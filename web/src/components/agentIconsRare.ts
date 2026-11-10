import ampIcon from "@lobehub/icons-static-svg/icons/amp-color.svg?agent-icon";
import antigravityIcon from "@lobehub/icons-static-svg/icons/antigravity-color.svg?agent-icon";
import clineIcon from "@lobehub/icons-static-svg/icons/cline.svg?agent-icon";
import devinIcon from "@lobehub/icons-static-svg/icons/devin-color.svg?agent-icon";
import grokIcon from "@lobehub/icons-static-svg/icons/grok.svg?agent-icon";
import kiloCodeIcon from "@lobehub/icons-static-svg/icons/kilocode.svg?agent-icon";
import kimiIcon from "@lobehub/icons-static-svg/icons/kimi-color.svg?agent-icon";
import kiroIcon from "@lobehub/icons-static-svg/icons/kiro-color.svg?agent-icon";
import qoderIcon from "@lobehub/icons-static-svg/icons/qoder-color.svg?agent-icon";
import type { AgentKind } from "../agentKind";

/**
 * Icons of the agents few sessions run, kept out of the app entry: AgentIcon
 * fetches this module when one of them first appears.
 */
export const RARE_AGENT_ICON_SVGS = {
  agy: antigravityIcon,
  devin: devinIcon,
  cline: clineIcon,
  kimi: kimiIcon,
  kiro: kiroIcon,
  amp: ampIcon,
  grok: grokIcon,
  kilo: kiloCodeIcon,
  qodercli: qoderIcon,
} satisfies Partial<Record<AgentKind, string>>;

export type RareAgentKind = keyof typeof RARE_AGENT_ICON_SVGS;
