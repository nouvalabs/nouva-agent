import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, readlink, rename, statfs, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AGENT_VOLUME_METRICS_INTERVAL_MS } from "@repo/runtime/agent-metrics";
import {
  EXTERNAL_BACKUP_IMPORT_HEADER_SAMPLE_BYTES,
  type ExternalBackupImportFailureCategory,
  type ExternalBackupImportProofV1,
  type ImportExternalBackupPayload,
  verifyExternalBackupArtifact,
} from "@repo/runtime/external-backup-import";
import { collectAgentWorkPayloadOperationalValues } from "@repo/runtime/logging";
import {
  decideVerificationConsequence,
  type ReleaseJobClaimRequest,
  type ReleaseJobClaimResponse,
  type ReleaseJobOutcome,
} from "@repo/runtime/release-phases";
import { calculateBuildReserve } from "@repo/runtime/server-capacity";
import { sanitizeWorkerRolloutShutdownFields } from "@repo/runtime/worker-shutdown";
import agentPackageJson from "../package.json" with { type: "json" };
import { sendAgentHeartbeat } from "./agent-heartbeat.js";
import {
  type AgentTerminalReport,
  ApiRequestError,
  executeAndReportAgentWork,
} from "./agent-work-reporting.js";
import {
  type AlloyRuntimeInput,
  buildUnavailableAlloyChecks,
  collectAlloyValidationChecks,
  ensureAlloyRuntime,
  getAlloyRuntimePaths,
  redactionContextScopeVersionsEqual,
} from "./alloy-runtime.js";
import {
  type AppBuildkitRuntime,
  buildAndDeployAppWithDependencies,
  type DeployAppImageInput,
} from "./app-build-runtime.js";
import {
  assessCandidateReadiness,
  NO_CANDIDATE_RUNTIME_EVIDENCE,
} from "./app-candidate-readiness.js";
import { buildApp, hashProjectNetwork } from "./build.js";
import {
  type BuildLogEmitter,
  type BuildLogPublisher,
  createBuildLogPublisher,
} from "./build-logs.js";
import { detectHostClockSync, evaluateClockSync } from "./clock-sync.js";
import { collectManagedContainerLogConfigValidationCheck } from "./container-log-reconciliation.js";
import {
  buildDatabaseReadinessProbe,
  collectDatabaseRuntimeHealthReport,
  type DatabaseReadinessProbeCommand,
  readDatabaseProbeCredentials,
  readDatabaseProbeCredentialsFromRuntime,
  resolveDatabaseInternalPort,
  waitForDatabaseReadiness,
} from "./database-readiness.js";
import {
  DockerApiClient,
  type DockerContainerInspection,
  type DockerContainerSpec,
  REDACTION_CONTEXT_VERSION_DOCKER_LABEL,
  type RegistryAuth,
} from "./docker-api.js";
import {
  assertAppliedDockerResourceSettings,
  type DockerResourceSettings,
  toDockerResourceSettings,
} from "./docker-resource-limits.js";
import { ensureHostKernelSettings, HOST_INOTIFY_MAX_USER_WATCHES } from "./host-tuning.js";
import { collectPostgresObservabilitySamples } from "./postgres-observability.js";
import {
  type AgentBuildLogsRequest,
  type AgentBuildLogsResponse,
  type AgentCapabilities,
  type AgentCleanupProof,
  type AgentDatabaseRuntimeHealthReport,
  type AgentImageStoreMode,
  type AgentLeaseRenewRequest,
  type AgentLeaseRenewResponse,
  type AgentLeaseResponse,
  type AgentMetricsEnvelope,
  type AgentMetricsRequest,
  type AgentPostgresObservabilityRequest,
  type AgentPostgresObservabilityResponse,
  type AgentRegistrationResponse,
  type AgentRuntimeConfig,
  type AgentWorkRecord,
  type AppDeployPayload,
  type AppRolloutConfig,
  type AppRolloutResult,
  type CreateVolumeBackupPayload,
  type DatabaseProvisionPayload,
  DEFAULT_AGENT_LEASE_TTL_SECONDS,
  type DeleteProjectPayload,
  type DeleteVolumeBackupPayload,
  type DeleteVolumePayload,
  type DeployOnlyPayload,
  type EffectiveServiceResourceLimits,
  type ExpireVolumeBackupRepositoryPayload,
  getAgentRuntimeConfig,
  MAX_PARALLEL_AGENT_WORK_ITEMS,
  parseHostMetricsSnapshot,
  type ReconcileServiceResourcesPayload,
  type RemoveServicePayload,
  type RestartServicePayload,
  type RestorePostgresPitrPayload,
  type RestoreVolumeBackupPayload,
  type RuntimeMetadata,
  type RuntimeRetainedImage,
  resolveAgentCapabilities,
  resolveAppRolloutConfig,
  type ServerValidationReport,
  type SyncRoutingPayload,
  type WorkerDeployOnlyPayload,
  type WorkerDeployPayload,
  type WorkerJobLifecyclePayload,
  type WorkerJobPayload,
} from "./protocol.js";
import {
  createReleasePhaseRunner,
  type ReleaseJobControlPlane,
  ReleaseJobDeferredError,
  ReleaseJobHaltError,
  type ReleaseJobTarget,
  type ReleasePhaseRequest,
  type ReleasePhaseResult,
  type ReleasePhaseRunner,
} from "./release-jobs.js";
import {
  createBuildLogRedactor,
  type EnvironmentVariableMap,
  redactSensitiveText,
  sanitizeSensitiveProtocolValue,
  sanitizeSensitiveValue,
} from "./security.js";
import { createSerializedTaskRunner } from "./serialized-task.js";
import { removeManagedServiceContainers } from "./service-container-cleanup.js";
import { resolveDatabaseProvisionSpec } from "./service-runtime.js";
import {
  calculateDiskSafetyReserveBytes,
  formatStorageBytes,
  resolveDockerRootHostPath,
} from "./storage-metrics.js";
import {
  buildTraefikRuntimePaths,
  buildUnavailableTraefikChecks,
  collectTraefikValidationChecks,
  DEFAULT_TRAEFIK_IMAGE,
  deleteLocalTraefikRoute,
  ensureTraefikRuntime,
  type TraefikRuntimeInput,
  writeLocalTraefikRoute,
} from "./traefik-runtime.js";
import { resolveUpdateAgentImageRef, toUpdateAgentPayload } from "./update-agent.js";
import { createVolumeMetricsCollector } from "./volume-metrics-loop.js";
import {
  hasReplacedVolumeForGeneration,
  readVolumeWipeReceipt,
  writeVolumeWipeReceipt,
} from "./volume-wipe-receipt.js";
import { createBoundedWorkScheduler } from "./work-scheduler.js";
import {
  cleanupWorkerJob,
  deployWorkerRuntime,
  inspectWorkerJob,
  removeWorkerServiceRuntime,
  restartWorkerServiceRuntime,
  startWorkerJob,
  stopWorkerJob,
  WorkerRolloutError,
} from "./worker-runtime.js";

export { ApiRequestError } from "./agent-work-reporting.js";

const execFile = promisify(execFileCallback);

const API_URL = process.env.NOUVA_API_URL;
const SERVER_ID = process.env.NOUVA_SERVER_ID;
const REGISTRATION_TOKEN = process.env.NOUVA_REGISTRATION_TOKEN;
const DATA_DIR = "/var/lib/nouva-agent";
const CREDENTIALS_PATH = path.join(DATA_DIR, "credentials.json");
const APP_DOMAIN = process.env.NOUVA_APP_DOMAIN || "up.nouva.cloud";
const DATA_VOLUME = process.env.NOUVA_AGENT_DATA_VOLUME || "nouva-agent-data";
const BUILDKIT_CONTAINER_NAME = process.env.NOUVA_AGENT_BUILDKIT_CONTAINER || "nouva-buildkitd";
const BUILDKIT_IMAGE = "moby/buildkit:v0.17.0";
const GIT_BIN = process.env.GIT_PATH || "git";
const RAILPACK_BIN = process.env.RAILPACK_PATH || "railpack";
const BUILDCTL_BIN = process.env.BUILDCTL_PATH || "buildctl";
const LOCAL_REGISTRY_CONTAINER_NAME =
  process.env.NOUVA_AGENT_REGISTRY_CONTAINER || "nouva-registry";
const TRAEFIK_CONTAINER_NAME = process.env.NOUVA_AGENT_TRAEFIK_CONTAINER || "nouva-traefik";
const TRAEFIK_IMAGE = process.env.NOUVA_AGENT_TRAEFIK_IMAGE || DEFAULT_TRAEFIK_IMAGE;
const TRAEFIK_PATHS = buildTraefikRuntimePaths(DATA_DIR);
const traefikRuntimeTasks = createSerializedTaskRunner();
const ALLOY_PATHS = getAlloyRuntimePaths(DATA_DIR);
// Each build allocates its own loopback port for its own daemon, so there is no fixed BuildKit
// address any more; this is only the fallback when a scoped address cannot be parsed.
const DEFAULT_BUILDKIT_PORT = 1234;
/**
 * Every build gets its own BuildKit daemon so it can carry the service's resource limits, but its
 * state directory is a named per-service volume rather than the anonymous one the image declares,
 * so the layer cache survives between deployments (#184). Without it a language runtime mise has no
 * prebuilt binary for — CRuby, Erlang — is recompiled from source on every single push.
 */
const BUILDKIT_CACHE_VOLUME_PREFIX = "nouva-buildkit-cache-";
const BUILDKIT_STATE_PATH = "/var/lib/buildkit";
/**
 * `Reserved,Free,Maximum` in MB. BuildKit's own defaults (2000,8000,30000) assume a build host, not
 * a customer's single small server, so cap the cache at 8 GB and keep 4 GB of the disk free.
 */
const BUILDKIT_GC_KEEP_STORAGE =
  process.env.NOUVA_AGENT_BUILDKIT_GC_KEEP_STORAGE || "1000,4000,8000";
const DEFAULT_AGENT_CONTAINER_NAME = "nouva-agent";
const DEFAULT_AGENT_IMAGE = "ghcr.io/nouvacloud/nouva-agent:latest";
const APP_VOLUME_SNAPSHOT_IMAGE = "alpine:3.21";

function ensureTraefikRuntimeSerialized(
  docker: DockerApiClient,
  input: TraefikRuntimeInput
): Promise<void> {
  return traefikRuntimeTasks.run(() => ensureTraefikRuntime(docker, input));
}
export function resolveReportedAgentVersion(packageVersion: string): string {
  const trimmedPackageVersion = packageVersion.trim();
  if (!trimmedPackageVersion) {
    throw new Error("Agent package version is required");
  }

  return trimmedPackageVersion.startsWith("v")
    ? trimmedPackageVersion
    : `v${trimmedPackageVersion}`;
}

export async function resolveAgentTaskImage(
  docker: Pick<DockerApiClient, "inspectContainer">,
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  const configuredImage = env.NOUVA_AGENT_IMAGE?.trim() || env.NOUVA_AGENT_TARGET_IMAGE?.trim();
  if (configuredImage?.length) {
    return configuredImage;
  }

  const candidates = [
    env.HOSTNAME?.trim(),
    env.NOUVA_AGENT_CONTAINER_NAME?.trim(),
    DEFAULT_AGENT_CONTAINER_NAME,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of new Set(candidates)) {
    const inspection = await docker.inspectContainer(candidate);
    const inspectedImage = inspection?.Config?.Image?.trim();
    if (inspectedImage) {
      return inspectedImage;
    }
  }

  return DEFAULT_AGENT_IMAGE;
}

function getInheritedNouvaEnvKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter(
      (key) =>
        key.startsWith("NOUVA_") &&
        key !== "NOUVA_AGENT_VERSION" &&
        key !== "NOUVA_AGENT_IMAGE" &&
        key !== "NOUVA_AGENT_TARGET_IMAGE"
    )
    .sort();
}

export function buildUpdateAgentRuntimeEnv(
  env: Record<string, string | undefined>,
  imageRef: string
): {
  updaterEnv: string[];
  envInheritFlags: string;
} {
  const inheritedNouvaEnvKeys = getInheritedNouvaEnvKeys(env);
  const updaterEnv = [
    ...inheritedNouvaEnvKeys.map((key) => `${key}=${env[key] ?? ""}`),
    `NOUVA_AGENT_IMAGE=${imageRef}`,
    `NOUVA_AGENT_TARGET_IMAGE=${imageRef}`,
  ];
  const envInheritFlags = [
    ...inheritedNouvaEnvKeys,
    "NOUVA_AGENT_IMAGE",
    "NOUVA_AGENT_TARGET_IMAGE",
  ]
    .map((key) => `-e ${key}`)
    .join(" ");

  return {
    updaterEnv,
    envInheritFlags,
  };
}

const AGENT_VERSION = resolveReportedAgentVersion(agentPackageJson.version);

function assertAgentBootstrapEnv(): void {
  if (!API_URL || !SERVER_ID) {
    throw new Error("Missing NOUVA_API_URL or NOUVA_SERVER_ID");
  }
}

export interface StoredCredentials {
  serverId: string;
  agentToken: string;
}

/**
 * Applies re-registered credentials to the live credentials object in place. `main()` shares one
 * credentials object with the heartbeat loop, the work scheduler, and the metrics collector, so
 * replacing the object would leave those closures on the rejected token until the next restart
 * (issue #167). Mutating it keeps every caller on the token the control plane just issued.
 */
export function adoptReregisteredCredentials(
  current: StoredCredentials,
  next: StoredCredentials
): StoredCredentials {
  current.serverId = next.serverId;
  current.agentToken = next.agentToken;
  return current;
}

interface ValidationSnapshot {
  databaseRuntimeHealth?: AgentDatabaseRuntimeHealthReport;
  hostname: string;
  operatingSystem: string | null;
  architecture: string | null;
  kernelRelease: string | null;
  dockerVersion: string | null;
  publicIp: string | null;
  cpuCores: number | null;
  memoryBytes: number | null;
  diskBytesAvailable: number | null;
  diskTotalBytes: number | null;
  latestValidationReport: ServerValidationReport;
  capabilities: AgentCapabilities;
}

async function inspectDockerStorageFilesystem(docker: DockerApiClient): Promise<{
  dockerRootDir: string;
  hostPath: string;
  diskAvailableBytes: number;
  diskTotalBytes: number;
}> {
  const info = await docker.info();
  const dockerRootDir = info.DockerRootDir;
  const hostPath = resolveDockerRootHostPath(dockerRootDir);
  const stats = await statfs(hostPath);
  return {
    dockerRootDir: dockerRootDir!,
    hostPath,
    diskAvailableBytes: Number(stats.bavail) * Number(stats.bsize),
    diskTotalBytes: Number(stats.blocks) * Number(stats.bsize),
  };
}

function buildManagedVolumeLabels(input: {
  volumeId: string;
  projectId?: string | null;
  serviceId?: string | null;
}): Record<string, string> {
  return {
    "nouva.managed": "true",
    "nouva.resource": "volume",
    "nouva.volume.id": input.volumeId,
    ...(input.projectId ? { "nouva.project.id": input.projectId } : {}),
    ...(input.serviceId ? { "nouva.service.id": input.serviceId } : {}),
  };
}

function buildBackupStageVolumeLabels(input: {
  kind: "backup-stage" | "restore-stage";
  backupId: string;
  serviceId: string;
}): Record<string, string> {
  // Intentionally not a "volume" resource: staging volumes are transient scratch space and must
  // never be mistaken for a service data volume by capacity accounting or reconciliation.
  return {
    "nouva.managed": "true",
    "nouva.resource": input.kind,
    "nouva.backup.id": input.backupId,
    "nouva.service.id": input.serviceId,
  };
}

const ARCHIVE_RCLONE_REMOTE = "nouvaarchive";
const ARCHIVE_RCLONE_ENV_PREFIX = `RCLONE_CONFIG_${ARCHIVE_RCLONE_REMOTE.toUpperCase()}`;

function buildArchiveDestinationEnv(
  destination: CreateVolumeBackupPayload["destination"],
  objectKey: string
): string[] {
  return [
    `${ARCHIVE_RCLONE_ENV_PREFIX}_TYPE=s3`,
    `${ARCHIVE_RCLONE_ENV_PREFIX}_PROVIDER=Other`,
    `${ARCHIVE_RCLONE_ENV_PREFIX}_ENV_AUTH=false`,
    `${ARCHIVE_RCLONE_ENV_PREFIX}_ACCESS_KEY_ID=${destination.accessKeyId}`,
    `${ARCHIVE_RCLONE_ENV_PREFIX}_SECRET_ACCESS_KEY=${destination.secretAccessKey}`,
    `${ARCHIVE_RCLONE_ENV_PREFIX}_ENDPOINT=${destination.endpoint}`,
    `${ARCHIVE_RCLONE_ENV_PREFIX}_REGION=${destination.region}`,
    `${ARCHIVE_RCLONE_ENV_PREFIX}_FORCE_PATH_STYLE=${destination.pathStyle ? "true" : "false"}`,
    `${ARCHIVE_RCLONE_ENV_PREFIX}_INSECURE_SKIP_VERIFY=${destination.verifyTls ? "false" : "true"}`,
    `${ARCHIVE_RCLONE_ENV_PREFIX}_NO_CHECK_BUCKET=true`,
    `BACKUP_ACCESS_KEY_ID=${destination.accessKeyId}`,
    `BACKUP_SECRET_ACCESS_KEY=${destination.secretAccessKey}`,
    `BACKUP_ENDPOINT=${destination.endpoint}`,
    `BACKUP_REGION=${destination.region}`,
    `BACKUP_BUCKET=${destination.bucket}`,
    `BACKUP_OBJECT_KEY=${objectKey}`,
    `BACKUP_FORCE_PATH_STYLE=${destination.pathStyle ? "true" : "false"}`,
  ];
}

function toObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function toRecord(value: unknown): Record<string, string> {
  const record = toObject(value);
  const next: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") {
      next[key] = entry;
    }
  }
  return next;
}

function resolveHydratedHelperSpec(payload: {
  imageUrl?: string;
  envVars?: Record<string, string> | undefined;
  containerArgs?: string[] | undefined;
  mountPath?: string;
  dataPath?: string;
}) {
  if (!payload.imageUrl || !payload.mountPath || !payload.dataPath || !payload.envVars) {
    throw new Error("Backup helper payload is missing hydrated executor fields");
  }

  return {
    image: payload.imageUrl,
    envVars: toRecord(payload.envVars),
    containerArgs: Array.isArray(payload.containerArgs)
      ? payload.containerArgs.filter((value): value is string => typeof value === "string")
      : [],
    mountPath: payload.mountPath,
    dataPath: payload.dataPath,
  };
}

function toRuntimeMetadata(value: unknown): RuntimeMetadata | null {
  const metadata = toObject(value);
  return Object.keys(metadata).length > 0 ? (metadata as RuntimeMetadata) : null;
}

function normalizeRetainedRuntimeImage(value: unknown): RuntimeRetainedImage | null {
  const image = toObject(value);
  const reference = typeof image.reference === "string" ? image.reference.trim() : "";
  if (!reference) {
    return null;
  }

  return {
    reference,
    imageId: typeof image.imageId === "string" ? image.imageId : null,
    deploymentId: typeof image.deploymentId === "string" ? image.deploymentId : null,
    commitHash: typeof image.commitHash === "string" ? image.commitHash : null,
  };
}

function resolveCurrentRuntimeImage(
  runtimeMetadata: RuntimeMetadata | null | undefined
): RuntimeRetainedImage | null {
  const currentImage = normalizeRetainedRuntimeImage(runtimeMetadata?.currentImage);
  if (currentImage) {
    return currentImage;
  }

  const reference = typeof runtimeMetadata?.image === "string" ? runtimeMetadata.image.trim() : "";
  return reference
    ? {
        reference,
        imageId: null,
        deploymentId: null,
        commitHash: null,
      }
    : null;
}

function resolvePreviousRuntimeImage(
  runtimeMetadata: RuntimeMetadata | null | undefined
): RuntimeRetainedImage | null {
  return normalizeRetainedRuntimeImage(runtimeMetadata?.previousImage);
}

function sameRetainedRuntimeImage(
  left: RuntimeRetainedImage | null | undefined,
  right: RuntimeRetainedImage | null | undefined
): boolean {
  if (!left || !right) {
    return false;
  }

  if (left.imageId && right.imageId) {
    return left.imageId === right.imageId;
  }

  return left.reference === right.reference;
}

function isDockerLocalImageStore(mode: AgentImageStoreMode): boolean {
  return mode === "docker-local";
}

function buildRetainedRuntimeImage(input: {
  reference: string;
  imageId: string | null;
  deploymentId: string;
  commitHash: string;
}): RuntimeRetainedImage {
  return {
    reference: input.reference,
    imageId: input.imageId,
    deploymentId: input.deploymentId,
    commitHash: input.commitHash,
  };
}

async function removeRetainedRuntimeImage(
  docker: Pick<DockerApiClient, "removeImage">,
  image: RuntimeRetainedImage | null
): Promise<void> {
  if (!image) {
    return;
  }

  if (image.reference) {
    await docker.removeImage(image.reference, true);
    return;
  }

  if (image.imageId) {
    await docker.removeImage(image.imageId, true);
  }
}

async function removeRetainedRuntimeImages(
  docker: Pick<DockerApiClient, "removeImage">,
  runtimeMetadata: RuntimeMetadata | null | undefined
): Promise<void> {
  for (const reference of getRetainedRuntimeImageReferences(runtimeMetadata)) {
    await docker.removeImage(reference, true);
  }
}

function getRetainedRuntimeImageReferences(
  runtimeMetadata: RuntimeMetadata | null | undefined
): string[] {
  return [resolveCurrentRuntimeImage(runtimeMetadata), resolvePreviousRuntimeImage(runtimeMetadata)]
    .map((image) => image?.reference ?? image?.imageId ?? null)
    .filter((reference): reference is string => Boolean(reference))
    .filter((reference, index, references) => references.indexOf(reference) === index);
}

async function verifyContainerAbsent(
  docker: Pick<DockerApiClient, "inspectContainer">,
  identifier: string | null
): Promise<void> {
  if (identifier && (await docker.inspectContainer(identifier))) {
    throw new Error(`Docker container ${identifier} still exists after cleanup`);
  }
}

async function verifyVolumeAbsent(
  docker: Pick<DockerApiClient, "inspectVolume">,
  volumeName: string
): Promise<void> {
  if (await docker.inspectVolume(volumeName)) {
    throw new Error(`Docker volume ${volumeName} still exists after cleanup`);
  }
}

async function verifyNetworkAbsent(
  docker: Pick<DockerApiClient, "inspectNetwork">,
  networkName: string
): Promise<void> {
  if (await docker.inspectNetwork(networkName)) {
    throw new Error(`Docker network ${networkName} still exists after cleanup`);
  }
}

function shouldRetainImageReference(
  runtimeMetadata: RuntimeMetadata | null | undefined,
  imageReference: string
): boolean {
  const retainedImages = [
    resolveCurrentRuntimeImage(runtimeMetadata),
    resolvePreviousRuntimeImage(runtimeMetadata),
  ];

  return retainedImages.some((image) => image?.reference === imageReference);
}

async function readCredentials(): Promise<StoredCredentials | null> {
  try {
    return JSON.parse(await readFile(CREDENTIALS_PATH, "utf8")) as StoredCredentials;
  } catch {
    return null;
  }
}

async function writeCredentials(credentials: StoredCredentials): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${CREDENTIALS_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(credentials, null, 2));
  await rename(tmp, CREDENTIALS_PATH);
}

function buildCheck(
  key: string,
  label: string,
  status: "pass" | "warn" | "fail",
  message: string,
  value: string | null = null
) {
  return { key, label, status, message, value };
}

async function checkTcpConnect(host: string, port: number, timeoutMs = 3000) {
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function checkCommandAvailability(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("sh", ["-lc", `command -v ${JSON.stringify(command)}`]);
    const resolved = stdout.trim();
    return resolved.length > 0 ? resolved : command;
  } catch {
    return null;
  }
}

function resolveAppRuntimePort(
  runtimeMetadata: RuntimeMetadata | null | undefined,
  fallback: number
) {
  const port = runtimeMetadata?.internalPort;
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535
    ? port
    : fallback;
}

function buildAppRolloutResult(input: {
  reusedCandidate?: boolean;
  strategy?: AppRolloutResult["strategy"];
  outcome: AppRolloutResult["outcome"];
  currentPhase: AppRolloutResult["currentPhase"];
  liveRuntimePreserved: boolean;
  rollbackCompleted: boolean;
  drainDurationMs?: number;
  previousContainerRetirement?: AppRolloutResult["previousContainerRetirement"];
  activeContainerName?: string | null;
  candidateContainerName?: string | null;
}): AppRolloutResult {
  return {
    strategy: input.strategy ?? "candidate_ready_cutover",
    outcome: input.outcome,
    currentPhase: input.currentPhase,
    liveRuntimePreserved: input.liveRuntimePreserved,
    rollbackCompleted: input.rollbackCompleted,
    drainDurationMs: input.drainDurationMs,
    previousContainerRetirement: input.previousContainerRetirement ?? null,
    reusedCandidate: input.reusedCandidate ?? false,
    activeContainerName: input.activeContainerName ?? null,
    candidateContainerName: input.candidateContainerName ?? null,
  };
}

class AppRolloutError extends Error {
  readonly result: Record<string, unknown>;

  constructor(message: string, rollout: AppRolloutResult) {
    super(message);
    this.name = "AppRolloutError";
    this.result = {
      rollout,
    };
  }
}

interface DeployAppImageDependencies {
  ensureBaseRuntime: typeof ensureBaseRuntime;
  checkTcpConnect: typeof checkTcpConnect;
  fetchImpl: typeof fetch;
  writeLocalTraefikRoute: typeof writeLocalTraefikRoute;
  deleteLocalTraefikRoute: typeof deleteLocalTraefikRoute;
  sleep?: (ms: number) => Promise<void>;
}

const defaultDeployAppImageDependencies: DeployAppImageDependencies = {
  ensureBaseRuntime,
  checkTcpConnect,
  fetchImpl: fetch,
  writeLocalTraefikRoute,
  deleteLocalTraefikRoute,
  sleep,
};

async function waitForAppCandidateReadiness(
  dependencies: Pick<DeployAppImageDependencies, "checkTcpConnect">,
  docker: Pick<DockerApiClient, "inspectContainer">,
  containerName: string,
  appPort: number,
  rollout: AppRolloutConfig
): Promise<void> {
  const deadline = Date.now() + rollout.readiness.timeoutMs;
  let evidence = NO_CANDIDATE_RUNTIME_EVIDENCE;
  let lastError = "candidate container did not become ready";

  while (Date.now() <= deadline) {
    const inspection = await docker.inspectContainer(containerName);
    if (!inspection) {
      throw new Error(`Candidate container ${containerName} is missing`);
    }

    const assessment = assessCandidateReadiness({
      containerName,
      appPort,
      inspection,
      evidence,
    });
    evidence = assessment.evidence;
    const step = assessment.step;

    if (step.kind === "ready") {
      return;
    }

    if (step.kind === "failed") {
      console.warn("[nouva-agent] app candidate readiness failed", {
        cause: step.cause,
        containerName,
        outOfMemory: evidence.outOfMemory,
        restarts: evidence.restarts,
      });
      throw new Error(step.message);
    }

    if (step.kind === "probe") {
      const reachable = await dependencies.checkTcpConnect(
        step.ipAddress,
        appPort,
        rollout.readiness.tcpConnectTimeoutMs
      );
      if (reachable) {
        return;
      }
      lastError = step.unreachableMessage;
    } else {
      lastError = step.message;
    }

    await sleep(rollout.readiness.intervalMs);
  }

  throw new Error(lastError);
}

type PreviousContainerRetirement = NonNullable<AppRolloutResult["previousContainerRetirement"]>;

function getRetirementErrorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function retirePreviousAppContainer(
  dependencies: Pick<DeployAppImageDependencies, "sleep">,
  docker: Pick<DockerApiClient, "removeContainer" | "stopContainer">,
  containerName: string,
  serviceId: string,
  deploymentId: string,
  rollout: AppRolloutConfig,
  drainDurationMs: number
): Promise<PreviousContainerRetirement> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await (dependencies.sleep ?? sleep)(1000 * attempt);
    const outcome = await retirePreviousAppContainerAttempt(
      dependencies,
      docker,
      containerName,
      serviceId,
      deploymentId,
      rollout,
      attempt === 0 ? drainDurationMs : 0
    );
    if (outcome !== "deferred") return outcome;
  }
  // Keep the healthy candidate. The completion warning is durable; deletion later sweeps leftovers.
  return "deferred";
}

async function retirePreviousAppContainerAttempt(
  dependencies: Pick<DeployAppImageDependencies, "sleep">,
  docker: Pick<DockerApiClient, "removeContainer" | "stopContainer">,
  containerName: string,
  serviceId: string,
  deploymentId: string,
  rollout: AppRolloutConfig,
  drainDurationMs: number
): Promise<PreviousContainerRetirement> {
  if (drainDurationMs > 0) {
    await (dependencies.sleep ?? sleep)(drainDurationMs);
  }

  try {
    await docker.stopContainer(
      containerName,
      rollout.drain.gracefulStopTimeoutSeconds,
      rollout.drain.cleanupTimeoutMs
    );
  } catch (error) {
    console.warn("[nouva-agent] app rollout retirement fallback", {
      containerName,
      deploymentId,
      errorType: getRetirementErrorType(error),
      outcome: "force_remove_attempt",
      serviceId,
      stage: "graceful_stop",
    });
    try {
      await docker.removeContainer(containerName, true, rollout.drain.cleanupTimeoutMs);
      return "forced";
    } catch (fallbackError) {
      console.warn("[nouva-agent] app rollout retirement deferred", {
        containerName,
        deploymentId,
        errorType: getRetirementErrorType(fallbackError),
        outcome: "deferred",
        serviceId,
        stage: "force_remove",
      });
      return "deferred";
    }
  }

  try {
    await docker.removeContainer(containerName, false, rollout.drain.cleanupTimeoutMs);
    return "graceful";
  } catch (error) {
    console.warn("[nouva-agent] app rollout retirement deferred", {
      containerName,
      deploymentId,
      errorType: getRetirementErrorType(error),
      outcome: "deferred",
      serviceId,
      stage: "non_force_remove",
    });
    return "deferred";
  }
}

async function waitForLocalTraefikCutover(
  fetchImpl: typeof fetch,
  serviceId: string,
  expectedServiceUrl: string,
  rollout: AppRolloutConfig
): Promise<void> {
  const serviceName = `svc-${serviceId}@file`;
  const deadline = Date.now() + rollout.cutover.verificationTimeoutMs;
  let lastError = `Traefik did not point ${serviceName} at ${expectedServiceUrl}`;

  while (Date.now() <= deadline) {
    const response = await fetchImpl("http://127.0.0.1:8082/api/http/services");
    if (!response.ok) {
      lastError = `Traefik service inspection failed with status ${response.status}`;
      await sleep(rollout.cutover.verificationIntervalMs);
      continue;
    }

    const services = (await response.json()) as Array<{
      name?: string;
      loadBalancer?: {
        servers?: Array<{
          url?: string;
        }>;
      };
    }>;

    const service = services.find((entry) => entry.name === serviceName);
    const actualUrl = service?.loadBalancer?.servers?.[0]?.url;
    if (actualUrl === expectedServiceUrl) {
      return;
    }

    if (typeof actualUrl === "string" && actualUrl.length > 0) {
      lastError = `Traefik still points ${serviceName} at ${actualUrl}`;
    }

    await sleep(rollout.cutover.verificationIntervalMs);
  }

  throw new Error(lastError);
}

/**
 * A nominal "2 GB" VPS exposes roughly 1.9 GiB to the kernel once firmware and reserved pages are
 * subtracted, so the supported minimum is checked against a tolerant threshold rather than 2 GiB.
 */
const NOMINAL_TWO_GB_BYTES = Math.floor(1.75 * 1024 * 1024 * 1024);
const NOMINAL_ONE_GB_BYTES = Math.floor(0.875 * 1024 * 1024 * 1024);

async function readSystemdResolvedUpstreams(): Promise<string[]> {
  try {
    const content = await readFile("/hostfs/run/systemd/resolve/resolv.conf", "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^nameserver\s+\S+/.test(line))
      .map((line) => line.split(/\s+/)[1] ?? "")
      .filter((address) => address.length > 0 && !/^127\./.test(address) && address !== "::1");
  } catch {
    return [];
  }
}

/** `uname -r` of the host the agent container shares its kernel with; null if unavailable. */
function readKernelRelease(): string | null {
  try {
    const release = os.release().trim();
    return release.length > 0 ? release : null;
  } catch {
    return null;
  }
}

async function collectValidationSnapshot(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  credentials?: StoredCredentials | null
): Promise<ValidationSnapshot> {
  const checks: ValidationSnapshot["latestValidationReport"]["checks"] = [];
  const hostOsId = (process.env.NOUVA_HOST_OS_ID || "unknown").toLowerCase();
  const hostOsVersion = process.env.NOUVA_HOST_OS_VERSION_ID || "unknown";
  const hostArch = os.arch();

  const osSupported = hostOsId === "ubuntu";
  checks.push(
    buildCheck(
      "os",
      "Supported OS",
      osSupported ? "pass" : "fail",
      osSupported ? `Ubuntu ${hostOsVersion} detected` : "Nouva currently supports Ubuntu only",
      `${hostOsId} ${hostOsVersion}`
    )
  );

  const archSupported = hostArch === "x64" || hostArch === "amd64";
  checks.push(
    buildCheck(
      "arch",
      "Supported architecture",
      archSupported ? "pass" : "fail",
      archSupported ? "x86_64 detected" : "Nouva currently supports x86_64 only",
      hostArch
    )
  );

  let dockerVersion: string | null = null;
  try {
    const version = await docker.request<{ Version?: string }>("GET", "/version");
    dockerVersion = version.Version ?? null;
    checks.push(
      buildCheck(
        "docker",
        "Docker Engine",
        dockerVersion ? "pass" : "fail",
        dockerVersion ? "Docker Engine is available" : "Docker Engine is unavailable",
        dockerVersion
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "docker",
        "Docker Engine",
        "fail",
        error instanceof Error ? error.message : "Docker Engine is unavailable"
      )
    );
  }

  const [gitPath, railpackPath, buildctlPath] = await Promise.all([
    checkCommandAvailability(GIT_BIN),
    checkCommandAvailability(RAILPACK_BIN),
    checkCommandAvailability(BUILDCTL_BIN),
  ]);

  checks.push(
    buildCheck(
      "git",
      "Git CLI",
      gitPath ? "pass" : "fail",
      gitPath ? "Git is available for repository clones" : "Git is missing from the agent runtime",
      gitPath
    ),
    buildCheck(
      "railpack",
      "Railpack CLI",
      railpackPath ? "pass" : "fail",
      railpackPath
        ? "Railpack is available for build detection and build planning"
        : "Railpack is missing from the agent runtime",
      railpackPath
    ),
    buildCheck(
      "buildctl",
      "Buildctl CLI",
      buildctlPath ? "pass" : "fail",
      buildctlPath
        ? "Buildctl is available for image builds"
        : "Buildctl is missing from the agent runtime",
      buildctlPath
    )
  );

  if (dockerVersion) {
    checks.push(await collectManagedContainerLogConfigValidationCheck(docker));

    let traefikBootstrapError: Error | null = null;
    try {
      await ensureTraefikRuntimeSerialized(docker, getTraefikRuntimeInput(config));
    } catch (error) {
      traefikBootstrapError =
        error instanceof Error ? error : new Error("Failed to reconcile Traefik");
    }

    checks.push(
      ...(await collectTraefikValidationChecks(
        docker,
        getTraefikRuntimeInput(config),
        undefined,
        traefikBootstrapError
      ))
    );

    try {
      await ensureBuildkitImage(docker);
      checks.push(
        buildCheck(
          "buildkit",
          "BuildKit image",
          "pass",
          "BuildKit image is present, so a build can start its own daemon",
          BUILDKIT_IMAGE
        )
      );
    } catch (error) {
      checks.push(
        buildCheck(
          "buildkit",
          "BuildKit image",
          "fail",
          error instanceof Error ? error.message : "BuildKit image is unavailable",
          BUILDKIT_IMAGE
        )
      );
    }

    if (config.imageStoreMode === "local-registry") {
      try {
        await ensureLocalRegistryRuntime(docker, config);
        checks.push(
          buildCheck(
            "registry",
            "Local image registry",
            "pass",
            "Local image registry is reachable and ready for pushes",
            `127.0.0.1:${config.localRegistryPort}`
          )
        );
      } catch (error) {
        checks.push(
          buildCheck(
            "registry",
            "Local image registry",
            "fail",
            error instanceof Error ? error.message : "Local image registry is unavailable",
            `127.0.0.1:${config.localRegistryPort}`
          )
        );
      }
    }

    if (config.observability.enabled) {
      if (!credentials?.agentToken || !config.observability.organizationId) {
        checks.push(
          ...buildUnavailableAlloyChecks(
            "Observability is enabled but Alloy is waiting for server-scoped credentials"
          )
        );
      } else {
        let alloyBootstrapError: Error | null = null;
        try {
          await ensureAlloyRuntime(docker, getAlloyRuntimeInput(credentials, config), {
            paths: ALLOY_PATHS,
          });
        } catch (error) {
          alloyBootstrapError =
            error instanceof Error ? error : new Error("Failed to reconcile Alloy");
        }

        checks.push(
          ...(await collectAlloyValidationChecks(
            docker,
            getAlloyRuntimeInput(credentials, config),
            {
              paths: ALLOY_PATHS,
            },
            alloyBootstrapError
          ))
        );
      }
    }
  } else {
    checks.push(...buildUnavailableTraefikChecks("Docker Engine is unavailable"));
    checks.push(
      buildCheck(
        "buildkit",
        "BuildKit image",
        "fail",
        "Docker Engine is unavailable, so BuildKit cannot be reconciled",
        BUILDKIT_IMAGE
      )
    );
    if (config.imageStoreMode === "local-registry") {
      checks.push(
        buildCheck(
          "registry",
          "Local image registry",
          "fail",
          "Docker Engine is unavailable, so the local image registry cannot be reconciled",
          `127.0.0.1:${config.localRegistryPort}`
        )
      );
    }

    if (config.observability.enabled) {
      checks.push(...buildUnavailableAlloyChecks("Docker Engine is unavailable"));
    }
  }

  let diskBytesAvailable: number | null = null;
  let diskTotalBytes: number | null = null;
  try {
    const disk = await inspectDockerStorageFilesystem(docker);
    diskBytesAvailable = disk.diskAvailableBytes;
    diskTotalBytes = disk.diskTotalBytes;
    const safetyReserveBytes = calculateDiskSafetyReserveBytes(diskTotalBytes);
    const status =
      diskBytesAvailable <= safetyReserveBytes
        ? "fail"
        : diskBytesAvailable < safetyReserveBytes * 2
          ? "warn"
          : "pass";
    const action =
      "Add disk capacity or remove unused data, images, or volumes before Docker storage is exhausted.";
    checks.push(
      buildCheck(
        "disk",
        "Docker storage headroom",
        status,
        status === "pass"
          ? `${formatStorageBytes(diskBytesAvailable)} free on Docker storage at ${disk.dockerRootDir}.`
          : `${formatStorageBytes(diskBytesAvailable)} free on Docker storage at ${disk.dockerRootDir}. Safety reserve: ${formatStorageBytes(safetyReserveBytes)}. ${action}`,
        String(diskBytesAvailable)
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "disk",
        "Docker storage headroom",
        "warn",
        error instanceof Error ? error.message : "Unable to inspect Docker storage"
      )
    );
  }

  try {
    const response = await fetch(`${API_URL}/health`);
    checks.push(
      buildCheck(
        "outbound",
        "Outbound connectivity",
        response.ok ? "pass" : "fail",
        response.ok ? "Can reach Nouva API" : "Cannot reach Nouva API",
        String(response.status)
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "outbound",
        "Outbound connectivity",
        "fail",
        error instanceof Error ? error.message : "Unable to reach Nouva API"
      )
    );
  }

  const totalMemoryBytes = os.totalmem();
  checks.push(
    buildCheck(
      "memory",
      "Memory headroom",
      totalMemoryBytes >= NOMINAL_TWO_GB_BYTES
        ? "pass"
        : totalMemoryBytes >= NOMINAL_ONE_GB_BYTES
          ? "warn"
          : "fail",
      totalMemoryBytes >= NOMINAL_TWO_GB_BYTES
        ? "At least 2 GB RAM available"
        : totalMemoryBytes >= NOMINAL_ONE_GB_BYTES
          ? "Less than 2 GB RAM — some workloads may be constrained"
          : "Less than 1 GB RAM — insufficient for most workloads",
      String(totalMemoryBytes)
    )
  );

  // IP forwarding — required for all Docker container networking and NAT
  try {
    const ipForward = (await readFile("/hostfs/proc/sys/net/ipv4/ip_forward", "utf8")).trim();
    checks.push(
      buildCheck(
        "ip-forward",
        "IP forwarding",
        ipForward === "1" ? "pass" : "fail",
        ipForward === "1"
          ? "IP forwarding is enabled"
          : "IP forwarding is disabled — container networking and NAT will not work",
        ipForward
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "ip-forward",
        "IP forwarding",
        "warn",
        error instanceof Error ? error.message : "Unable to read IP forwarding state"
      )
    );
  }

  // cgroup v2 — required for correct memory limits and OOM handling on containers
  try {
    await readFile("/hostfs/sys/fs/cgroup/cgroup.controllers", "utf8");
    checks.push(
      buildCheck("cgroup-version", "cgroup v2", "pass", "cgroup v2 unified hierarchy detected")
    );
  } catch {
    checks.push(
      buildCheck(
        "cgroup-version",
        "cgroup v2",
        "fail",
        "cgroup v1 detected — container memory limits and OOM protection will not be enforced correctly"
      )
    );
  }

  // Short-lived privileged helpers (the clock probe and the inotify tuner) run the agent's own
  // image, so its reference is resolved once per snapshot.
  let agentHelperImage: string | null = null;
  let agentHelperImageError: string | null = null;
  if (dockerVersion !== null) {
    try {
      agentHelperImage = await resolveAgentTaskImage(docker);
    } catch (error) {
      agentHelperImageError =
        error instanceof Error ? error.message : "Unable to resolve the agent image";
    }
  }

  // Clock synchronisation — drift breaks TLS, ACME challenges, and pgBackRest PITR
  {
    const clockSync = evaluateClockSync(
      await detectHostClockSync(
        agentHelperImage === null
          ? {
              kind: "unavailable",
              reason: agentHelperImageError ?? "Docker Engine is unavailable",
            }
          : { kind: "available", docker, image: agentHelperImage },
        { labels: buildLabels({ kind: "clock-probe" }) }
      )
    );
    checks.push(
      buildCheck(
        "clock-sync",
        "Clock synchronisation",
        clockSync.status,
        clockSync.message,
        clockSync.value
      )
    );
  }

  // DNS configuration — a systemd-resolved stub is fine as long as Docker can find the upstream
  // resolvers it forwards container DNS to (/run/systemd/resolve/resolv.conf); without them
  // containers on bridge networks would try to reach 127.0.0.53 and fail silently.
  try {
    let isStub = false;
    try {
      const symlinkTarget = await readlink("/hostfs/etc/resolv.conf");
      isStub = symlinkTarget.includes("stub-resolv.conf");
    } catch {
      const content = await readFile("/hostfs/etc/resolv.conf", "utf8");
      isStub =
        /^nameserver\s+127\.0\.0\.53$/m.test(content) && !content.includes("nameserver 127.0.0.1");
    }
    const upstreams = isStub ? await readSystemdResolvedUpstreams() : [];
    const stubWithoutUpstreams = isStub && upstreams.length === 0;
    checks.push(
      buildCheck(
        "dns-stub",
        "DNS configuration",
        stubWithoutUpstreams ? "warn" : "pass",
        stubWithoutUpstreams
          ? "resolv.conf points to the systemd-resolved stub (127.0.0.53) and no upstream resolvers were found — container DNS resolution may fail"
          : isStub
            ? `systemd-resolved stub in use; Docker forwards container DNS to ${upstreams.join(", ")}`
            : "DNS configuration looks correct",
        isStub ? upstreams.join(",") : undefined
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "dns-stub",
        "DNS configuration",
        "warn",
        error instanceof Error ? error.message : "Unable to inspect DNS configuration"
      )
    );
  }

  // inotify watch limit — Traefik file watching silently stops when the host limit is exhausted.
  // The agent raises the limit itself (see host-tuning.ts) before reporting on it.
  let hostTuningMessage: string | null = agentHelperImageError;
  if (agentHelperImage !== null) {
    try {
      const tuning = await ensureHostKernelSettings(docker, {
        image: agentHelperImage,
        labels: buildLabels({ kind: "host-tuning" }),
      });
      if (tuning.status === "applied") {
        console.log(
          `[nouva-agent] raised host inotify limits to ${tuning.limits.maxUserWatches} watches / ${tuning.limits.maxUserInstances} instances`
        );
      } else if (tuning.status === "failed") {
        hostTuningMessage = tuning.message;
        console.warn(`[nouva-agent] host tuning failed: ${tuning.message}`);
      }
    } catch (error) {
      hostTuningMessage = error instanceof Error ? error.message : "Unable to tune host";
    }
  }
  try {
    const maxWatches = parseInt(
      (await readFile("/hostfs/proc/sys/fs/inotify/max_user_watches", "utf8")).trim(),
      10
    );
    const sufficient = maxWatches >= HOST_INOTIFY_MAX_USER_WATCHES;
    checks.push(
      buildCheck(
        "inotify-limits",
        "inotify watch limit",
        sufficient ? "pass" : "warn",
        sufficient
          ? `inotify watch limit is sufficient (${maxWatches.toLocaleString()})`
          : `inotify watch limit is low (${maxWatches.toLocaleString()}) — Traefik file watching may silently stop as more services are deployed${hostTuningMessage ? ` (automatic tuning failed: ${hostTuningMessage})` : ""}`,
        String(maxWatches)
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "inotify-limits",
        "inotify watch limit",
        "warn",
        error instanceof Error ? error.message : "Unable to read inotify limits"
      )
    );
  }

  let publicIp: string | null = null;
  try {
    const response = await fetch("https://api.ipify.org?format=json");
    if (response.ok) {
      const body = (await response.json()) as { ip?: string };
      publicIp = body.ip ?? null;
    }
  } catch {}

  const summary = checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 }
  );

  return {
    hostname: os.hostname(),
    operatingSystem: `${hostOsId} ${hostOsVersion}`,
    architecture: hostArch,
    // The release string exactly as `uname -r` reports it. The control plane decides which database
    // images can start on it (MongoDB 8.0 refuses a range of kernels by this string), so it is sent
    // verbatim rather than interpreted here.
    kernelRelease: readKernelRelease(),
    dockerVersion,
    publicIp,
    cpuCores: os.cpus().length,
    memoryBytes: os.totalmem(),
    diskBytesAvailable,
    diskTotalBytes,
    latestValidationReport: {
      checkedAt: new Date().toISOString(),
      summary,
      checks,
    },
    capabilities: resolveAgentCapabilities(config),
    // Collected by its own bounded loop so an in-flight probe never delays a heartbeat.
    ...(latestDatabaseRuntimeHealth ? { databaseRuntimeHealth: latestDatabaseRuntimeHealth } : {}),
  };
}

export function shouldStopRetryingAgentWorkMutation(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    (error.status === 404 || error.status === 409 || error.status === 422)
  );
}

/**
 * A 422 means the control plane refused the *content* of this result and always will: the lease is
 * still ours and a retry reproduces the same rejection. It is the one non-retryable status that
 * leaves work behind on the server, so it is handled apart from 404/409 (lease genuinely gone).
 */
export function isAgentWorkResultRejected(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 422;
}

export function readApiRequestErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiRequestError)) {
    return fallback;
  }
  try {
    const parsed: unknown = JSON.parse(error.responseBody);
    if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
      const message = (parsed as { message: unknown }).message;
      if (typeof message === "string" && message.trim().length > 0) {
        return message.trim();
      }
    }
  } catch {
    // Not a JSON error envelope; fall through to the raw body.
  }
  return error.responseBody.trim() || fallback;
}

export interface AgentWorkFailureReport {
  errorMessage: string;
  result: Record<string, unknown> | null;
}

const AGENT_WORK_RESULT_PROTOCOL_KEYS = [
  "activePgbackrestSets",
  "artifactFormat",
  "artifactSha256",
  "buildDuration",
  "cleanupProof",
  "completedAt",
  "containerId",
  "containerName",
  "detectedFramework",
  "detectedLanguage",
  "exitCode",
  "externalHost",
  "externalPort",
  "imageUrl",
  "importFailure",
  "importProof",
  "integrityProof",
  "internalHost",
  "internalPort",
  "job",
  "languageVersion",
  "objectKey",
  "pgbackrestSet",
  "pgbackrestType",
  "restoreProof",
  "rollout",
  "runtimeInstance",
  "runtimeInstances",
  "runtimeMetadata",
  "scheduleRunId",
  "sizeBytes",
  "startedAt",
  "status",
  "statusMessage",
  "verifiedAt",
] as const;

export class AgentWorkResultRedactionConflictError extends Error {
  constructor() {
    super("Agent work result conflicts with protected environment material");
    this.name = "AgentWorkResultRedactionConflictError";
  }
}

/**
 * Work kinds that start a container before reporting. When such a result cannot be delivered the
 * container is orphaned: nothing on the control plane knows it exists, and the retry starts another
 * one beside it. These are the kinds whose result is rolled back before the failure is reported.
 */
const CONTAINER_STARTING_WORK_KINDS = new Set<string>([
  "deploy_app",
  "deploy_worker",
  "redeploy_app",
  "redeploy_worker",
  "rollback_app",
  "rollback_worker",
  "scale_worker",
]);

const RESULT_CONTAINER_IDENTIFIER_KEYS = new Set([
  "activeContainerName",
  "candidateContainerName",
  "containerId",
  "containerName",
]);

const MAX_RESULT_CONTAINER_SCAN_DEPTH = 6;

function collectResultContainerIdentifiers(
  value: unknown,
  identifiers: Set<string>,
  depth = 0
): void {
  if (depth > MAX_RESULT_CONTAINER_SCAN_DEPTH || value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectResultContainerIdentifiers(entry, identifiers, depth + 1);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (RESULT_CONTAINER_IDENTIFIER_KEYS.has(key) && typeof entry === "string") {
      const identifier = entry.trim();
      if (identifier.length > 0) {
        identifiers.add(identifier);
      }
      continue;
    }
    collectResultContainerIdentifiers(entry, identifiers, depth + 1);
  }
}

/**
 * Removes the containers a work item started when its result will never be accepted — either the
 * agent's own sanitizer refused to ship it, or the control plane rejected it with a 422. Containers
 * the payload already described are left alone: those were running before this attempt, and the
 * service keeps serving from them.
 */
export async function rollbackUnreportableWorkResult(
  docker: Pick<DockerApiClient, "removeContainer">,
  input: {
    kind: string;
    workItemId: string;
    payload: Record<string, unknown>;
    result: Record<string, unknown> | null | undefined;
  }
): Promise<string[]> {
  if (!CONTAINER_STARTING_WORK_KINDS.has(input.kind) || !input.result) {
    return [];
  }

  // Only the original local result is used here. An adopted candidate may already be committed,
  // even when this re-lease's payload still names an older runtime.
  if (
    ["deploy_app", "redeploy_app", "rollback_app"].includes(input.kind) &&
    toObject(input.result.rollout).reusedCandidate === true
  )
    return [];

  const started = new Set<string>();
  collectResultContainerIdentifiers(input.result, started);
  const preexisting = new Set<string>();
  collectResultContainerIdentifiers(input.payload.runtimeMetadata, preexisting);

  const removed: string[] = [];
  for (const identifier of started) {
    if (preexisting.has(identifier)) {
      continue;
    }
    try {
      await docker.removeContainer(identifier, true);
      removed.push(identifier);
    } catch (error) {
      console.error(
        `[nouva-agent] failed to remove container ${identifier} after work ${input.workItemId} ` +
          "produced an unreportable result:",
        error
      );
    }
  }

  if (removed.length > 0) {
    console.warn(
      `[nouva-agent] work ${input.workItemId} produced a result the control plane cannot accept; ` +
        `removed ${removed.join(", ")}`
    );
  }
  return removed;
}

function normalizeAgentProtocolValueForConflictCheck(
  key: (typeof AGENT_WORK_RESULT_PROTOCOL_KEYS)[number],
  value: unknown
): unknown {
  if (key === "statusMessage") {
    return "[DIAGNOSTIC]";
  }
  if (key === "importFailure" && typeof value === "object" && value !== null) {
    // Prose about a failure the customer's own bytes caused, diagnostic in exactly the way
    // `statusMessage` is. Dropping the whole result over a redaction inside it would cost the
    // control plane the failure category, which is the one thing the customer needs.
    return { ...(value as Record<string, unknown>), message: "[DIAGNOSTIC]" };
  }
  if (key !== "job" || typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const job = { ...(value as Record<string, unknown>) };
  if (Object.hasOwn(job, "statusMessage")) {
    job.statusMessage = "[DIAGNOSTIC]";
  }
  return job;
}

function agentProtocolValueHasRedactionConflict(
  key: (typeof AGENT_WORK_RESULT_PROTOCOL_KEYS)[number],
  value: unknown,
  sanitizedValue: unknown
): boolean {
  try {
    return (
      JSON.stringify(normalizeAgentProtocolValueForConflictCheck(key, value)) !==
      JSON.stringify(normalizeAgentProtocolValueForConflictCheck(key, sanitizedValue))
    );
  } catch {
    return true;
  }
}

/**
 * Sanitizes one protocol field. A rollout's worker shutdown fields are rebuilt from their closed
 * vocabularies rather than redacted, the same way the control plane reads them, so a customer
 * variable equal to "SIGTERM" or "previous" cannot turn a finished rollout into a leak.
 */
function sanitizeAgentProtocolValue(
  key: (typeof AGENT_WORK_RESULT_PROTOCOL_KEYS)[number],
  value: unknown,
  environmentVariables: EnvironmentVariableMap,
  operationalValues: readonly string[]
): unknown {
  const sanitized = sanitizeSensitiveProtocolValue(value, environmentVariables, operationalValues);
  if (
    key !== "rollout" ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof sanitized !== "object" ||
    sanitized === null
  ) {
    return sanitized;
  }
  return {
    ...sanitized,
    ...sanitizeWorkerRolloutShutdownFields(value as Record<string, unknown>, (containerName) =>
      sanitizeSensitiveProtocolValue(containerName, environmentVariables, operationalValues)
    ),
  };
}

export function sanitizeAgentWorkResult(
  result: Record<string, unknown> | null | undefined,
  environmentVariables: EnvironmentVariableMap,
  operationalValues: readonly string[] = []
): Record<string, unknown> | null {
  if (!result) {
    return null;
  }

  const sanitizedResult = sanitizeSensitiveValue(result, environmentVariables, operationalValues);
  if (!sanitizedResult || typeof sanitizedResult !== "object" || Array.isArray(sanitizedResult)) {
    return null;
  }

  const safeResult = sanitizedResult as Record<string, unknown>;
  for (const key of AGENT_WORK_RESULT_PROTOCOL_KEYS) {
    if (Object.hasOwn(result, key)) {
      const sanitizedProtocolValue = sanitizeAgentProtocolValue(
        key,
        result[key],
        environmentVariables,
        operationalValues
      );
      if (agentProtocolValueHasRedactionConflict(key, result[key], sanitizedProtocolValue)) {
        throw new AgentWorkResultRedactionConflictError();
      }
      safeResult[key] = sanitizedProtocolValue;
    }
    if (Object.hasOwn(result, key) && Object.hasOwn(environmentVariables, key)) {
      delete safeResult["[REDACTED]"];
    }
  }
  return safeResult;
}

export function buildAgentWorkFailureReport(input: {
  environmentVariables: EnvironmentVariableMap;
  errorMessage: string;
  operationalValues?: readonly string[];
  result?: Record<string, unknown> | null;
}): AgentWorkFailureReport {
  const operationalValues = input.operationalValues ?? [];
  let result: Record<string, unknown> | null;
  try {
    result = sanitizeAgentWorkResult(input.result, input.environmentVariables, operationalValues);
  } catch (error) {
    if (!(error instanceof AgentWorkResultRedactionConflictError)) {
      throw error;
    }
    result = null;
  }
  return {
    errorMessage: redactSensitiveText(
      input.errorMessage,
      input.environmentVariables,
      operationalValues
    ),
    result,
  };
}

/**
 * Every control-plane request the agent makes is awaited by a loop that only advances once the
 * request settles. A socket that stalls rather than fails -- a connection held open across the
 * Traefik cutover of a control-plane deploy, say -- therefore does not retry, it ends the loop:
 * the heartbeat timer stops re-arming, a leased work item never reports, and the container goes on
 * looking healthy. Give every request a deadline so a stall arrives as the rejection the loops
 * already know how to handle. Every payload here is a small JSON document, so one bound fits all
 * of them.
 */
export const AGENT_REQUEST_TIMEOUT_MS = 30_000;

function requestDeadlineSignal(callerSignal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(AGENT_REQUEST_TIMEOUT_MS);
  return callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
}

async function apiRequest<T>(
  pathName: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const response = await fetch(`${API_URL}${pathName}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: requestDeadlineSignal(options.signal),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new ApiRequestError({
      method: options.method ?? "GET",
      pathName,
      status: response.status,
      message,
    });
  }

  return (await response.json()) as T;
}

type AgentWorkLeaseRenewalTimer = unknown;

export interface AgentWorkLeaseRenewalController {
  ready: Promise<boolean>;
  leaseLost(): boolean;
  stop(): Promise<void>;
}

export function resolveAgentWorkLeaseRenewalIntervalMs(leaseTtlSeconds: number): number {
  const safeLeaseTtlSeconds =
    Number.isFinite(leaseTtlSeconds) && leaseTtlSeconds > 0
      ? leaseTtlSeconds
      : DEFAULT_AGENT_LEASE_TTL_SECONDS;
  return Math.max(1_000, Math.floor((safeLeaseTtlSeconds * 1_000) / 3));
}

export function startAgentWorkLeaseRenewal(input: {
  leaseTtlSeconds: number;
  renewLease: (signal: AbortSignal) => Promise<AgentLeaseRenewResponse>;
  onTransientError?: (error: unknown) => void;
  onLeaseLost?: (error: unknown) => void;
  schedule?: (callback: () => void, delayMs: number) => AgentWorkLeaseRenewalTimer;
  clearScheduled?: (timer: AgentWorkLeaseRenewalTimer) => void;
}): AgentWorkLeaseRenewalController {
  const normalIntervalMs = resolveAgentWorkLeaseRenewalIntervalMs(input.leaseTtlSeconds);
  const transientRetryIntervalMs = Math.min(normalIntervalMs, 5_000);
  const schedule = input.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearScheduled =
    input.clearScheduled ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let stopped = false;
  let leaseLost = false;
  let scheduled: AgentWorkLeaseRenewalTimer | null = null;
  let activeAbortController: AbortController | null = null;
  let inFlight: Promise<void> | null = null;

  const runRenewal = async (): Promise<void> => {
    if (stopped || leaseLost) {
      return;
    }

    activeAbortController = new AbortController();
    let nextDelayMs = normalIntervalMs;

    try {
      await input.renewLease(activeAbortController.signal);
    } catch (error) {
      if (stopped && error instanceof Error && error.name === "AbortError") {
        return;
      }

      if (shouldStopRetryingAgentWorkMutation(error)) {
        leaseLost = true;
        input.onLeaseLost?.(error);
        return;
      }

      nextDelayMs = transientRetryIntervalMs;
      input.onTransientError?.(error);
    } finally {
      activeAbortController = null;
      if (!stopped && !leaseLost) {
        scheduled = schedule(() => {
          scheduled = null;
          void startRenewal();
        }, nextDelayMs);
      }
    }
  };

  const startRenewal = (): Promise<void> => {
    const renewal = runRenewal();
    inFlight = renewal;
    void renewal.finally(() => {
      if (inFlight === renewal) {
        inFlight = null;
      }
    });
    return renewal;
  };

  const ready = startRenewal().then(() => !leaseLost);

  return {
    ready,
    leaseLost: () => leaseLost,
    async stop() {
      stopped = true;
      if (scheduled !== null) {
        clearScheduled(scheduled);
        scheduled = null;
      }
      activeAbortController?.abort();
      await inFlight;
    },
  };
}

async function renewAgentWorkLease(
  credentials: StoredCredentials,
  workItem: AgentWorkRecord,
  signal: AbortSignal
): Promise<AgentLeaseRenewResponse> {
  if (!workItem.leaseId) {
    throw new Error(`Leased work ${workItem.id} is missing leaseId`);
  }

  return await apiRequest<AgentLeaseRenewResponse>(
    `/api/agent/work/${encodeURIComponent(workItem.id)}/renew`,
    {
      method: "POST",
      token: credentials.agentToken,
      signal,
      body: {
        serverId: SERVER_ID!,
        leaseId: workItem.leaseId,
      } satisfies AgentLeaseRenewRequest,
    }
  );
}

let registrationUsed = false;

async function registerAgent(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  signal?: AbortSignal
): Promise<{
  credentials: StoredCredentials;
  config: AgentRuntimeConfig;
}> {
  const snapshot = await collectValidationSnapshot(docker, config);
  const payload = await apiRequest<AgentRegistrationResponse>("/api/agent/register", {
    method: "POST",
    body: {
      serverId: SERVER_ID!,
      registrationToken: REGISTRATION_TOKEN,
      agentVersion: AGENT_VERSION,
      ...snapshot,
    },
    signal,
  });

  const credentials = {
    serverId: SERVER_ID!,
    agentToken: payload.agentToken,
  };
  await writeCredentials(credentials);
  registrationUsed = true;
  rememberRedactionContextScopeVersions(payload.config);

  return { credentials, config: payload.config };
}

async function sendHeartbeat(
  docker: DockerApiClient,
  credentials: StoredCredentials,
  config: AgentRuntimeConfig,
  signal?: AbortSignal
): Promise<AgentRuntimeConfig> {
  return sendAgentHeartbeat(
    {
      collectSnapshot: (currentConfig) =>
        collectValidationSnapshot(docker, currentConfig, credentials),
      reconcileTraefik: (nextConfig) =>
        ensureTraefikRuntimeSerialized(docker, getTraefikRuntimeInput(nextConfig)),
      request: (snapshot, requestSignal) => {
        return fetch(`${API_URL}/api/agent/heartbeat`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.agentToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            serverId: SERVER_ID!,
            agentVersion: AGENT_VERSION,
            ...snapshot,
          }),
          signal: requestDeadlineSignal(requestSignal),
        });
      },
      reregister: async (currentConfig, requestSignal) => {
        if (!REGISTRATION_TOKEN || registrationUsed) {
          throw new Error("Agent credentials were rejected. Reinstall the agent.");
        }

        const next = await registerAgent(docker, currentConfig, requestSignal);
        // Propagate the fresh token to every closure holding this credentials object; the next
        // heartbeat's validation snapshot reconciles Alloy with it as well.
        adoptReregisteredCredentials(credentials, next.credentials);
        return next.config;
      },
      reloadRedactionContext: async (nextConfig, previousConfig) => {
        const previousScopeVersions = latestRedactionContextScopeVersions;
        rememberRedactionContextScopeVersions(nextConfig);
        if (
          nextConfig.observability.enabled &&
          (nextConfig.observability.redactionContextVersion !==
            previousConfig.observability.redactionContextVersion ||
            !redactionContextScopeVersionsEqual(
              previousScopeVersions,
              latestRedactionContextScopeVersions
            ))
        ) {
          try {
            await ensureAlloyRuntime(docker, getAlloyRuntimeInput(credentials, nextConfig), {
              paths: ALLOY_PATHS,
            });
          } catch {
            console.error(
              "[nouva-agent] Alloy redaction context reload failed; validation will retry"
            );
          }
        }
      },
    },
    config,
    signal
  );
}

type AgentHeartbeatTimer = unknown;

export interface AgentHeartbeatLoopInput {
  /** One heartbeat attempt. The signal is aborted when the attempt outlives its deadline. */
  runTick: (signal: AbortSignal) => Promise<void>;
  /** Read per tick, because the control plane can change the interval in its heartbeat response. */
  nextDelayMs: () => number;
  isStopped: () => boolean;
  onFailure: (error: unknown, failures: number, limit: number) => void;
  onFailureLimit: () => void;
  tickTimeoutMs?: number;
  maxConsecutiveFailures?: number;
  schedule?: (callback: () => void, delayMs: number) => AgentHeartbeatTimer;
  clearScheduled?: (timer: AgentHeartbeatTimer) => void;
}

export interface AgentHeartbeatLoop {
  start(): void;
  stop(): void;
}

/**
 * A tick that outlives this is treated as failed. It is deliberately far longer than the request
 * deadline: the only thing left that can hang once the request is bounded is the Docker socket the
 * validation snapshot reads, and a slow-but-working host must not be counted as a failure. What
 * matters is that no tick can hang *forever*, because the reschedule hangs with it.
 */
export const HEARTBEAT_TICK_TIMEOUT_MS = 90_000;
const MAX_HEARTBEAT_FAILURES = 5;

/**
 * The heartbeat loop, with the one invariant its inline predecessor lacked: every tick settles, so
 * every tick reschedules. Rescheduling used to hang off `.finally()` of an unbounded promise, so a
 * single stalled request ended the loop for good -- and because the failure watchdog counts
 * rejections, a loop that never gets a second attempt can never reach the limit that exists to
 * restart the process. One wedged request left a live agent reporting nothing until someone noticed
 * the server card said Offline.
 */
export function createAgentHeartbeatLoop(input: AgentHeartbeatLoopInput): AgentHeartbeatLoop {
  const tickTimeoutMs = input.tickTimeoutMs ?? HEARTBEAT_TICK_TIMEOUT_MS;
  const failureLimit = input.maxConsecutiveFailures ?? MAX_HEARTBEAT_FAILURES;
  const schedule = input.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearScheduled =
    input.clearScheduled ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  let failures = 0;
  let skips = 0;
  let stopped = false;
  let inFlight = false;
  let scheduled: AgentHeartbeatTimer | null = null;

  const reschedule = () => {
    if (stopped || input.isStopped()) {
      return;
    }
    scheduled = schedule(() => {
      scheduled = null;
      void runTick();
    }, input.nextDelayMs());
  };

  /** Returns whether the loop should keep going, so the watchdog decision lives in one place. */
  const recordFailure = (error: unknown): boolean => {
    failures++;
    input.onFailure(error, failures, failureLimit);
    if (failures >= failureLimit) {
      stopped = true;
      input.onFailureLimit();
      return false;
    }
    return true;
  };

  /**
   * A skip means the previous tick is still outstanding, not that anything new has gone wrong --
   * so it is counted apart from `failures`. Merging the two meant a merely slow tick could rack
   * up "skipped" ticks on the same counter as real failures and hit the limit before it ever got
   * a chance to succeed, which is the opposite of what the limit exists to detect. Enough
   * consecutive skips of the SAME still-stuck tick still walks this counter to the limit, which
   * is what makes a genuine wedge exit.
   */
  const recordSkip = (): boolean => {
    skips++;
    input.onFailure(
      new Error("Heartbeat skipped: the previous tick has not finished"),
      skips,
      failureLimit
    );
    if (skips >= failureLimit) {
      stopped = true;
      input.onFailureLimit();
      return false;
    }
    return true;
  };

  const runTick = async (): Promise<void> => {
    if (stopped || input.isStopped()) {
      return;
    }

    // A tick that blew its deadline is abandoned, not cancelled: aborting the signal reaches the
    // request, but not the validation snapshot the tick collects before it, and that snapshot
    // reconciles fixed-name Docker resources. Two of those running at once is container churn, so
    // an overrun tick is counted and waited out rather than overlapped.
    if (inFlight) {
      if (recordSkip()) {
        reschedule();
      }
      return;
    }

    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    inFlight = true;
    const work = input.runTick(controller.signal);
    // Whenever the stuck work finally settles -- however late -- its outcome is what actually
    // matters, not how many skips piled up while waiting for it. A late success means the tick
    // was merely slow, not broken, so both counters clear. A late failure only confirms what the
    // deadline already reported, so just the skip count (no longer meaningful) clears.
    void work.then(
      () => {
        inFlight = false;
        skips = 0;
        failures = 0;
      },
      () => {
        inFlight = false;
        skips = 0;
      }
    );

    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            controller.abort();
            reject(new Error(`Heartbeat exceeded its ${tickTimeoutMs}ms deadline`));
          }, tickTimeoutMs);
        }),
      ]);
      failures = 0;
      skips = 0;
    } catch (error) {
      if (!recordFailure(error)) {
        return;
      }
    } finally {
      clearTimeout(deadline);
    }

    reschedule();
  };

  return {
    start() {
      reschedule();
    },
    stop() {
      stopped = true;
      if (scheduled !== null) {
        clearScheduled(scheduled);
        scheduled = null;
      }
    },
  };
}

function buildProjectNetwork(projectId: string): string {
  return `nouva-project-${hashProjectNetwork(projectId)}`;
}

function resolveRuntimeResourceLimits(
  input: unknown,
  workload: "app" | "postgres" | "mongodb" | "redis" | "mysql"
): EffectiveServiceResourceLimits {
  const record =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const defaults =
    workload === "app"
      ? { cpuMillicores: 250, memoryBytes: 512 * 1024 * 1024, pidsLimit: 256 }
      : workload === "redis"
        ? { cpuMillicores: 250, memoryBytes: 256 * 1024 * 1024, pidsLimit: 256 }
        : { cpuMillicores: 500, memoryBytes: 1024 * 1024 * 1024, pidsLimit: 512 };

  return {
    cpuMillicores:
      typeof record.cpuMillicores === "number" ? record.cpuMillicores : defaults.cpuMillicores,
    memoryBytes: typeof record.memoryBytes === "number" ? record.memoryBytes : defaults.memoryBytes,
    // Numbers are carried through untouched so an out-of-range allowance is rejected by name in
    // toDockerResourceSettings rather than quietly repaired into a different policy here. Anything
    // else means a control plane that predates the setting, whose policy is no swap.
    ...(typeof record.memoryAndSwapBytes === "number"
      ? { memoryAndSwapBytes: record.memoryAndSwapBytes }
      : {}),
    pidsLimit: defaults.pidsLimit,
    policyVersion: 1,
  };
}

function buildLabels(input: {
  kind: string;
  projectId?: string | null;
  serviceId?: string | null;
  deploymentId?: string | null;
  serviceVariant?: string | null;
  environmentId?: string | null;
  redactionContextVersion?: string | null;
}): Record<string, string> {
  return {
    "nouva.managed": "true",
    "nouva.server.id": SERVER_ID!,
    "nouva.kind": input.kind,
    ...(input.projectId ? { "nouva.project.id": input.projectId } : {}),
    ...(input.serviceId ? { "nouva.service.id": input.serviceId } : {}),
    ...(input.deploymentId ? { "nouva.deployment.id": input.deploymentId } : {}),
    ...(input.serviceVariant ? { "nouva.service.variant": input.serviceVariant } : {}),
    ...(input.environmentId ? { "nouva.environment.id": input.environmentId } : {}),
    ...(input.redactionContextVersion
      ? { [REDACTION_CONTEXT_VERSION_DOCKER_LABEL]: input.redactionContextVersion }
      : {}),
  };
}

function getTraefikRuntimeInput(config: AgentRuntimeConfig): TraefikRuntimeInput {
  return {
    dataDir: DATA_DIR,
    dataVolume: DATA_VOLUME,
    containerName: TRAEFIK_CONTAINER_NAME,
    networkName: config.localTraefikNetwork,
    serverId: SERVER_ID!,
    image: TRAEFIK_IMAGE,
    acmeEmail: process.env.NOUVA_AGENT_TRAEFIK_ACME_EMAIL ?? null,
    trustedForwardedPeers: config.trustedForwardedPeers,
  };
}

/**
 * Per-scope redaction-context versions from the last registration or heartbeat response. Lease
 * responses replace `config` without carrying the map, so it lives outside the config object.
 */
let latestRedactionContextScopeVersions: AlloyRuntimeInput["redactionContextScopeVersions"];

function rememberRedactionContextScopeVersions(config: AgentRuntimeConfig): void {
  if (config.observability.redactionContextScopeVersions !== undefined) {
    latestRedactionContextScopeVersions = config.observability.redactionContextScopeVersions;
  }
}

function getAlloyRuntimeInput(
  credentials: StoredCredentials,
  config: AgentRuntimeConfig
): AlloyRuntimeInput {
  return {
    dataDir: DATA_DIR,
    dataVolume: DATA_VOLUME,
    serverId: SERVER_ID!,
    apiUrl: API_URL!,
    agentToken: credentials.agentToken,
    ...(config.observability.redactionContextVersion
      ? { redactionContextVersion: config.observability.redactionContextVersion }
      : {}),
    ...(latestRedactionContextScopeVersions
      ? { redactionContextScopeVersions: latestRedactionContextScopeVersions }
      : {}),
    config,
  };
}

function resolveBuildkitPort(address: string): number {
  try {
    const parsed = new URL(address);
    if (parsed.protocol !== "tcp:") {
      throw new Error("unsupported protocol");
    }

    const port = Number.parseInt(parsed.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("invalid port");
    }

    return port;
  } catch {
    return DEFAULT_BUILDKIT_PORT;
  }
}

function buildScopedBuildkitContainerName(deploymentId: string): string {
  const sanitized = deploymentId.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  const suffix = sanitized.slice(0, 24) || "build";
  return `nouva-buildkitd-${suffix}`;
}

/**
 * Keyed by service, not by deployment: consecutive pushes of the same service reuse the cache,
 * while two services building at once never share a BuildKit state directory.
 */
export function buildBuildkitCacheVolumeName(serviceId: string): string {
  const sanitized = serviceId.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  const suffix = sanitized.slice(0, 32) || "shared";
  return `${BUILDKIT_CACHE_VOLUME_PREFIX}${suffix}`;
}

function createBuildkitAddress(port: number): string {
  return `tcp://127.0.0.1:${port}`;
}

async function allocateAvailableLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        server.close();
        reject(new Error("Failed to allocate a local TCP port for BuildKit"));
        return;
      }

      server.close((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

async function waitForBuildkitAvailability(address: string, timeoutMs = 15_000): Promise<void> {
  const port = resolveBuildkitPort(address);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await checkTcpConnect("127.0.0.1", port, 500)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`BuildKit did not become ready at ${address} within ${timeoutMs}ms`);
}

async function waitForLocalRegistryAvailability(
  config: Pick<AgentRuntimeConfig, "localRegistryPort">,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.localRegistryPort}/v2/`);
      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Local registry did not become ready on 127.0.0.1:${config.localRegistryPort} within ${timeoutMs}ms`
  );
}

function buildBuildkitContainerSpec(options: {
  name: string;
  port: number;
  resourceLimits: EffectiveServiceResourceLimits;
  restartPolicyName: "no" | "unless-stopped";
  deploymentId?: string | null;
  serviceId?: string | null;
  cacheVolumeName?: string | null;
}): DockerContainerSpec {
  return {
    name: options.name,
    image: BUILDKIT_IMAGE,
    cmd: [
      "--addr",
      `tcp://0.0.0.0:${options.port}`,
      // A persistent state directory has to be bounded, or the cache that makes builds fast fills
      // the customer's disk instead (#184).
      "--oci-worker-gc",
      "--oci-worker-gc-keepstorage",
      BUILDKIT_GC_KEEP_STORAGE,
    ],
    labels: buildLabels({
      kind: "buildkit",
      deploymentId: options.deploymentId ?? null,
      serviceId: options.serviceId ?? null,
    }),
    hostConfig: {
      Privileged: true,
      NetworkMode: "host",
      RestartPolicy: {
        Name: options.restartPolicyName,
      },
      ...(options.cacheVolumeName
        ? { Binds: [`${options.cacheVolumeName}:${BUILDKIT_STATE_PATH}`] }
        : {}),
      ...toDockerResourceSettings(options.resourceLimits),
    },
  };
}

/**
 * Resource limits for a scoped BuildKit daemon.
 *
 * These come from the control plane's build reserve policy rather than a second set of constants
 * here: the agent used to grant BuildKit a 1 GiB floor against a 256 MiB reserve, so on a 2 GB host
 * the control plane offered memory a builder could already claim (#182).
 */
function getBuildkitResourceLimits(): EffectiveServiceResourceLimits {
  const reserve = calculateBuildReserve({
    cpuMillicores: os.cpus().length * 1000,
    memoryBytes: os.totalmem(),
  });

  return {
    cpuMillicores: reserve.cpuMillicores,
    memoryBytes: reserve.memoryBytes,
    // No swap allowance: the build reserve is a physical-RAM reserve the control plane hands out,
    // so letting a builder spill past it would overcommit memory the capacity maths already spent.
    pidsLimit: 512,
    policyVersion: 1,
  };
}

/**
 * Every build runs against its own scoped daemon, because a daemon has to carry the deploying
 * service's resource limits and the control plane always sends them. The long-lived
 * `nouva-buildkitd` container therefore never built anything — it sat at 0% CPU holding a cache
 * nothing read (#184). What is worth doing up front is having the image on disk, so the first build
 * of a fresh server does not pay for the pull, and so a Docker or registry problem surfaces during
 * validation rather than mid-deploy.
 */
async function ensureBuildkitImage(
  docker: Pick<DockerApiClient, "pullImage" | "inspectContainer" | "removeContainer">
): Promise<void> {
  if (await docker.inspectContainer(BUILDKIT_CONTAINER_NAME)) {
    await docker.removeContainer(BUILDKIT_CONTAINER_NAME, true);
  }

  await docker.pullImage(BUILDKIT_IMAGE);
}

async function ensureLocalRegistryRuntime(
  docker: Pick<DockerApiClient, "ensureContainer">,
  config: Pick<AgentRuntimeConfig, "localRegistryPort">
): Promise<void> {
  await docker.ensureContainer({
    name: LOCAL_REGISTRY_CONTAINER_NAME,
    image: "registry:2",
    labels: buildLabels({ kind: "registry" }),
    exposedPorts: {
      "5000/tcp": {},
    },
    hostConfig: {
      PortBindings: {
        "5000/tcp": [
          {
            HostIp: "127.0.0.1",
            HostPort: String(config.localRegistryPort),
          },
        ],
      },
      RestartPolicy: {
        Name: "unless-stopped",
      },
    },
  });
  await waitForLocalRegistryAvailability(config);
}

export interface PreparedAppBuildkitRuntime extends AppBuildkitRuntime {
  cleanup: () => Promise<void>;
}

export async function prepareAppBuildkitRuntime(
  docker: Pick<DockerApiClient, "ensureContainer" | "removeContainer" | "createVolume">,
  payload: Pick<AppDeployPayload, "deploymentId" | "resourceLimits" | "serviceId">,
  options: {
    allocatePort?: () => Promise<number>;
    waitUntilReady?: (address: string) => Promise<void>;
  } = {}
): Promise<PreparedAppBuildkitRuntime> {
  const port = await (options.allocatePort ?? allocateAvailableLocalPort)();
  const containerName = buildScopedBuildkitContainerName(payload.deploymentId);
  const cacheVolumeName = buildBuildkitCacheVolumeName(payload.serviceId);
  const address = createBuildkitAddress(port);
  const resourceLimits = getBuildkitResourceLimits();

  // The cache outlives the container that fills it, so it is a named volume the container-scoped
  // sweep below cannot touch. It is deliberately not labelled `nouva.volume.id`: it is agent
  // infrastructure, not a customer volume, and must stay out of the storage allowance (#184).
  await docker.createVolume(
    cacheVolumeName,
    buildLabels({ kind: "buildkit-cache", serviceId: payload.serviceId })
  );

  try {
    await docker.ensureContainer(
      buildBuildkitContainerSpec({
        name: containerName,
        port,
        resourceLimits,
        restartPolicyName: "no",
        deploymentId: payload.deploymentId,
        serviceId: payload.serviceId,
        cacheVolumeName,
      }),
      true
    );
    await (options.waitUntilReady ?? waitForBuildkitAvailability)(address);
  } catch (error) {
    // The scoped container is single-use; any anonymous volume it picked up has no reuse value and
    // must be swept alongside it, or it leaks on every build (#142). The named cache volume is not
    // anonymous, so `docker rm -v` leaves it alone.
    await docker.removeContainer(containerName, true);
    throw error;
  }

  return {
    address,
    memoryBytes: resourceLimits.memoryBytes,
    cleanup: async () => {
      await docker.removeContainer(containerName, true);
    },
  };
}

type PgBackrestInfoBackup = {
  label: string;
  type: "full" | "diff" | "incr";
  stopAt: string | null;
  annotationBackupId: string | null;
};

function parsePgBackrestInfo(raw: string): PgBackrestInfoBackup[] {
  const decoded = JSON.parse(raw) as unknown;
  if (!Array.isArray(decoded) || decoded.length === 0) {
    return [];
  }

  const stanza = decoded[0];
  const backups =
    stanza && typeof stanza === "object" && "backup" in stanza && Array.isArray(stanza.backup)
      ? stanza.backup
      : [];

  return backups
    .map((entry: unknown): PgBackrestInfoBackup | null => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const label = "label" in entry && typeof entry.label === "string" ? entry.label : null;
      const type = "type" in entry && typeof entry.type === "string" ? entry.type : null;
      if (!label || (type !== "full" && type !== "diff" && type !== "incr")) {
        return null;
      }

      const stopTimestamp =
        "timestamp" in entry &&
        entry.timestamp &&
        typeof entry.timestamp === "object" &&
        "stop" in entry.timestamp &&
        typeof entry.timestamp.stop === "number"
          ? entry.timestamp.stop
          : null;
      const annotationBackupId =
        "annotation" in entry &&
        entry.annotation &&
        typeof entry.annotation === "object" &&
        "nouva-backup-id" in entry.annotation &&
        typeof entry.annotation["nouva-backup-id"] === "string"
          ? entry.annotation["nouva-backup-id"]
          : null;

      return {
        label,
        type,
        stopAt: stopTimestamp ? new Date(stopTimestamp * 1000).toISOString() : null,
        annotationBackupId,
      };
    })
    .filter((entry: PgBackrestInfoBackup | null): entry is PgBackrestInfoBackup => entry !== null)
    .sort((left: PgBackrestInfoBackup, right: PgBackrestInfoBackup) => {
      const leftStopAt = left.stopAt ? Date.parse(left.stopAt) : Number.NEGATIVE_INFINITY;
      const rightStopAt = right.stopAt ? Date.parse(right.stopAt) : Number.NEGATIVE_INFINITY;
      return rightStopAt - leftStopAt;
    });
}

function selectCurrentPgBackrestEntry(
  entries: PgBackrestInfoBackup[],
  backupId: string,
  backupType: "full" | "incr"
): PgBackrestInfoBackup | null {
  const byAnnotation = entries.find((entry) => entry.annotationBackupId === backupId);
  if (byAnnotation) {
    return byAnnotation;
  }

  const byType = entries.find((entry) => entry.type === backupType);
  if (byType) {
    return byType;
  }

  return entries[0] ?? null;
}

function extractPrefixedLogLine(logs: string, prefix: string): string | null {
  const lines = logs.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.startsWith(prefix)) {
      return line.slice(prefix.length);
    }
  }

  return null;
}

function buildPgBackrestRestoreAndPromoteScript() {
  return [
    "set -eu",
    'mkdir -p "$NOUVA_DATA_PATH" "' +
      "$" +
      "{POSTGRES_SOCKET_DIR:-/var/lib/postgresql/.sockets}" +
      '" /var/run/postgresql',
    'chown -R 999:999 "$NOUVA_DATA_PATH" || true',
    "if [ -x /nouva/generate_config.sh ]; then /nouva/generate_config.sh; fi",
    `case "\${RESTORE_TYPE:-time}" in`,
    "  immediate)",
    `    if [ -z "\${RESTORE_SET:-}" ]; then echo "Immediate restore requires RESTORE_SET" >&2; exit 1; fi`,
    '    pgbackrest --stanza="$PGBACKREST_STANZA" --set="$RESTORE_SET" --delta --type=immediate --target-action=promote --log-level-console=info restore',
    "    ;;",
    "  time)",
    `    if [ -z "\${RESTORE_TARGET:-}" ]; then echo "Time restore requires RESTORE_TARGET" >&2; exit 1; fi`,
    `    if [ -n "\${RESTORE_SET:-}" ]; then`,
    '      pgbackrest --stanza="$PGBACKREST_STANZA" --set="$RESTORE_SET" --delta --type=time --target="$RESTORE_TARGET" --target-timeline=current --target-action=promote --log-level-console=info restore',
    "    else",
    '      pgbackrest --stanza="$PGBACKREST_STANZA" --delta --type=time --target="$RESTORE_TARGET" --target-timeline=current --target-action=promote --log-level-console=info restore',
    "    fi",
    "    ;;",
    "  *)",
    '    echo "Unsupported RESTORE_TYPE: $RESTORE_TYPE" >&2',
    "    exit 1",
    "    ;;",
    "esac",
    'export PGHOST="' + "$" + "{POSTGRES_SOCKET_DIR:-/var/lib/postgresql/.sockets}" + '"',
    'export PGPORT="' + "$" + "{POSTGRES_PORT:-5433}" + '"',
    'export NOUVA_PROMOTE_DB="' + "$" + "{POSTGRES_DB:-postgres}" + '"',
    'export NOUVA_PROMOTE_USER="' + "$" + "{POSTGRES_USER:-postgres}" + '"',
    'if [ -n "' +
      "$" +
      "{POSTGRES_PASSWORD:-}" +
      '" ]; then export PGPASSWORD="' +
      "$" +
      "{POSTGRES_PASSWORD}" +
      '"; fi',
    "/nouva/entrypoint.sh &",
    'entrypoint_pid="$!"',
    "cleanup() {",
    '  if kill -0 "$entrypoint_pid" 2>/dev/null; then',
    '    kill -TERM "$entrypoint_pid" || true',
    '    wait "$entrypoint_pid" || true',
    "  fi",
    "}",
    "trap cleanup EXIT INT TERM",
    "for i in $(seq 1 180); do",
    '  recovery_state=$(psql -h "$PGHOST" -p "$PGPORT" -U "$NOUVA_PROMOTE_USER" -d "$NOUVA_PROMOTE_DB" -Atqc "select case when pg_is_in_recovery() then \'t\' else \'f\' end" 2>/dev/null || true)',
    '  if [ "$recovery_state" = "f" ]; then',
    '    psql -h "$PGHOST" -p "$PGPORT" -U "$NOUVA_PROMOTE_USER" -d "$NOUVA_PROMOTE_DB" -c "checkpoint" >/dev/null 2>&1 || true',
    "    exit 0",
    "  fi",
    '  if ! kill -0 "$entrypoint_pid" 2>/dev/null; then',
    '    wait "$entrypoint_pid"',
    "  fi",
    "  sleep 1",
    '  if [ "$i" -eq 180 ]; then',
    '    echo "Restored Postgres did not promote within 180 seconds" >&2',
    "    exit 1",
    "  fi",
    "done",
  ].join("\n");
}

async function runTaskContainer(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  options: {
    name: string;
    image: string;
    env?: string[];
    entrypoint?: string[];
    cmd: string[];
    mounts?: Array<{ source: string; target: string; readOnly?: boolean }>;
    networkMode?: string;
    timeoutMs?: number;
    /** Skipped for images the caller just pulled, so repeated probes stay off the registry. */
    pull?: boolean;
  }
): Promise<{ logs: string }> {
  if (options.pull !== false) {
    await docker.pullImage(options.image, resolveRegistryAuthForImage(config, options.image));
  }
  await docker.removeContainer(options.name, true);

  const id = await docker.createContainer({
    name: options.name,
    image: options.image,
    env: options.env,
    entrypoint: options.entrypoint,
    cmd: options.cmd,
    tty: true,
    labels: buildLabels({ kind: "task" }),
    hostConfig: {
      AutoRemove: false,
      NetworkMode: options.networkMode,
      Mounts: options.mounts?.map((mount) => ({
        Type: "volume",
        Source: mount.source,
        Target: mount.target,
        ReadOnly: mount.readOnly === true,
      })),
    },
  });

  try {
    await docker.startContainer(id);
    const statusCode = await docker.waitContainer(id, options.timeoutMs);
    const logs = await docker.containerLogs(id).catch(() => "");
    if (statusCode !== 0) {
      throw new Error(logs.trim() || `Task container ${options.name} failed (${statusCode})`);
    }

    return { logs };
  } finally {
    await docker.removeContainer(id, true);
  }
}

// The S3 destination is configured through RCLONE_CONFIG_* environment variables (see
// buildArchiveDestinationEnv) instead of an inline connection string. Connection-string values
// that contain ":" or "," (every https:// endpoint does) must be quoted for rclone, and an
// inline string also leaks the access keys into the rclone process arguments.
function buildArchiveRemoteExpression(): string {
  return `${ARCHIVE_RCLONE_REMOTE}:\${BACKUP_BUCKET}/\${BACKUP_OBJECT_KEY}`;
}

async function ensureBaseRuntime(
  docker: DockerApiClient,
  config: AgentRuntimeConfig
): Promise<void> {
  await ensureTraefikRuntimeSerialized(docker, getTraefikRuntimeInput(config));
  await ensureBuildkitImage(docker);
  if (config.imageStoreMode === "local-registry") {
    await ensureLocalRegistryRuntime(docker, config);
  }
}

function resolveAppPort(
  payloadEnvVars: Record<string, string>,
  metadataPort: number | null
): number {
  const envPort = Number(payloadEnvVars.PORT);
  if (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535) {
    return envPort;
  }

  if (
    metadataPort &&
    Number.isInteger(metadataPort) &&
    metadataPort >= 1 &&
    metadataPort <= 65535
  ) {
    return metadataPort;
  }

  return 3000;
}

export function buildAppContainerSpec(
  _config: AgentRuntimeConfig,
  payload: DeployAppImageInput
): {
  containerName: string;
  appPort: number;
  spec: DockerContainerSpec;
} {
  const containerName = `nouva-app-${payload.serviceId.slice(0, 8)}-${payload.deploymentId.slice(0, 8)}`;
  const appPort = resolveAppPort(payload.envVars, payload.internalPort ?? null);

  return {
    containerName,
    appPort,
    spec: {
      name: containerName,
      image: payload.imageUrl,
      // Always pin PORT to the value the agent resolved and will probe/route to (#152) — otherwise
      // a build (e.g. a Railpack static/Vite app) that never sets PORT falls back to its own
      // runtime default, which can differ from resolveAppPort's fallback and the app never
      // becomes reachable on the port the agent thinks it's listening on.
      env: Object.entries({ ...payload.envVars, PORT: String(appPort) }).map(
        ([key, value]) => `${key}=${value}`
      ),
      labels: buildLabels({
        kind: "app",
        projectId: payload.projectId,
        environmentId: payload.environmentId ?? null,
        serviceId: payload.serviceId,
        deploymentId: payload.deploymentId,
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
        RestartPolicy: {
          Name: "unless-stopped",
        },
        ...toDockerResourceSettings(resolveRuntimeResourceLimits(payload.resourceLimits, "app")),
      },
      networkingConfig: {
        EndpointsConfig: {
          [buildProjectNetwork(payload.projectId)]: {},
        },
      },
    },
  };
}

function buildAppVolumeSnapshotName(payload: DeployAppImageInput): string {
  return `${payload.serviceId}-${payload.deploymentId}.tar.gz`;
}

async function assertSingleRunningVolumeConsumer(
  docker: DockerApiClient,
  volumeName: string,
  expectedContainer: string | null
): Promise<void> {
  const consumers = await docker.listContainersUsingVolume(volumeName);
  const running = consumers.filter((container) => container.State?.Running);
  const unexpected = running.filter(
    (container) =>
      !expectedContainer ||
      (container.Id !== expectedContainer &&
        container.Name.replace(/^\//, "") !== expectedContainer)
  );
  if (unexpected.length > 0 || running.length > (expectedContainer ? 1 : 0)) {
    throw new Error(`Volume ${volumeName} has another running consumer`);
  }
}

async function createAppVolumeSnapshot(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: DeployAppImageInput
): Promise<string> {
  if (!payload.volume) {
    throw new Error("App volume snapshot requires a volume");
  }
  const snapshotName = buildAppVolumeSnapshotName(payload);
  await docker.createVolume(DATA_VOLUME);
  await runTaskContainer(docker, config, {
    name: `nouva-app-snapshot-${payload.deploymentId.slice(0, 12)}`,
    image: APP_VOLUME_SNAPSHOT_IMAGE,
    entrypoint: ["/bin/sh", "-ec"],
    cmd: [
      [
        "mkdir -p /agent-data/app-volume-snapshots",
        `final=/agent-data/app-volume-snapshots/${snapshotName}`,
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
    ],
    mounts: [
      { source: payload.volume.volumeName, target: "/source", readOnly: true },
      { source: DATA_VOLUME, target: "/agent-data" },
    ],
  });
  return snapshotName;
}

async function restoreAppVolumeSnapshot(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: DeployAppImageInput,
  snapshotName: string
): Promise<void> {
  if (!payload.volume) {
    throw new Error("App volume restore requires a volume");
  }
  await runTaskContainer(docker, config, {
    name: `nouva-app-restore-${payload.deploymentId.slice(0, 12)}`,
    image: APP_VOLUME_SNAPSHOT_IMAGE,
    entrypoint: ["/bin/sh", "-ec"],
    cmd: [
      [
        `archive=/agent-data/app-volume-snapshots/${snapshotName}`,
        'test -s "$archive"',
        "find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +",
        'tar -C /target -xzpf "$archive"',
      ].join("\n"),
    ],
    mounts: [
      { source: payload.volume.volumeName, target: "/target" },
      { source: DATA_VOLUME, target: "/agent-data", readOnly: true },
    ],
  });
}

async function deleteAppVolumeSnapshot(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: DeployAppImageInput,
  snapshotName: string
): Promise<void> {
  await runTaskContainer(docker, config, {
    name: `nouva-app-snapshot-cleanup-${payload.deploymentId.slice(0, 12)}`,
    image: APP_VOLUME_SNAPSHOT_IMAGE,
    entrypoint: ["/bin/sh", "-ec"],
    cmd: [[`rm -f /agent-data/app-volume-snapshots/${snapshotName}`].join("\n")],
    mounts: [{ source: DATA_VOLUME, target: "/agent-data" }],
  });
}

async function deleteAppVolumeSnapshotBestEffort(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: DeployAppImageInput,
  snapshotName: string
): Promise<void> {
  try {
    await deleteAppVolumeSnapshot(docker, config, payload, snapshotName);
  } catch (error) {
    console.warn(`Failed to clean app volume snapshot ${snapshotName}`, error);
  }
}

async function appCandidateMountsMatch(
  docker: DockerApiClient,
  candidate: DockerContainerInspection,
  volume: DeployAppImageInput["volume"]
): Promise<boolean> {
  const mounts = candidate.Mounts ?? [];
  const isPlatformVolume = (mount: (typeof mounts)[number]) =>
    Boolean(
      volume &&
        mount.Type === "volume" &&
        mount.Name === volume.volumeName &&
        mount.Destination === volume.mountPath
    );
  if (volume && !mounts.some(isPlatformVolume)) return false;
  const extraMounts = mounts.filter((mount) => !isPlatformVolume(mount));
  if (extraMounts.length === 0) return true;

  // Docker materializes image VOLUME declarations without HostConfig mounts. Use the
  // candidate's immutable image, not a tag that may have moved since its first attempt.
  // Fail closed without this evidence; a generated-looking name alone proves nothing.
  const image = candidate.Image ? await docker.inspectImage(candidate.Image) : null;
  const declaredVolumes = image?.Config?.Volumes;
  if (
    !declaredVolumes ||
    !candidate.HostConfig ||
    candidate.HostConfig.Binds?.length ||
    candidate.HostConfig.VolumesFrom?.length
  )
    return false;
  for (const mount of extraMounts) {
    if (
      mount.Type !== "volume" ||
      !mount.Name ||
      !/^[a-f0-9]{64}$/.test(mount.Name) ||
      !mount.Destination ||
      !Object.hasOwn(declaredVolumes, mount.Destination) ||
      mount.Destination === volume?.mountPath ||
      candidate.HostConfig?.Mounts?.some((configured) => configured.Target === mount.Destination)
    )
      return false;
    const inspectedVolume = await docker.inspectVolume(mount.Name);
    const labels = inspectedVolume?.Labels;
    if (
      !inspectedVolume ||
      inspectedVolume.Name !== mount.Name ||
      (labels !== null &&
        labels !== undefined &&
        (typeof labels !== "object" ||
          Object.hasOwn(labels, "nouva.managed") ||
          Object.hasOwn(labels, "nouva.volume.id")))
    )
      return false;
  }
  return true;
}

/**
 * Runs the pre-activation phase, which comes before anything live is touched. However it stops —
 * the job did not succeed, or Docker or the control plane failed under it — the error carries
 * `rollout`, so the failure is recorded without marking the deployment still serving as failed.
 * A deferral passes through as it is: the work goes back to the queue rather than failing.
 */
export async function runPreActivation(
  releasePhases: ReleasePhaseRunner,
  target: ReleaseJobTarget,
  request: ReleasePhaseRequest,
  rollout: AppRolloutResult | { liveRuntimePreserved: boolean }
): Promise<void> {
  let result: ReleasePhaseResult;
  try {
    result = await releasePhases.run(target, request);
  } catch (error) {
    if (error instanceof ReleaseJobDeferredError) {
      throw error;
    }
    throw new ReleaseJobHaltError(
      error instanceof Error ? error.message : "The pre-activation job could not be run",
      rollout
    );
  }
  if (result.kind === "unsuccessful") {
    throw new ReleaseJobHaltError(result.message, rollout);
  }
}

/**
 * A verification that could not be carried through — Docker or the control plane failed under it —
 * has an unknown outcome, and an unknown outcome keeps the new deployment. Failing the work instead
 * would roll traffic back over something nobody observed. The attempt stays `running` in the
 * control plane, which settles it as unknown when the deployment completes.
 */
async function runVerificationKeepingOnError(
  releasePhases: ReleasePhaseRunner,
  target: ReleaseJobTarget,
  request: ReleasePhaseRequest
): Promise<ReleasePhaseResult | { kind: "interrupted" }> {
  try {
    return await releasePhases.run(target, request);
  } catch (error) {
    console.error(
      `[nouva-agent] verification of deployment ${target.deploymentId} was interrupted; keeping it`,
      target.redactLogLine(error instanceof Error ? error.message : "unknown error")
    );
    return { kind: "interrupted" };
  }
}

/**
 * Whether the previous app container could take traffic back right now, judged by the same
 * readiness check a candidate must pass before cutover.
 */
async function previousAppRuntimeCanServe(
  dependencies: Pick<DeployAppImageDependencies, "checkTcpConnect">,
  docker: Pick<DockerApiClient, "inspectContainer">,
  containerName: string,
  appPort: number,
  rollout: AppRolloutConfig
): Promise<boolean> {
  try {
    await waitForAppCandidateReadiness(dependencies, docker, containerName, appPort, rollout);
    return true;
  } catch (error) {
    // Not serving is the answer, not a failure: the new deployment keeps the traffic instead.
    console.warn(
      `[nouva-agent] previous container ${containerName} cannot take traffic back`,
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

/** Points the service's route at `serviceUrl`; whether Traefik confirmed it serves from there. */
async function moveAppTraffic(
  dependencies: Pick<DeployAppImageDependencies, "fetchImpl" | "writeLocalTraefikRoute">,
  serviceId: string,
  hostnames: { providedHostname: string; customHostnames: string[] },
  serviceUrl: string,
  rollout: AppRolloutConfig
): Promise<boolean> {
  try {
    await dependencies.writeLocalTraefikRoute(TRAEFIK_PATHS, serviceId, hostnames, serviceUrl);
    await waitForLocalTraefikCutover(dependencies.fetchImpl, serviceId, serviceUrl, rollout);
    return true;
  } catch (error) {
    // Reported as a boolean: the caller decides which release keeps the traffic instead.
    console.warn(
      `[nouva-agent] could not move traffic of service ${serviceId} to ${serviceUrl}`,
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

/**
 * Finishes the rollback an earlier run of this deployment reported after its verification failed:
 * only that run's final report was lost, and it may have stopped anywhere between reporting and
 * removing its candidate. Traffic goes to the previous deployment and a still running candidate is
 * removed, so the release is never served again. Whether the candidate is alive says nothing about
 * why, so the previous deployment is probed directly. When it cannot serve, or traffic cannot be
 * moved to it, `false` leaves the deploy to go ahead and keep the new release, as the earlier run
 * would have.
 */
async function returnTrafficFromRejectedRelease(
  dependencies: Pick<
    DeployAppImageDependencies,
    "checkTcpConnect" | "fetchImpl" | "writeLocalTraefikRoute"
  >,
  docker: Pick<DockerApiClient, "inspectContainer" | "removeContainer">,
  input: {
    serviceId: string;
    hostnames: { providedHostname: string; customHostnames: string[] };
    previousContainer: string;
    previousServiceUrl: string;
    previousPort: number;
    candidateContainerName: string | null;
    rollout: AppRolloutConfig;
  }
): Promise<boolean> {
  const previousCanServe = await previousAppRuntimeCanServe(
    dependencies,
    docker,
    input.previousContainer,
    input.previousPort,
    input.rollout
  );
  if (
    !previousCanServe ||
    !(await moveAppTraffic(
      dependencies,
      input.serviceId,
      input.hostnames,
      input.previousServiceUrl,
      input.rollout
    ))
  ) {
    return false;
  }
  if (input.candidateContainerName) {
    try {
      await docker.removeContainer(input.candidateContainerName, true);
    } catch (error) {
      // Traffic has already left it; an idle container is left for a later sweep rather than
      // letting the rejected release go ahead.
      console.warn(
        `[nouva-agent] could not remove rejected candidate ${input.candidateContainerName}`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return true;
}

/** The one-off container a release phase of this deployment runs in; see `release-jobs.ts`. */
function buildReleaseJobTarget(
  docker: Pick<DockerApiClient, "inspectImage" | "pullImage">,
  input: {
    projectId: string;
    environmentId?: string | null;
    serviceId: string;
    deploymentId: string;
    redactionContextVersion?: string;
    image: string;
    pullImage: boolean;
    envVars: Record<string, string>;
    platformGeneratedValues?: readonly string[];
    resourceSettings: DockerResourceSettings;
  }
): ReleaseJobTarget {
  return {
    serviceId: input.serviceId,
    deploymentId: input.deploymentId,
    image: input.image,
    networkName: buildProjectNetwork(input.projectId),
    envVars: input.envVars,
    labels: buildLabels({
      kind: "release_job",
      projectId: input.projectId,
      environmentId: input.environmentId ?? null,
      serviceId: input.serviceId,
      deploymentId: input.deploymentId,
      redactionContextVersion: input.redactionContextVersion,
    }),
    resourceSettings: input.resourceSettings,
    redactLogLine: createBuildLogRedactor(input.envVars, input.platformGeneratedValues ?? []),
    prepareImage: async () => {
      if (!(await docker.inspectImage(input.image))) {
        if (!input.pullImage) {
          throw new Error(`Docker image ${input.image} is not present locally`);
        }
        await docker.pullImage(input.image);
      }
    },
  };
}

export async function deployAppImageWithDependencies(
  dependencies: DeployAppImageDependencies,
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: DeployAppImageInput,
  releasePhases?: ReleasePhaseRunner
) {
  await dependencies.ensureBaseRuntime(docker, config);

  const projectNetwork = buildProjectNetwork(payload.projectId);
  await docker.ensureNetwork(projectNetwork, {
    "nouva.managed": "true",
    "nouva.server.id": SERVER_ID!,
    "nouva.project.id": payload.projectId,
  });
  await docker.connectNetwork(projectNetwork, TRAEFIK_CONTAINER_NAME);

  const currentRuntimeImage = resolveCurrentRuntimeImage(payload.runtimeMetadata);
  const retainedPreviousImage = resolvePreviousRuntimeImage(payload.runtimeMetadata);
  let previousContainer =
    payload.runtimeMetadata?.containerName ?? payload.runtimeMetadata?.containerId ?? null;
  const { containerName, appPort, spec } = buildAppContainerSpec(config, payload);
  // A prior process may have finished Docker cutover without delivering its completion.
  // Check all names, not only ownership labels: never replace a conflicting unmanaged container.
  const existingCandidate = (await docker.listContainersByLabels({})).find(
    (container) => container.Name.replace(/^\//, "") === containerName
  );
  if (existingCandidate) {
    const labels = existingCandidate.Config?.Labels;
    if (
      labels?.["nouva.managed"] !== "true" ||
      labels["nouva.service.id"] !== payload.serviceId ||
      labels["nouva.deployment.id"] !== payload.deploymentId ||
      existingCandidate.Config?.Image !== payload.imageUrl ||
      !(await appCandidateMountsMatch(docker, existingCandidate, payload.volume))
    ) {
      throw new Error(
        "Existing app candidate does not match deployment ownership or configuration"
      );
    }
    if (
      previousContainer === containerName ||
      previousContainer === existingCandidate.Id ||
      previousContainer === existingCandidate.Name
    )
      previousContainer = null;
    if (previousContainer && !(await docker.inspectContainer(previousContainer)))
      previousContainer = null;
    if (existingCandidate.State?.Running) {
      if (payload.volume)
        await assertSingleRunningVolumeConsumer(
          docker,
          payload.volume.volumeName,
          existingCandidate.Id
        );
    } else {
      await docker.removeContainer(existingCandidate.Id, true);
      await verifyContainerAbsent(docker, existingCandidate.Id);
      if (payload.volume)
        await assertSingleRunningVolumeConsumer(
          docker,
          payload.volume.volumeName,
          previousContainer
        );
    }
  }
  const adoptedCandidate = existingCandidate?.State?.Running ? existingCandidate : null;
  const previousServiceUrl = previousContainer
    ? `http://${previousContainer}:${resolveAppRuntimePort(payload.runtimeMetadata, appPort)}`
    : null;
  const rollout = resolveAppRolloutConfig(payload.rollout);
  const rolloutStrategy = payload.volume
    ? "single_writer_snapshot_cutover"
    : "candidate_ready_cutover";
  const dockerLocalImages = isDockerLocalImageStore(config.imageStoreMode);
  let resolvedImageId = payload.imageId ?? null;
  let snapshotName: string | null = null;
  let volumeRolloutPhase: AppRolloutResult["currentPhase"] = "quiesce";

  if (dockerLocalImages && !resolvedImageId) {
    resolvedImageId = (await docker.inspectImage(payload.imageUrl))?.Id ?? null;
  }

  const releaseJobs = releasePhases ? (payload.releaseJobs ?? null) : null;
  const releaseTarget = releaseJobs
    ? buildReleaseJobTarget(docker, {
        ...payload,
        image: payload.imageUrl,
        pullImage: !dockerLocalImages,
        // Exactly what the candidate container is given, PORT included.
        envVars: { ...payload.envVars, PORT: String(appPort) },
        resourceSettings: toDockerResourceSettings(
          resolveRuntimeResourceLimits(payload.resourceLimits, "app")
        ),
      })
    : null;
  const providedHostname = payload.providedHostname ?? `${payload.subdomain}.${APP_DOMAIN}`;
  const customHostnames = payload.customHostnames ?? [];
  if (
    releasePhases &&
    releaseJobs?.verificationRolledBack &&
    previousContainer &&
    previousServiceUrl &&
    (await returnTrafficFromRejectedRelease(dependencies, docker, {
      serviceId: payload.serviceId,
      hostnames: { providedHostname, customHostnames },
      previousContainer,
      previousServiceUrl,
      previousPort: resolveAppRuntimePort(payload.runtimeMetadata, appPort),
      candidateContainerName: adoptedCandidate ? containerName : null,
      rollout,
    }))
  ) {
    throw new ReleaseJobHaltError(
      "Verification of this deployment already failed and traffic was returned to the previous deployment; it is not activated again",
      buildAppRolloutResult({
        strategy: rolloutStrategy,
        outcome: "aborted_before_cutover",
        currentPhase: "release",
        liveRuntimePreserved: true,
        rollbackCompleted: true,
        activeContainerName: previousContainer,
        candidateContainerName: containerName,
      })
    );
  }
  if (releasePhases && releaseTarget && releaseJobs?.preActivation) {
    // Before anything is quiesced or created: a failed job leaves the live deployment untouched.
    await runPreActivation(
      releasePhases,
      releaseTarget,
      {
        phase: "pre_activation",
        command: releaseJobs.preActivation.command,
        timeoutSeconds: releaseJobs.preActivation.timeoutSeconds,
      },
      buildAppRolloutResult({
        strategy: rolloutStrategy,
        outcome: "aborted_before_cutover",
        currentPhase: "release",
        liveRuntimePreserved: Boolean(previousContainer) || adoptedCandidate !== null,
        rollbackCompleted: false,
        activeContainerName: adoptedCandidate ? containerName : previousContainer,
        candidateContainerName: containerName,
      })
    );
  }

  if (payload.volume && !adoptedCandidate) {
    await docker.createVolume(
      payload.volume.volumeName,
      buildManagedVolumeLabels({
        volumeId: payload.volume.volumeId,
        projectId: payload.projectId,
        serviceId: payload.serviceId,
      })
    );
    try {
      await assertSingleRunningVolumeConsumer(docker, payload.volume.volumeName, previousContainer);
      if (previousContainer) {
        await docker.stopContainer(previousContainer);
      }
      await assertSingleRunningVolumeConsumer(docker, payload.volume.volumeName, null);
      volumeRolloutPhase = "snapshot";
      snapshotName = await createAppVolumeSnapshot(docker, config, payload);
    } catch (error) {
      let liveRuntimePreserved = false;
      if (previousContainer) {
        try {
          await assertSingleRunningVolumeConsumer(docker, payload.volume.volumeName, null);
          await docker.startContainer(previousContainer);
          await waitForAppCandidateReadiness(
            dependencies,
            docker,
            previousContainer,
            resolveAppRuntimePort(payload.runtimeMetadata, appPort),
            rollout
          );
          await dependencies.writeLocalTraefikRoute(
            TRAEFIK_PATHS,
            payload.serviceId,
            {
              providedHostname: `${payload.subdomain}.${APP_DOMAIN}`,
              customHostnames: [],
            },
            previousServiceUrl!
          );
          await waitForLocalTraefikCutover(
            dependencies.fetchImpl,
            payload.serviceId,
            previousServiceUrl!,
            rollout
          );
          liveRuntimePreserved = true;
        } catch {}
      }
      throw new AppRolloutError(
        error instanceof Error ? error.message : "App volume snapshot failed",
        buildAppRolloutResult({
          strategy: rolloutStrategy,
          outcome: "aborted_before_cutover",
          currentPhase: volumeRolloutPhase,
          liveRuntimePreserved,
          rollbackCompleted: false,
          activeContainerName: previousContainer,
          candidateContainerName: containerName,
        })
      );
    }
  }

  const containerId =
    adoptedCandidate?.Id ??
    (await docker.ensureContainer(spec, true, {
      pull: !dockerLocalImages,
    }));
  try {
    await waitForAppCandidateReadiness(dependencies, docker, containerName, appPort, rollout);
  } catch (error) {
    // This candidate can already be serving an accepted deployment; failed revalidation is not
    // permission to roll it back or restore an older volume snapshot.
    if (adoptedCandidate) throw error;
    await docker.removeContainer(containerName, true);
    if (payload.volume) await verifyContainerAbsent(docker, containerName);
    if (payload.volume && snapshotName) {
      try {
        await assertSingleRunningVolumeConsumer(docker, payload.volume.volumeName, null);
        await restoreAppVolumeSnapshot(docker, config, payload, snapshotName);
        if (previousContainer) {
          await docker.startContainer(previousContainer);
          await waitForAppCandidateReadiness(
            dependencies,
            docker,
            previousContainer,
            resolveAppRuntimePort(payload.runtimeMetadata, appPort),
            rollout
          );
          await dependencies.writeLocalTraefikRoute(
            TRAEFIK_PATHS,
            payload.serviceId,
            {
              providedHostname: `${payload.subdomain}.${APP_DOMAIN}`,
              customHostnames: [],
            },
            previousServiceUrl!
          );
          await waitForLocalTraefikCutover(
            dependencies.fetchImpl,
            payload.serviceId,
            previousServiceUrl!,
            rollout
          );
        } else {
          await dependencies.deleteLocalTraefikRoute(TRAEFIK_PATHS, payload.serviceId);
        }
        await deleteAppVolumeSnapshotBestEffort(docker, config, payload, snapshotName);
      } catch (restoreError) {
        throw new AppRolloutError(
          restoreError instanceof Error ? restoreError.message : "App volume restore failed",
          buildAppRolloutResult({
            strategy: rolloutStrategy,
            outcome: "rolled_back",
            currentPhase: "restore",
            liveRuntimePreserved: false,
            rollbackCompleted: false,
            activeContainerName: null,
            candidateContainerName: containerName,
          })
        );
      }
    }
    if (
      dockerLocalImages &&
      !shouldRetainImageReference(payload.runtimeMetadata, payload.imageUrl)
    ) {
      await docker.removeImage(payload.imageUrl, true);
    }
    throw new AppRolloutError(
      error instanceof Error ? error.message : "Candidate container failed readiness checks",
      buildAppRolloutResult({
        strategy: rolloutStrategy,
        outcome: "aborted_before_cutover",
        currentPhase: "ready",
        liveRuntimePreserved: Boolean(previousContainer),
        rollbackCompleted: false,
        activeContainerName: previousContainer,
        candidateContainerName: containerName,
      })
    );
  }

  const candidateServiceUrl = `http://${containerName}:${appPort}`;
  let trafficReturnedToPrevious = false;
  try {
    await dependencies.writeLocalTraefikRoute(
      TRAEFIK_PATHS,
      payload.serviceId,
      {
        providedHostname,
        customHostnames,
      },
      candidateServiceUrl
    );
    await waitForLocalTraefikCutover(
      dependencies.fetchImpl,
      payload.serviceId,
      candidateServiceUrl,
      rollout
    );
    if (releasePhases && releaseTarget && releaseJobs?.verification) {
      const verification = releaseJobs.verification;
      // The previous container is still running and routable until retirement below, so returning
      // traffic to it is the only thing a rollback does. A volume service's previous container was
      // stopped for the single-writer cutover, and bringing it back would restore the pre-deploy
      // snapshot, discarding what the new release wrote — so it keeps the new deployment instead.
      const rollbackTarget =
        previousContainer && adoptedCandidate === null && !payload.volume
          ? previousContainer
          : null;
      // Probed once, and only when a failure would roll back: a previous release that is gone or
      // crash-looping (often why the fix is being deployed) cannot take the traffic back.
      let previousCanServe: Promise<boolean> | null = null;
      const decide = async (outcome: ReleaseJobOutcome) => {
        const wouldRollBack =
          rollbackTarget !== null &&
          verification.onFailure === "rollback" &&
          (outcome === "failed" || outcome === "timed_out");
        if (wouldRollBack) {
          previousCanServe ??= previousAppRuntimeCanServe(
            dependencies,
            docker,
            rollbackTarget,
            resolveAppRuntimePort(payload.runtimeMetadata, appPort),
            rollout
          );
        }
        return decideVerificationConsequence({
          outcome,
          policy: verification.onFailure,
          rollbackAvailable: wouldRollBack && (await previousCanServe) === true,
        });
      };
      const result = await runVerificationKeepingOnError(releasePhases, releaseTarget, {
        phase: "verification",
        command: verification.command,
        timeoutSeconds: verification.timeoutSeconds,
        phaseEnv: { NOUVA_CANDIDATE_URL: candidateServiceUrl },
        configuredPolicy: verification.onFailure,
        resolveAppliedPolicy: async (outcome) =>
          (await decide(outcome)).action === "rollback" ? "rollback" : "keep",
      });
      // Only a rollback this run reported, which it decided with a previous runtime that just proved
      // it serves. Traffic goes back to it before the candidate is removed: should the route not
      // move, the candidate keeps serving and the deployment goes LIVE, where the control plane
      // corrects the recorded rollback to keep.
      if (
        result.kind === "unsuccessful" &&
        previousServiceUrl &&
        result.appliedPolicy === "rollback"
      ) {
        trafficReturnedToPrevious = await moveAppTraffic(
          dependencies,
          payload.serviceId,
          { providedHostname, customHostnames },
          previousServiceUrl,
          rollout
        );
        if (trafficReturnedToPrevious) {
          throw new Error(result.message);
        }
        console.warn(
          `[nouva-agent] verification of deployment ${payload.deploymentId} failed, but traffic ` +
            "could not return to the previous release; keeping the new one"
        );
        try {
          await dependencies.writeLocalTraefikRoute(
            TRAEFIK_PATHS,
            payload.serviceId,
            { providedHostname, customHostnames },
            candidateServiceUrl
          );
          await waitForLocalTraefikCutover(
            dependencies.fetchImpl,
            payload.serviceId,
            candidateServiceUrl,
            rollout
          );
        } catch (routeError) {
          // Kept out of the catch below, which would remove the candidate: it is the release most
          // likely serving now, and the route left as it is beats taking that away as well.
          console.warn(
            `[nouva-agent] could not confirm the route back to deployment ${payload.deploymentId}; ` +
              "keeping it",
            routeError
          );
        }
      }
    }
  } catch (error) {
    // This candidate can already be serving an accepted deployment; failed revalidation is not
    // permission to roll it back or restore an older volume snapshot.
    if (adoptedCandidate) throw error;
    await docker.removeContainer(containerName, true);
    if (payload.volume) await verifyContainerAbsent(docker, containerName);
    let rollbackCompleted = true;
    let liveRuntimePreserved = Boolean(previousContainer);
    if (payload.volume && snapshotName) {
      try {
        await assertSingleRunningVolumeConsumer(docker, payload.volume.volumeName, null);
        await restoreAppVolumeSnapshot(docker, config, payload, snapshotName);
        if (previousContainer) {
          await docker.startContainer(previousContainer);
          await waitForAppCandidateReadiness(
            dependencies,
            docker,
            previousContainer,
            resolveAppRuntimePort(payload.runtimeMetadata, appPort),
            rollout
          );
        }
      } catch (restoreError) {
        throw new AppRolloutError(
          restoreError instanceof Error ? restoreError.message : "App volume restore failed",
          buildAppRolloutResult({
            strategy: rolloutStrategy,
            outcome: "rolled_back",
            currentPhase: "restore",
            liveRuntimePreserved: false,
            rollbackCompleted: false,
            activeContainerName: null,
            candidateContainerName: containerName,
          })
        );
      }
    }
    try {
      if (trafficReturnedToPrevious) {
        // A failed verification already moved traffic back before the candidate was removed.
      } else if (previousServiceUrl) {
        await dependencies.writeLocalTraefikRoute(
          TRAEFIK_PATHS,
          payload.serviceId,
          {
            providedHostname,
            customHostnames,
          },
          previousServiceUrl
        );
        await waitForLocalTraefikCutover(
          dependencies.fetchImpl,
          payload.serviceId,
          previousServiceUrl,
          rollout
        );
      } else if (customHostnames.length > 0) {
        const placeholderUrl = new URL(config.clientIngressPlaceholderUrl);
        await dependencies.writeLocalTraefikRoute(
          TRAEFIK_PATHS,
          payload.serviceId,
          { providedHostname: null, customHostnames },
          placeholderUrl.origin,
          { passHostHeader: false, replacePath: placeholderUrl.pathname }
        );
      } else {
        await dependencies.deleteLocalTraefikRoute(TRAEFIK_PATHS, payload.serviceId);
      }
      if (payload.volume && snapshotName) {
        await deleteAppVolumeSnapshotBestEffort(docker, config, payload, snapshotName);
      }
    } catch {
      rollbackCompleted = false;
      liveRuntimePreserved = false;
    }
    if (
      dockerLocalImages &&
      !shouldRetainImageReference(payload.runtimeMetadata, payload.imageUrl)
    ) {
      await docker.removeImage(payload.imageUrl, true);
    }

    throw new AppRolloutError(
      error instanceof Error ? error.message : "Traefik cutover failed",
      buildAppRolloutResult({
        strategy: rolloutStrategy,
        outcome: "rolled_back",
        currentPhase: "rollback",
        liveRuntimePreserved,
        rollbackCompleted,
        activeContainerName: previousContainer,
        candidateContainerName: containerName,
      })
    );
  }

  const drainDurationMs = payload.volume ? 0 : rollout.drain.durationMs;
  const previousContainerRetirement = previousContainer
    ? await retirePreviousAppContainer(
        dependencies,
        docker,
        previousContainer,
        payload.serviceId,
        payload.deploymentId,
        rollout,
        drainDurationMs
      )
    : null;
  if (payload.volume && snapshotName) {
    await deleteAppVolumeSnapshotBestEffort(docker, config, payload, snapshotName);
  }

  const nextCurrentImage = buildRetainedRuntimeImage({
    reference: payload.imageUrl,
    imageId: resolvedImageId,
    deploymentId: payload.deploymentId,
    commitHash: payload.commitHash,
  });
  const nextPreviousImage = currentRuntimeImage ? { ...currentRuntimeImage } : null;

  if (
    dockerLocalImages &&
    retainedPreviousImage &&
    !sameRetainedRuntimeImage(retainedPreviousImage, nextPreviousImage) &&
    !sameRetainedRuntimeImage(retainedPreviousImage, nextCurrentImage)
  ) {
    await removeRetainedRuntimeImage(docker, retainedPreviousImage);
  }

  return {
    imageUrl: payload.imageUrl,
    buildDuration: payload.buildDuration ?? null,
    detectedLanguage: payload.detectedLanguage ?? null,
    detectedFramework: payload.detectedFramework ?? null,
    languageVersion: payload.languageVersion ?? null,
    internalHost: containerName,
    internalPort: appPort,
    externalHost: `${payload.subdomain}.${APP_DOMAIN}`,
    runtimeMetadata: {
      containerId,
      containerName,
      image: payload.imageUrl,
      imageStoreMode: config.imageStoreMode,
      currentImage: nextCurrentImage,
      previousImage: nextPreviousImage,
      ingressHost: `${payload.subdomain}.${APP_DOMAIN}`,
      ingressPort: 80,
      internalPort: appPort,
      networkName: projectNetwork,
      clientIngressConfigHash: payload.clientIngressConfigHash ?? null,
    },
    rollout: buildAppRolloutResult({
      strategy: rolloutStrategy,
      outcome: "committed",
      currentPhase: "retire",
      liveRuntimePreserved: false,
      rollbackCompleted: false,
      drainDurationMs: previousContainer ? drainDurationMs : 0,
      previousContainerRetirement,
      reusedCandidate: adoptedCandidate !== null,
      activeContainerName: containerName,
      candidateContainerName: containerName,
    }),
    runtimeInstance: {
      kind: "app",
      status: "running",
      name: containerName,
      image: payload.imageUrl,
      containerId,
      containerName,
      networkName: projectNetwork,
      internalHost: containerName,
      internalPort: appPort,
      externalHost: `${payload.subdomain}.${APP_DOMAIN}`,
      externalPort: 80,
    },
  };
}

export async function deployAppImage(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: DeployAppImageInput,
  releasePhases?: ReleasePhaseRunner
) {
  return await deployAppImageWithDependencies(
    defaultDeployAppImageDependencies,
    docker,
    config,
    payload,
    releasePhases
  );
}

async function handleBuildAndDeployApp(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: AppDeployPayload,
  onBuildLog?: BuildLogEmitter,
  releasePhases?: ReleasePhaseRunner
) {
  const dependencies = {
    ensureBaseRuntime,
    buildApp,
    deployAppImage,
  };

  const buildkitRuntime = await prepareAppBuildkitRuntime(docker, payload);

  try {
    return await buildAndDeployAppWithDependencies(
      dependencies,
      docker,
      config,
      payload,
      buildkitRuntime,
      onBuildLog,
      releasePhases
    );
  } finally {
    await buildkitRuntime.cleanup();
  }
}

async function handleDeployOnlyApp(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: DeployOnlyPayload
) {
  return await deployAppImage(docker, config, {
    ...payload,
    serviceName: payload.serviceId,
  });
}

function getWorkerRuntimeEnvironment(config: AgentRuntimeConfig) {
  return {
    serverId: SERVER_ID!,
    imageStoreMode: config.imageStoreMode,
    dataDir: DATA_DIR,
    dataVolume: DATA_VOLUME,
  };
}

async function handleBuildAndDeployWorker(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: WorkerDeployPayload,
  onBuildLog?: BuildLogEmitter,
  releasePhases?: ReleasePhaseRunner
) {
  const requestedBuildType = payload.appBuildType as string | null | undefined;
  if (requestedBuildType === "static") {
    throw new Error("Worker services do not support Static builds");
  }
  if (config.imageStoreMode === "local-registry") {
    await ensureLocalRegistryRuntime(docker, config);
  }

  const buildkitRuntime = await prepareAppBuildkitRuntime(docker, payload);
  try {
    const buildResult = await buildApp({
      docker,
      repoUrl: payload.repoUrl,
      commitHash: payload.commitHash,
      deploymentId: payload.deploymentId,
      envVars: payload.envVars,
      resourceLimits: payload.resourceLimits,
      imageStoreMode: config.imageStoreMode,
      localRegistryHost: config.localRegistryHost,
      localRegistryPort: config.localRegistryPort,
      buildkitAddress: buildkitRuntime.address,
      builderMemoryBytes: buildkitRuntime.memoryBytes,
      appBuildType: payload.appBuildType ?? null,
      appBuildConfig: payload.appBuildConfig ?? null,
      platformGeneratedValues: payload.platformGeneratedValues ?? [],
      ...(onBuildLog ? { onBuildLog } : {}),
    });
    const releaseJobs = releasePhases ? (payload.releaseJobs ?? null) : null;
    const releaseTarget = releaseJobs
      ? buildReleaseJobTarget(docker, {
          ...payload,
          image: buildResult.imageUrl,
          pullImage: config.imageStoreMode !== "docker-local",
          envVars: payload.envVars,
          resourceSettings: toDockerResourceSettings(payload.resourceLimits),
        })
      : null;
    if (releasePhases && releaseTarget && releaseJobs?.preActivation) {
      await docker.ensureNetwork(releaseTarget.networkName, {
        "nouva.managed": "true",
        "nouva.server.id": SERVER_ID!,
        "nouva.project.id": payload.projectId,
      });
      const previousRuntime = payload.runtimeMetadata;
      await runPreActivation(
        releasePhases,
        releaseTarget,
        {
          phase: "pre_activation",
          command: releaseJobs.preActivation.command,
          timeoutSeconds: releaseJobs.preActivation.timeoutSeconds,
        },
        {
          liveRuntimePreserved: Boolean(
            previousRuntime?.containerName ||
              previousRuntime?.containerId ||
              (previousRuntime?.replicas?.length ?? 0) > 0
          ),
        }
      );
    }
    const result = await deployWorkerRuntime(
      docker,
      getWorkerRuntimeEnvironment(config),
      { ...payload, imageUrl: buildResult.imageUrl },
      onBuildLog
        ? {
            onProgress: (line) =>
              onBuildLog({ type: "stdout", line: `[rollout] ${line}`, timestamp: Date.now() }),
          }
        : {}
    );
    if (releasePhases && releaseTarget && releaseJobs?.verification) {
      // Workers only keep: their previous replicas are already retired, so there is nothing idle to
      // return to. The result is recorded and shown on the live deployment.
      await runVerificationKeepingOnError(releasePhases, releaseTarget, {
        phase: "verification",
        command: releaseJobs.verification.command,
        timeoutSeconds: releaseJobs.verification.timeoutSeconds,
        configuredPolicy: releaseJobs.verification.onFailure,
        resolveAppliedPolicy: () => "keep",
      });
    }
    return {
      ...result,
      buildDuration: buildResult.buildDuration,
      detectedLanguage: buildResult.detectedLanguage,
      detectedFramework: buildResult.detectedFramework,
      languageVersion: buildResult.languageVersion,
    };
  } finally {
    await buildkitRuntime.cleanup();
  }
}

async function handleDeployOnlyWorker(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: WorkerDeployOnlyPayload
) {
  return await deployWorkerRuntime(docker, getWorkerRuntimeEnvironment(config), payload);
}

function getManagedVolumeName(payload: DatabaseProvisionPayload | DeleteVolumePayload): string {
  return payload.volumeName;
}

function getDatabaseContainerName(payload: DatabaseProvisionPayload): string {
  return `nouva-${payload.variant}-${payload.serviceId.slice(0, 12)}`;
}

function canExistingContainerOwnPublicPort(
  inspection: DockerContainerInspection,
  payload: DatabaseProvisionPayload
): boolean {
  if (inspection.State?.Running !== true) {
    return false;
  }

  const labels = inspection.Config?.Labels ?? {};
  if (labels["nouva.managed"] !== "true" || labels["nouva.service.id"] !== payload.serviceId) {
    return false;
  }

  const expectedPort = String(payload.externalPort);
  return Object.values(inspection.HostConfig?.PortBindings ?? {}).some((bindings) =>
    bindings?.some(
      (binding) =>
        binding.HostPort === expectedPort &&
        (!binding.HostIp || binding.HostIp === "0.0.0.0" || binding.HostIp === "::")
    )
  );
}

async function assertHostPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", (error) => {
      reject(
        new Error(
          `Public database port ${port} is already occupied on this server. Remove the host listener or conflicting container, then retry provisioning.`,
          { cause: error }
        )
      );
    });
    listener.listen({ host: "0.0.0.0", port, exclusive: true }, () => {
      listener.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
}

export async function preflightDatabasePublicPort(
  docker: Pick<DockerApiClient, "inspectContainer">,
  payload: DatabaseProvisionPayload
): Promise<void> {
  if (!payload.publicAccessEnabled) {
    return;
  }

  if (
    !Number.isInteger(payload.externalPort) ||
    !payload.externalPort ||
    payload.externalPort < 1 ||
    payload.externalPort > 65535
  ) {
    throw new Error(
      "Public database access requires a valid external port between 1 and 65535. Update the server agent and retry provisioning."
    );
  }

  const existing = await docker.inspectContainer(getDatabaseContainerName(payload));
  if (existing && canExistingContainerOwnPublicPort(existing, payload)) {
    return;
  }

  await assertHostPortAvailable(payload.externalPort);
}

function getImageRegistryHost(imageReference: string): string | null {
  const trimmed = imageReference.trim();
  if (!trimmed) {
    return null;
  }

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }

  const firstSegment = trimmed.slice(0, slashIndex);
  if (!firstSegment) {
    return null;
  }

  return firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost"
    ? firstSegment
    : null;
}

function resolveRegistryAuthForImage(
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  imageReference: string
): RegistryAuth | undefined {
  if (!config.privateRegistry) {
    return undefined;
  }

  return getImageRegistryHost(imageReference) === config.privateRegistry.host
    ? config.privateRegistry
    : undefined;
}

export function buildDatabaseContainerSpec(payload: DatabaseProvisionPayload): {
  projectNetwork: string;
  resolved: ReturnType<typeof resolveDatabaseProvisionSpec>;
  volumeName: string;
  containerName: string;
  spec: DockerContainerSpec;
} {
  const projectNetwork = buildProjectNetwork(payload.projectId);
  const resolved = resolveDatabaseProvisionSpec(payload);
  const volumeName = getManagedVolumeName(payload);
  const containerName = getDatabaseContainerName(payload);

  const hostConfig: Record<string, unknown> = {
    Mounts: [
      {
        Type: "volume",
        Source: volumeName,
        Target: resolved.mountPath,
      },
    ],
    RestartPolicy: {
      Name: "unless-stopped",
    },
    ...toDockerResourceSettings(
      resolveRuntimeResourceLimits(payload.resourceLimits, payload.variant)
    ),
  };

  if (payload.publicAccessEnabled && payload.externalPort) {
    hostConfig.PortBindings = {
      [`${resolved.internalPort}/tcp`]: [
        {
          HostIp: "0.0.0.0",
          HostPort: String(payload.externalPort),
        },
      ],
    };
  }

  return {
    projectNetwork,
    resolved,
    volumeName,
    containerName,
    spec: {
      name: containerName,
      image: resolved.image,
      env: Object.entries(resolved.envVars).map(([key, value]) => `${key}=${value}`),
      cmd: resolved.containerArgs.length > 0 ? resolved.containerArgs : undefined,
      labels: buildLabels({
        kind: "database",
        projectId: payload.projectId,
        environmentId: payload.environmentId ?? null,
        serviceId: payload.serviceId,
        serviceVariant: payload.variant,
        redactionContextVersion: payload.redactionContextVersion,
      }),
      exposedPorts: {
        [`${resolved.internalPort}/tcp`]: {},
      },
      hostConfig,
      networkingConfig: {
        EndpointsConfig: {
          [projectNetwork]: {},
        },
      },
    },
  };
}

function isAttachedDatabaseVolumePayload(
  payload:
    | DeleteVolumePayload
    | (DatabaseProvisionPayload & { runtimeMetadata?: RuntimeMetadata | null })
): payload is DatabaseProvisionPayload & {
  runtimeMetadata?: RuntimeMetadata | null;
} {
  return typeof (payload as DatabaseProvisionPayload).serviceId === "string";
}

async function deployDatabaseContainer(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: DatabaseProvisionPayload
) {
  await preflightDatabasePublicPort(docker, payload);
  const { projectNetwork, resolved, volumeName, containerName, spec } =
    buildDatabaseContainerSpec(payload);
  await docker.ensureNetwork(projectNetwork, {
    "nouva.managed": "true",
    "nouva.server.id": SERVER_ID!,
    "nouva.project.id": payload.projectId,
  });
  await docker.connectNetwork(projectNetwork, TRAEFIK_CONTAINER_NAME);
  await docker.createVolume(
    volumeName,
    buildManagedVolumeLabels({
      volumeId: payload.volumeId,
      projectId: payload.projectId,
      serviceId: payload.serviceId,
    })
  );
  const containerId = await docker.ensureContainer(spec, true, {
    auth: resolveRegistryAuthForImage(config, resolved.image),
  });

  return {
    projectNetwork,
    resolved,
    volumeName,
    containerName,
    containerId,
  };
}

/** Bounds one authenticated probe attempt; the surrounding readiness wait owns the overall budget. */
const DATABASE_READINESS_PROBE_TIMEOUT_MS = 20_000;

/**
 * Resolves the account readiness authenticates with.
 *
 * The runtime definition the container is created with is authoritative: it is what the engine will
 * actually accept. The request's own credential fields are a fallback for a runtime whose account
 * does not appear in its environment or arguments.
 */
function getDatabaseProbeCredentials(
  payload: DatabaseProvisionPayload,
  runtime: { envVars: Record<string, string>; containerArgs: string[] }
): {
  username: string;
  password: string;
  database?: string | null;
} {
  const fromRuntime = readDatabaseProbeCredentialsFromRuntime(payload.variant, runtime);
  if (fromRuntime) {
    return fromRuntime;
  }

  const username = payload.credentials?.username?.trim();
  const password = payload.credentials?.password;
  if (!username || !password) {
    throw new Error(
      `Database readiness for ${payload.serviceName} cannot be verified: the provisioning request did not include service credentials`
    );
  }

  return { username, password, database: payload.credentials?.database ?? null };
}

async function runDatabaseReadinessProbe(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  input: {
    serviceId: string;
    image: string;
    projectNetwork: string;
    probe: DatabaseReadinessProbeCommand;
    /** Keeps provisioning and continuing-health sidecars from evicting each other by name. */
    namePrefix: string;
  }
): Promise<void> {
  await runTaskContainer(docker, config, {
    name: `${input.namePrefix}${input.serviceId.slice(0, 12)}`,
    image: input.image,
    env: input.probe.env,
    // The managed database images run their own startup and ignore the command, so the probe
    // container replaces the entrypoint with the shell that runs the authenticated statement.
    entrypoint: input.probe.entrypoint,
    cmd: input.probe.cmd,
    // Joining the project network reaches the database through its service address, so the
    // loopback bootstrap server an initializing image runs cannot answer for it.
    networkMode: input.projectNetwork,
    timeoutMs: DATABASE_READINESS_PROBE_TIMEOUT_MS,
    pull: false,
  });
}

/**
 * How often managed databases are re-observed for continuing health. Slower than the heartbeat: a
 * pass runs authenticated probes, and the heartbeat only reports the latest completed inventory.
 */
export const DATABASE_RUNTIME_HEALTH_INTERVAL_MS = 60_000;

let latestDatabaseRuntimeHealth: AgentDatabaseRuntimeHealthReport | null = null;

async function refreshDatabaseRuntimeHealth(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">
): Promise<void> {
  latestDatabaseRuntimeHealth = await collectDatabaseRuntimeHealthReport({
    docker,
    // Heartbeats publish the newest snapshot instead of waiting for the slowest probe, so a pass
    // over many databases cannot starve the ones it observed first. Snapshots are immutable and
    // always complete, so a heartbeat mid-pass still carries the whole inventory.
    onReport: (report) => {
      latestDatabaseRuntimeHealth = report;
    },
    runProbe: async ({ container, inspection, probe }) => {
      const image = inspection.Config?.Image;
      const projectId = inspection.Config?.Labels?.["nouva.project.id"];
      if (!image || !projectId) {
        throw new Error(
          `Managed database container ${container.containerName} does not carry the image and project labels a health probe needs`
        );
      }

      await runDatabaseReadinessProbe(docker, config, {
        serviceId: container.serviceId,
        image,
        projectNetwork: buildProjectNetwork(projectId),
        namePrefix: "nouva-db-health-",
        probe,
      });
    },
  });
}

export async function handleDatabaseProvision(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: DatabaseProvisionPayload
) {
  const { projectNetwork, resolved, volumeName, containerName, containerId } =
    await deployDatabaseContainer(docker, config, payload);
  const credentials = getDatabaseProbeCredentials(payload, {
    envVars: resolved.envVars,
    containerArgs: resolved.containerArgs,
  });

  // A started container is not a running database: readiness is only reported once the engine
  // answers an authenticated statement, and a failing start is reported as such.
  await waitForDatabaseReadiness({
    docker,
    containerName,
    engine: payload.variant,
    probe: () =>
      runDatabaseReadinessProbe(docker, config, {
        serviceId: payload.serviceId,
        image: resolved.image,
        projectNetwork,
        namePrefix: "nouva-db-ready-",
        probe: buildDatabaseReadinessProbe({
          engine: payload.variant,
          host: containerName,
          port: resolved.internalPort,
          credentials,
        }),
      }),
  });

  return {
    internalHost: containerName,
    internalPort: resolved.internalPort,
    externalHost: payload.publicAccessEnabled ? payload.externalHost : null,
    externalPort: payload.publicAccessEnabled ? payload.externalPort : null,
    runtimeMetadata: {
      containerId,
      containerName,
      image: resolved.image,
      publishedPort: payload.publicAccessEnabled ? payload.externalPort : null,
      volumeName,
      mountPath: resolved.mountPath,
      dataPath: resolved.dataPath,
    },
    runtimeInstance: {
      kind: "database",
      status: "running",
      name: containerName,
      image: resolved.image,
      containerId,
      containerName,
      networkName: projectNetwork,
      internalHost: containerName,
      internalPort: resolved.internalPort,
      externalHost: payload.publicAccessEnabled ? payload.externalHost : null,
      externalPort: payload.publicAccessEnabled ? payload.externalPort : null,
    },
  };
}

export async function handleApplyDatabaseVolume(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: DatabaseProvisionPayload & {
    runtimeMetadata?: RuntimeMetadata | null;
  }
) {
  await preflightDatabasePublicPort(docker, payload);

  const identifier = payload.runtimeMetadata?.containerId ?? payload.runtimeMetadata?.containerName;
  if (identifier) {
    await docker.removeContainer(identifier, true);
  }

  return await handleDatabaseProvision(docker, config, payload);
}

export async function handleDeleteVolume(docker: DockerApiClient, payload: DeleteVolumePayload) {
  const volumeName = getManagedVolumeName(payload);
  await docker.removeVolume(volumeName, true);
  await verifyVolumeAbsent(docker, volumeName);
  return {
    volumeName: payload.volumeName,
    cleanupProof: {
      version: 1,
      kind: "delete_volume",
      volume: { name: volumeName, absent: true },
    } satisfies AgentCleanupProof,
  };
}

/**
 * Remove the per-project Docker network left behind when the last service in a project is deleted.
 *
 * The control plane only queues this once the project holds no services, volumes or buckets, so the
 * only endpoint still attached is Traefik, which every project network gets connected to on the
 * first app deploy. Docker refuses to delete a network with endpoints attached, so Traefik is
 * disconnected first; `disconnectNetwork` already tolerates the network or the container being
 * gone.
 *
 * The name is derived here rather than taken from the payload so it is produced by the same
 * function that created the network (`buildProjectNetwork`), which is the only definition of it.
 */
export async function handleDeleteProject(docker: DockerApiClient, payload: DeleteProjectPayload) {
  const networkName = buildProjectNetwork(payload.projectId);

  await docker.disconnectNetwork(networkName, TRAEFIK_CONTAINER_NAME, true);
  await docker.removeNetwork(networkName);
  await verifyNetworkAbsent(docker, networkName);

  return {
    networkName,
    cleanupProof: {
      version: 1,
      kind: "delete_project",
      network: { name: networkName, absent: true },
    } satisfies AgentCleanupProof,
  };
}

function readPayloadRepositoryGeneration(
  payload: Pick<DeleteVolumePayload, "pgbackrestRepositoryGeneration">
): number | null {
  const value = payload.pgbackrestRepositoryGeneration;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * Wipe a volume's live data, keeping every backup.
 *
 * The destructive phase (removing the container and the Docker volume, then creating an empty
 * replacement) runs at most once per repository generation. When the control plane rotated the
 * volume onto a new pgBackRest repository, the agent records a durable receipt as soon as the empty
 * replacement exists, and a later attempt on the same generation resumes from provisioning instead
 * of erasing the cluster the earlier attempt initialized. Without that, a retry after a lost
 * completion report would leave the rotated repository bound to a PostgreSQL system identifier that
 * no longer exists.
 *
 * `dataDir` exists so tests can exercise the crash boundaries against a temporary directory.
 */
export async function handleWipeVolume(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload:
    | DeleteVolumePayload
    | (DatabaseProvisionPayload & { runtimeMetadata?: RuntimeMetadata | null }),
  context: { workItemId?: string | null; dataDir?: string } = {}
) {
  const volumeName = getManagedVolumeName(payload);
  const identifier = isAttachedDatabaseVolumePayload(payload)
    ? (payload.runtimeMetadata?.containerId ?? payload.runtimeMetadata?.containerName ?? null)
    : null;
  const repositoryGeneration = readPayloadRepositoryGeneration(payload);
  const dataDir = context.dataDir ?? DATA_DIR;
  const alreadyReplaced =
    repositoryGeneration !== null &&
    hasReplacedVolumeForGeneration(await readVolumeWipeReceipt(dataDir, volumeName), {
      volumeName,
      repositoryGeneration,
    });

  const recordVolumeReplaced = async (): Promise<void> => {
    if (repositoryGeneration === null) {
      return;
    }
    await writeVolumeWipeReceipt(dataDir, {
      volumeName,
      repositoryGeneration,
      workItemId: context.workItemId ?? null,
    });
  };

  if (!isAttachedDatabaseVolumePayload(payload)) {
    if (!alreadyReplaced) {
      await docker.removeVolume(volumeName, true);
      await verifyVolumeAbsent(docker, volumeName);
      await docker.createVolume(
        volumeName,
        buildManagedVolumeLabels({
          volumeId: payload.volumeId,
          projectId: payload.projectId,
        })
      );
      await recordVolumeReplaced();
    }
    if (!(await docker.inspectVolume(volumeName))) {
      throw new Error(`Replacement Docker volume ${volumeName} was not created`);
    }
    return {
      volumeName: payload.volumeName,
      cleanupProof: {
        version: 1,
        kind: "wipe_volume",
        previousContainer: { identifier: null, absent: true },
        previousVolume: { name: volumeName, absent: true },
        replacementVolume: { name: volumeName, present: true },
      } satisfies AgentCleanupProof,
    };
  }

  await preflightDatabasePublicPort(docker, payload);

  const containerTargets = [identifier, getDatabaseContainerName(payload)]
    .filter((target): target is string => Boolean(target))
    .filter((target, index, targets) => targets.indexOf(target) === index);

  if (!alreadyReplaced) {
    for (const target of containerTargets) {
      await docker.removeContainer(target, true);
    }
    for (const target of containerTargets) {
      await verifyContainerAbsent(docker, target);
    }

    await docker.removeVolume(volumeName, true);
    await verifyVolumeAbsent(docker, volumeName);
    // Created here rather than left to provisioning so the receipt can be written the moment the
    // replacement exists: everything after this point is safe to repeat.
    await docker.createVolume(
      volumeName,
      buildManagedVolumeLabels({
        volumeId: payload.volumeId,
        projectId: payload.projectId,
        serviceId: payload.serviceId,
      })
    );
    await recordVolumeReplaced();
  }

  const result = await handleDatabaseProvision(docker, config, payload);
  if (!(await docker.inspectVolume(volumeName))) {
    throw new Error(`Replacement Docker volume ${volumeName} was not created`);
  }
  return {
    ...result,
    cleanupProof: {
      version: 1,
      kind: "wipe_volume",
      previousContainer: { identifier, absent: true },
      previousVolume: { name: volumeName, absent: true },
      replacementVolume: { name: volumeName, present: true },
    } satisfies AgentCleanupProof,
  };
}

async function handleCreateMongoArchiveBackup(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: CreateVolumeBackupPayload
) {
  if (payload.artifactFormat !== "mongodb-archive-tar-v1") {
    throw new Error(`MongoDB backup requires mongodb-archive-tar-v1 artifacts`);
  }
  const runtimeContainer =
    payload.runtimeMetadata?.containerId ?? payload.runtimeMetadata?.containerName ?? null;
  if (!runtimeContainer) {
    throw new Error("MongoDB backup requires the authoritative live runtime container identity");
  }
  const username = payload.credentials?.username?.trim();
  const password = payload.credentials?.password;
  if (!username || !password) {
    throw new Error("MongoDB backup requires service credentials");
  }

  const remoteExpression = buildArchiveRemoteExpression();
  const agentTaskImage = await resolveAgentTaskImage(docker);
  const { logs } = await runTaskContainer(docker, config, {
    name: `nouva-backup-${payload.backupId.slice(0, 12)}`,
    image: agentTaskImage,
    env: [
      ...buildArchiveDestinationEnv(payload.destination, payload.expectedObjectKey),
      `NOUVA_BACKUP_ID=${payload.backupId}`,
      `MONGODB_USERNAME=${username}`,
      `MONGODB_PASSWORD=${password}`,
    ],
    cmd: [
      "sh",
      "-c",
      [
        "set -eu",
        `remote="${remoteExpression}"`,
        "work_dir=$(mktemp -d)",
        'archive="/tmp/nouva-mongodb-backup.tar.gz"',
        'download="/tmp/nouva-mongodb-backup.download.tar.gz"',
        "uploaded=0",
        'cleanup() { rm -rf "$work_dir" "$archive" "$download"; if [ "$uploaded" = 1 ] && [ "$' +
          '{NOUVA_BACKUP_OK:-0}" != 1 ]; then rclone deletefile "$remote" || true; fi; }',
        "trap cleanup EXIT INT TERM",
        'mongodump --host 127.0.0.1 --port 27017 --username "$MONGODB_USERNAME" --password "$MONGODB_PASSWORD" --authenticationDatabase admin --archive="$work_dir/dump.archive.gz" --gzip --quiet',
        'printf \'{"version":1,"backupId":"%s","artifactFormat":"mongodb-archive-tar-v1"}\\n\' "$NOUVA_BACKUP_ID" > "$work_dir/manifest.json"',
        'tar -C "$work_dir" -czf "$archive" manifest.json dump.archive.gz',
        'sha256=$(sha256sum "$archive" | cut -d " " -f 1)',
        'size_bytes=$(wc -c < "$archive" | tr -d " ")',
        'rclone copyto "$archive" "$remote"',
        "uploaded=1",
        'rclone copyto "$remote" "$download"',
        'download_sha256=$(sha256sum "$download" | cut -d " " -f 1)',
        'test "$sha256" = "$download_sha256"',
        'mkdir "$work_dir/restore"',
        'tar -C "$work_dir/restore" -xzf "$download"',
        'test "$(find "$work_dir/restore" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d " ")" = 2',
        'mongorestore --host 127.0.0.1 --port 27017 --username "$MONGODB_USERNAME" --password "$MONGODB_PASSWORD" --authenticationDatabase admin --archive="$work_dir/restore/dump.archive.gz" --gzip --dryRun --quiet',
        'printf "NOUVA_SIZE_BYTES:%s\\n" "$size_bytes"',
        'printf "NOUVA_SHA256:%s\\n" "$sha256"',
        "NOUVA_BACKUP_OK=1",
      ].join("\n"),
    ],
    networkMode: `container:${runtimeContainer}`,
    timeoutMs: 30 * 60_000,
  });

  const sizeBytes = Number.parseInt(extractPrefixedLogLine(logs, "NOUVA_SIZE_BYTES:") ?? "", 10);
  const artifactSha256 = extractPrefixedLogLine(logs, "NOUVA_SHA256:");
  if (!artifactSha256 || !Number.isFinite(sizeBytes)) {
    throw new Error("MongoDB backup did not return complete integrity evidence");
  }

  return {
    sizeBytes,
    objectKey: payload.expectedObjectKey,
    artifactFormat: payload.artifactFormat,
    artifactSha256,
    verifiedAt: new Date().toISOString(),
    integrityProof: {
      version: 1,
      engine: "mongodb",
      backupId: payload.backupId,
      objectKey: payload.expectedObjectKey,
      artifactFormat: "mongodb-archive-tar-v1",
      artifactSha256,
      sizeBytes,
      mongodumpSucceeded: true,
      mongorestoreDryRun: true,
      uploadChecksumVerified: true,
    },
  };
}

const MYSQL_SYSTEM_SCHEMAS = "'mysql','information_schema','performance_schema','sys'";
const MYSQL_CLIENT_FLAGS = "-h127.0.0.1 -P3306 -uroot --protocol=tcp";

function buildMysqlDumpScript(): string {
  // Runs inside the service image (mysqldump ships with it) in the live container's network
  // namespace. The root password arrives via MYSQL_PWD so it never appears on argv.
  // The dump uses --databases so it carries CREATE DATABASE / USE statements for every
  // user schema; grants on schemas other than MYSQL_DATABASE are not part of the dump.
  return [
    "set -eu",
    `schemas=$(mysql ${MYSQL_CLIENT_FLAGS} -N -e "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN (${MYSQL_SYSTEM_SCHEMAS})")`,
    'test -n "$schemas"',
    `mysqldump ${MYSQL_CLIENT_FLAGS} --single-transaction --routines --events --triggers --set-gtid-purged=OFF --databases $schemas > /stage/dump.sql`,
    "test -s /stage/dump.sql",
  ].join("\n");
}

function buildMysqlRestoreReplayScript(): string {
  // Runs inside the service image on the freshly created target volume. The official entrypoint
  // initializes the data directory with MYSQL_* credentials, replays /docker-entrypoint-initdb.d
  // (our dump.sql.gz) through a --skip-networking temp server, then starts the real server. A TCP
  // ping therefore only succeeds once the replay completed. MYSQL_PWD is set per command and
  // never exported: the entrypoint's own client calls run against a passwordless root during init.
  return [
    "set -eu",
    'test -n "$MYSQL_ROOT_PASSWORD"',
    'test -n "$MYSQL_DATABASE"',
    "docker-entrypoint.sh mysqld &",
    "pid=$!",
    "ready=0",
    "i=0",
    'while [ "$i" -lt 1500 ]; do',
    '  if ! kill -0 "$pid" 2>/dev/null; then echo "mysqld exited before the restore replay completed" >&2; exit 1; fi',
    `  if MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqladmin ${MYSQL_CLIENT_FLAGS} ping >/dev/null 2>&1; then ready=1; break; fi`,
    "  i=$((i + 1))",
    "  sleep 1",
    "done",
    'test "$ready" = 1',
    `schema_count=$(MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql ${MYSQL_CLIENT_FLAGS} -N -e "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = '$MYSQL_DATABASE'")`,
    'test "$schema_count" = 1',
    `MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqladmin ${MYSQL_CLIENT_FLAGS} shutdown`,
    'wait "$pid"',
    'printf "NOUVA_MYSQL_RESTORE_VALIDATED:1\\n"',
  ].join("\n");
}

async function handleCreateMysqlDumpBackup(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: CreateVolumeBackupPayload
) {
  if (payload.artifactFormat !== "mysql-dump-tar-v1") {
    throw new Error("MySQL backup requires mysql-dump-tar-v1 artifacts");
  }
  const runtimeContainer =
    payload.runtimeMetadata?.containerId ?? payload.runtimeMetadata?.containerName ?? null;
  if (!runtimeContainer) {
    throw new Error("MySQL backup requires the authoritative live runtime container identity");
  }
  const rootPassword = payload.credentials?.password;
  if (!rootPassword) {
    throw new Error("MySQL backup requires service credentials");
  }
  const serviceImage = payload.imageUrl?.trim();
  if (!serviceImage) {
    throw new Error("MySQL backup requires the hydrated service image reference");
  }

  const stageVolume = `nouva-backup-stage-${payload.backupId.slice(0, 12)}`;
  const remoteExpression = buildArchiveRemoteExpression();
  const agentTaskImage = await resolveAgentTaskImage(docker);
  await docker.removeVolume(stageVolume, true);
  await docker.createVolume(
    stageVolume,
    buildBackupStageVolumeLabels({
      kind: "backup-stage",
      backupId: payload.backupId,
      serviceId: payload.serviceId,
    })
  );

  let logs = "";
  try {
    await runTaskContainer(docker, config, {
      name: `nouva-backup-dump-${payload.backupId.slice(0, 12)}`,
      image: serviceImage,
      env: [`MYSQL_PWD=${rootPassword}`],
      entrypoint: ["sh", "-c"],
      cmd: [buildMysqlDumpScript()],
      mounts: [{ source: stageVolume, target: "/stage" }],
      networkMode: `container:${runtimeContainer}`,
      timeoutMs: 30 * 60_000,
    });

    const result = await runTaskContainer(docker, config, {
      name: `nouva-backup-${payload.backupId.slice(0, 12)}`,
      image: agentTaskImage,
      env: [
        ...buildArchiveDestinationEnv(payload.destination, payload.expectedObjectKey),
        `NOUVA_BACKUP_ID=${payload.backupId}`,
      ],
      cmd: [
        "sh",
        "-c",
        [
          "set -eu",
          `remote="${remoteExpression}"`,
          "work_dir=$(mktemp -d)",
          'archive="/tmp/nouva-mysql-backup.tar.gz"',
          'download="/tmp/nouva-mysql-backup.download.tar.gz"',
          "uploaded=0",
          'cleanup() { rm -rf "$work_dir" "$archive" "$download"; if [ "$uploaded" = 1 ] && [ "$' +
            '{NOUVA_BACKUP_OK:-0}" != 1 ]; then rclone deletefile "$remote" || true; fi; }',
          "trap cleanup EXIT INT TERM",
          "test -s /stage/dump.sql",
          'gzip -c /stage/dump.sql > "$work_dir/dump.sql.gz"',
          'printf \'{"version":1,"backupId":"%s","artifactFormat":"mysql-dump-tar-v1"}\\n\' "$NOUVA_BACKUP_ID" > "$work_dir/manifest.json"',
          'tar -C "$work_dir" -czf "$archive" manifest.json dump.sql.gz',
          'sha256=$(sha256sum "$archive" | cut -d " " -f 1)',
          'size_bytes=$(wc -c < "$archive" | tr -d " ")',
          'rclone copyto "$archive" "$remote"',
          "uploaded=1",
          'rclone copyto "$remote" "$download"',
          'download_sha256=$(sha256sum "$download" | cut -d " " -f 1)',
          'test "$sha256" = "$download_sha256"',
          'mkdir "$work_dir/restore"',
          'tar -C "$work_dir/restore" -xzf "$download"',
          'test "$(find "$work_dir/restore" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d " ")" = 2',
          'gzip -t "$work_dir/restore/dump.sql.gz"',
          'gzip -dc "$work_dir/restore/dump.sql.gz" | tail -n 1 | grep -q "Dump completed"',
          'printf "NOUVA_SIZE_BYTES:%s\\n" "$size_bytes"',
          'printf "NOUVA_SHA256:%s\\n" "$sha256"',
          "NOUVA_BACKUP_OK=1",
        ].join("\n"),
      ],
      mounts: [{ source: stageVolume, target: "/stage", readOnly: true }],
      timeoutMs: 30 * 60_000,
    });
    logs = result.logs;
  } finally {
    await docker.removeVolume(stageVolume, true);
  }

  const sizeBytes = Number.parseInt(extractPrefixedLogLine(logs, "NOUVA_SIZE_BYTES:") ?? "", 10);
  const artifactSha256 = extractPrefixedLogLine(logs, "NOUVA_SHA256:");
  if (!artifactSha256 || !Number.isFinite(sizeBytes)) {
    throw new Error("MySQL backup did not return complete integrity evidence");
  }

  return {
    sizeBytes,
    objectKey: payload.expectedObjectKey,
    artifactFormat: payload.artifactFormat,
    artifactSha256,
    verifiedAt: new Date().toISOString(),
    integrityProof: {
      version: 1,
      engine: "mysql",
      backupId: payload.backupId,
      objectKey: payload.expectedObjectKey,
      artifactFormat: "mysql-dump-tar-v1",
      artifactSha256,
      sizeBytes,
      mysqldumpSucceeded: true,
      dumpCompletedMarkerVerified: true,
      uploadChecksumVerified: true,
    },
  };
}

async function handleCreateArchiveBackup(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: CreateVolumeBackupPayload
) {
  if (payload.variant === "mongodb") {
    return handleCreateMongoArchiveBackup(docker, config, payload);
  }
  if (payload.variant === "mysql") {
    return handleCreateMysqlDumpBackup(docker, config, payload);
  }
  if (payload.variant !== "redis") {
    throw new Error(`Database-native snapshot backups do not support ${payload.variant}`);
  }
  const runtimeContainer =
    payload.runtimeMetadata?.containerId ?? payload.runtimeMetadata?.containerName ?? null;
  if (!runtimeContainer) {
    throw new Error("Redis backup requires the authoritative live runtime container identity");
  }
  const remoteExpression = buildArchiveRemoteExpression();
  const agentTaskImage = await resolveAgentTaskImage(docker);
  const { logs } = await runTaskContainer(docker, config, {
    name: `nouva-backup-${payload.backupId.slice(0, 12)}`,
    image: agentTaskImage,
    env: [
      ...buildArchiveDestinationEnv(payload.destination, payload.expectedObjectKey),
      `NOUVA_BACKUP_ID=${payload.backupId}`,
      `REDISCLI_AUTH=${payload.credentials?.password ?? ""}`,
    ],
    cmd: [
      "sh",
      "-c",
      [
        "set -eu",
        `remote="${remoteExpression}"`,
        "work_dir=$(mktemp -d)",
        'archive="/tmp/nouva-redis-backup.tar.gz"',
        'download="/tmp/nouva-redis-backup.download.tar.gz"',
        "uploaded=0",
        'cleanup() { rm -rf "$work_dir" "$archive" "$download"; if [ "$uploaded" = 1 ] && [ "$' +
          '{NOUVA_BACKUP_OK:-0}" != 1 ]; then rclone deletefile "$remote" || true; fi; }',
        "trap cleanup EXIT INT TERM",
        "appendonly=$(redis-cli -h 127.0.0.1 --raw CONFIG GET appendonly | tail -n 1)",
        "save=$(redis-cli -h 127.0.0.1 --raw CONFIG GET save | tail -n 1)",
        'if [ "$appendonly" = yes ] && [ -n "$save" ]; then source_mode=mixed; elif [ "$appendonly" = yes ]; then source_mode=aof; elif [ -n "$save" ]; then source_mode=rdb; else source_mode=none; fi',
        'redis-cli -h 127.0.0.1 --rdb "$work_dir/dump.rdb"',
        'redis-check-rdb "$work_dir/dump.rdb"',
        'printf \'{"version":1,"backupId":"%s","artifactFormat":"redis-rdb-tar-v1","sourceMode":"%s"}\\n\' "$NOUVA_BACKUP_ID" "$source_mode" > "$work_dir/manifest.json"',
        'tar -C "$work_dir" -czf "$archive" manifest.json dump.rdb',
        'sha256=$(sha256sum "$archive" | cut -d " " -f 1)',
        'size_bytes=$(wc -c < "$archive" | tr -d " ")',
        'rclone copyto "$archive" "$remote"',
        "uploaded=1",
        'rclone copyto "$remote" "$download"',
        'download_sha256=$(sha256sum "$download" | cut -d " " -f 1)',
        'test "$sha256" = "$download_sha256"',
        'mkdir "$work_dir/restore"',
        'tar -C "$work_dir/restore" -xzf "$download"',
        'test "$(find "$work_dir/restore" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d " ")" = 2',
        'redis-check-rdb "$work_dir/restore/dump.rdb"',
        'redis-server --port 6380 --bind 127.0.0.1 --dir "$work_dir/restore" --dbfilename dump.rdb --appendonly no --daemonize yes',
        'for i in $(seq 1 30); do redis-cli -h 127.0.0.1 -p 6380 PING | grep -q PONG && break; sleep 1; test "$i" -lt 30; done',
        'if [ "$source_mode" = aof ] || [ "$source_mode" = mixed ]; then redis-cli -h 127.0.0.1 -p 6380 CONFIG SET appendonly yes >/dev/null; redis-cli -h 127.0.0.1 -p 6380 BGREWRITEAOF >/dev/null; for i in $(seq 1 60); do state=$(redis-cli -h 127.0.0.1 -p 6380 --raw INFO persistence | sed -n "s/^aof_rewrite_in_progress:\\([01]\\).*/\\1/p" | tr -d "\\r"); test "$state" = 0 && break; sleep 1; test "$i" -lt 60; done; fi',
        "redis-cli -h 127.0.0.1 -p 6380 SHUTDOWN NOSAVE || true",
        'printf "NOUVA_SIZE_BYTES:%s\\n" "$size_bytes"',
        'printf "NOUVA_SHA256:%s\\n" "$sha256"',
        'printf "NOUVA_REDIS_SOURCE_MODE:%s\\n" "$source_mode"',
        "NOUVA_BACKUP_OK=1",
      ].join("\n"),
    ],
    networkMode: `container:${runtimeContainer}`,
    timeoutMs: 30 * 60_000,
  });

  const sizeBytes = Number.parseInt(extractPrefixedLogLine(logs, "NOUVA_SIZE_BYTES:") ?? "", 10);
  const artifactSha256 = extractPrefixedLogLine(logs, "NOUVA_SHA256:");
  const sourceMode = extractPrefixedLogLine(logs, "NOUVA_REDIS_SOURCE_MODE:") as
    | "rdb"
    | "aof"
    | "mixed"
    | "none"
    | null;
  if (!artifactSha256 || !sourceMode || !Number.isFinite(sizeBytes)) {
    throw new Error("Redis backup did not return complete integrity evidence");
  }
  return {
    sizeBytes,
    objectKey: payload.expectedObjectKey,
    artifactFormat: payload.artifactFormat,
    artifactSha256,
    verifiedAt: new Date().toISOString(),
    integrityProof: {
      version: 1,
      engine: "redis",
      backupId: payload.backupId,
      objectKey: payload.expectedObjectKey,
      artifactFormat: "redis-rdb-tar-v1",
      artifactSha256,
      sizeBytes,
      sourceMode,
      redisCheckRdb: true,
      uploadChecksumVerified: true,
      isolatedRestoreVerified: true,
    },
  };
}

async function handleDeleteArchiveBackup(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: DeleteVolumeBackupPayload
) {
  const remoteExpression = buildArchiveRemoteExpression();
  const agentTaskImage = await resolveAgentTaskImage(docker);
  await runTaskContainer(docker, config, {
    name: `nouva-delete-backup-${payload.backupId.slice(0, 12)}`,
    image: agentTaskImage,
    env: [
      ...buildArchiveDestinationEnv(
        payload.destination,
        `archives/v1/projects/${payload.projectId}/volumes/${payload.volumeId}/backups/${payload.backupId}.tar.gz`
      ),
    ],
    cmd: [
      "sh",
      "-c",
      ["set -eu", `remote="${remoteExpression}"`, 'rclone deletefile "$remote" || true'].join("\n"),
    ],
    timeoutMs: 10 * 60_000,
  });

  return {};
}

async function handleRestoreMysqlDumpBackup(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: RestoreVolumeBackupPayload
) {
  if (payload.artifactFormat !== "mysql-dump-tar-v1") {
    throw new Error("MySQL restore requires mysql-dump-tar-v1 artifacts");
  }
  const spec = resolveHydratedHelperSpec({
    imageUrl: payload.imageUrl,
    envVars: payload.envVars,
    containerArgs: payload.containerArgs,
    mountPath: payload.targetMountPath,
    dataPath: payload.dataPath,
  });
  if (!spec.envVars.MYSQL_ROOT_PASSWORD || !spec.envVars.MYSQL_DATABASE) {
    throw new Error("MySQL restore requires MYSQL_ROOT_PASSWORD and MYSQL_DATABASE init variables");
  }

  const remoteExpression = buildArchiveRemoteExpression();
  const agentTaskImage = await resolveAgentTaskImage(docker);
  const stageVolume = `nouva-restore-stage-${payload.backupId.slice(0, 12)}`;
  await docker.createVolume(
    payload.targetVolumeName,
    buildManagedVolumeLabels({
      volumeId: payload.targetVolumeId,
      projectId: payload.projectId,
      serviceId: payload.serviceId,
    })
  );
  await docker.removeVolume(stageVolume, true);
  await docker.createVolume(
    stageVolume,
    buildBackupStageVolumeLabels({
      kind: "restore-stage",
      backupId: payload.backupId,
      serviceId: payload.serviceId,
    })
  );

  try {
    await runTaskContainer(docker, config, {
      name: `nouva-restore-fetch-${payload.backupId.slice(0, 12)}`,
      image: agentTaskImage,
      env: [
        ...buildArchiveDestinationEnv(payload.destination, payload.expectedObjectKey),
        `EXPECTED_SHA256=${payload.artifactSha256 ?? ""}`,
      ],
      cmd: [
        "sh",
        "-c",
        [
          "set -eu",
          `remote="${remoteExpression}"`,
          'archive="/tmp/nouva-volume-backup.tar.gz"',
          'rclone copyto "$remote" "$archive"',
          'actual_sha256=$(sha256sum "$archive" | cut -d " " -f 1)',
          'if [ -n "$EXPECTED_SHA256" ]; then test "$actual_sha256" = "$EXPECTED_SHA256"; fi',
          'entries=$(tar -tzf "$archive")',
          'test "$(printf "%s\\n" "$entries" | wc -l | tr -d " ")" = 2',
          'printf "%s\\n" "$entries" | grep -qx "manifest.json"',
          'printf "%s\\n" "$entries" | grep -qx "dump.sql.gz"',
          'tar -C /stage -xzf "$archive" dump.sql.gz',
          "gzip -t /stage/dump.sql.gz",
          'printf "NOUVA_SHA256:%s\\n" "$actual_sha256"',
        ].join("\n"),
      ],
      mounts: [{ source: stageVolume, target: "/stage" }],
      timeoutMs: 30 * 60_000,
    });

    await runTaskContainer(docker, config, {
      name: `nouva-restore-replay-${payload.backupId.slice(0, 12)}`,
      image: spec.image,
      env: Object.entries(spec.envVars).map(([key, value]) => `${key}=${value}`),
      entrypoint: ["sh", "-c"],
      cmd: [buildMysqlRestoreReplayScript()],
      mounts: [
        { source: payload.targetVolumeName, target: spec.mountPath },
        { source: stageVolume, target: "/docker-entrypoint-initdb.d", readOnly: true },
      ],
      timeoutMs: 30 * 60_000,
    });
  } finally {
    await docker.removeVolume(stageVolume, true);
  }

  return {
    volumeName: payload.targetVolumeName,
    verifiedAt: new Date().toISOString(),
    restoreProof: {
      version: 1,
      backupId: payload.backupId,
      targetVolumeId: payload.targetVolumeId,
      targetVolumeName: payload.targetVolumeName,
      validationMethod: "mysql-startup-sql-read",
      isolatedDatabaseStarted: true,
      validatedAt: new Date().toISOString(),
    },
  };
}

async function handleRestoreArchiveBackup(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: RestoreVolumeBackupPayload
) {
  if (payload.variant === "mysql") {
    return handleRestoreMysqlDumpBackup(docker, config, payload);
  }
  if (payload.variant !== "redis") {
    throw new Error(`Database-native snapshot restore does not support ${payload.variant}`);
  }
  const remoteExpression = buildArchiveRemoteExpression();
  const agentTaskImage = await resolveAgentTaskImage(docker);
  await docker.createVolume(
    payload.targetVolumeName,
    buildManagedVolumeLabels({
      volumeId: payload.targetVolumeId,
      projectId: payload.projectId,
      serviceId: payload.serviceId,
    })
  );
  await runTaskContainer(docker, config, {
    name: `nouva-restore-backup-${payload.backupId.slice(0, 12)}`,
    image: agentTaskImage,
    env: [
      ...buildArchiveDestinationEnv(payload.destination, payload.expectedObjectKey),
      `EXPECTED_SHA256=${payload.artifactSha256 ?? ""}`,
    ],
    cmd: [
      "sh",
      "-c",
      [
        "set -eu",
        `remote="${remoteExpression}"`,
        'archive="/tmp/nouva-volume-backup.tar.gz"',
        "mkdir -p /target",
        'rclone copyto "$remote" "$archive"',
        'actual_sha256=$(sha256sum "$archive" | cut -d " " -f 1)',
        'if [ -n "$EXPECTED_SHA256" ]; then test "$actual_sha256" = "$EXPECTED_SHA256"; fi',
        'entries=$(tar -tzf "$archive")',
        'test "$(printf "%s\\n" "$entries" | wc -l | tr -d " ")" = 2',
        'printf "%s\\n" "$entries" | grep -qx "manifest.json"',
        'printf "%s\\n" "$entries" | grep -qx "dump.rdb"',
        'tar -C /target -xzf "$archive" dump.rdb',
        "redis-check-rdb /target/dump.rdb",
        "redis-server --port 6380 --bind 127.0.0.1 --dir /target --dbfilename dump.rdb --appendonly no --daemonize yes",
        'for i in $(seq 1 30); do redis-cli -h 127.0.0.1 -p 6380 PING | grep -q PONG && break; sleep 1; test "$i" -lt 30; done',
        "redis-cli -h 127.0.0.1 -p 6380 SHUTDOWN NOSAVE || true",
        'printf "NOUVA_SHA256:%s\\n" "$actual_sha256"',
      ].join("\n"),
    ],
    mounts: [{ source: payload.targetVolumeName, target: "/target" }],
    timeoutMs: 30 * 60_000,
  });

  return {
    volumeName: payload.targetVolumeName,
    verifiedAt: new Date().toISOString(),
    restoreProof: {
      version: 1,
      backupId: payload.backupId,
      targetVolumeId: payload.targetVolumeId,
      targetVolumeName: payload.targetVolumeName,
      validationMethod: "redis-load-ping",
      isolatedDatabaseStarted: true,
      validatedAt: new Date().toISOString(),
    },
  };
}

async function handleCreatePgBackrestBackup(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: CreateVolumeBackupPayload
) {
  const spec = resolveHydratedHelperSpec({
    imageUrl: payload.imageUrl,
    envVars: payload.envVars,
    containerArgs: payload.containerArgs,
    mountPath: payload.mountPath,
    dataPath: payload.dataPath,
  });
  const script = [
    "set -eu",
    'printf "%s\\n" "*:*:*:$POSTGRES_USER:$POSTGRES_PASSWORD" > /tmp/.pgpass',
    "chmod 0600 /tmp/.pgpass",
    "export PGPASSFILE=/tmp/.pgpass",
    'metadata_dir="$NOUVA_DATA_PATH/.nouva/pgbackrest"',
    'mkdir -p "$metadata_dir"',
    "if [ -x /nouva/generate_config.sh ]; then /nouva/generate_config.sh; fi",
    'stanza_info_log="/tmp/pgbackrest-stanza-info.log"',
    'if ! pgbackrest --stanza="$PGBACKREST_STANZA" info >"$stanza_info_log" 2>&1; then',
    '  if grep -Eq "missing stanza path|backup\\.info cannot be opened" "$stanza_info_log"; then',
    '    pgbackrest --stanza="$PGBACKREST_STANZA" --log-level-console=info stanza-create',
    "  else",
    '    cat "$stanza_info_log" >&2',
    "    exit 1",
    "  fi",
    "fi",
    'pgbackrest --stanza="$PGBACKREST_STANZA" --log-level-console=info check',
    'pgbackrest --stanza="$PGBACKREST_STANZA" --type="$NOUVA_PGBACKREST_BACKUP_TYPE" --annotation="nouva-backup-id=$NOUVA_BACKUP_ID" --log-level-console=info backup',
    'if info_output=$(pgbackrest --stanza="$PGBACKREST_STANZA" --output=json info 2>/dev/null); then',
    `  printf 'NOUVA_PGBACKREST_INFO:%s\\n' "$(printf '%s' "$info_output" | tr -d '\\n')"`,
    "fi",
  ].join("\n");
  const { logs } = await runTaskContainer(docker, config, {
    name: `nouva-pgbackrest-backup-${payload.backupId.slice(0, 12)}`,
    image: spec.image,
    env: [
      ...Object.entries(spec.envVars).map(([key, value]) => `${key}=${value}`),
      `NOUVA_BACKUP_ID=${payload.backupId}`,
      `NOUVA_PGBACKREST_BACKUP_TYPE=${payload.pgbackrestType ?? "full"}`,
      `NOUVA_DATA_PATH=${spec.dataPath}`,
    ],
    entrypoint: ["sh", "-c"],
    cmd: [script],
    mounts: [{ source: payload.volumeName, target: spec.mountPath }],
    timeoutMs: 30 * 60_000,
  });

  const rawInfo = extractPrefixedLogLine(logs, "NOUVA_PGBACKREST_INFO:");
  const entries = rawInfo ? parsePgBackrestInfo(rawInfo) : [];
  const selected = selectCurrentPgBackrestEntry(
    entries,
    payload.backupId,
    payload.pgbackrestType ?? "full"
  );
  if (!selected?.label || !selected.stopAt) {
    throw new Error("pgBackRest backup metadata did not contain the created backup set");
  }
  await runTaskContainer(docker, config, {
    name: `nouva-pgbackrest-verify-${payload.backupId.slice(0, 12)}`,
    image: spec.image,
    env: Object.entries(spec.envVars).map(([key, value]) => `${key}=${value}`),
    entrypoint: ["sh", "-c"],
    cmd: [
      [
        "set -eu",
        "if [ -x /nouva/generate_config.sh ]; then /nouva/generate_config.sh; fi",
        `pgbackrest --stanza="$PGBACKREST_STANZA" --set="${selected.label}" --log-level-console=info verify`,
      ].join("\n"),
    ],
    mounts: [{ source: payload.volumeName, target: spec.mountPath }],
    timeoutMs: 30 * 60_000,
  });
  const verifiedAt = new Date().toISOString();

  return {
    completedAt: selected?.stopAt ?? null,
    pgbackrestType:
      selected?.type === "full" || selected?.type === "incr"
        ? selected.type
        : (payload.pgbackrestType ?? null),
    pgbackrestSet: selected?.label ?? null,
    activePgbackrestSets: entries.map((entry) => entry.label),
    objectKey: payload.expectedObjectKey,
    artifactFormat: payload.artifactFormat,
    verifiedAt,
    integrityProof: {
      version: 1,
      engine: "pgbackrest",
      backupId: payload.backupId,
      objectKey: payload.expectedObjectKey,
      artifactFormat: "pgbackrest-v1",
      pgbackrestSet: selected.label,
      requiredWalStart: null,
      requiredWalStop: null,
      repositorySizeBytes: null,
      databaseSizeBytes: null,
      completedAt: selected.stopAt,
      verifiedAt,
    },
  };
}

async function handleRestorePgBackrestBackup(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: RestoreVolumeBackupPayload
) {
  if (!payload.pgbackrestSet && !payload.backupCompletedAt) {
    throw new Error("Backup restore is missing both pgbackrestSet and backupCompletedAt");
  }

  const spec = resolveHydratedHelperSpec({
    imageUrl: payload.imageUrl,
    envVars: payload.envVars,
    containerArgs: payload.containerArgs,
    mountPath: payload.targetMountPath,
    dataPath: payload.dataPath,
  });
  const script = buildPgBackrestRestoreAndPromoteScript();

  await docker.createVolume(
    payload.targetVolumeName,
    buildManagedVolumeLabels({
      volumeId: payload.targetVolumeId,
      projectId: payload.projectId,
      serviceId: payload.serviceId,
    })
  );
  await runTaskContainer(docker, config, {
    name: `nouva-pgbackrest-restore-${payload.targetVolumeId.slice(0, 12)}`,
    image: spec.image,
    env: [
      ...Object.entries(spec.envVars).map(([key, value]) => `${key}=${value}`),
      `RESTORE_TYPE=${payload.pgbackrestSet ? "immediate" : "time"}`,
      `RESTORE_TARGET=${payload.backupCompletedAt ?? ""}`,
      `RESTORE_SET=${payload.pgbackrestSet ?? ""}`,
      "NOUVA_STAGED_RESTORE=1",
      `NOUVA_DATA_PATH=${spec.dataPath}`,
    ],
    entrypoint: ["sh", "-c"],
    cmd: [script],
    mounts: [{ source: payload.targetVolumeName, target: spec.mountPath }],
    timeoutMs: 30 * 60_000,
  });

  return {
    volumeName: payload.targetVolumeName,
    verifiedAt: new Date().toISOString(),
    restoreProof: {
      version: 1,
      backupId: payload.backupId,
      targetVolumeId: payload.targetVolumeId,
      targetVolumeName: payload.targetVolumeName,
      validationMethod: "postgres-startup-sql-read",
      isolatedDatabaseStarted: true,
      validatedAt: new Date().toISOString(),
    },
  };
}

async function handleExpireVolumeBackupRepository(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: ExpireVolumeBackupRepositoryPayload
) {
  const script = [
    "set -eu",
    "if [ -x /nouva/generate_config.sh ]; then /nouva/generate_config.sh; fi",
    'pgbackrest --stanza="$PGBACKREST_STANZA" --log-level-console=info expire',
    'if info_output=$(pgbackrest --stanza="$PGBACKREST_STANZA" --output=json info 2>/dev/null); then',
    `  printf 'NOUVA_PGBACKREST_INFO:%s\\n' "$(printf '%s' "$info_output" | tr -d '\\n')"`,
    "fi",
  ].join("\n");
  const { logs } = await runTaskContainer(docker, config, {
    name: `nouva-pgbackrest-expire-${payload.volumeId.slice(0, 12)}`,
    image: payload.imageUrl ?? "postgres:17",
    env: Object.entries(toRecord(payload.envVars)).map(([key, value]) => `${key}=${value}`),
    entrypoint: ["sh", "-c"],
    cmd: [script],
    timeoutMs: 30 * 60_000,
  });

  const rawInfo = extractPrefixedLogLine(logs, "NOUVA_PGBACKREST_INFO:");
  const entries = rawInfo ? parsePgBackrestInfo(rawInfo) : [];
  return {
    activePgbackrestSets: entries.map((entry) => entry.label),
  };
}

export async function handleCreateVolumeBackup(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: CreateVolumeBackupPayload
) {
  if (payload.engine === "pgbackrest") {
    return await handleCreatePgBackrestBackup(docker, config, payload);
  }

  return await handleCreateArchiveBackup(docker, config, payload);
}

async function handleDeleteVolumeBackup(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: DeleteVolumeBackupPayload
) {
  if (payload.engine === "pgbackrest") {
    return {};
  }

  return await handleDeleteArchiveBackup(docker, config, payload);
}

export async function handleRestoreVolumeBackup(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: RestoreVolumeBackupPayload
) {
  if (payload.engine === "pgbackrest") {
    return await handleRestorePgBackrestBackup(docker, config, payload);
  }

  return await handleRestoreArchiveBackup(docker, config, payload);
}

export async function handleRestorePostgresPitr(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: RestorePostgresPitrPayload
) {
  const spec = resolveDatabaseProvisionSpec(payload);
  const script = buildPgBackrestRestoreAndPromoteScript();
  await runTaskContainer(docker, config, {
    name: `nouva-pgbackrest-pitr-${payload.serviceId.slice(0, 12)}`,
    image: spec.image,
    env: [
      ...Object.entries(spec.envVars).map(([key, value]) => `${key}=${value}`),
      "RESTORE_TYPE=time",
      `RESTORE_TARGET=${payload.restoreTarget}`,
      // Pinning the base set keeps recovery on the timeline the control plane selected instead of
      // letting pgBackRest pick whichever set it considers closest to the timestamp.
      `RESTORE_SET=${payload.sourcePgbackrestSet ?? ""}`,
      "NOUVA_STAGED_RESTORE=1",
      `NOUVA_DATA_PATH=${spec.dataPath}`,
    ],
    entrypoint: ["sh", "-c"],
    cmd: [script],
    mounts: [{ source: payload.volumeName, target: spec.mountPath }],
    timeoutMs: 30 * 60_000,
  });

  return {
    statusMessage: "PITR restore ready to apply",
  };
}

/**
 * A failure the control plane can classify.
 *
 * Import failures carry a category so the customer is told *what* was wrong with their artifact
 * rather than that "the agent work failed". The category rides in `result.importFailure`, which
 * the control plane re-reads into the `database_import` row.
 */
export class ExternalBackupImportError extends Error {
  readonly result: Record<string, unknown>;

  constructor(category: ExternalBackupImportFailureCategory, message: string) {
    super(message);
    this.name = "ExternalBackupImportError";
    this.result = { importFailure: { category, message } };
  }
}

const EXTERNAL_BACKUP_IMPORT_ARTIFACT_PATH = "/nouva-import/artifact.bin";
const EXTERNAL_BACKUP_IMPORT_STAGE_TARGET = "/stage";
/** Marker the restore scripts print once the bytes are in, before anything validates them. */
const EXTERNAL_BACKUP_IMPORT_RESTORED_MARKER = "NOUVA_IMPORT_RESTORED:";

/**
 * A shell parameter expansion with a default, assembled rather than written literally.
 *
 * `"${NAME:-fallback}"` inside a TypeScript string reads as a template placeholder to the linter,
 * so the `$` is contributed by an actual placeholder and the text stays shell-correct.
 */
function shellDefault(name: string, fallback: string): string {
  const dollar = "$";
  return `${dollar}{${name}:-${fallback}}`;
}

function buildImportStageVolumeLabels(input: {
  importId: string;
  serviceId: string;
}): Record<string, string> {
  // Not a "volume" resource, for the same reason backup staging volumes are not: this is scratch
  // space that capacity accounting and reconciliation must never mistake for service data.
  return {
    "nouva.managed": "true",
    "nouva.resource": "import-stage",
    "nouva.import.id": input.importId,
    "nouva.service.id": input.serviceId,
  };
}

/**
 * Downloads the artifact and reports what it actually is.
 *
 * The script measures and never judges: no `EXPECTED_SHA256` comparison happens here, because a
 * shell `test` that is skipped when a variable is empty is the shape of a check that silently
 * stops running. The digest, the byte count, and the header prefix all travel back out, and the
 * decision is made once, in `verifyExternalBackupArtifact`.
 */
export function buildExternalBackupImportFetchScript(headerSampleBytes: number): string {
  return [
    "set -eu",
    `remote="${buildArchiveRemoteExpression()}"`,
    `artifact="${EXTERNAL_BACKUP_IMPORT_STAGE_TARGET}/artifact.bin"`,
    'rclone copyto "$remote" "$artifact"',
    'actual_sha256=$(sha256sum "$artifact" | cut -d " " -f 1)',
    'actual_size=$(wc -c < "$artifact" | tr -d " ")',
    `header=$(head -c ${headerSampleBytes} "$artifact" | base64 | tr -d "\\n")`,
    'printf "NOUVA_SHA256:%s\\n" "$actual_sha256"',
    'printf "NOUVA_SIZE_BYTES:%s\\n" "$actual_size"',
    'printf "NOUVA_ARTIFACT_HEADER:%s\\n" "$header"',
  ].join("\n");
}

/**
 * Restores a verified custom-format archive into the staged volume and proves it opens.
 *
 * `--single-transaction` is what makes the outcome binary: an archive that errors part-way leaves
 * the staged database empty rather than half-populated, so there is no state in which a partial
 * import could be applied. `--no-owner --no-privileges` stops the archive reassigning ownership or
 * granting to roles it names; everything lands owned by the destination's own role.
 */
export function buildPostgresExternalBackupImportScript(): string {
  const socketDir = `"${shellDefault("POSTGRES_SOCKET_DIR", "/var/lib/postgresql/.sockets")}"`;
  const password = shellDefault("POSTGRES_PASSWORD", "");
  return [
    "set -eu",
    `mkdir -p "$NOUVA_DATA_PATH" ${socketDir} /var/run/postgresql`,
    'chown -R 999:999 "$NOUVA_DATA_PATH" || true',
    "/nouva/entrypoint.sh &",
    'entrypoint_pid="$!"',
    "cleanup() {",
    '  if kill -0 "$entrypoint_pid" 2>/dev/null; then',
    '    kill -TERM "$entrypoint_pid" || true',
    '    wait "$entrypoint_pid" || true',
    "  fi",
    "}",
    "trap cleanup EXIT INT TERM",
    `export PGHOST=${socketDir}`,
    `export PGPORT="${shellDefault("POSTGRES_PORT", "5433")}"`,
    `export PGUSER="${shellDefault("POSTGRES_USER", "postgres")}"`,
    `export PGDATABASE="${shellDefault("POSTGRES_DB", "postgres")}"`,
    `if [ -n "${password}" ]; then export PGPASSWORD="${password}"; fi`,
    "ready=0",
    "for i in $(seq 1 300); do",
    '  if pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; then ready=1; break; fi',
    '  if ! kill -0 "$entrypoint_pid" 2>/dev/null; then break; fi',
    "  sleep 1",
    "done",
    'if [ "$ready" != 1 ]; then',
    '  echo "The destination PostgreSQL server did not start for this import" >&2',
    "  exit 1",
    "fi",
    // `pg_restore` does not read PGDATABASE: without an explicit target it writes SQL to stdout,
    // and `--single-transaction` then aborts because there is no connection to open one on. The
    // database has to be named on the command line for the archive to be replayed at all.
    'pg_restore --single-transaction --exit-on-error --no-owner --no-privileges --dbname "$PGDATABASE" "$NOUVA_IMPORT_ARTIFACT"',
    `printf "${EXTERNAL_BACKUP_IMPORT_RESTORED_MARKER}%s\\n" 1`,
    "relations=$(psql -Atqc \"select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p','m') and n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_toast'\")",
    'psql -Atqc "checkpoint" >/dev/null',
    'printf "NOUVA_IMPORT_RELATIONS:%s\\n" "$relations"',
  ].join("\n");
}

/**
 * Loads a verified RDB snapshot into the staged volume with the engine that will serve it.
 *
 * The snapshot is validated by the destination's own `redis-server`, not by whatever
 * `redis-check-rdb` the agent image happens to ship: a snapshot the agent's binary accepts and the
 * service's binary refuses is exactly the failure this step exists to catch. Redis loads the whole
 * dataset at startup, so a `PONG` on the loopback port is proof the file parsed end to end.
 */
export function buildRedisExternalBackupImportScript(): string {
  return [
    "set -eu",
    'mkdir -p "$NOUVA_DATA_PATH"',
    'cp "$NOUVA_IMPORT_ARTIFACT" "$NOUVA_DATA_PATH/dump.rdb"',
    `printf "${EXTERNAL_BACKUP_IMPORT_RESTORED_MARKER}%s\\n" 1`,
    'redis-server --port 6380 --bind 127.0.0.1 --dir "$NOUVA_DATA_PATH" --dbfilename dump.rdb --appendonly no --daemonize yes',
    "ready=0",
    "for i in $(seq 1 120); do",
    "  if redis-cli -h 127.0.0.1 -p 6380 PING 2>/dev/null | grep -q PONG; then ready=1; break; fi",
    "  sleep 1",
    "done",
    'if [ "$ready" != 1 ]; then',
    '  echo "The destination Redis server did not load the imported snapshot" >&2',
    "  exit 1",
    "fi",
    'keyspace=$(redis-cli -h 127.0.0.1 -p 6380 INFO keyspace | tr -d "\\r")',
    'keys=$(printf "%s\\n" "$keyspace" | grep "^db" | cut -d "=" -f 2 | cut -d "," -f 1 | awk \'{ total += $1 } END { printf "%d\\n", total }\')',
    'volatile=$(printf "%s\\n" "$keyspace" | grep "^db" | cut -d "=" -f 3 | cut -d "," -f 1 | awk \'{ total += $1 } END { printf "%d\\n", total }\')',
    "redis-cli -h 127.0.0.1 -p 6380 SHUTDOWN NOSAVE >/dev/null 2>&1 || true",
    'printf "NOUVA_IMPORT_KEYS:%s\\n" "$keys"',
    'printf "NOUVA_IMPORT_VOLATILE_KEYS:%s\\n" "$volatile"',
  ].join("\n");
}

function readImportCount(logs: string, prefix: string): number | null {
  const raw = extractPrefixedLogLine(logs, prefix)?.trim();
  if (!raw || !/^[0-9]+$/.test(raw)) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Reads back what the fetch container measured.
 *
 * Anything missing or malformed is a hard failure: the verifier's guarantees rest on these three
 * values, so "the agent did not report a digest" can never degrade into "skip the digest check".
 */
export function parseExternalBackupImportObservation(logs: string): {
  sha256: string;
  sizeBytes: number;
  headerSample: Uint8Array;
} {
  const sha256 = extractPrefixedLogLine(logs, "NOUVA_SHA256:")?.trim() ?? "";
  const sizeBytes = readImportCount(logs, "NOUVA_SIZE_BYTES:");
  const headerBase64 = extractPrefixedLogLine(logs, "NOUVA_ARTIFACT_HEADER:")?.trim() ?? "";

  if (!sha256 || sizeBytes === null || !headerBase64) {
    throw new ExternalBackupImportError(
      "integrity_mismatch",
      "The artifact was downloaded without complete integrity evidence, so it cannot be verified"
    );
  }

  return {
    sha256,
    sizeBytes,
    headerSample: new Uint8Array(Buffer.from(headerBase64, "base64")),
  };
}

export async function handleImportExternalBackup(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: ImportExternalBackupPayload
) {
  const spec = resolveHydratedHelperSpec({
    imageUrl: payload.imageUrl,
    envVars: payload.envVars,
    containerArgs: payload.containerArgs,
    mountPath: payload.targetMountPath,
    dataPath: payload.dataPath,
  });
  const agentTaskImage = await resolveAgentTaskImage(docker);
  const shortId = payload.importId.slice(0, 12);
  const stageVolume = `nouva-import-stage-${shortId}`;

  await docker.removeVolume(stageVolume, true);
  await docker.createVolume(
    stageVolume,
    buildImportStageVolumeLabels({ importId: payload.importId, serviceId: payload.serviceId })
  );

  try {
    let fetchLogs: string;
    try {
      ({ logs: fetchLogs } = await runTaskContainer(docker, config, {
        name: `nouva-import-fetch-${shortId}`,
        image: agentTaskImage,
        env: buildArchiveDestinationEnv(payload.destination, payload.objectKey),
        cmd: [
          "sh",
          "-c",
          buildExternalBackupImportFetchScript(EXTERNAL_BACKUP_IMPORT_HEADER_SAMPLE_BYTES),
        ],
        mounts: [{ source: stageVolume, target: EXTERNAL_BACKUP_IMPORT_STAGE_TARGET }],
        timeoutMs: 60 * 60_000,
      }));
    } catch (error) {
      throw new ExternalBackupImportError(
        "artifact_missing",
        `The uploaded artifact could not be retrieved: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
    }

    const observed = parseExternalBackupImportObservation(fetchLogs);
    const verification = verifyExternalBackupArtifact({
      declared: {
        format: payload.format,
        sha256: payload.artifactSha256,
        sizeBytes: payload.artifactSizeBytes,
      },
      observed,
      destination: { variant: payload.variant, version: payload.version },
    });
    if (verification.outcome === "rejected") {
      throw new ExternalBackupImportError(verification.category, verification.message);
    }

    await docker.createVolume(
      payload.targetVolumeName,
      buildManagedVolumeLabels({
        volumeId: payload.targetVolumeId,
        projectId: payload.projectId,
        serviceId: payload.serviceId,
      })
    );

    let restoreLogs: string;
    try {
      ({ logs: restoreLogs } = await runTaskContainer(docker, config, {
        name: `nouva-import-restore-${shortId}`,
        image: spec.image,
        env: [
          ...Object.entries(spec.envVars).map(([key, value]) => `${key}=${value}`),
          "NOUVA_STAGED_RESTORE=1",
          `NOUVA_DATA_PATH=${spec.dataPath}`,
          `NOUVA_IMPORT_ARTIFACT=${EXTERNAL_BACKUP_IMPORT_ARTIFACT_PATH}`,
        ],
        entrypoint: ["sh", "-c"],
        cmd: [
          payload.variant === "postgres"
            ? buildPostgresExternalBackupImportScript()
            : buildRedisExternalBackupImportScript(),
        ],
        mounts: [
          { source: payload.targetVolumeName, target: spec.mountPath },
          {
            source: stageVolume,
            target: path.dirname(EXTERNAL_BACKUP_IMPORT_ARTIFACT_PATH),
            readOnly: true,
          },
        ],
        // A custom-format archive is arbitrary SQL replayed by the destination's own superuser, so
        // the container that replays it gets no network at all: it can reach neither the internet
        // nor the customer's other services, and it is destroyed when the import ends.
        networkMode: "none",
        timeoutMs: 6 * 60 * 60_000,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      throw new ExternalBackupImportError(
        message.includes(EXTERNAL_BACKUP_IMPORT_RESTORED_MARKER)
          ? "validation_failed"
          : "restore_failed",
        message
      );
    }

    const validatedAt = new Date().toISOString();
    const importProof: ExternalBackupImportProofV1 = {
      version: 1,
      importId: payload.importId,
      format: payload.format,
      targetVolumeId: payload.targetVolumeId,
      targetVolumeName: payload.targetVolumeName,
      artifactSha256: observed.sha256,
      artifactSizeBytes: observed.sizeBytes,
      digestVerified: true,
      headerVerified: true,
      sourceEngineVersion: verification.sourceEngineVersion,
      destinationVariant: payload.variant,
      destinationVersion: payload.version,
      validationMethod:
        payload.variant === "postgres" ? "postgres-startup-sql-read" : "redis-load-ping",
      isolatedDatabaseStarted: true,
      ...(payload.variant === "postgres"
        ? { relationCount: readImportCount(restoreLogs, "NOUVA_IMPORT_RELATIONS:") ?? 0 }
        : {
            keyCount: readImportCount(restoreLogs, "NOUVA_IMPORT_KEYS:") ?? 0,
            volatileKeyCount: readImportCount(restoreLogs, "NOUVA_IMPORT_VOLATILE_KEYS:") ?? 0,
          }),
      validatedAt,
    };

    return {
      volumeName: payload.targetVolumeName,
      verifiedAt: validatedAt,
      importProof,
    };
  } finally {
    await docker.removeVolume(stageVolume, true);
    // The artifact's life is exactly this work item: import work is queued with a single attempt,
    // so nothing will ask for these bytes again whether it succeeded or failed. Deletion is
    // best-effort — a stranded object costs storage, while throwing here would replace a real
    // import outcome with a cleanup error.
    await runTaskContainer(docker, config, {
      name: `nouva-import-cleanup-${shortId}`,
      image: agentTaskImage,
      env: buildArchiveDestinationEnv(payload.destination, payload.objectKey),
      cmd: [
        "sh",
        "-c",
        [
          "set -eu",
          `remote="${buildArchiveRemoteExpression()}"`,
          'rclone deletefile "$remote" || true',
        ].join("\n"),
      ],
      timeoutMs: 10 * 60_000,
    }).catch((error) => {
      console.warn(
        `[nouva-agent] failed to delete the import artifact for ${payload.importId}:`,
        error
      );
    });
  }
}

async function handleRestart(docker: DockerApiClient, payload: RestartServicePayload) {
  const identifier = resolveServiceContainerIdentifier(payload);
  if (!identifier) {
    throw new Error("Missing container identifier for restart");
  }

  await docker.restartContainer(identifier);
  return {
    runtimeMetadata: {
      ...(payload.runtimeMetadata ?? {}),
      containerName: payload.containerName ?? payload.runtimeMetadata?.containerName ?? null,
    },
  };
}

function readRestartCount(inspection: DockerContainerInspection | null): number {
  const restarts = inspection?.RestartCount;
  return typeof restarts === "number" && Number.isFinite(restarts) && restarts > 0 ? restarts : 0;
}

/**
 * Waits for a restarted database to answer an authenticated probe.
 *
 * The container is restarted in place, so it keeps its data, its image and every restart it ever
 * recovered from: `restartBaseline` scopes the restart-loop judgement to this attempt. Credentials
 * and the probe image come from the running container's own definition, which is the account the
 * engine will accept.
 */
async function waitForRestartedDatabaseReadiness(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  input: {
    payload: RestartServicePayload;
    identifier: string;
    restartBaseline: number;
  }
): Promise<void> {
  const inspection = await docker.inspectContainer(input.identifier);
  if (!inspection) {
    throw new Error(
      `Database container ${input.identifier} is missing on the server after the restart`
    );
  }

  const containerName =
    input.payload.containerName ??
    input.payload.runtimeMetadata?.containerName ??
    inspection.Name?.replace(/^\//, "") ??
    input.identifier;
  const image = inspection.Config?.Image;
  const projectId = input.payload.projectId ?? inspection.Config?.Labels?.["nouva.project.id"];
  const credentials = readDatabaseProbeCredentials(input.payload.variant, inspection);

  if (!image || !projectId || !credentials) {
    throw new Error(
      `Restarted database ${containerName} cannot be verified: its container does not carry the image, project and credential definition an authenticated readiness check needs`
    );
  }

  await waitForDatabaseReadiness({
    docker,
    containerName,
    engine: input.payload.variant,
    restartBaseline: input.restartBaseline,
    probe: () =>
      runDatabaseReadinessProbe(docker, config, {
        serviceId: input.payload.serviceId,
        image,
        projectNetwork: buildProjectNetwork(projectId),
        namePrefix: "nouva-db-ready-",
        probe: buildDatabaseReadinessProbe({
          engine: input.payload.variant,
          host: containerName,
          port: resolveDatabaseInternalPort(input.payload.variant, inspection),
          credentials,
        }),
      }),
  });
}

/**
 * Restarts a service container, and for a database waits until it actually serves again.
 *
 * `restart_database` reporting completion while the engine cannot start is the original #297
 * symptom, so the database path is gated on an authenticated probe. The app path is unchanged: it
 * keeps its own rollout readiness and is not probed here.
 */
export async function handleRestartService(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  kind: "restart_app" | "restart_database",
  payload: RestartServicePayload
) {
  if (kind !== "restart_database") {
    return await handleRestart(docker, payload);
  }

  const identifier = resolveServiceContainerIdentifier(payload);
  if (!identifier) {
    throw new Error("Missing container identifier for restart");
  }

  const restartBaseline = readRestartCount(await docker.inspectContainer(identifier));
  const result = await handleRestart(docker, payload);
  await waitForRestartedDatabaseReadiness(docker, config, {
    payload,
    identifier,
    restartBaseline,
  });
  return result;
}

export function resolveServiceContainerIdentifier(input: {
  containerName?: string | null;
  runtimeMetadata?: RuntimeMetadata | null;
}): string | null {
  return (
    input.containerName ??
    input.runtimeMetadata?.containerId ??
    input.runtimeMetadata?.containerName ??
    null
  );
}

async function handleRemove(
  docker: DockerApiClient,
  serviceId: string,
  runtimeMetadata: RuntimeMetadata | null,
  deploymentId: string
) {
  if (!deploymentId) throw new Error("App removal requires a deployment ID");
  await removeManagedServiceContainers(docker, serviceId, deploymentId);
  if (runtimeMetadata?.imageStoreMode === "docker-local") {
    await removeRetainedRuntimeImages(docker, runtimeMetadata);
  }
  await deleteLocalTraefikRoute(TRAEFIK_PATHS, serviceId);
  return {
    runtimeInstance: {
      kind: "app",
      status: "removed",
      containerId: runtimeMetadata?.containerId ?? null,
      containerName: runtimeMetadata?.containerName ?? null,
    },
  };
}

/**
 * Applies a stored resource policy to a container that is already running.
 *
 * `docker update` answers success without promising the daemon kept every field, so the container
 * is read back and compared: a swap allowance that never reached the cgroup would otherwise be
 * reported as applied, leaving the stored policy and the running container silently disagreeing.
 */
export async function handleReconcileServiceResources(
  docker: DockerApiClient,
  payload: ReconcileServiceResourcesPayload
): Promise<{
  serviceId: string;
  containerId: string;
  applied: {
    nanoCpus: number;
    memory: number;
    memorySwap: number;
    pidsLimit: number;
    policyVersion: number;
  };
}> {
  const container =
    payload.containerName ??
    payload.runtimeMetadata?.containerName ??
    payload.runtimeMetadata?.containerId;
  if (!container) {
    throw new Error(`Service ${payload.serviceId} has no runtime container to reconcile`);
  }

  const resources = toDockerResourceSettings(payload.resourceLimits);
  await docker.updateContainer(container, resources);
  const inspection = await docker.inspectContainer(container);
  if (!inspection) {
    throw new Error(
      `Service ${payload.serviceId} container disappeared after resource reconciliation`
    );
  }

  assertAppliedDockerResourceSettings({
    containerId: inspection.Id,
    requested: resources,
    applied: inspection.HostConfig,
  });

  return {
    serviceId: payload.serviceId,
    containerId: inspection.Id,
    applied: {
      nanoCpus: resources.NanoCpus,
      memory: resources.Memory,
      memorySwap: resources.MemorySwap,
      pidsLimit: resources.PidsLimit,
      policyVersion: payload.resourceLimits.policyVersion,
    },
  };
}

export async function handleDeleteService(docker: DockerApiClient, payload: RemoveServicePayload) {
  // The build cache outlives any single deployment, so nothing else reclaims it when the service
  // it belongs to goes away (#184). Removing a volume that was never created is a no-op.
  await docker.removeVolume(buildBuildkitCacheVolumeName(payload.serviceId), true);

  if (payload.serviceType === "worker") {
    return await removeWorkerServiceRuntime(docker, {
      serviceId: payload.serviceId,
      runtimeMetadata: payload.runtimeMetadata,
    });
  }

  const identifier = resolveServiceContainerIdentifier(payload);
  await removeManagedServiceContainers(docker, payload.serviceId);

  const retainedImageReferences =
    payload.serviceType === "app" && payload.runtimeMetadata?.imageStoreMode === "docker-local"
      ? getRetainedRuntimeImageReferences(payload.runtimeMetadata)
      : [];
  if (retainedImageReferences.length > 0) {
    await removeRetainedRuntimeImages(docker, payload.runtimeMetadata);
  }

  await verifyContainerAbsent(docker, identifier);
  for (const reference of retainedImageReferences) {
    if (await docker.inspectImage(reference)) {
      throw new Error(`Docker image ${reference} still exists after cleanup`);
    }
  }

  await deleteLocalTraefikRoute(TRAEFIK_PATHS, payload.serviceId);
  return {
    runtimeInstance: {
      kind: payload.serviceType === "app" ? "app" : "database",
      status: "removed",
      containerId: payload.runtimeMetadata?.containerId ?? null,
      containerName: identifier,
    },
    cleanupProof: {
      version: 1,
      kind: "delete_service",
      container: { identifier, absent: true },
      serviceContainers: { serviceId: payload.serviceId, remainingContainerIds: [] },
      retainedImages: retainedImageReferences.map((reference) => ({
        reference,
        absent: true as const,
      })),
    } satisfies AgentCleanupProof,
  };
}

async function handleSyncRouting(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: SyncRoutingPayload & { runtimeMetadata?: RuntimeMetadata | null }
) {
  const runtimeMetadata = payload.runtimeMetadata ?? null;
  const containerName = runtimeMetadata?.containerName;

  await ensureTraefikRuntimeSerialized(docker, getTraefikRuntimeInput(config));

  const internalPort =
    typeof runtimeMetadata?.internalPort === "number"
      ? runtimeMetadata.internalPort
      : (payload.ingressPort ?? 3000);

  if (!containerName && payload.customHostnames.length > 0) {
    const placeholderUrl = new URL(config.clientIngressPlaceholderUrl);
    await writeLocalTraefikRoute(
      TRAEFIK_PATHS,
      payload.serviceId,
      { providedHostname: null, customHostnames: payload.customHostnames },
      placeholderUrl.origin,
      { passHostHeader: false, replacePath: placeholderUrl.pathname }
    );
  } else if (
    !containerName ||
    (!payload.providedHostname && payload.customHostnames.length === 0)
  ) {
    await deleteLocalTraefikRoute(TRAEFIK_PATHS, payload.serviceId);
  } else {
    await writeLocalTraefikRoute(
      TRAEFIK_PATHS,
      payload.serviceId,
      {
        providedHostname: payload.providedHostname,
        customHostnames: payload.customHostnames,
      },
      `http://${containerName}:${internalPort}`
    );
  }
  return {
    runtimeMetadata: {
      ...runtimeMetadata,
      configVersion:
        typeof runtimeMetadata?.configVersion === "number" ? runtimeMetadata.configVersion + 1 : 1,
      clientIngressConfigHash: payload.clientIngressConfigHash ?? null,
    },
  };
}

async function handleUpdateAgent(
  docker: DockerApiClient,
  payload: ReturnType<typeof toUpdateAgentPayload>
): Promise<Record<string, unknown>> {
  const imageRef = resolveUpdateAgentImageRef(payload);

  // Pull the new image before anything else
  await docker.pullImage(imageRef);

  const { updaterEnv, envInheritFlags } = buildUpdateAgentRuntimeEnv(process.env, imageRef);

  // Build the shell command that runs AFTER we report success
  const updateCmd = [
    "sleep 5",
    "docker stop nouva-agent || true",
    "docker rm nouva-agent || true",
    `docker run -d --name nouva-agent --restart unless-stopped --network host` +
      ` -v /var/run/docker.sock:/var/run/docker.sock -v /:/hostfs:ro` +
      ` -v "$NOUVA_AGENT_DATA_VOLUME:/var/lib/nouva-agent"` +
      ` ${envInheritFlags} "$NOUVA_AGENT_TARGET_IMAGE"`,
  ].join(" && ");

  // Spawn ephemeral updater (auto-removed), fires after we return
  await docker.ensureContainer(
    {
      name: "nouva-agent-updater",
      image: "docker:cli",
      cmd: ["sh", "-c", updateCmd],
      env: updaterEnv,
      hostConfig: {
        AutoRemove: true,
        NetworkMode: "host",
        Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
      },
    },
    true // replace any previous updater
  );

  return {
    scheduled: true,
    imageRef,
    ...(payload.releaseId ? { releaseId: payload.releaseId } : {}),
    ...(payload.version ? { version: payload.version } : {}),
    scheduledAt: new Date().toISOString(),
  };
}

const BUILD_LOG_WORK_KINDS = new Set<string>([
  "deploy_app",
  "redeploy_app",
  "deploy_worker",
  "redeploy_worker",
]);

/**
 * Build logs are the only window a customer has into a failed build (#181), so they are shipped
 * independently of the work item's own reporting: a build whose lease was lost or whose result was
 * rejected still leaves its output behind.
 */
function createWorkItemBuildLogPublisher(
  credentials: StoredCredentials,
  workItem: AgentWorkRecord,
  payload: Record<string, unknown>
): BuildLogPublisher | null {
  if (!BUILD_LOG_WORK_KINDS.has(workItem.kind)) {
    return null;
  }

  const deploymentId = typeof payload.deploymentId === "string" ? payload.deploymentId : "";
  if (deploymentId.length === 0) {
    return null;
  }

  return createBuildLogPublisher({
    deploymentId,
    send: (batch) =>
      apiRequest<AgentBuildLogsResponse>("/api/agent/logs/build", {
        method: "POST",
        token: credentials.agentToken,
        body: { serverId: SERVER_ID!, logs: [batch] } satisfies AgentBuildLogsRequest,
      }),
    onSendError: (error) => {
      console.error(`[nouva-agent] failed to ship build logs for work ${workItem.id}:`, error);
    },
  });
}

function createReleaseJobControlPlane(
  credentials: StoredCredentials,
  workItemId: string,
  leaseId: string
): ReleaseJobControlPlane {
  const leaseProof = { serverId: SERVER_ID!, leaseId };
  return {
    claim: (phase, context) =>
      apiRequest<ReleaseJobClaimResponse>(
        `/api/agent/work/${workItemId}/release-jobs/${phase}/claim`,
        {
          method: "POST",
          token: credentials.agentToken,
          body: { ...leaseProof, ...context } satisfies ReleaseJobClaimRequest,
        }
      ),
    report: async (phase, report) => {
      await apiRequest(`/api/agent/work/${workItemId}/release-jobs/${phase}/report`, {
        method: "POST",
        token: credentials.agentToken,
        body: { ...leaseProof, ...report },
      });
    },
  };
}

async function processWorkItem(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  credentials: StoredCredentials,
  workItem: AgentWorkRecord
) {
  console.log(`[nouva-agent] processing work ${workItem.id} (${workItem.kind})`);
  if (!workItem.leaseId) {
    console.error(`[nouva-agent] work ${workItem.id} (${workItem.kind}) failed: missing lease ID`);
    return;
  }

  const payload = toObject(workItem.payload);
  const operationalValues = collectAgentWorkPayloadOperationalValues(payload);
  const redactError = (error: unknown) =>
    redactSensitiveText(
      error instanceof Error ? error.message : "Unknown agent reporting failure",
      toRecord(payload.envVars),
      operationalValues
    );

  const leaseRenewal = startAgentWorkLeaseRenewal({
    leaseTtlSeconds: config.leaseTtlSeconds,
    renewLease: (signal) => renewAgentWorkLease(credentials, workItem, signal),
    onLeaseLost: (error) => {
      console.warn(
        `[nouva-agent] work ${workItem.id} (${workItem.kind}) lease lost: ${redactError(error)}`
      );
    },
    onTransientError: (error) => {
      console.error(
        `[nouva-agent] work ${workItem.id} (${workItem.kind}) lease renewal failed: ${redactError(error)}`
      );
    },
  });
  const leaseIsActive = await leaseRenewal.ready;
  if (!leaseIsActive) {
    await leaseRenewal.stop();
    return;
  }

  let result: Record<string, unknown> | undefined;
  const reportUnreportableResult = async (errorMessage: string): Promise<AgentTerminalReport> => {
    await rollbackUnreportableWorkResult(docker, {
      kind: workItem.kind,
      workItemId: workItem.id,
      payload,
      result,
    });
    return { kind: "fail", result: null, errorMessage: redactError(new Error(errorMessage)) };
  };
  await executeAndReportAgentWork({
    work: workItem,
    stopLease: () => leaseRenewal.stop(),
    redactError,
    send: async (report) => {
      await apiRequest(`/api/agent/work/${workItem.id}/${report.kind}`, {
        method: "POST",
        token: credentials.agentToken,
        body: {
          serverId: SERVER_ID!,
          leaseId: workItem.leaseId,
          result: report.result,
          ...(report.kind === "fail" ? { errorMessage: report.errorMessage } : {}),
        },
      });
    },
    rejectResult: (error) =>
      reportUnreportableResult(
        readApiRequestErrorMessage(error, "Agent work result was rejected by the control plane")
      ),
    prepare: async () => {
      const buildLogPublisher = createWorkItemBuildLogPublisher(credentials, workItem, payload);
      const releasePhases = createReleasePhaseRunner({
        docker,
        controlPlane: createReleaseJobControlPlane(credentials, workItem.id, workItem.leaseId!),
        clock: { now: () => Date.now(), sleep },
        ...(buildLogPublisher ? { onBuildLog: buildLogPublisher.emit } : {}),
      });

      let failureResult: Record<string, unknown> | undefined;
      let workError: Error | null = null;

      try {
        switch (workItem.kind) {
          case "deploy_app":
          case "redeploy_app":
            // App deploy payloads are hydrated at lease time with the live service runtime metadata.
            result = await handleBuildAndDeployApp(
              docker,
              config,
              payload as unknown as AppDeployPayload,
              buildLogPublisher?.emit,
              releasePhases
            );
            break;
          case "rollback_app":
            result = await handleDeployOnlyApp(
              docker,
              config,
              payload as unknown as DeployOnlyPayload
            );
            break;
          case "deploy_worker":
          case "redeploy_worker":
            result = await handleBuildAndDeployWorker(
              docker,
              config,
              payload as unknown as WorkerDeployPayload,
              buildLogPublisher?.emit,
              releasePhases
            );
            break;
          case "rollback_worker":
          case "scale_worker":
            result = await handleDeployOnlyWorker(docker, config, {
              ...(payload as unknown as WorkerDeployOnlyPayload),
              runtimeMetadata: toRuntimeMetadata(payload.runtimeMetadata),
            });
            break;
          case "restart_app":
          case "restart_database":
            result = await handleRestartService(docker, config, workItem.kind, {
              ...(payload as unknown as RestartServicePayload),
              runtimeMetadata: toRuntimeMetadata(payload.runtimeMetadata),
            });
            break;
          case "restart_worker":
            result = await restartWorkerServiceRuntime(docker, {
              serviceId: String(payload.serviceId),
              runtimeMetadata: toRuntimeMetadata(payload.runtimeMetadata),
              shutdownPolicy: payload.shutdownPolicy,
            });
            break;
          case "remove_app":
            result = await handleRemove(
              docker,
              String(payload.serviceId),
              toRuntimeMetadata(payload.runtimeMetadata),
              String(payload.deploymentId ?? "")
            );
            break;
          case "remove_worker":
            result = await removeWorkerServiceRuntime(docker, {
              serviceId: String(payload.serviceId),
              runtimeMetadata: toRuntimeMetadata(payload.runtimeMetadata),
            });
            break;
          case "start_worker_job":
            result = await startWorkerJob(
              docker,
              getWorkerRuntimeEnvironment(config),
              payload as unknown as WorkerJobPayload
            );
            break;
          case "inspect_worker_job":
            result = await inspectWorkerJob(
              docker,
              getWorkerRuntimeEnvironment(config),
              payload as unknown as WorkerJobLifecyclePayload
            );
            break;
          case "stop_worker_job":
            result = await stopWorkerJob(
              docker,
              getWorkerRuntimeEnvironment(config),
              payload as unknown as WorkerJobLifecyclePayload
            );
            break;
          case "cleanup_worker_job":
            result = await cleanupWorkerJob(
              docker,
              getWorkerRuntimeEnvironment(config),
              payload as unknown as WorkerJobLifecyclePayload
            );
            break;
          case "provision_database":
            result = await handleDatabaseProvision(
              docker,
              config,
              payload as unknown as DatabaseProvisionPayload
            );
            break;
          case "apply_database_volume":
            result = await handleApplyDatabaseVolume(docker, config, {
              ...(payload as unknown as DatabaseProvisionPayload),
              runtimeMetadata: toRuntimeMetadata(payload.runtimeMetadata),
            });
            break;
          case "delete_service":
            result = await handleDeleteService(docker, {
              ...(payload as unknown as RemoveServicePayload),
              runtimeMetadata: toRuntimeMetadata(payload.runtimeMetadata),
            });
            break;
          case "delete_volume":
            result = await handleDeleteVolume(docker, payload as unknown as DeleteVolumePayload);
            break;
          case "delete_project":
            result = await handleDeleteProject(docker, payload as unknown as DeleteProjectPayload);
            break;
          case "wipe_volume":
            result = await handleWipeVolume(
              docker,
              config,
              "serviceId" in payload
                ? {
                    ...(payload as unknown as DatabaseProvisionPayload),
                    runtimeMetadata: toRuntimeMetadata(payload.runtimeMetadata),
                  }
                : (payload as unknown as DeleteVolumePayload),
              { workItemId: workItem.id }
            );
            break;
          case "create_volume_backup":
            result = await handleCreateVolumeBackup(
              docker,
              config,
              payload as unknown as CreateVolumeBackupPayload
            );
            break;
          case "delete_volume_backup":
            result = await handleDeleteVolumeBackup(
              docker,
              config,
              payload as unknown as DeleteVolumeBackupPayload
            );
            break;
          case "restore_volume_backup":
            result = await handleRestoreVolumeBackup(
              docker,
              config,
              payload as unknown as RestoreVolumeBackupPayload
            );
            break;
          case "restore_postgres_pitr":
            result = await handleRestorePostgresPitr(
              docker,
              config,
              payload as unknown as RestorePostgresPitrPayload
            );
            break;
          case "import_external_backup":
            result = await handleImportExternalBackup(
              docker,
              config,
              payload as unknown as ImportExternalBackupPayload
            );
            break;
          case "expire_volume_backup_repository":
            result = await handleExpireVolumeBackupRepository(
              docker,
              config,
              payload as unknown as ExpireVolumeBackupRepositoryPayload
            );
            break;
          case "reconcile_service_resources":
            result = await handleReconcileServiceResources(
              docker,
              payload as unknown as ReconcileServiceResourcesPayload
            );
            break;
          case "sync_routing":
            result = await handleSyncRouting(docker, config, {
              ...(payload as unknown as SyncRoutingPayload),
              runtimeMetadata: toRuntimeMetadata(payload.runtimeMetadata),
            });
            break;
          case "update_agent":
            result = await handleUpdateAgent(docker, toUpdateAgentPayload(payload));
            break;
          default:
            throw new Error(`Unsupported work kind: ${workItem.kind}`);
        }
      } catch (err) {
        if (
          err instanceof AppRolloutError ||
          err instanceof WorkerRolloutError ||
          err instanceof ExternalBackupImportError ||
          err instanceof ReleaseJobHaltError
        ) {
          failureResult = err.result;
        }
        workError = err instanceof Error ? err : new Error("Unknown agent work failure");
      }

      if (workError instanceof ReleaseJobDeferredError) {
        // No terminal report: the control plane either requeued the work when it answered the
        // claim, or hands it out again once this lease expires. The next lease opens a new log.
        await buildLogPublisher?.close();
        return { kind: "released", reason: workError.message };
      }

      if (buildLogPublisher) {
        buildLogPublisher.emit({
          type: "exit",
          timestamp: Date.now(),
          success: workError === null,
          exitCode: workError === null ? 0 : 1,
          message: workError
            ? redactSensitiveText(workError.message, toRecord(payload.envVars), operationalValues)
            : "Deployment finished",
        });
        await buildLogPublisher.close();
      }

      if (leaseRenewal.leaseLost()) {
        // The work is finished either way, and the control plane now accepts a terminal report from a
        // lease nothing else has claimed (#186). Report it and let the control plane decide: if the
        // lease is genuinely gone the report answers 409 and the branches below drop it, which costs
        // one request instead of discarding a build that has already run to completion.
        console.warn(
          `[nouva-agent] work ${workItem.id} finished locally after a lease renewal failed; ` +
            "reporting anyway"
        );
      }

      if (workError) {
        const report = buildAgentWorkFailureReport({
          environmentVariables: toRecord(payload.envVars),
          errorMessage: workError.message,
          operationalValues,
          result: failureResult ?? null,
        });
        return { kind: "fail", result: report.result, errorMessage: report.errorMessage };
      }
      try {
        return {
          kind: "complete",
          result: sanitizeAgentWorkResult(result, toRecord(payload.envVars), operationalValues),
        };
      } catch (error) {
        if (!(error instanceof AgentWorkResultRedactionConflictError)) throw error;
        return await reportUnreportableResult(error.message);
      }
    },
  });
}

async function collectMetrics(docker: DockerApiClient): Promise<AgentMetricsEnvelope> {
  const [currentCpuStat, previousCpuStat, meminfo, loadavg, disk] = await Promise.all([
    readFile("/hostfs/proc/stat", "utf8"),
    readFile(path.join(DATA_DIR, "last-cpu-stat"), "utf8").catch(() => ""),
    readFile("/hostfs/proc/meminfo", "utf8"),
    readFile("/hostfs/proc/loadavg", "utf8").catch(() => ""),
    inspectDockerStorageFilesystem(docker),
  ]);

  const serverMetrics = parseHostMetricsSnapshot({
    currentCpuStat,
    previousCpuStat,
    meminfo,
    loadavg,
    diskAvailableBytes: disk.diskAvailableBytes,
    diskTotalBytes: disk.diskTotalBytes,
  });
  await writeFile(path.join(DATA_DIR, "last-cpu-stat"), currentCpuStat);

  const containers = await docker.listManagedContainers();
  const services = [];
  for (const container of containers) {
    if (container.State !== "running") {
      continue;
    }

    const labels = container.Labels ?? {};
    const serviceId = labels["nouva.service.id"];
    if (!serviceId) {
      continue;
    }

    const parsed = await docker.containerStats(container.Id);
    services.push({
      serviceId,
      deploymentId: labels["nouva.deployment.id"] ?? null,
      runtimeInstanceId: null,
      ...parsed,
      raw: null,
      collectedAt: new Date().toISOString(),
    });
  }

  return {
    server: serverMetrics,
    services,
  };
}

/**
 * Docker computes local volume sizes by walking each volume directory on every /system/df call,
 * so this is sampled far less often than host and container metrics. Reservation admission
 * tolerates the lower resolution: stale usage is simply not credited back as reservable capacity.
 */
async function collectVolumeUsage(docker: DockerApiClient): Promise<AgentMetricsEnvelope> {
  const volumeUsage = await docker.listManagedVolumeDiskUsage();

  return {
    volumes: volumeUsage.map((volume) => ({
      volumeName: volume.volumeName,
      usedBytes: volume.usedBytes,
      raw: volume.raw,
      collectedAt: new Date().toISOString(),
    })),
  };
}

async function syncPostgresObservability(
  docker: DockerApiClient,
  credentials: StoredCredentials
): Promise<number> {
  const samples = await collectPostgresObservabilitySamples(docker);
  if (samples.length === 0) {
    return 0;
  }

  const response = await apiRequest<AgentPostgresObservabilityResponse>(
    "/api/agent/observability/postgres",
    {
      method: "POST",
      token: credentials.agentToken,
      body: {
        serverId: SERVER_ID!,
        samples,
      } satisfies AgentPostgresObservabilityRequest,
    }
  );

  return response.accepted;
}

async function main() {
  assertAgentBootstrapEnv();
  await mkdir(DATA_DIR, { recursive: true });
  const docker = await DockerApiClient.create();
  let credentials = await readCredentials();
  let config = getAgentRuntimeConfig();

  if (!credentials?.agentToken) {
    const registered = await registerAgent(docker, config);
    credentials = registered.credentials;
    config = registered.config;
  }

  config = await sendHeartbeat(docker, credentials, config);
  let postgresObservabilityLoopActive = false;
  let isShuttingDown = false;
  const volumeMetricsCollector = createVolumeMetricsCollector(async () => {
    const metrics = await collectVolumeUsage(docker);
    await apiRequest("/api/agent/metrics", {
      method: "POST",
      token: credentials!.agentToken,
      body: {
        serverId: SERVER_ID!,
        ...metrics,
      } satisfies AgentMetricsRequest,
    });
  });
  const workScheduler = createBoundedWorkScheduler<AgentRuntimeConfig, AgentWorkRecord>({
    maxConcurrency: MAX_PARALLEL_AGENT_WORK_ITEMS,
    leaseWork: (limit, activeWorkItemIds) =>
      apiRequest<AgentLeaseResponse>("/api/agent/work/lease", {
        method: "POST",
        token: credentials!.agentToken,
        body: {
          serverId: SERVER_ID!,
          limit,
          activeWorkItemIds: [...activeWorkItemIds],
        },
      }),
    processWork: (leasedConfig, workItem) =>
      processWorkItem(docker, leasedConfig, credentials!, workItem),
    onConfig: (leasedConfig) => {
      config = leasedConfig;
    },
    onWorkError: (error, workItem) => {
      console.error(`[nouva-agent] work ${workItem.id} failed outside its handler`, error);
    },
  });

  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("[nouva-agent] shutting down, draining work and log loops...");
    const deadline = Date.now() + 9_000;
    while (
      (workScheduler.isActive() ||
        postgresObservabilityLoopActive ||
        volumeMetricsCollector.isActive()) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });

  const heartbeatLoop = createAgentHeartbeatLoop({
    runTick: async (signal) => {
      config = await sendHeartbeat(docker, credentials!, config, signal);
    },
    nextDelayMs: () =>
      (config.observability.enabled
        ? Math.min(config.heartbeatIntervalSeconds, 30)
        : config.heartbeatIntervalSeconds) * 1000,
    isStopped: () => isShuttingDown,
    onFailure: (error, failures, limit) => {
      console.error(`[nouva-agent] heartbeat failed (${failures}/${limit})`, error);
    },
    onFailureLimit: () => {
      console.error("[nouva-agent] too many heartbeat failures, exiting");
      process.exit(1);
    },
  });
  heartbeatLoop.start();

  setInterval(() => {
    if (config.observability.enabled || isShuttingDown) {
      return;
    }

    collectMetrics(docker)
      .then((metrics) =>
        apiRequest("/api/agent/metrics", {
          method: "POST",
          token: credentials!.agentToken,
          body: {
            serverId: SERVER_ID!,
            ...metrics,
          } satisfies AgentMetricsRequest,
        })
      )
      .catch((error) => {
        console.error("[nouva-agent] metrics failed", error);
      });
  }, config.metricsIntervalSeconds * 1000);

  // Continuing database health is reported through the heartbeat rather than metrics: it must keep
  // working when Alloy owns telemetry, and a dead container produces no metrics at all.
  let databaseRuntimeHealthPassActive = false;
  setInterval(() => {
    if (databaseRuntimeHealthPassActive || isShuttingDown) {
      return;
    }

    databaseRuntimeHealthPassActive = true;
    refreshDatabaseRuntimeHealth(docker, config)
      .catch((error) => {
        console.error("[nouva-agent] database runtime health failed", error);
      })
      .finally(() => {
        databaseRuntimeHealthPassActive = false;
      });
  }, DATABASE_RUNTIME_HEALTH_INTERVAL_MS);

  // Volume usage backs reservation admission, so it is reported even when Alloy owns the rest
  // of the telemetry pipeline.
  void volumeMetricsCollector.trigger().catch((error) => {
    console.error("[nouva-agent] volume usage failed", error);
  });

  setInterval(() => {
    if (isShuttingDown) {
      return;
    }

    void volumeMetricsCollector.trigger().catch((error) => {
      console.error("[nouva-agent] volume usage failed", error);
    });
  }, AGENT_VOLUME_METRICS_INTERVAL_MS);

  if (config.postgresObservabilityIntervalSeconds > 0) {
    setInterval(() => {
      if (postgresObservabilityLoopActive || isShuttingDown) {
        return;
      }

      postgresObservabilityLoopActive = true;
      syncPostgresObservability(docker, credentials!)
        .catch((error) => {
          console.error("[nouva-agent] postgres observability sync failed", error);
        })
        .finally(() => {
          postgresObservabilityLoopActive = false;
        });
    }, config.postgresObservabilityIntervalSeconds * 1000);
  }

  setInterval(() => {
    if (isShuttingDown) {
      return;
    }

    void workScheduler.trigger().catch((error) => {
      console.error("[nouva-agent] work loop failed", error);
    });
  }, config.pollIntervalSeconds * 1000);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("[nouva-agent] fatal", error);
    process.exit(1);
  });
}
