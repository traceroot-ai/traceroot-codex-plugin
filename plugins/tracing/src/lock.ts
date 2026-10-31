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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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

/** The lock's content when its holder is gone: exited, or silent past staleMs. Otherwise undefined. */
async function staleContent(lockPath: string, staleMs: number): Promise<string | undefined> {
  try {
    const [stat, content] = await Promise.all([fs.stat(lockPath), fs.readFile(lockPath, "utf-8")]);
    // A live holder touches the file every heartbeat, so only an old file is judged
    // by age; content that doesn't parse is judged by age alone.
    if (Date.now() - stat.mtimeMs > staleMs) return content;
    const pid = Number(content.split(" ")[0]);
    return Number.isInteger(pid) && pid > 0 && !isAlive(pid) ? content : undefined;
  } catch {
    return undefined; // released meanwhile: just try again
  }
}

/**
 * Removes a stale lock, and puts back a fresh one if another hook replaced the
 * stale one first. False when the stale lock could not be moved.
 */
async function breakStale(lockPath: string, seen: string): Promise<boolean> {
  const moved = `${lockPath}.${randomUUID()}.stale`;
  try {
    await fs.rename(lockPath, moved);
  } catch {
    return false;
  }
  if ((await fs.readFile(moved, "utf-8").catch(() => undefined)) !== seen) {
    // If this fails, someone else already holds the lock, and the hook whose lock
    // was moved sees it no longer holds it before it exports.
    await fs.link(moved, lockPath).catch(() => {});
  }
  await fs.rm(moved, { force: true });
  return true;
}

/** One attempt to take the lock, breaking a stale one on the way. */
async function tryLock(lockPath: string, token: string, staleMs: number): Promise<"held" | "busy" | Error> {
  for (;;) {
    const created = await tryCreate(lockPath, token);
    if (created === "created") return "held";
    if (created instanceof Error) return created;
    const stale = await staleContent(lockPath, staleMs);
    if (stale === undefined || !(await breakStale(lockPath, stale))) return "busy";
  }
}

type Acquired = "held" | "handed-off" | "unlocked";

async function acquire(lockPath: string, pendingPath: string, token: string, t: LockTimings): Promise<Acquired> {
  const deadline = Date.now() + t.waitMs;
  for (;;) {
    let attempt = await tryLock(lockPath, token, t.staleMs);
    if (attempt === "busy" && Date.now() >= deadline) {
      // Ask the holder to run again for this hook, then look once more: the holder
      // may have released after it last looked for requests.
      await fs.writeFile(pendingPath, "").catch(() => {});
      attempt = await tryLock(lockPath, token, t.staleMs);
      if (attempt === "busy") return "handed-off";
    }
    if (attempt === "held") return "held";
    if (attempt instanceof Error) {
      // Fail open, like the sidecar: a lock that can't be created must not stop emission.
      debugLog("session lock unavailable; continuing without it:", attempt);
      return "unlocked";
    }
    await sleep(t.pollMs);
  }
}

/**
 * Runs `run` while holding the session's lock, a file next to the rollout, so
 * hooks of one session (a subagent's SubagentStop beside the parent's own hooks,
 * say) read the rollout, export and record what they sent one at a time.
 *
 * A hook that can't get the lock within `waitMs` never runs on its own: it leaves
 * a request and returns undefined, and the holder runs again, reading the rollout
 * as it is then. The holder keeps its lock file fresh while it runs, so it is
 * taken over only if it exits or freezes, and `run` checks `held()` before
 * exporting so a frozen holder that resumes sends nothing.
 */
export async function withSessionLock<T>(
  rolloutFile: string,
  run: (lock: SessionLock) => Promise<T>,
  timings: LockTimings = DEFAULT_TIMINGS,
): Promise<T | undefined> {
  const lockPath = `${rolloutFile}.traceroot.lock`;
  const pendingPath = `${rolloutFile}.traceroot.pending`;
  const token = `${process.pid} ${randomUUID()}`;
  const acquired = await acquire(lockPath, pendingPath, token, timings);
  if (acquired === "handed-off") {
    debugLog("another hook of this session holds the lock; it runs again for this one");
    return undefined;
  }
  if (acquired === "unlocked") return run({ held: async () => true });

  const lock: SessionLock = {
    held: async () => (await fs.readFile(lockPath, "utf-8").catch(() => "")) === token,
  };
  const release = async () => { if (await lock.held()) await fs.rm(lockPath, { force: true }); };
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
      // Cleared before reading the rollout: a request made after this point is
      // for a newer rollout, so it gets a run of its own.
      await fs.rm(pendingPath, { force: true });
      const result = await run(lock);
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
