import type { Attributes, TraceState } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

// Upper bounds on OTLP protobuf framing: the field tags, length prefixes and
// fixed-size fields (ids, timestamps, kind, status, flags) of one span, event or
// link, and the KeyValue/AnyValue wrapping of one attribute or array element.
const SPAN_OVERHEAD_BYTES = 256;
const ATTRIBUTE_OVERHEAD_BYTES = 32;

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

function valueBytes(value: unknown): number {
  if (typeof value === "string") return utf8Bytes(value);
  if (Array.isArray(value)) {
    return value.reduce<number>((n, v) => n + ATTRIBUTE_OVERHEAD_BYTES + valueBytes(v), 0);
  }
  return 10; // number or boolean: at most a 10-byte varint
}

/** Estimated serialized size of span attributes, never below the real size. */
export function attributesBytes(attributes: Attributes): number {
  let n = 0;
  for (const [key, value] of Object.entries(attributes)) {
    n += ATTRIBUTE_OVERHEAD_BYTES + utf8Bytes(key) + valueBytes(value);
  }
  return n;
}

const traceStateBytes = (state: TraceState | undefined): number => utf8Bytes(state?.serialize() ?? "");

/** Estimated size `span` adds to an OTLP protobuf request, never below the real size. */
export function estimateSpanBytes(span: ReadableSpan): number {
  let n = SPAN_OVERHEAD_BYTES + utf8Bytes(span.name) + utf8Bytes(span.status.message ?? "")
    + traceStateBytes(span.spanContext().traceState) + attributesBytes(span.attributes);
  for (const event of span.events) {
    n += SPAN_OVERHEAD_BYTES + utf8Bytes(event.name) + attributesBytes(event.attributes ?? {});
  }
  for (const link of span.links) {
    n += SPAN_OVERHEAD_BYTES + traceStateBytes(link.context.traceState) + attributesBytes(link.attributes ?? {});
  }
  return n;
}

/**
 * Splits `spans`, keeping their order, into groups whose estimated size stays
 * within `maxBytes`. A span larger than `maxBytes` on its own forms its own group.
 */
export function splitBySize(spans: ReadableSpan[], maxBytes: number): ReadableSpan[][] {
  const groups: ReadableSpan[][] = [];
  let group: ReadableSpan[] = [];
  let size = 0;
  for (const span of spans) {
    const bytes = estimateSpanBytes(span);
    if (group.length > 0 && size + bytes > maxBytes) {
      groups.push(group);
      group = [];
      size = 0;
    }
    group.push(span);
    size += bytes;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}
