import { parseDocument, YAMLSeq } from 'yaml'
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

export type { Model as YamlModel }
