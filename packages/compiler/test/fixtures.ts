import { MemoryFiles } from '@vn/compiler'

/** 最小可编译项目，测试在此基础上覆盖/增删文件 */
export function minimalProject(overrides: Record<string, string | null> = {}): MemoryFiles {
  const base: Record<string, string> = {
    'story/story.yaml': `
title: 测试
entry: s1
vars:
  flag: false
  n: 0
endings:
  fin: { title: 完 }
`,
    'story/characters.yaml': `
characters:
  甲:
    voiced: true
    sprite:
      dims:
        outfit: [常服]
        state: [淋湿]
        face: [默认, 笑]
      default: { outfit: 常服, face: 默认 }
      variants:
        - { outfit: 常服, face: 默认, file: a/normal.png }
  乙:
    voiced: false
`,
    'story/assets.yaml': `
backgrounds:
  房间: bg/room.jpg
bgm:
  主题: bgm/main.ogg
se:
  雷: se/thunder.ogg
`,
    'story/scenes/s1.yaml': `
scene: s1
steps:
  - bg: 房间
  - "旁白一句。"
  - show: 甲
  - 甲: "你好。"
    id: s1_0010
  - end: fin
`,
  }
  const merged: Record<string, string> = { ...base }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete merged[k]
    else merged[k] = v
  }
  return MemoryFiles.from(merged)
}
