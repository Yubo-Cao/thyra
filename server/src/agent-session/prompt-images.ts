import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import {
  AGENT_PROMPT_IMAGE_LIMIT,
  AGENT_PROMPT_IMAGE_MAX_BYTES,
  type AgentPromptImage,
} from "../../../shared/agentSession";
import { AgentActionError } from "./adapter";

/**
 * Images a prompt attaches. A page names them by the paths its uploads got;
 * the host that owns the agent checks each file itself before the agent is
 * given it, and tells what an image is from its bytes, not from its name.
 */

export type PromptImageType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

/** An attached image the host has checked. */
export type PromptImage = AgentPromptImage & { mediaType: PromptImageType };

const HEAD_BYTES = 12;
const MAX_SIZE_LABEL = `${AGENT_PROMPT_IMAGE_MAX_BYTES / (1024 * 1024)} MB`;

/** The format a file's first bytes declare; null when it is none accepted. */
export function imageTypeOf(head: Uint8Array): PromptImageType | null {
  const starts = (...bytes: number[]) =>
    bytes.every((byte, index) => head[index] === byte);
  const ascii = (from: number, text: string) =>
    [...text].every((char, index) => head[from + index] === char.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

/**
 * Open the file of a prompt's image (the `number`th, from 1) once it has
 * passed every check on the open file itself: a regular file reached
 * without following a link, owned by this user, within the size limit.
 */
async function openImage(path: string, number: number): Promise<FileHandle> {
  const refuse = (problem: string) =>
    new AgentActionError(`image ${number} ${problem}`);
  let file: FileHandle;
  try {
    // Never through a symlink, and never waiting on a pipe put in its place.
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw refuse(
      code === "ENOENT" || code === "ENOTDIR"
        ? "is no longer on the host"
        : code === "ELOOP"
          ? "is not a regular file"
          : "cannot be read on the host",
    );
  }
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw refuse("is not a regular file");
    if (process.getuid && stats.uid !== process.getuid())
      throw refuse("does not belong to the session's user");
    if (stats.size > AGENT_PROMPT_IMAGE_MAX_BYTES)
      throw refuse(`is larger than ${MAX_SIZE_LABEL}`);
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/**
 * Check the images of a prompt, in order. Any failure refuses the whole
 * prompt with an error that names the image.
 */
export async function checkPromptImages(
  images: AgentPromptImage[],
): Promise<PromptImage[]> {
  if (images.length > AGENT_PROMPT_IMAGE_LIMIT)
    throw new AgentActionError(
      `a prompt takes at most ${AGENT_PROMPT_IMAGE_LIMIT} images`,
    );
  const checked: PromptImage[] = [];
  for (const [index, { path }] of images.entries()) {
    const file = await openImage(path, index + 1);
    let mediaType: PromptImageType | null;
    try {
      const head = new Uint8Array(HEAD_BYTES);
      const { bytesRead } = await file.read(head, 0, HEAD_BYTES, 0);
      mediaType = imageTypeOf(head.subarray(0, bytesRead));
    } finally {
      await file.close();
    }
    if (!mediaType)
      throw new AgentActionError(
        `image ${index + 1} is not a PNG, JPEG, GIF or WebP file`,
      );
    checked.push({ path, mediaType });
  }
  return checked;
}

/** The bytes of a checked image (the `number`th of its prompt), checked again. */
export async function readPromptImage(
  image: PromptImage,
  number: number,
): Promise<Buffer> {
  const file = await openImage(image.path, number);
  try {
    return await file.readFile();
  } finally {
    await file.close();
  }
}
