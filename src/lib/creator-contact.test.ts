import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONTACT_SETTINGS,
  validateContactSettings,
  validateContactText,
  validateContactMessageInput,
  contactAmountUnits,
  validateContactConfiguration,
} from "./creator-contact";

test("contact settings preserve exact prices and require a published-wallet choice for paid ETH", () => {
  assert.deepEqual(validateContactSettings(DEFAULT_CONTACT_SETTINGS), DEFAULT_CONTACT_SETTINGS);
  assert.equal(contactAmountUnits("0.000000000000000001", 18), 1n);
  const paid = {
    ...DEFAULT_CONTACT_SETTINGS,
    dmMode: "paid",
    dmEthPrice: "0.100000000000000001",
    ethDonationAddressId: "donate-eth",
  };
  assert.equal(validateContactSettings(paid).dmEthPrice, "0.100000000000000001");
  for (const bad of ["0", "-1", "1e2", "NaN", "01.2", "1.0000000000000000001"])
    assert.throws(() => validateContactSettings({ ...paid, dmEthPrice: bad }));
  assert.throws(() => validateContactSettings({ ...paid, ethDonationAddressId: null }));
  assert.throws(() => validateContactSettings({ ...DEFAULT_CONTACT_SETTINGS, dmMode: "paid" }));
  assert.throws(() => validateContactSettings({ ...DEFAULT_CONTACT_SETTINGS, userId: "other" }));
  assert.equal(
    validateContactSettings({ ...DEFAULT_CONTACT_SETTINGS, dmMode: "paid", dmUsdPrice: "5.00" })
      .dmUsdPrice,
    "5.00",
  );
});
test("messages bound Unicode text, reject hidden controls and never accept client-chosen actor identity", () => {
  assert.equal(validateContactText("  Привет 🌙\r\nHello  "), "Привет 🌙\nHello");
  assert.equal(validateContactText("🌙".repeat(2000)).length, 4000);
  for (const bad of [
    "",
    " ",
    "a".repeat(2001),
    "🌙".repeat(2001),
    "hidden\u0000",
    "mask\u202e",
    "\ud800",
  ])
    assert.throws(() => validateContactText(bad));
  assert.deepEqual(validateContactMessageInput({ kind: "dm", text: "Hi", anonymous: false }), {
    kind: "dm",
    text: "Hi",
    anonymous: false,
  });
  assert.throws(() => validateContactMessageInput({ kind: "dm", text: "Hi", anonymous: true }));
  assert.throws(() =>
    validateContactMessageInput({
      kind: "donation",
      text: "Hi",
      anonymous: true,
      senderId: "owner",
    }),
  );
  const config = validateContactConfiguration({
    handle: "creator",
    settings: DEFAULT_CONTACT_SETTINGS,
    ethereumAddresses: [],
    nowpaymentsConfigured: false,
    email: "private",
  });
  assert.equal("email" in config, false);
});
