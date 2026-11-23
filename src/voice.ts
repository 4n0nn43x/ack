// Voice: glasses mic PCM (16 kHz, s16le, mono) to text, with the user's own key on their phone.
export type Provider = 'groq' | 'openai'
export interface VoiceCfg { provider: Provider; key: string }

export const PROVIDERS: Record<Provider, { base: string; model: string; label: string }> = {
  groq: { base: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', label: 'Groq (Whisper, fast, free tier)' },
  openai: { base: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', label: 'OpenAI' },
}

/** Wraps raw PCM chunks in a WAV header. */
export function wav(chunks: Uint8Array[], rate = 16000): Uint8Array {
  const size = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(44 + size)
  const v = new DataView(out.buffer)
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)))
  str(0, 'RIFF'); v.setUint32(4, 36 + size, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, size, true)
  let o = 44
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

/** Hints (button labels, the sender) are passed as the prompt so odd names are spelled right. */
export async function transcribe(cfg: VoiceCfg, chunks: Uint8Array[], hints: string[]): Promise<string> {
  if (chunks.reduce((n, c) => n + c.length, 0) < 3200 * 3) return '' // under 0.3 s: a slip, not speech
  const p = PROVIDERS[cfg.provider]
  const form = new FormData()
  form.append('file', new Blob([wav(chunks) as BlobPart], { type: 'audio/wav' }), 'voice.wav')
  form.append('model', p.model)
  form.append('prompt', hints.join(', ').slice(0, 400))
  const r = await fetch(`${p.base}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${cfg.key}` }, body: form })
  if (!r.ok) throw new Error(r.status === 401 ? 'Speech key refused. Check it in Ack settings.' : `Speech service error ${r.status}`)
  return ((await r.json()) as { text?: string }).text?.trim() ?? ''
}
