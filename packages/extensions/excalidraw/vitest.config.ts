import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    server: {
      deps: {
        // The published bundle imports open-color's JSON without an import
        // attribute, which Node's ESM loader rejects. Let Vite transform it so
        // tests can run Excalidraw's real text wrapping.
        inline: ['@excalidraw/excalidraw'],
      },
    },
  },
});
