import { AsyncLocalStorage } from "node:async_hooks";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HandOff, type LockTimings, type SessionLock, withSessionLock } from "../src/lock.js";
import { setDebug } from "../src/util.js";

type Op = "open" | "stat" | "readFile" | "writeFile" | "link" | "rename" | "rm";
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
    readFile: wrap("readFile", actual.readFile),
    writeFile: wrap("writeFile", actual.writeFile),
    link: wrap("link", actual.link),
    rename: wrap("rename", actual.rename),
    rm: wrap("rm", actual.rm),
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

const lockOf = (rollout: string) => `${rollout}.traceroot.lock`;
const breakOf = (rollout: string) => `${lockOf(rollout)}.break`;
const pendingOf = (rollout: string) => `${rollout}.traceroot.pending.d`;
const exists = (p: string) => real.access(p).then(() => true, () => false);

/** Another hook's lock in place of the one there, as if that hook had removed it and created its own. */
async function replaceLock(lockPath: string, content: string): Promise<void> {
  await real.writeFile(`${lockPath}.replacement`, content);
  await real.rename(`${lockPath}.replacement`, lockPath);
}

async function staleLock(lockPath: string, content: string): Promise<void> {
  await real.writeFile(lockPath, content);
  const old = new Date(Date.now() - 120_000);
  await real.utimes(lockPath, old, old);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Runs `step` once, right after this hook first looks at the lock file. Any read
 * of the lock that this look started at the same time waits for the step, so the
 * step lands between the hook's two reads when the look is two separate reads.
 */
function afterFirstLook(lockPath: string, step: () => Promise<void>): void {
  let looking = false;
  let finished = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const isLook = (op: Op, file: unknown) => file === lockPath && (op === "open" || op === "stat");
  steps.before = async (op, [file]) => {
    if (isLook(op, file)) looking = true;
    else if (op === "readFile" && file === lockPath && looking) await done;
  };
  steps.after = async (op, [file]) => {
    if (finished || !isLook(op, file)) return;
    finished = true;
    await step();
    resolveDone();
  };
}

describe("withSessionLock under exact interleavings", () => {
  it("does not remove a lock that another hook took over just before this hook released", async () => {
    const rollout = await rolloutPath();
    const other = `${process.pid} other`;

    await withSessionLock(rollout, async () => {
      // Right before this hook takes the right to remove its lock, another hook that
      // held it judged the lock stale, removed it and created its own.
      let fired = false;
      steps.before = async (op, [, to]) => {
        if (fired || op !== "link" || to !== breakOf(rollout)) return;
        fired = true;
        await replaceLock(lockOf(rollout), other);
      };
    }, T);

    expect(await real.readFile(lockOf(rollout), "utf-8")).toBe(other);
    expect(await exists(breakOf(rollout))).toBe(false);
  });

  it("releases its lock once the hook holding the right to remove it lets go", async () => {
    const rollout = await rolloutPath();

    await withSessionLock(rollout, async () => {
      let tries = 0;
      steps.before = async (op, [, to]) => {
        if (op !== "link" || to !== breakOf(rollout)) return;
        tries += 1;
        if (tries === 1) await real.writeFile(breakOf(rollout), `${process.pid} other`); // held by another hook
        if (tries === 2) await real.rm(breakOf(rollout)); // and let go
      };
    }, T);

    expect(await exists(lockOf(rollout))).toBe(false);
    expect(await exists(breakOf(rollout))).toBe(false);
  });

  it("does not remove a live lock that replaced a stale one while this hook was looking at it", async () => {
    const rollout = await rolloutPath();
    const live = `${process.pid} live`;
    await staleLock(lockOf(rollout), `${process.pid} frozen`);
    afterFirstLook(lockOf(rollout), () => replaceLock(lockOf(rollout), live));
    let ran = false;

    expect(await withSessionLock(rollout, async () => { ran = true; }, T)).toBeUndefined();
    expect(ran).toBe(false);
    expect(await real.readFile(lockOf(rollout), "utf-8")).toBe(live);
  });

  it("keeps a stale lock whose holder touched it again after this hook judged it stale and before it removed it", async () => {
    const rollout = await rolloutPath();
    const holder = `${process.pid} resumed`;
    await staleLock(lockOf(rollout), holder);
    let touched = false;
    steps.before = async (op, [, to]) => {
      if (touched || op !== "link" || to !== breakOf(rollout)) return;
      touched = true;
      await real.utimes(lockOf(rollout), new Date(), new Date());
    };
    let ran = false;

    expect(await withSessionLock(rollout, async () => { ran = true; }, T)).toBeUndefined();
    expect(ran).toBe(false);
    expect(await real.readFile(lockOf(rollout), "utf-8")).toBe(holder);
  });

  it("runs again when it could not read its lock for a moment during its run", async () => {
    const rollout = await rolloutPath();
    const held: boolean[] = [];

    await withSessionLock(rollout, async (lock) => {
      if (held.length === 0) {
        steps.before = (op, [file]) => {
          if (op !== "readFile" || file !== lockOf(rollout)) return;
          steps.before = undefined;
          throw Object.assign(new Error("EIO"), { code: "EIO" });
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
    const holder = `${process.pid} holder`;
    await real.writeFile(lockOf(rollout), holder);
    let tries = 0;
    steps.before = (op, [, to]) => {
      if (op === "link" && to === lockOf(rollout) && ++tries === 2) throw Object.assign(new Error("EIO"), { code: "EIO" });
    };
    // The holder releases only after the failed try.
    let sleeps = 0;
    const sleep = async () => { if (++sleeps === 2) await real.rm(lockOf(rollout), { force: true }); };
    const alongside: boolean[] = [];

    await withSessionLock(rollout, async () => {
      alongside.push((await real.readFile(lockOf(rollout), "utf-8").catch(() => "")) === holder);
    }, { ...T, waitMs, sleep });

    expect(tries).toBeGreaterThanOrEqual(2);
    expect(alongside).not.toContain(true);
  });

  it("does not report a hand-off when it could not leave its request", async () => {
    const rollout = await rolloutPath();
    await real.writeFile(lockOf(rollout), `${process.pid} holder`);
    steps.before = (op, [file]) => {
      if (op === "writeFile" && String(file).startsWith(pendingOf(rollout))) throw Object.assign(new Error("EIO"), { code: "EIO" });
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

describe("withSessionLock with one hook stepped at every file operation", () => {
  it("never lets a newcomer take a live lock while another hook recovers the stale lock it replaced", async () => {
    const rollout = await rolloutPath();
    await staleLock(lockOf(rollout), `${process.pid} frozen`);
    const looked = deferred();
    const resume = deferred();
    const running = deferred();
    const finish = deferred();
    let inRun = 0;
    let most = 0;
    const counted = async (body: () => Promise<void> = async () => {}) => {
      most = Math.max(most, ++inRun);
      try { await body(); } finally { inRun -= 1; }
    };
    let holderLock: SessionLock | undefined;
    const heldByHolder: boolean[] = [];
    let judged = false;
    let stepping = false;
    // The breaker looks at the stale lock and pauses while the holder breaks it and
    // takes the lock. After every later operation of the breaker, the holder must
    // still hold its lock and a newcomer must not get it.
    steps.after = async (op, [file]) => {
      if (actor.getStore() !== "breaker" || stepping) return;
      if (!judged) {
        if (op !== "open" || file !== lockOf(rollout)) return;
        judged = true;
        looked.resolve();
        await resume.promise;
        return;
      }
      stepping = true;
      heldByHolder.push(await as("check", () => holderLock!.held()));
      await as("newcomer", () => withSessionLock(rollout, () => counted(), T));
      stepping = false;
    };

    const breaker = as("breaker", () => withSessionLock(rollout, () => counted(), T));
    await looked.promise;
    const holder = as("holder", () => withSessionLock(rollout, (lock) => counted(async () => {
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
    expect(most).toBe(1);
    expect(await exists(lockOf(rollout))).toBe(false);
  });

  it("never removes the lock of a hook that broke the same stale lock first, wherever this one pauses", async () => {
    for (let pauseAt = 1; ; pauseAt++) {
      const rollout = await rolloutPath();
      await staleLock(lockOf(rollout), `${process.pid} frozen`);
      let inRun = 0;
      let most = 0;
      const counted = async (body: () => Promise<void> = async () => {}) => {
        most = Math.max(most, ++inRun);
        try { await body(); } finally { inRun -= 1; }
      };
      const running = deferred();
      const finish = deferred();
      let otherLock: SessionLock | undefined;
      let other: Promise<unknown> | undefined;

      // Right before this hook's operation number `pauseAt`, another hook breaks the
      // same stale lock, takes the lock and starts its run, or finds it busy and hands off.
      let ops = 0;
      steps.before = async () => {
        if (actor.getStore() !== "slow" || ++ops !== pauseAt) return;
        other = as("fast", () => withSessionLock(rollout, (lock) => counted(async () => {
          if (otherLock) return;
          otherLock = lock;
          running.resolve();
          await finish.promise;
        }), T));
        await Promise.race([running.promise, other]);
      };
      const slow = as("slow", () => withSessionLock(rollout, () => counted(), T));
      await slow;
      steps.before = undefined;
      const heldAfter = otherLock ? await otherLock.held() : true;
      finish.resolve();
      await other;
      await real.rm(dir, { recursive: true, force: true });

      if (other === undefined) break; // this hook made fewer operations: every point was tried
      expect(heldAfter, `other hook lost its lock when this one paused before operation ${pauseAt}`).toBe(true);
      expect(most, `two runs at once when this one paused before operation ${pauseAt}`).toBe(1);
    }
  });

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
