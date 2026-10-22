// Хранилище задач в памяти. Возвращает копии, чтобы снаружи нельзя было менять состояние.
export class TaskStore {
  #tasks = new Map();
  #seq = 0;

  list() {
    return [...this.#tasks.values()].map((t) => ({ ...t }));
  }

  get(id) {
    const t = this.#tasks.get(id);
    return t ? { ...t } : null;
  }

  insert(fields) {
    const task = { id: `t${++this.#seq}`, ...fields };
    this.#tasks.set(task.id, task);
    return { ...task };
  }

  update(id, patch) {
    const t = this.#tasks.get(id);
    if (!t) return null;
    Object.assign(t, patch);
    return { ...t };
  }

  remove(id) {
    return this.#tasks.delete(id);
  }
}
