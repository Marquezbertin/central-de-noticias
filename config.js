/* Configuração da Central de Notícias.
 *
 * Para habilitar o botão "Atualizar agora" (busca notícias novas na hora),
 * coloque aqui a URL do seu Cloudflare Worker. Sem isso, o botão fica escondido.
 *
 * Passo a passo para criar o Worker: veja worker/README.md
 *
 * Exemplo:
 *   window.CENTRAL_CONFIG = { workerUrl: "https://central-noticias.eu.workers.dev" };
 */
window.CENTRAL_CONFIG = {
  workerUrl: "https://central-de-noticias.bertinmarquez84.workers.dev",
};
