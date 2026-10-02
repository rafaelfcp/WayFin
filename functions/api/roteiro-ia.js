// Cloudflare Pages Function — POST /api/roteiro-ia
//
// Recebe as respostas do questionário, checa sessão + acesso à viagem + créditos
// do plano, chama o modelo e devolve SUGESTÕES (cidades → lugares). Quem monta
// os dias é o front-end (algoritmo determinístico de vizinho mais próximo), não o
// modelo: sai mais barato e evita "bairro do outro lado da cidade no mesmo dia".
//
// Variáveis de ambiente (Cloudflare Pages → Settings → Environment variables):
//   ANTHROPIC_API_KEY          → chave da API da Anthropic (console.anthropic.com)
//   IA_MODEL (opcional)        → padrão: claude-haiku-4-5-20251001
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY → as mesmas do checkout/webhook
//
// Contrato:
//   POST { viagem_id, destino, data_inicio, data_fim, transporte, orcamento,
//          viajantes, criancas, ritmo, interesses[], desejos, outras_cidades }
//   200  { sugestao: {resumo, dicas[], cidades[{nome,pais,dias,lugares[...]}]}, restantes }
//   402  { error:'sem_creditos' } · 401 sessão · 403 viagem · 400 entrada · 502 modelo

const MODEL_PADRAO = 'claude-haiku-4-5-20251001';
const CATEGORIAS = ['atração', 'restaurante', 'compras', 'outro'];
const CUSTOS = ['gratis', '$', '$$', '$$$'];

const TOOL = {
  name: 'sugerir_roteiro',
  description: 'Devolve sugestões de lugares para visitar, agrupadas por cidade, para o viajante escolher.',
  input_schema: {
    type: 'object',
    properties: {
      resumo: { type: 'string', description: 'Visão geral da viagem em 2 a 3 frases, em português do Brasil.' },
      dicas: { type: 'array', items: { type: 'string' }, description: 'Até 5 dicas práticas (transporte, dinheiro, reservas).' },
      cidades: {
        type: 'array',
        description: 'Cidades na ordem sugerida de visita. A primeira é o destino principal.',
        items: {
          type: 'object',
          properties: {
            nome: { type: 'string' },
            pais: { type: 'string' },
            dias: { type: 'integer', description: 'Dias sugeridos nesta cidade. A soma deve bater com a duração da viagem.' },
            lugares: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  nome: { type: 'string', description: 'Nome oficial do lugar, como aparece no mapa.' },
                  categoria: { type: 'string', enum: CATEGORIAS },
                  descricao: { type: 'string', description: 'Uma frase sobre o lugar.' },
                  duracao_min: { type: 'integer', description: 'Tempo médio de visita em minutos.' },
                  custo: { type: 'string', enum: CUSTOS },
                  motivo: { type: 'string', description: 'Por que combina com este viajante (curto).' }
                },
                required: ['nome', 'categoria', 'descricao', 'duracao_min', 'custo']
              }
            }
          },
          required: ['nome', 'pais', 'dias', 'lugares']
        }
      }
    },
    required: ['resumo', 'cidades']
  }
};

export async function onRequestPost({ request, env }) {
  try {
    if (!env.ANTHROPIC_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: 'ia_nao_configurada' }, 500);
    }
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'sem_sessao' }, 401);

    const asUser = { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` };
    const userResp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: asUser });
    if (!userResp.ok) return json({ error: 'sessao_invalida' }, 401);
    const user = await userResp.json();
    if (!user?.id) return json({ error: 'sessao_invalida' }, 401);

    let body = {};
    try { body = await request.json(); } catch {}
    const inp = sanitizarEntrada(body);
    if (inp.erro) return json({ error: inp.erro }, 400);

    // Acesso à viagem: consulta COM o token do usuário → a RLS decide.
    const vr = await fetch(`${env.SUPABASE_URL}/rest/v1/viagens?id=eq.${encodeURIComponent(inp.viagem_id)}&select=id`, { headers: asUser });
    const vrows = vr.ok ? await vr.json() : [];
    if (!vrows.length) return json({ error: 'viagem_sem_acesso' }, 403);

    // Créditos (função usa auth.uid() — só o próprio saldo).
    const cr = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/ia_creditos_restantes`, {
      method: 'POST', headers: { ...asUser, 'Content-Type': 'application/json' }, body: '{}'
    });
    const restantes = cr.ok ? Number(await cr.json()) : 0;
    if (!(restantes > 0)) return json({ error: 'sem_creditos', restantes: 0 }, 402);

    const modelo = env.IA_MODEL || MODEL_PADRAO;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: modelo,
        max_tokens: 4096,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{ role: 'user', content: montarPedido(inp) }]
      })
    });
    const data = await r.json().catch(() => ({}));
    const bloco = (data.content || []).find(b => b.type === 'tool_use');
    if (!r.ok || !bloco) {
      await log(env, { user_id: user.id, viagem_id: inp.viagem_id, entrada: inp, saida: data, status: 'erro', modelo });
      return json({ error: 'ia_falhou' }, 502);
    }
    const sugestao = sanitizarSaida(bloco.input);
    await log(env, {
      user_id: user.id, viagem_id: inp.viagem_id, entrada: inp, saida: sugestao, status: 'ok', modelo,
      tokens_in: data.usage?.input_tokens ?? null, tokens_out: data.usage?.output_tokens ?? null
    });
    return json({ sugestao, restantes: restantes - 1 });
  } catch (e) {
    console.error('roteiro_ia_erro', e);
    return json({ error: 'erro_interno' }, 500);
  }
}

// GET → só o saldo de créditos (o front mostra "Restam N gerações").
export async function onRequestGet({ request, env }) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !env.SUPABASE_URL) return json({ restantes: 0 });
  const cr = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/ia_creditos_restantes`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}'
  });
  return json({ restantes: cr.ok ? Number(await cr.json()) || 0 : 0 });
}

const SYSTEM = `Você é um planejador de viagens experiente. Sugira lugares REAIS e conhecidos, com o nome
exatamente como aparece no OpenStreetMap/Google Maps, para que possam ser localizados no mapa.
Nunca invente lugares. Prefira atrações consolidadas a modismos. Considere o meio de transporte
(sem carro: lugares próximos entre si e acessíveis por transporte público), o ritmo, o orçamento
e as crianças, se houver. Inclua obrigatoriamente os lugares que o viajante pediu, se existirem.
Por cidade, sugira de 6 a 10 lugares (mais do que cabe nos dias: o viajante vai escolher).
Inclua 1 ou 2 restaurantes típicos por cidade. Escreva em português do Brasil.`;

function montarPedido(i) {
  const dias = Math.round((Date.parse(i.data_fim) - Date.parse(i.data_inicio)) / 864e5) + 1;
  const transp = { carro: 'vai alugar carro', publico: 'só transporte público/a pé', ambos: 'carro em parte da viagem' }[i.transporte];
  return [
    `Destino principal: ${i.destino}`,
    `Período: ${i.data_inicio} a ${i.data_fim} (${dias} dias)`,
    `Outras cidades que quer incluir: ${i.outras_cidades || 'nenhuma — pode sugerir bate-voltas se fizer sentido'}`,
    `Transporte: ${transp}`,
    `Dinheiro disponível para a viagem: R$ ${i.orcamento.toLocaleString('pt-BR')} (${i.viajantes} pessoa(s))`,
    `Crianças: ${i.criancas ? 'sim' : 'não'}`,
    `Ritmo: ${i.ritmo}`,
    `Interesses: ${i.interesses.join(', ') || 'gerais'}`,
    `Lugares que quer conhecer: ${i.desejos || 'sem preferência'}`
  ].join('\n');
}

const txt = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const dataOk = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

function sanitizarEntrada(b) {
  const i = {
    viagem_id: txt(b.viagem_id, 40),
    destino: txt(b.destino, 80),
    data_inicio: txt(b.data_inicio, 10),
    data_fim: txt(b.data_fim, 10),
    transporte: ['carro', 'publico', 'ambos'].includes(b.transporte) ? b.transporte : 'publico',
    orcamento: Math.max(0, Math.min(Number(b.orcamento) || 0, 10_000_000)),
    viajantes: Math.max(1, Math.min(parseInt(b.viajantes) || 1, 20)),
    criancas: !!b.criancas,
    ritmo: ['tranquilo', 'moderado', 'intenso'].includes(b.ritmo) ? b.ritmo : 'moderado',
    interesses: (Array.isArray(b.interesses) ? b.interesses : []).slice(0, 10).map(x => txt(x, 30)).filter(Boolean),
    desejos: txt(b.desejos, 500),
    outras_cidades: txt(b.outras_cidades, 200)
  };
  if (!/^[0-9a-f-]{36}$/i.test(i.viagem_id)) return { erro: 'viagem_invalida' };
  if (i.destino.length < 2) return { erro: 'destino_obrigatorio' };
  if (!dataOk(i.data_inicio) || !dataOk(i.data_fim)) return { erro: 'datas_invalidas' };
  const dias = (Date.parse(i.data_fim) - Date.parse(i.data_inicio)) / 864e5 + 1;
  if (dias < 1 || dias > 30) return { erro: 'periodo_invalido' };
  return i;
}

// Nunca confia no formato do modelo: corta, normaliza enums e descarta lixo.
function sanitizarSaida(o) {
  const cidades = (Array.isArray(o?.cidades) ? o.cidades : []).slice(0, 5).map(c => ({
    nome: txt(c.nome, 60),
    pais: txt(c.pais, 40),
    dias: Math.max(1, Math.min(parseInt(c.dias) || 1, 30)),
    lugares: (Array.isArray(c.lugares) ? c.lugares : []).slice(0, 12).map(l => ({
      nome: txt(l.nome, 100),
      categoria: CATEGORIAS.includes(l.categoria) ? l.categoria : 'atração',
      descricao: txt(l.descricao, 240),
      duracao_min: Math.max(15, Math.min(parseInt(l.duracao_min) || 90, 600)),
      custo: CUSTOS.includes(l.custo) ? l.custo : '$',
      motivo: txt(l.motivo, 160)
    })).filter(l => l.nome)
  })).filter(c => c.nome && c.lugares.length);
  return {
    resumo: txt(o?.resumo, 600),
    dicas: (Array.isArray(o?.dicas) ? o.dicas : []).slice(0, 5).map(d => txt(d, 200)).filter(Boolean),
    cidades
  };
}

async function log(env, row) {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/roteiro_ia_geracoes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(row)
    });
  } catch (e) { console.error('roteiro_ia_log_erro', e); }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
