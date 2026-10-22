import { createServer } from './http.js';
import { TaskService } from './service.js';
import { TaskStore } from './store.js';

const port = Number(process.env.PORT ?? 3000);
createServer(new TaskService(new TaskStore())).listen(port, () => console.log(`listening on ${port}`));
