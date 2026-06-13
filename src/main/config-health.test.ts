import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock every config dependency the audit checks touch. The tests then
// directly call runConfigHealthCheck (the entry point the renderer hits
// via IPC) and assert on the issues it surfaces.
vi.mock("./config", () => ({
  readEnv: vi.fn(),
  getConfigValue: vi.fn(),
  getModelConfig: vi.fn(),
  customEndpointKeyResolvable: vi.fn(() => false),
  hasOAuthCredentials: vi.fn(() => false),
  setEnvValue: vi.fn(),
  setConfigValue: vi.fn(),
  appendConfigFixLog: vi.fn(),
  upsertBlockChild: vi.fn(),
  maskKey: vi.fn((v: string) => v.slice(0, 4) + "***"),
  profilePaths: vi.fn((profile?: string) => ({
    home: `/fake/home/.hermes`,
    envFile: `/fake/home/.hermes/.env`,
    configFile: `/fake/home/.hermes/config.yaml`,
    profile: profile || "default",
  })),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(
      (p: string) =>
        // Pretend the config file always exists; the audit gates the
        // EMPTY_API_SERVER_KEY warning on `configExists`. The .env file
        // existence is also gated; we treat it as existing unless the
        // mocked readEnv() returns nothing (the tests cover both).
        String(p).endsWith("config.yaml") || String(p).endsWith(".env"),
    ),
  };
});

// Per-test vault map for the command-provider tests. We mutate this object
// (assigning new properties) instead of reassigning, so the closure inside
// the secrets mock always reads the current value. Initialized to empty;
// each test sets the keys it needs.
let FAKE_VAULT: Record<string, string> = {};
// The `.env` layer for the resolvedSecretMap mock below. Kept as an explicit
// module-level holder (parallel to FAKE_VAULT) rather than re-reading ./config
// from inside the mock: a runtime require("./config") inside the vi.mock factory
// does NOT reliably resolve to the test-controlled readEnv mock under vitest, so
// the .env overlay was silently skipped — which is exactly what let the
// vault-wins precedence inversion hide (AIR-008). A precedence test sets this.
let FAKE_ENV: Record<string, string> = {};

vi.mock("./secrets", async () => {
  const actual = await vi.importActual<typeof import("./secrets")>("./secrets");
  return {
    ...actual,
    // Default provider selection: pretend secrets.provider === "command" so
    // getSecretsProvider() returns a command-shaped provider. Tests that
    // specifically want the env provider can override getConfigValue to
    // return null for "secrets.provider".
    getSecretsProvider: () => ({
      id: "command",
      get: (key: string) => FAKE_VAULT[key] ?? null,
      list: () => ({ ...FAKE_VAULT }),
    }),
    // Mirror the real resolvedSecretMap's merge DIRECTION exactly: provider is
    // the BASE (lowest priority), then .env OVERWRITES it, then process.env
    // OVERWRITES that — final precedence process.env > .env > provider. A
    // `!merged[k]` guard here would invert that (vault wins), diverging from
    // production and silently passing any future conflict test that asserts the
    // wrong winner (Greptile #650 / AIR-008). FAKE_VAULT is the base, NOT
    // authoritative — .env/process.env win on conflict.
    resolvedSecretMap: () => {
      // Provider (vault) is the BASE; .env overwrites it; process.env overwrites
      // that — final precedence process.env > .env > provider, matching the real
      // resolvedSecretMap exactly. No `!merged[k]` guard (that inverts it).
      const merged: Record<string, string> = { ...FAKE_VAULT };
      for (const [k, v] of Object.entries(FAKE_ENV)) {
        if (v != null && v !== "") merged[k] = v;
      }
      for (const [k, v] of Object.entries(process.env)) {
        if (v != null && v !== "") merged[k] = v;
      }
      return merged;
    },
  };
});

import {
  readEnv,
  getConfigValue,
  getModelConfig,
  customEndpointKeyResolvable,
  hasOAuthCredentials,
} from "./config";
import { runConfigHealthCheck } from "./config-health";
// The mocked resolvedSecretMap (defined in the vi.mock("./secrets") factory
// above) — imported so a precedence test can assert the merge WINNER directly,
// not just key presence (Greptile #650 / AIR-008).
import { resolvedSecretMap } from "./secrets";

const mockedReadEnv = vi.mocked(readEnv);
const mockedGetConfigValue = vi.mocked(getConfigValue);
const mockedGetModelConfig = vi.mocked(getModelConfig);
const mockedCustomEndpointKeyResolvable = vi.mocked(
  customEndpointKeyResolvable,
);
const mockedHasOAuthCredentials = vi.mocked(hasOAuthCredentials);

describe("config-health audit — vault awareness", () => {
  beforeEach(() => {
    FAKE_VAULT = {};
    FAKE_ENV = {};
    mockedReadEnv.mockReset();
    mockedGetConfigValue.mockReset();
    mockedGetModelConfig.mockReset();
    mockedCustomEndpointKeyResolvable.mockReset();
    mockedHasOAuthCredentials.mockReset();

    // Defaults: empty .env, empty config.yaml. We pick `provider: "anthropic"`
    // with no baseUrl so expectedEnvKeyForModel() returns ANTHROPIC_API_KEY
    // (nano-gpt.com / custom isn't in the URL pattern, so it returns null and
    // the check would silently no-op — not what we want to test). Tests that
    // need a different model override the mock.
    mockedReadEnv.mockReturnValue({});
    mockedGetConfigValue.mockReturnValue(null);
    mockedGetModelConfig.mockReturnValue({
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      baseUrl: "",
    });
    mockedCustomEndpointKeyResolvable.mockReturnValue(false);
    mockedHasOAuthCredentials.mockReturnValue(false);
  });

  afterEach(() => {
    // Don't leak process.env from one test to the next.
    for (const k of [
      "API_SERVER_KEY",
      "NANO_GPT_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_TOKEN",
      "CUSTOM_API_KEY",
      "OPENAI_API_KEY",
    ]) {
      delete process.env[k];
    }
  });

  describe("env provider (default) — byte-for-byte unchanged", () => {
    it("still fires EMPTY_API_SERVER_KEY when neither .env nor vault has the key", () => {
      const report = runConfigHealthCheck("default");
      const codes = report.issues.map((i) => i.code);
      expect(codes).toContain("EMPTY_API_SERVER_KEY");
    });

    it("still fires MODEL_KEY_MISSING when the active model's key is absent everywhere", () => {
      const report = runConfigHealthCheck("default");
      const codes = report.issues.map((i) => i.code);
      expect(codes).toContain("MODEL_KEY_MISSING");
    });

    it("does NOT fire EMPTY_API_SERVER_KEY when the .env file has the key", () => {
      mockedReadEnv.mockReturnValue({ API_SERVER_KEY: "from-dotenv" });
      const report = runConfigHealthCheck("default");
      const codes = report.issues.map((i) => i.code);
      expect(codes).not.toContain("EMPTY_API_SERVER_KEY");
    });

    it("does NOT fire MODEL_KEY_MISSING when the .env file has the key", () => {
      mockedReadEnv.mockReturnValue({ ANTHROPIC_API_KEY: "from-dotenv" });
      const report = runConfigHealthCheck("default");
      const codes = report.issues.map((i) => i.code);
      expect(codes).not.toContain("MODEL_KEY_MISSING");
    });
  });

  describe("command provider — vault-only user", () => {
    it("does NOT fire EMPTY_API_SERVER_KEY when the vault has the key", () => {
      FAKE_VAULT = { API_SERVER_KEY: "from-vault" };
      const report = runConfigHealthCheck("default");
      const codes = report.issues.map((i) => i.code);
      expect(codes).not.toContain("EMPTY_API_SERVER_KEY");
    });

    it("does NOT fire MODEL_KEY_MISSING when the vault has the active model's key", () => {
      FAKE_VAULT = { ANTHROPIC_API_KEY: "from-vault" };
      const report = runConfigHealthCheck("default");
      const codes = report.issues.map((i) => i.code);
      expect(codes).not.toContain("MODEL_KEY_MISSING");
    });

    it("does NOT fire MODEL_KEY_MISSING for a custom endpoint when the vault has OPENAI_API_KEY", () => {
      // With provider: "custom" and baseUrl "https://api.openai.com/v1",
      // expectedEnvKeyForModel() returns OPENAI_API_KEY (URL pattern match).
      // The audit's vault overlay should see OPENAI_API_KEY in the vault
      // and short-circuit before the customEndpointKeyResolvable() branch.
      mockedGetModelConfig.mockReturnValue({
        provider: "custom",
        model: "any-model",
        baseUrl: "https://api.openai.com/v1",
      });
      mockedReadEnv.mockReturnValue({});
      FAKE_VAULT = { OPENAI_API_KEY: "from-vault" };
      const report = runConfigHealthCheck("default");
      const codes = report.issues.map((i) => i.code);
      expect(codes).not.toContain("MODEL_KEY_MISSING");
    });
  });

  describe("process.env (vault-style env injection) — works the same way", () => {
    it("does NOT fire EMPTY_API_SERVER_KEY when process.env has the key", () => {
      // Many "vault" workflows just `export` the keys into the process
      // environment (e.g. a KeePassXC unseal script that calls `setenv`).
      // The audit must honor that.
      process.env.API_SERVER_KEY = "from-process-env";
      const report = runConfigHealthCheck("default");
      const codes = report.issues.map((i) => i.code);
      expect(codes).not.toContain("EMPTY_API_SERVER_KEY");
    });

    it("does NOT fire MODEL_KEY_MISSING when process.env has the key", () => {
      process.env.ANTHROPIC_API_KEY = "from-process-env";
      const report = runConfigHealthCheck("default");
      const codes = report.issues.map((i) => i.code);
      expect(codes).not.toContain("MODEL_KEY_MISSING");
    });
  });

  describe("rotation + deletion — reflected on next audit", () => {
    it("EMPTY_API_SERVER_KEY fires when the only source is removed", () => {
      // Simulate rotation: key was in .env, then moved to the vault, then
      // the vault entry got deleted. The audit must catch it again.
      mockedReadEnv.mockReturnValue({ API_SERVER_KEY: "from-dotenv" });
      let report = runConfigHealthCheck("default");
      expect(report.issues.map((i) => i.code)).not.toContain(
        "EMPTY_API_SERVER_KEY",
      );

      // User deletes the .env entry (vault doesn't have it either).
      mockedReadEnv.mockReturnValue({});
      report = runConfigHealthCheck("default");
      expect(report.issues.map((i) => i.code)).toContain(
        "EMPTY_API_SERVER_KEY",
      );
    });

    it("MODEL_KEY_MISSING recovers when a vault key is added", () => {
      // Vault is empty — warning fires.
      let report = runConfigHealthCheck("default");
      expect(report.issues.map((i) => i.code)).toContain("MODEL_KEY_MISSING");

      // Add the key to the vault — next audit should clear the warning.
      FAKE_VAULT = { ANTHROPIC_API_KEY: "rotated-value" };
      report = runConfigHealthCheck("default");
      expect(report.issues.map((i) => i.code)).not.toContain(
        "MODEL_KEY_MISSING",
      );

      // Rotate to a new value — still no warning.
      FAKE_VAULT = { ANTHROPIC_API_KEY: "rotated-again" };
      report = runConfigHealthCheck("default");
      expect(report.issues.map((i) => i.code)).not.toContain(
        "MODEL_KEY_MISSING",
      );

      // Delete the key — warning comes back.
      FAKE_VAULT = {};
      report = runConfigHealthCheck("default");
      expect(report.issues.map((i) => i.code)).toContain("MODEL_KEY_MISSING");
    });

    it("resolves precedence process.env > .env > provider on a key CONFLICT (AIR-008)", () => {
      // Same key present in all three layers with DIFFERENT values. The mock
      // must reproduce production's merge DIRECTION (provider base, .env and
      // process.env overwrite) — not a vault-wins inversion. Presence-only
      // tests can't catch a flipped direction; this asserts the actual winner.
      FAKE_VAULT = { API_SERVER_KEY: "from-vault" };
      FAKE_ENV = { API_SERVER_KEY: "from-dotenv" };

      // .env beats vault when process.env is absent.
      delete process.env.API_SERVER_KEY;
      expect(resolvedSecretMap("default").API_SERVER_KEY).toBe("from-dotenv");

      // process.env beats both when present.
      process.env.API_SERVER_KEY = "from-process-env";
      try {
        expect(resolvedSecretMap("default").API_SERVER_KEY).toBe(
          "from-process-env",
        );
      } finally {
        delete process.env.API_SERVER_KEY;
      }

      // With only the vault set, the vault value is what surfaces (base layer).
      FAKE_ENV = {};
      expect(resolvedSecretMap("default").API_SERVER_KEY).toBe("from-vault");
    });
  });
});
