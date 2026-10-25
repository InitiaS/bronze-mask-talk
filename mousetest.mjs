import puppeteer from 'puppeteer-core'
import path from 'node:path'

/**
 * 鼠标交互验证：把指针移到面具上，分别截"无鼠标 / 按下并在脸上划过 / 移开"三张。
 * 用法：node mousetest.mjs [url] [vw] [vh]
 */
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = process.argv[2] || 'http://127.0.0.1:5180/?still=1&turn=0&at=1'
const VW = Number(process.argv[3] || 1100)
const VH = Number(process.argv[4] || 700)
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
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
page.on('console', (m) => {
  const t = m.text()
  if (t.includes('mask') || m.type() === 'error') errs.push(`[${m.type()}] ${t}`)
})

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 40000 })
await new Promise((r) => setTimeout(r, 9000))

await page.screenshot({ path: 'mouse-0-none.png' })

// 指针压到面具右眼附近，慢慢向左划过
await page.mouse.move(VW * 0.58, VH * 0.42)
await new Promise((r) => setTimeout(r, 400))
await page.screenshot({ path: 'mouse-1-hover.png' })

for (let i = 0; i <= 10; i++) {
  await page.mouse.move(VW * (0.58 - i * 0.022), VH * 0.44)
  await new Promise((r) => setTimeout(r, 45))
}
await new Promise((r) => setTimeout(r, 250))
await page.screenshot({ path: 'mouse-2-sweep.png' })

// 移出画布，粒子应自行归位
await page.mouse.move(VW * 0.5, VH * 1.6)
await new Promise((r) => setTimeout(r, 1200))
await page.screenshot({ path: 'mouse-3-back.png' })

console.log('errors:', errs.slice(0, 6).join('\n') || '(none)')
await browser.close()
