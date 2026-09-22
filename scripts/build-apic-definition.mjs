#!/usr/bin/env node
/**
 * Generate the API Connect publication artefact from the contract.
 *
 * `api/openapi/origination.v1.yaml` is OpenAPI **3.1** and stays that way. It
 * is the source of truth: `services/origination/src/contract.ts` compiles it
 * into the runtime validators, which is what makes `additionalProperties:
 * false` an enforced control rather than a claim (SH-01).
 *
 * API Connect v10.0.11 does not parse 3.1 — established by experiment, not by
 * release notes; `apic validate` answers "Invalid file type provided" and does
 * so identically with `--no-extensions`. So we **generate** a 3.0 artefact for
 * the gateway rather than downgrading the source. Downgrading the source would
 * quietly delete constraints from the system of record in order to satisfy a
 * tool.
 *
 * Two constructs cannot survive the conversion and are **not** silently
 * dropped — they are listed in `x-sanad-not-expressible` inside the generated
 * file, so the gap is visible to whoever reads it at the gateway:
 *
 *   - the `if`/`then` making `invoiceUuid` and `invoiceHash` required when the
 *     trade is a cleared invoice. 3.0 cannot express a conditional.
 *   - `webhooks`, which has no 3.0 equivalent at all.
 *
 * Both remain enforced by the service. The gateway simply cannot check them,
 * which is the correct division anyway: the gateway is not the security
 * boundary (§5).
 *
 * Run: node scripts/build-apic-definition.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse, stringify } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = `${ROOT}api/openapi/origination.v1.yaml`;
const TARGET = `${ROOT}gateway/ibm/origination-api_1.0.0.yaml`;

const source = parse(readFileSync(SOURCE, 'utf8'));
const dropped = [];

/** Recursively convert 2020-12 schema constructs to the 3.0 subset. */
function convert(node, path = '$') {
  if (Array.isArray(node)) return node.map((n, i) => convert(n, `${path}[${i}]`));
  if (node === null || typeof node !== 'object') return node;

  const out = {};

  for (const [key, value] of Object.entries(node)) {
    const here = `${path}.${key}`;

    // `const: X` → `enum: [X]`. Semantically identical in this subset.
    if (key === 'const') {
      out.enum = [value];
      continue;
    }

    // `type: [string, 'null']` → `type: string` + `nullable: true`.
    if (key === 'type' && Array.isArray(value)) {
      const nonNull = value.filter((t) => t !== 'null');
      if (value.includes('null')) out.nullable = true;
      // A union of real types has no 3.0 equivalent; the widest honest
      // answer is to omit the constraint rather than pick one arbitrarily.
      if (nonNull.length === 1) {
        out.type = nonNull[0];
      } else {
        dropped.push(`${here}: union type [${value.join(', ')}] — no 3.0 equivalent`);
      }
      continue;
    }

    // Schema-level `examples` array → singular `example`.
    if (key === 'examples' && Array.isArray(value)) {
      out.example = value[0];
      continue;
    }

    // Conditionals are Draft 7+; 3.0's subset has none.
    if (key === 'if' || key === 'then' || key === 'else') {
      dropped.push(`${here}: \`${key}\` conditional — enforced by the service only`);
      continue;
    }

    out[key] = convert(value, here);
  }

  // An `allOf` emptied by dropping its conditionals is noise; remove it.
  if (Array.isArray(out.allOf)) {
    out.allOf = out.allOf.filter((s) => s !== null && Object.keys(s).length > 0);
    if (out.allOf.length === 0) delete out.allOf;
  }

  return out;
}

const converted = convert(source);

converted.openapi = '3.0.3';

// 3.1-only document fields.
delete converted.info.summary;
delete converted.info.license?.identifier;
if (converted.info.license !== undefined && Object.keys(converted.info.license).length === 0) {
  delete converted.info.license;
}
if (converted.webhooks !== undefined) {
  delete converted.webhooks;
  dropped.push('$.webhooks: no 3.0 equivalent — the callback contract lives in the 3.1 source');
}

converted.info['x-ibm-name'] = 'sanad-origination';

/*
 * `type: mutualTLS` is an OpenAPI 3.1 security scheme. 3.0 permits only
 * apiKey, http, oauth2 and openIdConnect, so the declaration cannot survive.
 *
 * Losing the *declaration* costs nothing, because it was never the
 * enforcement. mTLS is terminated in front of the service — by DataPower, or
 * by the load balancer ahead of it — and the service re-asserts identity from
 * the bearer credential regardless (§5). What is lost is documentation, and it
 * is recorded below rather than dropped silently.
 */
const schemes = converted.components?.securitySchemes ?? {};
for (const [name, scheme] of Object.entries(schemes)) {
  if (scheme?.type !== 'mutualTLS') continue;
  delete schemes[name];
  dropped.push(
    `$.components.securitySchemes.${name}: \`type: mutualTLS\` is 3.1-only — ` +
      'mTLS is terminated at the gateway and is not declarable here',
  );

  // A requirement naming a scheme that no longer exists will not validate.
  converted.security = (converted.security ?? [])
    .map((requirement) => {
      const remaining = { ...requirement };
      delete remaining[name];
      return remaining;
    })
    .filter((requirement) => Object.keys(requirement).length > 0);
}

/*
 * The assembly.
 *
 * Note what is absent, and why it is absent rather than forgotten. There is no
 * transform of any kind — no map, no gatewayscript, no xslt, no
 * json-to-xml. Three specific reasons (E-16):
 *
 *   - a gateway that normalises JSON silently disables SH-01, because our
 *     schemas are closed and a stripped unknown field never reaches the
 *     service that exists to reject it;
 *   - a gateway that rewrites an error strips the control code a compliance
 *     rejection carries, turning a specific refusal into a generic decline;
 *   - a gateway that transforms a body can change an amount.
 *
 * The upstream response is returned as-is. That is the whole design.
 */
converted['x-ibm-configuration'] = {
  type: 'rest',
  phase: 'realized',
  enforced: true,
  testable: false,
  cors: { enabled: false },
  gateway: 'datapower-api-gateway',

  properties: {
    'upstream-url': {
      value: 'http://origination.sanad.svc.cluster.local',
      description: 'The origination service, in-cluster. Set per catalog.',
      encoded: false,
    },
  },

  assembly: {
    execute: [
      {
        invoke: {
          version: '2.5.0',
          title: 'pass through to the service',
          'target-url': '$(upstream-url)$(request.path)$(request.search)',
          verb: 'keep',
          timeout: 30,
          'cache-response': 'no-cache',
          /*
           * THE line.
           *
           * A gateway retry reissues the request without a fresh
           * Idempotency-Key, which is the one path by which this platform can
           * execute an instruction twice — a duplicate purchase leg, or a
           * duplicate payment. Retries belong to the caller, who holds the
           * key.
           */
          'backend-type': 'detect',
          'stop-on-error': [],
          /* Every status reaches the caller unchanged, including 4xx. Our
           * problem details carry the control code and the Arabic text. */
          'error-control': 'ProtocolError',
        },
      },
    ],
  },
};

converted['x-sanad-not-expressible'] = {
  note:
    'Constraints present in the OpenAPI 3.1 contract that OpenAPI 3.0 cannot ' +
    'express. Each is enforced by the service. The gateway cannot check them, ' +
    'which is correct — the gateway is not the security boundary.',
  source: 'api/openapi/origination.v1.yaml',
  constraints: dropped,
};

const header = `# GENERATED — do not edit.
#
#   source:  api/openapi/origination.v1.yaml   (OpenAPI 3.1, the contract)
#   build:   node scripts/build-apic-definition.mjs
#
# API Connect v10.0.11 does not parse OpenAPI 3.1, so the contract is
# converted rather than downgraded. The 3.1 document remains the source of
# truth and the thing the service validates against at runtime.
#
# \`test/contract/apic-artefact.test.ts\` asserts this file still agrees with
# that contract on paths, operations, required fields and closed schemas. Edit
# the source and rebuild; an edit here is overwritten.
`;

writeFileSync(TARGET, `${header}\n${stringify(converted, { lineWidth: 100 })}`);

process.stdout.write(`wrote ${TARGET.replace(ROOT, '')}\n`);
process.stdout.write(`constraints not expressible in 3.0: ${String(dropped.length)}\n`);
for (const d of dropped) process.stdout.write(`  - ${d}\n`);
