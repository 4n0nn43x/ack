import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { App, errorText, type LogEntry } from './app'
import { DEFAULT_REPLIES, replies } from './cards'
import { DemoSource } from './demo'
import { Glasses, parseEvent } from './glasses'
import { Phone, type Saved } from './phone'
import type { TelegramSource } from './telegram'
import { transcribe } from './voice'

if (new URLSearchParams(location.search).has('fresh')) { try { localStorage.clear() } catch { /* nothing to clear */ } } // clean start for tests

const load = <T>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d } catch { return d } }
const store = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode: keep going */ } }

// .env.local keys are a dev-server convenience only: a production build (.ehpk) never carries them.
const ENV_ID = import.meta.env.DEV ? ((import.meta.env.VITE_TG_API_ID as string | undefined) ?? '') : ''
const ENV_HASH = import.meta.env.DEV ? ((import.meta.env.VITE_TG_API_HASH as string | undefined) ?? '') : ''
const saved: Saved = { mode: 'none', apiId: '', apiHash: '', people: [], groups: [], replies: DEFAULT_REPLIES, instant: [], muted: {}, voice: { provider: 'groq', key: '' }, ...load<Partial<Saved>>('ack.v1', {}) }
const log = load<LogEntry[]>('ack.log', [])
const lat = load<number[]>('ack.latency', [])
const save = () => store('ack.v1', saved)

let src: DemoSource | TelegramSource | null = null

const record = (e: LogEntry) => { log.push(e); log.splice(0, log.length - 200); store('ack.log', log); phone.log(log) }

const phone = new Phone(document.getElementById('app')!, saved, {
  connect: p => void startTelegram(p),
  connectQr: () => void startTelegram(undefined, true),
  demo: () => startDemo(),
  leave: () => void leave(),
  save,
  applied: () => { if (src?.kind === 'telegram') void src.scan() },
  input: i => app.input(i),
  chats: async () => (src ? src.chats() : []),
  history: async id => (src ? src.history(id) : []),
  press: async (b, a) => {
    if (!src) throw new Error('Not connected')
    const r = await src.press(b.card, a)
    record({ at: Date.now(), from: b.card.from, card: b.card.text.slice(0, 80), action: a.label, outcome: `${r.toast ? `ok: ${r.toast}` : 'ok'} (phone)` })
    return r.toast ?? (r.url ? `Open: ${r.url}` : undefined)
  },
  send: async (id, text) => { if (src) await src.send(id, text) },
  avatar: async id => (src ? src.avatar(id) : null),
}, Boolean(ENV_ID && ENV_HASH))
phone.log(log)
phone.stats(lat)

const bridge = await waitForEvenAppBridge()
const glasses = new Glasses(bridge)

const app = new App({
  draw: (page, force) => {
    phone.mirror(page)
    console.log(`[ack] lens ${page.texts.map(t => t.text.replace(/\n+/g, ' / ')).join(' | ')}${page.list ? ` | ${page.list.items.join(' · ')}` : ''}`)
    return glasses.draw(page, force)
  },
  exit: () => void glasses.exit(),
  now: () => Date.now(),
  perf: () => performance.now(),
  later: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id) },
  mic: on => void glasses.mic(on),
  get transcribe() { return saved.voice.key ? (pcm: Uint8Array[], hints: string[]) => transcribe(saved.voice, pcm, hints) : undefined },
  onLog: record,
  onLatency: ms => { lat.push(Math.round(ms)); lat.splice(0, lat.length - 200); store('ack.latency', lat); phone.stats(lat); console.log(`[ack] card on lens in ${Math.round(ms)} ms`) },
  onDemo: () => startDemo(),
  onChange: () => { store('ack.dismissed', [...app.dismissed].slice(-500)); save() },
}, saved)
for (const k of load<string[]>('ack.dismissed', [])) app.dismissed.add(k)

bridge.onEvenHubEvent(e => {
  const i = parseEvent(e)
  if (!i) return
  if (i.type === 'exit') { void glasses.mic(false); return }
  app.input(i)
})

app.render()
console.log('[ack] ready')
setInterval(() => { if (app.view.v === 'card') app.render() }, 30_000) // keeps "2m ago" honest

function stop() {
  if (src?.kind === 'demo') src.stop()
  src = null
}

function settingsFor(s: DemoSource | TelegramSource) {
  void s.bots().then(bots => phone.enter(s.kind === 'telegram' ? `Signed in as ${s.me?.displayName ?? ''}` : 'Demo', bots))
}

function startDemo() {
  stop()
  saved.mode = 'demo'
  save()
  const d = new DemoSource(c => app.upsert(c), () => replies(saved.replies))
  d.onActivity = id => phone.activity(id)
  src = d
  app.setSource(d)
  d.start()
  phone.status('Demo', 'live')
  settingsFor(d)
}

async function startTelegram(firstPhone?: string, qr = false) {
  const apiId = Number(ENV_ID || saved.apiId)
  const apiHash = ENV_HASH || saved.apiHash
  if (!apiId || !apiHash) { phone.status('Telegram API keys needed', 'warn'); return phone.showSignin('phone') }
  stop()
  phone.status('Loading Telegram...')
  const { TelegramSource } = await import('./telegram') // mtcute is heavy: only loaded for a real account
  const t = new TelegramSource(apiId, apiHash, c => app.upsert(c), k => app.remove(k), () => [...saved.people, ...saved.groups], () => replies(saved.replies))
  t.onActivity = id => phone.activity(id)
  src = t
  let pending = firstPhone
  try {
    await t.start({
      ask: kind => {
        if (kind === 'phone' && pending) { const p = pending; pending = undefined; return Promise.resolve(p) }
        phone.status(kind === 'code' ? 'Code sent' : kind === 'password' ? 'Password needed' : 'Sign in')
        return phone.ask(kind)
      },
      status: s => phone.status(s),
      qr: url => { phone.status('Scan the code'); phone.qr(url) },
    }, qr)
    saved.mode = 'telegram'
    save()
    app.setSource(t)
    phone.status(`Connected · ${t.me?.displayName ?? ''}`, 'live')
    await t.scan()
    settingsFor(t)
  } catch (e) {
    console.error('[ack] telegram', e)
    phone.status(errorText(e).split('\n')[0], 'warn')
    phone.showSignin('phone')
  }
}

async function leave() {
  const was = src
  stop()
  if (was?.kind === 'telegram') await was.signOut()
  saved.mode = 'none'
  save()
  app.setSource(null)
  phone.status('Signed out')
  phone.signedOut()
}

if (saved.mode === 'demo') startDemo()
else if (saved.mode === 'telegram') void startTelegram()
else phone.status('Not signed in')
