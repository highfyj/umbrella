/** 素材导入流程：OS 拖入或浏览本机选中 → 预览确认 + 改名 → 拷入项目（必要时注册由调用方完成） */

import { showModal } from './modal.js'
import { isAudioExt, isImageExt } from './fsBrowser.js'

export type ImportSource =
  | { kind: 'blob'; file: File } // 从 OS 拖入浏览器
  | { kind: 'local'; path: string } // 服务端文件浏览器选中的本机绝对路径

export interface ImportCategory {
  key: string
  label: string
  dir: string
  /** 是否在 assets.yaml 里有注册表（背景/BGM/音效） */
  registrable: boolean
}

const IMAGE_CATEGORIES: ImportCategory[] = [
  { key: 'bg', label: '背景', dir: 'bg/', registrable: true },
  { key: 'sprite', label: '立绘（导入后右键注册变体）', dir: 'sprite/', registrable: false },
  { key: 'refs', label: '参考图（编辑素材）', dir: 'production/refs/', registrable: false },
]

const AUDIO_CATEGORIES: ImportCategory[] = [
  { key: 'bgm', label: 'BGM', dir: 'bgm/', registrable: true },
  { key: 'se', label: '音效', dir: 'se/', registrable: true },
  { key: 'tts', label: '音色样本（编辑素材）', dir: 'production/tts/', registrable: false },
]

export interface ImportOutcome {
  /** 项目内相对路径（服务端处理重名后实际写入的位置） */
  path: string
  category: ImportCategory
  /** 用户填写的注册名；空 = 只拷贝不注册 */
  registerName: string
}

export function sanitizeFileName(name: string): string {
  return name.replace(/\s+/g, '_').replace(/[^\w.一-鿿-]/g, '_')
}

function sourceName(src: ImportSource): string {
  return src.kind === 'blob' ? src.file.name : src.path.split('/').pop()!
}

function previewHtml(src: ImportSource): string {
  const name = sourceName(src)
  const url =
    src.kind === 'blob'
      ? URL.createObjectURL(src.file)
      : `/api/fs/file?path=${encodeURIComponent(src.path)}&t=${Date.now()}`
  if (isImageExt(name)) return `<img class="imp-preview" src="${url}" alt="">`
  if (isAudioExt(name)) return `<audio class="imp-preview" controls src="${url}"></audio>`
  return ''
}

/**
 * 单个文件的导入确认框：分类 + 目标路径（自动改名，可改）+ 注册名 + 预览。
 * 确认后写入项目；注册写回 YAML 由调用方根据返回值完成。
 */
export async function importAssetFlow(src: ImportSource, defaultCategoryKey?: string): Promise<ImportOutcome | null> {
  const name = sourceName(src)
  const image = isImageExt(name)
  const audio = isAudioExt(name)
  if (!image && !audio) {
    alert(`不支持的素材类型：${name}（支持图片 png/jpg/webp/gif 与音频 ogg/mp3/wav/m4a）`)
    return null
  }
  const categories = image ? IMAGE_CATEGORIES : AUDIO_CATEGORIES
  const initial = categories.find((c) => c.key === defaultCategoryKey) ?? categories[0]
  const clean = sanitizeFileName(name)
  const byLabel = new Map(categories.map((c) => [c.label, c]))

  const v = await showModal({
    title: `导入素材：${name}`,
    bodyHtml: previewHtml(src),
    submitLabel: '导入',
    fields: [
      { key: 'category', label: '分类', type: 'select', value: initial.label, options: categories.map((c) => c.label) },
      {
        key: 'to', label: '目标路径（项目内，可改名/加子目录）', value: initial.dir + clean,
        hint: initial.key === 'sprite' ? '立绘建议放角色子目录，如 sprite/xiaoman/xxx.png' : '重名时自动追加 _2、_3…',
      },
      ...(categories.some((c) => c.registrable)
        ? [{ key: 'name', label: '注册名（脚本中引用；留空 = 只拷贝暂不注册）', value: clean.replace(/\.[^.]+$/, '') }]
        : []),
    ],
    onChange: (key, values, ui) => {
      if (key !== 'category') return
      const cat = byLabel.get(values.category) ?? categories[0]
      // 切分类时把目标路径的目录前缀换掉，保留用户已改的文件名部分
      const file = values.to.split('/').pop() || clean
      ui.setField('to', cat.dir + file)
    },
    validate: (values) => {
      const cat = byLabel.get(values.category) ?? categories[0]
      if (!values.to.startsWith(cat.dir)) return `目标路径需以 ${cat.dir} 开头`
      if (values.to.includes('..') || values.to.endsWith('/')) return '目标路径无效'
      return null
    },
  })
  if (!v) return null
  const category = byLabel.get(v.category) ?? categories[0]

  let r: { ok?: boolean; path?: string; error?: string }
  if (src.kind === 'blob') {
    r = (await (
      await fetch(`/api/asset/import?to=${encodeURIComponent(v.to)}`, { method: 'POST', body: src.file })
    ).json()) as typeof r
  } else {
    r = (await (
      await fetch('/api/asset/import-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ src: src.path, to: v.to }),
      })
    ).json()) as typeof r
  }
  if (!r.ok || !r.path) {
    alert(`导入失败：${r.error ?? '未知错误'}`)
    return null
  }
  return { path: r.path, category, registerName: category.registrable ? (v.name ?? '').trim() : '' }
}
