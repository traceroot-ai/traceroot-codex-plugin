import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { testConfig } from "./helpers.js";

// Hoisted mocks with benign DISABLED defaults so the module-load self-invoke
// (`runHook().catch(...)` at the bottom of src/index.ts) lands on the
// !enabled early-return path and never produces an unhandled rejection.
const mocks = vi.hoisted(() => ({
  readStdinMock: vi.fn(async () => ({}) as Record<string, unknown>),
  getConfigMock: vi.fn(async () => ({ enabled: false, debug: false, failOnError: false }) as Config),
  dispatchMock: vi.fn(async () => ({ emitted: 0 })),
  drainMock: vi.fn(async () => {}),
}));

vi.mock("../src/util.js", async (orig) => {
  const actual = await orig<typeof import("../src/util.js")>();
  return { ...actual, readStdin: mocks.readStdinMock };
});
vi.mock("../src/config.js", () => ({ getConfig: mocks.getConfigMock }));
vi.mock("../src/emit.js", () => ({ dispatch: mocks.dispatchMock, drain: mocks.drainMock }));

// Import once. The self-invoke runs here with the disabled defaults above.
const { runDrainer, runHook } = await import("../src/index.js");
const { DRAIN_LIFETIME_MS } = await import("../src/lock.js");

const baseConfig = testConfig({ enabled: false, hostUrl: "https://app.traceroot.ai", failOnError: false });
const disabledConfig: Config = { ...baseConfig, enabled: false };
const enabledConfig: Config = { ...baseConfig, enabled: true };

beforeEach(() => {
  // Reset call history AND implementations, then restore benign defaults so
  // each case starts from a known disabled state with no cross-test bleed.
  mocks.readStdinMock.mockReset().mockResolvedValue({});
  mocks.getConfigMock.mockReset().mockResolvedValue(disabledConfig);
  mocks.dispatchMock.mockReset().mockResolvedValue({ emitted: 0 });
  mocks.drainMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

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

describe("runDrainer", () => {
  const session = JSON.stringify({ transcript_path: "/x/rollout.jsonl", cwd: "/x" });

  it("drains the session it was started for when tracing is enabled", async () => {
    mocks.getConfigMock.mockResolvedValue(enabledConfig);
    await runDrainer(session, () => {});
    expect(mocks.getConfigMock).toHaveBeenCalledWith("/x");
    expect(mocks.drainMock).toHaveBeenCalledWith({ transcript_path: "/x/rollout.jsonl", cwd: "/x" }, enabledConfig);
  });

  it.each([
    ["tracing is disabled", session, disabledConfig],
    ["it names no rollout", JSON.stringify({ cwd: "/x" }), enabledConfig],
    ["its session can't be read", "{", enabledConfig],
    ["it was given no session", undefined, enabledConfig],
  ])("does nothing when %s", async (_label, given, config) => {
    mocks.getConfigMock.mockResolvedValue(config);
    await expect(runDrainer(given, () => {})).resolves.toBeUndefined();
    expect(mocks.drainMock).not.toHaveBeenCalled();
  });

  it("swallows drain errors: nothing reads a drainer's output or exit code", async () => {
    mocks.getConfigMock.mockResolvedValue(enabledConfig);
    mocks.drainMock.mockRejectedValue(new Error("boom"));
    await expect(runDrainer(session, () => {})).resolves.toBeUndefined();
  });

  it("stops the drainer once its lifetime is up, whatever it is doing", async () => {
    vi.useFakeTimers();
    mocks.getConfigMock.mockResolvedValue(enabledConfig);
    mocks.drainMock.mockReturnValue(new Promise(() => {})); // a run that never finishes
    const exit = vi.fn();

    void runDrainer(session, exit);
    await vi.advanceTimersByTimeAsync(DRAIN_LIFETIME_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
