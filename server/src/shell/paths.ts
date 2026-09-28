import { homedir } from "node:os";
import { join } from "node:path";

export function shellPaths(env: NodeJS.ProcessEnv = process.env) {
  const home = env.HOME || homedir();
  return {
    home,
    scripts: join(
      env.XDG_DATA_HOME || join(home, ".local/share"),
      "thyra/shell-integration",
    ),
    state: join(env.XDG_STATE_HOME || join(home, ".local/state"), "thyra"),
    runtime: join(
      env.XDG_RUNTIME_DIR || `/tmp/thyra-${process.getuid?.() ?? 0}`,
      "thyra/shell",
    ),
    fishConfig: join(
      env.XDG_CONFIG_HOME || join(home, ".config"),
      "fish/conf.d/thyra.fish",
    ),
  };
}

export function paneFilename(pane: string) {
  return pane.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
}
