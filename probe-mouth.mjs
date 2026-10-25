import puppeteer from 'puppeteer-core'
import path from 'node:path'
import fs from 'node:fs'

/**
 * 抓取嘴部定位探针：截图 + 数值网格。
 * 用法：node probe-mouth.mjs [url]
 */
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = process.argv[2] || 'http://127.0.0.1:5180/mouthprobe.html'
const cwd = process.cwd()
fs.mkdirSync(path.join(cwd, '.tmp'), { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: path.join(cwd, `.chrome-probe-${Date.now()}`),
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
  defaultViewport: { width: 1200, height: 1200, deviceScaleFactor: 1 }
})

const page = await browser.newPage()
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
await page.waitForFunction('window.__READY__ === true', { timeout: 90000 })
await new Promise((r) => setTimeout(r, 500))

const OUT = process.argv[3] || 'mouth-probe.png'
await page.screenshot({ path: OUT })
const probe = await page.evaluate(() => window.__PROBE__)
fs.writeFileSync(OUT.replace(/\.png$/, '.json'), JSON.stringify(probe))
console.log('saved', OUT)

console.log('--- console ---')
console.log(logs.filter((l) => l.includes('probe') || l.includes('mask') || l.includes('error')).join('\n') || '(none)')
await browser.close()
