/**
 * Pins the planned spans for every rollout fixture, byte for byte, so a change
 * that alters what existing rollouts produce (with optional features left off)
 * fails here. fixtures/spans-golden.json holds the expected spans.
 */
import { describe, expect, it } from "vitest";
import { GOLDEN_CONTEXTS, planFixture, readGolden } from "./helpers.js";

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

const golden = readGolden();

describe("planned spans for every rollout fixture", () => {
  const cases = FIXTURES.flatMap((f) => Object.keys(GOLDEN_CONTEXTS).map((c) => [f, c] as const));

  it.each(cases)("%s (%s context) matches the pinned output", async (fixture, context) => {
    const spans = await planFixture(fixture, GOLDEN_CONTEXTS[context]!);
    expect(spans).toEqual(golden[fixture]![context]);
    expect(JSON.stringify(spans)).toBe(JSON.stringify(golden[fixture]![context]));
  });
});
