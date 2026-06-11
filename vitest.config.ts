import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@vn/core': p('./packages/core/src/index.ts'),
      '@vn/compiler': p('./packages/compiler/src/index.ts'),
      '@vn/runtime': p('./packages/runtime/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
})
