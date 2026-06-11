# 雨伞（工作名）

基于全屏 Web 页面的全程语音视觉小说（Visual Novel）项目，分为两部分：

- **游戏本体**：确定性 VM 运行器 + Web 播放器
- **脚本编辑系统**：剧情脚本 DSL（YAML + JSON Schema + 编译器），本项目的核心

## 当前进度

- [x] DSL v0.1 设计文档：[docs/dsl-design.md](docs/dsl-design.md)
- [x] 样例剧本（1 个分支点小选择 + 1 个路线分支 + 2 个结局）：[story/](story/)
- [x] JSON Schema + 编译器（语义 linter、语音三向核对、IR 输出、台本/立绘清单导出、assign-ids）
- [x] 无头运行时 VM + 剧情测试（确定性随机、存读档、结局可达）
- [x] Web 播放器 UI（占位渲染、缺失资产 HUD、语音/打字机差异化推进、存读档、YAML 热刷新）
- [x] 编辑器（Monaco + Schema 补全、未保存缓冲区实时语义诊断、内嵌预览、剧情流程图）
- [x] 资产管理面板（分层树、预览/插入/拖拽、一键注册写回 YAML、光标停留预览小窗、production 编辑素材）
- [x] TTS 语音生成（CosyVoice 本地部署接入：设置 UI + 探活、右键对白 → 调参生成 → 试听 → 落盘替换 + voice.lock；右键菜单与新增资产表单）

## 常用命令

```
npm run editor                    启动编辑器（http://localhost:5174）
npm run dev                       启动播放器（http://localhost:5173，改 YAML 自动刷新）
npm test                          全部测试
npm run vn -- check               编译检查（资产缺失只警告，照常通过）
npm run vn -- compile             输出 build/story.ir.json
npm run vn -- voice-script        导出录音台本 CSV
npm run vn -- sprite-checklist    导出立绘生成清单 CSV（AI 出图工作列表）
npm run vn -- assign-ids --write  给配音台词自动分配语音 id 并写回
npm run vn -- check --strict      发布前 QA：警告升级为错误
```

## 目录

```
docs/dsl-design.md       DSL 设计文档（先读这个）
story/                   剧本源文件（story/characters/assets + scenes/*.yaml）
voice/                   语音文件（voice/<场景>/<语音id>.ogg，待录制）
sprite/ bg/ bgm/ se/     运行资产（可后补，缺失时占位）
production/              编辑素材（不随游戏发布）：refs/ AI出图参考、tts/ 音色文件
packages/
  core/                  IR 类型、表达式求值、可序列化 PRNG
  compiler/              YAML → 校验/linter → IR；CLI 与各导出；JSON Schema
  runtime/               无头确定性 VM（next/choose/save/load）
  player/                Web 播放器（导出 Game 类，编辑器预览复用）
  editor/                脚本编辑器（Monaco + monaco-yaml + 实时预览 + 流程图）
  devtools/              共享 Vite 插件（现场编译、叠加编译、文件读写 API、资产伺服）
```
