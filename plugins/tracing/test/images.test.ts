import { describe, expect, it } from "vitest";
import {
  capWithImages, decodedBytes, fitSpanImages, MAX_SPAN_BYTES, OVERSIZE_IMAGE, replaceImages, SPAN_TOO_LARGE_IMAGE,
} from "../src/images.js";
import { attributesBytes } from "../src/size.js";
import { truncate } from "../src/util.js";

const MiB = 1024 * 1024;
// A real 4x4 PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGO4IycHRwzEcQDTIxGBFNCZswAAAABJRU5ErkJggg==";
/** A syntactically valid data URL whose payload decodes to exactly `bytes` bytes. */
const imageOf = (bytes: number, mime = "png"): string => {
  const chars = Math.ceil(bytes / 3) * 4;
  const padding = (3 - (bytes % 3)) % 3;
  return `data:image/${mime};base64,${"A".repeat(chars - padding)}${"=".repeat(padding)}`;
};
const plain = (v: unknown, max: number): string => truncate(typeof v === "string" ? v : JSON.stringify(v ?? ""), max);

describe("decodedBytes", () => {
  it.each([[1], [2], [3], [4], [5 * MiB]])("measures a %i-byte payload", (bytes) => {
    expect(decodedBytes(imageOf(bytes))).toBe(bytes);
  });
  it("measures a real PNG", () => {
    expect(decodedBytes(PNG)).toBe(73);
  });
});

describe("capWithImages", () => {
  const items = (text: string, image = PNG) => [
    { type: "input_text", text },
    { type: "input_image", image_url: image },
  ];

  it.each<[string, unknown, number]>([
    ["a short string", "a.txt\nb.txt", 20000],
    ["a long string", "x".repeat(500), 64],
    ["an object", { output: "y".repeat(300), exit_code: 0 }, 64],
    ["undefined", undefined, 64],
    ["a non-image data URL", `data:image/svg+xml;base64,${"P".repeat(200)}`, 64],
  ])("cuts %s without images exactly like the plain cut", (_label, value, max) => {
    expect(capWithImages(value, max)).toBe(plain(value, max));
  });

  it("keeps Codex content items whole when the text fits", () => {
    expect(capWithImages(items("Captured."), 64)).toBe(JSON.stringify(items("Captured.")));
  });

  it("cuts only the text, keeps the image whole, and stays valid JSON", () => {
    const parsed = JSON.parse(capWithImages(items("t".repeat(30000)), 20000));
    expect(parsed[0].type).toBe("input_text");
    expect(parsed[0].text).toBe(`${"t".repeat(19990)}…[truncated 10010 chars]`);
    expect(parsed[1]).toEqual({ type: "input_image", image_url: PNG });
  });

  it("keeps an image that comes after text which used up the budget", () => {
    const value = [{ type: "input_text", text: "a".repeat(100) }, { type: "input_text", text: "b".repeat(100) }, ...items("c")];
    // Every string counts toward the budget, so "input_text" takes 10 of the 50.
    const parsed = JSON.parse(capWithImages(value, 50));
    expect(parsed[0].text).toBe(`${"a".repeat(40)}…[truncated 60 chars]`);
    expect(parsed[1].type).toBe("input_text"); // never replaced by a longer marker
    expect(parsed[1].text).toBe("…[truncated 100 chars]");
    expect(parsed[2]).toEqual({ type: "input_text", text: "c" });
    expect(parsed[3]).toEqual({ type: "input_image", image_url: PNG });
  });

  it("keeps the image item when content items arrive as serialized JSON and the text is cut", () => {
    const parsed = JSON.parse(capWithImages(JSON.stringify(items("t".repeat(21000))), 20000));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ type: "input_text", text: `${"t".repeat(19990)}…[truncated 1010 chars]` });
    expect(parsed[1]).toEqual({ type: "input_image", image_url: PNG });
  });

  it("leaves serialized JSON with images exactly as it was when the text fits", () => {
    const s = JSON.stringify(items("Captured."), null, 2);
    expect(capWithImages(s, 20000)).toBe(s);
  });

  it("cuts a string that only looks like JSON as one string", () => {
    const s = `[not json ${"r".repeat(100)} ${PNG}`;
    expect(capWithImages(s, 20)).toBe(`${"[not json ".padEnd(20, "r")}…[truncated 91 chars]${PNG}`);
  });

  it("keeps a data URL inside a plain string whole and cuts the text around it", () => {
    const s = `${"p".repeat(100)} ${PNG} and ${PNG} ${"q".repeat(100)}`;
    expect(capWithImages(s, 20)).toBe(
      `${"p".repeat(20)}…[truncated 81 chars]${PNG} and ${PNG}…[truncated 101 chars]`,
    );
  });

  it("replaces an image over 5 MiB decoded with a placeholder and keeps the text", () => {
    const parsed = JSON.parse(capWithImages(items("Captured.", imageOf(5 * MiB + 1)), 20000));
    expect(parsed).toEqual(items("Captured.", OVERSIZE_IMAGE));
  });

  it("keeps an image of exactly 5 MiB", () => {
    const big = imageOf(5 * MiB, "jpeg");
    expect(JSON.parse(capWithImages(items("x", big), 20000))[1].image_url).toBe(big);
  });

  it("accepts PNG, JPEG, GIF and WebP data URLs", () => {
    for (const mime of ["png", "jpeg", "jpg", "gif", "webp"]) {
      const url = imageOf(30, mime);
      expect(capWithImages(`${url} ${"z".repeat(50)}`, 10)).toBe(`${url} ${"z".repeat(9)}…[truncated 41 chars]`);
    }
  });
});

describe("replaceImages", () => {
  it("replaces every image anywhere in the value", () => {
    const value = [{ name: "exec", output: [{ type: "input_image", image_url: PNG }, { type: "input_text", text: `see ${PNG}` }] }];
    expect(replaceImages(value, "[image: see tool call c1]")).toEqual([
      { name: "exec", output: [{ type: "input_image", image_url: "[image: see tool call c1]" }, { type: "input_text", text: "see [image: see tool call c1]" }] },
    ]);
  });

  it("leaves a value without images serializing exactly as before", () => {
    const value = [{ name: "exec", output: { stdout: "ok", n: 1, ok: true, none: null, gone: undefined } }, "text"];
    expect(JSON.stringify(replaceImages(value, "[x]"))).toBe(JSON.stringify(value));
    expect(replaceImages("plain", "[x]")).toBe("plain");
  });

  it("inserts the placeholder literally", () => {
    expect(replaceImages(PNG, "[image: see tool call $&]")).toBe("[image: see tool call $&]");
  });
});

describe("fitSpanImages", () => {
  it("leaves a span within 8 MiB untouched", () => {
    const attrs = { "traceroot.span.output": `${imageOf(4 * MiB)} done` };
    const before = { ...attrs };
    fitSpanImages(attrs);
    expect(attrs).toEqual(before);
  });

  it("replaces images largest first until the span fits", () => {
    const [large, medium, small] = [imageOf(4.5 * MiB), imageOf(4 * MiB), imageOf(MiB)];
    const attrs: Record<string, string | number> = {
      "traceroot.span.input": `before ${medium}`,
      "traceroot.span.output": JSON.stringify([{ type: "input_image", image_url: large }, { type: "input_image", image_url: small }]),
      "llm.token_count.prompt": 10,
    };
    expect(attributesBytes(attrs)).toBeGreaterThan(MAX_SPAN_BYTES);
    fitSpanImages(attrs);

    expect(attributesBytes(attrs)).toBeLessThanOrEqual(MAX_SPAN_BYTES);
    expect(attrs["traceroot.span.output"]).toBe(JSON.stringify([
      { type: "input_image", image_url: SPAN_TOO_LARGE_IMAGE }, { type: "input_image", image_url: small },
    ]));
    expect(attrs["traceroot.span.input"]).toBe(`before ${medium}`);
  });

  it("keeps replacing while the span is still too large", () => {
    const image = imageOf(3.5 * MiB);
    const attrs = { "traceroot.span.output": `${image} ${image} ${image}` };
    fitSpanImages(attrs);
    expect(attrs["traceroot.span.output"]).toBe(`${SPAN_TOO_LARGE_IMAGE} ${SPAN_TOO_LARGE_IMAGE} ${image}`);
  });
});
