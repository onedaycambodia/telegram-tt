'use strict';
/**
 * telegram-tt + background transfer server.   Start command:   node server/index.js
 *
 * - serves ../dist (the web app, exactly like before)
 * - runs All Media Transfer jobs on the server, so they keep going when the phone leaves Safari
 * - every Telegram account is linked ONCE from inside telegram-tt (QR link, no typing): the logged-in
 *   browser accepts the server's QR token itself, and the server gets its OWN session for that account.
 *
 * Railway variables:   API_ID, API_HASH (my.telegram.org)   TRANSFER_TOKEN (any password you choose)
 * Optional:            DATA_DIR  (mount a Railway Volume there, e.g. /data, so linked accounts survive deploys)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const transfer = require('./transfer');

const PORT = Number(process.env.PORT) || 3000;
const DIST = path.join(__dirname, '..', 'dist');
const TOKEN = process.env.TRANSFER_TOKEN || '';
const API_ID = Number(process.env.API_ID || process.env.TELEGRAM_API_ID || 0);
const API_HASH = process.env.API_HASH || process.env.TELEGRAM_API_HASH || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const errText = (e) => String((e && (e.errorMessage || e.message)) || e);

/* ------------------------------------------------------------------ linked accounts */

let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch (e) { sessions = {}; }
if (process.env.TRANSFER_SESSIONS) {
  try { sessions = { ...JSON.parse(process.env.TRANSFER_SESSIONS), ...sessions }; } catch (e) { /* ignore bad json */ }
}

function saveSessions() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions), { mode: 0o600 });
  } catch (e) {
    console.error('Could not save sessions (read-only disk?) - mount a Volume and set DATA_DIR:', errText(e));
  }
}

const clients = new Map(); // accountId -> connected TelegramClient
const connecting = new Map();

async function getClient(accountId) {
  const id = String(accountId);
  const existing = clients.get(id);
  if (existing && existing.connected) return existing;
  if (connecting.has(id)) return connecting.get(id);
  if (!sessions[id]) throw new Error('This account is not linked to the server yet');
  if (!API_ID || !API_HASH) throw new Error('API_ID / API_HASH are not set on the server');
  const promise = (async () => {
    const c = new TelegramClient(new StringSession(sessions[id]), API_ID, API_HASH, { connectionRetries: 10 });
    await c.connect();
    clients.set(id, c);
    return c;
  })();
  connecting.set(id, promise);
  try { return await promise; } finally { connecting.delete(id); }
}

/** Called the moment a job finds this account's session dead (terminated/logged out elsewhere).
 * Drops the stored session and the cached client, so the next /transfer/ping reports linked:false
 * and the already-logged-in browser can relink the account with a fresh QR token automatically. */
function forgetSession(accountId) {
  const id = String(accountId);
  if (!sessions[id]) return;
  delete sessions[id];
  saveSessions();
  const c = clients.get(id);
  clients.delete(id);
  if (c) { try { c.disconnect(); } catch (e) { /* already gone */ } }
}

const engine = transfer.createEngine(getClient, forgetSession);

/* ------------------------------------------------------------------ QR link (one per account) */

const qrStates = new Map();

async function qrStart(accountId) {
  if (!API_ID || !API_HASH) throw new Error('Set API_ID and API_HASH on Railway first');
  const previous = qrStates.get(accountId);
  if (previous && previous.client) { try { await previous.client.disconnect(); } catch (e) { /* ignore */ } }

  const st = { status: 'waiting', token: '', error: '', resolvePassword: undefined, client: undefined };
  qrStates.set(accountId, st);
  setTimeout(() => { if (qrStates.get(accountId) === st) qrStates.delete(accountId); }, 15 * 60 * 1000);

  const c = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 5 });
  await c.connect();
  st.client = c;

  c.signInUserWithQrCode({ apiId: API_ID, apiHash: API_HASH }, {
    qrCode: async (qr) => { st.token = Buffer.from(qr.token).toString('base64'); },
    password: async () => {
      st.status = 'password';
      return new Promise((resolve) => { st.resolvePassword = resolve; });
    },
    onError: async (e) => { st.status = 'error'; st.error = errText(e); return true; },
  }).then(async () => {
    const me = await c.getMe();
    if (String(me.id) !== String(accountId)) {
      st.status = 'error';
      st.error = 'The linked account does not match this browser account';
      try { await c.disconnect(); } catch (e) { /* ignore */ }
      return;
    }
    sessions[String(me.id)] = c.session.save();
    saveSessions();
    clients.set(String(me.id), c);
    st.status = 'done';
  }).catch((e) => {
    if (st.status !== 'error') { st.status = 'error'; st.error = errText(e); }
  });
}

/* ------------------------------------------------------------------ helpers */

const json = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 30 * 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!TOKEN) return false;
  const a = crypto.createHash('sha256').update(String(req.headers['x-transfer-token'] || '')).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ API */

async function handleApi(req, res, url) {
  if (!TOKEN) return json(res, 503, { error: 'TRANSFER_TOKEN is not set on the server' });
  if (!authorized(req)) return json(res, 401, { error: 'Wrong or missing transfer password' });

  const p = url.pathname;
  const accountParam = String(url.searchParams.get('accountId') || '');

  if (req.method === 'GET' && p === '/transfer/ping') {
    return json(res, 200, { ok: true, linked: Boolean(sessions[accountParam]), hasApi: Boolean(API_ID && API_HASH) });
  }

  if (req.method === 'POST' && p === '/transfer/login/qr/start') {
    const body = await readBody(req);
    await qrStart(String(body.accountId));
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && p === '/transfer/login/qr/state') {
    const st = qrStates.get(accountParam);
    if (!st) return json(res, 200, { status: 'none' });
    return json(res, 200, { status: st.status, token: st.token, error: st.error });
  }

  if (req.method === 'POST' && p === '/transfer/login/qr/password') {
    const body = await readBody(req);
    const st = qrStates.get(String(body.accountId));
    if (!st || !st.resolvePassword) return json(res, 400, { error: 'No password requested' });
    st.status = 'waiting';
    st.resolvePassword(String(body.password || ''));
    st.resolvePassword = undefined;
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && p === '/transfer/jobs') {
    return json(res, 200, transfer.listJobs().filter((j) => !accountParam || j.meta.accountId === accountParam));
  }

  if (req.method === 'GET' && p.startsWith('/transfer/status/')) {
    const job = transfer.getJob(p.slice('/transfer/status/'.length));
    if (!job) return json(res, 404, { error: 'Job not found' });
    return json(res, 200, transfer.snapshot(job, Number(url.searchParams.get('since')) || 0));
  }

  if (req.method === 'POST' && p.startsWith('/transfer/cancel/')) {
    const job = transfer.getJob(p.slice('/transfer/cancel/'.length));
    if (job) job.cancel = true;
    return json(res, 200, { ok: Boolean(job) });
  }

  if (req.method === 'POST' && p === '/transfer/start') {
    const body = await readBody(req);
    if (!body.accountId || !body.fromChat || !body.toChat) return json(res, 400, { error: 'Missing account or chats' });
    if (!sessions[String(body.accountId)]) return json(res, 400, { error: 'This account is not linked to the server yet' });
    try {
      await getClient(body.accountId);
    } catch (e) {
      // The very first connect after a deploy/restart is where a terminated session usually surfaces,
      // before any job exists - forget it here too so /transfer/ping stops reporting linked:true.
      if (transfer.isSessionDead(e)) forgetSession(body.accountId);
      return json(res, 400, { error: errText(e) });
    }
    const running = transfer.listJobs().find((j) => j.meta.accountId === String(body.accountId)
      && (j.status === 'preparing' || j.status === 'running'));
    if (running) return json(res, 409, { error: 'A transfer is already running for this account', id: running.id });
    return json(res, 200, { id: engine.start(body) });
  }

  return json(res, 404, { error: 'Not found' });
}

/* ------------------------------------------------------------------ static files (dist) */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.tgs': 'application/json', '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json', '.bin': 'application/octet-stream', '.strings': 'text/plain; charset=utf-8',
};

function serveFile(res, file, noCache) {
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Service-Worker-Allowed': '/',
    'Cache-Control': noCache || /service|sw\.|version\.txt/i.test(path.basename(file))
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
  };
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (!err && st.isFile()) { serveFile(res, file, path.basename(file) === 'index.html'); return; }
    serveFile(res, path.join(DIST, 'index.html'), true);
  });
}

/* ------------------------------------------------------------------ server */

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/transfer/')) { await handleApi(req, res, url); return; }
    handleStatic(req, res, url);
  } catch (err) {
    console.error('request error:', err);
    if (!res.headersSent) json(res, 500, { error: errText(err) });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`telegram-tt + transfer server on :${PORT}`));

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
