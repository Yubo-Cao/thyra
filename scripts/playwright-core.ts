/**
 * Loads playwright-core for the browser-driving scripts. The root
 * devDependency is the default; PLAYWRIGHT_CORE_PATH points at another
 * playwright-core directory instead. Browsers come from Playwright's cache
 * (`bunx playwright-core install chromium webkit` fills it).
 */
export async function loadPlaywrightCore(): Promise<any> {
  const override = process.env.PLAYWRIGHT_CORE_PATH?.trim();
  const specifier = override || "playwright-core";
  try {
    const loaded = await import(specifier);
    return loaded.default ?? loaded;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      override
        ? `Could not load playwright-core from PLAYWRIGHT_CORE_PATH=${override}: ${reason}`
        : `Could not load playwright-core (${reason}). Run \`bun install\` at the repository root, or set PLAYWRIGHT_CORE_PATH to a playwright-core directory.`,
      { cause: error },
    );
  }
}
