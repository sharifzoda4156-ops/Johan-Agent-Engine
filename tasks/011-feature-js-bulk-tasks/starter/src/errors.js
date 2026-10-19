// Ошибка API на стороне клиента: status — HTTP-код, details — объект error из ответа.
export class ApiError extends Error {
  constructor(status, details) {
    super(details?.message ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = details?.code;
    this.details = details;
  }
}

export class NotFoundError extends Error {
  constructor(id) {
    super(`task ${id} not found`);
    this.code = 'NOT_FOUND';
  }
}
