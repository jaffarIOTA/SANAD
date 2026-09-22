import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const kong = parse(read("gateway/kong/kong.yaml"));
function sourcesUnder(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if ([".ts", ".tsx"].includes(extname(entry))) out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}
describe("\xA75 \u2014 gateway concerns are configuration, not code", () => {
  it("declares a directory for each implementation", () => {
    expect(existsSync(join(ROOT, "gateway/kong"))).toBe(true);
    expect(existsSync(join(ROOT, "gateway/ibm"))).toBe(true);
  });
  it("parses the Kong configuration", () => {
    expect(kong._format_version).toMatch(/^3\./);
    expect(kong.services.length).toBeGreaterThan(0);
  });
  it("names no environment host in the configuration", () => {
    const raw = read("gateway/kong/kong.yaml");
    const hosts = raw.match(/https?:\/\/[a-z0-9.-]+/gi) ?? [];
    const realHosts = hosts.filter((h) => !h.includes("docs.konghq.com"));
    expect(realHosts).toEqual([]);
  });
});
describe("\xA75 \u2014 the gateway is not the security boundary", () => {
  const pluginNames = (kong.plugins ?? []).map((p) => p.name);
  it("configures no authentication plugin", () => {
    const auth = [
      "key-auth",
      "jwt",
      "openid-connect",
      "oauth2",
      "basic-auth",
      "hmac-auth",
      "ldap-auth",
      "mtls-auth",
      "session"
    ];
    expect(pluginNames.filter((n) => auth.includes(n))).toEqual([]);
  });
  it("configures nothing that rewrites a request or a response", () => {
    const transformers = [
      "request-transformer",
      "request-transformer-advanced",
      "response-transformer",
      "response-transformer-advanced"
    ];
    expect(pluginNames.filter((n) => transformers.includes(n))).toEqual([]);
  });
  it("uses only plugins in the open-source distribution", () => {
    const openSource = /* @__PURE__ */ new Set([
      "rate-limiting",
      "request-size-limiting",
      "correlation-id",
      "cors",
      "ip-restriction",
      "request-termination",
      "file-log",
      "syslog",
      "prometheus"
    ]);
    const enterprise = pluginNames.filter((n) => !openSource.has(n));
    expect(enterprise).toEqual([]);
  });
  it("never retries an upstream request", () => {
    for (const service of kong.services) {
      expect(service.retries, `${service.name} retries`).toBe(0);
    }
  });
  it("exposes no plaintext listener", () => {
    for (const service of kong.services) {
      for (const route of service.routes ?? []) {
        expect(route.protocols).toEqual(["https"]);
      }
    }
  });
  it("allows no browser origin on a server-to-server API", () => {
    const cors = (kong.plugins ?? []).find((p) => p.name === "cors");
    expect(cors?.config?.["origins"]).toEqual([]);
  });
});
describe("\xA75 \u2014 no service depends on a gateway having run", () => {
  const surfaces = ["services", "apps/ops/src", "apps/sme/src", "core", "adapters"];
  it.each(surfaces)("%s reads no gateway-injected header", (surface) => {
    const injected = /x-consumer-|x-anonymous-consumer|x-credential-|x-authenticated-(scope|userid)|x-kong-|x-ibm-client|x-datapower/i;
    const offenders = [];
    for (const file of sourcesUnder(surface)) {
      const source = readFileSync(file, "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (injected.test(code)) offenders.push(relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });
  it("names no gateway product inside core", () => {
    const offenders = [];
    for (const file of sourcesUnder("core")) {
      if (/\b(kong|konnect|datapower|api connect|apigee)\b/i.test(readFileSync(file, "utf8"))) {
        offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
  it("keeps the two implementations in step", () => {
    const ibm = read("gateway/ibm/README.md");
    for (const plugin of (kong.plugins ?? []).map((p) => p.name)) {
      expect(ibm, `IBM README covers ${plugin}`).toContain(plugin);
    }
  });
});
