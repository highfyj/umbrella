/** 服务端文件系统浏览器模态框：选目录（打开项目）或选文件（导入素材，带预览） */

export interface FsEntry {
  name: string
  isProject?: boolean
}

interface FsListResult {
  path: string
  parent: string | null
  dirs: FsEntry[]
  files: Array<{ name: string; size: number }>
  error?: string
}

export interface PickOptions {
  title: string
  mode: 'dir' | 'file'
  /** 文件模式下的扩展名过滤（小写、带点），空 = 不过滤 */
  exts?: string[]
  /** 起始目录；缺省用上次浏览位置 */
  startDir?: string
}

const LAST_DIR_KEY = 'vn-fs-last-dir'

export function isImageExt(name: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(name)
}

export function isAudioExt(name: string): boolean {
  return /\.(ogg|mp3|wav|m4a)$/i.test(name)
}

/** 浏览服务器（本机）文件系统，返回选中的绝对路径；取消返回 null */
export function pickPath(opts: PickOptions): Promise<string | null> {
  return new Promise((resolvePick) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal fsb">
        <div class="m-title">${esc(opts.title)}</div>
        <div class="fsb-nav">
          <button class="fsb-up" title="上级目录">⬆</button>
          <input class="fsb-path" spellcheck="false">
          <button class="fsb-go">转到</button>
        </div>
        <div class="fsb-body">
          <div class="fsb-list"></div>
          <div class="fsb-preview"><div class="fsb-preview-empty">点击文件可预览</div></div>
        </div>
        <div class="m-status"></div>
        <div class="m-footer">
          <span class="m-spacer"></span>
          <button class="m-cancel">取消</button>
          <button class="m-submit primary" disabled>${opts.mode === 'dir' ? '选择此目录' : '选择文件'}</button>
        </div>
      </div>`
    document.body.appendChild(overlay)

    const pathInput = overlay.querySelector<HTMLInputElement>('.fsb-path')!
    const listEl = overlay.querySelector<HTMLElement>('.fsb-list')!
    const previewEl = overlay.querySelector<HTMLElement>('.fsb-preview')!
    const statusEl = overlay.querySelector<HTMLElement>('.m-status')!
    const submitBtn = overlay.querySelector<HTMLButtonElement>('.m-submit')!
    const upBtn = overlay.querySelector<HTMLButtonElement>('.fsb-up')!

    let current: FsListResult | null = null
    let selectedFile: string | null = null

    const close = (result: string | null): void => {
      previewEl.querySelector('audio')?.pause()
      overlay.remove()
      resolvePick(result)
    }

    const showPreview = (absPath: string, name: string): void => {
      const url = `/api/fs/file?path=${encodeURIComponent(absPath)}&t=${Date.now()}`
      if (isImageExt(name)) previewEl.innerHTML = `<img src="${url}" alt="">`
      else if (isAudioExt(name)) previewEl.innerHTML = `<div class="fsb-preview-name">${esc(name)}</div><audio controls autoplay src="${url}"></audio>`
      else previewEl.innerHTML = `<div class="fsb-preview-empty">该类型不支持预览</div>`
    }

    const load = async (dir: string): Promise<void> => {
      statusEl.textContent = ''
      let r: FsListResult
      try {
        const q = new URLSearchParams({ path: dir })
        r = (await (await fetch(`/api/fs/list?${q}`)).json()) as FsListResult
      } catch (err) {
        statusEl.innerHTML = `<span class="m-err">读取目录失败：${esc(String(err))}</span>`
        return
      }
      if (r.error) {
        statusEl.innerHTML = `<span class="m-err">${esc(r.error)}</span>`
        return
      }
      current = r
      selectedFile = null
      submitBtn.disabled = opts.mode === 'file'
      pathInput.value = r.path
      localStorage.setItem(LAST_DIR_KEY, r.path)
      upBtn.disabled = !r.parent

      const exts = (opts.exts ?? []).map((e) => e.toLowerCase())
      const files = opts.mode === 'dir' ? [] : r.files.filter((f) => !exts.length || exts.some((e) => f.name.toLowerCase().endsWith(e)))
      listEl.innerHTML =
        r.dirs
          .map(
            (d, i) =>
              `<div class="fsb-item fsb-dir" data-dir="${i}">📁 ${esc(d.name)}${d.isProject ? '<span class="fsb-proj">VN 项目</span>' : ''}</div>`,
          )
          .join('') +
        files
          .map(
            (f, i) =>
              `<div class="fsb-item fsb-file" data-file="${i}">${isImageExt(f.name) ? '🖼' : isAudioExt(f.name) ? '♪' : '📄'} ${esc(f.name)}<span class="fsb-size">${fmtSize(f.size)}</span></div>`,
          )
          .join('')
      if (!listEl.innerHTML) listEl.innerHTML = `<div class="fsb-empty">（${opts.mode === 'dir' ? '无子目录' : '无匹配文件'}）</div>`

      for (const el of listEl.querySelectorAll<HTMLElement>('.fsb-dir')) {
        const d = r.dirs[Number(el.dataset.dir)]
        el.addEventListener('dblclick', () => void load(joinPath(r.path, d.name)))
        el.addEventListener('click', () => {
          listEl.querySelectorAll('.fsb-item').forEach((x) => x.classList.remove('sel'))
          el.classList.add('sel')
        })
      }
      for (const el of listEl.querySelectorAll<HTMLElement>('.fsb-file')) {
        const f = files[Number(el.dataset.file)]
        el.addEventListener('click', () => {
          listEl.querySelectorAll('.fsb-item').forEach((x) => x.classList.remove('sel'))
          el.classList.add('sel')
          selectedFile = joinPath(r.path, f.name)
          submitBtn.disabled = false
          showPreview(selectedFile, f.name)
        })
        el.addEventListener('dblclick', () => {
          selectedFile = joinPath(r.path, f.name)
          close(selectedFile)
        })
      }
    }

    upBtn.addEventListener('click', () => {
      if (current?.parent) void load(current.parent)
    })
    overlay.querySelector('.fsb-go')!.addEventListener('click', () => void load(pathInput.value))
    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void load(pathInput.value)
    })
    overlay.querySelector('.m-cancel')!.addEventListener('click', () => close(null))
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null)
    })
    submitBtn.addEventListener('click', () => {
      if (opts.mode === 'dir') {
        // 选中高亮的子目录优先，否则当前目录
        const sel = listEl.querySelector<HTMLElement>('.fsb-dir.sel')
        const dir = sel && current ? joinPath(current.path, current.dirs[Number(sel.dataset.dir)].name) : current?.path
        if (dir) close(dir)
      } else if (selectedFile) {
        close(selectedFile)
      }
    })

    void load(opts.startDir ?? localStorage.getItem(LAST_DIR_KEY) ?? '~')
  })
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
