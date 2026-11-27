// Autenticação: hash de senha (scrypt), sessões por cookie e bloqueio por tentativas
import { scryptSync, randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto';
import { db } from './db.js';

const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const COOKIE_NAME = 'fbsid';
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export const MIN_PASSWORD_LENGTH = 8;

// ---------- Senhas ----------

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [algo, saltB64, hashB64] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return 'A senha deve ter letras e números.';
  }
  return null;
}

export function generateTempPassword() {
  // 12 caracteres legíveis (sem 0/O, 1/l/I), sempre com letras e números
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  for (;;) {
    let out = '';
    for (let i = 0; i < 12; i++) out += alphabet[randomInt(alphabet.length)];
    if (/[A-Za-z]/.test(out) && /\d/.test(out)) return out;
  }
}

// ---------- Bloqueio por tentativas (memória) ----------

const attempts = new Map(); // chave -> { count, lockedUntil }

export function isLocked(key) {
  const a = attempts.get(key);
  return a && a.lockedUntil && a.lockedUntil > Date.now();
}

export function registerFailure(key) {
  const a = attempts.get(key) || { count: 0, lockedUntil: 0 };
  a.count += 1;
  if (a.count >= MAX_ATTEMPTS) {
    a.lockedUntil = Date.now() + LOCK_MINUTES * 60_000;
    a.count = 0;
  }
  attempts.set(key, a);
}

export function clearFailures(key) {
  attempts.delete(key);
}

// ---------- Sessões ----------

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES (?, ?, datetime('now', ?))`
  ).run(sha256(token), userId, `+${SESSION_HOURS} hours`);
  return token;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function destroyUserSessions(userId, exceptToken) {
  if (exceptToken) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, sha256(exceptToken));
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

export function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.username, u.name, u.role, u.active, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')`
  ).get(sha256(token));
  if (!row || !row.active) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    mustChangePassword: !!row.must_change_password,
  };
}

export function readSessionCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionCookie(token) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

// ---------- Primeiro administrador ----------

/** Cria o administrador inicial se o banco não tiver nenhum usuário. */
export function ensureInitialAdmin() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return null;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || generateTempPassword();
  db.prepare(
    `INSERT INTO users (username, name, password_hash, role, must_change_password)
     VALUES (?, 'Administrador', ?, 'admin', 1)`
  ).run(username, hashPassword(password));
  return { username, password, fromEnv: !!process.env.ADMIN_PASSWORD };
}
