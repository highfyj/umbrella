import { spawnSync } from 'node:child_process'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ViteDevServer } from 'vite'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
}

interface CompilerMod {
  compileProject(files: unknown): { ir: unknown; diagnostics: { items: unknown[] } }
  NodeFiles: new (root: string) => DiskFiles
  textHash(text: string): string
  VOICE_EXTS: readonly string[]
}

// ---------- TTS 工具 ----------

let ffmpegAvailable: boolean | null = null
function hasFfmpeg(): boolean {
  ffmpegAvailable ??= spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
  return ffmpegAvailable
}

/** 裸 16bit 单声道 PCM → WAV（CosyVoice fastapi 流式返回的就是裸 PCM） */
function wrapPcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * 2
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function wavDurationMs(wav: Buffer): number | null {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return null
  let offset = 12
  let byteRate: number | null = null
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'fmt ') byteRate = wav.readUInt32LE(offset + 8 + 8)
    if (id === 'data' && byteRate) return Math.round((size / byteRate) * 1000)
    offset += 8 + size + (size % 2)
  }
  return null
}

export interface TtsGenerateRequest {
  baseUrl: string
  mode: 'zero_shot' | 'sft' | 'instruct'
  path?: string
  sampleRate?: number
  toOgg?: boolean
  text: string
  promptText?: string
  spkId?: string
  instruct?: string
  speed?: number
  /** 音色参考音频（项目根相对路径，zero_shot/instruct 用） */
  sample?: string
  /** 试听文件名（通常用语音 id） */
  previewName: string
}

const TTS_DEFAULT_PATHS: Record<string, string> = {
  zero_shot: '/inference_zero_shot',
  sft: '/inference_sft',
  instruct: '/inference_instruct2',
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

        // ---------- TTS：探活 / 生成试听 / 落盘提交 ----------

        if (url === '/api/tts/probe' && req.method === 'POST') {
          void readBody(req)
            .then(async (body) => {
              const { baseUrl } = JSON.parse(body) as { baseUrl: string }
              try {
                const r = await fetch(baseUrl, { signal: AbortSignal.timeout(3000) })
                json(res, 200, { ok: true, status: r.status, ffmpeg: hasFfmpeg() })
              } catch (err) {
                json(res, 200, { ok: false, error: String(err), ffmpeg: hasFfmpeg() })
              }
            })
            .catch((err: unknown) => json(res, 500, { error: String(err) }))
          return
        }

        if (url === '/api/tts/generate' && req.method === 'POST') {
          void readBody(req)
            .then(async (body) => {
              const o = JSON.parse(body) as TtsGenerateRequest
              const endpoint = o.baseUrl.replace(/\/$/, '') + (o.path ?? TTS_DEFAULT_PATHS[o.mode])
              const fd = new FormData()
              fd.append('tts_text', o.text)
              if (o.mode === 'sft' && o.spkId) fd.append('spk_id', o.spkId)
              if (o.mode === 'zero_shot') fd.append('prompt_text', o.promptText ?? '')
              if (o.mode === 'instruct' && o.instruct) fd.append('instruct_text', o.instruct)
              if ((o.mode === 'zero_shot' || o.mode === 'instruct') && o.sample) {
                const samplePath = join(repoRoot, o.sample)
                if (!existsSync(samplePath)) {
                  json(res, 200, { ok: false, error: `音色参考音频不存在：${o.sample}` })
                  return
                }
                fd.append('prompt_wav', new Blob([new Uint8Array(readFileSync(samplePath))]), 'prompt.wav')
              }
              if (o.speed) fd.append('speed', String(o.speed))

              let resp: Response
              try {
                resp = await fetch(endpoint, { method: 'POST', body: fd, signal: AbortSignal.timeout(120000) })
                if (resp.status === 404 || resp.status === 405) {
                  // 部分部署只接受 GET + query（无法携带文件，仅 sft 可用）
                  const q = new URLSearchParams({ tts_text: o.text, ...(o.spkId ? { spk_id: o.spkId } : {}) })
                  resp = await fetch(`${endpoint}?${q}`, { signal: AbortSignal.timeout(120000) })
                }
              } catch (err) {
                json(res, 200, { ok: false, error: `TTS 服务请求失败：${String(err)}` })
                return
              }
              if (!resp.ok) {
                json(res, 200, { ok: false, error: `TTS 服务返回 ${resp.status}：${(await resp.text()).slice(0, 300)}` })
                return
              }
              const bytes = Buffer.from(await resp.arrayBuffer())
              if (!bytes.length) {
                json(res, 200, { ok: false, error: 'TTS 服务返回了空音频' })
                return
              }
              const wav = bytes.toString('ascii', 0, 4) === 'RIFF' ? bytes : wrapPcmToWav(bytes, o.sampleRate ?? 24000)
              const durationMs = wavDurationMs(wav)
              const previewDir = join(repoRoot, 'build/tts-preview')
              mkdirSync(previewDir, { recursive: true })
              const safeName = o.previewName.replace(/[^\w-]/g, '_')
              const wavPath = join(previewDir, `${safeName}.wav`)
              writeFileSync(wavPath, wav)
              let preview = `tts-preview/${safeName}.wav`
              if (o.toOgg !== false && hasFfmpeg()) {
                const oggPath = join(previewDir, `${safeName}.ogg`)
                const r = spawnSync('ffmpeg', ['-y', '-i', wavPath, '-c:a', 'libvorbis', '-q:a', '4', oggPath], { stdio: 'ignore' })
                if (r.status === 0) preview = `tts-preview/${safeName}.ogg`
              }
              json(res, 200, { ok: true, preview, durationMs, bytes: bytes.length })
            })
            .catch((err: unknown) => json(res, 500, { error: String(err) }))
          return
        }

        if (url === '/api/tts/commit' && req.method === 'POST') {
          void readBody(req)
            .then(async (body) => {
              const { preview, id, text, durationMs } = JSON.parse(body) as { preview: string; id: string; text: string; durationMs: number | null }
              if (!/^tts-preview\/[\w-]+\.(ogg|wav|mp3|m4a)$/.test(preview) || !/^[\w-]+$/.test(id)) {
                json(res, 400, { error: 'invalid preview/id' })
                return
              }
              const src = join(repoRoot, 'build', preview)
              if (!existsSync(src)) {
                json(res, 400, { error: `试听文件不存在：${preview}` })
                return
              }
              const ext = extname(preview)
              const dir = id.replace(/_\d+$/, '')
              const targetRel = `voice/${dir}/${id}${ext}`
              mkdirSync(join(repoRoot, 'voice', dir), { recursive: true })
              const m = await loadCompiler()
              // 清掉同 id 的其他扩展名旧文件，避免多扩展名探测歧义
              for (const e of m.VOICE_EXTS) {
                const old = join(repoRoot, `voice/${dir}/${id}${e}`)
                if (e !== ext && existsSync(old)) unlinkSync(old)
              }
              copyFileSync(src, join(repoRoot, targetRel))
              // 更新 voice.lock：text_hash 用编译器同一实现，保证改稿检测一致
              const lockPath = join(repoRoot, 'voice.lock')
              const lock = (existsSync(lockPath) ? (parseYaml(readFileSync(lockPath, 'utf8')) ?? {}) : {}) as Record<string, unknown>
              lock[id] = { text_hash: m.textHash(text), file: targetRel, duration_ms: durationMs ?? undefined }
              writeFileSync(lockPath, stringifyYaml(lock), 'utf8')
              json(res, 200, { ok: true, file: targetRel })
            })
            .catch((err: unknown) => json(res, 500, { error: String(err) }))
          return
        }

        if (url.startsWith('/tts-preview/')) {
          const file = join(repoRoot, 'build', decodeURIComponent(url.slice(1)))
          if (existsSync(file) && statSync(file).isFile()) {
            res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
            res.setHeader('Cache-Control', 'no-store') // 同名覆盖生成，禁止缓存
            createReadStream(file).pipe(res)
          } else {
            res.statusCode = 404
            res.end('not found')
          }
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
