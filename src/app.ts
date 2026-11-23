// Ack's brain: a queue of cards, one view on the lens, and what each gesture does.
// No SDK or Telegram imports here: everything comes in through Deps and Source, so it runs in tests.
import { ago, fit, match, missingGlyphRatio, order, replies, rowLabel, type Action, type Card } from './cards'
import type { Input, Page } from './glasses'

export interface PressResult { toast?: string; url?: string }
export interface BotRef { id: number; name: string }
export interface Command { command: string; description: string }

export interface Source {
  readonly kind: 'telegram' | 'demo'
  /** Presses a callback button or sends a reply-keyboard / quick-reply text. */
  press(card: Card, action: Action): Promise<PressResult>
  send(chatId: number, text: string): Promise<void>
  bots(): Promise<BotRef[]>
  commands(botId: number): Promise<Command[]>
}

export interface Settings {
  instant: number[] // bots that skip the undo window
  muted: Record<string, number> // chatId -> muted until (ms)
  replies: string[]
}

export interface LogEntry { at: number; from: string; card: string; action: string; outcome: string }

export interface Deps {
  draw(page: Page, force?: boolean): Promise<boolean>
  exit(): void
  now(): number
  perf(): number
  later(fn: () => void, ms: number): () => void
  mic?(on: boolean): void
  transcribe?(pcm: Uint8Array[], hints: string[]): Promise<string>
  onLog?(e: LogEntry): void
  onLatency?(ms: number): void
  onDemo?(): void
  onChange?(): void
}

type Item = { label: string; run: () => void }
type View =
  | { v: 'root' }
  | { v: 'card' }
  | { v: 'read' }
  | { v: 'confirm'; a: Action }
  | { v: 'pending'; a: Action; key: string; left: number }
  | { v: 'wait'; a: Action }
  | { v: 'note'; text: string; head?: string }
  | { v: 'bots'; bots: BotRef[] }
  | { v: 'cmds'; bot: BotRef; cmds: Command[] }
  | { v: 'voice' }
  | { v: 'heard'; text: string; a?: Action }

export const UNDO_MS = 1500
export const NOTE_MS = 1800
const W = 576
const H = 288
const HEAD_H = 32
const FOOT_H = 32
const STEP_MS = 300
const ROW_H = 40
const LINE_H = 27
const MENU = [{ id: 1, label: 'Mute this chat 1 h' }, { id: 2, label: 'Read all' }, { id: 3, label: 'Clear all cards' }]

export class App {
  queue: Card[] = []
  view: View = { v: 'root' }
  source: Source | null = null
  dismissed = new Set<string>()
  private cancel = () => {}
  private shown = new Set<string>()
  private pcm: Uint8Array[] = []
  private focus = { chatId: 0, until: 0 }
  private items: Item[] = []

  constructor(private d: Deps, public settings: Settings) {}

  get card(): Card | undefined { return this.queue[0] }

  setSource(s: Source | null) {
    this.source = s
    this.queue = []
    this.go(this.view.v === 'root' || !s ? { v: 'root' } : this.view)
  }

  // ---- cards in -------------------------------------------------------------

  upsert(c: Card) {
    if (this.dismissed.has(c.key) || (this.settings.muted[c.chatId] ?? 0) > this.d.now()) return
    const i = this.queue.findIndex(x => x.key === c.key)
    if (i >= 0) this.queue[i] = { ...c, receivedAt: this.queue[i].receivedAt }
    else if (this.focus.chatId === c.chatId && this.focus.until > this.d.now()) this.queue.unshift(c)
    else this.queue.push(c)
    if (this.view.v === 'root') this.view = { v: 'card' }
    this.render()
  }

  remove(key: string) {
    const was = this.card?.key
    this.queue = this.queue.filter(c => c.key !== key)
    if (was === key && (this.view.v === 'card' || this.view.v === 'read')) this.back()
    else this.render()
  }

  // ---- gestures ---------------------------------------------------------------

  input(i: Input) {
    if (i.type === 'pcm') { if (this.view.v === 'voice') this.pcm.push(i.pcm); return }
    if (i.type === 'menu') return this.menu(i.id)
    if (i.type === 'foreground') return this.render(true)
    const v = this.view
    switch (v.v) {
      case 'root':
        if (i.type === 'double') return this.d.exit()
        if (i.type === 'click') return this.source ? this.openBots() : this.d.onDemo?.()
        return
      case 'card':
        if (i.type === 'select') return this.items[i.index]?.run()
        if (i.type === 'double') return this.dismiss('dismissed')
        if (i.type === 'longStart') return this.listen()
        return
      case 'read':
      case 'note':
        if (i.type === 'click' || i.type === 'double') return this.back()
        return
      case 'confirm':
        if (i.type === 'click') return this.card ? this.fire(v.a, this.card.key) : this.back()
        if (i.type === 'double') return this.back()
        return
      case 'pending':
        if (i.type === 'click') { this.cancel(); return this.fire(v.a, v.key) }
        if (i.type === 'double') { this.cancel(); this.log(v.a, 'undone'); return this.note(`Undone: ${v.a.label}`) }
        return
      case 'bots':
      case 'cmds':
        if (i.type === 'select') return this.items[i.index]?.run()
        if (i.type === 'double') return v.v === 'cmds' ? void this.openBots() : this.go({ v: 'root' })
        return
      case 'voice':
        if (i.type === 'longEnd') return this.heard()
        if (i.type === 'double') { this.d.mic?.(false); return this.back() }
        return
      case 'heard':
        if (i.type === 'click') return this.say(v.text, v.a)
        if (i.type === 'double') return this.back()
        return
      case 'wait':
        return
    }
  }

  private menu(id: number) {
    const c = this.card
    if (id === 1 && c) {
      this.settings.muted[c.chatId] = this.d.now() + 3600_000
      for (const x of this.queue.filter(x => x.chatId === c.chatId)) this.dismissed.add(x.key)
      this.queue = this.queue.filter(x => x.chatId !== c.chatId)
      this.d.onChange?.()
      return this.note(`${c.from} muted for 1 h`)
    }
    if (id === 2 && c) return this.go({ v: 'read' })
    if (id === 3) {
      for (const x of this.queue) this.dismissed.add(x.key)
      this.queue = []
      return this.go({ v: 'root' })
    }
  }

  // ---- actions ----------------------------------------------------------------

  choose(a: Action) {
    const c = this.card
    if (!c) return
    switch (a.kind) {
      case 'dismiss': return this.dismiss('ok')
      case 'phone': this.log(a, 'phone'); return this.note(`Finish on your phone:\n${a.label}${a.value ? `\n${a.value.replace(/^https?:\/\//, '').slice(0, 60)}` : ''}`)
      case 'copy': this.log(a, 'shown'); return this.note(a.value || a.label)
      case 'disabled': return this.note('This button is off.')
    }
    if (a.style === 'danger') return this.go({ v: 'confirm', a })
    if (this.settings.instant.includes(c.chatId)) return this.fire(a, c.key)
    this.countdown(a, c.key, UNDO_MS)
  }

  private countdown(a: Action, key: string, left: number) {
    if (left <= 0) return void this.fire(a, key)
    this.go({ v: 'pending', a, key, left })
    this.cancel = this.d.later(() => this.countdown(a, key, left - STEP_MS), Math.min(STEP_MS, left))
  }

  private async fire(a: Action, key: string) {
    const c = this.queue.find(x => x.key === key)
    if (!c || !this.source) return this.note('This card is gone.')
    this.go({ v: 'wait', a })
    this.focus = { chatId: c.chatId, until: this.d.now() + 15_000 }
    try {
      const r = await this.source.press(c, a)
      this.log(a, r.toast ? `ok: ${r.toast}` : 'ok', c)
      if (a.kind === 'text') this.drop(c.key)
      if (r.url) return this.note(`Finish on your phone:\n${r.toast ?? r.url}`)
      if (r.toast) return this.note(r.toast)
      this.back()
    } catch (e) {
      const msg = errorText(e)
      this.log(a, `error: ${msg}`, c)
      this.note(msg)
    }
  }

  private dismiss(outcome: string) {
    const c = this.card
    if (!c) return this.back()
    this.log({ label: '(none)', kind: 'dismiss' }, outcome, c)
    this.drop(c.key)
    this.back()
  }

  private drop(key: string) {
    this.dismissed.add(key)
    this.queue = this.queue.filter(x => x.key !== key)
    this.d.onChange?.()
  }

  // ---- bots and commands -------------------------------------------------------

  private async openBots() {
    const bots = (await this.source?.bots()) ?? []
    if (!bots.length) return this.note('No bot chats yet.\nStart one in Telegram.', 'Ack')
    this.go({ v: 'bots', bots })
  }

  private async openCommands(bot: BotRef) {
    const cmds = (await this.source?.commands(bot.id)) ?? []
    if (!cmds.length) return this.note('This bot has no command menu.', bot.name)
    this.go({ v: 'cmds', bot, cmds })
  }

  private async sendCommand(bot: BotRef, cmd: string) {
    this.focus = { chatId: bot.id, until: this.d.now() + 15_000 }
    try {
      await this.source!.send(bot.id, `/${cmd}`)
      this.d.onLog?.({ at: this.d.now(), from: bot.name, card: '(command menu)', action: `/${cmd}`, outcome: 'sent' })
      this.note(`Sent /${cmd}\nThe answer will show up here.`, bot.name)
    } catch (e) {
      this.note(errorText(e), bot.name)
    }
  }

  // ---- voice ------------------------------------------------------------------

  private listen() {
    if (!this.d.transcribe) return this.note('Voice needs a speech key:\nAck settings on your phone.')
    this.pcm = []
    this.d.mic?.(true)
    this.go({ v: 'voice' })
  }

  private async heard() {
    this.d.mic?.(false)
    const c = this.card
    if (!c) return this.back()
    this.go({ v: 'note', text: 'Transcribing...' })
    try {
      const text = (await this.d.transcribe!(this.pcm, [c.from, ...c.actions.map(a => a.label)])).trim()
      if (!text) return this.note('Did not catch that.')
      this.go({ v: 'heard', text, a: match(text, c.actions.filter(a => a.kind === 'callback' || a.kind === 'text')) })
    } catch (e) {
      this.note(errorText(e))
    }
  }

  private async say(text: string, a?: Action) {
    const c = this.card
    if (!c) return this.back()
    if (a) return this.fire(a, c.key)
    this.go({ v: 'wait', a: { label: text, kind: 'text' } })
    try {
      await this.source!.send(c.chatId, text)
      this.log({ label: `"${text}"`, kind: 'text' }, 'sent', c)
      this.drop(c.key)
      this.note(`Sent to ${c.from}`)
    } catch (e) {
      this.note(errorText(e))
    }
  }

  // ---- views ------------------------------------------------------------------

  private go(v: View) {
    this.cancel()
    this.cancel = () => {}
    this.view = v
    this.render()
  }

  private back() {
    this.go(this.queue.length ? { v: 'card' } : { v: 'root' })
  }

  private note(text: string, head = this.card?.from) {
    this.go({ v: 'note', text, head })
    this.cancel = this.d.later(() => this.back(), NOTE_MS)
  }

  private log(a: Action, outcome: string, c = this.card) {
    if (!c) return
    this.d.onLog?.({ at: this.d.now(), from: c.from, card: c.text.slice(0, 80), action: a.label, outcome })
  }

  render(force = false) {
    const page = this.page()
    const c = this.card
    const live = this.view.v === 'card' && c && !this.shown.has(c.key) ? c : undefined
    if (live) this.shown.add(live.key)
    void this.d.draw(page, force).then(ok => {
      if (ok && live) this.d.onLatency?.(this.d.perf() - live.receivedAt)
    })
    this.d.onChange?.()
  }

  /** The page for the current view. Pure apart from reading the clock for "2m". */
  page(): Page {
    const v = this.view
    const c = this.card
    const from = c?.from ?? 'Ack'
    this.items = []
    switch (v.v) {
      case 'root':
        return this.source
          ? screen('Ack', 'Nothing waiting.', 'Tap: your bots   ·   Double tap: exit', 2)
          : screen('Ack', 'Sign in to Telegram:\nopen Ack in the Even app\non your phone.', 'Tap: try the demo   ·   Double tap: exit', 2)
      case 'card':
        return c ? this.cardPage(c) : screen('Ack', 'Nothing waiting.', '', 2)
      case 'read':
        return screen(from, c?.text ?? '', 'Swipe: scroll   ·   Tap: back')
      case 'confirm':
        return screen(`${from} · marked as dangerous`, `▲ ${v.a.label}?`, 'Tap: yes, do it   ·   Double tap: no')
      case 'pending':
        return screen(from, `▶ ${v.a.label}\n\nSending in ${(v.left / 1000).toFixed(1)} s\n${bar(v.left / UNDO_MS)}`, 'Double tap: undo   ·   Tap: send now')
      case 'wait':
        return screen(from, `▶ ${v.a.label}\n\nWaiting for the bot...`, '')
      case 'note':
        return screen(v.head ?? 'Ack', v.text, 'Tap: back')
      case 'voice':
        return screen(from, 'Listening...', 'Release to finish   ·   Double tap: cancel')
      case 'heard':
        return screen(from, `"${v.text}"\n\n${v.a ? `→ ${rowLabel(v.a)}` : '→ Send it as a message'}`, 'Tap: yes   ·   Double tap: no')
      case 'bots':
        this.items = v.bots.slice(0, 19).map(b => ({ label: b.name, run: () => void this.openCommands(b) }))
        return listPage('Your bots · pick one to see its menu', this.items)
      case 'cmds':
        this.items = v.cmds.slice(0, 19).map(cm => ({ label: `/${cm.command} ${cm.description}`.trim(), run: () => void this.sendCommand(v.bot, cm.command) }))
        return listPage(`${v.bot.name} · commands`, this.items)
    }
  }

  private cardPage(c: Card): Page {
    const acts = order(c.actions.length ? c.actions : replies(['OK']).map(a => ({ ...a, kind: 'dismiss' as const })))
    const rows = Math.min(acts.length + 2, 3)
    const bodyH = H - HEAD_H - rows * ROW_H
    const text = missingGlyphRatio(c.text) > 0.4 ? `${c.text}\n(Some characters only show on your phone.)` : c.text
    const body = fit(text || '(no text)', W - 16, Math.max(1, Math.floor(bodyH / LINE_H)))
    this.items = acts.map(a => ({ label: rowLabel(a), run: () => this.choose(a) }))
    if (body.cut) this.items.push({ label: 'Read all', run: () => this.go({ v: 'read' }) })
    if (this.queue.length > 1) this.items.push({ label: `Later (${this.queue.length - 1} more)`, run: () => this.later() })
    const listRows = Math.min(this.items.length, 3)
    const pos = this.queue.length > 1 ? `   1/${this.queue.length}` : ''
    return {
      texts: [
        { name: 'head', x: 8, y: 0, w: W - 16, h: HEAD_H, text: `${c.from} · ${ago(this.d.now() - c.date)}${pos}`, color: 2 },
        { name: 'body', x: 8, y: HEAD_H, w: W - 16, h: H - HEAD_H - listRows * ROW_H, text: body.text, color: 4 },
      ],
      list: { name: 'acts', x: 0, y: H - listRows * ROW_H, w: W, h: listRows * ROW_H, items: this.items.map(i => i.label) },
      menu: MENU,
    }
  }

  private later() {
    const c = this.queue.shift()
    if (c) this.queue.push(c)
    this.go({ v: 'card' })
  }
}

/** Every non-list screen: dim context on top, the message, dim gesture hints at the bottom. */
function screen(head: string, body: string, foot: string, color = 4): Page {
  return {
    texts: [
      { name: 'head', x: 8, y: 0, w: W - 16, h: HEAD_H, text: head, color: 2 },
      { name: 'main', x: 8, y: HEAD_H, w: W - 16, h: H - HEAD_H - FOOT_H, text: body, color, capture: true },
      { name: 'foot', x: 8, y: H - FOOT_H, w: W - 16, h: FOOT_H, text: foot, color: 2 },
    ],
  }
}

function bar(share: number): string {
  const n = 24
  const on = Math.max(0, Math.min(n, Math.round(share * n)))
  return '━'.repeat(on) + '─'.repeat(n - on)
}

function listPage(title: string, items: Item[]): Page {
  const listH = Math.min(items.length, 6) * ROW_H
  return {
    texts: [{ name: 'head', x: 8, y: 0, w: W - 16, h: HEAD_H, text: title, color: 2 }],
    list: { name: 'items', x: 0, y: HEAD_H, w: W, h: Math.min(listH, H - HEAD_H), items: items.map(i => rowLabel({ label: i.label, kind: 'callback' })) },
  }
}

export function errorText(e: unknown): string {
  const m = String((e as { text?: string; message?: string })?.text ?? (e as Error)?.message ?? e)
  if (m.includes('BOT_RESPONSE_TIMEOUT') || m.includes('Timeout')) return 'The bot did not answer.\nIt may be offline.'
  if (m.includes('MESSAGE_ID_INVALID') || m.includes('DATA_INVALID')) return 'This button expired.'
  if (m.includes('FLOOD_WAIT')) return 'Telegram asks to slow down.\nTry again in a minute.'
  return `Could not send.\n${m.slice(0, 80)}`
}
