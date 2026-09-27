import { lazyPanel } from "../lazyWithReload";

// Surfaces opened from more than one place, or from inside the terminal
// chunk, are declared here so the app shell can prefetch them at idle
// without importing their owners.
export const createWorkspaceDialog = lazyPanel("create-workspace", () =>
  import("./CreateWorkspaceDialog").then(
    (module) => module.CreateWorkspaceDialog,
  ),
);
export const terminalComposerPanel = lazyPanel("terminal-composer", () =>
  import("./TerminalComposer").then((module) => module.TerminalComposer),
);
export const annotationComposerPanel = lazyPanel("annotation-composer", () =>
  import("./AnnotationComposerPopover").then(
    (module) => module.AnnotationComposerPopover,
  ),
);
export const terminalFileLinkMenuPanel = lazyPanel(
  "terminal-file-link-menu",
  () =>
    import("./TerminalFileLinkMenu").then(
      (module) => module.TerminalFileLinkMenu,
    ),
);
// Terminal dialogs load their overlay wrappers with the first one opened,
// not with the terminal's first output.
export const terminalConfirmDialog = lazyPanel("terminal-confirm-dialog", () =>
  import("./ui/ConfirmDialog").then((module) => module.ConfirmDialog),
);
export const terminalMessageDialog = lazyPanel("terminal-dialog", () =>
  import("./ui/Dialog").then((module) => module.Dialog),
);
