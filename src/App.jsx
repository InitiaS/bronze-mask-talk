import React, { useEffect, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import MaskParticles from './scene/MaskParticles.jsx'

export default function App() {
  const [autoRotate, setAutoRotate] = useState(true)
  const [replayKey, setReplayKey] = useState(0)
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const id = setInterval(() => {
      if (window.__MASK_PARTICLE_COUNT__) {
        setCount(window.__MASK_PARTICLE_COUNT__)
        setLoading(false)
        clearInterval(id)
      }
    }, 120)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="stage">
      <Canvas
        camera={{ position: [0, 0, 42], fov: 13.5, near: 0.1, far: 220 }}
        dpr={[1, 1.8]}
        gl={{ antialias: true, alpha: false }}
        onCreated={({ gl }) => gl.setClearColor('#07060a')}
      >
        <color attach="background" args={['#07060a']} />
        <MaskParticles autoRotate={autoRotate} replayKey={replayKey} />
      </Canvas>

      <div className="vignette" />
      <div className="grain" />

      <header className="ui top">
        <div className="brand">
          <span className="zh">青铜大面具</span>
          <span className="en">BRONZE MASK · PARTICLE RECONSTRUCTION</span>
        </div>
        <div className="meta">
          <span className="dot" />
          三星堆 · 商代
        </div>
      </header>

      <div className="ui controls">
        <button
          className={`btn ${autoRotate ? 'on' : ''}`}
          onClick={() => setAutoRotate((v) => !v)}
        >
          <span className="led" />
          {autoRotate ? '自动旋转 · 开' : '自动旋转 · 关'}
        </button>
        <button className="btn" onClick={() => setReplayKey((k) => k + 1)}>
          重播汇聚
        </button>
        <a className="btn btn-face" href="/face.html">
          <span className="led" />
          戴 上 它
        </a>
      </div>

      <footer className="ui bottom">
        <div className="hint">
          <span>拖拽 / 移动鼠标</span> 视差旋转
          <i />
          <span>划过面具</span> 吹散粒子
          <i />
          <span>滚轮</span> 推拉镜头
        </div>
        <div className="stat">
          <b>{count ? count.toLocaleString('en-US') : '—'}</b>
          <span>PARTICLES</span>
        </div>
      </footer>

      <div className={`loader ${loading ? '' : 'hide'}`}>
        <div className="ring" />
        <p>点云生成中…</p>
      </div>
    </div>
  )
}
