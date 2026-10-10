-- 0023_spent_tokens.sql
-- Sanad — sealed tokens spent before they expire, shared by every replica (SR-030, SR-043).
--
-- A session is a sealed cookie: stateless, so until now signing out deleted
-- the cookie but a copy stayed good until its expiry (SR-030), and the
-- single sign-on state guard lived in one process, so a copied state cookie
-- could open once per replica (SR-043). Each app now spends the token here:
-- a state when its callback consumes it, a session when its holder signs out;
-- and every session open asks whether it is spent.
--
-- Platform rows, not a tenant's: a sign-in state precedes the tenant's
-- session, and a development administrator has none. Only the SHA-256 of the
-- token is kept, never the token, and only until the token's own expiry, after
-- which its seal refuses it anyway. Reached only through the two functions
-- below; no role holds the table.
--
-- Portable PostgreSQL. Idempotent.

create table if not exists config.spent_token (
  purpose        text        not null check (purpose in ('ADMIN_OIDC_STATE', 'OPS_OIDC_STATE', 'ADMIN_SESSION',
                                                         'OPS_SESSION', 'CONSUMER_SESSION')),
  token_digest   text        not null check (token_digest ~ '^[0-9a-f]{64}$'),
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  created_by     text        not null default current_user,
  correlation_id uuid        not null default gen_random_uuid(),
  primary key (purpose, token_digest)
);

comment on table config.spent_token is
  'Sealed tokens spent before their expiry: consumed sign-in states, signed-out sessions (SR-030, SR-043). Digests only; pruned after expiry. Reached through config.spend_token and config.token_spent.';

-- No policy: nothing but the owner, through the functions below, reads or writes a row.
alter table config.spent_token enable row level security;
revoke all on config.spent_token from public;
do $$
declare
  r text;
begin
  foreach r in array core.hosted_platform_roles() loop
    execute format('revoke all on config.spent_token from %I', r);
  end loop;
end $$;

-- Spends a token: true if this call spent it, false if it already was. The primary key decides between two
-- at once. Expired rows go first; the token's own seal refuses it past its expiry.
create or replace function config.spend_token(p_purpose text, p_digest text, p_expires_at timestamptz)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  spent integer;
begin
  delete from config.spent_token where expires_at <= pg_catalog.now();
  insert into config.spent_token (purpose, token_digest, expires_at)
  values (p_purpose, p_digest, p_expires_at)
  on conflict (purpose, token_digest) do nothing;
  get diagnostics spent = row_count;
  return spent = 1;
end $$;

create or replace function config.token_spent(p_purpose text, p_digest text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select exists (select 1 from config.spent_token t where t.purpose = p_purpose and t.token_digest = p_digest) $$;

revoke execute on function config.spend_token(text, text, timestamptz) from public;
revoke execute on function config.token_spent(text, text) from public;
do $$
declare
  r text;
begin
  foreach r in array core.hosted_platform_roles() loop
    execute format('revoke execute on function config.spend_token(text, text, timestamptz) from %I', r);
    execute format('revoke execute on function config.token_spent(text, text) from %I', r);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'sanad_runtime') then
    grant execute on function config.spend_token(text, text, timestamptz) to sanad_runtime;
    grant execute on function config.token_spent(text, text) to sanad_runtime;
  end if;
end $$;
