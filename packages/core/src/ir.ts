/** 表达式 AST：数组编码，可直接序列化进 IR JSON */
export type BinOp = '||' | '&&' | '==' | '!=' | '>' | '>=' | '<' | '<=' | '+' | '-' | '*' | '/'
export type ExprAST =
  | ['lit', number | boolean | string]
  | ['var', string]
  | ['global', string]
  | ['bin', BinOp, ExprAST, ExprAST]
  | ['un', '!' | '-', ExprAST]
  | ['call', 'rand' | 'randint', ExprAST[]]

export type Assign = [name: string, value: ExprAST]

export interface VoiceRef {
  id: string
  file: string
  /** 来自 voice.lock 的预计算时长；未录制/未扫描为 null（运行时按字数估算） */
  durationMs: number | null
  /** 文件不在磁盘 → 占位（静音） */
  missing: boolean
}

export type StatePatch = {
  outfit?: string
  /** 替换语义：单值归一化为数组，[] 表示清空 */
  state?: string[]
  face?: string
  at?: 'left' | 'center' | 'right'
}

/** 跳转目标：scene 缺省 = 当前场景内 */
export interface Target {
  scene?: string
  to: number
}

export type Op =
  | { op: 'narrate'; text: string; lineId: string }
  | { op: 'say'; who: string; text: string; face: string | null; lineId: string; voice: VoiceRef | null }
  | { op: 'bg'; name: string; transition?: string; duration?: number }
  | { op: 'show'; who: string; patch: StatePatch; transition?: string }
  | { op: 'hide'; who: string; transition?: string }
  | { op: 'bgm'; name: string | null; fade?: number }
  | { op: 'se'; name: string }
  | { op: 'wait'; ms: number }
  | { op: 'set'; assigns: Assign[] }
  | { op: 'goto'; to: number }
  | { op: 'jump'; scene: string; to: number }
  | { op: 'jumpIfNot'; expr: ExprAST; to: number }
  | { op: 'random'; branches: Array<{ weight: ExprAST; to: number }> }
  | { op: 'choice'; options: Array<{ text: string; if?: ExprAST; set?: Assign[]; target: Target | null }> }
  | { op: 'end'; ending: string }

export interface SceneIR {
  ops: Op[]
  labels: Record<string, number>
}

export interface AssetRef {
  file: string
  missing: boolean
}

export interface SpriteIR {
  /** 首次登场的初始维度 */
  default: { outfit: string; face: string }
  /** comboKey -> 文件（缺图为 null，运行时占位渲染） */
  variants: Record<string, string | null>
}

export interface CharacterIR {
  color?: string
  voiced: boolean
  sprite: SpriteIR | null
}

export interface StoryIR {
  version: string
  title: string
  entry: string
  vars: Record<string, number | boolean | string>
  endings: Record<string, { title: string }>
  characters: Record<string, CharacterIR>
  assets: {
    backgrounds: Record<string, AssetRef>
    bgm: Record<string, AssetRef>
    se: Record<string, AssetRef>
  }
  scenes: Record<string, SceneIR>
  /** 语音/行 ID -> [场景, op 下标]，存档锚点与已读记录用 */
  lineIndex: Record<string, [string, number]>
}

/** (outfit, state集合, face) -> 变体查找键 */
export function comboKey(outfit: string, state: readonly string[], face: string): string {
  return `${outfit}|${[...state].sort().join('+')}|${face}`
}
