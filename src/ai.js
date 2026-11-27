// Respostas com a IA gratuita do Cloudflare (Workers AI), usando os trechos da base

const HISTORY_LIMIT = 8; // últimas mensagens enviadas como contexto
const MAX_HISTORY_CHARS = 2000; // corta respostas antigas longas para economizar a cota diária

const INSTRUCTIONS = `Você é o Assistente Diesel da FB Consult, uma consultoria de gestão para transportadoras rodoviárias de carga.
Quem conversa com você são os consultores da FB. Seu papel é tirar dúvidas rápidas sobre a legislação do diesel (tributação, ANP, CONTRAN, CONAMA, biodiesel, ARLA, trabalhista ligada à premiação) e sobre o Método FB de gestão de diesel, sempre indicando as fontes.

Regras:
- Responda SEMPRE em português do Brasil, de forma direta e prática. Comece pela resposta; depois dê o detalhe necessário.
- Use SOMENTE as informações dos TRECHOS DA BASE DE CONHECIMENTO abaixo. Cite a fonte de cada afirmação com o número do trecho entre colchetes, por exemplo [1] ou [2][3].
- Deixe claro o que é LEGISLAÇÃO (norma oficial) e o que é MÉTODO FB (prática interna da consultoria).
- Se os trechos não responderem à pergunta, diga claramente que a base não cobre o assunto e sugira consultar a fonte oficial. Nunca invente números de leis, alíquotas, valores ou datas.
- Para valores que mudam com frequência (ICMS ad rem, PIS/COFINS, percentual de biodiesel), informe a data "Verificado em" do trecho e recomende confirmar na fonte oficial antes de usar com o cliente.
- Em casos concretos de crédito tributário, regime especial ou risco trabalhista, recomende validar com o contador ou o jurídico do cliente.
- Seja conciso: no máximo cerca de 300 palavras, com listas curtas quando ajudar.`;

function formatExcerpts(chunks) {
  if (!chunks.length) return 'Nenhum trecho relevante foi encontrado na base de conhecimento para esta pergunta.';
  return chunks
    .map((c, i) => {
      const meta = [
        `Documento: ${c.docTitle}`,
        `Seção: ${c.heading}`,
        `Categoria: ${c.category}`,
        c.source ? `Fonte: ${c.source}` : null,
        c.verifiedAt ? `Verificado em: ${c.verifiedAt}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      return `[${i + 1}]\n${meta}\n---\n${c.text}`;
    })
    .join('\n\n=====\n\n');
}

function toModelHistory(history) {
  const recent = history.slice(-HISTORY_LIMIT);
  while (recent.length && recent[0].role !== 'user') recent.shift();
  return recent.map((m) => ({
    role: m.role,
    content: m.content.length > MAX_HISTORY_CHARS ? m.content.slice(0, MAX_HISTORY_CHARS) + '…' : m.content,
  }));
}

export function aiEnabled(env) {
  return env.AI_MODE !== 'off' && !!env.AI;
}

/**
 * Gera a resposta em streaming com Workers AI.
 * Lança erro se a IA falhar (por exemplo, cota diária esgotada); quem chama decide o que fazer.
 */
export async function generateAnswer(env, history, chunks, onDelta) {
  const messages = [
    { role: 'system', content: `${INSTRUCTIONS}\n\nTRECHOS DA BASE DE CONHECIMENTO\n\n${formatExcerpts(chunks)}` },
    ...toModelHistory(history),
  ];

  const stream = await env.AI.run(env.AI_MODEL, {
    messages,
    stream: true,
    max_tokens: 1200,
    temperature: 0.2,
  });

  // Workers AI devolve Server-Sent Events: linhas "data: {...}" terminando em "data: [DONE]"
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let piece = '';
      try {
        const obj = JSON.parse(data);
        piece = obj.response ?? obj.choices?.[0]?.delta?.content ?? '';
      } catch {
        continue;
      }
      if (piece) {
        text += piece;
        onDelta(piece);
      }
    }
  }
  return text;
}

/** Sem IA (desligada ou cota esgotada): devolve os trechos mais relevantes da base. */
export function offlineAnswer(chunks, reason) {
  const intro = reason === 'quota'
    ? '_A cota diária gratuita da IA acabou ou a IA está indisponível agora. Enquanto isso, estes são os trechos mais relevantes da base:_'
    : '_A IA está desligada. Estes são os trechos mais relevantes da base de conhecimento:_';
  if (!chunks.length) {
    return `${intro}\n\nNão encontrei trechos da base relacionados à sua pergunta. Tente outras palavras ou consulte a aba **Fontes**.`;
  }
  return (
    `${intro}\n\n` +
    chunks
      .slice(0, 4)
      .map((c, i) => {
        const resumo = c.text.length > 600 ? c.text.slice(0, 600).trimEnd() + '…' : c.text;
        return `**${c.docTitle} — ${c.heading}** [${i + 1}]\n\n${resumo}`;
      })
      .join('\n\n')
  );
}
