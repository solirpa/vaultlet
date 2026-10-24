// Build the extension into dist/chrome and dist/firefox.
//
// Three separate Vite builds so that background and content are single-file
// IIFE bundles (service workers / content scripts cannot load chunks), while
// the popup/options pages are a normal multi-page build with shared chunks.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeManifest, firefoxManifest } from './manifest.mjs';
import { extensionIdFromDer, readPublicKeyDer } from './extension-id.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const stage = resolve(dist, '.stage');
const isProd = process.env.NODE_ENV !== 'development';

rmSync(dist, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const shared = {
  configFile: false,
  root,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development') },
};

/** Single-file IIFE bundle (background service worker / content script). */
async function buildScript(name, entry) {
  await build({
    ...shared,
    build: {
      outDir: stage,
      emptyOutDir: false,
      sourcemap: !isProd,
      minify: isProd,
      target: 'es2022',
      lib: {
        entry: resolve(root, entry),
        name: `vaultlet_${name}`,
        formats: ['iife'],
        fileName: () => `${name}.js`,
      },
      rollupOptions: {
        output: { inlineDynamicImports: true, extend: true },
      },
    },
  });
}

/** Popup + options HTML pages (code-splitting allowed). */
async function buildPages() {
  await build({
    ...shared,
    root: resolve(root, 'src'),
    base: './',
    plugins: [react(), tailwindcss()],
    build: {
      outDir: stage,
      emptyOutDir: false,
      sourcemap: !isProd,
      minify: isProd,
      target: 'es2022',
      rollupOptions: {
        input: {
          popup: resolve(root, 'src/popup/index.html'),
          options: resolve(root, 'src/options/index.html'),
          passkey: resolve(root, 'src/passkey/index.html'),
        },
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
          manualChunks(id) {
            if (id.includes('node_modules')) return 'vendor';
            if (id.includes('/src/shared/')) return 'shared';
            return undefined;
          },
        },
      },
    },
  });
}

await buildScript('background', 'src/background/index.ts');
await buildScript('content', 'src/content/index.ts');
await buildScript('passkey-page', 'src/passkey/page.ts');
await buildScript('passkey-bridge', 'src/passkey/bridge.ts');
await buildPages();

// Static assets
if (existsSync(resolve(root, 'icons'))) cpSync(resolve(root, 'icons'), resolve(stage, 'icons'), { recursive: true });

// Per-browser output dirs
for (const [name, manifest] of [
  ['chrome', chromeManifest()],
  ['firefox', firefoxManifest()],
]) {
  const out = resolve(dist, name);
  cpSync(stage, out, { recursive: true });
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
rmSync(stage, { recursive: true, force: true });

const id = extensionIdFromDer(readPublicKeyDer());
writeFileSync(resolve(root, 'EXTENSION_ID'), id + '\n');
console.log(`\nBuilt dist/chrome and dist/firefox. Chrome extension id: ${id}`);
