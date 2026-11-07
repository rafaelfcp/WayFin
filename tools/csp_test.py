# Testa a CSP do _headers em modo de BLOQUEIO no Chromium (Playwright).
# Uso: pip install playwright && playwright install chromium && python tools/csp_test.py
# Esperado: só o controle negativo (evil.example.com) aparece como violação.
import asyncio, http.server, threading, functools, json, re
from playwright.async_api import async_playwright
import os,sys
ROOT=os.path.abspath(sys.argv[1] if len(sys.argv)>1 else os.path.join(os.path.dirname(__file__),'..'))
h=open(ROOT+'/_headers').read()
CSP=re.search(r'Content-Security-Policy(?:-Report-Only)?: (.*)',h).group(1).strip()
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a):pass
    def end_headers(self):
        self.send_header('Content-Security-Policy',CSP)   # modo BLOQUEIO
        super().end_headers()
srv=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Q,directory=ROOT))
threading.Thread(target=srv.serve_forever,daemon=True).start()
INIT="""window.__v=[];document.addEventListener('securitypolicyviolation',e=>window.__v.push(e.effectiveDirective+' <- '+(e.blockedURI||'inline')+(e.sourceFile?(' @'+e.sourceFile.split('/').pop()+':'+e.lineNumber):'')));"""
PROBE="""async()=>{
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const img=u=>{const i=new Image();i.src=u;};
 const tryFetch=u=>fetch(u,{mode:'no-cors'}).catch(()=>{});
 // imagens usadas pelo app
 img('https://a.tile.openstreetmap.org/7/62/48.png');img('https://c.tile.openstreetmap.org/7/62/48.png');
 img('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/7/48/62');
 img('https://upload.wikimedia.org/wikipedia/commons/x.jpg');img('https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png');
 // chamadas de dados
 tryFetch('https://nominatim.openstreetmap.org/search?q=lisboa&format=json');tryFetch('https://overpass-api.de/api/interpreter');
 tryFetch('https://overpass.kumi.systems/api/interpreter');tryFetch('https://pt.wikipedia.org/api/rest_v1/page/summary/Lisboa');
 tryFetch('https://evvvzmnguhgqaopvquhs.supabase.co/rest/v1/');tryFetch('/api/checkout');
 // o que o service worker busca para o cache
 ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.js','https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2','https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js','https://fonts.googleapis.com/css2?family=Inter','https://fonts.gstatic.com/s/x.woff2'].forEach(tryFetch);
 // script do QR code
 const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';document.head.appendChild(s);
 // controle negativo: precisa ser BLOQUEADO
 img('https://evil.example.com/x.png');
 await wait(1500);
 return window.__v;}"""
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch()
    pg=await b.new_page(); await pg.add_init_script(INIT)
    await pg.route('**/*supabase-js*',lambda r:r.fulfill(body='window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),onAuthStateChange:()=>({})},from:()=>({select:()=>({order:async()=>({data:[]})})})})}',content_type='application/javascript'))
    await pg.goto(f'http://127.0.0.1:{srv.server_address[1]}/',wait_until='load'); await pg.wait_for_timeout(1500)
    carga=await pg.evaluate('window.__v.slice()')
    # abre as telas do app (sem login) para exercitar estilos/handlers inline
    await pg.evaluate("()=>{document.body.classList.remove('show-landing','auth-required');document.getElementById('auth-screen').style.display='none';document.querySelectorAll('.tab').forEach(t=>t.click());openPaywall('geral');}")
    await pg.wait_for_timeout(800)
    telas=await pg.evaluate('window.__v.slice()')
    probe=await pg.evaluate(PROBE)
    print('CSP:',CSP[:90],'...')
    print('violações ao carregar:',json.dumps(carga,ensure_ascii=False))
    print('violações ao abrir telas:',json.dumps([x for x in telas if x not in carga],ensure_ascii=False))
    print('violações nos testes:',json.dumps(sorted(set(probe)-set(telas)),ensure_ascii=False,indent=1))
    await b.close()
asyncio.run(main())
