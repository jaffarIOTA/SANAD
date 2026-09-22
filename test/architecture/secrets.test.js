import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE_EXTENSIONS = /* @__PURE__ */ new Set([".ts", ".tsx", ".sql", ".json", ".yaml", ".yml"]);
const SURFACES = ["core", "config", "adapters", "apps", "packages", "supabase", "api"];
function filesUnder(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (SOURCE_EXTENSIONS.has(extname(entry))) out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}
const rel = (file) => relative(ROOT, file);
const tracked = () => execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
const SECRET_SHAPED = /(token|secret|password|passwd|api[_-]?key|credential|private[_-]?key)/i;
describe("\xA74 \u2014 no secret is committed", () => {
  it("tracks no environment file except the example", () => {
    const offenders = tracked().filter(
      (f) => /(^|\/)\.env/.test(f) && !f.endsWith(".env.example")
    );
    expect(offenders).toEqual([]);
  });
  it("keeps the example free of values", () => {
    const lines = readFileSync(join(ROOT, ".env.example"), "utf8").split("\n");
    const withValues = lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) return false;
      const [, value = ""] = trimmed.split(/=(.*)/s);
      return value.trim().length > 0;
    });
    expect(withValues).toEqual([]);
  });
  it("commits no key or certificate file", () => {
    const offenders = tracked().filter((f) => /\.(pem|p12|pfx|key|jks|keystore)$/i.test(f));
    expect(offenders).toEqual([]);
  });
  it("assigns no long opaque literal to a secret-named field", () => {
    const assignment = /(token|secret|password|api[_-]?key|credential)\w*\s*[:=]\s*['"`]([A-Za-z0-9_\-+/=.]{24,})['"`]/gi;
    const offenders = [];
    for (const surface of SURFACES) {
      for (const file of filesUnder(surface)) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(assignment)) {
          const value = match[2] ?? "";
          if (/^(development|example|placeholder|redacted|changeme|test|fixture)/i.test(value)) {
            continue;
          }
          if (/^\$\{/.test(value)) continue;
          offenders.push(`${rel(file)}: ${match[1] ?? ""}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
describe("\xA74 \u2014 no secret reaches the browser", () => {
  it("gives no secret-shaped variable a NEXT_PUBLIC_ prefix", () => {
    const offenders = [];
    const check = (source, where) => {
      for (const match of source.matchAll(/NEXT_PUBLIC_([A-Z0-9_]+)/g)) {
        const name = match[1] ?? "";
        if (SECRET_SHAPED.test(name)) offenders.push(`${where}: NEXT_PUBLIC_${name}`);
      }
    };
    for (const surface of SURFACES) {
      for (const file of filesUnder(surface)) check(readFileSync(file, "utf8"), rel(file));
    }
    check(readFileSync(join(ROOT, ".env.example"), "utf8"), ".env.example");
    expect(offenders).toEqual([]);
  });
  it("reads no environment variable inside core", () => {
    const offenders = [];
    for (const file of filesUnder("core")) {
      if (/process\s*\.\s*env/.test(readFileSync(file, "utf8"))) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });
  it("reads no secret-shaped environment variable inside a component tree", () => {
    const offenders = [];
    for (const surface of ["apps", "packages"]) {
      for (const file of filesUnder(surface)) {
        if (extname(file) !== ".tsx") continue;
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/process\s*\.\s*env\s*[.[]\s*['"`]?([A-Z0-9_]+)/g)) {
          const name = match[1] ?? "";
          if (SECRET_SHAPED.test(name)) offenders.push(`${rel(file)}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
describe("\xA74 \u2014 the credential store has no plaintext column", () => {
  it("never adds a value column to config.integration_credential", () => {
    const migrations = filesUnder("supabase/migrations").map((f) => readFileSync(f, "utf8")).join("\n");
    expect(migrations).not.toMatch(/add\s+column\s+(secret_value|plaintext|api_key_value)/i);
    expect(migrations).toMatch(/vault_secret_id/);
  });
});
