import type { Attributes } from "@opentelemetry/api";
import { attributesBytes } from "./size.js";
import { truncate } from "./util.js";

// Base64 image data URLs in the formats the TraceRoot backend stores as attachments.
const IMAGE_DATA_URL = /data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}/g;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_SPAN_BYTES = 8 * 1024 * 1024;
export const OVERSIZE_IMAGE = "[image omitted: larger than 5 MiB]";
export const SPAN_TOO_LARGE_IMAGE = "[image omitted: span larger than 8 MiB]";

/** Decoded size of a base64 data URL's payload, in bytes. */
export function decodedBytes(dataUrl: string): number {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

/** Applies `fn` to every string in a JSON value, keeping its shape. */
function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

type Budget = { left: number };

/** Cuts `text` to what is left of the budget, unless the cut marker would be longer than the text it drops. */
function capText(text: string, budget: Budget): string {
  const cut = truncate(text, budget.left);
  budget.left = Math.max(0, budget.left - text.length);
  return cut.length < text.length ? cut : text;
}

function capString(s: string, budget: Budget): string {
  let out = "";
  let at = 0;
  for (const m of s.matchAll(IMAGE_DATA_URL)) {
    const image = decodedBytes(m[0]) > MAX_IMAGE_BYTES ? OVERSIZE_IMAGE : m[0];
    out += capText(s.slice(at, m.index), budget) + image;
    at = m.index + m[0].length;
  }
  return out + capText(s.slice(at), budget);
}

/**
 * Serializes `value` for a span attribute and caps it at `max` characters like
 * the plain cut, but keeps image data URLs whole: only the text counts toward
 * `max`, and strings are cut one by one so JSON stays valid. An image over
 * 5 MiB decoded becomes a placeholder. A value without images is cut exactly
 * as the plain cut does.
 */
export function capWithImages(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (text.search(IMAGE_DATA_URL) === -1) return truncate(text, max);
  const budget: Budget = { left: max };
  const cap = (s: string): string => capString(s, budget);
  return typeof value === "string" ? cap(value) : JSON.stringify(mapStrings(value, cap));
}

/** `value` with every image data URL in it replaced by `placeholder`. */
export function replaceImages(value: unknown, placeholder: string): unknown {
  return mapStrings(value, (s) => s.replace(IMAGE_DATA_URL, () => placeholder));
}

/**
 * Replaces image data URLs in `attributes` with a placeholder, largest first,
 * until the attributes' estimated size is within MAX_SPAN_BYTES.
 */
export function fitSpanImages(attributes: Attributes): void {
  let size = attributesBytes(attributes);
  if (size <= MAX_SPAN_BYTES) return;
  const images: Array<{ key: string; url: string }> = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== "string") continue;
    for (const m of value.matchAll(IMAGE_DATA_URL)) images.push({ key, url: m[0] });
  }
  images.sort((a, b) => b.url.length - a.url.length);
  for (const { key, url } of images) {
    if (size <= MAX_SPAN_BYTES) break;
    attributes[key] = (attributes[key] as string).replace(url, () => SPAN_TOO_LARGE_IMAGE);
    size -= url.length - SPAN_TOO_LARGE_IMAGE.length; // data URLs are ASCII: one byte per char
  }
}
