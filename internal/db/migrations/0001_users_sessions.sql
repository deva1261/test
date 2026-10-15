-- ENT-001 User <- REQ-002, REQ-003
create table users (
    id             uuid not null,
    name           text not null,
    email          text not null,
    password_hash  text not null,  -- bcrypt hash, never plain text
    created_at     timestamptz not null default now(),
    primary key (id)
);

-- ENT-002 Session <- REQ-005, REQ-007
create table sessions (
    id          uuid not null,
    user_id     uuid not null,
    token_hash  text not null,  -- SHA-256 (hex) of the opaque session token
    expires_at  timestamptz not null,
    created_at  timestamptz not null default now(),
    primary key (id)
);

-- REL-001 Session -> User, many-to-one. Deleting a user removes their sessions.
alter table sessions add constraint sessions_user_id_fkey
    foreign key (user_id) references users (id) on delete cascade;
create unique index users_email_key on users (email);
create unique index sessions_token_hash_key on sessions (token_hash);
create index sessions_user_id_idx on sessions (user_id);
