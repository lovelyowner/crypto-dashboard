import { randomUUID } from "node:crypto";
import { validateCreatorProfile } from "./creator-profile";
import type { Sql } from "./db";
import {
  DEFAULT_CONTACT_SETTINGS,
  validateContactSettings,
  validateContactText,
  type ContactSettings,
  type ContactRecipient,
  type ContactMessage,
  type ContactReply,
  type ContactThread,
  type ContactKind,
  type ContactPaymentStatus,
  type InboxFolder,
} from "./creator-contact";

export type StoredContactMessage = {
  id: string;
  recipientId: string;
  recipientHandle: string;
  senderId: string | null;
  senderName: string;
  anonymous: boolean;
  kind: ContactKind;
  text: string;
  paymentStatus: ContactPaymentStatus;
  paymentId: string | null;
  createdAt: Date | string;
  readAt: Date | string | null;
};
export type PendingMessageInput = {
  id: string;
  paymentId: string;
  recipientId: string;
  senderId: string | null;
  senderName: string;
  anonymous: boolean;
  kind: ContactKind;
  text: string;
};
export type FreeMessageInput = Omit<PendingMessageInput, "id" | "paymentId">;
export interface ContactStore {
  resolveRecipient(handle: string): Promise<ContactRecipient | null>;
  readConfiguration(
    userId: string,
  ): Promise<{
    handle: string | null;
    settings: ContactSettings;
    ethereumAddresses: ContactRecipient["ethereumAddresses"];
  }>;
  saveSettings(userId: string, settings: ContactSettings): Promise<void>;
  consumeRate(key: string, limit: number, now: number): Promise<boolean>;
  createFreeMessage(input: FreeMessageInput): Promise<StoredContactMessage | null>;
  createPendingMessage(input: PendingMessageInput): Promise<StoredContactMessage>;
  completePendingMessage(messageId: string, paymentId: string): Promise<boolean>;
  readInternalMessage(id: string): Promise<StoredContactMessage | null>;
  listMessages(
    userId: string,
    folder: InboxFolder,
    cursor: string | null,
  ): Promise<{ messages: StoredContactMessage[]; nextCursor: string | null }>;
  readThread(
    userId: string,
    id: string,
    markRead?: boolean,
  ): Promise<{ message: StoredContactMessage; replies: ContactReply[] } | null>;
  reply(userId: string, id: string, text: string): Promise<boolean>;
  markRead(userId: string, id: string): Promise<boolean>;
}
const messageColumns = `id, recipient_id as "recipientId", recipient_handle as "recipientHandle",
 sender_id as "senderId", sender_name as "senderName", anonymous, kind, body as text,
 payment_status as "paymentStatus", payment_id as "paymentId", created_at as "createdAt",
 recipient_read_at as "readAt"`;
const iso = (value: Date | string) => new Date(value).toISOString();
export function contactMessageDto(row: StoredContactMessage, viewerId: string): ContactMessage {
  const direction = row.recipientId === viewerId ? "received" : "sent";
  return {
    id: row.id,
    kind: row.kind,
    text: validateContactText(row.text),
    anonymous: row.anonymous,
    senderName: row.anonymous ? "Anonymous" : row.senderName,
    recipientHandle: row.recipientHandle,
    createdAt: iso(row.createdAt),
    paymentStatus: row.paymentStatus,
    direction,
    readAt: row.readAt ? iso(row.readAt) : null,
    ...(direction === "sent" && row.paymentStatus === "pending"
      ? { paymentId: row.paymentId }
      : {}),
  };
}
export function contactThreadDto(
  thread: { message: StoredContactMessage; replies: ContactReply[] },
  userId: string,
): ContactThread {
  return { message: contactMessageDto(thread.message, userId), replies: thread.replies };
}
function settingsOf(value: unknown): ContactSettings {
  return value === null || value === undefined
    ? { ...DEFAULT_CONTACT_SETTINGS }
    : validateContactSettings(value);
}
export function createSqlContactStore(sql: Pick<Sql, "query">): ContactStore {
  const readConfiguration: ContactStore["readConfiguration"] = async (userId) => {
    const rows = await sql.query<{
      handle: string | null;
      profile: unknown;
      published: boolean | null;
      settings: unknown;
    }>(
      `select p.handle, p.profile, p.published, c.settings from "user" u
       left join public_creator_profiles p on p.user_id=u.id
       left join creator_contact_settings c on c.user_id=u.id where u.id=$1`,
      [userId],
    );
    const row = rows[0];
    if (!row) throw new Error("Account not found");
    const profile = row.published ? validateCreatorProfile(row.profile) : null;
    return {
      handle: row.handle ?? null,
      settings: settingsOf(row.settings),
      ethereumAddresses:
        profile?.donations.crypto
          .filter((a) => a.chain === "ethereum")
          .map(({ id, address, label }) => ({ id, address, label })) ?? [],
    };
  };
  const readInternalMessage = async (id: string) =>
    (
      await sql.query<StoredContactMessage>(
        `select ${messageColumns} from creator_messages where id=$1`,
        [id],
      )
    )[0] ?? null;
  return {
    readConfiguration,
    async resolveRecipient(handle) {
      const rows = await sql.query<{
        recipientUserId: string;
        handle: string;
        profile: unknown;
        settings: unknown;
      }>(
        `select p.user_id as "recipientUserId",p.handle,p.profile,c.settings from public_creator_profiles p
         left join creator_contact_settings c on c.user_id=p.user_id where p.handle=$1 and p.published=true`,
        [handle],
      );
      const row = rows[0];
      if (!row) return null;
      const profile = validateCreatorProfile(row.profile),
        settings = settingsOf(row.settings);
      const ethereumAddresses = profile.donations.crypto
        .filter((a) => a.chain === "ethereum")
        .map(({ id, address, label }) => ({ id, address, label }));
      return {
        recipientUserId: row.recipientUserId,
        handle: row.handle,
        displayName: profile.displayName,
        profile,
        settings,
        ethereumAddresses,
        ethereumAddress:
          ethereumAddresses.find((a) => a.id === settings.ethDonationAddressId)?.address ?? null,
      };
    },
    async saveSettings(userId, settings) {
      await sql.query(
        `insert into creator_contact_settings(user_id,settings) values($1,$2::jsonb)
        on conflict(user_id) do update set settings=excluded.settings,updated_at=now()`,
        [userId, JSON.stringify(validateContactSettings(settings))],
      );
    },
    async consumeRate(key, limit, now) {
      const rows = await sql.query(
        `insert into creator_contact_rate_limits(key,count,window_started) values($1,1,$2::timestamptz)
        on conflict(key) do update set
        count=case when creator_contact_rate_limits.window_started < $3::timestamptz then 1 else creator_contact_rate_limits.count+1 end,
        window_started=case when creator_contact_rate_limits.window_started < $3::timestamptz then excluded.window_started else creator_contact_rate_limits.window_started end
        where creator_contact_rate_limits.window_started < $3::timestamptz or creator_contact_rate_limits.count < $4 returning key`,
        [key, new Date(now).toISOString(), new Date(now - 60_000).toISOString(), limit],
      );
      return rows.length === 1;
    },
    async createFreeMessage(input) {
      if (input.kind !== "dm" || input.anonymous || !input.senderId) return null;
      const rows = await sql.query<StoredContactMessage>(
        `insert into creator_messages(id,recipient_id,recipient_handle,sender_id,sender_name,anonymous,kind,body,payment_status)
       select $1,p.user_id,p.handle,$3,$4,false,'dm',$5,'free' from public_creator_profiles p
       join creator_contact_settings c on c.user_id=p.user_id
       where p.user_id=$2 and p.published=true and c.settings->>'dmMode'='free'
       returning ${messageColumns}`,
        [
          randomUUID(),
          input.recipientId,
          input.senderId,
          input.senderName,
          validateContactText(input.text),
        ],
      );
      return rows[0] ?? null;
    },
    async createPendingMessage(input) {
      if (
        (input.anonymous && input.senderId !== null) ||
        (input.kind === "dm" && (input.anonymous || !input.senderId))
      )
        throw new Error("Invalid pending sender");
      const rows = await sql.query<StoredContactMessage>(
        `insert into creator_messages(id,recipient_id,recipient_handle,sender_id,sender_name,anonymous,kind,body,payment_status,payment_id)
        select $1,p.user_id,p.handle,$3,$4,$5,$6,$7,'pending',$8 from public_creator_profiles p where p.user_id=$2
        returning ${messageColumns}`,
        [
          input.id,
          input.recipientId,
          input.anonymous ? null : input.senderId,
          input.anonymous ? "Anonymous" : input.senderName,
          input.anonymous,
          input.kind,
          validateContactText(input.text),
          input.paymentId,
        ],
      );
      if (!rows[0]) throw new Error("Recipient not found");
      return rows[0];
    },
    async completePendingMessage(id, paymentId) {
      const rows = await sql.query(
        `update creator_messages set payment_status='paid' where id=$1 and payment_id=$2 and payment_status='pending' returning id`,
        [id, paymentId],
      );
      if (rows.length) return true;
      const row = await readInternalMessage(id);
      return row?.paymentId === paymentId && row.paymentStatus === "paid";
    },
    readInternalMessage,
    async listMessages(userId, folder, cursor) {
      const scope =
        folder === "sent"
          ? `sender_id=$1`
          : `recipient_id=$1 and payment_status<>'pending' and kind='${folder === "donations" ? "donation" : "dm"}'`;
      const rows = await sql.query<StoredContactMessage>(
        `select ${messageColumns} from creator_messages
        where ${scope} and ($2::text is null or (created_at,id)<(select created_at,id from creator_messages where id=$2 and ${scope}))
        order by created_at desc,id desc limit 51`,
        [userId, cursor],
      );
      return { messages: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49].id : null };
    },
    async readThread(userId, id, markRead = true) {
      if (markRead)
        await sql.query(
          `update creator_messages set recipient_read_at=coalesce(recipient_read_at,now()) where id=$1 and recipient_id=$2 and payment_status<>'pending'`,
          [id, userId],
        );
      const rows = await sql.query<StoredContactMessage>(
        `select ${messageColumns} from creator_messages where id=$1 and (sender_id=$2 or (recipient_id=$2 and payment_status<>'pending'))`,
        [id, userId],
      );
      if (!rows[0]) return null;
      const replies = await sql.query<{
        id: string;
        text: string;
        createdAt: Date | string;
        fromCreator: boolean;
      }>(
        `select r.id,r.body as text,r.created_at as "createdAt",r.author_id=m.recipient_id as "fromCreator" from creator_message_replies r join creator_messages m on m.id=r.message_id where r.message_id=$1 order by r.created_at,r.id limit 200`,
        [id],
      );
      return {
        message: rows[0],
        replies: replies.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
      };
    },
    async reply(userId, id, text) {
      const rows = await sql.query(
        `insert into creator_message_replies(id,message_id,author_id,body)
        select $1,m.id,$3,$4 from creator_messages m left join creator_contact_settings c on c.user_id=m.recipient_id
        where m.id=$2 and m.sender_id is not null and m.payment_status<>'pending'
        and (m.recipient_id=$3 or (m.sender_id=$3 and c.settings->>'dmMode'='free'))
        and (select count(*) from creator_message_replies r where r.message_id=m.id)<200 returning id`,
        [randomUUID(), id, userId, validateContactText(text)],
      );
      return rows.length === 1;
    },
    async markRead(userId, id) {
      return (
        (
          await sql.query(
            `update creator_messages set recipient_read_at=coalesce(recipient_read_at,now()) where id=$1 and recipient_id=$2 and payment_status<>'pending' returning id`,
            [id, userId],
          )
        ).length === 1
      );
    },
  };
}
