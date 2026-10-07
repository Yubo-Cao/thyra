import type { ITheme } from "@xterm/xterm";
import { Suspense, useEffect, useRef } from "react";
import { commandComboboxPanel } from "../components/CommandMenu";
import { configMenuPanel } from "../components/ConfigMenu";
import { connectionSwitcherPanel } from "../components/ConnectionSwitcherTrigger";
import {
  createWorkspaceDialog,
  promptEditorPanel,
  terminalComposerPanel,
  terminalFileLinkMenuPanel,
} from "../components/lazyPanels";
import { themedSelectPanel } from "../components/LazyThemedSelect";
import { textInputDialogPanel } from "../components/ModalDialogs";
import { preloadOverlays } from "../components/ui/lazyOverlays";
import { workspaceContextMenu } from "../components/WorkspaceTree";
import { prefetchWhenIdle } from "../idlePrefetch";
import { lazyPanel, lazyWithReload } from "../lazyWithReload";
import { useStoreSelector } from "../store";

// Surfaces that open on demand; Latched keeps them mounted afterwards.
export const workspaceInspectorPanel = lazyPanel("workspace-inspector", () =>
  import("../components/WorkspaceInspectorHost").then(
    (module) => module.WorkspaceInspectorPanel,
  ),
);
export const mobileTabSheet = lazyPanel("mobile-tab-sheet", () =>
  import("../components/MobileTabSheet").then(
    (module) => module.MobileTabSheet,
  ),
);
// The notice/update toasts and their queue load with the first notice.
export const noticeToastsPanel = lazyPanel("notice-toasts", () =>
  import("../components/NoticeToasts").then((module) => module.NoticeToasts),
);
export const projectLauncherPanel = lazyPanel("project-launcher", () =>
  import("../components/ProjectLauncher").then(
    (module) => module.ProjectLauncher,
  ),
);
// Delegated tooltips and overlay scrollbar thumbs load after the first output.
const LazyGlobalTooltip = lazyWithReload("global-tooltip", () =>
  import("../components/GlobalTooltip").then((module) => ({
    default: module.GlobalTooltip,
  })),
);
const LazyOverlayScrollbarLayer = lazyWithReload("overlay-scrollbars", () =>
  import("../components/OverlayScrollbarLayer").then((module) => ({
    default: module.OverlayScrollbarLayer,
  })),
);
// The inspector's file and diff caches are not needed for the first screen.
export const fileExplorerResources = () =>
  import("../components/fileExplorerResources");
export const gitDiffQueries = () => import("../inspectorQueries");

// Once the terminal has output, fetch the surfaces people open next, most
// likely first, one chunk per idle period (skipped under Data Saver and 2G).
const IDLE_PREFETCH_DELAY_MS = 1000;
function idlePrefetchLoaders(mobile: boolean) {
  return [
    ...(mobile ? [terminalComposerPanel.preload] : []),
    commandComboboxPanel.preload,
    configMenuPanel.preload,
    connectionSwitcherPanel.preload,
    workspaceContextMenu.preload,
    preloadOverlays,
    themedSelectPanel.preload,
    textInputDialogPanel.preload,
    terminalFileLinkMenuPanel.preload,
    createWorkspaceDialog.preload,
    projectLauncherPanel.preload,
    ...(mobile ? [mobileTabSheet.preload] : [promptEditorPanel.preload]),
    workspaceInspectorPanel.preload,
  ];
}

export function useIdlePrefetch(startupReady: boolean, mobile: boolean) {
  const startedRef = useRef(false);
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;
  useEffect(() => {
    if (!startupReady || startedRef.current) return;
    const timer = window.setTimeout(() => {
      startedRef.current = true;
      // The terminal chunk is already on its way; start after it arrives.
      void import("../components/TerminalView").then(
        () => void prefetchWhenIdle(idlePrefetchLoaders(mobileRef.current)),
        () => undefined,
      );
    }, IDLE_PREFETCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [startupReady]);
}

/** Layers that wait for the startup gate (first terminal output). */
export function StartupLayers() {
  return (
    <Suspense fallback={null}>
      <LazyGlobalTooltip />
      <LazyOverlayScrollbarLayer />
    </Suspense>
  );
}

// Keep this import after the terminal's: Rollup lays out the shared xterm
// vendor chunk in the order dynamic imports first reach it.
// xterm.js is heavy; keep the overlay's own copy out of the initial bundle the
// same way LazyTerminalView does, since most sessions never open a popup.
const LazyPopupOverlay = lazyWithReload("popup-overlay", () =>
  import("../components/PopupOverlay").then((module) => ({
    default: module.PopupOverlay,
  })),
);

export function PopupOverlay({ terminalTheme }: { terminalTheme: ITheme }) {
  // Gate the dynamic import on popup presence, not just its content, so a
  // session that never opens one never fetches xterm.js for it.
  const hasPopup = useStoreSelector((s) => s.popup !== null);
  if (!hasPopup) return null;
  return (
    <Suspense fallback={null}>
      <LazyPopupOverlay terminalTheme={terminalTheme} />
    </Suspense>
  );
}
