import type { CookieOptions } from 'express';

export const SESSION_COOKIE = 'sid';

export function sessionCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
  };
}
