import { t } from "./i18n";
import { prepareTerminalPasteText } from "./terminalPaste";

/**
 * Draft storage shared by the terminal composers: the mobile bottom composer
 * and the desktop prompt editor edit the same per-pane draft.
 *
 * Drafts live only in memory: terminal input can contain secrets, so they
 * must never reach localStorage. Keys are scoped by connection identity
 * (including the reconnect generation) and pane ID, so a reconnect or a pane
 * switch never mixes drafts or sends text to the wrong pane.
 */
const drafts = new Map<string, string>();
const selections = new Map<string, { start: number; end: number }>();
const retiredDraftKeys = new Set<string>();
let activeDraftScopePrefix: string | null = null;
type TerminalComposerDraftListener = (text: string) => void;
type TerminalComposerSubmissionListener = (pending: boolean) => void;
type TerminalComposerUploadListener = (count: number) => void;
const draftListeners = new Map<string, Set<TerminalComposerDraftListener>>();
const pendingSubmissions = new Set<string>();
const submissionListeners = new Map<
  string,
  Set<TerminalComposerSubmissionListener>
>();
const pendingUploads = new Map<string, number>();
const uploadListeners = new Map<string, Set<TerminalComposerUploadListener>>();
/** A pasted image: `ref` numbers it in the draft, `path` once uploaded. */
export type ComposerImage = {
  id: string;
  file: File;
  path: string | null;
  ref: number;
};
const imagesByDraft = new Map<string, ComposerImage[]>();
const imageListeners = new Map<string, Set<() => void>>();
const NO_IMAGES: readonly ComposerImage[] = [];
export function readComposerImages(key: string): readonly ComposerImage[] {
  return imagesByDraft.get(key) ?? NO_IMAGES;
}
export function subscribeComposerImages(key: string, listener: () => void) {
  const listeners = imageListeners.get(key) ?? new Set();
  listeners.add(listener);
  imageListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) imageListeners.delete(key);
  };
}
function setComposerImages(key: string, images: readonly ComposerImage[]) {
  for (const image of imagesByDraft.get(key) ?? [])
    if (!images.some((kept) => kept.file === image.file))
      revokeComposerImageUrl(image.file);
  if (images.length) imagesByDraft.set(key, [...images]);
  else imagesByDraft.delete(key);
  for (const listener of imageListeners.get(key) ?? []) listener();
}

const imageUrls = new Map<File, string>();
/** A local URL for a pasted image's file, kept while the draft holds it. */
export function composerImageUrl(image: ComposerImage): string {
  let url = imageUrls.get(image.file);
  if (!url) {
    url = URL.createObjectURL(image.file);
    imageUrls.set(image.file, url);
  }
  return url;
}
function revokeComposerImageUrl(file: File) {
  const url = imageUrls.get(file);
  if (!url) return;
  imageUrls.delete(file);
  URL.revokeObjectURL(url);
}

/** How a draft names its Nth pasted image, as Claude Code does. */
export function composerImageToken(ref: number): string {
  return `[Image #${ref}]`;
}
/** Claude Code's `[Image #2]` and Codex's `[image 2 ...]` placeholders. */
export const COMPOSER_IMAGE_TOKEN = /\[image #?(\d+)[^\]\n]*\]/gi;

/**
 * Whether the text still shows a pasted image. Images stay with the draft
 * until it is sent or cleared, so undoing a deletion brings them back.
 */
export function composerImageInDraft(image: ComposerImage, text: string) {
  return (
    image.path === null ||
    text.includes(image.path) ||
    text.includes(composerImageToken(image.ref))
  );
}

/** The draft as sent: each pasted image's placeholder becomes its path. */
export function expandComposerImageTokens(
  text: string,
  images: readonly ComposerImage[],
): string {
  return text.replace(
    COMPOSER_IMAGE_TOKEN,
    (token, ref: string) =>
      images.find((image) => image.ref === Number(ref))?.path ?? token,
  );
}

function notifyTerminalComposerDraft(key: string, text: string): void {
  for (const listener of draftListeners.get(key) ?? []) listener(text);
}

function notifyTerminalComposerSubmission(key: string, pending: boolean): void {
  for (const listener of submissionListeners.get(key) ?? []) listener(pending);
}

function notifyTerminalComposerUpload(key: string, count: number): void {
  for (const listener of uploadListeners.get(key) ?? []) listener(count);
}

function clearTerminalComposerUploads(key: string): void {
  if (!pendingUploads.delete(key)) return;
  notifyTerminalComposerUpload(key, 0);
}

function terminalComposerDraftScopePrefix(
  connectionId: string,
  connectionGeneration: number,
): string {
  return `${JSON.stringify([connectionId, connectionGeneration]).slice(0, -1)},`;
}

function terminalComposerDraftKeyIsActive(key: string): boolean {
  return (
    !retiredDraftKeys.has(key) &&
    (activeDraftScopePrefix === null || key.startsWith(activeDraftScopePrefix))
  );
}

export function terminalComposerDraftKey(
  connectionId: string,
  connectionGeneration: number,
  paneId: string,
): string {
  // Structured key: plain concatenation would let a digit-ending connection
  // ID collide across generations ("srv1"+2 vs "srv"+12).
  return JSON.stringify([connectionId, connectionGeneration, paneId]);
}

export function readTerminalComposerDraft(key: string): string {
  return drafts.get(key) ?? "";
}

export function readTerminalComposerSelection(
  key: string,
): { start: number; end: number } | null {
  return selections.get(key) ?? null;
}

/** Records the live textarea selection so async uploads use the latest mount. */
export function writeTerminalComposerSelection(
  key: string,
  selectionStart: number,
  selectionEnd: number,
): void {
  if (!terminalComposerDraftKeyIsActive(key)) return;
  const length = readTerminalComposerDraft(key).length;
  if (length === 0) {
    selections.delete(key);
    return;
  }
  const start = Math.max(0, Math.min(selectionStart, length));
  const end = Math.max(start, Math.min(selectionEnd, length));
  selections.set(key, { start, end });
}

export function writeTerminalComposerDraft(key: string, text: string): void {
  if (!text) {
    clearTerminalComposerDraft(key);
    return;
  }
  if (!terminalComposerDraftKeyIsActive(key)) return;
  if (drafts.get(key) === text) return;
  drafts.set(key, text);
  notifyTerminalComposerDraft(key, text);
}

export function clearTerminalComposerDraft(key: string): void {
  setComposerImages(key, []);
  selections.delete(key);
  if (!drafts.delete(key)) return;
  notifyTerminalComposerDraft(key, "");
}

/** Keeps mounted composers synchronized with async updates to their draft. */
export function subscribeTerminalComposerDraft(
  key: string,
  listener: TerminalComposerDraftListener,
): () => void {
  const listeners = draftListeners.get(key) ?? new Set();
  listeners.add(listener);
  draftListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) draftListeners.delete(key);
  };
}

export function terminalComposerSubmissionPending(key: string): boolean {
  return pendingSubmissions.has(key);
}

/** Starts at most one submission for a pane draft, even across remounts. */
export function beginTerminalComposerSubmission(key: string): boolean {
  if (!terminalComposerDraftKeyIsActive(key)) return false;
  if (pendingSubmissions.has(key)) return false;
  pendingSubmissions.add(key);
  notifyTerminalComposerSubmission(key, true);
  return true;
}

export function finishTerminalComposerSubmission(key: string): void {
  if (!pendingSubmissions.delete(key)) return;
  notifyTerminalComposerSubmission(key, false);
}

export function subscribeTerminalComposerSubmission(
  key: string,
  listener: TerminalComposerSubmissionListener,
): () => void {
  const listeners = submissionListeners.get(key) ?? new Set();
  listeners.add(listener);
  submissionListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) submissionListeners.delete(key);
  };
}

export function terminalComposerUploadCount(key: string): number {
  return pendingUploads.get(key) ?? 0;
}

/** Tracks uploads across composer remounts for the same pane draft. */
export function beginTerminalComposerUpload(key: string): boolean {
  if (!terminalComposerDraftKeyIsActive(key)) return false;
  const count = terminalComposerUploadCount(key) + 1;
  pendingUploads.set(key, count);
  notifyTerminalComposerUpload(key, count);
  return true;
}

export function finishTerminalComposerUpload(key: string): void {
  const count = terminalComposerUploadCount(key);
  if (count <= 0) return;
  if (count === 1) {
    clearTerminalComposerUploads(key);
    return;
  }
  pendingUploads.set(key, count - 1);
  notifyTerminalComposerUpload(key, count - 1);
}

export function subscribeTerminalComposerUpload(
  key: string,
  listener: TerminalComposerUploadListener,
): () => void {
  const listeners = uploadListeners.get(key) ?? new Set();
  listeners.add(listener);
  uploadListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) uploadListeners.delete(key);
  };
}

/**
 * Activates the app's single browser routing scope. Drafts and submissions
 * outside it are unreachable, and retired async work cannot write them back.
 */
export function activateTerminalComposerDraftScope(
  connectionId: string,
  connectionGeneration: number,
): void {
  activeDraftScopePrefix = terminalComposerDraftScopePrefix(
    connectionId,
    connectionGeneration,
  );
  for (const key of drafts.keys()) {
    if (!terminalComposerDraftKeyIsActive(key)) clearTerminalComposerDraft(key);
  }
  for (const key of selections.keys()) {
    if (!terminalComposerDraftKeyIsActive(key)) selections.delete(key);
  }
  for (const key of pendingSubmissions) {
    if (!terminalComposerDraftKeyIsActive(key)) {
      finishTerminalComposerSubmission(key);
    }
  }
  for (const key of pendingUploads.keys()) {
    if (!terminalComposerDraftKeyIsActive(key)) {
      clearTerminalComposerUploads(key);
    }
  }
  for (const key of imagesByDraft.keys()) {
    if (!terminalComposerDraftKeyIsActive(key)) setComposerImages(key, []);
  }
}

/** Inserts into the latest shared draft so async completions cannot overwrite it. */
export function insertIntoTerminalComposerDraft(
  key: string,
  insertion: string,
  selectionStart?: number,
  selectionEnd?: number,
): { text: string; caret: number } {
  const current = readTerminalComposerDraft(key);
  if (!terminalComposerDraftKeyIsActive(key)) {
    return { text: current, caret: current.length };
  }
  const storedSelection = readTerminalComposerSelection(key);
  const start = selectionStart ?? storedSelection?.start ?? current.length;
  const end = selectionEnd ?? storedSelection?.end ?? start;
  const next = terminalComposerInsertAtCaret(current, start, end, insertion);
  // Publish the selection before the draft notification so a remounted
  // subscriber restores this caret when it renders the inserted path.
  selections.set(key, { start: next.caret, end: next.caret });
  writeTerminalComposerDraft(key, next.text);
  return next;
}

/**
 * Replaces a range of the latest shared draft verbatim, without the path
 * spacing rules, and leaves the caret after the replacement. Returns null when
 * the draft belongs to an inactive scope.
 */
export function replaceTerminalComposerDraftRange(
  key: string,
  start: number,
  end: number,
  replacement: string,
): { text: string; caret: number } | null {
  if (!terminalComposerDraftKeyIsActive(key)) return null;
  const current = readTerminalComposerDraft(key);
  const text = `${current.slice(0, start)}${replacement}${current.slice(end)}`;
  const caret = start + replacement.length;
  selections.set(key, { start: caret, end: caret });
  writeTerminalComposerDraft(key, text);
  return { text, caret };
}

/**
 * Sends a pane draft at most once. The submitted text leaves the draft before
 * the request, so a remount cannot show it for a second send, and it returns
 * ahead of anything typed meanwhile if the request fails. Resolves to false
 * when nothing was sent (empty, a send or upload in flight, a retired pane)
 * and rethrows the send error after restoring the draft.
 */
export async function submitTerminalComposerDraft(
  key: string,
  draft: string,
  send: (text: string) => Promise<void>,
): Promise<boolean> {
  if (
    !draft ||
    terminalComposerUploadCount(key) > 0 ||
    !beginTerminalComposerSubmission(key)
  )
    return false;
  const current = readTerminalComposerDraft(key);
  const rest = current.startsWith(draft)
    ? current.slice(draft.length)
    : current;
  const sentImages = readComposerImages(key);
  writeTerminalComposerDraft(key, rest);
  try {
    await send(expandComposerImageTokens(draft, sentImages));
    setComposerImages(
      key,
      readComposerImages(key).filter((image) =>
        composerImageInDraft(image, readTerminalComposerDraft(key)),
      ),
    );
    return true;
  } catch (error) {
    writeTerminalComposerDraft(
      key,
      `${draft}${readTerminalComposerDraft(key)}`,
    );
    if (terminalComposerDraftKeyIsActive(key)) {
      const currentImages = readComposerImages(key);
      setComposerImages(key, [
        ...sentImages.filter(
          (image) => !currentImages.some((current) => current.id === image.id),
        ),
        ...currentImages,
      ]);
    }
    throw error;
  } finally {
    finishTerminalComposerSubmission(key);
  }
}

/** Image files among clipboard or drop items (unnamed types count). */
export function terminalComposerImageFiles(
  files: readonly (File | null)[],
): File[] {
  return files.filter(
    (file): file is File =>
      file !== null && (file.type === "" || file.type.startsWith("image/")),
  );
}

/** Image files on a paste event's clipboard; empty for text pastes. */
export function clipboardImageFiles(data: DataTransfer | null): File[] {
  return terminalComposerImageFiles(
    Array.from(data?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile()),
  );
}

/**
 * Uploads images one by one and inserts each path into the draft as it
 * lands. The count is tracked on the draft key, so a remounted editor still
 * shows the upload and send waits for it.
 */
export async function uploadTerminalComposerImages(
  key: string,
  files: readonly File[],
  upload: (file: File) => Promise<string>,
  insertPath: (key: string, path: string, image: ComposerImage) => void,
): Promise<void> {
  const images = terminalComposerImageFiles(files);
  if (images.length === 0 || !beginTerminalComposerUpload(key)) return;
  let ref = Math.max(0, ...readComposerImages(key).map((image) => image.ref));
  const pending = images.map(
    (file): ComposerImage => ({
      id: crypto.randomUUID(),
      file,
      path: null,
      ref: ++ref,
    }),
  );
  setComposerImages(key, [...readComposerImages(key), ...pending]);
  try {
    for (const image of pending) {
      if (!readComposerImages(key).some((item) => item.id === image.id))
        continue;
      const path = await upload(image.file);
      if (
        !terminalComposerDraftKeyIsActive(key) ||
        !readComposerImages(key).some((item) => item.id === image.id)
      )
        continue;
      setComposerImages(
        key,
        readComposerImages(key).map((item) =>
          item.id === image.id ? { ...item, path } : item,
        ),
      );
      insertPath(key, path, { ...image, path });
    }
  } finally {
    setComposerImages(
      key,
      readComposerImages(key).filter(
        (item) =>
          item.path !== null || !pending.some((image) => image.id === item.id),
      ),
    );
    finishTerminalComposerUpload(key);
  }
}

/** Test hook: number of retained drafts. */
export function terminalComposerDraftCount(): number {
  return drafts.size;
}

/**
 * Returns the subset of paneIds that currently hold a non-empty draft. Close
 * flows use this to warn before the draft becomes unreachable.
 */
export function terminalComposerDraftPaneIds(
  connectionId: string,
  connectionGeneration: number,
  paneIds: readonly string[],
): string[] {
  return paneIds.filter(
    (paneId) =>
      readTerminalComposerDraft(
        terminalComposerDraftKey(connectionId, connectionGeneration, paneId),
      ) !== "",
  );
}

/** Discards drafts and retires async work for panes confirmed closing. */
export function clearTerminalComposerDrafts(
  connectionId: string,
  connectionGeneration: number,
  paneIds: readonly string[],
): void {
  for (const paneId of paneIds) {
    const key = terminalComposerDraftKey(
      connectionId,
      connectionGeneration,
      paneId,
    );
    retiredDraftKeys.add(key);
    clearTerminalComposerDraft(key);
    finishTerminalComposerSubmission(key);
    clearTerminalComposerUploads(key);
  }
}

/**
 * Sentence appended to a close-confirmation message when the close would
 * discard composer drafts. Returns "" when there is nothing to warn about.
 */
export function terminalComposerCloseWarning(draftCount: number): string {
  if (draftCount <= 0) return "";
  return draftCount === 1
    ? ` ${t("The unsent composer draft will be discarded.")}`
    : ` ${t("{count} unsent composer drafts will be discarded.", { count: draftCount })}`;
}

/**
 * Builds the mode-aware pane input request for a composer submission. The
 * server wraps the text in bracketed-paste markers only when the PTY has
 * bracketed paste enabled, and encodes the Enter key for the active terminal
 * mode. `submit: false` inserts the draft without executing it.
 */
export function terminalComposerRequest(
  paneId: string,
  text: string,
  submit: boolean,
) {
  return {
    method: "pane.send_input" as const,
    params: {
      pane_id: paneId,
      text: prepareTerminalPasteText(text),
      keys: submit ? ["enter"] : ([] as string[]),
    },
  };
}

/**
 * A single line as typed characters: control characters (Tab, Escape, and
 * the like) would act as keys, so Tab becomes a space and the rest are
 * dropped.
 */
export function terminalComposerTypedText(text: string): string {
  return Array.from(text, (char) => {
    if (char === "\t") return " ";
    const code = char.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "" : char;
  }).join("");
}

export type TerminalComposerSend =
  /** Multi-line: one paste, so the agent cannot submit at the first break. */
  | {
      kind: "paste";
      request: ReturnType<typeof terminalComposerRequest>;
    }
  /** One line: typed like keystrokes, then Enter pressed on its own. */
  | { kind: "type"; text: string; enter: boolean };

/**
 * How a draft reaches the pane. Agents treat a bracketed paste as pasted
 * content (Claude Code quotes it back as "[Pasted text]"), so a single line
 * is sent as ordinary typing and only multi-line drafts use the paste path.
 */
export function terminalComposerSend(
  paneId: string,
  text: string,
  submit: boolean,
): TerminalComposerSend {
  if (/[\r\n\u2028\u2029]/.test(text))
    return {
      kind: "paste",
      request: terminalComposerRequest(paneId, text, submit),
    };
  return { kind: "type", text: terminalComposerTypedText(text), enter: submit };
}

/**
 * Inserts an uploaded image path at the composer caret, replacing the current
 * selection. A single space is added before the path when it would otherwise
 * touch non-whitespace text, and always after it unless whitespace follows,
 * so the path stays a separate shell word and continued typing cannot merge
 * into it. Returns the next draft text and the caret position after it.
 */
export function terminalComposerInsertAtCaret(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  insertion: string,
): { text: string; caret: number } {
  const before = text.slice(0, selectionStart);
  const after = text.slice(selectionEnd);
  const needsLeadingSpace = before !== "" && !/\s$/.test(before);
  const needsTrailingSpace = !/^\s/.test(after);
  const inserted = `${needsLeadingSpace ? " " : ""}${insertion}${
    needsTrailingSpace ? " " : ""
  }`;
  return {
    text: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}
