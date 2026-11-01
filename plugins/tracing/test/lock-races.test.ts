import { AsyncLocalStorage } from "node:async_hooks";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HandOff, type LockTimings, type SessionLock, withSessionLock } from "../src/lock.js";
import { setDebug } from "../src/util.js";

type Op =
  | "open" | "stat" | "lstat" | "readFile" | "writeFile" | "link" | "rename" | "rm" | "mkdir" | "rmdir" | "readdir"
  | "utimes";
type Step = (op: Op, args: unknown[]) => Promise<void> | void;

// Steps a test runs right before or right after one of the lock's file
// operations, to put another hook's action at an exact point between two of them.
const steps = vi.hoisted(() => ({ before: undefined as Step | undefined, after: undefined as Step | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrap = <A extends unknown[], R>(op: Op, fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    await steps.before?.(op, args);
    const result = await fn(...args);
    await steps.after?.(op, args);
    return result;
  };
  return {
    ...actual,
    open: wrap("open", actual.open),
    stat: wrap("stat", actual.stat),
    lstat: wrap("lstat", actual.lstat),
    readFile: wrap("readFile", actual.readFile),
    writeFile: wrap("writeFile", actual.writeFile),
    link: wrap("link", actual.link),
    rename: wrap("rename", actual.rename),
    rm: wrap("rm", actual.rm),
    mkdir: wrap("mkdir", actual.mkdir),
    rmdir: wrap("rmdir", actual.rmdir),
    readdir: wrap("readdir", actual.readdir),
    utimes: wrap("utimes", actual.utimes),
  };
});

const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const T: LockTimings = { waitMs: 0, staleMs: 60_000, heartbeatMs: 1_000, rerunBudgetMs: 60_000, pollMs: 5 };

let dir: string;
afterEach(async () => {
  steps.before = undefined;
  steps.after = undefined;
  setDebug(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (dir) await real.rm(dir, { recursive: true, force: true });
});

async function rolloutPath(): Promise<string> {
  dir = await real.mkdtemp(path.join(os.tmpdir(), "tr-lock-race-"));
  return path.join(dir, "rollout.jsonl");
}

const lockOf = (rollout: string) => `${rollout}.traceroot.lock.d`;
const pendingOf = (rollout: string) => `${rollout}.traceroot.pending.d`;
const exists = (p: string) => real.access(p).then(() => true, () => false);
const ownersOf = (rollout: string) => real.readdir(lockOf(rollout)).catch(() => []);
const isEntryOf = (rollout: string, file: unknown) => String(file).startsWith(`${lockOf(rollout)}${path.sep}`);
const eio = () => Object.assign(new Error("EIO"), { code: "EIO" });

/** Leaves a lock whose only owner is `owner`, last touched `ageMs` ago. */
async function leaveLock(rollout: string, owner: string, ageMs = 0): Promise<void> {
  await real.mkdir(lockOf(rollout), { recursive: true });
  await real.writeFile(path.join(lockOf(rollout), owner), owner);
  const at = new Date(Date.now() - ageMs);
  await real.utimes(path.join(lockOf(rollout), owner), at, at);
}

const staleLock = (rollout: string, owner: string) => leaveLock(rollout, owner, 120_000);

/** Another hook's lock in place of the one there, as when that hook took over a stale one. */
async function replaceLock(rollout: string, owner: string): Promise<void> {
  await real.rm(lockOf(rollout), { recursive: true, force: true });
  await leaveLock(rollout, owner);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("withSessionLock under exact interleavings", () => {
  it("does not remove a lock that another hook took over just before this hook released", async () => {
    const rollout = await rolloutPath();
    const other = `${process.pid}.other`;

    await withSessionLock(rollout, async () => {
      // Right before this hook removes its entry, another hook that judged it stale took the lock over.
      let fired = false;
      steps.before = async (op, [file]) => {
        if (fired || op !== "rm" || !isEntryOf(rollout, file)) return;
        fired = true;
        await replaceLock(rollout, other);
      };
    }, T);

    expect(await ownersOf(rollout)).toEqual([other]);
  });

  it.each<[string, Op, "before" | "after"]>([
    ["while this hook was looking at it", "readdir", "after"],
    ["after this hook judged it stale", "rm", "before"],
  ])("does not remove a live lock that replaced a stale one %s", async (_when, op, at) => {
    const rollout = await rolloutPath();
    const live = `${process.pid}.live`;
    await staleLock(rollout, `${process.pid}.frozen`);
    let fired = false;
    steps[at] = async (seen, [file]) => {
      if (fired || seen !== op || (file !== lockOf(rollout) && !isEntryOf(rollout, file))) return;
      fired = true;
      await replaceLock(rollout, live);
    };
    let ran = false;

    expect(await withSessionLock(rollout, async () => { ran = true; }, T)).toBeUndefined();
    expect(ran).toBe(false);
    expect(await ownersOf(rollout)).toEqual([live]);
  });

  it("keeps a stale lock whose holder touched it again after this hook judged it stale and before it removed it", async () => {
    const rollout = await rolloutPath();
    const holder = `${process.pid}.resumed`;
    await staleLock(rollout, holder);
    let looks = 0;
    steps.before = async (op, [file]) => {
      if (op !== "stat" || file !== path.join(lockOf(rollout), holder) || ++looks !== 2) return;
      await real.utimes(path.join(lockOf(rollout), holder), new Date(), new Date());
    };
    let ran = false;

    expect(await withSessionLock(rollout, async () => { ran = true; }, T)).toBeUndefined();
    expect(looks).toBeGreaterThanOrEqual(2);
    expect(ran).toBe(false);
    expect(await ownersOf(rollout)).toEqual([holder]);
  });

  it("runs again when it could not read its lock for a moment during its run", async () => {
    const rollout = await rolloutPath();
    const held: boolean[] = [];

    await withSessionLock(rollout, async (lock) => {
      if (held.length === 0) {
        steps.before = (op, [file]) => {
          if (op !== "readFile" || !isEntryOf(rollout, file)) return;
          steps.before = undefined;
          throw eio();
        };
      }
      held.push(await lock.held()); // a run that finds its lock gone sends nothing
    }, T);

    expect(held).toEqual([false, true]);
    expect(await exists(pendingOf(rollout))).toBe(false);
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it.each([
    ["while it waits", 60_000],
    ["on its last try after asking the holder to run again", 0],
  ])("does not run unlocked when it cannot create its lock %s for a lock it found held", async (_when, waitMs) => {
    const rollout = await rolloutPath();
    await leaveLock(rollout, `${process.pid}.holder`);
    // The holder releases after this hook first finds the lock held, and this hook's
    // next try then fails to create the lock.
    const released = () => real.rm(lockOf(rollout), { recursive: true, force: true });
    let tries = 0;
    steps.before = (op, [file]) => {
      if (op === "mkdir" && String(file).startsWith(`${lockOf(rollout)}.`) && ++tries === 2) throw eio();
    };
    steps.after = async (op, [, to]) => {
      if (op === "rename" && String(to).startsWith(pendingOf(rollout))) await released();
    };
    let sleeps = 0;
    const sleep = async () => { if (++sleeps === 1) await released(); };
    const locked: boolean[] = [];

    await withSessionLock(rollout, async () => { locked.push(await exists(lockOf(rollout))); }, { ...T, waitMs, sleep });

    expect(tries).toBeGreaterThanOrEqual(2);
    expect(locked).not.toContain(false);
  });

  it("does not run when it cannot claim the requests waiting for it, and releases the lock", async () => {
    const rollout = await rolloutPath();
    await real.mkdir(pendingOf(rollout));
    await real.writeFile(path.join(pendingOf(rollout), "waiting"), "");
    steps.before = (op, [from]) => {
      if (op === "rename" && from === pendingOf(rollout)) throw eio();
    };
    let ran = false;

    await expect(withSessionLock(rollout, async () => { ran = true; }, T)).rejects.toThrow("EIO");
    expect(ran).toBe(false);
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it("does not report a hand-off when it could not leave its request", async () => {
    const rollout = await rolloutPath();
    await leaveLock(rollout, `${process.pid}.holder`);
    steps.before = (op, [file]) => {
      if (op === "writeFile" && String(file).startsWith(pendingOf(rollout))) throw eio();
    };
    setDebug(true);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let ran = false;

    expect(await withSessionLock(rollout, async () => { ran = true; }, T)).toBeUndefined();
    expect(ran).toBe(false);
    expect(await exists(pendingOf(rollout))).toBe(false);
    const lines = log.mock.calls.map((args) => args.join(" "));
    expect(lines.some((line) => line.includes("could not ask"))).toBe(true);
    expect(lines.some((line) => line.includes("runs again for this one"))).toBe(false);
  });
});

// Which hook a file operation belongs to, so a test can step one hook at every
// operation it makes while the others run freely.
const actor = new AsyncLocalStorage<string>();
const as = <R>(name: string, fn: () => Promise<R>) => actor.run(name, fn);

/** Counts the runs in flight and records the most at once. */
function inFlight() {
  let now = 0;
  const c = { most: 0, run: async (body: () => Promise<void> = async () => {}) => {
    c.most = Math.max(c.most, ++now);
    try { await body(); } finally { now -= 1; }
  } };
  return c;
}

describe("withSessionLock with one hook stepped at every file operation", () => {
  it("lets one of two hooks that both judged a dead hook's lock stale take it", async () => {
    const rollout = await rolloutPath();
    const dead = "2147483647.dead";
    await leaveLock(rollout, dead);
    const paused = { a: deferred(), b: deferred() };
    const resume = { a: deferred(), b: deferred() };
    const runningA = deferred();
    const finish = deferred();
    const runs = inFlight();
    // Each hook pauses right before it removes the dead owner's entry.
    steps.before = async (op, [file]) => {
      const who = actor.getStore();
      if (op !== "rm" || file !== path.join(lockOf(rollout), dead) || (who !== "a" && who !== "b")) return;
      paused[who].resolve();
      await resume[who].promise;
    };

    const a = as("a", () => withSessionLock(rollout, () => runs.run(async () => { runningA.resolve(); await finish.promise; }), T));
    await paused.a.promise;
    const b = as("b", () => withSessionLock(rollout, () => runs.run(), T));
    await paused.b.promise;
    resume.a.resolve();
    await runningA.promise; // A removed the entry and the emptied lock, then took the lock
    const ownersWhileARuns = await ownersOf(rollout);
    resume.b.resolve();
    expect(await b).toBeUndefined(); // B's rmdir is refused: the lock holds A's entry
    expect(await ownersOf(rollout)).toEqual(ownersWhileARuns);
    finish.resolve();
    await a;

    expect(ownersWhileARuns).toHaveLength(1);
    expect(ownersWhileARuns[0]).not.toBe(dead);
    expect(runs.most).toBe(1);
  });

  it("never lets a newcomer take a live lock while another hook recovers the stale lock it replaced", async () => {
    const rollout = await rolloutPath();
    await staleLock(rollout, `${process.pid}.frozen`);
    const looked = deferred();
    const resume = deferred();
    const running = deferred();
    const finish = deferred();
    const runs = inFlight();
    let holderLock: SessionLock | undefined;
    const heldByHolder: boolean[] = [];
    let judged = false;
    let stepping = false;
    // The breaker looks inside the stale lock and pauses while the holder breaks it
    // and takes the lock. After every later operation of the breaker, the holder
    // must still hold its lock and a newcomer must not get it.
    steps.after = async (op, [file]) => {
      if (actor.getStore() !== "breaker" || stepping) return;
      if (!judged) {
        if (op !== "readdir" || file !== lockOf(rollout)) return;
        judged = true;
        looked.resolve();
        await resume.promise;
        return;
      }
      stepping = true;
      heldByHolder.push(await as("check", () => holderLock!.held()));
      await as("newcomer", () => withSessionLock(rollout, () => runs.run(), T));
      stepping = false;
    };

    const breaker = as("breaker", () => withSessionLock(rollout, () => runs.run(), T));
    await looked.promise;
    const holder = as("holder", () => withSessionLock(rollout, (lock) => runs.run(async () => {
      if (holderLock) return;
      holderLock = lock;
      running.resolve();
      await finish.promise;
    }), T));
    await running.promise;
    resume.resolve();
    await breaker;
    finish.resolve();
    await holder;

    expect(heldByHolder.length).toBeGreaterThan(0);
    expect(heldByHolder).not.toContain(false);
    expect(runs.most).toBe(1);
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it("never removes the lock of a hook that broke the same stale lock first, wherever this one pauses", async () => {
    for (let pauseAt = 1; ; pauseAt++) {
      const rollout = await rolloutPath();
      await staleLock(rollout, `${process.pid}.frozen`);
      const runs = inFlight();
      const running = deferred();
      const finish = deferred();
      let otherLock: SessionLock | undefined;
      let other: Promise<unknown> | undefined;

      // Right before this hook's operation number `pauseAt`, another hook breaks the
      // same stale lock, takes the lock and starts its run, or finds it busy and hands off.
      let ops = 0;
      steps.before = async () => {
        if (actor.getStore() !== "slow" || ++ops !== pauseAt) return;
        other = as("fast", () => withSessionLock(rollout, (lock) => runs.run(async () => {
          if (otherLock) return;
          otherLock = lock;
          running.resolve();
          await finish.promise;
        }), T));
        await Promise.race([running.promise, other]);
      };
      await as("slow", () => withSessionLock(rollout, () => runs.run(), T));
      steps.before = undefined;
      const heldAfter = otherLock ? await otherLock.held() : true;
      finish.resolve();
      await other;
      await real.rm(dir, { recursive: true, force: true });

      if (other === undefined) break; // this hook made fewer operations: every point was tried
      expect(heldAfter, `other hook lost its lock when this one paused before operation ${pauseAt}`).toBe(true);
      expect(runs.most, `two runs at once when this one paused before operation ${pauseAt}`).toBe(1);
    }
  });

  it("never runs two hooks at once while they recover what a dead hook left, wherever each pauses", async () => {
    // A pid no process has: the hook that used it is dead.
    const deadPid = 2_147_483_647;
    const quiet: LockTimings = { ...T, heartbeatMs: 1_000_000_000 };
    const never = new Promise<void>(() => {});

    /**
     * A hook dies holding the lock (in its run, `dieAt` 0) or right before its file
     * operation number `dieAt` after its run. Hook A then pauses before its own
     * operation number `aAt` while it recovers; while it waits, hook B recovers up
     * to its operation number `bAt` and pauses; A goes on until it runs or hands
     * off, then B does.
     */
    async function recover(dieAt: number, aAt: number, bAt: number) {
      const rollout = await rolloutPath();
      const runs = inFlight();
      const heldAtStart: boolean[] = [];
      const finish = deferred();
      const died = deferred();
      const paused = { a: deferred(), b: deferred() };
      const resume = { a: deferred(), b: deferred() };
      const started = { a: deferred(), b: deferred() };
      const ops = { dying: 0, a: 0, b: 0 };
      const state = { releasing: false, aPaused: false, bPaused: false, aRunning: false, bRunning: false };

      steps.before = async () => {
        const who = actor.getStore();
        if (who === "dying") {
          if (state.releasing && ++ops.dying === dieAt) { died.resolve(); await never; }
        } else if (who === "a" && !state.aRunning && ++ops.a === aAt) {
          state.aPaused = true;
          paused.a.resolve();
          await resume.a.promise;
        } else if (who === "b" && !state.bRunning && ++ops.b === bAt) {
          state.bPaused = true;
          paused.b.resolve();
          await resume.b.promise;
        }
      };
      const runOf = (name: "a" | "b") => (lock: SessionLock) => {
        state[`${name}Running`] = true;
        started[name].resolve();
        return runs.run(async () => {
          heldAtStart.push(await as("check", () => lock.held()));
          await finish.promise;
        });
      };

      const pid = Object.getOwnPropertyDescriptor(process, "pid")!;
      Object.defineProperty(process, "pid", { ...pid, value: deadPid });
      const dying = as("dying", () => withSessionLock(rollout, async () => {
        if (dieAt === 0) { died.resolve(); await never; }
        state.releasing = true;
      }, quiet));
      Object.defineProperty(process, "pid", pid);
      const dead = await Promise.race([died.promise.then(() => true), dying.then(() => false)]);

      const a = as("a", () => withSessionLock(rollout, runOf("a"), quiet));
      await Promise.race([paused.a.promise, started.a.promise, a]);
      let b: Promise<unknown> = Promise.resolve();
      if (state.aPaused) {
        b = as("b", () => withSessionLock(rollout, runOf("b"), quiet));
        await Promise.race([paused.b.promise, started.b.promise, b]);
        resume.a.resolve();
        await Promise.race([started.a.promise, a]);
        resume.b.resolve();
        await Promise.race([started.b.promise, b]);
      }
      finish.resolve();
      await Promise.all([a, b]);
      steps.before = undefined;
      await real.rm(dir, { recursive: true, force: true });
      return { dead, aPaused: state.aPaused, bPaused: state.bPaused, most: runs.most, heldAtStart };
    }

    let tried = 0;
    for (let dieAt = 0; ; dieAt++) {
      let dead = true;
      for (let aAt = 1; ; aAt++) {
        let aPaused = false;
        for (let bAt = 1; ; bAt++) {
          const result = await recover(dieAt, aAt, bAt);
          tried += 1;
          const at = `dead hook stopped at ${dieAt}, A paused before ${aAt}, B before ${bAt}`;
          expect(result.most, `two runs at once: ${at}`).toBeLessThanOrEqual(1);
          expect(result.heldAtStart, `a run started without the lock: ${at}`).not.toContain(false);
          dead = result.dead;
          aPaused = result.aPaused;
          if (!result.bPaused) break;
        }
        if (!aPaused) break;
      }
      if (!dead) break; // the hook made fewer operations than `dieAt`: it finished cleanly
    }
    expect(tried).toBeGreaterThan(100);
  }, 120_000);

  it("serves the latest of two Stops handing off at once, wherever the older one pauses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let pauseAt = 1; ; pauseAt++) {
      vi.setSystemTime(performance.timeOrigin + performance.now());
      const rollout = await rolloutPath();
      const started = deferred();
      const gate = deferred();
      const served: HandOff[] = [];
      const holder = as("holder", () => withSessionLock(rollout, async (_lock, handOff) => {
        served.push(handOff);
        if (served.length === 1) { started.resolve(); await gate.promise; }
      }, T));
      await started.promise;

      // Right before the older Stop's operation number `pauseAt`, a newer Stop hands off in full.
      let ops = 0;
      let newer: number | undefined;
      steps.before = async () => {
        if (actor.getStore() !== "older" || ++ops !== pauseAt) return;
        vi.setSystemTime(Date.now() + 1_000);
        newer = Date.now();
        expect(await as("newer", () => withSessionLock(rollout, async () => {}, T, true))).toBeUndefined();
      };
      expect(await as("older", () => withSessionLock(rollout, async () => {}, T, true))).toBeUndefined();
      steps.before = undefined;
      gate.resolve();
      await holder;
      await real.rm(dir, { recursive: true, force: true });

      if (newer === undefined) break; // the older Stop made fewer operations: every point was tried
      const turnEnds = served.map((handOff) => handOff.turnEndedAt ?? 0);
      expect(Math.max(...turnEnds), `newer Stop handed off before the older one's operation ${pauseAt}`).toBe(newer);
    }
  });
});
