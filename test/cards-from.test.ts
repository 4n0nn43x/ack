import { describe, expect, it } from 'vitest'
import { bubbleFrom, cardFrom, idScope, preview, type MsgLike } from '../src/cards-from'
import { replies } from '../src/cards'

const me = replies(['Yes', 'Later'])
const bot = { type: 'user', id: 10, isBot: true, username: 'ci_bot', displayName: 'CI' }
const alex = { type: 'user', id: 20, isBot: false, username: 'alex', displayName: 'Alex' }
const team = { type: 'chat', id: -100500, displayName: 'Dev team', chatType: 'supergroup' }
const news = { type: 'chat', id: -100900, displayName: 'Crypto News', chatType: 'channel' }
const inline = { type: 'inline', buttons: [[{ _: 'keyboardInlineButton', text: '✅ Deploy', style: { bgDanger: true }, type: { _: 'inlineButtonTypeCallback', data: new Uint8Array([1]) } }]] }

const msg = (over: Partial<MsgLike>): MsgLike => ({
  id: 7, isOutgoing: false, isService: false, text: 'Deploy v2?', date: new Date(1_700_000_000_000),
  chat: bot, sender: bot, markup: null, media: null, ...over,
})

describe('which messages become cards', () => {
  it('a private bot always comes, with its buttons', () => {
    const c = cardFrom(msg({ markup: inline }), [], me)!
    expect(c).toMatchObject({ key: '10:7', from: '@ci_bot', isBot: true, text: 'Deploy v2?' })
    expect(c.actions.map(a => [a.label, a.style])).toEqual([['OK Deploy', 'danger']])
    expect(c.replyTo).toBeUndefined()
  })

  it('a private bot without buttons still comes (OK card)', () => {
    expect(cardFrom(msg({}), [], me)!.actions).toEqual([])
  })

  it('people only when picked, with quick replies', () => {
    expect(cardFrom(msg({ chat: alex, sender: alex }), [], me)).toBeNull()
    const c = cardFrom(msg({ chat: alex, sender: alex, text: 'Still on for 7pm?' }), [20], me)!
    expect(c).toMatchObject({ from: 'Alex', isBot: false })
    expect(c.actions.map(a => a.label)).toEqual(['Yes', 'Later'])
  })

  it('groups only when picked; answers go back as a reply', () => {
    expect(cardFrom(msg({ chat: team, sender: bot, markup: inline }), [], me)).toBeNull()
    const fromBot = cardFrom(msg({ chat: team, sender: bot, markup: inline }), [-100500], me)!
    expect(fromBot).toMatchObject({ key: '-100500:7', chatId: -100500, from: '@ci_bot · Dev team', isBot: true, replyTo: 7 })
    const fromAlex = cardFrom(msg({ chat: team, sender: alex, text: 'Who reviews #412?' }), [-100500], me)!
    expect(fromAlex).toMatchObject({ from: 'Alex · Dev team', isBot: false, replyTo: 7 })
    expect(fromAlex.actions.map(a => a.label)).toEqual(['Yes', 'Later'])
  })

  it('channels are read-only and named after the channel', () => {
    const c = cardFrom(msg({ chat: news, sender: news, text: 'ETH ETF approved' }), [-100900], me)!
    expect(c).toMatchObject({ from: 'Crypto News', isBot: true, readOnly: true, actions: [] })
    expect(c.replyTo).toBeUndefined()
  })

  it('ignores my own messages and service messages', () => {
    expect(cardFrom(msg({ isOutgoing: true }), [], me)).toBeNull()
    expect(cardFrom(msg({ isService: true }), [], me)).toBeNull()
  })

  it('names media and rich messages instead of showing nothing', () => {
    expect(cardFrom(msg({ text: '', media: { type: 'photo' } }), [], me)!.text).toBe('[photo]')
    expect(cardFrom(msg({ text: '', richMessage: {} }), [], me)!.text).toContain('rich message')
  })
})

describe('deleted messages find the right card', () => {
  it('private chats and basic groups share one id sequence, supergroups and channels have their own', () => {
    expect(idScope(bot)).toBe(0)
    expect(idScope(alex)).toBe(0)
    expect(idScope({ type: 'chat', id: -42, displayName: 'Family', chatType: 'group' })).toBe(0)
    expect(idScope(team)).toBe(-100500)
    expect(idScope(news)).toBe(-100900)
  })
})

describe('phone chat view', () => {
  it('keeps the original text and button labels, and the parsed action to press', () => {
    const b = bubbleFrom(msg({ text: 'Deploy v2? 🚀', markup: inline }))
    expect(b).toMatchObject({ id: 7, out: false, from: '', text: 'Deploy v2? 🚀' })
    expect(b.buttons.map(x => [x.label, x.action.kind, x.action.style])).toEqual([['✅ Deploy', 'callback', 'danger']])
    expect(b.card).toMatchObject({ key: '10:7', chatId: 10, msgId: 7, isBot: true })
  })

  it('names the sender in groups and answers there as a reply', () => {
    const b = bubbleFrom(msg({ chat: team, sender: alex }))
    expect(b.from).toBe('Alex')
    expect(b.card.replyTo).toBe(7)
  })

  it('my own messages have no sender line', () => {
    expect(bubbleFrom(msg({ chat: team, sender: alex, isOutgoing: true }))).toMatchObject({ out: true, from: '' })
  })

  it('previews media and rich messages in one line', () => {
    expect(preview({ text: '', media: { type: 'voice' }, richMessage: undefined })).toBe('[voice]')
    expect(preview({ text: '', media: null, richMessage: {} })).toBe('[rich message]')
  })
})
