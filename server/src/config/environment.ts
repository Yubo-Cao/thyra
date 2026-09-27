/** Read a `THYRA_*` setting, preserving an explicitly empty value. */
export function thyraEnv(
  suffix: string,
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  return environment[`THYRA_${suffix}`];
}
