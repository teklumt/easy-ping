---
"easy-ping": minor
---

MySQL and SQLite adapters.

- `mysqlAdapter(query, { prefix?, transaction? })` from `easy-ping/adapters/mysql`, with `mysql2Query(pool)`, `mysqlTransaction(pool)` and `createMysqlTables(query, { plugins? })`. MySQL 8 or MariaDB. With `transaction` a claim uses `FOR UPDATE SKIP LOCKED`; without it a lock-free `UPDATE … JOIN (SELECT … LIMIT)` that re-checks eligibility on the locked row, so two sweeps can never take the same delivery. Create the pool with `timezone: "Z"`.
- `sqliteAdapter(query, { prefix?, transaction? })` from `easy-ping/adapters/sqlite`, with `sqliteQuery(db)`, `sqliteTransaction(db)` and `createSqliteTables(query, { plugins? })`. Works with `node:sqlite` (Node 22.13+), better-sqlite3 or anything with the same `prepare().all()/.run()` shape. Nothing is imported at module level, so the package's Node 20 floor holds.
- `renderMysqlDdl` and `renderSqliteDdl` from `easy-ping/schema`. MySQL string columns become `VARCHAR(768)` when they are a single-column key, `VARCHAR(255)` in a composite key or when they carry a default, and `TEXT` otherwise, inside InnoDB's 3072-byte key limit; indexes are declared inline because MySQL has no `CREATE INDEX IF NOT EXISTS`.
- The query contract for both is `(text, params) => Promise<{ rows, affectedRows }>`, since MySQL has no `RETURNING`. `PluginStore.update` on MySQL returns rows changed, not matched, unless the pool sets `FOUND_ROWS`.
- Both run the full conformance, plugin-store and end-to-end suites alongside the Postgres and MongoDB backends. The plugin store now coerces `0/1` to booleans for date-less engines.
- No additive migration planner for these dialects yet; `createMysqlTables` and `createSqliteTables` are bootstrap only.
