import { Suspense, useSyncExternalStore } from "react";
import { LazyToastRegion } from "./lazyOverlays";
import { toastController } from "./toastQueue";

export {
  toast,
  type ToastContent,
  type ToastOptions,
  type ToastTone,
} from "./toastQueue";

/**
 * Render once near the app root. It renders nothing until the first
 * `toast.*()` call, then loads the React Aria toast region (overlay chunk) and
 * replays the queued toasts. Stacks at the top end, below the top bar.
 */
export function ToastRegion() {
  const requested = useSyncExternalStore(
    toastController.subscribe,
    toastController.getRequested,
    () => false,
  );
  if (!requested) return null;
  return (
    <Suspense fallback={null}>
      <LazyToastRegion controller={toastController} />
    </Suspense>
  );
}
