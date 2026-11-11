import { Bot } from "lucide-react";
import { useEffect, useId, useMemo, useSyncExternalStore } from "react";
import claudeCodeIcon from "@lobehub/icons-static-svg/icons/claudecode-color.svg?agent-icon";
import codexIcon from "@lobehub/icons-static-svg/icons/codex-color.svg?agent-icon";
import cursorIcon from "@lobehub/icons-static-svg/icons/cursor.svg?agent-icon";
import geminiCliIcon from "@lobehub/icons-static-svg/icons/geminicli-color.svg?agent-icon";
import githubCopilotIcon from "@lobehub/icons-static-svg/icons/githubcopilot.svg?agent-icon";
import opencodeIcon from "@lobehub/icons-static-svg/icons/opencode.svg?agent-icon";
import piIcon from "../assets/pi-logo.svg?agent-icon";
import { type AgentKind, agentKind } from "../agentKind";
import { createLazyValue } from "../lazyValue";
import { cn } from "../utils";
import type { RareAgentKind } from "./agentIconsRare";
import "./AgentIcon.css";

// The icons paint with the first screen, so the common agents' ship in the
// app entry. The rest load on first use (agentIconsRare.ts) behind an empty
// box of the icon's size, which costs their sessions one late icon and
// everyone else nothing.
const AGENT_ICON_SVGS: Partial<Record<AgentKind, string>> = {
  pi: piIcon,
  claude: claudeCodeIcon,
  codex: codexIcon,
  gemini: geminiCliIcon,
  cursor: cursorIcon,
  opencode: opencodeIcon,
  copilot: githubCopilotIcon,
};

/** Every key of agentIconsRare.ts, known here without loading it. */
const RARE_AGENT_KINDS: Record<RareAgentKind, true> = {
  agy: true,
  devin: true,
  cline: true,
  kimi: true,
  kiro: true,
  amp: true,
  grok: true,
  kilo: true,
  qodercli: true,
};

/**
 * An icon's markup with its element IDs made this instance's own. Two copies
 * of an icon would otherwise share a gradient ID, and each would paint with
 * the first copy's gradient, which paints nothing when that copy is hidden
 * (the sidebar on a phone).
 */
export function agentIconInstance(svg: string, instance: string): string {
  if (!svg.includes(' id="')) return svg;
  const suffix = instance.replace(/[^\w-]/g, "");
  return svg.replace(
    /(\sid="|url\(#)([^")]+)/g,
    (_, lead: string, id: string) => `${lead}${id}-${suffix}`,
  );
}

const rareIcons = createLazyValue(
  async () => (await import("./agentIconsRare")).RARE_AGENT_ICON_SVGS,
);

export function AgentIcon({
  agent,
  compact = false,
}: {
  agent?: string;
  compact?: boolean;
}) {
  const kind = agentKind(agent);
  const rare = kind in RARE_AGENT_KINDS;
  const loaded = useSyncExternalStore(rareIcons.subscribe, rareIcons.read);
  useEffect(() => {
    if (rare) rareIcons.load();
  }, [rare]);
  const iconSvg = rare
    ? loaded.value?.[kind as RareAgentKind]
    : AGENT_ICON_SVGS[kind];
  const instance = useId();
  const markup = useMemo(
    () => (iconSvg ? agentIconInstance(iconSvg, instance) : undefined),
    [iconSvg, instance],
  );
  // An icon on its way holds its place; one that cannot load is generic.
  const pending = rare && !iconSvg && !loaded.failed;

  return (
    <span
      className={cn("agent-icon", compact && "is-compact")}
      data-agent={kind}
      title={agent || "Agent"}
      aria-hidden="true"
    >
      {markup ? (
        <span
          className="agent-icon-svg"
          dangerouslySetInnerHTML={{ __html: markup }}
        />
      ) : pending ? null : (
        <Bot size={compact ? 14 : 15} strokeWidth={2.2} />
      )}
    </span>
  );
}
