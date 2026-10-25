import puppeteer from 'puppeteer-core'
import path from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = process.argv[2]
const OUT = process.argv[3] || './ref-shot'
const STOPS = Number(process.argv[4] || 5)
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
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 }
})

const page = await browser.newPage()
const logs = []
page.on('console', (m) => {
  const t = m.text()
  if (!/WebGL|Download the React|\[vite\]|\[HMR\]/.test(t)) logs.push(`[${m.type()}] ${t.slice(0, 160)}`)
})
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message.slice(0, 160)}`))

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
await new Promise((r) => setTimeout(r, 7000))

const info = await page.evaluate(() => ({
  canvas: document.querySelectorAll('canvas').length,
  height: document.body.scrollHeight,
  title: document.title,
  text: (document.body.innerText || '').slice(0, 160).replace(/\s+/g, ' ')
}))

console.log(JSON.stringify({ ...info, logs: logs.slice(0, 10) }, null, 2))

const h = info.height
for (let i = 0; i < STOPS; i++) {
  const y = Math.round((h - 900) * (i / Math.max(1, STOPS - 1)))
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y)
  await new Promise((r) => setTimeout(r, 4500))
  await page.screenshot({ path: `${OUT}-${i}.png` })
  console.log('shot', i, 'y=', y)
}

await browser.close()
