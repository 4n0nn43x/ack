# Ack

**Every Telegram bot button becomes one tap on Even G2.** When a bot asks something, the question is on your lens within 60 ms of reaching your phone (measured in the Even Hub simulator, 9 to 62 ms across runs), and a tap on the temple or the R1 ring presses the button. You don't take the phone out, and the bots don't need any change.

Track: **01 Messaging & News** (Telegram accounts, bots, chats) · Special prize: **Best Telegram integration**

![A bot question on the lens](docs/lens/2-agent-card.png)

## The problem

Bots now ask with buttons. AI agents send exec approvals to Telegram as inline buttons (OpenClaw does it natively, and the approval expires in 30 minutes). Deploy bots ask "Deploy to prod?", trading and travel bots ask "Book it for $212?". Since Bot API 9.4 (9 Feb 2026) a bot can even mark a button as `danger`, `success` or `primary`.

On Even G2, those messages only arrive as read-only notifications. To press "Allow once", you still have to take out the phone, unlock it, find the chat and tap. The decision takes a second. Getting to it takes thirty.

## What Ack does

- **Every bot, nothing to set up.** Ack signs in as you (your own Telegram account, from your phone) and turns any bot message with buttons into a card on the lens. BotFather, your agent, your deploy bot, your price alerts: all of them work as they are.
- **One tap.** Swipe to pick, tap to press. The bot's answer appears in the card header, and when the bot edits its message, the card follows.
- **Safe by design.**
  - Every press runs on a 1.5 s countdown you can undo with a double tap.
  - Buttons a bot marks `danger` always ask for an explicit yes and show what the card is about.
  - Danger buttons are always listed last.
- **Numbers stay exact.** Emoji the glasses can't draw become words (✅ becomes "OK") or disappear. Digits, prices, addresses and commands are never changed, and a test checks it.
- **Buttons the lens can't run say so.** Links, Mini Apps and payments show "Finish on your phone" with the address. Copy buttons show their code, and disabled buttons are greyed.
- **People too, without becoming a chat client.** Only the people you pick come to the glasses, in the same queue. You answer with your quick replies or by voice.
- **Bot command menus from the lens.** Tap the empty lens to see your bots, pick one, then pick a command from its "/" menu: `/mybots`, `/deploy`, `/status`...
- **Voice when it is faster.** Hold, speak, release: "deny it" presses Deny. Anything else is sent as a message once you confirm. Transcription uses your own Groq or OpenAI key, kept on your phone.
- **The phone page** mirrors the lens to scale and keeps a log of every decision (who asked, what you pressed, what the bot answered). It also shows the message-to-lens latency measured on every card.

| Undo countdown | The bot answered | Danger needs a yes |
| --- | --- | --- |
| ![Undo countdown](docs/lens/3-undo-countdown.png) | ![Bot edited its message](docs/lens/4-bot-edited.png) | ![Danger confirmation](docs/lens/6-danger-confirm.png) |

## Try it in 2 minutes, no account needed

You need Node 20 or later. No glasses needed.

```bash
npm install -g @evenrealities/evenhub-simulator
git clone https://github.com/4n0nn43x/ack && cd ack
npm install
npm run dev
# in a second terminal
evenhub-simulator "http://localhost:5173/?fresh"
```

Click the glasses screen once to start the **demo**. Scripted bots then behave like real ones: an agent asks for an exec approval, a deploy bot asks about production, a friend asks about tonight, a travel agent offers a flight. The simulator shortcuts are:

| Gesture | Glasses / ring | Simulator |
| --- | --- | --- |
| Pick a button | Swipe | Up / Down |
| Press | Tap | Click |
| Undo, dismiss, back | Double tap | Double click |
| Answer by voice | Hold, speak, release | Long press |
| Mute a chat, read all, clear | Tap then hold (system menu) | Context menu |

On Linux the simulator needs WebKitGTK: `sudo apt install libwebkit2gtk-4.1-0`.

## Use it with your Telegram account

1. Get an API ID and hash at [my.telegram.org](https://my.telegram.org) ("API development tools").
2. Either put them in `.env.local` (copy `.env.example`), or type them in the Ack page on your phone.
3. Enter your phone number, then the code Telegram sends you. The session is stored on your phone only.
4. To see bot buttons right away, run the real demo bot. It uses Bot API 9.4 button styles:

   ```bash
   BOT_TOKEN=<token from @BotFather /newbot> node tools/demo-bot.mjs
   ```

   Then send it `/approve`, `/deploy` or `/trip`. You can also open `@BotFather` from the lens and run `/mybots`.

On the glasses: `npm run pack` builds `ack.ehpk` (443 kB) for the Even Hub portal, or run `evenhub qr --url http://<your-ip>:5173` and scan the QR with the Even app.

## Verify in 5 minutes

```bash
npm run verify   # types, 46 unit tests, production build
npm run e2e      # 9 checks on the real Even Hub simulator (start it with ?fresh and --automation-port 9898)
```

The end-to-end script drives the simulator through its automation API and reads what the lens shows. It checks:
- the sign-in screen;
- a bot question reaching the lens, with the latency;
- the undo countdown;
- the bot editing its message;
- the danger confirmation;
- an undo;
- the system menu.

```
Ack end-to-end on the Even Hub simulator
  ok 1. the lens shows the sign-in screen, never a black screen
  ok 2. tap starts the demo and a bot question reaches the lens
  ok 3. card on the lens 59 ms after the message arrived
  ok 4. pressing shows the undo countdown
  ok 5. the bot answers and edits its message, the card follows
  ok 6. OK clears the card, the lens is calm again
  ok 7. a dangerous button asks for an explicit yes, double tap backs out
  ok 8. double tap inside the countdown undoes the press
  ok 9. the contextual menu holds Ack actions
```

The unit tests check every page Ack can draw against the SDK's own validator (`validateEvenHubPageContainer`), and they also check the 63-byte list rows and the 1,000-character text limit.

## How it works

```
Telegram (MTProto, layer 233) ──WebSocket──▶ phone: Even app WebView running Ack ──BLE──▶ G2 lens
      ▲                                       mtcute client, session in IndexedDB          ▲
      └──────── callback answer / message ◀── card queue, undo, confirm ◀── tap, swipe, ring, voice
```

No Ack server sits in between. The WebView talks to Telegram's web endpoints (`wss://*.web.telegram.org`) directly, and they are listed in `app.json`.

### Telegram surfaces used

| What | Where |
| --- | --- |
| User account login (phone, code, 2FA) over MTProto | `src/telegram.ts:35` |
| New, edited and deleted messages, live | `src/telegram.ts:41-43` |
| Pending bot questions brought back on start (dialogs) | `src/telegram.ts:47` |
| Press an inline button: `messages.getBotCallbackAnswer` | `src/telegram.ts:93` |
| Reply keyboards and quick replies: send text | `src/telegram.ts:90` |
| Bot command menus (`botInfo.commands`) | `src/telegram.ts:111` |
| Layer 233 inline buttons: callback, copy, disabled, url, web app, password | `src/cards.ts:80-84` |
| Bot API 9.4 button `style` (danger, success, primary) | `src/cards.ts:66` |
| Reply keyboard buttons (`keyboardButton`) | `src/cards.ts:88` |
| Callback toasts and alerts | `src/app.ts:206` |
| Rich messages | `src/telegram.ts:75` |

### Even Hub SDK features used

| What | Where |
| --- | --- |
| Text and list containers, one page system with header, body and gesture hints | `src/app.ts`, `src/glasses.ts:65` |
| In-place text updates (`textContainerUpgrade`) when only texts change, else rebuild | `src/glasses.ts:128` |
| Native list selection, swipe handled by firmware | `src/glasses.ts:36` |
| Long press and release for voice (SDK 0.0.14+) | `src/glasses.ts:54` |
| Ring vs temple source on taps | `src/glasses.ts:28` |
| Contextual menu items (`menuObject`): mute, read all, clear | `src/glasses.ts:86`, `src/app.ts:157` |
| Text brightness levels (`textColor`) for hierarchy | `src/app.ts` |
| Glasses microphone (`audioControl`) | `src/glasses.ts:141` |
| Root double tap opens the system exit dialog (`shutDownPageContainer(1)`) | `src/glasses.ts:142` |
| Serialized bridge calls with a timeout | `src/glasses.ts:103` |

### Design rules on the lens

- Empty by default. The lens stays calm until a bot or a chosen person asks something.
- One card, one decision. At most three rows are visible, in the bot's order, with danger buttons last.
- Every screen has the same layout: who is asking (dim), the message (bright), what the gestures do (dim).
- Only glyphs the G2 font has are used (▲ ● ▶ ◁ □ ○ ━), and texts are fitted with Even's own font metrics (`@evenrealities/pretext`).
- Every gesture answers on the lens.

## Privacy and safety

- Your Telegram session stays in the Even app on your phone. Ack has no backend.
- Ack only sees what your account already sees. People's messages reach the glasses only for the chats you pick.
- Each press can be undone for 1.5 s, and bots you trust can skip the countdown in settings. Buttons a bot marks dangerous always ask for confirmation.
- Voice audio is captured only while you hold. It goes straight from your phone to the transcription service you chose, with your own key.
- The repository holds no secrets: Telegram API keys come from `.env.local` or from your phone.

## Project layout

```
src/cards.ts      Telegram message to card: buttons, styles, text cleaning, fitting (pure)
src/app.ts        queue, views and gestures (no SDK, no network: fully unit tested)
src/glasses.ts    pages to SDK containers, event parsing, serialized bridge
src/telegram.ts   live account over MTProto (mtcute)
src/demo.ts       scripted bots for the no-account demo
src/voice.ts      glasses mic to WAV to transcription
src/phone.ts      the phone page
scripts/e2e.mjs   end-to-end checks on the simulator
tools/demo-bot.mjs  a real Telegram bot with styled buttons
```

## Built during the hackathon

Everything in this repository was written from 23 Nov 2026. It started from the official `minimal` template of [evenhub-templates](https://github.com/even-realities/evenhub-templates) (first commit), and it uses these open-source libraries: [mtcute](https://github.com/mtcute/mtcute) (MIT), `@evenrealities/even_hub_sdk`, `@evenrealities/pretext`, Vite, TypeScript and Vitest.

## License

MIT
