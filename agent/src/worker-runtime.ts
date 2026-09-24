import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_WORKER_SHUTDOWN_POLICY,
  parseWorkerShutdownPolicy,
  type WorkerShutdownPolicy,
  type WorkerShutdownReport,
  type WorkerShutdownRole,
} from "@repo/runtime/worker-shutdown";
import { hashProjectNetwork } from "./build.js";
import {
  type DockerApiClient,
  type DockerContainerInspection,
  type DockerContainerSpec,
  type DockerImageInspection,
  REDACTION_CONTEXT_VERSION_DOCKER_LABEL,
} from "./docker-api.js";
import { toDockerResourceSettings } from "./docker-resource-limits.js";
import type {
  AgentImageStoreMode,
  AppVolumeIdentity,
  RuntimeMetadata,
  RuntimeRetainedImage,
  WorkerDeployOnlyPayload,
  WorkerJobLifecyclePayload,
  WorkerJobPayload,
} from "./protocol.js";
import { removeManagedServiceContainers } from "./service-container-cleanup.js";
import { planWorkerRollout, type WorkerRolloutPlan } from "./worker-rollout-plan.js";
import {
  describeWorkerShutdownReport,
  resolveWorkerStopSignal,
  SYSTEM_WORKER_SHUTDOWN_CLOCK,
  stopWorkerContainerGracefully,
  type WorkerShutdownClock,
} from "./worker-shutdown.js";

const WORKER_VOLUME_SNAPSHOT_IMAGE = "alpine:3.21";
const WORKER_HEALTHCHECK_INTERVAL_NS = 10_000_000_000;
const WORKER_HEALTHCHECK_TIMEOUT_NS = 5_000_000_000;
const WORKER_HEALTHCHECK_START_PERIOD_NS = 10_000_000_000;

export const DEFAULT_WORKER_READINESS_TIMEOUT_MS = 60_000;
export const DEFAULT_WORKER_READINESS_INTERVAL_MS = 500;
export const DEFAULT_WORKER_RUNNING_GRACE_MS = 10_000;
export const DEFAULT_WORKER_CRASH_LOOP_RESTART_COUNT = 3;

type WorkerRuntimeDocker = Pick<
  DockerApiClient,
  | "containerLogs"
  | "createContainer"
  | "createVolume"
  | "ensureContainer"
  | "ensureNetwork"
  | "inspectContainer"
  | "inspectImage"
  | "killContainer"
  | "listContainersByLabels"
  | "listContainersUsingVolume"
  | "pullImage"
  | "removeContainer"
  | "removeImage"
  | "restartContainer"
  | "startContainer"
  | "stopContainer"
  | "updateContainerRestartPolicy"
  | "waitContainer"
>;

export interface WorkerRuntimeEnvironment {
  serverId: string;
  imageStoreMode: AgentImageStoreMode;
  dataDir: string;
  dataVolume: string;
}

export interface WorkerImageCommand {
  entrypoint: string[];
  command: string[];
  display: string;
}

export interface WorkerRuntimeInstance {
  kind: "worker";
  status: "running";
  replicaIndex: number;
  name: string;
  image: string;
  containerId: string;
  containerName: string;
  networkName: string;
  internalHost: string;
}

export interface WorkerRolloutResult {
  strategy: WorkerRolloutPlan["strategy"];
  outcome: "committed" | "aborted_before_cutover" | "rolled_back";
  currentPhase: "candidate" | "ready" | "retire" | "restore";
  liveRuntimePreserved: boolean;
  rollbackCompleted: boolean;
  activeContainerNames: string[];
  candidateContainerNames: string[];
  /** The shutdown policy this rollout applied, after defaults. */
  policy: WorkerShutdownPolicy;
  /** How each process this rollout stopped actually stopped, in the order they were stopped. */
  shutdowns: WorkerShutdownReport[];
}

export class WorkerRolloutError extends Error {
  readonly result: Record<string, unknown>;

  constructor(message: string, rollout: WorkerRolloutResult) {
    super(message);
    this.name = "WorkerRolloutError";
    this.result = { rollout };
  }
}

interface WorkerJobReceipt {
  version: 1;
  projectId: string;
  serviceId: string;
  deploymentId: string;
  scheduleRunId: string;
  scheduleId: string;
  occurrenceKey: string;
  jobName: string;
  imageUrl: string;
  containerId: string;
  containerName: string;
  status: "created" | "running" | "succeeded" | "failed" | "cancelled" | "missing";
  exitCode: number | null;
  createdAt: string;
  completedAt: string | null;
}

function normalizeCommandParts(parts: string[] | null | undefined): string[] {
  return (parts ?? []).map((part) => part.trim()).filter((part) => part.length > 0);
}

function normalizeWorkerCommand(command: string | null | undefined): string | null {
  const normalized = command?.trim();
  return normalized ? normalized : null;
}

function getWorkerProjectNetwork(projectId: string): string {
  return `nouva-project-${hashProjectNetwork(projectId)}`;
}

function getContainerName(container: DockerContainerInspection): string {
  return container.Name.replace(/^\//, "");
}

function getContainerIdentifier(container: DockerContainerInspection): string {
  return container.Id || getContainerName(container);
}

function buildWorkerLabels(input: {
  serverId: string;
  kind: "worker" | "worker_job" | "worker_volume_task";
  projectId: string;
  environmentId?: string | null;
  serviceId: string;
  deploymentId?: string | null;
  replicaIndex?: number;
  scheduleId?: string;
  scheduleRunId?: string;
  occurrenceKey?: string;
  redactionContextVersion?: string | null;
}): Record<string, string> {
  return {
    "nouva.managed": "true",
    "nouva.server.id": input.serverId,
    "nouva.kind": input.kind,
    "nouva.service.type": "worker",
    "nouva.project.id": input.projectId,
    "nouva.service.id": input.serviceId,
    ...(input.environmentId ? { "nouva.environment.id": input.environmentId } : {}),
    ...(input.deploymentId ? { "nouva.deployment.id": input.deploymentId } : {}),
    ...(typeof input.replicaIndex === "number"
      ? { "nouva.replica.index": String(input.replicaIndex) }
      : {}),
    ...(input.scheduleId ? { "nouva.schedule.id": input.scheduleId } : {}),
    ...(input.scheduleRunId ? { "nouva.schedule.run.id": input.scheduleRunId } : {}),
    ...(input.occurrenceKey ? { "nouva.schedule.occurrence.key": input.occurrenceKey } : {}),
    ...(input.redactionContextVersion
      ? { [REDACTION_CONTEXT_VERSION_DOCKER_LABEL]: input.redactionContextVersion }
      : {}),
  };
}

export function buildWorkerReplicaContainerName(
  serviceId: string,
  deploymentId: string,
  replicaIndex: number
): string {
  return `nouva-worker-${serviceId.slice(0, 8)}-${deploymentId.slice(0, 8)}-${replicaIndex}`;
}

export function buildWorkerJobContainerName(serviceId: string, scheduleRunId: string): string {
  return `nouva-worker-job-${serviceId.slice(0, 8)}-${scheduleRunId.slice(0, 8)}`;
}

export function detectWorkerImageCommand(
  inspection: DockerImageInspection | null
): WorkerImageCommand | null {
  const entrypoint = normalizeCommandParts(inspection?.Config?.Entrypoint);
  const command = normalizeCommandParts(inspection?.Config?.Cmd);
  if (entrypoint.length === 0 && command.length === 0) {
    return null;
  }

  return {
    entrypoint,
    command,
    display: [...entrypoint, ...command].join(" "),
  };
}

function imageHasHealthcheck(inspection: DockerImageInspection | null): boolean {
  const test = inspection?.Config?.Healthcheck?.Test;
  return Array.isArray(test) && test.length > 0 && test[0]?.toUpperCase() !== "NONE";
}

export function buildWorkerHealthcheck(
  command: string | null | undefined
): DockerContainerSpec["healthcheck"] {
  const normalizedCommand = normalizeWorkerCommand(command);
  if (!normalizedCommand) {
    return undefined;
  }

  return {
    Test: ["CMD-SHELL", normalizedCommand],
    Interval: WORKER_HEALTHCHECK_INTERVAL_NS,
    Timeout: WORKER_HEALTHCHECK_TIMEOUT_NS,
    Retries: 3,
    StartPeriod: WORKER_HEALTHCHECK_START_PERIOD_NS,
  };
}

/**
 * The shutdown policy a worker payload asks for. The control plane only queues valid policies and
 * older control planes queue none, so anything unreadable falls back to the documented default
 * rather than failing a rollout the operator did not change.
 */
export function resolveWorkerShutdownPolicy(
  payload: Pick<WorkerDeployOnlyPayload, "shutdownPolicy">
): WorkerShutdownPolicy {
  return parseWorkerShutdownPolicy(payload.shutdownPolicy) ?? DEFAULT_WORKER_SHUTDOWN_POLICY;
}

export function buildWorkerContainerSpec(input: {
  environment: Pick<WorkerRuntimeEnvironment, "serverId">;
  payload: WorkerDeployOnlyPayload;
  image: DockerImageInspection | null;
  replicaIndex: number;
}): {
  containerName: string;
  projectNetwork: string;
  hasHealthcheck: boolean;
  imageCommand: WorkerImageCommand | null;
  spec: DockerContainerSpec;
} {
  const { payload } = input;
  const containerName = buildWorkerReplicaContainerName(
    payload.serviceId,
    payload.deploymentId,
    input.replicaIndex
  );
  const projectNetwork = getWorkerProjectNetwork(payload.projectId);
  const startCommand = normalizeWorkerCommand(payload.startCommand);
  const imageCommand = detectWorkerImageCommand(input.image);
  if (!startCommand && !imageCommand) {
    throw new Error(
      `Worker image ${payload.imageUrl} has no runnable default entrypoint or command. ` +
        "Set a worker start command or rebuild the image with a CMD or ENTRYPOINT."
    );
  }

  const healthcheck = buildWorkerHealthcheck(payload.healthCheckCommand);
  const shutdownPolicy = resolveWorkerShutdownPolicy(payload);
  return {
    containerName,
    projectNetwork,
    hasHealthcheck: Boolean(healthcheck) || imageHasHealthcheck(input.image),
    imageCommand,
    spec: {
      name: containerName,
      image: payload.imageUrl,
      env: Object.entries(payload.envVars).map(([key, value]) => `${key}=${value}`),
      ...(startCommand
        ? {
            entrypoint: ["/bin/sh", "-lc"],
            cmd: [startCommand],
          }
        : {}),
      labels: buildWorkerLabels({
        serverId: input.environment.serverId,
        kind: "worker",
        projectId: payload.projectId,
        environmentId: payload.environmentId ?? null,
        serviceId: payload.serviceId,
        deploymentId: payload.deploymentId,
        redactionContextVersion: payload.redactionContextVersion,
        replicaIndex: input.replicaIndex,
      }),
      ...(healthcheck ? { healthcheck } : {}),
      // Baked in so a daemon shutdown, a host reboot or a `restart_worker` stops the process the
      // same way a rollout does, not with Docker's 10-second default. Without a chosen signal the
      // container keeps the image's STOPSIGNAL, which a rollout then reads back to stop it with.
      ...(shutdownPolicy.signal ? { stopSignal: shutdownPolicy.signal } : {}),
      stopTimeoutSeconds: shutdownPolicy.gracePeriodSeconds,
      hostConfig: {
        ...(payload.volume
          ? {
              Mounts: [
                {
                  Type: "volume",
                  Source: payload.volume.volumeName,
                  Target: payload.volume.mountPath,
                },
              ],
            }
          : {}),
        RestartPolicy: {
          Name: "unless-stopped",
        },
        ...toDockerResourceSettings(payload.resourceLimits),
      },
      networkingConfig: {
        EndpointsConfig: {
          [projectNetwork]: {},
        },
      },
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalContainerStatus(status: string | undefined): boolean {
  return status === "dead" || status === "exited" || status === "removing";
}

export async function waitForWorkerReadiness(
  docker: Pick<DockerApiClient, "inspectContainer">,
  input: {
    containerName: string;
    hasHealthcheck: boolean;
    timeoutMs?: number;
    intervalMs?: number;
    runningGraceMs?: number;
    crashLoopRestartCount?: number;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  }
): Promise<void> {
  const now = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? DEFAULT_WORKER_READINESS_TIMEOUT_MS;
  const intervalMs = input.intervalMs ?? DEFAULT_WORKER_READINESS_INTERVAL_MS;
  const runningGraceMs = input.runningGraceMs ?? DEFAULT_WORKER_RUNNING_GRACE_MS;
  const crashLoopRestartCount =
    input.crashLoopRestartCount ?? DEFAULT_WORKER_CRASH_LOOP_RESTART_COUNT;
  const deadline = now() + timeoutMs;
  let runningSince: number | null = null;
  let observedRestartCount: number | null = null;

  while (now() <= deadline) {
    const inspection = await docker.inspectContainer(input.containerName);
    if (!inspection) {
      throw new Error(`Worker candidate ${input.containerName} is missing`);
    }

    const status = inspection.State?.Status?.toLowerCase();
    if (isTerminalContainerStatus(status)) {
      throw new Error(`Worker candidate ${input.containerName} is not running (${status})`);
    }

    const restartCount = inspection.RestartCount ?? 0;
    if (restartCount >= crashLoopRestartCount) {
      throw new Error(
        `Worker candidate ${input.containerName} is crash-looping (${restartCount} restarts)`
      );
    }
    if (observedRestartCount !== null && restartCount > observedRestartCount) {
      runningSince = null;
    }
    observedRestartCount = restartCount;

    const healthStatus = inspection.State?.Health?.Status?.toLowerCase();
    if (healthStatus === "unhealthy") {
      throw new Error(`Worker candidate ${input.containerName} became unhealthy`);
    }

    if (input.hasHealthcheck) {
      if (healthStatus === "healthy") {
        return;
      }
    } else if (inspection.State?.Running) {
      runningSince ??= now();
      if (now() - runningSince >= runningGraceMs) {
        return;
      }
    } else {
      runningSince = null;
    }

    await (input.wait ?? sleep)(intervalMs);
  }

  if (input.hasHealthcheck) {
    throw new Error(
      `Worker candidate ${input.containerName} did not become healthy within ${timeoutMs}ms`
    );
  }
  throw new Error(
    `Worker candidate ${input.containerName} did not remain running for ${runningGraceMs}ms`
  );
}

function resolveCurrentRuntimeImage(
  runtimeMetadata: RuntimeMetadata | null | undefined
): RuntimeRetainedImage | null {
  if (runtimeMetadata?.currentImage) {
    return runtimeMetadata.currentImage;
  }
  if (runtimeMetadata?.image) {
    return {
      reference: runtimeMetadata.image,
      imageId: null,
      deploymentId: null,
      commitHash: null,
    };
  }
  return null;
}

function resolvePreviousRuntimeImage(
  runtimeMetadata: RuntimeMetadata | null | undefined
): RuntimeRetainedImage | null {
  return runtimeMetadata?.previousImage ?? null;
}

function sameRetainedImage(
  left: RuntimeRetainedImage | null,
  right: RuntimeRetainedImage | null
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.imageId && right.imageId
    ? left.imageId === right.imageId
    : left.reference === right.reference;
}

function getRetainedImageReferences(runtimeMetadata: RuntimeMetadata | null | undefined): string[] {
  return [resolveCurrentRuntimeImage(runtimeMetadata), resolvePreviousRuntimeImage(runtimeMetadata)]
    .map((image) => image?.reference || image?.imageId || null)
    .filter((reference): reference is string => Boolean(reference))
    .filter((reference, index, references) => references.indexOf(reference) === index);
}

function shouldRetainWorkerImage(
  runtimeMetadata: RuntimeMetadata | null | undefined,
  reference: string
): boolean {
  return getRetainedImageReferences(runtimeMetadata).includes(reference);
}

async function ensureWorkerImage(
  docker: Pick<DockerApiClient, "inspectImage" | "pullImage">,
  environment: Pick<WorkerRuntimeEnvironment, "imageStoreMode">,
  imageUrl: string
): Promise<DockerImageInspection> {
  let inspection = await docker.inspectImage(imageUrl);
  if (!inspection && environment.imageStoreMode !== "docker-local") {
    await docker.pullImage(imageUrl);
    inspection = await docker.inspectImage(imageUrl);
  }
  if (!inspection) {
    throw new Error(`Worker image ${imageUrl} is not available locally`);
  }
  return inspection;
}

async function listWorkerServiceContainers(
  docker: Pick<DockerApiClient, "listContainersByLabels">,
  serviceId: string
): Promise<DockerContainerInspection[]> {
  const containers = await docker.listContainersByLabels({
    "nouva.managed": "true",
    "nouva.kind": "worker",
    "nouva.service.id": serviceId,
  });
  const seen = new Set<string>();
  return containers.filter((container) => {
    const identifier = getContainerIdentifier(container);
    if (seen.has(identifier)) {
      return false;
    }
    seen.add(identifier);
    return true;
  });
}

function assertReplicaCount(replicaCount: number): void {
  if (!Number.isInteger(replicaCount) || replicaCount < 0 || replicaCount > 32) {
    throw new Error("Worker replicaCount must be an integer from 0 through 32");
  }
}

function assertWorkerJobTimeout(timeoutSeconds: number): void {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 24 * 60 * 60) {
    throw new Error("Worker job timeoutSeconds must be an integer from 60 through 86400");
  }
}

function assertVolumeWorkerPayload(payload: WorkerDeployOnlyPayload): void {
  if (payload.volume && payload.replicaCount > 1) {
    throw new Error("Volume-backed workers support at most one continuous replica");
  }
}

async function assertNoUnexpectedVolumeConsumer(
  docker: Pick<DockerApiClient, "listContainersUsingVolume">,
  volumeName: string,
  allowedNames: Set<string>
): Promise<void> {
  const consumers = await docker.listContainersUsingVolume(volumeName);
  const unexpected = consumers.filter(
    (container) => container.State?.Running && !allowedNames.has(getContainerName(container))
  );
  if (unexpected.length > 0) {
    throw new Error(`Volume ${volumeName} has another running consumer`);
  }
}

function buildWorkerVolumeSnapshotName(payload: WorkerDeployOnlyPayload): string {
  return `${payload.serviceId}-${payload.deploymentId}.tar.gz`;
}

async function runWorkerVolumeTask(
  docker: Pick<
    DockerApiClient,
    | "containerLogs"
    | "createContainer"
    | "pullImage"
    | "removeContainer"
    | "startContainer"
    | "waitContainer"
  >,
  environment: Pick<WorkerRuntimeEnvironment, "serverId" | "dataVolume">,
  input: {
    name: string;
    projectId: string;
    serviceId: string;
    command: string;
    mounts: Array<{ source: string; target: string; readOnly?: boolean }>;
  }
): Promise<void> {
  await docker.pullImage(WORKER_VOLUME_SNAPSHOT_IMAGE);
  await docker.removeContainer(input.name, true);
  const id = await docker.createContainer({
    name: input.name,
    image: WORKER_VOLUME_SNAPSHOT_IMAGE,
    entrypoint: ["/bin/sh", "-ec"],
    cmd: [input.command],
    tty: true,
    labels: buildWorkerLabels({
      serverId: environment.serverId,
      kind: "worker_volume_task",
      projectId: input.projectId,
      serviceId: input.serviceId,
    }),
    hostConfig: {
      AutoRemove: false,
      Mounts: input.mounts.map((mount) => ({
        Type: "volume",
        Source: mount.source,
        Target: mount.target,
        ReadOnly: mount.readOnly === true,
      })),
    },
  });

  try {
    await docker.startContainer(id);
    const status = await docker.waitContainer(id);
    if (status !== 0) {
      const logs = await docker.containerLogs(id).catch(() => "");
      throw new Error(logs.trim() || `Worker volume task ${input.name} failed (${status})`);
    }
  } finally {
    await docker.removeContainer(id, true);
  }
}

async function createWorkerVolumeSnapshot(
  docker: WorkerRuntimeDocker,
  environment: WorkerRuntimeEnvironment,
  payload: WorkerDeployOnlyPayload
): Promise<string> {
  if (!payload.volume) {
    throw new Error("Worker volume snapshot requires a volume");
  }
  const snapshotName = buildWorkerVolumeSnapshotName(payload);
  await docker.createVolume(environment.dataVolume);
  await runWorkerVolumeTask(docker, environment, {
    name: `nouva-worker-snapshot-${payload.deploymentId.slice(0, 12)}`,
    projectId: payload.projectId,
    serviceId: payload.serviceId,
    command: [
      "mkdir -p /agent-data/worker-volume-snapshots",
      `final=/agent-data/worker-volume-snapshots/${snapshotName}`,
      'if [ -s "$final" ]; then exit 0; fi',
      "required=$(du -sk /source | awk '{print $1}')",
      "available=$(df -Pk /agent-data | awk 'NR==2 {print $4}')",
      'if [ "$available" -le "$required" ]; then echo "Insufficient snapshot capacity" >&2; exit 1; fi',
      'tmp="$final.tmp"',
      'rm -f "$tmp"',
      'tar -C /source -czpf "$tmp" .',
      'test -s "$tmp"',
      'mv "$tmp" "$final"',
    ].join("\n"),
    mounts: [
      { source: payload.volume.volumeName, target: "/source", readOnly: true },
      { source: environment.dataVolume, target: "/agent-data" },
    ],
  });
  return snapshotName;
}

async function restoreWorkerVolumeSnapshot(
  docker: WorkerRuntimeDocker,
  environment: WorkerRuntimeEnvironment,
  payload: WorkerDeployOnlyPayload,
  snapshotName: string
): Promise<void> {
  if (!payload.volume) {
    throw new Error("Worker volume restore requires a volume");
  }
  await runWorkerVolumeTask(docker, environment, {
    name: `nouva-worker-restore-${payload.deploymentId.slice(0, 12)}`,
    projectId: payload.projectId,
    serviceId: payload.serviceId,
    command: [
      `archive=/agent-data/worker-volume-snapshots/${snapshotName}`,
      'test -s "$archive"',
      "find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +",
      'tar -C /target -xzpf "$archive"',
    ].join("\n"),
    mounts: [
      { source: payload.volume.volumeName, target: "/target" },
      { source: environment.dataVolume, target: "/agent-data", readOnly: true },
    ],
  });
}

async function deleteWorkerVolumeSnapshotBestEffort(
  docker: WorkerRuntimeDocker,
  environment: WorkerRuntimeEnvironment,
  payload: WorkerDeployOnlyPayload,
  snapshotName: string
): Promise<void> {
  try {
    await runWorkerVolumeTask(docker, environment, {
      name: `nouva-worker-snapshot-cleanup-${payload.deploymentId.slice(0, 12)}`,
      projectId: payload.projectId,
      serviceId: payload.serviceId,
      command: `rm -f /agent-data/worker-volume-snapshots/${snapshotName}`,
      mounts: [{ source: environment.dataVolume, target: "/agent-data" }],
    });
  } catch (error) {
    console.warn(`Failed to clean worker volume snapshot ${snapshotName}`, error);
  }
}

/**
 * Moves a snapshot a failed rollout could not restore out of the per-deployment slot, so an
 * operator can recover the volume from it by hand. In the slot, a retry of the same deployment
 * would reuse it as its own restore point (the slot is reused so a retry after an agent restart
 * keeps the snapshot taken before the previous version stopped), and that retry's success would
 * delete it. Kept snapshots are named per attempt and never deleted by the agent.
 *
 * Returns where the snapshot is. If the move fails it stays in the slot, which is still better
 * than deleting it.
 */
async function keepWorkerVolumeSnapshot(
  docker: WorkerRuntimeDocker,
  environment: WorkerRuntimeEnvironment,
  payload: WorkerDeployOnlyPayload,
  snapshotName: string,
  keptAt: number
): Promise<string> {
  const keptName = `kept/${snapshotName.replace(/\.tar\.gz$/, "")}-${keptAt}.tar.gz`;
  try {
    await runWorkerVolumeTask(docker, environment, {
      name: `nouva-worker-snapshot-keep-${payload.deploymentId.slice(0, 12)}`,
      projectId: payload.projectId,
      serviceId: payload.serviceId,
      command: [
        "mkdir -p /agent-data/worker-volume-snapshots/kept",
        `mv /agent-data/worker-volume-snapshots/${snapshotName} /agent-data/worker-volume-snapshots/${keptName}`,
      ].join("\n"),
      mounts: [{ source: environment.dataVolume, target: "/agent-data" }],
    });
    return `worker-volume-snapshots/${keptName}`;
  } catch (error) {
    console.warn(`Failed to move the kept worker volume snapshot ${snapshotName}`, error);
    return `worker-volume-snapshots/${snapshotName}`;
  }
}

/**
 * Hands the service back to the previous version after a stop-first rollout could not finish, and
 * reports what is actually running afterwards.
 *
 * It works from each previous container's current state, not from how its stop ended: a stop that
 * failed part-way has already switched the restart policy off, and may or may not have stopped the
 * process. Every container this rollout tried to stop gets `unless-stopped` back; one that is not
 * running is started again. Two kinds are left alone: one that survived SIGKILL is not a process to
 * build on, and one found already stopped that the control plane does not record as live was never
 * part of the live runtime — starting either could put a second writer on a single-writer volume.
 * A container the rollout never got to is counted if it is running and otherwise not touched. The
 * volume's running consumers are checked before each start, allowing only previous containers
 * already running.
 *
 * Never throws, because it runs while reporting another failure.
 */
async function restorePreviousWorkerRuntime(
  docker: WorkerRuntimeDocker,
  previousContainers: DockerContainerInspection[],
  input: {
    shutdowns: readonly WorkerShutdownReport[];
    isRecordedLive: (container: DockerContainerInspection) => boolean;
    volumeName: string | null;
    clock: WorkerShutdownClock;
  }
): Promise<{ liveRuntimePreserved: boolean; rollbackCompleted: boolean }> {
  const outcomes = new Map(input.shutdowns.map((report) => [report.containerName, report.outcome]));
  const runningNames = new Set<string>();
  let rollbackCompleted = true;
  try {
    const toStart: DockerContainerInspection[] = [];
    for (const container of previousContainers) {
      const outcome = outcomes.get(getContainerName(container));
      if (
        outcome === "hung" ||
        (outcome === "already_stopped" && !input.isRecordedLive(container))
      ) {
        continue;
      }
      const identifier = getContainerIdentifier(container);
      const current = await docker.inspectContainer(identifier);
      if (!current) {
        rollbackCompleted = rollbackCompleted && outcome === undefined;
        continue;
      }
      if (current.State?.Running) {
        if (outcome !== undefined) {
          await docker.updateContainerRestartPolicy(identifier, "unless-stopped");
        }
        runningNames.add(getContainerName(container));
      } else if (outcome !== undefined) {
        toStart.push(container);
      }
    }
    for (const container of toStart) {
      const identifier = getContainerIdentifier(container);
      if (input.volumeName) {
        await assertNoUnexpectedVolumeConsumer(docker, input.volumeName, runningNames);
      }
      await docker.updateContainerRestartPolicy(identifier, "unless-stopped");
      await docker.startContainer(identifier);
      await waitForWorkerReadiness(docker, {
        containerName: getContainerName(container),
        hasHealthcheck: false,
        now: input.clock.now,
        wait: input.clock.wait,
      });
      runningNames.add(getContainerName(container));
    }
  } catch (error) {
    console.warn("Failed to restore the previous worker runtime", error);
    rollbackCompleted = false;
  }
  const liveRuntimePreserved = runningNames.size > 0;
  return { liveRuntimePreserved, rollbackCompleted: rollbackCompleted && liveRuntimePreserved };
}

function describeKeptSnapshot(path: string, dataVolume: string): string {
  return (
    `The volume was not restored; its contents from before this rollout are kept at ${path} ` +
    `in the agent data volume ${dataVolume}. Restore it by hand if the data needs recovering, ` +
    "then delete it."
  );
}

/** Whether any of `containers` is running now. A failed inspection counts as not running. */
async function anyContainerRunning(
  docker: Pick<DockerApiClient, "inspectContainer">,
  containers: readonly DockerContainerInspection[]
): Promise<boolean> {
  for (const container of containers) {
    try {
      const current = await docker.inspectContainer(getContainerIdentifier(container));
      if (current?.State?.Running) {
        return true;
      }
    } catch (error) {
      // Runs while reporting another failure; claiming a live runtime that cannot be confirmed
      // would mark the service running, so an unreadable container is not counted.
      console.warn(`Failed to inspect worker ${getContainerName(container)}`, error);
    }
  }
  return false;
}

/**
 * Recognizes the containers the control plane last recorded as the service's live runtime, by the
 * recorded replica names. The deployment id alone is not enough: a replica a scale-down retired
 * carries the same id, and treating it as live would plan around it and restart it on a rollback.
 * Metadata that records no replica names (written before workers had replicas) falls back to the
 * recorded deployment's containers below the recorded replica count.
 */
function recordedLiveRuntime(
  runtimeMetadata: RuntimeMetadata | null | undefined
): (container: DockerContainerInspection) => boolean {
  const names = new Set(
    [
      ...(runtimeMetadata?.replicas ?? []).map((replica) => replica.containerName),
      runtimeMetadata?.containerName,
    ].filter((name): name is string => typeof name === "string" && name.length > 0)
  );
  if (names.size > 0) {
    return (container) => names.has(getContainerName(container));
  }
  const deploymentId = runtimeMetadata?.currentImage?.deploymentId ?? null;
  const replicaCount = runtimeMetadata?.replicaCount ?? 1;
  return (container) => {
    const labels = container.Config?.Labels;
    const replicaIndex = Number(labels?.["nouva.replica.index"] ?? 0);
    return (
      deploymentId !== null &&
      labels?.["nouva.deployment.id"] === deploymentId &&
      replicaIndex < replicaCount
    );
  };
}

async function assertContainersAbsent(
  docker: Pick<DockerApiClient, "inspectContainer">,
  identifiers: string[]
): Promise<void> {
  for (const identifier of identifiers) {
    if (await docker.inspectContainer(identifier)) {
      throw new Error(`Worker container ${identifier} still exists after it was removed`);
    }
  }
}

async function assertContainersStopped(
  docker: Pick<DockerApiClient, "inspectContainer">,
  containers: DockerContainerInspection[]
): Promise<void> {
  for (const container of containers) {
    const current = await docker.inspectContainer(getContainerIdentifier(container));
    if (current?.State?.Running) {
      throw new Error(`Previous worker ${getContainerName(container)} is still running`);
    }
  }
}

/**
 * Makes `ensureContainer` either adopt a running candidate or create a fresh one, never restart a
 * stopped container with that name. A stopped one was stopped by an earlier rollout step (a failed
 * attempt, or a replica retired before its removal was recorded): it has restart policy `no` and
 * whatever stop settings it was created with, so starting it as-is would leave a worker that never
 * comes back after a crash or reboot. A running one keeps running, but gets `unless-stopped` back
 * in case an interrupted graceful stop had already switched it off.
 */
async function prepareCandidateSlot(
  docker: Pick<
    DockerApiClient,
    "inspectContainer" | "removeContainer" | "updateContainerRestartPolicy"
  >,
  containerName: string
): Promise<void> {
  const existing = await docker.inspectContainer(containerName);
  if (!existing) {
    return;
  }
  const identifier = getContainerIdentifier(existing);
  if (existing.State?.Running) {
    await docker.updateContainerRestartPolicy(identifier, "unless-stopped");
    return;
  }
  await docker.removeContainer(identifier, false);
  await assertContainersAbsent(docker, [identifier]);
}

export interface DeployWorkerRuntimeOptions {
  /** Receives one human-readable line per rollout step, for the deployment's build log. */
  onProgress?: (line: string) => void;
  clock?: WorkerShutdownClock;
}

/**
 * Converges a worker service onto `payload`'s deployment and replica count.
 *
 * The order comes from `planWorkerRollout`. Every process the rollout replaces is stopped with the
 * service's signal and grace period (`stopWorkerContainerGracefully`), never force-removed while
 * running, and each stop is reported in `rollout.shutdowns` so a forced kill is visible afterwards.
 *
 * Stop-first rollouts keep the stopped previous containers until the candidates are ready, so a
 * failed candidate can hand the service back to the version that was running. A previous container
 * that will not stop aborts the rollout before any candidate starts, because starting one then
 * would be exactly the overlap the policy forbids.
 */
export async function deployWorkerRuntime(
  docker: WorkerRuntimeDocker,
  environment: WorkerRuntimeEnvironment,
  payload: WorkerDeployOnlyPayload,
  options: DeployWorkerRuntimeOptions = {}
): Promise<Record<string, unknown>> {
  assertReplicaCount(payload.replicaCount);
  assertVolumeWorkerPayload(payload);
  const clock = options.clock ?? SYSTEM_WORKER_SHUTDOWN_CLOCK;
  const progress = (line: string) => options.onProgress?.(line);
  const policy = resolveWorkerShutdownPolicy(payload);

  const projectNetwork = getWorkerProjectNetwork(payload.projectId);
  await docker.ensureNetwork(projectNetwork, {
    "nouva.managed": "true",
    "nouva.server.id": environment.serverId,
    "nouva.project.id": payload.projectId,
  });
  if (payload.volume) {
    await docker.createVolume(payload.volume.volumeName, {
      "nouva.managed": "true",
      "nouva.server.id": environment.serverId,
      "nouva.volume.id": payload.volume.volumeId,
      "nouva.project.id": payload.projectId,
      "nouva.service.id": payload.serviceId,
    });
  }

  const image =
    payload.replicaCount > 0
      ? await ensureWorkerImage(docker, environment, payload.imageUrl)
      : await docker.inspectImage(payload.imageUrl);
  const candidateSpecs = Array.from({ length: payload.replicaCount }, (_, replicaIndex) =>
    buildWorkerContainerSpec({
      environment,
      payload,
      image,
      replicaIndex,
    })
  );
  const candidateNames = candidateSpecs.map((candidate) => candidate.containerName);
  const listedContainers = await listWorkerServiceContainers(docker, payload.serviceId);
  const candidateNameSet = new Set(candidateNames);
  const isRecordedLive = recordedLiveRuntime(payload.runtimeMetadata);
  // A stopped container outside the candidate slots is a leftover — a retired process whose removal
  // an agent restart interrupted, or one that outlived SIGKILL and exited later — unless the control
  // plane still records it as the live runtime. Then an earlier attempt of this rollout stopped it
  // before being interrupted, and it stays the version to stop before, and restore after, the new
  // one. Any other stopped container is removed rather than planned around or restored.
  const isLive = (container: DockerContainerInspection) =>
    container.State?.Running === true || isRecordedLive(container);
  const leftovers = listedContainers.filter(
    (container) => !isLive(container) && !candidateNameSet.has(getContainerName(container))
  );
  for (const leftover of leftovers) {
    await docker.removeContainer(getContainerIdentifier(leftover), false);
  }
  await assertContainersAbsent(docker, leftovers.map(getContainerIdentifier));
  if (leftovers.length > 0) {
    progress(
      `Removed ${leftovers.length} stopped leftover worker container(s): ` +
        leftovers.map(getContainerName).join(", ")
    );
  }
  const currentContainers = listedContainers.filter((container) => !leftovers.includes(container));
  if (payload.volume) {
    await assertNoUnexpectedVolumeConsumer(
      docker,
      payload.volume.volumeName,
      new Set(currentContainers.map(getContainerName))
    );
  }
  const containersByName = new Map(
    currentContainers.map((container) => [getContainerName(container), container])
  );
  const pick = (names: string[]) =>
    names.flatMap((name) => {
      const container = containersByName.get(name);
      return container ? [container] : [];
    });
  const plan = planWorkerRollout({
    rolloutPolicy: policy.rolloutPolicy,
    hasVolume: Boolean(payload.volume),
    deploymentId: payload.deploymentId,
    candidateNames,
    containers: currentContainers.map((container) => ({
      name: getContainerName(container),
      deploymentId: container.Config?.Labels?.["nouva.deployment.id"] ?? null,
      live: isLive(container),
    })),
  });
  const previousContainers = plan.order === "stop_first" ? pick(plan.stopBeforeStart) : [];
  const retiredContainers = plan.order === "candidate_first" ? pick(plan.retireAfterReady) : [];
  const shutdowns: WorkerShutdownReport[] = [];
  const rolloutResult = (
    fields: Pick<
      WorkerRolloutResult,
      | "outcome"
      | "currentPhase"
      | "liveRuntimePreserved"
      | "rollbackCompleted"
      | "activeContainerNames"
    >
  ): WorkerRolloutResult => ({
    strategy: plan.strategy,
    ...fields,
    candidateContainerNames: candidateNames,
    policy,
    shutdowns: [...shutdowns],
  });
  // A container of this rollout's own deployment that is not a candidate is a replica the new
  // count drops; anything else runs an older deployment.
  const retiredRole = (container: DockerContainerInspection): WorkerShutdownRole =>
    container.Config?.Labels?.["nouva.deployment.id"] === payload.deploymentId
      ? "surplus"
      : "previous";
  // Every container is signalled at once, so a rollout waits one grace period (plus the SIGKILL
  // confirmation) however many replicas it stops. Every container gets a report, in container
  // order: a Docker error part-way through one stop becomes an `unconfirmed` report instead of
  // an exception, so each caller decides what an unknown outcome means at its point in the
  // rollout, and the reports of the other stops are never lost.
  const stopAllGracefully = async (
    containers: DockerContainerInspection[],
    roleOf: (container: DockerContainerInspection) => WorkerShutdownRole
  ): Promise<WorkerShutdownReport[]> => {
    const startedAt = clock.now();
    const settled = await Promise.allSettled(
      containers.map((container) =>
        stopWorkerContainerGracefully(docker, {
          identifier: getContainerIdentifier(container),
          containerName: getContainerName(container),
          role: roleOf(container),
          policy,
          clock,
        })
      )
    );
    const reports = settled.map((result, index): WorkerShutdownReport => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      const container = containers[index] as DockerContainerInspection;
      console.warn(`Failed to stop worker ${getContainerName(container)}`, result.reason);
      return {
        containerName: getContainerName(container),
        role: roleOf(container),
        signal: resolveWorkerStopSignal(policy.signal, container.Config?.StopSignal),
        gracePeriodSeconds: policy.gracePeriodSeconds,
        outcome: "unconfirmed",
        exitCode: null,
        elapsedMs: Math.max(0, clock.now() - startedAt),
      };
    });
    for (const report of reports) {
      shutdowns.push(report);
      progress(describeWorkerShutdownReport(report));
    }
    return reports;
  };
  /** A container the rollout cannot claim has stopped. */
  const mayStillRun = (report: WorkerShutdownReport | undefined) =>
    report?.outcome === "hung" || report?.outcome === "unconfirmed";
  const describeUnstopped = (report: WorkerShutdownReport) =>
    report.outcome === "hung"
      ? "did not stop even after SIGKILL"
      : "could not be confirmed stopped because Docker returned an error";

  /**
   * Stops and removes the candidates of a failed attempt, returning whether none is left running.
   * A candidate that got as far as running may already be processing work, so it gets the same
   * graceful stop as any other retired process. One whose stop failed part-way (a Docker error on
   * the update, the kill or an inspect) is force-removed, and so is every candidate if anything
   * else in the cleanup throws, because the caller still has to restore the previous version and
   * report the result; a cleanup error must not skip either.
   */
  const discardFailedCandidates = async (names: readonly string[]): Promise<boolean> => {
    try {
      const startedCandidates: DockerContainerInspection[] = [];
      for (const name of names) {
        const candidate = await docker.inspectContainer(name);
        if (candidate) {
          startedCandidates.push(candidate);
        }
      }
      const reports = await stopAllGracefully(startedCandidates, () => "candidate");
      let stopped = true;
      for (const [index, candidate] of startedCandidates.entries()) {
        const outcome = reports[index]?.outcome;
        if (outcome === "hung") {
          stopped = false;
          continue;
        }
        await docker.removeContainer(getContainerIdentifier(candidate), outcome === "unconfirmed");
      }
      return stopped;
    } catch (cleanupError) {
      console.warn("Graceful cleanup of the failed worker candidates failed", cleanupError);
      progress("Could not stop the failed candidate(s) gracefully; force-removing them");
    }
    let stopped = true;
    for (const name of names) {
      try {
        const candidate = await docker.inspectContainer(name);
        if (candidate) {
          await docker.removeContainer(getContainerIdentifier(candidate), true);
        }
      } catch (removeError) {
        console.warn(`Failed to force-remove worker candidate ${name}`, removeError);
        stopped = false;
      }
    }
    return stopped;
  };

  const signalLabel = policy.signal ?? "image stop signal";
  progress(
    plan.order === "stop_first"
      ? `Stopping ${previousContainers.length} previous worker container(s) before starting ` +
          `the new version (${plan.reason === "single_writer_volume" ? "single-writer volume" : "no-overlap policy"}; ` +
          `${signalLabel}, ${policy.gracePeriodSeconds}s grace)`
      : `Starting ${candidateNames.length} worker container(s) before retiring ` +
          `${retiredContainers.length} previous one(s) (${signalLabel}, ${policy.gracePeriodSeconds}s grace)`
  );

  let snapshotName: string | null = null;
  if (plan.order === "stop_first") {
    try {
      // A retry can find candidates a prior attempt started before it was interrupted. Nothing
      // proves they never ran beside the previous version, so they are reset before anything else.
      const staleCandidates = pick(plan.resetCandidates);
      const staleReports = await stopAllGracefully(staleCandidates, () => "candidate");
      const unstoppedCandidate = staleReports.find(mayStillRun);
      if (unstoppedCandidate) {
        throw new Error(
          `Worker ${unstoppedCandidate.containerName} from an interrupted rollout ` +
            describeUnstopped(unstoppedCandidate)
        );
      }
      for (const candidate of staleCandidates) {
        await docker.removeContainer(getContainerIdentifier(candidate), false);
      }
      await assertContainersAbsent(docker, staleCandidates.map(getContainerIdentifier));
      if (payload.volume) {
        await assertNoUnexpectedVolumeConsumer(
          docker,
          payload.volume.volumeName,
          new Set(previousContainers.map(getContainerName))
        );
      }
      const previousReports = await stopAllGracefully(previousContainers, retiredRole);
      const unstoppedPrevious = previousReports.find(mayStillRun);
      if (unstoppedPrevious) {
        throw new Error(
          `Previous worker ${unstoppedPrevious.containerName} ${describeUnstopped(unstoppedPrevious)}, ` +
            "so the new version was not started. Stop it on the server, then redeploy."
        );
      }
      await assertContainersStopped(docker, previousContainers);
      if (payload.volume) {
        await assertNoUnexpectedVolumeConsumer(docker, payload.volume.volumeName, new Set());
        snapshotName = await createWorkerVolumeSnapshot(docker, environment, payload);
      }
    } catch (error) {
      const { liveRuntimePreserved } = await restorePreviousWorkerRuntime(
        docker,
        previousContainers,
        {
          shutdowns,
          isRecordedLive,
          volumeName: payload.volume?.volumeName ?? null,
          clock,
        }
      );
      throw new WorkerRolloutError(
        error instanceof Error ? error.message : "Stopping the previous worker failed",
        rolloutResult({
          outcome: "aborted_before_cutover",
          currentPhase: "restore",
          liveRuntimePreserved,
          rollbackCompleted: false,
          activeContainerNames: previousContainers.map(getContainerName),
        })
      );
    }
  }

  const candidateIds = new Map<string, string>();
  try {
    for (const candidate of candidateSpecs) {
      await prepareCandidateSlot(docker, candidate.containerName);
      const id = await docker.ensureContainer(candidate.spec, false, { pull: false });
      candidateIds.set(candidate.containerName, id);
    }
    for (const candidate of candidateSpecs) {
      await waitForWorkerReadiness(docker, {
        containerName: candidate.containerName,
        hasHealthcheck: candidate.hasHealthcheck,
        now: clock.now,
        wait: clock.wait,
      });
    }
    if (candidateSpecs.length > 0) {
      progress(`New worker container(s) ready: ${candidateNames.join(", ")}`);
    }
  } catch (error) {
    const candidatesStopped = await discardFailedCandidates(candidateNames);

    // Only a container running now preserves the service: a recorded-live one that was already
    // stopped when this rollout began is in `retiredContainers` but runs nothing.
    let liveRuntimePreserved =
      plan.order === "candidate_first" && (await anyContainerRunning(docker, retiredContainers));
    let rollbackCompleted = false;
    let keptSnapshot: string | null = null;
    if (plan.order === "stop_first") {
      // The snapshot is the only copy of the volume from before the failed version touched it, so
      // it is deleted only once it has been restored; skipped or failed, it is kept for recovery.
      let volumeRestored = false;
      if (!candidatesStopped) {
        liveRuntimePreserved = false;
      } else {
        try {
          if (snapshotName && payload.volume) {
            await assertNoUnexpectedVolumeConsumer(docker, payload.volume.volumeName, new Set());
            await restoreWorkerVolumeSnapshot(docker, environment, payload, snapshotName);
            volumeRestored = true;
          }
          ({ liveRuntimePreserved, rollbackCompleted } = await restorePreviousWorkerRuntime(
            docker,
            previousContainers,
            {
              shutdowns,
              isRecordedLive,
              volumeName: payload.volume?.volumeName ?? null,
              clock,
            }
          ));
        } catch (restoreError) {
          console.warn("Failed to restore the worker volume snapshot", restoreError);
          liveRuntimePreserved = false;
        }
      }
      if (snapshotName && volumeRestored) {
        await deleteWorkerVolumeSnapshotBestEffort(docker, environment, payload, snapshotName);
      } else if (snapshotName) {
        keptSnapshot = await keepWorkerVolumeSnapshot(
          docker,
          environment,
          payload,
          snapshotName,
          clock.now()
        );
        console.warn(
          `Kept the worker volume snapshot ${keptSnapshot} in ${environment.dataVolume} ` +
            "because it was not restored"
        );
        progress(describeKeptSnapshot(keptSnapshot, environment.dataVolume));
      }
      progress(
        rollbackCompleted
          ? "Restored the previous worker version after the new one failed"
          : "Could not restore the previous worker version; the service has no running worker"
      );
    }
    if (
      environment.imageStoreMode === "docker-local" &&
      !shouldRetainWorkerImage(payload.runtimeMetadata, payload.imageUrl)
    ) {
      try {
        await docker.removeImage(payload.imageUrl, true);
      } catch (imageError) {
        // An image left behind costs disk until the next cleanup; losing the rollout result below
        // would cost the control plane its record of what is running.
        console.warn(`Failed to remove the failed worker image ${payload.imageUrl}`, imageError);
      }
    }
    const failureMessage =
      error instanceof Error ? error.message : "Worker candidate failed readiness checks";
    throw new WorkerRolloutError(
      keptSnapshot
        ? `${failureMessage}. ${describeKeptSnapshot(keptSnapshot, environment.dataVolume)}`
        : failureMessage,
      rolloutResult({
        outcome: "aborted_before_cutover",
        currentPhase: plan.order === "stop_first" ? "restore" : "ready",
        liveRuntimePreserved,
        rollbackCompleted,
        activeContainerNames: [...previousContainers, ...retiredContainers].map(getContainerName),
      })
    );
  }

  // Past this point the new version is live, so retiring the old one is best effort. A retired
  // process that will not stop, or whose stop or removal Docker fails, is reported and left where it
  // is, not treated as a failed rollout: failing now would describe the running candidates as
  // broken and leave the control plane recording the old version as live.
  const removeRetired = async (container: DockerContainerInspection) => {
    try {
      await docker.removeContainer(getContainerIdentifier(container), false);
    } catch (error) {
      console.warn(`Failed to remove retired worker ${getContainerName(container)}`, error);
      progress(`Could not remove retired worker container ${getContainerName(container)}`);
    }
  };
  const retiredReports = await stopAllGracefully(retiredContainers, retiredRole);
  for (const [index, container] of retiredContainers.entries()) {
    if (!mayStillRun(retiredReports[index])) {
      await removeRetired(container);
    }
  }
  for (const container of previousContainers) {
    await removeRetired(container);
  }
  if (snapshotName) {
    await deleteWorkerVolumeSnapshotBestEffort(docker, environment, payload, snapshotName);
  }

  const previousCurrentImage = resolveCurrentRuntimeImage(payload.runtimeMetadata);
  const retainedPreviousImage = resolvePreviousRuntimeImage(payload.runtimeMetadata);
  const nextCurrentImage: RuntimeRetainedImage = image
    ? {
        reference: payload.imageUrl,
        imageId: image.Id,
        deploymentId: payload.deploymentId,
        commitHash: payload.commitHash,
      }
    : (previousCurrentImage ?? {
        reference: payload.imageUrl,
        imageId: null,
        deploymentId: payload.deploymentId,
        commitHash: payload.commitHash,
      });
  const nextPreviousImage = previousCurrentImage ? { ...previousCurrentImage } : null;
  if (
    environment.imageStoreMode === "docker-local" &&
    retainedPreviousImage &&
    !sameRetainedImage(retainedPreviousImage, nextCurrentImage) &&
    !sameRetainedImage(retainedPreviousImage, nextPreviousImage)
  ) {
    const retainedReference = retainedPreviousImage.reference || retainedPreviousImage.imageId;
    if (retainedReference) {
      await docker.removeImage(retainedReference, true);
    }
  }

  const runtimeInstances: WorkerRuntimeInstance[] = candidateSpecs.map(
    (candidate, replicaIndex) => ({
      kind: "worker",
      status: "running",
      replicaIndex,
      name: candidate.containerName,
      image: payload.imageUrl,
      containerId: candidateIds.get(candidate.containerName) ?? candidate.containerName,
      containerName: candidate.containerName,
      networkName: candidate.projectNetwork,
      internalHost: candidate.containerName,
    })
  );
  const imageCommand = candidateSpecs[0]?.imageCommand ?? detectWorkerImageCommand(image);

  return {
    imageUrl: payload.imageUrl,
    runtimeMetadata: {
      image: payload.imageUrl,
      imageStoreMode: environment.imageStoreMode,
      currentImage: nextCurrentImage,
      previousImage: nextPreviousImage,
      ingressHost: null,
      ingressPort: null,
      publishedPort: null,
      internalPort: null,
      containerId: runtimeInstances[0]?.containerId ?? null,
      containerName: runtimeInstances[0]?.containerName ?? null,
      networkName: projectNetwork,
      replicaCount: payload.replicaCount,
      replicas: runtimeInstances.map((instance) => ({
        replicaIndex: instance.replicaIndex,
        containerId: instance.containerId,
        containerName: instance.containerName,
      })),
      detectedEntrypoint: imageCommand?.entrypoint ?? null,
      detectedCommand: imageCommand?.command ?? null,
      detectedCommandDisplay: imageCommand?.display ?? null,
      workerCommand: normalizeWorkerCommand(payload.startCommand),
      workerHealthCheckCommand: normalizeWorkerCommand(payload.healthCheckCommand),
    },
    rollout: rolloutResult({
      outcome: "committed",
      currentPhase: "retire",
      liveRuntimePreserved: false,
      rollbackCompleted: false,
      activeContainerNames: candidateNames,
    }),
    runtimeInstances,
    ...(runtimeInstances[0] ? { runtimeInstance: runtimeInstances[0] } : {}),
  };
}

function getWorkerJobReceiptPath(dataDir: string, scheduleRunId: string): string {
  return path.join(
    dataDir,
    "worker-job-receipts",
    `${Buffer.from(scheduleRunId).toString("base64url")}.json`
  );
}

async function readWorkerJobReceipt(
  environment: Pick<WorkerRuntimeEnvironment, "dataDir">,
  scheduleRunId: string
): Promise<WorkerJobReceipt | null> {
  try {
    const raw = await readFile(getWorkerJobReceiptPath(environment.dataDir, scheduleRunId), "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkerJobReceipt>;
    if (
      parsed.version !== 1 ||
      parsed.scheduleRunId !== scheduleRunId ||
      typeof parsed.projectId !== "string" ||
      typeof parsed.serviceId !== "string" ||
      typeof parsed.deploymentId !== "string" ||
      typeof parsed.scheduleId !== "string" ||
      typeof parsed.occurrenceKey !== "string" ||
      typeof parsed.jobName !== "string" ||
      typeof parsed.imageUrl !== "string" ||
      typeof parsed.containerId !== "string" ||
      typeof parsed.containerName !== "string" ||
      typeof parsed.status !== "string"
    ) {
      throw new Error(`Worker job receipt for ${scheduleRunId} is invalid`);
    }
    return parsed as WorkerJobReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeWorkerJobReceipt(
  environment: Pick<WorkerRuntimeEnvironment, "dataDir">,
  receipt: WorkerJobReceipt
): Promise<void> {
  const receiptPath = getWorkerJobReceiptPath(environment.dataDir, receipt.scheduleRunId);
  await mkdir(path.dirname(receiptPath), { recursive: true });
  const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(receipt)}\n`, "utf8");
  await rename(temporaryPath, receiptPath);
}

function isWorkerJobTerminal(receipt: WorkerJobReceipt): boolean {
  return ["succeeded", "failed", "cancelled", "missing"].includes(receipt.status);
}

function readWorkerJobReceiptTimestamp(value: string | undefined): string | null {
  if (!value || value.startsWith("0001-")) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function readRequiredWorkerJobLabel(
  labels: Record<string, string> | undefined,
  key: string
): string | null {
  const value = labels?.[key]?.trim();
  return value ? value : null;
}

function recoverWorkerJobReceiptFromContainer(input: {
  container: DockerContainerInspection;
  serviceId: string;
  scheduleRunId: string;
  expected?: {
    projectId?: string;
    deploymentId?: string;
    scheduleId?: string;
    occurrenceKey?: string;
  };
}): WorkerJobReceipt | null {
  const labels = input.container.Config?.Labels;
  const containerName = getContainerName(input.container);
  if (
    labels?.["nouva.managed"] !== "true" ||
    labels["nouva.kind"] !== "worker_job" ||
    labels["nouva.service.type"] !== "worker" ||
    labels["nouva.service.id"] !== input.serviceId ||
    labels["nouva.schedule.run.id"] !== input.scheduleRunId ||
    containerName !== buildWorkerJobContainerName(input.serviceId, input.scheduleRunId)
  ) {
    return null;
  }

  if (
    (input.expected?.projectId && labels["nouva.project.id"] !== input.expected.projectId) ||
    (input.expected?.deploymentId &&
      labels["nouva.deployment.id"] !== input.expected.deploymentId) ||
    (input.expected?.scheduleId && labels["nouva.schedule.id"] !== input.expected.scheduleId) ||
    (input.expected?.occurrenceKey &&
      labels["nouva.schedule.occurrence.key"] !== input.expected.occurrenceKey)
  ) {
    return null;
  }

  const projectId = readRequiredWorkerJobLabel(labels, "nouva.project.id");
  const deploymentId = readRequiredWorkerJobLabel(labels, "nouva.deployment.id");
  const scheduleId = readRequiredWorkerJobLabel(labels, "nouva.schedule.id");
  const occurrenceKey = readRequiredWorkerJobLabel(labels, "nouva.schedule.occurrence.key");
  const imageUrl = input.container.Config?.Image?.trim() || null;
  const containerId = input.container.Id?.trim() || null;
  if (!projectId || !deploymentId || !scheduleId || !occurrenceKey || !imageUrl || !containerId) {
    return null;
  }

  const createdAt =
    readWorkerJobReceiptTimestamp(input.container.State?.StartedAt) ?? new Date().toISOString();
  const receipt: WorkerJobReceipt = {
    version: 1,
    projectId,
    serviceId: input.serviceId,
    deploymentId,
    scheduleRunId: input.scheduleRunId,
    scheduleId,
    occurrenceKey,
    jobName: containerName,
    imageUrl,
    containerId,
    containerName,
    status: "created",
    exitCode: null,
    createdAt,
    completedAt: null,
  };
  if (input.container.State?.Running) {
    return { ...receipt, status: "running" };
  }
  if (input.container.State?.Status?.toLowerCase() === "created") {
    return receipt;
  }

  const exitCode = input.container.State?.ExitCode ?? 1;
  return {
    ...receipt,
    status: exitCode === 0 ? "succeeded" : "failed",
    exitCode,
    completedAt:
      readWorkerJobReceiptTimestamp(input.container.State?.FinishedAt) ?? new Date().toISOString(),
  };
}

async function recoverMissingWorkerJobReceipt(
  docker: Pick<DockerApiClient, "inspectContainer">,
  environment: Pick<WorkerRuntimeEnvironment, "dataDir">,
  input: {
    serviceId: string;
    scheduleRunId: string;
    expected?: {
      projectId?: string;
      deploymentId?: string;
      scheduleId?: string;
      occurrenceKey?: string;
    };
  }
): Promise<WorkerJobReceipt | null> {
  const containerName = buildWorkerJobContainerName(input.serviceId, input.scheduleRunId);
  const container = await docker.inspectContainer(containerName);
  if (!container) {
    return null;
  }

  const receipt = recoverWorkerJobReceiptFromContainer({
    ...input,
    container,
  });
  if (!receipt) {
    throw new Error(
      `Worker job container ${containerName} exists but does not match the scheduled run receipt`
    );
  }
  await writeWorkerJobReceipt(environment, receipt);
  return receipt;
}

function buildWorkerJobRuntimeInstance(input: {
  receipt: WorkerJobReceipt;
  status: WorkerJobReceipt["status"];
}): Record<string, unknown> {
  return {
    kind: "worker_job",
    status: input.status,
    projectId: input.receipt.projectId,
    serviceId: input.receipt.serviceId,
    deploymentId: input.receipt.deploymentId,
    scheduleId: input.receipt.scheduleId,
    scheduleRunId: input.receipt.scheduleRunId,
    workerScheduleRunId: input.receipt.scheduleRunId,
    occurrenceKey: input.receipt.occurrenceKey,
    replicaIndex: null,
    name: input.receipt.containerName,
    image: input.receipt.imageUrl,
    containerId: input.receipt.containerId,
    containerName: input.receipt.containerName,
    networkName: getWorkerProjectNetwork(input.receipt.projectId),
    exitCode: input.receipt.exitCode,
    startedAt: input.receipt.createdAt,
    completedAt: input.receipt.completedAt,
  };
}

function toTerminalWorkerJobReceipt(
  receipt: WorkerJobReceipt,
  inspection: DockerContainerInspection | null,
  fallbackStatus: "cancelled" | "missing" = "missing"
): WorkerJobReceipt {
  if (!inspection) {
    return {
      ...receipt,
      status: fallbackStatus,
      completedAt: receipt.completedAt ?? new Date().toISOString(),
    };
  }
  const exitCode = inspection.State?.ExitCode ?? 1;
  return {
    ...receipt,
    status: exitCode === 0 ? "succeeded" : "failed",
    exitCode,
    completedAt: receipt.completedAt ?? new Date().toISOString(),
  };
}

async function assertWorkerJobVolumeAvailable(
  docker: Pick<DockerApiClient, "listContainersUsingVolume">,
  volume: AppVolumeIdentity | null | undefined
): Promise<void> {
  if (!volume) {
    return;
  }
  const consumers = await docker.listContainersUsingVolume(volume.volumeName);
  if (consumers.some((container) => container.State?.Running)) {
    throw new Error(`Volume ${volume.volumeName} already has a running consumer`);
  }
}

export async function startWorkerJob(
  docker: WorkerRuntimeDocker,
  environment: WorkerRuntimeEnvironment,
  payload: WorkerJobPayload
): Promise<Record<string, unknown>> {
  const command = normalizeWorkerCommand(payload.command);
  if (!command) {
    throw new Error("Scheduled worker jobs require an explicit command");
  }
  assertWorkerJobTimeout(payload.timeoutSeconds);

  let existingReceipt = await readWorkerJobReceipt(environment, payload.scheduleRunId);
  if (!existingReceipt) {
    existingReceipt = await recoverMissingWorkerJobReceipt(docker, environment, {
      serviceId: payload.serviceId,
      scheduleRunId: payload.scheduleRunId,
      expected: {
        projectId: payload.projectId,
        deploymentId: payload.deploymentId,
        scheduleId: payload.scheduleId,
        occurrenceKey: payload.occurrenceKey,
      },
    });
  }
  if (existingReceipt) {
    if (isWorkerJobTerminal(existingReceipt)) {
      return {
        job: buildWorkerJobRuntimeInstance({
          receipt: existingReceipt,
          status: existingReceipt.status,
        }),
        runtimeInstances: [
          buildWorkerJobRuntimeInstance({
            receipt: existingReceipt,
            status: existingReceipt.status,
          }),
        ],
        containerReceipt: existingReceipt,
      };
    }
    const existingContainer = await docker.inspectContainer(existingReceipt.containerId);
    if (existingContainer?.State?.Running) {
      return {
        job: buildWorkerJobRuntimeInstance({
          receipt: { ...existingReceipt, status: "running" },
          status: "running",
        }),
        containerReceipt: existingReceipt,
      };
    }
    if (existingReceipt.status === "created" && existingContainer?.State?.Status === "created") {
      await docker.startContainer(existingReceipt.containerId);
      const runningReceipt = { ...existingReceipt, status: "running" as const };
      await writeWorkerJobReceipt(environment, runningReceipt);
      return {
        job: buildWorkerJobRuntimeInstance({
          receipt: runningReceipt,
          status: "running",
        }),
        containerReceipt: runningReceipt,
      };
    }
    if (existingContainer) {
      const terminalReceipt = toTerminalWorkerJobReceipt(existingReceipt, existingContainer);
      await writeWorkerJobReceipt(environment, terminalReceipt);
      return {
        job: buildWorkerJobRuntimeInstance({
          receipt: terminalReceipt,
          status: terminalReceipt.status,
        }),
        containerReceipt: terminalReceipt,
      };
    }
    const missingReceipt = toTerminalWorkerJobReceipt(existingReceipt, null);
    await writeWorkerJobReceipt(environment, missingReceipt);
    return {
      job: buildWorkerJobRuntimeInstance({
        receipt: missingReceipt,
        status: missingReceipt.status,
      }),
      containerReceipt: missingReceipt,
    };
  }

  await assertWorkerJobVolumeAvailable(docker, payload.volume);
  const projectNetwork = getWorkerProjectNetwork(payload.projectId);
  await docker.ensureNetwork(projectNetwork, {
    "nouva.managed": "true",
    "nouva.server.id": environment.serverId,
    "nouva.project.id": payload.projectId,
  });
  await ensureWorkerImage(docker, environment, payload.imageUrl);
  const containerName = buildWorkerJobContainerName(payload.serviceId, payload.scheduleRunId);
  if (await docker.inspectContainer(containerName)) {
    throw new Error(
      `Worker job container ${containerName} exists but its receipt could not be recovered. ` +
        "Refusing to run the command again."
    );
  }
  const containerId = await docker.createContainer({
    name: containerName,
    image: payload.imageUrl,
    env: Object.entries(payload.envVars).map(([key, value]) => `${key}=${value}`),
    entrypoint: ["/bin/sh", "-lc"],
    cmd: [command],
    labels: buildWorkerLabels({
      serverId: environment.serverId,
      kind: "worker_job",
      projectId: payload.projectId,
      environmentId: payload.environmentId ?? null,
      serviceId: payload.serviceId,
      deploymentId: payload.deploymentId,
      scheduleId: payload.scheduleId,
      scheduleRunId: payload.scheduleRunId,
      occurrenceKey: payload.occurrenceKey,
      redactionContextVersion: payload.redactionContextVersion,
    }),
    hostConfig: {
      ...(payload.volume
        ? {
            Mounts: [
              {
                Type: "volume",
                Source: payload.volume.volumeName,
                Target: payload.volume.mountPath,
              },
            ],
          }
        : {}),
      RestartPolicy: { Name: "no" },
      ...toDockerResourceSettings(payload.resourceLimits),
    },
    networkingConfig: {
      EndpointsConfig: {
        [projectNetwork]: {},
      },
    },
  });
  const receipt: WorkerJobReceipt = {
    version: 1,
    projectId: payload.projectId,
    serviceId: payload.serviceId,
    deploymentId: payload.deploymentId,
    scheduleRunId: payload.scheduleRunId,
    scheduleId: payload.scheduleId,
    occurrenceKey: payload.occurrenceKey,
    jobName: payload.jobName,
    imageUrl: payload.imageUrl,
    containerId,
    containerName,
    status: "created",
    exitCode: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  await writeWorkerJobReceipt(environment, receipt);
  await docker.startContainer(containerId);
  const runningReceipt = { ...receipt, status: "running" as const };
  await writeWorkerJobReceipt(environment, runningReceipt);
  const job = buildWorkerJobRuntimeInstance({
    receipt: runningReceipt,
    status: "running",
  });
  return {
    job,
    runtimeInstances: [job],
    containerReceipt: runningReceipt,
    timeoutSeconds: payload.timeoutSeconds,
  };
}

export async function inspectWorkerJob(
  docker: Pick<DockerApiClient, "inspectContainer">,
  environment: Pick<WorkerRuntimeEnvironment, "dataDir">,
  payload: Pick<WorkerJobLifecyclePayload, "scheduleRunId">
): Promise<Record<string, unknown>> {
  const receipt = await readWorkerJobReceipt(environment, payload.scheduleRunId);
  if (!receipt) {
    throw new Error(`Worker job receipt ${payload.scheduleRunId} was not found`);
  }
  if (isWorkerJobTerminal(receipt)) {
    return {
      job: buildWorkerJobRuntimeInstance({
        receipt,
        status: receipt.status,
      }),
      containerReceipt: receipt,
    };
  }
  const inspection = await docker.inspectContainer(receipt.containerId);
  if (inspection?.State?.Running) {
    return {
      job: buildWorkerJobRuntimeInstance({
        receipt: { ...receipt, status: "running" },
        status: "running",
      }),
      containerReceipt: receipt,
    };
  }
  const terminalReceipt = toTerminalWorkerJobReceipt(receipt, inspection);
  await writeWorkerJobReceipt(environment, terminalReceipt);
  return {
    job: buildWorkerJobRuntimeInstance({
      receipt: terminalReceipt,
      status: terminalReceipt.status,
    }),
    containerReceipt: terminalReceipt,
  };
}

export async function stopWorkerJob(
  docker: Pick<DockerApiClient, "inspectContainer" | "stopContainer">,
  environment: Pick<WorkerRuntimeEnvironment, "dataDir">,
  payload: Pick<WorkerJobLifecyclePayload, "scheduleRunId">
): Promise<Record<string, unknown>> {
  const receipt = await readWorkerJobReceipt(environment, payload.scheduleRunId);
  if (!receipt) {
    throw new Error(`Worker job receipt ${payload.scheduleRunId} was not found`);
  }
  if (isWorkerJobTerminal(receipt)) {
    return {
      job: buildWorkerJobRuntimeInstance({
        receipt,
        status: receipt.status,
      }),
      containerReceipt: receipt,
    };
  }
  await docker.stopContainer(receipt.containerId);
  const inspection = await docker.inspectContainer(receipt.containerId);
  const stoppedReceipt: WorkerJobReceipt = {
    ...receipt,
    status: "cancelled",
    exitCode: inspection?.State?.ExitCode ?? receipt.exitCode,
    completedAt: new Date().toISOString(),
  };
  await writeWorkerJobReceipt(environment, stoppedReceipt);
  return {
    job: buildWorkerJobRuntimeInstance({
      receipt: stoppedReceipt,
      status: stoppedReceipt.status,
    }),
    containerReceipt: stoppedReceipt,
  };
}

export async function cleanupWorkerJob(
  docker: Pick<DockerApiClient, "inspectContainer" | "removeContainer">,
  environment: Pick<WorkerRuntimeEnvironment, "dataDir">,
  payload: Pick<WorkerJobLifecyclePayload, "serviceId" | "scheduleRunId">
): Promise<Record<string, unknown>> {
  let receipt = await readWorkerJobReceipt(environment, payload.scheduleRunId);
  if (!receipt) {
    receipt = await recoverMissingWorkerJobReceipt(docker, environment, {
      serviceId: payload.serviceId,
      scheduleRunId: payload.scheduleRunId,
    });
  }
  if (!receipt) {
    return {
      cleanupProof: {
        version: 1,
        kind: "cleanup_worker_job",
        container: {
          identifier: buildWorkerJobContainerName(payload.serviceId, payload.scheduleRunId),
          absent: true,
        },
      },
    };
  }
  const inspection = await docker.inspectContainer(receipt.containerId);
  if (inspection?.State?.Running) {
    throw new Error(
      `Worker job ${payload.scheduleRunId} is still running and cannot be cleaned up`
    );
  }
  await docker.removeContainer(receipt.containerId, true);
  if (await docker.inspectContainer(receipt.containerId)) {
    throw new Error(`Worker job container ${receipt.containerName} still exists after cleanup`);
  }
  await rm(getWorkerJobReceiptPath(environment.dataDir, payload.scheduleRunId), { force: true });
  return {
    containerReceipt: receipt,
    cleanupProof: {
      version: 1,
      kind: "cleanup_worker_job",
      container: { identifier: receipt.containerId, absent: true },
    },
  };
}

export async function removeWorkerServiceRuntime(
  docker: Pick<
    DockerApiClient,
    "inspectContainer" | "listContainersByLabels" | "removeContainer" | "removeImage"
  >,
  input: {
    serviceId: string;
    runtimeMetadata?: RuntimeMetadata | null;
  }
): Promise<Record<string, unknown>> {
  const containers = await removeManagedServiceContainers(docker, input.serviceId);
  const identifiers = containers.map(getContainerIdentifier);

  const retainedImages =
    input.runtimeMetadata?.imageStoreMode === "docker-local"
      ? getRetainedImageReferences(input.runtimeMetadata)
      : [];
  for (const reference of retainedImages) {
    await docker.removeImage(reference, true);
  }

  return {
    runtimeInstances: containers.map((container) => {
      const kind = container.Config?.Labels?.["nouva.kind"];
      const replicaIndex = Number(container.Config?.Labels?.["nouva.replica.index"]);
      return {
        kind: kind === "worker_job" ? "worker_job" : "worker",
        status: "removed",
        replicaIndex: Number.isInteger(replicaIndex) ? replicaIndex : null,
        workerScheduleRunId:
          kind === "worker_job"
            ? (container.Config?.Labels?.["nouva.schedule.run.id"] ?? null)
            : null,
        containerId: container.Id,
        containerName: getContainerName(container),
      };
    }),
    cleanupProof: {
      version: 1,
      kind: "delete_worker",
      serviceContainers: { serviceId: input.serviceId, remainingContainerIds: [] },
      containers: identifiers.map((identifier) => ({ identifier, absent: true })),
      retainedImages: retainedImages.map((reference) => ({ reference, absent: true })),
    },
  };
}

function mountsVolume(container: DockerContainerInspection): boolean {
  return (container.HostConfig?.Mounts ?? []).some((mount) => mount.Type === "volume");
}

/**
 * Restarts the replicas the control plane records as the live runtime. A committed rollout can
 * leave an older version's container behind (its removal failed, or it outlived SIGKILL), and
 * restarting that too would run two versions side by side. A stopped leftover is removed first, as
 * a deploy would; one still running is left alone and not reported as part of the runtime.
 *
 * A graceful stop sets a container's restart policy to "no", and a failed rollout can leave the
 * recorded replicas stopped that way, so each is set back to "unless-stopped" before it restarts.
 */
export async function restartWorkerServiceRuntime(
  docker: Pick<
    DockerApiClient,
    | "listContainersByLabels"
    | "restartContainer"
    | "removeContainer"
    | "inspectContainer"
    | "updateContainerRestartPolicy"
  >,
  input: {
    serviceId: string;
    runtimeMetadata: RuntimeMetadata | null | undefined;
    shutdownPolicy?: unknown;
  }
): Promise<Record<string, unknown>> {
  const containers = await listWorkerServiceContainers(docker, input.serviceId);
  const isRecordedLive = recordedLiveRuntime(input.runtimeMetadata);
  const liveContainers = containers.filter(isRecordedLive);
  const leftovers = containers.filter(
    (container) => !isRecordedLive(container) && container.State?.Running !== true
  );
  const runningOthers = containers.filter(
    (container) => !isRecordedLive(container) && container.State?.Running === true
  );
  for (const leftover of leftovers) {
    await docker.removeContainer(getContainerIdentifier(leftover), false);
  }
  await assertContainersAbsent(docker, leftovers.map(getContainerIdentifier));
  if (liveContainers.length === 0) {
    if (runningOthers.length > 0) {
      // The recorded replicas are gone while others run: a rollout that committed after this
      // restart was queued replaced them. Restarting what it left is not what was asked for.
      return { superseded: true };
    }
    throw new Error(`Worker ${input.serviceId} has no live runtime containers to restart`);
  }
  const policy = parseWorkerShutdownPolicy(input.shutdownPolicy) ?? DEFAULT_WORKER_SHUTDOWN_POLICY;
  if (
    runningOthers.length > 0 &&
    (policy.rolloutPolicy === "no_overlap" || containers.some(mountsVolume))
  ) {
    throw new Error(
      `Worker ${input.serviceId} still runs ${runningOthers.map(getContainerName).join(", ")} ` +
        "outside its live runtime, and restarting now would run it alongside the live replicas, " +
        "which a no_overlap policy or a volume forbids. Stop that container or redeploy first."
    );
  }
  for (const container of liveContainers) {
    await docker.updateContainerRestartPolicy(getContainerIdentifier(container), "unless-stopped");
    await docker.restartContainer(getContainerIdentifier(container));
  }
  return {
    runtimeInstances: liveContainers.map((container) => {
      const replicaIndex = Number(container.Config?.Labels?.["nouva.replica.index"]);
      return {
        kind: "worker",
        status: "running",
        replicaIndex: Number.isInteger(replicaIndex) ? replicaIndex : null,
        containerId: container.Id,
        containerName: getContainerName(container),
      };
    }),
  };
}
