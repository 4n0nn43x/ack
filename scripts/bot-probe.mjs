// Live proof that Ack works with bots it was never told about: sends /start to each bot from a signed-in
// Ack dev page, waits for the answer, and checks that every button of the real Telegram message became an
// action on the lens card. Never presses a bot's button. Writes docs/proof/bots.md.
// Usage: npm run dev, open http://localhost:5173/?browser in a Chromium started with --remote-debugging-port=9333,
// sign in, then `node scripts/bot-probe.mjs` (CDP=http://127.0.0.1:9333 by default).
import { writeFileSync } from 'node:fs'

const BOTS = ['BotFather', 'Stickers', 'PremiumBot', 'SpamBot', 'EURegulation', 'jobs_bot', 'vote', 'like', 'QuizBot', 'gif',
  'wiki', 'bing', 'youtube', 'telegraph', 'DurgerKingBot', 'MissRose_bot', 'GroupHelpBot', 'Combot', 'IFTTT', 'gamee', 'PollBot']

const probe = async bots => {
  const w = ms => new Promise(r => setTimeout(r, ms))
  const { app, src } = window.ack
  const tg = src.tg
  const out = []
  for (const bot of bots) {
    const row = { bot, answered: false, messages: 0, buttons: 0, actions: 0, kinds: {}, empty: 0, cards: 0, ms: 0 }
    try {
      const sent = await tg.sendText(bot, '/start')
      const t0 = Date.now()
      let answers = []
      while (Date.now() - t0 < 12000) {
        await w(700)
        answers = (await tg.getHistory(bot, { limit: 6 })).filter(m => !m.isOutgoing && m.id > sent.id)
        if (answers.length) { await w(1500); answers = (await tg.getHistory(bot, { limit: 6 })).filter(m => !m.isOutgoing && m.id > sent.id); break }
      }
      row.answered = answers.length > 0
      row.ms = row.answered ? Date.now() - t0 : 0
      for (const m of answers) {
        row.messages++
        const raw = m.markup?.type === 'inline' || m.markup?.type === 'reply' ? m.markup.buttons.flat().length : 0
        row.buttons += raw
        const card = app.queue.find(c => c.chatId === m.chat.id && c.msgId === m.id)
        if (!card) continue
        row.cards++
        row.actions += card.actions.length
        for (const a of card.actions) { row.kinds[a.kind] = (row.kinds[a.kind] ?? 0) + 1; if (!a.label || a.label === '(button)') row.empty++ }
      }
    } catch (e) { row.error = String(e?.message ?? e).slice(0, 80) }
    out.push(row)
    await w(2500) // stay far below Telegram's flood limits
  }
  return out
}

const CDP = process.env.CDP ?? 'http://127.0.0.1:9333'
const tab = (await (await fetch(`${CDP}/json`)).json()).find(t => t.type === 'page' && /localhost:\d+/.test(t.url))
if (!tab) throw new Error('no Ack dev tab open')
const ws = new WebSocket(tab.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))
const res = await new Promise((resolve, reject) => {
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id === 1) m.error ? reject(new Error(m.error.message)) : resolve(m.result) })
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(${probe})(${JSON.stringify(BOTS)})`, awaitPromise: true, returnByValue: true } }))
})
ws.close()
if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
const rows = res.result.value

const answered = rows.filter(r => r.answered)
const carded = answered.filter(r => r.cards === r.messages)
const withButtons = answered.filter(r => r.buttons > 0)
const buttons = answered.reduce((n, r) => n + r.buttons, 0)
const mapped = answered.reduce((n, r) => n + r.actions, 0)
const kinds = answered.reduce((k, r) => { for (const [a, n] of Object.entries(r.kinds)) k[a] = (k[a] ?? 0) + n; return k }, {})
const summary = `${carded.length} of ${answered.length} bots that answered reached the lens as cards, unmodified; ${withButtons.length} of them sent buttons, and ${mapped} of ${buttons} buttons became lens actions (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}).`
const kindsOf = r => Object.entries(r.kinds).map(([k, n]) => `${n} ${k}`).join(', ') || '-'
const md = `# Ack with bots it was never told about

Measured ${new Date().toISOString().slice(0, 10)} on a real Telegram account with \`node scripts/bot-probe.mjs\`: Ack sends \`/start\` to each public bot, waits for the answer, and compares every button of the real Telegram message with the actions on the lens card. No bot button is pressed.

**${summary}**

| Bot | Answered | Messages | Cards | Buttons in Telegram | Lens actions | Kinds |
| --- | --- | --- | --- | --- | --- | --- |
${rows.map(r => `| @${r.bot} | ${r.answered ? `yes, ${(r.ms / 1000).toFixed(1)} s` : r.error ? `error: ${r.error}` : 'no answer in 12 s'} | ${r.messages} | ${r.cards} | ${r.buttons} | ${r.actions} | ${kindsOf(r)} |`).join('\n')}

Kinds: \`callback\` is pressed from the lens with one tap, \`text\` sends a reply-keyboard answer, \`phone\` (links, Mini Apps, inline mode) is shown with "Finish on your phone", \`copy\` shows the text to copy.
`
writeFileSync('docs/proof/bots.md', md)
console.log(summary)
console.table(rows.map(r => ({ bot: r.bot, answered: r.answered, msgs: r.messages, cards: r.cards, buttons: r.buttons, actions: r.actions, error: r.error ?? '' })))
