import { Bot } from "lucide-react";
import ampIcon from "@lobehub/icons-static-svg/icons/amp-color.svg?raw";
import antigravityIcon from "@lobehub/icons-static-svg/icons/antigravity-color.svg?raw";
import claudeCodeIcon from "@lobehub/icons-static-svg/icons/claudecode-color.svg?raw";
import clineIcon from "@lobehub/icons-static-svg/icons/cline.svg?raw";
import codexIcon from "@lobehub/icons-static-svg/icons/codex-color.svg?raw";
import cursorIcon from "@lobehub/icons-static-svg/icons/cursor.svg?raw";
import devinIcon from "@lobehub/icons-static-svg/icons/devin-color.svg?raw";
import geminiCliIcon from "@lobehub/icons-static-svg/icons/geminicli-color.svg?raw";
import githubCopilotIcon from "@lobehub/icons-static-svg/icons/githubcopilot.svg?raw";
import grokIcon from "@lobehub/icons-static-svg/icons/grok.svg?raw";
import kiloCodeIcon from "@lobehub/icons-static-svg/icons/kilocode.svg?raw";
import kimiIcon from "@lobehub/icons-static-svg/icons/kimi-color.svg?raw";
import kiroIcon from "@lobehub/icons-static-svg/icons/kiro-color.svg?raw";
import opencodeIcon from "@lobehub/icons-static-svg/icons/opencode.svg?raw";
import qoderIcon from "@lobehub/icons-static-svg/icons/qoder-color.svg?raw";
import piIcon from "../assets/pi-logo.svg?raw";
import { type AgentKind, agentKind } from "../agentKind";
import { cn } from "../utils";
import "./AgentIcon.css";

const AGENT_ICON_SVGS: Partial<Record<AgentKind, string>> = {
  pi: piIcon,
  claude: claudeCodeIcon,
  codex: codexIcon,
  gemini: geminiCliIcon,
  cursor: cursorIcon,
  devin: devinIcon,
  agy: antigravityIcon,
  cline: clineIcon,
  opencode: opencodeIcon,
  copilot: githubCopilotIcon,
  kimi: kimiIcon,
  kiro: kiroIcon,
  amp: ampIcon,
  grok: grokIcon,
  kilo: kiloCodeIcon,
  qodercli: qoderIcon,
};

export function AgentIcon({
  agent,
  compact = false,
}: {
  agent?: string;
  compact?: boolean;
}) {
  const kind = agentKind(agent);
  const iconSvg = AGENT_ICON_SVGS[kind];

  return (
    <span
      className={cn("agent-icon", compact && "is-compact")}
      data-agent={kind}
      title={agent || "Agent"}
      aria-hidden="true"
    >
      {iconSvg ? (
        <span
          className="agent-icon-svg"
          dangerouslySetInnerHTML={{ __html: iconSvg }}
        />
      ) : (
        <Bot size={compact ? 14 : 15} strokeWidth={2.2} />
      )}
    </span>
  );
}
