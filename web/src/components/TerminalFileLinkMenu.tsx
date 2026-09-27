import { useEffect, useState } from "react";
import type { ConnectionClient } from "../api";
import {
  directoryPreviewPath,
  normalizeFilesystemPath,
} from "../filesystemPaths";
import { t } from "../i18n";
import { useStoreSelector } from "../store";
import { requestFilePreview } from "./fileExplorerResources";
import { ContextMenu } from "./ui/ContextMenu";

export type TerminalFileLinkMenuState = {
  x: number;
  y: number;
  path: string;
  workspaceId: string;
};

export function TerminalFileLinkMenu({
  state,
  client,
  onPreview,
  onWorkspace,
  onClose,
}: {
  state: TerminalFileLinkMenuState;
  client: ConnectionClient;
  onPreview: (path: string) => void;
  onWorkspace: (path: string) => void;
  onClose: () => void;
}) {
  const workspaces = useStoreSelector((state) => state.workspaces);
  const [directory, setDirectory] = useState<string | null>(null);
  const alreadyOpen =
    directory !== null &&
    workspaces.some((workspace) => {
      const root = workspace.worktree?.checkout_path ?? workspace.cwd;
      return root && normalizeFilesystemPath(root) === directory;
    });
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let current = true;
    setDirectory(null);
    setChecking(true);
    void requestFilePreview(state.workspaceId, state.path, { client })
      .then(
        (preview) => {
          if (current && client.isCurrent())
            setDirectory(directoryPreviewPath(preview));
        },
        () => {
          /* Preview retains the existing error UI for unavailable paths. */
        },
      )
      .finally(() => {
        if (current) setChecking(false);
      });
    return () => {
      current = false;
    };
  }, [client, state]);
  return (
    <ContextMenu
      position={{ x: state.x, y: state.y }}
      header={{ title: state.path }}
      aria-label={t("File actions")}
      onClose={onClose}
      items={[
        {
          id: "file-actions",
          title: t("File actions"),
          items: [
            {
              id: "preview",
              label: directory ? t("Preview directory") : t("Preview file"),
              onAction: () => onPreview(state.path),
            },
            ...(directory && !alreadyOpen
              ? [
                  {
                    id: "workspace",
                    label: t("Open directory as workspace..."),
                    onAction: () => onWorkspace(directory),
                  },
                ]
              : []),
            ...(checking
              ? [
                  {
                    id: "checking",
                    label: t("Checking directory..."),
                    disabled: true,
                  },
                ]
              : []),
          ],
        },
      ]}
    />
  );
}
