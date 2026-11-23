import { describe, expect, it } from 'vitest'
import { cardFrom, preview, type MsgLike } from '../src/cards-from'
import { gram, shortAddress, walletCard, walletFrom } from '../src/wallet'

const NOW = 1_800_000_000_000
const alex = { type: 'user', id: 20, isBot: false, username: 'alex', displayName: 'Alex' }
const walletChat = { type: 'user', id: 777, isBot: false, username: 'wallet', displayName: 'Wallet' }
const team = { type: 'chat', id: -100500, displayName: 'Dev team', chatType: 'supergroup' }

const service = (action: Record<string, unknown>, over: Partial<MsgLike> = {}): MsgLike => ({
  id: 9, isOutgoing: false, isService: true, text: '', date: new Date(NOW - 60_000),
  chat: alex, sender: alex, markup: null, media: null, raw: { _: 'messageService', action }, ...over,
})
const transfer = (extra: Record<string, unknown> = {}) => ({ _: 'messageActionGramTransfer', amount: 25_000_000_000n, peerAddress: 'UQ...', transactionId: 't1', ...extra })
const tonConnect = (extra: Record<string, unknown> = {}) => ({ _: 'messageActionWalletTonConnectRequest', sessionId: 1n, expires: (NOW + 5 * 60_000) / 1000, dappName: 'STON.fi', ...extra })

describe('gram amounts stay exact', () => {
  it('converts nano-GRAM without floating point', () => {
    expect(gram(12_500_000_000n)).toBe('12.5')
    expect(gram(1n)).toBe('0.000000001')
    expect(gram('1000000000000')).toBe('1,000')
    expect(gram(-3_200_000_000n)).toBe('-3.2')
    expect(gram({ toString: () => '123456789012345678' })).toBe('123,456,789.012345678')
  })

  it('shortens addresses to one line', () => {
    expect(shortAddress('UQBpx4qZr8vN0n7sHk2xY1cWf3eD9aLmP0tQ9xKa')).toBe('UQBpx4...9xKa')
  })
})

describe('money received', () => {
  it('a transfer in a private chat becomes a card with its note, and thanks can be sent', () => {
    const c = walletCard(service(transfer({ comment: 'Zuma, my share 🍣' })), NOW)!
    expect(c).toMatchObject({ key: '20:9', from: 'Alex', isBot: false, text: 'Sent you 25 GRAM\n"Zuma, my share"' })
    expect(c.actions.map(a => [a.label, a.kind])).toEqual([['Say thanks', 'text'], ['OK', 'dismiss']])
  })

  it('an encrypted note is never shown on the lens', () => {
    expect(walletCard(service(transfer({ comment: 'secret', commentEncrypted: true })), NOW)!.text).toBe('Sent you 25 GRAM\nPrivate note: read it in Telegram.')
  })

  it('money I sent, or a transfer outside a private chat, is not a card', () => {
    expect(walletCard(service(transfer(), { isOutgoing: true }), NOW)).toBeNull()
    expect(walletCard(service(transfer(), { chat: team }), NOW)).toBeNull()
  })

  it('goes through cardFrom without following the chat, and previews in one line', () => {
    expect(cardFrom(service(transfer()), [], [])?.text).toBe('Sent you 25 GRAM')
    expect(preview(service(transfer({ comment: 'dinner' })))).toBe('Sent you 25 GRAM · dinner')
    expect(preview(service(transfer(), { isOutgoing: true }))).toBe('You sent 25 GRAM')
  })
})

describe('connection requests', () => {
  it('an open TonConnect request warns on the lens and sends the decision to the phone', () => {
    const c = walletCard(service(tonConnect(), { chat: walletChat, sender: walletChat }), NOW)!
    expect(c.from).toBe('Gram wallet')
    expect(c.text).toBe('STON.fi asks to connect to your wallet.\nExpires in 5 min. Accept only if you started it.')
    expect(c.actions.map(a => [a.label, a.kind])).toEqual([['Review on my phone', 'phone'], ['OK', 'dismiss']])
  })

  it('answered or expired requests stay off the lens', () => {
    expect(walletCard(service(tonConnect({ accepted: true })), NOW)).toBeNull()
    expect(walletCard(service(tonConnect({ declined: true })), NOW)).toBeNull()
    expect(walletCard(service(tonConnect({ expires: (NOW - 1000) / 1000 })), NOW)).toBeNull()
  })

  it('other service messages are not cards', () => {
    expect(walletCard(service({ _: 'messageActionChatJoinedByLink' }), NOW)).toBeNull()
  })
})

describe('the read-only wallet view', () => {
  it('maps balance and transactions, naming people, top-ups and plain addresses', () => {
    const w = walletFrom(
      { _: 'walletState', address: 'UQBpx4qZr8vN0n7sHk2xY1cWf3eD9aLmP0tQ9xKa', balance: 142_750_000_000n },
      {
        users: [{ id: 20, firstName: 'Alex', lastName: 'Martin' }],
        transactions: [
          { id: 'a', incoming: true, amount: 25_000_000_000n, date: 1_800_000_000, comment: 'Zuma', peer: { _: 'walletTransactionPeerUser', userId: 20, address: 'UQ...' } },
          { id: 'b', amount: 3_200_000_000n, date: 1_799_990_000, peer: { _: 'walletTransactionPeerAddress', address: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', domain: 'ston.fi' } },
          { id: 'c', incoming: true, amount: 50_000_000_000n, date: 1_799_900_000, comment: 'hidden', commentEncrypted: true, peer: { _: 'walletTransactionPeerOnramp', address: 'UQ...', providerName: 'MoonPay' } },
        ],
      },
    )!
    expect(w.balance).toBe('142.75')
    expect(w.txs.map(t => [t.incoming, t.amount, t.peer, t.comment])).toEqual([
      [true, '25', 'Alex Martin', 'Zuma'],
      [false, '3.2', 'ston.fi', ''],
      [true, '50', 'MoonPay', ''],
    ])
    expect(w.txs[0].date).toBe(1_800_000_000_000)
  })

  it('no wallet yet: nothing to show', () => {
    expect(walletFrom({ _: 'walletStateEmpty' }, null)).toBeNull()
  })
})
