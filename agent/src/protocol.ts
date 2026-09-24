import type { AgentServerMetricPayload } from "@repo/runtime/agent-metrics";

export type {
  AgentMetricsEnvelope,
  AgentMetricsRequest,
  AgentMetricsResponse,
  AgentServerMetricPayload,
  AgentServiceMetricPayload,
  AgentVolumeMetricPayload,
} from "@repo/runtime/agent-metrics";

export const SERVER_CHECK_STATUSES = ["pass", "warn", "fail"] as const;
export type ServerCheckStatus = (typeof SERVER_CHECK_STATUSES)[number];

export const AGENT_WORK_STATUSES = [
  "queued",
  "leased",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AgentWorkStatus = (typeof AGENT_WORK_STATUSES)[number];

export const AGENT_WORK_KINDS = [
  "deploy_app",
  "redeploy_app",
  "rollback_app",
  "restart_app",
  "remove_app",
  "deploy_worker",
  "redeploy_worker",
  "rollback_worker",
  "scale_worker",
  "restart_worker",
  "remove_worker",
  "start_worker_job",
  "inspect_worker_job",
  "stop_worker_job",
  "cleanup_worker_job",
  "provision_database",
  "apply_database_volume",
  "restart_database",
  "delete_service",
  "delete_volume",
  "delete_project",
  "wipe_volume",
  "create_volume_backup",
  "delete_volume_backup",
  "restore_volume_backup",
  "restore_postgres_pitr",
  "import_external_backup",
  "expire_volume_backup_repository",
  "reconcile_service_resources",
  "sync_routing",
  "update_agent",
] as const;
export type AgentWorkKind = (typeof AGENT_WORK_KINDS)[number];

export type AgentCleanupProof =
  | {
      version: 1;
      kind: "delete_service";
      serviceContainers: { serviceId: string; remainingContainerIds: [] };
      container: { identifier: string | null; absent: true };
      retainedImages: Array<{ reference: string; absent: true }>;
    }
  | {
      version: 1;
      kind: "delete_volume";
      volume: { name: string; absent: true };
    }
  | {
      version: 1;
      kind: "delete_project";
      network: { name: string; absent: true };
    }
  | {
      version: 1;
      kind: "wipe_volume";
      previousContainer: { identifier: string | null; absent: true };
      previousVolume: { name: string; absent: true };
      replacementVolume: { name: string; present: true };
    }
  | {
      version: 1;
      kind: "delete_worker";
      serviceContainers: { serviceId: string; remainingContainerIds: [] };
      containers: Array<{ identifier: string; absent: true }>;
      retainedImages: Array<{ reference: string; absent: true }>;
    }
  | {
      version: 1;
      kind: "cleanup_worker_job";
      container: { identifier: string; absent: true };
    };

export type ServerValidationCheck = {
  key: string;
  label: string;
  status: ServerCheckStatus;
  message: string;
  value?: string | null;
};

export type ServerValidationReport = {
  checkedAt: string;
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
  checks: ServerValidationCheck[];
};

export type AgentImageStoreMode = "docker-local" | "local-registry";

export interface RuntimeRetainedImage {
  reference: string;
  imageId: string | null;
  deploymentId?: string | null;
  commitHash?: string | null;
}

export type RuntimeMetadata = {
  configVersion?: number;
  ingressHost?: string | null;
  ingressPort?: number | null;
  publishedPort?: number | null;
  internalPort?: number | null;
  image?: string | null;
  imageStoreMode?: AgentImageStoreMode | null;
  currentImage?: RuntimeRetainedImage | null;
  previousImage?: RuntimeRetainedImage | null;
  containerId?: string | null;
  containerName?: string | null;
  networkName?: string | null;
  runtimeInstanceId?: string | null;
  clientIngressConfigHash?: string | null;
  replicaCount?: number | null;
  replicas?: Array<{
    replicaIndex: number;
    containerId: string | null;
    containerName: string;
  }>;
  detectedEntrypoint?: string[] | null;
  detectedCommand?: string[] | null;
  [key: string]: unknown;
};

export type AppRolloutStrategy = "candidate_ready_cutover" | "single_writer_snapshot_cutover";
export type AppRolloutPhase =
  | "quiesce"
  | "snapshot"
  | "candidate"
  | "ready"
  | "cutover"
  | "retire"
  | "restore"
  | "rollback";
export type AppRolloutOutcome = "committed" | "aborted_before_cutover" | "rolled_back";

export interface AppRolloutReadinessConfig {
  timeoutMs: number;
  intervalMs: number;
  tcpConnectTimeoutMs: number;
}

export interface AppRolloutCutoverConfig {
  verificationTimeoutMs: number;
  verificationIntervalMs: number;
}

export interface AppRolloutDrainConfig {
  durationMs: number;
  gracefulStopTimeoutSeconds: number;
  cleanupTimeoutMs: number;
}

export interface AppRolloutConfig {
  strategy: AppRolloutStrategy;
  readiness: AppRolloutReadinessConfig;
  cutover: AppRolloutCutoverConfig;
  drain: AppRolloutDrainConfig;
}

export interface AppRolloutResult {
  /** Locally adopted a running candidate; control-plane commitment may still be unknown. */
  reusedCandidate?: boolean;
  strategy: AppRolloutStrategy;
  outcome: AppRolloutOutcome;
  currentPhase: AppRolloutPhase;
  liveRuntimePreserved: boolean;
  rollbackCompleted: boolean;
  drainDurationMs?: number;
  previousContainerRetirement?: "graceful" | "forced" | "deferred" | null;
  activeContainerName?: string | null;
  candidateContainerName?: string | null;
}

export const DEFAULT_APP_ROLLOUT_CONFIG: AppRolloutConfig = {
  strategy: "candidate_ready_cutover",
  readiness: {
    timeoutMs: 60_000,
    intervalMs: 500,
    tcpConnectTimeoutMs: 2_000,
  },
  cutover: {
    verificationTimeoutMs: 15_000,
    verificationIntervalMs: 250,
  },
  drain: {
    durationMs: 30_000,
    gracefulStopTimeoutSeconds: 10,
    cleanupTimeoutMs: 15_000,
  },
};

export function resolveAppRolloutConfig(config?: AppRolloutConfig | null): AppRolloutConfig {
  return {
    strategy: config?.strategy ?? DEFAULT_APP_ROLLOUT_CONFIG.strategy,
    readiness: {
      timeoutMs: config?.readiness?.timeoutMs ?? DEFAULT_APP_ROLLOUT_CONFIG.readiness.timeoutMs,
      intervalMs: config?.readiness?.intervalMs ?? DEFAULT_APP_ROLLOUT_CONFIG.readiness.intervalMs,
      tcpConnectTimeoutMs:
        config?.readiness?.tcpConnectTimeoutMs ??
        DEFAULT_APP_ROLLOUT_CONFIG.readiness.tcpConnectTimeoutMs,
    },
    cutover: {
      verificationTimeoutMs:
        config?.cutover?.verificationTimeoutMs ??
        DEFAULT_APP_ROLLOUT_CONFIG.cutover.verificationTimeoutMs,
      verificationIntervalMs:
        config?.cutover?.verificationIntervalMs ??
        DEFAULT_APP_ROLLOUT_CONFIG.cutover.verificationIntervalMs,
    },
    drain: {
      durationMs: config?.drain?.durationMs ?? DEFAULT_APP_ROLLOUT_CONFIG.drain.durationMs,
      gracefulStopTimeoutSeconds:
        config?.drain?.gracefulStopTimeoutSeconds ??
        DEFAULT_APP_ROLLOUT_CONFIG.drain.gracefulStopTimeoutSeconds,
      cleanupTimeoutMs:
        config?.drain?.cleanupTimeoutMs ?? DEFAULT_APP_ROLLOUT_CONFIG.drain.cleanupTimeoutMs,
    },
  };
}

export interface ServiceResourceLimits {
  cpuMillicores?: number;
  memoryBytes?: number;
  /** Combined RAM-and-swap ceiling in bytes, in Docker's `MemorySwap` units. */
  memoryAndSwapBytes?: number;
}

export interface EffectiveServiceResourceLimits {
  cpuMillicores: number;
  memoryBytes: number;
  /**
   * Combined RAM-and-swap ceiling. Always >= `memoryBytes`; equal means no swap allowance. Older
   * control planes omit it, which `toDockerResourceSettings` reads as the same no-swap policy.
   */
  memoryAndSwapBytes?: number;
  pidsLimit: number;
  policyVersion: number;
}

export const APP_BUILD_TYPES = ["railpack", "dockerfile", "static"] as const;
export type AppBuildType = (typeof APP_BUILD_TYPES)[number];

export interface AppRailpackBuildConfig {
  buildRoot: string;
}

export interface AppDockerfileBuildConfig {
  buildRoot: string;
  dockerfilePath: string;
  dockerContextPath: string;
  dockerBuildStage?: string | null;
}

export interface AppStaticBuildConfig {
  buildRoot: string;
  publishDirectory: string;
  spaFallback: boolean;
}

export type AppBuildConfig =
  | AppRailpackBuildConfig
  | AppDockerfileBuildConfig
  | AppStaticBuildConfig;

export type AgentCapabilities = {
  dockerApi?: boolean;
  buildkit?: boolean;
  localRegistry?: boolean;
  localTraefik?: boolean;
  alloyObservability?: boolean;
  traefikRequestMetrics?: boolean;
  hostMetrics?: boolean;
  containerMetrics?: boolean;
  postgresObservability?: boolean;
  cleanupProofV1?: boolean;
  serviceScopedCleanupV1?: boolean;
  resourceIsolationV1?: boolean;
  projectNetworkIsolationV1?: boolean;
  appVolumeRolloutV1?: boolean;
  publicPortPreflightV1?: boolean;
  backupIntegrityV1?: boolean;
  mysqlBackupsV1?: boolean;
  managedVolumeCapacityV1?: boolean;
  workerServicesV1?: boolean;
  workerVolumeRolloutV1?: boolean;
  externalBackupImportV1?: boolean;
  postgresRepositoryLineageV1?: boolean;
  workerShutdownPolicyV1?: boolean;
  [key: string]: boolean | undefined;
};

export const DEFAULT_AGENT_HEARTBEAT_INTERVAL_SECONDS = 30;
export const DEFAULT_AGENT_POLL_INTERVAL_SECONDS = 10;
export const DEFAULT_AGENT_LEASE_TTL_SECONDS = 120;
export const DEFAULT_AGENT_METRICS_INTERVAL_SECONDS = 30;
export const DEFAULT_AGENT_POSTGRES_OBSERVABILITY_INTERVAL_SECONDS = 30;
export const MAX_PARALLEL_AGENT_WORK_ITEMS = 4;

export type AgentIngressMode = "local_traefik";
export type AgentBuildkitMode = "docker-container";

export type AgentRedactionContextScopeKind = "deployment" | "database";

export interface AgentRedactionContextScopeVersion {
  kind: AgentRedactionContextScopeKind;
  id: string;
  version: string;
}

export interface AgentObservabilityConfig {
  enabled: boolean;
  organizationId: string | null;
  redactionContextVersion?: string | null;
  /** Present on registration and heartbeat responses only; lease responses omit it. */
  redactionContextScopeVersions?: AgentRedactionContextScopeVersion[];
  alloyImage: string;
  scrapeIntervalSeconds: number;
  collectorScope: "services_traefik_and_workers";
  noneLabelValue: "__none__";
}

export interface AgentRuntimeConfig {
  heartbeatIntervalSeconds: number;
  pollIntervalSeconds: number;
  leaseTtlSeconds: number;
  metricsIntervalSeconds: number;
  postgresObservabilityIntervalSeconds: number;
  ingressMode: AgentIngressMode;
  buildkitMode: AgentBuildkitMode;
  imageStoreMode: AgentImageStoreMode;
  capabilities: AgentCapabilities;
  localRegistryHost: string;
  localRegistryPort: number;
  localTraefikNetwork: string;
  clientIngressPlaceholderUrl: string;
  /** Edge peers whose forwarding headers the local proxy keeps. The control plane owns this list. */
  trustedForwardedPeers: string[];
  observability: AgentObservabilityConfig;
  privateRegistry?: {
    host: string;
    username: string;
    password: string;
  };
}

export type AgentDatabaseRuntimeHealthState = "ready" | "unavailable" | "unknown";

/**
 * Why a managed database container was reported in its state. The set is closed so a report can
 * never carry container log text, probe output, or other untrusted material.
 */
export type AgentDatabaseRuntimeHealthReason =
  | "authenticated_probe_succeeded"
  | "container_missing"
  | "container_restarting"
  | "container_exited"
  | "container_paused"
  | "incompatible_host_kernel"
  | "probe_unavailable";

export interface AgentDatabaseRuntimeHealthObservation {
  serviceId: string;
  containerId: string | null;
  containerName: string;
  engine: string;
  state: AgentDatabaseRuntimeHealthState;
  reason: AgentDatabaseRuntimeHealthReason;
  observedAt: string;
}

/** The server's complete inventory of managed database containers at `observedAt`. */
export interface AgentDatabaseRuntimeHealthReport {
  observedAt: string;
  containers: AgentDatabaseRuntimeHealthObservation[];
}

export interface AgentRegistrationSnapshot {
  serverId: string;
  hostname: string;
  operatingSystem: string | null;
  architecture: string | null;
  /** The host kernel release exactly as `uname -r` reports it; see `collectValidationSnapshot`. */
  kernelRelease?: string | null;
  dockerVersion: string | null;
  agentVersion: string;
  publicIp: string | null;
  cpuCores: number | null;
  memoryBytes: number | null;
  diskBytesAvailable: number | null;
  diskTotalBytes: number | null;
  latestValidationReport: ServerValidationReport | null;
  capabilities?: AgentCapabilities | null;
  /** Omitted until the agent has completed one full observation pass; never partially populated. */
  databaseRuntimeHealth?: AgentDatabaseRuntimeHealthReport | null;
}

export interface AgentWorkRecord {
  id: string;
  serverId: string;
  projectId: string | null;
  serviceId: string | null;
  deploymentId: string | null;
  kind: AgentWorkKind;
  status: AgentWorkStatus;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
  maxAttempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export type PostgresObservabilityExtensionStatus = {
  pgStatMonitor: boolean;
  pgCron: boolean;
};

export type PostgresObservabilityActiveSession = {
  state: string;
  count: number;
};

export type PostgresObservabilitySlowQuery = {
  queryId: string;
  query: string;
  calls: number;
  rows: number;
  totalTimeMs: number;
  meanTimeMs: number;
  minTimeMs: number;
  maxTimeMs: number;
};

export type PostgresObservabilitySampleStatus = "success" | "error";

export type PostgresWalArchiveHealth = {
  status: "healthy" | "degraded" | "pending" | "unknown";
  archiveMode: string;
  archiveCommandConfigured: boolean;
  archivedCount: number;
  failedCount: number;
  lastArchivedWal: string | null;
  lastArchivedAt: string | null;
  lastFailedWal: string | null;
  lastFailedAt: string | null;
  reason: string | null;
};

export interface PostgresObservabilitySnapshot {
  collectedAt: string;
  extensionStatus: PostgresObservabilityExtensionStatus;
  activeSessions: PostgresObservabilityActiveSession[];
  slowQueries: PostgresObservabilitySlowQuery[];
  walArchiveHealth: PostgresWalArchiveHealth;
  queryInsightsError?: string | null;
}

export interface AgentPostgresObservabilitySample {
  serviceId: string;
  collectedAt: string;
  status: PostgresObservabilitySampleStatus;
  errorMessage?: string | null;
  extensionStatus?: PostgresObservabilityExtensionStatus | null;
  activeSessions?: PostgresObservabilityActiveSession[] | null;
  slowQueries?: PostgresObservabilitySlowQuery[] | null;
  walArchiveHealth?: PostgresWalArchiveHealth | null;
}

export interface AgentPostgresObservabilityRequest {
  serverId: string;
  samples: AgentPostgresObservabilitySample[];
}

export interface AgentPostgresObservabilityResponse {
  ok: true;
  accepted: number;
}

export interface AgentWorkLeaseResult {
  config: AgentRuntimeConfig;
  workItems: AgentWorkRecord[];
}

export interface UpdateAgentPayload {
  releaseId?: string;
  version?: string;
  imageRef?: string;
  imageTag?: string;
}

export interface AppDeployPayload {
  repoUrl: string;
  commitHash: string;
  commitMessage: string;
  branch: string;
  subdomain: string;
  serviceName: string;
  projectId: string;
  environmentId?: string | null;
  serviceId: string;
  deploymentId: string;
  redactionContextVersion?: string;
  // Added by the control plane during lease hydration, never stored in queued work.
  envVars: Record<string, string>;
  /**
   * The subset of `envVars` the platform generated rather than the customer typing it. The build
   * log redactor masks one of these only where it stands as its own word, so `require` from
   * `PGSSLMODE` stops eating the word inside `requirements.txt` (#219, #245). Absent on a payload
   * from a control plane older than the field, which keeps the previous, stricter rule.
   */
  platformGeneratedValues?: string[];
  appBuildType?: AppBuildType | null;
  appBuildConfig?: AppBuildConfig | null;
  volume?: AppVolumeIdentity | null;
  resourceLimits: EffectiveServiceResourceLimits;
  buildCommand?: string;
  startCommand?: string;
  rollout?: AppRolloutConfig | null;
  runtimeMetadata?: RuntimeMetadata | null;
  providedHostname?: string;
  customHostnames?: string[];
  clientIngressConfigHash?: string;
}

export interface DeployOnlyPayload {
  imageUrl: string;
  commitHash: string;
  commitMessage: string;
  subdomain: string;
  projectId: string;
  environmentId?: string | null;
  serviceId: string;
  deploymentId: string;
  redactionContextVersion?: string;
  // Added by the control plane during lease hydration, never stored in queued work.
  envVars: Record<string, string>;
  volume?: AppVolumeIdentity | null;
  resourceLimits: EffectiveServiceResourceLimits;
  rollout?: AppRolloutConfig | null;
  runtimeMetadata?: RuntimeMetadata | null;
  providedHostname?: string;
  customHostnames?: string[];
  clientIngressConfigHash?: string;
}

/**
 * Workers share app build inputs, but are intentionally not ingress services.
 * A non-blank start command is executed by the agent through `/bin/sh -lc`.
 */
export interface WorkerDeployPayload {
  repoUrl: string;
  commitHash: string;
  commitMessage: string;
  branch: string;
  serviceName: string;
  projectId: string;
  environmentId?: string | null;
  serviceId: string;
  deploymentId: string;
  redactionContextVersion?: string;
  // Added by the control plane during lease hydration, never stored in queued work.
  envVars: Record<string, string>;
  /**
   * The subset of `envVars` the platform generated rather than the customer typing it. The build
   * log redactor masks one of these only where it stands as its own word, so `require` from
   * `PGSSLMODE` stops eating the word inside `requirements.txt` (#219, #245). Absent on a payload
   * from a control plane older than the field, which keeps the previous, stricter rule.
   */
  platformGeneratedValues?: string[];
  appBuildType?: Exclude<AppBuildType, "static"> | null;
  appBuildConfig?: AppBuildConfig | null;
  startCommand: string | null;
  healthCheckCommand: string | null;
  replicaCount: number;
  /**
   * The worker's shutdown signal, grace period and rollout policy (#284), unvalidated as it came
   * off the wire. The worker runtime parses it and falls back to the default policy when a control
   * plane older than the field leaves it out.
   */
  shutdownPolicy?: unknown;
  volume?: AppVolumeIdentity | null;
  resourceLimits: EffectiveServiceResourceLimits;
  runtimeMetadata?: RuntimeMetadata | null;
}

export interface WorkerDeployOnlyPayload {
  imageUrl: string;
  commitHash: string;
  commitMessage: string;
  serviceName: string;
  projectId: string;
  environmentId?: string | null;
  serviceId: string;
  deploymentId: string;
  redactionContextVersion?: string;
  // Added by the control plane during lease hydration, never stored in queued work.
  envVars: Record<string, string>;
  startCommand: string | null;
  healthCheckCommand: string | null;
  replicaCount: number;
  /** See `WorkerDeployPayload.shutdownPolicy`. */
  shutdownPolicy?: unknown;
  volume?: AppVolumeIdentity | null;
  resourceLimits: EffectiveServiceResourceLimits;
  runtimeMetadata?: RuntimeMetadata | null;
}

export interface WorkerJobPayload {
  projectId: string;
  environmentId?: string | null;
  serviceId: string;
  deploymentId: string;
  redactionContextVersion?: string;
  scheduleId: string;
  scheduleRunId: string;
  occurrenceKey: string;
  jobName: string;
  imageUrl: string;
  // Added by the control plane during lease hydration, never stored in queued work.
  envVars: Record<string, string>;
  command: string;
  timeoutSeconds: number;
  volume?: AppVolumeIdentity | null;
  resourceLimits: EffectiveServiceResourceLimits;
  runtimeMetadata?: RuntimeMetadata | null;
}

/**
 * Inspection, timeout, and cleanup work intentionally carry only the durable
 * run identity. The agent derives image and occurrence details from its receipt.
 */
export interface WorkerJobLifecyclePayload {
  projectId?: string;
  serviceId: string;
  deploymentId?: string;
  scheduleId?: string | null;
  scheduleRunId: string;
  jobName?: string;
  timeoutSeconds?: number;
  reason?: string;
}

export interface AppVolumeIdentity {
  volumeId: string;
  volumeName: string;
  mountPath: string;
}

export type DatabaseServiceVariant = "postgres" | "mongodb" | "redis" | "mysql";
export type BackupDatabaseServiceVariant = "postgres" | "mongodb" | "redis" | "mysql";

export type VolumeBackupArtifactFormat =
  | "mongodb-archive-tar-v1"
  | "redis-rdb-tar-v1"
  | "mysql-dump-tar-v1"
  | "pgbackrest-v1";

export interface DatabaseProvisionPayload {
  projectId: string;
  environmentId?: string | null;
  serviceId: string;
  redactionContextVersion?: string;
  serviceName: string;
  variant: DatabaseServiceVariant;
  volumeId: string;
  volumeName: string;
  mountPath: string;
  imageUrl?: string;
  envVars?: Record<string, string>;
  containerArgs?: string[];
  dataPath?: string;
  internalPort: number;
  externalHost: string | null;
  externalPort: number | null;
  publicAccessEnabled: boolean;
  resourceLimits: EffectiveServiceResourceLimits;
  runtimeMetadata?: RuntimeMetadata | null;
  version?: string;
  credentials?: Record<string, string>;
  /**
   * Which pgBackRest repository generation the control plane assigned to this volume.
   *
   * The repository path itself already arrives resolved in `envVars`; the agent only needs the
   * number to key its durable wipe receipt, so a retry can tell "this generation's volume was
   * already replaced" from "a previous wipe's receipt".
   */
  pgbackrestRepositoryGeneration?: number | null;
}

export interface ReconcileServiceResourcesPayload {
  serviceId: string;
  containerName?: string | null;
  runtimeMetadata?: RuntimeMetadata | null;
  resourceLimits: EffectiveServiceResourceLimits;
}

export interface DeleteVolumePayload {
  [key: string]: unknown;
  projectId: string;
  volumeId: string;
  volumeName: string;
  pgbackrestRepositoryGeneration?: number | null;
}

export interface DeleteProjectPayload {
  [key: string]: unknown;
  projectId: string;
}

export interface PlatformBackupDestinationMetadata {
  [key: string]: unknown;
  id: string;
  type: "s3";
  bucket: string;
  endpoint: string;
  region: string;
  pathStyle: boolean;
  verifyTls: boolean;
  pgbackrestRepoType: string;
  pgbackrestCipherType: string | null;
  pgbackrestRetentionFullType: string | null;
  pgbackrestRetentionFull: string | null;
  pgbackrestRetentionDiff: string | null;
  pgbackrestRetentionArchiveType: string | null;
  pgbackrestRetentionArchive: string | null;
  pgbackrestRetentionHistory: string | null;
  pgbackrestArchiveAsync: boolean | null;
  pgbackrestSpoolPath: string | null;
}

export interface PlatformBackupDestination extends PlatformBackupDestinationMetadata {
  accessKeyId: string;
  secretAccessKey: string;
  pgbackrestCipherPass: string | null;
}

interface QueuedVolumeBackupPayloadBase {
  [key: string]: unknown;
  projectId: string;
  serviceId: string;
  serviceName: string;
  variant: BackupDatabaseServiceVariant;
  version: string;
  volumeId: string;
  volumeName: string;
  mountPath: string;
  destination: PlatformBackupDestinationMetadata;
}

export interface CreateVolumeBackupPayload extends QueuedVolumeBackupPayloadBase {
  backupId: string;
  kind: string;
  scheduleType?: string | null;
  engine: "pgbackrest" | "snapshot";
  pgbackrestType?: "full" | "incr" | null;
  runtimeMetadata?: RuntimeMetadata | null;
  destination: PlatformBackupDestination;
  imageUrl?: string;
  envVars?: Record<string, string>;
  containerArgs?: string[];
  dataPath?: string;
  credentials?: Record<string, string>;
  expectedObjectKey: string;
  artifactFormat: VolumeBackupArtifactFormat;
}

export interface DeleteVolumeBackupPayload extends QueuedVolumeBackupPayloadBase {
  backupId: string;
  engine: "pgbackrest" | "snapshot";
  destination: PlatformBackupDestination;
}

export interface RestoreVolumeBackupPayload {
  [key: string]: unknown;
  projectId: string;
  serviceId: string;
  serviceName: string;
  variant: BackupDatabaseServiceVariant;
  version: string;
  sourceVolumeId: string;
  sourceVolumeName: string;
  sourceMountPath: string;
  targetVolumeId: string;
  targetVolumeName: string;
  targetMountPath: string;
  backupId: string;
  engine: "pgbackrest" | "snapshot";
  backupCompletedAt?: string | null;
  pgbackrestSet?: string | null;
  destination: PlatformBackupDestination;
  imageUrl?: string;
  envVars?: Record<string, string>;
  containerArgs?: string[];
  dataPath?: string;
  credentials?: Record<string, string>;
  expectedObjectKey: string;
  artifactFormat: VolumeBackupArtifactFormat;
  artifactSha256?: string | null;
}

export type AgentBackupIntegrityProofV1 =
  | {
      version: 1;
      engine: "mongodb";
      backupId: string;
      objectKey: string;
      artifactFormat: "mongodb-archive-tar-v1";
      artifactSha256: string;
      sizeBytes: number;
      mongodumpSucceeded: true;
      mongorestoreDryRun: true;
      uploadChecksumVerified: true;
    }
  | {
      version: 1;
      engine: "redis";
      backupId: string;
      objectKey: string;
      artifactFormat: "redis-rdb-tar-v1";
      artifactSha256: string;
      sizeBytes: number;
      sourceMode: "rdb" | "aof" | "mixed" | "none";
      redisCheckRdb: true;
      uploadChecksumVerified: true;
      isolatedRestoreVerified: true;
    }
  | {
      version: 1;
      engine: "mysql";
      backupId: string;
      objectKey: string;
      artifactFormat: "mysql-dump-tar-v1";
      artifactSha256: string;
      sizeBytes: number;
      mysqldumpSucceeded: true;
      dumpCompletedMarkerVerified: true;
      uploadChecksumVerified: true;
    }
  | {
      version: 1;
      engine: "pgbackrest";
      backupId: string;
      objectKey: string;
      artifactFormat: "pgbackrest-v1";
      pgbackrestSet: string;
      requiredWalStart: string | null;
      requiredWalStop: string | null;
      repositorySizeBytes: number | null;
      databaseSizeBytes: number | null;
      completedAt: string;
      verifiedAt: string;
    };

export interface AgentBackupRestoreProofV1 {
  version: 1;
  backupId: string;
  targetVolumeId: string;
  targetVolumeName: string;
  validationMethod: "redis-load-ping" | "postgres-startup-sql-read" | "mysql-startup-sql-read";
  isolatedDatabaseStarted: true;
  validatedAt: string;
}

export interface RestorePostgresPitrPayload extends Omit<DatabaseProvisionPayload, "variant"> {
  variant: "postgres";
  sourceVolumeId?: string;
  sourceVolumeName?: string;
  sourceMountPath?: string;
  restoreTarget: string;
  destination: PlatformBackupDestination;
  /** The base backup set the control plane selected, pinning recovery to one repository timeline. */
  sourcePgbackrestSet?: string | null;
}

export interface ExpireVolumeBackupRepositoryPayload {
  [key: string]: unknown;
  projectId: string;
  volumeId: string;
  volumeName: string;
  destination: PlatformBackupDestination;
  imageUrl?: string;
  envVars?: Record<string, string>;
}

export interface RestartServicePayload {
  [key: string]: unknown;
  projectId: string;
  serviceId: string;
  serviceName: string;
  variant: DatabaseServiceVariant;
  containerName: string;
  deploymentId?: string | null;
  runtimeMetadata?: RuntimeMetadata | null;
}

export interface RemoveServicePayload {
  [key: string]: unknown;
  projectId: string;
  serviceId: string;
  serviceName: string;
  serviceType: "app" | "database" | "worker";
  variant?: DatabaseServiceVariant | null;
  containerName?: string | null;
  deploymentId?: string | null;
  runtimeMetadata?: RuntimeMetadata | null;
}

export interface SyncRoutingPayload {
  projectId: string;
  serviceId: string;
  serviceName: string;
  providedHostname: string | null;
  customHostnames: string[];
  ingressPort: number;
  clientIngressConfigHash?: string;
  runtimeMetadata?: RuntimeMetadata | null;
}

export function getDefaultAgentCapabilities(): AgentCapabilities {
  return {
    dockerApi: true,
    buildkit: true,
    localRegistry: true,
    localTraefik: true,
    hostMetrics: true,
    containerMetrics: true,
    postgresObservability: true,
    cleanupProofV1: true,
    serviceScopedCleanupV1: true,
    resourceIsolationV1: true,
    projectNetworkIsolationV1: true,
    projectNetworkReapV1: true,
    appVolumeRolloutV1: true,
    publicPortPreflightV1: true,
    backupIntegrityV1: true,
    mysqlBackupsV1: true,
    managedVolumeCapacityV1: true,
    workerServicesV1: true,
    workerVolumeRolloutV1: true,
    externalBackupImportV1: true,
    // Declares that a volume wipe records a durable replacement receipt, so a retry after a lost
    // completion report resumes instead of erasing the freshly initialized cluster. The control
    // plane refuses to rotate a PostgreSQL repository without it.
    postgresRepositoryLineageV1: true,
    // Declares that a worker rollout honors the service's shutdown signal, grace period and
    // overlap policy, and never force-removes the previous process as normal retirement (#284).
    workerShutdownPolicyV1: true,
  };
}

export function resolveAgentCapabilities(config: AgentRuntimeConfig): AgentCapabilities {
  const capabilities = getDefaultAgentCapabilities();

  if (!config.observability.enabled) {
    return capabilities;
  }

  return {
    ...capabilities,
    alloyObservability: true,
    traefikRequestMetrics: true,
  };
}

export function resolveAgentRuntimeConfigForServer(
  baseConfig: AgentRuntimeConfig,
  organizationId: string,
  redactionContextVersion?: string | null
): AgentRuntimeConfig {
  return {
    ...baseConfig,
    observability: {
      ...baseConfig.observability,
      organizationId,
      ...(redactionContextVersion !== undefined ? { redactionContextVersion } : {}),
    },
    capabilities: resolveAgentCapabilities({
      ...baseConfig,
      observability: {
        ...baseConfig.observability,
        organizationId,
        ...(redactionContextVersion !== undefined ? { redactionContextVersion } : {}),
      },
    }),
  };
}

export function getAgentRuntimeConfig(): AgentRuntimeConfig {
  const registryPort = Number.parseInt(process.env.NOUVA_AGENT_LOCAL_REGISTRY_PORT ?? "5000", 10);
  const imageStoreMode =
    process.env.NOUVA_AGENT_IMAGE_STORE_MODE === "local-registry"
      ? "local-registry"
      : "docker-local";
  const config = {
    heartbeatIntervalSeconds: Number.parseInt(
      process.env.NOUVA_AGENT_HEARTBEAT_INTERVAL_SECONDS ??
        String(DEFAULT_AGENT_HEARTBEAT_INTERVAL_SECONDS),
      10
    ),
    pollIntervalSeconds: Number.parseInt(
      process.env.NOUVA_AGENT_POLL_INTERVAL_SECONDS ?? String(DEFAULT_AGENT_POLL_INTERVAL_SECONDS),
      10
    ),
    leaseTtlSeconds: Number.parseInt(
      process.env.NOUVA_AGENT_LEASE_TTL_SECONDS ?? String(DEFAULT_AGENT_LEASE_TTL_SECONDS),
      10
    ),
    metricsIntervalSeconds: Number.parseInt(
      process.env.NOUVA_AGENT_METRICS_INTERVAL_SECONDS ??
        String(DEFAULT_AGENT_METRICS_INTERVAL_SECONDS),
      10
    ),
    postgresObservabilityIntervalSeconds: Number.parseInt(
      process.env.NOUVA_AGENT_POSTGRES_OBSERVABILITY_INTERVAL_SECONDS ??
        String(DEFAULT_AGENT_POSTGRES_OBSERVABILITY_INTERVAL_SECONDS),
      10
    ),
    ingressMode: "local_traefik",
    buildkitMode: "docker-container",
    imageStoreMode,
    capabilities: {},
    localRegistryHost: process.env.NOUVA_AGENT_LOCAL_REGISTRY_HOST ?? "127.0.0.1",
    localRegistryPort: Number.isFinite(registryPort) ? registryPort : 5000,
    localTraefikNetwork: process.env.NOUVA_AGENT_INGRESS_NETWORK ?? "nouva-ingress",
    clientIngressPlaceholderUrl:
      process.env.NOUVA_CLIENT_INGRESS_PLACEHOLDER_URL ?? "https://nouva.sh/_nouva/domain-pending",
    // Empty until the control plane names its edge on registration: only it knows which peer the
    // provided-domain hop arrives from, and guessing here would trust an address on this server's
    // public port 80 that nothing has confirmed.
    trustedForwardedPeers: [],
    observability: {
      enabled: process.env.NOUVA_OBSERVABILITY_ENABLED === "true",
      organizationId: null,
      alloyImage: process.env.NOUVA_OBSERVABILITY_ALLOY_IMAGE ?? "grafana/alloy:v1.17.1",
      scrapeIntervalSeconds: Number.parseInt(
        process.env.NOUVA_OBSERVABILITY_SCRAPE_INTERVAL_SECONDS ?? "15",
        10
      ),
      collectorScope: "services_traefik_and_workers",
      noneLabelValue: "__none__",
    },
  } satisfies AgentRuntimeConfig;

  return {
    ...config,
    capabilities: resolveAgentCapabilities(config),
  };
}

export function isLeaseActive(leaseExpiresAt: Date | null, now = new Date()): boolean {
  return Boolean(leaseExpiresAt && leaseExpiresAt.getTime() > now.getTime());
}

export function canLeaseWorkItem(
  item: Pick<AgentWorkRecord, "status" | "leaseExpiresAt">
): boolean {
  if (item.status === "queued") {
    return true;
  }

  if (item.status !== "leased") {
    return false;
  }

  return !isLeaseActive(item.leaseExpiresAt);
}

export interface AgentRegistrationRequest extends AgentRegistrationSnapshot {
  registrationToken: string;
}

export interface AgentRegistrationResponse {
  serverId: string;
  agentToken: string;
  config: AgentRuntimeConfig;
}

export type AgentHeartbeatRequest = AgentRegistrationSnapshot;

export interface AgentHeartbeatResponse {
  ok: true;
  config: AgentRuntimeConfig;
}

export interface AgentLeaseRequest {
  serverId: string;
  limit?: number;
  activeWorkItemIds?: string[];
}

export type AgentLeaseResponse = AgentWorkLeaseResult;

export interface AgentLeaseRenewRequest {
  serverId: string;
  leaseId: string;
}

export interface AgentLeaseRenewResponse {
  ok: true;
  leaseExpiresAt: string;
}

export interface AgentWorkMutationRequest {
  serverId: string;
  leaseId: string;
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
}

export interface AgentWorkMutationResponse {
  ok: true;
}

export type BuildLogStage = "cloning" | "analyzing" | "building" | "pushing" | "deploying";

export interface BuildLogMessage {
  type: "stdout" | "stderr" | "progress" | "exit";
  line?: string;
  timestamp: number;
  stage?: BuildLogStage;
  percent?: number;
  message?: string;
  exitCode?: number;
  success?: boolean;
}

export interface AgentBuildLogBatch {
  deploymentId: string;
  entries: BuildLogMessage[];
}

export interface AgentBuildLogsRequest {
  serverId: string;
  logs: AgentBuildLogBatch[];
}

export interface AgentBuildLogsResponse {
  ok: true;
  accepted: number;
}

export interface AgentErrorResponse {
  message: string;
}

export interface DockerVersionPayload {
  ApiVersion?: string;
  Version?: string;
}

export interface ParsedDockerStats {
  cpuUsageBasisPoints: number | null;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number | null;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
  blockReadBytes: number | null;
  blockWriteBytes: number | null;
  pidsCurrent: number | null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function extractBlkioBytes(stats: Record<string, unknown>, operation: string): number | null {
  const blkioStats = toObject(stats.blkio_stats);
  const entries = Array.isArray(blkioStats.io_service_bytes_recursive)
    ? blkioStats.io_service_bytes_recursive
    : [];

  let total = 0;
  let found = false;
  for (const entry of entries) {
    const record = toObject(entry);
    if (String(record.op ?? "").toLowerCase() !== operation) {
      continue;
    }

    const value = toFiniteNumber(record.value);
    if (value === null) {
      continue;
    }

    total += value;
    found = true;
  }

  return found ? total : null;
}

export function negotiateDockerApiVersion(payload: DockerVersionPayload): string {
  const version = payload.ApiVersion?.trim();
  if (!version) {
    return "v1.41";
  }

  return version.startsWith("v") ? version : `v${version}`;
}

export function parseDockerStatsSnapshot(input: unknown): ParsedDockerStats {
  const stats = toObject(input);
  const cpuStats = toObject(stats.cpu_stats);
  const precpuStats = toObject(stats.precpu_stats);
  const cpuUsage = toObject(cpuStats.cpu_usage);
  const precpuUsage = toObject(precpuStats.cpu_usage);

  const totalUsage = toFiniteNumber(cpuUsage.total_usage);
  const previousTotalUsage = toFiniteNumber(precpuUsage.total_usage);
  const systemUsage = toFiniteNumber(cpuStats.system_cpu_usage);
  const previousSystemUsage = toFiniteNumber(precpuStats.system_cpu_usage);
  const onlineCpus =
    toFiniteNumber(cpuStats.online_cpus) ??
    (Array.isArray(cpuUsage.percpu_usage) ? cpuUsage.percpu_usage.length : null);

  let cpuUsageBasisPoints: number | null = null;
  if (
    totalUsage !== null &&
    previousTotalUsage !== null &&
    systemUsage !== null &&
    previousSystemUsage !== null &&
    onlineCpus !== null &&
    systemUsage > previousSystemUsage
  ) {
    const cpuDelta = totalUsage - previousTotalUsage;
    const systemDelta = systemUsage - previousSystemUsage;
    const cpuPercent = (cpuDelta / systemDelta) * Number(onlineCpus) * 100;
    cpuUsageBasisPoints = Math.max(0, Math.round(cpuPercent * 100));
  }

  const memoryStats = toObject(stats.memory_stats);
  const memoryUsageBytes = toFiniteNumber(memoryStats.usage);
  const memoryLimitBytes = toFiniteNumber(memoryStats.limit);

  const networks = toObject(stats.networks);
  let networkRxBytes = 0;
  let networkTxBytes = 0;
  let sawNetwork = false;
  for (const value of Object.values(networks)) {
    const network = toObject(value);
    const rx = toFiniteNumber(network.rx_bytes);
    const tx = toFiniteNumber(network.tx_bytes);
    if (rx !== null) {
      networkRxBytes += rx;
      sawNetwork = true;
    }
    if (tx !== null) {
      networkTxBytes += tx;
      sawNetwork = true;
    }
  }

  const pidsStats = toObject(stats.pids_stats);

  return {
    cpuUsageBasisPoints,
    memoryUsageBytes,
    memoryLimitBytes,
    networkRxBytes: sawNetwork ? networkRxBytes : null,
    networkTxBytes: sawNetwork ? networkTxBytes : null,
    blockReadBytes: extractBlkioBytes(stats, "read"),
    blockWriteBytes: extractBlkioBytes(stats, "write"),
    pidsCurrent: toFiniteNumber(pidsStats.current),
  };
}

export interface HostMetricsSnapshotInput {
  currentCpuStat: string;
  previousCpuStat?: string | null;
  meminfo: string;
  loadavg?: string | null;
  diskAvailableBytes?: number | null;
  diskTotalBytes?: number | null;
}

function parseProcStatLine(content: string): number[] | null {
  const cpuLine = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("cpu "));

  if (!cpuLine) {
    return null;
  }

  const values = cpuLine
    .split(/\s+/)
    .slice(1)
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isFinite(value));

  return values.length > 0 ? values : null;
}

function parseMeminfoValue(content: string, key: string): number | null {
  const line = content
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${key}:`));

  if (!line) {
    return null;
  }

  const value = Number.parseInt(line.replace(`${key}:`, "").trim().split(/\s+/)[0] ?? "", 10);
  if (!Number.isFinite(value)) {
    return null;
  }

  return value * 1024;
}

function parseLoadavgMilli(content?: string | null): {
  loadAvg1mMilli: number | null;
  loadAvg5mMilli: number | null;
  loadAvg15mMilli: number | null;
} {
  if (!content) {
    return {
      loadAvg1mMilli: null,
      loadAvg5mMilli: null,
      loadAvg15mMilli: null,
    };
  }

  const [load1, load5, load15] = content.trim().split(/\s+/);

  const parseOne = (value: string | undefined) => {
    if (!value) {
      return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 1000) : null;
  };

  return {
    loadAvg1mMilli: parseOne(load1),
    loadAvg5mMilli: parseOne(load5),
    loadAvg15mMilli: parseOne(load15),
  };
}

export function parseHostMetricsSnapshot(
  input: HostMetricsSnapshotInput
): AgentServerMetricPayload {
  const currentCpu = parseProcStatLine(input.currentCpuStat);
  const previousCpu = parseProcStatLine(input.previousCpuStat ?? "");

  let cpuUsageBasisPoints: number | null = null;
  if (currentCpu && previousCpu && currentCpu.length >= 4 && previousCpu.length >= 4) {
    const currentIdle = (currentCpu[3] ?? 0) + (currentCpu[4] ?? 0);
    const previousIdle = (previousCpu[3] ?? 0) + (previousCpu[4] ?? 0);
    const currentTotal = currentCpu.reduce((sum, value) => sum + value, 0);
    const previousTotal = previousCpu.reduce((sum, value) => sum + value, 0);
    const totalDelta = currentTotal - previousTotal;
    const idleDelta = currentIdle - previousIdle;

    if (totalDelta > 0) {
      const usagePercent = (1 - idleDelta / totalDelta) * 100;
      cpuUsageBasisPoints = Math.max(0, Math.round(usagePercent * 100));
    }
  }

  const memoryTotalBytes = parseMeminfoValue(input.meminfo, "MemTotal");
  const memoryAvailableBytes = parseMeminfoValue(input.meminfo, "MemAvailable");
  const memoryUsedBytes =
    memoryTotalBytes !== null && memoryAvailableBytes !== null
      ? Math.max(0, memoryTotalBytes - memoryAvailableBytes)
      : null;

  const diskTotalBytes = input.diskTotalBytes ?? null;
  const diskAvailableBytes = input.diskAvailableBytes ?? null;
  const diskUsedBytes =
    diskTotalBytes !== null && diskAvailableBytes !== null
      ? Math.max(0, diskTotalBytes - diskAvailableBytes)
      : null;

  return {
    cpuUsageBasisPoints,
    memoryUsedBytes,
    memoryTotalBytes,
    diskUsedBytes,
    diskAvailableBytes,
    diskTotalBytes,
    ...parseLoadavgMilli(input.loadavg),
    raw: null,
    collectedAt: new Date().toISOString(),
  };
}
