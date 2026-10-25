import puppeteer from 'puppeteer-core'
import path from 'node:path'
import fs from 'node:fs'

/** 走真实交互路径：点"开始讲解"按钮 → 检查音频是否真的在放、口型是否有变化 */
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = process.argv[2] || 'http://127.0.0.1:5180/talk.html?still=1'
const cwd = process.cwd()
fs.mkdirSync(path.join(cwd, '.tmp'), { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: path.join(cwd, `.chrome-flow-${Date.now()}`),
  env: { ...process.env, TMPDIR: path.join(cwd, '.tmp') },
  args: [
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--no-sandbox', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-crash-reporter', '--autoplay-policy=no-user-gesture-required', '--mute-audio'
  ],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 }
})

const page = await browser.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errs.push('[err] ' + m.text()) })

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
await page.waitForFunction('window.__MASK_PARTICLE_COUNT__ > 0', { timeout: 120000 })
await new Promise((r) => setTimeout(r, 5000))

// 按钮文案在 ready 之后才变成"开始讲解"
const label = await page.evaluate(() => document.querySelector('.play')?.textContent)
console.log('按钮文案:', JSON.stringify(label))
await page.click('.play')
await new Promise((r) => setTimeout(r, 3000))

const st = await page.evaluate(() => ({
  playing: window.__TALK__.narr.playing,
  t: window.__TALK__.narr.currentTime,
  dur: window.__TALK__.narr.duration,
  open: window.__TALK__.mouth.open,
  gateHidden: document.querySelector('.gate')?.classList.contains('hide'),
  panel: !!document.querySelector('.panel')
}))
console.log('播放状态:', JSON.stringify(st))

await new Promise((r) => setTimeout(r, 4000))
// 等到一个"正在重音上"的帧再截图，静态图才看得出张口
for (let i = 0; i < 60; i++) {
  const o = await page.evaluate(() => window.__TALK__.mouth.open)
  if (o > 0.82) break
  await new Promise((r) => setTimeout(r, 60))
}
await page.screenshot({ path: 'flow-playing.png' })
const st2 = await page.evaluate(() => ({ t: window.__TALK__.narr.currentTime, open: window.__TALK__.mouth.open }))
console.log('4 秒后:', JSON.stringify(st2))
console.log('错误:', errs.slice(0, 6).join(' | ') || 'none')
await browser.close()
