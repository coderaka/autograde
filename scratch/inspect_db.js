import { initDb, getSubmissions } from '../lib/db.js';

async function main() {
  await initDb();
  const subs = getSubmissions();
  console.log(JSON.stringify(subs, null, 2));
}

main().catch(console.error);
