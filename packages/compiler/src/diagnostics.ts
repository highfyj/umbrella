export type Severity = 'error' | 'warning' | 'info'

export interface Pos {
  line: number
  col: number
}

export interface Diagnostic {
  severity: Severity
  code: string
  message: string
  file: string
  pos: Pos | null
}

export class Diagnostics {
  items: Diagnostic[] = []

  add(severity: Severity, code: string, message: string, file: string, pos: Pos | null = null): void {
    this.items.push({ severity, code, message, file, pos })
  }

  error(code: string, message: string, file: string, pos: Pos | null = null): void {
    this.add('error', code, message, file, pos)
  }
  warn(code: string, message: string, file: string, pos: Pos | null = null): void {
    this.add('warning', code, message, file, pos)
  }
  info(code: string, message: string, file: string, pos: Pos | null = null): void {
    this.add('info', code, message, file, pos)
  }

  get errors(): Diagnostic[] {
    return this.items.filter((d) => d.severity === 'error')
  }
  get warnings(): Diagnostic[] {
    return this.items.filter((d) => d.severity === 'warning')
  }
  hasErrors(): boolean {
    return this.items.some((d) => d.severity === 'error')
  }
}

export function formatDiagnostic(d: Diagnostic): string {
  const loc = d.pos ? `${d.file}:${d.pos.line}:${d.pos.col}` : d.file
  return `${d.severity.toUpperCase().padEnd(7)} ${loc}  [${d.code}] ${d.message}`
}
