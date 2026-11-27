// Reimporta os arquivos de knowledge/ para o banco.
// Uso: npm run kb:import            -> só adiciona documentos novos
//      npm run kb:import -- --force -> também atualiza documentos vindos de arquivo
//                                      (edições feitas pelo painel admin nunca são sobrescritas)
import { importKnowledgeFiles } from '../src/knowledge.js';

const overwrite = process.argv.includes('--force');
const r = importKnowledgeFiles({ overwrite });
console.log(`Arquivos lidos: ${r.files} | novos: ${r.inserted} | atualizados: ${r.updated}`);
