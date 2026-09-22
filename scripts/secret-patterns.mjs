/**
 * The patterns that define "this looks like a secret".
 *
 * One source, used by two callers with different inputs: the architecture test
 * scans the repository as it stands, the pre-commit hook scans what is about
 * to be committed. Duplicating the patterns would mean the hook and the test
 * drifting, and the hook is the one that runs when someone is in a hurry.
 *
 * Deliberately narrow. A scanner that cries wolf gets bypassed with
 * `--no-verify`, and a bypassed scanner is worse than none because it is
 * believed in.
 */

/** Names that carry a secret rather than a location. */
export const SECRET_SHAPED =
  /(token|secret|password|passwd|api[_-]?key|credential|private[_-]?key)/i;

/**
 * A long opaque value assigned to a secret-named thing.
 *
 * The `['"`]?` after the name is load-bearing. Without it the pattern matches
 * `clientSecret: "…"` but **not** `"client_secret": "…"`, because the closing
 * quote sits between the name and the colon. That is the shape of every JSON
 * credentials file — including the API Connect toolkit's `credentials.json` —
 * so the omission would have let exactly the files most worth catching
 * through.
 */
export const OPAQUE_ASSIGNMENT =
  /(token|secret|password|api[_-]?key|credential)\w*['"`]?\s*[:=]\s*['"`]?([A-Za-z0-9_\-+/=.]{24,})['"`]?/gi;

/**
 * Files that are credential bundles by name, whatever is inside them.
 *
 * A vendor toolkit hands you one of these and the natural place to put it is
 * the project root. Catching the name is more reliable than catching every
 * field a vendor might choose to call its secret.
 */
export const CREDENTIAL_FILE =
  /(^|\/)(credentials|toolkit-credentials|service-account|sa|gha|kubeconfig)[-.\w]*\.(json|ya?ml|conf)$/i;

/** Values that are obviously not secrets. */
export const PLACEHOLDER = /^(development|example|placeholder|redacted|changeme|test|fixture|your[_-])/i;

/** Key and certificate material, which never belongs in the repository. */
export const KEY_FILE = /\.(pem|p12|pfx|key|jks|keystore)$/i;

/** Any environment file except the one that is meant to be tracked. */
export const isTrackedEnvFile = (path) =>
  /(^|\/)\.env/.test(path) && !path.endsWith('.env.example');

/** PEM blocks, which are unambiguous wherever they appear. */
export const PEM_BLOCK = /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/;

/**
 * Findings in a single file's content.
 *
 * `path` is used for the env-file and key-file rules; `content` for the rest.
 */
export function findSecrets(path, content) {
  const findings = [];

  if (isTrackedEnvFile(path)) {
    findings.push(`${path}: an environment file must not be committed`);
  }

  if (KEY_FILE.test(path)) {
    findings.push(`${path}: key or certificate material must not be committed`);
  }

  if (CREDENTIAL_FILE.test(path)) {
    findings.push(`${path}: looks like a credential bundle and must not be committed`);
  }

  if (PEM_BLOCK.test(content)) {
    findings.push(`${path}: contains a PEM private key block`);
  }

  // `.env.example` is tracked on purpose and must hold names only.
  if (path.endsWith('.env.example')) {
    for (const [i, line] of content.split('\n').entries()) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const value = trimmed.split(/=(.*)/s)[1] ?? '';
      if (value.trim().length > 0) {
        findings.push(`${path}:${i + 1}: holds a value; this file is names only`);
      }
    }
  }

  for (const match of content.matchAll(OPAQUE_ASSIGNMENT)) {
    const value = match[2] ?? '';
    if (PLACEHOLDER.test(value) || value.startsWith('${') || value.startsWith('process.env')) {
      continue;
    }
    const line = content.slice(0, match.index).split('\n').length;
    findings.push(`${path}:${line}: long opaque value assigned to '${match[1]}'`);
  }

  for (const match of content.matchAll(/NEXT_PUBLIC_([A-Z0-9_]+)/g)) {
    if (SECRET_SHAPED.test(match[1] ?? '')) {
      const line = content.slice(0, match.index).split('\n').length;
      findings.push(
        `${path}:${line}: NEXT_PUBLIC_${match[1]} — this prefix inlines the value into the browser bundle`,
      );
    }
  }

  return findings;
}
