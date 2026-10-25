import puppeteer from 'puppeteer-core'
import path from 'node:path'
import fs from 'node:fs'

/** 抓界面态：node shot-ui.mjs <url> <out.png> [waitMs] [vw] [vh] */
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = process.argv[2]
const OUT = process.argv[3] || 'ui.png'
const WAIT = Number(process.argv[4] || 7000)
const VW = Number(process.argv[5] || 1440)
const VH = Number(process.argv[6] || 900)
const cwd = process.cwd()
fs.mkdirSync(path.join(cwd, '.tmp'), { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: path.join(cwd, `.chrome-ui-${Date.now()}`),
  env: { ...process.env, TMPDIR: path.join(cwd, '.tmp') },
  args: [
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--no-sandbox', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-crash-reporter', '--autoplay-policy=no-user-gesture-required', '--mute-audio'
  ],
  defaultViewport: { width: VW, height: VH, deviceScaleFactor: 1 }
})

const page = await browser.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
await page.waitForFunction('window.__MASK_PARTICLE_COUNT__ > 0', { timeout: 120000 })
await new Promise((r) => setTimeout(r, WAIT))
await page.screenshot({ path: OUT })
console.log('shot', OUT, 'errors:', errs.slice(0, 5).join(' | ') || 'none')
await browser.close()
