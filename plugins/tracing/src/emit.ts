import type { Config } from "./config.js";
import { spawnDrainer } from "./drainer.js";
import { buildTracing as defaultBuildTracing, type Tracing } from "./exporter.js";
import { getGitContext } from "./git.js";
import { makeSpanId, makeTraceId } from "./ids.js";
import { drainSession, type HandOff, type LockTimings, type SessionLock, withSessionLock } from "./lock.js";
import { loadEmittedSpanIds, markSpansEmitted } from "./sidecar.js";
import { emitSpan, planTurnSpans, type EmitCtx, type PlanOpts } from "./spans.js";
import { locateSubagentRollout } from "./subagents.js";
import { parseRollout, readRollout } from "./transcript.js";
import type { HookInput, SessionMeta, Turn } from "./types.js";
import { debugLog } from "./util.js";

// Paranoia guard only; the visited-set is the real recursion bound.
const STACK_GUARD = 32;

export type Deps = {
  /**
   * `stillHeld` says whether this hook still holds the session's lock; each request
   * is sent only while it does. `onDelivered` records each accepted request's spans.
   */
  buildTracing: (c: Config, stillHeld?: () => Promise<boolean>, onDelivered?: (ids: string[]) => Promise<void>) => Tracing;
  getGit: (cwd: string) => Promise<{ repo?: string; ref?: string }>;
  /**
   * Resolve a subagent's child rollout path by thread id.
   * SHOULD be fail-soft (return undefined rather than throw), but dispatch does
   * NOT assume it — the per-subagent resolve/read/parse is wrapped in try/catch.
   */
  findSubagent: (threadId: string) => Promise<string | undefined>;
  lockTimings: LockTimings;
  drainTimings: LockTimings;
  /** Starts a drainer for the hook's session (see drainSession). */
  startDrainer: (hook: HookInput) => void;
};

const buildLockedTracing: Deps["buildTracing"] = (c, stillHeld, onDelivered) =>
  defaultBuildTracing(c, undefined, stillHeld, onDelivered);

/** Emit all complete, not-yet-seen spans for `turn` and recurse into its subagents. */
async function emitTurnTree(
  sessionMeta: SessionMeta,
  turn: Turn,
  ctx: EmitCtx,
  opts: PlanOpts,
  visited: Set<string>,
  depth: number,
  tracing: Tracing,
  already: Set<string>,
  emittedIds: string[],
  findSubagent: Deps["findSubagent"],
): Promise<number> {
  let n = 0;

  for (const span of planTurnSpans(sessionMeta, turn, ctx, opts)) {
    if (!span.complete) continue;
    // The trace root (AGENT, no parent) is re-emitted on every hook so the trace
    // is named "Codex Turn" from the first span (not the first LLM step's model
    // name) and its end-time/output refine as the turn progresses (backend keeps
    // the latest version of a span id). All other spans dedup via the sidecar.
    const isTraceRoot = span.parentSpanId === null;
    if (already.has(span.spanId) && !isTraceRoot) continue;
    emitSpan(tracing, span);
    emittedIds.push(span.spanId);
    already.add(span.spanId);
    n++;
  }

  if (depth >= STACK_GUARD) {
    debugLog(`subagent recursion hit STACK_GUARD at depth ${depth}; stopping`);
    return n;
  }

  // Determine the traceId and seed prefix that were used for this turn.
  const parentSeed = opts.seedPrefix ?? "";
  const traceId = opts.traceId ?? makeTraceId(sessionMeta.sessionId, turn.turnId ?? "");

  for (const sub of turn.subagents ?? []) {
    if (!sub.spawnCallId) continue;
    if (visited.has(sub.threadId)) continue; // cycle/diamond guard
    // Mark BEFORE the try so a failing/cyclic thread is never retried this dispatch.
    visited.add(sub.threadId);

    // Fail-open: a throwing resolver/read/parse must NEVER propagate out of dispatch
    // (that would leave already-emitted parent spans un-marked → re-emit churn next hook).
    // On any error we log and skip to the next subagent.
    try {
      const childPath = await findSubagent(sub.threadId);
      debugLog(`subagent ${sub.threadId} spawnCall=${sub.spawnCallId}: childPath=${childPath ?? "NOT FOUND"}`);
      if (!childPath) continue; // child rollout not on disk yet — try again next hook

      const childLines = await readRollout(childPath);
      const child = parseRollout(childLines);
      debugLog(`subagent ${sub.threadId}: parsed ${child.turns.length} turn(s), session=${child.sessionMeta.sessionId}`);

      const childOpts: PlanOpts = {
        traceId,                                          // SAME trace as parent
        rootParentSpanId: makeSpanId(parentSeed + sub.spawnCallId), // nest under spawn TOOL span
        seedPrefix: sub.threadId + ":",                   // unique, stable child span ids
      };

      for (const childTurn of child.turns) {
        n += await emitTurnTree(
          child.sessionMeta, childTurn, ctx, childOpts, visited, depth + 1,
          tracing, already, emittedIds, findSubagent,
        );
      }
    } catch (err) {
      debugLog(`subagent ${sub.threadId} resolve/read/parse failed; skipping: ${String(err)}`);
      continue;
    }
  }

  return n;
}

export async function dispatch(
  hook: HookInput, config: Config, deps?: Partial<Deps>,
): Promise<{ emitted: number }> {
  const transcript = hook.transcript_path;
  if (!transcript) { debugLog("no transcript_path; skipping"); return { emitted: 0 }; }
  // Reading the rollout, exporting and recording what was sent run under the
  // session's lock, so concurrent hooks of one session deliver in the order they read.
  const result = await withSessionLock(
    transcript, (lock, handOff) => emitSession(hook, transcript, config, lock, handOff, deps), deps?.lockTimings,
    hook.hook_event_name === "Stop", () => (deps?.startDrainer ?? spawnDrainer)(hook),
  );
  // undefined: the hook holding the lock runs again for this one, or this one couldn't ask it to.
  return result ?? { emitted: 0 };
}

/** Serves, as a drainer, the runs the session's hooks left behind (see drainSession). */
export async function drain(hook: HookInput, config: Config, deps?: Partial<Deps>): Promise<void> {
  const transcript = hook.transcript_path;
  if (!transcript) return;
  // No hook event of its own: it ends a turn only for a Stop among the runs it serves.
  const session: HookInput = { transcript_path: transcript, cwd: hook.cwd };
  await drainSession(
    transcript, (lock, handOff) => emitSession(session, transcript, config, lock, handOff, deps), deps?.drainTimings,
    () => (deps?.startDrainer ?? spawnDrainer)(session),
  );
}

async function emitSession(
  hook: HookInput, transcript: string, config: Config, lock: SessionLock, handOff: HandOff, deps?: Partial<Deps>,
): Promise<{ emitted: number }> {
  const buildTracingFn = deps?.buildTracing ?? buildLockedTracing;
  const getGit = deps?.getGit ?? getGitContext;
  const findSubagentFn = deps?.findSubagent ?? locateSubagentRollout;

  const { sessionMeta, turns } = parseRollout(await readRollout(transcript));
  // The Stop hook, this hook or one that handed its run to it, is the "turn is
  // ending" signal — only then is the root span emitted (see planTurnSpans),
  // unless a newer turn has started since it arrived: that turn is still running.
  // Mid-turn PostToolUse hooks leave the root absent so the trace stays live.
  // SubagentStop carries the PARENT transcript while the parent turn is still
  // running, so it must NOT count as the parent turn ending.
  const latest = turns.at(-1);
  const turnEnding = handOff.turnEndedAt !== undefined && !!latest && latest.startTime <= handOff.turnEndedAt;

  // A subagent session is emitted NESTED under its parent's trace (via the
  // parent's spawn_agent tool). Codex fires PostToolUse/Stop on the subagent
  // session itself too; emitting here would duplicate it as a redundant
  // standalone trace — skip, the parent owns it. (Note: the SubagentStop hook
  // carries transcript_path = the PARENT session, so it does NOT hit this guard;
  // it usefully re-walks the parent to nest the just-finished subagent live.)
  if (sessionMeta.threadSource === "subagent" || sessionMeta.parentThreadId) {
    debugLog(`subagent session ${sessionMeta.sessionId}; skipping standalone emit (nested under parent)`);
    return { emitted: 0 };
  }

  const cwd = sessionMeta.cwd ?? hook.cwd ?? process.cwd();
  const git = await getGit(cwd).catch(() => ({}));
  const ctx: EmitCtx = {
    environment: config.environment, userId: config.userId, git, maxChars: config.maxChars,
    turnEnding,
    captureImages: config.captureImages,
  };

  const already = await loadEmittedSpanIds(transcript);
  // A hook that froze past the stale limit and lost the lock must not send what it read.
  if (!(await lock.held())) { debugLog("session lock lost before export; skipping"); return { emitted: 0 }; }
  // Each request's spans are recorded as soon as it is accepted, so a hook killed
  // at Codex's deadline keeps what it delivered and the next hook sends only the rest.
  const marked = new Set<string>();
  const record = async (ids: string[]) => {
    const fresh = ids.filter((id) => !marked.has(id));
    for (const id of fresh) marked.add(id);
    await markSpansEmitted(transcript, fresh);
  };
  const tracing = buildTracingFn(config, lock.held, record);
  let emitted = 0;
  const emittedIds: string[] = [];

  // One visited set per dispatch so a thread referenced from multiple turns is emitted once.
  const visited = new Set<string>();

  try {
    for (const turn of turns) {
      emitted += await emitTurnTree(
        sessionMeta, turn, ctx, {}, visited, 0,
        tracing, already, emittedIds, findSubagentFn,
      );
    }
  } finally {
    try {
      await tracing.shutdown();
    } finally {
      // Mark only the spans the backend accepted, even when shutdown reports a
      // failed export: anything left unmarked is sent again on the next hook.
      await record(emittedIds.filter((id) => tracing.delivered.has(id)));
    }
  }
  debugLog(`emitted ${emitted} spans`);
  return { emitted };
}
