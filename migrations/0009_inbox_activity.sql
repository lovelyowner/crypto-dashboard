-- Each participant reads a revision, so a concurrent reply cannot be hidden by a later clock time.
alter table creator_messages add column if not exists last_activity_at timestamptz;
alter table creator_messages add column if not exists activity_revision integer not null default 0;
alter table creator_messages add column if not exists recipient_read_revision integer not null default -1;
alter table creator_messages add column if not exists sender_read_revision integer not null default 0;
alter table creator_messages add column if not exists sender_read_at timestamptz;
alter table creator_message_replies add column if not exists activity_revision integer;

with numbered as (
  select id, row_number() over (partition by message_id order by created_at,id)::integer as revision
  from creator_message_replies
)
update creator_message_replies r set activity_revision=n.revision
from numbered n where n.id=r.id and r.activity_revision is null;

update creator_messages m set
  activity_revision=(select count(*)::integer from creator_message_replies r where r.message_id=m.id),
  last_activity_at=greatest(m.created_at,coalesce((select max(created_at) from creator_message_replies r where r.message_id=m.id),m.created_at)),
  recipient_read_revision=greatest(
    case when m.recipient_read_at is null then -1 else 0 end,
    coalesce((select max(activity_revision) from creator_message_replies r where r.message_id=m.id and (r.created_at<=m.recipient_read_at or r.author_id=m.recipient_id)),-1)
  ),
  sender_read_revision=coalesce((select max(activity_revision) from creator_message_replies r where r.message_id=m.id and r.author_id=m.sender_id),0),
  sender_read_at=case when m.sender_id is null then null else coalesce((select max(created_at) from creator_message_replies r where r.message_id=m.id and r.author_id=m.sender_id),m.created_at) end
where m.last_activity_at is null;

alter table creator_messages alter column last_activity_at set default now();
alter table creator_messages alter column last_activity_at set not null;
alter table creator_message_replies alter column activity_revision set not null;
-- An older function can still receive a request while a deployment is being switched over.
-- Its original INSERT omits the revision; fill it atomically instead of rejecting that write.
create or replace function creator_reply_legacy_activity() returns trigger language plpgsql as $$
begin
  update creator_messages m set
    activity_revision=m.activity_revision+1,
    last_activity_at=greatest(clock_timestamp(),m.last_activity_at+interval '1 microsecond'),
    recipient_read_revision=case when m.recipient_id=new.author_id then m.activity_revision+1 else m.recipient_read_revision end,
    sender_read_revision=case when m.sender_id=new.author_id then m.activity_revision+1 else m.sender_read_revision end,
    recipient_read_at=case when m.recipient_id=new.author_id then now() else m.recipient_read_at end,
    sender_read_at=case when m.sender_id=new.author_id then now() else m.sender_read_at end
  where m.id=new.message_id and m.sender_id is not null and m.payment_status<>'pending'
    and (m.recipient_id=new.author_id or m.sender_id=new.author_id) and m.activity_revision<200
  returning m.activity_revision,m.last_activity_at into new.activity_revision,new.created_at;
  if not found then raise exception 'Conversation cannot accept another reply'; end if;
  return new;
end;
$$;
drop trigger if exists creator_reply_legacy_activity on creator_message_replies;
create trigger creator_reply_legacy_activity before insert on creator_message_replies
for each row when (new.activity_revision is null) execute function creator_reply_legacy_activity();
create unique index if not exists creator_replies_revision_idx on creator_message_replies(message_id,activity_revision);
create index if not exists creator_messages_recipient_activity_idx on creator_messages(recipient_id,last_activity_at desc,id desc);
create index if not exists creator_messages_sender_activity_idx on creator_messages(sender_id,last_activity_at desc,id desc);
