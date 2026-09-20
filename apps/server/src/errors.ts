export class HttpError extends Error {
  status: number;
  /** seconds, sent as the Retry-After header on 429/503 */
  retryAfter?: number;
  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
export const bad = (m: string) => new HttpError(400, m);
export const unauthorized = (m = 'Sign in required') => new HttpError(401, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const tooMany = (m: string, retryAfter?: number) => new HttpError(429, m, retryAfter);
export const unavailable = (m: string, retryAfter?: number) => new HttpError(503, m, retryAfter);
