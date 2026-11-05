/**
 * Helpers shared by the lock tests: the paths the lock keeps next to a rollout,
 * and setting up and inspecting the files in them.
 */
import * as path from "node:path";
import { vi } from "vitest";
import { pathsOf } from "../src/lock.js";

// lock-races.test.ts mocks node:fs/promises for everything it imports, this module
// included. These helpers act from outside the lock, so they use the actual module
// and never run the steps that test hooks onto the lock's own file operations.
const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

export const lockOf = (rollout: string) => pathsOf(rollout).lockDir;
export const pendingOf = (rollout: string) => pathsOf(rollout).pendingDir;
export const drainerOf = (rollout: string) => pathsOf(rollout).drainerDir;
export const exists = (p: string) => fs.access(p).then(() => true, () => false);

/** The owners in the lock: the names in its directory. */
export const ownersOf = (rollout: string) => fs.readdir(lockOf(rollout)).catch(() => []);

/** Leaves a lock whose only owner is `owner`, last touched `ageMs` ago. */
export async function leaveLock(rollout: string, owner: string, ageMs = 0): Promise<void> {
  await fs.mkdir(lockOf(rollout), { recursive: true });
  await fs.writeFile(path.join(lockOf(rollout), owner), owner);
  const at = new Date(Date.now() - ageMs);
  await fs.utimes(path.join(lockOf(rollout), owner), at, at);
}
