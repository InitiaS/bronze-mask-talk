import puppeteer from 'puppeteer-core'
import path from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = process.argv[2] || 'http://127.0.0.1:5199/'
const OUT = process.argv[3] || '/tmp/mask_shot2.png'
const WAIT = Number(process.argv[4] || 5000)
const VW = Number(process.argv[5] || 1440)
const VH = Number(process.argv[6] || 900)
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

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 })
await new Promise((r) => setTimeout(r, WAIT))

const info = await page.evaluate(() => ({
  particles: window.__MASK_PARTICLE_COUNT__ || 0,
  hasCanvas: !!document.querySelector('canvas'),
  loaderHidden: !!document.querySelector('.loader.hide'),
  stat: document.querySelector('.stat b')?.textContent || ''
}))

await page.screenshot({ path: OUT })
console.log(JSON.stringify(info, null, 2))
console.log('--- console ---')
console.log(logs.slice(0, 60).join('\n') || '(none)')
await browser.close()
