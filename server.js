// server.js (Lottery – per product + Back-in-Stock multilingual, campaign-scoped)
// Email, admin page, Shopify eligibility, MX validation, dedupe, public "current" endpoints

const express   = require('express');
const cors      = require('cors');
const sqlite3   = require('sqlite3').verbose();
const nodemailer= require('nodemailer');
const dns       = require('dns').promises;
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

// ---------- SQLite DB (file) ----------
const dbPath = process.env.DB_PATH || 'lottery.db';
const db = new sqlite3.Database(dbPath);
console.log('DB path in use:', dbPath);

db.serialize(() => {
  // Each row in products = a lottery "campaign" for that productId
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,  -- campaignId
      productId INTEGER,                     -- Shopify product id (or handle if you prefer)
      name TEXT,
      startPrice REAL,
      increment REAL,
      endAt TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaignId INTEGER,  -- FK -> products.id
      productId INTEGER,   -- denormalized for convenience
      email TEXT,
      locale TEXT
    )
  `);

  // winners are stored per campaign
  db.run(`
    CREATE TABLE IF NOT EXISTS winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaignId INTEGER,     -- FK -> products.id
      productId INTEGER,      -- denormalized
      email TEXT,
      drawnAt TEXT
    )
  `);

  // Back-in-stock requests (multilingual)
  db.run(`
    CREATE TABLE IF NOT EXISTS bis_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId TEXT,
      email TEXT,
      locale TEXT,
      createdAt TEXT
    )
  `);

  // Uniques
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_unique ON entries (campaignId, email)`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bis_unique ON bis_requests (productId, email)`);
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
  } catch (_) {}
  try {
    const a = await withTimeout(dns.resolve(domain));
    if (Array.isArray(a) && a.length > 0) return true;
  } catch (_) {}
  return false;
}

function saveWinner(campaignId, productId, email) {
  return new Promise((resolve) => {
    db.run(
      `INSERT INTO winners (campaignId, productId, email, drawnAt) VALUES (?, ?, ?, datetime('now'))`,
      [campaignId, productId, email],
      (err) => {
        if (err) console.error('Failed to store winner:', err);
        resolve();
      }
    );
  });
}

function normLocale(loc){ return (loc ? String(loc) : 'en').toLowerCase(); }
function shortLocale(loc){ return normLocale(loc).split('-')[0]; }

// ------- Winner email i18n (same as your version) -------
function buildEmail(locale, title, claimLink) {
  const l = normLocale(locale), s = shortLocale(l);
  const t = {
    en:{subject:`You won: ${title}!`,hello:`🎉 Congratulations!`,body:`You’ve won the lottery for <strong>${title}</strong>.`,ctaLead:`Click below to claim your prize:`,cta:`Claim your prize`,reply:`Please reply to this email to claim your prize.`,copyHelp:`If the button doesn’t work, copy this link:`},
    de:{subject:`Sie haben gewonnen: ${title}!`,hello:`🎉 Herzlichen Glückwunsch!`,body:`Sie haben die Verlosung für <strong>${title}</strong> gewonnen.`,ctaLead:`Klicken Sie unten, um Ihren Gewinn einzulösen:`,cta:`Gewinn einlösen`,reply:`Bitte antworten Sie auf diese E-Mail, um Ihren Gewinn zu beanspruchen.`,copyHelp:`Falls die Schaltfläche nicht funktioniert, kopieren Sie diesen Link:`},
    // … (other languages unchanged from your file)
  };
  const pack = t[l] || t[s] || t.en;
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
      <h2>${pack.hello}</h2>
      <p>${pack.body}</p>
      ${ claimLink ? `
        <p>${pack.ctaLead}</p>
        <p><a href="${claimLink}" style="padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px">${pack.cta}</a></p>
        <p style="font-size:13px;color:#666">${pack.copyHelp}<br>${claimLink}</p>
      ` : `<p>${pack.reply}</p>`}
    </div>`;
  return { subject: pack.subject, html };
}

// ---------- BIS i18n (kept) ----------
const BIS_I18N = {
  subject:{ en:'Back in stock: {{title}}', de:'Wieder auf Lager: {{title}}', fr:'De retour en stock : {{title}}', es:'¡De vuelta en stock!: {{title}}', it:'Tornato disponibile: {{title}}', nl:'Terug op voorraad: {{title}}', da:'Tilbage på lager: {{title}}', sv:'Tillbaka i lager: {{title}}', nb:'Tilbake på lager: {{title}}', fi:'Täydennetty varastoon: {{title}}', cs:'Zpět na skladě: {{title}}', sk:'Opäť na sklade: {{title}}', sl:'Spet na zalogi: {{title}}', hu:'Újra készleten: {{title}}', ro:'Înapoi în stoc: {{title}}', pl:'Ponownie w magazynie: {{title}}', pt:'De volta ao estoque: {{title}}', bg:'Отново в наличност: {{title}}', el:'Ξανά διαθέσιμο: {{title}}', ru:'Снова в наличии: {{title}}', tr:'Yeniden stokta: {{title}}', vi:'Có hàng trở lại: {{title}}', ja:'再入荷：{{title}}', ko:'재입고: {{title}}', 'zh-cn':'现已到货：{{title}}', 'zh-tw':'現已到貨：{{title}}' },
  body:{
    en:(t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Good news — <strong>${t}</strong> is back in stock.</p><p><a href="${u}" style="padding:10px 14px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Shop now</a></p></div>`,
    de:(t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Gute Nachrichten — <strong>${t}</strong> ist wieder vorrätig.</p><p><a href="${u}" style="padding:10px 14px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Jetzt kaufen</a></p></div>`
    // … (others unchanged)
  }
};
function pickLoc(str,fallback='en'){ const s=(str||'').toLowerCase(); if(BIS_I18N.subject[s]) return s; const sh=s.split('-')[0]; return BIS_I18N.subject[sh]?sh:fallback; }
function sub(tpl,vars){ return tpl.replace(/{{\s*(\w+)\s*}}/g,(_,k)=> (vars[k] ?? '')); }

// ---------- CREATE a product lottery (campaign) ----------
app.post('/lottery/create', (req, res) => {
  let { productId, name, startPrice, increment, endAt } = req.body;
  if (productId == null || name == null || endAt == null || String(name).trim() === '') {
    return res.status(400).json({ success:false, message:'Missing fields' });
  }
  if (startPrice == null || startPrice === '') startPrice = 0;
  if (increment == null || increment === '') increment = 0;

  db.run(
    `INSERT INTO products (productId, name, startPrice, increment, endAt) VALUES (?, ?, ?, ?, ?)`,
    [productId, name, Number(startPrice), Number(increment), endAt],
    function(err){
      if (err) {
        console.error('Create lottery insert error:', err);
        return res.status(500).json({ success:false, message:'Server error' });
      }
      res.json({ success:true, productId, campaignId: this.lastID });
    }
  );
});

// Find active campaign for a productId
function getActiveCampaign(productId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM products
       WHERE productId = ?
         AND (endAt IS NULL OR endAt = '' OR datetime(endAt) > datetime('now'))
       ORDER BY
         CASE WHEN endAt IS NULL OR endAt = '' THEN 1 ELSE 0 END,
         endAt
       LIMIT 1`,
      [productId],
      (err, row) => err ? reject(err) : resolve(row)
    );
  });
}

// Find the most recent campaign for a productId (fallback for draw)
function getLatestCampaign(productId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM products WHERE productId = ? ORDER BY id DESC LIMIT 1`,
      [productId],
      (err, row) => err ? reject(err) : resolve(row)
    );
  });
}

// ---------- ENTER a lottery (with validation + Shopify order check) ----------
app.post('/lottery/enter', async (req, res) => {
  try {
    let { email, productId, locale } = req.body;
    if (!email || !productId) {
      return res.status(400).json({ success:false, message:'Missing email or productId' });
    }
    locale = normLocale(locale || 'en');
    email = String(email).trim().toLowerCase();

    if (!isValidEmailFormat(email)) {
      return res.status(400).json({ success:false, message:'Invalid email format' });
    }
    const deliverable = await isDeliverableEmail(email);
    if (!deliverable) {
      return res.status(400).json({ success:false, message:'Please enter a real email address' });
    }

    // Must have an active campaign for this productId
    const campaign = await getActiveCampaign(productId);
    if (!campaign) {
      return res.status(400).json({ success:false, message:'No active lottery for this product.' });
    }

    // Shopify purchase check (guarded)
    const shop  = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ADMIN_API_KEY;
    console.log('Shopify env check:', { shop: !!shop, token: token ? 'set' : 'missing' });

    if (!shop || !token) {
      return res.status(503).json({ success:false, message:'Eligibility check unavailable. Please try again later.' });
    }

    const shopifyUrl = `https://${shop}/admin/api/2025-01/orders.json?email=${encodeURIComponent(email)}&status=any&limit=1`;
    const resp = await fetch(shopifyUrl, { method:'GET', headers:{
      'X-Shopify-Access-Token': token, 'Content-Type':'application/json', 'Accept':'application/json'
    }});
    if (!resp.ok) {
      console.error('Shopify API error', resp.status, await resp.text());
      return res.status(503).json({ success:false, message:'Eligibility check unavailable. Please try again later.' });
    }
    const data = await resp.json();
    const hasOrder = Array.isArray(data.orders) && data.orders.length > 0;
    if (!hasOrder) {
      return res.status(200).json({ success:false, message:'Only customers with a past order can enter this lottery.' });
    }

    db.run(
      `INSERT INTO entries (campaignId, productId, email, locale) VALUES (?, ?, ?, ?)`,
      [campaign.id, campaign.productId, email, locale],
      function(err){
        if (err) {
          const msg = String(err).toLowerCase();
          if (msg.includes('unique')) {
            return res.status(200).json({ success:true, message:'You are already entered for this product.' });
          }
          console.error('DB insert error', err);
          return res.status(500).json({ success:false, message:'Server error' });
        }
        res.json({ success:true, message:'You have been entered into the lottery!', campaignId: campaign.id });
      }
    );
  } catch (e) {
    console.error('Enter handler error', e);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// ---------- DRAW a winner (per campaign) ----------
// POST /lottery/draw/:productId  (optionally ?campaignId=123 to target a specific campaign)
app.post('/lottery/draw/:productId', async (req, res) => {
  try {
    const productId = req.params.productId;
    const targetCampaignId = req.query.campaignId ? Number(req.query.campaignId) : null;

    const campaign = targetCampaignId
      ? await new Promise((resolve,reject)=> db.get(`SELECT * FROM products WHERE id = ?`, [targetCampaignId], (e,r)=> e?reject(e):resolve(r)))
      : await getLatestCampaign(productId);

    if (!campaign) {
      return res.status(400).json({ success:false, message:'No campaign found for this product.' });
    }

    db.all(`SELECT * FROM entries WHERE campaignId = ?`, [campaign.id], async (err, rows) => {
      if (err) return res.status(500).json({ success:false, message:'Server error' });
      if (!rows || rows.length === 0) {
        return res.status(400).json({ success:false, message:'No entries for this campaign yet.' });
      }

      const winner = rows[Math.floor(Math.random() * rows.length)];

      const title = campaign?.name || `Product ${campaign.productId}`;
      const claimPrefix = process.env.CLAIM_URL_PREFIX || '';
      const claimLink = claimPrefix ? `${claimPrefix}${campaign.productId}&email=${encodeURIComponent(winner.email)}` : null;

      try {
        await saveWinner(campaign.id, campaign.productId, winner.email);
        const { subject, html } = buildEmail(winner.locale || 'en', title, claimLink);

        await mailer.sendMail({
          from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
          to: winner.email,
          subject, html
        });

        return res.json({
          success:true,
          message:`Winner drawn and emailed for product ${campaign.productId} (campaign ${campaign.id})`,
          winner:{ email:winner.email, locale:winner.locale || 'en' },
          campaignId: campaign.id
        });
      } catch (errMail) {
        console.error('Email error:', errMail);
        return res.status(200).json({
          success:true,
          message:'Winner drawn. Email could not be sent.',
          emailed:false,
          winner:{ email:winner.email, locale:winner.locale || 'en' },
          campaignId: campaign.id
        });
      }
    });
  } catch (e) {
    console.error('Draw error', e);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// ---------- Back-in-Stock (BIS) endpoints ----------
app.post('/bis/subscribe', (req, res) => {
  let { email, productId, locale } = req.body || {};
  if (!email || !productId) {
    return res.status(400).json({ success:false, message:'Missing email or productId' });
  }
  email  = String(email).trim().toLowerCase();
  locale = normLocale(locale || 'en');

  if (!isValidEmailFormat(email)) {
    return res.status(400).json({ success:false, message:'Invalid email' });
  }

  db.run(
    `INSERT OR IGNORE INTO bis_requests (productId, email, locale, createdAt) VALUES (?, ?, ?, datetime('now'))`,
    [String(productId), email, locale],
    (err) => {
      if (err) {
        console.error('BIS insert error', err);
        return res.status(500).json({ success:false, message:'Server error' });
      }
      res.json({ success:true, message:'We’ll email you when it’s back.' });
    }
  );
});

// POST /bis/notify?pass=ADMIN_PASS  { productId, productTitle, productUrl, localeOverride? }
app.post('/bis/notify', async (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== process.env.ADMIN_PASS) {
    return res.status(403).json({ success:false, message:'Forbidden' });
  }
  const { productId, productTitle, productUrl, localeOverride } = req.body || {};
  if (!productId || !productTitle || !productUrl) {
    return res.status(400).json({ success:false, message:'Missing productId/productTitle/productUrl' });
  }

  db.all(`SELECT email, locale FROM bis_requests WHERE productId = ?`, [String(productId)], async (err, rows) => {
    if (err) {
      console.error('BIS select error', err);
      return res.status(500).json({ success:false, message:'DB error' });
    }
    if (!rows || !rows.length) return res.json({ success:true, sent:0, message:'No subscribers' });

    let sent=0, failed=0;
    for (const r of rows) {
      const loc = pickLoc(localeOverride || r.locale || 'en');
      const subj = sub(BIS_I18N.subject[loc] || BIS_I18N.subject.en, { title: productTitle });
      const html = (BIS_I18N.body[loc] || BIS_I18N.body.en)(productTitle, productUrl);
      try{
        await mailer.sendMail({ from:process.env.FROM_EMAIL || process.env.EMAIL_USER, to:r.email, subject:subj, html });
        sent++;
      }catch(e){ console.error('BIS mail error', r.email, e); failed++; }
    }
    db.run(`DELETE FROM bis_requests WHERE productId = ?`, [String(productId)]);
    res.json({ success:true, sent, failed });
  });
});

// --- ADMIN: List all entries (by campaign) ---
app.get('/admin/entries', (req, res) => {
  const pass = req.query.pass;
  if (pass !== process.env.ADMIN_PASS) return res.status(403).send('Forbidden: Wrong password');

  const sql = `
    SELECT e.campaignId, e.productId, e.email, e.locale, p.name, p.endAt
    FROM entries e
    LEFT JOIN products p ON p.id = e.campaignId
    ORDER BY e.campaignId, e.email
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).send('DB error');

    const counts = {};
    rows.forEach(r => { counts[r.campaignId] = (counts[r.campaignId] || 0) + 1; });

    let html = `<h2>Lottery Entries (by campaign)</h2>`;
    html += `<p>Total entries: ${rows.length}</p><ul>`;
    Object.keys(counts).forEach(cid => html += `<li>Campaign ${cid}: ${counts[cid]} entries</li>`);
    html += `</ul>`;
    html += `<table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>Campaign</th><th>Product ID</th><th>Email</th><th>Locale</th><th>Ends</th></tr>`;
    rows.forEach(r => { html += `<tr><td>${r.campaignId}</td><td>${r.productId}</td><td>${r.email}</td><td>${r.locale||''}</td><td>${r.endAt||''}</td></tr>`; });
    html += `</table>`;
    res.send(html);
  });
});

// --- ADMIN: repair entries (normalize + dedupe per campaign) ---
app.post('/admin/repair-entries', (req, res) => {
  const pass = req.query.pass;
  if (pass !== process.env.ADMIN_PASS) return res.status(403).json({ ok:false, message:'Forbidden' });
  db.serialize(() => {
    db.run(`UPDATE entries SET email = lower(trim(email))`);
    db.run(`
      DELETE FROM entries
      WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM entries GROUP BY campaignId, email
      )
    `);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_unique ON entries (campaignId, email)`);
  });
  res.json({ ok:true, repaired:true });
});

// --- ADMIN: list lotteries (per campaign, with last winner) ---
app.get('/admin/lotteries', (req, res) => {
  const pass = req.query.pass;
  if (pass !== process.env.ADMIN_PASS) return res.status(403).json({ ok:false, message:'Forbidden' });

  const sql = `
    WITH lastw AS (
      SELECT campaignId, MAX(drawnAt) AS lastDraw
      FROM winners
      GROUP BY campaignId
    )
    SELECT p.id AS campaignId, p.productId, p.name, p.endAt,
           COUNT(e.id) AS entries,
           w.email AS winnerEmail,
           lastw.lastDraw
    FROM products p
    LEFT JOIN entries e ON e.campaignId = p.id
    LEFT JOIN lastw ON lastw.campaignId = p.id
    LEFT JOIN winners w ON w.campaignId = p.id AND w.drawnAt = lastw.lastDraw
    GROUP BY p.id
    HAVING entries > 0
    ORDER BY
      CASE WHEN p.endAt IS NULL OR p.endAt = '' THEN 1 ELSE 0 END,
      p.endAt
  `;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('SQL error /admin/lotteries:', err);
      return res.status(500).json({ ok:false, message:'DB error' });
    }
    res.json({ ok:true, lotteries: rows });
  });
});

// --- PUBLIC: list current active lotteries (campaigns) ---
app.get('/lottery/current', (req, res) => {
  const sql = `
    SELECT id AS campaignId, productId, name, endAt
    FROM products
    WHERE endAt IS NULL OR datetime(endAt) > datetime('now')
    ORDER BY 
      CASE WHEN endAt IS NULL OR endAt = '' THEN 1 ELSE 0 END,
      endAt
    LIMIT 10
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ ok:false, message:'DB error' });
    res.json({ ok:true, lotteries: rows });
  });
});

// --- PUBLIC: fetch first active campaign ---
app.get('/lottery/current/one', (req, res) => {
  const sql = `
    SELECT id AS campaignId, productId, name, endAt
    FROM products
    WHERE endAt IS NULL OR datetime(endAt) > datetime('now')
    ORDER BY 
      CASE WHEN endAt IS NULL OR endAt = '' THEN 1 ELSE 0 END,
      endAt
    LIMIT 1
  `;
  db.get(sql, [], (err, row) => {
    if (err) return res.status(500).json({ ok:false, message:'DB error' });
    if (!row) return res.json({ ok:true, lottery:null });
    res.json({ ok:true, lottery: row });
  });
});

// --- PUBLIC: get entry count for the active campaign of a product ---
app.get('/lottery/count/:productId', async (req, res) => {
  try {
    const productId = req.params.productId;
    const campaign = await getActiveCampaign(productId);
    if (!campaign) return res.json({ success:true, totalEntries: 0 });
    db.get(
      `SELECT COUNT(*) AS c FROM entries WHERE campaignId = ?`,
      [campaign.id],
      (err, row) => {
        if (err) {
          console.error('SQL error /lottery/count:', err);
          return res.status(500).json({ success:false });
        }
        res.json({ success:true, totalEntries: row?.c || 0, campaignId: campaign.id });
      }
    );
  } catch(e) {
    console.error(e);
    res.status(500).json({ success:false });
  }
});

// ---------- Health checks ----------
app.get('/', (_req, res) => res.json({ ok:true, service:'lottery+bis', version:2 }));
app.get('/health', (_req, res) => res.json({ ok:true, service:'lottery+bis', version:2 }));

// ---------- Start server ----------
app.listen(port, () => {
  console.log(`✅ Lottery/BIS server running on http://localhost:${port}`);
});