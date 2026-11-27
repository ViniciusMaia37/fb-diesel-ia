# Planejamento em equipe: Assistente Diesel FB com Supabase

## Contexto

Na mentoria, o mentor propôs trocar o banco do projeto `fb-diesel-ia` pelo **Supabase**. O objetivo principal é **praticar desenvolvimento em equipe**:

- Vinicius e Felipe trabalham cada um com o seu Claude Code.
- Cada entrega chega por **pull request** no GitHub.
- O **instrutor** é o aprovador obrigatório e o responsável pelo deploy da `main`.

Estado atual do projeto: Cloudflare Workers + D1 + Workers AI, com login próprio e 4 testes passando. O commit da versão Cloudflare (`212ec1c`) **ainda não foi enviado** ao GitHub. A `main` remota ainda tem a versão Node.js.

Decisões tomadas:

| Tema | Decisão |
|---|---|
| Divisão | **Vinicius:** base de dados + login. **Felipe:** IA embarcada |
| GitHub | Repositório **público**, com a `main` protegida (aprovação obrigatória do instrutor) |
| Login | **E-mail e senha** com Supabase Auth |
| Hospedagem | **Cloudflare Workers**, com deploy automático pelo GitHub Actions no merge da `main` |
| Custo | Zero: Supabase Free, Cloudflare Free, GitHub público e Actions gratuito |

## Arquitetura alvo

```
Navegador (public/: HTML/CSS/JS, sem mudança de visual)
   │  cookie HttpOnly com a sessão do Supabase
   ▼
Cloudflare Worker (src/worker.js: rotas)
   ├── src/auth/  (Vinicius)  login, sessão, troca de senha, admin de usuários → Supabase Auth
   ├── src/db/    (Vinicius)  repositórios: conversas, mensagens, documentos → Supabase Postgres (RLS)
   └── src/ia/    (Felipe)    indexação, busca vetorial, resposta em streaming → Workers AI + pgvector
```

- **Supabase Postgres:**
  - tabelas `profiles`, `conversations`, `messages`, `documents` e `document_chunks` (`embedding vector(1024)`);
  - **RLS**: cada consultor só lê as próprias conversas, e só o admin altera documentos.
- **Supabase Auth:**
  - e-mail e senha, com cadastro público **desligado**;
  - o admin cria os usuários pelo Worker com a *service role*;
  - "desativar usuário" usa o bloqueio (*ban*) do Supabase;
  - o aviso de "troca obrigatória de senha" fica em `profiles.deve_trocar_senha`.
- **Busca:** híbrida, combinando vetor (embeddings `@cf/baai/bge-m3`, multilíngue) com texto completo em português, numa função SQL `buscar_trechos`.
- **Segredos:**
  - `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` ficam em `.dev.vars` (local, fora do Git) e em *secrets* do Cloudflare e do GitHub (produção);
  - a *service role* nunca chega ao navegador.
- **Ambientes Supabase:**
  - **dev**: projeto do Vinicius, compartilhado com o Felipe;
  - **prod**: projeto do instrutor.
- **Cloudflare:** cada um usa a própria conta gratuita para testar a IA localmente. A conta de **produção é do instrutor**.

## Código atual que será reaproveitado

| Arquivo | O que reaproveitar | Quem |
|---|---|---|
| `src/knowledge.js` | `parseMarkdown`, `tokenize`, `splitIntoChunks` (exportar) | Felipe |
| `src/ai.js` | `INSTRUCTIONS`, `generateAnswer` (streaming), `offlineAnswer` (plano B quando a cota acaba) | Felipe |
| `src/auth.js` | `validatePassword`, `generateTempPassword` | Vinicius |
| `src/worker.js` | roteador, `HttpError`, `json`, `readJson`, rota SSE do chat | ambos (etapa 5) |
| `public/` | todas as telas. Muda só o login (e-mail) e o painel admin | Vinicius |
| `test/app.test.js` | padrão de teste de ponta a ponta | ambos |
| `knowledge/` | os 14 documentos da base | Felipe (indexação) |

Será removido: o banco D1 (`migrations/0001_schema.sql`), as sessões e o hash PBKDF2 próprios e os scripts `kb-sync.js` e `create-admin.js` (substituídos por versões para o Supabase).

## Regras do fluxo de trabalho (valem para todas as etapas)

1. **Uma tarefa = uma issue = uma branch = um PR pequeno.** Nomes de branch: `feat/banco-...`, `feat/login-...`, `feat/ia-...`, `chore/...`.
2. **Ninguém faz push na `main`.** A regra do GitHub exige:
   - PR;
   - CI verde;
   - aprovação do **instrutor** (CODEOWNERS);
   - histórico linear.
3. **Revisão em dois níveis:** o colega revisa e comenta primeiro. Depois o instrutor aprova e faz o merge.
4. **Antes de abrir o PR:** rodar `npm test` e `/code-review` no Claude Code, e preencher o template do PR (o que mudou, como testar, prints).
5. **Cada um só altera a própria pasta** (`src/db` + `src/auth` = Vinicius; `src/ia` = Felipe). Arquivos compartilhados (`src/worker.js`, `public/js/app.js`, `docs/contratos.md`) só mudam com aviso ao colega no PR.
6. **Migrações do banco** ficam em `supabase/migrations/` e são nomeadas por data e hora, para não haver conflito entre os dois. Toda migração passa por revisão do Vinicius.
7. **Segredos nunca vão para o Git.** O CI roda um verificador de segredos (gitleaks).
8. **O `CLAUDE.md` do projeto** dá as mesmas regras aos dois Claudes: pt-BR, branches, testes e o que cada um não deve tocar.

## Etapas

### Etapa 0: Preparação do repositório e das contas
**Responsáveis:** Vinicius (dono do repositório) e instrutor. **Sem código de produto.**

1. **Vinicius:** auditar o histórico do Git antes de deixar o repositório público (gitleaks em todo o histórico). Confirmar que nenhum `.env`, banco ou `knowledge/interno/` foi enviado.
2. **Vinicius:** enviar a versão Cloudflare (`212ec1c`) numa branch e abrir o **PR #1 "Base Cloudflare"**. É o primeiro PR aprovado pelo instrutor.
3. **Vinicius:** tornar o repositório público e convidar Felipe e o instrutor como colaboradores.
4. **Instrutor:** criar o *ruleset* da `main`:
   - exigir PR;
   - 1 aprovação;
   - revisão do CODEOWNERS;
   - status check `CI`;
   - bloquear *force push* e exclusão;
   - sem exceções.
5. **Contas gratuitas:**
   - Supabase **dev** (Vinicius, com Felipe convidado);
   - Supabase **prod** (instrutor);
   - Cloudflare (cada um a sua; a de produção é do instrutor).

**Teste da etapa:** tentar `git push origin main` direto. Tem que ser recusado. Um PR sem aprovação do instrutor não pode ser mesclado.

### Etapa 1: Fundação da equipe (PR #2)
**Responsável:** Vinicius escreve, Felipe revisa.

- `CLAUDE.md` do projeto (regras acima e comandos), `.github/pull_request_template.md`, `.github/CODEOWNERS` (`* @<instrutor>`).
- `.github/workflows/ci.yml`: `npm ci`, testes de unidade e gitleaks em todo PR.
- `docs/arquitetura.md` e **`docs/contratos.md`** com as funções que cada lado expõe, para os dois trabalharem em paralelo:
  - `src/auth`: `exigirUsuario(request, env)` retorna `{ id, email, nome, papel, deveTrocarSenha, accessToken }`; e `exigirAdmin(...)`.
  - `src/db`: `conversas.{listar, criar, obter, renomear, excluir}`, `mensagens.{listar, inserir}`, `documentos.{listar, obter, salvar, excluir}`.
  - `src/ia`: `indexarDocumento(env, doc)`, `buscarTrechos(env, pergunta, { limite })`, `gerarResposta(env, historico, trechos, aoReceberTexto)`.
- Pastas `src/db`, `src/auth` e `src/ia`, com **versões provisórias (stubs)** de cada contrato, além de `.dev.vars.example` e `@supabase/supabase-js` como dependência.

**Testes:** o CI roda e passa. Os stubs têm testes mínimos que confirmam o formato de retorno.

### Etapa 2: Base de dados (Vinicius)

| PR | Entrega | Testes |
|---|---|---|
| 2a | Migração: `profiles`, `conversations`, `messages`, `documents`, gatilho que cria o `profile` ao criar o usuário, função `is_admin()` e políticas RLS | Teste de integração com 2 usuários de teste no Supabase dev: A não lê conversa de B, consultor não altera documento, admin altera |
| 2b | Repositórios em `src/db` cumprindo o contrato | Unidade (validações) e integração (criar, listar, excluir conversa, apagar em cascata) |
| 2c | Script `npm run base:importar`: lê `knowledge/*.md` e grava em `documents` (reaproveita `parseMarkdown`) | Reimportar duas vezes não duplica. Edição feita pelo painel não é sobrescrita |

**O 2a é o primeiro PR depois da etapa 1**, porque o Felipe depende da tabela `documents`.

### Etapa 3: Login (Vinicius)

| PR | Entrega | Testes |
|---|---|---|
| 3a | Rotas `/api/auth/*`: login (`signInWithPassword`), sessão em cookie HttpOnly com renovação automática do token, logout, `me` e troca de senha. Configuração do Supabase: cadastro público desligado e senha mínima de 8 caracteres | Unidade (cookie, validação de senha). Integração: login certo e errado, senha provisória bloqueia o resto, token expirado é renovado |
| 3b | Admin de usuários: criar (service role, senha provisória), desativar (*ban*), nova senha, excluir. Pelo menos um admin ativo é obrigatório | Integração: consultor recebe 403 no admin, desativado perde acesso na hora, não dá para excluir o último admin |
| 3c | Telas: login por e-mail, troca de senha e painel admin (campo e-mail) em `public/` | Manual no navegador (desktop e celular) com checklist no PR |

### Etapa 4: IA embarcada (Felipe)
Pode começar **em paralelo** às etapas 2b e 3. O 4b pode começar antes do 2a ser mesclado, porque o *chunking* não depende do banco.

| PR | Entrega | Testes |
|---|---|---|
| 4a | Migração: extensão `pgvector`, tabela `document_chunks`, índice vetorial e índice de texto em português, função `buscar_trechos` (híbrida) | Integração: a função devolve trechos ordenados por relevância. Consultor só lê, não grava |
| 4b | `src/ia/indexacao.js`: divide em trechos (reaproveita `splitIntoChunks`), gera embeddings com Workers AI `@cf/baai/bge-m3` e grava os trechos. Reindexa ao salvar um documento e tem o comando "reindexar tudo" | Unidade: divisão em trechos (títulos `##`, tamanho máximo) |
| 4c | `src/ia/busca.js` e `src/ia/resposta.js`: busca híbrida e resposta em streaming (reaproveita `generateAnswer` e o plano B `offlineAnswer` quando a cota acaba) | Unidade: leitura do streaming com um stream falso; plano B quando a IA falha. **Conjunto de avaliação:** 15 perguntas reais com o documento esperado entre os 3 primeiros (meta: pelo menos 13 de 15) |

### Etapa 5: Integração (Vinicius + Felipe juntos, em par)
- PR conjunto que liga as rotas de `src/worker.js` aos módulos reais e remove o código D1 antigo e os stubs.
- **Teste de ponta a ponta** (adaptar `test/app.test.js`) contra o Supabase dev:
  - login, troca de senha, criação de consultor;
  - pergunta com resposta e fontes, histórico salvo;
  - isolamento entre usuários, desativação.
- Teste manual no navegador com a IA real (`wrangler dev`, cada um com a própria conta Cloudflare).

### Etapa 6: Deploy (instrutor)
1. Felipe (ou Vinicius) abre o PR com `.github/workflows/deploy.yml`, disparado no merge da `main`:
   - `supabase db push` (aplica as migrações em prod);
   - `wrangler deploy`;
   - reindexação da base.
2. **Instrutor:** cadastra os *secrets* no GitHub (`CLOUDFLARE_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`) e os *secrets* do Worker (`wrangler secret put`). Depois aprova e faz o merge.
3. **Instrutor:** cria o primeiro admin de produção (script com a service role) e entrega o link e o acesso.

**Teste:** a execução do deploy fica verde no Actions, o site abre pelo link e o checklist de ponta a ponta passa em produção.

## Ordem e paralelismo

```
Etapa 0 ─► Etapa 1 ─► 2a (Vinicius) ─┬─► 2b ─► 2c ─► 3a ─► 3b ─► 3c ──┐
                                      └─► 4a ─► 4b ─► 4c (Felipe) ──────┴─► Etapa 5 ─► Etapa 6
                         (Felipe pode adiantar o 4b logo após a Etapa 1)
```

## Pontos de atenção

- **Supabase Free pausa o projeto após 7 dias sem uso.** Basta reativar no painel. Não há cobrança.
- **Cota diária do Workers AI:** os embeddings da base são baratos (uma vez por documento), e o chat continua com o plano B quando a cota acaba.
- **Conteúdo interno (`knowledge/interno/`)** continua fora do Git público. Na produção, o instrutor importa esses arquivos pelo script, a partir de uma cópia local.
- **Visual e funcionalidades** continuam iguais. Muda só o login (e-mail no lugar do nome de usuário).

## Acompanhamento

Cada PR deste planejamento tem uma issue no GitHub com responsável, entrega e testes. Ao abrir o PR, cite a issue (por exemplo, `Fecha #3`).

## Verificação do planejamento

- **Etapa 0:** push direto na `main` é recusado, e PR sem aprovação do instrutor não pode ser mesclado.
- **Cada PR:** CI verde, revisão do colega, aprovação do instrutor, testes da etapa descritos e executados.
- **Final:** site em produção no Cloudflare, dados no Supabase prod, checklist de ponta a ponta aprovado e conjunto de avaliação da IA com pelo menos 13 de 15 acertos.
