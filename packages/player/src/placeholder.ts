/** 占位渲染：缺失资产时的兜底视觉，调试不中断 */

export function hashColor(name: string, sat = 35, light = 26): string {
  let h = 0
  for (const c of name) h = (h * 31 + (c.codePointAt(0) ?? 0)) | 0
  return `hsl(${((h % 360) + 360) % 360} ${sat}% ${light}%)`
}

/** 背景占位：按名称哈希取色 + 资源名水印 */
export function applyBgPlaceholder(el: HTMLElement, name: string): void {
  el.style.backgroundImage = 'none'
  el.style.backgroundColor = hashColor(name)
  el.dataset.placeholder = name
}

export function applyBgImage(el: HTMLElement, file: string): void {
  el.style.backgroundColor = '#000'
  el.style.backgroundImage = `url(${encodeURI('/' + file)})`
  delete el.dataset.placeholder
}

/** 立绘占位：角色主题色剪影 + 维度标签 */
export function spriteContent(who: string, combo: string, file: string | null, color: string | undefined): HTMLElement {
  if (file) {
    const img = document.createElement('img')
    img.src = encodeURI('/' + file)
    img.alt = `${who} ${combo}`
    img.className = 'sprite-img'
    return img
  }
  const div = document.createElement('div')
  div.className = 'sprite-placeholder'
  div.style.background = `linear-gradient(180deg, ${color ?? hashColor(who, 40, 40)} 0%, transparent 100%)`
  const label = document.createElement('div')
  label.className = 'sprite-label'
  label.textContent = `${who}\n${combo.replaceAll('|', ' / ')}`
  div.appendChild(label)
  return div
}
