// Build: bundle src/ → dist/ with esbuild, and emit a dist manifest whose paths
// drop the `src/` prefix. Chrome loads dist/. Run `npm run build` or `npm run watch`.
import esbuild from 'esbuild';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ENTRYPOINTS = [
  'src/background/service-worker.js',
  'src/content/bridge.js',
  'src/inject/main-world.js',
  'src/options/options.js',
];

// local-config.js is gitignored and statically imported by notion.js. On a fresh
// clone it won't exist, so generate an empty stub to keep the bundle building.
// (Real credentials go in chrome.storage via the settings page; this file is just
// an optional dev shortcut.)
const LOCAL_CONFIG_STUB =
  `// LOCAL DEV ONLY — gitignored. Optional Notion credentials for quick local\n` +
  `// testing. Leave empty to configure via the settings page (chrome.storage).\n` +
  `export const LOCAL_NOTION = { token: '', rootPageId: '' };\n`;

async function ensureLocalConfig() {
  const p = 'src/background/local-config.js';
  if (!existsSync(p)) {
    await writeFile(p, LOCAL_CONFIG_STUB);
    console.log('• created empty src/background/local-config.js (configure via settings, or fill in for dev)');
  }
}

// Rewrite manifest for dist: strip `src/` prefixes; bundles are IIFE so the
// background no longer needs `type: module`.
async function buildManifest() {
  const m = JSON.parse(await readFile('manifest.json', 'utf8'));
  const strip = (s) => s.replace(/^src\//, '');
  m.background.service_worker = strip(m.background.service_worker);
  delete m.background.type;
  if (m.options_page) m.options_page = strip(m.options_page);
  for (const cs of m.content_scripts || []) cs.js = (cs.js || []).map(strip);
  await mkdir('dist', { recursive: true });
  await writeFile('dist/manifest.json', JSON.stringify(m, null, 2) + '\n');
}

// Copy non-bundled static assets (HTML) into dist.
async function copyAssets() {
  await mkdir('dist/options', { recursive: true });
  await copyFile('src/options/options.html', 'dist/options/options.html');
}

const options = {
  entryPoints: ENTRYPOINTS,
  outbase: 'src',
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome111',
  logLevel: 'info',
  // martian imports node's path/url but never calls them — alias to empty stub.
  alias: {
    path: resolve('build-shims/node-empty.js'),
    url: resolve('build-shims/node-empty.js'),
  },
};

await ensureLocalConfig();
await buildManifest();
await copyAssets();

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('• watching src/ … (rebuilds dist/ on change; reload the extension in Chrome)');
} else {
  await esbuild.build(options);
  console.log('• build done → dist/');
}
