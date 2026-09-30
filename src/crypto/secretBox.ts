import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for provider credentials at rest. Output is `v1.<iv>.<tag>.<ciphertext>`, base64url.
 */
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ciphertext].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  open(sealed: string): string {
    const [version, iv, tag, ciphertext] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || ciphertext === undefined) throw new Error('Unrecognised sealed value');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  }
}
