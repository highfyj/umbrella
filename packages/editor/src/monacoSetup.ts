import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import yamlWorker from 'monaco-yaml/yaml.worker?worker'
import { configureMonacoYaml } from 'monaco-yaml'
import storySchema from '../../compiler/schemas/story.schema.json'
import charactersSchema from '../../compiler/schemas/characters.schema.json'
import assetsSchema from '../../compiler/schemas/assets.schema.json'
import sceneSchema from '../../compiler/schemas/scene.schema.json'
import itemsSchema from '../../compiler/schemas/items.schema.json'

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'yaml') return new yamlWorker()
    return new editorWorker()
  },
}

configureMonacoYaml(monaco, {
  enableSchemaRequest: false,
  schemas: [
    { uri: 'vn://schemas/story', fileMatch: ['**/story/story.yaml'], schema: storySchema },
    { uri: 'vn://schemas/characters', fileMatch: ['**/story/characters.yaml'], schema: charactersSchema },
    { uri: 'vn://schemas/assets', fileMatch: ['**/story/assets.yaml'], schema: assetsSchema },
    { uri: 'vn://schemas/items', fileMatch: ['**/story/items.yaml'], schema: itemsSchema },
    { uri: 'vn://schemas/scene', fileMatch: ['**/story/scenes/*.yaml', '**/story/scenes/*.yml'], schema: sceneSchema },
  ],
})

export { monaco }
