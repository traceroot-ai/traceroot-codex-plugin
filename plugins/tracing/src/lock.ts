import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { debugLog } from "./util.js";

export type LockTimings = {
  /** How long a hook waits for the session's lock before handing its run to the holder. */
  waitMs: number;
  /** A lock untouched for this long was left by a hook that died or froze. */
  staleMs: number;
  /** How often the holder touches its lock; well under staleMs. */
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

/** A drainer exits this long after it starts, whatever it is doing. */
export const DRAIN_LIFETIME_MS = 120_000;

// A drainer runs outside Codex's 30 s, after the hooks that left it work have
// exited. A live holder lets go within 30 s and a frozen one goes stale after
// 30 s, so a minute's wait is enough; it starts runs only in its first 90 s.
export const DRAIN_TIMINGS: LockTimings = {
  waitMs: 60_000, staleMs: 30_000, heartbeatMs: 5_000, rerunBudgetMs: 90_000, pollMs: 200,
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/*
 * The lock is a directory next to the rollout holding one entry, its owner, named
 * for that one acquisition (`<pid>.<uuid>`). It is filled under a temporary name
 * and renamed into place, so it never exists without its owner. Nothing ever
 * deletes a name another live hook could own:
 *   - an owner entry is removed by its unique name, by its holder on release or by
 *     a hook that found its holder gone, so it can never remove a later holder's;
 *   - the directory is removed only with rmdir, which the system refuses while
 *     the directory holds an owner, and a new lock replaces it only while empty.
 */

type Owner = { name: string; mtimeMs: number };

const newOwner = () => `${process.pid}.${randomUUID()}`;

/** Whether an owner is gone: its process exited, or it has been silent past staleMs. */
function isStale(owner: Owner, staleMs: number): boolean {
  // A live holder touches its entry every heartbeat, so only an old entry is judged
  // by age; a name that carries no pid is judged by age alone.
  if (Date.now() - owner.mtimeMs > staleMs) return true;
  const pid = Number(owner.name.split(".")[0]);
  return Number.isInteger(pid) && pid > 0 && !isAlive(pid);
}

async function ownerAt(lockDir: string, name: string): Promise<Owner | undefined> {
  const stat = await fs.stat(path.join(lockDir, name)).catch(() => undefined);
  return stat && { name, mtimeMs: stat.mtimeMs };
}

/** The owners in the lock directory, or undefined if it can't be read. */
async function ownersOf(lockDir: string): Promise<Owner[] | undefined> {
  const names = await fs.readdir(lockDir).catch(() => undefined);
  if (!names) return undefined;
  const owners: Owner[] = [];
  for (const name of names) {
    const owner = await ownerAt(lockDir, name);
    if (owner) owners.push(owner); // gone meanwhile: nothing to judge
  }
  return owners;
}

/** Creates the lock with `owner` in it, in one rename. */
async function tryCreate(lockDir: string, owner: string): Promise<"created" | "exists" | Error> {
  const staging = `${lockDir}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(staging);
    await fs.writeFile(path.join(staging, owner), owner);
    await fs.rename(staging, lockDir); // fails while another lock is there; replaces an empty one
    return "created";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") return "exists";
    // Some systems refuse to rename over any directory: what counts is whether a lock is there.
    return (await fs.lstat(lockDir).then(() => true, () => false)) ? "exists" : (error as Error);
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** One attempt to take the lock as `owner`, removing one whose holder is gone on the way. */
async function tryLock(lockDir: string, owner: string, staleMs: number): Promise<"held" | "busy" | Error> {
  for (;;) {
    const created = await tryCreate(lockDir, owner);
    if (created !== "exists") return created === "created" ? "held" : created;
    const owners = await ownersOf(lockDir);
    if (!owners || owners.some((seen) => !isStale(seen, staleMs))) return "busy";
    // Each entry is judged again right before it goes: a holder that resumed may
    // have touched it since. A directory left empty is removed the same way.
    for (const { name } of owners) {
      const now = await ownerAt(lockDir, name);
      if (now && !isStale(now, staleMs)) return "busy";
      await fs.rm(path.join(lockDir, name), { recursive: true, force: true }).catch(() => {});
    }
    // Refused if another hook has taken the lock since: then it is busy.
    if (!(await fs.rmdir(lockDir).then(() => true, () => false))) return "busy";
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
  try {
    await fs.writeFile(tmp, turnEndedAt === undefined ? "" : String(turnEndedAt));
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.rename(tmp, path.join(pendingDir, randomUUID()));
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

const hasRequests = (pendingDir: string) => fs.readdir(pendingDir).then((names) => names.length > 0, () => false);

/** The requests one run serves, and the latest turn end among them. */
type Claim = { handOff: HandOff; requests: string[] };

/**
 * Takes the requests waiting for a run. Requests made after this are not among
 * them, so they get a run of their own. They stay in place until the run that
 * claimed them has finished, so a hook killed during that run leaves them for the
 * next one.
 */
async function claimRequests(pendingDir: string): Promise<Claim> {
  let requests: string[];
  try {
    requests = await fs.readdir(pendingDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { handOff: {}, requests: [] };
    throw error;
  }
  let turnEndedAt: number | undefined;
  for (const name of requests) {
    const request = await fs.readFile(path.join(pendingDir, name), "utf-8").catch(() => "");
    turnEndedAt = laterTurnEnd(turnEndedAt, turnEndOf(request));
  }
  return { handOff: turnEndedAt === undefined ? {} : { turnEndedAt }, requests };
}

async function removeRequests(pendingDir: string, requests: string[]): Promise<void> {
  for (const name of requests) await fs.rm(path.join(pendingDir, name), { force: true }).catch(() => {});
}

type Acquired = "held" | "handed-off" | "not-handed-off" | "unlocked" | "timed-out";

async function acquire(
  lockDir: string, pendingDir: string, owner: string, turnEndedAt: number | undefined, t: LockTimings, drainer: boolean,
): Promise<Acquired> {
  const deadline = Date.now() + t.waitMs;
  // Failing open is for a lock that can't be created at all: once another hook was
  // seen holding it, an error creating it is no reason to run alongside that hook.
  // A drainer never fails open: no hook waits on it, so it keeps trying instead.
  let seenHeld = false;
  const attemptLock = async () => {
    const attempt = await tryLock(lockDir, owner, t.staleMs);
    seenHeld ||= attempt === "busy";
    return attempt instanceof Error && (seenHeld || drainer) ? "busy" : attempt;
  };
  for (;;) {
    let attempt = await attemptLock();
    if (attempt === "busy" && Date.now() >= deadline) {
      if (drainer) return "timed-out";
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

const pathsOf = (rolloutFile: string) => ({
  lockDir: `${rolloutFile}.traceroot.lock.d`,
  pendingDir: `${rolloutFile}.traceroot.pending.d`,
  drainerDir: `${rolloutFile}.traceroot.drainer.d`,
});

/** Removes `owner`'s entry, then the directory if that left it empty. */
async function releaseOwner(dir: string, owner: string): Promise<void> {
  await fs.rm(path.join(dir, owner), { force: true }).catch(() => {});
  await fs.rmdir(dir).catch(() => {}); // refused once another hook holds it
}

/**
 * Whether a drainer is serving the session: the drainer directory, made like the
 * lock, names a live owner. A drainer exits within DRAIN_LIFETIME_MS, so an older
 * entry is one whose drainer died.
 */
async function drainerRunning(drainerDir: string): Promise<boolean> {
  const owners = await ownersOf(drainerDir);
  return !!owners && owners.some((owner) => !isStale(owner, DRAIN_LIFETIME_MS));
}

type Role = {
  endsTurn: boolean;
  /** Never hands off nor runs unlocked, and runs only for requests. */
  drainer: boolean;
  /** Called when this hook exits leaving requests and no drainer is serving the session. */
  startDrainer?: () => void;
};

async function serve<T>(
  rolloutFile: string, run: (lock: SessionLock, handOff: HandOff) => Promise<T>, timings: LockTimings, role: Role,
): Promise<T | undefined> {
  // The rerun budget counts from here, so the time spent waiting for the lock is part of it.
  const started = Date.now();
  const { lockDir, pendingDir, drainerDir } = pathsOf(rolloutFile);
  // A new name for every time this hook takes the lock, so a hook that judged an
  // earlier holding stale can never remove a later one.
  let owner = newOwner();
  const turnEndedAt = role.endsTurn ? started : undefined;
  // Requests this hook leaves may have no run left to serve them: the holder it
  // handed off to may be past its budget or be killed at Codex's deadline, and
  // after a turn's last Stop no later hook may come. A drainer serves them.
  const leaveToDrainer = async () => {
    if (!role.startDrainer || !(await hasRequests(pendingDir)) || (await drainerRunning(drainerDir))) return;
    debugLog("starting a drainer for the runs this session's hooks left");
    role.startDrainer();
  };
  const acquired = await acquire(lockDir, pendingDir, owner, turnEndedAt, timings, role.drainer);
  if (acquired === "handed-off") {
    debugLog("another hook of this session holds the lock; it runs again for this one");
    await leaveToDrainer();
    return undefined;
  }
  if (acquired === "not-handed-off") {
    debugLog("another hook of this session holds the lock, and this one could not ask it to run again; sending nothing");
    return undefined;
  }
  if (acquired === "timed-out") {
    debugLog("the session lock stayed held; leaving its runs for the session's next hook");
    return undefined;
  }
  if (acquired === "unlocked") return run({ held: async () => true }, {});

  const ownerPath = () => path.join(lockDir, owner);
  // Whether the lock was found gone, or unreadable, at any point of the current run.
  let lostInRun = false;
  const lock: SessionLock = {
    held: async () => {
      const mine = (await fs.readFile(ownerPath(), "utf-8").catch(() => "")) === owner;
      lostInRun ||= !mine;
      return mine;
    },
  };
  const heartbeat = setInterval(() => {
    void lock.held().then((mine) => {
      if (mine) return fs.utimes(ownerPath(), new Date(), new Date());
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
      const claim = await claimRequests(pendingDir);
      if (role.drainer && claim.requests.length === 0) {
        debugLog("nothing left to run for; the hooks served it");
        return undefined;
      }
      lostInRun = false;
      const result = await run(lock, claim.handOff).finally(async () => {
        await askAgainIfLost(claim.handOff);
        await removeRequests(pendingDir, claim.requests);
      });
      if (await hasRequests(pendingDir)) {
        if (budgetLeft() && (await lock.held())) {
          debugLog("running again for a hook that handed its run to this one");
          continue;
        }
        debugLog("leaving a handed-off run for a drainer or the session's next hook");
        return result;
      }
      // Release, then look again: a hook may have asked between that look and the
      // release. Then either it takes the lock itself, or this hook takes it back.
      await releaseOwner(lockDir, owner);
      if (!(await hasRequests(pendingDir)) || !budgetLeft()) return result;
      owner = newOwner();
      if ((await tryLock(lockDir, owner, timings.staleMs)) !== "held") return result;
      debugLog("running again for a hook that asked while this one released");
    }
  } finally {
    clearInterval(heartbeat);
    await releaseOwner(lockDir, owner);
    await leaveToDrainer();
  }
}

/**
 * Runs `run` while holding the session's lock, a directory next to the rollout, so
 * hooks of one session (a subagent's SubagentStop beside the parent's own hooks,
 * say) read the rollout, export and record what they sent one at a time.
 *
 * A hook that can't get the lock within `waitMs` never runs on its own: it leaves
 * a request and returns undefined, and the holder runs again, reading the rollout
 * as it is then. A hook that `endsTurn` says so in its request, and the run that
 * serves it is told when it arrived. The holder keeps its entry in the lock fresh
 * while it runs, so it is taken over only if it exits or freezes, and `run` checks
 * `held()` before exporting so a frozen holder that resumes sends nothing.
 *
 * A hook that exits while requests are still waiting, after handing off or as a
 * holder past its rerun budget, calls `startDrainer` unless a drainer is already
 * serving the session (see drainSession).
 */
export async function withSessionLock<T>(
  rolloutFile: string,
  run: (lock: SessionLock, handOff: HandOff) => Promise<T>,
  timings: LockTimings = DEFAULT_TIMINGS,
  endsTurn = false,
  startDrainer?: () => void,
): Promise<T | undefined> {
  return serve(rolloutFile, run, timings, { endsTurn, drainer: false, startDrainer });
}

/**
 * Serves the requests the session's hooks left, from a process that outlives them:
 * a drainer. It waits for the lock like a hook, but it never hands off, never runs
 * unlocked, and runs only for requests still waiting, so it adds no run when the
 * hooks served them. It starts no run after `rerunBudgetMs`.
 *
 * At most one drainer serves a session: it holds the drainer directory, made and
 * removed like the lock, while it works, and one that finds it held exits. After
 * letting go it looks again, since a hook that left a request meanwhile saw it
 * running and started no drainer of its own.
 */
export async function drainSession<T>(
  rolloutFile: string,
  run: (lock: SessionLock, handOff: HandOff) => Promise<T>,
  timings: LockTimings = DRAIN_TIMINGS,
): Promise<void> {
  const started = Date.now();
  const { pendingDir, drainerDir } = pathsOf(rolloutFile);
  for (;;) {
    const left = timings.rerunBudgetMs - (Date.now() - started);
    if (left <= 0 || !(await hasRequests(pendingDir))) return;
    const owner = newOwner();
    if ((await tryLock(drainerDir, owner, DRAIN_LIFETIME_MS)) !== "held") return; // another drainer serves them
    try {
      await serve(rolloutFile, run, { ...timings, waitMs: Math.min(timings.waitMs, left), rerunBudgetMs: left }, {
        endsTurn: false, drainer: true,
      });
    } finally {
      await releaseOwner(drainerDir, owner);
    }
  }
}
