import { describe, expect, it } from 'vitest'
import { evalExpr, type EvalEnv } from '@vn/core'
import { ExprError, parseExpr, parseSetValue } from '@vn/compiler'

const env = (vars: Record<string, number | boolean | string> = {}): EvalEnv => ({
  getVar: (n) => {
    if (vars[n] === undefined) throw new Error(`no var ${n}`)
    return vars[n]
  },
  getGlobal: () => false,
  rand: () => 0.5,
})

describe('表达式解析与求值', () => {
  it('运算符优先级', () => {
    expect(evalExpr(parseExpr('1 + 2 * 3'), env())).toBe(7)
    expect(evalExpr(parseExpr('(1 + 2) * 3'), env())).toBe(9)
    expect(evalExpr(parseExpr('1 + 2 >= 3 && true'), env())).toBe(true)
    expect(evalExpr(parseExpr('!false || false'), env())).toBe(true)
  })

  it('变量与 CJK 标识符', () => {
    expect(evalExpr(parseExpr('favor + 1'), env({ favor: 2 }))).toBe(3)
    expect(evalExpr(parseExpr('好感 * 2'), env({ 好感: 5 }))).toBe(10)
  })

  it('字符串字面量与比较', () => {
    expect(evalExpr(parseExpr("name == '小满'"), env({ name: '小满' }))).toBe(true)
  })

  it('global 前缀', () => {
    expect(parseExpr('global.cleared_good')).toEqual(['global', 'cleared_good'])
  })

  it('rand / randint', () => {
    expect(evalExpr(parseExpr('rand()'), env())).toBe(0.5)
    const v = evalExpr(parseExpr('randint(1, 3)'), env())
    expect(v).toBe(2) // rand=0.5 → 1 + floor(0.5*3) = 2
  })

  it('语法错误', () => {
    expect(() => parseExpr('1 +')).toThrow(ExprError)
    expect(() => parseExpr('(1 + 2')).toThrow(ExprError)
    expect(() => parseExpr('foo(1)')).toThrow(/未知函数/)
    expect(() => parseExpr('a.b')).toThrow(/非法的变量名/)
    expect(() => parseExpr("'未闭合")).toThrow(/未闭合/)
  })

  it('set 取值：字面量 / 表达式 / += 语法糖', () => {
    expect(parseSetValue('x', true)).toEqual(['lit', true])
    expect(parseSetValue('x', 5)).toEqual(['lit', 5])
    expect(parseSetValue('favor', 'favor + 1')).toEqual(['bin', '+', ['var', 'favor'], ['lit', 1]])
    expect(parseSetValue('favor', 'favor += 1')).toEqual(['bin', '+', ['var', 'favor'], ['lit', 1]])
    expect(parseSetValue('favor', '+= 2')).toEqual(['bin', '+', ['var', 'favor'], ['lit', 2]])
    expect(() => parseSetValue('a', 'b += 1')).toThrow(/不一致/)
  })
})
