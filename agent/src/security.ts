import {
  collectConfiguredSecretValues,
  collectEnvironmentMapValues,
  createLogTextRedactor,
  redactLogText,
  sanitizeLogValue,
} from "@repo/runtime/logging";

export type EnvironmentVariableMap = Readonly<Record<string, string | undefined>>;

/**
 * `operationalValues` are the exact plaintext strings the leased payload itself declares — the
 * paths (`dataPath`, `mountPath`) and the service identity the control plane generated (provided
 * hostname, custom domains, container and network names, image reference); see
 * `collectAgentWorkPayloadOperationalValues` in `@repo/runtime/logging`. They are exempt from
 * redaction even when an environment value such as `PGDATA` or `PHX_HOST` is identical, because
 * the control plane already holds them unencrypted.
 */
export function redactSensitiveText(
  value: string,
  environmentVariables?: EnvironmentVariableMap,
  operationalValues: readonly string[] = []
): string {
  return redactLogText(value, {
    ...(environmentVariables ? { environmentVariables } : {}),
    operationalValues,
  });
}

/**
 * Redactor for one build's log, compiled once and reused for every line it emits.
 *
 * It differs from `redactSensitiveText` in the two ways a build log needs, and both come from the
 * same over-matching family as #125, #187 and #219:
 *
 * - It protects environment *values* only. A variable name is already visible to anyone who can
 *   read the log, and treating names as protected material is what reduced an explanatory line to
 *   `reading [REDACTED] and [REDACTED] from the environment`.
 * - It honours `platformGeneratedValues`, so a fixed literal the platform emits for every service
 *   of a kind — `require` from `PGSSLMODE`, `postgres` from `PGDATABASE` — is masked only where it
 *   stands as its own word. Without it the agent turned `requirements.txt` into
 *   `[REDACTED]ments.txt` before the line ever left the server, which the control plane's own fix
 *   for the same rule (#245) could not undo. A port among them, such as `PGPORT=5432`, is not
 *   masked at all (#398).
 *
 * A customer's value keeps matching anywhere it appears, however ordinary it looks, and the
 * agent's own configured secrets are never relaxed.
 */
export function createBuildLogRedactor(
  environmentVariables: EnvironmentVariableMap,
  platformGeneratedValues: readonly string[] = []
): (value: string) => string {
  return createLogTextRedactor({
    platformGeneratedValues,
    secretValues: [
      ...collectConfiguredSecretValues(),
      ...collectEnvironmentMapValues(environmentVariables),
    ],
  });
}

/** `assignedNames` are the names derived from the work's ids; see `LogRedactionOptions`. */
export function sanitizeSensitiveValue(
  value: unknown,
  environmentVariables?: EnvironmentVariableMap,
  operationalValues: readonly string[] = [],
  assignedNames: readonly string[] = []
): unknown {
  return sanitizeLogValue(value, {
    assignedNames,
    ...(environmentVariables ? { environmentVariables } : {}),
    operationalValues,
  });
}

/**
 * Sanitizes a protocol field whose redacted copy is compared against the original to detect a leak.
 * Unlike `sanitizeSensitiveValue` this protects variable *values* only: protocol fields carry
 * platform-generated strings, so a variable *name* matching one is not a leak, and treating names
 * as protected material turned healthy deployments into permanent failures (#187). For the same
 * reason the field's own property names are left alone: they are the agent's, so `MODE=strategy`
 * is not leaking through `rollout.strategy` (#397).
 */
export function sanitizeSensitiveProtocolValue(
  value: unknown,
  environmentVariables: EnvironmentVariableMap,
  operationalValues: readonly string[] = [],
  assignedNames: readonly string[] = []
): unknown {
  return sanitizeLogValue(value, {
    assignedNames,
    operationalValues,
    preserveObjectKeys: true,
    secretValues: [
      ...collectConfiguredSecretValues(),
      ...collectEnvironmentMapValues(environmentVariables),
    ],
  });
}
