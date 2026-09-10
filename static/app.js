/* hostpulse panel.
   One poll of /api/servers drives the cards; opening a server fetches its own
   history. Charts are rebuilt rather than updated in place - a few hundred
   points cost nothing to redraw and it keeps the range switch honest. */

/* Chart.js renders its legend, ticks and tooltips with its own font setting,
   not the page's. Left alone, every Persian label inside a chart - the series
   names, the tooltip text - is drawn in a Latin default and falls back to
   whatever the system has. */
Chart.defaults.font.family = "Samim, system-ui, sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.color = '#94A3B8';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const fmtBytes = (b) => {
  if (b === null || b === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0, v = Number(b);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i];
};
const fmtRate = (bps) => bps === null || bps === undefined
  ? '—' : fmtBytes(bps) + '/s';
const fmtPct = (p) => p === null || p === undefined ? '—' : p.toFixed(0) + '٪';
/* Mostly words, so the digits are wrapped and the rest is left to Samim -
   otherwise "روز" and "ساعت" are drawn by a font that has no Persian. */
const fmtUptime = (s) => {
  if (!s) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const n = (v) => `<span class="n">${v}</span>`;
  return d > 0 ? `${n(d)} روز ${n(h)} ساعت` : `${n(h)} ساعت`;
};
const level = (p) => p === null || p === undefined ? '' : (p >= 90 ? 'bad' : p >= 75 ? 'warn' : '');

/* --------------------------------------------------------------- cards */
let servers = [];

async function refresh() {
  const r = await fetch('/api/servers');
  if (r.status === 401) { location.href = '/login'; return; }
  const d = await r.json();
  servers = d.servers;
  const box = $('#cards');
  box.innerHTML = '';
  $('#empty').hidden = servers.length > 0;
  for (const s of servers) box.appendChild(cardFor(s));
}

function bar(label, pct) {
  return `<div class="bar-row"><span>${label}</span>
    <span class="bar"><i class="${level(pct)}" style="width:${pct === null || pct === undefined ? 0 : Math.min(100, pct)}%"></i></span>
    <span class="val">${fmtPct(pct)}</span></div>`;
}

function cardFor(s) {
  const el = document.createElement('div');
  el.className = 'card clickable';
  el.innerHTML = `
    <div class="card-head">
      <div class="left">
        <span class="dot ${s.online ? 'on' : 'off'}" aria-hidden="true"></span>
        <span class="name">${esc(s.name)}</span>
        <span class="state">${s.online ? 'آنلاین' : 'آفلاین'}</span>
      </div>
      <div class="head-right">
        <span class="host">${esc(s.username)}@${esc(s.host)}:${s.port}</span>
        <button class="icon edit" title="ویرایش و حذف" aria-label="ویرایش ${esc(s.name)}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/>
            <circle cx="12" cy="19" r="1.6"/></svg>
        </button>
      </div>
    </div>
    <div class="bars">
      ${bar('پردازنده', s.cpu_pct)}
      ${bar('حافظه', s.mem_pct)}
      ${bar('دیسک', s.disk_pct)}
    </div>
    <div class="rate">
      <span>${arrow('down')} <b>${fmtRate(s.rx_rate)}</b></span>
      <span>${arrow('up')} <b>${fmtRate(s.tx_rate)}</b></span>
    </div>
    <div class="traffic">
      <div><span>امروز</span><b>${fmtBytes(s.today.total)}</b></div>
      <div><span>۷ روز</span><b>${fmtBytes(s.week.total)}</b></div>
      <div><span>۳۰ روز</span><b>${fmtBytes(s.month.total)}</b></div>
    </div>
    ${s.last_error && !s.online ? `<div class="err">${esc(s.last_error)}</div>` : ''}`;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.edit')) { e.stopPropagation(); openForm(s); return; }
    openDetail(s.id);
  });
  return el;
}

/* Direction arrows as SVG rather than glyphs: the checklist rules out
   pictographs standing in for icons, and an arrow glyph in an RTL paragraph
   is also at the mercy of bidi reordering. */
const arrow = (dir) => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
  stroke="${dir === 'down' ? 'var(--rx)' : 'var(--tx)'}" stroke-width="2.4"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
  style="vertical-align:-1px">${dir === 'down'
    ? '<path d="M12 5v14M19 12l-7 7-7-7"/>'
    : '<path d="M12 19V5M5 12l7-7 7 7"/>'}</svg>`;

const esc = (t) => String(t === null || t === undefined ? '' : t)
  .replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

/* -------------------------------------------------------------- detail */
let charts = {}, detailId = null, detailRange = '24h';

// bucket: what the server aggregates by; step: seconds each point covers, used
// to turn a bucket total back into a rate.
const RANGES = {
  '1h':  {secs: 3600,       bucket: null,  step: 60,    kind: 'rate'},
  '6h':  {secs: 6 * 3600,   bucket: null,  step: 60,    kind: 'rate'},
  '24h': {secs: 86400,      bucket: null,  step: 60,    kind: 'rate'},
  '7d':  {secs: 7 * 86400,  bucket: 'hour', step: 3600, kind: 'total'},
  '30d': {secs: 30 * 86400, bucket: 'day',  step: 86400, kind: 'total'},
};

async function openDetail(id) {
  detailId = id;
  $('#detail').hidden = false;
  await loadDetail();
}

async function loadDetail() {
  const r = await fetch(`/api/servers/${detailId}?range=${detailRange}`);
  const d = await r.json();
  const s = d.server;
  $('#d-name').textContent = s.name;
  $('#d-stats').innerHTML = `
    <div><span>وضعیت</span><b style="color:${s.online ? 'var(--ok)' : 'var(--bad)'}">${s.online ? 'آنلاین' : 'آفلاین'}</b></div>
    <div><span>پردازنده</span><b>${fmtPct(s.cpu_pct)}</b></div>
    <div><span>حافظه</span><b>${fmtPct(s.mem_pct)} از ${fmtBytes(s.mem_total)}</b></div>
    <div><span>دیسک</span><b>${fmtPct(s.disk_pct)} از ${fmtBytes(s.disk_total)}</b></div>
    <div><span>بار سیستم</span><b>${s.load1 === null || s.load1 === undefined ? '—' : s.load1.toFixed(2)}</b></div>
    <div><span>روشن بوده</span><b>${fmtUptime(s.uptime)}</b></div>
    <div><span>ترافیک امروز</span><b>${fmtBytes(s.today.rx)} / ${fmtBytes(s.today.tx)}</b></div>
    <div><span>ترافیک ۳۰ روز</span><b>${fmtBytes(s.month.total)}</b></div>`;

  const pts = d.points;
  const R = RANGES[detailRange];
  $('#d-thin').hidden = pts.length >= 3;

  // Latin digits and a 24-hour clock: Persian digits on a dense axis are hard
  // to read at a glance, which is the only thing an axis is for.
  const fmt = (ts) => {
    const t = new Date(ts * 1000);
    const p2 = (n) => String(n).padStart(2, '0');
    return R.secs <= 86400
      ? `${p2(t.getHours())}:${p2(t.getMinutes())}`
      : `${p2(t.getDate())}/${p2(t.getMonth() + 1)}` +
        (R.bucket === 'hour' ? ` ${p2(t.getHours())}h` : '');
  };
  const labels = pts.map(p => fmt(p.ts));

  draw('c-cpu', labels, [
    {label: 'پردازنده ٪', data: pts.map(p => p.cpu_pct), color: '#5b9dff'},
    {label: 'حافظه ٪', data: pts.map(p => p.mem_pct), color: '#3ddc84'},
  ], {max: 100, unit: 'pct'});

  // Live views read better as a rate; a week or a month is a question about
  // volume - how much did this move on Tuesday - so those are bucket totals.
  if (R.kind === 'rate') {
    draw('c-net', labels, [
      {label: 'دریافت', data: pts.map(p => (p.rx_bytes || 0) / R.step), color: '#5b9dff', fill: true},
      {label: 'ارسال', data: pts.map(p => (p.tx_bytes || 0) / R.step), color: '#c48bff', fill: true},
    ], {unit: 'rate'});
    $('#net-title').textContent = 'پهنای باند';
  } else {
    draw('c-net', labels, [
      {label: 'دریافت', data: pts.map(p => p.rx_bytes || 0), color: '#5b9dff'},
      {label: 'ارسال', data: pts.map(p => p.tx_bytes || 0), color: '#c48bff'},
    ], {unit: 'bytes', bars: true, stacked: true});
    $('#net-title').textContent =
      R.bucket === 'day' ? 'ترافیک هر روز' : 'ترافیک هر ساعت';
  }

  draw('c-disk', labels, [
    {label: 'دیسک ٪', data: pts.map(p => p.disk_pct), color: '#ffb020'},
  ], {max: 100, unit: 'pct'});
}

function unitFmt(unit) {
  if (unit === 'rate') return fmtRate;
  if (unit === 'bytes') return fmtBytes;
  return (v) => (v === null || v === undefined) ? '—' : v.toFixed(1) + '٪';
}

function draw(canvasId, labels, sets, opts = {}) {
  if (charts[canvasId]) charts[canvasId].destroy();
  const f = unitFmt(opts.unit);
  charts[canvasId] = new Chart(document.getElementById(canvasId), {
    type: opts.bars ? 'bar' : 'line',
    data: {
      labels,
      datasets: sets.map(s => ({
        label: s.label,
        data: s.data,
        borderColor: s.color,
        backgroundColor: opts.bars ? s.color + 'cc' : (s.fill ? s.color + '22' : 'transparent'),
        fill: !!s.fill,
        borderWidth: opts.bars ? 0 : 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: .25,
        // A break in the line is a server that was not answering. Joining
        // across it would draw traffic that never happened.
        spanGaps: false,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: false,
      interaction: {mode: 'index', intersect: false},
      plugins: {
        legend: {labels: {boxWidth: 10, font: {size: 11}}},
        tooltip: {
          callbacks: {label: (c) => c.dataset.label + ': ' + f(c.parsed.y)},
        },
      },
      scales: {
        x: {ticks: {maxTicksLimit: 10, font: {size: 10}, autoSkip: true},
            grid: {display: false}, stacked: !!opts.stacked},
        y: {beginAtZero: true, max: opts.max, stacked: !!opts.stacked,
            ticks: {font: {size: 10}, maxTicksLimit: 6, callback: f},
            grid: {color: 'rgba(128,128,128,.15)'}},
      },
    },
  });
}

/* ---------------------------------------------------------------- form */
let editing = null, authMode = 'password';

function openForm(server) {
  editing = server || null;
  $('#f-title').textContent = server ? 'ویرایش سرور' : 'افزودن سرور';
  $('#f-name').value = server ? server.name : '';
  $('#f-host').value = server ? server.host : '';
  $('#f-port').value = server ? server.port : 22;
  $('#f-user').value = server ? server.username : 'root';
  $('#f-password').value = ''; $('#f-key').value = ''; $('#f-passphrase').value = '';
  $('#f-delete').hidden = !server;
  setAuth(server ? server.auth : 'password');
  msg('');
  $('#form').hidden = false;
}

function setAuth(mode) {
  authMode = mode;
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.auth === mode));
  $('#pane-password').hidden = mode !== 'password';
  $('#pane-key').hidden = mode !== 'key';
}

function msg(text, ok) {
  const m = $('#f-msg');
  m.textContent = text; m.hidden = !text;
  m.classList.toggle('ok', !!ok);
}

function formBody() {
  return {
    name: $('#f-name').value.trim(),
    host: $('#f-host').value.trim(),
    port: parseInt($('#f-port').value || '22', 10),
    username: $('#f-user').value.trim() || 'root',
    auth: authMode,
    secret: authMode === 'password' ? $('#f-password').value : $('#f-key').value,
    passphrase: authMode === 'key' ? ($('#f-passphrase').value || null) : null,
  };
}

async function post(url, body) {
  const r = await fetch(url, {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  return {ok: r.ok, data: await r.json().catch(() => ({}))};
}

/* ---------------------------------------------------------------- wire */
$('#add-btn').addEventListener('click', () => openForm(null));
function closeModal(el) {
  if (!el) return;
  el.hidden = true;
  if (el.id === 'detail') detailId = null;
}
$$('.close').forEach(b => b.addEventListener('click', (e) =>
  closeModal(e.target.closest('.modal'))));
// Clicking the dark area outside the sheet, and Escape - both are what people
// reach for before they look for a button.
$$('.modal').forEach(m => m.addEventListener('click', (e) => {
  if (e.target === m) closeModal(m);
}));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.modal').forEach(m => { if (!m.hidden) closeModal(m); });
});
$$('.tabs button').forEach(b => b.addEventListener('click', () => setAuth(b.dataset.auth)));
$$('.seg button').forEach(b => b.addEventListener('click', () => {
  $$('.seg button').forEach(x => x.classList.toggle('on', x === b));
  detailRange = b.dataset.range;
  loadDetail();
}));

$('#f-test').addEventListener('click', async () => {
  msg('در حال تست…');
  const {data} = await post('/api/test', formBody());
  if (data.ok) {
    msg(`وصل شد — ${data.hostname || ''} · ${data.cores || '?'} هسته · ` +
        `${fmtBytes(data.mem_total)} رم · ${fmtBytes(data.disk_total)} دیسک`, true);
  } else {
    msg(data.error || 'اتصال ناموفق');
  }
});

$('#f-save').addEventListener('click', async () => {
  const body = formBody();
  if (!editing) {
    const twin = servers.find(s => s.host === body.host && s.port === body.port &&
                                   s.username === body.username);
    if (twin && !confirm(`«${twin.name}» همین حالا همین آدرس را دارد. باز هم اضافه شود؟`))
      return;
  }
  if (editing && !body.secret) { delete body.secret; delete body.auth; }
  const url = editing ? `/api/servers/${editing.id}` : '/api/servers';
  const {ok, data} = await post(url, body);
  if (!ok) { msg(data.error || 'ذخیره نشد'); return; }
  $('#form').hidden = true;
  refresh();
});

$('#f-delete').addEventListener('click', async () => {
  if (!editing || !confirm(`«${editing.name}» حذف شود؟ تاریخچه‌اش هم پاک می‌شود.`)) return;
  await post(`/api/servers/${editing.id}/delete`, {});
  $('#form').hidden = true;
  refresh();
});

// Reaching here means the file parsed and every handler is bound; the boot
// watchdog in the page checks for it.
window.__hostpulseReady = true;

refresh();
setInterval(() => { refresh(); if (detailId) loadDetail(); }, 30000);
