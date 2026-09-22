import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BASE_PATH,
  createService,
  developmentTimestamps
} from "../../services/origination/src/server.js";
import { inMemoryIdempotencyStore } from "../../services/origination/src/idempotency.js";
import { inMemoryRequestRepository } from "../../services/origination/src/repository.js";
import { createHash } from "node:crypto";
const PARTNER_TOKEN = "test-token-partner";
const AGGREGATOR_TOKEN = "test-token-aggregator";
const OTHER_PARTNER_TOKEN = "test-token-other-partner";
const READ_ONLY_TOKEN = "test-token-read-only";
const PARTNER = {
  partnerId: "partner-01",
  tenantId: "bank-a",
  channel: "PARTNER_API",
  scopes: ["origination:read", "origination:write"],
  credentialRef: "cred-01"
};
const AGGREGATOR = {
  partnerId: "aggregator-01",
  tenantId: "bank-a",
  channel: "EMBEDDED_AGGREGATOR",
  scopes: ["origination:read", "origination:write"],
  credentialRef: "cred-02"
};
const OTHER_PARTNER = {
  partnerId: "partner-02",
  tenantId: "bank-a",
  channel: "PARTNER_API",
  scopes: ["origination:read", "origination:write"],
  credentialRef: "cred-03"
};
const READ_ONLY = {
  partnerId: "partner-03",
  tenantId: "bank-a",
  channel: "PARTNER_API",
  scopes: ["origination:read"],
  credentialRef: "cred-04"
};
const sha = (v) => createHash("sha256").update(v, "utf8").digest("hex");
const registry = {
  findByTokenDigest(digest) {
    const table = /* @__PURE__ */ new Map([
      [sha(PARTNER_TOKEN), PARTNER],
      [sha(AGGREGATOR_TOKEN), AGGREGATOR],
      [sha(OTHER_PARTNER_TOKEN), OTHER_PARTNER],
      [sha(READ_ONLY_TOKEN), READ_ONLY]
    ]);
    return table.get(digest);
  }
};
let server;
let origin;
beforeAll(async () => {
  server = createService({
    repository: inMemoryRequestRepository(),
    idempotency: inMemoryIdempotencyStore(),
    credentials: registry,
    timestamps: developmentTimestamps()
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${String(address.port)}${BASE_PATH}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(() => {
    resolve();
  }));
});
function validBody(overrides = {}) {
  return {
    programmeId: "018f3a2c-7b41-7c9e-9a11-3f0c2d5e6a70",
    counterpartyId: "018f3a2c-7b41-7c9e-9a11-4b1d3e6f7a81",
    tradeReference: {
      type: "PURCHASE_ORDER",
      issuerCr: "1010223344",
      recipientCr: "2050667788"
    },
    requestedAmount: { minorUnits: "48500000", currency: "SAR" },
    requestedTenorDays: 90,
    initiator: { kind: "PARTNER_SYSTEM" },
    ...overrides
  };
}
async function call(method, path, options = {}) {
  const headers = { "content-type": "application/json" };
  const token = options.token ?? PARTNER_TOKEN;
  if (token !== "") headers["authorization"] = `Bearer ${token}`;
  if (options.idempotencyKey !== null) {
    headers["idempotency-key"] = options.idempotencyKey ?? randomUUID();
  }
  if (options.correlationId !== void 0) headers["x-correlation-id"] = options.correlationId;
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    ...options.body === void 0 ? {} : { body: JSON.stringify(options.body) }
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === "" ? void 0 : JSON.parse(text)
  };
}
describe("raising a request", () => {
  it("accepts a well-formed request and parks it with the servicing platform", async () => {
    const response = await call("POST", "/requests", { body: validBody() });
    expect(response.status).toBe(201);
    expect(response.body.state).toBe("AWAITING_SERVICING_RESPONSE");
    expect(response.body.channel).toBe("PARTNER_API");
    expect(response.headers.get("location")).toContain("/requests/");
    expect(response.headers.get("x-correlation-id")).toBeTruthy();
  });
  it("returns the amount as a digit string, never a number", async () => {
    const response = await call("POST", "/requests", { body: validBody() });
    expect(response.body.requestedAmount.minorUnits).toBe("48500000");
    expect(typeof response.body.requestedAmount.minorUnits).toBe("string");
  });
  it("carries the attestation with the instant", async () => {
    const response = await call("POST", "/requests", { body: validBody() });
    expect(response.body.raisedAt.instant).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(response.body.raisedAt.attestationRef.length).toBeGreaterThan(0);
  });
  it("never exposes internal staff identity", async () => {
    const response = await call("POST", "/requests", { body: validBody() });
    const serialised = JSON.stringify(response.body);
    for (const leak of ["maker", "checker", "reviewer", "principalId"]) {
      expect(serialised).not.toContain(leak);
    }
  });
  it("echoes the caller\u2019s correlation identifier", async () => {
    const correlationId = randomUUID();
    const response = await call("POST", "/requests", { body: validBody(), correlationId });
    expect(response.headers.get("x-correlation-id")).toBe(correlationId);
    expect(response.body.correlationId).toBe(correlationId);
  });
});
describe("SH-01 \u2014 a rate cannot be posted", () => {
  it("refuses a proportion-shaped field rather than dropping it", async () => {
    const response = await call("POST", "/requests", {
      body: validBody({ profitRate: 0.025 })
    });
    expect(response.status).toBe(400);
    expect(response.body.control).toBe("SH-01");
    expect(response.body.reason).toBe("UNKNOWN_PROPERTY");
    expect(response.body.detailAr).toMatch(/[؀-ۿ]/);
    expect(JSON.stringify(response.body)).not.toContain("profitRate");
  });
  it("refuses any unknown property, not a hardcoded list", async () => {
    const response = await call("POST", "/requests", {
      body: validBody({ someFieldInventedToday: "x" })
    });
    expect(response.status).toBe(400);
    expect(response.body.reason).toBe("UNKNOWN_PROPERTY");
  });
});
describe("\xA78 \u2014 the client cannot choose its tenant, channel or identity", () => {
  it("refuses a body claiming a tenant", async () => {
    const response = await call("POST", "/requests", { body: validBody({ tenantId: "bank-b" }) });
    expect(response.status).toBe(400);
    expect(response.body.reason).toBe("UNKNOWN_PROPERTY");
  });
  it("refuses a body claiming a channel", async () => {
    const response = await call("POST", "/requests", {
      body: validBody({ channel: "MAKER_CHECKER" })
    });
    expect(response.status).toBe(400);
  });
  it("derives the channel from the credential", async () => {
    const asAggregator = await call("POST", "/requests", {
      token: AGGREGATOR_TOKEN,
      body: validBody({
        initiator: { kind: "AGGREGATOR_ON_BEHALF", merchantMandateRef: "mnd_1" }
      })
    });
    expect(asAggregator.status).toBe(201);
    expect(asAggregator.body.channel).toBe("EMBEDDED_AGGREGATOR");
  });
  it("refuses an aggregator that omits the merchant\u2019s mandate", async () => {
    const response = await call("POST", "/requests", {
      token: AGGREGATOR_TOKEN,
      body: validBody({ initiator: { kind: "PARTNER_SYSTEM" } })
    });
    expect(response.status).toBe(422);
    expect(response.body.reason).toBe("MERCHANT_MANDATE_EMPTY");
    expect(response.body.detailAr).toMatch(/[؀-ۿ]/);
  });
});
describe("\xA78 \u2014 idempotency", () => {
  it("requires the header on a state-changing request", async () => {
    const response = await call("POST", "/requests", {
      body: validBody(),
      idempotencyKey: null
    });
    expect(response.status).toBe(400);
    expect(response.body.reason).toBe("IDEMPOTENCY_KEY_MISSING");
  });
  it("replays the original result rather than executing twice", async () => {
    const key = randomUUID();
    const body = validBody();
    const first = await call("POST", "/requests", { body, idempotencyKey: key });
    const second = await call("POST", "/requests", { body, idempotencyKey: key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replay")).toBe("true");
    expect(second.body.requestId).toBe(first.body.requestId);
  });
  it("does not create a second request on replay", async () => {
    const key = randomUUID();
    const body = validBody({ partnerReference: "replay-probe" });
    await call("POST", "/requests", { body, idempotencyKey: key });
    await call("POST", "/requests", { body, idempotencyKey: key });
    const listed = await call("GET", "/requests", { idempotencyKey: null });
    const matching = listed.body.items.filter(
      (i) => i.partnerReference === "replay-probe"
    );
    expect(matching).toHaveLength(1);
  });
  it("refuses a key reused with a different body", async () => {
    const key = randomUUID();
    await call("POST", "/requests", { body: validBody(), idempotencyKey: key });
    const conflict = await call("POST", "/requests", {
      body: validBody({ requestedTenorDays: 30 }),
      idempotencyKey: key
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.reason).toBe("IDEMPOTENCY_KEY_REUSED");
  });
  it("never serves one partner the stored response of another", async () => {
    const key = randomUUID();
    const mine = await call("POST", "/requests", {
      body: validBody({ partnerReference: "partner-01-confidential" }),
      idempotencyKey: key
    });
    const theirs = await call("POST", "/requests", {
      token: OTHER_PARTNER_TOKEN,
      body: validBody({ partnerReference: "partner-02-own" }),
      idempotencyKey: key
    });
    expect(theirs.body.requestId).not.toBe(mine.body.requestId);
    expect(theirs.body.partnerReference).toBe("partner-02-own");
    expect(JSON.stringify(theirs.body)).not.toContain("partner-01-confidential");
  });
  it("scopes keys per tenant-partner, so one caller cannot consume another\u2019s", async () => {
    const key = randomUUID();
    const body = validBody();
    const mine = await call("POST", "/requests", { body, idempotencyKey: key });
    const theirs = await call("POST", "/requests", {
      token: OTHER_PARTNER_TOKEN,
      body,
      idempotencyKey: key
    });
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    expect(theirs.headers.get("idempotent-replay")).toBeNull();
  });
  it("replays a refusal too, so a retry does not get a different answer", async () => {
    const key = randomUUID();
    const body = validBody({ profitRate: 0.01 });
    const first = await call("POST", "/requests", { body, idempotencyKey: key });
    const second = await call("POST", "/requests", { body, idempotencyKey: key });
    expect(first.status).toBe(400);
    expect(second.status).toBe(400);
    expect(second.headers.get("idempotent-replay")).toBe("true");
  });
});
describe("authentication and scope", () => {
  it("refuses an unauthenticated call", async () => {
    const response = await call("POST", "/requests", { token: "", body: validBody() });
    expect(response.status).toBe(401);
    expect(response.body.reason).toBe("CREDENTIAL_MISSING");
  });
  it("refuses an unrecognised credential", async () => {
    const response = await call("POST", "/requests", {
      token: "not-a-real-token",
      body: validBody()
    });
    expect(response.status).toBe(401);
    expect(response.body.reason).toBe("CREDENTIAL_NOT_RECOGNISED");
  });
  it("refuses a write from a read-only credential", async () => {
    const response = await call("POST", "/requests", {
      token: READ_ONLY_TOKEN,
      body: validBody()
    });
    expect(response.status).toBe(403);
    expect(response.body.reason).toBe("SCOPE_INSUFFICIENT");
  });
  it("never echoes the credential in a problem body", async () => {
    const response = await call("POST", "/requests", {
      token: "secret-value-that-must-not-appear",
      body: validBody()
    });
    expect(JSON.stringify(response.body)).not.toContain("secret-value-that-must-not-appear");
  });
  it("reports another partner\u2019s request as absent, not forbidden", async () => {
    const mine = await call("POST", "/requests", { body: validBody() });
    const theirs = await call("GET", `/requests/${mine.body.requestId}`, {
      token: OTHER_PARTNER_TOKEN,
      idempotencyKey: null
    });
    expect(theirs.status).toBe(404);
  });
});
describe("withdrawal", () => {
  it("withdraws a request still with the servicing platform", async () => {
    const raised = await call("POST", "/requests", { body: validBody() });
    const withdrawn = await call("PUT", `/requests/${raised.body.requestId}/withdrawal`, {
      body: { reason: "Counterparty cancelled the order." }
    });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.state).toBe("WITHDRAWN");
  });
  it("is idempotent by nature, which is why it is a PUT", async () => {
    const raised = await call("POST", "/requests", { body: validBody() });
    const path = `/requests/${raised.body.requestId}/withdrawal`;
    const once = await call("PUT", path, { body: { reason: "Changed our mind." } });
    const twice = await call("PUT", path, { body: { reason: "Changed our mind." } });
    expect(once.status).toBe(200);
    expect(twice.status).toBe(200);
    expect(twice.headers.get("idempotent-replay")).toBeNull();
    expect(twice.body.state).toBe("WITHDRAWN");
  });
  it("requires a reason", async () => {
    const raised = await call("POST", "/requests", { body: validBody() });
    const response = await call("PUT", `/requests/${raised.body.requestId}/withdrawal`, {
      body: {}
    });
    expect(response.status).toBe(400);
  });
});
describe("transport", () => {
  it("returns problem+json on every error", async () => {
    const response = await call("GET", "/requests/not-a-request", { idempotencyKey: null });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });
  it("refuses malformed JSON without a stack trace", async () => {
    const raw = await fetch(`${origin}/requests`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${PARTNER_TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID()
      },
      body: "{ not json"
    });
    const body = await raw.json();
    expect(raw.status).toBe(400);
    expect(body.reason).toBe("MALFORMED_JSON");
    expect(JSON.stringify(body)).not.toMatch(/at .*\.ts:\d+/);
  });
  it("rejects an unknown route", async () => {
    const response = await call("GET", "/nonexistent", { idempotencyKey: null });
    expect(response.status).toBe(404);
  });
  it("rejects a disallowed method", async () => {
    const response = await call("DELETE", "/requests", { idempotencyKey: null });
    expect(response.status).toBe(405);
  });
  it("never sets a cacheable header on a response", async () => {
    const response = await call("POST", "/requests", { body: validBody() });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("reads no gateway-injected header", async () => {
    const forged = await fetch(`${origin}/requests`, {
      method: "GET",
      headers: {
        "x-consumer-username": "partner-02",
        "x-consumer-id": "partner-02",
        "x-authenticated-scope": "origination:write"
      }
    });
    expect(forged.status).toBe(401);
  });
});
describe("health and readiness", () => {
  it("answers without a credential, because the kubelet holds none", async () => {
    for (const path of ["/healthz", "/readyz"]) {
      const probe = await fetch(`${origin.replace(BASE_PATH, "")}${path}`);
      expect(probe.status, path).toBe(200);
    }
  });
  it("says almost nothing", async () => {
    const probe = await fetch(`${origin.replace(BASE_PATH, "")}/healthz`);
    const body = await probe.text();
    expect(body.trim()).toBe("ok");
    expect(body).not.toMatch(/\d+\.\d+\.\d+/);
    expect(probe.headers.get("content-type")).toContain("text/plain");
  });
  it("sits outside the API base path, so the gateway never routes it", async () => {
    const underApi = await fetch(`${origin}/healthz`, {
      headers: { authorization: `Bearer ${PARTNER_TOKEN}` }
    });
    expect(underApi.status).toBe(404);
  });
  it("fails readiness while draining but stays live", async () => {
    const drainable = createService({
      repository: inMemoryRequestRepository(),
      idempotency: inMemoryIdempotencyStore(),
      credentials: registry,
      timestamps: developmentTimestamps()
    });
    await new Promise((resolve) => drainable.listen(0, "127.0.0.1", resolve));
    const port = drainable.address().port;
    const base = `http://127.0.0.1:${String(port)}`;
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    drainable.beginDraining();
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    await new Promise((resolve) => drainable.close(() => {
      resolve();
    }));
  });
});
describe("listing", () => {
  it("returns only this partner\u2019s requests", async () => {
    await call("POST", "/requests", { body: validBody({ partnerReference: "mine" }) });
    await call("POST", "/requests", {
      token: OTHER_PARTNER_TOKEN,
      body: validBody({ partnerReference: "theirs" })
    });
    const listed = await call("GET", "/requests", { idempotencyKey: null });
    const references = listed.body.items.map(
      (i) => i.partnerReference
    );
    expect(references).not.toContain("theirs");
  });
  it("filters by state", async () => {
    const listed = await call("GET", "/requests?state=WITHDRAWN", { idempotencyKey: null });
    for (const item of listed.body.items) expect(item.state).toBe("WITHDRAWN");
  });
  it("bounds the page size", async () => {
    const listed = await call("GET", "/requests?limit=1000", { idempotencyKey: null });
    expect(listed.body.items.length).toBeLessThanOrEqual(100);
  });
});
