import type { ExprAST } from './ir.js'

export type Value = number | boolean | string

export interface EvalEnv {
  getVar(name: string): Value
  getGlobal(name: string): Value
  /** [0,1) 均匀随机，消耗 PRNG 状态 */
  rand(): number
}

export class EvalError extends Error {}

export function evalExpr(e: ExprAST, env: EvalEnv): Value {
  switch (e[0]) {
    case 'lit':
      return e[1]
    case 'var':
      return env.getVar(e[1])
    case 'global':
      return env.getGlobal(e[1])
    case 'un': {
      const v = evalExpr(e[2], env)
      if (e[1] === '!') {
        if (typeof v !== 'boolean') throw new EvalError(`! 需要布尔值，得到 ${typeof v}`)
        return !v
      }
      if (typeof v !== 'number') throw new EvalError(`负号需要数字，得到 ${typeof v}`)
      return -v
    }
    case 'call': {
      if (e[1] === 'rand') return env.rand()
      const a = num(evalExpr(e[2][0], env))
      const b = num(evalExpr(e[2][1], env))
      const lo = Math.ceil(Math.min(a, b))
      const hi = Math.floor(Math.max(a, b))
      return lo + Math.floor(env.rand() * (hi - lo + 1))
    }
    case 'bin': {
      const op = e[1]
      if (op === '&&') return bool(evalExpr(e[2], env)) && bool(evalExpr(e[3], env))
      if (op === '||') return bool(evalExpr(e[2], env)) || bool(evalExpr(e[3], env))
      const l = evalExpr(e[2], env)
      const r = evalExpr(e[3], env)
      switch (op) {
        case '==': return l === r
        case '!=': return l !== r
        case '>': return num(l) > num(r)
        case '>=': return num(l) >= num(r)
        case '<': return num(l) < num(r)
        case '<=': return num(l) <= num(r)
        case '+': return num(l) + num(r)
        case '-': return num(l) - num(r)
        case '*': return num(l) * num(r)
        case '/': return num(l) / num(r)
      }
    }
  }
}

function num(v: Value): number {
  if (typeof v !== 'number') throw new EvalError(`需要数字，得到 ${JSON.stringify(v)}`)
  return v
}

function bool(v: Value): boolean {
  if (typeof v !== 'boolean') throw new EvalError(`需要布尔值，得到 ${JSON.stringify(v)}`)
  return v
}

/** 遍历表达式中的变量引用 */
export function walkVars(e: ExprAST, fn: (kind: 'var' | 'global', name: string) => void): void {
  switch (e[0]) {
    case 'var': fn('var', e[1]); break
    case 'global': fn('global', e[1]); break
    case 'un': walkVars(e[2], fn); break
    case 'bin': walkVars(e[2], fn); walkVars(e[3], fn); break
    case 'call': for (const a of e[2]) walkVars(a, fn); break
  }
}
