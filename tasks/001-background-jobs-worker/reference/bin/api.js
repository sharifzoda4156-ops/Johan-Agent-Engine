import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';

const db = openDb();
const app = buildApp({ db, logger: true });
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  app.log.info(`${signal}: closing API`);
  await app.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port, host });
