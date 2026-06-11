import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assignVoiceIds } from './assignIds.js'
import { compileProject } from './compile.js'
import { formatDiagnostic } from './diagnostics.js'
import { exportSpriteChecklist, exportVoiceScript } from './exports.js'
import { NodeFiles } from './nodeFiles.js'

const USAGE = `用法: vn <命令> [--root <项目根>] [选项]

命令:
  check                  编译并报告诊断（不输出 IR）
  compile [-o <文件>]    编译并输出 IR JSON（默认 build/story.ir.json）
  voice-script [-o]      导出录音台本 CSV（默认 build/voice-script.csv）
  sprite-checklist [-o]  导出立绘生成清单 CSV（默认 build/sprite-checklist.csv）
  assign-ids [--write]   给配音台词分配语音 id（默认只预览，--write 写回）

选项:
  --strict               把警告升级为错误（发布前 QA 用）
`

function main(): void {
  const args = process.argv.slice(2)
  const cmd = args[0]
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(USAGE)
    process.exit(cmd ? 0 : 1)
  }

  const opt = (name: string): string | null => {
    const i = args.indexOf(name)
    return i >= 0 && args[i + 1] ? args[i + 1] : null
  }
  const root = opt('--root') ?? '.'
  const strict = args.includes('--strict')
  const files = new NodeFiles(root)

  const writeOut = (path: string, content: string): void => {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
    console.log(`已写出 ${path}`)
  }

  if (cmd === 'assign-ids') {
    const r = assignVoiceIds(files)
    for (const e of r.errors) console.error(`ERROR  ${e}`)
    for (const a of r.assigned) console.log(`${a.id}  ${a.text}`)
    if (!r.assigned.length) console.log('没有需要分配 id 的台词')
    if (args.includes('--write')) {
      for (const [path, content] of r.changes) {
        writeFileSync(join(root, path), content, 'utf8')
        console.log(`已写回 ${path}`)
      }
    } else if (r.changes.size) {
      console.log('（预览模式，使用 --write 写回文件）')
    }
    process.exit(r.errors.length ? 1 : 0)
  }

  const result = compileProject(files)
  for (const d of result.diagnostics.items) console.log(formatDiagnostic(d))
  const errs = result.diagnostics.errors.length
  const warns = result.diagnostics.warnings.length
  console.log(`\n${errs} 个错误，${warns} 个警告`)
  const failed = errs > 0 || (strict && warns > 0)

  if (!failed && result.ir) {
    if (cmd === 'compile') {
      writeOut(opt('-o') ?? 'build/story.ir.json', JSON.stringify(result.ir, null, 2))
    } else if (cmd === 'voice-script') {
      writeOut(opt('-o') ?? 'build/voice-script.csv', exportVoiceScript(result.ir, result.voiceLines))
    } else if (cmd === 'sprite-checklist') {
      writeOut(opt('-o') ?? 'build/sprite-checklist.csv', exportSpriteChecklist(result.ir, result.sprites!))
    } else if (cmd !== 'check') {
      console.error(`未知命令: ${cmd}\n${USAGE}`)
      process.exit(1)
    }
  }

  process.exit(failed ? 1 : 0)
}

main()
