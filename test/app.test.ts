import { beforeEach, describe, expect, it } from 'vitest'
import { App, UNDO_MS, type Deps, type LogEntry, type Source } from '../src/app'
import type { Action, Card } from '../src/cards'
import type { Page } from '../src/glasses'

let t = 1_000_000
let timers: { at: number; fn: () => void; dead: boolean }[] = []
let pages: Page[] = []
let logs: LogEntry[] = []
let pressed: string[] = []
let sent: string[] = []
let exited = 0

const tick = async (ms: number) => {
  t += ms
  for (const x of timers.filter(x => !x.dead && x.at <= t)) { x.dead = true; x.fn() }
  await new Promise(r => setTimeout(r, 0))
}
const flush = () => new Promise(r => setTimeout(r, 0))

const source: Source = {
  kind: 'demo',
  async press(_c, a) { pressed.push(a.label); return a.label === 'Ping' ? { toast: 'Pong' } : {} },
  async send(chat, text) { sent.push(`${chat}:${text}`) },
  async bots() { return [{ id: 7, name: '@BotFather' }] },
  async commands() { return [{ command: 'mybots', description: 'Edit your bots' }] },
}

const deps = (over: Partial<Deps> = {}): Deps => ({
  draw: async p => { pages.push(p); return true },
  exit: () => { exited++ },
  now: () => t,
  perf: () => t,
  later: (fn, ms) => { const x = { at: t + ms, fn, dead: false }; timers.push(x); return () => { x.dead = true } },
  onLog: e => logs.push(e),
  ...over,
})

const act = (label: string, extra: Partial<Action> = {}): Action => ({ label, kind: 'callback', data: new Uint8Array(), ...extra })
const card = (id: number, actions: Action[], text = 'Deploy api v2.3.1 to production?'): Card =>
  ({ key: `1:${id}`, chatId: 1, msgId: id, from: '@deploybot', isBot: true, text, date: t, actions, receivedAt: t })
const last = () => pages[pages.length - 1]
const lens = () => last().texts.map(x => x.text).join('\n')

let app: App
beforeEach(() => {
  timers = []; pages = []; logs = []; pressed = []; sent = []; exited = 0
  app = new App(deps(), { instant: [], muted: {}, replies: ['Yes'] })
  app.setSource(source)
})

describe('root', () => {
  it('shows a calm empty lens and exits on double tap', () => {
    expect(lens()).toContain('Nothing waiting')
    app.input({ type: 'double', ring: false })
    expect(exited).toBe(1)
  })

  it('without an account, tells the user what to do instead of a black screen', () => {
    app.setSource(null)
    expect(lens()).toContain('Sign in to Telegram')
  })
})

describe('a card', () => {
  it('appears as soon as a bot asks, with its buttons as a list', () => {
    app.upsert(card(1, [act('Deploy', { style: 'danger' }), act('Staging only'), act('Cancel')]))
    expect(app.view.v).toBe('card')
    expect(last().texts[0].text).toContain('@deploybot')
    expect(last().list!.items).toEqual(['Staging only', 'Cancel', '▲ Deploy'])
    expect(last().menu?.length).toBe(3)
  })

  it('presses after the undo window', async () => {
    app.upsert(card(1, [act('Staging only')]))
    app.input({ type: 'select', index: 0 })
    expect(lens()).toContain('double tap: undo'.replace('d', 'D'))
    await tick(UNDO_MS - 1)
    expect(pressed).toEqual([])
    await tick(1)
    expect(pressed).toEqual(['Staging only'])
    expect(logs.at(-1)).toMatchObject({ action: 'Staging only', outcome: 'ok' })
  })

  it('double tap inside the window undoes it', async () => {
    app.upsert(card(1, [act('Staging only')]))
    app.input({ type: 'select', index: 0 })
    app.input({ type: 'double', ring: false })
    await tick(UNDO_MS * 2)
    expect(pressed).toEqual([])
    expect(logs.at(-1)?.outcome).toBe('undone')
  })

  it('tap inside the window sends at once', async () => {
    app.upsert(card(1, [act('Staging only')]))
    app.input({ type: 'select', index: 0 })
    app.input({ type: 'click', ring: false })
    await flush()
    expect(pressed).toEqual(['Staging only'])
  })

  it('danger buttons need an explicit yes', async () => {
    app.upsert(card(1, [act('Deploy', { style: 'danger' })]))
    app.input({ type: 'select', index: 0 })
    expect(app.view.v).toBe('confirm')
    app.input({ type: 'double', ring: false })
    expect(app.view.v).toBe('card')
    app.input({ type: 'select', index: 0 })
    app.input({ type: 'click', ring: false })
    await flush()
    expect(pressed).toEqual(['Deploy'])
  })

  it('instant bots skip the undo window', async () => {
    app.settings.instant = [1]
    app.upsert(card(1, [act('Staging only')]))
    app.input({ type: 'select', index: 0 })
    await flush()
    expect(pressed).toEqual(['Staging only'])
  })

  it('shows the bot answer, then comes back to the card', async () => {
    app.upsert(card(1, [act('Ping')]))
    app.settings.instant = [1]
    app.input({ type: 'select', index: 0 })
    await flush()
    expect(lens()).toBe('Pong')
    await tick(2000)
    expect(app.view.v).toBe('card')
  })

  it('an edit updates the card in place', () => {
    app.upsert(card(1, [act('Ping')]))
    app.upsert(card(1, [act('Done')], 'Deployed in 41 s'))
    expect(app.queue).toHaveLength(1)
    expect(lens()).toContain('Deployed in 41 s')
    expect(last().list!.items).toEqual(['Done'])
  })

  it('double tap dismisses, and a dismissed card never comes back', () => {
    app.upsert(card(1, [act('Ping')]))
    app.input({ type: 'double', ring: false })
    expect(app.view.v).toBe('root')
    app.upsert(card(1, [act('Ping')]))
    expect(app.queue).toHaveLength(0)
  })

  it('a card without buttons offers OK', () => {
    app.upsert(card(1, [], 'Build finished'))
    expect(last().list!.items).toEqual(['OK'])
    app.input({ type: 'select', index: 0 })
    expect(app.queue).toHaveLength(0)
  })

  it('url buttons say where to finish instead of failing', () => {
    app.upsert(card(1, [{ label: 'Open dashboard', kind: 'phone', value: 'https://grafana.example.com/d/1' }]))
    app.input({ type: 'select', index: 0 })
    expect(lens()).toContain('Finish on your phone')
    expect(lens()).toContain('grafana.example.com')
    expect(pressed).toEqual([])
  })
})

describe('queue', () => {
  it('keeps order, counts, and Later rotates', () => {
    app.upsert(card(1, [act('A')]))
    app.upsert({ ...card(2, [act('B')]), key: '2:2', chatId: 2, from: '@other' })
    expect(last().texts[0].text).toContain('1/2')
    const items = last().list!.items
    expect(items.at(-1)).toBe('Later (1 more)')
    app.input({ type: 'select', index: items.length - 1 })
    expect(app.card?.from).toBe('@other')
  })

  it('the answer to what I just pressed jumps to the front', async () => {
    app.settings.instant = [1]
    app.upsert(card(1, [act('Next')]))
    app.upsert({ ...card(2, [act('B')]), key: '2:2', chatId: 2, from: '@other' })
    app.input({ type: 'select', index: 0 })
    await flush()
    app.upsert(card(3, [act('Step 2')], 'Choose a bot'))
    expect(app.card?.msgId).toBe(3)
  })

  it('mute removes every card from that chat for an hour', () => {
    app.upsert(card(1, [act('A')]))
    app.upsert(card(2, [act('B')]))
    app.input({ type: 'menu', id: 1 })
    expect(app.queue).toHaveLength(0)
    app.upsert(card(3, [act('C')]))
    expect(app.queue).toHaveLength(0)
  })

  it('records latency the first time a card reaches the lens', async () => {
    const seen: number[] = []
    app = new App(deps({ onLatency: ms => seen.push(ms), perf: () => t + 120 }), { instant: [], muted: {}, replies: [] })
    app.setSource(source)
    app.upsert(card(1, [act('A')]))
    await flush()
    app.upsert(card(1, [act('A2')]))
    await flush()
    expect(seen).toEqual([120])
  })
})

describe('bots and commands from the lens', () => {
  it('tap on the empty lens lists bots, then their commands, then sends one', async () => {
    app.input({ type: 'click', ring: false })
    await flush()
    expect(last().list!.items).toEqual(['@BotFather'])
    app.input({ type: 'select', index: 0 })
    await flush()
    expect(last().list!.items[0]).toBe('/mybots Edit your bots')
    app.input({ type: 'select', index: 0 })
    await flush()
    expect(sent).toEqual(['7:/mybots'])
  })
})

describe('voice', () => {
  it('without a speech key, says how to add one', () => {
    app.upsert(card(1, [act('Deny')]))
    app.input({ type: 'longStart' })
    expect(lens()).toContain('speech key')
  })

  it('hold, speak, release: the phrase picks the button, tap confirms', async () => {
    const mic: boolean[] = []
    app = new App(deps({ mic: on => mic.push(on), transcribe: async pcm => (pcm.length === 2 ? 'deny it' : '') }), { instant: [], muted: {}, replies: [] })
    app.setSource(source)
    app.upsert(card(1, [act('Allow once'), act('Deny')]))
    app.input({ type: 'longStart' })
    app.input({ type: 'pcm', pcm: new Uint8Array(3200) })
    app.input({ type: 'pcm', pcm: new Uint8Array(3200) })
    app.input({ type: 'longEnd' })
    await flush()
    expect(mic).toEqual([true, false])
    expect(lens()).toContain('"deny it"')
    expect(lens()).toContain('→ Deny')
    app.input({ type: 'click', ring: false })
    await flush()
    expect(pressed).toEqual(['Deny'])
  })

  it('a phrase that is no button is sent as a message', async () => {
    app = new App(deps({ transcribe: async () => 'running 5 minutes late' }), { instant: [], muted: {}, replies: [] })
    app.setSource(source)
    app.upsert({ ...card(1, []), from: 'Alex', isBot: false })
    app.input({ type: 'longStart' })
    app.input({ type: 'longEnd' })
    await flush()
    expect(lens()).toContain('Send as a message to Alex')
    app.input({ type: 'click', ring: false })
    await flush()
    expect(sent).toEqual(['1:running 5 minutes late'])
  })
})
