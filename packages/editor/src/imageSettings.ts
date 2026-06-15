import { showModal } from './modal.js'

/**
 * 生图接入配置：目前支持本地 codex CLI（image2）+ rembg 抠图。
 * 命令为模板字符串（占位符 {prompt} {out} {ref} {size}），未知/异构 CLI 由用户改模板适配，
 * 与 TTS 的"可配置 + 可达性测试"思路一致。provider 字段为将来接入别的生图方案预留。
 */
export interface ImageSettings {
  provider: 'codex'
  /** 无参考图时的生图命令模板 */
  genCommand: string
  /** 带参考图时的生图命令模板（含 {ref}）；留空则忽略参考图用 genCommand */
  genCommandRef: string
  /** 抠图命令模板（{in} 输入、{out} 输出透明 PNG） */
  rembgCommand: string
  /** 抽卡次数：一次生成的候选数量 */
  gachaCount: number
  /** 默认出图尺寸 */
  size: string
  /** 三类流程的预置提示词（生成对话框预填，可现场编辑） */
  presets: {
    sprite: string
    bg: string
    base: string
  }
}

const KEY = 'vn-image-settings'

export const IMAGE_DEFAULTS: ImageSettings = {
  provider: 'codex',
  genCommand: 'codex image2 --size {size} --output {out} --prompt {prompt}',
  genCommandRef: 'codex image2 --size {size} --image {ref} --output {out} --prompt {prompt}',
  rembgCommand: 'rembg i {in} {out}',
  gachaCount: 4,
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
    title: '生图接入设置（codex image2 + rembg）',
    submitLabel: '保存',
    fields: [
      { key: 'genCommand', label: '生图命令（无参考图）', value: s.genCommand, hint: '占位符：{prompt} {out} {size} {n}；含空格/中文的提示词不会被拆开' },
      { key: 'genCommandRef', label: '生图命令（带参考图）', value: s.genCommandRef, hint: '额外占位符 {ref}（参考图绝对路径）；留空则忽略参考图' },
      { key: 'rembgCommand', label: '抠图命令（rembg）', value: s.rembgCommand, hint: '占位符：{in} 输入、{out} 输出透明 PNG' },
      { key: 'size', label: '默认出图尺寸', value: s.size, placeholder: '1024x1536' },
      { key: 'gachaCount', label: '抽卡次数（一次生成候选数 1–8）', type: 'number', value: s.gachaCount },
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
      if (!v.genCommand.includes('{prompt}') || !v.genCommand.includes('{out}')) return '生图命令必须含 {prompt} 与 {out}'
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
    rembgCommand: result.rembgCommand.trim(),
    gachaCount: Math.max(1, Math.min(8, Number(result.gachaCount) || 4)),
    size: result.size.trim() || '1024x1536',
    presets: { sprite: result.presetSprite, bg: result.presetBg, base: result.presetBase },
  })
  return true
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
