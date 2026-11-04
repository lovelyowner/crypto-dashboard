import test from "node:test";
import assert from "node:assert/strict";
import { validatePaymentResponse } from "./payment-types";

const id = "12345678-1234-4234-8234-123456789abc";
const messageId = "12345678-1234-4234-8234-123456789abd";
function receipt() {
  return {
    payment: {
      id,
      messageId,
      kind: "dm",
      method: "ethereum",
      status: "pending",
      amount: "0.001",
      currency: "ETH",
      createdAt: "2026-11-04T10:00:00Z",
      expiresAt: "2026-11-05T10:00:00Z",
      confirmations: 0,
      transaction: {
        chainId: 1,
        to: "0x52908400098527886e0f7030069857d2e4169ee7",
        value: "0x38d7ea4c68000",
        data: `0x${"ab".repeat(32)}`,
      },
    },
  };
}

test("payment instructions charge exactly the displayed native amount and whitelist only receipt data", () => {
  const value = { ...receipt(), apiKey: "not-a-receipt", password: "not-a-receipt" };
  const parsed = validatePaymentResponse(value);
  assert.equal(parsed.payment.transaction?.value, "0x38d7ea4c68000");
  assert.doesNotMatch(JSON.stringify(parsed), /not-a-receipt|apiKey|password/);
  const zero = receipt();
  zero.payment.amount = "0";
  assert.throws(() => validatePaymentResponse(zero));
  const different = receipt();
  different.payment.transaction.value = "0x1";
  assert.throws(() => validatePaymentResponse(different), /displayed payment amount/);
  const huge = receipt();
  huge.payment.transaction.value = `0x${"f".repeat(10000)}`;
  assert.throws(() => validatePaymentResponse(huge));
  const burn = receipt();
  burn.payment.transaction.to = `0x${"0".repeat(40)}`;
  assert.throws(() => validatePaymentResponse(burn));
});

test("payment states cannot mix currencies or mark unconfirmed Ethereum transfers paid", () => {
  const mixed = receipt();
  mixed.payment.currency = "USD";
  assert.throws(() => validatePaymentResponse(mixed), /currency/);
  const unconfirmed = receipt();
  unconfirmed.payment.status = "paid";
  assert.throws(() => validatePaymentResponse(unconfirmed), /incomplete/);
  unconfirmed.payment.confirmations = 3;
  assert.equal(validatePaymentResponse(unconfirmed).payment.status, "paid");
  const fakeId = receipt();
  fakeId.payment.id = "-".repeat(36);
  assert.throws(() => validatePaymentResponse(fakeId));
});

test("hosted checkout accepts only HTTPS NOWPayments URLs and exact positive USD prices", () => {
  const base = receipt();
  const { transaction: _tx, ...other } = base.payment;
  const hosted = {
    payment: {
      ...other,
      method: "nowpayments",
      currency: "USD",
      amount: "5.00",
      checkoutUrl: "https://nowpayments.io/payment/?iid=123",
    },
  };
  assert.equal(validatePaymentResponse(hosted).payment.checkoutUrl, hosted.payment.checkoutUrl);
  for (const url of [
    "http://nowpayments.io/payment",
    "https://nowpayments.io.evil.com/",
    "https://user:pass@nowpayments.io/",
    "https://nowpayments.io:4443/payment",
    "javascript:alert(1)",
  ])
    assert.throws(() =>
      validatePaymentResponse({ payment: { ...hosted.payment, checkoutUrl: url } }),
    );
  assert.throws(() => validatePaymentResponse({ payment: { ...hosted.payment, amount: "0.001" } }));
});
