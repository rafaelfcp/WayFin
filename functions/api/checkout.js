// POST /api/checkout
//
// Cria a cobrança no Mercado Pago e devolve { url } pro front-end redirecionar
// (contrato que o index.html já espera). Duas rotas, conforme o plano:
//   - "trip_pass" (30 dias) e "annual" (12 meses) → Checkout Pro, PAGAMENTO ÚNICO (Pix + cartão)
//   - "monthly"                                    → Preapproval (assinatura recorrente, só cartão)
//
// O Anual é pagamento único de propósito: aceita Pix (0,99% vs ~5% no cartão) e elimina
// os problemas de recorrência (cartão vencido, falha de renovação). Renovação = nova compra,
// que o webhook empilha sobre o acesso que ainda resta.
//
// Variáveis de ambiente (Worker "wayfin" → Settings → Variables and Secrets):
//   MP_ACCESS_TOKEN   → Access Token do Mercado Pago (Credenciais de produção)  [secret]
//   SUPABASE_URL      → https://evvvzmnguhgqaopvquhs.supabase.co
//   SUPABASE_ANON_KEY → a mesma anon key que já está no index.html
//
// Os preços aqui são a fonte da verdade — o webhook também confere o valor pago contra eles.
// Mantenha em sincronia com PRICING no index.html.
export const PRICES = {
  monthly:   { title: 'Wayfin Premium — Mensal',            amount: 21.90,  recurring: { frequency: 1, frequency_type: 'months' } },
  annual:    { title: 'Wayfin Premium — Anual (12 meses)',  amount: 119.90, recurring: null },
  trip_pass: { title: 'Wayfin — Passe de Viagem (30 dias)', amount: 34.90,  recurring: null }
};

export async function onRequestPost({ request, env }) {
  try {
    if (!env.MP_ACCESS_TOKEN || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      return json({ error: 'checkout_nao_configurado' }, 500);
    }

    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'sem_sessao' }, 401);

    // Valida o usuário direto no Supabase Auth (sem SDK).
    const userResp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY }
    });
    if (!userResp.ok) return json({ error: 'sessao_invalida' }, 401);
    const user = await userResp.json();
    if (!user?.id || !user?.email) return json({ error: 'sessao_invalida' }, 401);

    let body = {};
    try { body = await request.json(); } catch {}
    const plan = body.plan;
    const price = PRICES[plan];
    if (!price) return json({ error: 'plano_invalido' }, 400);

    const origin = new URL(request.url).origin;
    // "userId:plan" — é o que o webhook usa pra saber quem pagou o quê.
    const externalRef = `${user.id}:${plan}`;
    // source_news=webhooks: só a notificação nova (assinada), sem o IPN legado duplicado.
    const notificationUrl = `${origin}/api/webhook/mercadopago?source_news=webhooks`;
    const mpHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
      // Mesmo clique duplicado gera a mesma cobrança (janela de ~1 min)
      'X-Idempotency-Key': `${externalRef}:${Math.floor(Date.now() / 60000)}`
    };

    if (price.recurring) {
      const r = await fetch('https://api.mercadopago.com/preapproval', {
        method: 'POST',
        headers: mpHeaders,
        body: JSON.stringify({
          reason: price.title,
          external_reference: externalRef,
          payer_email: user.email,
          back_url: `${origin}/?checkout=success`,
          notification_url: notificationUrl,
          auto_recurring: {
            frequency: price.recurring.frequency,
            frequency_type: price.recurring.frequency_type,
            transaction_amount: price.amount,
            currency_id: 'BRL'
          },
          status: 'pending'
        })
      });
      const data = await r.json();
      if (!r.ok || !data.init_point) {
        console.error('mp_preapproval_falhou', r.status, JSON.stringify(data));
        return json({ error: 'mp_preapproval_falhou' }, 502);
      }
      return json({ url: data.init_point });
    }

    const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: mpHeaders,
      body: JSON.stringify({
        items: [{ id: plan, title: price.title, quantity: 1, unit_price: price.amount, currency_id: 'BRL' }],
        external_reference: externalRef,
        payer: { email: user.email },
        notification_url: notificationUrl,
        statement_descriptor: 'WAYFIN',
        back_urls: {
          success: `${origin}/?checkout=success`,
          failure: `${origin}/?checkout=failure`,
          pending: `${origin}/?checkout=pending`
        },
        auto_return: 'approved'
      })
    });
    const data = await r.json();
    if (!r.ok || !data.init_point) {
      console.error('mp_preference_falhou', r.status, JSON.stringify(data));
      return json({ error: 'mp_preference_falhou' }, 502);
    }
    return json({ url: data.init_point });
  } catch (e) {
    console.error('checkout_erro', e);
    return json({ error: 'erro_interno' }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
