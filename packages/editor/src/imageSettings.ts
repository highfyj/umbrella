import { showModal } from './modal.js'

/**
 * 生图接入配置：用 codex 作为 agent 工作流（codex exec）出图 + rembg 抠图。
 * - 命令模板占位符：{cwd}（项目根）{prompt}（完整工作流提示词，单参数不拆）{ref}（参考图绝对路径）
 * - 提示词模板（promptTemplate，即 $imagegen 工作流模板）占位符：{desc}{out}{size}{ref}；
 *   服务端逐张把 {out} 填成绝对路径，codex agent 据此把图存到该路径并输出 JSON。
 * codex exec 是 agent 工作流而非图片服务：单次较慢，生成串行（一次一个任务）。
 * provider 字段为将来接入别的生图方案预留；命令/模板均可在本对话框改写适配。
 */
export interface ImageSettings {
  provider: 'codex'
  /** 无参考图时的生图命令模板 */
  genCommand: string
  /** 带参考图时的生图命令模板（含 {ref}）；留空则忽略参考图用 genCommand */
  genCommandRef: string
  /** 工作流提示词模板（$imagegen）：{desc} 用户描述、{out} 绝对输出路径、{size} 尺寸、{ref} 参考图 */
  promptTemplate: string
  /** 抠图命令模板（{in} 输入、{out} 输出透明 PNG） */
  rembgCommand: string
  /** 抽卡次数：一次生成的候选数量（codex agent 较慢，默认 1） */
  gachaCount: number
  /** 默认出图尺寸 */
  size: string
  /** 三类流程的预置提示词（生成对话框预填到 {desc}，可现场编辑） */
  presets: {
    sprite: string
    bg: string
    base: string
  }
}

const KEY = 'vn-image-settings'

export const IMAGE_DEFAULTS: ImageSettings = {
  provider: 'codex',
  genCommand: 'codex exec --sandbox workspace-write --skip-git-repo-check -C {cwd} {prompt}',
  genCommandRef: 'codex exec --sandbox workspace-write --skip-git-repo-check -C {cwd} --image {ref} {prompt}',
  promptTemplate:
    '生成视觉小说素材：{desc}。目标尺寸约 {size}。请把生成的 PNG 图片保存到绝对路径 {out}（目录不存在则创建），完成后只输出一行 JSON：{path, prompt, notes}。',
  rembgCommand: 'rembg i {in} {out}',
  gachaCount: 1,
  size: '1024x1536',
  presets: {
    sprite:
      '视觉小说角色立绘，全身或半身，纯色/透明背景便于抠图，柔和动漫赛璐珞上色，正面站姿，高质量。角色：',
    bg: '视觉小说背景 CG，无人物，电影感构图与光影，动漫风景插画，高细节。场景：',
    base: '角色设定参考图（character sheet），三视图/多表情，统一画风，干净背景。角色：',
  },
}

export function loadImageSettings(): ImageSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<ImageSettings>
    return { ...IMAGE_DEFAULTS, ...saved, presets: { ...IMAGE_DEFAULTS.presets, ...(saved.presets ?? {}) } }
  } catch {
    return { ...IMAGE_DEFAULTS }
  }
}

export function saveImageSettings(s: ImageSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s))
}

/** 设置对话框（含 codex / rembg 可达性测试） */
export async function openImageSettings(): Promise<boolean> {
  const s = loadImageSettings()
  const result = await showModal({
    title: '生图接入设置（codex exec 工作流 + rembg）',
    submitLabel: '保存',
    fields: [
      { key: 'genCommand', label: '生图命令（无参考图）', value: s.genCommand, hint: '占位符：{cwd} 项目根、{prompt} 完整工作流提示词（单参数不拆）；codex exec 是 agent 工作流' },
      { key: 'genCommandRef', label: '生图命令（带参考图）', value: s.genCommandRef, hint: '额外占位符 {ref}（参考图绝对路径）；留空则忽略参考图' },
      { key: 'promptTemplate', label: '工作流提示词模板（$imagegen）', type: 'textarea', value: s.promptTemplate, hint: '占位符：{desc} 用户描述、{out} 绝对输出路径、{size}、{ref}；必须含 {out} 让 agent 知道存哪' },
      { key: 'rembgCommand', label: '抠图命令（rembg）', value: s.rembgCommand, hint: '占位符：{in} 输入、{out} 输出透明 PNG' },
      { key: 'size', label: '默认出图尺寸', value: s.size, placeholder: '1024x1536' },
      { key: 'gachaCount', label: '抽卡次数（候选数 1–8；codex agent 较慢，建议 1–2）', type: 'number', value: s.gachaCount },
      { key: 'presetSprite', label: '立绘预置提示词', type: 'textarea', value: s.presets.sprite },
      { key: 'presetBg', label: '背景预置提示词', type: 'textarea', value: s.presets.bg },
      { key: 'presetBase', label: '基准图预置提示词', type: 'textarea', value: s.presets.base },
    ],
    actions: [
      {
        label: '测试 codex / rembg 可达性',
        handler: async (v, statusEl) => {
          statusEl.textContent = '正在探测本地命令…'
          try {
            const r = (await (
              await fetch('/api/img/probe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ genCommand: v.genCommand, rembgCommand: v.rembgCommand }),
              })
            ).json()) as { codex: { ok: boolean; detail: string }; rembg: { ok: boolean; detail: string } }
            const line = (name: string, x: { ok: boolean; detail: string }) =>
              x.ok ? `<span class="m-ok">✓ ${name}：${esc(x.detail)}</span>` : `<span class="m-err">✗ ${name}：${esc(x.detail)}</span>`
            statusEl.innerHTML = `${line('codex', r.codex)}<br>${line('rembg', r.rembg)}`
          } catch (err) {
            statusEl.innerHTML = `<span class="m-err">探测失败：${esc(String(err))}</span>`
          }
        },
      },
    ],
    validate: (v) => {
      const n = Number(v.gachaCount)
      if (!v.genCommand.includes('{prompt}')) return '生图命令必须含 {prompt}'
      if (!v.promptTemplate.includes('{out}')) return '工作流提示词模板必须含 {out}（agent 据此保存图片）'
      if (!v.rembgCommand.includes('{in}') || !v.rembgCommand.includes('{out}')) return '抠图命令必须含 {in} 与 {out}'
      if (!Number.isFinite(n) || n < 1 || n > 8) return '抽卡次数需在 1–8 之间'
      return null
    },
  })
  if (!result) return false
  saveImageSettings({
    provider: 'codex',
    genCommand: result.genCommand.trim(),
    genCommandRef: result.genCommandRef.trim(),
    promptTemplate: result.promptTemplate.trim(),
    rembgCommand: result.rembgCommand.trim(),
    gachaCount: Math.max(1, Math.min(8, Number(result.gachaCount) || 1)),
    size: result.size.trim() || '1024x1536',
    presets: { sprite: result.presetSprite, bg: result.presetBg, base: result.presetBase },
  })
  return true
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
