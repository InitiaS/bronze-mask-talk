import puppeteer from 'puppeteer-core'
import path from 'node:path'
import fs from 'node:fs'

/**
 * 抓 talk.html 的口型静帧。
 * 用法：node shot-talk.mjs <base> <outPrefix> [hold1,hold2,...] [vw] [vh]
 * 每张图靠 URL 上的 ?hold= 固定张口量，配合 front/nogate 得到可比的正面视图。
 */
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = process.argv[2] || 'http://127.0.0.1:5180/talk.html'
const PREFIX = process.argv[3] || 'talk'
const HOLDS = (process.argv[4] || '0,0.95').split(',').map(Number)
const VW = Number(process.argv[5] || 1200)
const VH = Number(process.argv[6] || 1200)
const cwd = process.cwd()
fs.mkdirSync(path.join(cwd, '.tmp'), { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: path.join(cwd, `.chrome-talk-${Date.now()}`),
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
    '--autoplay-policy=no-user-gesture-required'
  ],
  defaultViewport: { width: VW, height: VH, deviceScaleFactor: 1 }
})

const logs = []
for (const h of HOLDS) {
  const page = await browser.newPage()
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  const url = `${BASE}?front=1&nogate=1&panel=0&still=1&hold=${h}`
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
  // 等点云采样完成（820k 点大约 3~6 s）再定格
  await page.waitForFunction('window.__MASK_PARTICLE_COUNT__ > 0', { timeout: 120000 })
  await new Promise((r) => setTimeout(r, 6000))
  const out = `${PREFIX}-hold${h}.png`
  await page.screenshot({ path: out })
  const info = await page.evaluate(() => ({
    particles: window.__MASK_PARTICLE_COUNT__ || 0,
    mouth: window.__TALK__ ? { ...window.__TALK__.mouth } : null
  }))
  console.log('shot', out, JSON.stringify(info))
  await page.close()
}

console.log('--- console ---')
console.log(logs.filter((l) => !l.includes('Download the React')).slice(0, 30).join('\n') || '(none)')
await browser.close()
