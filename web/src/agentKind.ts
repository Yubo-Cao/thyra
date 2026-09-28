/**
 * Agent families Thyra recognises from Herdr's pane `agent` name, for icons
 * and agent-specific terminal behaviour (the prompt editor's detectors).
 */
export type AgentKind =
  | "pi"
  | "claude"
  | "codex"
  | "gemini"
  | "cursor"
  | "devin"
  | "agy"
  | "cline"
  | "omp"
  | "opencode"
  | "copilot"
  | "kimi"
  | "kiro"
  | "droid"
  | "amp"
  | "grok"
  | "hermes"
  | "kilo"
  | "qodercli"
  | "unknown";

/** The agent family of a Herdr pane `agent` name. */
export function agentKind(agent?: string): AgentKind {
  const name = (agent ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "")
    .replace(/[_\s]+/g, "-");

  if (!name) return "unknown";
  if (name === "pi" || name === "pi-agent" || name === "pi-coding-agent") {
    return "pi";
  }
  if (name === "claude" || name === "claude-code") return "claude";
  if (name === "codex") return "codex";
  if (name === "gemini") return "gemini";
  if (name === "cursor" || name === "cursor-agent") return "cursor";
  if (name === "devin" || name === "devin-cli") return "devin";
  if (name === "agy" || name === "antigravity" || name === "antigravity-cli") {
    return "agy";
  }
  if (name === "cline") return "cline";
  if (name === "omp") return "omp";
  if (name === "opencode" || name === "open-code") return "opencode";
  if (name === "copilot" || name === "github-copilot" || name === "ghcs") {
    return "copilot";
  }
  if (name === "kimi" || name === "kimi-code") return "kimi";
  if (name === "kiro" || name === "kiro-cli") return "kiro";
  if (name === "droid") return "droid";
  if (name === "amp" || name === "amp-local") return "amp";
  if (name === "grok" || name === "grok-build") return "grok";
  if (name === "hermes" || name === "hermes-agent") return "hermes";
  if (name === "kilo" || name === "kilo-code") return "kilo";
  if (
    name === "qodercli" ||
    name === "qoderclicn" ||
    name === "qoder" ||
    name === "qodercn"
  ) {
    return "qodercli";
  }
  return "unknown";
}
