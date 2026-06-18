import {
  buildAssetIndex,
  isAudio,
  isImage,
  suggestName,
  type AssetIndex,
  type CharacterView,
  type ItemView,
} from './assetIndex.js'
import { pickPath } from './fsBrowser.js'
import { importAssetFlow, sanitizeFileName, type ImportSource } from './importAsset.js'
import { showModal, type ModalAction } from './modal.js'
import { loadTtsSettings, openTtsSettings, pathForMode } from './ttsSettings.js'
import { commitImage, generateImageFlow, matteFlow } from './imageGen.js'
import {
  addCharacter, addRef, clearTtsSample, ensureSpriteDefault, registerAsset, registerVariant,
  removeAsset, removeItem, removeRef, removeVariant, setItemField, setTtsSample, upsertItem, type YamlModel,
} from './yamlEdit.js'
import type { StoryIR } from '@vn/core'

export interface AssetPanelHost {
  getIr(): StoryIR | null
  ensureModel(path: string): Promise<YamlModel>
  insertStep(snippet: string): void
  openFile(path: string): void
  onMutated(): void
}

type Action = [label: string, run: () => void | Promise<void>]

export const DRAG_MIME = 'text/plain'

const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
const AUD_EXTS = ['.ogg', '.mp3', '.wav', '.m4a']

export class AssetPanel {
  private index: AssetIndex | null = null
  private collapsed = new Set<string>()
  private previewEl: HTMLElement
  private menuEl: HTMLElement

  constructor(
    private container: HTMLElement,
    private host: AssetPanelHost,
  ) {
    this.previewEl = document.createElement('div')
    this.previewEl.id = 'asset-preview'
    document.body.appendChild(this.previewEl)
    this.menuEl = document.createElement('div')
    this.menuEl.id = 'ctx-menu'
    document.body.appendChild(this.menuEl)
    document.addEventListener('click', (e) => {
      this.menuEl.classList.remove('on')
      if (!this.previewEl.contains(e.target as Node) && !this.container.contains(e.target as Node)) {
        this.hidePreview()
      }
    })
    document.addEventListener('contextmenu', (e) => {
      if (!this.container.contains(e.target as Node)) this.menuEl.classList.remove('on')
    })

    // 从 OS 拖文件进面板 → 导入流程（面板内部资产拖拽不带 Files 类型，不受影响）
    container.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      container.classList.add('drop-target')
    })
    container.addEventListener('dragleave', () => container.classList.remove('drop-target'))
    container.addEventListener('drop', (e) => {
      container.classList.remove('drop-target')
      const files = [...(e.dataTransfer?.files ?? [])]
      if (!files.length) return
      e.preventDefault()
      void (async () => {
        for (const f of files) await this.runImport({ kind: 'blob', file: f })
      })()
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
    const html: string[] = [
      `<div class="asset-toolbar"><button data-act="refresh">↻ 刷新</button> <button data-act="import">⤓ 导入素材</button> <button data-act="aigen">✨ AI 生成</button></div>`,
      `<div class="asset-drophint">可直接把图片/音频拖进本面板</div>`,
    ]

    html.push(this.section('背景', 'bg', true, [
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

    html.push(this.section('立绘', 'sprite', true, idx.characters.filter((c) => c.variants.length || c.unregisteredSprites.length).map((c) => this.charSprites(c)).flat()
      .concat(idx.loose.sprite.map((f) => this.item({ icon: '＋', label: f, sub: '未注册（目录未关联角色）', cls: 'unreg', data: { kind: 'loose-sprite-orphan', file: f } })))))

    html.push(this.section('物品', 'item', true, [
      ...idx.items.map((it) => this.itemRow(it)),
      ...idx.loose.item.map((f) =>
        this.item({ icon: '＋', label: f.replace(/^item\//, ''), sub: '未注册（item/ 下的散图）', cls: 'unreg', data: { kind: 'loose-item', file: f } }),
      ),
    ]))

    html.push(this.section('BGM', 'bgm', true, [
      ...idx.bgm.map((a) =>
        this.item({ icon: '♫', label: a.name, sub: a.file, badge: a.missing ? '缺文件' : '', drag: `bgm: ${a.name}`, data: { kind: 'bgm', name: a.name, file: a.file, missing: String(a.missing) } }),
      ),
      ...idx.loose.bgm.map((f) => this.item({ icon: '＋', label: f.split('/').pop()!, sub: '未注册', cls: 'unreg', data: { kind: 'loose-bgm', file: f } })),
    ]))

    html.push(this.section('音效', 'se', true, [
      ...idx.se.map((a) =>
        this.item({ icon: '♪', label: a.name, sub: a.file, badge: a.missing ? '缺文件' : '', drag: `se: ${a.name}`, data: { kind: 'se', name: a.name, file: a.file, missing: String(a.missing) } }),
      ),
      ...idx.loose.se.map((f) => this.item({ icon: '＋', label: f.split('/').pop()!, sub: '未注册', cls: 'unreg', data: { kind: 'loose-se', file: f } })),
    ]))

    html.push(this.section('语音', 'voice', false, idx.voice.map((v) => {
      const done = v.lines.filter((l) => l.exists).length
      return [
        `<div class="asset-subhead">${esc(v.scene)}（${done}/${v.lines.length} 已录）</div>`,
        ...v.lines.map((l) =>
          this.item({
            icon: l.exists ? '◉' : '○', label: l.id, sub: `${l.who}：${l.text}`, cls: l.exists ? '' : 'unreg',
            badge: l.exists ? '' : '待录',
            data: { kind: 'voice', file: l.file, missing: String(!l.exists), id: l.id, who: l.who, text: l.text },
          }),
        ),
      ].join('')
    })))

    html.push(this.section('编辑素材', 'production', false, [
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
          data: { kind: 'variant', who: c.name, file: v.missing ? '' : v.file, combo: v.combo, missing: String(v.missing) },
        }),
      ),
      ...c.unregisteredSprites.map((f) =>
        this.item({ icon: '＋', label: f.replace(/^sprite\//, ''), sub: '未注册变体', cls: 'unreg', data: { kind: 'loose-sprite', who: c.name, file: f } }),
      ),
    ]
  }

  private itemRow(it: ItemView): string {
    const sub = it.desc ? `${it.name} · ${it.desc}` : it.file ? `${it.name} · ${it.file}` : `${it.name} · 未配图`
    const badge = it.file ? (it.missing ? '缺图' : '') : '无图'
    return this.item({
      icon: '🎒', label: it.id, sub, badge,
      drag: `item: { get: ${it.id} }`,
      data: { kind: 'item', id: it.id, name: it.name, file: it.missing ? '' : it.file ?? '', missing: String(it.missing || !it.file) },
    })
  }

  private charProduction(c: CharacterView): string[] {
    const rows = [`<div class="asset-subhead" style="color:${c.color ?? '#9aa3c0'}">${esc(c.name)}</div>`]
    for (const r of c.refs) {
      rows.push(this.item({ icon: '🎨', label: r.path.replace('production/refs/', ''), sub: r.exists ? '参考图' : '参考图 · 缺文件', badge: r.exists ? '' : '缺文件', data: { kind: 'ref', who: c.name, file: r.path, missing: String(!r.exists) } }))
    }
    if (c.tts) {
      const sub = `${c.tts.provider ?? '未设 provider'}${c.tts.params ? ' · ' + Object.entries(c.tts.params).map(([k, v]) => `${k}=${String(v)}`).join(' ') : ''}`
      rows.push(this.item({ icon: '🎙', label: c.tts.sample ?? '（未设音色文件）', sub: `TTS ${sub}`, badge: c.tts.sample && !c.tts.sampleExists ? '缺文件' : '', data: { kind: 'tts', who: c.name, file: c.tts.sample ?? '', missing: String(!c.tts.sampleExists) } }))
    }
    return rows
  }

  private section(title: string, key: string, addable: boolean, items: string[]): string {
    const closed = this.collapsed.has(key)
    return `
      <div class="asset-section">
        <div class="asset-head" data-sec="${key}">${closed ? '▸' : '▾'} ${title}
          ${addable ? `<span class="a-add" data-add="${key}" title="新增">＋</span>` : ''}
          <span class="count">${items.length}</span>
        </div>
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
    this.container.querySelector('[data-act="import"]')?.addEventListener('click', () => void this.importFromDisk())
    this.container.querySelector('[data-act="aigen"]')?.addEventListener('click', () => void this.aiGenerate())
    for (const head of this.container.querySelectorAll<HTMLElement>('.asset-head')) {
      head.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).dataset.add) {
          void this.openAdd((e.target as HTMLElement).dataset.add!)
          return
        }
        const key = head.dataset.sec!
        if (this.collapsed.has(key)) this.collapsed.delete(key)
        else this.collapsed.add(key)
        this.render()
      })
    }
    for (const el of this.container.querySelectorAll<HTMLElement>('.asset-item')) {
      el.addEventListener('click', () => this.showPreview(el))
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        this.showMenu(el, e.clientX, e.clientY)
      })
      if (el.dataset.drag) {
        el.addEventListener('dragstart', (e) => {
          e.dataTransfer?.setData(DRAG_MIME, el.dataset.drag!)
          e.dataTransfer!.effectAllowed = 'copy'
        })
      }
    }
  }

  /** 该资产项可用的动作（预览浮窗与右键菜单共用） */
  private actionsFor(el: HTMLElement): Action[] {
    const d = el.dataset
    const kind = d.kind!
    const actions: Action[] = []
    if (d.drag) actions.push(['插入到脚本', () => this.host.insertStep(d.drag!)])
    if (kind === 'voice') {
      actions.push([d.missing === 'true' ? 'TTS 生成…' : 'TTS 重新生成/替换…', () => this.ttsFlow(d)])
    }
    // AI 生图 / 抠图
    if (kind === 'bg') actions.push([d.missing === 'true' ? 'AI 生成图片…' : 'AI 重新生成图片…', () => this.genBgInto(d.name!)])
    if (kind === 'variant') actions.push([d.missing === 'true' ? 'AI 生成立绘…' : 'AI 重新生成立绘…', () => this.genSpriteForCombo(d.who!, d.combo!)])
    if (kind === 'ref') actions.push(['AI 重新生成基准图…', () => this.genBaseRef(d.who!)])
    if ((kind === 'variant' || kind === 'loose-sprite' || kind === 'loose-sprite-orphan') && d.missing !== 'true' && d.file) {
      actions.push(['抠图（去背景）…', () => this.matteInto(d)])
    }
    if (kind === 'loose-bg') actions.push(['注册为背景', () => this.registerLoose('backgrounds', d.file!)])
    if (kind === 'loose-bgm') actions.push(['注册为 BGM', () => this.registerLoose('bgm', d.file!)])
    if (kind === 'loose-se') actions.push(['注册为音效', () => this.registerLoose('se', d.file!)])
    if (kind === 'loose-sprite') actions.push(['注册为变体…', () => this.registerSpriteFlow(d.who!, d.file!)])
    if (kind === 'loose-sprite-orphan') actions.push(['注册为变体…', () => this.registerSpriteFlow(null, d.file!)])
    if (kind === 'loose-ref') actions.push(['关联到角色…', () => this.associateRef(d.file!)])
    if (kind === 'loose-tts') actions.push(['设为角色音色…', () => this.associateTts(d.file!)])
    if (kind === 'loose-item') actions.push(['注册为物品…', () => this.registerLooseItem(d.file!)])
    if (kind === 'item') {
      actions.push(['编辑物品（名称/说明/数量）…', () => this.editItemFlow(d.id!)])
      actions.push([d.missing === 'true' ? '设置配图…' : '更换配图…', () => this.setItemImageFlow(d.id!)])
      actions.push(['打开 items.yaml', () => this.host.openFile('story/items.yaml')])
    }
    if (kind === 'tts' || kind === 'ref') actions.push(['打开 characters.yaml', () => this.host.openFile('story/characters.yaml')])

    // 移除/删除（带预览的确认框；破坏性动作放最后）
    const file = d.file ?? ''
    const exists = d.missing !== 'true' && !!file
    if (kind === 'bg' || kind === 'bgm' || kind === 'se') {
      const kindMap = { bg: 'backgrounds', bgm: 'bgm', se: 'se' } as const
      actions.push(['移除…', () => this.removeRegisteredFlow(kindMap[kind], d.name!, file, exists)])
    }
    if (kind === 'variant') actions.push(['移除变体…', () => this.removeVariantFlow(d.who!, d.combo!, file, exists)])
    if (kind === 'voice' && exists) actions.push(['删除录音…', () => this.removeVoiceFlow(d.id!, file, d.who ?? '', d.text ?? '')])
    if (kind === 'ref') actions.push(['移除参考图…', () => this.removeRefFlow(d.who!, file, exists)])
    if (kind === 'tts' && file) actions.push(['移除音色…', () => this.removeTtsFlow(d.who!, file, exists)])
    if (kind === 'item') actions.push(['移除物品…', () => this.removeItemFlow(d.id!, file, exists)])
    if (kind.startsWith('loose-')) actions.push(['删除文件…', () => this.removeLooseFlow(file)])
    return actions
  }

  // ---------- 移除资产（注册写回 + 可选删除磁盘文件） ----------

  private removePreviewHtml(file: string, exists: boolean): string {
    if (!exists) return `<div class="ap-missing">文件不存在（仅移除注册/关联）</div>`
    if (isImage(file)) return `<img class="imp-preview" src="${encodeURI('/' + file)}" alt="">`
    if (isAudio(file)) return `<audio class="imp-preview" controls src="${encodeURI('/' + file)}?t=${Date.now()}"></audio>`
    return ''
  }

  /** 预览 + 明确确认；offerDelete 时提供"同时删除文件"勾选（默认勾上） */
  private async confirmRemove(title: string, file: string, exists: boolean, detail: string, offerDelete: boolean): Promise<{ deleteFile: boolean } | null> {
    const v = await showModal({
      title,
      bodyHtml:
        this.removePreviewHtml(file, exists) +
        `<div class="rm-detail">${esc(detail)}</div>` +
        (file ? `<div class="rm-path">${esc(file)}</div>` : ''),
      submitLabel: '确认移除',
      fields: offerDelete && exists ? [{ key: 'del', label: '同时删除磁盘文件（不可恢复）', type: 'checkbox', value: true }] : [],
    })
    if (!v) return null
    return { deleteFile: offerDelete && exists && v.del === 'true' }
  }

  private async deleteFileOnDisk(path: string): Promise<boolean> {
    const r = (await (
      await fetch('/api/asset/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ path }),
      })
    ).json()) as { ok?: boolean; error?: string }
    if (!r.ok) {
      alert(`删除文件失败：${r.error ?? '未知错误'}`)
      return false
    }
    return true
  }

  private async removeRegisteredFlow(kind: 'backgrounds' | 'bgm' | 'se', name: string, file: string, exists: boolean): Promise<void> {
    const r = await this.confirmRemove(
      `移除注册：${name}`, file, exists,
      `将从 assets.yaml 移除注册名"${name}"；脚本中对它的引用会变成编译错误。注册表改动进编辑缓冲区（可撤销，保存后生效），文件删除立即生效。`,
      true,
    )
    if (!r) return
    removeAsset(await this.host.ensureModel('story/assets.yaml'), kind, name)
    if (r.deleteFile) await this.deleteFileOnDisk(file)
    this.host.onMutated()
  }

  private async removeVariantFlow(who: string, combo: string, file: string, exists: boolean): Promise<void> {
    const r = await this.confirmRemove(
      `移除变体：${who} · ${combo.split('|').join(' / ')}`, file, exists,
      '将从 characters.yaml 移除该变体条目；脚本中用到该组合的演出会变成缺图警告。',
      true,
    )
    if (!r) return
    removeVariant(await this.host.ensureModel('story/characters.yaml'), who, combo)
    if (r.deleteFile) await this.deleteFileOnDisk(file)
    this.host.onMutated()
  }

  private async removeVoiceFlow(id: string, file: string, who: string, text: string): Promise<void> {
    const brief = text.length > 30 ? text.slice(0, 30) + '…' : text
    const r = await this.confirmRemove(
      `删除录音：${id}`, file, true,
      `删除后该句台词（${who}：${brief}）回到"待录"状态，voice.lock 中的条目一并清除。`,
      false,
    )
    if (!r) return
    if (await this.deleteFileOnDisk(file)) this.host.onMutated()
  }

  private async removeRefFlow(who: string, file: string, exists: boolean): Promise<void> {
    const r = await this.confirmRemove(`移除参考图`, file, exists, `将解除与角色"${who}"的关联。`, true)
    if (!r) return
    removeRef(await this.host.ensureModel('story/characters.yaml'), who, file)
    if (r.deleteFile) await this.deleteFileOnDisk(file)
    this.host.onMutated()
  }

  private async removeTtsFlow(who: string, file: string, exists: boolean): Promise<void> {
    const r = await this.confirmRemove(`移除音色样本`, file, exists, `将清除角色"${who}"的 tts.sample 引用（provider/params 保留）。`, true)
    if (!r) return
    clearTtsSample(await this.host.ensureModel('story/characters.yaml'), who)
    if (r.deleteFile) await this.deleteFileOnDisk(file)
    this.host.onMutated()
  }

  private async removeLooseFlow(file: string): Promise<void> {
    const r = await this.confirmRemove(`删除文件`, file, true, '该文件未注册/未关联，将直接从磁盘删除。', false)
    if (!r) return
    if (await this.deleteFileOnDisk(file)) this.host.onMutated()
  }

  private showMenu(el: HTMLElement, x: number, y: number): void {
    const actions: Action[] = [['预览', () => this.showPreview(el)], ...this.actionsFor(el)]
    this.menuEl.innerHTML = actions.map(([label], i) => `<div class="ctx-item" data-i="${i}">${esc(label)}</div>`).join('')
    this.menuEl.classList.add('on')
    this.menuEl.style.left = `${Math.min(x, window.innerWidth - 200)}px`
    this.menuEl.style.top = `${Math.min(y, window.innerHeight - actions.length * 30 - 10)}px`
    this.menuEl.querySelectorAll<HTMLElement>('.ctx-item').forEach((item) => {
      item.addEventListener('click', () => {
        this.menuEl.classList.remove('on')
        void actions[Number(item.dataset.i)][1]()
      })
    })
  }

  private showPreview(el: HTMLElement): void {
    const d = el.dataset
    const file = d.file ?? ''
    const missing = d.missing === 'true' || !file
    const parts: string[] = [`<div class="ap-title">${esc(d.name ?? d.id ?? d.combo ?? file.split('/').pop() ?? '')}</div>`]

    if (!missing && isImage(file)) parts.push(`<img src="${encodeURI('/' + file)}" alt="">`)
    else if (!missing && isAudio(file)) parts.push(`<audio controls src="${encodeURI('/' + file)}?t=${Date.now()}"></audio>`)
    else if (missing) parts.push(`<div class="ap-missing">文件不存在${file ? `：${esc(file)}` : ''}<br>（游戏内将占位渲染）</div>`)
    if (d.kind === 'voice') parts.push(`<div class="ap-path">${esc(d.who ?? '')}：${esc(d.text ?? '')}</div>`)
    if (file) parts.push(`<div class="ap-path">${esc(file)}</div>`)

    const actions = this.actionsFor(el)
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

  // ---------- TTS 生成流程：设置内容 → 调 API → 试听 → 保存/替换 ----------

  private async ttsFlow(d: DOMStringMap): Promise<void> {
    const settings = loadTtsSettings()
    const cv = this.index?.characters.find((c) => c.name === d.who)
    const params = (cv?.tts?.params ?? {}) as Record<string, unknown>
    const previewRef: { current: { path: string; durationMs: number | null } | null } = { current: null }

    const result = await showModal({
      title: `TTS 生成：${d.id}（${d.who}）`,
      submitLabel: '保存/替换',
      backdropClose: false,
      fields: [
        { key: 'text', label: '台词文本', type: 'textarea', value: d.text ?? '', hint: '可微调读法（如插入逗号控制停顿）；存档的改稿检测以脚本原文为准' },
        { key: 'mode', label: '生成模式', type: 'select', value: String(params.mode ?? settings.mode), options: ['zero_shot', 'sft', 'instruct'] },
        { key: 'promptText', label: 'prompt 文本（zero_shot）', value: String(params.prompt_text ?? ''), hint: '音色参考音频对应的文字内容' },
        { key: 'spkId', label: '说话人 id（sft）', value: String(params.spk_id ?? '') },
        { key: 'instruct', label: '指令（instruct）', value: String(params.instruct ?? ''), placeholder: '如：用开心的语气说' },
        { key: 'speed', label: '语速', type: 'number', value: String(params.speed ?? 1.0) },
        { key: 'sample', label: '音色参考音频', value: cv?.tts?.sample ?? '', hint: cv?.tts?.sample ? (cv.tts.sampleExists ? '' : '⚠ 该文件不存在') : '未配置：在资产面板"编辑素材"里给角色设音色' },
      ],
      actions: [
        {
          label: '⚙ 接入设置',
          handler: async (_v, statusEl) => {
            await openTtsSettings()
            statusEl.textContent = '设置已更新（生成时生效）'
          },
        },
        {
          label: '▶ 生成试听',
          handler: async (v, statusEl) => {
            statusEl.innerHTML = '生成中…（首次调用模型可能较慢）'
            const s = loadTtsSettings()
            const mode = v.mode as 'zero_shot' | 'sft' | 'instruct'
            try {
              const r = (await (
                await fetch('/api/tts/generate', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json; charset=utf-8' },
                  body: JSON.stringify({
                    baseUrl: s.baseUrl,
                    mode,
                    path: pathForMode({ ...s, mode }),
                    sampleRate: s.sampleRate,
                    toOgg: s.toOgg,
                    text: v.text,
                    promptText: v.promptText,
                    spkId: v.spkId,
                    instruct: v.instruct,
                    speed: Number(v.speed) || undefined,
                    sample: v.sample || undefined,
                    previewName: d.id,
                  }),
                })
              ).json()) as { ok: boolean; preview?: string; durationMs?: number | null; error?: string }
              if (!r.ok) {
                statusEl.innerHTML = `<span class="m-err">${esc(r.error ?? '生成失败')}</span>`
                return
              }
              previewRef.current = { path: r.preview!, durationMs: r.durationMs ?? null }
              statusEl.innerHTML = `<span class="m-ok">✓ 生成成功${r.durationMs ? `（${(r.durationMs / 1000).toFixed(1)}s）` : ''}</span><br><audio controls autoplay src="/${r.preview}?t=${Date.now()}"></audio>`
            } catch (err) {
              statusEl.innerHTML = `<span class="m-err">请求失败：${String(err)}</span>`
            }
          },
        },
      ],
      validate: () => (previewRef.current ? null : '请先"生成试听"，确认效果后再保存'),
    })
    const preview = previewRef.current
    if (!result || !preview) return

    const commit = (await (
      await fetch('/api/tts/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        // text 用脚本原文（d.text）：voice.lock 的改稿检测必须对照脚本，而非微调后的读法文本
        body: JSON.stringify({ preview: preview.path, id: d.id, text: d.text, durationMs: preview.durationMs }),
      })
    ).json()) as { ok: boolean; file?: string; error?: string }
    if (commit.ok) this.host.onMutated()
    else alert(`保存失败：${commit.error}`)
  }

  // ---------- 素材导入（OS 拖入 / 浏览本机文件） ----------

  private async importFromDisk(): Promise<void> {
    const p = await pickPath({ title: '选择要导入的素材文件', mode: 'file', exts: [...IMG_EXTS, ...AUD_EXTS] })
    if (p) await this.runImport({ kind: 'local', path: p })
  }

  private async runImport(src: ImportSource, defaultCategory?: string): Promise<void> {
    const out = await importAssetFlow(src, defaultCategory)
    if (!out) return
    if (out.registerName) {
      const kindMap: Record<string, 'backgrounds' | 'bgm' | 'se'> = { bg: 'backgrounds', bgm: 'bgm', se: 'se' }
      const kind = kindMap[out.category.key]
      if (kind) registerAsset(await this.host.ensureModel('story/assets.yaml'), kind, out.registerName, out.path)
    }
    this.host.onMutated()
  }

  /** 本机文件拷入项目，返回实际写入的项目内路径（重名自动改名） */
  private async copyLocalIntoProject(src: string, to: string): Promise<string | null> {
    const r = (await (
      await fetch('/api/asset/import-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ src, to }),
      })
    ).json()) as { ok?: boolean; path?: string; error?: string }
    if (!r.ok || !r.path) {
      alert(`拷贝失败：${r.error ?? '未知错误'}`)
      return null
    }
    return r.path
  }

  /** "浏览本地文件…"动作：选中后回填 file 字段并在状态区预览；返回 pendingSrc 容器 */
  private browseAction(exts: string[], fileFieldPrefix: string, pendingSrc: { current: string | null }): ModalAction {
    return {
      label: '📂 浏览本地文件…',
      handler: async (_v, statusEl, ui) => {
        const p = await pickPath({ title: '选择素材文件', mode: 'file', exts })
        if (!p) return
        pendingSrc.current = p
        const clean = sanitizeFileName(p.split('/').pop()!)
        ui.setField('file', fileFieldPrefix + clean)
        const url = `/api/fs/file?path=${encodeURIComponent(p)}&t=${Date.now()}`
        statusEl.innerHTML = isImage(p)
          ? `<span class="m-ok">✓ 已选择，确定后拷入项目</span><br><img class="imp-preview" src="${url}" alt="">`
          : `<span class="m-ok">✓ 已选择，确定后拷入项目</span><br><audio class="imp-preview" controls src="${url}"></audio>`
      },
    }
  }

  // ---------- 新增（注册表条目） ----------

  private async openAdd(section: string): Promise<void> {
    if (section === 'bg' || section === 'bgm' || section === 'se') {
      const kindMap = { bg: 'backgrounds', bgm: 'bgm', se: 'se' } as const
      const labelMap = { bg: '背景', bgm: 'BGM', se: '音效' }
      const dirMap = { bg: 'bg/', bgm: 'bgm/', se: 'se/' }
      const pendingSrc = { current: null as string | null }
      const v = await showModal({
        title: `新增${labelMap[section]}`,
        fields: [
          { key: 'name', label: '注册名（脚本中引用）', placeholder: '如 教室_白天' },
          { key: 'file', label: '文件路径', placeholder: `${dirMap[section]}xxx.${section === 'bg' ? 'jpg' : 'ogg'}`, hint: '文件可以后补（缺失时游戏内占位渲染），或点下方"浏览本地文件"选一个拷入项目' },
        ],
        actions: [this.browseAction(section === 'bg' ? IMG_EXTS : AUD_EXTS, dirMap[section], pendingSrc)],
        validate: (v) => (!v.name ? '注册名必填' : !v.file.startsWith(dirMap[section]) ? `文件路径需以 ${dirMap[section]} 开头` : null),
      })
      if (!v) return
      let file = v.file
      if (pendingSrc.current) {
        const copied = await this.copyLocalIntoProject(pendingSrc.current, v.file)
        if (!copied) return
        file = copied
      }
      registerAsset(await this.host.ensureModel('story/assets.yaml'), kindMap[section], v.name, file)
      this.host.onMutated()
      return
    }
    if (section === 'item') {
      const pendingSrc = { current: null as string | null }
      const v = await showModal({
        title: '新增物品',
        fields: [
          { key: 'id', label: '物品 id（脚本中 item.<id> 引用、item 指令的 get/lose）', placeholder: '如 折叠伞' },
          { key: 'name', label: '显示名', placeholder: '缺省用 id' },
          { key: 'desc', label: '说明（物品栏展示）', type: 'textarea', placeholder: '如 早上塞进书包的折叠伞。' },
          { key: 'max', label: '堆叠上限（可空 = 不限）', type: 'number' },
          { key: 'file', label: '配图（item/ 下）', placeholder: 'item/umbrella.png', hint: '可后补（缺图时物品栏占位），或点下方"浏览本地文件"拷入项目' },
        ],
        actions: [this.browseAction(IMG_EXTS, 'item/', pendingSrc)],
        validate: (v) => (!v.id ? '物品 id 必填' : v.file && !v.file.startsWith('item/') ? '配图路径需以 item/ 开头' : null),
      })
      if (!v) return
      let image = v.file
      if (pendingSrc.current) {
        const copied = await this.copyLocalIntoProject(pendingSrc.current, v.file)
        if (!copied) return
        image = copied
      }
      upsertItem(await this.host.ensureModel('story/items.yaml'), {
        id: v.id, name: v.name || undefined, desc: v.desc || undefined,
        image: image || undefined, max: v.max ? Number(v.max) : undefined,
      })
      this.host.onMutated()
      return
    }
    if (section === 'sprite') {
      const NEW = '〈新建角色〉'
      const names = this.index!.characters.map((c) => c.name)
      const pendingSrc = { current: null as string | null }
      const v = await showModal({
        title: '新增立绘变体 / 角色',
        fields: [
          { key: 'who', label: '角色', type: 'select', value: names[0] ?? NEW, options: [...names, NEW] },
          { key: 'newName', label: '新角色名（选〈新建角色〉时生效）' },
          { key: 'color', label: '新角色名字颜色', placeholder: '#e8748a' },
          { key: 'voiced', label: '新角色配音', type: 'checkbox', value: true },
          { key: 'outfit', label: 'outfit 衣着', placeholder: '如 校服' },
          { key: 'state', label: 'state 状态（可空，多个用+连接）', placeholder: '如 淋湿' },
          { key: 'face', label: 'face 表情', placeholder: '如 默认' },
          { key: 'file', label: '图片路径（sprite/ 下）', placeholder: 'xiaoman/seifuku_normal.png', hint: '留空 = 只建角色不加变体；文件可后补，或"浏览本地文件"拷入（建议加角色子目录）' },
        ],
        actions: [this.browseAction(IMG_EXTS, '', pendingSrc)],
        validate: (v) => {
          const isNew = v.who === NEW
          if (isNew && !v.newName) return '请填写新角色名'
          if (v.file && (!v.outfit || !v.face)) return '加变体时 outfit 与 face 必填'
          if (!isNew && !v.file) return '已有角色请填写变体信息'
          return null
        },
      })
      if (!v) return
      const model = await this.host.ensureModel('story/characters.yaml')
      const who = v.who === NEW ? v.newName : v.who
      if (v.who === NEW) addCharacter(model, { name: who, color: v.color || undefined, voiced: v.voiced === 'true' })
      if (v.file) {
        let file = v.file.startsWith('sprite/') ? v.file : `sprite/${v.file}`
        if (pendingSrc.current) {
          const copied = await this.copyLocalIntoProject(pendingSrc.current, file)
          if (!copied) return
          file = copied
        }
        ensureSpriteDefault(model, who, v.outfit, v.face)
        registerVariant(model, who, {
          outfit: v.outfit,
          state: v.state ? v.state.split('+').map((s) => s.trim()).filter(Boolean) : [],
          face: v.face,
          file,
        })
      }
      this.host.onMutated()
    }
  }

  // ---------- 注册动作 ----------

  private async registerLoose(kind: 'backgrounds' | 'bgm' | 'se', file: string): Promise<void> {
    const v = await showModal({
      title: `注册 ${file}`,
      fields: [{ key: 'name', label: '注册名（脚本中引用的名字）', value: suggestName(file) }],
      validate: (v) => (v.name ? null : '注册名必填'),
    })
    if (!v) return
    registerAsset(await this.host.ensureModel('story/assets.yaml'), kind, v.name, file)
    this.host.onMutated()
  }

  private async registerSpriteFlow(who: string | null, file: string): Promise<void> {
    const idx = this.index!
    const names = idx.characters.map((c) => c.name)
    const v = await showModal({
      title: `注册变体：${file}`,
      fields: [
        { key: 'who', label: '角色', type: 'select', value: who ?? names[0], options: names },
        { key: 'outfit', label: 'outfit 衣着', placeholder: '如 校服' },
        { key: 'state', label: 'state 状态（可空，多个用+连接）' },
        { key: 'face', label: 'face 表情', placeholder: '如 微笑' },
      ],
      validate: (v) => (!v.outfit || !v.face ? 'outfit 与 face 必填' : null),
    })
    if (!v) return
    const model = await this.host.ensureModel('story/characters.yaml')
    ensureSpriteDefault(model, v.who, v.outfit, v.face)
    registerVariant(model, v.who, {
      outfit: v.outfit,
      state: v.state ? v.state.split('+').map((s) => s.trim()).filter(Boolean) : [],
      face: v.face,
      file,
    })
    this.host.onMutated()
  }

  private async associateRef(file: string): Promise<void> {
    const names = this.index!.characters.map((c) => c.name)
    const v = await showModal({
      title: `参考图关联：${file}`,
      fields: [{ key: 'who', label: '关联到角色', type: 'select', value: names[0], options: names }],
    })
    if (!v) return
    addRef(await this.host.ensureModel('story/characters.yaml'), v.who, file)
    this.host.onMutated()
  }

  private async associateTts(file: string): Promise<void> {
    const names = this.index!.characters.map((c) => c.name)
    const v = await showModal({
      title: `设为音色参考：${file}`,
      fields: [{ key: 'who', label: '设给角色', type: 'select', value: names[0], options: names }],
    })
    if (!v) return
    setTtsSample(await this.host.ensureModel('story/characters.yaml'), v.who, file)
    this.host.onMutated()
  }

  // ---------- 物品（配图 / 说明 / 数量） ----------

  private async editItemFlow(id: string): Promise<void> {
    const it = this.index?.items.find((i) => i.id === id)
    if (!it) return
    const v = await showModal({
      title: `编辑物品：${id}`,
      fields: [
        { key: 'name', label: '显示名', value: it.name },
        { key: 'desc', label: '说明', type: 'textarea', value: it.desc ?? '' },
        { key: 'max', label: '堆叠上限（空 = 不限）', type: 'number', value: it.max != null ? String(it.max) : '' },
      ],
    })
    if (!v) return
    const model = await this.host.ensureModel('story/items.yaml')
    setItemField(model, id, 'name', v.name || undefined)
    setItemField(model, id, 'desc', v.desc || undefined)
    setItemField(model, id, 'max', v.max ? Number(v.max) : undefined)
    this.host.onMutated()
  }

  private async setItemImageFlow(id: string): Promise<void> {
    const pendingSrc = { current: null as string | null }
    const cur = this.index?.items.find((i) => i.id === id)
    const v = await showModal({
      title: `配图：${id}`,
      fields: [{ key: 'file', label: '配图路径（item/ 下）', value: cur?.file ?? '', placeholder: 'item/umbrella.png', hint: '点"浏览本地文件"拷入项目，或手填已在 item/ 下的文件' }],
      actions: [this.browseAction(IMG_EXTS, 'item/', pendingSrc)],
      validate: (v) => (!v.file ? '请填写或选择配图' : !v.file.startsWith('item/') ? '路径需以 item/ 开头' : null),
    })
    if (!v) return
    let image = v.file
    if (pendingSrc.current) {
      const copied = await this.copyLocalIntoProject(pendingSrc.current, v.file)
      if (!copied) return
      image = copied
    }
    setItemField(await this.host.ensureModel('story/items.yaml'), id, 'image', image)
    this.host.onMutated()
  }

  private async registerLooseItem(file: string): Promise<void> {
    const NEW = '〈新建物品〉'
    const ids = this.index!.items.map((i) => i.id)
    const v = await showModal({
      title: `注册物品图：${file.replace(/^item\//, '')}`,
      fields: [
        { key: 'target', label: '用作配图', type: 'select', value: ids[0] ?? NEW, options: [...ids, NEW] },
        { key: 'newId', label: '新物品 id（选〈新建物品〉时生效）', value: suggestName(file) },
        { key: 'name', label: '显示名（新建时）' },
        { key: 'desc', label: '说明（新建时）', type: 'textarea' },
      ],
      validate: (v) => (v.target === NEW && !v.newId ? '请填写新物品 id' : null),
    })
    if (!v) return
    const model = await this.host.ensureModel('story/items.yaml')
    if (v.target === NEW) upsertItem(model, { id: v.newId, name: v.name || undefined, desc: v.desc || undefined, image: file })
    else setItemField(model, v.target, 'image', file)
    this.host.onMutated()
  }

  private async removeItemFlow(id: string, file: string, exists: boolean): Promise<void> {
    const r = await this.confirmRemove(
      `移除物品：${id}`, file, exists,
      `将从 items.yaml 移除该物品；脚本中对 item.${id} 的引用与 item 指令会变成编译错误。`,
      true,
    )
    if (!r) return
    removeItem(await this.host.ensureModel('story/items.yaml'), id)
    if (r.deleteFile) await this.deleteFileOnDisk(file)
    this.host.onMutated()
  }

  // ---------- AI 生图 / 抠图 ----------

  /** 工具栏"✨ AI 生成"：选类型 → 路由到对应流程（含新建目标） */
  private async aiGenerate(): Promise<void> {
    const t = await showModal({
      title: 'AI 生成素材',
      fields: [{ key: 'type', label: '生成类型', type: 'select', value: '背景', options: ['背景', '立绘', '角色基准图'] }],
    })
    if (!t) return
    if (t.type === '背景') {
      const v = await showModal({
        title: 'AI 生成背景',
        fields: [{ key: 'name', label: '背景注册名（脚本中引用）', placeholder: '如 教室_白天' }],
        validate: (v) => (v.name ? null : '注册名必填'),
      })
      if (v) await this.genBgInto(v.name)
    } else if (t.type === '角色基准图') {
      const names = this.index!.characters.map((c) => c.name)
      if (!names.length) {
        alert('还没有角色，请先在"立绘"分节用 ＋ 新建角色')
        return
      }
      const v = await showModal({
        title: 'AI 生成角色基准图',
        fields: [{ key: 'who', label: '角色', type: 'select', value: names[0], options: names }],
      })
      if (v) await this.genBaseRef(v.who)
    } else {
      await this.addSpriteViaGen()
    }
  }

  private parseCombo(combo: string): { outfit: string; state: string[]; face: string } {
    const [outfit, stateStr, face] = combo.split('|')
    return { outfit, state: stateStr ? stateStr.split('+').filter(Boolean) : [], face }
  }

  private async genBgInto(name: string): Promise<void> {
    const preview = await generateImageFlow({
      flow: 'bg', title: `AI 生成背景：${name}`, seed: name, name: `bg_${sanitizeFileName(name)}`, matteDefault: false,
    })
    if (!preview) return
    const path = await commitImage(preview, `bg/${sanitizeFileName(name)}.png`)
    if (!path) return
    registerAsset(await this.host.ensureModel('story/assets.yaml'), 'backgrounds', name, path)
    this.host.onMutated()
  }

  private async genBaseRef(who: string): Promise<void> {
    const preview = await generateImageFlow({
      flow: 'base', title: `AI 生成基准图：${who}`, seed: who, name: `ref_${sanitizeFileName(who)}`, matteDefault: false,
    })
    if (!preview) return
    const dir = sanitizeFileName(who)
    const path = await commitImage(preview, `production/refs/${dir}/${dir}_ref.png`)
    if (!path) return
    addRef(await this.host.ensureModel('story/characters.yaml'), who, path)
    this.host.onMutated()
  }

  private async genSpriteForCombo(who: string, combo: string): Promise<void> {
    const { outfit, state, face } = this.parseCombo(combo)
    await this.genSpriteVariant({ who, outfit, state, face, oldCombo: combo })
  }

  /** "✨ AI 生成 → 立绘"：可新建角色 + 维度，然后生成 */
  private async addSpriteViaGen(): Promise<void> {
    const NEW = '〈新建角色〉'
    const names = this.index!.characters.map((c) => c.name)
    const v = await showModal({
      title: 'AI 生成立绘（新变体）',
      fields: [
        { key: 'who', label: '角色', type: 'select', value: names[0] ?? NEW, options: [...names, NEW] },
        { key: 'newName', label: '新角色名（选〈新建角色〉时生效）' },
        { key: 'color', label: '新角色名字颜色', placeholder: '#e8748a' },
        { key: 'voiced', label: '新角色配音', type: 'checkbox', value: true },
        { key: 'outfit', label: 'outfit 衣着', placeholder: '如 校服' },
        { key: 'state', label: 'state 状态（可空，多个用+连接）', placeholder: '如 淋湿' },
        { key: 'face', label: 'face 表情', placeholder: '如 默认' },
      ],
      validate: (v) => {
        if (v.who === NEW && !v.newName) return '请填写新角色名'
        if (!v.outfit || !v.face) return 'outfit 与 face 必填'
        return null
      },
    })
    if (!v) return
    const who = v.who === NEW ? v.newName : v.who
    await this.genSpriteVariant({
      who,
      outfit: v.outfit,
      state: v.state ? v.state.split('+').map((s) => s.trim()).filter(Boolean) : [],
      face: v.face,
      newChar: v.who === NEW ? { color: v.color || undefined, voiced: v.voiced === 'true' } : undefined,
    })
  }

  /** 生成立绘 → 落盘到 sprite/<角色目录> → 注册变体（oldCombo 存在则替换） */
  private async genSpriteVariant(p: {
    who: string
    outfit: string
    state: string[]
    face: string
    oldCombo?: string
    newChar?: { color?: string; voiced: boolean }
  }): Promise<void> {
    const cv = this.index?.characters.find((c) => c.name === p.who)
    const ref = cv?.refs.find((r) => r.exists)?.path
    const stateLabel = p.state.join('+') || '无状态'
    const stem = sanitizeFileName(`${p.who}_${p.outfit}_${p.state.join('-') || 'base'}_${p.face}`)
    const preview = await generateImageFlow({
      flow: 'sprite',
      title: `AI 生成立绘：${p.who}`,
      seed: `${p.who}，服装「${p.outfit}」，状态「${stateLabel}」，表情「${p.face}」`,
      ref,
      name: `sprite_${stem}`,
      matteDefault: true,
    })
    if (!preview) return
    const dir = cv?.spriteDir ?? sanitizeFileName(p.who)
    const path = await commitImage(preview, `sprite/${dir}/${stem}.png`)
    if (!path) return
    const model = await this.host.ensureModel('story/characters.yaml')
    if (p.newChar) addCharacter(model, { name: p.who, color: p.newChar.color, voiced: p.newChar.voiced })
    if (p.oldCombo) removeVariant(model, p.who, p.oldCombo)
    ensureSpriteDefault(model, p.who, p.outfit, p.face)
    registerVariant(model, p.who, { outfit: p.outfit, state: p.state, face: p.face, file: path })
    this.host.onMutated()
  }

  /** 抠图：对已有图片去背景；变体图就地替换，散图另存为透明 PNG（保持未注册） */
  private async matteInto(d: DOMStringMap): Promise<void> {
    const file = d.file!
    const base = sanitizeFileName(file.split('/').pop()!.replace(/\.[^.]+$/, ''))
    const preview = await matteFlow(file, base)
    if (!preview) return
    if (d.kind === 'variant') {
      const cv = this.index?.characters.find((c) => c.name === d.who)
      const dir = cv?.spriteDir ?? sanitizeFileName(d.who!)
      const path = await commitImage(preview, `sprite/${dir}/${base}_cut.png`)
      if (!path) return
      const model = await this.host.ensureModel('story/characters.yaml')
      const { outfit, state, face } = this.parseCombo(d.combo!)
      removeVariant(model, d.who!, d.combo!)
      ensureSpriteDefault(model, d.who!, outfit, face)
      registerVariant(model, d.who!, { outfit, state, face, file: path })
      this.host.onMutated()
    } else {
      const dirPrefix = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : 'sprite'
      const path = await commitImage(preview, `${dirPrefix}/${base}_cut.png`)
      if (path) this.host.onMutated()
    }
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
