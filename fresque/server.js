const express = require('express');
const { Pool } = require('pg');

const SIZE = 32;
const COOLDOWN_MS = 10_000;
const PALETTE = [
  '#ffffff', '#e4e4e4', '#888888', '#222222', '#ffa7d1', '#e50000', '#e59500', '#a06a42',
  '#e5d900', '#94e044', '#02be01', '#00d3dd', '#0083c7', '#0000ea', '#cf6ee4', '#820080',
];

const connectionString = process.env.DATABASE_URL || process.env.POSTGRESQL_ADDON_URI;
const pool = new Pool({ connectionString, max: 4 });

const lastPlace = new Map(); // ip -> timestamp

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pixels (
      x SMALLINT NOT NULL,
      y SMALLINT NOT NULL,
      color SMALLINT NOT NULL,
      author TEXT,
      placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (x, y)
    )`);
}

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2kb' }));
app.use(express.static(__dirname + '/public'));

app.get('/api/config', (_req, res) => res.json({ size: SIZE, cooldownMs: COOLDOWN_MS, palette: PALETTE }));

app.get('/api/pixels', async (_req, res) => {
  const { rows } = await pool.query('SELECT x, y, color FROM pixels');
  const { rows: [stats] } = await pool.query(
    `SELECT count(*)::int AS painted, max(placed_at) AS last FROM pixels`);
  res.json({ pixels: rows, stats });
});

app.post('/api/pixels', async (req, res) => {
  const x = Number(req.body.x), y = Number(req.body.y), color = Number(req.body.color);
  const author = String(req.body.author || '').trim().slice(0, 24) || null;
  if (![x, y].every(v => Number.isInteger(v) && v >= 0 && v < SIZE) ||
      !Number.isInteger(color) || color < 0 || color >= PALETTE.length) {
    return res.status(400).json({ error: 'pixel invalide' });
  }
  const ip = req.ip, now = Date.now();
  const wait = (lastPlace.get(ip) || 0) + COOLDOWN_MS - now;
  if (wait > 0) return res.status(429).json({ error: 'cooldown', waitMs: wait });
  lastPlace.set(ip, now);

  await pool.query(
    `INSERT INTO pixels (x, y, color, author) VALUES ($1, $2, $3, $4)
     ON CONFLICT (x, y) DO UPDATE SET color = EXCLUDED.color, author = EXCLUDED.author, placed_at = now()`,
    [x, y, color, author]);
  res.json({ ok: true, cooldownMs: COOLDOWN_MS });
});

app.get('/api/pixels/:x/:y', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT x, y, color, author, placed_at FROM pixels WHERE x = $1 AND y = $2',
    [Number(req.params.x), Number(req.params.y)]);
  res.json(rows[0] || null);
});

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'erreur serveur' }); });

const port = process.env.PORT || 8080;
init()
  .then(() => app.listen(port, '0.0.0.0', () => console.log(`Fresque sur :${port}`)))
  .catch(err => { console.error('DB init failed', err); process.exit(1); });
