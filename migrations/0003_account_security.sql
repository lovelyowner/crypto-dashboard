alter table "user" add column if not exists "username" text;
alter table "user" add column if not exists "displayUsername" text;
alter table "user" add column if not exists "twoFactorEnabled" boolean default false;
create unique index if not exists "user_username_unique" on "user" ("username");
create table if not exists "twoFactor" (
  "id" text not null primary key,
  "secret" text not null,
  "backupCodes" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "verified" boolean default false,
  "failedVerificationCount" integer default 0,
  "lockedUntil" timestamptz
);
create index if not exists "twoFactor_userId_idx" on "twoFactor" ("userId");
