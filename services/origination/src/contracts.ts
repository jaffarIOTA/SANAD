/**
 * Contract compilation for any of the platform's OpenAPI documents.
 *
 * The origination service compiles its own contract at module load
 * (`contract.ts`); the checkout API and any later surface use this factory
 * with the same settings — closed schemas enforced, nothing removed, every
 * error reported — so "the contract is the validator" holds for every API.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { parse } from 'yaml';

import type { OpenApiDocument, ValidationFailure, Validator } from './contract.ts';

const FORMATS: Readonly<Record<string, RegExp>> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'date-time': /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/,
  uri: /^[a-z][a-z0-9+.-]*:/i,
  'uri-reference': /^\S*$/,
};

export interface CompiledContract {
  readonly document: OpenApiDocument;
  validatorFor(schemaName: string): Validator;
}

/** Resolve a contract by its file name under api/openapi, from the repository root or an env override. */
export function contractPath(fileName: string): string {
  const override = process.env['SANAD_CONTRACT_DIR'];
  if (override !== undefined && override.length > 0) return `${override}/${fileName}`;
  return fileURLToPath(new URL(`../../../api/openapi/${fileName}`, import.meta.url));
}

export function compileContract(specPath: string): CompiledContract {
  const document = parse(readFileSync(specPath, 'utf8')) as OpenApiDocument;
  const ajv = new Ajv2020({ allErrors: true, removeAdditional: false, useDefaults: false, strict: false });
  for (const [name, pattern] of Object.entries(FORMATS))
    ajv.addFormat(name, { type: 'string', validate: (value: string) => pattern.test(value) });
  for (const [name, schema] of Object.entries(document.components.schemas))
    ajv.addSchema(schema, `#/components/schemas/${name}`);

  const describe = (error: ErrorObject): ValidationFailure => {
    if (error.keyword === 'additionalProperties') {
      const property = String((error.params as { additionalProperty?: string }).additionalProperty);
      return { path: error.instancePath, message: `Unknown property '${property}'.`, unknownProperty: property };
    }
    if (error.keyword === 'required')
      return {
        path: error.instancePath,
        message: `Missing required property '${String((error.params as { missingProperty?: string }).missingProperty)}'.`,
      };
    return { path: error.instancePath, message: error.message ?? 'is invalid' };
  };

  return {
    document,
    validatorFor(schemaName) {
      const schema = document.components.schemas[schemaName];
      if (schema === undefined) throw new Error(`the contract declares no schema named ${schemaName}`);
      const validate: ValidateFunction = ajv.compile(schema);
      return (body) => (validate(body) ? [] : (validate.errors ?? []).map(describe));
    },
  };
}
