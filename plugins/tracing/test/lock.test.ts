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
const T: LockTimings = { waitMs: 2_000, staleMs: 60_000, heartbeatMs: 1_000, rerunBudgetMs: 60_000, pollMs: 5 };

let dir: string;
afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });

async function rolloutPath(): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tr-lock-"));
  return path.join(dir, "rollout.jsonl");
}

const lockOf = (rollout: string) => `${rollout}.traceroot.lock`;
const pendingOf = (rollout: string) => `${rollout}.traceroot.pending`;
const exists = (p: string) => fs.access(p).then(() => true, () => false);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Counts runs in flight and records the most at once. */
function tracker() {
  let active = 0;
  const t = { max: 0, starts: [] as number[] };
  const run = async <R>(body: () => Promise<R>): Promise<R> => {
    active += 1;
    t.max = Math.max(t.max, active);
    t.starts.push(performance.now());
    try { return await body(); } finally { active -= 1; }
  };
  return { t, run };
}

describe("withSessionLock", () => {
  it("runs a second hook of the same session only after the first finishes", async () => {
    const rollout = await rolloutPath();
    const events: string[] = [];
    const gate = deferred();

    const first = withSessionLock(rollout, async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
    }, T);
    await sleep(20);
    const second = withSessionLock(rollout, async () => { events.push("second:start"); }, T);
    await sleep(50);
    expect(events).toEqual(["first:start"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it("hands its run to the holder when the wait runs out, and never runs unlocked", async () => {
    const rollout = await rolloutPath();
    const { t, run } = tracker();
    const gate = deferred();
    let holderRuns = 0;
    let waiterRan = false;

    const holder = withSessionLock(rollout, () => run(async () => {
      holderRuns += 1;
      if (holderRuns === 1) await gate.promise;
      return holderRuns;
    }), T);
    await sleep(20);
    const arrived = performance.now();
    const waiter = await withSessionLock(rollout, async () => { waiterRan = true; }, { ...T, waitMs: 50 });

    expect(waiter).toBeUndefined();
    expect(waiterRan).toBe(false);
    expect(await exists(pendingOf(rollout))).toBe(true);

    gate.resolve();
    expect(await holder).toBe(2); // ran again for the hook that handed off
    expect(t.max).toBe(1);
    expect(t.starts[1]).toBeGreaterThan(arrived);
    expect(await exists(pendingOf(rollout))).toBe(false);
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it("under many concurrent hooks never runs two at once, and serves every hook with a run that started after it", async () => {
    const rollout = await rolloutPath();
    const { t, run } = tracker();
    const arrivals: number[] = [];
    const hooks = Array.from({ length: 12 }, (_, i) => (async () => {
      await sleep((i * 37) % 120);
      arrivals.push(performance.now());
      return withSessionLock(rollout, () => run(() => sleep(15 + ((i * 7) % 20))), { ...T, waitMs: 25 });
    })());

    await Promise.all(hooks);
    expect(t.max).toBe(1);
    for (const at of arrivals) expect(t.starts.some((s) => s >= at)).toBe(true);
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it.each(["", "partly written"])("does not take over a fresh lock whose content is %j", async (content) => {
    const rollout = await rolloutPath();
    await fs.writeFile(lockOf(rollout), content);
    let ran = false;

    expect(await withSessionLock(rollout, async () => { ran = true; }, { ...T, waitMs: 60 })).toBeUndefined();
    expect(ran).toBe(false);
    expect(await fs.readFile(lockOf(rollout), "utf-8")).toBe(content);
  });

  it.each<[string, (rollout: string) => Promise<void>]>([
    ["an exited holder", async (r) => fs.writeFile(lockOf(r), `${await deadPid()} x`)],
    ["unreadable content older than the stale limit", async (r) => {
      await fs.writeFile(lockOf(r), "");
      const old = new Date(Date.now() - 120_000);
      await fs.utimes(lockOf(r), old, old);
    }],
    ["a live holder silent past the stale limit", async (r) => {
      await fs.writeFile(lockOf(r), `${process.pid} frozen`);
      const old = new Date(Date.now() - 120_000);
      await fs.utimes(lockOf(r), old, old);
    }],
  ])("takes over a lock left by %s", async (_label, leave) => {
    const rollout = await rolloutPath();
    await leave(rollout);

    expect(await withSessionLock(rollout, async () => "ran", { ...T, waitMs: 500 })).toBe("ran");
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it("keeps the lock of a holder that runs past the stale limit", async () => {
    const rollout = await rolloutPath();
    const timings = { ...T, staleMs: 120, heartbeatMs: 20 };
    const { t, run } = tracker();

    const holder = withSessionLock(rollout, () => run(() => sleep(400)), timings);
    await sleep(50);
    await withSessionLock(rollout, () => run(async () => {}), { ...timings, waitMs: 1_000 });
    await holder;

    expect(t.max).toBe(1);
  });

  it("tells a holder whose lock was taken over that it no longer holds it, and leaves the new lock", async () => {
    const rollout = await rolloutPath();
    const seen: boolean[] = [];

    await withSessionLock(rollout, async (lock) => {
      seen.push(await lock.held());
      await fs.writeFile(lockOf(rollout), `${process.pid} someone-else`);
      seen.push(await lock.held());
    }, T);

    expect(seen).toEqual([true, false]);
    expect(await fs.readFile(lockOf(rollout), "utf-8")).toBe(`${process.pid} someone-else`);
  });

  it("leaves a handed-off run for the next hook once the holder has used its rerun budget", async () => {
    const rollout = await rolloutPath();
    const gate = deferred();
    let holderRuns = 0;

    const holder = withSessionLock(rollout, async () => { holderRuns += 1; await gate.promise; }, { ...T, rerunBudgetMs: 0 });
    await sleep(20);
    expect(await withSessionLock(rollout, async () => {}, { ...T, waitMs: 30 })).toBeUndefined();
    gate.resolve();
    await holder;

    expect(holderRuns).toBe(1);
    expect(await exists(pendingOf(rollout))).toBe(true);
  });

  it("releases the lock when the run throws, and passes the error on", async () => {
    const rollout = await rolloutPath();
    await expect(withSessionLock(rollout, async () => { throw new Error("boom"); }, T)).rejects.toThrow("boom");
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it("does not hold up another session", async () => {
    const rollout = await rolloutPath();
    const gate = deferred();
    const first = withSessionLock(rollout, () => gate.promise, T);
    await sleep(20);

    await expect(withSessionLock(`${rollout}.other`, async () => "ran", T)).resolves.toBe("ran");
    gate.resolve();
    await first;
  });

  it("runs without a lock when the lock file cannot be created", async () => {
    const rollout = path.join(await rolloutPath(), "missing-dir", "rollout.jsonl");
    await expect(withSessionLock(rollout, async (lock) => lock.held(), T)).resolves.toBe(true);
  });
});

describe("dispatch under the session lock", () => {
  const config: Config = {
    enabled: true, apiKey: "tr-x", hostUrl: "http://127.0.0.1:9", maxChars: 20000, maxRequestBytes: 12 * 1024 * 1024, debug: false, failOnError: true, captureImages: false,
  };
  const ROOT = makeSpanId("turn-1:root");

  /** Exports succeed; an export waits for `gate` the first time. Every step is logged. */
  class GatedExporter implements SpanExporter {
    private gated = true;

    constructor(private readonly label: string, private readonly events: string[], private readonly gate?: Promise<void>) {}

    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
      this.events.push(`${this.label}:export ${ids(spans).includes(ROOT) ? "with root" : "without root"}`);
      const wait = this.gated && this.gate ? this.gate : Promise.resolve();
      this.gated = false;
      void wait.then(() => {
        this.events.push(`${this.label}:delivered`);
        resultCallback(OK);
      });
    }

    async shutdown(): Promise<void> {}
  }

  async function transcriptCopy(): Promise<string> {
    const transcript = await rolloutPath();
    await fs.copyFile(path.join(here, "fixtures", "rollout-basic.jsonl"), transcript);
    return transcript;
  }

  const depsFor = (label: string, events: string[], exporter: SpanExporter, timings: LockTimings) => ({
    // A fresh exporter wrapper per run: each run builds and shuts down its own tracing.
    buildTracing: (c: Config) => buildTracing(c, exporter),
    // getGit runs right after the rollout is read.
    getGit: async () => { events.push(`${label}:read`); return {}; },
    lockTimings: timings,
  });

  it("lets a hook that started later read the rollout only after the earlier hook delivered", async () => {
    const transcript = await transcriptCopy();
    const events: string[] = [];
    const gate = deferred();

    const first = dispatch({ transcript_path: transcript, hook_event_name: "Stop" }, config,
      depsFor("first", events, new GatedExporter("first", events, gate.promise), T));
    await sleep(50);
    const second = dispatch({ transcript_path: transcript, hook_event_name: "SubagentStop" }, config,
      depsFor("second", events, new GatedExporter("second", events), T));
    await sleep(50);
    expect(events).toEqual(["first:read", "first:export with root"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first:read", "first:export with root", "first:delivered",
      "second:read", "second:export with root", "second:delivered",
    ]);
  });

  it("sends nothing from a hook whose wait ran out; the earlier hook reads and sends again instead", async () => {
    const transcript = await transcriptCopy();
    const events: string[] = [];
    const gate = deferred();

    const first = dispatch({ transcript_path: transcript, hook_event_name: "Stop" }, config,
      depsFor("first", events, new GatedExporter("first", events, gate.promise), T));
    await sleep(50);
    const second = await dispatch({ transcript_path: transcript, hook_event_name: "SubagentStop" }, config,
      depsFor("second", events, new GatedExporter("second", events), { ...T, waitMs: 50 }));
    expect(second).toEqual({ emitted: 0 });

    gate.resolve();
    await first;
    expect(events).toEqual([
      "first:read", "first:export with root", "first:delivered",
      "first:read", "first:export with root", "first:delivered",
    ]);
    expect(await exists(lockOf(transcript))).toBe(false);
  });

  it("sends nothing once the hook's lock was taken over before it exported", async () => {
    const transcript = await transcriptCopy();
    const events: string[] = [];
    const deps = {
      ...depsFor("first", events, new GatedExporter("first", events), T),
      getGit: async () => {
        await fs.writeFile(lockOf(transcript), `${process.pid} someone-else`);
        return {};
      },
    };

    expect(await dispatch({ transcript_path: transcript, hook_event_name: "Stop" }, config, deps)).toEqual({ emitted: 0 });
    expect(events).toEqual([]);
  });
});
