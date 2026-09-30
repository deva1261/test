import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-sprintle-signature';

/** Header format: `sha256=<hex HMAC-SHA256 of the raw request body>`. */
export function signPayload(rawBody: Buffer | string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export function isValidSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(signPayload(rawBody, secret));
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
