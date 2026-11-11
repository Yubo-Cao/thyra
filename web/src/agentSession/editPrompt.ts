import type { AgentItem } from "../../../shared/agentSession";
import { replaceComposerDraft } from "../terminalComposer";

export type UserItem = Extract<AgentItem, { type: "user" }>;

/** What the session's state allows the prompt actions to do now. */
export function promptActionBlock(
  info: { status: string; can_rewind?: boolean },
  canEdit: boolean,
): "unsupported" | "busy" | null {
  if (!canEdit || info.can_rewind !== true || info.status === "exited")
    return "unsupported";
  return info.status === "idle" ? null : "busy";
}

/**
 * The images of a sent prompt as files again, fetched back from the host
 * for the draft's thumbnails. An image that does not load still goes with
 * the prompt: it is sent by its path, which the host still has.
 */
export async function promptImageFiles(
  item: UserItem,
  imageUrl: ((path: string) => string | null) | undefined,
  load: (url: string) => Promise<Blob> = (url) =>
    fetch(url).then((response) => {
      if (!response.ok) throw new Error(String(response.status));
      return response.blob();
    }),
): Promise<{ file: File; path: string }[]> {
  return Promise.all(
    (item.images ?? []).map(async ({ path }) => {
      const name = path.slice(path.lastIndexOf("/") + 1) || "image";
      const url = imageUrl?.(path);
      const blob = url ? await load(url).catch(() => null) : null;
      return {
        path,
        file: new File(blob ? [blob] : [], name, { type: blob?.type ?? "" }),
      };
    }),
  );
}

/** Put a sent prompt, images and all, in a draft to be edited. */
export async function putPromptInDraft(
  draftKey: string,
  item: UserItem,
  imageUrl: ((path: string) => string | null) | undefined,
): Promise<void> {
  const images = await promptImageFiles(item, imageUrl);
  replaceComposerDraft(draftKey, item.text, images);
}
