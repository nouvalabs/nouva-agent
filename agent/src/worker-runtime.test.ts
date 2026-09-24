import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DockerContainerInspection, DockerContainerSpec } from "./docker-api.js";
import type { WorkerDeployOnlyPayload, WorkerJobPayload } from "./protocol.js";
import {
  buildWorkerContainerSpec,
  buildWorkerJobContainerName,
  buildWorkerReplicaContainerName,
  cleanupWorkerJob,
  deployWorkerRuntime,
  inspectWorkerJob,
  removeWorkerServiceRuntime,
  restartWorkerServiceRuntime,
  startWorkerJob,
  WorkerRolloutError,
  waitForWorkerReadiness,
} from "./worker-runtime.js";

const resourceLimits = {
  cpuMillicores: 250,
  memoryBytes: 512 * 1024 * 1024,
  pidsLimit: 256,
  policyVersion: 1,
} as const;

const environment = {
  serverId: "srv_1",
  imageStoreMode: "docker-local" as const,
  dataDir: "/tmp/nouva-worker-runtime-tests",
  dataVolume: "nouva-agent-data",
};

const workerPayload: WorkerDeployOnlyPayload = {
  imageUrl: "registry.example/nouva-worker:dep_1",
  commitHash: "abc123",
  commitMessage: "feat: worker",
  serviceName: "queue-consumer",
  projectId: "proj_1",
  environmentId: "env_1",
  serviceId: "svc_1",
  deploymentId: "dep_1",
  redactionContextVersion: "hmac-sha256:redaction-context:v1:deployment",
  envVars: { NODE_ENV: "production" },
  startCommand: null,
  healthCheckCommand: null,
  replicaCount: 1,
  volume: null,
  resourceLimits,
  runtimeMetadata: null,
};

const workerImage = {
  Id: "img_worker_1",
  Config: {
    Entrypoint: ["node"],
    Cmd: ["dist/worker.js"],
  },
};

function getWorkerJobReceiptPath(dataDir: string, scheduleRunId: string): string {
  return path.join(
    dataDir,
    "worker-job-receipts",
    `${Buffer.from(scheduleRunId).toString("base64url")}.json`
  );
}

type SignalBehavior = "exits" | "ignores" | "survives_sigkill";

/**
 * A fake Docker daemon. `events` records every lifecycle call in order so tests can assert which
 * process started before which one stopped; `signalBehavior` makes a named container's process
 * ignore its shutdown signal, or survive even SIGKILL.
 */
function createRuntimeDocker() {
  const containers = new Map<string, DockerContainerInspection>();
  const signalBehavior = new Map<string, SignalBehavior>();
  const restartPolicies = new Map<string, string>();
  // An image's STOPSIGNAL, which Docker copies onto a container created without its own.
  const imageStopSignals = new Map<string, string>();
  const events: string[] = [];
  const forcedRemovalsOfRunningContainers: string[] = [];
  let nextContainer = 0;
  let now = 0;
  const clock = {
    now: () => now,
    wait: async (ms: number) => {
      now += ms;
    },
  };

  const findContainer = (identifier: string) =>
    containers.get(identifier) ??
    [...containers.values()].find((container) => container.Id === identifier) ??
    null;

  const docker = {
    containerLogs: mock(async () => ""),
    createContainer: mock(async (spec: DockerContainerSpec) => {
      const id = `ctr_task_${++nextContainer}`;
      containers.set(spec.name, {
        Id: id,
        Name: spec.name,
        Config: { Image: spec.image, Labels: spec.labels },
        State: { Running: false, Status: "created", ExitCode: 0 },
      });
      return id;
    }),
    createVolume: mock(async () => {}),
    ensureContainer: mock(async (spec: DockerContainerSpec) => {
      events.push(`start ${spec.name}`);
      const existing = containers.get(spec.name);
      if (existing) {
        existing.State = {
          Running: true,
          Status: "running",
          Health: { Status: "healthy" },
          ExitCode: 0,
        };
        return existing.Id;
      }
      const id = `ctr_worker_${++nextContainer}`;
      containers.set(spec.name, {
        Id: id,
        Name: spec.name,
        Config: {
          Image: spec.image,
          Labels: spec.labels,
          StopSignal: spec.stopSignal ?? imageStopSignals.get(spec.image),
        },
        State: {
          Running: true,
          Status: "running",
          Health: { Status: "healthy" },
          ExitCode: 0,
        },
      });
      return id;
    }),
    ensureNetwork: mock(async () => {}),
    inspectContainer: mock(async (identifier: string) => findContainer(identifier)),
    inspectImage: mock(async () => workerImage),
    killContainer: mock(async (identifier: string, signal: string) => {
      const container = findContainer(identifier);
      if (!container?.State?.Running) return false;
      events.push(`${signal} ${container.Name}`);
      const behavior = signalBehavior.get(container.Name) ?? "exits";
      if (behavior === "survives_sigkill" || (signal !== "SIGKILL" && behavior === "ignores")) {
        return true;
      }
      container.State = {
        Running: false,
        Status: "exited",
        ExitCode: signal === "SIGKILL" ? 137 : 0,
      };
      return true;
    }),
    listContainersByLabels: mock(async (labels: Record<string, string>) =>
      [...containers.values()].filter((container) =>
        Object.entries(labels).every(([key, value]) => container.Config?.Labels?.[key] === value)
      )
    ),
    listContainersUsingVolume: mock(async (volumeName: string) =>
      [...containers.values()].filter((container) =>
        container.Mounts?.some((mount) => mount.Name === volumeName || mount.Source === volumeName)
      )
    ),
    pullImage: mock(async () => {}),
    removeContainer: mock(async (identifier: string, force?: boolean) => {
      const container = findContainer(identifier);
      if (container) {
        if (container.State?.Running) {
          if (!force) throw new Error(`Cannot remove running container ${container.Name}`);
          forcedRemovalsOfRunningContainers.push(container.Name);
        }
        events.push(`remove ${container.Name}`);
        containers.delete(container.Name);
      }
    }),
    removeImage: mock(async () => {}),
    restartContainer: mock(async () => {}),
    startContainer: mock(async (identifier: string) => {
      const container = findContainer(identifier);
      if (!container) throw new Error(`Missing ${identifier}`);
      events.push(`start ${container.Name}`);
      container.State = { Running: true, Status: "running", ExitCode: 0 };
    }),
    stopContainer: mock(async (identifier: string) => {
      const container = findContainer(identifier);
      if (container) {
        container.State = { Running: false, Status: "exited", ExitCode: 137 };
      }
    }),
    updateContainerRestartPolicy: mock(async (identifier: string, policy: string) => {
      const container = findContainer(identifier);
      if (container) restartPolicies.set(container.Name, policy);
    }),
    waitContainer: mock(async () => 0),
  };

  return {
    clock,
    containers,
    docker,
    events,
    forcedRemovalsOfRunningContainers,
    imageStopSignals,
    restartPolicies,
    signalBehavior,
  };
}

describe("worker container specs", () => {
  test("uses a deterministic replica name and never configures ingress or ports", () => {
    const result = buildWorkerContainerSpec({
      environment,
      payload: workerPayload,
      image: workerImage,
      replicaIndex: 2,
    });

    expect(buildWorkerReplicaContainerName("svc_1", "dep_1", 2)).toBe("nouva-worker-svc_1-dep_1-2");
    expect(result.containerName).toBe("nouva-worker-svc_1-dep_1-2");
    expect(result.spec.entrypoint).toBeUndefined();
    expect(result.spec.cmd).toBeUndefined();
    expect(result.spec.exposedPorts).toBeUndefined();
    expect(result.spec.hostConfig).not.toHaveProperty("PortBindings");
    expect(result.spec.hostConfig).not.toHaveProperty("NetworkMode");
    expect(result.spec.networkingConfig).toEqual({
      EndpointsConfig: {
        [result.projectNetwork]: {},
      },
    });
    expect(result.spec.labels).toEqual(
      expect.objectContaining({
        "nouva.kind": "worker",
        "nouva.service.type": "worker",
        "nouva.replica.index": "2",
        "nouva.service.id": "svc_1",
        "nouva.redaction.context.version": "hmac-sha256:redaction-context:v1:deployment",
      })
    );
    expect(result.imageCommand).toEqual({
      entrypoint: ["node"],
      command: ["dist/worker.js"],
      display: "node dist/worker.js",
    });
  });

  test("bakes the shutdown policy into the container so Docker's own stops honor it", () => {
    const configured = buildWorkerContainerSpec({
      environment,
      payload: {
        ...workerPayload,
        shutdownPolicy: { signal: "SIGQUIT", gracePeriodSeconds: 600, rolloutPolicy: "no_overlap" },
      },
      image: workerImage,
      replicaIndex: 0,
    });
    const legacy = buildWorkerContainerSpec({
      environment,
      payload: { ...workerPayload, shutdownPolicy: { signal: "SIGKILL" } },
      image: workerImage,
      replicaIndex: 0,
    });
    const inheriting = buildWorkerContainerSpec({
      environment,
      payload: {
        ...workerPayload,
        shutdownPolicy: { signal: null, gracePeriodSeconds: 90, rolloutPolicy: "overlap" },
      },
      image: workerImage,
      replicaIndex: 0,
    });

    expect(configured.spec).toEqual(
      expect.objectContaining({ stopSignal: "SIGQUIT", stopTimeoutSeconds: 600 })
    );
    // Without a chosen signal Docker keeps the image's STOPSIGNAL, as it did before the policy.
    expect(Object.hasOwn(legacy.spec, "stopSignal")).toBe(false);
    expect(legacy.spec.stopTimeoutSeconds).toBe(30);
    expect(Object.hasOwn(inheriting.spec, "stopSignal")).toBe(false);
    expect(inheriting.spec.stopTimeoutSeconds).toBe(90);
  });

  test("uses fixed Docker health check defaults for an explicit worker command", () => {
    const result = buildWorkerContainerSpec({
      environment,
      payload: {
        ...workerPayload,
        startCommand: "node dist/override.js",
        healthCheckCommand: "node scripts/health.js",
      },
      image: workerImage,
      replicaIndex: 0,
    });

    expect(result.spec.entrypoint).toEqual(["/bin/sh", "-lc"]);
    expect(result.spec.cmd).toEqual(["node dist/override.js"]);
    expect(result.spec.healthcheck).toEqual({
      Test: ["CMD-SHELL", "node scripts/health.js"],
      Interval: 10_000_000_000,
      Timeout: 5_000_000_000,
      Retries: 3,
      StartPeriod: 10_000_000_000,
    });
  });

  test("keeps the no-swap default when no allowance is stored", () => {
    const result = buildWorkerContainerSpec({
      environment,
      payload: workerPayload,
      image: workerImage,
      replicaIndex: 0,
    });

    expect(result.spec.hostConfig).toEqual(
      expect.objectContaining({
        Memory: 512 * 1024 * 1024,
        MemorySwap: 512 * 1024 * 1024,
      })
    );
  });

  test("carries a bounded swap allowance into every worker replica", () => {
    const result = buildWorkerContainerSpec({
      environment,
      payload: {
        ...workerPayload,
        resourceLimits: { ...resourceLimits, memoryAndSwapBytes: 1024 * 1024 * 1024 },
      },
      image: workerImage,
      replicaIndex: 3,
    });

    expect(result.spec.hostConfig).toEqual(
      expect.objectContaining({
        NanoCpus: 250_000_000,
        Memory: 512 * 1024 * 1024,
        MemorySwap: 1024 * 1024 * 1024,
        PidsLimit: 256,
      })
    );
  });

  test("fails before creating a worker with no override or image default command", () => {
    expect(() =>
      buildWorkerContainerSpec({
        environment,
        payload: workerPayload,
        image: { Id: "img_empty", Config: { Entrypoint: [], Cmd: [] } },
        replicaIndex: 0,
      })
    ).toThrow("has no runnable default entrypoint or command");
  });
});

describe("worker readiness", () => {
  test("resets the ten-second running grace period after a restart", async () => {
    let now = 0;
    let inspectionCount = 0;
    const docker = {
      inspectContainer: mock(async () => {
        inspectionCount += 1;
        return {
          Id: "ctr_1",
          Name: "nouva-worker-svc_1-dep_1-0",
          RestartCount: inspectionCount === 1 ? 0 : 1,
          State: { Running: true, Status: "running" },
        };
      }),
    };

    await waitForWorkerReadiness(docker as never, {
      containerName: "nouva-worker-svc_1-dep_1-0",
      hasHealthcheck: false,
      timeoutMs: 100,
      intervalMs: 1,
      runningGraceMs: 10,
      now: () => now,
      wait: async () => {
        now += 10;
      },
    });

    expect(inspectionCount).toBe(3);
  });

  test("fails a candidate as soon as its health check becomes unhealthy", async () => {
    const docker = {
      inspectContainer: mock(async () => ({
        Id: "ctr_1",
        Name: "nouva-worker-svc_1-dep_1-0",
        State: { Running: true, Status: "running", Health: { Status: "unhealthy" } },
      })),
    };

    await expect(
      waitForWorkerReadiness(docker as never, {
        containerName: "nouva-worker-svc_1-dep_1-0",
        hasHealthcheck: true,
      })
    ).rejects.toThrow("became unhealthy");
  });
});

describe("worker convergence and cleanup", () => {
  test("converges 1 to 3 to 1 replicas without any ingress runtime", async () => {
    const { containers, docker } = createRuntimeDocker();
    const payload = { ...workerPayload, healthCheckCommand: "true" };

    await deployWorkerRuntime(docker as never, environment, payload);
    expect(containers.size).toBe(1);

    const scaleUp = await deployWorkerRuntime(docker as never, environment, {
      ...payload,
      replicaCount: 3,
    });
    expect(containers.size).toBe(3);
    expect(scaleUp.runtimeInstances).toHaveLength(3);
    expect(docker.ensureNetwork).toHaveBeenCalled();

    const scaleDown = await deployWorkerRuntime(docker as never, environment, payload);
    expect(containers.size).toBe(1);
    expect(scaleDown.runtimeInstances).toHaveLength(1);
    expect(docker.killContainer).toHaveBeenCalledWith("ctr_worker_2", "SIGTERM");
    expect(docker.killContainer).toHaveBeenCalledWith("ctr_worker_3", "SIGTERM");
    expect(docker.removeContainer).toHaveBeenCalledWith("ctr_worker_2", false);
    expect(docker.removeContainer).toHaveBeenCalledWith("ctr_worker_3", false);
    expect(scaleDown.rollout).toEqual(
      expect.objectContaining({
        strategy: "candidate_ready_cutover",
        shutdowns: [
          expect.objectContaining({
            containerName: "nouva-worker-svc_1-dep_1-1",
            role: "surplus",
            outcome: "exited",
          }),
          expect.objectContaining({
            containerName: "nouva-worker-svc_1-dep_1-2",
            role: "surplus",
            outcome: "exited",
          }),
        ],
      })
    );
  });

  test("recreates a replica a scale-down stopped instead of restarting it on scale-up", async () => {
    const { containers, docker, events, restartPolicies } = createRuntimeDocker();
    const payload = { ...workerPayload, healthCheckCommand: "true", replicaCount: 2 };
    await deployWorkerRuntime(docker as never, environment, payload);
    // A scale-down stopped replica 1 gracefully (restart policy "no") but never removed it.
    const keptName = "nouva-worker-svc_1-dep_1-0";
    const retiredName = "nouva-worker-svc_1-dep_1-1";
    const retiredId = containers.get(retiredName)?.Id;
    await docker.updateContainerRestartPolicy(retiredName, "no");
    await docker.killContainer(retiredName, "SIGTERM");
    events.length = 0;

    await deployWorkerRuntime(docker as never, environment, payload);

    expect(events).toEqual([`start ${keptName}`, `remove ${retiredName}`, `start ${retiredName}`]);
    expect(containers.get(retiredName)?.Id).not.toBe(retiredId);
    expect(containers.get(retiredName)?.State?.Running).toBe(true);
    expect(restartPolicies.get(keptName)).toBe("unless-stopped");
  });

  test("resets an incomplete volume candidate before retrying the single-writer cutover", async () => {
    const { containers, docker } = createRuntimeDocker();
    const volume = {
      volumeId: "vol_1",
      volumeName: "nouva-vol-1",
      mountPath: "/data",
    };
    await deployWorkerRuntime(docker as never, environment, {
      ...workerPayload,
      deploymentId: "dep_old",
      imageUrl: "registry.example/nouva-worker:dep_old",
      healthCheckCommand: "true",
      volume,
    });

    const candidateName = buildWorkerReplicaContainerName("svc_1", "dep_new", 0);
    containers.set(candidateName, {
      Id: "ctr_incomplete_candidate",
      Name: candidateName,
      Config: {
        Image: "registry.example/nouva-worker:dep_new",
        Labels: {
          "nouva.managed": "true",
          "nouva.kind": "worker",
          "nouva.service.type": "worker",
          "nouva.project.id": "proj_1",
          "nouva.service.id": "svc_1",
          "nouva.deployment.id": "dep_new",
          "nouva.replica.index": "0",
        },
      },
      Mounts: [{ Name: volume.volumeName }],
      State: { Running: true, Status: "running", Health: { Status: "healthy" } },
    });

    const result = await deployWorkerRuntime(docker as never, environment, {
      ...workerPayload,
      deploymentId: "dep_new",
      imageUrl: "registry.example/nouva-worker:dep_new",
      healthCheckCommand: "true",
      volume,
    });

    expect(docker.killContainer).toHaveBeenCalledWith("ctr_incomplete_candidate", "SIGTERM");
    expect(docker.removeContainer).toHaveBeenCalledWith("ctr_incomplete_candidate", false);
    expect(containers.has("nouva-worker-svc_1-dep_old-0")).toBe(false);
    expect(containers.has(candidateName)).toBe(true);
    expect(result.rollout).toEqual(
      expect.objectContaining({ outcome: "committed", strategy: "single_writer_snapshot_cutover" })
    );
  });

  test("discovers every worker replica by managed labels before issuing plural cleanup proof", async () => {
    const { containers, docker } = createRuntimeDocker();
    await deployWorkerRuntime(docker as never, environment, {
      ...workerPayload,
      replicaCount: 2,
      healthCheckCommand: "true",
    });

    const result = await removeWorkerServiceRuntime(docker as never, {
      serviceId: "svc_1",
      runtimeMetadata: {
        imageStoreMode: "docker-local",
        currentImage: { reference: "registry.example/nouva-worker:dep_1", imageId: "img_worker_1" },
        previousImage: {
          reference: "registry.example/nouva-worker:old",
          imageId: "img_worker_old",
        },
      },
    });

    expect(containers.size).toBe(0);
    expect(result.cleanupProof).toEqual({
      version: 1,
      kind: "delete_worker",
      serviceContainers: { serviceId: "svc_1", remainingContainerIds: [] },
      containers: [
        { identifier: "ctr_worker_1", absent: true },
        { identifier: "ctr_worker_2", absent: true },
      ],
      retainedImages: [
        { reference: "registry.example/nouva-worker:dep_1", absent: true },
        { reference: "registry.example/nouva-worker:old", absent: true },
      ],
    });
  });

  test("scales to zero even when a scheduled-only image is no longer local", async () => {
    const { containers, docker } = createRuntimeDocker();
    await deployWorkerRuntime(docker as never, environment, {
      ...workerPayload,
      healthCheckCommand: "true",
    });
    docker.inspectImage.mockImplementation(async () => null);

    const result = await deployWorkerRuntime(docker as never, environment, {
      ...workerPayload,
      replicaCount: 0,
      runtimeMetadata: {
        imageStoreMode: "docker-local",
        currentImage: {
          reference: workerPayload.imageUrl,
          imageId: "img_worker_1",
          deploymentId: "dep_1",
          commitHash: "abc123",
        },
      },
    });

    expect(containers.size).toBe(0);
    expect(result.runtimeInstances).toEqual([]);
  });
});

describe("worker rollout ordering and graceful retirement", () => {
  const oldName = buildWorkerReplicaContainerName("svc_1", "dep_old", 0);
  const newName = buildWorkerReplicaContainerName("svc_1", "dep_new", 0);

  function releasePayload(
    deploymentId: string,
    shutdownPolicy: WorkerDeployOnlyPayload["shutdownPolicy"]
  ): WorkerDeployOnlyPayload {
    return {
      ...workerPayload,
      deploymentId,
      imageUrl: `registry.example/nouva-worker:${deploymentId}`,
      healthCheckCommand: "true",
      shutdownPolicy,
    };
  }

  async function runningOldVersion(shutdownPolicy: WorkerDeployOnlyPayload["shutdownPolicy"]) {
    const fake = createRuntimeDocker();
    await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_old", shutdownPolicy),
      { clock: fake.clock }
    );
    fake.events.length = 0;
    return fake;
  }

  const overlap = { signal: "SIGTERM", gracePeriodSeconds: 30, rolloutPolicy: "overlap" } as const;
  const noOverlap = { ...overlap, rolloutPolicy: "no_overlap" } as const;

  test("overlap starts the new version first, then signals the old one and waits for it", async () => {
    const fake = await runningOldVersion(overlap);
    const progress: string[] = [];

    const result = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_new", overlap),
      { clock: fake.clock, onProgress: (line) => progress.push(line) }
    );

    expect(fake.events).toEqual([`start ${newName}`, `SIGTERM ${oldName}`, `remove ${oldName}`]);
    expect(fake.forcedRemovalsOfRunningContainers).toEqual([]);
    expect(fake.restartPolicies.get(oldName)).toBe("no");
    expect(result.rollout).toEqual(
      expect.objectContaining({
        strategy: "candidate_ready_cutover",
        outcome: "committed",
        policy: overlap,
        shutdowns: [
          expect.objectContaining({ containerName: oldName, outcome: "exited", exitCode: 0 }),
        ],
      })
    );
    expect(progress).toContain(`Worker ${oldName} exited 0.0s after SIGTERM (exit code 0)`);
  });

  test("an old worker is treated like overlap when an older control plane sends no policy", async () => {
    const fake = await runningOldVersion(undefined);

    const result = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_new", undefined),
      { clock: fake.clock }
    );

    expect(fake.events).toEqual([`start ${newName}`, `SIGTERM ${oldName}`, `remove ${oldName}`]);
    expect(result.rollout).toEqual(
      expect.objectContaining({ policy: { ...overlap, signal: null } })
    );
  });

  test("a worker that keeps its image's signal is retired with the image's STOPSIGNAL", async () => {
    const inherit = { ...overlap, signal: null } as const;
    const fake = createRuntimeDocker();
    fake.imageStopSignals.set("registry.example/nouva-worker:dep_old", "SIGQUIT");
    await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_old", inherit),
      {
        clock: fake.clock,
      }
    );
    expect(fake.containers.get(oldName)?.Config?.StopSignal).toBe("SIGQUIT");
    fake.events.length = 0;

    const result = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_new", inherit),
      { clock: fake.clock }
    );

    expect(fake.events).toEqual([`start ${newName}`, `SIGQUIT ${oldName}`, `remove ${oldName}`]);
    expect(result.rollout).toEqual(
      expect.objectContaining({
        shutdowns: [expect.objectContaining({ containerName: oldName, signal: "SIGQUIT" })],
      })
    );
  });

  test("a chosen signal overrides the image's STOPSIGNAL", async () => {
    const fake = createRuntimeDocker();
    fake.imageStopSignals.set("registry.example/nouva-worker:dep_old", "SIGQUIT");
    await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_old", { ...overlap, signal: null }),
      { clock: fake.clock }
    );
    fake.events.length = 0;

    await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_new", { ...overlap, signal: "SIGINT" }),
      { clock: fake.clock }
    );

    expect(fake.events).toEqual([`start ${newName}`, `SIGINT ${oldName}`, `remove ${oldName}`]);
  });

  test("reports a forced kill when the old worker outlives its grace period", async () => {
    const fake = await runningOldVersion(overlap);
    fake.signalBehavior.set(oldName, "ignores");

    const result = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_new", overlap),
      { clock: fake.clock }
    );

    expect(fake.events).toEqual([
      `start ${newName}`,
      `SIGTERM ${oldName}`,
      `SIGKILL ${oldName}`,
      `remove ${oldName}`,
    ]);
    expect(result.rollout).toEqual(
      expect.objectContaining({
        outcome: "committed",
        shutdowns: [
          {
            containerName: oldName,
            role: "previous",
            signal: "SIGTERM",
            gracePeriodSeconds: 30,
            outcome: "forced",
            exitCode: 137,
            elapsedMs: 30_000,
          },
        ],
      })
    );
  });

  test("keeps the rollout committed but reports an old worker that survives SIGKILL", async () => {
    const fake = await runningOldVersion(overlap);
    fake.signalBehavior.set(oldName, "survives_sigkill");

    const result = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_new", overlap),
      { clock: fake.clock }
    );

    expect(fake.containers.has(oldName)).toBe(true);
    expect(fake.forcedRemovalsOfRunningContainers).toEqual([]);
    expect(result.rollout).toEqual(
      expect.objectContaining({
        outcome: "committed",
        shutdowns: [expect.objectContaining({ containerName: oldName, outcome: "hung" })],
      })
    );
  });

  test("no_overlap confirms the old worker stopped before the new one starts", async () => {
    const fake = await runningOldVersion(noOverlap);

    const result = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_new", noOverlap),
      { clock: fake.clock }
    );

    expect(fake.events).toEqual([`SIGTERM ${oldName}`, `start ${newName}`, `remove ${oldName}`]);
    expect(result.rollout).toEqual(
      expect.objectContaining({
        strategy: "stop_first_cutover",
        outcome: "committed",
        shutdowns: [expect.objectContaining({ containerName: oldName, outcome: "exited" })],
      })
    );
  });

  test("no_overlap waits out the grace period and force-kills before starting the new one", async () => {
    const fake = await runningOldVersion(noOverlap);
    fake.signalBehavior.set(oldName, "ignores");

    const result = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_new", noOverlap),
      { clock: fake.clock }
    );

    expect(fake.events).toEqual([
      `SIGTERM ${oldName}`,
      `SIGKILL ${oldName}`,
      `start ${newName}`,
      `remove ${oldName}`,
    ]);
    expect(result.rollout).toEqual(
      expect.objectContaining({
        shutdowns: [expect.objectContaining({ outcome: "forced", elapsedMs: 30_000 })],
      })
    );
  });

  test("no_overlap never starts the new version while the old one refuses to stop", async () => {
    const fake = await runningOldVersion(noOverlap);
    fake.signalBehavior.set(oldName, "survives_sigkill");

    const failure = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_new", noOverlap),
      { clock: fake.clock }
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WorkerRolloutError);
    expect((failure as Error).message).toContain(
      `Previous worker ${oldName} did not stop even after SIGKILL, so the new version was not started`
    );
    expect(fake.events).toEqual([`SIGTERM ${oldName}`, `SIGKILL ${oldName}`]);
    expect(fake.containers.has(newName)).toBe(false);
    expect((failure as WorkerRolloutError).result.rollout).toEqual(
      expect.objectContaining({
        outcome: "aborted_before_cutover",
        currentPhase: "restore",
        shutdowns: [expect.objectContaining({ outcome: "hung" })],
      })
    );
  });

  test("no_overlap hands the service back to the old version when the new one fails", async () => {
    const fake = await runningOldVersion(noOverlap);
    fake.docker.ensureContainer.mockImplementation(async (spec: DockerContainerSpec) => {
      fake.events.push(`start ${spec.name}`);
      fake.containers.set(spec.name, {
        Id: "ctr_crashing",
        Name: spec.name,
        Config: { Image: spec.image, Labels: spec.labels },
        State: { Running: false, Status: "exited", ExitCode: 1 },
      });
      return "ctr_crashing";
    });

    const failure = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_new", noOverlap),
      { clock: fake.clock }
    ).catch((error: unknown) => error);

    expect(fake.events).toEqual([
      `SIGTERM ${oldName}`,
      `start ${newName}`,
      `remove ${newName}`,
      `start ${oldName}`,
    ]);
    expect(fake.restartPolicies.get(oldName)).toBe("unless-stopped");
    expect(fake.containers.get(oldName)?.State?.Running).toBe(true);
    expect((failure as WorkerRolloutError).result.rollout).toEqual(
      expect.objectContaining({
        strategy: "stop_first_cutover",
        outcome: "aborted_before_cutover",
        liveRuntimePreserved: true,
        rollbackCompleted: true,
        activeContainerNames: [oldName],
      })
    );
  });

  test("recreates a stopped candidate from an earlier attempt instead of restarting it", async () => {
    const fake = await runningOldVersion(overlap);
    // An earlier attempt's candidate was stopped gracefully, which switched its restart policy off.
    await fake.docker.ensureContainer(
      buildWorkerContainerSpec({
        environment,
        payload: releasePayload("dep_new", overlap),
        image: workerImage,
        replicaIndex: 0,
      }).spec
    );
    const staleId = fake.containers.get(newName)?.Id;
    await fake.docker.updateContainerRestartPolicy(newName, "no");
    await fake.docker.killContainer(newName, "SIGTERM");
    fake.events.length = 0;

    const result = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_new", overlap),
      { clock: fake.clock }
    );

    expect(fake.events).toEqual([
      `remove ${newName}`,
      `start ${newName}`,
      `SIGTERM ${oldName}`,
      `remove ${oldName}`,
    ]);
    expect(fake.containers.get(newName)?.Id).not.toBe(staleId);
    expect(fake.containers.get(newName)?.State?.Running).toBe(true);
    expect(result.rollout).toEqual(expect.objectContaining({ outcome: "committed" }));
  });

  test("gracefully stops and reports a candidate that fails readiness", async () => {
    const fake = await runningOldVersion(overlap);
    fake.signalBehavior.set(newName, "ignores");
    fake.docker.ensureContainer.mockImplementation(async (spec: DockerContainerSpec) => {
      fake.events.push(`start ${spec.name}`);
      fake.containers.set(spec.name, {
        Id: "ctr_unhealthy",
        Name: spec.name,
        Config: { Image: spec.image, Labels: spec.labels },
        State: { Running: true, Status: "running", Health: { Status: "unhealthy" } },
      });
      return "ctr_unhealthy";
    });

    const failure = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_new", overlap),
      { clock: fake.clock }
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WorkerRolloutError);
    expect(fake.events).toEqual([
      `start ${newName}`,
      `SIGTERM ${newName}`,
      `SIGKILL ${newName}`,
      `remove ${newName}`,
    ]);
    expect(fake.forcedRemovalsOfRunningContainers).toEqual([]);
    expect(fake.containers.get(oldName)?.State?.Running).toBe(true);
    expect((failure as WorkerRolloutError).result.rollout).toEqual(
      expect.objectContaining({
        outcome: "aborted_before_cutover",
        liveRuntimePreserved: true,
        shutdowns: [
          expect.objectContaining({
            containerName: newName,
            role: "candidate",
            outcome: "forced",
            exitCode: 137,
          }),
        ],
      })
    );
  });

  test("recovers an overlap rollout the agent restarted in the middle of", async () => {
    const fake = await runningOldVersion(overlap);
    // The interrupted attempt started the new version but never retired the old one.
    await fake.docker.ensureContainer(
      buildWorkerContainerSpec({
        environment,
        payload: releasePayload("dep_new", overlap),
        image: workerImage,
        replicaIndex: 0,
      }).spec
    );
    fake.events.length = 0;
    const created = fake.containers.size;

    const result = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_new", overlap),
      { clock: fake.clock }
    );

    expect(created).toBe(2);
    expect(fake.events).toEqual([`start ${newName}`, `SIGTERM ${oldName}`, `remove ${oldName}`]);
    expect([...fake.containers.keys()]).toEqual([newName]);
    expect(result.rollout).toEqual(expect.objectContaining({ outcome: "committed" }));
  });

  test("recovers a no_overlap rollout the agent restarted in the middle of", async () => {
    const fake = await runningOldVersion(noOverlap);
    // The interrupted attempt stopped the old version and started the new one, then died.
    await fake.docker.killContainer(oldName, "SIGTERM");
    await fake.docker.updateContainerRestartPolicy(oldName, "no");
    await fake.docker.ensureContainer(
      buildWorkerContainerSpec({
        environment,
        payload: releasePayload("dep_new", noOverlap),
        image: workerImage,
        replicaIndex: 0,
      }).spec
    );
    fake.events.length = 0;

    const result = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      releasePayload("dep_new", noOverlap),
      { clock: fake.clock }
    );

    // The old version is already stopped, so nothing can overlap: its container is a leftover and
    // the running new version is adopted rather than restarted.
    expect(fake.events).toEqual([`remove ${oldName}`, `start ${newName}`]);
    expect(result.rollout).toEqual(
      expect.objectContaining({
        strategy: "candidate_ready_cutover",
        outcome: "committed",
        shutdowns: [],
      })
    );
  });
});

describe("worker rollouts around stopped leftovers", () => {
  const replicaName = (deploymentId: string, index: number) =>
    buildWorkerReplicaContainerName("svc_1", deploymentId, index);
  const noOverlap = {
    signal: "SIGTERM",
    gracePeriodSeconds: 30,
    rolloutPolicy: "no_overlap",
  } as const;

  function release(
    deploymentId: string,
    replicaCount: number,
    shutdownPolicy: WorkerDeployOnlyPayload["shutdownPolicy"] = noOverlap
  ): WorkerDeployOnlyPayload {
    return {
      ...workerPayload,
      deploymentId,
      imageUrl: `registry.example/nouva-worker:${deploymentId}`,
      healthCheckCommand: "true",
      replicaCount,
      shutdownPolicy,
    };
  }

  /** Deploys `payload` and returns it as the control plane would record it: the live runtime. */
  async function deployLive(
    fake: ReturnType<typeof createRuntimeDocker>,
    payload: WorkerDeployOnlyPayload
  ): Promise<WorkerDeployOnlyPayload["runtimeMetadata"]> {
    const result = await deployWorkerRuntime(fake.docker as never, environment, payload, {
      clock: fake.clock,
    });
    return result.runtimeMetadata as WorkerDeployOnlyPayload["runtimeMetadata"];
  }

  /** Makes the next ensureContainer create a candidate that exits at once. */
  function crashNextCandidates(fake: ReturnType<typeof createRuntimeDocker>): void {
    fake.docker.ensureContainer.mockImplementation(async (spec: DockerContainerSpec) => {
      fake.events.push(`start ${spec.name}`);
      fake.containers.set(spec.name, {
        Id: "ctr_crashing",
        Name: spec.name,
        Config: { Image: spec.image, Labels: spec.labels },
        State: { Running: false, Status: "exited", ExitCode: 1 },
      });
      return "ctr_crashing";
    });
  }

  function addStoppedLeftover(
    fake: ReturnType<typeof createRuntimeDocker>,
    deploymentId: string
  ): string {
    const name = replicaName(deploymentId, 0);
    fake.containers.set(name, {
      Id: `ctr_leftover_${deploymentId}`,
      Name: name,
      Config: {
        Image: `registry.example/nouva-worker:${deploymentId}`,
        Labels: {
          "nouva.managed": "true",
          "nouva.kind": "worker",
          "nouva.service.id": "svc_1",
          "nouva.deployment.id": deploymentId,
        },
      },
      State: { Running: false, Status: "exited", ExitCode: 137 },
    });
    return name;
  }

  test("a restart removes a stopped older leftover and restarts only the live replicas", async () => {
    const fake = createRuntimeDocker();
    const runtimeMetadata = await deployLive(fake, release("dep_2", 2));
    const leftover = addStoppedLeftover(fake, "dep_1");

    const result = await restartWorkerServiceRuntime(fake.docker as never, {
      serviceId: "svc_1",
      runtimeMetadata,
    });

    const live = [replicaName("dep_2", 0), replicaName("dep_2", 1)];
    const restarted = fake.docker.restartContainer.mock.calls.map(([identifier]) => identifier);
    expect(restarted).not.toContain(`ctr_leftover_dep_1`);
    expect(restarted).toHaveLength(2);
    expect(fake.containers.has(leftover)).toBe(false);
    expect(
      (result.runtimeInstances as { containerName: string }[]).map((i) => i.containerName)
    ).toEqual(live);
  });

  test("a restart leaves a still-running older container alone and does not report it", async () => {
    const fake = createRuntimeDocker();
    const runtimeMetadata = await deployLive(fake, release("dep_2", 1));
    const hung = addStoppedLeftover(fake, "dep_1");
    const hungContainer = fake.containers.get(hung);
    if (!hungContainer) throw new Error("missing hung container");
    hungContainer.State = { Running: true, Status: "running" };

    const result = await restartWorkerServiceRuntime(fake.docker as never, {
      serviceId: "svc_1",
      runtimeMetadata,
    });

    const restarted = fake.docker.restartContainer.mock.calls.map(([identifier]) => identifier);
    expect(restarted).not.toContain("ctr_leftover_dep_1");
    expect(restarted).toHaveLength(1);
    expect(fake.containers.has(hung)).toBe(true);
    expect(fake.docker.removeContainer.mock.calls.map(([identifier]) => identifier)).not.toContain(
      "ctr_leftover_dep_1"
    );
    expect(
      (result.runtimeInstances as { containerName: string }[]).map((i) => i.containerName)
    ).toEqual([replicaName("dep_2", 0)]);
  });

  test("a restart queued before a rollout that replaced its replicas completes as superseded", async () => {
    const fake = createRuntimeDocker();
    const queuedRuntime = await deployLive(fake, release("dep_1", 1));
    const overlap = { ...noOverlap, rolloutPolicy: "overlap" } as const;
    await deployLive(fake, { ...release("dep_2", 1, overlap), runtimeMetadata: queuedRuntime });

    const result = await restartWorkerServiceRuntime(fake.docker as never, {
      serviceId: "svc_1",
      runtimeMetadata: queuedRuntime,
    });

    expect(result).toEqual({ superseded: true });
    expect(fake.docker.restartContainer).not.toHaveBeenCalled();
    expect(fake.containers.has(replicaName("dep_2", 0))).toBe(true);
  });

  test("a restart re-enables the restart policy a graceful stop turned off", async () => {
    const fake = createRuntimeDocker();
    const runtimeMetadata = await deployLive(fake, release("dep_1", 1));
    const name = replicaName("dep_1", 0);
    await fake.docker.updateContainerRestartPolicy(name, "no");

    await restartWorkerServiceRuntime(fake.docker as never, {
      serviceId: "svc_1",
      runtimeMetadata,
    });

    expect(fake.restartPolicies.get(name)).toBe("unless-stopped");
  });

  test.each([
    ["a no_overlap policy", noOverlap, false],
    ["a volume", { ...noOverlap, rolloutPolicy: "overlap" as const }, true],
  ])("a restart refuses to run the live replicas beside a still-running older container under %s", async (_label, shutdownPolicy, withVolume) => {
    const fake = createRuntimeDocker();
    const runtimeMetadata = await deployLive(fake, release("dep_2", 1));
    const hung = addStoppedLeftover(fake, "dep_1");
    const hungContainer = fake.containers.get(hung);
    if (!hungContainer) throw new Error("missing hung container");
    hungContainer.State = { Running: true, Status: "running" };
    if (withVolume) {
      hungContainer.HostConfig = {
        Mounts: [{ Type: "volume", Source: "nouva-vol-1", Target: "/data" }],
      };
    }

    await expect(
      restartWorkerServiceRuntime(fake.docker as never, {
        serviceId: "svc_1",
        runtimeMetadata,
        shutdownPolicy,
      })
    ).rejects.toThrow(`still runs ${hung} outside its live runtime`);
    expect(fake.docker.restartContainer).not.toHaveBeenCalled();
  });

  test("a no_overlap scale-up removes a stopped older leftover instead of restarting replicas", async () => {
    const fake = createRuntimeDocker();
    const runtimeMetadata = await deployLive(fake, release("dep_1", 2));
    const leftover = addStoppedLeftover(fake, "dep_0");
    fake.events.length = 0;

    const result = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      { ...release("dep_1", 3), runtimeMetadata },
      { clock: fake.clock }
    );

    expect(fake.events).toEqual([
      `remove ${leftover}`,
      `start ${replicaName("dep_1", 0)}`,
      `start ${replicaName("dep_1", 1)}`,
      `start ${replicaName("dep_1", 2)}`,
    ]);
    expect(fake.docker.killContainer).not.toHaveBeenCalled();
    expect(result.rollout).toEqual(
      expect.objectContaining({ strategy: "candidate_ready_cutover", shutdowns: [] })
    );
  });

  test("a failed stop-first rollout restarts only the containers it stopped", async () => {
    const fake = createRuntimeDocker();
    const runtimeMetadata = await deployLive(fake, release("dep_1", 1));
    // dep_0 exited after the listing saw it running, so the rollout finds it already stopped.
    const leftover = addStoppedLeftover(fake, "dep_0");
    const listed = [...fake.containers.values()].map((container) =>
      container.Name === leftover
        ? { ...container, State: { Running: true, Status: "running" } }
        : container
    );
    fake.docker.listContainersByLabels.mockImplementationOnce(async () => listed);
    crashNextCandidates(fake);
    fake.events.length = 0;

    const failure = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      { ...release("dep_2", 1), runtimeMetadata },
      { clock: fake.clock }
    ).catch((error: unknown) => error);

    const previous = replicaName("dep_1", 0);
    expect(fake.events).toEqual([
      `SIGTERM ${previous}`,
      `start ${replicaName("dep_2", 0)}`,
      `remove ${replicaName("dep_2", 0)}`,
      `start ${previous}`,
    ]);
    expect(fake.containers.get(leftover)?.State?.Running).toBe(false);
    expect(fake.restartPolicies.has(leftover)).toBe(false);
    expect((failure as WorkerRolloutError).result.rollout).toEqual(
      expect.objectContaining({
        outcome: "aborted_before_cutover",
        liveRuntimePreserved: true,
        rollbackCompleted: true,
        shutdowns: expect.arrayContaining([
          expect.objectContaining({ containerName: leftover, outcome: "already_stopped" }),
        ]),
      })
    );
  });

  test.each([
    ["a no_overlap worker", null],
    ["a volume worker", { volumeId: "vol_1", volumeName: "nouva-vol-1", mountPath: "/data" }],
  ])("restores %s whose rollout the agent restarted after stopping it", async (_label, volume) => {
    const fake = createRuntimeDocker();
    const releaseWith = (deploymentId: string) => ({ ...release(deploymentId, 1), volume });
    const runtimeMetadata = await deployLive(fake, releaseWith("dep_1"));
    const previous = replicaName("dep_1", 0);
    const candidate = replicaName("dep_2", 0);
    // The interrupted attempt stopped dep_1 and started dep_2, then the agent restarted before
    // dep_2 was ready, so the control plane still records dep_1 as live.
    await fake.docker.updateContainerRestartPolicy(previous, "no");
    await fake.docker.killContainer(previous, "SIGTERM");
    await fake.docker.ensureContainer(
      buildWorkerContainerSpec({
        environment,
        payload: releaseWith("dep_2"),
        image: workerImage,
        replicaIndex: 0,
      }).spec
    );
    crashNextCandidates(fake);
    fake.events.length = 0;

    const failure = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      { ...releaseWith("dep_2"), runtimeMetadata },
      { clock: fake.clock }
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WorkerRolloutError);
    expect(fake.events.filter((event) => event.includes("nouva-worker-svc_1"))).toEqual([
      `SIGTERM ${candidate}`,
      `remove ${candidate}`,
      `start ${candidate}`,
      `remove ${candidate}`,
      `start ${previous}`,
    ]);
    expect(fake.containers.get(previous)?.State?.Running).toBe(true);
    expect(fake.restartPolicies.get(previous)).toBe("unless-stopped");
    const volumeTasks = fake.docker.createContainer.mock.calls.map(([spec]) => spec.name);
    expect(volumeTasks.some((name) => name.startsWith("nouva-worker-restore-"))).toBe(
      volume !== null
    );
    expect((failure as WorkerRolloutError).result.rollout).toEqual(
      expect.objectContaining({
        strategy: volume ? "single_writer_snapshot_cutover" : "stop_first_cutover",
        outcome: "aborted_before_cutover",
        liveRuntimePreserved: true,
        rollbackCompleted: true,
        activeContainerNames: [previous],
      })
    );
  });

  describe("the volume snapshot of a failed stop-first rollout", () => {
    const volume = { volumeId: "vol_1", volumeName: "nouva-vol-1", mountPath: "/data" };
    const slot = "svc_1-dep_2.tar.gz";

    /** The shell commands of the agent's volume tasks, by task name prefix. */
    function volumeTaskCommands(fake: ReturnType<typeof createRuntimeDocker>, prefix: string) {
      return fake.docker.createContainer.mock.calls
        .map(([spec]) => spec)
        .filter((spec) => spec.name.startsWith(prefix))
        .map((spec) => spec.cmd?.join(" ") ?? "");
    }

    async function failRollout(
      fake: ReturnType<typeof createRuntimeDocker>,
      breakCandidate: () => void
    ) {
      const runtimeMetadata = await deployLive(fake, { ...release("dep_1", 1), volume });
      fake.docker.createContainer.mockClear();
      breakCandidate();
      const progress: string[] = [];
      const failure = await deployWorkerRuntime(
        fake.docker as never,
        environment,
        { ...release("dep_2", 1), volume, runtimeMetadata },
        { clock: fake.clock, onProgress: (line) => progress.push(line) }
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(WorkerRolloutError);
      return { failure: failure as WorkerRolloutError, progress };
    }

    test("is deleted once it has been restored", async () => {
      const fake = createRuntimeDocker();
      const { failure } = await failRollout(fake, () => crashNextCandidates(fake));

      expect(volumeTaskCommands(fake, "nouva-worker-restore-")).toHaveLength(1);
      expect(volumeTaskCommands(fake, "nouva-worker-snapshot-cleanup-")).toEqual([
        `rm -f /agent-data/worker-volume-snapshots/${slot}`,
      ]);
      expect(volumeTaskCommands(fake, "nouva-worker-snapshot-keep-")).toEqual([]);
      expect(failure.message).not.toContain("kept at");
    });

    test("is kept for recovery when the restore fails", async () => {
      const fake = createRuntimeDocker();
      const createTask = fake.docker.createContainer.getMockImplementation();
      const { failure, progress } = await failRollout(fake, () => {
        crashNextCandidates(fake);
        fake.docker.createContainer.mockImplementation(async (spec: DockerContainerSpec) => {
          if (spec.name.startsWith("nouva-worker-restore-")) throw new Error("disk full");
          return (createTask as (spec: DockerContainerSpec) => Promise<string>)(spec);
        });
      });

      const kept = `worker-volume-snapshots/kept/svc_1-dep_2-${fake.clock.now()}.tar.gz`;
      expect(volumeTaskCommands(fake, "nouva-worker-snapshot-cleanup-")).toEqual([]);
      expect(volumeTaskCommands(fake, "nouva-worker-snapshot-keep-")).toEqual([
        "mkdir -p /agent-data/worker-volume-snapshots/kept\n" +
          `mv /agent-data/worker-volume-snapshots/${slot} /agent-data/${kept}`,
      ]);
      expect(failure.message).toContain(`kept at ${kept} in the agent data volume`);
      expect(progress.some((line) => line.includes(`kept at ${kept}`))).toBe(true);
    });

    test("is kept for recovery when the restore is skipped because a candidate may still run", async () => {
      const fake = createRuntimeDocker();
      const { failure } = await failRollout(fake, () => {
        startUnhealthyCandidates(fake);
        fake.signalBehavior.set(replicaName("dep_2", 0), "survives_sigkill");
      });

      expect(volumeTaskCommands(fake, "nouva-worker-restore-")).toEqual([]);
      expect(volumeTaskCommands(fake, "nouva-worker-snapshot-cleanup-")).toEqual([]);
      expect(volumeTaskCommands(fake, "nouva-worker-snapshot-keep-")).toHaveLength(1);
      expect(failure.message).toContain("worker-volume-snapshots/kept/svc_1-dep_2-");
    });
  });

  /** Makes the next ensureContainer create a candidate that runs but reports unhealthy. */
  function startUnhealthyCandidates(fake: ReturnType<typeof createRuntimeDocker>): void {
    fake.docker.ensureContainer.mockImplementation(async (spec: DockerContainerSpec) => {
      fake.events.push(`start ${spec.name}`);
      fake.containers.set(spec.name, {
        Id: `ctr_unhealthy_${spec.name}`,
        Name: spec.name,
        Config: { Image: spec.image, Labels: spec.labels },
        State: { Running: true, Status: "running", Health: { Status: "unhealthy" } },
      });
      return `ctr_unhealthy_${spec.name}`;
    });
  }

  test("still restores the previous version when stopping a failed candidate errors", async () => {
    const fake = createRuntimeDocker();
    const runtimeMetadata = await deployLive(fake, release("dep_1", 1));
    const previous = replicaName("dep_1", 0);
    const candidate = replicaName("dep_2", 0);
    startUnhealthyCandidates(fake);
    const kill = fake.docker.killContainer.getMockImplementation();
    fake.docker.killContainer.mockImplementation(async (identifier: string, signal: string) => {
      if (identifier.includes(candidate)) {
        throw new Error("Docker API 500 on kill");
      }
      return (await kill?.(identifier, signal)) ?? false;
    });
    fake.events.length = 0;

    const failure = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      { ...release("dep_2", 1), runtimeMetadata },
      { clock: fake.clock }
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WorkerRolloutError);
    expect(fake.forcedRemovalsOfRunningContainers).toEqual([candidate]);
    expect(fake.containers.has(candidate)).toBe(false);
    expect(fake.containers.get(previous)?.State?.Running).toBe(true);
    expect(fake.restartPolicies.get(previous)).toBe("unless-stopped");
    expect((failure as WorkerRolloutError).result.rollout).toEqual(
      expect.objectContaining({
        outcome: "aborted_before_cutover",
        liveRuntimePreserved: true,
        rollbackCompleted: true,
        shutdowns: [
          expect.objectContaining({ containerName: previous, outcome: "exited" }),
          expect.objectContaining({
            containerName: candidate,
            role: "candidate",
            outcome: "unconfirmed",
          }),
        ],
      })
    );
  });

  /**
   * Makes Docker fail on `name` once the rollout has signalled it: every later inspect throws, or
   * only the first one when `once` is set.
   */
  function failInspectAfterSignal(
    fake: ReturnType<typeof createRuntimeDocker>,
    name: string,
    { once = false } = {}
  ): void {
    const inspect = fake.docker.inspectContainer.getMockImplementation();
    const kill = fake.docker.killContainer.getMockImplementation();
    let armed = false;
    fake.docker.killContainer.mockImplementation(async (identifier: string, signal: string) => {
      const result = (await kill?.(identifier, signal)) ?? false;
      if (fake.containers.get(name)?.Id === identifier) armed = true;
      return result;
    });
    fake.docker.inspectContainer.mockImplementation(async (identifier: string) => {
      const container = (await inspect?.(identifier)) ?? null;
      if (armed && container?.Name === name) {
        armed = !once;
        throw new Error("Docker API 500 on inspect");
      }
      return container;
    });
  }

  test("completes the rollout when retiring the old worker fails after the new one is ready", async () => {
    const fake = createRuntimeDocker();
    const overlap = { ...noOverlap, rolloutPolicy: "overlap" } as const;
    const runtimeMetadata = await deployLive(fake, release("dep_1", 1, overlap));
    const previous = replicaName("dep_1", 0);
    const candidate = replicaName("dep_2", 0);
    failInspectAfterSignal(fake, previous);

    const result = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      { ...release("dep_2", 1, overlap), runtimeMetadata },
      { clock: fake.clock }
    );

    expect(fake.containers.has(previous)).toBe(true);
    expect(result.runtimeInstances).toEqual([
      expect.objectContaining({ containerName: candidate }),
    ]);
    expect(result.rollout).toEqual(
      expect.objectContaining({
        outcome: "committed",
        shutdowns: [
          expect.objectContaining({
            containerName: previous,
            role: "previous",
            outcome: "unconfirmed",
          }),
        ],
      })
    );
  });

  test("completes a stop-first rollout when removing the stopped old worker fails", async () => {
    const fake = createRuntimeDocker();
    const runtimeMetadata = await deployLive(fake, release("dep_1", 1));
    const previous = replicaName("dep_1", 0);
    const remove = fake.docker.removeContainer.getMockImplementation();
    fake.docker.removeContainer.mockImplementation(async (identifier: string, force?: boolean) => {
      if (fake.containers.get(previous)?.Id === identifier) {
        throw new Error("Docker API 500 on remove");
      }
      await remove?.(identifier, force);
    });

    const result = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      { ...release("dep_2", 1), runtimeMetadata },
      { clock: fake.clock }
    );

    expect(fake.containers.get(replicaName("dep_2", 0))?.State?.Running).toBe(true);
    expect(result.rollout).toEqual(
      expect.objectContaining({ strategy: "stop_first_cutover", outcome: "committed" })
    );
  });

  test("restarts a previous worker whose stop Docker could not confirm", async () => {
    const fake = createRuntimeDocker();
    const runtimeMetadata = await deployLive(fake, release("dep_1", 1));
    const previous = replicaName("dep_1", 0);
    // The kill works and the worker exits, but the next inspect fails, so the outcome is unknown.
    failInspectAfterSignal(fake, previous, { once: true });
    fake.events.length = 0;

    const failure = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      { ...release("dep_2", 1), runtimeMetadata },
      { clock: fake.clock }
    ).catch((error: unknown) => error);

    expect((failure as Error).message).toContain(
      `Previous worker ${previous} could not be confirmed stopped`
    );
    expect(fake.events).toEqual([`SIGTERM ${previous}`, `start ${previous}`]);
    expect(fake.containers.get(previous)?.State?.Running).toBe(true);
    expect(fake.restartPolicies.get(previous)).toBe("unless-stopped");
    expect((failure as WorkerRolloutError).result.rollout).toEqual(
      expect.objectContaining({
        outcome: "aborted_before_cutover",
        liveRuntimePreserved: true,
        shutdowns: [expect.objectContaining({ containerName: previous, outcome: "unconfirmed" })],
      })
    );
  });

  test("gives a previous worker its restart policy back when the kill fails", async () => {
    const fake = createRuntimeDocker();
    const runtimeMetadata = await deployLive(fake, release("dep_1", 1));
    const previous = replicaName("dep_1", 0);
    fake.docker.killContainer.mockImplementation(async () => {
      throw new Error("Docker API 500 on kill");
    });
    fake.events.length = 0;

    const failure = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      { ...release("dep_2", 1), runtimeMetadata },
      { clock: fake.clock }
    ).catch((error: unknown) => error);

    expect(fake.events).toEqual([]);
    expect(fake.containers.get(previous)?.State?.Running).toBe(true);
    expect(fake.restartPolicies.get(previous)).toBe("unless-stopped");
    expect((failure as WorkerRolloutError).result.rollout).toEqual(
      expect.objectContaining({
        outcome: "aborted_before_cutover",
        liveRuntimePreserved: true,
        activeContainerNames: [previous],
      })
    );
  });

  test("treats a retired replica of the recorded deployment as a leftover, not as live", async () => {
    const fake = createRuntimeDocker();
    await deployLive(fake, release("dep_1", 3));
    // Scaling down to one stopped replicas 1 and 2, but replica 1 was never removed.
    const runtimeMetadata = await deployLive(fake, release("dep_1", 1));
    const kept = replicaName("dep_1", 0);
    const retired = replicaName("dep_1", 1);
    fake.containers.set(retired, {
      Id: "ctr_retired_replica",
      Name: retired,
      Config: {
        Image: "registry.example/nouva-worker:dep_1",
        Labels: {
          "nouva.managed": "true",
          "nouva.kind": "worker",
          "nouva.service.id": "svc_1",
          "nouva.deployment.id": "dep_1",
          "nouva.replica.index": "1",
        },
      },
      State: { Running: false, Status: "exited", ExitCode: 0 },
    });
    crashNextCandidates(fake);
    fake.events.length = 0;

    const failure = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      { ...release("dep_2", 1), runtimeMetadata },
      { clock: fake.clock }
    ).catch((error: unknown) => error);

    expect(fake.events[0]).toBe(`remove ${retired}`);
    expect(fake.events).not.toContain(`start ${retired}`);
    expect(fake.containers.has(retired)).toBe(false);
    expect(fake.containers.get(kept)?.State?.Running).toBe(true);
    expect((failure as WorkerRolloutError).result.rollout).toEqual(
      expect.objectContaining({
        rollbackCompleted: true,
        activeContainerNames: [kept],
      })
    );
    const shutdowns = (failure as WorkerRolloutError).result.rollout.shutdowns;
    expect(shutdowns.map((report) => report.containerName)).not.toContain(retired);
    expect(shutdowns).toContainEqual(
      expect.objectContaining({ containerName: kept, outcome: "exited" })
    );
  });

  test("does not report a stopped recorded version as preserved when an overlap candidate fails", async () => {
    const fake = createRuntimeDocker();
    const overlap = { ...noOverlap, rolloutPolicy: "overlap" } as const;
    const runtimeMetadata = await deployLive(fake, release("dep_1", 1, overlap));
    const previous = replicaName("dep_1", 0);
    // An earlier failed attempt left the recorded live worker stopped.
    await fake.docker.updateContainerRestartPolicy(previous, "no");
    await fake.docker.killContainer(previous, "SIGTERM");
    startUnhealthyCandidates(fake);

    const failure = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      { ...release("dep_2", 1, overlap), runtimeMetadata },
      { clock: fake.clock }
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WorkerRolloutError);
    expect((failure as WorkerRolloutError).result.rollout).toEqual(
      expect.objectContaining({
        strategy: "candidate_ready_cutover",
        outcome: "aborted_before_cutover",
        liveRuntimePreserved: false,
      })
    );
  });

  test("reports the untouched previous version as preserved when a stale candidate hangs", async () => {
    const fake = createRuntimeDocker();
    const volume = { volumeId: "vol_1", volumeName: "nouva-vol-1", mountPath: "/data" };
    const withVolume = (deploymentId: string) => ({ ...release(deploymentId, 1), volume });
    const mountVolume = (name: string) => {
      const container = fake.containers.get(name);
      if (container) container.Mounts = [{ Name: volume.volumeName }];
    };
    const previous = replicaName("dep_1", 0);
    const stale = replicaName("dep_2", 0);
    await deployWorkerRuntime(fake.docker as never, environment, withVolume("dep_1"), {
      clock: fake.clock,
    });
    mountVolume(previous);
    await fake.docker.ensureContainer(
      buildWorkerContainerSpec({
        environment,
        payload: withVolume("dep_2"),
        image: workerImage,
        replicaIndex: 0,
      }).spec
    );
    mountVolume(stale);
    fake.signalBehavior.set(stale, "survives_sigkill");
    fake.events.length = 0;

    const failure = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      withVolume("dep_2"),
      { clock: fake.clock }
    ).catch((error: unknown) => error);

    expect((failure as Error).message).toContain(`Worker ${stale} from an interrupted rollout`);
    expect(fake.events).toEqual([`SIGTERM ${stale}`, `SIGKILL ${stale}`]);
    expect(fake.containers.get(previous)?.State?.Running).toBe(true);
    expect(fake.restartPolicies.has(previous)).toBe(false);
    expect((failure as WorkerRolloutError).result.rollout).toEqual(
      expect.objectContaining({
        outcome: "aborted_before_cutover",
        liveRuntimePreserved: true,
        activeContainerNames: [previous],
      })
    );
  });

  test("signals every replica at once so the rollout waits one grace period, not one each", async () => {
    const fake = createRuntimeDocker();
    const overlap = { ...noOverlap, rolloutPolicy: "overlap" } as const;
    await deployWorkerRuntime(fake.docker as never, environment, release("dep_1", 2, overlap), {
      clock: fake.clock,
    });
    const old = [0, 1].map((index) => replicaName("dep_1", index));
    for (const name of old) {
      fake.signalBehavior.set(name, "ignores");
    }
    fake.events.length = 0;
    const startedAt = fake.clock.now();

    const result = await deployWorkerRuntime(
      fake.docker as never,
      environment,
      release("dep_2", 2, overlap),
      { clock: fake.clock }
    );

    expect(fake.clock.now() - startedAt).toBeLessThanOrEqual(30_000 + 15_000);
    expect(fake.events.filter((event) => event.startsWith("SIG"))).toEqual([
      `SIGTERM ${old[0]}`,
      `SIGTERM ${old[1]}`,
      `SIGKILL ${old[0]}`,
      `SIGKILL ${old[1]}`,
    ]);
    expect(result.rollout).toEqual(
      expect.objectContaining({
        outcome: "committed",
        shutdowns: old.map((containerName) =>
          expect.objectContaining({ containerName, outcome: "forced", exitCode: 137 })
        ),
      })
    );
  });
});

describe("scheduled worker job receipts", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  test("carries a bounded swap allowance into the scheduled job container", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "nouva-worker-job-"));
    tempDirs.push(dataDir);
    const { docker } = createRuntimeDocker();
    const payload: WorkerJobPayload = {
      projectId: "proj_1",
      environmentId: "env_1",
      serviceId: "svc_1",
      deploymentId: "dep_1",
      redactionContextVersion: "hmac-sha256:redaction-context:v1:job",
      scheduleId: "schedule_1",
      scheduleRunId: "run_swap",
      occurrenceKey: "2026-07-27T12:00:00.000Z",
      jobName: "hourly-sync",
      imageUrl: workerPayload.imageUrl,
      envVars: {},
      command: "node dist/sync.js",
      timeoutSeconds: 1800,
      volume: null,
      resourceLimits: { ...resourceLimits, memoryAndSwapBytes: 1024 * 1024 * 1024 },
    };

    await startWorkerJob(docker as never, { ...environment, dataDir }, payload);

    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        hostConfig: expect.objectContaining({
          Memory: 512 * 1024 * 1024,
          MemorySwap: 1024 * 1024 * 1024,
          PidsLimit: 256,
        }),
      })
    );
  });

  test("returns the receipt on retry without starting the user command twice", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "nouva-worker-job-"));
    tempDirs.push(dataDir);
    const { containers, docker } = createRuntimeDocker();
    const payload: WorkerJobPayload = {
      projectId: "proj_1",
      environmentId: "env_1",
      serviceId: "svc_1",
      deploymentId: "dep_1",
      redactionContextVersion: "hmac-sha256:redaction-context:v1:job",
      scheduleId: "schedule_1",
      scheduleRunId: "run_1",
      occurrenceKey: "2026-07-27T12:00:00.000Z",
      jobName: "hourly-sync",
      imageUrl: workerPayload.imageUrl,
      envVars: { NODE_ENV: "production" },
      command: "node dist/sync.js",
      timeoutSeconds: 1800,
      volume: null,
      resourceLimits,
    };
    const jobEnvironment = { ...environment, dataDir };

    const first = await startWorkerJob(docker as never, jobEnvironment, payload);
    const inspection = await inspectWorkerJob(docker as never, jobEnvironment, {
      scheduleRunId: "run_1",
    });
    const second = await startWorkerJob(docker as never, jobEnvironment, payload);

    expect(first.job).toEqual(
      expect.objectContaining({ status: "running", scheduleRunId: "run_1" })
    );
    expect(inspection.job).toEqual(
      expect.objectContaining({
        status: "running",
        occurrenceKey: "2026-07-27T12:00:00.000Z",
        image: workerPayload.imageUrl,
      })
    );
    expect(second.job).toEqual(
      expect.objectContaining({ status: "running", scheduleRunId: "run_1" })
    );
    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    expect(docker.startContainer).toHaveBeenCalledTimes(1);
    expect(
      containers.get(buildWorkerJobContainerName(payload.serviceId, payload.scheduleRunId))?.Config
        ?.Labels
    ).toEqual(
      expect.objectContaining({
        "nouva.redaction.context.version": "hmac-sha256:redaction-context:v1:job",
      })
    );
  });

  test("recovers a labeled container when the agent lost its local receipt", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "nouva-worker-job-"));
    tempDirs.push(dataDir);
    const { docker } = createRuntimeDocker();
    const payload: WorkerJobPayload = {
      projectId: "proj_1",
      environmentId: "env_1",
      serviceId: "svc_1",
      deploymentId: "dep_1",
      scheduleId: "schedule_1",
      scheduleRunId: "run_lost_receipt",
      occurrenceKey: "2026-07-27T12:01:00.000Z",
      jobName: "hourly-sync",
      imageUrl: workerPayload.imageUrl,
      envVars: { NODE_ENV: "production" },
      command: "node dist/sync.js",
      timeoutSeconds: 1800,
      volume: null,
      resourceLimits,
    };
    const jobEnvironment = { ...environment, dataDir };

    await startWorkerJob(docker as never, jobEnvironment, payload);
    await rm(getWorkerJobReceiptPath(dataDir, payload.scheduleRunId), { force: true });
    const recovered = await startWorkerJob(docker as never, jobEnvironment, payload);

    expect(recovered.job).toEqual(
      expect.objectContaining({ status: "running", scheduleRunId: payload.scheduleRunId })
    );
    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    expect(docker.startContainer).toHaveBeenCalledTimes(1);
  });

  test("recovers a terminal no-receipt container before proving cleanup", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "nouva-worker-job-"));
    tempDirs.push(dataDir);
    const { containers, docker } = createRuntimeDocker();
    const payload: WorkerJobPayload = {
      projectId: "proj_1",
      environmentId: "env_1",
      serviceId: "svc_1",
      deploymentId: "dep_1",
      scheduleId: "schedule_1",
      scheduleRunId: "run_cleanup_lost_receipt",
      occurrenceKey: "2026-07-27T12:02:00.000Z",
      jobName: "hourly-sync",
      imageUrl: workerPayload.imageUrl,
      envVars: { NODE_ENV: "production" },
      command: "node dist/sync.js",
      timeoutSeconds: 1800,
      volume: null,
      resourceLimits,
    };
    const jobEnvironment = { ...environment, dataDir };

    const started = await startWorkerJob(docker as never, jobEnvironment, payload);
    const containerId = String((started.job as { containerId: string }).containerId);
    const container = containers.get(
      buildWorkerJobContainerName(payload.serviceId, payload.scheduleRunId)
    );
    if (!container) {
      throw new Error("Expected test worker job container");
    }
    container.State = { Running: false, Status: "exited", ExitCode: 0 };
    await rm(getWorkerJobReceiptPath(dataDir, payload.scheduleRunId), { force: true });

    const result = await cleanupWorkerJob(docker as never, jobEnvironment, {
      serviceId: payload.serviceId,
      scheduleRunId: payload.scheduleRunId,
    });

    expect(result.cleanupProof).toEqual({
      version: 1,
      kind: "cleanup_worker_job",
      container: { identifier: containerId, absent: true },
    });
    expect(
      containers.has(buildWorkerJobContainerName(payload.serviceId, payload.scheduleRunId))
    ).toBe(false);
  });

  test("inspects the deterministic container name before proving a missing receipt absent", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "nouva-worker-job-"));
    tempDirs.push(dataDir);
    const { docker } = createRuntimeDocker();
    const jobEnvironment = { ...environment, dataDir };
    const serviceId = "svc_1";
    const scheduleRunId = "run_absent";

    const result = await cleanupWorkerJob(docker as never, jobEnvironment, {
      serviceId,
      scheduleRunId,
    });

    expect(docker.inspectContainer).toHaveBeenCalledWith(
      buildWorkerJobContainerName(serviceId, scheduleRunId)
    );
    expect(result.cleanupProof).toEqual({
      version: 1,
      kind: "cleanup_worker_job",
      container: {
        identifier: buildWorkerJobContainerName(serviceId, scheduleRunId),
        absent: true,
      },
    });
  });
});
