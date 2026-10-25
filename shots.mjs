import puppeteer from 'puppeteer-core'
import path from 'node:path'

/**
 * 一次加载、多次定格：用 window.__setAt() 抽查汇聚动画的任意进度帧，
 * 避免每张图都重开一次 Chrome（重开一次要 1 分钟，其中一半是冷启动）。
 *
 * 用法：node shots.mjs <url> <outPrefix> <waitMs> <vw> <vh> <at1,at2,...>
 */
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = process.argv[2] || 'http://127.0.0.1:5180/?still=1&turn=0'
const PREFIX = process.argv[3] || 'frame'
const WAIT = Number(process.argv[4] || 6500)
const VW = Number(process.argv[5] || 1100)
const VH = Number(process.argv[6] || 700)
const ATS = (process.argv[7] || '0.34,0.62,0.86,1').split(',').map(Number)
const cwd = process.cwd()

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: path.join(cwd, `.chrome-profile-${Date.now()}`),
  env: { ...process.env, TMPDIR: path.join(cwd, '.tmp') },
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter'
  ],
  defaultViewport: { width: VW, height: VH, deviceScaleFactor: 1 }
})

const page = await browser.newPage()
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 40000 })
await new Promise((r) => setTimeout(r, WAIT))

for (const at of ATS) {
  await page.evaluate((v) => window.__setAt && window.__setAt(v), at)
  await new Promise((r) => setTimeout(r, 900))
  const out = `${PREFIX}-${at}.png`
  await page.screenshot({ path: out })
  console.log('shot', out)
}

const info = await page.evaluate(() => ({
  particles: window.__MASK_PARTICLE_COUNT__ || 0,
  loaderHidden: !!document.querySelector('.loader.hide')
}))
console.log(JSON.stringify(info))
console.log('--- console ---')
console.log(logs.filter((l) => l.includes('mask') || l.includes('error')).slice(0, 20).join('\n') || '(none)')
await browser.close()
