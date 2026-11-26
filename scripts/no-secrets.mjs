// The repository must never hold the Telegram api_hash (hackathon rule). It lives in .env.local, which git ignores,
// and Vite injects it into the build, as iMe and Nicegram inject theirs. Fails if any file git would commit holds it.
// Run by `npm run verify` and `npm run pack`.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

let env = ''
try { env = readFileSync('.env.local', 'utf8') } catch { /* no local keys: nothing can leak */ }
const hash = env.match(/^VITE_TG_API_HASH=(.+)$/m)?.[1].trim() ?? ''

if (hash) {
  let leaks = ''
  try {
    leaks = execFileSync('git', ['grep', '--untracked', '-I', '-l', '-F', '-e', hash], { encoding: 'utf8' }).trim()
  } catch (e) {
    if (e.status !== 1) throw e // 1 means no match; anything else is a real git error
  }
  if (leaks) {
    console.error(`Telegram API hash found in files git would commit: ${leaks.split('\n').join(', ')}`)
    process.exit(1)
  }
}
const files = readdirSync('dist', { recursive: true }).map(f => join('dist', String(f))).filter(f => statSync(f).isFile())
const embedded = !!hash && files.some(f => readFileSync(f).includes(hash))
console.log(`no Telegram API key in the repository; the build ${embedded ? "carries Ack's api_id, so users only sign in" : 'has no api_id, so users enter their own API keys'}`)
