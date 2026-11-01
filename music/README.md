# Pasta de músicas (opcional)

Coloque aqui arquivos `.mp3` de músicas que **você tem o direito de usar**
(suas próprias gravações, músicas de domínio público ou com licença livre).

O gerador usa essas músicas como **vinheta** entre os blocos de notícias —
uma música a cada `MUSICA_A_CADA` notícias, com duração de `MUSICA_DUR` segundos
(por padrão, a cada 5 notícias, por 7 segundos).

Se esta pasta estiver vazia, o gerador cria uma **vinheta instrumental própria e livre
de direitos** automaticamente (um arpejo suave), então não é necessário ter músicas.

> Importante: não inclua aqui músicas protegidas por direitos autorais sem autorização.
> Este projeto é público; respeite os direitos dos artistas.

## Configuração (variáveis de ambiente)

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `MUSICA_A_CADA` | `5` | Toca uma vinheta a cada N notícias |
| `MUSICA_DUR` | `7.0` | Duração da vinheta em segundos |
| `PER_CATEGORY` | `8` | Quantas notícias aparecem no site por seção |
| `SPOKEN` | igual a `PER_CATEGORY` | Quantas notícias são narradas por seção (todas, por padrão) |
| `PAUSA_TITULO` | `1.0` | Pausa entre o título e o resumo (segundos) |
| `PAUSA_ITEM` | `2.2` | Pausa entre uma notícia e outra (segundos) |

Exemplo: para tocar uma música a cada 6 notícias, por 10 segundos:

```
MUSICA_A_CADA=6 MUSICA_DUR=10 python scripts/gerar.py
```
