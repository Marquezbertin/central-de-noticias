/**
 * Cloudflare Worker — Central de Notícias.
 *
 *   GET  /rapido  -> busca as notícias mais recentes nos feeds RSS agora
 *   POST /fala    -> gera áudio (voz em português) do texto enviado
 *   POST /atualizar, GET /ultimo -> opcionais (precisam do token GH_TOKEN)
 *
 * Variáveis de ambiente (opcionais):
 *   GH_TOKEN, OWNER, REPO, WORKFLOW   (para o disparo do workflow)
 *   ALLOWED_ORIGIN  ex.: https://marquezbertin.github.io
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

    if (pathname === "/fala") return fala(request, cors);

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

const ENTIDADES = {
  aacute: "á", agrave: "à", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë",
  iacute: "í", igrave: "ì", icirc: "î", iuml: "ï",
  oacute: "ó", ograve: "ò", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü",
  ccedil: "ç", ntilde: "ñ", yacute: "ý", aacute_: "á",
  Aacute: "Á", Agrave: "À", Acirc: "Â", Atilde: "Ã", Auml: "Ä",
  Eacute: "É", Egrave: "È", Ecirc: "Ê", Euml: "Ë",
  Iacute: "Í", Icirc: "Î", Iuml: "Ï",
  Oacute: "Ó", Ograve: "Ò", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö",
  Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Ccedil: "Ç", Ntilde: "Ñ",
  nbsp: " ", ordm: "º", ordf: "ª", deg: "°", middot: "·", hellip: "…",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", laquo: "«", raquo: "»",
  ndash: "–", mdash: "—", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£",
  times: "×", divide: "÷", sup2: "²", sup3: "³", frac12: "½", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
};

function limpar(s) {
  if (!s) return "";
  let t = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ");
  t = t.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  t = t.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
  t = t.replace(/&([a-zA-Z]+);/g, (m, n) => (ENTIDADES[n] != null ? ENTIDADES[n] : m));
  return t.replace(/\s+/g, " ").trim();
}

function resumir(texto) {
  if (!texto) return "";
  let s = texto.replace(/The post .*? appeared first on .*?\.?/i, "").trim();
  const frases = s.match(/[^.!?]+[.!?]+/g) || [s];
  let out = "";
  for (const f of frases) {
    if ((out + f).length > 360) break;
    out += f;
  }
  out = (out || s).trim();
  return out.length > 400 ? out.slice(0, 400).replace(/\s\S*$/, "") + "…" : out;
}

/* --------------------------- voz (Google TTS) --------------------------- */

async function fala(request, cors) {
  let texto = "";
  try {
    if (request.method === "POST") {
      const raw = await request.text();
      try {
        const j = JSON.parse(raw);
        texto = j && j.text ? String(j.text) : raw;
      } catch (e) {
        texto = raw;
      }
    } else {
      texto = new URL(request.url).searchParams.get("text") || "";
    }
  } catch (e) { /* ignora */ }
  texto = texto.replace(/\s+/g, " ").trim().slice(0, 3000);
  if (!texto) return json({ ok: false, erro: "texto vazio" }, 400, cors);

  try {
    const audio = await googleTts(texto);
    if (!audio || audio.length < 200) return json({ ok: false, erro: "sem audio" }, 502, cors);
    return new Response(audio, {
      status: 200,
      headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return json({ ok: false, erro: "tts falhou", detalhe: String(e).slice(0, 200) }, 502, cors);
  }
}

async function googleTts(texto) {
  const partes = dividir(texto, 190);
  const pedacos = [];
  for (const p of partes) {
    const u =
      "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=pt-BR&q=" +
      encodeURIComponent(p);
    const r = await fetch(u, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        Referer: "https://translate.google.com/",
      },
    });
    if (!r.ok) throw new Error("google tts " + r.status);
    pedacos.push(new Uint8Array(await r.arrayBuffer()));
  }
  let total = 0;
  for (const c of pedacos) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of pedacos) { out.set(c, off); off += c.length; }
  return out;
}

function dividir(texto, max) {
  const palavras = texto.split(/\s+/);
  const partes = [];
  let atual = "";
  for (const p of palavras) {
    if ((atual + " " + p).trim().length > max) {
      if (atual) partes.push(atual.trim());
      atual = p;
    } else {
      atual = (atual + " " + p).trim();
    }
  }
  if (atual) partes.push(atual.trim());
  return partes.length ? partes : [texto];
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
