import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, getConfig } from "../src/config.js";
import { dispatch } from "../src/emit.js";
import { MAX_SPAN_BYTES, OVERSIZE_IMAGE, SPAN_TOO_LARGE_IMAGE } from "../src/images.js";
import { attributesBytes } from "../src/size.js";
import { type EmitCtx, type EmittableSpan, planTurnSpans } from "../src/spans.js";
import { parseRollout, readRollout } from "../src/transcript.js";
import type { SessionMeta, Turn } from "../src/types.js";
import { memTracing } from "./helpers.js";

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
const turnWith = (patch: Partial<Turn>, output?: unknown): Turn => ({
  turnId: "turn-big", startTime: 0, endTime: 10, model: "gpt-5.5", completed: true, aborted: false,
  userInput: "go", ...patch,
  steps: [{
    index: 0, startTime: 1, endTime: 2, usage: { input_tokens: 1 },
    toolCalls: output === undefined ? [] : [{ callId: "call-big", name: "exec", args: "shot()", startTime: 1, endTime: 2, output }],
  }],
});

describe("image capture on: tool output", () => {
  it("keeps the screenshot data URL whole in the tool span output", async () => {
    const png = await fixtureImage("rollout-tool-image.jsonl", "png");
    const tool = (await plan("rollout-tool-image.jsonl", on)).find((s) => s.kind === "TOOL");
    expect(JSON.parse(attr(tool, OUTPUT))).toEqual([
      { type: "input_text", text: "Captured a 4x4 screenshot." },
      { type: "input_image", image_url: png },
    ]);
  });

  it("puts a placeholder, not a second copy, into the next model call's input", async () => {
    const steps = (await plan("rollout-tool-image.jsonl", { ...on, maxChars: 20000 })).filter((s) => s.kind === "LLM");
    const next = attr(steps[1], INPUT);
    expect(next).toContain("[image: see tool call call-shot]");
    expect(next).not.toContain("data:image");
    expect(JSON.parse(next)[0].output[1]).toEqual({ type: "input_image", image_url: "[image: see tool call call-shot]" });
  });

  it("cuts long tool text at maxChars but keeps the image after it", () => {
    const output = [{ type: "input_text", text: "t".repeat(30000) }, { type: "input_image", image_url: imageOf(3000) }];
    const tool = planTurnSpans(sessionMeta, turnWith({}, output), { ...on, maxChars: 20000 }).find((s) => s.kind === "TOOL");
    const parsed = JSON.parse(attr(tool, OUTPUT));
    expect(parsed[0].text).toMatch(/…\[truncated 10010 chars\]$/);
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
  it("puts the attached image in the turn input and the first model call's input", async () => {
    const jpeg = await fixtureImage("rollout-prompt-image.jsonl", "jpeg");
    const spans = await plan("rollout-prompt-image.jsonl", on);
    const expected = [{ type: "input_text", text: "what colour is this image?" }, { type: "input_image", image_url: jpeg }];
    expect(JSON.parse(attr(spans.find((s) => s.kind === "AGENT"), INPUT))).toEqual(expected);
    expect(JSON.parse(attr(spans.find((s) => s.kind === "LLM"), INPUT))).toEqual(expected);
  });

  it("sends an image-only prompt as the image alone", () => {
    const png = imageOf(30);
    const root = planTurnSpans(sessionMeta, turnWith({ userInput: undefined, userImages: [png] }), on)[0]!;
    expect(JSON.parse(attr(root, INPUT))).toEqual([{ type: "input_image", image_url: png }]);
  });

  it("fits prompt images into 8 MiB on the turn span too", () => {
    const [a, b] = [imageOf(4.5 * MiB), imageOf(4 * MiB)];
    const spans = planTurnSpans(sessionMeta, turnWith({ userImages: [a, b] }), on);
    for (const span of spans) expect(attributesBytes(span.attributes)).toBeLessThanOrEqual(MAX_SPAN_BYTES);
    expect(JSON.parse(attr(spans[0], INPUT))[1].image_url).toBe(SPAN_TOO_LARGE_IMAGE);
    expect(JSON.parse(attr(spans[0], INPUT))[2].image_url).toBe(b);
  });
});

describe("image capture off", () => {
  const golden = JSON.parse(fs.readFileSync(path.join(fixtures, "spans-golden.json"), "utf-8")) as
    Record<string, Record<string, unknown>>;
  const contexts: Record<string, EmitCtx> = {
    full: {
      environment: "dev", userId: "user-1", git: { repo: "traceroot-ai/traceroot", ref: "a".repeat(40) },
      maxChars: 20000, turnEnding: true,
    },
    tight: { maxChars: 64 },
  };
  const cases = Object.keys(golden).flatMap((f) => Object.keys(contexts).map((c) => [f, c] as const));

  it.each(cases)("%s (%s context) is byte-identical to the pinned output", async (fixture, context) => {
    const spans = await plan(fixture, { ...contexts[context]!, captureImages: false });
    expect(JSON.stringify(spans)).toBe(JSON.stringify(golden[fixture]![context]));
  });

  it.each(cases.filter(([f]) => !f.includes("image")))(
    "%s (%s context) without images is unchanged with capture on too",
    async (fixture, context) => {
      const spans = await plan(fixture, { ...contexts[context]!, captureImages: true });
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

  it("reads capture_images from traceroot.json", async () => {
    fs.writeFileSync(path.join(home, "traceroot.json"), JSON.stringify({ capture_images: true }));
    expect((await getConfig()).captureImages).toBe(true);
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
