import { bech32, base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export type WalletAddresses = {
  bitcoin: string;
  ethereum: string;
  solana: string;
  cosmos: string;
  xrp: string;
  /** NEAR implicit account: create/fund this account before treating it as active. */
  near: string;
};

/** Stored in encrypted exports so another wallet can reproduce these exact accounts. */
export const DERIVATION_PATHS = {
  bitcoin: "m/84'/0'/0'/0/0",
  ethereum: "m/44'/60'/0'/0/0",
  solana: "m/44'/501'/0'/0'",
  cosmos: "m/44'/118'/0'/0/0",
  xrp: "m/44'/144'/0'/0/0",
  near: "m/44'/397'/0'",
} as const;
export const DERIVATION_SCHEME = "fathom-bip39-v1";
const ED_SEED = utf8ToBytes("ed25519 seed");
const HARDENED = 0x80000000;
const BTC_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const XRP_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

export function createMnemonic(): string {
  return generateMnemonic(wordlist, 256);
}

export function normalizeMnemonic(phrase: string): string {
  return phrase.normalize("NFKD").trim().toLowerCase().replace(/\s+/g, " ");
}

export function isValidMnemonic(phrase: string): boolean {
  return validateMnemonic(normalizeMnemonic(phrase), wordlist);
}

/** First account only; no BIP39 seed passphrase. Never call this on a server. */
export function addressesFromMnemonic(phrase: string): WalletAddresses {
  const mnemonic = normalizeMnemonic(phrase);
  if (!validateMnemonic(mnemonic, wordlist))
    throw new Error("Those words are not a valid recovery phrase.");
  const seed = mnemonicToSeedSync(mnemonic);
  try {
    const root = HDKey.fromMasterSeed(seed);
    try {
      const bitcoin = root.derive(DERIVATION_PATHS.bitcoin).publicKey;
      const ethKey = root.derive(DERIVATION_PATHS.ethereum).privateKey;
      const cosmos = root.derive(DERIVATION_PATHS.cosmos).publicKey;
      const xrp = root.derive(DERIVATION_PATHS.xrp).publicKey;
      if (!bitcoin || !ethKey || !cosmos || !xrp) throw new Error("Could not derive wallet keys.");
      const hash = keccak_256(secp256k1.getPublicKey(ethKey, false).subarray(1));
      const ethAddress = toChecksum(bytesToHex(hash.subarray(-20)));
      ethKey.fill(0);
      const xrpPayload = new Uint8Array(25);
      xrpPayload.set(hash160(xrp), 1); // version 0, AccountID 20 bytes, checksum 4 bytes
      xrpPayload.set(sha256(sha256(xrpPayload.subarray(0, 21))).subarray(0, 4), 21);
      return {
        bitcoin: bech32.encode("bc", [0, ...bech32.toWords(hash160(bitcoin))]),
        ethereum: ethAddress,
        solana: base58.encode(edPublic(seed, [44, 501, 0, 0])),
        cosmos: bech32.encode("cosmos", bech32.toWords(hash160(cosmos))),
        xrp: [...base58.encode(xrpPayload)]
          .map((c) => XRP_ALPHABET[BTC_ALPHABET.indexOf(c)])
          .join(""),
        near: bytesToHex(edPublic(seed, [44, 397, 0])),
      };
    } finally {
      root.wipePrivateData();
    }
  } finally {
    seed.fill(0);
  }
}

function hash160(bytes: Uint8Array): Uint8Array {
  return ripemd160(sha256(bytes));
}

/** SLIP-0010 Ed25519: every path segment is hardened. */
function edPublic(seed: Uint8Array, indexes: number[]): Uint8Array {
  let material = hmac(sha512, ED_SEED, seed);
  let key = material.slice(0, 32);
  let chain = material.slice(32);
  material.fill(0);
  try {
    for (const child of indexes) {
      const data = new Uint8Array(37);
      data.set(key, 1);
      new DataView(data.buffer).setUint32(33, child + HARDENED);
      material = hmac(sha512, chain, data);
      key.fill(0);
      chain.fill(0);
      data.fill(0);
      key = material.slice(0, 32);
      chain = material.slice(32);
      material.fill(0);
    }
    return ed25519.getPublicKey(key);
  } finally {
    key.fill(0);
    chain.fill(0);
  }
}

function toChecksum(hex: string): string {
  const hash = bytesToHex(keccak_256(utf8ToBytes(hex)));
  return (
    "0x" + [...hex].map((c, i) => (parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c)).join("")
  );
}
