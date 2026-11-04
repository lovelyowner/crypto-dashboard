import assert from "node:assert/strict";
import test from "node:test";
import {
  createEthereumPaymentVerifier,
  EthereumPaymentRecipientError,
  EthereumPaymentUnavailableError,
} from "./ethereum-payment";

const hash = `0x${"a".repeat(64)}`,
  blockHash = `0x${"b".repeat(64)}`;
const to = "0x52908400098527886e0f7030069857d2e4169ee7",
  from = `0x${"1".repeat(40)}`;
const nonceData = `0x${"c".repeat(64)}`;
const mined = Date.parse("2026-11-04T12:00:00Z");
const intent = {
  recipientAddress: to,
  amountWei: "1000000000000000",
  nonceData,
  expiresAt: new Date(mined + 60_000).toISOString(),
};
const hex = (value: number | bigint) => `0x${value.toString(16)}`;
function fixture(change: Record<string, unknown> = {}) {
  const replies: Record<string, unknown> = {
    eth_chainId: "0x1",
    eth_getCode: "0x",
    eth_blockNumber: "0x66",
    eth_getTransactionByHash: {
      hash,
      chainId: "0x1",
      from,
      to,
      input: nonceData,
      value: hex(1000000000000000n),
      blockNumber: "0x64",
      blockHash,
    },
    eth_getTransactionReceipt: {
      transactionHash: hash,
      from,
      to,
      status: "0x1",
      blockNumber: "0x64",
      blockHash,
    },
    eth_getBlockByNumber: {
      number: "0x64",
      hash: blockHash,
      transactions: [hash],
      timestamp: hex(mined / 1000),
    },
    ...change,
  };
  const methods: string[] = [];
  const verifier = createEthereumPaymentVerifier({
    fetch: (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      methods.push(request.method);
      return Response.json({ jsonrpc: "2.0", id: request.id, result: replies[request.method] });
    }) as typeof fetch,
  });
  return { ...verifier, methods, replies };
}

test("Ethereum payment proof binds chain, recipient, exact reference, successful canonical inclusion and three confirmations", async () => {
  const f = fixture();
  await f.assertEthereumRecipient(to);
  const result = await f.verifyEthereumPayment(intent, hash);
  assert.equal(result.status, "confirmed");
  if (result.status === "confirmed") {
    assert.equal(result.confirmations, 3);
    assert.equal(result.amountWei, intent.amountWei);
  }
  assert.ok(f.methods.every((method) => !method.includes("send") && !method.includes("sign")));
  const delegated = fixture({ eth_getCode: "0xef0100" });
  await assert.rejects(delegated.assertEthereumRecipient(to), EthereumPaymentRecipientError);
  assert.equal(
    (await delegated.verifyEthereumPayment(intent, hash)).status,
    "confirmed",
    "An address delegating after payment cannot erase a completed transfer",
  );
});

test("pending, mismatched, failed, reorganized and late transfers cannot unlock a message", async () => {
  assert.equal(
    (await fixture({ eth_getTransactionReceipt: null }).verifyEthereumPayment(intent, hash)).status,
    "pending",
  );
  assert.equal(
    (await fixture({ eth_blockNumber: "0x65" }).verifyEthereumPayment(intent, hash)).status,
    "pending",
  );
  const base = fixture().replies;
  const tx = base.eth_getTransactionByHash as Record<string, unknown>,
    receipt = base.eth_getTransactionReceipt as Record<string, unknown>,
    block = base.eth_getBlockByNumber as Record<string, unknown>;
  for (const changes of [
    { eth_chainId: "0x89" },
    { eth_getTransactionByHash: { ...tx, input: `0x${"d".repeat(64)}` } },
    { eth_getTransactionByHash: { ...tx, to: from } },
    { eth_getTransactionByHash: { ...tx, value: "0x1" } },
    { eth_getTransactionReceipt: { ...receipt, status: "0x0" } },
    { eth_getTransactionReceipt: { ...receipt, blockNumber: "0x63" } },
    { eth_getBlockByNumber: { ...block, hash: `0x${"e".repeat(64)}` } },
    { eth_getBlockByNumber: { ...block, transactions: [] } },
    { eth_getBlockByNumber: { ...block, timestamp: hex((mined + 120_000) / 1000) } },
  ])
    assert.notEqual(
      (await fixture(changes).verifyEthereumPayment(intent, hash)).status,
      "confirmed",
    );
});

test("RPC failures, wrong response IDs and unsafe configuration fail closed without leaking provider keys", async () => {
  for (const request of [
    async () => new Response("unavailable", { status: 503 }),
    async () => Response.json({ jsonrpc: "2.0", id: "wrong", result: "0x1" }),
    async () => new Response("{}", { headers: { "content-length": String(2 * 1024 * 1024) } }),
  ]) {
    const verifier = createEthereumPaymentVerifier({ fetch: request as typeof fetch });
    await assert.rejects(
      verifier.verifyEthereumPayment(intent, hash),
      EthereumPaymentUnavailableError,
    );
  }
  const f = fixture();
  await assert.rejects(
    f.assertEthereumRecipient(`0x${"0".repeat(40)}`),
    EthereumPaymentRecipientError,
  );
  assert.equal((await f.verifyEthereumPayment(intent, "not-a-hash")).status, "rejected");
  assert.equal(f.methods.length, 0);
  const unsafe = createEthereumPaymentVerifier({ rpcUrl: "http://localhost/?key=must-not-leak" });
  await assert.rejects(
    unsafe.verifyEthereumPayment(intent, hash),
    (error) => error instanceof Error && !error.message.includes("must-not-leak"),
  );
});
