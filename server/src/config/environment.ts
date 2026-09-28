/** Read a `THYRA_*` setting, preserving an explicitly empty value. */
export function thyraEnv(
  suffix: string,
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  return environment[`THYRA_${suffix}`];
}

/** `KEY=value` lines of an environment file (systemd `EnvironmentFile`). */
export function parseEnvironmentFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/,
    );
    if (!match || line.trim().startsWith("#")) continue;
    const raw = match[2] ?? "";
    const quoted =
      raw.length >= 2 &&
      (raw[0] === "'" || raw[0] === '"') &&
      raw.at(-1) === raw[0];
    values[match[1]!] = quoted ? raw.slice(1, -1) : raw;
  }
  return values;
}
