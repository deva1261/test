export interface UserRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface NewUser {
  name: string;
  email: string;
  passwordHash: string;
}

export interface NewSession {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  /** Throws DuplicateEmailError if the email is already registered. */
  create(user: NewUser): Promise<UserRecord>;
}

export interface SessionRepository {
  create(session: NewSession): Promise<SessionRecord>;
  /** Returns the session only if it is neither revoked nor expired at `now`. */
  findActiveByTokenHash(tokenHash: string, now: Date): Promise<SessionRecord | null>;
  revokeByTokenHash(tokenHash: string, now: Date): Promise<void>;
}

export class DuplicateEmailError extends Error {
  constructor() {
    super('Email already registered');
    this.name = 'DuplicateEmailError';
  }
}
