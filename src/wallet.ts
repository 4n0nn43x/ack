// Gram, Telegram's native TON wallet: money received and connection requests as lens cards,
// and a read-only view of the balance. Ack never signs or sends anything from the wallet.
import { clean, type Card } from './cards'
import type { MsgLike } from './cards-from'

export interface WalletTx { id: string; incoming: boolean; amount: string; peer: string; comment: string; date: number; failed: boolean }
export interface WalletView { balance: string; address: string; txs: WalletTx[] }

const NANO = 1_000_000_000n

/** Nano-GRAM (a TL Long, a bigint or a digit string) to an exact decimal: 12500000000 -> "12.5". */
export function gram(nano: { toString(): string } | bigint): string {
  const n = BigInt(nano.toString())
  const abs = n < 0n ? -n : n
  const whole = (abs / NANO).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = (abs % NANO).toString().padStart(9, '0').replace(/0+$/, '')
  return `${n < 0n ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/** A TON address shortened for one line: UQBpx...9xKa. */
export const shortAddress = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a)

type Base = Pick<Card, 'key' | 'chatId' | 'msgId' | 'date'>

export function transferCard(base: Base, from: string, nano: { toString(): string } | bigint, comment?: string, encrypted = false): Card {
  const note = encrypted ? 'Private note: read it in Telegram.' : comment ? `"${clean(comment)}"` : ''
  return {
    ...base, from, isBot: false, wallet: true, receivedAt: performance.now(),
    text: `Sent you ${gram(nano)} GRAM${note ? `\n${note}` : ''}`,
    actions: [{ label: 'Say thanks', kind: 'text', value: 'Thanks!' }, { label: 'OK', kind: 'dismiss' }],
  }
}

/** A dApp asks to connect to the wallet. Approving means signing, which stays in Telegram on the phone. */
export function tonConnectCard(base: Base, dapp: string | undefined, expiresMs: number, now: number): Card {
  const mins = Math.max(1, Math.round((expiresMs - now) / 60_000))
  return {
    ...base, from: 'Gram wallet', isBot: true, wallet: true, receivedAt: performance.now(),
    text: `${clean(dapp || 'An app')} asks to connect to your wallet.\nExpires in ${mins} min. Accept only if you started it.`,
    actions: [{ label: 'Review on my phone', kind: 'phone' }, { label: 'OK', kind: 'dismiss' }],
  }
}

interface RawAction {
  _: string
  amount?: { toString(): string }
  comment?: string
  commentEncrypted?: boolean
  accepted?: boolean
  declined?: boolean
  expires?: number
  dappName?: string
}

const actionOf = (m: MsgLike) => (m.raw as { action?: RawAction } | undefined)?.action

/** Wallet service messages as cards: money I received in a private chat, and open TonConnect requests. */
export function walletCard(m: MsgLike, now: number): Card | null {
  const a = actionOf(m)
  if (!a) return null
  const base = { key: `${m.chat.id}:${m.id}`, chatId: m.chat.id, msgId: m.id, date: m.date.getTime() }
  if (a._ === 'messageActionGramTransfer') {
    if (m.isOutgoing || m.chat.type !== 'user' || !a.amount) return null
    return transferCard(base, m.chat.displayName, a.amount, a.comment, a.commentEncrypted)
  }
  if (a._ === 'messageActionWalletTonConnectRequest') {
    const expires = (a.expires ?? 0) * 1000
    if (a.accepted || a.declined || expires <= now) return null
    return tonConnectCard(base, a.dappName, expires, now)
  }
  return null
}

/** What a wallet service message says in one line (chat list previews, chat view). */
export function walletLine(m: MsgLike): string | null {
  const a = actionOf(m)
  if (a?._ !== 'messageActionGramTransfer' || !a.amount) return null
  const note = a.comment && !a.commentEncrypted ? ` · ${a.comment}` : ''
  return `${m.isOutgoing ? 'You sent' : 'Sent you'} ${gram(a.amount)} GRAM${note}`
}

interface RawUser { id: number; firstName?: string | null; lastName?: string | null; username?: string | null }
interface RawPeer { _: string; userId?: number; address?: string; domain?: string; providerName?: string }
interface RawTx { id: string; incoming?: boolean; failed?: boolean; amount: { toString(): string }; date: number; comment?: string; commentEncrypted?: boolean; peer: RawPeer }

/** wallet.getState and wallet.getTransactions to the read-only view shown on the lens and the phone. */
export function walletFrom(state: { _: string; address?: string; balance?: { toString(): string } }, txs: { transactions: RawTx[]; users: RawUser[] } | null): WalletView | null {
  if (state._ !== 'walletState' || !state.address || !state.balance) return null
  const users = new Map((txs?.users ?? []).map(u => [u.id, [u.firstName, u.lastName].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : '')]))
  const peer = (p: RawPeer): string => {
    if (p._ === 'walletTransactionPeerUser') return users.get(p.userId ?? 0) || p.domain || shortAddress(p.address ?? '')
    if (p._ === 'walletTransactionPeerOnramp') return p.providerName ?? 'Top-up'
    if (p._ === 'walletTransactionPeerTelegramGift') return 'Telegram gift'
    return p.domain || (p.address ? shortAddress(p.address) : 'Unknown')
  }
  return {
    balance: gram(state.balance),
    address: state.address,
    txs: (txs?.transactions ?? []).map(t => ({
      id: t.id, incoming: !!t.incoming, amount: gram(t.amount), peer: peer(t.peer),
      comment: t.comment && !t.commentEncrypted ? t.comment : '', date: t.date * 1000, failed: !!t.failed,
    })),
  }
}
