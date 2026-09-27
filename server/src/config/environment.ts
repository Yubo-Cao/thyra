/**
 * Thyra names take precedence, including an explicitly empty value, then the
 * names used before the split from Roamgate, then the original herdr-gui ones.
 */
export function thyraEnv(
  suffix: string,
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  return (
    environment[`THYRA_${suffix}`] ??
    environment[`ROAMGATE_${suffix}`] ??
    environment[`HERDR_GUI_${suffix}`]
  );
}
