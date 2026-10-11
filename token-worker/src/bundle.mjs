/**
 * Seals the stored Codex login with AES-GCM under the BUNDLE_KEY secret.
 *
 * Worker secrets can't be read back, so a copy of the KV value
 * reveals nothing without the key. Runs in Workers and Node.
 */

const ENCRYPTION = { name: "AES-GCM", length: 256 };

export function generateBundleKey() {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sealBundle(bundle, bundleKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle));
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

export async function openBundle(sealed, bundleKey) {
  const { version, iv, data } = JSON.parse(sealed);

  if (version !== 1) {
    throw new Error(
      `The stored bundle has version ${version}, and this worker reads version 1.`,
    );
  }

  const plaintext = await crypto.subtle.decrypt(
    { ...ENCRYPTION, iv: base64ToBytes(iv) },
    await importBundleKey(bundleKey),
    base64ToBytes(data),
  );

  return JSON.parse(new TextDecoder().decode(plaintext));
}

/**
 * Reads the `exp` claim of a JWT without verifying it, in milliseconds.
 */
export function accessTokenExpiry(accessToken) {
  const payload =
    typeof accessToken === "string" ? accessToken.split(".")[1] : undefined;

  if (!payload) {
    return null;
  }

  try {
    const { exp } = JSON.parse(
      new TextDecoder().decode(
        base64ToBytes(payload.replace(/-/g, "+").replace(/_/g, "/")),
      ),
    );

    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

async function importBundleKey(bundleKey) {
  const rawKey = bundleKey ? base64ToBytes(bundleKey) : new Uint8Array();

  if (rawKey.length !== 32) {
    throw new Error("BUNDLE_KEY must be 32 random bytes encoded as base64.");
  }

  return crypto.subtle.importKey("raw", rawKey, ENCRYPTION, false, [
    "encrypt",
    "decrypt",
  ]);
}

function bytesToBase64(bytes) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function base64ToBytes(base64) {
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );

  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
