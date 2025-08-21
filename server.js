// server.js (Lottery – per product, multi-run safe)
// Scopes entries to the latest lottery run per productId using createdAt barriers.

const express  = require('express');
const cors     = require('cors');
const sqlite3  = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const dns = require('dns').promises;
require('dotenv').config();

const app  = express();
const port = process.env.PORT || 3005;

app.use(express.json());
app.use(cors());

// ---------- Email transporter ----------
const mailer = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT || 587),
  secure: String(process.env.EMAIL_PORT) === '465',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// ---------- SQLite DB ----------
const dbPath = process.env.DB_PATH || 'lottery.db';
const db = new sqlite3.Database(dbPath);
console.log('DB path in use:', dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId INTEGER,
      name TEXT,
      startPrice REAL,
      increment REAL,
      endAt TEXT,
      createdAt TEXT DEFAULT (datetime('now'))    -- identifies the "run"
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId INTEGER,
      email TEXT,
      createdAt TEXT DEFAULT (datetime('now'))    -- used to scope into the active run
    )
  `);

  // In-place migrations if DB existed before
  db.run(`PRAGMA busy_timeout=3000`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_unique ON entries (productId, email, createdAt)`);

  // winners table (optional; keeps last winners)
  db.run(`
    CREATE TABLE IF NOT EXISTS winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId INTEGER,
      email TEXT,
      drawnAt TEXT DEFAULT (datetime('now'))
    )
  `);
});

// ---------- Helpers ----------
const BLOCKED_EMAIL_DOMAINS = (process.env.BLOCKED_EMAIL_DOMAINS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function isValidEmailFormat(email) {
  const re = /^[^\s@]+@[^\s@]+\.[A-Za-z0-9-]{2,}$/;
  return re.test(email);
}

async function withTimeout(promise, ms = 2000) {
  return await Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('DNS timeout')), ms))
  ]);
}

async function isDeliverableEmail(email) {
  const domain = String(email).split('@')[1]?.toLowerCase();
  if (!domain) return false;
  if (BLOCKED_EMAIL_DOMAINS.includes(domain)) return false;
  try {
    const mx = await withTimeout(dns.resolveMx(domain));
    if (Array.isArray(mx) && mx.length > 0) return true;
  } catch {}
  try {
    const a = await withTimeout(dns.resolve(domain));
    if (Array.isArray(a) && a.length > 0) return true;
  } catch {}
  return false;
}

function getActiveRun(productId, cb) {
  // Latest run by createdAt for this productId
  db.get(
    `SELECT * FROM products
     WHERE productId = ?
     ORDER BY datetime(createdAt) DESC
     LIMIT 1`,
    [productId],
    cb
  );
}

function entriesForRunWhere(run) {
  // Only entries added since this run started; stop at endAt if present
  let where = `productId = ? AND datetime(createdAt) >= datetime(?)`;
  const params = [run.productId, run.createdAt];
  if (run.endAt) {
    where += ` AND datetime(createdAt) <= datetime(?)`;
    params.push(run.endAt);
  }
  return { where, params };
}

function saveWinner(productId, email) {
  return new Promise((resolve) => {
    db.run(
      `INSERT INTO winners (productId, email, drawnAt) VALUES (?, ?, datetime('now'))`,
      [productId, email],
      () => resolve()
    );
  });
}

// ---------- CREATE a product lottery run ----------
app.post('/lottery/create', (req, res) => {
  let { productId, name, startPrice, increment, endAt } = req.body;

  if (productId == null || name == null || endAt == null || String(name).trim() === '') {
    return res.status(400).json({ success: false, message: 'Missing fields' });
  }

  if (startPrice == null || startPrice === '') startPrice = 0;
  if (increment == null || increment === '') increment = 0;

  db.run(
    `INSERT INTO products (productId, name, startPrice, increment, endAt, createdAt)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [productId, name, Number(startPrice), Number(increment), endAt],
    function (err) {
      if (err) {
        console.error('Create lottery insert error:', err);
        return res.status(500).json({ success: false, message: 'Server error' });
      }
      res.json({ success: true, productId });
    }
  );
});

// ---------- ENTER a lottery (scoped to active run) ----------
app.post('/lottery/enter', async (req, res) => {
  try {
    let { email, productId } = req.body;
    if (!email || !productId) {
      return res.status(400).json({ success: false, message: 'Missing email or productId' });
    }

    email = String(email).trim().toLowerCase();
    if (!isValidEmailFormat(email)) return res.status(400).json({ success: false, message: 'Invalid email format' });
    const deliverable = await isDeliverableEmail(email);
    if (!deliverable) return res.status(400).json({ success: false, message: 'Please enter a real email address' });

    // Optional Shopify eligibility (same as before)
    const shop  = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ADMIN_API_KEY;
    if (!shop || !token) {
      return res.status(503).json({ success: false, message: 'Eligibility check unavailable. Please try again later.' });
    }

    const shopifyUrl =
      `https://${shop}/admin/api/2025-01/orders.json?email=${encodeURIComponent(email)}&status=any&limit=1`;

    const resp = await fetch(shopifyUrl, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    if (!resp.ok) {
      console.error('Shopify API error', resp.status, await resp.text());
      return res.status(503).json({ success: false, message: 'Eligibility check unavailable. Please try again later.' });
    }
    const data = await resp.json();
    const hasOrder = Array.isArray(data.orders) && data.orders.length > 0;
    if (!hasOrder) {
      return res.status(200).json({ success: false, message: 'Only customers with a past order can enter this lottery.' });
    }

    // Find the active run for this productId
    getActiveRun(productId, (err, run) => {
      if (err || !run) return res.status(404).json({ success: false, message: 'No lottery run found.' });

      db.run(
        `INSERT INTO entries (productId, email, createdAt) VALUES (?, ?, datetime('now'))`,
        [productId, email],
        function (e) {
          if (e) {
            if (String(e).toLowerCase().includes('unique')) {
              // same productId+email+createdAt uniqueness can still collide only on same ms; ignore
              return res.status(200).json({ success: true, message: 'You are already entered for this product.' });
            }
            console.error('DB insert error', e);
            return res.status(500).json({ success: false, message: 'Server error' });
          }
          res.json({ success: true, message: 'You have been entered into the lottery!' });
        }
      );
    });

  } catch (e) {
    console.error('Enter handler error', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------- DRAW a winner (scoped to the latest run) ----------
app.post('/lottery/draw/:productId', (req, res) => {
  const productId = req.params.productId;

  getActiveRun(productId, (err, run) => {
    if (err || !run) return res.status(404).json({ success: false, message: 'No lottery run found.' });

    const { where, params } = entriesForRunWhere(run);

    db.all(`SELECT * FROM entries WHERE ${where}`, params, (e1, rows) => {
      if (e1) return res.status(500).json({ success: false, message: 'Server error' });
      if (!rows || rows.length === 0) return res.status(400).json({ success: false, message: 'No entries for this product yet.' });

      const winner = rows[Math.floor(Math.random() * rows.length)];
      const title = run?.name || `Product ${productId}`;

      const claimPrefix = process.env.CLAIM_URL_PREFIX || '';
      const claimLink = claimPrefix ? `${claimPrefix}${productId}&email=${encodeURIComponent(winner.email)}` : null;

      const html = `
        <div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
          <h2>🎉 Congratulations!</h2>
          <p>You’ve won the lottery for <strong>${title}</strong>.</p>
          ${claimLink
            ? `<p>Click below to claim your prize:</p>
               <p><a href="${claimLink}" style="padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Claim your prize</a></p>
               <p style="font-size:13px;color:#666">If the button doesn’t work, copy this link:<br>${claimLink}</p>`
            : `<p>Please reply to this email to claim your prize.</p>`
          }
        </div>
      `;

      (async () => {
        try {
          await saveWinner(productId, winner.email);
          await mailer.sendMail({
            from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
            to: winner.email,
            subject: `You won: ${title}!`,
            html
          });
          res.json({ success: true, message: `Winner drawn and emailed for product ${productId}`, winner: { email: winner.email } });
        } catch (errMail) {
          console.error('Email error:', errMail);
          await saveWinner(productId, winner.email);
          res.status(200).json({ success: true, message: 'Winner drawn. Email could not be sent.', emailed: false, winner: { email: winner.email } });
        }
      })();
    });
  });
});

// --- ADMIN: list latest run per productId with entry counts scoped to that run ---
app.get('/admin/lotteries', (req, res) => {
  const pass = req.query.pass;
  if (pass !== process.env.ADMIN_PASS) return res.status(403).json({ ok: false, message: 'Forbidden' });

  const sql = `
    WITH latest AS (
      SELECT productId, MAX(datetime(createdAt)) AS startedAt
      FROM products
      GROUP BY productId
    )
    SELECT p.productId, p.name, p.endAt, p.createdAt,
           COUNT(e.id) AS entries
    FROM products p
    JOIN latest L ON L.productId = p.productId AND datetime(p.createdAt) = datetime(L.startedAt)
    LEFT JOIN entries e
      ON e.productId = p.productId
     AND datetime(e.createdAt) >= datetime(p.createdAt)
     AND (p.endAt IS NULL OR datetime(e.createdAt) <= datetime(p.endAt))
    GROUP BY p.productId
    ORDER BY
      CASE WHEN p.endAt IS NULL OR p.endAt = '' THEN 1 ELSE 0 END,
      p.endAt
  `;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('SQL error /admin/lotteries:', err);
      return res.status(500).json({ ok: false, message: 'DB error' });
    }
    res.json({ ok: true, lotteries: rows });
  });
});

// --- PUBLIC: list current active lotteries (latest run per product) ---
app.get('/lottery/current', (_req, res) => {
  const sql = `
    WITH latest AS (
      SELECT productId, MAX(datetime(createdAt)) AS startedAt
      FROM products
      GROUP BY productId
    )
    SELECT p.productId, p.name, p.endAt, p.createdAt
    FROM products p
    JOIN latest L ON L.productId = p.productId AND datetime(p.createdAt) = datetime(L.startedAt)
    WHERE p.endAt IS NULL OR datetime(p.endAt) > datetime('now')
    ORDER BY 
      CASE WHEN p.endAt IS NULL OR p.endAt = '' THEN 1 ELSE 0 END,
      p.endAt
    LIMIT 10
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ ok: false, message: 'DB error' });
    res.json({ ok: true, lotteries: rows });
  });
});

app.get('/lottery/current/one', (_req, res) => {
  const sql = `
    WITH latest AS (
      SELECT productId, MAX(datetime(createdAt)) AS startedAt
      FROM products
      GROUP BY productId
    )
    SELECT p.productId, p.name, p.endAt, p.createdAt
    FROM products p
    JOIN latest L ON L.productId = p.productId AND datetime(p.createdAt) = datetime(L.startedAt)
    WHERE p.endAt IS NULL OR datetime(p.endAt) > datetime('now')
    ORDER BY 
      CASE WHEN p.endAt IS NULL OR p.endAt = '' THEN 1 ELSE 0 END,
      p.endAt
    LIMIT 1
  `;
  db.get(sql, [], (err, row) => {
    if (err) return res.status(500).json({ ok: false, message: 'DB error' });
    if (!row) return res.json({ ok: true, lottery: null });
    res.json({ ok: true, lottery: row });
  });
});

// --- PUBLIC: get entry count for the latest run of a product ---
app.get('/lottery/count/:productId', (req, res) => {
  const productId = req.params.productId;

  getActiveRun(productId, (err, run) => {
    if (err || !run) return res.json({ success: true, totalEntries: 0 });

    const { where, params } = entriesForRunWhere(run);
    db.get(
      `SELECT COUNT(*) AS c FROM entries WHERE ${where}`,
      params,
      (e, row) => {
        if (e) {
          console.error('SQL error /lottery/count:', e);
          return res.status(500).json({ success: false });
        }
        res.json({ success: true, totalEntries: row?.c || 0 });
      }
    );
  });
});

// ---------- Health ----------
app.get('/', (_req, res) => { res.json({ ok: true, service: 'lottery', version: 2 }); });
app.get('/health', (_req, res) => { res.json({ ok: true, service: 'lottery', version: 2 }); });

// ---------- Start ----------
app.listen(port, () => {
  console.log(`✅ Lottery server running on http://localhost:${port}`);
});