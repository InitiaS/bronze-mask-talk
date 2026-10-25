import * as THREE from 'three'

/**
 * 把任意真实网格（STL / OBJ / GLB 载入后的 THREE.Object3D）按面积加权采样成点云，
 * 输出与 buildFromImage 完全一致的 BufferGeometry 结构，可直接替换粒子源。
 *
 * 与"照片推深度"的根本差别：
 *  - 点分布在真实表面上，法线来自网格本身 → 光照是真的
 *  - 眼窝是真的凹、鼻梁是真的凸、耳部有真实厚度
 *  - 任意角度转过去都成立，不会变成一张薄片
 */

const HIGH = new THREE.Color('#f4e2b6')
const BRONZE_DEEP = new THREE.Color('#4a3115')
const BRONZE_MID = new THREE.Color('#a87c3c')
const BRONZE_GOLD = new THREE.Color('#dcb968')
const BRONZE_PLAIN = new THREE.Color('#8a6a34')

/* 青铜色阶：暗部偏褐、中间偏铜、高光偏金 */
function bronzeRamp(t) {
  const c = new THREE.Color()
  if (t < 0.5) c.copy(BRONZE_DEEP).lerp(BRONZE_MID, t / 0.5)
  else if (t < 0.82) c.copy(BRONZE_MID).lerp(BRONZE_GOLD, (t - 0.5) / 0.32)
  else c.copy(BRONZE_GOLD).lerp(HIGH, (t - 0.82) / 0.18)
  return c
}

function readTexturePixels(texture) {
  const img = texture?.image
  if (!img) return null
  const w = img.width || img.videoWidth
  const h = img.height || img.videoHeight
  if (!w || !h) return null
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, w, h)
  return { data: ctx.getImageData(0, 0, w, h).data, w, h }
}

/* 读顶点色：three 的 BufferAttribute.getX() 对 normalized 属性已经做过反量化，
   这里只处理少数"未标记 normalized 的 uint8"这种老格式 */
function readVertexColor(attr, i) {
  const c = new THREE.Color()
  c.setRGB(attr.getX(i), attr.getY(i), attr.getZ(i))
  if (!attr.normalized && attr.array instanceof Uint8Array) {
    c.r /= 255
    c.g /= 255
    c.b /= 255
  }
  return c
}

function makeSampledGeometry(positionsOut, colorsOut, normalsOut, sizesOut, orderOut, eyeOut) {
  const n = positionsOut.length / 3
  const start = new Float32Array(n * 3)
  const delay = new Float32Array(n)
  const rand = new Float32Array(n)
  const order = new Float32Array(n)
  const eye = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const o = orderOut ? orderOut[i] : Math.random() * 0.7
    order[i] = o
    eye[i] = eyeOut ? eyeOut[i] : 0

    // 起点：绝大多数粒子从目标点附近 0.12~0.42（局部单位）出发。
    // 之前把起点丢到 12~24 单位外，换算成世界坐标是 86~172——粒子飞到九成路程
    // 都还在画外，读起来只是"最后一刻凭空冒出来"，完全没有凝聚感。
    // 短距离吸附 + 少数粒子从深处浮上来，才既有形状又有纵深。
    const tx = positionsOut[i * 3]
    const ty = positionsOut[i * 3 + 1]
    const tz = positionsOut[i * 3 + 2]
    const a = Math.random() * Math.PI * 2
    let sx
    let sy
    let sz
    if (Math.random() < 0.12) {
      const r = 0.30 + Math.random() * 0.80
      sx = Math.cos(a) * r
      sy = Math.sin(a) * r * 0.70
      sz = -(1.20 + Math.random() * 2.20)
    } else {
      const b = Math.acos(2 * Math.random() - 1)
      const d = 0.12 + Math.random() * 0.30
      sx = tx + Math.sin(b) * Math.cos(a) * d
      sy = ty + Math.cos(b) * d * 0.80
      sz = tz + Math.sin(b) * Math.sin(a) * d
      // 外轮廓那批从更外侧收进来，形成一圈向内推的波前
      if (o < 0.30) {
        sx *= 1.55
        sy *= 1.65
      }
    }

    start[i * 3] = sx
    start[i * 3 + 1] = sy
    start[i * 3 + 2] = sz
    delay[i] = Math.random() * 0.18
    rand[i] = Math.random()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positionsOut, 3))
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(colorsOut, 3))
  g.setAttribute('aNorm', new THREE.Float32BufferAttribute(normalsOut, 3))
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(sizesOut, 1))
  g.setAttribute('aStart', new THREE.BufferAttribute(start, 3))
  g.setAttribute('aDelay', new THREE.BufferAttribute(delay, 1))
  g.setAttribute('aRand', new THREE.BufferAttribute(rand, 1))
  g.setAttribute('aOrder', new THREE.BufferAttribute(order, 1))
  g.setAttribute('aEye', new THREE.BufferAttribute(eye, 1))
  g.computeBoundingSphere()
  return g
}

/**
 * @param {THREE.Object3D} root  载入后的场景根节点
 * @param {number} target        目标粒子数
 */
export async function sampleMeshToPoints(root, target = 260000) {
  root.updateWorldMatrix(true, true)

  // 1) 收集所有三角面（世界坐标）与所属材质
  let tris = [] // { a,b,c: Vector3, na,nb,nc, uva,uvb,uvc, tex, vcol }
  const meshes = []
  root.traverse((o) => {
    if (o.isMesh && o.geometry) meshes.push(o)
  })

  for (const mesh of meshes) {
    const geo = mesh.geometry
    const posAttr = geo.getAttribute('position')
    if (!posAttr) continue
    const nrmAttr = geo.getAttribute('normal')
    const uvAttr = geo.getAttribute('uv')
    const colAttr = geo.getAttribute('color')
    const idx = geo.getIndex()
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const tex = mats[0]?.map || null
    const texPixels = readTexturePixels(tex)

    geometryLoop:
    for (let groups = 0; groups < (geo.groups.length || 1); groups++) {
      const g = geo.groups[groups]
      const start = g ? g.start : 0
      const count = g ? g.count : idx ? idx.count : posAttr.count
      if (g && mats[g.materialIndex]?.map) {
        // 多材质时逐组取贴图，简化处理：沿用首图
      }
      for (let k = start; k + 2 < start + count; k += 3) {
        const ia = idx ? idx.getX(k) : k
        const ib = idx ? idx.getX(k + 1) : k + 1
        const ic = idx ? idx.getX(k + 2) : k + 2

        const a = new THREE.Vector3().fromBufferAttribute(posAttr, ia).applyMatrix4(mesh.matrixWorld)
        const b = new THREE.Vector3().fromBufferAttribute(posAttr, ib).applyMatrix4(mesh.matrixWorld)
        const c = new THREE.Vector3().fromBufferAttribute(posAttr, ic).applyMatrix4(mesh.matrixWorld)

        const area = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() * 0.5
        if (!(area > 0)) continue geometryLoop

        const nrm = mesh.matrixWorld.clone().invert().transpose() // 粗略法线变换
        const ga = nrmAttr ? new THREE.Vector3().fromBufferAttribute(nrmAttr, ia).applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)).normalize() : null
        const gb = nrmAttr ? new THREE.Vector3().fromBufferAttribute(nrmAttr, ib).applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)).normalize() : null
        const gc = nrmAttr ? new THREE.Vector3().fromBufferAttribute(nrmAttr, ic).applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)).normalize() : null
        void nrm

        tris.push({
          a, b, c, area,
          na: ga, nb: gb, nc: gc,
          uva: uvAttr ? new THREE.Vector2().fromBufferAttribute(uvAttr, ia) : null,
          uvb: uvAttr ? new THREE.Vector2().fromBufferAttribute(uvAttr, ib) : null,
          uvc: uvAttr ? new THREE.Vector2().fromBufferAttribute(uvAttr, ic) : null,
          ca: colAttr ? readVertexColor(colAttr, ia) : null,
          cb: colAttr ? readVertexColor(colAttr, ib) : null,
          cc: colAttr ? readVertexColor(colAttr, ic) : null,
          texPixels
        })
      }
    }
  }

  if (!tris.length) throw new Error('网格中没有可采样的三角面')

  // 摄影测量补洞会留下"桥接大三角"——几块巨大的假平面把破洞连起来。
  // 面积加权采样会把这些假面铺满粒子，于是模型周围出现莫名其妙的直角薄片。
  // 用中位数面积做离群剔除，只留下接近真实表面密度的三角面。
  {
    const areas = tris.map((t) => t.area).sort((m, n) => m - n)
    const medArea = areas[Math.floor(areas.length * 0.5)] || 0
    const A_MAX = medArea * 40
    if (medArea > 0) {
      const kept = tris.filter((t) => t.area <= A_MAX)
      if (kept.length > tris.length * 0.5) {
        console.log(
          '[mask] 剔除桥接大三角 %d 个（中位面积 %.6f，阈值 %d×）',
          tris.length - kept.length,
          medArea,
          40
        )
        tris = kept
      }
    }
  }

  // 2) 面积累积分布，做面积加权采样
  const totalArea = tris.reduce((s, t) => s + t.area, 0)
  const cdf = new Float32Array(tris.length)
  let acc = 0
  for (let i = 0; i < tris.length; i++) {
    acc += tris[i].area
    cdf[i] = acc / totalArea
  }

  // 3) 归一化：用 1%~99% 分位数代替 min/max，剔除摄影测量常见的离群碎片
  root.updateWorldMatrix(true, true)

  const xs = []
  const ys = []
  const zs = []
  for (let i = 0; i < tris.length; i += 3) {
    const t = tris[i]
    xs.push(t.a.x, t.b.x, t.c.x)
    ys.push(t.a.y, t.b.y, t.c.y)
    zs.push(t.a.z, t.b.z, t.c.z)
  }
  const pct = (arr, p) => {
    arr.sort((m, n) => m - n)
    return arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))]
  }
  const LO = 0.012
  const HI = 0.988
  const range = {
    x: [pct(xs, LO), pct(xs, HI)],
    y: [pct(ys, LO), pct(ys, HI)],
    z: [pct(zs, LO), pct(zs, HI)]
  }
  const extent = { x: range.x[1] - range.x[0], y: range.y[1] - range.y[0], z: range.z[1] - range.z[0] }
  const center = new THREE.Vector3(
    (range.x[0] + range.x[1]) / 2,
    (range.y[0] + range.y[1]) / 2,
    (range.z[0] + range.z[1]) / 2
  )
  const span = Math.max(extent.x, extent.y, extent.z)

  // 归一化后的半长（用于判断"离中心多远"），旋转 90° 时轴要跟着换
  const heSrc = new THREE.Vector3(extent.x / 2 / span, extent.y / 2 / span, extent.z / 2 / span)
  const he = heSrc.clone()

  // 最薄的一轴视为"朝向轴"：绕与之垂直的轴转 90°，让面具正对 +Z
  const depthAxis = extent.x < extent.y && extent.x < extent.z ? 'x' : extent.y < extent.z ? 'y' : 'z'
  if (depthAxis === 'x') he.set(heSrc.z, heSrc.y, heSrc.x)
  else if (depthAxis === 'y') he.set(heSrc.x, heSrc.z, heSrc.y)
  const rot = new THREE.Euler(0, 0, 0)
  if (depthAxis === 'x') rot.set(0, Math.PI / 2, 0)
  else if (depthAxis === 'y') rot.set(-Math.PI / 2, 0, 0)
  let rotM = new THREE.Matrix4().makeRotationFromEuler(rot)

  // 用面法线均值判断正反，脸朝反了就再翻 180°
  const probe = new THREE.Vector3()
  const probe2 = new THREE.Vector3()
  let nz = 0
  const step = Math.max(1, Math.floor(tris.length / 600))
  for (let i = 0; i < tris.length; i += step) {
    const t = tris[i]
    probe.copy(t.b).sub(t.a).cross(probe2.copy(t.c).sub(t.a))
    if (probe.lengthSq() < 1e-12) continue
    nz += probe.normalize().applyMatrix4(rotM).z
  }
  if (nz < 0) {
    const flip = depthAxis === 'y' ? new THREE.Euler(Math.PI, 0, 0) : new THREE.Euler(0, Math.PI, 0)
    rotM = new THREE.Matrix4().makeRotationFromEuler(flip).multiply(rotM)
  }

  console.log(
    '[mask] tris=%d dims=%s span=%s depthAxis=%s',
    tris.length,
    [extent.x, extent.y, extent.z].map((v) => v.toFixed(2)).join(' x '),
    span.toFixed(2),
    depthAxis
  )

  // —— 二阶矩二次校正 ——
  // "最薄的一轴 = 深度轴"只能把模型转到大概方向，剩下的偏航/滚转还有几度到十几度。
  // 用点云主成分把"宽度轴"精确对齐到 X、"竖直方向"对齐到 Y，正脸才真的正。
  {
    const c3 = new THREE.Vector3()
    let sxx = 0, szz = 0, sxz = 0, syy = 0, sxy = 0, cnt = 0
    const st = Math.max(1, Math.floor(tris.length / 4000))
    for (let i = 0; i < tris.length; i += st) {
      const t = tris[i]
      c3.set(0, 0, 0).addScaledVector(t.a, 1 / 3).addScaledVector(t.b, 1 / 3).addScaledVector(t.c, 1 / 3)
      c3.sub(center).applyMatrix4(rotM)
      sxx += c3.x * c3.x
      szz += c3.z * c3.z
      sxz += c3.x * c3.z
      syy += c3.y * c3.y
      sxy += c3.x * c3.y
      cnt++
    }
    if (cnt > 8) {
      const yaw = 0.5 * Math.atan2((2 * sxz) / cnt, (sxx - szz) / cnt)
      // 滚转（画面内的倾斜）实测只有 0.1°，校正反而引入误差，这里不做处理
      rotM = new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().makeRotationY(-yaw), rotM)
      console.log('[mask] 偏航校正 %s°', ((yaw * 180) / Math.PI).toFixed(2))
    }
  }

  // —— 整体朝向：多数投票决定翻不翻法线 ——
  // 不能逐点翻：壳体内外两侧的法线会被一起掰成"由中心朝外"，
  // 于是正面和背面同时被当成正面画上来，画面就会重影、出现说不清的折面。
  let FLIP = false
  {
    const c3 = new THREE.Vector3()
    const f1 = new THREE.Vector3()
    const f2 = new THREE.Vector3()
    let vote = 0
    const st = Math.max(1, Math.floor(tris.length / 2000))
    for (let i = 0; i < tris.length; i += st) {
      const t = tris[i]
      const n = t.na && t.nb && t.nc
        ? f1.copy(t.na).add(t.nb).add(t.nc)
        : f1.copy(t.b).sub(t.a).cross(f2.copy(t.c).sub(t.a))
      if (n.lengthSq() < 1e-12) continue
      n.normalize().applyMatrix4(rotM)
      c3.copy(t.a).add(t.b).add(t.c).multiplyScalar(1 / 3).sub(center).applyMatrix4(rotM)
      vote += Math.sign(n.dot(c3))
    }
    FLIP = vote < 0
    console.log('[mask] 法线整体翻转=%s 票数=%d', FLIP ? '是' : '否', vote)
  }

  const P = []
  const C = []
  const N = []
  const Sz = []
  const Ord = []
  const Eye = []

  const tmp = new THREE.Vector3()
  const cTmp = new THREE.Color()
  const p = new THREE.Vector3()
  const nv = new THREE.Vector3()
  const t2 = new THREE.Vector3()

  // 顺带统计 XZ/XY 平面上的二阶矩，用来判断扫描件有没有整体歪斜
  let sxx = 0
  let syy = 0
  let sxy = 0

  for (let i = 0; i < target; i++) {
    // 二分查找所属三角形
    let lo = 0
    let hi = tris.length - 1
    const r = Math.random()
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cdf[mid] < r) lo = mid + 1
      else hi = mid
    }
    const t = tris[lo]

    // 三角形内均匀采样
    let u = Math.random()
    let v = Math.random()
    if (u + v > 1) { u = 1 - u; v = 1 - v }
    const w = 1 - u - v

    p.set(0, 0, 0)
      .addScaledVector(t.a, w)
      .addScaledVector(t.b, u)
      .addScaledVector(t.c, v)

    // 归一化 + 居中 + 摆正朝向
    tmp.copy(p).sub(center).divideScalar(span).applyMatrix4(rotM)
    P.push(tmp.x, tmp.y, tmp.z)
    sxx += tmp.x * tmp.x
    syy += tmp.y * tmp.y
    sxy += tmp.x * tmp.y

    // 法线：优先用网格自带，缺失则用面法线
    if (t.na && t.nb && t.nc) {
      nv.set(0, 0, 0)
        .addScaledVector(t.na, w)
        .addScaledVector(t.nb, u)
        .addScaledVector(t.nc, v)
      if (nv.lengthSq() < 1e-8) nv.set(0, 0, 1)
      nv.normalize()
    } else {
      t2.copy(t.c).sub(t.a)
      nv.copy(t.b).sub(t.a).cross(t2).normalize()
    }
    // 先转到最终坐标系，再做朝向判断——之前拿原始坐标系的法线去点乘已旋转的位置，
    // 90° 旋转下这个点积几乎随机，一半法线被翻反，背面剔除就把表面切碎了。
    nv.applyMatrix4(rotM)
    if (FLIP) nv.negate()
    N.push(nv.x, nv.y, nv.z)

    // 颜色：优先贴图，其次顶点色，最后按法线给青铜色阶。
    // 这里复用同一个 Color 实例——每个点 new 一个的话，50 万个对象会把 GC 压到卡顿。
    let c = cTmp
    if (t.texPixels && t.uva && t.uvb && t.uvc) {
      const uu = t.uva.x * w + t.uvb.x * u + t.uvc.x * v
      const vv = t.uva.y * w + t.uvb.y * u + t.uvc.y * v
      const tx = Math.min(t.texPixels.w - 1, Math.max(0, Math.floor(uu * t.texPixels.w)))
      const ty = Math.min(t.texPixels.h - 1, Math.max(0, Math.floor((1 - vv) * t.texPixels.h)))
      const k = (ty * t.texPixels.w + tx) * 4
      const d = t.texPixels.data
      c.setRGB(d[k] / 255, d[k + 1] / 255, d[k + 2] / 255)
    } else if (t.ca && t.cb && t.cc) {
      c.setRGB(
        t.ca.r * w + t.cb.r * u + t.cc.r * v,
        t.ca.g * w + t.cb.g * u + t.cc.g * v,
        t.ca.b * w + t.cb.b * u + t.cc.b * v
      )
    } else {
      const g = 0.35 + 0.65 * Math.max(0, nv.z)
      c.copy(BRONZE_PLAIN).lerp(HIGH, g * 0.7)
    }

    // 特征优先级：轮廓、耳部、向前突出的部位给更大更亮的粒子，关键特征才读得出来。
    // 注意"轮廓"只能用屏幕平面内的 x/y 判断：面具是个浅碗，正面的 z 全都贴着
    // 前后壳的极限值，把 oz 算进来会让每个点都被判成轮廓，加权等于没做。
    const ox = Math.abs(tmp.x) / Math.max(he.x, 1e-4)
    const oy = Math.abs(tmp.y) / Math.max(he.y, 1e-4)
    const oz = Math.abs(tmp.z) / Math.max(he.z, 1e-4)
    const outline = THREE.MathUtils.smoothstep(Math.max(ox, oy), 0.70, 0.99)
    const protrude = THREE.MathUtils.smoothstep(oz, 0.28, 0.82)
    const feature = Math.max(outline, protrude * 0.82, 0.28)

    // 眼睛识别（给"最后点亮双眼"用）：脸上部、横向居中两侧、且法线明显偏斜——
    // 三星堆面具的眼是深凹的杏核形，凹坑壁的法线不会正对镜头。
    const ax = Math.abs(tmp.x)
    const inEyeBand = ax > 0.09 && ax < 0.33 && tmp.y > -0.01 && tmp.y < 0.21
    const isEye = inEyeBand && nv.z < 0.58 && outline < 0.52 ? 1 : 0

    // 到达顺序：0 = 最先（外轮廓），1 = 最后（双眼）。
    // 用连续径向距离当波前——硬分两波会在中段出现一条说不清来路的"环"。
    const radial = Math.min(1, Math.max(0, (Math.max(ox, oy) - 0.15) / 0.85))
    let order
    if (isEye) {
      order = 0.86 + Math.random() * 0.14
    } else {
      order = 0.05 + 0.62 * (1 - radial) + Math.random() * 0.05
    }
    Ord.push(Math.min(1, Math.max(0, order)))
    Eye.push(isEye)

    // 扫描件顶点色偏灰绿，按亮度映射到青铜色阶再与原色混合，保留纹理又不发"水泥/青苔"色
    const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b
    const bt = Math.min(1, Math.max(0, (lum - 0.04) / 0.42))
    c.lerp(bronzeRamp(bt), 0.66)
    c.multiplyScalar(1.02 * (0.94 + 0.12 * feature))
    c.lerp(HIGH, 0.03 + 0.06 * Math.max(0, nv.z))

    // 极少量金色亮点，模拟金属反光颗粒（多了会变成噪点）
    if (Math.random() < 0.012) c.lerp(BRONZE_GOLD, 0.30 + Math.random() * 0.20)

    // 逐点亮度抖动压到几乎不可见：色噪一大，形体就被"沙粒感"吃掉
    c.offsetHSL(0, 0, (Math.random() - 0.5) * 0.008)
    C.push(c.r, c.g, c.b)

    // 粒子尺寸以"细而匀"为主，只给特征部位很小的加成
    Sz.push((0.30 + Math.random() * 0.09) * (0.94 + 0.18 * feature))
  }

  const eyeCount = Eye.reduce((s, v) => s + v, 0)
  console.log(
    '[mask] 主轴倾角 %s°（0 表示完全正），点云 %d，眼睛区 %d 点',
    ((0.5 * Math.atan2((2 * sxy) / target, (sxx - syy) / target) * 180) / Math.PI).toFixed(2),
    target,
    eyeCount
  )

  return makeSampledGeometry(P, C, N, Sz, Ord, Eye)
}
