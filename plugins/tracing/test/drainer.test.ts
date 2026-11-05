import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DRAIN_ARG, spawnDrainer } from "../src/drainer.js";

let dir: string;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

// Stands in for the bundle: records how it was started, then exits.
const ENTRY = `
import { execFileSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
const [, , flag, session] = process.argv;
const group = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf-8" }).trim());
const out = JSON.parse(session).cwd + "/started.json";
writeFileSync(out + ".tmp", JSON.stringify({ flag, session: JSON.parse(session), pid: process.pid, group }));
renameSync(out + ".tmp", out);
`;

describe("spawnDrainer", () => {
  it.skipIf(process.platform === "win32")(
    "starts the bundle as a drainer for the hook's session, leading a process group of its own",
    async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "tr-drainer-"));
      const entry = path.join(dir, "entry.mjs");
      await fs.writeFile(entry, ENTRY);
      const started = path.join(dir, "started.json");

      spawnDrainer({ session_id: "s", hook_event_name: "Stop", transcript_path: "/r/rollout.jsonl", cwd: dir }, entry);
      for (const at = Date.now(); !(await fs.access(started).then(() => true, () => false));) {
        if (Date.now() - at > 5_000) throw new Error("the drainer never started");
        await new Promise((r) => setTimeout(r, 10));
      }

      const seen = JSON.parse(await fs.readFile(started, "utf-8"));
      expect(seen.flag).toBe(DRAIN_ARG);
      expect(seen.session).toEqual({ transcript_path: "/r/rollout.jsonl", cwd: dir });
      // Killing the hook's process group, as Codex does when a hook times out, misses it.
      expect(seen.group).toBe(seen.pid);
    },
  );

  it("does not throw when the drainer cannot be started", () => {
    expect(() => spawnDrainer({ transcript_path: "/r/rollout.jsonl" }, "no\0entry")).not.toThrow();
  });
});
