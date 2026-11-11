import {
  AGENT_SESSION_KINDS,
  type AgentSessionKind,
} from "../../../shared/agentSession";
import { createHerdrReporter, herdrSocketRequest } from "./herdr-report";
import { type AgentHost, startAgentHost } from "./host";
import { agentSocketDir } from "./paths";

const USAGE = `Usage: thyra agent <claude|codex> [agent arguments...]

Runs a coding agent in this Herdr pane as an agent session: Thyra shows it as
a conversation instead of the agent's terminal UI. The pane shows a plain log;
Ctrl+C ends the session.`;

function isKind(value: string | undefined): value is AgentSessionKind {
  return (AGENT_SESSION_KINDS as readonly string[]).includes(value ?? "");
}

/** `thyra agent <kind> [args...]`: host one agent session in this pane. */
export async function runAgentCommand(argv: string[]): Promise<number | null> {
  if (argv[0] !== "agent") return null;
  const kind = argv[1];
  if (kind === "--help" || kind === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (!isKind(kind)) {
    console.error(USAGE);
    return 2;
  }
  if (process.platform === "win32") {
    console.error("thyra agent is not available on Windows.");
    return 1;
  }
  const paneId = process.env.HERDR_PANE_ID;
  const herdrSocketPath = process.env.HERDR_SOCKET_PATH;
  if (!paneId || !herdrSocketPath) {
    console.error(
      "thyra agent must run inside a Herdr pane: HERDR_PANE_ID and HERDR_SOCKET_PATH are not set.\nOpen a pane in Herdr (or Thyra) and run it there.",
    );
    return 1;
  }
  const write = (value: string) => {
    try {
      process.stdout.write(value);
    } catch {
      // The pane is gone; the session ends with its hangup signal.
    }
  };
  process.stdout.on("error", () => undefined);
  let host: AgentHost;
  try {
    host = await startAgentHost({
      kind,
      args: argv.slice(2),
      paneId,
      herdrSocketPath,
      cwd: process.cwd(),
      socketDir: agentSocketDir(),
      write,
      reporter: createHerdrReporter({
        paneId,
        kind,
        request: herdrSocketRequest(herdrSocketPath),
      }),
    });
  } catch (error) {
    console.error(`thyra agent: ${(error as Error).message}`);
    return 1;
  }
  if (host.failedToStart) return 1;
  let code = 0;
  const stop = (exitCode: number) => () => {
    code = exitCode;
    void host.shutdown();
  };
  process.on("SIGINT", stop(130));
  process.on("SIGTERM", stop(143));
  process.on("SIGHUP", stop(129));
  await host.closed;
  return code;
}
