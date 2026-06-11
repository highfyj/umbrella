import './style.css'
import { comboKey, type StoryIR } from '@vn/core'
import { VM, type Effect, type SaveData, type VMEvent } from '@vn/runtime'
import { AudioChannels } from './audio.js'
import { applyBgImage, applyBgPlaceholder, spriteContent } from './placeholder.js'

interface DiagItem {
  severity: string
  code: string
  message: string
  file: string
  pos: { line: number; col: number } | null
}

interface Payload {
  ir: StoryIR | null
  diagnostics: DiagItem[]
}

const SAVE_KEY = 'vn-quicksave'
const TYPE_MS = 38 // 打字机：每字毫秒

const app = document.getElementById('app')!

class Game {
  private vm: VM
  private audio = new AudioChannels()
  private busy = false
  private typing: { timer: number; full: string } | null = null
  private inChoice = false
  private ended = false
  private placeholders = new Map<string, string>()

  private bgEl!: HTMLElement
  private charsEl!: HTMLElement
  private speakerEl!: HTMLElement
  private textEl!: HTMLElement
  private advEl!: HTMLElement
  private choicesEl!: HTMLElement
  private hudEl!: HTMLElement
  private endcardEl!: HTMLElement

  constructor(
    private ir: StoryIR,
    private warningCount: number,
  ) {
    this.vm = new VM(ir)
    this.buildDom()
  }

  start(): void {
    void this.advance()
  }

  // ---------- DOM ----------

  private buildDom(): void {
    app.innerHTML = `
      <div id="stage">
        <div id="bg"></div>
        <div id="chars"></div>
        <div id="choices"></div>
        <div id="dialogue">
          <div id="speaker"></div>
          <div id="text"></div>
          <div id="adv">▼ 点击继续</div>
        </div>
        <div id="menu">
          <button id="btn-save">存档</button>
          <button id="btn-load">读档</button>
          <button id="btn-restart">重来</button>
          <button id="btn-hud">HUD</button>
        </div>
        <div id="hud"></div>
        <div id="endcard"></div>
      </div>`
    this.bgEl = document.getElementById('bg')!
    this.charsEl = document.getElementById('chars')!
    this.speakerEl = document.getElementById('speaker')!
    this.textEl = document.getElementById('text')!
    this.advEl = document.getElementById('adv')!
    this.choicesEl = document.getElementById('choices')!
    this.hudEl = document.getElementById('hud')!
    this.endcardEl = document.getElementById('endcard')!

    const stage = document.getElementById('stage')!
    stage.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('#menu, #choices, #endcard, #hud')) return
      void this.advance()
    })
    window.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        void this.advance()
      }
    })
    document.getElementById('btn-save')!.addEventListener('click', () => this.quickSave())
    document.getElementById('btn-load')!.addEventListener('click', () => this.quickLoad())
    document.getElementById('btn-restart')!.addEventListener('click', () => this.restart())
    document.getElementById('btn-hud')!.addEventListener('click', () => this.hudEl.classList.toggle('on'))
    if (this.warningCount > 0) this.hudEl.classList.add('on')
  }

  // ---------- 推进 ----------

  private async advance(): Promise<void> {
    if (this.busy || this.inChoice || this.ended) return
    // 打字机进行中：先一键全显
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

    const voiced = e.voice !== null
    if (voiced && e.voice) {
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
      <div class="ending-id">— ${e.ending} —</div>
      <h1>${escapeHtml(title)}</h1>
      <button id="btn-again">重新开始</button>`
    this.endcardEl.classList.add('on')
    document.getElementById('btn-again')!.addEventListener('click', () => this.restart())
  }

  private showError(msg: string): void {
    app.innerHTML = `<div class="error-page"><h2>运行时错误</h2>${escapeHtml(msg)}</div>`
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

  private restart(): void {
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

async function boot(): Promise<void> {
  let payload: Payload
  try {
    payload = (await (await fetch('/story.ir.json')).json()) as Payload
  } catch (err) {
    app.innerHTML = `<div class="error-page"><h2>无法加载剧本</h2>${escapeHtml(String(err))}</div>`
    return
  }
  const errors = payload.diagnostics.filter((d) => d.severity === 'error')
  if (!payload.ir || errors.length) {
    const list = errors
      .map((d) => `${d.file}${d.pos ? `:${d.pos.line}:${d.pos.col}` : ''}  [${d.code}] ${d.message}`)
      .join('\n')
    app.innerHTML = `<div class="error-page"><h2>剧本编译错误（${errors.length}）</h2>${escapeHtml(list)}</div>`
    return
  }
  const warnings = payload.diagnostics.filter((d) => d.severity === 'warning').length
  new Game(payload.ir, warnings).start()
}

void boot()
