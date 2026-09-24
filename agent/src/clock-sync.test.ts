import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildClockProbeScript,
  CLOCK_PROBE_CONTAINER_NAME,
  CLOCK_PROBE_INTERVAL_MS,
  type ClockProbeDocker,
  type ClockProbeHelper,
  type ClockSyncEvidence,
  detectHostClockSync,
  evaluateClockSync,
  parseTimedatectlClockState,
  resetClockProbeCacheForTests,
} from "./clock-sync.js";

/** What `timedatectl show -p NTP -p NTPSynchronized` prints on each kind of host. */
const CHRONY_HOST_OUTPUT = "NTP=yes\nNTPSynchronized=yes\n";
const TIMESYNCD_HOST_OUTPUT = "NTP=yes\nNTPSynchronized=yes";
const UNSYNCHRONISED_HOST_OUTPUT = "NTP=yes\nNTPSynchronized=no\n";
const NO_TIME_SERVICE_OUTPUT = "NTP=no\nNTPSynchronized=no\n";

function createDockerMock(input: { output?: string; exitCode?: number } = {}) {
  return {
    createContainer: mock(async () => "container-id"),
    startContainer: mock(async () => undefined),
    waitContainer: mock(async () => input.exitCode ?? 0),
    containerLogs: mock(async () => input.output ?? CHRONY_HOST_OUTPUT),
    removeContainer: mock(async () => undefined),
  };
}

function createUnusableDockerMock() {
  return {
    createContainer: mock(async () => {
      throw new Error("Cannot connect to the Docker daemon");
    }),
    startContainer: mock(async () => undefined),
    waitContainer: mock(async () => 0),
    containerLogs: mock(async () => ""),
    removeContainer: mock(async () => undefined),
  };
}

function availableHelper(docker: ClockProbeDocker, image = "agent:test"): ClockProbeHelper {
  return { kind: "available", docker, image };
}

async function writeTimesyncdSentinel(hostRoot: string): Promise<void> {
  const dir = path.join(hostRoot, "run/systemd/timesync");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "synchronized"), "");
}

async function listenOnChronydSocket(hostRoot: string): Promise<net.Server> {
  const dir = path.join(hostRoot, "run/chrony");
  await mkdir(dir, { recursive: true });
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path.join(dir, "chronyd.sock"), resolve);
  });
  return server;
}

describe("clock synchronisation detection", () => {
  let hostRoot = "";
  let chronydSocket: net.Server | null = null;

  beforeEach(async () => {
    resetClockProbeCacheForTests();
    // A short prefix keeps the chronyd socket path under the ~104 byte sun_path limit.
    hostRoot = await mkdtemp(path.join(tmpdir(), "clk-"));
    chronydSocket = null;
  });

  afterEach(async () => {
    chronydSocket?.close();
    await rm(hostRoot, { recursive: true, force: true });
  });

  test("should read the synchronisation state out of timedatectl properties", () => {
    expect(parseTimedatectlClockState(CHRONY_HOST_OUTPUT)).toEqual({
      ntpEnabled: true,
      synchronized: true,
    });
    expect(parseTimedatectlClockState(UNSYNCHRONISED_HOST_OUTPUT)).toEqual({
      ntpEnabled: true,
      synchronized: false,
    });
    expect(parseTimedatectlClockState(NO_TIME_SERVICE_OUTPUT)).toEqual({
      ntpEnabled: false,
      synchronized: false,
    });
    expect(parseTimedatectlClockState("NTPSynchronized=yes")).toEqual({
      ntpEnabled: null,
      synchronized: true,
    });
  });

  test("should treat a missing or unreadable synchronisation state as no answer", () => {
    expect(parseTimedatectlClockState("NTP=yes")).toBeNull();
    expect(parseTimedatectlClockState("Failed to query server: Connection refused")).toBeNull();
    expect(parseTimedatectlClockState("NTPSynchronized=maybe")).toBeNull();
    expect(parseTimedatectlClockState("")).toBeNull();
  });

  test("should pass a synchronised host and warn only about what was tested", () => {
    const synchronised = evaluateClockSync({
      kind: "timedatectl",
      state: { ntpEnabled: true, synchronized: true },
    });
    expect(synchronised.status).toBe("pass");
    expect(synchronised.value).toBe("NTP=yes,NTPSynchronized=yes");

    const syncing = evaluateClockSync({
      kind: "timedatectl",
      state: { ntpEnabled: true, synchronized: false },
    });
    expect(syncing.status).toBe("warn");
    expect(syncing.message).toContain("is enabled but the clock is not synchronised yet");

    const noService = evaluateClockSync({
      kind: "timedatectl",
      state: { ntpEnabled: false, synchronized: false },
    });
    expect(noService.status).toBe("warn");
    expect(noService.message).toContain("No time synchronisation service is enabled");
    expect(noService.value).toBe("NTP=no,NTPSynchronized=no");

    const syncedWithoutService = evaluateClockSync({
      kind: "timedatectl",
      state: { ntpEnabled: false, synchronized: true },
    });
    expect(syncedWithoutService.status).toBe("pass");
  });

  test("should report degraded evidence for what it actually proves", () => {
    const cases: Array<[ClockSyncEvidence, "pass" | "warn", string]> = [
      [
        { kind: "timesyncd-synchronized", reason: "probe unavailable" },
        "pass",
        "systemd-timesyncd has completed a synchronisation",
      ],
      [
        { kind: "chronyd-running", reason: "probe unavailable" },
        "warn",
        "chronyd is running but its synchronisation state could not be verified",
      ],
      [
        { kind: "unknown", reason: "probe unavailable" },
        "warn",
        "Clock synchronisation could not be verified",
      ],
    ];

    for (const [evidence, status, fragment] of cases) {
      const assessment = evaluateClockSync(evidence);
      expect(assessment.status).toBe(status);
      expect(assessment.message).toContain(fragment);
      expect(assessment.message).toContain("probe unavailable");
    }
  });

  test("should pass a chrony host by asking the host namespaces about the clock", async () => {
    const docker = createDockerMock({ output: CHRONY_HOST_OUTPUT });
    chronydSocket = await listenOnChronydSocket(hostRoot);

    const evidence = await detectHostClockSync(
      availableHelper(docker, "ghcr.io/nouvalabs/nouva-agent:0.4.24"),
      { hostRoot, labels: { "nouva.kind": "clock-probe" } }
    );

    expect(evidence).toEqual({
      kind: "timedatectl",
      state: { ntpEnabled: true, synchronized: true },
    });
    expect(evaluateClockSync(evidence).status).toBe("pass");

    const spec = docker.createContainer.mock.calls[0]?.[0] as {
      name: string;
      image: string;
      entrypoint?: string[];
      cmd?: string[];
      labels?: Record<string, string>;
      hostConfig?: Record<string, unknown>;
    };
    expect(spec.name).toBe(CLOCK_PROBE_CONTAINER_NAME);
    expect(spec.image).toBe("ghcr.io/nouvalabs/nouva-agent:0.4.24");
    expect(spec.entrypoint).toEqual(["nsenter"]);
    expect(spec.cmd?.slice(0, 9)).toEqual(["-t", "1", "-m", "-u", "-i", "-n", "--", "sh", "-c"]);
    expect(spec.cmd?.[9]).toBe(buildClockProbeScript());
    expect(spec.labels).toEqual({ "nouva.kind": "clock-probe" });
    expect(spec.hostConfig).toMatchObject({ Privileged: true, PidMode: "host" });
    expect(docker.removeContainer).toHaveBeenLastCalledWith(CLOCK_PROBE_CONTAINER_NAME, true);
  });

  test("should pass a timesyncd host", async () => {
    const docker = createDockerMock({ output: TIMESYNCD_HOST_OUTPUT });
    await writeTimesyncdSentinel(hostRoot);

    const evidence = await detectHostClockSync(availableHelper(docker), { hostRoot });

    expect(evidence).toEqual({
      kind: "timedatectl",
      state: { ntpEnabled: true, synchronized: true },
    });
    expect(evaluateClockSync(evidence).status).toBe("pass");
  });

  test("should distinguish a syncing host from one with no time service at all", async () => {
    const syncing = await detectHostClockSync(
      availableHelper(createDockerMock({ output: UNSYNCHRONISED_HOST_OUTPUT })),
      { hostRoot }
    );
    expect(evaluateClockSync(syncing).message).toContain(
      "A time synchronisation service is enabled but the clock is not synchronised yet"
    );

    resetClockProbeCacheForTests();
    const bare = await detectHostClockSync(
      availableHelper(createDockerMock({ output: NO_TIME_SERVICE_OUTPUT })),
      { hostRoot }
    );
    expect(evaluateClockSync(bare).message).toContain(
      "No time synchronisation service is enabled and the clock is not synchronised"
    );
  });

  test("should still pass a timesyncd host when the privileged probe cannot run", async () => {
    await writeTimesyncdSentinel(hostRoot);

    const evidence = await detectHostClockSync(availableHelper(createUnusableDockerMock()), {
      hostRoot,
    });

    expect(evidence.kind).toBe("timesyncd-synchronized");
    const assessment = evaluateClockSync(evidence);
    expect(assessment.status).toBe("pass");
    expect(assessment.message).toContain("Cannot connect to the Docker daemon");
  });

  test("should stat chronyd's socket rather than opening it when the probe cannot run", async () => {
    chronydSocket = await listenOnChronydSocket(hostRoot);
    const socketPath = path.join(hostRoot, "run/chrony/chronyd.sock");
    // open(2) on a unix socket always fails (ENXIO on Linux, EOPNOTSUPP on macOS), which is why
    // the old readFile probe could never detect chrony (issue #268).
    await expect(readFile(socketPath)).rejects.toThrow();

    const evidence = await detectHostClockSync(availableHelper(createUnusableDockerMock()), {
      hostRoot,
    });

    expect(evidence.kind).toBe("chronyd-running");
    const assessment = evaluateClockSync(evidence);
    expect(assessment.status).toBe("warn");
    expect(assessment.message).toContain("chronyd is running");
    expect(assessment.message).not.toContain("No time synchronisation service is enabled");
  });

  test("should report an honest unknown when nothing can be established", async () => {
    const evidence = await detectHostClockSync(availableHelper(createUnusableDockerMock()), {
      hostRoot,
    });

    expect(evidence).toEqual({
      kind: "unknown",
      reason: "Cannot connect to the Docker daemon",
    });
    expect(evaluateClockSync(evidence).status).toBe("warn");
  });

  test("should name why the probe could not run instead of a generic reason", async () => {
    const docker = createDockerMock();
    // What resolveAgentTaskImage throws when the pinned agent image is not present locally.
    const imageFailure = 'No such image: ghcr.io/nouvalabs/nouva-agent:0.4.24"';

    const bare = await detectHostClockSync(
      { kind: "unavailable", reason: imageFailure },
      { hostRoot }
    );

    expect(bare).toEqual({ kind: "unknown", reason: imageFailure });
    expect(evaluateClockSync(bare).message).toContain(imageFailure);
    expect(docker.createContainer).not.toHaveBeenCalled();

    // The same failure still degrades to whatever the host filesystem proves, naming the reason.
    await writeTimesyncdSentinel(hostRoot);
    const degraded = await detectHostClockSync(
      { kind: "unavailable", reason: imageFailure },
      { hostRoot }
    );

    expect(degraded.kind).toBe("timesyncd-synchronized");
    const assessment = evaluateClockSync(degraded);
    expect(assessment.status).toBe("pass");
    expect(assessment.message).toContain(imageFailure);
  });

  test("should reuse a reading instead of launching a container on every heartbeat", async () => {
    const docker = createDockerMock({ output: CHRONY_HOST_OUTPUT });
    let clock = 1_000_000;
    const now = () => clock;

    const first = await detectHostClockSync(availableHelper(docker), { hostRoot, now });
    const second = await detectHostClockSync(availableHelper(docker), { hostRoot, now });
    expect(second).toEqual(first);
    expect(docker.createContainer).toHaveBeenCalledTimes(1);

    clock += CLOCK_PROBE_INTERVAL_MS;
    await detectHostClockSync(availableHelper(docker), { hostRoot, now });
    expect(docker.createContainer).toHaveBeenCalledTimes(2);
  });

  test("should surface a failing helper and back off before retrying", async () => {
    const docker = createDockerMock({ exitCode: 127, output: "sh: timedatectl: not found" });
    let clock = 1_000_000;
    const now = () => clock;

    const evidence = await detectHostClockSync(availableHelper(docker), { hostRoot, now });
    expect(evidence).toEqual({
      kind: "unknown",
      reason: "the host clock probe exited with status 127: sh: timedatectl: not found",
    });

    clock += CLOCK_PROBE_INTERVAL_MS;
    await detectHostClockSync(availableHelper(docker), { hostRoot, now });
    expect(docker.createContainer).toHaveBeenCalledTimes(1);
  });

  test("should read state and change nothing on the host", () => {
    const script = buildClockProbeScript();

    expect(script).toContain("timedatectl show -p NTP -p NTPSynchronized");
    expect(script).not.toMatch(/set-ntp|systemctl|>/);
  });
});
