import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import maskUrl from '../assets/mask.jpg'
import { sampleMeshToPoints } from './sampleMesh'

/**
 * 只要 src/assets/ 下出现 mask.glb / mask.gltf / mask.stl / mask.obj / mask.ply，
 * 就自动改用真网格采样；没有则回退到"照片反推浮雕"。
 */
const MODEL_URLS = import.meta.glob('../assets/mask.{glb,gltf,stl,obj,ply}', {
  eager: true,
  query: '?url',
  import: 'default'
})

async function loadRealMesh() {
  const entries = Object.entries(MODEL_URLS)
  if (!entries.length) return null
  const [path, url] = entries[0]
  const ext = path.split('.').pop().toLowerCase()
  let root = null

  if (ext === 'glb' || ext === 'gltf') {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
    const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js')
    const loader = new GLTFLoader()
    loader.setMeshoptDecoder(MeshoptDecoder)
    root = (await loader.loadAsync(url)).scene
  } else if (ext === 'stl') {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js')
    const geo = await new STLLoader().loadAsync(url)
    if (!geo.getAttribute('normal')) geo.computeVertexNormals()
    root = new THREE.Mesh(geo, new THREE.MeshStandardMaterial())
  } else if (ext === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js')
    root = await new OBJLoader().loadAsync(url)
  } else if (ext === 'ply') {
    const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js')
    const geo = await new PLYLoader().loadAsync(url)
    if (!geo.getAttribute('normal')) geo.computeVertexNormals()
    root = new THREE.Mesh(geo, new THREE.MeshStandardMaterial())
  }

  if (!root) return null
  return await sampleMeshToPoints(root, 820000)
}

const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uProgress;
  uniform float uSize;
  uniform float uDpr;
  uniform float uFlat;
  uniform float uEyeDebug;
  uniform vec2 uMouse;
  uniform float uMouseStrength;
  uniform float uAspect;
  uniform float uTanHalfFov;
  // —— 开口讲解相关（默认全 0，对原页面没有任何影响）——
  uniform float uMouthY;     // 唇线所在 y（归一化坐标）
  uniform float uMouthHW;    // 嘴半宽
  uniform float uMouthHH;    // 唇部影响半径
  uniform float uOpen;       // 0..1 张口量（由音频包络驱动）
  uniform float uWide;       // 口型横向变化（元音宽窄）
  uniform float uJaw;        // 下颌下坠权重
  uniform float uLipFade;    // 唇线剥离强度（开口时把唇缝抹暗）
  attribute vec3 aColor;
  attribute vec3 aNorm;
  attribute vec3 aStart;
  attribute float aSize;
  attribute float aDelay;
  attribute float aRand;
  attribute float aOrder;
  attribute float aEye;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vShade;
  varying float vFacing;

  void main() {
    // 叙事分段：外轮廓先到（0.04 → 0.38），面中段随后填满（0.33 → 0.67），
    // 双眼最后点亮（0.60 → 0.94）
    float span = 0.34;
    float startAt = aOrder * (1.0 - span) + aDelay * 0.06;
    float pr = clamp((uProgress - startAt) / span, 0.0, 1.0);
    float p = pr * pr * (3.0 - 2.0 * pr);

    // —— 开口形变：在"目标位置"域里做，汇聚过程中口型就已经在了 ——
    // 这个模型是摄影测量出来的静态壳，没有骨骼，所以"张嘴"只能是解析式的
    // 区域性顶点位移：以唇线为轴，上下唇沿 y 反向让开，唇线以下的下颌整体下坠。
    float mdy = position.y - uMouthY;
    float mhw = uMouthHW * (1.0 + uWide * 0.16);
    // 横向收口：用椭圆而不是"平台 + 斜坡"。平顶两端有折角，张开时像被刀划的一道缝；
    // 椭圆收口让中间最开、嘴角慢慢收拢，才读得出是一张嘴。
    float mu = clamp(abs(position.x) / max(mhw, 1e-4), 0.0, 1.0);
    float mbx = pow(max(0.0, 1.0 - mu * mu), 0.55);
    // 纵向高斯：只让唇部附近参与，超过约 1.6 倍半径就完全不动
    float mbd = exp(-(mdy * mdy) / max(uMouthHH * uMouthHH, 1e-5));
    // sign(mdy) 在唇线上取 0，于是上下唇正好从唇线向两侧让开。
    // 但两片不能等分：面具的上唇长在刚性面壳上，真正能动的是下颌，
    // 所以上唇只给 0.35，下唇吃满 1.0，张开时才是"下巴掉下来"而不是"脸被撕开"。
    float sep = uOpen * 0.027 * mbx * mbd * sign(mdy) * (mdy > 0.0 ? 0.35 : 1.0);
    // 下颌下坠：越往下权重越大，做出"下巴掉下来"而不是"嘴被拉长"
    float jawMask = smoothstep(0.0, 0.115, -mdy) * mbx;
    float drop = -uOpen * uJaw * 0.029 * jawMask;

    vec3 tp = position;
    tp.y += sep + drop;
    // 张口时下唇略向前探，补一点立体感，避免看起来像被一刀切开
    tp.z += uOpen * 0.009 * mbx * mbd * max(-mdy, 0.0) / max(uMouthHH, 1e-5);

    // 唇缝权重：用来把开口处的粒子压暗/抹掉，让"洞"读得出来
    float mouthLine = mbx * exp(-(mdy * mdy) / max(pow(uMouthHH * 0.42, 2.0), 1e-6));
    // 唇缘受光：张口时上下唇的边沿应该亮一档，否则缺口只是"少了一层粒子"
    float lipRim = mbx * exp(-pow((abs(mdy) - uMouthHH * 1.15) / max(uMouthHH * 0.55, 1e-5), 2.0));

    vec3 pos = mix(aStart, tp, p);

    // 这一颗粒子刚就位的瞬间（用来做"描边亮一下"和"双眼点亮"）
    float arrivedAt = aOrder * (1.0 - span) + span;
    float sinceRaw = uProgress - arrivedAt;
    // 到达之前不能有 flash：之前用 clamp 会把"还没到"也算成 since=0，
    // 于是最大的爆闪正好落在最不该亮的那一批粒子上，整个轮廓糊成一团雾
    float flash = sinceRaw > 0.0 ? exp(-pow(sinceRaw / 0.055, 2.0)) : 0.0;
    float isContour = 1.0 - smoothstep(0.0, 0.34, aOrder);

    float t = uTime * 0.55 + aRand * 6.28318;
    // 汇聚完成后粒子基本"定住"，只留极轻的呼吸，避免抖动糊掉轮廓
    float drift = 0.34 * (1.0 - 0.62 * p);
    pos.z += sin(t) * 0.05 * p * drift;
    pos.x += cos(t * 0.7) * 0.03 * p * drift;
    pos.y += sin(t * 1.13) * 0.03 * p * drift;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);

    // 鼠标吹散：按屏幕距离把粒子从光标处推开，指针一走开就自己归位。
    // 判定用 NDC 距离（横向按宽高比拉齐），位移量按视空间深度换算，
    // 否则近处的点会被推得比远处猛得多。
    if (uMouseStrength > 0.001) {
      vec4 clip0 = projectionMatrix * mv;
      vec2 ndc = clip0.xy / max(clip0.w, 1e-4);
      ndc.x *= uAspect;
      vec2 dm = ndc - uMouse;
      float dist = length(dm);
      float infl = uMouseStrength * exp(-dist * dist / 0.012);
      if (infl > 0.002) {
        vec2 dir = dist > 1e-4 ? dm / dist : vec2(0.0, 1.0);
        float k = -mv.z * uTanHalfFov * 2.0;
        // 每颗粒子的推力和方向都不一样——统一径向推会切出一个边缘锐利的圆洞，
        // 打散之后才像"被气流吹开的粉尘"
        float rnd = 0.30 + aRand * 1.30;
        float ang = (aRand - 0.5) * 1.20;
        vec2 dir2 = vec2(dir.x * cos(ang) - dir.y * sin(ang), dir.x * sin(ang) + dir.y * cos(ang));
        mv.xy += dir2 * infl * 0.055 * k * rnd;
        mv.z += infl * 0.090 * k * rnd;
      }
    }

    gl_Position = projectionMatrix * mv;

    vec3 nv = normalize(normalMatrix * aNorm);

    // 朝向剔除：depthWrite 关掉之后，背面那层也会被画上来，
    // 正面形体就被"看穿"了。用逐点法线判正面，只留朝向相机的一层表面。
    vFacing = dot(nv, normalize(-mv.xyz));

    // 真实法线光照：体积感来自明暗过渡，而不是贴图
    // 主光偏右上做形体，再补一盏"跟机头灯"——否则背光那半边整片沉进黑里，
    // 面具只剩半个，读不出整体轮廓。
    vec3 L = normalize(vec3(-0.62, 0.52, 0.50));
    float diff = max(dot(nv, L), 0.0);
    float head = max(vFacing, 0.0);
    float rim = pow(1.0 - abs(nv.z), 2.4);
    vShade = 0.13 + 1.02 * diff + 0.16 * head + 0.12 * rim;
    // 诊断用：?flat=1 抹掉光照，只看点云本身的密度与轮廓
    if (uFlat > 0.5) vShade = 1.0;

    float twinkle = 0.96 + 0.06 * sin(uTime * 1.7 + aRand * 23.0);

    // 尺寸：轮廓就位时轻微鼓一下，眼睛点亮时明显放大
    // "点亮双眼"要分两层：到达瞬间的爆闪 + 之后一直留着的余辉，
    // 只做爆闪的话进度停在 1 之后眼睛就暗回去了，看不出"点亮"。
    float eyeOn = smoothstep(0.86, 0.99, uProgress);
    float sizeBoost = 1.0 + 0.85 * flash * isContour + aEye * (2.10 * flash + 0.45 * eyeOn);
    gl_PointSize = aSize * uSize * uDpr / max(-mv.z, 0.001) * (0.96 + 0.08 * twinkle) * sizeBoost;

    vColor = aColor;
    // 开口处的粒子压暗：唇缝要沉下去，不能被同样亮的粒子填满
    vColor *= 1.0 - 0.72 * uLipFade * uOpen * mouthLine;
    // 唇缘补光：青铜唇沿在张口时会吃到一点反射，这一档亮度就是"嘴"和"缺口"的区别
    vColor += vec3(0.42, 0.24, 0.07) * lipRim * min(1.0, uOpen) * 0.85;
    // 诊断用：?eye=1 把判定为"眼睛"的粒子染红，用来核对识别范围
    if (uEyeDebug > 0.5) vColor = mix(vec3(0.30, 0.30, 0.30), vec3(1.0, 0.16, 0.10), aEye);

    float eyeIdle = aEye * eyeOn * (0.55 + 0.22 * sin(uTime * 1.8 + aRand * 6.28318));

    // 还没轮到的粒子压到全透明：否则 70% 的粒子会在面具背后摊成一片雾，
    // "先勾轮廓、再填面、最后点眼"这三拍就完全读不出来。
    // 用未缓动的 pr 判断——缓动曲线前段涨得快，用缓动值会让远处那层雾过早显形。
    float appear = smoothstep(0.55, 0.97, pr);

    // 累加混合下，"暗部"只能靠压低 alpha 让出来，否则整片会被糊成一片沙
    float lit = mix(0.62, 1.0, p) * (0.62 + 0.38 * clamp(vShade, 0.0, 1.2));
    vAlpha = appear * twinkle * (0.78 + 0.22 * p) * lit
           * (1.0 + 1.10 * flash + 2.20 * aEye * flash + eyeIdle)
           * (1.0 - uLipFade * uOpen * mouthLine);
  }
`

const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vShade;
  varying float vFacing;

  void main() {
    // 背面直接丢掉；临界的掠射角软化过渡，轮廓不会出现硬锯齿
    float vis = smoothstep(-0.12, 0.16, vFacing);
    if (vis < 0.02) discard;
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float a = pow(smoothstep(0.5, 0.10, d), 1.40);
    vec3 c = vColor * vShade * (1.0 + 0.18 * a);
    gl_FragColor = vec4(c * 1.30, a * vAlpha * vis);
  }
`

const HIGH = new THREE.Color('#fff2ca')
const QS = new URLSearchParams(location.search)
const TURN = Number(QS.get('turn')) || 0
// 这个摄影测量模型本身是正的（-X 方向即正脸），不需要额外俯仰补偿
const PITCH_DEG = QS.has('pitch') ? Number(QS.get('pitch')) : 0
const STILL = location.search.includes('still')
// ?at=0.35 把汇聚定格在指定进度，方便逐帧检查叙事分段
const AT = QS.has('at') ? Math.min(1, Math.max(0, Number(QS.get('at')) || 0)) : null

/**
 * 唇线的默认位置。这些数不是猜的：把 mask.glb 按 sampleMeshToPoints 归一化后，
 * 沿中轴做 z-y 剖面，可以读到鼻尖在 y≈-0.085、鼻底在 y≈-0.11，
 * 唇上缘 y≈-0.163、唇间沟 y≈-0.176、唇下缘 y≈-0.197，
 * 横向几乎贯穿下半脸（三星堆面具的嘴本来就这么宽）。
 */
export const MOUTH_DEFAULT = {
  y: -0.176,
  hw: 0.19,
  hh: 0.030,
  jaw: 1.0,
  fade: 0.85
}

/* 3x3 盒式模糊：抹掉照片高光边缘的尖刺，只保留大形 */
function boxBlur(src, S) {
  const out = new Float32Array(S * S)
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      let sum = 0, n = 0
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj
        if (jj < 0 || jj >= S) continue
        for (let di = -1; di <= 1; di++) {
          const ii = i + di
          if (ii < 0 || ii >= S) continue
          sum += src[jj * S + ii]
          n++
        }
      }
      out[j * S + i] = sum / n
    }
  }
  return out
}

/* 从图片反推一副有厚度的面具壳：距离场 → 隆起高度场 → 法线 → 双面粒子 */
function buildFromImage(img) {
  const S = 780
  const cv = document.createElement('canvas')
  cv.width = S
  cv.height = S
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, S, S)
  const px = ctx.getImageData(0, 0, S, S).data

  // 亮度缓存
  const lumBuf = new Float32Array(S * S)
  let maxL = 0.001
  for (let q = 0; q < S * S; q++) {
    const k = q * 4
    const l = (0.299 * px[k] + 0.587 * px[k + 1] + 0.114 * px[k + 2]) / 255
    lumBuf[q] = l
    if (l > maxL) maxL = l
  }

  // 连通域：只保留与主体相连的大块，剔除背景光晕与孤立高光
  const bin = new Uint8Array(S * S)
  for (let q = 0; q < S * S; q++) bin[q] = lumBuf[q] > 0.12 ? 1 : 0
  const labels = new Int32Array(S * S).fill(-1)
  const queue = new Int32Array(S * S)
  const sizes = []
  for (let s0 = 0; s0 < S * S; s0++) {
    if (!bin[s0] || labels[s0] !== -1) continue
    let head = 0
    let tail = 0
    queue[tail++] = s0
    labels[s0] = sizes.length
    let n = 0
    while (head < tail) {
      const cur = queue[head++]
      n++
      const ci = cur % S
      const cj = (cur - ci) / S
      if (ci > 0) { const q = cur - 1; if (bin[q] && labels[q] === -1) { labels[q] = sizes.length; queue[tail++] = q } }
      if (ci < S - 1) { const q = cur + 1; if (bin[q] && labels[q] === -1) { labels[q] = sizes.length; queue[tail++] = q } }
      if (cj > 0) { const q = cur - S; if (bin[q] && labels[q] === -1) { labels[q] = sizes.length; queue[tail++] = q } }
      if (cj < S - 1) { const q = cur + S; if (bin[q] && labels[q] === -1) { labels[q] = sizes.length; queue[tail++] = q } }
    }
    sizes.push(n)
  }
  const maxSize = sizes.length ? Math.max(...sizes) : 0
  const keep = new Uint8Array(S * S)
  for (let q = 0; q < S * S; q++) {
    const lb = labels[q]
    if (lb >= 0 && sizes[lb] > Math.max(80, maxSize * 0.05)) keep[q] = 1
  }

  // 包围盒取自保留像素
  let minI = S, maxI = -1, minJ = S, maxJ = -1
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      if (!keep[j * S + i]) continue
      if (i < minI) minI = i
      if (i > maxI) maxI = i
      if (j < minJ) minJ = j
      if (j > maxJ) maxJ = j
    }
  }
  if (maxI < 0) { minI = 0; maxI = S - 1; minJ = 0; maxJ = S - 1 }

  // 倒角距离变换：每个点到轮廓的距离，用来生成圆润的隆起
  const dist = new Float32Array(S * S)
  for (let q = 0; q < S * S; q++) dist[q] = keep[q] ? 1e6 : 0
  const A = 1, B = Math.SQRT2
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const q = j * S + i
      if (dist[q] === 0) continue
      let m = dist[q]
      if (i > 0) m = Math.min(m, dist[q - 1] + A)
      if (j > 0) m = Math.min(m, dist[q - S] + A)
      if (i > 0 && j > 0) m = Math.min(m, dist[q - S - 1] + B)
      if (i < S - 1 && j > 0) m = Math.min(m, dist[q - S + 1] + B)
      dist[q] = m
    }
  }
  for (let j = S - 1; j >= 0; j--) {
    for (let i = S - 1; i >= 0; i--) {
      const q = j * S + i
      if (dist[q] === 0) continue
      let m = dist[q]
      if (i < S - 1) m = Math.min(m, dist[q + 1] + A)
      if (j < S - 1) m = Math.min(m, dist[q + S] + A)
      if (i < S - 1 && j < S - 1) m = Math.min(m, dist[q + S + 1] + B)
      if (i > 0 && j < S - 1) m = Math.min(m, dist[q + S - 1] + B)
      dist[q] = m
    }
  }
  let maxDist = 1
  for (let q = 0; q < S * S; q++) if (keep[q] && dist[q] > maxDist) maxDist = dist[q]

  const cx = (minI + maxI) / 2
  const cy = (minJ + maxJ) / 2
  const span = Math.max(maxI - minI + 1, maxJ - minJ + 1)
  const k = 1.0 / span
  const inv = 0.5 / k // 用于按世界单位求梯度

  // 两轮模糊：亮度场负责"大形"的起伏，不做高频雕刻
  const lumS = boxBlur(boxBlur(lumBuf, S), S)

  // 前表面高度场：距离场决定整体隆起，亮度决定鼻梁、颧骨等局部凸起
  const zF = new Float32Array(S * S)
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const q = j * S + i
      if (!keep[q] || lumBuf[q] < 0.12) continue
      const t = Math.min(1, lumS[q] / Math.max(maxL * 0.82, 0.55))
      const dn = Math.min(1, dist[q] / Math.max(1, maxDist * 0.92))
      const shell = Math.sqrt(dn)
      const taper = THREE.MathUtils.smoothstep(dn, 0.0, 0.12)
      zF[q] = (0.10 * shell + 0.34 * t) * taper
    }
  }

  // 高度场再平滑一次，法线才不会有高频毛刺
  const zS = boxBlur(boxBlur(zF, S), S)

  const pos = []
  const col = []
  const nrm = []
  const size = []
  const start = []
  const delay = []
  const rand = []

  const zAt = (i, j) => zS[Math.min(S - 1, Math.max(0, j)) * S + Math.min(S - 1, Math.max(0, i))]

  const pushPoint = (x, y, z, nx, ny, nz, c, s, flip) => {
    pos.push(x, y, z)
    nrm.push(nx * flip, ny * flip, nz * flip)
    col.push(c.r, c.g, c.b)
    size.push(s)
    // 起点贴着目标点：目标坐标是归一化 ±0.5，group 会再放大 ~7.2 倍，
    // 起点给 13~26 等于把粒子丢到画外一百多个单位，飞到 90% 都还看不见
    const a2 = Math.random() * Math.PI * 2
    if (Math.random() < 0.12) {
      const r = 0.30 + Math.random() * 0.80
      start.push(Math.cos(a2) * r, Math.sin(a2) * r * 0.70, -(1.20 + Math.random() * 2.20))
    } else {
      const b2 = Math.acos(2 * Math.random() - 1)
      const d = 0.12 + Math.random() * 0.30
      start.push(
        x + Math.sin(b2) * Math.cos(a2) * d,
        y + Math.cos(b2) * d * 0.80,
        z + Math.sin(b2) * Math.sin(a2) * d
      )
    }
    delay.push(Math.random() * 0.18)
    rand.push(Math.random())
  }

  const SHELL = 0.15 // 壳厚（以主体宽度 = 1 为单位），接近真实青铜面具的薄壳体

  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const q = j * S + i
      const l = lumBuf[q]
      if (l < 0.12 || !keep[q]) continue

      const t = Math.min(1, l / Math.max(maxL * 0.82, 0.55))
      const z0 = zS[q]

      // 法线由高度场梯度求得（y 轴像素朝下，世界朝上，故取负）
      const gx = (zAt(i + 1, j) - zAt(i - 1, j)) * inv * 0.7
      const gy = -(zAt(i, j + 1) - zAt(i, j - 1)) * inv * 0.7
      let nx = -gx, ny = -gy, nz = 1
      const nl = Math.hypot(nx, ny, nz) || 1
      nx /= nl; ny /= nl; nz /= nl

      const x = (i - cx) * k + (Math.random() - 0.5) * k * 0.95
      const y = -(j - cy) * k + (Math.random() - 0.5) * k * 0.95
      const zc = z0 - 0.20

      // 逐像素真实颜色，稍作压暗/提亮
      const pk = q * 4
      const c = new THREE.Color(px[pk] / 255, px[pk + 1] / 255, px[pk + 2] / 255)
      c.multiplyScalar(0.92 + 0.42 * t)
      c.lerp(HIGH, Math.min(0.55, t * 0.22))
      c.offsetHSL(0, 0.04, (Math.random() - 0.5) * 0.02)

      const s = 0.40 + Math.random() * 0.30

      // 前表面
      pushPoint(x, y, zc, nx, ny, nz, c, s, 1)

      // 背壳（55% 概率，保证任意角度都是实体而非薄片）
      if (Math.random() < 0.55) {
        const cb = c.clone().multiplyScalar(0.52)
        pushPoint(
          x + (Math.random() - 0.5) * k * 0.6,
          y + (Math.random() - 0.5) * k * 0.6,
          zc - SHELL,
          nx, ny, nz,
          cb,
          s * 0.86,
          -1
        )
      }
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3))
  g.setAttribute('aNorm', new THREE.Float32BufferAttribute(nrm, 3))
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1))
  g.setAttribute('aStart', new THREE.Float32BufferAttribute(start, 3))
  g.setAttribute('aDelay', new THREE.Float32BufferAttribute(delay, 1))
  g.setAttribute('aRand', new THREE.Float32BufferAttribute(rand, 1))
  // 照片浮雕没有轮廓/眼睛的几何依据，叙事分段退化为"随机先后"
  g.setAttribute('aOrder', new THREE.Float32BufferAttribute(delay.map((d) => 0.10 + d * 1.6), 1))
  g.setAttribute('aEye', new THREE.Float32BufferAttribute(new Float32Array(delay.length), 1))
  g.computeBoundingSphere()

  return { geometry: g }
}

function Halo() {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color('#b8863a') } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `varying vec2 vUv; uniform vec3 uColor;
          void main(){ float d = length(vUv - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d); a = pow(a, 2.8); gl_FragColor = vec4(uColor, a * 0.14); }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      }),
    []
  )
  return (
    <mesh position={[0, 0, -2.6]} material={mat}>
      <planeGeometry args={[24, 24]} />
    </mesh>
  )
}

function Dust() {
  const geo = useMemo(() => {
    const n = 700
    const p = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2
      const ph = Math.acos(2 * Math.random() - 1)
      const r = 9 + Math.random() * 14
      p[i * 3] = Math.sin(ph) * Math.cos(th) * r
      p[i * 3 + 1] = Math.cos(ph) * r
      p[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * r
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
    return g
  }, [])
  const ref = useRef()
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.02
  })
  return (
    <points ref={ref} geometry={geo}>
      <pointsMaterial
        size={0.04}
        color="#d9b062"
        transparent
        opacity={0.4}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        sizeAttenuation
      />
    </points>
  )
}

export default function MaskParticles({
  autoRotate,
  replayKey,
  mouthRef,
  onProgress,
  swayGain = 1,
  lockFront = false,
  scaleGain = 1,
  shiftX = 0,
  pointSize = null
}) {
  const group = useRef()
  const matRef = useRef()
  const pointer = useRef({ x: 0, y: 0 })
  const mouseNdc = useRef(new THREE.Vector2(9, 9))
  const gust = useRef(0)
  const atRef = useRef(AT)
  const spin = useRef(0)
  const progress = useRef(0)
  const [asset, setAsset] = useState(null)
  const [count, setCount] = useState(0)
  const { camera, gl, size, viewport } = useThree()

  useEffect(() => {
    let dead = false
    ;(async () => {
      try {
        const mesh = await loadRealMesh()
        if (mesh) {
          if (dead) return
          setCount(mesh.attributes.position.count)
          setAsset({ geometry: mesh, source: 'mesh' })
          return
        }
      } catch (e) {
        console.warn('[mask] 真网格载入失败，回退到照片浮雕：', e)
      }
      const img = new Image()
      img.onload = () => {
        if (dead) return
        const a = buildFromImage(img)
        setCount(a.geometry.attributes.position.count)
        setAsset({ ...a, source: 'photo' })
      }
      img.src = maskUrl
    })()
    return () => {
      dead = true
    }
  }, [])

  useEffect(() => {
    progress.current = 0
    spin.current = 0
    if (matRef.current) matRef.current.uniforms.uProgress.value = 0
  }, [replayKey, asset])

  // 调试用：window.__setAt(0.42) / __setAt(null) 可以在一次页面加载里抽查任意进度帧
  useEffect(() => {
    window.__setAt = (v) => {
      atRef.current = v === null ? null : Math.min(1, Math.max(0, Number(v) || 0))
    }
    return () => {
      delete window.__setAt
    }
  }, [])

  useEffect(() => {
    const onMove = (e) => {
      // 拖参数滑块时不要顺手把面具吹散——UI 上打了 data-ui 标记就跳过
      if (e.target?.closest?.('[data-ui]')) return
      pointer.current.x = (e.clientX / window.innerWidth - 0.5) * 2
      pointer.current.y = (e.clientY / window.innerHeight - 0.5) * 2
      mouseNdc.current.set(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1
      )
      // 只有"划过"才起风：指针停住后 gust 会自己衰减，粒子随即归位
      gust.current = 1
    }
    const onLeave = () => {
      gust.current = 0
      pointer.current.x = 0
      pointer.current.y = 0
    }
    const onWheel = (e) => {
      camera.position.z = THREE.MathUtils.clamp(camera.position.z + e.deltaY * 0.008, 8.5, 20)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerleave', onLeave)
    gl.domElement.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerleave', onLeave)
      gl.domElement.removeEventListener('wheel', onWheel)
    }
  }, [camera, gl])

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uSize: { value: 30 },
      uDpr: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uFlat: { value: QS.get('flat') === '1' ? 1 : 0 },
      uEyeDebug: { value: QS.get('eye') === '1' ? 1 : 0 },
      uMouse: { value: new THREE.Vector2(9, 9) },
      uMouseStrength: { value: 0 },
      uAspect: { value: 1 },
      uTanHalfFov: { value: 0.12 },
      // 开口参数：默认 region 用的是从 mask.glb 点云剖面上量出来的唇线位置，
      // 但 uOpen / uJaw / uLipFade 默认 0，所以原页面行为完全不变
      uMouthY: { value: MOUTH_DEFAULT.y },
      uMouthHW: { value: MOUTH_DEFAULT.hw },
      uMouthHH: { value: MOUTH_DEFAULT.hh },
      uOpen: { value: 0 },
      uWide: { value: 0 },
      uJaw: { value: MOUTH_DEFAULT.jaw },
      uLipFade: { value: MOUTH_DEFAULT.fade }
    }),
    []
  )

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime
    const m = matRef.current
    if (m) {
      m.uniforms.uTime.value = t
      progress.current = atRef.current !== null ? atRef.current : Math.min(1, progress.current + dt * 0.28)
      m.uniforms.uProgress.value = progress.current
      m.uniforms.uSize.value = pointSize
        ? pointSize * (size.width < 720 ? 0.72 : 1)
        : (size.width < 720 ? 28 : 38)

      // 鼠标吹散：gust 只在指针移动时被点亮，停手后按 0.22s 时间常数衰减，
      // 粒子随那股风散开又自己收回去
      const u = m.uniforms
      u.uMouse.value.copy(mouseNdc.current)
      u.uAspect.value = size.width / Math.max(size.height, 1)
      u.uTanHalfFov.value = Math.tan(((camera.fov || 40) * Math.PI) / 360)
      gust.current *= Math.exp(-dt / 0.22)
      if (gust.current < 0.002) gust.current = 0
      u.uMouseStrength.value = gust.current

      // 音频驱动的开口：外部每帧写 mouthRef.current，这里只做搬运，
      // 不走 React state —— 每秒 60 次 setState 会把渲染管线拖死
      const mo = mouthRef?.current
      if (mo) {
        u.uOpen.value = mo.open ?? 0
        u.uWide.value = mo.wide ?? 0
        u.uJaw.value = mo.jaw ?? MOUTH_DEFAULT.jaw
        u.uLipFade.value = mo.fade ?? MOUTH_DEFAULT.fade
        if (mo.y !== undefined) u.uMouthY.value = mo.y
        if (mo.hw !== undefined) u.uMouthHW.value = mo.hw
        if (mo.hh !== undefined) u.uMouthHH.value = mo.hh
      }
      onProgress?.(progress.current)
    }
    if (group.current) {
      const s = Math.min(viewport.width, viewport.height) * (size.width < 720 ? 0.86 : 0.72) * scaleGain
      group.current.scale.setScalar(s)

      // 真网格：整圈转过去会看到空心的内侧壳，不如在 ±32° 内缓慢摆动——
      // 一直保持"看得见脸"，同时把耳朵厚度和鼻梁起伏露出来
      const isMesh = asset?.source === 'mesh'
      const autoY = isMesh ? Math.sin(t * 0.34) * 0.56 : Math.sin(t * 0.30) * 0.22
      const sway = autoRotate && !STILL ? autoY : TURN
      const mo = mouthRef?.current
      // 讲解时跟着音节轻轻点头：只靠嘴动会显得像贴图，加一点整体俯仰才"活"
      const nod = (mo?.nod ?? 0) * (mo?.open ?? 0) * Math.sin(t * 1.1)
      const targetY = sway * swayGain + (lockFront ? 0 : pointer.current.x * 0.40)
      const targetX = lockFront
        ? 0
        : (isMesh ? (PITCH_DEG * Math.PI) / 180 : 0) + pointer.current.y * 0.22 + nod

      group.current.rotation.y += (targetY - group.current.rotation.y) * Math.min(1, dt * 2.4)
      group.current.rotation.x += (targetX - group.current.rotation.x) * Math.min(1, dt * 2.4)
      // 静止模式下连上下浮动也一起冻住，否则两张对比帧的垂直位置差几十像素
      group.current.position.y = STILL ? 0 : Math.sin(t * 0.5) * 0.07
      // 右侧参数面板打开时把面具让开一点，别把耳朵压掉
      group.current.position.x += (shiftX - group.current.position.x) * Math.min(1, dt * 3.2)
    }
    // 静止模式同时也冻结机位漂移——截图/对位检查需要一台完全固定的相机
    if (!STILL) {
      camera.position.x = Math.sin(t * 0.22) * 0.3
      camera.position.y = Math.cos(t * 0.17) * 0.2
      camera.lookAt(0, 0, 0)
    }  })

  if (!asset) return null

  const { geometry } = asset

  return (
    <group ref={group}>
      <Halo />
      <Dust />
      <points geometry={geometry} renderOrder={1}>
        <shaderMaterial
          ref={matRef}
          uniforms={uniforms}
          vertexShader={VERT}
          fragmentShader={FRAG}
          transparent
          depthWrite={false}
          blending={THREE.NormalBlending}
        />
      </points>
      <ParticleCountReporter count={count} />
    </group>
  )
}

function ParticleCountReporter({ count }) {
  useEffect(() => {
    window.__MASK_PARTICLE_COUNT__ = count
  }, [count])
  return null
}
