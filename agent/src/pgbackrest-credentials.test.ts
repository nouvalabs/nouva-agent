import { describe, expect, test } from "bun:test";
import {
  PGBACKREST_CREDENTIALS_INCLUDE_PATH,
  separatePgBackrestCredentials,
} from "./pgbackrest-credentials.js";

const ACCESS_KEY = "access-key-sentinel";
const SECRET_KEY = "secret-key-sentinel";
const CIPHER_PASS = "cipher-pass-sentinel";

describe("separatePgBackrestCredentials", () => {
  test("moves repository credentials from the environment into a pgBackRest include file", () => {
    const separated = separatePgBackrestCredentials([
      "POSTGRES_USER=nouva_user",
      "PGBACKREST_STANZA=vol-vol_1",
      "PGBACKREST_REPO1_S3_BUCKET=nouva-backups",
      `PGBACKREST_REPO1_S3_KEY=${ACCESS_KEY}`,
      `PGBACKREST_REPO1_S3_KEY_SECRET=${SECRET_KEY}`,
      `PGBACKREST_REPO1_CIPHER_PASS=${CIPHER_PASS}`,
    ]);

    expect(separated.env).toEqual([
      "POSTGRES_USER=nouva_user",
      "PGBACKREST_STANZA=vol-vol_1",
      "PGBACKREST_REPO1_S3_BUCKET=nouva-backups",
      `PGBACKREST_CONFIG_INCLUDE_PATH=${PGBACKREST_CREDENTIALS_INCLUDE_PATH}`,
    ]);
    for (const secret of [ACCESS_KEY, SECRET_KEY, CIPHER_PASS]) {
      expect(separated.env.join("\n")).not.toContain(secret);
    }
    expect(separated.files).toEqual([
      {
        path: `${PGBACKREST_CREDENTIALS_INCLUDE_PATH}/repository-credentials.conf`,
        content: [
          "[global]",
          `repo1-s3-key=${ACCESS_KEY}`,
          `repo1-s3-key-secret=${SECRET_KEY}`,
          `repo1-cipher-pass=${CIPHER_PASS}`,
          "",
        ].join("\n"),
        mode: 0o600,
        uid: 999,
        gid: 999,
      },
    ]);
  });

  test("keeps credential values that contain an equals sign intact", () => {
    const separated = separatePgBackrestCredentials([`PGBACKREST_REPO1_S3_KEY_SECRET=abc=/+def=`]);

    expect(separated.files[0]?.content).toContain("repo1-s3-key-secret=abc=/+def=\n");
  });

  test("leaves an environment without repository credentials untouched", () => {
    const env = [
      "POSTGRES_USER=nouva_user",
      "PGBACKREST_STANZA=vol-vol_1",
      "PGBACKREST_REPO1_PATH=/postgres/v1/projects/proj_1/volumes/vol_1",
    ];

    expect(separatePgBackrestCredentials(env)).toEqual({ env, files: [] });
  });

  test("points pgBackRest at the credentials directory even if an include path was already set", () => {
    const separated = separatePgBackrestCredentials([
      "PGBACKREST_CONFIG_INCLUDE_PATH=/somewhere/else",
      `PGBACKREST_REPO1_S3_KEY=${ACCESS_KEY}`,
    ]);

    expect(separated.env).toEqual([
      `PGBACKREST_CONFIG_INCLUDE_PATH=${PGBACKREST_CREDENTIALS_INCLUDE_PATH}`,
    ]);
  });

  test("rejects a credential that would inject another option, without echoing its value", () => {
    let message: string | null = null;
    try {
      separatePgBackrestCredentials([
        `PGBACKREST_REPO1_S3_KEY_SECRET=${SECRET_KEY}\nrepo1-path=/elsewhere`,
      ]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("PGBACKREST_REPO1_S3_KEY_SECRET cannot contain a line break");
  });
});
