/* hostpulse panel.
   One poll of /api/servers drives the cards; opening a server fetches its own
   history. Charts are rebuilt rather than updated in place - a few hundred
   points cost nothing to redraw and it keeps the range switch honest. */

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
const fmtUptime = (s) => {
  if (!s) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  return d > 0 ? `${d} روز ${h} ساعت` : `${h} ساعت`;
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
      <div><span class="dot ${s.online ? 'on' : 'off'}"></span><span class="name">${esc(s.name)}</span></div>
      <div class="host">${esc(s.username)}@${esc(s.host)}:${s.port}</div>
    </div>
    <div class="bars">
      ${bar('پردازنده', s.cpu_pct)}
      ${bar('حافظه', s.mem_pct)}
      ${bar('دیسک', s.disk_pct)}
    </div>
    <div class="rate">↓ ${fmtRate(s.rx_rate)} &nbsp; ↑ ${fmtRate(s.tx_rate)}</div>
    <div class="traffic">
      <div><span>امروز</span><b>${fmtBytes(s.today.total)}</b></div>
      <div><span>۷ روز</span><b>${fmtBytes(s.week.total)}</b></div>
      <div><span>۳۰ روز</span><b>${fmtBytes(s.month.total)}</b></div>
    </div>
    ${s.last_error && !s.online ? `<div class="err">${esc(s.last_error)}</div>` : ''}`;
  el.addEventListener('click', () => openDetail(s.id));
  return el;
}

const esc = (t) => String(t === null || t === undefined ? '' : t)
  .replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

/* -------------------------------------------------------------- detail */
let charts = {}, detailId = null, detailRange = '24h';

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
    <div><span>ترافیک امروز</span><b>↓${fmtBytes(s.today.rx)} ↑${fmtBytes(s.today.tx)}</b></div>
    <div><span>ترافیک ۳۰ روز</span><b>${fmtBytes(s.month.total)}</b></div>`;

  const pts = d.points;
  const labels = pts.map(p => new Date(p.ts * 1000).toLocaleString('fa-IR',
    detailRange === '24h' ? {hour: '2-digit', minute: '2-digit'}
                          : {month: 'short', day: 'numeric', hour: '2-digit'}));
  draw('c-cpu', labels, [
    {label: 'پردازنده ٪', data: pts.map(p => p.cpu_pct), color: '#5b9dff'},
    {label: 'حافظه ٪', data: pts.map(p => p.mem_pct), color: '#3ddc84'},
  ], {max: 100});
  // per-second on the raw view, per-bucket totals once rolled up
  const div = detailRange === '24h' ? 60 : (detailRange === '7d' ? 3600 : 86400);
  draw('c-net', labels, [
    {label: 'دریافت', data: pts.map(p => (p.rx_bytes || 0) / div), color: '#5b9dff', fill: true},
    {label: 'ارسال', data: pts.map(p => (p.tx_bytes || 0) / div), color: '#c48bff', fill: true},
  ], {bytesRate: true});
  draw('c-disk', labels, [
    {label: 'دیسک ٪', data: pts.map(p => p.disk_pct), color: '#ffb020'},
  ], {max: 100});
}

function draw(canvasId, labels, sets, opts = {}) {
  if (charts[canvasId]) charts[canvasId].destroy();
  const ctx = document.getElementById(canvasId);
  charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: sets.map(s => ({
        label: s.label, data: s.data, borderColor: s.color,
        backgroundColor: s.fill ? s.color + '22' : 'transparent',
        fill: !!s.fill, borderWidth: 2, pointRadius: 0, tension: .25, spanGaps: true,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: {mode: 'index', intersect: false},
      plugins: {
        legend: {labels: {boxWidth: 10, font: {size: 11}}},
        tooltip: {callbacks: {label: (c) => c.dataset.label + ': ' +
          (opts.bytesRate ? fmtRate(c.parsed.y) : (c.parsed.y === null ? '—' : c.parsed.y.toFixed(1) + '٪'))}},
      },
      scales: {
        x: {ticks: {maxTicksLimit: 8, font: {size: 10}}, grid: {display: false}},
        y: {beginAtZero: true, max: opts.max,
            ticks: {font: {size: 10}, callback: (v) => opts.bytesRate ? fmtRate(v) : v + '٪'}},
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

refresh();
setInterval(() => { refresh(); if (detailId) loadDetail(); }, 30000);
