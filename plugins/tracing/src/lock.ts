import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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

// The right to remove the lock file is held for a few file operations only, so one
// held this long was left by a hook that died or froze holding it.
const BREAKER_STALE_MS = 5_000;
const BREAKER_POLL_MS = 5;
// A holder waits up to about a second for that right to release its lock.
const RELEASE_WAITS = 200;

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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type LockFile = { content: string; mtimeMs: number; dev: number; ino: number };

/** A lock file's content, age and identity, all read through one handle so they come from the same file. */
async function inspect(file: string): Promise<LockFile | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const { mtimeMs, dev, ino } = await handle.stat();
    return { content: await handle.readFile("utf-8"), mtimeMs, dev, ino };
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

const sameFile = (a: LockFile, b: LockFile) => a.dev === b.dev && a.ino === b.ino && a.content === b.content;

/**
 * Takes `breakPath`, the right to remove the lock file, created whole like the
 * lock itself, waiting for it up to `waits` times. One left by a hook that exited,
 * or held past BREAKER_STALE_MS, is removed and taken.
 */
async function takeBreaker(breakPath: string, token: string, waits: number): Promise<boolean> {
  for (let attempt = 0; attempt <= waits; attempt++) {
    if (attempt > 0) await sleep(BREAKER_POLL_MS);
    const created = await tryCreate(breakPath, token);
    if (created === "created") return true;
    if (created instanceof Error) return false;
    const seen = await inspect(breakPath);
    if (seen && isStale(seen, BREAKER_STALE_MS)) {
      await fs.rm(breakPath, { force: true }).catch(() => {});
      if ((await tryCreate(breakPath, token)) === "created") return true;
    }
  }
  return false;
}

async function dropBreaker(breakPath: string, token: string): Promise<void> {
  if ((await fs.readFile(breakPath, "utf-8").catch(() => "")) !== token) return;
  await fs.rm(breakPath, { force: true }).catch(() => {}); // left behind, it is stale once this hook exits
}

/**
 * Removes the lock file only if `isIt` holds for it, checked and removed in place
 * while holding `<lock>.break`. Every removal of the lock, a stale one's or a
 * holder's own, holds it, and a new lock is only ever created where none is, so
 * the file checked is the file removed: no other hook can remove it and create
 * its own in between. The lock path is never empty while a live hook holds it.
 */
async function removeLockIf(
  lockPath: string, token: string, isIt: (lock: LockFile) => boolean, waits: number,
): Promise<boolean> {
  const breakPath = `${lockPath}.break`;
  if (!(await takeBreaker(breakPath, token, waits))) return false;
  try {
    const lock = await inspect(lockPath);
    if (!lock || !isIt(lock)) return false;
    return await fs.rm(lockPath, { force: true }).then(() => true, () => false);
  } finally {
    await dropBreaker(breakPath, token);
  }
}

/** One attempt to take the lock, breaking a stale one on the way. */
async function tryLock(lockPath: string, token: string, staleMs: number): Promise<"held" | "busy" | Error> {
  for (;;) {
    const created = await tryCreate(lockPath, token);
    if (created === "created") return "held";
    if (created instanceof Error) return created;
    const seen = await inspect(lockPath);
    if (!seen || !isStale(seen, staleMs)) return "busy";
    // Judged again before removal: the file may have been replaced, or touched by
    // a holder that resumed, since it was first looked at.
    const broken = await removeLockIf(lockPath, token, (lock) => sameFile(lock, seen) && isStale(lock, staleMs), 0);
    if (!broken) return "busy";
  }
}

/** The turn end a request names, if any. */
function turnEndOf(request: string): number | undefined {
  const at = Number(request);
  return request && Number.isFinite(at) ? at : undefined;
}

function laterTurnEnd(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  return b === undefined ? a : Math.max(a, b);
}

/**
 * Asks the holder to run again for this hook: a request file of its own in
 * `pendingDir`, written in full before it appears. A hook that ended its turn
 * writes when it arrived. No request ever replaces another, so the run that
 * claims them sees every turn end.
 */
async function requestRun(pendingDir: string, turnEndedAt: number | undefined): Promise<boolean> {
  const tmp = `${pendingDir}.${randomUUID()}.tmp`;
  const request = path.join(pendingDir, randomUUID());
  try {
    await fs.writeFile(tmp, turnEndedAt === undefined ? "" : String(turnEndedAt));
    // A holder claiming the requests moves the directory away; then it is made again.
    for (let attempt = 1; ; attempt++) {
      await fs.mkdir(pendingDir, { recursive: true });
      try {
        await fs.rename(tmp, request);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt >= 3) throw error;
      }
    }
  } catch {
    return false;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

const hasRequests = (pendingDir: string) => fs.readdir(pendingDir).then((names) => names.length > 0, () => false);

/**
 * Takes every request waiting for a run, by moving their directory away, so that
 * requests made after this get a run of their own. The latest turn end among them
 * is passed on.
 */
async function claimRequests(pendingDir: string): Promise<HandOff> {
  const claimed = `${pendingDir}.${randomUUID()}.claimed`;
  try {
    await fs.rename(pendingDir, claimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let turnEndedAt: number | undefined;
  try {
    for (const name of await fs.readdir(claimed).catch(() => [])) {
      const request = await fs.readFile(path.join(claimed, name), "utf-8").catch(() => "");
      turnEndedAt = laterTurnEnd(turnEndedAt, turnEndOf(request));
    }
  } finally {
    await fs.rm(claimed, { recursive: true, force: true }).catch(() => {});
  }
  return turnEndedAt === undefined ? {} : { turnEndedAt };
}

type Acquired = "held" | "handed-off" | "not-handed-off" | "unlocked";

async function acquire(
  lockPath: string, pendingDir: string, token: string, turnEndedAt: number | undefined, t: LockTimings,
): Promise<Acquired> {
  const deadline = Date.now() + t.waitMs;
  // Failing open is for a lock that can't be created at all: once another hook was
  // seen holding it, an error creating it is no reason to run alongside that hook.
  let seenHeld = false;
  const attemptLock = async () => {
    const attempt = await tryLock(lockPath, token, t.staleMs);
    seenHeld ||= attempt === "busy";
    return attempt instanceof Error && seenHeld ? "busy" : attempt;
  };
  for (;;) {
    let attempt = await attemptLock();
    if (attempt === "busy" && Date.now() >= deadline) {
      // Ask the holder to run again for this hook, then look once more: the holder
      // may have released after it last looked for requests.
      const asked = await requestRun(pendingDir, turnEndedAt);
      attempt = await attemptLock();
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
  // The rerun budget counts from here, so the time spent waiting for the lock is part of it.
  const started = Date.now();
  const lockPath = `${rolloutFile}.traceroot.lock`;
  const pendingDir = `${rolloutFile}.traceroot.pending.d`;
  const token = `${process.pid} ${randomUUID()}`;
  const turnEndedAt = endsTurn ? started : undefined;
  const acquired = await acquire(lockPath, pendingDir, token, turnEndedAt, timings);
  if (acquired === "handed-off") {
    debugLog("another hook of this session holds the lock; it runs again for this one");
    return undefined;
  }
  if (acquired === "not-handed-off") {
    debugLog("another hook of this session holds the lock, and this one could not ask it to run again; sending nothing");
    return undefined;
  }
  if (acquired === "unlocked") return run({ held: async () => true }, {});

  // Whether the lock was found gone, or unreadable, at any point of the current run.
  let lostInRun = false;
  const lock: SessionLock = {
    held: async () => {
      const mine = (await fs.readFile(lockPath, "utf-8").catch(() => "")) === token;
      lostInRun ||= !mine;
      return mine;
    },
  };
  const release = async () => {
    if (await lock.held()) await removeLockIf(lockPath, token, (mine) => mine.content === token, RELEASE_WAITS);
  };
  const heartbeat = setInterval(() => {
    void lock.held().then((mine) => {
      if (mine) return fs.utimes(lockPath, new Date(), new Date());
    }).catch(() => {});
  }, timings.heartbeatMs);
  heartbeat.unref();
  const budgetLeft = () => Date.now() - started < timings.rerunBudgetMs;
  // A run that found the lock gone may not have sent what it read, nor ended the turn
  // it was told of, so it asks again: the hook holding the lock now, the session's
  // next hook, or this one if its lock was only unreadable for a moment runs for it.
  const askAgainIfLost = async (handOff: HandOff) => {
    if (!(await lock.held()) || lostInRun) await requestRun(pendingDir, laterTurnEnd(turnEndedAt, handOff.turnEndedAt));
  };
  try {
    for (;;) {
      // Claimed before reading the rollout: a request made after this point is
      // for a newer rollout, so it gets a run of its own.
      const handOff = await claimRequests(pendingDir);
      lostInRun = false;
      const result = await run(lock, handOff).finally(() => askAgainIfLost(handOff));
      if (await hasRequests(pendingDir)) {
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
      if (!(await hasRequests(pendingDir)) || !budgetLeft()) return result;
      if ((await tryLock(lockPath, token, timings.staleMs)) !== "held") return result;
      debugLog("running again for a hook that asked while this one released");
    }
  } finally {
    clearInterval(heartbeat);
    await release();
  }
}
