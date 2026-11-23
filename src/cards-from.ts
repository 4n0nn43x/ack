// A Telegram message to a card (lens) or a bubble (phone). Kept apart from the client so it is tested without a connection.
import { clean, fromInline, fromReply, type Action, type Card, type RawButton } from './cards'
import { walletCard, walletLine } from './wallet'

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

interface PeerLike { type: string; id: number; isBot?: boolean; username?: string | null; displayName: string; chatType?: string }

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
  raw?: unknown // the TL message, read for wallet service actions
}

const nameOf = (p: PeerLike) => (p.isBot ? `@${p.username ?? p.displayName}` : p.displayName)

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
  if (m.isService) return walletCard(m, Date.now())
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
  const from = privateChat ? nameOf(m.chat) : sender ? `${sender} · ${m.chat.displayName}` : m.chat.displayName

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
  if (m.raw && m.isService) { const w = walletLine(m as MsgLike); if (w) return w }
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
