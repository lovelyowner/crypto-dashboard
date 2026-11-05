-- A canonical pair row serializes policy changes with new contact writes.
-- The flags are directional; either flag prevents new contact in both directions.
-- A signed-in anonymous payer remains anonymous in every contact/payment DTO.
-- This private server-derived actor prevents that known account bypassing a block.
alter table creator_messages add column if not exists moderation_actor_id text references "user"(id) on delete set null;
create table if not exists creator_contact_pairs (
  low_id text not null references "user"(id) on delete cascade,
  high_id text not null references "user"(id) on delete cascade,
  low_blocked boolean not null default false,
  high_blocked boolean not null default false,
  primary key(low_id,high_id),
  check(low_id<high_id)
);

create or replace function creator_assert_contact_allowed(first_id text,second_id text)
returns void language plpgsql as $$
declare denied boolean;
begin
  if first_id is null or second_id is null or first_id=second_id then return; end if;
  -- ON CONFLICT reads the current row even when this statement waited behind a
  -- block committed after its snapshot. A separate SELECT after a lock would not.
  insert into creator_contact_pairs(low_id,high_id)
  values(least(first_id,second_id),greatest(first_id,second_id))
  on conflict(low_id,high_id) do update set low_id=excluded.low_id
  returning low_blocked or high_blocked into denied;
  if denied then raise exception 'Contact is blocked.' using errcode='P0001'; end if;
end;
$$;

create or replace function creator_guard_message_contact() returns trigger language plpgsql as $$
begin
  perform creator_assert_contact_allowed(coalesce(new.moderation_actor_id,new.sender_id),new.recipient_id);
  return new;
end;
$$;
drop trigger if exists creator_guard_message_contact on creator_messages;
create trigger creator_guard_message_contact before insert on creator_messages
for each row execute function creator_guard_message_contact();

create or replace function creator_guard_reply_contact() returns trigger language plpgsql as $$
declare sender text; recipient text;
begin
  select coalesce(moderation_actor_id,sender_id),recipient_id into sender,recipient from creator_messages where id=new.message_id;
  perform creator_assert_contact_allowed(sender,recipient);
  return new;
end;
$$;
drop trigger if exists creator_guard_reply_contact on creator_message_replies;
create trigger creator_guard_reply_contact before insert on creator_message_replies
for each row execute function creator_guard_reply_contact();

create or replace function creator_guard_payment_contact() returns trigger language plpgsql as $$
declare sender text; recipient text; message_sender text; expected_payment text; expected_kind text;
begin
  select coalesce(moderation_actor_id,sender_id),recipient_id,sender_id,payment_id,kind
  into sender,recipient,message_sender,expected_payment,expected_kind
  from creator_messages where id=new.message_id;
  if not found or new.recipient_id<>recipient or new.sender_id is distinct from message_sender
    or new.id is distinct from expected_payment or new.kind<>expected_kind then
    raise exception 'The payment does not match its pending message.';
  end if;
  perform creator_assert_contact_allowed(sender,recipient);
  return new;
end;
$$;
drop trigger if exists creator_guard_payment_contact on creator_payment_intents;
create trigger creator_guard_payment_contact before insert on creator_payment_intents
for each row execute function creator_guard_payment_contact();
-- Only INSERTs are guarded: old pending payments must still verify and deliver.

create table if not exists creator_contact_reports (
  id text primary key,
  message_id text not null references creator_messages(id) on delete cascade,
  reporter_id text not null references "user"(id) on delete cascade,
  target_id text references "user"(id) on delete set null,
  reason text not null check(reason in ('spam','harassment','scam','other')),
  details text not null check(char_length(details)<=1000),
  message_snapshot jsonb not null,
  replies_snapshot jsonb not null,
  status text not null default 'open' check(status in ('open','reviewed','dismissed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewer_id text references "user"(id) on delete set null,
  unique(reporter_id,message_id)
);
create index if not exists creator_contact_reports_queue on creator_contact_reports(status,created_at desc,id desc);
create table if not exists creator_moderation_limits (
  key text primary key,
  count integer not null,
  window_started_at timestamptz not null
);
