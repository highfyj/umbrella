import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
}

/**
 * 开发服务器插件：
 * - GET /story.ir.json → 现场编译 story/，返回 IR + 诊断（资产缺失只是警告，照常可玩）
 * - /sprite|bg|bgm|se|voice/** → 从项目根直接伺服资产文件
 * - story/**.yaml 变更 → 整页刷新（重新编译重新开始）
 *
 * 编译器是 TS 源码，经 server.ssrLoadModule 加载（走 Vite 的 TS/别名解析管线）。
 */
function vnPlugin(): Plugin {
  return {
    name: 'vn-story',
    configureServer(server: ViteDevServer) {
      type CompilerMod = {
        compileProject(files: unknown): {
          ir: unknown
          diagnostics: { items: unknown[] }
        }
        NodeFiles: new (root: string) => unknown
      }
      let compiler: Promise<CompilerMod> | null = null
      const loadCompiler = (): Promise<CompilerMod> => {
        compiler ??= server
          .ssrLoadModule('/@fs/' + p('../compiler/src/index.ts').replaceAll('\\', '/'))
          .then((m) => m as CompilerMod)
        return compiler
      }

      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]
        if (url === '/story.ir.json') {
          void loadCompiler()
            .then((m) => {
              const r = m.compileProject(new m.NodeFiles(repoRoot))
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ir: r.ir, diagnostics: r.diagnostics.items }))
            })
            .catch((err: unknown) => {
              res.statusCode = 500
              res.end(JSON.stringify({ ir: null, diagnostics: [{ severity: 'error', code: 'compiler-crash', message: String(err), file: '', pos: null }] }))
            })
          return
        }
        if (/^\/(sprite|bg|bgm|se|voice)\//.test(url)) {
          const file = join(repoRoot, decodeURIComponent(url))
          if (existsSync(file) && statSync(file).isFile()) {
            res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
            createReadStream(file).pipe(res)
          } else {
            res.statusCode = 404
            res.end('not found')
          }
          return
        }
        next()
      })

      server.watcher.add(join(repoRoot, 'story'))
      server.watcher.on('all', (_event, file) => {
        const f = file.replaceAll('\\', '/')
        if (f.includes('/story/') && /\.ya?ml$/.test(f)) {
          server.ws.send({ type: 'full-reload' })
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [vnPlugin()],
  resolve: {
    alias: {
      '@vn/core': p('../core/src/index.ts'),
      '@vn/runtime': p('../runtime/src/index.ts'),
      '@vn/compiler': p('../compiler/src/index.ts'),
    },
  },
})
