/**
 * Deny-list for workspace paths MCP clients may not read.
 *
 * Patterns without a slash match any single path segment, so `.ssh` hides the
 * whole directory and `*.pem` hides a key anywhere in the tree. Patterns with
 * a slash match a run of consecutive segments (`.docker/config.json`).
 * Matching is case-insensitive because macOS and Windows checkouts are.
 */
export const DEFAULT_DENIED_FILE_PATTERNS: readonly string[] = [
  ".env*",
  "*.pem",
  "*.key",
  "id_*",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "*.kdbx",
  "*.tfstate",
  "*.tfstate.*",
  "*.tfvars",
  "credentials",
  "credentials.*",
  "*.credentials",
  "*credentials*.json",
  "service-account*.json",
  "secrets.*",
  ".secrets",
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".htpasswd",
  ".pgpass",
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".git",
  ".docker/config.json",
  ".config/gcloud",
  ".config/gh/hosts.yml",
  ".config/thyra",
  "auth-token",
  "thyra.db*",
  "mcp-tokens.json",
];

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (const char of glob) {
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

export type FilePolicy = {
  /** The first pattern that denies `path`, or null when it may be read. */
  deniedBy(path: string): string | null;
  patterns: readonly string[];
};

export function createFilePolicy(
  extraPatterns: readonly string[] = [],
): FilePolicy {
  const patterns = [
    ...DEFAULT_DENIED_FILE_PATTERNS,
    ...extraPatterns
      .map((pattern) => pattern.trim().replace(/^\/+|\/+$/g, ""))
      .filter(Boolean),
  ];
  const compiled = patterns.map((pattern) => ({
    pattern,
    parts: pattern.split("/").map(globToRegExp),
  }));
  return {
    patterns,
    deniedBy(path: string) {
      const segments = path
        .replace(/\\/g, "/")
        .split("/")
        .filter((segment) => segment && segment !== ".");
      for (const { pattern, parts } of compiled) {
        for (let start = 0; start + parts.length <= segments.length; start++) {
          if (
            parts.every((part, offset) =>
              part.test(segments[start + offset] ?? ""),
            )
          ) {
            return pattern;
          }
        }
      }
      return null;
    },
  };
}
