# Ack privacy policy

Last updated: 27 November 2026

Ack is an unofficial Telegram client built on the Telegram API. It runs as a plugin inside the Even Realities App on your phone and shows your Telegram bots and the chats you choose on Even G2 glasses. Ack has no server: its developers never receive your messages, your contacts, your session or anything about how you use it.

## What Ack connects to

Ack uses the network permission for these hosts only. They are the only ones listed in its `app.json`.

| Host | When | What goes there |
| --- | --- | --- |
| `pluto`, `venus`, `aurora`, `vesta` and `flora.web.telegram.org` (WebSocket) | While you are signed in | What any Telegram client sends: signing in, the messages and commands you send, the buttons you press (Telegram passes them to that bot), read receipts for the messages you open or that the lens shows, the views and clicks of Telegram's sponsored messages, as Telegram's API terms require, and, on the Settings tab, a request for your own Telegram Stars subscriptions, to show whether you support Ack (Ack+). The answer stays on your phone. [Telegram's privacy policy](https://telegram.org/privacy) applies. |
| `api.groq.com` or `api.openai.com` | Only if you turn on voice with your own key, and only after you hold to speak | The recording of what you said while holding, and a short hint so names are spelled right: who sent the card and its button labels. The provider you chose handles it under its own policy. |

Ack has no analytics, no tracking, no advertising of its own and no crash reporting.

## Microphone

Ack turns the glasses' microphone on only while you hold the temple or the ring to answer a card by voice, and only if you added a speech key. Releasing stops it. Ack does not store the audio: it is sent once to your speech provider.

## What stays on your phone

Everything Ack keeps lives in the Even Realities App's web view on your phone:

- your Telegram session;
- your settings: the chats you send to the glasses, quick replies, bots that skip the countdown, muted chats, your speech provider and key, and your own Telegram API keys if you typed them;
- the last 200 decisions (time, chat name, the first 80 characters of the card, the button and the result) and the last 200 timing measures, shown on the Lens tab;
- the ids of the last 500 cards you dismissed, so they do not come back.

## What reaches the glasses

Only the card on screen, sent by the Even Realities App over Bluetooth. Even Realities' own privacy policy covers its app and the glasses.

## Whose messages Ack shows

Ack sees only what your Telegram account already sees. Bot messages come to the lens. Messages from people, groups and channels come only from the chats you switch on. When you tap the empty lens, it lists the names of your recent chats by kind, and a chat's messages show on the lens only once you open that chat there.

## AI

Ack does not use Telegram data to train or improve any model. The only data it sends to a speech service is described above, and only when you use voice.

## Deleting your data

"Sign out of Telegram" (or "Leave the demo") in Ack's settings ends the session on Telegram's side and erases everything listed under "What stays on your phone". You can also end Ack's session from Telegram, in Settings, Devices.

## Contact

Questions about this policy: open an issue on [github.com/4n0nn43x/ack](https://github.com/4n0nn43x/ack).
