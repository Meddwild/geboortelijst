// Gift list front-end. Data comes from the Node server (/api/registry) and
// refreshes live via Server-Sent Events whenever anyone contributes.

const state = { config: {}, gifts: [], category: 'Alles', current: null, slides: {}, expanded: new Set() };

const $ = (id) => document.getElementById(id);
const euro = (n) => new Intl.NumberFormat('nl-BE', { style: 'currency', currency: 'EUR' }).format(n);
const formatIban = (iban) => iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
const toCents = (euros) => Math.round(Number(euros) * 100);

// EPC QR codes only reliably support plain ASCII in Belgian banking apps.
const ascii = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- loading & live updates ----------

async function load() {
  const res = await fetch('/api/registry', { cache: 'no-store' });
  if (!res.ok) throw new Error('Kon de lijst niet laden.');
  const data = await res.json();
  state.config = data.config;
  state.gifts = data.gifts;
  renderHeader();
  renderFilters();
  renderGrid();
  syncOpenDialog();
}

let reloadTimer;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => load().catch(() => {}), 150);
}

function connectLive() {
  if (!('EventSource' in window)) {
    setInterval(scheduleReload, 30_000);
    return;
  }
  const events = new EventSource('/api/events');
  events.onmessage = scheduleReload;
  // After a dropped connection EventSource reconnects by itself; catch up on what we missed.
  events.onopen = scheduleReload;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleReload();
});

// If someone else bought the gift while this visitor has the popup open, tell them.
function syncOpenDialog() {
  if (!$('dialog').open || !state.current || state.submitting) return;
  if (!$('pay').hidden) return syncPayStep();
  if ($('form').hidden) return;
  const fresh = state.gifts.find((g) => g.id === state.current.id);
  if (!fresh) return;
  state.current = fresh;
  updateRemainingText(fresh);
  applyMethodAvailability(fresh);
  updateMethodUi();
  $('amount').max = fresh.remaining;
  if (fresh.complete) {
    showError('Iemand anders heeft dit cadeau net gekocht.');
    $('submitBtn').disabled = true;
  } else if ($('amount').readOnly) {
    $('amount').value = fresh.remaining.toFixed(2);
  }
}

// ---------- rendering ----------

function renderHeader() {
  const c = state.config;
  document.title = c.title || 'Geboortelijst';
  $('title').textContent = c.title || 'Geboortelijst';
  $('subtitle').textContent = c.subtitle || '';
  $('intro').textContent = c.intro || '';
  if (c.heroImage) $('heroArt').src = c.heroImage;
  $('heroArt').hidden = c.heroImage === '';
}

function renderFilters() {
  const categories = ['Alles', ...new Set(state.gifts.map((g) => g.category).filter(Boolean))];
  if (!categories.includes(state.category)) state.category = 'Alles';
  $('filters').hidden = categories.length <= 2;
  $('filters').innerHTML = categories
    .map((c) => `<button type="button" role="tab" class="chip${c === state.category ? ' active' : ''}" aria-selected="${c === state.category}" data-category="${escapeHtml(c)}">${escapeHtml(c)}</button>`)
    .join('');
}

function renderGrid() {
  const hideComplete = $('hideComplete').checked;
  const hasFavorites = state.gifts.some((g) => g.favorite);
  $('favToggle').hidden = !hasFavorites;
  const onlyFavorites = hasFavorites && $('onlyFavorites').checked;
  const gifts = state.gifts
    .filter((g) => state.category === 'Alles' || g.category === state.category)
    .filter((g) => !(hideComplete && g.complete))
    .filter((g) => !onlyFavorites || g.favorite)
    .sort((a, b) => b.favorite - a.favorite); // favourites first (sort is stable, so list order is kept otherwise)

  $('empty').hidden = gifts.length > 0;

  // Fully bought gifts leave their category and gather in one section at the bottom.
  const open = gifts.filter((g) => !g.complete);
  const bought = gifts.filter((g) => g.complete);

  // One section per category on "Alles"; a single category needs no heading
  // (its filter chip is already highlighted).
  const groups = new Map();
  for (const g of open) {
    const key = g.category || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }
  const grouped = state.category === 'Alles' && [...groups.keys()].some(Boolean);

  let html;
  if (!grouped) {
    html = open.length ? `<div class="grid">${open.map(cardHtml).join('')}</div>` : '';
  } else {
    // Gifts without a category go last, under "Overige".
    const ordered = [...groups.entries()].sort(([a], [b]) => (a === '') - (b === ''));
    html = ordered.map(([category, list], i) => sectionHtml(`cat-${i}`, escapeHtml(category || 'Overige'), list)).join('');
  }
  if (bought.length) {
    html += sectionHtml('cat-bought', 'Al gekocht <span class="heart" aria-hidden="true">♥</span>', bought, 'is-bought');
  }

  $('grid').innerHTML = html;
  restoreCarousels($('grid'));
  updateClamps($('grid'));
}

function sectionHtml(id, titleHtml, list, extraClass = '') {
  return `
    <section class="category-section ${extraClass}" aria-labelledby="${id}">
      <header class="category-head">
        <h2 id="${id}">${titleHtml}</h2>
        <span class="muted small">${list.length} ${list.length === 1 ? 'cadeau' : 'cadeaus'}</span>
      </header>
      <div class="grid">${list.map(cardHtml).join('')}</div>
    </section>`;
}

// ---------- long descriptions: clamp to a few lines with "meer" / "minder" ----------

function descriptionHtml(g) {
  if (!g.description) return '';
  const open = state.expanded.has(g.id);
  return `
    <div class="desc-wrap${open ? ' is-open' : ''}">
      <p class="desc" id="desc-${escapeHtml(g.id)}">${escapeHtml(g.description)}</p>
      <button type="button" class="more-btn" data-more="${escapeHtml(g.id)}" aria-controls="desc-${escapeHtml(g.id)}" aria-expanded="${open}" hidden>${open ? 'minder' : 'meer'}</button>
    </div>`;
}

// Only show the toggle when the text really is cut off (depends on card width and font).
function updateClamps(root) {
  requestAnimationFrame(() => {
    root.querySelectorAll('.desc-wrap').forEach((wrap) => {
      const desc = wrap.querySelector('.desc');
      const btn = wrap.querySelector('.more-btn');
      if (wrap.classList.contains('is-open')) {
        btn.hidden = false;
        return;
      }
      btn.hidden = desc.scrollHeight <= desc.clientHeight + 1;
    });
  });
}

// Line wrapping changes once the web fonts arrive, and when the window is resized.
document.fonts?.ready.then(() => updateClamps($('grid')));
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => updateClamps($('grid')), 150);
});
function cardHtml(g) {
  const pct = g.price ? Math.round((g.taken / g.price) * 100) : 0;
  const image = carouselHtml(g.images, `card-${g.id}`, g.name);
  const status = g.complete
    ? '<span class="badge done">Gekocht ✓</span>'
    : g.taken > 0
      ? `<span class="badge">Nog ${euro(g.remaining)} open</span>`
      : '';
  const label = !canBuyWhole(g) ? 'Bijdragen' : g.allowPartial ? 'Bijdragen of kopen' : 'Kopen';
  const action = g.complete
    ? '<button class="btn" type="button" disabled>Al gekocht</button>'
    : `<button class="btn primary" type="button" data-gift="${escapeHtml(g.id)}">${label}</button>`;
  const favorite = g.favorite ? '<span class="fav-badge" title="Een van onze favorieten">♥ Favoriet</span>' : '';

  return `
    <article class="card${g.complete ? ' is-complete' : ''}${g.favorite ? ' is-favorite' : ''}">
      <div class="media">${image}${status}${favorite}</div>
      <div class="body">
        <h3>${escapeHtml(g.name)}</h3>
        ${descriptionHtml(g)}
        ${g.link ? `<a class="link" href="${escapeHtml(g.link)}" target="_blank" rel="noopener">Bekijk product ↗</a>` : ''}
        <div class="price-row">
          <span class="price">${euro(g.price)}</span>
          ${g.allowPartial && !g.complete ? '<span class="muted small">deelbaar</span>' : ''}
        </div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${pct}% bijeengebracht">
          <span style="width:${pct}%"></span>
        </div>
        <p class="muted small">${euro(g.taken)} van ${euro(g.price)}${g.contributors ? ` · ${g.contributors} ${g.contributors === 1 ? 'gever' : 'gevers'}` : ''}</p>
        ${action}
      </div>
    </article>`;
}

// ---------- image carousel (cards + popup) ----------
// Native horizontal scroll with snap points: swipe on phones, arrows/dots on desktop.

function carouselHtml(images, key, alt) {
  if (!images.length) return '<span class="placeholder" aria-hidden="true">🎁</span>';
  const imgs = images.map((src, i) => `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}${images.length > 1 ? ` (afbeelding ${i + 1} van ${images.length})` : ''}" loading="lazy" draggable="false">`).join('');
  if (images.length === 1) return `<div class="carousel"><div class="slides">${imgs}</div></div>`;
  return `
    <div class="carousel" data-carousel="${escapeHtml(key)}">
      <div class="slides" tabindex="0" aria-label="Afbeeldingen van ${escapeHtml(alt)}">${imgs}</div>
      <button type="button" class="nav prev" data-nav="-1" aria-label="Vorige afbeelding">‹</button>
      <button type="button" class="nav next" data-nav="1" aria-label="Volgende afbeelding">›</button>
      <div class="dots">${images.map((_, i) => `<button type="button" class="dot${i === 0 ? ' active' : ''}" data-dot="${i}" aria-label="Afbeelding ${i + 1}"></button>`).join('')}</div>
    </div>`;
}

const currentSlide = (slides) => Math.round(slides.scrollLeft / (slides.clientWidth || 1));

function goToSlide(carousel, index, smooth = true) {
  const slides = carousel.querySelector('.slides');
  const count = slides.children.length;
  const i = ((index % count) + count) % count; // wrap around at both ends
  slides.scrollTo({ left: i * slides.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
}

// Live updates re-render the cards; put every slideshow back on the image the visitor was viewing.
function restoreCarousels(root) {
  root.querySelectorAll('[data-carousel]').forEach((c) => {
    const i = state.slides[c.dataset.carousel];
    if (i) goToSlide(c, i, false);
  });
}

// Scroll events don't bubble, so listen in the capture phase.
document.addEventListener('scroll', (e) => {
  const slides = e.target;
  if (!(slides instanceof Element) || !slides.classList.contains('slides')) return;
  const carousel = slides.closest('[data-carousel]');
  if (!carousel) return;
  const i = currentSlide(slides);
  carousel.querySelectorAll('.dot').forEach((d, n) => d.classList.toggle('active', n === i));
  state.slides[carousel.dataset.carousel] = i;
}, true);

// ---------- dialog ----------

// "Ik koop het zelf" is only offered while nobody has contributed yet,
// and never for gifts the parents marked as contribute-only.
const canBuyWhole = (g) => !g.contributeOnly && g.taken === 0;

function applyMethodAvailability(gift) {
  const allowed = canBuyWhole(gift);
  $('methodSelf').hidden = !allowed;
  $('methods').hidden = !allowed; // with a single option there is nothing to choose
  if (!allowed) $('form').elements.method.value = 'transfer';

  const note = gift.contributeOnly
    ? 'Voor dit cadeau kan je een bijdrage doen via overschrijving.'
    : gift.taken > 0 && !gift.complete
      ? 'Er werd al aan dit cadeau bijgedragen. Je kan het resterende bedrag of een deeltje bijdragen.'
      : '';
  $('dlgNote').textContent = note;
  $('dlgNote').hidden = !note;
}

function updateRemainingText(gift) {
  $('dlgRemaining').textContent = gift.taken > 0
    ? `Nog ${euro(gift.remaining)} van ${euro(gift.price)} open`
    : `Prijs: ${euro(gift.price)}`;
}

function showError(msg) {
  $('formError').textContent = msg;
  $('formError').hidden = false;
}

function openDialog(gift) {
  state.current = gift;
  $('form').hidden = false;
  $('pay').hidden = true;
  $('done').hidden = true;
  state.pending = null;
  $('form').reset();
  $('formError').hidden = true;
  $('submitBtn').disabled = false;
  $('dlgTitle').textContent = gift.name;
  $('dlgMedia').innerHTML = carouselHtml(gift.images, `dlg-${gift.id}`, gift.name);
  $('dlgMedia').hidden = !gift.images.length;
  updateRemainingText(gift);

  $('amount').max = gift.remaining;
  $('amount').value = gift.allowPartial ? '' : gift.remaining.toFixed(2);

  const quick = [10, 25, 50, 100].filter((a) => a < gift.remaining);
  $('quickAmounts').innerHTML = quick.map((a) => `<button type="button" class="chip" data-amount="${a}">${euro(a)}</button>`).join('');

  applyMethodAvailability(gift);
  updateMethodUi();
  $('dialog').showModal();
  // Open on the same image the visitor was looking at on the card.
  const dlgCarousel = $('dlgMedia').querySelector('[data-carousel]');
  const startAt = state.slides[`card-${gift.id}`];
  if (dlgCarousel && startAt) goToSlide(dlgCarousel, startAt, false);
  setTimeout(() => (gift.allowPartial ? $('amount') : $('name')).focus(), 50);
}

function updateMethodUi() {
  const gift = state.current;
  const self = $('form').elements.method.value === 'self';
  const fixed = self || !gift.allowPartial;
  $('amount').readOnly = fixed;
  $('fullAmount').hidden = fixed;
  $('quickAmounts').hidden = fixed;
  if (fixed) $('amount').value = gift.remaining.toFixed(2);
}

// Step 1 -> 2: validate and show the QR code (or the self-purchase summary).
// Nothing is saved yet; that only happens when the guest confirms in step 2.
function submit(event) {
  event.preventDefault();
  const form = $('form');
  const gift = state.current;
  const method = form.elements.method.value;
  const amount = method === 'self' || !gift.allowPartial ? gift.remaining : Number(form.elements.amount.value);
  const name = form.elements.name.value.trim();
  const message = form.elements.message.value.trim();

  $('formError').hidden = true;
  if (!name) return showError('Vul je naam in.');
  if (!(amount >= 1)) return showError('Het minimumbedrag is € 1.');
  if (toCents(amount) > toCents(gift.remaining)) return showError(`Er staat nog maar ${euro(gift.remaining)} open.`);

  state.pending = { gift, method, amount: toCents(amount) / 100, name, message, reference: newReference() };
  showPay(state.pending);
}

// Same alphabet as the server: no 0/O or 1/I, so it is easy to read off a bank statement.
function newReference() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

function showPay({ gift, method, amount, name, reference }) {
  $('form').hidden = true;
  $('pay').hidden = false;
  $('payError').hidden = true;
  $('payWarning').hidden = true;
  $('payConfirm').disabled = false;
  const isSelf = method === 'self';
  $('payBlock').hidden = isSelf;
  $('selfBlock').hidden = !isSelf;
  $('payTitle').textContent = isSelf ? 'Bevestig je keuze' : 'Scan en betaal';
  $('payConfirm').textContent = isSelf ? 'Bevestigen' : 'Ik heb betaald';
  $('dialog').scrollTop = 0;

  if (isSelf) {
    $('selfText').textContent = `Je koopt "${gift.name}" zelf. Na bevestigen staat het cadeau op jouw naam en kan niemand anders het nog kopen.`;
    return;
  }

  const c = state.config;
  const remittance = ascii(`Geboortelijst ${reference} ${gift.name} - ${name}`).slice(0, 140);
  $('payAmount').textContent = euro(amount);
  $('payAmount2').textContent = euro(amount);
  $('payName').textContent = c.beneficiary;
  $('payIban').textContent = formatIban(c.iban);
  $('payRef').textContent = remittance;
  renderQr(epcPayload({
    bic: c.bic || '',
    name: ascii(c.beneficiary).slice(0, 70),
    iban: c.iban.replace(/\s+/g, '').toUpperCase(),
    amount,
    remittance,
  }));
}

// While the QR code is on screen, someone else may contribute. Warn before the guest pays.
function syncPayStep() {
  const p = state.pending;
  const fresh = p && state.gifts.find((g) => g.id === p.gift.id);
  if (!fresh) return;
  let warning = '';
  if (p.method === 'self' && (fresh.complete || !canBuyWhole(fresh))) {
    warning = 'Iemand anders was je net voor: dit cadeau kan je niet meer volledig zelf kopen.';
    $('payConfirm').disabled = true;
  } else if (p.method === 'transfer' && toCents(p.amount) > toCents(fresh.remaining)) {
    warning = fresh.complete
      ? 'Let op: iemand anders heeft dit cadeau net gekocht. Nog niet betaald? Annuleer dan. Al betaald? Klik gerust op "Ik heb betaald", we regelen het.'
      : `Let op: er staat intussen nog maar ${euro(fresh.remaining)} open. Nog niet betaald? Annuleer en kies een kleiner bedrag. Al betaald? Klik gerust op "Ik heb betaald".`;
  }
  $('payWarning').textContent = warning;
  $('payWarning').hidden = !warning;
}

// Step 2 -> 3: the guest confirms; only now the contribution is saved.
async function confirmPending() {
  const p = state.pending;
  if (!p) return;
  $('payError').hidden = true;
  $('payConfirm').disabled = true;
  state.submitting = true;
  try {
    const res = await fetch('/api/contributions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        giftId: p.gift.id, method: p.method, amount: p.amount, name: p.name, message: p.message,
        reference: p.reference, confirmedPayment: p.method === 'transfer',
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      $('payError').textContent = data.error || 'Er ging iets mis.';
      $('payError').hidden = false;
      if (res.status === 409) scheduleReload();
      return;
    }
    state.pending = null;
    showDone(p, data);
  } catch {
    $('payError').textContent = 'Geen verbinding met de server. Probeer opnieuw.';
    $('payError').hidden = false;
  } finally {
    state.submitting = false;
    $('payConfirm').disabled = false;
  }
}

function showDone({ gift, method }, result) {
  $('pay').hidden = true;
  $('done').hidden = false;
  $('doneText').textContent = method === 'self'
    ? `"${gift.name}" staat nu op jouw naam. Veel plezier met het kopen!`
    : `Je bijdrage van ${euro(result.amount)} voor "${gift.name}" staat nu op de lijst.`;
  $('doneWarning').textContent = result.overflow
    ? 'Iemand anders was je net voor, waardoor er nu meer betaald is dan nodig. Geen zorgen: je betaling is genoteerd en we nemen contact met je op.'
    : '';
  $('doneWarning').hidden = !result.overflow;
  $('dialog').scrollTop = 0;
}
// ---------- EPC QR ----------

// EPC069-12 "SEPA Credit Transfer" QR payload (version 002: BIC optional).
function epcPayload({ bic, name, iban, amount, remittance }) {
  return [
    'BCD', '002', '1', 'SCT',
    bic,
    name,
    iban,
    `EUR${amount.toFixed(2)}`,
    '',          // purpose
    '',          // structured reference
    remittance,  // unstructured remittance (max 140)
  ].join('\n');
}

function renderQr(payload) {
  const el = $('qr');
  if (typeof qrcode !== 'function') {
    el.innerHTML = '<p class="muted small">QR-code kon niet geladen worden — gebruik de gegevens hieronder.</p>';
    return;
  }
  const qr = qrcode(0, 'M');
  qr.addData(payload);
  qr.make();
  el.innerHTML = qr.createSvgTag(6, 4);
}

// ---------- events ----------

document.addEventListener('click', async (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    const carousel = nav.closest('.carousel');
    return goToSlide(carousel, currentSlide(carousel.querySelector('.slides')) + Number(nav.dataset.nav));
  }
  const dot = e.target.closest('[data-dot]');
  if (dot) return goToSlide(dot.closest('.carousel'), Number(dot.dataset.dot));

  const more = e.target.closest('[data-more]');
  if (more) {
    const wrap = more.closest('.desc-wrap');
    const open = wrap.classList.toggle('is-open');
    more.textContent = open ? 'minder' : 'meer';
    more.setAttribute('aria-expanded', open);
    if (open) state.expanded.add(more.dataset.more); else state.expanded.delete(more.dataset.more);
    return;
  }

  const giftBtn = e.target.closest('[data-gift]');
  if (giftBtn) return openDialog(state.gifts.find((g) => g.id === giftBtn.dataset.gift));

  const cat = e.target.closest('[data-category]');
  if (cat) {
    state.category = cat.dataset.category;
    renderFilters();
    return renderGrid();
  }

  const quick = e.target.closest('[data-amount]');
  if (quick) return void ($('amount').value = Number(quick.dataset.amount).toFixed(2));

  if (e.target.closest('#fullAmount')) return void ($('amount').value = state.current.remaining.toFixed(2));

  if (e.target.closest('[data-close]')) return $('dialog').close();

  const copy = e.target.closest('[data-copy]');
  if (copy) {
    try {
      await navigator.clipboard.writeText($(copy.dataset.copy).textContent);
      copy.textContent = 'gekopieerd ✓';
      setTimeout(() => (copy.textContent = 'kopieer'), 1500);
    } catch { /* clipboard unavailable - user can still select the text */ }
  }
});

$('dialog').addEventListener('click', (e) => { if (e.target === $('dialog')) $('dialog').close(); });
$('form').addEventListener('change', (e) => { if (e.target.name === 'method') updateMethodUi(); });
$('form').addEventListener('submit', submit);
$('payConfirm').addEventListener('click', confirmPending);
$('payCancel').addEventListener('click', () => { state.pending = null; $('dialog').close(); });
$('hideComplete').addEventListener('change', renderGrid);
$('onlyFavorites').addEventListener('change', renderGrid);

load()
  .then(connectLive)
  .catch((err) => {
    $('grid').innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    connectLive();
  });
