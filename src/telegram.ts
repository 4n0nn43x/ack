// Live Telegram: the user's own account over MTProto (mtcute, layer 233), straight from the phone.
// The session lives in the WebView's IndexedDB; no Ack server ever sees it.
import { TelegramClient, type Message, type User } from '@mtcute/web'
import type { BotRef, Command, PressResult, Source } from './app'
import { clean, fromInline, fromReply, type Action, type Card, type RawButton } from './cards'

export interface LoginUI {
  ask(kind: 'phone' | 'code' | 'password'): Promise<string>
  status(text: string): void
}

export interface Chat { id: number; name: string; isBot: boolean }

const FRESH_MS = 48 * 3600_000 // pending bot questions older than this are not resurfaced on start

export class TelegramSource implements Source {
  readonly kind = 'telegram'
  readonly tg: TelegramClient
  me: User | null = null
  private recent = new Map<number, Chat>()

  constructor(
    apiId: number,
    apiHash: string,
    private sink: (c: Card) => void,
    private drop: (key: string) => void,
    private people: () => number[],
    private replies: () => Action[],
  ) {
    this.tg = new TelegramClient({ apiId, apiHash, storage: 'ack-session' })
  }

  async start(ui: LoginUI) {
    ui.status('Connecting to Telegram...')
    this.me = await this.tg.start({
      phone: () => ui.ask('phone'),
      code: () => ui.ask('code'),
      password: () => ui.ask('password'),
      invalidCodeCallback: kind => ui.status(kind === 'code' ? 'Wrong code, try again.' : 'Wrong password, try again.'),
    })
    this.tg.onNewMessage.add(m => this.take(m))
    this.tg.onEditMessage.add(m => this.take(m))
    this.tg.onDeleteMessage.add(u => { if (!u.channelId) for (const id of u.messageIds) this.dropMsg(id) })
  }

  /** Brings back the decisions that were waiting while Ack was closed. Call once the app uses this source. */
  async scan() {
    for await (const d of this.tg.iterDialogs({ limit: 60 })) {
      const p = d.peer
      if (p.type !== 'user') continue
      this.recent.set(p.id, { id: p.id, name: p.isBot ? `@${p.username ?? p.displayName}` : p.displayName, isBot: p.isBot })
      const m = d.lastMessage
      if (!m || m.isOutgoing || Date.now() - m.date.getTime() > FRESH_MS) continue
      if (p.isBot ? m.markup?.type === 'inline' || m.markup?.type === 'reply' : d.unreadCount > 0) this.take(m)
    }
  }

  private keys = new Map<number, string>()
  private dropMsg(msgId: number) {
    const key = this.keys.get(msgId)
    if (key) this.drop(key)
  }

  /** A Telegram message to a card, or nothing. Only private chats: bots, and the people the user picked. */
  toCard(m: Message): Card | null {
    if (m.isOutgoing || m.isService || m.chat.type !== 'user') return null
    const u = m.chat as User
    if (!u.isBot && !this.people().includes(u.id)) return null
    const mk = m.markup
    const actions = !u.isBot ? this.replies()
      : mk?.type === 'inline' ? fromInline(mk.buttons as unknown as RawButton[][])
      : mk?.type === 'reply' ? fromReply(mk.buttons as unknown as RawButton[][])
      : []
    const media = (m.media as { type?: string } | null)?.type
    const text = clean(m.text) || (media ? `[${media}]` : m.richMessage ? '[rich message, open it on your phone]' : '')
    const name = u.isBot ? `@${u.username ?? u.displayName}` : u.displayName
    this.recent.set(u.id, { id: u.id, name, isBot: u.isBot })
    return { key: `${u.id}:${m.id}`, chatId: u.id, msgId: m.id, from: name, isBot: u.isBot, text, date: m.date.getTime(), actions, receivedAt: performance.now() }
  }

  private take(m: Message) {
    const c = this.toCard(m)
    if (!c) return
    this.keys.set(c.msgId, c.key)
    this.sink(c)
  }

  async press(card: Card, action: Action): Promise<PressResult> {
    if (action.kind === 'text') {
      await this.tg.sendText(card.chatId, action.value ?? action.label)
      return {}
    }
    const r = await this.tg.getCallbackAnswer({ chatId: card.chatId, message: card.msgId, data: action.data ?? new Uint8Array() })
    return { toast: r.message ? clean(r.message) : undefined, url: r.url }
  }

  async send(chatId: number, text: string) {
    await this.tg.sendText(chatId, text)
  }

  async bots(): Promise<BotRef[]> {
    return [...this.recent.values()].filter(c => c.isBot).map(({ id, name }) => ({ id, name }))
  }

  /** People the user can follow, most recent first. */
  chats(): Chat[] {
    return [...this.recent.values()].filter(c => !c.isBot)
  }

  async commands(botId: number): Promise<Command[]> {
    const full = await this.tg.getFullUser(botId)
    const info = (full.full as { botInfo?: { commands?: { command: string; description: string }[] } }).botInfo
    return (info?.commands ?? []).map(c => ({ command: c.command, description: clean(c.description) }))
  }

  async signOut() {
    await this.tg.logOut().catch(() => {})
  }
}
