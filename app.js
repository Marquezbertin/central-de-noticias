"use strict";

/* ============================================================
   Central de Notícias — Brasil
   Lê noticias.json (gerado diariamente) e reproduz:
   - o boletim falado do dia (MP3 neural)
   - o áudio de cada matéria (MP3 neural), com fallback à voz do navegador
   ============================================================ */

const state = {
  itens: [],
  categorias: [],
  filtro: "Todas",
  busca: "",
  tocandoIdx: -1,
  fallbackUtter: null,
  geradoEm: "",
  versao: "",
};

const WORKER = ((window.CENTRAL_CONFIG && window.CENTRAL_CONFIG.workerUrl) || "").replace(/\/+$/, "");

const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};

/* ------------------------------ utils ------------------------------ */

function fmtDur(s) {
  if (!isFinite(s) || s <= 0) return "—:—";
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

function quando(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return "";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 3600) return Math.max(1, Math.round(diff / 60)) + " min atrás";
  if (diff < 86400) return Math.round(diff / 3600) + " h atrás";
  return Math.round(diff / 86400) + " d atrás";
}

function hojeExtenso() {
  return new Date().toLocaleDateString("pt-BR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

/* ------------------------------ áudio ------------------------------ */

const boletim = $("#boletim");
const itemAudio = new Audio();
itemAudio.preload = "metadata";
let activePlayer = null;
let fallbackAtivo = false;
let tocandoRapido = false;

function updMediaSession(it) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: it ? it.title : "Boletim do dia — Central de Notícias",
      artist: it ? it.source : "Central de Notícias — Brasil",
      album: "Central de Notícias",
      artwork: [
        { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    });
  } catch (e) { /* ignora */ }
}

function mediaHandlers() {
  if (!("mediaSession" in navigator)) return;
  const set = (a, h) => { try { navigator.mediaSession.setActionHandler(a, h); } catch (e) {} };
  set("play", () => { activePlayer === "item" ? itemAudio.play() : boletim.play(); });
  set("pause", () => { activePlayer === "item" ? itemAudio.pause() : boletim.pause(); });
  set("stop", () => pararTudo());
}
mediaHandlers();

function pausarBoletim() { if (!boletim.paused) boletim.pause(); }
function pausarItem() { if (!itemAudio.paused) itemAudio.pause(); }

function pararTudo() {
  tocandoRapido = false;
  boletim.pause();
  itemAudio.pause();
  fallbackAtivo = false;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

/* ---------- boletim ---------- */

function setBtnBoletim(playing) {
  const b = $("#b-play");
  b.classList.toggle("playing", playing);
  b.innerHTML = playing
    ? '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
    : '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  b.setAttribute("aria-label", playing ? "Pausar boletim" : "Reproduzir boletim");
}

boletim.addEventListener("loadedmetadata", () => {
  $("#b-dur").textContent = fmtDur(boletim.duration);
  $("#b-seek").max = Math.max(1, boletim.duration);
});

boletim.addEventListener("timeupdate", () => {
  $("#b-seek").value = boletim.currentTime;
  $("#b-cur").textContent = fmtDur(boletim.currentTime);
});

boletim.addEventListener("play", () => { activePlayer = "boletim"; updMediaSession(null); setBtnBoletim(true); });
boletim.addEventListener("pause", () => setBtnBoletim(false));
boletim.addEventListener("ended", () => setBtnBoletim(false));

$("#b-play").addEventListener("click", () => {
  if (!boletim.src) return;
  if (boletim.paused) {
    pararTudo();
    boletim.play();
  } else {
    boletim.pause();
  }
});

$("#b-seek").addEventListener("input", () => {
  boletim.currentTime = Number($("#b-seek").value);
});

$("#b-rate").addEventListener("change", (e) => {
  boletim.playbackRate = Number(e.target.value);
});

/* ---------- item ---------- */

itemAudio.addEventListener("ended", () => limparTocando());
itemAudio.addEventListener("error", () => {
  if (fallbackAtivo) return;
  const it = state.itens[state.tocandoIdx];
  if (it) falarTexto(`${it.title}. ${it.summary || ""}`);
});

function limparTocando() {
  state.tocandoIdx = -1;
  fallbackAtivo = false;
  document.querySelectorAll(".card.playing").forEach((c) => c.classList.remove("playing"));
  document.querySelectorAll(".btn-listen.on").forEach((b) => {
    b.classList.remove("on");
    b.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M8 5v14l11-7z"/></svg> Ouvir';
  });
}

function falarTexto(texto) {
  if (!("speechSynthesis" in window)) return;
  if (fallbackAtivo) return;
  fallbackAtivo = true;
  const u = new SpeechSynthesisUtterance(texto);
  const vs = window.speechSynthesis.getVoices();
  const pt = vs.find((v) => /pt-BR|pt_BR/i.test(v.lang)) || vs.find((v) => /^pt/i.test(v.lang));
  if (pt) u.voice = pt;
  u.lang = (pt && pt.lang) || "pt-BR";
  u.rate = 1.05;
  u.onend = () => limparTocando();
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

function tocarItem(idx, btn) {
  const it = state.itens[idx];
  if (!it) return;

  if (state.tocandoIdx === idx && !itemAudio.paused) {
    itemAudio.pause();
    limparTocando();
    return;
  }

  pararTudo();
  limparTocando();
  state.tocandoIdx = idx;
  activePlayer = "item";
  updMediaSession(it);

  const card = btn.closest(".card");
  if (card) card.classList.add("playing");
  btn.classList.add("on");
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg> Tocando';

  if (it.audio) {
    itemAudio.src = it.audio + state.versao;
    itemAudio.playbackRate = Number($("#b-rate").value) || 1;
    itemAudio.play().catch(() => falarTexto(`${it.title}. ${it.summary || ""}`));
  } else {
    falarTexto(`${it.title}. ${it.summary || ""}`);
  }
}

/* ------------------------------ render ------------------------------ */

function renderStats() {
  const fontes = new Set(state.itens.map((i) => i.source));
  const cats = new Set(state.itens.map((i) => i.cat));
  $("#st-noticias").textContent = state.itens.length;
  $("#st-fontes").textContent = fontes.size;
  $("#st-cats").textContent = cats.size;
  const reais = state.itens.filter((i) => i.real).length;
  $("#hero-resumo").textContent =
    `Um boletim com ${state.itens.length} notícias de ${fontes.size} veículos diferentes, ` +
    `organizadas em ${cats.size} seções. ${reais} matérias têm resumo detalhado.`;
}

function renderTabs() {
  const tabs = $("#tabs");
  tabs.innerHTML = "";
  const cats = ["Todas", ...state.categorias.filter((c) => state.itens.some((i) => i.cat === c))];
  cats.forEach((c) => {
    const b = el("button", "tab" + (state.filtro === c ? " active" : ""), c);
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => { state.filtro = c; renderTabs(); render(); });
    tabs.appendChild(b);
  });
}

function passarFiltro(it) {
  if (state.filtro !== "Todas" && it.cat !== state.filtro) return false;
  if (state.busca) {
    const alvo = (it.title + " " + (it.summary || "") + " " + it.source + " " + it.cat).toLowerCase();
    if (!alvo.includes(state.busca)) return false;
  }
  return true;
}

function card(it, idx) {
  const c = el("article", "card");
  c.dataset.idx = idx;

  const media = el("div", "card-media");
  if (it.image) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = it.image;
    img.alt = "";
    img.addEventListener("error", () => img.remove());
    media.appendChild(img);
  }
  media.appendChild(el("span", "cat-chip", it.cat));
  c.appendChild(media);

  const body = el("div", "card-body");
  const h3 = el("h3");
  const a = el("a", null, it.title);
  a.href = it.link;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  h3.appendChild(a);
  body.appendChild(h3);

  if (it.summary) body.appendChild(el("p", null, it.summary));

  const meta = el("div", "card-meta");
  meta.appendChild(el("span", "src", it.source));
  if (it.date) meta.appendChild(el("span", null, quando(it.date)));
  if (it.real) meta.appendChild(el("span", "badge-real", "resumo"));
  body.appendChild(meta);

  const actions = el("div", "card-actions");
  const listen = el("button", "btn-listen");
  listen.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M8 5v14l11-7z"/></svg> Ouvir';
  listen.addEventListener("click", () => tocarItem(Number(c.dataset.idx), listen));
  actions.appendChild(listen);

  const read = el("a", "btn-read", "Ler matéria ›");
  read.href = it.link;
  read.target = "_blank";
  read.rel = "noopener noreferrer";
  actions.appendChild(read);
  body.appendChild(actions);

  c.appendChild(body);
  return c;
}

function render() {
  const news = $("#news");
  news.innerHTML = "";
  const lista = state.itens.map((it, i) => [it, i]).filter(([it]) => passarFiltro(it));

  if (!lista.length) {
    const e = el("div", "empty");
    e.innerHTML = "<strong>Nada encontrado</strong>Tente outro termo de busca ou outra seção.";
    news.appendChild(e);
    return;
  }
  lista.forEach(([it, i]) => news.appendChild(card(it, i)));
}

function renderSkeleton() {
  const news = $("#news");
  news.innerHTML = "";
  for (let i = 0; i < 6; i++) news.appendChild(el("div", "skeleton"));
}

/* ------------------------------ carga ------------------------------ */

function normalizar(dados) {
  // aceita formato novo {itens:[...]} ou antigo (array)
  const itens = Array.isArray(dados) ? dados : (dados.itens || []);
  const categorias = (!Array.isArray(dados) && dados.categorias) || [];
  return { itens, categorias, audioDia: (!Array.isArray(dados) && dados.audioDia) || "resumo.mp3",
           geradoEm: (!Array.isArray(dados) && dados.geradoEm) || "" };
}

function dataGerado(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return "Atualizado em " + d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function carregar() {
  $("#status").textContent = "Carregando notícias…";
  $("#refresh").classList.add("spin");
  renderSkeleton();
  try {
    const res = await fetch("noticias.json?t=" + Date.now(), { cache: "no-store" });
    const dados = await res.json();
    const { itens, categorias, audioDia } = normalizar(dados);

    state.itens = itens;
    state.categorias = categorias.length ? categorias : [...new Set(itens.map((i) => i.cat))];

    state.geradoEm = dados.geradoEm || "";
    state.versao = dados.geradoEm ? "?v=" + encodeURIComponent(dados.geradoEm) : "";

      boletim.src = audioDia + state.versao;
      $("#b-download").href = audioDia + state.versao;
      $("#b-play").disabled = false;

      renderStats();
      renderTabs();
      render();

      if (dados.geradoEm) $("#generated").textContent = dataGerado(dados.geradoEm);
      $("#updated").textContent = dataGerado(dados.geradoEm) || "";
      $("#status").textContent = `${itens.length} not��cias de ${new Set(itens.map((i) => i.source)).size} fontes.`;

      if (!boletim.duration) {
        // aguarda metadados
        boletim.load();
      }
  } catch (e) {
    $("#news").innerHTML = "";
    const d = el("div", "empty");
    d.innerHTML = "<strong>Não foi possível carregar as notícias</strong>Verifique a conexão e clique em atualizar.";
    $("#news").appendChild(d);
    $("#status").textContent = "Falha ao carregar.";
    $("#b-play").disabled = true;
  } finally {
    $("#refresh").classList.remove("spin");
  }
}

/* ------------------------------ eventos ------------------------------ */

$("#q").addEventListener("input", (e) => {
  state.busca = e.target.value.trim().toLowerCase();
  render();
});

$("#refresh").addEventListener("click", carregar);

/* --------------- atualizar agora (ao vivo): busca e toca --------------- */

const btnForcar = $("#forcar");
if (WORKER && btnForcar) {
  btnForcar.hidden = false;
  btnForcar.addEventListener("click", atualizarAgora);
}

let urlBoletimVivo = null;

async function atualizarAgora() {
  const btn = $("#forcar");
  btn.disabled = true;
  pararTudo();
  $("#status").textContent = "Buscando as notícias mais recentes…";
  try {
    const r = await fetch(WORKER + "/rapido?n=20", { cache: "no-store" });
    const j = await r.json();
    if (!r.ok || !j.ok || !j.itens || !j.itens.length) throw new Error("sem itens");

    const novos = j.itens.map((i) => ({ ...i, date: j.atualizadoEm, real: !!i.summary }));
    state.itens = novos;
    state.categorias = [...new Set(novos.map((i) => i.cat))];
    state.filtro = "Todas";
    state.busca = "";
    $("#q").value = "";

    renderStats();
    renderTabs();
    render();
    $("#generated").textContent = "Ao vivo · " + new Date(j.atualizadoEm).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    $("#updated").textContent = $("#generated").textContent;
    $("#status").textContent = `Montando o boletim com ${novos.length} notícias…`;
    await tocarBoletimVivo(novos);
  } catch (e) {
    $("#status").textContent = "Não foi possível buscar notícias novas agora. Tente de novo.";
  } finally {
    btn.disabled = false;
  }
}

async function tocarBoletimVivo(itens) {
  $("#status").textContent = "Gravando o áudio (voz do boletim)… pode levar alguns segundos.";
  try {
    const corpo = itens.map((i) => ({ title: i.title, summary: i.summary || "" }));
    const r = await fetch(WORKER + "/boletim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itens: corpo }),
    });
    if (!r.ok) throw new Error("boletim " + r.status);
    const blob = await r.blob();
    if (blob.size < 500) throw new Error("audio vazio");

    pararTudo();
    if (urlBoletimVivo) { URL.revokeObjectURL(urlBoletimVivo); urlBoletimVivo = null; }
    urlBoletimVivo = URL.createObjectURL(blob);
    boletim.src = urlBoletimVivo;
    const dl = $("#b-download");
    if (dl) { dl.href = urlBoletimVivo; dl.setAttribute("download", "boletim-ao-vivo.mp3"); }

    boletim.play()
      .then(() => { $("#status").textContent = `Boletim ao vivo com ${itens.length} notícias.`; })
      .catch(() => { $("#status").textContent = "Boletim pronto. Toque em ▶ para ouvir."; });
  } catch (e) {
    $("#status").textContent = "Não consegui gerar o áudio agora; lendo com a voz do aparelho…";
    await lerComVozDoAparelho(itens);
  }
}

async function lerComVozDoAparelho(itens) {
  pararTudo();
  tocandoRapido = true;
  for (const it of itens) {
    if (!tocandoRapido) break;
    $("#status").textContent = `Tocando: ${it.source} — ${it.title}`;
    await falarTextoLocal(`${it.title}. ${it.summary || ""}`);
  }
  tocandoRapido = false;
  $("#status").textContent = "Fim do boletim ao vivo.";
}

function falarTextoLocal(texto) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    const u = new SpeechSynthesisUtterance(texto);
    const vs = window.speechSynthesis.getVoices();
    const pt = vs.find((v) => /pt-BR|pt_BR/i.test(v.lang)) || vs.find((v) => /^pt/i.test(v.lang));
    if (pt) u.voice = pt;
    u.lang = (pt && pt.lang) || "pt-BR";
    u.rate = 1.05;
    u.onend = resolve;
    u.onerror = resolve;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
}

/* ------------------------------ init ------------------------------ */

$("#hoje").textContent = hojeExtenso();
const coverDate = $("#cover-date");
if (coverDate) {
  coverDate.textContent = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
}
if ("speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = () => {};
carregar();

/* ---------- PWA: service worker + instalação ---------- */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

let deferredPrompt = null;
const btnInstall = $("#install");
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (btnInstall) btnInstall.hidden = false;
});
if (btnInstall) {
  btnInstall.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    btnInstall.hidden = true;
  });
}
window.addEventListener("appinstalled", () => { if (btnInstall) btnInstall.hidden = true; });

// Atalho "Ouvir o boletim do dia" (menu do app instalado)
if (new URLSearchParams(location.search).has("play")) {
  setTimeout(() => { const b = $("#b-play"); if (b && !b.disabled) b.click(); }, 800);
}
