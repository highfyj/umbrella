import type { StoryIR } from '@vn/core'
import type { SpriteFlowResult } from './checks.js'
import type { VoiceLine } from './voice.js'

function csv(rows: string[][]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  // BOM 让 Excel 正确识别 UTF-8
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\n') + '\n'
}

/** 录音台本：按角色分组，带前后文与情绪标注 */
export function exportVoiceScript(ir: StoryIR, lines: VoiceLine[]): string {
  const context = (sceneId: string, opIndex: number, dir: -1 | 1): string => {
    const ops = ir.scenes[sceneId]?.ops ?? []
    for (let i = opIndex + dir; i >= 0 && i < ops.length; i += dir) {
      const op = ops[i]
      if (op.op === 'say') return `${op.who}：${op.text}`
      if (op.op === 'narrate') return op.text
    }
    return ''
  }

  const rows: string[][] = [['角色', '语音ID', '情绪', '台词', '前文', '后文', '场景', '状态']]
  const sorted = [...lines].sort((a, b) => a.who.localeCompare(b.who, 'zh') || a.id.localeCompare(b.id))
  for (const l of sorted) {
    rows.push([
      l.who,
      l.id,
      l.face ?? '',
      l.text,
      context(l.sceneId, l.opIndex, -1),
      context(l.sceneId, l.opIndex, 1),
      l.sceneId,
      l.missing ? '待录' : l.stale ? '已改稿需重录' : '已录',
    ])
  }
  return csv(rows)
}

/** 立绘生成清单：可达但缺图的维度组合（= AI 出图工作列表） */
export function exportSpriteChecklist(ir: StoryIR, sprites: SpriteFlowResult): string {
  const rows: string[][] = [['角色', 'outfit', 'state', 'face', '首次出现场景', '位置', '上下文']]
  for (const d of sprites.missing) {
    const ops = ir.scenes[d.scene]?.ops ?? []
    let ctx = ''
    for (const op of ops) {
      if (op.op === 'say' && op.who === d.who) {
        ctx = op.text
        break
      }
    }
    rows.push([
      d.who,
      d.outfit,
      d.state.join('+') || '（无）',
      d.face,
      d.scene,
      d.pos ? `${d.scene}.yaml:${d.pos.line}` : '',
      ctx,
    ])
  }
  return csv(rows)
}
