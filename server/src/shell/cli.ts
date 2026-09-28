import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { HerdrClient } from "../bridge/herdr-client";
import { loadServerConfig } from "../config/server-config";
import { shellIntegration } from "./installer";
import { shellPaths } from "./paths";
import { isProcessAlive, readShellRecord } from "./state";
import type { ShellName } from "../../../shared/shell";

export async function runShellIntegrationCommand(
  argv: string[],
  version: string,
): Promise<number | null> {
  if (argv[0] !== "shell-integration") return null;
  const action = argv[1];
  const selection =
    argv[2] === "--shell" && argv.length === 4
      ? argv[3]
      : argv.length === 2
        ? "all"
        : "";
  if (
    !["install", "uninstall", "status"].includes(action ?? "") ||
    !["all", "bash", "zsh", "fish"].includes(selection ?? "")
  ) {
    console.error(
      "Usage: thyra shell-integration install|uninstall|status [--shell bash|zsh|fish|all]",
    );
    return 2;
  }
  try {
    const result = await shellIntegration(
      action as "install" | "uninstall" | "status",
      selection === "all" ? ["bash", "zsh", "fish"] : [selection as ShellName],
    );
    for (const row of result)
      console.log(
        `${row.shell}: ${row.installed ? "installed" : "not installed"}${row.exists ? "" : " (shell not found)"}`,
      );
    if (action === "status") {
      const dir = shellPaths().runtime;
      const config = loadServerConfig(version, []);
      const herdr = new HerdrClient(config.socketPath);
      let live = false;
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (!name.endsWith(".json")) continue;
        const record = await readShellRecord(join(dir, name));
        if (!record || !isProcessAlive(record.pid)) continue;
        const info = await herdr
          .call("pane.process_info", { pane_id: record.pane }, 1000)
          .catch(() => null);
        if (info?.shell_pid === record.pid) {
          live = true;
          break;
        }
      }
      console.log(`Live pane state: ${live ? "reported" : "none verified"}`);
    }
    return 0;
  } catch (error) {
    console.error(`Shell integration: ${(error as Error).message}`);
    return 1;
  }
}
