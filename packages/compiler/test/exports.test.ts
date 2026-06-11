import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NodeFiles, compileProject, exportSpriteChecklist, exportVoiceScript, assignVoiceIds } from '@vn/compiler'
import { minimalProject } from './fixtures.js'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

describe('录音台本导出', () => {
  it('包含全部配音台词与上下文', () => {
    const r = compileProject(new NodeFiles(repoRoot))
    const csvText = exportVoiceScript(r.ir!, r.voiceLines)
    const lines = csvText.trim().split('\n')
    expect(lines).toHaveLength(1 + 6)
    expect(csvText).toContain('ch01_0010')
    expect(csvText).toContain('你还不回家吗？')
    expect(csvText).toContain('赌气') // 情绪标注来自 face
    expect(csvText).toContain('待录')
  })
})

describe('立绘生成清单导出', () => {
  it('缺图组合进清单', () => {
    const r = compileProject(
      minimalProject({
        'story/scenes/s1.yaml': `
scene: s1
steps:
  - show: { who: 甲, state: 淋湿, face: 笑 }
  - end: fin
`,
      }),
    )
    const csvText = exportSpriteChecklist(r.ir!, r.sprites!)
    expect(csvText).toContain('淋湿')
    expect(csvText).toContain('笑')
  })

  it('样例剧本无缺失组合', () => {
    const r = compileProject(new NodeFiles(repoRoot))
    const csvText = exportSpriteChecklist(r.ir!, r.sprites!)
    expect(csvText.trim().split('\n')).toHaveLength(1) // 只有表头
  })
})

describe('assign-ids', () => {
  it('给缺 id 的配音台词按步长 10 分配并写回，跳过 voice:false 与无语音角色', () => {
    const files = minimalProject({
      'story/scenes/s1.yaml': `scene: s1
steps:
  - 甲: "第一句。"
  - 乙: "主角不配音。"
  - 甲: "已有编号。"
    id: s1_0020
  - 甲: "嘟囔。"
    voice: false
  - 甲: "插在中间。"
  - 甲: "最后一句。"
  - end: fin
`,
    })
    const r = assignVoiceIds(files)
    expect(r.errors).toEqual([])
    const ids = r.assigned.map((a) => a.id)
    expect(ids).toContain('s1_0010') // 第一句：0 与 0020 的间隙
    expect(ids).toContain('s1_0030') // 插在中间：0020 之后
    expect(ids).toContain('s1_0040')
    expect(r.assigned).toHaveLength(3)
    const content = r.changes.get('story/scenes/s1.yaml')!
    expect(content).toContain('id: s1_0010')
    expect(content).not.toMatch(/乙:.*\n\s+id:/) // 乙 不配音，不分配
    // 写回后的文件能正常编译
    files.map.set('story/scenes/s1.yaml', content)
    const compiled = compileProject(files)
    expect(compiled.diagnostics.errors).toEqual([])
    expect(compiled.voiceLines.map((l) => l.id).sort()).toEqual(['s1_0010', 's1_0020', 's1_0030', 's1_0040'])
  })

  it('嵌套在 if/random 里的台词也能分配', () => {
    const files = minimalProject({
      'story/scenes/s1.yaml': `scene: s1
steps:
  - if: "flag"
    then:
      - 甲: "条件内台词。"
  - random:
      - weight: 1
        then:
          - 甲: "随机内台词。"
  - end: fin
`,
    })
    const r = assignVoiceIds(files)
    expect(r.errors).toEqual([])
    expect(r.assigned).toHaveLength(2)
  })
})
