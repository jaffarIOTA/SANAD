# Document Engine, locally, for verification

```bash
scripts/nutrient-dev-keys.sh            # once: writes compose/.env and the four SANAD_CREDENTIAL_* lines into .env.local
# No key needed for the trial: the engine starts in evaluation mode (watermark on exports).
# With a purchased licence: $EDITOR adapters/nutrient/compose/.env and set LICENSE_KEY; nowhere else.
docker compose -f adapters/nutrient/compose/docker-compose.yml --env-file adapters/nutrient/compose/.env up -d
curl -s http://127.0.0.1:5000/healthcheck
```

Then the probe: `adapters/nutrient/verification/probe.sh <synthetic.pdf>` with `.env.local` sourced.

## With the development signing service (check V-04)

```bash
scripts/nutrient-dev-signing-cert.sh    # once: a throwaway CA and signer into compose/.signing/ (gitignored, 30 days)
docker compose -f adapters/nutrient/compose/docker-compose.yml -f adapters/nutrient/compose/docker-compose.signing.yml \
  --env-file adapters/nutrient/compose/.env up -d
```

The override adds `signing-service`, which runs `adapters/nutrient/signing-service/server.mjs`
on the compose network with no host port. It points the engine's `SIGNING_SERVICE_URL` at
the service and mounts the development CA into the engine's `/certificate-stores` so the
engine can validate what it signs. Everything it signs carries a certificate named
"NOT TRUSTED", and the workbench labels a seal made in the sandbox as a development
certificate. In production the institution's signing service, in front of its HSM, answers
the same callback.

What the key script generates, and why none of it is a secret worth protecting beyond the
gitignore: a random API token and a random dashboard password for *this* engine on *this*
laptop, a database password for the container's own PostgreSQL, and an RSA key pair whose
public half goes to the engine and whose private half (`jwt_private_key`) the ops app uses to
sign viewer tokens. Rotate by running the script again and restarting the stack. The
activation key is the only value that comes from outside, and it is pasted by hand into a
gitignored file.

This stack is development only. The in-Kingdom deployment runs the same image on the
institution's hosts with the real PostgreSQL and the vault (ADR 0001).
