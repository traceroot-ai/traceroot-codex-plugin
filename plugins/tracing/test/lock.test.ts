import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { dispatch } from "../src/emit.js";
import { buildTracing } from "../src/exporter.js";
import { makeSpanId } from "../src/ids.js";
import { type LockTimings, withSessionLock } from "../src/lock.js";
import { ids, OK } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAST: LockTimings = { waitMs: 2_000, staleMs: 60_000, pollMs: 5 };

let dir: string;
afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });

async function rolloutPath(): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tr-lock-"));
  return path.join(dir, "rollout.jsonl");
}

const lockOf = (rollout: string) => `${rollout}.traceroot.lock`;
const exists = (p: string) => fs.access(p).then(() => true, () => false);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid as number;
}

describe("withSessionLock", () => {
  it("runs a second holder of the same session only after the first finishes", async () => {
    const rollout = await rolloutPath();
    const events: string[] = [];
    const gate = deferred();

    const first = withSessionLock(rollout, async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
    }, FAST);
    await new Promise((r) => setTimeout(r, 20));
    const second = withSessionLock(rollout, async () => { events.push("second:start"); }, FAST);
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual(["first:start"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it("does not hold up another session", async () => {
    const rollout = await rolloutPath();
    const gate = deferred();
    const first = withSessionLock(rollout, () => gate.promise, FAST);
    await new Promise((r) => setTimeout(r, 20));

    await expect(withSessionLock(`${rollout}.other`, async () => "ran", FAST)).resolves.toBe("ran");
    gate.resolve();
    await first;
  });

  it("releases the lock when the work throws, and passes the error on", async () => {
    const rollout = await rolloutPath();
    await expect(withSessionLock(rollout, async () => { throw new Error("boom"); }, FAST)).rejects.toThrow("boom");
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it.each<[string, () => Promise<string>]>([
    ["a holder that has exited", async () => `${await deadPid()} ${Date.now()} x`],
    ["a holder older than the stale limit", async () => `${process.pid} ${Date.now() - 120_000} x`],
    ["unreadable content", async () => "not a lock"],
  ])("takes over a lock left by %s", async (_label, content) => {
    const rollout = await rolloutPath();
    await fs.writeFile(lockOf(rollout), await content());
    const started = Date.now();

    await expect(withSessionLock(rollout, async () => "ran", FAST)).resolves.toBe("ran");
    expect(Date.now() - started).toBeLessThan(FAST.waitMs);
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it("goes ahead after the wait when a live holder keeps the lock, and leaves that lock alone", async () => {
    const rollout = await rolloutPath();
    const held = `${process.pid} ${Date.now()} someone-else`;
    await fs.writeFile(lockOf(rollout), held);
    const started = Date.now();

    await expect(withSessionLock(rollout, async () => "ran", { ...FAST, waitMs: 100 })).resolves.toBe("ran");
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(await fs.readFile(lockOf(rollout), "utf-8")).toBe(held);
  });

  it("goes ahead when the lock file cannot be created", async () => {
    const rollout = path.join(await rolloutPath(), "missing-dir", "rollout.jsonl");
    await expect(withSessionLock(rollout, async () => "ran", FAST)).resolves.toBe("ran");
  });
});

describe("dispatch holds the session lock from reading the rollout to recording what was sent", () => {
  const config: Config = {
    enabled: true, apiKey: "tr-x", hostUrl: "http://127.0.0.1:9", maxChars: 20000, maxRequestBytes: 12 * 1024 * 1024, debug: false, failOnError: true, captureImages: false,
  };
  const ROOT = makeSpanId("turn-1:root");

  /** Exports succeed, but the first export waits for `gate`; every step is logged. */
  class GatedExporter implements SpanExporter {
    constructor(private readonly label: string, private readonly events: string[], private readonly gate?: Promise<void>) {}

    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
      this.events.push(`${this.label}:export ${ids(spans).includes(ROOT) ? "with root" : "without root"}`);
      void (this.gate ?? Promise.resolve()).then(() => {
        this.events.push(`${this.label}:delivered`);
        resultCallback(OK);
      });
    }

    async shutdown(): Promise<void> {}
  }

  it("lets a hook that started later read the rollout only after the earlier hook delivered", async () => {
    const transcript = await rolloutPath();
    await fs.copyFile(path.join(here, "fixtures", "rollout-basic.jsonl"), transcript);
    const events: string[] = [];
    const gate = deferred();
    const deps = (label: string, exporter: SpanExporter) => ({
      buildTracing: (c: Config) => buildTracing(c, exporter),
      // getGit runs right after the rollout is read.
      getGit: async () => { events.push(`${label}:read`); return {}; },
      lockTimings: FAST,
    });

    const first = dispatch({ transcript_path: transcript, hook_event_name: "Stop" }, config,
      deps("first", new GatedExporter("first", events, gate.promise)));
    await new Promise((r) => setTimeout(r, 50));
    const second = dispatch({ transcript_path: transcript, hook_event_name: "SubagentStop" }, config,
      deps("second", new GatedExporter("second", events)));
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual(["first:read", "first:export with root"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first:read", "first:export with root", "first:delivered",
      "second:read", "second:export with root", "second:delivered",
    ]);
    expect(await exists(lockOf(transcript))).toBe(false);
  });
});
