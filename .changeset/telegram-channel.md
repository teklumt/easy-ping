---
"easy-ping": minor
---

Telegram as a channel.

- `easy-ping/plugins/telegram`: `telegram({ provider, botUsername, render, webhookSecret?, linkTtlMinutes?, maxChatsPerUser?, messages? })` declares the `telegram` channel. `POST /telegram/link` mints a one-time `https://t.me/<bot>?start=<code>` link; the `/start <code>` message links the chat to the user. `GET /telegram/chats`, `POST /telegram/unlink`, and `POST /telegram/webhook` (mounted only with `webhookSecret`, authenticated by `X-Telegram-Bot-Api-Secret-Token`). `plugin.poll()` long-polls instead of a webhook. `telegramSchema` exported for DDL.
- `easy-ping/providers/telegram`: `telegramBot({ token })` over fetch. `send` never throws: 429 is retryable with `retry_after`, 403 and "chat not found" mark the chat gone (pruned), other 400s fail without retry, 5xx and network retry. The token is redacted from every error. `getUpdates`, `setWebhook`, `deleteWebhook`, `getMe`.
- `Channel` gains `"telegram"`; the preferences plugin lists it.
