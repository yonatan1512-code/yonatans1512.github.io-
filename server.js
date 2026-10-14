// Local web server for CourtMaster AI.
//   node server.js          start on http://localhost:3000
//   node server.js --open   start and open the browser
//   set PORT=4000 && node server.js   use another port
//
// The AI coach (optional): an adult sets an Anthropic API key in the environment before starting, e.g.
//   set ANTHROPIC_API_KEY=sk-ant-...  (Windows cmd)   or   $env:ANTHROPIC_API_KEY="sk-ant-..."  (PowerShell)
// The key stays here on the server and is never sent to the browser. Without a key the site works,
// and the coach page says it is not connected.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const URL_BASE = `http://localhost:${PORT}`;
const ORIGINS = new Set([URL_BASE, `http://127.0.0.1:${PORT}`]);
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const MODEL = 'claude-opus-5-5';
// automatic backup of the player's data (the browser keeps the main copy); this folder is never served
const DATA_DIR = process.env.CM_DATA_DIR || path.join(ROOT, 'data');
const BACKUP = path.join(DATA_DIR, 'backup.json');
const DAILY_KEEP = 14;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
// Only these folders and files are served; server.js, package files and node_modules stay private.
const PUBLIC = ['index.html', 'css', 'js', 'images', 'legacy'];

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

/* ---------- the Anthropic SDK, loaded only when needed ---------- */
let Anthropic = null;
let client = null;
async function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (Anthropic === null) {
    try { Anthropic = (await import('@anthropic-ai/sdk')).default; }
    catch (e) { Anthropic = false; console.error('The @anthropic-ai/sdk package is missing. Run: npm install'); }
  }
  if (!Anthropic) return null;
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  return client;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// checks the chat the page sends: plain user/assistant text turns, starting and ending with the player
function validChat(body) {
  if (!body || typeof body.system !== 'string' || body.system.length > 60000) return null;
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  if (!msgs.length || msgs.length > 30) return null;
  const out = [];
  for (const m of msgs) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 12000) return null;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content; // merge two turns from the same side
    else out.push({ role: m.role, content: m.content });
  }
  if (out[0].role !== 'user' || out[out.length - 1].role !== 'user') return null;
  return { system: body.system, messages: out };
}

async function coach(req, res) {
  const origin = req.headers.origin;
  if (origin && !ORIGINS.has(origin)) return sendJson(res, 403, { error: 'forbidden' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendJson(res, 415, { error: 'invalid_request' });
  const api = await getClient();
  if (!api) return sendJson(res, 503, { error: 'no_key' });

  let chat;
  try { chat = validChat(JSON.parse(await readBody(req, 400000))); } catch (e) { chat = null; }
  if (!chat) return sendJson(res, 400, { error: 'invalid_request' });

  // one JSON object per line: {t} pieces of text, then {done} or {error}
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  const line = obj => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };

  let stream = null;
  let closed = false;
  res.on('close', () => { closed = true; if (stream && !res.writableFinished) stream.abort(); });
  try {
    stream = api.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      // if a safety classifier declines a harmless question, the API retries it on a recommended fallback model
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: chat.system,
      messages: chat.messages,
    });
    stream.on('text', delta => line({ t: delta }));
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') line({ error: 'refused' });
    else line({ done: true, truncated: msg.stop_reason === 'max_tokens' });
  } catch (err) {
    if (closed) return;
    let code = 'upstream_error';
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) code = 'auth';
    else if (err instanceof Anthropic.RateLimitError) code = 'rate_limited';
    else if (err instanceof Anthropic.BadRequestError) code = 'invalid_request';
    if (err instanceof Anthropic.APIError) console.error(`Claude API error ${err.status}: ${err.message}`);
    else console.error('Coach error:', err && err.message);
    line({ error: code });
  }
  res.end();
}

/* ---------- the backup file ---------- */
async function backup(req, res) {
  if (req.method === 'GET') {
    fs.readFile(BACKUP, 'utf8', (err, text) => {
      if (err) return sendJson(res, 404, { error: 'none' });
      send(res, 200, text, 'application/json; charset=utf-8');
    });
    return;
  }
  if (req.method !== 'PUT') return send(res, 405, 'Method not allowed');
  const origin = req.headers.origin;
  if (origin && !ORIGINS.has(origin)) return sendJson(res, 403, { error: 'forbidden' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendJson(res, 415, { error: 'invalid_request' });
  let text, body;
  try { text = await readBody(req, 5 * 1024 * 1024); body = JSON.parse(text); } catch (e) { return sendJson(res, 400, { error: 'invalid_request' }); }
  if (!body || typeof body !== 'object' || !body.data || typeof body.data !== 'object') return sendJson(res, 400, { error: 'invalid_request' });
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // write to a temporary file first, so a crash never leaves half a backup
    const tmp = BACKUP + '.tmp';
    fs.writeFileSync(tmp, text);
    if (fs.existsSync(BACKUP)) fs.copyFileSync(BACKUP, path.join(DATA_DIR, 'backup-previous.json'));
    fs.renameSync(tmp, BACKUP);
    // one copy per day, the last two weeks
    const day = path.join(DATA_DIR, 'backup-' + new Date().toISOString().slice(0, 10) + '.json');
    fs.copyFileSync(BACKUP, day);
    fs.readdirSync(DATA_DIR).filter(n => /^backup-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().slice(0, -DAILY_KEEP)
      .forEach(n => fs.unlinkSync(path.join(DATA_DIR, n)));
    sendJson(res, 200, { ok: true });
  } catch (e) {
    console.error('Backup failed:', e.message);
    sendJson(res, 500, { error: 'write_failed' });
  }
}

const server = http.createServer(async (req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, URL_BASE).pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }

  // the API answers only pages opened from this computer's own address
  if (urlPath.startsWith('/api/') && !HOSTS.has(String(req.headers.host || ''))) return sendJson(res, 403, { error: 'forbidden' });
  if (urlPath === '/api/backup') return backup(req, res).catch(e => { console.error(e); if (!res.headersSent) sendJson(res, 500, { error: 'write_failed' }); });
  if (urlPath === '/api/health') {
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    return sendJson(res, 200, { ai: !!(await getClient()) });
  }
  if (urlPath === '/api/coach') {
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
    return coach(req, res).catch(e => { console.error(e); if (!res.headersSent) sendJson(res, 500, { error: 'upstream_error' }); else res.end(); });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  const rel = path.relative(ROOT, file);
  const top = rel.split(path.sep)[0];
  if (rel.startsWith('..') || path.isAbsolute(rel) || !PUBLIC.includes(top)) return send(res, 404, 'Not found');

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    if (req.method === 'HEAD') return send(res, 200, '', type);
    send(res, 200, data, type);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. The site may already be running at ${URL_BASE}`);
    console.error('To use another port: set PORT=4000 && node server.js');
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`CourtMaster AI running at ${URL_BASE}`);
  console.log(process.env.ANTHROPIC_API_KEY ? 'AI coach: API key found (kept on the server only).' : 'AI coach: not connected (no ANTHROPIC_API_KEY). Everything else works.');
  console.log('Press Ctrl+C to stop.');
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? `start "" "${URL_BASE}"`
      : process.platform === 'darwin' ? `open "${URL_BASE}"`
      : `xdg-open "${URL_BASE}"`;
    exec(cmd);
  }
});
