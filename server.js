// server.js (Lottery + Back-in-Stock, multilingual)
// Email, admin page, Shopify eligibility, MX validation, dedupe, public "current" endpoints

const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const dns = require('dns').promises;
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3005;
const host = '0.0.0.0';

// Ensure fetch exists (Node >=18 has it; for <18 we lazy-load node-fetch v3 ESM)
const ensureFetch = async () => {
  if (typeof fetch !== 'undefined') return fetch;
  const { default: nodeFetch } = await import('node-fetch');
  return nodeFetch;
};

app.use(express.json());
app.use(cors());
app.use(express.urlencoded({ extended: true })); // for <form> posts

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
    CREATE TABLE IF NOT EXISTS unsubscribes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId INTEGER,
      email TEXT,
      locale TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS bis_subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      product_handle TEXT,
      product_title TEXT,
      variant_id TEXT,
      locale TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId INTEGER,
      email TEXT,
      drawnAt TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS bis_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId TEXT,
      email TEXT,
      locale TEXT,
      createdAt TEXT
    )
  `);

  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bis_unique ON bis_requests (productId, email)`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_unique ON entries (productId, email)`);

  // Try to add entries.locale if it wasn't there (ignore if exists)
  db.run(`ALTER TABLE entries ADD COLUMN locale TEXT`, err => {
    if (err && !String(err.message || err).toLowerCase().includes('duplicate column name')) {
      console.warn('ALTER TABLE entries ADD COLUMN locale warning:', err.message || err);
    }
  });
});

// ---------- Helpers ----------
const BLOCKED_EMAIL_DOMAINS = (process.env.BLOCKED_EMAIL_DOMAINS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function normEmail(e) { return String(e || '').trim().toLowerCase(); }

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
  } catch (_) { /* ignore */ }

  try {
    const a = await withTimeout(dns.resolve(domain));
    if (Array.isArray(a) && a.length > 0) return true;
  } catch (_) { /* ignore */ }

  return false;
}

function normLocale(loc) { return String(loc || 'en').toLowerCase(); }
function shortLocale(loc) { return normLocale(loc).split('-')[0]; }

// ---------- Unsubscribe helpers (single, unified set) ----------
const UNSUB_SECRET = process.env.UNSUB_SECRET || process.env.UNSUBSCRIBE_SECRET || 'change-me';

function signUnsub(email) {
  return crypto.createHmac('sha256', UNSUB_SECRET)
    .update(normEmail(email))
    .digest('hex')
    .slice(0, 32);
}

function buildUnsubLink(email) {
  const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const t = signUnsub(email);
  return `${base}/u?e=${encodeURIComponent(normEmail(email))}&t=${t}`;
}

function verifyUnsub(email, token) {
  if (!token) return false;
  try {
    const expected = signUnsub(email);
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(token)));
  } catch {
    return false;
  }
}

function isUnsubscribed(email) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT 1 FROM unsubscribes WHERE email = ? LIMIT 1`, [normEmail(email)], (err, row) => {
      if (err) return reject(err);
      resolve(!!row);
    });
  });
}

function withUnsubFooter(html, email) {
  const link = buildUnsubLink(email);
  const brand = process.env.BRAND_NAME || 'our store';
  const footer = `
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
    <p style="font:13px/1.45 Arial,sans-serif;color:#666;margin:0">
      You’re receiving this because you subscribed at ${brand}.
      <a href="${link}">Unsubscribe</a>.
    </p>`;

  if (/<\/body>\s*<\/html>\s*$/i.test(html)) {
    return html.replace(/<\/body>\s*<\/html>\s*$/i, `${footer}</body></html>`);
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${footer}</body>`);
  }
  return String(html || '') + footer;
}

function listUnsubHeader(email) {
  const httpLink = buildUnsubLink(email);
  const mailto = (process.env.UNSUBSCRIBE_MAILTO || '').trim();
  return mailto ? `<mailto:${mailto}>, <${httpLink}>` : `<${httpLink}>`;
}

// ---------- Shopify helpers ----------
async function shopifyGraphQL(query, variables = {}) {
  const f = await ensureFetch();
  const shop = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_API_KEY;
  if (!shop || !token) throw new Error('Missing SHOPIFY_STORE or SHOPIFY_ADMIN_API_KEY');

  const resp = await f(`https://${shop}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Shopify GQL ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  if (data.errors) throw new Error(`Shopify GQL errors: ${JSON.stringify(data.errors)}`);
  return data.data;
}

async function fetchAllSubscribedCustomersFromShopify() {
  const out = [];
  let cursor = null;
  const q = `
    query Customers($cursor: String) {
      customers(first: 250, after: $cursor, query: "email_marketing_consent:subscribed") {
        edges {
          cursor
          node { email locale emailMarketingConsent { state } }
        }
        pageInfo { hasNextPage }
      }
    }
  `;
  while (true) {
    const data = await shopifyGraphQL(q, { cursor });
    const edges = data?.customers?.edges || [];
    for (const e of edges) {
      const n = e.node;
      if (!n?.email) continue;
      const email = normEmail(n.email);
      const loc = (n.locale || '').toLowerCase();
      const short = loc.includes('-') ? loc.split('-')[0] : loc;
      out.push({ email, short_locale: short || '' });
    }
    if (!data?.customers?.pageInfo?.hasNextPage) break;
    cursor = edges[edges.length - 1]?.cursor || null;
    if (!cursor) break;
  }
  // dedupe
  const seen = new Set();
  const deduped = [];
  for (const r of out) {
    if (seen.has(r.email)) continue;
    seen.add(r.email);
    deduped.push(r);
  }
  return deduped;
}

function ensureAdmin(req, res) {
  const pass = req.query.pass || req.headers['x-admin-pass'] || req.body?.pass;
  if (pass !== process.env.ADMIN_PASS) {
    res.status(403).send('Forbidden: wrong password');
    return false;
  }
  return true;
}

function isAdmin(req) {
  const pass = req.query.pass || req.body?.pass || req.headers['x-admin-pass'];
  return pass && pass === process.env.ADMIN_PASS;
}

// ---------- Email content builders ----------
function buildEmail(locale, title, claimLink) {
  const l = normLocale(locale), s = shortLocale(locale);
  const t = {
    en: { subject: `You won: ${title}!`, hello: `🎉 Congratulations!`, body: `You’ve won the lottery for <strong>${title}</strong>.`, ctaLead: `Click below to claim your prize:`, cta: `Claim your prize`, reply: `Please reply to this email to claim your prize.`, copyHelp: `If the button doesn’t work, copy this link:` },
    de: { subject: `Sie haben gewonnen: ${title}!`, hello: `🎉 Herzlichen Glückwunsch!`, body: `Sie haben die Verlosung für <strong>${title}</strong> gewonnen.`, ctaLead: `Klicken Sie unten, um Ihren Gewinn einzulösen:`, cta: `Gewinn einlösen`, reply: `Bitte antworten Sie auf diese E-Mail, um Ihren Gewinn zu beanspruchen.`, copyHelp: `Falls die Schaltfläche nicht funktioniert, kopieren Sie diesen Link:` },
    // ... (other locales omitted for brevity; keep yours as in your version)
  };
  const pack = t[l] || t[s] || t.en;
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
      <h2>${pack.hello}</h2>
      <p>${pack.body}</p>
      ${claimLink ? `
        <p>${pack.ctaLead}</p>
        <p><a href="${claimLink}" style="padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px">${pack.cta}</a></p>
        <p style="font-size:13px;color:#666">${pack.copyHelp}<br>${claimLink}</p>
      ` : `<p>${pack.reply}</p>`}
    </div>
  `;
  return { subject: pack.subject, html };
}

function buildEntryConfirmEmail(locale, title) {
  const l = normLocale(locale), s = shortLocale(locale);
  const t = {
    en: { subject: `You're in: ${title}`, body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Thanks—your entry for <strong>${title}</strong> is confirmed.</p><p>We’ll draw at the deadline and email the winner.</p></div>` },
    de: { subject: `Sie sind dabei: ${title}`, body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Danke – Ihre Teilnahme für <strong>${title}</strong> wurde bestätigt.</p><p>Wir losen zum Stichtag aus und benachrichtigen den Gewinner per E-Mail.</p></div>` },
    // ... (other locales as in your version)
  };
  const pack = t[l] || t[s] || t.en;
  return { subject: pack.subject, html: pack.body };
}

// ---------- BIS i18n ----------
const BIS_I18N = {
  subject: {
    en: 'Back in stock: {{title}}',
    de: 'Wieder auf Lager: {{title}}',
    fr: 'De retour en stock : {{title}}',
    es: '¡De vuelta en stock!: {{title}}',
    it: 'Tornato disponibile: {{title}}',
    nl: 'Terug op voorraad: {{title}}',
    da: 'Tilbage på lager: {{title}}',
    sv: 'Tillbaka i lager: {{title}}',
    nb: 'Tilbake på lager: {{title}}',
    fi: 'Täydennetty varastoon: {{title}}',
    cs: 'Zpět na skladě: {{title}}',
    sk: 'Opäť na sklade: {{title}}',
    sl: 'Spet na zalogi: {{title}}',
    hu: 'Újra készleten: {{title}}',
    ro: 'Înapoi în stoc: {{title}}',
    pl: 'Ponownie w magazynie: {{title}}',
    pt: 'De volta ao estoque: {{title}}',
    bg: 'Отново в наличност: {{title}}',
    el: 'Ξανά διαθέσιμο: {{title}}',
    ru: 'Снова в наличии: {{title}}',
    tr: 'Yeniden stokta: {{title}}',
    vi: 'Có hàng trở lại: {{title}}',
    ja: '再入荷：{{title}}',
    ko: '재입고: {{title}}',
    'zh-cn': '现已到货：{{title}}',
    'zh-tw': '現已到貨：{{title}}'
  },
  body: {
    en: (title, url) => `
      <div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
        <p>Good news — <strong>${title}</strong> is back in stock.</p>
        <p><a href="${url}" style="padding:10px 14px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Shop now</a></p>
      </div>`,
    // ... (other locales as in your version)
  }
};
function pickLoc(str, fallback = 'en') {
  const s = (str || '').toLowerCase();
  if (BIS_I18N.subject[s]) return s;
  const short = s.split('-')[0];
  return BIS_I18N.subject[short] ? short : fallback;
}
function sub(tpl, vars) { return tpl.replace(/{{\s*(\w+)\s*}}/g, (_, k) => (vars[k] ?? '')); }

// ---------- Routes ----------

// Unsubscribe (link: /u?e=<email>&t=<token>)
app.get('/u', (req, res) => {
  const email = normEmail(req.query.e);
  const token = String(req.query.t || '');
  if (!email || !verifyUnsub(email, token)) {
    return res.status(400).send(`
      <div style="font:16px Arial,sans-serif;color:#333">
        <p>Invalid or expired unsubscribe link.</p>
      </div>
    `);
  }
  db.run(`INSERT OR IGNORE INTO unsubscribes (email) VALUES (?)`, [email], err => {
    if (err) {
      console.error('Unsubscribe DB error:', err);
      return res.status(500).send(`<div style="font:16px Arial,sans-serif;color:#333">Server error.</div>`);
    }
    return res.send(`
      <div style="font:16px Arial,sans-serif;color:#333">
        <h2 style="margin:0 0 10px 0">You’ve been unsubscribed</h2>
        <p>${email} will no longer receive marketing emails from us.</p>
      </div>
    `);
  });
});

// --- Admin broadcast from Shopify (form)
app.get('/admin/broadcast-shopify', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    const rows = await fetchAllSubscribedCustomersFromShopify();
    const counts = {};
    for (const r of rows) counts[r.short_locale || 'en'] = (counts[r.short_locale || 'en'] || 0) + 1;
    const total = rows.length;
    const opts = Object.keys(counts).sort().map(k => `<option value="${k}">${k} (${counts[k]})</option>`).join('');
    res.send(`
      <meta charset="utf-8">
      <style>
        body { font-family:system-ui, Arial, sans-serif; padding:20px; max-width:900px; margin:0 auto; color:#222;}
        .box { border:1px solid #ddd; border-radius:10px; padding:16px; margin-top:16px;}
        label { display:block; margin-top:12px; font-weight:600; }
        input[type="text"]{ width:100%; padding:10px; border:1px solid #ccc; border-radius:8px;}
        textarea{ width:100%; min-height:260px; padding:10px; border:1px solid #ccc; border-radius:8px; font-family:Consolas,monospace;}
        select,button{ padding:10px 12px; border-radius:8px; border:1px solid #999;}
        .row{ display:flex; gap:8px; align-items:center; flex-wrap:wrap;}
        .muted{ color:#666; font-size:13px;}
        .right{ text-align:right;}
        .btn-primary{ background:#111; color:#fff; border-color:#111;}
      </style>
      <h1>Broadcast from Shopify Customers</h1>
      <p class="muted">Total subscribed customers: <strong>${total}</strong></p>
      <div class="box">
        <form method="POST" action="/admin/broadcast-shopify/send?pass=${encodeURIComponent(req.query.pass || '')}">
          <label>Subject</label>
          <input type="text" name="subject" placeholder="Your email subject" required>
          <div class="row">
            <div>
              <label>Segment by language</label>
              <select name="segment" required>
                <option value="all">All locales</option>
                ${opts}
              </select>
            </div>
            <div>
              <label>Test only</label>
              <select name="test_only">
                <option value="yes">Yes (no sends)</option>
                <option value="no">No (send)</option>
              </select>
            </div>
            <div>
              <label>Max send (cap)</label>
              <input type="text" name="max_send" value="2000" style="width:110px">
            </div>
          </div>
          <label>HTML content</label>
          <textarea name="html" placeholder="<div>...</div>" required></textarea>
          <div class="row right"><button type="submit" class="btn-primary">Go</button></div>
        </form>
      </div>
    `);
  } catch (e) {
    console.error('broadcast-shopify form error', e);
    res.status(500).send('Server error');
  }
});

// Send broadcast
app.post('/admin/broadcast-shopify/send', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    const f = await ensureFetch();
    let { subject, html, segment, test_only, max_send } = req.body || {};
    subject = String(subject || '').trim();
    html = String(html || '').trim();
    segment = String(segment || 'all').toLowerCase();
    test_only = String(test_only || 'yes') === 'yes';
    max_send = Number(max_send || 2000);
    if (!subject || !html) return res.status(400).send('Missing subject or HTML.');
    const all = await fetchAllSubscribedCustomersFromShopify();
    const filtered = (segment === 'all') ? all : all.filter(r => (r.short_locale || 'en') === segment);
    const toSend = filtered.slice(0, Math.max(0, max_send));

    if (test_only) {
      return res.send(`
        <meta charset="utf-8">
        <div style="font-family:system-ui,Arial,sans-serif;padding:20px;max-width:900px;margin:0 auto">
          <h2>Test Mode (no emails sent)</h2>
          <p><strong>Segment:</strong> ${segment}</p>
          <p><strong>Total candidates:</strong> ${filtered.length}</p>
          <p><strong>Capped to:</strong> ${toSend.length}</p>
          <p><strong>Sample first 20:</strong></p>
          <pre>${toSend.slice(0,20).map(x=>x.email).join('\\n')}</pre>
          <h3>Subject</h3>
          <pre>${subject.replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</pre>
          <h3>HTML Preview</h3>
          <div style="border:1px solid #ddd;border-radius:8px;padding:12px">${html}</div>
        </div>
      `);
    }

    let sent = 0, failed = 0;
    const batchSize = 50;
    for (let i = 0; i < toSend.length; i += batchSize) {
      const batch = toSend.slice(i, i + batchSize);
      const jobs = batch.map(r =>
        mailer.sendMail({
          from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
          to: r.email,
          subject,
          html: withUnsubFooter(html, r.email),
          headers: { 'List-Unsubscribe': listUnsubHeader(r.email) }
        }).then(() => { sent++; }).catch(err => { failed++; console.error('shopify broadcast error', r.email, err); })
      );
      await Promise.allSettled(jobs);
      await new Promise(r => setTimeout(r, 600));
    }
    res.send(`
      <meta charset="utf-8">
      <div style="font-family:system-ui,Arial,sans-serif;padding:20px;max-width:900px;margin:0 auto">
        <h2>Broadcast complete</h2>
        <p><strong>Segment:</strong> ${segment}</p>
        <p><strong>Attempted:</strong> ${toSend.length}</p>
        <p><strong>Sent:</strong> ${sent}</p>
        <p><strong>Failed:</strong> ${failed}</p>
        <p><a href="/admin/broadcast-shopify?pass=${encodeURIComponent(req.query.pass || '')}">← Back</a></p>
      </div>
    `);
  } catch (e) {
    console.error('broadcast-shopify send error', e);
    res.status(500).send('Server error');
  }
});

// ---------- Lottery ----------
app.post('/lottery/create', (req, res) => {
  let { productId, name, startPrice, increment, endAt } = req.body;
  if (productId == null || name == null || endAt == null || String(name).trim() === '') {
    return res.status(400).json({ success: false, message: 'Missing fields' });
  }
  if (startPrice == null || startPrice === '') startPrice = 0;
  if (increment == null || increment === '') increment = 0;

  db.run(
    `INSERT INTO products (productId, name, startPrice, increment, endAt) VALUES (?, ?, ?, ?, ?)`,
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

app.post('/lottery/enter', async (req, res) => {
  try {
    const f = await ensureFetch();
    let { email, productId, locale } = req.body;
    if (!email || !productId) {
      return res.status(400).json({ success: false, message: 'Missing email or productId' });
    }
    locale = normLocale(locale || 'en');
    email = normEmail(email);

    if (!isValidEmailFormat(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }
    const deliverable = await isDeliverableEmail(email);
    if (!deliverable) {
      return res.status(400).json({ success: false, message: 'Please enter a real email address' });
    }

    const shop = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ADMIN_API_KEY;
    if (!shop || !token) {
      return res.status(503).json({ success: false, message: 'Eligibility check unavailable. Please try again later.' });
    }

    const url = `https://${shop}/admin/api/2025-01/orders.json?email=${encodeURIComponent(email)}&status=any&limit=1`;
    const resp = await f(url, { method: 'GET', headers: { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' } });
    if (!resp.ok) {
      console.error('Shopify API error', resp.status, await resp.text());
      return res.status(503).json({ success: false, message: 'Eligibility check unavailable. Please try again later.' });
    }
    const data = await resp.json();
    const hasOrder = Array.isArray(data.orders) && data.orders.length > 0;
    if (!hasOrder) {
      return res.status(200).json({ success: false, message: 'Only customers with a past order can enter this lottery.' });
    }

    db.run(`INSERT INTO entries (productId, email, locale) VALUES (?, ?, ?)`,
      [productId, email, locale],
      function (err) {
        if (err) {
          if (String(err).toLowerCase().includes('unique')) {
            return res.status(200).json({ success: true, message: 'You are already entered for this product.' });
          }
          console.error('DB insert error', err);
          return res.status(500).json({ success: false, message: 'Server error' });
        }

        try {
          db.get(`SELECT name FROM products WHERE productId = ?`, [productId], async (_e2, row) => {
            try {
              const title = row?.name || `Product ${productId}`;
              const { subject, html } = buildEntryConfirmEmail(locale, title);
              await mailer.sendMail({
                from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
                to: email,
                subject,
                html
              });
            } catch (mailErr) {
              console.warn('Entry confirmation email failed:', mailErr?.message || mailErr);
            }
          });
        } catch (e) {
          console.warn('Post-insert confirm mail scheduling failed:', e?.message || e);
        }

        res.json({ success: true, message: 'You have been entered into the lottery!' });
      }
    );
  } catch (e) {
    console.error('Enter handler error', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

function saveWinner(productId, email) {
  return new Promise(resolve => {
    db.run(
      `INSERT INTO winners (productId, email, drawnAt) VALUES (?, ?, datetime('now'))`,
      [productId, email],
      (errW) => {
        if (errW) console.error('Failed to store winner:', errW);
        resolve();
      }
    );
  });
}

app.post('/lottery/draw/:productId', (req, res) => {
  const productId = req.params.productId;
  db.all(`SELECT * FROM entries WHERE productId = ?`, [productId], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: 'Server error' });
    if (!rows || rows.length === 0) {
      return res.status(400).json({ success: false, message: 'No entries for this product yet.' });
    }
    const winner = rows[Math.floor(Math.random() * rows.length)];
    db.get(`SELECT * FROM products WHERE productId = ?`, [productId], async (_e2, product) => {
      const title = product?.name || `Product ${productId}`;
      const claimPrefix = process.env.CLAIM_URL_PREFIX || '';
      const claimLink = claimPrefix ? `${claimPrefix}${productId}&email=${encodeURIComponent(winner.email)}` : null;
      try {
        await saveWinner(productId, winner.email);
        const { subject, html } = buildEmail(winner.locale || 'en', title, claimLink);
        await mailer.sendMail({ from: process.env.FROM_EMAIL || process.env.EMAIL_USER, to: winner.email, subject, html });
        return res.json({ success: true, message: `Winner drawn and emailed for product ${productId}`, winner: { email: winner.email, locale: winner.locale || 'en' } });
      } catch (errMail) {
        console.error('Email error:', errMail);
        return res.status(200).json({ success: true, message: 'Winner drawn. Email could not be sent.', emailed: false, winner: { email: winner.email, locale: winner.locale || 'en' } });
      }
    });
  });
});

// ---------- Back-in-Stock (BIS) ----------
app.post('/bis/subscribe', async (req, res) => {
  try {
    let { email, product_handle, product_title, variant_id, locale } = req.body || {};
    if (!email || !product_handle) {
      return res.status(400).json({ ok: false, message: 'Missing email or product' });
    }
    email = normEmail(email);
    locale = normLocale(locale || 'en');

    if (!isValidEmailFormat(email)) return res.status(400).json({ ok: false, message: 'Invalid email format' });
    const deliverable = await isDeliverableEmail(email);
    if (!deliverable) return res.status(400).json({ ok: false, message: 'Please enter a real email address' });

    db.run(
      `INSERT INTO bis_subscribers (email, product_handle, product_title, variant_id, locale) VALUES (?, ?, ?, ?, ?)`,
      [email, product_handle, product_title || '', String(variant_id || ''), locale],
      (err) => { if (err) console.error('BIS insert error:', err); }
    );

    // confirmation to subscriber
    const packs = {
      en: { sub: 'We’ll notify you when it’s back', body: `You’ll receive an email as soon as <strong>${product_title || product_handle}</strong> is back in stock.` },
      de: { sub: 'Wir benachrichtigen Sie bei Verfügbarkeit', body: `Sobald <strong>${product_title || product_handle}</strong> wieder verfügbar ist, erhalten Sie eine E-Mail.` }
    };
    const short = shortLocale(locale);
    const p = packs[locale] || packs[short] || packs.en;

    const htmlCustomer = `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>${p.body}</p></div>`;

    try {
      await mailer.sendMail({ from: process.env.FROM_EMAIL || process.env.EMAIL_USER, to: email, subject: p.sub, html: htmlCustomer });
      const ownerTo = process.env.BIS_NOTIFY_TO || process.env.FROM_EMAIL || process.env.EMAIL_USER;
      if (ownerTo) {
        await mailer.sendMail({
          from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
          to: ownerTo,
          subject: `BIS signup: ${product_title || product_handle}`,
          html: `<div>New BIS request<br>Email: ${email}<br>Product: ${product_title || product_handle}<br>Variant: ${variant_id || '-'}<br>Locale: ${locale}</div>`
        });
      }
    } catch (mailErr) {
      console.error('BIS mail error:', mailErr);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('BIS subscribe error:', e);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// Notify all BIS subscribers for a product
app.post('/bis/notify', async (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== process.env.ADMIN_PASS) return res.status(403).json({ success: false, message: 'Forbidden' });

  const { productId, productTitle, productUrl, localeOverride } = req.body || {};
  if (!productId || !productTitle || !productUrl) {
    return res.status(400).json({ success: false, message: 'Missing productId/productTitle/productUrl' });
  }

  db.all(`SELECT email, locale FROM bis_requests WHERE productId = ?`, [String(productId)], async (err, rows) => {
    if (err) {
      console.error('BIS select error', err);
      return res.status(500).json({ success: false, message: 'DB error' });
    }
    if (!rows || !rows.length) return res.json({ success: true, sent: 0, message: 'No subscribers' });

    let sent = 0, failed = 0;
    for (const r of rows) {
      const loc = pickLoc(localeOverride || r.locale || 'en');
      const subj = sub(BIS_I18N.subject[loc] || BIS_I18N.subject.en, { title: productTitle });
      const html = (BIS_I18N.body[loc] || BIS_I18N.body.en)(productTitle, productUrl);
      try {
        await mailer.sendMail({ from: process.env.FROM_EMAIL || process.env.EMAIL_USER, to: r.email, subject: subj, html });
        sent++;
      } catch (e) {
        console.error('BIS mail error', r.email, e);
        failed++;
      }
    }

    db.run(`DELETE FROM bis_requests WHERE productId = ?`, [String(productId)]);
    res.json({ success: true, sent, failed });
  });
});

// --- ADMIN: List all entries ---
app.get('/admin/entries', (req, res) => {
  const pass = req.query.pass;
  if (pass !== process.env.ADMIN_PASS) return res.status(403).send('Forbidden: Wrong password');

  db.all(`SELECT productId, email FROM entries ORDER BY productId, email`, [], (err, rows) => {
    if (err) return res.status(500).send('DB error');
    const counts = {};
    rows.forEach(r => { counts[r.productId] = (counts[r.productId] || 0) + 1; });

    let html = `<h2>Lottery Entries</h2>`;
    html += `<p>Total entries: ${rows.length}</p><ul>`;
    for (const pid in counts) html += `<li>Product ${pid}: ${counts[pid]} entries</li>`;
    html += `</ul><table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>Product ID</th><th>Email</th></tr>`;
    rows.forEach(r => { html += `<tr><td>${r.productId}</td><td>${r.email}</td></tr>`; });
    html += `</table>`;
    res.send(html);
  });
});

// --- ADMIN: repair entries (normalize + dedupe) ---
app.post('/admin/repair-entries', (req, res) => {
  const pass = req.query.pass;
  if (pass !== process.env.ADMIN_PASS) return res.status(403).json({ ok: false, message: 'Forbidden' });

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
  if (pass !== process.env.ADMIN_PASS) return res.status(403).json({ ok: false, message: 'Forbidden' });

  const sql = `
    WITH lastw AS (SELECT productId, MAX(drawnAt) AS lastDraw FROM winners GROUP BY productId)
    SELECT p.productId, p.name, p.endAt, COUNT(e.id) AS entries, w.email AS winnerEmail, lastw.lastDraw
    FROM products p
    JOIN entries e ON e.productId = p.productId
    LEFT JOIN lastw ON lastw.productId = p.productId
    LEFT JOIN winners w ON w.productId = p.productId AND w.drawnAt = lastw.lastDraw
    GROUP BY p.productId
    HAVING entries > 0
    ORDER BY CASE WHEN p.endAt IS NULL OR p.endAt = '' THEN 1 ELSE 0 END, p.endAt
  `;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('SQL error /admin/lotteries:', err);
      return res.status(500).json({ ok: false, message: 'DB error' });
    }
    res.json({ ok: true, lotteries: rows });
  });
});

// ===================== ADMIN BULK EMAIL (Shopify customers) =====================
app.get('/admin/email', (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Forbidden');
  res.send(`
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <div style="max-width:900px;margin:24px auto;font:16px/1.45 Arial,sans-serif;color:#222">
      <h2 style="margin:0 0 12px">Bulk Email (Shopify Customers)</h2>
      <form method="POST" action="/admin/email">
        <input type="hidden" name="pass" value="${(req.query.pass || '')}">
        <div style="margin:12px 0">
          <label>Segment (language / locale short):</label>
          <input name="segment" placeholder="e.g. en, de, fr (leave blank for all)" style="padding:8px;width:240px">
        </div>
        <div style="margin:12px 0">
          <label>Subject</label><br>
          <input name="subject" required style="width:100%;padding:10px" placeholder="Your subject">
        </div>
        <div style="margin:12px 0">
          <label>HTML</label><br>
          <textarea name="html" required rows="14" style="width:100%;padding:10px;font-family:monospace"></textarea>
          <small style="color:#666;display:block">We’ll append the unsubscribe footer + add a List-Unsubscribe header.</small>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin:12px 0">
          <label>Max recipients (this run):
            <input type="number" name="limit" value="500" min="1" max="10000" style="width:120px;padding:8px">
          </label>
          <label>Start after customer ID:
            <input type="number" name="since_id" value="0" style="width:160px;padding:8px">
          </label>
          <label><input type="checkbox" name="dry" checked> Dry run (preview only)</label>
          <label>Test to (optional email):
            <input type="email" name="test_to" placeholder="you@example.com" style="width:220px;padding:8px">
          </label>
        </div>
        <button type="submit" style="padding:10px 16px;background:#111;color:#fff;border:0;border-radius:6px">Send</button>
      </form>
    </div>
  `);
});

async function fetchShopifyCustomers({ limit = 250, since_id = 0 } = {}) {
  const f = await ensureFetch();
  const shop = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_API_KEY;
  if (!shop || !token) throw new Error('SHOPIFY env missing');

  const url = `https://${shop}/admin/api/2024-07/customers.json?limit=${Math.min(+limit || 250, 250)}&since_id=${since_id}`;
  const r = await f(url, { method: 'GET', headers: { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' } });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Shopify customers fetch failed: ${r.status} ${txt}`);
  }
  const data = await r.json();
  return Array.isArray(data.customers) ? data.customers : [];
}

app.post('/admin/email', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).send('Forbidden');

    const subject = String(req.body.subject || '').trim();
    const html = String(req.body.html || '');
    const segment = String(req.body.segment || '').trim().toLowerCase();
    const dryRun = !!req.body.dry;
    const limit = Math.max(1, Math.min(10000, Number(req.body.limit || 500)));
    let since_id = Number(req.body.since_id || 0) || 0;
    const testTo = String(req.body.test_to || '').trim();

    if (!subject || !html) return res.status(400).send('Missing subject or html');

    if (testTo) {
      const email = normEmail(testTo);
      await mailer.sendMail({
        from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
        to: email,
        subject,
        html: withUnsubFooter(html, email),
        headers: { 'List-Unsubscribe': listUnsubHeader(email) }
      });
    }

    const toSend = [];
    while (toSend.length < limit) {
      const batch = await fetchShopifyCustomers({ limit: Math.min(250, limit - toSend.length), since_id });
      if (!batch.length) break;
      since_id = batch[batch.length - 1].id;
      for (const c of batch) {
        const email = normEmail(c.email);
        if (!email) continue;
        if (segment) {
          const loc = (c.locale || '').toLowerCase();
          if (!(loc === segment || (loc.split('-')[0] === segment))) continue;
        }
        toSend.push({ id: c.id, email, locale: (c.locale || 'en').toLowerCase() });
        if (toSend.length >= limit) break;
      }
    }

    if (dryRun) {
      return res.send(`
        <div style="font:14px Arial,sans-serif">
          <h3>Dry run — would send to ${toSend.length} customers</h3>
          <p>Next since_id to continue: <code>${since_id}</code></p>
          <pre style="white-space:pre-wrap">${toSend.slice(0, 50).map(x => `${x.id}  ${x.email}  (${x.locale})`).join('\n')}${toSend.length>50?'\n…':''}</pre>
        </div>
      `);
    }

    let sent = 0, skipped = 0, failed = 0;
    for (const cust of toSend) {
      if (await isUnsubscribed(cust.email)) { skipped++; continue; }
      try {
        await mailer.sendMail({
          from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
          to: cust.email,
          subject,
          html: withUnsubFooter(html, cust.email),
          headers: { 'List-Unsubscribe': listUnsubHeader(cust.email) }
        });
        sent++;
      } catch (e) {
        console.error('Bulk email error', cust.email, e);
        failed++;
      }
      await new Promise(r => setTimeout(r, 15));
    }

    res.send(`
      <div style="font:14px Arial,sans-serif">
        <h3>Bulk email done</h3>
        <p>Segment: <code>${segment || 'all'}</code></p>
        <p>Sent: ${sent}, Skipped (unsubscribed): ${skipped}, Failed: ${failed}</p>
        <p>Next since_id to continue: <code>${since_id}</code></p>
        <p><a href="/admin/email?pass=${encodeURIComponent(req.body.pass || '')}">Back</a></p>
      </div>
    `);
  } catch (err) {
    console.error('/admin/email error:', err);
    res.status(500).send('Server error');
  }
});

// --- PUBLIC: list current active lotteries ---
app.get('/lottery/current', (req, res) => {
  const sql = `
    SELECT productId, name, endAt
    FROM products
    WHERE endAt IS NULL OR datetime(endAt) > datetime('now')
    ORDER BY CASE WHEN endAt IS NULL OR endAt = '' THEN 1 ELSE 0 END, endAt
    LIMIT 10
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ ok: false, message: 'DB error' });
    res.json({ ok: true, lotteries: rows });
  });
});

// --- PUBLIC: fetch only one active lottery ---
app.get('/lottery/current/one', (req, res) => {
  const sql = `
    SELECT productId, name, endAt
    FROM products
    WHERE endAt IS NULL OR datetime(endAt) > datetime('now')
    ORDER BY CASE WHEN endAt IS NULL OR endAt = '' THEN 1 ELSE 0 END, endAt
    LIMIT 1
  `;
  db.get(sql, [], (err, row) => {
    if (err) return res.status(500).json({ ok: false, message: 'DB error' });
    res.json({ ok: true, lottery: row || null });
  });
});

// --- PUBLIC: get entry count for a product ---
app.get('/lottery/count/:productId', (req, res) => {
  const productId = req.params.productId;
  db.get(`SELECT COUNT(*) AS c FROM entries WHERE productId = ?`, [productId], (err, row) => {
    if (err) {
      console.error('SQL error /lottery/count:', err);
      return res.status(500).json({ success: false });
    }
    res.json({ success: true, totalEntries: row?.c || 0 });
  });
});

// ---------- Health checks ----------
app.get('/', (_req, res) => res.json({ ok: true, service: 'lottery+bis', version: 1 }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'lottery+bis', version: 1 }));

// ---------- Start server ----------
app.listen(port, host, () => {
  console.log(`✅ Lottery/BIS server listening on ${host}:${port}`);
});