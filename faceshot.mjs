import puppeteer from 'puppeteer-core'
import path from 'node:path'

/**
 * 一次加载、多组参数各截一张。
 * 静态图模式下位姿是定死的，改参数只要重算一次，不用重新跑 MediaPipe——
 * 一次加载能顶十次重新加载。
 */

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = process.argv[2] || 'http://127.0.0.1:5199/face.html'
const PREFIX = process.argv[3] || 'fs'
const VW = Number(process.argv[4] || 1024)
const VH = Number(process.argv[5] || 1024)
const cwd = process.cwd()

// 每组：{ tag, expo, pt, gain, shade }
const GROUPS = JSON.parse(
  process.argv[6] ||
    '[{"tag":"a","expo":0.42},{"tag":"b","expo":0.62},{"tag":"c","expo":0.85}]'
)

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

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction('window.__FACE_OK__ === true', { timeout: 120000 })
await new Promise((r) => setTimeout(r, 1200))

for (const g of GROUPS) {
  await page.evaluate((c) => window.__face.set(c), g)
  await new Promise((r) => setTimeout(r, 700))
  const out = `${PREFIX}-${g.tag}.png`
  await page.screenshot({ path: out })
  console.log('saved', out)
}

const info = await page.evaluate(() => ({
  ok: !!window.__FACE_OK__,
  status: document.getElementById('status')?.textContent
}))
console.log(JSON.stringify(info))
console.log('--- console ---')
console.log(logs.filter((l) => /face\]|error|pageerror/.test(l)).slice(0, 20).join('\n'))
await browser.close()
