// The phone side, in the Even companion app's design language: sign in (QR code or phone number),
// drive and watch the lens, browse Telegram chats and press bot buttons, settings.
import { renderSVG } from 'uqr'
import type { LogEntry } from './app'
import { needsYes, type Action } from './cards'
import { adNeedsConfirm, type Bubble, type ChatKind, type ChatRow, type Sponsored } from './cards-from'
import type { Input, Page } from './glasses'
import { PROVIDERS, type Provider } from './voice'

export interface Saved {
  mode: 'none' | 'demo' | 'telegram'
  apiId: string
  apiHash: string
  people: number[]
  groups: number[]
  replies: string[]
  instant: number[]
  muted: Record<string, number>
  voice: { provider: Provider; key: string }
}

export interface Handlers {
  connect(phone: string): void
  connectQr(): void
  demo(): void
  leave(): void
  save(): void
  applied(): void // settings changed: pick up chats that were just followed
  input(i: Input): void // drives the lens from the phone, for people without glasses at hand
  chats(): Promise<ChatRow[]>
  history(chatId: number): Promise<Bubble[]>
  press(b: Bubble, a: Action): Promise<string | undefined> // resolves with the bot's answer, if any
  send(chatId: number, text: string): Promise<void>
  avatar(chatId: number): Promise<string | null>
  ads(chatId: number): Promise<Sponsored[]> // Telegram's official sponsored messages for a channel or a bot
  adSeen(random: Uint8Array): void
  adClick(random: Uint8Array): void
}

export interface Pick { id: number; name: string }

type Step = 'phone' | 'code' | 'password'
type Tab = 'lens' | 'chats' | 'settings'
type View = { v: 'signin'; step: Step; method: 'qr' | 'phone' } | { v: Tab } | { v: 'chat'; chat: ChatRow }
type Filter = 'all' | ChatKind

// Official Even app icons (32 px pixel artboards drawn at 24 px), recoloured through the text colour.
const ICONS = Object.fromEntries(Object.entries(import.meta.glob<string>('./icons/*.svg', { query: '?raw', import: 'default', eager: true }))
  .map(([path, svg]) => [path.slice(8, -4), svg.replace(/#232323/g, 'currentColor')]))
const icon = (name: string, cls = 'ic') => `<span class="${cls}" aria-hidden="true">${ICONS[name] ?? ''}</span>`

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const $ = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T
const KIND: Record<ChatKind, string> = { bot: 'Bot', person: 'Person', group: 'Group', channel: 'Channel' }
const FILTERS: [Filter, string][] = [['all', 'All'], ['bot', 'Bots'], ['person', 'People'], ['group', 'Groups'], ['channel', 'Channels']]

function when(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

function initials(name: string): string {
  const words = name.replace(/^@/, '').split(/[\s_]+/).filter(Boolean)
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase()
}

export class Phone {
  private view: View = { v: 'signin', step: 'phone', method: 'qr' }
  private pending: { kind: Step; resolve: (v: string) => void } | null = null
  private who = ''
  private bots: Pick[] = []
  private page: Page | null = null
  private sel = 0 // the lens list row the phone remote points at
  private entries: LogEntry[] = []
  private ms: number[] = []
  private rows: ChatRow[] = []
  private filter: Filter = 'all'
  private query = ''
  private bubbles: Bubble[] = []
  private armed = '' // a dangerous button waiting for its second tap
  private refresh = 0
  private qrUrl = ''

  constructor(private root: HTMLElement, private s: Saved, private h: Handlers, private hasEnvKeys: boolean) {
    root.innerHTML = `
      <header class="bar">
        <button id="back" class="icon-btn" aria-label="Back" hidden>${icon('chevron-back')}</button>
        <h1 id="title">Ack</h1>
        <span id="status" class="chip">Starting</span>
      </header>
      <main id="view"></main>
      <nav id="tabs" class="tabs" hidden>
        <button data-tab="lens">${icon('glasses')}<span>Lens</span></button>
        <button data-tab="chats">${icon('message')}<span>Chats</span></button>
        <button data-tab="settings">${icon('settings')}<span>Settings</span></button>
      </nav>
      <div id="toast" class="toast" role="status" hidden></div>`
    $(root, '#back').onclick = () => this.go({ v: 'chats' })
    for (const b of root.querySelectorAll<HTMLButtonElement>('#tabs [data-tab]')) b.onclick = () => this.go({ v: b.dataset.tab as Tab })
    this.render()
  }

  // ---- what main.ts drives -----------------------------------------------------

  status(text: string, tone: '' | 'live' | 'warn' = '') {
    const el = $(this.root, '#status')
    el.textContent = text
    el.className = `chip ${tone}`
  }

  /** Shows the sign-in step Telegram asks for and resolves with what the user typed. */
  ask(kind: Step): Promise<string> {
    this.go({ v: 'signin', step: kind, method: 'phone' })
    return new Promise(resolve => { this.pending = { kind, resolve } })
  }

  showSignin(step: Step) {
    this.go({ v: 'signin', step, method: this.view.v === 'signin' ? this.view.method : 'qr' })
  }

  /** QR sign-in: Telegram hands out a fresh tg://login link every 30 s or so. */
  qr(url: string) {
    this.qrUrl = url
    if (this.view.v === 'signin' && this.view.method === 'qr') this.render()
  }

  /** Signed in (or in the demo): the tabs appear and the lens is shown first. */
  enter(who: string, bots: Pick[]) {
    this.who = who
    this.bots = bots
    this.qrUrl = ''
    this.go({ v: 'lens' })
  }

  signedOut() {
    this.who = ''
    this.rows = []
    this.go({ v: 'signin', step: 'phone', method: 'qr' })
  }

  /** The lens, drawn to scale, every container at its real position and brightness. */
  mirror(page: Page) {
    const items = JSON.stringify(page.list?.items ?? [])
    if (items !== JSON.stringify(this.page?.list?.items ?? [])) this.sel = 0
    this.page = page
    const el = this.root.querySelector<HTMLElement>('#mirror')
    if (el) this.drawMirror(el)
  }

  log(entries: LogEntry[]) {
    this.entries = entries
    const el = this.root.querySelector<HTMLElement>('#log')
    if (el) el.innerHTML = this.logHtml()
  }

  stats(ms: number[]) {
    this.ms = ms
    const el = this.root.querySelector<HTMLElement>('#stats')
    if (el) el.innerHTML = this.statsHtml()
  }

  /** A message arrived or changed in a chat: refresh what the phone shows of it. */
  activity(chatId: number) {
    const v = this.view
    if (v.v !== 'chat' && v.v !== 'chats') return
    if (v.v === 'chat' && v.chat.id !== chatId) return
    clearTimeout(this.refresh)
    this.refresh = window.setTimeout(() => void (v.v === 'chat' ? this.loadChat(v.chat) : this.loadChats()), v.v === 'chat' ? 150 : 600)
  }

  // ---- views ---------------------------------------------------------------------

  private go(v: View) {
    this.view = v
    this.armed = ''
    this.render()
    if (v.v === 'chats') void this.loadChats()
    if (v.v === 'chat') void this.loadChat(v.chat)
  }

  private render() {
    const v = this.view
    const signedIn = v.v !== 'signin'
    $(this.root, '#tabs').hidden = !signedIn
    $(this.root, '#back').hidden = v.v !== 'chat'
    $(this.root, '#title').textContent = v.v === 'chat' ? v.chat.name : v.v === 'signin' ? 'Ack' : { lens: 'Lens', chats: 'Chats', settings: 'Settings' }[v.v]
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('#tabs [data-tab]')) b.classList.toggle('on', b.dataset.tab === v.v || (v.v === 'chat' && b.dataset.tab === 'chats'))
    const main = $(this.root, '#view')
    main.className = `view v-${v.v}`
    if (v.v === 'signin') return this.signin(main, v.step, v.method)
    if (v.v === 'lens') return this.lens(main)
    if (v.v === 'chats') return this.chatList(main)
    if (v.v === 'chat') return this.chat(main, v.chat)
    this.settings(main)
  }

  private signin(el: HTMLElement, step: Step, method: 'qr' | 'phone') {
    const keys = step === 'phone' && !this.hasEnvKeys
      ? `<div class="card form">
          <p class="label">Telegram API keys</p>
          <div class="pair"><input id="aid" inputmode="numeric" placeholder="API ID" value="${esc(this.s.apiId)}"><input id="ahash" placeholder="API hash" value="${esc(this.s.apiHash)}"></div>
          <p class="hint">From my.telegram.org, in API development tools. Saved on this phone only.</p>
        </div>` : ''
    if (step !== 'phone') {
      const code = step === 'code'
      el.innerHTML = `
        <div class="hero"><h2>${code ? 'Enter the code' : 'Two-step verification'}</h2>
          <p>${code ? 'Telegram sent it to your Telegram app, in the chat named Telegram.' : 'Your account has a password. Type it to finish signing in.'}</p></div>
        <div class="card form">
          <input id="v" ${code ? 'inputmode="numeric" autocomplete="one-time-code" placeholder="12345"' : 'type="password" autocomplete="current-password" placeholder="Password"'}>
          <button id="go" class="btn dark">Continue</button>
        </div>`
      return this.bindStep(el, step)
    }
    const qrBody = this.qrUrl
      ? `<div class="qr">${renderSVG(this.qrUrl, { border: 2, whiteColor: '#FFFFFF', blackColor: '#232323' })}</div>
         <ol class="steps"><li>Open Telegram on another device</li><li>Go to Settings, Devices, Link Desktop Device</li><li>Point the camera at this code</li></ol>`
      : `<div class="qr empty">${icon('qr', 'ic big')}</div>
         <button id="qrgo" class="btn dark">${icon('qr')}<span>Show my QR code</span></button>`
    el.innerHTML = `
      <div class="hero"><h2>Taking back our eyes from our phones.</h2>
        <p>Every Telegram bot, one tap away on your glasses. Ack is an unofficial Telegram client built on the Telegram API. It signs in as you, and your session stays on this phone.</p></div>
      ${keys}
      <div class="card form">
        <div class="seg" role="tablist">
          <button role="tab" data-m="qr" class="${method === 'qr' ? 'on' : ''}">QR code</button>
          <button role="tab" data-m="phone" class="${method === 'phone' ? 'on' : ''}">Phone number</button>
        </div>
        ${method === 'qr' ? qrBody : `
          <input id="v" type="tel" autocomplete="tel" placeholder="+33 6 12 34 56 78">
          <button id="go" class="btn dark">Send me a code</button>`}
      </div>
      <button id="demo" class="btn">${icon('go')}<span>Try the demo, no account</span></button>`
    for (const b of el.querySelectorAll<HTMLButtonElement>('[data-m]')) b.onclick = () => this.go({ v: 'signin', step: 'phone', method: b.dataset.m as 'qr' | 'phone' })
    $(el, '#demo').onclick = () => this.h.demo()
    const qrgo = el.querySelector<HTMLButtonElement>('#qrgo')
    if (qrgo) qrgo.onclick = () => { if (this.keys(el)) { qrgo.disabled = true; this.h.connectQr() } }
    if (method === 'phone') this.bindStep(el, 'phone')
  }

  /** Saves the API keys typed on the sign-in screen. False if they are missing. */
  private keys(el: HTMLElement): boolean {
    if (this.hasEnvKeys) return true
    this.s.apiId = $<HTMLInputElement>(el, '#aid').value.trim()
    this.s.apiHash = $<HTMLInputElement>(el, '#ahash').value.trim()
    if (!this.s.apiId || !this.s.apiHash) { this.toast('Add your Telegram API ID and hash first.', true); return false }
    this.h.save()
    return true
  }

  private bindStep(el: HTMLElement, step: Step) {
    const input = $<HTMLInputElement>(el, '#v')
    const go = () => {
      const v = input.value.trim()
      if (!v) return input.focus()
      if (step === 'phone' && !this.keys(el)) return
      $<HTMLButtonElement>(el, '#go').disabled = true
      if (this.pending?.kind === step) { const p = this.pending; this.pending = null; p.resolve(v) }
      else if (step === 'phone') this.h.connect(v)
    }
    $(el, '#go').onclick = go
    input.onkeydown = e => { if (e.key === 'Enter') go() }
  }

  private lens(el: HTMLElement) {
    el.innerHTML = `
      <div class="card lens-card">
        <div id="mirror" class="lens" aria-label="What the glasses show"></div>
        <div class="remote">
          <button data-in="up" aria-label="Swipe up">${icon('up')}</button>
          <button data-in="down" aria-label="Swipe down">${icon('down')}</button>
          <button data-in="tap">${icon('tap')}<span>Tap</span></button>
          <button data-in="double">${icon('double-tap')}<span>Double tap</span></button>
          <button data-in="menu" aria-label="Glasses menu">${icon('more')}</button>
        </div>
        <div id="lensmenu" class="menu" hidden></div>
      </div>
      <p class="hint pad">Drives the lens like the temple or the R1 ring would.</p>
      <h3 class="section">Decisions</h3>
      <div id="log" class="card list">${this.logHtml()}</div>
      <h3 class="section">Message to lens</h3>
      <div id="stats" class="card">${this.statsHtml()}</div>`
    this.drawMirror($(el, '#mirror'))
    for (const b of el.querySelectorAll<HTMLButtonElement>('[data-in]')) b.onclick = () => this.remote(b.dataset.in!)
  }

  private drawMirror(el: HTMLElement) {
    const page = this.page
    if (!page) { el.innerHTML = ''; return }
    const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(3)}%`
    const box = (x: number, y: number, w: number, h: number) => `left:${pct(x, 576)};top:${pct(y, 288)};width:${pct(w, 576)};height:${pct(h, 288)}`
    const texts = page.texts.map(t => `<div class="box b${t.color ?? 4}" style="${box(t.x, t.y, t.w, t.h)}">${esc(t.text)}</div>`).join('')
    const l = page.list
    const list = l ? `<div class="box" style="${box(l.x, l.y, l.w, l.h)}">${l.items.map((i, n) => `<button class="lrow${n === this.sel ? ' sel' : ''}" data-row="${n}">${esc(i)}</button>`).join('')}</div>` : ''
    el.innerHTML = texts + list
    // Like the glasses' firmware, the list scrolls so the selected row stays in view.
    const sel = el.querySelector<HTMLElement>('.lrow.sel')
    if (sel?.parentElement) sel.parentElement.scrollTop = Math.max(0, sel.offsetTop + sel.offsetHeight - sel.parentElement.clientHeight)
    for (const r of el.querySelectorAll<HTMLButtonElement>('[data-row]')) r.onclick = () => { this.sel = Number(r.dataset.row); this.h.input({ type: 'select', index: this.sel }) }
    el.onclick = e => { if (!(e.target as HTMLElement).closest('[data-row]') && !page.list) this.h.input({ type: 'click', ring: false }) }
  }

  private remote(what: string) {
    const items = this.page?.list?.items.length ?? 0
    if (what === 'up' || what === 'down') {
      if (items) { this.sel = Math.max(0, Math.min(items - 1, this.sel + (what === 'up' ? -1 : 1))); this.mirror(this.page!) }
      else this.h.input({ type: what })
      return
    }
    if (what === 'tap') return this.h.input(items ? { type: 'select', index: this.sel } : { type: 'click', ring: false })
    if (what === 'double') return this.h.input({ type: 'double', ring: false })
    const menu = $(this.root, '#lensmenu')
    const entries = this.page?.menu ?? []
    if (!entries.length) return this.toast('This screen has no menu.')
    menu.hidden = !menu.hidden
    menu.innerHTML = entries.map(m => `<button data-menu="${m.id}">${esc(m.label)}</button>`).join('')
    for (const b of menu.querySelectorAll<HTMLButtonElement>('[data-menu]')) b.onclick = () => { menu.hidden = true; this.h.input({ type: 'menu', id: Number(b.dataset.menu) }) }
  }

  private logHtml(): string {
    if (!this.entries.length) return '<p class="empty">Every decision taken from the glasses shows up here.</p>'
    return this.entries.slice(-30).reverse().map(e => `
      <div class="row">
        <div class="main"><span class="name">${esc(e.from)}</span><span class="prev">${esc(e.action)} · ${esc(e.outcome)}</span></div>
        <span class="time">${when(e.at)}</span>
      </div>`).join('')
  }

  private statsHtml(): string {
    if (!this.ms.length) return '<p class="empty">Measured on every card that reaches the lens.</p>'
    const s = [...this.ms].sort((a, b) => a - b)
    const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))])
    return `<div class="stats">
      <div><b>${q(0.5)} ms</b><span>median</span></div>
      <div><b>${q(0.95)} ms</b><span>p95</span></div>
      <div><b>${s.length}</b><span>cards</span></div></div>`
  }

  private chatList(el: HTMLElement) {
    el.innerHTML = `
      <label class="search">${icon('search')}<input id="q" type="search" placeholder="Search" value="${esc(this.query)}"></label>
      <div class="tags">${FILTERS.map(([f, label]) => `<button data-f="${f}" class="${f === this.filter ? 'on' : ''}">${label}</button>`).join('')}</div>
      <div id="chatlist" class="card list">${this.rows.length ? this.chatRows() : '<p class="empty">Loading your chats...</p>'}</div>`
    const q = $<HTMLInputElement>(el, '#q')
    q.oninput = () => { this.query = q.value; this.fillChats() }
    for (const b of el.querySelectorAll<HTMLButtonElement>('[data-f]')) b.onclick = () => {
      this.filter = b.dataset.f as Filter
      for (const x of el.querySelectorAll('[data-f]')) x.classList.toggle('on', x === b)
      this.fillChats()
    }
    this.bindChats()
  }

  private async loadChats() {
    try { this.rows = await this.h.chats() } catch (e) { this.toast(String((e as Error).message ?? e), true) }
    if (this.view.v === 'chats') this.fillChats()
  }

  private fillChats() {
    const el = this.root.querySelector<HTMLElement>('#chatlist')
    if (!el) return
    el.innerHTML = this.chatRows()
    this.bindChats()
  }

  private followed(c: Pick & { kind: ChatKind }): boolean {
    return c.kind === 'bot' || (c.kind === 'person' ? this.s.people : this.s.groups).includes(c.id)
  }

  private chatRows(): string {
    const q = this.query.trim().toLowerCase()
    const rows = this.rows.filter(r => (this.filter === 'all' || r.kind === this.filter) && (!q || r.name.toLowerCase().includes(q)))
    if (!rows.length) return '<p class="empty">No chat here.</p>'
    return rows.map(r => `
      <button class="row chat" data-chat="${r.id}">
        <span class="avatar" data-av="${r.id}">${esc(initials(r.name))}</span>
        <span class="main"><span class="name">${esc(r.name)}${this.followed(r) ? icon('glasses', 'ic tiny') : ''}</span><span class="prev">${esc(r.preview)}</span></span>
        <span class="side"><span class="time">${when(r.date)}</span>${r.unread ? `<span class="badge">${r.unread > 99 ? '99+' : r.unread}</span>` : ''}</span>
      </button>`).join('')
  }

  private bindChats() {
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-chat]')) {
      const row = this.rows.find(r => r.id === Number(b.dataset.chat))!
      b.onclick = () => this.go({ v: 'chat', chat: row })
    }
    for (const a of this.root.querySelectorAll<HTMLElement>('[data-av]')) {
      void this.h.avatar(Number(a.dataset.av)).then(url => { if (url) a.innerHTML = `<img src="${url}" alt="">` })
    }
  }

  private chat(el: HTMLElement, c: ChatRow) {
    const on = this.followed(c)
    el.innerHTML = `
      <div class="card follow">
        ${icon('glasses')}
        <span class="main"><span class="name">On my glasses</span><span class="prev">${c.kind === 'bot' ? 'Bots with a question always come to the lens' : `New messages from this ${KIND[c.kind].toLowerCase()} come to the lens`}</span></span>
        ${c.kind === 'bot' ? '' : `<button id="follow" class="toggle" role="switch" aria-checked="${on}" aria-label="On my glasses">${icon(on ? 'toggle-on' : 'toggle-off', 'tg')}</button>`}
      </div>
      <div id="msgs" class="msgs">${this.bubbles.length ? this.bubbleHtml() : '<p class="empty">Loading messages...</p>'}</div>
      ${c.kind === 'channel' ? '' : `
      <form id="compose" class="composer">
        <input id="text" placeholder="Message" autocomplete="off">
        <button class="send" aria-label="Send">${icon('go')}</button>
      </form>`}`
    const follow = el.querySelector<HTMLButtonElement>('#follow')
    if (follow) follow.onclick = () => {
      const list = c.kind === 'person' ? this.s.people : this.s.groups
      const i = list.indexOf(c.id)
      if (i >= 0) list.splice(i, 1)
      else list.push(c.id)
      this.h.save()
      this.h.applied()
      this.render()
    }
    const form = el.querySelector<HTMLFormElement>('#compose')
    if (form) form.onsubmit = e => {
      e.preventDefault()
      const input = $<HTMLInputElement>(form, '#text')
      const text = input.value.trim()
      if (!text) return
      input.value = ''
      this.h.send(c.id, text).catch(err => this.toast(String((err as Error).message ?? err), true))
    }
    this.bindBubbles()
  }

  private async loadChat(c: ChatRow) {
    try { this.bubbles = await this.h.history(c.id) } catch (e) { this.toast(String((e as Error).message ?? e), true); this.bubbles = [] }
    const v = this.view
    if (v.v !== 'chat' || v.chat.id !== c.id) return
    const el = $(this.root, '#msgs')
    el.innerHTML = this.bubbles.length ? this.bubbleHtml() : '<p class="empty">No messages yet.</p>'
    this.bindBubbles()
    el.scrollTop = el.scrollHeight
    window.scrollTo({ top: document.body.scrollHeight })
    void this.showAd(c)
  }

  /**
   * Telegram's official sponsored message (API terms 3.3): below the last post in a channel, as a bar
   * above a bot chat. Counted as viewed once its whole text is on screen; links outside Telegram ask first.
   */
  private async showAd(c: ChatRow) {
    if (c.kind !== 'channel' && c.kind !== 'bot') return
    const ad = (await this.h.ads(c.id).catch(() => []))[0]
    const v = this.view
    if (!ad || v.v !== 'chat' || v.chat.id !== c.id) return
    this.root.querySelector('.ad')?.remove()
    const bot = c.kind === 'bot'
    const box = document.createElement('div')
    box.className = bot ? 'card ad adbar' : 'msg in ad'
    box.innerHTML = `
      <div class="from">${bot ? `<span class="tag">${ad.label === 'Recommended' ? 'Recommended' : 'Ad'}</span> ` : ''}${esc(ad.title)}</div>
      <div class="text">${esc(ad.text)}</div>
      ${bot ? '' : `<div class="time">${ad.label}</div>`}
      ${ad.info ? `<details class="info"><summary>Sponsor info</summary>${esc(ad.info)}</details>` : ''}
      <div class="kbd"><button class="kb link">${esc(ad.button || 'Open')}</button></div>`
    if (bot) $(this.root, '#msgs').before(box)
    else $(this.root, '#msgs').append(box)
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); this.h.adSeen(ad.random) } }, { threshold: 1 })
    io.observe($(box, '.text'))
    const btn = $<HTMLButtonElement>(box, '.kb')
    let armed = false
    btn.onclick = () => {
      if (adNeedsConfirm(ad.url) && !armed) {
        armed = true
        btn.textContent = `Open ${URL.canParse(ad.url) ? new URL(ad.url).hostname : 'this link'}? Tap again`
        btn.classList.add('armed')
        window.setTimeout(() => { armed = false; btn.textContent = ad.button || 'Open'; btn.classList.remove('armed') }, 3000)
        return
      }
      this.h.adClick(ad.random)
      window.open(ad.url, '_blank', 'noopener')
    }
  }

  private bubbleHtml(): string {
    const kb = (b: Bubble) => b.buttons.length ? `<div class="kbd">${b.buttons.map((x, i) => {
      const a = x.action
      const kind = a.kind === 'phone' ? 'link' : a.kind === 'copy' ? 'copy' : a.kind === 'disabled' ? 'off' : a.style ?? ''
      const armed = this.armed === `${b.id}:${i}`
      return `<button class="kb ${kind}${armed ? ' armed' : ''}" data-b="${b.id}:${i}" ${a.kind === 'disabled' ? 'disabled' : ''}>${armed ? 'Tap again to confirm' : esc(x.label)}</button>`
    }).join('')}</div>` : ''
    return this.bubbles.map(b => `
      <div class="msg ${b.out ? 'out' : 'in'}">
        ${b.from ? `<div class="from">${esc(b.from)}</div>` : ''}
        <div class="text">${esc(b.text)}</div>
        <div class="time">${when(b.date)}</div>
        ${kb(b)}
      </div>`).join('')
  }

  private bindBubbles() {
    for (const el of this.root.querySelectorAll<HTMLButtonElement>('[data-b]')) {
      const [id, i] = el.dataset.b!.split(':').map(Number)
      const b = this.bubbles.find(x => x.id === id)
      if (!b) continue
      el.onclick = () => void this.pressButton(b, i, el)
    }
  }

  private async pressButton(b: Bubble, i: number, el: HTMLButtonElement) {
    const { action } = b.buttons[i]
    if (action.kind === 'phone') {
      if (action.value) window.open(action.value, '_blank', 'noopener')
      else this.toast('This button opens a Mini App or a payment: finish it in Telegram.')
      return
    }
    if (action.kind === 'copy') {
      await navigator.clipboard?.writeText(action.value ?? '').catch(() => {})
      return this.toast(`Copied: ${action.value ?? ''}`)
    }
    // A dangerous or irreversible button takes a second tap, like the explicit yes on the lens.
    const key = `${b.id}:${i}`
    if (needsYes(action) && this.armed !== key) {
      this.armed = key
      el.textContent = 'Tap again to confirm'
      el.classList.add('armed')
      window.setTimeout(() => { if (this.armed === key) { this.armed = ''; el.textContent = b.buttons[i].label; el.classList.remove('armed') } }, 3000)
      return
    }
    this.armed = ''
    el.disabled = true
    try {
      const answer = await this.h.press(b, action)
      if (answer) this.toast(answer)
    } catch (e) {
      this.toast(String((e as Error).message ?? e), true)
    } finally {
      el.disabled = false
    }
  }

  private settings(el: HTMLElement) {
    const instant = this.bots.map(b => {
      const on = this.s.instant.includes(b.id)
      return `<div class="row"><span class="main"><span class="name">${esc(b.name)}</span></span>
        <button class="toggle" role="switch" aria-checked="${on}" aria-label="${esc(b.name)} skips the undo" data-instant="${b.id}">${icon(on ? 'toggle-on' : 'toggle-off', 'tg')}</button></div>`
    }).join('')
    el.innerHTML = `
      <h3 class="section">Account</h3>
      <div class="card">
        <div class="row"><span class="avatar">${esc(initials(this.who.replace(/^Signed in as /, '') || 'Ack'))}</span>
          <span class="main"><span class="name">${esc(this.who || 'Not signed in')}</span><span class="prev">${this.s.mode === 'demo' ? 'Scripted bots, nothing reaches Telegram' : 'Your session stays on this phone'}</span></span></div>
      </div>
      <h3 class="section">Quick replies to people</h3>
      <div class="card form">
        <textarea id="replies" rows="4">${esc(this.s.replies.join('\n'))}</textarea>
        <p class="hint">One per line, up to 6. They show under a person's message on the lens.</p>
      </div>
      <h3 class="section">Bots that skip the 1.5 s undo</h3>
      <div class="card list">${instant || '<p class="empty">No bots yet.</p>'}</div>
      <h3 class="section">Voice answers</h3>
      <div class="card form">
        <select id="prov">${Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}" ${k === this.s.voice.provider ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
        <input id="vkey" type="password" placeholder="Your speech API key" value="${esc(this.s.voice.key)}">
        <p class="hint">Hold on the glasses, speak, release. The key stays on this phone, and audio goes to that service only while you hold.</p>
      </div>
      <button id="save" class="btn dark">Save settings</button>
      <button id="leave" class="btn warn">${icon('logout')}<span>${this.s.mode === 'demo' ? 'Leave the demo' : 'Sign out of Telegram'}</span></button>
      <p class="hint pad">Leaving erases everything Ack keeps on this phone: the session, settings and decisions.</p>`
    for (const t of el.querySelectorAll<HTMLButtonElement>('[data-instant]')) t.onclick = () => {
      const id = Number(t.dataset.instant)
      const on = t.getAttribute('aria-checked') !== 'true'
      t.setAttribute('aria-checked', String(on))
      t.innerHTML = icon(on ? 'toggle-on' : 'toggle-off', 'tg')
      this.s.instant = on ? [...this.s.instant, id] : this.s.instant.filter(x => x !== id)
    }
    const save = $<HTMLButtonElement>(el, '#save')
    save.onclick = () => {
      this.s.replies = $<HTMLTextAreaElement>(el, '#replies').value.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 6)
      this.s.voice = { provider: $<HTMLSelectElement>(el, '#prov').value as Provider, key: $<HTMLInputElement>(el, '#vkey').value.trim() }
      this.h.save()
      this.h.applied()
      this.toast('Settings saved')
    }
    $(el, '#leave').onclick = () => this.h.leave()
  }

  private toast(text: string, warn = false) {
    const t = $(this.root, '#toast')
    t.textContent = text
    t.className = `toast${warn ? ' warn' : ''}`
    t.hidden = false
    clearTimeout(Number(t.dataset.timer))
    t.dataset.timer = String(window.setTimeout(() => { t.hidden = true }, 2600))
  }
}
