import type { StoryIR } from '@vn/core'

interface GraphNode {
  id: string
  kind: 'scene' | 'ending'
  title: string
  layer: number
  row: number
}

interface GraphEdge {
  from: string
  to: string
  labels: string[]
}

/** 从 IR 生成只读剧情流程图（SVG）。点击场景节点回调 onOpenScene。 */
export function renderGraph(container: HTMLElement, ir: StoryIR, onOpenScene: (sceneId: string) => void): void {
  const edges = collectEdges(ir)
  const nodes = layout(ir, edges)

  const W = 200
  const H = 64
  const GX = 110
  const GY = 36
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const x = (n: GraphNode) => 40 + n.layer * (W + GX)
  const y = (n: GraphNode) => 40 + n.row * (H + GY)

  const maxLayer = Math.max(...nodes.map((n) => n.layer), 0)
  const maxRow = Math.max(...nodes.map((n) => n.row), 0)
  const width = 80 + (maxLayer + 1) * (W + GX)
  const height = 80 + (maxRow + 1) * (H + GY)

  const svgEdges = edges
    .map((e) => {
      const a = nodeMap.get(e.from)
      const b = nodeMap.get(e.to)
      if (!a || !b) return ''
      const x1 = x(a) + W
      const y1 = y(a) + H / 2
      const x2 = x(b)
      const y2 = y(b) + H / 2
      const mx = (x1 + x2) / 2
      const label = e.labels.filter(Boolean).join(' / ')
      const labelSvg = label
        ? `<text x="${mx}" y="${(y1 + y2) / 2 - 8}" class="g-edge-label" text-anchor="middle">${esc(truncate(label, 16))}</text>`
        : ''
      return `<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" class="g-edge" marker-end="url(#arrow)"/>${labelSvg}`
    })
    .join('')

  const svgNodes = nodes
    .map((n) => {
      const cls = n.kind === 'ending' ? 'g-node g-ending' : 'g-node g-scene'
      const sub = n.kind === 'ending' ? '结局' : n.id
      return `
        <g class="${cls}" data-scene="${n.kind === 'scene' ? esc(n.id) : ''}" transform="translate(${x(n)},${y(n)})">
          <rect width="${W}" height="${H}" rx="10"/>
          <text x="${W / 2}" y="${H / 2 - 6}" text-anchor="middle" class="g-title">${esc(truncate(n.title, 12))}</text>
          <text x="${W / 2}" y="${H / 2 + 16}" text-anchor="middle" class="g-sub">${esc(sub)}</text>
        </g>`
    })
    .join('')

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#7d8bb5"/>
        </marker>
      </defs>
      ${svgEdges}
      ${svgNodes}
    </svg>`

  for (const g of container.querySelectorAll<SVGGElement>('.g-scene')) {
    g.addEventListener('click', () => {
      const id = g.dataset.scene
      if (id) onOpenScene(id)
    })
  }
}

function collectEdges(ir: StoryIR): GraphEdge[] {
  const map = new Map<string, GraphEdge>()
  const add = (from: string, to: string, label: string): void => {
    const key = `${from}→${to}`
    let e = map.get(key)
    if (!e) {
      e = { from, to, labels: [] }
      map.set(key, e)
    }
    if (label && !e.labels.includes(label)) e.labels.push(label)
  }

  for (const [sceneId, sc] of Object.entries(ir.scenes)) {
    for (const op of sc.ops) {
      if (op.op === 'jump') add(sceneId, op.scene, '')
      else if (op.op === 'choice') {
        for (const o of op.options) {
          if (o.target?.scene) add(sceneId, o.target.scene, o.text)
        }
      } else if (op.op === 'end') add(sceneId, `end:${op.ending}`, '')
    }
  }
  return [...map.values()]
}

function layout(ir: StoryIR, edges: GraphEdge[]): GraphNode[] {
  // BFS 分层：入口在第 0 层
  const layerOf = new Map<string, number>()
  const queue: Array<[string, number]> = [[ir.entry, 0]]
  while (queue.length) {
    const [id, layer] = queue.shift()!
    if (layerOf.has(id)) continue
    layerOf.set(id, layer)
    for (const e of edges.filter((e) => e.from === id)) queue.push([e.to, layer + 1])
  }
  // 未被引用的场景排到最后一层之后
  const maxLayer = Math.max(0, ...layerOf.values())
  for (const id of Object.keys(ir.scenes)) {
    if (!layerOf.has(id)) layerOf.set(id, maxLayer + 1)
  }

  const rows = new Map<number, number>()
  const nodes: GraphNode[] = []
  const push = (id: string, kind: GraphNode['kind'], title: string): void => {
    const layer = layerOf.get(id) ?? 0
    const row = rows.get(layer) ?? 0
    rows.set(layer, row + 1)
    nodes.push({ id, kind, title, layer, row })
  }
  for (const [id] of [...layerOf.entries()].sort((a, b) => a[1] - b[1])) {
    if (id.startsWith('end:')) {
      const ending = id.slice(4)
      push(id, 'ending', ir.endings[ending]?.title ?? ending)
    } else if (ir.scenes[id]) {
      push(id, 'scene', sceneTitle(ir, id))
    }
  }
  return nodes
}

function sceneTitle(ir: StoryIR, id: string): string {
  // IR 里暂未带场景 title，先用 id；编辑器可后续从源文件补
  return id
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
