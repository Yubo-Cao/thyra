import { enrichAgentActivity } from "./agent-activity";
import type { HerdrCall } from "./session-types";
import { createAgentSessionResolverContext } from "./session-resolver";
import type { AgentSessionFileAccess } from "./session-file-access";

export function createAgentSessionHandlers(args: {
  herdrCall: HerdrCall;
  files: AgentSessionFileAccess;
}) {
  const resolverContext = createAgentSessionResolverContext();
  return {
    listWithActivity: async (params: Record<string, unknown>) =>
      enrichAgentActivity(
        await args.herdrCall("agent.list", params),
        args.files,
        resolverContext,
      ),
  };
}
