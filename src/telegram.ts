// Live Telegram: the user's own account over MTProto (mtcute, layer 233), straight from the phone.
// The session lives in the WebView's IndexedDB; no Ack server ever sees it.
import { TelegramClient, WebCryptoProvider, type Chat as TgChat, type Dialog, type Message, type User } from '@mtcute/web'
import wasmUrl from '@mtcute/wasm/mtcute.wasm?url' // explicit URL: works in Vite dev and in the packed .ehpk
import type { BotRef, Command, PressResult, Source } from './app'
import { adCard, bubbleFrom, cardFrom, idScope, msgLike, nameOf, preview, shouldSurface, sponsoredFrom, waitingIn, type Bubble, type ChatKind, type ChatRow, type MsgLike, type PeerLike, type Sponsored } from './cards-from'
import { clean, type Action, type Card } from './cards'

export interface LoginUI {
  ask(kind: 'phone' | 'code' | 'password'): Promise<string>
  status(text: string): void
  qr(url: string): void // QR sign-in: show this tg://login link as a QR code
}

export interface Chat { id: number; name: string; kind: ChatKind }

export class TelegramSource implements Source {
  readonly kind = 'telegram'
  readonly tg: TelegramClient
  me: User | null = null
  private recent = new Map<number, Chat>()
  private keys = new Map<string, string>() // `${idScope}:${msgId}` -> card key
  private photos = new Map<number, { small: Parameters<TelegramClient['downloadAsBuffer']>[0] }>()
  private avatars = new Map<number, Promise<string | null>>()
  private ads = new Map<number, { at: number; list: Promise<Sponsored[]> }>()
  private adsViewed = new Set<string>()
  private read = new Set<string>()
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
    const follow = this.follow()
    for await (const d of this.tg.iterDialogs({ limit: 80 })) {
      const chat = this.remember(d)
      const m = d.lastMessage
      if (!m) continue
      const asks = m.markup?.type === 'inline' || m.markup?.type === 'reply'
      if (shouldSurface({
        kind: chat.kind, incoming: !m.isOutgoing, ageMs: Date.now() - m.date.getTime(),
        unread: d.unreadCount, hasButtons: asks, followed: follow.includes(chat.id),
      })) this.take(m)
    }
    await this.refreshFollowed()
  }

  /**
   * Pushes the last incoming message of every followed chat, even when it was already read or is
   * old. Opening a chat on the phone marks it read, so unread count alone loses those decisions.
   */
  async refreshFollowed() {
    for (const id of this.follow()) {
      try {
        const m = waitingIn(await this.tg.getHistory(id, { limit: 10 }))
        if (!m) continue
        this.chatOf(m.chat)
        if (m.sender.id !== m.chat.id) this.chatOf(m.sender)
        this.take(m)
      } catch (e) {
        console.log(`[ack] cannot refresh chat ${id}: ${(e as Error).message ?? e}`)
      }
    }
  }

  /** Keeps a peer in the recent list (with its photo for avatars), with a name always fit for the lens. */
  private chatOf(p: User | TgChat): Chat {
    const kind: ChatKind = p.type === 'user' ? (p.isBot ? 'bot' : 'person') : p.chatType === 'channel' ? 'channel' : 'group'
    const name = nameOf(p as unknown as PeerLike)
    this.recent.set(p.id, { id: p.id, name, kind })
    if (p.photo) this.photos.set(p.id, p.photo)
    return { id: p.id, name, kind }
  }

  /** Keeps a dialog in the recent list (with its photo for avatars) and returns its chat list row. */
  private remember(d: Dialog): ChatRow {
    const chat = this.chatOf(d.peer)
    const m = d.lastMessage
    const text = m ? preview(this.named(m)).split('\n')[0] : ''
    return { ...chat, preview: m?.isOutgoing && text ? `You: ${text}` : text, date: m?.date.getTime() ?? 0, unread: d.unreadCount }
  }

  /** Live peers can be partial: fill their names from the dialogs we already saw. */
  private named(m: Message): MsgLike {
    return msgLike(m as unknown as MsgLike, id => this.recent.get(id)?.name)
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
    return [...msgs].reverse().filter(m => !m.isService).map(m => bubbleFrom(this.named(m)))
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

  /** A channel's or bot's official sponsored messages (API terms 3.3), cached 5 minutes as the API asks. */
  sponsored(chatId: number): Promise<Sponsored[]> {
    const hit = this.ads.get(chatId)
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.list
    const list = this.tg.resolvePeer(chatId)
      .then(peer => this.tg.call({ _: 'messages.getSponsoredMessages', peer }))
      .then(r => sponsoredFrom(r as Parameters<typeof sponsoredFrom>[0]), () => [])
    this.ads.set(chatId, { at: Date.now(), list })
    return list
  }

  /** Reports a sponsored message once its whole text was on screen (lens or phone), once per ad. */
  adViewed(random: Uint8Array) {
    const id = random.join(',')
    if (this.adsViewed.has(id)) return
    this.adsViewed.add(id)
    void this.tg.call({ _: 'messages.viewSponsoredMessage', randomId: random }).catch(() => {})
  }

  /**
   * A message read on the lens is read for Telegram too (API terms 1.4: no ghost mode), once per card.
   * Only what was actually drawn is marked, up to that message.
   */
  markRead(c: Card) {
    if (this.read.has(c.key)) return
    this.read.add(c.key)
    void this.tg.readHistory(c.chatId, { maxId: c.msgId }).catch(() => {})
  }

  adClicked(random: Uint8Array) {
    void this.tg.call({ _: 'messages.clickSponsoredMessage', randomId: random }).catch(() => {})
  }

  private dropMsg(scope: number, msgId: number) {
    const key = this.keys.get(`${scope}:${msgId}`)
    if (key) this.drop(key)
  }

  private take(m: Message) {
    this.onActivity(m.chat.id)
    const c = cardFrom(this.named(m), this.follow(), this.replies())
    console.log(`[ack] telegram message ${m.chat.type}${m.chat.type === 'user' && m.chat.isBot ? ' bot' : ''} ${m.isOutgoing ? 'out' : 'in'} markup=${m.markup?.type ?? 'none'} -> ${c ? 'card' : 'skipped'}`)
    if (!c) return
    this.keys.set(`${idScope(m.chat as unknown as MsgLike['chat'])}:${c.msgId}`, c.key)
    this.sink(c)
    // A channel post on the lens is followed by that channel's sponsored message, as in Telegram's own apps.
    if (c.readOnly) void this.sponsored(m.chat.id).then(ads => { if (ads[0]) this.sink(adCard(m.chat.id, nameOf(this.named(m).chat), ads[0], Date.now())) })
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
