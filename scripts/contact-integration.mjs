/** Real local HTTP checks for creator policies and private messages.
 * Usage: node scripts/contact-integration.mjs [http://127.0.0.1:8080]
 * Creates disposable local accounts. Does not initiate payments or print credentials.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:8080").origin;
const suffix = randomBytes(8).toString("hex");
const handle = `inbox-${suffix}`;
let checks = 0;
function check(value, description) {
  assert.ok(value, description);
  checks += 1;
}
function client() {
  const cookies = new Map();
  const ip = `198.51.100.${1 + (randomBytes(1)[0] % 254)}`;
  async function request(path, { method = "GET", json, body, headers = {} } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        origin,
        "x-forwarded-for": ip,
        ...(json === undefined && body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookies.size
          ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") }
          : {}),
        ...headers,
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : body !== undefined ? { body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0],
        separator = pair.indexOf("=");
      const key = pair.slice(0, separator),
        value = pair.slice(separator + 1);
      if (!value || /max-age=0(?:;|$)/i.test(line)) cookies.delete(key);
      else cookies.set(key, value);
    }
    const data = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, headers: response.headers, data };
  }
  return { request };
}
async function account(label) {
  const user = client();
  const unique = randomBytes(8).toString("hex");
  const email = `contact-${unique}@example.com`;
  const password = `🔐 ${randomBytes(24).toString("base64")} /# +`;
  const result = await user.request("/api/auth/sign-up/email", {
    method: "POST",
    json: { email, password, name: label, username: `contact @ ${unique}` },
  });
  check(result.ok && result.data?.user?.id, `${label} has a real authenticated account`);
  return { ...user, id: result.data.user.id, email, password, label };
}
const settings = {
  dmMode: "free",
  dmEthPrice: "",
  dmUsdPrice: "",
  donationNotesEnabled: true,
  minimumDonationEth: "0.000001",
  minimumDonationUsd: "1.00",
  ethDonationAddressId: "eth-wallet",
};
const profile = {
  version: 1,
  displayName: "Creator integration 🌙",
  bio: "Private messaging checks.",
  links: [{ id: "work", label: "Public work", url: "https://example.org/work" }],
  wishlist: [],
  serviceLinks: { allmylinks: "", throne: "", nowpayments: "", bluesky: "" },
  donations: {
    bankLink: "",
    crypto: [
      {
        id: "eth-wallet",
        chain: "ethereum",
        address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        label: "ETH receiving wallet",
      },
    ],
  },
};
const guest = client();
const accounts = [];
let owner;
try {
  const guestInbox = await guest.request("/api/inbox");
  check(guestInbox.status === 401, "Guests cannot read private inboxes");
  check(
    /no-store/.test(guestInbox.headers.get("cache-control")),
    "Private inbox failures cannot be cached",
  );
  check(
    (await guest.request("/api/profile/contact")).status === 401,
    "Guests cannot read private contact settings",
  );
  owner = await account("Creator owner");
  accounts.push(owner);
  const sender = await account("Sender member 🪐");
  accounts.push(sender);
  const stranger = await account("Unrelated member");
  accounts.push(stranger);
  const published = await owner.request("/api/profile/publication", {
    method: "PUT",
    json: { handle, profile },
  });
  check(published.ok, "Creator publishes the receiving profile before enabling contact");
  const initial = await owner.request("/api/profile/contact");
  check(
    initial.ok && initial.data?.settings?.dmMode === "closed",
    "New creators begin with closed DMs",
  );
  check(
    initial.data.ethereumAddresses.some((item) => item.id === "eth-wallet"),
    "Receiving-wallet choices come from the published profile",
  );
  const unavailable = await guest.request("/api/creators/missing-contact-creator/contact");
  check(unavailable.status === 404, "Unknown creator contact policies are not exposed");
  const route = `/api/creators/${handle}/messages`;
  const dm = (text) => ({ kind: "dm", anonymous: false, text });
  const closed = await sender.request(route, { method: "POST", json: dm("Closed test") });
  check(closed.status === 403, "Closed creators reject new DMs");
  const badOrigin = await owner.request("/api/profile/contact", {
    method: "PUT",
    json: { settings },
    headers: { origin: "https://evil.example.org" },
  });
  check(badOrigin.status === 403, "Settings changes require the configured app origin");
  const forgedWallet = await owner.request("/api/profile/contact", {
    method: "PUT",
    json: { settings: { ...settings, ethDonationAddressId: "not-published" } },
  });
  check(forgedWallet.status === 400, "A creator cannot select an unpublished receiving wallet");
  const save = await owner.request("/api/profile/contact", { method: "PUT", json: { settings } });
  check(
    save.ok && save.data?.settings?.dmMode === "free",
    "Creator can enable free account DMs with a published wallet",
  );
  const publicConfig = await guest.request(`/api/creators/${handle}/contact`);
  check(
    publicConfig.ok && publicConfig.data?.handle === handle,
    "Anonymous visitors can read public contact availability",
  );
  check(
    /no-store/.test(publicConfig.headers.get("cache-control")),
    "Public contact policy is not stale-cached",
  );
  const configurationText = JSON.stringify(publicConfig.data);
  check(
    !configurationText.includes(owner.id) &&
      !configurationText.includes(owner.email) &&
      !configurationText.includes(owner.password),
    "Public contact configuration never exposes owner identity or credentials",
  );
  const guestDm = await guest.request(route, { method: "POST", json: dm("Guest message") });
  check(guestDm.status === 401, "DMs require an authenticated sender");
  const anonymousDm = await sender.request(route, {
    method: "POST",
    json: { kind: "dm", text: "Anonymous DM", anonymous: true },
  });
  check(anonymousDm.status === 400, "An account cannot bypass DM identity by claiming anonymity");
  const anonymousNote = await guest.request(route, {
    method: "POST",
    json: { kind: "donation", text: "No payment was made", anonymous: true },
  });
  check(
    anonymousNote.status === 402 && anonymousNote.data?.paymentRequired === true,
    "Anonymous donation notes require verified payment",
  );
  const accountNote = await sender.request(route, {
    method: "POST",
    json: { kind: "donation", text: "Still not paid", anonymous: false },
  });
  check(
    accountNote.status === 402,
    "An authenticated donation note cannot impersonate a paid donation",
  );
  const forgedIdentity = await sender.request(route, {
    method: "POST",
    json: { ...dm("Forged sender"), senderId: owner.id, paymentStatus: "paid" },
  });
  check(forgedIdentity.status === 400, "Clients cannot provide a sender ID or paid status");
  check(
    (await sender.request(route, { method: "POST", json: dm("   ") })).status === 400,
    "Empty messages are rejected before storage",
  );
  check(
    (await sender.request(route, { method: "POST", json: dm("x".repeat(2001)) })).status === 400,
    "Oversized message text is rejected",
  );
  const text = "Hello creator 🌙\n<script>literal text only</script>";
  const sent = await sender.request(route, { method: "POST", json: dm(text) });
  check(
    sent.status === 201 && sent.data?.message?.id,
    "A signed-in sender can send a free private DM",
  );
  const messageId = sent.data.message.id;
  check(
    sent.data.message.senderName === sender.label && sent.data.message.paymentStatus === "free",
    "Message identity and free status are derived by the server",
  );
  check(
    sent.data.message.direction === "sent" && sent.data.message.text === text,
    "Sender receipt preserves Unicode and literal text",
  );
  const leakedReceipt = JSON.stringify(sent.data);
  check(
    !leakedReceipt.includes(sender.email) &&
      !leakedReceipt.includes(sender.id) &&
      !leakedReceipt.includes(owner.id),
    "Message DTO omits participant emails and internal account IDs",
  );
  const received = await owner.request("/api/inbox?folder=received");
  check(
    received.ok &&
      received.data.messages.length === 1 &&
      received.data.messages[0].id === messageId,
    "Only the recipient receives the new message",
  );
  check(
    received.data.messages[0].direction === "received" && received.data.messages[0].readAt === null,
    "Incoming messages begin unread",
  );
  const sentFolder = await sender.request("/api/inbox?folder=sent");
  check(
    sentFolder.data?.messages?.some((message) => message.id === messageId),
    "The sender sees their own outbox copy",
  );
  const donationFolder = await owner.request("/api/inbox?folder=donations");
  check(
    donationFolder.ok && donationFolder.data.messages.length === 0,
    "Unpaid donation notes never appear in the creator inbox",
  );
  check(
    (await stranger.request("/api/inbox")).data?.messages?.length === 0,
    "An unrelated account sees an empty inbox",
  );
  const privateThread = `/api/inbox/${messageId}`;
  check(
    (await stranger.request(privateThread)).status === 404,
    "An unrelated account cannot read a known message ID",
  );
  check(
    (
      await stranger.request(`${privateThread}/replies`, {
        method: "POST",
        json: { text: "Unauthorized reply" },
      })
    ).status === 404,
    "An unrelated account cannot append replies",
  );
  const read = await owner.request(privateThread);
  check(read.ok && read.data?.message?.readAt, "Reading the recipient thread records read status");
  const markRead = await sender.request(privateThread, { method: "PATCH", json: { read: true } });
  check(markRead.status === 404, "A sender cannot mark the recipient copy as read");
  const crossOriginReply = await owner.request(`${privateThread}/replies`, {
    method: "POST",
    json: { text: "Forged origin" },
    headers: { origin: "https://evil.example.org" },
  });
  check(crossOriginReply.status === 403, "Reply mutations reject a foreign origin");
  const reply = await owner.request(`${privateThread}/replies`, {
    method: "POST",
    json: { text: "Thanks for your message 🌟" },
  });
  check(
    reply.status === 201 && reply.data.replies[0]?.fromCreator === true,
    "Creators can reply privately without charging themselves",
  );
  const followup = await sender.request(`${privateThread}/replies`, {
    method: "POST",
    json: { text: "A free follow-up" },
  });
  check(
    followup.status === 201 && followup.data.replies.at(-1)?.fromCreator === false,
    "Sender follow-ups work while the policy remains free",
  );
  const paidSettings = { ...settings, dmMode: "paid", dmEthPrice: "0.001", dmUsdPrice: "5.00" };
  check(
    (
      await owner.request("/api/profile/contact", {
        method: "PUT",
        json: { settings: paidSettings },
      })
    ).ok,
    "Creator can enable explicit prices for both paid-DM methods",
  );
  const countBefore = (await owner.request("/api/inbox")).data.messages.length;
  const unpaidDm = await sender.request(route, {
    method: "POST",
    json: dm("Unpaid paid-mode message"),
  });
  check(
    unpaidDm.status === 402 && unpaidDm.data?.paymentRequired,
    "Paid DMs cannot be delivered through the free-message endpoint",
  );
  const unpaidFollowup = await sender.request(`${privateThread}/replies`, {
    method: "POST",
    json: { text: "Trying the old thread" },
  });
  check(
    unpaidFollowup.status === 402,
    "An older free thread cannot bypass the new paid-message policy",
  );
  const ownerPaidReply = await owner.request(`${privateThread}/replies`, {
    method: "POST",
    json: { text: "Creator reply remains free" },
  });
  check(
    ownerPaidReply.status === 201 && ownerPaidReply.data.replies.at(-1)?.fromCreator,
    "Creator replies remain available when incoming messages become paid",
  );
  check(
    (await owner.request("/api/inbox")).data.messages.length === countBefore,
    "Rejected paid messages do not create delivered inbox entries",
  );
  check(
    (await owner.request("/api/inbox?folder=unexpected")).status === 400,
    "Unknown inbox folders are rejected",
  );
  const disabledNotes = { ...paidSettings, donationNotesEnabled: false };
  check(
    (
      await owner.request("/api/profile/contact", {
        method: "PUT",
        json: { settings: disabledNotes },
      })
    ).ok,
    "Creators can disable donation-note submissions",
  );
  check(
    (
      await guest.request(route, {
        method: "POST",
        json: { kind: "donation", anonymous: true, text: "Disabled note" },
      })
    ).status === 403,
    "Disabled donation notes reject new submissions before payment preparation",
  );
  await owner.request("/api/profile/publication", { method: "DELETE" });
  check(
    (await guest.request(`/api/creators/${handle}/contact`)).status === 404,
    "Unpublishing removes public contact availability",
  );
  check(
    (await sender.request(privateThread)).ok,
    "Existing participant conversations remain accessible after unpublishing",
  );
  await sender.request("/api/auth/sign-out", { method: "POST", json: {} });
  check(
    (await sender.request(privateThread)).status === 401,
    "Signing out revokes access to private conversations",
  );
} finally {
  if (owner)
    await owner.request("/api/profile/publication", { method: "DELETE" }).catch(() => undefined);
  for (const user of accounts)
    await user.request("/api/auth/sign-out", { method: "POST", json: {} }).catch(() => undefined);
}
console.log(
  `Contact integration passed: ${checks} checks (real local accounts; no payment or blockchain requests).`,
);
