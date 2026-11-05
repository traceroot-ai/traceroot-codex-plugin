import * as fs from "node:fs/promises";
import { debugLog } from "./util.js";

const suffix = ".traceroot";

export async function loadEmittedSpanIds(rolloutFile: string): Promise<Set<string>> {
  try {
    const data = await fs.readFile(`${rolloutFile}${suffix}`, "utf-8");
    return new Set(data.split("\n").filter(Boolean));
  } catch (error) {
    // Fail-open: ENOENT is the normal first-run case; any other read failure
    // (e.g. permissions) should also degrade to "nothing emitted yet" rather
    // than abort emission. Duplicate emits are idempotent (deterministic ids +
    // backend upsert), so proceeding is strictly safer than dropping the trace.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      debugLog("sidecar read failed; assuming empty:", error);
    }
    return new Set();
  }
}

/** Records `spanIds` as sent, in one append; an empty list writes nothing. */
export async function markSpansEmitted(rolloutFile: string, spanIds: string[]): Promise<void> {
  if (spanIds.length === 0) return;
  try {
    await fs.appendFile(`${rolloutFile}${suffix}`, `${spanIds.join("\n")}\n`, "utf-8");
  } catch {
    // Best-effort: a failed write only risks a duplicate emit next time.
  }
}
