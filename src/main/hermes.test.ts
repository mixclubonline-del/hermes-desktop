import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// hermes.ts pulls in the full main-process import graph; mock the modules with
// import-time side effects (installer → electron) and the two seams under
// test (config's readEnv / secrets' providerListSafe). Everything else
// (run-stream, url-key-map, …) is pure and loads for real.
vi.mock("./installer", () => ({
  HERMES_HOME: "/tmp/hermes-test-home",
  HERMES_REPO: "/tmp/hermes-test-repo",
  HERMES_PYTHON: "python3",
  hermesCliArgs: vi.fn(() => []),
  getEnhancedPath: vi.fn(() => ""),
}));
vi.mock("./config", () => ({
  getApiServerKey: vi.fn(() => ""),
  getConnectionConfig: vi.fn(() => ({
    mode: "local",
    remoteUrl: "",
    apiKey: "",
    ssh: {},
  })),
  getConfigValue: vi.fn(() => null),
  getModelConfig: vi.fn(),
  readEnv: vi.fn(() => ({})),
}));
vi.mock("./ssh-tunnel", () => ({
  getSshTunnelUrl: vi.fn(() => null),
  isSshTunnelActive: vi.fn(() => false),
  isSshTunnelHealthy: vi.fn(() => false),
  startSshTunnel: vi.fn(),
}));
vi.mock("./utils", () => ({
  pidIsAliveAs: vi.fn(() => false),
  stripAnsi: (s: string) => s,
  profileHome: vi.fn(() => "/tmp/hermes-test-home"),
  profilePaths: vi.fn(() => ({
    configFile: "/tmp/hermes-test-home/config.yaml",
    envFile: "/tmp/hermes-test-home/.env",
  })),
  normalizeProfileName: (p?: string) => p,
  getActiveProfileNameSync: vi.fn(() => undefined),
}));
vi.mock("./gateway-ports", () => ({ getProfilePort: vi.fn(() => 8642) }));
vi.mock("./models", () => ({ readModels: vi.fn(() => []) }));
vi.mock("./secrets", () => ({ providerListSafe: vi.fn(() => ({})) }));

import { getModelConfig, readEnv } from "./config";
import { providerListSafe } from "./secrets";
import { transcribeAudio } from "./hermes";

const mockedGetModelConfig = vi.mocked(getModelConfig);
const mockedReadEnv = vi.mocked(readEnv);
const mockedProviderListSafe = vi.mocked(providerListSafe);

describe("transcribeAudio API-key resolution", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    mockedGetModelConfig.mockReset();
    mockedReadEnv.mockReset();
    mockedProviderListSafe.mockReset();
    mockedGetModelConfig.mockReturnValue({
      baseUrl: "https://api.groq.com/openai/v1",
    } as ReturnType<typeof getModelConfig>);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: "transcribed" }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sentAuthHeader(): string | undefined {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return (init.headers as Record<string, string>).Authorization;
  }

  it("falls back to the secrets provider when .env lacks the key (vault user)", async () => {
    mockedReadEnv.mockReturnValue({});
    mockedProviderListSafe.mockReturnValue({ GROQ_API_KEY: "from-vault" });

    await expect(
      transcribeAudio(new Uint8Array([1, 2, 3]), "audio/webm", "default"),
    ).resolves.toBe("transcribed");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentAuthHeader()).toBe("Bearer from-vault");
  });

  it(".env wins over the secrets provider (env-provider precedence unchanged)", async () => {
    mockedReadEnv.mockReturnValue({ GROQ_API_KEY: "from-dotenv" });
    mockedProviderListSafe.mockReturnValue({ GROQ_API_KEY: "from-vault" });

    await transcribeAudio(new Uint8Array([1, 2, 3]), "audio/webm", "default");

    expect(sentAuthHeader()).toBe("Bearer from-dotenv");
  });

  it("generic CUSTOM_API_KEY/OPENAI_API_KEY fallbacks also see the provider overlay", async () => {
    mockedGetModelConfig.mockReturnValue({
      baseUrl: "https://llm.example.com/v1",
    } as ReturnType<typeof getModelConfig>);
    mockedReadEnv.mockReturnValue({});
    mockedProviderListSafe.mockReturnValue({ CUSTOM_API_KEY: "from-vault" });

    await transcribeAudio(new Uint8Array([1, 2, 3]), "audio/webm", "default");

    expect(sentAuthHeader()).toBe("Bearer from-vault");
  });
});
