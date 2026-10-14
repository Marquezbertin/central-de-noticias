# Central de Notícias — Brasil

Central pessoal de notícias com **boletim falado diário**, reunindo dezenas de fontes
jornalísticas (G1/Globo, Folha, UOL, CNN, BBC, Veja, Exame, InfoMoney, GE, CBN, Band, Record
e veículos de São Pedro e região) em um único lugar.

Funciona 100% no navegador, é gratuita e publicada pelo **GitHub Pages**.
Também é um **app instalável (PWA)**: pode ser adicionado à tela inicial do celular e
ouvido com a tela bloqueada, com os controles na tela de bloqueio.

## O que ela faz

- **Reúne** notícias de várias fontes via feeds RSS.
- **Resume a matéria** de verdade: o texto real é extraído da página e transformado em um resumo
  (não é só a leitura do título).
- **Narra** o resumo com **voz neural humana** (edge-tts) — um boletim completo do dia em MP3
  e um áudio por matéria. O boletim lê o **título e depois o resumo**, com **pausas** entre as
  notícias e **vinhetas musicais** a cada 5 notícias. Se o MP3 não estiver disponível, usa a voz
  do navegador.
- **Não repete** a mesma notícia: deduplica de forma exata e por similaridade de texto.
- Organiza em seções: **Brasil, Política, Economia, Mundo, Tecnologia, Esportes e São Pedro e região**.
- Mostra a fonte e o link para a matéria original em cada card.
- **Busca** por assunto, fonte ou palavra-chave.
- É **instalável no celular (PWA)** e funciona com a tela bloqueada (controles de mídia).
- Atualiza tudo automaticamente **todos os dias** por meio de um GitHub Action.

## Como usar

1. Abra a página publicada no link do GitHub Pages deste repositório.
2. Ouça o **Boletim do dia** no player principal (ou clique em *Baixar MP3*).
3. Para uma notícia específica, clique em **Ouvir** no card.
4. Use as abas para filtrar por seção e a busca para encontrar assuntos.

### Instalar no celular

- **Android (Chrome):** menu ⋮ → *Instalar aplicativo* (ou o botão *Instalar app* na página).
- **iPhone (Safari):** Compartilhar → *Adicionar à Tela de Início*.

## Fontes

| Fonte | Seções |
| --- | --- |
| G1 / Globo | Brasil, Política, Economia, Mundo, Tecnologia, São Pedro e região |
| Folha de S.Paulo | Política, Economia, Mundo |
| UOL | Brasil, Economia, Tecnologia, Esportes |
| CNN Brasil, BBC News Brasil, Agência Brasil, Veja, Metrópoles | Brasil / Mundo |
| Poder360, IstoÉ, Jovem Pan | Política / Brasil |
| Exame, InfoMoney | Economia |
| Canaltech, Olhar Digital | Tecnologia |
| GE / Globo | Esportes |
| CBN, BandNews, Record News | Brasil (via Google Notícias) |
| Google Notícias | reforço de cobertura e notícias locais |

Os resumos são extrativos (trechos reais das matérias). Todo o conteúdo e os direitos pertencem a cada veículo.

## Estrutura

```
index.html                          Página da central
styles.css                          Estilo
app.js                              Player de áudio, busca, filtros, cards e PWA
sw.js                               Service Worker (PWA, cache offline do app)
manifest.webmanifest                Manifesto do PWA (instalação no celular)
icons/                              Ícones do app (192, 512, maskable, Apple)
noticias.json                       Notícias + resumos + links do dia (gerado)
resumo.mp3                          Boletim falado completo do dia (gerado)
resumo.txt                          Roteiro do boletim (gerado)
audio/<secao>-<n>.mp3               Áudio de cada matéria (gerado)
music/                              (opcional) músicas de vinheta — veja music/README.md
scripts/gerar.py                    Busca, resume e narra as notícias
scripts/make_icons.py               Gera os ícones do PWA (uso único)
requirements.txt                    Dependências Python
.github/workflows/update-news.yml   Atualização diária automática
.github/workflows/limpar-historico.yml  Limpeza mensal do histórico (squash)
```

## Atualização automática

O workflow executa `scripts/gerar.py` todos os dias às **06:00 (horário de Brasília)**,
gera `noticias.json`, o boletim `resumo.mp3`, os áudios por matéria e publica tudo.

Para rodar manualmente: **Actions → Atualizar notícias → Run workflow**.

### Limpeza mensal do histórico

Como o áudio muda todo dia, o histórico do Git cresce (~28 MB/dia). Para o repositório não lotar,
existe o workflow **Limpar histórico**, que roda no **dia 1º de cada mês** e reduz todo o histórico
a **um único commit** com os arquivos atuais (squash) e faz push forçado. O site continua igual; só o
histórico de commits antigos é descartado.

- Para limpar também no meio do mês, troque o `cron` em `.github/workflows/limpar-historico.yml`
  por `"0 3 1,15 * *"` (dias 1 e 15).
- Para rodar na hora: **Actions → Limpar histórico → Run workflow**.
- Observação: por usar push forçado, clones locais antigos precisariam ser baixados de novo.

### Detalhes técnicos

- Coleta RSS com `feedparser` e `requests`.
- Resolve links do Google Notícias para a URL real do veículo (`googlenewsdecoder`).
- Extrai o texto da matéria com `trafilatura` e monta um resumo extrativo.
- Remove notícias repetidas: dedupe por título exato e por **similaridade** (evita ler a mesma
  notícia vinda de fontes diferentes).
- Monta o boletim em **segmentos** (fala, pausa, vinheta) e saltando o trecho do resumo que apenas
  repete o título, para não ler a mesma informação duas vezes.
- Gera a voz com `edge-tts` (voz `pt-BR-ThalitaMultilingualNeural`) e junta tudo com **ffmpeg**.

## Personalização

Edite a lista `FEEDS` e `CATEGORIES` em `scripts/gerar.py` para incluir/remover fontes e seções.
As variáveis de ambiente também são ajustáveis: `PER_CATEGORY` (notícias por seção no site),
`SPOKEN` (notícias narradas por seção — por padrão, **todas** as exibidas),
`PAUSA_TITULO`/`PAUSA_ITEM` (pausas em segundos),
`MUSICA_A_CADA` e `MUSICA_DUR` (vinheta a cada N notícias, com N segundos).

Para usar suas próprias músicas de fundo, coloque arquivos `.mp3` em `music/`
(veja `music/README.md`). Sem músicas, o gerador cria uma vinheta instrumental própria, livre de direitos.
