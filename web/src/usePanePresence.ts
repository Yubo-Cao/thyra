import { useEffect, useMemo, useState } from "react";
import {
  type CollaborationSnapshot,
  collaborationProfile,
  collaborationSelfIdentity,
  subscribeCollaborationIdentity,
  subscribeCollaborationSnapshot,
} from "./collaboration";
import {
  type PanePresence,
  type PresenceSelf,
  panePresence,
  panePresenceSignature,
} from "./collaborationGroups";
import { useConnectionClient } from "./useConnectionClient";

/** This page's participant plus its bridge-resolved person and device. */
export function usePresenceSelf(): PresenceSelf {
  const [identity, setIdentity] = useState(collaborationSelfIdentity);
  useEffect(() => subscribeCollaborationIdentity(setIdentity), []);
  const participantId = collaborationProfile().participantId;
  const personId = identity?.person_id;
  const deviceId = identity?.device_id;
  return useMemo(
    () => ({ participantId, personId, deviceId }),
    [participantId, personId, deviceId],
  );
}

const NO_PRESENCE = {
  signature: "",
  presence: panePresence(null, [], { participantId: "" }),
};

/**
 * Viewers and controller of the given panes. Re-renders only when that
 * presence changes, not on every presence snapshot.
 */
export function usePanePresence(paneIds: readonly string[]): PanePresence {
  const client = useConnectionClient();
  const self = usePresenceSelf();
  const key = paneIds.join("\n");
  const [state, setState] = useState(NO_PRESENCE);
  useEffect(() => {
    const ids = key ? key.split("\n") : [];
    return subscribeCollaborationSnapshot(
      client,
      (snapshot: CollaborationSnapshot | null) => {
        const presence = panePresence(snapshot, ids, self);
        const signature = panePresenceSignature(presence);
        setState((previous) =>
          previous.signature === signature ? previous : { signature, presence },
        );
      },
    );
  }, [client, key, self]);
  return state.presence;
}
