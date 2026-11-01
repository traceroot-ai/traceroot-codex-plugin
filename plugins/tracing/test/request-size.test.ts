import { type Attributes, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import { TraceState } from "@opentelemetry/core";
import { type ReadableSpan, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildTracingWith } from "../src/exporter.js";
import { PrimedIdGenerator } from "../src/ids.js";
import { attributesBytes, estimateSpanBytes, splitBySize } from "../src/size.js";
import { ScriptedExporter } from "./helpers.js";

// The protobuf serializer the OTLP exporter itself uses, resolved through it.
const require = createRequire(import.meta.url);
const { ProtobufTraceSerializer } = createRequire(require.resolve("@opentelemetry/exporter-trace-otlp-proto"))(
  "@opentelemetry/otlp-transformer",
) as { ProtobufTraceSerializer: { serializeRequest(spans: ReadableSpan[]): Uint8Array } };
const requestBytes = (spans: ReadableSpan[]): number => ProtobufTraceSerializer.serializeRequest(spans).length;

const MiB = 1024 * 1024;
// The longest trace state the W3C format allows: 512 characters.
const LONGEST_TRACE_STATE = `a=${"x".repeat(254)},b=${"y".repeat(253)}`;

type SpanSpec = {
  name?: string;
  attributes?: Attributes;
  event?: { name: string; attributes: Attributes };
  link?: Attributes;
  linkTraceState?: string;
  statusMessage?: string;
  /** Trace state the span takes from its parent. */
  traceState?: string;
};

/** Real ReadableSpans built from specs, through the plugin's own tracing setup. */
async function makeSpans(specs: SpanSpec[]): Promise<ReadableSpan[]> {
  const sink = new ScriptedExporter();
  const tracing = buildTracingWith(new SimpleSpanProcessor(sink), new PrimedIdGenerator());
  const traceState = (raw?: string) => (raw === undefined ? undefined : new TraceState(raw));
  for (const spec of specs) {
    const parent = spec.traceState === undefined ? ROOT_CONTEXT : trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "c".repeat(32), spanId: "d".repeat(16), traceFlags: 1, traceState: traceState(spec.traceState),
    });
    const span = tracing.tracer.startSpan(spec.name ?? "span", {
      attributes: spec.attributes,
      links: spec.link ? [{
        context: {
          traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1, traceState: traceState(spec.linkTraceState),
        },
        attributes: spec.link,
      }] : [],
    }, parent);
    if (spec.event) span.addEvent(spec.event.name, spec.event.attributes);
    if (spec.statusMessage) span.setStatus({ code: SpanStatusCode.ERROR, message: spec.statusMessage });
    span.end();
  }
  await tracing.shutdown();
  return sink.calls.flat();
}

describe("estimateSpanBytes", () => {
  const specs: Array<[string, SpanSpec]> = [
    ["a bare span", {}],
    ["a long ASCII attribute", { attributes: { "traceroot.span.output": "x".repeat(100_000) } }],
    ["multi-byte text", { name: "名前", attributes: { "traceroot.span.input": "héllo 🌍 世界".repeat(1000) } }],
    ["string arrays", { attributes: { "traceroot.span.path": ["Codex Turn", "exec_command", "ünïcode"] } }],
    ["numbers and booleans", {
      attributes: { "llm.token_count.prompt": 1200, negative: -1, big: Number.MAX_SAFE_INTEGER, ratio: 0.25, flag: true },
    }],
    ["events, links and a status message", {
      event: { name: "exception", attributes: { "exception.message": "boom".repeat(50) } },
      link: { "link.reason": "follows" },
      statusMessage: "failed".repeat(20),
    }],
    ["many small attributes", {
      attributes: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`attr.${i}`, `value-${i}`])),
    }],
    ["a trace state of the longest valid length", { traceState: LONGEST_TRACE_STATE }],
    ["a link with a trace state of the longest valid length", { link: {}, linkTraceState: LONGEST_TRACE_STATE }],
  ];

  it.each(specs)("never underestimates the serialized size of %s", async (_label, spec) => {
    const [anchor, span] = await makeSpans([{ name: "anchor" }, spec]);
    // What adding this span to a request costs, net of the resource and scope.
    const added = requestBytes([anchor!, span!]) - requestBytes([anchor!]);
    expect(estimateSpanBytes(span!)).toBeGreaterThanOrEqual(added);
  });

  it("stays close to the real size for a large span", async () => {
    const [anchor, span] = await makeSpans([{ name: "anchor" }, { attributes: { out: "y".repeat(5 * MiB) } }]);
    const added = requestBytes([anchor!, span!]) - requestBytes([anchor!]);
    expect(estimateSpanBytes(span!) - added).toBeLessThan(512);
  });

  it("counts attribute values by their UTF-8 size", () => {
    expect(attributesBytes({ k: "é" }) - attributesBytes({ k: "e" })).toBe(1);
    expect(attributesBytes({})).toBe(0);
  });

  it("counts the trace state of the span and of each link by its length", async () => {
    const [bare, own, linkedBare, linked] = await makeSpans([
      {}, { traceState: LONGEST_TRACE_STATE }, { link: {} }, { link: {}, linkTraceState: LONGEST_TRACE_STATE },
    ]);
    expect(own!.spanContext().traceState?.serialize()).toHaveLength(512);
    expect(linked!.links[0]!.context.traceState?.serialize()).toHaveLength(512);
    expect(estimateSpanBytes(own!) - estimateSpanBytes(bare!)).toBe(512);
    expect(estimateSpanBytes(linked!) - estimateSpanBytes(linkedBare!)).toBe(512);
  });
});

describe("splitBySize", () => {
  it("keeps 1,024 small spans in one group", async () => {
    const spans = await makeSpans(Array.from({ length: 1024 }, (_, i) => ({ attributes: { i, text: "ok" } })));
    expect(splitBySize(spans, 12 * MiB)).toEqual([spans]);
  });

  it("splits spans totalling 30 MiB into groups that each serialize under the budget", async () => {
    const budget = 12 * MiB;
    const spans = await makeSpans(Array.from({ length: 30 }, () => ({ attributes: { out: "z".repeat(MiB) } })));
    const groups = splitBySize(spans, budget);

    expect(groups.length).toBeGreaterThanOrEqual(3);
    expect(groups.flat()).toEqual(spans); // nothing lost, order kept
    for (const group of groups) {
      expect(group.reduce((n, s) => n + estimateSpanBytes(s), 0)).toBeLessThanOrEqual(budget);
      expect(requestBytes(group)).toBeLessThanOrEqual(budget);
    }
  });

  it("puts a span larger than the budget in a group of its own", async () => {
    const [small1, huge, small2] = await makeSpans([
      { attributes: { a: "1" } }, { attributes: { out: "h".repeat(2 * MiB) } }, { attributes: { b: "2" } },
    ]);
    expect(splitBySize([small1!, huge!, small2!], MiB)).toEqual([[small1], [huge], [small2]]);
  });

  it("returns no groups for no spans", () => {
    expect(splitBySize([], MiB)).toEqual([]);
  });
});
