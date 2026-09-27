import { thyraSessionStorage } from "./browserStorage";
import { type ComponentType, createElement, lazy, useState } from "react";

// After an in-app update, the restarted server only embeds the new build's
// hashed chunks, so a lazy import from an older open tab 404s and crashes the
// root error boundary. Reload each lazy component once to fetch fresh assets;
// other components loading successfully must not reset its retry guard.
export async function importWithReload<T>(
  componentKey: string,
  factory: () => Promise<T>,
): Promise<T> {
  const reloadKey = `lazyChunkReload:${componentKey}`;
  try {
    const module = await factory();
    thyraSessionStorage.removeItem(reloadKey);
    return module;
  } catch (error) {
    if (thyraSessionStorage.getItem(reloadKey)) throw error;
    // Without a stored guard every reload would fail the same way and loop.
    if (!thyraSessionStorage.setItem(reloadKey, "1")) throw error;
    window.location.reload();
    // Keep the lazy boundary suspended while the page unloads.
    return new Promise<T>(() => {});
  }
}

export function lazyWithReload<C extends ComponentType<any>>(
  componentKey: string,
  factory: () => Promise<{ default: C }>,
) {
  return lazy(() => importWithReload(componentKey, factory));
}

/** A code-split component that can also be fetched ahead of its first use. */
export type LazyPanel<P extends object> = {
  Component: ComponentType<P>;
  /** Fetch the chunk without rendering; failures stay silent. */
  preload: () => Promise<void>;
  /** Whether Component renders without suspending. */
  isLoaded: () => boolean;
};

/**
 * Like lazyWithReload, for surfaces whose chunk is worth prefetching (idle
 * prefetch, first interaction). A failed prefetch never reloads the page:
 * only a render that needs the chunk falls back to importWithReload. Once
 * loaded, new mounts render the component directly, so a prefetched surface
 * opens in the same commit without a Suspense fallback frame.
 */
export function lazyPanel<P extends object>(
  componentKey: string,
  factory: () => Promise<ComponentType<P>>,
): LazyPanel<P> {
  let component: ComponentType<P> | null = null;
  let prefetching: Promise<void> | null = null;
  const remember = (loaded: ComponentType<P>) => (component = loaded);
  const Lazy = lazy(async () => ({
    default:
      component ?? remember(await importWithReload(componentKey, factory)),
  }));
  function LazyPanelComponent(props: P) {
    // Fixed per mount: switching element types later would remount it.
    const [Loaded] = useState(() => component);
    return Loaded ? createElement(Loaded, props) : createElement(Lazy, props);
  }
  LazyPanelComponent.displayName = `LazyPanel(${componentKey})`;
  return {
    Component: LazyPanelComponent,
    preload: () => {
      if (component) return Promise.resolve();
      prefetching ??= factory().then(
        (loaded) => void remember(loaded),
        () => {
          prefetching = null;
        },
      );
      return prefetching;
    },
    isLoaded: () => component !== null,
  };
}
