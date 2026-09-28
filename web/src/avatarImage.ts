/**
 * Profile pictures: crop the middle square of any picture the browser can
 * decode, scale it to 256x256 and encode WebP (JPEG where the browser cannot
 * encode WebP, as Safari), within the server's 128 KiB limit.
 */

export const AVATAR_SIZE = 256;
export const AVATAR_MAX_BYTES = 128 * 1024;

function encode(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function avatarBlob(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  context.imageSmoothingQuality = "high";
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_SIZE,
    AVATAR_SIZE,
  );
  bitmap.close();
  for (const quality of [0.86, 0.72, 0.55]) {
    let blob = await encode(canvas, "image/webp", quality);
    if (blob?.type !== "image/webp")
      blob = await encode(canvas, "image/jpeg", quality);
    if (blob && blob.size <= AVATAR_MAX_BYTES) return blob;
  }
  throw new Error("image too large");
}
