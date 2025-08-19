// server.js (Lottery – per product) — with email on draw + validation
// CommonJS version for Windows / default Node setups

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
  secure: String(process.env.EMAIL_PORT) === '465',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ---------- SQLite DB (file) ----------
const db = new sqlite3.Database(process.env.DB_PATH || 'lottery.db');
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

  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_unique ON entries (productId, email)`);
});

// ---------- Email validation helper ----------
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

// ---------- ENTER a lottery ----------
app.post('/lottery/enter', (req, res) => {
  let { email, productId } = req.body;

  if (!email || !productId) {
    return res.status(400).json({ success: false, message: 'Missing email or productId' });
  }

  // normalize email
  email = String(email).trim().toLowerCase();

  // ✅ reject invalid emails
  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'Invalid email format' });
  }

  db.run(
    `INSERT INTO entries (productId, email) VALUES (?, ?)`,
    [productId, email],
    function (err) {
      if (err) {
        if (String(err).toLowerCase().includes('unique')) {
          return res.status(200).json({ success: true, message: 'You are already entered for this product.' });
        }
        return res.status(500).json({ success: false, message: 'Server error' });
      }
      res.json({ success: true, message: 'You have been entered into the lottery!' });
    }
  );
});

// ---------- DRAW a winner ----------
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
                <p><a href="${claimLink}" style="display:inline-block;padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px">
                  Claim your prize
                </a></p>
                <p style="font-size:13px;color:#666">If the button doesn’t work, copy this link:<br>${claimLink}</p>
              `
              : `<p>Please reply to this email to claim your prize.</p>`
          }
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

// ---------- SMTP test ----------
app.all('/debug/email', async (req, res) => {
  try {
    await mailer.verify();
    await mailer.sendMail({
      from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
      to: process.env.EMAIL_USER,
      subject: 'SMTP test from Lottery server',
      text: 'If you received this, your SMTP settings work.'
    });
    res.json({ ok: true, sent: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const path = require('path');
console.log('Loaded server file:', __filename);
console.log('Using .env at     :', path.resolve('.env'));

// ---------- Health check ----------
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