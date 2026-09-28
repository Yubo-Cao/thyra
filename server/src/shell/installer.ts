import {
  chmod,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  lstat,
  rename,
  readdir,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ShellName } from "../../../shared/shell";
import bash from "./integration/thyra.bash" with { type: "text" };
import zsh from "./integration/thyra.zsh" with { type: "text" };
import fish from "./integration/thyra.fish" with { type: "text" };
import { shellPaths } from "./paths";

const scripts = { bash, zsh, fish };
const begin = "# >>> thyra shell integration >>>";
const end = "# <<< thyra shell integration <<<";
const block =
  /^# >>> thyra shell integration >>>\r?\n[\s\S]*?^# <<< thyra shell integration <<<\r?(?:\n|$)/gm;
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

export async function refreshShellScripts(
  env: NodeJS.ProcessEnv = process.env,
) {
  const paths = shellPaths(env);
  await mkdir(paths.scripts, { recursive: true, mode: 0o700 });
  for (const shell of Object.keys(scripts) as ShellName[]) {
    const path = join(paths.scripts, `thyra.${shell}`);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, scripts[shell], { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }
}

export async function shellIntegration(
  action: "install" | "uninstall" | "status",
  shells: ShellName[],
  env: NodeJS.ProcessEnv = process.env,
  exists: (shell: ShellName) => boolean = (shell) => Boolean(Bun.which(shell)),
) {
  const paths = shellPaths(env);
  if (action === "install") await refreshShellScripts(env);
  const result: {
    shell: ShellName;
    installed: boolean;
    exists: boolean;
    /** False when the shell has no rc file to edit. */
    rc?: boolean;
  }[] = [];
  for (const shell of shells) {
    if (!exists(shell)) {
      result.push({ shell, installed: false, exists: false });
      continue;
    }
    const rc =
      shell === "fish"
        ? paths.fishConfig
        : join((shell === "zsh" && env.ZDOTDIR) || paths.home, `.${shell}rc`);
    const old = await readFile(rc, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    // Creating a missing rc changes shell startup (zsh skips its new-user
    // wizard), so only edit rc files the user already has. The fish conf.d
    // file is ours alone.
    if (old === null && shell !== "fish") {
      result.push({ shell, installed: false, exists: true, rc: false });
      continue;
    }
    let next = old ?? "";
    if (action !== "status") {
      next = next.replace(block, "");
      if (action === "install") {
        const source = quote(join(paths.scripts, `thyra.${shell}`));
        const line =
          shell === "fish"
            ? `if set -q HERDR_PANE_ID; and test -r ${source}; source ${source}; end`
            : `[ -n "$HERDR_PANE_ID" ] && [ -r ${source} ] && . ${source}`;
        const integration = `${begin}\n${line}\n${end}\n`;
        // Append so the hooks load after the user's prompt setup (ble.sh,
        // starship, ...), which they must wrap rather than precede.
        next =
          next && !next.endsWith("\n")
            ? `${next}\n${integration}`
            : next + integration;
      }
      if (next !== (old ?? "")) {
        await mkdir(dirname(rc), { recursive: true });
        const backedUp = (await readdir(dirname(rc))).some((name) =>
          join(dirname(rc), name).startsWith(`${rc}.bak-thyra-`),
        );
        if (!backedUp && (await lstat(rc).catch(() => null))) {
          // Preserve the first backup across refreshes, even on later dates.
          await copyFile(
            rc,
            `${rc}.bak-thyra-${new Date().toISOString().slice(0, 10)}`,
            1,
          ).catch((error) => {
            if (error.code !== "EEXIST") throw error;
          });
        }
        await writeFile(rc, next, { mode: 0o600 });
      }
    }
    result.push({ shell, installed: next.includes(begin), exists: true });
  }
  return result;
}
