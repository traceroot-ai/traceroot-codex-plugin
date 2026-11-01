import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type Config = {
  enabled: boolean;
  apiKey?: string;
  hostUrl: string;
  environment?: string;
  userId?: string;
  maxChars: number;
  maxRequestBytes: number;
  debug: boolean;
  failOnError: boolean;
};

// Default target for the estimated size of one export request. It leaves
// headroom under the ingest endpoint's request size limit.
const DEFAULT_MAX_REQUEST_BYTES = 12 * 1024 * 1024;

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function envFirst(...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

export async function getConfig(cwd: string = process.cwd()): Promise<Config> {
  // Resolve CODEX_HOME at call time (not module load) so it always reflects the
  // current env and is isolatable in tests.
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const globalJson = await readJson(path.join(codexHome, "traceroot.json"));
  const projectJson = await readJson(path.join(cwd, ".codex", "traceroot.json"));
  const j = { ...globalJson, ...projectJson };

  const truthy = (v: unknown) => v === true || v === "true" || v === "1";

  const enabledFlag =
    envFirst("TRACE_TO_TRACEROOT") ?? (j.enabled !== undefined ? String(j.enabled) : undefined);
  // Credential + upload destination come ONLY from env or the GLOBAL config
  // (~/.codex/traceroot.json) — never the project-local .codex/traceroot.json.
  // A checked-in project config that could set host_url/api_key would let a
  // malicious repo redirect authenticated uploads (your env/global key) to an
  // attacker endpoint. Project-local config may still set non-sensitive fields.
  const apiKey =
    envFirst("TRACEROOT_CODEX_API_KEY", "TRACEROOT_API_KEY") ?? (globalJson.api_key as string | undefined);

  const config: Config = {
    apiKey,
    hostUrl:
      envFirst("TRACEROOT_CODEX_HOST_URL", "TRACEROOT_HOST_URL") ??
      (globalJson.host_url as string | undefined) ??
      "https://app.traceroot.ai",
    environment: envFirst("TRACEROOT_ENVIRONMENT") ?? (j.environment as string | undefined),
    userId: envFirst("TRACEROOT_CODEX_USER_ID") ?? (j.user_id as string | undefined),
    maxChars: (n => Number.isFinite(n) ? n : 20000)(Number(envFirst("TRACEROOT_CODEX_MAX_CHARS") ?? j.max_chars ?? 20000)),
    maxRequestBytes: (n => Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_REQUEST_BYTES)(
      Number(envFirst("TRACEROOT_CODEX_MAX_REQUEST_BYTES") ?? j.max_request_bytes ?? DEFAULT_MAX_REQUEST_BYTES),
    ),
    debug: truthy(envFirst("TRACEROOT_CODEX_DEBUG") ?? j.debug),
    failOnError: truthy(envFirst("TRACEROOT_CODEX_FAIL_ON_ERROR") ?? j.fail_on_error),
    enabled: false,
  };
  config.enabled = truthy(enabledFlag) && Boolean(apiKey);
  return config;
}
