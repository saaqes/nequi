'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = String(process.env.ADMIN_KEY || '1090274993');
const DB_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/nequi';
const pool = new Pool({
  connectionString: DB_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false },
});

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const q = (text, params) => pool.query(text, params);

async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS people (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // código de un solo uso: la fila se borra para siempre cuando se usa
  await q(`CREATE TABLE IF NOT EXISTS codes (
    code CHAR(6) PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // la sesión guarda su propia copia de los datos: borrar a la persona NO la cierra
  await q(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    person_id INTEGER,
    name TEXT,
    phone TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

/* ---- límite de intentos fallidos por IP ---- */
const fails = new Map();
const WINDOW = 15 * 60 * 1000, MAX_FAILS = 10;
function blocked(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.t > WINDOW) { fails.delete(ip); return false; }
  return f.n >= MAX_FAILS;
}
function fail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.t > WINDOW) fails.set(ip, { n: 1, t: Date.now() });
  else f.n++;
}

function isAdminKey(s) {
  const a = Buffer.from(String(s)), b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function newSession(role, person) {
  const token = crypto.randomBytes(32).toString('hex');
  await q(
    'INSERT INTO sessions (token_hash, role, person_id, name, phone) VALUES ($1,$2,$3,$4,$5)',
    [sha(token), role, person ? person.id : null, person ? person.name : null, person ? person.phone : null]
  );
  return token;
}

async function newCode(personId) {
  await q('DELETE FROM codes WHERE person_id=$1', [personId]);
  for (let i = 0; i < 20; i++) {
    const code = String(crypto.randomInt(100000, 1000000));
    try {
      await q('INSERT INTO codes (code, person_id) VALUES ($1,$2)', [code, personId]);
      return code;
    } catch (e) {
      if (e.code !== '23505') throw e; // código repetido: probar otro
    }
  }
  throw new Error('No se pudo generar un código');
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));

app.get('/health', (req, res) => res.send('ok'));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: 'Error del servidor' });
});

async function auth(req) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(req.get('authorization') || '');
  if (!m) return null;
  const r = await q('SELECT role, name, phone, created_at FROM sessions WHERE token_hash=$1', [sha(m[1])]);
  const s = r.rows[0];
  if (!s) return null;
  if (s.role === 'admin' && Date.now() - new Date(s.created_at).getTime() > 30 * 864e5) return null;
  return s;
}
const needAdmin = (fn) => wrap(async (req, res) => {
  const s = await auth(req);
  if (!s || s.role !== 'admin') return res.status(401).json({ error: 'No autorizado' });
  return fn(req, res);
});

/* ---- entrar con un código (o la clave de admin) ---- */
app.post('/api/redeem', wrap(async (req, res) => {
  const ip = req.ip;
  if (blocked(ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  const code = String((req.body && req.body.code) || '').replace(/\D/g, '');
  if (isAdminKey(code)) {
    return res.json({ role: 'admin', token: await newSession('admin', null) });
  }
  if (!/^\d{6}$/.test(code)) { fail(ip); return res.status(400).json({ error: 'Escribe el código de 6 dígitos' }); }
  // borrado atómico: el código sirve una sola vez
  const used = await q('DELETE FROM codes WHERE code=$1 RETURNING person_id', [code]);
  if (!used.rows[0]) { fail(ip); return res.status(401).json({ error: 'Código incorrecto o ya usado' }); }
  const p = await q('SELECT id, name, phone FROM people WHERE id=$1', [used.rows[0].person_id]);
  const person = p.rows[0];
  if (!person) { fail(ip); return res.status(401).json({ error: 'Código incorrecto o ya usado' }); }
  const token = await newSession('user', person);
  res.json({ role: 'user', token, name: person.name, phone: person.phone });
}));

app.get('/api/me', wrap(async (req, res) => {
  const s = await auth(req);
  if (!s) return res.status(401).json({ error: 'Sesión no válida' });
  res.json({ role: s.role, name: s.name, phone: s.phone });
}));

app.post('/api/logout', wrap(async (req, res) => {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(req.get('authorization') || '');
  if (m) await q('DELETE FROM sessions WHERE token_hash=$1', [sha(m[1])]);
  res.json({ ok: true });
}));

/* ---- admin: personas ---- */
async function listPeople() {
  const r = await q(`SELECT p.id, p.name, p.phone, c.code,
      (SELECT count(*) FROM sessions s WHERE s.role='user' AND s.person_id=p.id)::int AS devices
    FROM people p LEFT JOIN codes c ON c.person_id=p.id ORDER BY p.created_at DESC`);
  return r.rows;
}
app.get('/api/admin/people', needAdmin(async (req, res) => res.json(await listPeople())));

app.post('/api/admin/people', needAdmin(async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
  if (!name) return res.status(400).json({ error: 'Escribe el nombre' });
  if (phone.length !== 10) return res.status(400).json({ error: 'El celular debe tener 10 dígitos' });
  let person;
  try {
    person = (await q('INSERT INTO people (name, phone) VALUES ($1,$2) RETURNING id, name, phone', [name, phone])).rows[0];
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ese celular ya está en la lista (usa «Nuevo código»)' });
    throw e;
  }
  person.code = await newCode(person.id);
  person.devices = 0;
  res.json(person);
}));

app.post('/api/admin/people/:id/code', needAdmin(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await q('SELECT id FROM people WHERE id=$1', [id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'No existe' });
  res.json({ code: await newCode(id) });
}));

// borrar de la lista: no cierra las sesiones que ya están activas
app.delete('/api/admin/people/:id', needAdmin(async (req, res) => {
  await q('DELETE FROM people WHERE id=$1', [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

/* ---- archivos de la app ---- */
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) {
    if (/\.(html|webmanifest)$|sw\.js$/.test(file)) res.set('Cache-Control', 'no-cache');
  },
}));

initDb().then(() => {
  app.listen(PORT, () => console.log('Nequi escuchando en el puerto ' + PORT));
}).catch((e) => { console.error('No se pudo iniciar la base de datos', e); process.exit(1); });
