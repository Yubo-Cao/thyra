import { useEffect, useMemo, useRef } from "react";
import type { ConnectionClient } from "./api";
import {
  type CollaborationSnapshot,
  subscribeCollaborationSnapshot,
} from "./collaboration";
import {
  focusSignature,
  type PersonFocus,
  personFocus,
} from "./collaborationFocus";
import type { PresenceSelf } from "./collaborationGroups";
import { followTarget, stopFollowing, useFollowTarget } from "./followState";
import {
  navigateProgrammatically,
  onUserNavigation,
  type State,
  store,
} from "./store";

/** How long a followed person may vanish (a reconnect) before following ends. */
export const FOLLOW_DISCONNECT_GRACE_MS = 3_000;

/**
 * Moves this page to the followed person's focus. `navigate` returns whether
 * the focus was fully applied; an unknown pane (created a moment ago) is
 * retried on the next evaluation.
 */
export function createFollowController(deps: {
  navigate: (focus: PersonFocus) => boolean;
  graceMs?: number;
  now?: () => number;
}) {
  const graceMs = deps.graceMs ?? FOLLOW_DISCONNECT_GRACE_MS;
  const now = () => deps.now?.() ?? Date.now();
  let snapshot: CollaborationSnapshot | null = null;
  let self: PresenceSelf = { participantId: "" };
  let followedKey: string | null = null;
  let applied = "";
  let navigating = false;
  let missingTimer: ReturnType<typeof setTimeout> | null = null;

  const clearMissing = () => {
    if (missingTimer) clearTimeout(missingTimer);
    missingTimer = null;
  };

  function evaluate() {
    const target = followTarget();
    if (!target) {
      followedKey = null;
      applied = "";
      clearMissing();
      return;
    }
    if (target.key !== followedKey) {
      followedKey = target.key;
      applied = "";
      clearMissing();
    }
    const focus = personFocus(snapshot, target.key, self, now());
    if (!focus) {
      missingTimer ??= setTimeout(() => {
        missingTimer = null;
        if (
          followTarget()?.key === target.key &&
          !personFocus(snapshot, target.key, self, now())
        )
          stopFollowing("disconnected");
      }, graceMs);
      return;
    }
    clearMissing();
    const signature = focusSignature(focus);
    // Navigating updates the store, which evaluates again: ignore that.
    if (signature === applied || navigating) return;
    navigating = true;
    try {
      if (deps.navigate(focus)) applied = signature;
    } finally {
      navigating = false;
    }
  }

  return {
    update(nextSnapshot: CollaborationSnapshot | null, nextSelf: PresenceSelf) {
      snapshot = nextSnapshot;
      self = nextSelf;
      evaluate();
    },
    evaluate,
    snapshot: () => snapshot,
    /** The user moved this page's view: following ends. */
    userNavigated() {
      stopFollowing("navigated");
    },
    keyDown(key: string) {
      if (key === "Escape") stopFollowing("escape");
    },
    dispose: clearMissing,
  };
}

function currentFocus(state: State) {
  const workspace = state.workspaces.find((entry) => entry.focused);
  return {
    workspaceId: workspace?.workspace_id,
    tabId: workspace?.active_tab_id ?? state.layout?.tab_id,
    paneId: state.selectedPaneId ?? state.layout?.focused_pane_id,
  };
}

/** Bring the followed pane's sidebar row into view once it is selected. */
function revealPane(paneId: string, attempt = 0) {
  if (typeof document === "undefined") return;
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(
      `.agent-row[data-pane-id="${CSS.escape(paneId)}"]`,
    );
    if (row?.classList.contains("is-selected") || attempt >= 2) {
      row?.scrollIntoView({ block: "nearest" });
      return;
    }
    setTimeout(() => revealPane(paneId, attempt + 1), 150);
  });
}

const REPEAT_REQUEST_MS = 1_000;
let lastRequest = { key: "", at: 0 };

/**
 * Issue one navigation, not again while the same request is in flight (shared
 * navigation reflects in the store only after its RPCs).
 */
function request(key: string, run: () => unknown) {
  const at = Date.now();
  if (key === lastRequest.key && at - lastRequest.at < REPEAT_REQUEST_MS)
    return;
  lastRequest = { key, at };
  navigateProgrammatically(run);
}

/**
 * Select a person's focus in this page. Following never counts as the user's
 * own navigation; a jump does (and so ends following).
 */
export function navigateToFocus(
  focus: PersonFocus,
  mode: "follow" | "jump" = "follow",
): boolean {
  const go = (key: string, run: () => unknown) => {
    if (mode === "follow") request(key, run);
    else void run();
  };
  const state = store.get();
  const pane = focus.paneId
    ? state.panes.find((entry) => entry.pane_id === focus.paneId)
    : undefined;
  const tab =
    !pane && focus.tabId
      ? state.tabs.find((entry) => entry.tab_id === focus.tabId)
      : undefined;
  const workspace =
    !pane && !tab && focus.workspaceId
      ? state.workspaces.find(
          (entry) => entry.workspace_id === focus.workspaceId,
        )
      : undefined;
  const current = currentFocus(state);
  if (pane) {
    if (
      current.paneId !== pane.pane_id ||
      current.tabId !== pane.tab_id ||
      current.workspaceId !== pane.workspace_id
    )
      go(`pane:${pane.pane_id}`, () => store.focusPane(pane.pane_id));
  } else if (tab) {
    if (current.tabId !== tab.tab_id)
      go(`tab:${tab.tab_id}`, () => store.focusTab(tab.tab_id));
  } else if (workspace && current.workspaceId !== workspace.workspace_id) {
    go(`workspace:${workspace.workspace_id}`, () =>
      store.focusWorkspace(workspace.workspace_id),
    );
  }
  if (pane) revealPane(pane.pane_id);
  return focus.paneId ? !!pane : focus.tabId ? !!tab : true;
}

/**
 * Follow mode for this page: follow the target's focus, and stop when this
 * user navigates, presses Escape, switches connection, or the person leaves.
 */
export function useFollowController(
  client: ConnectionClient,
  self: PresenceSelf,
) {
  const controller = useMemo(
    () =>
      createFollowController({ navigate: (focus) => navigateToFocus(focus) }),
    [],
  );
  const target = useFollowTarget();
  const selfRef = useRef(self);
  selfRef.current = self;
  useEffect(() => controller.dispose, [controller]);
  useEffect(() => () => stopFollowing("connection"), [client]);
  // Straight from the presence event, not after a React render: moving the
  // view is what the follower waits for.
  useEffect(
    () =>
      subscribeCollaborationSnapshot(client, (snapshot) =>
        controller.update(snapshot, selfRef.current),
      ),
    [client, controller],
  );
  useEffect(() => {
    controller.update(controller.snapshot(), self);
  }, [controller, self, target]);
  useEffect(() => {
    if (!target) return;
    const offNavigation = onUserNavigation(controller.userNavigated);
    const onKeyDown = (event: KeyboardEvent) => controller.keyDown(event.key);
    window.addEventListener("keydown", onKeyDown, true);
    // Panes created a moment ago appear in the store after their focus.
    const offStore = store.subscribe(controller.evaluate);
    return () => {
      offNavigation();
      offStore();
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [controller, target]);
}
