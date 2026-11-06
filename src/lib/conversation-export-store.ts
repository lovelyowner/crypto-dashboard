import type { Sql } from "./db.js";
import {
  CONVERSATION_EXPORT_LIMITS,
  type ConversationExportSnapshot,
} from "./conversation-export.js";

/** A single statement provides one snapshot without relying on pooled transaction affinity. */
export function createSqlConversationExportStore(sql: Pick<Sql, "query">) {
  return {
    async readSnapshot(userId: string): Promise<ConversationExportSnapshot> {
      const [row] = await sql.query<{
        exportedAt: Date | string;
        conversationCount: number;
        replyCount: number;
        overflow: boolean;
        conversations: unknown[] | null;
      }>(
        `with messages as materialized (
          select m.id,m.kind,m.body,m.anonymous,m.sender_name,m.recipient_handle,m.created_at,
            m.payment_status,m.recipient_id,m.sender_id,m.recipient_read_at,m.sender_read_at,m.last_activity_at
          from creator_messages m
          where m.sender_id=$1 or (m.recipient_id=$1 and m.payment_status<>'pending')
          order by m.created_at,m.id limit $2
        ), message_count as (select count(*)::integer as count from messages),
        replies as materialized (
          select r.id,r.message_id from creator_message_replies r join messages m on m.id=r.message_id
          where (select count from message_count)<$2
          order by r.message_id,r.activity_revision,r.id limit $3
        ), totals as (
          select (select count from message_count) as messages,
          (select count(*)::integer from replies) as replies,
          coalesce((select sum(octet_length(m.id)+octet_length(m.body)+
            octet_length(case when m.anonymous then 'Anonymous' else m.sender_name end)+octet_length(m.recipient_handle)) from messages m),0)+
          coalesce((select sum(octet_length(r.id)+octet_length(r.body)) from creator_message_replies r join replies p on p.id=r.id),0) as bytes
        )
        select statement_timestamp() as "exportedAt",t.messages as "conversationCount",t.replies as "replyCount",
        (t.messages>=$2 or t.replies>=$3 or t.bytes>$4) as overflow,
        case when t.messages<$2 and t.replies<$3 and t.bytes<=$4 then (
          select coalesce(json_agg(json_build_object(
            'id',m.id,'kind',m.kind,'text',m.body,'anonymous',m.anonymous,
            'senderName',case when m.anonymous then 'Anonymous' else m.sender_name end,
            'recipientHandle',m.recipient_handle,'createdAt',m.created_at,'paymentStatus',m.payment_status,
            'direction',case when m.recipient_id=$1 and m.payment_status<>'pending' then 'received' else 'sent' end,
            'readAt',case when m.recipient_id=$1 and m.payment_status<>'pending' then m.recipient_read_at else coalesce(m.sender_read_at,m.created_at) end,
            'lastActivityAt',coalesce(m.last_activity_at,m.created_at),
            'replies',(select coalesce(json_agg(json_build_object(
              'id',r.id,'text',r.body,'createdAt',r.created_at,'fromCreator',r.author_id=m.recipient_id
            ) order by r.activity_revision,r.id),'[]'::json)
              from creator_message_replies r join replies p on p.id=r.id where r.message_id=m.id)
          ) order by m.created_at,m.id),'[]'::json) from messages m
        ) else null end as conversations from totals t`,
        [
          userId,
          CONVERSATION_EXPORT_LIMITS.conversations + 1,
          CONVERSATION_EXPORT_LIMITS.replies + 1,
          CONVERSATION_EXPORT_LIMITS.bytes,
        ],
      );
      if (!row) throw new Error("Conversation snapshot unavailable.");
      return {
        exportedAt: row.exportedAt,
        counts: { conversations: row.conversationCount, replies: row.replyCount },
        conversations: row.conversations,
        overflow: row.overflow,
      };
    },
  };
}
