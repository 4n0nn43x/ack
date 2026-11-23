// The phone side: sign in, see what the lens shows, the decision log, measured speed, settings.
import type { LogEntry } from './app'
import type { Page } from './glasses'
import { PROVIDERS, type Provider } from './voice'

export interface Saved {
  mode: 'none' | 'demo' | 'telegram'
  apiId: string
  apiHash: string
  people: number[]
  replies: string[]
  instant: number[]
  muted: Record<string, number>
  voice: { provider: Provider; key: string }
}

export interface Handlers {
  connect(phone: string): void
  demo(): void
  leave(): void
  save(): void
}

export interface Pick { id: number; name: string }

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const $ = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T

export class Phone {
  private pending: { kind: string; resolve: (v: string) => void } | null = null

  constructor(private root: HTMLElement, private s: Saved, private h: Handlers, private hasEnvKeys: boolean) {
    root.innerHTML = `
      <header><div class="brand">Ack</div><span id="status" class="pill">Starting</span></header>
      <p class="tag">Every Telegram bot button, one tap on your glasses.</p>
      <section id="signin" hidden></section>
      <section><h2>On your glasses now</h2><div id="mirror" class="lens"></div></section>
      <section><h2>Decisions</h2><ol id="log"></ol></section>
      <section><h2>Speed, message to lens</h2><div id="stats"></div></section>
      <section id="settings" hidden></section>`
    this.showSignin('phone')
  }

  status(text: string, tone: '' | 'live' | 'warn' = '') {
    const el = $(this.root, '#status')
    el.textContent = text
    el.className = `pill ${tone}`
  }

  /** Shows the sign-in step Telegram asks for and resolves with what the user typed. */
  ask(kind: 'phone' | 'code' | 'password'): Promise<string> {
    this.showSignin(kind)
    return new Promise(resolve => { this.pending = { kind, resolve } })
  }

  hideSignin() { $(this.root, '#signin').hidden = true }

  showSignin(step: 'phone' | 'code' | 'password') {
    const el = $(this.root, '#signin')
    el.hidden = false
    const needKeys = step === 'phone' && !this.hasEnvKeys
    const field = {
      phone: `<label for="v">Your Telegram phone number</label><input id="v" type="tel" autocomplete="tel" placeholder="+33 6 12 34 56 78">`,
      code: `<label for="v">Code Telegram just sent you (in the Telegram app)</label><input id="v" inputmode="numeric" autocomplete="one-time-code" placeholder="12345">`,
      password: `<label for="v">Your two-step verification password</label><input id="v" type="password" autocomplete="current-password">`,
    }[step]
    el.innerHTML = `
      <h2>${step === 'phone' ? 'Connect Telegram' : 'Almost there'}</h2>
      ${step === 'phone' ? '<p class="hint">Ack signs in as you, from this phone. Your session never leaves it.</p>' : ''}
      ${needKeys ? `<div class="row"><div><label for="aid">API ID</label><input id="aid" inputmode="numeric" value="${esc(this.s.apiId)}"></div>
        <div><label for="ahash">API hash</label><input id="ahash" value="${esc(this.s.apiHash)}"></div></div>
        <p class="hint">From my.telegram.org, "API development tools".</p>` : ''}
      ${field}
      <button id="go">${step === 'phone' ? 'Send me a code' : 'Continue'}</button>
      ${step === 'phone' ? '<button id="demo" class="ghost">Try the demo, no account</button>' : ''}`
    const input = $<HTMLInputElement>(el, '#v')
    const go = () => {
      const v = input.value.trim()
      if (!v) return input.focus()
      if (needKeys) {
        this.s.apiId = $<HTMLInputElement>(el, '#aid').value.trim()
        this.s.apiHash = $<HTMLInputElement>(el, '#ahash').value.trim()
        if (!this.s.apiId || !this.s.apiHash) return this.status('API ID and hash needed', 'warn')
        this.h.save()
      }
      $<HTMLButtonElement>(el, '#go').disabled = true
      if (this.pending?.kind === step) { const p = this.pending; this.pending = null; p.resolve(v) }
      else if (step === 'phone') this.h.connect(v)
    }
    $(el, '#go').onclick = go
    input.onkeydown = e => { if (e.key === 'Enter') go() }
    const demo = el.querySelector<HTMLButtonElement>('#demo')
    if (demo) demo.onclick = () => this.h.demo()
  }

  /** The lens, drawn to scale: every container at its real position and brightness. */
  mirror(page: Page) {
    const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(3)}%`
    const box = (x: number, y: number, w: number, h: number) => `left:${pct(x, 576)};top:${pct(y, 288)};width:${pct(w, 576)};height:${pct(h, 288)}`
    const texts = page.texts.map(t => `<div class="box b${t.color ?? 4}" style="${box(t.x, t.y, t.w, t.h)}">${esc(t.text)}</div>`).join('')
    const l = page.list
    const list = l ? `<div class="box list" style="${box(l.x, l.y, l.w, l.h)}">${l.items.map((i, n) => `<div class="row${n === 0 ? ' sel' : ''}">${esc(i)}</div>`).join('')}</div>` : ''
    $(this.root, '#mirror').innerHTML = texts + list
  }

  log(entries: LogEntry[]) {
    const el = $(this.root, '#log')
    if (!entries.length) { el.innerHTML = '<li class="empty">Your taps on the glasses will show here.</li>'; return }
    el.innerHTML = entries.slice(-30).reverse().map(e => {
      const t = new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      return `<li><span class="who">${esc(e.from)}</span> · ${esc(e.action)}<div class="what">${t} · ${esc(e.outcome)} · ${esc(e.card.split('\n')[0].slice(0, 60))}</div></li>`
    }).join('')
  }

  stats(ms: number[]) {
    const el = $(this.root, '#stats')
    if (!ms.length) { el.innerHTML = '<p class="empty">Measured on every card that reaches the lens.</p>'; return }
    const s = [...ms].sort((a, b) => a - b)
    const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))])
    el.innerHTML = `<div class="stats">
      <div class="stat"><b>${q(0.5)} ms</b><span>median</span></div>
      <div class="stat"><b>${q(0.95)} ms</b><span>p95</span></div>
      <div class="stat"><b>${s.length}</b><span>cards</span></div></div>`
  }

  settings(who: string, chats: Pick[], bots: Pick[]) {
    const el = $(this.root, '#settings')
    el.hidden = false
    const checks = (list: Pick[], picked: number[], attr: string, empty: string) => list.length
      ? list.slice(0, 40).map(c => `<label class="check"><input type="checkbox" data-${attr}="${c.id}" ${picked.includes(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('')
      : `<p class="empty">${empty}</p>`
    el.innerHTML = `
      <h2>Settings</h2>
      <p class="hint">${esc(who)}</p>
      <label>People whose messages come to the glasses</label>
      ${checks(chats, this.s.people, 'person', 'Chats show up here once Telegram is connected.')}
      <label for="replies">Quick replies to people, one per line</label>
      <textarea id="replies">${esc(this.s.replies.join('\n'))}</textarea>
      <label>Bots that skip the 1.5 s undo</label>
      ${checks(bots, this.s.instant, 'bot', 'No bots yet.')}
      <label for="prov">Voice answers (hold on the glasses, speak, release)</label>
      <select id="prov">${Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}" ${k === this.s.voice.provider ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
      <input id="vkey" type="password" placeholder="Your speech API key" value="${esc(this.s.voice.key)}" style="margin-top:8px">
      <p class="hint">Stays on this phone. Audio goes from your phone to that service only while you hold.</p>
      <button id="save">Save settings</button>
      <button id="leave" class="danger">${this.s.mode === 'demo' ? 'Leave the demo' : 'Sign out of Telegram'}</button>`
    $(el, '#save').onclick = () => {
      this.s.people = [...el.querySelectorAll<HTMLInputElement>('[data-person]')].filter(i => i.checked).map(i => Number(i.dataset.person))
      this.s.instant = [...el.querySelectorAll<HTMLInputElement>('[data-bot]')].filter(i => i.checked).map(i => Number(i.dataset.bot))
      this.s.replies = $<HTMLTextAreaElement>(el, '#replies').value.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 6)
      this.s.voice = { provider: $<HTMLSelectElement>(el, '#prov').value as Provider, key: $<HTMLInputElement>(el, '#vkey').value.trim() }
      this.h.save()
      this.status('Saved', 'live')
    }
    $(el, '#leave').onclick = () => this.h.leave()
  }
}
