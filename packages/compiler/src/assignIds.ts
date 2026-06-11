import { Document, Pair, Scalar, isMap, isScalar, isSeq } from 'yaml'
import { Diagnostics } from './diagnostics.js'
import { parseFile, type ProjectFiles } from './project.js'
import { buildRegistry } from './registry.js'

export interface AssignResult {
  /** path -> 重写后的文件内容（只含有改动的文件） */
  changes: Map<string, string>
  assigned: Array<{ scene: string; id: string; text: string }>
  errors: string[]
}

const ID_STEP = 10

/**
 * 给缺少语音 id 的配音台词自动分配 id 并写回 YAML（保留注释与结构）。
 * 分配策略：步长 10；插入行取前后已有编号的间隙；编号永不复用。
 */
export function assignVoiceIds(files: ProjectFiles): AssignResult {
  const result: AssignResult = { changes: new Map(), assigned: [], errors: [] }
  const diag = new Diagnostics()

  const story = parseFile(files, 'story/story.yaml')
  const characters = parseFile(files, 'story/characters.yaml')
  const assets = parseFile(files, 'story/assets.yaml')
  if (!story || !characters || !assets) {
    result.errors.push('缺少 story/story.yaml、characters.yaml 或 assets.yaml')
    return result
  }
  const reg = buildRegistry(story, characters, assets, diag)

  for (const f of files.list('story/scenes').filter((n) => n.endsWith('.yaml') || n.endsWith('.yml'))) {
    const path = `story/scenes/${f}`
    const pf = parseFile(files, path)
    if (!pf) continue
    const sceneId = f.replace(/\.ya?ml$/, '')
    const root = pf.doc.contents
    if (!isMap(root)) continue
    const steps = root.get('steps', true)
    if (!isSeq(steps)) continue

    // 文档顺序收集所有配音 say 映射
    type Entry = { map: { items: Pair[] }; text: string; existing: number | null }
    const entries: Entry[] = []
    const visitSteps = (seq: { items: unknown[] }): void => {
      for (const item of seq.items) {
        if (!isMap(item)) continue
        const keys = item.items
          .map((p) => (isScalar(p.key) ? String(p.key.value) : ''))
          .filter(Boolean)
        // 嵌套结构递归
        for (const sub of ['then', 'else']) {
          const node = item.get(sub, true)
          if (isSeq(node)) visitSteps(node as { items: unknown[] })
        }
        for (const sub of ['random']) {
          const node = item.get(sub, true)
          if (isSeq(node)) {
            for (const branch of (node as { items: unknown[] }).items) {
              if (isMap(branch)) {
                const then = branch.get('then', true)
                if (isSeq(then)) visitSteps(then as { items: unknown[] })
              }
            }
          }
        }
        const first = keys[0]
        if (!first) continue
        const who = first.includes('@') ? first.slice(0, first.indexOf('@')) : first
        const ch = reg.characters.get(who)
        if (!ch) continue
        const js = (item as { toJSON(): Record<string, unknown> }).toJSON()
        if (typeof js[first] !== 'string') continue
        if (js.voice === false || typeof js.voice === 'string') continue
        if (ch.voiced === false) continue
        const existing = typeof js.id === 'string' ? parseIdNum(js.id, sceneId) : null
        entries.push({ map: item as unknown as { items: Pair[] }, text: js[first] as string, existing })
      }
    }
    visitSteps(steps as { items: unknown[] })

    // 分配间隙编号
    let changed = false
    const nums = entries.map((e) => e.existing)
    for (let i = 0; i < entries.length; i++) {
      if (nums[i] !== null) continue
      let prev = 0
      for (let j = i - 1; j >= 0; j--) {
        if (nums[j] !== null) {
          prev = nums[j]!
          break
        }
      }
      let next = Infinity
      for (let j = i + 1; j < entries.length; j++) {
        if (nums[j] !== null) {
          next = nums[j]!
          break
        }
      }
      let candidate: number
      if (next === Infinity) candidate = prev + ID_STEP
      else if (next - prev > 1) candidate = Math.min(prev + ID_STEP, prev + Math.floor((next - prev) / 2))
      else {
        result.errors.push(`${path}: 第 ${i + 1} 句配音台词在编号 ${prev} 与 ${next} 之间没有可用编号，需要手动重排`)
        continue
      }
      nums[i] = candidate
      const id = `${sceneId}_${String(candidate).padStart(4, '0')}`
      entries[i].map.items.splice(1, 0, pf.doc.createPair('id', id) as Pair)
      result.assigned.push({ scene: sceneId, id, text: entries[i].text })
      changed = true
    }

    if (changed) result.changes.set(path, pf.doc.toString())
  }

  return result
}

function parseIdNum(id: string, sceneId: string): number | null {
  const m = new RegExp(`^${escapeRe(sceneId)}_(\\d+)$`).exec(id)
  return m ? parseInt(m[1], 10) : null
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type { Document }
