import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
function tsconfigPaths() {
  const tsconfig = JSON.parse(readFileSync(`${ROOT}tsconfig.json`, "utf8"));
  const out = {};
  for (const [alias, targets] of Object.entries(tsconfig.compilerOptions.paths)) {
    if (!alias.startsWith("@sanad/")) continue;
    const target = targets[0];
    if (target === void 0) continue;
    out[alias.replace(/\/\*$/, "")] = target.replace(/\/\*$/, "");
  }
  return out;
}
function vitestAliases() {
  const source = readFileSync(`${ROOT}vitest.config.ts`, "utf8");
  const out = {};
  for (const match of source.matchAll(/'(@sanad\/[\w-]+)':\s*dir\('\.\/([^']+)'\)/g)) {
    const [, alias, target] = match;
    if (alias !== void 0 && target !== void 0) out[alias] = target;
  }
  return out;
}
describe("module aliases agree across the compiler and the test runner", () => {
  it("maps the same names", () => {
    expect(Object.keys(vitestAliases()).sort()).toEqual(Object.keys(tsconfigPaths()).sort());
  });
  it("maps them to the same directories", () => {
    expect(vitestAliases()).toEqual(tsconfigPaths());
  });
});
