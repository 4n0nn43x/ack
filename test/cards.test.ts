import { describe, expect, it } from 'vitest'
import { measureTextWrap } from '@evenrealities/pretext'
import { ago, clean, fit, fitBytes, fromInline, fromReply, match, missingGlyphRatio, needsYes, order, rowLabel, type Action, type RawButton } from '../src/cards'

const cb = (text: string, style?: RawButton['style']): RawButton => ({ _: 'keyboardInlineButton', text, style, type: { _: 'inlineButtonTypeCallback', data: new TextEncoder().encode(text) } })

describe('clean', () => {
  it('turns known emoji into words and drops the rest', () => {
    expect(clean('✅ Confirm')).toBe('OK Confirm')
    expect(clean('❌ Cancel')).toBe('No Cancel')
    expect(clean('🚀 Deploy 🔥')).toBe('Deploy')
    expect(clean('👨‍👩‍👧 family')).toBe('family')
    expect(clean('🇫🇷 Paris')).toBe('Paris')
  })

  it('never changes a number, price, percentage, address or command', () => {
    const samples = [
      'ETH 5x LONG · liq. at 8% · PnL +312.45 $',
      'Send 1,250.00 USDT to UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG?',
      'Book 09:40 for $212 (ref #A7-99)',
      'Tap /confirm_123 or /move 23456 laeré',
      '0.000123 BTC ≈ €7.89',
    ]
    for (const s of samples) {
      const out = clean(`🟢 ${s} ✅`)
      for (const token of s.match(/[\d$€%#/.,:+≈A-Za-z_-]+/g)!) expect(out).toContain(token)
    }
  })

  it('keeps line breaks but collapses blank runs and spaces', () => {
    expect(clean('a   b\n\n\n\nc  ')).toBe('a b\n\nc')
  })
})

describe('buttons from Telegram layer 233', () => {
  it('reads callback, url, webview, copy, disabled and password buttons', () => {
    const rows: RawButton[][] = [
      [cb('Approve', { bgSuccess: true }), cb('Deny', { bgDanger: true })],
      [{ _: 'keyboardInlineButton', text: 'Docs', type: { _: 'inlineButtonTypeUrl', url: 'https://example.com/x' } }],
      [{ _: 'keyboardInlineButton', text: 'Open app', type: { _: 'inlineButtonTypeWebView', url: 'https://app' } }],
      [{ _: 'keyboardInlineButton', text: 'Copy code', type: { _: 'inlineButtonTypeCopy', copyText: '493021' } }],
      [{ _: 'keyboardInlineButton', text: 'Sold out', type: { _: 'inlineButtonTypeDisabled' } }],
      [{ _: 'keyboardInlineButton', text: 'Transfer', type: { _: 'inlineButtonTypeCallback', requiresPassword: true, data: new Uint8Array([1]) } }],
    ]
    const a = fromInline(rows)
    expect(a.map(x => [x.label, x.kind, x.style])).toEqual([
      ['Approve', 'callback', 'success'],
      ['Deny', 'callback', 'danger'],
      ['Docs', 'phone', undefined],
      ['Open app', 'phone', undefined],
      ['Copy code', 'copy', undefined],
      ['Sold out', 'disabled', undefined],
      ['Transfer', 'phone', undefined],
    ])
    expect(a[0].data).toEqual(new TextEncoder().encode('Approve'))
    expect(a[2].value).toBe('https://example.com/x')
    expect(a[4].value).toBe('493021')
  })

  it('reply keyboards send their exact text, special ones need the phone', () => {
    const a = fromReply([[{ _: 'keyboardButton', text: '✅ Yes', type: { _: 'buttonTypeDefault' } }, { _: 'keyboardButton', text: 'Share location', type: { _: 'buttonTypeRequestGeoLocation' } }]])
    expect(a).toEqual([
      { label: 'OK Yes', kind: 'text', style: undefined, value: '✅ Yes' },
      { label: 'Share location', kind: 'phone', style: undefined },
    ])
  })

  it('emoji-only labels stay visible', () => {
    expect(fromInline([[cb('👍')], [cb('🎉')]]).map(a => a.label)).toEqual(['OK', '(button)'])
  })
})

describe('order and rows', () => {
  it('keeps the bot order but sends danger buttons last', () => {
    const acts = fromInline([[cb('Delete', { bgDanger: true }), cb('Keep'), cb('Archive', { bgPrimary: true })]])
    expect(order(acts).map(a => a.label)).toEqual(['Keep', 'Archive', 'Delete'])
  })

  it('prefixes rows with glyphs the G2 font has', () => {
    const rows = order(fromInline([[cb('Go', { bgSuccess: true }), cb('Stop', { bgDanger: true }), cb('Maybe')]])).map(rowLabel)
    expect(rows).toEqual(['● Go', 'Maybe', '▲ Stop'])
    expect(rowLabel({ label: 'Site', kind: 'phone' })).toBe('◁ Site')
  })

  it('fits list rows into 63 UTF-8 bytes', () => {
    const long = '漢'.repeat(40)
    expect(new TextEncoder().encode(fitBytes(long, 63)).length).toBeLessThanOrEqual(63)
    expect(new TextEncoder().encode(rowLabel({ label: 'x'.repeat(200), kind: 'callback', style: 'danger' })).length).toBeLessThanOrEqual(63)
  })
})

describe('fit', () => {
  it('cuts long text to the line budget and marks it', () => {
    const text = 'word '.repeat(300).trim()
    const r = fit(text, 560, 4)
    expect(r.cut).toBe(true)
    expect(measureTextWrap(r.text, 560).lineCount).toBeLessThanOrEqual(4)
    expect(r.text.endsWith('...')).toBe(true)
  })

  it('leaves short text alone', () => {
    expect(fit('Deploy now?', 560, 4)).toEqual({ text: 'Deploy now?', cut: false })
  })
})

describe('misc', () => {
  it('formats ages', () => {
    expect(ago(5_000)).toBe('now')
    expect(ago(120_000)).toBe('2m')
    expect(ago(3 * 3600_000)).toBe('3h')
    expect(ago(2 * 86400_000)).toBe('2d')
  })

  it('spots text the glasses cannot draw', () => {
    expect(missingGlyphRatio('Hello there')).toBe(0)
    expect(missingGlyphRatio('مرحبا بك')).toBeGreaterThan(0.9)
  })
})

describe('voice match', () => {
  const acts: Action[] = ['Allow once', 'Always allow', 'Deny'].map(label => ({ label, kind: 'callback' as const }))
  it('finds the button behind a phrase', () => {
    expect(match('deny', acts)?.label).toBe('Deny')
    expect(match('yes allow once please', acts)?.label).toBe('Allow once')
    expect(match('the second one', acts)?.label).toBe('Always allow')
    expect(match('always', acts)?.label).toBe('Always allow')
  })
  it('returns nothing when unsure', () => {
    expect(match('what is the weather', acts)).toBeUndefined()
    expect(match('', acts)).toBeUndefined()
  })
  it('never presses the opposite of what was said', () => {
    expect(match("don't allow", acts)).toBeUndefined()
    expect(match('do not deny', acts)).toBeUndefined()
    expect(match('ne pas refuser', [{ label: 'Refuser', kind: 'callback' }])).toBeUndefined()
    expect(match('no', [{ label: 'Yes', kind: 'callback' }, { label: 'No', kind: 'callback' }])?.label).toBe('No')
  })
})

describe('presses that need an explicit yes', () => {
  const cb = (label: string, style?: 'danger'): Action => ({ label, kind: 'callback', style })

  it('irreversible labels, even when the bot marks nothing (BotFather does not)', () => {
    for (const l of ['Delete Bot', 'Transfer Ownership', 'Revoke current token', 'Withdraw 50 USDT', 'Supprimer le bot', 'Log out', 'Close all', 'Roll back'])
      expect(needsYes(cb(l)), l).toBe(true)
  })

  it('not everyday answers, so one tap stays one tap', () => {
    for (const l of ['« Back to Bot List', 'Allow once', 'Payments', 'API Token', 'Book $212', 'Mute 1 h', 'Approve', 'Staging only'])
      expect(needsYes(cb(l)), l).toBe(false)
  })

  it('whatever the label when the bot marks it danger, never for links the phone opens', () => {
    expect(needsYes(cb('Deny', 'danger'))).toBe(true)
    expect(needsYes({ label: 'Delete on the website', kind: 'phone' })).toBe(false)
  })
})
