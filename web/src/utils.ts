export function shortId(id: string): string {
  // "w1:t1" -> "t1", "w1:p2" -> "p2"
  const i = id.indexOf(":");
  return i === -1 ? id : id.slice(i + 1);
}

export function cn(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}

export function agentClass(status?: string): string {
  switch ((status ?? "unknown").toLowerCase()) {
    case "working":
      return "app-badge badge-working";
    case "done":
      return "app-badge badge-done";
    case "blocked":
      return "app-badge badge-blocked";
    case "idle":
      return "app-badge badge-idle";
    default:
      return "app-badge badge-unknown";
  }
}

/** Render a memory size the way the Herdr server words the same limit. */
export function formatMemoryLimit(bytes: number): string {
  const MIB = 1024 * 1024;
  const GIB = 1024 * MIB;
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GiB`;
  return `${Math.ceil(bytes / MIB)} MiB`;
}

export function basename(path?: string): string {
  if (!path) return "";
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1) || trimmed;
}
