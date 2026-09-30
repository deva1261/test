import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { Errors } from '../errors';

/** Guards /internal/* routes with a shared bearer token. */
export function requireInternalToken(token: string): RequestHandler {
  const expected = Buffer.from(`Bearer ${token}`);
  return (req, _res, next) => {
    const actual = Buffer.from(req.get('authorization') ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      next(Errors.unauthenticated());
      return;
    }
    next();
  };
}
