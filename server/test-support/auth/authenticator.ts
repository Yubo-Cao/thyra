import { createHash, randomBytes, webcrypto } from "node:crypto";

/**
 * A software passkey authenticator for tests: ES256 keys, "none"
 * attestation, discoverable credentials. It produces the JSON a browser's
 * `PublicKeyCredential.toJSON()` would send.
 */

type CborValue =
  | number
  | string
  | Uint8Array
  | Map<CborValue, CborValue>
  | { [key: string]: CborValue };

function cborHead(major: number, value: number): number[] {
  if (value < 24) return [(major << 5) | value];
  if (value < 0x100) return [(major << 5) | 24, value];
  if (value < 0x10000) return [(major << 5) | 25, value >> 8, value & 0xff];
  return [
    (major << 5) | 26,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

export function cbor(value: CborValue): Uint8Array {
  const out: number[] = [];
  const write = (item: CborValue) => {
    if (typeof item === "number") {
      if (item >= 0) out.push(...cborHead(0, item));
      else out.push(...cborHead(1, -1 - item));
    } else if (typeof item === "string") {
      const bytes = new TextEncoder().encode(item);
      out.push(...cborHead(3, bytes.length), ...bytes);
    } else if (item instanceof Uint8Array) {
      out.push(...cborHead(2, item.length), ...item);
    } else {
      const entries =
        item instanceof Map ? [...item.entries()] : Object.entries(item);
      out.push(...cborHead(5, entries.length));
      for (const [key, entry] of entries) {
        write(key);
        write(entry);
      }
    }
  };
  write(value);
  return Uint8Array.from(out);
}

const b64 = (bytes: Uint8Array | Buffer) =>
  Buffer.from(bytes).toString("base64url");
const sha256 = (bytes: Uint8Array | string) =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

/** Raw r||s ECDSA signature to ASN.1 DER. */
function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    let value = bytes.slice(start);
    if (value[0]! & 0x80) value = Uint8Array.from([0, ...value]);
    return [0x02, value.length, ...value];
  };
  const body = [...integer(raw.slice(0, 32)), ...integer(raw.slice(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

export type SoftwarePasskey = Awaited<
  ReturnType<typeof createSoftwareAuthenticator>
>;

export async function createSoftwareAuthenticator() {
  const keys = (await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
  const credentialId = new Uint8Array(randomBytes(16));
  let counter = 0;
  let userHandle = "";

  async function sign(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const raw = new Uint8Array(
      await webcrypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keys.privateKey,
        data,
      ),
    );
    return derSignature(raw);
  }

  function counterBytes(): number[] {
    counter += 1;
    return [
      (counter >>> 24) & 0xff,
      (counter >>> 16) & 0xff,
      (counter >>> 8) & 0xff,
      counter & 0xff,
    ];
  }

  return {
    credentialId: b64(credentialId),

    /** Answer `navigator.credentials.create` options for `origin`. */
    create(options: any, origin: string) {
      userHandle = options.user.id;
      const clientData = new TextEncoder().encode(
        JSON.stringify({
          type: "webauthn.create",
          challenge: options.challenge,
          origin,
          crossOrigin: false,
        }),
      );
      const publicKey = cbor(
        new Map<CborValue, CborValue>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
          [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
        ]),
      );
      const authData = Uint8Array.from([
        ...sha256(options.rp.id),
        0x45, // user present, user verified, attested credential data
        ...counterBytes(),
        ...new Uint8Array(16), // AAGUID
        credentialId.length >> 8,
        credentialId.length & 0xff,
        ...credentialId,
        ...publicKey,
      ]);
      const attestationObject = cbor({
        fmt: "none",
        attStmt: {},
        authData,
      });
      return {
        id: b64(credentialId),
        rawId: b64(credentialId),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64(clientData),
          attestationObject: b64(attestationObject),
          transports: ["internal"],
        },
      };
    },

    /** Answer `navigator.credentials.get` options for `origin`. */
    async get(options: any, origin: string, rpId: string) {
      const clientData = new TextEncoder().encode(
        JSON.stringify({
          type: "webauthn.get",
          challenge: options.challenge,
          origin,
          crossOrigin: false,
        }),
      );
      const authData = Uint8Array.from([
        ...sha256(rpId),
        0x05, // user present, user verified
        ...counterBytes(),
      ]);
      const signature = await sign(
        Uint8Array.from([...authData, ...sha256(clientData)]),
      );
      return {
        id: b64(credentialId),
        rawId: b64(credentialId),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64(clientData),
          authenticatorData: b64(authData),
          signature: b64(signature),
          userHandle,
        },
      };
    },
  };
}
