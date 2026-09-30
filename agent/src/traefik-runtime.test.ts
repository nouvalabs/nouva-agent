import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DockerApiError, type DockerContainerInspection } from "./docker-api.js";
import type { AgentRuntimeConfig } from "./protocol.js";
import {
  buildTraefikContainerSpec,
  buildTraefikRouteConfig,
  collectTraefikValidationChecks,
  countDeclaredTraefikRouters,
  createTraefikStateHash,
  ensureTraefikState,
  getTraefikRuntimePaths,
  reconcileTraefikRuntime,
  renderTraefikStaticConfig,
  resetTraefikRuntimeState,
  resolveRoutingHostnames,
  TRAEFIK_ADMIN_PORT,
  TRAEFIK_API_ENTRYPOINT,
  TRAEFIK_CANDIDATE_ADMIN_PORT,
  TRAEFIK_CANDIDATE_CONTAINER_NAME,
  TRAEFIK_CONFIG_HASH_LABEL,
  TRAEFIK_CONTAINER_NAME,
  TRAEFIK_IMAGE,
  writeTraefikRouteFile,
} from "./traefik-runtime.js";

const runtimeConfig: AgentRuntimeConfig = {
  heartbeatIntervalSeconds: 30,
  pollIntervalSeconds: 10,
  leaseTtlSeconds: 120,
  metricsIntervalSeconds: 30,
  postgresObservabilityIntervalSeconds: 30,
  ingressMode: "local_traefik",
  buildkitMode: "docker-container",
  capabilities: {
    dockerApi: true,
    buildkit: true,
    localRegistry: true,
    localTraefik: true,
    hostMetrics: true,
    containerMetrics: true,
    postgresObservability: true,
  },
  localRegistryHost: "127.0.0.1",
  localRegistryPort: 5000,
  localTraefikNetwork: "nouva-ingress",
  observability: {
    enabled: false,
    organizationId: null,
    alloyImage: "grafana/alloy:v1.17.1",
    scrapeIntervalSeconds: 30,
    collectorScope: "services_traefik_and_workers",
    noneLabelValue: "__none__",
  },
};

function createTraefikInspection(input: {
  name?: string;
  image?: string;
  running?: boolean;
  stateHash?: string;
  port80?: boolean;
  port443?: boolean;
  adminPort?: number;
}): DockerContainerInspection {
  return {
    Id: input.name ?? TRAEFIK_CONTAINER_NAME,
    Name: input.name ?? TRAEFIK_CONTAINER_NAME,
    State: {
      Running: input.running ?? true,
    },
    HostConfig: {
      PortBindings: {
        ...(input.port80 === false
          ? {}
          : {
              "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "80" }],
            }),
        ...(input.port443 === false
          ? {}
          : {
              "443/tcp": [{ HostIp: "0.0.0.0", HostPort: "443" }],
            }),
        "8082/tcp": [
          {
            HostIp: "127.0.0.1",
            HostPort: String(input.adminPort ?? TRAEFIK_ADMIN_PORT),
          },
        ],
      },
    },
    Config: {
      Image: input.image ?? TRAEFIK_IMAGE,
      Labels: {
        [TRAEFIK_CONFIG_HASH_LABEL]: input.stateHash ?? "state-hash",
      },
    },
  };
}

describe("traefik-runtime", () => {
  let tempDir = "";

  afterEach(async () => {
    resetTraefikRuntimeState();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("should normalize hostnames from provided and custom routing payloads", () => {
    expect(
      resolveRoutingHostnames({
        providedHostname: "Frontend.UP.Nouva.Cloud",
        customHostnames: ["app.example.com", " frontend.up.nouva.cloud ", "docs.example.com"],
      })
    ).toEqual(["frontend.up.nouva.cloud", "app.example.com", "docs.example.com"]);
  });

  test("should render redirect and TLS routers for file-provider configs", () => {
    const config = buildTraefikRouteConfig({
      fileKey: "svc_1",
      hostnames: ["frontend.up.nouva.cloud", "app.example.com"],
      serviceUrl: "http://nouva-app:3000",
    });

    expect(config).toContain("middlewares:");
    expect(config).toContain("redirectScheme:");
    expect(config).toContain("certResolver: letsencrypt");
    expect(config).toContain("Host(`frontend.up.nouva.cloud`) || Host(`app.example.com`)");
  });

  test("should keep provided hostnames on plain HTTP for hosted edge routing", () => {
    const config = buildTraefikRouteConfig({
      fileKey: "svc_1",
      providedHostnames: ["frontend.up.nouva.cloud"],
      serviceUrl: "http://nouva-app:3000",
    });

    expect(config).toContain("Host(`frontend.up.nouva.cloud`)");
    expect(config).toContain("- web");
    expect(config).not.toContain("- websecure");
    expect(config).not.toContain("certResolver: letsencrypt");
    expect(config).not.toContain("redirectScheme:");
  });

  test("should rewrite placeholder requests without preserving the custom Host header", () => {
    const config = buildTraefikRouteConfig({
      fileKey: "svc-placeholder",
      customHostnames: ["pending.example.com"],
      serviceUrl: "https://nouva.sh",
      passHostHeader: false,
      replacePath: "/_nouva/domain-pending",
    });

    expect(config).toContain("passHostHeader: false");
    expect(config).toContain("replace-path-svc-placeholder");
    expect(config).toContain("path: /_nouva/domain-pending");
    expect(config).toContain("url: https://nouva.sh");
  });

  test("publishes request metrics on the loopback admin entrypoint only", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
    const paths = getTraefikRuntimePaths(tempDir);
    await ensureTraefikState(paths);

    const staticConfig = renderTraefikStaticConfig(paths);

    expect(staticConfig).toContain("metrics:");
    expect(staticConfig).toContain("  prometheus:");
    // The admin entrypoint is already bound to 127.0.0.1, so metrics add no host exposure.
    expect(staticConfig).toContain(`    entryPoint: ${TRAEFIK_API_ENTRYPOINT}`);
    expect(staticConfig).toContain("    addServicesLabels: true");
    // Entrypoint series say nothing per service; router series would multiply each service by
    // its router count for a breakdown nothing queries.
    expect(staticConfig).toContain("    addEntryPointsLabels: false");
    expect(staticConfig).toContain("    addRoutersLabels: false");

    const spec = buildTraefikContainerSpec(runtimeConfig, {
      dataVolume: "nouva-agent-data",
      stateHash: createTraefikStateHash(staticConfig),
    });
    // Still loopback-only on the host: Alloy reaches 8082 over the ingress network instead.
    expect(spec.hostConfig?.PortBindings?.["8082/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "8082" },
    ]);
  });

  test("should pin Traefik v3.5 and bind 80, 443, and localhost 8082", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
    const paths = getTraefikRuntimePaths(tempDir);
    await ensureTraefikState(paths);

    const staticConfig = renderTraefikStaticConfig(paths);
    const spec = buildTraefikContainerSpec(runtimeConfig, {
      dataVolume: "nouva-agent-data",
      stateHash: createTraefikStateHash(staticConfig),
    });

    expect(staticConfig).toContain('address: ":80"');
    expect(staticConfig).toContain('address: ":443"');
    expect(staticConfig).toContain('address: ":8082"');
    expect(staticConfig).toContain(`entryPoint: ${TRAEFIK_API_ENTRYPOINT}`);
    expect(staticConfig).toContain(`  ${TRAEFIK_API_ENTRYPOINT}:`);
    expect(spec.image).toBe("traefik:v3.5");
    expect(spec.hostConfig).toEqual(
      expect.objectContaining({
        LogConfig: {
          Type: "json-file",
          Config: { "max-size": "10m", "max-file": "3" },
        },
        PortBindings: expect.objectContaining({
          "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "80" }],
          "443/tcp": [{ HostIp: "0.0.0.0", HostPort: "443" }],
          "8082/tcp": [{ HostIp: "127.0.0.1", HostPort: "8082" }],
        }),
      })
    );
  });

  test("should persist static, dynamic, and acme state with 0600 ACME mode", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
    const paths = getTraefikRuntimePaths(tempDir);
    await ensureTraefikState(paths);

    const acmeContent = await readFile(paths.acmeStoragePath, "utf8");
    const acmeStats = await stat(paths.acmeStoragePath);

    expect(acmeContent).toBe("{}\n");
    expect(acmeStats.mode & 0o777).toBe(0o600);
  });

  test("should roll back to the previous image when cutover health checks fail", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
    const paths = getTraefikRuntimePaths(tempDir);
    await ensureTraefikState(paths);
    await writeTraefikRouteFile(paths, "svc_1", ["frontend.up.nouva.cloud"], "http://svc_1:3000");

    const staticConfig = renderTraefikStaticConfig(paths);
    const stateHash = createTraefikStateHash(staticConfig);
    const dockerState: Record<string, DockerContainerInspection | null> = {
      [TRAEFIK_CONTAINER_NAME]: createTraefikInspection({
        image: "traefik:v3.4",
        stateHash,
      }),
    };

    const docker = {
      ensureNetwork: mock(async () => {}),
      listNetworks: mock(async () => [
        {
          Id: "network-1",
          Name: "nouva-project-one",
          Labels: {
            "nouva.managed": "true",
            "nouva.server.id": "server-1",
            "nouva.project.id": "project-1",
          },
        },
      ]),
      connectNetwork: mock(async () => {}),
      pullImage: mock(async () => {}),
      removeContainer: mock(async (name: string) => {
        dockerState[name] = null;
      }),
      inspectContainer: mock(async (name: string) => dockerState[name] ?? null),
      ensureContainer: mock(
        async (spec: { name: string; image: string; labels?: Record<string, string> }) => {
          dockerState[spec.name] = createTraefikInspection({
            name: spec.name,
            image: spec.image,
            adminPort:
              spec.name === TRAEFIK_CANDIDATE_CONTAINER_NAME
                ? TRAEFIK_CANDIDATE_ADMIN_PORT
                : TRAEFIK_ADMIN_PORT,
            stateHash: spec.labels?.[TRAEFIK_CONFIG_HASH_LABEL] ?? stateHash,
          });
          return spec.name;
        }
      ),
    };

    const fetchImpl: typeof fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith(`:${TRAEFIK_CANDIDATE_ADMIN_PORT}/ping`)) {
        return new Response("OK", { status: 200 });
      }

      if (url.endsWith(`:${TRAEFIK_CANDIDATE_ADMIN_PORT}/api/http/routers`)) {
        return Response.json([
          {
            name: "http-svc_1@file",
            provider: "file",
            rule: "Host(`frontend.up.nouva.cloud`)",
          },
          {
            name: "https-svc_1@file",
            provider: "file",
            rule: "Host(`frontend.up.nouva.cloud`)",
          },
        ]);
      }

      if (url.endsWith(`:${TRAEFIK_ADMIN_PORT}/ping`)) {
        return dockerState[TRAEFIK_CONTAINER_NAME]?.Config?.Image === "traefik:v3.4"
          ? new Response("OK", { status: 200 })
          : new Response("fail", { status: 503 });
      }

      if (url.endsWith(`:${TRAEFIK_ADMIN_PORT}/api/http/routers`)) {
        return Response.json([
          {
            name: "http-svc_1@file",
            provider: "file",
            rule: "Host(`frontend.up.nouva.cloud`)",
          },
          {
            name: "https-svc_1@file",
            provider: "file",
            rule: "Host(`frontend.up.nouva.cloud`)",
          },
        ]);
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await expect(
      reconcileTraefikRuntime(docker as never, runtimeConfig, {
        dataVolume: "nouva-agent-data",
        paths,
        fetchImpl,
        timeoutMs: 20,
        intervalMs: 1,
      })
    ).rejects.toThrow("Traefik ping endpoint is not healthy");

    expect(docker.ensureContainer.mock.calls.map((call) => call[0].image)).toEqual([
      TRAEFIK_IMAGE,
      TRAEFIK_IMAGE,
      "traefik:v3.4",
    ]);
    expect(docker.connectNetwork.mock.calls).toEqual([
      ["nouva-project-one", TRAEFIK_CANDIDATE_CONTAINER_NAME],
      ["nouva-project-one", TRAEFIK_CONTAINER_NAME],
      ["nouva-project-one", TRAEFIK_CONTAINER_NAME],
    ]);
  });

  test("reconnects a current Traefik container to every managed project network", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
    const paths = getTraefikRuntimePaths(tempDir);
    await ensureTraefikState(paths);
    const stateHash = createTraefikStateHash(renderTraefikStaticConfig(paths));
    const docker = {
      ensureNetwork: mock(async () => {}),
      inspectContainer: mock(async () => createTraefikInspection({ stateHash })),
      listNetworks: mock(async () => [
        {
          Id: "network-1",
          Name: "nouva-project-one",
          Labels: {
            "nouva.managed": "true",
            "nouva.server.id": "server-1",
            "nouva.project.id": "project-1",
          },
        },
        {
          Id: "network-2",
          Name: "nouva-project-two",
          Labels: {
            "nouva.managed": "true",
            "nouva.server.id": "server-1",
            "nouva.project.id": "project-2",
          },
        },
        {
          Id: "network-foreign",
          Name: "nouva-project-foreign",
          Labels: {
            "nouva.managed": "true",
            "nouva.server.id": "server-2",
            "nouva.project.id": "project-3",
          },
        },
        {
          Id: "network-ingress",
          Name: "nouva-ingress",
          Labels: {},
        },
      ]),
      connectNetwork: mock(async () => {}),
    };

    await reconcileTraefikRuntime(docker as never, runtimeConfig, {
      dataVolume: "nouva-agent-data",
      labels: {
        "nouva.server.id": "server-1",
      },
      paths,
    });

    expect(docker.connectNetwork.mock.calls).toEqual([
      ["nouva-project-one", TRAEFIK_CONTAINER_NAME],
      ["nouva-project-two", TRAEFIK_CONTAINER_NAME],
    ]);
  });

  describe("when a connect finds nothing to connect", () => {
    const projectNetwork = (name: string, projectId: string) => ({
      Id: name,
      Name: name,
      Labels: { "nouva.managed": "true", "nouva.project.id": projectId },
    });

    async function reconcileCurrent(input: {
      notFound: string;
      networkStillExists: boolean;
      status?: number;
    }): Promise<{ failure: unknown; connected: string[] }> {
      tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
      const paths = getTraefikRuntimePaths(tempDir);
      await ensureTraefikState(paths);
      const stateHash = createTraefikStateHash(renderTraefikStaticConfig(paths));
      const connected: string[] = [];
      const docker = {
        ensureNetwork: mock(async () => {}),
        inspectContainer: mock(async () => createTraefikInspection({ stateHash })),
        listNetworks: mock(async () => [
          projectNetwork("nouva-project-one", "project-1"),
          projectNetwork("nouva-project-two", "project-2"),
        ]),
        connectNetwork: mock(async (network: string) => {
          if (network === "nouva-project-one") {
            throw new DockerApiError(
              input.status ?? 404,
              "POST",
              `/v1.52/networks/${network}/connect`,
              input.notFound
            );
          }
          connected.push(network);
        }),
        inspectNetwork: mock(async (network: string) =>
          network === "nouva-project-one" && !input.networkStillExists ? null : { Name: network }
        ),
      };
      const failure = await reconcileTraefikRuntime(docker as never, runtimeConfig, {
        dataVolume: "nouva-agent-data",
        paths,
      }).then(
        () => null,
        (error: unknown) => error
      );
      return { failure, connected };
    }

    // #449: `delete_project` does not wait for the reconcile, so a network the listing returned
    // can be gone by the time Traefik is connected to it.
    test("skips a project network deleted since the listing", async () => {
      const { failure, connected } = await reconcileCurrent({
        notFound: '{"message":"network nouva-project-one not found"}',
        networkStillExists: false,
      });

      expect(failure).toBeNull();
      expect(connected).toEqual(["nouva-project-two"]);
    });

    test("still fails when the Traefik container is the one missing", async () => {
      const { failure } = await reconcileCurrent({
        notFound: '{"message":"No such container: nouva-traefik"}',
        networkStillExists: true,
      });

      expect((failure as Error).message).toContain("No such container: nouva-traefik");
    });

    test("still fails when Docker errors on a network deleted since the listing", async () => {
      const { failure } = await reconcileCurrent({
        notFound: '{"message":"network nouva-project-one is being removed"}',
        networkStillExists: false,
        status: 500,
      });

      expect((failure as Error).message).toContain("is being removed");
    });
  });

  // #468: a connect that fails after a Traefik container is created must take the same cleanup,
  // rollback and failure-recording path as a failed health check.
  describe("when connecting a new Traefik container to a project network fails", () => {
    async function replaceTraefik(failingContainer: string) {
      tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
      const paths = getTraefikRuntimePaths(tempDir);
      await ensureTraefikState(paths);
      await writeTraefikRouteFile(paths, "svc_1", ["frontend.up.nouva.cloud"], "http://svc_1:3000");
      const stateHash = createTraefikStateHash(renderTraefikStaticConfig(paths));
      const dockerState: Record<string, DockerContainerInspection | null> = {
        [TRAEFIK_CONTAINER_NAME]: createTraefikInspection({ image: "traefik:v3.4", stateHash }),
      };
      let connectFailed = false;
      const docker = {
        ensureNetwork: mock(async () => {}),
        listNetworks: mock(async () => [
          {
            Id: "network-1",
            Name: "nouva-project-one",
            Labels: { "nouva.managed": "true", "nouva.project.id": "project-1" },
          },
        ]),
        connectNetwork: mock(async (network: string, container: string) => {
          if (container === failingContainer && !connectFailed) {
            connectFailed = true;
            throw new DockerApiError(
              500,
              "POST",
              `/v1.52/networks/${network}/connect`,
              '{"message":"failed to add interface to sandbox"}'
            );
          }
        }),
        inspectNetwork: mock(async (network: string) => ({ Name: network })),
        pullImage: mock(async () => {}),
        removeContainer: mock(async (name: string) => {
          dockerState[name] = null;
        }),
        inspectContainer: mock(async (name: string) => dockerState[name] ?? null),
        ensureContainer: mock(
          async (spec: { name: string; image: string; labels?: Record<string, string> }) => {
            dockerState[spec.name] = createTraefikInspection({
              name: spec.name,
              image: spec.image,
              adminPort:
                spec.name === TRAEFIK_CANDIDATE_CONTAINER_NAME
                  ? TRAEFIK_CANDIDATE_ADMIN_PORT
                  : TRAEFIK_ADMIN_PORT,
              stateHash: spec.labels?.[TRAEFIK_CONFIG_HASH_LABEL] ?? stateHash,
            });
            return spec.name;
          }
        ),
      };
      const fetchImpl: typeof fetch = mock(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/ping")) {
          return new Response("OK", { status: 200 });
        }
        if (url.endsWith("/api/http/routers")) {
          return Response.json([
            { name: "http-svc_1@file", provider: "file", rule: "Host(`frontend.up.nouva.cloud`)" },
            { name: "https-svc_1@file", provider: "file", rule: "Host(`frontend.up.nouva.cloud`)" },
          ]);
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      const failure = await reconcileTraefikRuntime(docker as never, runtimeConfig, {
        dataVolume: "nouva-agent-data",
        paths,
        fetchImpl,
        timeoutMs: 20,
        intervalMs: 1,
      }).then(
        () => null,
        (error: unknown) => error
      );
      const checks = await collectTraefikValidationChecks(docker as never, { paths, fetchImpl });
      return {
        failure,
        createdImages: docker.ensureContainer.mock.calls.map((call) => call[0].image),
        dockerState,
        containerCheck: checks.find((check) => check.key === "traefik-container"),
      };
    }

    test("rolls the cutover back to the previous image and records the failure", async () => {
      const { failure, createdImages, dockerState, containerCheck } =
        await replaceTraefik(TRAEFIK_CONTAINER_NAME);

      expect((failure as Error).message).toContain("failed to add interface to sandbox");
      expect(createdImages).toEqual([TRAEFIK_IMAGE, TRAEFIK_IMAGE, "traefik:v3.4"]);
      expect(dockerState[TRAEFIK_CONTAINER_NAME]?.Config?.Image).toBe("traefik:v3.4");
      expect(dockerState[TRAEFIK_CANDIDATE_CONTAINER_NAME]).toBeNull();
      expect(containerCheck?.message).toContain("last reconcile failed during cutover");
      expect(containerCheck?.message).toContain("(rollback succeeded)");
    });

    test("removes the preflight candidate and records the failure", async () => {
      const { failure, createdImages, dockerState, containerCheck } = await replaceTraefik(
        TRAEFIK_CANDIDATE_CONTAINER_NAME
      );

      expect((failure as Error).message).toContain("failed to add interface to sandbox");
      expect(createdImages).toEqual([TRAEFIK_IMAGE]);
      expect(dockerState[TRAEFIK_CONTAINER_NAME]?.Config?.Image).toBe("traefik:v3.4");
      expect(dockerState[TRAEFIK_CANDIDATE_CONTAINER_NAME]).toBeNull();
      expect(containerCheck?.message).toContain("last reconcile failed during preflight");
    });
  });

  test("should report the fixed Traefik validation keys", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
    const paths = getTraefikRuntimePaths(tempDir);
    await ensureTraefikState(paths);
    await writeTraefikRouteFile(paths, "svc_1", ["frontend.up.nouva.cloud"], "http://svc_1:3000");

    const staticConfig = renderTraefikStaticConfig(paths);
    const docker = {
      inspectContainer: mock(async () =>
        createTraefikInspection({
          stateHash: createTraefikStateHash(staticConfig),
        })
      ),
    };

    const fetchImpl: typeof fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/ping")) {
        return new Response("OK", { status: 200 });
      }

      if (url.endsWith("/api/http/routers")) {
        return Response.json([
          {
            name: "http-svc_1@file",
            provider: "file",
            rule: "Host(`frontend.up.nouva.cloud`)",
          },
          {
            name: "https-svc_1@file",
            provider: "file",
            rule: "Host(`frontend.up.nouva.cloud`)",
          },
        ]);
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const checks = await collectTraefikValidationChecks(docker as never, {
      paths,
      fetchImpl,
    });

    expect(checks.map((check) => check.key)).toEqual([
      "traefik-image",
      "traefik-container",
      "traefik-port-80",
      "traefik-port-443",
      "traefik-ping",
      "traefik-acme",
      "traefik-routes",
    ]);
  });
});

describe("traefik route accounting", () => {
  test("should count the routers each managed route file declares", () => {
    expect(
      countDeclaredTraefikRouters(
        buildTraefikRouteConfig({
          fileKey: "svc_1",
          providedHostnames: ["frontend.up.nouva.cloud"],
          serviceUrl: "http://nouva-app:3000",
        })
      )
    ).toBe(1);
    expect(
      countDeclaredTraefikRouters(
        buildTraefikRouteConfig({
          fileKey: "svc_1",
          customHostnames: ["app.example.com"],
          serviceUrl: "http://nouva-app:3000",
        })
      )
    ).toBe(2);
    expect(
      countDeclaredTraefikRouters(
        buildTraefikRouteConfig({
          fileKey: "svc_1",
          providedHostnames: ["frontend.up.nouva.cloud"],
          customHostnames: ["app.example.com"],
          serviceUrl: "http://nouva-app:3000",
          replacePath: "/_nouva/domain-pending",
        })
      )
    ).toBe(3);
    expect(countDeclaredTraefikRouters("http:\n  services:\n    svc:\n")).toBe(0);
  });

  test("should pass the routes check for provided-hostname-only services", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
    try {
      const paths = getTraefikRuntimePaths(tempDir);
      await ensureTraefikState(paths);
      await writeTraefikRouteFile(
        paths,
        "svc_1",
        { providedHostname: "frontend.up.nouva.cloud" },
        "http://svc_1:3000"
      );

      const staticConfig = renderTraefikStaticConfig(paths);
      const docker = {
        inspectContainer: mock(async () =>
          createTraefikInspection({ stateHash: createTraefikStateHash(staticConfig) })
        ),
      };
      const routers: Array<{ name: string; provider: string; rule: string }> = [];
      const fetchImpl: typeof fetch = mock(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/ping")) {
          return new Response("OK", { status: 200 });
        }
        if (url.endsWith("/api/http/routers")) {
          return Response.json(routers);
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      const failing = await collectTraefikValidationChecks(docker as never, { paths, fetchImpl });
      expect(failing.find((check) => check.key === "traefik-routes")).toMatchObject({
        status: "fail",
        message: "Expected 1 file-provider routers from 1 route files but found 0",
      });

      routers.push({
        name: "http-svc_1@file",
        provider: "file",
        rule: "Host(`frontend.up.nouva.cloud`)",
      });
      const passing = await collectTraefikValidationChecks(docker as never, { paths, fetchImpl });
      expect(passing.find((check) => check.key === "traefik-routes")).toMatchObject({
        status: "pass",
        message: "Loaded 1 routers from 1 route files",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("traefik forwarded headers", () => {
  let tempDir = "";

  afterEach(async () => {
    resetTraefikRuntimeState();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("should trust the hosted edge on the provided-domain entrypoint only", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
    const paths = getTraefikRuntimePaths(tempDir);
    await ensureTraefikState(paths);

    const staticConfig = renderTraefikStaticConfig(paths, [
      "40.160.2.8/32",
      "2604:2dc0:101:200::310e",
    ]);

    // Provided hostnames reach this entrypoint over plain HTTP from the edge, so without the peer
    // the app is told the request was `http` on port 80 however the browser actually connected.
    expect(staticConfig).toContain(
      [
        "  web:",
        '    address: ":80"',
        "    forwardedHeaders:",
        "      trustedIPs:",
        "        - 40.160.2.8/32",
        "        - 2604:2dc0:101:200::310e",
        "  websecure:",
        '    address: ":443"',
      ].join("\n")
    );
    expect(staticConfig.split("  websecure:")[1]).not.toContain("forwardedHeaders");
  });

  test("should leave the entrypoint untrusting when the control plane names no edge", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
    const paths = getTraefikRuntimePaths(tempDir);
    await ensureTraefikState(paths);

    expect(renderTraefikStaticConfig(paths)).not.toContain("forwardedHeaders");
    expect(renderTraefikStaticConfig(paths, [])).not.toContain("forwardedHeaders");
  });

  test("should drop peers that trust the internet or that Traefik cannot parse", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
    const paths = getTraefikRuntimePaths(tempDir);
    await ensureTraefikState(paths);

    for (const peer of [
      "0.0.0.0/0",
      "::/0",
      "edge.nouva.sh",
      "40.160.2.8:80",
      "40.160.2.8/33",
      "2604:2dc0:101:200::310e/129",
      "999.1.1.1",
      "40.160.2.8/32/32",
      '"\n  websecure:\n    address: ":8443"',
      // Half-written IPv6: each of these would be rendered by a looser check and would then
      // stop Traefik on every reconcile instead of leaving the entrypoint untrusting.
      ":",
      "1:2",
      ":::1",
      "1:2:3:4:5:6:7:",
      "1:2:3:4:5:6:7:8:9",
      "2001:db8::1::2",
      "::ffff:999.1.1.1",
      // Go reads a leading zero as an error, not as octal, so traefik:v3.5 aborts with
      // `invalid CIDR address: 010.0.0.1` rather than trusting 10.0.0.1 or 8.0.0.1.
      "010.0.0.1",
      "10.0.0.01",
      "::ffff:010.0.0.1",
      "010.0.0.0/24",
      // A dotted quad only stands in for the last two hextets, so a compression cannot follow it.
      "1.2.3.4::",
      // A zone names an interface on whoever wrote the entry, not a peer that can dial in, and Go
      // drops zoned addresses on the floor.
      "fe80::1%eth0",
      "2604:2dc0:101:200::310e%eth0",
    ]) {
      expect(renderTraefikStaticConfig(paths, [peer])).not.toContain("forwardedHeaders");
    }

    // `::` is the unspecified address: syntactically an address Traefik loads, and no peer ever
    // presents it, so there is no reason for this to be the check that rejects it.
    for (const peer of [
      "::",
      "2604:2dc0:101:200::310e/64",
      "::ffff:192.0.2.1",
      "2001:0db8:0000:0000:0000:0000:0000:0001",
      // A bare zero octet is not a leading zero, and Traefik loads it.
      "10.0.0.0/24",
      "0.0.0.1",
    ]) {
      expect(renderTraefikStaticConfig(paths, [peer])).toContain(`        - ${peer}`);
    }

    expect(
      renderTraefikStaticConfig(paths, ["203.0.113.7", "  203.0.113.7  ", "10.0.0.0/24"])
    ).toContain(["      trustedIPs:", "        - 203.0.113.7", "        - 10.0.0.0/24"].join("\n"));
  });

  test("should drop a prefix wider than the one edge host an entry is meant to name", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
    const paths = getTraefikRuntimePaths(tempDir);
    await ensureTraefikState(paths);

    for (const peer of [
      // `/1` is a typo for `/32` as easily as `/0` is, and it trusts half the IPv4 internet.
      "0.0.0.0/0",
      "0.0.0.0/1",
      "203.0.113.0/1",
      "10.0.0.0/8",
      // One step wider than the bound: 512 hosts is already more than an edge egress set.
      "203.0.113.0/23",
      "::/0",
      "2604:2dc0:101:200::/1",
      "2604:2dc0:101:200::/47",
      // Out of range on the narrow side, and prefixes Go will not read as a number at all.
      "40.160.2.8/33",
      "2604:2dc0:101:200::310e/129",
      "40.160.2.8/033",
      "2604:2dc0:101:200::310e/0128",
      "40.160.2.8/abc",
      "40.160.2.8/1/2",
      "40.160.2.8/",
      "40.160.2.8/-24",
      "40.160.2.8/ 24",
    ]) {
      expect(renderTraefikStaticConfig(paths, [peer])).not.toContain("forwardedHeaders");
    }

    for (const peer of [
      "203.0.113.0/24",
      "40.160.2.8/32",
      "40.160.2.8",
      "2604:2dc0:101:200::/48",
      "2604:2dc0:101:200::310e/128",
      "2604:2dc0:101:200::310e",
    ]) {
      expect(renderTraefikStaticConfig(paths, [peer])).toContain(`        - ${peer}`);
    }

    // `DEFAULT_EDGE_FORWARDED_PEERS`, the only value the control plane ships, has to survive the
    // bound: a dropped entry leaves the edge untrusted, and every app behind a provided hostname
    // then sees the proxy's address instead of the client's.
    expect(renderTraefikStaticConfig(paths, ["40.160.2.8/32"])).toContain(
      "        - 40.160.2.8/32"
    );
  });

  test("should cut Traefik over when the trusted edge changes", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
    const paths = getTraefikRuntimePaths(tempDir);
    await ensureTraefikState(paths);

    const untrustedHash = createTraefikStateHash(renderTraefikStaticConfig(paths));
    const trustedHash = createTraefikStateHash(renderTraefikStaticConfig(paths, ["40.160.2.8/32"]));
    expect(trustedHash).not.toBe(untrustedHash);

    const dockerState: Record<string, DockerContainerInspection | null> = {
      [TRAEFIK_CONTAINER_NAME]: createTraefikInspection({ stateHash: untrustedHash }),
    };
    const docker = {
      ensureNetwork: mock(async () => {}),
      listNetworks: mock(async () => []),
      connectNetwork: mock(async () => {}),
      pullImage: mock(async () => {}),
      removeContainer: mock(async (name: string) => {
        dockerState[name] = null;
      }),
      inspectContainer: mock(async (name: string) => dockerState[name] ?? null),
      ensureContainer: mock(
        async (spec: { name: string; image: string; labels?: Record<string, string> }) => {
          dockerState[spec.name] = createTraefikInspection({
            name: spec.name,
            image: spec.image,
            adminPort:
              spec.name === TRAEFIK_CANDIDATE_CONTAINER_NAME
                ? TRAEFIK_CANDIDATE_ADMIN_PORT
                : TRAEFIK_ADMIN_PORT,
            port80: spec.name !== TRAEFIK_CANDIDATE_CONTAINER_NAME,
            port443: spec.name !== TRAEFIK_CANDIDATE_CONTAINER_NAME,
            stateHash: spec.labels?.[TRAEFIK_CONFIG_HASH_LABEL] ?? untrustedHash,
          });
          return spec.name;
        }
      ),
    };
    const fetchImpl: typeof fetch = mock(async (input: RequestInfo | URL) =>
      String(input).endsWith("/ping") ? new Response("OK", { status: 200 }) : Response.json([])
    ) as typeof fetch;

    await reconcileTraefikRuntime(
      docker as never,
      { ...runtimeConfig, trustedForwardedPeers: ["40.160.2.8/32"] },
      { dataVolume: "nouva-agent-data", paths, fetchImpl, timeoutMs: 200, intervalMs: 1 }
    );

    expect(await readFile(paths.staticConfigPath, "utf8")).toContain("        - 40.160.2.8/32");
    expect(
      docker.ensureContainer.mock.calls.map((call) => call[0].labels?.[TRAEFIK_CONFIG_HASH_LABEL])
    ).toEqual([trustedHash, trustedHash]);
  });
});
