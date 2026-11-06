import type { CreatorProfile } from "./creator-profile.js";

export type DmMode = "closed" | "free" | "paid";
export type ContactKind = "dm" | "donation";
export type ContactPaymentStatus = "free" | "unverified" | "pending" | "paid";
export type ContactSettings = {
  dmMode: DmMode;
  dmEthPrice: string;
  dmUsdPrice: string;
  donationNotesEnabled: boolean;
  minimumDonationEth: string;
  minimumDonationUsd: string;
  ethDonationAddressId: string | null;
};
export const DEFAULT_CONTACT_SETTINGS: Readonly<ContactSettings> = Object.freeze({
  dmMode: "closed",
  dmEthPrice: "",
  dmUsdPrice: "",
  donationNotesEnabled: true,
  minimumDonationEth: "0.000001",
  minimumDonationUsd: "1.00",
  ethDonationAddressId: null,
});
export type EthereumContactAddress = { id: string; address: string; label: string };
/** Server-only recipient resolution. Never serialize this object to public responses. */
export type ContactRecipient = {
  recipientUserId: string;
  handle: string;
  displayName: string;
  profile: CreatorProfile;
  settings: ContactSettings;
  ethereumAddresses: EthereumContactAddress[];
  ethereumAddress: string | null;
};
export type ContactConfiguration = {
  handle: string | null;
  settings: ContactSettings;
  ethereumAddresses: EthereumContactAddress[];
  nowpaymentsConfigured: boolean;
};
export type PublicContactConfiguration = ContactConfiguration & { handle: string };
export type ContactMessage = {
  id: string;
  kind: ContactKind;
  text: string;
  anonymous: boolean;
  senderName: string;
  recipientHandle: string;
  createdAt: string;
  paymentStatus: ContactPaymentStatus;
  direction: "received" | "sent";
  readAt: string | null;
  /** Viewer-specific activity metadata; optional for older cached responses. */
  lastActivityAt?: string;
  unread?: boolean;
  latestReply?: ContactReply | null;
  paymentId?: string | null;
};
export type ContactReply = { id: string; text: string; createdAt: string; fromCreator: boolean };
export type ContactThread = { message: ContactMessage; replies: ContactReply[] };
export type InboxFolder = "received" | "sent" | "donations";
export type InboxUnreadCounts = { received: number; sent: number; donations: number };
export type InboxResponse = {
  messages: ContactMessage[];
  nextCursor: string | null;
  unreadCounts?: InboxUnreadCounts;
};

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}
/** Decimal amounts stay exact. Empty strings represent a disabled payment method. */
export function exactContactAmount(value: unknown, decimals: number, optional = false): string {
  if (typeof value !== "string") throw new Error("Payment amounts must be decimal text.");
  const source = value.trim();
  if (optional && source === "") return "";
  if (!new RegExp(`^(?:0|[1-9][0-9]{0,8})(?:\\.[0-9]{1,${decimals}})?$`).test(source))
    throw new Error(`Use a positive decimal amount with at most ${decimals} decimal places.`);
  const [whole, fraction = ""] = source.split(".");
  if (BigInt(whole + fraction.padEnd(decimals, "0")) <= 0n)
    throw new Error("Payment amounts must be greater than zero.");
  return source;
}
export function contactAmountUnits(value: string, decimals: number): bigint {
  const source = exactContactAmount(value, decimals);
  const [whole, fraction = ""] = source.split(".");
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}
export function validateContactSettings(value: unknown): ContactSettings {
  const row = object(value, "Contact settings");
  const keys = Object.keys(DEFAULT_CONTACT_SETTINGS);
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    throw new Error("Send only the supported contact settings.");
  if (!["closed", "free", "paid"].includes(row.dmMode as string))
    throw new Error("Choose closed, free, or paid DMs.");
  if (typeof row.donationNotesEnabled !== "boolean")
    throw new Error("Donation-note availability must be true or false.");
  if (
    row.ethDonationAddressId !== null &&
    (typeof row.ethDonationAddressId !== "string" ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(row.ethDonationAddressId))
  )
    throw new Error("Choose an Ethereum address from your published profile.");
  const settings: ContactSettings = {
    dmMode: row.dmMode as DmMode,
    dmEthPrice: exactContactAmount(row.dmEthPrice, 18, true),
    dmUsdPrice: exactContactAmount(row.dmUsdPrice, 2, true),
    donationNotesEnabled: row.donationNotesEnabled,
    minimumDonationEth: exactContactAmount(row.minimumDonationEth, 18),
    minimumDonationUsd: exactContactAmount(row.minimumDonationUsd, 2),
    ethDonationAddressId: row.ethDonationAddressId as string | null,
  };
  if (settings.dmMode === "paid" && !settings.dmEthPrice && !settings.dmUsdPrice)
    throw new Error("Set a price for at least one paid-DM method.");
  if (settings.dmMode === "paid" && settings.dmEthPrice && !settings.ethDonationAddressId)
    throw new Error("Choose a published Ethereum receiving address for paid ETH messages.");
  return settings;
}
export function validateContactText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 4_000 ||
    [...value].length > 2_000 ||
    new TextEncoder().encode(value).byteLength > 8_000
  )
    throw new Error("Messages must contain 1–2000 characters and be at most 8 KB.");
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (
    !text ||
    // eslint-disable-next-line no-control-regex -- Reject hidden controls while retaining message line breaks and tabs.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(text) ||
    [...text].some((character) => character.length === 1 && /[\ud800-\udfff]/u.test(character))
  )
    throw new Error("Messages cannot be empty or contain unsupported control characters.");
  return text;
}
export function validateContactMessageInput(value: unknown): {
  kind: ContactKind;
  text: string;
  anonymous: boolean;
} {
  const row = object(value, "Message");
  if (
    Object.keys(row).length !== 3 ||
    !Object.hasOwn(row, "kind") ||
    !Object.hasOwn(row, "text") ||
    !Object.hasOwn(row, "anonymous")
  )
    throw new Error("Send only kind, text, and anonymous.");
  if (row.kind !== "dm" && row.kind !== "donation")
    throw new Error("Choose a direct message or donation note.");
  if (typeof row.anonymous !== "boolean" || (row.kind === "dm" && row.anonymous))
    throw new Error("Direct messages require an account identity.");
  return { kind: row.kind, text: validateContactText(row.text), anonymous: row.anonymous };
}
export function validateContactConfiguration(value: unknown): ContactConfiguration {
  const row = object(value, "Contact configuration");
  if (
    row.handle !== null &&
    (typeof row.handle !== "string" || !/^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/.test(row.handle))
  )
    throw new Error("Invalid contact handle.");
  if (
    typeof row.nowpaymentsConfigured !== "boolean" ||
    !Array.isArray(row.ethereumAddresses) ||
    row.ethereumAddresses.length > 10
  )
    throw new Error("Invalid contact payment options.");
  return {
    handle: row.handle as string | null,
    settings: validateContactSettings(row.settings),
    nowpaymentsConfigured: row.nowpaymentsConfigured,
    ethereumAddresses: row.ethereumAddresses.map((value) => {
      const address = object(value, "Ethereum address");
      if (
        typeof address.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(address.id) ||
        typeof address.address !== "string" ||
        !/^0x[0-9a-fA-F]{40}$/.test(address.address) ||
        typeof address.label !== "string" ||
        address.label.length > 160
      )
        throw new Error("Invalid Ethereum contact address.");
      return { id: address.id, address: address.address, label: address.label };
    }),
  };
}
