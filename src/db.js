// Banco de dados local (SQLite embutido no Node.js - sem dependências externas)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT_DIR, 'data', 'fb-diesel.db');
mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    username              TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name                  TEXT NOT NULL,
    password_hash         TEXT NOT NULL,
    role                  TEXT NOT NULL DEFAULT 'consultor' CHECK (role IN ('admin', 'consultor')),
    active                INTEGER NOT NULL DEFAULT 1,
    must_change_password  INTEGER NOT NULL DEFAULT 1,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at         TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT 'Nova conversa',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content          TEXT NOT NULL,
    sources          TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);

  CREATE TABLE IF NOT EXISTS documents (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    slug           TEXT NOT NULL UNIQUE,
    title          TEXT NOT NULL,
    category       TEXT NOT NULL DEFAULT 'Geral',
    source         TEXT,
    url            TEXT,
    verified_at    TEXT,
    content        TEXT NOT NULL,
    origin         TEXT NOT NULL DEFAULT 'arquivo' CHECK (origin IN ('arquivo', 'admin')),
    deleted        INTEGER NOT NULL DEFAULT 0,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
`);

// Remove sessões expiradas a cada inicialização
db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();

/** Executa uma função dentro de uma transação. */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
