/** 通用模态框：字段表单 + 可选的交互动作区（如"测试连接""生成试听"） */

export interface ModalField {
  key: string
  label: string
  type?: 'text' | 'textarea' | 'select' | 'checkbox' | 'number'
  value?: string | number | boolean
  options?: string[]
  placeholder?: string
  hint?: string
}

export interface ModalUi {
  /** 程序化回填字段（如"浏览本地文件"选中后写入路径） */
  setField(key: string, value: string): void
  statusEl: HTMLElement
}

export interface ModalAction {
  label: string
  /** 返回 false 可在动作区显示错误而不关闭 */
  handler: (values: Record<string, string>, statusEl: HTMLElement, ui: ModalUi) => void | Promise<void>
}

export interface ModalOptions {
  title: string
  /** 标题下方的自由 HTML 区（如导入预览）；调用方负责转义 */
  bodyHtml?: string
  fields: ModalField[]
  submitLabel?: string
  actions?: ModalAction[]
  /** 字段值变化回调（select/input 的 change） */
  onChange?: (key: string, values: Record<string, string>, ui: ModalUi) => void
  /** 校验：返回错误信息阻止提交 */
  validate?: (values: Record<string, string>) => string | null
}

export function showModal(opts: ModalOptions): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal">
        <div class="m-title">${esc(opts.title)}</div>
        ${opts.bodyHtml ? `<div class="m-body">${opts.bodyHtml}</div>` : ''}
        <div class="m-fields">
          ${opts.fields.map(fieldHtml).join('')}
        </div>
        <div class="m-status"></div>
        <div class="m-footer">
          ${(opts.actions ?? []).map((a, i) => `<button class="m-action" data-i="${i}">${esc(a.label)}</button>`).join('')}
          <span class="m-spacer"></span>
          <button class="m-cancel">取消</button>
          <button class="m-submit primary">${esc(opts.submitLabel ?? '确定')}</button>
        </div>
      </div>`
    document.body.appendChild(overlay)
    const statusEl = overlay.querySelector<HTMLElement>('.m-status')!

    const values = (): Record<string, string> => {
      const out: Record<string, string> = {}
      for (const f of opts.fields) {
        const el = overlay.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${f.key}"]`)
        if (!el) continue
        out[f.key] = f.type === 'checkbox' ? String((el as HTMLInputElement).checked) : el.value
      }
      return out
    }

    const close = (result: Record<string, string> | null): void => {
      overlay.querySelectorAll('audio').forEach((a) => a.pause())
      overlay.remove()
      resolve(result)
    }

    const ui: ModalUi = {
      setField: (key, value) => {
        const el = overlay.querySelector<HTMLInputElement>(`[name="${key}"]`)
        if (el) el.value = value
      },
      statusEl,
    }

    if (opts.onChange) {
      for (const f of opts.fields) {
        overlay.querySelector(`[name="${f.key}"]`)?.addEventListener('change', () => opts.onChange!(f.key, values(), ui))
      }
    }

    overlay.querySelector('.m-cancel')!.addEventListener('click', () => close(null))
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null)
    })
    overlay.querySelector('.m-submit')!.addEventListener('click', () => {
      const v = values()
      const err = opts.validate?.(v)
      if (err) {
        statusEl.innerHTML = `<span class="m-err">${esc(err)}</span>`
        return
      }
      close(v)
    })
    overlay.querySelectorAll<HTMLElement>('.m-action').forEach((btn) => {
      btn.addEventListener('click', () => {
        void opts.actions![Number(btn.dataset.i)].handler(values(), statusEl, ui)
      })
    })
    overlay.querySelector<HTMLElement>('input, textarea, select')?.focus()
  })
}

function fieldHtml(f: ModalField): string {
  const label = `<label>${esc(f.label)}</label>`
  const hint = f.hint ? `<div class="m-hint">${esc(f.hint)}</div>` : ''
  if (f.type === 'textarea') {
    return `<div class="m-field">${label}<textarea name="${f.key}" rows="3" placeholder="${esc(f.placeholder ?? '')}">${esc(String(f.value ?? ''))}</textarea>${hint}</div>`
  }
  if (f.type === 'select') {
    const opts = (f.options ?? [])
      .map((o) => `<option value="${esc(o)}" ${o === f.value ? 'selected' : ''}>${esc(o)}</option>`)
      .join('')
    return `<div class="m-field">${label}<select name="${f.key}">${opts}</select>${hint}</div>`
  }
  if (f.type === 'checkbox') {
    return `<div class="m-field m-check"><label><input type="checkbox" name="${f.key}" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>${hint}</div>`
  }
  return `<div class="m-field">${label}<input type="${f.type === 'number' ? 'number' : 'text'}" name="${f.key}" value="${esc(String(f.value ?? ''))}" placeholder="${esc(f.placeholder ?? '')}">${hint}</div>`
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
