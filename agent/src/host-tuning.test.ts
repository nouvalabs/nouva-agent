import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildHostSysctlScript,
  ensureHostKernelSettings,
  HOST_INOTIFY_MAX_USER_INSTANCES,
  HOST_INOTIFY_MAX_USER_WATCHES,
  HOST_SYSCTL_CONFIG_PATH,
  HOST_TUNING_CONTAINER_NAME,
  HOST_TUNING_RETRY_INTERVAL_MS,
  hostInotifyLimitsSatisfied,
  readHostInotifyLimits,
  resetHostTuningBackoffForTests,
} from "./host-tuning.js";

async function writeHostSysctls(
  hostRoot: string,
  values: { watches: number | string; instances: number | string }
): Promise<void> {
  const dir = path.join(hostRoot, "proc/sys/fs/inotify");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "max_user_watches"), `${values.watches}\n`);
  await writeFile(path.join(dir, "max_user_instances"), `${values.instances}\n`);
}

function createDockerMock(input: { exitCode?: number; onStart?: () => Promise<void> } = {}) {
  return {
    createContainer: mock(async () => "container-id"),
    startContainer: mock(async () => {
      await input.onStart?.();
    }),
    waitContainer: mock(async () => input.exitCode ?? 0),
    containerLogs: mock(async () => "sysctl: permission denied"),
    removeContainer: mock(async () => undefined),
  };
}

describe("host tuning", () => {
  let hostRoot = "";

  beforeEach(async () => {
    resetHostTuningBackoffForTests();
    hostRoot = await mkdtemp(path.join(tmpdir(), "nouva-agent-host-"));
  });

  afterEach(async () => {
    await rm(hostRoot, { recursive: true, force: true });
  });

  test("should only raise limits and persist them in sysctl.d", () => {
    const script = buildHostSysctlScript();

    expect(script).toContain(`[ "$watches" -ge ${HOST_INOTIFY_MAX_USER_WATCHES} ]`);
    expect(script).toContain(`[ "$instances" -ge ${HOST_INOTIFY_MAX_USER_INSTANCES} ]`);
    expect(script).toContain(`> ${HOST_SYSCTL_CONFIG_PATH}`);
    expect(script).toContain(`sysctl -q -p ${HOST_SYSCTL_CONFIG_PATH}`);
    expect(script).toContain('echo "$watches" > /proc/sys/fs/inotify/max_user_watches');
  });

  test("should read the host limits and judge them against the baseline", async () => {
    await writeHostSysctls(hostRoot, { watches: 14695, instances: 128 });
    const low = await readHostInotifyLimits(hostRoot);
    expect(low).toEqual({ maxUserWatches: 14695, maxUserInstances: 128 });
    expect(hostInotifyLimitsSatisfied(low)).toBe(false);

    await writeHostSysctls(hostRoot, { watches: 1048576, instances: 512 });
    expect(hostInotifyLimitsSatisfied(await readHostInotifyLimits(hostRoot))).toBe(true);

    expect(await readHostInotifyLimits(path.join(hostRoot, "missing"))).toEqual({
      maxUserWatches: null,
      maxUserInstances: null,
    });
  });

  test("should skip the helper when the host already satisfies the baseline", async () => {
    await writeHostSysctls(hostRoot, { watches: 524288, instances: 512 });
    const docker = createDockerMock();

    const result = await ensureHostKernelSettings(docker, { image: "agent:test", hostRoot });

    expect(result.status).toBe("satisfied");
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  test("should apply limits through a privileged helper in the host namespaces", async () => {
    await writeHostSysctls(hostRoot, { watches: 14695, instances: 128 });
    const docker = createDockerMock({
      onStart: () => writeHostSysctls(hostRoot, { watches: 524288, instances: 512 }),
    });

    const result = await ensureHostKernelSettings(docker, {
      image: "ghcr.io/nouvalabs/nouva-agent:0.4.19",
      hostRoot,
      labels: { "nouva.kind": "host-tuning" },
    });

    expect(result).toEqual({
      status: "applied",
      limits: { maxUserWatches: 524288, maxUserInstances: 512 },
      message: null,
    });
    const spec = docker.createContainer.mock.calls[0]?.[0] as {
      name: string;
      image: string;
      entrypoint?: string[];
      cmd?: string[];
      labels?: Record<string, string>;
      hostConfig?: Record<string, unknown>;
    };
    expect(spec.name).toBe(HOST_TUNING_CONTAINER_NAME);
    expect(spec.image).toBe("ghcr.io/nouvalabs/nouva-agent:0.4.19");
    expect(spec.entrypoint).toEqual(["nsenter"]);
    expect(spec.cmd?.slice(0, 9)).toEqual(["-t", "1", "-m", "-u", "-i", "-n", "--", "sh", "-c"]);
    expect(spec.cmd?.[9]).toBe(buildHostSysctlScript());
    expect(spec.labels).toEqual({ "nouva.kind": "host-tuning" });
    expect(spec.hostConfig).toMatchObject({ Privileged: true, PidMode: "host" });
    expect(docker.removeContainer).toHaveBeenLastCalledWith(HOST_TUNING_CONTAINER_NAME, true);
  });

  test("should report failures and back off before retrying", async () => {
    await writeHostSysctls(hostRoot, { watches: 14695, instances: 128 });
    const docker = createDockerMock({ exitCode: 1 });
    let clock = 1_000_000;
    const now = () => clock;

    const failed = await ensureHostKernelSettings(docker, { image: "agent:test", hostRoot, now });
    expect(failed.status).toBe("failed");
    expect(failed.message).toContain("exited with status 1");
    expect(failed.message).toContain("sysctl: permission denied");

    const deferred = await ensureHostKernelSettings(docker, { image: "agent:test", hostRoot, now });
    expect(deferred.status).toBe("deferred");
    expect(docker.createContainer).toHaveBeenCalledTimes(1);

    clock += HOST_TUNING_RETRY_INTERVAL_MS;
    const retried = await ensureHostKernelSettings(docker, { image: "agent:test", hostRoot, now });
    expect(retried.status).toBe("failed");
    expect(docker.createContainer).toHaveBeenCalledTimes(2);
  });
});
