# Saving the Tuum and Nutrient API keys

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
| `TUUM` | `client_id`, `client_secret`, `base_url` |
| `NUTRIENT` | `api_key`, `base_url`, `jwt_signing_key` |

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
