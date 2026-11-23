// A real Telegram bot that asks the questions agents and ops bots ask, with Bot API 9.4 button styles.
// Run: BOT_TOKEN=123:abc node tools/demo-bot.mjs   (token from @BotFather, /newbot)
// Then message your bot /approve, /deploy or /trip from the account signed in to Ack.
const TOKEN = process.env.BOT_TOKEN
if (!TOKEN) { console.error('Set BOT_TOKEN (from @BotFather).'); process.exit(1) }
const call = async (method, body = {}) => {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json()
  if (!j.ok) console.error(method, j.description)
  return j.result
}
const btn = (text, data, style) => ({ text, callback_data: data, ...(style ? { style } : {}) })

const SCREENS = {
  approve: { text: 'Exec approval needed\n$ rm -rf ./dist && npm run build\ncwd ~/shop-api · expires in 30 min', kb: [[btn('Allow once', 'approve:once', 'success'), btn('Always allow', 'approve:always')], [btn('Deny', 'approve:deny', 'danger')]] },
  'approve:once': { text: 'Approved once.\nBuild finished in 41 s, 0 errors.', toast: 'Approved' },
  'approve:always': { text: 'Always allowed: npm run build.' },
  'approve:deny': { text: 'Denied. The agent stopped.' },
  deploy: { text: 'Deploy shop-api v2.3.1 to production?\n3 commits · CI green · 2 approvals', kb: [[btn('Staging only', 'deploy:staging'), btn('Cancel', 'deploy:cancel')], [btn('Deploy to prod', 'deploy:prod', 'danger')]] },
  'deploy:staging': { text: 'v2.3.1 is live on staging.', kb: [[btn('Promote to prod', 'deploy:prod', 'danger')], [{ text: 'Open staging', url: 'https://example.com' }]] },
  'deploy:prod': { text: 'v2.3.1 is live in production.\nDeployed in 2 min 14 s, error rate 0.02%.', toast: 'Deploy started' },
  'deploy:cancel': { text: 'Cancelled. Production stays on v2.3.0.' },
  trip: { text: 'Flight PAR → DXB, Wed 3 Dec\n09:40 Emirates · $212\n13:15 Air France · $248\nBook the 09:40 for $212?', kb: [[btn('Book $212', 'trip:book', 'success'), btn('Show the 13:15', 'trip:later')], [btn('Not now', 'trip:no')]] },
  'trip:later': { text: '13:15 Air France · $248\nBook it?', kb: [[btn('Book $248', 'trip:book2', 'success'), btn('Back to 09:40', 'trip')]] },
  'trip:book': { text: 'Booked. EK 76, 09:40, seat 32A, $212.', toast: 'Booked' },
  'trip:book2': { text: 'Booked. AF 662, 13:15, seat 18C, $248.', toast: 'Booked' },
  'trip:no': { text: 'OK, I will keep watching prices.' },
}

await call('setMyCommands', { commands: [
  { command: 'approve', description: 'An agent asks to run a command' },
  { command: 'deploy', description: 'Ship to production' },
  { command: 'trip', description: 'Book a flight' },
] })
const me = await call('getMe')
console.log(`@${me?.username} is up. Send it /approve, /deploy or /trip.`)

let offset = 0
for (;;) {
  const updates = (await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] })) ?? []
  for (const u of updates) {
    offset = u.update_id + 1
    const m = u.message
    const name = m?.text?.match(/^\/(\w+)/)?.[1]
    if (m && SCREENS[name]) {
      const s = SCREENS[name]
      await call('sendMessage', { chat_id: m.chat.id, text: s.text, reply_markup: { inline_keyboard: s.kb } })
    } else if (m) {
      await call('sendMessage', { chat_id: m.chat.id, text: `Got "${m.text ?? ''}". Try /approve, /deploy or /trip.` })
    }
    const q = u.callback_query
    if (q) {
      const s = SCREENS[q.data]
      await call('answerCallbackQuery', { callback_query_id: q.id, text: s?.toast })
      if (s) await call('editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text: s.text, reply_markup: { inline_keyboard: s.kb ?? [] } })
    }
  }
}
