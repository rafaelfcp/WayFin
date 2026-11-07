// Wayfin — Worker de produção.
// Serve o site estático (binding ASSETS) e executa as funções de /api/*, que foram escritas
// no formato do Cloudflare Pages (functions/api/...). O roteador abaixo chama essas mesmas
// funções sem alterá-las: onRequestGet / onRequestPost / onRequest recebem { request, env, ... }.
import * as checkout from '../functions/api/checkout.js'
import * as roteiroIa from '../functions/api/roteiro-ia.js'
import * as webhookMercadoPago from '../functions/api/webhook/mercadopago.js'

const ROTAS = {
  '/api/checkout': checkout,
  '/api/roteiro-ia': roteiroIa,
  '/api/webhook/mercadopago': webhookMercadoPago,
}

const METODO = { GET: 'onRequestGet', POST: 'onRequestPost', PUT: 'onRequestPut', PATCH: 'onRequestPatch', DELETE: 'onRequestDelete', OPTIONS: 'onRequestOptions', HEAD: 'onRequestHead' }

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const caminho = url.pathname.replace(/\/+$/, '') || '/'
    const modulo = ROTAS[caminho]

    if (!modulo) {
      if (caminho.startsWith('/api/')) return Response.json({ error: 'not_found' }, { status: 404 })
      return env.ASSETS.fetch(request)
    }

    const handler = modulo[METODO[request.method]] ?? modulo.onRequest
    if (!handler) return new Response('Method Not Allowed', { status: 405, headers: { Allow: Object.keys(METODO).filter((m) => modulo[METODO[m]]).join(', ') } })

    // mesmo "context" que o Pages entrega às funções
    return handler({
      request,
      env,
      params: {},
      data: {},
      waitUntil: ctx.waitUntil.bind(ctx),
      passThroughOnException: () => ctx.passThroughOnException?.(),
      next: () => env.ASSETS.fetch(request),
    })
  },
}
