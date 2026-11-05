// Geboortelijst - minimal, dependency-free Node.js server.
//
//   config.json                 site text and bank details (part of the code)
//   gifts.json                  starting gift list, copied into the data folder on first start
//   <data>/gifts.json           the live gift list (managed via /admin, picked up live)
//   <data>/contributions.json   what guests contributed / reserved
//
// The data folder is DATA_DIR, else Railway's volume (RAILWAY_VOLUME_MOUNT_PATH),
// else ./data. Only that folder has to survive redeploys.
//
// Every visitor gets live updates through Server-Sent Events (/api/events):
// as soon as someone contributes, or the gift list changes, all open pages refresh.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data'));
const SEED_GIFTS_FILE = path.join(ROOT, 'gifts.json');
const GIFTS_FILE = path.join(DATA_DIR, 'gifts.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const CONTRIBUTIONS_FILE = path.join(DATA_DIR, 'contributions.json');

// First start (empty data folder): begin with the gift list from the repository.
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(GIFTS_FILE)) {
  fs.copyFileSync(SEED_GIFTS_FILE, GIFTS_FILE);
  console.log(`Startlijst gekopieerd naar ${GIFTS_FILE}`);
}
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- data access ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`Kan ${path.basename(file)} niet lezen: ${err.message}`);
  }
}

// Re-read on every request so edits to the JSON files show up without a restart.
const loadConfig = () => readJson(CONFIG_FILE, {});
const loadGifts = () => readJson(GIFTS_FILE, []);
const loadContributions = () => readJson(CONTRIBUTIONS_FILE, []);

function saveContributions(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONTRIBUTIONS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, CONTRIBUTIONS_FILE);
  broadcast();
}

const toCents = (euros) => Math.round(Number(euros) * 100);

// Combines what guests did through the site with anything you recorded by hand
// in gifts.json ("bought": true, or a "contributions" list).
function giftStatus(gift, contributions) {
  const priceCents = toCents(gift.price);
  const manual = Array.isArray(gift.contributions) ? gift.contributions : [];
  const online = contributions.filter((c) => c.giftId === String(gift.id));
  const takenCents = gift.bought
    ? priceCents
    : Math.min(
        manual.reduce((sum, c) => sum + toCents(c.amount), 0) + online.reduce((sum, c) => sum + c.amountCents, 0),
        priceCents,
      );
  const remainingCents = priceCents - takenCents;
  const givers = manual.length + online.length;
  return {
    id: String(gift.id),
    name: gift.name,
    description: gift.description || '',
    images: giftImages(gift),
    link: gift.link || '',
    category: gift.category || '',
    allowPartial: gift.allowPartial !== false,
    contributeOnly: gift.contributeOnly === true,
    favorite: gift.favorite === true,
    price: priceCents / 100,
    taken: takenCents / 100,
    remaining: remainingCents / 100,
    complete: remainingCents === 0,
    contributors: gift.bought && givers === 0 ? 1 : givers,
  };
}

function publicConfig(config) {
  const { title, subtitle, intro, heroImage, beneficiary, iban, bic } = config;
  return { title, subtitle, intro, heroImage, beneficiary, iban, bic };
}

function newReference() {
  // Short, human-friendly code without ambiguous characters (no 0/O, 1/I).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (const b of crypto.randomBytes(6)) code += alphabet[b % alphabet.length];
  return code;
}

// ---------- live updates (Server-Sent Events) ----------

const clients = new Set();

function broadcast() {
  for (const res of clients) res.write('data: update\n\n');
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // stop reverse proxies from holding back events
  });
  res.write('retry: 5000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

// Keep connections alive through proxies that close idle streams.
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25_000).unref();

// Hand edits to gifts.json / config.json are pushed to all open pages.
// watchFile (polling) is used because fs.watch is unreliable on synced folders like OneDrive.
for (const file of [GIFTS_FILE, CONFIG_FILE]) {
  fs.watchFile(file, { interval: 1500 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) broadcast();
  });
}

// ---------- http helpers ----------

function send(res, status, body) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, {
    'Content-Type': isJson ? MIME['.json'] : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const given = Buffer.from(String(req.headers['x-admin-password'] || ''));
  const expected = Buffer.from(ADMIN_PASSWORD);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname === '/admin' ? 'admin.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(rel)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, content) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- api ----------

function handleRegistry(res) {
  const contributions = loadContributions();
  const gifts = loadGifts().map((g) => giftStatus(g, contributions));
  send(res, 200, { config: publicConfig(loadConfig()), gifts });
}

async function handleContribute(req, res) {
  const body = await readBody(req);
  const name = String(body.name || '').trim().slice(0, 80);
  const message = String(body.message || '').trim().slice(0, 500);
  const method = body.method === 'self' ? 'self' : 'transfer';

  if (!name) return send(res, 400, { error: 'Vul je naam in.' });

  const gift = loadGifts().find((g) => String(g.id) === String(body.giftId));
  if (!gift) return send(res, 404, { error: 'Dit cadeau bestaat niet (meer).' });

  // Everything below is synchronous, so no other request can interleave
  // between checking the remaining amount and saving the contribution.
  const contributions = loadContributions();
  const status = giftStatus(gift, contributions);
  const remainingCents = toCents(status.remaining);
  const euroText = (cents) => `€ ${(cents / 100).toFixed(2).replace('.', ',')}`;

  // A guest confirms a transfer only AFTER paying with the QR code. If someone else
  // filled the gift in the meantime, the money is already on its way: record it anyway,
  // flagged as "overflow" so the parents can sort it out, instead of losing it.
  const alreadyPaid = method === 'transfer' && body.confirmedPayment === true;

  if (method === 'self') {
    if (remainingCents === 0) return send(res, 409, { error: 'Dit cadeau is intussen al volledig gekocht.' });
    // Buying the whole gift yourself only makes sense while nobody has chipped in yet.
    if (status.contributeOnly || status.taken > 0) {
      return send(res, 409, { error: status.contributeOnly
        ? 'Voor dit cadeau kan je enkel een bijdrage doen.'
        : 'Er werd intussen al aan dit cadeau bijgedragen. Je kan nog een bijdrage doen.' });
    }
  } else if (remainingCents === 0 && !alreadyPaid) {
    return send(res, 409, { error: 'Dit cadeau is intussen al volledig gekocht.' });
  }

  let amountCents;
  if (method === 'self' || (!status.allowPartial && !alreadyPaid)) {
    amountCents = remainingCents;
  } else {
    amountCents = toCents(body.amount);
    if (!Number.isFinite(amountCents) || amountCents < 100) {
      return send(res, 400, { error: 'Het minimumbedrag is € 1.' });
    }
    if (amountCents > toCents(status.price)) {
      return send(res, 400, { error: `Het bedrag kan niet hoger zijn dan de prijs (${euroText(toCents(status.price))}).` });
    }
    if (amountCents > remainingCents && !alreadyPaid) {
      return send(res, 409, { error: `Er staat intussen nog maar ${euroText(remainingCents)} open voor dit cadeau.` });
    }
  }
  const overflow = amountCents > remainingCents;

  // The guest already saw (and maybe used) this reference in the QR code, so keep it.
  const reference = /^[A-HJ-NP-Z2-9]{6}$/.test(String(body.reference || '')) ? body.reference : newReference();

  const contribution = {
    id: crypto.randomUUID(),
    reference,
    ...(overflow ? { overflow: true } : {}),
    giftId: String(gift.id),
    giftName: gift.name,
    name,
    message,
    method,
    amountCents,
    paid: false,
    createdAt: new Date().toISOString(),
  };
  contributions.push(contribution);
  saveContributions(contributions);

  send(res, 201, {
    reference: contribution.reference,
    overflow,
    amount: amountCents / 100,
    method,
    giftId: contribution.giftId,
    giftName: gift.name,
  });
}

// ---------- gift management (admin) ----------

function saveGifts(list) {
  const tmp = GIFTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
  fs.renameSync(tmp, GIFTS_FILE);
  broadcast();
}

function slugify(text, taken) {
  const base = String(text)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'cadeau';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

// Keep gifts.json tidy: only write optional on/off flags when they're on.
function dropFalseFlags(gift) {
  for (const key of ['bought', 'contributeOnly', 'favorite']) if (!gift[key]) delete gift[key];
}

const isWebUrl = (s) => /^https?:\/\/\S+$/i.test(s);
// Either an online image, or a file you put in public/images/ (e.g. "images/cadeaus/kinderwagen-1.jpg").
const isLocalImage = (s) => /^images\/[\w.\/-]+\.(jpe?g|png|webp|gif|svg)$/i.test(s) && !s.includes('..');
const isImageRef = (s) => isWebUrl(s) || isLocalImage(s);
const MAX_IMAGES = 10;

// A gift has an "images" list; older gifts may still have a single "image".
function giftImages(gift) {
  const list = Array.isArray(gift.images) ? gift.images : gift.image ? [gift.image] : [];
  return list.map((s) => String(s).trim()).filter(Boolean);
}

// Validates the editable fields; returns { gift } or { error }.
function cleanGift(body) {
  const name = String(body.name || '').trim().slice(0, 120);
  const price = Math.round(Number(body.price) * 100) / 100;
  const images = [...new Set(giftImages(body))];
  const link = String(body.link || '').trim();

  if (!name) return { error: 'Geef het cadeau een naam.' };
  if (!Number.isFinite(price) || price <= 0) return { error: 'Geef een geldige prijs in.' };
  if (images.length > MAX_IMAGES) return { error: `Maximaal ${MAX_IMAGES} afbeeldingen per cadeau.` };
  const badImage = images.findIndex((s) => !isImageRef(s));
  if (badImage !== -1) {
    return { error: `Afbeelding ${badImage + 1} moet een link zijn (https://…) of een bestand in public/images, bv. images/cadeaus/foto.jpg.` };
  }
  if (link && !isWebUrl(link)) return { error: 'De productlink moet beginnen met http:// of https://.' };

  return {
    gift: {
      name,
      description: String(body.description || '').trim().slice(0, 1000),
      price,
      images,
      link,
      category: String(body.category || '').trim().slice(0, 40),
      allowPartial: body.allowPartial !== false,
      bought: body.bought === true,
      contributeOnly: body.contributeOnly === true,
      favorite: body.favorite === true,
    },
  };
}

async function handleAdminGifts(req, res, pathname) {
  const gifts = loadGifts();

  if (pathname === '/api/admin/gifts') {
    if (req.method === 'GET') {
      const contributions = loadContributions();
      return send(res, 200, gifts.map((g) => ({ ...g, ...pick(giftStatus(g, contributions), 'taken', 'contributors') })));
    }
    if (req.method === 'POST') {
      const { gift, error } = cleanGift(await readBody(req));
      if (error) return send(res, 400, { error });
      const created = { id: slugify(gift.name, new Set(gifts.map((g) => String(g.id)))), ...gift };
      dropFalseFlags(created);
      gifts.push(created);
      saveGifts(gifts);
      return send(res, 201, created);
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  const id = decodeURIComponent(pathname.slice('/api/admin/gifts/'.length));
  const index = gifts.findIndex((g) => String(g.id) === id);
  if (index === -1) return send(res, 404, { error: 'Cadeau niet gevonden.' });

  if (req.method === 'PUT') {
    const { gift, error } = cleanGift(await readBody(req));
    if (error) return send(res, 400, { error });
    // Keep fields the form doesn't edit (id, hand-entered "contributions").
    const updated = { ...gifts[index], ...gift };
    delete updated.image; // migrated to "images"
    dropFalseFlags(updated);
    gifts[index] = updated;
    saveGifts(gifts);
    return send(res, 200, updated);
  }

  if (req.method === 'DELETE') {
    const linked = loadContributions().filter((c) => c.giftId === id).length;
    if (linked) {
      return send(res, 409, { error: `Er ${linked === 1 ? 'is al 1 bijdrage' : `zijn al ${linked} bijdragen`} voor dit cadeau. Verwijder die eerst in het tabblad Bijdragen.` });
    }
    const [removed] = gifts.splice(index, 1);
    saveGifts(gifts);
    return send(res, 200, removed);
  }

  send(res, 405, { error: 'Method not allowed' });
}

const pick = (obj, ...keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

async function handleAdmin(req, res, pathname) {
  if (!isAdmin(req)) {
    return send(res, 401, { error: ADMIN_PASSWORD ? 'Onjuist wachtwoord.' : 'Beheer is uitgeschakeld: start de server met ADMIN_PASSWORD.' });
  }

  if (pathname === '/api/admin/gifts' || pathname.startsWith('/api/admin/gifts/')) {
    return handleAdminGifts(req, res, pathname);
  }

  if (req.method === 'GET' && pathname === '/api/admin/contributions') {
    return send(res, 200, loadContributions());
  }

  const match = pathname.match(/^\/api\/admin\/contributions\/([\w-]+)$/);
  if (!match) return send(res, 404, { error: 'Not found' });
  const contributions = loadContributions();
  const index = contributions.findIndex((c) => c.id === match[1]);
  if (index === -1) return send(res, 404, { error: 'Bijdrage niet gevonden.' });

  if (req.method === 'PATCH') {
    const body = await readBody(req);
    if (typeof body.paid === 'boolean') contributions[index].paid = body.paid;
    saveContributions(contributions);
    return send(res, 200, contributions[index]);
  }
  if (req.method === 'DELETE') {
    const [removed] = contributions.splice(index, 1);
    saveContributions(contributions);
    return send(res, 200, removed);
  }
  send(res, 405, { error: 'Method not allowed' });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/registry' && req.method === 'GET') return handleRegistry(res);
    if (pathname === '/api/events' && req.method === 'GET') return handleEvents(req, res);
    if (pathname === '/api/contributions' && req.method === 'POST') return await handleContribute(req, res);
    if (pathname.startsWith('/api/admin/')) return await handleAdmin(req, res, pathname);
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    serveStatic(res, pathname);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message || 'Er ging iets mis.' });
  }
});

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`Poort ${PORT} is al in gebruik. Kies een andere, bv. in PowerShell: $env:PORT=${PORT + 1}; node server.js`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Geboortelijst draait op http://localhost:${PORT}`);
  console.log(`Gegevens in: ${DATA_DIR}`);
  console.log(ADMIN_PASSWORD ? `Beheer: http://localhost:${PORT}/admin` : 'Tip: zet ADMIN_PASSWORD om /admin te gebruiken.');
});

// Hosting platforms stop the old server with SIGTERM on every redeploy.
// All writes are synchronous, so nothing is half-written; just close open streams and exit.
process.on('SIGTERM', () => {
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
