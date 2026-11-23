// Demo mode: scripted bots that behave like real Telegram bots (they edit their message
// after a press and answer with a toast), so anyone can try Ack without an account.
import type { BotRef, Command, PressResult, Source } from './app'
import { clean, type Action, type Card, type Style } from './cards'

type Btn = [label: string, next: string, style?: Style] | [label: string, url: { url: string }]
interface Screen { text: string; buttons: Btn[][]; toast?: string }
interface Bot { id: number; name: string; commands: Command[]; screens: Record<string, Screen>; onCommand?: Record<string, string> }

const BOTS: Bot[] = [
  {
    id: 101, name: '@my_agent_bot', commands: [{ command: 'status', description: 'What the agent is doing' }],
    onCommand: { status: 'status' },
    screens: {
      ask: { text: 'Exec approval needed\n$ rm -rf ./dist && npm run build\ncwd ~/shop-api · expires in 30 min', buttons: [[['Allow once', 'once', 'success'], ['Always allow', 'always']], [['Deny', 'deny', 'danger']]] },
      once: { text: 'Approved once.\nBuild finished in 41 s, 0 errors.', buttons: [], toast: 'Approved' },
      always: { text: 'Always allowed: npm run build.\nBuild finished in 39 s, 0 errors.', buttons: [] },
      deny: { text: 'Denied. The agent stopped and is waiting for you.', buttons: [] },
      status: { text: 'Agent idle. Last run: build, 41 s, 0 errors.', buttons: [] },
    },
  },
  {
    id: 102, name: '@deploy_bot', commands: [{ command: 'deploy', description: 'Ship the latest build' }, { command: 'status', description: 'What runs in prod' }],
    onCommand: { deploy: 'ask', status: 'status' },
    screens: {
      ask: { text: 'Deploy shop-api v2.3.1 to production?\n3 commits · CI green · 2 approvals', buttons: [[['Staging only', 'staging'], ['Cancel', 'cancel']], [['Deploy to prod', 'prod', 'danger']]] },
      staging: { text: 'v2.3.1 is live on staging.\nhttps://staging.shop.example', buttons: [[['Promote to prod', 'prod', 'danger']], [['Open staging', { url: 'https://staging.shop.example' }]]] },
      prod: { text: 'v2.3.1 is live in production.\nDeployed in 2 min 14 s, error rate 0.02%.', buttons: [[['Roll back', 'cancel', 'danger']]], toast: 'Deploy started' },
      cancel: { text: 'Cancelled. Production stays on v2.3.0.', buttons: [] },
      status: { text: 'Production: shop-api v2.3.0, healthy, p95 182 ms.', buttons: [] },
    },
  },
  {
    id: 103, name: '@trip_agent_bot', commands: [{ command: 'trips', description: 'Upcoming trips' }],
    onCommand: { trips: 'ask' },
    screens: {
      ask: { text: 'Flight PAR → DXB, Wed 3 Dec\n09:40 Emirates · $212\n13:15 Air France · $248\nBook the 09:40 for $212?', buttons: [[['Book $212', 'booked', 'success'], ['Show the 13:15', 'later']], [['Not now', 'no']]] },
      later: { text: '13:15 Air France · $248\nArrives 23:05, 1 bag included.\nBook it?', buttons: [[['Book $248', 'booked2', 'success'], ['Back to 09:40', 'ask']]] },
      booked: { text: 'Booked. EK 76, 09:40, seat 32A, $212.\nConfirmation EK7Q2Z.', buttons: [], toast: 'Booked' },
      booked2: { text: 'Booked. AF 662, 13:15, seat 18C, $248.\nConfirmation AF9K1M.', buttons: [], toast: 'Booked' },
      no: { text: 'OK, I will keep watching prices.', buttons: [] },
    },
  },
  {
    id: 104, name: '@BotFather', commands: [{ command: 'mybots', description: 'Edit your bots' }, { command: 'newbot', description: 'Create a new bot' }],
    onCommand: { mybots: 'list', newbot: 'newbot' },
    screens: {
      list: { text: 'Choose a bot from the list below:', buttons: [[['@ack_demo_bot', 'bot'], ['@price_alert_bot', 'bot']]] },
      bot: { text: 'Here it is: Ack Demo @ack_demo_bot.\nWhat do you want to do with the bot?', buttons: [[['API Token', 'token'], ['Edit Bot', 'edit']], [['Bot Settings', 'settings'], ['Payments', 'settings']], [['Delete Bot', 'deleted', 'danger']], [['« Back to Bots List', 'list']]] },
      token: { text: 'Here is the token for bot Ack Demo @ack_demo_bot:\n7311842261:AAF-demo-token-0000\nKeep your token secure.', buttons: [[['Revoke current token', 'revoked', 'danger']], [['« Back to Bot', 'bot']]] },
      revoked: { text: 'Token for @ack_demo_bot has been revoked. New token:\n7311842261:AAG-demo-token-0001', buttons: [[['« Back to Bot', 'bot']]], toast: 'Token revoked' },
      edit: { text: 'Edit @ack_demo_bot info.\nName: Ack Demo\nAbout: Taps from your glasses.', buttons: [[['Edit Name', 'bot'], ['Edit About', 'bot']], [['« Back to Bot', 'bot']]] },
      settings: { text: 'Settings for @ack_demo_bot.', buttons: [[['Inline Mode', 'bot'], ['Allow Groups?', 'bot']], [['« Back to Bot', 'bot']]] },
      deleted: { text: 'Bot @ack_demo_bot deleted. (Demo: nothing was really deleted.)', buttons: [] },
      newbot: { text: 'Alright, a new bot. How are we going to call it? Please choose a name for your bot.', buttons: [] },
    },
  },
  {
    id: 105, name: '@price_alert_bot', commands: [{ command: 'alerts', description: 'Your alerts' }],
    onCommand: { alerts: 'ask' },
    screens: {
      ask: { text: 'ETH crossed $3,500.00 (+4.2% in 1 h).\nYour alert: above $3,500.', buttons: [[['Mute 1 h', 'muted'], ['New alert at $3,600', 'next', 'primary']], [['Open chart', { url: 'https://www.tradingview.com/symbols/ETHUSD/' }]]] },
      muted: { text: 'ETH alerts muted until 11:42.', buttons: [] },
      next: { text: 'New alert set: ETH above $3,600.00.', buttons: [], toast: 'Alert saved' },
    },
  },
]

const ALEX = 201
// The opening sequence: when each bot speaks first (ms after the demo starts).
const SCRIPT: [botId: number, screen: string, at: number][] = [[101, 'ask', 900], [102, 'ask', 7000], [ALEX, '', 15000], [103, 'ask', 24000], [105, 'ask', 40000]]

export class DemoSource implements Source {
  readonly kind = 'demo'
  private msg = 1
  private state = new Map<string, { bot: Bot; screen: string }>()
  private timers: number[] = []

  constructor(private sink: (c: Card) => void, private replies: () => Action[]) {}

  start() {
    for (const [id, screen, at] of SCRIPT) {
      this.timers.push(window.setTimeout(() => id === ALEX ? this.alex() : this.post(BOTS.find(b => b.id === id)!, screen), at))
    }
  }

  stop() { this.timers.forEach(clearTimeout) }

  private card(bot: Bot, screen: string, msgId: number): Card {
    const s = bot.screens[screen]
    const actions: Action[] = s.buttons.flat().map(b => typeof b[1] === 'string'
      ? { label: clean(b[0]), kind: 'callback', style: b[2], data: new TextEncoder().encode(b[1]) }
      : { label: clean(b[0]), kind: 'phone', value: b[1].url })
    return { key: `${bot.id}:${msgId}`, chatId: bot.id, msgId, from: bot.name, isBot: true, text: s.text, date: Date.now(), actions, receivedAt: performance.now() }
  }

  private post(bot: Bot, screen: string) {
    const id = this.msg++
    this.state.set(`${bot.id}:${id}`, { bot, screen })
    this.sink(this.card(bot, screen, id))
  }

  private alex() {
    this.sink({ key: `${ALEX}:${this.msg}`, chatId: ALEX, msgId: this.msg++, from: 'Alex', isBot: false, text: 'Still on for 7pm? I booked the table at Zuma.', date: Date.now(), actions: this.replies(), receivedAt: performance.now() })
  }

  async press(card: Card, action: Action): Promise<PressResult> {
    await wait(250 + Math.random() * 250) // a real bot takes a moment
    if (action.kind === 'text') return {}
    const st = this.state.get(card.key)
    if (!st) throw new Error('MESSAGE_ID_INVALID')
    const next = new TextDecoder().decode(action.data)
    st.screen = next
    window.setTimeout(() => this.sink({ ...this.card(st.bot, next, card.msgId), date: card.date }), 120)
    return { toast: st.bot.screens[next].toast }
  }

  async send(chatId: number, text: string) {
    await wait(200)
    const bot = BOTS.find(b => b.id === chatId)
    const screen = bot?.onCommand?.[text.replace(/^\//, '').split(' ')[0]]
    if (bot && screen) window.setTimeout(() => this.post(bot, screen), 500)
  }

  async bots(): Promise<BotRef[]> { return BOTS.map(b => ({ id: b.id, name: b.name })) }
  async commands(botId: number) { return BOTS.find(b => b.id === botId)?.commands ?? [] }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
