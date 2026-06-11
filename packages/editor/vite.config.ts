import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { vnPlugin } from '../devtools/vnVitePlugin.js'

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  // 编辑器自己管理刷新节奏：保存时重启预览，不做整页 reload
  plugins: [vnPlugin({ reloadOnYamlChange: false })],
  resolve: {
    alias: {
      '@vn/core': p('../core/src/index.ts'),
      '@vn/runtime': p('../runtime/src/index.ts'),
      '@vn/player': p('../player/src/index.ts'),
    },
  },
})
