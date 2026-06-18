import type { Op, SceneIR, Target } from '@vn/core'
import type { Diagnostics, Pos } from './diagnostics.js'
import type { NormalizedScene, Step } from './normalize.js'

/** 扁平化期间的待解析跳转：goto/jump 的目标字符串在所有场景就位后统一解析 */
interface PendingJump {
  scene: string
  opIndex: number
  target: string
  pos: Pos | null
  /** choice 选项下标；undefined 表示整个 op 是 jump 占位 */
  optionIndex?: number
}

export interface FlatScene {
  id: string
  ops: Op[]
  labels: Record<string, number>
  /** 每个 op 的源码位置（与 ops 对齐） */
  opPos: (Pos | null)[]
  file: string
}

export interface FlattenResult {
  scenes: Map<string, FlatScene>
  pending: PendingJump[]
  /** say 的语音附加信息（voiceOff/显式 id），按场景 -> op 下标 */
  sayMeta: Map<string, Map<number, { voiceOff: boolean; id: string | null; reuse: boolean }>>
}

export function flattenScenes(scenes: NormalizedScene[], diag: Diagnostics): FlattenResult {
  const out = new Map<string, FlatScene>()
  const pending: PendingJump[] = []
  const sayMetaByScene = new Map<string, Map<number, { voiceOff: boolean; id: string | null; reuse: boolean }>>()

  for (const scene of scenes) {
    const ops: Op[] = []
    const opPos: (Pos | null)[] = []
    const labels: Record<string, number> = {}
    const filePath = scene.file.path

    const push = (op: Op, pos: Pos | null): number => {
      ops.push(op)
      opPos.push(pos)
      return ops.length - 1
    }

    const emitSteps = (steps: Step[]): void => {
      for (const s of steps) emitStep(s)
    }

    const emitStep = (s: Step): void => {
      switch (s.kind) {
        case 'narrate':
          push({ op: 'narrate', text: s.text, lineId: '' }, s.pos)
          return
        case 'say':
          push({ op: 'say', who: s.who, text: s.text, face: s.face, lineId: s.id ?? '', voice: null }, s.pos)
          // voice 解析在 voice.ts 中补全；voiceOff 信息通过 sideTable 传递
          sayMeta.set(ops.length - 1, { voiceOff: s.voiceOff, id: s.id, reuse: s.reuse })
          return
        case 'text':
          push({ op: 'text', style: s.style, title: s.title, content: s.content, lineId: '' }, s.pos)
          return
        case 'shake':
          push({ op: 'shake', intensity: s.intensity, ms: s.ms }, s.pos)
          return
        case 'item':
          push({ op: 'item', id: s.id, delta: s.delta }, s.pos)
          return
        case 'money':
          push({ op: 'money', delta: s.delta }, s.pos)
          return
        case 'bg':
          push({ op: 'bg', name: s.name, transition: s.transition, duration: s.duration }, s.pos)
          return
        case 'show':
          push({ op: 'show', who: s.who, patch: s.patch, transition: s.transition }, s.pos)
          return
        case 'hide':
          push({ op: 'hide', who: s.who, transition: s.transition }, s.pos)
          return
        case 'bgm':
          push({ op: 'bgm', name: s.name, fade: s.fade }, s.pos)
          return
        case 'se':
          push({ op: 'se', name: s.name }, s.pos)
          return
        case 'wait':
          push({ op: 'wait', ms: s.ms }, s.pos)
          return
        case 'set':
          push({ op: 'set', assigns: s.assigns }, s.pos)
          return
        case 'end':
          push({ op: 'end', ending: s.ending }, s.pos)
          return
        case 'label':
          if (labels[s.name] !== undefined) {
            diag.error('dup-label', `label "${s.name}" 重复定义`, filePath, s.pos)
          } else {
            labels[s.name] = ops.length
          }
          return
        case 'jump': {
          const i = push({ op: 'goto', to: -1 }, s.pos)
          pending.push({ scene: scene.id, opIndex: i, target: s.target, pos: s.pos })
          return
        }
        case 'if': {
          const j = push({ op: 'jumpIfNot', expr: s.expr, to: -1 }, s.pos) // 占位
          emitSteps(s.then)
          if (s.else.length) {
            const g = push({ op: 'goto', to: -1 }, s.pos)
            ;(ops[j] as { to: number }).to = ops.length
            emitSteps(s.else)
            ;(ops[g] as { to: number }).to = ops.length
          } else {
            ;(ops[j] as { to: number }).to = ops.length
          }
          return
        }
        case 'random': {
          const r = push({ op: 'random', branches: s.branches.map((b) => ({ weight: b.weight, to: -1 })) }, s.pos)
          const exits: number[] = []
          s.branches.forEach((b, bi) => {
            ;((ops[r] as { branches: { to: number }[] }).branches)[bi].to = ops.length
            if (b.steps) {
              emitSteps(b.steps)
              exits.push(push({ op: 'goto', to: -1 }, b.pos))
            } else {
              const i = push({ op: 'goto', to: -1 }, b.pos)
              pending.push({ scene: scene.id, opIndex: i, target: b.goto!, pos: b.pos })
            }
          })
          const after = ops.length
          for (const e of exits) (ops[e] as { to: number }).to = after
          return
        }
        case 'choice': {
          const i = push(
            {
              op: 'choice',
              options: s.options.map((o) => ({
                text: o.text,
                if: o.if,
                set: o.set,
                target: o.goto === null ? null : { to: -1 },
              })),
            },
            s.pos,
          )
          s.options.forEach((o, oi) => {
            if (o.goto !== null) {
              pending.push({ scene: scene.id, opIndex: i, target: o.goto, pos: o.pos, optionIndex: oi })
            }
          })
          return
        }
      }
    }

    const sayMeta = new Map<number, { voiceOff: boolean; id: string | null; reuse: boolean }>()
    emitSteps(scene.steps)
    out.set(scene.id, { id: scene.id, ops, labels, opPos, file: filePath })
    sayMetaByScene.set(scene.id, sayMeta)
  }

  return { scenes: out, pending, sayMeta: sayMetaByScene }
}

/** 解析待定跳转：本场景 label 优先，其次场景 id */
export function linkJumps(result: FlattenResult, diag: Diagnostics): void {
  for (const pj of result.pending) {
    const scene = result.scenes.get(pj.scene)!
    const local = scene.labels[pj.target]
    const isScene = result.scenes.has(pj.target)
    let target: Target | null = null
    if (local !== undefined && isScene) {
      diag.error('ambiguous-jump', `跳转目标 "${pj.target}" 既是本场景 label 又是场景 id`, scene.file, pj.pos)
      continue
    }
    if (local !== undefined) target = { to: local }
    else if (isScene) target = { scene: pj.target, to: 0 }
    else {
      diag.error('dangling-jump', `跳转目标 "${pj.target}" 不存在（既不是本场景 label 也不是场景 id）`, scene.file, pj.pos)
      continue
    }

    const op = scene.ops[pj.opIndex]
    if (pj.optionIndex !== undefined && op.op === 'choice') {
      op.options[pj.optionIndex].target = target
    } else if (op.op === 'goto') {
      if (target.scene) {
        scene.ops[pj.opIndex] = { op: 'jump', scene: target.scene, to: target.to }
      } else {
        op.to = target.to
      }
    }
  }
}

export function toSceneIR(f: FlatScene): SceneIR {
  return { ops: f.ops, labels: f.labels }
}
