import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export interface PaymentCredentials {
  apiKey: string;
  ipnSecret: string;
}

export function validatePaymentCredentials(value: unknown): PaymentCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Enter the merchant API key and IPN secret.");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 2 ||
    !Object.hasOwn(row, "apiKey") ||
    !Object.hasOwn(row, "ipnSecret")
  )
    throw new Error("Send only the merchant API key and IPN secret.");
  if (typeof row.apiKey !== "string" || !/^[!-~]{10,256}$/.test(row.apiKey))
    throw new Error("Enter a valid merchant API key without spaces or control characters.");
  if (
    typeof row.ipnSecret !== "string" ||
    row.ipnSecret.length < 16 ||
    row.ipnSecret.length > 512 ||
    row.ipnSecret.trim() !== row.ipnSecret ||
    /[\p{Cc}\p{Cs}]/u.test(row.ipnSecret)
  )
    throw new Error(
      "Use an IPN secret of 16–512 characters without surrounding whitespace or controls.",
    );
  return { apiKey: row.apiKey, ipnSecret: row.ipnSecret };
}

function context(secret: string, userId: string, credentialId: string) {
  if (
    typeof secret !== "string" ||
    secret.length < 32 ||
    !userId ||
    !credentialId ||
    userId.length > 256 ||
    credentialId.length > 256
  )
    throw new Error("Payment credential encryption is unavailable.");
  const aad = Buffer.from(JSON.stringify(["fathom-payment-credentials-v1", userId, credentialId]));
  const key = Buffer.from(hkdfSync("sha256", secret, "fathom-payment-credentials-v1", aad, 32));
  return { key, aad };
}

/** Merchant credentials remain server-only and are bound to one creator and version. */
export function encryptPaymentCredentials(
  credentials: PaymentCredentials,
  secret: string,
  userId: string,
  credentialId: string,
): string {
  const checked = validatePaymentCredentials(credentials);
  const { key, aad } = context(secret, userId, credentialId);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(checked), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

export function decryptPaymentCredentials(
  source: string,
  secret: string,
  userId: string,
  credentialId: string,
): PaymentCredentials {
  try {
    if (typeof source !== "string" || source.length > 4096)
      throw new Error("Invalid encrypted credentials");
    const parts = source.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Invalid encrypted credentials");
    const bytes = parts.slice(1).map((part) => {
      if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("Invalid encrypted credentials");
      const value = Buffer.from(part, "base64url");
      if (value.toString("base64url") !== part) throw new Error("Invalid encrypted credentials");
      return value;
    });
    if (bytes[0].length !== 12 || bytes[2].length !== 16 || !bytes[1].length)
      throw new Error("Invalid encrypted credentials");
    const { key, aad } = context(secret, userId, credentialId);
    const decipher = createDecipheriv("aes-256-gcm", key, bytes[0]);
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes[2]);
    const plaintext = Buffer.concat([decipher.update(bytes[1]), decipher.final()]);
    return validatePaymentCredentials(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
    );
  } catch {
    throw new Error("Payment credentials could not be unlocked.");
  }
}
