import './style.css'
import { monaco } from './monacoSetup.js'
import { Game } from '@vn/player'
import type { StoryIR } from '@vn/core'
import { renderGraph } from './graph.js'
import { AssetPanel, DRAG_MIME } from './assetPanel.js'
import { CursorPreview } from './cursorPreview.js'
import { pickPath } from './fsBrowser.js'
import { openTtsSettings } from './ttsSettings.js'
import { openImageSettings } from './imageSettings.js'

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
      <button id="btn-project" title="切换到另一个项目目录">📂 <span id="project-name">…</span></button>
      <button id="btn-save" class="primary" title="Ctrl+S">保存并更新预览</button>
      <button id="btn-restart">重启预览</button>
      <button id="btn-view">流程图</button>
      <button id="btn-tts">TTS 设置</button>
      <button id="btn-img">图片设置</button>
      <span class="status" id="status">就绪</span>
    </div>
    <aside id="sidebar">
      <div id="side-tabs">
        <button class="tab active" data-tab="files">文件</button>
        <button class="tab" data-tab="assets">资产</button>
      </div>
      <div id="files"></div>
      <div id="assets-panel" hidden></div>
    </aside>
    <main id="editor"></main>
    <section id="side">
      <div id="preview"><div class="preview-msg">加载中…</div></div>
      <div id="graph"></div>
    </section>
    <footer id="problems"><div class="p-head">问题</div></footer>
  </div>`

const filesEl = document.getElementById('files')!
const assetsEl = document.getElementById('assets-panel')!
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

// ---------- 文件与 model 管理 ----------

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

/** 加载（不切换编辑器）；所有 model 都从这里建，统一挂 dirty/编译监听 */
async function ensureModel(path: string): Promise<ReturnType<typeof monaco.editor.createModel>> {
  let model = models.get(path)
  if (!model) {
    const data = (await (await fetch(`/api/file?path=${encodeURIComponent(path)}`)).json()) as { content?: string }
    // 文件可能尚不存在（如首次添加物品前的 items.yaml）→ 空缓冲，保存时落盘创建
    model = monaco.editor.createModel(data.content ?? '', 'yaml', monaco.Uri.parse(`file:///${path}`))
    model.onDidChangeContent(() => {
      dirty.add(path)
      renderFileList()
      scheduleCompile()
    })
    models.set(path, model)
  }
  return model
}

async function openFile(path: string): Promise<void> {
  const model = await ensureModel(path)
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
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ path, content: model.getValue() }),
    })
    dirty.delete(path)
  }
  renderFileList()
  await compileNow()
  restartPreview()
  if (!assetsEl.hidden) void assetPanel.refresh()
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
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
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
        const line = Math.min(d.pos!.line, model.getLineCount())
        const col = d.pos!.col
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
          endColumn: Math.max(col + 1, model.getLineLength(line) + 1),
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

// ---------- 资产面板与脚本插入 ----------

/** 在光标所在行下方插入一个步骤（2 空格缩进的 "- xxx"） */
function insertStep(snippet: string): void {
  const model = editor.getModel()
  if (!model || !currentPath?.includes('/scenes/')) {
    void openFile(fileList.find((f) => f.includes('/scenes/')) ?? fileList[0]).then(() => insertStep(snippet))
    return
  }
  const pos = editor.getPosition() ?? { lineNumber: model.getLineCount(), column: 1 }
  insertStepAtLine(snippet, pos.lineNumber)
}

function insertStepAtLine(snippet: string, lineNumber: number): void {
  const model = editor.getModel()
  if (!model) return
  const text = snippet.startsWith('- ') ? snippet : `- ${snippet}`
  const col = model.getLineMaxColumn(lineNumber)
  editor.executeEdits('vn-asset', [
    { range: new monaco.Range(lineNumber, col, lineNumber, col), text: `\n  ${text}` },
  ])
  editor.setPosition({ lineNumber: lineNumber + 1, column: model.getLineMaxColumn(lineNumber + 1) })
  editor.focus()
}

const assetPanel = new AssetPanel(assetsEl, {
  getIr: () => lastGood?.ir ?? null,
  ensureModel,
  insertStep,
  openFile: (p) => void openFile(p),
  onMutated: () => {
    void compileNow().then(() => assetPanel.refresh())
  },
})

// 拖拽资产 → 放到编辑器某一行
const editorDom = editor.getDomNode()
if (editorDom) {
  editorDom.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'copy'
  })
  editorDom.addEventListener('drop', (e) => {
    const snippet = e.dataTransfer?.getData(DRAG_MIME)
    if (!snippet) return
    e.preventDefault()
    const target = editor.getTargetAtClientPoint(e.clientX, e.clientY)
    const line = target?.position?.lineNumber ?? editor.getModel()?.getLineCount() ?? 1
    insertStepAtLine(snippet, line)
  })
}

// 光标停留预览小窗
new CursorPreview(editor, () => lastGood?.ir ?? null)

// ---------- 工具栏、标签页与快捷键 ----------

// ---------- 项目切换 ----------

async function loadProjectInfo(): Promise<void> {
  try {
    const p = (await (await fetch('/api/project')).json()) as { root: string; name: string }
    const el = document.getElementById('project-name')!
    el.textContent = p.name
    document.getElementById('btn-project')!.title = `当前项目：${p.root}\n点击切换到另一个项目目录`
  } catch {
    /* 服务暂不可用时保持占位 */
  }
}

async function openProject(): Promise<void> {
  if (dirty.size && !confirm('有未保存的修改，切换项目将丢弃。继续？')) return
  const dir = await pickPath({ title: '打开项目（选择含 story/story.yaml 的目录）', mode: 'dir' })
  if (!dir) return
  const r = (await (
    await fetch('/api/project/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ path: dir }),
    })
  ).json()) as { ok?: boolean; error?: string }
  if (!r.ok) {
    alert(`打开项目失败：${r.error ?? '未知错误'}`)
    return
  }
  dirty.clear() // 已确认丢弃；清掉避免 beforeunload 再拦一次
  location.reload() // 全量重载：编辑器状态（model/预览/资产面板）全部按新项目重建
}

const viewBtn = document.getElementById('btn-view')!
document.getElementById('btn-project')!.addEventListener('click', () => void openProject())
document.getElementById('btn-save')!.addEventListener('click', () => void saveDirty())
document.getElementById('btn-restart')!.addEventListener('click', () => restartPreview())
document.getElementById('btn-tts')!.addEventListener('click', () => void openTtsSettings())
document.getElementById('btn-img')!.addEventListener('click', () => void openImageSettings())
viewBtn.addEventListener('click', () => {
  const toGraph = !sideEl.classList.contains('graph-mode')
  sideEl.classList.toggle('graph-mode', toGraph)
  viewBtn.textContent = toGraph ? '预览' : '流程图'
  if (toGraph) refreshGraph()
})

for (const tab of document.querySelectorAll<HTMLElement>('#side-tabs .tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#side-tabs .tab').forEach((t) => t.classList.remove('active'))
    tab.classList.add('active')
    const isAssets = tab.dataset.tab === 'assets'
    filesEl.hidden = isAssets
    assetsEl.hidden = !isAssets
    if (isAssets) void assetPanel.refresh()
  })
}

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
  void loadProjectInfo()
  await loadFileList()
  const firstScene = fileList.find((f) => f.includes('/scenes/')) ?? fileList[0]
  if (firstScene) await openFile(firstScene)
  await compileNow()
  restartPreview()
}

void boot()
