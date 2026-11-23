// Fails if the Telegram API hash from .env.local ended up in dist/ (Vite inlines VITE_* variables).
// Run after every production build: `npm run verify` and `npm run pack` do it.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

let env = ''
try { env = readFileSync('.env.local', 'utf8') } catch { /* no local keys: nothing can leak */ }
const hash = env.match(/^VITE_TG_API_HASH=(.+)$/m)?.[1].trim() ?? ''

const files = readdirSync('dist', { recursive: true }).map(f => join('dist', String(f))).filter(f => statSync(f).isFile())
const leaks = hash ? files.filter(f => readFileSync(f).includes(hash)) : []
if (leaks.length) {
  console.error(`Telegram API hash found in the build: ${leaks.join(', ')}`)
  process.exit(1)
}
console.log(`no Telegram API key in dist/ (${files.length} files checked)`)
