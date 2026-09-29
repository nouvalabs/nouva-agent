import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type DockerApiClient,
  type DockerContainerInspection,
  type DockerContainerSpec,
  hasManagedContainerLogConfig,
  MANAGED_CONTAINER_LOG_CONFIG,
  REDACTION_CONTEXT_VERSION_DOCKER_LABEL,
} from "./docker-api.js";
import type {
  AgentRedactionContextScopeVersion,
  AgentRuntimeConfig,
  ServerCheckStatus,
  ServerValidationCheck,
} from "./protocol.js";
import { redactSensitiveText } from "./security.js";
import { calculateDiskSafetyReserveBytes, formatStorageBytes } from "./storage-metrics.js";
import { TRAEFIK_ADMIN_PORT, TRAEFIK_CONTAINER_NAME } from "./traefik-runtime.js";

export const ALLOY_CONTAINER_NAME = "nouva-alloy";
export const ALLOY_HTTP_HOST = "127.0.0.1";
export const ALLOY_HTTP_PORT = 12345;
export const ALLOY_CONFIG_HASH_LABEL = "nouva.alloy.config-sha";
export const ALLOY_CONFIG_LAYOUT_LABEL = "nouva.alloy.config-layout";
export const ALLOY_ROLE_LABEL = "nouva.alloy.role";
export const ALLOY_VALIDATION_CONTAINER_NAME = "nouva-alloy-config-validation";
export const ALLOY_CONFIG_LAYOUT_VERSION = "static-dynamic-v1";
export const DEFAULT_SYSTEM_REDACTION_CONTEXT_VERSION = "unversioned-v1";

const AGENT_DATA_DIR_IN_CONTAINER = "/var/lib/nouva-agent";
const ALLOY_ROOT_DIR_IN_CONTAINER = `${AGENT_DATA_DIR_IN_CONTAINER}/alloy`;
const ALLOY_CONFIG_DIR_IN_CONTAINER = `${ALLOY_ROOT_DIR_IN_CONTAINER}/config`;
const ALLOY_CANDIDATE_CONFIG_DIR_IN_CONTAINER = `${ALLOY_ROOT_DIR_IN_CONTAINER}/config.candidate`;
const ALLOY_DATA_DIR_IN_CONTAINER = `${ALLOY_ROOT_DIR_IN_CONTAINER}/data`;
const ALLOY_DYNAMIC_CONFIG_FILE_NAME = "redaction-context.alloy";
const ALLOY_STATIC_CONFIG_FILE_NAME = "static.alloy";
const ALLOY_PROBE_TIMEOUT_MS = 5_000;
// cAdvisor dials a new containerd client, and never closes it, every time it starts watching a
// container on a Docker host that uses the containerd image store (#329). No exporter argument
// avoids that path without also losing every container metric, so the collector is bounded
// instead: a leak ends in an Alloy restart, not in memory taken from the customer's workloads.
// There is deliberately no GOMEMLIMIT under it. Leaked memory is live, so a soft limit cannot
// reclaim it: past that limit the runtime would collect back to back for the days the leak takes
// to reach the hard limit, burning CPU the whole time, instead of simply restarting. Alloy does not
// derive one from this limit either: the host /sys mount hides the container's cgroup from it.
const ALLOY_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const DOCKER_SOCKET = "/var/run/docker.sock";
const OBSERVABILITY_NONE_LABEL_VALUE = "__none__";
const OBSERVABILITY_DOCKER_LABELS = {
  managed: "__meta_docker_container_label_nouva_managed",
  kind: "__meta_docker_container_label_nouva_kind",
  projectId: "__meta_docker_container_label_nouva_project_id",
  serviceId: "__meta_docker_container_label_nouva_service_id",
  deploymentId: "__meta_docker_container_label_nouva_deployment_id",
  serviceVariant: "__meta_docker_container_label_nouva_service_variant",
  environmentId: "__meta_docker_container_label_nouva_environment_id",
  replicaIndex: "__meta_docker_container_label_nouva_replica_index",
  scheduleId: "__meta_docker_container_label_nouva_schedule_id",
  scheduleRunId: "__meta_docker_container_label_nouva_schedule_run_id",
  redactionContextVersion: `__meta_docker_container_label_${REDACTION_CONTEXT_VERSION_DOCKER_LABEL.replaceAll(
    ".",
    "_"
  )}`,
  containerName: "__meta_docker_container_name",
} as const;

export interface AlloyRuntimePaths {
  rootDir: string;
  dataDir: string;
  configDir: string;
  dynamicConfigPath: string;
  staticConfigPath: string;
  candidateConfigDir: string;
  candidateDynamicConfigPath: string;
  candidateStaticConfigPath: string;
}

export interface AlloyRuntimeInput {
  dataDir: string;
  dataVolume: string;
  serverId: string;
  apiUrl: string;
  agentToken: string;
  redactionContextVersion?: string;
  /**
   * Expected version per active deployment or database scope. Rendered as relabel rules that
   * override the container label, so a container whose label went stale keeps being accepted.
   */
  redactionContextScopeVersions?: readonly AgentRedactionContextScopeVersion[];
  config: AgentRuntimeConfig;
}

export interface AlloyRuntimeDeps {
  paths?: AlloyRuntimePaths;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
  reloadTimeoutMs?: number;
}

interface ReconcileAlloyRuntimeOptions {
  paths?: AlloyRuntimePaths;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
  reloadTimeoutMs?: number;
}

interface CollectAlloyValidationChecksOptions {
  paths?: AlloyRuntimePaths;
  fetchImpl?: typeof fetch;
  statfsImpl?: (path: string) => Promise<{
    bavail: bigint | number;
    blocks: bigint | number;
    bsize: bigint | number;
  }>;
}

interface AlloyProbeResult {
  configPresent: boolean;
  healthOk: boolean;
  imagePresent: boolean;
  inspection: DockerContainerInspection | null;
}

type AlloyRuntimeDocker = Pick<
  DockerApiClient,
  | "containerLogs"
  | "createContainer"
  | "ensureContainer"
  | "ensureNetwork"
  | "inspectContainer"
  | "inspectImage"
  | "pullImage"
  | "removeContainer"
  | "startContainer"
  | "waitContainer"
>;

interface PendingAlloyReconcile {
  deps: AlloyRuntimeDeps;
  docker: AlloyRuntimeDocker;
  input: AlloyRuntimeInput;
}

let lastAlloyRuntimeFailure: Error | null = null;
let pendingAlloyReconcile: PendingAlloyReconcile | null = null;
let alloyReconcileDrain: Promise<void> | null = null;

function buildCheck(
  key: string,
  label: string,
  status: ServerCheckStatus,
  message: string,
  value: string | null = null
): ServerValidationCheck {
  return { key, label, status, message, value };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function list(values: string[]): string {
  return `[${values.map((value) => quote(value)).join(", ")}]`;
}

const REDACTION_CONTEXT_VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const REDACTION_CONTEXT_SCOPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function resolveSystemRedactionContextVersion(input: AlloyRuntimeInput): string {
  const version = input.redactionContextVersion?.trim() || DEFAULT_SYSTEM_REDACTION_CONTEXT_VERSION;
  if (!REDACTION_CONTEXT_VERSION_PATTERN.test(version)) {
    throw new Error("Alloy redaction context version is invalid.");
  }
  return version;
}

/**
 * Validates, de-duplicates, and orders the per-scope versions so the rendered config is
 * deterministic and every value is safe to embed in an Alloy regex or string literal.
 */
export function normalizeRedactionContextScopeVersions(
  values: readonly AgentRedactionContextScopeVersion[] | undefined
): AgentRedactionContextScopeVersion[] {
  const byScope = new Map<string, AgentRedactionContextScopeVersion>();
  for (const value of values ?? []) {
    if (value.kind !== "deployment" && value.kind !== "database") {
      throw new Error("Alloy redaction context scope kind is invalid.");
    }
    // The none sentinel is the deployment_id every database container carries, so a rule keyed
    // on it would rewrite every database stream on the server.
    if (
      !REDACTION_CONTEXT_SCOPE_ID_PATTERN.test(value.id) ||
      value.id === OBSERVABILITY_NONE_LABEL_VALUE
    ) {
      throw new Error("Alloy redaction context scope id is invalid.");
    }
    if (!REDACTION_CONTEXT_VERSION_PATTERN.test(value.version)) {
      throw new Error("Alloy redaction context scope version is invalid.");
    }
    const key = `${value.kind}:${value.id}`;
    const existing = byScope.get(key);
    if (existing && existing.version !== value.version) {
      throw new Error("Alloy redaction context scope has conflicting versions.");
    }
    byScope.set(key, { kind: value.kind, id: value.id, version: value.version });
  }
  return [...byScope.values()].sort((left, right) =>
    left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind.localeCompare(right.kind)
  );
}

export function redactionContextScopeVersionsEqual(
  left: readonly AgentRedactionContextScopeVersion[] | undefined,
  right: readonly AgentRedactionContextScopeVersion[] | undefined
): boolean {
  return (
    JSON.stringify(normalizeRedactionContextScopeVersions(left)) ===
    JSON.stringify(normalizeRedactionContextScopeVersions(right))
  );
}

function renderRedactionContextScopeRules(input: AlloyRuntimeInput): string[] {
  return normalizeRedactionContextScopeVersions(input.redactionContextScopeVersions).map((scope) =>
    scope.kind === "deployment"
      ? `  rule {
    source_labels = ["deployment_id"]
    regex         = ${quote(scope.id)}
    target_label  = "redaction_context_version"
    replacement   = ${quote(scope.version)}
  }`
      : `  rule {
    source_labels = ["service_type", "service_id"]
    separator     = ";"
    regex         = ${quote(`database;${scope.id}`)}
    target_label  = "redaction_context_version"
    replacement   = ${quote(scope.version)}
  }`
  );
}

async function writeManagedFile(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, contents, "utf8");
  await rename(tempPath, filePath);
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

function hasRequiredBinds(inspection: DockerContainerInspection | null): boolean {
  const binds = inspection?.HostConfig?.Binds ?? [];
  const requiredPrefixes = [
    `${DOCKER_SOCKET}:${DOCKER_SOCKET}`,
    `/:/rootfs:ro`,
    `/sys:/sys:ro`,
    `/var/run:/var/run:ro`,
    `/var/lib/docker:/var/lib/docker:ro`,
    `:/var/lib/nouva-agent`,
  ];

  return requiredPrefixes.every((prefix) =>
    prefix.startsWith(":")
      ? binds.some((bind) => bind.endsWith(prefix.slice(1)))
      : binds.some((bind) => bind.startsWith(prefix))
  );
}

function resolveAlloyDataVolume(
  inspection: DockerContainerInspection | null,
  fallback: string
): string {
  const existingBind = inspection?.HostConfig?.Binds?.find((bind) =>
    bind.split(":").slice(1).join(":").startsWith(AGENT_DATA_DIR_IN_CONTAINER)
  );
  const source = existingBind?.split(":")[0]?.trim();
  return source || fallback;
}

function getAlloyRunArguments(): string[] {
  return [
    "run",
    "--stability.level=experimental",
    `--server.http.listen-addr=0.0.0.0:${ALLOY_HTTP_PORT}`,
    `--storage.path=${ALLOY_DATA_DIR_IN_CONTAINER}`,
    ALLOY_CONFIG_DIR_IN_CONTAINER,
  ];
}

function hasExpectedRunArguments(inspection: DockerContainerInspection | null): boolean {
  return JSON.stringify(inspection?.Config?.Cmd ?? []) === JSON.stringify(getAlloyRunArguments());
}

// A collector created without this limit, or with another one, is recreated once. Only Memory is
// compared: Docker stores MemorySwap as -1 on hosts without swap accounting. On a host whose kernel
// cannot enforce a memory limit at all, Docker stores the request as Memory 0 with MemorySwap -1
// (a container created with no limit reads 0 and 0), and that pair is accepted so such a host does
// not recreate the collector on every reconcile.
function hasMemoryBound(inspection: DockerContainerInspection | null): boolean {
  const memory = inspection?.HostConfig?.Memory;
  const discardedByDocker = memory === 0 && inspection?.HostConfig?.MemorySwap === -1;
  return memory === ALLOY_MEMORY_LIMIT_BYTES || discardedByDocker;
}

function isAlloyContainerCurrent(
  inspection: DockerContainerInspection | null,
  input: AlloyRuntimeInput,
  stateHash: string
): boolean {
  return (
    inspection?.State?.Running === true &&
    inspection.Config?.Image === input.config.observability.alloyImage &&
    inspection.Config?.Labels?.[ALLOY_CONFIG_HASH_LABEL] === stateHash &&
    inspection.Config.Labels[ALLOY_CONFIG_LAYOUT_LABEL] === ALLOY_CONFIG_LAYOUT_VERSION &&
    hasExpectedRunArguments(inspection) &&
    hasMemoryBound(inspection) &&
    hasManagedContainerLogConfig(inspection) &&
    hasPortBinding(inspection, `${ALLOY_HTTP_PORT}/tcp`, {
      hostIp: ALLOY_HTTP_HOST,
      hostPort: String(ALLOY_HTTP_PORT),
    }) &&
    hasRequiredBinds(inspection)
  );
}

async function probeAlloyRuntime(
  docker: Pick<DockerApiClient, "inspectContainer" | "inspectImage">,
  paths: AlloyRuntimePaths,
  input: AlloyRuntimeInput,
  fetchImpl: typeof fetch
): Promise<AlloyProbeResult> {
  const [inspection, image, configPresent] = await Promise.all([
    docker.inspectContainer(ALLOY_CONTAINER_NAME),
    docker.inspectImage(input.config.observability.alloyImage),
    Promise.all([
      access(paths.staticConfigPath, fsConstants.R_OK),
      access(paths.dynamicConfigPath, fsConstants.R_OK),
    ])
      .then(() => true)
      .catch(() => false),
  ]);

  let healthOk = false;
  if (inspection?.State?.Running) {
    try {
      const response = await fetchImpl(`http://${ALLOY_HTTP_HOST}:${ALLOY_HTTP_PORT}/metrics`, {
        signal: AbortSignal.timeout(ALLOY_PROBE_TIMEOUT_MS),
      });
      healthOk = response.ok;
    } catch {
      healthOk = false;
    }
  }

  return {
    configPresent,
    healthOk,
    imagePresent: image !== null,
    inspection,
  };
}

async function waitForAlloyHealth(
  docker: Pick<DockerApiClient, "inspectContainer" | "inspectImage">,
  input: AlloyRuntimeInput,
  paths: AlloyRuntimePaths,
  options: {
    fetchImpl: typeof fetch;
    timeoutMs: number;
    intervalMs: number;
  }
): Promise<void> {
  const startedAt = Date.now();
  let lastError = "Alloy runtime did not become healthy";

  while (Date.now() - startedAt < options.timeoutMs) {
    const probe = await probeAlloyRuntime(docker, paths, input, options.fetchImpl);

    if (!probe.inspection?.State?.Running) {
      lastError = "Alloy container is not running";
    } else if (!probe.configPresent) {
      lastError = "Alloy config file is missing";
    } else if (!probe.imagePresent) {
      lastError = "Alloy image is not present locally";
    } else if (!probe.healthOk) {
      lastError = `Alloy metrics endpoint is not reachable on ${ALLOY_HTTP_HOST}:${ALLOY_HTTP_PORT}`;
    } else {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }

  throw new Error(lastError);
}

function buildRelabelRules(input: AlloyRuntimeInput): string[] {
  const noneValue = quote(
    input.config.observability.noneLabelValue || OBSERVABILITY_NONE_LABEL_VALUE
  );
  const organizationId = quote(
    input.config.observability.organizationId ?? OBSERVABILITY_NONE_LABEL_VALUE
  );
  const serverId = quote(input.serverId);

  return [
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.managed)}]
    action        = "keep"
    regex         = "true"
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.kind)}]
    action        = "keep"
    regex         = "app|database|traefik|worker|worker_job"
  }`,
    `  rule {
    target_label = "organization_id"
    replacement  = ${organizationId}
  }`,
    `  rule {
    target_label = "server_id"
    replacement  = ${serverId}
  }`,
    `  rule {
    target_label = "project_id"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.projectId)}]
    target_label  = "project_id"
    regex         = "(.+)"
    replacement   = "$1"
  }`,
    `  rule {
    target_label = "service_id"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.serviceId)}]
    target_label  = "service_id"
    regex         = "(.+)"
    replacement   = "$1"
  }`,
    `  rule {
    target_label = "deployment_id"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.deploymentId)}]
    target_label  = "deployment_id"
    regex         = "(.+)"
    replacement   = "$1"
  }`,
    `  rule {
    target_label = "environment_id"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.environmentId)}]
    target_label  = "environment_id"
    regex         = "(.+)"
    replacement   = "$1"
  }`,
    `  rule {
    target_label = "replica_index"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.replicaIndex)}]
    target_label  = "replica_index"
    regex         = "(.+)"
    replacement   = "$1"
  }`,
    `  rule {
    target_label = "schedule_id"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.scheduleId)}]
    target_label  = "schedule_id"
    regex         = "(.+)"
    replacement   = "$1"
  }`,
    `  rule {
    target_label = "schedule_run_id"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.scheduleRunId)}]
    target_label  = "schedule_run_id"
    regex         = "(.+)"
    replacement   = "$1"
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.redactionContextVersion)}]
    target_label  = "redaction_context_version"
    regex         = "(.+)"
    replacement   = "$1"
  }`,
    `  rule {
    target_label = "service_type"
    replacement  = "system"
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.kind)}]
    target_label  = "service_type"
    regex         = "app"
    replacement   = "app"
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.kind)}]
    target_label  = "service_type"
    regex         = "database"
    replacement   = "database"
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.kind)}]
    target_label  = "service_type"
    regex         = "worker|worker_job"
    replacement   = "worker"
  }`,
    `  rule {
    target_label = "service_variant"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.kind)}]
    target_label  = "service_variant"
    regex         = "app"
    replacement   = "app"
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.kind)}]
    target_label  = "service_variant"
    regex         = "traefik"
    replacement   = "traefik"
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.serviceVariant)}]
    target_label  = "service_variant"
    regex         = "(.+)"
    replacement   = "$1"
  }`,
    `  rule {
    target_label = "container_name"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.containerName)}]
    target_label  = "container_name"
    regex         = "/?(.*)"
    replacement   = "$1"
  }`,
    `  rule {
    target_label = "runtime_kind"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.kind)}]
    target_label  = "runtime_kind"
    regex         = "(.+)"
    replacement   = "$1"
  }`,
  ];
}

export function getAlloyRuntimePaths(dataDir: string): AlloyRuntimePaths {
  const rootDir = path.join(dataDir, "alloy");
  const configDir = path.join(rootDir, "config");
  const candidateConfigDir = path.join(rootDir, "config.candidate");
  return {
    rootDir,
    dataDir: path.join(rootDir, "data"),
    configDir,
    dynamicConfigPath: path.join(configDir, ALLOY_DYNAMIC_CONFIG_FILE_NAME),
    staticConfigPath: path.join(configDir, ALLOY_STATIC_CONFIG_FILE_NAME),
    candidateConfigDir,
    candidateDynamicConfigPath: path.join(candidateConfigDir, ALLOY_DYNAMIC_CONFIG_FILE_NAME),
    candidateStaticConfigPath: path.join(candidateConfigDir, ALLOY_STATIC_CONFIG_FILE_NAME),
  };
}

export async function ensureAlloyState(paths: AlloyRuntimePaths): Promise<void> {
  await mkdir(paths.rootDir, { recursive: true });
  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(paths.configDir, { recursive: true });
}

export function renderAlloyStaticConfig(input: AlloyRuntimeInput): string {
  if (!input.config.observability.organizationId) {
    throw new Error("Alloy observability config requires an organization ID.");
  }

  const scrapeIntervalSeconds = Math.max(5, input.config.observability.scrapeIntervalSeconds || 30);
  // Keep schedule run IDs in Mimir as well as Loki so run-scoped metrics match
  // run-scoped logs. This deliberately trades additional cardinality for that view.
  const allowlistedLabels = list([
    "nouva.managed",
    "nouva.server.id",
    "nouva.project.id",
    "nouva.service.id",
    "nouva.deployment.id",
    "nouva.service.variant",
    "nouva.environment.id",
    "nouva.kind",
    "nouva.replica.index",
    "nouva.schedule.id",
    "nouva.schedule.run.id",
    REDACTION_CONTEXT_VERSION_DOCKER_LABEL,
  ]);
  const dockerRules = buildRelabelRules(input);
  const noneValue = quote(
    input.config.observability.noneLabelValue || OBSERVABILITY_NONE_LABEL_VALUE
  );
  const organizationId = quote(input.config.observability.organizationId);
  const serverId = quote(input.serverId);

  return [
    `discovery.docker "nouva" {
  host = ${quote(`unix://${DOCKER_SOCKET}`)}
}`,
    `discovery.relabel "nouva_logs" {
  targets = discovery.docker.nouva.targets
${dockerRules.join("\n")}
}`,
    `loki.source.docker "nouva" {
  host       = ${quote(`unix://${DOCKER_SOCKET}`)}
  targets    = discovery.relabel.nouva_logs.output
  forward_to = [loki.relabel.nouva_redaction_context.receiver]
}`,
    `loki.write "nouva" {
  endpoint {
    url                 = ${quote(`${input.apiUrl}/api/agent/observability/logs`)}
    bearer_token        = ${quote(input.agentToken)}
    remote_timeout      = "10s"
    min_backoff_period  = "1s"
    max_backoff_period  = "1m"
    max_backoff_retries = 1200
    retry_on_http_429   = true

    queue_config {
      capacity          = "64MiB"
      min_shards        = 1
      block_on_overflow = true
      drain_timeout     = "1m"
    }
  }

  wal {
    enabled         = true
    max_segment_age = "24h"
    drain_timeout   = "1m"
  }
}`,
    // Only the groups behind the API's service metrics: cpu, memory, network and block I/O
    // (diskIO); container_start_time_seconds and container_last_seen are exported regardless.
    // Leaving out the disk usage group also stops a filesystem walk per container.
    // containerd_host stays at its default: on hosts using Docker's containerd image store,
    // cAdvisor needs that socket to watch a Docker container at all.
    `prometheus.exporter.cadvisor "nouva" {
  docker_host                  = ${quote(`unix://${DOCKER_SOCKET}`)}
  docker_only                  = true
  store_container_labels       = false
  disable_root_cgroup_stats    = true
  enabled_metrics              = ${list(["cpu", "memory", "network", "diskIO"])}
  allowlisted_container_labels = ${allowlistedLabels}
}`,
    `prometheus.scrape "nouva_cadvisor" {
  targets         = prometheus.exporter.cadvisor.nouva.targets
  scrape_interval = ${quote(`${scrapeIntervalSeconds}s`)}
  forward_to      = [prometheus.relabel.nouva_cadvisor.receiver]
}`,
    `prometheus.relabel "nouva_cadvisor" {
  forward_to = [prometheus.relabel.nouva_redaction_context.receiver]

  rule {
    source_labels = ["container_label_nouva_managed"]
    action        = "keep"
    regex         = "true"
  }

  rule {
    source_labels = ["container_label_nouva_kind"]
    action        = "keep"
    regex         = "app|database|traefik|worker|worker_job"
  }

  rule {
    target_label = "organization_id"
    replacement  = ${organizationId}
  }

  rule {
    target_label = "server_id"
    replacement  = ${serverId}
  }

  rule {
    target_label = "project_id"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["container_label_nouva_project_id"]
    target_label  = "project_id"
    regex         = "(.+)"
    replacement   = "$1"
  }

  rule {
    target_label = "service_id"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["container_label_nouva_service_id"]
    target_label  = "service_id"
    regex         = "(.+)"
    replacement   = "$1"
  }

  rule {
    target_label = "deployment_id"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["container_label_nouva_deployment_id"]
    target_label  = "deployment_id"
    regex         = "(.+)"
    replacement   = "$1"
  }

  rule {
    target_label = "environment_id"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["container_label_nouva_environment_id"]
    target_label  = "environment_id"
    regex         = "(.+)"
    replacement   = "$1"
  }

  rule {
    target_label = "replica_index"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["container_label_nouva_replica_index"]
    target_label  = "replica_index"
    regex         = "(.+)"
    replacement   = "$1"
  }

  rule {
    target_label = "schedule_id"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["container_label_nouva_schedule_id"]
    target_label  = "schedule_id"
    regex         = "(.+)"
    replacement   = "$1"
  }

  rule {
    target_label = "schedule_run_id"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["container_label_nouva_schedule_run_id"]
    target_label  = "schedule_run_id"
    regex         = "(.+)"
    replacement   = "$1"
  }

  rule {
    source_labels = ["container_label_nouva_redaction_context_version"]
    target_label  = "redaction_context_version"
    regex         = "(.+)"
    replacement   = "$1"
  }

  rule {
    target_label = "service_type"
    replacement  = "system"
  }

  rule {
    source_labels = ["container_label_nouva_kind"]
    target_label  = "service_type"
    regex         = "app"
    replacement   = "app"
  }

  rule {
    source_labels = ["container_label_nouva_kind"]
    target_label  = "service_type"
    regex         = "database"
    replacement   = "database"
  }

  rule {
    source_labels = ["container_label_nouva_kind"]
    target_label  = "service_type"
    regex         = "worker|worker_job"
    replacement   = "worker"
  }

  rule {
    target_label = "service_variant"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["container_label_nouva_kind"]
    target_label  = "service_variant"
    regex         = "app"
    replacement   = "app"
  }

  rule {
    source_labels = ["container_label_nouva_kind"]
    target_label  = "service_variant"
    regex         = "traefik"
    replacement   = "traefik"
  }

  rule {
    source_labels = ["container_label_nouva_service_variant"]
    target_label  = "service_variant"
    regex         = "(.+)"
    replacement   = "$1"
  }

  rule {
    target_label = "container_name"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["name"]
    target_label  = "container_name"
    regex         = "/?(.*)"
    replacement   = "$1"
  }

  rule {
    target_label = "runtime_kind"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["container_label_nouva_kind"]
    target_label  = "runtime_kind"
    regex         = "(.+)"
    replacement   = "$1"
  }

  rule {
    action = "labeldrop"
    regex  = "container_label_.*|instance|job|id|name|image|container"
  }
}`,
    // Traefik publishes request counters on its admin entrypoint, which is bound to the host
    // loopback only. Alloy reaches it container-to-container over the ingress network instead,
    // so nothing new is exposed on the host (#137).
    `prometheus.scrape "nouva_traefik" {
  targets         = [{ __address__ = ${quote(`${TRAEFIK_CONTAINER_NAME}:${TRAEFIK_ADMIN_PORT}`)} }]
  scrape_interval = ${quote(`${scrapeIntervalSeconds}s`)}
  forward_to      = [prometheus.relabel.nouva_traefik.receiver]
}`,
    `prometheus.relabel "nouva_traefik" {
  forward_to = [prometheus.relabel.nouva_redaction_context.receiver]

  rule {
    source_labels = ["__name__"]
    action        = "keep"
    regex         = "traefik_service_requests_total"
  }

  // A request counter belongs to a route, not to a container. Traefik is a system container and
  // these are its metrics, so the series stays in the system scope exactly like the rest of
  // Traefik's telemetry, and the routed service travels in a separate, non-authoritative label.
  // Putting it in service_id instead would make an unowned series look like a service's own.
  rule {
    target_label = "organization_id"
    replacement  = ${organizationId}
  }

  rule {
    target_label = "server_id"
    replacement  = ${serverId}
  }

  rule {
    target_label = "project_id"
    replacement  = ${noneValue}
  }

  rule {
    target_label = "service_id"
    replacement  = ${noneValue}
  }

  rule {
    target_label = "deployment_id"
    replacement  = ${noneValue}
  }

  rule {
    target_label = "environment_id"
    replacement  = ${noneValue}
  }

  rule {
    target_label = "replica_index"
    replacement  = ${noneValue}
  }

  rule {
    target_label = "schedule_id"
    replacement  = ${noneValue}
  }

  rule {
    target_label = "schedule_run_id"
    replacement  = ${noneValue}
  }

  rule {
    target_label = "service_type"
    replacement  = "system"
  }

  rule {
    target_label = "service_variant"
    replacement  = "traefik"
  }

  rule {
    target_label = "container_name"
    replacement  = ${quote(TRAEFIK_CONTAINER_NAME)}
  }

  rule {
    target_label = "runtime_kind"
    replacement  = "traefik"
  }

  rule {
    target_label = "ingress_service_id"
    replacement  = ${noneValue}
  }

  // Route files are named by service id and the renderer names the load balancer svc-<serviceId>,
  // so Traefik's own service label carries the id the dashboard queries by.
  rule {
    source_labels = ["service"]
    target_label  = "ingress_service_id"
    regex         = "svc-(.+)@file"
    replacement   = "$1"
  }

  // Traefik's api, dashboard and ping endpoints are @internal, never match the rule above, and
  // keep the none placeholder. They are not a service's traffic, so they are not shipped.
  rule {
    source_labels = ["ingress_service_id"]
    action        = "drop"
    regex         = ${noneValue}
  }

  // Traefik's own service label would otherwise reach Mimir as a second copy of the id.
  rule {
    action = "labeldrop"
    regex  = "instance|job|service"
  }
}`,
    // Only the collectors behind the API's server metrics; node_boot_time_seconds comes from stat.
    `prometheus.exporter.unix "nouva" {
  rootfs_path    = ${quote("/rootfs")}
  procfs_path    = ${quote("/rootfs/proc")}
  sysfs_path     = ${quote("/rootfs/sys")}
  set_collectors = ${list(["cpu", "diskstats", "filesystem", "loadavg", "meminfo", "netdev", "stat", "uname"])}
}`,
    `prometheus.scrape "nouva_host" {
  targets         = prometheus.exporter.unix.nouva.targets
  scrape_interval = ${quote(`${scrapeIntervalSeconds}s`)}
  forward_to      = [prometheus.relabel.nouva_host.receiver]
}`,
    `prometheus.relabel "nouva_host" {
  forward_to = [prometheus.relabel.nouva_redaction_context.receiver]

  rule {
    target_label = "organization_id"
    replacement  = ${organizationId}
  }

  rule {
    target_label = "server_id"
    replacement  = ${serverId}
  }

  rule {
    target_label = "project_id"
    replacement  = ${noneValue}
  }

  rule {
    target_label = "service_id"
    replacement  = ${noneValue}
  }

  rule {
    target_label = "deployment_id"
    replacement  = ${noneValue}
  }

  rule {
    target_label = "service_type"
    replacement  = "system"
  }

  rule {
    target_label = "service_variant"
    replacement  = "host"
  }

  rule {
    target_label = "environment_id"
    replacement  = ${noneValue}
  }

  rule {
    target_label = "container_name"
    replacement  = "host"
  }

  rule {
    target_label = "runtime_kind"
    replacement  = "host"
  }

  rule {
    action = "labeldrop"
    regex  = "instance|job"
  }
}`,
    `prometheus.remote_write "nouva" {
  endpoint {
    url          = ${quote(`${input.apiUrl}/api/agent/observability/metrics`)}
    bearer_token = ${quote(input.agentToken)}

    metadata_config {
      send = false
    }
  }
}`,
    "",
  ].join("\n\n");
}

export function renderAlloyDynamicConfig(input: AlloyRuntimeInput): string {
  const version = quote(resolveSystemRedactionContextVersion(input));
  const systemRule = `  rule {
    source_labels = ["service_type", "redaction_context_version"]
    separator     = ";"
    target_label  = "redaction_context_version"
    regex         = "system;$"
    replacement   = ${version}
  }`;
  const rules = [systemRule, ...renderRedactionContextScopeRules(input)].join("\n\n");
  return [
    `loki.relabel "nouva_redaction_context" {
  forward_to = [loki.write.nouva.receiver]

${rules}
}`,
    `prometheus.relabel "nouva_redaction_context" {
  forward_to = [prometheus.remote_write.nouva.receiver]

${rules}
}`,
    "",
  ].join("\n\n");
}

export function createAlloyStateHash(configContents: string): string {
  return createHash("sha256").update(configContents).digest("hex");
}

export function buildAlloyContainerSpec(
  input: AlloyRuntimeInput,
  options: {
    stateHash: string;
    labels?: Record<string, string>;
  }
): DockerContainerSpec {
  return {
    name: ALLOY_CONTAINER_NAME,
    image: input.config.observability.alloyImage,
    cmd: getAlloyRunArguments(),
    labels: {
      "nouva.managed": "true",
      "nouva.kind": "observability",
      "nouva.server.id": input.serverId,
      [ALLOY_ROLE_LABEL]: "collector",
      [ALLOY_CONFIG_HASH_LABEL]: options.stateHash,
      [ALLOY_CONFIG_LAYOUT_LABEL]: ALLOY_CONFIG_LAYOUT_VERSION,
      ...(options.labels ?? {}),
    },
    exposedPorts: {
      [`${ALLOY_HTTP_PORT}/tcp`]: {},
    },
    hostConfig: {
      PortBindings: {
        [`${ALLOY_HTTP_PORT}/tcp`]: [
          {
            HostIp: ALLOY_HTTP_HOST,
            HostPort: String(ALLOY_HTTP_PORT),
          },
        ],
      },
      Binds: [
        `${DOCKER_SOCKET}:${DOCKER_SOCKET}`,
        `/:/rootfs:ro`,
        `/sys:/sys:ro`,
        `/var/run:/var/run:ro`,
        `/var/lib/docker:/var/lib/docker:ro`,
        `${input.dataVolume}:${AGENT_DATA_DIR_IN_CONTAINER}`,
      ],
      RestartPolicy: {
        Name: "unless-stopped",
      },
      LogConfig: MANAGED_CONTAINER_LOG_CONFIG,
      Privileged: true,
      Memory: ALLOY_MEMORY_LIMIT_BYTES,
      // Equal to Memory: no swap allowance, so the bound is not stretched into host swap.
      MemorySwap: ALLOY_MEMORY_LIMIT_BYTES,
    },
    // Traefik's admin entrypoint is bound to the host loopback only, so the scrape has to happen
    // container-to-container. Joining the ingress network reaches `nouva-traefik:8082` on the
    // in-container listener without opening anything new on the host (#137).
    networkingConfig: {
      EndpointsConfig: {
        [input.config.localTraefikNetwork]: {},
      },
    },
  };
}

export function buildAlloyValidationContainerSpec(input: AlloyRuntimeInput): DockerContainerSpec {
  return {
    name: ALLOY_VALIDATION_CONTAINER_NAME,
    image: input.config.observability.alloyImage,
    cmd: ["validate", "--stability.level=experimental", ALLOY_CANDIDATE_CONFIG_DIR_IN_CONTAINER],
    hostConfig: {
      Binds: [`${input.dataVolume}:${AGENT_DATA_DIR_IN_CONTAINER}:ro`],
      NetworkMode: "none",
    },
  };
}

async function validateAlloyConfig(
  docker: Pick<
    DockerApiClient,
    | "containerLogs"
    | "createContainer"
    | "pullImage"
    | "removeContainer"
    | "startContainer"
    | "waitContainer"
  >,
  input: AlloyRuntimeInput,
  options: { pullImage: boolean }
): Promise<void> {
  if (options.pullImage) {
    await docker.pullImage(input.config.observability.alloyImage);
  }
  await docker.removeContainer(ALLOY_VALIDATION_CONTAINER_NAME, true);

  const containerId = await docker.createContainer(buildAlloyValidationContainerSpec(input));
  try {
    await docker.startContainer(containerId);
    const status = await docker.waitContainer(containerId, 30_000);
    if (status !== 0) {
      const logs = await docker.containerLogs(containerId);
      const safeLogs = logs
        ? redactSensitiveText(logs, {
            NOUVA_AGENT_TOKEN: input.agentToken,
            NOUVA_REDACTION_CONTEXT_VERSION: resolveSystemRedactionContextVersion(input),
          }).slice(0, 2_048)
        : "";
      throw new Error(`Alloy configuration validation failed${safeLogs ? `: ${safeLogs}` : ""}`);
    }
  } finally {
    await docker.removeContainer(ALLOY_VALIDATION_CONTAINER_NAME, true);
  }
}

async function readManagedFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function writeAlloyCandidateConfig(
  paths: AlloyRuntimePaths,
  staticContents: string,
  dynamicContents: string
): Promise<void> {
  await rm(paths.candidateConfigDir, { recursive: true, force: true });
  await writeManagedFile(paths.candidateStaticConfigPath, staticContents);
  await writeManagedFile(paths.candidateDynamicConfigPath, dynamicContents);
}

async function reloadAlloyConfig(fetchImpl: typeof fetch, timeoutMs: number): Promise<void> {
  const response = await fetchImpl(`http://${ALLOY_HTTP_HOST}:${ALLOY_HTTP_PORT}/-/reload`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Alloy configuration reload failed with status ${response.status}`);
  }
}

async function replaceAlloyDynamicConfig(
  docker: Pick<DockerApiClient, "inspectContainer" | "inspectImage">,
  input: AlloyRuntimeInput,
  paths: AlloyRuntimePaths,
  dynamicContents: string,
  options: {
    fetchImpl: typeof fetch;
    reloadTimeoutMs: number;
    readinessTimeoutMs: number;
    intervalMs: number;
  }
): Promise<void> {
  const previousContents = await readManagedFile(paths.dynamicConfigPath);
  const nextPath = `${paths.dynamicConfigPath}.next`;
  await writeManagedFile(nextPath, dynamicContents);
  await rename(nextPath, paths.dynamicConfigPath);

  try {
    await reloadAlloyConfig(options.fetchImpl, options.reloadTimeoutMs);
    await waitForAlloyHealth(docker, input, paths, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.readinessTimeoutMs,
      intervalMs: options.intervalMs,
    });
  } catch (error) {
    if (previousContents === null) {
      await rm(paths.dynamicConfigPath, { force: true });
    } else {
      await writeManagedFile(paths.dynamicConfigPath, previousContents);
    }

    try {
      await reloadAlloyConfig(options.fetchImpl, options.reloadTimeoutMs);
      await waitForAlloyHealth(docker, input, paths, {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.readinessTimeoutMs,
        intervalMs: options.intervalMs,
      });
    } catch (rollbackError) {
      throw new Error(
        `Alloy configuration reload failed and rollback did not become healthy: ${
          rollbackError instanceof Error ? rollbackError.message : "unknown rollback failure"
        }`,
        { cause: error }
      );
    }

    throw new Error("Alloy configuration reload failed; the previous fragment was restored", {
      cause: error,
    });
  }
}

export async function reconcileAlloyRuntime(
  docker: AlloyRuntimeDocker,
  input: AlloyRuntimeInput,
  options: ReconcileAlloyRuntimeOptions = {}
): Promise<void> {
  if (!input.config.observability.enabled) {
    return;
  }

  if (!input.config.observability.organizationId) {
    throw new Error("Alloy runtime requires an organization ID.");
  }

  const paths = options.paths ?? getAlloyRuntimePaths(input.dataDir);
  await ensureAlloyState(paths);

  const inspection = await docker.inspectContainer(ALLOY_CONTAINER_NAME);
  const runtimeInput = {
    ...input,
    dataVolume: resolveAlloyDataVolume(inspection, input.dataVolume),
  };
  const staticContents = renderAlloyStaticConfig(runtimeInput);
  const dynamicContents = renderAlloyDynamicConfig(runtimeInput);
  const stateHash = createAlloyStateHash(staticContents);
  const [activeStaticContents, activeDynamicContents] = await Promise.all([
    readManagedFile(paths.staticConfigPath),
    readManagedFile(paths.dynamicConfigPath),
  ]);
  const staticRuntimeCurrent =
    activeStaticContents === staticContents &&
    isAlloyContainerCurrent(inspection, runtimeInput, stateHash);
  if (staticRuntimeCurrent && activeDynamicContents === dynamicContents) {
    lastAlloyRuntimeFailure = null;
    return;
  }

  await writeAlloyCandidateConfig(paths, staticContents, dynamicContents);
  try {
    const validationImagePresent = staticRuntimeCurrent
      ? await docker.inspectImage(runtimeInput.config.observability.alloyImage)
      : null;
    await validateAlloyConfig(docker, runtimeInput, {
      pullImage: !staticRuntimeCurrent || validationImagePresent === null,
    });
    if (staticRuntimeCurrent) {
      await replaceAlloyDynamicConfig(docker, runtimeInput, paths, dynamicContents, {
        fetchImpl: options.fetchImpl ?? fetch,
        reloadTimeoutMs: options.reloadTimeoutMs ?? 10_000,
        readinessTimeoutMs: options.timeoutMs ?? 30_000,
        intervalMs: options.intervalMs ?? 500,
      });
    } else {
      await writeManagedFile(paths.staticConfigPath, staticContents);
      await writeManagedFile(paths.dynamicConfigPath, dynamicContents);

      if (inspection) {
        await docker.removeContainer(ALLOY_CONTAINER_NAME, true);
      }

      // The container joins the ingress network at creation, so the network has to exist even
      // when the Traefik reconcile has not run yet on this boot. `ensureNetwork` is idempotent.
      await docker.ensureNetwork(runtimeInput.config.localTraefikNetwork);
      await docker.ensureContainer(buildAlloyContainerSpec(runtimeInput, { stateHash }), false, {
        pull: false,
      });
      await waitForAlloyHealth(docker, runtimeInput, paths, {
        fetchImpl: options.fetchImpl ?? fetch,
        timeoutMs: options.timeoutMs ?? 30_000,
        intervalMs: options.intervalMs ?? 500,
      });
      await rm(path.join(paths.rootDir, "config.alloy"), { force: true });
    }
  } finally {
    await rm(paths.candidateConfigDir, { recursive: true, force: true });
  }
  lastAlloyRuntimeFailure = null;
}

export async function ensureAlloyRuntime(
  docker: AlloyRuntimeDocker,
  input: AlloyRuntimeInput,
  deps: AlloyRuntimeDeps = {}
): Promise<void> {
  pendingAlloyReconcile = { deps, docker, input };
  if (!alloyReconcileDrain) {
    alloyReconcileDrain = (async () => {
      let latestFailure: Error | null = null;
      while (pendingAlloyReconcile) {
        const pending = pendingAlloyReconcile;
        pendingAlloyReconcile = null;
        try {
          await reconcileAlloyRuntime(pending.docker, pending.input, pending.deps);
          latestFailure = null;
        } catch (error) {
          latestFailure = error instanceof Error ? error : new Error("Alloy reconcile failed");
        }
      }

      lastAlloyRuntimeFailure = latestFailure;
      if (latestFailure) {
        throw latestFailure;
      }
    })().finally(() => {
      alloyReconcileDrain = null;
    });
  }

  await alloyReconcileDrain;
}

export async function collectAlloyValidationChecks(
  docker: Pick<DockerApiClient, "inspectContainer" | "inspectImage">,
  input: AlloyRuntimeInput,
  options: CollectAlloyValidationChecksOptions = {},
  bootstrapError?: Error | null
): Promise<ServerValidationCheck[]> {
  const paths = options.paths ?? getAlloyRuntimePaths(input.dataDir);
  const probe = await probeAlloyRuntime(docker, paths, input, options.fetchImpl ?? fetch);
  const checks: ServerValidationCheck[] = [];

  checks.push(
    buildCheck(
      "alloy-image",
      "Alloy image",
      probe.imagePresent ? "pass" : "fail",
      probe.imagePresent
        ? `Alloy image ${input.config.observability.alloyImage} is present locally`
        : `Expected ${input.config.observability.alloyImage}`,
      input.config.observability.alloyImage
    )
  );

  const containerStatus: ServerCheckStatus =
    probe.inspection?.State?.Running === true
      ? lastAlloyRuntimeFailure || bootstrapError
        ? "warn"
        : "pass"
      : "fail";
  const containerMessage =
    probe.inspection?.State?.Running === true
      ? lastAlloyRuntimeFailure
        ? `Alloy is running but the last reconcile failed: ${lastAlloyRuntimeFailure.message}`
        : bootstrapError
          ? `Alloy is running but reconcile failed: ${bootstrapError.message}`
          : "Alloy container is running"
      : "Alloy container is not running";

  checks.push(
    buildCheck(
      "alloy-container",
      "Alloy container",
      containerStatus,
      containerMessage,
      probe.inspection?.Name ?? null
    )
  );

  checks.push(
    buildCheck(
      "alloy-config",
      "Alloy config",
      probe.configPresent ? "pass" : "fail",
      probe.configPresent ? "Alloy config file is present" : "Alloy config file is missing",
      paths.configDir
    )
  );

  checks.push(
    buildCheck(
      "alloy-health",
      "Alloy health",
      probe.healthOk ? "pass" : "fail",
      probe.healthOk
        ? `Alloy metrics endpoint responds on ${ALLOY_HTTP_HOST}:${ALLOY_HTTP_PORT}`
        : `Alloy metrics endpoint is not reachable on ${ALLOY_HTTP_HOST}:${ALLOY_HTTP_PORT}`,
      `${ALLOY_HTTP_HOST}:${ALLOY_HTTP_PORT}`
    )
  );

  checks.push(
    buildCheck(
      "alloy-mounts",
      "Alloy mounts",
      hasRequiredBinds(probe.inspection) ? "pass" : "fail",
      hasRequiredBinds(probe.inspection)
        ? "Alloy container has the required host mounts"
        : "Alloy container is missing one or more required host mounts"
    )
  );

  try {
    const stats = await (options.statfsImpl ?? statfs)(paths.dataDir);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const safetyReserveBytes = calculateDiskSafetyReserveBytes(totalBytes);
    const status: ServerCheckStatus =
      availableBytes <= safetyReserveBytes
        ? "fail"
        : availableBytes < safetyReserveBytes * 2
          ? "warn"
          : "pass";
    checks.push(
      buildCheck(
        "alloy-wal-disk",
        "Alloy WAL disk headroom",
        status,
        status === "pass"
          ? `${formatStorageBytes(availableBytes)} is available for Alloy WAL and positions data.`
          : `${formatStorageBytes(availableBytes)} is available for Alloy WAL and positions data. The safety reserve is ${formatStorageBytes(safetyReserveBytes)}.`,
        JSON.stringify({ availableBytes, totalBytes })
      )
    );
  } catch {
    checks.push(
      buildCheck(
        "alloy-wal-disk",
        "Alloy WAL disk headroom",
        "fail",
        "Unable to inspect disk headroom for Alloy WAL and positions data."
      )
    );
  }

  return checks;
}

export function buildUnavailableAlloyChecks(reason: string): ServerValidationCheck[] {
  return [
    buildCheck("alloy-image", "Alloy image", "fail", reason),
    buildCheck("alloy-container", "Alloy container", "fail", reason),
    buildCheck("alloy-config", "Alloy config", "fail", reason),
    buildCheck(
      "alloy-health",
      "Alloy health",
      "fail",
      reason,
      `${ALLOY_HTTP_HOST}:${ALLOY_HTTP_PORT}`
    ),
    buildCheck("alloy-mounts", "Alloy mounts", "fail", reason),
    buildCheck("alloy-wal-disk", "Alloy WAL disk headroom", "fail", reason),
  ];
}

export function resetAlloyRuntimeState(): void {
  lastAlloyRuntimeFailure = null;
  pendingAlloyReconcile = null;
  alloyReconcileDrain = null;
}
