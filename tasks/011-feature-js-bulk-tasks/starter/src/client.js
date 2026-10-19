import { ApiError } from './errors.js';

// SDK, которым пользуются мобильное приложение и скрипты.
export class TasksClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async #request(method, path, body) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, data?.error);
    return data;
  }

  async list() {
    return (await this.#request('GET', '/tasks')).tasks;
  }

  get(id) {
    return this.#request('GET', `/tasks/${encodeURIComponent(id)}`);
  }

  create(data) {
    return this.#request('POST', '/tasks', data);
  }

  update(id, patch) {
    return this.#request('PATCH', `/tasks/${encodeURIComponent(id)}`, patch);
  }

  async remove(id) {
    await this.#request('DELETE', `/tasks/${encodeURIComponent(id)}`);
  }
}
