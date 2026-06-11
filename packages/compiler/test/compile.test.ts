import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NodeFiles, compileProject } from '@vn/compiler'
import { minimalProject } from './fixtures.js'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

describe('样例剧本集成编译', () => {
  const result = compileProject(new NodeFiles(repoRoot))

  it('零错误（资产缺失只是警告）', () => {
    expect(result.diagnostics.errors).toEqual([])
    expect(result.ir).not.toBeNull()
  })

  it('资产缺失产生警告而非错误', () => {
    const codes = result.diagnostics.warnings.map((d) => d.code)
    expect(codes).toContain('asset-missing-file')
    expect(codes).toContain('voice-missing-audio')
  })

  it('场景与控制流扁平化', () => {
    const ir = result.ir!
    expect(Object.keys(ir.scenes).sort()).toEqual(['ch01', 'ch02_alone', 'ch02_walk'])
    expect(ir.scenes.ch01.labels).toHaveProperty('sit_a_while')
    // 分支选项跳转到 ch02_walk 场景
    const choice = ir.scenes.ch01.ops.find(
      (o) => o.op === 'choice' && o.options.some((x) => x.target?.scene === 'ch02_walk'),
    )
    expect(choice).toBeTruthy()
  })

  it('语音行解析：6 条配音台词，全部待录', () => {
    expect(result.voiceLines).toHaveLength(6)
    expect(result.voiceLines.every((l) => l.missing)).toBe(true)
    expect(result.ir!.lineIndex).toHaveProperty('ch01_0010')
  })

  it('立绘组合数据流：样例的可达组合全部已注册', () => {
    expect(result.sprites!.missing).toEqual([])
    const demanded = result.sprites!.demanded.get('小满')!
    expect(demanded.has('校服|淋湿|微笑')).toBe(true)
  })

  it('两个结局都可达（无 unreachable-ending 警告）', () => {
    expect(result.diagnostics.items.filter((d) => d.code === 'unreachable-ending')).toEqual([])
  })
})

describe('语义检查（负例）', () => {
  const errorsOf = (overrides: Record<string, string | null>) =>
    compileProject(minimalProject(overrides)).diagnostics.errors.map((d) => d.code)

  it('未注册的角色名作为台词键', () => {
    expect(
      errorsOf({
        'story/scenes/s1.yaml': `
scene: s1
steps:
  - 丙: "我是谁。"
  - end: fin
`,
      }),
    ).toContain('unknown-step-key')
  })

  it('悬空跳转', () => {
    expect(
      errorsOf({
        'story/scenes/s1.yaml': `
scene: s1
steps:
  - jump: nowhere
`,
      }),
    ).toContain('dangling-jump')
  })

  it('重复 label', () => {
    expect(
      errorsOf({
        'story/scenes/s1.yaml': `
scene: s1
steps:
  - label: a
  - label: a
  - end: fin
`,
      }),
    ).toContain('dup-label')
  })

  it('未声明变量', () => {
    expect(
      errorsOf({
        'story/scenes/s1.yaml': `
scene: s1
steps:
  - set: { unknown_var: 1 }
  - end: fin
`,
      }),
    ).toContain('undeclared-var')
  })

  it('词表外的表情', () => {
    expect(
      errorsOf({
        'story/scenes/s1.yaml': `
scene: s1
steps:
  - 甲@哭: "呜。"
  - end: fin
`,
      }),
    ).toContain('dim-unknown')
  })

  it('类型不匹配：if 条件是数字', () => {
    expect(
      errorsOf({
        'story/scenes/s1.yaml': `
scene: s1
steps:
  - if: "n + 1"
    then:
      - "x"
  - end: fin
`,
      }),
    ).toContain('type-mismatch')
  })

  it('语音 id 重复', () => {
    expect(
      errorsOf({
        'story/scenes/s1.yaml': `
scene: s1
steps:
  - 甲: "一。"
    id: s1_0010
  - 甲: "二。"
    id: s1_0010
  - end: fin
`,
      }),
    ).toContain('dup-voice-id')
  })

  it('结局未注册', () => {
    expect(
      errorsOf({
        'story/scenes/s1.yaml': `
scene: s1
steps:
  - end: nofin
`,
      }),
    ).toContain('unknown-ref')
  })
})

describe('语义检查（警告与占位策略）', () => {
  it('可达组合缺变体 → 警告 + 进入清单，而非错误', () => {
    const r = compileProject(
      minimalProject({
        'story/scenes/s1.yaml': `
scene: s1
steps:
  - show: { who: 甲, state: 淋湿, face: 笑 }
  - 甲: "湿透了。"
    id: s1_0010
  - end: fin
`,
      }),
    )
    expect(r.diagnostics.errors).toEqual([])
    expect(r.sprites!.missing.map((m) => m.comboKey)).toContain('常服|淋湿|笑')
  })

  it('全选项带条件 → 软锁风险警告', () => {
    const r = compileProject(
      minimalProject({
        'story/scenes/s1.yaml': `
scene: s1
steps:
  - choice:
      - text: a
        if: "flag"
      - text: b
        if: "!flag"
  - end: fin
`,
      }),
    )
    expect(r.diagnostics.warnings.map((d) => d.code)).toContain('softlock-risk')
  })

  it('yes/no 布尔陷阱：明确报错并提示写 true/false', () => {
    const r = compileProject(
      minimalProject({
        'story/scenes/s1.yaml': `
scene: s1
steps:
  - set: { flag: yes }
  - end: fin
`,
      }),
    )
    // YAML 1.2 中 yes 是字符串 → 进表达式解析 → 给出明确修复提示
    const trap = r.diagnostics.errors.find((d) => d.code === 'yaml-bool-trap')
    expect(trap?.message).toContain('true/false')
  })

  it('语音文件多扩展名：wav 也能被识别为已录', () => {
    const files = minimalProject({ 'voice/s1/s1_0010.wav': 'fake-audio-bytes' })
    const r = compileProject(files)
    expect(r.voiceLines).toHaveLength(1)
    expect(r.voiceLines[0].missing).toBe(false)
    expect(r.voiceLines[0].file).toBe('voice/s1/s1_0010.wav')
  })

  it('production 编辑素材：缺文件只提示（info），不进 IR', () => {
    const r = compileProject(
      minimalProject({
        'story/characters.yaml': `
characters:
  甲:
    sprite:
      default: { outfit: 常服, face: 默认 }
      variants:
        - { outfit: 常服, face: 默认, file: a/normal.png }
    production:
      refs: [production/refs/a/sheet.png]
      tts: { provider: gpt-sovits, sample: production/tts/a/sample.wav, params: { speed: 1.0 } }
  乙:
    voiced: false
`,
      }),
    )
    expect(r.diagnostics.errors).toEqual([])
    const infos = r.diagnostics.items.filter((d) => d.code === 'production-missing-file')
    expect(infos).toHaveLength(2) // 参考图 + 音色文件都不存在
    expect(infos.every((d) => d.severity === 'info')).toBe(true)
    expect(JSON.stringify(r.ir)).not.toContain('production/') // 不进 IR
  })

  it('场景末尾无 jump/end → 警告', () => {
    const r = compileProject(
      minimalProject({
        'story/scenes/s1.yaml': `
scene: s1
steps:
  - "就这样结束了？"
`,
      }),
    )
    expect(r.diagnostics.warnings.map((d) => d.code)).toContain('scene-fallthrough')
  })
})
