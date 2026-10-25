import puppeteer from 'puppeteer-core'
import path from 'node:path'
import fs from 'node:fs'

/**
 * 验证「部署到子路径」是否真的能用。
 * 用法：node verify-pages.mjs <baseDir>   baseDir 例如 http://127.0.0.1:8791/bronze-mask-talk
 * 逐个页面打开，记录 4xx/5xx 请求、pageerror、以及关键状态（粒子数、音频时长）。
 */
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = (process.argv[2] || 'http://127.0.0.1:8791/bronze-mask-talk').replace(/\/$/, '')
const cwd = process.cwd()
fs.mkdirSync(path.join(cwd, '.tmp'), { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: path.join(cwd, `.chrome-verify-${Date.now()}`),
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
    // 假摄像头，让 face.html 能走到 MediaPipe 初始化，从而真正去取 wasm 与 .task
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream'
  ],
  defaultViewport: { width: 1000, height: 1000, deviceScaleFactor: 1 }
})

const PAGES = [
  { file: 'index.html', wait: 'window.__MASK_PARTICLE_COUNT__ > 0', label: '粒子重构' },
  { file: 'talk.html', wait: 'window.__MASK_PARTICLE_COUNT__ > 0', label: '开口讲解' },
  { file: 'face.html', wait: '1', label: '戴上面具' }
]

let bad = 0
for (const p of PAGES) {
  const page = await browser.newPage()
  const errs = []
  const notFound = []
  page.on('pageerror', (e) => errs.push(e.message))
  page.on('response', (r) => {
    const s = r.status()
    if (s >= 400) notFound.push(`${s} ${r.url().replace(BASE, '')}`)
  })
  await page.goto(`${BASE}/${p.file}`, { waitUntil: 'networkidle2', timeout: 90000 })
  try {
    await page.waitForFunction(p.wait, { timeout: 120000 })
  } catch {
    errs.push(`waitForFunction 超时：${p.wait}`)
  }
  await new Promise((r) => setTimeout(r, p.file === 'face.html' ? 9000 : 3000))

  const st = await page.evaluate(() => ({
    particles: window.__MASK_PARTICLE_COUNT__ || 0,
    audioDur: window.__TALK__?.narr?.el?.duration ?? null,
    audioSrc: window.__TALK__?.narr?.el?.currentSrc ?? null,
    canvas: document.querySelector('canvas')?.width ?? null
  }))

  console.log(`\n[${p.label}] ${p.file}`)
  console.log(`  particles=${st.particles} canvas=${st.canvas} audio=${st.audioDur ? st.audioDur.toFixed(2) + 's' : '—'}`)
  if (st.audioSrc) console.log(`  audioSrc=${st.audioSrc}`)
  console.log(`  4xx/5xx: ${notFound.length ? notFound.join(' | ') : '无'}`)
  console.log(`  pageerror: ${errs.length ? errs.join(' | ') : '无'}`)
  if (notFound.length || errs.length) bad++
  await page.close()
}

await browser.close()
console.log(`\n${bad === 0 ? '✅ 三个页面在子路径下均无 404、无脚本错误' : `❌ ${bad} 个页面有问题`}`)
process.exit(bad === 0 ? 0 : 1)
