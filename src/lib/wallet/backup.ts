import { DERIVATION_PATHS, DERIVATION_SCHEME } from "./derive.ts";
import { validateCipher, type StoredCipher } from "./secret.ts";
export const BACKUP_FORMAT = "fathom-encrypted-wallet";
export type WalletBackup = {
  format: typeof BACKUP_FORMAT;
  version: 1;
  derivation: typeof DERIVATION_SCHEME;
  paths: typeof DERIVATION_PATHS;
  label: string;
  createdAt: number;
  encrypted: StoredCipher;
};
export function createBackup(
  label: string,
  createdAt: number,
  encrypted: StoredCipher,
): WalletBackup {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    derivation: DERIVATION_SCHEME,
    paths: DERIVATION_PATHS,
    label: label.slice(0, 80),
    createdAt,
    encrypted: validateCipher(encrypted),
  };
}
export function parseBackup(text: string): WalletBackup {
  if (text.length > 16_384) throw new Error("This backup file is too large.");
  let row: Record<string, unknown>;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    row = value;
  } catch {
    throw new Error("Choose a valid Fathom encrypted JSON backup.");
  }
  if (row.format !== BACKUP_FORMAT || row.version !== 1 || row.derivation !== DERIVATION_SCHEME)
    throw new Error("Unsupported backup format or derivation scheme.");
  if (
    !row.paths ||
    typeof row.paths !== "object" ||
    Object.entries(DERIVATION_PATHS).some(
      ([name, path]) => (row.paths as Record<string, unknown>)[name] !== path,
    )
  )
    throw new Error("Backup derivation paths do not match this wallet version.");
  if (
    typeof row.label !== "string" ||
    row.label.length > 80 ||
    typeof row.createdAt !== "number" ||
    !Number.isFinite(row.createdAt) ||
    row.createdAt < 0
  )
    throw new Error("Invalid backup metadata.");
  return {
    format: BACKUP_FORMAT,
    version: 1,
    derivation: DERIVATION_SCHEME,
    paths: DERIVATION_PATHS,
    label: row.label,
    createdAt: row.createdAt,
    encrypted: validateCipher(row.encrypted),
  };
}
