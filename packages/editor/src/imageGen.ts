import { showModal } from './modal.js'
import { loadImageSettings, openImageSettings } from './imageSettings.js'

export type ImgFlow = 'sprite' | 'bg' | 'base'

export interface GenFlowOpts {
  flow: ImgFlow
  title: string
  /** 追加到预置提示词后的初始内容（角色名/场景名等上下文） */
  seed?: string
  /** 参考图：项目内相对路径（可选；sprite/base 常用角色基准图） */
  ref?: string
  /** 预览文件基名 */
  name: string
  matteDefault?: boolean
}

interface GenResp {
  ok: boolean
  candidates?: Array<{ preview?: string; error?: string }>
  error?: string
}

/**
 * 生图流程：调参 → 抽卡生成 N 个候选 → 画廊选一张 → 返回预览路径（在 build/img-preview）。
 * 落盘与注册由调用方完成（不同流程目标目录/注册方式不同）。
 */
export async function generateImageFlow(opts: GenFlowOpts): Promise<string | null> {
  const s = loadImageSettings()
  const initialPrompt = (s.presets[opts.flow] ?? '') + (opts.seed ?? '')
  const selected = { current: null as string | null }

  const renderGallery = (statusEl: HTMLElement, candidates: Array<{ preview?: string; error?: string }>): void => {
    selected.current = null
    const cells = candidates
      .map((c, i) =>
        c.preview
          ? `<div class="ig-cell" data-preview="${esc(c.preview)}" data-i="${i}"><img src="/${esc(c.preview)}?t=${Date.now()}" alt=""><div class="ig-cap">候选 ${i + 1}${c.error ? ' ⚠' : ''}</div></div>`
          : `<div class="ig-cell ig-fail" title="${esc(c.error ?? '')}">候选 ${i + 1}<br>失败</div>`,
      )
      .join('')
    statusEl.innerHTML = `<div class="ig-hint">点选一张候选，再"使用选中候选"</div><div class="ig-gallery">${cells}</div>`
    statusEl.querySelectorAll<HTMLElement>('.ig-cell[data-preview]').forEach((cell) => {
      cell.addEventListener('click', () => {
        statusEl.querySelectorAll('.ig-cell').forEach((x) => x.classList.remove('sel'))
        cell.classList.add('sel')
        selected.current = cell.dataset.preview!
      })
    })
    // 仅一张成功时自动选中
    const ok = statusEl.querySelectorAll<HTMLElement>('.ig-cell[data-preview]')
    if (ok.length === 1) ok[0].click()
  }

  const result = await showModal({
    title: opts.title,
    submitLabel: '使用选中候选',
    fields: [
      { key: 'prompt', label: '描述（喂入工作流模板的 {desc}，已含预置词，可编辑）', type: 'textarea', value: initialPrompt },
      ...(opts.ref ? [{ key: 'ref', label: '参考图', value: opts.ref, hint: '生成时作为 {ref} 传入（带参考图命令模板）' } as const] : []),
      { key: 'size', label: '尺寸', value: s.size },
      { key: 'count', label: '抽卡次数（候选数 1–8）', type: 'number', value: s.gachaCount },
      { key: 'matte', label: '抠图去背景（rembg）', type: 'checkbox', value: opts.matteDefault ?? opts.flow === 'sprite' },
    ],
    actions: [
      {
        label: '⚙ 生图设置',
        handler: async (_v, statusEl) => {
          await openImageSettings()
          statusEl.textContent = '设置已更新（下次生成生效）'
        },
      },
      {
        label: '▶ 生成候选',
        handler: async (v, statusEl) => {
          const cur = loadImageSettings()
          statusEl.innerHTML = `<span class="ig-running">生成中…（抽卡 ${v.count} 次，模型较慢请耐心等待）</span>`
          try {
            const r = (await (
              await fetch('/api/img/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({
                  flow: opts.flow,
                  desc: v.prompt,
                  promptTemplate: cur.promptTemplate,
                  ref: opts.ref ?? '',
                  count: Number(v.count) || cur.gachaCount,
                  size: v.size || cur.size,
                  genCommand: cur.genCommand,
                  genCommandRef: cur.genCommandRef,
                  rembgCommand: cur.rembgCommand,
                  matte: v.matte === 'true',
                  name: opts.name,
                }),
              })
            ).json()) as GenResp
            if (!r.ok || !r.candidates) {
              statusEl.innerHTML = `<span class="m-err">${esc(r.error ?? '全部候选生成失败')}</span>${
                r.candidates ? `<div class="ig-errs">${r.candidates.map((c) => esc(c.error ?? '')).filter(Boolean).join('<br>')}</div>` : ''
              }`
              return
            }
            renderGallery(statusEl, r.candidates)
          } catch (err) {
            statusEl.innerHTML = `<span class="m-err">请求失败：${esc(String(err))}</span>`
          }
        },
      },
    ],
    validate: () => (selected.current ? null : '请先"生成候选"并点选一张'),
  })
  if (!result) return null
  return selected.current
}

/** 抠图流程：对已有图片跑 rembg，预览结果，返回透明 PNG 预览路径或 null */
export async function matteFlow(src: string, name: string): Promise<string | null> {
  const previewRef = { current: null as string | null }
  const result = await showModal({
    title: `抠图去背景：${src.split('/').pop()}`,
    bodyHtml: `<div class="rm-detail">对该图运行 rembg 去背景，生成透明 PNG。原图：</div><img class="imp-preview" src="/${esc(src)}?t=${Date.now()}" alt="">`,
    submitLabel: '使用抠图结果',
    fields: [],
    actions: [
      {
        label: '▶ 抠图',
        handler: async (_v, statusEl) => {
          const s = loadImageSettings()
          statusEl.textContent = '抠图中…'
          try {
            const r = (await (
              await fetch('/api/img/matte', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ src, rembgCommand: s.rembgCommand, name }),
              })
            ).json()) as { ok: boolean; preview?: string; error?: string }
            if (!r.ok || !r.preview) {
              statusEl.innerHTML = `<span class="m-err">${esc(r.error ?? '抠图失败')}</span>`
              return
            }
            previewRef.current = r.preview
            statusEl.innerHTML = `<span class="m-ok">✓ 完成（棋盘格处为透明）</span><br><img class="imp-preview ig-checker" src="/${esc(r.preview)}?t=${Date.now()}" alt="">`
          } catch (err) {
            statusEl.innerHTML = `<span class="m-err">请求失败：${esc(String(err))}</span>`
          }
        },
      },
    ],
    validate: () => (previewRef.current ? null : '请先"抠图"生成结果'),
  })
  if (!result) return null
  return previewRef.current
}

/** 把预览图落盘到项目目标路径，返回实际写入的项目内相对路径（重名自动改名） */
export async function commitImage(preview: string, to: string): Promise<string | null> {
  const r = (await (
    await fetch('/api/img/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ preview, to }),
    })
  ).json()) as { ok?: boolean; path?: string; error?: string }
  if (!r.ok || !r.path) {
    alert(`保存失败：${r.error ?? '未知错误'}`)
    return null
  }
  return r.path
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
