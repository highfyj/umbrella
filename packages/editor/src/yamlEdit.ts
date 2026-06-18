import { parseDocument, YAMLSeq } from 'yaml'
import { comboKey } from '@vn/core'
import type { editor as monacoEditor } from 'monaco-editor'

type Model = monacoEditor.ITextModel

/**
 * 对 YAML model 做结构化编辑（保留注释），整体替换文本以保持 Monaco undo 栈。
 * 注册类动作（写 assets.yaml / characters.yaml）都走这里。
 */
export function editYamlModel(model: Model, mutate: (doc: ReturnType<typeof parseDocument>) => void): void {
  const doc = parseDocument(model.getValue())
  mutate(doc)
  const next = doc.toString()
  if (next === model.getValue()) return
  model.pushEditOperations(
    [],
    [{ range: model.getFullModelRange(), text: next }],
    () => null,
  )
}

/** assets.yaml：注册背景/BGM/SE */
export function registerAsset(model: Model, kind: 'backgrounds' | 'bgm' | 'se', name: string, file: string): void {
  editYamlModel(model, (doc) => {
    doc.setIn([kind, name], file)
  })
}

/** characters.yaml：给角色追加立绘变体（file 为 sprite/ 下的相对路径） */
export function registerVariant(
  model: Model,
  char: string,
  v: { outfit: string; state: string[]; face: string; file: string },
): void {
  editYamlModel(model, (doc) => {
    const entry: Record<string, unknown> = { outfit: v.outfit, face: v.face }
    if (v.state.length) entry.state = v.state.length === 1 ? v.state[0] : v.state
    entry.file = v.file.replace(/^sprite\//, '')
    const path = ['characters', char, 'sprite', 'variants']
    const seq = doc.getIn(path)
    const node = doc.createNode(entry)
    ;(node as { flow?: boolean }).flow = true
    if (seq instanceof YAMLSeq) seq.add(node)
    else doc.setIn(path, doc.createNode([entry]))
  })
}

/** characters.yaml：新增角色 */
export function addCharacter(model: Model, c: { name: string; color?: string; voiced: boolean }): void {
  editYamlModel(model, (doc) => {
    if (doc.getIn(['characters', c.name]) !== undefined) return
    const def: Record<string, unknown> = {}
    if (c.color) def.color = c.color
    if (!c.voiced) def.voiced = false
    doc.setIn(['characters', c.name], doc.createNode(def))
  })
}

/** characters.yaml：确保角色有 sprite.default（注册首个变体时需要） */
export function ensureSpriteDefault(model: Model, char: string, outfit: string, face: string): void {
  editYamlModel(model, (doc) => {
    if (doc.getIn(['characters', char, 'sprite', 'default']) !== undefined) return
    const node = doc.createNode({ outfit, face })
    ;(node as { flow?: boolean }).flow = true
    doc.setIn(['characters', char, 'sprite', 'default'], node)
  })
}

/** characters.yaml：关联 AI 出图参考立绘 */
export function addRef(model: Model, char: string, path: string): void {
  editYamlModel(model, (doc) => {
    const p = ['characters', char, 'production', 'refs']
    const seq = doc.getIn(p)
    if (seq instanceof YAMLSeq) {
      if (!seq.items.some((i) => (i as { value?: unknown }).value === path)) seq.add(doc.createNode(path))
    } else {
      doc.setIn(p, doc.createNode([path]))
    }
  })
}

/** characters.yaml：设置 TTS 音色参考音频 */
export function setTtsSample(model: Model, char: string, samplePath: string): void {
  editYamlModel(model, (doc) => {
    doc.setIn(['characters', char, 'production', 'tts', 'sample'], samplePath)
  })
}

/** assets.yaml：移除背景/BGM/SE 注册条目 */
export function removeAsset(model: Model, kind: 'backgrounds' | 'bgm' | 'se', name: string): void {
  editYamlModel(model, (doc) => {
    doc.deleteIn([kind, name])
  })
}

/** characters.yaml：按 comboKey 移除立绘变体条目 */
export function removeVariant(model: Model, char: string, combo: string): void {
  editYamlModel(model, (doc) => {
    const seq = doc.getIn(['characters', char, 'sprite', 'variants'])
    if (!(seq instanceof YAMLSeq)) return
    const idx = seq.items.findIndex((item) => {
      const v = ((item as { toJSON?: () => unknown }).toJSON?.() ?? {}) as { outfit?: string; state?: string | string[]; face?: string }
      const state = Array.isArray(v.state) ? v.state : v.state ? [v.state] : []
      return comboKey(v.outfit ?? '', state, v.face ?? '') === combo
    })
    if (idx >= 0) seq.delete(idx)
  })
}

/** characters.yaml：解除参考图与角色的关联 */
export function removeRef(model: Model, char: string, path: string): void {
  editYamlModel(model, (doc) => {
    const p = ['characters', char, 'production', 'refs']
    const seq = doc.getIn(p)
    if (!(seq instanceof YAMLSeq)) return
    const idx = seq.items.findIndex((i) => (i as { value?: unknown }).value === path)
    if (idx >= 0) seq.delete(idx)
    if (!seq.items.length) doc.deleteIn(p)
  })
}

/** characters.yaml：清除角色的 TTS 音色文件引用（provider/params 保留） */
export function clearTtsSample(model: Model, char: string): void {
  editYamlModel(model, (doc) => {
    doc.deleteIn(['characters', char, 'production', 'tts', 'sample'])
  })
}

/** items.yaml：新增/更新物品条目（image 为 item/ 下的相对文件名，去掉 item/ 前缀） */
export function upsertItem(
  model: Model,
  item: { id: string; name?: string; desc?: string; image?: string; max?: number },
): void {
  editYamlModel(model, (doc) => {
    const def: Record<string, unknown> = {}
    if (item.name) def.name = item.name
    if (item.desc) def.desc = item.desc
    if (item.image) def.image = item.image.replace(/^item\//, '')
    if (typeof item.max === 'number') def.max = item.max
    doc.setIn(['items', item.id], doc.createNode(def))
  })
}

/** items.yaml：只改某个物品的单个字段（配图/说明等），保留其余字段 */
export function setItemField(model: Model, id: string, field: 'name' | 'desc' | 'image' | 'max', value: string | number | undefined): void {
  editYamlModel(model, (doc) => {
    if (doc.getIn(['items', id]) === undefined) return
    if (value === undefined || value === '') doc.deleteIn(['items', id, field])
    else doc.setIn(['items', id, field], field === 'image' ? String(value).replace(/^item\//, '') : value)
  })
}

/** items.yaml：移除物品条目 */
export function removeItem(model: Model, id: string): void {
  editYamlModel(model, (doc) => {
    doc.deleteIn(['items', id])
  })
}

export type { Model as YamlModel }
