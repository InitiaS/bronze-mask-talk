/**
 * 讲解音频的包络分析。
 *
 * 面具是个静态摄影测量壳体，没有骨骼，所以"开口"只能靠音频包络去驱动一个
 * 解析式形变。这里做两件事：
 *  1) 从时域波形算 RMS → 张口量 open（带非对称平滑：起音快、回落慢）
 *  2) 从频域能量比粗略区分"宽元音 / 窄元音" → wide，用来轻微改变口型横向宽度
 *
 * 刻意不做音素识别：几十毫秒级的 viseme 分类在这种点云上读不出来，
 * 反而会因为误判让嘴乱跳。宁可少动、动得对。
 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

export class Narration {
  constructor(url) {
    this.url = url
    this.audio = null
    this.ctx = null
    this.analyser = null
    this.tdBuf = null
    this.fdBuf = null
    this.binHz = 44.1 / 1024
    this.open = 0
    this.wide = 0
    this.rms = 0
    this.ref = 0.22   // 峰值跟随器的起点，跑起来两三个音节就收敛了
    this.peak = 0
    this.onEnded = null
  }

  ensure() {
    if (this.audio) return this.audio
    const a = new Audio()
    a.src = this.url
    a.preload = 'auto'
    a.crossOrigin = 'anonymous'
    a.addEventListener('ended', () => this.onEnded?.())
    this.audio = a
    return a
  }

  /** 建 AudioContext 必须在用户手势里调用，否则浏览器会把 ctx 挂起 */
  async arm() {
    const a = this.ensure()
    if (this.ctx) return
    const AC = window.AudioContext || window.webkitAudioContext
    const ctx = new AC()
    const src = ctx.createMediaElementSource(a)
    const an = ctx.createAnalyser()
    an.fftSize = 1024
    an.smoothingTimeConstant = 0.55
    src.connect(an)
    an.connect(ctx.destination)
    this.ctx = ctx
    this.analyser = an
    this.tdBuf = new Uint8Array(an.fftSize)
    this.fdBuf = new Uint8Array(an.frequencyBinCount)
    this.binHz = ctx.sampleRate / an.fftSize
  }

  async play() {
    await this.arm()
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    await this.audio.play()
  }

  pause() {
    this.audio?.pause()
  }

  toggle() {
    if (!this.audio) return this.play()
    if (this.audio.paused) return this.play()
    this.pause()
  }

  seek(sec) {
    if (this.audio) this.audio.currentTime = Math.max(0, sec)
  }

  get duration() {
    const d = this.audio?.duration
    return Number.isFinite(d) ? d : 0
  }

  get currentTime() {
    return this.audio?.currentTime || 0
  }

  get playing() {
    return !!this.audio && !this.audio.paused && !this.audio.ended
  }

  /**
   * 每帧调用。dt 单位秒。返回 { open, wide, rms } 供写进 uniform。
   */
  sample(dt, { gain = 1, wideGain = 1, release = 1 } = {}) {
    const an = this.analyser
    if (!an || !this.playing) {
      // 停播/暂停时优雅回落，不能硬置 0（会瞬间"啪"地闭嘴）
      this.open += (0 - this.open) * Math.min(1, dt / 0.16)
      this.wide += (0 - this.wide) * Math.min(1, dt / 0.25)
      this.rms = 0
      return { open: this.open, wide: this.wide, rms: 0 }
    }

    an.getByteTimeDomainData(this.tdBuf)
    let sum = 0
    for (let i = 0; i < this.tdBuf.length; i++) {
      const v = (this.tdBuf[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / this.tdBuf.length)
    this.rms = rms

    // —— 自动标定 ——
    // 不同配音的电平能差好几倍（这版 TTS 有声段 RMS：p50=0.122、p95=0.275、max=0.43），
    // 写死阈值换成别的录音就全废。用一个峰值跟随器估当前满刻度：
    // 涨得快（0.3 s）、落得慢（6 s），于是快句子里它贴着峰值走，
    // 长静音里缓缓回落，不会被一次咳嗽带偏。floor 0.055 防止静音期把噪声放大。
    if (rms > this.ref) this.ref += (rms - this.ref) * Math.min(1, dt / 0.30)
    else this.ref += (rms - this.ref) * Math.min(1, dt / 6.0)
    this.ref = clamp(this.ref, 0.055, 0.6)

    // 这两个系数是拿整条 810 s 音频离线扫出来的：中位开口 0.495、p90 0.909、
    // 峰值饱和率只有 1.5% —— 既有明显口型，又不会一直张到最大
    const GATE = this.ref * 0.28   // 低于此视为句间停顿 → 闭嘴
    const TOP = this.ref * 1.15    // 高于此视为满张口
    let o = clamp((rms - GATE) / Math.max(1e-4, TOP - GATE), 0, 1)
    // 指数 0.62 把中低段抬起来，普通音节也有明显口型，不然只有重音才动
    o = Math.pow(o, 0.62) * gain

    // 起音快、回落慢：真实说话是"张得快、合得缓"，
    // 两端用同一时间常数会让口型显得黏滞
    const rel = 0.115 / Math.max(0.2, release)
    const k = o > this.open ? dt / 0.035 : dt / rel
    this.open += (o - this.open) * Math.min(1, k)
    this.open = clamp(this.open, 0, 1.6)
    if (this.open > this.peak) this.peak = this.open

    // 宽窄：低频（F1 区）相对中频（F2 区）越强，口型越"开而扁"
    an.getByteFrequencyData(this.fdBuf)
    const b = (hz) => Math.round(hz / this.binHz)
    let lowE = 0
    let midE = 0
    for (let i = b(90); i <= b(700); i++) lowE += this.fdBuf[i]
    for (let i = b(760); i <= Math.min(b(2600), this.fdBuf.length - 1); i++) midE += this.fdBuf[i]
    const w = clamp((lowE / (midE + 1e-3) - 1.15) * 0.55, -1, 1) * wideGain
    this.wide += (w - this.wide) * Math.min(1, dt / 0.09)

    return { open: this.open, wide: this.wide, rms }
  }
}
