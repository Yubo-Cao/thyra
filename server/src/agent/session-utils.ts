export function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function normalizeAgentName(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "pi-agent" || normalized === "pi-coding-agent")
    return "pi";
  if (normalized === "claude-code") return "claude";
  if (normalized === "muse-code" || normalized === "muse code") return "muse";
  if (normalized === "kimi-code" || normalized === "kimi code") return "kimi";
  if (normalized === "grok-build" || normalized === "grok build") return "grok";
  if (
    normalized === "antigravity" ||
    normalized === "antigravity-cli" ||
    normalized === "antigravity cli"
  ) {
    return "agy";
  }
  return normalized;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
