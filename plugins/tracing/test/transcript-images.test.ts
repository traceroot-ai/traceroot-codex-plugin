import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRollout, readRollout } from "../src/transcript.js";
import type { RolloutLine } from "../src/types.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const parseFixture = async (name: string) => parseRollout(await readRollout(path.join(fixtures, name)));

const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP8=";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE=";

const ts = "2026-07-01T00:00:00.000Z";
const start: RolloutLine[] = [
  { timestamp: ts, type: "session_meta", payload: { id: "s" } },
  { timestamp: ts, type: "event_msg", payload: { type: "task_started", turn_id: "t" } },
];
const userMessage = (content: unknown[]): RolloutLine =>
  ({ timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content } }) as RolloutLine;
const turnOf = (lines: RolloutLine[]) => parseRollout([...start, ...lines]).turns[0]!;

describe("prompt images", () => {
  it("keeps images attached to the prompt, next to the authoritative prompt text", async () => {
    const { turns } = await parseFixture("rollout-prompt-image.jsonl");
    expect(turns[0]!.userInput).toBe("what colour is this image?");
    expect(turns[0]!.userImages).toHaveLength(1);
    expect(turns[0]!.userImages![0]).toMatch(/^data:image\/jpeg;base64,\/9j\//);
  });

  it("keeps an image sent without any text", () => {
    expect(turnOf([userMessage([{ type: "input_image", image_url: PNG }])]).userImages).toEqual([PNG]);
  });

  it("keeps several images in order and drops repeats", () => {
    const turn = turnOf([
      userMessage([{ type: "input_text", text: "compare" }, { type: "input_image", image_url: PNG }, { type: "input_image", image_url: JPEG }]),
      userMessage([{ type: "input_text", text: "again" }, { type: "input_image", image_url: PNG }]),
    ]);
    expect(turn.userImages).toEqual([PNG, JPEG]);
  });

  it("ignores injected context messages, remote URLs and other parts", () => {
    const turn = turnOf([
      userMessage([{ type: "input_text", text: "<environment_context>x</environment_context>" }, { type: "input_image", image_url: PNG }]),
      userMessage([
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: "https://example.com/a.png" },
        { type: "input_image" },
        { type: "output_image", image_url: JPEG },
      ]),
    ]);
    expect(turn.userImages).toBeUndefined();
  });

  it("keeps only PNG, JPEG, GIF and WebP base64 data URLs", () => {
    const turn = turnOf([userMessage([
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: "data:image/svg+xml;base64,PHN2Zy8+" },
      { type: "input_image", image_url: PNG },
      { type: "input_image", image_url: "data:image/png,%89PNG" },
    ])]);
    expect(turn.userImages).toEqual([PNG]);
    const svgOnly = turnOf([userMessage([{ type: "input_image", image_url: "data:image/svg+xml;base64,PHN2Zy8+" }])]);
    expect(svgOnly.userImages).toBeUndefined();
  });

  it("does not add the field to a turn without images", async () => {
    const { turns } = await parseFixture("rollout-basic.jsonl");
    expect("userImages" in turns[0]!).toBe(false);
  });
});

describe("tool output with images", () => {
  it("stores a custom_tool_call_output's content items as the raw array", async () => {
    const { turns } = await parseFixture("rollout-tool-image.jsonl");
    const tool = turns[0]!.steps[0]!.toolCalls[0]!;
    expect(tool.name).toBe("exec");
    expect(tool.output).toEqual([
      { type: "input_text", text: "Captured a 4x4 screenshot." },
      { type: "input_image", image_url: expect.stringMatching(/^data:image\/png;base64,iVBORw0KGgo/) },
    ]);
  });
});
