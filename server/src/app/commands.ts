import { runAccountsCommand } from "../accounts/cli";
import {
  runServiceCommand,
  SERVICE_COMMAND_CONTINUE,
} from "../config/service-manager";
import { runHerdrCommand } from "../herdr/cli";
import { runMessageBoardCommand } from "../message-board/cli";
import { runShellIntegrationCommand } from "../shell/cli";

/**
 * Subcommands (message board, shell integration, service, herdr, accounts)
 * run and exit here; this returns only when the process should serve.
 */
export async function runStartupCommands(APP_VERSION: string): Promise<void> {
  const boardCommandResult = await runMessageBoardCommand(
    process.argv.slice(2),
  );
  if (boardCommandResult !== null) process.exit(boardCommandResult);
  const shellCommandResult = await runShellIntegrationCommand(
    process.argv.slice(2),
    APP_VERSION,
  );
  if (shellCommandResult !== null) process.exit(shellCommandResult);
  const serviceCommandResult = runServiceCommand(process.argv.slice(2));
  if (serviceCommandResult === SERVICE_COMMAND_CONTINUE) {
    process.argv.splice(2);
  } else if (serviceCommandResult !== null) {
    process.exit(serviceCommandResult);
  }
  const herdrCommandResult = await runHerdrCommand(
    process.argv.slice(2),
    APP_VERSION,
  );
  if (herdrCommandResult !== null) {
    process.exit(herdrCommandResult);
  }
  const accountsCommandResult = await runAccountsCommand(process.argv.slice(2));
  if (accountsCommandResult !== null) {
    process.exit(accountsCommandResult);
  }
}
