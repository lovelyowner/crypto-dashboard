-- Better Auth's shared, atomic database rate limiter (milliseconds since epoch).
-- The unique key also prevents concurrent cold serverless instances from
-- creating independent counters for the same IP and endpoint.
create table if not exists "rateLimit" (
  "id" text primary key not null,
  "key" text not null unique,
  "count" integer not null,
  "lastRequest" bigint not null
);

create index if not exists "rateLimit_lastRequest_idx" on "rateLimit" ("lastRequest");
