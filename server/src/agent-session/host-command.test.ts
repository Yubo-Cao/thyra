import { expect, test } from "bun:test";
import { thyraHostCommand } from "./host-command";

test("a compiled executable is run by its own absolute path", () => {
  expect(thyraHostCommand("/opt/thyra/thyra", "/$bunfs/root/thyra")).toBe(
    "/opt/thyra/thyra",
  );
  expect(thyraHostCommand("C:\\thyra.exe", "B:\\~BUN\\root\\thyra.exe")).toBe(
    "'C:\\thyra.exe'",
  );
});

test("from source it is Bun and the entry script", () => {
  expect(thyraHostCommand("/usr/bin/bun", "/repo/server/src/index.ts")).toBe(
    "/usr/bin/bun /repo/server/src/index.ts",
  );
  expect(thyraHostCommand()).toContain(process.execPath);
});

test("paths the shell would split or expand are quoted", () => {
  expect(thyraHostCommand("/home/a b/it's/thyra", "/$bunfs/root/thyra")).toBe(
    "'/home/a b/it'\\''s/thyra'",
  );
  expect(thyraHostCommand("/bin/bun", "/re po/$x/index.ts")).toBe(
    "/bin/bun '/re po/$x/index.ts'",
  );
});
