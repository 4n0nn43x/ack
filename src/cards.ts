// Cards: one Telegram message that waits for a decision, shaped for a 576x288 lens.
// Pure functions only, so every rule here is unit tested.
import { getAdvW, measureTextWrap, pxTruncate } from '@evenrealities/pretext'

export type Style = 'danger' | 'success' | 'primary'
export type ActionKind = 'callback' | 'text' | 'phone' | 'copy' | 'disabled' | 'dismiss'

export interface Action {
  label: string // cleaned for the G2 font
  kind: ActionKind
  style?: Style
  data?: Uint8Array // callback payload
  value?: string // text to send, text to copy, or the url to open on the phone
}

export interface Card {
  key: string // `${chatId}:${msgId}`
  chatId: number
  msgId: number
  from: string
  isBot: boolean
  text: string
  date: number // ms, when Telegram stamped the message
  actions: Action[]
  receivedAt: number // performance.now() when Ack received it, for latency
  replyTo?: number // in groups, answers go back as a reply to this message
  readOnly?: boolean // channels: nothing can be sent back
  ad?: Uint8Array // a channel's sponsored message (its random_id): the view is reported once shown
}

// Raw TL shapes from Telegram layer 233 (mtcute passes them through untouched).
export interface RawStyle { bgDanger?: boolean; bgSuccess?: boolean; bgPrimary?: boolean }
export interface RawButton {
  _: string
  text: string
  style?: RawStyle
  type?: { _: string; data?: Uint8Array; requiresPassword?: boolean; url?: string; copyText?: string }
}

const EMOJI_WORDS: Record<string, string> = {
  '✅': 'OK', '✔️': 'OK', '✔': 'OK', '☑️': 'OK', '👍': 'OK',
  '❌': 'No', '✖️': 'No', '🚫': 'No', '👎': 'No',
  '⚠️': '!', '⚠': '!', '❗': '!', '‼️': '!!',
  '🟢': '●', '🔴': '●', '🟡': '●', '🔵': '●', '⭐': '★', '⭐️': '★',
  '➡️': '→', '⬅️': '←', '⬆️': '↑', '⬇️': '↓', '🔙': '←', '«': '«', '»': '»',
}
const PICTO = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu

/** Makes text safe for the G2 font: known emoji become words, other pictographs go, digits never change. */
export function clean(text: string): string {
  let out = text
  for (const [emoji, word] of Object.entries(EMOJI_WORDS)) out = out.split(emoji).join(` ${word} `)
  return out
    .replace(PICTO, ' ')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Share of visible characters the glasses font cannot draw (Arabic, Thai...). */
export function missingGlyphRatio(text: string): number {
  const chars = [...text].filter(c => c.trim())
  if (!chars.length) return 0
  return chars.filter(c => getAdvW(c.codePointAt(0)!) === 0).length / chars.length
}

function styleOf(s?: RawStyle): Style | undefined {
  if (!s) return undefined
  if (s.bgDanger) return 'danger'
  if (s.bgSuccess) return 'success'
  if (s.bgPrimary) return 'primary'
  return undefined
}

/** Inline keyboard rows (keyboardInlineButton) to actions, in reading order. */
export function fromInline(rows: RawButton[][]): Action[] {
  return rows.flat().map(b => {
    const label = clean(b.text) || '(button)'
    const style = styleOf(b.style)
    const t = b.type?._ ?? ''
    if (t === 'inlineButtonTypeCallback' && !b.type?.requiresPassword) return { label, kind: 'callback', style, data: b.type?.data ?? new Uint8Array() }
    if (t === 'inlineButtonTypeCopy') return { label, kind: 'copy', style, value: b.type?.copyText ?? '' }
    if (t === 'inlineButtonTypeDisabled') return { label, kind: 'disabled', style }
    return { label, kind: 'phone', style, value: b.type?.url }
  })
}

/** Reply keyboard rows (keyboardButton): plain ones send their text, the rest need the phone. */
export function fromReply(rows: RawButton[][]): Action[] {
  return rows.flat().map(b => {
    const label = clean(b.text) || '(button)'
    const plain = !b.type || b.type._ === 'buttonTypeDefault'
    return plain ? { label, kind: 'text', style: styleOf(b.style), value: b.text } : { label, kind: 'phone', style: styleOf(b.style) }
  })
}

/**
 * Labels that commit something hard to undo, in English and French. Bots rarely mark such buttons as
 * danger (BotFather's Delete Bot and Transfer Ownership carry no style), so Ack reads the label too.
 */
const IRREVERSIBLE = /\b(delete|remove|erase|wipe|destroy|purge|revoke|reset|terminate|transfer|withdraw|pay|buy|sell|purchase|checkout|swap|stake|unstake|bet|liquidate|close (all|position)|deploy|roll ?back|ban|kick|block|leave|log ?out|sign out|supprimer|effacer|révoquer|réinitialiser|transférer|retirer|payer|acheter|vendre|bannir|exclure|bloquer|quitter|déconnecter)\b/i

/** A press that asks for an explicit yes first: marked danger by the bot, or irreversible by its label. */
export const needsYes = (a: Action) => a.style === 'danger' || ((a.kind === 'callback' || a.kind === 'text') && IRREVERSIBLE.test(a.label))

/** The bot's order is kept, except danger buttons always go last. */
export function order(actions: Action[]): Action[] {
  return [...actions.filter(a => a.style !== 'danger'), ...actions.filter(a => a.style === 'danger')]
}

const PREFIX: Record<string, string> = { danger: '▲ ', success: '● ', primary: '● ', phone: '◁ ', copy: '□ ', disabled: '○ ' }
const LIST_INNER_PX = 576 - 24 // list items have 12 px padding each side

/** One list row. Lists take 63 UTF-8 bytes per item at most. */
export function rowLabel(a: Action): string {
  const prefix = a.kind === 'phone' || a.kind === 'copy' || a.kind === 'disabled' ? PREFIX[a.kind] : needsYes(a) ? PREFIX.danger : PREFIX[a.style ?? ''] ?? ''
  return fitBytes(pxTruncate(prefix + a.label, LIST_INNER_PX), 63)
}

export function fitBytes(s: string, max: number): string {
  const enc = new TextEncoder()
  if (enc.encode(s).length <= max) return s
  let out = ''
  for (const ch of s) {
    if (enc.encode(out + ch + '...').length > max) break
    out += ch
  }
  return out + '...'
}

/** Cuts text to `lines` lines of `width` px. Words are never altered, only dropped from the end. */
export function fit(text: string, width: number, lines: number): { text: string; cut: boolean } {
  if (measureTextWrap(text, width).lineCount <= lines) return { text, cut: false }
  const words = text.split(/(\s+)/)
  let lo = 0
  let hi = words.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measureTextWrap(words.slice(0, mid).join('').trimEnd() + ' ...', width).lineCount <= lines) lo = mid
    else hi = mid - 1
  }
  return { text: words.slice(0, lo).join('').trimEnd() + ' ...', cut: true }
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

export const DEFAULT_REPLIES = ['Yes', 'On my way', 'Call you later']

export function replies(list: string[]): Action[] {
  return list.map(t => ({ label: clean(t), kind: 'text', value: t }))
}

const ORDINALS: Record<string, number> = { first: 0, one: 0, premier: 0, second: 1, two: 1, deuxieme: 1, third: 2, three: 2, troisieme: 2 }
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}%$.]+/gu, ' ').trim()

/** Which button a spoken phrase means: exact or contained label, an ordinal, or the best word overlap (at least half). */
export function match(spoken: string, actions: Action[]): Action | undefined {
  const s = norm(spoken)
  if (!s || !actions.length) return undefined
  const labels = actions.map(a => norm(a.label))
  const exact = labels.findIndex(l => l && (l === s || s.includes(l)))
  if (exact >= 0) return actions[exact]
  const words = new Set(s.split(' '))
  for (const w of words) if (w in ORDINALS && actions[ORDINALS[w]]) return actions[ORDINALS[w]]
  let best = -1
  let score = 0
  labels.forEach((l, i) => {
    const lw = l.split(' ').filter(Boolean)
    const hit = lw.filter(w => words.has(w)).length / Math.max(lw.length, 1)
    if (hit > score) { score = hit; best = i }
  })
  return score >= 0.5 ? actions[best] : undefined
}
