# Umbrella（雨伞）

一个全栈 Web 视觉小说引擎与脚本编辑系统。在浏览器中创作、编译、播放全程语音的视觉小说。

> **「脚本先行，资产解耦。」** 在零资产状态下即可完成剧本的编写与全流程调试。占位渲染让你持续推进。美术、音乐、配音等你准备好了再补。

[English Documentation](README.md)

---

## Umbrella 是什么？

Umbrella 包含两个部分：

- **游戏运行时** — 一个确定性虚拟机（VM）+ Web 播放器，支持全程语音、选择分支、存读档、多结局。
- **脚本编辑系统**（核心产品） — 基于 YAML 的剧情 DSL，配备完整的编译器工具链（JSON Schema 结构校验、语义 Linter、IR 输出），以及集成 Web 编辑器，支持实时预览、资产管理和 AI 辅助生产。

### 为什么选择 Umbrella？

大多数视觉小说引擎需要你学习一套专属脚本语言，并且在看到效果之前就得准备好所有美术素材。Umbrella 颠覆了这个流程：

- **用 YAML 写剧本** — 熟悉、可读，配合 JSON Schema 驱动自动补全和内联诊断。
- **编译期安全** — 悬空跳转、未声明变量、拼写错误在编译期就会被捕获，并给出精确的行列号。告别运行时翻车。
- **零资产开发** — 缺少立绘、背景、语音文件不会阻塞你。播放器用占位渲染兜底，让你第一时间跑通完整流程。
- **AI 辅助生产** — 编辑器内集成 TTS 语音生成（CosyVoice）和 AI 立绘生成（含自动抠图）。

---

## 功能特性

### 剧本 DSL & 编译器
- 基于 YAML 的剧本格式，语法简洁，为写手设计
- JSON Schema 校验 + Monaco Editor 自动补全
- 语义 Linter：引用检查、变量校验、可达性分析、语音三向核对
- 编译输出 JSON IR，运行时不再解析 YAML

### 运行时 VM
- 确定性、无头 VM — 可在 Node.js 中跑通全部分支测试
- 可序列化 PRNG 状态（mulberry32）— 存档完全可复现
- 表达式中支持 `rand()` / `randint()`，加权 `random` 分支

### Web 播放器
- 全屏播放器，支持打字机效果和语音播放
- 三通道独立音频：语音 / BGM / SE，语音播放时 BGM 自动压低
- 存读档、快速重开、结局卡片
- 缺失资产占位渲染 + 画面上 HUD 面板

### 集成编辑器
- Monaco 编辑器 + JSON Schema 驱动自动补全
- 未保存缓冲区实时语义诊断（叠加编译，400ms 防抖）
- 内嵌播放器预览（复用同一 `Game` 类）
- 只读剧情流程图
- 资产管理面板：拖拽注册、光标悬停预览、一键写回 YAML

### AI 生产管线
- **TTS**：CosyVoice 接入 — 配置、探活、右键对白生成、试听、落盘提交
- **生图**：codex exec agent 工作流 + rembg 抠图 — 立绘/背景/参考图三种流程，抽卡式候选画廊

---

## 快速上手

```bash
git clone https://github.com/highfyj/umbrella.git
cd umbrella
npm install              # Node >= 20，npm workspaces
npm test                 # 45 个测试全部通过
npm run editor           # 启动编辑器 http://localhost:5174
npm run dev              # 启动播放器 http://localhost:5173
```

可选依赖：
- **ffmpeg**（PATH 可达）：TTS 生成后自动转 Ogg；没有则保留 WAV
- **CosyVoice**（本地 FastAPI 部署）：编辑器工具栏 →「TTS 设置」中配置并测试连接

---

## 常用命令

```
npm run editor                    启动编辑器（http://localhost:5174）
npm run dev                       启动播放器（http://localhost:5173，改 YAML 自动刷新）
npm test                          运行全部测试
npm run typecheck                 TypeScript 类型检查
npm run vn -- check               编译检查（资产缺失只警告，照常通过）
npm run vn -- check --strict      发布前 QA：警告升级为错误
npm run vn -- compile             输出 build/story.ir.json
npm run vn -- voice-script        导出录音台本 CSV
npm run vn -- sprite-checklist    导出立绘生成清单 CSV
npm run vn -- assign-ids --write  自动分配语音 ID 并写回 YAML
```

---

## 项目结构

```
umbrella/
├── docs/
│   ├── dsl-design.md              DSL 设计文档（数据模型权威参考）
│   └── progress.md                开发日志与设计决策汇总
├── story/                         剧本源文件（YAML）
│   ├── story.yaml                 入口：变量声明、结局注册
│   ├── characters.yaml            角色与立绘变体注册表
│   ├── assets.yaml                背景 / BGM / SE 词表
│   └── scenes/                    每场景一个 YAML 文件
├── sprite/ bg/ bgm/ se/           运行资产（可选；缺失时占位兜底）
├── voice/                         语音文件（voice/<场景>/<id>.ogg）
├── production/                    编辑素材（不随游戏发布）
│   ├── refs/                      AI 出图参考图
│   └── tts/                       音色参考音频
├── packages/
│   ├── core/                      IR 类型定义、表达式求值器、可序列化 PRNG
│   ├── compiler/                  YAML → 校验/Linter → IR；CLI 工具；JSON Schema ×4
│   ├── runtime/                   无头确定性 VM（next/choose/save/load）
│   ├── player/                    Web 播放器（导出 Game 类，编辑器预览复用）
│   ├── editor/                    Monaco 编辑器 + 实时诊断 + 预览 + 流程图 + 资产管理
│   └── devtools/                  共享 Vite 插件：现场编译、文件 API、资产伺服、TTS/生图代理
└── build/                         编译输出的 IR
```

---

## 样例剧本

仓库内包含一个完整样例剧本《雨伞》，覆盖全部 DSL 特性：

- 2 位角色（一位有立绘和语音，一位无立绘无语音）
- 3 个场景，2 个结局（好结局 / 普通结局）
- 带条件可见性的选择分支
- 加权随机分支
- 变量系统与表达式求值
- 立绘三维寻址变体（outfit / state / face）
- 配音台词 ID 分配

---

## 核心设计决策

1. **编译中间层** — 运行时只认 IR，不碰 YAML。语义错误在编译期暴露，带精确行列号。
2. **错误 vs 警告的分界** — 拼写/引用错误 = 错误。资产缺失一律警告 + 占位兜底。`--strict` 仅用于发布前 QA。
3. **立绘 = 维度寻址的整图变体** — `(outfit, state, face)` → 一张完整 AI 生成图。不做运行时图层合成。
4. **语音 ID** — 格式 `<场景>_<四位序号>`，步长 10 分配，永不复用。文本哈希存 `voice.lock` 做改稿检测。
5. **确定性随机** — PRNG 状态随 VM/存档序列化。回滚不重掷。
6. **编辑素材独立** — 参考图与音色文件挂角色定义节点，不进入构建产物。

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 语言 | TypeScript 5.5（全栈） |
| 模块系统 | ESM（`"type": "module"`） |
| 包管理 | npm workspaces（monorepo，6 个子包） |
| 构建工具 | Vite（开发服务器 + HMR） |
| 测试 | Vitest（45 个测试） |
| 编辑器 | Monaco Editor + monaco-yaml |
| 数据格式 | YAML 1.2 |
| JSON Schema | ajv 8.17 |
| 音频 | Web Audio API（三通道：语音/BGM/SE） |
| AI 集成 | CosyVoice（TTS）、codex agent（生图）、rembg（抠图） |

---

## 路线图

详见 [docs/progress.md](docs/progress.md#7-后续路线建议优先级)。亮点包括：

- **v0.2**：`call/return` 公共子剧情、并行演出、选项内嵌 steps
- **构建管线**：`vn build` 产出静态站点、按场景分包加载 + Service Worker
- **多语言钩子**、CG/画廊解锁、浏览器 SpeechSynthesis TTS 占位预览

---

## 许可证

MIT
