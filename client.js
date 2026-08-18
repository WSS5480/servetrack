/* ServeTrack — field-first process serving manager */
(function () {
'use strict';

/* ------------------------------------------------------------ helpers -- */
const $ = sel => document.querySelector(sel);
const app = $('#app');
const S = { me: null, view: 'dash', params: {}, cache: {} };

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const money = v => '$' + Number(v || 0).toFixed(2);
const cls = s => String(s || '').replace(/[^A-Za-z]/g, '');

function fmtDate(v, opts) {
  if (!v) return '';
  const d = new Date(v);
  return d.toLocaleDateString('en-US', opts || { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateOnly(v) { // date columns come back as YYYY-MM-DD or ISO midnight UTC
  if (!v) return '';
  const s = String(v).slice(0, 10).split('-');
  return `${+s[1]}/${+s[2]}/${s[0].slice(2)}`;
}
function fmtDT(v) {
  if (!v) return '';
  return new Date(v).toLocaleString('en-US',
    { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function daysOut(v) {
  if (!v) return null;
  const due = new Date(String(v).slice(0, 10) + 'T12:00:00');
  return Math.round((due - new Date()) / 864e5);
}
const todayISO = () => new Date().toISOString().slice(0, 10);

async function api(path, opts) {
  const res = await fetch('/api' + path, Object.assign({
    headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin'
  }, opts || {}));
  if (res.status === 401) { S.me = null; render(); throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg, bad) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function go(view, params) { S.view = view; S.params = params || {}; window.scrollTo(0, 0); render(); }

/* modal sheet */
let sheetEl = null;
function sheet(title, bodyHtml, onMount) {
  closeSheet();
  sheetEl = document.createElement('div');
  sheetEl.className = 'sheet';
  sheetEl.innerHTML = `<div class="inner"><h2>${esc(title)}</h2>${bodyHtml}</div>`;
  sheetEl.addEventListener('click', e => { if (e.target === sheetEl) closeSheet(); });
  document.body.appendChild(sheetEl);
  if (onMount) onMount(sheetEl);
}
function closeSheet() {
  if (sheetEl) { sheetEl.remove(); sheetEl = null; }
  if (window.__stopScan) { window.__stopScan(); window.__stopScan = null; }
}
window.closeSheet = closeSheet;

/* ------------------------------------------------------- maps linking -- */
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function addrOf(j) {
  return [j.address1, j.address2, j.city, j.state, j.zip].filter(Boolean).join(', ');
}
function appleUrl(a) { return 'https://maps.apple.com/?daddr=' + encodeURIComponent(a) + '&dirflg=d'; }
function googleUrl(a) {
  return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(a) + '&travelmode=driving';
}
function navUrl(a) { return isIOS() ? appleUrl(a) : googleUrl(a); }
function routeUrl(list) {
  const stops = list.map(addrOf).filter(Boolean);
  if (!stops.length) return null;
  const dest = stops[stops.length - 1];
  const way = stops.slice(0, -1).slice(0, 9).map(encodeURIComponent).join('|');
  return 'https://www.google.com/maps/dir/?api=1&origin=Current+Location&destination=' +
    encodeURIComponent(dest) + (way ? '&waypoints=' + way : '') + '&travelmode=driving';
}

/* ------------------------------------------------------------- layout -- */
const isAdmin = () => S.me && S.me.role === 'admin';

const TABS = () => isAdmin()
  ? [['dash', 'Today', '◎'], ['jobs', 'Jobs', '▤'], ['scan', 'Scan', '▥'], ['money', 'Billing', '$'], ['admin', 'Setup', '⚙']]
  : [['dash', 'My Day', '◎'], ['jobs', 'My Jobs', '▤'], ['scan', 'Scan', '▥'], ['money', 'My Pay', '$']];

function shell(inner) {
  const tabs = TABS().map(([v, label, ic]) =>
    `<button data-tab="${v}" class="${S.view === v || (v === 'jobs' && S.view === 'job') ? 'on' : ''}">
      <span class="ic">${ic}</span>${esc(label)}</button>`).join('');
  return `
    <div class="topbar">
      <div class="brand">ServeTrack<small>${esc(S.me.name)} · ${S.me.role === 'admin' ? 'Admin' : 'Field server'}</small></div>
      <div class="spacer"></div>
      <button id="logout">Sign out</button>
    </div>
    <div class="wrap">${inner}</div>
    <div class="tabs">${tabs}</div>`;
}

function bindShell() {
  document.querySelectorAll('[data-tab]').forEach(b =>
    b.onclick = () => go(b.dataset.tab));
  const lo = $('#logout');
  if (lo) lo.onclick = async () => { await api('/logout', { method: 'POST' }); S.me = null; render(); };
}

/* -------------------------------------------------------------- login -- */
function loginView() {
  app.innerHTML = `<div class="login">
    <div class="logo"><b>ServeTrack</b><div>Process serving management</div></div>
    <div class="card">
      <div class="field"><label>Email</label><input id="email" type="email" autocomplete="username" inputmode="email"></div>
      <div class="field"><label>Password</label><input id="pw" type="password" autocomplete="current-password"></div>
      <button class="btn block" id="signin">Sign in</button>
      <div class="hint" id="err" style="color:var(--bad);margin-top:10px"></div>
    </div></div>`;
  const submit = async () => {
    $('#err').textContent = '';
    try {
      S.me = await api('/login', { method: 'POST', body: JSON.stringify({ email: $('#email').value, password: $('#pw').value }) });
      go('dash');
    } catch (e) { $('#err').textContent = e.message; }
  };
  $('#signin').onclick = submit;
  $('#pw').onkeydown = e => { if (e.key === 'Enter') submit(); };
  $('#email').focus();
}

/* ---------------------------------------------------------- dashboard -- */
async function dashView() {
  const [stats, jobs] = await Promise.all([api('/stats'), api('/jobs?open=1')]);
  const overdue = jobs.filter(j => { const d = daysOut(j.due_date); return d !== null && d < 0; });
  const today = jobs.filter(j => { const d = daysOut(j.due_date); return d !== null && d >= 0 && d <= 1; });
  const rush = jobs.filter(j => j.priority !== 'Routine');
  const mine = isAdmin() ? jobs : jobs;

  app.innerHTML = shell(`
    <h1 class="page">${isAdmin() ? 'Operations today' : 'My day'}</h1>
    <div class="stats">
      <div class="stat"><div class="n">${stats.open_jobs}</div><div class="l">Open jobs</div></div>
      <div class="stat ${stats.overdue ? 'alert' : ''}"><div class="n">${stats.overdue}</div><div class="l">Past due</div></div>
      <div class="stat"><div class="n">${stats.rush}</div><div class="l">Rush / same day</div></div>
      <div class="stat good"><div class="n">${stats.served_7d}</div><div class="l">Served, 7 days</div></div>
    </div>

    <div class="card">
      <h2>Route my day <span class="sub">— ${mine.length} open stop${mine.length === 1 ? '' : 's'}</span></h2>
      <p class="hint" style="margin-top:-4px">Opens Google Maps with your stops in order (up to 10). No mapping fees — it just hands off to the app you already have.</p>
      <div class="row" style="margin-top:10px">
        <button class="btn nav" id="routeBtn" ${mine.length ? '' : 'disabled'}>Start route (${Math.min(mine.length, 10)} stops)</button>
        <button class="btn sec sm" id="routeList">See order</button>
      </div>
    </div>

    ${section('Past due', overdue)}
    ${section('Due today or tomorrow', today)}
    ${section('Rush &amp; same day', rush.filter(j => !overdue.includes(j) && !today.includes(j)))}
    ${overdue.length + today.length + rush.length === 0
      ? `<div class="card"><div class="empty">Nothing urgent. ${mine.length} open job${mine.length === 1 ? '' : 's'} total — see the Jobs tab.</div></div>` : ''}
  `);
  bindShell();
  bindJobItems();
  const rb = $('#routeBtn');
  if (rb) rb.onclick = () => {
    const url = routeUrl(mine.slice(0, 10));
    if (url) window.open(url, '_blank');
  };
  $('#routeList').onclick = () => sheet('Route order', `
    <p class="hint">Ordered by priority, then due date. Tap any stop to navigate to it alone.</p>
    <div class="list">${mine.slice(0, 10).map((j, i) => `
      <div class="item" data-nav="${esc(addrOf(j))}">
        <div class="r"><div><div class="t">${i + 1}. ${esc(j.recipient_name)}</div>
        <div class="m">${esc(addrOf(j))}</div></div>
        <span class="pill ${cls(j.priority)}">${esc(j.priority)}</span></div></div>`).join('')}</div>
    <button class="btn sec block" style="margin-top:12px" onclick="closeSheet()">Close</button>`,
    el => el.querySelectorAll('[data-nav]').forEach(n =>
      n.onclick = () => window.open(navUrl(n.dataset.nav), '_blank')));
}

function section(title, list) {
  if (!list.length) return '';
  return `<div class="card"><h2>${title} <span class="sub">${list.length}</span></h2>
    <div class="list">${list.map(jobItem).join('')}</div></div>`;
}

function jobItem(j) {
  const d = daysOut(j.due_date);
  const late = d !== null && d < 0 && !['Served', 'Non-Est', 'Cancelled'].includes(j.status);
  const due = j.due_date
    ? (late ? `<span style="color:var(--bad);font-weight:600">${Math.abs(d)}d past due</span>`
            : (d === 0 ? 'due today' : d === 1 ? 'due tomorrow' : 'due ' + fmtDateOnly(j.due_date)))
    : 'no due date';
  return `<div class="item p-${cls(j.priority)} ${late ? 'overdue' : ''}" data-job="${j.id}">
    <div class="r">
      <div>
        <div class="t">${esc(j.recipient_name)}</div>
        <div class="m">${esc(j.job_number)} · ${esc(j.city || '')}${j.city ? ', ' : ''}${esc(j.state || '')} · ${due}</div>
        <div class="m">${esc(j.client_name || 'No client')}${j.server_name ? ' → ' + esc(j.server_name) : ''}${j.attempt_count ? ' · ' + j.attempt_count + ' attempt' + (j.attempt_count === 1 ? '' : 's') : ''}</div>
      </div>
      <div style="text-align:right">
        <span class="pill ${cls(j.status)}">${esc(j.status)}</span>
        ${j.priority !== 'Routine' ? `<div style="margin-top:5px"><span class="pill rush">${esc(j.priority)}</span></div>` : ''}
      </div>
    </div></div>`;
}

function bindJobItems() {
  document.querySelectorAll('[data-job]').forEach(el =>
    el.onclick = () => go('job', { id: el.dataset.job }));
}

/* --------------------------------------------------------------- jobs -- */
async function jobsView() {
  const f = S.params;
  const qs = new URLSearchParams();
  if (f.status) qs.set('status', f.status);
  if (f.q) qs.set('q', f.q);
  if (f.open) qs.set('open', '1');
  const jobs = await api('/jobs?' + qs.toString());

  app.innerHTML = shell(`
    <h1 class="page">${isAdmin() ? 'Jobs' : 'My jobs'}</h1>
    <div class="card">
      <div class="row">
        <input id="q" placeholder="Search name, case #, job #, address" value="${esc(f.q || '')}" style="flex:1;min-width:160px">
        <select id="status" style="width:auto">
          <option value="">Any status</option>
          ${['Pending', 'Assigned', 'Attempted', 'Served', 'Non-Est', 'On Hold', 'Cancelled']
            .map(s => `<option ${f.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <label style="display:flex;align-items:center;gap:6px;margin:0;font-size:13px">
          <input type="checkbox" id="openOnly" ${f.open ? 'checked' : ''} style="width:auto"> Open only</label>
      </div>
      ${isAdmin() ? '<button class="btn block" id="newJob" style="margin-top:10px">+ New job</button>' : ''}
    </div>
    ${jobs.length ? `<div class="list">${jobs.map(jobItem).join('')}</div>`
      : '<div class="card"><div class="empty">No jobs match.</div></div>'}
  `);
  bindShell(); bindJobItems();
  const apply = () => go('jobs', { q: $('#q').value.trim(), status: $('#status').value, open: $('#openOnly').checked });
  $('#q').onkeydown = e => { if (e.key === 'Enter') apply(); };
  $('#status').onchange = apply;
  $('#openOnly').onchange = apply;
  if ($('#newJob')) $('#newJob').onclick = () => jobForm(null);
}

/* ------------------------------------------------------------ job form -- */
async function jobForm(job) {
  const [clients, users] = await Promise.all([api('/clients'), api('/users')]);
  const v = job || { service_type: 'Personal', priority: 'Routine', status: 'Pending' };
  const opt = (list, sel, label) => list.map(x =>
    `<option value="${x.id}" ${String(sel) === String(x.id) ? 'selected' : ''}>${esc(label(x))}</option>`).join('');

  sheet(job ? 'Edit ' + job.job_number : 'New job', `
    <div class="grid g2">
      <div class="field"><label>Client</label><select id="f_client_id">
        <option value="">— none —</option>${opt(clients, v.client_id, c => c.name)}</select></div>
      <div class="field"><label>Assign to</label><select id="f_assigned_to">
        <option value="">— unassigned —</option>${opt(users.filter(u => u.active), v.assigned_to, u => u.name)}</select></div>
    </div>
    <div class="field"><label>Person / entity to serve *</label><input id="f_recipient_name" value="${esc(v.recipient_name)}"></div>
    <div class="field"><label>Service address</label><input id="f_address1" placeholder="Street address" value="${esc(v.address1)}"></div>
    <div class="grid g3">
      <div class="field"><label>Apt / unit</label><input id="f_address2" value="${esc(v.address2)}"></div>
      <div class="field"><label>City</label><input id="f_city" value="${esc(v.city)}"></div>
      <div class="field"><label>State / ZIP</label>
        <div class="row"><input id="f_state" style="width:70px" maxlength="2" value="${esc(v.state)}">
        <input id="f_zip" style="flex:1" inputmode="numeric" value="${esc(v.zip)}"></div></div>
    </div>
    <div class="field"><label>Recipient notes (description, work hours, vehicle, gate code)</label>
      <textarea id="f_recipient_notes" style="min-height:60px">${esc(v.recipient_notes)}</textarea></div>
    <div class="grid g2">
      <div class="field"><label>Case number</label><input id="f_case_number" value="${esc(v.case_number)}"></div>
      <div class="field"><label>Court</label><input id="f_court" value="${esc(v.court)}"></div>
      <div class="field"><label>Plaintiff</label><input id="f_plaintiff" value="${esc(v.plaintiff)}"></div>
      <div class="field"><label>Defendant</label><input id="f_defendant" value="${esc(v.defendant)}"></div>
    </div>
    <div class="field"><label>Documents to serve</label><input id="f_documents" placeholder="Summons and Complaint" value="${esc(v.documents)}"></div>
    <div class="grid g3">
      <div class="field"><label>Service type</label><select id="f_service_type">
        ${['Personal', 'Substitute', 'Posting', 'Certified Mail', 'Corporate'].map(s => `<option ${v.service_type === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="field"><label>Priority</label><select id="f_priority">
        ${['Routine', 'Rush', 'Same Day'].map(s => `<option ${v.priority === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="field"><label>Due date</label><input id="f_due_date" type="date" value="${v.due_date ? String(v.due_date).slice(0, 10) : ''}"></div>
    </div>
    <div class="grid g3">
      <div class="field"><label>Client fee</label><input id="f_client_fee" type="number" step="0.01" value="${v.client_fee || ''}"></div>
      <div class="field"><label>Server pay</label><input id="f_server_pay" type="number" step="0.01" value="${v.server_pay || ''}"></div>
      <div class="field"><label>Status</label><select id="f_status">
        ${['Pending', 'Assigned', 'Attempted', 'Served', 'Non-Est', 'On Hold', 'Cancelled'].map(s => `<option ${v.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Internal notes</label><textarea id="f_notes" style="min-height:60px">${esc(v.notes)}</textarea></div>
    <div class="row" style="margin-top:6px">
      <button class="btn" id="save">${job ? 'Save changes' : 'Create job'}</button>
      <button class="btn sec" onclick="closeSheet()">Cancel</button>
      ${job ? '<button class="btn ghost" id="del" style="color:var(--bad);margin-left:auto">Delete</button>' : ''}
    </div>`, el => {
    // auto-fill fee/pay defaults from the selected client / server
    el.querySelector('#f_client_id').onchange = e => {
      const c = clients.find(x => String(x.id) === e.target.value);
      if (c && c.default_fee && !el.querySelector('#f_client_fee').value)
        el.querySelector('#f_client_fee').value = Number(c.default_fee).toFixed(2);
    };
    el.querySelector('#f_assigned_to').onchange = e => {
      const u = users.find(x => String(x.id) === e.target.value);
      if (u && u.default_pay && !el.querySelector('#f_server_pay').value)
        el.querySelector('#f_server_pay').value = Number(u.default_pay).toFixed(2);
    };
    el.querySelector('#save').onclick = async () => {
      const body = {};
      ['client_id','assigned_to','recipient_name','address1','address2','city','state','zip','recipient_notes',
       'case_number','court','plaintiff','defendant','documents','service_type','priority','due_date',
       'client_fee','server_pay','status','notes'].forEach(f => { body[f] = el.querySelector('#f_' + f).value; });
      if (!body.recipient_name.trim()) return toast('Who are we serving?', true);
      try {
        const saved = job
          ? await api('/jobs/' + job.id, { method: 'PATCH', body: JSON.stringify(body) })
          : await api('/jobs', { method: 'POST', body: JSON.stringify(body) });
        closeSheet(); toast(job ? 'Saved' : 'Job ' + saved.job_number + ' created');
        go('job', { id: saved.id });
      } catch (e) { toast(e.message, true); }
    };
    if (el.querySelector('#del')) el.querySelector('#del').onclick = async () => {
      if (!confirm('Delete this job and all its attempts?')) return;
      await api('/jobs/' + job.id, { method: 'DELETE' });
      closeSheet(); toast('Deleted'); go('jobs');
    };
  });
}

/* ---------------------------------------------------------- job detail -- */
async function jobView() {
  const j = await api('/jobs/' + S.params.id);
  const addr = addrOf(j);
  const done = ['Served', 'Non-Est', 'Cancelled'].includes(j.status);

  app.innerHTML = shell(`
    <div class="row" style="margin-bottom:8px">
      <button class="btn ghost" id="back">‹ Back</button>
      <div class="spacer" style="flex:1"></div>
      <span class="pill ${cls(j.status)}">${esc(j.status)}</span>
      ${j.priority !== 'Routine' ? `<span class="pill rush">${esc(j.priority)}</span>` : ''}
    </div>
    <h1 class="page" style="margin-top:0">${esc(j.recipient_name)}</h1>

    <div class="card">
      <div class="m" style="color:var(--muted);font-size:13px;margin-bottom:8px">${esc(j.job_number)} · ${esc(j.client_name || 'No client')}</div>
      <div style="font-size:15px;font-weight:600">${esc(addr || 'No address on file')}</div>
      ${j.recipient_notes ? `<div class="hint" style="margin-top:6px">${esc(j.recipient_notes)}</div>` : ''}
      <div class="row" style="margin-top:12px">
        <button class="btn nav" id="navBtn" ${addr ? '' : 'disabled'}>Navigate ▸</button>
        ${!done ? '<button class="btn ok" id="attBtn">Log attempt</button>' : ''}
      </div>
      ${addr ? `<div class="hint" style="margin-top:8px">Opens ${isIOS() ? 'Apple Maps' : 'Google Maps'} ·
        <a href="${isIOS() ? googleUrl(addr) : appleUrl(addr)}" target="_blank">use ${isIOS() ? 'Google' : 'Apple'} Maps instead</a></div>` : ''}
    </div>

    <div class="card">
      <h2>Attempts <span class="sub">${j.attempts.length}</span></h2>
      ${j.attempts.length ? j.attempts.map(a => `
        <div class="att ${cls(a.outcome)}">
          <div class="h">${esc(a.outcome)}${a.manner ? ' — ' + esc(a.manner) : ''}</div>
          <div class="m">${fmtDT(a.attempted_at)} · ${esc(a.server_name || '')}</div>
          ${a.person_served ? `<div class="m">Served: ${esc(a.person_served)}${a.relationship ? ' (' + esc(a.relationship) + ')' : ''}</div>` : ''}
          ${a.description ? `<div class="m">Description: ${esc(a.description)}</div>` : ''}
          ${a.notes ? `<div class="m">${esc(a.notes)}</div>` : ''}
          ${a.lat != null ? `<div class="m">GPS ${Number(a.lat).toFixed(5)}, ${Number(a.lng).toFixed(5)}
            ${a.accuracy_m ? '±' + Math.round(a.accuracy_m) + 'm' : ''} ·
            <a href="https://www.google.com/maps?q=${a.lat},${a.lng}" target="_blank">map</a></div>` : ''}
        </div>`).join('')
        : '<div class="empty">No attempts logged yet.</div>'}
    </div>

    <div class="card">
      <h2>Paperwork</h2>
      <div class="row">
        <button class="btn sec sm" id="affBtn">Affidavit</button>
        <button class="btn sec sm" id="coverBtn">Cover sheet + barcode</button>
      </div>
      <div style="text-align:center;margin-top:14px">
        <img src="/barcode/${encodeURIComponent(j.job_number)}.svg" alt="barcode" style="max-width:100%">
      </div>
    </div>

    <div class="card">
      <h2>Case detail</h2>
      <table class="tbl">
        ${[['Case', j.case_number], ['Court', j.court], ['Plaintiff', j.plaintiff], ['Defendant', j.defendant],
           ['Documents', j.documents], ['Service type', j.service_type], ['Due', fmtDateOnly(j.due_date)],
           ['Assigned to', j.server_name], ['Client fee', j.client_fee ? money(j.client_fee) : ''],
           ['Server pay', j.server_pay ? money(j.server_pay) : ''],
           ['Served', j.served_at ? fmtDT(j.served_at) + ' — ' + esc(j.served_manner || '') : ''],
           ['Notes', j.notes]]
          .filter(r => r[1]).map(r => `<tr><th style="width:34%">${r[0]}</th><td>${esc(r[1])}</td></tr>`).join('')}
      </table>
      ${isAdmin() ? '<button class="btn sec block sm" id="editBtn" style="margin-top:12px">Edit job</button>' : ''}
    </div>`);
  bindShell();
  $('#back').onclick = () => go('jobs', S.cache.jobFilter || {});
  if ($('#navBtn')) $('#navBtn').onclick = () => window.open(navUrl(addr), '_blank');
  if ($('#attBtn')) $('#attBtn').onclick = () => attemptForm(j);
  if ($('#editBtn')) $('#editBtn').onclick = () => jobForm(j);
  $('#coverBtn').onclick = () => window.open('/print/coversheet/' + j.id, '_blank');
  $('#affBtn').onclick = () => affidavitSheet(j);
}

/* ------------------------------------------------------- log attempt -- */
const OUTCOMES = ['Served', 'No Answer', 'Bad Address', 'Moved', 'Refused', 'Evading', 'Other'];

function attemptForm(job) {
  sheet('Log attempt — ' + job.recipient_name, `
    <div class="field"><label>Outcome</label>
      <div class="row" id="outcomes">${OUTCOMES.map(o =>
        `<button class="btn sec sm" data-o="${o}">${o}</button>`).join('')}</div></div>
    <div id="servedFields" style="display:none">
      <div class="grid g2">
        <div class="field"><label>Manner</label><select id="a_manner">
          ${['Personal', 'Substitute', 'Posted', 'Corporate', 'Certified Mail'].map(s => `<option>${s}</option>`).join('')}</select></div>
        <div class="field"><label>Person served</label><input id="a_person_served" value="${esc(job.recipient_name)}"></div>
      </div>
      <div class="grid g2">
        <div class="field"><label>Relationship (if substitute)</label><input id="a_relationship" placeholder="co-resident, co-worker..."></div>
        <div class="field"><label>Description</label><input id="a_description" placeholder="W/F, 40s, 5'6&quot;, brown hair"></div>
      </div>
    </div>
    <div class="field"><label>Notes</label><textarea id="a_notes" placeholder="Lights on, no answer at front door. Silver Civic in driveway."></textarea></div>
    <div class="field"><label>When</label><input id="a_when" type="datetime-local" value="${localNow()}"></div>
    <div class="card" style="background:#f8fafc;box-shadow:none;margin-bottom:12px">
      <div class="row"><button class="btn sec sm" id="gpsBtn">Capture GPS</button>
      <span class="hint" id="gpsOut" style="margin:0">Not captured</span></div>
    </div>
    <div class="row">
      <button class="btn" id="saveAtt" disabled>Pick an outcome</button>
      <button class="btn sec" onclick="closeSheet()">Cancel</button>
    </div>`, el => {
    let outcome = null, gps = null;
    el.querySelectorAll('[data-o]').forEach(b => b.onclick = () => {
      outcome = b.dataset.o;
      el.querySelectorAll('[data-o]').forEach(x => { x.className = 'btn sec sm'; });
      b.className = 'btn sm' + (outcome === 'Served' ? ' ok' : '');
      el.querySelector('#servedFields').style.display = outcome === 'Served' ? '' : 'none';
      const s = el.querySelector('#saveAtt');
      s.disabled = false;
      s.textContent = outcome === 'Served' ? 'Save — marks job SERVED' : 'Save attempt';
    });
    el.querySelector('#gpsBtn').onclick = () => {
      const out = el.querySelector('#gpsOut');
      if (!navigator.geolocation) return out.textContent = 'Not supported on this device';
      out.textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition(pos => {
        gps = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy_m: pos.coords.accuracy };
        out.innerHTML = `<b style="color:var(--ok)">✓ ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}</b> ±${Math.round(gps.accuracy_m)}m`;
      }, err => { out.textContent = 'Failed: ' + err.message; },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    };
    // auto-capture on open — the affidavit is stronger when every attempt has coordinates
    el.querySelector('#gpsBtn').click();

    el.querySelector('#saveAtt').onclick = async () => {
      const body = Object.assign({
        outcome,
        attempted_at: el.querySelector('#a_when').value || null,
        notes: el.querySelector('#a_notes').value
      }, gps || {});
      if (outcome === 'Served') {
        body.manner = el.querySelector('#a_manner').value;
        body.person_served = el.querySelector('#a_person_served').value;
        body.relationship = el.querySelector('#a_relationship').value;
        body.description = el.querySelector('#a_description').value;
      }
      try {
        await api('/jobs/' + job.id + '/attempts', { method: 'POST', body: JSON.stringify(body) });
        closeSheet(); toast(outcome === 'Served' ? 'Served — job closed out' : 'Attempt logged');
        go('job', { id: job.id });
      } catch (e) { toast(e.message, true); }
    };
  });
}

function localNow() {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

/* ---------------------------------------------------------- affidavit -- */
async function affidavitSheet(job) {
  const templates = await api('/templates');
  const load = async id => {
    const r = await api('/jobs/' + job.id + '/affidavit' + (id ? '?template_id=' + id : ''));
    return r;
  };
  const first = await load();
  sheet('Affidavit — ' + job.job_number, `
    <div class="field"><label>Template</label><select id="tpl">
      ${templates.map(t => `<option value="${t.id}" ${t.id === first.template_id ? 'selected' : ''}>${esc(t.name)}${t.jurisdiction ? ' — ' + esc(t.jurisdiction) : ''}</option>`).join('')}
    </select></div>
    <pre class="prev" id="prev">${esc(first.text)}</pre>
    <div class="row" style="margin-top:12px">
      <button class="btn" id="printAff">Print / save PDF</button>
      <button class="btn sec" id="copyAff">Copy text</button>
      <button class="btn sec" onclick="closeSheet()">Close</button>
    </div>`, el => {
    const sel = el.querySelector('#tpl');
    sel.onchange = async () => { el.querySelector('#prev').textContent = (await load(sel.value)).text; };
    el.querySelector('#printAff').onclick = () =>
      window.open('/print/affidavit/' + job.id + '?template_id=' + sel.value, '_blank');
    el.querySelector('#copyAff').onclick = async () => {
      await navigator.clipboard.writeText(el.querySelector('#prev').textContent);
      toast('Copied');
    };
  });
}

/* --------------------------------------------------------------- scan -- */
function scanView() {
  app.innerHTML = shell(`
    <h1 class="page">Scan a packet</h1>
    <div class="card">
      <p class="hint" style="margin-top:0">Point the camera at the barcode on the cover sheet to open that job. If the camera
      won't cooperate, type the job number instead — it works the same.</p>
      <div id="reader"></div>
      <div class="row" style="margin-top:12px">
        <button class="btn" id="startScan">Start camera</button>
        <button class="btn sec" id="stopScanBtn" style="display:none">Stop</button>
      </div>
      <div class="hint" id="scanMsg"></div>
    </div>
    <div class="card">
      <h2>Enter job number</h2>
      <div class="row">
        <input id="manual" placeholder="ST-10001" style="flex:1;text-transform:uppercase">
        <button class="btn" id="manualGo">Open</button>
      </div>
    </div>`);
  bindShell();

  const open = async code => {
    try {
      const j = await api('/lookup/' + encodeURIComponent(code));
      if (window.__stopScan) { window.__stopScan(); window.__stopScan = null; }
      toast('Opening ' + j.job_number);
      go('job', { id: j.id });
    } catch (e) { $('#scanMsg').textContent = e.message; toast(e.message, true); }
  };

  $('#manualGo').onclick = () => { const v = $('#manual').value.trim(); if (v) open(v); };
  $('#manual').onkeydown = e => { if (e.key === 'Enter') $('#manualGo').click(); };

  $('#startScan').onclick = async () => {
    const msg = $('#scanMsg');
    if (!window.ZXing) return msg.textContent = 'Scanner library did not load — use the job number box below.';
    try {
      const reader = new ZXing.BrowserMultiFormatReader();
      const video = document.createElement('video');
      video.setAttribute('playsinline', 'true');
      $('#reader').innerHTML = '';
      $('#reader').appendChild(video);
      $('#startScan').style.display = 'none';
      $('#stopScanBtn').style.display = '';
      msg.textContent = 'Looking for a barcode…';
      let handled = false;
      await reader.decodeFromConstraints(
        { video: { facingMode: 'environment' } }, video,
        (result) => { if (result && !handled) { handled = true; open(result.getText()); } });
      window.__stopScan = () => {
        try { reader.reset(); } catch (e) {}
        $('#reader').innerHTML = '';
        const s = $('#startScan'), st = $('#stopScanBtn');
        if (s) s.style.display = '';
        if (st) st.style.display = 'none';
      };
      $('#stopScanBtn').onclick = () => { window.__stopScan(); window.__stopScan = null; msg.textContent = ''; };
    } catch (e) {
      msg.textContent = 'Camera unavailable (' + e.message + '). Use the job number box below.';
      $('#startScan').style.display = '';
      $('#stopScanBtn').style.display = 'none';
    }
  };
}

/* -------------------------------------------------------------- money -- */
async function moneyView() {
  if (!isAdmin()) return myPayView();
  const [statements, invoices, users, clients] = await Promise.all(
    [api('/statements'), api('/invoices'), api('/users'), api('/clients')]);

  app.innerHTML = shell(`
    <h1 class="page">Billing &amp; pay</h1>

    <div class="card">
      <h2>Contractor statements <span class="sub">what you owe your servers</span></h2>
      <p class="hint" style="margin-top:-4px">Pulls every completed serve in the period that hasn't been paid out yet, at the
      per-job rate on the job. Nothing gets counted twice.</p>
      <div class="grid g2" style="margin-top:10px">
        <div class="field"><label>Server</label><select id="s_server">
          ${users.filter(u => u.active).map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></div>
        <div class="row" style="align-items:flex-end;gap:6px">
          <div class="field" style="flex:1;margin:0"><label>From</label><input type="date" id="s_start" value="${firstOfMonth()}"></div>
          <div class="field" style="flex:1;margin:0"><label>To</label><input type="date" id="s_end" value="${todayISO()}"></div>
        </div>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="btn sec sm" id="s_prev">Preview</button>
        <button class="btn sm" id="s_make">Create statement</button>
      </div>
      <div id="s_out"></div>
      ${statements.length ? `<table class="tbl" style="margin-top:14px">
        <tr><th>Server</th><th>Period</th><th class="num">Jobs</th><th class="num">Total</th><th></th><th></th></tr>
        ${statements.map(s => `<tr>
          <td>${esc(s.server_name)}</td><td>${fmtDateOnly(s.period_start)}–${fmtDateOnly(s.period_end)}</td>
          <td class="num">${s.job_count}</td><td class="num">${money(s.total)}</td>
          <td><span class="pill ${cls(s.status)}">${esc(s.status)}</span></td>
          <td class="num"><a href="/print/statement/${s.id}" target="_blank">print</a>
            ${s.status !== 'Paid' ? ` · <a href="#" data-paid="${s.id}">mark paid</a>` : ''}</td>
        </tr>`).join('')}</table>` : ''}
    </div>

    <div class="card">
      <h2>Client invoices</h2>
      <div class="grid g2">
        <div class="field"><label>Client</label><select id="i_client">
          ${clients.filter(c => c.active).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="row" style="align-items:flex-end;gap:6px">
          <div class="field" style="flex:1;margin:0"><label>From</label><input type="date" id="i_start" value="${firstOfMonth()}"></div>
          <div class="field" style="flex:1;margin:0"><label>To</label><input type="date" id="i_end" value="${todayISO()}"></div>
        </div>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="btn sec sm" id="i_prev">Preview</button>
        <button class="btn sm" id="i_make">Create invoice</button>
      </div>
      <div id="i_out"></div>
      ${invoices.length ? `<table class="tbl" style="margin-top:14px">
        <tr><th>Client</th><th>Period</th><th class="num">Jobs</th><th class="num">Total</th><th></th><th></th></tr>
        ${invoices.map(s => `<tr>
          <td>${esc(s.client_name)}</td><td>${fmtDateOnly(s.period_start)}–${fmtDateOnly(s.period_end)}</td>
          <td class="num">${s.job_count}</td><td class="num">${money(s.total)}</td>
          <td><span class="pill ${cls(s.status)}">${esc(s.status)}</span></td>
          <td class="num"><a href="/print/invoice/${s.id}" target="_blank">print</a>
            ${s.status !== 'Paid' ? ` · <a href="#" data-ipaid="${s.id}">mark paid</a>` : ''}</td>
        </tr>`).join('')}</table>` : ''}
    </div>`);
  bindShell();

  const linesTable = (r, key) => r.lines.length
    ? `<table class="tbl" style="margin-top:10px"><tr><th>Date</th><th>Job</th><th>Recipient</th><th class="num">${key === 'pay' ? 'Pay' : 'Fee'}</th></tr>
       ${r.lines.map(l => `<tr><td>${fmtDateOnly(l.served_at)}</td><td>${esc(l.job_number)}</td>
       <td>${esc(l.recipient_name)}</td><td class="num">${money(key === 'pay' ? l.server_pay : l.client_fee)}</td></tr>`).join('')}
       <tr><td colspan="3"><b>${r.count} job(s)</b></td><td class="num"><b>${money(r.total)}</b></td></tr></table>`
    : '<div class="hint">Nothing unbilled in that window.</div>';

  $('#s_prev').onclick = async () => {
    const r = await api('/statements/preview', { method: 'POST', body: JSON.stringify(
      { server_id: $('#s_server').value, start: $('#s_start').value, end: $('#s_end').value }) });
    $('#s_out').innerHTML = linesTable(r, 'pay');
  };
  $('#s_make').onclick = async () => {
    try {
      await api('/statements', { method: 'POST', body: JSON.stringify(
        { server_id: $('#s_server').value, start: $('#s_start').value, end: $('#s_end').value }) });
      toast('Statement created'); go('money');
    } catch (e) { toast(e.message, true); }
  };
  $('#i_prev').onclick = async () => {
    const r = await api('/invoices/preview', { method: 'POST', body: JSON.stringify(
      { client_id: $('#i_client').value, start: $('#i_start').value, end: $('#i_end').value }) });
    $('#i_out').innerHTML = linesTable(r, 'fee');
  };
  $('#i_make').onclick = async () => {
    try {
      await api('/invoices', { method: 'POST', body: JSON.stringify(
        { client_id: $('#i_client').value, start: $('#i_start').value, end: $('#i_end').value }) });
      toast('Invoice created'); go('money');
    } catch (e) { toast(e.message, true); }
  };
  document.querySelectorAll('[data-paid]').forEach(a => a.onclick = async e => {
    e.preventDefault();
    await api('/statements/' + a.dataset.paid, { method: 'PATCH', body: JSON.stringify({ status: 'Paid' }) });
    toast('Marked paid'); go('money');
  });
  document.querySelectorAll('[data-ipaid]').forEach(a => a.onclick = async e => {
    e.preventDefault();
    await api('/invoices/' + a.dataset.ipaid, { method: 'PATCH', body: JSON.stringify({ status: 'Paid' }) });
    toast('Marked paid'); go('money');
  });
}

function firstOfMonth() {
  const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

async function myPayView() {
  const [statements, stats] = await Promise.all([api('/statements'), api('/stats')]);
  app.innerHTML = shell(`
    <h1 class="page">My pay</h1>
    <div class="stats">
      <div class="stat good"><div class="n">${money(stats.unbilled)}</div><div class="l">Earned, not yet on a statement</div></div>
      <div class="stat"><div class="n">${stats.served_7d}</div><div class="l">Serves completed, 7 days</div></div>
    </div>
    <div class="card"><h2>Statements</h2>
    ${statements.length ? `<table class="tbl">
      <tr><th>Period</th><th class="num">Jobs</th><th class="num">Total</th><th></th><th></th></tr>
      ${statements.map(s => `<tr><td>${fmtDateOnly(s.period_start)}–${fmtDateOnly(s.period_end)}</td>
        <td class="num">${s.job_count}</td><td class="num">${money(s.total)}</td>
        <td><span class="pill ${cls(s.status)}">${esc(s.status)}</span></td>
        <td class="num"><a href="/print/statement/${s.id}" target="_blank">print</a></td></tr>`).join('')}
      </table>` : '<div class="empty">No statements yet.</div>'}
    </div>
    <div class="card"><h2>Change password</h2>
      <div class="field"><input id="npw" type="password" placeholder="New password (8+ characters)"></div>
      <button class="btn sm" id="savePw">Update</button></div>`);
  bindShell();
  $('#savePw').onclick = async () => {
    try { await api('/me/password', { method: 'POST', body: JSON.stringify({ password: $('#npw').value }) }); toast('Password updated'); }
    catch (e) { toast(e.message, true); }
  };
}

/* -------------------------------------------------------------- admin -- */
async function adminView() {
  const [users, clients, templates] = await Promise.all([api('/users'), api('/clients'), api('/templates')]);
  app.innerHTML = shell(`
    <h1 class="page">Setup</h1>

    <div class="card">
      <h2>Team <span class="sub">${users.length}</span></h2>
      <table class="tbl">
        <tr><th>Name</th><th>Role</th><th class="num">Rate</th><th></th></tr>
        ${users.map(u => `<tr><td>${esc(u.name)}<div class="hint">${esc(u.email)}</div></td>
          <td>${esc(u.role)}${u.active ? '' : ' <span class="pill">off</span>'}</td>
          <td class="num">${money(u.default_pay)}</td>
          <td class="num"><a href="#" data-user="${u.id}">edit</a></td></tr>`).join('')}
      </table>
      <button class="btn sec block sm" id="newUser" style="margin-top:10px">+ Add person</button>
    </div>

    <div class="card">
      <h2>Clients <span class="sub">${clients.length}</span></h2>
      <table class="tbl">
        <tr><th>Name</th><th class="num">Default fee</th><th></th></tr>
        ${clients.map(c => `<tr><td>${esc(c.name)}<div class="hint">${esc(c.contact_name || '')} ${esc(c.phone || '')}</div></td>
          <td class="num">${money(c.default_fee)}</td>
          <td class="num"><a href="#" data-client="${c.id}">edit</a></td></tr>`).join('')}
      </table>
      <button class="btn sec block sm" id="newClient" style="margin-top:10px">+ Add client</button>
    </div>

    <div class="card">
      <h2>Affidavit templates <span class="sub">${templates.length}</span></h2>
      <p class="hint" style="margin-top:-4px">Write your own wording per county or client. Merge fields fill in from the job,
      including the full attempt log with GPS.</p>
      <table class="tbl">
        ${templates.map(t => `<tr><td>${esc(t.name)}<div class="hint">${esc(t.jurisdiction || '')}</div></td>
          <td>${t.is_default ? '<span class="pill Served">default</span>' : ''}</td>
          <td class="num"><a href="#" data-tpl="${t.id}">edit</a></td></tr>`).join('')}
      </table>
      <button class="btn sec block sm" id="newTpl" style="margin-top:10px">+ New template</button>
    </div>

    <div class="card">
      <h2>My account</h2>
      <div class="field"><label>New password</label><input id="npw" type="password" placeholder="8+ characters"></div>
      <button class="btn sm" id="savePw">Update password</button>
    </div>`);
  bindShell();

  document.querySelectorAll('[data-user]').forEach(a => a.onclick = e => {
    e.preventDefault(); userForm(users.find(u => String(u.id) === a.dataset.user));
  });
  document.querySelectorAll('[data-client]').forEach(a => a.onclick = e => {
    e.preventDefault(); clientForm(clients.find(c => String(c.id) === a.dataset.client));
  });
  document.querySelectorAll('[data-tpl]').forEach(a => a.onclick = e => {
    e.preventDefault(); templateForm(templates.find(t => String(t.id) === a.dataset.tpl));
  });
  $('#newUser').onclick = () => userForm(null);
  $('#newClient').onclick = () => clientForm(null);
  $('#newTpl').onclick = () => templateForm(null);
  $('#savePw').onclick = async () => {
    try { await api('/me/password', { method: 'POST', body: JSON.stringify({ password: $('#npw').value }) }); toast('Password updated'); }
    catch (e) { toast(e.message, true); }
  };
}

function userForm(u) {
  const v = u || { role: 'server', active: true };
  sheet(u ? 'Edit ' + u.name : 'Add person', `
    <div class="field"><label>Name</label><input id="u_name" value="${esc(v.name)}"></div>
    <div class="field"><label>Email (used to sign in)</label><input id="u_email" type="email" value="${esc(v.email)}"></div>
    <div class="field"><label>${u ? 'New password (leave blank to keep)' : 'Password'}</label><input id="u_password" type="text" placeholder="${u ? 'unchanged' : 'set a password'}"></div>
    <div class="grid g2">
      <div class="field"><label>Role</label><select id="u_role">
        <option value="server" ${v.role === 'server' ? 'selected' : ''}>Field server</option>
        <option value="admin" ${v.role === 'admin' ? 'selected' : ''}>Admin</option></select></div>
      <div class="field"><label>Default pay per serve</label><input id="u_default_pay" type="number" step="0.01" value="${v.default_pay || ''}"></div>
      <div class="field"><label>Phone</label><input id="u_phone" value="${esc(v.phone)}"></div>
      <div class="field"><label>License / registration #</label><input id="u_license_no" value="${esc(v.license_no)}"></div>
    </div>
    ${u ? `<div class="field"><label>Status</label><select id="u_active">
      <option value="true" ${v.active ? 'selected' : ''}>Active</option>
      <option value="false" ${!v.active ? 'selected' : ''}>Deactivated</option></select></div>` : ''}
    <div class="row"><button class="btn" id="save">Save</button>
    <button class="btn sec" onclick="closeSheet()">Cancel</button></div>`, el => {
    el.querySelector('#save').onclick = async () => {
      const body = {
        name: el.querySelector('#u_name').value, email: el.querySelector('#u_email').value,
        role: el.querySelector('#u_role').value, phone: el.querySelector('#u_phone').value,
        license_no: el.querySelector('#u_license_no').value,
        default_pay: el.querySelector('#u_default_pay').value || 0
      };
      const pw = el.querySelector('#u_password').value;
      if (pw) body.password = pw;
      if (u) body.active = el.querySelector('#u_active').value === 'true';
      try {
        await (u ? api('/users/' + u.id, { method: 'PATCH', body: JSON.stringify(body) })
                 : api('/users', { method: 'POST', body: JSON.stringify(body) }));
        closeSheet(); toast('Saved'); go('admin');
      } catch (e) { toast(e.message, true); }
    };
  });
}

function clientForm(c) {
  const v = c || {};
  sheet(c ? 'Edit ' + c.name : 'Add client', `
    <div class="field"><label>Firm / client name</label><input id="c_name" value="${esc(v.name)}"></div>
    <div class="grid g2">
      <div class="field"><label>Contact</label><input id="c_contact_name" value="${esc(v.contact_name)}"></div>
      <div class="field"><label>Phone</label><input id="c_phone" value="${esc(v.phone)}"></div>
      <div class="field"><label>Email</label><input id="c_email" type="email" value="${esc(v.email)}"></div>
      <div class="field"><label>Default fee per serve</label><input id="c_default_fee" type="number" step="0.01" value="${v.default_fee || ''}"></div>
    </div>
    <div class="field"><label>Billing address</label><textarea id="c_address" style="min-height:60px">${esc(v.address)}</textarea></div>
    <div class="field"><label>Notes</label><textarea id="c_notes" style="min-height:60px">${esc(v.notes)}</textarea></div>
    <div class="row"><button class="btn" id="save">Save</button>
    <button class="btn sec" onclick="closeSheet()">Cancel</button></div>`, el => {
    el.querySelector('#save').onclick = async () => {
      const body = {};
      ['name','contact_name','phone','email','default_fee','address','notes']
        .forEach(f => body[f] = el.querySelector('#c_' + f).value);
      try {
        await (c ? api('/clients/' + c.id, { method: 'PATCH', body: JSON.stringify(body) })
                 : api('/clients', { method: 'POST', body: JSON.stringify(body) }));
        closeSheet(); toast('Saved'); go('admin');
      } catch (e) { toast(e.message, true); }
    };
  });
}

async function templateForm(t) {
  const fields = await api('/template-fields');
  const v = t || { body: '', is_default: false };
  sheet(t ? 'Edit template' : 'New affidavit template', `
    <div class="grid g2">
      <div class="field"><label>Template name</label><input id="t_name" value="${esc(v.name)}"></div>
      <div class="field"><label>Jurisdiction / court</label><input id="t_jurisdiction" value="${esc(v.jurisdiction)}"></div>
    </div>
    <div class="field"><label>Body</label>
      <textarea id="t_body" style="min-height:220px;font:12.5px/1.5 'Courier New',monospace">${esc(v.body)}</textarea>
      <div class="hint">Click a field to insert it at the cursor:</div>
      <div class="tokens">${fields.map(f => `<button data-f="${f[0]}" title="${esc(f[1])}">{{${f[0]}}}</button>`).join('')}</div>
    </div>
    <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="t_default" style="width:auto" ${v.is_default ? 'checked' : ''}> Use as the default template</label>
    <div class="row" style="margin-top:12px">
      <button class="btn" id="save">Save</button>
      <button class="btn sec" id="preview">Preview with real job</button>
      <button class="btn sec" onclick="closeSheet()">Cancel</button>
      ${t ? '<button class="btn ghost" id="del" style="color:var(--bad);margin-left:auto">Delete</button>' : ''}
    </div>
    <pre class="prev" id="tprev" style="display:none;margin-top:12px"></pre>`, el => {
    const ta = el.querySelector('#t_body');
    el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
      const tok = '{{' + b.dataset.f + '}}';
      const s = ta.selectionStart, e = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + tok + ta.value.slice(e);
      ta.focus(); ta.selectionStart = ta.selectionEnd = s + tok.length;
    });
    el.querySelector('#preview').onclick = async () => {
      const r = await api('/templates/preview', { method: 'POST', body: JSON.stringify({ body: ta.value }) });
      const p = el.querySelector('#tprev');
      p.style.display = ''; p.textContent = r.text;
    };
    el.querySelector('#save').onclick = async () => {
      const body = {
        name: el.querySelector('#t_name').value, jurisdiction: el.querySelector('#t_jurisdiction').value,
        body: ta.value, is_default: el.querySelector('#t_default').checked
      };
      if (!body.name.trim()) return toast('Give the template a name', true);
      try {
        await (t ? api('/templates/' + t.id, { method: 'PATCH', body: JSON.stringify(body) })
                 : api('/templates', { method: 'POST', body: JSON.stringify(body) }));
        closeSheet(); toast('Saved'); go('admin');
      } catch (e) { toast(e.message, true); }
    };
    if (el.querySelector('#del')) el.querySelector('#del').onclick = async () => {
      if (!confirm('Delete this template?')) return;
      await api('/templates/' + t.id, { method: 'DELETE' });
      closeSheet(); toast('Deleted'); go('admin');
    };
  });
}

/* --------------------------------------------------------------- boot -- */
const VIEWS = { dash: dashView, jobs: jobsView, job: jobView, scan: scanView, money: moneyView, admin: adminView };

async function render() {
  closeSheet();
  if (!S.me) return loginView();
  if (S.view === 'jobs') S.cache.jobFilter = S.params;
  const fn = VIEWS[S.view] || dashView;
  try {
    app.innerHTML = '<div class="wrap"><div class="empty">Loading…</div></div>';
    await fn();
  } catch (e) {
    if (S.me) { app.innerHTML = shell(`<div class="card"><div class="empty">${esc(e.message)}</div></div>`); bindShell(); }
  }
}

(async function boot() {
  try { S.me = await api('/me'); } catch (e) { S.me = null; }
  render();
})();
})();
