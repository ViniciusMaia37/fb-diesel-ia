// Cria (ou recupera) um administrador no banco D1 com senha provisória.
// Uso: npm run admin:create:remote              -> usuário "admin"
//      npm run admin:create:remote -- maria.souza
// A senha provisória é gerada aqui no seu computador e mostrada só no terminal;
// o banco guarda apenas o hash. A troca de senha é exigida no primeiro login.
import { hashPassword, generateTempPassword, validatePassword } from '../src/auth.js';
import { sql, targetArgs, executeSql } from './lib.js';

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--persist-to');
const username = (positional[0] || 'admin').toLowerCase();
const password = process.env.ADMIN_PASSWORD || generateTempPassword();
const target = targetArgs(args);

if (!/^[a-z0-9._-]{3,60}$/.test(username)) {
  console.error('Usuário inválido: use de 3 a 60 caracteres (letras, números, ponto, hífen ou sublinhado).');
  process.exit(1);
}
const problem = validatePassword(password);
if (problem) {
  console.error(problem);
  process.exit(1);
}

const hash = await hashPassword(password);
executeSql(
  `INSERT INTO users (username, name, password_hash, role, active, must_change_password)
VALUES (${sql(username)}, 'Administrador', ${sql(hash)}, 'admin', 1, 1)
ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', active = 1, must_change_password = 1;
DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ${sql(username)});`,
  target,
  { quiet: true }
);

console.log('\n================ ACESSO DE ADMINISTRADOR ================');
console.log(`Banco:            ${target.includes('--remote') ? 'NA NUVEM (Cloudflare)' : 'local (teste)'}`);
console.log(`Usuário:          ${username}`);
console.log(`Senha provisória: ${password}`);
console.log('A troca de senha será exigida no primeiro login.');
console.log('==========================================================\n');
