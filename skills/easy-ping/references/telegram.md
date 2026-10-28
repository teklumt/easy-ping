# Telegram

Telegram as a channel. Read [api.md](api.md) first; this file adds what is specific to it.

```text
- provider: telegramBot({ token }) from 'easy-ping/providers/telegram'. The token comes from
  @BotFather; keep it in an environment variable. The provider never puts it in an error or log.
- plugin:   telegram({ provider, botUsername, render, webhookSecret?, linkTtlMinutes?,
            maxChatsPerUser?, messages? }) from 'easy-ping/plugins/telegram'
  render: ({ type, payload }) => ({ text, button? }) — text is Telegram HTML (<b>, <i>, <a>,
  <code>, <pre>); wrap user-typed payload fields in escapeHtml() or the send fails to parse.
  button is { text, url } and the url must be a public http(s) link — Telegram rejects
  localhost and private hosts, so the plugin drops such a button and sends the text alone.
- the notification type must list 'telegram' in its channels, or nothing is sent; the plugin
  is what makes 'telegram' a usable channel at all
- a bot cannot message anyone who has not opened a chat with it, so linking is the real work:
  POST /telegram/link (user route) returns { url: 'https://t.me/<bot>?start=<code>' }; the app's UI
  opens that url; the user taps Start; Telegram sends '/start <code>' back to the server; the plugin
  spends the one-time code (10 min TTL), stores the chat against the user and replies "Connected"
- how '/start' reaches the server is one of two ways, never both:
  webhook: set webhookSecret, then once per deployment call
    provider.setWebhook('https://<host>/api/notifications/telegram/webhook', secret);
    Telegram echoes the secret in X-Telegram-Bot-Api-Secret-Token and the route accepts nothing else
  polling: omit webhookSecret and call plugin.poll() in a long-running process (returns { stop });
    for development or hosts with no public URL; one poller per bot token
- GET /telegram/chats lists the user's linked chats; POST /telegram/unlink { chatId? } removes one
  or all; '/stop' in the chat or blocking the bot also unlinks
- a chat belongs to one account at a time and moves to whoever holds a fresh code; past
  maxChatsPerUser (default 5) the least recently seen chat is evicted
- failures: 429 retries with Telegram's retry_after; 403 and "chat not found" prune the chat on the
  spot; other 400s fail without retry; 5xx and network errors retry. A user with no linked chat is
  'skipped', never 'failed'
- tables: telegramSchema from 'easy-ping/plugins/telegram' — create them like pushSchema
  (createPostgresTables(query, { plugins: [telegramSchema] }), or createPluginIndexes on Mongo)
```
