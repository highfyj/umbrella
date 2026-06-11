import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectFiles } from './project.js'

/** Node 文件系统实现，root = 项目根（包含 story/、voice/、sprite/ 等） */
export class NodeFiles implements ProjectFiles {
  constructor(public root: string) {}

  read(path: string): string | null {
    const full = join(this.root, path)
    try {
      return readFileSync(full, 'utf8')
    } catch {
      return null
    }
  }

  list(dir: string): string[] {
    const full = join(this.root, dir)
    try {
      return readdirSync(full).filter((f) => statSync(join(full, f)).isFile())
    } catch {
      return []
    }
  }

  exists(path: string): boolean {
    return existsSync(join(this.root, path))
  }
}
