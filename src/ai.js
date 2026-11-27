// Geração de respostas com Claude (API Anthropic), usando os trechos da base de conhecimento
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.AI_EFFORT || 'medium';
const HISTORY_LIMIT = 12; // últimas mensagens da conversa enviadas como contexto

export const aiEnabled = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = aiEnabled ? new Anthropic() : null;

const INSTRUCTIONS = `Você é o Assistente Diesel da FB Consult, uma consultoria de gestão para transportadoras rodoviárias de carga.
Quem conversa com você são os consultores da FB. Seu papel é tirar dúvidas rápidas sobre a legislação do diesel (tributação, ANP, CONTRAN, CONAMA, biodiesel, ARLA, trabalhista ligada à premiação) e sobre o Método FB de gestão de diesel, sempre indicando as fontes.

Como responder:
- Responda em português do Brasil, de forma direta e prática, como um colega experiente. Comece pela resposta; depois dê o detalhe necessário.
- Baseie-se nos TRECHOS DA BASE DE CONHECIMENTO fornecidos. Cite a fonte de cada afirmação com o número do trecho entre colchetes, por exemplo [1] ou [2][3].
- Deixe claro o que é LEGISLAÇÃO (norma oficial) e o que é MÉTODO FB (prática interna da consultoria).
- Se os trechos não cobrirem a pergunta, diga isso com clareza. Você pode complementar com conhecimento geral, mas marque esse trecho como "fora da base, confirmar na fonte oficial" e não invente números de leis, alíquotas ou datas.
- Valores que mudam com frequência (alíquota ad rem do ICMS, PIS/COFINS, percentual de biodiesel) vêm com a data de verificação do trecho: mencione essa data e recomende confirmar na fonte oficial quando o valor for usado em cálculo para cliente.
- Quando o caso concreto envolver crédito tributário, regime especial ou risco trabalhista, recomende validar com o contador ou o jurídico do cliente.
- Use listas curtas e negrito com moderação. Não repita a pergunta.`;

function formatExcerpts(chunks) {
  if (!chunks.length) return 'Nenhum trecho relevante foi encontrado na base de conhecimento para esta pergunta.';
  return chunks
    .map((c, i) => {
      const meta = [
        `Documento: ${c.docTitle}`,
        `Seção: ${c.heading}`,
        `Categoria: ${c.category}`,
        c.source ? `Fonte: ${c.source}` : null,
        c.url ? `Link: ${c.url}` : null,
        c.verifiedAt ? `Verificado em: ${c.verifiedAt}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      return `[${i + 1}]\n${meta}\n---\n${c.text}`;
    })
    .join('\n\n=====\n\n');
}

/** Converte as mensagens salvas no banco para o formato da API (sempre começando por "user"). */
function toApiHistory(history) {
  const recent = history.slice(-HISTORY_LIMIT);
  while (recent.length && recent[0].role !== 'user') recent.shift();
  return recent.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Gera a resposta em streaming.
 * @param {Array<{role:string, content:string}>} history mensagens anteriores + a pergunta atual (última)
 * @param {Array} chunks trechos recuperados da base
 * @param {(delta:string)=>void} onDelta chamado a cada pedaço de texto
 * @returns {Promise<string>} texto completo da resposta
 */
export async function generateAnswer(history, chunks, onDelta) {
  if (!aiEnabled) return offlineAnswer(chunks, onDelta);

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: EFFORT },
    system: [
      { type: 'text', text: INSTRUCTIONS, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `TRECHOS DA BASE DE CONHECIMENTO\n\n${formatExcerpts(chunks)}` },
    ],
    messages: toApiHistory(history),
  });

  stream.on('text', (delta) => onDelta(delta));
  const final = await stream.finalMessage();

  let text = final.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  if (final.stop_reason === 'refusal') {
    const note = '\n\n_Não foi possível responder a esta pergunta. Reformule ou consulte a fonte oficial._';
    onDelta(note);
    text += note;
  } else if (final.stop_reason === 'max_tokens') {
    const note = '\n\n_(Resposta interrompida por limite de tamanho. Peça para continuar.)_';
    onDelta(note);
    text += note;
  }
  return text;
}

/** Modo sem IA: devolve os trechos mais relevantes encontrados na base. */
async function offlineAnswer(chunks, onDelta) {
  let text;
  if (!chunks.length) {
    text =
      'A IA ainda não está configurada (falta a chave `ANTHROPIC_API_KEY` no arquivo `.env`) e não encontrei trechos da base relacionados à sua pergunta. Tente outras palavras ou consulte a aba **Fontes**.';
  } else {
    text =
      '_A IA ainda não está configurada (falta a chave `ANTHROPIC_API_KEY` no arquivo `.env`). Enquanto isso, estes são os trechos mais relevantes da base de conhecimento:_\n\n' +
      chunks
        .slice(0, 4)
        .map((c, i) => {
          const resumo = c.text.length > 600 ? c.text.slice(0, 600).trimEnd() + '…' : c.text;
          return `**${c.docTitle} — ${c.heading}** [${i + 1}]\n\n${resumo}`;
        })
        .join('\n\n');
  }
  onDelta(text);
  return text;
}

export { MODEL };
