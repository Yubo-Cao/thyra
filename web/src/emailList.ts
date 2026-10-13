// Addresses an admin binds to an account, typed or pasted as a list. The
// bridge validates again; this splits the list and flags typos before sending.

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/i;

/**
 * The addresses in `input` (separated by commas, semicolons or whitespace),
 * lower-cased and once each. `invalid` lists the entries that are not
 * addresses; the caller keeps them in the field.
 */
export function parseEmails(input: string): {
  emails: string[];
  invalid: string[];
} {
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const entry of input.split(/[\s,;]+/).filter(Boolean)) {
    const email = entry.toLowerCase();
    if (email.length > 254 || !EMAIL.test(email)) invalid.push(entry);
    else if (!emails.includes(email)) emails.push(email);
  }
  return { emails, invalid };
}
