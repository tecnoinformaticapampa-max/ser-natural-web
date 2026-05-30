// ─────────────────────────────────────────────────────────────
// SerNatural — Cloudflare Worker v4
// Variables de entorno requeridas:
//   GITHUB_TOKEN      — Personal Access Token GitHub
//   CLOUDINARY_CLOUD  — ditz4ufas
//   CLOUDINARY_KEY    — 842269388152256
//   CLOUDINARY_SECRET — API Secret de Cloudinary
// ─────────────────────────────────────────────────────────────

const GITHUB_USER = 'tecnoinformaticapampa-max';
const GITHUB_REPO = 'ser-natural-web';
const FILES = {
  products: 'products.json',
  gallery:  'gallery.json',
  config:   'config.json',
  reviews:  'reviews.json',
  users:    'users.json',
};

const ALLOWED = [
  'https://sernatural.pages.dev',
  'https://ser-natural-web.pages.dev',
];

const DEFAULT_CONFIG = {
  categorias: [
    { id:'jabones',   label:'Jabones artesanales' },
    { id:'cosmetica', label:'Cosmética natural' },
    { id:'bienestar', label:'Bienestar' },
  ],
  etiquetas:  [{ id:'nuevo', label:'Nuevo' }, { id:'popular', label:'Popular' }],
  camposExtra: [],
  logoUrl: '',
};

// ── CORS ──────────────────────────────────────────────────────
function cors(origin) {
  const ok = ALLOWED.some(o => origin && origin.startsWith(o)) ? origin : ALLOWED[0];
  return {
    'Access-Control-Allow-Origin':  ok,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Session-Token',
    'Access-Control-Max-Age':       '86400',
  };
}

function j(data, status=200, h={}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type':'application/json', ...h },
  });
}

// ── TOKEN ─────────────────────────────────────────────────────
function makeToken(user, role) {
  return btoa(`${user}|${role}|${Date.now()}`);
}
function parseToken(t) {
  try {
    const [user, role, ts] = atob(t).split('|');
    if (Date.now() - parseInt(ts) > 8*60*60*1000) return null;
    return { user, role };
  } catch { return null; }
}

// ── GITHUB ────────────────────────────────────────────────────
async function ghRead(env, file) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${file}`,
    { headers:{ Authorization:`token ${env.GITHUB_TOKEN}`, Accept:'application/vnd.github.v3+json', 'User-Agent':'SerNatural-Worker' } }
  );
  if (res.status === 404) return { data:null, sha:null };
  const raw = await res.json();
  return { data: JSON.parse(atob(raw.content.replace(/\n/g,''))), sha: raw.sha };
}

async function ghWrite(env, file, content, sha, msg) {
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2))));
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${file}`,
    {
      method: 'PUT',
      headers: { Authorization:`token ${env.GITHUB_TOKEN}`, Accept:'application/vnd.github.v3+json', 'Content-Type':'application/json', 'User-Agent':'SerNatural-Worker' },
      body: JSON.stringify({ message:msg, content:encoded, ...(sha?{sha}:{}) }),
    }
  );
  if (!res.ok) { const e=await res.json(); throw new Error(e.message||'Error GitHub'); }
  return (await res.json()).content.sha;
}

// ── CLOUDINARY DELETE ─────────────────────────────────────────
async function cloudinaryDelete(env, publicId) {
  const ts  = Math.floor(Date.now()/1000).toString();
  const str = `public_id=${publicId}&timestamp=${ts}${env.CLOUDINARY_SECRET}`;
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  const sig = Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
  const fd  = new FormData();
  fd.append('public_id', publicId);
  fd.append('timestamp',  ts);
  fd.append('api_key',    env.CLOUDINARY_KEY);
  fd.append('signature',  sig);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/image/destroy`, { method:'POST', body:fd });
  return res.ok ? await res.json() : null;
}

function extractPublicId(url) {
  try {
    const m = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.\w+)?$/);
    return m ? m[1] : null;
  } catch { return null; }
}

// ── MAIN ──────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const c      = cors(origin);
    const now    = new Date().toLocaleString('es-AR');

    if (request.method === 'OPTIONS') return new Response(null, { status:204, headers:c });

    const { pathname: path } = new URL(request.url);
    const method = request.method;

    const getSession = () => {
      const t = request.headers.get('X-Session-Token');
      return t ? parseToken(t) : null;
    };
    const auth = (role=null) => {
      const s = getSession();
      if (!s) return { fail: j({ error:'No autenticado' }, 401, c) };
      if (role && s.role !== role) return { fail: j({ error:'Sin permisos' }, 403, c) };
      return { session: s };
    };

    try {

      // ── POST /auth ──────────────────────────────────────────
      if (method==='POST' && path==='/auth') {
        const { user, pass } = await request.json();
        const { data } = await ghRead(env, FILES.users);
        const list = data || [];
        const found = list.find(u => u.user===user && u.pass===pass);
        if (!found) return j({ error:'Usuario o contraseña incorrectos' }, 401, c);
        return j({ ok:true, token:makeToken(found.user, found.role), role:found.role, user:found.user }, 200, c);
      }

      // ── GET /me ─────────────────────────────────────────────
      if (method==='GET' && path==='/me') {
        const s = getSession();
        if (!s) return j({ error:'No autenticado' }, 401, c);
        return j({ ok:true, user:s.user, role:s.role }, 200, c);
      }

      // ── PUBLIC — no auth needed ─────────────────────────────
      if (method==='GET' && path==='/products/public') {
        const { data } = await ghRead(env, FILES.products);
        return j(data || [], 200, { ...c, 'Cache-Control':'no-cache' });
      }
      if (method==='GET' && path==='/gallery/public') {
        const { data } = await ghRead(env, FILES.gallery);
        return j(data || { inicio:[], proceso:[], final:[] }, 200, { ...c, 'Cache-Control':'no-cache' });
      }
      if (method==='GET' && path==='/config/public') {
        const { data } = await ghRead(env, FILES.config);
        return j({ ...DEFAULT_CONFIG, ...(data||{}) }, 200, { ...c, 'Cache-Control':'no-cache' });
      }
      if (method==='GET' && path==='/reviews/public') {
        const { data } = await ghRead(env, FILES.reviews);
        return j(data || { opiniones:[], clientes:[] }, 200, { ...c, 'Cache-Control':'no-cache' });
      }

      // ── USERS — superadmin only ─────────────────────────────
      if (path==='/users') {
        const { fail } = auth('superadmin');
        if (fail) return fail;
        if (method==='GET') {
          const { data, sha } = await ghRead(env, FILES.users);
          const safe = (data||[]).map(u => ({ user:u.user, role:u.role }));
          return j({ users:safe, sha }, 200, c);
        }
        if (method==='PUT') {
          const { users, sha } = await request.json();
          const newSha = await ghWrite(env, FILES.users, users, sha, `Usuarios actualizados — ${now}`);
          return j({ ok:true, sha:newSha }, 200, c);
        }
      }

      // ── CONFIG — GET any auth, PUT superadmin ───────────────
      if (path==='/config') {
        const { fail } = auth();
        if (fail) return fail;
        if (method==='GET') {
          const { data, sha } = await ghRead(env, FILES.config);
          return j({ config:{ ...DEFAULT_CONFIG, ...(data||{}) }, sha }, 200, { ...c, 'Cache-Control':'no-cache' });
        }
        if (method==='PUT') {
          const { fail:f2 } = auth('superadmin');
          if (f2) return f2;
          const { config, sha } = await request.json();
          const newSha = await ghWrite(env, FILES.config, config, sha, `Config actualizada — ${now}`);
          return j({ ok:true, sha:newSha }, 200, c);
        }
      }

      // ── PRODUCTS ────────────────────────────────────────────
      if (path==='/products') {
        const { fail } = auth();
        if (fail) return fail;
        if (method==='GET') {
          const { data, sha } = await ghRead(env, FILES.products);
          return j({ products:data||[], sha }, 200, { ...c, 'Cache-Control':'no-cache' });
        }
        if (method==='PUT') {
          const { products, sha } = await request.json();
          const newSha = await ghWrite(env, FILES.products, products, sha, `Catálogo actualizado — ${now}`);
          return j({ ok:true, sha:newSha }, 200, c);
        }
      }

      // ── GALLERY ─────────────────────────────────────────────
      if (path==='/gallery') {
        const { fail } = auth();
        if (fail) return fail;
        if (method==='GET') {
          const { data, sha } = await ghRead(env, FILES.gallery);
          return j({ gallery:data||{ inicio:[], proceso:[], final:[] }, sha }, 200, { ...c, 'Cache-Control':'no-cache' });
        }
        if (method==='PUT') {
          const { gallery, sha } = await request.json();
          const newSha = await ghWrite(env, FILES.gallery, gallery, sha, `Galería actualizada — ${now}`);
          return j({ ok:true, sha:newSha }, 200, c);
        }
      }

      // ── REVIEWS ─────────────────────────────────────────────
      if (path==='/reviews') {
        const { fail } = auth();
        if (fail) return fail;
        if (method==='GET') {
          const { data, sha } = await ghRead(env, FILES.reviews);
          return j({ reviews:data||{ opiniones:[], clientes:[] }, sha }, 200, { ...c, 'Cache-Control':'no-cache' });
        }
        if (method==='PUT') {
          const { reviews, sha } = await request.json();
          const newSha = await ghWrite(env, FILES.reviews, reviews, sha, `Reviews actualizadas — ${now}`);
          return j({ ok:true, sha:newSha }, 200, c);
        }
      }

      // ── DELETE IMAGE ─────────────────────────────────────────
      if (method==='DELETE' && path==='/image') {
        const { fail } = auth();
        if (fail) return fail;
        const { url } = await request.json();
        const publicId = extractPublicId(url);
        if (!publicId) return j({ error:'URL inválida' }, 400, c);
        const result = await cloudinaryDelete(env, publicId);
        return j({ ok:true, result }, 200, c);
      }

      return new Response('Not found', { status:404, headers:c });

    } catch(e) {
      return j({ error:e.message }, 500, c);
    }
  },
};
