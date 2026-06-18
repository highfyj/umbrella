import {
  PRNG,
  comboKey,
  evalExpr,
  type EvalEnv,
  type Op,
  type ShakeIntensity,
  type StoryIR,
  type Target,
  type TextStyle,
  type Value,
  type VoiceRef,
} from '@vn/core'

export interface CharStage {
  shown: boolean
  at: 'left' | 'center' | 'right'
  outfit: string
  state: string[]
  face: string
}

export interface Stage {
  bg: string | null
  bgmName: string | null
  chars: Record<string, CharStage>
}

/** 立绘解析结果：file=null 表示占位渲染 */
export interface SpriteResolution {
  combo: string
  file: string | null
}

export type Effect =
  | { kind: 'bg'; name: string; file: string | null; transition?: string; duration?: number }
  | { kind: 'show'; who: string; at: string; sprite: SpriteResolution; transition?: string }
  | { kind: 'face'; who: string; sprite: SpriteResolution }
  | { kind: 'hide'; who: string; transition?: string }
  | { kind: 'bgm'; name: string | null; file: string | null; fade?: number }
  | { kind: 'se'; name: string; file: string | null }
  | { kind: 'wait'; ms: number }
  | { kind: 'shake'; intensity: ShakeIntensity; ms: number }

export type VMEvent =
  | { type: 'line'; lineKind: 'say' | 'narrate'; who: string | null; text: string; lineId: string; voice: VoiceRef | null; effects: Effect[] }
  | { type: 'text'; style: TextStyle; title: string | null; content: string; lineId: string; effects: Effect[] }
  | { type: 'choice'; options: Array<{ index: number; text: string }>; effects: Effect[] }
  | { type: 'end'; ending: string; effects: Effect[] }

export interface SaveData {
  scene: string
  pc: number
  vars: Record<string, Value>
  globals: Record<string, Value>
  /** 物品库存：id -> 数量；旧存档缺此字段时降级为空库存 */
  items?: Record<string, number>
  prng: number
  stage: Stage
  /** 最近一条行 ID，脚本更新后读档的回退锚点 */
  anchor: string | null
}

export class VMError extends Error {}

export class VM {
  private scene: string
  private pc = 0
  private vars: Record<string, Value>
  private globals: Record<string, Value>
  private items: Record<string, number> = {}
  private prng: PRNG
  private stage: Stage
  private anchor: string | null = null
  private pendingChoice: number | null = null
  private ended = false

  constructor(
    private ir: StoryIR,
    opts?: { seed?: number; globals?: Record<string, Value> },
  ) {
    this.scene = ir.entry
    this.vars = { ...ir.vars }
    this.globals = { ...(opts?.globals ?? {}) }
    this.prng = new PRNG(opts?.seed ?? (Math.floor(Math.random() * 0xffffffff) | 0))
    this.stage = { bg: null, bgmName: null, chars: {} }
  }

  get isEnded(): boolean {
    return this.ended
  }

  /** 推进到下一个阻塞事件（台词/选择/结局），途中收集演出 effects */
  next(): VMEvent {
    if (this.ended) throw new VMError('剧情已结束')
    if (this.pendingChoice !== null) throw new VMError('等待 choose() 选择中')

    const effects: Effect[] = []
    let guard = 0
    for (;;) {
      if (guard++ > 100000) throw new VMError('疑似死循环（10 万步无阻塞事件）')
      const ops = this.ir.scenes[this.scene]?.ops
      if (!ops) throw new VMError(`场景 "${this.scene}" 不存在`)
      if (this.pc >= ops.length) throw new VMError(`场景 "${this.scene}" 执行到末尾而没有 jump/end`)
      const op = ops[this.pc]

      switch (op.op) {
        case 'narrate': {
          this.pc++
          this.anchor = op.lineId
          return { type: 'line', lineKind: 'narrate', who: null, text: op.text, lineId: op.lineId, voice: null, effects }
        }
        case 'say': {
          this.pc++
          this.anchor = op.lineId
          if (op.face !== null) {
            const st = this.charStage(op.who)
            if (st && st.face !== op.face) {
              st.face = op.face
              if (st.shown) effects.push({ kind: 'face', who: op.who, sprite: this.resolveSprite(op.who) })
            }
          }
          return { type: 'line', lineKind: 'say', who: op.who, text: op.text, lineId: op.lineId, voice: op.voice, effects }
        }
        case 'text': {
          this.pc++
          this.anchor = op.lineId
          return { type: 'text', style: op.style, title: op.title, content: op.content, lineId: op.lineId, effects }
        }
        case 'bg': {
          this.stage.bg = op.name
          const a = this.ir.assets.backgrounds[op.name]
          effects.push({ kind: 'bg', name: op.name, file: a && !a.missing ? a.file : null, transition: op.transition, duration: op.duration })
          this.pc++
          break
        }
        case 'show': {
          const st = this.charStage(op.who)
          if (!st) {
            this.pc++
            break
          }
          if (op.patch.outfit !== undefined) st.outfit = op.patch.outfit
          if (op.patch.state !== undefined) st.state = [...op.patch.state]
          if (op.patch.face !== undefined) st.face = op.patch.face
          if (op.patch.at !== undefined) st.at = op.patch.at
          st.shown = true
          effects.push({ kind: 'show', who: op.who, at: st.at, sprite: this.resolveSprite(op.who), transition: op.transition })
          this.pc++
          break
        }
        case 'hide': {
          const st = this.charStage(op.who)
          if (st) st.shown = false
          effects.push({ kind: 'hide', who: op.who, transition: op.transition })
          this.pc++
          break
        }
        case 'bgm': {
          this.stage.bgmName = op.name
          const a = op.name !== null ? this.ir.assets.bgm[op.name] : null
          effects.push({ kind: 'bgm', name: op.name, file: a && !a.missing ? a.file : null, fade: op.fade })
          this.pc++
          break
        }
        case 'se': {
          const a = this.ir.assets.se[op.name]
          effects.push({ kind: 'se', name: op.name, file: a && !a.missing ? a.file : null })
          this.pc++
          break
        }
        case 'wait': {
          effects.push({ kind: 'wait', ms: op.ms })
          this.pc++
          break
        }
        case 'shake': {
          effects.push({ kind: 'shake', intensity: op.intensity, ms: op.ms })
          this.pc++
          break
        }
        case 'set': {
          this.applyAssigns(op.assigns)
          this.pc++
          break
        }
        case 'item': {
          this.setItem(op.id, (this.items[op.id] ?? 0) + op.delta)
          this.pc++
          break
        }
        case 'money': {
          const cur = typeof this.vars.money === 'number' ? this.vars.money : 0
          this.vars.money = Math.max(0, cur + op.delta)
          this.pc++
          break
        }
        case 'goto':
          this.pc = op.to
          break
        case 'jump':
          this.scene = op.scene
          this.pc = op.to
          break
        case 'jumpIfNot': {
          const v = evalExpr(op.expr, this.env())
          if (typeof v !== 'boolean') throw new VMError('if 条件求值结果不是布尔值')
          this.pc = v ? this.pc + 1 : op.to
          break
        }
        case 'random': {
          const weights = op.branches.map((b) => {
            const w = evalExpr(b.weight, this.env())
            if (typeof w !== 'number') throw new VMError('random 权重求值结果不是数字')
            return Math.max(0, w)
          })
          const total = weights.reduce((a, b) => a + b, 0)
          let target = op.branches[0].to
          if (total > 0) {
            let roll = this.prng.next() * total
            for (let i = 0; i < weights.length; i++) {
              roll -= weights[i]
              if (roll < 0) {
                target = op.branches[i].to
                break
              }
            }
          }
          this.pc = target
          break
        }
        case 'choice': {
          const visible = op.options
            .map((o, i) => ({ o, i }))
            .filter(({ o }) => o.if === undefined || evalExpr(o.if, this.env()) === true)
          if (!visible.length) throw new VMError('所有选项都被条件隐藏（软锁）')
          this.pendingChoice = this.pc
          return { type: 'choice', options: visible.map(({ o, i }) => ({ index: i, text: o.text })), effects }
        }
        case 'end': {
          this.ended = true
          this.globals[`cleared_${op.ending}`] = true
          return { type: 'end', ending: op.ending, effects }
        }
      }
    }
  }

  /** 对 choice 事件做出选择；index 是事件中给出的原始选项下标 */
  choose(index: number): void {
    if (this.pendingChoice === null) throw new VMError('当前没有等待中的选择')
    const op = this.ir.scenes[this.scene].ops[this.pendingChoice] as Extract<Op, { op: 'choice' }>
    const o = op.options[index]
    if (!o) throw new VMError(`选项下标 ${index} 不存在`)
    if (o.if !== undefined && evalExpr(o.if, this.env()) !== true) throw new VMError('该选项当前不可见')
    if (o.set) this.applyAssigns(o.set)
    const t: Target | null = o.target
    if (t === null) {
      this.pc = this.pendingChoice + 1
    } else {
      if (t.scene) this.scene = t.scene
      this.pc = t.to
    }
    this.pendingChoice = null
  }

  /** 当前物品库存（副本，供物品栏 UI 读取） */
  get inventory(): Record<string, number> {
    return { ...this.items }
  }

  /** 当前货币金额（无货币系统时为 0） */
  get money(): number {
    return typeof this.vars.money === 'number' ? this.vars.money : 0
  }

  save(): SaveData {
    return structuredClone({
      scene: this.scene,
      pc: this.pendingChoice ?? this.pc,
      vars: this.vars,
      globals: this.globals,
      items: this.items,
      prng: this.prng.state,
      stage: this.stage,
      anchor: this.anchor,
    })
  }

  static load(ir: StoryIR, data: SaveData): VM {
    const vm = new VM(ir, { seed: data.prng })
    vm.scene = data.scene
    vm.pc = data.pc
    vm.vars = structuredClone(data.vars)
    vm.globals = structuredClone(data.globals)
    vm.items = structuredClone(data.items ?? {})
    vm.prng.state = data.prng
    vm.stage = structuredClone(data.stage)
    vm.anchor = data.anchor
    return vm
  }

  private env(): EvalEnv {
    return {
      getVar: (n) => {
        const v = this.vars[n]
        if (v === undefined) throw new VMError(`变量 "${n}" 不存在`)
        return v
      },
      getGlobal: (n) => this.globals[n] ?? false,
      getItem: (id) => this.items[id] ?? 0,
      rand: () => this.prng.next(),
    }
  }

  private setItem(id: string, value: Value): void {
    if (typeof value !== 'number') throw new VMError(`物品 "${id}" 的数量必须是数字`)
    const n = Math.max(0, Math.floor(value))
    if (n === 0) delete this.items[id]
    else this.items[id] = n
  }

  private applyAssigns(assigns: ReadonlyArray<readonly [string, Parameters<typeof evalExpr>[0]]>): void {
    for (const [name, expr] of assigns) {
      const v = evalExpr(expr, this.env())
      if (name.startsWith('global.')) this.globals[name.slice('global.'.length)] = v
      else if (name.startsWith('item.')) this.setItem(name.slice('item.'.length), v)
      else this.vars[name] = v
    }
  }

  private charStage(who: string): CharStage | null {
    const def = this.ir.characters[who]
    if (!def) return null
    let st = this.stage.chars[who]
    if (!st) {
      st = {
        shown: false,
        at: 'center',
        outfit: def.sprite?.default.outfit ?? '',
        state: [],
        face: def.sprite?.default.face ?? '',
      }
      this.stage.chars[who] = st
    }
    return st
  }

  private resolveSprite(who: string): SpriteResolution {
    const st = this.stage.chars[who]
    const sprite = this.ir.characters[who]?.sprite
    const combo = comboKey(st?.outfit ?? '', st?.state ?? [], st?.face ?? '')
    if (!sprite) return { combo, file: null }
    return { combo, file: sprite.variants[combo] ?? null }
  }
}
