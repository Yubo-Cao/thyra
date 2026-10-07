import { isSshDestination } from "../../shared/sshDestination";
import { t } from "./i18n";

const REMOTE_SOCKET_SEGMENT_PATTERN = /^[A-Za-z0-9._~+@%=-]+$/;

export function validateSshDestination(value: unknown): string {
  if (!isSshDestination(value))
    throw new Error(
      t(
        "SSH destination must be an OpenSSH alias or user@host. Use an OpenSSH config alias for custom ports.",
      ),
    );
  return value;
}

export function validateRemoteSocketPath(
  value: unknown,
  field: string,
): string {
  // An empty path asks the bridge to infer the default Herdr socket location
  // under the remote home directory at connect time.
  if (value === "") return "";
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    new TextEncoder().encode(value).length > 100 ||
    !value.startsWith("/") ||
    !/^[\x21-\x7e]+$/.test(value) ||
    /[:\\\s]/.test(value)
  ) {
    throw new Error(
      t("{field} path must be a short absolute POSIX path.", {
        field: t(field),
      }),
    );
  }
  const segments = value.split("/").slice(1);
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !REMOTE_SOCKET_SEGMENT_PATTERN.test(segment),
    )
  ) {
    throw new Error(
      t("{field} path must be a short absolute POSIX path.", {
        field: t(field),
      }),
    );
  }
  return value;
}
