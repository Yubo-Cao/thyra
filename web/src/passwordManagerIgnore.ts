/**
 * Attributes that keep password managers' inline menus (1Password,
 * LastPass, Bitwarden, Dashlane) off a text field. Prompts and terminal input
 * are never credentials, so a fill menu there only gets in the way.
 */
export const PASSWORD_MANAGER_IGNORE = {
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
} as const;
