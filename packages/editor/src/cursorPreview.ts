import { monaco } from './monacoSetup.js'
import { isAudio, isImage } from './assetIndex.js'
import type { StoryIR } from '@vn/core'

type Editor = ReturnType<typeof monaco.editor.create>

interface PreviewSpec {
  title: string
  file: string | null
  missing: boolean
  detail?: string
}

/**
 * 光标停留预览：光标落在资产名/角色台词/语音 id 上时，
 * 在该位置弹出小窗（图片直接显示，音频给播放器）。
 */
export class CursorPreview {
  private widget: monaco.editor.IContentWidget | null = null
  private dom = document.createElement('div')
  private timer: number | null = null

  constructor(
    private editor: Editor,
    private getIr: () => StoryIR | null,
  ) {
    this.dom.className = 'cursor-preview'
    editor.onDidChangeCursorPosition((e) => {
      if (this.timer !== null) clearTimeout(this.timer)
      this.hide()
      this.timer = window.setTimeout(() => this.maybeShow(e.position), 300)
    })
    editor.onDidBlurEditorWidget(() => this.hide())
    editor.onKeyDown((e) => {
      if (e.keyCode === monaco.KeyCode.Escape) this.hide()
    })
  }

  private maybeShow(pos: monaco.Position): void {
    const ir = this.getIr()
    const model = this.editor.getModel()
    if (!ir || !model) return
    const line = model.getLineContent(pos.lineNumber)
    const spec = resolveAsset(ir, line, pos.column)
    if (!spec) return

    const parts = [`<div class="cp-title">${esc(spec.title)}</div>`]
    if (spec.file && isImage(spec.file)) parts.push(`<img src="${encodeURI('/' + spec.file)}" alt="">`)
    else if (spec.file && isAudio(spec.file)) parts.push(`<audio controls src="${encodeURI('/' + spec.file)}"></audio>`)
    if (spec.missing) parts.push(`<div class="cp-missing">文件未到位 · 占位中</div>`)
    if (spec.detail) parts.push(`<div class="cp-detail">${esc(spec.detail)}</div>`)
    this.dom.innerHTML = parts.join('')

    const widget: monaco.editor.IContentWidget = {
      getId: () => 'vn.cursor-preview',
      getDomNode: () => this.dom,
      getPosition: () => ({
        position: pos,
        preference: [
          monaco.editor.ContentWidgetPositionPreference.ABOVE,
          monaco.editor.ContentWidgetPositionPreference.BELOW,
        ],
      }),
    }
    this.widget = widget
    this.editor.addContentWidget(widget)
  }

  hide(): void {
    if (this.widget) {
      this.dom.querySelector('audio')?.pause()
      this.editor.removeContentWidget(this.widget)
      this.widget = null
    }
  }
}

/** 解析光标处指向的资产 */
export function resolveAsset(ir: StoryIR, line: string, column: number): PreviewSpec | null {
  const col = column - 1 // 0-based

  const hit = (name: string): boolean => {
    for (let i = line.indexOf(name); i >= 0; i = line.indexOf(name, i + 1)) {
      if (col >= i && col <= i + name.length) return true
    }
    return false
  }

  // 语音 id（id: xxx / voice: xxx）
  const idMatch = /\b(?:id|voice):\s*([A-Za-z0-9_]+)/.exec(line)
  if (idMatch && hit(idMatch[1])) {
    const loc = ir.lineIndex[idMatch[1]]
    if (loc) {
      const op = ir.scenes[loc[0]]?.ops[loc[1]]
      if (op?.op === 'say' && op.voice) {
        return {
          title: `语音 ${op.voice.id}`,
          file: op.voice.missing ? null : op.voice.file,
          missing: op.voice.missing,
          detail: `${op.who}：${op.text}`,
        }
      }
    }
  }

  // 背景 / BGM / SE 名
  const tables: Array<[string, Record<string, { file: string; missing: boolean }>]> = [
    ['背景', ir.assets.backgrounds],
    ['BGM', ir.assets.bgm],
    ['音效', ir.assets.se],
  ]
  for (const [label, table] of tables) {
    for (const [name, a] of Object.entries(table)) {
      if (hit(name)) {
        return { title: `${label} ${name}`, file: a.missing ? null : a.file, missing: a.missing, detail: a.file }
      }
    }
  }

  // 角色名（台词行 / show / who）→ 解析一个代表性变体
  for (const [name, def] of Object.entries(ir.characters)) {
    if (!def.sprite || !hit(name)) continue
    const faceMatch = new RegExp(`${escapeRe(name)}@([^\\s:："']+)`).exec(line) ?? /\bface:\s*([^\s,}"']+)/.exec(line)
    const face = faceMatch?.[1] ?? def.sprite.default.face
    const outfit = /\boutfit:\s*([^\s,}"']+)/.exec(line)?.[1] ?? def.sprite.default.outfit
    const stateM = /\bstate:\s*\[([^\]]*)\]/.exec(line) ?? /\bstate:\s*([^\s,}"']+)/.exec(line)
    const state = stateM ? stateM[1].split(',').map((s) => s.trim()).filter(Boolean) : []
    const combo = `${outfit}|${[...state].sort().join('+')}|${face}`
    const file = def.sprite.variants[combo]
    const registered = combo in def.sprite.variants
    return {
      title: `${name} [${outfit} / ${state.join('+') || '－'} / ${face}]`,
      file: file ?? null,
      missing: !file,
      detail: registered ? (file ?? '已注册，文件缺失') : '该组合未注册变体（将进出图清单）',
    }
  }

  return null
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
