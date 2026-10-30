import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";

// Hoisted mocks with benign DISABLED defaults so the module-load self-invoke
// (`runHook().catch(...)` at the bottom of src/index.ts) lands on the
// !enabled early-return path and never produces an unhandled rejection.
const mocks = vi.hoisted(() => ({
  readStdinMock: vi.fn(async () => ({}) as Record<string, unknown>),
  getConfigMock: vi.fn(async () => ({ enabled: false, debug: false, failOnError: false }) as Config),
  dispatchMock: vi.fn(async () => ({ emitted: 0 })),
}));

vi.mock("../src/util.js", async (orig) => {
  const actual = await orig<typeof import("../src/util.js")>();
  return { ...actual, readStdin: mocks.readStdinMock };
});
vi.mock("../src/config.js", () => ({ getConfig: mocks.getConfigMock }));
vi.mock("../src/emit.js", () => ({ dispatch: mocks.dispatchMock }));

// Import once. The self-invoke runs here with the disabled defaults above.
const { runHook } = await import("../src/index.js");

const baseConfig: Config = {
  enabled: false,
  hostUrl: "https://app.traceroot.ai",
  maxChars: 20000,
  maxRequestBytes: 12 * 1024 * 1024,
  debug: false,
  failOnError: false,
};
const disabledConfig: Config = { ...baseConfig, enabled: false };
const enabledConfig: Config = { ...baseConfig, enabled: true };

beforeEach(() => {
  // Reset call history AND implementations, then restore benign defaults so
  // each case starts from a known disabled state with no cross-test bleed.
  mocks.readStdinMock.mockReset().mockResolvedValue({});
  mocks.getConfigMock.mockReset().mockResolvedValue(disabledConfig);
  mocks.dispatchMock.mockReset().mockResolvedValue({ emitted: 0 });
});

describe("runHook", () => {
  it("returns without throwing when disabled", async () => {
    await expect(runHook()).resolves.toBeUndefined();
  });

  it("does NOT call dispatch when tracing is disabled", async () => {
    mocks.getConfigMock.mockResolvedValue(disabledConfig);
    await runHook();
    expect(mocks.dispatchMock).not.toHaveBeenCalled();
  });

  it("calls dispatch once when enabled and transcript_path is present", async () => {
    mocks.readStdinMock.mockResolvedValue({ transcript_path: "/x/rollout.jsonl" });
    mocks.getConfigMock.mockResolvedValue(enabledConfig);
    await runHook();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT call dispatch when enabled but transcript_path is missing", async () => {
    mocks.readStdinMock.mockResolvedValue({});
    mocks.getConfigMock.mockResolvedValue(enabledConfig);
    await runHook();
    expect(mocks.dispatchMock).not.toHaveBeenCalled();
  });

  // GLOBAL CONSTRAINT: fail-open. A dispatch error must never escape runHook
  // (it would otherwise break the Codex turn).
  it("swallows dispatch errors when failOnError is false (fail-open)", async () => {
    mocks.readStdinMock.mockResolvedValue({ transcript_path: "/x/rollout.jsonl" });
    mocks.getConfigMock.mockResolvedValue({ ...enabledConfig, failOnError: false });
    mocks.dispatchMock.mockRejectedValue(new Error("boom"));
    await expect(runHook()).resolves.toBeUndefined();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("re-throws dispatch errors when failOnError is true", async () => {
    mocks.readStdinMock.mockResolvedValue({ transcript_path: "/x/rollout.jsonl" });
    mocks.getConfigMock.mockResolvedValue({ ...enabledConfig, failOnError: true });
    mocks.dispatchMock.mockRejectedValue(new Error("boom"));
    await expect(runHook()).rejects.toThrow("boom");
  });

  // failOnError resolved from JSON config (not an env var) must still set the
  // exit code — the fix is that runHook honors resolved config directly rather
  // than the module-level handler re-deriving it from process.env.
  it("sets process.exitCode=1 from resolved config, not just env vars", async () => {
    const prev = process.exitCode;
    process.exitCode = 0;
    try {
      mocks.readStdinMock.mockResolvedValue({ transcript_path: "/x/rollout.jsonl" });
      mocks.getConfigMock.mockResolvedValue({ ...enabledConfig, failOnError: true });
      mocks.dispatchMock.mockRejectedValue(new Error("boom"));
      await expect(runHook()).rejects.toThrow("boom");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prev;
    }
  });
});
