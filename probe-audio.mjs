import puppeteer from 'puppeteer-core'
import path from 'node:path'
import fs from 'node:fs'

/**
 * 端到端验证：把讲解音频放起来，在页面内按帧采集开口量并算分位数。
 * 外部每 250 ms 采一次会严重混叠——包络在 10 Hz 上下跳，采样点撞到什么全看运气。
 */
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = process.argv[2] || 'http://127.0.0.1:5180/talk.html?nogate=1&panel=0&front=1'
const SECS = Number(process.argv[3] || 15)
const cwd = process.cwd()
fs.mkdirSync(path.join(cwd, '.tmp'), { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: path.join(cwd, `.chrome-audio-${Date.now()}`),
  env: { ...process.env, TMPDIR: path.join(cwd, '.tmp') },
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio'
  ],
  defaultViewport: { width: 1200, height: 1200, deviceScaleFactor: 1 }
})

const page = await browser.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error' || m.text().includes('talk')) errs.push(`[${m.type()}] ${m.text()}`)
})

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
await page.waitForFunction('window.__MASK_PARTICLE_COUNT__ > 0', { timeout: 120000 })
await new Promise((r) => setTimeout(r, 4500))

const started = await page.evaluate(async () => {
  try {
    await window.__TALK__.narr.play()
    return { ok: true, state: window.__TALK__.narr.ctx?.state, dur: window.__TALK__.narr.duration }
  } catch (e) {
    return { ok: false, err: String(e) }
  }
})
console.log('play:', JSON.stringify(started))

// 播放 6 s 后再开始统计，避开起播瞬间的跟随器收敛过程
await new Promise((r) => setTimeout(r, 6000))
await page.screenshot({ path: 'audio-mid.png' })

const st = await page.evaluate(
  (secs) =>
    new Promise((res) => {
      const arr = []
      const wr = []
      const t0 = performance.now()
      const tick = () => {
        arr.push(window.__TALK__.mouth.open)
        wr.push(window.__TALK__.narr.rms)
        if (performance.now() - t0 < secs * 1000) requestAnimationFrame(tick)
        else {
          const s = (a) => a.slice().sort((x, y) => x - y)
          const A = s(arr)
          const R = s(wr)
          const q = (a) => (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))]
          const qa = q(A)
          const qr = q(R)
          res({
            n: A.length,
            open: {
              min: A[0], p10: qa(0.1), p25: qa(0.25), p50: qa(0.5),
              p75: qa(0.75), p90: qa(0.9), p99: qa(0.99), max: A[A.length - 1],
              mean: A.reduce((x, y) => x + y, 0) / A.length
            },
            rms: { min: R[0], p50: qr(0.5), p90: qr(0.9), max: R[R.length - 1] },
            ref: window.__TALK__.narr.ref,
            t: window.__TALK__.narr.currentTime
          })
        }
      }
      requestAnimationFrame(tick)
    }),
  SECS
)

const f = (o) => Object.entries(o).map(([k, v]) => `${k}=${Number(v).toFixed(3)}`).join('  ')
console.log('open ', f(st.open))
console.log('rms  ', f(st.rms), ` ref=${st.ref.toFixed(3)}  t=${st.t.toFixed(1)}s  n=${st.n}`)
console.log('--- 错误 ---')
console.log(errs.slice(0, 8).join('\n') || '(none)')

await browser.close()
