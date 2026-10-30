/**
 * Pins the planned spans for every rollout fixture, byte for byte, so a change
 * that alters what existing rollouts produce (with optional features left off)
 * fails here. fixtures/spans-golden.json holds the expected spans.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type EmitCtx, planTurnSpans } from "../src/spans.js";
import { parseRollout, readRollout } from "../src/transcript.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const FIXTURES = [
  "rollout-basic.jsonl",
  "rollout-child-spawner.jsonl",
  "rollout-child-thread-1.jsonl",
  "rollout-inprogress.jsonl",
  "rollout-tool-detail.jsonl",
  "rollout-with-subagent.jsonl",
  "rollout-tool-image.jsonl",
  "rollout-prompt-image.jsonl",
];

// "full" mirrors a live Stop hook with every optional context field set;
// "tight" truncates hard so the truncation path is pinned too.
const CONTEXTS: Record<string, EmitCtx> = {
  full: {
    environment: "dev", userId: "user-1", git: { repo: "traceroot-ai/traceroot", ref: "a".repeat(40) },
    maxChars: 20000, turnEnding: true,
  },
  tight: { maxChars: 64 },
};

const golden = JSON.parse(fs.readFileSync(path.join(fixtures, "spans-golden.json"), "utf-8")) as
  Record<string, Record<string, unknown>>;

async function planFixture(name: string, ctx: EmitCtx) {
  const { sessionMeta, turns } = parseRollout(await readRollout(path.join(fixtures, name)));
  return turns.flatMap((turn) => planTurnSpans(sessionMeta, turn, ctx));
}

describe("planned spans for every rollout fixture", () => {
  const cases = FIXTURES.flatMap((f) => Object.keys(CONTEXTS).map((c) => [f, c] as const));

  it.each(cases)("%s (%s context) matches the pinned output", async (fixture, context) => {
    const spans = await planFixture(fixture, CONTEXTS[context]!);
    expect(spans).toEqual(golden[fixture]![context]);
    expect(JSON.stringify(spans)).toBe(JSON.stringify(golden[fixture]![context]));
  });
});
