import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATOR_PROFILE_MAX_BYTES,
  DEFAULT_CREATOR_PROFILE,
  decodeProfileShare,
  encodeProfileShare,
  parseCreatorProfile,
  serializeCreatorProfile,
  validateCreatorProfile,
  validatePublicProfileUrl,
  type CreatorProfile,
} from "./creator-profile";

function profile(): CreatorProfile {
  return {
    ...DEFAULT_CREATOR_PROFILE,
    displayName: "Aster 🌙 / アスター",
    bio: "Building things together.\nПривет 👋🏽",
    links: [{ id: "link-1", label: "My website ✨", url: "https://example.com/hello" }],
    wishlist: [
      {
        id: "wish-1",
        title: "Drawing tools",
        url: "https://shop.example.com/pencils",
        price: "19.50",
        currency: "EUR",
      },
    ],
    serviceLinks: {
      allmylinks: "https://allmylinks.com/aster",
      throne: "https://throne.com/aster",
      nowpayments: "https://nowpayments.io/payment/?iid=invoice-123",
      bluesky: "https://bsky.app/profile/aster.example.com",
    },
    donations: {
      bankLink: "https://buy.stripe.com/test-checkout",
      crypto: [
        {
          id: "donate-1",
          chain: "ethereum",
          address: "0x52908400098527886E0F7030069857D2E4169EE7",
          label: "ETH donations",
        },
      ],
    },
  };
}

test("public profile JSON and URL shares preserve Unicode, ordered data and exact prices", () => {
  const input = profile();
  input.links.push({ id: "link-2", label: "Second", url: "https://example.org/" });
  const validated = validateCreatorProfile(input);
  assert.deepEqual(parseCreatorProfile(serializeCreatorProfile(input)), validated);
  const encoded = encodeProfileShare(input);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeProfileShare(encoded), validated);
  assert.equal(validated.donations.crypto[0].address, "0x52908400098527886e0f7030069857d2e4169ee7");
  assert.equal(validated.wishlist[0].price, "19.50");
  assert.notEqual(validated.links, input.links);
  assert.notEqual(validated.serviceLinks, input.serviceLinks);
  assert.deepEqual(validateCreatorProfile(DEFAULT_CREATOR_PROFILE), DEFAULT_CREATOR_PROFILE);
});

test("only explicitly supported public fields are imported, exported or shared", () => {
  const input = {
    ...profile(),
    password: "must-not-export",
    accessToken: "must-not-export",
    recoveryWords: ["must-not-export"],
    links: [{ ...profile().links[0], secret: "must-not-export" }],
    wishlist: [{ ...profile().wishlist[0], accountToken: "must-not-export" }],
    serviceLinks: { ...profile().serviceLinks, session: "must-not-export" },
    donations: {
      ...profile().donations,
      accountNumber: "must-not-export",
      crypto: [{ ...profile().donations.crypto[0], privateKey: "must-not-export" }],
    },
  };
  const checked = validateCreatorProfile(input);
  assert.doesNotMatch(
    serializeCreatorProfile(input),
    /must-not-export|password|accessToken|privateKey|accountNumber/,
  );
  assert.deepEqual(parseCreatorProfile(JSON.stringify(input)), checked);
  assert.deepEqual(decodeProfileShare(encodeProfileShare(input)), checked);
});

test("custom URLs reject unsafe schemes, credentials, local hosts and all IP literal forms", () => {
  const invalid = [
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///etc/passwd",
    "http://example.com/",
    "https://user:password@example.com/",
    "https://localhost/",
    "https://a.localhost/",
    "https://server.local/",
    "https://service.internal/",
    "https://service.test/",
    "https://service.invalid/",
    "https://service.home/",
    "https://service.lan/",
    "https://printer/",
    "https://example.com./",
    "https://127.0.0.1/",
    "https://10.0.0.1/",
    "https://192.168.0.1/",
    "https://8.8.8.8/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://0177.0.0.1/",
    "https://[::1]/",
    "https://[2001:4860:4860::8888]/",
    "https://example.com\\@localhost/",
    "https://exam ple.com/",
    "https://example.com/?access_token=secret",
    "https://example.com/?PASSWORD=secret",
    "https://example.com/#id_token=secret",
    "https://example.com/?private_key=secret",
  ];
  for (const url of invalid) {
    assert.throws(() => validatePublicProfileUrl(url), { name: "Error" }, url);
    const input = profile();
    input.links[0].url = url;
    assert.throws(() => validateCreatorProfile(input), { name: "Error" }, url);
  }
  assert.equal(
    validatePublicProfileUrl("  HTTPS://EXAMPLE.COM:443/a?invoice=123#details  "),
    "https://example.com/a?invoice=123#details",
  );
  assert.equal(validatePublicProfileUrl("https://münich.de/"), "https://xn--mnich-kva.de/");
  assert.equal(
    validatePublicProfileUrl("https://shop.example.com/pay?session_id=checkout-123"),
    "https://shop.example.com/pay?session_id=checkout-123",
  );
  assert.equal(validatePublicProfileUrl("", "Optional link", true), "");
  assert.throws(() => validatePublicProfileUrl(""));
});

test("service links require their exact provider domain or www host", () => {
  for (const service of ["allmylinks", "throne", "nowpayments", "bluesky"] as const) {
    const input = profile();
    input.serviceLinks[service] = "https://foreign.example.com/user";
    assert.throws(() => validateCreatorProfile(input), /link must use/);
  }
  for (const url of [
    "https://allmylinks.com.evil.com/user",
    "https://evilallmylinks.com/user",
    "https://user.allmylinks.com/",
  ]) {
    const input = profile();
    input.serviceLinks.allmylinks = url;
    assert.throws(() => validateCreatorProfile(input), /allmylinks.com/);
  }
  const input = profile();
  input.serviceLinks.allmylinks = "https://WWW.ALLMYLINKS.COM/aster";
  assert.equal(
    validateCreatorProfile(input).serviceLinks.allmylinks,
    "https://www.allmylinks.com/aster",
  );
});

test("profile text limits count Unicode characters and reject concealed controls", () => {
  const input = profile();
  input.displayName = "🌙".repeat(80);
  input.bio = "\n".repeat(500);
  assert.equal(validateCreatorProfile(input).displayName, input.displayName);
  input.displayName += "🌙";
  assert.throws(() => validateCreatorProfile(input), /Display name/);
  for (const displayName of ["name\nsecond line", "name\u202eevil", "name\u0000", "\ud800"]) {
    assert.throws(() => validateCreatorProfile({ ...profile(), displayName }), /control/);
  }
  assert.throws(() => validateCreatorProfile({ ...profile(), bio: "a".repeat(501) }), /Bio/);
  const blank = profile();
  blank.links[0].label = "  ";
  assert.throws(() => validateCreatorProfile(blank), /label must not be empty/);
  blank.links[0].label = "Link";
  blank.wishlist[0].title = "\t";
  assert.throws(() => validateCreatorProfile(blank), /Wishlist title/);
});

test("collection limits and duplicate IDs cannot be bypassed by imports", () => {
  const input = profile();
  input.links = Array.from({ length: 20 }, (_, i) => ({ ...input.links[0], id: `link-${i}` }));
  input.wishlist = Array.from({ length: 20 }, (_, i) => ({
    ...input.wishlist[0],
    id: `wish-${i}`,
  }));
  assert.equal(validateCreatorProfile(input).links.length, 20);
  input.links.push({ ...input.links[0], id: "extra" });
  assert.throws(() => validateCreatorProfile(input), /at most 20/);
  input.links.pop();
  input.wishlist.push({ ...input.wishlist[0], id: "extra" });
  assert.throws(() => validateCreatorProfile(input), /at most 20/);
  input.wishlist.pop();
  input.links[1].id = input.links[0].id;
  assert.throws(() => validateCreatorProfile(input), /unique item IDs/);
  input.links[1].id = "unsafe id";
  assert.throws(() => validateCreatorProfile(input), /valid ID/);
});

test("wishlist prices stay exact and bounded; currencies use three uppercase letters", () => {
  for (const price of [
    "-1",
    "1e3",
    "NaN",
    "Infinity",
    "0.123456789",
    "1234567890123",
    "1,000",
    " 1",
    ".5",
    "1.",
    2,
  ]) {
    const input = profile();
    (input.wishlist[0] as unknown as { price: unknown }).price = price;
    assert.throws(() => validateCreatorProfile(input), /Wishlist price/);
  }
  for (const currency of ["usd", "US", "EURO", "€€€", "U1D"]) {
    const input = profile();
    input.wishlist[0].currency = currency;
    assert.throws(() => validateCreatorProfile(input), /currency/);
  }
  for (const price of ["", "0", "0.00000001", "999999999999.99999999"]) {
    const input = profile();
    input.wishlist[0].price = price;
    assert.equal(validateCreatorProfile(input).wishlist[0].price, price);
  }
  const input = profile();
  const item = input.wishlist[0] as Partial<(typeof input.wishlist)[0]>;
  delete item.price;
  delete item.currency;
  assert.equal(validateCreatorProfile(input).wishlist[0].price, "");
  assert.equal(validateCreatorProfile(input).wishlist[0].currency, "USD");
});

test("donation addresses are chain-checked, normalized, bounded and deduplicated", () => {
  const input = profile();
  input.donations.crypto.push({
    ...input.donations.crypto[0],
    id: "another",
    address: input.donations.crypto[0].address.toLowerCase(),
  });
  assert.throws(() => validateCreatorProfile(input), /must not repeat/);
  input.donations.crypto[1].chain = "base";
  assert.equal(validateCreatorProfile(input).donations.crypto.length, 2);
  input.donations.crypto[0].address = "0x52908400098527886e0F7030069857D2E4169EE7";
  assert.throws(() => validateCreatorProfile(input), /valid public address/);
  input.donations.crypto[0] = {
    id: "sol",
    chain: "solana",
    address: "11111111111111111111111111111111",
    label: "SOL",
  };
  assert.equal(validateCreatorProfile(input).donations.crypto[0].chain, "solana");
  const unsupported = profile();
  (unsupported.donations.crypto[0] as unknown as { chain: string }).chain = "fake-chain";
  assert.throws(() => validateCreatorProfile(unsupported), /supported blockchain/);
  const capacity = profile();
  capacity.donations.crypto = Array.from({ length: 11 }, (_, i) => ({
    id: `d-${i}`,
    chain: "near" as const,
    address: `donation${i}.near`,
    label: "NEAR",
  }));
  assert.throws(() => validateCreatorProfile(capacity), /at most 10/);
  capacity.donations.crypto.pop();
  assert.equal(validateCreatorProfile(capacity).donations.crypto.length, 10);
  capacity.donations.bankLink = "DE89370400440532013000";
  assert.throws(() => validateCreatorProfile(capacity), /HTTPS URL/);
  capacity.donations.bankLink = "https://localhost/pay";
  assert.throws(() => validateCreatorProfile(capacity), /public domain/);
});

test("older public drafts without donations receive empty donation options", () => {
  const input = { ...profile() } as Partial<CreatorProfile>;
  delete input.donations;
  assert.deepEqual(validateCreatorProfile(input).donations, { bankLink: "", crypto: [] });
});

test("JSON import rejects malformed roots, versions and oversized UTF-8 input", () => {
  for (const source of [
    "{",
    "null",
    "[]",
    "123",
    '"profile"',
    JSON.stringify({ ...profile(), version: 2 }),
  ]) {
    assert.throws(() => parseCreatorProfile(source));
  }
  assert.throws(() => parseCreatorProfile(" ".repeat(CREATOR_PROFILE_MAX_BYTES + 1)), /50 KB/);
  assert.throws(() => parseCreatorProfile("🌙".repeat(13_000)), /50 KB/);
  const input = profile();
  input.links = Array.from({ length: 20 }, (_, i) => ({
    id: `link-${i}`,
    label: "Link",
    url: `https://example.com/${"a".repeat(1900)}?id=${i}`,
  }));
  input.wishlist = Array.from({ length: 20 }, (_, i) => ({
    id: `wish-${i}`,
    title: "Wish",
    url: `https://example.com/${"b".repeat(1900)}?id=${i}`,
    price: "",
    currency: "USD",
  }));
  assert.throws(() => validateCreatorProfile(input), /50 KB/);
  assert.throws(() => serializeCreatorProfile(input), /50 KB/);
  assert.throws(() => encodeProfileShare(input), /50 KB/);
});

test("share decoding rejects malformed, noncanonical and excessive base64url before parsing", () => {
  for (const encoded of ["", "A", "%%", "e30=", "e30+", "e30/", "_w", "Zh", "a".repeat(66_668)]) {
    assert.throws(() => decodeProfileShare(encoded), { name: "Error" }, encoded.slice(0, 20));
  }
  assert.throws(
    () => decodeProfileShare(Buffer.from("not JSON").toString("base64url")),
    /valid JSON/,
  );
  assert.throws(
    () => decodeProfileShare(Buffer.from([0xc3, 0x28]).toString("base64url")),
    /invalid/,
  );
});
