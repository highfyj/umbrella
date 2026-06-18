import { describe, expect, it } from 'vitest'
import { compileProject } from '@vn/compiler'
import { minimalProject } from './fixtures.js'

/** 在最小项目上挂载货币 + 物品注册表 */
const withFeatures = (overrides: Record<string, string | null>) =>
  minimalProject({
    'story/story.yaml': `
title: t
entry: s1
vars: { flag: false }
currency: { enabled: true, symbol: ₲, initial: 100 }
endings: { fin: { title: 完 } }
`,
    'story/items.yaml': `
items:
  伞: { name: 旧雨伞, desc: 一把褪色的长柄伞, image: umbrella.png }
  硬币: { name: 硬币 }
`,
    ...overrides,
  })

const codesOf = (scene: string, base = withFeatures) =>
  compileProject(base({ 'story/scenes/s1.yaml': scene })).diagnostics.errors.map((d) => d.code)

describe('扩展指令：text / shake / item / money', () => {
  it('齐活编译零错误，且 IR 含 currency / items / 注入 money 变量', () => {
    const r = compileProject(
      withFeatures({
        'story/scenes/s1.yaml': `
scene: s1
steps:
  - text: { style: intro, title: 序章, content: "雨夜。" }
  - shake: 强
  - item: { get: 伞 }
  - item: { get: 硬币, n: 5 }
  - money: { earn: 50 }
  - if: "item.伞 >= 1 && money >= 120"
    then:
      - set: { item.硬币: "item.硬币 - 2" }
      - money: { spend: 30 }
  - end: fin
`,
      }),
    )
    expect(r.diagnostics.errors).toEqual([])
    expect(r.ir!.currency).toMatchObject({ symbol: '₲' })
    expect(r.ir!.vars.money).toBe(100)
    expect(r.ir!.items.伞.image).toMatchObject({ missing: true, file: 'item/umbrella.png' })
  })

  it('未注册物品 → unknown-ref（指令 / 表达式 / set 目标三处）', () => {
    expect(codesOf(`scene: s1\nsteps:\n  - item: { get: 没有 }\n  - end: fin\n`)).toContain('unknown-ref')
    expect(codesOf(`scene: s1\nsteps:\n  - if: "item.没有 >= 1"\n    then: [ "x" ]\n  - end: fin\n`)).toContain('unknown-ref')
    expect(codesOf(`scene: s1\nsteps:\n  - set: { item.没有: 1 }\n  - end: fin\n`)).toContain('unknown-ref')
  })

  it('未启用 currency 却用 money 指令 → money-disabled', () => {
    const r = compileProject(minimalProject({ 'story/scenes/s1.yaml': `scene: s1\nsteps:\n  - money: { earn: 1 }\n  - end: fin\n` }))
    expect(r.diagnostics.errors.map((d) => d.code)).toContain('money-disabled')
  })

  it('启用 currency 同时声明 money 变量 → money-var-conflict', () => {
    const r = compileProject(
      minimalProject({
        'story/story.yaml': `title: t\nentry: s1\nvars: { money: 0 }\ncurrency: { enabled: true }\nendings: { fin: { title: 完 } }\n`,
        'story/scenes/s1.yaml': `scene: s1\nsteps:\n  - end: fin\n`,
      }),
    )
    expect(r.diagnostics.errors.map((d) => d.code)).toContain('money-var-conflict')
  })

  it('非法 text.style / shake 强度 → bad-instruction', () => {
    expect(codesOf(`scene: s1\nsteps:\n  - text: { style: 乱来, content: x }\n  - end: fin\n`)).toContain('bad-instruction')
    expect(codesOf(`scene: s1\nsteps:\n  - shake: 巨\n  - end: fin\n`)).toContain('bad-instruction')
  })

  it('物品数量类型检查：if 里把物品当布尔比较 → type-mismatch', () => {
    expect(codesOf(`scene: s1\nsteps:\n  - if: "item.伞"\n    then: [ "x" ]\n  - end: fin\n`)).toContain('type-mismatch')
  })
})
