import { useSyncExternalStore } from "react";
import { bridge, type BridgePrincipal } from "./api";

// Who this page acts for, from the bridge hello: an account (admin or
// member) or direct local use. The bridge enforces every permission; the
// interface only hides actions the caller cannot use.

let current: BridgePrincipal | null = null;
const listeners = new Set<() => void>();

bridge.onHello((hello) => {
  const next = hello.principal ?? null;
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  for (const listener of listeners) listener();
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentPrincipal(): BridgePrincipal | null {
  return current;
}

/** Instance admins (and direct local use) manage the host; members do not. */
export function isInstanceAdmin(principal = current): boolean {
  // Older bridges send no principal: they only know the owner.
  return !principal || principal.role === "admin";
}

export function usePrincipal(): BridgePrincipal | null {
  return useSyncExternalStore(subscribe, currentPrincipal, currentPrincipal);
}

export function useInstanceAdmin(): boolean {
  return isInstanceAdmin(usePrincipal());
}
