/**
 * Verification contract for importing a customer-supplied database backup.
 *
 * An import ingests bytes the control plane did not produce into a database the customer runs.
 * Everything in this module answers one question: what can be *proved* about those bytes before
 * a running database is allowed to depend on them? The rules are deliberately narrow, and every
 * unprovable case is a rejection rather than a warning — see `verifyExternalBackupArtifact`.
 *
 * The module is pure so both sides can run it: the agent verifies the artifact it downloaded on
 * the customer server, and the control plane re-checks the agent's report against the descriptor
 * the customer registered. Neither side trusts filename, declared size, or content type.
 */
import type {
  DatabaseProvisionCredentials,
  PlatformBackupDestination,
  PlatformBackupDestinationMetadata,
} from "./database-backup-contract.js";

/**
 * Containers an import may declare.
 *
 * Both are self-describing binary formats whose header states the engine that wrote them, which is
 * what makes "is this really a backup of a compatible engine?" answerable at all. Plain `pg_dump`
 * SQL is deliberately absent: it has no header to check, and restoring it is indistinguishable
 * from letting the uploader run an arbitrary program as the destination database owner.
 *
 * These names are also persisted as the `external_backup_import_format` enum. The tuple is spelled
 * out here rather than imported from `@repo/db` so the agent can run this verifier without pulling
 * the ORM onto the customer's server; `external-backup-import.test.ts` fails if the two drift.
 */
export const EXTERNAL_BACKUP_IMPORT_FORMATS = ["postgres-custom-dump-v1", "redis-rdb-v1"] as const;
export type ExternalBackupImportFormat = (typeof EXTERNAL_BACKUP_IMPORT_FORMATS)[number];

/** Why an import was refused. Mirrors the `external_backup_import_failure_category` enum. */
export const EXTERNAL_BACKUP_IMPORT_FAILURE_CATEGORIES = [
  "artifact_missing",
  "integrity_mismatch",
  "format_unreadable",
  "format_mismatch",
  "engine_version_incompatible",
  "restore_failed",
  "validation_failed",
] as const;
export type ExternalBackupImportFailureCategory =
  (typeof EXTERNAL_BACKUP_IMPORT_FAILURE_CATEGORIES)[number];

export type ExternalBackupImportVariant = "postgres" | "redis";

export const EXTERNAL_BACKUP_IMPORT_VARIANT_BY_FORMAT = {
  "postgres-custom-dump-v1": "postgres",
  "redis-rdb-v1": "redis",
} as const satisfies Record<ExternalBackupImportFormat, ExternalBackupImportVariant>;

export function isExternalBackupImportFormat(value: unknown): value is ExternalBackupImportFormat {
  return (EXTERNAL_BACKUP_IMPORT_FORMATS as readonly unknown[]).includes(value);
}

export function isExternalBackupImportFailureCategory(
  value: unknown
): value is ExternalBackupImportFailureCategory {
  return (EXTERNAL_BACKUP_IMPORT_FAILURE_CATEGORIES as readonly unknown[]).includes(value);
}

/**
 * Bytes of the artifact prefix the agent must sample for header verification.
 *
 * A `pg_dump` custom-format header runs to roughly 200 bytes even with a maximum-length database
 * name; 8 KiB leaves generous headroom while staying small enough to travel in a log line.
 */
export const EXTERNAL_BACKUP_IMPORT_HEADER_SAMPLE_BYTES = 8 * 1024;

export interface PostgresCustomDumpHeader {
  format: "postgres-custom-dump-v1";
  /** `pg_dump` archive format version, e.g. `"1.15"`. Not the server version. */
  archiveVersion: string;
  /** Version the source *server* reported to `pg_dump`, e.g. `"16.4"`. */
  sourceEngineVersion: string;
  /** Version of the `pg_dump` binary that wrote the archive, when the archive records one. */
  dumpVersion: string | null;
  /** Name of the database the archive was taken from. Informational only. */
  sourceDatabase: string | null;
}

export interface RedisRdbHeader {
  format: "redis-rdb-v1";
  /** RDB file format version from the `REDISnnnn` magic, e.g. `11`. */
  rdbVersion: number;
}

export type ExternalBackupArtifactHeader = PostgresCustomDumpHeader | RedisRdbHeader;

export type ExternalBackupHeaderParse =
  | { outcome: "parsed"; header: ExternalBackupArtifactHeader }
  | {
      outcome: "rejected";
      category: Extract<
        ExternalBackupImportFailureCategory,
        "format_unreadable" | "format_mismatch" | "engine_version_incompatible"
      >;
      message: string;
    };

export type ExternalBackupImportVerification =
  | {
      outcome: "verified";
      header: ExternalBackupArtifactHeader;
      /** The release the artifact came from, as its receipt reports it: `16.15`, `rdb-11`. */
      sourceEngineVersion: string;
    }
  | {
      outcome: "rejected";
      category: ExternalBackupImportFailureCategory;
      message: string;
    };

function reject<Category extends ExternalBackupImportFailureCategory>(
  category: Category,
  message: string
): { outcome: "rejected"; category: Category; message: string } {
  return { outcome: "rejected", category, message };
}

/* -------------------------------------------------------------------------- */
/* pg_dump custom-format archive header                                       */
/* -------------------------------------------------------------------------- */

const PGDMP_MAGIC = "PGDMP";
/** `ARCHIVE_FORMAT_CUSTOM` in `pg_backup_archiver.h`. Directory (3) and tar (4) are not files. */
const PGDMP_FORMAT_CUSTOM = 1;

function makeArchiveVersion(major: number, minor: number, revision: number): number {
  return (major * 256 + minor) * 256 + revision;
}

const K_VERS_1_0 = makeArchiveVersion(1, 0, 0);
const K_VERS_1_2 = makeArchiveVersion(1, 2, 0);
const K_VERS_1_4 = makeArchiveVersion(1, 4, 0);
const K_VERS_1_7 = makeArchiveVersion(1, 7, 0);
/** First archive version that records the source server version. Written by PostgreSQL 9.2+. */
const K_VERS_1_10 = makeArchiveVersion(1, 10, 0);
/** From here the compression field is a one-byte algorithm id instead of an integer level. */
const K_VERS_1_15 = makeArchiveVersion(1, 15, 0);
/**
 * Highest archive version this platform has been taught to read; `pg_dump` 18 writes 1.16.
 *
 * A newer archive is rejected rather than parsed optimistically. Header fields are positional, so
 * reading an unknown layout would misalign the cursor and could yield a *plausible* but wrong
 * source version — the one field the admission decision depends on.
 */
const K_VERS_MAX = makeArchiveVersion(1, 16, 0);

interface ByteCursor {
  bytes: Uint8Array;
  offset: number;
}

class HeaderTruncatedError extends Error {}

function readByte(cursor: ByteCursor): number {
  const value = cursor.bytes[cursor.offset];
  if (value === undefined) {
    throw new HeaderTruncatedError("Artifact header ended before the archive header was complete");
  }
  cursor.offset += 1;
  return value;
}

/**
 * Mirrors `ReadInt()` in `pg_backup_archiver.c`: an optional sign byte followed by `intSize`
 * little-endian magnitude bytes.
 */
function readArchiveInt(cursor: ByteCursor, intSize: number, archiveVersion: number): number {
  const signed = archiveVersion > K_VERS_1_0 && readByte(cursor) !== 0;
  let value = 0;
  for (let index = 0; index < intSize; index += 1) {
    value += readByte(cursor) * 2 ** (8 * index);
  }
  return signed ? -value : value;
}

/** Mirrors `ReadStr()`: a length-prefixed, non-terminated byte string; a negative length is null. */
function readArchiveString(
  cursor: ByteCursor,
  intSize: number,
  archiveVersion: number
): string | null {
  const length = readArchiveInt(cursor, intSize, archiveVersion);
  if (length < 0) {
    return null;
  }
  if (length > EXTERNAL_BACKUP_IMPORT_HEADER_SAMPLE_BYTES) {
    throw new HeaderTruncatedError("Archive header declares an implausibly long string");
  }
  const end = cursor.offset + length;
  if (end > cursor.bytes.length) {
    throw new HeaderTruncatedError("Artifact header ended inside an archive header string");
  }
  const value = new TextDecoder("utf-8", { fatal: false }).decode(
    cursor.bytes.subarray(cursor.offset, end)
  );
  cursor.offset = end;
  return value;
}

function formatArchiveVersion(major: number, minor: number, revision: number): string {
  return revision === 0 ? `${major}.${minor}` : `${major}.${minor}.${revision}`;
}

/**
 * Reads the uncompressed prefix of a `pg_dump --format=custom` archive.
 *
 * The header precedes any compressed data block, so a byte prefix is enough. Only the fields that
 * gate admission are interpreted; everything else is skipped by width so the cursor stays aligned.
 */
export function parsePostgresCustomDumpHeader(bytes: Uint8Array): ExternalBackupHeaderParse {
  const cursor: ByteCursor = { bytes, offset: 0 };

  try {
    for (const expected of PGDMP_MAGIC) {
      if (readByte(cursor) !== expected.charCodeAt(0)) {
        return reject(
          "format_mismatch",
          "Artifact does not start with the PGDMP signature of a pg_dump custom-format archive"
        );
      }
    }

    const major = readByte(cursor);
    const minor = readByte(cursor);
    const revision = major > 1 || (major === 1 && minor > 0) ? readByte(cursor) : 0;
    const archiveVersion = makeArchiveVersion(major, minor, revision);

    if (archiveVersion > K_VERS_MAX) {
      return reject(
        "engine_version_incompatible",
        `Archive format version ${formatArchiveVersion(major, minor, revision)} is newer than ` +
          "this platform can read; re-dump with a pg_dump matching your destination version"
      );
    }

    const intSize = readByte(cursor);
    if (intSize < 1 || intSize > 8) {
      return reject("format_unreadable", "Archive header declares an unsupported integer width");
    }
    if (archiveVersion >= K_VERS_1_7) {
      readByte(cursor);
    }

    const archiveFormat = readByte(cursor);
    if (archiveFormat !== PGDMP_FORMAT_CUSTOM) {
      return reject(
        "format_mismatch",
        "Archive is not in pg_dump custom format; re-dump with `pg_dump --format=custom`"
      );
    }

    if (archiveVersion >= K_VERS_1_15) {
      // A single byte naming the compression algorithm, not a length-prefixed integer.
      readByte(cursor);
    } else if (archiveVersion >= K_VERS_1_2) {
      if (archiveVersion < K_VERS_1_4) {
        readByte(cursor);
      } else {
        readArchiveInt(cursor, intSize, archiveVersion);
      }
    }

    let sourceDatabase: string | null = null;
    if (archiveVersion >= K_VERS_1_4) {
      // Creation timestamp: seven integers (sec, min, hour, mday, mon, year, isdst).
      for (let field = 0; field < 7; field += 1) {
        readArchiveInt(cursor, intSize, archiveVersion);
      }
      sourceDatabase = readArchiveString(cursor, intSize, archiveVersion);
    }

    if (archiveVersion < K_VERS_1_10) {
      return reject(
        "format_unreadable",
        "Archive predates PostgreSQL 9.2 and does not record the server version it was taken " +
          "from, so compatibility with the destination cannot be verified"
      );
    }

    const sourceEngineVersion = readArchiveString(cursor, intSize, archiveVersion);
    const dumpVersion = readArchiveString(cursor, intSize, archiveVersion);

    if (!sourceEngineVersion || parsePostgresMajorVersion(sourceEngineVersion) === null) {
      return reject(
        "format_unreadable",
        "Archive header does not carry a readable source server version"
      );
    }

    return {
      outcome: "parsed",
      header: {
        format: "postgres-custom-dump-v1",
        archiveVersion: formatArchiveVersion(major, minor, revision),
        sourceEngineVersion,
        dumpVersion,
        sourceDatabase,
      },
    };
  } catch (error) {
    if (error instanceof HeaderTruncatedError) {
      return reject("format_unreadable", error.message);
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Redis RDB header                                                            */
/* -------------------------------------------------------------------------- */

const RDB_MAGIC = "REDIS";
const RDB_MAGIC_LENGTH = RDB_MAGIC.length + 4;

export function parseRedisRdbHeader(bytes: Uint8Array): ExternalBackupHeaderParse {
  if (bytes.length < RDB_MAGIC_LENGTH) {
    return reject("format_unreadable", "Artifact is too short to contain an RDB header");
  }

  for (let index = 0; index < RDB_MAGIC.length; index += 1) {
    if (bytes[index] !== RDB_MAGIC.charCodeAt(index)) {
      return reject(
        "format_mismatch",
        "Artifact does not start with the REDIS signature of an RDB snapshot; an AOF file or a " +
          "compressed RDB is not accepted"
      );
    }
  }

  let rdbVersion = 0;
  for (let index = RDB_MAGIC.length; index < RDB_MAGIC_LENGTH; index += 1) {
    const digit = bytes[index] ?? 0;
    if (digit < 0x30 || digit > 0x39) {
      return reject("format_unreadable", "RDB header does not carry a four-digit version");
    }
    rdbVersion = rdbVersion * 10 + (digit - 0x30);
  }

  if (rdbVersion < 1) {
    return reject("format_unreadable", "RDB header declares version 0");
  }

  return { outcome: "parsed", header: { format: "redis-rdb-v1", rdbVersion } };
}

export function parseExternalBackupArtifactHeader(
  format: ExternalBackupImportFormat,
  bytes: Uint8Array
): ExternalBackupHeaderParse {
  return format === "postgres-custom-dump-v1"
    ? parsePostgresCustomDumpHeader(bytes)
    : parseRedisRdbHeader(bytes);
}

/* -------------------------------------------------------------------------- */
/* Engine compatibility                                                        */
/* -------------------------------------------------------------------------- */

export function parsePostgresMajorVersion(version: string): number | null {
  const match = /^\s*(\d{1,3})(?:[._].*)?\s*$/.exec(version);
  if (!match?.[1]) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(major) && major > 0 ? major : null;
}

/**
 * The release a PostgreSQL server reports, without the build description a packager appends:
 * `16.15` out of `16.15 (Debian 16.15-1.pgdg13+2)`.
 *
 * The receipt carries this rather than the whole string. The description is free text read out of
 * the customer's archive that nothing on the control plane uses, and every word of it is one a
 * leak check can match: the platform's backup retention `2` is a word of `…pgdg13+2)`, and the
 * agent refused the receipt of an import it had already staged (#514).
 */
function readPostgresReleaseVersion(serverVersion: string): string | null {
  return /^\s*(\d{1,3}(?:\.\d{1,3}){0,2})/.exec(serverVersion)?.[1] ?? null;
}

/**
 * Highest RDB file version each supported Redis line can load.
 *
 * Redis refuses an RDB newer than its own writer version outright, so this table is the whole
 * compatibility rule. A destination version absent from the table is a rejection, not a default:
 * guessing here would admit a snapshot the destination cannot open.
 */
const REDIS_MAX_READABLE_RDB_VERSION: Record<string, number> = {
  "7.0": 10,
  "7.2": 11,
  "7.4": 12,
};

export function getMaxReadableRdbVersion(destinationVersion: string): number | null {
  return REDIS_MAX_READABLE_RDB_VERSION[destinationVersion.trim()] ?? null;
}

export function isSha256Digest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export interface ExternalBackupArtifactObservation {
  sha256: string;
  sizeBytes: number;
  headerSample: Uint8Array;
}

export interface ExternalBackupArtifactDeclaration {
  format: ExternalBackupImportFormat;
  sha256: string;
  sizeBytes: number;
}

export interface ExternalBackupImportDestination {
  variant: ExternalBackupImportVariant;
  version: string;
}

/**
 * Decides whether an artifact may be restored into the destination engine.
 *
 * Checks run integrity first: until the bytes are known to be the ones the customer registered,
 * nothing parsed out of them means anything. Every branch that cannot reach a positive conclusion
 * returns a rejection, including the ones caused by our own missing knowledge (an unrecognized
 * destination version, an archive too old to state its origin).
 *
 * What a `verified` outcome asserts:
 *   - the bytes hash to the digest registered before the upload slot was issued (integrity, and
 *     binding to the authenticated principal who registered it);
 *   - the container really is the declared format, read from its header rather than its name;
 *   - the engine that wrote it is one the destination can restore from.
 *
 * What it does not assert: who authored the dump, that its contents are benign, or that the
 * statements inside it are safe to execute. A custom-format archive still carries arbitrary SQL
 * that `pg_restore` runs as the destination database owner. An import is exactly as trustworthy
 * as the workspace member who registered it.
 */
export function verifyExternalBackupArtifact(input: {
  declared: ExternalBackupArtifactDeclaration;
  observed: ExternalBackupArtifactObservation;
  destination: ExternalBackupImportDestination;
}): ExternalBackupImportVerification {
  const { declared, observed, destination } = input;

  if (!isSha256Digest(declared.sha256)) {
    return reject("integrity_mismatch", "Registered digest is not a SHA-256 hex digest");
  }
  if (!isSha256Digest(observed.sha256)) {
    return reject("integrity_mismatch", "Artifact digest was not reported as a SHA-256 hex digest");
  }
  if (observed.sha256 !== declared.sha256) {
    return reject(
      "integrity_mismatch",
      "Uploaded artifact does not match the SHA-256 digest registered for this import"
    );
  }
  if (!Number.isSafeInteger(observed.sizeBytes) || observed.sizeBytes <= 0) {
    return reject("integrity_mismatch", "Artifact size was not reported as a positive byte count");
  }
  if (observed.sizeBytes !== declared.sizeBytes) {
    return reject(
      "integrity_mismatch",
      "Uploaded artifact does not match the byte count registered for this import"
    );
  }

  if (EXTERNAL_BACKUP_IMPORT_VARIANT_BY_FORMAT[declared.format] !== destination.variant) {
    return reject(
      "format_mismatch",
      `A ${declared.format} artifact cannot be imported into a ${destination.variant} service`
    );
  }

  const parsed = parseExternalBackupArtifactHeader(declared.format, observed.headerSample);
  if (parsed.outcome === "rejected") {
    return parsed;
  }

  if (parsed.header.format === "postgres-custom-dump-v1") {
    const sourceMajor = parsePostgresMajorVersion(parsed.header.sourceEngineVersion);
    const destinationMajor = parsePostgresMajorVersion(destination.version);
    if (sourceMajor === null) {
      return reject(
        "format_unreadable",
        "Archive header does not carry a readable source server version"
      );
    }
    if (destinationMajor === null) {
      return reject(
        "engine_version_incompatible",
        `Destination PostgreSQL version "${destination.version}" is not a recognized major version`
      );
    }
    if (sourceMajor > destinationMajor) {
      return reject(
        "engine_version_incompatible",
        `Archive was taken from PostgreSQL ${sourceMajor}; a dump cannot be restored into the ` +
          `older PostgreSQL ${destinationMajor} destination`
      );
    }

    return {
      outcome: "verified",
      header: parsed.header,
      sourceEngineVersion:
        readPostgresReleaseVersion(parsed.header.sourceEngineVersion) ?? String(sourceMajor),
    };
  }

  const maxReadable = getMaxReadableRdbVersion(destination.version);
  if (maxReadable === null) {
    return reject(
      "engine_version_incompatible",
      `Destination Redis version "${destination.version}" has no recorded RDB compatibility range`
    );
  }
  if (parsed.header.rdbVersion > maxReadable) {
    return reject(
      "engine_version_incompatible",
      `Snapshot uses RDB version ${parsed.header.rdbVersion}; Redis ${destination.version} reads ` +
        `up to RDB version ${maxReadable}`
    );
  }

  return {
    outcome: "verified",
    header: parsed.header,
    sourceEngineVersion: `rdb-${parsed.header.rdbVersion}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Agent work contract                                                         */
/* -------------------------------------------------------------------------- */

export interface QueuedImportExternalBackupPayload {
  [key: string]: unknown;
  projectId: string;
  serviceId: string;
  serviceName: string;
  variant: ExternalBackupImportVariant;
  /** Destination engine version, e.g. `"17"` or `"7.4"`. */
  version: string;
  importId: string;
  format: ExternalBackupImportFormat;
  /** Digest registered before the upload slot was issued. The agent must reproduce it exactly. */
  artifactSha256: string;
  artifactSizeBytes: number;
  objectKey: string;
  sourceVolumeId: string;
  sourceVolumeName: string;
  targetVolumeId: string;
  targetVolumeName: string;
  targetMountPath: string;
  destination: PlatformBackupDestinationMetadata;
}

export interface ImportExternalBackupPayload extends QueuedImportExternalBackupPayload {
  destination: PlatformBackupDestination;
  imageUrl: string;
  envVars: Record<string, string>;
  containerArgs: string[];
  dataPath: string;
  credentials: DatabaseProvisionCredentials;
}

/**
 * Copies exactly the fields the agent needs, so queued rows stay free of hydrated secrets and a
 * caller cannot smuggle extra payload keys past the contract.
 */
export function buildQueuedImportExternalBackupPayload(
  input: QueuedImportExternalBackupPayload
): QueuedImportExternalBackupPayload {
  return {
    projectId: input.projectId,
    serviceId: input.serviceId,
    serviceName: input.serviceName,
    variant: input.variant,
    version: input.version,
    importId: input.importId,
    format: input.format,
    artifactSha256: input.artifactSha256,
    artifactSizeBytes: input.artifactSizeBytes,
    objectKey: input.objectKey,
    sourceVolumeId: input.sourceVolumeId,
    sourceVolumeName: input.sourceVolumeName,
    targetVolumeId: input.targetVolumeId,
    targetVolumeName: input.targetVolumeName,
    targetMountPath: input.targetMountPath,
    destination: input.destination,
  };
}

const EXTERNAL_BACKUP_IMPORT_VALIDATION_METHODS = [
  "postgres-startup-sql-read",
  "redis-load-ping",
] as const;
export type ExternalBackupImportValidationMethod =
  (typeof EXTERNAL_BACKUP_IMPORT_VALIDATION_METHODS)[number];

/**
 * The import receipt. Every field is something the agent observed rather than something it was
 * told, which is what makes it usable as evidence after the fact.
 */
export interface ExternalBackupImportProofV1 {
  version: 1;
  importId: string;
  format: ExternalBackupImportFormat;
  targetVolumeId: string;
  targetVolumeName: string;
  artifactSha256: string;
  artifactSizeBytes: number;
  digestVerified: true;
  headerVerified: true;
  sourceEngineVersion: string;
  destinationVariant: ExternalBackupImportVariant;
  destinationVersion: string;
  validationMethod: ExternalBackupImportValidationMethod;
  isolatedDatabaseStarted: true;
  /** Postgres: user relations counted in the staged database after restore. */
  relationCount?: number;
  /** Redis: keys loaded from the snapshot. */
  keyCount?: number;
  /** Redis: keys that still carry a TTL, evidencing that expiry survived the import. */
  volatileKeyCount?: number;
  validatedAt: string;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readCount(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Re-checks the agent's receipt against the work item it was issued for.
 *
 * The agent decides whether an artifact passes; this decides whether the *report* of that decision
 * is about the right artifact and the right volume. Without it a compromised or confused agent
 * could mark any import verified by echoing a well-formed proof for something else.
 */
export function isValidExternalBackupImportProof(input: {
  payload: QueuedImportExternalBackupPayload;
  proof: unknown;
}): boolean {
  const { payload, proof } = input;
  if (typeof proof !== "object" || proof === null || Array.isArray(proof)) {
    return false;
  }

  const record = proof as Record<string, unknown>;
  const validationMethod = readString(record, "validationMethod");
  const expectedMethod: ExternalBackupImportValidationMethod =
    payload.variant === "postgres" ? "postgres-startup-sql-read" : "redis-load-ping";

  return (
    record.version === 1 &&
    readString(record, "importId") === payload.importId &&
    readString(record, "format") === payload.format &&
    readString(record, "targetVolumeId") === payload.targetVolumeId &&
    readString(record, "targetVolumeName") === payload.targetVolumeName &&
    readString(record, "artifactSha256") === payload.artifactSha256 &&
    readCount(record, "artifactSizeBytes") === payload.artifactSizeBytes &&
    readString(record, "destinationVariant") === payload.variant &&
    readString(record, "destinationVersion") === payload.version &&
    readString(record, "sourceEngineVersion") !== null &&
    record.digestVerified === true &&
    record.headerVerified === true &&
    record.isolatedDatabaseStarted === true &&
    validationMethod === expectedMethod &&
    readString(record, "validatedAt") !== null
  );
}

/** An engine release as a receipt reports one: `17`, `7.4`, `16.15`, `9.6.24`. */
const ENGINE_RELEASE_VERSION_PATTERN = /^\d{1,3}(?:\.\d{1,3}){0,2}$/;
/** The RDB file version of a Redis snapshot, as a receipt reports it: `rdb-11`. */
const RDB_SOURCE_VERSION_PATTERN = /^rdb-\d{1,4}$/;

const EXTERNAL_BACKUP_IMPORT_VARIANTS: ReadonlySet<string> = new Set(
  Object.values(EXTERNAL_BACKUP_IMPORT_VARIANT_BY_FORMAT)
);

const EXTERNAL_BACKUP_IMPORT_PROOF_VOCABULARY: Readonly<
  Record<string, (value: string) => boolean>
> = {
  format: isExternalBackupImportFormat,
  destinationVariant: (value) => EXTERNAL_BACKUP_IMPORT_VARIANTS.has(value),
  validationMethod: (value) =>
    (EXTERNAL_BACKUP_IMPORT_VALIDATION_METHODS as readonly string[]).includes(value),
  destinationVersion: (value) => ENGINE_RELEASE_VERSION_PATTERN.test(value),
  sourceEngineVersion: (value) =>
    ENGINE_RELEASE_VERSION_PATTERN.test(value) || RDB_SOURCE_VERSION_PATTERN.test(value),
};

/**
 * The fields of an import receipt whose value is one of the platform's own words or a bare engine
 * release: the format, the destination's variant and the validation method, and the source and
 * destination versions. Both ends of the agent protocol keep these as they are instead of
 * redacting them, for the rollout vocabulary's reason (#345): none of them can carry a secret. A
 * release is a few digits the agent parsed out of the archive's header or was told by the payload,
 * never a value it was handed as material.
 *
 * A platform setting or a customer variable that happens to equal one, or a word of one, is not
 * coming back through it. The backup retention `2` beside a dump from PostgreSQL `16.2`, or a
 * variable set to `postgres` on a Postgres service, refused the receipt of an import the agent had
 * already staged (#514). A value of any other shape is not returned, so it is still redacted and
 * still fails the leak check.
 */
export function collectExternalBackupImportProofVocabularyFields(
  proof: Readonly<Record<string, unknown>>
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, isVocabulary] of Object.entries(EXTERNAL_BACKUP_IMPORT_PROOF_VOCABULARY)) {
    const value = Object.hasOwn(proof, key) ? proof[key] : undefined;
    if (typeof value === "string" && isVocabulary(value)) {
      fields[key] = value;
    }
  }
  return fields;
}

export function supportsExternalBackupImport(
  capabilities: { externalBackupImportV1?: boolean } | null | undefined
): boolean {
  return capabilities?.externalBackupImportV1 === true;
}
