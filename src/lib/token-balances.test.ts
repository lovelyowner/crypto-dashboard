import assert from "node:assert/strict";
import test from "node:test";
import { base58 } from "@scure/base";
import {
  createTokenBalanceClient,
  decodeTokenText,
  formatExactTokenAmount,
  SPL_TOKEN_2022_PROGRAM,
  SPL_TOKEN_PROGRAM,
} from "./token-balances";
import type { TokenWatch } from "./token-watch";

const ethereum: TokenWatch = {
  id: "token-1",
  ownerId: "owner-1",
  chain: "ethereum",
  ownerAddress: "0x1111111111111111111111111111111111111111",
  tokenAddress: "0x2222222222222222222222222222222222222222",
  label: "Example",
};
const solana: TokenWatch = {
  id: "token-2",
  ownerId: "owner-2",
  chain: "solana",
  ownerAddress: base58.encode(new Uint8Array(32).fill(1)),
  tokenAddress: base58.encode(new Uint8Array(32).fill(2)),
  label: "SPL example",
};
function word(value: bigint | number) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}
function textAbi(text: string) {
  const bytes = new TextEncoder().encode(text);
  return `${word(32)}${word(bytes.length).slice(2)}${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .padEnd(Math.ceil(bytes.length / 32) * 64, "0")}`;
}
type Request = { id: number; method: string; params: unknown[] };
function fixture(answer: (request: Request) => unknown | Promise<unknown>) {
  const calls: Request[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.ok(
      ["https://ethereum-rpc.publicnode.com", "https://solana-rpc.publicnode.com"].includes(
        String(url),
      ),
    );
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(init?.redirect, "error");
    const request = JSON.parse(String(init?.body)) as Request;
    calls.push(request);
    return Response.json({ jsonrpc: "2.0", id: request.id, result: await answer(request) });
  };
  return { client: createTokenBalanceClient({ fetch: fetcher }), calls };
}
function ethAnswer(raw = word(1234567), precision = word(6)) {
  return (request: Request) => {
    if (request.method === "eth_chainId") return "0x1";
    assert.equal(request.method, "eth_call");
    assert.equal(request.params[1], "latest");
    const call = request.params[0] as { to: string; data: string };
    assert.equal(call.to, ethereum.tokenAddress);
    if (call.data.startsWith("0x70a08231")) {
      assert.equal(call.data, `0x70a08231${ethereum.ownerAddress.slice(2).padStart(64, "0")}`);
      return raw;
    }
    if (call.data === "0x313ce567") return precision;
    if (call.data === "0x95d89b41") return textAbi("EXM");
    if (call.data === "0x06fdde03") return textAbi("Example token");
    throw new Error("Unexpected selector");
  };
}
function splFixture(
  program = SPL_TOKEN_PROGRAM,
  amounts = ["9007199254740993", "9007199254740994"],
) {
  const parser = program === SPL_TOKEN_PROGRAM ? "spl-token" : "spl-token-2022";
  const mint = {
    value: {
      owner: program,
      executable: false,
      data: {
        program: parser,
        parsed: {
          type: "mint",
          info: { decimals: 9, isInitialized: true, supply: "18446744073709551615" },
        },
      },
    },
  };
  const accounts = {
    value: amounts.map((amount, index) => ({
      pubkey: base58.encode(new Uint8Array(32).fill(index + 3)),
      account: {
        owner: program,
        executable: false,
        data: {
          program: parser,
          parsed: {
            type: "account",
            info: {
              owner: solana.ownerAddress,
              mint: solana.tokenAddress,
              state: index === 0 ? "frozen" : "initialized",
              tokenAmount: { amount, decimals: 9, uiAmount: 0.0001 },
            },
          },
        },
      },
    })),
  };
  return {
    mint,
    accounts,
    answer: (request: Request) => {
      if (request.method === "getAccountInfo") {
        assert.deepEqual(request.params, [
          solana.tokenAddress,
          { encoding: "jsonParsed", commitment: "finalized" },
        ]);
        return mint;
      }
      assert.equal(request.method, "getTokenAccountsByOwner");
      assert.deepEqual(request.params, [
        solana.ownerAddress,
        { mint: solana.tokenAddress },
        { encoding: "jsonParsed", commitment: "finalized" },
      ]);
      return accounts;
    },
  };
}

test("exact formatting handles uint256, tiny amounts, zero and decimal bounds without floats", () => {
  assert.equal(
    formatExactTokenAmount(((1n << 256n) - 1n).toString(), 18),
    "115792089237316195423570985008687907853269984665640564039457.584007913129639935",
  );
  assert.equal(formatExactTokenAmount("1", 18), "0.000000000000000001");
  assert.equal(formatExactTokenAmount("1000000", 6), "1");
  assert.equal(formatExactTokenAmount("0", 255), "0");
  assert.equal(formatExactTokenAmount("456", 0), "456");
  for (const [raw, places] of [
    ["-1", 0],
    ["01", 0],
    ["1.1", 0],
    ["1", 256],
    ["1", -1],
    [(1n << 256n).toString(), 0],
  ] as const)
    assert.throws(() => formatExactTokenAmount(raw, places));
});

test("ERC20 reads standard ABI balances and optional metadata with public read-only calls", async () => {
  const { client, calls } = fixture(ethAnswer());
  const result = await client.readTokenBalance(ethereum);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.rawAmount, "1234567");
  assert.equal(result.decimals, 6);
  assert.equal(result.amount, "1.234567");
  assert.equal(result.symbol, "EXM");
  assert.equal(result.name, "Example token");
  assert.equal(result.metadataUnavailable, false);
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => call.method === "eth_call" || call.method === "eth_chainId"));
});

test("ERC20 preserves huge balances and actual zero only when required metadata is valid", async () => {
  for (const value of [0n, (1n << 256n) - 1n]) {
    const { client } = fixture(ethAnswer(word(value), word(0)));
    const result = await client.readTokenBalance(ethereum);
    assert.equal(result.status, "ready");
    if (result.status === "ready") assert.equal(result.amount, value.toString());
  }
});

test("unavailable optional symbol/name stays explicit while decimals and raw balance remain usable", async () => {
  const answer = ethAnswer();
  const { client } = fixture((request) => {
    const data = (request.params[0] as { data?: string } | undefined)?.data;
    return data === "0x95d89b41" || data === "0x06fdde03" ? "0x" : answer(request);
  });
  const result = await client.readTokenBalance(ethereum);
  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.equal(result.symbol, null);
    assert.equal(result.name, null);
    assert.equal(result.metadataUnavailable, true);
    assert.equal(result.amount, "1.234567");
  }
});

test("malformed ERC20 balance, missing decimals, wrong network never become zero", async () => {
  const cases = [
    ethAnswer("0x0"),
    ethAnswer("0x"),
    ethAnswer(word(1), "0x"),
    ethAnswer(word(1), word(256)),
    (request: Request) => (request.method === "eth_chainId" ? "0xa" : ethAnswer()(request)),
  ];
  for (const answer of cases) {
    const result = await fixture(answer).client.readTokenBalance(ethereum);
    assert.equal(result.status, "unsupported");
    assert.equal("amount" in result, false);
  }
});

test("bounded ABI metadata rejects malformed UTF8, offsets, controls, and oversized strings", () => {
  assert.equal(decodeTokenText(textAbi("Example")), "Example");
  assert.equal(decodeTokenText(`0x${Buffer.from("OLD").toString("hex").padEnd(64, "0")}`), "OLD");
  for (const value of [
    "0x",
    word(0),
    textAbi("bad\u0000text"),
    textAbi("bad\u202etext"),
    textAbi("x".repeat(65)),
    `${word(64)}${textAbi("BAD").slice(66)}`,
    `0x${"ff".repeat(32)}`,
  ])
    assert.equal(decodeTokenText(value), null);
});

test("classic SPL and Token-2022 sum every matching account exactly, ignoring rounded uiAmount", async () => {
  for (const program of [SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM]) {
    const data = splFixture(program);
    const { client, calls } = fixture(data.answer);
    const result = await client.readTokenBalance(solana);
    assert.equal(result.status, "ready");
    if (result.status === "ready") {
      assert.equal(result.rawAmount, "18014398509481987");
      assert.equal(result.amount, "18014398.509481987");
      assert.equal(result.accountCount, 2);
      assert.equal(result.program, program === SPL_TOKEN_PROGRAM ? "SPL Token" : "Token-2022");
    }
    assert.equal(calls.length, 2);
  }
});

test("SPL empty account set is zero only after a valid parsed mint", async () => {
  const { client } = fixture(splFixture(SPL_TOKEN_PROGRAM, []).answer);
  const result = await client.readTokenBalance(solana);
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.equal(result.amount, "0");
});

test("Token-2022 confidential mint or account extensions never present a partial public zero as a complete balance", async () => {
  for (const location of ["mint", "account"] as const) {
    const data = splFixture(SPL_TOKEN_2022_PROGRAM, ["0"]);
    const info =
      location === "mint"
        ? data.mint.value.data.parsed.info
        : data.accounts.value[0].account.data.parsed.info;
    Object.assign(info, {
      extensions: [
        {
          extension:
            location === "mint" ? "confidentialTransferMint" : "confidentialTransferAccount",
          state: {},
        },
      ],
    });
    const result = await fixture(data.answer).client.readTokenBalance(solana);
    assert.equal(result.status, "unsupported");
    assert.equal("amount" in result, false);
    assert.match(result.message, /Confidential.*hidden balances/);
  }
});

test("Token-2022 interest-bearing and scaled-UI mint or account extensions reject misleading base-unit display", async () => {
  for (const extension of ["interestBearingConfig", "scaledUiAmountConfig"]) {
    for (const location of ["mint", "account"] as const) {
      const data = splFixture(SPL_TOKEN_2022_PROGRAM);
      const info =
        location === "mint"
          ? data.mint.value.data.parsed.info
          : data.accounts.value[0].account.data.parsed.info;
      Object.assign(info, { extensions: [{ extension, state: { multiplier: 2 } }] });
      const result = await fixture(data.answer).client.readTokenBalance(solana);
      assert.equal(result.status, "unsupported");
      assert.equal("amount" in result, false);
      assert.match(result.message, /changes displayed token amounts/);
    }
  }
});

test("SPL extension arrays are bounded and structurally validated when present", async () => {
  const malformed = [
    null,
    {},
    "confidentialTransferAccount",
    [null],
    ["transferHook"],
    [{}],
    [{ extension: 1 }],
    [{ extension: "bad extension" }],
    [{ extension: "unparseableExtension" }],
    [{ extension: "transferHook", state: [] }],
    [{ extension: "transferHook", state: null }],
    [{ extension: "transferHook" }, { extension: "transferHook" }],
    new Array(65).fill({ extension: "immutableOwner" }),
  ];
  for (const extensions of malformed) {
    for (const location of ["mint", "account"] as const) {
      const data = splFixture(SPL_TOKEN_2022_PROGRAM, ["0"]);
      const info =
        location === "mint"
          ? data.mint.value.data.parsed.info
          : data.accounts.value[0].account.data.parsed.info;
      Object.assign(info, { extensions });
      const result = await fixture(data.answer).client.readTokenBalance(solana);
      assert.equal(result.status, "unsupported");
      assert.equal("amount" in result, false);
    }
  }
});

test("Token-2022 public metadata and transfer-hook extensions retain exact base-unit reads", async () => {
  const data = splFixture(SPL_TOKEN_2022_PROGRAM);
  Object.assign(data.mint.value.data.parsed.info, {
    extensions: [
      { extension: "metadataPointer", state: { metadataAddress: solana.tokenAddress } },
      {
        extension: "tokenMetadata",
        state: { name: "Public token", uri: "https://metadata.invalid/not-fetched" },
      },
      { extension: "transferHook", state: { programId: solana.ownerAddress } },
    ],
  });
  Object.assign(data.accounts.value[0].account.data.parsed.info, {
    extensions: [
      { extension: "immutableOwner" },
      { extension: "transferHookAccount", state: { transferring: false } },
    ],
  });
  Object.assign(data.accounts.value[1].account.data.parsed.info, { extensions: [] });
  const { client, calls } = fixture(data.answer);
  const result = await client.readTokenBalance(solana);
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.equal(result.amount, "18014398.509481987");
  assert.equal(calls.length, 2);
});

test("SPL rejects an aggregate exceeding the entire uint64 token supply range", async () => {
  const data = splFixture(SPL_TOKEN_PROGRAM, ["18446744073709551615", "1"]);
  const result = await fixture(data.answer).client.readTokenBalance(solana);
  assert.equal(result.status, "unsupported");
  assert.equal("amount" in result, false);
});

test("SPL rejects mismatched mint, owner, program, decimals, amounts, duplicates and unparsed data", async () => {
  const mutations: ((data: ReturnType<typeof splFixture>) => void)[] = [
    (data) => {
      data.mint.value.owner = solana.ownerAddress;
    },
    (data) => {
      data.mint.value.data.program = "unsupported";
    },
    (data) => {
      data.mint.value.data.parsed.info.isInitialized = false;
    },
    (data) => {
      data.accounts.value[0].account.owner = SPL_TOKEN_2022_PROGRAM;
    },
    (data) => {
      data.accounts.value[0].account.data.parsed.info.owner = solana.tokenAddress;
    },
    (data) => {
      data.accounts.value[0].account.data.parsed.info.mint = solana.ownerAddress;
    },
    (data) => {
      data.accounts.value[0].account.data.parsed.info.tokenAmount.decimals = 8;
    },
    (data) => {
      data.accounts.value[0].account.data.parsed.info.tokenAmount.amount = "18446744073709551616";
    },
    (data) => {
      data.accounts.value[0].account.data.parsed.info.tokenAmount.amount = "-1";
    },
    (data) => {
      data.accounts.value[1].pubkey = data.accounts.value[0].pubkey;
    },
  ];
  for (const mutate of mutations) {
    const data = splFixture();
    mutate(data);
    const result = await fixture(data.answer).client.readTokenBalance(solana);
    assert.equal(result.status, "unsupported");
    assert.equal("amount" in result, false);
  }
  for (const result of [
    null,
    { value: null },
    { value: { owner: SPL_TOKEN_PROGRAM, executable: false, data: ["base64", "base64"] } },
  ]) {
    const data = splFixture();
    const read = await fixture((request) =>
      request.method === "getAccountInfo" ? result : data.accounts,
    ).client.readTokenBalance(solana);
    assert.equal(read.status, "unsupported");
  }
});

test("RPC HTTP, protocol, JSON, oversized and provider errors are unavailable, never zero", async () => {
  const responses = [
    () => new Response("blocked", { status: 429 }),
    () => Response.json({ jsonrpc: "2.0", id: 999, result: word(0) }),
    () =>
      Response.json({ jsonrpc: "2.0", id: 1, error: { message: "do not surface provider text" } }),
    () => new Response("not json"),
    () => new Response("{}", { headers: { "content-length": "999999999" } }),
    () => new Response(" ".repeat(2 * 1024 * 1024 + 1)),
    () => {
      throw new Error("connection failed secret URL");
    },
  ];
  for (const respond of responses) {
    const client = createTokenBalanceClient({ fetch: async () => respond() });
    const result = await client.readTokenBalance(ethereum);
    assert.equal(result.status, "unavailable");
    assert.equal("amount" in result, false);
    assert.doesNotMatch(result.message, /secret|provider text/);
  }
});

test("invalid checksum or pre-aborted signal makes no provider requests", async () => {
  const { client, calls } = fixture(ethAnswer());
  const invalid = await client.readTokenBalance({
    ...ethereum,
    tokenAddress: "0x52908400098527886E0F7030069857D2E4169Ee7",
  });
  assert.equal(invalid.status, "unsupported");
  const controller = new AbortController();
  controller.abort();
  assert.equal((await client.readTokenBalance(ethereum, controller.signal)).status, "unavailable");
  assert.equal(calls.length, 0);
});

test("in-flight abort is passed to each provider read and returns no fabricated balance", async () => {
  const controller = new AbortController();
  let started = 0;
  const client = createTokenBalanceClient({
    fetch: async (_url, init) => {
      started++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    },
  });
  const pending = client.readTokenBalance(ethereum, controller.signal);
  assert.equal(started, 3);
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "unavailable");
  assert.equal("amount" in result, false);
});

test("aborting during optional ERC20 metadata does not turn cancellation into a ready balance", async () => {
  const controller = new AbortController();
  let started = 0;
  let metadataReady!: () => void;
  const metadataStarted = new Promise<void>((resolve) => {
    metadataReady = resolve;
  });
  const client = createTokenBalanceClient({
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as Request;
      const data = (request.params[0] as { data?: string } | undefined)?.data;
      if (data === "0x95d89b41" || data === "0x06fdde03") {
        if (++started === 2) metadataReady();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result: ethAnswer()(request) });
    },
  });
  const pending = client.readTokenBalance(ethereum, controller.signal);
  await metadataStarted;
  controller.abort();
  assert.equal((await pending).status, "unavailable");
});
