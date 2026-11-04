import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, getConfig } from "../src/config.js";
import { dispatch } from "../src/emit.js";
import { makeSpanId } from "../src/ids.js";
import { MAX_SPAN_BYTES, OVERSIZE_IMAGE, SPAN_TOO_LARGE_IMAGE } from "../src/images.js";
import { attributesBytes } from "../src/size.js";
import { type EmitCtx, type EmittableSpan, planTurnSpans } from "../src/spans.js";
import { parseRollout, readRollout } from "../src/transcript.js";
import type { SessionMeta, Turn } from "../src/types.js";
import { GOLDEN_CONTEXTS, memTracing, readGolden } from "./helpers.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const MiB = 1024 * 1024;
const INPUT = "traceroot.span.input";
const OUTPUT = "traceroot.span.output";

const on: EmitCtx = { maxChars: 64, turnEnding: true, captureImages: true };

async function plan(fixture: string, ctx: EmitCtx): Promise<EmittableSpan[]> {
  const { sessionMeta, turns } = parseRollout(await readRollout(path.join(fixtures, fixture)));
  return turns.flatMap((turn) => planTurnSpans(sessionMeta, turn, ctx));
}

async function fixtureImage(fixture: string, mime: string): Promise<string> {
  const text = fs.readFileSync(path.join(fixtures, fixture), "utf-8");
  return new RegExp(`data:image/${mime};base64,[A-Za-z0-9+/]+=*`).exec(text)![0];
}

const attr = (span: EmittableSpan | undefined, key: string): string => String(span?.attributes[key]);

/** A data URL whose payload decodes to `bytes` bytes. */
const imageOf = (bytes: number): string => `data:image/png;base64,${"A".repeat(Math.ceil(bytes / 3) * 4)}`;

const sessionMeta: SessionMeta = { sessionId: "sess-big" };
const turnWith = (patch: Partial<Turn>, output?: unknown, promptImages?: string[]): Turn => ({
  turnId: "turn-big", startTime: 0, endTime: 10, model: "gpt-5.5", completed: true, aborted: false,
  userInput: "go", ...patch,
  steps: [{
    index: 0, startTime: 1, endTime: 2, usage: { input_tokens: 1 },
    toolCalls: output === undefined ? [] : [{ callId: "call-big", name: "exec", args: "shot()", startTime: 1, endTime: 2, output }],
    ...(promptImages ? { userImages: promptImages } : {}),
  }],
});

describe("image capture on: tool output", () => {
  it("keeps the screenshot data URL whole in the tool span output", async () => {
    const png = await fixtureImage("rollout-tool-image.jsonl", "png");
    const tool = (await plan("rollout-tool-image.jsonl", on)).find((s) => s.kind === "TOOL");
    // The JSON around the strings and "input_text" take 60 of the 64 characters.
    expect(JSON.parse(attr(tool, OUTPUT))).toEqual([
      { type: "input_text", text: "Capt…[truncated 22 chars]" },
      { type: "input_image", image_url: png },
    ]);
  });

  it("records the Codex call id on the tool span, so the placeholder resolves to it", async () => {
    const spans = await plan("rollout-tool-image.jsonl", { ...on, maxChars: 20000 });
    const tool = spans.find((s) => s.kind === "TOOL");
    expect(JSON.parse(attr(tool, "traceroot.span.metadata"))).toEqual({ call_id: "call-shot" });
    expect(attr(spans.filter((s) => s.kind === "LLM")[1], INPUT)).toContain("[image: see tool call call-shot]");
  });

  it("puts a placeholder, not a second copy, into the next model call's input", async () => {
    const steps = (await plan("rollout-tool-image.jsonl", { ...on, maxChars: 20000 })).filter((s) => s.kind === "LLM");
    const next = attr(steps[1], INPUT);
    expect(next).toContain("[image: see tool call call-shot]");
    expect(next).not.toContain("data:image");
    expect(JSON.parse(next)[0].output[1]).toEqual({ type: "input_image", image_url: "[image: see tool call call-shot]" });
  });

  it("keeps the placeholder in the next model call's input after tool text longer than maxChars", () => {
    const output = [{ type: "input_text", text: "t".repeat(30000) }, { type: "input_image", image_url: imageOf(3000) }];
    const turn = turnWith({}, output);
    turn.steps.push({ index: 1, startTime: 3, endTime: 4, usage: { input_tokens: 1 }, toolCalls: [] });
    const next = attr(planTurnSpans(sessionMeta, turn, { ...on, maxChars: 20000 }).filter((s) => s.kind === "LLM")[1], INPUT);
    expect(next).not.toContain("data:image");
    const fed = JSON.parse(next)[0].output;
    expect(fed[0].text).toMatch(/^t{19913}…\[truncated \d+ chars\]$/);
    expect(fed[1]).toEqual({ type: "input_image", image_url: "[image: see tool call call-big]" });
  });

  it("cuts long tool text at maxChars but keeps the image after it", () => {
    const output = [{ type: "input_text", text: "t".repeat(30000) }, { type: "input_image", image_url: imageOf(3000) }];
    const tool = planTurnSpans(sessionMeta, turnWith({}, output), { ...on, maxChars: 20000 }).find((s) => s.kind === "TOOL");
    const parsed = JSON.parse(attr(tool, OUTPUT));
    expect(parsed[0].text).toMatch(/…\[truncated 10060 chars\]$/);
    expect(parsed[1].image_url).toBe(imageOf(3000));
  });

  it("replaces an image over 5 MiB with a placeholder", () => {
    const output = [{ type: "input_text", text: "Captured." }, { type: "input_image", image_url: imageOf(5 * MiB + 3) }];
    const tool = planTurnSpans(sessionMeta, turnWith({}, output), on).find((s) => s.kind === "TOOL");
    expect(JSON.parse(attr(tool, OUTPUT))).toEqual([
      { type: "input_text", text: "Captured." }, { type: "input_image", image_url: OVERSIZE_IMAGE },
    ]);
  });

  it("replaces the largest images until a span fits in 8 MiB", () => {
    const [large, small] = [imageOf(4.5 * MiB), imageOf(4 * MiB)];
    const output = [{ type: "input_image", image_url: small }, { type: "input_image", image_url: large }];
    const tool = planTurnSpans(sessionMeta, turnWith({}, output), on).find((s) => s.kind === "TOOL")!;
    expect(attributesBytes(tool.attributes)).toBeLessThanOrEqual(MAX_SPAN_BYTES);
    expect(JSON.parse(attr(tool, OUTPUT))).toEqual([
      { type: "input_image", image_url: small }, { type: "input_image", image_url: SPAN_TOO_LARGE_IMAGE },
    ]);
  });
});

describe("image capture on: prompt images", () => {
  const FIRST_CALL = "[image: see first model call]";

  it("puts the attached image in the first model call's input, and a placeholder in the turn input", async () => {
    const jpeg = await fixtureImage("rollout-prompt-image.jsonl", "jpeg");
    // Without images left in it, the turn input takes the plain maxChars cut.
    const spans = await plan("rollout-prompt-image.jsonl", { ...on, maxChars: 20000 });
    const text = { type: "input_text", text: "what colour is this image?" };
    expect(JSON.parse(attr(spans.find((s) => s.kind === "LLM"), INPUT))).toEqual([text, { type: "input_image", image_url: jpeg }]);
    const root = attr(spans.find((s) => s.kind === "AGENT"), INPUT);
    expect(JSON.parse(root)).toEqual([text, { type: "input_image", image_url: FIRST_CALL }]);
    expect(root).not.toContain("data:image");
  });

  it("keeps the turn input's placeholder after a prompt longer than maxChars", () => {
    const turn = turnWith({ userInput: "q".repeat(30000) }, undefined, [imageOf(30)]);
    const [root] = planTurnSpans(sessionMeta, turn, { ...on, maxChars: 20000 });
    const parsed = JSON.parse(attr(root, INPUT));
    expect(parsed[0]).toEqual({ type: "input_text", text: `${"q".repeat(19940)}…[truncated 10060 chars]` });
    expect(parsed[1]).toEqual({ type: "input_image", image_url: FIRST_CALL });
  });

  it("sends an image-only prompt as the image alone", () => {
    const png = imageOf(30);
    const [root, step] = planTurnSpans(
      sessionMeta, turnWith({ userInput: undefined }, undefined, [png]), { ...on, maxChars: 20000 },
    );
    expect(JSON.parse(attr(step, INPUT))).toEqual([{ type: "input_image", image_url: png }]);
    expect(JSON.parse(attr(root, INPUT))).toEqual([{ type: "input_image", image_url: FIRST_CALL }]);
  });

  it("never puts image bytes in the turn span, even from a data URL pasted as text", () => {
    const png = imageOf(30);
    const [root, step] = planTurnSpans(sessionMeta, turnWith({ userInput: `look: ${png}` }), on);
    expect(attr(root, INPUT)).toBe(`look: ${FIRST_CALL}`);
    expect(attr(step, INPUT)).toBe(`look: ${png}`);
  });

  it("fits prompt images into 8 MiB on the first model call span", () => {
    const [a, b] = [imageOf(4.5 * MiB), imageOf(4 * MiB)];
    const [root, step] = planTurnSpans(sessionMeta, turnWith({}, undefined, [a, b]), { ...on, maxChars: 20000 });
    expect(attributesBytes(step!.attributes)).toBeLessThanOrEqual(MAX_SPAN_BYTES);
    expect(JSON.parse(attr(step, INPUT))[1].image_url).toBe(SPAN_TOO_LARGE_IMAGE);
    expect(JSON.parse(attr(step, INPUT))[2].image_url).toBe(b);
    expect(attr(root, INPUT)).not.toContain("data:image");
    expect(attributesBytes(root!.attributes)).toBeLessThan(4096);
  });
});

describe("image capture on: an image sent while the turn is running", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const line = (ms: number, type: string, payload: Record<string, unknown>): string =>
    JSON.stringify({ timestamp: new Date(Date.UTC(2026, 6, 1, 12, 0, 0, ms)).toISOString(), type, payload });
  const config: Config = {
    enabled: true, apiKey: "tr-x", hostUrl: "http://127.0.0.1:9", maxChars: 20000, maxRequestBytes: 12 * MiB,
    debug: false, failOnError: true, captureImages: true,
  };

  it("goes on the model call after it, which is still unsent, and the turn input points at that call", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-steer-"));
    const transcript = path.join(dir, "rollout.jsonl");
    const png = await fixtureImage("rollout-tool-image.jsonl", "png");
    const throughFirstCall = [
      line(0, "session_meta", { id: "sess-steer", cwd: "/repo" }),
      line(10, "event_msg", { type: "task_started", turn_id: "turn-steer" }),
      line(20, "turn_context", { turn_id: "turn-steer", model: "gpt-5.5" }),
      line(100, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "fix the page" }] }),
      line(110, "event_msg", { type: "user_message", message: "fix the page" }),
      line(1000, "response_item", { type: "function_call", name: "exec_command", call_id: "call-edit", arguments: "{}" }),
      line(1100, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 10 } } }),
      line(2000, "response_item", { type: "function_call_output", call_id: "call-edit", output: "edited" }),
    ];
    // The user sends a screenshot while the first model call's tool runs.
    const steeringAndRest = [
      line(2500, "response_item", {
        type: "message", role: "user", content: [
          { type: "input_text", text: "<image name=[Image #1]>" }, { type: "input_image", image_url: png },
          { type: "input_text", text: "</image>" }, { type: "input_text", text: "it should look like this" },
        ],
      }),
      line(2510, "event_msg", { type: "user_message", message: "it should look like this" }),
      line(3000, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }),
      line(3100, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 20 } } }),
      line(3200, "event_msg", { type: "task_complete", turn_id: "turn-steer", last_agent_message: "Done." }),
    ];
    const mem = new InMemorySpanExporter();
    const deps = { buildTracing: () => memTracing(mem), getGit: async () => ({}) };

    fs.writeFileSync(transcript, `${throughFirstCall.join("\n")}\n`);
    await dispatch({ transcript_path: transcript, hook_event_name: "PostToolUse" }, config, deps);
    fs.appendFileSync(transcript, `${steeringAndRest.join("\n")}\n`);
    await dispatch({ transcript_path: transcript, hook_event_name: "Stop" }, config, deps);

    const sent = mem.getFinishedSpans();
    const ofType = (t: string) => sent.filter((s) => s.attributes["traceroot.span.type"] === t);
    const [first, second] = ofType("LLM");
    expect(ofType("LLM")).toHaveLength(2);
    expect(first!.attributes[INPUT]).toBe("fix the page");
    expect(JSON.parse(String(second!.attributes[INPUT]))).toEqual([
      { type: "input_text", text: JSON.stringify([{ name: "exec_command", output: "edited" }]) },
      { type: "input_image", image_url: png },
    ]);
    expect(JSON.parse(String(second!.attributes["traceroot.span.metadata"]))).toEqual({ "codex.step_index": 1 });
    expect(JSON.parse(String(ofType("AGENT")[0]!.attributes[INPUT]))).toEqual([
      { type: "input_text", text: "fix the page\n\nit should look like this" },
      { type: "input_image", image_url: "[image: see model call 1]" },
    ]);
  });

  it("puts each model call's images on that call, and points the turn input at the call holding each", () => {
    const [a, b] = [imageOf(30), imageOf(60)];
    const turn = turnWith({}, undefined, [a, b]);
    turn.steps.push({ index: 1, startTime: 3, endTime: 4, usage: { input_tokens: 1 }, toolCalls: [], userImages: [imageOf(90)] });
    const [root, step0, step1] = planTurnSpans(sessionMeta, turn, { ...on, maxChars: 20000 });
    expect(JSON.parse(attr(step0, INPUT)).slice(1)).toEqual([a, b].map((url) => ({ type: "input_image", image_url: url })));
    expect(JSON.parse(attr(step1, INPUT))).toEqual([{ type: "input_image", image_url: imageOf(90) }]);
    expect(JSON.parse(attr(root, INPUT)).map((item: { image_url?: string }) => item.image_url)).toEqual([
      undefined, "[image: see first model call]", "[image: see first model call]", "[image: see model call 1]",
    ]);
  });
});

describe("image capture on: a placeholder for an image left out of its span", () => {
  const wide: EmitCtx = { ...on, maxChars: 20000 };
  const fed = (spans: EmittableSpan[]) => JSON.parse(attr(spans.filter((s) => s.kind === "LLM")[1], INPUT))[0].output;
  const withNextCall = (turn: Turn): Turn => {
    turn.steps.push({ index: 1, startTime: 3, endTime: 4, usage: { input_tokens: 1 }, toolCalls: [] });
    return turn;
  };

  it("shows in the next model call that the tool span dropped the image to fit in 8 MiB", () => {
    const [large, small] = [imageOf(4.5 * MiB), imageOf(4 * MiB)];
    const output = [{ type: "input_image", image_url: small }, { type: "input_image", image_url: large }];
    const spans = planTurnSpans(sessionMeta, withNextCall(turnWith({}, output)), wide);
    expect(JSON.parse(attr(spans.find((s) => s.kind === "TOOL"), OUTPUT))[1].image_url).toBe(SPAN_TOO_LARGE_IMAGE);
    expect(fed(spans)).toEqual([
      { type: "input_image", image_url: "[image: see tool call call-big]" },
      { type: "input_image", image_url: SPAN_TOO_LARGE_IMAGE },
    ]);
  });

  it("shows in the next model call that the tool's image was over 5 MiB", () => {
    const output = [{ type: "input_text", text: "Captured." }, { type: "input_image", image_url: imageOf(5 * MiB + 3) }];
    const spans = planTurnSpans(sessionMeta, withNextCall(turnWith({}, output)), wide);
    expect(fed(spans)).toEqual([{ type: "input_text", text: "Captured." }, { type: "input_image", image_url: OVERSIZE_IMAGE }]);
  });

  it("shows in the turn input which prompt images the first model call dropped", () => {
    const [a, b] = [imageOf(4.5 * MiB), imageOf(4 * MiB)];
    const [root] = planTurnSpans(sessionMeta, turnWith({}, undefined, [a, b, imageOf(5 * MiB + 3)]), wide);
    expect(JSON.parse(attr(root, INPUT)).slice(1)).toEqual([
      { type: "input_image", image_url: SPAN_TOO_LARGE_IMAGE },
      { type: "input_image", image_url: "[image: see first model call]" },
      { type: "input_image", image_url: OVERSIZE_IMAGE },
    ]);
  });
});

// With capture off, every fixture's spans are pinned by span-output-golden.test.ts.
describe("image capture on, fixtures without images", () => {
  const golden = readGolden();
  const cases = Object.keys(golden).filter((f) => !f.includes("image"))
    .flatMap((f) => Object.keys(GOLDEN_CONTEXTS).map((c) => [f, c] as const));

  it.each(cases)(
    "%s (%s context) changes only by the tool call ids",
    async (fixture, context) => {
      const spans = await plan(fixture, { ...GOLDEN_CONTEXTS[context]!, captureImages: true });
      for (const span of spans.filter((s) => s.kind === "TOOL")) {
        const { call_id, ...rest } = JSON.parse(String(span.attributes["traceroot.span.metadata"]));
        expect(makeSpanId(call_id)).toBe(span.spanId);
        if (Object.keys(rest).length) span.attributes["traceroot.span.metadata"] = JSON.stringify(rest);
        else delete span.attributes["traceroot.span.metadata"];
      }
      expect(JSON.stringify(spans)).toBe(JSON.stringify(golden[fixture]![context]));
    },
  );
});

describe("capture_images setting", () => {
  const saved = { ...process.env };
  let home: string;
  let dir: string | undefined;
  beforeEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("TRACE")) delete process.env[k];
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tr-codexhome-"));
    process.env.CODEX_HOME = home;
  });
  afterEach(() => {
    process.env = { ...saved };
    fs.rmSync(home, { recursive: true, force: true });
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is off by default", async () => {
    expect((await getConfig()).captureImages).toBe(false);
  });

  it.each(["true", "1"])("is on with TRACEROOT_CODEX_CAPTURE_IMAGES=%s", async (value) => {
    process.env.TRACEROOT_CODEX_CAPTURE_IMAGES = value;
    expect((await getConfig()).captureImages).toBe(true);
  });

  it("reads capture_images from the global traceroot.json", async () => {
    fs.writeFileSync(path.join(home, "traceroot.json"), JSON.stringify({ capture_images: true }));
    expect((await getConfig()).captureImages).toBe(true);
  });

  /** A project dir whose checked-in .codex/traceroot.json holds `json`. */
  function projectWith(json: Record<string, unknown>): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-proj-"));
    fs.mkdirSync(path.join(dir, ".codex"));
    fs.writeFileSync(path.join(dir, ".codex", "traceroot.json"), JSON.stringify(json));
    return dir;
  }

  it("ignores capture_images in a project's .codex/traceroot.json", async () => {
    expect((await getConfig(projectWith({ capture_images: true }))).captureImages).toBe(false);
  });

  it("keeps the global setting whatever the project config says", async () => {
    fs.writeFileSync(path.join(home, "traceroot.json"), JSON.stringify({ capture_images: true }));
    expect((await getConfig(projectWith({ capture_images: false }))).captureImages).toBe(true);
  });

  it("lets the env var turn it off over traceroot.json", async () => {
    fs.writeFileSync(path.join(home, "traceroot.json"), JSON.stringify({ capture_images: true }));
    process.env.TRACEROOT_CODEX_CAPTURE_IMAGES = "false";
    expect((await getConfig()).captureImages).toBe(false);
  });

  it("is passed to span planning by dispatch", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-img-"));
    const transcript = path.join(dir, "rollout.jsonl");
    fs.copyFileSync(path.join(fixtures, "rollout-tool-image.jsonl"), transcript);
    const png = await fixtureImage("rollout-tool-image.jsonl", "png");
    const config: Config = {
      enabled: true, apiKey: "tr-x", hostUrl: "http://127.0.0.1:9", maxChars: 64, maxRequestBytes: 12 * MiB,
      debug: false, failOnError: true, captureImages: true,
    };
    const mem = new InMemorySpanExporter();
    await dispatch({ transcript_path: transcript }, config, { buildTracing: () => memTracing(mem), getGit: async () => ({}) });
    const tool = mem.getFinishedSpans().find((s) => s.attributes["traceroot.span.type"] === "TOOL")!;
    expect(String(tool.attributes[OUTPUT])).toContain(png);
  });
});
