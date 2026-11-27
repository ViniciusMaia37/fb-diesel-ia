// Recupera o acesso de administrador (rodar no servidor, com acesso ao banco local).
// Uso: npm run admin:reset -- <usuario>
// Gera uma senha provisória, reativa o usuário como administrador e exige troca no próximo login.
import { db } from '../src/db.js';
import { hashPassword, generateTempPassword, destroyUserSessions } from '../src/auth.js';

const username = process.argv[2] || process.env.ADMIN_USERNAME || 'admin';
const password = generateTempPassword();
const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);

if (user) {
  db.prepare(`UPDATE users SET password_hash = ?, role = 'admin', active = 1, must_change_password = 1 WHERE id = ?`)
    .run(hashPassword(password), user.id);
  destroyUserSessions(user.id);
} else {
  db.prepare(`INSERT INTO users (username, name, password_hash, role, must_change_password) VALUES (?, 'Administrador', ?, 'admin', 1)`)
    .run(username, hashPassword(password));
}
console.log(`Administrador "${username}" com senha provisória: ${password}`);
console.log('A troca de senha será exigida no próximo login.');
