import { describe, expect, mock, test } from "bun:test";
import type { ReleaseJobClaimResponse, ReleaseJobReport } from "@repo/runtime/release-phases";
import type { DockerContainerInspection } from "./docker-api.js";
import {
  buildReleaseJobContainerName,
  createReleasePhaseRunner,
  ReleaseJobDeferredError,
  type ReleaseJobTarget,
  type ReleasePhaseRequest,
} from "./release-jobs.js";

const SERVICE_ID = "svc_1234567890";
const DEPLOYMENT_ID = "dep_abcdefghij";
const STARTED_AT = "2026-09-23T10:00:00.000Z";

type ContainerState = NonNullable<DockerContainerInspection["State"]>;

/**
 * A Docker host holding release job containers, listed by label like Docker does. `existing`
 * containers belong to this deployment's pre-activation phase unless `labels` says otherwise.
 * `onStart` decides what a job does once started: exit with a code, or keep running until stopped.
 * `failInspect` makes Docker fail while a job is running.
 */
function createFakeDocker(options: {
  onStart?: "exit_0" | "exit_1" | "hang";
  existing?: Record<string, ContainerState>;
  labels?: Record<string, Record<string, string>>;
  failInspect?: boolean;
}) {
  const containers = new Map<string, ContainerState>(Object.entries(options.existing ?? {}));
  const labels = new Map<string, Record<string, string>>(
    [...containers.keys()].map((name) => [
      name,
      options.labels?.[name] ?? {
        "nouva.kind": "release_job",
        "nouva.service.id": SERVICE_ID,
        "nouva.deployment.id": DEPLOYMENT_ID,
        "nouva.release.phase": "pre_activation",
      },
    ])
  );
  const events: string[] = [];
  const docker = {
    createContainer: mock(async (spec: { name: string; labels: Record<string, string> }) => {
      events.push(`create:${spec.name}`);
      labels.set(spec.name, spec.labels);
      containers.set(spec.name, { Status: "created", Running: false });
      return "ctr_job";
    }),
    startContainer: mock(async (name: string) => {
      events.push(`start:${name}`);
      const onStart = options.onStart ?? "exit_0";
      containers.set(
        name,
        onStart === "hang"
          ? { Status: "running", Running: true, StartedAt: STARTED_AT }
          : {
              Status: "exited",
              Running: false,
              ExitCode: onStart === "exit_0" ? 0 : 1,
              StartedAt: STARTED_AT,
              FinishedAt: "2026-09-23T10:00:02.000Z",
            }
      );
    }),
    stopContainer: mock(async (name: string) => {
      events.push(`stop:${name}`);
      const state = containers.get(name);
      if (state) {
        containers.set(name, {
          ...state,
          Status: "exited",
          Running: false,
          ExitCode: 143,
          FinishedAt: "2026-09-23T10:00:05.000Z",
        });
      }
    }),
    inspectContainer: mock(async (name: string) => {
      const state = containers.get(name);
      if (options.failInspect && state?.Running) {
        throw new Error("docker unavailable");
      }
      return state
        ? ({ Id: name, State: state, Config: { Labels: labels.get(name) } } as never)
        : null;
    }),
    removeContainer: mock(async (name: string) => {
      events.push(`remove:${name}`);
      containers.delete(name);
      labels.delete(name);
    }),
    listContainersByLabels: mock(async (filter: Record<string, string>) =>
      [...containers.keys()]
        .filter((name) =>
          Object.entries(filter).every(([key, value]) => labels.get(name)?.[key] === value)
        )
        .map((name) => ({
          Id: name,
          State: containers.get(name),
          Config: { Labels: labels.get(name) },
        }))
    ),
    containerLogEntries: mock(async () => [
      { type: "stdout" as const, line: "migrating with secret-value" },
    ]),
  };
  return { docker, containers, events };
}

function createFakeControlPlane(claim: ReleaseJobClaimResponse, events: string[] = []) {
  const reports: ReleaseJobReport[] = [];
  const controlPlane = {
    claim: mock(async () => {
      events.push("claim");
      return claim;
    }),
    report: mock(async (_phase: string, report: ReleaseJobReport) => {
      events.push(`report:${report.outcome}`);
      reports.push(report);
    }),
  };
  return { controlPlane, reports };
}

function createClock() {
  let nowMs = Date.parse(STARTED_AT);
  return {
    now: () => nowMs,
    sleep: mock(async (ms: number) => {
      nowMs += ms;
    }),
  };
}

function createTarget(events: string[] = []): ReleaseJobTarget {
  return {
    serviceId: SERVICE_ID,
    deploymentId: DEPLOYMENT_ID,
    image: "registry.local/app:candidate",
    networkName: "nouva-project-1",
    envVars: { DATABASE_URL: "postgres://secret-value@db/app" },
    labels: { "nouva.managed": "true" },
    resourceSettings: { Memory: 512 * 1024 * 1024 },
    redactLogLine: (line) => line.replaceAll("secret-value", "[redacted]"),
    prepareImage: mock(async () => {
      events.push("prepare");
    }),
  };
}

const preActivation: ReleasePhaseRequest = {
  phase: "pre_activation",
  command: "bun run migrate",
  timeoutSeconds: 30,
};

function containerName(phase: "pre_activation" | "verification", attempt: number) {
  return buildReleaseJobContainerName({
    serviceId: SERVICE_ID,
    deploymentId: DEPLOYMENT_ID,
    phase,
    attempt,
  });
}

describe("release phase runner", () => {
  test("runs the command in a candidate container and reports success before removing it", async () => {
    const exited = { Status: "exited", Running: false, ExitCode: 1 };
    const { docker, events } = createFakeDocker({
      onStart: "exit_0",
      existing: { earlier_attempt: exited, other_deployment: exited, other_service: exited },
      labels: {
        other_deployment: {
          "nouva.kind": "release_job",
          "nouva.service.id": SERVICE_ID,
          "nouva.deployment.id": "dep_older",
        },
        other_service: {
          "nouva.kind": "release_job",
          "nouva.service.id": "svc_other",
          "nouva.deployment.id": "dep_other",
        },
      },
    });
    const { controlPlane, reports } = createFakeControlPlane(
      { decision: "run", attempt: 1 },
      events
    );
    const logs = mock(() => {});
    const runner = createReleasePhaseRunner({
      docker: docker as never,
      controlPlane,
      clock: createClock(),
      onBuildLog: logs,
    });
    const target = createTarget(events);

    const result = await runner.run(target, preActivation);

    expect(result).toEqual({ kind: "succeeded", attempt: 1 });
    const name = containerName("pre_activation", 1);
    expect(events).toEqual([
      "prepare",
      "claim",
      // Allowed to run, so no other deployment's job is unsettled: its exited leftovers can go.
      "remove:other_deployment",
      "remove:earlier_attempt",
      `create:${name}`,
      `start:${name}`,
      "report:succeeded",
      `remove:${name}`,
    ]);
    const spec = docker.createContainer.mock.calls[0]?.[0] as unknown as {
      image: string;
      env: string[];
      entrypoint: string[];
      cmd: string[];
      labels: Record<string, string>;
      hostConfig: Record<string, unknown>;
      networkingConfig: { EndpointsConfig: Record<string, unknown> };
    };
    expect(spec.image).toBe(target.image);
    expect(spec.entrypoint).toEqual(["/bin/sh", "-c"]);
    expect(spec.cmd).toEqual(["bun run migrate"]);
    expect(spec.env).toContain("DATABASE_URL=postgres://secret-value@db/app");
    expect(spec.env).toContain("NOUVA_RELEASE_PHASE=pre_activation");
    expect(spec.env).toContain(`NOUVA_DEPLOYMENT_ID=${DEPLOYMENT_ID}`);
    expect(spec.labels).toMatchObject({
      "nouva.managed": "true",
      "nouva.kind": "release_job",
      "nouva.release.phase": "pre_activation",
      "nouva.release.attempt": "1",
      "nouva.release.timeout_seconds": "30",
    });
    expect(spec.hostConfig).toMatchObject({
      AutoRemove: false,
      RestartPolicy: { Name: "no" },
      Memory: 512 * 1024 * 1024,
    });
    expect(spec.hostConfig).not.toHaveProperty("Mounts");
    expect(Object.keys(spec.networkingConfig.EndpointsConfig)).toEqual(["nouva-project-1"]);
    expect(reports[0]).toMatchObject({ attempt: 1, outcome: "succeeded", exitCode: 0 });
    expect(logs).toHaveBeenCalledWith(
      expect.objectContaining({ line: "[pre-activation] migrating with [redacted]" })
    );
  });

  test("a failing job is reported as failed and stops the deployment", async () => {
    const { docker } = createFakeDocker({ onStart: "exit_1" });
    const { controlPlane, reports } = createFakeControlPlane({ decision: "run", attempt: 2 });
    const runner = createReleasePhaseRunner({
      docker: docker as never,
      controlPlane,
      clock: createClock(),
    });

    const result = await runner.run(createTarget(), preActivation);

    expect(result).toMatchObject({ kind: "unsuccessful", attempt: 2, outcome: "failed" });
    expect(result.kind === "unsuccessful" && result.message).toContain("was not activated");
    expect(reports[0]).toMatchObject({ outcome: "failed", exitCode: 1, appliedPolicy: null });
  });

  test("a job still running at its deadline is stopped and reported as timed out", async () => {
    const { docker } = createFakeDocker({ onStart: "hang" });
    const { controlPlane, reports } = createFakeControlPlane({ decision: "run", attempt: 1 });
    const clock = createClock();
    const runner = createReleasePhaseRunner({ docker: docker as never, controlPlane, clock });

    const result = await runner.run(createTarget(), { ...preActivation, timeoutSeconds: 3 });

    expect(result).toMatchObject({ kind: "unsuccessful", outcome: "timed_out" });
    expect(docker.stopContainer).toHaveBeenCalledWith(containerName("pre_activation", 1), 5);
    expect(clock.now() - Date.parse(STARTED_AT)).toBe(3_000);
    expect(reports[0]).toMatchObject({ outcome: "timed_out" });
  });

  test("skip never runs the job again", async () => {
    const { docker } = createFakeDocker({});
    const { controlPlane } = createFakeControlPlane({ decision: "skip", attempt: 1 });
    const runner = createReleasePhaseRunner({
      docker: docker as never,
      controlPlane,
      clock: createClock(),
    });

    expect(await runner.run(createTarget(), preActivation)).toEqual({
      kind: "succeeded",
      attempt: 1,
    });
    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(controlPlane.report).not.toHaveBeenCalled();
  });

  test("halt returns the control plane's verdict without touching Docker", async () => {
    const { docker } = createFakeDocker({});
    const { controlPlane } = createFakeControlPlane({
      decision: "halt",
      attempt: 1,
      status: "outcome_unknown",
      message: "Needs an operator",
    });
    const runner = createReleasePhaseRunner({
      docker: docker as never,
      controlPlane,
      clock: createClock(),
    });

    expect(await runner.run(createTarget(), preActivation)).toEqual({
      kind: "unsuccessful",
      attempt: 1,
      outcome: "outcome_unknown",
      message: "Needs an operator",
      appliedPolicy: null,
    });
    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(docker.startContainer).not.toHaveBeenCalled();
  });

  describe("resuming a claimed attempt", () => {
    test("records an exited container without running the command again", async () => {
      const name = containerName("pre_activation", 1);
      const { docker } = createFakeDocker({
        existing: {
          [name]: {
            Status: "exited",
            Running: false,
            ExitCode: 0,
            StartedAt: STARTED_AT,
            FinishedAt: "2026-09-23T10:00:02.000Z",
          },
        },
      });
      const { controlPlane, reports } = createFakeControlPlane({ decision: "resume", attempt: 1 });
      const runner = createReleasePhaseRunner({
        docker: docker as never,
        controlPlane,
        clock: createClock(),
      });

      expect(await runner.run(createTarget(), preActivation)).toEqual({
        kind: "succeeded",
        attempt: 1,
      });
      expect(docker.createContainer).not.toHaveBeenCalled();
      expect(docker.startContainer).not.toHaveBeenCalled();
      expect(reports[0]).toMatchObject({ outcome: "succeeded", exitCode: 0 });
    });

    test("starts a container that was created but never started", async () => {
      const name = containerName("pre_activation", 1);
      const { docker } = createFakeDocker({
        onStart: "exit_0",
        existing: { [name]: { Status: "created", Running: false } },
      });
      const { controlPlane } = createFakeControlPlane({ decision: "resume", attempt: 1 });
      const runner = createReleasePhaseRunner({
        docker: docker as never,
        controlPlane,
        clock: createClock(),
      });

      expect(await runner.run(createTarget(), preActivation)).toMatchObject({
        kind: "succeeded",
      });
      expect(docker.createContainer).not.toHaveBeenCalled();
      expect(docker.startContainer).toHaveBeenCalledWith(name);
    });

    test("waits on a running container against its original start time", async () => {
      const name = containerName("pre_activation", 1);
      const { docker } = createFakeDocker({
        existing: { [name]: { Status: "running", Running: true, StartedAt: STARTED_AT } },
      });
      const { controlPlane } = createFakeControlPlane({ decision: "resume", attempt: 1 });
      const clock = createClock();
      await clock.sleep(2_000);
      const runner = createReleasePhaseRunner({ docker: docker as never, controlPlane, clock });

      const result = await runner.run(createTarget(), { ...preActivation, timeoutSeconds: 3 });

      expect(result).toMatchObject({ outcome: "timed_out" });
      expect(docker.startContainer).not.toHaveBeenCalled();
      // One second was left of the attempt's own deadline, not a fresh three.
      expect(clock.now() - Date.parse(STARTED_AT)).toBe(3_000);
    });

    test("a missing container is an unknown outcome, never a rerun", async () => {
      const { docker } = createFakeDocker({});
      const { controlPlane, reports } = createFakeControlPlane({ decision: "resume", attempt: 1 });
      const runner = createReleasePhaseRunner({
        docker: docker as never,
        controlPlane,
        clock: createClock(),
      });

      const result = await runner.run(createTarget(), preActivation);

      expect(result).toMatchObject({ kind: "unsuccessful", outcome: "outcome_unknown" });
      expect(docker.createContainer).not.toHaveBeenCalled();
      expect(docker.startContainer).not.toHaveBeenCalled();
      expect(reports[0]).toMatchObject({ outcome: "outcome_unknown", exitCode: null });
    });
  });

  test("a verification failure reports the policy the agent will apply", async () => {
    const { docker } = createFakeDocker({ onStart: "exit_1" });
    const { controlPlane, reports } = createFakeControlPlane({ decision: "run", attempt: 1 });
    const runner = createReleasePhaseRunner({
      docker: docker as never,
      controlPlane,
      clock: createClock(),
    });

    const result = await runner.run(createTarget(), {
      phase: "verification",
      command: "curl -fsS $NOUVA_CANDIDATE_URL/health",
      timeoutSeconds: 30,
      phaseEnv: { NOUVA_CANDIDATE_URL: "http://candidate:8080" },
      configuredPolicy: "rollback",
      resolveAppliedPolicy: () => "rollback",
    });

    expect(result).toMatchObject({ kind: "unsuccessful", outcome: "failed" });
    expect(result.kind === "unsuccessful" && result.message).toContain(
      "no data or schema was rolled back"
    );
    expect(reports[0]).toMatchObject({ appliedPolicy: "rollback" });
    const spec = docker.createContainer.mock.calls[0]?.[0] as unknown as { env: string[] };
    expect(spec.env).toContain("NOUVA_CANDIDATE_URL=http://candidate:8080");
    expect(spec.env).toContain("NOUVA_RELEASE_PHASE=verification");
  });

  test("a lost report acknowledgement is retried and the container kept until it lands", async () => {
    const { docker, events } = createFakeDocker({ onStart: "exit_0" });
    const { controlPlane } = createFakeControlPlane({ decision: "run", attempt: 1 }, events);
    const report = controlPlane.report;
    let failures = 2;
    controlPlane.report = mock(async (phase: string, body: ReleaseJobReport) => {
      if (failures > 0) {
        failures -= 1;
        events.push("report:lost");
        throw Object.assign(new Error("bad gateway"), { status: 502 });
      }
      return report(phase, body);
    });
    const runner = createReleasePhaseRunner({
      docker: docker as never,
      controlPlane,
      clock: createClock(),
    });

    await runner.run(createTarget(), preActivation);

    const name = containerName("pre_activation", 1);
    expect(events.slice(-4)).toEqual([
      "report:lost",
      "report:lost",
      "report:succeeded",
      `remove:${name}`,
    ]);
  });

  test("a rejected report keeps the container as evidence for the next lease", async () => {
    const { docker } = createFakeDocker({ onStart: "exit_0" });
    const { controlPlane } = createFakeControlPlane({ decision: "run", attempt: 1 });
    controlPlane.report = mock(async () => {
      throw Object.assign(new Error("lease inactive"), { status: 409 });
    });
    const runner = createReleasePhaseRunner({
      docker: docker as never,
      controlPlane,
      clock: createClock(),
    });

    await expect(runner.run(createTarget(), preActivation)).rejects.toThrow("lease inactive");
    expect(controlPlane.report).toHaveBeenCalledTimes(1);
    expect(docker.removeContainer).not.toHaveBeenCalledWith(
      containerName("pre_activation", 1),
      true
    );
  });

  test("an outcome the control plane cannot take is given back with its container, not failed", async () => {
    const { docker, containers } = createFakeDocker({ onStart: "exit_0" });
    const { controlPlane } = createFakeControlPlane({ decision: "run", attempt: 1 });
    controlPlane.report = mock(async () => {
      throw Object.assign(new Error("bad gateway"), { status: 502 });
    });
    const clock = createClock();
    const runner = createReleasePhaseRunner({ docker: docker as never, controlPlane, clock });
    const startedMs = clock.now();

    await expect(runner.run(createTarget(), preActivation)).rejects.toBeInstanceOf(
      ReleaseJobDeferredError
    );
    // Retried for longer than a control-plane blue/green switch takes.
    expect(clock.now() - startedMs).toBeGreaterThanOrEqual(60_000);
    expect(containers.has(containerName("pre_activation", 1))).toBe(true);
  });

  test("every status line carries the stage and percent the control plane needs to keep it", async () => {
    const { docker } = createFakeDocker({ onStart: "exit_1" });
    const { controlPlane } = createFakeControlPlane({ decision: "run", attempt: 1 });
    const logs = mock((_entry: Record<string, unknown>) => {});
    const runner = createReleasePhaseRunner({
      docker: docker as never,
      controlPlane,
      clock: createClock(),
      onBuildLog: logs,
    });

    await runner.run(createTarget(), preActivation);

    const progress = logs.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.type === "progress");
    expect(progress.length).toBeGreaterThan(1);
    for (const entry of progress) {
      expect(entry).toMatchObject({ stage: "deploying", percent: expect.any(Number) });
    }
  });

  test("a job that could not be started is reported failed, not unknown", async () => {
    const { docker, containers } = createFakeDocker({});
    docker.startContainer.mockImplementation(async () => {
      throw new Error('exec: "/bin/sh": stat /bin/sh: no such file or directory');
    });
    const { controlPlane, reports } = createFakeControlPlane({ decision: "run", attempt: 1 });
    const runner = createReleasePhaseRunner({
      docker: docker as never,
      controlPlane,
      clock: createClock(),
    });

    const result = await runner.run(createTarget(), preActivation);

    expect(reports[0]).toMatchObject({ attempt: 1, outcome: "failed", exitCode: null });
    expect(result).toMatchObject({
      kind: "unsuccessful",
      outcome: "failed",
      message: expect.stringContaining(
        "could not be started. The new deployment was not activated. Start error: exec"
      ),
    });
    expect(containers.has(containerName("pre_activation", 1))).toBe(false);
  });

  test("a verification that could not be started is reported failed and kept", async () => {
    const { docker, containers } = createFakeDocker({});
    docker.startContainer.mockImplementation(async () => {
      throw new Error('exec: "/bin/sh": stat /bin/sh: no such file or directory');
    });
    const { controlPlane, reports } = createFakeControlPlane({ decision: "run", attempt: 1 });
    const resolveAppliedPolicy = mock(async () => "rollback" as const);
    const runner = createReleasePhaseRunner({
      docker: docker as never,
      controlPlane,
      clock: createClock(),
    });

    const result = await runner.run(createTarget(), {
      phase: "verification",
      command: "curl -fsS $NOUVA_CANDIDATE_URL",
      timeoutSeconds: 30,
      configuredPolicy: "rollback",
      resolveAppliedPolicy,
    });

    // Recorded as a failure, not left running for activation to call its result lost. Nothing
    // was observed, so it never rolls traffic back whatever the configured policy.
    expect(reports[0]).toMatchObject({
      attempt: 1,
      outcome: "failed",
      exitCode: null,
      appliedPolicy: "keep",
    });
    expect(result).toMatchObject({
      kind: "unsuccessful",
      outcome: "failed",
      appliedPolicy: "keep",
      message: expect.stringContaining(
        "Verification could not be started. The new deployment keeps serving. Start error: exec"
      ),
    });
    expect(resolveAppliedPolicy).not.toHaveBeenCalled();
    expect(containers.has(containerName("verification", 1))).toBe(false);
  });

  test("a start Docker reported as failed but that did start is awaited like any other", async () => {
    const { docker } = createFakeDocker({ onStart: "exit_0" });
    const start = docker.startContainer.getMockImplementation()!;
    docker.startContainer.mockImplementation(async (name: string) => {
      await start(name);
      throw new Error("docker socket timed out");
    });
    const { controlPlane, reports } = createFakeControlPlane({ decision: "run", attempt: 1 });
    const runner = createReleasePhaseRunner({
      docker: docker as never,
      controlPlane,
      clock: createClock(),
    });

    expect(await runner.run(createTarget(), preActivation)).toEqual({
      kind: "succeeded",
      attempt: 1,
    });
    expect(reports[0]).toMatchObject({ outcome: "succeeded", exitCode: 0 });
  });

  test("a claim whose answer was lost is asked again and runs the attempt it was given", async () => {
    const { docker } = createFakeDocker({ onStart: "exit_0" });
    const { controlPlane, reports } = createFakeControlPlane({ decision: "run", attempt: 1 });
    const claim = controlPlane.claim.getMockImplementation()!;
    let failures = 1;
    controlPlane.claim.mockImplementation(async () => {
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error("bad gateway"), { status: 502 });
      }
      return claim();
    });
    const runner = createReleasePhaseRunner({
      docker: docker as never,
      controlPlane,
      clock: createClock(),
    });

    expect(await runner.run(createTarget(), preActivation)).toEqual({
      kind: "succeeded",
      attempt: 1,
    });
    expect(controlPlane.claim).toHaveBeenCalledTimes(2);
    expect(reports[0]).toMatchObject({ attempt: 1, outcome: "succeeded" });
  });

  test("a repeated claim that finds the work already requeued gives it back", async () => {
    const { docker } = createFakeDocker({});
    const { controlPlane } = createFakeControlPlane({ decision: "run", attempt: 1 });
    const statuses = [502, 409];
    controlPlane.claim.mockImplementation(async () => {
      throw Object.assign(new Error("claim failed"), { status: statuses.shift() });
    });
    const runner = createReleasePhaseRunner({
      docker: docker as never,
      controlPlane,
      clock: createClock(),
    });

    await expect(runner.run(createTarget(), preActivation)).rejects.toBeInstanceOf(
      ReleaseJobDeferredError
    );
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  test("an image that cannot be prepared fails before anything is claimed", async () => {
    const { docker } = createFakeDocker({});
    const { controlPlane } = createFakeControlPlane({ decision: "run", attempt: 1 });
    const runner = createReleasePhaseRunner({
      docker: docker as never,
      controlPlane,
      clock: createClock(),
    });
    const target = {
      ...createTarget(),
      prepareImage: async () => {
        throw new Error("image missing");
      },
    };

    await expect(runner.run(target, preActivation)).rejects.toThrow("image missing");
    expect(controlPlane.claim).not.toHaveBeenCalled();
  });

  describe("containers nothing will resume", () => {
    const verification: ReleasePhaseRequest = {
      phase: "verification",
      command: "curl -fsS $NOUVA_CANDIDATE_URL",
      timeoutSeconds: 30,
    };

    test.each([
      { decision: "skip" as const },
      {
        decision: "halt" as const,
        status: "outcome_unknown" as const,
        message: "Marked by an operator",
      },
    ])("a settled phase ($decision) removes what its attempts left behind", async (claim) => {
      const earlier = containerName("pre_activation", 1);
      const { docker, containers } = createFakeDocker({
        existing: { [earlier]: { Status: "exited", Running: false, ExitCode: 0 } },
      });
      const { controlPlane } = createFakeControlPlane({ ...claim, attempt: 1 });
      const runner = createReleasePhaseRunner({
        docker: docker as never,
        controlPlane,
        clock: createClock(),
      });

      await runner.run(createTarget(), preActivation);

      expect(containers.has(earlier)).toBe(false);
      expect(docker.createContainer).not.toHaveBeenCalled();
    });

    test("an unacknowledged verification report does not leave its container behind", async () => {
      const { docker, containers } = createFakeDocker({ onStart: "exit_1" });
      const { controlPlane } = createFakeControlPlane({ decision: "run", attempt: 1 });
      controlPlane.report = mock(async () => {
        throw Object.assign(new Error("lease inactive"), { status: 409 });
      });
      const runner = createReleasePhaseRunner({
        docker: docker as never,
        controlPlane,
        clock: createClock(),
      });

      await expect(runner.run(createTarget(), verification)).rejects.toThrow("lease inactive");
      expect(containers.has(containerName("verification", 1))).toBe(false);
    });

    test("a verification Docker lost track of is removed rather than left running", async () => {
      const { docker, containers } = createFakeDocker({ onStart: "hang", failInspect: true });
      const { controlPlane } = createFakeControlPlane({ decision: "run", attempt: 1 });
      const runner = createReleasePhaseRunner({
        docker: docker as never,
        controlPlane,
        clock: createClock(),
      });

      await expect(runner.run(createTarget(), verification)).rejects.toThrow("docker unavailable");
      expect(containers.has(containerName("verification", 1))).toBe(false);
      expect(controlPlane.report).not.toHaveBeenCalled();
    });

    test("a container Docker will not remove after the report does not fail the phase", async () => {
      const { docker } = createFakeDocker({ onStart: "exit_1" });
      docker.removeContainer.mockImplementation(async () => {
        throw new Error("removal in progress");
      });
      const { controlPlane, reports } = createFakeControlPlane({ decision: "run", attempt: 1 });
      const runner = createReleasePhaseRunner({
        docker: docker as never,
        controlPlane,
        clock: createClock(),
      });

      const result = await runner.run(createTarget(), {
        ...verification,
        configuredPolicy: "rollback",
        resolveAppliedPolicy: () => "rollback",
      });

      // The recorded outcome stands, so the caller still applies the policy it reported.
      expect(result).toMatchObject({ kind: "unsuccessful", outcome: "failed" });
      expect(reports[0]).toMatchObject({ appliedPolicy: "rollback" });
    });

    test("an interrupted pre-activation attempt keeps its container for a resume", async () => {
      const { docker, containers } = createFakeDocker({ onStart: "hang", failInspect: true });
      const { controlPlane } = createFakeControlPlane({ decision: "run", attempt: 1 });
      const runner = createReleasePhaseRunner({
        docker: docker as never,
        controlPlane,
        clock: createClock(),
      });

      await expect(runner.run(createTarget(), preActivation)).rejects.toThrow("docker unavailable");
      expect(containers.has(containerName("pre_activation", 1))).toBe(true);
    });
  });

  test("a job that exits on its own just before the deadline stop keeps its success", async () => {
    const { docker, containers } = createFakeDocker({ onStart: "hang" });
    const name = containerName("pre_activation", 1);
    // The command finishes after the agent's last look but before its stop reaches Docker.
    docker.stopContainer.mockImplementation(async () => {
      containers.set(name, {
        Status: "exited",
        Running: false,
        ExitCode: 0,
        StartedAt: STARTED_AT,
        FinishedAt: "2026-09-23T10:00:02.900Z",
      });
    });
    const { controlPlane, reports } = createFakeControlPlane({ decision: "run", attempt: 1 });
    const runner = createReleasePhaseRunner({
      docker: docker as never,
      controlPlane,
      clock: createClock(),
    });

    const result = await runner.run(createTarget(), { ...preActivation, timeoutSeconds: 3 });

    expect(result).toEqual({ kind: "succeeded", attempt: 1 });
    expect(reports[0]).toMatchObject({ outcome: "succeeded", exitCode: 0 });
  });

  describe("an earlier attempt of this deployment still running", () => {
    const running = { Status: "running", Running: true, StartedAt: STARTED_AT };

    test.each([
      { decision: "run" as const, attempt: 2 },
      { decision: "skip" as const, attempt: 1 },
      {
        decision: "halt" as const,
        attempt: 1,
        status: "outcome_unknown" as const,
        message: "Needs an operator",
      },
    ])("is reported with the claim and survives a $decision answer", async (claim) => {
      const earlier = containerName("pre_activation", 1);
      const { docker, containers } = createFakeDocker({
        onStart: "exit_0",
        existing: { [earlier]: running },
        labels: {
          [earlier]: {
            "nouva.kind": "release_job",
            "nouva.service.id": SERVICE_ID,
            "nouva.deployment.id": DEPLOYMENT_ID,
            "nouva.release.phase": "pre_activation",
            "nouva.release.timeout_seconds": "600",
          },
        },
      });
      const { controlPlane } = createFakeControlPlane(claim);
      const runner = createReleasePhaseRunner({
        docker: docker as never,
        controlPlane,
        clock: createClock(),
      });

      await runner.run(createTarget(), preActivation);

      // The control plane answers `wait` for a run or skip it hears about; whatever it answers,
      // the agent never kills a migration halfway through.
      expect(controlPlane.claim).toHaveBeenCalledWith("pre_activation", {
        runningJobDeploymentIds: [DEPLOYMENT_ID],
      });
      expect(containers.get(earlier)).toMatchObject({ Running: true });
      expect(docker.stopContainer).not.toHaveBeenCalled();
    });

    test("is not reported for another phase of the deployment", async () => {
      const verification = containerName("verification", 1);
      const { docker } = createFakeDocker({
        existing: { [verification]: running },
        labels: {
          [verification]: {
            "nouva.kind": "release_job",
            "nouva.service.id": SERVICE_ID,
            "nouva.deployment.id": DEPLOYMENT_ID,
            "nouva.release.phase": "verification",
          },
        },
      });
      const { controlPlane } = createFakeControlPlane({ decision: "skip", attempt: 1 });
      const runner = createReleasePhaseRunner({
        docker: docker as never,
        controlPlane,
        clock: createClock(),
      });

      await runner.run(createTarget(), preActivation);

      expect(controlPlane.claim).toHaveBeenCalledWith("pre_activation", {
        runningJobDeploymentIds: [],
      });
    });
  });

  describe("another deployment's jobs", () => {
    const otherJobLabels = (phase: string) => ({
      "nouva.kind": "release_job",
      "nouva.service.id": SERVICE_ID,
      "nouva.deployment.id": "dep_older",
      "nouva.release.phase": phase,
      "nouva.release.timeout_seconds": "600",
    });
    const running = { Status: "running", Running: true, StartedAt: STARTED_AT };

    test("a running job of another deployment is never touched and makes the claim wait", async () => {
      const { docker, containers, events } = createFakeDocker({
        existing: { older_migration: running },
        labels: { older_migration: otherJobLabels("pre_activation") },
      });
      const { controlPlane } = createFakeControlPlane(
        { decision: "wait", attempt: 0, message: "Waiting on deployment dep_olde" },
        events
      );
      const clock = createClock();
      await clock.sleep(60_000);
      const runner = createReleasePhaseRunner({ docker: docker as never, controlPlane, clock });

      const run = runner.run(createTarget(events), preActivation);

      await expect(run).rejects.toBeInstanceOf(ReleaseJobDeferredError);
      await expect(run).rejects.toThrow("Waiting on deployment dep_olde");
      expect(controlPlane.claim).toHaveBeenCalledWith("pre_activation", {
        runningJobDeploymentIds: ["dep_older"],
      });
      expect(events).toEqual(["prepare", "claim"]);
      expect(containers.get("older_migration")).toMatchObject({ Running: true });
    });

    test("a job of another deployment past its own deadline is stopped, not removed", async () => {
      const { docker, containers } = createFakeDocker({
        existing: { older_migration: running },
        labels: { older_migration: otherJobLabels("pre_activation") },
      });
      const { controlPlane } = createFakeControlPlane({ decision: "run", attempt: 1 });
      const clock = createClock();
      await clock.sleep(601_000);
      const runner = createReleasePhaseRunner({ docker: docker as never, controlPlane, clock });

      await runner.run(createTarget(), preActivation);

      expect(docker.stopContainer).toHaveBeenCalledWith("older_migration", 5);
      expect(controlPlane.claim).toHaveBeenCalledWith("pre_activation", {
        runningJobDeploymentIds: [],
      });
      // Stopped before the claim, then swept as an exited leftover once the claim allowed a run.
      expect(containers.has("older_migration")).toBe(false);
    });

    test("exited jobs of another deployment stay while this deployment waits or resumes", async () => {
      for (const claim of [
        { decision: "wait" as const, attempt: 0, message: "Waiting" },
        { decision: "resume" as const, attempt: 1 },
      ]) {
        const { docker, containers } = createFakeDocker({
          existing: { older_migration: { Status: "exited", Running: false, ExitCode: 0 } },
          labels: { older_migration: otherJobLabels("pre_activation") },
        });
        const { controlPlane } = createFakeControlPlane(claim);
        const runner = createReleasePhaseRunner({
          docker: docker as never,
          controlPlane,
          clock: createClock(),
        });

        await runner.run(createTarget(), preActivation).catch(() => undefined);

        expect(containers.has("older_migration")).toBe(true);
      }
    });

    test("a verification only sweeps other deployments' exited verifications", async () => {
      const exited = { Status: "exited", Running: false, ExitCode: 0 };
      const { docker, containers } = createFakeDocker({
        existing: { older_migration: exited, older_verification: exited },
        labels: {
          older_migration: otherJobLabels("pre_activation"),
          older_verification: otherJobLabels("verification"),
        },
      });
      const { controlPlane } = createFakeControlPlane({ decision: "run", attempt: 1 });
      const runner = createReleasePhaseRunner({
        docker: docker as never,
        controlPlane,
        clock: createClock(),
      });

      await runner.run(createTarget(), {
        phase: "verification",
        command: "curl -fsS $NOUVA_CANDIDATE_URL",
        timeoutSeconds: 30,
      });

      expect(containers.has("older_migration")).toBe(true);
      expect(containers.has("older_verification")).toBe(false);
    });
  });
});
