import { getConfig } from "./config.js";
import { DRAIN_ARG } from "./drainer.js";
import { dispatch, drain } from "./emit.js";
import { DRAIN_LIFETIME_MS } from "./lock.js";
import type { HookInput } from "./types.js";
import { debugLog, readStdin, setDebug } from "./util.js";

export async function runHook(): Promise<void> {
  let hook: HookInput;
  try {
    hook = await readStdin<HookInput>();
  } catch {
    return; // no/invalid stdin — nothing to do
  }

  const config = await getConfig(hook.cwd);
  setDebug(config.debug);

  if (!config.enabled) {
    debugLog("tracing disabled (set TRACE_TO_TRACEROOT=true and TRACEROOT_API_KEY)");
    return;
  }
  if (!hook.transcript_path) {
    debugLog("hook payload missing transcript_path; skipping");
    return;
  }

  try {
    await dispatch(hook, config);
  } catch (error) {
    debugLog("dispatch failed:", error);
    // Honor the RESOLVED config (env OR JSON), not just env vars — set the exit
    // code here where config is known, then re-throw. The module-level handler
    // below is only a last resort for errors that escape before config resolves.
    if (config.failOnError) {
      process.exitCode = 1;
      throw error;
    }
  }
}

/**
 * Runs a drainer a hook started for its session: `session` names the rollout and
 * the cwd. Nothing reads its output or exit code. It stops at DRAIN_LIFETIME_MS
 * whatever it is doing; requests a run had not finished stay for the next hook.
 */
export async function runDrainer(session: string | undefined, exit: () => void = () => process.exit()): Promise<void> {
  setTimeout(exit, DRAIN_LIFETIME_MS).unref();
  let hook: HookInput;
  try {
    hook = JSON.parse(session ?? "") as HookInput;
  } catch {
    return;
  }
  const config = await getConfig(hook.cwd);
  setDebug(config.debug);
  if (!config.enabled || !hook.transcript_path) return;
  try {
    await drain(hook, config);
  } catch (error) {
    debugLog("drain failed:", error);
  }
}

// Self-invoke when executed as the bundled hook entry. By the time runHook
// rejects it has already applied resolved-config behavior (debug log + exit
// code); this is the backstop for the rare error thrown before getConfig — only
// env vars are available then.
if (process.argv[2] === DRAIN_ARG) {
  runDrainer(process.argv[3]).catch(() => {});
} else {
  runHook().catch((error) => {
    if (process.env.TRACEROOT_CODEX_DEBUG === "true") console.error("[traceroot-codex] fatal:", error);
    if (process.env.TRACEROOT_CODEX_FAIL_ON_ERROR === "true") process.exitCode = 1;
  });
}
