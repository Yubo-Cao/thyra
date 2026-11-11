import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { richEditorLoadPolicy } from "../../idlePrefetch";
import { lazyPanel } from "../../lazyWithReload";
import { useStartupSettled } from "../../startupGate";
import {
  clipboardImageFiles,
  readTerminalComposerDraft,
  readTerminalComposerSelection,
  writeTerminalComposerDraft,
  writeTerminalComposerSelection,
} from "../../terminalComposer";
import { useTerminalComposerDraft } from "../../useTerminalComposerDraft";
import { useComposerImages } from "../ComposerImages";
import { LazyBoundary } from "../LazyBoundary";
import {
  attachDraftImages,
  draftImageStrip,
  draftPromptImages,
} from "./draftImages";
import { PromptTextarea } from "./PromptTextarea";
import type { PromptEditorSurface, PromptEditorSurfaceProps } from "./surface";
import "./PromptEditor.css";

// What the terminal's prompt editor and the agent view's prompt box share: a
// draft in the composer store edited through the plain surface, then the
// rich one, with pasted images as `[Image #N]` placeholders.

const promptRichPanel = lazyPanel("prompt-editor-rich", () =>
  import("./PromptCodeMirror").then((module) => module.PromptCodeMirror),
);
const PromptCodeMirror = promptRichPanel.Component;

/**
 * Loads the live-preview editor: at idle after startup on a fast 4G link,
 * otherwise once the editor is first used (`used`), and never under Data
 * Saver or on 2G.
 */
function useRichSurface(used: boolean) {
  const settled = useStartupSettled();
  const [ready, setReady] = useState(() => promptRichPanel.isLoaded());
  useEffect(() => {
    if (!settled || ready) return;
    const policy = richEditorLoadPolicy();
    if (policy === "never" || (policy === "on-demand" && !used)) return;
    let cancelled = false;
    const load = () =>
      void promptRichPanel.preload().then(() => {
        if (!cancelled && promptRichPanel.isLoaded()) setReady(true);
      });
    if (policy === "on-demand") {
      load();
      return () => {
        cancelled = true;
      };
    }
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(load, { timeout: 3000 })
      : window.setTimeout(load, 250);
    return () => {
      cancelled = true;
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
  }, [ready, settled, used]);
  return ready;
}

/**
 * A composer-store draft bound to a prompt surface. The caller renders
 * `PromptSurface` with `surface` plus its own keys, font and labels, and the
 * thumbnail strip with `strip`.
 */
export function usePromptDraft({
  draftKey,
  imageUrl,
  paneHistory = true,
  imageAtoms = false,
  onUploadImage,
  onError,
}: {
  draftKey: string;
  /** Where local Markdown images and image paths in the draft load from. */
  imageUrl?: (source: string) => string | null;
  /** See uploadTerminalComposerImages. */
  paneHistory?: boolean;
  /** See PromptImages.atoms. */
  imageAtoms?: boolean;
  onUploadImage: (file: File) => Promise<string>;
  /** An image upload failed. */
  onError: (message: string) => void;
}) {
  const { text, submissionPending, uploadCount } =
    useTerminalComposerDraft(draftKey);
  const images = useComposerImages(draftKey);
  const surfaceRef = useRef<PromptEditorSurface | null>(null);
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);

  // Outside changes to the draft (a send clearing it, a failed send or an
  // upload restoring text) reach the surface; local typing is already there.
  useEffect(() => {
    surfaceRef.current?.setText(
      text,
      readTerminalComposerSelection(draftKey)?.end,
    );
  }, [draftKey, text]);

  // Swap the textarea for the rich editor when it arrives, never
  // mid-composition.
  const [used, setUsed] = useState(false);
  const richReady = useRichSurface(used);
  const [rich, setRich] = useState(richReady);
  const focusRich = useRef(false);
  useEffect(() => {
    if (!richReady || rich || composing) return;
    focusRich.current = !!surfaceRef.current?.hasFocus();
    setRich(true);
  }, [composing, rich, richReady]);

  /** Uploads images into the draft; false when there are none to take. */
  const attach = (files: readonly File[]) => {
    if (files.length === 0) return false;
    void attachDraftImages(
      draftKey,
      files,
      onUploadImage,
      () => surfaceRef.current?.selection(),
      paneHistory,
    ).catch((error) =>
      onError(
        error instanceof Error ? error.message : t("Image upload failed"),
      ),
    );
    return true;
  };

  return {
    text,
    submissionPending,
    uploadCount,
    surfaceRef,
    /** An IME composition is open in the surface. */
    composingRef,
    /** The rich surface is the one mounted. */
    rich,
    /** The images for the thumbnail strip (draftImageStrip). */
    strip: draftImageStrip(images, rich, text),
    attach,
    surface: {
      surfaceRef,
      initialText: readTerminalComposerDraft(draftKey),
      initialSelection: readTerminalComposerSelection(draftKey),
      focus: focusRich.current,
      onChange: (next, start, end) => {
        writeTerminalComposerDraft(draftKey, next);
        writeTerminalComposerSelection(draftKey, start, end);
      },
      onPasteFiles: (data) => attach(clipboardImageFiles(data)),
      images: draftPromptImages(draftKey, imageUrl, imageAtoms),
      onUse: () => setUsed(true),
      onCompositionChange: (active) => {
        composingRef.current = active;
        setComposing(active);
      },
    } satisfies Partial<PromptEditorSurfaceProps>,
  };
}

/** The plain surface, or the rich one once `rich` (see usePromptDraft). */
export function PromptSurface({
  rich,
  ...props
}: PromptEditorSurfaceProps & { rich: boolean }) {
  return rich ? (
    <LazyBoundary>
      <PromptCodeMirror {...props} />
    </LazyBoundary>
  ) : (
    <PromptTextarea {...props} />
  );
}
