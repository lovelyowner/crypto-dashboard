-- Private creator profile drafts. Authentication is checked by the server
-- before every read/write; the user_id always comes from the validated session.
-- This table is accessed through the server's database connection, never a
-- browser/database SDK. It contains only the whitelisted public profile model,
-- not wallet keys, authentication credentials, recovery data, or provider tokens.
-- No public/read-all endpoint is provided by this migration.
create table if not exists creator_profiles (
  user_id text primary key references "user" ("id") on delete cascade,
  profile jsonb not null check (jsonb_typeof(profile) = 'object'),
  updated_at timestamptz not null default now()
);
