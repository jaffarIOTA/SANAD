import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SURFACES = ["packages/design", "apps/ops/src", "apps/sme/src"];
function filesUnder(dir, extensions) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (extensions.includes(extname(entry))) out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}
const rel = (file) => relative(ROOT, file);
const PHYSICAL_UTILITY = [
  { pattern: /^-?(ml|mr|pl|pr)-/, why: "physical margin or padding \u2014 use ms-/me-/ps-/pe-" },
  { pattern: /^-?(left|right)-/, why: "physical inset \u2014 use start-/end-" },
  { pattern: /^text-(left|right)$/, why: "physical text alignment \u2014 use text-start/text-end" },
  { pattern: /^border-(l|r)(-|$)/, why: "physical border side \u2014 use border-s/border-e" },
  { pattern: /^rounded-(l|r|tl|tr|bl|br)(-|$)/, why: "physical corner \u2014 use the logical corner" },
  { pattern: /^float-(left|right)$/, why: "float \u2014 use float-start/float-end" },
  { pattern: /^(scroll-m|scroll-p)[lr]-/, why: "physical scroll spacing" }
];
const CLASS_ATTRIBUTE = /class(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{\s*['"]([^'"]*)['"]\s*\})/gs;
function classTokens(source) {
  const out = [];
  for (const match of source.matchAll(CLASS_ATTRIBUTE)) {
    const blob = match.slice(1).find((g) => g !== void 0);
    if (blob === void 0) continue;
    const line = source.slice(0, match.index).split("\n").length;
    for (const raw of blob.replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) {
      const token = raw.trim().replace(/^!/, "");
      if (token.length > 0) out.push({ token, line });
    }
  }
  return out;
}
describe("\xA76 \u2014 the interface is composed in logical properties", () => {
  it.each(SURFACES)("%s uses no physical-direction utility", (surface) => {
    const offenders = [];
    for (const file of filesUnder(surface, [".tsx"])) {
      for (const { token, line } of classTokens(readFileSync(file, "utf8"))) {
        const bare = token.split(":").at(-1) ?? token;
        for (const { pattern, why } of PHYSICAL_UTILITY) {
          if (pattern.test(bare)) offenders.push(`${rel(file)}:${String(line)} ${token} \u2014 ${why}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
  it("the stylesheets declare no physical box property", () => {
    const PHYSICAL_CSS = /(?:^|[;{\s])(?:(?:margin|padding|border)-(?:left|right)|left|right|float|clear)\s*:|text-align\s*:\s*(?:left|right)/;
    const offenders = [];
    for (const surface of [...SURFACES, "apps/ops/src", "apps/sme/src"]) {
      for (const file of filesUnder(surface, [".css"])) {
        readFileSync(file, "utf8").split("\n").forEach((line, i) => {
          if (PHYSICAL_CSS.test(line)) offenders.push(`${rel(file)}:${String(i + 1)} ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
describe("SH-01 \u2014 no rate reaches a screen", () => {
  it("the Money component declares exactly four props, none of them a rate", () => {
    const source = readFileSync(join(ROOT, "packages/design/Money.tsx"), "utf8");
    const block = /export interface MoneyProps \{([\s\S]*?)\n\}/.exec(source);
    expect(block, "MoneyProps is declared").not.toBeNull();
    const declared = [...(block?.[1] ?? "").matchAll(/^\s*readonly\s+(\w+)\??:/gm)].map(
      (m) => m[1]
    );
    expect(declared.sort()).toEqual(["labels", "locale", "numerals", "pricing"]);
  });
  it("no rendering surface names a proportion in a prop or a label", () => {
    const banned = [["rate"], ["margin"], [["a", "p", "r"].join("")], ["percent"], ["yield"]].flat();
    const offenders = [];
    for (const surface of SURFACES) {
      for (const file of filesUnder(surface, [".tsx"])) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/^\s*readonly\s+(\w+)\??:/gm)) {
          const name = (match[1] ?? "").toLowerCase();
          if (name.startsWith("margininline")) continue;
          if (banned.some((b) => name.includes(b))) {
            offenders.push(`${rel(file)}: ${match[1] ?? ""}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
