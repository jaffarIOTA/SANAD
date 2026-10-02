# Document Engine, locally, for verification

```bash
scripts/nutrient-dev-keys.sh            # once: writes compose/.env and the four SANAD_CREDENTIAL_* lines into .env.local
$EDITOR adapters/nutrient/compose/.env  # paste ACTIVATION_KEY from the trial licence; nowhere else
docker compose -f adapters/nutrient/compose/docker-compose.yml up -d
curl -s http://127.0.0.1:5000/healthcheck
```

Then the probe: `adapters/nutrient/verification/probe.sh <synthetic.pdf>` with `.env.local` sourced.

What the key script generates, and why none of it is a secret worth protecting beyond the
gitignore: a random API token and a random dashboard password for *this* engine on *this*
laptop, a database password for the container's own PostgreSQL, and an RSA key pair whose
public half goes to the engine and whose private half (`jwt_private_key`) the ops app uses to
sign viewer tokens. Rotate by running the script again and restarting the stack. The
activation key is the only value that comes from outside, and it is pasted by hand into a
gitignored file.

This stack is development only. The in-Kingdom deployment runs the same image on the
institution's hosts with the real PostgreSQL and the vault (ADR 0001).
