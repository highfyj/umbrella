import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const root = (rel: string) => fileURLToPath(new URL('../../../' + rel, import.meta.url))
const schema = (name: string) => JSON.parse(readFileSync(root(`packages/compiler/schemas/${name}.schema.json`), 'utf8'))
const yamlFile = (rel: string) => parse(readFileSync(root(rel), 'utf8'))

// CJS/ESM 互操作：vitest 下 default 可能套了一层
const AjvClass = ((Ajv as { default?: unknown }).default ?? Ajv) as new (opts: object) => {
  compile(schema: object): { (data: unknown): boolean; errors: unknown }
}

describe('JSON Schema 校验样例剧本', () => {
  const ajv = new AjvClass({ allErrors: true })

  it('story.yaml', () => {
    const validate = ajv.compile(schema('story'))
    expect(validate(yamlFile('story/story.yaml')), JSON.stringify(validate.errors)).toBe(true)
  })

  it('characters.yaml', () => {
    const validate = ajv.compile(schema('characters'))
    expect(validate(yamlFile('story/characters.yaml')), JSON.stringify(validate.errors)).toBe(true)
  })

  it('assets.yaml', () => {
    const validate = ajv.compile(schema('assets'))
    expect(validate(yamlFile('story/assets.yaml')), JSON.stringify(validate.errors)).toBe(true)
  })

  it('scenes/*.yaml', () => {
    const validate = ajv.compile(schema('scene'))
    for (const f of ['ch01', 'ch02_walk', 'ch02_alone']) {
      expect(validate(yamlFile(`story/scenes/${f}.yaml`)), `${f}: ${JSON.stringify(validate.errors)}`).toBe(true)
    }
  })
})
