// Editing the email domains whose addresses may sign up without an invite.
// The server validates again; this only keeps the list tidy while typing.

const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** "@Example.COM." -> "example.com"; null when it is not a domain. */
export function normalizeDomain(input: string): string | null {
  const domain = input
    .trim()
    .toLowerCase()
    .replace(/^.*@/, "")
    .replace(/\.$/, "");
  return DOMAIN.test(domain) ? domain : null;
}

/**
 * Add every domain in `input` (separated by commas or whitespace, so a pasted
 * list works) to `domains`, skipping ones already there. `invalid` lists the
 * entries that are not domains; the caller keeps them in the field.
 */
export function addDomains(
  domains: readonly string[],
  input: string,
): { domains: string[]; invalid: string[] } {
  const next = [...domains];
  const invalid: string[] = [];
  for (const entry of input.split(/[\s,;]+/).filter(Boolean)) {
    const domain = normalizeDomain(entry);
    if (!domain) invalid.push(entry);
    else if (!next.includes(domain)) next.push(domain);
  }
  return { domains: next, invalid };
}

/** Same domains regardless of order. */
export function sameDomains(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((domain) => b.includes(domain));
}
