// Copies the Web SDK's static assets into the ops app's public directory so the
// viewer loads them same-origin (no vendor CDN in the page). The target is
// gitignored; run after `npm install` and after an SDK upgrade.
//
// The SDK's .NET runtime (`nutrient-viewer-lib/gdpicture-<hash>/`) is left out (SR-049). It
// converts Office files in the browser and carries System.Security.Cryptography.Pkcs 10.0.5
// (CVE-2026-84008), which no Nutrient release has yet replaced. SANAD accepts only PDF, PNG and
// JPEG; the viewer opens all three without it (PDF and PNG never ask for it, a JPEG asks, is
// refused and opens anyway), verified with SDK 1.24.0 on 2026-10-27.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** True for the .NET runtime directory, which is never copied. */
export const isDotnetRuntime = (path) => /^gdpicture-[0-9a-f]+$/.test(basename(path));

export function copyViewerAssets(source, target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(source, 'nutrient-viewer-lib'), join(target, 'nutrient-viewer-lib'), {
    recursive: true,
    filter: (path) => !isDotnetRuntime(path),
  });
  cpSync(join(source, 'nutrient-viewer.js'), join(target, 'nutrient-viewer.js'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = join(root, 'node_modules/@nutrient-sdk/viewer/dist');
  if (!existsSync(source)) {
    console.error('SDK not installed: npm install first');
    process.exit(1);
  }
  copyViewerAssets(source, join(root, 'apps/ops/public/nutrient'));
  console.log('copied Web SDK assets to apps/ops/public/nutrient (without the .NET runtime, SR-049)');
}
