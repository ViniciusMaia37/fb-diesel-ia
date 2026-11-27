// Envia os arquivos de knowledge/ para o banco D1.
// Uso: npm run kb:sync:remote            -> só adiciona documentos novos
//      npm run kb:sync:remote -- --force -> também atualiza documentos vindos de arquivo
// Documentos editados pelo painel admin (ou excluídos por ele) nunca são sobrescritos.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseMarkdown } from '../src/knowledge.js';
import { ROOT, sql, targetArgs, executeSql } from './lib.js';

const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');
const force = process.argv.includes('--force');
const target = targetArgs();

function listMarkdown(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return listMarkdown(full);
    return name.toLowerCase().endsWith('.md') ? [full] : [];
  });
}

const files = listMarkdown(KNOWLEDGE_DIR).sort();
const statements = files.map((file) => {
  const slug = path.relative(KNOWLEDGE_DIR, file).replace(/\\/g, '/').replace(/\.md$/i, '');
  const { meta, body } = parseMarkdown(readFileSync(file, 'utf8'));
  const values = [slug, meta.titulo || slug, meta.categoria || 'Geral', meta.fonte, meta.url, meta.verificado_em, body];
  const onConflict = force
    ? `ON CONFLICT(slug) DO UPDATE SET title = excluded.title, category = excluded.category, source = excluded.source,
         url = excluded.url, verified_at = excluded.verified_at, content = excluded.content, updated_at = datetime('now')
       WHERE documents.origin = 'arquivo'`
    : 'ON CONFLICT(slug) DO NOTHING';
  return `INSERT INTO documents (slug, title, category, source, url, verified_at, content, origin)
VALUES (${values.map(sql).join(', ')}, 'arquivo')
${onConflict};`;
});
statements.push(`UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'kb_version';`);

console.log(`Enviando ${files.length} documento(s) para o banco ${target.includes('--remote') ? 'NA NUVEM' : 'local'}${force ? ' (atualizando os existentes)' : ''}…`);
executeSql(statements.join('\n\n'), target, { quiet: true });
console.log('Base de conhecimento sincronizada.');
