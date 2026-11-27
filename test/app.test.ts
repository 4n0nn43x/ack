import { beforeEach, describe, expect, it } from 'vitest'
import { App, EDIT_WAIT_MS, UNDO_MS, type Deps, type LogEntry, type Source } from '../src/app'
import type { Action, Card } from '../src/cards'
import type { Page } from '../src/glasses'

let t = 1_000_000
let timers: { at: number; fn: () => void; dead: boolean }[] = []
let pages: Page[] = []
let logs: LogEntry[] = []
let pressed: string[] = []
let sent: string[] = []
let exited = 0

// Advances a fake clock timer by timer, so timers created while firing run at the right time.
const tick = async (ms: number) => {
  const end = t + ms
  for (;;) {
    const next = timers.filter(x => !x.dead && x.at <= end).sort((a, b) => a.at - b.at)[0]
    if (!next) break
    t = next.at
    next.dead = true
    next.fn()
    await new Promise(r => setTimeout(r, 0))
  }
  t = end
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
const main = () => last().texts[1].text

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
    expect(lens()).toContain('Double tap: undo')
    expect(main()).toContain('━━━━')
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

  it('shows the bot toast in the card header when the bot edits its message', async () => {
    const editing: Source = { ...source, press: async (c, a) => { pressed.push(a.label); app.upsert({ ...c, text: 'Pinged.', actions: [act('Again')] }); return { toast: 'Pong' } } }
    app.setSource(editing)
    app.settings.instant = [1]
    app.upsert(card(1, [act('Ping')]))
    app.input({ type: 'select', index: 0 })
    await flush()
    expect(app.view.v).toBe('card')
    expect(last().texts[0]).toMatchObject({ text: '@deploybot · Pong', color: 4 })
    expect(main()).toContain('Pinged.')
    await tick(2500)
    expect(last().texts[0]).toMatchObject({ text: '@deploybot · now', color: 2 })
  })

  it('without a reaction from the bot, the card retires so its buttons cannot be pressed twice', async () => {
    app.settings.instant = [1]
    app.upsert(card(1, [act('Staging only')]))
    app.input({ type: 'select', index: 0 })
    await flush()
    expect(main()).toContain('▶ Staging only')
    await tick(EDIT_WAIT_MS)
    expect(main()).toBe('Sent: Staging only')
    expect(app.queue).toHaveLength(0)
    app.upsert(card(1, [act('Staging only')])) // the same message again, e.g. rescanned on the next start
    expect(app.queue).toHaveLength(0)
  })

  it('an edit just after the press brings the card back with what the bot wrote', async () => {
    app.settings.instant = [1]
    app.upsert(card(1, [act('Staging only')]))
    app.input({ type: 'select', index: 0 })
    await flush()
    app.upsert(card(1, [act('Promote to prod', { style: 'danger' })], 'v2.3.1 is live on staging'))
    expect(app.view.v).toBe('card')
    expect(main()).toContain('v2.3.1 is live on staging')
    await tick(EDIT_WAIT_MS * 2)
    expect(app.queue).toHaveLength(1)
  })

  it('an answer sent as a new message replaces the card that was pressed', async () => {
    app.settings.instant = [1]
    app.upsert(card(1, [act('Book $212')]))
    app.input({ type: 'select', index: 0 })
    await flush()
    app.upsert(card(2, [], 'Booked. EK 76, seat 32A.'))
    expect(app.queue.map(c => c.msgId)).toEqual([2])
    expect(main()).toContain('Booked')
  })

  it('a bot alert gets its own screen', async () => {
    const alerting: Source = { ...source, press: async () => ({ toast: 'Insufficient funds', alert: true }) }
    app.setSource(alerting)
    app.settings.instant = [1]
    app.upsert(card(1, [act('Check balance')]))
    app.input({ type: 'select', index: 0 })
    await flush()
    expect(main()).toBe('Insufficient funds')
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
    app.upsert(card(2, [act('B')]))
    app.input({ type: 'select', index: 1 }) // Later: card 2 reaches the lens after waiting in the queue
    await flush()
    expect(app.card?.msgId).toBe(2)
    expect(seen).toEqual([120])
  })
})

describe('people', () => {
  const alex = () => ({ ...card(9, [{ label: 'Yes', kind: 'text' as const, value: 'Yes' }], 'Still on for 7pm?'), from: 'Alex', isBot: false })

  it('offers quick replies and a visible voice entry', () => {
    app.upsert(alex())
    expect(last().list!.items).toEqual(['Yes', 'Reply by voice'])
  })

  it('a quick reply is sent after the undo window and confirmed on the lens', async () => {
    app.upsert(alex())
    app.input({ type: 'select', index: 0 })
    await tick(UNDO_MS)
    expect(pressed).toEqual(['Yes'])
    expect(main()).toBe('Sent: "Yes"')
    expect(app.queue).toHaveLength(0)
  })

  it('voice can also be started and finished with taps', async () => {
    app = new App(deps({ transcribe: async () => 'see you there' }), { instant: [], muted: {}, replies: [] })
    app.setSource(source)
    app.upsert(alex())
    app.input({ type: 'select', index: 1 })
    expect(main()).toBe('Listening...')
    app.input({ type: 'click', ring: false })
    await flush()
    expect(main()).toContain('"see you there"')
  })
})

describe('bots and commands from the lens', () => {
  it('tap on the empty lens lists bots, then their commands, then sends one', async () => {
    app.input({ type: 'click', ring: false })
    await flush()
    expect(last().list!.items).toEqual(['@BotFather'])
    app.input({ type: 'select', index: 0 })
    await flush()
    expect(last().list!.items).toEqual(['Commands (1)']) // no messages yet: only the command menu
    app.input({ type: 'select', index: 0 })
    expect(last().list!.items[0]).toBe('/mybots · Edit your bots')
    app.input({ type: 'select', index: 0 })
    await flush()
    expect(sent).toEqual(['7:/mybots'])
  })
})

describe('chats picked for the glasses', () => {
  it('come first in the lens list, and a person opens with the quick replies', async () => {
    const alex: Card = { key: '201:5', chatId: 201, msgId: 5, from: 'Alex', isBot: false, text: 'Still on for 7pm?', date: t, actions: [], receivedAt: 0 }
    app.setSource({
      ...source,
      followed: async () => [{ id: 201, name: 'Alex' }, { id: 7, name: '@BotFather' }],
      history: async id => (id === 201 ? [{ id: 5, out: false, from: '', text: alex.text, date: t, buttons: [], card: alex }] : []),
      commands: async id => (id === 201 ? [] : [{ command: 'mybots', description: 'Edit your bots' }]),
    })
    app.input({ type: 'click', ring: false })
    await flush()
    expect(last().texts[0].text).toBe('Your chats')
    expect(last().list!.items).toEqual(['Alex', '@BotFather']) // a followed bot is listed once
    app.input({ type: 'select', index: 0 })
    await flush()
    app.input({ type: 'select', index: 0 })
    expect(lens()).toContain('Still on for 7pm?')
    expect(last().list!.items[0]).toContain('Yes')
    app.input({ type: 'select', index: 0 })
    await tick(UNDO_MS)
    expect(pressed).toEqual(['Yes'])
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
    expect(last().texts[0].text).toBe('Alex')
    expect(main()).toContain('Send it as a message')
    app.input({ type: 'click', ring: false })
    await flush()
    expect(sent).toEqual(['1:running 5 minutes late'])
  })
})

describe('what the lens really showed', () => {
  it('tells the source which card the lens really drew: read receipts and ad views', async () => {
    const seen: Card[] = []
    app = new App(deps({ onSeen: c => seen.push(c) }), { instant: [], muted: {}, replies: ['Yes'] })
    app.setSource(source)
    app.upsert(card(1, [act('OK')]))
    app.upsert(card(2, [act('OK')]))
    await flush()
    expect(new Set(seen.map(c => c.msgId))).toEqual(new Set([1])) // the queued card was not drawn: not read (the source dedups redraws)
    const random = new Uint8Array([9, 9])
    app.input({ type: 'double', ring: false })
    await flush()
    expect(new Set(seen.map(c => c.msgId))).toEqual(new Set([1, 2]))
    app.input({ type: 'double', ring: false })
    app.upsert({ ...card(3, [{ label: 'Open', kind: 'phone', value: 'https://t.me/x' }], 'Durov\nAds on Telegram'), ad: random, readOnly: true })
    await flush()
    expect(seen[seen.length - 1].ad).toBe(random)
  })
})

describe('irreversible buttons the bot did not mark', () => {
  it('ask for an explicit yes and say why, then press on tap', async () => {
    app.upsert(card(1, [act('Edit Bot'), act('Delete Bot'), act('« Back to Bot List')]))
    expect(last().list!.items[1]).toBe('▲ Delete Bot')
    app.input({ type: 'select', index: 1 })
    expect(lens()).toContain('cannot be undone')
    expect(pressed).toEqual([])
    app.input({ type: 'click', ring: false })
    await flush()
    expect(pressed).toEqual(['Delete Bot'])
  })
})

describe('a bot opened from the lens', () => {
  const bubble = (c: Card, out = false) => ({ id: c.msgId, out, from: '', text: c.text, date: c.date, buttons: [], card: c })
  const agent = (id: number, text: string, actions: Action[] = []) => ({ ...card(id, actions, text), key: `7:${id}`, chatId: 7, from: 'Evidence Mining' })

  it('shows its last messages, buttons or not, newest first, and opens one as a card', async () => {
    const msgs = [bubble(agent(4, '/start'), true), bubble(agent(5, 'Agent run finished\n6 markets studied')), bubble(agent(6, 'Run failed', [act('Retry')]))]
    app.setSource({ ...source, history: async () => msgs, commands: async () => [] })
    app.input({ type: 'click', ring: false })
    await flush()
    app.input({ type: 'select', index: 0 })
    await flush()
    expect(last().texts[0].text).toBe('@BotFather')
    expect(last().list!.items.map(l => l.replace(/^\S+ · /, ''))).toEqual(['Run failed', 'Agent run finished'])
    app.input({ type: 'select', index: 1 })
    expect(main()).toContain('Agent run finished')
    expect(last().list!.items).toEqual(['OK'])
  })

  it('says so when the bot never wrote and has no menu', async () => {
    app.setSource({ ...source, history: async () => [], commands: async () => [] })
    app.input({ type: 'click', ring: false })
    await flush()
    app.input({ type: 'select', index: 0 })
    await flush()
    expect(lens()).toContain('No messages here yet.')
  })
})

describe('a long bot list', () => {
  it('pages, so every bot stays reachable from the lens', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: 100 + i, name: `Bot ${i}` }))
    app.setSource({ ...source, bots: async () => many })
    app.input({ type: 'click', ring: false })
    await flush()
    const first = last().list!.items
    expect(first).toHaveLength(19)
    expect(first[18]).toBe('More chats (7)')
    app.input({ type: 'select', index: 18 })
    expect(last().list!.items).toEqual(many.slice(18).map(b => b.name))
    expect(last().texts[0].text).toBe('Your chats · 19 to 25')
    app.input({ type: 'double', ring: false })
    expect(last().list!.items[0]).toBe('Bot 0')
    app.input({ type: 'double', ring: false })
    expect(lens()).toContain('Nothing waiting')
  })
})
