// Подпись и проверка вебхуков: получатель (и отправитель) на Node.js.
import crypto from 'node:crypto';

export const TOLERANCE = 300;

export class VerifyError extends Error {
  constructor(code) {
    super(code);
    this.name = 'VerifyError';
    this.code = code;
  }
}

export function canonical(payload) {
  return JSON.stringify(payload);
}

const mac = (secret, ts, body) => crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

export function sign(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const body = canonical(payload);
  return { body, header: `t=${timestamp},v1=${mac(secret, timestamp, body)}` };
}

export function verify(rawBody, header, secrets, { now = Date.now(), tolerance = TOLERANCE } = {}) {
  const list = Array.isArray(secrets) ? secrets : [secrets];
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')));
  const ts = Number(parts.t);
  if (!Number.isInteger(ts) || !parts.v1) throw new VerifyError('BAD_HEADER');
  if (Math.abs(now - ts) > tolerance) throw new VerifyError('STALE');
  const payload = JSON.parse(String(rawBody));
  const body = canonical(payload);
  if (!list.some((s) => mac(s, ts, body) === parts.v1)) throw new VerifyError('BAD_SIGNATURE');
  return payload;
}
