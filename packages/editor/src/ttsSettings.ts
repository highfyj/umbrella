import { showModal } from './modal.js'

/**
 * TTS 接入配置：目前支持 CosyVoice 本地部署（FastAPI），
 * provider 字段为将来接入其他方案（互联网 API / 别的本地引擎）预留。
 */
export interface TtsSettings {
  provider: 'cosyvoice'
  baseUrl: string
  mode: 'zero_shot' | 'sft' | 'instruct'
  zeroShotPath: string
  sftPath: string
  instructPath: string
  /** 服务返回裸 PCM 时按此采样率包装 WAV（CosyVoice2/3 通常 24000） */
  sampleRate: number
  /** 有 ffmpeg 时转 ogg（否则保存 wav，运行时同样可用） */
  toOgg: boolean
}

const KEY = 'vn-tts-settings'

export const TTS_DEFAULTS: TtsSettings = {
  provider: 'cosyvoice',
  baseUrl: 'http://localhost:50000',
  mode: 'zero_shot',
  zeroShotPath: '/inference_zero_shot',
  sftPath: '/inference_sft',
  instructPath: '/inference_instruct2',
  sampleRate: 24000,
  toOgg: true,
}

export function loadTtsSettings(): TtsSettings {
  try {
    return { ...TTS_DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<TtsSettings>) }
  } catch {
    return { ...TTS_DEFAULTS }
  }
}

export function saveTtsSettings(s: TtsSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s))
}

export function pathForMode(s: TtsSettings): string {
  return s.mode === 'zero_shot' ? s.zeroShotPath : s.mode === 'sft' ? s.sftPath : s.instructPath
}

/** 设置对话框（含可达性测试） */
export async function openTtsSettings(): Promise<boolean> {
  const s = loadTtsSettings()
  const result = await showModal({
    title: 'TTS 接入设置（CosyVoice 本地部署）',
    submitLabel: '保存',
    backdropClose: false,
    fields: [
      { key: 'baseUrl', label: '服务地址', value: s.baseUrl, placeholder: 'http://localhost:50000', hint: 'CosyVoice FastAPI 服务的根地址' },
      { key: 'mode', label: '默认生成模式', type: 'select', value: s.mode, options: ['zero_shot', 'sft', 'instruct'], hint: 'zero_shot=音色克隆（用角色音色文件）；sft=预置说话人；instruct=指令控制' },
      { key: 'zeroShotPath', label: 'zero_shot 路径', value: s.zeroShotPath },
      { key: 'sftPath', label: 'sft 路径', value: s.sftPath },
      { key: 'instructPath', label: 'instruct 路径', value: s.instructPath },
      { key: 'sampleRate', label: 'PCM 采样率', type: 'number', value: s.sampleRate, hint: '服务返回裸 PCM 时包装 WAV 用；CosyVoice2/3 通常 24000' },
      { key: 'toOgg', label: '生成后转 ogg（需本机 ffmpeg）', type: 'checkbox', value: s.toOgg },
    ],
    actions: [
      {
        label: '测试连接',
        handler: async (v, statusEl) => {
          statusEl.textContent = '正在探测…'
          try {
            const r = (await (
              await fetch('/api/tts/probe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ baseUrl: v.baseUrl }),
              })
            ).json()) as { ok: boolean; status?: number; error?: string; ffmpeg: boolean }
            statusEl.innerHTML = r.ok
              ? `<span class="m-ok">✓ 服务可达（HTTP ${r.status}）</span> · ffmpeg ${r.ffmpeg ? '可用，可转 ogg' : '不可用，将保存 wav'}`
              : `<span class="m-err">✗ 无法连接：${r.error}</span>`
          } catch (err) {
            statusEl.innerHTML = `<span class="m-err">探测失败：${String(err)}</span>`
          }
        },
      },
    ],
    validate: (v) => (/^https?:\/\//.test(v.baseUrl) ? null : '服务地址必须以 http:// 或 https:// 开头'),
  })
  if (!result) return false
  saveTtsSettings({
    provider: 'cosyvoice',
    baseUrl: result.baseUrl.replace(/\/$/, ''),
    mode: result.mode as TtsSettings['mode'],
    zeroShotPath: result.zeroShotPath,
    sftPath: result.sftPath,
    instructPath: result.instructPath,
    sampleRate: Number(result.sampleRate) || 24000,
    toOgg: result.toOgg === 'true',
  })
  return true
}
