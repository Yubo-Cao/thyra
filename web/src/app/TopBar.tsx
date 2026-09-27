import { Suspense } from "react";
import packageJson from "../../package.json";
import { CommandMenu } from "../components/CommandMenu";
import { ConfigMenu } from "../components/ConfigMenu";
import type { ConfigurationProps } from "../components/ConfigurationDialog";
import { LazyConnectionSwitcher } from "../components/ConnectionSwitcherTrigger";
import { lazyWithReload } from "../lazyWithReload";
import type { WorkspaceInspector } from "./useWorkspaceInspector";

const LazyCollaborationBar = lazyWithReload("collaboration-bar", () =>
  import("../components/CollaborationBar").then((module) => ({
    default: module.CollaborationBar,
  })),
);

/** Brand, connection and collaboration status, command and settings menus. */
export function TopBar({
  resourceUiKey,
  startupReady,
  configuration,
  zenMode,
  onZenModeChange,
  inspector,
  onOpenProjectLauncher,
}: {
  /** Remounts the menus when the connection changes. */
  resourceUiKey: string;
  startupReady: boolean;
  configuration: ConfigurationProps;
  zenMode: boolean;
  onZenModeChange: (zenMode: boolean) => void;
  inspector: Pick<
    WorkspaceInspector,
    "openFileExplorer" | "openFileExplorerFile" | "openDiffViewer"
  >;
  onOpenProjectLauncher: () => void;
}) {
  return (
    <header className="topbar">
      <div className="topbar-start">
        <div className="brand">
          <img
            className="logo"
            src="/thyra-mark-48.png"
            srcSet="/thyra-mark-48.png 2x, /thyra-mark-72.png 3x"
            width={24}
            height={24}
            alt=""
          />
          <span className="brand-title">Thyra</span>
          <span className="brand-version">v{packageJson.version}</span>
        </div>
        <LazyConnectionSwitcher />
        {startupReady ? (
          <Suspense fallback={null}>
            <LazyCollaborationBar />
          </Suspense>
        ) : null}
      </div>
      <div className="topbar-actions">
        <div className="topbar-command-group">
          <CommandMenu
            key={`${resourceUiKey}:commands`}
            onOpenFileExplorer={inspector.openFileExplorer}
            onOpenFile={inspector.openFileExplorerFile}
            onOpenDiffViewer={inspector.openDiffViewer}
            onOpenProjectLauncher={onOpenProjectLauncher}
          />
          <ConfigMenu
            key={`${resourceUiKey}:config`}
            {...configuration}
            zenMode={zenMode}
            onZenModeChange={onZenModeChange}
          />
        </div>
      </div>
    </header>
  );
}
