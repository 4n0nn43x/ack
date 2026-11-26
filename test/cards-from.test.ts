import { describe, expect, it } from 'vitest'
import { adCard, adNeedsConfirm, bubbleFrom, cardFrom, idScope, nameOf, preview, shouldSurface, sponsoredFrom, waitingIn, type MsgLike } from '../src/cards-from'
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

describe('names on the lens', () => {
  it('never shows a bare id when a peer has no usable display name', () => {
    expect(nameOf({ type: 'user', id: 42, displayName: '12345' })).toBe('User 42')
    expect(nameOf({ type: 'chat', id: -100500, displayName: '98765', chatType: 'supergroup' })).toBe('Group 100500')
    expect(nameOf({ type: 'user', id: 42 })).toBe('User 42')
  })

  it('falls back to the username or the first and last name', () => {
    expect(nameOf({ type: 'user', id: 42, displayName: '12345', username: 'alex' })).toBe('@alex')
    expect(nameOf({ type: 'user', id: 42, displayName: '', firstName: 'Alex', lastName: 'Dupont' })).toBe('Alex Dupont')
    expect(nameOf({ type: 'user', id: 10, isBot: true, displayName: '12345', username: 'ci_bot' })).toBe('@ci_bot')
    expect(nameOf({ type: 'user', id: 10, isBot: true, displayName: 'CI' })).toBe('@CI')
  })

  it('keeps group headers readable on cards when peers are incomplete', () => {
    const c = cardFrom(msg({
      chat: { type: 'chat', id: -100500, displayName: '98765', chatType: 'supergroup' },
      sender: { type: 'user', id: 42, displayName: '12345' },
    }), [-100500], me)!
    expect(c.from).toBe('User 42 · Group 100500')
  })
})

describe('which dialogs come back on start', () => {
  const base = { incoming: true, ageMs: 1000, unread: 0, hasButtons: false, followed: false }

  it('a fresh bot question comes through', () => {
    expect(shouldSurface({ ...base, kind: 'bot', hasButtons: true })).toBe(true)
  })

  it('an old bot question does not', () => {
    expect(shouldSurface({ ...base, kind: 'bot', hasButtons: true, ageMs: 49 * 3600_000 })).toBe(false)
  })

  it('a person already read still comes when followed', () => {
    expect(shouldSurface({ ...base, kind: 'person', followed: true })).toBe(true)
  })

  it('an old group still comes when followed', () => {
    expect(shouldSurface({ ...base, kind: 'group', followed: true, ageMs: 30 * 24 * 3600_000 })).toBe(true)
  })

  it('an unfollowed channel never comes', () => {
    expect(shouldSurface({ ...base, kind: 'channel', unread: 5 })).toBe(false)
  })

  it('my own last message never comes', () => {
    expect(shouldSurface({ ...base, kind: 'person', followed: true, incoming: false })).toBe(false)
  })
})

describe('what a followed chat is waiting on', () => {
  const m = (id: number, isOutgoing: boolean, isService = false) => ({ id, isOutgoing, isService })

  it('their newest message, when it is theirs', () => {
    expect(waitingIn([m(3, false), m(2, false), m(1, true)])?.id).toBe(3)
  })

  it('nothing once I answered, even from the phone', () => {
    expect(waitingIn([m(3, true), m(2, false)])).toBeUndefined()
  })

  it('looks past service messages', () => {
    expect(waitingIn([m(4, false, true), m(3, false)])?.id).toBe(3)
    expect(waitingIn([m(4, false, true), m(3, true)])).toBeUndefined()
  })
})

describe('Telegram sponsored messages (API terms 3.3)', () => {
  const raw = (over = {}) => ({ _: 'sponsoredMessage', randomId: new Uint8Array([1, 2, 255]), url: 'https://t.me/durov', title: 'Durov', message: 'Ads on Telegram', buttonText: 'Open channel', ...over })

  it('reads the ads, and none from an empty answer', () => {
    expect(sponsoredFrom({ _: 'messages.sponsoredMessagesEmpty' })).toEqual([])
    const [ad] = sponsoredFrom({ _: 'messages.sponsoredMessages', messages: [raw({ sponsorInfo: 'Ad by X', additionalInfo: 'ERID 123' })] })
    expect(ad).toMatchObject({ label: 'Sponsored', title: 'Durov', button: 'Open channel', info: 'Ad by X\nERID 123' })
  })

  it('says Recommended instead of Sponsored when Telegram flags it', () => {
    expect(sponsoredFrom({ _: 'messages.sponsoredMessages', messages: [raw({ recommended: true })] })[0].label).toBe('Recommended')
  })

  it('opens Telegram links directly, asks before any other host', () => {
    expect(adNeedsConfirm('https://t.me/durov')).toBe(false)
    expect(adNeedsConfirm('https://fragment.com/username/ack')).toBe(false)
    expect(adNeedsConfirm('https://core.telegram.org/api')).toBe(false)
    expect(adNeedsConfirm('https://example.com/promo')).toBe(true)
    expect(adNeedsConfirm('https://t.me.evil.com/')).toBe(true)
    expect(adNeedsConfirm('not a url')).toBe(true)
  })

  it('becomes a read-only lens card labelled as an ad, never a button Ack presses', () => {
    const [ad] = sponsoredFrom({ _: 'messages.sponsoredMessages', messages: [raw()] })
    const c = adCard(-100, 'Durov News', ad, 5)
    expect(c).toMatchObject({ key: 'ad:-100:0102ff', from: 'Durov News · Sponsored', readOnly: true, text: 'Durov\nAds on Telegram' })
    expect(c.actions.map(a => a.kind)).toEqual(['phone', 'dismiss'])
    expect(c.ad).toBe(ad.random)
  })
})
