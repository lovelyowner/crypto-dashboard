import assert from "node:assert/strict";
import { test } from "node:test";
import { addressesFromMnemonic, createMnemonic, isValidMnemonic } from "./derive.ts";
import { openSecret, PASSPHRASE_ITERATIONS, sealWithPassphrase, validateCipher } from "./secret.ts";
import { createBackup, parseBackup } from "./backup.ts";

const phrase =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const passphrase = "🔐 strong wallet passphrase !@#$%^&*()";

test("standard BIP39/BIP32/SLIP10 paths match independent public test vectors", () => {
  assert.deepEqual(addressesFromMnemonic(phrase), {
    bitcoin: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
    ethereum: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
    solana: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk",
    cosmos: "cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4",
    xrp: "rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3",
    near: "5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412",
  });
});

test("wallet generation uses 24 valid random BIP39 words; invalid checksums are refused", () => {
  const generated = createMnemonic();
  assert.equal(generated.split(" ").length, 24);
  assert.equal(isValidMnemonic(generated), true);
  assert.equal(isValidMnemonic("abandon ".repeat(12)), false);
  assert.throws(() => addressesFromMnemonic("abandon ".repeat(12)), /valid recovery phrase/);
  assert.deepEqual(
    addressesFromMnemonic("  " + phrase.toUpperCase().replaceAll(" ", "\n") + "  "),
    addressesFromMnemonic(phrase),
  );
});

test("passphrase encryption is nondeterministic and authenticates password and ciphertext", async () => {
  const first = await sealWithPassphrase(phrase, passphrase);
  const second = await sealWithPassphrase(phrase, passphrase);
  assert.equal(first.iterations, PASSPHRASE_ITERATIONS);
  assert.equal(first.kdf, "pbkdf2");
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
  assert.equal(await openSecret(first, passphrase), phrase);
  await assert.rejects(() => openSecret(first, passphrase + "x"), /Wrong wallet passphrase/);
  const modified = {
    ...first,
    ciphertext: (first.ciphertext[0] === "A" ? "B" : "A") + first.ciphertext.slice(1),
  };
  await assert.rejects(() => openSecret(modified, passphrase), /Wrong wallet passphrase/);
});

test("backup roundtrip preserves derivation and ciphertext, rejects untrusted expensive inputs", async () => {
  const encrypted = await sealWithPassphrase(phrase, passphrase);
  const backup = createBackup("Public test fixture", 1700000000000, encrypted);
  const restored = parseBackup(JSON.stringify(backup));
  assert.equal(await openSecret(restored.encrypted, passphrase), phrase);
  assert.throws(() => parseBackup(JSON.stringify({ ...backup, version: 2 })), /Unsupported backup/);
  assert.throws(
    () =>
      parseBackup(
        JSON.stringify({ ...backup, paths: { ...backup.paths, solana: "m/44'/501'/0'" } }),
      ),
    /derivation paths/,
  );
  assert.throws(() => validateCipher({ ...encrypted, iterations: 1e12 }), /work factor/);
  assert.throws(() => validateCipher({ ...encrypted, iterations: 0 }), /work factor/);
  assert.throws(() => validateCipher({ ...encrypted, iv: "AAAA" }), /length/);
  assert.throws(() => validateCipher({ ...encrypted, ciphertext: "!" }), /Malformed/);
  assert.throws(() => validateCipher({ ...encrypted, kdf: "raw" }), /Legacy/);
  assert.throws(() => parseBackup(" ".repeat(16385)), /too large/);
  await assert.rejects(() => sealWithPassphrase(phrase, "short"), /12–1024/);
});
