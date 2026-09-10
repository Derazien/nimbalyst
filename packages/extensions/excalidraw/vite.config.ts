import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join, resolve } from 'path';

const PROCESS_SHIM_BANNER = `
if (typeof process === 'undefined') {
  globalThis.process = { env: { NODE_ENV: 'production' }, browser: true, platform: '' };
}
`;

const sharedOutput = {
  format: 'es' as const,
  globals: {
    react: 'React',
    'react-dom': 'ReactDOM',
    'react/jsx-runtime': 'jsxRuntime',
  },
  banner: PROCESS_SHIM_BANNER,
  assetFileNames: (assetInfo: { names?: string[] }) => {
    if (assetInfo.names?.some((name) => name.endsWith('.css'))) {
      return 'index.css';
    }
    return assetInfo.names?.[0] || 'asset';
  },
};

// mermaid >= 11.13 prefixes every SVG element id with the render id
// (e.g. "mermaid-to-excalidraw-6-Client" instead of "Client"), but
// @excalidraw/mermaid-to-excalidraw 2.2.2 still looks subgraphs up by their
// bare id. The lookup misses, the parser throws "SubGraph element not found",
// and every diagram with a subgraph silently degrades to a rasterized SVG
// image. Patch the lookup at bundle time to fall back to a suffix match.
// Remove once upstream handles prefixed ids (tracked as NIM-1596).
const SUBGRAPH_LOOKUP = 'containerEl.querySelector(`[id=\'${data.id}\']`)';
const SUBGRAPH_LOOKUP_PATCHED =
  '(containerEl.querySelector(`[id=\'${data.id}\']`) || containerEl.querySelector(`[id$=\'-${data.id}\']`))';

function patchMermaidToExcalidrawSubgraphLookup() {
  return {
    name: 'patch-mermaid-to-excalidraw-subgraph-lookup',
    transform(code: string, id: string) {
      if (!id.includes('mermaid-to-excalidraw') || !id.includes('flowchart')) return null;
      if (!code.includes(SUBGRAPH_LOOKUP)) return null;
      return { code: code.replaceAll(SUBGRAPH_LOOKUP, SUBGRAPH_LOOKUP_PATCHED), map: null };
    },
  };
}

// Excalidraw's font loader fetches every face by URL from
// window.EXCALIDRAW_ASSET_PATH (set in activate) before falling back to the
// esm.sh CDN, so the faces ship as files beside the bundle, in
// dist/fonts/<Family>/. A family ships only when its license sits in
// fonts/<Family>/LICENSE.txt, which is copied beside it. See fonts/README.md.
function copyExcalidrawFonts() {
  return {
    name: 'copy-excalidraw-fonts',
    closeBundle() {
      const requireFromHere = createRequire(resolve(__dirname, 'package.json'));
      const sourceRoot = join(dirname(requireFromHere.resolve('@excalidraw/excalidraw')), 'fonts');
      const licenseRoot = resolve(__dirname, 'fonts');
      for (const family of readdirSync(licenseRoot, { withFileTypes: true })) {
        if (!family.isDirectory()) continue;
        const source = join(sourceRoot, family.name);
        const faces = existsSync(source)
          ? readdirSync(source).filter((file) => file.endsWith('.woff2'))
          : [];
        if (faces.length === 0) {
          throw new Error(`copy-excalidraw-fonts: @excalidraw/excalidraw ships no ${family.name} faces in ${source}`);
        }
        const target = resolve(__dirname, 'dist', 'fonts', family.name);
        mkdirSync(target, { recursive: true });
        for (const face of faces) copyFileSync(join(source, face), join(target, face));
        copyFileSync(join(licenseRoot, family.name, 'LICENSE.txt'), join(target, 'LICENSE.txt'));
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react({
      jsxRuntime: 'automatic',
      jsxImportSource: 'react',
    }),
    patchMermaidToExcalidrawSubgraphLookup(),
    copyExcalidrawFonts(),
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  mode: 'production',
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.tsx'),
      name: 'ExcalidrawExtension',
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'lexical',
        /^@lexical\//,
        /^@nimbalyst\/runtime/,
        '@nimbalyst/editor-context',
        // yJS must resolve to the host's copy at runtime -- `instanceof Y.Doc`
        // checks fail if the extension bundles its own (same constraint as
        // React). The host's runtime exposes both modules.
        'yjs',
        /^y-protocols(\/.*)?$/,
      ],
      output: [
        {
          ...sharedOutput,
          entryFileNames: 'index.js',
          chunkFileNames: '[name]-[hash].mjs',
          // The web console consumes this entry as a hierarchical module URL,
          // so tool-only dependencies remain lazy sibling chunks.
        },
        {
          ...sharedOutput,
          entryFileNames: 'desktop.js',
          // Electron currently loads extension modules from blob URLs. Keep a
          // self-contained desktop entry so its import_mermaid tool retains the
          // same behavior while the browser entry stops paying for Mermaid.
          inlineDynamicImports: true,
        },
      ],
    },
    // Excalidraw 0.18 ships fonts as external .woff2 files referenced by
    // relative url() in its CSS. The host injects extension CSS as an inline
    // <style> and loads index.js via a module loader, so emitted asset files
    // with relative URLs would not resolve at runtime. Inline every asset as a
    // base64 data URI instead (0.17.6 already shipped its fonts pre-inlined, so
    // this preserves the prior single-bundle behavior). `true` forces inlining
    // regardless of size. The drawing faces its font-loading code fetches by
    // URL are not assets of the bundle; copyExcalidrawFonts ships those.
    assetsInlineLimit: () => true,
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
