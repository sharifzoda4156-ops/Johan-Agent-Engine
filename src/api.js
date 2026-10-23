import { openDatabase, closeDatabase, DEFAULT_DATABASE_PATH } from './db.js';
import { createRepo } from './repo.js';
import { buildApp } from './app.js';

/** TCP port the API listens on (default 3000). */
const PORT = Number(process.env.PORT ?? 3000);

/** Bind address; 0.0.0.0 so the worker/other hosts can reach the API. */
const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * Boot the HTTP API:
 *   1. open the shared SQLite database (DATABASE_PATH or ./data/jobs.sqlite),
 *   2. build the repository on top of that handle,
 *   3. build the Fastify app with both injected,
 *   4. listen on PORT and install graceful-shutdown handlers.
 */
async function main() {
  const dbPath = process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;
  const db = openDatabase(dbPath);
  const repo = createRepo(db);
  const app = buildApp({ db, repo });

  let shuttingDown = false;

  /**
   * Close the Fastify server first (stop accepting requests), then close the
   * database so WAL is checkpointed cleanly. Safe to call more than once.
   *
   * @param {string} signal
   */
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
    } catch (err) {
      app.log.error({ err }, 'error while closing the server');
    } finally {
      closeDatabase(db);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await app.listen({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
