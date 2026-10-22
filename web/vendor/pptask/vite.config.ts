import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(import.meta.dirname, 'src/index.ts'),
        'providers/kie': resolve(import.meta.dirname, 'src/providers/kie/index.ts'),
        'providers/apiframe': resolve(import.meta.dirname, 'src/providers/apiframe/index.ts'),
        'providers/grsai': resolve(import.meta.dirname, 'src/providers/grsai/index.ts'),
        'providers/comfy': resolve(import.meta.dirname, 'src/providers/comfy/index.ts'),
        'providers/openai': resolve(import.meta.dirname, 'src/providers/openai/index.ts'),
        'providers/gemini': resolve(import.meta.dirname, 'src/providers/gemini/index.ts'),
        'providers/modern': resolve(import.meta.dirname, 'src/providers/modern/index.ts'),
        'providers/shared': resolve(import.meta.dirname, 'src/providers/shared/index.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: ['ai', '@ai-sdk/provider'],
    },
  },
});
