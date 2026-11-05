import type { Attributes } from "@opentelemetry/api";
import {
  capWithImages, FIRST_CALL_IMAGE, fitSpanImages, imagesIn, modelCallImage, omittedImage, replaceImages, toolCallImage,
} from "./images.js";
import type { ModelStep, ToolCall } from "./types.js";
import { str } from "./util.js";

/** How span planning renders content. Dispatch picks one from the capture_images setting. */
export type ContentPolicy = {
  /** A span input or output capped at `max` characters. */
  io(value: unknown, max: number): string;
  /** A model call's input, given the text the model got before it. */
  callInput(text: unknown, step: ModelStep): unknown;
  /** A tool's output as the next model call is shown it. */
  fedBack(tc: ToolCall, toolAttrs: Attributes): unknown;
  /** The turn span's input, given each model call and its fitted attributes. */
  turnInput(userInput: string | undefined, calls: ReadonlyArray<[ModelStep, Attributes]>): unknown;
  /** Brings a span's attributes within the span size limit. */
  fit(attrs: Attributes): void;
  /** Adds what a tool span's metadata needs under this policy. */
  toolMeta(tc: ToolCall, meta: Record<string, unknown>): void;
};

/** Image capture off: every value takes the plain maxChars cut. */
export const textPolicy: ContentPolicy = {
  io: str,
  callInput: (text) => text,
  fedBack: (tc) => tc.output,
  turnInput: (userInput) => userInput,
  fit: () => {},
  toolMeta: () => {},
};

/** `text`, then `images` as content items like a Codex user message; just `text` without images. */
const withImages = (text: unknown, images: string[]): unknown => (images.length === 0 ? text : [
  ...(text ? [{ type: "input_text", text }] : []),
  ...images.map((url) => ({ type: "input_image", image_url: url })),
]);

/** Image capture on: images stay whole, then the largest give way until a span fits in 8 MiB. */
export const imagePolicy: ContentPolicy = {
  io: capWithImages,
  // Adds the images sent with the user message before the call.
  callInput: (text, step) => withImages(text, step.userImages ?? []),
  // Each image points at the tool span that already holds it instead of being sent twice.
  fedBack: (tc, toolAttrs) =>
    replaceImages(tc.output, toolCallImage(tc.callId), imagesIn(toolAttrs["traceroot.span.output"])),
  // The turn span is re-sent on every hook, so it never carries image bytes: each
  // image a user sent points at the model call span that holds it, which is sent once.
  turnInput(userInput, calls) {
    const turnImages: string[] = [];
    let firstCallImages: Set<string> | undefined;
    for (const [step, attrs] of calls) {
      const kept = imagesIn(attrs["traceroot.span.input"]);
      if (step.index === 0) firstCallImages = kept;
      for (const url of step.userImages ?? []) {
        turnImages.push(kept.has(url) ? modelCallImage(step.index) : omittedImage(url));
      }
    }
    return withImages(replaceImages(userInput, FIRST_CALL_IMAGE, firstCallImages), turnImages);
  },
  fit: fitSpanImages,
  // Matches the tool span to the "[image: see tool call <call_id>]" placeholders.
  toolMeta: (tc, meta) => { meta["call_id"] = tc.callId; },
};
