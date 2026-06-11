/**
 * mulberry32：状态是单个 uint32，可直接序列化进存档。
 * 每次 next() 推进状态——已掷出的结果属于历史，回滚/回放绝不重掷。
 */
export class PRNG {
  constructor(public state: number) {
    this.state |= 0
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
