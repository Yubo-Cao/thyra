/**
 * Test preload: every test process, and every server it spawns, gets a
 * throwaway HOME and XDG directories. Process-level tests start real Thyra
 * servers that open `~/.config/thyra/thyra.db` and friends; with the
 * developer's HOME they migrated the live account database.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "thyra-test-home-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.XDG_DATA_HOME = join(home, ".local", "share");
process.env.XDG_STATE_HOME = join(home, ".local", "state");
for (const name of Object.keys(process.env)) {
  if (name.startsWith("THYRA_")) delete process.env[name];
}
// Git reads identity from HOME; tests that commit need one.
process.env.GIT_AUTHOR_NAME ??= "Thyra Test";
process.env.GIT_AUTHOR_EMAIL ??= "test@thyra.invalid";
process.env.GIT_COMMITTER_NAME ??= "Thyra Test";
process.env.GIT_COMMITTER_EMAIL ??= "test@thyra.invalid";
afterAll(() => rmSync(home, { recursive: true, force: true }));
