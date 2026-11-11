import {
  type ComposerImage,
  composerImageInDraft,
  composerImageToken,
  composerImageUrl,
  insertIntoTerminalComposerDraft,
  readComposerImages,
  resolveComposerImages,
  uploadTerminalComposerImages,
} from "../../terminalComposer";
import type { PromptImages } from "./livePreview";
import type { PromptEditorSelection } from "./surface";

// The images of a composer-store draft, as the prompt editors use them.

/**
 * Uploads images into a draft. Each one, once uploaded, becomes an
 * `[Image #N]` placeholder at the selection the draft's editor has then
 * (`selection`; an editor of another draft says nothing), as in Claude Code.
 */
export function attachDraftImages(
  draftKey: string,
  files: readonly File[],
  upload: (file: File) => Promise<string>,
  selection: () => PromptEditorSelection | null | undefined,
  paneHistory = true,
): Promise<void> {
  return uploadTerminalComposerImages(
    draftKey,
    files,
    upload,
    (key, _path, image) => {
      const range = key === draftKey ? selection() : null;
      insertIntoTerminalComposerDraft(
        key,
        composerImageToken(image.ref),
        range?.start,
        range?.end,
      );
    },
    paneHistory,
  );
}

/**
 * Where a draft's images load from: pasted ones from their files, and what
 * the text names by path through `imageUrl`.
 */
export function draftPromptImages(
  draftKey: string,
  imageUrl?: (source: string) => string | null,
  atoms = false,
): PromptImages {
  return {
    url: (source) => {
      const pasted = readComposerImages(draftKey).find(
        (image) => image.path === source,
      );
      return pasted ? composerImageUrl(pasted) : (imageUrl?.(source) ?? null);
    },
    pasted: (ref, doc) => {
      const pasted = resolveComposerImages(draftKey, doc).get(ref);
      if (pasted?.file) return composerImageUrl({ file: pasted.file });
      return pasted?.path ? (imageUrl?.(pasted.path) ?? null) : null;
    },
    atoms,
  };
}

/**
 * The images for the thumbnail strip. The rich surface shows pasted images
 * in the text, so the strip keeps the ones still uploading; under the plain
 * textarea it shows every image the draft still names.
 */
export function draftImageStrip(
  images: readonly ComposerImage[],
  rich: boolean,
  text: string,
): ComposerImage[] {
  return images.filter((image) =>
    rich ? image.path === null : composerImageInDraft(image, text),
  );
}
