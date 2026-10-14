# Cloudflare Worker — botão "Atualizar agora"

Este pequeno Worker faz a ponte segura entre o site (estático) e o GitHub.
Ele aciona o workflow **Atualizar notícias** sem expor seu token no site.

O site só mostra o botão **Atualizar agora** se você preencher a `workerUrl` em
[`config.js`](../config.js).

---

## Passo 1 — Criar um token no GitHub

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens** → *Generate new token*.
2. **Repository access:** *Only select repositories* → escolha `central-de-noticias`.
3. **Permissions → Repository permissions:**
   - **Actions:** *Read and write*
   - **Contents:** *Read-only* (o `/ultimo` usa isso)
4. Gere e **copie o token** (você não verá de novo).

## Passo 2 — Criar o Worker no Cloudflare

1. Crie uma conta grátis em <https://dash.cloudflare.com>.
2. Menu **Workers & Pages → Create → Create Worker**. Dê um nome (ex.: `central-noticias`) e crie.
3. Clique em **Edit code**, apague o conteúdo e cole o conteúdo de [`worker.js`](worker.js). Salve e **Deploy**.
4. Anote a URL do Worker (algo como `https://central-noticias.SEU_USUARIO.workers.dev`).

## Passo 3 — Configurar variáveis e segredos

No Worker, **Settings → Variables and Secrets** (ou "Variáveis e segredos"):

| Nome | Tipo | Valor |
| --- | --- | --- |
| `GH_TOKEN` | **Secret** | o token do Passo 1 |
| `OWNER` | Text | `Marquezbertin` |
| `REPO` | Text | `central-de-noticias` |
| `WORKFLOW` | Text | `update-news.yml` |
| `ALLOWED_ORIGIN` | Text | `https://marquezbertin.github.io` |

Salve e faça **Deploy** novamente.

## Passo 4 — (Recomendado) Limite de frequência com KV

Para evitar disparos repetidos:

1. Cloudflare → **Storage & Databases → KV → Create namespace** (ex.: `central-noticias-rate`).
2. No Worker → **Settings → Bindings → Add → KV Namespace**:
   - **Variable name:** `RATE`
   - **KV namespace:** o que você criou.
3. Deploy novamente (opcional, mas evita abuso).

Sem o KV o worker funciona, apenas não limita a frequência.

## Passo 5 — Ligar no site

Edite [`config.js`](../config.js) e coloque a URL do Worker:

```js
window.CENTRAL_CONFIG = { workerUrl: "https://central-noticias.SEU_USUARIO.workers.dev" };
```

Pronto. O botão **Atualizar agora** aparece ao lado do 🔄. Ao clicar, ele pede a
atualização, acompanha o progresso e, quando fica pronto, já toca o boletim novo.

---

### Como testar o Worker rapidamente

```bash
curl -X POST https://central-noticias.SEU_USUARIO.workers.dev/atualizar
# esperado: {"ok":true,"disparadoEm":"..."}
```

Se receber `GitHub 404`, o token provavelmente não tem permissão de **Actions: write**
para este repositório (tokens fine-grained devolvem 404 quando faltam permissões).
