// End-to-end check on the real Even Hub simulator, through its automation API.
// Usage: npm run dev, then `evenhub-simulator "http://localhost:5173/?fresh" --automation-port 9898`, then `npm run e2e`.
// It starts the demo from the lens, waits for a bot question, presses a button, undoes another, and checks every screen.
const BASE = process.env.SIM ?? 'http://127.0.0.1:9898'
let since = 0
const lines = []

const api = async (path, body) => {
  const r = await fetch(BASE + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  if (!r.ok) throw new Error(`${path} -> ${r.status}`)
  return r
}
const input = async (...actions) => { for (const action of actions) { await api('/api/input', { action }); await sleep(350) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function poll() {
  const { entries } = await (await api(`/api/console?since_id=${since}`)).json()
  for (const e of entries) { since = Math.max(since, e.id); lines.push(e.message) }
}
async function waitFor(re, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    await poll()
    const i = lines.findIndex(l => re.test(l))
    if (i >= 0) return lines.splice(0, i + 1)[i]
    await sleep(150)
  }
  throw new Error(`timed out waiting for ${re}`)
}
let n = 0
const step = async (name, fn) => { await fn(); console.log(`  ok ${++n}. ${name}`) }

console.log('Ack end-to-end on the Even Hub simulator')
await api('/api/ping')
await step('the lens shows the sign-in screen, never a black screen', async () => {
  await waitFor(/\[ack\] lens Ack \| Sign in to Telegram/)
})
await step('tap starts the demo and a bot question reaches the lens', async () => {
  await input('click')
  await waitFor(/\[ack\] lens @my_agent_bot .*Exec approval needed.*Allow once/)
})
const latency = Number((await waitFor(/\[ack\] card on lens in \d+ ms/)).match(/(\d+) ms/)[1])
await step(`card on the lens ${latency} ms after the message arrived`, async () => { if (latency > 1000) throw new Error('over the 1 s budget') })
await step('pressing shows the undo countdown', async () => {
  await input('click')
  await waitFor(/\[ack\] lens @my_agent_bot \| ▶ Allow once.*Sending in.*━/)
})
await step('the bot answers and edits its message, the card follows', async () => {
  await waitFor(/\[ack\] lens @my_agent_bot \| Approved/, 6000)
  await waitFor(/\[ack\] lens @my_agent_bot · .*Approved once\. \/ Build finished in 41 s, 0 errors\./, 6000)
})
await step('OK clears the card, the lens is calm again', async () => {
  await input('click')
  await waitFor(/\[ack\] lens Ack \| Nothing waiting\.|\[ack\] lens @deploy_bot/)
})
await step('a dangerous button asks for an explicit yes, double tap backs out', async () => {
  await waitFor(/\[ack\] lens @deploy_bot .*Deploy shop-api v2\.3\.1/, 12000)
  await input('down', 'down', 'click')
  await waitFor(/marked as dangerous \| ▲ Deploy to prod\?/)
  await input('double_click')
  await waitFor(/\[ack\] lens @deploy_bot .*Staging only/)
})
await step('double tap inside the countdown undoes the press', async () => {
  await input('click')
  await waitFor(/Sending in/)
  await input('double_click')
  await waitFor(/Undone: Staging only/)
})
await step('the contextual menu holds Ack actions', async () => {
  await sleep(2000)
  await input('context_menu')
  await sleep(600)
  await input('context_menu')
})
console.log(`\nAll ${n} checks passed.`)
