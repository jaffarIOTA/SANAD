# Saving the Tuum and Nutrient API keys

> **The usual route is the administration app.** Start it with `npm run dev:admin`, open
> http://localhost:3004, sign in with the platform operations token from your `.env.local`,
> and use **Credentials → Save or rotate**. The screen calls the same
> `config.set_integration_credential` function described below, shows names and dates only,
> and never displays a value. The SQL route remains for environments without the app.
>
> Locally the database is `npx supabase start` (migrations apply on start); its connection
> string goes in `SANAD_DATABASE_URL` in `.env.local`, which is what switches every app from
> the environment credential provider to the vault.

**Do not paste keys into chat, a ticket, a commit, or a `.env` that is tracked.**
Run these yourself, from the Supabase SQL editor (which connects as a privileged role)
or a service-role psql session.

## 1. Apply the migrations

```bash
supabase db push
```

## 2. Find the tenant id

```sql
select id, code from core.tenant;
```

## 3. Save a key

```sql
select config.set_integration_credential(
  p_tenant      => '<tenant uuid>',
  p_provider    => 'TUUM',
  p_environment => 'sandbox',
  p_key_name    => 'api_key',
  p_secret      => '<paste the key here>',
  p_label       => 'Tuum sandbox, issued Sep 2026'
);
```

Repeat per credential. Typical set:

| Provider | Keys you will likely need |
|---|---|
| `TUUM` | `username`, `password`, `tenant_code`, `auth_base_url`, `loan_api_base_url` — the sandbox authenticates an **employee** by username and password with a tenant code (`POST /api/v1/employees/authorise`), so the stored secret is a password and password rotation applies to it. `auth_base_url` is the authentication host (for the partners sandbox, `https://auth-api.sandbox-partners.tuumplatform.com`); `loan_api_base_url` the loan module's host. Hosts only, no paths. |
| `NUTRIENT` | `web_sdk_license_key`, `document_engine_base_url`, `document_engine_api_token`, `jwt_private_key` |

For `NUTRIENT`: the **Web SDK licence key** is domain-bound and is handed to the browser
by the viewer page, so it is configuration rather than a secret — it is kept here anyway
so the adapter reads its whole configuration from one place and so it is never committed.
The **Document Engine API token** and the **JWT private key** (which signs the short-lived
tokens the viewer presents to Document Engine) are secrets. Document Engine's own
**activation key** is not a Sanad credential: it goes to the Document Engine container's
environment on the in-Kingdom host, nowhere else. See
`adapters/nutrient/verification/README.md` for what to check first.

In development, before the database is reachable, the same four keys go in `.env.local`
under the names `.env.example` lists; the adapter cannot tell the difference.

`base_url` is not secret but is stored alongside so an adapter reads its whole
configuration from one place. Keep it here for consistency.

## 4. Check what is stored — no values returned

```sql
select * from config.list_integration_credentials('<tenant uuid>');
```

## 5. Rotate

Call `set_integration_credential` again with the same provider, environment and key name.
The vault reference stays stable; only the value changes, and `last_rotated_at` is set.

## 6. Revoke

```sql
select config.revoke_integration_credential('<credential uuid>');
```

A revoked credential raises on read rather than returning a stale value.

---

## What this does not do

- **It does not clear the key out of your clipboard or shell history.** If you paste into
  psql, run `unset HISTFILE` first or use the Supabase SQL editor.
- **It does not remove the key from Tuum's or Nutrient's side.** Revoking here stops Sanad
  using it; revoke at the provider too if the key is compromised.
- **Vault's encryption key is managed by Supabase.** For the bank deployment this must move
  to a customer-managed key in an in-Kingdom HSM. Tracked as an open item.
