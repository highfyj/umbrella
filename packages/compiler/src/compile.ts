import type { AssetRef, CharacterIR, StoryIR } from '@vn/core'
import { checkReachability, checkRefs, checkSprites, checkVars, type SpriteFlowResult } from './checks.js'
import { Diagnostics } from './diagnostics.js'
import { flattenScenes, linkJumps, toSceneIR } from './flatten.js'
import { normalizeScene, type NormalizedScene } from './normalize.js'
import { parseFile, type ProjectFiles } from './project.js'
import { buildRegistry, type Registry } from './registry.js'
import { resolveVoice, type VoiceLine } from './voice.js'

export interface CompileResult {
  ir: StoryIR | null
  diagnostics: Diagnostics
  registry: Registry | null
  voiceLines: VoiceLine[]
  sprites: SpriteFlowResult | null
}

export function compileProject(files: ProjectFiles): CompileResult {
  const diag = new Diagnostics()
  const fail = (): CompileResult => ({ ir: null, diagnostics: diag, registry: null, voiceLines: [], sprites: null })

  const story = parseFile(files, 'story/story.yaml')
  const characters = parseFile(files, 'story/characters.yaml')
  const assets = parseFile(files, 'story/assets.yaml')
  if (!story) diag.error('missing-file', '找不到 story/story.yaml', 'story/story.yaml')
  if (!characters) diag.error('missing-file', '找不到 story/characters.yaml', 'story/characters.yaml')
  if (!assets) diag.error('missing-file', '找不到 story/assets.yaml', 'story/assets.yaml')
  if (!story || !characters || !assets) return fail()

  const reg = buildRegistry(story, characters, assets, diag)

  const sceneFiles = files.list('story/scenes').filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
  if (!sceneFiles.length) {
    diag.error('missing-file', 'story/scenes/ 下没有场景文件', 'story/scenes')
    return fail()
  }
  const normalized: NormalizedScene[] = []
  for (const f of sceneFiles) {
    const pf = parseFile(files, `story/scenes/${f}`)
    if (!pf) continue
    const expectedId = f.replace(/\.ya?ml$/, '')
    const ns = normalizeScene(pf, expectedId, reg, diag)
    if (ns) normalized.push(ns)
  }

  const flat = flattenScenes(normalized, diag)
  linkJumps(flat, diag)

  checkRefs(flat.scenes, reg, diag)
  checkVars(flat.scenes, reg, diag)
  checkReachability(flat.scenes, reg, diag)
  const sprites = checkSprites(flat.scenes, reg, diag)
  const voiceLines = resolveVoice(flat, reg, files, diag)

  // 资产文件存在性：已注册但文件缺失 = 警告 + 占位
  const assetRefs = (m: Map<string, string>, what: string): Record<string, AssetRef> => {
    const out: Record<string, AssetRef> = {}
    for (const [name, file] of m) {
      const missing = !files.exists(file)
      if (missing) diag.warn('asset-missing-file', `${what} "${name}" 的文件不存在（${file}），将占位`, 'story/assets.yaml')
      out[name] = { file, missing }
    }
    return out
  }

  // 编辑素材（production）：只做存在性提示，不进 IR、不随游戏发布
  for (const c of reg.characters.values()) {
    if (!c.production) continue
    for (const ref of c.production.refs) {
      if (!files.exists(ref)) diag.info('production-missing-file', `角色 "${c.name}" 的参考图不存在（${ref}）`, 'story/characters.yaml')
    }
    const sample = c.production.tts?.sample
    if (sample && !files.exists(sample)) {
      diag.info('production-missing-file', `角色 "${c.name}" 的音色文件不存在（${sample}）`, 'story/characters.yaml')
    }
  }

  const charactersIR: Record<string, CharacterIR> = {}
  for (const c of reg.characters.values()) {
    let sprite: CharacterIR['sprite'] = null
    if (c.sprite) {
      const variants: Record<string, string | null> = {}
      for (const [key, file] of c.sprite.variants) {
        const path = `sprite/${file}`
        if (files.exists(path)) {
          variants[key] = path
        } else {
          variants[key] = null
          diag.warn('asset-missing-file', `角色 "${c.name}" 变体 ${key} 的文件不存在（${path}），将占位`, 'story/characters.yaml')
        }
      }
      sprite = { default: c.sprite.default, variants }
    }
    charactersIR[c.name] = { color: c.color, voiced: c.voiced, sprite }
  }

  const lineIndex: Record<string, [string, number]> = {}
  for (const sc of flat.scenes.values()) {
    sc.ops.forEach((op, i) => {
      if ((op.op === 'say' || op.op === 'narrate') && op.lineId && lineIndex[op.lineId] === undefined) {
        lineIndex[op.lineId] = [sc.id, i]
      }
    })
  }

  const ir: StoryIR = {
    version: '0.1',
    title: reg.title,
    entry: reg.entry,
    vars: reg.vars,
    endings: reg.endings,
    characters: charactersIR,
    assets: {
      backgrounds: assetRefs(reg.backgrounds, '背景'),
      bgm: assetRefs(reg.bgm, 'BGM'),
      se: assetRefs(reg.se, '音效'),
    },
    scenes: Object.fromEntries([...flat.scenes.values()].map((s) => [s.id, toSceneIR(s)])),
    lineIndex,
  }

  return { ir: diag.hasErrors() ? null : ir, diagnostics: diag, registry: reg, voiceLines, sprites }
}
