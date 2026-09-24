import { randomUUID } from 'node:crypto';
import {
  DuplicateEmailError,
  type NewSession,
  type NewUser,
  type SessionRecord,
  type SessionRepository,
  type UserRecord,
  type UserRepository,
} from './types';

/** In-memory implementations used by the test suite. */
export class InMemoryUserRepository implements UserRepository {
  readonly users = new Map<string, UserRecord>();

  async findByEmail(email: string): Promise<UserRecord | null> {
    const needle = email.toLowerCase();
    for (const user of this.users.values()) {
      if (user.email.toLowerCase() === needle) return { ...user };
    }
    return null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const user = this.users.get(id);
    return user ? { ...user } : null;
  }

  async create(user: NewUser): Promise<UserRecord> {
    if (await this.findByEmail(user.email)) throw new DuplicateEmailError();
    const record: UserRecord = { id: randomUUID(), createdAt: new Date(), ...user };
    this.users.set(record.id, record);
    return { ...record };
  }
}

export class InMemorySessionRepository implements SessionRepository {
  readonly sessions = new Map<string, SessionRecord>();

  async create(session: NewSession): Promise<SessionRecord> {
    const record: SessionRecord = {
      id: randomUUID(),
      createdAt: new Date(),
      revokedAt: null,
      ...session,
    };
    this.sessions.set(record.tokenHash, record);
    return { ...record };
  }

  async findActiveByTokenHash(tokenHash: string, now: Date): Promise<SessionRecord | null> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt || session.expiresAt <= now) return null;
    return { ...session };
  }

  async revokeByTokenHash(tokenHash: string, now: Date): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session && !session.revokedAt) session.revokedAt = now;
  }
}
