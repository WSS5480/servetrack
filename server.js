const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { q, init } = require('./db');
const code128 = require('./code128');
const merge = require('./merge');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TZ = process.env.TIMEZONE || 'America/New_York';

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
// Serve only these files from the project root — everything else is server-side.
const PUBLIC_FILES = {
  '/index.html': 'index.html',
  '/client.js': 'client.js',
  '/client.css': 'client.css',
  '/zxing.min.js': 'zxing.min.js'
};
app.get(Object.keys(PUBLIC_FILES), (req, res) => {
  res.sendFile(path.join(__dirname, PUBLIC_FILES[req.path]));
});

/* ---------------------------------------------------------------- auth --- */

function sign(user) {
  return jwt.sign({ id: user.id, role: user.role, name: user.name }, SECRET, { expiresIn: '30d' });
}

async function auth(req, res, next) {
  const token = req.cookies.st_token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const payload = jwt.verify(token, SECRET);
    const { rows } = await q('SELECT id,name,email,role,license_no,default_pay,active FROM users WHERE id=$1', [payload.id]);
    if (!rows.length || !rows[0].active) return res.status(401).json({ error: 'Account inactive' });
    req.user = rows[0];
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired' });
  }
}

const admin = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' });

const wrap = fn => (req, res) =>
  fn(req, res).catch(err => {
    console.error(err);
    res.status(500).json({ error: err.message || 'Server error' });
  });

app.post('/api/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { rows } = await q('SELECT * FROM users WHERE lower(email)=$1', [email]);
  const user = rows[0];
  if (!user || !user.active || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  res.cookie('st_token', sign(user), {
    httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5,
    secure: process.env.NODE_ENV === 'production'
  });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
}));

app.post('/api/logout', (req, res) => { res.clearCookie('st_token'); res.json({ ok: true }); });

app.get('/api/me', auth, (req, res) => res.json(req.user));

app.post('/api/me/password', auth, wrap(async (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(pw, 10), req.user.id]);
  res.json({ ok: true });
}));

/* --------------------------------------------------------------- users --- */

app.get('/api/users', auth, wrap(async (req, res) => {
  const { rows } = await q(
    'SELECT id,name,email,role,phone,license_no,county,default_pay,active FROM users ORDER BY active DESC, name'
  );
  res.json(rows);
}));

app.post('/api/users', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  const hash = await bcrypt.hash(String(b.password || 'changeme123'), 10);
  const { rows } = await q(
    `INSERT INTO users (name,email,password_hash,role,phone,license_no,county,default_pay)
     VALUES ($1,lower($2),$3,$4,$5,$6,$7,$8) RETURNING id,name,email,role,phone,license_no,county,default_pay,active`,
    [b.name, b.email, hash, b.role || 'server', b.phone || null, b.license_no || null, b.county || null, b.default_pay || 0]
  );
  res.json(rows[0]);
}));

app.patch('/api/users/:id', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  if (b.password) {
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(String(b.password), 10), req.params.id]);
  }
  const { rows } = await q(
    `UPDATE users SET name=COALESCE($1,name), email=COALESCE(lower($2),email), role=COALESCE($3,role),
       phone=COALESCE($4,phone), license_no=COALESCE($5,license_no), county=COALESCE($6,county),
       default_pay=COALESCE($7,default_pay), active=COALESCE($8,active)
     WHERE id=$9 RETURNING id,name,email,role,phone,license_no,county,default_pay,active`,
    [b.name, b.email, b.role, b.phone, b.license_no, b.county, b.default_pay, b.active, req.params.id]
  );
  res.json(rows[0]);
}));

/* ------------------------------------------------------------- clients --- */

app.get('/api/clients', auth, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM clients ORDER BY active DESC, name');
  res.json(rows);
}));

app.post('/api/clients', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  const { rows } = await q(
    `INSERT INTO clients (name,contact_name,email,phone,address,default_fee,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.name, b.contact_name || null, b.email || null, b.phone || null, b.address || null, b.default_fee || 0, b.notes || null]
  );
  res.json(rows[0]);
}));

app.patch('/api/clients/:id', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  const { rows } = await q(
    `UPDATE clients SET name=COALESCE($1,name), contact_name=COALESCE($2,contact_name),
       email=COALESCE($3,email), phone=COALESCE($4,phone), address=COALESCE($5,address),
       default_fee=COALESCE($6,default_fee), notes=COALESCE($7,notes), active=COALESCE($8,active)
     WHERE id=$9 RETURNING *`,
    [b.name, b.contact_name, b.email, b.phone, b.address, b.default_fee, b.notes, b.active, req.params.id]
  );
  res.json(rows[0]);
}));

/* ---------------------------------------------------------------- jobs --- */

const JOB_SELECT = `
  SELECT j.*, c.name AS client_name, u.name AS server_name,
         (SELECT count(*)::int FROM attempts a WHERE a.job_id=j.id) AS attempt_count,
         (SELECT max(a.attempted_at) FROM attempts a WHERE a.job_id=j.id) AS last_attempt
  FROM jobs j
  LEFT JOIN clients c ON c.id=j.client_id
  LEFT JOIN users u ON u.id=j.assigned_to`;

async function nextJobNumber() {
  const { rows } = await q("SELECT count(*)::int AS n FROM jobs");
  return 'ST-' + String(10000 + rows[0].n + 1);
}

app.get('/api/jobs', auth, wrap(async (req, res) => {
  const where = [];
  const params = [];
  // pushes a value and returns its placeholder, e.g. "$1"
  const p = val => { params.push(val); return '$' + params.length; };

  if (req.user.role !== 'admin') where.push('j.assigned_to = ' + p(req.user.id));
  else if (req.query.assigned_to) where.push('j.assigned_to = ' + p(req.query.assigned_to));

  if (req.query.status) where.push('j.status = ' + p(req.query.status));
  if (req.query.client_id) where.push('j.client_id = ' + p(req.query.client_id));
  if (req.query.open === '1') where.push("j.status IN ('Pending','Assigned','Attempted','On Hold')");
  if (req.query.q) {
    const i = p('%' + req.query.q + '%');
    where.push(`(j.recipient_name ILIKE ${i} OR j.case_number ILIKE ${i} OR j.job_number ILIKE ${i}
      OR j.address1 ILIKE ${i} OR j.defendant ILIKE ${i} OR j.plaintiff ILIKE ${i} OR j.city ILIKE ${i})`);
  }
  const sql = JOB_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ` ORDER BY CASE j.priority WHEN 'Same Day' THEN 0 WHEN 'Rush' THEN 1 ELSE 2 END,
             j.due_date NULLS LAST, j.id DESC LIMIT 500`;
  const { rows } = await q(sql, params);
  res.json(rows);
}));

app.get('/api/jobs/:id', auth, wrap(async (req, res) => {
  const { rows } = await q(JOB_SELECT + ' WHERE j.id=$1', [req.params.id]);
  const job = rows[0];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (req.user.role !== 'admin' && job.assigned_to !== req.user.id) {
    return res.status(403).json({ error: 'Not your job' });
  }
  const att = await q(
    `SELECT a.*, u.name AS server_name FROM attempts a
     LEFT JOIN users u ON u.id=a.server_id WHERE a.job_id=$1 ORDER BY a.attempted_at`,
    [req.params.id]
  );
  job.attempts = att.rows;
  res.json(job);
}));

// Barcode scan lookup: accepts job number or raw id
app.get('/api/lookup/:code', auth, wrap(async (req, res) => {
  const code = String(req.params.code).trim().toUpperCase();
  const { rows } = await q(
    'SELECT id, job_number, recipient_name, status, assigned_to FROM jobs WHERE upper(job_number)=$1 OR CAST(id AS TEXT)=$1',
    [code]
  );
  if (!rows.length) return res.status(404).json({ error: 'No job matches ' + code });
  if (req.user.role !== 'admin' && rows[0].assigned_to !== req.user.id) {
    return res.status(403).json({ error: 'That job is not assigned to you' });
  }
  res.json(rows[0]);
}));

const JOB_FIELDS = ['client_id','case_number','court','plaintiff','defendant','recipient_name','recipient_notes',
  'address1','address2','city','state','zip','service_type','documents','priority','due_date','status',
  'assigned_to','client_fee','server_pay','notes'];

app.post('/api/jobs', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  const vals = JOB_FIELDS.map(f => (b[f] === '' || b[f] === undefined ? null : b[f]));
  const jn = await nextJobNumber();
  const cols = JOB_FIELDS.join(',');
  const ph = JOB_FIELDS.map((_, i) => '$' + (i + 2)).join(',');
  const { rows } = await q(
    `INSERT INTO jobs (job_number,${cols}) VALUES ($1,${ph}) RETURNING *`, [jn, ...vals]
  );
  if (rows[0].assigned_to && rows[0].status === 'Pending') {
    await q("UPDATE jobs SET status='Assigned' WHERE id=$1", [rows[0].id]);
    rows[0].status = 'Assigned';
  }
  res.json(rows[0]);
}));

app.patch('/api/jobs/:id', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  const sets = [];
  const params = [];
  for (const f of JOB_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(b, f)) {
      params.push(b[f] === '' ? null : b[f]);
      sets.push(`${f}=$${params.length}`);
    }
  }
  if (!sets.length) return res.json({ ok: true });
  params.push(req.params.id);
  const { rows } = await q(
    `UPDATE jobs SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`, params
  );
  res.json(rows[0]);
}));

app.delete('/api/jobs/:id', auth, admin, wrap(async (req, res) => {
  await q('DELETE FROM jobs WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------ attempts --- */

app.post('/api/jobs/:id/attempts', auth, wrap(async (req, res) => {
  const { rows: jr } = await q('SELECT * FROM jobs WHERE id=$1', [req.params.id]);
  const job = jr[0];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (req.user.role !== 'admin' && job.assigned_to !== req.user.id) {
    return res.status(403).json({ error: 'Not your job' });
  }
  const b = req.body;
  const addr = [job.address1, job.city, job.state, job.zip].filter(Boolean).join(', ');
  const { rows } = await q(
    `INSERT INTO attempts (job_id,server_id,attempted_at,outcome,manner,person_served,relationship,
       description,notes,lat,lng,accuracy_m,address_used)
     VALUES ($1,$2,COALESCE($3,NOW()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [job.id, req.user.id, b.attempted_at || null, b.outcome, b.manner || null, b.person_served || null,
     b.relationship || null, b.description || null, b.notes || null,
     b.lat ?? null, b.lng ?? null, b.accuracy_m ?? null, addr]
  );
  const a = rows[0];

  if (a.outcome === 'Served') {
    await q(
      `UPDATE jobs SET status='Served', served_at=$1, served_manner=$2, served_person=$3, updated_at=NOW()
       WHERE id=$4`,
      [a.attempted_at, a.manner || 'Personal', a.person_served || job.recipient_name, job.id]
    );
  } else if (['Pending', 'Assigned'].includes(job.status)) {
    await q("UPDATE jobs SET status='Attempted', updated_at=NOW() WHERE id=$1", [job.id]);
  }
  res.json(a);
}));

app.delete('/api/attempts/:id', auth, admin, wrap(async (req, res) => {
  await q('DELETE FROM attempts WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

/* --------------------------------------------------------- route my day --- */

app.get('/api/route', auth, wrap(async (req, res) => {
  const serverId = req.user.role === 'admin' && req.query.server_id ? req.query.server_id : req.user.id;
  const { rows } = await q(
    `SELECT id, job_number, recipient_name, address1, address2, city, state, zip, priority, due_date, status
     FROM jobs
     WHERE assigned_to=$1 AND status IN ('Pending','Assigned','Attempted')
     ORDER BY CASE priority WHEN 'Same Day' THEN 0 WHEN 'Rush' THEN 1 ELSE 2 END, due_date NULLS LAST`,
    [serverId]
  );
  res.json(rows);
}));

/* ----------------------------------------------------------- templates --- */

app.get('/api/template-fields', auth, (req, res) => res.json(merge.FIELDS));

app.get('/api/templates', auth, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM affidavit_templates ORDER BY is_default DESC, name');
  res.json(rows);
}));

app.post('/api/templates', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  if (b.is_default) await q('UPDATE affidavit_templates SET is_default=FALSE');
  const { rows } = await q(
    'INSERT INTO affidavit_templates (name,jurisdiction,body,is_default) VALUES ($1,$2,$3,$4) RETURNING *',
    [b.name, b.jurisdiction || null, b.body || '', !!b.is_default]
  );
  res.json(rows[0]);
}));

app.patch('/api/templates/:id', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  if (b.is_default) await q('UPDATE affidavit_templates SET is_default=FALSE');
  const { rows } = await q(
    `UPDATE affidavit_templates SET name=COALESCE($1,name), jurisdiction=COALESCE($2,jurisdiction),
       body=COALESCE($3,body), is_default=COALESCE($4,is_default), updated_at=NOW()
     WHERE id=$5 RETURNING *`,
    [b.name, b.jurisdiction, b.body, b.is_default, req.params.id]
  );
  res.json(rows[0]);
}));

app.delete('/api/templates/:id', auth, admin, wrap(async (req, res) => {
  await q('DELETE FROM affidavit_templates WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

async function affidavitText(jobId, templateId) {
  const { rows: jr } = await q(
    'SELECT j.*, c.name AS c_name FROM jobs j LEFT JOIN clients c ON c.id=j.client_id WHERE j.id=$1', [jobId]
  );
  const job = jr[0];
  if (!job) return null;
  const { rows: attempts } = await q('SELECT * FROM attempts WHERE job_id=$1 ORDER BY attempted_at', [jobId]);
  const servedBy = attempts.find(a => a.outcome === 'Served') || attempts[attempts.length - 1];
  const sid = (servedBy && servedBy.server_id) || job.assigned_to;
  const { rows: ur } = sid
    ? await q('SELECT * FROM users WHERE id=$1', [sid])
    : { rows: [] };
  const tpl = templateId
    ? (await q('SELECT * FROM affidavit_templates WHERE id=$1', [templateId])).rows[0]
    : (await q('SELECT * FROM affidavit_templates ORDER BY is_default DESC, id LIMIT 1')).rows[0];
  if (!tpl) return null;
  const ctx = merge.buildContext(job, attempts, ur[0], { name: job.c_name }, TZ);
  return { job, template: tpl, text: merge.render(tpl.body, ctx) };
}

app.get('/api/jobs/:id/affidavit', auth, wrap(async (req, res) => {
  const out = await affidavitText(req.params.id, req.query.template_id);
  if (!out) return res.status(404).json({ error: 'Job or template not found' });
  res.json({ text: out.text, template_id: out.template.id, template_name: out.template.name });
}));

// Live preview while editing a template
app.post('/api/templates/preview', auth, admin, wrap(async (req, res) => {
  const { rows: jr } = req.body.job_id
    ? await q('SELECT j.*, c.name AS c_name FROM jobs j LEFT JOIN clients c ON c.id=j.client_id WHERE j.id=$1', [req.body.job_id])
    : await q(`SELECT j.*, c.name AS c_name FROM jobs j LEFT JOIN clients c ON c.id=j.client_id
               ORDER BY (j.status='Served') DESC, j.id DESC LIMIT 1`);
  if (!jr.length) return res.json({ text: merge.render(req.body.body || '', {}) });
  const job = jr[0];
  const { rows: attempts } = await q('SELECT * FROM attempts WHERE job_id=$1 ORDER BY attempted_at', [job.id]);
  const { rows: ur } = job.assigned_to ? await q('SELECT * FROM users WHERE id=$1', [job.assigned_to]) : { rows: [] };
  const ctx = merge.buildContext(job, attempts, ur[0], { name: job.c_name }, TZ);
  res.json({ text: merge.render(req.body.body || '', ctx), job_number: job.job_number });
}));

/* ---------------------------------------------------------- statements --- */

app.get('/api/statements', auth, wrap(async (req, res) => {
  const own = req.user.role !== 'admin' ? ' WHERE s.server_id=' + req.user.id : '';
  const { rows } = await q(
    `SELECT s.*, u.name AS server_name FROM statements s
     JOIN users u ON u.id=s.server_id ${own} ORDER BY s.created_at DESC`
  );
  res.json(rows);
}));

app.post('/api/statements/preview', auth, admin, wrap(async (req, res) => {
  const { server_id, start, end } = req.body;
  const { rows } = await q(
    `SELECT j.id, j.job_number, j.recipient_name, j.served_at, j.server_pay, j.status, c.name AS client_name
     FROM jobs j LEFT JOIN clients c ON c.id=j.client_id
     WHERE j.assigned_to=$1 AND j.statement_id IS NULL AND j.status='Served'
       AND j.served_at::date BETWEEN $2 AND $3
     ORDER BY j.served_at`,
    [server_id, start, end]
  );
  const total = rows.reduce((s, r) => s + Number(r.server_pay || 0), 0);
  res.json({ lines: rows, total, count: rows.length });
}));

app.post('/api/statements', auth, admin, wrap(async (req, res) => {
  const { server_id, start, end } = req.body;
  const { rows: lines } = await q(
    `SELECT id, server_pay FROM jobs
     WHERE assigned_to=$1 AND statement_id IS NULL AND status='Served' AND served_at::date BETWEEN $2 AND $3`,
    [server_id, start, end]
  );
  if (!lines.length) return res.status(400).json({ error: 'No unbilled completed serves in that period' });
  const total = lines.reduce((s, r) => s + Number(r.server_pay || 0), 0);
  const { rows } = await q(
    `INSERT INTO statements (server_id,period_start,period_end,total,job_count)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [server_id, start, end, total, lines.length]
  );
  await q('UPDATE jobs SET statement_id=$1 WHERE id = ANY($2::int[])', [rows[0].id, lines.map(l => l.id)]);
  res.json(rows[0]);
}));

app.patch('/api/statements/:id', auth, admin, wrap(async (req, res) => {
  const paid = req.body.status === 'Paid';
  const { rows } = await q(
    'UPDATE statements SET status=$1, paid_at=$2 WHERE id=$3 RETURNING *',
    [req.body.status, paid ? new Date() : null, req.params.id]
  );
  res.json(rows[0]);
}));

app.delete('/api/statements/:id', auth, admin, wrap(async (req, res) => {
  await q('UPDATE jobs SET statement_id=NULL WHERE statement_id=$1', [req.params.id]);
  await q('DELETE FROM statements WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------ invoices --- */

app.get('/api/invoices', auth, admin, wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT i.*, c.name AS client_name FROM invoices i JOIN clients c ON c.id=i.client_id
     ORDER BY i.created_at DESC`
  );
  res.json(rows);
}));

app.post('/api/invoices/preview', auth, admin, wrap(async (req, res) => {
  const { client_id, start, end } = req.body;
  const { rows } = await q(
    `SELECT id, job_number, recipient_name, case_number, served_at, client_fee, status FROM jobs
     WHERE client_id=$1 AND invoice_id IS NULL AND status IN ('Served','Non-Est')
       AND COALESCE(served_at, updated_at)::date BETWEEN $2 AND $3
     ORDER BY served_at`,
    [client_id, start, end]
  );
  res.json({ lines: rows, total: rows.reduce((s, r) => s + Number(r.client_fee || 0), 0), count: rows.length });
}));

app.post('/api/invoices', auth, admin, wrap(async (req, res) => {
  const { client_id, start, end } = req.body;
  const { rows: lines } = await q(
    `SELECT id, client_fee FROM jobs WHERE client_id=$1 AND invoice_id IS NULL
     AND status IN ('Served','Non-Est') AND COALESCE(served_at, updated_at)::date BETWEEN $2 AND $3`,
    [client_id, start, end]
  );
  if (!lines.length) return res.status(400).json({ error: 'Nothing unbilled in that period' });
  const total = lines.reduce((s, r) => s + Number(r.client_fee || 0), 0);
  const { rows } = await q(
    'INSERT INTO invoices (client_id,period_start,period_end,total,job_count) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [client_id, start, end, total, lines.length]
  );
  await q('UPDATE jobs SET invoice_id=$1 WHERE id = ANY($2::int[])', [rows[0].id, lines.map(l => l.id)]);
  res.json(rows[0]);
}));

app.patch('/api/invoices/:id', auth, admin, wrap(async (req, res) => {
  const paid = req.body.status === 'Paid';
  const { rows } = await q('UPDATE invoices SET status=$1, paid_at=$2 WHERE id=$3 RETURNING *',
    [req.body.status, paid ? new Date() : null, req.params.id]);
  res.json(rows[0]);
}));

/* --------------------------------------------------------------- stats --- */

app.get('/api/stats', auth, wrap(async (req, res) => {
  const mine = req.user.role !== 'admin' ? ' AND assigned_to=' + req.user.id : '';
  const { rows } = await q(`
    SELECT
      count(*) FILTER (WHERE status IN ('Pending','Assigned','Attempted','On Hold'))::int AS open_jobs,
      count(*) FILTER (WHERE status='Pending')::int AS unassigned,
      count(*) FILTER (WHERE status IN ('Pending','Assigned','Attempted')
                       AND due_date IS NOT NULL AND due_date < CURRENT_DATE)::int AS overdue,
      count(*) FILTER (WHERE status='Served' AND served_at > NOW() - INTERVAL '7 days')::int AS served_7d,
      count(*) FILTER (WHERE priority IN ('Rush','Same Day')
                       AND status IN ('Pending','Assigned','Attempted'))::int AS rush
    FROM jobs WHERE 1=1 ${mine}`);
  const unbilled = req.user.role === 'admin'
    ? (await q(`SELECT COALESCE(sum(client_fee),0)::float AS v FROM jobs WHERE invoice_id IS NULL AND status='Served'`)).rows[0].v
    : (await q(`SELECT COALESCE(sum(server_pay),0)::float AS v FROM jobs WHERE statement_id IS NULL AND status='Served' AND assigned_to=$1`, [req.user.id])).rows[0].v;
  res.json({ ...rows[0], unbilled });
}));

/* ------------------------------------------------------ barcode + print --- */

app.get('/barcode/:code.svg', (req, res) => {
  res.type('image/svg+xml').send(code128.toSVG(req.params.code, { height: 55, moduleWidth: 2 }));
});

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const printPage = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font:13px/1.55 "Courier New",monospace;max-width:7.6in;margin:0 auto;padding:.5in;color:#111}
 h1{font:600 16px/1.3 system-ui;margin:0 0 4px} h2{font:600 13px/1.3 system-ui;margin:18px 0 6px}
 pre{white-space:pre-wrap;font:inherit;margin:0}
 table{width:100%;border-collapse:collapse;font:12px/1.4 system-ui;margin-top:10px}
 th,td{border-bottom:1px solid #ddd;padding:6px 4px;text-align:left}
 th{font-weight:600;border-bottom:1.5px solid #333}
 td.num,th.num{text-align:right}
 .meta{font:12px/1.5 system-ui;color:#444;margin-bottom:14px}
 .tot{font-weight:700;border-top:1.5px solid #333;border-bottom:none}
 .bar{margin:14px 0;text-align:center}
 .noprint{margin:20px 0;text-align:center}
 button{font:14px system-ui;padding:9px 18px;border:1px solid #333;background:#111;color:#fff;border-radius:6px}
 @media print{.noprint{display:none}body{padding:0}}
</style></head><body>${body}
<div class="noprint"><button onclick="window.print()">Print / Save as PDF</button></div>
</body></html>`;

app.get('/print/affidavit/:id', auth, wrap(async (req, res) => {
  const out = await affidavitText(req.params.id, req.query.template_id);
  if (!out) return res.status(404).send('Not found');
  res.send(printPage(`Affidavit ${out.job.job_number}`, `<pre>${esc(out.text)}</pre>`));
}));

app.get('/print/coversheet/:id', auth, wrap(async (req, res) => {
  const { rows } = await q(
    'SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id=j.client_id WHERE j.id=$1',
    [req.params.id]
  );
  const j = rows[0];
  if (!j) return res.status(404).send('Not found');
  const addr = [j.address1, j.address2, [j.city, j.state, j.zip].filter(Boolean).join(' ')].filter(Boolean).join('<br>');
  res.send(printPage('Cover sheet ' + j.job_number, `
    <h1>SERVICE COVER SHEET</h1>
    <div class="bar">${code128.toSVG(j.job_number, { height: 60, moduleWidth: 2.2 })}</div>
    <table>
      <tr><th style="width:32%">Job</th><td>${esc(j.job_number)} &nbsp;·&nbsp; ${esc(j.priority)}</td></tr>
      <tr><th>Client</th><td>${esc(j.client_name)}</td></tr>
      <tr><th>Case</th><td>${esc(j.case_number)} — ${esc(j.court)}</td></tr>
      <tr><th>Plaintiff</th><td>${esc(j.plaintiff)}</td></tr>
      <tr><th>Defendant</th><td>${esc(j.defendant)}</td></tr>
      <tr><th>Serve</th><td><b>${esc(j.recipient_name)}</b></td></tr>
      <tr><th>Address</th><td>${addr}</td></tr>
      <tr><th>Documents</th><td>${esc(j.documents)}</td></tr>
      <tr><th>Service type</th><td>${esc(j.service_type)}</td></tr>
      <tr><th>Due</th><td>${j.due_date ? new Date(j.due_date).toLocaleDateString('en-US', { timeZone: 'UTC' }) : '—'}</td></tr>
      <tr><th>Notes</th><td>${esc(j.recipient_notes || j.notes)}</td></tr>
    </table>
    <p style="font:11px system-ui;color:#555;margin-top:16px">
      Scan the barcode in ServeTrack (Scan tab) to open this job on your phone.</p>`));
}));

app.get('/print/statement/:id', auth, wrap(async (req, res) => {
  const { rows: sr } = await q(
    'SELECT s.*, u.name AS server_name, u.license_no, u.email FROM statements s JOIN users u ON u.id=s.server_id WHERE s.id=$1',
    [req.params.id]
  );
  const s = sr[0];
  if (!s) return res.status(404).send('Not found');
  if (req.user.role !== 'admin' && s.server_id !== req.user.id) return res.status(403).send('Forbidden');
  const { rows: lines } = await q(
    `SELECT j.job_number, j.recipient_name, j.served_at, j.server_pay, c.name AS client_name
     FROM jobs j LEFT JOIN clients c ON c.id=j.client_id WHERE j.statement_id=$1 ORDER BY j.served_at`,
    [req.params.id]
  );
  const d = v => v ? new Date(v).toLocaleDateString('en-US', { timeZone: TZ }) : '';
  res.send(printPage('Statement #' + s.id, `
    <h1>${esc(process.env.COMPANY_NAME || 'ServeTrack')} — Contractor Pay Statement</h1>
    <div class="meta">
      <b>Statement #${s.id}</b> &nbsp;·&nbsp; ${d(s.created_at)}<br>
      Server: <b>${esc(s.server_name)}</b>${s.license_no ? ' (License #' + esc(s.license_no) + ')' : ''}<br>
      Period: ${d(s.period_start)} – ${d(s.period_end)} &nbsp;·&nbsp; Status: <b>${esc(s.status)}</b>
    </div>
    <table>
      <thead><tr><th>Date</th><th>Job</th><th>Client</th><th>Recipient</th><th class="num">Pay</th></tr></thead>
      <tbody>${lines.map(l => `<tr><td>${d(l.served_at)}</td><td>${esc(l.job_number)}</td>
        <td>${esc(l.client_name)}</td><td>${esc(l.recipient_name)}</td>
        <td class="num">$${Number(l.server_pay || 0).toFixed(2)}</td></tr>`).join('')}
        <tr class="tot"><td colspan="4">${lines.length} serve(s) — TOTAL DUE</td>
        <td class="num">$${Number(s.total).toFixed(2)}</td></tr></tbody>
    </table>
    <p style="font:11px system-ui;color:#555;margin-top:18px">
      Independent contractor compensation. No taxes withheld; recipient is responsible for
      self-employment tax. Retain for your records.</p>`));
}));

app.get('/print/invoice/:id', auth, admin, wrap(async (req, res) => {
  const { rows: ir } = await q(
    'SELECT i.*, c.name AS client_name, c.address, c.contact_name FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=$1',
    [req.params.id]
  );
  const inv = ir[0];
  if (!inv) return res.status(404).send('Not found');
  const { rows: lines } = await q(
    'SELECT job_number, recipient_name, case_number, served_at, client_fee, status FROM jobs WHERE invoice_id=$1 ORDER BY served_at',
    [req.params.id]
  );
  const d = v => v ? new Date(v).toLocaleDateString('en-US', { timeZone: TZ }) : '';
  res.send(printPage('Invoice #' + inv.id, `
    <h1>${esc(process.env.COMPANY_NAME || 'ServeTrack')} — Invoice</h1>
    <div class="meta">
      <b>Invoice #${inv.id}</b> &nbsp;·&nbsp; ${d(inv.created_at)}<br>
      Bill to: <b>${esc(inv.client_name)}</b>${inv.contact_name ? ' — ' + esc(inv.contact_name) : ''}<br>
      ${esc(inv.address || '')}<br>
      Period: ${d(inv.period_start)} – ${d(inv.period_end)} &nbsp;·&nbsp; Status: <b>${esc(inv.status)}</b>
    </div>
    <table>
      <thead><tr><th>Date</th><th>Job</th><th>Case</th><th>Recipient</th><th>Result</th><th class="num">Fee</th></tr></thead>
      <tbody>${lines.map(l => `<tr><td>${d(l.served_at)}</td><td>${esc(l.job_number)}</td>
        <td>${esc(l.case_number)}</td><td>${esc(l.recipient_name)}</td><td>${esc(l.status)}</td>
        <td class="num">$${Number(l.client_fee || 0).toFixed(2)}</td></tr>`).join('')}
        <tr class="tot"><td colspan="5">${lines.length} job(s) — TOTAL DUE</td>
        <td class="num">$${Number(inv.total).toFixed(2)}</td></tr></tbody>
    </table>`));
}));

app.get('/healthz', (req, res) => res.send('ok'));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

init()
  .then(() => app.listen(PORT, () => console.log('ServeTrack listening on ' + PORT)))
  .catch(err => { console.error('Startup failed:', err); process.exit(1); });
