# FB Consult · Assistente Diesel

Chatbot com IA para os consultores da **FB Consult** tirarem dúvidas rápidas sobre a **legislação do diesel** e o **Método FB de gestão de diesel**, sempre com a fonte de cada informação. Roda como um site, aberto por um link no navegador, hospedado **gratuitamente no Cloudflare**.

- **Login e senha**, com perfis de **administrador** e **consultor**. O administrador cria os usuários e gera senhas provisórias; a troca é obrigatória no primeiro acesso.
- **Banco de dados** Cloudflare D1 (SQLite): usuários, sessões, histórico de conversas e base de conhecimento.
- **Histórico de conversas** como num chatbot tradicional: lista lateral, busca, renomear e excluir.
- **Fontes**: cada resposta mostra os documentos consultados, com link oficial e data da última verificação.
- **Painel do administrador**: usuários (criar, editar, desativar, nova senha, excluir) e documentos da base (criar e editar sem mexer em código).
- **IA gratuita** (Workers AI). Quando a cota diária acaba, o chat continua respondendo com os trechos da base.
- Frontend em **HTML, CSS e JavaScript puros**, no padrão visual da plataforma FB.

## Custo: zero

Tudo roda no **plano gratuito (Free) do Cloudflare**, que não pede cartão de crédito:

| Serviço | Limite gratuito |
|---|---|
| Workers (servidor) | 100 mil acessos por dia |
| D1 (banco) | 5 GB de armazenamento |
| Workers AI (IA) | Cota diária de uso (renova todo dia às 21h de Brasília / 00h UTC) |

Ao atingir um limite no plano gratuito, o serviço para de responder até o dia seguinte. **Não há cobrança.**

> **Não assine o plano "Workers Paid"** (US$ 5/mês). Nele, o uso acima da cota passa a ser cobrado.

## Publicar pela primeira vez

Pré-requisitos: [Node.js](https://nodejs.org) 22.13 ou superior e uma conta gratuita no [Cloudflare](https://dash.cloudflare.com/sign-up).

```bash
npm install

# 1. Login no Cloudflare (abre o navegador para você autorizar)
npx wrangler login

# 2. Criar o banco de dados
npx wrangler d1 create fb-diesel-ia
#    -> copie o "database_id" mostrado e cole no wrangler.jsonc (seção d1_databases)

# 3. Criar as tabelas, enviar a base de conhecimento e criar o administrador
npm run db:migrate:remote
npm run kb:sync:remote
npm run admin:create:remote      # mostra a senha provisória do "admin" no terminal

# 4. Publicar o site
npm run deploy                   # mostra o link: https://fb-diesel-ia.<sua-conta>.workers.dev
```

Abra o link, entre com `admin` e a senha provisória e troque a senha. Depois, vá em **Administração → Novo usuário** para cadastrar os consultores.

### Atualizações

- **Código ou telas:** `npm run deploy`
- **Base de conhecimento (arquivos em `knowledge/`):** `npm run kb:sync:remote -- --force`. Documentos editados pelo painel admin nunca são sobrescritos.
- **Recuperar o acesso de administrador:** `npm run admin:create:remote -- admin`

### Endereço próprio (opcional)

Para usar algo como `diesel.fbconsult.com.br`, o domínio precisa estar no Cloudflare. Depois, no painel: **Workers & Pages → fb-diesel-ia → Settings → Domains & Routes → Add → Custom domain**.

## Base de conhecimento

Os documentos ficam em `knowledge/` como Markdown com cabeçalho:

```markdown
---
titulo: ICMS monofásico sobre o diesel
categoria: Tributário
fonte: Lei Complementar nº 192/2022
url: https://www.planalto.gov.br/...
verificado_em: 2026-11-27
---

## Título da seção
Texto…
```

- `knowledge/legislacao/`: legislação pública (ICMS monofásico, PIS/COFINS, Reforma Tributária, biodiesel, especificação ANP, tanque interno, CONTRAN, ARLA/PROCONVE, preços ANP, Lei do Motorista, fontes oficiais).
- `knowledge/interno/`: **Método FB**. Fica **fora do Git** por padrão (ver `.gitignore`), mas é enviado ao banco pelo `kb:sync`.

> Valores como ICMS ad rem, PIS/COFINS e percentual de biodiesel mudam com frequência. Revise a base periodicamente e atualize `verificado_em`.

### Como a IA responde

1. A pergunta é buscada na base (BM25, com tratamento de acentos e plurais em português).
2. Os 6 trechos mais relevantes vão para o modelo de IA com as instruções: responder em português, citar cada afirmação com [n], separar *legislação* de *Método FB* e não inventar números de leis.
3. A resposta chega em tempo real e fica salva no histórico com a lista de fontes.

O modelo é definido em `AI_MODEL` no `wrangler.jsonc` (padrão: Llama 3.3 70B). Um modelo menor, como `@cf/meta/llama-3.1-8b-instruct-fast`, gasta menos da cota diária e permite mais respostas por dia, com qualidade menor. Para desligar a IA, use `AI_MODE: "off"`.

## Desenvolvimento local

```bash
npm run setup:local                 # tabelas + base + admin no banco local
npx wrangler dev --env test         # site em http://localhost:8787, sem IA, sem login no Cloudflare
npm test                            # testes automatizados
```

`npx wrangler dev` (sem `--env test`) usa a IA real e exige o login no Cloudflare.

## Segurança

- Senhas com hash **PBKDF2-SHA256** e salt aleatório. Senhas provisórias aparecem uma única vez.
- Sessão em cookie `HttpOnly` + `Secure` + `SameSite=Strict`. Bloqueio de 15 minutos após 5 tentativas erradas.
- Cada consultor só vê as próprias conversas. Desativar um usuário encerra as sessões dele na hora.
- HTTPS automático pelo Cloudflare e cabeçalhos de segurança (CSP, HSTS, X-Frame-Options) em `public/_headers`.

**Backup:** `npx wrangler d1 export fb-diesel-ia --remote --output backup.sql`. O D1 também guarda 30 dias de histórico (Time Travel).

## Estrutura

```
src/worker.js          API (rotas) no Cloudflare Workers
src/auth.js            senhas e tokens (Web Crypto)
src/knowledge.js       leitura do Markdown e busca BM25
src/ai.js              Workers AI (streaming e citações)
public/                telas (HTML, CSS, JS) e cabeçalhos de segurança
migrations/            tabelas do banco D1
knowledge/             base de conhecimento em Markdown
scripts/               sincronizar a base e criar administrador
wrangler.jsonc         configuração do Cloudflare
test/                  testes automatizados
```
