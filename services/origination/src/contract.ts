/**
 * The OpenAPI document, compiled into runtime validators.
 *
 * This file is what turns `api/openapi/origination.v1.yaml` from a description
 * into a control.
 *
 * The specification claims that every schema is closed, and that closing them
 * is how a partner cannot post a proportion-shaped field (SH-01). That claim
 * is only true if something enforces it at runtime. Hand-written validation
 * would enforce *a* set of rules, drift from the document within a release or
 * two, and leave the contract test asserting one thing while the service does
 * another.
 *
 * So the schemas are read from the document itself and compiled. There is one
 * source of truth, and "the implementation matches the spec" stops being a
 * review question.
 *
 * OpenAPI 3.1 schemas are JSON Schema 2020-12, which is why this needs no
 * translation layer.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { parse } from 'yaml';

const SPEC_PATH = fileURLToPath(
  new URL('../../../api/openapi/origination.v1.yaml', import.meta.url),
);

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: { readonly schemas: Record<string, object> };
}

export const document = parse(readFileSync(SPEC_PATH, 'utf8')) as OpenApiDocument;

/**
 * Formats are declared rather than pulled from a package.
 *
 * Three formats are used by this contract. A dependency that brings dozens
 * more, each with its own interpretation of an RFC, is a larger supply-chain
 * surface than the nine lines below (SDD §6.12) — and it would mean the
 * strictness of our identifier checks was somebody else's decision.
 */
const FORMATS: Readonly<Record<string, RegExp>> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'date-time': /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/,
  uri: /^[a-z][a-z0-9+.-]*:/i,
  'uri-reference': /^\S*$/,
};

function buildAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    // Report everything wrong with a body, not just the first thing. A partner
    // fixing one field at a time across four round trips is a bad integration
    // experience and produces four times the log noise.
    allErrors: true,
    // `additionalProperties: false` is the control. `removeAdditional` would
    // silently delete the offending field and accept the request, which is the
    // precise opposite of what this contract promises.
    removeAdditional: false,
    useDefaults: false,
    strict: false,
  });

  for (const [name, pattern] of Object.entries(FORMATS)) {
    ajv.addFormat(name, { type: 'string', validate: (value: string) => pattern.test(value) });
  }

  // Register every component schema under its `#/components/schemas/…` id so
  // `$ref`s inside the document resolve exactly as written.
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    ajv.addSchema(schema, `#/components/schemas/${name}`);
  }

  return ajv;
}

const ajv = buildAjv();

export interface ValidationFailure {
  /** JSON Pointer into the body, or '' for the body itself. */
  readonly path: string;
  readonly message: string;
  /** The property name, where the failure is an unknown one. */
  readonly unknownProperty?: string;
}

export interface Validator {
  (body: unknown): readonly ValidationFailure[];
}

function describe(error: ErrorObject): ValidationFailure {
  const path = error.instancePath;

  if (error.keyword === 'additionalProperties') {
    const property = String((error.params as { additionalProperty?: string }).additionalProperty);
    return {
      path,
      message: `Unknown property '${property}'.`,
      unknownProperty: property,
    };
  }

  if (error.keyword === 'required') {
    const property = String((error.params as { missingProperty?: string }).missingProperty);
    return { path, message: `Missing required property '${property}'.` };
  }

  return { path, message: error.message ?? 'is invalid' };
}

/** Compile a validator for a named component schema. */
export function validatorFor(schemaName: string): Validator {
  const schema = document.components.schemas[schemaName];
  if (schema === undefined) {
    throw new Error(`the contract declares no schema named ${schemaName}`);
  }

  const validate: ValidateFunction = ajv.compile(schema);

  return (body: unknown): readonly ValidationFailure[] => {
    if (validate(body)) return [];
    return (validate.errors ?? []).map(describe);
  };
}

/** Compile a validator for an inline request-body schema at a given operation. */
export function validatorForBodyOf(path: string, method: string): Validator {
  const operation = document.paths[path]?.[method] as
    | { requestBody?: { content?: Record<string, { schema?: object }> } }
    | undefined;

  const schema = operation?.requestBody?.content?.['application/json']?.schema;
  if (schema === undefined) {
    throw new Error(`the contract declares no JSON request body for ${method} ${path}`);
  }

  const validate: ValidateFunction =
    '$ref' in schema
      ? ajv.compile({ $ref: String((schema as { $ref: string }).$ref) })
      : ajv.compile(schema);

  return (body: unknown): readonly ValidationFailure[] => {
    if (validate(body)) return [];
    return (validate.errors ?? []).map(describe);
  };
}
