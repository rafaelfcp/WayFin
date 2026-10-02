// Cloudflare Pages Function — POST /api/checkout
//
// Cria a cobrança no Mercado Pago e devolve { url } pro front-end redirecionar
// (é exatamente o contrato que o index.html já espera). Duas rotas dentro do
// mesmo endpoint, dependendo do plano escolhido:
//   - "trip_pass" (30 dias, sem renovação) → Checkout Pro (pagamento único)
//   - "monthly" / "annual" (recorrente)    → Preapproval (assinatura)
//
// Variáveis de ambiente esperadas (Cloudflare Pages → Settings → Environment
// variables, em Production E Preview):
//   MP_ACCESS_TOKEN          → Access Token do Mercado Pago (Credenciais de produção)
//   SUPABASE_URL             → https://evvvzmnguhgqaopvquhs.supabase.co
//   SUPABASE_ANON_KEY        → a mesma anon key que já está no index.html
//
// Os preços aqui são a fonte da verdade pro valor cobrado — nunca confie no
// valor vindo do front-end. Mantenha isto em sincronia com PRICING no index.html.
const PRICES = {
  monthly:   { title: 'Wayfin Premium — Mensal', amount: 9.90,  recurring: { frequency: 1, frequency_type: 'months' } },
  annual:    { title: 'Wayfin Premium — Anual',  amount: 69.90, recurring: { frequency: 1, frequency_type: 'years' } },
  trip_pass: { title: 'Wayfin — Passe de Viagem (30 dias)', amount: 19.90, recurring: null }
};

export async function onRequestPost({ request, env }) {
  try {
    if (!env.MP_ACCESS_TOKEN || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      return json({ error: 'checkout_nao_configurado' }, 500);
    }

    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'sem_sessao' }, 401);

    // Valida o usuário direto no Supabase Auth (sem precisar de SDK aqui).
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

    if (price.recurring) {
      const r = await fetch('https://api.mercadopago.com/preapproval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` },
        body: JSON.stringify({
          reason: price.title,
          external_reference: externalRef,
          payer_email: user.email,
          back_url: `${origin}/?checkout=success`,
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
      if (!r.ok || !data.init_point) return json({ error: 'mp_preapproval_falhou', detail: data }, 502);
      return json({ url: data.init_point });
    }

    const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` },
      body: JSON.stringify({
        items: [{ title: price.title, quantity: 1, unit_price: price.amount, currency_id: 'BRL' }],
        external_reference: externalRef,
        payer: { email: user.email },
        back_urls: {
          success: `${origin}/?checkout=success`,
          failure: `${origin}/?checkout=failure`,
          pending: `${origin}/?checkout=pending`
        },
        auto_return: 'approved'
      })
    });
    const data = await r.json();
    if (!r.ok || !data.init_point) return json({ error: 'mp_preference_falhou', detail: data }, 502);
    return json({ url: data.init_point });
  } catch (e) {
    return json({ error: 'erro_interno', detail: String(e && e.message || e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
