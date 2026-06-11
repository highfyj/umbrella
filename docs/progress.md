# 项目阶段性文档

> 更新日期：2026-06-11。换机器继续开发时先读本文档，再按"快速上手"操作。
> 设计细节见 [dsl-design.md](dsl-design.md)（DSL/语音/立绘/随机/占位工作流的完整设计）。

## 1. 项目是什么

全屏 Web 视觉小说（VN）引擎 + 配套脚本编辑系统，全程语音，资产由 AI 生成驱动。
核心理念：**剧情脚本 DSL 是产品核心**——YAML 源码 → 编译器（结构校验 + 语义 linter）→ JSON IR → 确定性 VM。

仓库：`ssh://git@git.imakeall.com:2022/game/webnovel.git`（main 分支）

## 2. 当前进度（全部已完成并验证）

| 里程碑 | 内容 | 关键提交 |
|---|---|---|
| DSL v0.1 设计 | 设计文档 + 样例剧本《雨伞》（2 结局，覆盖全部特性） | 69661df |
| 编译器 + 运行时 | YAML→IR、语义检查、语音三向核对、台本/立绘清单导出、assign-ids、无头 VM | 69661df |
| Web 播放器 | 零资产可玩（占位渲染）、语音/打字机差异化、存读档、HUD | 4b0c329 |
| 编辑器 | Monaco + Schema 补全、未保存缓冲区实时语义诊断、内嵌预览、流程图 | cf0382b |
| 资产管理 | 分层面板、注册写回 YAML、拖拽/插入、光标停留预览、production 编辑素材模型 | 36180c7 |
| TTS 集成 | CosyVoice 接入（设置 UI/探活/右键生成/试听/落盘+voice.lock）、资产新增 UI | 324144b |

测试：45/45 通过（`npm test`）；类型检查零错误（`npm run typecheck`）。

## 3. 快速上手（新机器）

```bash
git clone ssh://git@git.imakeall.com:2022/game/webnovel.git
cd webnovel
npm install            # Node >= 20（开发时用的 24），npm workspaces
npm test               # 应 45/45 通过
npm run editor         # 编辑器 http://localhost:5174（主要工作入口）
npm run dev            # 纯播放器 http://localhost:5173
npm run vn -- check    # CLI 编译检查
```

可选环境：
- **ffmpeg**（PATH 可达）：TTS 生成后自动转 ogg；没有则保存 wav（运行时同样支持，多扩展名探测）。
- **CosyVoice 本地部署**（FastAPI 服务）：编辑器 → 工具栏"TTS 设置"配置地址并"测试连接"。

## 4. 仓库结构与各包职责

```
docs/dsl-design.md     DSL 设计文档（数据模型的唯一权威）
docs/progress.md       本文档
story/                 剧本源文件：story.yaml(变量/结局) characters.yaml(角色/立绘变体/production)
                       assets.yaml(背景/BGM/SE 词表) scenes/*.yaml(一文件一场景)
voice/ sprite/ bg/ bgm/ se/   运行资产（约定目录，缺失时占位，当前为空）
production/            编辑素材（不发布）：refs/ AI出图参考图、tts/ 音色参考音频
voice.lock             语音清单 lockfile（编译器/TTS 提交共同维护，当前未生成）
packages/
  core/       IR 类型、表达式求值器（无 eval）、可序列化 PRNG（mulberry32）
  compiler/   解析(行列位置)→归一化→扁平化→linter→IR；CLI(check/compile/voice-script/
              sprite-checklist/assign-ids)；JSON Schema ×4；voice.lock 三向核对
  runtime/    无头确定性 VM：next()/choose()/save()/load()，演出经 effects 输出
  player/     Web 播放器；Game 类可挂任意容器（编辑器预览复用）
  editor/     Monaco 编辑器：实时语义诊断(叠加编译)、资产面板、TTS、流程图
  devtools/   共享 Vite 插件：现场编译、/api/compile(叠加)、文件读写、资产扫描、
              TTS 代理(probe/generate/commit)、资产静态伺服
```

## 5. 关键设计决策（为什么是这样）

1. **编译中间层**：运行时只认 IR，不碰 YAML。语义错误（悬空跳转/未声明变量/词表外维度）在编译期报，带精确行列。
2. **错误 vs 警告的分界 = 脚本自洽性**：拼写/引用/语法错 = 错误；**资产缺失一律警告 + 占位兜底**（脚本先行，零资产可全流程开发调试）。`--strict` 仅用于发布 QA。
3. **立绘 = 维度寻址的整图变体**：`(outfit, state, face)` → 一张 AI 生成的完整图（不做图层合成，AI 对齐不可控）。维度值必须是字面量 → 编译器可静态枚举可达组合 → 缺图清单 = AI 出图工作列表。
4. **语音 id**：`<场景>_<四位序号>`，步长 10 分配、永不复用，工具写回 YAML（不用内容哈希——改稿会失联音频）。文本哈希存 `voice.lock` 做改稿检测（`voice-stale-text` 警告）。
5. **确定性随机**：PRNG 状态进 VM/存档；`random` 加权分支（权重是表达式）、`rand()/randint()`；回滚不重掷。
6. **production 编辑素材**：挂 characters.yaml 角色节点（refs 出图参考 / tts 音色配置），编译器只做存在性 info 提示，**不进 IR 不发布**。
7. **TTS 走 dev server 代理**（浏览器 CORS）：generate 裸 PCM→WAV→可选 ogg；commit 落盘 + 写 voice.lock（text_hash 复用编译器 textHash，且**用脚本原文**而非微调读法文本）。
8. **编辑器注册类操作 = yaml Document 结构化编辑写回 Monaco model**：保留注释、走撤销栈、保存才落盘；叠加编译（未保存缓冲区覆盖磁盘）让语义诊断在打字时就生效。

## 6. 已知事项 / 注意点

- **CosyVoice API 形态未实测**：按官方 FastAPI 部署实现（`/inference_zero_shot` 等端点、
  `tts_text/prompt_text/prompt_wav` 字段、裸 PCM 流）。若实际部署（CosyVoice3）接口不同：
  端点路径可在设置 UI 直接改；字段名不同则需在 `packages/devtools/vnVitePlugin.ts` 的
  `/api/tts/generate` 处加适配。
- TTS 设置存浏览器 localStorage（机器本地，换机器要重配）。
- 角色立绘变体的 `state` 当前在 IR comboKey 中以排序后 `+` 连接（`校服|淋湿|微笑`）。
- 编辑器保存（Ctrl+S）= 写盘 + 重启预览（从头开始）；"从当前场景重播"未做。
- Windows PowerShell 5.1 直接调 `/api/file` 测试时注意 UTF-8（服务端已声明 charset；浏览器无此问题）。
- 样例剧本引用的图/音文件均未生成，编译有 18 个占位警告属正常。

## 7. 后续路线（建议优先级）

1. **TTS 实测适配**：连真实 CosyVoice3 部署，校准端点/字段/采样率；按需加 provider 适配层。
2. **批量 TTS**：按场景"生成全部待录"（逐句调用 + 进度 UI + 失败重试），台本导出按钮进编辑器工具栏。
3. **编辑器体验**：从当前场景/当前行重播预览；assign-ids 集成进保存流程；立绘清单/录音台本一键导出入口。
4. **DSL v0.2**：`call/return` 公共子剧情；选项内嵌 steps；并行演出；选项配音。
5. **发布管线**：`vn build` 产出静态站点（IR + 资产打包 + player 构建）；按场景分包加载 + Service Worker 缓存（资产上量后）。
6. **多语言钩子**、CG/画廊解锁、TTS 占位语音（编辑器预览用浏览器 SpeechSynthesis）。

## 8. 常用命令速查

```
npm run editor                    编辑器（5174）
npm run dev                       播放器（5173）
npm test / npm run typecheck      测试 / 类型检查
npm run vn -- check [--strict]    编译检查
npm run vn -- compile             输出 build/story.ir.json
npm run vn -- voice-script        录音台本 CSV
npm run vn -- sprite-checklist    立绘生成清单 CSV
npm run vn -- assign-ids --write  分配语音 id 并写回
```
