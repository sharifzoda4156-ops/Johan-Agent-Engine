// Example PM2 ecosystem configuration for the background jobs worker.
//
// Usage:
//   cp ecosystem.config.example.js ecosystem.config.js
//   pm2 start ecosystem.config.js
//
// The API and the worker are two separate processes that share a single
// SQLite database, so both must be given the same DATABASE_PATH.
//
// Environment variables
// ---------------------
//   DATABASE_PATH  Path to the shared SQLite database file.
//                  Default: ./data/jobs.sqlite
//   PORT           TCP port the API process listens on.
//                  Default: 3000
//
// LEASE_MS and MAX_ATTEMPTS are constants in src/config.js and are
// intentionally NOT environment variables, so they are not listed here.
//
// This file is an ES module (package.json has "type": "module"). If your PM2
// version cannot load ESM configs, rename the copy to ecosystem.config.cjs
// and replace `export default` with `module.exports =`.

export default {
  apps: [
    {
      name: 'jobs-api',
      script: 'src/api.js',
      env: {
        // Shared SQLite database (default: ./data/jobs.sqlite)
        DATABASE_PATH: './data/jobs.sqlite',
        // Port the HTTP API listens on (default: 3000)
        PORT: '3000',
      },
    },
    {
      name: 'jobs-worker',
      script: 'src/worker.js',
      env: {
        // Must match the API's DATABASE_PATH so both processes share one queue.
        DATABASE_PATH: './data/jobs.sqlite',
      },
    },
  ],
};
