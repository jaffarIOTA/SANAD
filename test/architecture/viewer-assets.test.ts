/**
 * SR-049: the document viewer ships without the SDK's .NET runtime, which carries
 * System.Security.Cryptography.Pkcs 10.0.5 (CVE-2026-84008). The copy is run from the
 * installed SDK into a scratch directory and its result read, not the script's text.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { copyViewerAssets, isDotnetRuntime } from '../../scripts/nutrient-assets.mjs';

const source = join(process.cwd(), 'node_modules/@nutrient-sdk/viewer/dist');

describe('the viewer assets (SR-049)', () => {
  it('names only the hashed runtime directory as the .NET runtime', () => {
    expect(isDotnetRuntime('/x/nutrient-viewer-lib/gdpicture-4bd46a6d')).toBe(true);
    expect(isDotnetRuntime('/x/nutrient-viewer-lib/gdpicture-worker.js')).toBe(false);
    expect(isDotnetRuntime('/x/nutrient-viewer-lib/chunk-gdpicture-3abae87dcb1d7298.js')).toBe(false);
  });

  it.skipIf(!existsSync(source))('copies the viewer without the .NET runtime or any Pkcs assembly', () => {
    const target = mkdtempSync(join(tmpdir(), 'sanad-viewer-'));
    try {
      copyViewerAssets(source, target);
      const lib = join(target, 'nutrient-viewer-lib');
      expect(existsSync(join(target, 'nutrient-viewer.js'))).toBe(true);
      const entries = readdirSync(lib, { recursive: true }).map(String);
      expect(entries.some((e) => e.endsWith('.wasm'))).toBe(true);
      expect(entries.filter((e) => /gdpicture-[0-9a-f]+(\/|$)/.test(e))).toEqual([]);
      expect(entries.filter((e) => /Cryptography\.Pkcs/i.test(e) || e.endsWith('sbom.cdx.json'))).toEqual([]);
      for (const e of entries.filter((x) => x.endsWith('.js')))
        expect(readFileSync(join(lib, e), 'utf8')).not.toContain('System.Security.Cryptography.Pkcs');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
