import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import {
  type DockerApiClient,
  DockerApiError,
  type DockerContainerInspection,
  type DockerContainerSpec,
  MANAGED_CONTAINER_LOG_CONFIG,
} from "./docker-api.js";
import type { AgentRuntimeConfig, ServerCheckStatus, ServerValidationCheck } from "./protocol.js";

export const TRAEFIK_IMAGE = process.env.NOUVA_AGENT_TRAEFIK_IMAGE || "traefik:v3.5";
export const DEFAULT_TRAEFIK_IMAGE = TRAEFIK_IMAGE;
export const TRAEFIK_CONTAINER_NAME = process.env.NOUVA_AGENT_TRAEFIK_CONTAINER || "nouva-traefik";
export const TRAEFIK_CANDIDATE_CONTAINER_NAME = `${TRAEFIK_CONTAINER_NAME}-candidate`;
export const TRAEFIK_ADMIN_HOST = "127.0.0.1";
export const TRAEFIK_ADMIN_PORT = 8082;
export const TRAEFIK_CANDIDATE_ADMIN_PORT = 8083;
export const TRAEFIK_CONFIG_HASH_LABEL = "nouva.traefik.static-config-sha";
export const TRAEFIK_ROLE_LABEL = "nouva.traefik.role";
export const TRAEFIK_API_ENTRYPOINT = "traefik";

const AGENT_DATA_DIR_IN_CONTAINER = "/var/lib/nouva-agent";
const ACME_FILE_MODE = 0o600;

export interface TraefikRuntimePaths {
  rootDir: string;
  staticDir: string;
  dynamicDir: string;
  acmeDir: string;
  staticConfigPath: string;
  acmeStoragePath: string;
}

export interface TraefikRouteConfig {
  fileKey: string;
  hostnames?: string[];
  providedHostnames?: string[];
  customHostnames?: string[];
  serviceUrl: string;
  passHostHeader?: boolean;
  replacePath?: string | null;
}

export interface TraefikRuntimeFailure {
  phase: "preflight" | "cutover" | "rollback";
  message: string;
  at: string;
  rollbackStatus: "not-needed" | "succeeded" | "failed";
}

export interface TraefikRuntimeInput {
  dataDir: string;
  dataVolume: string;
  containerName: string;
  networkName: string;
  serverId: string;
  image: string;
  acmeEmail: string | null;
  trustedForwardedPeers?: readonly string[];
}

export interface TraefikRuntimeDeps {
  paths?: TraefikRuntimePaths;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
}

interface BuildTraefikContainerSpecOptions {
  dataVolume: string;
  labels?: Record<string, string>;
  name?: string;
  image?: string;
  publicBindings?: boolean;
  adminHostPort?: number;
  stateHash: string;
}

interface ProbeTraefikRuntimeOptions {
  containerName?: string;
  adminPort?: number;
  fetchImpl?: typeof fetch;
}

interface WaitForTraefikHealthOptions extends ProbeTraefikRuntimeOptions {
  expectPublicBindings: boolean;
  timeoutMs: number;
  intervalMs: number;
}

interface ReconcileTraefikRuntimeOptions {
  dataVolume: string;
  labels?: Record<string, string>;
  paths?: TraefikRuntimePaths;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
}

async function connectTraefikToManagedProjectNetworks(
  docker: Pick<DockerApiClient, "connectNetwork" | "inspectNetwork" | "listNetworks">,
  containerName: string,
  serverId: string | undefined
): Promise<void> {
  const networks = await docker.listNetworks();
  const projectNetworks = networks.filter((network) => {
    const labels = network.Labels ?? {};
    return (
      labels["nouva.managed"] === "true" &&
      typeof labels["nouva.project.id"] === "string" &&
      (!serverId || labels["nouva.server.id"] === serverId)
    );
  });

  await Promise.all(
    projectNetworks.map(async (network) => {
      try {
        await docker.connectNetwork(network.Name, containerName);
      } catch (error) {
        // A project deleted since the listing took its network with it, which leaves nothing to
        // connect: `delete_project` does not wait for this reconcile. Docker answers a missing
        // container with the same 404, so only a network that is gone now is skipped.
        if (
          error instanceof DockerApiError &&
          error.status === 404 &&
          !(await docker.inspectNetwork(network.Name))
        ) {
          return;
        }
        throw error;
      }
    })
  );
}

interface CollectTraefikValidationChecksOptions {
  paths?: TraefikRuntimePaths;
  fetchImpl?: typeof fetch;
}

interface TraefikProbeResult {
  inspection: DockerContainerInspection | null;
  pingOk: boolean;
  routeFileCount: number;
  /** Routers declared across the managed route files (one for provided hostnames, two for custom). */
  expectedRouterCount: number;
  managedRouterCount: number | null;
  acmeStatus: ServerCheckStatus;
  acmeMessage: string;
  acmeMode: string | null;
}

let lastTraefikRuntimeFailure: TraefikRuntimeFailure | null = null;

function buildCheck(
  key: string,
  label: string,
  status: ServerCheckStatus,
  message: string,
  value: string | null = null
): ServerValidationCheck {
  return { key, label, status, message, value };
}

function serializeYaml(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function quoteHostnames(hostnames: string[]): string {
  return hostnames.map((hostname) => `Host(\`${hostname}\`)`).join(" || ");
}

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

/**
 * How wide a network a single entry may name, per address family.
 *
 * Every peer here is one hosted-edge egress host — the control plane sends a single `/32` (see
 * `DEFAULT_EDGE_FORWARDED_PEERS`), and nothing between the edge and the customer proxy widens that
 * into a range. So the prefix is only ever a host mask, and a broad one is a slip of the keyboard
 * rather than a peer: `/1` is as easy to type in place of `/32` as `/0` is, and it hands the right
 * to forge `X-Forwarded-For` to half the IPv4 internet. Rejecting only `/0` catches one spelling
 * of the same mistake.
 *
 * `/24` is where the line sits: it is the smallest block the global routing table carries, so it
 * is also the smallest piece of IPv4 space anyone is allocated. One whole allocation already spans
 * 256 hosts, far more than an edge's egress set, and anything wider is more address space than a
 * peer list can mean. `/48` is the IPv6 equivalent, the smallest allocation a site is handed.
 */
const FORWARDING_PREFIX_BOUNDS: Readonly<Record<number, { min: number; max: number }>> = {
  4: { min: 24, max: 32 },
  6: { min: 48, max: 128 },
};

/**
 * Anything looser than what Traefik itself accepts defeats the reason these entries are filtered
 * at all: a half-address that survives this check is written into the static config, and Traefik
 * then refuses to start with it. `node:net` draws the same line Go does, down to reading a leading
 * zero in an octet as an error rather than as octal — verified on traefik:v3.5, where `010.0.0.1`
 * aborts the process with `invalid CIDR address`. The one place the two part company is a zone id,
 * handled below.
 */
function isForwardingPeer(value: string): boolean {
  const parts = value.split("/");
  const address = parts[0] ?? "";
  const prefix = parts[1];

  if (parts.length > 2) {
    return false;
  }

  // `isIP` accepts a scoped address like `fe80::1%eth0`, but a zone names an interface on the host
  // that wrote it, so it can never identify a peer dialling in from somewhere else — and Go's
  // `net.ParseIP`, which Traefik parses `trustedIPs` with, discards zoned addresses outright.
  if (address.includes("%")) {
    return false;
  }

  const bounds = FORWARDING_PREFIX_BOUNDS[isIP(address)];
  if (!bounds) {
    return false;
  }

  if (prefix === undefined) {
    return true;
  }

  // Go reads the mask with plain decimal parsing, so `/024` is the same network as `/24` there and
  // stays accepted here; only the width it resolves to decides the entry.
  const prefixLength = /^\d{1,3}$/.test(prefix) ? Number.parseInt(prefix, 10) : Number.NaN;
  return prefixLength >= bounds.min && prefixLength <= bounds.max;
}

/**
 * Keeps the peers this proxy can safely be told to trust, in the order the control plane sent
 * them. An entry Traefik could not parse is dropped rather than rendered: an unreadable static
 * config stops the proxy and takes every route on the server down, while dropping one entry only
 * leaves that peer as untrusted as it was before.
 */
function selectTrustedForwardedPeers(peers: readonly string[] | undefined): string[] {
  const selected: string[] = [];

  for (const candidate of peers ?? []) {
    const peer = typeof candidate === "string" ? candidate.trim() : "";
    if (peer.length > 0 && !selected.includes(peer) && isForwardingPeer(peer)) {
      selected.push(peer);
    }
  }

  return selected;
}

function buildTraefikRuntimeConfig(input: TraefikRuntimeInput): AgentRuntimeConfig {
  return {
    heartbeatIntervalSeconds: 30,
    pollIntervalSeconds: 10,
    leaseTtlSeconds: 120,
    metricsIntervalSeconds: 30,
    postgresObservabilityIntervalSeconds: 30,
    ingressMode: "local_traefik",
    buildkitMode: "docker-container",
    imageStoreMode: "docker-local",
    capabilities: {
      dockerApi: true,
      buildkit: true,
      localRegistry: true,
      localTraefik: true,
      hostMetrics: true,
      containerMetrics: true,
      postgresObservability: true,
    },
    localRegistryHost: "127.0.0.1",
    localRegistryPort: 5000,
    localTraefikNetwork: input.networkName,
    clientIngressPlaceholderUrl: "https://nouva.sh/_nouva/domain-pending",
    trustedForwardedPeers: [...(input.trustedForwardedPeers ?? [])],
    observability: {
      enabled: false,
      organizationId: null,
      alloyImage: "grafana/alloy:v1.17.1",
      scrapeIntervalSeconds: 30,
      collectorScope: "services_traefik_and_workers",
      noneLabelValue: "__none__",
    },
  };
}

function buildTraefikLabels(input: TraefikRuntimeInput): Record<string, string> {
  return {
    "nouva.managed": "true",
    "nouva.kind": "traefik",
    "nouva.server.id": input.serverId,
  };
}

function resolveValidationOptions(
  inputOrOptions: TraefikRuntimeInput | CollectTraefikValidationChecksOptions | undefined,
  deps: CollectTraefikValidationChecksOptions | undefined
): CollectTraefikValidationChecksOptions {
  if (inputOrOptions && "dataDir" in inputOrOptions && typeof inputOrOptions.dataDir === "string") {
    return {
      ...deps,
      paths: deps?.paths ?? getTraefikRuntimePaths(inputOrOptions.dataDir),
    };
  }

  if (!inputOrOptions) {
    return {};
  }

  return inputOrOptions as CollectTraefikValidationChecksOptions;
}

function hasPortBinding(
  inspection: DockerContainerInspection | null,
  containerPort: string,
  expected: { hostIp: string; hostPort: string }
): boolean {
  const bindings = inspection?.HostConfig?.PortBindings?.[containerPort];
  if (!Array.isArray(bindings)) {
    return false;
  }

  return bindings.some(
    (binding) =>
      binding.HostPort === expected.hostPort &&
      (binding.HostIp === expected.hostIp ||
        (expected.hostIp === "0.0.0.0" && (binding.HostIp === "0.0.0.0" || binding.HostIp === "")))
  );
}

function hasPrimaryPortBindings(inspection: DockerContainerInspection | null): boolean {
  return (
    hasPortBinding(inspection, "80/tcp", { hostIp: "0.0.0.0", hostPort: "80" }) &&
    hasPortBinding(inspection, "443/tcp", { hostIp: "0.0.0.0", hostPort: "443" })
  );
}

function hasAdminBinding(
  inspection: DockerContainerInspection | null,
  adminHostPort: number
): boolean {
  return hasPortBinding(inspection, "8082/tcp", {
    hostIp: TRAEFIK_ADMIN_HOST,
    hostPort: String(adminHostPort),
  });
}

function isTraefikContainerCurrent(
  inspection: DockerContainerInspection | null,
  stateHash: string
): boolean {
  return (
    inspection?.State?.Running === true &&
    inspection.Config?.Image === TRAEFIK_IMAGE &&
    inspection.Config?.Labels?.[TRAEFIK_CONFIG_HASH_LABEL] === stateHash &&
    hasPrimaryPortBindings(inspection) &&
    hasAdminBinding(inspection, TRAEFIK_ADMIN_PORT)
  );
}

async function writeManagedFile(filePath: string, contents: string, mode?: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, contents, "utf8");
  if (typeof mode === "number") {
    await chmod(tempPath, mode);
  }
  await rename(tempPath, filePath);
  if (typeof mode === "number") {
    await chmod(filePath, mode);
  }
}

/**
 * Counts the routers declared in a managed route file rendered by `buildTraefikRouteConfig`.
 * Provided hostnames emit a single HTTP router; custom hostnames emit an HTTP redirect router plus
 * an HTTPS router, so the expected count differs per file and must be read back from disk.
 */
export function countDeclaredTraefikRouters(content: string): number {
  let inRouters = false;
  let count = 0;
  for (const line of content.split(/\r?\n/)) {
    if (/^ {2}routers:\s*$/.test(line)) {
      inRouters = true;
      continue;
    }
    if (/^ {0,2}\S/.test(line)) {
      inRouters = false;
      continue;
    }
    if (inRouters && /^ {4}[^\s:]+:\s*$/.test(line)) {
      count += 1;
    }
  }
  return count;
}

async function countRouteFiles(
  dynamicDir: string
): Promise<{ routeFileCount: number; expectedRouterCount: number }> {
  try {
    const entries = await readdir(dynamicDir, { withFileTypes: true });
    const routeFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".yml"));
    let expectedRouterCount = 0;
    for (const entry of routeFiles) {
      try {
        expectedRouterCount += countDeclaredTraefikRouters(
          await readFile(path.join(dynamicDir, entry.name), "utf8")
        );
      } catch {
        // A file that disappears mid-scan is simply not expected to be loaded.
      }
    }
    return { routeFileCount: routeFiles.length, expectedRouterCount };
  } catch {
    return { routeFileCount: 0, expectedRouterCount: 0 };
  }
}

async function fetchManagedRouterCount(
  fetchImpl: typeof fetch,
  adminPort: number
): Promise<number | null> {
  const response = await fetchImpl(`http://${TRAEFIK_ADMIN_HOST}:${adminPort}/api/http/routers`);
  if (!response.ok) {
    return null;
  }

  const routers = (await response.json()) as Array<{
    name?: string;
    provider?: string;
    rule?: string;
  }>;

  return routers.filter((router) => {
    if (typeof router.rule !== "string" || !router.rule.includes("Host(`")) {
      return false;
    }

    return router.provider === "file" || router.name?.endsWith("@file");
  }).length;
}

async function probeTraefikRuntime(
  docker: DockerApiClient,
  paths: TraefikRuntimePaths,
  options: ProbeTraefikRuntimeOptions = {}
): Promise<TraefikProbeResult> {
  const inspection = await docker.inspectContainer(options.containerName ?? TRAEFIK_CONTAINER_NAME);
  const fetchImpl = options.fetchImpl ?? fetch;
  const adminPort = options.adminPort ?? TRAEFIK_ADMIN_PORT;
  const { routeFileCount, expectedRouterCount } = await countRouteFiles(paths.dynamicDir);

  let pingOk = false;
  let managedRouterCount: number | null = null;

  if (inspection?.State?.Running) {
    try {
      const pingResponse = await fetchImpl(`http://${TRAEFIK_ADMIN_HOST}:${adminPort}/ping`);
      pingOk = pingResponse.ok;
    } catch {
      pingOk = false;
    }

    try {
      managedRouterCount = await fetchManagedRouterCount(fetchImpl, adminPort);
    } catch {
      managedRouterCount = null;
    }
  }

  let acmeStatus: ServerCheckStatus = "fail";
  let acmeMessage = "ACME storage is missing";
  let acmeMode: string | null = null;

  try {
    await access(paths.acmeStoragePath, fsConstants.R_OK | fsConstants.W_OK);
    const stats = await stat(paths.acmeStoragePath);
    acmeMode = formatMode(stats.mode);
    acmeStatus = (stats.mode & 0o777) === ACME_FILE_MODE ? "pass" : "warn";
    acmeMessage =
      acmeStatus === "pass"
        ? "ACME storage is readable, writable, and mode 0600"
        : `ACME storage is readable and writable but mode is ${acmeMode}`;
  } catch (error) {
    acmeStatus = "fail";
    acmeMessage = error instanceof Error ? error.message : "ACME storage is not accessible";
  }

  return {
    inspection,
    pingOk,
    routeFileCount,
    expectedRouterCount,
    managedRouterCount,
    acmeStatus,
    acmeMessage,
    acmeMode,
  };
}

async function waitForTraefikHealth(
  docker: DockerApiClient,
  paths: TraefikRuntimePaths,
  options: WaitForTraefikHealthOptions
): Promise<void> {
  const startedAt = Date.now();
  let lastError = "Traefik runtime did not become healthy";

  while (Date.now() - startedAt < options.timeoutMs) {
    const probe = await probeTraefikRuntime(docker, paths, {
      containerName: options.containerName,
      adminPort: options.adminPort,
      fetchImpl: options.fetchImpl,
    });

    if (!probe.inspection?.State?.Running) {
      lastError = "Traefik container is not running";
    } else if (options.expectPublicBindings && !hasPrimaryPortBindings(probe.inspection)) {
      lastError = "Traefik public port bindings are incomplete";
    } else if (!hasAdminBinding(probe.inspection, options.adminPort ?? TRAEFIK_ADMIN_PORT)) {
      lastError = "Traefik admin binding is missing";
    } else if (!probe.pingOk) {
      lastError = "Traefik ping endpoint is not healthy";
    } else if (probe.acmeStatus === "fail") {
      lastError = probe.acmeMessage;
    } else if (
      probe.expectedRouterCount > 0 &&
      (probe.managedRouterCount === null || probe.managedRouterCount < probe.expectedRouterCount)
    ) {
      lastError = "Traefik has not loaded all file-provider routes";
    } else {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }

  throw new Error(lastError);
}

function recordTraefikRuntimeFailure(
  failure: Pick<TraefikRuntimeFailure, "phase" | "message" | "rollbackStatus">
): void {
  lastTraefikRuntimeFailure = {
    ...failure,
    at: new Date().toISOString(),
  };
  console.error("[nouva-agent] traefik reconcile failure", lastTraefikRuntimeFailure);
}

export function resetTraefikRuntimeState(): void {
  lastTraefikRuntimeFailure = null;
}

export function getTraefikRuntimePaths(dataDir: string): TraefikRuntimePaths {
  const rootDir = path.join(dataDir, "traefik");
  return {
    rootDir,
    staticDir: path.join(rootDir, "static"),
    dynamicDir: path.join(rootDir, "dynamic"),
    acmeDir: path.join(rootDir, "acme"),
    staticConfigPath: path.join(rootDir, "static", "traefik.yml"),
    acmeStoragePath: path.join(rootDir, "acme", "acme.json"),
  };
}

export function buildTraefikRuntimePaths(dataDir: string): TraefikRuntimePaths {
  return getTraefikRuntimePaths(dataDir);
}

export async function ensureTraefikState(paths: TraefikRuntimePaths): Promise<void> {
  await mkdir(paths.staticDir, { recursive: true });
  await mkdir(paths.dynamicDir, { recursive: true });
  await mkdir(paths.acmeDir, { recursive: true });

  try {
    const currentContent = await readFile(paths.acmeStoragePath, "utf8");
    if (!currentContent.trim()) {
      await writeManagedFile(paths.acmeStoragePath, "{}\n", ACME_FILE_MODE);
      return;
    }

    await chmod(paths.acmeStoragePath, ACME_FILE_MODE);
  } catch {
    await writeManagedFile(paths.acmeStoragePath, "{}\n", ACME_FILE_MODE);
  }
}

export function resolveRoutingHostnames(input: {
  providedHostname?: string | null;
  customHostnames?: string[] | null;
}): string[] {
  const seen = new Set<string>();
  const hostnames: string[] = [];

  for (const rawHostname of [input.providedHostname, ...(input.customHostnames ?? [])]) {
    const hostname = typeof rawHostname === "string" ? rawHostname.trim().toLowerCase() : "";
    if (!hostname || seen.has(hostname)) {
      continue;
    }

    seen.add(hostname);
    hostnames.push(hostname);
  }

  return hostnames;
}

export function buildTraefikRouteConfig(route: TraefikRouteConfig): string {
  const providedHostnames = route.providedHostnames ?? [];
  const customHostnames =
    route.customHostnames ?? (providedHostnames.length === 0 ? (route.hostnames ?? []) : []);
  const providedHttpRouterName = `http-${route.fileKey}`;
  const customHttpRouterName = `http-custom-${route.fileKey}`;
  const customHttpsRouterName = `https-${route.fileKey}`;
  const redirectMiddlewareName = `redirect-${route.fileKey}`;
  const replacePathMiddlewareName = `replace-path-${route.fileKey}`;
  const serviceName = `svc-${route.fileKey}`;
  const lines = ["http:", "  routers:"];

  if (providedHostnames.length > 0) {
    lines.push(
      `    ${providedHttpRouterName}:`,
      `      rule: "${quoteHostnames(providedHostnames)}"`,
      "      entryPoints:",
      "        - web",
      `      service: ${serviceName}`
    );
  }

  if (customHostnames.length > 0) {
    lines.push(
      `    ${customHttpRouterName}:`,
      `      rule: "${quoteHostnames(customHostnames)}"`,
      "      entryPoints:",
      "        - web",
      "      middlewares:",
      `        - ${redirectMiddlewareName}`,
      ...(route.replacePath ? [`        - ${replacePathMiddlewareName}`] : []),
      `      service: ${serviceName}`,
      `    ${customHttpsRouterName}:`,
      `      rule: "${quoteHostnames(customHostnames)}"`,
      "      entryPoints:",
      "        - websecure",
      ...(route.replacePath
        ? ["      middlewares:", `        - ${replacePathMiddlewareName}`]
        : []),
      `      service: ${serviceName}`,
      "      tls:",
      "        certResolver: letsencrypt",
      "  middlewares:",
      `    ${redirectMiddlewareName}:`,
      "      redirectScheme:",
      "        scheme: https",
      "        permanent: true",
      ...(route.replacePath
        ? [
            `    ${replacePathMiddlewareName}:`,
            "      replacePath:",
            `        path: ${route.replacePath}`,
          ]
        : [])
    );
  }

  lines.push(
    "  services:",
    `    ${serviceName}:`,
    "      loadBalancer:",
    `        passHostHeader: ${route.passHostHeader !== false ? "true" : "false"}`,
    "        servers:",
    `          - url: ${route.serviceUrl}`
  );

  return serializeYaml(lines);
}

export function renderTraefikStaticConfig(
  paths: TraefikRuntimePaths,
  trustedForwardedPeers?: readonly string[]
): string {
  const forwardingPeers = selectTrustedForwardedPeers(trustedForwardedPeers);

  return serializeYaml([
    "api:",
    "  insecure: true",
    "  dashboard: true",
    "ping:",
    `  entryPoint: ${TRAEFIK_API_ENTRYPOINT}`,
    "entryPoints:",
    "  web:",
    '    address: ":80"',
    // A provided hostname arrives here as a plain HTTP hop from the hosted edge, which already
    // terminated the browser's TLS. With no peer named, Traefik discards the incoming
    // `X-Forwarded-*` headers and re-derives them from this connection, so the app sees `http` on
    // port 80 for a request the user made over HTTPS — and everything a framework builds from that
    // header (OAuth redirect URIs, `Secure` cookies, HTTPS redirects) follows it. Peers outside
    // this list, including anyone dialling port 80 directly, keep being rewritten.
    ...(forwardingPeers.length > 0
      ? [
          "    forwardedHeaders:",
          "      trustedIPs:",
          ...forwardingPeers.map((peer) => `        - ${peer}`),
        ]
      : []),
    // websecure is deliberately left untrusting: it terminates the customer's own certificate
    // with the browser on the other end, so nothing forwards to it.
    "  websecure:",
    '    address: ":443"',
    `  ${TRAEFIK_API_ENTRYPOINT}:`,
    '    address: ":8082"',
    // Request metrics ride the existing admin entrypoint, which is already bound to
    // 127.0.0.1 on the host, so this adds no new host exposure. Alloy reaches it
    // container-to-container over `nouva-ingress` instead (#137).
    "metrics:",
    "  prometheus:",
    `    entryPoint: ${TRAEFIK_API_ENTRYPOINT}`,
    // Only the service dimension is kept. Entrypoint series say nothing per service, and
    // router series would multiply every service by its router count (provided HTTP, custom
    // HTTP, custom HTTPS) for a breakdown nothing queries.
    "    addEntryPointsLabels: false",
    "    addRoutersLabels: false",
    "    addServicesLabels: true",
    "providers:",
    "  file:",
    `    directory: "${paths.dynamicDir}"`,
    "    watch: true",
    "certificatesResolvers:",
    "  letsencrypt:",
    "    acme:",
    `      storage: "${paths.acmeStoragePath}"`,
    "      httpChallenge:",
    "        entryPoint: web",
  ]);
}

export function createTraefikStateHash(staticConfig: string): string {
  return createHash("sha256").update(staticConfig).digest("hex");
}

export function buildTraefikContainerSpec(
  config: AgentRuntimeConfig,
  options: BuildTraefikContainerSpecOptions
): DockerContainerSpec {
  const publicBindings = options.publicBindings ?? true;
  const adminHostPort = options.adminHostPort ?? TRAEFIK_ADMIN_PORT;

  return {
    name: options.name ?? TRAEFIK_CONTAINER_NAME,
    image: options.image ?? TRAEFIK_IMAGE,
    cmd: [
      `--configFile=${path.posix.join(
        AGENT_DATA_DIR_IN_CONTAINER,
        "traefik",
        "static",
        "traefik.yml"
      )}`,
    ],
    labels: {
      ...(options.labels ?? {}),
      [TRAEFIK_CONFIG_HASH_LABEL]: options.stateHash,
      [TRAEFIK_ROLE_LABEL]: publicBindings ? "primary" : "candidate",
    },
    exposedPorts: {
      "80/tcp": {},
      "443/tcp": {},
      "8082/tcp": {},
    },
    hostConfig: {
      Binds: [`${options.dataVolume}:${AGENT_DATA_DIR_IN_CONTAINER}`],
      PortBindings: {
        ...(publicBindings
          ? {
              "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "80" }],
              "443/tcp": [{ HostIp: "0.0.0.0", HostPort: "443" }],
            }
          : {}),
        "8082/tcp": [
          {
            HostIp: TRAEFIK_ADMIN_HOST,
            HostPort: String(adminHostPort),
          },
        ],
      },
      RestartPolicy: {
        Name: publicBindings ? "unless-stopped" : "no",
      },
      LogConfig: MANAGED_CONTAINER_LOG_CONFIG,
    },
    networkingConfig: {
      EndpointsConfig: {
        [config.localTraefikNetwork]: {},
      },
    },
  };
}

export async function writeTraefikRouteFile(
  paths: TraefikRuntimePaths,
  serviceId: string,
  hostnames: {
    providedHostname?: string | null;
    customHostnames?: string[] | null;
  },
  serviceUrl: string,
  options: { passHostHeader?: boolean; replacePath?: string | null } = {}
): Promise<void> {
  const providedHostnames = resolveRoutingHostnames({
    providedHostname: hostnames.providedHostname,
  });
  const customHostnames = resolveRoutingHostnames({
    customHostnames: hostnames.customHostnames,
  });

  if (providedHostnames.length === 0 && customHostnames.length === 0) {
    await deleteTraefikRouteFile(paths, serviceId);
    return;
  }

  await writeManagedFile(
    path.join(paths.dynamicDir, `${serviceId}.yml`),
    buildTraefikRouteConfig({
      fileKey: serviceId,
      providedHostnames,
      customHostnames,
      serviceUrl,
      ...options,
    })
  );
}

export async function writeLocalTraefikRoute(
  paths: TraefikRuntimePaths,
  serviceId: string,
  hostnames: {
    providedHostname?: string | null;
    customHostnames?: string[] | null;
  },
  serviceUrl: string,
  options: { passHostHeader?: boolean; replacePath?: string | null } = {}
): Promise<void> {
  await writeTraefikRouteFile(paths, serviceId, hostnames, serviceUrl, options);
}

export async function deleteTraefikRouteFile(
  paths: TraefikRuntimePaths,
  serviceId: string
): Promise<void> {
  await rm(path.join(paths.dynamicDir, `${serviceId}.yml`), { force: true });
}

export async function deleteLocalTraefikRoute(
  paths: TraefikRuntimePaths,
  serviceId: string
): Promise<void> {
  await deleteTraefikRouteFile(paths, serviceId);
}

export async function reconcileTraefikRuntime(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  options: ReconcileTraefikRuntimeOptions
): Promise<void> {
  const paths = options.paths ?? getTraefikRuntimePaths("/var/lib/nouva-agent");

  await ensureTraefikState(paths);
  await docker.ensureNetwork(config.localTraefikNetwork);

  const staticConfig = renderTraefikStaticConfig(paths, config.trustedForwardedPeers);
  await writeManagedFile(paths.staticConfigPath, staticConfig);
  const stateHash = createTraefikStateHash(staticConfig);
  const current = await docker.inspectContainer(TRAEFIK_CONTAINER_NAME);
  const serverId = options.labels?.["nouva.server.id"];

  if (isTraefikContainerCurrent(current, stateHash)) {
    await connectTraefikToManagedProjectNetworks(docker, TRAEFIK_CONTAINER_NAME, serverId);
    lastTraefikRuntimeFailure = null;
    return;
  }

  const previousImage = current?.Config?.Image ?? null;
  await docker.pullImage(TRAEFIK_IMAGE);
  await docker.removeContainer(TRAEFIK_CANDIDATE_CONTAINER_NAME, true);

  await docker.ensureContainer(
    buildTraefikContainerSpec(config, {
      dataVolume: options.dataVolume,
      labels: options.labels,
      name: TRAEFIK_CANDIDATE_CONTAINER_NAME,
      publicBindings: false,
      adminHostPort: TRAEFIK_CANDIDATE_ADMIN_PORT,
      stateHash,
    }),
    true
  );
  await connectTraefikToManagedProjectNetworks(docker, TRAEFIK_CANDIDATE_CONTAINER_NAME, serverId);

  try {
    await waitForTraefikHealth(docker, paths, {
      containerName: TRAEFIK_CANDIDATE_CONTAINER_NAME,
      adminPort: TRAEFIK_CANDIDATE_ADMIN_PORT,
      expectPublicBindings: false,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs ?? 15_000,
      intervalMs: options.intervalMs ?? 250,
    });
  } catch (error) {
    await docker.removeContainer(TRAEFIK_CANDIDATE_CONTAINER_NAME, true);
    recordTraefikRuntimeFailure({
      phase: "preflight",
      message: error instanceof Error ? error.message : "Traefik candidate preflight failed",
      rollbackStatus: "not-needed",
    });
    throw error;
  }

  await docker.removeContainer(TRAEFIK_CONTAINER_NAME, true);
  await docker.ensureContainer(
    buildTraefikContainerSpec(config, {
      dataVolume: options.dataVolume,
      labels: options.labels,
      stateHash,
    }),
    true
  );
  await connectTraefikToManagedProjectNetworks(docker, TRAEFIK_CONTAINER_NAME, serverId);

  try {
    await waitForTraefikHealth(docker, paths, {
      containerName: TRAEFIK_CONTAINER_NAME,
      adminPort: TRAEFIK_ADMIN_PORT,
      expectPublicBindings: true,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs ?? 15_000,
      intervalMs: options.intervalMs ?? 250,
    });
    lastTraefikRuntimeFailure = null;
  } catch (error) {
    await docker.removeContainer(TRAEFIK_CONTAINER_NAME, true);

    let rollbackStatus: TraefikRuntimeFailure["rollbackStatus"] = "not-needed";
    if (previousImage) {
      try {
        await docker.ensureContainer(
          buildTraefikContainerSpec(config, {
            dataVolume: options.dataVolume,
            labels: options.labels,
            image: previousImage,
            stateHash,
          }),
          true
        );
        await connectTraefikToManagedProjectNetworks(docker, TRAEFIK_CONTAINER_NAME, serverId);
        await waitForTraefikHealth(docker, paths, {
          containerName: TRAEFIK_CONTAINER_NAME,
          adminPort: TRAEFIK_ADMIN_PORT,
          expectPublicBindings: true,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs ?? 15_000,
          intervalMs: options.intervalMs ?? 250,
        });
        rollbackStatus = "succeeded";
      } catch {
        rollbackStatus = "failed";
      }
    }

    recordTraefikRuntimeFailure({
      phase: "cutover",
      message: error instanceof Error ? error.message : "Traefik cutover failed",
      rollbackStatus,
    });
    throw error;
  } finally {
    await docker.removeContainer(TRAEFIK_CANDIDATE_CONTAINER_NAME, true);
  }
}

export async function collectTraefikValidationChecks(
  docker: DockerApiClient,
  inputOrOptions: TraefikRuntimeInput | CollectTraefikValidationChecksOptions = {},
  deps?: CollectTraefikValidationChecksOptions,
  bootstrapError?: Error | null
): Promise<ServerValidationCheck[]> {
  const options = resolveValidationOptions(inputOrOptions, deps);
  const paths = options.paths ?? getTraefikRuntimePaths("/var/lib/nouva-agent");
  const probe = await probeTraefikRuntime(docker, paths, {
    fetchImpl: options.fetchImpl,
  });

  const checks: ServerValidationCheck[] = [];
  checks.push(
    buildCheck(
      "traefik-image",
      "Traefik image",
      probe.inspection?.Config?.Image === TRAEFIK_IMAGE ? "pass" : "fail",
      probe.inspection?.Config?.Image === TRAEFIK_IMAGE
        ? `Running pinned image ${TRAEFIK_IMAGE}`
        : `Expected ${TRAEFIK_IMAGE}`,
      probe.inspection?.Config?.Image ?? null
    )
  );

  const containerStatus: ServerCheckStatus =
    probe.inspection?.State?.Running === true
      ? lastTraefikRuntimeFailure || bootstrapError
        ? "warn"
        : "pass"
      : "fail";
  const containerMessage =
    probe.inspection?.State?.Running === true
      ? lastTraefikRuntimeFailure
        ? `Traefik is running but the last reconcile failed during ${lastTraefikRuntimeFailure.phase}: ${lastTraefikRuntimeFailure.message} (rollback ${lastTraefikRuntimeFailure.rollbackStatus})`
        : bootstrapError
          ? `Traefik is running but reconcile failed: ${bootstrapError.message}`
          : "Traefik container is running"
      : "Traefik container is not running";

  checks.push(
    buildCheck(
      "traefik-container",
      "Traefik container",
      containerStatus,
      containerMessage,
      probe.inspection?.Name ?? null
    )
  );

  const port80Bound = hasPortBinding(probe.inspection, "80/tcp", {
    hostIp: "0.0.0.0",
    hostPort: "80",
  });
  checks.push(
    buildCheck(
      "traefik-port-80",
      "Traefik port 80",
      port80Bound ? "pass" : "fail",
      port80Bound ? "Traefik is bound on 0.0.0.0:80" : "Traefik is not bound on 0.0.0.0:80",
      "0.0.0.0:80"
    )
  );

  const port443Bound = hasPortBinding(probe.inspection, "443/tcp", {
    hostIp: "0.0.0.0",
    hostPort: "443",
  });
  checks.push(
    buildCheck(
      "traefik-port-443",
      "Traefik port 443",
      port443Bound ? "pass" : "fail",
      port443Bound ? "Traefik is bound on 0.0.0.0:443" : "Traefik is not bound on 0.0.0.0:443",
      "0.0.0.0:443"
    )
  );

  checks.push(
    buildCheck(
      "traefik-ping",
      "Traefik ping",
      probe.pingOk ? "pass" : "fail",
      probe.pingOk
        ? "Traefik ping endpoint responds on 127.0.0.1:8082"
        : "Traefik ping endpoint is not reachable on 127.0.0.1:8082",
      "127.0.0.1:8082"
    )
  );

  checks.push(
    buildCheck(
      "traefik-acme",
      "Traefik ACME storage",
      probe.acmeStatus,
      probe.acmeMessage,
      probe.acmeMode
    )
  );

  const routesStatus: ServerCheckStatus =
    probe.expectedRouterCount === 0
      ? "pass"
      : probe.managedRouterCount !== null && probe.managedRouterCount >= probe.expectedRouterCount
        ? "pass"
        : "fail";
  const routesMessage =
    probe.expectedRouterCount === 0
      ? "No active Traefik route files are configured"
      : routesStatus === "pass"
        ? `Loaded ${probe.managedRouterCount} routers from ${probe.routeFileCount} route files`
        : `Expected ${probe.expectedRouterCount} file-provider routers from ${probe.routeFileCount} route files but found ${probe.managedRouterCount ?? 0}`;

  checks.push(
    buildCheck(
      "traefik-routes",
      "Traefik routes",
      routesStatus,
      routesMessage,
      String(probe.routeFileCount)
    )
  );

  return checks;
}

export async function ensureTraefikRuntime(
  docker: DockerApiClient,
  input: TraefikRuntimeInput,
  deps: TraefikRuntimeDeps = {}
): Promise<void> {
  await reconcileTraefikRuntime(docker, buildTraefikRuntimeConfig(input), {
    dataVolume: input.dataVolume,
    labels: buildTraefikLabels(input),
    paths: deps.paths ?? getTraefikRuntimePaths(input.dataDir),
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    intervalMs: deps.intervalMs,
  });
}

export function buildUnavailableTraefikChecks(reason: string): ServerValidationCheck[] {
  return [
    buildCheck("traefik-image", "Traefik image", "fail", reason),
    buildCheck("traefik-container", "Traefik container", "fail", reason),
    buildCheck("traefik-port-80", "Traefik port 80", "fail", reason, "0.0.0.0:80"),
    buildCheck("traefik-port-443", "Traefik port 443", "fail", reason, "0.0.0.0:443"),
    buildCheck("traefik-ping", "Traefik ping", "fail", reason, "127.0.0.1:8082"),
    buildCheck("traefik-acme", "Traefik ACME storage", "fail", reason),
    buildCheck("traefik-routes", "Traefik routes", "fail", reason),
  ];
}
