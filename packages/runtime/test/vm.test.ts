import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { StoryIR } from '@vn/core'
import { NodeFiles, compileProject } from '@vn/compiler'
import { VM, type VMEvent } from '@vn/runtime'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const ir: StoryIR = compileProject(new NodeFiles(repoRoot)).ir!

/** 跑完整个剧情：按选项文本匹配做选择，返回全部事件 */
function playthrough(vm: VM, choose: (texts: string[]) => number): VMEvent[] {
  const events: VMEvent[] = []
  for (let i = 0; i < 1000; i++) {
    const e = vm.next()
    events.push(e)
    if (e.type === 'end') return events
    if (e.type === 'choice') vm.choose(e.options[choose(e.options.map((o) => o.text))].index)
  }
  throw new Error('1000 步未到结局')
}

const pick = (...wants: string[]) => (texts: string[]) => {
  for (const w of wants) {
    const i = texts.findIndex((t) => t.includes(w))
    if (i >= 0) return i
  }
  return 0
}

describe('VM 剧情运行', () => {
  it('带伞 + 一起走 → good_ending，且好感差分台词出现', () => {
    const vm = new VM(ir, { seed: 42 })
    const events = playthrough(vm, pick('带上折叠伞', '一起走'))
    const end = events.at(-1)!
    expect(end).toMatchObject({ type: 'end', ending: 'good_ending' })
    const texts = events.filter((e) => e.type === 'line').map((e) => (e as { text: string }).text)
    expect(texts.some((t) => t.includes('就算不下雨'))).toBe(true) // favor >= 1 的差分
  })

  it('不带伞时"一起走"选项不可见，先走 → normal_ending', () => {
    const vm = new VM(ir, { seed: 7 })
    const events = playthrough(vm, pick('应该不会下吧', '先走一步'))
    const choiceEvents = events.filter((e) => e.type === 'choice')
    const branchChoice = choiceEvents[1] as Extract<VMEvent, { type: 'choice' }>
    expect(branchChoice.options.map((o) => o.text).join('')).not.toContain('一起走')
    expect(events.at(-1)).toMatchObject({ type: 'end', ending: 'normal_ending' })
  })

  it('label 支线：再坐一会儿 → favor+1 → normal_ending 带差分', () => {
    const vm = new VM(ir, { seed: 7 })
    const events = playthrough(vm, pick('应该不会下吧', '再坐一会儿'))
    const texts = events.filter((e) => e.type === 'line').map((e) => (e as { text: string }).text)
    expect(texts.some((t) => t.includes('下雨天也不坏'))).toBe(true)
    expect(texts.some((t) => t.includes('聊得还算开心'))).toBe(true) // favor >= 1 差分
    expect(events.at(-1)).toMatchObject({ type: 'end', ending: 'normal_ending' })
  })

  it('语音与占位：配音台词带 voice 引用且标记缺失', () => {
    const vm = new VM(ir, { seed: 1 })
    const events = playthrough(vm, pick('带上折叠伞', '一起走'))
    const said = events.find((e) => e.type === 'line' && (e as { lineId: string }).lineId === 'ch01_0010') as Extract<VMEvent, { type: 'line' }>
    expect(said.voice).toMatchObject({ id: 'ch01_0010', missing: true })
    const narr = events.find((e) => e.type === 'line' && (e as { lineKind: string }).lineKind === 'narrate') as Extract<VMEvent, { type: 'line' }>
    expect(narr.voice).toBeNull()
  })

  it('立绘维度更新：淋湿后的 show 解析到湿身变体', () => {
    const vm = new VM(ir, { seed: 1 })
    const events = playthrough(vm, pick('带上折叠伞', '一起走'))
    const shows = events.flatMap((e) => e.effects.filter((f) => f.kind === 'show'))
    expect(shows.map((s) => (s as { sprite: { combo: string } }).sprite.combo)).toContain('校服|淋湿|微笑')
  })

  it('确定性：相同种子 + 相同选择 → 完全一致的事件流', () => {
    const run = () => {
      const vm = new VM(ir, { seed: 12345 })
      return JSON.stringify(playthrough(vm, pick('应该不会下吧', '先走一步')))
    }
    expect(run()).toBe(run())
  })

  it('随机权重：favor=0 时"想起她的背影"分支绝不触发', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const vm = new VM(ir, { seed })
      const events = playthrough(vm, pick('应该不会下吧', '先走一步'))
      const texts = events.filter((e) => e.type === 'line').map((e) => (e as { text: string }).text)
      expect(texts.some((t) => t.includes('想起她跑开时的背影'))).toBe(false)
    }
  })

  it('存档/读档：在分支点存档，恢复后走向不同结局', () => {
    const vm = new VM(ir, { seed: 99 })
    let save: string | null = null
    for (;;) {
      const e = vm.next()
      if (e.type === 'choice') {
        if (e.options.some((o) => o.text.includes('一起走'))) {
          save = JSON.stringify(vm.save())
          vm.choose(e.options.find((o) => o.text.includes('一起走'))!.index)
        } else {
          vm.choose(e.options.find((o) => o.text.includes('带上折叠伞'))!.index)
        }
      }
      if (e.type === 'end') {
        expect(e.ending).toBe('good_ending')
        break
      }
    }
    // 读档，这次选先走 → normal_ending
    const vm2 = VM.load(ir, JSON.parse(save!))
    const events = playthrough(vm2, pick('先走一步'))
    expect(events.at(-1)).toMatchObject({ type: 'end', ending: 'normal_ending' })
  })

  it('PRNG 状态进存档：读档后的随机序列与原 VM 一致', () => {
    const vm = new VM(ir, { seed: 555 })
    vm.next()
    const save = vm.save()
    const vm2 = VM.load(ir, save)
    const a = JSON.stringify(playthrough(vm, pick('应该不会下吧', '再坐一会儿')))
    const b = JSON.stringify(playthrough(vm2, pick('应该不会下吧', '再坐一会儿')))
    expect(a).toBe(b)
  })
})
