import { describe, expect, it } from 'vitest'
import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'
import { App, type Source } from '../src/app'
import { layout, parseEvent, toPayload, type Page } from '../src/glasses'

describe('parseEvent', () => {
  it('reads a missing eventType as a click (protobuf drops zeros)', () => {
    expect(parseEvent({ sysEvent: { eventSource: 1 } } as never)).toEqual({ type: 'click', ring: false })
    expect(parseEvent({ sysEvent: { eventType: 3, eventSource: 2 } } as never)).toEqual({ type: 'double', ring: true })
  })

  it('reads list selections, index 0 included', () => {
    expect(parseEvent({ listEvent: { containerID: 3 } } as never)).toEqual({ type: 'select', index: 0 })
    expect(parseEvent({ listEvent: { currentSelectItemIndex: 2 } } as never)).toEqual({ type: 'select', index: 2 })
  })

  it('reads long press, scrolls, menu, audio and exits', () => {
    expect(parseEvent({ sysEvent: { eventType: 9 } } as never)).toEqual({ type: 'longStart' })
    expect(parseEvent({ sysEvent: { eventType: 10 } } as never)).toEqual({ type: 'longEnd' })
    expect(parseEvent({ textEvent: { eventType: 1 } } as never)).toEqual({ type: 'up' })
    expect(parseEvent({ menuItemClickEvent: { itemID: 2 } } as never)).toEqual({ type: 'menu', id: 2 })
    expect(parseEvent({ sysEvent: { eventType: 7 } } as never)).toEqual({ type: 'exit' })
    const pcm = new Uint8Array(4)
    expect(parseEvent({ audioEvent: { audioPcm: pcm } } as never)).toEqual({ type: 'pcm', pcm })
  })

  it('ignores what it does not use', () => {
    expect(parseEvent({ sysEvent: { eventType: 8 } } as never)).toBeNull()
    expect(parseEvent({} as never)).toBeNull()
  })
})

// Every page Ack can show must pass the SDK's own validator (z-order, menu, brightness).
describe('every page passes SDK validation', () => {
  const src: Source = { kind: 'demo', press: async () => ({}), send: async () => {}, bots: async () => [{ id: 1, name: '@a' }], commands: async () => [{ command: 'go', description: 'Go' }] }
  const pages: Page[] = []
  const app = new App({ draw: async p => { pages.push(p); return true }, exit() {}, now: () => 0, perf: () => 0, later: () => () => {} }, { instant: [], muted: {}, replies: ['Yes'] })

  it('root, card, confirm, pending, read, menu', async () => {
    app.render()
    app.setSource(src)
    app.upsert({ key: '1:1', chatId: 1, msgId: 1, from: '@bot', isBot: true, text: 'x '.repeat(400), date: 0, receivedAt: 0, actions: [{ label: 'Go', kind: 'callback', style: 'danger' }, { label: 'Wait', kind: 'callback' }] })
    app.input({ type: 'select', index: 1 })
    app.input({ type: 'double', ring: false })
    app.input({ type: 'select', index: 0 })
    app.input({ type: 'select', index: 2 })
    // The sidebar with all four sections, and a section list.
    app.setSource(null) // back to the empty lens
    app.setSource({ ...src, followed: async () => [{ id: 2, name: 'Alex', kind: 'person' }, { id: -3, name: 'Team', kind: 'group' }, { id: -4, name: 'News', kind: 'channel' }] })
    app.input({ type: 'click', ring: false })
    await new Promise(r => setTimeout(r, 0))
    app.input({ type: 'down' })
    app.input({ type: 'click', ring: false })
    expect(pages.some(p => p.texts.some(x => x.name === 'side3'))).toBe(true)
    for (const p of pages) {
      const payload = toPayload(p)
      expect(validateEvenHubPageContainer(payload as never), JSON.stringify(p).slice(0, 200)).toEqual({ valid: true })
      const capture = [...payload.textObject, ...payload.listObject].filter(c => c.isEventCapture === 1)
      expect(capture).toHaveLength(1)
      for (const t of payload.textObject) expect((t.content ?? '').length).toBeLessThanOrEqual(1000)
      for (const c of [...payload.textObject, ...payload.listObject]) {
        expect((c.containerName ?? '').length).toBeLessThanOrEqual(16)
        expect(c.yPosition! + c.height!).toBeLessThanOrEqual(288)
      }
    }
    expect(pages.length).toBeGreaterThan(4)
  })
})

describe('layout', () => {
  it('same structure with new text means an in-place update', () => {
    const a: Page = { texts: [{ name: 'main', x: 0, y: 0, w: 10, h: 10, text: 'Sending in 1.5 s', color: 4 }] }
    const b: Page = { texts: [{ name: 'main', x: 0, y: 0, w: 10, h: 10, text: 'Sending in 1.2 s', color: 3 }] }
    expect(layout(a)).toBe(layout(b))
    expect(layout(a)).not.toBe(layout({ ...a, list: { name: 'l', x: 0, y: 0, w: 1, h: 1, items: ['x'] } }))
  })
})
