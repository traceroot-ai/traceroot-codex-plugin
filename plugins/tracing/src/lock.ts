import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { debugLog } from "./util.js";

const suffix = ".traceroot.lock";

export type LockTimings = {
  /** How long to wait for the hook ahead before going ahead anyway. */
  waitMs: number;
  /** A lock older than this was left by a hook that died before releasing it. */
  staleMs: number;
  pollMs: number;
};

// Codex gives a hook 30 s. Wait for the hook ahead for half of that, leaving the
// rest for this hook's own export, then go ahead anyway: a stuck holder must not
// stop the session's traces for good.
const DEFAULT_TIMINGS: LockTimings = { waitMs: 15_000, staleMs: 60_000, pollMs: 50 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when the lock's content shows a holder that is gone or has held it too long. */
function isStale(content: string, staleMs: number): boolean {
  const [pid = NaN, since = NaN] = content.split(" ").map(Number);
  if (!Number.isInteger(pid) || !Number.isFinite(since)) return true;
  return Date.now() - since > staleMs || !isAlive(pid);
}

async function acquire(lockPath: string, t: LockTimings): Promise<() => Promise<void>> {
  const token = `${process.pid} ${Date.now()} ${randomUUID()}`;
  const deadline = Date.now() + t.waitMs;
  for (;;) {
    try {
      await fs.writeFile(lockPath, token, { flag: "wx" });
      return async () => {
        // Remove it only while it is still ours: after a stale takeover it may not be.
        const now = await fs.readFile(lockPath, "utf-8").catch(() => "");
        if (now === token) await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // Fail open, like the sidecar: a lock we cannot create must not stop emission.
        debugLog("session lock unavailable; continuing without it:", error);
        return async () => {};
      }
    }
    const held = await fs.readFile(lockPath, "utf-8").catch(() => undefined);
    if (held !== undefined && isStale(held, t.staleMs)) {
      // Best effort: re-check right before removing, so a fresh lock is left alone.
      const again = await fs.readFile(lockPath, "utf-8").catch(() => undefined);
      if (again === held) await fs.rm(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      debugLog(`session lock still held after ${t.waitMs} ms; continuing without it`);
      return async () => {};
    }
    await sleep(t.pollMs);
  }
}

/**
 * Runs `fn` while holding the session's lock, a file next to the rollout. Hooks
 * of one session (a subagent's SubagentStop beside the parent's own hooks, say)
 * then read the rollout, export and record what was sent one at a time, so a
 * hook that read an older rollout can never deliver after one that read a newer.
 */
export async function withSessionLock<T>(
  rolloutFile: string, fn: () => Promise<T>, timings: LockTimings = DEFAULT_TIMINGS,
): Promise<T> {
  const release = await acquire(`${rolloutFile}${suffix}`, timings);
  try {
    return await fn();
  } finally {
    await release();
  }
}
