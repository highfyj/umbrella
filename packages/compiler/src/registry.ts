import type { Pos, Diagnostics } from './diagnostics.js'
import { Diagnostics as _D } from './diagnostics.js'
import { ParsedFile, isMap, nodePos } from './project.js'
import { comboKey } from '@vn/core'

/** 主指令键（与角色名互斥） */
export const INSTRUCTION_KEYS = new Set([
  'bg', 'show', 'hide', 'bgm', 'se', 'wait', 'set', 'if', 'random', 'choice', 'label', 'jump', 'end',
  'text', 'shake', 'item', 'money',
])
/** 所有保留键（含辅助键），角色名不得与之重名 */
export const RESERVED_KEYS = new Set([
  ...INSTRUCTION_KEYS,
  'then', 'else', 'goto', 'weight', 'text', 'id', 'voice', 'face', 'at', 'who',
  'name', 'transition', 'duration', 'fade', 'steps', 'scene', 'title',
  'style', 'content', 'intensity', 'ms', 'get', 'lose', 'n', 'earn', 'spend',
])

export interface SpriteRegistry {
  dims: { outfit: Set<string>; state: Set<string>; face: Set<string> }
  dimsDeclared: boolean
  default: { outfit: string; face: string }
  /** comboKey -> 相对 sprite/ 的文件路径 */
  variants: Map<string, string>
  variantPos: Map<string, Pos | null>
}

/** 编辑素材（生产元数据）：不进 IR、不随游戏发布 */
export interface ProductionInfo {
  /** AI 出图参考立绘（production/refs/ 下） */
  refs: string[]
  /** TTS 音色：参考音频 + 透传给生成接口的参数 */
  tts: { provider?: string; sample?: string; params?: Record<string, unknown> } | null
}

export interface CharacterDef {
  name: string
  color?: string
  voiced: boolean
  sprite: SpriteRegistry | null
  production: ProductionInfo | null
}

export interface ItemDef {
  name: string
  desc: string | null
  /** 相对 item/ 的配图文件名；无图为 null（占位渲染） */
  image: string | null
  max: number | null
}

export interface CurrencyDef {
  name: string
  symbol: string
  initial: number
}

export interface Registry {
  title: string
  version: string
  entry: string
  vars: Record<string, number | boolean | string>
  endings: Record<string, { title: string }>
  characters: Map<string, CharacterDef>
  items: Map<string, ItemDef>
  currency: CurrencyDef | null
  backgrounds: Map<string, string>
  bgm: Map<string, string>
  se: Map<string, string>
}

type Json = Record<string, unknown>

export function buildRegistry(
  story: ParsedFile,
  characters: ParsedFile,
  assets: ParsedFile,
  items: ParsedFile | null,
  diag: Diagnostics,
): Registry {
  const storyJs = (story.doc.toJS() ?? {}) as Json
  const charsJs = (characters.doc.toJS() ?? {}) as Json
  const assetsJs = (assets.doc.toJS() ?? {}) as Json
  const itemsJs = (items?.doc.toJS() ?? {}) as Json

  const reg: Registry = {
    title: str(storyJs.title) ?? '未命名',
    version: str(storyJs.version) ?? '0.0.0',
    entry: str(storyJs.entry) ?? '',
    vars: {},
    endings: {},
    characters: new Map(),
    items: new Map(),
    currency: null,
    backgrounds: toStrMap(assetsJs.backgrounds),
    bgm: toStrMap(assetsJs.bgm),
    se: toStrMap(assetsJs.se),
  }

  if (!reg.entry) diag.error('missing-entry', 'story.yaml 缺少 entry 字段', story.path)

  const vars = (storyJs.vars ?? {}) as Json
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
      reg.vars[k] = v
    } else {
      diag.error('bad-var-default', `变量 ${k} 的默认值必须是数字/布尔/字符串`, story.path)
    }
  }

  // 物品注册表（items.yaml，可缺省）
  const itemMap = (itemsJs.items ?? {}) as Json
  for (const [id, def] of Object.entries(itemMap)) {
    const d = (def ?? {}) as Json
    if (id.includes('.')) {
      diag.error('bad-item-id', `物品 id "${id}" 不能包含 "."`, items?.path ?? 'story/items.yaml')
      continue
    }
    const max = typeof d.max === 'number' ? d.max : null
    reg.items.set(id, { name: str(d.name) ?? id, desc: str(d.desc) ?? null, image: str(d.image) ?? null, max })
  }

  // 货币系统（story.yaml currency 块；启用时注入内置变量 money）
  const cur = storyJs.currency as Json | undefined
  if (cur && cur.enabled !== false) {
    reg.currency = { name: str(cur.name) ?? '金钱', symbol: str(cur.symbol) ?? '¥', initial: typeof cur.initial === 'number' ? cur.initial : 0 }
    if (reg.vars.money !== undefined) {
      diag.error('money-var-conflict', '启用 currency 时不能再声明名为 "money" 的变量（它是内置货币变量）', story.path)
    } else {
      reg.vars.money = reg.currency.initial
    }
  }

  const endings = (storyJs.endings ?? {}) as Json
  for (const [k, v] of Object.entries(endings)) {
    reg.endings[k] = { title: str((v as Json)?.title) ?? k }
  }

  const charMapNode = isMap(characters.doc.contents)
    ? characters.doc.contents.get('characters', true)
    : null
  const chars = (charsJs.characters ?? {}) as Json
  for (const [name, def] of Object.entries(chars)) {
    const d = (def ?? {}) as Json
    const pos = isMap(charMapNode) ? nodePos(characters, charMapNode.items.find(
      (p) => (p.key as { value?: unknown })?.value === name,
    )?.key) : null
    if (RESERVED_KEYS.has(name)) {
      diag.error('reserved-character-name', `角色名 "${name}" 与保留指令键冲突`, characters.path, pos)
      continue
    }
    if (name.includes('@')) {
      diag.error('bad-character-name', `角色名 "${name}" 不能包含 @`, characters.path, pos)
      continue
    }
    const sprite = buildSprite(name, d.sprite as Json | undefined, characters, pos, diag)
    reg.characters.set(name, {
      name,
      color: str(d.color),
      voiced: d.voiced !== false,
      sprite,
      production: buildProduction(d.production as Json | undefined),
    })
  }

  return reg
}

function buildSprite(
  charName: string,
  sprite: Json | undefined,
  file: ParsedFile,
  pos: Pos | null,
  diag: Diagnostics,
): SpriteRegistry | null {
  if (!sprite) return null
  const def = (sprite.default ?? {}) as Json
  const defOutfit = str(def.outfit)
  const defFace = str(def.face)
  if (!defOutfit || !defFace) {
    diag.error('sprite-no-default', `角色 "${charName}" 的 sprite 缺少 default: { outfit, face }`, file.path, pos)
    return null
  }

  const dimsRaw = sprite.dims as Json | undefined
  const dims = {
    outfit: new Set<string>(strList(dimsRaw?.outfit)),
    state: new Set<string>(strList(dimsRaw?.state)),
    face: new Set<string>(strList(dimsRaw?.face)),
  }
  const dimsDeclared = !!dimsRaw

  const variants = new Map<string, string>()
  const variantPos = new Map<string, Pos | null>()
  const list = Array.isArray(sprite.variants) ? sprite.variants : []
  for (const v of list as Json[]) {
    const outfit = str(v.outfit)
    const face = str(v.face)
    const state = strList(v.state)
    const f = str(v.file)
    if (!outfit || !face || !f) {
      diag.error('bad-variant', `角色 "${charName}" 的变体缺少 outfit/face/file`, file.path, pos)
      continue
    }
    const key = comboKey(outfit, state, face)
    if (variants.has(key)) {
      diag.error('dup-variant', `角色 "${charName}" 的变体重复：${key}`, file.path, pos)
      continue
    }
    variants.set(key, f)
    variantPos.set(key, pos)
    if (!dimsDeclared) {
      dims.outfit.add(outfit)
      dims.face.add(face)
      for (const s of state) dims.state.add(s)
    } else {
      // 词表已声明：变体本身也要受词表约束
      if (!dims.outfit.has(outfit)) diag.error('dim-unknown', `角色 "${charName}" 变体的 outfit "${outfit}" 不在词表中`, file.path, pos)
      if (!dims.face.has(face)) diag.error('dim-unknown', `角色 "${charName}" 变体的 face "${face}" 不在词表中`, file.path, pos)
      for (const s of state) if (!dims.state.has(s)) diag.error('dim-unknown', `角色 "${charName}" 变体的 state "${s}" 不在词表中`, file.path, pos)
    }
  }
  if (!dimsDeclared) {
    dims.outfit.add(defOutfit)
    dims.face.add(defFace)
  } else {
    if (!dims.outfit.has(defOutfit)) diag.error('dim-unknown', `角色 "${charName}" default 的 outfit "${defOutfit}" 不在词表中`, file.path, pos)
    if (!dims.face.has(defFace)) diag.error('dim-unknown', `角色 "${charName}" default 的 face "${defFace}" 不在词表中`, file.path, pos)
  }

  return { dims, dimsDeclared, default: { outfit: defOutfit, face: defFace }, variants, variantPos }
}

function buildProduction(p: Json | undefined): ProductionInfo | null {
  if (!p) return null
  const ttsRaw = p.tts as Json | undefined
  return {
    refs: strList(p.refs),
    tts: ttsRaw
      ? {
          provider: str(ttsRaw.provider),
          sample: str(ttsRaw.sample),
          params: ttsRaw.params && typeof ttsRaw.params === 'object' ? (ttsRaw.params as Record<string, unknown>) : undefined,
        }
      : null,
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function strList(v: unknown): string[] {
  if (v === undefined || v === null) return []
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return []
}

function toStrMap(v: unknown): Map<string, string> {
  const m = new Map<string, string>()
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Json)) {
      if (typeof val === 'string') m.set(k, val)
    }
  }
  return m
}
