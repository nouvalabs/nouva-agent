import type { DockerContainerFile } from "./docker-api.js";

/**
 * pgBackRest options that authenticate to, or decrypt, the platform backup repository, keyed by the
 * environment variable the control plane delivers each one in.
 */
const REPOSITORY_SECRET_OPTIONS: ReadonlyMap<string, string> = new Map([
  ["PGBACKREST_REPO1_S3_KEY", "repo1-s3-key"],
  ["PGBACKREST_REPO1_S3_KEY_SECRET", "repo1-s3-key-secret"],
  ["PGBACKREST_REPO1_CIPHER_PASS", "repo1-cipher-pass"],
]);

const CONFIG_INCLUDE_PATH_VARIABLE = "PGBACKREST_CONFIG_INCLUDE_PATH";

/** pgBackRest loads every `*.conf` here on top of the image's generated `pgbackrest.conf`. */
export const PGBACKREST_CREDENTIALS_INCLUDE_PATH = "/etc/nouva/pgbackrest";

// The Nouva PostgreSQL image keeps the official image's `postgres` account, which pins uid and gid
// 999, and both archive_command and every backup task run pgBackRest as that account.
const POSTGRES_ACCOUNT_ID = 999;

/**
 * Moves the platform repository credentials out of a container environment and into a pgBackRest
 * include file written into that container.
 *
 * A container environment is part of its configuration: `docker inspect` prints it, and every tool
 * that collects container metadata through the Docker API gathers it too. The include file exists
 * only inside the container's filesystem, readable by the account that runs pgBackRest.
 *
 * An environment without repository credentials comes back unchanged, with no files.
 */
export function separatePgBackrestCredentials(env: readonly string[]): {
  env: string[];
  files: DockerContainerFile[];
} {
  const kept: string[] = [];
  const options: string[] = [];
  for (const entry of env) {
    const separator = entry.indexOf("=");
    const option = separator > 0 ? REPOSITORY_SECRET_OPTIONS.get(entry.slice(0, separator)) : null;
    if (!option) {
      kept.push(entry);
      continue;
    }

    const value = entry.slice(separator + 1);
    // One line per option is the whole file format; a line break would start another option.
    if (/[\r\n]/.test(value)) {
      throw new Error(`${entry.slice(0, separator)} cannot contain a line break`);
    }
    options.push(`${option}=${value}`);
  }

  if (options.length === 0) {
    return { env: kept, files: [] };
  }

  return {
    env: [
      ...kept.filter((entry) => !entry.startsWith(`${CONFIG_INCLUDE_PATH_VARIABLE}=`)),
      `${CONFIG_INCLUDE_PATH_VARIABLE}=${PGBACKREST_CREDENTIALS_INCLUDE_PATH}`,
    ],
    files: [
      {
        path: `${PGBACKREST_CREDENTIALS_INCLUDE_PATH}/repository-credentials.conf`,
        content: ["[global]", ...options, ""].join("\n"),
        mode: 0o600,
        uid: POSTGRES_ACCOUNT_ID,
        gid: POSTGRES_ACCOUNT_ID,
      },
    ],
  };
}
