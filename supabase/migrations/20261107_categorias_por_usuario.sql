-- WayFin · Categorias personalizadas por usuário (07/11/2026)
-- Antes: a tabela era global; "personalizar" mudava as categorias de todo mundo.
-- Agora:
--   categorias.user_id NULL  → categoria padrão (todos veem; só admin altera)
--   categorias.user_id = X   → categoria personalizada do assinante X
--   categorias_prefs         → ativo/ordem de cada pessoa, inclusive para as padrão

alter table public.categorias
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
create index if not exists categorias_user_id_idx on public.categorias(user_id);

create table if not exists public.categorias_prefs (
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  categoria_id  text not null references public.categorias(id) on delete cascade,
  ativo         boolean,
  ordem         integer,
  atualizado_em timestamptz not null default now(),
  primary key (user_id, categoria_id)
);
alter table public.categorias_prefs enable row level security;
revoke all on public.categorias_prefs from anon;
grant select, insert, update, delete on public.categorias_prefs to authenticated;

drop policy if exists categorias_prefs_select on public.categorias_prefs;
drop policy if exists categorias_prefs_write  on public.categorias_prefs;
create policy categorias_prefs_select on public.categorias_prefs for select to authenticated
  using (user_id = auth.uid());
create policy categorias_prefs_write on public.categorias_prefs for all to authenticated
  using (user_id = auth.uid() and public.is_premium(auth.uid()))
  with check (user_id = auth.uid() and public.is_premium(auth.uid()));

-- quem pode ver: padrão, as suas e as do dono de uma viagem que você acessa como convidado.
-- (A viagem de exemplo usa só as padrão; liberar as do dono dela exporia categorias pessoais a todos.)
drop policy if exists categorias_select       on public.categorias;
drop policy if exists categorias_admin_write  on public.categorias;
drop policy if exists categorias_own_insert   on public.categorias;
drop policy if exists categorias_own_modify   on public.categorias;
drop policy if exists categorias_own_delete   on public.categorias;
create policy categorias_select on public.categorias for select to anon, authenticated
  using (
    user_id is null
    or user_id = auth.uid()
    or exists (select 1 from public.viagens v
               where v.owner_id = categorias.user_id and public.owns_trip(v.id))
  );
-- assinante cria e altera só as próprias
create policy categorias_own_insert on public.categorias for insert to authenticated
  with check (user_id = auth.uid() and public.is_premium(auth.uid()));
create policy categorias_own_modify on public.categorias for update to authenticated
  using ((user_id = auth.uid() and public.is_premium(auth.uid())) or (user_id is null and public.is_admin()))
  with check ((user_id = auth.uid() and public.is_premium(auth.uid())) or (user_id is null and public.is_admin()));
create policy categorias_own_delete on public.categorias for delete to authenticated
  using ((user_id = auth.uid() and public.is_premium(auth.uid())) or (user_id is null and public.is_admin()));
-- admin cria categorias padrão
drop policy if exists categorias_admin_insert on public.categorias;
create policy categorias_admin_insert on public.categorias for insert to authenticated
  with check (user_id is null and public.is_admin());
