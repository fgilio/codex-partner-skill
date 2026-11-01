/**
 * Seals the stored Codex login with AES-GCM under the BUNDLE_KEY secret.
 *
 * Worker secrets can't be read back, so a copy of the KV value
 * reveals nothing without the key. Runs in Workers and Bun.
 */

const ENCRYPTION = { name: "AES-GCM", length: 256 } as const;
const BUNDLE_KEY_FORMAT =
  "BUNDLE_KEY must be 32 random bytes encoded as base64.";

/**
 * A Codex auth.json as `codex login` writes it. Only the tokens object is
 * required. Every field passes through unchanged.
 */
export interface StoredLogin {
  tokens: Record<string, unknown>;
  [field: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStoredLogin(value: unknown): value is StoredLogin {
  return isRecord(value) && isRecord(value.tokens);
}

export function generateBundleKey(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sealBundle(
  login: StoredLogin,
  bundleKey: string | undefined,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(login));
  const ciphertext = await crypto.subtle.encrypt(
    { ...ENCRYPTION, iv },
    await importBundleKey(bundleKey),
    plaintext,
  );

  return JSON.stringify({
    version: 1,
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

export async function openBundle(
  sealed: string,
  bundleKey: string | undefined,
): Promise<StoredLogin> {
  const bundle: unknown = JSON.parse(sealed);
  const version = isRecord(bundle) ? bundle.version : undefined;

  if (version !== 1) {
    throw new Error(
      `The stored bundle has version ${String(version)}, and this worker reads version 1.`,
    );
  }

  const key = await importBundleKey(bundleKey);
  let plaintext: ArrayBuffer;

  try {
    const { iv, data } = isRecord(bundle) ? bundle : {};

    if (typeof iv !== "string" || typeof data !== "string") {
      throw new TypeError("The bundle has no iv or data.");
    }

    plaintext = await crypto.subtle.decrypt(
      { ...ENCRYPTION, iv: base64ToBytes(iv) },
      key,
      base64ToBytes(data),
    );
  } catch {
    throw new Error(
      "The sealed login does not decrypt with the current BUNDLE_KEY.",
    );
  }

  const login: unknown = JSON.parse(new TextDecoder().decode(plaintext));

  if (!isStoredLogin(login)) {
    throw new Error("The sealed login has no tokens.");
  }

  return login;
}

/**
 * Reads the `exp` claim of a JWT without verifying it.
 */
export function accessTokenExpiryMs(accessToken: unknown): number | null {
  const payload =
    typeof accessToken === "string" ? accessToken.split(".")[1] : undefined;

  if (!payload) {
    return null;
  }

  try {
    const claims: unknown = JSON.parse(
      new TextDecoder().decode(
        base64ToBytes(payload.replace(/-/g, "+").replace(/_/g, "/")),
      ),
    );
    const exp = isRecord(claims) ? claims.exp : undefined;

    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

async function importBundleKey(
  bundleKey: string | undefined,
): Promise<CryptoKey> {
  let rawKey: Uint8Array<ArrayBuffer>;

  try {
    rawKey = base64ToBytes(bundleKey ?? "");
  } catch {
    throw new Error(BUNDLE_KEY_FORMAT);
  }

  if (rawKey.length !== 32) {
    throw new Error(BUNDLE_KEY_FORMAT);
  }

  return crypto.subtle.importKey("raw", rawKey, ENCRYPTION, false, [
    "encrypt",
    "decrypt",
  ]);
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

// atob accepts base64 with or without its trailing padding.
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}
