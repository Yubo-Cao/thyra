import { t } from "./i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionClient } from "./api";
import {
  collaborationProfile,
  collaborationSelfIdentity,
  parseDisplayOwners,
  publishCollaborationSnapshot,
  publishDisplayOwners,
  subscribeCollaborationSnapshot,
  updateCollaborationPresence,
  type CollaborationSnapshot,
} from "./collaboration";
import { workspaceCan } from "./capabilities";
import { paneControlClient, paneControlState } from "./paneControl";
import { store, useStoreSelector } from "./store";

export function usePaneControl(
  client: ConnectionClient,
  paneId: string | undefined,
) {
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot | null>(null);
  const [viewingScope, setViewingScope] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const scope = `${client.connectionId}:${client.generation}:${client.serverRuntimeGeneration}:${paneId}`;
  useEffect(() => {
    setBusy(false);
    setError("");
  }, [scope]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const participantId = collaborationProfile().participantId;
  // Without `edit` here (viewers, guests) the page only watches; the bridge
  // refuses input. With `manage` (owners, instance admins) it may take
  // control during another person's protection.
  const workspace = useStoreSelector((state) => {
    const pane = state.panes.find((item) => item.pane_id === paneId);
    return pane
      ? state.workspaces.find((item) => item.workspace_id === pane.workspace_id)
      : undefined;
  });
  useEffect(
    () => subscribeCollaborationSnapshot(client, setSnapshot),
    [client],
  );
  useEffect(() => {
    const claim = snapshot?.pane_claims.find((item) => item.pane_id === paneId);
    if (!claim) return;
    const deadline = Math.min(
      ...[claim.expires_at_unix_ms, claim.protected_until_unix_ms].filter(
        (value): value is number =>
          typeof value === "number" && value > Date.now(),
      ),
    );
    if (!Number.isFinite(deadline)) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      deadline - Date.now() + 20,
    );
    return () => clearTimeout(timer);
  }, [snapshot, paneId, now]);
  const access = paneControlState(
    snapshot,
    paneId,
    participantId,
    viewingScope === scope,
    Date.now(),
    {
      readOnly: !!workspace && !workspaceCan(workspace, "edit"),
      overridesProtection: workspaceCan(workspace, "manage"),
      personId: collaborationSelfIdentity()?.person_id ?? null,
    },
  );
  const accessRef = useRef(access);
  accessRef.current = access;
  // Set by the terminal view: opens local history for a read-only viewer.
  const localScroll = useRef<
    ((params: Record<string, unknown>) => void) | null
  >(null);
  const guardedClient = useMemo(
    () =>
      paneControlClient(
        client,
        () => accessRef.current,
        () => localScroll.current,
      ),
    [client],
  );
  const assertInputAllowed = useCallback(() => {
    if (accessRef.current.viewOnly)
      throw new Error(t("This pane is view only. Take control to send input."));
  }, []);
  /**
   * `view`: stop typing and resizing. `type`: take the control claim and
   * type here while the displaying device keeps the size. `resize`: take the
   * claim and the display, so this device's viewport sizes the pane.
   */
  const change = useCallback(
    async (mode: "view" | "type" | "resize") => {
      const viewOnly = mode === "view";
      if (!paneId || busy || !client.isCurrent()) return;
      if (!viewOnly && accessRef.current.readOnly) return;
      const expectedScope = scope;
      setBusy(true);
      setError("");
      // Disable local input immediately, before awaiting release.
      if (viewOnly) {
        accessRef.current = {
          ...accessRef.current,
          viewOnly: true,
          canResize: false,
        };
        setViewingScope(scope);
      }
      try {
        await updateCollaborationPresence(client, store.get());
        if (currentScope.current !== expectedScope || !client.isCurrent())
          return;
        const result = await client.call(
          viewOnly ? "collaboration.release" : "collaboration.claim",
          {
            pane_id: paneId,
            participant_id: participantId,
            ...(viewOnly ? {} : { takeover: true, protect_ms: 15_000 }),
          },
        );
        if (currentScope.current !== expectedScope || !client.isCurrent())
          return;
        if (!viewOnly && result?.granted !== true)
          throw new Error(
            t(
              "Another collaborator controls this pane. Try again when its protection ends.",
            ),
          );
        if (!viewOnly) setViewingScope(null);
        if (mode === "resize" && accessRef.current.display) {
          const taken = await client.call("terminal.display", {
            pane_id: paneId,
            action: "take",
          });
          const owners = parseDisplayOwners(taken?.display_owners);
          if (owners && currentScope.current === expectedScope)
            publishDisplayOwners(client, owners);
        }
        const latest = await client.call("collaboration.list");
        if (
          currentScope.current === expectedScope &&
          client.isCurrent() &&
          latest?.snapshot
        )
          publishCollaborationSnapshot(client, latest.snapshot);
      } catch (failure) {
        if (currentScope.current === expectedScope)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      } finally {
        if (currentScope.current === expectedScope) setBusy(false);
      }
    },
    [client, paneId, participantId, scope, busy],
  );
  /** Pin the pane's size to this device's screen, or give the pin back. */
  const toggleDisplayPin = useCallback(async () => {
    if (!paneId || busy || !client.isCurrent()) return;
    const expectedScope = scope;
    const display = accessRef.current.display;
    const pinned = display?.mine === true && display.pinned;
    setBusy(true);
    setError("");
    try {
      const result = await client.call("terminal.display", {
        pane_id: paneId,
        action: pinned ? "release" : "pin",
      });
      const owners = parseDisplayOwners(result?.display_owners);
      if (owners && currentScope.current === expectedScope)
        publishDisplayOwners(client, owners);
    } catch (failure) {
      if (currentScope.current === expectedScope)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (currentScope.current === expectedScope) setBusy(false);
    }
  }, [client, paneId, scope, busy]);
  return {
    access,
    client: guardedClient,
    localScroll,
    assertInputAllowed,
    busy,
    error,
    /** Take control and size the pane for this device. */
    takeControl: () => change("resize"),
    /** Type here; the displaying device keeps the size. */
    typeHere: () => change("type"),
    watch: () => change("view"),
    toggleDisplayPin,
  };
}
