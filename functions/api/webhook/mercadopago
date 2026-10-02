// Cloudflare Pages Function — POST /api/webhook/mercadopago
//
// O Mercado Pago só manda { type, data: { id } } — a gente nunca confia nisso
// direto, sempre busca o recurso de verdade na API deles (com o nosso próprio
// Access Token) antes de liberar qualquer coisa. Depois grava em
// "subscriptions" usando a SERVICE ROLE KEY (a única forma de escrever ali,
// já que a tabela não tem policy de insert/update pro cliente — ver 001_planos.sql).
//
// Configure esta URL no painel do Mercado Pago:
//   Seu app → Webhooks → URL: https://SEU-DOMINIO/api/webhook/mercadopago
//   Eventos: "Pagamentos" e "Assinaturas"
//
// Variáveis de ambiente esperadas (além das de /api/checkout.js):
//   SUPABASE_SERVICE_ROLE_KEY → Supabase → Settings → API → service_role key
//                               (NUNCA exponha essa chave no index.html)
export async function onRequestPost({ request, env }) {
  try {
    const url = new URL(request.url);
    let body = {};
    try { body = await request.json(); } catch {}
    const type = body.type || body.topic || url.searchParams.get('type') || url.searchParams.get('topic');
    const id = (body.data && body.data.id) || url.searchParams.get('id') || url.searchParams.get('data.id');
    if (!id || !env.MP_ACCESS_TOKEN) return new Response('ok', { status: 200 });

    const mpAuth = { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` };

    if (type === 'payment') {
      const pay = await (await fetch(`https://api.mercadopago.com/v1/payments/${id}`, { headers: mpAuth })).json();
      if (pay.status === 'approved' && pay.external_reference) {
        const [userId, plan] = pay.external_reference.split(':');
        await upsertSubscription(env, {
          user_id: userId,
          plan,
          status: 'active',
          provider: 'mercadopago',
          provider_customer_id: pay.payer?.id ? String(pay.payer.id) : null,
          provider_subscription_id: `mp_payment_${pay.id}`,
          current_period_end: plan === 'trip_pass' ? addDays(30) : null
        });
      }
    } else if (type === 'preapproval' || type === 'subscription_preapproval') {
      const sub = await (await fetch(`https://api.mercadopago.com/preapproval/${id}`, { headers: mpAuth })).json();
      if (sub.external_reference) {
        const [userId, plan] = sub.external_reference.split(':');
        await upsertSubscription(env, {
          user_id: userId,
          plan,
          status: sub.status === 'authorized' ? 'active' : 'canceled',
          provider: 'mercadopago',
          provider_customer_id: sub.payer_id ? String(sub.payer_id) : null,
          provider_subscription_id: `mp_preapproval_${sub.id}`,
          current_period_end: sub.status === 'authorized' ? addDays(plan === 'annual' ? 365 : 30) : null
        });
      }
    } else if (type === 'subscription_authorized_payment') {
      // uma cobrança recorrente foi paga (renovação) → estende o vencimento
      const ap = await (await fetch(`https://api.mercadopago.com/authorized_payments/${id}`, { headers: mpAuth })).json();
      if (ap.preapproval_id) {
        const sub = await (await fetch(`https://api.mercadopago.com/preapproval/${ap.preapproval_id}`, { headers: mpAuth })).json();
        if (sub.external_reference) {
          const [userId, plan] = sub.external_reference.split(':');
          await upsertSubscription(env, {
            user_id: userId,
            plan,
            status: ap.status === 'approved' ? 'active' : 'past_due',
            provider: 'mercadopago',
            provider_subscription_id: `mp_preapproval_${sub.id}`,
            current_period_end: ap.status === 'approved' ? addDays(plan === 'annual' ? 365 : 30) : null
          });
        }
      }
    }
    return new Response('ok', { status: 200 });
  } catch (e) {
    // Responde 200 mesmo em erro nosso pra não entrar num loop de retentativas
    // do Mercado Pago — mas o erro fica nos logs do Cloudflare Pages pra investigar.
    console.error('webhook_mercadopago_erro', e);
    return new Response('ok', { status: 200 });
  }
}

function addDays(n) {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
}

async function upsertSubscription(env, row) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?on_conflict=provider_subscription_id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify([row])
  });
}
