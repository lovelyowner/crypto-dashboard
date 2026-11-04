import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomBytes } from "node:crypto";
import { paymentFixture } from "./payment-store.test";
import { createPaymentHandler, type PaymentHandlerDependencies } from "./payment-handler";
import { DEFAULT_CONTACT_SETTINGS } from "./creator-contact";
import { decryptPaymentCredentials } from "./payment-credentials";

async function setup() {
  const f = await paymentFixture();
  const origin = "https://app.example.com",
    secret = randomBytes(32).toString("hex");
  await f.contacts.saveSettings("owner", {
    ...DEFAULT_CONTACT_SETTINGS,
    dmMode: "paid",
    dmEthPrice: "0.01",
    dmUsdPrice: "5.00",
    ethDonationAddressId: "eth",
  });
  let nativeState: "pending" | "confirmed" | "rejected" = "pending",
    providerState = "partially_paid",
    getProviderCalls = 0;
  const invoiceOrders = new Map<string, { amount: string }>();
  const dependencies: PaymentHandlerDependencies = {
    configured: true,
    allowedOrigins: [origin],
    publicOrigin: origin,
    encryptionSecret: secret,
    store: f.store,
    contacts: f.contacts,
    getSession: async (headers) => {
      const id = headers.get("x-test-user");
      return id
        ? {
            user: { id, name: `Name ${id}` },
            session: {
              userId: id,
              createdAt: new Date(Date.now() - (headers.has("x-stale") ? 3600_000 : 0)),
              expiresAt: new Date(Date.now() + 3600_000),
            },
          }
        : null;
    },
    ethereum: {
      assertEthereumRecipient: async () => {},
      verifyEthereumPayment: async (intent, hash) =>
        nativeState === "confirmed"
          ? {
              status: "confirmed",
              transactionHash: hash.toLowerCase(),
              confirmations: 3,
              amountWei: intent.amountWei,
              fromAddress: "0x1111111111111111111111111111111111111111",
              blockNumber: 100,
              blockHash: `0x${"a".repeat(64)}`,
            }
          : nativeState === "pending"
            ? { status: "pending", confirmations: 1, reason: "Confirmations pending" }
            : { status: "rejected", reason: "Payment does not match issued nonce." },
    },
    nowpayments: {
      createInvoice: async (input) => {
        invoiceOrders.set(input.intentId, { amount: input.amountUsd });
        return { invoiceId: "100", checkoutUrl: "https://nowpayments.io/payment?iid=100" };
      },
      getPayment: async (_key, paymentId) => {
        getProviderCalls++;
        const [id, order] = [...invoiceOrders][0];
        return {
          payment_id: paymentId,
          order_id: id,
          price_amount: order.amount,
          price_currency: "usd",
          payment_status: providerState,
        };
      },
    },
  };
  const handle = createPaymentHandler(dependencies);
  async function request(
    path: string,
    {
      method = "GET",
      body,
      user,
      headers = {},
    }: { method?: string; body?: unknown; user?: string; headers?: Record<string, string> } = {},
  ) {
    const response = await handle(
      new Request(origin + path, {
        method,
        headers: {
          origin,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(user ? { "x-test-user": user } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    return { response, data: await response.json() };
  }
  const input = (overrides: Record<string, unknown> = {}) => ({
    handle: "creator",
    kind: "dm",
    text: "Private content never goes on chain",
    anonymous: false,
    method: "ethereum",
    ...overrides,
  });
  return {
    ...f,
    origin,
    secret,
    handle,
    request,
    input,
    setNative: (value: typeof nativeState) => {
      nativeState = value;
    },
    setProvider: (value: string) => {
      providerState = value;
    },
    providerCalls: () => getProviderCalls,
  };
}

test("payment receipts preserve anonymous identity, owner authorization and pending-message privacy", async () => {
  const f = await setup();
  try {
    const anonDM = await f.request("/api/payments", {
      method: "POST",
      body: f.input({ anonymous: true }),
    });
    assert.equal(anonDM.response.status, 400);
    const forged = await f.request("/api/payments", {
      method: "POST",
      body: f.input({ kind: "donation", anonymous: true, amount: "0.02" }),
      headers: { origin: "https://evil.example" },
    });
    assert.equal(forged.response.status, 403);
    const created = await f.request("/api/payments", {
      method: "POST",
      body: f.input({ kind: "donation", anonymous: true, amount: "0.02" }),
    });
    assert.equal(created.response.status, 201);
    const { payment, capabilityToken } = created.data;
    assert.match(capabilityToken, /^[a-f0-9]{64}$/);
    assert.match(payment.transaction.data, /^0x[a-f0-9]{64}$/);
    assert.equal(payment.transaction.value, `0x${20000000000000000n.toString(16)}`);
    assert.equal(JSON.stringify(created.data).includes("Private content"), false);
    const raw = await f.store.read(payment.id);
    assert.equal(raw!.senderId, null);
    assert.notEqual(raw!.capabilityHash, capabilityToken);
    assert.equal((await f.contacts.listMessages("owner", "donations", null)).messages.length, 0);
    assert.equal((await f.request(`/api/payments/${payment.id}`)).response.status, 404);
    assert.equal(
      (
        await f.request(`/api/payments/${payment.id}`, {
          headers: { "X-Payment-Token": "f".repeat(64) },
        })
      ).response.status,
      404,
    );
    assert.equal(
      (
        await f.request(`/api/payments/${payment.id}`, {
          headers: { "X-Payment-Token": capabilityToken },
        })
      ).response.status,
      200,
    );
    const owned = await f.request("/api/payments", {
      method: "POST",
      user: "sender",
      body: f.input({ amount: "0.0000001" }),
    });
    assert.equal(owned.data.payment.amount, "0.01");
    assert.equal(
      (await f.request(`/api/payments/${owned.data.payment.id}`, { user: "other" })).response
        .status,
      404,
    );
  } finally {
    await f.pg.close();
  }
});

test("native pending hash resumes on receipt polling, rejected proofs do not deliver, and paid delivery is idempotent", async () => {
  const f = await setup();
  try {
    const created = await f.request("/api/payments", {
      method: "POST",
      user: "sender",
      body: f.input(),
    });
    const id = created.data.payment.id,
      hash = `0x${"1".repeat(64)}`;
    const pending = await f.request(`/api/payments/${id}/verify`, {
      method: "POST",
      user: "sender",
      body: { transactionHash: hash },
    });
    assert.equal(pending.data.payment.status, "pending");
    assert.equal(pending.data.payment.confirmations, 1);
    assert.equal((await f.store.read(id))!.transactionHash, hash);
    assert.equal((await f.contacts.listMessages("owner", "received", null)).messages.length, 0);
    await f.pg.query("update creator_payment_intents set last_verify_at=null where id=$1", [id]);
    f.setNative("confirmed");
    const paid = await f.request(`/api/payments/${id}`, { user: "sender" });
    assert.equal(paid.data.payment.status, "paid");
    assert.equal((await f.contacts.listMessages("owner", "received", null)).messages.length, 1);
    await f.request(`/api/payments/${id}/verify`, {
      method: "POST",
      user: "sender",
      body: { transactionHash: hash },
    });
    assert.equal((await f.contacts.listMessages("owner", "received", null)).messages.length, 1);
    const next = await f.request("/api/payments", {
      method: "POST",
      user: "sender",
      body: f.input(),
    });
    f.setNative("rejected");
    const bad = await f.request(`/api/payments/${next.data.payment.id}/verify`, {
      method: "POST",
      user: "sender",
      body: { transactionHash: `0x${"2".repeat(64)}` },
    });
    assert.equal(bad.response.status, 422);
    assert.equal((await f.store.read(next.data.payment.id))!.transactionHash, null);
    assert.equal((await f.contacts.listMessages("owner", "received", null)).messages.length, 1);
  } finally {
    await f.pg.close();
  }
});

test("creator-owned NOWPayments credentials stay encrypted; signed IPN alone never bypasses authoritative finished verification", async () => {
  const f = await setup();
  try {
    const keys = {
      apiKey: "merchant-fixture-api-key",
      ipnSecret: "fixture-IPN-secret-long-enough",
    };
    assert.equal(
      (
        await f.request("/api/profile/payments", {
          method: "PUT",
          user: "owner",
          body: keys,
          headers: { "x-stale": "1" },
        })
      ).response.status,
      403,
    );
    const saved = await f.request("/api/profile/payments", {
      method: "PUT",
      user: "owner",
      body: keys,
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.data.nowpayments.configured, true);
    assert.equal(JSON.stringify(saved.data).includes(keys.apiKey), false);
    const credential = (await f.store.credential("owner"))!;
    assert.equal(credential.encrypted.includes(keys.apiKey), false);
    assert.deepEqual(
      decryptPaymentCredentials(credential.encrypted, f.secret, "owner", credential.id),
      keys,
    );
    const prepared = await f.request("/api/payments", {
      method: "POST",
      user: "sender",
      body: f.input({ method: "nowpayments", amount: "0.01" }),
    });
    assert.equal(prepared.response.status, 201);
    assert.equal(prepared.data.payment.amount, "5.00");
    assert.equal(prepared.data.payment.checkoutUrl, "https://nowpayments.io/payment?iid=100");
    const id = prepared.data.payment.id;
    const notification = {
      payment_id: 10,
      order_id: id,
      price_amount: 5,
      price_currency: "usd",
      payment_status: "finished",
    };
    const hook = `/api/payments/nowpayments/webhook/${credential.id}`;
    assert.equal(
      (
        await f.request(hook, {
          method: "POST",
          body: notification,
          headers: { "x-nowpayments-sig": "0".repeat(128) },
        })
      ).response.status,
      403,
    );
    assert.equal(f.providerCalls(), 0);
    const sign = (body: Record<string, unknown>) =>
      createHmac("sha512", keys.ipnSecret)
        .update(
          JSON.stringify(
            Object.fromEntries(
              Object.keys(body)
                .sort()
                .map((key) => [key, body[key]]),
            ),
          ),
        )
        .digest("hex");
    const pending = await f.request(hook, {
      method: "POST",
      body: notification,
      headers: { "x-nowpayments-sig": sign(notification) },
    });
    assert.equal(pending.response.status, 200);
    assert.equal(pending.data.status, "pending");
    assert.equal((await f.contacts.listMessages("owner", "received", null)).messages.length, 0);
    f.setProvider("finished");
    const paid = await f.request(hook, {
      method: "POST",
      body: notification,
      headers: { "x-nowpayments-sig": sign(notification) },
    });
    assert.equal(paid.response.status, 200);
    assert.equal(paid.data.status, "paid");
    assert.equal((await f.contacts.listMessages("owner", "received", null)).messages.length, 1);
    await f.request(hook, {
      method: "POST",
      body: notification,
      headers: { "x-nowpayments-sig": sign(notification) },
    });
    assert.equal((await f.contacts.listMessages("owner", "received", null)).messages.length, 1);
  } finally {
    await f.pg.close();
  }
});

test("disabling new hosted checkouts is owner scoped and preserves existing invoice settlement", async () => {
  const f = await setup();
  try {
    const keys = {
      apiKey: "disable-fixture-api-key",
      ipnSecret: "disable-fixture-IPN-secret-long-enough",
    };
    const saved = await f.request("/api/profile/payments", {
      method: "PUT",
      user: "owner",
      body: keys,
    });
    assert.equal(saved.response.status, 200);
    const credential = (await f.store.credential("owner"))!;
    const prepared = await f.request("/api/payments", {
      method: "POST",
      user: "sender",
      body: f.input({ method: "nowpayments" }),
    });
    assert.equal(prepared.response.status, 201);
    const id = prepared.data.payment.id;
    assert.equal((await f.store.read(id))!.credentialId, credential.id);
    const unrelated = await f.pending("other");

    const otherKeys = {
      apiKey: "other-fixture-api-key",
      ipnSecret: "other-fixture-IPN-secret-long-enough",
    };
    await f.request("/api/profile/payments", {
      method: "PUT",
      user: "other",
      body: otherKeys,
    });
    const otherDisabled = await f.request("/api/profile/payments", {
      method: "DELETE",
      user: "other",
    });
    assert.equal(otherDisabled.response.status, 200);
    assert.equal(otherDisabled.data.nowpayments.configured, false);
    assert.equal((await f.store.credential("owner"))!.id, credential.id);
    await f.request("/api/profile/payments", {
      method: "PUT",
      user: "other",
      body: otherKeys,
    });
    const otherCredential = (await f.store.credential("other"))!;

    for (const [options, expectedStatus] of [
      [{}, 401],
      [{ user: "owner", headers: { "x-stale": "1" } }, 403],
      [{ user: "owner", headers: { origin: "https://evil.example" } }, 403],
      [{ user: "owner", headers: { "sec-fetch-site": "cross-site" } }, 403],
    ] as const) {
      const rejected = await f.request("/api/profile/payments", {
        method: "DELETE",
        ...options,
      });
      assert.equal(rejected.response.status, expectedStatus);
      assert.equal((await f.store.credential("owner"))!.id, credential.id);
    }

    const disabled = await f.request("/api/profile/payments", {
      method: "DELETE",
      user: "owner",
    });
    assert.equal(disabled.response.status, 200);
    assert.deepEqual(disabled.data.nowpayments, { configured: false, webhookUrl: null });
    assert.equal(JSON.stringify(disabled.data).includes(keys.apiKey), false);
    assert.equal(JSON.stringify(disabled.data).includes(keys.ipnSecret), false);
    assert.equal(await f.store.credential("owner"), null);
    const retained = (await f.store.credentialById(credential.id))!;
    assert.equal(retained.active, false);
    assert.equal(retained.encrypted, credential.encrypted);
    assert.equal((await f.store.credential("other"))!.id, otherCredential.id);
    assert.equal((await f.store.read(id))!.status, "pending");
    assert.equal((await f.contacts.listMessages("owner", "received", null)).messages.length, 0);

    const newCheckout = await f.request("/api/payments", {
      method: "POST",
      user: "sender",
      body: f.input({ method: "nowpayments" }),
    });
    assert.equal(newCheckout.response.status, 503);
    assert.equal(f.providerCalls(), 0);

    const notification = {
      payment_id: 10,
      order_id: id,
      price_amount: 5,
      price_currency: "usd",
      payment_status: "finished",
    };
    const signature = createHmac("sha512", keys.ipnSecret)
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.keys(notification)
              .sort()
              .map((key) => [key, notification[key as keyof typeof notification]]),
          ),
        ),
      )
      .digest("hex");
    f.setProvider("finished");
    for (let retry = 0; retry < 2; retry++) {
      const completed = await f.request(`/api/payments/nowpayments/webhook/${credential.id}`, {
        method: "POST",
        body: notification,
        headers: { "x-nowpayments-sig": signature },
      });
      assert.equal(completed.response.status, 200);
      assert.equal(completed.data.status, "paid");
    }
    assert.equal((await f.contacts.listMessages("owner", "received", null)).messages.length, 1);
    assert.equal((await f.store.read(unrelated.id))!.status, "pending");
    assert.equal(await f.store.credential("owner"), null);
  } finally {
    await f.pg.close();
  }
});
