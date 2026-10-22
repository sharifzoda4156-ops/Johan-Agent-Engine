import { NotFoundError } from './errors.js';

export class TaskService {
  constructor(store) {
    this.store = store;
  }

  listTasks() {
    return this.store.list();
  }

  getTask(id) {
    const t = this.store.get(id);
    if (!t) throw new NotFoundError(id);
    return t;
  }

  createTask(input) {
    return this.store.insert({ title: input.title, done: input.done ?? false, priority: input.priority ?? 3 });
  }

  updateTask(id, patch) {
    const t = this.store.update(id, patch);
    if (!t) throw new NotFoundError(id);
    return t;
  }

  deleteTask(id) {
    if (!this.store.remove(id)) throw new NotFoundError(id);
  }
}
