// ก้าวรวมใจ — เซิร์ฟเวอร์ Node.js ไม่มี dependency ภายนอก
// ให้บริการไฟล์เว็บ (clean URLs: /, /app, /credits) · /api/health · /api/sessions (ตรวจ HMAC-SHA256) · /api/hobby (ส่งเฉพาะแท็ก PDPA ม.26)
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySession } from '../web/js/core/sign.js';
import { CATEGORIES, getHobbyOptions } from '../web/js/core/hobby.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '../web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const CLEAN_HTML = {
  '/': 'index.html',
  '/index': 'index.html',
  '/app': 'app.html',
  '/credits': 'credits.html',
};

const DEMO_KEYS = {
  'clip-001': 'demo-key-clip-001',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

async function readJsonBody(req, limitBytes = 65536) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/** กรองอินพุต /api/hobby ให้เหลือเฉพาะแท็กความปลอดภัยเท่านั้น (ป้องกันข้อมูลสุขภาพส่วนบุคคลหลุดตาม PDPA ม.26) */
function sanitizeHobbyTags(raw = {}) {
  const allowedCats = Object.keys(CATEGORIES);
  const allowed = Array.isArray(raw.allowed)
    ? raw.allowed.filter((c) => allowedCats.includes(c))
    : allowedCats;
  const safeTags = Array.isArray(raw.tags)
    ? raw.tags.filter((t) => typeof t === 'string' && /^[a-z_]+$/.test(t)).slice(0, 12)
    : [];
  const liked = Array.isArray(raw.liked)
    ? raw.liked.filter((c) => allowed.includes(c)).slice(0, 3)
    : [];
  const recentTitles = Array.isArray(raw.recentTitles)
    ? raw.recentTitles.filter((x) => typeof x === 'string' && x.length <= 50).slice(0, 12)
    : [];
  const movementMax = Number.isInteger(raw.movementMax) ? Math.max(0, Math.min(3, raw.movementMax)) : 1;
  const maxMinutes = Number.isInteger(raw.maxMinutes) ? Math.max(5, Math.min(30, raw.maxMinutes)) : 20;
  return { tags: safeTags, movementMax, maxMinutes, allowed: allowed.length ? allowed : ['mind', 'music', 'reading'], liked, recentTitles };
}

function makeGeminiCaller(apiKey) {
  if (!apiKey) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  return async ({ prompt, schema }) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.7 },
      }),
    });
    if (!res.ok) throw new Error(`gemini_${res.status}`);
    const j = await res.json();
    const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return JSON.parse(txt);
  };
}

export function createHandler({ geminiApiKey = process.env.GEMINI_API_KEY || '' } = {}) {
  // เก็บประวัติเซสชันต่ออุปกรณ์ในหน่วยความจำ (ป้องกันการส่งซ้ำ/เวลาทับซ้อนในต้นแบบ)
  const devices = new Map();
  const getDev = (id) => {
    if (!devices.has(id)) devices.set(id, { lastSeq: -1, sessions: [] });
    return devices.get(id);
  };
  const callAI = makeGeminiCaller(geminiApiKey);

  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const rawUrl = String(req.url || '/');
      if (rawUrl.includes('..') || rawUrl.toLowerCase().includes('%2e%2e')) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Forbidden');
      }
      const pathname = decodeURIComponent(url.pathname);

      // ---------- API Routes ----------
      if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, app: 'kaoruamjai', version: '3.1.0', gemini: Boolean(callAI) });
      }

      if (pathname === '/api/sessions' && req.method === 'GET') {
        const deviceId = (url.searchParams.get('deviceId') || 'clip-001').slice(0, 40);
        const dev = getDev(deviceId);
        return sendJson(res, 200, {
          deviceId,
          lastSeq: dev.lastSeq,
          count: dev.sessions.length,
          sessions: dev.sessions.slice(-20),
        });
      }

      if (pathname === '/api/sessions' && req.method === 'POST') {
        let body;
        try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { ok: false, reasons: ['ข้อมูล JSON ไม่ถูกต้อง'] }); }
        const deviceId = String(body?.deviceId || '');
        const key = DEMO_KEYS[deviceId] || (deviceId.startsWith('clip-') ? `demo-key-${deviceId}` : null);
        if (!key) return sendJson(res, 400, { ok: false, reasons: ['ไม่รู้จักอุปกรณ์นี้'] });
        const dev = getDev(deviceId);
        const v = await verifySession(body, key, dev);
        if (!v.ok) return sendJson(res, 400, { ok: false, reasons: v.reasons, stepsPerMin: Math.round(v.stepsPerMin) });
        dev.lastSeq = body.seq;
        dev.sessions.push({ seq: body.seq, startedAt: body.startedAt, durationSec: body.durationSec, steps: body.steps, verdict: body.verdict });
        if (dev.sessions.length > 200) dev.sessions = dev.sessions.slice(-200);
        return sendJson(res, 200, { ok: true, stateless: false, stepsPerMin: Math.round(v.stepsPerMin), count: dev.sessions.length });
      }

      if (pathname === '/api/hobby' && req.method === 'POST') {
        let body;
        try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'invalid_json' }); }
        const safeTags = sanitizeHobbyTags(body);
        const out = await getHobbyOptions(safeTags, callAI);
        return sendJson(res, 200, { options: out.options, source: out.options.some((o) => o.source === 'ai') ? 'ai' : 'fallback' });
      }

      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'not_found' });
      }

      // ---------- Static Files & Clean URLs ----------
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }

      const rel = CLEAN_HTML[pathname] || pathname.replace(/^\/+/, '');
      const fullPath = path.resolve(WEB_DIR, rel);
      if (!fullPath.startsWith(WEB_DIR + path.sep) && fullPath !== WEB_DIR) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Forbidden');
      }

      let data;
      let servedPath = fullPath;
      let status = 200;
      try {
        const st = await fs.stat(fullPath);
        if (st.isDirectory()) servedPath = path.join(fullPath, 'index.html');
        data = await fs.readFile(servedPath);
      } catch {
        status = 404;
        servedPath = path.join(WEB_DIR, '404.html');
        data = await fs.readFile(servedPath).catch(() => Buffer.from('404 Not Found'));
      }

      const ext = path.extname(servedPath).toLowerCase();
      res.writeHead(status, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      if (req.method === 'HEAD') res.end();
      else res.end(data);
    } catch (err) {
      sendJson(res, 500, { error: 'internal_error', message: String(err?.message || err) });
    }
  };
}

export function createAppServer(opts = {}) {
  return http.createServer(createHandler(opts));
}

// รันเป็นเซิร์ฟเวอร์จริงเมื่อเปิดไฟล์นี้โดยตรง
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const server = createAppServer();
  server.listen(port, host, () => {
    console.log(`ก้าวรวมใจ v3.1 พร้อมใช้งานที่ http://${host}:${port}/`);
    console.log(`  หน้าแรก:   http://${host}:${port}/`);
    console.log(`  ตัวแอป:    http://${host}:${port}/app#/step`);
    console.log(`  เครดิต:    http://${host}:${port}/credits`);
  });
}
