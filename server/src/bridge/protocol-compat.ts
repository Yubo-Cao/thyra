/** The private terminal protocol of tagged Herdr 0.9.0, the only one supported. */
export const HERDR_PROTOCOL = 22;

export class HerdrCompatibilityError extends Error {}

// Private terminal protocol 22 is distinct from stable endpoint generation 1.
// Protocol 21 and future versions must never be accepted silently.
export function isSupportedHerdrProtocol(
  protocol: unknown,
): protocol is number {
  return protocol === HERDR_PROTOCOL;
}

export function assertSupportedHerdrProtocol(
  protocol: unknown,
): asserts protocol is number {
  if (isSupportedHerdrProtocol(protocol)) return;
  const actual =
    typeof protocol === "number" || typeof protocol === "string"
      ? String(protocol)
          .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
          .slice(0, 20)
      : "unknown";
  throw new HerdrCompatibilityError(
    `Herdr protocol ${actual} is not supported by this Thyra build ` +
      `(supports protocol ${HERDR_PROTOCOL}, Herdr 0.9 or newer). Use a Thyra release explicitly ` +
      "supporting this server, or a separate compatible server. Do not downgrade a live server.",
  );
}
