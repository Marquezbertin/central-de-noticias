/**
 * Cloudflare Worker — "porteiro" seguro da Central de Notícias.
 *
 * Ele apenas aciona o workflow do GitHub que gera o boletim. O token do GitHub
 * fica guardado como SEGREDO aqui (nunca aparece no site).
 *
 * Rotas:
 *   POST /atualizar  -> dispara o workflow "Atualizar notícias"
 *   GET  /ultimo      -> devolve o último commit (sha/data) da branch main
 *
 * Variáveis de ambiente (Settings > Variables and Secrets):
 *   GH_TOKEN        (secret)  Token fine-grained com permissão "Actions: Read and write"
 *                             e acesso a este repositório.
 *   OWNER           (text)    Ex.: Marquezbertin
 *   REPO            (text)    Ex.: central-de-noticias
 *   WORKFLOW        (text)    Ex.: update-news.yml
 *   ALLOWED_ORIGIN  (text)    Ex.: https://marquezbertin.github.io
 *
 * Opcional (recomendado): um namespace KV chamado RATE, vinculado como "RATE".
 *   Sem ele, o worker funciona, mas sem limite de frequência.
 */

const MIN_INTERVAL = 240; // segundos mínimos entre dois disparos (4 min)

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const { pathname } = new URL(request.url);

    if (pathname === "/ultimo") return ultimo(env, cors);
    if (pathname !== "/atualizar") return json({ ok: false, erro: "rota desconhecida" }, 404, cors);

    // Limite de frequência (se o KV estiver configurado)
    if (env.RATE) {
      const now = Math.floor(Date.now() / 1000);
      const last = await env.RATE.get("last");
      if (last && now - Number(last) < MIN_INTERVAL) {
        return json(
          { ok: false, motivo: "aguarde", faltam: MIN_INTERVAL - (now - Number(last)) },
          429,
          cors
        );
      }
      await env.RATE.put("last", String(now), { expirationTtl: 3600 });
    }

    const res = await fetch(
      `https://api.github.com/repos/${env.OWNER}/${env.REPO}/actions/workflows/${env.WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "central-de-noticias-worker",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      }
    );

    if (res.status === 204) {
      return json({ ok: true, disparadoEm: new Date().toISOString() }, 200, cors);
    }
    const detalhe = (await res.text()).slice(0, 300);
    return json({ ok: false, erro: `GitHub ${res.status}`, detalhe }, 502, cors);
  },
};

async function ultimo(env, cors) {
  const res = await fetch(`https://api.github.com/repos/${env.OWNER}/${env.REPO}/commits/main`, {
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "central-de-noticias-worker",
    },
  });
  if (!res.ok) return json({ ok: false, erro: `GitHub ${res.status}` }, 502, cors);
  const c = await res.json();
  return json({ ok: true, sha: c.sha, date: c.commit && c.commit.committer && c.commit.committer.date }, 200, cors);
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
