import { shQuote } from "../utils/process-utils";

/**
 * Shell text that runs this Thyra executable by absolute path, so starting
 * `thyra agent` in a pane does not depend on the pane's PATH. From source
 * (`bun src/index.ts`) that is Bun followed by the entry script.
 */
export function thyraHostCommand(
  execPath: string = process.execPath,
  main: string = Bun.main,
): string {
  const quote = (value: string) =>
    /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : shQuote(value);
  // A compiled executable runs its entry from Bun's embedded filesystem.
  const compiled =
    main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(main);
  return compiled ? quote(execPath) : `${quote(execPath)} ${quote(main)}`;
}
