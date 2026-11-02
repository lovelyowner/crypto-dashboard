/** No raw encryption key is generated or persisted by this implementation. */
export type StoredCipher = {
  ciphertext: string;
  iv: string;
  salt: string;
  iterations: number;
  /** raw is recognized only to reject legacy device-key copies safely. */
  kdf: "raw" | "pbkdf2";
};
export const PASSPHRASE_ITERATIONS = 600_000;
const MAX_TEXT = 4096;

export function assertPassphrase(passphrase: string): void {
  if (passphrase.length < 12 || passphrase.length > 1024)
    throw new Error(
      "Use a wallet passphrase of 12–1024 characters. Symbols and spaces are welcome.",
    );
}

export async function sealWithPassphrase(plain: string, passphrase: string): Promise<StoredCipher> {
  assertPassphrase(passphrase);
  if (typeof plain !== "string" || !plain || utf8(plain).length > MAX_TEXT)
    throw new Error("Recovery data is too large.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derivePassphraseKey(passphrase, salt, PASSPHRASE_ITERATIONS);
  const plaintext = utf8(plain);
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toBuf(iv) },
      key,
      toBuf(plaintext),
    );
    return {
      ciphertext: b64(new Uint8Array(ciphertext)),
      iv: b64(iv),
      salt: b64(salt),
      iterations: PASSPHRASE_ITERATIONS,
      kdf: "pbkdf2",
    };
  } finally {
    plaintext.fill(0);
  }
}

/** Validate before invoking PBKDF2; imported work factors and sizes are bounded. */
export function validateCipher(value: unknown): StoredCipher {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid encrypted recovery data.");
  const row = value as Record<string, unknown>;
  if (row.kdf !== "pbkdf2")
    throw new Error(
      "Legacy device-key copies are unsupported. Recover with your original words and create a passphrase-protected wallet.",
    );
  if (
    typeof row.iterations !== "number" ||
    !Number.isInteger(row.iterations) ||
    row.iterations < 120_000 ||
    row.iterations > 1_000_000
  )
    throw new Error("Unsupported encryption work factor.");
  const iv = decodeField(row.iv, 12, 12);
  const salt = decodeField(row.salt, 16, 32);
  const ciphertext = decodeField(row.ciphertext, 17, MAX_TEXT + 16);
  return {
    kdf: "pbkdf2",
    iterations: row.iterations,
    iv: b64(iv),
    salt: b64(salt),
    ciphertext: b64(ciphertext),
  };
}

export async function openSecret(bundle: StoredCipher, passphrase = ""): Promise<string> {
  const valid = validateCipher(bundle);
  if (passphrase.length > 1024) throw new Error("Passphrase is too long.");
  const key = await derivePassphraseKey(passphrase, unb64(valid.salt), valid.iterations);
  try {
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: toBuf(unb64(valid.iv)) },
        key,
        toBuf(unb64(valid.ciphertext)),
      ),
    );
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(plain);
    } finally {
      plain.fill(0);
    }
  } catch {
    throw new Error("Wrong wallet passphrase or damaged backup.");
  }
}

async function derivePassphraseKey(passphrase: string, salt: Uint8Array, iterations: number) {
  const password = utf8(passphrase);
  try {
    const base = await crypto.subtle.importKey("raw", toBuf(password), "PBKDF2", false, [
      "deriveKey",
    ]);
    return await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: toBuf(salt), iterations, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    password.fill(0);
  }
}
function decodeField(value: unknown, min: number, max: number): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(max / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error("Malformed encrypted recovery data.");
  const bytes = unb64(value);
  if (bytes.length < min || bytes.length > max || b64(bytes) !== value)
    throw new Error("Invalid encrypted recovery data length.");
  return bytes;
}
function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
function toBuf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function unb64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
