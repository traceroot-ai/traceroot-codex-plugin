import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { HookInput } from "./types.js";
import { debugLog } from "./util.js";

/** The argument that makes the bundle drain a session instead of handling a hook. */
export const DRAIN_ARG = "--drain";

/**
 * Starts a drainer for the hook's session (see drainSession): this bundle again, in
 * a process that keeps running after the hook exits. Codex reads a hook's output
 * until it closes and, when a hook times out, kills the hook's process group, so
 * the drainer shares neither: it has no stdio and, outside Windows, a session of
 * its own. On Windows it stays in the hook's job, which Codex keeps once the hook
 * exits normally, as a hook does right after starting it.
 */
export function spawnDrainer(hook: HookInput, entry = fileURLToPath(import.meta.url)): void {
  const session = JSON.stringify({ transcript_path: hook.transcript_path, cwd: hook.cwd });
  try {
    const child = spawn(process.execPath, [entry, DRAIN_ARG, session], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", (error) => debugLog("could not start a drainer:", error));
    child.unref();
  } catch (error) {
    debugLog("could not start a drainer:", error);
  }
}
