// server.js (Lottery – per product)
// Email, admin page, Shopify eligibility, MX validation, dedupe, public "current" endpoints

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
  secure: String(process.env.EMAIL_PORT) === '465', // true if SSL (465)
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// ---------- SQLite DB (file) ----------
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
      endAt TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId INTEGER,
      email TEXT
    )
  `);

  // ✅ NEW: store winners so admin UI can display them later
  db.run(`
    CREATE TABLE IF NOT EXISTS winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId INTEGER,
      email TEXT,
      drawnAt TEXT
    )
  `);

  // Prevent duplicate entries (same product, same email)
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_unique ON entries (productId, email)`);
});

// ---------- Helpers ----------
const BLOCKED_EMAIL_DOMAINS = (process.env.BLOCKED_EMAIL_DOMAINS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Basic email format
function isValidEmailFormat(email) {
  const re = /^[^\s@]+@[^\s@]+\.[A-Za-z0-9-]{2,}$/;
  return re.test(email);
}

// DNS helper with timeout
async function withTimeout(promise, ms = 2000) {
  return await Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('DNS timeout')), ms))
  ]);
}

// MX (or A) check for deliverability
async function isDeliverableEmail(email) {
  const domain = String(email).split('@')[1]?.toLowerCase();
  if (!domain) return false;

  if (BLOCKED_EMAIL_DOMAINS.includes(domain)) return false;

  try {
    const mx = await withTimeout(dns.resolveMx(domain));
    if (Array.isArray(mx) && mx.length > 0) return true;
  } catch (_) { /* fallthrough */ }

  try {
    const a = await withTimeout(dns.resolve(domain));
    if (Array.isArray(a) && a.length > 0) return true;
  } catch (_) { }

  return false;
}

// Small helper to store winner (used in both success + failure email flows)
function saveWinner(productId, email) {
  return new Promise((resolve) => {
    db.run(
      `INSERT INTO winners (productId, email, drawnAt) VALUES (?, ?, datetime('now'))`,
      [productId, email],
      (errW) => {
        if (errW) console.error('Failed to store winner:', errW);
        resolve(); // always resolve; we don't want to block the response
      }
    );
  });
}

// ---------- CREATE a product lottery ----------
app.post('/lottery/create', (req, res) => {
  let { productId, name, startPrice, increment, endAt } = req.body;

  if (productId == null || name == null || endAt == null || String(name).trim() === '') {
    return res.status(400).json({ success: false, message: 'Missing fields' });
  }

  if (startPrice == null || startPrice === '') startPrice = 0;
  if (increment == null || increment === '') increment = 0;

  db.run(
    `INSERT INTO products (productId, name, startPrice, increment, endAt)
     VALUES (?, ?, ?, ?, ?)`,
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

// ---------- ENTER a lottery (with validation + Shopify order check) ----------
app.post('/lottery/enter', async (req, res) => {
  try {
    let { email, productId } = req.body;
    if (!email || !productId) {
      return res.status(400).json({ success: false, message: 'Missing email or productId' });
    }

    // normalize
    email = String(email).trim().toLowerCase();

    // format + DNS deliverability
    if (!isValidEmailFormat(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }
    const deliverable = await isDeliverableEmail(email);
    if (!deliverable) {
      return res.status(400).json({ success: false, message: 'Please enter a real email address' });
    }

    // Shopify purchase check (guarded)
    const shop  = process.env.SHOPIFY_STORE;          // e.g. smelltoimpress.myshopify.com
    const token = process.env.SHOPIFY_ADMIN_API_KEY;  // Admin API token with read_orders
    console.log('Shopify env check:', { shop: !!shop, token: token ? 'set' : 'missing' });

    if (!shop || !token) {
      return res.status(503).json({
        success: false,
        message: 'Eligibility check unavailable. Please try again later.'
      });
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
      return res.status(200).json({
        success: false,
        message: 'Only customers with a past order can enter this lottery.'
      });
    }

    // Insert (unique index prevents duplicate per product)
    db.run(
      `INSERT INTO entries (productId, email) VALUES (?, ?)`,
      [productId, email],
      function (err) {
        if (err) {
          if (String(err).toLowerCase().includes('unique')) {
            return res.status(200).json({ success: true, message: 'You are already entered for this product.' });
          }
          console.error('DB insert error', err);
          return res.status(500).json({ success: false, message: 'Server error' });
        }
        res.json({ success: true, message: 'You have been entered into the lottery!' });
      }
    );
  } catch (e) {
    console.error('Enter handler error', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------- DRAW a winner (and email them) ----------
app.post('/lottery/draw/:productId', (req, res) => {
  const productId = req.params.productId;
  db.all(`SELECT * FROM entries WHERE productId = ?`, [productId], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: 'Server error' });
    if (!rows || rows.length === 0) {
      return res.status(400).json({ success: false, message: 'No entries for this product yet.' });
    }

    const winner = rows[Math.floor(Math.random() * rows.length)];

    db.get(`SELECT * FROM products WHERE productId = ?`, [productId], async (e2, product) => {
      const title = product?.name || `Product ${productId}`;
      const claimPrefix = process.env.CLAIM_URL_PREFIX || '';
      const claimLink = claimPrefix
        ? `${claimPrefix}${productId}&email=${encodeURIComponent(winner.email)}`
        : null;

      const html = `
        <div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
          <h2>🎉 Congratulations!</h2>
          <p>You’ve won the lottery for <strong>${title}</strong>.</p>
          ${
            claimLink
              ? `
                <p>Click below to claim your prize:</p>
                <p><a href="${claimLink}" style="padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px">
                  Claim your prize
                </a></p>
                <p style="font-size:13px;color:#666">If the button doesn’t work, copy this link:<br>${claimLink}</p>
              `
              : `<p>Please reply to this email to claim your prize.</p>`
          }
        </div>
      `;

      try {
        // ✅ Always store the winner, regardless of email outcome
        await saveWinner(productId, winner.email);

        await mailer.sendMail({
          from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
          to: winner.email,
          subject: `You won: ${title}!`,
          html
        });

        return res.json({
          success: true,
          message: `Winner drawn and emailed for product ${productId}`,
          winner: { email: winner.email }
        });
      } catch (errMail) {
        console.error('Email error:', errMail);

        // Winner is already stored via saveWinner above
        return res.status(200).json({
          success: true,
          message: 'Winner drawn. Email could not be sent.',
          emailed: false,
          winner: { email: winner.email }
        });
      }
    });
  });
});

// --- ADMIN: List all entries ---
app.get('/admin/entries', (req, res) => {
  const pass = req.query.pass;
  if (pass !== process.env.ADMIN_PASS) {
    return res.status(403).send('Forbidden: Wrong password');
  }

  db.all(`SELECT productId, email FROM entries ORDER BY productId, email`, [], (err, rows) => {
    if (err) return res.status(500).send('DB error');

    const counts = {};
    rows.forEach(r => { counts[r.productId] = (counts[r.productId] || 0) + 1; });

    let html = `<h2>Lottery Entries</h2>`;
    html += `<p>Total entries: ${rows.length}</p>`;
    html += `<ul>`;
    for (const pid in counts) {
      html += `<li>Product ${pid}: ${counts[pid]} entries</li>`;
    }
    html += `</ul>`;
    html += `<table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>Product ID</th><th>Email</th></tr>`;
    rows.forEach(r => { html += `<tr><td>${r.productId}</td><td>${r.email}</td></tr>`; });
    html += `</table>`;
    res.send(html);
  });
});

// --- ADMIN: repair entries (normalize + dedupe) ---
app.post('/admin/repair-entries', (req, res) => {
  const pass = req.query.pass;
  if (pass !== process.env.ADMIN_PASS) {
    return res.status(403).json({ ok: false, message: 'Forbidden' });
  }
  db.serialize(() => {
    db.run(`UPDATE entries SET email = lower(trim(email))`);
    db.run(`
      DELETE FROM entries
      WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM entries GROUP BY productId, email
      )
    `);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_unique ON entries (productId, email)`);
  });
  res.json({ ok: true, repaired: true });
});

// --- ADMIN: list lotteries with entries (includes last winnerEmail) ---
app.get('/admin/lotteries', (req, res) => {
  const pass = req.query.pass;
  if (pass !== process.env.ADMIN_PASS) {
    return res.status(403).json({ ok: false, message: 'Forbidden' });
  }

  const sql = `
    WITH lastw AS (
      SELECT productId, MAX(drawnAt) AS lastDraw
      FROM winners
      GROUP BY productId
    )
    SELECT p.productId, p.name, p.endAt,
           COUNT(e.id) AS entries,
           w.email AS winnerEmail,
           lastw.lastDraw
    FROM products p
    JOIN entries e ON e.productId = p.productId
    LEFT JOIN lastw ON lastw.productId = p.productId
    LEFT JOIN winners w ON w.productId = p.productId AND w.drawnAt = lastw.lastDraw
    GROUP BY p.productId
    HAVING entries > 0
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

// --- PUBLIC: list current active lotteries (no admin password) ---
app.get('/lottery/current', (req, res) => {
  const sql = `
    SELECT productId, name, endAt
    FROM products
    WHERE endAt IS NULL OR datetime(endAt) > datetime('now')
    ORDER BY 
      CASE WHEN endAt IS NULL OR endAt = '' THEN 1 ELSE 0 END,
      endAt
    LIMIT 10
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ ok: false, message: 'DB error' });
    res.json({ ok: true, lotteries: rows });
  });
});

// --- PUBLIC: fetch only one active lottery (first upcoming one) ---
app.get('/lottery/current/one', (req, res) => {
  const sql = `
    SELECT productId, name, endAt
    FROM products
    WHERE endAt IS NULL OR datetime(endAt) > datetime('now')
    ORDER BY 
      CASE WHEN endAt IS NULL OR endAt = '' THEN 1 ELSE 0 END,
      endAt
    LIMIT 1
  `;
  db.get(sql, [], (err, row) => {
    if (err) return res.status(500).json({ ok: false, message: 'DB error' });
    if (!row) return res.json({ ok: true, lottery: null });
    res.json({ ok: true, lottery: row });
  });
});

// --- PUBLIC: get entry count for a product ---
app.get('/lottery/count/:productId', (req, res) => {
  const productId = req.params.productId;
  db.get(
    `SELECT COUNT(*) AS c FROM entries WHERE productId = ?`,
    [productId],
    (err, row) => {
      if (err) {
        console.error('SQL error /lottery/count:', err);
        return res.status(500).json({ success: false });
      }
      res.json({ success: true, totalEntries: row?.c || 0 });
    }
  );
});

// ---------- Health checks ----------
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'lottery', version: 1 });
});
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'lottery', version: 1 });
});

// ---------- Start server ----------
app.listen(port, () => {
  console.log(`✅ Lottery server running on http://localhost:${port}`);
});