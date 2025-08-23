// server.js (Lottery – per product + Back-in-Stock multilingual)
// Email, admin page, Shopify eligibility, MX validation, dedupe, public "current" endpoints

const express  = require('express');
const crypto = require('crypto');
const cors     = require('cors');
const sqlite3  = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const dns = require('dns').promises;
require('dotenv').config();

const app  = express();
const port = process.env.PORT || 3005;

app.use(express.json());
app.use(cors());
app.use(express.urlencoded({ extended: true })); // for <form> posts from /admin/email

// ---------- Email transporter ----------
const mailer = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT || 587),
  secure: String(process.env.EMAIL_PORT) === '465', // true if SSL (465)
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// GET /u?e=<email>&t=<token>
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

  db.run(
    `INSERT OR IGNORE INTO unsubscribes (email) VALUES (?)`,
    [email],
    (err) => {
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
    }
  );
});

// === ADMIN BROADCAST FROM SHOPIFY CUSTOMERS (HTML email, by language) ===
// Pulls subscribers from Shopify Customers (email marketing consent = subscribed)
// and optionally filters by short locale (de, fr, nl, ...).

function ensureAdmin(req, res) {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== process.env.ADMIN_PASS) {
    res.status(403).send('Forbidden: wrong password');
    return false;
  }
  return true;
}

async function shopifyGraphQL(query, variables = {}) {
  const shop = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_API_KEY;
  if (!shop || !token) throw new Error('Missing SHOPIFY_STORE or SHOPIFY_ADMIN_API_KEY');

  const resp = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
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

// Pull ALL customers with marketing consent = subscribed
// Returns [{email, short_locale}]
async function fetchAllSubscribedCustomersFromShopify() {
  const out = [];
  let cursor = null;
  const q = `
    query Customers($cursor: String) {
      customers(
        first: 250,
        after: $cursor,
        query: "email_marketing_consent:subscribed"
      ) {
        edges {
          cursor
          node {
            email
            locale
            emailMarketingConsent { state }
          }
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
      const email = String(n.email).trim().toLowerCase();
      const loc = (n.locale || '').toLowerCase();
      const short = loc.includes('-') ? loc.split('-')[0] : loc;
      out.push({ email, short_locale: short || '' });
    }
    if (!data?.customers?.pageInfo?.hasNextPage) break;
    cursor = edges[edges.length - 1]?.cursor || null;
    if (!cursor) break;
  }
  // Dedupe by email
  const seen = new Set();
  const deduped = [];
  for (const r of out) {
    if (seen.has(r.email)) continue;
    seen.add(r.email);
    deduped.push(r);
  }
  return deduped;
}

// Small locale histogram to show counts on the form
async function buildShopifyLocaleCounts() {
  const rows = await fetchAllSubscribedCustomersFromShopify();
  const map = {};
  for (const r of rows) {
    const k = r.short_locale || 'en';
    map[k] = (map[k] || 0) + 1;
  }
  return { rows, counts: map };
}

// Broadcast form (Shopify source)
app.get('/admin/broadcast-shopify', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    const { rows, counts } = await buildShopifyLocaleCounts();
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

          <div class="row right">
            <button type="submit" class="btn-primary">Go</button>
          </div>
        </form>
      </div>
    `);
  } catch (e) {
    console.error('broadcast-shopify form error', e);
    res.status(500).send('Server error');
  }
});

// Send from Shopify audience
app.post('/admin/broadcast-shopify/send', async (req, res) => {
  if (!ensureAdmin(req, res)) return;

  try {
    let { subject, html, segment, test_only, max_send } = req.body || {};
    subject  = String(subject || '').trim();
    html     = String(html || '').trim();
    segment  = String(segment || 'all').toLowerCase();
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
          html
        }).then(() => { sent++; }).catch(err => { failed++; console.error('shopify broadcast error', r.email, err); })
      );
      await Promise.allSettled(jobs);
      await new Promise(r => setTimeout(r, 600)); // small pause
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

  // Unsubscribed email addresses
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
  CREATE TABLE IF NOT EXISTS unsubscribes (
    email TEXT PRIMARY KEY,
    createdAt TEXT DEFAULT (datetime('now'))
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

  // --- Light migration: ensure entries.locale column exists (ignore error if already there)
  db.run(`ALTER TABLE entries ADD COLUMN locale TEXT`, (err) => {
    if (err && !String(err.message || err).toLowerCase().includes('duplicate column name')) {
      console.warn('ALTER TABLE entries ADD COLUMN locale warning:', err.message || err);
    }
  });

  // Store winners so admin UI can display them later
  db.run(`
    CREATE TABLE IF NOT EXISTS winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      productId INTEGER,
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
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bis_unique ON bis_requests (productId, email)`);

  // Prevent duplicate entries (same product, same email)
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_unique ON entries (productId, email)`);
});

// ---------- Helpers ----------
const BLOCKED_EMAIL_DOMAINS = (process.env.BLOCKED_EMAIL_DOMAINS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// ---- Bulk mail helpers ----
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `https://lottery-server-wsg0.onrender.com`;

// normalize email safely
function normEmail(e){ return String(e||'').trim().toLowerCase() || null; }

// check unsubscribe table (returns true if unsubscribed)
function isUnsubscribed(email){
  return new Promise((resolve)=>{
    db.get(`SELECT 1 FROM unsubscribes WHERE email = ? LIMIT 1`, [email], (err,row)=>{
      if (err){ console.warn('unsub check err', err); return resolve(false); }
      resolve(!!row);
    });
  });
}

// add a simple footer with per-recipient link
function withUnsubFooter(html, email){
  const link = `${PUBLIC_BASE_URL}/unsubscribe?e=${encodeURIComponent(email)}`;
  const footer = `
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
    <p style="font:14px/1.4 Arial,sans-serif;color:#666">
      You’re receiving this because you subscribed at our store.
      <a href="${link}">Unsubscribe</a>
    </p>`;
  return String(html||'') + footer;
}

// RFC header so clients (Gmail/Apple Mail) show native “Unsubscribe”
function listUnsubHeader(email){
  const link = `${PUBLIC_BASE_URL}/unsubscribe?e=${encodeURIComponent(email)}`;
  return `<${link}>`;
}

// Fetch customers from Shopify Admin REST (email, locale, accepts_marketing)
// Requires env: SHOPIFY_STORE, SHOPIFY_ADMIN_API_KEY
async function fetchShopifyCustomers({ locales = [], limitMax = 50000 } = {}){
  const shop  = process.env.SHOPIFY_STORE;         // e.g. smelltoimpress.myshopify.com
  const token = process.env.SHOPIFY_ADMIN_API_KEY; // private Admin token

  if (!shop || !token) throw new Error('Shopify env missing');

  const base = `https://${shop}/admin/api/2024-10/customers.json?limit=250&fields=email,locale,accepts_marketing`;
  let url = base;
  const all = [];
  let safety = 0;

  while (url && all.length < limitMax && safety < 1000){
    const r = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Accept': 'application/json'
      }
    });
    if (!r.ok){
      const txt = await r.text();
      throw new Error(`Shopify ${r.status}: ${txt}`);
    }
    const data = await r.json();
    const page = Array.isArray(data.customers) ? data.customers : [];

    for (const c of page){
      if (!c?.email) continue;
      if (c.accepts_marketing === false) continue; // respect Shopify opt-out
      if (locales.length){
        const lc = (c.locale || '').toLowerCase();
        const short = lc.split('-')[0];
        if (!locales.includes(lc) && !locales.includes(short)) continue;
      }
      all.push({ email: c.email, locale: (c.locale || 'en').toLowerCase() });
      if (all.length >= limitMax) break;
    }

    // parse Link header for cursor pagination
    const link = r.headers.get('link') || r.headers.get('Link');
    const m = link && link.split(',').find(p => /rel="?next"?/.test(p));
    if (m){
      const u = (m.match(/<([^>]+)>/) || [])[1];
      url = u || null;
    } else {
      url = null;
    }
    safety++;
  }
  return all;
}

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

// Store winner helper
function saveWinner(productId, email) {
  return new Promise((resolve) => {
    db.run(
      `INSERT INTO winners (productId, email, drawnAt) VALUES (?, ?, datetime('now'))`,
      [productId, email],
      (errW) => {
        if (errW) console.error('Failed to store winner:', errW);
        resolve(); // don't block response
      }
    );
  });
}

// Normalize locale key
function normLocale(loc) {
  if (!loc) return 'en';
  return String(loc).toLowerCase();
}
function shortLocale(loc) {
  const n = normLocale(loc);
  return n.split('-')[0];
}

// Build i18n email (subject + html) for lottery winners
function buildEmail(locale, title, claimLink) {
  const l = normLocale(locale);
  const s = shortLocale(l);

  const t = {
    en: {
      subject: `You won: ${title}!`,
      hello: `🎉 Congratulations!`,
      body: `You’ve won the lottery for <strong>${title}</strong>.`,
      ctaLead: `Click below to claim your prize:`,
      cta: `Claim your prize`,
      reply: `Please reply to this email to claim your prize.`,
      copyHelp: `If the button doesn’t work, copy this link:`
    },
    de: {
      subject: `Sie haben gewonnen: ${title}!`,
      hello: `🎉 Herzlichen Glückwunsch!`,
      body: `Sie haben die Verlosung für <strong>${title}</strong> gewonnen.`,
      ctaLead: `Klicken Sie unten, um Ihren Gewinn einzulösen:`,
      cta: `Gewinn einlösen`,
      reply: `Bitte antworten Sie auf diese E-Mail, um Ihren Gewinn zu beanspruchen.`,
      copyHelp: `Falls die Schaltfläche nicht funktioniert, kopieren Sie diesen Link:`
    },
    fr: {
      subject: `Vous avez gagné : ${title} !`,
      hello: `🎉 Félicitations !`,
      body: `Vous avez remporté la loterie pour <strong>${title}</strong>.`,
      ctaLead: `Cliquez ci-dessous pour récupérer votre lot :`,
      cta: `Récupérer mon lot`,
      reply: `Veuillez répondre à cet e-mail pour récupérer votre lot.`,
      copyHelp: `Si le bouton ne fonctionne pas, copiez ce lien :`
    },
    es: {
      subject: `¡Has ganado: ${title}!`,
      hello: `🎉 ¡Enhorabuena!`,
      body: `Has ganado la lotería de <strong>${title}</strong>.`,
      ctaLead: `Haz clic abajo para reclamar tu premio:`,
      cta: `Reclamar premio`,
      reply: `Responde a este correo para reclamar tu premio.`,
      copyHelp: `Si el botón no funciona, copia este enlace:`
    },
    it: {
      subject: `Hai vinto: ${title}!`,
      hello: `🎉 Congratulazioni!`,
      body: `Hai vinto la lotteria per <strong>${title}</strong>.`,
      ctaLead: `Clicca qui sotto per riscattare il premio:`,
      cta: `Riscatta il premio`,
      reply: `Rispondi a questa email per riscattare il premio.`,
      copyHelp: `Se il pulsante non funziona, copia questo link:`
    },
    nl: {
      subject: `Je hebt gewonnen: ${title}!`,
      hello: `🎉 Gefeliciteerd!`,
      body: `Je hebt de loterij voor <strong>${title}</strong> gewonnen.`,
      ctaLead: `Klik hieronder om je prijs te claimen:`,
      cta: `Prijs claimen`,
      reply: `Beantwoord deze e-mail om je prijs te claimen.`,
      copyHelp: `Werkt de knop niet? Kopieer deze link:`
    },
    da: {
      subject: `Du har vundet: ${title}!`,
      hello: `🎉 Tillykke!`,
      body: `Du har vundet lodtrækningen om <strong>${title}</strong>.`,
      ctaLead: `Klik herunder for at få din præmie:`,
      cta: `Hent præmien`,
      reply: `Svar på denne e-mail for at få din præmie.`,
      copyHelp: `Hvis knappen ikke virker, så kopier dette link:`
    },
    sv: {
      subject: `Du har vunnit: ${title}!`,
      hello: `🎉 Grattis!`,
      body: `Du har vunnit lotteriet för <strong>${title}</strong>.`,
      ctaLead: `Klicka nedan för att hämta ditt pris:`,
      cta: `Hämta priset`,
      reply: `Svara på detta mejl för att hämta ditt pris.`,
      copyHelp: `Om knappen inte fungerar, kopiera denna länk:`
    },
    nb: {
      subject: `Du har vunnet: ${title}!`,
      hello: `🎉 Gratulerer!`,
      body: `Du har vunnet lotteriet for <strong>${title}</strong>.`,
      ctaLead: `Klikk nedenfor for å hente premien:`,
      cta: `Hent premien`,
      reply: `Svar på denne e-posten for å hente premien.`,
      copyHelp: `Hvis knappen ikke fungerer, kopier denne lenken:`
    },
    fi: {
      subject: `Voitit: ${title}!`,
      hello: `🎉 Onnittelut!`,
      body: `Voitit arvonnassa tuotteen <strong>${title}</strong>.`,
      ctaLead: `Napsauta alta lunastaaksesi palkinnon:`,
      cta: `Lunasta palkinto`,
      reply: `Vastaa tähän sähköpostiin lunastaaksesi palkinnon.`,
      copyHelp: `Ellei painike toimi, kopioi tämä linkki:`
    },
    pl: {
      subject: `Wygrałeś/Wygrałaś: ${title}!`,
      hello: `🎉 Gratulacje!`,
      body: `Wygrałeś/Wygrałaś losowanie <strong>${title}</strong>.`,
      ctaLead: `Kliknij poniżej, aby odebrać nagrodę:`,
      cta: `Odbierz nagrodę`,
      reply: `Odpowiedz na tę wiadomość, aby odebrać nagrodę.`,
      copyHelp: `Jeśli przycisk nie działa, skopiuj ten link:`
    },
    pt: {
      subject: `Você ganhou: ${title}!`,
      hello: `🎉 Parabéns!`,
      body: `Você ganhou o sorteio de <strong>${title}</strong>.`,
      ctaLead: `Clique abaixo para resgatar o prêmio:`,
      cta: `Resgatar prêmio`,
      reply: `Responda a este e-mail para resgatar seu prêmio.`,
      copyHelp: `Se o botão não funcionar, copie este link:`
    },
    cs: {
      subject: `Vyhráli jste: ${title}!`,
      hello: `🎉 Gratulujeme!`,
      body: `Vyhráli jste v loterii o <strong>${title}</strong>.`,
      ctaLead: `Klikněte níže pro převzetí výhry:`,
      cta: `Vyžádat výhru`,
      reply: `Odpovězte na tento e-mail pro převzetí výhry.`,
      copyHelp: `Pokud tlačítko nefunguje, zkopírujte tento odkaz:`
    },
    sk: {
      subject: `Vyhrali ste: ${title}!`,
      hello: `🎉 Gratulujeme!`,
      body: `Vyhrali ste v lotérii o <strong>${title}</strong>.`,
      ctaLead: `Kliknite nižšie a vyzdvihnite si výhru:`,
      cta: `Vyzdvihnúť výhru`,
      reply: `Odpovedzte na tento e-mail, aby ste získali výhru.`,
      copyHelp: `Ak tlačidlo nefunguje, skopírujte tento odkaz:`
    },
    sl: {
      subject: `Zmagali ste: ${title}!`,
      hello: `🎉 Čestitke!`,
      body: `Zmagali ste v žrebanju za <strong>${title}</strong>.`,
      ctaLead: `Kliknite spodaj za prevzem nagrade:`,
      cta: `Prevzemi nagrado`,
      reply: `Odgovorite na to e-pošto za prevzem nagrade.`,
      copyHelp: `Če gumb ne deluje, kopirajte to povezavo:`
    },
    ro: {
      subject: `Ai câștigat: ${title}!`,
      hello: `🎉 Felicitări!`,
      body: `Ai câștigat loteria pentru <strong>${title}</strong>.`,
      ctaLead: `Apasă mai jos pentru a-ți revendica premiul:`,
      cta: `Revendică premiul`,
      reply: `Răspunde la acest e-mail pentru a-ți revendica premiul.`,
      copyHelp: `Dacă butonul nu funcționează, copiază acest link:`
    },
    hu: {
      subject: `Nyertél: ${title}!`,
      hello: `🎉 Gratulálunk!`,
      body: `Megnyerted a <strong>${title}</strong> sorsolását.`,
      ctaLead: `Kattints lentebb a nyereményed átvételéhez:`,
      cta: `Nyeremény átvétele`,
      reply: `Válaszolj erre az e-mailre a nyereményed átvételéhez.`,
      copyHelp: `Ha a gomb nem működik, másold ezt a hivatkozást:`
    },
    bg: {
      subject: `Спечелихте: ${title}!`,
      hello: `🎉 Поздравления!`,
      body: `Вие спечелихте томболата за <strong>${title}</strong>.`,
      ctaLead: `Кликнете по-долу, за да получите наградата:`,
      cta: `Вземете наградата`,
      reply: `Отговорете на този имейл, за да получите наградата.`,
      copyHelp: `Ако бутонът не работи, копирайте този линк:`
    },
    el: {
      subject: `Κερδίσατε: ${title}!`,
      hello: `🎉 Συγχαρητήρια!`,
      body: `Κερδίσατε την κλήρωση για <strong>${title}</strong>.`,
      ctaLead: `Κάντε κλικ παρακάτω για να παραλάβετε το έπαθλο:`,
      cta: `Παραλαβή επάθλου`,
      reply: `Απαντήστε σε αυτό το email για να παραλάβετε το έπαθλο.`,
      copyHelp: `Αν δεν λειτουργεί το κουμπί, αντιγράψτε αυτόν τον σύνδεσμο:`
    },
    tr: {
      subject: `Kazandınız: ${title}!`,
      hello: `🎉 Tebrikler!`,
      body: `<strong>${title}</strong> çekilişini kazandınız.`,
      ctaLead: `Ödülünüzü almak için aşağıya tıklayın:`,
      cta: `Ödülü al`,
      reply: `Ödülünüzü almak için bu e-postayı yanıtlayın.`,
      copyHelp: `Düğme çalışmazsa bu bağlantıyı kopyalayın:`
    },
    ru: {
      subject: `Вы выиграли: ${title}!`,
      hello: `🎉 Поздравляем!`,
      body: `Вы выиграли розыгрыш <strong>${title}</strong>.`,
      ctaLead: `Нажмите ниже, чтобы получить приз:`,
      cta: `Получить приз`,
      reply: `Ответьте на это письмо, чтобы получить приз.`,
      copyHelp: `Если кнопка не работает, скопируйте эту ссылку:`
    },
    ja: {
      subject: `当選しました：${title}！`,
      hello: `🎉 おめでとうございます！`,
      body: `<strong>${title}</strong> の抽選に当選しました。`,
      ctaLead: `賞品の受け取りは以下をクリック：`,
      cta: `賞品を受け取る`,
      reply: `このメールに返信して賞品を受け取ってください。`,
      copyHelp: `ボタンが動作しない場合は、このリンクをコピーしてください：`
    },
    ko: {
      subject: `당첨을 축하드립니다: ${title}!`,
      hello: `🎉 축하합니다!`,
      body: `<strong>${title}</strong> 추첨에 당첨되셨습니다.`,
      ctaLead: `아래를 클릭해 상품을 수령하세요:`,
      cta: `상품 수령하기`,
      reply: `이 이메일에 회신하여 상품을 수령하세요.`,
      copyHelp: `버튼이 작동하지 않으면 이 링크를 복사하세요:`
    },
    'zh-cn': {
      subject: `您已中奖：${title}！`,
      hello: `🎉 恭喜！`,
      body: `您已中签 <strong>${title}</strong> 抽奖活动。`,
      ctaLead: `点击下方领取奖品：`,
      cta: `领取奖品`,
      reply: `请回复此邮件以领取奖品。`,
      copyHelp: `如果按钮无效，请复制此链接：`
    },
    'zh-tw': {
      subject: `您中獎了：${title}！`,
      hello: `🎉 恭喜！`,
      body: `您已中籤 <strong>${title}</strong> 抽獎活動。`,
      ctaLead: `點擊下方領取獎品：`,
      cta: `領取獎品`,
      reply: `請回覆此郵件以領取獎品。`,
      copyHelp: `如果按鈕無法使用，請複製此連結：`
    },
    vi: {
      subject: `Bạn đã trúng thưởng: ${title}!`,
      hello: `🎉 Chúc mừng!`,
      body: `Bạn đã trúng xổ số cho <strong>${title}</strong>.`,
      ctaLead: `Nhấn bên dưới để nhận phần thưởng:`,
      cta: `Nhận phần thưởng`,
      reply: `Hãy trả lời email này để nhận phần thưởng.`,
      copyHelp: `Nếu nút không hoạt động, hãy sao chép liên kết này:`
    },
    lt: {
      subject: `Jūs laimėjote: ${title}!`,
      hello: `🎉 Sveikiname!`,
      body: `Laimėjote loteriją dėl <strong>${title}</strong>.`,
      ctaLead: `Spustelėkite žemiau, kad atsiimtumėte prizą:`,
      cta: `Atsiimti prizą`,
      reply: `Atsakykite į šį el. laišką, kad atsiimtumėte prizą.`,
      copyHelp: `Jei mygtukas neveikia, nukopijuokite šią nuorodą:`
    },
    hr: {
      subject: `Pobijedili ste: ${title}!`,
      hello: `🎉 Čestitamo!`,
      body: `Pobijedili ste na nagradnoj igri za <strong>${title}</strong>.`,
      ctaLead: `Kliknite dolje za preuzimanje nagrade:`,
      cta: `Preuzmi nagradu`,
      reply: `Odgovorite na ovaj e-mail kako biste preuzeli nagradu.`,
      copyHelp: `Ako gumb ne radi, kopirajte ovu poveznicu:`
    }
  };

  const pack = t[l] || t[s] || t.en;

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
      <h2>${pack.hello}</h2>
      <p>${pack.body}</p>
      ${
        claimLink
          ? `
            <p>${pack.ctaLead}</p>
            <p><a href="${claimLink}" style="padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px">
              ${pack.cta}
            </a></p>
            <p style="font-size:13px;color:#666">${pack.copyHelp}<br>${claimLink}</p>
          `
          : `<p>${pack.reply}</p>`
      }
    </div>
  `;

  return { subject: pack.subject, html };
}
// --- Entry confirmation email (multi-language) ---
function buildEntryConfirmEmail(locale, title) {
  const l = normLocale(locale);
  const s = shortLocale(l);

  const t = {
    en: {
      subject: `You're in: ${title}`,
      body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
               <p>Thanks—your entry for <strong>${title}</strong> is confirmed.</p>
               <p>We’ll draw at the deadline and email the winner.</p>
             </div>`
    },
    de: {
      subject: `Sie sind dabei: ${title}`,
      body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
               <p>Danke – Ihre Teilnahme für <strong>${title}</strong> wurde bestätigt.</p>
               <p>Wir losen zum Stichtag aus und benachrichtigen den Gewinner per E-Mail.</p>
             </div>`
    },
    fr: {
      subject: `Participation confirmée : ${title}`,
      body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
               <p>Merci — votre participation pour <strong>${title}</strong> est confirmée.</p>
               <p>Nous tirerons au sort à l’échéance et préviendrons le gagnant par e-mail.</p>
             </div>`
    },
    nl: {
      subject: `Je doet mee: ${title}`,
      body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
               <p>Bedankt — je inschrijving voor <strong>${title}</strong> is bevestigd.</p>
               <p>We loten op de einddatum en mailen de winnaar.</p>
             </div>`
    },
    es: {
      subject: `Estás dentro: ${title}`,
      body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
               <p>Gracias — tu participación en <strong>${title}</strong> está confirmada.</p>
               <p>Haremos el sorteo en la fecha límite y enviaremos un correo al ganador.</p>
             </div>`
    },
    it: {
      subject: `Sei dentro: ${title}`,
      body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
               <p>Grazie — la tua partecipazione a <strong>${title}</strong> è confermata.</p>
               <p>Eseguiremo l’estrazione alla scadenza e invieremo un’e-mail al vincitore.</p>
             </div>`
    },
    ja: {
      subject: `参加が確定しました：${title}`,
      body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
               <p>ご応募ありがとうございます。<strong>${title}</strong> への参加が確認されました。</p>
               <p>締め切り後に抽選を行い、当選者にメールでご連絡します。</p>
             </div>`
    },
    ko: {
      subject: `참여가 완료되었습니다: ${title}`,
      body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
               <p>감사합니다. <strong>${title}</strong> 응모가 확인되었습니다.</p>
               <p>마감 후 추첨하여 당첨자에게 이메일로 안내드립니다.</p>
             </div>`
    },
    pl: {
      subject: `Zgłoszenie przyjęte: ${title}`,
      body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
               <p>Dziękujemy — Twoje zgłoszenie do <strong>${title}</strong> zostało potwierdzone.</p>
               <p>Losowanie odbędzie się w terminie końcowym, a zwycięzca otrzyma e-mail.</p>
             </div>`
    },
    ro: {
      subject: `Ești înscris: ${title}`,
      body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
               <p>Mulțumim — înscrierea ta pentru <strong>${title}</strong> a fost confirmată.</p>
               <p>Vom face tragerea la sorți la termen și îl vom anunța pe câștigător prin e-mail.</p>
             </div>`
    },
    bg: {
      subject: `Участието ви е потвърдено: ${title}`,
      body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
               <p>Благодарим — участието ви за <strong>${title}</strong> е потвърдено.</p>
               <p>Жребият ще бъде изтеглен на крайния срок и победителят ще получи имейл.</p>
             </div>`
    },
    ar: {
      subject: `تم تأكيد مشاركتك: ${title}`,
      body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333;direction:rtl;text-align:right">
               <p>شكرًا لك — تم تأكيد مشاركتك في <strong>${title}</strong>.</p>
               <p>سنُجري السحب عند موعد الإغلاق ونرسل رسالة إلى الفائز عبر البريد الإلكتروني.</p>
             </div>`
    },
    he: {
      subject: `ההרשמה שלך אושרה: ${title}`,
      body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333;direction:rtl;text-align:right">
               <p>תודה — ההשתתפות שלך ב־<strong>${title}</strong> אושרה.</p>
               <p>נבצע את ההגרלה במועד הסיום ונעדכן את הזוכה במייל.</p>
             </div>`
    },
    sv: {
      subject: `Du är med: ${title}`,
      body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
               <p>Tack — din anmälan till <strong>${title}</strong> är bekräftad.</p>
               <p>Vi drar en vinnare vid sista datumet och mejlar vinnaren.</p>
             </div>`
    },
    nb: {
      subject: `Du er med: ${title}`,
      body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
               <p>Takk — påmeldingen din til <strong>${title}</strong> er bekreftet.</p>
               <p>Vi trekker en vinner ved fristen og sender e-post til vinneren.</p>
             </div>`
    },
    fi: {
      subject: `Olet mukana: ${title}`,
      body: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
               <p>Kiitos — osallistumisesi kohteeseen <strong>${title}</strong> on vahvistettu.</p>
               <p>Arvonta suoritetaan määräaikana ja voittajalle lähetetään sähköposti.</p>
             </div>`
    }
  };

  const pack = t[l] || t[s] || t.en;
  return { subject: pack.subject, html: pack.body };
}
// ---------- Back-in-Stock (BIS) translations & helpers ----------
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
    de: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Gute Nachrichten — <strong>${t}</strong> ist wieder vorrätig.</p><p><a href="${u}" style="padding:10px 14px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Jetzt kaufen</a></p></div>`,
    fr: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Bonne nouvelle — <strong>${t}</strong> est de retour en stock.</p><p><a href="${u}" style="padding:10px 14px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Je commande</a></p></div>`,
    es: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Buenas noticias: <strong>${t}</strong> está de vuelta.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">Comprar ahora</a></p></div>`,
    it: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Buone notizie — <strong>${t}</strong> è di nuovo disponibile.</p><p><a href="${u}" style="padding:10px 14px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Acquista ora</a></p></div>`,
    nl: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Goed nieuws — <strong>${t}</strong> is weer op voorraad.</p><p><a href="${u}" style="padding:10px 14px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Nu shoppen</a></p></div>`,
    da: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Gode nyheder — <strong>${t}</strong> er tilbage på lager.</p><p><a href="${u}" style="padding:10px 14px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Køb nu</a></p></div>`,
    sv: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Goda nyheter — <strong>${t}</strong> är tillbaka i lager.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">Handla nu</a></p></div>`,
    nb: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Godt nytt — <strong>${t}</strong> er tilbake på lager.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">Kjøp nå</a></p></div>`,
    fi: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Hyviä uutisia — <strong>${t}</strong> on taas varastossa.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">Osta nyt</a></p></div>`,
    cs: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Skvělé zprávy — <strong>${t}</strong> je opět skladem.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">Koupit nyní</a></p></div>`,
    sk: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Skvelá správa — <strong>${t}</strong> je opäť na sklade.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">Kúpiť teraz</a></p></div>`,
    sl: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Dobre novice — <strong>${t}</strong> je spet na zalogi.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">Nakupuj zdaj</a></p></div>`,
    hu: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Jó hír — <strong>${t}</strong> újra készleten van.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">Vásárlás</a></p></div>`,
    ro: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Veste bună — <strong>${t}</strong> este din nou în stoc.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">Cumpără acum</a></p></div>`,
    pl: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Dobra wiadomość — <strong>${t}</strong> znów jest dostępny.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">Kup teraz</a></p></div>`,
    pt: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Boa notícia — <strong>${t}</strong> está de volta ao estoque.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">Comprar agora</a></p></div>`,
    bg: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Добра новина — <strong>${t}</strong> отново е наличен.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">Купи сега</a></p></div>`,
    el: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Καλά νέα — το <strong>${t}</strong> είναι ξανά διαθέσιμο.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">Αγορά τώρα</a></p></div>`,
    ru: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Отличная новость — <strong>${t}</strong> снова в наличии.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">Купить</a></p></div>`,
    tr: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Harika haber — <strong>${t}</strong> yeniden stokta.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">Hemen al</a></p></div>`,
    vi: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>Tin vui — <strong>${t}</strong> đã có hàng trở lại.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">Mua ngay</a></p></div>`,
    ja: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>朗報です。<strong>${t}</strong> が再入荷しました。</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">今すぐ購入</a></p></div>`,
    ko: (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>좋은 소식 — <strong>${t}</strong> 가 재입고되었습니다.</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">지금 구매</a></p></div>`,
    'zh-cn': (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>好消息 — <strong>${t}</strong> 现已到货。</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">立即购买</a></p></div>`,
    'zh-tw': (t,u)=>`<div style="font-family:Arial,sans-serif;font-size:16px;color:#333"><p>好消息 — <strong>${t}</strong> 現已到貨。</p><p><a href="${u}" style="padding:10px 14px	background:#111;color:#fff;text-decoration:none;border-radius:6px">立即購買</a></p></div>`
  }
};
function pickLoc(str, fallback='en') {
  const s = (str || '').toLowerCase();
  if (BIS_I18N.subject[s]) return s;
  const short = s.split('-')[0];
  return BIS_I18N.subject[short] ? short : fallback;
}
function sub(tpl, vars){ return tpl.replace(/{{\s*(\w+)\s*}}/g, (_,k)=> (vars[k] ?? '')); }

// ===== Unsubscribe helpers =====
const crypto = require('crypto');

function normEmail(e){ return String(e || '').trim().toLowerCase(); }

const UNSUB_SECRET = process.env.UNSUB_SECRET || 'change-me'; // one consistent name

function signUnsub(email) {
  return crypto
    .createHmac('sha256', UNSUB_SECRET)
    .update(normEmail(email))
    .digest('hex')
    .slice(0, 32); // short but strong
}

function buildUnsubLink(email) {
  const base =
    (process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.replace(/\/+$/,'')) ||
    `http://localhost:${process.env.PORT || 3005}`;
  const t = signUnsub(email);
  return `${base}/u?e=${encodeURIComponent(normEmail(email))}&t=${t}`;
}

function verifyUnsub(email, token) {
  if (!token) return false;
  try {
    const expected = signUnsub(email);
    // constant-time compare
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(token)));
  } catch {
    return false;
  }
}

function isUnsubscribed(email) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT 1 FROM unsubscribes WHERE email = ? LIMIT 1`,
      [normEmail(email)],
      (err, row) => {
        if (err) return reject(err);
        resolve(!!row);
      }
    );
  });
}

// Inject CAN-SPAM footer + List-Unsubscribe link
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
  return (html || '') + footer;
}

// RFC List-Unsubscribe header for mailbox providers
function listUnsubHeader(email) {
  const httpLink = buildUnsubLink(email);
  const mailto = (process.env.UNSUBSCRIBE_MAILTO || '').trim(); // e.g. unsubscribe@yourdomain.com
  return mailto
    ? `<mailto:${mailto}>, <${httpLink}>`
    : `<${httpLink}>`;
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
     VALUES (?, ?, ?, ?, ?)` ,
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
    let { email, productId, locale } = req.body;
    if (!email || !productId) {
      return res.status(400).json({ success: false, message: 'Missing email or productId' });
    }

    // defaults + normalize
    locale = normLocale(locale || 'en');
    email  = String(email).trim().toLowerCase();

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
      `INSERT INTO entries (productId, email, locale) VALUES (?, ?, ?)`,
      [productId, email, locale],
      function (err) {
        if (err) {
          if (String(err).toLowerCase().includes('unique')) {
            // Already entered — still send a friendly OK
            return res.status(200).json({ success: true, message: 'You are already entered for this product.' });
          }
          console.error('DB insert error', err);
          return res.status(500).json({ success: false, message: 'Server error' });
        }

        // Fire-and-forget: fetch product title and email the confirmation.
        // This does NOT delay the API response.
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
              console.warn('Entry confirmation email failed (non-blocking):', mailErr?.message || mailErr);
            }
          });
        } catch (e) {
          console.warn('Post-insert confirm mail scheduling failed:', e?.message || e);
        }

        // Immediate API reply
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

      try {
        // Always store the winner, regardless of email outcome
        await saveWinner(productId, winner.email);

        // Localized subject + body
        const { subject, html } = buildEmail(winner.locale || 'en', title, claimLink);

        await mailer.sendMail({
          from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
          to: winner.email,
          subject,
          html
        });

        return res.json({
          success: true,
          message: `Winner drawn and emailed for product ${productId}`,
          winner: { email: winner.email, locale: winner.locale || 'en' }
        });
      } catch (errMail) {
        console.error('Email error:', errMail);

        // Winner is already stored via saveWinner above
        return res.status(200).json({
          success: true,
          message: 'Winner drawn. Email could not be sent.',
          emailed: false,
          winner: { email: winner.email, locale: winner.locale || 'en' }
        });
      }
    });
  });
});

// ---------- Back-in-Stock (BIS) endpoints ----------

// Subscribe to BIS
app.post('/bis/subscribe', async (req, res) => {
  try {
    let { email, product_handle, product_title, variant_id, locale } = req.body || {};
    if (!email || !product_handle) {
      return res.status(400).json({ ok:false, message:'Missing email or product' });
    }

    email  = String(email).trim().toLowerCase();
    locale = (locale || 'en').toLowerCase();

    if (!isValidEmailFormat(email)) {
      return res.status(400).json({ ok:false, message:'Invalid email format' });
    }
    const deliverable = await isDeliverableEmail(email);
    if (!deliverable) {
      return res.status(400).json({ ok:false, message:'Please enter a real email address' });
    }

    db.run(
      `INSERT INTO bis_subscribers (email, product_handle, product_title, variant_id, locale)
       VALUES (?, ?, ?, ?, ?)`,
      [ email, product_handle, product_title || '', String(variant_id || ''), locale ],
      (err) => {
        if (err) console.error('BIS insert error:', err);
      }
    );

    // --- email the subscriber (confirmation) + optionally notify store owner
    const ownerTo = process.env.BIS_NOTIFY_TO || process.env.FROM_EMAIL || process.env.EMAIL_USER;

    const packs = {
      en: {
        sub: 'We’ll notify you when it’s back',
        body: `You’ll receive an email as soon as <strong>${product_title || product_handle}</strong> is back in stock.`
      },
      de: {
        sub: 'Wir benachrichtigen Sie bei Verfügbarkeit',
        body: `Sobald <strong>${product_title || product_handle}</strong> wieder verfügbar ist, erhalten Sie eine E-Mail.`
      }
    };
    const short = locale.split('-')[0];
    const p = packs[locale] || packs[short] || packs.en;

    const htmlCustomer = `
      <div style="font-family:Arial,sans-serif;font-size:16px;color:#333">
        <p>${p.body}</p>
      </div>
    `;

    try {
      // confirmation to subscriber
      await mailer.sendMail({
        from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
        to: email,
        subject: p.sub,
        html: htmlCustomer
      });

      // internal heads-up (optional)
      if (ownerTo) {
        await mailer.sendMail({
          from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
          to: ownerTo,
          subject: `BIS signup: ${product_title || product_handle}`,
          html: `<div>New BIS request<br>Email: ${email}<br>Product: ${product_title || product_handle}<br>Variant: ${variant_id || '-' }<br>Locale: ${locale}</div>`
        });
      }
    } catch (mailErr) {
      console.error('BIS mail error:', mailErr);
      // Don’t fail the request just because email failed
    }

    return res.json({ ok:true });
  } catch (e) {
    console.error('BIS subscribe error:', e);
    return res.status(500).json({ ok:false, message:'Server error' });
  }
});

app.post('/bis/subscribe', (req, res) => {
  try {
    // Defensive log to verify the incoming body on Render
    console.log('[BIS] raw body:', typeof req.body, JSON.stringify(req.body || {}).slice(0, 500));

    let { email, productId, variant_id, product_handle, locale } = req.body || {};

    // Normalize product identifier: accept any of these keys
    const pid = productId || variant_id || product_handle;

    if (!email || !pid) {
      console.warn('[BIS] missing fields:', { emailPresent: !!email, pidPresent: !!pid });
      return res.status(400).json({ success: false, message: 'Missing email or product' });
    }

    email = String(email).trim().toLowerCase();
    locale = normLocale(locale || 'en');

    if (!isValidEmailFormat(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email' });
    }

    db.run(
      `INSERT OR IGNORE INTO bis_requests (productId, email, locale, createdAt)
       VALUES (?, ?, ?, datetime('now'))`,
      [String(pid), email, locale],
      (err) => {
        if (err) {
          console.error('[BIS] insert error:', err);
          return res.status(500).json({ success: false, message: 'Server error' });
        }
        return res.json({ success: true, message: 'We’ll email you when it’s back.' });
      }
    );
  } catch (e) {
    console.error('[BIS] handler crash:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Notify all subscribers for a product (trigger manually / via Flow)
// POST /bis/notify?pass=ADMIN_PASS
// body: { productId, productTitle, productUrl, localeOverride? }
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
    if (!rows || !rows.length) {
      return res.json({ success:true, sent:0, message:'No subscribers' });
    }

    let sent = 0, failed = 0;
    for (const r of rows) {
      const loc = pickLoc(localeOverride || r.locale || 'en');
      const subj = sub(BIS_I18N.subject[loc] || BIS_I18N.subject.en, { title: productTitle });
      const html = (BIS_I18N.body[loc] || BIS_I18N.body.en)(productTitle, productUrl);

      try {
        await mailer.sendMail({
          from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
          to: r.email,
          subject: subj,
          html
        });
        sent++;
      } catch (e) {
        console.error('BIS mail error', r.email, e);
        failed++;
      }
    }

    // Optional: clear subscriptions for this product after notifying
    db.run(`DELETE FROM bis_requests WHERE productId = ?`, [String(productId)]);

    res.json({ success:true, sent, failed });
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

// GET /admin/email — simple admin UI to send HTML emails to customers
app.get('/admin/email', (req, res) => {
  const pass = req.query.pass;
  if (pass !== process.env.ADMIN_PASS) {
    return res.status(403).send('Forbidden: Wrong password');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Bulk email sender</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.4;margin:24px;color:#222}
  h1{font-size:22px;margin:0 0 16px}
  form{display:grid;gap:12px;max-width:900px}
  .row{display:grid;gap:10px;grid-template-columns:1fr 1fr}
  label{font-weight:600;font-size:14px}
  input[type="text"],select,textarea{width:100%;padding:10px;border:1px solid #ccc;border-radius:8px;font:inherit}
  textarea{min-height:220px}
  .hint{font-size:12px;color:#666}
  .btn{background:#111;color:#fff;border:1px solid #111;border-radius:10px;padding:12px 16px;cursor:pointer}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .box{border:1px dashed #ddd;border-radius:10px;padding:10px}
  .badge{display:inline-block;background:#eee;border-radius:999px;padding:4px 8px;font-size:12px}
  .ok{color:#0a7a3c}.err{color:#b3261e}
  .grid2{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center}
</style>
</head>
<body>
  <h1>Bulk email sender</h1>
  <p class="hint">Admin tip: keep batches small while testing. The server appends an unsubscribe footer and List-Unsubscribe headers automatically.</p>

  <form id="f">
    <div class="row">
      <div>
        <label>Subject</label>
        <input id="subject" type="text" placeholder="Your email subject">
      </div>
      <div>
        <label>Language segment</label>
        <select id="locale">
          <option value="">All languages</option>
          <option value="en">English</option>
          <option value="de">German</option>
          <option value="fr">French</option>
          <option value="nl">Dutch</option>
          <option value="es">Spanish</option>
          <option value="it">Italian</option>
          <option value="sv">Swedish</option>
          <option value="nb">Norwegian (Bokmål)</option>
          <option value="fi">Finnish</option>
          <option value="pl">Polish</option>
          <option value="ro">Romanian</option>
          <option value="bg">Bulgarian</option>
          <option value="ar">Arabic</option>
          <option value="he">Hebrew</option>
          <option value="ja">Japanese</option>
          <option value="ko">Korean</option>
        </select>
      </div>
    </div>

    <div class="row">
      <div>
        <label>Batch size (per request)</label>
        <input id="limit" type="text" value="500">
        <div class="hint">Max customers to send in this run (server will page Shopify).</div>
      </div>
      <div>
        <label>Test mode</label>
        <select id="dry">
          <option value="1">Dry-run (no emails sent)</option>
          <option value="0">Send for real</option>
        </select>
      </div>
    </div>

    <div>
      <label>HTML body</label>
      <textarea id="html" placeholder="Paste your HTML here"></textarea>
      <div class="hint">We will append an unsubscribe footer automatically.</div>
    </div>

    <div class="grid2">
      <button class="btn" type="submit">Send</button>
      <span id="status" class="badge">idle</span>
    </div>
  </form>

  <div class="box" id="log"></div>

<script>
const f = document.getElementById('f');
const log = document.getElementById('log');
const statusEl = document.getElementById('status');

function addLog(msg, cls){
  const p = document.createElement('div');
  if (cls) p.className = cls;
  p.textContent = msg;
  log.prepend(p);
}

f.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const body = {
    subject: document.getElementById('subject').value.trim(),
    html: document.getElementById('html').value,
    locale: document.getElementById('locale').value.trim(),
    limit: parseInt(document.getElementById('limit').value, 10) || 500,
    dryRun: document.getElementById('dry').value === '1'
  };
  statusEl.textContent = 'working…';
  try{
    const r = await fetch('/admin/email?pass=${encodeURIComponent(process.env.ADMIN_PASS || '')}', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const out = await r.json();
    if (r.ok){
      statusEl.textContent = 'done';
      addLog('OK: sent=' + (out.sent||0) + ', skipped=' + (out.skipped||0) + ', failed=' + (out.failed||0), 'ok');
    } else {
      statusEl.textContent = 'error';
      addLog('Error: ' + (out.message || r.status), 'err');
    }
  } catch(err){
    statusEl.textContent = 'error';
    addLog('Network error: ' + (err && err.message ? err.message : err), 'err');
  }
});
</script>
</body>
</html>`);
});

// POST /admin/email — actually send the emails
app.post('/admin/email', async (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== process.env.ADMIN_PASS) {
    return res.status(403).json({ ok:false, message:'Forbidden' });
  }

  try {
    let { subject, html, locale, limit, dryRun } = req.body || {};
    subject = String(subject || '').trim();
    html    = String(html || '');
    locale  = String(locale || '').trim().toLowerCase();
    limit   = Math.max(1, Math.min(5000, Number(limit || 500)));
    dryRun  = !!dryRun;

    if (!subject || !html) {
      return res.status(400).json({ ok:false, message:'Missing subject or html' });
    }

    // Fetch customers from Shopify in pages
    let sent = 0, failed = 0, skipped = 0, checked = 0;
    let pageInfo = null;

    while (checked < limit) {
      const { customers, nextPageInfo } = await fetchShopifyCustomersPage(pageInfo);
      if (!customers || !customers.length) break;
      pageInfo = nextPageInfo;

      for (const cust of customers) {
        if (checked >= limit) break;
        checked++;

        const email = normEmail(cust.email);
        if (!email) { skipped++; continue; }

        // segment by locale if provided (match long or short)
        if (locale) {
          const cl = (cust.locale || cust.language || '').toLowerCase();
          const short = cl.split('-')[0];
          if (cl !== locale && short !== locale) { skipped++; continue; }
        }

        // honor unsubscribes
        if (await isUnsubscribed(email)) { skipped++; continue; }

        // assemble message
        const finalSubject = subject;
        const finalHtml    = withUnsubFooter(html, email);

        if (dryRun) {
          // just count, don’t send
          sent++;
          continue;
        }

        try {
          await mailer.sendMail({
            from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
            to: email,
            subject: finalSubject,
            html: finalHtml,
            headers: {
              'List-Unsubscribe': listUnsubHeader(email)
            }
          });
          sent++;
        } catch (e) {
          console.error('Send error', email, e && e.message ? e.message : e);
          failed++;
        }
      }

      if (!nextPageInfo) break; // no more pages
    }

    return res.json({ ok:true, sent, failed, skipped, checked, dryRun });
  } catch (e) {
    console.error('POST /admin/email error', e);
    return res.status(500).json({ ok:false, message:'Server error' });
  }
});

// ===================== ADMIN BULK EMAIL (Shopify customers) =====================

// Small helper: auth gate via ADMIN_PASS
function isAdmin(req) {
  const pass = req.query.pass || req.body?.pass || req.headers['x-admin-pass'];
  return pass && pass === process.env.ADMIN_PASS;
}

// Render a super-simple HTML form for composing & sending
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
          <select name="segment" style="padding:8px">
            <option value="">All customers</option>
            <option value="en">English</option>
            <option value="de">Deutsch</option>
            <option value="fr">Français</option>
            <option value="es">Español</option>
            <option value="it">Italiano</option>
            <option value="nl">Nederlands</option>
            <option value="sv">Svenska</option>
            <option value="nb">Norsk</option>
            <option value="fi">Suomi</option>
            <option value="pl">Polski</option>
            <option value="ro">Română</option>
            <option value="bg">Български</option>
            <option value="ar">العربية</option>
            <option value="he">עברית</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
            <option value="pt">Português</option>
            <option value="cs">Čeština</option>
            <option value="sk">Slovenčina</option>
            <option value="sl">Slovenščina</option>
            <option value="tr">Türkçe</option>
            <option value="ru">Русский</option>
            <option value="vi">Tiếng Việt</option>
            <option value="lt">Lietuvių</option>
            <option value="hr">Hrvatski</option>
          </select>
          <small style="color:#666;display:block">We match against Shopify customer.locale’s **short** code (e.g. “de”, “fr”). If blank, we send to all.</small>
        </div>

        <div style="margin:12px 0">
          <label>Subject</label><br>
          <input name="subject" required style="width:100%;padding:10px" placeholder="Your subject">
        </div>

        <div style="margin:12px 0">
          <label>HTML</label><br>
          <textarea name="html" required rows="14" style="width:100%;padding:10px;font-family:monospace"></textarea>
          <small style="color:#666;display:block">We’ll automatically append the unsubscribe footer + add a List-Unsubscribe header.</small>
        </div>

        <div style="display:flex;gap:12px;flex-wrap:wrap;margin:12px 0">
          <label>Max recipients (this run):
            <input type="number" name="limit" value="500" min="1" max="10000" style="width:120px;padding:8px">
          </label>
          <label>Start after customer ID (advanced pagination):
            <input type="number" name="since_id" value="0" style="width:160px;padding:8px">
          </label>
          <label><input type="checkbox" name="dry" checked> Dry run (don’t send; show a preview list)</label>
          <label>Test to (optional email):
            <input type="email" name="test_to" placeholder="you@example.com" style="width:220px;padding:8px">
          </label>
        </div>

        <button type="submit" style="padding:10px 16px;background:#111;color:#fff;border:0;border-radius:6px">Send</button>
      </form>
    </div>
  `);
});

// Fetch a batch of Shopify customers
async function fetchShopifyCustomers({ limit = 250, since_id = 0 } = {}) {
  const shop  = process.env.SHOPIFY_STORE;         // e.g. creedperfumesamples.myshopify.com
  const token = process.env.SHOPIFY_ADMIN_API_KEY; // private app token

  if (!shop || !token) throw new Error('SHOPIFY env missing');

  // We use the stable 2024-07 or newer – you already have 2024-07 working.
  const url =
    `https://${shop}/admin/api/2024-07/customers.json?limit=${Math.min(+limit || 250, 250)}&since_id=${since_id}`;

  const r = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Shopify-Access-Token': token,
      'Accept': 'application/json'
    }
  });
  if (!r.ok) {
    const txt = await r.text().catch(()=> '');
    throw new Error(`Shopify customers fetch failed: ${r.status} ${txt}`);
  }
  const data = await r.json();
  return Array.isArray(data.customers) ? data.customers : [];
}

// POST /admin/email — send (or dry-run) to a segment
app.post('/admin/email', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).send('Forbidden');

    const subject   = String(req.body.subject || '').trim();
    const html      = String(req.body.html || '');
    const segment   = String(req.body.segment || '').trim().toLowerCase(); // e.g. "de"
    const dryRun    = !!req.body.dry;
    const limit     = Math.max(1, Math.min(10000, Number(req.body.limit || 500)));
    let   since_id  = Number(req.body.since_id || 0) || 0;
    const testTo    = String(req.body.test_to || '').trim();

    if (!subject || !html) {
      return res.status(400).send('Missing subject or html');
    }

    // Optional: send a single test first
    if (testTo) {
      const email = normEmail(testTo);
      if (!email) return res.status(400).send('Invalid test email');
      await mailer.sendMail({
        from: process.env.FROM_EMAIL || process.env.EMAIL_USER,
        to: email,
        subject,
        html: withUnsubFooter(html, email),
        headers: { 'List-Unsubscribe': listUnsubHeader(email) }
      });
    }

    // Pull customers in small chunks until we hit the requested `limit`
    const toSend = [];
    while (toSend.length < limit) {
      const batch = await fetchShopifyCustomers({
        limit: Math.min(250, limit - toSend.length),
        since_id
      });
      if (!batch.length) break;
      since_id = batch[batch.length - 1].id;

      // Segment filter by locale short (if provided)
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
      // Skip unsubscribed
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

      // polite tiny delay to avoid bursts (optional)
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

// === Unsubscribe endpoint ===
app.get('/u', (req, res) => {
  const { e, t } = req.query;
  const secret = process.env.UNSUB_SECRET || process.env.ADMIN_PASS || 'change-me';

  if (!e || !t) return res.status(400).send('Invalid link');

  const check = crypto.createHmac('sha256', secret)
    .update(e.toLowerCase())
    .digest('hex')
    .slice(0, 32);

  if (check !== t) return res.status(403).send('Invalid token');

  // remove from BIS + entries
  db.run(`DELETE FROM bis_requests WHERE email = ?`, [e.toLowerCase()]);
  db.run(`DELETE FROM entries WHERE email = ?`, [e.toLowerCase()]);

  res.send('<h2>You have been unsubscribed.</h2>');
});

// ---------- Health checks ----------
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'lottery+bis', version: 1 });
});
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'lottery+bis', version: 1 });
});

// ===== Unsubscribe helpers =====
function normEmail(e){ return String(e || '').trim().toLowerCase(); }

function signUnsub(email) {
  const secret = process.env.UNSUBSCRIBE_SECRET || 'change-me';
  return crypto.createHmac('sha256', secret)
    .update(normEmail(email))
    .digest('hex')
    .slice(0, 32); // short but strong signature
}

function buildUnsubLink(email) {
  const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/,'');
  const t = signUnsub(email);
  return `${base}/u?e=${encodeURIComponent(normEmail(email))}&t=${t}`;
}

function verifyUnsub(email, token) {
  return token && token === signUnsub(email);
}

function isUnsubscribed(email) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT 1 FROM unsubscribes WHERE email = ? LIMIT 1`, [normEmail(email)], (err, row) => {
      if (err) return reject(err);
      resolve(!!row);
    });
  });
}

// Inject CAN-SPAM footer + List-Unsubscribe header
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
  return html + footer;
}

// Create nodemailer "List-Unsubscribe" header for mailbox providers
function listUnsubHeader(email) {
  const httpLink = buildUnsubLink(email);
  const mailto = process.env.UNSUBSCRIBE_MAILTO || ''; // optional, e.g. "unsubscribe@yourdomain.com"
  return mailto
    ? `<mailto:${mailto}>, <${httpLink}>`
    : `<${httpLink}>`;
}

// ---------- Start server ----------
const host = '0.0.0.0';
app.listen(port, host, () => {
  console.log(`✅ Lottery/BIS server listening on ${host}:${port}`);
});