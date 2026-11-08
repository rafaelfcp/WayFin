// POST /api/webhook/mercadopago
//
// Fluxo:
//   1. Valida a assinatura x-signature (HMAC-SHA256) se MP_WEBHOOK_SECRET estiver configurado.
//   2. Nunca confia no corpo: busca o recurso na API do MP com o nosso Access Token.
//   3. Confere valor e moeda contra PRICES (checkout.js).
//   4. Chama a função public.mp_registrar_pagamento (Postgres), que é IDEMPOTENTE:
//      grava o ledger, libera/revoga acesso e calcula o vencimento uma única vez.
//
// Códigos de resposta (o MP reenvia enquanto não receber 2xx):
//   200 → processado OU irrelevante (tipo ignorado, id inexistente, dado inválido). Não adianta reenviar.
//   401 → assinatura inválida.
//   500 → falha NOSSA e transitória (API do MP fora, Supabase fora). Reenvio é seguro: tudo é idempotente.
//
// Eventos tratados:
//   payment                           → Passe e Anual (pagamento único); estornos de qualquer plano
//   subscription_authorized_payment   → cada cobrança do Mensal
//   subscription_preapproval          → só log. Cancelar a assinatura NÃO corta o acesso: o período
//                                       já pago vence sozinho (current_period_end).
//
// Variáveis de ambiente (além das de checkout.js):
//   SUPABASE_SERVICE_ROLE_KEY → service_role key do Supabase [secret]  (NUNCA no index.html)
//   MP_WEBHOOK_SECRET         → "Assinatura secreta" em MP → Suas integrações → Webhooks [secret]
import { PRICES } from '../checkout.js';

const MP_API = 'https://api.mercadopago.com';
const REF_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(monthly|annual|trip_pass)$/i;

class Transitorio extends Error {}   // erro que deve virar 500 (MP reenvia)

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  try {
    if (!env.MP_ACCESS_TOKEN || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('webhook_nao_configurado');
      return new Response('nao_configurado', { status: 500 });
    }

    let body = {};
    try { body = await request.json(); } catch {}
    const type = body.type || url.searchParams.get('type') || body.topic || url.searchParams.get('topic');
    const id = String(url.searchParams.get('data.id') || body?.data?.id || url.searchParams.get('id') || '');

    // 1) Assinatura
    if (env.MP_WEBHOOK_SECRET) {
      if (!request.headers.get('x-signature')) {
        // IPN legado (sem assinatura). O webhook assinado do mesmo evento cobre; ignora.
        return ok('ipn_ignorado');
      }
      if (!(await assinaturaValida(request, url, env.MP_WEBHOOK_SECRET))) {
        console.warn('webhook_assinatura_invalida', type, id);
        return new Response('assinatura_invalida', { status: 401 });
      }
    } else {
      console.warn('webhook_sem_MP_WEBHOOK_SECRET: assinatura não verificada (o recurso ainda é revalidado na API do MP)');
    }

    if (!id || !/^[0-9A-Za-z_-]+$/.test(id)) return ok('sem_id');

    // 2) Roteamento por tipo
    let resultado;
    if (type === 'payment') {
      resultado = await tratarPagamento(env, id);
    } else if (type === 'subscription_authorized_payment') {
      resultado = await tratarCobrancaRecorrente(env, id);
    } else if (type === 'subscription_preapproval' || type === 'preapproval') {
      const sub = await mpGet(env, `/preapproval/${id}`);
      resultado = `preapproval_${sub?.status ?? 'inexistente'}`;
    } else {
      resultado = `tipo_ignorado_${type}`;
    }

    console.log('webhook_mp', type, id, resultado);
    return ok(resultado);
  } catch (e) {
    console.error('webhook_mp_erro', e instanceof Transitorio ? 'transitorio' : 'inesperado', String(e?.message || e));
    return new Response('erro', { status: 500 });   // MP reenvia; idempotência garante que é seguro
  }
}

// ── Pagamento único (Passe/Anual) e estornos ────────────────────────────────────
async function tratarPagamento(env, paymentId) {
  const pay = await mpGet(env, `/v1/payments/${paymentId}`);
  if (!pay) return 'pagamento_inexistente';

  const alvo = await resolverDono(env, pay);
  if (!alvo) return 'sem_external_reference';

  // Cobranças do Mensal também chegam aqui. A aprovação delas é aplicada pelo
  // subscription_authorized_payment; aqui aplicamos também (a função é idempotente),
  // então tanto faz qual evento chega primeiro.
  return registrar(env, pay, alvo);
}

// ── Cobrança recorrente do Mensal ───────────────────────────────────────────────
async function tratarCobrancaRecorrente(env, authorizedPaymentId) {
  const ap = await mpGet(env, `/authorized_payments/${authorizedPaymentId}`);
  if (!ap) return 'cobranca_inexistente';
  const paymentId = ap.payment?.id;
  if (!paymentId) return `cobranca_sem_pagamento_${ap.status ?? ''}`;   // ainda agendada / sem tentativa

  const pay = await mpGet(env, `/v1/payments/${paymentId}`);
  if (!pay) return 'pagamento_inexistente';

  const sub = ap.preapproval_id ? await mpGet(env, `/preapproval/${ap.preapproval_id}`) : null;
  const alvo = parseRef(sub?.external_reference);
  if (!alvo) return 'preapproval_sem_external_reference';

  return registrar(env, pay, { ...alvo, preapprovalId: ap.preapproval_id });
}

// Descobre user/plano: external_reference do pagamento ou, nas cobranças do Mensal, da assinatura.
// (Validar no sandbox qual campo o MP preenche nas cobranças recorrentes — por isso a cadeia.)
async function resolverDono(env, pay) {
  const direto = parseRef(pay.external_reference);
  if (direto) return direto;

  const preId = pay.metadata?.preapproval_id
    || pay.point_of_interaction?.transaction_data?.subscription_id;
  if (!preId) return null;
  const sub = await mpGet(env, `/preapproval/${preId}`);
  const viaSub = parseRef(sub?.external_reference);
  return viaSub ? { ...viaSub, preapprovalId: preId } : null;
}

async function registrar(env, pay, { userId, plan, preapprovalId = null }) {
  const price = PRICES[plan];
  // 3) Valor e moeda: nunca libera acesso por pagamento menor que o preço do plano
  if (pay.status === 'approved') {
    const pago = Number(pay.transaction_amount);
    if (pay.currency_id !== 'BRL' || !(pago >= price.amount - 0.01)) {
      console.error('webhook_valor_divergente', pay.id, plan, pay.currency_id, pago, price.amount);
      return 'valor_divergente';
    }
  }

  // 4) Função idempotente no banco
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/mp_registrar_pagamento`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
    },
    body: JSON.stringify({
      p_payment_id: String(pay.id),
      p_user: userId,
      p_plan: plan,
      p_status: pay.status,
      p_status_detail: pay.status_detail ?? null,
      p_valor: Number(pay.transaction_amount ?? price.amount),
      p_metodo: pay.payment_type_id ?? null,
      p_preapproval_id: preapprovalId,
      p_aprovado_em: pay.date_approved ?? null
    })
  });
  if (!r.ok) {
    const txt = await r.text();
    // 23503 = FK: user_id não existe mais (conta apagada). Reenviar não resolve.
    if (r.status === 409 && txt.includes('23503')) return 'usuario_inexistente';
    throw new Transitorio(`supabase_rpc_${r.status}: ${txt.slice(0, 300)}`);
  }
  return await r.json();   // 'aplicado' | 'ja_aplicado' | 'revogado' | 'ignorado_pending' ...
}

// ── Helpers ─────────────────────────────────────────────────────────────────────
async function mpGet(env, path) {
  const r = await fetch(`${MP_API}${path}`, { headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` } });
  if (r.status === 404) return null;                       // id de teste / inexistente: não reenviar
  if (!r.ok) throw new Transitorio(`mp_${r.status}_${path}`);
  return r.json();
}

export function parseRef(ref) {
  const m = REF_RE.exec(String(ref ?? ''));
  return m ? { userId: m[1].toLowerCase(), plan: m[2].toLowerCase() } : null;
}

// Manifesto oficial do MP: "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
// (partes ausentes são omitidas; data.id alfanumérico vai em minúsculas)
export async function assinaturaValida(request, url, secret) {
  const partes = Object.fromEntries(
    (request.headers.get('x-signature') || '').split(',')
      .map((p) => p.split('=').map((s) => s.trim()))
      .filter((kv) => kv.length === 2)
  );
  const { ts, v1 } = partes;
  if (!ts || !v1) return false;

  let dataId = url.searchParams.get('data.id') || '';
  if (/^[0-9a-z]+$/i.test(dataId)) dataId = dataId.toLowerCase();
  const requestId = request.headers.get('x-request-id') || '';

  let manifesto = '';
  if (dataId) manifesto += `id:${dataId};`;
  if (requestId) manifesto += `request-id:${requestId};`;
  manifesto += `ts:${ts};`;

  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const assinatura = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(manifesto));
  const esperado = [...new Uint8Array(assinatura)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return iguaisTempoConstante(esperado, v1.toLowerCase());
}

function iguaisTempoConstante(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function ok(msg) {
  return new Response(msg, { status: 200 });
}
