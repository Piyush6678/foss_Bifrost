// Headless UI walkthrough of the real app in local Chrome.
// Run the dev stack (npm run dev), then: npm run e2e:ui
// Note: waits use interval polling because rAF never fires in hidden tabs.
import puppeteer from 'puppeteer-core'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OUT = path.join(os.tmpdir(), 'collab-e2e-shots') + path.sep
fs.mkdirSync(OUT, { recursive: true })
const URL = process.env.APP_URL || 'http://localhost:5173'
const browser = await puppeteer.launch({
  // Uses an installed Chrome/Edge; override with CHROME_PATH.
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  defaultViewport: { width: 1400, height: 900 },
})
const errors = []
const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name} console: ${m.text()}`))
}
const ok = (msg) => console.log('  ✓', msg)
const newDoc = async (page, type) => {
  await page.click('[data-new-menu]')
  await page.waitForSelector(`.menu [data-new="${type}"]`)
  await page.click(`.menu [data-new="${type}"]`)
}
const clickButton = (page, text) =>
  page.evaluate((t) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t).click(), text)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  const ctx = await browser.createBrowserContext()
  const p1 = await ctx.newPage()
  watch(p1, 'p1')

  // ---- sign up through the UI ----
  await p1.goto(URL + '/signup', { waitUntil: 'networkidle0' })
  await p1.type('input:not([type])', 'Ada')
  await p1.type('input[type=email]', `ui-${Date.now()}@test.io`)
  await p1.type('input[type=password]', crypto.randomUUID())
  await p1.click('button.primary')
  await p1.waitForSelector('[data-new-menu]')
  ok('signed up and landed on dashboard')
  await p1.screenshot({ path: OUT + '1-dashboard.png' })

  // ---- rich document ----
  await newDoc(p1, 'doc')
  await p1.waitForSelector('.ProseMirror')
  const docUrl = p1.url()
  await p1.bringToFront()
  await p1.click('.ProseMirror')
  await p1.keyboard.type('Hello from tab one')
  const p2 = await ctx.newPage()
  watch(p2, 'p2')
  await p2.goto(docUrl, { waitUntil: 'networkidle0' })
  await p2.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent.includes('Hello from tab one'), { timeout: 10000, polling: 100 })
  ok('second tab receives the rich text')
  await p2.click('.ProseMirror')
  await p2.keyboard.press('End')
  await p2.keyboard.type(' and tab two')
  await p1.waitForFunction(() => document.querySelector('.ProseMirror').textContent.includes('and tab two'), { timeout: 10000, polling: 100 })
  ok('first tab receives the second tab’s edit')
  await p1.waitForFunction(() => document.querySelectorAll('.presence-bar .avatar').length >= 2 && document.querySelector('.collaboration-cursor__caret'), { timeout: 10000, polling: 100 })
  ok('presence avatars + remote cursor rendered')
  await p1.waitForFunction(() => document.querySelector('.status-badge')?.textContent.includes('Live'), { polling: 100 })
  ok('status badge shows Live')

  // offline via the network simulator, edit both sides, reconnect
  await p1.bringToFront()
  await clickButton(p1, 'Network')
  await p1.waitForSelector('.switch-row input')
  await p1.click('.switch-row input')
  await p1.waitForFunction(() => document.querySelector('.status-badge').textContent.includes('Offline'), { polling: 100 })
  await p1.click('.ProseMirror')
  await p1.keyboard.press('End')
  await p1.keyboard.type(' [offline-A]')
  await p2.keyboard.type(' [online-B]')
  await p1.waitForFunction(() => document.querySelector('.status-badge').textContent.includes('local change'), { polling: 100 })
  ok('offline edits counted as pending local changes')
  await p1.screenshot({ path: OUT + '2-offline.png' })
  await p1.click('.switch-row input')
  const both = () => {
    const t = document.querySelector('.ProseMirror').textContent
    return t.includes('[offline-A]') && t.includes('[online-B]')
  }
  await p1.waitForFunction(both, { timeout: 10000, polling: 100 })
  await p2.waitForFunction(both, { timeout: 10000, polling: 100 })
  const t1 = await p1.$eval('.ProseMirror', (e) => e.textContent)
  const t2 = await p2.$eval('.ProseMirror', (e) => e.textContent)
  if (t1 !== t2) throw new Error(`diverged:\n${t1}\n---\n${t2}`)
  ok(`reconnect merged concurrent edits identically: "${t1}"`)

  // metrics + history panels render
  await clickButton(p1, 'Metrics')
  await p1.waitForFunction(() => document.querySelector('.side-panel')?.textContent.includes('Op-log entries'), { polling: 100 })
  ok('metrics panel shows server op-log stats')
  await clickButton(p1, 'History')
  await p1.waitForSelector('.side-panel form input')
  await p1.type('.side-panel form input', 'checkpoint')
  await p1.click('.side-panel form button')
  await p1.waitForSelector('.version-item')
  await p1.click('.version-item')
  await p1.waitForFunction(() => document.querySelector('.preview-box')?.textContent.includes('Hello from tab one'), { polling: 100 })
  ok('version saved and previewed')
  await p1.screenshot({ path: OUT + '3-richdoc.png' })

  // ---- whiteboard ----
  await p1.goto(URL + '/', { waitUntil: 'networkidle0' })
  await newDoc(p1, 'board')
  await p1.waitForSelector('.wb-canvas')
  const boardUrl = p1.url()
  await p2.goto(boardUrl, { waitUntil: 'networkidle0' })
  await p2.waitForSelector('.wb-canvas')
  await p1.keyboard.press('r')
  const box = await p1.$eval('.wb-canvas', (e) => {
    const r = e.getBoundingClientRect()
    return { x: r.left, y: r.top }
  })
  await p1.mouse.move(box.x + 200, box.y + 150)
  await p1.mouse.down()
  await p1.mouse.move(box.x + 300, box.y + 220, { steps: 5 })
  await p1.mouse.move(box.x + 380, box.y + 280, { steps: 5 })
  await p1.mouse.up()
  await p2.waitForFunction(() => document.querySelectorAll('.wb-canvas [data-shape] rect').length >= 1, { timeout: 10000, polling: 100 })
  ok('rectangle drawn in tab 1 appears in tab 2')
  // drag it from tab 2, check position in tab 1
  await p2.bringToFront()
  await p2.mouse.move(box.x + 290, box.y + 215)
  await p2.mouse.down()
  await p2.mouse.move(box.x + 490, box.y + 315, { steps: 6 })
  await p2.mouse.up()
  await p1.waitForFunction(() => Number(document.querySelector('[data-shape] rect').getAttribute('x')) > 350, { timeout: 10000, polling: 100 })
  ok('move in tab 2 propagates to tab 1')
  await p1.waitForFunction(() => document.querySelector('.remote-pointer'), { timeout: 10000, polling: 100 })
  ok('remote pointer rendered')
  await p1.bringToFront()
  await p1.keyboard.press('s')
  await p1.mouse.click(box.x + 700, box.y + 400)
  await p1.waitForSelector('.wb-text-edit')
  await p1.keyboard.type('sticky note!')
  await p2.waitForFunction(() => [...document.querySelectorAll('.wb-text')].some((e) => e.textContent.includes('sticky note!')), { timeout: 10000, polling: 100 })
  ok('sticky note text (Y.Text) syncs')
  await p1.mouse.click(box.x + 1200, box.y + 700)
  await p1.screenshot({ path: OUT + '4-board.png' })

  // ---- RGA plain text ----
  await p1.goto(URL + '/', { waitUntil: 'networkidle0' })
  await newDoc(p1, 'text')
  await p1.waitForSelector('.rga-textarea')
  const textUrl = p1.url()
  await p2.goto(textUrl, { waitUntil: 'networkidle0' })
  await p2.waitForSelector('.rga-textarea')
  await p1.click('.rga-textarea')
  await p1.keyboard.type('RGA says hi')
  await p2.waitForFunction(() => document.querySelector('.rga-textarea').value === 'RGA says hi', { timeout: 10000, polling: 100 })
  ok('RGA text syncs between tabs')
  await p2.bringToFront()
  await p2.click('.rga-textarea')
  await p2.keyboard.press('Home')
  await p2.keyboard.type('>> ')
  await p1.waitForFunction(() => document.querySelector('.rga-textarea').value === '>> RGA says hi', { timeout: 10000, polling: 100 })
  const caret = await p1.$eval('.rga-textarea', (e) => e.selectionStart)
  if (caret !== 14) throw new Error('caret not preserved, got ' + caret)
  ok('local caret preserved across remote insert (stable RGA positions)')
  await p1.waitForSelector('.remote-caret', { timeout: 10000, polling: 100 })
  ok('remote caret overlay rendered')
  await p1.screenshot({ path: OUT + '5-rga.png' })

  // ---- Lab ----
  const lab = await ctx.newPage()
  watch(lab, 'lab')
  await lab.goto(URL + '/lab', { waitUntil: 'networkidle0' })
  const areas = await lab.$$('.rga-textarea')
  await areas[0].type('alice ')
  await lab.waitForFunction(() => [...document.querySelectorAll('.rga-textarea')].every((t) => t.value === 'alice '), { timeout: 10000, polling: 100 })
  ok('lab: three peers converge')
  await lab.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Partition all').click())
  await areas[1].type('bob ')
  await areas[2].type('carol ')
  await lab.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Random concurrent')).click())
  await lab.waitForFunction(() => document.querySelector('.converge-pill').textContent.includes('diverged'), { polling: 100 })
  ok('lab: partition causes divergence')
  await wait(1500)
  await lab.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Heal all').click())
  await lab.waitForFunction(() => document.querySelector('.converge-pill').textContent.includes('converged'), { timeout: 10000, polling: 100 })
  const vals = await lab.$$eval('.rga-textarea', (ts) => ts.map((t) => t.value))
  if (new Set(vals).size !== 1) throw new Error('lab diverged ' + JSON.stringify(vals))
  ok(`lab: heal + anti-entropy converges ("${vals[0].slice(0, 40)}…")`)
  await lab.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('GC tombstones')).click())
  await lab.waitForFunction(() => document.querySelector('.net-log').textContent.includes('tombstone GC'), { polling: 100 })
  ok('lab: tombstone GC ran')
  await lab.screenshot({ path: OUT + '6-lab.png', fullPage: true })

  const real = errors.filter((e) => !/WebSocket|ERR_INTERNET|Failed to load resource/.test(e))
  if (real.length) {
    console.log('Console/page errors:')
    real.forEach((e) => console.log('  ', e))
  } else ok('no page errors in any tab')
  console.log('UI TEST DONE, screenshots in', OUT)
} catch (e) {
  console.error('FAILED:', e.message)
  errors.forEach((x) => console.log('  ', x))
  const pages = await browser.pages()
  for (const [i, p] of pages.entries()) await p.screenshot({ path: OUT + `fail-${i}.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
