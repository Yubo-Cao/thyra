import { AGENT_PROMPT_IMAGE_MAX_BYTES } from "../../../shared/agentSession";
import { t } from "../i18n";

/** The formats a prompt takes as they are. */
const ACCEPTED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
/** The long edge of a redrawn image, in pixels. */
const LONG_EDGE = 2000;
/** Each further try is this much smaller, down to SMALLEST_EDGE. */
const SHRINK = 0.75;
const SMALLEST_EDGE = 320;
const JPEG_QUALITY = 0.85;

/** Whether a file uploads as it is; any other is redrawn first. */
export function promptImageFits(file: { type: string; size: number }) {
  return (
    ACCEPTED_TYPES.has(file.type) && file.size <= AGENT_PROMPT_IMAGE_MAX_BYTES
  );
}

/** A size scaled down, never up, so that its long edge is at most `edge`. */
export function fitPromptImage(width: number, height: number, edge: number) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The long edges to redraw an image at, in turn, until it is small enough. */
export function promptImageEdges(longEdge: number): number[] {
  const edges: number[] = [];
  for (
    let edge = Math.min(longEdge, LONG_EDGE);
    edge >= SMALLEST_EDGE || edges.length === 0;
    edge = Math.round(edge * SHRINK)
  )
    edges.push(edge);
  return edges;
}

/** A redrawn image's file name: the original's, with the new format's ending. */
export function redrawnImageName(name: string, type: string) {
  const ending = type === "image/png" ? "png" : "jpg";
  return `${name.replace(/\.[^./\\]*$/, "") || "image"}.${ending}`;
}

async function decode(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    // Reported below: a format this browser has no decoder for.
  } finally {
    URL.revokeObjectURL(url);
  }
  if (!image.naturalWidth || !image.naturalHeight)
    throw new Error(
      t("This browser cannot read the image {name}.", { name: file.name }),
    );
  return image;
}

function hasTransparency(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const { data } = context.getImageData(0, 0, width, height);
  for (let index = 3; index < data.length; index += 4)
    if (data[index] < 255) return true;
  return false;
}

/**
 * The file to upload for an image attached to a prompt. One within the size
 * limit in an accepted format goes as it is. Any other is redrawn here: long
 * edge at most 2000 pixels, JPEG unless it has transparency, and smaller
 * again while the result is still over the limit. Throws for an image this
 * browser cannot decode.
 */
export async function preparePromptImage(file: File): Promise<File> {
  if (promptImageFits(file)) return file;
  const image = await decode(file);
  let transparent = file.type === "image/jpeg" ? false : null;
  for (const edge of promptImageEdges(
    Math.max(image.naturalWidth, image.naturalHeight),
  )) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) break;
    Object.assign(
      canvas,
      fitPromptImage(image.naturalWidth, image.naturalHeight, edge),
    );
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    transparent ??= hasTransparency(context, canvas.width, canvas.height);
    const type = transparent ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, type, JPEG_QUALITY),
    );
    if (blob && blob.size <= AGENT_PROMPT_IMAGE_MAX_BYTES)
      return new File([blob], redrawnImageName(file.name, type), { type });
  }
  throw new Error(
    t("The image {name} is too large to attach.", { name: file.name }),
  );
}
