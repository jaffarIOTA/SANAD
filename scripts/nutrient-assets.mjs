// Copies the Web SDK's static assets into the ops app's public directory so the
// viewer loads them same-origin (no vendor CDN in the page). The target is
// gitignored; run after `npm install` and after an SDK upgrade.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules/@nutrient-sdk/viewer/dist');
const target = join(root, 'apps/ops/public/nutrient');
if (!existsSync(source)) { console.error('SDK not installed: npm install first'); process.exit(1); }
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(source, 'nutrient-viewer-lib'), join(target, 'nutrient-viewer-lib'), { recursive: true });
cpSync(join(source, 'nutrient-viewer.js'), join(target, 'nutrient-viewer.js'));
console.log('copied Web SDK assets to apps/ops/public/nutrient');
