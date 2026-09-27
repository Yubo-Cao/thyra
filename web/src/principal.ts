import { useSyncExternalStore } from "react";
import { bridge, type BridgePrincipal } from "./api";
import { hostCapable } from "./capabilities";

// Who this page acts for, from the bridge hello: an account (admin or
// member), direct local use, or a share-link guest. The bridge enforces
// every permission; the interface only hides actions the caller cannot use.

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
  return hostCapable(principal);
}

export function usePrincipal(): BridgePrincipal | null {
  return useSyncExternalStore(subscribe, currentPrincipal, currentPrincipal);
}

export function useInstanceAdmin(): boolean {
  return isInstanceAdmin(usePrincipal());
}

/** An anonymous share-link guest: read-only, no account or settings. */
export function useGuest(): boolean {
  return usePrincipal()?.kind === "guest";
}
