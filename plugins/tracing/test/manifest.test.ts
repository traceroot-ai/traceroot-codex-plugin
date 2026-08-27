import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("plugin manifest", () => {
  it("plugin.json references hooks file and has name/version", async () => {
    const m = JSON.parse(await fs.readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf-8"));
    expect(m.name).toBe("tracing");
    expect(m.version).toBe("0.1.0");
    expect(m.hooks).toBe("./hooks/hooks.json");
  });

  it("hooks.json resolves the dist bundle from the installed plugin root", async () => {
    const h = JSON.parse(await fs.readFile(path.join(root, "hooks", "hooks.json"), "utf-8"));
    for (const ev of ["PostToolUse", "Stop", "SubagentStop"]) {
      expect(h.hooks[ev]).toBeDefined();
      const cmd = h.hooks[ev][0].hooks[0].command;
      expect(cmd).toBe('node "$PLUGIN_ROOT/dist/index.mjs"');
      expect(cmd).not.toContain("/plugins/cache/");
    }
  });
});
