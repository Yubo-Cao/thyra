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

/** Whether keys typed at `target` edit text (inputs, contenteditable). */
export function isEditableElement(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

// Terminal frames decode through here; a non-streaming decoder keeps no state
// between calls, so one serves every frame.
const utf8Decoder = new TextDecoder();

/** Decodes base64 UTF-8 text; null when it is not valid base64. */
export function b64toText(b64: string): string | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * Runs `run` at most once per animation frame however often `request` is
 * called. `flush` runs a pending request now; `cancel` drops it.
 */
export function frameCoalescer(
  run: () => void,
  schedule: (callback: () => void) => number = (callback) =>
    requestAnimationFrame(callback),
  unschedule: (handle: number) => void = (handle) =>
    cancelAnimationFrame(handle),
) {
  let handle: number | null = null;
  const fire = () => {
    handle = null;
    run();
  };
  return {
    request() {
      if (handle === null) handle = schedule(fire);
    },
    flush() {
      if (handle === null) return;
      unschedule(handle);
      fire();
    },
    cancel() {
      if (handle !== null) unschedule(handle);
      handle = null;
    },
    get pending() {
      return handle !== null;
    },
  };
}
