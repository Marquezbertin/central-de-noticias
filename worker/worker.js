/**
 * Cloudflare Worker — Central de Notícias.
 *
 *   GET  /rapido         -> notícias mais recentes dos feeds RSS agora (JSON)
 *   POST /boletim        -> gera UM MP3 (voz Thalita) com os itens enviados,
 *                           com pausa entre as notícias (SSML <break>)
 *   GET  /fala?text=...  -> MP3 (voz Thalita) de um texto curto
 *   POST /atualizar, GET /ultimo -> opcionais (precisam do token GH_TOKEN)
 *
 * Variáveis de ambiente (para /atualizar):
 *   GH_TOKEN, OWNER, REPO, WORKFLOW
 *   ALLOWED_ORIGIN  ex.: https://marquezbertin.github.io
 */

const MIN_INTERVAL = 240;

const TTS_VOICE = "pt-BR-ThalitaMultilingualNeural";
const TTS_RATE = "+6%";
const TTS_PITCH = "-2Hz";
const TTS_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const TTS_OUTPUT = `${TTS_FORMAT}`;
const PAUSA_ENTRE_ITENS = "2s";

const EDGE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_VERSION = "143.0.3650.75";
const EDGE_SEC_VERSION = `2-${EDGE_VERSION}`;

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

    if (pathname === "/boletim") return boletim(request, cors);
    if (pathname === "/fala") return fala(request, cors);
    if (pathname === "/ultimo") return ultimo(env, cors);
    if (pathname !== "/atualizar") {
      return json({ ok: false, erro: "rota desconhecida" }, 404, cors);
    }

    if (env.RATE) {
      const now = Math.floor(Date.now() / 1000);
      const last = await env.RATE.get("last");
      if (last && now - Number(last) < MIN_INTERVAL) {
        return json({ ok: false, motivo: "aguarde", faltam: MIN_INTERVAL - (now - Number(last)) }, 429, cors);
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
    if (res.status === 204) return json({ ok: true, disparadoEm: new Date().toISOString() }, 200, cors);
    const detalhe = (await res.text()).slice(0, 300);
    return json({ ok: false, erro: `GitHub ${res.status}`, detalhe }, 502, cors);
  },
};

/* --------------------------- busca rápida (RSS) --------------------------- */

async function coletarItens(n) {
  const resultados = await Promise.allSettled(
    FEEDS.map(async (f) => {
      const res = await fetch(f.u, {
        headers: { "User-Agent": "central-de-noticias/1.0 (+https://github.com/Marquezbertin/central-de-noticias)" },
        cf: { cacheTtl: 60, cacheEverything: true },
      });
      if (!res.ok) return [];
      return parseFeed(await res.text(), f);
    })
  );
  let itens = [];
  for (const r of resultados) if (r.status === "fulfilled" && Array.isArray(r.value)) itens.push(...r.value);

  const vistos = new Set();
  return itens
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
}

async function rapido(n, cors) {
  const itens = await coletarItens(n);
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
    itens.push({ title, link, summary: resumir(desc), source: f.n, cat: f.c, ts: pub ? Date.parse(pub) || 0 : 0 });
  }
  return itens.slice(0, 6);
}

function tag(block, nome) {
  const m = block.match(new RegExp(`<${nome}[^>]*>([\\s\\S]*?)</${nome}>`, "i"));
  return m ? m[1] : "";
}
function attr(block, nome, atributo) {
  const m = block.match(new RegExp(`<${nome}[^>]*\\b${atributo}=["']([^"']+)["']`, "i"));
  return m ? m[1] : "";
}

const ENTIDADES = {
  aacute: "á", agrave: "à", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", iacute: "í", igrave: "ì", icirc: "î", iuml: "ï",
  oacute: "ó", ograve: "ò", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü", ccedil: "ç", ntilde: "ñ", yacute: "ý",
  Aacute: "Á", Agrave: "À", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Eacute: "É", Egrave: "È", Ecirc: "Ê", Euml: "Ë",
  Iacute: "Í", Icirc: "Î", Iuml: "Ï", Oacute: "Ó", Ograve: "Ò", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö",
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
  const s = texto.replace(/The post .*? appeared first on .*?\.?/i, "").trim();
  const frases = s.match(/[^.!?]+[.!?]+/g) || [s];
  let out = "";
  for (const f of frases) { if ((out + f).length > 360) break; out += f; }
  out = (out || s).trim();
  return out.length > 400 ? out.slice(0, 400).replace(/\s\S*$/, "") + "…" : out;
}

/* --------------------------- voz neural (edge-tts) --------------------------- */

async function fala(request, cors) {
  let texto = "";
  try {
    if (request.method === "POST") {
      const raw = await request.text();
      try { texto = String(JSON.parse(raw).text || raw); } catch (e) { texto = raw; }
    } else {
      texto = new URL(request.url).searchParams.get("text") || "";
    }
  } catch (e) { /* ignora */ }
  texto = texto.replace(/\s+/g, " ").trim().slice(0, 1200);
  if (!texto) return json({ ok: false, erro: "texto vazio" }, 400, cors);
  return responderAudio([escapeXml(texto)], cors);
}

async function boletim(request, cors) {
  let itens = [];
  try {
    if (request.method === "POST") {
      const j = JSON.parse(await request.text());
      if (Array.isArray(j.itens)) itens = j.itens;
    }
  } catch (e) { /* ignora */ }
  if (!itens.length) itens = await coletarItens(20);

  const segmentos = itens
    .map((it) => {
      const t = escapeXml(String(it.title || "").trim());
      const s = it.summary ? escapeXml(String(it.summary).trim()) : "";
      return (t + (s ? ". " + s : "")).trim();
    })
    .filter((s) => s.length > 0);
  if (!segmentos.length) return json({ ok: false, erro: "sem itens" }, 400, cors);

  return responderAudio(segmentos, cors);
}

async function responderAudio(segmentos, cors) {
  try {
    const audio = await edgeTts(segmentos);
    if (!audio || audio.length < 200) return json({ ok: false, erro: "sem audio" }, 502, cors);
    return new Response(audio, {
      status: 200,
      headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return json({ ok: false, erro: "tts falhou", detalhe: String(e).slice(0, 200) }, 502, cors);
  }
}

const enc = new TextEncoder();

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function montarSsml(corpo) {
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='pt-BR'>` +
    `<voice name='${TTS_VOICE}'>` +
    `<prosody pitch='${TTS_PITCH}' rate='${TTS_RATE}' volume='+0%'>${corpo}</prosody>` +
    `</voice></speak>`;
  return ssml;
}

async function edgeTts(segmentos) {
  // agrupa os itens em blocos para nao estourar o limite de texto por conexao
  const blocos = [];
  let atual = "";
  segmentos.forEach((seg, i) => {
    const trecho = seg + `<break time='${PAUSA_ENTRE_ITENS}'/>`;
    if (atual && enc.encode(atual + trecho).length > 3400) { blocos.push(atual); atual = ""; }
    atual += trecho;
  });
  if (atual) blocos.push(atual);

  const pedacos = [];
  for (const corpo of blocos) {
    const audio = await edgeTtsUma(montarSsml(corpo));
    pedacos.push(new Uint8Array(audio));
  }
  let total = 0;
  for (const p of pedacos) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of pedacos) { out.set(p, off); off += p.length; }
  return out;
}

async function edgeTtsUma(ssml) {
  const conn = crypto.randomUUID().replace(/-/g, "");
  const gec = secMsGec(Date.now() / 1000);
  const url =
    `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${EDGE_TOKEN}&ConnectionId=${conn}` +
    `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${EDGE_SEC_VERSION}`;

  const resp = await fetch(url, {
    headers: {
      Upgrade: "websocket",
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
      Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      "Sec-WebSocket-Version": "13",
      "User-Agent":
        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
        `Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0`,
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: `muid=${randomMuid()};`,
    },
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error("sem websocket (" + resp.status + ")");
  ws.accept();

  const chunks = [];
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("timeout")), 30000);
    ws.addEventListener("message", (ev) => {
      const d = ev.data;
      if (typeof d === "string") {
        if (d.includes("Path:turn.end")) {
          clearTimeout(to);
          try { ws.close(); } catch (e) { /* ignore */ }
          resolve();
        }
        return;
      }
      const u8 = new Uint8Array(d);
      if (u8.length < 3) return;
      const headerLen = (u8[0] << 8) | u8[1];
      const start = 2 + headerLen;
      if (start >= u8.length) return;
      const header = new TextDecoder().decode(u8.slice(2, start));
      if (header.includes("Path:audio")) chunks.push(u8.slice(start));
    });
    ws.addEventListener("close", () => { clearTimeout(to); resolve(); });
    ws.addEventListener("error", () => { clearTimeout(to); reject(new Error("ws error")); });

    const cfg =
      `X-Timestamp:${edgeDate()}\r\nContent-Type:application/json; charset=utf-8\r\n` +
      `Path:speech.config\r\n\r\n` +
      `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},` +
      `"outputFormat":"${TTS_OUTPUT}"}}}}`;
    ws.send(cfg);
    ws.send(
      `X-RequestId:${crypto.randomUUID().replace(/-/g, "")}\r\nContent-Type:application/ssml+xml\r\n` +
      `X-Timestamp:${edgeDate()}Z\r\nPath:ssml\r\n\r\n${ssml}`
    );
  });

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function edgeDate() {
  const d = new Date();
  const dias = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const meses = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (x) => String(x).padStart(2, "0");
  return `${dias[d.getUTCDay()]} ${meses[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

function randomMuid() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
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

/* ===================== edge-tts: token Sec-MS-GEC v2 ===================== */
/* Porte fiel de edge_tts/drm.py (v7.3.1), validado contra o Python. */

const M32 = 0xFFFFFFFF;
const WIN_EPOCH = 11644473600;

const SHA_INITIAL = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];
const SHA_STATE = [0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2];
const SHA_SCHEDULE = [0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6, 0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564];
const ROUND_CONSTANTS = [
0x428A2F98,0x71374491,0xB5C0FBCF,0xE9B5DBA5,0x3956C25B,0x59F111F1,0x923F82A4,0xAB1C5ED5,
0xD807AA98,0x12835B01,0x243185BE,0x550C7DC3,0x72BE5D74,0x80DEB1FE,0x9BDC06A7,0xC19BF174,
0xE49B69C1,0xEFBE4786,0x0FC19DC6,0x240CA1CC,0x2DE92C6F,0x4A7484AA,0x5CB0A9DC,0x76F988DA,
0x983E5152,0xA831C66D,0xB00327C8,0xBF597FC7,0xC6E00BF3,0xD5A79147,0x06CA6351,0x14292967,
0x27B70A85,0x2E1B2138,0x4D2C6DFC,0x53380D13,0x650A7354,0x766A0ABB,0x81C2C92E,0x92722C85,
0xA2BFE8A1,0xA81A664B,0xC24B8B70,0xC76C51A3,0xD192E819,0xD6990624,0xF40E3585,0x106AA070,
0x19A4C116,0x1E376C08,0x2748774C,0x34B0BCB5,0x391C0CB3,0x4ED8AA4A,0x5B9CCA4F,0x682E6FF3,
0x748F82EE,0x78A5636F,0x84C87814,0x8CC70208,0x90BEFFFA,0xA4506CEB,0xBEF9A3F7,0xC67178F2];
const ADJUSTMENT = 0xC9DC06A7;
const BLOCK_CONSTANTS = ROUND_CONSTANTS.slice(0, 14).concat([ADJUSTMENT], ROUND_CONSTANTS.slice(15));
const SIGMA0_ADJ = 0x059C0B80;
const SIGMA1_ADJ = 0x000B92C0;

const CS64_COEFFICIENTS = [
[0xE82E91B1,0xB32700D0],[0x44DE24C6,0x88DFF51D],[0x3BEB65BC,0x29514038],[0xC89C5933,0xB328CBDF],
[0x8D1EC211,0xD405B4D5],[0x314EF5D5,0x26E55F3C],[0xE92491B1,0x607801C6],[0xF0A5B9D5,0x82B2C1FB],
[0x06064CF3,0xFA51A3DA],[0xDA79FA60,0x207CC464],[0xBED20560,0x3C3C74F3],[0x89F9C9F8,0xD2D14B61],
[0x35FA38C6,0xBB04A2C1],[0xCB49E3C6,0xC5626167]];
const CS64_FACTOR = 0x82893933;
const CS64_ADJ0 = 0xF2F90B1A;
const CS64_ADJ1 = 0x0B1A0000;

const mul32 = (a, b) => Math.imul(a, b) >>> 0;
const rol16 = (v) => (((v << 16) | (v >>> 16)) >>> 0);
const rotr = (x, k) => (((x >>> k) | (x << (32 - k))) >>> 0);
const rotr3 = (x, a, b, c) => ((rotr(x, a) ^ rotr(x, b) ^ rotr(x, c)) >>> 0);
const sigma0 = (v) => ((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) >>> 0;
const sigma1 = (v) => ((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) >>> 0;

function sha256Rounds(state, words, firstRound) {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? BLOCK_CONSTANTS : ROUND_CONSTANTS;
  const aligned = Math.min(64, Math.floor((firstRound + 7) / 8) * 8);
  for (let index = firstRound; index < aligned; index++) {
    const ch = (g ^ (e & (f ^ g))) >>> 0;
    const maj = ((a & b) | (c & (a | b))) >>> 0;
    const t1 = (h + rotr3(e, 6, 11, 25) + ch + constants[index] + words[index]) >>> 0;
    const t2 = (rotr3(a, 2, 13, 22) + maj) >>> 0;
    [a, b, c, d, e, f, g, h] = [(t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g];
  }
  for (let index = aligned; index < 64; index += 8) {
    const t1a = (h + rotr3(e, 6, 11, 25) + ((g ^ (e & (f ^ g))) >>> 0) + constants[index] + words[index]) >>> 0;
    d = (d + t1a) >>> 0;
    h = (t1a + rotr3(a, 2, 13, 22) + (((a & b) | (c & (a | b))) >>> 0)) >>> 0;
    const t1b = (g + rotr3(d, 6, 11, 25) + ((f ^ (d & (e ^ f))) >>> 0) + constants[index + 1] + words[index + 1]) >>> 0;
    c = (c + t1b) >>> 0;
    g = (t1b + rotr3(h, 2, 13, 22) + (((h & a) | (b & (h | a))) >>> 0)) >>> 0;
    const t1c = (f + rotr3(c, 6, 11, 25) + ((e ^ (c & (d ^ e))) >>> 0) + constants[index + 2] + words[index + 2]) >>> 0;
    b = (b + t1c) >>> 0;
    f = (t1c + rotr3(g, 2, 13, 22) + (((g & h) | (a & (g | h))) >>> 0)) >>> 0;
    const t1d = (e + rotr3(b, 6, 11, 25) + ((d ^ (b & (c ^ d))) >>> 0) + constants[index + 3] + words[index + 3]) >>> 0;
    a = (a + t1d) >>> 0;
    e = (t1d + rotr3(f, 2, 13, 22) + (((f & g) | (h & (f | g))) >>> 0)) >>> 0;
    const t1e = (d + rotr3(a, 6, 11, 25) + ((c ^ (a & (b ^ c))) >>> 0) + constants[index + 4] + words[index + 4]) >>> 0;
    h = (h + t1e) >>> 0;
    d = (t1e + rotr3(e, 2, 13, 22) + (((e & f) | (g & (e | f))) >>> 0)) >>> 0;
    const t1f = (c + rotr3(h, 6, 11, 25) + ((b ^ (h & (a ^ b))) >>> 0) + constants[index + 5] + words[index + 5]) >>> 0;
    g = (g + t1f) >>> 0;
    c = (t1f + rotr3(d, 2, 13, 22) + (((d & e) | (f & (d | e))) >>> 0)) >>> 0;
    const t1g = (b + rotr3(g, 6, 11, 25) + ((a ^ (g & (h ^ a))) >>> 0) + constants[index + 6] + words[index + 6]) >>> 0;
    f = (f + t1g) >>> 0;
    b = (t1g + rotr3(c, 2, 13, 22) + (((c & d) | (e & (c | d))) >>> 0)) >>> 0;
    const t1h = (a + rotr3(f, 6, 11, 25) + ((h ^ (f & (g ^ h))) >>> 0) + constants[index + 7] + words[index + 7]) >>> 0;
    e = (e + t1h) >>> 0;
    a = (t1h + rotr3(b, 2, 13, 22) + (((b & c) | (d & (b | c))) >>> 0)) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

function expandSchedule(words, firstWord) {
  for (let index = firstWord || 16; index < 64; index++) {
    const x = words[index - 2], y = words[index - 15];
    const s1 = ((x >>> 17) ^ (x << 15) ^ (x >>> 19) ^ (x << 13) ^ (x >>> 10)) >>> 0;
    const s0 = ((y >>> 7) ^ (y << 25) ^ (y >>> 18) ^ (y << 14) ^ (y >>> 3)) >>> 0;
    words.push((s1 + words[index - 7] + s0 + words[index - 16]) >>> 0);
  }
}

function beInt(bytes) { let n = 0; for (const b of bytes) n = n * 256 + b; return n >>> 0; }

function sha256Init(data) {
  const words = new Array(14).fill(0);
  words.push(beInt(data.slice(0, 3)));
  words.push(beInt(data.slice(3, 7)));
  for (let index = 16; index < 30; index++) {
    let value = SHA_SCHEDULE[index - 16];
    if (index - 2 >= 14) {
      const s1 = sigma1(words[index - 2]);
      value += index === 16 ? (s1 ^ SIGMA1_ADJ) >>> 0 : s1;
    }
    if (index - 7 >= 14) value += words[index - 7];
    if (index - 15 >= 14) {
      const s0 = sigma0(words[index - 15]);
      value += index === 29 ? (s0 ^ SIGMA0_ADJ) >>> 0 : s0;
    }
    words.push(value >>> 0);
  }
  words.push((sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + ADJUSTMENT - ROUND_CONSTANTS[14]) >>> 0);
  expandSchedule(words, 31);
  const working = sha256Rounds(SHA_STATE, words, 14);
  return SHA_INITIAL.map((x, i) => (x + working[i]) >>> 0);
}

function sha256Digest(data) {
  const length = 57 + data.length;
  const out = data.slice(7);
  out.push(0x80);
  const pad = (((55 - length) % 64) + 64) % 64;
  for (let i = 0; i < pad; i++) out.push(0);
  let len = length * 8;
  const lenBytes = new Array(8).fill(0);
  for (let i = 7; i >= 0; i--) { lenBytes[i] = len & 0xff; len = Math.floor(len / 256); }
  for (const b of lenBytes) out.push(b);
  let state = sha256Init(data.slice(0, 7));
  for (let off = 0; off < out.length; off += 64) {
    const words = [];
    for (let i = 0; i < 16; i++) {
      const b = out.slice(off + i * 4, off + i * 4 + 4);
      words.push(((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);
    }
    expandSchedule(words);
    const working = sha256Rounds(state, words, 0);
    state = state.map((x, i) => (x + working[i]) >>> 0);
  }
  const res = [];
  for (const w of state) res.push((w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff);
  return res;
}

function wordsLe4Even(data) {
  const padded = data.slice();
  while (padded.length % 4 !== 0) padded.push(0);
  const words = [];
  for (let i = 0; i < padded.length; i += 4) {
    words.push((padded[i] | (padded[i + 1] << 8) | (padded[i + 2] << 16) | (padded[i + 3] << 24)) >>> 0);
  }
  if (words.length % 2) words.push(0);
  return words;
}

function cs64Digest(data, digest) {
  let keyA = (digest[0] | (digest[1] << 8) | (digest[2] << 16) | (digest[3] << 24)) >>> 0;
  let keyB = (digest[4] | (digest[5] << 8) | (digest[6] << 16) | (digest[7] << 24)) >>> 0;
  keyA |= 1; keyB |= 1;
  const factors = [mul32(keyA, CS64_FACTOR), mul32(keyB, CS64_FACTOR)];
  const terms = [];
  const offsets = [];
  CS64_COEFFICIENTS.forEach((c, index) => {
    terms.push(mul32(c[0], factors[index % 2]));
    offsets.push(c[1] >>> 0);
  });
  const full = [0, ...data];
  wordsLe4Even(full).forEach((word, index) => {
    let term = mul32(word, index % 2 === 0 ? keyA : keyB);
    let offset = mul32(rol16(word), index % 2 === 0 ? 0xEF0569FB : 0xC31713DB);
    if (index === 0) { term = (term + mul32(CS64_ADJ0, factors[0])) >>> 0; offset = (offset + CS64_ADJ1) >>> 0; }
    terms.push(term >>> 0);
    offsets.push(offset >>> 0);
  });
  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16((offsets[i] + x) >>> 0);
    let q = mul32(t, 0x76F50F34);
    swapAcc = (swapAcc + ((mul32(rol16(q), 0xC3EFEA97) + q) >>> 0)) >>> 0;
    t = rol16((offsets[i + 1] + y) >>> 0);
    q = mul32(t, 0x1881CE3C);
    swapLast = (mul32(rol16(q), 0x35BD1EC9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;
    state = (mul32(state, keyA) + x) >>> 0;
    state = mul32(rol16(state), 0xCF98B111);
    state = mul32(rol16(state), 0x87085B9F);
    state = mul32(rol16(state), 0x12CEB96D);
    state = mul32(rol16(state), 0x257E1D83);
    acc += state;
    t = (mul32(state, keyB) + y) >>> 0;
    t = mul32(rol16(t), 0xA27416F5);
    t = mul32(rol16(t), 0xD38396FF);
    state = mul32(rol16(mul32(rol16(t), 0x7C932B89)), 0xBFA49F69);
    acc = (acc + state) >>> 0;
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

function leHex(v) {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
    .map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}
function bytesHex(bytes) {
  return bytes.map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function secMsGec(unixTs) {
  let ticks = unixTs + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e7;
  const str = ticks.toFixed(0) + EDGE_TOKEN;
  const data = Array.from(str).map((c) => c.charCodeAt(0));
  const digest = sha256Digest(data);
  const cs = cs64Digest(data, digest);
  return leHex(cs[0]) + leHex(cs[1]) + "-" + bytesHex(digest);
}
