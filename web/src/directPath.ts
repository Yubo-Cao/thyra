import { type BridgeHello, bridge } from "./api";
import { thyraLocalStorage } from "./browserStorage";
import { openedNotificationHash } from "./taskNotifications";
import { PUSH_TWIN_PARAM, taskPushEndpoint } from "./taskPush";

// The direct path: a signed-in page on the public origin (through a tunnel)
// moves to the tailnet origin the bridge names in its hello when this device
// reaches it as the same account, so requests and the socket skip the
// tunnel. `?direct=0` or `localStorage["thyra:directPath"] = "off"` opts out.

const STORAGE_KEY = "directPath";
const PROBE_TIMEOUT_MS = 1500;

/** The tailnet origin to probe, or null when this page should stay put. */
export function directPathTarget(
  hello: Pick<BridgeHello, "direct_origin" | "principal">,
  location: Pick<Location, "origin" | "search">,
  optedOut: boolean,
): string | null {
  const origin = hello.direct_origin;
  if (!origin || optedOut || origin === location.origin) return null;
  if (new URLSearchParams(location.search).get("direct") === "0") return null;
  if (hello.principal?.kind !== "user" || !hello.principal.user) return null;
  return origin;
}

/** Ask the tailnet listener which account this device is; null on failure. */
async function tailnetUserId(origin: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}/auth/tailnet-direct`, {
      credentials: "omit",
      mode: "cors",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { user_id?: unknown };
    return typeof body.user_id === "string" ? body.user_id : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let tried = false;

async function tryDirectPath(hello: BridgeHello) {
  if (tried) return;
  tried = true;
  const { location } = window;
  if (new URLSearchParams(location.search).get("direct") === "0")
    thyraLocalStorage.setItem(STORAGE_KEY, "off");
  const target = directPathTarget(
    hello,
    location,
    thyraLocalStorage.getItem(STORAGE_KEY) === "off",
  );
  const userId = hello.principal?.user?.id;
  if (!target || !userId) return;
  if ((await tailnetUserId(target)) !== userId) return;
  const url = new URL(
    `${location.pathname}${location.search}${location.hash || openedNotificationHash()}`,
    target,
  );
  const endpoint = await taskPushEndpoint();
  if (endpoint) url.searchParams.set(PUSH_TWIN_PARAM, endpoint);
  location.replace(url.href);
}

/** Once per page load, after the first hello. */
export function initDirectPath() {
  bridge.onHello((hello) => void tryDirectPath(hello));
}
