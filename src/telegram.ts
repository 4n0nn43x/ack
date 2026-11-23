// Live Telegram: the user's own account over MTProto (mtcute, layer 233), straight from the phone.
// The session lives in the WebView's IndexedDB; no Ack server ever sees it.
import { TelegramClient, WebCryptoProvider, type Dialog, type Message, type User } from '@mtcute/web'
import wasmUrl from '@mtcute/wasm/mtcute.wasm?url' // explicit URL: works in Vite dev and in the packed .ehpk
import type { BotRef, Command, PressResult, Source } from './app'
import { bubbleFrom, cardFrom, idScope, preview, type Bubble, type ChatKind, type ChatRow, type MsgLike } from './cards-from'
import { clean, type Action, type Card } from './cards'

export interface LoginUI {
  ask(kind: 'phone' | 'code' | 'password'): Promise<string>
  status(text: string): void
  qr(url: string): void // QR sign-in: show this tg://login link as a QR code
}

export interface Chat { id: number; name: string; kind: ChatKind }

const FRESH_MS = 48 * 3600_000 // pending questions older than this are not resurfaced on start

export class TelegramSource implements Source {
  readonly kind = 'telegram'
  readonly tg: TelegramClient
  me: User | null = null
  private recent = new Map<number, Chat>()
  private keys = new Map<string, string>() // `${idScope}:${msgId}` -> card key
  private photos = new Map<number, { small: Parameters<TelegramClient['downloadAsBuffer']>[0] }>()
  private avatars = new Map<number, Promise<string | null>>()
  onActivity: (chatId: number) => void = () => {} // any new or edited message, so the phone can refresh an open chat

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

  /** Signs in with a phone number and code, or with a QR code scanned from Telegram on another device. */
  async start(ui: LoginUI, qr = false) {
    ui.status('Connecting to Telegram...')
    const password = () => ui.ask('password')
    const invalidCodeCallback = (kind: 'code' | 'password') => ui.status(kind === 'code' ? 'Wrong code, try again.' : 'Wrong password, try again.')
    this.me = await this.tg.start(qr
      ? { qrCodeHandler: url => ui.qr(url), password, invalidCodeCallback }
      : { phone: () => ui.ask('phone'), code: () => ui.ask('code'), password, invalidCodeCallback })
    this.tg.onConnectionState.add(st => console.log(`[ack] telegram ${st}`))
    this.tg.onError.add(e => console.error('[ack] telegram error', e))
    this.tg.onNewMessage.add(m => this.take(m))
    this.tg.onEditMessage.add(m => this.take(m))
    this.tg.onDeleteMessage.add(u => { for (const id of u.messageIds) this.dropMsg(u.channelId ?? 0, id) })
    await this.tg.startUpdatesLoop() // start() only signs in; live updates need the loop
  }

  /** Brings back the decisions that were waiting while Ack was closed. Call once the app uses this source. */
  async scan() {
    for await (const d of this.tg.iterDialogs({ limit: 80 })) {
      const chat = this.remember(d)
      const m = d.lastMessage
      if (!m || m.isOutgoing || Date.now() - m.date.getTime() > FRESH_MS) continue
      const asks = m.markup?.type === 'inline' || m.markup?.type === 'reply'
      if (chat.kind === 'bot' ? asks : d.unreadCount > 0 || asks) this.take(m)
    }
  }

  /** Keeps a dialog in the recent list (with its photo for avatars) and returns its chat list row. */
  private remember(d: Dialog): ChatRow {
    const p = d.peer
    const kind: ChatKind = p.type === 'user' ? (p.isBot ? 'bot' : 'person') : p.chatType === 'channel' ? 'channel' : 'group'
    const name = p.type === 'user' && p.isBot ? `@${p.username ?? p.displayName}` : p.displayName
    this.recent.set(p.id, { id: p.id, name, kind })
    if (p.photo) this.photos.set(p.id, p.photo)
    const m = d.lastMessage
    const text = m ? preview(m as unknown as MsgLike).split('\n')[0] : ''
    return { id: p.id, name, kind, preview: m?.isOutgoing && text ? `You: ${text}` : text, date: m?.date.getTime() ?? 0, unread: d.unreadCount }
  }

  /** The chat list for the phone, most recent first. */
  async chats(): Promise<ChatRow[]> {
    const rows: ChatRow[] = []
    for await (const d of this.tg.iterDialogs({ limit: 60 })) rows.push(this.remember(d))
    return rows
  }

  /** The last messages of one chat, oldest first. Opening a chat marks it read, like any Telegram client. */
  async history(chatId: number): Promise<Bubble[]> {
    const msgs = await this.tg.getHistory(chatId, { limit: 40 })
    void this.tg.readHistory(chatId).catch(() => {})
    return [...msgs].reverse().filter(m => !m.isService).map(m => bubbleFrom(m as unknown as MsgLike))
  }

  /** A chat's small profile photo as an object URL, downloaded once. */
  avatar(chatId: number): Promise<string | null> {
    let url = this.avatars.get(chatId)
    if (!url) {
      const photo = this.photos.get(chatId)
      url = photo
        ? this.tg.downloadAsBuffer(photo.small).then(b => URL.createObjectURL(new Blob([b as BlobPart], { type: 'image/jpeg' })), () => null)
        : Promise.resolve(null)
      this.avatars.set(chatId, url)
    }
    return url
  }

  private dropMsg(scope: number, msgId: number) {
    const key = this.keys.get(`${scope}:${msgId}`)
    if (key) this.drop(key)
  }

  private take(m: Message) {
    this.onActivity(m.chat.id)
    const c = cardFrom(m as unknown as MsgLike, this.follow(), this.replies())
    console.log(`[ack] telegram message ${m.chat.type}${m.chat.type === 'user' && m.chat.isBot ? ' bot' : ''} ${m.isOutgoing ? 'out' : 'in'} markup=${m.markup?.type ?? 'none'} -> ${c ? 'card' : 'skipped'}`)
    if (!c) return
    this.keys.set(`${idScope(m.chat as unknown as MsgLike['chat'])}:${c.msgId}`, c.key)
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
