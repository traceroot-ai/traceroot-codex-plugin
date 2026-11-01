import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { dispatch } from "../src/emit.js";
import { buildTracing } from "../src/exporter.js";
import { makeSpanId } from "../src/ids.js";
import { type HandOff, type LockTimings, withSessionLock } from "../src/lock.js";
import { loadEmittedSpanIds } from "../src/sidecar.js";
import { ids, OK, ScriptedExporter } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const T: LockTimings = { waitMs: 2_000, staleMs: 60_000, heartbeatMs: 1_000, rerunBudgetMs: 60_000, pollMs: 5 };

let dir: string;
afterEach(async () => {
  vi.useRealTimers();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

async function rolloutPath(): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tr-lock-"));
  return path.join(dir, "rollout.jsonl");
}

const lockOf = (rollout: string) => `${rollout}.traceroot.lock`;
const breakOf = (rollout: string) => `${lockOf(rollout)}.break`;
const pendingOf = (rollout: string) => `${rollout}.traceroot.pending.d`;
const exists = (p: string) => fs.access(p).then(() => true, () => false);
/** The requests waiting for a run: their turn ends, or NaN for one that names none. */
const requestsOf = async (rollout: string) => {
  const names = await fs.readdir(pendingOf(rollout)).catch(() => []);
  return Promise.all(names.map(async (name) => Number((await fs.readFile(path.join(pendingOf(rollout), name), "utf-8")) || NaN)));
};
const hasRequest = async (rollout: string) => (await requestsOf(rollout)).length > 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Timings whose hook resolves `waiting` once it has found the lock held and starts waiting. */
function waitingTimings(timings: LockTimings, waiting: { resolve: () => void }): LockTimings {
  return { ...timings, sleep: (ms) => { waiting.resolve(); return sleep(ms); } };
}

/** Waits until `check` passes: a barrier on something another task does, not a guess at how long it takes. */
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (const started = Date.now(); !(await check());) {
    if (Date.now() - started > 4_000) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
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
    const started = deferred();
    const gate = deferred();
    const waiting = deferred();

    const first = withSessionLock(rollout, async () => {
      events.push("first:start");
      started.resolve();
      await gate.promise;
      events.push("first:end");
    }, T);
    await started.promise;
    const second = withSessionLock(rollout, async () => { events.push("second:start"); }, waitingTimings(T, waiting));
    await waiting.promise; // the second hook found the lock held
    expect(events).toEqual(["first:start"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it("hands its run to the holder when the wait runs out, and never runs unlocked", async () => {
    const rollout = await rolloutPath();
    const { t, run } = tracker();
    const started = deferred();
    const gate = deferred();
    let holderRuns = 0;
    let waiterRan = false;

    const holder = withSessionLock(rollout, () => run(async () => {
      holderRuns += 1;
      if (holderRuns === 1) { started.resolve(); await gate.promise; }
      return holderRuns;
    }), T);
    await started.promise;
    const arrived = performance.now();
    const waiter = await withSessionLock(rollout, async () => { waiterRan = true; }, { ...T, waitMs: 0 });

    expect(waiter).toBeUndefined();
    expect(waiterRan).toBe(false);
    expect(await hasRequest(rollout)).toBe(true);

    gate.resolve();
    expect(await holder).toBe(2); // ran again for the hook that handed off
    expect(t.max).toBe(1);
    expect(t.starts[1]).toBeGreaterThan(arrived);
    expect(await hasRequest(rollout)).toBe(false);
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it.each([
    ["before", [true, false]],
    ["after", [false, true]],
  ])("tells the run serving a hand-off that a hook ending its turn handed off %s one that doesn't", async (_order, endsTurn) => {
    const rollout = await rolloutPath();
    const started = deferred();
    const gate = deferred();
    const served: HandOff[] = [];

    const holder = withSessionLock(rollout, async (_lock, handOff) => {
      served.push(handOff);
      if (served.length === 1) { started.resolve(); await gate.promise; }
    }, T);
    await started.promise;
    const firstArrived = Date.now();
    for (const ends of endsTurn) {
      expect(await withSessionLock(rollout, async () => {}, { ...T, waitMs: 0 }, ends)).toBeUndefined();
    }
    const lastArrived = Date.now();
    gate.resolve();
    await holder;

    expect(served).toHaveLength(2);
    expect(served[0]).toEqual({});
    expect(served[1]!.turnEndedAt).toBeGreaterThanOrEqual(firstArrived);
    expect(served[1]!.turnEndedAt).toBeLessThanOrEqual(lastArrived);
  });

  // A stress test: the hooks arrive and run for staggered times, and the
  // assertions must hold for whatever interleaving that produces.
  it("under many concurrent hooks never runs two at once, and serves every hook with a run that started after it", async () => {
    const rollout = await rolloutPath();
    const { t, run } = tracker();
    const arrivals: number[] = [];
    const hooks = Array.from({ length: 12 }, (_, i) => (async () => {
      await sleep((i * 37) % 120);
      arrivals.push(performance.now());
      return withSessionLock(rollout, () => run(() => sleep(15 + ((i * 7) % 20))), { ...T, waitMs: 25 }, i % 3 === 0);
    })());

    await Promise.all(hooks);
    expect(t.max).toBe(1);
    for (const at of arrivals) expect(t.starts.some((s) => s >= at)).toBe(true);
    expect(await exists(lockOf(rollout))).toBe(false);
    expect(await exists(breakOf(rollout))).toBe(false);
  });

  it.each(["", "partly written"])("does not take over a fresh lock whose content is %j", async (content) => {
    const rollout = await rolloutPath();
    await fs.writeFile(lockOf(rollout), content);
    let ran = false;

    expect(await withSessionLock(rollout, async () => { ran = true; }, { ...T, waitMs: 0 })).toBeUndefined();
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

    expect(await withSessionLock(rollout, async () => "ran", { ...T, waitMs: 0 })).toBe("ran");
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it.each<[string, (rollout: string) => Promise<void>]>([
    ["a hook that exited", async (r) => fs.writeFile(breakOf(r), `${await deadPid()} x`)],
    ["a live hook past its few seconds", async (r) => {
      await fs.writeFile(breakOf(r), `${process.pid} frozen`);
      const old = new Date(Date.now() - 120_000);
      await fs.utimes(breakOf(r), old, old);
    }],
  ])("takes over a stale lock when the right to remove it was left by %s", async (_label, leave) => {
    const rollout = await rolloutPath();
    await fs.writeFile(lockOf(rollout), `${await deadPid()} x`);
    await leave(rollout);

    expect(await withSessionLock(rollout, async () => "ran", { ...T, waitMs: 0 })).toBe("ran");
    expect(await exists(lockOf(rollout))).toBe(false);
    expect(await exists(breakOf(rollout))).toBe(false);
  });

  it("does not remove a stale lock while a live hook holds the right to remove it", async () => {
    const rollout = await rolloutPath();
    await fs.writeFile(lockOf(rollout), `${await deadPid()} x`);
    await fs.writeFile(breakOf(rollout), `${process.pid} removing`);

    expect(await withSessionLock(rollout, async () => "ran", { ...T, waitMs: 0 })).toBeUndefined();
    expect(await exists(lockOf(rollout))).toBe(true);
    expect(await fs.readFile(breakOf(rollout), "utf-8")).toBe(`${process.pid} removing`);
  });

  it("keeps the lock of a holder that runs past the stale limit, because it keeps touching it", async () => {
    const rollout = await rolloutPath();
    const timings = { ...T, heartbeatMs: 10 };
    const { t, run } = tracker();
    const started = deferred();
    const gate = deferred();

    const holder = withSessionLock(rollout, () => run(async () => { started.resolve(); await gate.promise; }), timings);
    await started.promise;
    // Age the lock as if the holder had run past the stale limit, then wait for its next touch.
    const old = Date.now() - 120_000;
    await fs.utimes(lockOf(rollout), old / 1000, old / 1000);
    await until(async () => (await fs.stat(lockOf(rollout))).mtimeMs > old + 60_000, "the holder to touch its lock");

    expect(await withSessionLock(rollout, () => run(async () => {}), { ...timings, waitMs: 0 })).toBeUndefined();
    gate.resolve();
    await holder;
    expect(t.max).toBe(1);
    expect(t.starts).toHaveLength(2); // the holder ran again for the hook that handed off
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

  it("asks again for the turn end it was serving when its lock is taken over during the run", async () => {
    const rollout = await rolloutPath();
    const started = deferred();
    const gate = deferred();
    const served: HandOff[] = [];

    const holder = withSessionLock(rollout, async (_lock, handOff) => {
      served.push(handOff);
      if (served.length === 1) { started.resolve(); await gate.promise; return; }
      await fs.writeFile(lockOf(rollout), `${process.pid} someone-else`); // taken over while serving the Stop
    }, T);
    await started.promise;
    expect(await withSessionLock(rollout, async () => {}, { ...T, waitMs: 0 }, true)).toBeUndefined();
    gate.resolve();
    await holder;

    expect(served).toHaveLength(2);
    expect(await requestsOf(rollout)).toEqual([served[1]!.turnEndedAt]);
  });

  it("asks again for its own turn end when it is a Stop whose lock is taken over", async () => {
    const rollout = await rolloutPath();
    const arrived = Date.now();

    await withSessionLock(rollout, async () => {
      await fs.writeFile(lockOf(rollout), `${process.pid} someone-else`);
    }, T, true);

    const [request] = await requestsOf(rollout);
    expect(request).toBeGreaterThanOrEqual(arrived);
  });

  it("leaves a waiting request in place when a Stop hands off, and the run claiming both gets the later turn end", async () => {
    const rollout = await rolloutPath();
    const started = deferred();
    const gate = deferred();
    const served: HandOff[] = [];
    const holder = withSessionLock(rollout, async (_lock, handOff) => {
      served.push(handOff);
      if (served.length === 1) { started.resolve(); await gate.promise; }
    }, T);
    await started.promise;
    const later = Date.now() + 60_000;
    await fs.mkdir(pendingOf(rollout));
    await fs.writeFile(path.join(pendingOf(rollout), "waiting"), String(later));

    expect(await withSessionLock(rollout, async () => {}, { ...T, waitMs: 0 }, true)).toBeUndefined();
    expect(await requestsOf(rollout)).toHaveLength(2);
    gate.resolve();
    await holder;
    expect(served.map((handOff) => handOff.turnEndedAt)).toEqual([undefined, later]);
  });

  it("leaves a handed-off run for the next hook once the holder has used its rerun budget", async () => {
    const rollout = await rolloutPath();
    const started = deferred();
    const gate = deferred();
    let holderRuns = 0;

    const holder = withSessionLock(rollout, async () => {
      holderRuns += 1;
      started.resolve();
      await gate.promise;
    }, { ...T, rerunBudgetMs: 0 });
    await started.promise;
    expect(await withSessionLock(rollout, async () => {}, { ...T, waitMs: 0 })).toBeUndefined();
    gate.resolve();
    await holder;

    expect(holderRuns).toBe(1);
    expect(await hasRequest(rollout)).toBe(true);
  });

  it("counts the time it waited for the lock against its rerun budget", async () => {
    const rollout = await rolloutPath();
    vi.useFakeTimers({ toFake: ["Date"] });
    const started = deferred();
    const gate = deferred();
    const first = withSessionLock(rollout, async () => { started.resolve(); await gate.promise; }, T);
    await started.promise;
    let runs = 0;

    // Waits 10 s for the first hook, then runs for 6 s while another hook hands its run to it.
    await withSessionLock(rollout, async () => {
      runs += 1;
      if (runs > 1) return;
      expect(await withSessionLock(rollout, async () => {}, { ...T, waitMs: 0 })).toBeUndefined();
      vi.setSystemTime(Date.now() + 6_000);
    }, {
      ...T, waitMs: 60_000, rerunBudgetMs: 15_000,
      sleep: async () => { vi.setSystemTime(Date.now() + 10_000); gate.resolve(); await first; },
    });

    expect(runs).toBe(1);
    expect(await hasRequest(rollout)).toBe(true); // left for the session's next hook
  });

  it("releases the lock when the run throws, and passes the error on", async () => {
    const rollout = await rolloutPath();
    await expect(withSessionLock(rollout, async () => { throw new Error("boom"); }, T)).rejects.toThrow("boom");
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it("does not hold up another session", async () => {
    const rollout = await rolloutPath();
    const started = deferred();
    const gate = deferred();
    const first = withSessionLock(rollout, async () => { started.resolve(); await gate.promise; }, T);
    await started.promise;

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
  const NEXT_ROOT = makeSpanId("turn-2:root");

  /** Exports succeed; an export waits for `gate` the first time and calls `onExport` when it starts. Every step is logged. */
  class GatedExporter implements SpanExporter {
    private gated = true;

    constructor(
      private readonly label: string, private readonly events: string[], private readonly gate?: Promise<void>,
      private readonly onExport?: () => void,
    ) {}

    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
      this.events.push(`${this.label}:export ${ids(spans).includes(ROOT) ? "with root" : "without root"}`);
      this.onExport?.();
      const wait = this.gated && this.gate ? this.gate : Promise.resolve();
      this.gated = false;
      void wait.then(() => {
        this.events.push(`${this.label}:delivered`);
        resultCallback(OK);
      });
    }

    async shutdown(): Promise<void> {}
  }

  async function transcriptCopy(fixture = "rollout-basic.jsonl"): Promise<string> {
    const transcript = await rolloutPath();
    await fs.copyFile(path.join(here, "fixtures", fixture), transcript);
    return transcript;
  }

  const depsFor = (label: string, events: string[], exporter: SpanExporter, timings: LockTimings) => ({
    // A fresh exporter wrapper per run: each run builds and shuts down its own tracing.
    buildTracing: (c: Config, stillHeld?: () => Promise<boolean>) => buildTracing(c, exporter, stillHeld),
    // getGit runs right after the rollout is read.
    getGit: async () => { events.push(`${label}:read`); return {}; },
    lockTimings: timings,
  });

  it("lets a hook that started later read the rollout only after the earlier hook delivered", async () => {
    const transcript = await transcriptCopy();
    const events: string[] = [];
    const gate = deferred();
    const exporting = deferred();
    const waiting = deferred();

    const first = dispatch({ transcript_path: transcript, hook_event_name: "Stop" }, config,
      depsFor("first", events, new GatedExporter("first", events, gate.promise, exporting.resolve), T));
    await exporting.promise;
    const second = dispatch({ transcript_path: transcript, hook_event_name: "SubagentStop" }, config,
      depsFor("second", events, new GatedExporter("second", events), waitingTimings(T, waiting)));
    await waiting.promise; // the second hook found the lock held
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
    const exporting = deferred();

    const first = dispatch({ transcript_path: transcript, hook_event_name: "Stop" }, config,
      depsFor("first", events, new GatedExporter("first", events, gate.promise, exporting.resolve), T));
    await exporting.promise;
    const second = await dispatch({ transcript_path: transcript, hook_event_name: "SubagentStop" }, config,
      depsFor("second", events, new GatedExporter("second", events), { ...T, waitMs: 0 }));
    expect(second).toEqual({ emitted: 0 });

    gate.resolve();
    await first;
    expect(events).toEqual([
      "first:read", "first:export with root", "first:delivered",
      "first:read", "first:export with root", "first:delivered",
    ]);
    expect(await exists(lockOf(transcript))).toBe(false);
  });

  it("ends the turn for a Stop whose wait ran out: the holder's next run sends the turn's root", async () => {
    const transcript = await transcriptCopy("rollout-inprogress.jsonl");
    const events: string[] = [];
    const gate = deferred();
    const exporting = deferred();

    const first = dispatch({ transcript_path: transcript, hook_event_name: "PostToolUse" }, config,
      depsFor("first", events, new GatedExporter("first", events, gate.promise, exporting.resolve), T));
    await exporting.promise;
    expect(await dispatch({ transcript_path: transcript, hook_event_name: "Stop" }, config,
      depsFor("second", events, new GatedExporter("second", events), { ...T, waitMs: 0 }))).toEqual({ emitted: 0 });

    gate.resolve();
    await first;
    expect(events).toEqual([
      "first:read", "first:export without root", "first:delivered",
      "first:read", "first:export with root", "first:delivered",
    ]);
  });

  it.each([
    ["no newer turn has started", false],
    ["a newer turn has started since", true],
  ])("lets a Stop left for a later hook end its turn only if %s", async (_label, newerTurn) => {
    const transcript = await transcriptCopy("rollout-inprogress.jsonl");
    const events: string[] = [];
    const gate = deferred();
    const exporting = deferred();

    const first = dispatch({ transcript_path: transcript, hook_event_name: "PostToolUse" }, config,
      depsFor("first", events, new GatedExporter("first", events, gate.promise, exporting.resolve), { ...T, rerunBudgetMs: 0 }));
    await exporting.promise;
    await dispatch({ transcript_path: transcript, hook_event_name: "Stop" }, config,
      depsFor("second", events, new GatedExporter("second", events), { ...T, waitMs: 0 }));
    gate.resolve();
    await first;
    expect(await hasRequest(transcript)).toBe(true); // left for the session's next hook

    if (newerTurn) {
      const later = new Date(Date.now() + 60_000).toISOString();
      await fs.appendFile(transcript, [
        { timestamp: later, type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
        { timestamp: later, type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } },
        { timestamp: later, type: "event_msg", payload: { type: "user_message", message: "and the hidden ones?" } },
      ].map((line) => `${JSON.stringify(line)}\n`).join(""));
    }
    const next = new ScriptedExporter();
    await dispatch({ transcript_path: transcript, hook_event_name: "PostToolUse" }, config,
      { buildTracing: (c: Config) => buildTracing(c, next), getGit: async () => ({}), lockTimings: T });

    const sent = ids(next.calls.flat());
    expect(sent).toContain(ROOT);
    expect(sent.includes(NEXT_ROOT)).toBe(false);
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

  it("sends no further request once the hook's lock is taken over during export, and marks only what was sent", async () => {
    const transcript = await transcriptCopy();
    // A request per span; another hook takes the lock over while the first is being sent.
    const exporter = new ScriptedExporter(() => {
      writeFileSync(lockOf(transcript), `${process.pid} someone-else`);
      return OK;
    });
    const deps = {
      buildTracing: (c: Config, stillHeld?: () => Promise<boolean>) => buildTracing(c, exporter, stillHeld),
      getGit: async () => ({}),
      lockTimings: T,
    };

    // The requests held back fail the export, which surfaces from dispatch like any failed export.
    const failure = await dispatch({ transcript_path: transcript, hook_event_name: "Stop" }, { ...config, maxRequestBytes: 1 }, deps)
      .then(() => undefined, (error: unknown) => error);
    expect(String(failure)).toContain("the session lock was taken over");
    expect(exporter.calls).toHaveLength(1);
    expect([...(await loadEmittedSpanIds(transcript))]).toEqual(ids(exporter.calls[0]!));
    expect(await fs.readFile(lockOf(transcript), "utf-8")).toBe(`${process.pid} someone-else`);
    expect(await hasRequest(transcript)).toBe(true); // the rest is sent by a run of the hook holding the lock
  });
});
