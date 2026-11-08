-- 20261108_pagamentos_mp.sql
-- Ledger de pagamentos do Mercado Pago + função idempotente que aplica o direito de acesso.
--
-- Por que mudar a lógica do JS para o banco:
--   * Idempotência garantida por constraint (PK em pagamentos_mp, UNIQUE em subscriptions.provider_subscription_id),
--     não por "if" em código. Webhook reenviado = no-op.
--   * O cálculo do vencimento acontece UMA vez, no primeiro processamento, a partir de date_approved
--     (antes: now()+30 a cada reentrega, o que estendia o acesso de graça).
--   * Serialização por usuário (advisory lock) evita corrida entre dois webhooks simultâneos.
--   * Estorno/chargeback revoga o acesso daquele pagamento.
--
-- Chave do direito de acesso: subscriptions.provider_subscription_id = 'mp_payment_<id do pagamento>'.
-- Vale para os 3 planos (inclusive cada renovação do Mensal), então estorno é tratado de forma uniforme.

-- ── 1) Ledger de pagamentos (auditoria/conciliação) ─────────────────────────────
create table if not exists public.pagamentos_mp (
  mp_payment_id   text primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  plan            text not null check (plan in ('monthly','annual','trip_pass')),
  status          text not null,                 -- approved, pending, rejected, refunded, charged_back, cancelled...
  status_detail   text,
  valor           numeric(10,2) not null,
  metodo          text,                          -- pix, credit_card, debit_card, account_money...
  preapproval_id  text,                          -- preenchido nas cobranças do Mensal
  aprovado_em     timestamptz,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);
create index if not exists pagamentos_mp_user_idx on public.pagamentos_mp (user_id, criado_em desc);

alter table public.pagamentos_mp enable row level security;
-- Sem policies de propósito: cliente (anon/authenticated) não lê nem grava.
-- Só service_role (bypassa RLS) e a função security definer abaixo.

-- ── 2) Função idempotente chamada pelo webhook ──────────────────────────────────
create or replace function public.mp_registrar_pagamento(
  p_payment_id     text,
  p_user           uuid,
  p_plan           text,
  p_status         text,
  p_status_detail  text,
  p_valor          numeric,
  p_metodo         text,
  p_preapproval_id text,
  p_aprovado_em    timestamptz
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref     text := 'mp_payment_' || p_payment_id;
  v_aprov   timestamptz := coalesce(p_aprovado_em, now());
  v_inicio  timestamptz;
  v_fim     timestamptz;
begin
  if p_plan not in ('monthly','annual','trip_pass') then
    raise exception 'plano_invalido:%', p_plan;
  end if;

  -- Ledger: sempre reflete o último status visto no MP
  insert into pagamentos_mp (mp_payment_id, user_id, plan, status, status_detail, valor, metodo, preapproval_id, aprovado_em)
  values (p_payment_id, p_user, p_plan, p_status, p_status_detail, p_valor, p_metodo, p_preapproval_id, p_aprovado_em)
  on conflict (mp_payment_id) do update
     set status        = excluded.status,
         status_detail = excluded.status_detail,
         aprovado_em   = coalesce(pagamentos_mp.aprovado_em, excluded.aprovado_em),
         atualizado_em = now();

  -- Estorno / chargeback / cancelamento: revoga o acesso deste pagamento
  if p_status in ('refunded', 'charged_back', 'cancelled') then
    update subscriptions
       set status = 'canceled', updated_at = now()
     where provider_subscription_id = v_ref
       and status <> 'canceled';
    return case when found then 'revogado' else 'nada_a_revogar' end;
  end if;

  if p_status <> 'approved' then
    return 'ignorado_' || p_status;            -- pending/in_process/rejected: não libera nada
  end if;

  -- Serializa por usuário: dois webhooks simultâneos não calculam o início em cima do mesmo "max"
  perform pg_advisory_xact_lock(hashtextextended('mp_entitlement:' || p_user::text, 0));

  if exists (select 1 from subscriptions where provider_subscription_id = v_ref) then
    return 'ja_aplicado';                      -- reentrega do webhook: no-op, vencimento NÃO muda
  end if;

  if p_plan = 'monthly' then
    -- Renovação recorrente: período ancorado na data da cobrança, +3 dias de tolerância
    -- para o MP retentar um cartão recusado sem cortar o acesso.
    v_inicio := v_aprov;
    v_fim    := v_inicio + interval '1 month' + interval '3 days';
  else
    -- Pagamento único (Anual / Passe): empilha sobre o acesso que o usuário já tem,
    -- para quem compra antes de vencer não perder dias.
    select greatest(v_aprov, coalesce(max(s.current_period_end), v_aprov))
      into v_inicio
      from subscriptions s
     where s.user_id = p_user
       and s.status in ('active', 'trialing')
       and s.current_period_end is not null;   -- linhas 'manual' (vitalícias) não entram na conta

    v_fim := v_inicio + case p_plan when 'annual' then interval '1 year' else interval '30 days' end;
  end if;

  insert into subscriptions (user_id, plan, status, provider, provider_subscription_id, current_period_end)
  values (p_user, p_plan, 'active', 'mercadopago', v_ref, v_fim);

  return 'aplicado';
end;
$$;

revoke all on function public.mp_registrar_pagamento(text, uuid, text, text, text, numeric, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.mp_registrar_pagamento(text, uuid, text, text, text, numeric, text, text, timestamptz) to service_role;

-- ── 3) Validação (rode depois de aplicar) ───────────────────────────────────────
-- select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.pagamentos_mp'::regclass;
-- select relrowsecurity from pg_class where oid = 'public.pagamentos_mp'::regclass;          -- esperado: true
-- select grantee, privilege_type from information_schema.routine_privileges
--  where routine_name = 'mp_registrar_pagamento';                                             -- esperado: só service_role (+ postgres)
