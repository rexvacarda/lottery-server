// server.js — multi-run safe, with safe migrations for existing DB
// Keeps old data working and scopes counts/draws to the latest run per productId.

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

// Small helper to run SQL and ignore "duplicate column" or "already exists" errors
function runIgnore(sql, params = []) {
  return new Promise((resolve) => {
    db.run(sql, params, (err) => {
      if (err) {
        const m = String(err).toLowerCase();
        // ignore common migration errors
        if (
          m.includes('duplicate column') ||
          m.includes('already exists') ||
          m.includes('no such index') ||
          m.includes('not unique') // harmless here
        ) {
          return resolve();
        }
        console.error('SQL error:', err.message);
      }
      resolve();
    });
  });
}

function tableHasColumn(table, column) {
  return new Promise((resolve) => {
    db.all(`PRAGMA table_info(${table})`, (err, rows) => {
      if (err) return resolve(false);
      resolve(rows.some(r => r.name === column));
    });
  });
}

db.serialize(async () => {
  // Create base tables if they don't exist
  await runIgnore(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId INTEGER,
      name TEXT,
      startPrice REAL,
      increment REAL,
      endAt TEXT
    )
  `);

  await runIgnore(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId INTEGER,
      email TEXT
    )
  `);

  await runIgnore(`
    CREATE TABLE IF NOT EXISTS winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId INTEGER,
      email TEXT,
      drawnAt TEXT DEFAULT (datetime('now'))
    )
  `);

  // ---- Safe migrations (non-destructive) ----
  // products.createdAt (used as "run start")
  const hasProdCreatedAt = await tableHasColumn('products', 'createdAt');
  if (!hasProdCreatedAt) {
    await runIgnore(`ALTER TABLE products ADD COLUMN createdAt TEXT`);
    // For existing lotteries, set run start very old so all old entries (with NULL createdAt) would match if ever needed.
    await runIgnore(`UPDATE products SET createdAt = COALESCE(createdAt, '1970-01-01 00:00:00')`);
  }

  // entries.createdAt (timestamp for entry time)
  const hasEntryCreatedAt = await tableHasColumn('entries', 'createdAt');
  if (!hasEntryCreatedAt) {
    await runIgnore(`ALTER TABLE entries ADD COLUMN createdAt TEXT`);
    // DO NOT fill with "now" — leave NULL so old entries are *excluded* from new runs.
    // (Comparisons with NULL are false, so they won't be counted for new runs.)
  }

  // Old unique index across (productId,email) could block re-entries in new runs.
  await runIgnore(`DROP INDEX IF EXISTS idx_entries_unique`);

  // Helpful indexes (non-unique)
  await runIgnore(`CREATE INDEX IF NOT EXISTS idx_entries_pid_createdAt ON entries (productId, createdAt)`);
  await runIgnore(`CREATE INDEX IF NOT EXISTS idx_entries_pid_email_createdAt ON entries (productId, email, createdAt)`);

  db.run(`PRAGMA busy_timeout=3000`);
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

// Latest run for a productId
function getActiveRun(productId, cb) {
  db.get(
    `SELECT * FROM products
     WHERE productId = ?
     ORDER BY datetime(createdAt) DESC
     LIMIT 1`,
    [productId],
    cb
  );
}

// Build WHERE for entries in a run
function entriesWhereForRun(run) {
  // Only entries created at/after the run start; if run has endAt, cap it
  let where = `productId = ? AND createdAt IS NOT NULL AND datetime(createdAt) >= datetime(?)`;
  const params = [run.productId, run.createdAt];
  if (run.endAt) {
    where += ` AND datetime(createdAt) <= datetime(?)`;
    params.push(run.endAt);
  }
  return { where, params };
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
    if (!isValidEmailFormat(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }
    const deliverable = await isDeliverableEmail(email);
    if (!deliverable) {
      return res.status(400).json({ success: false, message: 'Please enter a real email address' });
    }

    // Optional Shopify eligibility (as before)
    const shop  = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ADMIN_API_KEY;
    if (!shop || !token) {
      return res.status(503).json({
        success: false,
        message: 'Eligibility check unavailable. Please try again later.'
      });
    }

    // Simple eligibility check (kept the same)
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

    // Get the current run
    getActiveRun(productId, (err, run) => {
      if (err || !run) return res.status(404).json({ success: false, message: 'No lottery run found.' });

      const runStart = run.createdAt;

      // Check duplicate within the same run (entries created since run start)
      db.get(
        `SELECT 1 FROM entries
         WHERE productId = ?
           AND email = ?
           AND createdAt IS NOT NULL
           AND datetime(createdAt) >= datetime(?)
         LIMIT 1`,
        [productId, email, runStart],
        (dupErr, existing) => {
          if (dupErr) {
            console.error('Dup check error', dupErr);
            return res.status(500).json({ success: false, message: 'Server error' });
          }
          if (existing) {
            return res.status(200).json({ success: true, message: 'You are already entered for this product.' });
          }

          // Insert this entry with a timestamp
          db.run(
            `INSERT INTO entries (productId, email, createdAt) VALUES (?, ?, datetime('now'))`,
            [productId, email],
            function (insErr) {
              if (insErr) {
                console.error('DB insert error', insErr);
                return res.status(500).json({ success: false, message: 'Server error' });
              }
              res.json({ success: true, message: 'You have been entered into the lottery!' });
            }
          );
        }
      );
    });

  } catch (e) {
    console.error('Enter handler error', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------- DRAW a winner (scoped to latest run) ----------
app.post('/lottery/draw/:productId', (req, res) => {
  const productId = req.params.productId;

  getActiveRun(productId, (err, run) => {
    if (err || !run) return res.status(404).json({ success: false, message: 'No lottery run found.' });

    const { where, params } = entriesWhereForRun(run);

    db.all(`SELECT * FROM entries WHERE ${where}`, params, (e1, rows) => {
      if (e1) return res.status(500).json({ success: false, message: 'Server error' });
      if (!rows || rows.length === 0) {
        return res.status(400).json({ success: false, message: 'No entries for this product yet.' });
      }

      const winner = rows[Math.floor(Math.random() * rows.length)];
      const title = run?.name || `Product ${productId}`;

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
            : `<p>Please reply to this email to claim your prize.</p>`
          }
        </div>
      `;

      (async () => {
        try {
          // store the winner (optional table)
          await new Promise((resolve) => {
            db.run(
              `INSERT INTO winners (productId, email, drawnAt) VALUES (?, ?, datetime('now'))`,
              [productId, winner.email],
              () => resolve()
            );
          });

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
          res.status(200).json({
            success: true,
            message: 'Winner drawn. Email could not be sent.',
            emailed: false,
            winner: { email: winner.email }
          });
        }
      })();
    });
  });
});

// --- ADMIN: list latest run per PID with counts for that run ---
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
    JOIN latest L
      ON L.productId = p.productId
     AND datetime(p.createdAt) = datetime(L.startedAt)
    LEFT JOIN entries e
      ON e.productId = p.productId
     AND e.createdAt IS NOT NULL
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
    JOIN latest L
      ON L.productId = p.productId
     AND datetime(p.createdAt) = datetime(L.startedAt)
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
    JOIN latest L
      ON L.productId = p.productId
     AND datetime(p.createdAt) = datetime(L.startedAt)
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

    const { where, params } = entriesWhereForRun(run);
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
app.get('/', (_req, res) => { res.json({ ok: true, service: 'lottery', version: 3 }); });
app.get('/health', (_req, res) => { res.json({ ok: true, service: 'lottery', version: 3 }); });

// ---------- Start ----------
app.listen(port, () => {
  console.log(`✅ Lottery server running on http://localhost:${port}`);
});