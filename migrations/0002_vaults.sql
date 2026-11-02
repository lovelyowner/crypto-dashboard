create table if not exists identity_vaults (
  id text primary key,
  user_id text not null,
  label text not null,
  ciphertext text not null,
  iv text not null,
  salt text not null,
  kdf text not null,
  iterations integer not null,
  btc_address text not null,
  eth_address text not null,
  sol_address text not null,
  identity_name text not null,
  identity_method text not null,
  created_at timestamptz not null default now()
);

create index if not exists identity_vaults_user_idx on identity_vaults (user_id);
