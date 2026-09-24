import { describe, expect, test } from "bun:test";
import { resolveUpdateAgentImageRef, toUpdateAgentPayload } from "./update-agent.js";

describe("update agent payload compatibility", () => {
  test("accepts the legacy imageTag payload", () => {
    const payload = toUpdateAgentPayload({
      imageTag: "ghcr.io/nouvalabs/nouva-agent:v0.2.0",
    });

    expect(payload).toEqual({
      imageTag: "ghcr.io/nouvalabs/nouva-agent:v0.2.0",
    });
    expect(resolveUpdateAgentImageRef(payload)).toBe("ghcr.io/nouvalabs/nouva-agent:v0.2.0");
  });

  test("prefers imageRef for digest-pinned rollout payloads", () => {
    const payload = toUpdateAgentPayload({
      releaseId: "rel_123",
      version: "v0.2.0",
      imageRef: "ghcr.io/nouvalabs/nouva-agent@sha256:deadbeef",
      imageTag: "ghcr.io/nouvalabs/nouva-agent:v0.2.0",
    });

    expect(payload).toEqual({
      releaseId: "rel_123",
      version: "v0.2.0",
      imageRef: "ghcr.io/nouvalabs/nouva-agent@sha256:deadbeef",
      imageTag: "ghcr.io/nouvalabs/nouva-agent:v0.2.0",
    });
    expect(resolveUpdateAgentImageRef(payload)).toBe(
      "ghcr.io/nouvalabs/nouva-agent@sha256:deadbeef"
    );
  });

  test("rejects missing image references", () => {
    expect(() => toUpdateAgentPayload({ releaseId: "rel_123" })).toThrow(
      "Agent update payload is missing imageRef/imageTag"
    );
  });
});
