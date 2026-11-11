import type { AgentSessionMode } from "../../../shared/agentSession";

/**
 * Codex's permission levels. Codex decides two things separately: when it
 * asks (the approval policy) and what a command may touch (the sandbox). A
 * mode names one pair of them, so "never asks" and "unsandboxed" read as the
 * different things they are: `never` still runs every command in the
 * workspace-write sandbox (no writes outside the workspace, no network, no
 * new privileges, so `sudo` fails); `full-access` is `--yolo`.
 */

export const CODEX_APPROVAL_POLICIES = [
  "untrusted",
  "on-request",
  "never",
] as const;
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];

export const CODEX_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

export type CodexPermissions = {
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
};

const NAMED_MODES: (AgentSessionMode & CodexPermissions)[] = [
  {
    id: "read-only",
    label: "Read only",
    approvalPolicy: "on-request",
    sandbox: "read-only",
  },
  {
    id: "untrusted",
    label: "Ask before commands (sandboxed)",
    approvalPolicy: "untrusted",
    sandbox: "workspace-write",
  },
  {
    id: "on-request",
    label: "Ask when needed (sandboxed)",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
  {
    id: "never",
    label: "Never ask (sandboxed)",
    approvalPolicy: "never",
    sandbox: "workspace-write",
  },
  {
    id: "full-access",
    label: "Full access (no sandbox, never asks)",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  },
];

/** The modes `set_mode` offers for every Codex session. */
export const CODEX_MODES: AgentSessionMode[] = NAMED_MODES.map(
  ({ id, label }) => ({ id, label }),
);

const APPROVAL_LABELS: Record<string, string> = {
  untrusted: "asks before commands",
  "on-request": "asks when needed",
  never: "never asks",
  granular: "custom approvals",
};
const SANDBOX_LABELS: Record<string, string> = {
  "read-only": "read-only sandbox",
  "workspace-write": "workspace-write sandbox",
  "danger-full-access": "no sandbox",
  "external-sandbox": "external sandbox",
};

const isApproval = (value: string): value is CodexApprovalPolicy =>
  (CODEX_APPROVAL_POLICIES as readonly string[]).includes(value);
const isSandbox = (value: string): value is CodexSandboxMode =>
  (CODEX_SANDBOX_MODES as readonly string[]).includes(value);

/**
 * A sandbox as `codex` options name it (`workspace-write`), from that name or
 * from the app-server's policy object (`{ type: "workspaceWrite", ... }`).
 */
export function codexSandboxName(value: unknown): string | undefined {
  const type =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? (value as { type?: unknown }).type
        : undefined;
  if (typeof type !== "string" || !type) return undefined;
  return type.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * The mode a thread runs in, from the approval policy and sandbox Codex
 * reports. A pair no named mode covers (a `config.toml` may choose any)
 * becomes a mode of its own, `<policy>+<sandbox>`, so the session never
 * claims a level it does not have. Without a reported sandbox the policy
 * alone picks a workspace-write mode, as Codex's own default.
 */
export function codexMode(
  approvalPolicy: unknown,
  sandbox: unknown,
): AgentSessionMode | undefined {
  const policy =
    typeof approvalPolicy === "string"
      ? approvalPolicy
      : approvalPolicy && typeof approvalPolicy === "object"
        ? "granular"
        : undefined;
  if (!policy) return undefined;
  const box = codexSandboxName(sandbox) ?? "workspace-write";
  const named = NAMED_MODES.find(
    (mode) => mode.approvalPolicy === policy && mode.sandbox === box,
  );
  if (named) return { id: named.id, label: named.label };
  const label = `${APPROVAL_LABELS[policy] ?? policy}, ${SANDBOX_LABELS[box] ?? box}`;
  return {
    id: `${policy}+${box}`,
    label: label.charAt(0).toUpperCase() + label.slice(1),
  };
}

/** The modes to offer: the named ones, and the current one if it is not. */
export function codexModes(current?: AgentSessionMode): AgentSessionMode[] {
  return current && !CODEX_MODES.some((mode) => mode.id === current.id)
    ? [...CODEX_MODES, current]
    : CODEX_MODES;
}

/** What a mode ID asks Codex for; null for an ID that names no valid pair. */
export function codexPermissions(id: string): CodexPermissions | null {
  const named = NAMED_MODES.find((mode) => mode.id === id);
  if (named)
    return { approvalPolicy: named.approvalPolicy, sandbox: named.sandbox };
  const [policy, box, ...rest] = id.split("+");
  return policy &&
    box &&
    rest.length === 0 &&
    isApproval(policy) &&
    isSandbox(box)
    ? { approvalPolicy: policy, sandbox: box }
    : null;
}

/**
 * The `sandboxPolicy` of a `turn/start` that switches to `sandbox`. Switching
 * back to the kind of sandbox the thread has keeps its settings (writable
 * roots, network access from `config.toml`); another kind starts from
 * Codex's defaults for it.
 */
export function codexSandboxPolicy(
  sandbox: CodexSandboxMode,
  current: Record<string, unknown> | null,
): Record<string, unknown> {
  if (current && codexSandboxName(current) === sandbox) return current;
  return {
    type: sandbox.replace(/-([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    ),
  };
}

/**
 * Whether `codex -c key=value` sets the approval policy or the sandbox, as
 * `-a` and `-s` do.
 */
export function codexConfigChoosesPermissions(override: string): boolean {
  return /^\s*(?:approval_policy|sandbox_mode)\s*=/.test(override);
}
