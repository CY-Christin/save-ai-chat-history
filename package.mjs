// Package the extension for Chrome Web Store review: build, safety-scan the
// bundle for credential-shaped strings, then zip dist/.
// Run `npm run package`; upload the printed zip in the CWS dashboard.
import { execSync } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

execSync('node build.mjs', { stdio: 'inherit' });

// Runtime credentials live only in chrome.storage, so nothing token-shaped
// should ever appear in the bundle — scan to make sure.
const TOKEN_RE = /ntn_[A-Za-z0-9]{20,}|secret_[A-Za-z0-9]{20,}/;
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
for await (const file of walk('dist')) {
  if (file.endsWith('.png')) continue;
  if (TOKEN_RE.test(await readFile(file, 'utf8'))) {
    console.error(`✗ token-shaped string found in ${file} — refusing to package.`);
    process.exit(1);
  }
}
console.log('• credential scan clean');

const { version } = JSON.parse(await readFile('manifest.json', 'utf8'));
const zip = `save-ai-chat-history-v${version}.zip`;
await rm(zip, { force: true });
execSync(`cd dist && zip -qr "../${zip}" . -x "*.DS_Store"`, { stdio: 'inherit' });
console.log(`• packaged → ${zip}`);
