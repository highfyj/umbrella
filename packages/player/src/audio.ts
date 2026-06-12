/**
 * 三通道音频：voice / BGM / SE，独立音量；语音播放时 BGM ducking。
 * 文件缺失（file=null）= 静默占位，不报错。
 */
export class AudioChannels {
  bgmVolume = 0.6
  voiceVolume = 1.0
  seVolume = 0.8
  private duck = 0.3

  private bgm: HTMLAudioElement | null = null
  private voice: HTMLAudioElement | null = null
  /** 被浏览器自动播放策略拦下的 BGM：等下一次用户交互补播 */
  private pendingBgm: { file: string; fadeMs: number } | null = null
  /** 静音跨预览重启/刷新保持（编辑器每次保存都会重建播放器实例） */
  private mutedState = localStorage.getItem('vn-muted') === '1'

  get muted(): boolean {
    return this.mutedState
  }

  setMuted(m: boolean): void {
    this.mutedState = m
    localStorage.setItem('vn-muted', m ? '1' : '0')
    if (this.bgm) this.bgm.muted = m
    if (this.voice) this.voice.muted = m
  }

  private readonly retryPending = (): void => {
    if (!this.pendingBgm) return
    const { file, fadeMs } = this.pendingBgm
    this.pendingBgm = null
    this.playBgm(file, fadeMs)
  }

  constructor() {
    // 无用户手势时 play() 必被拒（播放器刚加载、编辑器保存后程序化重启预览都如此），
    // 在交互事件的调用栈内补播才能通过各浏览器的自动播放策略
    window.addEventListener('pointerdown', this.retryPending, true)
    window.addEventListener('keydown', this.retryPending, true)
  }

  dispose(): void {
    this.stopVoice()
    this.stopBgm()
    window.removeEventListener('pointerdown', this.retryPending, true)
    window.removeEventListener('keydown', this.retryPending, true)
  }

  playBgm(file: string | null, fadeMs = 0): void {
    this.stopBgm()
    if (!file) return
    const a = new Audio(encodeURI('/' + file))
    a.loop = true
    a.muted = this.mutedState
    a.volume = fadeMs > 0 ? 0 : this.bgmVolume
    a.play().catch(() => {
      if (a === this.bgm) this.pendingBgm = { file, fadeMs }
    })
    this.bgm = a
    if (fadeMs > 0) this.fadeTo(a, this.bgmVolume, fadeMs)
  }

  stopBgm(): void {
    this.pendingBgm = null
    this.bgm?.pause()
    this.bgm = null
  }

  playVoice(file: string | null, onEnd?: () => void): void {
    this.stopVoice()
    if (!file) return
    const a = new Audio(encodeURI('/' + file))
    a.muted = this.mutedState
    a.volume = this.voiceVolume
    if (this.bgm) this.bgm.volume = this.bgmVolume * this.duck
    a.onended = () => {
      if (this.bgm) this.bgm.volume = this.bgmVolume
      onEnd?.()
    }
    a.play().catch(() => {})
    this.voice = a
  }

  stopVoice(): void {
    if (this.voice) {
      this.voice.onended = null
      this.voice.pause()
      this.voice = null
      if (this.bgm) this.bgm.volume = this.bgmVolume
    }
  }

  playSe(file: string | null): void {
    if (!file) return
    const a = new Audio(encodeURI('/' + file))
    a.muted = this.mutedState
    a.volume = this.seVolume
    a.play().catch(() => {})
  }

  private fadeTo(a: HTMLAudioElement, target: number, ms: number): void {
    const steps = Math.max(1, Math.floor(ms / 50))
    let i = 0
    const start = a.volume
    const timer = setInterval(() => {
      i++
      a.volume = start + ((target - start) * i) / steps
      if (i >= steps || a !== this.bgm) clearInterval(timer)
    }, 50)
  }
}
