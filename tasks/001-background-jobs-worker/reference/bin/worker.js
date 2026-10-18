import { openDb } from '../src/db.js';
import { createWorker } from '../src/worker.js';

const db = openDb();
const worker = createWorker({
  db,
  pollMs: Number(process.env.WORKER_POLL_MS ?? 500),
  log: (m) => console.log(m),
});

function shutdown(signal) {
  console.log(`${signal}: stopping worker`);
  worker.stop();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('worker started');
await worker.run();
db.close();
console.log('worker stopped');
