import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ALLOY_CONFIG_HASH_LABEL,
  ALLOY_CONFIG_LAYOUT_LABEL,
  ALLOY_CONFIG_LAYOUT_VERSION,
  ALLOY_CONTAINER_NAME,
  ALLOY_HTTP_HOST,
  ALLOY_HTTP_PORT,
  buildAlloyContainerSpec,
  buildAlloyValidationContainerSpec,
  collectAlloyValidationChecks,
  createAlloyStateHash,
  ensureAlloyRuntime,
  getAlloyRuntimePaths,
  normalizeRedactionContextScopeVersions,
  redactionContextScopeVersionsEqual,
  renderAlloyDynamicConfig,
  renderAlloyStaticConfig,
  resetAlloyRuntimeState,
} from "./alloy-runtime.js";
import type { DockerContainerInspection, DockerContainerSpec } from "./docker-api.js";
import type { AgentRuntimeConfig } from "./protocol.js";

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
    alloyObservability: true,
  },
  localRegistryHost: "127.0.0.1",
  localRegistryPort: 5000,
  localTraefikNetwork: "nouva-ingress",
  observability: {
    enabled: true,
    organizationId: "org_123",
    alloyImage: "grafana/alloy:v1.17.1",
    scrapeIntervalSeconds: 45,
    collectorScope: "services_traefik_and_workers",
    noneLabelValue: "__none__",
  },
};

function createAlloyInput(dataDir: string, redactionContextVersion = "context-v1") {
  return {
    dataDir,
    dataVolume: "nouva-agent-data",
    serverId: "srv_1",
    apiUrl: "https://api.nouva.sh",
    agentToken: "agent-token",
    redactionContextVersion,
    config: runtimeConfig,
  };
}

const EXPECTED_ALLOY_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

interface StoredMemoryLimit {
  Memory: number;
  MemorySwap: number;
}

const CURRENT_MEMORY_LIMIT: StoredMemoryLimit = {
  Memory: EXPECTED_ALLOY_MEMORY_LIMIT_BYTES,
  MemorySwap: EXPECTED_ALLOY_MEMORY_LIMIT_BYTES,
};

function createAlloyInspection(input: {
  image?: string;
  running?: boolean;
  stateHash?: string;
  binds?: string[];
  dataVolume?: string;
  logConfigCurrent?: boolean;
  memoryLimit?: StoredMemoryLimit;
}): DockerContainerInspection {
  return {
    Id: ALLOY_CONTAINER_NAME,
    Name: ALLOY_CONTAINER_NAME,
    State: {
      Running: input.running ?? true,
    },
    HostConfig: {
      ...(input.memoryLimit ?? CURRENT_MEMORY_LIMIT),
      Binds: input.binds ?? [
        "/var/run/docker.sock:/var/run/docker.sock",
        "/:/rootfs:ro",
        "/sys:/sys:ro",
        "/var/run:/var/run:ro",
        "/var/lib/docker:/var/lib/docker:ro",
        `${input.dataVolume ?? "nouva-agent-data"}:/var/lib/nouva-agent`,
      ],
      RestartPolicy: {
        Name: "unless-stopped",
      },
      LogConfig:
        input.logConfigCurrent === false
          ? { Type: "json-file", Config: {} }
          : { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      PortBindings: {
        [`${ALLOY_HTTP_PORT}/tcp`]: [
          {
            HostIp: ALLOY_HTTP_HOST,
            HostPort: String(ALLOY_HTTP_PORT),
          },
        ],
      },
      Privileged: true,
    },
    Config: {
      Image: input.image ?? runtimeConfig.observability.alloyImage,
      Cmd: [
        "run",
        "--stability.level=experimental",
        "--server.http.listen-addr=0.0.0.0:12345",
        "--storage.path=/var/lib/nouva-agent/alloy/data",
        "/var/lib/nouva-agent/alloy/config",
      ],
      Labels: {
        [ALLOY_CONFIG_HASH_LABEL]: input.stateHash ?? "state-hash",
        [ALLOY_CONFIG_LAYOUT_LABEL]: ALLOY_CONFIG_LAYOUT_VERSION,
      },
    },
  };
}

describe("alloy-runtime", () => {
  let tempDir = "";

  afterEach(async () => {
    resetAlloyRuntimeState();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("scrapes Traefik request counters and attributes them to the routed service", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));

    const config = renderAlloyStaticConfig(createAlloyInput(tempDir));

    // Reached container-to-container. Traefik binds 8082 to the host loopback only, so a host
    // target would not resolve from inside Alloy.
    expect(config).toContain('targets         = [{ __address__ = "nouva-traefik:8082" }]');
    // Only the request counter is kept. Traefik publishes config reloads, TLS expiry and open
    // connection gauges on the same endpoint, and none of them are charted.
    expect(config).toContain('regex         = "traefik_service_requests_total"');
    // The route file is named by service id and the load balancer is svc-<serviceId>, so
    // Traefik's own service label is what carries the id the dashboard queries by.
    expect(config).toContain(`rule {
    source_labels = ["service"]
    target_label  = "ingress_service_id"
    regex         = "svc-(.+)@file"
    replacement   = "$1"
  }`);
    // Traefik's own service label would otherwise reach Mimir as a second copy of the id.
    expect(config).toContain(`  rule {
    action = "labeldrop"
    regex  = "instance|job|service"
  }`);
  });

  test("keeps Traefik request counters in the system scope", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));

    const config = renderAlloyStaticConfig(createAlloyInput(tempDir));
    const traefikBlock = config.slice(
      config.indexOf('prometheus.relabel "nouva_traefik"'),
      config.indexOf('prometheus.exporter.unix "nouva"')
    );

    // These are Traefik's metrics, and Traefik is a system container. Writing the routed service
    // into `service_id` would give an unowned series a service's authoritative identity and make
    // it indistinguishable at ingest from that service's own container metrics, so the route id
    // travels in its own non-authoritative label instead.
    expect(traefikBlock).toContain(`  rule {
    target_label = "service_id"
    replacement  = "__none__"
  }`);
    expect(traefikBlock).toContain(`  rule {
    target_label = "service_type"
    replacement  = "system"
  }`);
    // service_variant/runtime_kind of traefik/traefik is the pair the ingest path already
    // accepts for a system-scope series, so this needs no new authorization path.
    expect(traefikBlock).toContain(`  rule {
    target_label = "service_variant"
    replacement  = "traefik"
  }`);
    expect(traefikBlock).toContain(`  rule {
    target_label = "runtime_kind"
    replacement  = "traefik"
  }`);
  });

  test("drops Traefik routes that are not a Nouva service route", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));

    const config = renderAlloyStaticConfig(createAlloyInput(tempDir));

    // Traefik routes its own dashboard, api and ping endpoints through @internal services.
    // Those never match svc-<id>@file, so they keep the none placeholder. A keep filter on
    // "no @ in the value" would have let __none__ straight through; the drop is on the
    // placeholder itself. They are not a service's traffic, so they are not shipped at all.
    expect(config).toContain(`  rule {
    source_labels = ["ingress_service_id"]
    action        = "drop"
    regex         = "__none__"
  }`);
  });

  test("comments the rendered config in Alloy syntax rather than shell syntax", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));

    const staticConfig = renderAlloyStaticConfig(createAlloyInput(tempDir));
    const dynamicConfig = renderAlloyDynamicConfig(createAlloyInput(tempDir));

    // Alloy's parser rejects `#` outright ("illegal character U+0023"), and the whole config is
    // one file: a single `#` comment invalidates every block, so `alloy validate` fails, the
    // reconcile never swaps the container in and the collector silently keeps running the last
    // good config. v0.4.30 shipped exactly that and the Traefik request scrape never started.
    for (const [name, config] of [
      ["static", staticConfig],
      ["dynamic", dynamicConfig],
    ] as const) {
      const shellComments = config
        .split("\n")
        .filter((line) => /^\s*#/.test(line))
        .map((line) => `${name}: ${line.trim()}`);
      expect(shellComments).toEqual([]);
    }

    expect(staticConfig).toContain(
      "  // Traefik's own service label would otherwise reach Mimir as a second copy of the id."
    );
  });

  test("renders bounded WAL delivery and v1 metadata-free remote write", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));

    const config = renderAlloyStaticConfig(createAlloyInput(tempDir));

    expect(config).toContain('"https://api.nouva.sh/api/agent/observability/logs"');
    expect(config).toContain('"https://api.nouva.sh/api/agent/observability/metrics"');
    expect(config).toContain('"agent-token"');
    expect(config).toContain('min_backoff_period  = "1s"');
    expect(config).toContain('remote_timeout      = "10s"');
    expect(config).toContain('max_backoff_period  = "1m"');
    expect(config).toContain("max_backoff_retries = 1200");
    expect(config).toContain("retry_on_http_429   = true");
    expect(config).toContain('capacity          = "64MiB"');
    expect(config).toContain("min_shards        = 1");
    expect(config).toContain("block_on_overflow = true");
    expect(config).toContain('drain_timeout     = "1m"');
    expect(config).toContain("enabled         = true");
    expect(config).toContain('max_segment_age = "24h"');
    expect(config).toContain('regex         = "app|database|traefik|worker|worker_job"');
    expect(config).toContain('target_label = "organization_id"');
    expect(config).toContain('target_label = "environment_id"');
    expect(config).toContain('replacement  = "__none__"');
    expect(config).toContain("allowlisted_container_labels = [");
    expect(config).toContain('"nouva.redaction.context.version"');
    expect(config).toContain(`endpoint {
    url          = "https://api.nouva.sh/api/agent/observability/metrics"
    bearer_token = "agent-token"

    metadata_config {
      send = false
    }
  }`);
    expect(config).not.toContain("protobuf_message");
    expect(config).not.toContain("remote_write_version");
    expect(config).not.toContain("X-Redaction-Context-Version");
  });

  test("collects only the exporter groups behind the service and server metrics (#329)", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));

    const config = renderAlloyStaticConfig(createAlloyInput(tempDir));

    // cpu, memory, network and diskIO carry container_cpu_usage_seconds_total,
    // container_memory_working_set_bytes, container_network_*_bytes_total and
    // container_fs_{reads,writes}_bytes_total; start time and last seen are always exported.
    expect(config).toContain(
      'enabled_metrics              = ["cpu", "memory", "network", "diskIO"]'
    );
    expect(config).toContain(
      'set_collectors = ["cpu", "diskstats", "filesystem", "loadavg", "meminfo", "netdev", "stat", "uname"]'
    );
    // On hosts using Docker's containerd image store, cAdvisor cannot watch a Docker container
    // without the containerd socket, so pointing it elsewhere would drop every container metric.
    expect(config).not.toContain("containerd_host");
  });

  test("keeps the runtime-log integration collector on the bounded WAL policy", async () => {
    const config = await readFile(
      new URL("../integration/runtime-logs/alloy.config", import.meta.url),
      "utf8"
    );

    expect(config).toContain('remote_timeout        = "10s"');
    expect(config).toContain('max_backoff_period    = "1m"');
    expect(config).toContain("max_backoff_retries   = 1200");
    expect(config).toContain("enabled         = true");
    expect(config).toContain('max_segment_age = "24h"');
  });

  test("stamps system context dynamically before both delivery WALs", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));
    const v1Input = createAlloyInput(tempDir, "context-v1");
    const v2Input = createAlloyInput(tempDir, "context-v2");

    const staticV1 = renderAlloyStaticConfig(v1Input);
    const staticV2 = renderAlloyStaticConfig(v2Input);
    const dynamicV1 = renderAlloyDynamicConfig(v1Input);
    const dynamicV2 = renderAlloyDynamicConfig(v2Input);

    expect(staticV2).toBe(staticV1);
    expect(dynamicV1).toContain('replacement   = "context-v1"');
    expect(dynamicV2).toContain('replacement   = "context-v2"');
    expect(dynamicV2).toContain('source_labels = ["service_type", "redaction_context_version"]');
    expect(dynamicV2).toContain('regex         = "system;$"');
    expect(staticV1).toContain("forward_to = [loki.relabel.nouva_redaction_context.receiver]");
    expect(dynamicV1.indexOf('loki.relabel "nouva_redaction_context"')).toBeLessThan(
      dynamicV1.indexOf("forward_to = [loki.write.nouva.receiver]")
    );
    expect(staticV1).toContain(
      "forward_to = [prometheus.relabel.nouva_redaction_context.receiver]"
    );
    expect(dynamicV1.indexOf('prometheus.relabel "nouva_redaction_context"')).toBeLessThan(
      dynamicV1.indexOf("forward_to = [prometheus.remote_write.nouva.receiver]")
    );
  });

  test("overrides stale container labels with per-scope versions in both delivery paths", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));
    const input = {
      ...createAlloyInput(tempDir, "context-v2"),
      redactionContextScopeVersions: [
        { kind: "database" as const, id: "svc_db", version: "hmac-sha256:redaction-context:v1:b" },
        { kind: "deployment" as const, id: "dep_1", version: "hmac-sha256:redaction-context:v1:a" },
      ],
    };

    const dynamic = renderAlloyDynamicConfig(input);
    const deploymentRule = [
      "  rule {",
      '    source_labels = ["deployment_id"]',
      '    regex         = "dep_1"',
      '    target_label  = "redaction_context_version"',
      '    replacement   = "hmac-sha256:redaction-context:v1:a"',
      "  }",
    ].join("\n");
    const databaseRule = [
      "  rule {",
      '    source_labels = ["service_type", "service_id"]',
      '    separator     = ";"',
      '    regex         = "database;svc_db"',
      '    target_label  = "redaction_context_version"',
      '    replacement   = "hmac-sha256:redaction-context:v1:b"',
      "  }",
    ].join("\n");

    // Both blocks carry both rules, after the system rule so the system stamp is untouched.
    expect(dynamic.split(deploymentRule).length - 1).toBe(2);
    expect(dynamic.split(databaseRule).length - 1).toBe(2);
    const lokiBlock = dynamic.slice(
      0,
      dynamic.indexOf('prometheus.relabel "nouva_redaction_context"')
    );
    expect(lokiBlock.indexOf('regex         = "system;$"')).toBeLessThan(
      lokiBlock.indexOf(deploymentRule)
    );
    // Deployment scopes are ordered by kind then id regardless of input order.
    expect(dynamic.indexOf(databaseRule)).toBeLessThan(dynamic.indexOf(deploymentRule));
    expect(renderAlloyStaticConfig(input)).toBe(
      renderAlloyStaticConfig(createAlloyInput(tempDir, "context-v2"))
    );
  });

  test("rejects scope versions that cannot be embedded safely", () => {
    expect(() =>
      normalizeRedactionContextScopeVersions([
        { kind: "deployment", id: "dep.1|.*", version: "hmac-sha256:redaction-context:v1:a" },
      ])
    ).toThrow("scope id is invalid");
    // The none sentinel is the deployment_id label of every database container.
    expect(() =>
      normalizeRedactionContextScopeVersions([
        { kind: "deployment", id: "__none__", version: "hmac-sha256:redaction-context:v1:a" },
      ])
    ).toThrow("scope id is invalid");
    expect(() =>
      normalizeRedactionContextScopeVersions([
        { kind: "deployment", id: "dep_1", version: 'v1"\n' },
      ])
    ).toThrow("scope version is invalid");
    expect(() =>
      normalizeRedactionContextScopeVersions([
        { kind: "deployment", id: "dep_1", version: "v1" },
        { kind: "deployment", id: "dep_1", version: "v2" },
      ])
    ).toThrow("conflicting versions");
    expect(
      normalizeRedactionContextScopeVersions([
        { kind: "deployment", id: "dep_1", version: "v1" },
        { kind: "deployment", id: "dep_1", version: "v1" },
      ])
    ).toEqual([{ kind: "deployment", id: "dep_1", version: "v1" }]);
  });

  test("compares scope version maps by content, not order", () => {
    const left = [
      { kind: "deployment" as const, id: "dep_1", version: "v1" },
      { kind: "database" as const, id: "svc_db", version: "v2" },
    ];
    const right = [...left].reverse();

    expect(redactionContextScopeVersionsEqual(left, right)).toBe(true);
    expect(redactionContextScopeVersionsEqual(undefined, [])).toBe(true);
    expect(redactionContextScopeVersionsEqual(left, undefined)).toBe(false);
    expect(
      redactionContextScopeVersionsEqual(left, [
        left[0]!,
        { kind: "database", id: "svc_db", version: "v3" },
      ])
    ).toBe(false);
  });

  test("preserves worker identity in Loki and Mimir", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));

    const config = renderAlloyStaticConfig(createAlloyInput(tempDir));
    const cadvisorOffset = config.indexOf('prometheus.exporter.cadvisor "nouva"');
    const lokiConfig = config.slice(0, cadvisorOffset);
    const metricConfig = config.slice(cadvisorOffset);

    expect(lokiConfig).toContain("__meta_docker_container_label_nouva_replica_index");
    expect(lokiConfig).toContain("__meta_docker_container_label_nouva_schedule_id");
    expect(lokiConfig).toContain("__meta_docker_container_label_nouva_schedule_run_id");
    expect(lokiConfig).toContain('target_label = "schedule_run_id"');
    expect(lokiConfig).toContain('target_label  = "container_name"');
    expect(metricConfig).toContain('"nouva.replica.index"');
    expect(metricConfig).toContain('"nouva.schedule.id"');
    expect(metricConfig).toContain('"nouva.schedule.run.id"');
    expect(metricConfig).toContain('target_label = "replica_index"');
    expect(metricConfig).toContain('target_label = "schedule_id"');
    expect(metricConfig).toContain('target_label = "schedule_run_id"');
    expect(metricConfig).toContain('"container_label_nouva_schedule_run_id"');
    expect(metricConfig).toContain('target_label  = "container_name"');
    const contextRuleIndex = metricConfig.indexOf(
      'source_labels = ["container_label_nouva_redaction_context_version"]'
    );
    const terminalLabelDropIndex = metricConfig.indexOf(
      'regex  = "container_label_.*|instance|job|id|name|image|container"'
    );
    expect(contextRuleIndex).toBeGreaterThan(-1);
    expect(contextRuleIndex).toBeLessThan(terminalLabelDropIndex);
  });

  test("builds the managed Alloy container spec with required mounts and localhost health port", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));

    const config = renderAlloyStaticConfig(createAlloyInput(tempDir));
    const spec = buildAlloyContainerSpec(createAlloyInput(tempDir), {
      stateHash: createAlloyStateHash(config),
    });

    expect(spec.image).toBe("grafana/alloy:v1.17.1");
    expect(spec.cmd).toContain("--stability.level=experimental");
    expect(spec.cmd?.at(-1)).toBe("/var/lib/nouva-agent/alloy/config");
    expect(spec.labels?.[ALLOY_CONFIG_LAYOUT_LABEL]).toBe(ALLOY_CONFIG_LAYOUT_VERSION);
    expect(spec.hostConfig).toEqual(
      expect.objectContaining({
        Binds: expect.arrayContaining([
          "/var/run/docker.sock:/var/run/docker.sock",
          "/:/rootfs:ro",
          "/sys:/sys:ro",
          "/var/run:/var/run:ro",
          "/var/lib/docker:/var/lib/docker:ro",
          "nouva-agent-data:/var/lib/nouva-agent",
        ]),
        RestartPolicy: {
          Name: "unless-stopped",
        },
        LogConfig: {
          Type: "json-file",
          Config: { "max-size": "10m", "max-file": "3" },
        },
        Privileged: true,
        PortBindings: {
          [`${ALLOY_HTTP_PORT}/tcp`]: [
            {
              HostIp: "127.0.0.1",
              HostPort: "12345",
            },
          ],
        },
      })
    );

    expect(buildAlloyValidationContainerSpec(createAlloyInput(tempDir))).toEqual(
      expect.objectContaining({
        image: "grafana/alloy:v1.17.1",
        cmd: [
          "validate",
          "--stability.level=experimental",
          "/var/lib/nouva-agent/alloy/config.candidate",
        ],
        hostConfig: {
          Binds: ["nouva-agent-data:/var/lib/nouva-agent:ro"],
          NetworkMode: "none",
        },
      })
    );
  });

  test("bounds the collector's memory with a hard limit and no Go soft limit (#329)", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));

    const spec = buildAlloyContainerSpec(createAlloyInput(tempDir), { stateHash: "state-hash" });

    expect(spec.hostConfig).toEqual(expect.objectContaining(CURRENT_MEMORY_LIMIT));
    // The leak is live memory. A soft limit below the hard one cannot reclaim it and would keep
    // the collector collecting back to back for days before the hard limit restarted it.
    expect((spec.env ?? []).filter((entry) => entry.startsWith("GOMEMLIMIT="))).toEqual([]);
  });

  async function writeCurrentAlloyConfig(input: ReturnType<typeof createAlloyInput>) {
    const paths = getAlloyRuntimePaths(input.dataDir);
    const staticConfig = renderAlloyStaticConfig(input);
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.staticConfigPath, staticConfig, "utf8");
    await writeFile(paths.dynamicConfigPath, renderAlloyDynamicConfig(input), "utf8");
    return { paths, stateHash: createAlloyStateHash(staticConfig) };
  }

  test.each([
    ["created before the memory bound", { Memory: 0, MemorySwap: 0 }],
    [
      "created with another memory limit",
      { Memory: 256 * 1024 * 1024, MemorySwap: 256 * 1024 * 1024 },
    ],
  ])("recreates a collector %s exactly once", async (_name, memoryLimit) => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));
    const input = createAlloyInput(tempDir);
    const { paths, stateHash } = await writeCurrentAlloyConfig(input);
    const dockerState: { inspection: DockerContainerInspection | null } = {
      inspection: createAlloyInspection({ memoryLimit, stateHash }),
    };
    const ensuredSpecs: DockerContainerSpec[] = [];
    const docker = {
      inspectContainer: mock(async () => dockerState.inspection),
      inspectImage: mock(async () => ({ Id: "img_1" })),
      pullImage: mock(async () => undefined),
      createContainer: mock(async () => "alloy-validation"),
      startContainer: mock(async () => undefined),
      waitContainer: mock(async () => 0),
      containerLogs: mock(async () => ""),
      removeContainer: mock(async (name: string, _force?: boolean) => {
        if (name === ALLOY_CONTAINER_NAME) {
          dockerState.inspection = null;
        }
      }),
      ensureNetwork: mock(async () => undefined),
      ensureContainer: mock(async (spec: DockerContainerSpec) => {
        ensuredSpecs.push(spec);
        dockerState.inspection = createAlloyInspection({
          stateHash: spec.labels?.[ALLOY_CONFIG_HASH_LABEL] ?? stateHash,
          memoryLimit: {
            Memory: Number(spec.hostConfig?.Memory),
            MemorySwap: Number(spec.hostConfig?.MemorySwap),
          },
        });
        return ALLOY_CONTAINER_NAME;
      }),
    };
    const fetchImpl: typeof fetch = mock(
      async () => new Response("ok", { status: 200 })
    ) as typeof fetch;
    const options = { paths, fetchImpl, timeoutMs: 100, intervalMs: 1 };

    await ensureAlloyRuntime(docker, input, options);
    await ensureAlloyRuntime(docker, input, options);
    await ensureAlloyRuntime(docker, input, options);

    const collectorRemovals = docker.removeContainer.mock.calls.filter(
      ([name]) => name === ALLOY_CONTAINER_NAME
    );
    expect(collectorRemovals).toHaveLength(1);
    expect(ensuredSpecs).toHaveLength(1);
    expect(ensuredSpecs[0]?.hostConfig).toEqual(expect.objectContaining(CURRENT_MEMORY_LIMIT));
  });

  test.each([
    ["with the current memory limit", CURRENT_MEMORY_LIMIT],
    // Docker keeps the memory limit and stores swap as -1 when the host has no swap accounting.
    [
      "on a host without swap accounting",
      { Memory: EXPECTED_ALLOY_MEMORY_LIMIT_BYTES, MemorySwap: -1 },
    ],
    // Docker stores a memory limit the kernel cannot enforce as 0 with swap -1. Treating that as
    // stale would recreate the collector on every reconcile, and the new one would read the same.
    ["whose memory limit Docker discarded", { Memory: 0, MemorySwap: -1 }],
  ])("keeps a collector %s", async (_name, memoryLimit) => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));
    const input = createAlloyInput(tempDir);
    const { paths, stateHash } = await writeCurrentAlloyConfig(input);
    const inspection = createAlloyInspection({ memoryLimit, stateHash });
    const docker = {
      inspectContainer: mock(async () => inspection),
      inspectImage: mock(async () => ({ Id: "img_1" })),
      pullImage: mock(async () => undefined),
      createContainer: mock(async () => "alloy-validation"),
      startContainer: mock(async () => undefined),
      waitContainer: mock(async () => 0),
      containerLogs: mock(async () => ""),
      removeContainer: mock(async () => undefined),
      ensureNetwork: mock(async () => undefined),
      ensureContainer: mock(async () => ALLOY_CONTAINER_NAME),
    };

    await ensureAlloyRuntime(docker, input, { paths, timeoutMs: 100, intervalMs: 1 });

    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(docker.ensureContainer).not.toHaveBeenCalled();
  });

  test("reconciles Alloy state and reports healthy validation checks", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));
    const paths = getAlloyRuntimePaths(tempDir);
    const input = createAlloyInput(tempDir);
    const staticConfig = renderAlloyStaticConfig(input);
    const dynamicConfig = renderAlloyDynamicConfig(input);
    const stateHash = createAlloyStateHash(staticConfig);
    const dockerState: { inspection: DockerContainerInspection | null } = {
      inspection: null,
    };

    const docker = {
      inspectContainer: mock(async () => dockerState.inspection),
      inspectImage: mock(async () => ({ Id: "img_1" })),
      pullImage: mock(async () => undefined),
      createContainer: mock(async () => "alloy-validation"),
      startContainer: mock(async () => undefined),
      waitContainer: mock(async () => 0),
      containerLogs: mock(async () => ""),
      removeContainer: mock(async (name: string) => {
        if (name === ALLOY_CONTAINER_NAME) {
          dockerState.inspection = null;
        }
      }),
      ensureNetwork: mock(async () => undefined),
      ensureContainer: mock(async (spec: DockerContainerSpec) => {
        dockerState.inspection = createAlloyInspection({
          image: spec.image,
          stateHash: spec.labels?.[ALLOY_CONFIG_HASH_LABEL] ?? stateHash,
        });
        return ALLOY_CONTAINER_NAME;
      }),
    };

    const fetchImpl: typeof fetch = mock(
      async () =>
        new Response("metrics", {
          status: 200,
        })
    ) as typeof fetch;

    await ensureAlloyRuntime(docker, input, {
      paths,
      fetchImpl,
      timeoutMs: 100,
      intervalMs: 1,
    });

    const persistedStaticConfig = await readFile(paths.staticConfigPath, "utf8");
    const persistedDynamicConfig = await readFile(paths.dynamicConfigPath, "utf8");
    expect(persistedStaticConfig).toBe(staticConfig);
    expect(persistedStaticConfig).toContain("/api/agent/observability/logs");
    expect(persistedDynamicConfig).toBe(dynamicConfig);
    expect(docker.pullImage).toHaveBeenCalledWith("grafana/alloy:v1.17.1");
    expect(docker.createContainer).toHaveBeenCalledWith(buildAlloyValidationContainerSpec(input));
    expect(docker.ensureContainer).toHaveBeenCalledTimes(1);
    expect(docker.ensureContainer).toHaveBeenCalledWith(expect.anything(), false, {
      pull: false,
    });

    const checks = await collectAlloyValidationChecks(
      {
        inspectContainer: docker.inspectContainer,
        inspectImage: docker.inspectImage,
      },
      input,
      {
        paths,
        fetchImpl,
        statfsImpl: async () => ({
          bavail: 20 * 1024 * 1024 * 1024,
          blocks: 100 * 1024 * 1024 * 1024,
          bsize: 1,
        }),
      }
    );

    expect(checks).toEqual([
      expect.objectContaining({ key: "alloy-image", status: "pass" }),
      expect.objectContaining({ key: "alloy-container", status: "pass" }),
      expect.objectContaining({ key: "alloy-config", status: "pass" }),
      expect.objectContaining({ key: "alloy-health", status: "pass" }),
      expect.objectContaining({ key: "alloy-mounts", status: "pass" }),
      expect.objectContaining({ key: "alloy-wal-disk", status: "pass" }),
    ]);

    const pressureChecks = await collectAlloyValidationChecks(
      {
        inspectContainer: docker.inspectContainer,
        inspectImage: docker.inspectImage,
      },
      input,
      {
        paths,
        fetchImpl,
        statfsImpl: async () => ({
          bavail: 4 * 1024 * 1024 * 1024,
          blocks: 100 * 1024 * 1024 * 1024,
          bsize: 1,
        }),
      }
    );
    expect(pressureChecks.find((check) => check.key === "alloy-wal-disk")).toEqual(
      expect.objectContaining({ status: "fail" })
    );
  });

  test("keeps buffered V1 records and state while V2 is applied by reload", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));
    const paths = getAlloyRuntimePaths(tempDir);
    const v1Input = createAlloyInput(tempDir, "context-v1");
    const v2Input = createAlloyInput(tempDir, "context-v2");
    const staticConfig = renderAlloyStaticConfig(v1Input);
    const stateHash = createAlloyStateHash(staticConfig);
    const dockerState: { inspection: DockerContainerInspection | null } = {
      inspection: null,
    };
    const ensuredSpecs: DockerContainerSpec[] = [];
    const removedNames: string[] = [];
    const docker = {
      inspectContainer: mock(async () => dockerState.inspection),
      inspectImage: mock(async () => ({ Id: "img_1" })),
      pullImage: mock(async () => undefined),
      createContainer: mock(async () => "alloy-validation"),
      startContainer: mock(async () => undefined),
      waitContainer: mock(async () => 0),
      containerLogs: mock(async () => ""),
      removeContainer: mock(async (name: string) => {
        removedNames.push(name);
        if (name === ALLOY_CONTAINER_NAME) {
          dockerState.inspection = null;
        }
      }),
      ensureNetwork: mock(async () => undefined),
      ensureContainer: mock(async (spec: DockerContainerSpec) => {
        ensuredSpecs.push(spec);
        dockerState.inspection = createAlloyInspection({
          image: spec.image,
          stateHash: spec.labels?.[ALLOY_CONFIG_HASH_LABEL] ?? stateHash,
        });
        return ALLOY_CONTAINER_NAME;
      }),
    };
    const fetchImpl: typeof fetch = mock(
      async () => new Response("ok", { status: 200 })
    ) as typeof fetch;

    await ensureAlloyRuntime(docker, v1Input, {
      paths,
      fetchImpl,
      timeoutMs: 100,
      intervalMs: 1,
    });

    const v1Fragment = await readFile(paths.dynamicConfigPath, "utf8");
    const bufferedRecordPath = path.join(paths.dataDir, "loki", "wal", "buffered-v1");
    const positionsPath = path.join(paths.dataDir, "loki", "positions", "positions.yml");
    await mkdir(path.dirname(bufferedRecordPath), { recursive: true });
    await mkdir(path.dirname(positionsPath), { recursive: true });
    await writeFile(bufferedRecordPath, "redaction_context_version=context-v1\n", "utf8");
    await writeFile(positionsPath, "cursor: 42\n", "utf8");

    const argsBeforeReload = dockerState.inspection?.Config?.Cmd;
    await ensureAlloyRuntime(docker, v2Input, {
      paths,
      fetchImpl,
      reloadTimeoutMs: 100,
      timeoutMs: 100,
      intervalMs: 1,
    });

    expect(v1Fragment).toContain('replacement   = "context-v1"');
    expect(await readFile(paths.dynamicConfigPath, "utf8")).toContain(
      'replacement   = "context-v2"'
    );
    expect(await readFile(paths.staticConfigPath, "utf8")).toBe(staticConfig);
    expect(await readFile(bufferedRecordPath, "utf8")).toBe(
      "redaction_context_version=context-v1\n"
    );
    expect(await readFile(positionsPath, "utf8")).toBe("cursor: 42\n");
    expect(dockerState.inspection?.Config?.Cmd).toEqual(argsBeforeReload);
    expect(ensuredSpecs).toHaveLength(1);
    expect(docker.pullImage).toHaveBeenCalledTimes(1);
    expect(removedNames.filter((name) => name === ALLOY_CONTAINER_NAME)).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://${ALLOY_HTTP_HOST}:${ALLOY_HTTP_PORT}/-/reload`,
      expect.objectContaining({ method: "POST" })
    );
  });

  test("coalesces concurrent context updates to the latest fragment", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));
    const paths = getAlloyRuntimePaths(tempDir);
    const v1Input = createAlloyInput(tempDir, "context-v1");
    const v2Input = createAlloyInput(tempDir, "context-v2");
    const v3Input = createAlloyInput(tempDir, "context-v3");
    const stateHash = createAlloyStateHash(renderAlloyStaticConfig(v1Input));
    const dockerState: { inspection: DockerContainerInspection | null } = {
      inspection: null,
    };
    let validationCount = 0;
    let releaseFirstValidation = () => {};
    let announceFirstValidation = () => {};
    const firstValidationStarted = new Promise<void>((resolve) => {
      announceFirstValidation = resolve;
    });
    const firstValidationGate = new Promise<void>((resolve) => {
      releaseFirstValidation = resolve;
    });
    const docker = {
      inspectContainer: mock(async () => dockerState.inspection),
      inspectImage: mock(async () => ({ Id: "img_1" })),
      pullImage: mock(async () => undefined),
      createContainer: mock(async () => "alloy-validation"),
      startContainer: mock(async () => undefined),
      waitContainer: mock(async () => {
        validationCount += 1;
        if (validationCount === 1) {
          announceFirstValidation();
          await firstValidationGate;
        }
        return 0;
      }),
      containerLogs: mock(async () => ""),
      removeContainer: mock(async (name: string) => {
        if (name === ALLOY_CONTAINER_NAME) {
          dockerState.inspection = null;
        }
      }),
      ensureNetwork: mock(async () => undefined),
      ensureContainer: mock(async (spec: DockerContainerSpec) => {
        dockerState.inspection = createAlloyInspection({
          image: spec.image,
          stateHash: spec.labels?.[ALLOY_CONFIG_HASH_LABEL] ?? stateHash,
        });
        return ALLOY_CONTAINER_NAME;
      }),
    };
    const fetchImpl: typeof fetch = mock(
      async () => new Response("ok", { status: 200 })
    ) as typeof fetch;
    const deps = {
      paths,
      fetchImpl,
      reloadTimeoutMs: 100,
      timeoutMs: 100,
      intervalMs: 1,
    };

    const first = ensureAlloyRuntime(docker, v1Input, deps);
    await firstValidationStarted;
    const second = ensureAlloyRuntime(docker, v2Input, deps);
    const third = ensureAlloyRuntime(docker, v3Input, deps);
    releaseFirstValidation();
    await Promise.all([first, second, third]);

    const fragment = await readFile(paths.dynamicConfigPath, "utf8");
    expect(fragment).toContain('replacement   = "context-v3"');
    expect(fragment).not.toContain("context-v2");
    expect(validationCount).toBe(2);
    expect(docker.ensureContainer).toHaveBeenCalledTimes(1);
    expect(
      fetchImpl.mock.calls.filter((call) => String(call[0]).endsWith("/-/reload"))
    ).toHaveLength(1);
  });

  test("restores the previous dynamic fragment when reload fails", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));
    const paths = getAlloyRuntimePaths(tempDir);
    const v1Input = createAlloyInput(tempDir, "context-v1");
    const v2Input = createAlloyInput(tempDir, "context-v2");
    const stateHash = createAlloyStateHash(renderAlloyStaticConfig(v1Input));
    const dockerState: { inspection: DockerContainerInspection | null } = {
      inspection: null,
    };
    const mainRemovals: string[] = [];
    const docker = {
      inspectContainer: mock(async () => dockerState.inspection),
      inspectImage: mock(async () => ({ Id: "img_1" })),
      pullImage: mock(async () => undefined),
      createContainer: mock(async () => "alloy-validation"),
      startContainer: mock(async () => undefined),
      waitContainer: mock(async () => 0),
      containerLogs: mock(async () => ""),
      removeContainer: mock(async (name: string) => {
        if (name === ALLOY_CONTAINER_NAME) {
          mainRemovals.push(name);
          dockerState.inspection = null;
        }
      }),
      ensureNetwork: mock(async () => undefined),
      ensureContainer: mock(async (spec: DockerContainerSpec) => {
        dockerState.inspection = createAlloyInspection({
          image: spec.image,
          stateHash: spec.labels?.[ALLOY_CONFIG_HASH_LABEL] ?? stateHash,
        });
        return ALLOY_CONTAINER_NAME;
      }),
    };
    let failNextReload = false;
    const fetchImpl: typeof fetch = mock(async (request: RequestInfo | URL) => {
      if (String(request).endsWith("/-/reload") && failNextReload) {
        failNextReload = false;
        return new Response("invalid", { status: 500 });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await ensureAlloyRuntime(docker, v1Input, {
      paths,
      fetchImpl,
      timeoutMs: 100,
      intervalMs: 1,
    });
    const v1Fragment = await readFile(paths.dynamicConfigPath, "utf8");
    failNextReload = true;

    await expect(
      ensureAlloyRuntime(docker, v2Input, {
        paths,
        fetchImpl,
        reloadTimeoutMs: 100,
        timeoutMs: 100,
        intervalMs: 1,
      })
    ).rejects.toThrow("the previous fragment was restored");

    expect(await readFile(paths.dynamicConfigPath, "utf8")).toBe(v1Fragment);
    expect(mainRemovals).toHaveLength(0);
    expect(
      fetchImpl.mock.calls.filter((call) => String(call[0]).endsWith("/-/reload"))
    ).toHaveLength(2);
  });

  test("adopts Alloy logging drift once while preserving its data volume", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));
    const paths = getAlloyRuntimePaths(tempDir);
    const input = createAlloyInput(tempDir);
    const staticConfig = renderAlloyStaticConfig(input);
    const stateHash = createAlloyStateHash(staticConfig);
    const dockerState: { inspection: DockerContainerInspection | null } = {
      inspection: createAlloyInspection({
        dataVolume: "legacy-alloy-data",
        logConfigCurrent: false,
        stateHash,
      }),
    };
    const ensuredSpecs: DockerContainerSpec[] = [];
    const removedNames: string[] = [];
    const docker = {
      inspectContainer: mock(async () => dockerState.inspection),
      inspectImage: mock(async () => ({ Id: "img_1" })),
      pullImage: mock(async () => undefined),
      createContainer: mock(async () => "alloy-validation"),
      startContainer: mock(async () => undefined),
      waitContainer: mock(async () => 0),
      containerLogs: mock(async () => ""),
      removeContainer: mock(async (name: string) => {
        removedNames.push(name);
        if (name === ALLOY_CONTAINER_NAME) {
          dockerState.inspection = null;
        }
      }),
      ensureNetwork: mock(async () => undefined),
      ensureContainer: mock(async (spec: DockerContainerSpec) => {
        ensuredSpecs.push(spec);
        dockerState.inspection = createAlloyInspection({
          dataVolume: "legacy-alloy-data",
          image: spec.image,
          stateHash: spec.labels?.[ALLOY_CONFIG_HASH_LABEL] ?? stateHash,
        });
        return ALLOY_CONTAINER_NAME;
      }),
    };
    const fetchImpl: typeof fetch = mock(
      async () => new Response("ok", { status: 200 })
    ) as typeof fetch;

    await ensureAlloyRuntime(docker, input, {
      paths,
      fetchImpl,
      timeoutMs: 100,
      intervalMs: 1,
    });
    await ensureAlloyRuntime(docker, input, {
      paths,
      fetchImpl,
      timeoutMs: 100,
      intervalMs: 1,
    });

    expect(removedNames.filter((name) => name === ALLOY_CONTAINER_NAME)).toEqual([
      ALLOY_CONTAINER_NAME,
    ]);
    expect(ensuredSpecs).toHaveLength(1);
    expect(ensuredSpecs[0]?.hostConfig).toEqual(
      expect.objectContaining({
        Binds: expect.arrayContaining(["legacy-alloy-data:/var/lib/nouva-agent"]),
        LogConfig: {
          Type: "json-file",
          Config: { "max-size": "10m", "max-file": "3" },
        },
      })
    );
  });

  test("keeps the running collector when candidate config validation fails", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));
    const input = createAlloyInput(tempDir);
    const currentInspection = createAlloyInspection({
      image: "grafana/alloy:v1.16.1",
      stateHash: "old-state",
    });
    const removeContainer = mock(async () => undefined);
    const docker = {
      inspectContainer: mock(async () => currentInspection),
      inspectImage: mock(async () => ({ Id: "img_1" })),
      pullImage: mock(async () => undefined),
      createContainer: mock(async () => "alloy-validation"),
      startContainer: mock(async () => undefined),
      waitContainer: mock(async () => 1),
      containerLogs: mock(async () => "invalid queue_config token=agent-token context=context-v1"),
      removeContainer,
      ensureNetwork: mock(async () => undefined),
      ensureContainer: mock(async () => ALLOY_CONTAINER_NAME),
    };

    let failure: Error | null = null;
    try {
      await ensureAlloyRuntime(docker, input, {
        paths: getAlloyRuntimePaths(tempDir),
        timeoutMs: 100,
        intervalMs: 1,
      });
    } catch (error) {
      failure = error instanceof Error ? error : new Error("unknown failure");
    }

    expect(failure?.message).toContain(
      "Alloy configuration validation failed: invalid queue_config"
    );
    expect(failure?.message).not.toContain("agent-token");
    expect(failure?.message).not.toContain("context-v1");

    expect(removeContainer).not.toHaveBeenCalledWith(ALLOY_CONTAINER_NAME, true);
    expect(docker.ensureContainer).not.toHaveBeenCalled();
  });
});
