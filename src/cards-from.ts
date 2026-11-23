// A Telegram message to a card. Kept apart from the client so it is tested without a connection.
import { clean, fromInline, fromReply, type Action, type Card, type RawButton } from './cards'

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
}

const nameOf = (p: PeerLike) => (p.isBot ? `@${p.username ?? p.displayName}` : p.displayName)

/**
 * Which messages become cards:
 * - private chats with bots: always;
 * - private chats with people, groups and channels: only the ones the user picked (`follow`).
 * In groups, replies go back as a reply to the message. Channels are read-only.
 */
export function cardFrom(m: MsgLike, follow: number[], replies: Action[]): Card | null {
  if (m.isOutgoing || m.isService) return null
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
