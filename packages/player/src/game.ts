import './style.css'
import { comboKey, type StoryIR } from '@vn/core'
import { VM, type Effect, type SaveData, type VMEvent } from '@vn/runtime'
import { AudioChannels } from './audio.js'
import { applyBgImage, applyBgPlaceholder, spriteContent } from './placeholder.js'

const SAVE_KEY = 'vn-quicksave'
const TYPE_MS = 38 // 打字机：每字毫秒

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** 全屏 VN 播放器：挂到任意容器元素上；编辑器预览复用同一实现 */
export class Game {
  private vm: VM
  private audio = new AudioChannels()
  private busy = false
  private typing: { timer: number; full: string } | null = null
  private inChoice = false
  private ended = false
  private disposed = false
  private placeholders = new Map<string, string>()
  private keyHandler: (e: KeyboardEvent) => void

  private bgEl!: HTMLElement
  private charsEl!: HTMLElement
  private speakerEl!: HTMLElement
  private textEl!: HTMLElement
  private advEl!: HTMLElement
  private choicesEl!: HTMLElement
  private hudEl!: HTMLElement
  private endcardEl!: HTMLElement

  constructor(
    private mount: HTMLElement,
    private ir: StoryIR,
    private warningCount: number,
  ) {
    this.vm = new VM(ir)
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key !== ' ' && e.key !== 'Enter') return
      // 编辑器宿主里打字时不抢按键
      const t = e.target as HTMLElement | null
      if (t?.closest?.('.monaco-editor, input, textarea, select, [contenteditable]')) return
      e.preventDefault()
      void this.advance()
    }
    this.buildDom()
  }

  start(): void {
    void this.advance()
  }

  dispose(): void {
    this.disposed = true
    if (this.typing) clearInterval(this.typing.timer)
    window.removeEventListener('keydown', this.keyHandler)
    this.audio.dispose()
    this.mount.replaceChildren()
  }

  // ---------- DOM ----------

  private buildDom(): void {
    this.mount.innerHTML = `
      <div class="vn-stage">
        <div class="vn-bg"></div>
        <div class="vn-chars"></div>
        <div class="vn-choices"></div>
        <div class="vn-dialogue">
          <div class="vn-speaker"></div>
          <div class="vn-text"></div>
          <div class="vn-adv">▼ 点击继续</div>
        </div>
        <div class="vn-menu">
          <button data-act="save">存档</button>
          <button data-act="load">读档</button>
          <button data-act="restart">重来</button>
          <button data-act="mute"></button>
          <button data-act="hud">HUD</button>
        </div>
        <div class="vn-hud"></div>
        <div class="vn-endcard"></div>
      </div>`
    const q = (sel: string): HTMLElement => this.mount.querySelector(sel)!
    this.bgEl = q('.vn-bg')
    this.charsEl = q('.vn-chars')
    this.speakerEl = q('.vn-speaker')
    this.textEl = q('.vn-text')
    this.advEl = q('.vn-adv')
    this.choicesEl = q('.vn-choices')
    this.hudEl = q('.vn-hud')
    this.endcardEl = q('.vn-endcard')

    q('.vn-stage').addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.vn-menu, .vn-choices, .vn-endcard, .vn-hud')) return
      void this.advance()
    })
    window.addEventListener('keydown', this.keyHandler)
    q('[data-act="save"]').addEventListener('click', () => this.quickSave())
    q('[data-act="load"]').addEventListener('click', () => this.quickLoad())
    q('[data-act="restart"]').addEventListener('click', () => this.restart())
    const muteBtn = q('[data-act="mute"]')
    const renderMute = (): void => {
      muteBtn.textContent = this.audio.muted ? '🔇 已静音' : '🔊 声音'
      muteBtn.classList.toggle('vn-muted', this.audio.muted)
    }
    renderMute()
    muteBtn.addEventListener('click', () => {
      this.audio.setMuted(!this.audio.muted)
      renderMute()
    })
    q('[data-act="hud"]').addEventListener('click', () => this.hudEl.classList.toggle('on'))
    if (this.warningCount > 0) this.hudEl.classList.add('on')
  }

  // ---------- 推进 ----------

  private async advance(): Promise<void> {
    if (this.busy || this.inChoice || this.ended || this.disposed) return
    if (this.typing) {
      clearInterval(this.typing.timer)
      this.textEl.textContent = this.typing.full
      this.typing = null
      this.advEl.classList.add('on')
      return
    }
    this.busy = true
    this.advEl.classList.remove('on')
    this.audio.stopVoice() // 推进打断语音（玩家设置项，v1 固定为打断）
    try {
      const event = this.vm.next()
      await this.applyEffects(event.effects)
      if (this.disposed) return
      if (event.type === 'line') this.showLine(event)
      else if (event.type === 'choice') this.showChoice(event)
      else this.showEnd(event)
    } catch (err) {
      this.showError(String(err))
    } finally {
      this.busy = false
    }
  }

  private async applyEffects(effects: Effect[]): Promise<void> {
    for (const f of effects) {
      switch (f.kind) {
        case 'bg':
          if (f.file) {
            applyBgImage(this.bgEl, f.file)
            this.placeholders.delete('bg')
          } else {
            applyBgPlaceholder(this.bgEl, f.name)
            this.placeholders.set('bg', `背景 ${f.name}`)
          }
          break
        case 'show':
        case 'face': {
          const at = f.kind === 'show' ? f.at : (this.charEl(f.who)?.dataset.at ?? 'center')
          const el = this.upsertChar(f.who, at)
          el.replaceChildren(spriteContent(f.who, f.sprite.combo, f.sprite.file, this.ir.characters[f.who]?.color))
          if (f.sprite.file) this.placeholders.delete(`char:${f.who}`)
          else this.placeholders.set(`char:${f.who}`, `立绘 ${f.who} [${f.sprite.combo.replaceAll('|', ' / ')}]`)
          break
        }
        case 'hide':
          this.charEl(f.who)?.remove()
          this.placeholders.delete(`char:${f.who}`)
          break
        case 'bgm':
          this.audio.playBgm(f.file, f.fade ?? 0)
          if (f.name !== null && !f.file) this.placeholders.set('bgm', `BGM ${f.name}`)
          else this.placeholders.delete('bgm')
          break
        case 'se':
          this.audio.playSe(f.file)
          break
        case 'wait':
          await sleep(f.ms)
          break
      }
    }
    this.renderHud()
  }

  private charEl(who: string): HTMLElement | null {
    return this.charsEl.querySelector(`[data-who="${CSS.escape(who)}"]`)
  }

  private upsertChar(who: string, at: string): HTMLElement {
    let el = this.charEl(who)
    if (!el) {
      el = document.createElement('div')
      el.className = 'char'
      el.dataset.who = who
      this.charsEl.appendChild(el)
    }
    el.dataset.at = at
    return el
  }

  // ---------- 事件呈现 ----------

  private showLine(e: Extract<VMEvent, { type: 'line' }>): void {
    if (e.lineKind === 'say' && e.who) {
      this.speakerEl.textContent = e.who
      this.speakerEl.style.color = this.ir.characters[e.who]?.color ?? '#fff'
    } else {
      this.speakerEl.textContent = ''
    }

    if (e.voice !== null) {
      if (e.voice.missing) {
        this.placeholders.set('voice', `语音 ${e.voice.id}（静音占位）`)
        const badge = document.createElement('span')
        badge.className = 'voice-badge'
        badge.textContent = '♪ 待录'
        this.speakerEl.appendChild(badge)
      } else {
        this.placeholders.delete('voice')
        this.audio.playVoice(e.voice.file)
      }
      // 配音台词：文字即时全显
      this.textEl.textContent = e.text
      this.advEl.classList.add('on')
    } else {
      this.placeholders.delete('voice')
      // 旁白/无语音：打字机
      this.typewrite(e.text)
    }
    this.renderHud()
  }

  private typewrite(text: string): void {
    this.textEl.textContent = ''
    let i = 0
    const timer = window.setInterval(() => {
      i++
      this.textEl.textContent = text.slice(0, i)
      if (i >= text.length) {
        clearInterval(timer)
        this.typing = null
        this.advEl.classList.add('on')
      }
    }, TYPE_MS)
    this.typing = { timer, full: text }
  }

  private showChoice(e: Extract<VMEvent, { type: 'choice' }>): void {
    this.inChoice = true
    this.choicesEl.replaceChildren(
      ...e.options.map((o) => {
        const btn = document.createElement('button')
        btn.className = 'choice-btn'
        btn.textContent = o.text
        btn.addEventListener('click', () => {
          this.inChoice = false
          this.choicesEl.classList.remove('on')
          this.vm.choose(o.index)
          void this.advance()
        })
        return btn
      }),
    )
    this.choicesEl.classList.add('on')
  }

  private showEnd(e: Extract<VMEvent, { type: 'end' }>): void {
    this.ended = true
    this.audio.stopBgm()
    const title = this.ir.endings[e.ending]?.title ?? e.ending
    this.endcardEl.innerHTML = `
      <div class="ending-id">— ${escapeHtml(e.ending)} —</div>
      <h1>${escapeHtml(title)}</h1>
      <button data-act="again">重新开始</button>`
    this.endcardEl.classList.add('on')
    this.endcardEl.querySelector('[data-act="again"]')!.addEventListener('click', () => this.restart())
  }

  private showError(msg: string): void {
    this.mount.innerHTML = `<div class="error-page"><h2>运行时错误</h2>${escapeHtml(msg)}</div>`
  }

  // ---------- 存档 / 读档 / 重开 ----------

  private quickSave(): void {
    if (this.ended) return
    localStorage.setItem(SAVE_KEY, JSON.stringify(this.vm.save()))
    this.toastHud('已存档')
  }

  private quickLoad(): void {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) {
      this.toastHud('没有存档')
      return
    }
    const data = JSON.parse(raw) as SaveData
    this.vm = VM.load(this.ir, data)
    this.resetTransient()
    this.rebuildStage(data)
    void this.advance()
  }

  restart(): void {
    this.vm = new VM(this.ir)
    this.resetTransient()
    this.bgEl.style.backgroundImage = 'none'
    this.bgEl.style.backgroundColor = '#111'
    delete this.bgEl.dataset.placeholder
    this.charsEl.replaceChildren()
    this.audio.stopBgm()
    this.placeholders.clear()
    void this.advance()
  }

  private resetTransient(): void {
    if (this.typing) clearInterval(this.typing.timer)
    this.typing = null
    this.inChoice = false
    this.ended = false
    this.busy = false
    this.choicesEl.classList.remove('on')
    this.endcardEl.classList.remove('on')
    this.speakerEl.textContent = ''
    this.textEl.textContent = ''
    this.audio.stopVoice()
  }

  /** 读档后按存档里的舞台状态重建画面 */
  private rebuildStage(data: SaveData): void {
    this.placeholders.clear()
    const st = data.stage
    if (st.bg) {
      const a = this.ir.assets.backgrounds[st.bg]
      if (a && !a.missing) applyBgImage(this.bgEl, a.file)
      else {
        applyBgPlaceholder(this.bgEl, st.bg)
        this.placeholders.set('bg', `背景 ${st.bg}`)
      }
    }
    this.charsEl.replaceChildren()
    for (const [who, cs] of Object.entries(st.chars)) {
      if (!cs.shown) continue
      const combo = comboKey(cs.outfit, cs.state, cs.face)
      const file = this.ir.characters[who]?.sprite?.variants[combo] ?? null
      const el = this.upsertChar(who, cs.at)
      el.replaceChildren(spriteContent(who, combo, file, this.ir.characters[who]?.color))
      if (!file) this.placeholders.set(`char:${who}`, `立绘 ${who} [${combo.replaceAll('|', ' / ')}]`)
    }
    if (st.bgmName) {
      const a = this.ir.assets.bgm[st.bgmName]
      this.audio.playBgm(a && !a.missing ? a.file : null)
      if (!a || a.missing) this.placeholders.set('bgm', `BGM ${st.bgmName}`)
    } else {
      this.audio.stopBgm()
    }
    this.renderHud()
  }

  // ---------- HUD ----------

  private renderHud(): void {
    const items = [...this.placeholders.values()]
    const head = `<div class="hud-title">缺失资产占位中（${items.length}）｜编译警告 ${this.warningCount}</div>`
    this.hudEl.innerHTML = head + items.map((s) => `<div>· ${escapeHtml(s)}</div>`).join('')
  }

  private toastHud(msg: string): void {
    this.hudEl.classList.add('on')
    this.hudEl.innerHTML = `<div class="hud-title">${escapeHtml(msg)}</div>` + this.hudEl.innerHTML
    setTimeout(() => this.renderHud(), 1200)
  }
}
