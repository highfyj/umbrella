import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import type { Diagnostics } from './diagnostics.js'
import type { FlattenResult } from './flatten.js'
import type { ProjectFiles } from './project.js'
import type { Registry } from './registry.js'

export interface VoiceLine {
  sceneId: string
  opIndex: number
  who: string
  text: string
  face: string | null
  id: string
  file: string
  missing: boolean
  stale: boolean
  durationMs: number | null
}

interface LockEntry {
  text_hash?: string
  file?: string
  duration_ms?: number
}

export function textHash(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 12)
}

/**
 * 语音解析：填充 say op 的 voice/lineId，三向核对 voice.lock。
 * 全部是警告/提示——缺语音由占位（静音+字数估时）兜底。
 */
export function resolveVoice(
  flat: FlattenResult,
  reg: Registry,
  files: ProjectFiles,
  diag: Diagnostics,
): VoiceLine[] {
  const lockSrc = files.read('voice.lock')
  let lock: Record<string, LockEntry> = {}
  if (lockSrc !== null) {
    try {
      lock = (parseYaml(lockSrc) ?? {}) as Record<string, LockEntry>
    } catch {
      diag.warn('bad-voice-lock', 'voice.lock 解析失败，忽略', 'voice.lock')
    }
  }

  const lines: VoiceLine[] = []
  const owners = new Map<string, string>() // id -> "scene:op"，自有 id 查重
  const idsByScene = new Map<string, Set<string>>()

  for (const sc of flat.scenes.values()) {
    const meta = flat.sayMeta.get(sc.id)
    sc.ops.forEach((op, i) => {
      if (op.op !== 'say') return
      const m = meta?.get(i) ?? { voiceOff: false, id: null, reuse: false }
      const ch = reg.characters.get(op.who)
      const voiced = (ch?.voiced ?? true) && !m.voiceOff
      const fallbackLineId = `${sc.id}#${i}`

      if (!voiced) {
        op.lineId = fallbackLineId
        op.voice = null
        return
      }
      if (!m.id) {
        diag.warn('voice-no-id', `配音台词缺少语音 id（运行 assign-ids 自动分配）`, sc.file, sc.opPos[i])
        op.lineId = fallbackLineId
        op.voice = null
        return
      }

      const id = m.id
      if (!m.reuse) {
        const owner = owners.get(id)
        if (owner) {
          diag.error('dup-voice-id', `语音 id "${id}" 重复（已被 ${owner} 占用）`, sc.file, sc.opPos[i])
        } else {
          owners.set(id, `${sc.id}:${i}`)
        }
      }

      // 文件按约定路径绑定：voice/<id 的场景前缀部分>/<id>.ogg
      const dir = id.replace(/_\d+$/, '')
      const file = `voice/${dir}/${id}.ogg`
      const missing = !files.exists(file)
      const entry = lock[id]
      let stale = false
      if (missing) {
        diag.warn('voice-missing-audio', `语音 ${id} 的音频文件不存在（${file}），将静音占位`, sc.file, sc.opPos[i])
      } else if (entry?.text_hash && !m.reuse && entry.text_hash !== textHash(op.text)) {
        stale = true
        diag.warn('voice-stale-text', `语音 ${id} 的台词在录音后被修改过，需要重录`, sc.file, sc.opPos[i])
      }

      op.lineId = m.reuse ? fallbackLineId : id
      op.voice = { id, file, durationMs: entry?.duration_ms ?? null, missing }

      if (!m.reuse) {
        let set = idsByScene.get(dir)
        if (!set) {
          set = new Set()
          idsByScene.set(dir, set)
        }
        set.add(id)
        lines.push({
          sceneId: sc.id, opIndex: i, who: op.who, text: op.text, face: op.face,
          id, file, missing, stale, durationMs: entry?.duration_ms ?? null,
        })
      }
    })
  }

  // 孤儿音频：voice/<scene>/ 下没有对应台词的文件
  for (const [dir, ids] of idsByScene) {
    for (const f of files.list(`voice/${dir}`)) {
      const base = f.replace(/\.[a-z0-9]+$/i, '')
      if (!ids.has(base)) {
        diag.info('voice-orphan', `音频文件 voice/${dir}/${f} 没有对应的台词`, `voice/${dir}/${f}`)
      }
    }
  }

  return lines
}
