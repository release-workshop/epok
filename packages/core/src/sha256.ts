/**
 * Portable SHA-256 hex digest via Web Crypto (Node 18+, Workers, WinterCG).
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return bufferToHex(new Uint8Array(digest));
}

export async function sha256HexUtf8(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

/** Precomputed SHA-256 of an empty byte sequence. */
export const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function bufferToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
