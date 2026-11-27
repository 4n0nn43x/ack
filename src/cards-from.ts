// A Telegram message to a card (lens) or a bubble (phone). Kept apart from the client so it is tested without a connection.
import { clean, fromInline, fromReply, type Action, type Card, type RawButton } from './cards'

export type ChatKind = 'bot' | 'person' | 'group' | 'channel'

/** One row of the phone's chat list. */
export interface ChatRow { id: number; name: string; kind: ChatKind; preview: string; date: number; unread: number }

/** One message in the phone's chat view. The phone draws the original text and button labels (emoji included). */
export interface Bubble {
  id: number
  out: boolean
  from: string // sender name in groups, empty elsewhere
  text: string
  date: number
  buttons: { label: string; action: Action }[]
  card: Card // what Source.press needs to press one of the buttons
}

export interface PeerLike {
  type: string
  id: number
  isBot?: boolean
  username?: string | null
  displayName?: string | null
  title?: string | null
  firstName?: string | null
  lastName?: string | null
  chatType?: string
}

/** The fields of an mtcute Message that Ack reads. */
export interface MsgLike {
  id: number
  isOutgoing: boolean
  isService: boolean
  text: string
  date: Date
  chat: PeerLike
  sender: PeerLike
  markup: { type: string; buttons?: unknown[][] } | null
  media: unknown
  richMessage?: unknown
}

const at = (s: string) => (s.startsWith('@') ? s : `@${s}`)

/** A name we can show: never a bare numeric Telegram id, even when the peer is incomplete. */
const usable = (s?: string | null): s is string => typeof s === 'string' && !!s.trim() && !/^[-+]?\d+$/.test(s.trim())

const kindLabel = (p: PeerLike) => p.isBot ? 'Bot' : p.type === 'user' ? 'User' : p.chatType === 'channel' ? 'Channel' : p.type === 'chat' ? 'Group' : 'Chat'

/** Best display name for a peer, bots included, as Telegram shows it; @username, then a readable fallback, never an id. */
export function nameOf(p: PeerLike): string {
  const full = usable(p.firstName) ? `${p.firstName!.trim()}${usable(p.lastName) ? ` ${p.lastName!.trim()}` : ''}` : ''
  const name = [p.displayName, p.title, full].find(usable)
  if (name) return name.trim()
  if (usable(p.username)) return at(p.username!.trim())
  return `${kindLabel(p)} ${Math.abs(p.id)}`
}

/**
 * The message a followed chat is waiting on: its newest one, and only if it came from them.
 * `msgs` is newest first (mtcute getHistory). Once I answered, nothing is waiting.
 */
export function waitingIn<T extends { isOutgoing: boolean; isService: boolean }>(msgs: T[]): T | undefined {
  const m = msgs.find(x => !x.isService)
  return m && !m.isOutgoing ? m : undefined
}

/** One official Telegram sponsored message, as the API terms (3.3) require clients to show in channels and bots. */
export interface Sponsored { random: Uint8Array; label: 'Sponsored' | 'Recommended'; title: string; text: string; button: string; url: string; info: string }

interface RawSponsored { _: string; recommended?: boolean; randomId: Uint8Array; url: string; title: string; message: string; buttonText: string; sponsorInfo?: string; additionalInfo?: string }

/** messages.getSponsoredMessages to what Ack shows. An empty answer means no ad. */
export function sponsoredFrom(r: { _: string; messages?: RawSponsored[] }): Sponsored[] {
  return (r.messages ?? []).filter(m => m._ === 'sponsoredMessage').map(m => ({
    random: m.randomId, label: m.recommended ? 'Recommended' : 'Sponsored', title: m.title, text: m.message,
    button: m.buttonText, url: m.url, info: [m.sponsorInfo, m.additionalInfo].filter(Boolean).join('\n'),
  }))
}

/** Telegram's own hosts open without a confirmation; any other link asks first (sponsored messages spec). */
const TG_HOSTS = /(^|\.)(telegram\.(org|me|dog)|t\.me|te\.?legra\.ph|graph\.org|fragment\.com|telesco\.pe)$/
export function adNeedsConfirm(url: string): boolean {
  try { return !TG_HOSTS.test(new URL(url).hostname) } catch { return true }
}

/** A channel's sponsored message as a lens card, right after that channel's post. */
export function adCard(chatId: number, channel: string, ad: Sponsored, now: number): Card {
  const id = [...ad.random].map(b => b.toString(16).padStart(2, '0')).join('')
  return {
    key: `ad:${chatId}:${id}`, chatId, msgId: 0, from: `${channel} · ${ad.label}`, isBot: true, readOnly: true,
    text: clean(`${ad.title}\n${ad.text}`), date: now, receivedAt: performance.now(), ad: ad.random,
    actions: [{ label: clean(ad.button) || 'Open', kind: 'phone', value: ad.url }, { label: 'OK', kind: 'dismiss' }],
  }
}

/**
 * A plain copy of a live mtcute Message. Its fields are prototype getters, so `{ ...m }` would copy none
 * of them. Names come from `names` (the dialogs already seen) when the live peer is partial.
 */
export function msgLike(m: MsgLike, names: (id: number) => string | undefined): MsgLike {
  const peer = (p: PeerLike): PeerLike => ({
    type: p.type, id: p.id, isBot: p.isBot, username: p.username, title: p.title, firstName: p.firstName,
    lastName: p.lastName, chatType: p.chatType, displayName: names(p.id) ?? p.displayName,
  })
  return {
    id: m.id, isOutgoing: m.isOutgoing, isService: m.isService, text: m.text, date: m.date, chat: peer(m.chat),
    sender: peer(m.sender), markup: m.markup, media: m.media, richMessage: m.richMessage,
  }
}

/** How long a bot question stays worth resurfacing on start. */
export const FRESH_MS = 48 * 3600_000

export interface SurfaceInput {
  kind: ChatKind
  incoming: boolean
  ageMs: number
  unread: number
  hasButtons: boolean
  followed: boolean
}

/**
 * Whether a dialog's last message goes to the lens. Followed people, groups and channels always
 * come, read or old: that is what the "On my glasses" switch means. Other chats only surface
 * fresh bot questions.
 */
export function shouldSurface(d: SurfaceInput): boolean {
  if (!d.incoming) return false
  if (d.followed) return true
  if (d.kind !== 'bot' || d.ageMs > FRESH_MS) return false
  return d.hasButtons || d.unread > 0
}

/**
 * Where a message id is unique. Private chats and basic groups share one id sequence (scope 0);
 * supergroups and channels each have their own, and their deletions name the channel.
 */
export const idScope = (chat: PeerLike): number => (chat.type === 'chat' && chat.chatType !== 'group' ? chat.id : 0)

/**
 * Which messages become cards:
 * - private chats with bots: always;
 * - private chats with people, groups and channels: only the ones the user picked (`follow`).
 * In groups, replies go back as a reply to the message. Channels are read-only.
 */
export function cardFrom(m: MsgLike, follow: number[], replies: Action[]): Card | null {
  if (m.isService) return null
  if (m.isOutgoing) return null
  const privateChat = m.chat.type === 'user'
  const privateBot = privateChat && !!m.chat.isBot
  if (!privateBot && !follow.includes(m.chat.id)) return null

  const channel = m.chat.type === 'chat' && m.chat.chatType === 'channel'
  const fromBot = !!m.sender.isBot
  const mk = m.markup
  const buttons = mk?.type === 'inline' ? fromInline((mk.buttons ?? []) as RawButton[][])
    : mk?.type === 'reply' ? fromReply((mk.buttons ?? []) as RawButton[][])
    : []
  const actions = buttons.length || fromBot || channel ? buttons : replies

  const media = (m.media as { type?: string } | null)?.type
  const text = clean(m.text) || (media ? `[${media}]` : m.richMessage ? '[rich message, open it on your phone]' : '')
  const sender = m.sender.id === m.chat.id ? '' : nameOf(m.sender)
  const from = privateChat ? nameOf(m.chat) : sender ? `${sender} · ${nameOf(m.chat)}` : nameOf(m.chat)

  return {
    key: `${m.chat.id}:${m.id}`,
    chatId: m.chat.id,
    msgId: m.id,
    from,
    isBot: fromBot || channel,
    text,
    date: m.date.getTime(),
    actions,
    receivedAt: performance.now(),
    ...(privateChat ? {} : channel ? { readOnly: true } : { replyTo: m.id }),
  }
}

/** What a message says in one line, for chat list previews and media-only messages. */
export function preview(m: Pick<MsgLike, 'text' | 'media' | 'richMessage'> & Partial<MsgLike>): string {
  const media = (m.media as { type?: string } | null)?.type
  return m.text || (media ? `[${media}]` : m.richMessage ? '[rich message]' : '')
}

/** A message for the phone's chat view, with its buttons ready to press. */
export function bubbleFrom(m: MsgLike): Bubble {
  const raw = ((m.markup?.type === 'inline' || m.markup?.type === 'reply') ? (m.markup.buttons ?? []) : []) as RawButton[][]
  const actions = m.markup?.type === 'inline' ? fromInline(raw) : m.markup?.type === 'reply' ? fromReply(raw) : []
  const labels = raw.flat().map(b => b.text)
  const privateChat = m.chat.type === 'user'
  const channel = m.chat.type === 'chat' && m.chat.chatType === 'channel'
  const from = privateChat || channel || m.isOutgoing || m.sender.id === m.chat.id ? '' : nameOf(m.sender)
  return {
    id: m.id,
    out: m.isOutgoing,
    from,
    text: preview(m),
    date: m.date.getTime(),
    buttons: actions.map((action, i) => ({ label: labels[i] ?? action.label, action })),
    card: {
      key: `${m.chat.id}:${m.id}`, chatId: m.chat.id, msgId: m.id, from: nameOf(m.chat), isBot: !!m.sender.isBot || channel,
      text: clean(m.text), date: m.date.getTime(), actions, receivedAt: 0,
      ...(privateChat ? {} : channel ? { readOnly: true } : { replyTo: m.id }),
    },
  }
}
