import type { Pool } from 'pg';
import {
  DuplicateEmailError,
  type NewSession,
  type NewUser,
  type SessionRecord,
  type SessionRepository,
  type UserRecord,
  type UserRepository,
} from './types';

const PG_UNIQUE_VIOLATION = '23505';

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

const USER_COLUMNS = 'id, name, email, password_hash, created_at';
const SESSION_COLUMNS = 'id, user_id, token_hash, created_at, expires_at, revoked_at';

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly pool: Pool) {}

  async findByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
      [id],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async create(user: NewUser): Promise<UserRecord> {
    try {
      const { rows } = await this.pool.query<UserRow>(
        `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)
         RETURNING ${USER_COLUMNS}`,
        [user.name, user.email, user.passwordHash],
      );
      return toUser(rows[0]);
    } catch (err) {
      // Two concurrent signups can both pass the pre-check; the unique index decides.
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) throw new DuplicateEmailError();
      throw err;
    }
  }
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly pool: Pool) {}

  async create(session: NewSession): Promise<SessionRecord> {
    const { rows } = await this.pool.query<SessionRow>(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)
       RETURNING ${SESSION_COLUMNS}`,
      [session.userId, session.tokenHash, session.expiresAt],
    );
    return toSession(rows[0]);
  }

  async findActiveByTokenHash(tokenHash: string, now: Date): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [tokenHash, now],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async revokeByTokenHash(tokenHash: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash, now],
    );
  }
}
