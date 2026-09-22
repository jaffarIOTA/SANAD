import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
const SPEC_PATH = fileURLToPath(new URL("../../api/openapi/origination.v1.yaml", import.meta.url));
const spec = parse(readFileSync(SPEC_PATH, "utf8"));
const STATE_CHANGING = /* @__PURE__ */ new Set(["post", "put", "patch", "delete"]);
const HTTP_METHODS = /* @__PURE__ */ new Set(["get", "put", "post", "delete", "patch", "head", "options", "trace"]);
function operations() {
  const out = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (HTTP_METHODS.has(method)) out.push({ path, method, op });
    }
  }
  return out;
}
function* nodes(value, path = "$") {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* nodes(v, `${path}[${String(i)}]`);
  } else if (value !== null && typeof value === "object") {
    yield { path, node: value };
    for (const [k, v] of Object.entries(value)) yield* nodes(v, `${path}.${k}`);
  }
}
function resolveRef(ref) {
  let cursor = spec;
  for (const raw of ref.replace(/^#\//, "").split("/")) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    cursor = cursor[part];
    if (cursor === void 0) return void 0;
  }
  return cursor;
}
describe("the document itself", () => {
  it("is OpenAPI 3.1", () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
  });
  it("resolves every internal $ref", () => {
    const broken = [];
    for (const { path, node } of nodes(spec)) {
      const ref = node["$ref"];
      if (typeof ref === "string" && ref.startsWith("#/") && resolveRef(ref) === void 0) {
        broken.push(`${path} -> ${ref}`);
      }
    }
    expect(broken).toEqual([]);
  });
  it("gives every operation a unique operationId", () => {
    const ids = operations().map(({ op }) => op.operationId);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
describe("SH-01 \u2014 the wire format cannot carry a rate", () => {
  it("closes every object schema against unknown properties", () => {
    const applicator = /\.(if|then|else|not)$/;
    const open = [];
    for (const { path, node } of nodes(spec)) {
      if (applicator.test(path)) continue;
      const isObjectSchema = node["type"] === "object" || node["properties"] !== void 0 && node["$ref"] === void 0;
      if (isObjectSchema && node["additionalProperties"] === void 0) open.push(path);
    }
    expect(open).toEqual([]);
  });
  it("introduces no property inside a conditional branch of a closed schema", () => {
    const unreachable = [];
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      if (schema["additionalProperties"] !== false) continue;
      const declared = new Set(Object.keys(schema["properties"] ?? {}));
      for (const { path, node } of nodes(schema, `$.${name}`)) {
        if (!/\.(then|else)$/.test(path)) continue;
        for (const branchProperty of Object.keys(node["properties"] ?? {})) {
          if (!declared.has(branchProperty)) unreachable.push(`${path}.${branchProperty}`);
        }
      }
    }
    expect(unreachable).toEqual([]);
  });
  it("never types additionalProperties as an open true", () => {
    const permissive = [];
    for (const { path, node } of nodes(spec)) {
      if (node["additionalProperties"] === true) permissive.push(path);
    }
    expect(permissive).toEqual([]);
  });
  it("declares no property whose name is proportion-shaped", () => {
    const banned = [
      ["rate"],
      ["margin"],
      ["a", "p", "r"].join(""),
      ["percent"],
      ["yield"],
      ["coupon"]
    ].flat();
    const offenders = [];
    for (const { path, node } of nodes(spec)) {
      const properties = node["properties"];
      if (properties === null || typeof properties !== "object") continue;
      for (const name of Object.keys(properties)) {
        const lower = name.toLowerCase();
        if (banned.some((b) => lower.includes(b))) offenders.push(`${path}.${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
describe("money", () => {
  const money = spec.components.schemas["Money"];
  it("exists and carries an explicit currency", () => {
    expect(money).toBeDefined();
    expect(money?.required).toEqual(expect.arrayContaining(["minorUnits", "currency"]));
  });
  it("carries minor units as a digit string, never a JSON number", () => {
    expect(money?.properties["minorUnits"]?.["type"]).toBe("string");
    expect(money?.properties["minorUnits"]?.["pattern"]).toBeTypeOf("string");
  });
  it("types no amount anywhere as number", () => {
    const numeric = [];
    for (const { path, node } of nodes(spec)) {
      const properties = node["properties"];
      if (properties === null || typeof properties !== "object") continue;
      for (const [name, schema] of Object.entries(properties)) {
        const looksMonetary = /amount|price|cost|profit|total|units|balance/i.test(name);
        const t = schema["type"];
        if (looksMonetary && (t === "number" || t === "integer")) numeric.push(`${path}.${name}`);
      }
    }
    expect(numeric).toEqual([]);
  });
});
describe("\xA78 \u2014 API conventions", () => {
  it("requires Idempotency-Key on every state-changing operation", () => {
    const missing = [];
    for (const { path, method, op } of operations()) {
      if (!STATE_CHANGING.has(method)) continue;
      const names = (op.parameters ?? []).map(
        (p) => p.$ref === void 0 ? p.name : resolveRef(p.$ref)?.name
      );
      if (!names.includes("Idempotency-Key")) missing.push(`${method.toUpperCase()} ${path}`);
    }
    expect(missing).toEqual([]);
  });
  it("declares Idempotency-Key as required, not optional", () => {
    expect(spec.components.parameters["IdempotencyKey"]?.required).toBe(true);
  });
  it("accepts no tenant, channel or partner identity in a request body", () => {
    const claimed = [];
    for (const { path, method, op } of operations()) {
      const bodySchemas = Object.values(op.requestBody?.content ?? {}).map((c) => c.schema);
      for (const schema of bodySchemas) {
        const resolved = typeof schema?.["$ref"] === "string" ? resolveRef(schema["$ref"]) : schema;
        for (const { node } of nodes(resolved)) {
          const properties = node["properties"];
          if (properties === null || typeof properties !== "object") continue;
          for (const name of Object.keys(properties)) {
            if (/^(tenantId|channel|partnerId|aggregatorId|credentialRef)$/.test(name)) {
              claimed.push(`${method.toUpperCase()} ${path}: ${name}`);
            }
          }
        }
      }
    }
    expect(claimed).toEqual([]);
  });
  it("returns RFC 9457 problem details on every error response", () => {
    const wrong = [];
    for (const { path, method, op } of operations()) {
      for (const [status, response] of Object.entries(op.responses ?? {})) {
        if (!/^[45]/.test(status)) continue;
        const resolved = "$ref" in response ? resolveRef(response.$ref) : response;
        const types = Object.keys(resolved?.content ?? {});
        if (!types.includes("application/problem+json")) {
          wrong.push(`${method.toUpperCase()} ${path} ${status}: ${types.join(",") || "no content"}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
  it("makes every problem bilingual and correlated", () => {
    const problem = spec.components.schemas["Problem"];
    expect(problem?.required).toEqual(
      expect.arrayContaining(["detail", "detailAr", "correlationId"])
    );
  });
  it("names a control on the rejection examples, never a generic decline", () => {
    const rejection = spec.components.responses["ControlRejection"];
    const examples = rejection?.content?.["application/problem+json"]?.examples;
    expect(examples).toBeDefined();
    expect(Object.keys(examples ?? {}).length).toBeGreaterThan(0);
    for (const [name, example] of Object.entries(examples ?? {})) {
      expect(example.value["control"], `${name} names a control`).toBeTypeOf("string");
      expect(example.value["reason"], `${name} names a reason`).toBeTypeOf("string");
      expect(example.value["detailAr"], `${name} is bilingual`).toBeTypeOf("string");
    }
  });
});
describe("\xA75 \u2014 no gateway-specific behaviour in the contract", () => {
  it("names no header a particular gateway injects", () => {
    const forbidden = /^x-(consumer|anonymous-consumer|credential|kong|authenticated-|ibm-|datapower)/i;
    const offenders = [];
    for (const { path, node } of nodes(spec)) {
      const name = node["name"];
      if (node["in"] === "header" && typeof name === "string" && forbidden.test(name)) {
        offenders.push(`${path}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("requires both mutual TLS and a partner token, not either", () => {
    expect(spec.components.securitySchemes["mutualTls"]?.type).toBe("mutualTLS");
    expect(spec.components.securitySchemes["partnerOAuth"]?.type).toBe("oauth2");
    expect(spec.security).toHaveLength(1);
    expect(Object.keys(spec.security?.[0] ?? {}).sort()).toEqual(["mutualTls", "partnerOAuth"]);
  });
});
describe("SH-05 \u2014 no sequencing shortcut is expressible", () => {
  it("exposes no review action on a partner-authenticated API", () => {
    const reviewish = operations().filter(
      ({ path, op }) => /approve|reject|decision|review|override|force/i.test(`${path} ${op.operationId ?? ""}`)
    );
    expect(reviewish.map((r) => r.op.operationId)).toEqual([]);
  });
  it("can only ever report a transaction in DRAFT", () => {
    const request = spec.components.schemas["OriginationRequest"];
    const transaction = request.properties["transaction"];
    expect(transaction.properties["state"]?.["const"]).toBe("DRAFT");
  });
  it("does not expose KEYING, which is an internal screen state", () => {
    const states = spec.components.schemas["RequestState"]?.["enum"];
    expect(states).not.toContain("KEYING");
  });
  it("enumerates only the two partner channels", () => {
    const request = spec.components.schemas["OriginationRequest"];
    expect(request.properties["channel"]?.["enum"]).toEqual([
      "PARTNER_API",
      "EMBEDDED_AGGREGATOR"
    ]);
  });
});
describe("the contract agrees with the domain it fronts", () => {
  it("lists exactly the control codes the kernel defines", async () => {
    const declared = spec.components.schemas["ControlCode"]?.["enum"];
    const shariah = Array.from({ length: 18 }, (_, i) => `SH-${String(i + 1).padStart(2, "0")}`);
    const operational = ["OP-DETERMINACY", "OP-CHAIN", "OP-LIMIT"];
    expect(declared).toEqual([...shariah, ...operational]);
  });
  it("exposes every request state the domain can reach externally", async () => {
    const declared = new Set(spec.components.schemas["RequestState"]?.["enum"]);
    expect(declared).toEqual(
      /* @__PURE__ */ new Set([
        "AWAITING_SERVICING_RESPONSE",
        "AWAITING_REVIEW",
        "RETURNED_TO_MAKER",
        "APPROVED",
        "REJECTED",
        "WITHDRAWN"
      ])
    );
  });
  it("requires a trade on every raise, so there is no amount-only path", async () => {
    const raise = spec.components.schemas["RaiseRequest"];
    expect(raise.required).toContain("tradeReference");
  });
  it("requires a merchant mandate from an aggregator, not from the aggregator alone", () => {
    const aggregator = spec.components.schemas["AggregatorInitiator"];
    expect(aggregator.required).toContain("merchantMandateRef");
  });
  it("carries the attestation with every instant that has contractual effect", () => {
    const instant = spec.components.schemas["AttestedInstant"];
    expect(instant.required).toEqual(expect.arrayContaining(["instant", "attestationRef"]));
  });
});
