import { timingSafeEqual } from "node:crypto";

/** Constant-time comparison of two hex digests; false for a missing one. */
export function sameDigest(a: string | null, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
