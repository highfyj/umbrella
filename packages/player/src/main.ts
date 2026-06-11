import { Game, escapeHtml } from './game.js'
import type { StoryIR } from '@vn/core'

interface DiagItem {
  severity: string
  code: string
  message: string
  file: string
  pos: { line: number; col: number } | null
}

const app = document.getElementById('app')!

async function boot(): Promise<void> {
  let payload: { ir: StoryIR | null; diagnostics: DiagItem[] }
  try {
    payload = await (await fetch('/story.ir.json')).json()
  } catch (err) {
    app.innerHTML = `<div class="error-page"><h2>无法加载剧本</h2>${escapeHtml(String(err))}</div>`
    return
  }
  const errors = payload.diagnostics.filter((d) => d.severity === 'error')
  if (!payload.ir || errors.length) {
    const list = errors
      .map((d) => `${d.file}${d.pos ? `:${d.pos.line}:${d.pos.col}` : ''}  [${d.code}] ${d.message}`)
      .join('\n')
    app.innerHTML = `<div class="error-page"><h2>剧本编译错误（${errors.length}）</h2>${escapeHtml(list)}</div>`
    return
  }
  const warnings = payload.diagnostics.filter((d) => d.severity === 'warning').length
  new Game(app, payload.ir, warnings).start()
}

void boot()
