-- Account-owned inboxes and contact policies. No message is a public profile field.
create table if not exists creator_contact_settings (
  user_id text primary key references "user" ("id") on delete cascade,
  settings jsonb not null check (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz not null default now()
);
create table if not exists creator_messages (
  id text primary key,
  recipient_id text not null references "user" ("id") on delete cascade,
  recipient_handle text not null,
  sender_id text references "user" ("id") on delete set null,
  sender_name text not null,
  anonymous boolean not null,
  kind text not null check (kind in ('dm', 'donation')),
  body text not null check (char_length(body) between 1 and 2000),
  payment_status text not null check (payment_status in ('free', 'unverified', 'pending', 'paid')),
  payment_id text unique,
  created_at timestamptz not null default now(),
  recipient_read_at timestamptz,
  check (not anonymous or sender_id is null),
  check (kind <> 'dm' or not anonymous),
  check (payment_status not in ('pending', 'paid') or payment_id is not null)
);
create index if not exists creator_messages_recipient_idx on creator_messages (recipient_id, created_at desc, id desc);
create index if not exists creator_messages_sender_idx on creator_messages (sender_id, created_at desc, id desc);
create table if not exists creator_message_replies (
  id text primary key,
  message_id text not null references creator_messages (id) on delete cascade,
  author_id text not null references "user" ("id") on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists creator_replies_message_idx on creator_message_replies (message_id, created_at, id);
create table if not exists creator_contact_rate_limits (
  key text primary key,
  count integer not null,
  window_started timestamptz not null
);
