import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectAgentWorkPayloadOperationalValues } from "@repo/runtime/logging";
import type { ReleasePhase } from "@repo/runtime/release-phases";
import agentPackageJson from "../package.json" with { type: "json" };
import { executeAndReportAgentWork } from "./agent-work-reporting.js";
import type { DeployAppImageInput } from "./app-build-runtime.js";
import { buildAndDeployAppWithDependencies } from "./app-build-runtime.js";
import { hashProjectNetwork } from "./build.js";
import { DockerApiError, type DockerContainerSpec } from "./docker-api.js";
import {
  ApiRequestError,
  adoptReregisteredCredentials,
  buildAgentWorkFailureReport,
  buildAppContainerSpec,
  buildDatabaseContainerSpec,
  buildExternalBackupImportFetchScript,
  buildPostgresExternalBackupImportScript,
  buildRedisExternalBackupImportScript,
  buildUpdateAgentRuntimeEnv,
  createAgentHeartbeatLoop,
  deployAppImageWithDependencies,
  handleApplyDatabaseVolume,
  handleCreateVolumeBackup,
  handleDatabaseProvision,
  handleDeleteProject,
  handleDeleteService,
  handleDeleteVolume,
  handleImportExternalBackup,
  handleReconcileServiceResources,
  handleRestartService,
  handleRestorePostgresPitr,
  handleRestoreVolumeBackup,
  handleWipeVolume,
  isAgentWorkResultRejected,
  parseExternalBackupImportObservation,
  preflightDatabasePublicPort,
  prepareAppBuildkitRuntime,
  readApiRequestErrorMessage,
  resolveAgentTaskImage,
  resolveAgentWorkLeaseRenewalIntervalMs,
  resolveReportedAgentVersion,
  resolveServiceContainerIdentifier,
  rollbackUnreportableWorkResult,
  runPreActivation,
  type StoredCredentials,
  sanitizeAgentWorkResult,
  shouldStopRetryingAgentWorkMutation,
  startAgentWorkLeaseRenewal,
} from "./index.js";
import {
  type AgentRuntimeConfig,
  type AppDeployPayload,
  type AppRolloutConfig,
  type CreateVolumeBackupPayload,
  type DatabaseProvisionPayload,
  type RestoreVolumeBackupPayload,
  resolveAppRolloutConfig,
} from "./protocol.js";
import {
  ReleaseJobDeferredError,
  ReleaseJobHaltError,
  type ReleaseJobTarget,
  type ReleasePhaseRequest,
  type ReleasePhaseResult,
} from "./release-jobs.js";

const runtimeConfig: AgentRuntimeConfig = {
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
    cleanupProofV1: true,
  },
  localRegistryHost: "127.0.0.1",
  localRegistryPort: 5000,
  localTraefikNetwork: "nouva-local",
  observability: {
    enabled: false,
    organizationId: null,
    alloyImage: "grafana/alloy:v1.17.1",
    scrapeIntervalSeconds: 30,
    collectorScope: "services_traefik_and_workers",
    noneLabelValue: "__none__",
  },
};

const resourceLimits = {
  cpuMillicores: 1500,
  memoryBytes: 2 * 1024 * 1024 * 1024,
} as const;

const appPayload: AppDeployPayload = {
  repoUrl: "https://example.com/repo.git",
  commitHash: "abc123",
  commitMessage: "feat: build",
  branch: "main",
  subdomain: "app",
  serviceName: "app",
  projectId: "proj_1",
  serviceId: "svc_1",
  deploymentId: "dep_1",
  environmentId: "env_1",
  envVars: { PGSSLMODE: "require" },
  platformGeneratedValues: ["require"],
  appBuildType: "dockerfile",
  appBuildConfig: {
    buildRoot: "apps/web",
    dockerfilePath: "Dockerfile",
    dockerContextPath: ".",
    dockerBuildStage: "runner",
  },
  volume: {
    volumeId: "vol_1",
    volumeName: "nouva-vol-vol_1",
    mountPath: "/data",
  },
  resourceLimits,
  runtimeMetadata: null,
};

const appRuntimePayload: DeployAppImageInput = {
  projectId: "proj_1",
  serviceId: "svc_1",
  deploymentId: "dep_1",
  redactionContextVersion: "hmac-sha256:redaction-context:v1:deployment",
  environmentId: "env_1",
  commitHash: "abc123",
  serviceName: "app",
  subdomain: "app",
  envVars: {
    PORT: "8080",
  },
  imageUrl: "127.0.0.1:5000/nouva-app:dep_1",
  volume: {
    volumeId: "vol_1",
    volumeName: "nouva-vol-vol_1",
    mountPath: "/data",
  },
  resourceLimits,
  runtimeMetadata: null,
  detectedLanguage: null,
  detectedFramework: null,
  languageVersion: null,
  internalPort: 8080,
  buildDuration: 100,
};

const databasePayload: DatabaseProvisionPayload = {
  projectId: "proj_1",
  serviceId: "svc_1",
  redactionContextVersion: "hmac-sha256:redaction-context:v1:database",
  serviceName: "main-db",
  variant: "postgres",
  environmentId: "env_1",
  volumeId: "vol_1",
  volumeName: "nouva-vol-vol_1",
  mountPath: "/var/lib/postgresql",
  imageUrl: "postgres:17",
  // Mirrors the executor config the control plane hydrates: PGDATA equals `dataPath`, and the
  // socket, SSL and pgpass paths derive from `mountPath`.
  envVars: {
    POSTGRES_USER: "nouva_user",
    POSTGRES_PASSWORD: "super-secret",
    POSTGRES_DB: "nouva_user",
    PGDATA: "/var/lib/postgresql/pgdata",
    POSTGRES_SOCKET_DIR: "/var/lib/postgresql/.sockets",
    POSTGRES_SSL_DIR: "/var/lib/postgresql/ssl",
    POSTGRES_SSL_CERT_FILE: "/var/lib/postgresql/ssl/server.crt",
    POSTGRES_SSL_KEY_FILE: "/var/lib/postgresql/ssl/server.key",
    PGPASSFILE: "/var/lib/postgresql/.pgpass",
    PGBACKREST_STANZA: "vol-vol_1",
    PGBACKREST_REPO1_PATH: "/postgres/v1/projects/proj_1/volumes/vol_1",
  },
  containerArgs: [],
  dataPath: "/var/lib/postgresql/pgdata",
  expectedObjectKey: "pgbackrest/proj_1/vol_1",
  artifactFormat: "pgbackrest-v1",
  internalPort: 5432,
  storageSizeGb: 20,
  externalHost: null,
  externalPort: null,
  publicAccessEnabled: false,
  resourceLimits,
  runtimeMetadata: null,
  credentials: {
    username: "nouva_user",
    password: "super-secret",
    database: "nouva_user",
  },
};

const pgBackrestBackupPayload: CreateVolumeBackupPayload = {
  projectId: "proj_1",
  serviceId: "svc_1",
  serviceName: "main-db",
  variant: "postgres",
  version: "17",
  volumeId: "vol_1",
  volumeName: "nouva-vol-vol_1",
  mountPath: "/var/lib/postgresql",
  backupId: "backup_1",
  kind: "MANUAL",
  engine: "pgbackrest",
  pgbackrestType: "full",
  destination: {} as never,
  imageUrl: "postgres:17",
  envVars: {
    POSTGRES_USER: "nouva_user",
    POSTGRES_PASSWORD: "super-secret",
    PGBACKREST_STANZA: "vol-vol_1",
  },
  containerArgs: [],
  dataPath: "/var/lib/postgresql/pgdata",
};

const snapshotBackupPayload: CreateVolumeBackupPayload = {
  projectId: "proj_1",
  serviceId: "svc_redis_1",
  serviceName: "redis-cache",
  variant: "redis",
  version: "7.4",
  volumeId: "vol_redis_1",
  volumeName: "nouva-vol-vol_redis_1",
  mountPath: "/data",
  backupId: "backup_redis_1",
  kind: "MANUAL",
  engine: "snapshot",
  destination: {
    id: "dest_1",
    type: "s3",
    bucket: "nouva-backups",
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    pathStyle: false,
    verifyTls: true,
    accessKeyId: "key-id",
    secretAccessKey: "secret-key",
    pgbackrestRepoType: "s3",
    pgbackrestCipherType: null,
    pgbackrestRetentionFullType: null,
    pgbackrestRetentionFull: null,
    pgbackrestRetentionDiff: null,
    pgbackrestRetentionArchiveType: null,
    pgbackrestRetentionArchive: null,
    pgbackrestRetentionHistory: null,
    pgbackrestArchiveAsync: null,
    pgbackrestSpoolPath: null,
    pgbackrestCipherPass: null,
  },
  runtimeMetadata: { containerName: "nouva-redis-svc_redis_1" },
  credentials: { password: "redis-secret" },
  expectedObjectKey:
    "archives/v1/projects/proj_1/volumes/vol_redis_1/backups/backup_redis_1.tar.gz",
  artifactFormat: "redis-rdb-tar-v1",
};

const mongodbBackupPayload: CreateVolumeBackupPayload = {
  ...snapshotBackupPayload,
  serviceId: "svc_mongo_1",
  serviceName: "main-mongo",
  variant: "mongodb",
  version: "8.0",
  volumeId: "vol_mongo_1",
  volumeName: "nouva-vol-vol_mongo_1",
  mountPath: "/data/db",
  backupId: "backup_mongo_1",
  runtimeMetadata: { containerId: "mongo-container-id" },
  credentials: {
    username: "root",
    password: "mongo-secret",
    database: "appdb",
  },
  expectedObjectKey:
    "archives/v1/projects/proj_1/volumes/vol_mongo_1/backups/backup_mongo_1.tar.gz",
  artifactFormat: "mongodb-archive-tar-v1",
};

const mysqlBackupPayload: CreateVolumeBackupPayload = {
  ...snapshotBackupPayload,
  serviceId: "svc_mysql_1",
  serviceName: "main-mysql",
  variant: "mysql",
  version: "8.4",
  volumeId: "vol_mysql_1",
  volumeName: "nouva-vol-vol_mysql_1",
  mountPath: "/var/lib/mysql",
  backupId: "backup_mysql_1",
  runtimeMetadata: { containerId: "mysql-container-id" },
  credentials: {
    username: "app_user",
    password: "mysql-secret",
    database: "appdb",
  },
  imageUrl: "mysql:8.4",
  envVars: {
    MYSQL_ROOT_PASSWORD: "mysql-secret",
    MYSQL_USER: "app_user",
    MYSQL_PASSWORD: "mysql-secret",
    MYSQL_DATABASE: "appdb",
  },
  containerArgs: [],
  dataPath: "/var/lib/mysql",
  expectedObjectKey:
    "archives/v1/projects/proj_1/volumes/vol_mysql_1/backups/backup_mysql_1.tar.gz",
  artifactFormat: "mysql-dump-tar-v1",
};

const mysqlRestorePayload: RestoreVolumeBackupPayload = {
  projectId: "proj_1",
  serviceId: "svc_mysql_1",
  serviceName: "main-mysql",
  variant: "mysql",
  version: "8.4",
  sourceVolumeId: "vol_mysql_1",
  sourceVolumeName: "nouva-vol-vol_mysql_1",
  sourceMountPath: "/var/lib/mysql",
  targetVolumeId: "vol_restored_mysql",
  targetVolumeName: "nouva-vol-vol_restored_mysql",
  targetMountPath: "/var/lib/mysql",
  backupId: "backup_mysql_1",
  engine: "snapshot",
  backupCompletedAt: "2026-03-25T00:00:00Z",
  pgbackrestSet: null,
  artifactSha256: "c".repeat(64),
  destination: {} as never,
  imageUrl: "mysql:8.4",
  envVars: {
    MYSQL_ROOT_PASSWORD: "mysql-secret",
    MYSQL_USER: "app_user",
    MYSQL_PASSWORD: "mysql-secret",
    MYSQL_DATABASE: "appdb",
  },
  containerArgs: [],
  dataPath: "/var/lib/mysql",
  expectedObjectKey:
    "archives/v1/projects/proj_1/volumes/vol_mysql_1/backups/backup_mysql_1.tar.gz",
  artifactFormat: "mysql-dump-tar-v1",
};

const pgBackrestRestorePayload: RestoreVolumeBackupPayload = {
  projectId: "proj_1",
  serviceId: "svc_1",
  serviceName: "main-db",
  variant: "postgres",
  version: "17",
  sourceVolumeId: "vol_1",
  sourceVolumeName: "nouva-vol-vol_1",
  sourceMountPath: "/var/lib/postgresql",
  targetVolumeId: "vol_restored_1",
  targetVolumeName: "nouva-vol-vol_restored_1",
  targetMountPath: "/var/lib/postgresql",
  backupId: "backup_1",
  engine: "pgbackrest",
  backupCompletedAt: "2026-03-25T00:00:00Z",
  pgbackrestSet: "20260325-000000F",
  destination: {} as never,
  imageUrl: "postgres:17",
  envVars: {
    POSTGRES_USER: "nouva_user",
    POSTGRES_PASSWORD: "super-secret",
    PGBACKREST_STANZA: "vol-vol_1",
  },
  containerArgs: [],
  dataPath: "/var/lib/postgresql/pgdata",
  expectedObjectKey: "pgbackrest/proj_1/vol_1",
  artifactFormat: "pgbackrest-v1",
};

const originalAgentImage = process.env.NOUVA_AGENT_IMAGE;
const originalAgentTargetImage = process.env.NOUVA_AGENT_TARGET_IMAGE;
const originalAgentContainerName = process.env.NOUVA_AGENT_CONTAINER_NAME;
const originalHostname = process.env.HOSTNAME;

function createDockerMock() {
  // Mirrors the host: a container only exists to be inspected once Docker has been asked to run it.
  let startedContainerName: string | null = null;
  return {
    ensureNetwork: mock(async () => {}),
    createVolume: mock(async () => {}),
    ensureContainer: mock(async (spec: DockerContainerSpec) => {
      startedContainerName = spec.name;
      return "ctr_1";
    }),
    connectNetwork: mock(async () => {}),
    disconnectNetwork: mock(async () => {}),
    removeNetwork: mock(async () => {}),
    inspectNetwork: mock(async () => null),
    inspectContainer: mock(async (nameOrId: string) =>
      startedContainerName && (nameOrId === startedContainerName || nameOrId === "ctr_1")
        ? {
            Id: "ctr_1",
            Name: `/${startedContainerName}`,
            RestartCount: 0,
            State: { Running: true, Status: "running", ExitCode: 0, OOMKilled: false },
            NetworkSettings: { Networks: { managed: { IPAddress: "172.18.0.9" } } },
          }
        : null
    ),
    listContainersUsingVolume: mock(async () => []),
    listContainersByLabels: mock(async () => []),
    inspectImage: mock(async () => ({ Id: "img_candidate" })),
    inspectVolume: mock(async () => null),
    removeContainer: mock(async () => {}),
    removeImage: mock(async () => {}),
    removeVolume: mock(async () => {}),
    stopContainer: mock(async () => {}),
    restartContainer: mock(async () => {}),
    pullImage: mock(async () => {}),
    loadImage: mock(async () => {}),
    createContainer: mock(async () => "task_1"),
    startContainer: mock(async () => {}),
    waitContainer: mock(async () => 0),
    containerLogs: mock(async () => ""),
  };
}

/**
 * Database readiness runs its probe in a sidecar the agent creates and removes itself, so container
 * lifecycle assertions about a service keep looking at the service's own containers.
 */
function serviceContainerRemovals(docker: ReturnType<typeof createDockerMock>): Array<unknown[]> {
  return docker.removeContainer.mock.calls.filter(
    ([identifier]) => !String(identifier).startsWith("nouva-db-ready-") && identifier !== "task_1"
  );
}

function createRolloutConfig(overrides?: Partial<AppRolloutConfig>): AppRolloutConfig {
  return {
    strategy: "candidate_ready_cutover",
    readiness: {
      timeoutMs: 25,
      intervalMs: 1,
      tcpConnectTimeoutMs: 1,
      ...overrides?.readiness,
    },
    cutover: {
      verificationTimeoutMs: 25,
      verificationIntervalMs: 1,
      ...overrides?.cutover,
    },
    drain: {
      durationMs: 0,
      gracefulStopTimeoutSeconds: 10,
      cleanupTimeoutMs: 15_000,
      ...overrides?.drain,
    },
  };
}

describe("agent version reporting", () => {
  test("reports the package version with a v prefix", () => {
    expect(resolveReportedAgentVersion(agentPackageJson.version)).toBe(
      `v${agentPackageJson.version}`
    );
  });

  test("does not inherit NOUVA_AGENT_VERSION during self-update", () => {
    const result = buildUpdateAgentRuntimeEnv(
      {
        NOUVA_API_URL: "https://api.nouvacloud.com",
        NOUVA_SERVER_ID: "srv_1",
        NOUVA_AGENT_DATA_VOLUME: "nouva-agent-data",
        NOUVA_AGENT_IMAGE: "ghcr.io/nouvacloud/nouva-agent:v0.1.0",
        NOUVA_AGENT_TARGET_IMAGE: "ghcr.io/nouvacloud/nouva-agent:v0.1.0",
        NOUVA_AGENT_VERSION: "v0.1.0",
        PATH: "/usr/bin",
      },
      "ghcr.io/nouvacloud/nouva-agent:latest"
    );

    expect(result).toEqual({
      updaterEnv: [
        "NOUVA_AGENT_DATA_VOLUME=nouva-agent-data",
        "NOUVA_API_URL=https://api.nouvacloud.com",
        "NOUVA_SERVER_ID=srv_1",
        "NOUVA_AGENT_IMAGE=ghcr.io/nouvacloud/nouva-agent:latest",
        "NOUVA_AGENT_TARGET_IMAGE=ghcr.io/nouvacloud/nouva-agent:latest",
      ],
      envInheritFlags:
        "-e NOUVA_AGENT_DATA_VOLUME -e NOUVA_API_URL -e NOUVA_SERVER_ID -e NOUVA_AGENT_IMAGE -e NOUVA_AGENT_TARGET_IMAGE",
    });
  });
});

describe("adoptReregisteredCredentials", () => {
  test("updates the shared credentials object in place so every caller sees the new token", () => {
    const credentials: StoredCredentials = { serverId: "srv_1", agentToken: "stale-token" };
    // Mirrors main(): the heartbeat loop, work scheduler, and metrics collector all close over the
    // same object rather than re-reading credentials.json.
    const leaseToken = () => credentials.agentToken;

    const result = adoptReregisteredCredentials(credentials, {
      serverId: "srv_1",
      agentToken: "fresh-token",
    });

    expect(result).toBe(credentials);
    expect(credentials).toEqual({ serverId: "srv_1", agentToken: "fresh-token" });
    expect(leaseToken()).toBe("fresh-token");
  });

  test("does not keep a reference to the registration payload", () => {
    const credentials: StoredCredentials = { serverId: "srv_1", agentToken: "stale-token" };
    const payload: StoredCredentials = { serverId: "srv_1", agentToken: "fresh-token" };

    adoptReregisteredCredentials(credentials, payload);
    payload.agentToken = "mutated-after-adoption";

    expect(credentials.agentToken).toBe("fresh-token");
  });
});

describe("resolveAgentTaskImage", () => {
  beforeEach(() => {
    delete process.env.NOUVA_AGENT_IMAGE;
    delete process.env.NOUVA_AGENT_TARGET_IMAGE;
    delete process.env.NOUVA_AGENT_CONTAINER_NAME;
    delete process.env.HOSTNAME;
  });

  afterEach(() => {
    if (originalAgentImage === undefined) delete process.env.NOUVA_AGENT_IMAGE;
    else process.env.NOUVA_AGENT_IMAGE = originalAgentImage;
    if (originalAgentTargetImage === undefined) delete process.env.NOUVA_AGENT_TARGET_IMAGE;
    else process.env.NOUVA_AGENT_TARGET_IMAGE = originalAgentTargetImage;
    if (originalAgentContainerName === undefined) delete process.env.NOUVA_AGENT_CONTAINER_NAME;
    else process.env.NOUVA_AGENT_CONTAINER_NAME = originalAgentContainerName;
    if (originalHostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = originalHostname;
  });

  test("returns the configured agent image when NOUVA_AGENT_IMAGE is set", async () => {
    const docker = createDockerMock();
    process.env.NOUVA_AGENT_IMAGE = "example.com/custom/nouva-agent:1.0.0";

    await expect(resolveAgentTaskImage(docker as never)).resolves.toBe(
      "example.com/custom/nouva-agent:1.0.0"
    );
    expect(docker.inspectContainer).not.toHaveBeenCalled();
  });

  test("falls back to inspecting the running agent container image when env is missing", async () => {
    const docker = createDockerMock();
    process.env.HOSTNAME = "ctr_agent_1";
    docker.inspectContainer.mockImplementation(async (nameOrId: string) =>
      nameOrId === "ctr_agent_1"
        ? {
            Id: "ctr_agent_1",
            Config: {
              Image: "ghcr.io/nouvacloud/nouva-agent:v0.4.10",
            },
          }
        : null
    );

    await expect(resolveAgentTaskImage(docker as never)).resolves.toBe(
      "ghcr.io/nouvacloud/nouva-agent:v0.4.10"
    );
  });
});

describe("agent work mutation errors", () => {
  test("sanitizes nested failure reports with the leased environment map", () => {
    const report = buildAgentWorkFailureReport({
      environmentVariables: {
        Q: "x",
        UV: "yz",
      },
      errorMessage: "Command failed: buildctl --opt build-arg:Q=x --opt build-arg:UV=yz",
      result: {
        Q: "x",
        preservedRuntime: {
          statusMessage: "UV=yz",
        },
      },
    });
    const serialized = JSON.stringify(report);

    for (const secret of ["Q", "x", "UV", "yz"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("[REDACTED]");
    expect(report.result).toBeDefined();
  });

  test("sanitizes successful completion results with the leased environment map", () => {
    const result = sanitizeAgentWorkResult(
      {
        status: "completed",
        Q: "x",
        nested: {
          UV: "yz",
          summary: "Q=x UV=yz",
        },
      },
      {
        Q: "x",
        UV: "yz",
      }
    );
    const serialized = JSON.stringify(result);

    for (const secret of ["Q", "x", "UV", "yz"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(result).toMatchObject({ status: "completed" });
    expect(serialized).toContain("[REDACTED]");
  });

  test("preserves runtime metadata and job protocol keys that collide with environment names", () => {
    const result = sanitizeAgentWorkResult(
      {
        runtimeMetadata: {
          containerId: "ctr_runtime-secret",
        },
        job: {
          status: "failed",
          statusMessage: "job=job-secret",
        },
      },
      {
        runtimeMetadata: "unrelated-runtime-secret",
        job: "job-secret",
      }
    );

    expect(result).toEqual({
      runtimeMetadata: {
        containerId: "ctr_runtime-secret",
      },
      job: {
        status: "failed",
        // The variable name survives so a failure can say which variable to change; its value does
        // not (#187).
        statusMessage: "job=[REDACTED]",
      },
    });
  });

  test("rejects operational identifiers that contain protected environment material", () => {
    const secret = "sentinel-private-value";

    expect(() =>
      sanitizeAgentWorkResult(
        {
          containerName: `nouva-${secret}`,
          imageUrl: secret,
          objectKey: secret,
          runtimeMetadata: { image: secret },
        },
        { SENTINEL_PRIVATE_NAME: secret }
      )
    ).toThrow("Agent work result conflicts with protected environment material");
  });

  test("keeps a worker rollout's shutdown vocabulary when a customer value equals it", () => {
    const shutdown = {
      containerName: "nouva-worker-svc_1-dep_1-0",
      role: "previous",
      signal: "SIGTERM",
      gracePeriodSeconds: 30,
      outcome: "forced",
      exitCode: 137,
      elapsedMs: 30_000,
    };
    const rollout = {
      strategy: "candidate_ready_cutover",
      outcome: "committed",
      liveRuntimePreserved: false,
      rollbackCompleted: false,
      policy: { signal: "SIGTERM", gracePeriodSeconds: 30, rolloutPolicy: "overlap" },
      shutdowns: [shutdown],
    };
    const customerVariables = {
      STOP_SIGNAL: "SIGTERM",
      QUEUE_MODE: "overlap",
      NODE_ROLE: "previous",
      LAST_RESULT: "forced",
    };

    expect(sanitizeAgentWorkResult({ rollout }, customerVariables)).toEqual({ rollout });

    const secret = "sentinel-private-value";
    expect(() =>
      sanitizeAgentWorkResult(
        { rollout: { ...rollout, shutdowns: [{ ...shutdown, containerName: `nouva-${secret}` }] } },
        { ...customerVariables, SENTINEL_PRIVATE_NAME: secret }
      )
    ).toThrow("Agent work result conflicts with protected environment material");
  });

  test("drops an ambiguous failure result instead of leaking or corrupting identifiers", () => {
    const secret = "sentinel-private-value";

    expect(
      buildAgentWorkFailureReport({
        environmentVariables: { SENTINEL_PRIVATE_NAME: secret },
        errorMessage: `rollout failed for ${secret}`,
        result: { runtimeMetadata: { containerId: `nouva-${secret}` } },
      })
    ).toEqual({
      errorMessage: "rollout failed for [REDACTED]",
      result: null,
    });
  });

  test("keeps a postgres provision result whose data path equals the leased PGDATA", () => {
    // Regression for #118: PGDATA is byte-identical to the reported runtimeMetadata.dataPath.
    // Uses production-shaped ids: the volume name is `nouva-vol-` plus the first 12 characters of
    // the 24-character volume id, while the pgBackRest stanza carries the full id, so the stanza
    // value is not a substring of the volume name. The shared fixture's short `vol_1` id would
    // make them collide, which real ids never do.
    const volumeId = "q3v8k1zpd0m7wcx5tn2ryhb4";
    const payload: DatabaseProvisionPayload = {
      ...databasePayload,
      volumeId,
      volumeName: `nouva-vol-${volumeId.slice(0, 12)}`,
      envVars: {
        ...databasePayload.envVars,
        PGBACKREST_STANZA: `vol-${volumeId}`,
        PGBACKREST_REPO1_PATH: `/postgres/v1/projects/proj_1/volumes/${volumeId}`,
      },
    };
    const provisionResult = {
      internalHost: "nouva-postgres-svc_1",
      internalPort: 5432,
      externalHost: null,
      externalPort: null,
      runtimeMetadata: {
        containerId: "ctr_pg",
        containerName: "nouva-postgres-svc_1",
        image: "postgres:17",
        publishedPort: null,
        volumeName: payload.volumeName,
        mountPath: "/var/lib/postgresql",
        dataPath: "/var/lib/postgresql/pgdata",
      },
      runtimeInstance: {
        kind: "database",
        status: "running",
        name: "nouva-postgres-svc_1",
        image: "postgres:17",
        containerId: "ctr_pg",
        containerName: "nouva-postgres-svc_1",
        networkName: "nouva-project-proj_1",
        internalHost: "nouva-postgres-svc_1",
        internalPort: 5432,
        externalHost: null,
        externalPort: null,
      },
      statusMessage: "initdb in /var/lib/postgresql/pgdata for POSTGRES_PASSWORD=super-secret",
    };

    const result = sanitizeAgentWorkResult(
      provisionResult,
      payload.envVars ?? {},
      collectAgentWorkPayloadOperationalValues(payload)
    );

    expect(result).toMatchObject({
      runtimeMetadata: provisionResult.runtimeMetadata,
      runtimeInstance: provisionResult.runtimeInstance,
      statusMessage: "initdb in /var/lib/postgresql/pgdata for POSTGRES_PASSWORD=[REDACTED]",
    });
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  test("still rejects a data path that only matches an environment value, not the payload", () => {
    const foreignPayload = { ...databasePayload, dataPath: "/var/lib/postgresql/other" };

    expect(() =>
      sanitizeAgentWorkResult(
        { runtimeMetadata: { dataPath: "/var/lib/postgresql/pgdata" } },
        foreignPayload.envVars ?? {},
        collectAgentWorkPayloadOperationalValues(foreignPayload)
      )
    ).toThrow("Agent work result conflicts with protected environment material");
  });

  test("keeps payload paths in failure reports", () => {
    expect(
      buildAgentWorkFailureReport({
        environmentVariables: databasePayload.envVars ?? {},
        errorMessage: "initdb failed in /var/lib/postgresql/pgdata: password super-secret rejected",
        operationalValues: collectAgentWorkPayloadOperationalValues(databasePayload),
        result: { runtimeMetadata: { dataPath: "/var/lib/postgresql/pgdata" } },
      })
    ).toEqual({
      errorMessage: "initdb failed in /var/lib/postgresql/pgdata: password [REDACTED] rejected",
      result: { runtimeMetadata: { dataPath: "/var/lib/postgresql/pgdata" } },
    });
  });

  test("preserves backup and timestamp protocol keys that collide with environment names", () => {
    const result = sanitizeAgentWorkResult(
      {
        activePgbackrestSets: ["20260825-120000F"],
        artifactFormat: "pgbackrest-v1",
        artifactSha256: "sha256-safe-artifact",
        completedAt: "2026-08-25T12:01:00.000Z",
        objectKey: "backups/service-1/backup-1",
        pgbackrestSet: "20260825-120000F",
        pgbackrestType: "full",
        sizeBytes: 4096,
        startedAt: "2026-08-25T12:00:00.000Z",
        verifiedAt: "2026-08-25T12:02:00.000Z",
      },
      {
        activePgbackrestSets: "sets-env-secret",
        artifactFormat: "format-env-secret",
        artifactSha256: "sha-env-secret",
        completedAt: "completed-env-secret",
        objectKey: "object-env-secret",
        pgbackrestSet: "set-env-secret",
        pgbackrestType: "type-env-secret",
        sizeBytes: "size-env-secret",
        startedAt: "started-env-secret",
        verifiedAt: "verified-env-secret",
      }
    );

    expect(result).toEqual({
      activePgbackrestSets: ["20260825-120000F"],
      artifactFormat: "pgbackrest-v1",
      artifactSha256: "sha256-safe-artifact",
      completedAt: "2026-08-25T12:01:00.000Z",
      objectKey: "backups/service-1/backup-1",
      pgbackrestSet: "20260825-120000F",
      pgbackrestType: "full",
      sizeBytes: 4096,
      startedAt: "2026-08-25T12:00:00.000Z",
      verifiedAt: "2026-08-25T12:02:00.000Z",
    });
    expect(result).not.toHaveProperty("[REDACTED]");
  });

  test("stops retrying when the control plane reports the work is gone or superseded", () => {
    expect(
      shouldStopRetryingAgentWorkMutation(
        new ApiRequestError({
          method: "POST",
          pathName: "/api/agent/work/work_1/complete",
          status: 404,
          message: "Work item not found",
        })
      )
    ).toBe(true);
    expect(
      shouldStopRetryingAgentWorkMutation(
        new ApiRequestError({
          method: "POST",
          pathName: "/api/agent/work/work_1/complete",
          status: 422,
          message: "Cleanup verification failed",
        })
      )
    ).toBe(true);
    expect(
      shouldStopRetryingAgentWorkMutation(
        new ApiRequestError({
          method: "POST",
          pathName: "/api/agent/work/work_1/fail",
          status: 409,
          message: "Work item lease is no longer active",
        })
      )
    ).toBe(true);
  });

  test("keeps retrying on non-terminal agent work mutation failures", () => {
    expect(
      shouldStopRetryingAgentWorkMutation(
        new ApiRequestError({
          method: "POST",
          pathName: "/api/agent/work/work_1/complete",
          status: 500,
          message: "boom",
        })
      )
    ).toBe(false);
    expect(shouldStopRetryingAgentWorkMutation(new Error("network exploded"))).toBe(false);
  });

  test("separates a rejected result from a lease that is genuinely gone", () => {
    const rejection = new ApiRequestError({
      method: "POST",
      pathName: "/api/agent/work/work_1/complete",
      status: 422,
      message: JSON.stringify({
        message: 'Agent work result field "runtimeMetadata" repeats the value of PHX_HOST.',
      }),
    });

    expect(isAgentWorkResultRejected(rejection)).toBe(true);
    expect(
      isAgentWorkResultRejected(
        new ApiRequestError({
          method: "POST",
          pathName: "/api/agent/work/work_1/complete",
          status: 409,
          message: "Work item lease is no longer active",
        })
      )
    ).toBe(false);
    expect(isAgentWorkResultRejected(new Error("network exploded"))).toBe(false);
    expect(readApiRequestErrorMessage(rejection, "fallback")).toBe(
      'Agent work result field "runtimeMetadata" repeats the value of PHX_HOST.'
    );
    expect(
      readApiRequestErrorMessage(
        new ApiRequestError({
          method: "POST",
          pathName: "/api/agent/work/work_1/complete",
          status: 422,
          message: "not json",
        }),
        "fallback"
      )
    ).toBe("not json");
    expect(readApiRequestErrorMessage(new Error("network exploded"), "fallback")).toBe("fallback");
  });
});

describe("rollbackUnreportableWorkResult", () => {
  function createRemoveContainerRecorder() {
    const removed: string[] = [];
    return {
      removed,
      docker: {
        removeContainer: async (nameOrId: string) => {
          removed.push(nameOrId);
        },
      },
    };
  }

  test("removes the containers this attempt started and keeps the ones it inherited", async () => {
    const recorder = createRemoveContainerRecorder();

    const removed = await rollbackUnreportableWorkResult(recorder.docker, {
      kind: "redeploy_app",
      workItemId: "work_1",
      payload: {
        runtimeMetadata: { containerName: "nouva-proj-phoenix-old", containerId: "ctr_old" },
      },
      result: {
        runtimeMetadata: { containerName: "nouva-proj-phoenix", containerId: "ctr_new" },
        rollout: {
          activeContainerName: "nouva-proj-phoenix",
          previousContainerRetirement: { containerName: "nouva-proj-phoenix-old" },
        },
        runtimeInstance: { containerName: "nouva-proj-phoenix", containerId: "ctr_new" },
      },
    });

    expect(removed.sort()).toEqual(["ctr_new", "nouva-proj-phoenix"]);
    expect(recorder.removed).not.toContain("nouva-proj-phoenix-old");
    expect(recorder.removed).not.toContain("ctr_old");
  });

  test("leaves work that never starts a container alone", async () => {
    const recorder = createRemoveContainerRecorder();

    expect(
      await rollbackUnreportableWorkResult(recorder.docker, {
        kind: "provision_database",
        workItemId: "work_2",
        payload: {},
        result: { runtimeMetadata: { containerName: "nouva-proj-db" } },
      })
    ).toEqual([]);
    expect(
      await rollbackUnreportableWorkResult(recorder.docker, {
        kind: "deploy_app",
        workItemId: "work_3",
        payload: {},
        result: null,
      })
    ).toEqual([]);
    expect(recorder.removed).toEqual([]);
  });

  test("keeps removing after one container cannot be removed", async () => {
    const removed: string[] = [];
    const docker = {
      removeContainer: async (nameOrId: string) => {
        if (nameOrId === "ctr_locked") {
          throw new Error("container is locked");
        }
        removed.push(nameOrId);
      },
    };

    expect(
      await rollbackUnreportableWorkResult(docker, {
        kind: "deploy_worker",
        workItemId: "work_4",
        payload: {},
        result: {
          runtimeInstances: [{ containerId: "ctr_locked" }, { containerId: "ctr_ok" }],
        },
      })
    ).toEqual(["ctr_ok"]);
    expect(removed).toEqual(["ctr_ok"]);
  });
});

describe("agent work lease renewal", () => {
  test("renews at one third of the configured lease TTL with a one-second floor", () => {
    expect(resolveAgentWorkLeaseRenewalIntervalMs(120)).toBe(40_000);
    expect(resolveAgentWorkLeaseRenewalIntervalMs(1)).toBe(1_000);
    expect(resolveAgentWorkLeaseRenewalIntervalMs(0)).toBe(40_000);
    expect(resolveAgentWorkLeaseRenewalIntervalMs(Number.NaN)).toBe(40_000);
  });

  test("does not schedule another renewal while the current request is in flight", async () => {
    let resolveRenewal: (() => void) | undefined;
    const renewLease = mock(
      () =>
        new Promise<{ ok: true; leaseExpiresAt: string }>((resolve) => {
          resolveRenewal = () => resolve({ ok: true, leaseExpiresAt: "2026-03-26T12:02:00.000Z" });
        })
    );
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const controller = startAgentWorkLeaseRenewal({
      leaseTtlSeconds: 120,
      renewLease,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return callback;
      },
      clearScheduled: () => undefined,
    });

    expect(renewLease).toHaveBeenCalledTimes(1);
    expect(scheduled).toEqual([]);

    resolveRenewal?.();
    await controller.ready;

    expect(scheduled).toEqual([{ callback: expect.any(Function), delayMs: 40_000 }]);
    await controller.stop();
  });

  test("retries transient renewal failures sooner and returns to the normal cadence", async () => {
    const renewLease = mock()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({ ok: true, leaseExpiresAt: "2026-03-26T12:02:00.000Z" });
    const onTransientError = mock();
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const controller = startAgentWorkLeaseRenewal({
      leaseTtlSeconds: 120,
      renewLease,
      onTransientError,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return callback;
      },
      clearScheduled: () => undefined,
    });

    expect(await controller.ready).toBe(true);
    expect(onTransientError).toHaveBeenCalledTimes(1);
    expect(scheduled[0]?.delayMs).toBe(5_000);

    scheduled.shift()?.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(renewLease).toHaveBeenCalledTimes(2);
    expect(scheduled[0]?.delayMs).toBe(40_000);
    await controller.stop();
  });

  test("stops permanently when the control plane rejects lease ownership", async () => {
    const onLeaseLost = mock();
    const schedule = mock();
    const controller = startAgentWorkLeaseRenewal({
      leaseTtlSeconds: 120,
      renewLease: async () => {
        throw new ApiRequestError({
          method: "POST",
          pathName: "/api/agent/work/work_1/renew",
          status: 409,
          message: "Work item lease is no longer active",
        });
      },
      onLeaseLost,
      schedule,
    });

    expect(await controller.ready).toBe(false);
    expect(controller.leaseLost()).toBe(true);
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
    await controller.stop();
  });

  test("clears scheduled renewals during terminal work reporting", async () => {
    const timer = Symbol("lease-renewal-timer");
    const clearScheduled = mock();
    const controller = startAgentWorkLeaseRenewal({
      leaseTtlSeconds: 120,
      renewLease: async () => ({
        ok: true,
        leaseExpiresAt: "2026-03-26T12:02:00.000Z",
      }),
      schedule: () => timer,
      clearScheduled,
    });

    expect(await controller.ready).toBe(true);
    await controller.stop();

    expect(clearScheduled).toHaveBeenCalledWith(timer);
  });
});

describe("agent heartbeat loop", () => {
  const drainMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("re-arms after a heartbeat that never settles", async () => {
    const scheduled: Array<() => void> = [];
    const failures: number[] = [];
    let ticks = 0;
    let abortedFirstTick = false;
    let reachedLimit = false;

    const loop = createAgentHeartbeatLoop({
      runTick: (signal) => {
        ticks += 1;
        if (ticks > 1) {
          return Promise.resolve();
        }
        signal.addEventListener("abort", () => {
          abortedFirstTick = true;
        });
        // The wedged request: it never settles and never rejects.
        return new Promise<void>(() => {});
      },
      nextDelayMs: () => 0,
      isStopped: () => false,
      onFailure: (_error, count) => failures.push(count),
      onFailureLimit: () => {
        reachedLimit = true;
      },
      tickTimeoutMs: 20,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      clearScheduled: () => undefined,
    });

    loop.start();
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(failures).toEqual([1]);
    expect(abortedFirstTick).toBe(true);
    // The whole point: the stalled tick did not end the timer chain.
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    await drainMicrotasks();

    // The abandoned tick is still running, so the next attempt is counted and waited out rather
    // than started alongside it. The chain keeps re-arming, which is what walks the failure limit.
    // The first entry is the real failure from the original tick's own deadline loss; the second
    // is a skip on its own counter (restarting at 1, not continuing to 2).
    expect(ticks).toBe(1);
    expect(failures).toEqual([1, 1]);
    expect(scheduled).toHaveLength(1);
    expect(reachedLimit).toBe(false);
    loop.stop();
  });

  test("a heartbeat that is genuinely wedged forever still hits the watchdog", async () => {
    const scheduled: Array<() => void> = [];
    const failures: number[] = [];
    let reachedLimit = false;

    const loop = createAgentHeartbeatLoop({
      // The wedged request: it never settles and never rejects, on every attempt.
      runTick: () => new Promise<void>(() => {}),
      nextDelayMs: () => 0,
      isStopped: () => false,
      onFailure: (_error, count) => failures.push(count),
      onFailureLimit: () => {
        reachedLimit = true;
      },
      tickTimeoutMs: 20,
      maxConsecutiveFailures: 5,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      clearScheduled: () => undefined,
    });

    loop.start();

    // First attempt: its own deadline loses the race -- 1 real failure.
    scheduled.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(failures).toEqual([1]);

    // The same stuck tick is still in flight for every subsequent attempt, so each one is a
    // skip, counted on its own counter. Enough consecutive skips of the same still-stuck tick
    // must still walk the loop to the limit -- a genuine wedge must still cause the agent to
    // exit, even though skips no longer share a counter with real failures.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      scheduled.shift()?.();
      await drainMicrotasks();
    }

    expect(reachedLimit).toBe(true);
    expect(scheduled).toHaveLength(0);
    loop.stop();
  });

  test("a slow tick that eventually succeeds does not trip the watchdog", async () => {
    const scheduled: Array<() => void> = [];
    const failures: number[] = [];
    let ticks = 0;
    let reachedLimit = false;
    let releaseFirstTick: (() => void) | undefined;

    const loop = createAgentHeartbeatLoop({
      runTick: () => {
        ticks += 1;
        if (ticks > 1) {
          return Promise.resolve();
        }
        // Slow, not hung: it outlives the deadline, but eventually resolves on its own.
        return new Promise<void>((resolve) => {
          releaseFirstTick = resolve;
        });
      },
      nextDelayMs: () => 0,
      isStopped: () => false,
      onFailure: (_error, count) => failures.push(count),
      onFailureLimit: () => {
        reachedLimit = true;
      },
      tickTimeoutMs: 20,
      maxConsecutiveFailures: 5,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      clearScheduled: () => undefined,
    });

    loop.start();

    // The first attempt's own deadline loses the race -- 1 real failure.
    scheduled.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Four more reschedules land while the same slow tick is still outstanding. Under the
    // regression, these skips shared the same counter as the real failure above and would have
    // hit the default limit (5) and exited here, even though the tick was never actually stuck.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      scheduled.shift()?.();
      await drainMicrotasks();
    }
    expect(reachedLimit).toBe(false);

    // The slow operation finally succeeds.
    releaseFirstTick?.();
    await drainMicrotasks();

    scheduled.shift()?.();
    await drainMicrotasks();

    expect(ticks).toBe(2);
    expect(reachedLimit).toBe(false);
    loop.stop();
  });

  test("never runs two ticks at once, and resumes when the stalled one settles", async () => {
    const scheduled: Array<() => void> = [];
    const failures: number[] = [];
    let concurrent = 0;
    let peakConcurrent = 0;
    let ticks = 0;
    let releaseFirstTick: (() => void) | undefined;

    const loop = createAgentHeartbeatLoop({
      runTick: () => {
        ticks += 1;
        concurrent += 1;
        peakConcurrent = Math.max(peakConcurrent, concurrent);
        if (ticks > 1) {
          concurrent -= 1;
          return Promise.resolve();
        }
        // A tick that outlives its deadline: aborting reaches the request, but the Docker
        // reconciliation it already started keeps going until it finishes on its own.
        return new Promise<void>((resolve) => {
          releaseFirstTick = () => {
            concurrent -= 1;
            resolve();
          };
        });
      },
      nextDelayMs: () => 0,
      isStopped: () => false,
      onFailure: (_error, count) => failures.push(count),
      onFailureLimit: () => undefined,
      tickTimeoutMs: 20,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      clearScheduled: () => undefined,
    });

    loop.start();
    scheduled.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Two attempts land while the first tick is still in flight; neither may overlap it.
    scheduled.shift()?.();
    await drainMicrotasks();
    scheduled.shift()?.();
    await drainMicrotasks();

    expect(ticks).toBe(1);
    expect(peakConcurrent).toBe(1);
    // The first entry is the real failure from the original tick losing its own deadline race;
    // the next two are skip counts (1, 2) for the two reschedules that landed while it was still
    // outstanding. They are tracked on separate counters, so the skip counts restart from 1
    // rather than continuing the real-failure count to 2 and 3.
    expect(failures).toEqual([1, 1, 2]);

    releaseFirstTick?.();
    await drainMicrotasks();

    // Once the stalled work finally lets go, the loop takes its next turn normally.
    scheduled.shift()?.();
    await drainMicrotasks();

    expect(ticks).toBe(2);
    expect(peakConcurrent).toBe(1);
    // The late success clears both counters; the next tick succeeds immediately too, so no new
    // failures are ever recorded.
    expect(failures).toEqual([1, 1, 2]);
    loop.stop();
  });

  test("counts consecutive failures until the watchdog fires", async () => {
    const scheduled: Array<() => void> = [];
    const failures: number[] = [];
    let reachedLimit = 0;

    const loop = createAgentHeartbeatLoop({
      runTick: () => Promise.reject(new Error("Heartbeat failed with status 502")),
      nextDelayMs: () => 0,
      isStopped: () => false,
      onFailure: (_error, count) => failures.push(count),
      onFailureLimit: () => {
        reachedLimit += 1;
      },
      maxConsecutiveFailures: 3,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      clearScheduled: () => undefined,
    });

    loop.start();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      scheduled.shift()?.();
      await drainMicrotasks();
    }

    expect(failures).toEqual([1, 2, 3]);
    expect(reachedLimit).toBe(1);
    // At the limit the process is expected to exit; nothing further is scheduled.
    expect(scheduled).toHaveLength(0);
  });

  test("a successful heartbeat clears earlier failures", async () => {
    const scheduled: Array<() => void> = [];
    const failures: number[] = [];
    let attempts = 0;

    const loop = createAgentHeartbeatLoop({
      runTick: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error("transient")) : Promise.resolve();
      },
      nextDelayMs: () => 0,
      isStopped: () => false,
      onFailure: (_error, count) => failures.push(count),
      onFailureLimit: () => undefined,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      clearScheduled: () => undefined,
    });

    loop.start();
    scheduled.shift()?.();
    await drainMicrotasks();
    scheduled.shift()?.();
    await drainMicrotasks();
    scheduled.shift()?.();
    await drainMicrotasks();

    expect(failures).toEqual([1]);
    expect(attempts).toBe(3);
    loop.stop();
  });

  test("stops scheduling once the agent is shutting down", async () => {
    const scheduled: Array<() => void> = [];
    let shuttingDown = false;
    let ticks = 0;

    const loop = createAgentHeartbeatLoop({
      runTick: () => {
        ticks += 1;
        return Promise.resolve();
      },
      nextDelayMs: () => 0,
      isStopped: () => shuttingDown,
      onFailure: () => undefined,
      onFailureLimit: () => undefined,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      clearScheduled: () => undefined,
    });

    loop.start();
    shuttingDown = true;
    scheduled.shift()?.();
    await drainMicrotasks();

    expect(ticks).toBe(0);
    expect(scheduled).toHaveLength(0);
  });
});

describe("buildAndDeployAppWithDependencies", () => {
  test("forwards resource limits into the deploy step", async () => {
    const calls: string[] = [];
    const ensureBaseRuntime = mock(async () => {
      calls.push("ensure");
    });
    const buildApp = mock(async () => {
      calls.push("build");
      return {
        imageUrl: "127.0.0.1:5000/nouva-app:dep_1",
        imageId: "img_candidate",
        imageSha: "sha256:test",
        buildDuration: 100,
        detectedLanguage: null,
        detectedFramework: null,
        languageVersion: null,
        internalPort: 8080,
      };
    });
    const deployAppImage = mock(async () => {
      calls.push("deploy");
      return {
        runtimeMetadata: null,
      };
    });

    await buildAndDeployAppWithDependencies(
      {
        ensureBaseRuntime,
        buildApp,
        deployAppImage,
      },
      {} as never,
      runtimeConfig,
      appPayload,
      { address: "tcp://127.0.0.1:1234", memoryBytes: 585 * 1024 * 1024 }
    );

    expect(calls).toEqual(["ensure", "build", "deploy"]);
    expect(buildApp).toHaveBeenCalledWith(
      expect.objectContaining({
        appBuildType: "dockerfile",
        appBuildConfig: appPayload.appBuildConfig,
        imageStoreMode: "docker-local",
        resourceLimits: appPayload.resourceLimits,
        buildkitAddress: "tcp://127.0.0.1:1234",
        // A failed build can only name the builder's budget if the deploy path hands it over (#215).
        builderMemoryBytes: 585 * 1024 * 1024,
        // Without this the build log redactor cannot tell `require` from `PGSSLMODE` apart from a
        // customer value, and masks it inside `requirements.txt` (#245).
        platformGeneratedValues: appPayload.platformGeneratedValues ?? [],
      })
    );
    expect(deployAppImage.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        volume: appPayload.volume,
        resourceLimits: appPayload.resourceLimits,
      })
    );
  });
});

describe("prepareAppBuildkitRuntime", () => {
  const createBuildkitDocker = () => ({
    createVolume: mock(async () => {}),
    ensureContainer: mock(async () => "buildkit_1"),
    removeContainer: mock(async () => {}),
  });

  test("creates an isolated resource-limited BuildKit worker for bounded app builds", async () => {
    const docker = createBuildkitDocker();
    const waitUntilReady = mock(async () => {});

    const runtime = await prepareAppBuildkitRuntime(
      docker as never,
      {
        deploymentId: "dep_1",
        serviceId: "svc_1",
        resourceLimits,
      },
      {
        allocatePort: async () => 4567,
        waitUntilReady,
      }
    );

    expect(runtime.address).toBe("tcp://127.0.0.1:4567");
    expect(docker.ensureContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "nouva-buildkitd-dep_1",
        cmd: [
          "--addr",
          "tcp://0.0.0.0:4567",
          "--oci-worker-gc",
          "--oci-worker-gc-keepstorage",
          "1000,4000,8000",
        ],
        hostConfig: expect.objectContaining({
          Privileged: true,
          NetworkMode: "host",
          RestartPolicy: {
            Name: "no",
          },
          // The state directory is a named per-service volume, so the layer cache survives to the
          // next deployment instead of being thrown away with the container (#184).
          Binds: ["nouva-buildkit-cache-svc_1:/var/lib/buildkit"],
          NanoCpus: expect.any(Number),
          Memory: expect.any(Number),
          MemorySwap: expect.any(Number),
          PidsLimit: 512,
        }),
      }),
      true
    );
    expect(waitUntilReady).toHaveBeenCalledWith("tcp://127.0.0.1:4567");

    // The budget a failed build names has to be the one the daemon actually got (#215).
    const [spec] = docker.ensureContainer.mock.calls[0] as unknown as [
      { hostConfig: { Memory: number } },
    ];
    expect(runtime.memoryBytes).toBe(spec.hostConfig.Memory);

    await runtime.cleanup();

    expect(docker.removeContainer).toHaveBeenCalledWith("nouva-buildkitd-dep_1", true);
  });

  test("keeps the cache volume out of the customer storage allowance", async () => {
    const docker = createBuildkitDocker();

    await prepareAppBuildkitRuntime(
      docker as never,
      {
        deploymentId: "dep_1",
        serviceId: "svc_1",
        resourceLimits,
      },
      {
        allocatePort: async () => 4567,
        waitUntilReady: async () => {},
      }
    );

    const [volumeName, labels] = docker.createVolume.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
    ];

    expect(volumeName).toBe("nouva-buildkit-cache-svc_1");
    expect(labels["nouva.kind"]).toBe("buildkit-cache");
    expect(labels["nouva.service.id"]).toBe("svc_1");
    // Volume accounting keys off `nouva.volume.id`; agent infrastructure must not carry it.
    expect(labels["nouva.volume.id"]).toBeUndefined();
    expect(volumeName.startsWith("nouva-vol-")).toBe(false);
  });

  test("reuses one cache per service across deployments", async () => {
    const docker = createBuildkitDocker();

    for (const deploymentId of ["dep_1", "dep_2"]) {
      await prepareAppBuildkitRuntime(
        docker as never,
        { deploymentId, serviceId: "svc_1", resourceLimits },
        { allocatePort: async () => 4567, waitUntilReady: async () => {} }
      );
    }
    await prepareAppBuildkitRuntime(
      docker as never,
      { deploymentId: "dep_3", serviceId: "svc_2", resourceLimits },
      { allocatePort: async () => 4567, waitUntilReady: async () => {} }
    );

    expect(docker.createVolume.mock.calls.map((call) => call[0])).toEqual([
      "nouva-buildkit-cache-svc_1",
      "nouva-buildkit-cache-svc_1",
      "nouva-buildkit-cache-svc_2",
    ]);
  });

  test("creates a scoped BuildKit worker when legacy payload limits are null", async () => {
    const docker = createBuildkitDocker();

    const runtime = await prepareAppBuildkitRuntime(
      docker as never,
      {
        deploymentId: "dep_1",
        serviceId: "svc_1",
        resourceLimits: null,
      },
      {
        allocatePort: async () => 4568,
        waitUntilReady: async () => {},
      }
    );

    expect(runtime.address).toBe("tcp://127.0.0.1:4568");
    expect(docker.ensureContainer).toHaveBeenCalled();

    await runtime.cleanup();

    expect(docker.removeContainer).toHaveBeenCalledWith("nouva-buildkitd-dep_1", true);
  });

  test("removes the container's anonymous BuildKit volume when a build fails to become ready", async () => {
    const docker = createBuildkitDocker();

    await expect(
      prepareAppBuildkitRuntime(
        docker as never,
        {
          deploymentId: "dep_1",
          serviceId: "svc_1",
          resourceLimits,
        },
        {
          allocatePort: async () => 4569,
          waitUntilReady: async () => {
            throw new Error("buildkit never became ready");
          },
        }
      )
    ).rejects.toThrow("buildkit never became ready");

    // `docker rm -v` only sweeps anonymous volumes, so the named cache survives a failed build.
    expect(docker.removeContainer).toHaveBeenCalledWith("nouva-buildkitd-dep_1", true);
  });
});

describe("buildAppContainerSpec", () => {
  test("includes Docker CPU and memory limits when resource limits are provided", () => {
    const spec = buildAppContainerSpec(runtimeConfig, appRuntimePayload);

    expect(spec.spec.hostConfig).toEqual(
      expect.objectContaining({
        NanoCpus: 1_500_000_000,
        Memory: 2 * 1024 * 1024 * 1024,
      })
    );
  });

  test("applies protected app defaults when legacy resource limits are null", () => {
    const spec = buildAppContainerSpec(runtimeConfig, {
      ...appRuntimePayload,
      resourceLimits: null,
    });

    expect(spec.spec.hostConfig).toEqual(
      expect.objectContaining({
        NanoCpus: 250_000_000,
        Memory: 512 * 1024 * 1024,
        MemorySwap: 512 * 1024 * 1024,
        PidsLimit: 256,
      })
    );
  });

  test("keeps the no-swap default when no allowance is stored", () => {
    const spec = buildAppContainerSpec(runtimeConfig, appRuntimePayload);

    expect(spec.spec.hostConfig).toEqual(
      expect.objectContaining({
        Memory: 2 * 1024 * 1024 * 1024,
        MemorySwap: 2 * 1024 * 1024 * 1024,
      })
    );
  });

  test("carries a bounded swap allowance into the candidate container", () => {
    const spec = buildAppContainerSpec(runtimeConfig, {
      ...appRuntimePayload,
      resourceLimits: { ...resourceLimits, memoryAndSwapBytes: 3 * 1024 * 1024 * 1024 },
    });

    expect(spec.spec.hostConfig).toEqual(
      expect.objectContaining({
        NanoCpus: 1_500_000_000,
        Memory: 2 * 1024 * 1024 * 1024,
        MemorySwap: 3 * 1024 * 1024 * 1024,
        PidsLimit: 256,
      })
    );
  });

  test("mounts managed app volumes when they are provided", () => {
    const spec = buildAppContainerSpec(runtimeConfig, appRuntimePayload);

    expect(spec.spec.hostConfig).toEqual(
      expect.objectContaining({
        Mounts: [
          {
            Type: "volume",
            Source: "nouva-vol-vol_1",
            Target: "/data",
          },
        ],
      })
    );
  });

  test("stamps environment labels for app containers", () => {
    const spec = buildAppContainerSpec(runtimeConfig, appRuntimePayload);

    expect(spec.spec.labels).toEqual(
      expect.objectContaining({
        "nouva.environment.id": "env_1",
        "nouva.project.id": "proj_1",
        "nouva.service.id": "svc_1",
        "nouva.deployment.id": "dep_1",
        "nouva.kind": "app",
        "nouva.redaction.context.version": "hmac-sha256:redaction-context:v1:deployment",
      })
    );
  });

  test("injects the resolved PORT so the container listens on what the agent will probe (#152)", () => {
    const spec = buildAppContainerSpec(runtimeConfig, appRuntimePayload);

    expect(spec.appPort).toBe(8080);
    expect(spec.spec.env).toContain("PORT=8080");
  });

  test("falls back to the default port and still injects it when no PORT is set anywhere", () => {
    const spec = buildAppContainerSpec(runtimeConfig, {
      ...appRuntimePayload,
      envVars: {},
      internalPort: null,
    });

    expect(spec.appPort).toBe(3000);
    expect(spec.spec.env).toContain("PORT=3000");
  });

  test("overrides an invalid user-provided PORT with the resolved fallback", () => {
    const spec = buildAppContainerSpec(runtimeConfig, {
      ...appRuntimePayload,
      envVars: { PORT: "not-a-port" },
      internalPort: null,
    });

    expect(spec.appPort).toBe(3000);
    expect(spec.spec.env).toContain("PORT=3000");
    expect(spec.spec.env).not.toContain("PORT=not-a-port");
  });
});

describe("deployAppImageWithDependencies", () => {
  function retryFixture() {
    const docker = createDockerMock();
    const candidate = {
      Id: "ctr_candidate",
      Name: "/nouva-app-svc_1-dep_1",
      Config: {
        Image: appRuntimePayload.imageUrl,
        Labels: {
          "nouva.managed": "true",
          "nouva.service.id": "svc_1",
          "nouva.deployment.id": "dep_1",
        },
      },
      Mounts: [
        {
          Type: "volume",
          Name: appRuntimePayload.volume!.volumeName,
          Destination: appRuntimePayload.volume!.mountPath,
        },
      ],
      State: { Running: true, Health: { Status: "healthy" } },
    };
    docker.listContainersByLabels.mockResolvedValue([candidate] as never);
    docker.listContainersUsingVolume.mockResolvedValue([candidate] as never);
    docker.inspectContainer.mockImplementation(async (name: string) =>
      name === "old" ? null : (candidate as never)
    );
    const dependencies = {
      ensureBaseRuntime: async () => {},
      checkTcpConnect: async () => true,
      fetchImpl: mock(async () =>
        Response.json([
          {
            name: "svc-svc_1@file",
            loadBalancer: { servers: [{ url: "http://nouva-app-svc_1-dep_1:8080" }] },
          },
        ])
      ) as typeof fetch,
      writeLocalTraefikRoute: mock(async () => {}),
      deleteLocalTraefikRoute: mock(async () => {}),
      sleep: mock(async () => {}),
    };
    const payload = {
      ...appRuntimePayload,
      rollout: createRolloutConfig(),
      runtimeMetadata: { containerName: "old" },
    };
    return { docker, candidate, dependencies, payload };
  }

  test.each([
    false,
    true,
  ])("re-leased deploy adopts image-declared anonymous volumes (platform volume=%s)", async (platformVolume) => {
    const { docker, candidate, dependencies, payload } = retryFixture();
    const anonymousVolume = "a".repeat(64);
    Object.assign(candidate, {
      Image: "sha256:original-image",
      HostConfig: platformVolume
        ? {
            Mounts: [
              {
                Type: "volume",
                Source: payload.volume!.volumeName,
                Target: payload.volume!.mountPath,
              },
            ],
          }
        : {},
    });
    candidate.Mounts = [
      ...(platformVolume ? candidate.Mounts : []),
      { Type: "volume", Name: anonymousVolume, Destination: "/image-data" },
    ];
    docker.inspectImage.mockImplementation(async (image: string) => ({
      Id: "sha256:original-image",
      ...(image === "sha256:original-image" ? { Config: { Volumes: { "/image-data": {} } } } : {}),
    }));
    docker.inspectVolume.mockResolvedValue({ Name: anonymousVolume, Labels: null } as never);
    const result = await deployAppImageWithDependencies(
      dependencies,
      docker as never,
      runtimeConfig,
      { ...payload, volume: platformVolume ? payload.volume : null }
    );
    expect(result.runtimeMetadata.containerId).toBe(candidate.Id);
    expect(result.rollout.reusedCandidate).toBe(true);
    expect(result.rollout.outcome).toBe("committed");
    expect(dependencies.writeLocalTraefikRoute).toHaveBeenCalledTimes(1);
    expect(docker.inspectImage).toHaveBeenCalledWith("sha256:original-image");
    if (platformVolume)
      expect(docker.listContainersUsingVolume).toHaveBeenCalledWith(payload.volume!.volumeName);
    expect(docker.ensureContainer).not.toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(docker.startContainer).not.toHaveBeenCalled();
    expect(docker.stopContainer).not.toHaveBeenCalled();
  });

  test.each([
    "named",
    "managed-name",
    "managed-label",
    "volume-id-label",
    "undeclared",
    "explicit",
    "bind",
    "volumes-from",
    "missing-image-id",
    "missing-image",
    "missing-declarations",
    "missing-host-config",
    "missing-volume",
    "volume-inspection-mismatch",
    "non-volume",
    "platform-path-conflict",
  ])("retry rejects %s extra mounts without mutating either runtime", async (problem) => {
    for (const platformVolume of [false, true]) {
      const { docker, candidate, dependencies, payload } = retryFixture();
      const anonymousVolume = "a".repeat(64);
      Object.assign(candidate, { Image: "sha256:original-image", HostConfig: {} });
      const extraMount = { Type: "volume", Name: anonymousVolume, Destination: "/image-data" };
      candidate.Mounts = [...(platformVolume ? candidate.Mounts : []), extraMount];
      docker.inspectImage.mockResolvedValue({
        Id: "sha256:original-image",
        Config: { Volumes: { "/image-data": {}, [payload.volume!.mountPath]: {} } },
      } as never);
      docker.inspectVolume.mockResolvedValue({ Name: anonymousVolume, Labels: null } as never);
      if (problem === "named") extraMount.Name = "user-named-volume";
      if (problem === "managed-name") extraMount.Name = "nouva-vol-unexpected";
      if (problem === "managed-label" || problem === "volume-id-label")
        docker.inspectVolume.mockResolvedValue({
          Name: anonymousVolume,
          Labels:
            problem === "managed-label"
              ? { "nouva.managed": "true" }
              : { "nouva.volume.id": "other" },
        } as never);
      if (problem === "undeclared") extraMount.Destination = "/undeclared";
      if (problem === "explicit")
        Object.assign(candidate, {
          HostConfig: {
            Mounts: [{ Type: "volume", Source: anonymousVolume, Target: "/image-data" }],
          },
        });
      if (problem === "bind")
        Object.assign(candidate, { HostConfig: { Binds: [`${anonymousVolume}:/image-data`] } });
      if (problem === "volumes-from")
        Object.assign(candidate, { HostConfig: { VolumesFrom: ["other"] } });
      if (problem === "missing-image-id") Object.assign(candidate, { Image: undefined });
      if (problem === "missing-image") docker.inspectImage.mockResolvedValue(null as never);
      if (problem === "missing-declarations")
        docker.inspectImage.mockResolvedValue({ Id: "sha256:original-image" });
      if (problem === "missing-host-config") Object.assign(candidate, { HostConfig: undefined });
      if (problem === "missing-volume") docker.inspectVolume.mockResolvedValue(null);
      if (problem === "volume-inspection-mismatch")
        docker.inspectVolume.mockResolvedValue({ Name: "other", Labels: null } as never);
      if (problem === "non-volume") extraMount.Type = "bind";
      if (problem === "platform-path-conflict") {
        extraMount.Destination = payload.volume!.mountPath;
        // With no platform volume, the same conflict is an explicitly configured mount.
        if (!platformVolume)
          Object.assign(candidate, {
            HostConfig: { Mounts: [{ Target: extraMount.Destination }] },
          });
      }
      await expect(
        deployAppImageWithDependencies(dependencies, docker as never, runtimeConfig, {
          ...payload,
          volume: platformVolume ? payload.volume : null,
        })
      ).rejects.toThrow(
        "Existing app candidate does not match deployment ownership or configuration"
      );
      expect(dependencies.writeLocalTraefikRoute).not.toHaveBeenCalled();
      expect(docker.removeContainer).not.toHaveBeenCalled();
      expect(docker.startContainer).not.toHaveBeenCalled();
      expect(docker.stopContainer).not.toHaveBeenCalled();
      expect(docker.createContainer).not.toHaveBeenCalled();
      expect(docker.ensureContainer).not.toHaveBeenCalled();
    }
  });

  test("snapshot preflight never restarts an old writer alongside an unexpected consumer", async () => {
    const { docker, dependencies, payload } = retryFixture();
    docker.listContainersByLabels.mockResolvedValue([]);
    await expect(
      deployAppImageWithDependencies(dependencies, docker as never, runtimeConfig, payload)
    ).rejects.toThrow("another running consumer");
    expect(docker.startContainer).not.toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  test("deploy workflow survives accepted-but-lost completion and a later process re-lease", async () => {
    const { docker, candidate, dependencies, payload } = retryFixture();
    let exists = false;
    docker.listContainersByLabels.mockImplementation(async () =>
      exists ? ([candidate] as never) : []
    );
    docker.listContainersUsingVolume.mockImplementation(async () =>
      exists ? ([candidate] as never) : []
    );
    docker.ensureContainer.mockImplementation(async () => {
      exists = true;
      return candidate.Id;
    });
    const rejected = mock(async () => ({
      kind: "fail" as const,
      result: null,
      errorMessage: "unexpected rejection",
    }));
    let completions = 0;
    for (const restarted of [false, true]) {
      await executeAndReportAgentWork({
        work: { id: "w", kind: "deploy_app" },
        prepare: async () => ({
          kind: "complete",
          result: await deployAppImageWithDependencies(
            dependencies,
            docker as never,
            runtimeConfig,
            { ...payload, runtimeMetadata: restarted ? payload.runtimeMetadata : null }
          ),
        }),
        send: async () => {
          if (++completions === 1) throw new TypeError("accepted completion reply lost");
        },
        rejectResult: rejected,
        stopLease: async () => {},
        redactError: () => "safe",
        sleep: async () => {},
        log: () => {},
      });
    }
    expect(completions).toBe(3);
    expect(docker.ensureContainer).toHaveBeenCalledTimes(1);
    expect(rejected).not.toHaveBeenCalled();
    expect(
      docker.removeContainer.mock.calls.some(
        ([name]) => name === candidate.Id || name === "nouva-app-svc_1-dep_1"
      )
    ).toBe(false);
  });

  test.each([
    "sanitizer",
    "422",
  ])("adopted runtime survives %s rejection with stale control-plane metadata", async (rejection) => {
    const { docker, dependencies, payload } = retryFixture();
    const result = await deployAppImageWithDependencies(
      dependencies,
      docker as never,
      runtimeConfig,
      payload
    );
    const rejectResult = async () => {
      await rollbackUnreportableWorkResult(docker as never, {
        kind: "deploy_app",
        workItemId: "w",
        payload,
        result,
      });
      return { kind: "fail" as const, result: null, errorMessage: "rejected" };
    };
    await executeAndReportAgentWork({
      work: { id: "w", kind: "deploy_app" },
      prepare: async () => {
        if (rejection === "sanitizer") {
          expect(() => sanitizeAgentWorkResult(result, { SECRET: "ctr_candidate" })).toThrow();
          return await rejectResult();
        }
        return { kind: "complete", result: sanitizeAgentWorkResult(result, {}) };
      },
      send: async (report) => {
        if (report.kind === "complete")
          throw new ApiRequestError({
            status: 422,
            method: "POST",
            pathName: "/complete",
            message: "rejected",
          });
      },
      rejectResult,
      stopLease: async () => {},
      redactError: () => "safe",
      log: () => {},
    });
    expect(docker.removeContainer).not.toHaveBeenCalled();
  });

  test.each([
    "service",
    "deployment",
    "managed",
    "image",
    "volume",
    "volume-path",
    "volume-type",
    "writer",
    "readiness",
    "cutover",
  ])("retry refuses %s mismatch without deleting the candidate or restarting the old writer", async (problem) => {
    const { docker, candidate, dependencies, payload } = retryFixture();
    if (problem === "service") candidate.Config.Labels["nouva.service.id"] = "foreign";
    if (problem === "deployment") candidate.Config.Labels["nouva.deployment.id"] = "foreign";
    if (problem === "managed") candidate.Config.Labels["nouva.managed"] = "false";
    if (problem === "image") candidate.Config.Image = "other:image";
    if (problem === "volume") candidate.Mounts[0]!.Name = "other-volume";
    if (problem === "volume-path") candidate.Mounts[0]!.Destination = "/other-path";
    if (problem === "volume-type") candidate.Mounts[0]!.Type = "bind";
    if (problem === "writer")
      docker.listContainersUsingVolume.mockResolvedValue([
        candidate,
        { ...candidate, Id: "other", Name: "/other" },
      ] as never);
    if (problem === "readiness") candidate.State.Health.Status = "unhealthy";
    if (problem === "cutover")
      dependencies.fetchImpl = mock(async () => Response.json([])) as typeof fetch;
    await expect(
      deployAppImageWithDependencies(dependencies, docker as never, runtimeConfig, payload)
    ).rejects.toThrow();
    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(docker.startContainer).not.toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(docker.ensureContainer).not.toHaveBeenCalled();
  });

  test.each([
    "ctr_candidate",
    "nouva-app-svc_1-dep_1",
    "/nouva-app-svc_1-dep_1",
  ])("retry never retires its own previous-container alias %s", async (alias) => {
    const { docker, dependencies, payload } = retryFixture();
    payload.runtimeMetadata.containerName = alias;
    await deployAppImageWithDependencies(dependencies, docker as never, runtimeConfig, payload);
    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(docker.stopContainer).not.toHaveBeenCalled();
  });

  test.each([
    "throws",
    "still-present",
  ])("stopped candidate cleanup %s cannot snapshot or restore a writer", async (failure) => {
    const { docker, candidate, dependencies, payload } = retryFixture();
    candidate.State.Running = false;
    if (failure === "throws") docker.removeContainer.mockRejectedValue(new Error("remove failed"));
    await expect(
      deployAppImageWithDependencies(dependencies, docker as never, runtimeConfig, payload)
    ).rejects.toThrow();
    expect(docker.startContainer).not.toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(docker.ensureContainer).not.toHaveBeenCalled();
  });

  test.each([
    false,
    true,
  ])("retirement retries are bounded and never roll back the healthy candidate (persistent=%s)", async (persistent) => {
    const { docker, candidate, dependencies, payload } = retryFixture();
    docker.inspectContainer.mockImplementation(async (name: string) =>
      name === "old"
        ? ({ ...candidate, Id: "old-id", Name: "/old", State: { Running: false } } as never)
        : (candidate as never)
    );
    if (persistent) docker.removeContainer.mockRejectedValue(new Error("remove failed"));
    else docker.removeContainer.mockRejectedValueOnce(new Error("remove failed"));
    const result = await deployAppImageWithDependencies(
      dependencies,
      docker as never,
      runtimeConfig,
      payload
    );
    expect(result.rollout.previousContainerRetirement).toBe(persistent ? "deferred" : "graceful");
    expect(docker.removeContainer).toHaveBeenCalledTimes(persistent ? 3 : 2);
    expect(docker.removeContainer.mock.calls.every(([name]) => name === "old")).toBe(true);
    expect(result.rollout.outcome).toBe("committed");
  });

  test("re-leased volume deploy adopts its running candidate after a lost completion and stale metadata", async () => {
    const docker = createDockerMock();
    const candidate = {
      Id: "ctr_candidate",
      Name: "/nouva-app-svc_1-dep_1",
      Config: {
        Image: appRuntimePayload.imageUrl,
        Labels: {
          "nouva.managed": "true",
          "nouva.service.id": "svc_1",
          "nouva.deployment.id": "dep_1",
        },
      },
      Mounts: [
        {
          Type: "volume",
          Name: appRuntimePayload.volume!.volumeName,
          Destination: appRuntimePayload.volume!.mountPath,
        },
      ],
      State: { Running: true, Health: { Status: "healthy" } },
    };
    docker.listContainersByLabels.mockResolvedValue([candidate] as never);
    docker.listContainersUsingVolume.mockResolvedValue([candidate] as never);
    docker.inspectContainer.mockImplementation(async (name: string) =>
      name === "already-retired" ? null : (candidate as never)
    );
    const result = await deployAppImageWithDependencies(
      {
        ensureBaseRuntime: async () => {},
        checkTcpConnect: async () => true,
        fetchImpl: mock(async () =>
          Response.json([
            {
              name: "svc-svc_1@file",
              loadBalancer: { servers: [{ url: "http://nouva-app-svc_1-dep_1:8080" }] },
            },
          ])
        ) as typeof fetch,
        writeLocalTraefikRoute: async () => {},
        deleteLocalTraefikRoute: async () => {},
      },
      docker as never,
      runtimeConfig,
      {
        ...appRuntimePayload,
        rollout: createRolloutConfig(),
        runtimeMetadata: { containerName: "already-retired" },
      }
    );
    expect(result.runtimeMetadata.containerId).toBe("ctr_candidate");
    expect(docker.ensureContainer).not.toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(docker.startContainer).not.toHaveBeenCalled();
    expect(docker.removeContainer).not.toHaveBeenCalled();
  });

  test("uses the backward-compatible thirty-second drain defaults", () => {
    expect(resolveAppRolloutConfig(null).drain).toEqual({
      durationMs: 30_000,
      gracefulStopTimeoutSeconds: 10,
      cleanupTimeoutMs: 15_000,
    });
  });

  test("keeps the live container in place until the candidate is ready and cut over", async () => {
    const docker = createDockerMock();
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) => {
      if (name === "nouva-app-svc_1-dep_1") {
        return {
          Id: "ctr_candidate",
          Name: name,
          State: {
            Running: true,
          },
          NetworkSettings: {
            Networks: {
              "nouva-local": {
                IPAddress: "172.19.0.10",
              },
            },
          },
        };
      }

      return null;
    });

    const writeLocalTraefikRoute = mock(async () => {});
    const deleteLocalTraefikRoute = mock(async () => {});
    const checkTcpConnect = mock(async () => true);
    const drainSleep = mock(async () => undefined);
    const fetchImpl: typeof fetch = mock(async () =>
      Response.json([
        {
          name: "svc-svc_1@file",
          loadBalancer: {
            servers: [{ url: "http://nouva-app-svc_1-dep_1:8080" }],
          },
        },
      ])
    ) as typeof fetch;

    const result = await deployAppImageWithDependencies(
      {
        ensureBaseRuntime: async () => undefined,
        checkTcpConnect,
        fetchImpl,
        writeLocalTraefikRoute,
        deleteLocalTraefikRoute,
        sleep: drainSleep,
      },
      docker as never,
      runtimeConfig,
      {
        ...appRuntimePayload,
        volume: null,
        rollout: createRolloutConfig({
          drain: {
            durationMs: 30_000,
            gracefulStopTimeoutSeconds: 10,
            cleanupTimeoutMs: 15_000,
          },
        }),
        runtimeMetadata: {
          image: "nouva-app:dep_prev",
          imageStoreMode: "docker-local",
          containerName: "nouva-app-svc_1-live",
          currentImage: {
            reference: "nouva-app:dep_prev",
            imageId: "img_prev",
            deploymentId: "dep_prev",
            commitHash: "prev123",
          },
          previousImage: {
            reference: "nouva-app:dep_older",
            imageId: "img_older",
            deploymentId: "dep_older",
            commitHash: "older123",
          },
          internalPort: 8080,
        },
      }
    );

    expect(docker.ensureContainer).toHaveBeenCalledWith(expect.anything(), true, { pull: false });
    expect(checkTcpConnect).toHaveBeenCalledWith("172.19.0.10", 8080, 1);
    expect(writeLocalTraefikRoute).toHaveBeenCalledWith(
      expect.anything(),
      "svc_1",
      {
        providedHostname: "app.up.nouva.cloud",
        customHostnames: [],
      },
      "http://nouva-app-svc_1-dep_1:8080"
    );
    expect(drainSleep).toHaveBeenCalledWith(30_000);
    expect(fetchImpl.mock.invocationCallOrder[0]).toBeLessThan(
      drainSleep.mock.invocationCallOrder[0]!
    );
    expect(drainSleep.mock.invocationCallOrder[0]).toBeLessThan(
      docker.stopContainer.mock.invocationCallOrder[0]!
    );
    expect(docker.stopContainer).toHaveBeenCalledWith("nouva-app-svc_1-live", 10, 15_000);
    expect(docker.removeContainer.mock.calls).toEqual([["nouva-app-svc_1-live", false, 15_000]]);
    expect(docker.removeImage).toHaveBeenCalledWith("nouva-app:dep_older", true);
    expect(result.runtimeMetadata).toEqual(
      expect.objectContaining({
        imageStoreMode: "docker-local",
        currentImage: expect.objectContaining({
          reference: "127.0.0.1:5000/nouva-app:dep_1",
          imageId: "img_candidate",
          deploymentId: "dep_1",
          commitHash: "abc123",
        }),
        previousImage: expect.objectContaining({
          reference: "nouva-app:dep_prev",
          imageId: "img_prev",
          deploymentId: "dep_prev",
          commitHash: "prev123",
        }),
      })
    );
    expect(result.rollout).toEqual(
      expect.objectContaining({
        outcome: "committed",
        currentPhase: "retire",
        drainDurationMs: 30_000,
        previousContainerRetirement: "graceful",
      })
    );
  });

  describe("release phases", () => {
    const candidateName = "nouva-app-svc_1-dep_1";
    const liveName = "nouva-app-svc_1-live";
    const verify = (onFailure: "keep" | "rollback") => ({
      command: "curl -fsS $NOUVA_CANDIDATE_URL",
      timeoutSeconds: 30,
      onFailure,
    });

    function releaseFixture(releaseJobs: DeployAppImageInput["releaseJobs"]) {
      const docker = createDockerMock();
      docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
      docker.inspectContainer.mockImplementation(
        async (name: string) =>
          (name === candidateName || name === liveName
            ? {
                Id: name === candidateName ? "ctr_candidate" : "ctr_live",
                Name: name,
                State: { Running: true },
                NetworkSettings: { Networks: { "nouva-local": { IPAddress: "172.19.0.10" } } },
              }
            : null) as never
      );
      // Traefik reports whichever backend the agent last routed to.
      let routedUrl = "";
      const writeLocalTraefikRoute = mock(
        async (_paths: unknown, _serviceId: string, _hosts: unknown, url: string) => {
          routedUrl = url;
        }
      );
      const fetchImpl = mock(async () =>
        Response.json([{ name: "svc-svc_1@file", loadBalancer: { servers: [{ url: routedUrl }] } }])
      ) as unknown as typeof fetch;
      const dependencies = {
        ensureBaseRuntime: async () => undefined,
        checkTcpConnect: mock(async () => true),
        fetchImpl,
        writeLocalTraefikRoute,
        deleteLocalTraefikRoute: mock(async () => {}),
        sleep: mock(async () => undefined),
      };
      const payload: DeployAppImageInput = {
        ...appRuntimePayload,
        volume: null,
        rollout: createRolloutConfig(),
        runtimeMetadata: { containerName: liveName, internalPort: 8080 },
        releaseJobs,
      };
      const runs: ReleasePhaseRequest[] = [];
      const runner = (results: Partial<Record<ReleasePhase, ReleasePhaseResult>>) => ({
        run: mock(
          async (
            _target: ReleaseJobTarget,
            request: ReleasePhaseRequest
          ): Promise<ReleasePhaseResult> => {
            runs.push(request);
            const result = results[request.phase] ?? { kind: "succeeded" as const, attempt: 1 };
            // Like a run that just finished an attempt, the result carries the policy it reported.
            return result.kind === "unsuccessful" && request.resolveAppliedPolicy
              ? {
                  ...result,
                  appliedPolicy: (await request.resolveAppliedPolicy(result.outcome)) ?? null,
                }
              : result;
          }
        ),
      });
      return { docker, dependencies, payload, runs, runner };
    }

    const failed = (phase: ReleasePhase): ReleasePhaseResult => ({
      kind: "unsuccessful",
      attempt: 1,
      outcome: "failed",
      message: `The ${phase} job failed`,
      appliedPolicy: null,
    });

    test("a failed pre-activation job creates no candidate and keeps the live deployment", async () => {
      const { docker, dependencies, payload, runs, runner } = releaseFixture({
        preActivation: { command: "bun run migrate", timeoutSeconds: 60 },
        verification: null,
      });

      const error = await deployAppImageWithDependencies(
        dependencies,
        docker as never,
        runtimeConfig,
        payload,
        runner({ pre_activation: failed("pre_activation") })
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ReleaseJobHaltError);
      expect((error as ReleaseJobHaltError).message).toBe("The pre_activation job failed");
      expect((error as ReleaseJobHaltError).result.rollout).toMatchObject({
        outcome: "aborted_before_cutover",
        currentPhase: "release",
        liveRuntimePreserved: true,
        activeContainerName: liveName,
      });
      expect(runs.map((request) => request.phase)).toEqual(["pre_activation"]);
      expect(docker.ensureContainer).not.toHaveBeenCalled();
      expect(docker.stopContainer).not.toHaveBeenCalled();
      expect(dependencies.writeLocalTraefikRoute).not.toHaveBeenCalled();
    });

    const rolledBackRelease = {
      preActivation: { command: "bun run migrate", timeoutSeconds: 60 },
      verification: verify("rollback"),
      verificationRolledBack: true,
    };

    /** The candidate an earlier run left running, e.g. when it stopped in the middle of rolling back. */
    function leaveCandidateRunning(docker: ReturnType<typeof releaseFixture>["docker"]) {
      docker.listContainersByLabels.mockResolvedValue([
        {
          Id: "ctr_candidate",
          Name: `/${candidateName}`,
          Config: {
            Image: appRuntimePayload.imageUrl,
            Labels: {
              "nouva.managed": "true",
              "nouva.service.id": "svc_1",
              "nouva.deployment.id": "dep_1",
            },
          },
          Mounts: [],
          State: { Running: true },
        },
      ] as never);
    }

    function haltedRollout(error: unknown) {
      expect(error).toBeInstanceOf(ReleaseJobHaltError);
      expect((error as ReleaseJobHaltError).message).toContain("already failed");
      return (error as ReleaseJobHaltError).result.rollout;
    }

    test("a release an earlier run rolled back is not cut over to again", async () => {
      const { docker, dependencies, payload, runs, runner } = releaseFixture(rolledBackRelease);

      const error = await deployAppImageWithDependencies(
        dependencies,
        docker as never,
        runtimeConfig,
        payload,
        runner({})
      ).catch((caught: unknown) => caught);

      // Traffic already went back, so the rollback is complete and its message stays as recorded.
      expect(haltedRollout(error)).toMatchObject({
        outcome: "aborted_before_cutover",
        liveRuntimePreserved: true,
        rollbackCompleted: true,
        activeContainerName: liveName,
      });
      expect(runs).toEqual([]);
      expect(docker.ensureContainer).not.toHaveBeenCalled();
      expect(dependencies.writeLocalTraefikRoute.mock.calls.map((call) => call[3])).toEqual([
        `http://${liveName}:8080`,
      ]);
    });

    test("a rollback an earlier run left half done is finished, not undone", async () => {
      const { docker, dependencies, payload, runs, runner } = releaseFixture(rolledBackRelease);
      leaveCandidateRunning(docker);

      const error = await deployAppImageWithDependencies(
        dependencies,
        docker as never,
        runtimeConfig,
        payload,
        runner({})
      ).catch((caught: unknown) => caught);

      expect(haltedRollout(error)).toMatchObject({
        outcome: "aborted_before_cutover",
        liveRuntimePreserved: true,
        rollbackCompleted: true,
        activeContainerName: liveName,
      });
      expect(dependencies.writeLocalTraefikRoute.mock.calls.map((call) => call[3])).toEqual([
        `http://${liveName}:8080`,
      ]);
      expect(docker.removeContainer).toHaveBeenCalledWith(candidateName, true);
      // Traffic left the candidate before the candidate did.
      expect(dependencies.writeLocalTraefikRoute.mock.invocationCallOrder[0]).toBeLessThan(
        docker.removeContainer.mock.invocationCallOrder[0]!
      );
      expect(runs).toEqual([]);
    });

    test("a rejected release keeps serving only when the previous one cannot", async () => {
      const { docker, dependencies, payload, runner } = releaseFixture(rolledBackRelease);
      leaveCandidateRunning(docker);
      const inspectServing = docker.inspectContainer.getMockImplementation()!;
      docker.inspectContainer.mockImplementation(async (name: string) =>
        name === liveName
          ? ({
              Id: "ctr_live",
              Name: liveName,
              RestartCount: 4,
              State: { Running: false, Status: "exited", ExitCode: 1, OOMKilled: false },
            } as never)
          : inspectServing(name)
      );

      const result = await deployAppImageWithDependencies(
        dependencies,
        docker as never,
        runtimeConfig,
        payload,
        runner({})
      );

      expect(result.rollout.outcome).toBe("committed");
      expect(dependencies.writeLocalTraefikRoute.mock.calls.map((call) => call[3])).toEqual([
        `http://${candidateName}:8080`,
      ]);
      expect(docker.removeContainer).not.toHaveBeenCalledWith(candidateName, true);
    });

    test("a pre-activation job that breaks down still keeps the live deployment", async () => {
      const { docker, dependencies, payload } = releaseFixture({
        preActivation: { command: "bun run migrate", timeoutSeconds: 60 },
        verification: null,
      });
      const phases = {
        run: mock(async (): Promise<ReleasePhaseResult> => {
          throw new Error("docker unavailable");
        }),
      };

      const error = await deployAppImageWithDependencies(
        dependencies,
        docker as never,
        runtimeConfig,
        payload,
        phases
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ReleaseJobHaltError);
      expect((error as ReleaseJobHaltError).message).toBe("docker unavailable");
      expect((error as ReleaseJobHaltError).result.rollout).toMatchObject({
        outcome: "aborted_before_cutover",
        liveRuntimePreserved: true,
        activeContainerName: liveName,
      });
      expect(docker.ensureContainer).not.toHaveBeenCalled();
    });

    test("a pre-activation job that has to wait returns the work instead of failing it", async () => {
      const { docker, dependencies, payload } = releaseFixture({
        preActivation: { command: "bun run migrate", timeoutSeconds: 60 },
        verification: null,
      });
      const phases = {
        run: mock(async (): Promise<ReleasePhaseResult> => {
          throw new ReleaseJobDeferredError("Waiting on the pre-activation job of deployment x");
        }),
      };

      await expect(
        deployAppImageWithDependencies(
          dependencies,
          docker as never,
          runtimeConfig,
          payload,
          phases
        )
      ).rejects.toBeInstanceOf(ReleaseJobDeferredError);
    });

    test("a worker's pre-activation breakdown carries its preserved replicas", async () => {
      // The worker deploy passes this rollout; its replicas are not touched before the phase ends.
      const rollout = { liveRuntimePreserved: true };
      const phases = {
        run: mock(async (): Promise<ReleasePhaseResult> => {
          throw Object.assign(new Error("claim rejected"), { status: 404 });
        }),
      };

      const error = await runPreActivation(
        phases,
        {} as ReleaseJobTarget,
        { phase: "pre_activation", command: "bun run migrate", timeoutSeconds: 60 },
        rollout
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ReleaseJobHaltError);
      expect((error as ReleaseJobHaltError).result).toEqual({ rollout });
    });

    test("the pre-activation job runs first, with the candidate's image, env and PORT", async () => {
      const { docker, dependencies, payload, runner } = releaseFixture({
        preActivation: { command: "bun run migrate", timeoutSeconds: 60 },
        verification: null,
      });
      const phases = runner({});

      await deployAppImageWithDependencies(
        dependencies,
        docker as never,
        runtimeConfig,
        { ...payload, envVars: { DATABASE_URL: "postgres://db/app" } },
        phases
      );

      const target = phases.run.mock.calls[0]?.[0];
      expect(target?.image).toBe(payload.imageUrl);
      expect(target?.envVars).toEqual({ DATABASE_URL: "postgres://db/app", PORT: "8080" });
      expect(target?.networkName).toBe(docker.ensureNetwork.mock.calls[0]?.[0] as never);
      expect(phases.run.mock.invocationCallOrder[0]).toBeLessThan(
        docker.ensureContainer.mock.invocationCallOrder[0]!
      );
    });

    test("a failed verification under rollback returns traffic to the previous deployment", async () => {
      const { docker, dependencies, payload, runs, runner } = releaseFixture({
        preActivation: null,
        verification: verify("rollback"),
      });

      await expect(
        deployAppImageWithDependencies(
          dependencies,
          docker as never,
          runtimeConfig,
          payload,
          runner({ verification: failed("verification") })
        )
      ).rejects.toThrow("The verification job failed");

      expect(runs[0]?.phaseEnv).toEqual({ NOUVA_CANDIDATE_URL: `http://${candidateName}:8080` });
      expect(await runs[0]?.resolveAppliedPolicy?.("failed")).toBe("rollback");
      // An unknown result never rolls back, whatever the policy.
      expect(await runs[0]?.resolveAppliedPolicy?.("outcome_unknown")).toBe("keep");
      expect(dependencies.writeLocalTraefikRoute.mock.calls.map((call) => call[3])).toEqual([
        `http://${candidateName}:8080`,
        `http://${liveName}:8080`,
      ]);
      expect(docker.removeContainer).toHaveBeenCalledWith(candidateName, true);
      // Traffic left the candidate before the candidate did.
      expect(dependencies.writeLocalTraefikRoute.mock.invocationCallOrder[1]).toBeLessThan(
        docker.removeContainer.mock.invocationCallOrder[0]!
      );
      expect(docker.stopContainer).not.toHaveBeenCalled();
    });

    test("a rollback whose route cannot move keeps the new deployment serving", async () => {
      const { docker, dependencies, payload, runner } = releaseFixture({
        preActivation: null,
        verification: verify("rollback"),
      });
      const route = dependencies.writeLocalTraefikRoute.getMockImplementation()!;
      dependencies.writeLocalTraefikRoute.mockImplementation(
        async (paths: unknown, serviceId: string, hosts: unknown, url: string) => {
          if (url === `http://${liveName}:8080`) {
            throw new Error("traefik config not writable");
          }
          await route(paths, serviceId, hosts, url);
        }
      );

      const result = await deployAppImageWithDependencies(
        dependencies,
        docker as never,
        runtimeConfig,
        payload,
        runner({ verification: failed("verification") })
      );

      // LIVE, where the control plane corrects the reported rollback to keep.
      expect(result.rollout.outcome).toBe("committed");
      expect(dependencies.writeLocalTraefikRoute.mock.calls.map((call) => call[3])).toEqual([
        `http://${candidateName}:8080`,
        `http://${liveName}:8080`,
        `http://${candidateName}:8080`,
      ]);
      expect(docker.removeContainer).not.toHaveBeenCalledWith(candidateName, true);
    });

    test("a route that moves neither way still keeps the new deployment serving", async () => {
      const { docker, dependencies, payload, runner } = releaseFixture({
        preActivation: null,
        verification: verify("rollback"),
      });
      const route = dependencies.writeLocalTraefikRoute.getMockImplementation()!;
      let candidateWrites = 0;
      dependencies.writeLocalTraefikRoute.mockImplementation(
        async (paths: unknown, serviceId: string, hosts: unknown, url: string) => {
          if (url === `http://${candidateName}:8080`) candidateWrites += 1;
          if (url === `http://${liveName}:8080` || candidateWrites > 1) {
            throw new Error("traefik config not writable");
          }
          await route(paths, serviceId, hosts, url);
        }
      );

      const result = await deployAppImageWithDependencies(
        dependencies,
        docker as never,
        runtimeConfig,
        payload,
        runner({ verification: failed("verification") })
      );

      expect(result.rollout.outcome).toBe("committed");
      expect(docker.removeContainer).not.toHaveBeenCalledWith(candidateName, true);
    });

    test("a failed verification under keep leaves the new deployment serving", async () => {
      const { docker, dependencies, payload, runs, runner } = releaseFixture({
        preActivation: null,
        verification: verify("keep"),
      });

      const result = await deployAppImageWithDependencies(
        dependencies,
        docker as never,
        runtimeConfig,
        payload,
        runner({ verification: failed("verification") })
      );

      expect(result.rollout.outcome).toBe("committed");
      expect(await runs[0]?.resolveAppliedPolicy?.("failed")).toBe("keep");
      expect(dependencies.writeLocalTraefikRoute).toHaveBeenCalledTimes(1);
      expect(docker.stopContainer).toHaveBeenCalledWith(liveName, 10, 15_000);
    });

    test("a verification settled by an earlier run is not rolled back again", async () => {
      const { docker, dependencies, payload } = releaseFixture({
        preActivation: null,
        verification: verify("rollback"),
      });
      const phases = { run: mock(async () => failed("verification")) };

      const result = await deployAppImageWithDependencies(
        dependencies,
        docker as never,
        runtimeConfig,
        payload,
        phases
      );

      // No policy reported by this run: the result was decided, and acted on, back then.
      expect(result.rollout.outcome).toBe("committed");
      expect(dependencies.writeLocalTraefikRoute).toHaveBeenCalledTimes(1);
    });

    test("a verification that cannot run keeps the new deployment even under rollback", async () => {
      const { docker, dependencies, payload } = releaseFixture({
        preActivation: null,
        verification: verify("rollback"),
      });
      const phases = {
        run: mock(async (): Promise<ReleasePhaseResult> => {
          throw new Error("control plane unreachable");
        }),
      };

      const result = await deployAppImageWithDependencies(
        dependencies,
        docker as never,
        runtimeConfig,
        payload,
        phases
      );

      expect(result.rollout.outcome).toBe("committed");
      expect(dependencies.writeLocalTraefikRoute).toHaveBeenCalledTimes(1);
    });

    test("a previous deployment that cannot serve keeps the new one under rollback", async () => {
      const { docker, dependencies, payload, runs, runner } = releaseFixture({
        preActivation: null,
        verification: verify("rollback"),
      });
      const inspectServing = docker.inspectContainer.getMockImplementation()!;
      // The live release is crash-looping, which is often why a fix is being deployed.
      docker.inspectContainer.mockImplementation(async (name: string) =>
        name === liveName
          ? ({
              Id: "ctr_live",
              Name: liveName,
              RestartCount: 4,
              State: { Running: false, Status: "exited", ExitCode: 1, OOMKilled: false },
            } as never)
          : inspectServing(name)
      );

      const result = await deployAppImageWithDependencies(
        dependencies,
        docker as never,
        runtimeConfig,
        payload,
        runner({ verification: failed("verification") })
      );

      expect(result.rollout.outcome).toBe("committed");
      expect(await runs[0]?.resolveAppliedPolicy?.("failed")).toBe("keep");
      expect(dependencies.writeLocalTraefikRoute.mock.calls.map((call) => call[3])).toEqual([
        `http://${candidateName}:8080`,
      ]);
      expect(docker.removeContainer).not.toHaveBeenCalledWith(candidateName, true);
    });

    test("without a previous deployment there is nothing to roll back to", async () => {
      const { docker, dependencies, payload, runs, runner } = releaseFixture({
        preActivation: null,
        verification: verify("rollback"),
      });

      const result = await deployAppImageWithDependencies(
        dependencies,
        docker as never,
        runtimeConfig,
        { ...payload, runtimeMetadata: null },
        runner({ verification: failed("verification") })
      );

      expect(result.rollout.outcome).toBe("committed");
      expect(await runs[0]?.resolveAppliedPolicy?.("failed")).toBe("keep");
    });

    test("an agent without a runner ignores release jobs", async () => {
      const { docker, dependencies, payload } = releaseFixture({
        preActivation: { command: "exit 1", timeoutSeconds: 60 },
        verification: null,
      });

      const result = await deployAppImageWithDependencies(
        dependencies,
        docker as never,
        runtimeConfig,
        payload
      );

      expect(result.rollout.outcome).toBe("committed");
    });
  });

  test("waits for Docker health instead of accepting TCP while health is starting", async () => {
    const docker = createDockerMock();
    let inspectionCount = 0;
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) => {
      if (name !== "nouva-app-svc_1-dep_1") {
        return null;
      }

      inspectionCount += 1;
      return {
        Id: "ctr_candidate",
        Name: name,
        State: {
          Running: true,
          Status: "running",
          Health: { Status: inspectionCount === 1 ? "starting" : "healthy" },
        },
        NetworkSettings: {
          Networks: { "nouva-local": { IPAddress: "172.19.0.10" } },
        },
      };
    });

    const checkTcpConnect = mock(async () => true);
    const drainSleep = mock(async () => undefined);
    const result = await deployAppImageWithDependencies(
      {
        ensureBaseRuntime: async () => undefined,
        checkTcpConnect,
        fetchImpl: mock(async () =>
          Response.json([
            {
              name: "svc-svc_1@file",
              loadBalancer: {
                servers: [{ url: "http://nouva-app-svc_1-dep_1:8080" }],
              },
            },
          ])
        ) as typeof fetch,
        writeLocalTraefikRoute: mock(async () => {}),
        deleteLocalTraefikRoute: mock(async () => {}),
        sleep: drainSleep,
      },
      docker as never,
      runtimeConfig,
      {
        ...appRuntimePayload,
        volume: null,
        rollout: createRolloutConfig(),
        runtimeMetadata: null,
      }
    );

    expect(inspectionCount).toBe(2);
    expect(checkTcpConnect).not.toHaveBeenCalled();
    expect(drainSleep).not.toHaveBeenCalled();
    expect(docker.stopContainer).not.toHaveBeenCalled();
    expect(result.rollout).toEqual(
      expect.objectContaining({
        drainDurationMs: 0,
        previousContainerRetirement: null,
      })
    );
  });

  test("fails immediately when Docker reports an unhealthy candidate", async () => {
    const docker = createDockerMock();
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) =>
      name === "nouva-app-svc_1-dep_1"
        ? {
            Id: "ctr_candidate",
            Name: name,
            State: {
              Running: true,
              Status: "running",
              Health: { Status: "unhealthy" },
            },
          }
        : null
    );
    const checkTcpConnect = mock(async () => true);

    await expect(
      deployAppImageWithDependencies(
        {
          ensureBaseRuntime: async () => undefined,
          checkTcpConnect,
          fetchImpl: mock(async () => Response.json([])) as typeof fetch,
          writeLocalTraefikRoute: mock(async () => {}),
          deleteLocalTraefikRoute: mock(async () => {}),
        },
        docker as never,
        runtimeConfig,
        {
          ...appRuntimePayload,
          volume: null,
          rollout: createRolloutConfig(),
          runtimeMetadata: null,
        }
      )
    ).rejects.toHaveProperty(
      "message",
      "Candidate container nouva-app-svc_1-dep_1 became unhealthy"
    );

    expect(checkTcpConnect).not.toHaveBeenCalled();
    expect(docker.removeContainer).toHaveBeenCalledWith("nouva-app-svc_1-dep_1", true);
  });

  test("reports the last Docker health status when readiness times out", async () => {
    const docker = createDockerMock();
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) =>
      name === "nouva-app-svc_1-dep_1"
        ? {
            Id: "ctr_candidate",
            Name: name,
            State: {
              Running: true,
              Status: "running",
              Health: { Status: "starting" },
            },
          }
        : null
    );
    const checkTcpConnect = mock(async () => true);

    await expect(
      deployAppImageWithDependencies(
        {
          ensureBaseRuntime: async () => undefined,
          checkTcpConnect,
          fetchImpl: mock(async () => Response.json([])) as typeof fetch,
          writeLocalTraefikRoute: mock(async () => {}),
          deleteLocalTraefikRoute: mock(async () => {}),
        },
        docker as never,
        runtimeConfig,
        {
          ...appRuntimePayload,
          volume: null,
          rollout: createRolloutConfig({
            readiness: {
              timeoutMs: 0,
              intervalMs: 1,
              tcpConnectTimeoutMs: 1,
            },
          }),
          runtimeMetadata: null,
        }
      )
    ).rejects.toHaveProperty(
      "message",
      "Candidate container nouva-app-svc_1-dep_1 health status is starting"
    );

    expect(checkTcpConnect).not.toHaveBeenCalled();
  });

  test("reports the memory kill instead of waiting out the TCP probe", async () => {
    const docker = createDockerMock();
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) =>
      name === "nouva-app-svc_1-dep_1"
        ? {
            Id: "ctr_candidate",
            Name: name,
            RestartCount: 4,
            State: { Running: true, Status: "running", OOMKilled: true },
            HostConfig: { Memory: 134_217_728, MemorySwap: 134_217_728 },
            NetworkSettings: { Networks: { "nouva-local": { IPAddress: "172.19.0.10" } } },
          }
        : null
    );
    const checkTcpConnect = mock(async () => false);

    try {
      await expect(
        deployAppImageWithDependencies(
          {
            ensureBaseRuntime: async () => undefined,
            checkTcpConnect,
            fetchImpl: mock(async () => Response.json([])) as typeof fetch,
            writeLocalTraefikRoute: mock(async () => {}),
            deleteLocalTraefikRoute: mock(async () => {}),
          },
          docker as never,
          runtimeConfig,
          {
            ...appRuntimePayload,
            volume: null,
            rollout: createRolloutConfig(),
            runtimeMetadata: null,
          }
        )
      ).rejects.toHaveProperty(
        "message",
        "Candidate container nouva-app-svc_1-dep_1 ran out of memory and was killed (memory limit 128 MiB, swap disabled, 4 restarts); raise the service memory limit and redeploy"
      );

      expect(checkTcpConnect).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "[nouva-agent] app candidate readiness failed",
        expect.objectContaining({ cause: "out_of_memory", restarts: 4 })
      );
      expect(docker.removeContainer).toHaveBeenCalledWith("nouva-app-svc_1-dep_1", true);
    } finally {
      warn.mockRestore();
    }
  });

  test("reports the exit code when the candidate keeps restarting", async () => {
    const docker = createDockerMock();
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    let restartCount = 0;
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) => {
      if (name !== "nouva-app-svc_1-dep_1") {
        return null;
      }

      restartCount += 1;
      return {
        Id: "ctr_candidate",
        Name: name,
        RestartCount: restartCount,
        State: { Running: false, Status: "restarting", ExitCode: 1 },
      };
    });
    const checkTcpConnect = mock(async () => false);

    try {
      await expect(
        deployAppImageWithDependencies(
          {
            ensureBaseRuntime: async () => undefined,
            checkTcpConnect,
            fetchImpl: mock(async () => Response.json([])) as typeof fetch,
            writeLocalTraefikRoute: mock(async () => {}),
            deleteLocalTraefikRoute: mock(async () => {}),
          },
          docker as never,
          runtimeConfig,
          {
            ...appRuntimePayload,
            volume: null,
            rollout: createRolloutConfig(),
            runtimeMetadata: null,
          }
        )
      ).rejects.toHaveProperty(
        "message",
        "Candidate container nouva-app-svc_1-dep_1 keeps restarting (2 restarts, last exit code 1); the process is exiting instead of serving traffic"
      );

      expect(restartCount).toBe(2);
      expect(checkTcpConnect).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "[nouva-agent] app candidate readiness failed",
        expect.objectContaining({ cause: "restart_loop" })
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("keeps waiting for a starting candidate that has not crashed", async () => {
    const docker = createDockerMock();
    let inspectionCount = 0;
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) => {
      if (name !== "nouva-app-svc_1-dep_1") {
        return null;
      }

      inspectionCount += 1;
      return {
        Id: "ctr_candidate",
        Name: name,
        RestartCount: 0,
        State: {
          Running: true,
          Status: "running",
          Health: { Status: inspectionCount < 3 ? "starting" : "healthy" },
        },
        HostConfig: { Memory: 134_217_728, MemorySwap: 134_217_728 },
      };
    });

    const result = await deployAppImageWithDependencies(
      {
        ensureBaseRuntime: async () => undefined,
        checkTcpConnect: mock(async () => false),
        fetchImpl: mock(async () =>
          Response.json([
            {
              name: "svc-svc_1@file",
              loadBalancer: {
                servers: [{ url: "http://nouva-app-svc_1-dep_1:8080" }],
              },
            },
          ])
        ) as typeof fetch,
        writeLocalTraefikRoute: mock(async () => {}),
        deleteLocalTraefikRoute: mock(async () => {}),
      },
      docker as never,
      runtimeConfig,
      {
        ...appRuntimePayload,
        volume: null,
        rollout: createRolloutConfig(),
        runtimeMetadata: null,
      }
    );

    expect(inspectionCount).toBe(3);
    expect(result.rollout).toEqual(expect.objectContaining({ outcome: "committed" }));
  });

  test("uses a bounded forced removal only when graceful retirement fails", async () => {
    const docker = createDockerMock();
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) =>
      name === "nouva-app-svc_1-dep_1"
        ? {
            Id: "ctr_candidate",
            Name: name,
            State: { Running: true },
            NetworkSettings: {
              Networks: { "nouva-local": { IPAddress: "172.19.0.10" } },
            },
          }
        : null
    );
    docker.stopContainer.mockRejectedValueOnce(new Error("stop failed"));

    try {
      const result = await deployAppImageWithDependencies(
        {
          ensureBaseRuntime: async () => undefined,
          checkTcpConnect: mock(async () => true),
          fetchImpl: mock(async () =>
            Response.json([
              {
                name: "svc-svc_1@file",
                loadBalancer: {
                  servers: [{ url: "http://nouva-app-svc_1-dep_1:8080" }],
                },
              },
            ])
          ) as typeof fetch,
          writeLocalTraefikRoute: mock(async () => {}),
          deleteLocalTraefikRoute: mock(async () => {}),
          sleep: mock(async () => undefined),
        },
        docker as never,
        runtimeConfig,
        {
          ...appRuntimePayload,
          volume: null,
          rollout: createRolloutConfig(),
          runtimeMetadata: {
            containerName: "nouva-app-svc_1-live",
            internalPort: 8080,
          },
        }
      );

      expect(docker.stopContainer).toHaveBeenCalledWith("nouva-app-svc_1-live", 10, 15_000);
      expect(docker.removeContainer.mock.calls).toEqual([["nouva-app-svc_1-live", true, 15_000]]);
      expect(warn).toHaveBeenCalledWith(
        "[nouva-agent] app rollout retirement fallback",
        expect.objectContaining({
          containerName: "nouva-app-svc_1-live",
          deploymentId: "dep_1",
          serviceId: "svc_1",
        })
      );
      expect(result.rollout).toEqual(
        expect.objectContaining({ previousContainerRetirement: "forced" })
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("removes the candidate and preserves the live runtime when readiness fails", async () => {
    const docker = createDockerMock();
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) => {
      if (name === "nouva-app-svc_1-dep_1") {
        return {
          Id: "ctr_candidate",
          Name: name,
          State: {
            Running: false,
            Status: "exited",
          },
        };
      }

      return null;
    });

    const writeLocalTraefikRoute = mock(async () => {});

    await expect(
      deployAppImageWithDependencies(
        {
          ensureBaseRuntime: async () => undefined,
          checkTcpConnect: mock(async () => false),
          fetchImpl: mock(async () => Response.json([])) as typeof fetch,
          writeLocalTraefikRoute,
          deleteLocalTraefikRoute: mock(async () => {}),
        },
        docker as never,
        runtimeConfig,
        {
          ...appRuntimePayload,
          volume: null,
          rollout: createRolloutConfig(),
          runtimeMetadata: {
            containerName: "nouva-app-svc_1-live",
            internalPort: 8080,
          },
        }
      )
    ).rejects.toMatchObject({
      message: "Candidate container nouva-app-svc_1-dep_1 is not running (exited)",
      result: {
        rollout: expect.objectContaining({
          outcome: "aborted_before_cutover",
          liveRuntimePreserved: true,
        }),
      },
    });

    expect(writeLocalTraefikRoute).not.toHaveBeenCalled();
    expect(docker.removeContainer.mock.calls).toEqual([["nouva-app-svc_1-dep_1", true]]);
    expect(docker.removeImage).toHaveBeenCalledWith("127.0.0.1:5000/nouva-app:dep_1", true);
  });

  test("restores the previous route and keeps the live runtime when cutover verification fails", async () => {
    const docker = createDockerMock();
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) => {
      if (name === "nouva-app-svc_1-dep_1") {
        return {
          Id: "ctr_candidate",
          Name: name,
          State: {
            Running: true,
          },
          NetworkSettings: {
            Networks: {
              "nouva-local": {
                IPAddress: "172.19.0.10",
              },
            },
          },
        };
      }

      return null;
    });

    let serviceUrl = "http://nouva-app-svc_1-live:8080";
    const writeLocalTraefikRoute = mock(
      async (_paths: unknown, _serviceId: string, _hostnames: string[], nextUrl: string) => {
        serviceUrl = nextUrl;
      }
    );
    const fetchImpl: typeof fetch = mock(async () =>
      Response.json([
        {
          name: "svc-svc_1@file",
          loadBalancer: {
            servers: [
              {
                url:
                  serviceUrl === "http://nouva-app-svc_1-dep_1:8080"
                    ? "http://wrong-target:8080"
                    : serviceUrl,
              },
            ],
          },
        },
      ])
    ) as typeof fetch;

    await expect(
      deployAppImageWithDependencies(
        {
          ensureBaseRuntime: async () => undefined,
          checkTcpConnect: mock(async () => true),
          fetchImpl,
          writeLocalTraefikRoute,
          deleteLocalTraefikRoute: mock(async () => {}),
        },
        docker as never,
        runtimeConfig,
        {
          ...appRuntimePayload,
          volume: null,
          rollout: createRolloutConfig(),
          runtimeMetadata: {
            containerName: "nouva-app-svc_1-live",
            internalPort: 8080,
          },
        }
      )
    ).rejects.toMatchObject({
      result: {
        rollout: expect.objectContaining({
          outcome: "rolled_back",
          rollbackCompleted: true,
          liveRuntimePreserved: true,
        }),
      },
    });

    expect(writeLocalTraefikRoute.mock.calls).toEqual([
      [
        expect.anything(),
        "svc_1",
        {
          providedHostname: "app.up.nouva.cloud",
          customHostnames: [],
        },
        "http://nouva-app-svc_1-dep_1:8080",
      ],
      [
        expect.anything(),
        "svc_1",
        {
          providedHostname: "app.up.nouva.cloud",
          customHostnames: [],
        },
        "http://nouva-app-svc_1-live:8080",
      ],
    ]);
    expect(docker.removeContainer.mock.calls).toEqual([["nouva-app-svc_1-dep_1", true]]);
    expect(docker.stopContainer).not.toHaveBeenCalled();
  });

  test("stops and snapshots a volume app before launching its candidate", async () => {
    const docker = createDockerMock();
    docker.listContainersUsingVolume
      .mockImplementationOnce(async () => [
        {
          Id: "ctr_live",
          Name: "/nouva-app-svc_1-live",
          State: { Running: true },
        },
      ])
      .mockImplementation(async () => []);
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) => {
      if (name === "nouva-app-svc_1-dep_1") {
        return {
          Id: "ctr_candidate",
          Name: name,
          State: { Running: true },
          NetworkSettings: {
            Networks: { "nouva-local": { IPAddress: "172.19.0.10" } },
          },
        };
      }
      return null;
    });

    let serviceUrl = "http://nouva-app-svc_1-live:8080";
    const result = await deployAppImageWithDependencies(
      {
        ensureBaseRuntime: async () => undefined,
        checkTcpConnect: mock(async () => true),
        fetchImpl: mock(async () =>
          Response.json([
            {
              name: "svc-svc_1@file",
              loadBalancer: { servers: [{ url: serviceUrl }] },
            },
          ])
        ) as typeof fetch,
        writeLocalTraefikRoute: mock(
          async (_paths: unknown, _serviceId: string, _hostnames: unknown, nextUrl: string) => {
            serviceUrl = nextUrl;
          }
        ),
        deleteLocalTraefikRoute: mock(async () => {}),
      },
      docker as never,
      runtimeConfig,
      {
        ...appRuntimePayload,
        rollout: createRolloutConfig(),
        runtimeMetadata: {
          containerName: "nouva-app-svc_1-live",
          internalPort: 8080,
        },
      }
    );

    expect(docker.stopContainer).toHaveBeenCalledWith("nouva-app-svc_1-live");
    expect(docker.stopContainer.mock.invocationCallOrder[0]).toBeLessThan(
      docker.ensureContainer.mock.invocationCallOrder[0]!
    );
    expect(result.rollout).toEqual(
      expect.objectContaining({
        strategy: "single_writer_snapshot_cutover",
        outcome: "committed",
      })
    );
  });

  test("restarts the previous app without launching a candidate when volume snapshot fails", async () => {
    const docker = createDockerMock();
    docker.listContainersUsingVolume.mockImplementationOnce(async () => [
      {
        Id: "ctr_live",
        Name: "/nouva-app-svc_1-live",
        State: { Running: true },
      },
    ]);
    docker.waitContainer.mockImplementationOnce(async () => 1);
    docker.containerLogs.mockImplementationOnce(async () => "Insufficient snapshot capacity");
    docker.inspectContainer.mockImplementation(async (name: string) =>
      name === "nouva-app-svc_1-live"
        ? {
            Id: "ctr_live",
            Name: name,
            State: { Running: true },
            NetworkSettings: {
              Networks: { "nouva-local": { IPAddress: "172.19.0.9" } },
            },
          }
        : null
    );

    await expect(
      deployAppImageWithDependencies(
        {
          ensureBaseRuntime: async () => undefined,
          checkTcpConnect: mock(async () => true),
          fetchImpl: mock(async () =>
            Response.json([
              {
                name: "svc-svc_1@file",
                loadBalancer: {
                  servers: [{ url: "http://nouva-app-svc_1-live:8080" }],
                },
              },
            ])
          ) as typeof fetch,
          writeLocalTraefikRoute: mock(async () => {}),
          deleteLocalTraefikRoute: mock(async () => {}),
        },
        docker as never,
        runtimeConfig,
        {
          ...appRuntimePayload,
          rollout: createRolloutConfig(),
          runtimeMetadata: {
            containerName: "nouva-app-svc_1-live",
            internalPort: 8080,
          },
        }
      )
    ).rejects.toMatchObject({
      message: "Insufficient snapshot capacity",
      result: {
        rollout: expect.objectContaining({
          outcome: "aborted_before_cutover",
          liveRuntimePreserved: true,
          strategy: "single_writer_snapshot_cutover",
        }),
      },
    });

    expect(docker.ensureContainer).not.toHaveBeenCalled();
    expect(docker.stopContainer).toHaveBeenCalledWith("nouva-app-svc_1-live");
    expect(docker.startContainer).toHaveBeenCalledWith("nouva-app-svc_1-live");
  });
});

describe("buildDatabaseContainerSpec", () => {
  test("includes Docker resource limits for provisioned database containers", () => {
    const spec = buildDatabaseContainerSpec(databasePayload);

    expect(spec.resolved).toEqual(
      expect.objectContaining({
        mountPath: "/var/lib/postgresql",
        dataPath: "/var/lib/postgresql/pgdata",
      })
    );
    expect(spec.spec.hostConfig).toEqual(
      expect.objectContaining({
        Mounts: [
          expect.objectContaining({
            Source: "nouva-vol-vol_1",
            Target: "/var/lib/postgresql",
          }),
        ],
        NanoCpus: 1_500_000_000,
        Memory: 2 * 1024 * 1024 * 1024,
      })
    );
  });

  test("applies protected database defaults when legacy resource limits are null", () => {
    const spec = buildDatabaseContainerSpec({
      ...databasePayload,
      resourceLimits: null,
    });

    expect(spec.spec.hostConfig).toEqual(
      expect.objectContaining({
        NanoCpus: 500_000_000,
        Memory: 1024 * 1024 * 1024,
        MemorySwap: 1024 * 1024 * 1024,
        PidsLimit: 512,
      })
    );
  });

  test("carries a bounded swap allowance into the database container", () => {
    const spec = buildDatabaseContainerSpec({
      ...databasePayload,
      resourceLimits: {
        cpuMillicores: 500,
        memoryBytes: 1024 * 1024 * 1024,
        memoryAndSwapBytes: 2 * 1024 * 1024 * 1024,
      },
    });

    expect(spec.spec.hostConfig).toEqual(
      expect.objectContaining({
        NanoCpus: 500_000_000,
        Memory: 1024 * 1024 * 1024,
        MemorySwap: 2 * 1024 * 1024 * 1024,
        PidsLimit: 512,
      })
    );
  });

  test("stamps environment labels for database containers", () => {
    const spec = buildDatabaseContainerSpec(databasePayload);

    expect(spec.spec.labels).toEqual(
      expect.objectContaining({
        "nouva.environment.id": "env_1",
        "nouva.project.id": "proj_1",
        "nouva.service.id": "svc_1",
        "nouva.service.variant": "postgres",
        "nouva.kind": "database",
        "nouva.redaction.context.version": "hmac-sha256:redaction-context:v1:database",
      })
    );
  });
});

describe("database runtime recreate paths", () => {
  async function withOccupiedHostPort(callback: (port: number) => Promise<void>): Promise<void> {
    const listener = net.createServer();
    await new Promise<void>((resolve) =>
      listener.listen({ host: "0.0.0.0", port: 0 }, () => resolve())
    );
    const address = listener.address();
    if (!address || typeof address === "string") {
      listener.close();
      throw new Error("Failed to allocate test listener");
    }

    try {
      await callback(address.port);
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }

  test("rejects an occupied public port before Docker mutations", async () => {
    const docker = createDockerMock();

    await withOccupiedHostPort(async (port) => {
      await expect(
        handleDatabaseProvision(docker as never, runtimeConfig, {
          ...databasePayload,
          publicAccessEnabled: true,
          externalHost: "203.0.113.20",
          externalPort: port,
        })
      ).rejects.toThrow(`Public database port ${port} is already occupied`);
    });

    expect(docker.ensureNetwork).not.toHaveBeenCalled();
    expect(docker.createVolume).not.toHaveBeenCalled();
    expect(docker.ensureContainer).not.toHaveBeenCalled();
  });

  test("checks an occupied public port before removing a database for volume apply", async () => {
    const docker = createDockerMock();

    await withOccupiedHostPort(async (port) => {
      await expect(
        handleApplyDatabaseVolume(docker as never, runtimeConfig, {
          ...databasePayload,
          publicAccessEnabled: true,
          externalHost: "203.0.113.20",
          externalPort: port,
          runtimeMetadata: {
            containerName: "nouva-postgres-prev",
          },
        })
      ).rejects.toThrow(`Public database port ${port} is already occupied`);
    });

    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(docker.removeVolume).not.toHaveBeenCalled();
  });

  test("checks an occupied public port before removing an attached database volume", async () => {
    const docker = createDockerMock();

    await withOccupiedHostPort(async (port) => {
      await expect(
        handleWipeVolume(docker as never, runtimeConfig, {
          ...databasePayload,
          publicAccessEnabled: true,
          externalHost: "203.0.113.20",
          externalPort: port,
          runtimeMetadata: {
            containerName: "nouva-postgres-prev",
          },
        })
      ).rejects.toThrow(`Public database port ${port} is already occupied`);
    });

    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(docker.removeVolume).not.toHaveBeenCalled();
  });

  test("allows a running Nouva container for the same service to retain its binding", async () => {
    const docker = createDockerMock();
    docker.inspectContainer.mockResolvedValue({
      Id: "ctr_existing",
      Name: "nouva-postgres-svc_1",
      State: { Running: true },
      Config: {
        Labels: {
          "nouva.managed": "true",
          "nouva.service.id": "svc_1",
        },
      },
      HostConfig: {
        PortBindings: {
          "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "61234" }],
        },
      },
    });

    await expect(
      preflightDatabasePublicPort(docker as never, {
        ...databasePayload,
        publicAccessEnabled: true,
        externalHost: "203.0.113.20",
        externalPort: 61234,
      })
    ).resolves.toBeUndefined();
  });

  test("requires a valid port only when public access is enabled", async () => {
    const docker = createDockerMock();

    await expect(
      preflightDatabasePublicPort(docker as never, databasePayload)
    ).resolves.toBeUndefined();
    await expect(
      preflightDatabasePublicPort(docker as never, {
        ...databasePayload,
        publicAccessEnabled: true,
        externalPort: null,
      })
    ).rejects.toThrow("valid external port between 1 and 65535");
    expect(docker.inspectContainer).not.toHaveBeenCalled();
  });

  test("applies Docker resource limits during database provision", async () => {
    const docker = createDockerMock();

    const result = await handleDatabaseProvision(docker as never, runtimeConfig, databasePayload);

    expect(docker.ensureContainer.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        hostConfig: expect.objectContaining({
          Mounts: [
            expect.objectContaining({
              Source: "nouva-vol-vol_1",
              Target: "/var/lib/postgresql",
            }),
          ],
          NanoCpus: 1_500_000_000,
          Memory: 2 * 1024 * 1024 * 1024,
        }),
      })
    );
    expect(result.runtimeMetadata).toEqual(
      expect.objectContaining({
        mountPath: "/var/lib/postgresql",
        dataPath: "/var/lib/postgresql/pgdata",
      })
    );
  });

  test("reports a running database only after an authenticated probe answers", async () => {
    const docker = createDockerMock();

    const result = await handleDatabaseProvision(docker as never, runtimeConfig, databasePayload);

    const probeSpec = docker.createContainer.mock.calls
      .map((call) => call[0] as DockerContainerSpec)
      .find((spec) => spec.name?.startsWith("nouva-db-ready-"));
    expect(probeSpec).toBeDefined();
    expect(probeSpec?.image).toBe("postgres:17");
    // The probe must reach the service-facing address on the managed project network, not the
    // temporary loopback server the entrypoint runs while initializing the data directory.
    expect(probeSpec?.hostConfig?.NetworkMode).toBe(
      `nouva-project-${hashProjectNetwork("proj_1")}`
    );
    expect(probeSpec?.env).toContain("PGHOST=nouva-postgres-svc_1");
    expect(probeSpec?.cmd?.join(" ")).toContain("SELECT 1");
    // Managed database images ignore the command and run their own startup instead, so the probe
    // container must replace the entrypoint with the shell that runs the statement.
    expect(probeSpec?.entrypoint).toEqual(["/bin/sh"]);
    expect(probeSpec?.cmd?.[0]).toBe("-c");
    expect(result.runtimeInstance.status).toBe("running");
  });

  test("authenticates with the runtime definition when the payload carries no credentials", async () => {
    const docker = createDockerMock();
    const { credentials: _credentials, ...payloadWithoutCredentials } = databasePayload;

    await handleDatabaseProvision(
      docker as never,
      runtimeConfig,
      payloadWithoutCredentials as typeof databasePayload
    );

    const probeSpec = docker.createContainer.mock.calls
      .map((call) => call[0] as DockerContainerSpec)
      .find((spec) => spec.name?.startsWith("nouva-db-ready-"));
    expect(probeSpec?.env).toContain("PGUSER=nouva_user");
    expect(probeSpec?.env).toContain("PGPASSWORD=super-secret");
  });

  test("fails provisioning instead of reporting a restarting database as running", async () => {
    const docker = createDockerMock();
    docker.inspectContainer.mockResolvedValue({
      Id: "ctr_1",
      Name: "/nouva-postgres-svc_1",
      RestartCount: 8,
      State: { Running: true, Status: "restarting", ExitCode: 1, OOMKilled: false },
    });

    await expect(
      handleDatabaseProvision(docker as never, runtimeConfig, databasePayload)
    ).rejects.toThrow("Database container nouva-postgres-svc_1 keeps restarting");
  });

  test("reports the known MongoDB host kernel incompatibility without echoing logs", async () => {
    const docker = createDockerMock();
    docker.inspectContainer.mockResolvedValue({
      Id: "ctr_1",
      Name: "/nouva-mongodb-svc_1",
      RestartCount: 8,
      State: { Running: true, Status: "restarting", ExitCode: 1, OOMKilled: false },
    });
    docker.containerLogs.mockResolvedValue(
      [
        '{"t":{"$date":"2026-09-15T21:48:26.446Z"},"s":"F","id":12257600,"ctx":"main","msg":"MongoDB cannot start: Linux kernel versions 6.19 and newer has a known incompatibility with this version of MongoDB. See https://jira.mongodb.org/browse/SERVER-121912 for more information."}',
        '{"s":"F","msg":"env MONGO_INITDB_ROOT_PASSWORD=super-secret"}',
      ].join("\n")
    );

    const error = await handleDatabaseProvision(docker as never, runtimeConfig, {
      ...databasePayload,
      variant: "mongodb",
      imageUrl: "mongo:8.0",
      internalPort: 27017,
      mountPath: "/data/db",
      dataPath: "/data/db",
      envVars: {
        MONGO_INITDB_ROOT_USERNAME: "nouva_user",
        MONGO_INITDB_ROOT_PASSWORD: "super-secret",
      },
    }).catch((caught: unknown) => caught as Error);

    expect(error.message).toContain("SERVER-121912");
    expect(error.message).not.toContain("super-secret");
    expect(error.message).not.toContain('{"t":');
  });

  test("applies Docker resource limits when reapplying a database volume", async () => {
    const docker = createDockerMock();

    await handleApplyDatabaseVolume(docker as never, runtimeConfig, {
      ...databasePayload,
      resourceLimits: {
        memoryBytes: 1024 * 1024 * 1024,
      },
      runtimeMetadata: {
        containerName: "nouva-postgres-prev",
      },
    });

    expect(docker.removeContainer).toHaveBeenCalledWith("nouva-postgres-prev", true);
    expect(docker.ensureContainer.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        hostConfig: expect.objectContaining({
          Memory: 1024 * 1024 * 1024,
        }),
      })
    );
    expect(docker.ensureContainer.mock.calls[0]?.[0]?.hostConfig).toEqual(
      expect.objectContaining({
        NanoCpus: 500_000_000,
        PidsLimit: 512,
      })
    );
  });

  test("attaches registry auth only for images hosted on the configured private registry", async () => {
    const docker = createDockerMock();

    await handleDatabaseProvision(
      docker as never,
      {
        ...runtimeConfig,
        privateRegistry: {
          host: "registry.nouva.sh",
          username: "srv_srv_1",
          password: "registry-password",
        },
      },
      {
        ...databasePayload,
        imageUrl: "registry.nouva.sh/nouva/postgres:17",
      }
    );

    expect(docker.ensureContainer.mock.calls[0]?.[2]).toEqual({
      auth: {
        host: "registry.nouva.sh",
        username: "srv_srv_1",
        password: "registry-password",
      },
    });

    docker.ensureContainer.mockClear();

    await handleDatabaseProvision(
      docker as never,
      {
        ...runtimeConfig,
        privateRegistry: {
          host: "registry.nouva.sh",
          username: "srv_srv_1",
          password: "registry-password",
        },
      },
      {
        ...databasePayload,
        imageUrl: "postgres:17",
      }
    );

    expect(docker.ensureContainer.mock.calls[0]?.[2]).toEqual({
      auth: undefined,
    });
  });

  test("restores PITR into the staged volume without touching the live container", async () => {
    const docker = createDockerMock();

    const result = await handleRestorePostgresPitr(docker as never, runtimeConfig, {
      ...databasePayload,
      sourceVolumeId: "vol_source",
      sourceVolumeName: "nouva-vol-vol_source",
      sourceMountPath: "/var/lib/postgresql",
      destination: {} as never,
      restoreTarget: "2026-03-25T00:00:00Z",
      runtimeMetadata: {
        containerName: "nouva-postgres-prev",
      },
    });

    expect(result).toEqual({
      statusMessage: "PITR restore ready to apply",
    });
    expect(docker.stopContainer).not.toHaveBeenCalled();
    expect(docker.ensureContainer).not.toHaveBeenCalled();
    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    expect(docker.createContainer.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        image: "postgres:17",
        entrypoint: ["sh", "-c"],
        cmd: [expect.any(String)],
        hostConfig: expect.objectContaining({
          Mounts: [
            expect.objectContaining({
              Source: "nouva-vol-vol_1",
              Target: "/var/lib/postgresql",
            }),
          ],
        }),
        env: expect.arrayContaining(["NOUVA_DATA_PATH=/var/lib/postgresql/pgdata"]),
      })
    );
    const pitrScript = docker.createContainer.mock.calls[0]?.[0]?.cmd?.[0];
    expect(pitrScript).toContain('pgbackrest --stanza="$PGBACKREST_STANZA"');
    expect(pitrScript).toContain("--type=time");
    expect(pitrScript).toContain("--target-timeline=current");
    expect(pitrScript).toContain("/nouva/entrypoint.sh &");
    expect(pitrScript).toContain("pg_is_in_recovery()");
    expect(docker.createContainer.mock.calls[0]?.[0]?.env).toEqual(
      expect.arrayContaining(["RESTORE_TYPE=time", "NOUVA_STAGED_RESTORE=1"])
    );
    expect(
      docker.removeContainer.mock.calls.some((call) => call[0] === "nouva-postgres-prev")
    ).toBe(false);
  });

  test("initializes a missing pgBackRest stanza before the first backup", async () => {
    const docker = createDockerMock();
    docker.containerLogs.mockResolvedValueOnce(
      'NOUVA_PGBACKREST_INFO:[{"backup":[{"label":"20260325-000000F","type":"full","timestamp":{"stop":1774396800},"annotation":{"nouva-backup-id":"backup_1"}}]}]'
    );

    await handleCreateVolumeBackup(docker as never, runtimeConfig, pgBackrestBackupPayload);

    expect(docker.createContainer).toHaveBeenCalledTimes(2);
    expect(docker.createContainer.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        image: "postgres:17",
        entrypoint: ["sh", "-c"],
        cmd: [
          expect.stringContaining(
            'pgbackrest --stanza="$PGBACKREST_STANZA" --log-level-console=info stanza-create'
          ),
        ],
        hostConfig: expect.objectContaining({
          Mounts: [
            expect.objectContaining({
              Source: "nouva-vol-vol_1",
              Target: "/var/lib/postgresql",
            }),
          ],
        }),
        env: expect.arrayContaining(["NOUVA_DATA_PATH=/var/lib/postgresql/pgdata"]),
      })
    );
  });

  test("selects the newest pgBackRest backup when annotations are unavailable", async () => {
    const docker = createDockerMock();
    docker.containerLogs.mockResolvedValue(
      `NOUVA_PGBACKREST_INFO:${JSON.stringify([
        {
          backup: [
            {
              label: "20260324-000000F",
              type: "full",
              timestamp: { stop: 1_774_310_400 },
            },
            {
              label: "20260325-000000F",
              type: "full",
              timestamp: { stop: 1_774_396_800 },
            },
          ],
        },
      ])}`
    );

    const result = await handleCreateVolumeBackup(
      docker as never,
      runtimeConfig,
      pgBackrestBackupPayload
    );

    expect(result.pgbackrestSet).toBe("20260325-000000F");
    expect(result.activePgbackrestSets).toEqual(["20260325-000000F", "20260324-000000F"]);
  });

  test("dumps MySQL through a service-image sidecar and verifies the uploaded archive", async () => {
    const docker = createDockerMock();
    docker.containerLogs.mockResolvedValue(
      "NOUVA_SIZE_BYTES:128\nNOUVA_SHA256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    );

    const result = await handleCreateVolumeBackup(
      docker as never,
      runtimeConfig,
      mysqlBackupPayload
    );

    expect(docker.createVolume).toHaveBeenCalledWith(
      "nouva-backup-stage-backup_mysql",
      expect.objectContaining({ "nouva.resource": "backup-stage" })
    );
    const dumpTask = docker.createContainer.mock.calls[0]?.[0];
    const dumpScript = dumpTask?.cmd?.[0];
    expect(dumpTask).toEqual(
      expect.objectContaining({
        image: "mysql:8.4",
        env: ["MYSQL_PWD=mysql-secret"],
        entrypoint: ["sh", "-c"],
        hostConfig: expect.objectContaining({
          NetworkMode: "container:mysql-container-id",
          Mounts: [
            expect.objectContaining({
              Source: "nouva-backup-stage-backup_mysql",
              Target: "/stage",
            }),
          ],
        }),
      })
    );
    expect(dumpScript).toContain("mysqldump -h127.0.0.1 -P3306 -uroot");
    expect(dumpScript).toContain("--single-transaction");
    expect(dumpScript).toContain("--databases");
    expect(dumpScript).not.toContain("mysql-secret");

    const verifyTask = docker.createContainer.mock.calls[1]?.[0];
    const verifyScript = verifyTask?.cmd?.[2];
    expect(verifyTask?.env).toEqual(expect.arrayContaining(["NOUVA_BACKUP_ID=backup_mysql_1"]));
    expect(verifyTask?.env).not.toEqual(expect.arrayContaining(["MYSQL_PWD=mysql-secret"]));
    expect(verifyScript).toContain('grep -q "Dump completed"');
    expect(verifyScript).toContain("rclone copyto");
    expect(verifyTask?.env).toEqual(
      expect.arrayContaining([
        "RCLONE_CONFIG_NOUVAARCHIVE_TYPE=s3",
        "RCLONE_CONFIG_NOUVAARCHIVE_ENDPOINT=https://s3.example.com",
        "RCLONE_CONFIG_NOUVAARCHIVE_SECRET_ACCESS_KEY=secret-key",
        "RCLONE_CONFIG_NOUVAARCHIVE_INSECURE_SKIP_VERIFY=false",
      ])
    );
    expect(verifyScript).toMatch(
      /remote="nouvaarchive:\$\{BACKUP_BUCKET\}\/\$\{BACKUP_OBJECT_KEY\}"/
    );
    expect(verifyScript).not.toContain("secret-key");
    expect(verifyScript).not.toContain("https://s3.example.com");
    expect(docker.removeVolume).toHaveBeenLastCalledWith("nouva-backup-stage-backup_mysql", true);
    expect(result).toEqual(
      expect.objectContaining({
        sizeBytes: 128,
        objectKey: mysqlBackupPayload.expectedObjectKey,
        artifactFormat: "mysql-dump-tar-v1",
        integrityProof: expect.objectContaining({
          engine: "mysql",
          mysqldumpSucceeded: true,
          dumpCompletedMarkerVerified: true,
          uploadChecksumVerified: true,
        }),
      })
    );
  });

  test("removes the MySQL staging volume when the dump sidecar fails", async () => {
    const docker = createDockerMock();
    docker.waitContainer.mockResolvedValueOnce(1);
    docker.containerLogs.mockResolvedValueOnce("mysqldump: Got error: 1045");

    await expect(
      handleCreateVolumeBackup(docker as never, runtimeConfig, mysqlBackupPayload)
    ).rejects.toThrow("mysqldump: Got error: 1045");

    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    expect(docker.removeVolume).toHaveBeenLastCalledWith("nouva-backup-stage-backup_mysql", true);
  });

  test("restores a MySQL dump by replaying it through the service image on a staged volume", async () => {
    const docker = createDockerMock();

    const result = await handleRestoreVolumeBackup(
      docker as never,
      runtimeConfig,
      mysqlRestorePayload
    );

    expect(docker.createVolume).toHaveBeenNthCalledWith(
      1,
      "nouva-vol-vol_restored_mysql",
      expect.objectContaining({ "nouva.volume.id": "vol_restored_mysql" })
    );
    expect(docker.createVolume).toHaveBeenNthCalledWith(
      2,
      "nouva-restore-stage-backup_mysql",
      expect.objectContaining({ "nouva.resource": "restore-stage" })
    );

    const fetchTask = docker.createContainer.mock.calls[0]?.[0];
    expect(fetchTask?.env).toEqual(expect.arrayContaining([`EXPECTED_SHA256=${"c".repeat(64)}`]));
    expect(fetchTask?.cmd?.[2]).toContain('grep -qx "dump.sql.gz"');

    const replayTask = docker.createContainer.mock.calls[1]?.[0];
    expect(replayTask).toEqual(
      expect.objectContaining({
        image: "mysql:8.4",
        entrypoint: ["sh", "-c"],
        hostConfig: expect.objectContaining({
          Mounts: [
            expect.objectContaining({
              Source: "nouva-vol-vol_restored_mysql",
              Target: "/var/lib/mysql",
            }),
            expect.objectContaining({
              Source: "nouva-restore-stage-backup_mysql",
              Target: "/docker-entrypoint-initdb.d",
              ReadOnly: true,
            }),
          ],
        }),
      })
    );
    expect(replayTask?.env).toEqual(
      expect.arrayContaining(["MYSQL_ROOT_PASSWORD=mysql-secret", "MYSQL_DATABASE=appdb"])
    );
    expect(replayTask?.env).not.toEqual(expect.arrayContaining(["MYSQL_PWD=mysql-secret"]));
    expect(replayTask?.cmd?.[0]).toContain("docker-entrypoint.sh mysqld");
    expect(replayTask?.cmd?.[0]).toContain("mysqladmin");
    expect(docker.removeVolume).toHaveBeenLastCalledWith("nouva-restore-stage-backup_mysql", true);
    expect(result).toEqual(
      expect.objectContaining({
        volumeName: "nouva-vol-vol_restored_mysql",
        restoreProof: expect.objectContaining({
          validationMethod: "mysql-startup-sql-read",
          isolatedDatabaseStarted: true,
          targetVolumeId: "vol_restored_mysql",
        }),
      })
    );
  });

  test("restores a named pgBackRest backup to consistency without a time target", async () => {
    const docker = createDockerMock();

    await handleRestoreVolumeBackup(docker as never, runtimeConfig, {
      ...pgBackrestRestorePayload,
      backupCompletedAt: null,
    });

    const task = docker.createContainer.mock.calls[0]?.[0];
    expect(task?.env).toEqual(
      expect.arrayContaining([
        "RESTORE_TYPE=immediate",
        "RESTORE_TARGET=",
        "RESTORE_SET=20260325-000000F",
        "NOUVA_STAGED_RESTORE=1",
      ])
    );
    expect(task?.cmd?.[0]).toContain("--type=immediate");
  });

  test("keeps timestamp-only pgBackRest backups on time recovery", async () => {
    const docker = createDockerMock();

    await handleRestoreVolumeBackup(docker as never, runtimeConfig, {
      ...pgBackrestRestorePayload,
      pgbackrestSet: null,
    });

    const task = docker.createContainer.mock.calls[0]?.[0];
    expect(task?.env).toEqual(
      expect.arrayContaining([
        "RESTORE_TYPE=time",
        "RESTORE_TARGET=2026-03-25T00:00:00Z",
        "RESTORE_SET=",
        "NOUVA_STAGED_RESTORE=1",
      ])
    );
    expect(task?.cmd?.[0]).toContain("--target-timeline=current");
  });

  test("creates and verifies a MongoDB logical archive through the live container network", async () => {
    const docker = createDockerMock();
    docker.containerLogs.mockResolvedValue(
      "NOUVA_SIZE_BYTES:84\nNOUVA_SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );

    const result = await handleCreateVolumeBackup(
      docker as never,
      runtimeConfig,
      mongodbBackupPayload
    );

    const task = docker.createContainer.mock.calls[0]?.[0];
    const script = task?.cmd?.[2];
    expect(task).toEqual(
      expect.objectContaining({
        env: expect.arrayContaining([
          "MONGODB_USERNAME=root",
          "MONGODB_PASSWORD=mongo-secret",
          "NOUVA_BACKUP_ID=backup_mongo_1",
        ]),
        hostConfig: expect.objectContaining({
          Mounts: undefined,
          NetworkMode: "container:mongo-container-id",
        }),
      })
    );
    expect(script).toContain("mongodump --host 127.0.0.1 --port 27017");
    expect(script).toContain("--authenticationDatabase admin");
    expect(script).toContain("mongorestore --host 127.0.0.1 --port 27017");
    expect(script).toContain("--dryRun");
    expect(script).not.toContain("mongo-secret");
    expect(result).toEqual(
      expect.objectContaining({
        sizeBytes: 84,
        objectKey: mongodbBackupPayload.expectedObjectKey,
        artifactFormat: "mongodb-archive-tar-v1",
        artifactSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        integrityProof: expect.objectContaining({
          engine: "mongodb",
          mongodumpSucceeded: true,
          mongorestoreDryRun: true,
          uploadChecksumVerified: true,
        }),
      })
    );
  });

  test("uses the installed agent image for snapshot backup tasks", async () => {
    const docker = createDockerMock();
    docker.containerLogs.mockResolvedValue(
      "NOUVA_SIZE_BYTES:42\nNOUVA_SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nNOUVA_REDIS_SOURCE_MODE:rdb"
    );
    process.env.NOUVA_AGENT_IMAGE = "registry.nouva.sh/nouva/nouva-agent:v0.4.10";

    await handleCreateVolumeBackup(
      docker as never,
      {
        ...runtimeConfig,
        privateRegistry: {
          host: "registry.nouva.sh",
          username: "srv_srv_1",
          password: "registry-password",
        },
      },
      snapshotBackupPayload
    );

    expect(docker.pullImage).toHaveBeenCalledWith("registry.nouva.sh/nouva/nouva-agent:v0.4.10", {
      host: "registry.nouva.sh",
      username: "srv_srv_1",
      password: "registry-password",
    });
    expect(docker.createContainer.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        image: "registry.nouva.sh/nouva/nouva-agent:v0.4.10",
        cmd: ["sh", "-c", expect.stringContaining("redis-cli -h 127.0.0.1 --rdb")],
        hostConfig: expect.objectContaining({
          Mounts: undefined,
          NetworkMode: "container:nouva-redis-svc_redis_1",
        }),
      })
    );
  });

  test("uses private registry auth when a PITR helper image is hosted on the private registry", async () => {
    const docker = createDockerMock();

    await handleRestorePostgresPitr(
      docker as never,
      {
        ...runtimeConfig,
        privateRegistry: {
          host: "registry.nouva.sh",
          username: "srv_srv_1",
          password: "registry-password",
        },
      },
      {
        ...databasePayload,
        sourceVolumeId: "vol_source",
        sourceVolumeName: "nouva-vol-vol_source",
        sourceMountPath: "/var/lib/postgresql",
        imageUrl: "registry.nouva.sh/nouva/postgres:17",
        destination: {} as never,
        restoreTarget: "2026-03-25T00:00:00Z",
      }
    );

    expect(docker.pullImage).toHaveBeenCalledWith("registry.nouva.sh/nouva/postgres:17", {
      host: "registry.nouva.sh",
      username: "srv_srv_1",
      password: "registry-password",
    });
  });

  test("does not attach private registry auth when a PITR helper image is public", async () => {
    const docker = createDockerMock();

    await handleRestorePostgresPitr(
      docker as never,
      {
        ...runtimeConfig,
        privateRegistry: {
          host: "registry.nouva.sh",
          username: "srv_srv_1",
          password: "registry-password",
        },
      },
      {
        ...databasePayload,
        sourceVolumeId: "vol_source",
        sourceVolumeName: "nouva-vol-vol_source",
        sourceMountPath: "/var/lib/postgresql",
        imageUrl: "postgres:17",
        destination: {} as never,
        restoreTarget: "2026-03-25T00:00:00Z",
      }
    );

    expect(docker.pullImage).toHaveBeenCalledWith("postgres:17", undefined);
  });

  test("does not contain the removed custom runtime log collector loop", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).not.toContain("/api/agent/logs/runtime");
    expect(source).not.toContain("syncRuntimeLogs");
    expect(source).not.toContain("NOUVA_AGENT_RUNTIME_LOG_SYNC_INTERVAL_MS");
  });
});

describe("database restart readiness", () => {
  const restartPayload = {
    projectId: "proj_1",
    serviceId: "svc_1",
    serviceName: "main-db",
    variant: "postgres" as const,
    containerName: "nouva-postgres-svc_1",
    runtimeMetadata: { containerId: "ctr_1", containerName: "nouva-postgres-svc_1" },
  };

  function liveDatabaseInspection(overrides?: Record<string, unknown>) {
    return {
      Id: "ctr_1",
      Name: "/nouva-postgres-svc_1",
      RestartCount: 0,
      State: { Running: true, Status: "running", ExitCode: 0, OOMKilled: false },
      NetworkSettings: { Networks: { managed: { IPAddress: "172.18.0.9" } } },
      Config: {
        Image: "postgres:17",
        Env: ["POSTGRES_USER=nouva_user", "POSTGRES_PASSWORD=super-secret"],
        Labels: { "nouva.project.id": "proj_1", "nouva.service.variant": "postgres" },
      },
      ...overrides,
    };
  }

  function probeSpecs(docker: ReturnType<typeof createDockerMock>) {
    return docker.createContainer.mock.calls
      .map((call) => call[0] as DockerContainerSpec)
      .filter((spec) => spec.name?.startsWith("nouva-db-ready-"));
  }

  test("reports a restarted database only once it answers an authenticated probe", async () => {
    const docker = createDockerMock();
    docker.inspectContainer.mockResolvedValue(liveDatabaseInspection());

    const result = await handleRestartService(
      docker as never,
      runtimeConfig,
      "restart_database",
      restartPayload
    );

    expect(docker.restartContainer).toHaveBeenCalledWith("nouva-postgres-svc_1");
    expect(probeSpecs(docker)).toHaveLength(1);
    expect(probeSpecs(docker)[0]?.env).toContain("PGHOST=nouva-postgres-svc_1");
    // A restart must never replace the container or its data.
    expect(docker.ensureContainer).not.toHaveBeenCalled();
    expect(docker.removeVolume).not.toHaveBeenCalled();
    expect(docker.createVolume).not.toHaveBeenCalled();
    expect(result.runtimeMetadata.containerName).toBe("nouva-postgres-svc_1");
  });

  test("fails a restart that leaves the engine unable to start", async () => {
    const docker = createDockerMock();
    let restarted = false;
    docker.restartContainer.mockImplementation(async () => {
      restarted = true;
    });
    docker.inspectContainer.mockImplementation(async () =>
      restarted
        ? liveDatabaseInspection({
            RestartCount: 3,
            State: { Running: true, Status: "restarting", ExitCode: 1, OOMKilled: false },
          })
        : liveDatabaseInspection()
    );

    await expect(
      handleRestartService(docker as never, runtimeConfig, "restart_database", restartPayload)
    ).rejects.toThrow("Database container nouva-postgres-svc_1 keeps restarting");
  });

  test("waits for a database that only answers after a delay", async () => {
    const docker = createDockerMock();
    let inspections = 0;
    docker.inspectContainer.mockImplementation(async () => {
      inspections += 1;
      // The engine is still starting when readiness first looks at it.
      return inspections === 3
        ? liveDatabaseInspection({
            State: { Running: false, Status: "created" },
            NetworkSettings: { Networks: {} },
          })
        : liveDatabaseInspection();
    });

    await handleRestartService(docker as never, runtimeConfig, "restart_database", restartPayload);

    expect(inspections).toBeGreaterThanOrEqual(4);
    expect(probeSpecs(docker)).toHaveLength(1);
  });

  test("does not read a long-lived container's restart history as this restart failing", async () => {
    const docker = createDockerMock();
    // The restart policy recovered this database nine times over its lifetime; the operator restart
    // that just happened added none of them.
    docker.inspectContainer.mockResolvedValue(liveDatabaseInspection({ RestartCount: 9 }));

    await handleRestartService(docker as never, runtimeConfig, "restart_database", restartPayload);

    expect(probeSpecs(docker)).toHaveLength(1);
  });

  test("leaves app restarts exactly as they were", async () => {
    const docker = createDockerMock();
    docker.inspectContainer.mockResolvedValue(liveDatabaseInspection());

    await handleRestartService(docker as never, runtimeConfig, "restart_app", {
      ...restartPayload,
      containerName: "nouva-app-svc_1-dep_1",
      runtimeMetadata: { containerId: "ctr_app", containerName: "nouva-app-svc_1-dep_1" },
    });

    expect(docker.restartContainer).toHaveBeenCalledWith("nouva-app-svc_1-dep_1");
    expect(probeSpecs(docker)).toHaveLength(0);
  });
});

describe("resolveServiceContainerIdentifier", () => {
  test("prefers explicit container names over runtime metadata", () => {
    expect(
      resolveServiceContainerIdentifier({
        containerName: "nouva-postgres-svc_1",
        runtimeMetadata: {
          containerId: "ctr_1",
          containerName: "legacy-name",
        },
      })
    ).toBe("nouva-postgres-svc_1");
  });
});

describe("verified volume cleanup", () => {
  test("returns delete proof only after Docker confirms the volume is absent", async () => {
    const docker = createDockerMock();

    const result = await handleDeleteVolume(docker as never, {
      projectId: "proj_1",
      volumeId: "vol_1",
      volumeName: "nouva-vol-vol_1",
    });

    expect(docker.removeVolume).toHaveBeenCalledWith("nouva-vol-vol_1", true);
    expect(docker.inspectVolume).toHaveBeenCalledWith("nouva-vol-vol_1");
    expect(result.cleanupProof).toEqual({
      version: 1,
      kind: "delete_volume",
      volume: { name: "nouva-vol-vol_1", absent: true },
    });
  });

  test("does not emit proof when Docker still reports the volume", async () => {
    const docker = createDockerMock();
    docker.inspectVolume.mockResolvedValueOnce({ Name: "nouva-vol-vol_1" });

    await expect(
      handleDeleteVolume(docker as never, {
        projectId: "proj_1",
        volumeId: "vol_1",
        volumeName: "nouva-vol-vol_1",
      })
    ).rejects.toThrow("still exists after cleanup");
  });

  test("propagates a volume-in-use conflict without inspecting absence", async () => {
    const docker = createDockerMock();
    const conflict = new DockerApiError(
      409,
      "DELETE",
      "/v1.51/volumes/nouva-vol-vol_1",
      "volume is in use"
    );
    docker.removeVolume.mockRejectedValueOnce(conflict);

    await expect(
      handleDeleteVolume(docker as never, {
        projectId: "proj_1",
        volumeId: "vol_1",
        volumeName: "nouva-vol-vol_1",
      })
    ).rejects.toBe(conflict);
    expect(docker.inspectVolume).not.toHaveBeenCalled();
  });
});

// #143: the per-project network was created on the first deploy and never removed, so every deleted
// project left a `nouva-project-<hash>` behind on the customer's server for good.
describe("verified project network cleanup", () => {
  const PROJECT_NETWORK = `nouva-project-${hashProjectNetwork("proj_1")}`;

  test("detaches Traefik, removes the network, and proves it is gone", async () => {
    const docker = createDockerMock();

    const result = await handleDeleteProject(docker as never, { projectId: "proj_1" });

    expect(docker.disconnectNetwork).toHaveBeenCalledWith(PROJECT_NETWORK, "nouva-traefik", true);
    expect(docker.removeNetwork).toHaveBeenCalledWith(PROJECT_NETWORK);
    expect(docker.inspectNetwork).toHaveBeenCalledWith(PROJECT_NETWORK);
    expect(result.cleanupProof).toEqual({
      version: 1,
      kind: "delete_project",
      network: { name: PROJECT_NETWORK, absent: true },
    });
  });

  // The name must come from the same derivation that created the network, not from the payload.
  test("derives the network name from the project id", async () => {
    const docker = createDockerMock();

    const result = await handleDeleteProject(docker as never, { projectId: "proj_2" });

    expect(result.networkName).toBe(`nouva-project-${hashProjectNetwork("proj_2")}`);
    expect(result.networkName).not.toBe(PROJECT_NETWORK);
  });

  test("does not emit proof when Docker still reports the network", async () => {
    const docker = createDockerMock();
    docker.inspectNetwork.mockResolvedValueOnce({ Name: PROJECT_NETWORK });

    await expect(handleDeleteProject(docker as never, { projectId: "proj_1" })).rejects.toThrow(
      "still exists after cleanup"
    );
  });

  // Docker refuses to delete a network that still has endpoints attached. Reporting that as success
  // would leave the network behind with a proof saying it was removed.
  test("propagates an endpoints-still-attached conflict without claiming absence", async () => {
    const docker = createDockerMock();
    const conflict = new DockerApiError(
      403,
      "DELETE",
      `/v1.51/networks/${PROJECT_NETWORK}`,
      "network has active endpoints"
    );
    docker.removeNetwork.mockRejectedValueOnce(conflict);

    await expect(handleDeleteProject(docker as never, { projectId: "proj_1" })).rejects.toBe(
      conflict
    );
    expect(docker.inspectNetwork).not.toHaveBeenCalled();
  });
});

describe("verified service cleanup", () => {
  test.each([
    "listing",
    "removal",
    "verification",
    "leftover",
  ])("does not prove deletion when %s fails", async (failure) => {
    const docker = createDockerMock();
    const container = {
      Id: "orphan",
      Config: { Labels: { "nouva.managed": "true", "nouva.service.id": "svc_1" } },
    };
    docker.listContainersByLabels.mockResolvedValue([container] as never);
    if (failure === "listing")
      docker.listContainersByLabels.mockRejectedValue(new Error("listing failed"));
    if (failure === "removal")
      docker.removeContainer.mockRejectedValue(new Error("removal failed"));
    if (failure === "verification")
      docker.listContainersByLabels
        .mockResolvedValueOnce([container] as never)
        .mockRejectedValueOnce(new Error("verification failed"));
    await expect(
      handleDeleteService(docker as never, {
        projectId: "proj_1",
        serviceId: "svc_1",
        serviceName: "app",
        serviceType: "app",
        runtimeMetadata: null,
      })
    ).rejects.toThrow();
  });

  test.each([
    "app",
    "database",
  ] as const)("%s cleanup never deletes unmanaged or other-service containers from stale metadata", async (serviceType) => {
    const docker = createDockerMock();
    docker.listContainersByLabels.mockResolvedValue([
      {
        Id: "foreign",
        Config: { Labels: { "nouva.managed": "true", "nouva.service.id": "other" } },
      },
      { Id: "unmanaged", Config: { Labels: { "nouva.service.id": "svc_1" } } },
    ] as never);
    await handleDeleteService(docker as never, {
      projectId: "proj_1",
      serviceId: "svc_1",
      serviceName: "service",
      serviceType,
      runtimeMetadata: { containerId: "foreign" },
    });
    expect(docker.removeContainer).not.toHaveBeenCalled();
  });

  test.each([
    null,
    { containerName: "already-removed-live" },
  ])("sweeps running failed and stopped replaced deployments with metadata %j", async (runtimeMetadata) => {
    const docker = createDockerMock();
    const containers = new Map(
      ["failed-running", "replaced-stopped"].map((id) => [
        id,
        {
          Id: id,
          State: { Running: id === "failed-running" },
          Config: { Labels: { "nouva.managed": "true", "nouva.service.id": "svc_1" } },
        },
      ])
    );
    docker.listContainersByLabels.mockImplementation(async () => [...containers.values()] as never);
    docker.removeContainer.mockImplementation(async (id: string) => {
      containers.delete(id);
    });
    const result = await handleDeleteService(docker as never, {
      projectId: "proj_1",
      serviceId: "svc_1",
      serviceName: "app",
      serviceType: "app",
      runtimeMetadata,
    });
    expect(containers.size).toBe(0);
    expect(docker.listContainersByLabels).toHaveBeenCalledWith({
      "nouva.managed": "true",
      "nouva.service.id": "svc_1",
    });
    expect(result.cleanupProof).toMatchObject({
      serviceContainers: { serviceId: "svc_1", remainingContainerIds: [] },
    });
  });

  test("retries partial cleanup and removes distinct tags sharing one image ID", async () => {
    const docker = createDockerMock();
    const previousImageFailure = new Error("Docker daemon became unavailable");
    let shouldFailPreviousImage = true;
    docker.inspectImage.mockResolvedValue(null);
    docker.removeImage.mockImplementation(async (reference: string) => {
      if (reference === "nouva-app:previous" && shouldFailPreviousImage) {
        shouldFailPreviousImage = false;
        throw previousImageFailure;
      }
    });
    const payload = {
      projectId: "proj_1",
      serviceId: "svc_1",
      serviceName: "app",
      serviceType: "app" as const,
      containerName: "nouva-app-svc_1",
      runtimeMetadata: {
        imageStoreMode: "docker-local" as const,
        currentImage: {
          reference: "nouva-app:current",
          imageId: "sha256:shared",
        },
        previousImage: {
          reference: "nouva-app:previous",
          imageId: "sha256:shared",
        },
      },
    };

    await expect(handleDeleteService(docker as never, payload)).rejects.toBe(previousImageFailure);
    const result = await handleDeleteService(docker as never, payload);

    expect(docker.removeImage.mock.calls.map(([reference]) => reference)).toEqual([
      "nouva-app:current",
      "nouva-app:previous",
      "nouva-app:current",
      "nouva-app:previous",
    ]);
    expect(result.cleanupProof).toEqual({
      version: 1,
      kind: "delete_service",
      serviceContainers: { serviceId: "svc_1", remainingContainerIds: [] },
      container: { identifier: "nouva-app-svc_1", absent: true },
      retainedImages: [
        { reference: "nouva-app:current", absent: true },
        { reference: "nouva-app:previous", absent: true },
      ],
    });
  });

  test("removes the service's build cache, for workers too", async () => {
    const docker = Object.assign(createDockerMock(), {
      listContainersByLabels: mock(async () => []),
    });
    docker.inspectImage.mockResolvedValue(null);

    await handleDeleteService(docker as never, {
      projectId: "proj_1",
      serviceId: "svc_1",
      serviceName: "app",
      serviceType: "app" as const,
      containerName: "nouva-app-svc_1",
      runtimeMetadata: null,
    });
    await handleDeleteService(docker as never, {
      projectId: "proj_1",
      serviceId: "svc_2",
      serviceName: "worker",
      serviceType: "worker" as const,
      containerName: "nouva-worker-svc_2",
      runtimeMetadata: null,
    });

    // Nothing else reclaims a named cache volume once its service is gone (#184).
    expect(docker.removeVolume.mock.calls).toEqual([
      ["nouva-buildkit-cache-svc_1", true],
      ["nouva-buildkit-cache-svc_2", true],
    ]);
  });
});

describe("verified volume wipe", () => {
  test("proves detached volume absence before creating and proving a replacement", async () => {
    const docker = createDockerMock();
    const events: string[] = [];
    let inspectionCount = 0;
    docker.removeVolume.mockImplementation(async () => {
      events.push("remove");
    });
    docker.inspectVolume.mockImplementation(async () => {
      inspectionCount += 1;
      events.push(inspectionCount === 1 ? "inspect-absent" : "inspect-present");
      return inspectionCount === 1 ? null : { Name: "nouva-vol-vol_1" };
    });
    docker.createVolume.mockImplementation(async () => {
      events.push("create");
    });

    const result = await handleWipeVolume(
      docker as never,
      {},
      {
        projectId: "proj_1",
        volumeId: "vol_1",
        volumeName: "nouva-vol-vol_1",
      }
    );

    expect(events).toEqual(["remove", "inspect-absent", "create", "inspect-present"]);
    expect(result.cleanupProof).toEqual({
      version: 1,
      kind: "wipe_volume",
      previousContainer: { identifier: null, absent: true },
      previousVolume: { name: "nouva-vol-vol_1", absent: true },
      replacementVolume: { name: "nouva-vol-vol_1", present: true },
    });
  });

  test("removes a replacement container left by a partial attached wipe before retrying", async () => {
    const docker = createDockerMock();
    const deterministicContainerName = "nouva-postgres-svc_1";
    let replacementContainerPresent = false;
    let volumePresent = true;
    let volumeInspectionCount = 0;

    docker.removeContainer.mockImplementation(async (identifier: string) => {
      if (identifier === deterministicContainerName) {
        replacementContainerPresent = false;
      }
    });
    docker.inspectContainer.mockImplementation(async (identifier: string) =>
      identifier === deterministicContainerName && replacementContainerPresent
        ? ({
            Id: "ctr_replacement",
            Name: `/${deterministicContainerName}`,
            RestartCount: 0,
            State: { Running: true, Status: "running", ExitCode: 0, OOMKilled: false },
            NetworkSettings: { Networks: { managed: { IPAddress: "172.18.0.9" } } },
          } as never)
        : null
    );
    docker.removeVolume.mockImplementation(async () => {
      if (replacementContainerPresent) {
        throw new Error("volume is in use");
      }
      volumePresent = false;
    });
    docker.createVolume.mockImplementation(async () => {
      volumePresent = true;
    });
    docker.ensureContainer.mockImplementation(async () => {
      replacementContainerPresent = true;
      return "ctr_replacement";
    });
    docker.inspectVolume.mockImplementation(async () => {
      volumeInspectionCount += 1;
      if (volumeInspectionCount === 2) {
        return null;
      }
      return volumePresent ? { Name: "nouva-vol-vol_1" } : null;
    });
    const payload = {
      ...databasePayload,
      runtimeMetadata: {
        containerId: "ctr_old",
      },
    };

    await expect(handleWipeVolume(docker as never, runtimeConfig, payload)).rejects.toThrow(
      "Replacement Docker volume nouva-vol-vol_1 was not created"
    );
    expect(replacementContainerPresent).toBe(true);

    const result = await handleWipeVolume(docker as never, runtimeConfig, payload);

    expect(serviceContainerRemovals(docker)).toEqual([
      ["ctr_old", true],
      [deterministicContainerName, true],
      ["ctr_old", true],
      [deterministicContainerName, true],
    ]);
    expect(result.cleanupProof).toEqual({
      version: 1,
      kind: "wipe_volume",
      previousContainer: { identifier: "ctr_old", absent: true },
      previousVolume: { name: "nouva-vol-vol_1", absent: true },
      replacementVolume: { name: "nouva-vol-vol_1", present: true },
    });
  });

  // The dangerous retry is the one after a *successful* attempt whose completion never reached the
  // control plane: repeating the destructive phase would erase the cluster that already initialized
  // under the rotated repository, leaving that repository with no matching system identifier.
  function createWipeDockerMock() {
    const docker = createDockerMock();
    let volumePresent = true;
    docker.removeVolume.mockImplementation(async () => {
      volumePresent = false;
    });
    docker.createVolume.mockImplementation(async () => {
      volumePresent = true;
    });
    docker.inspectVolume.mockImplementation(async () =>
      volumePresent ? ({ Name: "nouva-vol-vol_1" } as never) : null
    );
    const containerName = "nouva-postgres-svc_1";
    let containerPresent = false;
    docker.removeContainer.mockImplementation(async (identifier: string) => {
      if (identifier === containerName) {
        containerPresent = false;
      }
    });
    docker.inspectContainer.mockImplementation(async (identifier: string) =>
      identifier === containerName && containerPresent
        ? ({
            Id: "ctr_new",
            Name: `/${containerName}`,
            RestartCount: 0,
            State: { Running: true, Status: "running", ExitCode: 0, OOMKilled: false },
            NetworkSettings: { Networks: { managed: { IPAddress: "172.18.0.9" } } },
          } as never)
        : null
    );
    docker.ensureContainer.mockImplementation(async () => {
      containerPresent = true;
      return "ctr_new";
    });
    return docker;
  }

  test("resumes at provisioning instead of erasing the cluster a lost completion left behind", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nouva-wipe-receipt-"));

    try {
      const docker = createWipeDockerMock();
      const payload = {
        ...databasePayload,
        pgbackrestRepositoryGeneration: 1,
        runtimeMetadata: { containerId: "ctr_old" },
      };

      await handleWipeVolume(docker as never, runtimeConfig, payload, {
        workItemId: "work_1",
        dataDir,
      });
      expect(docker.removeVolume.mock.calls).toEqual([["nouva-vol-vol_1", true]]);

      docker.removeVolume.mockClear();
      docker.removeContainer.mockClear();

      const replay = await handleWipeVolume(docker as never, runtimeConfig, payload, {
        workItemId: "work_1",
        dataDir,
      });

      expect(docker.removeVolume.mock.calls).toEqual([]);
      expect(serviceContainerRemovals(docker)).toEqual([]);
      expect(replay.cleanupProof).toEqual({
        version: 1,
        kind: "wipe_volume",
        previousContainer: { identifier: "ctr_old", absent: true },
        previousVolume: { name: "nouva-vol-vol_1", absent: true },
        replacementVolume: { name: "nouva-vol-vol_1", present: true },
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("wipes again when a later wipe rotates the repository to a new generation", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nouva-wipe-receipt-"));

    try {
      const docker = createWipeDockerMock();
      const payload = {
        ...databasePayload,
        runtimeMetadata: { containerId: "ctr_old" },
      };

      await handleWipeVolume(
        docker as never,
        runtimeConfig,
        { ...payload, pgbackrestRepositoryGeneration: 1 },
        { workItemId: "work_1", dataDir }
      );
      docker.removeVolume.mockClear();

      // Wipe work is deduplicated, so the second wipe reuses the same work item id. Only the
      // generation distinguishes the two, and a stale receipt must not suppress the new wipe.
      await handleWipeVolume(
        docker as never,
        runtimeConfig,
        { ...payload, pgbackrestRepositoryGeneration: 2 },
        { workItemId: "work_1", dataDir }
      );

      expect(docker.removeVolume.mock.calls).toEqual([["nouva-vol-vol_1", true]]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  // An unreadable receipt is not evidence that nothing happened: the previous attempt may have
  // already replaced the volume and provisioned the fresh cluster. Destroying again on that
  // evidence is exactly the data loss the receipt exists to prevent.
  test("refuses to mutate Docker when the receipt exists but cannot be read", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nouva-wipe-receipt-"));

    try {
      const docker = createWipeDockerMock();
      const payload = {
        ...databasePayload,
        pgbackrestRepositoryGeneration: 1,
        runtimeMetadata: { containerId: "ctr_old" },
      };

      await mkdir(path.join(dataDir, "volume-wipes"), { recursive: true });
      const receiptPath = path.join(dataDir, "volume-wipes", "nouva-vol-vol_1.json");
      await writeFile(receiptPath, '{"version": 1, "volumeName": "nouva-v');

      await expect(
        handleWipeVolume(docker as never, runtimeConfig, payload, {
          workItemId: "work_1",
          dataDir,
        })
      ).rejects.toThrow("is not valid JSON");

      await writeFile(receiptPath, JSON.stringify({ version: 2, volumeName: "nouva-vol-vol_1" }));

      await expect(
        handleWipeVolume(docker as never, runtimeConfig, payload, {
          workItemId: "work_1",
          dataDir,
        })
      ).rejects.toThrow("does not have a recognised shape");

      expect(docker.removeContainer.mock.calls).toEqual([]);
      expect(docker.removeVolume.mock.calls).toEqual([]);
      expect(docker.createVolume.mock.calls).toEqual([]);
      expect(docker.ensureContainer.mock.calls).toEqual([]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("still repeats the destructive phase for volumes without repository lineage", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nouva-wipe-receipt-"));

    try {
      const docker = createWipeDockerMock();
      const payload = {
        projectId: "proj_1",
        volumeId: "vol_1",
        volumeName: "nouva-vol-vol_1",
      };

      await handleWipeVolume(docker as never, {}, payload, { dataDir });
      await handleWipeVolume(docker as never, {}, payload, { dataDir });

      expect(docker.removeVolume.mock.calls).toEqual([
        ["nouva-vol-vol_1", true],
        ["nouva-vol-vol_1", true],
      ]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("handleReconcileServiceResources", () => {
  const reconcilePayload = {
    serviceId: "svc_1",
    containerName: "nouva-app-svc_1",
    runtimeMetadata: null,
    resourceLimits: {
      cpuMillicores: 250,
      memoryBytes: 128 * 1024 * 1024,
      memoryAndSwapBytes: 512 * 1024 * 1024,
      pidsLimit: 256,
      policyVersion: 1,
    },
  };

  function createReconcileDocker(hostConfig: Record<string, number>) {
    const docker = createDockerMock();
    docker.updateContainer = mock(async () => {});
    docker.inspectContainer = mock(async () => ({
      Id: "ctr_1",
      Name: "nouva-app-svc_1",
      HostConfig: hostConfig,
    })) as never;
    return docker;
  }

  test("updates the running container with the stored swap allowance", async () => {
    const docker = createReconcileDocker({
      NanoCpus: 250_000_000,
      Memory: 128 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,
      PidsLimit: 256,
    });

    await expect(
      handleReconcileServiceResources(docker as never, reconcilePayload as never)
    ).resolves.toEqual({
      serviceId: "svc_1",
      containerId: "ctr_1",
      applied: {
        nanoCpus: 250_000_000,
        memory: 128 * 1024 * 1024,
        memorySwap: 512 * 1024 * 1024,
        pidsLimit: 256,
        policyVersion: 1,
      },
    });
    expect(docker.updateContainer).toHaveBeenCalledWith("nouva-app-svc_1", {
      NanoCpus: 250_000_000,
      Memory: 128 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,
      PidsLimit: 256,
    });
  });

  test("fails when the daemon silently dropped the allowance", async () => {
    const docker = createReconcileDocker({
      NanoCpus: 250_000_000,
      Memory: 128 * 1024 * 1024,
      MemorySwap: 128 * 1024 * 1024,
      PidsLimit: 256,
    });

    await expect(
      handleReconcileServiceResources(docker as never, reconcilePayload as never)
    ).rejects.toThrow(
      "Container ctr_1 did not apply the requested resource limits: MemorySwap 134217728 (expected 536870912)"
    );
  });
});

describe("external backup import", () => {
  const POSTGRES_HEADER_BASE64 =
    "UEdETVABEAAECAEBADgAAAAAJwAAAAARAAAAAAkAAAAACAAAAAB+AAAAAAAAAAAABwAAAGZpeHR1cmUA" +
    "HwAAADE2LjE1IChEZWJpYW4gMTYuMTUtMS5wZ2RnMTMrMikABAAAADE4LjQABwAAAABWDQAAAAAAAAAAAQAAADAAAQA=";
  const POSTGRES_SHA256 = "fb2e454c51162909c3da786edb545027752cd2f3004887bef4a7421808d0ac1e";

  function createImportPayload(overrides: Record<string, unknown> = {}) {
    return {
      projectId: "project_1",
      serviceId: "service_1",
      serviceName: "db",
      variant: "postgres" as const,
      version: "17",
      importId: "import_abcdef123456",
      format: "postgres-custom-dump-v1" as const,
      artifactSha256: POSTGRES_SHA256,
      artifactSizeBytes: 1024,
      objectKey: "imports/v1/projects/project_1/services/service_1/import_abcdef123456.artifact",
      sourceVolumeId: "volume_source",
      sourceVolumeName: "nouva-vol-volume_source",
      targetVolumeId: "volume_target",
      targetVolumeName: "nouva-vol-volume_target",
      targetMountPath: "/var/lib/postgresql",
      destination: {
        bucket: "nouva-backups",
        endpoint: "https://s3.example.com",
        region: "eu-west-1",
        pathStyle: true,
        verifyTls: true,
        accessKeyId: "key",
        secretAccessKey: "secret",
      },
      imageUrl: "registry.example.com/nouva/postgres:17",
      envVars: { POSTGRES_USER: "app", POSTGRES_PASSWORD: "pw", POSTGRES_DB: "app" },
      containerArgs: [],
      dataPath: "/var/lib/postgresql/pgdata",
      credentials: { username: "app", password: "pw", database: "app" },
      ...overrides,
    };
  }

  function fetchLogs(input: { sha256: string; sizeBytes: number; headerBase64: string }): string {
    return [
      `NOUVA_SHA256:${input.sha256}`,
      `NOUVA_SIZE_BYTES:${input.sizeBytes}`,
      `NOUVA_ARTIFACT_HEADER:${input.headerBase64}`,
    ].join("\n");
  }

  test("measures the artifact without deciding anything about it", () => {
    const script = buildExternalBackupImportFetchScript(8192);

    expect(script).toContain('rclone copyto "$remote" "$artifact"');
    expect(script).toContain('printf "NOUVA_SHA256:%s\\n" "$actual_sha256"');
    expect(script).toContain('printf "NOUVA_SIZE_BYTES:%s\\n" "$actual_size"');
    expect(script).toContain("head -c 8192");
    // The managed-restore path guards its digest check with `if [ -n "$EXPECTED_SHA256" ]`, which
    // silently passes when the digest is absent. An import must never grow that shape: the
    // comparison belongs to the verifier, which has no way to skip it.
    expect(script).not.toContain("EXPECTED_SHA256");
  });

  test("replays a Postgres archive atomically and strips its ownership claims", () => {
    const script = buildPostgresExternalBackupImportScript();

    expect(script).toContain("--single-transaction");
    expect(script).toContain("--exit-on-error");
    expect(script).toContain("--no-owner");
    expect(script).toContain("--no-privileges");
    // Every other client in this script reaches the destination through PGHOST/PGPORT/PGDATABASE,
    // and `pg_restore` is the one that does not: given no `--dbname` it writes SQL to stdout and
    // `--single-transaction` aborts for want of a connection, so the archive is never replayed.
    const restoreCommand = script.split("\n").find((line) => line.startsWith("pg_restore "));
    expect(restoreCommand).toContain('--dbname "$PGDATABASE"');
    expect(script.indexOf("pg_restore")).toBeLessThan(script.indexOf("NOUVA_IMPORT_RESTORED:"));
    expect(script.indexOf("NOUVA_IMPORT_RESTORED:")).toBeLessThan(
      script.indexOf("NOUVA_IMPORT_RELATIONS:")
    );
  });

  test("proves a Redis snapshot loads in the engine that will serve it", () => {
    const script = buildRedisExternalBackupImportScript();

    expect(script).toContain("redis-server --port 6380 --bind 127.0.0.1");
    expect(script).toContain("redis-cli -h 127.0.0.1 -p 6380 PING");
    expect(script).toContain("The destination Redis server did not load the imported snapshot");
    expect(script).toContain('printf "NOUVA_IMPORT_VOLATILE_KEYS:%s\\n" "$volatile"');
  });

  test("refuses to proceed when the download reported incomplete evidence", () => {
    expect(() =>
      parseExternalBackupImportObservation(
        `NOUVA_SIZE_BYTES:1024\nNOUVA_ARTIFACT_HEADER:${POSTGRES_HEADER_BASE64}`
      )
    ).toThrow(/complete integrity evidence/);
    expect(() =>
      parseExternalBackupImportObservation(
        `NOUVA_SHA256:${POSTGRES_SHA256}\nNOUVA_ARTIFACT_HEADER:${POSTGRES_HEADER_BASE64}`
      )
    ).toThrow(/complete integrity evidence/);
    expect(() =>
      parseExternalBackupImportObservation(`NOUVA_SHA256:${POSTGRES_SHA256}\nNOUVA_SIZE_BYTES:1024`)
    ).toThrow(/complete integrity evidence/);
  });

  test("stages a verified archive and returns a receipt bound to the work item", async () => {
    const docker = createDockerMock();
    docker.containerLogs
      .mockResolvedValueOnce(
        fetchLogs({
          sha256: POSTGRES_SHA256,
          sizeBytes: 1024,
          headerBase64: POSTGRES_HEADER_BASE64,
        })
      )
      .mockResolvedValueOnce("NOUVA_IMPORT_RESTORED:1\nNOUVA_IMPORT_RELATIONS:42");

    const result = await handleImportExternalBackup(
      docker as never,
      {} as never,
      createImportPayload() as never
    );

    expect(result.volumeName).toBe("nouva-vol-volume_target");
    expect(result.importProof).toEqual(
      expect.objectContaining({
        version: 1,
        importId: "import_abcdef123456",
        format: "postgres-custom-dump-v1",
        targetVolumeId: "volume_target",
        artifactSha256: POSTGRES_SHA256,
        artifactSizeBytes: 1024,
        digestVerified: true,
        headerVerified: true,
        sourceEngineVersion: "16.15 (Debian 16.15-1.pgdg13+2)",
        destinationVariant: "postgres",
        destinationVersion: "17",
        validationMethod: "postgres-startup-sql-read",
        isolatedDatabaseStarted: true,
        relationCount: 42,
      })
    );

    const restoreSpec = docker.createContainer.mock.calls[1]?.[0];
    expect(restoreSpec?.image).toBe("registry.example.com/nouva/postgres:17");
    // Untrusted SQL runs as the destination superuser; the container that replays it must not be
    // able to reach the internet or the customer's other services.
    expect(restoreSpec?.hostConfig?.NetworkMode).toBe("none");
    expect(
      restoreSpec?.hostConfig?.Mounts?.find(
        (mount: { Target: string }) => mount.Target === "/nouva-import"
      )?.ReadOnly
    ).toBe(true);
  });

  test("fails an artifact whose bytes do not match the registered digest", async () => {
    const docker = createDockerMock();
    docker.containerLogs.mockResolvedValueOnce(
      fetchLogs({
        sha256: "0".repeat(64),
        sizeBytes: 1024,
        headerBase64: POSTGRES_HEADER_BASE64,
      })
    );

    const error = await handleImportExternalBackup(
      docker as never,
      {} as never,
      createImportPayload() as never
    ).catch((caught: unknown) => caught);

    expect((error as { result: unknown }).result).toEqual({
      importFailure: {
        category: "integrity_mismatch",
        message: "Uploaded artifact does not match the SHA-256 digest registered for this import",
      },
    });
    // Nothing was staged: the target volume is never created for bytes that failed verification.
    expect(
      docker.createVolume.mock.calls.some((call) => call[0] === "nouva-vol-volume_target")
    ).toBe(false);
  });

  test("fails an archive taken from a newer engine than the destination runs", async () => {
    const docker = createDockerMock();
    docker.containerLogs.mockResolvedValueOnce(
      fetchLogs({
        sha256: POSTGRES_SHA256,
        sizeBytes: 1024,
        headerBase64: POSTGRES_HEADER_BASE64,
      })
    );

    const error = await handleImportExternalBackup(
      docker as never,
      {} as never,
      createImportPayload({ version: "15" }) as never
    ).catch((caught: unknown) => caught);

    expect(
      (error as { result: { importFailure: { category: string } } }).result.importFailure
    ).toEqual(expect.objectContaining({ category: "engine_version_incompatible" }));
  });

  test("deletes the artifact whether the import succeeded or failed", async () => {
    const docker = createDockerMock();
    docker.containerLogs.mockResolvedValueOnce(
      fetchLogs({
        sha256: "0".repeat(64),
        sizeBytes: 1024,
        headerBase64: POSTGRES_HEADER_BASE64,
      })
    );

    await handleImportExternalBackup(
      docker as never,
      {} as never,
      createImportPayload() as never
    ).catch(() => {});

    const cleanupSpec = docker.createContainer.mock.calls.at(-1)?.[0];
    expect(cleanupSpec?.name).toBe("nouva-import-cleanup-import_abcde");
    expect(cleanupSpec?.cmd?.[2]).toContain('rclone deletefile "$remote" || true');
  });
});
