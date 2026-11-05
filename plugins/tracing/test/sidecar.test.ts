import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEmittedSpanIds, markSpansEmitted } from "../src/sidecar.js";

vi.mock("node:fs/promises", async (orig) => {
  const actual = await orig<typeof import("node:fs/promises")>();
  return { ...actual, appendFile: vi.fn(actual.appendFile) };
});

let dir: string;
afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });

describe("sidecar", () => {
  it("returns empty set when no sidecar file", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tr-"));
    const f = path.join(dir, "rollout.jsonl");
    expect((await loadEmittedSpanIds(f)).size).toBe(0);
  });

  it("round-trips emitted ids", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tr-"));
    const f = path.join(dir, "rollout.jsonl");
    await markSpansEmitted(f, ["span-a"]);
    await markSpansEmitted(f, ["span-b", "span-c"]);
    const ids = await loadEmittedSpanIds(f);
    expect([...ids].sort()).toEqual(["span-a", "span-b", "span-c"]);
  });

  it("writes a list of ids in one append, and nothing for an empty list", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tr-"));
    const f = path.join(dir, "rollout.jsonl");
    const appendFile = vi.mocked(fs.appendFile);
    appendFile.mockClear();

    await markSpansEmitted(f, []);
    await expect(fs.access(`${f}.traceroot`)).rejects.toThrow();
    await markSpansEmitted(f, ["span-a", "span-b", "span-c"]);

    expect(appendFile).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(`${f}.traceroot`, "utf-8")).toBe("span-a\nspan-b\nspan-c\n");
  });

  it("fails open (empty set) on a non-ENOENT read error", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tr-"));
    const f = path.join(dir, "rollout.jsonl");
    // Make the sidecar path a directory so readFile throws EISDIR (not ENOENT).
    // The whole plugin is fail-open: an unreadable sidecar must degrade to
    // "nothing emitted yet", never abort emission.
    await fs.mkdir(`${f}.traceroot`);
    const ids = await loadEmittedSpanIds(f);
    expect(ids.size).toBe(0);
  });
});
