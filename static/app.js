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
/* Throughput is quoted in bits per second - that is what a link is sold as and
   what every other network tool shows - so the byte counters are multiplied by
   eight here.
   
   The unit step is 1000, not 1024. Storage is measured in powers of two and
   line rate in powers of ten; a "100 Mbps" port means 100,000,000 bits, and
   dividing by 1024 would quietly report it as 95. Volume totals stay in bytes
   below, because that is the unit a provider bills in. */
const fmtBits = (bytesPerSec) => {
  if (bytesPerSec === null || bytesPerSec === undefined) return '—';
  let v = Number(bytesPerSec) * 8, i = 0;
  const u = ['bps', 'kbps', 'Mbps', 'Gbps', 'Tbps'];
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return (v < 10 && i > 0 ? v.toFixed(2) : v < 100 && i > 0 ? v.toFixed(1)
          : Math.round(v)) + ' ' + u[i];
};
const fmtRate = fmtBits;
const fmtPct = (p) => p === null || p === undefined ? '—' : p.toFixed(0) + t('pct');
/* Mostly words, so the digits are wrapped and the rest is left to Samim -
   otherwise "روز" and "ساعت" are drawn by a font that has no Persian. */
const fmtUptime = (s) => {
  if (!s) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const n = (v) => `<span class="n">${v}</span>`;
  return d > 0 ? `${n(d)} ${t('days')} ${n(h)} ${t('hours')}` : `${n(h)} ${t('hours')}`;
};
const level = (p) => p === null || p === undefined ? '' : (p >= 90 ? 'bad' : p >= 75 ? 'warn' : '');

/* --------------------------------------------------------------- cards */
let servers = [], groups = [];

async function refresh() {
  // Rebuilding the board while a card is in the air destroys the element being
  // dragged, and the drag ends wherever it happens to be.
  if (dragging) return;
  const r = await fetch('/api/servers');
  if (r.status === 401) { location.href = '/login'; return; }
  const d = await r.json();
  servers = d.servers;
  groups = d.groups || [];
  renderBoard();
}

/* The board is one band per group plus a band for whatever has not been filed
   yet. Ungrouped comes last: it is a staging area, not a category. */
function renderBoard() {
  const board = $('#board');
  board.innerHTML = '';
  $('#empty').hidden = servers.length > 0;

  const bands = groups.map(g => ({group: g, list: servers.filter(s => s.group_id === g.id)}));
  const loose = servers.filter(s => !s.group_id);
  if (loose.length || groups.length) {
    bands.push({group: null, list: loose});
  } else {
    bands.push({group: null, list: servers});
  }

  for (const band of bands) {
    // An empty group still shows: it is a target to drag into, and hiding it
    // would make a group you just created look like it failed.
    if (!band.group && !band.list.length && groups.length) continue;
    board.appendChild(bandFor(band));
  }
}

function bandFor({group, list}) {
  const wrap = document.createElement('section');
  wrap.className = 'group';
  const sums = group
    ? `<div class="group-sums">
         <span>${t('today')} <b>${fmtBytes(group.today)}</b></span>
         <span>${t('week')} <b>${fmtBytes(group.week)}</b></span>
         <span>${t('month')} <b>${fmtBytes(group.month)}</b></span>
         <span>${t('bandwidth')} ${arrow('down')} <b>${fmtBits(group.rx_rate)}</b></span>
       </div>` : '';
  wrap.innerHTML = `
    <div class="group-head">
      <div class="title">
        <h2>${esc(group ? group.name : t('ungrouped'))}</h2>
        <span class="count">${group ? t('of_online', group.online, group.count)
                                    : t('n_servers', list.length)}</span>
      </div>
      ${sums}
    </div>
    <div class="cards ${list.length ? '' : 'empty-slot'}"
         data-group="${group ? group.id : ''}"></div>`;
  const box = wrap.querySelector('.cards');
  for (const s of list) box.appendChild(cardFor(s));
  wireDrop(box);
  return wrap;
}

/* ---------------------------------------------------------------- drag */
let dragId = null;
let dragging = false;

function wireDrag(el, s) {
  el.draggable = true;
  el.dataset.id = s.id;
  el.addEventListener('dragstart', (e) => {
    dragId = s.id;
    dragging = true;      // hold the periodic refresh off until this is over
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox will not start a drag without data on the transfer
    e.dataTransfer.setData('text/plain', String(s.id));
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    dragId = null;
    dragging = false;
    $$('.cards').forEach(c => c.classList.remove('drop-on'));
  });
}

function wireDrop(box) {
  box.addEventListener('dragover', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    box.classList.add('drop-on');
    const after = cardAfter(box, e.clientY);
    const moving = $(`.card[data-id="${dragId}"]`);
    if (!moving) return;
    if (after == null) box.appendChild(moving);
    else box.insertBefore(moving, after);
  });
  box.addEventListener('dragleave', (e) => {
    if (!box.contains(e.relatedTarget)) box.classList.remove('drop-on');
  });
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('drop-on');
    saveLayout();
  });
}

/* Which card the pointer is above, so the placeholder lands where it looks
   like it will land. */
function cardAfter(box, y) {
  const others = [...box.querySelectorAll('.card:not(.dragging)')];
  return others.reduce((closest, child) => {
    const r = child.getBoundingClientRect();
    const offset = y - r.top - r.height / 2;
    return offset < 0 && offset > closest.offset ? {offset, el: child} : closest;
  }, {offset: Number.NEGATIVE_INFINITY, el: null}).el;
}

async function saveLayout() {
  const order = [];
  $$('#board .cards').forEach(box => {
    const gid = box.dataset.group ? Number(box.dataset.group) : null;
    box.querySelectorAll('.card').forEach(card =>
      order.push({id: Number(card.dataset.id), group_id: gid}));
  });
  const {ok, data} = await post('/api/layout',
    {groups: groups.map(g => g.id), servers: order});
  if (!ok) {
    alert(t('layout_failed', data.error || t('unknown')));
  }
  dragging = false;
  refresh();
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
        <span class="state">${s.online ? t('online') : t('offline')}</span>
      </div>
      <div class="head-right">
        <span class="host">${esc(s.username)}@${esc(s.host)}:${s.port}</span>
        <button class="icon edit" title="${t('g_edit')}" aria-label="${t('g_edit')}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/>
            <circle cx="12" cy="19" r="1.6"/></svg>
        </button>
      </div>
    </div>
    <div class="bars">
      ${bar(t('cpu'), s.cpu_pct)}
      ${bar(t('memory'), s.mem_pct)}
      ${bar(t('disk'), s.disk_pct)}
    </div>
    <div class="rate">
      <span>${arrow('down')} <b>${fmtRate(s.rx_rate)}</b></span>
      <span>${arrow('up')} <b>${fmtRate(s.tx_rate)}</b></span>
    </div>
    <div class="traffic">
      <div><span>${t('today')}</span><b>${fmtBytes(s.today.total)}</b></div>
      <div><span>${t('week')}</span><b>${fmtBytes(s.week.total)}</b></div>
      <div><span>${t('month')}</span><b>${fmtBytes(s.month.total)}</b></div>
    </div>
    ${s.last_error && !s.online ? `<div class="err">${esc(s.last_error)}</div>` : ''}`;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.edit')) { e.stopPropagation(); openForm(s); return; }
    openDetail(s.id);
  });
  wireDrag(el, s);
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

/* The server decides how far to aggregate - it is the only side that knows how
   much history exists - and reports the bucket it used along with the seconds
   each point covers. Assuming that here was how the weekly view ended up
   asking for data that did not exist yet. */
const RANGE_SECONDS = {'1h': 3600, '6h': 21600, '24h': 86400,
                       '7d': 604800, '30d': 2592000};

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
    <div><span>${t('status')}</span><b style="color:${s.online ? 'var(--ok)' : 'var(--bad)'}">${s.online ? t('online') : t('offline')}</b></div>
    <div><span>${t('cpu')}</span><b>${fmtPct(s.cpu_pct)}</b></div>
    <div><span>${t('memory')}</span><b>${fmtPct(s.mem_pct)} / ${fmtBytes(s.mem_total)}</b></div>
    <div><span>${t('disk')}</span><b>${fmtPct(s.disk_pct)} / ${fmtBytes(s.disk_total)}</b></div>
    <div><span>${t('load')}</span><b>${s.load1 === null || s.load1 === undefined ? '—' : s.load1.toFixed(2)}</b></div>
    <div><span>${t('uptime')}</span><b>${fmtUptime(s.uptime)}</b></div>
    <div><span>${t('traffic_today')}</span><b>${fmtBytes(s.today.rx)} / ${fmtBytes(s.today.tx)}</b></div>
    <div><span>${t('traffic_month')}</span><b>${fmtBytes(s.month.total)}</b></div>`;

  const pts = d.points;
  const step = d.step || 60;              // seconds each point covers
  const span = RANGE_SECONDS[detailRange] || 86400;
  $('#d-thin').hidden = pts.length >= 3;

  // Latin digits and a 24-hour clock: Persian digits on a dense axis are hard
  // to read at a glance, which is the only thing an axis is for.
  const fmt = (ts) => {
    const t = new Date(ts * 1000);
    const p2 = (n) => String(n).padStart(2, '0');
    return span <= 86400
      ? `${p2(t.getHours())}:${p2(t.getMinutes())}`
      : `${p2(t.getDate())}/${p2(t.getMonth() + 1)}` +
        (d.bucket === 'hour' || d.bucket === 'raw' ? ` ${p2(t.getHours())}h` : '');
  };
  const labels = pts.map(p => fmt(p.ts));

  draw('c-cpu', labels, [
    {label: t('cpu'), data: pts.map(p => p.cpu_pct), color: '#38BDF8'},
    {label: t('memory'), data: pts.map(p => p.mem_pct), color: '#22C55E'},
  ], {max: 100, unit: 'pct'});

  // Always a rate, and always a line. Throughput is a continuous quantity, so
  // it reads as a curve; dividing every bucket by the seconds it covers means
  // an hourly point and a minute point sit on the same axis and can be
  // compared, which bars of raw bucket totals could not.
  draw('c-net', labels, [
    {label: t('download'), data: pts.map(p => (p.rx_bytes || 0) / step), color: '#38BDF8', fill: true},
    {label: t('upload'), data: pts.map(p => (p.tx_bytes || 0) / step), color: '#A78BFA', fill: true},
  ], {unit: 'rate'});
  $('#net-title').textContent = t('bw_bits') +
    (d.bucket === 'day' ? t('avg_daily') : d.bucket === 'hour' ? t('avg_hourly') : '');

  draw('c-disk', labels, [
    {label: t('disk'), data: pts.map(p => p.disk_pct), color: '#F59E0B'},
  ], {max: 100, unit: 'pct'});
}

function unitFmt(unit) {
  if (unit === 'rate') return fmtBits;      // throughput, in bits
  if (unit === 'bytes') return fmtBytes;    // volume, in bytes
  return (v) => (v === null || v === undefined) ? '—' : v.toFixed(1) + t('pct');
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

/* -------------------------------------------------------------- groups */
function renderGroups() {
  $('#g-list').innerHTML = groups.map(g => `
    <div class="grow-row" data-gid="${g.id}">
      <input value="${esc(g.name)}" aria-label="${t('g_name')}">
      <button class="icon del" title="${t('g_del')}" aria-label="${t('g_del')}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
      </button>
    </div>`).join('') || `<p class="sub">${t('g_none')}</p>`;

  $$('#g-list .grow-row input').forEach(inp => {
    const gid = inp.closest('.grow-row').dataset.gid;
    // Saved when the field loses focus rather than on every keystroke: a
    // rename is one decision, not one per letter.
    inp.addEventListener('change', async () => {
      const {ok, data} = await post(`/api/groups/${gid}`, {name: inp.value});
      if (!ok) gmsg(data.error || t('g_rename_failed')); else refresh();
    });
  });
  $$('#g-list .del').forEach(b => b.addEventListener('click', async () => {
    const row = b.closest('.grow-row');
    const name = row.querySelector('input').value;
    if (!confirm(t('g_confirm_del', name))) return;
    await post(`/api/groups/${row.dataset.gid}/delete`, {});
    await refresh();
    renderGroups();
  }));
}

function gmsg(text) {
  const m = $('#g-msg');
  m.textContent = text || '';
  m.hidden = !text;
}

function fillGroupSelect(selected) {
  $('#f-group').innerHTML = `<option value="">${t('ungrouped')}</option>` +
    groups.map(g => `<option value="${g.id}" ${g.id === selected ? 'selected' : ''}
      >${esc(g.name)}</option>`).join('');
}

/* ---------------------------------------------------------------- form */
let editing = null, authMode = 'password';

function openForm(server) {
  editing = server || null;
  $('#f-title').textContent = server ? t('edit_title') : t('add_title');
  $('#f-name').value = server ? server.name : '';
  $('#f-host').value = server ? server.host : '';
  $('#f-port').value = server ? server.port : 22;
  $('#f-user').value = server ? server.username : 'root';
  $('#f-password').value = ''; $('#f-key').value = ''; $('#f-passphrase').value = '';
  $('#f-delete').hidden = !server;
  fillGroupSelect(server ? server.group_id : null);
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
    group_id: $('#f-group').value ? Number($('#f-group').value) : null,
  };
}

async function post(url, body) {
  const r = await fetch(url, {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  return {ok: r.ok, data: await r.json().catch(() => ({}))};
}

/* ---------------------------------------------------------------- wire */
$('#add-btn').addEventListener('click', () => openForm(null));
$('#groups-btn').addEventListener('click', () => {
  gmsg('');
  renderGroups();
  $('#groupsheet').hidden = false;
});
$('#g-add').addEventListener('click', async () => {
  const name = $('#g-name').value.trim();
  if (!name) { gmsg(t('g_need_name')); return; }
  const {ok, data} = await post('/api/groups', {name});
  if (!ok) { gmsg(data.error || t('g_failed')); return; }
  $('#g-name').value = '';
  gmsg('');
  await refresh();
  renderGroups();
});
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
  msg(t('testing'));
  const {group_id, ...creds} = formBody();
  const {data} = await post('/api/test', creds);
  if (data.ok) {
    msg(`${t('connected')} — ${data.hostname || ''} · ${data.cores || '?'} ${t('cores')} · ` +
        `${fmtBytes(data.mem_total)} ${t('ram')} · ${fmtBytes(data.disk_total)} ${t('disk')}`, true);
  } else {
    msg(data.error || t('e_conn'));
  }
});

$('#f-save').addEventListener('click', async () => {
  const body = formBody();
  if (!editing) {
    const twin = servers.find(s => s.host === body.host && s.port === body.port &&
                                   s.username === body.username);
    if (twin && !confirm(t('confirm_twin', twin.name))) return;
  }
  if (editing && !body.secret) { delete body.secret; delete body.auth; }
  const url = editing ? `/api/servers/${editing.id}` : '/api/servers';
  const {ok, data} = await post(url, body);
  if (!ok) { msg(data.error || t('e_save')); return; }
  $('#form').hidden = true;
  refresh();
});

$('#f-delete').addEventListener('click', async () => {
  if (!editing || !confirm(t('confirm_del', editing.name))) return;
  await post(`/api/servers/${editing.id}/delete`, {});
  $('#form').hidden = true;
  refresh();
});

// Reaching here means the file parsed and every handler is bound; the boot
// watchdog in the page checks for it.
window.__hostpulseReady = true;

applyLang();
document.getElementById('lang-btn').addEventListener('click', () => {
  setLang(LANG === 'fa' ? 'en' : 'fa');
  refresh();                       // card and chart text is built in JS
  if (detailId) loadDetail();
});

refresh();
setInterval(() => { refresh(); if (detailId) loadDetail(); }, 30000);
