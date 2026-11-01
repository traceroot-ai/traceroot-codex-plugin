import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LockTimings, withSessionLock } from "../src/lock.js";
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
  if (dir) await real.rm(dir, { recursive: true, force: true });
});

async function rolloutPath(): Promise<string> {
  dir = await real.mkdtemp(path.join(os.tmpdir(), "tr-lock-race-"));
  return path.join(dir, "rollout.jsonl");
}

const lockOf = (rollout: string) => `${rollout}.traceroot.lock`;
const pendingOf = (rollout: string) => `${rollout}.traceroot.pending`;
const exists = (p: string) => real.access(p).then(() => true, () => false);

/** Another hook's lock, put in place the way the lock module does it: a new file renamed over the path. */
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
      // The next time this hook moves or removes its lock, another hook takes it over just before.
      let fired = false;
      steps.before = async (op, [file]) => {
        if (fired || (op !== "rm" && op !== "rename") || file !== lockOf(rollout)) return;
        fired = true;
        await replaceLock(lockOf(rollout), other);
      };
    }, T);

    expect(await real.readFile(lockOf(rollout), "utf-8")).toBe(other);
  });

  it("puts a lock it moved aside by mistake back over one taken while it was away, so its holder keeps it", async () => {
    const rollout = await rolloutPath();
    const holder = `${process.pid} holder`;
    let step = 0;

    await withSessionLock(rollout, async () => {
      steps.before = async (op, [from, to]) => {
        if (step === 0 && op === "rename" && from === lockOf(rollout)) {
          step = 1; // taken over just before this hook moves its lock aside to release it
          await replaceLock(lockOf(rollout), holder);
        } else if (step === 1 && (op === "rename" || op === "link") && to === lockOf(rollout)) {
          step = 2; // and a third hook takes the empty path before the lock is put back
          await real.writeFile(lockOf(rollout), `${process.pid} newcomer`);
        }
      };
    }, T);

    expect(step).toBe(2);
    expect(await real.readFile(lockOf(rollout), "utf-8")).toBe(holder);
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

  it("keeps a stale lock whose holder touched it again after this hook judged it stale and before it moved it", async () => {
    const rollout = await rolloutPath();
    const holder = `${process.pid} resumed`;
    await staleLock(lockOf(rollout), holder);
    let touched = false;
    steps.before = async (op, [file]) => {
      if (touched || op !== "rename" || file !== lockOf(rollout)) return;
      touched = true;
      await real.utimes(lockOf(rollout), new Date(), new Date());
    };
    let ran = false;

    expect(await withSessionLock(rollout, async () => { ran = true; }, T)).toBeUndefined();
    expect(ran).toBe(false);
    expect(await real.readFile(lockOf(rollout), "utf-8")).toBe(holder);
  });

  it("runs again when its lock was away for a moment, moved aside by a hook that judged an older lock stale", async () => {
    const rollout = await rolloutPath();
    await staleLock(lockOf(rollout), `${process.pid} frozen`);
    const atMove = deferred();
    const letMove = deferred();
    const moved = deferred();
    const checked = deferred();
    const movedBack = deferred();
    let movedTo: string | undefined;
    // The first hook to move the stale lock aside is held back until the second has
    // broken it, taken the lock and started its run; it then moves the new lock aside.
    steps.before = async (op, [from, to]) => {
      if (movedTo !== undefined || op !== "rename" || from !== lockOf(rollout)) return;
      movedTo = String(to);
      atMove.resolve();
      await letMove.promise;
    };
    steps.after = async (op, [from, to]) => {
      if (op !== "rename") return;
      if (to === movedTo) { moved.resolve(); await checked.promise; }
      if (from === movedTo && to === lockOf(rollout)) movedBack.resolve();
    };

    const breaker = withSessionLock(rollout, async () => {}, T);
    await atMove.promise;
    const held: boolean[] = [];
    const holder = withSessionLock(rollout, async (lock) => {
      if (held.length === 0) {
        letMove.resolve();
        await moved.promise;
        held.push(await lock.held()); // the run sees its lock gone and sends nothing
        checked.resolve();
        await movedBack.promise;
        return;
      }
      held.push(await lock.held());
    }, T);
    await Promise.all([breaker, holder]);

    expect(held[0]).toBe(false);
    expect(held.slice(1)).toContain(true); // ran again holding its lock
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
