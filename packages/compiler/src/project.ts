import { LineCounter, parseDocument, Document, isMap, isSeq, isScalar } from 'yaml'
import type { Pos } from './diagnostics.js'

/** 文件系统抽象：Node 实现 + 内存实现（测试用） */
export interface ProjectFiles {
  read(path: string): string | null
  /** 列出目录下文件名（非递归）；目录不存在返回 [] */
  list(dir: string): string[]
  exists(path: string): boolean
}

export class MemoryFiles implements ProjectFiles {
  constructor(public map: Map<string, string>) {}

  static from(obj: Record<string, string>): MemoryFiles {
    return new MemoryFiles(new Map(Object.entries(obj)))
  }

  read(path: string): string | null {
    return this.map.get(path) ?? null
  }

  list(dir: string): string[] {
    const prefix = dir.endsWith('/') ? dir : dir + '/'
    const names = new Set<string>()
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length)
        if (!rest.includes('/')) names.add(rest)
      }
    }
    return [...names].sort()
  }

  exists(path: string): boolean {
    return this.map.has(path)
  }
}

/** 解析后的单个 YAML 文件：文档 + 源码 + 行号表 */
export interface ParsedFile {
  path: string
  src: string
  doc: Document
  lineCounter: LineCounter
}

export function parseFile(files: ProjectFiles, path: string): ParsedFile | null {
  const src = files.read(path)
  if (src === null) return null
  const lineCounter = new LineCounter()
  const doc = parseDocument(src, { lineCounter, keepSourceTokens: true })
  return { path, src, doc, lineCounter }
}

export function nodePos(file: ParsedFile, node: unknown): Pos | null {
  const range = (node as { range?: [number, number, number] })?.range
  if (!range) return null
  const lp = file.lineCounter.linePos(range[0])
  return { line: lp.line, col: lp.col }
}

/** 节点对应的源码原文（检测 yes/no/on/off 布尔陷阱用） */
export function nodeRaw(file: ParsedFile, node: unknown): string | null {
  const range = (node as { range?: [number, number, number] })?.range
  if (!range) return null
  return file.src.slice(range[0], range[1])
}

export { isMap, isSeq, isScalar }
