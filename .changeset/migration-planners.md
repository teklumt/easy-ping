---
"easy-ping": minor
---

Migration planners for MySQL and SQLite, so every SQL database has an upgrade path.

- `planMysqlMigration(query, schema, prefix?)` and `planSqliteMigration(query, schema, prefix?)` from `easy-ping/schema`, taking the same query function as the adapters. Additive only, like `planPostgresMigration`: missing tables, columns and indexes are emitted; type changes, undeclared columns, required columns with no default and (MySQL) indexes over `TEXT` columns land in `plan.unsupported`.
- MySQL checks existing indexes in `information_schema.STATISTICS`, since it has no `CREATE INDEX IF NOT EXISTS`.
- SQLite rebuilds a table that gains a timestamp column (copy, move rows, swap, reindex), because `ADD COLUMN` cannot carry a non-constant default.
- The digests plugin now declares `notification_preference` with the core table's full definition instead of the subset it reads, so planners no longer report `updated_at` as undeclared.
