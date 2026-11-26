# Ack with bots it was never told about

Measured 2026-11-26 on a real Telegram account with `node scripts/bot-probe.mjs`: Ack sends `/start` to each public bot, waits for the answer, and compares every button of the real Telegram message with the actions on the lens card. No bot button is pressed.

**21 of 21 bots that answered reached the lens as cards, unmodified; 11 of them sent buttons, and 31 of 31 buttons became lens actions (10 callback, 16 phone, 5 text).**

| Bot | Answered | Messages | Cards | Buttons in Telegram | Lens actions | Kinds |
| --- | --- | --- | --- | --- | --- | --- |
| @BotFather | yes, 2.6 s | 1 | 1 | 0 | 0 | - |
| @Stickers | yes, 2.6 s | 1 | 1 | 0 | 0 | - |
| @PremiumBot | yes, 2.5 s | 2 | 2 | 2 | 2 | 1 callback, 1 phone |
| @SpamBot | yes, 2.5 s | 1 | 1 | 2 | 2 | 2 text |
| @EURegulation | yes, 2.5 s | 1 | 1 | 0 | 0 | - |
| @jobs_bot | yes, 2.5 s | 1 | 1 | 1 | 1 | 1 text |
| @vote | yes, 2.5 s | 1 | 1 | 2 | 2 | 2 text |
| @like | yes, 2.5 s | 1 | 1 | 0 | 0 | - |
| @QuizBot | yes, 2.5 s | 1 | 1 | 2 | 2 | 2 callback |
| @gif | yes, 2.5 s | 1 | 1 | 0 | 0 | - |
| @wiki | yes, 2.5 s | 1 | 1 | 0 | 0 | - |
| @bing | yes, 2.6 s | 1 | 1 | 0 | 0 | - |
| @youtube | yes, 2.8 s | 1 | 1 | 0 | 0 | - |
| @telegraph | yes, 2.5 s | 1 | 1 | 3 | 3 | 3 callback |
| @DurgerKingBot | yes, 2.6 s | 1 | 1 | 1 | 1 | 1 phone |
| @MissRose_bot | yes, 2.5 s | 1 | 1 | 2 | 2 | 2 phone |
| @GroupHelpBot | yes, 2.6 s | 1 | 1 | 6 | 6 | 3 phone, 3 callback |
| @Combot | yes, 3.3 s | 1 | 1 | 7 | 7 | 7 phone |
| @IFTTT | yes, 2.5 s | 1 | 1 | 0 | 0 | - |
| @gamee | yes, 2.6 s | 1 | 1 | 3 | 3 | 1 callback, 2 phone |
| @PollBot | yes, 2.5 s | 1 | 1 | 0 | 0 | - |

Kinds: `callback` is pressed from the lens with one tap, `text` sends a reply-keyboard answer, `phone` (links, Mini Apps, inline mode) is shown with "Finish on your phone", `copy` shows the text to copy.
