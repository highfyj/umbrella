import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ViteDevServer } from 'vite'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
}

interface CompilerMod {
  compileProject(files: unknown): { ir: unknown; diagnostics: { items: unknown[] } }
  NodeFiles: new (root: string) => DiskFiles
}

interface DiskFiles {
  read(p: string): string | null
  list(d: string): string[]
  exists(p: string): boolean
}

export interface VnPluginOptions {
  /** story/*.yaml 磁盘变更时整页刷新（播放器 true；编辑器 false，自己管理刷新） */
  reloadOnYamlChange: boolean
}

/**
 * VN 开发服务器插件（播放器与编辑器共用）：
 * - GET  /story.ir.json            现场编译 story/（磁盘状态）
 * - POST /api/compile {overrides}  内存叠加编译：未保存的缓冲区覆盖磁盘文件
 * - GET  /api/files                剧本文件列表
 * - GET  /api/file?path=...        读文件
 * - PUT  /api/file {path,content}  写文件（限 story/ 下的 yaml）
 * - /sprite|bg|bgm|se|voice/**     从项目根伺服资产
 */
export function vnPlugin(opts: VnPluginOptions): Plugin {
  return {
    name: 'vn-story',
    configureServer(server: ViteDevServer) {
      let compiler: Promise<CompilerMod> | null = null
      const loadCompiler = (): Promise<CompilerMod> => {
        const entry = join(repoRoot, 'packages/compiler/src/index.ts').replaceAll('\\', '/')
        compiler ??= server.ssrLoadModule('/@fs/' + entry).then((m) => m as unknown as CompilerMod)
        return compiler
      }

      const overlayFiles = (m: CompilerMod, overrides: Record<string, string>): DiskFiles => {
        const disk = new m.NodeFiles(repoRoot)
        return {
          read: (p) => overrides[p] ?? disk.read(p),
          exists: (p) => overrides[p] !== undefined || disk.exists(p),
          list: (d) => {
            const set = new Set(disk.list(d))
            const prefix = d.endsWith('/') ? d : d + '/'
            for (const k of Object.keys(overrides)) {
              const rest = k.startsWith(prefix) ? k.slice(prefix.length) : null
              if (rest && !rest.includes('/')) set.add(rest)
            }
            return [...set].sort()
          },
        }
      }

      const json = (res: ServerResponse, status: number, data: unknown): void => {
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(data))
      }

      const readBody = (req: IncomingMessage): Promise<string> =>
        new Promise((resolve, reject) => {
          let s = ''
          req.on('data', (c: Buffer) => (s += c.toString('utf8')))
          req.on('end', () => resolve(s))
          req.on('error', reject)
        })

      const compileWith = async (overrides: Record<string, string>) => {
        const m = await loadCompiler()
        const r = m.compileProject(overlayFiles(m, overrides))
        return { ir: r.ir, diagnostics: r.diagnostics.items }
      }

      const safeYamlPath = (p: string): boolean =>
        p.startsWith('story/') && !p.includes('..') && /\.ya?ml$/.test(p)

      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]
        const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')

        if (url === '/story.ir.json') {
          void compileWith({})
            .then((r) => json(res, 200, r))
            .catch((err: unknown) =>
              json(res, 500, { ir: null, diagnostics: [{ severity: 'error', code: 'compiler-crash', message: String(err), file: '', pos: null }] }),
            )
          return
        }

        if (url === '/api/compile' && req.method === 'POST') {
          void readBody(req)
            .then(async (body) => {
              const overrides = (JSON.parse(body || '{}').overrides ?? {}) as Record<string, string>
              json(res, 200, await compileWith(overrides))
            })
            .catch((err: unknown) => json(res, 500, { error: String(err) }))
          return
        }

        if (url === '/api/assets') {
          const walk = (dir: string, prefix: string): string[] => {
            const full = join(repoRoot, dir)
            if (!existsSync(full)) return []
            const out: string[] = []
            for (const e of readdirSync(full, { withFileTypes: true })) {
              if (e.name.startsWith('.')) continue
              if (e.isDirectory()) out.push(...walk(`${dir}/${e.name}`, `${prefix}/${e.name}`))
              else out.push(`${prefix}/${e.name}`)
            }
            return out
          }
          const cats = ['bg', 'bgm', 'se', 'sprite', 'voice', 'production'] as const
          const files: Record<string, string[]> = {}
          for (const c of cats) files[c] = walk(c, c)
          json(res, 200, { files })
          return
        }

        if (url === '/api/files') {
          const scenes = existsSync(join(repoRoot, 'story/scenes'))
            ? readdirSync(join(repoRoot, 'story/scenes'))
                .filter((f) => /\.ya?ml$/.test(f))
                .map((f) => `story/scenes/${f}`)
            : []
          json(res, 200, { files: ['story/story.yaml', 'story/characters.yaml', 'story/assets.yaml', ...scenes] })
          return
        }

        if (url === '/api/file' && req.method === 'GET') {
          const p = query.get('path') ?? ''
          if (!safeYamlPath(p) || !existsSync(join(repoRoot, p))) {
            json(res, 404, { error: `not found: ${p}` })
            return
          }
          json(res, 200, { path: p, content: readFileSync(join(repoRoot, p), 'utf8') })
          return
        }

        if (url === '/api/file' && req.method === 'PUT') {
          void readBody(req)
            .then((body) => {
              const { path, content } = JSON.parse(body) as { path: string; content: string }
              if (!safeYamlPath(path) || typeof content !== 'string') {
                json(res, 400, { error: `invalid path: ${path}` })
                return
              }
              writeFileSync(join(repoRoot, path), content, 'utf8')
              json(res, 200, { ok: true })
            })
            .catch((err: unknown) => json(res, 500, { error: String(err) }))
          return
        }

        if (/^\/(sprite|bg|bgm|se|voice|production)\//.test(url)) {
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

      if (opts.reloadOnYamlChange) {
        server.watcher.add(join(repoRoot, 'story'))
        server.watcher.on('all', (_event, file) => {
          const f = file.replaceAll('\\', '/')
          if (f.includes('/story/') && /\.ya?ml$/.test(f)) {
            server.ws.send({ type: 'full-reload' })
          }
        })
      }
    },
  }
}
