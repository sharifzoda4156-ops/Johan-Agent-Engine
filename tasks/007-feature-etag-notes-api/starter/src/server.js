import { createApp } from './app.js';

const server = createApp().listen(Number(process.env.PORT) || 3000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
