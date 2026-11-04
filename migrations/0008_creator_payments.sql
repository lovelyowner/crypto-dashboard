-- A creator's own merchant credentials are encrypted with the application secret.
-- Versions stay bound to existing invoices when a creator replaces active keys.
create table if not exists creator_payment_credentials (
 id text primary key,
 user_id text not null references "user" (id) on delete cascade,
 encrypted text not null,
 active boolean not null default true,
 created_at timestamptz not null default now()
);
create unique index if not exists creator_payment_credentials_active on creator_payment_credentials(user_id) where active = true;
create table if not exists creator_payment_intents (
 id text primary key,
 message_id text not null unique references creator_messages(id) on delete cascade,
 recipient_id text not null references "user"(id) on delete cascade,
 sender_id text references "user"(id) on delete cascade,
 capability_hash text,
 kind text not null check(kind in ('dm','donation')),
 method text not null check(method in ('ethereum','nowpayments')),
 status text not null default 'pending' check(status in ('pending','paid','failed')),
 amount text not null,
 recipient_address text,
 amount_wei text,
 nonce_data text,
 credential_id text references creator_payment_credentials(id),
 invoice_id text,
 checkout_url text,
 provider_payment_id text,
 transaction_hash text,
 confirmations integer not null default 0,
 last_verify_at timestamptz,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null,
 paid_at timestamptz,
 check((sender_id is not null and capability_hash is null) or (sender_id is null and capability_hash is not null))
);
create index if not exists creator_payment_intents_sender on creator_payment_intents(sender_id, created_at desc);
create index if not exists creator_payment_intents_recipient on creator_payment_intents(recipient_id, created_at desc);
-- One chain transfer or provider payment may release only one exact intent.
create table if not exists creator_payment_proofs (
 proof_key text primary key,
 intent_id text not null unique references creator_payment_intents(id) on delete cascade,
 created_at timestamptz not null default now()
);
create table if not exists creator_payment_limits (
 key text primary key,
 count integer not null,
 window_started_at timestamptz not null
);
