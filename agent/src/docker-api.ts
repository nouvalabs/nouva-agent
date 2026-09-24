import http from "node:http";
import {
  negotiateDockerApiVersion,
  type ParsedDockerStats,
  parseDockerStatsSnapshot,
} from "./protocol.js";

type HttpMethod = "GET" | "POST" | "DELETE";
type DockerRequestBody = Record<string, unknown> | Buffer | string | null;

interface DockerRequestOptions {
  contentType?: string;
  headers?: Record<string, string>;
}

export class DockerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: HttpMethod,
    public readonly path: string,
    public readonly responseBody: string
  ) {
    super(`Docker API ${method} ${path} failed (${status}): ${responseBody}`);
    this.name = "DockerApiError";
  }
}

export interface RegistryAuth {
  host: string;
  username: string;
  password: string;
}

export const MANAGED_CONTAINER_LOG_CONFIG = {
  Type: "json-file",
  Config: {
    "max-size": "10m",
    "max-file": "3",
  },
} as const;

export const REDACTION_CONTEXT_VERSION_DOCKER_LABEL = "nouva.redaction.context.version";

export interface DockerContainerInspection {
  Id: string;
  Name: string;
  Image?: string;
  RestartCount?: number;
  State?: {
    Running?: boolean;
    Status?: string;
    ExitCode?: number;
    Error?: string;
    OOMKilled?: boolean;
    StartedAt?: string;
    FinishedAt?: string;
    Health?: {
      Status?: string;
    };
  };
  HostConfig?: {
    NanoCpus?: number;
    Memory?: number;
    MemorySwap?: number;
    PidsLimit?: number;
    NetworkMode?: string;
    Binds?: string[];
    VolumesFrom?: string[];
    Mounts?: Array<{ Type?: string; Source?: string; Target?: string }>;
    Privileged?: boolean;
    RestartPolicy?: {
      Name?: string;
    };
    LogConfig?: {
      Type?: string;
      Config?: Record<string, string>;
    };
    PortBindings?: Record<
      string,
      Array<{
        HostIp?: string;
        HostPort?: string;
      }>
    >;
  };
  Config?: {
    Image?: string;
    Entrypoint?: string[] | null;
    Cmd?: string[];
    Env?: string[];
    Labels?: Record<string, string>;
    StopSignal?: string;
  };
  NetworkSettings?: {
    Networks?: Record<
      string,
      {
        IPAddress?: string;
      }
    >;
  };
  Mounts?: Array<{
    Type?: string;
    Name?: string;
    Source?: string;
    Destination?: string;
    RW?: boolean;
  }>;
}

export interface DockerImageInspection {
  Id: string;
  RepoTags?: string[];
  RepoDigests?: string[];
  Config?: {
    Volumes?: Record<string, Record<string, never>> | null;
    Entrypoint?: string[] | null;
    Cmd?: string[] | null;
    Healthcheck?: {
      Test?: string[] | null;
      Interval?: number;
      Timeout?: number;
      Retries?: number;
      StartPeriod?: number;
    } | null;
  };
}

export interface DockerSystemInfo {
  DockerRootDir?: string;
}

export interface DockerVolumeDiskUsage {
  volumeName: string;
  usedBytes: number;
  raw: Record<string, unknown>;
}

interface DockerSystemDiskUsage {
  Volumes?: Array<{
    Name?: string;
    Labels?: Record<string, string> | null;
    UsageData?: {
      Size?: number;
      RefCount?: number;
    };
  }>;
}

export interface DockerContainerSpec {
  name: string;
  image: string;
  env?: string[];
  entrypoint?: string[];
  cmd?: string[];
  tty?: boolean;
  labels?: Record<string, string>;
  healthcheck?: {
    Test: string[];
    Interval?: number;
    Timeout?: number;
    Retries?: number;
    StartPeriod?: number;
  };
  exposedPorts?: Record<string, Record<string, never>>;
  /** Signal Docker sends on `docker stop`, a daemon shutdown or a restart. */
  stopSignal?: string;
  /** Seconds Docker waits after `stopSignal` before it sends SIGKILL. */
  stopTimeoutSeconds?: number;
  hostConfig?: Record<string, unknown>;
  networkingConfig?: Record<string, unknown>;
}

export type ManagedContainerLogConfigAdoptionStatus =
  | "compliant"
  | "recreation_required"
  | "inspection_failed";

export interface ManagedContainerLogConfigAdoptionEntry {
  containerId: string;
  containerName: string;
  kind: string | null;
  status: ManagedContainerLogConfigAdoptionStatus;
  stateful: boolean;
  preservedVolumeNames: string[];
}

export interface ManagedContainerLogConfigAdoptionResult {
  phase2Ready: boolean;
  containers: ManagedContainerLogConfigAdoptionEntry[];
}

export function hasManagedContainerLogConfig(
  inspection: DockerContainerInspection | null
): boolean {
  const logConfig = inspection?.HostConfig?.LogConfig;
  return (
    logConfig?.Type === MANAGED_CONTAINER_LOG_CONFIG.Type &&
    logConfig.Config?.["max-size"] === MANAGED_CONTAINER_LOG_CONFIG.Config["max-size"] &&
    logConfig.Config?.["max-file"] === MANAGED_CONTAINER_LOG_CONFIG.Config["max-file"]
  );
}

function withManagedContainerLogConfig(
  spec: DockerContainerSpec
): Record<string, unknown> | undefined {
  if (spec.labels?.["nouva.managed"] !== "true") {
    return spec.hostConfig;
  }

  return {
    ...(spec.hostConfig ?? {}),
    LogConfig: {
      Type: MANAGED_CONTAINER_LOG_CONFIG.Type,
      Config: { ...MANAGED_CONTAINER_LOG_CONFIG.Config },
    },
  };
}

export interface DockerLogEntry {
  type: "stdout" | "stderr";
  timestamp: string | null;
  line: string;
}

function splitLogLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0);
}

function parseTimestampedLogLine(line: string): {
  timestamp: string | null;
  line: string;
} {
  const separatorIndex = line.indexOf(" ");
  if (separatorIndex <= 0) {
    return {
      timestamp: null,
      line,
    };
  }

  const timestamp = line.slice(0, separatorIndex);
  if (!Number.isFinite(Date.parse(timestamp))) {
    return {
      timestamp: null,
      line,
    };
  }

  return {
    timestamp,
    line: line.slice(separatorIndex + 1),
  };
}

export function parseDockerLogBuffer(buffer: Buffer, timestamps = false): DockerLogEntry[] {
  const frames: Array<{ stream: "stdout" | "stderr"; payload: string }> = [];

  if (buffer.length >= 8) {
    let offset = 0;
    let isMultiplexed = true;

    while (offset + 8 <= buffer.length) {
      const streamType = buffer[offset];
      const payloadLength = buffer.readUInt32BE(offset + 4);
      const payloadStart = offset + 8;
      const payloadEnd = payloadStart + payloadLength;
      if ((streamType !== 1 && streamType !== 2) || payloadEnd > buffer.length) {
        isMultiplexed = false;
        break;
      }

      frames.push({
        stream: streamType === 2 ? "stderr" : "stdout",
        payload: buffer.toString("utf8", payloadStart, payloadEnd),
      });
      offset = payloadEnd;
    }

    if (!isMultiplexed || offset !== buffer.length) {
      frames.length = 0;
    }
  }

  if (frames.length === 0) {
    frames.push({
      stream: "stdout",
      payload: buffer.toString("utf8"),
    });
  }

  return frames.flatMap((frame) =>
    splitLogLines(frame.payload).map((rawLine) => {
      const parsed = timestamps
        ? parseTimestampedLogLine(rawLine)
        : { timestamp: null, line: rawLine };
      return {
        type: frame.stream,
        timestamp: parsed.timestamp,
        line: parsed.line,
      } satisfies DockerLogEntry;
    })
  );
}

export function parseManagedVolumeDiskUsage(input: unknown): DockerVolumeDiskUsage[] {
  const report =
    typeof input === "object" && input !== null ? (input as DockerSystemDiskUsage) : {};
  return (report.Volumes ?? []).flatMap((volume) => {
    const volumeName = volume.Name?.trim();
    const managed =
      volume.Labels?.["nouva.managed"] === "true" &&
      typeof volume.Labels["nouva.volume.id"] === "string";
    const legacy = Boolean(volumeName?.startsWith("nouva-vol-"));
    const usedBytes = volume.UsageData?.Size;
    if (
      !volumeName ||
      (!managed && !legacy) ||
      typeof usedBytes !== "number" ||
      !Number.isFinite(usedBytes) ||
      usedBytes < 0
    ) {
      return [];
    }

    return [
      {
        volumeName,
        usedBytes: Math.trunc(usedBytes),
        raw: {
          refCount: volume.UsageData?.RefCount ?? null,
          managedByLabel: managed,
          legacyName: legacy && !managed,
        },
      },
    ];
  });
}

export class DockerApiClient {
  private constructor(private readonly apiVersion: string) {}

  static async create(): Promise<DockerApiClient> {
    const raw = await DockerApiClient.rawRequest("GET", "/version");
    const payload = JSON.parse(raw) as { ApiVersion?: string };
    return new DockerApiClient(negotiateDockerApiVersion(payload));
  }

  private static rawRequestBuffer(
    method: HttpMethod,
    path: string,
    body?: DockerRequestBody,
    timeoutMs?: number,
    options: DockerRequestOptions = {}
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let payload: Buffer | string | null = null;
      let headers: Record<string, string> | undefined;

      if (body !== null && body !== undefined) {
        if (Buffer.isBuffer(body) || typeof body === "string") {
          payload = body;
          const payloadLength = Buffer.isBuffer(payload)
            ? payload.length
            : Buffer.byteLength(payload, "utf8");
          headers = {
            "content-type": options.contentType ?? "application/octet-stream",
            "content-length": String(payloadLength),
            ...(options.headers ?? {}),
          };
        } else {
          payload = JSON.stringify(body);
          headers = {
            "content-type": options.contentType ?? "application/json",
            ...(options.headers ?? {}),
          };
        }
      } else if (options.headers) {
        headers = { ...options.headers };
      }

      const req = http.request(
        {
          socketPath: "/var/run/docker.sock",
          path,
          method,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("end", () => {
            const raw = Buffer.concat(chunks);
            const statusCode = res.statusCode ?? 500;
            if (statusCode >= 400) {
              reject(new DockerApiError(statusCode, method, path, raw.toString("utf8")));
              return;
            }

            resolve(raw);
          });
        }
      );

      if (timeoutMs) {
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(`Docker API timed out (${timeoutMs}ms): ${method} ${path}`));
        });
      }

      req.on("error", reject);
      if (payload !== null) {
        req.write(payload);
      }
      req.end();
    });
  }

  private static async rawRequest(
    method: HttpMethod,
    path: string,
    body?: DockerRequestBody,
    timeoutMs?: number,
    options: DockerRequestOptions = {}
  ): Promise<string> {
    return (
      await DockerApiClient.rawRequestBuffer(method, path, body, timeoutMs, options)
    ).toString("utf8");
  }

  async request<T = string>(
    method: HttpMethod,
    path: string,
    body?: DockerRequestBody,
    timeoutMs?: number,
    options: DockerRequestOptions = {}
  ): Promise<T> {
    const raw = await DockerApiClient.rawRequest(
      method,
      `/${this.apiVersion}${path}`,
      body,
      timeoutMs,
      options
    );
    if (!raw) {
      return "" as T;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as T;
    }
  }

  async requestRaw(
    method: HttpMethod,
    path: string,
    body?: DockerRequestBody,
    timeoutMs?: number,
    options: DockerRequestOptions = {}
  ): Promise<Buffer> {
    return await DockerApiClient.rawRequestBuffer(
      method,
      `/${this.apiVersion}${path}`,
      body,
      timeoutMs,
      options
    );
  }

  async listManagedContainers(): Promise<
    Array<{
      Id: string;
      Names?: string[];
      State?: string;
      Labels?: Record<string, string>;
    }>
  > {
    const filters = encodeURIComponent(JSON.stringify({ label: ["nouva.managed=true"] }));
    return await this.request("GET", `/containers/json?all=true&filters=${filters}`);
  }

  async inspectManagedContainerLogConfigAdoption(): Promise<ManagedContainerLogConfigAdoptionResult> {
    const containers = await this.listManagedContainers();
    const results: ManagedContainerLogConfigAdoptionEntry[] = [];

    for (const container of containers) {
      const inspection = await this.inspectContainer(container.Id);
      if (!inspection) {
        const kind = container.Labels?.["nouva.kind"] ?? null;
        results.push({
          containerId: container.Id,
          containerName: container.Names?.[0]?.replace(/^\//, "") ?? container.Id,
          kind,
          status: "inspection_failed",
          stateful: kind === "database",
          preservedVolumeNames: [],
        });
        continue;
      }

      const preservedVolumeNames = [
        ...new Set(
          (inspection.Mounts ?? []).flatMap((mount) => {
            if (mount.Type !== "volume") {
              return [];
            }
            const volumeName = mount.Name?.trim() || mount.Source?.trim();
            return volumeName ? [volumeName] : [];
          })
        ),
      ].sort();
      const kind =
        inspection.Config?.Labels?.["nouva.kind"] ?? container.Labels?.["nouva.kind"] ?? null;
      results.push({
        containerId: inspection.Id || container.Id,
        containerName:
          inspection.Name?.replace(/^\//, "") ??
          container.Names?.[0]?.replace(/^\//, "") ??
          container.Id,
        kind,
        status: hasManagedContainerLogConfig(inspection) ? "compliant" : "recreation_required",
        stateful: kind === "database" || preservedVolumeNames.length > 0,
        preservedVolumeNames,
      });
    }

    return {
      phase2Ready: results.every((result) => result.status === "compliant"),
      containers: results,
    };
  }

  async pullImage(image: string, auth?: RegistryAuth): Promise<void> {
    const headers = auth
      ? {
          "X-Registry-Auth": Buffer.from(
            JSON.stringify({
              username: auth.username,
              password: auth.password,
              serveraddress: auth.host,
            }),
            "utf8"
          ).toString("base64"),
        }
      : undefined;

    await this.request(
      "POST",
      `/images/create?fromImage=${encodeURIComponent(image)}`,
      null,
      5 * 60_000,
      { headers }
    );
  }

  async listNetworks(): Promise<
    Array<{ Id: string; Name: string; Labels?: Record<string, string> }>
  > {
    return (
      (await this.request<Array<{ Id: string; Name: string; Labels?: Record<string, string> }>>(
        "GET",
        "/networks"
      )) ?? []
    );
  }

  async inspectNetwork(name: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.request("GET", `/networks/${encodeURIComponent(name)}`);
    } catch (error) {
      if (error instanceof DockerApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Delete a network, tolerating one that is already gone.
   *
   * A 404 means the desired end state already holds, so it is not an error — same reasoning as
   * `removeVolume`. A 403 is not swallowed here: Docker returns it when containers are still
   * attached, and silently reporting success would leave the network behind.
   */
  async removeNetwork(name: string): Promise<void> {
    try {
      await this.request("DELETE", `/networks/${encodeURIComponent(name)}`);
    } catch (error) {
      if (!(error instanceof DockerApiError && error.status === 404)) {
        throw error;
      }
    }
  }

  async ensureNetwork(name: string, labels: Record<string, string> = {}): Promise<void> {
    const networks = await this.listNetworks();
    if (networks.some((network) => network.Name === name)) {
      return;
    }

    await this.request("POST", "/networks/create", {
      Name: name,
      Driver: "bridge",
      Attachable: true,
      Labels: labels,
    });
  }

  async info(): Promise<DockerSystemInfo> {
    return (await this.request<DockerSystemInfo>("GET", "/info")) ?? {};
  }

  async createVolume(name: string, labels: Record<string, string> = {}): Promise<void> {
    await this.request("POST", "/volumes/create", {
      Name: name,
      Labels: labels,
    });
  }

  async listManagedVolumeDiskUsage(): Promise<DockerVolumeDiskUsage[]> {
    return parseManagedVolumeDiskUsage(await this.request("GET", "/system/df?type=volume"));
  }

  async removeVolume(name: string, force = false): Promise<void> {
    try {
      await this.request(
        "DELETE",
        `/volumes/${encodeURIComponent(name)}${force ? "?force=true" : ""}`
      );
    } catch (error) {
      if (!(error instanceof DockerApiError && error.status === 404)) {
        throw error;
      }
    }
  }

  async inspectVolume(name: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.request("GET", `/volumes/${encodeURIComponent(name)}`);
    } catch (error) {
      if (error instanceof DockerApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async inspectContainer(nameOrId: string): Promise<DockerContainerInspection | null> {
    try {
      return await this.request("GET", `/containers/${encodeURIComponent(nameOrId)}/json`);
    } catch (error) {
      if (error instanceof DockerApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async listContainersUsingVolume(volumeName: string): Promise<DockerContainerInspection[]> {
    const filters = encodeURIComponent(JSON.stringify({ volume: [volumeName] }));
    const containers = await this.request<Array<{ Id?: string }>>(
      "GET",
      `/containers/json?all=true&filters=${filters}`
    );
    const inspections = await Promise.all(
      containers.flatMap((container) => (container.Id ? [this.inspectContainer(container.Id)] : []))
    );
    return inspections.filter(
      (inspection): inspection is DockerContainerInspection => inspection !== null
    );
  }

  async listContainersByLabels(
    labels: Record<string, string>
  ): Promise<DockerContainerInspection[]> {
    const labelFilters = Object.entries(labels).map(([key, value]) => `${key}=${value}`);
    const filters = encodeURIComponent(JSON.stringify({ label: labelFilters }));
    const containers = await this.request<Array<{ Id?: string }>>(
      "GET",
      `/containers/json?all=true&filters=${filters}`
    );
    const inspections = await Promise.all(
      containers.flatMap((container) => (container.Id ? [this.inspectContainer(container.Id)] : []))
    );
    return inspections.filter(
      (inspection): inspection is DockerContainerInspection => inspection !== null
    );
  }

  async updateContainer(
    nameOrId: string,
    resources: {
      NanoCpus: number;
      Memory: number;
      MemorySwap: number;
      PidsLimit: number;
    }
  ): Promise<void> {
    await this.request("POST", `/containers/${encodeURIComponent(nameOrId)}/update`, resources);
  }

  async inspectImage(nameOrId: string): Promise<DockerImageInspection | null> {
    try {
      return await this.request("GET", `/images/${encodeURIComponent(nameOrId)}/json`);
    } catch (error) {
      if (error instanceof DockerApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * `removeVolumes` maps to Docker's `v=true`, which removes only the *anonymous* volumes the
   * container owns and never a named one, so it defaults to true: no caller wants to keep an
   * anonymous volume, and leaving it opt-in leaked one per container lifetime for every image
   * declaring a `VOLUME` the agent does not mount over — Postgres `/var/lib/postgresql/data` and
   * Mongo `/data/configdb` on every database work item (#176). Managed service volumes and the
   * per-service build cache (#184) are named, so this never touches them.
   */
  async removeContainer(
    nameOrId: string,
    force = false,
    timeoutMs?: number,
    removeVolumes = true
  ): Promise<void> {
    try {
      await this.request(
        "DELETE",
        `/containers/${encodeURIComponent(nameOrId)}?force=${force}${removeVolumes ? "&v=true" : ""}`,
        null,
        timeoutMs
      );
    } catch (error) {
      if (!(error instanceof DockerApiError && error.status === 404)) {
        throw error;
      }
    }
  }

  async removeImage(nameOrId: string, force = false): Promise<void> {
    try {
      await this.request(
        "DELETE",
        `/images/${encodeURIComponent(nameOrId)}?force=${force ? "1" : "0"}`
      );
    } catch (error) {
      if (!(error instanceof DockerApiError && error.status === 404)) {
        throw error;
      }
    }
  }

  async stopContainer(
    nameOrId: string,
    timeoutSeconds?: number,
    requestTimeoutMs?: number
  ): Promise<void> {
    try {
      const timeoutQuery =
        typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds)
          ? `?t=${Math.max(0, Math.trunc(timeoutSeconds))}`
          : "";
      await this.request(
        "POST",
        `/containers/${encodeURIComponent(nameOrId)}/stop${timeoutQuery}`,
        null,
        requestTimeoutMs
      );
    } catch (error) {
      if (!(error instanceof DockerApiError && (error.status === 404 || error.status === 304))) {
        throw error;
      }
    }
  }

  /**
   * Sends `signal` to the container's main process. Returns `false` when there was nothing to
   * signal: the container is gone (404) or no longer running (409), which a caller waiting for the
   * process to stop reads as the same outcome.
   */
  async killContainer(nameOrId: string, signal: string): Promise<boolean> {
    try {
      await this.request(
        "POST",
        `/containers/${encodeURIComponent(nameOrId)}/kill?signal=${encodeURIComponent(signal)}`
      );
      return true;
    } catch (error) {
      if (error instanceof DockerApiError && (error.status === 404 || error.status === 409)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Changes only the restart policy. A worker being retired is switched to `no` first so the
   * daemon cannot restart a process that exits on the retirement signal, and switched back to
   * `unless-stopped` if the rollout has to restore it.
   */
  async updateContainerRestartPolicy(
    nameOrId: string,
    policy: "no" | "unless-stopped"
  ): Promise<void> {
    await this.request("POST", `/containers/${encodeURIComponent(nameOrId)}/update`, {
      RestartPolicy: { Name: policy },
    });
  }

  async restartContainer(nameOrId: string): Promise<void> {
    await this.request("POST", `/containers/${encodeURIComponent(nameOrId)}/restart`);
  }

  async createContainer(spec: DockerContainerSpec): Promise<string> {
    const created = await this.request<{ Id: string }>(
      "POST",
      `/containers/create?name=${encodeURIComponent(spec.name)}`,
      {
        Image: spec.image,
        Env: spec.env,
        Entrypoint: spec.entrypoint,
        Cmd: spec.cmd,
        Tty: spec.tty ?? false,
        Labels: spec.labels,
        Healthcheck: spec.healthcheck,
        ExposedPorts: spec.exposedPorts,
        StopSignal: spec.stopSignal,
        StopTimeout: spec.stopTimeoutSeconds,
        HostConfig: withManagedContainerLogConfig(spec),
        NetworkingConfig: spec.networkingConfig,
      }
    );
    return created.Id;
  }

  async startContainer(id: string): Promise<void> {
    await this.request("POST", `/containers/${encodeURIComponent(id)}/start`);
  }

  async waitContainer(id: string, timeoutMs = 30 * 60_000): Promise<number> {
    const result = await this.request<{ StatusCode?: number }>(
      "POST",
      `/containers/${encodeURIComponent(id)}/wait`,
      null,
      timeoutMs
    );
    return result.StatusCode ?? 1;
  }

  async containerLogs(id: string): Promise<string> {
    const entries = await this.containerLogEntries(id, {
      stdout: true,
      stderr: true,
      timestamps: false,
    });
    return entries.map((entry) => entry.line).join("\n");
  }

  async containerLogEntries(
    id: string,
    options: {
      stdout?: boolean;
      stderr?: boolean;
      timestamps?: boolean;
      tail?: number;
      since?: Date | null;
    } = {}
  ): Promise<DockerLogEntry[]> {
    const params = new URLSearchParams({
      stdout: options.stdout === false ? "false" : "true",
      stderr: options.stderr === false ? "false" : "true",
      timestamps: options.timestamps ? "true" : "false",
    });

    if (typeof options.tail === "number" && Number.isFinite(options.tail)) {
      params.set("tail", String(Math.max(1, Math.trunc(options.tail))));
    }

    if (options.since) {
      params.set("since", String(Math.max(0, Math.floor(options.since.getTime() / 1000))));
    }

    const raw = await this.requestRaw(
      "GET",
      `/containers/${encodeURIComponent(id)}/logs?${params.toString()}`,
      null,
      30_000
    );

    return parseDockerLogBuffer(raw, options.timestamps);
  }

  async connectNetwork(network: string, container: string): Promise<void> {
    try {
      await this.request("POST", `/networks/${encodeURIComponent(network)}/connect`, {
        Container: container,
      });
    } catch (error) {
      if (!(error instanceof DockerApiError && error.status === 403)) {
        throw error;
      }
    }
  }

  async disconnectNetwork(network: string, container: string, force = false): Promise<void> {
    try {
      await this.request("POST", `/networks/${encodeURIComponent(network)}/disconnect`, {
        Container: container,
        Force: force,
      });
    } catch (error) {
      if (!(error instanceof DockerApiError && (error.status === 403 || error.status === 404))) {
        throw error;
      }
    }
  }

  async loadImage(archive: Buffer): Promise<void> {
    await this.requestRaw("POST", "/images/load?quiet=1", archive, 5 * 60_000, {
      contentType: "application/x-tar",
    });
  }

  async ensureContainer(
    spec: DockerContainerSpec,
    replace = false,
    options: {
      auth?: RegistryAuth;
      pull?: boolean;
    } = {}
  ): Promise<string> {
    const existing = await this.inspectContainer(spec.name);
    if (existing && replace) {
      await this.removeContainer(spec.name, true);
    }

    const latest = replace ? null : await this.inspectContainer(spec.name);
    if (latest) {
      if (!latest.State?.Running) {
        await this.startContainer(latest.Id);
      }
      return latest.Id;
    }

    if (options.pull === false) {
      const image = await this.inspectImage(spec.image);
      if (!image) {
        throw new Error(`Docker image ${spec.image} is not present locally`);
      }
    } else {
      await this.pullImage(spec.image, options.auth);
    }
    const id = await this.createContainer(spec);
    await this.startContainer(id);
    return id;
  }

  async containerStats(containerId: string): Promise<ParsedDockerStats> {
    const stats = await this.request(
      "GET",
      `/containers/${encodeURIComponent(containerId)}/stats?stream=false`,
      null,
      30_000
    );
    return parseDockerStatsSnapshot(stats);
  }
}
