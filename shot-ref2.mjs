import puppeteer from 'puppeteer-core'
import path from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = process.argv[2]
const OUT = process.argv[3] || './ref-shot'
const YS = String(process.argv[4] || '0').split(',').map(Number)
const WAIT = Number(process.argv[5] || 8000)
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
    '--no-default-browser-check'
  ],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 }
})

const page = await browser.newPage()
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
await new Promise((r) => setTimeout(r, 7000))

let i = 0
for (const y of YS) {
  // 分几步滚过去，让滚动叙事有时间触发
  const cur = await page.evaluate(() => window.scrollY)
  const steps = 6
  for (let s = 1; s <= steps; s++) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), cur + ((y - cur) * s) / steps)
    await new Promise((r) => setTimeout(r, 260))
  }
  await new Promise((r) => setTimeout(r, WAIT))
  await page.screenshot({ path: `${OUT}-${i}.png` })
  console.log('shot', i, 'y=', y)
  i++
}

await browser.close()
