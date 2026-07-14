// Build: bundle src/ → dist/ with esbuild, and emit a dist manifest whose paths
// drop the `src/` prefix. Chrome loads dist/. Run `npm run build` or `npm run watch`.
import esbuild from 'esbuild';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ENTRYPOINTS = [
  'src/background/service-worker.js',
  'src/content/bridge.js',
  'src/inject/main-world.js',
  'src/options/options.js',
  'src/popup/popup.js',
];

// Rewrite manifest for dist: strip `src/` prefixes; bundles are IIFE so the
// background no longer needs `type: module`.
async function buildManifest() {
  const m = JSON.parse(await readFile('manifest.json', 'utf8'));
  const strip = (s) => s.replace(/^src\//, '');
  m.background.service_worker = strip(m.background.service_worker);
  delete m.background.type;
  if (m.options_page) m.options_page = strip(m.options_page);
  if (m.action?.default_popup) m.action.default_popup = strip(m.action.default_popup);
  for (const key of ['icons', 'action']) {
    const table = key === 'action' ? m.action?.default_icon : m.icons;
    for (const size of Object.keys(table || {})) table[size] = strip(table[size]);
  }
  for (const cs of m.content_scripts || []) cs.js = (cs.js || []).map(strip);
  await mkdir('dist', { recursive: true });
  await writeFile('dist/manifest.json', JSON.stringify(m, null, 2) + '\n');
}

// Copy non-bundled static assets (HTML, icons) into dist.
async function copyAssets() {
  await mkdir('dist/options', { recursive: true });
  await copyFile('src/options/options.html', 'dist/options/options.html');
  await mkdir('dist/popup', { recursive: true });
  await copyFile('src/popup/popup.html', 'dist/popup/popup.html');
  await mkdir('dist/icons', { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await copyFile(`src/icons/icon${size}.png`, `dist/icons/icon${size}.png`);
  }
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
