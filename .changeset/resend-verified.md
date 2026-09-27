---
"easy-ping": patch
---

The Resend provider is now verified against Resend's live API: a real send, idempotent retries (the same delivery sent twice is one email) and a full `send()` to delivered pass through the cron sweep. The readme no longer says it was only exercised against a stub.
