// ─────────────────────────────────────────────────────────────
// SerNatural — Cloudflare Worker v4
// Endpoints: /auth /me /users /products /gallery /config /reviews /image
// Variables de entorno requeridas:
//   GITHUB_TOKEN      — Personal Access Token de GitHub (scope: repo)
//   CLOUDINARY_CLOUD  — Cloud name (ditz4ufas)
//   CLOUDINARY_KEY    — API Key (842269388152256)
//   CLOUDINARY_SECRET — API Secret
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

const ALLOWED_ORIGINS = [
  'https://sernatural.pages.dev',
  'https://ser-natural-web.pages.dev',
];

// ── CORS ──────────────────────────────────────────────────────
function cors(origin) {
  const valid = ALLOWED_ORIGINS.some(o => origin && origin.startsWith(o))
    ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  valid,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Session-Token',
    'Access-Control-Max-Age':       '86400',
  };
}

function jsonRes(data, status = 200, corHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corHeaders },
  });
}

// ── TOKEN ─────────────────────────────────────────────────────
function makeToken(user, role) {
  return btoa(`${user}|${role}|${Date.now()}`);
}

function parseToken(token) {
  try {
    const [user, role, ts] = atob(token).split('|');
    if (Date.now() - parseInt(ts) > 8 * 60 * 60 * 1000) return null;
    return { user, role };
  } catch { return null; }
}

// ── GITHUB ────────────────────────────────────────────────────
async function ghRead(env, file) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${file}`,
    { headers: { Authorization: `token ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'SerNatural-Worker' } }
  );
  if (res.status === 404) return { data: null, sha: null };
  const raw = await res.json();
  return { data: JSON.parse(atob(raw.content.replace(/\n/g, ''))), sha: raw.sha };
}

async function ghWrite(env, file, content, sha, message) {
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2))));
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${file}`,
    {
      method: 'PUT',
      headers: { Authorization: `token ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'SerNatural-Worker' },
      body: JSON.stringify({ message, content: encoded, ...(sha ? { sha } : {}) }),
    }
  );
  if (!res.ok) { const e = await res.json(); throw new Error(e.message || 'Error GitHub'); }
  return (await res.json()).content.sha;
}

// ── CLOUDINARY DELETE ─────────────────────────────────────────
async function cloudinaryDelete(env, publicId) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const toSign    = `public_id=${publicId}&timestamp=${timestamp}${env.CLOUDINARY_SECRET}`;
  // SHA-1 via SubtleCrypto
  const msgBuf    = new TextEncoder().encode(toSign);
  const hashBuf   = await crypto.subtle.digest('SHA-1', msgBuf);
  const signature = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');
  const fd = new FormData();
  fd.append('public_id', publicId);
  fd.append('timestamp',  timestamp);
  fd.append('api_key',    env.CLOUDINARY_KEY);
  fd.append('signature',  signature);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/image/destroy`, { method: 'POST', body: fd });
  return res.ok ? await res.json() : null;
}

// Extract Cloudinary public_id from URL
function extractPublicId(url) {
  try {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.\w+)?$/);
    return match ? match[1] : null;
  } catch { return null; }
}

// ── MAIN ──────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const c      = cors(origin);
    const now    = new Date().toLocaleString('es-AR');

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });

    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    const getSession = () => {
      const t = request.headers.get('X-Session-Token');
      return t ? parseToken(t) : null;
    };
    const requireAuth = (role = null) => {
      const s = getSession();
      if (!s) return { err: jsonRes({ error: 'No autenticado' }, 401, c) };
      if (role && s.role !== role) return { err: jsonRes({ error: 'Sin permisos' }, 403, c) };
      return { session: s };
    };

    try {

      // ── POST /auth ────────────────────────────────────────
      if (method === 'POST' && path === '/auth') {
        const { user, pass } = await request.json();
        const { data: users } = await ghRead(env, FILES.users);
        const list  = users || [];
        const found = list.find(u => u.user === user && u.pass === pass);
        if (!found) return jsonRes({ error: 'Usuario o contraseña incorrectos' }, 401, c);
        return jsonRes({ ok: true, token: makeToken(found.user, found.role), role: found.role, user: found.user }, 200, c);
      }

      // ── GET /me ───────────────────────────────────────────
      if (method === 'GET' && path === '/me') {
        const s = getSession();
        if (!s) return jsonRes({ error: 'No autenticado' }, 401, c);
        return jsonRes({ ok: true, user: s.user, role: s.role }, 200, c);
      }

      // ── GET/PUT /users ────────────────────────────────────
      if (path === '/users') {
        const { err, session } = requireAuth('superadmin');
        if (err) return err;

        if (method === 'GET') {
          const { data, sha } = await ghRead(env, FILES.users);
          // Return without passwords to the client
          const safe = (data || []).map(u => ({ user: u.user, role: u.role }));
          return jsonRes({ users: safe, sha }, 200, c);
        }

        if (method === 'PUT') {
          // Body: { users: [...with passwords...], sha }
          const { users, sha } = await request.json();
          const newSha = await ghWrite(env, FILES.users, users, sha, `Usuarios actualizados — ${now}`);
          return jsonRes({ ok: true, sha: newSha }, 200, c);
        }
      }

      // ── GET/PUT /config ───────────────────────────────────
      if (path === '/config') {
        const { err } = requireAuth();
        if (err) return err;
        const defaultConfig = {
          categorias: [
            { id: 'jabones',   label: 'Jabones artesanales' },
            { id: 'cosmetica', label: 'Cosmética natural' },
            { id: 'bienestar', label: 'Bienestar' },
          ],
          etiquetas: [{ id: 'nuevo', label: 'Nuevo' }, { id: 'popular', label: 'Popular' }],
          camposExtra: [],
          logoUrl: '',
        };
        if (method === 'GET') {
          const { data, sha } = await ghRead(env, FILES.config);
          return jsonRes({ config: { ...defaultConfig, ...(data || {}) }, sha }, 200, c);
        }
        if (method === 'PUT') {
          const { err: e2 } = requireAuth('superadmin');
          if (e2) return e2;
          const { config, sha } = await request.json();
          const newSha = await ghWrite(env, FILES.config, config, sha, `Config actualizada — ${now}`);
          return jsonRes({ ok: true, sha: newSha }, 200, c);
        }
      }

      // ── GET/PUT /products ─────────────────────────────────
      if (path === '/products') {
        const { err } = requireAuth();
        if (err) return err;
        if (method === 'GET') {
          const { data, sha } = await ghRead(env, FILES.products);
          return jsonRes({ products: data || [], sha }, 200, c);
        }
        if (method === 'PUT') {
          const { products, sha } = await request.json();
          const newSha = await ghWrite(env, FILES.products, products, sha, `Catálogo actualizado — ${now}`);
          return jsonRes({ ok: true, sha: newSha }, 200, c);
        }
      }

      // ── GET/PUT /gallery ──────────────────────────────────
      if (path === '/gallery') {
        const { err } = requireAuth();
        if (err) return err;
        if (method === 'GET') {
          const { data, sha } = await ghRead(env, FILES.gallery);
          return jsonRes({ gallery: data || { inicio: [], proceso: [], final: [] }, sha }, 200, c);
        }
        if (method === 'PUT') {
          const { gallery, sha } = await request.json();
          const newSha = await ghWrite(env, FILES.gallery, gallery, sha, `Galería actualizada — ${now}`);
          return jsonRes({ ok: true, sha: newSha }, 200, c);
        }
      }

      // ── GET/PUT /reviews ──────────────────────────────────
      if (path === '/reviews') {
        const { err } = requireAuth();
        if (err) return err;
        if (method === 'GET') {
          const { data, sha } = await ghRead(env, FILES.reviews);
          return jsonRes({ reviews: data || { opiniones: [], clientes: [] }, sha }, 200, c);
        }
        if (method === 'PUT') {
          const { reviews, sha } = await request.json();
          const newSha = await ghWrite(env, FILES.reviews, reviews, sha, `Reviews actualizadas — ${now}`);
          return jsonRes({ ok: true, sha: newSha }, 200, c);
        }
      }

      // ── DELETE /image ─────────────────────────────────────
      if (method === 'DELETE' && path === '/image') {
        const { err } = requireAuth();
        if (err) return err;
        const { url: imgUrl } = await request.json();
        const publicId = extractPublicId(imgUrl);
        if (!publicId) return jsonRes({ error: 'URL inválida' }, 400, c);
        const result = await cloudinaryDelete(env, publicId);
        return jsonRes({ ok: true, result }, 200, c);
      }

      // ── PUBLIC ENDPOINTS (no auth, for index.html) ────────
      if (method === 'GET' && path === '/products/public') {
        const { data } = await ghRead(env, FILES.products);
        return jsonRes(data || [], 200, c);
      }
      if (method === 'GET' && path === '/gallery/public') {
        const { data } = await ghRead(env, FILES.gallery);
        return jsonRes(data || { inicio: [], proceso: [], final: [] }, 200, c);
      }
      if (method === 'GET' && path === '/config/public') {
        const { data } = await ghRead(env, FILES.config);
        return jsonRes(data || {}, 200, c);
      }
      if (method === 'GET' && path === '/reviews/public') {
        const { data } = await ghRead(env, FILES.reviews);
        return jsonRes(data || { opiniones: [], clientes: [] }, 200, c);
      }

      return new Response('Not found', { status: 404, headers: c });

    } catch(e) {
      return jsonRes({ error: e.message }, 500, c);
    }
  },
};
