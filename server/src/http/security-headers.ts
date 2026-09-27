/** Headers for Thyra's own HTML pages (not workspace file previews). */
export const HTML_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "referrer-policy": "no-referrer",
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
};
