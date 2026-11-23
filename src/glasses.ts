// The lens: pages described as plain data, drawn through one serialized bridge queue.
import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerUpgrade,
  TextContainerProperty,
  type EvenAppBridge,
  type EvenHubEvent,
  AudioInputSource,
  MenuContainerProperty,
  MenuItemProperty,
} from '@evenrealities/even_hub_sdk'

export interface TextBox { name: string; x: number; y: number; w: number; h: number; text: string; color?: number; capture?: boolean; pad?: number }
export interface ListBox { name: string; x: number; y: number; w: number; h: number; items: string[] }
export interface Page { texts: TextBox[]; list?: ListBox; menu?: { id: number; label: string }[] }

export type Input =
  | { type: 'click' | 'double'; ring: boolean }
  | { type: 'up' | 'down' | 'longStart' | 'longEnd' | 'foreground' | 'exit' }
  | { type: 'select'; index: number }
  | { type: 'menu'; id: number }
  | { type: 'pcm'; pcm: Uint8Array }

const RING = 2 // EventSourceType.TOUCH_EVENT_FROM_RING

/** One SDK event to one input. Protobuf drops zero values, so a missing eventType is a click. */
export function parseEvent(e: EvenHubEvent): Input | null {
  if (e.audioEvent?.audioPcm) return { type: 'pcm', pcm: e.audioEvent.audioPcm }
  if (e.menuItemClickEvent) return { type: 'menu', id: e.menuItemClickEvent.itemID ?? 0 }
  if (e.listEvent) {
    const t = e.listEvent.eventType ?? OsEventTypeList.CLICK_EVENT
    if (t === OsEventTypeList.CLICK_EVENT) return { type: 'select', index: e.listEvent.currentSelectItemIndex ?? 0 }
    if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) return { type: 'double', ring: false }
    return null
  }
  if (e.textEvent) {
    const t = e.textEvent.eventType ?? OsEventTypeList.CLICK_EVENT
    if (t === OsEventTypeList.SCROLL_TOP_EVENT) return { type: 'up' }
    if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) return { type: 'down' }
    if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) return { type: 'double', ring: false }
    if (t === OsEventTypeList.CLICK_EVENT) return { type: 'click', ring: false }
    return null
  }
  if (e.sysEvent) {
    const s = e.sysEvent
    const ring = s.eventSource === RING
    switch (s.eventType ?? OsEventTypeList.CLICK_EVENT) {
      case OsEventTypeList.CLICK_EVENT: return { type: 'click', ring }
      case OsEventTypeList.DOUBLE_CLICK_EVENT: return { type: 'double', ring }
      case OsEventTypeList.LONG_PRESS_EVENT: return { type: 'longStart' }
      case OsEventTypeList.LONG_PRESS_RELEASE_EVENT: return { type: 'longEnd' }
      case OsEventTypeList.FOREGROUND_ENTER_EVENT: return { type: 'foreground' }
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
      case OsEventTypeList.ABNORMAL_EXIT_EVENT: return { type: 'exit' }
    }
  }
  return null
}

/** Page to SDK payload. Text boxes get ids 1..n, the list n+1. Exactly one container captures input. */
export function toPayload(page: Page) {
  const textObject = page.texts.map((t, i) => new TextContainerProperty({
    xPosition: t.x, yPosition: t.y, width: t.w, height: t.h,
    borderWidth: 0, borderColor: 0, paddingLength: t.pad ?? 0,
    containerID: i + 1, containerName: t.name,
    content: t.text.slice(0, 999) || ' ',
    textColor: t.color ?? 4,
    isEventCapture: !page.list && t.capture ? 1 : 0,
  }))
  const l = page.list
  const listObject = l ? [new ListContainerProperty({
    xPosition: l.x, yPosition: l.y, width: l.w, height: l.h,
    borderWidth: 0, borderColor: 0, paddingLength: 0,
    containerID: textObject.length + 1, containerName: l.name,
    itemContainer: new ListItemContainerProperty({ itemCount: l.items.length, itemWidth: 0, isItemSelectBorderEn: 1, itemName: l.items.slice(0, 20) }),
    isEventCapture: 1,
  })] : []
  return {
    containerTotalNum: textObject.length + listObject.length,
    textObject,
    listObject,
    menuObject: page.menu?.length ? new MenuContainerProperty({ menuItems: page.menu.map(m => new MenuItemProperty({ itemID: m.id, itemName: m.label })) }) : undefined,
  }
}

const TIMEOUT_MS = 4000

/** Everything but the text values: same layout means an in-place text update is enough. */
export const layout = (p: Page) => JSON.stringify({ ...p, texts: p.texts.map(t => ({ ...t, text: '', color: 0 })) })

/** Serializes every bridge call (concurrent calls can drop the BLE link) and caps each one. */
export class Glasses {
  private chain: Promise<unknown> = Promise.resolve()
  private started = false
  private last = ''
  private lastPage: Page | null = null
  constructor(private bridge: EvenAppBridge) {}

  private run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const next = this.chain.then(() => Promise.race([
      fn(),
      new Promise<undefined>(r => setTimeout(() => r(undefined), TIMEOUT_MS)),
    ])).catch(err => { console.error('[ack] bridge', err); return undefined })
    this.chain = next
    return next
  }

  /**
   * Draws a page. Identical pages are skipped; when only texts changed, they are updated in place
   * (textContainerUpgrade: faster than a rebuild and flicker-free on the glasses).
   * Resolves with true once the glasses accepted it.
   */
  draw(page: Page, force = false): Promise<boolean> {
    const key = JSON.stringify(page)
    if (key === this.last && !force) return Promise.resolve(true)
    const prev = this.lastPage
    this.last = key
    this.lastPage = page
    return this.run(async () => {
      if (!this.started) {
        this.started = true
        return (await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(toPayload(page)))) === 0
      }
      if (!force && prev && layout(prev) === layout(page)) {
        let ok = true
        for (const [i, t] of page.texts.entries()) {
          const was = prev.texts[i]
          if (was.text === t.text && was.color === t.color) continue
          ok = (await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: i + 1, containerName: t.name, content: t.text.slice(0, 1999) || ' ', textColor: t.color ?? 4 }))) && ok
        }
        return ok
      }
      return this.bridge.rebuildPageContainer(new RebuildPageContainer(toPayload(page)))
    }).then(ok => ok === true)
  }

  mic(on: boolean) { return this.run(() => this.bridge.audioControl(on, AudioInputSource.Glasses)) }
  exit() { return this.run(() => this.bridge.shutDownPageContainer(1)) }
}
