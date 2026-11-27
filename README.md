# FB Consult · Assistente Diesel

Chatbot com IA para os consultores da **FB Consult** tirarem dúvidas rápidas sobre a **legislação do diesel** e o **Método FB de gestão de diesel**, sempre com a fonte de cada informação.

- **Login e senha**, com perfis de **administrador** e **consultor**. O administrador cria os usuários e gera senhas provisórias, e a troca é obrigatória no primeiro acesso.
- **Banco de dados local** (SQLite, arquivo `data/fb-diesel.db`): usuários, sessões, histórico de conversas e base de conhecimento.
- **Histórico de conversas** como num chatbot tradicional: lista lateral, busca, renomear e excluir.
- **Fontes**: cada resposta mostra os documentos consultados, com link oficial e data da última verificação. A aba *Fontes* permite ler a base completa.
- **Painel do administrador**: usuários (criar, editar, desativar, gerar nova senha, excluir) e documentos da base (criar e editar sem mexer em código).
- Frontend em **HTML, CSS e JavaScript puros**, no padrão visual da plataforma FB. O servidor é **Node.js** sem framework; a única dependência é o SDK oficial da Anthropic.

## Requisitos

- [Node.js](https://nodejs.org) **22.13 ou superior** (o SQLite já vem embutido no Node).
- Uma chave da API da Anthropic (Claude), criada em https://platform.claude.com/settings/keys. Sem a chave, o sistema funciona em modo de consulta: o chat devolve os trechos mais relevantes da base, sem gerar texto com IA.

## Instalação

```bash
npm install
cp .env.example .env      # no Windows: copy .env.example .env
# edite o .env e preencha ANTHROPIC_API_KEY
npm start
```

Acesse http://localhost:3000.

### Primeiro acesso

Na primeira vez que o servidor sobe, com o banco vazio, ele cria o usuário **admin**:

- se `ADMIN_PASSWORD` estiver preenchido no `.env`, essa é a senha provisória;
- se não estiver, uma senha provisória é gerada e **mostrada no terminal**.

No primeiro login o sistema exige a troca de senha. Depois disso, vá em **Administração → Novo usuário** para cadastrar os consultores.

Perdeu a senha do administrador? No servidor, rode `npm run admin:reset -- admin`.

## Base de conhecimento

Os documentos ficam em `knowledge/` como arquivos Markdown, com um cabeçalho:

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

- `knowledge/legislacao/` traz a legislação pública: ICMS monofásico, PIS/COFINS, Reforma Tributária (IBS/CBS), mistura de biodiesel, especificação ANP, ponto de abastecimento (tanque interno), tanque suplementar (CONTRAN), ARLA 32/PROCONVE, preços ANP, premiação e Lei do Motorista, e fontes oficiais.
- `knowledge/interno/` traz o **Método FB** (etapas e indicadores, pontos-chave e laudo de divergência/LCDA, checklist de ICMS). **Essa pasta fica fora do Git por padrão** (ver `.gitignore`), porque é conteúdo proprietário da FB.

Os arquivos são importados automaticamente quando o servidor sobe (só os novos). Para reimportar após editar um arquivo:

```bash
npm run kb:import -- --force
```

Documentos editados pelo **painel do administrador** nunca são sobrescritos pela reimportação.

### Como a IA responde

1. A pergunta é buscada na base (busca por relevância BM25, com tratamento de acentos e plurais em português).
2. Os 6 trechos mais relevantes vão para o Claude junto com as instruções: responder em português, citar cada afirmação com [n], separar *legislação* de *Método FB*, mencionar a data de verificação de valores que mudam com frequência e não inventar números de leis.
3. A resposta chega em tempo real (streaming) e fica salva no histórico com a lista de fontes.

> **Atenção:** valores como a alíquota ad rem do ICMS, o PIS/COFINS e o percentual de biodiesel mudam com frequência. Revise a base periodicamente e atualize o campo `verificado_em`.

## Configuração (`.env`)

| Variável | Padrão | Descrição |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Chave da API do Claude |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Modelo de IA |
| `AI_EFFORT` | `medium` | Esforço de raciocínio (`low`, `medium`, `high`) |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Use `HOST=0.0.0.0` para acesso pela rede |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / gerada | Primeiro administrador |
| `SESSION_HOURS` | `12` | Duração do login |
| `COOKIE_SECURE` | `0` | Use `1` quando estiver atrás de HTTPS |
| `DB_PATH` | `data/fb-diesel.db` | Caminho do banco |

## Segurança

- Senhas guardadas com hash **scrypt** e salt aleatório. Senhas provisórias aparecem uma única vez.
- Sessão em cookie `HttpOnly` + `SameSite=Strict`, com bloqueio de 15 minutos após 5 tentativas erradas.
- Cada consultor só vê as próprias conversas. Desativar um usuário encerra as sessões dele na hora.
- A chave da IA fica só no servidor (`.env`) e nunca chega ao navegador.
- Cabeçalhos de segurança (CSP, X-Frame-Options, nosniff).
- Para acesso fora da rede local, coloque o sistema atrás de HTTPS (por exemplo, com um proxy reverso) e use `COOKIE_SECURE=1`.

**Backup:** copie periodicamente a pasta `data/` (contém usuários e todo o histórico).

## Testes

```bash
npm test
```

## Estrutura

```
server.js              servidor HTTP e rotas da API
src/db.js              banco SQLite e esquema
src/auth.js            senhas, sessões e primeiro administrador
src/knowledge.js       importação da base e busca BM25
src/ai.js              integração com o Claude (streaming e citações)
public/                frontend (HTML, CSS, JS)
knowledge/             base de conhecimento em Markdown
scripts/               reimportação da base e recuperação do admin
test/                  testes automatizados
```
