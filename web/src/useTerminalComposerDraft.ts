import { useEffect, useState } from "react";
import {
  readTerminalComposerDraft,
  subscribeTerminalComposerDraft,
  subscribeTerminalComposerSubmission,
  subscribeTerminalComposerUpload,
  terminalComposerSubmissionPending,
  terminalComposerUploadCount,
} from "./terminalComposer";

/**
 * A pane draft's text and its in-flight send and uploads, kept in sync with
 * the shared store: async work begun by an earlier mount (an upload, a failed
 * send restoring its text) lands in whichever editor shows the draft now.
 */
export function useTerminalComposerDraft(draftKey: string) {
  const [text, setText] = useState(() => readTerminalComposerDraft(draftKey));
  const [submissionPending, setSubmissionPending] = useState(() =>
    terminalComposerSubmissionPending(draftKey),
  );
  const [uploadCount, setUploadCount] = useState(() =>
    terminalComposerUploadCount(draftKey),
  );
  useEffect(() => {
    setText(readTerminalComposerDraft(draftKey));
    return subscribeTerminalComposerDraft(draftKey, setText);
  }, [draftKey]);
  useEffect(() => {
    setSubmissionPending(terminalComposerSubmissionPending(draftKey));
    return subscribeTerminalComposerSubmission(draftKey, setSubmissionPending);
  }, [draftKey]);
  useEffect(() => {
    setUploadCount(terminalComposerUploadCount(draftKey));
    return subscribeTerminalComposerUpload(draftKey, setUploadCount);
  }, [draftKey]);
  return { text, setText, submissionPending, uploadCount };
}

/** Whether a pane's draft holds text; re-renders only when that changes. */
export function useTerminalComposerHasDraft(draftKey: string): boolean {
  const [hasDraft, setHasDraft] = useState(
    () => !!readTerminalComposerDraft(draftKey),
  );
  useEffect(() => {
    setHasDraft(!!readTerminalComposerDraft(draftKey));
    return subscribeTerminalComposerDraft(draftKey, (text) =>
      setHasDraft(!!text),
    );
  }, [draftKey]);
  return hasDraft;
}
