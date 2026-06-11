import './style.css'
import { monaco } from './monacoSetup.js'
import { Game } from '@vn/player'
import type { StoryIR } from '@vn/core'
import { renderGraph } from './graph.js'

interface Diag {
  severity: 'error' | 'warning' | 'info'
  code: string
  message: string
  file: string
  pos: { line: number; col: number } | null
}

interface CompilePayload {
  ir: StoryIR | null
  diagnostics: Diag[]
}

const app = document.getElementById('app')!
app.innerHTML = `
  <div id="editor-app">
    <div id="toolbar">
      <span class="brand">VN 编辑器</span>
      <button id="btn-save" class="primary" title="Ctrl+S">保存并更新预览</button>
      <button id="btn-restart">重启预览</button>
      <button id="btn-view">流程图</button>
      <span class="status" id="status">就绪</span>
    </div>
    <aside id="files"></aside>
    <main id="editor"></main>
    <section id="side">
      <div id="preview"><div class="preview-msg">加载中…</div></div>
      <div id="graph"></div>
    </section>
    <footer id="problems"><div class="p-head">问题</div></footer>
  </div>`

const filesEl = document.getElementById('files')!
const editorEl = document.getElementById('editor')!
const previewEl = document.getElementById('preview')!
const graphEl = document.getElementById('graph')!
const sideEl = document.getElementById('side')!
const problemsEl = document.getElementById('problems')!
const statusEl = document.getElementById('status')!

const editor = monaco.editor.create(editorEl, {
  theme: 'vs-dark',
  fontSize: 14,
  automaticLayout: true,
  minimap: { enabled: false },
  wordWrap: 'on',
  tabSize: 2,
  insertSpaces: true,
  unicodeHighlight: { ambiguousCharacters: false },
})

const models = new Map<string, ReturnType<typeof monaco.editor.createModel>>()
const dirty = new Set<string>()
let currentPath: string | null = null
let fileList: string[] = []
let lastGood: { ir: StoryIR; warnings: number } | null = null
let lastDiags: Diag[] = []
let game: Game | null = null
let compileTimer: number | null = null
let compileSeq = 0

// ---------- 文件管理 ----------

async function loadFileList(): Promise<void> {
  fileList = ((await (await fetch('/api/files')).json()) as { files: string[] }).files
  renderFileList()
}

function renderFileList(): void {
  const group = (title: string, files: string[]): string =>
    `<div class="group">${title}</div>` +
    files
      .map((f) => {
        const name = f.split('/').pop()!
        const cls = ['file', f === currentPath ? 'active' : '', dirty.has(f) ? 'dirty' : ''].join(' ')
        return `<div class="${cls}" data-path="${f}">${name}</div>`
      })
      .join('')
  const registry = fileList.filter((f) => !f.includes('/scenes/'))
  const scenes = fileList.filter((f) => f.includes('/scenes/'))
  filesEl.innerHTML = group('注册表', registry) + group('场景', scenes)
  for (const el of filesEl.querySelectorAll<HTMLElement>('.file')) {
    el.addEventListener('click', () => void openFile(el.dataset.path!))
  }
}

async function openFile(path: string): Promise<void> {
  let model = models.get(path)
  if (!model) {
    const data = (await (await fetch(`/api/file?path=${encodeURIComponent(path)}`)).json()) as { content: string }
    model = monaco.editor.createModel(data.content, 'yaml', monaco.Uri.parse(`file:///${path}`))
    model.onDidChangeContent(() => {
      dirty.add(path)
      renderFileList()
      scheduleCompile()
    })
    models.set(path, model)
  }
  currentPath = path
  editor.setModel(model)
  renderFileList()
}

async function saveDirty(): Promise<void> {
  const paths = [...dirty]
  for (const path of paths) {
    const model = models.get(path)
    if (!model) continue
    await fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content: model.getValue() }),
    })
    dirty.delete(path)
  }
  renderFileList()
  await compileNow()
  restartPreview()
}

// ---------- 编译与诊断 ----------

function scheduleCompile(): void {
  if (compileTimer !== null) clearTimeout(compileTimer)
  compileTimer = window.setTimeout(() => void compileNow(), 400)
}

async function compileNow(): Promise<void> {
  const seq = ++compileSeq
  const overrides: Record<string, string> = {}
  for (const [path, model] of models) overrides[path] = model.getValue()
  let payload: CompilePayload
  try {
    payload = (await (
      await fetch('/api/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides }),
      })
    ).json()) as CompilePayload
  } catch (err) {
    statusEl.innerHTML = `<span class="err">编译服务不可用：${String(err)}</span>`
    return
  }
  if (seq !== compileSeq) return // 过期结果丢弃

  lastDiags = payload.diagnostics
  if (payload.ir) {
    lastGood = { ir: payload.ir, warnings: payload.diagnostics.filter((d) => d.severity === 'warning').length }
    if (sideEl.classList.contains('graph-mode')) refreshGraph()
  }
  applyMarkers()
  renderProblems()
  renderStatus()
}

function applyMarkers(): void {
  for (const [path, model] of models) {
    const markers = lastDiags
      .filter((d) => d.file === path && d.pos)
      .map((d) => {
        const line = d.pos!.line
        const col = d.pos!.col
        const lineLen = Math.max(col + 1, model.getLineLength(Math.min(line, model.getLineCount())) + 1)
        return {
          severity:
            d.severity === 'error'
              ? monaco.MarkerSeverity.Error
              : d.severity === 'warning'
                ? monaco.MarkerSeverity.Warning
                : monaco.MarkerSeverity.Info,
          message: `[${d.code}] ${d.message}`,
          startLineNumber: line,
          startColumn: col,
          endLineNumber: line,
          endColumn: lineLen,
        }
      })
    monaco.editor.setModelMarkers(model, 'vn-compiler', markers)
  }
}

function renderProblems(): void {
  const order = { error: 0, warning: 1, info: 2 }
  const items = [...lastDiags].sort((a, b) => order[a.severity] - order[b.severity])
  problemsEl.innerHTML =
    `<div class="p-head">问题（${items.length}）</div>` +
    items
      .map((d, i) => {
        const loc = d.pos ? `${d.file}:${d.pos.line}:${d.pos.col}` : d.file
        return `<div class="p-item sev-${d.severity}" data-i="${i}"><span class="p-loc">${loc}</span>[${d.code}] ${escapeHtml(d.message)}</div>`
      })
      .join('')
  for (const el of problemsEl.querySelectorAll<HTMLElement>('.p-item')) {
    el.addEventListener('click', () => {
      const d = items[Number(el.dataset.i)]
      if (!d.file.endsWith('.yaml') && !d.file.endsWith('.yml')) return
      void openFile(d.file).then(() => {
        if (d.pos) {
          editor.revealLineInCenter(d.pos.line)
          editor.setPosition({ lineNumber: d.pos.line, column: d.pos.col })
          editor.focus()
        }
      })
    })
  }
}

function renderStatus(): void {
  const errs = lastDiags.filter((d) => d.severity === 'error').length
  const warns = lastDiags.filter((d) => d.severity === 'warning').length
  statusEl.innerHTML = errs
    ? `<span class="err">${errs} 错误</span> <span class="warn">${warns} 警告</span>`
    : `<span class="ok">✓ 可运行</span> <span class="warn">${warns} 警告</span>`
}

// ---------- 预览与流程图 ----------

function restartPreview(): void {
  game?.dispose()
  game = null
  if (!lastGood) {
    previewEl.innerHTML = `<div class="preview-msg">剧本有编译错误\n修复后保存即可恢复预览</div>`
    return
  }
  previewEl.innerHTML = ''
  game = new Game(previewEl, lastGood.ir, lastGood.warnings)
  game.start()
}

function refreshGraph(): void {
  if (lastGood) {
    renderGraph(graphEl, lastGood.ir, (sceneId) => {
      sideEl.classList.remove('graph-mode')
      viewBtn.textContent = '流程图'
      void openFile(`story/scenes/${sceneId}.yaml`)
    })
  } else {
    graphEl.innerHTML = `<div class="preview-msg">剧本有编译错误，无法生成流程图</div>`
  }
}

// ---------- 工具栏与快捷键 ----------

const viewBtn = document.getElementById('btn-view')!
document.getElementById('btn-save')!.addEventListener('click', () => void saveDirty())
document.getElementById('btn-restart')!.addEventListener('click', () => restartPreview())
viewBtn.addEventListener('click', () => {
  const toGraph = !sideEl.classList.contains('graph-mode')
  sideEl.classList.toggle('graph-mode', toGraph)
  viewBtn.textContent = toGraph ? '预览' : '流程图'
  if (toGraph) refreshGraph()
})
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    void saveDirty()
  }
})
window.addEventListener('beforeunload', (e) => {
  if (dirty.size) e.preventDefault()
})

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

// ---------- 启动 ----------

async function boot(): Promise<void> {
  await loadFileList()
  const firstScene = fileList.find((f) => f.includes('/scenes/')) ?? fileList[0]
  if (firstScene) await openFile(firstScene)
  await compileNow()
  restartPreview()
}

void boot()
