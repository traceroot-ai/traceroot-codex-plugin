/**
 * Pins the planned spans for every rollout fixture, byte for byte, so a change
 * that alters what existing rollouts produce (with optional features left off)
 * fails here. fixtures/spans-golden.json holds what the planner on main at
 * 0065794ad750 produces for these fixtures and contexts. To rebuild it, run
 * `pnpm run regenerate:golden`: it plans from that commit, never from the
 * current sources, so a change under test cannot rewrite its own expectation.
 */
import { describe, expect, it } from "vitest";
import { GOLDEN_CONTEXTS, GOLDEN_FIXTURES, readGolden } from "./golden.js";
import { planFixture } from "./helpers.js";

const golden = readGolden();

describe("planned spans for every rollout fixture", () => {
  const cases = GOLDEN_FIXTURES.flatMap((f) => Object.keys(GOLDEN_CONTEXTS).map((c) => [f, c] as const));

  it.each(cases)("%s (%s context) matches the pinned output", async (fixture, context) => {
    const spans = await planFixture(fixture, GOLDEN_CONTEXTS[context]!);
    expect(spans).toEqual(golden[fixture]![context]);
    expect(JSON.stringify(spans)).toBe(JSON.stringify(golden[fixture]![context]));
  });
});
