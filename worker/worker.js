/**
 * Cloudflare Worker — Central de Notícias.
 *
 * Rota principal (não precisa de token):
 *   GET /rapido  -> busca as notícias mais recentes nos feeds RSS agora
 *                   e devolve JSON { atualizadoEm, itens:[{title,summary,source,cat,link}] }
 *
 * Rotas opcionais (só funcionam se as variáveis/token estiverem certos):
 *   POST /atualizar -> dispara o workflow do GitHub
 *   GET  /ultimo     -> último commit da branch main
 *
 * Variáveis de ambiente (opcionais):
 *   GH_TOKEN        (secret)  token com permissão "Actions: Read and write"
 *   OWNER, REPO, WORKFLOW      (text)  ex.: Marquezbertin / central-de-noticias / update-news.yml
 *   ALLOWED_ORIGIN  (text)    ex.: https://marquezbertin.github.io
 */

const MIN_INTERVAL = 240; // segundos mínimos entre dois disparos

const FEEDS = [
  { n: "G1", c: "Brasil", u: "https://g1.globo.com/rss/g1/" },
  { n: "Agência Brasil", c: "Brasil", u: "https://agenciabrasil.ebc.com.br/rss/ultimasnoticias/feed.xml" },
  { n: "CNN Brasil", c: "Brasil", u: "https://www.cnnbrasil.com.br/feed/" },
  { n: "Metrópoles", c: "Brasil", u: "https://www.metropoles.com/feed" },
  { n: "Veja", c: "Brasil", u: "https://veja.abril.com.br/feed/" },
  { n: "Jovem Pan", c: "Brasil", u: "https://jovempan.com.br/feed" },
  { n: "G1 Política", c: "Política", u: "https://g1.globo.com/rss/g1/politica/" },
  { n: "Folha Poder", c: "Política", u: "https://feeds.folha.uol.com.br/poder/rss091.xml" },
  { n: "Poder360", c: "Política", u: "https://www.poder360.com.br/feed/" },
  { n: "G1 Economia", c: "Economia", u: "https://g1.globo.com/rss/g1/economia/" },
  { n: "InfoMoney", c: "Economia", u: "https://www.infomoney.com.br/feed/" },
  { n: "G1 Mundo", c: "Mundo", u: "https://g1.globo.com/rss/g1/mundo/" },
  { n: "BBC Brasil", c: "Mundo", u: "https://feeds.bbci.co.uk/portuguese/rss.xml" },
  { n: "G1 Tecnologia", c: "Tecnologia", u: "https://g1.globo.com/rss/g1/tecnologia/" },
  { n: "Canaltech", c: "Tecnologia", u: "https://canaltech.com.br/rss/" },
  { n: "Olhar Digital", c: "Tecnologia", u: "https://olhardigital.com.br/feed/" },
  { n: "GE", c: "Esportes", u: "https://ge.globo.com/rss/ge/" },
  { n: "G1 Campinas", c: "São Pedro e região", u: "https://g1.globo.com/rss/g1/sao-paulo/campinas-e-regiao/" },
];

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const { pathname, searchParams } = new URL(request.url);

    if (pathname === "/rapido") {
      const n = Math.min(Math.max(parseInt(searchParams.get("n") || "30", 10) || 30, 1), 60);
      return rapido(n, cors);
    }

    if (pathname === "/ultimo") return ultimo(env, cors);
    if (pathname !== "/atualizar") {
      return json({ ok: false, erro: "rota desconhecida" }, 404, cors);
    }

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

/* --------------------------- busca rápida (RSS) --------------------------- */

async function rapido(n, cors) {
  const resultados = await Promise.allSettled(
    FEEDS.map(async (f) => {
      const res = await fetch(f.u, {
        headers: { "User-Agent": "central-de-noticias/1.0 (+https://github.com/Marquezbertin/central-de-noticias)" },
        cf: { cacheTtl: 60, cacheEverything: true },
      });
      if (!res.ok) return [];
      const xml = await res.text();
      return parseFeed(xml, f);
    })
  );

  let itens = [];
  for (const r of resultados) {
    if (r.status === "fulfilled" && Array.isArray(r.value)) itens.push(...r.value);
  }

  const vistos = new Set();
  itens = itens
    .filter((i) => i.title && i.link)
    .filter((i) => {
      const k = i.title.toLowerCase().replace(/\s+/g, " ").slice(0, 80);
      if (vistos.has(k)) return false;
      vistos.add(k);
      return true;
    })
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, n)
    .map(({ ts, ...i }) => i);

  return json({ ok: true, atualizadoEm: new Date().toISOString(), total: itens.length, itens }, 200, cors);
}

function parseFeed(xml, f) {
  const itens = [];
  const re = /<item[\s>][\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[0];
    const title = limpar(tag(b, "title"));
    const link = limpar(tag(b, "link")) || attr(b, "link", "href");
    const desc = limpar(tag(b, "description")) || limpar(tag(b, "content:encoded"));
    const pub = limpar(tag(b, "pubDate")) || limpar(tag(b, "dc:date"));
    if (!title) continue;
    itens.push({
      title,
      link,
      summary: resumir(desc),
      source: f.n,
      cat: f.c,
      ts: pub ? Date.parse(pub) || 0 : 0,
    });
  }
  return itens.slice(0, 6);
}

function tag(block, nome) {
  const re = new RegExp(`<${nome}[^>]*>([\\s\\S]*?)</${nome}>`, "i");
  const m = block.match(re);
  return m ? m[1] : "";
}

function attr(block, nome, atributo) {
  const re = new RegExp(`<${nome}[^>]*\\b${atributo}=["']([^"']+)["']`, "i");
  const m = block.match(re);
  return m ? m[1] : "";
}

function limpar(s) {
  if (!s) return "";
  let t = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ");
  t = t
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return t.replace(/\s+/g, " ").trim();
}

function resumir(texto) {
  if (!texto) return "";
  const frases = texto.match(/[^.!?]+[.!?]+/g) || [texto];
  let out = "";
  for (const f of frases) {
    if ((out + f).length > 360) break;
    out += f;
  }
  out = (out || texto).trim();
  return out.length > 400 ? out.slice(0, 400).replace(/\s\S*$/, "") + "…" : out;
}

/* --------------------------- rotas com token (opcional) --------------------------- */

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
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
