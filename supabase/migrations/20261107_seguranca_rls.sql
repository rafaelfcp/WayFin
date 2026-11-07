-- Wayfin · Segurança no banco (07/11/2026)
-- A) Storage: remove o acesso anônimo total ao bucket documentos-viagem.
-- B) categorias: leitura para todos, escrita só para admin (a tabela é global, sem dono por linha).
-- C) Trava de assinatura também em UPDATE/DELETE (antes só INSERT era bloqueado).

-- ── A) Storage ─────────────────────────────────────
drop policy if exists "Acesso total via anon - storage documentos" on storage.objects;

-- dono da viagem do caminho "<viagem_id>/arquivo.pdf" tem assinatura ativa?
create or replace function public.document_path_trip(p_path text)
returns uuid language plpgsql immutable as $$
begin
  return split_part(p_path, '/', 1)::uuid;
exception when invalid_text_representation then
  return null;
end $$;

create or replace function public.trip_owner_premium(p_trip_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select public.is_premium(v.owner_id) from public.viagens v where v.id = p_trip_id), false);
$$;

-- upload só para quem pode editar a viagem E a viagem é de um assinante
drop policy if exists tripcash_document_insert on storage.objects;
create policy tripcash_document_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documentos-viagem'
              and public.owns_document_path(name)
              and public.trip_owner_premium(public.document_path_trip(name)));

-- documentos da viagem de exemplo podem ser abertos (só leitura)
drop policy if exists tripcash_document_select_demo on storage.objects;
create policy tripcash_document_select_demo on storage.objects for select to authenticated
  using (bucket_id = 'documentos-viagem'
         and public.is_demo_trip(public.document_path_trip(name)));

-- ── B) categorias ──────────────────────────────────
drop policy if exists "anon full access" on public.categorias;
drop policy if exists categorias_select on public.categorias;
drop policy if exists categorias_admin_write on public.categorias;
create policy categorias_select on public.categorias for select to anon, authenticated using (true);
create policy categorias_admin_write on public.categorias for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
revoke insert, update, delete, truncate on public.categorias from anon;

-- ── C) Trava de assinatura em INSERT/UPDATE/DELETE ──
create or replace function public.enforce_free_limits()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_row    jsonb;
  v_viagem uuid;
  v_owner  uuid;
begin
  -- service_role (webhook) e acesso direto ao banco (painel/SQL) não passam pela trava.
  -- auth.role() continua 'authenticated' dentro de funções security definer chamadas pelo app.
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return coalesce(new, old);
  end if;

  -- linhas apagadas em cascata: a decisão já foi tomada na linha-pai
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;

  -- o dono pode sempre apagar a própria viagem inteira (direito de excluir os dados)
  if tg_op = 'DELETE' and tg_table_name = 'viagens' then
    return old;
  end if;

  if tg_op = 'DELETE' then v_row := to_jsonb(old); else v_row := to_jsonb(new); end if;

  if tg_table_name = 'viagens' then
    v_owner := (v_row ->> 'owner_id')::uuid;
    if tg_op = 'UPDATE' then v_owner := old.owner_id; end if;
  else
    if tg_table_name = 'roteiro_paradas' then
      select d.viagem_id into v_viagem from public.roteiro_dias d where d.id = (v_row ->> 'dia_id')::uuid;
    else
      v_viagem := (v_row ->> 'viagem_id')::uuid;
    end if;
    select v.owner_id into v_owner from public.viagens v where v.id = v_viagem;
  end if;

  if v_owner is null or public.is_premium(v_owner) then
    return coalesce(new, old);
  end if;

  raise exception 'limite_plano_free:%',
    case tg_table_name
      when 'viagens'         then 'viagens'
      when 'gastos'          then 'gastos'
      when 'reservas'        then 'reservas'
      when 'documentos'      then 'anexos'
      when 'roteiro_dias'    then 'roteiro'
      when 'roteiro_paradas' then 'roteiro'
      when 'mala_itens'      then 'mala'
      when 'viagem_membros'  then 'compartilhar'
      else tg_table_name
    end
    using errcode = 'P0001';
end $$;

do $$
declare t text;
begin
  foreach t in array array['viagens','gastos','reservas','documentos','roteiro_dias','roteiro_paradas','mala_itens','viagem_membros']
  loop
    execute format('drop trigger if exists trg_plano_upd_del on public.%I', t);
    execute format('create trigger trg_plano_upd_del before update or delete on public.%I
                    for each row execute function public.enforce_free_limits()', t);
  end loop;
end $$;
