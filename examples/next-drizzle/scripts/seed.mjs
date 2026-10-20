import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL ?? "", { onnotice: () => {} });

await sql`
  insert into "user" (id, email)
  values ('you', 'you@example.com'), ('dana', 'dana@example.com'), ('sam', 'sam@example.com')
  on conflict (id) do nothing
`;
await sql.end();

console.log("seeded users: you, dana, sam");
