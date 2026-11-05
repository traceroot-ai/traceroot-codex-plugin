import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { dispatch, drain } from "../src/emit.js";
import { buildTracing } from "../src/exporter.js";
import { makeSpanId } from "../src/ids.js";
import { drainSession, type HandOff, type LockTimings, withSessionLock } from "../src/lock.js";
import { loadEmittedSpanIds } from "../src/sidecar.js";
import type { HookInput } from "../src/types.js";
import { deferred, failed, ids, OK, rolloutPath, ScriptedExporter } from "./helpers.js";
import { drainerOf, exists, leaveLock, lockOf, ownersOf, pendingOf } from "./lock-helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const T: LockTimings = { waitMs: 2_000, staleMs: 60_000, heartbeatMs: 1_000, rerunBudgetMs: 60_000, pollMs: 5 };

afterEach(() => {
  vi.useRealTimers();
});

/** Another hook takes the lock over: the current owner's entry is gone and `owner` is in its place. */
function takeOver(rollout: string, owner: string): void {
  mkdirSync(lockOf(rollout), { recursive: true });
  for (const name of readdirSync(lockOf(rollout))) rmSync(path.join(lockOf(rollout), name), { force: true });
  writeFileSync(path.join(lockOf(rollout), owner), owner);
}
/** The requests waiting for a run: their turn ends, or NaN for one that names none. */
const requestsOf = async (rollout: string) => {
  const names = await fs.readdir(pendingOf(rollout)).catch(() => []);
  return Promise.all(names.map(async (name) => Number((await fs.readFile(path.join(pendingOf(rollout), name), "utf-8")) || NaN)));
};
const hasRequest = async (rollout: string) => (await requestsOf(rollout)).length > 0;
/** Leaves a request for a run, as a hook that handed off does; a Stop's names when it arrived. */
async function leaveRequest(rollout: string, turnEndedAt?: number): Promise<void> {
  await fs.mkdir(pendingOf(rollout), { recursive: true });
  await fs.writeFile(path.join(pendingOf(rollout), randomUUID()), turnEndedAt === undefined ? "" : String(turnEndedAt));
}
/** Leaves the drainer directory naming `owner`, as a drainer serving the session does. */
async function leaveDrainer(rollout: string, owner: string): Promise<void> {
  await fs.mkdir(drainerOf(rollout));
  await fs.writeFile(path.join(drainerOf(rollout), owner), owner);
}
/** Nothing is left next to the rollout but an empty request directory. */
async function settled(rollout: string): Promise<void> {
  expect(await requestsOf(rollout)).toEqual([]);
  expect(await exists(lockOf(rollout))).toBe(false);
  expect(await exists(drainerOf(rollout))).toBe(false);
}
/** What a hook or drainer killed now leaves: its entries in `dirs` name a process that is gone. */
function die(pid: number, ...dirs: string[]): void {
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      rmSync(path.join(dir, name), { force: true });
      writeFileSync(path.join(dir, `${pid}.${name.split(".")[1]}`), "");
    }
  }
}
const never = new Promise<void>(() => {});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    }, { timings: T });
    await started.promise;
    const second = withSessionLock(rollout, async () => { events.push("second:start"); }, { timings: waitingTimings(T, waiting) });
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
    }), { timings: T });
    await started.promise;
    const arrived = performance.now();
    const waiter = await withSessionLock(rollout, async () => { waiterRan = true; }, { timings: { ...T, waitMs: 0 } });

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
    }, { timings: T });
    await started.promise;
    const firstArrived = Date.now();
    for (const ends of endsTurn) {
      expect(await withSessionLock(rollout, async () => {}, { timings: { ...T, waitMs: 0 }, endsTurn: ends })).toBeUndefined();
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
      return withSessionLock(rollout, () => run(() => sleep(15 + ((i * 7) % 20))), {
        timings: { ...T, waitMs: 25 }, endsTurn: i % 3 === 0,
      });
    })());

    await Promise.all(hooks);
    expect(t.max).toBe(1);
    for (const at of arrivals) expect(t.starts.some((s) => s >= at)).toBe(true);
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it.each([
    ["names no process", "partly-written"],
    ["names a live process", `${process.pid}.other`],
  ])("does not take over a fresh lock whose owner %s", async (_label, owner) => {
    const rollout = await rolloutPath();
    await leaveLock(rollout, owner);
    let ran = false;

    expect(await withSessionLock(rollout, async () => { ran = true; }, { timings: { ...T, waitMs: 0 } })).toBeUndefined();
    expect(ran).toBe(false);
    expect(await ownersOf(rollout)).toEqual([owner]);
  });

  it.each<[string, (rollout: string) => Promise<void>]>([
    ["an exited holder", async (r) => leaveLock(r, `${await deadPid()}.x`)],
    ["an owner naming no process, older than the stale limit", async (r) => leaveLock(r, "partly-written", 120_000)],
    ["a live holder silent past the stale limit", async (r) => leaveLock(r, `${process.pid}.frozen`, 120_000)],
    ["a hook that died while releasing it, emptied", async (r) => { await fs.mkdir(lockOf(r)); }],
  ])("takes over a lock left by %s", async (_label, leave) => {
    const rollout = await rolloutPath();
    await leave(rollout);

    expect(await withSessionLock(rollout, async () => "ran", { timings: { ...T, waitMs: 0 } })).toBe("ran");
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it("keeps the lock of a holder that runs past the stale limit, because it keeps touching it", async () => {
    const rollout = await rolloutPath();
    const timings = { ...T, heartbeatMs: 10 };
    const { t, run } = tracker();
    const started = deferred();
    const gate = deferred();

    const holder = withSessionLock(rollout, () => run(async () => { started.resolve(); await gate.promise; }), { timings });
    await started.promise;
    // Age the lock as if the holder had run past the stale limit, then wait for its next touch.
    const [owner] = await ownersOf(rollout);
    const entry = path.join(lockOf(rollout), owner!);
    const old = Date.now() - 120_000;
    await fs.utimes(entry, old / 1000, old / 1000);
    await until(async () => (await fs.stat(entry)).mtimeMs > old + 60_000, "the holder to touch its lock");

    expect(await withSessionLock(rollout, () => run(async () => {}), { timings: { ...timings, waitMs: 0 } })).toBeUndefined();
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
      takeOver(rollout, `${process.pid}.someone-else`);
      seen.push(await lock.held());
    }, { timings: T });

    expect(seen).toEqual([true, false]);
    expect(await ownersOf(rollout)).toEqual([`${process.pid}.someone-else`]);
  });

  it("asks again for the turn end it was serving when its lock is taken over during the run", async () => {
    const rollout = await rolloutPath();
    const started = deferred();
    const gate = deferred();
    const served: HandOff[] = [];

    const holder = withSessionLock(rollout, async (_lock, handOff) => {
      served.push(handOff);
      if (served.length === 1) { started.resolve(); await gate.promise; return; }
      takeOver(rollout, `${process.pid}.someone-else`); // taken over while serving the Stop
    }, { timings: T });
    await started.promise;
    expect(await withSessionLock(rollout, async () => {}, { timings: { ...T, waitMs: 0 }, endsTurn: true })).toBeUndefined();
    gate.resolve();
    await holder;

    expect(served).toHaveLength(2);
    expect(await requestsOf(rollout)).toEqual([served[1]!.turnEndedAt]);
  });

  it("asks again for its own turn end when it is a Stop whose lock is taken over", async () => {
    const rollout = await rolloutPath();
    const arrived = Date.now();

    await withSessionLock(rollout, async () => {
      takeOver(rollout, `${process.pid}.someone-else`);
    }, { timings: T, endsTurn: true });

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
    }, { timings: T });
    await started.promise;
    const later = Date.now() + 60_000;
    await fs.mkdir(pendingOf(rollout));
    await fs.writeFile(path.join(pendingOf(rollout), "waiting"), String(later));

    expect(await withSessionLock(rollout, async () => {}, { timings: { ...T, waitMs: 0 }, endsTurn: true })).toBeUndefined();
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
    }, { timings: { ...T, rerunBudgetMs: 0 } });
    await started.promise;
    expect(await withSessionLock(rollout, async () => {}, { timings: { ...T, waitMs: 0 } })).toBeUndefined();
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
    const first = withSessionLock(rollout, async () => { started.resolve(); await gate.promise; }, { timings: T });
    await started.promise;
    let runs = 0;

    // Waits 10 s for the first hook, then runs for 6 s while another hook hands its run to it.
    await withSessionLock(rollout, async () => {
      runs += 1;
      if (runs > 1) return;
      expect(await withSessionLock(rollout, async () => {}, { timings: { ...T, waitMs: 0 } })).toBeUndefined();
      vi.setSystemTime(Date.now() + 6_000);
    }, {
      timings: {
        ...T, waitMs: 60_000, rerunBudgetMs: 15_000,
        sleep: async () => { vi.setSystemTime(Date.now() + 10_000); gate.resolve(); await first; },
      },
    });

    expect(runs).toBe(1);
    expect(await hasRequest(rollout)).toBe(true); // left for the session's next hook
  });

  it("releases the lock when the run throws, and passes the error on", async () => {
    const rollout = await rolloutPath();
    await expect(withSessionLock(rollout, async () => { throw new Error("boom"); }, { timings: T })).rejects.toThrow("boom");
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it("keeps the requests it claimed when its run fails, and leaves them to a drainer", async () => {
    const rollout = await rolloutPath();
    await leaveRequest(rollout, 1234);
    let starts = 0;

    await expect(withSessionLock(rollout, async () => { throw new Error("export failed"); }, {
      timings: T, startDrainer: () => { starts += 1; },
    })).rejects.toThrow("export failed");
    expect(await requestsOf(rollout)).toEqual([1234]);
    expect(starts).toBe(1);
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it("does not hold up another session", async () => {
    const rollout = await rolloutPath();
    const started = deferred();
    const gate = deferred();
    const first = withSessionLock(rollout, async () => { started.resolve(); await gate.promise; }, { timings: T });
    await started.promise;

    await expect(withSessionLock(`${rollout}.other`, async () => "ran", { timings: T })).resolves.toBe("ran");
    gate.resolve();
    await first;
  });

  it("runs without a lock when the lock file cannot be created", async () => {
    const rollout = path.join(await rolloutPath(), "missing-dir", "rollout.jsonl");
    await expect(withSessionLock(rollout, async (lock) => lock.held(), { timings: T })).resolves.toBe(true);
  });
});

describe("drainers", () => {
  it("are started by a hook that hands off, and not by a holder that served it", async () => {
    const rollout = await rolloutPath();
    const started = deferred();
    const gate = deferred();
    let starts = 0;
    const startDrainer = () => { starts += 1; };

    const holder = withSessionLock(rollout, async () => { started.resolve(); await gate.promise; }, { timings: T, startDrainer });
    await started.promise;
    expect(await withSessionLock(rollout, async () => {}, { timings: { ...T, waitMs: 0 }, endsTurn: true, startDrainer })).toBeUndefined();
    expect(starts).toBe(1);
    gate.resolve();
    await holder;
    expect(starts).toBe(1);
    await settled(rollout);
  });

  it.each<[string, ((rollout: string) => Promise<void>) | undefined, number]>([
    ["no drainer is serving the session", undefined, 1],
    ["the drainer that was serving it died", async (r) => leaveDrainer(r, `${await deadPid()}.x`), 1],
    ["a drainer is serving it", async (r) => leaveDrainer(r, `${process.pid}.x`), 0],
  ])("are started by a holder that exits past its budget with a run left when %s", async (_label, before, starts) => {
    const rollout = await rolloutPath();
    await before?.(rollout);
    let started = 0;

    await withSessionLock(rollout, () => leaveRequest(rollout), {
      timings: { ...T, rerunBudgetMs: 0 }, startDrainer: () => { started += 1; },
    });
    expect(started).toBe(starts);
    expect(await hasRequest(rollout)).toBe(true);
  });

  it("serve the Stop a holder past its budget left, once the holder lets go", async () => {
    const rollout = await rolloutPath();
    const { t, run } = tracker();
    const started = deferred();
    const gate = deferred();
    const drainers: Promise<void>[] = [];
    const served: HandOff[] = [];
    const drainerWaiting = deferred();
    const startDrainer = () => {
      drainers.push(drainSession(rollout, (_lock, handOff) => run(async () => { served.push(handOff); }),
        { timings: waitingTimings(T, drainerWaiting) }));
    };

    const holder = withSessionLock(rollout, () => run(async () => { started.resolve(); await gate.promise; }),
      { timings: { ...T, rerunBudgetMs: 0 }, startDrainer });
    await started.promise;
    const arrived = Date.now();
    expect(await withSessionLock(rollout, async () => {}, { timings: { ...T, waitMs: 0 }, endsTurn: true, startDrainer })).toBeUndefined();
    // The drainer holds the drainer directory and waits for the lock before the holder lets go.
    await drainerWaiting.promise;
    gate.resolve();
    await holder;
    await Promise.all(drainers);

    expect(drainers).toHaveLength(1); // the holder found it serving the session
    expect(served).toHaveLength(1);
    expect(served[0]!.turnEndedAt).toBeGreaterThanOrEqual(arrived);
    expect(t.max).toBe(1);
    await settled(rollout);
  });

  it("do not run when the holder served the hook they were started for", async () => {
    const rollout = await rolloutPath();
    const started = deferred();
    const gate = deferred();
    const runs: string[] = [];
    const drainers: Promise<void>[] = [];

    const holder = withSessionLock(rollout, async () => {
      runs.push("holder");
      if (runs.length === 1) { started.resolve(); await gate.promise; }
    }, { timings: T });
    await started.promise;
    await withSessionLock(rollout, async () => {}, {
      timings: { ...T, waitMs: 0 },
      endsTurn: true,
      startDrainer: () => {
        drainers.push(drainSession(rollout, async () => { runs.push("drainer"); }, { timings: T }));
      },
    });
    gate.resolve();
    await holder;
    await Promise.all(drainers);

    expect(drainers).toHaveLength(1);
    expect(runs).toEqual(["holder", "holder"]);
    await settled(rollout);
  });

  it("serve a Stop the holder claimed and was killed while running for", async () => {
    const rollout = await rolloutPath();
    const started = deferred();
    const gate = deferred();
    const claimed = deferred();
    const drainers: Promise<void>[] = [];
    const served: HandOff[] = [];
    let holderRuns = 0;
    const killed = await deadPid();

    void withSessionLock(rollout, async () => {
      holderRuns += 1;
      if (holderRuns === 1) { started.resolve(); await gate.promise; return; }
      die(killed, lockOf(rollout)); // killed while running for the Stop it claimed
      claimed.resolve();
      await never;
    }, { timings: T });
    await started.promise;
    const arrived = Date.now();
    await withSessionLock(rollout, async () => {}, {
      timings: { ...T, waitMs: 0 },
      endsTurn: true,
      startDrainer: () => {
        drainers.push(drainSession(rollout, async (_lock, handOff) => { served.push(handOff); }, { timings: T }));
      },
    });
    gate.resolve();
    await claimed.promise;
    await Promise.all(drainers);

    expect(served).toHaveLength(1);
    expect(served[0]!.turnEndedAt).toBeGreaterThanOrEqual(arrived);
    await settled(rollout);
  });

  it("take over from a drainer that died, and serve what it was serving", async () => {
    const rollout = await rolloutPath();
    await leaveRequest(rollout, 1234);
    const running = deferred();
    const killed = await deadPid();
    void drainSession(rollout, async () => {
      die(killed, lockOf(rollout), drainerOf(rollout));
      running.resolve();
      await never;
    }, { timings: T });
    await running.promise; // it died in its run, holding the lock and the drainer directory
    const served: HandOff[] = [];

    await drainSession(rollout, async (_lock, handOff) => { served.push(handOff); }, { timings: T });
    expect(served).toEqual([{ turnEndedAt: 1234 }]);
    await settled(rollout);
  });

  it("let only one of them serve a session; another exits at once", async () => {
    const rollout = await rolloutPath();
    await leaveLock(rollout, `${process.pid}.holder`);
    await leaveRequest(rollout, 1234);
    const served: HandOff[] = [];
    const run = async (_lock: unknown, handOff: HandOff) => { served.push(handOff); };
    const waiting = deferred();

    const first = drainSession(rollout, run, { timings: waitingTimings(T, waiting) });
    await waiting.promise; // it holds the drainer directory and waits for the lock
    await drainSession(rollout, run, { timings: { ...T, sleep: async () => { throw new Error("waited for the lock"); } } });
    expect(served).toEqual([]);
    await fs.rm(lockOf(rollout), { recursive: true }); // the holder lets go without running for it
    await first;

    expect(served).toEqual([{ turnEndedAt: 1234 }]);
    await settled(rollout);
  });

  it("neither run, hand off nor keep trying past their budget while the lock stays held", async () => {
    const rollout = await rolloutPath();
    await leaveLock(rollout, `${process.pid}.holder`);
    await leaveRequest(rollout);
    let ran = false;

    await drainSession(rollout, async () => { ran = true; }, { timings: { ...T, waitMs: 20, rerunBudgetMs: 50 } });
    expect(ran).toBe(false);
    expect(await requestsOf(rollout)).toHaveLength(1);
    expect(await exists(drainerOf(rollout))).toBe(false);
  });

  it("keep a handed-off Stop whose run failed, and serve it on a later try", async () => {
    const rollout = await rolloutPath();
    await leaveRequest(rollout, 1234);
    const served: HandOff[] = [];
    let tries = 0;

    await drainSession(rollout, async (_lock, handOff) => {
      if (++tries === 1) throw new Error("export failed");
      served.push(handOff);
    }, { timings: { ...T, retryMs: 1 } });
    expect(tries).toBe(2);
    expect(served).toEqual([{ turnEndedAt: 1234 }]);
    await settled(rollout);
  });

  it("leave a request whose runs keep failing for a later hook once their budget is spent, waiting longer between tries", async () => {
    const rollout = await rolloutPath();
    await leaveRequest(rollout, 1234);
    vi.useFakeTimers({ toFake: ["Date"] });
    const waits: number[] = [];
    let tries = 0;
    let starts = 0;

    await drainSession(rollout, async () => {
      tries += 1;
      throw new Error("export failed");
    }, {
      timings: {
        ...T, rerunBudgetMs: 30_000, retryMs: 1_000,
        sleep: async (ms) => { waits.push(ms); vi.setSystemTime(Date.now() + ms); },
      },
      startDrainer: () => { starts += 1; },
    });

    expect(waits.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30_000);
    expect(tries).toBe(waits.length);
    expect(await requestsOf(rollout)).toEqual([1234]);
    expect(starts).toBe(0); // no other drainer for requests it already tried
    expect(await exists(drainerOf(rollout))).toBe(false);
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it("start another drainer for a Stop that handed off during their last run", async () => {
    const rollout = await rolloutPath();
    await leaveRequest(rollout);
    const served: HandOff[] = [];
    const drainers: Promise<void>[] = [];
    const run = async (_lock: unknown, handOff: HandOff) => { served.push(handOff); };
    const startDrainer = () => { drainers.push(drainSession(rollout, run, { timings: T })); };
    let arrived = 0;

    // The drainer's run outlasts its budget, and the turn's last Stop hands off to
    // it meanwhile: the Stop finds the drainer serving and starts none.
    await drainSession(rollout, async (lock, handOff) => {
      await run(lock, handOff);
      await sleep(60);
      arrived = Date.now();
      expect(await withSessionLock(rollout, async () => {}, {
        timings: { ...T, waitMs: 0 }, endsTurn: true, startDrainer,
      })).toBeUndefined();
      expect(drainers).toHaveLength(0);
    }, { timings: { ...T, rerunBudgetMs: 50 }, startDrainer });
    await Promise.all(drainers);

    expect(drainers).toHaveLength(1);
    expect(served).toHaveLength(2);
    expect(served[1]!.turnEndedAt).toBeGreaterThanOrEqual(arrived);
    await settled(rollout);
  });

  it("exit at once when no run is waiting", async () => {
    const rollout = await rolloutPath();
    let ran = false;

    await drainSession(rollout, async () => { ran = true; }, { timings: { ...T, sleep: async () => { throw new Error("waited"); } } });
    expect(ran).toBe(false);
    expect(await exists(drainerOf(rollout))).toBe(false);
    expect(await exists(lockOf(rollout))).toBe(false);
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

  /** Passes spans to `inner`, adding the ids of those it accepted to `accepted`. */
  const recording = (inner: SpanExporter, accepted: Set<string>): SpanExporter => ({
    export: (spans, resultCallback) => inner.export(spans, (result) => {
      if (result.code === ExportResultCode.SUCCESS) for (const id of ids(spans)) accepted.add(id);
      resultCallback(result);
    }),
    shutdown: () => inner.shutdown(),
  });

  const depsFor = (label: string, events: string[], exporter: SpanExporter, timings: LockTimings) => ({
    // A fresh exporter wrapper per run: each run builds and shuts down its own tracing.
    buildTracing: (c: Config, stillHeld?: () => Promise<boolean>) => buildTracing(c, exporter, stillHeld),
    // getGit runs right after the rollout is read.
    getGit: async () => { events.push(`${label}:read`); return {}; },
    lockTimings: timings,
    drainTimings: timings,
    startDrainer: () => {},
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

  it("sends the rest of the turn for its last Stop with no later hook, when the holder runs past its budget", async () => {
    const transcript = await transcriptCopy("rollout-inprogress.jsonl");
    const events: string[] = [];
    const gate = deferred();
    const exporting = deferred();
    const drainers: Promise<void>[] = [];
    const drainerWaiting = deferred();
    // What a hook starts runs on its own, in the drainer the real hook would spawn.
    const startDrainer = (hook: HookInput) => {
      events.push("drainer:started");
      drainers.push(drain(hook, config,
        depsFor("drainer", events, new GatedExporter("drainer", events), waitingTimings(T, drainerWaiting))));
    };

    // The holder's export is slow: by the time it is delivered, the holder's rerun budget is spent.
    const holder = dispatch({ transcript_path: transcript, hook_event_name: "PostToolUse" }, config,
      { ...depsFor("holder", events, new GatedExporter("holder", events, gate.promise, exporting.resolve), { ...T, rerunBudgetMs: 0 }), startDrainer });
    await exporting.promise;
    // The turn's last Stop hands off and exits. No hook runs after it.
    expect(await dispatch({ transcript_path: transcript, hook_event_name: "Stop", cwd: path.dirname(transcript) }, config,
      { ...depsFor("stop", events, new GatedExporter("stop", events), { ...T, waitMs: 0 }), startDrainer })).toEqual({ emitted: 0 });
    // The drainer holds the drainer directory and waits for the lock before the holder lets go.
    await drainerWaiting.promise;
    gate.resolve();
    await holder;
    await Promise.all(drainers);

    expect(events).toEqual([
      "holder:read", "holder:export without root", "drainer:started", "holder:delivered",
      "drainer:read", "drainer:export with root", "drainer:delivered",
    ]);
    expect(await requestsOf(transcript)).toEqual([]);
    expect(await exists(lockOf(transcript))).toBe(false);
    expect(await exists(`${transcript}.traceroot.drainer.d`)).toBe(false);
  });

  it("sends the rest of the turn for its last Stop with no later hook, when the drainer's first export fails", async () => {
    const transcript = await transcriptCopy("rollout-inprogress.jsonl");
    const events: string[] = [];
    const gate = deferred();
    const exporting = deferred();
    const accepted = new Set<string>();
    const drainers: Promise<void>[] = [];
    const drainerWaiting = deferred();
    // The collector rejects the drainer's first request, then recovers.
    let drainerCalls = 0;
    const collector = new ScriptedExporter(() => (++drainerCalls === 1 ? failed("Service Unavailable") : OK));
    const startDrainer = (hook: HookInput) => {
      drainers.push(drain(hook, config, {
        ...depsFor("drainer", events, recording(collector, accepted), waitingTimings({ ...T, retryMs: 1 }, drainerWaiting)),
        startDrainer: () => { throw new Error("a drainer started another"); },
      }));
    };

    const holder = dispatch({ transcript_path: transcript, hook_event_name: "PostToolUse" }, config, {
      ...depsFor("holder", events, recording(new GatedExporter("holder", events, gate.promise, exporting.resolve), accepted),
        { ...T, rerunBudgetMs: 0 }),
      startDrainer,
    });
    await exporting.promise;
    // The turn's last Stop hands off and exits. No hook runs after it.
    expect(await dispatch({ transcript_path: transcript, hook_event_name: "Stop", cwd: path.dirname(transcript) }, config,
      { ...depsFor("stop", events, new GatedExporter("stop", events), { ...T, waitMs: 0 }), startDrainer })).toEqual({ emitted: 0 });
    // The drainer holds the drainer directory and waits for the lock before the holder lets go.
    await drainerWaiting.promise;
    gate.resolve();
    await holder;
    await Promise.all(drainers);

    // What a single Stop over the whole rollout sends.
    const reference = new ScriptedExporter();
    const referenceRollout = path.join(path.dirname(transcript), "reference.jsonl");
    await fs.copyFile(path.join(here, "fixtures", "rollout-inprogress.jsonl"), referenceRollout);
    await dispatch({ transcript_path: referenceRollout, hook_event_name: "Stop" }, config,
      { buildTracing: (c: Config) => buildTracing(c, reference), getGit: async () => ({}), lockTimings: T });
    expect(drainers).toHaveLength(1);
    expect(collector.calls).toHaveLength(2);
    expect(ids(collector.calls[0]!)).toContain(ROOT);
    expect([...accepted].sort()).toEqual([...new Set(ids(reference.calls.flat()))].sort());
    expect(await requestsOf(transcript)).toEqual([]);
    expect(await exists(lockOf(transcript))).toBe(false);
    expect(await exists(`${transcript}.traceroot.drainer.d`)).toBe(false);
  });

  it("does not end a newer turn when a Stop holding the lock runs again after that turn started", async () => {
    const transcript = await transcriptCopy("rollout-inprogress.jsonl");
    const exporter = new ScriptedExporter();
    const reading = deferred();
    const gate = deferred();
    let reads = 0;
    const deps = {
      buildTracing: (c: Config, stillHeld?: () => Promise<boolean>) => buildTracing(c, exporter, stillHeld),
      // The Stop's first run waits right after reading the rollout.
      getGit: async () => {
        if (++reads === 1) { reading.resolve(); await gate.promise; }
        return {};
      },
      lockTimings: T,
      startDrainer: () => {},
    };

    const stop = dispatch({ transcript_path: transcript, hook_event_name: "Stop" }, config, deps);
    await reading.promise;
    // Meanwhile the next turn starts, and one of its hooks hands its run to the Stop.
    const later = new Date(Date.now() + 60_000).toISOString();
    await fs.appendFile(transcript, [
      { timestamp: later, type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
      { timestamp: later, type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } },
      { timestamp: later, type: "event_msg", payload: { type: "user_message", message: "and the hidden ones?" } },
    ].map((line) => `${JSON.stringify(line)}\n`).join(""));
    expect(await dispatch({ transcript_path: transcript, hook_event_name: "PostToolUse" }, config,
      { ...deps, lockTimings: { ...T, waitMs: 0 } })).toEqual({ emitted: 0 });
    gate.resolve();
    await stop;

    expect(reads).toBe(2); // the Stop ran again for the hook that handed off
    const sent = ids(exporter.calls.flat());
    expect(sent).toContain(ROOT);
    expect(sent.includes(NEXT_ROOT)).toBe(false);
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
        takeOver(transcript, `${process.pid}.someone-else`);
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
      takeOver(transcript, `${process.pid}.someone-else`);
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
    expect(await ownersOf(transcript)).toEqual([`${process.pid}.someone-else`]);
    expect(await hasRequest(transcript)).toBe(true); // the rest is sent by a run of the hook holding the lock
  });
});
