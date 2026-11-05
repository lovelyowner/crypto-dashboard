import { randomUUID } from "node:crypto";
import type { Sql } from "./db";
import type { ContactModeration, ModerationReport, ReportReason, ReportStatus } from "./moderation";

const participantScope = `m.id=$1 and (m.sender_id=$2 or (m.recipient_id=$2 and m.payment_status<>'pending'))`;
const counterpart = `case when m.recipient_id=$2 then m.sender_id else m.recipient_id end`;
export function createSqlModerationStore(sql: Pick<Sql, "query">) {
  const state = async (userId: string, messageId: string): Promise<ContactModeration | null> => {
    const [row] = await sql.query<ContactModeration>(
      `select (${counterpart} is not null and ${counterpart}<>$2) as "canBlock",
       coalesce(case when $2=p.low_id then p.low_blocked else p.high_blocked end,false) as blocked,
       (${counterpart} is null or ${counterpart}<>$2) as "canReport",
       exists(select 1 from creator_contact_reports r where r.message_id=m.id and r.reporter_id=$2) as reported
       from creator_messages m left join creator_contact_pairs p
       on p.low_id=least($2,${counterpart}) and p.high_id=greatest($2,${counterpart})
       where ${participantScope}`,
      [messageId, userId],
    );
    return row ?? null;
  };
  return {
    state,
    async setBlocked(userId: string, messageId: string, blocked: boolean): Promise<boolean> {
      const rows = await sql.query(
        `insert into creator_contact_pairs(low_id,high_id,low_blocked,high_blocked)
         select least($2,${counterpart}),greatest($2,${counterpart}),
         case when $2<${counterpart} then $3 else false end,
         case when $2>${counterpart} then $3 else false end
         from creator_messages m where ${participantScope} and ${counterpart} is not null and ${counterpart}<>$2
         on conflict(low_id,high_id) do update set
         low_blocked=case when creator_contact_pairs.low_id=$2 then $3 else creator_contact_pairs.low_blocked end,
         high_blocked=case when creator_contact_pairs.high_id=$2 then $3 else creator_contact_pairs.high_blocked end returning low_id`,
        [messageId, userId, blocked],
      );
      return rows.length === 1;
    },
    async report(
      userId: string,
      messageId: string,
      reason: ReportReason,
      details: string,
    ): Promise<boolean> {
      const rows = await sql.query(
        `insert into creator_contact_reports(id,message_id,reporter_id,target_id,reason,details,message_snapshot,replies_snapshot)
         select $3,m.id,$2,${counterpart},$4,$5,
         jsonb_build_object('text',m.body,'kind',m.kind,'anonymous',m.anonymous),
         coalesce((select jsonb_agg(jsonb_build_object('text',r.body,'fromCreator',r.author_id=m.recipient_id,'createdAt',r.created_at) order by r.activity_revision)
           from creator_message_replies r where r.message_id=m.id),'[]'::jsonb)
         from creator_messages m where ${participantScope} and (${counterpart} is null or ${counterpart}<>$2)
         on conflict(reporter_id,message_id) do update set reporter_id=excluded.reporter_id returning id`,
        [messageId, userId, randomUUID(), reason, details],
      );
      return rows.length === 1;
    },
    async consumeLimit(key: string, max: number, seconds: number): Promise<boolean> {
      const rows = await sql.query(
        `insert into creator_moderation_limits(key,count,window_started_at) values($1,1,now())
         on conflict(key) do update set
         count=case when creator_moderation_limits.window_started_at<now()-($3*interval '1 second') then 1 else creator_moderation_limits.count+1 end,
         window_started_at=case when creator_moderation_limits.window_started_at<now()-($3*interval '1 second') then now() else creator_moderation_limits.window_started_at end
         where creator_moderation_limits.count<$2 or creator_moderation_limits.window_started_at<now()-($3*interval '1 second') returning key`,
        [key, max, seconds],
      );
      return rows.length === 1;
    },
    async listReports(status: ReportStatus): Promise<ModerationReport[]> {
      const rows = await sql.query<
        Omit<ModerationReport, "createdAt"> & { createdAt: string | Date }
      >(
        `select id,message_id as "messageId",reason,details,status,created_at as "createdAt",
         message_snapshot as message,replies_snapshot as replies from creator_contact_reports
         where status=$1 order by created_at desc,id desc limit 50`,
        [status],
      );
      return rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt).toISOString() }));
    },
    async review(userId: string, id: string, status: "reviewed" | "dismissed"): Promise<boolean> {
      return (
        (
          await sql.query(
            `update creator_contact_reports set status=$3,reviewer_id=$2,reviewed_at=now() where id=$1 returning id`,
            [id, userId, status],
          )
        ).length === 1
      );
    },
  };
}
export type ModerationStore = ReturnType<typeof createSqlModerationStore>;
