import type { BuildAppResult } from "./build.js";
import type { BuildLogEmitter } from "./build-logs.js";
import type { DockerApiClient } from "./docker-api.js";
import type { AgentRuntimeConfig, AppDeployPayload, RuntimeMetadata } from "./protocol.js";
import type { ReleasePhaseRunner } from "./release-jobs.js";

export interface DeployAppImageInput {
  projectId: string;
  environmentId?: string | null;
  serviceId: string;
  deploymentId: string;
  redactionContextVersion?: AppDeployPayload["redactionContextVersion"];
  commitHash: string;
  serviceName: string;
  subdomain: string;
  envVars: Record<string, string>;
  imageUrl: string;
  imageId?: string | null;
  volume?: AppDeployPayload["volume"];
  resourceLimits: AppDeployPayload["resourceLimits"];
  rollout?: AppDeployPayload["rollout"];
  runtimeMetadata?: RuntimeMetadata | null;
  detectedLanguage?: string | null;
  detectedFramework?: string | null;
  languageVersion?: string | null;
  internalPort?: number | null;
  buildDuration?: number | null;
  providedHostname?: string;
  customHostnames?: string[];
  clientIngressConfigHash?: string;
  releaseJobs?: AppDeployPayload["releaseJobs"];
  platformGeneratedValues?: AppDeployPayload["platformGeneratedValues"];
}

/** The scoped BuildKit daemon a deploy builds against, and the memory it was capped at. */
export interface AppBuildkitRuntime {
  address: string;
  memoryBytes: number;
}

export interface BuildAndDeployAppDependencies {
  ensureBaseRuntime: (docker: DockerApiClient, config: AgentRuntimeConfig) => Promise<void>;
  buildApp: (options: {
    docker: Pick<DockerApiClient, "inspectImage" | "loadImage">;
    repoUrl: string;
    commitHash: string;
    deploymentId: string;
    envVars: Record<string, string>;
    resourceLimits: AppDeployPayload["resourceLimits"];
    imageStoreMode: AgentRuntimeConfig["imageStoreMode"];
    localRegistryHost: string;
    localRegistryPort: number;
    buildkitAddress: string;
    builderMemoryBytes: number | null;
    appBuildType?: AppDeployPayload["appBuildType"];
    appBuildConfig?: AppDeployPayload["appBuildConfig"];
    platformGeneratedValues?: readonly string[];
    onBuildLog?: BuildLogEmitter;
  }) => Promise<BuildAppResult>;
  deployAppImage: (
    docker: DockerApiClient,
    config: AgentRuntimeConfig,
    payload: DeployAppImageInput,
    releasePhases?: ReleasePhaseRunner
  ) => Promise<Record<string, unknown>>;
}

export async function buildAndDeployAppWithDependencies(
  dependencies: BuildAndDeployAppDependencies,
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: AppDeployPayload,
  buildkit: AppBuildkitRuntime,
  onBuildLog?: BuildLogEmitter,
  releasePhases?: ReleasePhaseRunner
) {
  await dependencies.ensureBaseRuntime(docker, config);

  const buildResult = await dependencies.buildApp({
    docker,
    repoUrl: payload.repoUrl,
    commitHash: payload.commitHash,
    deploymentId: payload.deploymentId,
    envVars: payload.envVars,
    resourceLimits: payload.resourceLimits,
    imageStoreMode: config.imageStoreMode,
    localRegistryHost: config.localRegistryHost,
    localRegistryPort: config.localRegistryPort,
    buildkitAddress: buildkit.address,
    builderMemoryBytes: buildkit.memoryBytes,
    appBuildType: payload.appBuildType ?? null,
    appBuildConfig: payload.appBuildConfig ?? null,
    platformGeneratedValues: payload.platformGeneratedValues ?? [],
    ...(onBuildLog ? { onBuildLog } : {}),
  });

  onBuildLog?.({
    type: "progress",
    stage: "deploying",
    message: "Starting the container",
    percent: 90,
    timestamp: Date.now(),
  });

  return await dependencies.deployAppImage(
    docker,
    config,
    {
      ...payload,
      imageUrl: buildResult.imageUrl,
      imageId: buildResult.imageId,
      buildDuration: buildResult.buildDuration,
      detectedLanguage: buildResult.detectedLanguage,
      detectedFramework: buildResult.detectedFramework,
      languageVersion: buildResult.languageVersion,
      internalPort: buildResult.internalPort,
    },
    releasePhases
  );
}
