import { describe, expect, it } from 'vitest'
import type { StoryIR } from '@vn/core'
import { MemoryFiles, compileProject } from '@vn/compiler'
import { VM, type VMEvent } from '@vn/runtime'

/** 自带货币 + 物品的最小可运行项目；scene 由各用例提供 */
function buildIr(scene: string): StoryIR {
  const files = MemoryFiles.from({
    'story/story.yaml': `title: t\nentry: s1\nvars: {}\ncurrency: { enabled: true, symbol: ₲, initial: 100 }\nendings: { fin: { title: 完 } }\n`,
    'story/characters.yaml': `characters:\n  乙: { voiced: false }\n`,
    'story/assets.yaml': `backgrounds: {}\nbgm: {}\nse: {}\n`,
    'story/items.yaml': `items:\n  伞: { name: 旧雨伞, image: umbrella.png }\n  硬币: { name: 硬币 }\n`,
    'story/scenes/s1.yaml': scene,
  })
  const r = compileProject(files)
  if (!r.ir) throw new Error('编译失败：' + JSON.stringify(r.diagnostics.errors))
  return r.ir
}

const RICH = `
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
`

function runToEnd(vm: VM): VMEvent[] {
  const events: VMEvent[] = []
  for (let i = 0; i < 1000; i++) {
    const e = vm.next()
    events.push(e)
    if (e.type === 'end') return events
  }
  throw new Error('未结束')
}

describe('VM：扩展指令运行语义', () => {
  it('text 指令产出独立的 text 事件（携带 style/title/content）', () => {
    const vm = new VM(buildIr(RICH), { seed: 1 })
    const e = vm.next()
    expect(e.type).toBe('text')
    expect(e).toMatchObject({ style: 'intro', title: '序章', content: '雨夜。' })
  })

  it('shake 产出非阻塞 effect；物品库存与货币结算正确', () => {
    const vm = new VM(buildIr(RICH), { seed: 1 })
    const effects = runToEnd(vm).flatMap((e) => e.effects)
    expect(effects.some((f) => f.kind === 'shake')).toBe(true)
    expect(vm.inventory).toEqual({ 伞: 1, 硬币: 3 }) // 5 - 2
    expect(vm.money).toBe(120) // 100 + 50 - 30
  })

  it('数量下限钳制：lose / spend 不会让库存或金额变负', () => {
    const vm = new VM(
      buildIr(`scene: s1\nsteps:\n  - item: { get: 硬币, n: 3 }\n  - item: { lose: 硬币, n: 99 }\n  - money: { spend: 999 }\n  - end: fin\n`),
      { seed: 1 },
    )
    runToEnd(vm)
    expect(vm.inventory).toEqual({}) // 归零即从库存移除
    expect(vm.money).toBe(0)
  })

  it('物品/货币随存档序列化：读档后续跑结果一致', () => {
    const ir = buildIr(RICH)
    const a = new VM(ir, { seed: 1 })
    expect(a.next().type).toBe('text') // 唯一的阻塞事件，其后是 item/money 结算
    const b = VM.load(ir, JSON.parse(JSON.stringify(a.save())))
    runToEnd(a)
    runToEnd(b)
    expect(b.inventory).toEqual(a.inventory)
    expect(b.money).toBe(a.money)
  })
})
