import { ApiRequestError } from "./agent-work-reporting.js";
import type { UpdateAgentPayload } from "./protocol.js";

function toObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function toUpdateAgentPayload(value: unknown): UpdateAgentPayload {
  const payload = toObject(value);
  const releaseId = typeof payload.releaseId === "string" ? payload.releaseId : undefined;
  const version = typeof payload.version === "string" ? payload.version : undefined;
  const imageRef = typeof payload.imageRef === "string" ? payload.imageRef : undefined;
  const imageTag = typeof payload.imageTag === "string" ? payload.imageTag : undefined;

  if ((!imageRef || imageRef.trim().length === 0) && (!imageTag || imageTag.trim().length === 0)) {
    throw new Error("Agent update payload is missing imageRef/imageTag");
  }

  return {
    ...(releaseId ? { releaseId } : {}),
    ...(version ? { version } : {}),
    ...(imageRef ? { imageRef } : {}),
    ...(imageTag ? { imageTag } : {}),
  };
}

export function resolveUpdateAgentImageRef(payload: UpdateAgentPayload): string {
  const imageRef = payload.imageRef?.trim();
  if (imageRef) {
    return imageRef;
  }

  const imageTag = payload.imageTag?.trim();
  if (imageTag) {
    return imageTag;
  }

  throw new Error("Agent update payload is missing imageRef/imageTag");
}

/**
 * A re-leased update (its completion report was lost after the new agent started) must not restart
 * the agent a second time. Both the image and the version have to match: a mutable tag such as
 * `:latest` alone does not prove the running build is the requested release.
 */
export function isAgentUpdateAlreadyApplied(
  running: { image: string; version: string },
  payload: UpdateAgentPayload
): boolean {
  const requestedVersion = payload.version?.trim();
  if (!requestedVersion) {
    return false;
  }

  const normalizeVersion = (version: string) => (version.startsWith("v") ? version : `v${version}`);
  return (
    running.image.trim() === resolveUpdateAgentImageRef(payload) &&
    normalizeVersion(running.version.trim()) === normalizeVersion(requestedVersion)
  );
}

/**
 * What the control plane has said about an update's completion report. `unconfirmed` means at least
 * one attempt failed in a way that may still have committed it, so a later rejection (for example a
 * 409 on retry) does not prove the completion was refused.
 */
export type AgentUpdateCompletionDelivery = "pending" | "delivered" | "unconfirmed" | "rejected";

export function recordAgentUpdateCompletionAttempt(
  current: AgentUpdateCompletionDelivery,
  error: unknown
): AgentUpdateCompletionDelivery {
  if (error === null) {
    return "delivered";
  }
  const transient =
    !(error instanceof ApiRequestError) ||
    error.status >= 500 ||
    error.status === 408 ||
    error.status === 429;
  if (transient || current === "unconfirmed") {
    return "unconfirmed";
  }
  return "rejected";
}

/**
 * The updater restarts the agent, so it only runs once the completion was reported. An unconfirmed
 * report still restarts: if the control plane re-leases the work, the new agent recognises the
 * update as applied and completes it without restarting again.
 */
export function shouldStartAgentUpdater(delivery: AgentUpdateCompletionDelivery): boolean {
  return delivery === "delivered" || delivery === "unconfirmed";
}

/**
 * Starts the updater only once no other work is in flight, so the restart it performs does not
 * kill a concurrent deploy or backup. The caller must already have stopped leasing new work. A work
 * item that never finishes must not block the update forever, so the drain is bounded; work still
 * running at the deadline is interrupted and re-leased by the control plane after its lease expires.
 */
export async function startAgentUpdaterAfterDrain(input: {
  isWorkActive: () => boolean;
  startUpdater: () => Promise<void>;
  drainTimeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}): Promise<void> {
  const deadline = input.now() + input.drainTimeoutMs;
  while (input.isWorkActive()) {
    if (input.now() >= deadline) {
      input.log("[nouva-agent] agent update drain timed out; restarting with work still in flight");
      break;
    }
    await input.sleep(input.pollIntervalMs);
  }

  await input.startUpdater();
}
