// server.js (Lottery – per product) — email, admin page, Shopify eligibility

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3005;

app.use(express.json());
app.use(cors());

// ---------- Email transporter ----------
const mailer = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT || 587),
  secure: String(process.env.EMAIL_PORT) === '465', // true if SSL (465)
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ---------- SQLite DB (file) ----------
const db = new sqlite3.Database(process.env.DB_PATH || 'lottery.db');
console.log('DB path in use:', process.env.DB_PATH || 'lottery.db');

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

  // Prevent duplicate entries per product (productId + email must be unique)
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_unique ON entries (productId, email)`);
});

// ---------- Helpers ----------
function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}

// ---------- CREATE a product lottery ----------
app.post('/lottery/create', (req, res) => {
  const { productId, name, startPrice, increment, endAt } = req.body;
  if (!productId || !name || !startPrice || !increment || !endAt) {
    return res.status(400).json({ success: false, message: 'Missing fields' });
  }
  db.run(
    `INSERT INTO products (productId, name, startPrice, increment, endAt)
     VALUES (?, ?, ?, ?, ?)`,
    [productId, name, startPrice, increment, endAt],
    function (err) {
      if (err) return res.status(500).json({ success: false, message: 'Server error' });
      res.json({ success: true, productId });
    }
  );
});

// ---------- ENTER a lottery (per product) with Shopify purchase check ----------
app.post('/lottery/enter', async (req, res) => {
  try {
    let { email, productId } = req.body;

    if (!email || !productId) {
      return res.status(400).json({ success: false, message: 'Missing email or productId' });
    }

    // normalize + validate email
    email = String(email).trim().toLowerCase();
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }

    // Optional Shopify eligibility check (only past customers can enter)
    const SHOP = process.env.SHOPIFY_SHOP;
    const TOKEN = process.env.SHOPIFY_TOKEN;

    if (SHOP && TOKEN) {
      // Check if there is at least one order with this email (customer or guest)
      // API: GET /admin/api/2024-07/orders.json?status=any&email=<email>&limit=1
      const url = `https://${SHOP}/admin/api/2024-07/orders.json?status=any&email=${encodeURIComponent(email)}&limit=1`;

      // Node 18+ has global fetch; if your runtime doesn't, add node-fetch dependency
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': TOKEN,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      if (!resp.ok) {
        console.error('Shopify orders lookup failed', resp.status, await resp.text());
        return res.status(503).json({ success: false, message: 'Eligibility check unavailable. Please try again later.' });
      }

      const data = await resp.json();
      const hasOrder = Array.isArray(data.orders) && data.orders.length > 0;

      if (!hasOrder) {
        return res.status(200).json({
          success: false,
          message: 'This lottery is only open to previous customers.'
        });
      }
    } else {
      // If SHOPIFY_* env vars not set, we allow entries (no restriction)
      // console.warn('SHOPIFY_SHOP / SHOPIFY_TOKEN not set; skipping eligibility check.');
    }

    // Insert entry (enforced unique per product)
    db.run(
      `INSERT INTO entries (productId, email) VALUES (?, ?)`,
      [productId, email],
      function (err) {
        if (err) {
          const msg = String(err).toLowerCase();
          if (msg.includes('unique')) {
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

// ---------- DRAW a winner for a product + email them ----------
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
          ${claimLink
            ? `<p>Click below to claim your prize:</p>
               <p><a href="${claimLink}" style="padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px">
                 Claim your prize
               </a></p>
               <p style="font-size:13px;color:#666">If the button doesn’t work, copy this link:<br>${claimLink}</p>`
            : `<p>Please reply to this email to claim your prize.</p>`}
        </div>
      `;

      try {
        await mailer.sendMail({
          from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
          to: winner.email,
          subject: `You won: ${title}!`,
          html
        });

        res.json({
          success: true,
          message: `Winner drawn and emailed for product ${productId}`,
          winner: { email: winner.email }
        });
      } catch (errMail) {
        console.error('Email error:', errMail);
        res.status(500).json({ success: false, message: 'Email failed', error: String(errMail) });
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

  db.all(`SELECT productId, email FROM entries ORDER BY productId`, [], (err, rows) => {
    if (err) return res.status(500).send('DB error');

    const counts = {};
    rows.forEach(r => {
      counts[r.productId] = (counts[r.productId] || 0) + 1;
    });

    let html = `<h2>Lottery Entries</h2>`;
    html += `<p>Total entries: ${rows.length}</p>`;
    html += `<ul>`;
    for (const pid in counts) {
      html += `<li>Product ${pid}: ${counts[pid]} entries</li>`;
    }
    html += `</ul>`;
    html += `<table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>Product ID</th><th>Email</th></tr>`;
    rows.forEach(r => {
      html += `<tr><td>${r.productId}</td><td>${r.email}</td></tr>`;
    });
    html += `</table>`;
    res.send(html);
  });
});

// ---------- Health check ----------
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'lottery', version: 1 });
});

// ---------- Start server ----------
app.listen(port, () => {
  console.log(`✅ Lottery server running on http://localhost:${port}`);
});