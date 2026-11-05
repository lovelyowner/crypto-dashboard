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
  type InboxUnreadCounts,
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
  senderReadAt?: Date | string | null;
  lastActivityAt?: Date | string;
  activityRevision?: number;
  recipientReadRevision?: number;
  senderReadRevision?: number;
  latestReply?: ContactReply | null;
  cursorActivityAt?: string;
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
  /** Server-session identity only; never included in anonymous contact DTOs. */
  moderationActorId?: string | null;
};
export type FreeMessageInput = Omit<PendingMessageInput, "id" | "paymentId">;
export interface ContactStore {
  contactAllowed?(senderId: string, recipientId: string): Promise<boolean>;
  resolveRecipient(handle: string): Promise<ContactRecipient | null>;
  readConfiguration(userId: string): Promise<{
    handle: string | null;
    settings: ContactSettings;
    ethereumAddresses: ContactRecipient["ethereumAddresses"];
  }>;
  saveSettings(userId: string, settings: ContactSettings): Promise<void>;
  consumeRate(key: string, limit: number, now: number): Promise<boolean>;
  createFreeMessage(input: FreeMessageInput): Promise<StoredContactMessage | null>;
  createPendingMessage(input: PendingMessageInput): Promise<StoredContactMessage>;
  discardPendingMessage?(messageId: string, paymentId: string): Promise<void>;
  completePendingMessage(messageId: string, paymentId: string): Promise<boolean>;
  readInternalMessage(id: string): Promise<StoredContactMessage | null>;
  listMessages(
    userId: string,
    folder: InboxFolder,
    cursor: string | null,
  ): Promise<{
    messages: StoredContactMessage[];
    nextCursor: string | null;
    unreadCounts?: InboxUnreadCounts;
  }>;
  unreadCounts?(userId: string): Promise<InboxUnreadCounts>;
  readThread(
    userId: string,
    id: string,
    markRead?: boolean,
  ): Promise<{ message: StoredContactMessage; replies: ContactReply[] } | null>;
  reply(userId: string, id: string, text: string): Promise<boolean>;
  markRead(userId: string, id: string, revision?: number): Promise<boolean>;
}
const messageColumns = `id, recipient_id as "recipientId", recipient_handle as "recipientHandle",
 sender_id as "senderId", sender_name as "senderName", anonymous, kind, body as text,
 payment_status as "paymentStatus", payment_id as "paymentId", created_at as "createdAt",
 recipient_read_at as "readAt", sender_read_at as "senderReadAt",
 last_activity_at as "lastActivityAt", activity_revision as "activityRevision",
 recipient_read_revision as "recipientReadRevision", sender_read_revision as "senderReadRevision"`;
const latestReplyColumns = `(select json_build_object('id',r.id,'text',r.body,'createdAt',r.created_at,
 'fromCreator',r.author_id=creator_messages.recipient_id) from creator_message_replies r
 where r.message_id=creator_messages.id order by r.activity_revision desc limit 1) as "latestReply"`;
const unreadCountsQuery = `select
 count(*) filter(where recipient_id=$1 and kind='dm' and payment_status<>'pending' and recipient_read_revision<activity_revision)::integer as received,
 count(*) filter(where sender_id=$1 and payment_status<>'pending' and sender_read_revision<activity_revision)::integer as sent,
 count(*) filter(where recipient_id=$1 and kind='donation' and payment_status<>'pending' and recipient_read_revision<activity_revision)::integer as donations
 from creator_messages where recipient_id=$1 or sender_id=$1`;
const iso = (value: Date | string) => new Date(value).toISOString();
type ActivityCursor = { id: string; at: string | null };
function activityCursor(value: string): ActivityCursor {
  if (!value.startsWith("v1_")) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error("Invalid inbox cursor");
    return { id: value, at: null };
  }
  const encoded = value.slice(3);
  if (!/^[A-Za-z0-9_-]{1,509}$/.test(encoded)) throw new Error("Invalid inbox cursor");
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) throw new Error("Invalid inbox cursor");
  const parts: unknown = JSON.parse(decoded.toString("utf8"));
  if (
    !Array.isArray(parts) ||
    parts.length !== 2 ||
    typeof parts[0] !== "string" ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(parts[0]) ||
    parts[0].startsWith("0000-") ||
    !Number.isFinite(Date.parse(parts[0])) ||
    new Date(parts[0]).toISOString() !== `${parts[0].slice(0, 23)}Z` ||
    typeof parts[1] !== "string" ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(parts[1])
  )
    throw new Error("Invalid inbox cursor");
  return { at: parts[0], id: parts[1] };
}
export function validInboxCursor(value: string): boolean {
  try {
    activityCursor(value);
    return true;
  } catch {
    return false;
  }
}
function nextActivityCursor(row: StoredContactMessage): string {
  return `v1_${Buffer.from(JSON.stringify([row.cursorActivityAt, row.id])).toString("base64url")}`;
}
function dtoReply(reply: ContactReply): ContactReply {
  return {
    id: reply.id,
    text: validateContactText(reply.text),
    createdAt: iso(reply.createdAt),
    fromCreator: reply.fromCreator,
  };
}
export function contactMessageDto(row: StoredContactMessage, viewerId: string): ContactMessage {
  const direction = row.recipientId === viewerId ? "received" : "sent";
  const ownReadAt = direction === "received" ? row.readAt : (row.senderReadAt ?? row.createdAt);
  const readRevision =
    direction === "received" ? row.recipientReadRevision : row.senderReadRevision;
  const unread =
    row.paymentStatus === "pending"
      ? false
      : readRevision === undefined
        ? direction === "received" && !row.readAt
        : readRevision < (row.activityRevision ?? 0);
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
    readAt: ownReadAt ? iso(ownReadAt) : null,
    lastActivityAt: iso(row.lastActivityAt ?? row.createdAt),
    unread,
    latestReply: row.latestReply ? dtoReply(row.latestReply) : null,
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
  const markReadSnapshot = async (userId: string, id: string, revision?: number) =>
    (
      await sql.query<StoredContactMessage>(
        `update creator_messages set
       recipient_read_revision=case when recipient_id=$2 then greatest(recipient_read_revision,least(activity_revision,coalesce($3::integer,activity_revision))) else recipient_read_revision end,
       recipient_read_at=case when recipient_id=$2 then now() else recipient_read_at end,
       sender_read_revision=case when sender_id=$2 then greatest(sender_read_revision,least(activity_revision,coalesce($3::integer,activity_revision))) else sender_read_revision end,
       sender_read_at=case when sender_id=$2 then now() else sender_read_at end
       where id=$1 and (sender_id=$2 or (recipient_id=$2 and payment_status<>'pending')) returning ${messageColumns}`,
        [id, userId, revision ?? null],
      )
    )[0] ?? null;
  return {
    async contactAllowed(senderId, recipientId) {
      const [row] = await sql.query<{ allowed: boolean }>(
        `select not exists(select 1 from creator_contact_pairs where low_id=least($1::text,$2::text)
         and high_id=greatest($1::text,$2::text) and (low_blocked or high_blocked)) as allowed`,
        [senderId, recipientId],
      );
      return row.allowed;
    },
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
        `insert into creator_messages(id,recipient_id,recipient_handle,sender_id,sender_name,anonymous,kind,body,payment_status,sender_read_at)
       select $1,p.user_id,p.handle,$3,$4,false,'dm',$5,'free',now() from public_creator_profiles p
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
        `insert into creator_messages(id,recipient_id,recipient_handle,sender_id,sender_name,anonymous,kind,body,payment_status,payment_id,sender_read_at,moderation_actor_id)
        select $1,p.user_id,p.handle,$3,$4,$5,$6,$7,'pending',$8,case when $3::text is null then null else now() end,$9 from public_creator_profiles p where p.user_id=$2
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
          input.moderationActorId ?? input.senderId,
        ],
      );
      if (!rows[0]) throw new Error("Recipient not found");
      return rows[0];
    },
    async discardPendingMessage(id, paymentId) {
      await sql.query(
        `delete from creator_messages m where m.id=$1 and m.payment_id=$2 and m.payment_status='pending'
         and not exists(select 1 from creator_payment_intents p where p.message_id=m.id)`,
        [id, paymentId],
      );
    },
    async completePendingMessage(id, paymentId) {
      const rows = await sql.query(
        `update creator_messages set payment_status='paid',last_activity_at=greatest(last_activity_at,clock_timestamp()) where id=$1 and payment_id=$2 and payment_status='pending' returning id`,
        [id, paymentId],
      );
      if (rows.length) return true;
      const row = await readInternalMessage(id);
      return row?.paymentId === paymentId && row.paymentStatus === "paid";
    },
    readInternalMessage,
    async listMessages(userId, folder, cursor) {
      const boundary = cursor ? activityCursor(cursor) : null;
      const scope =
        folder === "sent"
          ? `sender_id=$1`
          : `recipient_id=$1 and payment_status<>'pending' and kind='${folder === "donations" ? "donation" : "dm"}'`;
      // Page rows and counters share a statement snapshot, even when a conversation is read concurrently.
      const [page] = await sql.query<{
        messages: StoredContactMessage[];
        unreadCounts: InboxUnreadCounts;
      }>(
        `with page as materialized (select ${messageColumns},${latestReplyColumns},
        to_char(last_activity_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorActivityAt" from creator_messages
        where ${scope} and ($2::text is null or (last_activity_at,id)<(coalesce($3::timestamptz,(select last_activity_at from creator_messages where id=$2 and ${scope})),$2))
        order by last_activity_at desc,id desc limit 51), counts as (${unreadCountsQuery})
        select coalesce((select json_agg(page order by "lastActivityAt" desc,id desc) from page),'[]'::json) as messages,
        row_to_json(counts) as "unreadCounts" from counts`,
        [userId, boundary?.id ?? null, boundary?.at ?? null],
      );
      const rows = page.messages;
      return {
        messages: rows.slice(0, 50),
        nextCursor: rows.length > 50 ? nextActivityCursor(rows[49]) : null,
        unreadCounts: page.unreadCounts,
      };
    },
    async unreadCounts(userId) {
      const [row] = await sql.query<InboxUnreadCounts>(unreadCountsQuery, [userId]);
      return row ?? { received: 0, sent: 0, donations: 0 };
    },
    async readThread(userId, id, markRead = true) {
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
        `select r.id,r.body as text,r.created_at as "createdAt",r.author_id=m.recipient_id as "fromCreator" from creator_message_replies r join creator_messages m on m.id=r.message_id where r.message_id=$1 and r.activity_revision<=$2 order by r.activity_revision limit 200`,
        [id, rows[0].activityRevision],
      );
      const message = rows[0];
      if (markRead) {
        const marked = await markReadSnapshot(userId, id, message.activityRevision);
        if (marked) {
          message.readAt = marked.readAt;
          message.senderReadAt = marked.senderReadAt;
          message.recipientReadRevision = marked.recipientReadRevision;
          message.senderReadRevision = marked.senderReadRevision;
        }
      }
      const threadReplies = replies.map((r) => ({ ...r, createdAt: iso(r.createdAt) }));
      message.latestReply = threadReplies.at(-1) ?? null;
      return {
        message,
        replies: threadReplies,
      };
    },
    async reply(userId, id, text) {
      const rows = await sql.query(
        `with candidate as materialized (
          select m.id from creator_messages m left join creator_contact_settings c on c.user_id=m.recipient_id
          where m.id=$2 and m.sender_id is not null and m.payment_status<>'pending'
          and (m.recipient_id=$3 or (m.sender_id=$3 and c.settings->>'dmMode'='free')) for update of m
        ), activity as (
          update creator_messages m set activity_revision=m.activity_revision+1,
          last_activity_at=greatest(clock_timestamp(),m.last_activity_at+interval '1 microsecond'),
          recipient_read_revision=case when m.recipient_id=$3 then m.activity_revision+1 else m.recipient_read_revision end,
          sender_read_revision=case when m.sender_id=$3 then m.activity_revision+1 else m.sender_read_revision end,
          recipient_read_at=case when m.recipient_id=$3 then now() else m.recipient_read_at end,
          sender_read_at=case when m.sender_id=$3 then now() else m.sender_read_at end
          from candidate where m.id=candidate.id and m.activity_revision<200
          returning m.id,m.activity_revision,m.last_activity_at
        ) insert into creator_message_replies(id,message_id,author_id,body,activity_revision,created_at)
          select $1,id,$3,$4,activity_revision,last_activity_at from activity returning id`,
        [randomUUID(), id, userId, validateContactText(text)],
      );
      return rows.length === 1;
    },
    async markRead(userId, id, revision) {
      return Boolean(await markReadSnapshot(userId, id, revision));
    },
  };
}
