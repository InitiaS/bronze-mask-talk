import puppeteer from 'puppeteer-core'
import path from 'node:path'
import fs from 'node:fs'

/**
 * 验证"边放边录"真的能出画面：
 * 拦截下载到一个目录里，录 6 秒，再用 ffmpeg 抽帧统计亮度——
 * 全黑视频的 YAVG 会接近 16（limited range 的黑电平），有内容会明显更高。
 */
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const cwd = process.cwd()
fs.mkdirSync(path.join(cwd, '.tmp'), { recursive: true })
const DL = path.join(cwd, 'rec')
fs.rmSync(DL, { recursive: true, force: true })
fs.mkdirSync(DL, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: path.join(cwd, `.chrome-rec-${Date.now()}`),
  env: { ...process.env, TMPDIR: path.join(cwd, '.tmp') },
  args: [
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--no-sandbox', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-crash-reporter', '--autoplay-policy=no-user-gesture-required', '--mute-audio'
  ],
  defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 }
})

const page = await browser.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
const client = await page.target().createCDPSession()
await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL })

await page.goto('http://127.0.0.1:5180/talk.html?nogate=1&front=1&panel=0&hold=0.7', {
  waitUntil: 'networkidle2',
  timeout: 60000
})
await page.waitForFunction('window.__MASK_PARTICLE_COUNT__ > 0', { timeout: 120000 })
await new Promise((r) => setTimeout(r, 5000))

// 先把音频放起来，这样录出来的轨也有声音
await page.evaluate(() => window.__TALK__.narr.play())
await new Promise((r) => setTimeout(r, 1200))

// tools 里第三个按钮是"录制"
const btns = await page.$$('.tools button')
console.log('工具按钮数:', btns.length)
await btns[2].click()
await new Promise((r) => setTimeout(r, 6000))
await btns[2].click()
await new Promise((r) => setTimeout(r, 3000))

const size = await page.evaluate(() => window.__LAST_REC_SIZE__ || 0)
const files = fs.readdirSync(DL).filter((f) => f.endsWith('.webm'))
console.log('blob 大小:', size, ' 落盘文件:', files)
console.log('错误:', errs.slice(0, 5).join(' | ') || 'none')
await browser.close()

if (!files.length) {
  console.log('!! 没有下载到文件')
  process.exit(1)
}
const f = path.join(DL, files[0])
console.log('文件大小:', (fs.statSync(f).size / 1024).toFixed(0), 'KB')
