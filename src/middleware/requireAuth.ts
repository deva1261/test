import type { RequestHandler } from 'express';
import { Errors } from '../errors';
import type { AuthService } from '../services/authService';
import { SESSION_COOKIE } from '../routes/cookies';

export function requireAuth(auth: AuthService): RequestHandler {
  return async (req, res, next) => {
    try {
      const user = await auth.authenticate(req.cookies?.[SESSION_COOKIE]);
      if (!user) throw Errors.unauthenticated();
      res.locals.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}
