import { expect, test } from "bun:test";

test("systemd template runs Thyra and uses the Thyra environment file", async () => {
  const unit = await Bun.file(
    new URL("../deploy/systemd/thyra.service", import.meta.url),
  ).text();
  expect(unit).toContain("Description=Thyra");
  expect(unit).toContain("ExecStart=%h/.local/bin/thyra");
  expect(unit).toContain("EnvironmentFile=-%h/.config/thyra/thyra.env");
});

test("launchd template executes the installed Thyra binary with Thyra identities and state paths", async () => {
  const plist = await Bun.file(
    new URL("../deploy/launchd/dev.thyra.plist", import.meta.url),
  ).text();
  const installer = await Bun.file(
    new URL("./install.sh", import.meta.url),
  ).text();
  expect(installer).toContain('install_file "$binary" "$bin_dir/thyra"');
  expect(installer).toContain("THYRA_INSTALL_DIR-$HOME/.local/bin");
  expect(plist).toContain('exec "$HOME/.local/bin/thyra"');
  expect(plist).toContain("<string>dev.thyra</string>");
  expect(plist).toContain("$HOME/.config/thyra/thyra.env");
  expect(plist).not.toContain("RESTART_SUPERVISOR");
  expect(plist).toContain("__HOME__/Library/Logs/thyra.stdout.log");
  expect(plist).toContain("__HOME__/Library/Logs/thyra.stderr.log");
});
