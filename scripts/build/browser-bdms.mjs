import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import bundle from './browser-bundle.cjs';

const root = fileURLToPath(new URL('../../src/anti-bot/', import.meta.url));
const output = fileURLToPath(new URL('../../lib/desktop/assets/bdms.js', import.meta.url));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, bundle.buildDesktopBdmsAsset(root));
await writeFile(fileURLToPath(new URL('../../lib/desktop/assets/dtrait.js', import.meta.url)), bundle.buildDesktopDTraitAsset(root));
// The combined asset includes DTrait; load it instead of dtrait.js in a WebSecure realm.
await writeFile(fileURLToPath(new URL('../../lib/desktop/assets/web-secure.js', import.meta.url)), bundle.buildDesktopWebSecureAsset(root));
// Preserve the upstream licenses alongside the redistributed browser code.
const { createRequire } = await import('node:module');
const { readFile } = await import('node:fs/promises');
const require = createRequire(import.meta.url);
for (const name of ['crypto-js', 'jsencrypt']) {
  const packageRoot = dirname(require.resolve(name + '/package.json'));
  await writeFile(fileURLToPath(new URL('../../lib/desktop/assets/' + name + '.LICENSE', import.meta.url)), await readFile(packageRoot + (name === 'jsencrypt' ? '/LICENSE.txt' : '/LICENSE')));
}
