import { spawnSync } from 'node:child_process'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Plugin, ViteDevServer } from 'vite'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
}

// ---------- 项目根目录：可在 UI 中切换，跨重启记忆 ----------

const editorStatePath = join(homedir(), '.vn-editor.json')

function isProjectDir(dir: string): boolean {
  return existsSync(join(dir, 'story/story.yaml'))
}

function loadLastProject(): string | null {
  try {
    const s = JSON.parse(readFileSync(editorStatePath, 'utf8')) as { lastProject?: string }
    return s.lastProject && isProjectDir(s.lastProject) ? s.lastProject : null
  } catch {
    return null
  }
}

function saveLastProject(dir: string): void {
  try {
    writeFileSync(editorStatePath, JSON.stringify({ lastProject: dir }, null, 2), 'utf8')
  } catch {
    /* 记忆失败不影响功能 */
  }
}

/** 项目内允许写入素材的相对路径（含子目录与媒体扩展名校验） */
function safeAssetPath(p: string): boolean {
  return (
    /^(bg|bgm|se|sprite|voice|production|item)\//.test(p) &&
    !p.includes('..') &&
    !p.includes('\\') &&
    Object.hasOwn(MIME, extname(p).toLowerCase())
  )
}

/** 目标已存在时自动改名：xxx.png → xxx_2.png、xxx_3.png… */
function dedupePath(absPath: string): string {
  if (!existsSync(absPath)) return absPath
  const ext = extname(absPath)
  const stem = absPath.slice(0, -ext.length)
  for (let i = 2; ; i++) {
    const candidate = `${stem}_${i}${ext}`
    if (!existsSync(candidate)) return candidate
  }
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

// ---------- 生图 / 抠图：本地 CLI 工具（codex image2、rembg）通过 dev server 代理 ----------

/**
 * 命令模板 → 参数数组：以空格切分模板，整词占位符（{prompt} 等）替换为单个参数
 * （含空格/中文的提示词不会被拆开）；嵌入式占位符（--out={out}）就地替换。
 * 值为空的整词占位符（如可选的 {ref}）被丢弃。
 */
function buildArgs(template: string, vars: Record<string, string>): string[] {
  const out: string[] = []
  for (const tok of template.trim().split(/\s+/).filter(Boolean)) {
    const whole = /^\{(\w+)\}$/.exec(tok)
    if (whole) {
      const v = vars[whole[1]]
      if (v) out.push(v)
      continue
    }
    out.push(tok.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ''))
  }
  return out
}

function quoteArg(a: string): string {
  if (process.platform !== 'win32') return `'${a.replace(/'/g, `'\\''`)}'`
  // 仅对需要的 token 加引号：cmd.exe 会再解析一层，给 --sandbox 之类简单参数加引号会让
  // codex 收到带引号的值（如 "workspace-write"）从而 clap 解析失败（exit 2）
  return a === '' || /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a
}

interface ToolResult {
  ok: boolean
  status: number | null
  output: string
  notFound: boolean
}

/** 运行本地 CLI：先直接 spawn；ENOENT（多为 Windows 的 .cmd/.bat）回退 shell 模式 */
function runTool(cmd: string, args: string[], cwd: string, timeout: number): ToolResult {
  // input: '' 给子进程一个立即 EOF 的空 stdin——codex exec 见到管道 stdin 会一直读到 EOF，
  // 不喂 EOF 就会卡在 "Reading additional input from stdin..." 永不返回
  const opts = { cwd, timeout, encoding: 'utf8' as const, maxBuffer: 64 * 1024 * 1024, input: '' }
  let r = spawnSync(cmd, args, opts)
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
    const line = [cmd, ...args].map(quoteArg).join(' ')
    r = spawnSync(line, { ...opts, shell: true })
  }
  const notFound = !!r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT'
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`.trim().slice(-2000)
  return { ok: !r.error && r.status === 0, status: r.status ?? null, output, notFound }
}

/**
 * 探活：用 where/which 按退出码判定（与语言环境无关，能识别 Windows 的 .cmd/.bat）。
 * shell 回退执行 + 解析输出不可靠：中文 Windows 的"不是内部或外部命令"是 GBK，按 UTF-8 解码会乱码。
 */
function probeTool(command: string, _cwd: string): { ok: boolean; detail: string } {
  const cmd = command.trim().split(/\s+/)[0] ?? ''
  if (!cmd) return { ok: false, detail: '未配置命令' }
  // 配置成绝对路径/带目录分隔符时直接查存在性
  if (isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
    return existsSync(cmd) ? { ok: true, detail: cmd } : { ok: false, detail: `找不到可执行文件：${cmd}` }
  }
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const r = spawnSync(finder, [cmd], { encoding: 'utf8', timeout: 8000 })
  const path = (r.stdout ?? '').split(/\r?\n/)[0]?.trim()
  if (!r.error && r.status === 0 && path) return { ok: true, detail: path }
  return { ok: false, detail: `找不到可执行文件：${cmd}` }
}

export interface ImgGenerateRequest {
  flow: 'sprite' | 'bg' | 'base'
  /** 用户填写的本张图描述（喂给 promptTemplate 的 {desc}） */
  desc: string
  /**
   * 工作流提示词模板（$imagegen）：占位符 {desc} {out} {size} {ref}。
   * 由服务端按候选逐个填充 {out}（绝对路径），codex agent 据此把图存到该路径。
   */
  promptTemplate: string
  /** 参考图：项目内相对路径（可选） */
  ref?: string
  count: number
  size: string
  /** 命令模板：占位符 {cwd}（项目根）{prompt}（完整工作流提示词）{ref}（参考图绝对路径） */
  genCommand: string
  genCommandRef: string
  rembgCommand: string
  /** 是否抠图（立绘默认开） */
  matte: boolean
  /** 预览文件基名 */
  name: string
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
 * - GET  /api/project              当前项目信息；POST /api/project/open {path} 切换项目（记忆到 ~/.vn-editor.json）
 * - GET  /api/fs/list?path=...     浏览本机目录（打开项目 / 导入素材用）
 * - GET  /api/fs/file?path=...     本机媒体文件预览流（导入前试看/试听）
 * - POST /api/asset/import?to=...  浏览器上传素材写入项目（拖入文件；重名自动加后缀）
 * - POST /api/asset/import-local   {src,to} 本机文件拷入项目（浏览选中）
 * - POST /api/asset/delete         {path} 删除项目内素材文件（voice/ 下会同步清 voice.lock）
 * - POST /api/tts/{probe,generate,commit}   CosyVoice 代理：探活 / 生成试听 / 落盘+voice.lock
 * - POST /api/img/{probe,generate,matte,commit}  生图/抠图代理：codex image2 探活 / 抽卡候选 / rembg 抠图 / 落盘
 * - /sprite|bg|bgm|se|voice/**     从项目根伺服资产；/tts-preview/** /img-preview/** 试听试看
 */
export function vnPlugin(opts: VnPluginOptions): Plugin {
  return {
    name: 'vn-story',
    configureServer(server: ViteDevServer) {
      // 当前项目根：上次打开的项目，否则本仓库自带的样例项目
      let projectRoot = loadLastProject() ?? repoRoot
      let compiler: Promise<CompilerMod> | null = null
      const loadCompiler = (): Promise<CompilerMod> => {
        const entry = join(repoRoot, 'packages/compiler/src/index.ts').replaceAll('\\', '/')
        compiler ??= server.ssrLoadModule('/@fs/' + entry).then((m) => m as unknown as CompilerMod)
        return compiler
      }

      const overlayFiles = (m: CompilerMod, overrides: Record<string, string>): DiskFiles => {
        const disk = new m.NodeFiles(projectRoot)
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

      const readBodyBuffer = (req: IncomingMessage): Promise<Buffer> =>
        new Promise((res2, reject) => {
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', () => res2(Buffer.concat(chunks)))
          req.on('error', reject)
        })

      const readBody = (req: IncomingMessage): Promise<string> => readBodyBuffer(req).then((b) => b.toString('utf8'))

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

        // ---------- 项目管理：查询当前项目 / 切换项目 ----------

        if (url === '/api/project') {
          json(res, 200, { root: projectRoot, name: basename(projectRoot), isDefault: projectRoot === repoRoot })
          return
        }

        if (url === '/api/project/open' && req.method === 'POST') {
          void readBody(req)
            .then((body) => {
              const { path } = JSON.parse(body) as { path: string }
              const dir = resolve(path.startsWith('~') ? join(homedir(), path.slice(1)) : path)
              if (!isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) {
                json(res, 400, { error: `目录不存在：${dir}` })
                return
              }
              if (!isProjectDir(dir)) {
                json(res, 400, { error: `不是 VN 项目（缺少 story/story.yaml）：${dir}` })
                return
              }
              projectRoot = dir
              saveLastProject(dir)
              server.watcher.add(join(dir, 'story'))
              json(res, 200, { ok: true, root: projectRoot, name: basename(projectRoot) })
            })
            .catch((err: unknown) => json(res, 500, { error: String(err) }))
          return
        }

        // ---------- 本机文件系统：浏览目录 / 预览媒体文件（仅本机开发服务器使用） ----------

        if (url === '/api/fs/list') {
          const raw = query.get('path') || '~'
          const dir = resolve(raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw)
          if (!existsSync(dir) || !statSync(dir).isDirectory()) {
            json(res, 200, { error: `目录不存在：${dir}`, path: dir, parent: null, dirs: [], files: [] })
            return
          }
          const dirs: Array<{ name: string; isProject: boolean }> = []
          const files: Array<{ name: string; size: number }> = []
          try {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
              if (e.name.startsWith('.')) continue
              try {
                if (e.isDirectory()) dirs.push({ name: e.name, isProject: isProjectDir(join(dir, e.name)) })
                else if (e.isFile()) files.push({ name: e.name, size: statSync(join(dir, e.name)).size })
              } catch {
                /* 个别条目不可读（权限）→ 跳过 */
              }
            }
          } catch (err) {
            json(res, 200, { error: `目录不可读：${String(err)}`, path: dir, parent: null, dirs: [], files: [] })
            return
          }
          const parent = dirname(dir)
          json(res, 200, {
            path: dir,
            parent: parent === dir ? null : parent,
            dirs: dirs.sort((a, b) => a.name.localeCompare(b.name)),
            files: files.sort((a, b) => a.name.localeCompare(b.name)),
          })
          return
        }

        if (url === '/api/fs/file') {
          const p = query.get('path') ?? ''
          const mime = MIME[extname(p).toLowerCase()]
          if (!isAbsolute(p) || !mime || !existsSync(p) || !statSync(p).isFile()) {
            res.statusCode = 404
            res.end('not found')
            return
          }
          res.setHeader('Content-Type', mime)
          res.setHeader('Cache-Control', 'no-store')
          createReadStream(p).pipe(res)
          return
        }

        // ---------- 素材导入：浏览器上传（拖入） / 本机拷贝（浏览选中） ----------

        if (url === '/api/asset/import' && req.method === 'POST') {
          const to = query.get('to') ?? ''
          if (!safeAssetPath(to)) {
            json(res, 400, { error: `无效目标路径：${to}` })
            return
          }
          void readBodyBuffer(req)
            .then((data) => {
              if (!data.length) {
                json(res, 400, { error: '文件内容为空' })
                return
              }
              const abs = dedupePath(join(projectRoot, to))
              mkdirSync(dirname(abs), { recursive: true })
              writeFileSync(abs, data)
              json(res, 200, { ok: true, path: abs.slice(projectRoot.length).replace(/^[/\\]/, '').replaceAll('\\', '/') })
            })
            .catch((err: unknown) => json(res, 500, { error: String(err) }))
          return
        }

        if (url === '/api/asset/delete' && req.method === 'POST') {
          void readBody(req)
            .then((body) => {
              const { path } = JSON.parse(body) as { path: string }
              if (!safeAssetPath(path)) {
                json(res, 400, { error: `无效路径：${path}` })
                return
              }
              const abs = join(projectRoot, path)
              let deleted = false
              if (existsSync(abs) && statSync(abs).isFile()) {
                unlinkSync(abs)
                deleted = true
              }
              // 删语音文件时同步清掉 voice.lock 里引用它的条目，避免残留过期 hash
              if (path.startsWith('voice/')) {
                const lockPath = join(projectRoot, 'voice.lock')
                if (existsSync(lockPath)) {
                  const lock = (parseYaml(readFileSync(lockPath, 'utf8')) ?? {}) as Record<string, { file?: string }>
                  const kept = Object.entries(lock).filter(([, v]) => v?.file !== path)
                  if (kept.length !== Object.keys(lock).length) {
                    writeFileSync(lockPath, stringifyYaml(Object.fromEntries(kept)), 'utf8')
                  }
                }
              }
              json(res, 200, { ok: true, deleted })
            })
            .catch((err: unknown) => json(res, 500, { error: String(err) }))
          return
        }

        if (url === '/api/asset/import-local' && req.method === 'POST') {
          void readBody(req)
            .then((body) => {
              const { src, to } = JSON.parse(body) as { src: string; to: string }
              if (!isAbsolute(src) || !existsSync(src) || !statSync(src).isFile()) {
                json(res, 400, { error: `源文件不存在：${src}` })
                return
              }
              if (!safeAssetPath(to)) {
                json(res, 400, { error: `无效目标路径：${to}` })
                return
              }
              const abs = dedupePath(join(projectRoot, to))
              mkdirSync(dirname(abs), { recursive: true })
              copyFileSync(src, abs)
              json(res, 200, { ok: true, path: abs.slice(projectRoot.length).replace(/^[/\\]/, '').replaceAll('\\', '/') })
            })
            .catch((err: unknown) => json(res, 500, { error: String(err) }))
          return
        }

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
                const samplePath = join(projectRoot, o.sample)
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
              const previewDir = join(projectRoot, 'build/tts-preview')
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
              const src = join(projectRoot, 'build', preview)
              if (!existsSync(src)) {
                json(res, 400, { error: `试听文件不存在：${preview}` })
                return
              }
              const ext = extname(preview)
              const dir = id.replace(/_\d+$/, '')
              const targetRel = `voice/${dir}/${id}${ext}`
              mkdirSync(join(projectRoot, 'voice', dir), { recursive: true })
              const m = await loadCompiler()
              // 清掉同 id 的其他扩展名旧文件，避免多扩展名探测歧义
              for (const e of m.VOICE_EXTS) {
                const old = join(projectRoot, `voice/${dir}/${id}${e}`)
                if (e !== ext && existsSync(old)) unlinkSync(old)
              }
              copyFileSync(src, join(projectRoot, targetRel))
              // 更新 voice.lock：text_hash 用编译器同一实现，保证改稿检测一致
              const lockPath = join(projectRoot, 'voice.lock')
              const lock = (existsSync(lockPath) ? (parseYaml(readFileSync(lockPath, 'utf8')) ?? {}) : {}) as Record<string, unknown>
              lock[id] = { text_hash: m.textHash(text), file: targetRel, duration_ms: durationMs ?? undefined }
              writeFileSync(lockPath, stringifyYaml(lock), 'utf8')
              json(res, 200, { ok: true, file: targetRel })
            })
            .catch((err: unknown) => json(res, 500, { error: String(err) }))
          return
        }

        if (url.startsWith('/tts-preview/')) {
          const file = join(projectRoot, 'build', decodeURIComponent(url.slice(1)))
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

        // ---------- 生图 / 抠图：探活 / 生成候选 / 抠图 / 落盘 ----------

        if (url === '/api/img/probe' && req.method === 'POST') {
          void readBody(req)
            .then((body) => {
              const { genCommand, rembgCommand } = JSON.parse(body) as { genCommand: string; rembgCommand: string }
              json(res, 200, {
                codex: probeTool(genCommand, projectRoot),
                rembg: probeTool(rembgCommand, projectRoot),
              })
            })
            .catch((err: unknown) => json(res, 500, { error: String(err) }))
          return
        }

        if (url === '/api/img/generate' && req.method === 'POST') {
          void readBody(req)
            .then((body) => {
              const o = JSON.parse(body) as ImgGenerateRequest
              const previewDir = join(projectRoot, 'build/img-preview')
              mkdirSync(previewDir, { recursive: true })
              let absRef = ''
              if (o.ref) {
                absRef = join(projectRoot, o.ref)
                if (!existsSync(absRef)) {
                  json(res, 200, { ok: false, error: `参考图不存在：${o.ref}` })
                  return
                }
              }
              const safeName = (o.name || 'gen').replace(/[^\w-]/g, '_')
              const count = Math.max(1, Math.min(8, o.count || 1))
              const template = absRef && o.genCommandRef.trim() ? o.genCommandRef : o.genCommand
              const candidates: Array<{ preview?: string; error?: string }> = []
              for (let i = 0; i < count; i++) {
                const stem = `${safeName}_${i}`
                const outAbs = join(previewDir, `${stem}.png`)
                if (existsSync(outAbs)) unlinkSync(outAbs)
                // 工作流提示词：把绝对输出路径/尺寸/描述填进模板（agent 据此存图）
                const prompt = o.promptTemplate
                  .replaceAll('{desc}', o.desc)
                  .replaceAll('{out}', outAbs)
                  .replaceAll('{size}', o.size)
                  .replaceAll('{ref}', absRef)
                const args = buildArgs(template, { prompt, cwd: projectRoot, out: outAbs, ref: absRef, size: o.size, n: '1' })
                if (!args.length) {
                  candidates.push({ error: '生图命令为空' })
                  continue
                }
                // codex 等 agent 工作流单次可能较慢；串行执行（一次一个任务）
                const r = runTool(args[0], args.slice(1), projectRoot, 600000)
                if (r.notFound) {
                  candidates.push({ error: `找不到生图命令：${args[0]}` })
                  continue
                }
                if (!existsSync(outAbs)) {
                  candidates.push({ error: `命令未在预期路径生成图片（退出码 ${r.status}）：${r.output.split('\n').slice(-1)[0] ?? ''}` })
                  continue
                }
                let preview = `img-preview/${stem}.png`
                if (o.matte) {
                  const matteAbs = join(previewDir, `${stem}_cut.png`)
                  if (existsSync(matteAbs)) unlinkSync(matteAbs)
                  const ra = buildArgs(o.rembgCommand, { in: outAbs, out: matteAbs })
                  const mr = runTool(ra[0], ra.slice(1), projectRoot, 120000)
                  if (existsSync(matteAbs)) preview = `img-preview/${stem}_cut.png`
                  else candidates.push({ preview, error: `抠图失败（保留原图）：${mr.notFound ? '找不到 rembg' : mr.output.split('\n').slice(-1)[0] ?? ''}` })
                }
                if (!candidates[i]) candidates.push({ preview })
              }
              json(res, 200, { ok: candidates.some((c) => c.preview), candidates })
            })
            .catch((err: unknown) => json(res, 500, { error: String(err) }))
          return
        }

        if (url === '/api/img/matte' && req.method === 'POST') {
          void readBody(req)
            .then((body) => {
              const { src, rembgCommand, name } = JSON.parse(body) as { src: string; rembgCommand: string; name: string }
              if (!safeAssetPath(src) && !/^(sprite|bg|production)\//.test(src)) {
                json(res, 400, { error: `无效源路径：${src}` })
                return
              }
              const srcAbs = join(projectRoot, src)
              if (!existsSync(srcAbs)) {
                json(res, 200, { ok: false, error: `源文件不存在：${src}` })
                return
              }
              const previewDir = join(projectRoot, 'build/img-preview')
              mkdirSync(previewDir, { recursive: true })
              const stem = `${(name || 'matte').replace(/[^\w-]/g, '_')}_cut`
              const outAbs = join(previewDir, `${stem}.png`)
              if (existsSync(outAbs)) unlinkSync(outAbs)
              const ra = buildArgs(rembgCommand, { in: srcAbs, out: outAbs })
              const r = runTool(ra[0], ra.slice(1), projectRoot, 120000)
              if (r.notFound) {
                json(res, 200, { ok: false, error: `找不到 rembg：${ra[0]}` })
                return
              }
              if (!existsSync(outAbs)) {
                json(res, 200, { ok: false, error: `抠图未产出（退出码 ${r.status}）：${r.output.split('\n').slice(-1)[0] ?? ''}` })
                return
              }
              json(res, 200, { ok: true, preview: `img-preview/${stem}.png` })
            })
            .catch((err: unknown) => json(res, 500, { error: String(err) }))
          return
        }

        if (url === '/api/img/commit' && req.method === 'POST') {
          void readBody(req)
            .then((body) => {
              const { preview, to } = JSON.parse(body) as { preview: string; to: string }
              if (!/^img-preview\/[\w-]+\.png$/.test(preview)) {
                json(res, 400, { error: `无效预览路径：${preview}` })
                return
              }
              if (!safeAssetPath(to)) {
                json(res, 400, { error: `无效目标路径：${to}` })
                return
              }
              const src = join(projectRoot, 'build', preview)
              if (!existsSync(src)) {
                json(res, 400, { error: `预览文件不存在：${preview}` })
                return
              }
              const abs = dedupePath(join(projectRoot, to))
              mkdirSync(dirname(abs), { recursive: true })
              copyFileSync(src, abs)
              json(res, 200, { ok: true, path: abs.slice(projectRoot.length).replace(/^[/\\]/, '').replaceAll('\\', '/') })
            })
            .catch((err: unknown) => json(res, 500, { error: String(err) }))
          return
        }

        if (url.startsWith('/img-preview/')) {
          const file = join(projectRoot, 'build', decodeURIComponent(url.slice(1)))
          if (existsSync(file) && statSync(file).isFile()) {
            res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
            res.setHeader('Cache-Control', 'no-store')
            createReadStream(file).pipe(res)
          } else {
            res.statusCode = 404
            res.end('not found')
          }
          return
        }

        if (url === '/api/assets') {
          const walk = (dir: string, prefix: string): string[] => {
            const full = join(projectRoot, dir)
            if (!existsSync(full)) return []
            const out: string[] = []
            for (const e of readdirSync(full, { withFileTypes: true })) {
              if (e.name.startsWith('.')) continue
              if (e.isDirectory()) out.push(...walk(`${dir}/${e.name}`, `${prefix}/${e.name}`))
              else out.push(`${prefix}/${e.name}`)
            }
            return out
          }
          const cats = ['bg', 'bgm', 'se', 'sprite', 'voice', 'production', 'item'] as const
          const files: Record<string, string[]> = {}
          for (const c of cats) files[c] = walk(c, c)
          json(res, 200, { files })
          return
        }

        if (url === '/api/files') {
          const scenes = existsSync(join(projectRoot, 'story/scenes'))
            ? readdirSync(join(projectRoot, 'story/scenes'))
                .filter((f) => /\.ya?ml$/.test(f))
                .map((f) => `story/scenes/${f}`)
            : []
          json(res, 200, { files: ['story/story.yaml', 'story/characters.yaml', 'story/assets.yaml', 'story/items.yaml', ...scenes] })
          return
        }

        if (url === '/api/file' && req.method === 'GET') {
          const p = query.get('path') ?? ''
          if (!safeYamlPath(p) || !existsSync(join(projectRoot, p))) {
            json(res, 404, { error: `not found: ${p}` })
            return
          }
          json(res, 200, { path: p, content: readFileSync(join(projectRoot, p), 'utf8') })
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
              writeFileSync(join(projectRoot, path), content, 'utf8')
              json(res, 200, { ok: true })
            })
            .catch((err: unknown) => json(res, 500, { error: String(err) }))
          return
        }

        if (/^\/(sprite|bg|bgm|se|voice|production|item)\//.test(url)) {
          const file = join(projectRoot, decodeURIComponent(url))
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
        server.watcher.add(join(projectRoot, 'story'))
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
