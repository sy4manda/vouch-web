export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export const bad = (m: string) => new HttpError(400, m);
export const unauthorized = (m = 'Sign in required') => new HttpError(401, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
