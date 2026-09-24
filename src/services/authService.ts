import { createHash, randomBytes } from 'node:crypto';
import { Errors } from '../errors';
import { DuplicateEmailError, type SessionRepository, type UserRecord, type UserRepository } from '../repositories/types';
import type { LoginInput, SignupInput } from '../validation/schemas';
import type { PasswordHasher } from './password';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface IssuedSession {
  user: PublicUser;
  token: string;
  expiresAt: Date;
}

export interface AuthServiceOptions {
  sessionTtlMs: number;
  now?: () => Date;
}

/** Strips everything that must never leave the service, notably the password hash. */
export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class AuthService {
  private readonly now: () => Date;

  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly passwords: PasswordHasher,
    private readonly options: AuthServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async signup(input: SignupInput): Promise<PublicUser> {
    if (await this.users.findByEmail(input.email)) throw Errors.emailTaken();

    const passwordHash = await this.passwords.hash(input.password);
    try {
      const user = await this.users.create({ name: input.name, email: input.email, passwordHash });
      return toPublicUser(user);
    } catch (err) {
      if (err instanceof DuplicateEmailError) throw Errors.emailTaken();
      throw err;
    }
  }

  async login(input: LoginInput): Promise<IssuedSession> {
    const user = await this.users.findByEmail(input.email);
    const valid = user
      ? await this.passwords.verify(input.password, user.passwordHash)
      : await this.passwords.verifyAgainstDummy(input.password);
    // Same error for unknown email and wrong password, to avoid account enumeration.
    if (!user || !valid) throw Errors.invalidCredentials();

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + this.options.sessionTtlMs);
    await this.sessions.create({ userId: user.id, tokenHash: hashToken(token), expiresAt });
    return { user: toPublicUser(user), token, expiresAt };
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.sessions.revokeByTokenHash(hashToken(token), this.now());
  }

  /** Resolves a session token to its user, or null if the token is missing, expired or revoked. */
  async authenticate(token: string | undefined): Promise<PublicUser | null> {
    if (!token) return null;
    const session = await this.sessions.findActiveByTokenHash(hashToken(token), this.now());
    if (!session) return null;
    const user = await this.users.findById(session.userId);
    return user ? toPublicUser(user) : null;
  }
}
