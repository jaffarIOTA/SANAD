import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CODE_EXTENSIONS = /* @__PURE__ */ new Set([".ts", ".tsx", ".js", ".sql", ".json"]);
function filesUnder(dir) {
  const absolute = join(ROOT, dir);
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (CODE_EXTENSIONS.has(extname(entry))) {
        out.push(full);
      }
    }
  };
  walk(absolute);
  return out;
}
const read = (file) => readFileSync(file, "utf8");
const rel = (file) => relative(ROOT, file);
function codeOnly(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const RATE_IDENTIFIERS = [
  ["interest", "rate"],
  ["profit", "rate"],
  ["accrued", "interest"],
  ["compounding", "frequency"],
  ["penalty", "rate"],
  ["rate", "index"],
  ["nominal", "rate"],
  ["effective", "rate"],
  ["markup", "rate"]
].flatMap(([a, b]) => [
  `${a}_${b}`,
  `${a}${b.charAt(0).toUpperCase()}${b.slice(1)}`,
  `${a.toUpperCase()}_${b.toUpperCase()}`
]);
const ANNUALISED = ["a", "p", "r"].join("");
describe("SH-01 \u2014 no rate construct exists anywhere", () => {
  const surfaces = ["core", "config", "adapters", "supabase/migrations"];
  it.each(surfaces)("%s declares no rate identifier", (surface) => {
    const offenders = [];
    for (const file of filesUnder(surface)) {
      const content = read(file);
      for (const identifier of RATE_IDENTIFIERS) {
        if (content.includes(identifier)) offenders.push(`${rel(file)}: ${identifier}`);
      }
      if (new RegExp(`\\b${ANNUALISED}\\b`, "i").test(content)) {
        offenders.push(`${rel(file)}: annualised percentage`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("the transaction aggregate exposes cost, profit and total and nothing rate-shaped", async () => {
    const { priceMurabaha } = await import(../../core/pricing/murabaha.js);
    const { money } = await import(../../core/kernel/money.js);
    const { expectOk } = await import(../../core/kernel/result.js);
    const pricing = expectOk(priceMurabaha(money(100000n), money(2500n)));
    expect(Object.keys(pricing).sort()).toEqual([
      "costAmount",
      "profitAmount",
      "salePriceAmount"
    ]);
    expect(pricing.salePriceAmount.minorUnits).toBe(102500n);
  });
});
describe("SH-06 \u2014 the domain reads no clock", () => {
  const CLOCK_READS = [
    ["new", "Date("],
    ["Date", "now("],
    ["performance", "now("],
    ["process", "hrtime("]
  ].map(([a, b]) => a === "new" ? `${a} ${b}` : `${a}.${b}`);
  it("core contains no clock read", () => {
    const offenders = [];
    for (const file of filesUnder("core")) {
      const content = codeOnly(read(file));
      for (const expression of CLOCK_READS) {
        if (content.includes(expression)) offenders.push(`${rel(file)}: ${expression}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it('core exports no function that answers "what time is it"', () => {
    const offenders = [];
    for (const file of filesUnder("core")) {
      if (/export\s+(const|function|async function)\s+now\b/.test(codeOnly(read(file)))) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
describe("AP-04 \u2014 vendor concepts stop at the adapter", () => {
  const VENDOR_NAMES = [
    "tuum",
    "nutrient",
    "zatca",
    "fatoora",
    "nafath",
    "wathq",
    "simah",
    "bayan",
    "etimad",
    "kafalah",
    "sarie",
    "monsha",
    "supabase",
    "postgrest",
    "kong",
    "datapower",
    "temporal",
    "kafka"
  ];
  it("core names no vendor or national rail", () => {
    const offenders = [];
    for (const file of filesUnder("core")) {
      const content = read(file).toLowerCase();
      for (const vendor of VENDOR_NAMES) {
        if (content.includes(vendor)) offenders.push(`${rel(file)}: ${vendor}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("core names no client or institution", () => {
    const CLIENT_IDENTIFIERS = ["bank-a", "fintech-b", "bank_a", "fintech_b"];
    const offenders = [];
    for (const file of filesUnder("core")) {
      const content = read(file).toLowerCase();
      for (const client of CLIENT_IDENTIFIERS) {
        if (content.includes(client)) offenders.push(`${rel(file)}: ${client}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("core imports nothing from adapters, config or apps", () => {
    const offenders = [];
    for (const file of filesUnder("core")) {
      for (const match of read(file).matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1] ?? "";
        if (/(^|\/)(adapters|config|apps)\//.test(specifier)) {
          offenders.push(`${rel(file)} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
  it("the core banking adapter carries no lending path", () => {
    const LENDING_PATHS = [/\/api\/v\d+\/(loans|contracts|offers)\b/, /loan-api/];
    const offenders = [];
    for (const file of filesUnder("adapters/tuum")) {
      if (!file.endsWith(".ts")) continue;
      for (const line of codeOnly(read(file)).split("\n")) {
        for (const pattern of LENDING_PATHS) {
          if (pattern.test(line) && !line.includes("LENDING_HOST")) {
            offenders.push(`${rel(file)}: ${line.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
  it("each adapter declares its deviations and names its verification item", async () => {
    const { TUUM_DEVIATIONS } = await import(../../adapters/tuum/core-banking-adapter.js);
    const { NUTRIENT_DEVIATIONS } = await import(../../adapters/nutrient/document-adapter.js);
    for (const deviations of [TUUM_DEVIATIONS, NUTRIENT_DEVIATIONS]) {
      expect(deviations.length).toBeGreaterThan(0);
      for (const deviation of deviations) {
        expect(deviation.containment.length).toBeGreaterThan(0);
        expect(deviation.verificationRef).toBeTruthy();
      }
    }
  });
});
describe("ADR 0001 \u2014 platform coupling stays quarantined", () => {
  const QUARANTINED = ["0001_integration_credentials.sql", "0005_vault_extension_guard.sql"];
  const otherMigrations = () => filesUnder("supabase/migrations").filter((f) => !QUARANTINED.some((q) => f.endsWith(q)));
  it("the secret store is referenced only in the quarantined migrations", () => {
    const offenders = [];
    for (const file of otherMigrations()) {
      const content = read(file);
      for (const token of ["vault.", "supabase_vault"]) {
        if (content.includes(token)) offenders.push(`${rel(file)}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("no migration revokes from a platform role without guarding its existence", () => {
    const offenders = [];
    for (const file of otherMigrations()) {
      for (const line of read(file).split("\n")) {
        if (/^\s*(--)/.test(line)) continue;
        if (/revoke[^;]*\bfrom\b[^;]*\b(anon|authenticated|service_role)\b/.test(line)) {
          offenders.push(`${rel(file)}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
  it("records the decision rather than leaving it implicit", () => {
    const adr = read(join(ROOT, "docs/adr/0001-data-residency-and-datastore.md"));
    expect(adr).toContain("Status:** Accepted");
    expect(adr.toLowerCase()).toContain("in-kingdom");
  });
});
describe("no domain table lives in the exposed schema", () => {
  it("migrations create nothing in the schema PostgREST exposes", () => {
    const offenders = [];
    for (const file of filesUnder("supabase/migrations")) {
      const content = read(file);
      if (/create\s+table\s+(if\s+not\s+exists\s+)?public\./i.test(content)) {
        offenders.push(rel(file));
      }
      for (const match of content.matchAll(/create\s+table\s+(if\s+not\s+exists\s+)?([\w.]+)/gi)) {
        const name = match[2] ?? "";
        if (!name.includes(".")) offenders.push(`${rel(file)}: unqualified table ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("every domain table enables row-level security", () => {
    for (const file of filesUnder("supabase/migrations")) {
      const content = read(file);
      const created = [...content.matchAll(/create\s+table\s+if\s+not\s+exists\s+([\w.]+)/gi)].map(
        (m) => m[1] ?? ""
      );
      if (created.length === 0) continue;
      expect(
        /enable row level security/i.test(content),
        `${rel(file)} creates tables but never enables row-level security`
      ).toBe(true);
    }
  });
});
