// server.js (Lottery – per product + Back-in-Stock multilingual)
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
      email TEXT,
      locale TEXT
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

    // defaults
    locale = normLocale(locale || 'en');

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
      `INSERT INTO entries (productId, email, locale) VALUES (?, ?, ?)`,
      [productId, email, locale],
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
app.post('/bis/subscribe', (req, res) => {
  let { email, productId, locale } = req.body || {};
  if (!email || !productId) {
    return res.status(400).json({ success:false, message:'Missing email or productId' });
  }
  email = String(email).trim().toLowerCase();
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
  res.json({ ok: true, service: 'lottery+bis', version: 1 });
});
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'lottery+bis', version: 1 });
});

// ---------- Start server ----------
app.listen(port, () => {
  console.log(`✅ Lottery/BIS server running on http://localhost:${port}`);
});