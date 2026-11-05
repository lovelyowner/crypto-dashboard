-- Official @better-auth/passkey schema. Private keys remain on the authenticator.
create table if not exists "passkey" (
  "id" text primary key,
  "name" text,
  "publicKey" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "credentialID" text not null unique,
  "counter" bigint not null,
  "deviceType" text not null,
  "backedUp" boolean not null,
  "transports" text,
  "createdAt" timestamptz default CURRENT_TIMESTAMP,
  "aaguid" text
);
create index if not exists "passkey_userId_idx" on "passkey" ("userId");
