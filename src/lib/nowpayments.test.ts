import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import {
  createNowPaymentsClient,
  NowPaymentsUnavailableError,
  verifyNowPaymentsPayment,
  verifyNowPaymentsSignature,
} from "./nowpayments";

const expected = { intentId: "intent-fixture-123", invoiceId: "101", amountUsd: "12.50" };
const payment = {
  payment_id: 202,
  invoice_id: 101,
  order_id: expected.intentId,
  price_amount: 12.5,
  price_currency: "usd",
  payment_status: "finished",
};
test("IPN verification uses recursively sorted JSON, constant-size SHA512 signatures and the merchant secret", () => {
  const secret = "merchant-ipn-secret-fixture";
  const body = { z: [3, { b: "two", a: 1 }], payment_status: "finished", a: { y: true, x: null } };
  const canonical =
    '{"a":{"x":null,"y":true},"payment_status":"finished","z":[3,{"a":1,"b":"two"}]}';
  const signature = createHmac("sha512", secret).update(canonical).digest("hex");
  assert.equal(verifyNowPaymentsSignature(body, signature, secret), true);
  assert.equal(verifyNowPaymentsSignature(body, signature.toUpperCase(), secret), true);
  assert.equal(
    verifyNowPaymentsSignature({ ...body, payment_status: "waiting" }, signature, secret),
    false,
  );
  for (const value of [undefined, "", signature.slice(2), "g".repeat(128), `${signature}00`])
    assert.equal(verifyNowPaymentsSignature(body, value, secret), false);
  assert.equal(verifyNowPaymentsSignature(body, signature, "different-secret"), false);
  assert.equal(verifyNowPaymentsSignature([body], signature, secret), false);
});
test("only authoritative finished payments matching the bound order, optional invoice and exact USD price confirm", () => {
  assert.deepEqual(verifyNowPaymentsPayment(payment, expected), {
    status: "confirmed",
    paymentId: "202",
  });
  assert.equal(
    verifyNowPaymentsPayment({ ...payment, invoice_id: undefined }, expected).status,
    "confirmed",
  );
  assert.equal(
    verifyNowPaymentsPayment({ ...payment, purchase_id: 999, invoice_id: undefined }, expected)
      .status,
    "confirmed",
  );
  for (const patch of [
    { order_id: "another-order" },
    { invoice_id: 999 },
    { price_amount: 12.49 },
    { price_amount: 12.501 },
    { price_currency: "eur" },
    { payment_id: "bad-id" },
  ])
    assert.equal(verifyNowPaymentsPayment({ ...payment, ...patch }, expected).status, "rejected");
  for (const status of ["waiting", "confirming", "confirmed", "sending", "partially_paid"])
    assert.equal(
      verifyNowPaymentsPayment({ ...payment, payment_status: status }, expected).status,
      "pending",
    );
  for (const status of ["failed", "refunded", "expired", "finished-but-unknown"])
    assert.equal(
      verifyNowPaymentsPayment({ ...payment, payment_status: status }, expected).status,
      "rejected",
    );
});
test("invoice creation uses the official API contract and accepts only a trusted HTTPS checkout URL", async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const client = createNowPaymentsClient({
    fetch: (async (url, options) => {
      calls.push({ url: String(url), options: options! });
      return Response.json({ id: 101, invoice_url: "https://nowpayments.io/payment/?iid=101" });
    }) as typeof fetch,
  });
  const result = await client.createInvoice({
    apiKey: "merchant-fixture-api-key",
    intentId: expected.intentId,
    amountUsd: expected.amountUsd,
    handle: "creator-a",
    callbackUrl: "https://fathom.example.com/api/payments/nowpayments/webhook/version-1",
    returnUrl: "https://fathom.example.com/creator-a",
  });
  assert.deepEqual(result, {
    invoiceId: "101",
    checkoutUrl: "https://nowpayments.io/payment/?iid=101",
  });
  assert.equal(calls[0].url, "https://api.nowpayments.io/v1/invoice");
  assert.equal(calls[0].options.redirect, "error");
  const body = JSON.parse(calls[0].options.body as string);
  assert.deepEqual(Object.keys(body).sort(), [
    "cancel_url",
    "ipn_callback_url",
    "order_description",
    "order_id",
    "price_amount",
    "price_currency",
    "success_url",
  ]);
  assert.equal(body.price_amount, 12.5);
  assert.equal(body.order_id, expected.intentId);
  assert.equal(body.order_description, "Message for @creator-a");
  const invoiceInput = {
    apiKey: "merchant-fixture-api-key",
    intentId: expected.intentId,
    amountUsd: "1.00",
    handle: "creator-a",
    callbackUrl: "https://fathom.example.com/ipn",
    returnUrl: "https://fathom.example.com/creator-a",
  };
  for (const url of [
    "http://nowpayments.io/payment",
    "https://nowpayments.io.evil.com/",
    "https://user:password@nowpayments.io/",
    "https://pay.nowpayments.io/?api_key=secret",
    "https://nowpayments.io/payment/?iid=999",
    "https://unrelated.example.com/",
  ]) {
    const unsafe = createNowPaymentsClient({
      fetch: (async () => Response.json({ id: 101, invoice_url: url })) as typeof fetch,
    });
    await assert.rejects(unsafe.createInvoice(invoiceInput), NowPaymentsUnavailableError);
  }
});
test("payment lookups use the authenticated official endpoint, bind response ID, and bound provider responses", async () => {
  let target = "";
  const client = createNowPaymentsClient({
    fetch: (async (url) => {
      target = String(url);
      return Response.json(payment);
    }) as typeof fetch,
  });
  assert.deepEqual(await client.getPayment("merchant-fixture-api-key", "202"), payment);
  assert.equal(target, "https://api.nowpayments.io/v1/payment/202");
  const mismatched = createNowPaymentsClient({
    fetch: (async () => Response.json({ ...payment, payment_id: 999 })) as typeof fetch,
  });
  await assert.rejects(
    mismatched.getPayment("merchant-fixture-api-key", "202"),
    NowPaymentsUnavailableError,
  );
  const oversized = createNowPaymentsClient({
    fetch: (async () => new Response("x".repeat(262145))) as typeof fetch,
  });
  await assert.rejects(
    oversized.getPayment("merchant-fixture-api-key", "202"),
    NowPaymentsUnavailableError,
  );
  const unavailable = createNowPaymentsClient({
    fetch: (async () =>
      Response.json({ message: "credential must-not-log" }, { status: 401 })) as typeof fetch,
  });
  await assert.rejects(
    unavailable.getPayment("merchant-fixture-api-key", "202"),
    (error: Error) =>
      error instanceof NowPaymentsUnavailableError && !error.message.includes("must-not-log"),
  );
});
