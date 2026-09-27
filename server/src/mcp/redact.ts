/**
 * Secret redaction applied to every MCP tool output.
 *
 * Redaction is deliberately greedy: a false positive hides a harmless value,
 * while a false negative hands a credential to a third-party agent. Values are
 * replaced with a marker naming the rule so the caller knows content was
 * withheld rather than absent.
 */

export const REDACTED = "[REDACTED]";

type Rule = {
  name: string;
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
};

const marker = (name: string) => `[REDACTED:${name}]`;

const STRONG_LAST = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
  "apikey",
  "cookie",
  "dsn",
  "pat",
]);
const STRONG_ANYWHERE = new Set([
  "secret",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
  "apikey",
]);
// A trailing word that describes metadata about a secret, not the secret.
const METADATA_LAST = new Set([
  "count",
  "limit",
  "length",
  "len",
  "size",
  "type",
  "name",
  "names",
  "id",
  "ids",
  "file",
  "path",
  "dir",
  "url",
  "uri",
  "env",
  "var",
  "hint",
  "prompt",
  "label",
  "field",
  "required",
  "enabled",
  "min",
  "max",
  "usage",
  "kind",
  "source",
]);

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether an identifier (env var, config key, JSON field) names a secret. */
export function isSecretName(name: string): boolean {
  const words = nameWords(name);
  const last = words.at(-1);
  if (!last) return false;
  if (STRONG_LAST.has(last)) return true;
  // Bare "key"/"auth" are too common (React keys, map keys, author fields).
  if ((last === "key" || last === "auth") && words.length > 1) return true;
  if (METADATA_LAST.has(last)) return false;
  return words.some((word) => STRONG_ANYWHERE.has(word));
}

/** A value that only names another variable is not itself a secret. */
function isReference(value: string): boolean {
  const trimmed = value.trim().replace(/^["']|["'],?$/g, "");
  return (
    trimmed.length === 0 ||
    trimmed.startsWith("[REDACTED") ||
    /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(trimmed) ||
    /^(process\.env|os\.environ|env::var|getenv)\b/.test(trimmed) ||
    /^(<[^>]*>|\*+|x{3,}|\.{3}|null|none|undefined|true|false|""|'')$/i.test(
      trimmed,
    )
  );
}

const RULES: Rule[] = [
  {
    name: "private-key",
    // An unterminated block (for example a truncated read) is redacted to the
    // end of the text.
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: () => marker("private-key"),
  },
  {
    name: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
    replace: () => marker("anthropic-key"),
  },
  {
    name: "openai-key",
    pattern: /\bsk-(?:proj-|svcacct-|admin-|live-|test-)?[A-Za-z0-9_-]{20,}/g,
    replace: () => marker("openai-key"),
  },
  {
    name: "github-token",
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
    replace: () => marker("github-token"),
  },
  {
    name: "gitlab-token",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g,
    replace: () => marker("gitlab-token"),
  },
  {
    name: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g,
    replace: () => marker("aws-access-key"),
  },
  {
    name: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replace: () => marker("google-api-key"),
  },
  {
    name: "slack-token",
    pattern: /\bxox[abposre]-[A-Za-z0-9-]{10,}/g,
    replace: () => marker("slack-token"),
  },
  {
    name: "stripe-key",
    pattern: /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}/g,
    replace: () => marker("stripe-key"),
  },
  {
    name: "huggingface-token",
    pattern: /\bhf_[A-Za-z0-9]{30,}\b/g,
    replace: () => marker("huggingface-token"),
  },
  {
    name: "npm-token",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    replace: () => marker("npm-token"),
  },
  {
    name: "thyra-token",
    pattern: /\bthyra_mcp_[A-Za-z0-9_]{16,}/g,
    replace: () => marker("thyra-token"),
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: () => marker("jwt"),
  },
  {
    name: "bearer",
    pattern: /\b(Bearer|Basic|Token)(\s+)([A-Za-z0-9._~+/=-]{12,})/g,
    replace: (_match, scheme, space) => `${scheme}${space}${REDACTED}`,
  },
  {
    name: "url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi,
    replace: (_match, prefix, _secret, at) => `${prefix}${REDACTED}${at}`,
  },
  {
    // KEY=value, export KEY=value, KEY: value, and "key": "value" forms.
    name: "assignment",
    pattern:
      /(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,80})\1([ \t]*(?::=|=>|=|:)[ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s,;)}\]]+)/g,
    replace: (match, quote, name, separator, value) =>
      isSecretName(name) && !isReference(value)
        ? `${quote}${name}${quote}${separator}${redactValue(value)}`
        : match,
  },
];

function redactValue(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    return `${quote}${REDACTED}${quote}`;
  }
  return REDACTED;
}

/** Redact secrets in one string. */
export function redactText(text: string): string {
  let result = text;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, rule.replace as never);
  }
  return result;
}

/** Redact every string (keys included) inside a JSON-like value. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") return redactText(value) as T;
  if (depth > 32 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth + 1)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    // A secret-named field holding a plain scalar is withheld outright.
    if (
      typeof item === "string" &&
      item.length > 0 &&
      isSecretName(key) &&
      !isReference(item)
    ) {
      out[key] = REDACTED;
      continue;
    }
    out[redactText(key)] = redactDeep(item, depth + 1);
  }
  return out as T;
}
