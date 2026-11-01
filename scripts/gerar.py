# -*- coding: utf-8 -*-
"""
Central de Notícias — gerador diário.

1. Busca notícias de várias fontes (RSS).
2. Extrai o texto real de cada matéria e monta um RESUMO extrativo.
3. Monta um roteiro jornalístico.
4. Gera o áudio do boletim com voz neural humana (edge-tts).

Saídas:
  - noticias.json          (manchetes + resumos + links + áudios)
  - resumo.mp3             (boletim completo do dia)
  - resumo.txt             (roteiro em texto)
  - audio/<cat>-<n>.mp3    (áudio de cada matéria)
"""

import asyncio
import glob
import html
import json
import math
import os
import random
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import unicodedata
import wave
from concurrent.futures import ThreadPoolExecutor

import edge_tts
import feedparser
import requests
import trafilatura

try:
    import imageio_ffmpeg
    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except Exception as ex:  # noqa
    print("Aviso: ffmpeg (imageio-ffmpeg) indisponível:", ex)
    FFMPEG = None

try:
    from googlenewsdecoder import gnewsdecoder
    TEM_DECODER = True
except Exception as ex:  # noqa
    print("Aviso: googlenewsdecoder indisponível:", ex)
    gnewsdecoder = None
    TEM_DECODER = False

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# ------------------------------------------------------------------ #
# Configuração
# ------------------------------------------------------------------ #

VOZ = os.environ.get("VOZ", "pt-BR-ThalitaMultilingualNeural")
RATE = os.environ.get("VOZ_RATE", "+6%")
PITCH = os.environ.get("VOZ_PITCH", "-2Hz")
SR = 24000  # taxa de amostragem dos áudios

PER_CATEGORY = int(os.environ.get("PER_CATEGORY", "8"))     # exibidas no site
SPOKEN_PER_CATEGORY = int(os.environ.get("SPOKEN", str(PER_CATEGORY)))  # narradas no boletim (todas por padrão)
PAUSA_TITULO = float(os.environ.get("PAUSA_TITULO", "1.0"))  # título -> resumo
PAUSA_ITEM = float(os.environ.get("PAUSA_ITEM", "2.2"))      # entre notícias
MUSICA_A_CADA = int(os.environ.get("MUSICA_A_CADA", "5"))    # vinheta a cada N notícias
MUSICA_DUR = float(os.environ.get("MUSICA_DUR", "7.0"))      # duração da vinheta
MUSIC_DIR = os.environ.get("MUSIC_DIR", "music")            # músicas próprias (opcional)
TIMEOUT = int(os.environ.get("TIMEOUT", "20"))
UA = os.environ.get("UA", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")

GN = "https://news.google.com/rss/search?q={}&hl=pt-BR&gl=BR&ceid=BR:pt-419"


def gn(q):
    from urllib.parse import quote
    return GN.format(quote(q))


CATEGORIES = [
    "Brasil",
    "Política",
    "Economia",
    "Mundo",
    "Tecnologia",
    "Esportes",
    "São Pedro e região",
]

# fonte (nome do feed), categoria, url
FEEDS = [
    # ---------------- Brasil ----------------
    ("G1 / Globo", "Brasil", "https://g1.globo.com/rss/g1/"),
    ("Agência Brasil", "Brasil", "https://agenciabrasil.ebc.com.br/rss/ultimasnoticias/feed.xml"),
    ("CNN Brasil", "Brasil", "https://www.cnnbrasil.com.br/feed/"),
    ("UOL", "Brasil", "https://rss.uol.com.br/feed/noticias.xml"),
    ("Metrópoles", "Brasil", "https://www.metropoles.com/feed"),
    ("Veja", "Brasil", "https://veja.abril.com.br/feed/"),
    ("Jovem Pan", "Brasil", "https://jovempan.com.br/feed"),
    ("CBN", "Brasil", gn("CBN")),
    ("BandNews", "Brasil", gn("BandNews")),
    ("Record News", "Brasil", gn("Record News")),
    # ---------------- Política ----------------
    ("G1 / Globo", "Política", "https://g1.globo.com/rss/g1/politica/"),
    ("Folha de S.Paulo", "Política", "https://feeds.folha.uol.com.br/poder/rss091.xml"),
    ("Poder360", "Política", "https://www.poder360.com.br/feed/"),
    ("IstoÉ", "Política", "https://istoe.com.br/feed/"),
    ("Google Notícias", "Política", gn("política Brasil hoje")),
    # ---------------- Economia ----------------
    ("G1 / Globo", "Economia", "https://g1.globo.com/rss/g1/economia/"),
    ("Folha de S.Paulo", "Economia", "https://feeds.folha.uol.com.br/mercado/rss091.xml"),
    ("InfoMoney", "Economia", "https://www.infomoney.com.br/feed/"),
    ("Exame", "Economia", "https://exame.com/feed/"),
    ("UOL", "Economia", "https://rss.uol.com.br/feed/economia.xml"),
    # ---------------- Mundo ----------------
    ("G1 / Globo", "Mundo", "https://g1.globo.com/rss/g1/mundo/"),
    ("Folha de S.Paulo", "Mundo", "https://feeds.folha.uol.com.br/mundo/rss091.xml"),
    ("BBC News Brasil", "Mundo", "https://feeds.bbci.co.uk/portuguese/rss.xml"),
    ("Google Notícias", "Mundo", gn("notícias internacionais")),
    # ---------------- Tecnologia ----------------
    ("G1 / Globo", "Tecnologia", "https://g1.globo.com/rss/g1/tecnologia/"),
    ("Canaltech", "Tecnologia", "https://canaltech.com.br/rss/"),
    ("Olhar Digital", "Tecnologia", "https://olhardigital.com.br/feed/"),
    ("UOL", "Tecnologia", "https://rss.uol.com.br/feed/tecnologia.xml"),
    ("Google Notícias", "Tecnologia", gn("tecnologia inteligência artificial")),
    # ---------------- Esportes ----------------
    ("GE / Globo", "Esportes", "https://ge.globo.com/rss/ge/"),
    ("UOL", "Esportes", "https://rss.uol.com.br/feed/esporte.xml"),
    ("Google Notícias", "Esportes", gn("esportes Brasil")),
    # ---------------- São Pedro e região ----------------
    ("G1 Campinas / região", "São Pedro e região", "https://g1.globo.com/rss/g1/sp/campinas-regiao/"),
    ("Google Notícias", "São Pedro e região", gn('"São Pedro" SP')),
    ("Google Notícias", "São Pedro e região", gn("Piracicaba")),
    ("Google Notícias", "São Pedro e região", gn('"Rio Claro" SP')),
]

# ------------------------------------------------------------------ #
# Utilidades de texto
# ------------------------------------------------------------------ #

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")
PREFIX_LIXO = re.compile(
    r"^\s*(foto|cr[eé]dito|imagem|reprodu[cç][aã]o|divulga[cç][aã]o|publicidade|"
    r"por\s+[A-ZÁÉÍÓÚÂÊÔÃÕ][\wà-ÿ]+\s+[A-ZÁÉÍÓÚÂÊÔÃÕ][\wà-ÿ]+|"
    r"por\s+reda[cç][aã]o|da\s+reda[cç][aã]o|"
    r"leia\s+mais|veja(\s+(mais|tamb[eé]m|v[ií]deo))?|assista|ou[cç]a|"
    r"confira|saiba\s+mais|entenda)\s*:?\s*",
    re.I,
)
DATA_LIXO = re.compile(r"^\d{1,2}/\d{1,2}/\d{4}[,\s]*(às\s+)?\d{1,2}h\d{2}")
SUFIXO_FONTE = re.compile(
    r"\s*[|\-–]\s*(G1|GE|Globo|GloboNews|UOL|Folha|CNN|CNN Brasil|Veja|Exame|"
    r"InfoMoney|Canaltech|Olhar Digital|BBC|BBC News Brasil|Metr[oó]poles|Jovem Pan|"
    r"Isto[EÉ]|Poder360|Ag[eê]ncia Brasil|Record|Record News|CBN|BandNews)\s*$",
    re.I,
)


def limpar(raw):
    t = html.unescape(raw or "")
    t = TAG_RE.sub(" ", t)
    t = re.sub(r"\bPublicidade\b", " ", t, flags=re.I)
    t = WS_RE.sub(" ", t).strip()
    return t


def limpar_titulo(raw):
    t = limpar(raw)
    m = re.match(r"^(.*?)\s+-\s+([^-]{2,40})$", t)
    if m:
        return SUFIXO_FONTE.sub("", m.group(1)).strip(), m.group(2).strip()
    return SUFIXO_FONTE.sub("", t).strip(), ""


def _finalizar(s):
    """Garante que o texto termine em fim de frase (nunca corta no meio)."""
    s = s.strip().rstrip(" …")
    if not s:
        return s
    if s[-1] in ".!?":
        return s
    m = max(s.rfind("."), s.rfind("!"), s.rfind("?"))
    if m >= len(s) * 0.5:
        return s[:m + 1].strip()
    return s + "."


def limpar_inline(t):
    t = re.sub(r"^\s*[A-ZÁÉÍÓÚÂÊÔÃÕ][\wà-ÿ]+(?:\s+[\wà-ÿ]+){0,3}\s*[—–]\s+", "", t)
    t = re.sub(
        r"\s+Por\s+[A-ZÁÉÍÓÚÂÊÔÃÕ][\wà-ÿ.]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕ][\wà-ÿ.]+){0,2}\s*\|\s*",
        " ", t,
    )
    t = re.sub(
        r"\s*[—\-–]?\s*(Foto|Cr[eé]dito|Imagem|Reprodu[cç][aã]o|Divulga[cç][aã]o)\s*:"
        r"(?:\s+\S+){0,4}\s+",
        " ", t, flags=re.I,
    )
    return WS_RE.sub(" ", t)


def parece_lista(s):
    return len(re.findall(r"\b(Rua|Avenida|Estrada|Travessa|Alameda)\b", s, re.I)) >= 3


def resumir(texto, limite=700, max_frases=6):
    texto = (texto or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not texto:
        return ""
    # quebra em parágrafos antes de colapsar espaços (preserva limites de frase)
    frases = []
    for bloco in texto.split("\n"):
        bloco = WS_RE.sub(" ", bloco).strip()
        if not bloco:
            continue
        bloco = limpar_inline(bloco)
        bloco = DATA_LIXO.sub("", bloco).strip()
        if not bloco:
            continue
        frases.extend(p.strip() for p in re.split(r"(?<=[.!?])\s+", bloco) if p.strip())
    out, total = [], 0
    for f in frases:
        if len(f) < 25:
            continue
        if PREFIX_LIXO.match(f):
            continue
        out.append(f)
        total += len(f)
        if total >= limite or len(out) >= max_frases:
            break
    if not out:
        out = [WS_RE.sub(" ", fe.strip()) for fe in frases if fe.strip()][:2]
    if not out:
        return ""
    s = WS_RE.sub(" ", " ".join(out)).strip()
    if parece_lista(s) and len(out) > 1:
        s = out[0]
    s = _finalizar(s)
    # só corta em casos extremos, e sempre em fim de frase/cláusula
    if len(s) > 1500:
        trecho = s[:1500]
        corte = max(trecho.rfind(". "), trecho.rfind("! "), trecho.rfind("? "), trecho.rfind("; "))
        if corte < limite * 0.6:
            corte = trecho.rfind(", ")
        if corte > limite * 0.6:
            s = _finalizar(trecho[:corte])
        else:
            s = _finalizar(trecho[:trecho.rfind(" ")] if trecho.rfind(" ") > 0 else trecho)
    if s and s[0].islower():
        s = s[0].upper() + s[1:]
    return s



def _remove_prefixo_titulo(titulo, texto):
    """Remove do início do texto o trecho que repete/parafraseia o título."""
    tt = tokens(titulo)
    if not tt:
        return texto
    palavras = list(re.finditer(r"\S+", texto))
    if len(palavras) <= 2:
        return texto
    teto = min(len(palavras), max(len(tt) + 8, 30))
    for k in range(3, teto + 1):
        prefixo = tokens(" ".join(p.group() for p in palavras[:k]))
        if not prefixo:
            continue
        inter = len(tt & prefixo)
        cov = inter / len(tt)
        prec = inter / len(prefixo)
        if cov >= 0.7 and prec >= 0.6:
            while k < len(palavras):
                prox = palavras[k].group()
                pt = tokens(prox)
                baixa = not re.match(r"[A-ZÀ-Þ]", prox)
                if pt and pt <= tt and baixa:
                    k += 1
                    continue
                if not pt and baixa:
                    j = k + 1
                    while j < len(palavras) and not tokens(palavras[j].group()):
                        j += 1
                    if (j < len(palavras) and tokens(palavras[j].group()) <= tt
                            and not re.match(r"[A-ZÀ-Þ]", palavras[j].group())):
                        k += 1
                        continue
                break
            corte = palavras[k - 1].end()
            return texto[corte:].lstrip(" \t.-—–:;,»\"'(").strip()
    return texto


def _repete_titulo(titulo, frag):
    """O trecho cobre a maior parte do título? (parafraseia a manchete)."""
    tt, ft = tokens(titulo), tokens(frag)
    if not tt or not ft:
        return False
    inter = len(tt & ft)
    return inter >= 3 and inter / len(tt) >= 0.7


def resumo_falado(titulo, resumo):
    """Resumo pronto para narração: sem a frase que apenas repete o título."""
    if not resumo:
        return ""
    frases = [f.strip() for f in re.split(r"(?<=[.!?])\s+", resumo) if f.strip()]
    if len(frases) > 1 and _repete_titulo(titulo, frases[0]):
        resto = " ".join(frases[1:]).strip()
        if len(resto) > 40:
            return resto
    novo = _remove_prefixo_titulo(titulo, resumo)
    if novo != resumo:
        return novo if len(novo) > 40 else ""
    if parecido(titulo, resumo) and len(tokens(resumo)) <= len(tokens(titulo)) + 2:
        return ""
    return resumo if len(resumo) > 40 else ""


def imagem(entry):
    for key in ("media_thumbnail", "media_content"):
        v = entry.get(key)
        if isinstance(v, list) and v and isinstance(v[0], dict) and v[0].get("url"):
            return v[0]["url"]
    for l in entry.get("links", []) or []:
        if l.get("rel") == "enclosure" and "image" in (l.get("type") or ""):
            return l.get("href", "")
    m = re.search(r'<img[^>]+src="([^"]+)"', entry.get("summary", "") or "")
    return m.group(1) if m else ""


def normaliza(t):
    return re.sub(r"[^a-z0-9áàâãéêíóôõúç ]", "", (t or "").lower())[:90]


def _sem_acento(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)).lower()


STOP = set((
    "a o as os um uma de do da dos das em no na nos nas para por com sem sob sobre entre e ou "
    "que qual quais como ao aos as é são foi foram ser será serão se sua seu suas seus mais menos "
    "muito pouco já não sim até após antes depois ainda também apenas onde quando porque contra sobre "
    "durante desde nesta neste nessa nesse pela pelo aos das"
).split())


def tokens(t):
    return {
        w for w in re.findall(r"[a-z0-9áàâãéêíóôõúç]+", (t or "").lower())
        if len(w) > 3 and w not in STOP
    }


def parecido(a, b):
    """Considera duas manchetes como a mesma notícia (quase-duplicada)."""
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return False
    inter = len(ta & tb)
    if inter < 3:
        return False
    jac = inter / len(ta | tb)
    cont = inter / min(len(ta), len(tb))
    return jac >= 0.5 or cont >= 0.82


# ------------------------------------------------------------------ #
# Coleta de feeds
# ------------------------------------------------------------------ #

def baixar(url):
    r = requests.get(url, headers={"User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9"}, timeout=TIMEOUT)
    r.raise_for_status()
    return r


def ler_feed(feed):
    nome, cat, url = feed
    try:
        resp = baixar(url)
        parsed = feedparser.parse(resp.content)
        itens = []
        for e in parsed.entries:
            titulo, fonte_embutida = limpar_titulo(e.get("title", ""))
            fonte = fonte_embutida or nome
            link = e.get("link", "")
            when = e.get("published_parsed") or e.get("updated_parsed")
            data = time.strftime("%Y-%m-%dT%H:%M:%SZ", when) if when else ""
            fallback = limpar(e.get("summary", "") or e.get("description", ""))
            itens.append({
                "cat": cat, "source": fonte, "title": titulo, "link": link,
                "date": data, "rss": fallback, "image": imagem(e),
            })
        print(f"  [{cat}] {nome}: {len(itens)} itens")
        return itens
    except Exception as ex:
        print(f"  [{cat}] {nome}: FALHOU ({ex})")
        return []


def coletar():
    todos = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for itens in ex.map(ler_feed, FEEDS):
            todos.extend(itens)
    return todos


# ------------------------------------------------------------------ #
# Resumo real das matérias
# ------------------------------------------------------------------ #

def resolver_link(url):
    """Converte links do Google Notícias para a URL real do veículo."""
    if "news.google.com" not in (url or ""):
        return url
    if not TEM_DECODER:
        return url
    try:
        r = gnewsdecoder(url)
        if isinstance(r, dict):
            real = r.get("decoded_url") or r.get("url")
            if real:
                return real
    except Exception:
        pass
    return url


def extrair_resumo(item):
    url = resolver_link(item["link"])
    item["link"] = url
    try:
        resp = baixar(url)
        # segue redirect / encoding
        if not resp.encoding or resp.encoding.lower() in ("iso-8859-1", "latin-1"):
            resp.encoding = resp.apparent_encoding
        texto = trafilatura.extract(
            resp.text,
            include_comments=False,
            include_tables=False,
            no_fallback=True,
            favor_precision=True,
        )
        if texto:
            s = resumir(texto)
            if len(s) > 50:
                item["summary"] = s
                item["real"] = True
                return item
    except Exception:
        pass
    # fallback: descrição do RSS
    item["summary"] = resumir(item.get("rss", ""), 260) or item["title"]
    item["real"] = False
    return item


def adicionar_resumos(itens):
    with ThreadPoolExecutor(max_workers=8) as ex:
        return list(ex.map(extrair_resumo, itens))


# ------------------------------------------------------------------ #
# Montagem do conteúdo selecionado
# ------------------------------------------------------------------ #

def selecionar(todos):
    # ordena por data (mais recentes primeiro)
    for it in todos:
        it["_ts"] = it["date"] or ""
    todos.sort(key=lambda x: x["_ts"], reverse=True)

    vistos = set()        # títulos normalizados exatos
    links = set()         # links já usados
    aceitos = []          # objetos já aceitos (para near-duplicidade)
    contagem = {c: 0 for c in CATEGORIES}

    for it in todos:
        if not it["title"] or not it["link"]:
            continue
        k = normaliza(it["title"])
        if not k or k in vistos:
            continue
        if it["link"] in links:
            continue
        if contagem.get(it["cat"], 0) >= PER_CATEGORY:
            continue

        # evita ler a mesma notícia várias vezes (mesmo com títulos diferentes)
        if any(parecido(it["title"], a["title"]) for a in aceitos):
            continue

        vistos.add(k)
        links.add(it["link"])
        aceitos.append(it)
        contagem[it["cat"]] += 1

    # devolve mantendo a ordem das categorias
    ordem = {c: i for i, c in enumerate(CATEGORIES)}
    aceitos.sort(key=lambda x: ordem.get(x["cat"], 99))
    return aceitos


# ------------------------------------------------------------------ #
# Roteiro (segmentos) falado
# ------------------------------------------------------------------ #

TRANSICOES = {
    "Brasil": "Começamos pelo Brasil.",
    "Política": "Agora, as notícias de política.",
    "Economia": "Na economia.",
    "Mundo": "No cenário internacional.",
    "Tecnologia": "Em tecnologia.",
    "Esportes": "No esporte.",
    "São Pedro e região": "E as notícias de São Pedro e região.",
}


def data_extenso():
    data = time.strftime("%A, %d de %B de %Y")
    meses = {
        "Monday": "segunda-feira", "Tuesday": "terça-feira", "Wednesday": "quarta-feira",
        "Thursday": "quinta-feira", "Friday": "sexta-feira", "Saturday": "sábado", "Sunday": "domingo",
        "January": "janeiro", "February": "fevereiro", "March": "março", "April": "abril",
        "May": "maio", "June": "junho", "July": "julho", "August": "agosto",
        "September": "setembro", "October": "outubro", "November": "novembro", "December": "dezembro",
    }
    for en, pt in meses.items():
        data = data.replace(en, pt)
    return data


def noticias_narradas(selecionados):
    """Lista (categoria, itens narrados) na ordem, cada notícia uma única vez."""
    plano = []
    for cat in CATEGORIES:
        do_cat = [i for i in selecionados if i["cat"] == cat]
        if not do_cat:
            continue
        reais = [i for i in do_cat if i.get("real")]
        outros = [i for i in do_cat if not i.get("real")]
        narradas = (reais + outros)[:SPOKEN_PER_CATEGORY]
        plano.append((cat, narradas))
    return plano


def montar_segmentos(selecionados):
    """Devolve a sequência do boletim: fala, pausa e vinheta."""
    segs = []
    segs.append({"tipo": "fala",
                 "texto": f"Bom dia! Estas são as principais notícias de {data_extenso()}. "
                          f"Um boletim com as manchetes do momento, com informação de várias fontes. "
                          f"Vamos começar."})

    contador = 0
    for cat, itens in noticias_narradas(selecionados):
        segs.append({"tipo": "fala", "texto": TRANSICOES.get(cat, f"Agora, {cat}.")})
        for it in itens:
            # vinheta só ENTRE notícias (nunca no meio nem depois da última)
            if contador and contador % MUSICA_A_CADA == 0:
                segs.append({"tipo": "musica"})
            segs.append({"tipo": "fala", "texto": it["title"] + "."})
            if it.get("real") and it.get("summary"):
                corpo = resumo_falado(it["title"], it["summary"])
                if corpo:
                    segs.append({"tipo": "pausa", "dur": PAUSA_TITULO})
                    segs.append({"tipo": "fala", "texto": corpo})
            segs.append({"tipo": "pausa", "dur": PAUSA_ITEM})
            contador += 1

    segs.append({"tipo": "pausa", "dur": 1.2})
    segs.append({"tipo": "fala",
                 "texto": "Estas foram as principais notícias de hoje. "
                          "Para ler as matérias completas, acesse a central no seu navegador. "
                          "Bom dia e até a próxima atualização!"})
    return segs


def roteiro_texto(selecionados):
    linhas = [f"Boletim — {data_extenso()}", ""]
    for cat, itens in noticias_narradas(selecionados):
        linhas.append(f"== {cat} ==")
        for it in itens:
            linhas.append(f"• {it['title']}  ({it['source']})")
            if it.get("summary"):
                linhas.append(f"  {it['summary']}")
        linhas.append("")
    return "\n".join(linhas)


# ------------------------------------------------------------------ #
# Áudio: TTS + silêncio + vinheta + montagem (ffmpeg)
# ------------------------------------------------------------------ #

def _run(args):
    subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *args], check=True)


def silencio(dest, dur):
    _run(["-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=mono", "-t", f"{dur:.2f}",
          "-c:a", "libmp3lame", "-b:a", "48k", dest])
    return dest


def _tom(freq, dur, sr=SR, fase=0.0):
    return [math.sin(2 * math.pi * freq * ((i / sr)) + fase) for i in range(int(sr * dur))]


def gerar_jingle(dest, notas=None, dur=None):
    """Vinheta curta e suave, original (sem direitos autorais)."""
    notas = notas or [523.25, 659.25, 783.99, 1046.50, 783.99, 659.25]  # dó maior arpejo
    dur = dur or MUSICA_DUR
    n = int(SR * dur)
    buf = [0.0] * n
    dn = dur / len(notas)
    for i, f in enumerate(notas):
        ini = int(i * dn * SR)
        fim = int((i + 1) * dn * SR)
        for j in range(ini, min(fim, n)):
            tt = (j - ini) / SR
            env = min(1.0, tt / 0.02) * max(0.0, 1 - tt / dn)
            buf[j] += (math.sin(2 * math.pi * f * tt) * 0.5
                       + math.sin(2 * math.pi * 2 * f * tt) * 0.18) * env * 0.22
    wav = dest + ".wav"
    with wave.open(wav, "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, x)) * 32767)) for x in buf))
    _run(["-i", wav, "-c:a", "libmp3lame", "-b:a", "64k", dest])
    os.remove(wav)
    return dest


def preparar_musica(src, dest, dur=MUSICA_DUR):
    fade = 1.2
    _run(["-i", src, "-t", f"{dur:.2f}",
          "-af", f"afade=t=in:d={fade},afade=t=out:st={max(0, dur - fade):.2f}:d={fade}",
          "-ar", str(SR), "-ac", "1", "-b:a", "64k", dest])
    return dest


def preparar_musicas(tmp, quantas):
    """Retorna uma lista de vinhetas: usa music/ se houver, senão gera jingles."""
    fontes = []
    if os.path.isdir(MUSIC_DIR):
        fontes = sorted(glob.glob(os.path.join(MUSIC_DIR, "*.mp3")))
    arquivos = []
    if fontes:
        random.shuffle(fontes)
        for i in range(quantas):
            src = fontes[i % len(fontes)]
            dest = os.path.join(tmp, f"musica-{i}.mp3")
            try:
                arquivos.append(preparar_musica(src, dest))
            except Exception as ex:
                print("    falha na música, usando vinheta:", ex)
                arquivos.append(gerar_jingle(os.path.join(tmp, f"musica-{i}.mp3")))
    else:
        escalas = [
            [523.25, 659.25, 783.99, 1046.50, 783.99, 659.25],
            [587.33, 698.46, 880.00, 1174.66, 880.00, 698.46],
            [493.88, 587.33, 739.99, 987.77, 739.99, 587.33],
        ]
        for i in range(quantas):
            arquivos.append(gerar_jingle(os.path.join(tmp, f"musica-{i}.mp3"),
                                         notas=escalas[i % len(escalas)]))
    return arquivos


def concat(dest, partes):
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
        for p in partes:
            f.write("file '" + os.path.abspath(p).replace("'", "'\\''") + "'\n")
        lista = f.name
    _run(["-f", "concat", "-safe", "0", "-i", lista,
          "-c:a", "libmp3lame", "-ar", str(SR), "-ac", "1", "-b:a", "48k", dest])
    os.remove(lista)
    return dest


async def falar(texto, destino, sem):
    async with sem:
        for tentativa in range(3):
            try:
                c = edge_tts.Communicate(texto, VOZ, rate=RATE, pitch=PITCH)
                await asyncio.wait_for(c.save(destino), timeout=120)
                if os.path.getsize(destino) > 800:
                    return True
            except Exception as ex:
                print(f"    TTS falhou ({ex}); tentando de novo…")
                await asyncio.sleep(2)
    return False


async def gerar_audios(selecionados, segs):
    os.makedirs("audio", exist_ok=True)
    sem = asyncio.Semaphore(4)

    async with asyncio.TaskGroup() as tg:  # type: ignore[attr-defined]
        tarefas_fala = []
        # 1) boletim: cada trecho de fala
        for i, seg in enumerate(segs):
            if seg["tipo"] == "fala":
                seg["_tmp"] = os.path.join(TMP, f"fala-{i}.mp3")
                tarefas_fala.append(tg.create_task(falar(seg["texto"], seg["_tmp"], sem)))
        # 2) áudio por matéria (título + resumo, sem repetir o título)
        idx = {}
        for it in selecionados:
            n = idx.get(it["cat"], 0)
            idx[it["cat"]] = n + 1
            slug = re.sub(r"[^a-z0-9]+", "-", _sem_acento(it["cat"])).strip("-")
            it["audio"] = f"audio/{slug}-{n}.mp3"
            if it.get("real") and it.get("summary"):
                corpo = resumo_falado(it["title"], it["summary"])
                texto = it["title"] if not corpo or corpo == it["title"] else f"{it['title']}. {corpo}"
            else:
                texto = it["title"]
            tarefas_fala.append(tg.create_task(falar(texto, it["audio"], sem)))
    return tarefas_fala


def montar_boletim(segs):
    # prepara silêncios e vinhetas
    n_musicas = sum(1 for s in segs if s["tipo"] == "musica")
    musicas = preparar_musicas(TMP, n_musicas) if n_musicas else []
    sil = {}
    for s in segs:
        if s["tipo"] == "pausa":
            key = f"{s['dur']:.2f}"
            if key not in sil:
                sil[key] = silencio(os.path.join(TMP, f"sil-{key}.mp3"), s["dur"])

    partes = []
    mi = 0
    for s in segs:
        if s["tipo"] == "fala":
            if os.path.exists(s.get("_tmp", "")):
                partes.append(s["_tmp"])
        elif s["tipo"] == "pausa":
            partes.append(sil[f"{s['dur']:.2f}"])
        elif s["tipo"] == "musica" and mi < len(musicas):
            partes.append(musicas[mi]); mi += 1
    if not partes:
        # fallback: ao menos gera o texto se não conseguiu áudio; mas não concatena
        raise RuntimeError("Nada para concatenar no boletim.")
    concat("resumo.mp3", partes)


# ------------------------------------------------------------------ #
# Main
# ------------------------------------------------------------------ #

TMP = tempfile.mkdtemp(prefix="noticias-")


def main():
    # limpa áudios antigos para não deixar arquivos órfãos
    if os.path.isdir("audio"):
        shutil.rmtree("audio", ignore_errors=True)
    os.makedirs("audio", exist_ok=True)

    print("1/5 Buscando feeds…")
    todos = coletar()
    print(f"    total bruto: {len(todos)}")

    print("2/5 Selecionando notícias…")
    selecionados = selecionar(todos)
    print(f"    selecionadas: {len(selecionados)}")

    print("3/5 Extraindo resumos das matérias…")
    selecionados = adicionar_resumos(selecionados)
    com_resumo = sum(1 for i in selecionados if i.get("real"))
    print(f"    com resumo real: {com_resumo}/{len(selecionados)}")

    print("4/5 Montando o boletim…")
    segs = montar_segmentos(selecionados)
    narradas = sum(len(itens) for _, itens in noticias_narradas(selecionados))
    print(f"    notícias narradas: {narradas}")

    print("5/5 Gerando áudio neural e montando…")
    try:
        if FFMPEG:
            asyncio.run(gerar_audios(selecionados, segs))
            montar_boletim(segs)
        else:
            # fallback: boletim em uma única narração (sem pausas/vinheta)
            texto = " ".join(s["texto"] for s in segs if s["tipo"] == "fala")
            asyncio.run(_fallback(selecionados, texto))
    except Exception as ex:
        # mesmo sem áudio, publica as notícias do dia
        print("    aviso: falha ao gerar áudio; publicando só o texto:", ex)

    for it in selecionados:
        it.pop("rss", None)
        it.pop("_ts", None)

    payload = {
        "geradoEm": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "voz": VOZ,
        "audioDia": "resumo.mp3",
        "categorias": CATEGORIES,
        "itens": selecionados,
    }
    with open("noticias.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    with open("resumo.txt", "w", encoding="utf-8") as f:
        f.write(roteiro_texto(selecionados))

    print(f"OK — {len(selecionados)} notícias, boletim e áudios gerados.")


async def _fallback(selecionados, texto):
    sem = asyncio.Semaphore(3)
    await asyncio.gather(falar(texto, "resumo.mp3", sem))
    for it in selecionados:
        if it.get("real") and it.get("summary"):
            corpo = resumo_falado(it["title"], it["summary"])
            t = it["title"] if not corpo or corpo == it["title"] else f"{it['title']}. {corpo}"
        else:
            t = it["title"]
        await falar(t, it["audio"], sem)


if __name__ == "__main__":
    main()
