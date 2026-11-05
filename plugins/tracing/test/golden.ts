/**
 * What fixtures/spans-golden.json is planned from, and a reader for it. Nothing
 * here loads the plugin's code at run time, so regenerate-spans-golden.mjs can
 * load it next to the pinned planner without the current sources.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { EmitCtx } from "../src/spans.js";

/** The rollout fixtures the golden file pins, in the order it lists them. */
export const GOLDEN_FIXTURES = [
  "rollout-basic.jsonl",
  "rollout-child-spawner.jsonl",
  "rollout-child-thread-1.jsonl",
  "rollout-inprogress.jsonl",
  "rollout-tool-detail.jsonl",
  "rollout-with-subagent.jsonl",
  "rollout-tool-image.jsonl",
  "rollout-prompt-image.jsonl",
];

/**
 * The contexts fixtures/spans-golden.json was planned in. "full" mirrors a live
 * Stop hook with every context field set the way dispatch sets it by default,
 * image capture off included; "tight" leaves the optional fields unset and
 * truncates hard, so the truncation path is pinned too.
 */
export const GOLDEN_CONTEXTS: Record<string, EmitCtx> = {
  full: {
    environment: "dev", userId: "user-1", git: { repo: "traceroot-ai/traceroot", ref: "a".repeat(40) },
    maxChars: 20000, turnEnding: true, captureImages: false,
  },
  tight: { maxChars: 64 },
};

/** fixtures/spans-golden.json: each fixture's planned spans, by context name. */
export function readGolden(): Record<string, Record<string, unknown>> {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "spans-golden.json");
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, Record<string, unknown>>;
}
