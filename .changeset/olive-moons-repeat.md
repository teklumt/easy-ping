---
"easy-ping": patch
---

Fix `planPostgresMigration` silently doing nothing on an existing database.

`INTROSPECT_SQL` returns `table_name`/`column_name`/`data_type`/`is_nullable`, but `LiveColumn` is
`table`/`column`/`type`/`nullable`, and the planner read the short names. Passing the exported
query's rows straight through — which "so callers need not retype it" invites — built a map keyed
on `undefined`, so every existing table looked new. The plan came back as `CREATE TABLE IF NOT
EXISTS` against tables that already exist, which is a no-op, with no `ALTER TABLE ADD COLUMN` at
all and an empty `unsupported` list. It reported success and changed nothing.

The practical effect: anyone upgrading to 0.4.0 by the documented path did not get
`notification_preference.updated_at`, so unsubscribe-freshness checks had no column to read.

The planner now accepts either shape, so raw rows and hand-mapped rows both work. Every existing
test mapped the names by hand before calling it, which is why this survived; the new case passes
the rows through untouched.
