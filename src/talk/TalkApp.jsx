import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import MaskParticles, { MOUTH_DEFAULT } from '../scene/MaskParticles.jsx'
import { Narration } from './audio.js'
import './talk.css'

const DEFAULTS = {
  // 音画同步
  gain: 1.0,      // 张口幅度
  jaw: 1.0,       // 下颌下坠权重
  fade: 0.85,     // 唇缝剥离（开口处压暗）
  wideGain: 1.0,  // 元音宽窄
  release: 1.0,   // 回落速度
  nod: 0.055,     // 点头幅度
  // 口型定位（量自 mask.glb 的中轴剖面）
  my: MOUTH_DEFAULT.y,
  mhw: MOUTH_DEFAULT.hw,
  mhh: MOUTH_DEFAULT.hh,
  // 画面
  size: 46,
  sway: 0.34
}

const PRESETS = {
  沉静: { gain: 0.60, jaw: 0.55, fade: 0.55, wideGain: 0.5, release: 1.4, nod: 0.03 },
  稳重: { gain: 1.00, jaw: 1.00, fade: 0.85, wideGain: 1.0, release: 1.0, nod: 0.055 },
  生动: { gain: 1.35, jaw: 1.25, fade: 0.95, wideGain: 1.5, release: 0.9, nod: 0.085 },
  夸张: { gain: 1.95, jaw: 1.75, fade: 1.00, wideGain: 1.9, release: 0.75, nod: 0.12 }
}

const SLIDERS = [
  { group: '音画同步 · 口型怎么动', key: 'gain', label: '张口幅度', hint: '包络 → 开口量的增益', min: 0, max: 2.5, step: 0.02, fmt: (v) => v.toFixed(2) + '×' },
  { key: 'jaw', label: '下颌下坠', hint: '0 = 只分唇，1 = 下巴跟着掉', min: 0, max: 2, step: 0.02, fmt: (v) => v.toFixed(2) + '×' },
  { key: 'fade', label: '唇缝剥离', hint: '开口处把粒子压暗，撑出"洞"', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: 'wideGain', label: '元音宽窄', hint: '低频/中频比 → 口型横向', min: 0, max: 2, step: 0.02, fmt: (v) => v.toFixed(2) + '×' },
  { key: 'release', label: '回落速度', hint: '越大合嘴越快', min: 0.2, max: 2.5, step: 0.02, fmt: (v) => v.toFixed(2) + '×' },
  { key: 'nod', label: '点头幅度', hint: '跟着音节轻微俯仰', min: 0, max: 0.25, step: 0.005, fmt: (v) => v.toFixed(3) },

  { group: '口型定位 · 量自 mask.glb', key: 'my', label: '唇线高度 y', hint: '实测唇间沟 ≈ -0.176', min: -0.28, max: -0.08, step: 0.002, fmt: (v) => v.toFixed(3) },
  { key: 'mhw', label: '嘴宽（半宽）', hint: '实测 ≈ 0.19，几乎横贯下半脸', min: 0.06, max: 0.30, step: 0.005, fmt: (v) => v.toFixed(3) },
  { key: 'mhh', label: '唇部范围', hint: '上下唇影响半径', min: 0.012, max: 0.075, step: 0.001, fmt: (v) => v.toFixed(3) },

  { group: '画面', key: 'size', label: '粒子大小', hint: '', min: 14, max: 62, step: 1, fmt: (v) => v.toFixed(0) },
  { key: 'sway', label: '摆动幅度', hint: '0 = 正对镜头', min: 0, max: 1.2, step: 0.01, fmt: (v) => v.toFixed(2) }
]

const mmss = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

/**
 * 调试参数（截图核验 / 出静帧用）：
 *   ?front=1   正面定格，不让指针视差把脸转开
 *   ?hold=0.8  把张口量锁在 0.8，配合 front 可以逐档检查口型
 *   ?nogate=1  跳过开场蒙层，直接看到面具
 *   ?panel=0   收起右侧参数面板
 */
const QS = new URLSearchParams(location.search)
const HOLD = QS.has('hold') ? Math.max(0, Number(QS.get('hold')) || 0) : null
const NOGATE = QS.get('nogate') === '1'
const FRONT = QS.get('front') === '1'
const PANEL0 = QS.get('panel') === '0'

export default function TalkApp() {
  const mouthRef = useRef({
    open: 0, wide: 0, nod: DEFAULTS.nod,
    y: MOUTH_DEFAULT.y, hw: MOUTH_DEFAULT.hw, hh: MOUTH_DEFAULT.hh,
    jaw: MOUTH_DEFAULT.jaw, fade: MOUTH_DEFAULT.fade
  })
  const cfgRef = useRef(DEFAULTS)
  const testRef = useRef(false)
  const progRef = useRef(0)

  const [params, setParams] = useState(DEFAULTS)
  const [ready, setReady] = useState(false)
  const [started, setStarted] = useState(NOGATE)
  const [playing, setPlaying] = useState(false)
  const [panelOpen, setPanelOpen] = useState(!PANEL0)
  const [preset, setPreset] = useState('稳重')
  const [testing, setTesting] = useState(false)
  const [lockFront, setLockFront] = useState(FRONT)
  const [replayKey, setReplayKey] = useState(0)

  const narr = useMemo(() => new Narration('./narration.mp3'), [])
  const barRef = useRef(null)
  const knobRef = useRef(null)
  const timeRef = useRef(null)
  const meterRef = useRef(null)
  const canvasRef = useRef(null)
  const recRef = useRef(null)
  const [recording, setRecording] = useState(false)

  const set = useCallback((k, v) => {
    cfgRef.current = { ...cfgRef.current, [k]: v }
    setParams(cfgRef.current)
    setPreset('')
  }, [])

  const applyPreset = useCallback((name) => {
    cfgRef.current = { ...cfgRef.current, ...PRESETS[name] }
    setParams(cfgRef.current)
    setPreset(name)
  }, [])

  const onProgress = useCallback((v) => {
    progRef.current = v
    if (v >= 0.995) setReady(true)
  }, [])

  /* —— 每帧：采样音频包络 → 写入 mouthRef → 顺手更新 UI —— */
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now

      const cfg = cfgRef.current
      let open
      let wide
      if (HOLD !== null) {
        open = HOLD * cfg.gain
        wide = 0
      } else if (testRef.current) {
        // 无音频时的合成口型：两个不同周期包络叠出"说话"的重音节奏，方便调参
        const tt = now / 1000
        const env = (Math.sin(tt * 5.1) * 0.5 + 0.5) * (Math.sin(tt * 1.7) * 0.35 + 0.65)
        open = Math.pow(env, 0.8) * cfg.gain
        wide = Math.sin(tt * 2.3) * 0.6 * cfg.wideGain
      } else {
        const s = narr.sample(dt, cfg)
        open = s.open
        wide = s.wide
      }

      const m = mouthRef.current
      m.open = open
      m.wide = wide
      m.nod = cfg.nod
      m.jaw = cfg.jaw
      m.fade = cfg.fade
      m.y = cfg.my
      m.hw = cfg.mhw
      m.hh = cfg.mhh

      // —— UI：进度条、时间、口型电平 ——
      const dur = narr.duration
      const cur = narr.currentTime
      const pct = dur > 0 ? Math.min(1, cur / dur) : 0
      if (barRef.current) barRef.current.style.width = (pct * 100).toFixed(2) + '%'
      if (knobRef.current) knobRef.current.style.left = (pct * 100).toFixed(2) + '%'
      if (timeRef.current) timeRef.current.textContent = `${mmss(cur)} / ${mmss(dur)}`

      const bars = meterRef.current?.children
      if (bars && bars.length) {
        for (let i = 0; i < bars.length; i++) {
          const v = Math.min(1, Math.max(0.08, open * (1.55 - i * 0.075)))
          bars[i].style.height = (v * 100).toFixed(0) + '%'
        }
      }

      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [narr])

  /* —— 播放控制 —— */
  const start = useCallback(async () => {
    setStarted(true)
    try {
      await narr.play()
      setPlaying(true)
    } catch (e) {
      console.warn('[talk] 音频启动失败：', e)
    }
  }, [narr])

  const toggle = useCallback(async () => {
    if (!started) return start()
    if (narr.playing) {
      narr.pause()
      setPlaying(false)
    } else {
      try {
        await narr.play()
        setPlaying(true)
      } catch (e) {
        console.warn('[talk] 恢复播放失败：', e)
      }
    }
  }, [narr, started, start])

  useEffect(() => {
    narr.onEnded = () => setPlaying(false)
    return () => { narr.onEnded = null }
  }, [narr])

  // 预加载音频元数据：不这样做，进度条的时长要等到点"开始"之后才出现
  useEffect(() => {
    narr.ensure()
  }, [narr])

  // 控制台上手调：__TALK__.mouth 看当前口型量，__TALK__.set('gain', 1.4) 改参数
  useEffect(() => {
    window.__TALK__ = {
      mouth: mouthRef.current,
      cfg: cfgRef,
      narr,
      set: (k, v) => { cfgRef.current = { ...cfgRef.current, [k]: v } }
    }
    return () => { delete window.__TALK__ }
  }, [narr])

  /* —— 空格播放/暂停 —— */
  useEffect(() => {
    const onKey = (e) => {
      if (e.target?.tagName === 'INPUT') return
      if (e.code === 'Space') { e.preventDefault(); toggle() }
      if (e.key === 'r' || e.key === 'R') setReplayKey((k) => k + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  const seek = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    const r = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))
    if (narr.duration) narr.seek(r * narr.duration)
  }

  const reset = () => {
    cfgRef.current = { ...DEFAULTS }
    setParams(cfgRef.current)
    setPreset('稳重')
  }

  /* —— 边放边录：canvas 画面 + 讲解音轨合成一个 webm —— */
  const startRec = useCallback(async () => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!narr.ctx) await narr.arm()

    const dest = narr.ctx.createMediaStreamDestination()
    narr.analyser.connect(dest)
    const vs = canvas.captureStream(30)
    const stream = new MediaStream([...vs.getVideoTracks(), ...dest.stream.getAudioTracks()])

    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm'
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 })
    const chunks = []
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `青铜面具讲解_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 15000)
      try { dest.disconnect() } catch (e) { /* 已经断开就忽略 */ }
      window.__LAST_REC_SIZE__ = blob.size
      setRecording(false)
    }
    rec.start(1000)
    recRef.current = rec
    setRecording(true)
  }, [narr])

  const stopRec = useCallback(() => {
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop()
  }, [])

  const toggleRec = useCallback(() => {
    if (recording) stopRec()
    else startRec()
  }, [recording, startRec, stopRec])

  return (
    <div className="talk-stage">
      <Canvas
        camera={{ position: [0, 0, 42], fov: 13.5, near: 0.1, far: 220 }}
        dpr={[1, 1.8]}
        gl={{ antialias: true, alpha: false, preserveDrawingBuffer: true }}
        onCreated={({ gl }) => {
          gl.setClearColor('#07060a')
          // captureStream 抓 WebGL 画布时，不保帧缓冲很容易录出全黑的视频
          canvasRef.current = gl.domElement
        }}
      >
        <color attach="background" args={['#07060a']} />
        <MaskParticles
          autoRotate
          replayKey={replayKey}
          mouthRef={mouthRef}
          onProgress={onProgress}
          swayGain={params.sway / 0.56}
          lockFront={lockFront}
          scaleGain={1.18}
          shiftX={panelOpen && !PANEL0 ? -0.55 : 0}
          pointSize={params.size}
        />
      </Canvas>

      <div className="vignette" />
      <div className="grain" />

      <header className="talk-top">
        <div className="brand">
          <span className="zh">青铜大面具</span>
          <span className="en">BRONZE MASK · SPEAKING RECONSTRUCTION</span>
          <div className="sub">
            面具在讲 <b>《吉金万里》</b> · 三星堆 · 商代
          </div>
        </div>
      </header>

      {/* —— 参数面板 —— */}
      {started && (
      <aside className={`panel ${panelOpen ? '' : 'closed'}`} data-ui>
        <div className="panel-head">
          <div className="t">
            口型参数
            <small>PARAMETERS</small>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="x" onClick={reset} title="恢复默认">
              ↺
            </button>
            <button className="x" onClick={() => setPanelOpen(false)} title="收起">
              ×
            </button>
          </div>
        </div>
        <div className="panel-body">
          <div className="group-t">预设</div>
          <div className="presets">
            {Object.keys(PRESETS).map((k) => (
              <button key={k} className={preset === k ? 'on' : ''} onClick={() => applyPreset(k)}>
                {k}
              </button>
            ))}
          </div>

          {SLIDERS.map((s, i) => (
            <React.Fragment key={s.key}>
              {s.group && <div className="group-t">{s.group}</div>}
              <div className="row">
                <div className="lab">
                  <span>
                    {s.label}
                    {s.hint ? <em> · {s.hint}</em> : null}
                  </span>
                  <b>{s.fmt(params[s.key])}</b>
                </div>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={params[s.key]}
                  onChange={(e) => set(s.key, Number(e.target.value))}
                />
              </div>
            </React.Fragment>
          ))}

          <div className="group-t">开关</div>
          <div className="toggle-row">
            <span>试口型（不用音频）</span>
            <div
              className={`switch ${testing ? 'on' : ''}`}
              onClick={() => {
                const v = !testing
                setTesting(v)
                testRef.current = v
              }}
            />
          </div>
          <div className="toggle-row">
            <span>正面定格</span>
            <div className={`switch ${lockFront ? 'on' : ''}`} onClick={() => setLockFront((v) => !v)} />
          </div>
        </div>
      </aside>
      )}

      <button className={`handle ${!panelOpen && started ? 'show' : ''}`} onClick={() => setPanelOpen(true)} data-ui>
        参数
      </button>

      {/* —— 进度 —— */}
      <div className="now">
        <div className="cap">NARRATION · 十幕讲解</div>
        <div className="title">
          吉金万里<span>东莞市博物馆 · 特展导览</span>
        </div>
        <div className="bar" onClick={seek} style={{ pointerEvents: 'auto', cursor: 'pointer' }}>
          <i ref={barRef} />
          <div className="knob" ref={knobRef} />
        </div>
        <div className="meta">
          <span ref={timeRef}>00:00 / 00:00</span>
          <span>{playing ? '播放中' : started ? '已暂停' : '待开始'}</span>
        </div>
        <div className="meter" ref={meterRef}>
          {Array.from({ length: 14 }, (_, i) => (
            <i key={i} />
          ))}
        </div>
        <div className="credit">
          三维面具 Sanxingdui Mask Model / Mark_Peach（Sketchfab）· CC-BY-4.0
          <br />
          讲解配音由《吉金万里》十幕文稿 TTS 生成
        </div>
      </div>

      <div className="tools" data-ui>
        <button className={playing ? 'on' : ''} onClick={toggle}>
          {playing ? '暂停' : started ? '继续' : '开始'}
        </button>
        <button onClick={() => setReplayKey((k) => k + 1)}>重播</button>
        <button className={recording ? 'on' : ''} onClick={toggleRec}>
          {recording ? '停止录制' : '录制'}
        </button>
      </div>

      {/* —— 开场 —— */}
      <div className={`gate ${started ? 'hide' : ''}`}>
        <div className="lead">{ready ? '青铜神像，准备开口' : '点云生成中…'}</div>
        <button className="play" onClick={start} disabled={!ready}>
          <span className="tri" />
          {ready ? '开 始 讲 解' : '加 载 中'}
        </button>
        <div className="sub">点击后播放讲解音频，面具随之动口型</div>
      </div>
    </div>
  )
}
