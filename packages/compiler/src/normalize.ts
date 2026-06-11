import type { Assign, ExprAST, StatePatch } from '@vn/core'
import type { Diagnostics, Pos } from './diagnostics.js'
import { ParsedFile, isMap, isScalar, isSeq, nodePos } from './project.js'
import { INSTRUCTION_KEYS, Registry } from './registry.js'
import { ExprError, parseExpr, parseSetValue } from './exprParser.js'

export type Step =
  | { kind: 'narrate'; text: string; pos: Pos | null }
  | { kind: 'say'; who: string; text: string; face: string | null; id: string | null; voiceOff: boolean; reuse: boolean; pos: Pos | null }
  | { kind: 'bg'; name: string; transition?: string; duration?: number; pos: Pos | null }
  | { kind: 'show'; who: string; patch: StatePatch; transition?: string; pos: Pos | null }
  | { kind: 'hide'; who: string; transition?: string; pos: Pos | null }
  | { kind: 'bgm'; name: string | null; fade?: number; pos: Pos | null }
  | { kind: 'se'; name: string; pos: Pos | null }
  | { kind: 'wait'; ms: number; pos: Pos | null }
  | { kind: 'set'; assigns: Assign[]; pos: Pos | null }
  | { kind: 'if'; expr: ExprAST; exprSrc: string; then: Step[]; else: Step[]; pos: Pos | null }
  | { kind: 'random'; branches: RandomBranch[]; pos: Pos | null }
  | { kind: 'choice'; options: ChoiceOption[]; pos: Pos | null }
  | { kind: 'label'; name: string; pos: Pos | null }
  | { kind: 'jump'; target: string; pos: Pos | null }
  | { kind: 'end'; ending: string; pos: Pos | null }

export interface RandomBranch {
  weight: ExprAST
  weightSrc: string
  steps: Step[] | null
  goto: string | null
  pos: Pos | null
}

export interface ChoiceOption {
  text: string
  if?: ExprAST
  ifSrc?: string
  set?: Assign[]
  goto: string | null
  pos: Pos | null
}

export interface NormalizedScene {
  id: string
  title: string | null
  steps: Step[]
  file: ParsedFile
}

interface Ctx {
  file: ParsedFile
  reg: Registry
  diag: Diagnostics
}

const YAML11_BOOLS = /^(yes|no|on|off)$/i

export function normalizeScene(file: ParsedFile, expectedId: string, reg: Registry, diag: Diagnostics): NormalizedScene | null {
  const ctx: Ctx = { file, reg, diag }
  const root = file.doc.contents
  if (!isMap(root)) {
    diag.error('bad-scene', '场景文件必须是一个映射（scene + steps）', file.path)
    return null
  }
  const js = file.doc.toJS() as Record<string, unknown>
  const id = typeof js.scene === 'string' ? js.scene : null
  if (!id) {
    diag.error('bad-scene', '场景文件缺少 scene: <id>', file.path)
    return null
  }
  if (id !== expectedId) {
    diag.error('scene-id-mismatch', `场景 id "${id}" 与文件名 "${expectedId}" 不一致`, file.path, nodePos(file, root.get('scene', true)))
  }
  const stepsNode = root.get('steps', true)
  if (!isSeq(stepsNode)) {
    diag.error('bad-scene', '场景缺少 steps 列表', file.path)
    return null
  }
  const steps = normalizeSteps(stepsNode.items, ctx)
  return { id, title: typeof js.title === 'string' ? js.title : null, steps, file }
}

function normalizeSteps(items: readonly unknown[], ctx: Ctx): Step[] {
  const out: Step[] = []
  for (const item of items) {
    const s = normalizeStep(item, ctx)
    if (s) out.push(s)
  }
  return out
}

function normalizeStep(node: unknown, ctx: Ctx): Step | null {
  const { file, reg, diag } = ctx
  const pos = nodePos(file, node)

  if (isScalar(node)) {
    if (typeof node.value === 'string') return { kind: 'narrate', text: node.value, pos }
    diag.error('bad-step', `步骤必须是字符串（旁白）或映射（指令/台词），得到 ${JSON.stringify(node.value)}`, file.path, pos)
    return null
  }

  if (!isMap(node)) {
    diag.error('bad-step', '步骤必须是字符串（旁白）或映射（指令/台词）', file.path, pos)
    return null
  }

  const keys: string[] = []
  for (const pair of node.items) {
    if (isScalar(pair.key) && typeof pair.key.value === 'string') keys.push(pair.key.value)
  }

  const instr = keys.find((k) => INSTRUCTION_KEYS.has(k))
  if (instr) return normalizeInstruction(instr, node, keys, ctx, pos)

  // say：首键 = 角色名[@表情]
  const first = keys[0]
  if (first !== undefined) {
    const at = first.indexOf('@')
    const who = at >= 0 ? first.slice(0, at) : first
    const face = at >= 0 ? first.slice(at + 1) : null
    if (reg.characters.has(who)) {
      const js = toJS(node) as Record<string, unknown>
      const text = js[first]
      if (typeof text !== 'string') {
        diag.error('bad-say', `台词内容必须是字符串`, file.path, pos)
        return null
      }
      const extra = keys.slice(1).filter((k) => !['id', 'voice', 'face', 'at'].includes(k))
      if (extra.length) diag.error('bad-say-key', `台词不支持的辅助键：${extra.join(', ')}`, file.path, pos)
      if (face !== null && face.length === 0) diag.error('bad-say', `"${first}" 的 @ 后缺少表情名`, file.path, pos)
      const explicitFace = typeof js.face === 'string' ? js.face : null
      const voice = js.voice
      if (voice !== undefined && voice !== false && typeof voice !== 'string') {
        diag.error('bad-voice', `voice 只能是 false 或语音 id 字符串`, file.path, pos)
      }
      if (typeof voice === 'string' && YAML11_BOOLS.test(voice)) {
        diag.error('yaml-bool-trap', `voice: ${voice} 在 YAML 1.2 中是字符串，关闭语音请写 voice: false`, file.path, pos)
      }
      return {
        kind: 'say',
        who,
        text,
        face: face ?? explicitFace,
        id: typeof voice === 'string' ? voice : typeof js.id === 'string' ? js.id : null,
        voiceOff: voice === false,
        reuse: typeof voice === 'string',
        pos,
      }
    }
    diag.error('unknown-step-key', `"${first}" 既不是指令也不是已注册的角色名`, file.path, pos)
    return null
  }

  diag.error('bad-step', '空的步骤映射', file.path, pos)
  return null
}

function normalizeInstruction(instr: string, node: ReturnType<typeof Object>, keys: string[], ctx: Ctx, pos: Pos | null): Step | null {
  const { file, diag } = ctx
  const map = node as { get(k: string, keep?: boolean): unknown }
  const js = toJS(node) as Record<string, unknown>
  const v = js[instr]

  const allowed: Record<string, string[]> = {
    bg: ['bg'], show: ['show'], hide: ['hide'], bgm: ['bgm'], se: ['se'], wait: ['wait'],
    set: ['set'], if: ['if', 'then', 'else'], random: ['random'], choice: ['choice'],
    label: ['label'], jump: ['jump'], end: ['end'],
  }
  const extra = keys.filter((k) => !allowed[instr].includes(k))
  if (extra.length) {
    diag.error('bad-instruction-key', `指令 ${instr} 不支持的键：${extra.join(', ')}`, file.path, pos)
  }

  const expectStr = (val: unknown, what: string): string | null => {
    if (typeof val === 'string') return val
    diag.error('bad-instruction', `${what} 必须是字符串`, file.path, pos)
    return null
  }

  switch (instr) {
    case 'bg': {
      if (typeof v === 'string') return { kind: 'bg', name: v, pos }
      const o = (v ?? {}) as Record<string, unknown>
      const name = expectStr(o.name, 'bg.name')
      if (!name) return null
      return { kind: 'bg', name, transition: strOpt(o.transition), duration: numOpt(o.duration), pos }
    }
    case 'show': {
      if (typeof v === 'string') return { kind: 'show', who: v, patch: {}, pos }
      const o = (v ?? {}) as Record<string, unknown>
      const who = expectStr(o.who, 'show.who')
      if (!who) return null
      const patch: StatePatch = {}
      if (typeof o.outfit === 'string') patch.outfit = o.outfit
      if (o.state !== undefined) {
        patch.state = Array.isArray(o.state)
          ? o.state.filter((x): x is string => typeof x === 'string')
          : typeof o.state === 'string' ? [o.state] : []
      }
      if (typeof o.face === 'string') patch.face = o.face
      if (o.at === 'left' || o.at === 'center' || o.at === 'right') patch.at = o.at
      else if (o.at !== undefined) diag.error('bad-instruction', `show.at 只能是 left/center/right`, file.path, pos)
      return { kind: 'show', who, patch, transition: strOpt(o.transition), pos }
    }
    case 'hide': {
      if (typeof v === 'string') return { kind: 'hide', who: v, pos }
      const o = (v ?? {}) as Record<string, unknown>
      const who = expectStr(o.who, 'hide.who')
      if (!who) return null
      return { kind: 'hide', who, transition: strOpt(o.transition), pos }
    }
    case 'bgm': {
      if (v === 'stop') return { kind: 'bgm', name: null, pos }
      if (typeof v === 'string') return { kind: 'bgm', name: v, pos }
      const o = (v ?? {}) as Record<string, unknown>
      const name = expectStr(o.name, 'bgm.name')
      if (!name) return null
      return { kind: 'bgm', name, fade: numOpt(o.fade), pos }
    }
    case 'se': {
      const name = expectStr(v, 'se')
      return name ? { kind: 'se', name, pos } : null
    }
    case 'wait': {
      if (typeof v !== 'number' || v < 0) {
        diag.error('bad-instruction', 'wait 必须是非负毫秒数', file.path, pos)
        return null
      }
      return { kind: 'wait', ms: v, pos }
    }
    case 'set': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        diag.error('bad-instruction', 'set 必须是 { 变量: 值 } 映射', file.path, pos)
        return null
      }
      const assigns: Assign[] = []
      for (const [name, raw] of Object.entries(v as Record<string, unknown>)) {
        try {
          assigns.push([name, parseSetValue(name, raw)])
        } catch (e) {
          const err = e as ExprError
          diag.error(err.code ?? 'expr-syntax', `set ${name}: ${err.message}`, file.path, pos)
        }
      }
      return { kind: 'set', assigns, pos }
    }
    case 'if': {
      const exprSrc = expectStr(v, 'if 条件')
      if (exprSrc === null) return null
      const expr = tryExpr(exprSrc, ctx, pos)
      if (!expr) return null
      const thenNode = map.get('then', true)
      if (!isSeq(thenNode)) {
        diag.error('bad-instruction', 'if 缺少 then 步骤列表', file.path, pos)
        return null
      }
      const elseNode = map.get('else', true)
      return {
        kind: 'if', expr, exprSrc,
        then: normalizeSteps(thenNode.items, ctx),
        else: isSeq(elseNode) ? normalizeSteps(elseNode.items, ctx) : [],
        pos,
      }
    }
    case 'random': {
      const listNode = map.get('random', true)
      if (!isSeq(listNode)) {
        diag.error('bad-instruction', 'random 必须是分支列表', file.path, pos)
        return null
      }
      const branches: RandomBranch[] = []
      for (const item of listNode.items) {
        const bpos = nodePos(file, item)
        if (!isMap(item)) {
          diag.error('bad-instruction', 'random 分支必须是映射', file.path, bpos)
          continue
        }
        const bjs = toJS(item) as Record<string, unknown>
        let weight: ExprAST | null = null
        let weightSrc = ''
        if (typeof bjs.weight === 'number') {
          weight = ['lit', bjs.weight]
          weightSrc = String(bjs.weight)
        } else if (typeof bjs.weight === 'string') {
          weightSrc = bjs.weight
          weight = tryExpr(bjs.weight, ctx, bpos)
        } else {
          diag.error('bad-instruction', 'random 分支缺少 weight（数字或表达式）', file.path, bpos)
        }
        if (!weight) continue
        const stepsNode = item.get('then', true)
        const goto = typeof bjs.goto === 'string' ? bjs.goto : null
        if (!isSeq(stepsNode) && !goto) {
          diag.error('bad-instruction', 'random 分支需要 then 或 goto', file.path, bpos)
          continue
        }
        if (isSeq(stepsNode) && goto) {
          diag.error('bad-instruction', 'random 分支的 then 与 goto 互斥', file.path, bpos)
          continue
        }
        branches.push({
          weight, weightSrc,
          steps: isSeq(stepsNode) ? normalizeSteps(stepsNode.items, ctx) : null,
          goto, pos: bpos,
        })
      }
      if (!branches.length) {
        diag.error('bad-instruction', 'random 至少需要一个分支', file.path, pos)
        return null
      }
      return { kind: 'random', branches, pos }
    }
    case 'choice': {
      const listNode = map.get('choice', true)
      if (!isSeq(listNode)) {
        diag.error('bad-instruction', 'choice 必须是选项列表', file.path, pos)
        return null
      }
      const options: ChoiceOption[] = []
      for (const item of listNode.items) {
        const opos = nodePos(file, item)
        if (!isMap(item)) {
          diag.error('bad-instruction', 'choice 选项必须是映射', file.path, opos)
          continue
        }
        const ojs = toJS(item) as Record<string, unknown>
        if (typeof ojs.text !== 'string') {
          diag.error('bad-instruction', 'choice 选项缺少 text', file.path, opos)
          continue
        }
        const opt: ChoiceOption = { text: ojs.text, goto: typeof ojs.goto === 'string' ? ojs.goto : null, pos: opos }
        if (typeof ojs.if === 'string') {
          const e = tryExpr(ojs.if, ctx, opos)
          if (e) {
            opt.if = e
            opt.ifSrc = ojs.if
          }
        } else if (ojs.if !== undefined) {
          diag.error('bad-instruction', '选项的 if 必须是表达式字符串', file.path, opos)
        }
        if (ojs.set !== undefined) {
          if (ojs.set && typeof ojs.set === 'object' && !Array.isArray(ojs.set)) {
            opt.set = []
            for (const [name, raw] of Object.entries(ojs.set as Record<string, unknown>)) {
              try {
                opt.set.push([name, parseSetValue(name, raw)])
              } catch (e) {
                diag.error('expr-syntax', `set ${name}: ${(e as ExprError).message}`, file.path, opos)
              }
            }
          } else {
            diag.error('bad-instruction', '选项的 set 必须是映射', file.path, opos)
          }
        }
        options.push(opt)
      }
      if (!options.length) {
        diag.error('bad-instruction', 'choice 至少需要一个选项', file.path, pos)
        return null
      }
      return { kind: 'choice', options, pos }
    }
    case 'label': {
      const name = expectStr(v, 'label')
      return name ? { kind: 'label', name, pos } : null
    }
    case 'jump': {
      const target = expectStr(v, 'jump 目标')
      return target ? { kind: 'jump', target, pos } : null
    }
    case 'end': {
      const ending = expectStr(v, 'end 结局 id')
      return ending ? { kind: 'end', ending, pos } : null
    }
  }
  return null
}

function tryExpr(src: string, ctx: Ctx, pos: Pos | null): ExprAST | null {
  try {
    return parseExpr(src)
  } catch (e) {
    const err = e as ExprError
    ctx.diag.error(err.code ?? 'expr-syntax', `表达式 "${src}"：${err.message}`, ctx.file.path, pos)
    return null
  }
}

function toJS(node: unknown): unknown {
  return (node as { toJSON(): unknown }).toJSON()
}

function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function numOpt(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}
