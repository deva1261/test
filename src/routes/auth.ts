import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import type { AuthService } from '../services/authService';
import { loginSchema, signupSchema } from '../validation/schemas';
import { SESSION_COOKIE, sessionCookieOptions } from './cookies';

type Handler = (req: Request, res: Response) => Promise<void>;

const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

export interface AuthRouterOptions {
  cookieSecure: boolean;
}

export function authRouter(auth: AuthService, options: AuthRouterOptions): Router {
  const router = Router();
  const cookieOptions = sessionCookieOptions(options.cookieSecure);

  // Auth responses are per-user and must never be cached by intermediaries.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // OP-001
  router.post(
    '/signup',
    wrap(async (req, res) => {
      const input = signupSchema.parse(req.body ?? {});
      const user = await auth.signup(input);
      res.status(201).json({ user });
    }),
  );

  // OP-002
  router.post(
    '/login',
    wrap(async (req, res) => {
      const input = loginSchema.parse(req.body ?? {});
      const { user, token, expiresAt } = await auth.login(input);
      res.cookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });
      res.status(200).json({ user });
    }),
  );

  // OP-003: idempotent — succeeds even if the caller has no live session.
  router.post(
    '/logout',
    wrap(async (req, res) => {
      await auth.logout(req.cookies?.[SESSION_COOKIE]);
      res.clearCookie(SESSION_COOKIE, cookieOptions);
      res.status(204).end();
    }),
  );

  // OP-004
  router.get('/me', requireAuth(auth), (_req, res) => {
    res.status(200).json({ user: res.locals.user });
  });

  return router;
}
