// @ts-expect-error Bun provides the test module at runtime in this workspace.
import { describe, expect, test } from "bun:test";
import {
  createBuildLogRedactor,
  redactSensitiveText,
  sanitizeSensitiveProtocolValue,
  sanitizeSensitiveValue,
} from "./security.js";

describe("createBuildLogRedactor", () => {
  // The build map the agent receives is the customer's own map laid over the generated catalog of
  // every resource it references, so a service referencing only `${{db.DATABASE_URL}}` still has
  // `PGSSLMODE=require` in it. The agent redacts before the line leaves the server, so getting the
  // rule wrong here is not something the control plane can undo (#219, #245).
  const buildEnvVars = {
    DATABASE_URL: "postgres://nouva:zzgeneratedzz@db.internal/app",
    PGDATABASE: "nouva_suite_db",
    PGSSLMODE: "require",
    PROBE_SECRET: "zzsecretvaluezz",
  };

  test("keeps an ordinary filename that contains a platform-generated word", () => {
    const redact = createBuildLogRedactor(buildEnvVars, ["require", "nouva_suite_db"]);

    expect(redact("pip install -r requirements.txt")).toBe("pip install -r requirements.txt");
    expect(redact("2 packages required, 0 satisfied")).toBe("2 packages required, 0 satisfied");
  });

  test("keeps variable names legible", () => {
    const redact = createBuildLogRedactor(buildEnvVars, ["require", "nouva_suite_db"]);

    expect(redact("reading PGSSLMODE and DATABASE_URL from the environment")).toBe(
      "reading PGSSLMODE and DATABASE_URL from the environment"
    );
  });

  test("still masks a platform-generated word standing on its own", () => {
    const redact = createBuildLogRedactor(buildEnvVars, ["require", "nouva_suite_db"]);

    expect(redact("sslmode=require")).toBe("sslmode=[REDACTED]");
  });

  test("masks a customer value wherever it appears, including inside a longer run", () => {
    const redact = createBuildLogRedactor(buildEnvVars, ["require", "nouva_suite_db"]);

    expect(redact("prefixzzsecretvaluezzsuffix")).toBe("prefix[REDACTED]suffix");
    expect(redact(buildEnvVars.DATABASE_URL)).toBe("[REDACTED]");
  });

  test("masks a word-shaped value the platform did not generate", () => {
    const redact = createBuildLogRedactor({ APP_PASSWORD: "changeme" }, []);

    expect(redact("tried changemenow")).toBe("tried [REDACTED]now");
  });

  test("keeps a port the platform generated", () => {
    // #398: `PGPORT=5432` comes from the referenced database's generated catalog.
    const redact = createBuildLogRedactor({ ...buildEnvVars, PGPORT: "5432" }, [
      "require",
      "nouva_suite_db",
      "5432",
    ]);

    expect(redact("added 154321 packages, waiting for db.internal:5432")).toBe(
      "added 154321 packages, waiting for db.internal:5432"
    );
    expect(redact("prefixzzsecretvaluezzsuffix")).toBe("prefix[REDACTED]suffix");
    expect(redact(buildEnvVars.DATABASE_URL)).toBe("[REDACTED]");
  });

  test("masks a port-shaped value the platform did not generate", () => {
    const redact = createBuildLogRedactor({ PGPORT: "5432", PIN_CODE: "6379" }, ["5432"]);

    expect(redact("pin 6379, build 163790")).toBe("pin [REDACTED], build 1[REDACTED]0");
  });
});

describe("redactSensitiveText", () => {
  test("redacts clone credentials from command failures", () => {
    expect(
      redactSensitiveText(
        "Command failed: git clone https://x-access-token:ghs_installation_secret@github.com/nouva/private.git"
      )
    ).toBe("Command failed: git clone https://[REDACTED]@github.com/nouva/private.git");
  });

  test("leaves ordinary build failures unchanged", () => {
    expect(redactSensitiveText("Docker build failed")).toBe("Docker build failed");
  });

  test("redacts environment names and values including one and two character secrets", () => {
    const redacted = redactSensitiveText("build-arg:Q=x build-arg:UV=yz", {
      Q: "x",
      UV: "yz",
    });

    for (const secret of ["Q", "x", "UV", "yz"]) {
      expect(redacted).not.toContain(secret);
    }
  });

  test("recursively sanitizes environment names and values in failure results", () => {
    const sanitized = sanitizeSensitiveValue(
      {
        Q: "x",
        nested: [
          {
            UV: "yz",
            statusMessage: "Q=x UV=yz",
          },
        ],
      },
      {
        Q: "x",
        UV: "yz",
      }
    );
    const serialized = JSON.stringify(sanitized);

    for (const secret of ["Q", "x", "UV", "yz"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("[REDACTED]");
  });

  test("redacts nested environment values inside protocol values but keeps the names", () => {
    const sanitized = sanitizeSensitiveProtocolValue(
      {
        containerId: "container-runtime-secret",
        nested: {
          Q: "x",
          statusMessage: "Q=x",
        },
      },
      {
        runtimeMetadata: "runtime-secret",
        Q: "x",
      }
    );

    expect(sanitized).toEqual({
      containerId: "container-[REDACTED]",
      nested: {
        Q: "[REDACTED]",
        statusMessage: "Q=[REDACTED]",
      },
    });
  });

  test("keeps platform identity a variable happens to repeat", () => {
    const environmentVariables = {
      PHX_HOST: "phoenix.up.nouva.cloud",
      SECRET_KEY_BASE: "super-secret-base",
    };

    // The provided hostname is generated by the control plane and handed to the agent, so a
    // variable set to it is not a leak and must not make the result unreportable (#187).
    expect(
      sanitizeSensitiveProtocolValue(
        {
          externalHost: "phoenix.up.nouva.cloud",
          runtimeMetadata: {
            ingressHost: "phoenix.up.nouva.cloud",
            statusMessage: "started with super-secret-base",
          },
        },
        environmentVariables,
        ["phoenix.up.nouva.cloud"]
      )
    ).toEqual({
      externalHost: "phoenix.up.nouva.cloud",
      runtimeMetadata: {
        ingressHost: "phoenix.up.nouva.cloud",
        statusMessage: "started with [REDACTED]",
      },
    });
  });

  test("keeps payload operational paths that equal environment values", () => {
    const environmentVariables = {
      PGDATA: "/var/lib/postgresql/pgdata",
      Q: "x",
    };

    expect(
      sanitizeSensitiveProtocolValue(
        {
          dataPath: "/var/lib/postgresql/pgdata",
          statusMessage: "Q=x at /var/lib/postgresql/pgdata",
        },
        environmentVariables,
        ["/var/lib/postgresql/pgdata"]
      )
    ).toEqual({
      dataPath: "/var/lib/postgresql/pgdata",
      statusMessage: "Q=[REDACTED] at /var/lib/postgresql/pgdata",
    });
    expect(
      sanitizeSensitiveProtocolValue(
        { dataPath: "/var/lib/postgresql/pgdata" },
        environmentVariables
      )
    ).toEqual({ dataPath: "[REDACTED]" });
  });
});
