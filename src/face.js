import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { sampleMeshToPoints } from './scene/sampleMesh.js'
import maskUrl from './assets/mask.glb?url'

/**
 * 把青铜大面具"戴"到真人脸上。
 *
 * 对齐不是靠猜比例：点云里每个粒子都带 aEye 标记（源自 3D 几何的凹坑判据），
 * 先算出面具自身两只眼睛的中心与间距，再把这个间距缩放到人脸测出来的眼距。
 * 这样不管换成哪张脸、离镜头多远，面具都自动贴合。
 */

const QS = new URLSearchParams(location.search)
const IMG = QS.get('img') // 有值则跑静态图（用于验证贴合），否则开摄像头
const FAKECAM = QS.get('fakecam') // 虚拟摄像头：会动的静态脸，验证 VIDEO 实时链路
const PARTICLES = Number(QS.get('p') || 300000)
const SHOW_MASK = QS.get('bare') !== '1'
// 面具相对真人脸的放大系数：1.0 时面具宽度约等于"眼中心到下巴"的距离，
// 调到 1.1~1.2 才能让大耳张到脸颊之外
let GAIN = Number(QS.get('gain') || 0.74)
// 细微校准：面具整体在画面里平移多少 CSS 像素。不同镜头/脸型会有系统差。
// 也可以在页面上用方向键实时微调（存 localStorage，见 CALIBRATE 一节）。
// 注意自拍是镜像的，ox 正方向在画面里看起来朝左。
let OX = Number(QS.get('ox') || -6)
let OY = Number(QS.get('oy') || 0)
// 曝光。正常混合下这是纯粹的亮度增益：1.0 = 用采样出来的青铜色原样上屏。
// （若切回叠加混合，要压到 0.3~0.5，否则三十万粒子叠在几万像素上会烧成白纸）
let EXPO = Number(QS.get('expo') || 0.95)
// 粒子直径系数。正交相机下 1 本地单位 ≈ 每单位像素数 px，粒子直径 = aSize × 该值 × PT_K。
// 直接写死像素尺寸是错的：人脸离远一点 scale 变小，面具缩小而粒子不变，密度就崩了。
let PT_K = Number(QS.get('pt') || 0.0135)
// 2D 层压暗真实脸的比例——压太狠五官全没了，压太轻面具底下透出真嘴真眼会"穿帮"。
// 0.30 只是轻轻罩一层，保留真实五官。
let SHADE = Number(QS.get('shade') || 0.30)
// 透明度增益。正常混合下靠它把点云从"纱"拧成"皮"，1.3 时面具才有实体感
let ALPHA_K = Number(QS.get('alphak') || 1.30)

const stage = document.getElementById('stage')
const video = document.getElementById('cam')
const imgEl = document.getElementById('still')
const mask2d = document.getElementById('mask2d')
const ctx2d = mask2d.getContext('2d')
const statusEl = document.getElementById('status')
const tipEl = document.getElementById('tip')

/* ---------------- three 基础 ---------------- */

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2))
renderer.setClearColor(0x000000, 0)
const glCanvas = renderer.domElement
glCanvas.id = 'gl'
stage.appendChild(glCanvas)

const scene = new THREE.Scene()
// 正交相机，1 单位 = 1 CSS 像素，landmark 坐标可以原样用
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000)

/* ---------------- 粒子材质 ---------------- */

const VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute vec3 aNorm;
  attribute float aSize;
  attribute float aRand;
  attribute float aEye;
  uniform float uTime;
  uniform float uPt;
  uniform float uEyeGlow;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vShade;
  varying float vFacing;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    vec3 nv = normalize(normalMatrix * aNorm);
    // 正交相机下视线方向恒为 -Z，直接用世界系法线判正反面
    vFacing = nv.z;

    vec3 L = normalize(vec3(-0.62, 0.52, 0.50));
    float diff = max(dot(nv, L), 0.0);
    float head = max(nv.z, 0.0);
    float rim = pow(1.0 - abs(nv.z), 2.4);
    vShade = 0.15 + 0.95 * diff + 0.22 * head + 0.12 * rim;

    float twinkle = 0.95 + 0.07 * sin(uTime * 2.1 + aRand * 23.0);
    gl_PointSize = clamp(
      aSize * uPt * (0.96 + 0.08 * twinkle) * (1.0 + 0.55 * aEye * uEyeGlow),
      1.0, 26.0
    );

    vColor = aColor;
    vAlpha = twinkle * (0.55 + 0.45 * clamp(vShade, 0.0, 1.2))
           * (1.0 + 0.45 * aEye * uEyeGlow);
  }
`

const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vShade;
  varying float vFacing;
  uniform float uExpo;
  uniform float uAlphaK;

  void main() {
    float vis = smoothstep(-0.15, 0.12, vFacing);
    if (vis < 0.02) discard;
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float a = pow(smoothstep(0.5, 0.12, d), 1.35);
    vec3 c = vColor * vShade * (1.0 + 0.15 * a);
    gl_FragColor = vec4(c * 1.22 * uExpo, clamp(a * vAlpha * vis * uAlphaK, 0.0, 1.0));
  }
`

const uniforms = {
  uTime: { value: 0 },
  uPt: { value: 10 },
  uExpo: { value: EXPO },
  uAlphaK: { value: ALPHA_K },
  uEyeGlow: { value: 1 }
}

const mat = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: VERT,
  fragmentShader: FRAG,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  // 正常混合：粒子盖在压暗的脸上，空隙里透出脸——面具是"实心的一层皮"。
  // 用叠加混合时会反过来：粒子加到黑底上还是黑，只有落在浅色背景上的
  // 耳朵、外轮廓会亮起来，脸中央一片死黑，看着像一圈空心金边。
  blending: THREE.NormalBlending
})

const group = new THREE.Group()
// YXZ：先偏航、再俯仰、最后在画面内滚转——顺序反了会出现"歪着转头"的怪相
group.rotation.order = 'YXZ'
scene.add(group)

/* ---------------- 加载面具点云 ---------------- */

let maskEyeMid = new THREE.Vector2() // 面具自身两眼中心的本地坐标
let maskEyeDist = 1 // 面具自身的眼距（本地单位）
let maskEyeToBottom = 0.4 // 面具从眼中心到下缘的高度（本地单位）
let maskCenterX = 0 // 面具包围盒横向中线（面具真正的"鼻梁"位置）
let ready = false

async function buildMask() {
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  const root = (await loader.loadAsync(maskUrl)).scene
  const geo = await sampleMeshToPoints(root, PARTICLES)

  // 从 aEye 标记里量出面具的眼睛位置与眼距——这就是对齐的锚点
  const pos = geo.getAttribute('position')
  const eye = geo.getAttribute('aEye')
  let n = 0
  let sx = 0
  let sy = 0
  let lx = 0
  let ln = 0
  let rx = 0
  let rn = 0
  for (let i = 0; i < eye.count; i++) {
    if (eye.getX(i) < 0.5) continue
    const x = pos.getX(i)
    const y = pos.getY(i)
    sx += x
    sy += y
    n++
    if (x > 0) {
      rx += x
      rn++
    } else {
      lx += x
      ln++
    }
  }
  if (n > 0) {
    maskEyeMid.set(sx / n, sy / n)
    if (rn > 0 && ln > 0) maskEyeDist = rx / rn - lx / ln
  }
  // 面具从眼中心到下缘有多高——三星堆面具的"口部横带 + 底座"很宽，
  // 用这个距离去对下巴，面具下缘才会落在该落的地方
  geo.computeBoundingBox()
  maskEyeToBottom = Math.max(0.05, maskEyeMid.y - geo.boundingBox.min.y)
  // 横向锚点不能拿 aEye 质心：两个眼窝检出的粒子数不对称，质心会横向偏
  // （实测偏 0.039 本地单位 ≈ 34px，鼻子跟着歪）。用包围盒中心才是面具真正的中线。
  maskCenterX = (geo.boundingBox.min.x + geo.boundingBox.max.x) / 2

  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  group.add(points)
  ready = true
  console.log(
    '[face] 面具眼带中心 y=%s，几何中线 x=%s（aEye 质心 x=%s，偏 %s），粒子 %d',
    maskEyeMid.y.toFixed(4),
    maskCenterX.toFixed(4),
    maskEyeMid.x.toFixed(4),
    (maskEyeMid.x - maskCenterX).toFixed(4),
    pos.count
  )
}

/* ---------------- 人脸 → 面具位姿 ---------------- */

const lmIdx = {
  eyeR: [33, 133], // 图像左侧那只眼（人的右眼）
  eyeL: [362, 263],
  nose: 1,
  chin: 152
}

// MediaPipe 的 facialTransformationMatrix 是"规范脸 → 相机"的列主序 4×4。
// 正负号跟坐标系约定有关，留两个开关以便用转头的实拍图校准。
const YAW_SIGN = Number(QS.get('yawsign') || 1)
const PITCH_SIGN = Number(QS.get('pitchsign') || 1)

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _vx = new THREE.Vector3()
const _vy = new THREE.Vector3()
const _vz = new THREE.Vector3()

/**
 * 从头部位姿矩阵里取出 yaw / pitch。
 * 矩阵里混着尺度和位移，直接 setFromRotationMatrix 会得到歪掉的角度，
 * 先把三个基向量归一化成纯旋转再取欧拉角。
 */
function headAngles(mtx) {
  if (!mtx || mtx.length < 16) return { yaw: 0, pitch: 0 }
  _m.fromArray(mtx)
  const e4 = _m.elements
  _vx.set(e4[0], e4[1], e4[2]).normalize()
  _vy.set(e4[4], e4[5], e4[6]).normalize()
  _vz.set(e4[8], e4[9], e4[10]).normalize()
  _m.makeBasis(_vx, _vy, _vz)
  _q.setFromRotationMatrix(_m)
  _e.setFromQuaternion(_q, 'YXZ')
  return {
    yaw: THREE.MathUtils.clamp(_e.y * YAW_SIGN, -0.75, 0.75),
    pitch: THREE.MathUtils.clamp(_e.x * PITCH_SIGN, -0.6, 0.6)
  }
}

// 脸部轮廓，用来把真脸压暗，面具才"戴得住"
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152,
  148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109
]

const smooth = { scale: 0, x: 0, y: 0, roll: 0, yaw: 0, pitch: 0, init: false, yawInit: false }

// 最近一次解算用到的输入——改调参（gain / pt / shade）时要靠它重算一遍
let lastLm = null
let lastMtx = null
const lastDims = { W: 0, H: 0 }
const _anchor = new THREE.Vector3()
const _poseEuler = new THREE.Euler()

/**
 * @param {Array<{x:number,y:number,z:number}>} lm 归一化 landmark
 * @param {number} W 画面宽（CSS 像素）
 * @param {number} H 画面高
 */
function applyPose(lm, W, H, mtx) {
  const px = (i) => new THREE.Vector2(lm[i].x * W, lm[i].y * H)
  const mid = (a, b, out) => out.copy(px(a)).add(px(b)).multiplyScalar(0.5)

  const t1 = new THREE.Vector2()
  const t2 = new THREE.Vector2()
  const eyeR = mid(lmIdx.eyeR[0], lmIdx.eyeR[1], t1.clone())
  const eyeL = mid(lmIdx.eyeL[0], lmIdx.eyeL[1], t2.clone())

  const eyeMid = eyeR.clone().add(eyeL).multiplyScalar(0.5)
  const dEyePx = eyeL.distanceTo(eyeR)

  // 眼连线角度 = 头部滚转
  const roll = Math.atan2(eyeL.y - eyeR.y, eyeL.x - eyeR.x)

  // 尺度：用"眼中心 → 下巴"对"眼中心 → 面具下缘"。
  // 之前拿眼距当锚点，面具只有脸宽的六成——三星堆面具本来就比人脸宽（大耳外张），
  // 用眼距对齐等于强行把面具压到真人脸的尺寸上，戴着像个小面片。
  const chin = px(lmIdx.chin)
  const dChin = eyeMid.distanceTo(chin)
  const scale = (dChin / maskEyeToBottom) * GAIN

  // 正交相机、1 单位 1 像素，且 y 轴朝上
  const wx = eyeMid.x - W / 2
  const wy = H / 2 - eyeMid.y

  // 拉一个一阶低通，MediaPipe 逐帧抖动直接给到渲染会看见"果冻"。
  // 位置用 0.55（太保守会拖出 100ms+ 的滞后，面具看起来"浮"在脸外），
  // 旋转保持 0.30——头部角度噪得厉害，跟太快面具会"抖鳞"。
  const k = smooth.init ? 0.55 : 1
  smooth.init = true
  smooth.scale += (scale - smooth.scale) * k
  smooth.x += (wx - smooth.x) * k
  smooth.y += (wy - smooth.y) * k
  smooth.roll += (roll - smooth.roll) * k

  // 转头跟随。慢一点（k=0.22）：头部角度逐帧噪得比眼位厉害，跟太快面具会"抖鳞"
  const hd = headAngles(mtx)
  smooth.yaw += (hd.yaw - smooth.yaw) * (smooth.yawInit ? 0.22 : 1)
  smooth.pitch += (hd.pitch - smooth.pitch) * (smooth.yawInit ? 0.22 : 1)
  smooth.yawInit = true

  group.scale.setScalar(smooth.scale)
  group.rotation.set(smooth.pitch, smooth.yaw, -smooth.roll)
  lastLm = lm
  lastMtx = mtx
  lastDims.W = W
  lastDims.H = H

  // 让面具的眼中心落在人脸眼中心上。
  // 横向用包围盒中线（= 鼻梁位置），纵向用眼带质心——
  // 锚点要按当前姿态先转一遍，转头时面具的眼在本地坐标里没动，投到屏幕上却挪了位，
  // 不减掉这一项，面具会整片"甩"出去。
  _anchor.set(maskCenterX, maskEyeMid.y, 0).multiplyScalar(smooth.scale)
  _anchor.applyEuler(_poseEuler.set(smooth.pitch, smooth.yaw, -smooth.roll, 'YXZ'))
  group.position.set(smooth.x - _anchor.x + OX, smooth.y - _anchor.y + OY, 0)

  if (!applyPose.logged) {
    applyPose.logged = true
    console.log(
      '[face] 位姿解算：scale=%s，眼中心→下巴=%spx，面具眼中心→下缘=%s，粒子直径≈%spx',
      smooth.scale.toFixed(1),
      dChin.toFixed(1),
      maskEyeToBottom.toFixed(4),
      (0.35 * uniforms.uPt.value).toFixed(2)
    )
  }

  return { lm, W, H }
}

function drawFaceShade(lm, W, H) {
  ctx2d.clearRect(0, 0, W, H)
  if (!SHOW_MASK) return
  ctx2d.save()
  ctx2d.beginPath()
  FACE_OVAL.forEach((i, k) => {
    const x = lm[i].x * W
    const y = lm[i].y * H
    if (k === 0) ctx2d.moveTo(x, y)
    else ctx2d.lineTo(x, y)
  })
  ctx2d.closePath()
  // 轻微放大再裁掉边缘，羽化靠 shadowBlur 做
  ctx2d.filter = 'blur(14px)'
  ctx2d.fillStyle = `rgba(8,6,5,${SHADE})`
  ctx2d.fill()
  ctx2d.restore()
}

/* ---------------- MediaPipe ---------------- */

let landmaker = null
let lastVideoTime = -1
let lastResult = null

async function initLandmarker(mode) {
  // 用 BASE_URL 而不是写死 '/wasm'：部署到 GitHub Pages 项目页时站点在
  // /<repo>/ 子路径下，绝对路径会 404。base 是 './'，所以拼出来是相对路径。
  const fileset = await FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}wasm`)
  const opts = {
    baseOptions: {
      modelAssetPath: `${import.meta.env.BASE_URL}models/face_landmarker.task`,
      delegate: 'GPU'
    },
    runningMode: mode,
    numFaces: 1,
    outputFaceBlendshapes: false,
    // 转头要靠它：只给 2D landmark 的话，点头和低头的投影几乎一样，解不出俯仰
    outputFacialTransformationMatrixes: true
  }
  try {
    return await FaceLandmarker.createFromOptions(fileset, opts)
  } catch (e) {
    console.warn('[face] GPU delegate 不可用，退回 CPU：', e)
    opts.baseOptions.delegate = 'CPU'
    return await FaceLandmarker.createFromOptions(fileset, opts)
  }
}

/* ---------------- 尺寸 ---------------- */

let VW = 0
let VH = 0

function resize(w, h) {
  VW = w
  VH = h
  stage.style.width = w + 'px'
  stage.style.height = h + 'px'
  mask2d.width = w
  mask2d.height = h
  renderer.setSize(w, h, false)
  camera.left = -w / 2
  camera.right = w / 2
  camera.top = h / 2
  camera.bottom = -h / 2
  camera.updateProjectionMatrix()
}

/* ---------------- 主循环 ---------------- */

const clock = new THREE.Clock()

function loop() {
  requestAnimationFrame(loop)
  uniforms.uTime.value = clock.getElapsedTime()
  // 粒子尺寸跟着人脸远近距离一起缩，否则人一后退面具变小米粒就散成雾
  if (smooth.init) uniforms.uPt.value = smooth.scale * PT_K

  if (landmaker && video.readyState >= 2 && !IMG) {
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime
      lastResult = landmaker.detectForVideo(video, performance.now())
    }
    if (lastResult && lastResult.faceLandmarks.length) {
      const lm = lastResult.faceLandmarks[0]
      const mtx = lastResult.facialTransformationMatrixes?.[0]?.data
      applyPose(lm, VW, VH, mtx)
      drawFaceShade(lm, VW, VH)
      statusEl.textContent = '已锁定人脸 · 粒子 ' + PARTICLES.toLocaleString() + ' · yaw ' +
        Math.round(THREE.MathUtils.radToDeg(smooth.yaw)) + '°'
      if (!loop.okOnce) {
        loop.okOnce = true
        window.__FACE_OK__ = true
      }
    } else {
      statusEl.textContent = '画面里没找到人脸'
    }
  }

  renderer.render(scene, camera)
}

/* ---------------- 运行时调参（截图对比用） ---------------- */

window.__face = {
  /**
   * @param {{expo?:number, pt?:number, gain?:number, shade?:number}} o
   */
  set(o) {
    if (o.expo != null) uniforms.uExpo.value = o.expo
    if (o.alphaK != null) uniforms.uAlphaK.value = o.alphaK
    if (o.blend) {
      mat.blending = o.blend === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending
      mat.needsUpdate = true
    }
    if (o.pt != null) PT_K = o.pt
    if (o.gain != null) { GAIN = o.gain; calib.gain = o.gain }
    if (o.shade != null) SHADE = o.shade
    if (o.ox != null) { OX = o.ox; calib.ox = o.ox }
    if (o.oy != null) { OY = o.oy; calib.oy = o.oy }
    if (!lastLm) return
    // 平滑器直接跳到目标位，否则改完参数还要等几帧才收敛
    const wasInit = smooth.init
    smooth.init = false
    applyPose(lastLm, lastDims.W, lastDims.H, lastMtx)
    drawFaceShade(lastLm, lastDims.W, lastDims.H)
    if (wasInit) smooth.init = true
  }
}

/* ---------------- 校准（方向键实时微调，localStorage 记住） ----------------
 * 每个人的镜头和脸型都有几像素的系统差，靠猜默认值永远差一口气。
 * 方向键挪面具、+/- 缩放，改完自动存 localStorage，下次打开还在。
 * URL 参数（?ox= ?oy= ?gain=）优先级最高，方便做对比实验。
 */

const CAL_KEY = 'face.calib.v1'
const calib = { ox: OX, oy: OY, gain: GAIN, ...(loadCal()) }
// URL 参数覆盖 localStorage
if (QS.get('ox') != null) calib.ox = Number(QS.get('ox'))
if (QS.get('oy') != null) calib.oy = Number(QS.get('oy'))
if (QS.get('gain') != null) calib.gain = Number(QS.get('gain'))

function loadCal() {
  try {
    return JSON.parse(localStorage.getItem(CAL_KEY)) || {}
  } catch {
    return {}
  }
}

function saveCal() {
  try {
    localStorage.setItem(CAL_KEY, JSON.stringify({ ox: calib.ox, oy: calib.oy, gain: calib.gain }))
  } catch { /* 隐身模式等场景存不了就算了 */ }
}

function applyCal() {
  OX = calib.ox
  OY = calib.oy
  GAIN = calib.gain
  if (lastLm) {
    const wasInit = smooth.init
    smooth.init = false
    applyPose(lastLm, lastDims.W, lastDims.H, lastMtx)
    drawFaceShade(lastLm, lastDims.W, lastDims.H)
    smooth.init = true
    if (!wasInit) smooth.init = false
  }
  saveCal()
  showCal()
}

function showCal() {
  const el = document.getElementById('calib')
  if (el) {
    el.textContent =
      `校准 ox=${calib.ox}px oy=${calib.oy}px gain=${calib.gain.toFixed(2)}（方向键移动 · +/- 缩放 · 0 复位）`
  }
}

window.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 6 : 2
  switch (e.key) {
    case 'ArrowLeft': calib.ox -= step; break
    case 'ArrowRight': calib.ox += step; break
    case 'ArrowUp': calib.oy -= step; break
    case 'ArrowDown': calib.oy += step; break
    case '+': case '=': calib.gain = Math.min(1.4, calib.gain + 0.02); break
    case '-': case '_': calib.gain = Math.max(0.4, calib.gain - 0.02); break
    case '0': calib.ox = -6; calib.oy = 0; calib.gain = 0.74; break
    default: return
  }
  e.preventDefault()
  applyCal()
})

/* ---------------- 启动 ---------------- */

async function boot() {
  showCal()
  statusEl.textContent = '生成粒子面具…'
  await buildMask()

  if (IMG) {
    // 静态图：帧尺寸就用图片原始尺寸
    statusEl.textContent = '载入测试人脸…'
    await new Promise((res, rej) => {
      imgEl.onload = res
      imgEl.onerror = rej
      imgEl.src = IMG
    })
    imgEl.style.display = 'block'
    window.__IMG_READY__ = true
    stage.classList.add('plain')

    const w = imgEl.naturalWidth
    const h = imgEl.naturalHeight
    resize(w, h)
    landmaker = await initLandmarker('IMAGE')
    const r = landmaker.detect(imgEl)
    console.log('[face] 静态图检出人脸数', r.faceLandmarks.length)
    if (r.faceLandmarks.length) {
      applyPose(r.faceLandmarks[0], w, h, r.facialTransformationMatrixes?.[0]?.data)
      const nose = r.faceLandmarks[0][lmIdx.nose]
      const noseDx = (nose.x - (r.faceLandmarks[0][lmIdx.eyeR[0]].x + r.faceLandmarks[0][lmIdx.eyeL[0]].x) / 2) * w
      console.log(
        '[face] yaw=%s° pitch=%s° roll=%s°；鼻尖横向偏移 %spx（两者应同号，反了就翻 yawsign）',
        THREE.MathUtils.radToDeg(smooth.yaw).toFixed(1),
        THREE.MathUtils.radToDeg(smooth.pitch).toFixed(1),
        THREE.MathUtils.radToDeg(smooth.roll).toFixed(1),
        noseDx.toFixed(1)
      )
      drawFaceShade(r.faceLandmarks[0], w, h)
      statusEl.textContent = '静态图贴合 · ' + PARTICLES.toLocaleString() + ' 粒子'
      window.__FACE_OK__ = true
    } else {
      statusEl.textContent = '这张图里没检出人脸'
    }
    loop()
    return
  }

  statusEl.textContent = '请求摄像头…'
  tipEl.textContent = '浏览器会问是否允许使用摄像头 · 靠近一点更贴合 · 转头面具会跟着转'
  let stream
  if (FAKECAM) {
    // 虚拟摄像头：把一张静态脸画在 canvas 上做缓慢的漂移/缩放，再 captureStream()
    // 喂给 VIDEO 模式。没有摄像头的机器也能把实时链路完整验一遍。
    statusEl.textContent = '虚拟摄像头…'
    tipEl.textContent = '虚拟摄像头（会动的静态脸）——只用于验证实时链路，不是真画面'
    const im = new Image()
    await new Promise((res, rej) => {
      im.onload = res
      im.onerror = rej
      im.src = FAKECAM
    })
    const fc = document.createElement('canvas')
    fc.width = 960
    fc.height = 720
    const fx = fc.getContext('2d')
    const t0 = performance.now()
    const drawFake = () => {
      const t = (performance.now() - t0) / 1000
      const s = 1 + 0.10 * Math.sin(t * 0.9)
      const dx = 70 * Math.sin(t * 0.55)
      const dy = 34 * Math.sin(t * 0.8 + 1.2)
      fx.fillStyle = '#9a9a9a'
      fx.fillRect(0, 0, fc.width, fc.height)
      const h = fc.height * s
      const w = h * (im.naturalWidth / im.naturalHeight)
      fx.drawImage(im, (fc.width - w) / 2 + dx, (fc.height - h) / 2 + dy, w, h)
      requestAnimationFrame(drawFake)
    }
    drawFake()
    stream = fc.captureStream(30)
  } else {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false
      })
    } catch (e) {
      // 摄像头打不开很常见（没设备 / 没授权 / 非 localhost），别只丢一句错就完了
      statusEl.textContent = '摄像头打不开'
      tipEl.innerHTML =
        '原因：' + e.name + '。可以换个方式看——在地址后面加 <b>?img=图片地址</b> 用静态图试戴，<br>' +
        '或直接用 <b>https</b> / <b>localhost</b> 打开（浏览器只在这两种情况下允许摄像头）。'
      console.warn('[face] getUserMedia 失败', e)
      return
    }
  }
  video.srcObject = stream
  await video.play()
  const w = video.videoWidth
  const h = video.videoHeight
  resize(w, h)
  // 舞台按画面比例缩放到视口内；自拍要看镜子，整层横向翻转
  const s = Math.min(window.innerWidth / w, (window.innerHeight - 90) / h)
  stage.classList.add('mirror')
  stage.style.setProperty('--zoom', String(s))

  landmaker = await initLandmarker('VIDEO')
  loop()
}

boot().catch((e) => {
  console.error(e)
  statusEl.textContent = '启动失败：' + e.message
  window.__FACE_ERR__ = String(e)
})
