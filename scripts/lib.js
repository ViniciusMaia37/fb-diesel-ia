// Utilitários dos scripts (rodam no seu computador, com Node.js)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DB_NAME = 'fb-diesel-ia';

/** Escapa um valor para SQL (texto entre aspas simples ou NULL). */
export function sql(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Lê --local / --remote e o opcional --persist-to <pasta> da linha de comando. */
export function targetArgs(argv = process.argv.slice(2)) {
  const out = [];
  if (argv.includes('--remote')) out.push('--remote');
  else out.push('--local');
  const i = argv.indexOf('--persist-to');
  if (i >= 0 && argv[i + 1]) out.push('--persist-to', argv[i + 1]);
  return out;
}

export function runWrangler(args, { quiet = false } = {}) {
  const bin = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd: ROOT,
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    if (quiet) process.stderr.write(r.stdout + r.stderr);
    throw new Error(`wrangler terminou com erro (código ${r.status})`);
  }
  return r;
}

/** Executa um bloco SQL no banco D1 (local ou remoto) via arquivo temporário. */
export function executeSql(sqlText, target, opts) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fbdiesel-sql-'));
  const file = path.join(dir, 'run.sql');
  writeFileSync(file, sqlText, 'utf8');
  try {
    return runWrangler(['d1', 'execute', DB_NAME, ...target, `--file=${file}`], opts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
