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

  playBgm(file: string | null, fadeMs = 0): void {
    this.stopBgm()
    if (!file) return
    const a = new Audio(encodeURI('/' + file))
    a.loop = true
    a.volume = fadeMs > 0 ? 0 : this.bgmVolume
    a.play().catch(() => {})
    this.bgm = a
    if (fadeMs > 0) this.fadeTo(a, this.bgmVolume, fadeMs)
  }

  stopBgm(): void {
    this.bgm?.pause()
    this.bgm = null
  }

  playVoice(file: string | null, onEnd?: () => void): void {
    this.stopVoice()
    if (!file) return
    const a = new Audio(encodeURI('/' + file))
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
