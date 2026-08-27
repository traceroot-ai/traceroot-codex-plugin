import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const pluginRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runShellCommand(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs?: number },
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      detached: useProcessGroup,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;

    const terminate = (signal: NodeJS.Signals): void => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.unref();
        return;
      }
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The group may already be gone; fall back to the direct child.
        }
      }
      child.kill(signal);
    };

    const timeout = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      terminate("SIGTERM");
      forceKill = setTimeout(() => { terminate("SIGKILL"); }, 1_000);
      forceKill.unref();
    }, options.timeoutMs ?? 10_000);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (timedOut) {
        reject(new Error("hook command timed out"));
        return;
      }
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}

afterEach(async () => {
  while (tempDirs.length) {
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("bundled hook command", () => {
  it("executes the Stop hook via PLUGIN_ROOT from an arbitrary cwd", async () => {
    const installedPluginRoot = await makeTempDir("traceroot-plugin-");
    const codexHome = await makeTempDir("traceroot-codex-home-");
    const sessionCwd = await makeTempDir("traceroot-session-");
    const installedBundle = path.join(installedPluginRoot, "dist", "index.mjs");
    await fs.mkdir(path.dirname(installedBundle), { recursive: true });
    await fs.copyFile(path.join(pluginRoot, "dist", "index.mjs"), installedBundle);

    const transcriptPath = path.join(sessionCwd, "rollout.jsonl");
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ timestamp: "2026-08-27T00:00:00.000Z", type: "session_meta", payload: { id: "sess-1" } }),
        JSON.stringify({ timestamp: "2026-08-27T00:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
        JSON.stringify({ timestamp: "2026-08-27T00:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "hello" } }),
        JSON.stringify({ timestamp: "2026-08-27T00:00:03.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
      ].join("\n"),
      "utf-8",
    );

    const hooks = JSON.parse(await fs.readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf-8")) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    const command = hooks.hooks.Stop[0]!.hooks[0]!.command;
    const result = await runShellCommand(command, {
      cwd: sessionCwd,
      env: {
        ...process.env,
        PLUGIN_ROOT: installedPluginRoot,
        CODEX_HOME: codexHome,
        TRACE_TO_TRACEROOT: "false",
        TRACEROOT_CODEX_DEBUG: "false",
        TRACEROOT_CODEX_FAIL_ON_ERROR: "false",
      },
      input: `${JSON.stringify({
        session_id: "sess-1",
        turn_id: "turn-1",
        hook_event_name: "Stop",
        transcript_path: transcriptPath,
        cwd: sessionCwd,
      })}\n`,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("terminates the shell process group when a hook command times out", async () => {
    const sessionCwd = await makeTempDir("traceroot-timeout-");
    const command = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;

    await expect(runShellCommand(command, {
      cwd: sessionCwd,
      env: { ...process.env },
      input: "",
      timeoutMs: 50,
    })).rejects.toThrow("hook command timed out");
  });
});
