import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Profile pictures. The browser crops and scales the picture to 256x256 and
 * encodes WebP (JPEG where the browser cannot encode WebP, as in Safari);
 * the server only checks the format, the size and the dimensions, and keeps
 * the bytes under their SHA-256, so the URL changes with the content and can
 * be cached forever.
 */

export const AVATAR_MAX_BYTES = 128 * 1024;
export const AVATAR_MAX_SIZE = 256;
export const AVATAR_FILE_PATTERN = /^[0-9a-f]{64}\.(?:webp|jpg)$/;

export type AvatarImage = {
  type: "image/webp" | "image/jpeg";
  width: number;
  height: number;
};

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 30 || tag(0) !== "RIFF" || tag(8) !== "WEBP") return null;
  if (view.getUint32(4, true) + 8 > bytes.length) return null;
  const chunk = tag(12);
  if (chunk === "VP8 ") {
    // Keyframe start code, then 14-bit width and height.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
      return null;
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    const read24 = (offset: number) =>
      bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
    return { width: read24(24) + 1, height: read24(27) + 1 };
  }
  return null;
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    // Start of frame (baseline, extended, progressive, lossless).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
      };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/** The picture's format and size, or an error for anything else. */
export function inspectAvatar(
  bytes: Uint8Array,
): { ok: true; image: AvatarImage } | { ok: false; error: string } {
  if (bytes.length === 0) return { ok: false, error: "empty image" };
  if (bytes.length > AVATAR_MAX_BYTES)
    return { ok: false, error: "image too large (128 KiB at most)" };
  const webp = webpSize(bytes);
  const jpeg = webp ? null : jpegSize(bytes);
  const size = webp ?? jpeg;
  if (!size) return { ok: false, error: "expected a WebP or JPEG image" };
  if (
    size.width < 1 ||
    size.height < 1 ||
    size.width > AVATAR_MAX_SIZE ||
    size.height > AVATAR_MAX_SIZE
  )
    return { ok: false, error: "images must be at most 256x256 pixels" };
  return {
    ok: true,
    image: { type: webp ? "image/webp" : "image/jpeg", ...size },
  };
}

export type AvatarFiles = ReturnType<typeof createAvatarFiles>;

/** Avatar files in `<data>/avatars`, named by content hash. */
export function createAvatarFiles(dir: string) {
  return {
    dir,
    save(bytes: Uint8Array, image: AvatarImage): string {
      const name = `${createHash("sha256").update(bytes).digest("hex")}.${image.type === "image/webp" ? "webp" : "jpg"}`;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, name);
      if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600 });
      return name;
    },
    read(name: string): Uint8Array<ArrayBuffer> | null {
      if (!AVATAR_FILE_PATTERN.test(name)) return null;
      try {
        return new Uint8Array(readFileSync(join(dir, name)));
      } catch {
        return null;
      }
    },
    remove(name: string) {
      if (AVATAR_FILE_PATTERN.test(name))
        rmSync(join(dir, name), { force: true });
    },
  };
}

/** The URL of an account's avatar, or undefined. */
export function avatarUrl(
  avatar: string | null | undefined,
): string | undefined {
  return avatar && AVATAR_FILE_PATTERN.test(avatar)
    ? `/avatars/${avatar}`
    : undefined;
}
