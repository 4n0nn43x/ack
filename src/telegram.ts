// Live Telegram: the user's own account over MTProto (mtcute, layer 233), straight from the phone.
// The session lives in the WebView's IndexedDB; no Ack server ever sees it.
import { TelegramClient, WebCryptoProvider, type Message, type User } from '@mtcute/web'
import wasmUrl from '@mtcute/wasm/mtcute.wasm?url' // explicit URL: works in Vite dev and in the packed .ehpk
import type { BotRef, Command, PressResult, Source } from './app'
import { cardFrom, type MsgLike } from './cards-from'
import { clean, type Action, type Card } from './cards'

export interface LoginUI {
  ask(kind: 'phone' | 'code' | 'password'): Promise<string>
  status(text: string): void
}

export type ChatKind = 'bot' | 'person' | 'group' | 'channel'
export interface Chat { id: number; name: string; kind: ChatKind }

const FRESH_MS = 48 * 3600_000 // pending questions older than this are not resurfaced on start

export class TelegramSource implements Source {
  readonly kind = 'telegram'
  readonly tg: TelegramClient
  me: User | null = null
  private recent = new Map<number, Chat>()
  private keys = new Map<number, string>()

  constructor(
    apiId: number,
    apiHash: string,
    private sink: (c: Card) => void,
    private drop: (key: string) => void,
    private follow: () => number[], // people and groups the user picked
    private replies: () => Action[],
  ) {
    this.tg = new TelegramClient({ apiId, apiHash, storage: 'ack-session', crypto: new WebCryptoProvider({ wasmInput: wasmUrl }) })
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
    this.tg.onDeleteMessage.add(u => { for (const id of u.messageIds) this.dropMsg(id) })
    await this.tg.startUpdatesLoop() // start() only signs in; live updates need the loop
  }

  /** Brings back the decisions that were waiting while Ack was closed. Call once the app uses this source. */
  async scan() {
    for await (const d of this.tg.iterDialogs({ limit: 80 })) {
      const p = d.peer
      const chat: Chat = p.type === 'user'
        ? { id: p.id, name: p.isBot ? `@${p.username ?? p.displayName}` : p.displayName, kind: p.isBot ? 'bot' : 'person' }
        : { id: p.id, name: p.displayName, kind: p.type === 'chat' && p.chatType === 'channel' ? 'channel' : 'group' }
      this.recent.set(chat.id, chat)
      const m = d.lastMessage
      if (!m || m.isOutgoing || Date.now() - m.date.getTime() > FRESH_MS) continue
      const asks = m.markup?.type === 'inline' || m.markup?.type === 'reply'
      if (chat.kind === 'bot' ? asks : d.unreadCount > 0 || asks) this.take(m)
    }
  }

  private dropMsg(msgId: number) {
    const key = this.keys.get(msgId)
    if (key) this.drop(key)
  }

  private take(m: Message) {
    const c = cardFrom(m as unknown as MsgLike, this.follow(), this.replies())
    if (!c) return
    this.keys.set(c.msgId, c.key)
    this.sink(c)
  }

  async press(card: Card, action: Action): Promise<PressResult> {
    if (action.kind === 'text') {
      await this.send(card.chatId, action.value ?? action.label, card.replyTo)
      return {}
    }
    const r = await this.tg.getCallbackAnswer({ chatId: card.chatId, message: card.msgId, data: action.data ?? new Uint8Array() })
    return { toast: r.message ? clean(r.message) : undefined, alert: r.alert, url: r.url }
  }

  async send(chatId: number, text: string, replyTo?: number) {
    await this.tg.sendText(chatId, text, replyTo ? { replyTo } : undefined)
  }

  async bots(): Promise<BotRef[]> {
    return this.list('bot').map(({ id, name }) => ({ id, name }))
  }

  /** Chats of one kind, most recent first, for the phone settings. */
  list(kind: ChatKind): Chat[] {
    return [...this.recent.values()].filter(c => c.kind === kind)
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
