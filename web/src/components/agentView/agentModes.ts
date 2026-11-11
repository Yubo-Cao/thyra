import type {
  AgentSessionInfo,
  AgentSessionMode,
} from "../../../../shared/agentSession";
import { msg, t } from "../../i18n";

/**
 * The permission modes the hosts offer (see `CODEX_MODES` and `CLAUDE_MODES`
 * on the server), labelled in the interface language. Each says both what
 * the agent asks first and how much it may touch, so a mode that never asks
 * but is still sandboxed does not read like full access.
 */
type ModeText = { label: string; description: string };

const KNOWN: Record<string, ModeText> = {
  "codex:read-only": {
    label: msg("Read only"),
    description: msg(
      "Sandboxed: reads files, asks before writing or using the network.",
    ),
  },
  "codex:untrusted": {
    label: msg("Ask before commands (sandboxed)"),
    description: msg(
      "Asks before any command that is not known to be safe; writes stay in the workspace.",
    ),
  },
  "codex:on-request": {
    label: msg("Ask when needed (sandboxed)"),
    description: msg(
      "Works in the workspace sandbox and asks to go beyond it.",
    ),
  },
  "codex:never": {
    label: msg("Never ask (sandboxed)"),
    description: msg(
      "Never asks, but commands stay in the workspace sandbox: no writes elsewhere, no network, no sudo.",
    ),
  },
  "codex:full-access": {
    label: msg("Full access (no sandbox, never asks)"),
    description: msg(
      "Runs every command unsandboxed with your permissions, without asking (--yolo).",
    ),
  },
  "claude:default": {
    label: msg("Ask before edits and commands"),
    description: msg("Asks before editing files or running commands."),
  },
  "claude:acceptEdits": {
    label: msg("Accept edits, ask before commands"),
    description: msg("Edits files without asking; asks before commands."),
  },
  "claude:plan": {
    label: msg("Plan (read only)"),
    description: msg("Reads and plans; changes nothing."),
  },
  "claude:bypassPermissions": {
    label: msg("Full access (bypass permissions)"),
    description: msg(
      "Never asks; Claude Code runs commands with your permissions (--dangerously-skip-permissions).",
    ),
  },
};

const CODEX_APPROVALS: Record<string, string> = {
  untrusted: msg("asks before commands"),
  "on-request": msg("asks when needed"),
  never: msg("never asks"),
};
const CODEX_SANDBOXES: Record<string, string> = {
  "read-only": msg("read-only sandbox"),
  "workspace-write": msg("workspace-write sandbox"),
  "danger-full-access": msg("no sandbox"),
};

/** A mode's label and description; unknown modes keep the host's label. */
export function agentModeText(
  kind: AgentSessionInfo["kind"],
  mode: AgentSessionMode,
): { label: string; description?: string } {
  const known = KNOWN[`${kind}:${mode.id}`];
  if (known)
    return { label: t(known.label), description: t(known.description) };
  // A Codex pair no named mode covers: `<approval policy>+<sandbox>`.
  const [approval, sandbox] = mode.id.split("+");
  if (
    kind === "codex" &&
    approval &&
    sandbox &&
    CODEX_APPROVALS[approval] &&
    CODEX_SANDBOXES[sandbox]
  )
    return {
      label: t("Custom: {approval}, {sandbox}", {
        approval: t(CODEX_APPROVALS[approval]),
        sandbox: t(CODEX_SANDBOXES[sandbox]),
      }),
    };
  return { label: mode.label };
}
