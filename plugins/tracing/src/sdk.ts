// Single source for the plugin's SDK identity. Used for the OTLP scope +
// request headers (exporter) and the traceroot.sdk.* span attributes (spans).
// Keep SDK_VERSION in sync with .codex-plugin/plugin.json + package.json.
export const SDK_NAME = "traceroot-codex-plugin";
export const SDK_VERSION = "0.1.1";
