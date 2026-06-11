import { parse as parseYaml } from 'yaml'
import type { StoryIR } from '@vn/core'

/** 资产索引：把磁盘扫描、IR 注册表、production 元数据合并成一张关联视图 */

export interface RegisteredAsset {
  name: string
  file: string
  missing: boolean
}

export interface VariantView {
  outfit: string
  state: string[]
  face: string
  combo: string
  file: string
  missing: boolean
}

export interface CharacterView {
  name: string
  color?: string
  voiced: boolean
  spriteDir: string | null
  variants: VariantView[]
  /** sprite/<dir>/ 下存在但未注册为变体的文件 */
  unregisteredSprites: string[]
  refs: Array<{ path: string; exists: boolean }>
  tts: { provider?: string; sample?: string; sampleExists: boolean; params?: Record<string, unknown> } | null
  dims: { outfit: string[]; state: string[]; face: string[] }
}

export interface VoiceLineView {
  id: string
  file: string
  exists: boolean
  who: string
  text: string
}

export interface AssetIndex {
  backgrounds: RegisteredAsset[]
  bgm: RegisteredAsset[]
  se: RegisteredAsset[]
  characters: CharacterView[]
  voice: Array<{ scene: string; lines: VoiceLineView[] }>
  /** 未注册的散文件 */
  loose: { bg: string[]; bgm: string[]; se: string[]; sprite: string[]; refs: string[]; tts: string[] }
}

interface ScanResult {
  files: Record<string, string[]>
}

interface ProductionYaml {
  refs?: string[]
  tts?: { provider?: string; sample?: string; params?: Record<string, unknown> }
}

export function buildAssetIndex(scan: ScanResult, ir: StoryIR, charactersYamlText: string): AssetIndex {
  const disk = new Set(Object.values(scan.files).flat())

  const registered = (table: Record<string, { file: string; missing: boolean }>): RegisteredAsset[] =>
    Object.entries(table)
      .map(([name, a]) => ({ name, file: a.file, missing: !disk.has(a.file) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))

  // production 元数据从 characters.yaml 源文本读（不进 IR）
  let productionByChar: Record<string, ProductionYaml> = {}
  try {
    const chars = (parseYaml(charactersYamlText)?.characters ?? {}) as Record<string, { production?: ProductionYaml }>
    productionByChar = Object.fromEntries(
      Object.entries(chars).map(([name, def]) => [name, def?.production ?? {}]),
    )
  } catch {
    /* 源文本暂时解析不了（正在编辑）→ 用空 production */
  }

  const registeredSpriteFiles = new Set<string>()
  const characters: CharacterView[] = []
  for (const [name, def] of Object.entries(ir.characters)) {
    const variants: VariantView[] = []
    let spriteDir: string | null = null
    if (def.sprite) {
      for (const [combo, file] of Object.entries(def.sprite.variants)) {
        const [outfit, stateStr, face] = combo.split('|')
        // IR 里 file 为 null 表示编译时文件缺失；路径按约定可从注册表反推，但这里直接扫描匹配
        const realFile = file ?? findVariantFile(scan.files.sprite ?? [], combo)
        if (file) registeredSpriteFiles.add(file)
        variants.push({
          outfit,
          state: stateStr ? stateStr.split('+') : [],
          face,
          combo,
          file: file ?? '（缺文件）',
          missing: file === null,
        })
        if (file) {
          const m = /^sprite\/([^/]+)\//.exec(file)
          if (m) spriteDir = m[1]
        }
      }
    }
    const prod = productionByChar[name] ?? {}
    const refs = (prod.refs ?? []).map((p) => ({ path: p, exists: disk.has(p) }))
    const tts = prod.tts
      ? { ...prod.tts, sampleExists: prod.tts.sample ? disk.has(prod.tts.sample) : false }
      : null
    characters.push({
      name,
      color: def.color,
      voiced: def.voiced,
      spriteDir,
      variants,
      unregisteredSprites: [],
      refs,
      tts,
      dims: dimsFromVariants(variants),
    })
  }

  // 未注册的立绘文件：按目录归到角色，归不到的进 loose
  const looseSprites: string[] = []
  for (const f of scan.files.sprite ?? []) {
    if (registeredSpriteFiles.has(f)) continue
    const m = /^sprite\/([^/]+)\//.exec(f)
    const owner = m ? characters.find((c) => c.spriteDir === m[1]) : undefined
    if (owner) owner.unregisteredSprites.push(f)
    else looseSprites.push(f)
  }

  const inTable = (table: RegisteredAsset[], f: string): boolean => table.some((a) => a.file === f)
  const backgrounds = registered(ir.assets.backgrounds)
  const bgmList = registered(ir.assets.bgm)
  const seList = registered(ir.assets.se)

  // 语音：从 IR 的 say op 收集每场景的语音行
  const voiceByScene = new Map<string, VoiceLineView[]>()
  const seen = new Set<string>()
  for (const [sceneId, sc] of Object.entries(ir.scenes)) {
    for (const op of sc.ops) {
      if (op.op === 'say' && op.voice && !seen.has(op.voice.id)) {
        seen.add(op.voice.id)
        let list = voiceByScene.get(sceneId)
        if (!list) {
          list = []
          voiceByScene.set(sceneId, list)
        }
        list.push({ id: op.voice.id, file: op.voice.file, exists: disk.has(op.voice.file), who: op.who, text: op.text })
      }
    }
  }

  const associatedRefs = new Set(characters.flatMap((c) => c.refs.map((r) => r.path)))
  const associatedTts = new Set(characters.map((c) => c.tts?.sample).filter(Boolean) as string[])
  const production = scan.files.production ?? []

  return {
    backgrounds,
    bgm: bgmList,
    se: seList,
    characters,
    voice: [...voiceByScene.entries()].map(([scene, lines]) => ({ scene, lines })),
    loose: {
      bg: (scan.files.bg ?? []).filter((f) => !inTable(backgrounds, f)),
      bgm: (scan.files.bgm ?? []).filter((f) => !inTable(bgmList, f)),
      se: (scan.files.se ?? []).filter((f) => !inTable(seList, f)),
      sprite: looseSprites,
      refs: production.filter((f) => f.startsWith('production/refs/') && !associatedRefs.has(f)),
      tts: production.filter((f) => f.startsWith('production/tts/') && !associatedTts.has(f)),
    },
  }
}

function findVariantFile(_spriteFiles: string[], _combo: string): null {
  return null
}

function dimsFromVariants(variants: VariantView[]): { outfit: string[]; state: string[]; face: string[] } {
  const outfit = new Set<string>()
  const state = new Set<string>()
  const face = new Set<string>()
  for (const v of variants) {
    outfit.add(v.outfit)
    face.add(v.face)
    for (const s of v.state) state.add(s)
  }
  return { outfit: [...outfit], state: [...state], face: [...face] }
}

/** 文件名 → 建议的注册名（去目录、去扩展名） */
export function suggestName(file: string): string {
  return file.split('/').pop()!.replace(/\.[^.]+$/, '')
}

export function isImage(file: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(file)
}

export function isAudio(file: string): boolean {
  return /\.(ogg|mp3|wav|m4a)$/i.test(file)
}
