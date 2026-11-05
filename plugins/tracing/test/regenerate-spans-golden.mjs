/**
 * Rewrites fixtures/spans-golden.json with the spans the planner at BASE, a
 * commit on main, produces for the current fixtures in the contexts from
 * golden.ts. It never uses the current sources: the file is what shows that
 * existing rollouts still produce the same spans, so rebuilding it from the code
 * under test would hide exactly the change it is there to catch.
 *
 * Run with: pnpm run regenerate:golden
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";

const BASE = "0065794ad750244029232dc83862c0618ca6d569";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(testDir, "../../..");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "inherit" });

// The temporary checkout has no node_modules, so the planner's one package
// dependency resolves from this checkout.
const load = async (file) =>
  (await runnerImport(file, { root: repo, resolve: { dedupe: ["@opentelemetry/api"] } })).module;

async function regenerate(src) {
  const { planTurnSpans } = await load(path.join(src, "spans.ts"));
  const { parseRollout, readRollout } = await load(path.join(src, "transcript.ts"));
  const { GOLDEN_CONTEXTS, GOLDEN_FIXTURES } = await load(path.join(testDir, "golden.ts"));
  const golden = {};
  for (const fixture of GOLDEN_FIXTURES) {
    const { sessionMeta, turns } = parseRollout(await readRollout(path.join(testDir, "fixtures", fixture)));
    golden[fixture] = Object.fromEntries(Object.entries(GOLDEN_CONTEXTS).map(
      ([name, ctx]) => [name, turns.flatMap((turn) => planTurnSpans(sessionMeta, turn, ctx))],
    ));
  }
  fs.writeFileSync(path.join(testDir, "fixtures", "spans-golden.json"), `${JSON.stringify(golden, null, 2)}\n`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spans-golden-"));
const base = path.join(tmp, "base");
try {
  git("worktree", "add", "--detach", "--quiet", base, BASE);
  try {
    await regenerate(path.join(base, "plugins", "tracing", "src"));
  } finally {
    git("worktree", "remove", "--force", base);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`Wrote plugins/tracing/test/fixtures/spans-golden.json from ${BASE.slice(0, 12)}`);
