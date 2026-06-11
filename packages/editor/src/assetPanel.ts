import {
  buildAssetIndex,
  isAudio,
  isImage,
  suggestName,
  type AssetIndex,
  type CharacterView,
} from './assetIndex.js'
import { addRef, registerAsset, registerVariant, setTtsSample, type YamlModel } from './yamlEdit.js'
import type { StoryIR } from '@vn/core'

export interface AssetPanelHost {
  getIr(): StoryIR | null
  /** 确保 YAML model 已加载（不切换编辑器） */
  ensureModel(path: string): Promise<YamlModel>
  /** 在脚本光标处插入一个步骤行 */
  insertStep(snippet: string): void
  openFile(path: string): void
  /** 注册动作之后触发（重编译 + 刷新面板） */
  onMutated(): void
}

/** 拖拽载荷：drop 处理器按整行步骤插入 */
export const DRAG_MIME = 'text/plain'

export class AssetPanel {
  private index: AssetIndex | null = null
  private collapsed = new Set<string>()
  private previewEl: HTMLElement

  constructor(
    private container: HTMLElement,
    private host: AssetPanelHost,
  ) {
    this.previewEl = document.createElement('div')
    this.previewEl.id = 'asset-preview'
    document.body.appendChild(this.previewEl)
    document.addEventListener('click', (e) => {
      if (!this.previewEl.contains(e.target as Node) && !this.container.contains(e.target as Node)) {
        this.hidePreview()
      }
    })
  }

  async refresh(): Promise<void> {
    const ir = this.host.getIr()
    if (!ir) {
      this.container.innerHTML = `<div class="asset-empty">剧本有编译错误，修复后可用</div>`
      return
    }
    const scan = (await (await fetch('/api/assets')).json()) as { files: Record<string, string[]> }
    const charactersModel = await this.host.ensureModel('story/characters.yaml')
    this.index = buildAssetIndex(scan, ir, charactersModel.getValue())
    this.render()
  }

  // ---------- 渲染 ----------

  private render(): void {
    const idx = this.index!
    const html: string[] = [`<div class="asset-toolbar"><button data-act="refresh">↻ 刷新</button></div>`]

    html.push(this.section('背景', 'bg', [
      ...idx.backgrounds.map((a) =>
        this.item({
          icon: '🖼', label: a.name, sub: a.file, badge: a.missing ? '缺文件' : '',
          drag: `bg: ${a.name}`, data: { kind: 'bg', name: a.name, file: a.file, missing: String(a.missing) },
        }),
      ),
      ...idx.loose.bg.map((f) =>
        this.item({ icon: '＋', label: f.split('/').pop()!, sub: '未注册', cls: 'unreg', data: { kind: 'loose-bg', file: f } }),
      ),
    ]))

    html.push(this.section('立绘', 'sprite', idx.characters.filter((c) => c.variants.length || c.unregisteredSprites.length).map((c) => this.charSprites(c)).flat()
      .concat(idx.loose.sprite.map((f) => this.item({ icon: '＋', label: f, sub: '未注册（目录未关联角色）', cls: 'unreg', data: { kind: 'loose-sprite-orphan', file: f } })))))

    html.push(this.section('BGM', 'bgm', [
      ...idx.bgm.map((a) =>
        this.item({ icon: '♫', label: a.name, sub: a.file, badge: a.missing ? '缺文件' : '', drag: `bgm: ${a.name}`, data: { kind: 'bgm', name: a.name, file: a.file, missing: String(a.missing) } }),
      ),
      ...idx.loose.bgm.map((f) => this.item({ icon: '＋', label: f.split('/').pop()!, sub: '未注册', cls: 'unreg', data: { kind: 'loose-bgm', file: f } })),
    ]))

    html.push(this.section('音效', 'se', [
      ...idx.se.map((a) =>
        this.item({ icon: '♪', label: a.name, sub: a.file, badge: a.missing ? '缺文件' : '', drag: `se: ${a.name}`, data: { kind: 'se', name: a.name, file: a.file, missing: String(a.missing) } }),
      ),
      ...idx.loose.se.map((f) => this.item({ icon: '＋', label: f.split('/').pop()!, sub: '未注册', cls: 'unreg', data: { kind: 'loose-se', file: f } })),
    ]))

    html.push(this.section('语音', 'voice', idx.voice.map((v) => {
      const done = v.lines.filter((l) => l.exists).length
      return [
        `<div class="asset-subhead">${esc(v.scene)}（${done}/${v.lines.length} 已录）</div>`,
        ...v.lines.map((l) =>
          this.item({ icon: l.exists ? '◉' : '○', label: l.id, sub: l.exists ? '已录' : '待录', cls: l.exists ? '' : 'unreg', data: { kind: 'voice', file: l.file, missing: String(!l.exists) } }),
        ),
      ].join('')
    })))

    html.push(this.section('编辑素材', 'production', [
      ...idx.characters.filter((c) => c.refs.length || c.tts).map((c) => this.charProduction(c)).flat(),
      ...idx.loose.refs.map((f) =>
        this.item({ icon: '🎨', label: f.replace('production/refs/', ''), sub: '参考图 · 未关联', cls: 'unreg', data: { kind: 'loose-ref', file: f } }),
      ),
      ...idx.loose.tts.map((f) =>
        this.item({ icon: '🎙', label: f.replace('production/tts/', ''), sub: '音色 · 未关联', cls: 'unreg', data: { kind: 'loose-tts', file: f } }),
      ),
    ]))

    this.container.innerHTML = html.join('')
    this.bind()
  }

  private charSprites(c: CharacterView): string[] {
    return [
      `<div class="asset-subhead" style="color:${c.color ?? '#9aa3c0'}">${esc(c.name)}</div>`,
      ...c.variants.map((v) =>
        this.item({
          icon: '◩', label: `${v.outfit} / ${v.state.join('+') || '－'} / ${v.face}`, sub: v.file, badge: v.missing ? '缺图' : '',
          drag: `show: { who: ${c.name}${v.outfit ? `, outfit: ${v.outfit}` : ''}${v.state.length ? `, state: [${v.state.join(', ')}]` : ''}, face: ${v.face} }`,
          data: { kind: 'variant', who: c.name, file: v.missing ? '' : v.file, combo: v.combo, outfit: v.outfit, state: v.state.join('+'), face: v.face },
        }),
      ),
      ...c.unregisteredSprites.map((f) =>
        this.item({ icon: '＋', label: f.replace(/^sprite\//, ''), sub: '未注册变体', cls: 'unreg', data: { kind: 'loose-sprite', who: c.name, file: f } }),
      ),
    ]
  }

  private charProduction(c: CharacterView): string[] {
    const rows = [`<div class="asset-subhead" style="color:${c.color ?? '#9aa3c0'}">${esc(c.name)}</div>`]
    for (const r of c.refs) {
      rows.push(this.item({ icon: '🎨', label: r.path.replace('production/refs/', ''), sub: r.exists ? '参考图' : '参考图 · 缺文件', badge: r.exists ? '' : '缺文件', data: { kind: 'ref', file: r.path, missing: String(!r.exists) } }))
    }
    if (c.tts) {
      const sub = `${c.tts.provider ?? '未设 provider'}${c.tts.params ? ' · ' + Object.entries(c.tts.params).map(([k, v]) => `${k}=${String(v)}`).join(' ') : ''}`
      rows.push(this.item({ icon: '🎙', label: c.tts.sample ?? '（未设音色文件）', sub: `TTS ${sub}`, badge: c.tts.sample && !c.tts.sampleExists ? '缺文件' : '', data: { kind: 'tts', file: c.tts.sample ?? '', missing: String(!c.tts.sampleExists) } }))
    }
    return rows
  }

  private section(title: string, key: string, items: string[]): string {
    const closed = this.collapsed.has(key)
    return `
      <div class="asset-section">
        <div class="asset-head" data-sec="${key}">${closed ? '▸' : '▾'} ${title}<span class="count">${items.length}</span></div>
        <div class="asset-items" ${closed ? 'hidden' : ''}>${items.join('') || '<div class="asset-empty">（空）</div>'}</div>
      </div>`
  }

  private item(o: {
    icon: string
    label: string
    sub?: string
    badge?: string
    cls?: string
    drag?: string
    data: Record<string, string>
  }): string {
    const data = Object.entries(o.data)
      .map(([k, v]) => `data-${k}="${esc(v)}"`)
      .join(' ')
    return `
      <div class="asset-item ${o.cls ?? ''}" ${o.drag ? `draggable="true" data-drag="${esc(o.drag)}"` : ''} ${data}>
        <span class="a-icon">${o.icon}</span>
        <span class="a-label" title="${esc(o.sub ?? '')}">${esc(o.label)}</span>
        ${o.badge ? `<span class="a-badge">${esc(o.badge)}</span>` : ''}
      </div>`
  }

  // ---------- 交互 ----------

  private bind(): void {
    this.container.querySelector('[data-act="refresh"]')?.addEventListener('click', () => void this.refresh())
    for (const head of this.container.querySelectorAll<HTMLElement>('.asset-head')) {
      head.addEventListener('click', () => {
        const key = head.dataset.sec!
        if (this.collapsed.has(key)) this.collapsed.delete(key)
        else this.collapsed.add(key)
        this.render()
      })
    }
    for (const el of this.container.querySelectorAll<HTMLElement>('.asset-item')) {
      el.addEventListener('click', () => this.showPreview(el))
      if (el.dataset.drag) {
        el.addEventListener('dragstart', (e) => {
          e.dataTransfer?.setData(DRAG_MIME, el.dataset.drag!)
          e.dataTransfer!.effectAllowed = 'copy'
        })
      }
    }
  }

  /** 预览浮窗：图片/音频 + 上下文相关动作 */
  private showPreview(el: HTMLElement): void {
    const d = el.dataset
    const file = d.file ?? ''
    const missing = d.missing === 'true' || !file
    const parts: string[] = [`<div class="ap-title">${esc(d.name ?? d.combo ?? file.split('/').pop() ?? '')}</div>`]

    if (!missing && isImage(file)) parts.push(`<img src="${encodeURI('/' + file)}" alt="">`)
    else if (!missing && isAudio(file)) parts.push(`<audio controls src="${encodeURI('/' + file)}"></audio>`)
    else if (missing) parts.push(`<div class="ap-missing">文件不存在${file ? `：${esc(file)}` : ''}<br>（游戏内将占位渲染）</div>`)
    if (file) parts.push(`<div class="ap-path">${esc(file)}</div>`)

    const actions: Array<[string, () => void | Promise<void>]> = []
    const kind = d.kind!
    if (d.drag) actions.push(['插入到脚本', () => this.host.insertStep(d.drag!.startsWith('-') ? d.drag! : d.drag!)])
    if (kind === 'loose-bg') actions.push(['注册为背景', () => this.registerLoose('backgrounds', d.file!)])
    if (kind === 'loose-bgm') actions.push(['注册为 BGM', () => this.registerLoose('bgm', d.file!)])
    if (kind === 'loose-se') actions.push(['注册为音效', () => this.registerLoose('se', d.file!)])
    if (kind === 'loose-sprite') actions.push(['注册为变体…', () => this.registerSpriteFlow(d.who!, d.file!)])
    if (kind === 'loose-sprite-orphan') actions.push(['注册为变体…', () => this.registerSpriteFlow(null, d.file!)])
    if (kind === 'loose-ref') actions.push(['关联到角色…', () => this.associateRef(d.file!)])
    if (kind === 'loose-tts') actions.push(['设为角色音色…', () => this.associateTts(d.file!)])
    if (kind === 'tts' || kind === 'ref') actions.push(['打开 characters.yaml', () => this.host.openFile('story/characters.yaml')])

    parts.push(
      `<div class="ap-actions">${actions.map(([label], i) => `<button data-i="${i}">${esc(label)}</button>`).join('')}</div>`,
    )
    this.previewEl.innerHTML = parts.join('')
    this.previewEl.classList.add('on')
    const rect = el.getBoundingClientRect()
    this.previewEl.style.top = `${Math.min(rect.top, window.innerHeight - 320)}px`
    this.previewEl.querySelectorAll<HTMLElement>('.ap-actions button').forEach((btn) => {
      btn.addEventListener('click', () => {
        void actions[Number(btn.dataset.i)][1]()
        this.hidePreview()
      })
    })
  }

  private hidePreview(): void {
    this.previewEl.classList.remove('on')
    this.previewEl.querySelector('audio')?.pause()
  }

  // ---------- 注册动作（写回 YAML model，保存后落盘） ----------

  private async registerLoose(kind: 'backgrounds' | 'bgm' | 'se', file: string): Promise<void> {
    const name = prompt('注册名（脚本中引用的名字）：', suggestName(file))
    if (!name) return
    registerAsset(await this.host.ensureModel('story/assets.yaml'), kind, name, file)
    this.host.onMutated()
  }

  private async registerSpriteFlow(who: string | null, file: string): Promise<void> {
    const idx = this.index!
    const char = who ?? prompt(`关联到哪个角色？（${idx.characters.map((c) => c.name).join(' / ')}）`)
    if (!char) return
    const cv = idx.characters.find((c) => c.name === char)
    if (!cv) {
      alert(`角色 "${char}" 不存在`)
      return
    }
    const ask = (dim: string, options: string[], allowEmpty = false): string | null => {
      const v = prompt(`${dim}（已有：${options.join(' / ') || '无'}${allowEmpty ? '，留空=无' : ''}）：`, options[0] ?? '')
      return v === null ? null : v.trim()
    }
    const outfit = ask('outfit 衣着', cv.dims.outfit)
    if (outfit === null || !outfit) return
    const state = ask('state 状态', cv.dims.state, true)
    if (state === null) return
    const face = ask('face 表情', cv.dims.face)
    if (face === null || !face) return
    registerVariant(await this.host.ensureModel('story/characters.yaml'), char, {
      outfit,
      state: state ? state.split('+').map((s) => s.trim()).filter(Boolean) : [],
      face,
      file,
    })
    this.host.onMutated()
  }

  private async associateRef(file: string): Promise<void> {
    const char = prompt(`参考图关联到哪个角色？（${this.index!.characters.map((c) => c.name).join(' / ')}）`)
    if (!char) return
    addRef(await this.host.ensureModel('story/characters.yaml'), char, file)
    this.host.onMutated()
  }

  private async associateTts(file: string): Promise<void> {
    const char = prompt(`音色设给哪个角色？（${this.index!.characters.map((c) => c.name).join(' / ')}）`)
    if (!char) return
    setTtsSample(await this.host.ensureModel('story/characters.yaml'), char, file)
    this.host.onMutated()
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
