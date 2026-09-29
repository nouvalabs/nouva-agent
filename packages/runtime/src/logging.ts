export const REDACTED_LOG_VALUE = "[REDACTED]";
export const HIDDEN_ENVIRONMENT_COMMIT_MESSAGE = "[commit message hidden]";

const SENSITIVE_LOG_KEY_NAMES = new Set([
  "authorization",
  "body",
  "cookie",
  "credential",
  "formdata",
  "idempotencykey",
  "password",
  "payload",
  "proxyauthorization",
  "rawbody",
  "requestbody",
  "responsebody",
  "secret",
  "setcookie",
  "token",
]);

const SENSITIVE_ENVIRONMENT_NAMES = new Set([
  "connectionstring",
  "databaseurl",
  "environmentmapencryptionkeys",
  "redisurl",
]);

const SENSITIVE_TEXT_PATTERN =
  /\b([A-Za-z0-9_-]*(?:authorization|cookie|idempotency[-_ ]?key|token|secret|password|credential|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|signature|body|payload|formdata)[A-Za-z0-9_-]*)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\[[^\s,}\]]+\]|[^\s,}\]]+)/gi;
const SENSITIVE_HEADER_PATTERN =
  /\b(authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|idempotency[-_ ]?key)\b["']?\s*[:=]\s*[^\r\n]*/gi;
const SENSITIVE_QUERY_VALUE_PATTERN =
  /([?&][A-Za-z0-9_-]*(?:authorization|cookie|idempotency[-_ ]?key|token|secret|password|credential|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|signature)[A-Za-z0-9_-]*=)([^&#\s]+)/gi;
const URI_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi;
const BEARER_OR_BASIC_PATTERN = /\b(Bearer|Basic)\s+[^\s,;]+/gi;
const NOUVA_TOKEN_PATTERN = /\bnouva_v1_[A-Za-z0-9_-]+\b/g;
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g;

export type SafeLogLevel = "debug" | "info" | "warn" | "error";

export interface SafeLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface LogRedactionOptions {
  environmentVariables?: Readonly<Record<string, string | undefined>>;
  exactStructuredValues?: readonly string[];
  /**
   * Exact strings the caller's own payload declares in plaintext operational fields, such as a
   * database provision payload's `dataPath` and `mountPath`. They are never treated as leaked
   * material even when an environment value (for example `PGDATA`) is identical, because the
   * payload already carries them unencrypted. Environment names stay protected.
   */
  operationalValues?: readonly string[];
  /**
   * Which of the redacted values the platform generated rather than the customer typing them.
   * These stay redacted; the provenance only relaxes a *word* among them to whole-lexeme matching,
   * so a fixed literal such as `require` stops eating the word inside `requirements.txt` (#219).
   * A value not listed here is treated as the customer's and matched strictly.
   */
  platformGeneratedValues?: readonly string[];
  secretValues?: readonly string[];
}

export interface SafeLoggerOptions extends LogRedactionOptions {
  bindings?: Record<string, unknown>;
  write?: (line: string, level: SafeLogLevel) => void;
}

export interface SafeRequestLogInput {
  hostname?: string;
  method?: string;
  remoteAddress?: string;
  remotePort?: number;
  url?: string;
}

export interface SafeRequestLogSerializerOptions extends LogRedactionOptions {
  sanitizeUrl?: (value: string | undefined) => string;
}

export interface SafeSerializedError {
  [key: string]: unknown;
  message: string;
  stack: string;
  type: string;
}

function normalizeLogKey(value: string): string {
  return value.toLowerCase().replaceAll(/[-_.\s]/g, "");
}

/**
 * Name suffixes that describe an attribute of a secret rather than the secret itself:
 * `BETTER_AUTH_COOKIE_DOMAIN`, `TUNNEL_INTERNAL_TOKEN_FILE`, `LEGACY_COOKIE_RETIREMENT_ENABLED`,
 * `TUNNEL_LEGACY_JS_COOKIE_NAMES`. Their values are public configuration (a cookie domain, a file
 * location, a flag, a version), so treating them as leaked material only produces false
 * conflicts: a cookie domain of `nouva.sh` would otherwise redact every image reference under
 * `registry.nouva.sh` and reject the agent result that carries it.
 */
const SECRET_ATTRIBUTE_ENVIRONMENT_NAME_SUFFIXES = [
  "dir",
  "disabled",
  "domain",
  "enabled",
  "file",
  "name",
  "names",
  "path",
  "version",
] as const;

/** `NEXT_PUBLIC_*` values ship to browsers by convention and are never secrets. */
const PUBLIC_ENVIRONMENT_NAME_PREFIX = "nextpublic";

/** Flag literals cannot be secrets; redacting them would only strip words such as `true`. */
const FLAG_ENVIRONMENT_VALUES = new Set(["0", "1", "false", "no", "off", "on", "true", "yes"]);

function isSecretAttributeEnvironmentName(normalized: string): boolean {
  return (
    normalized.startsWith(PUBLIC_ENVIRONMENT_NAME_PREFIX) ||
    SECRET_ATTRIBUTE_ENVIRONMENT_NAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

function isSensitiveEnvironmentName(value: string): boolean {
  const normalized = normalizeLogKey(value);
  if (isSecretAttributeEnvironmentName(normalized)) {
    return false;
  }
  return (
    isSensitiveLogKey(value) ||
    SENSITIVE_ENVIRONMENT_NAMES.has(normalized) ||
    normalized.endsWith("dsn") ||
    normalized.endsWith("key") ||
    normalized.includes("privatekey")
  );
}

function isFlagEnvironmentValue(value: string): boolean {
  return FLAG_ENVIRONMENT_VALUES.has(value.trim().toLowerCase());
}

/**
 * Two characters carry too little to be a credential and match almost every line, so a token that
 * short has always been confined to whole-lexeme matching. Unchanged by #219.
 */
const MIN_SUBSTRING_TOKEN_LENGTH = 3;

/**
 * Past this many letters a single-case, letter-only value stops reading as prose: twelve lowercase
 * letters already carry ~56 bits, so a longer run is generated material rather than a word even
 * when the platform emitted it, and keeps the strict matching.
 */
const MAX_WORD_TOKEN_LENGTH = 12;

/** One run of letters with no internal case change: `require`, `Require`, `ADMIN`. */
const WORD_TOKEN_PATTERN = /^(?:[A-Za-z][a-z]*|[A-Z]+)$/;

/**
 * Who put a redaction token into the map.
 *
 * `platform` is for values the control plane generated into a deployment's environment itself. It
 * is never inferred from what a value looks like — see `collectDeploymentLogRedactionValues` for
 * the only place that establishes it.
 */
export type RedactionTokenProvenance = "customer" | "platform";

/** How far a redaction token may reach into the text it is redacted from. */
export type RedactionTokenMatch = "boundary" | "substring";

/**
 * Classifies how a redaction token is allowed to match.
 *
 * `substring` is the strict mode and the default: the token is masked wherever it occurs, including
 * inside a longer run of characters, because a leaked credential can be embedded in one. `boundary`
 * masks the token only where it stands as its own lexeme.
 *
 * A token is relaxed to `boundary` only when the platform generated it *and* it is a single word.
 * Both halves are load-bearing. The platform emits fixed word literals for every service of a kind
 * — `require` (`PGSSLMODE`), `admin` (MongoDB's auth source), `postgres` (the fallback database
 * name) — none of which is secret, and matching one inside a word is what turned
 * `requirements.txt` into `[REDACTED]ments.txt` in a build log (#219). Shape alone cannot carry
 * that decision: a weak customer password such as `changeme` or `hunterhunter` is word-shaped too,
 * and it must keep being masked wherever it appears, including glued to other characters. So a
 * customer's value is always `substring`, however ordinary it looks.
 *
 * A generated value that is not a word stays `substring` as well, which is what keeps the generated
 * credentials in the same catalog (`PGPASSWORD` and the connection URLs, 32 base64url characters)
 * fully protected.
 */
export function classifyRedactionToken(
  token: string,
  provenance: RedactionTokenProvenance = "customer"
): RedactionTokenMatch {
  if (token.length < MIN_SUBSTRING_TOKEN_LENGTH) {
    return "boundary";
  }
  if (provenance !== "platform") {
    return "substring";
  }
  return token.length <= MAX_WORD_TOKEN_LENGTH && WORD_TOKEN_PATTERN.test(token)
    ? "boundary"
    : "substring";
}

function partitionRedactionTokens(
  tokens: readonly string[],
  platformGeneratedValues: ReadonlySet<string>
): { boundary: string[]; substring: string[] } {
  const boundary: string[] = [];
  const substring: string[] = [];
  for (const token of tokens) {
    const provenance = platformGeneratedValues.has(token) ? "platform" : "customer";
    if (classifyRedactionToken(token, provenance) === "boundary") {
      boundary.push(token);
    } else {
      substring.push(token);
    }
  }
  return { boundary, substring };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value) ? value : {};
}

function safeObjectEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  try {
    return Object.entries(value);
  } catch {
    return [];
  }
}

function uniqueSortedSecretValues(secretValues: readonly string[]): string[] {
  return [...new Set(secretValues.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length
  );
}

function normalizedConfiguredSecretValues(secretValues: readonly string[]): string[] {
  return uniqueSortedSecretValues(
    secretValues.filter(
      (value) => value.length > 0 && value !== REDACTED_LOG_VALUE && value !== "undefined"
    )
  );
}

export function collectEnvironmentMapSecretValues(
  environmentVariables: Readonly<Record<string, string | undefined>>
): string[] {
  const secretValues: string[] = [];

  for (const [key, value] of Object.entries(environmentVariables)) {
    if (key.length > 0) {
      secretValues.push(key);
    }
    if (typeof value === "string" && value.length > 0) {
      secretValues.push(value);
    }
  }

  return uniqueSortedSecretValues(secretValues);
}

/**
 * The material of an environment map that can actually be a secret: its values, minus the flag
 * literals, and without the variable names.
 *
 * `collectEnvironmentMapSecretValues` deliberately treats a variable name as protected material so
 * that an agent echoing back `{"DATABASE_URL": "…"}` is redacted key and all. Surfaces that compare
 * a redacted copy against the original to detect a leak cannot use that set: a name is already
 * visible in the dashboard, the deployment payload and the environment editor, so a name matching a
 * platform-generated string is not a leak — it just made the comparison differ, which permanently
 * failed the deployment (#187). A flag literal is dropped for the same reason it is dropped from
 * the platform's own configured secrets: `DEBUG=true` cannot be a secret, but it can collide with
 * a boolean an operational field reports.
 */
export function collectEnvironmentMapValues(
  environmentVariables: Readonly<Record<string, string | undefined>>
): string[] {
  return uniqueSortedSecretValues(
    Object.values(environmentVariables).filter(
      (value): value is string => typeof value === "string" && !isFlagEnvironmentValue(value)
    )
  );
}

/** The pair of maps a deployment stores: what it runs with, and what it was built with. */
export interface DeploymentLogEnvironmentMaps {
  build: Readonly<Record<string, string | undefined>>;
  runtime: Readonly<Record<string, string | undefined>>;
}

/** Spreads straight into `LogRedactionOptions`. */
export interface DeploymentLogRedactionValues {
  platformGeneratedValues: string[];
  secretValues: string[];
}

/**
 * Reads a deployment's environment maps as a redaction context for its logs: what to mask, and
 * which of those values the platform generated rather than the customer typing them.
 *
 * The provenance is not a guess. `runtime` is the customer's own map with its `${{…}}` references
 * resolved; `build` is that same map laid over the complete generated catalog of every resource it
 * references, because `resolveProjectBuildEnvironmentVariables` spreads the catalog underneath it.
 * So a service referencing only `${{db.DATABASE_URL}}` still stores `PGSSLMODE=require` and
 * `PGDATABASE=postgres` in its build map, and a variable that appears only there is one the
 * platform put in. That is the single place a fixed literal such as `require` entered a build log's
 * redaction context and mangled `requirements.txt` (#219).
 *
 * A value the customer also holds under some name of their own is theirs, not the platform's: the
 * customer wins the tie, exactly as they do for a chosen database name in the diagnostic audit
 * (#125). Names are not collected at all — see `collectEnvironmentMapValues`.
 */
export function collectDeploymentLogRedactionValues(
  environmentMaps: DeploymentLogEnvironmentMaps
): DeploymentLogRedactionValues {
  const customerValues = new Set(collectEnvironmentMapValues(environmentMaps.runtime));
  const platformGeneratedValues = new Set<string>();

  for (const [name, value] of Object.entries(environmentMaps.build)) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      isFlagEnvironmentValue(value) ||
      Object.hasOwn(environmentMaps.runtime, name) ||
      customerValues.has(value)
    ) {
      continue;
    }
    platformGeneratedValues.add(value);
  }

  return {
    platformGeneratedValues: [...platformGeneratedValues],
    secretValues: [
      ...new Set([...customerValues, ...collectEnvironmentMapValues(environmentMaps.build)]),
    ].sort((left, right) => right.length - left.length || left.localeCompare(right)),
  };
}

export function sanitizeEnvironmentCommitMessage(
  commitMessage: string,
  environmentMaps: readonly Readonly<Record<string, string | undefined>>[]
): string;
export function sanitizeEnvironmentCommitMessage(
  commitMessage: null,
  environmentMaps: readonly Readonly<Record<string, string | undefined>>[]
): null;
export function sanitizeEnvironmentCommitMessage(
  commitMessage: string | null,
  environmentMaps: readonly Readonly<Record<string, string | undefined>>[]
): string | null;
export function sanitizeEnvironmentCommitMessage(
  commitMessage: string | null,
  environmentMaps: readonly Readonly<Record<string, string | undefined>>[]
): string | null {
  if (commitMessage === null) {
    return null;
  }
  const protectedMaterial = new Set(
    environmentMaps.flatMap((environmentMap) => collectEnvironmentMapSecretValues(environmentMap))
  );
  return [...protectedMaterial].some((token) => commitMessage.includes(token))
    ? HIDDEN_ENVIRONMENT_COMMIT_MESSAGE
    : commitMessage;
}

const AGENT_WORK_PAYLOAD_OPERATIONAL_PATH_KEYS = ["dataPath", "mountPath"] as const;

/**
 * Identity the control plane generates for a service and hands to the agent in plaintext. The agent
 * echoes every one of these back in its operational result, and a customer variable is allowed to
 * hold the same string — `PHX_HOST`, `ALLOWED_HOSTS` and `APP_HOST` are routinely set to the
 * service's own provided hostname — so they are exempt from redaction just like the paths above.
 */
const AGENT_WORK_PAYLOAD_OPERATIONAL_IDENTITY_KEYS = [
  "containerName",
  "externalHost",
  "imageUrl",
  "internalHost",
  "networkName",
  "providedHostname",
  "serviceName",
  "subdomain",
  "volumeName",
] as const;

const AGENT_WORK_PAYLOAD_OPERATIONAL_LIST_KEYS = ["customHostnames"] as const;

/**
 * Payload members whose every string leaf is platform-generated: the live runtime metadata the
 * control plane resolved at lease time, and the volume identity it allocated.
 */
const AGENT_WORK_PAYLOAD_OPERATIONAL_RECORD_KEYS = ["runtimeMetadata", "volume"] as const;

/**
 * A one- or two-character exemption would punch a hole through redaction far wider than the
 * identity it protects, and no hostname, container name or image reference is that short.
 */
const MIN_OPERATIONAL_IDENTITY_LENGTH = 3;
const MAX_OPERATIONAL_RECORD_DEPTH = 4;

function addOperationalIdentityValue(values: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length >= MIN_OPERATIONAL_IDENTITY_LENGTH) {
    values.add(trimmed);
  }
}

function collectOperationalRecordValues(value: unknown, values: Set<string>, depth: number): void {
  if (depth > MAX_OPERATIONAL_RECORD_DEPTH || value === null || typeof value !== "object") {
    addOperationalIdentityValue(values, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectOperationalRecordValues(entry, values, depth + 1);
    }
    return;
  }
  for (const entry of Object.values(asRecord(value))) {
    collectOperationalRecordValues(entry, values, depth + 1);
  }
}

/**
 * Reads the plaintext operational material an agent work payload declares: the paths (`dataPath`,
 * `mountPath`) and the service identity the control plane generated for this deployment. Agent
 * results echo these verbatim, so both the agent and the API pass them as `operationalValues` when
 * redacting a result against the leased environment.
 */
export function collectAgentWorkPayloadOperationalValues(payload: unknown): string[] {
  const record = asRecord(payload);
  const values = new Set<string>();
  for (const key of AGENT_WORK_PAYLOAD_OPERATIONAL_PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      values.add(value.trim());
    }
  }
  for (const key of AGENT_WORK_PAYLOAD_OPERATIONAL_IDENTITY_KEYS) {
    addOperationalIdentityValue(values, record[key]);
  }
  for (const key of AGENT_WORK_PAYLOAD_OPERATIONAL_LIST_KEYS) {
    const entries = record[key];
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        addOperationalIdentityValue(values, entry);
      }
    }
  }
  for (const key of AGENT_WORK_PAYLOAD_OPERATIONAL_RECORD_KEYS) {
    collectOperationalRecordValues(record[key], values, 1);
  }
  return [...values];
}

/**
 * The agent rollout result fields that only ever hold one of a few words the agent chooses, for
 * app and worker rollouts alike (`AppRolloutResult` and `WorkerRolloutResult` in the agent).
 */
const AGENT_ROLLOUT_RESULT_VOCABULARY: Readonly<Record<string, ReadonlySet<string>>> = {
  currentPhase: new Set([
    "release",
    "quiesce",
    "snapshot",
    "candidate",
    "ready",
    "cutover",
    "verify",
    "retire",
    "restore",
    "rollback",
  ]),
  outcome: new Set(["committed", "aborted_before_cutover", "rolled_back"]),
  previousContainerRetirement: new Set(["graceful", "forced", "deferred"]),
  strategy: new Set([
    "candidate_ready_cutover",
    "single_writer_snapshot_cutover",
    "stop_first_cutover",
  ]),
};

/**
 * The fields of an agent rollout result whose value is one of that field's own fixed words:
 * `strategy`, `outcome`, `currentPhase` and `previousContainerRetirement`. Both ends of the agent
 * protocol keep these as they are instead of redacting them, for #187's reason: the platform's own
 * material is not a leak. A customer variable that happens to equal `committed` or `graceful` is
 * not coming back through the rollout's outcome, and treating it as if it were rejected the result
 * of a rollout that had already replaced the live containers (#345).
 *
 * The exemption is scoped to the field rather than added to `operationalValues`, which are exempt
 * across the whole result: a customer value equal to `ready` must stay redacted in a status message
 * or a container name. A value outside its field's vocabulary is not returned, so it is still
 * redacted and still fails the leak check.
 */
export function collectAgentRolloutVocabularyFields(
  rollout: Readonly<Record<string, unknown>>
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, vocabulary] of Object.entries(AGENT_ROLLOUT_RESULT_VOCABULARY)) {
    const value = Object.hasOwn(rollout, key) ? rollout[key] : undefined;
    if (typeof value === "string" && vocabulary.has(value)) {
      fields[key] = value;
    }
  }
  return fields;
}

function resolveOperationalValueExclusions(options: LogRedactionOptions): Set<string> {
  const exclusions = new Set<string>();
  for (const value of options.operationalValues ?? []) {
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    exclusions.add(value);
    exclusions.add(encodeURIComponent(value));
  }
  return exclusions;
}

function excludeOperationalValues(
  secretValues: readonly string[],
  options: LogRedactionOptions
): string[] {
  const exclusions = resolveOperationalValueExclusions(options);
  return exclusions.size === 0
    ? [...secretValues]
    : secretValues.filter((value) => !exclusions.has(value));
}

function resolveSecretValues(options: LogRedactionOptions): string[] {
  const configuredOrExplicitValues =
    options.secretValues === undefined
      ? collectConfiguredSecretValues()
      : uniqueSortedSecretValues(options.secretValues);
  const environmentValues = options.environmentVariables
    ? collectEnvironmentMapSecretValues(options.environmentVariables)
    : [];

  return uniqueSortedSecretValues(
    excludeOperationalValues([...configuredOrExplicitValues, ...environmentValues], options)
  );
}

function resolveExactStructuredValues(options: LogRedactionOptions): string[] {
  const environmentValues = options.environmentVariables
    ? collectEnvironmentMapSecretValues(options.environmentVariables)
    : [];
  return uniqueSortedSecretValues(
    excludeOperationalValues(
      [
        ...(options.exactStructuredValues ?? []),
        ...resolveSecretValues(options),
        ...environmentValues,
      ],
      options
    )
  );
}

type LiteralSecretMatcherNode = {
  failure: number;
  maxOutputLength: number;
  transitions: Map<string, number>;
};

type LiteralSecretMatcher = readonly LiteralSecretMatcherNode[];

type CompiledLogRedaction = {
  boundaryTextValues: readonly string[];
  exactStructuredValues: ReadonlySet<string>;
  substringMatcher: LiteralSecretMatcher;
};

export interface CompiledLogValueRedactor {
  hasExactStructuredValue(value: string): boolean;
  redactText(value: string): string;
  sanitize(value: unknown): unknown;
}

function createLiteralSecretMatcher(secretValues: readonly string[]): LiteralSecretMatcher {
  const nodes: LiteralSecretMatcherNode[] = [
    { failure: 0, maxOutputLength: 0, transitions: new Map() },
  ];
  for (const secretValue of secretValues) {
    let state = 0;
    for (let index = secretValue.length - 1; index >= 0; index -= 1) {
      const character = secretValue[index] ?? "";
      let nextState = nodes[state]?.transitions.get(character);
      if (nextState === undefined) {
        nextState = nodes.length;
        nodes[state]?.transitions.set(character, nextState);
        nodes.push({ failure: 0, maxOutputLength: 0, transitions: new Map() });
      }
      state = nextState;
    }
    const terminal = nodes[state];
    if (terminal) {
      terminal.maxOutputLength = Math.max(terminal.maxOutputLength, secretValue.length);
    }
  }

  const queue: number[] = [];
  for (const child of nodes[0]?.transitions.values() ?? []) {
    queue.push(child);
  }
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const state = queue[queueIndex];
    const node = state === undefined ? undefined : nodes[state];
    if (!node) {
      continue;
    }
    node.maxOutputLength = Math.max(
      node.maxOutputLength,
      nodes[node.failure]?.maxOutputLength ?? 0
    );
    for (const [character, child] of node.transitions) {
      let failure = node.failure;
      while (failure !== 0 && !nodes[failure]?.transitions.has(character)) {
        failure = nodes[failure]?.failure ?? 0;
      }
      const failureTransition = nodes[failure]?.transitions.get(character);
      nodes[child]!.failure = failureTransition ?? 0;
      queue.push(child);
    }
  }
  return nodes;
}

function resolvePlatformGeneratedValues(options: LogRedactionOptions): ReadonlySet<string> {
  return new Set(options.platformGeneratedValues ?? []);
}

function compileLogRedaction(options: LogRedactionOptions): CompiledLogRedaction {
  const { boundary, substring } = partitionRedactionTokens(
    resolveSecretValues(options),
    resolvePlatformGeneratedValues(options)
  );
  return {
    boundaryTextValues: boundary,
    exactStructuredValues: new Set(resolveExactStructuredValues(options)),
    substringMatcher: createLiteralSecretMatcher(substring),
  };
}

function isLexicalCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

function isLexicalBoundaryMatch(value: string, start: number, length: number): boolean {
  return !isLexicalCharacter(value[start - 1]) && !isLexicalCharacter(value[start + length]);
}

function addBoundaryMatches(
  value: string,
  boundaryTextValues: readonly string[],
  longestMatchAt: Uint32Array
): boolean {
  let hasMatch = false;
  for (const secretValue of boundaryTextValues) {
    let offset = value.indexOf(secretValue);
    while (offset !== -1) {
      if (
        isLexicalBoundaryMatch(value, offset, secretValue.length) &&
        secretValue.length > (longestMatchAt[offset] ?? 0)
      ) {
        longestMatchAt[offset] = secretValue.length;
        hasMatch = true;
      }
      offset = value.indexOf(secretValue, offset + 1);
    }
  }
  return hasMatch;
}

function redactLiteralSecretsWithMatcher(
  value: string,
  matcher: LiteralSecretMatcher,
  boundaryTextValues: readonly string[] = []
): string {
  if ((matcher.length <= 1 && boundaryTextValues.length === 0) || value.length === 0) {
    return value;
  }

  const longestMatchAt = new Uint32Array(value.length);
  let hasMatch = false;
  let state = 0;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const character = value[index] ?? "";
    while (state !== 0 && !matcher[state]?.transitions.has(character)) {
      state = matcher[state]?.failure ?? 0;
    }
    state = matcher[state]?.transitions.get(character) ?? 0;
    const matchLength = matcher[state]?.maxOutputLength ?? 0;
    if (matchLength > 0) {
      longestMatchAt[index] = matchLength;
      hasMatch = true;
    }
  }
  hasMatch = addBoundaryMatches(value, boundaryTextValues, longestMatchAt) || hasMatch;
  if (!hasMatch) {
    return value;
  }

  const redacted: string[] = [];
  let segmentStart = 0;
  let index = 0;
  while (index < value.length) {
    const matchLength = longestMatchAt[index] ?? 0;
    if (matchLength === 0) {
      index += 1;
      continue;
    }
    redacted.push(value.slice(segmentStart, index), REDACTED_LOG_VALUE);
    index += matchLength;
    segmentStart = index;
  }
  redacted.push(value.slice(segmentStart));
  return redacted.join("");
}

function redactTextWithSecretMatcher(
  value: string,
  matcher: LiteralSecretMatcher,
  boundaryTextValues: readonly string[] = []
): string {
  const redacted = redactLiteralSecretsWithMatcher(value, matcher, boundaryTextValues);

  return redacted
    .replace(SENSITIVE_HEADER_PATTERN, `$1=${REDACTED_LOG_VALUE}`)
    .replace(URI_USERINFO_PATTERN, `$1${REDACTED_LOG_VALUE}@`)
    .replace(SENSITIVE_QUERY_VALUE_PATTERN, `$1${REDACTED_LOG_VALUE}`)
    .replace(SENSITIVE_TEXT_PATTERN, `$1=${REDACTED_LOG_VALUE}`)
    .replace(BEARER_OR_BASIC_PATTERN, `$1 ${REDACTED_LOG_VALUE}`)
    .replace(NOUVA_TOKEN_PATTERN, REDACTED_LOG_VALUE)
    .replace(GITHUB_TOKEN_PATTERN, REDACTED_LOG_VALUE);
}

function redactTextWithSecrets(
  value: string,
  secretValues: readonly string[],
  platformGeneratedValues: ReadonlySet<string>
): string {
  const { boundary, substring } = partitionRedactionTokens(
    uniqueSortedSecretValues(secretValues),
    platformGeneratedValues
  );
  return redactTextWithSecretMatcher(value, createLiteralSecretMatcher(substring), boundary);
}

function sanitizeStructuredText(value: string, redaction: CompiledLogRedaction): string {
  if (redaction.exactStructuredValues.has(value)) {
    return REDACTED_LOG_VALUE;
  }
  return redactTextWithSecretMatcher(
    value,
    redaction.substringMatcher,
    redaction.boundaryTextValues
  );
}

function sanitizeValue(
  value: unknown,
  redaction: CompiledLogRedaction,
  seen: WeakSet<object>
): unknown {
  if (typeof value === "string") {
    if (redaction.exactStructuredValues.has(value)) {
      return REDACTED_LOG_VALUE;
    }
    return redactTextWithSecretMatcher(
      value,
      redaction.substringMatcher,
      redaction.boundaryTextValues
    );
  }

  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "undefined"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "symbol") {
    return "[Symbol]";
  }

  if (typeof value === "function") {
    return "[Function]";
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  try {
    return sanitizeObjectValue(value, redaction, seen);
  } finally {
    seen.delete(value);
  }
}

function sanitizeObjectValue(
  value: object,
  redaction: CompiledLogRedaction,
  seen: WeakSet<object>
): unknown {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "[Invalid Date]" : value.toISOString();
  }

  if (value instanceof URL) {
    return redactTextWithSecretMatcher(
      value.toString(),
      redaction.substringMatcher,
      redaction.boundaryTextValues
    );
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return `[Buffer ${value.byteLength} bytes]`;
  }

  if (value instanceof Uint8Array) {
    return `[Binary ${value.byteLength} bytes]`;
  }

  if (value instanceof URLSearchParams) {
    const result: Record<string, string[]> = {};
    for (const [key, entry] of value.entries()) {
      const safeKey = sanitizeStructuredText(key, redaction);
      const values = result[safeKey] ?? [];
      values.push(
        isSensitiveLogKey(key)
          ? REDACTED_LOG_VALUE
          : (sanitizeValue(entry, redaction, seen) as string)
      );
      result[safeKey] = values;
    }
    return result;
  }

  if (typeof Headers !== "undefined" && value instanceof Headers) {
    const result: Record<string, string> = {};
    for (const [key, entry] of value.entries()) {
      const safeKey = sanitizeStructuredText(key, redaction);
      result[safeKey] = isSensitiveLogKey(key)
        ? REDACTED_LOG_VALUE
        : (sanitizeValue(entry, redaction, seen) as string);
    }
    return result;
  }

  if (typeof FormData !== "undefined" && value instanceof FormData) {
    const result: Record<string, string[]> = {};
    for (const [key, entry] of value.entries()) {
      const safeKey = sanitizeStructuredText(key, redaction);
      const values = result[safeKey] ?? [];
      values.push(
        isSensitiveLogKey(key)
          ? REDACTED_LOG_VALUE
          : typeof entry === "string"
            ? (sanitizeValue(entry, redaction, seen) as string)
            : "[File]"
      );
      result[safeKey] = values;
    }
    return result;
  }

  if (value instanceof Error) {
    const result: Record<string, unknown> = {
      message: sanitizeValue(value.message, redaction, seen),
      type: sanitizeValue(value.name || "Error", redaction, seen),
    };
    if (value.stack) {
      result.stack = sanitizeValue(value.stack, redaction, seen);
    }
    return result;
  }

  if (value instanceof Map) {
    return [...value.entries()].map(([key, entry]) => [
      sanitizeValue(key, redaction, seen),
      sanitizeValue(entry, redaction, seen),
    ]);
  }

  if (value instanceof Set) {
    return [...value].map((entry) => sanitizeValue(entry, redaction, seen));
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, redaction, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of safeObjectEntries(value as Record<string, unknown>)) {
    const safeKey = sanitizeStructuredText(key, redaction);
    result[safeKey] = isSensitiveLogKey(key)
      ? REDACTED_LOG_VALUE
      : sanitizeValue(entry, redaction, seen);
  }
  return result;
}

function writeToConsole(line: string, level: SafeLogLevel): void {
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  if (level === "debug") {
    console.debug(line);
    return;
  }
  console.log(line);
}

export function isSensitiveLogKey(value: string): boolean {
  const normalized = normalizeLogKey(value);
  return (
    SENSITIVE_LOG_KEY_NAMES.has(normalized) ||
    normalized.includes("authorization") ||
    normalized.includes("cookie") ||
    normalized.includes("credential") ||
    normalized.includes("idempotencykey") ||
    normalized.includes("password") ||
    normalized.includes("privatekey") ||
    normalized.includes("secret") ||
    normalized.includes("signature") ||
    normalized.includes("token") ||
    normalized.includes("apikey") ||
    normalized.includes("accesskey")
  );
}

export function collectConfiguredSecretValues(
  environment: Record<string, string | undefined> = process.env
): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    if (
      typeof value !== "string" ||
      !isSensitiveEnvironmentName(key) ||
      isFlagEnvironmentValue(value)
    ) {
      continue;
    }
    values.push(value);
    if (normalizeLogKey(key) !== "environmentmapencryptionkeys") {
      continue;
    }
    try {
      const keyring = JSON.parse(value) as unknown;
      if (isRecord(keyring) && !Array.isArray(keyring)) {
        for (const keyValue of Object.values(keyring)) {
          if (typeof keyValue === "string") {
            values.push(keyValue);
          }
        }
      }
    } catch {
      // The complete malformed value is still treated as sensitive above.
    }
  }
  return normalizedConfiguredSecretValues(values);
}

export function redactLogText(value: string, options: LogRedactionOptions = {}): string {
  return redactTextWithSecrets(
    value,
    resolveSecretValues(options),
    resolvePlatformGeneratedValues(options)
  );
}

export function createLogTextRedactor(
  options: LogRedactionOptions = {}
): (value: string) => string {
  const redaction = compileLogRedaction(options);
  return (value) =>
    redactTextWithSecretMatcher(value, redaction.substringMatcher, redaction.boundaryTextValues);
}

export function createLogValueRedactor(
  options: LogRedactionOptions = {}
): CompiledLogValueRedactor {
  const redaction = compileLogRedaction(options);
  return {
    hasExactStructuredValue: (value) => redaction.exactStructuredValues.has(value),
    redactText: (value) =>
      redactTextWithSecretMatcher(value, redaction.substringMatcher, redaction.boundaryTextValues),
    sanitize: (value) => sanitizeValue(value, redaction, new WeakSet<object>()),
  };
}

export function formatJsonLogLevel(label: string): { level: string } {
  return { level: label };
}

export function sanitizeLogValue(value: unknown, options: LogRedactionOptions = {}): unknown {
  return createLogValueRedactor(options).sanitize(value);
}

export function sanitizeLogUrl(value: string | undefined): string {
  if (!value) {
    return "/";
  }
  return value.split(/[?#]/, 1)[0] || "/";
}

export function serializeSafeRequestForLog(
  request: SafeRequestLogInput,
  options: SafeRequestLogSerializerOptions = {}
): Record<string, unknown> {
  const redaction = compileLogRedaction(options);
  const sanitizeUrl = options.sanitizeUrl ?? sanitizeLogUrl;
  const redactText = (value: string): string =>
    redactTextWithSecretMatcher(value, redaction.substringMatcher, redaction.boundaryTextValues);
  return {
    hostname: request.hostname === undefined ? undefined : redactText(request.hostname),
    method: request.method === undefined ? undefined : redactText(request.method),
    remoteAddress:
      request.remoteAddress === undefined ? undefined : redactText(request.remoteAddress),
    remotePort: request.remotePort,
    url: redactText(sanitizeUrl(request.url)),
  };
}

export function serializeSafeError(
  error: unknown,
  options: LogRedactionOptions = {}
): SafeSerializedError {
  const sanitized = sanitizeLogValue(error, options);
  if (isRecord(sanitized) && !Array.isArray(sanitized)) {
    return {
      message: typeof sanitized.message === "string" ? sanitized.message : "Unknown error",
      stack: typeof sanitized.stack === "string" ? sanitized.stack : "",
      type: typeof sanitized.type === "string" ? sanitized.type : "Error",
    };
  }

  return {
    message: typeof sanitized === "string" ? sanitized : "Unknown error",
    stack: "",
    type: "Error",
  };
}

export function createSafeLogger(options: SafeLoggerOptions = {}): SafeLogger {
  const write = options.write ?? writeToConsole;
  const redaction = compileLogRedaction(options);
  const emit = (
    level: SafeLogLevel,
    message: string,
    fields: Record<string, unknown> = {}
  ): void => {
    const bindings = asRecord(
      sanitizeValue(options.bindings ?? {}, redaction, new WeakSet<object>())
    );
    const safeFields = asRecord(sanitizeValue(fields, redaction, new WeakSet<object>()));
    const safeMessage = redactTextWithSecretMatcher(
      message,
      redaction.substringMatcher,
      redaction.boundaryTextValues
    );
    const record = {
      ...bindings,
      ...safeFields,
      level,
      message: safeMessage,
    };

    try {
      write(JSON.stringify(record), level);
    } catch {
      try {
        write(JSON.stringify({ level, message: "Unable to serialize log entry" }), level);
      } catch {
        // Logging must not make a control-plane process unavailable.
      }
    }
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    error: (message, fields) => emit("error", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
  };
}
