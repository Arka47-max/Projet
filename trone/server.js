const express = require('express');
const { Pool } = require('pg');

const COOLDOWN_MS = 15_000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || process.env.POSTGRESQL_ADDON_URI, max: 4 });
const lastPost = new Map(); // ip -> timestamp

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reigns (
      id SERIAL PRIMARY KEY,
      message TEXT NOT NULL,
      author TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ,
      ended_by TEXT
    )`);
  // Au plus un roi en place à la fois
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS one_king ON reigns ((true)) WHERE ended_at IS NULL`);
}

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2kb' }));
app.use(express.static(__dirname + '/public'));

const SECS = `EXTRACT(EPOCH FROM (coalesce(ended_at, now()) - started_at))::int`;

app.get('/api/state', async (_req, res) => {
  const [king, top, recent, count] = await Promise.all([
    pool.query(`SELECT id, message, author, started_at, ${SECS} AS secs FROM reigns WHERE ended_at IS NULL`),
    pool.query(`SELECT id, message, author, ${SECS} AS secs, ended_at IS NULL AS current
                FROM reigns ORDER BY secs DESC LIMIT 10`),
    pool.query(`SELECT id, message, author, ended_by, ${SECS} AS secs
                FROM reigns WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 8`),
    pool.query(`SELECT count(*)::int AS n FROM reigns`),
  ]);
  res.json({ king: king.rows[0] || null, top: top.rows, recent: recent.rows, total: count.rows[0].n, cooldownMs: COOLDOWN_MS });
});

app.post('/api/throne', async (req, res) => {
  const message = String(req.body.message || '').trim().slice(0, 140);
  const author = String(req.body.author || '').trim().slice(0, 24) || 'Anonyme';
  if (!message) return res.status(400).json({ error: 'Un roi sans proclamation ? Écris quelque chose.' });

  const ip = req.ip, now = Date.now();
  const wait = (lastPost.get(ip) || 0) + COOLDOWN_MS - now;
  if (wait > 0) return res.status(429).json({ error: `Calme-toi, usurpateur. Encore ${Math.ceil(wait / 1000)} s.`, waitMs: wait });
  lastPost.set(ip, now);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [old] } = await client.query(
      `UPDATE reigns SET ended_at = now(), ended_by = $1 WHERE ended_at IS NULL
       RETURNING author, ${SECS} AS secs`, [author]);
    const { rows: [king] } = await client.query(
      'INSERT INTO reigns (message, author) VALUES ($1, $2) RETURNING id, message, author, started_at',
      [message, author]);
    await client.query('COMMIT');
    res.json({ king, dethroned: old || null });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return res.status(409).json({ error: 'Quelqu’un a pris le trône en même temps que toi. Réessaie !' });
    throw e;
  } finally {
    client.release();
  }
});

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'erreur serveur' }); });

const port = process.env.PORT || 8080;
init()
  .then(() => app.listen(port, '0.0.0.0', () => console.log(`Trône sur :${port}`)))
  .catch(err => { console.error('DB init failed', err); process.exit(1); });
