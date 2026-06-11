import type { BinOp, ExprAST } from '@vn/core'

export class ExprError extends Error {
  constructor(msg: string, public offset: number, public code = 'expr-syntax') {
    super(msg)
  }
}

const YAML11_BOOLS = /^(yes|no|on|off)$/i

type Tok = { t: 'num' | 'str' | 'ident' | 'op' | 'eof'; v: string; pos: number }

const TWO_CHAR = ['||', '&&', '==', '!=', '>=', '<=']
const ONE_CHAR = ['>', '<', '+', '-', '*', '/', '(', ')', ',', '!']
const IDENT_RE = /^[\p{L}_][\p{L}\p{N}_.]*/u

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (/\d/.test(c)) {
      let j = i
      while (j < src.length && /[\d.]/.test(src[j])) j++
      toks.push({ t: 'num', v: src.slice(i, j), pos: i })
      i = j
      continue
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1)
      if (j < 0) throw new ExprError('未闭合的字符串', i)
      toks.push({ t: 'str', v: src.slice(i + 1, j), pos: i })
      i = j + 1
      continue
    }
    const two = src.slice(i, i + 2)
    if (TWO_CHAR.includes(two)) {
      toks.push({ t: 'op', v: two, pos: i })
      i += 2
      continue
    }
    if (ONE_CHAR.includes(c)) {
      toks.push({ t: 'op', v: c, pos: i })
      i++
      continue
    }
    const m = IDENT_RE.exec(src.slice(i))
    if (m) {
      toks.push({ t: 'ident', v: m[0], pos: i })
      i += m[0].length
      continue
    }
    throw new ExprError(`无法识别的字符 '${c}'`, i)
  }
  toks.push({ t: 'eof', v: '', pos: src.length })
  return toks
}

const BIN_PREC: Record<string, number> = {
  '||': 1, '&&': 2,
  '==': 3, '!=': 3,
  '>': 4, '>=': 4, '<': 4, '<=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6,
}

export function parseExpr(src: string): ExprAST {
  const toks = tokenize(src)
  let p = 0
  const peek = () => toks[p]
  const next = () => toks[p++]

  function expect(op: string): void {
    const t = next()
    if (!(t.t === 'op' && t.v === op)) throw new ExprError(`期望 '${op}'`, t.pos)
  }

  function expr(minPrec: number): ExprAST {
    let lhs = unary()
    for (;;) {
      const t = peek()
      if (t.t !== 'op') break
      const prec = BIN_PREC[t.v]
      if (prec === undefined || prec < minPrec) break
      next()
      const rhs = expr(prec + 1)
      lhs = ['bin', t.v as BinOp, lhs, rhs]
    }
    return lhs
  }

  function unary(): ExprAST {
    const t = peek()
    if (t.t === 'op' && (t.v === '!' || t.v === '-')) {
      next()
      return ['un', t.v, unary()]
    }
    return primary()
  }

  function primary(): ExprAST {
    const t = next()
    if (t.t === 'num') return ['lit', Number(t.v)]
    if (t.t === 'str') return ['lit', t.v]
    if (t.t === 'op' && t.v === '(') {
      const e = expr(0)
      expect(')')
      return e
    }
    if (t.t === 'ident') {
      if (t.v === 'true') return ['lit', true]
      if (t.v === 'false') return ['lit', false]
      if (YAML11_BOOLS.test(t.v)) {
        throw new ExprError(`"${t.v}" 在 YAML 1.2 / 表达式中不是布尔值，请写 true/false`, t.pos, 'yaml-bool-trap')
      }
      if (t.v === 'rand' || t.v === 'randint') {
        expect('(')
        const args: ExprAST[] = []
        if (!(peek().t === 'op' && peek().v === ')')) {
          args.push(expr(0))
          while (peek().t === 'op' && peek().v === ',') {
            next()
            args.push(expr(0))
          }
        }
        expect(')')
        const arity = t.v === 'rand' ? 0 : 2
        if (args.length !== arity) throw new ExprError(`${t.v}() 需要 ${arity} 个参数`, t.pos)
        return ['call', t.v, args]
      }
      if (peek().t === 'op' && peek().v === '(') throw new ExprError(`未知函数 '${t.v}'`, t.pos)
      if (t.v.includes('.')) {
        if (t.v.startsWith('global.') && !t.v.slice('global.'.length).includes('.')) {
          return ['global', t.v.slice('global.'.length)]
        }
        throw new ExprError(`非法的变量名 '${t.v}'`, t.pos)
      }
      return ['var', t.v]
    }
    throw new ExprError(t.t === 'eof' ? '表达式意外结束' : `意外的 '${t.v}'`, t.pos)
  }

  const e = expr(0)
  if (peek().t !== 'eof') throw new ExprError(`表达式末尾有多余内容 '${peek().v}'`, peek().pos)
  return e
}

/** set 的取值：YAML 原生数字/布尔 = 字面量；字符串 = 表达式，支持 "x += 1" / "+= 1" 语法糖 */
export function parseSetValue(name: string, raw: unknown): ExprAST {
  if (typeof raw === 'number' || typeof raw === 'boolean') return ['lit', raw]
  if (typeof raw !== 'string') throw new ExprError('set 的值必须是数字、布尔或表达式字符串', 0)
  const m = /^\s*([\p{L}_][\p{L}\p{N}_.]*\s+)?([+\-*/])=\s*([\s\S]+)$/u.exec(raw)
  if (m) {
    const target = m[1]?.trim() ?? name
    if (target !== name) throw new ExprError(`复合赋值的目标 '${target}' 与变量名 '${name}' 不一致`, 0)
    const self: ExprAST = name.startsWith('global.') ? ['global', name.slice('global.'.length)] : ['var', name]
    return ['bin', m[2] as BinOp, self, parseExpr(m[3])]
  }
  return parseExpr(raw)
}
