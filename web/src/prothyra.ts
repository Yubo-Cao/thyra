/**
 * Prothyra, the owner's iPad browser, declares the native capabilities it
 * provides as `window.prothyra = { version, capabilities }`, injected at
 * document start. Thyra reads only the capabilities, never the version.
 */
export type ProthyraCapability =
  | "clipboard.read"
  | "clipboard.write"
  | "lifecycle.resume"
  | "keyboard.fullCapture";

/** Dispatched on `window` when the app returns to the foreground. */
export const PROTHYRA_RESUME_EVENT = "prothyra:resume";

/** The declared capabilities, or null when `value` is not Prothyra's. */
export function parseProthyra(value: unknown): ReadonlySet<string> | null {
  try {
    if (!value || typeof value !== "object") return null;
    const capabilities: unknown = (value as { capabilities?: unknown })
      .capabilities;
    if (!Array.isArray(capabilities)) return null;
    return new Set(
      capabilities.filter((item): item is string => typeof item === "string"),
    );
  } catch {
    return null;
  }
}

let declared: ReadonlySet<string> | null | undefined;

function declaredCapabilities(): ReadonlySet<string> | null {
  if (declared === undefined)
    declared =
      typeof window === "undefined"
        ? null
        : parseProthyra((window as { prothyra?: unknown }).prothyra);
  return declared;
}

export function inProthyra(): boolean {
  return declaredCapabilities() !== null;
}

export function hasProthyraCapability(name: ProthyraCapability): boolean {
  return declaredCapabilities()?.has(name) === true;
}

/** Calls `listener` on every foreground resume Prothyra announces. */
export function onProthyraResume(listener: () => void, signal?: AbortSignal) {
  if (!hasProthyraCapability("lifecycle.resume")) return;
  window.addEventListener(PROTHYRA_RESUME_EVENT, listener, { signal });
}

export function resetProthyraForTests() {
  declared = undefined;
}
