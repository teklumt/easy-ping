# MongoDB

Running easy-ping on MongoDB. Read [api.md](api.md) first; this file adds what is specific to it.

```text
- mongoAdapter(db, { client }) from 'easy-ping/adapters/mongodb'
- pass the MongoClient as well as the db — that is what makes createNotifications
  atomic (a notification and its deliveries land together, or neither does).
  Without it the adapter still works, it just loses that guarantee.
- transactions need a replica set; a single-node replica set is fine locally
- there are no tables, only indexes: await createMongoIndexes(db) at startup
- plugin tables: await createPluginIndexes(db, pushSchema)  // schemas export standalone
- re-running createMongoIndexes is idempotent, so it doubles as the upgrade path
  (there is no planPostgresMigration equivalent to run, and none is needed)
- ids are stored as _id; the library never exposes that outside the adapter
```
