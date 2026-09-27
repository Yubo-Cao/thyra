import {
  Component,
  type ReactNode,
  Suspense,
  useEffect,
  useState,
} from "react";
import { t } from "../i18n";
import { store } from "../store";

type BoundaryState = { failed: boolean };

// importWithReload already reloaded the page once for a missing chunk; a
// second failure lands here. Report it and drop only this surface instead of
// letting the root error boundary replace the whole app.
class LazyErrorBoundary extends Component<
  { children: ReactNode },
  BoundaryState
> {
  state: BoundaryState = { failed: false };
  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
    store.notify({
      kind: "error",
      message: t("Could not load this part of Thyra"),
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Suspense plus a local error boundary for a lazily loaded surface. */
export function LazyBoundary({
  fallback = null,
  children,
}: {
  fallback?: ReactNode;
  children: ReactNode;
}) {
  return (
    <LazyErrorBoundary>
      <Suspense fallback={fallback}>{children}</Suspense>
    </LazyErrorBoundary>
  );
}

/**
 * True from the first time `active` is true. Lazy surfaces that keep state
 * while hidden (drafts, follow-up dialogs) stay mounted after they first
 * open, exactly as when they were part of the initial bundle.
 */
export function useMountLatch(active: boolean) {
  const [latched, setLatched] = useState(active);
  if (active && !latched) setLatched(true);
  return latched || active;
}

/**
 * Becomes true once `panel` can render: immediately when its chunk is already
 * loaded, otherwise after the fetch that `active` starts settles. A failed
 * fetch also settles, so the render goes through importWithReload's stale
 * chunk recovery and LazyBoundary's error report.
 */
export function usePanelReady(
  panel: { preload: () => Promise<void>; isLoaded: () => boolean },
  active: boolean,
) {
  const [ready, setReady] = useState(panel.isLoaded);
  useEffect(() => {
    if (!active || ready) return;
    let cancelled = false;
    void panel.preload().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [active, panel, ready]);
  return ready;
}

/** Fallback for a lazy surface with no eager placeholder of its own. */
export function LazyPendingStatus({
  label = t("Loading..."),
}: {
  label?: string;
}) {
  return (
    <div className="lazy-pending-status" role="status">
      <span className="terminal-loading-dot" aria-hidden="true" />
      {label}
    </div>
  );
}

/**
 * Render a lazy panel's element from the first time `open` is true and keep
 * it mounted, so the panel keeps its state while hidden like an eagerly
 * bundled one.
 */
export function Latched({
  open,
  fallback = <LazyPendingStatus />,
  children,
}: {
  open: boolean;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const mounted = useMountLatch(open);
  if (!mounted) return null;
  return (
    <LazyBoundary fallback={open ? fallback : null}>{children}</LazyBoundary>
  );
}
