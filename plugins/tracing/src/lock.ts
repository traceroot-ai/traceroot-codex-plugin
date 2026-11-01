import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { debugLog } from "./util.js";

export type LockTimings = {
  /** How long a hook waits for the session's lock before handing its run to the holder. */
  waitMs: number;
  /** A lock file untouched for this long was left by a hook that died or froze. */
  staleMs: number;
  /** How often the holder touches its lock file; well under staleMs. */
  heartbeatMs: number;
  /** The holder runs again for hooks that handed it their run only while it has run less than this. */
  rerunBudgetMs: number;
  pollMs: number;
  /** How a waiting hook sleeps between attempts; tests replace it to know when a hook is waiting. */
  sleep?: (ms: number) => Promise<void>;
};

// Codex gives a hook 30 s. A hook that can't get the lock in 10 s hands its run
// to the holder and exits; the holder runs again for it while it has used less
// than half of its own 30 s.
const DEFAULT_TIMINGS: LockTimings = {
  waitMs: 10_000, staleMs: 30_000, heartbeatMs: 5_000, rerunBudgetMs: 15_000, pollMs: 50,
};

export type SessionLock = {
  /** Whether this hook still holds the session's lock. Check it right before exporting. */
  held: () => Promise<boolean>;
};

/** What the hooks that handed their run to this one asked of it. */
export type HandOff = {
  /** When the latest of them that ended its turn (Codex's Stop) arrived. */
  turnEndedAt?: number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const exists = (p: string) => fs.access(p).then(() => true, () => false);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type LockFile = { content: string; mtimeMs: number };

/** A lock file's content and age, both read through one handle so they come from the same file. */
async function inspect(file: string): Promise<LockFile | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const { mtimeMs } = await handle.stat();
    return { content: await handle.readFile("utf-8"), mtimeMs };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Whether the lock's holder is gone: exited, or silent past staleMs. */
function isStale(lock: LockFile, staleMs: number): boolean {
  // A live holder touches the file every heartbeat, so only an old file is judged
  // by age; content that doesn't parse is judged by age alone.
  if (Date.now() - lock.mtimeMs > staleMs) return true;
  const pid = Number(lock.content.split(" ")[0]);
  return Number.isInteger(pid) && pid > 0 && !isAlive(pid);
}

/** Creates the lock holding `token`. It is written in full first, so a lock file is never seen empty. */
async function tryCreate(lockPath: string, token: string): Promise<"created" | "exists" | Error> {
  const tmp = `${lockPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, token);
    await fs.link(tmp, lockPath); // fails with EEXIST if the lock is there
    return "created";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : (error as Error);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/**
 * Removes the lock only if `isIt` holds for it. The lock is first moved to a
 * path no other hook uses, so the check and the removal act on one file that
 * nobody can replace in between. A lock that fails the check is moved back.
 */
async function removeLockIf(lockPath: string, isIt: (lock: LockFile) => boolean): Promise<boolean> {
  const moved = `${lockPath}.${randomUUID()}.moved`;
  try {
    await fs.rename(lockPath, moved);
  } catch {
    return false; // released meanwhile
  }
  const lock = await inspect(moved);
  if (lock && isIt(lock)) {
    await fs.rm(moved, { force: true });
    return true;
  }
  // Moved back over any lock taken in the moment it was away: its holder may
  // already be exporting, while a hook that has only just taken the lock checks
  // that it still holds it before it exports.
  await fs.rename(moved, lockPath).catch(() => fs.rm(moved, { force: true }));
  return false;
}

/** One attempt to take the lock, breaking a stale one on the way. */
async function tryLock(lockPath: string, token: string, staleMs: number): Promise<"held" | "busy" | Error> {
  for (;;) {
    const created = await tryCreate(lockPath, token);
    if (created === "created") return "held";
    if (created instanceof Error) return created;
    const seen = await inspect(lockPath);
    if (!seen || !isStale(seen, staleMs)) return "busy";
    // Judged again once moved aside: the file may have been replaced, or touched
    // by a holder that resumed, since it was first looked at.
    const broken = await removeLockIf(lockPath, (lock) => lock.content === seen.content && isStale(lock, staleMs));
    if (!broken) return "busy";
  }
}

/**
 * Asks the holder to run again for this hook, written in full before it appears.
 * A hook that ended its turn replaces any request already waiting with one that
 * says when it arrived; any other leaves a waiting request in place, since that
 * one already gets a run.
 */
async function requestRun(pendingPath: string, turnEndedAt: number | undefined): Promise<boolean> {
  const tmp = `${pendingPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, turnEndedAt === undefined ? "" : String(turnEndedAt));
    if (turnEndedAt !== undefined) {
      await fs.rename(tmp, pendingPath);
    } else {
      await fs.link(tmp, pendingPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/** Takes the requests waiting for a run, so that requests made after this get a run of their own. */
async function claimRequests(pendingPath: string): Promise<HandOff> {
  const claimed = `${pendingPath}.${randomUUID()}.claimed`;
  try {
    await fs.rename(pendingPath, claimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const request = await fs.readFile(claimed, "utf-8").catch(() => "");
  await fs.rm(claimed, { force: true });
  const turnEndedAt = Number(request);
  return request && Number.isFinite(turnEndedAt) ? { turnEndedAt } : {};
}

type Acquired = "held" | "handed-off" | "not-handed-off" | "unlocked";

async function acquire(
  lockPath: string, pendingPath: string, token: string, turnEndedAt: number | undefined, t: LockTimings,
): Promise<Acquired> {
  const deadline = Date.now() + t.waitMs;
  for (;;) {
    let attempt = await tryLock(lockPath, token, t.staleMs);
    if (attempt === "busy" && Date.now() >= deadline) {
      // Ask the holder to run again for this hook, then look once more: the holder
      // may have released after it last looked for requests.
      const asked = await requestRun(pendingPath, turnEndedAt);
      attempt = await tryLock(lockPath, token, t.staleMs);
      if (attempt === "busy") return asked ? "handed-off" : "not-handed-off";
    }
    if (attempt === "held") return "held";
    if (attempt instanceof Error) {
      // Fail open, like the sidecar: a lock that can't be created must not stop emission.
      debugLog("session lock unavailable; continuing without it:", attempt);
      return "unlocked";
    }
    await (t.sleep ?? sleep)(t.pollMs);
  }
}

/**
 * Runs `run` while holding the session's lock, a file next to the rollout, so
 * hooks of one session (a subagent's SubagentStop beside the parent's own hooks,
 * say) read the rollout, export and record what they sent one at a time.
 *
 * A hook that can't get the lock within `waitMs` never runs on its own: it leaves
 * a request and returns undefined, and the holder runs again, reading the rollout
 * as it is then. A hook that `endsTurn` says so in its request, and the run that
 * serves it is told when it arrived. The holder keeps its lock file fresh while it
 * runs, so it is taken over only if it exits or freezes, and `run` checks `held()`
 * before exporting so a frozen holder that resumes sends nothing.
 */
export async function withSessionLock<T>(
  rolloutFile: string,
  run: (lock: SessionLock, handOff: HandOff) => Promise<T>,
  timings: LockTimings = DEFAULT_TIMINGS,
  endsTurn = false,
): Promise<T | undefined> {
  const lockPath = `${rolloutFile}.traceroot.lock`;
  const pendingPath = `${rolloutFile}.traceroot.pending`;
  const token = `${process.pid} ${randomUUID()}`;
  const acquired = await acquire(lockPath, pendingPath, token, endsTurn ? Date.now() : undefined, timings);
  if (acquired === "handed-off") {
    debugLog("another hook of this session holds the lock; it runs again for this one");
    return undefined;
  }
  if (acquired === "not-handed-off") {
    debugLog("another hook of this session holds the lock, and this one could not ask it to run again; sending nothing");
    return undefined;
  }
  if (acquired === "unlocked") return run({ held: async () => true }, {});

  const lock: SessionLock = {
    held: async () => (await fs.readFile(lockPath, "utf-8").catch(() => "")) === token,
  };
  const release = async () => {
    if (await lock.held()) await removeLockIf(lockPath, (mine) => mine.content === token);
  };
  const heartbeat = setInterval(() => {
    void lock.held().then((mine) => {
      if (mine) return fs.utimes(lockPath, new Date(), new Date());
    }).catch(() => {});
  }, timings.heartbeatMs);
  heartbeat.unref();
  const started = Date.now();
  const budgetLeft = () => Date.now() - started < timings.rerunBudgetMs;
  try {
    for (;;) {
      // Claimed before reading the rollout: a request made after this point is
      // for a newer rollout, so it gets a run of its own.
      const handOff = await claimRequests(pendingPath);
      const result = await run(lock, handOff);
      if (await exists(pendingPath)) {
        if (budgetLeft() && (await lock.held())) {
          debugLog("running again for a hook that handed its run to this one");
          continue;
        }
        debugLog("leaving a handed-off run for the session's next hook");
        return result;
      }
      // Release, then look again: a hook may have asked between that look and the
      // release. Then either it takes the lock itself, or this hook takes it back.
      await release();
      if (!(await exists(pendingPath)) || !budgetLeft()) return result;
      if ((await tryLock(lockPath, token, timings.staleMs)) !== "held") return result;
      debugLog("running again for a hook that asked while this one released");
    }
  } finally {
    clearInterval(heartbeat);
    await release();
  }
}
