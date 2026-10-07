const SSH_DESTINATION_MAX_LENGTH = 320;
const SSH_USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const SSH_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

/** Whether `value` is an OpenSSH config alias or plain `user@host`. */
export function isSshDestination(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > SSH_DESTINATION_MAX_LENGTH ||
    !/^[\x21-\x7e]+$/.test(value) ||
    value.startsWith("-") ||
    /[\s/=:,]/.test(value) ||
    value.includes("://")
  )
    return false;
  const parts = value.split("@");
  if (parts.length > 2) return false;
  const host = parts.length === 2 ? parts[1] : parts[0];
  const user = parts.length === 2 ? parts[0] : undefined;
  return (
    SSH_HOST_PATTERN.test(host) &&
    (user === undefined || SSH_USER_PATTERN.test(user))
  );
}
