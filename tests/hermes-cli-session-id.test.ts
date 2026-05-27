import { EventEmitter } from "events";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { spawned, TEST_HOME, healthStatuses, apiBodies } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os");
  return {
    spawned: [] as Array<
      EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        killed: boolean;
        kill: ReturnType<typeof vi.fn>;
        unref: ReturnType<typeof vi.fn>;
      }
    >,
    TEST_HOME: path.join(os.tmpdir(), `hermes-cli-session-test-${Date.now()}`),
    healthStatuses: [] as number[],
    apiBodies: [] as string[],
  };
});

vi.mock("http", () => ({
  default: {
    request: (
      _url: string,
      _options: Record<string, unknown>,
      cb?: (res: {
        statusCode: number;
        headers?: Record<string, string>;
        resume?: () => void;
        on?: (event: string, handler: (...args: unknown[]) => void) => void;
      }) => void,
    ) => {
      let body = "";
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const req = {
        write: (chunk: string | Buffer) => {
          body += chunk.toString();
        },
        end: () => {
          if (_url.endsWith("/health")) {
            cb?.({
              statusCode: healthStatuses.shift() ?? 503,
              resume: () => {},
            });
            return;
          }

          if (_url.endsWith("/v1/chat/completions")) {
            apiBodies.push(body);
            const res = new EventEmitter() as EventEmitter & {
              statusCode: number;
              headers: Record<string, string>;
            };
            res.statusCode = 200;
            res.headers = { "x-hermes-session-id": "desk-cold-gateway" };
            cb?.(res);
            queueMicrotask(() => {
              res.emit(
                "data",
                Buffer.from(
                  'data: {"choices":[{"delta":{"content":"Hi from API"}}]}\n\n',
                ),
              );
              res.emit("data", Buffer.from("data: [DONE]\n\n"));
              res.emit("end");
            });
          }
        },
        on: (event: string, handler: (...args: unknown[]) => void) => {
          handlers.set(event, handler);
          return req;
        },
        destroy: () => {
          handlers.get("error")?.(new Error("destroyed"));
        },
      };
      return req;
    },
  },
}));

vi.mock("https", () => ({
  default: {
    request: () => ({
      write: () => {},
      end: () => {},
      on: () => {},
      destroy: () => {},
    }),
  },
}));

vi.mock("child_process", () => ({
  default: {
    spawn: vi.fn(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        killed: false,
        kill: vi.fn(),
        unref: vi.fn(),
      });
      spawned.push(proc);
      return proc;
    }),
  },
  spawn: vi.fn(() => {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      killed: false,
      kill: vi.fn(),
      unref: vi.fn(),
    });
    spawned.push(proc);
    return proc;
  }),
}));

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: TEST_HOME,
  HERMES_PYTHON: "/usr/bin/python3",
  HERMES_REPO: "/dev/null",
  hermesCliArgs: (extra?: string[]) => ["/dev/null", ...(extra || [])],
  getEnhancedPath: () => process.env.PATH || "",
}));

vi.mock("../src/main/config", () => ({
  getModelConfig: () => ({ model: "test-model", provider: "openrouter" }),
  readEnv: () => ({}),
  getApiServerKey: () => "",
  getConnectionConfig: () => ({ mode: "local" as const }),
}));

vi.mock("../src/main/ssh-tunnel", () => ({
  getSshTunnelUrl: () => null,
  isSshTunnelActive: () => false,
  isSshTunnelHealthy: () => Promise.resolve(false),
  startSshTunnel: () => Promise.resolve(),
}));

vi.mock("../src/main/utils", () => ({
  stripAnsi: (s: string) => s,
  pidIsAliveAs: () => false,
}));

vi.mock("../src/main/models", () => ({
  readModels: () => [],
}));

vi.mock("../src/main/process-options", () => ({
  HIDDEN_SUBPROCESS_OPTIONS: {},
}));

import {
  sendMessage,
  startGateway,
  stopGateway,
  stopHealthPolling,
} from "../src/main/hermes";

describe("CLI fallback session id propagation", () => {
  beforeEach(() => {
    healthStatuses.length = 0;
    apiBodies.length = 0;
  });

  afterEach(() => {
    stopGateway(true);
    stopHealthPolling();
    spawned.length = 0;
  });

  it("captures the quiet CLI session id from stderr so the next desktop turn can resume it", async () => {
    const done = new Promise<string | undefined>((resolve) => {
      sendMessage("hi", {
        onChunk: () => {},
        onDone: resolve,
        onError: () => {},
      }).then(() => {
        const proc = spawned[0];
        proc.stdout.emit("data", Buffer.from("Hi there"));
        proc.stderr.emit(
          "data",
          Buffer.from("\nsession_id: 20260527_143413_10df4c\n"),
        );
        proc.emit("close", 0);
      });
    });

    await expect(done).resolves.toBe("20260527_143413_10df4c");
  });

  it("waits for a cold gateway to become API-ready instead of falling back to CLI", async () => {
    healthStatuses.push(503, 200);

    expect(startGateway()).toBe(true);
    expect(spawned).toHaveLength(1);

    const chunks: string[] = [];
    const done = new Promise<string | undefined>((resolve, reject) => {
      sendMessage("hi", {
        onChunk: (chunk) => chunks.push(chunk),
        onDone: resolve,
        onError: reject,
      }).catch(reject);
    });

    await expect(done).resolves.toBe("desk-cold-gateway");
    expect(chunks.join("")).toBe("Hi from API");
    expect(spawned).toHaveLength(1);
    expect(apiBodies).toHaveLength(1);
    expect(JSON.parse(apiBodies[0])).toMatchObject({
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
  });

  it("re-checks health when a previously-ready local gateway is restarted cold", async () => {
    healthStatuses.push(200);

    await expect(
      new Promise<string | undefined>((resolve, reject) => {
        sendMessage("warmup", {
          onChunk: () => {},
          onDone: resolve,
          onError: reject,
        }).catch(reject);
      }),
    ).resolves.toBe("desk-cold-gateway");
    expect(apiBodies).toHaveLength(1);

    expect(startGateway()).toBe(true);
    expect(spawned).toHaveLength(1);
    healthStatuses.push(503, 200);

    const chunks: string[] = [];
    await expect(
      new Promise<string | undefined>((resolve, reject) => {
        sendMessage("hi after restart", {
          onChunk: (chunk) => chunks.push(chunk),
          onDone: resolve,
          onError: reject,
        }).catch(reject);
      }),
    ).resolves.toBe("desk-cold-gateway");

    expect(chunks.join("")).toBe("Hi from API");
    expect(spawned).toHaveLength(1);
    expect(apiBodies).toHaveLength(2);
    expect(JSON.parse(apiBodies[1])).toMatchObject({
      messages: [{ role: "user", content: "hi after restart" }],
      stream: true,
    });
  });
});
