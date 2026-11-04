-- Explicitly published snapshots are separate from private account drafts.
-- Retain an unpublished row so removing a page cannot release its public handle
-- for another account to claim. Deleting the account removes both ownership
-- and its published snapshot through the foreign key.
create table if not exists public_creator_profiles (
  user_id text primary key references "user" ("id") on delete cascade,
  handle text not null unique check (handle ~ '^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$'),
  profile jsonb not null check (jsonb_typeof(profile) = 'object'),
  published boolean not null default true,
  updated_at timestamptz not null default now()
);
