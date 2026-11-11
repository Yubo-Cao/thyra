import type { AgentPromptImage } from "../../../shared/agentSession";
import { COMPOSER_IMAGE_TOKEN, composerImageToken } from "../terminalComposer";

/** An image attached to a draft: `ref` numbers it there, `path` once uploaded. */
export type DraftImage = { ref: number; path: string | null };

/**
 * A draft as `agent_session.send` takes it: the attached images whose
 * placeholder is still in the text, in the order they first appear, and the
 * text with those placeholders numbered to match (`[Image #1]` names the
 * first). A placeholder without an uploaded image stays as written.
 */
export function promptForSend(
  draft: string,
  attached: readonly DraftImage[],
): { text: string; images: AgentPromptImage[] } {
  const images: AgentPromptImage[] = [];
  const numbers = new Map<number, number>();
  const text = draft.replace(COMPOSER_IMAGE_TOKEN, (token, ref: string) => {
    const image = attached.find((item) => item.ref === Number(ref));
    if (!image?.path) return token;
    let number = numbers.get(image.ref);
    if (number === undefined) {
      images.push({ path: image.path });
      number = images.length;
      numbers.set(image.ref, number);
    }
    return composerImageToken(number);
  });
  return { text, images };
}

/** `[Image #N]` as a user item's text names its Nth image. */
const ITEM_IMAGE_TOKEN = /\[Image #(\d+)\]/g;

/**
 * A run of a user item's text cut at the placeholders of its `count`
 * images: text, and the index (from 0) of the image each placeholder names.
 * A number without an image stays text.
 */
export function splitPromptImages(
  text: string,
  count: number,
): (string | number)[] {
  const parts: (string | number)[] = [];
  let at = 0;
  for (const match of text.matchAll(ITEM_IMAGE_TOKEN)) {
    const index = Number(match[1]) - 1;
    if (index < 0 || index >= count) continue;
    if (match.index > at) parts.push(text.slice(at, match.index));
    parts.push(index);
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/**
 * The images (by index) no placeholder in the text shows: none names them,
 * or only one written as code, which stays as written.
 */
export function unplacedPromptImages(text: string, count: number): number[] {
  const prose = text.replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)|`[^`\n]*`/g, "");
  const placed = new Set(
    splitPromptImages(prose, count).filter((part) => typeof part === "number"),
  );
  return Array.from({ length: count }, (_, index) => index).filter(
    (index) => !placed.has(index),
  );
}
