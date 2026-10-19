import { randomUUID } from 'node:crypto';

export function createStore() {
  const notes = new Map();
  return {
    get: (id) => notes.get(id) ?? null,
    create({ title, body }) {
      const note = { id: randomUUID(), title, body, updatedAt: new Date().toISOString() };
      notes.set(note.id, note);
      return note;
    },
    update(id, { title, body }) {
      const note = notes.get(id);
      if (!note) return null;
      const next = { ...note, title, body, updatedAt: new Date().toISOString() };
      notes.set(id, next);
      return next;
    },
    delete: (id) => notes.delete(id),
  };
}
