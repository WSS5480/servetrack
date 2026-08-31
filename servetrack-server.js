/* ServeTrack — process serving management.
 *
 * Single-file server. Bundles the barcode encoder, affidavit merge engine,
 * database layer and schema so the whole app deploys as three files:
 * server.js, index.html, package.json.
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');



/* ------------------------------------------------ bundled: schema.sql --- */
const SCHEMA = `-- ServeTrack schema (idempotent)

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'server',   -- admin | server
  phone         TEXT,
  license_no    TEXT,                              -- process server registration / license
  county        TEXT,
  default_pay   NUMERIC(10,2) DEFAULT 0,           -- default pay per completed serve
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  contact_name  TEXT,
  email         TEXT,
  phone         TEXT,
  address       TEXT,
  default_fee   NUMERIC(10,2) DEFAULT 0,
  notes         TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id              SERIAL PRIMARY KEY,
  job_number      TEXT UNIQUE,                     -- e.g. ST-10042  (also the barcode value)
  client_id       INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  case_number     TEXT,
  court           TEXT,
  plaintiff       TEXT,
  defendant       TEXT,
  recipient_name  TEXT NOT NULL,
  recipient_notes TEXT,                            -- description, vehicle, hours, etc.
  address1        TEXT,
  address2        TEXT,
  city            TEXT,
  state           TEXT,
  zip             TEXT,
  service_type    TEXT DEFAULT 'Personal',         -- Personal | Substitute | Posting | Certified Mail
  documents       TEXT,
  priority        TEXT DEFAULT 'Routine',          -- Routine | Rush | Same Day
  due_date        DATE,
  status          TEXT NOT NULL DEFAULT 'Pending', -- Pending|Assigned|Attempted|Served|Non-Est|On Hold|Cancelled
  assigned_to     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  client_fee      NUMERIC(10,2) DEFAULT 0,
  server_pay      NUMERIC(10,2) DEFAULT 0,
  served_at       TIMESTAMPTZ,
  served_manner   TEXT,
  served_person   TEXT,
  invoice_id      INTEGER,
  statement_id    INTEGER,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS jobs_status_idx    ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_assigned_idx  ON jobs(assigned_to);
CREATE INDEX IF NOT EXISTS jobs_client_idx    ON jobs(client_id);

CREATE TABLE IF NOT EXISTS attempts (
  id            SERIAL PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  server_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  outcome       TEXT NOT NULL,                    -- Served | No Answer | Bad Address | Moved | Refused | Evading | Other
  manner        TEXT,                             -- Personal | Substitute | Posted | Corporate
  person_served TEXT,
  relationship  TEXT,
  description   TEXT,                             -- physical description of person served
  notes         TEXT,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  accuracy_m    DOUBLE PRECISION,
  address_used  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS attempts_job_idx ON attempts(job_id);

CREATE TABLE IF NOT EXISTS affidavit_templates (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  jurisdiction TEXT,
  body         TEXT NOT NULL,
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS statements (
  id            SERIAL PRIMARY KEY,
  server_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  total         NUMERIC(10,2) NOT NULL DEFAULT 0,
  job_count     INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'Open',     -- Open | Paid
  paid_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Access codes: hand someone a code and they create their own account, rather
-- than an admin keying in every person by hand.
CREATE TABLE IF NOT EXISTS access_codes (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL DEFAULT 'server',     -- what redeeming grants
  max_uses    INTEGER NOT NULL DEFAULT 1,
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  DATE,
  note        TEXT,                                -- who you gave it to, and why
  default_pay NUMERIC(10,2) DEFAULT 0,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS code_redemptions (
  id          SERIAL PRIMARY KEY,
  code_id     INTEGER NOT NULL REFERENCES access_codes(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email       TEXT,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tracks the physical label sheet currently in the printer, so a part-used
-- sheet can go back in and carry on from where it left off.
CREATE TABLE IF NOT EXISTS label_sheets (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  layout     TEXT NOT NULL DEFAULT 'avery5160',
  used       INTEGER[] NOT NULL DEFAULT '{}',   -- zero-based positions already peeled off
  offset_x   NUMERIC(5,3) NOT NULL DEFAULT 0,   -- printer drift correction, inches
  offset_y   NUMERIC(5,3) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS label_sheets_user_idx ON label_sheets(user_id);

CREATE TABLE IF NOT EXISTS invoices (
  id            SERIAL PRIMARY KEY,
  client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  period_start  DATE,
  period_end    DATE,
  total         NUMERIC(10,2) NOT NULL DEFAULT 0,
  job_count     INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'Unpaid',   -- Unpaid | Paid
  paid_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;


/* --------------------------------------------- bundled: the entire UI --- */
/* index.html (markup + styles + client script) encoded so the app ships as
   a single JavaScript file. Decoded once at startup. */
const INDEX_HTML = Buffer.from(
  'PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9InV0Zi04Ij4KPG1ldGEgbmFtZT0i' +
  'dmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCxpbml0aWFsLXNjYWxlPTEsdmlld3BvcnQtZml0PWNvdmVyIj4K' +
  'PG1ldGEgbmFtZT0idGhlbWUtY29sb3IiIGNvbnRlbnQ9IiMxZTNhNWYiPgo8dGl0bGU+U2VydmVUcmFjazwvdGl0bGU+CjxzdHls' +
  'ZT4KOnJvb3R7CiAgLS1iZzojZjVmNmY4OyAtLWNhcmQ6I2ZmZjsgLS1pbms6IzEyMTYxZjsgLS1tdXRlZDojNmI3MjgwOyAtLWxp' +
  'bmU6I2U0ZTdlYzsKICAtLWJyYW5kOiMxZTNhNWY7IC0tYnJhbmQtMjojMmI1YjhjOyAtLWFjY2VudDojMGI3Mjg1OwogIC0tb2s6' +
  'IzBmN2I0NTsgLS13YXJuOiNiNDUzMDk7IC0tYmFkOiNiNDIzMTg7IC0tcnVzaDojN2MyZDEyOwogIC0tcjoxMnB4OyAtLXNoOjAg' +
  'MXB4IDJweCByZ2JhKDE2LDI0LDQwLC4wNiksMCAxcHggM3B4IHJnYmEoMTYsMjQsNDAsLjEpOwp9Cip7Ym94LXNpemluZzpib3Jk' +
  'ZXItYm94fQpodG1sLGJvZHl7bWFyZ2luOjA7cGFkZGluZzowfQovKiBUaGUgc3RpY2t5IGhlYWRlciBhbmQgZml4ZWQgdGFiIGJh' +
  'ciBvdmVybGFwIHRoZSB2aWV3cG9ydCwgc28gYW55dGhpbmcgdGhlCiAgIGJyb3dzZXIgc2Nyb2xscyBpbnRvIHZpZXcgY2FuIGxh' +
  'bmQgdW5kZXJuZWF0aCB0aGVtIGFuZCBzd2FsbG93IHRoZSB0YXAuCiAgIFNjcm9sbCBwYWRkaW5nIGtlZXBzIHNjcm9sbGVkLXRv' +
  'IGNvbnRlbnQgY2xlYXIgb2YgYm90aC4gKi8KaHRtbHtzY3JvbGwtcGFkZGluZy10b3A6NzZweDtzY3JvbGwtcGFkZGluZy1ib3R0' +
  'b206OTZweH0KYm9keXsKICBmb250OjE1cHgvMS41IC1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LCJTZWdvZSBVSSIs' +
  'Um9ib3RvLEhlbHZldGljYSxBcmlhbCxzYW5zLXNlcmlmOwogIGJhY2tncm91bmQ6dmFyKC0tYmcpOyBjb2xvcjp2YXIoLS1pbmsp' +
  'OyAtd2Via2l0LXRleHQtc2l6ZS1hZGp1c3Q6MTAwJTsKfQphe2NvbG9yOnZhcigtLWJyYW5kLTIpfQpidXR0b24saW5wdXQsc2Vs' +
  'ZWN0LHRleHRhcmVhe2ZvbnQ6aW5oZXJpdDtjb2xvcjppbmhlcml0fQoKLyogLS0tLS0tLS0tLSBzaGVsbCAtLS0tLS0tLS0tICov' +
  'CiNhcHB7bWluLWhlaWdodDoxMDB2aH0KLnRvcGJhcnsKICBwb3NpdGlvbjpzdGlja3k7dG9wOjA7ei1pbmRleDoyMDtiYWNrZ3Jv' +
  'dW5kOnZhcigtLWJyYW5kKTtjb2xvcjojZmZmOwogIGRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEwcHg7cGFk' +
  'ZGluZzoxMnB4IDE0cHg7CiAgcGFkZGluZy10b3A6Y2FsYygxMnB4ICsgZW52KHNhZmUtYXJlYS1pbnNldC10b3ApKTsKfQoudG9w' +
  'YmFyIC5icmFuZHtmb250LXdlaWdodDo3MDA7bGV0dGVyLXNwYWNpbmc6LjJweH0KLnRvcGJhciAuYnJhbmQgc21hbGx7ZGlzcGxh' +
  'eTpibG9jaztmb250LXdlaWdodDo0MDA7Zm9udC1zaXplOjExcHg7b3BhY2l0eTouNztsZXR0ZXItc3BhY2luZzouNHB4fQoudG9w' +
  'YmFyIC5zcGFjZXJ7ZmxleDoxfQoudG9wYmFyIGJ1dHRvbntiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjE0KTtib3JkZXI6' +
  'MDtjb2xvcjojZmZmO3BhZGRpbmc6N3B4IDEycHg7Ym9yZGVyLXJhZGl1czo4cHh9Ci53cmFwe21heC13aWR0aDoxMTAwcHg7bWFy' +
  'Z2luOjAgYXV0bztwYWRkaW5nOjE0cHggMTRweCA5NnB4fQoKLyogYm90dG9tIHRhYnMgKG1vYmlsZSkgKi8KLnRhYnN7CiAgcG9z' +
  'aXRpb246Zml4ZWQ7bGVmdDowO3JpZ2h0OjA7Ym90dG9tOjA7ei1pbmRleDozMDtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyLXRvcDox' +
  'cHggc29saWQgdmFyKC0tbGluZSk7CiAgZGlzcGxheTpmbGV4O3BhZGRpbmctYm90dG9tOmVudihzYWZlLWFyZWEtaW5zZXQtYm90' +
  'dG9tKTsKfQoudGFicyBidXR0b257CiAgZmxleDoxO2JhY2tncm91bmQ6bm9uZTtib3JkZXI6MDtwYWRkaW5nOjlweCAxcHggMTBw' +
  'eDtmb250LXNpemU6MTBweDtjb2xvcjp2YXIoLS1tdXRlZCk7CiAgZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjth' +
  'bGlnbi1pdGVtczpjZW50ZXI7Z2FwOjNweDsKICBtaW4td2lkdGg6MDt3aGl0ZS1zcGFjZTpub3dyYXA7bGV0dGVyLXNwYWNpbmc6' +
  'LS4xcHg7Cn0KLnRhYnMgYnV0dG9uIC5pY3tmb250LXNpemU6MTlweDtsaW5lLWhlaWdodDoxfQoudGFicyBidXR0b24ub257Y29s' +
  'b3I6dmFyKC0tYnJhbmQpO2ZvbnQtd2VpZ2h0OjYwMH0KCi8qIC0tLS0tLS0tLS0gcGllY2VzIC0tLS0tLS0tLS0gKi8KLmNhcmR7' +
  'YmFja2dyb3VuZDp2YXIoLS1jYXJkKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6dmFyKC0tcik7' +
  'Ym94LXNoYWRvdzp2YXIoLS1zaCk7cGFkZGluZzoxNHB4O21hcmdpbi1ib3R0b206MTJweH0KLmNhcmQgaDJ7bWFyZ2luOjAgMCAx' +
  'MHB4O2ZvbnQtc2l6ZToxNXB4fQouY2FyZCBoMiAuc3Vie2ZvbnQtd2VpZ2h0OjQwMDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1z' +
  'aXplOjEycHh9CmgxLnBhZ2V7Zm9udC1zaXplOjIwcHg7bWFyZ2luOjRweCAwIDE0cHh9Ci5yb3d7ZGlzcGxheTpmbGV4O2dhcDo4' +
  'cHg7ZmxleC13cmFwOndyYXA7YWxpZ24taXRlbXM6Y2VudGVyfQouZ3JpZHtkaXNwbGF5OmdyaWQ7Z2FwOjEwcHh9CkBtZWRpYSht' +
  'aW4td2lkdGg6NzIwcHgpeyAuZzJ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciAxZnJ9IC5nM3tncmlkLXRlbXBsYXRlLWNvbHVt' +
  'bnM6cmVwZWF0KDMsMWZyKX0gfQoKLnN0YXRze2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsMWZy' +
  'KTtnYXA6MTBweDttYXJnaW4tYm90dG9tOjEycHh9CkBtZWRpYShtaW4td2lkdGg6NzIwcHgpey5zdGF0c3tncmlkLXRlbXBsYXRl' +
  'LWNvbHVtbnM6cmVwZWF0KDQsMWZyKX19Ci5zdGF0e2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUp' +
  'O2JvcmRlci1yYWRpdXM6dmFyKC0tcik7cGFkZGluZzoxMnB4O2JveC1zaGFkb3c6dmFyKC0tc2gpfQouc3RhdCAubntmb250LXNp' +
  'emU6MjZweDtmb250LXdlaWdodDo3MDA7bGluZS1oZWlnaHQ6MS4xfQouc3RhdCAubHtmb250LXNpemU6MTJweDtjb2xvcjp2YXIo' +
  'LS1tdXRlZCk7bWFyZ2luLXRvcDoycHh9Ci5zdGF0LmFsZXJ0IC5ue2NvbG9yOnZhcigtLWJhZCl9Ci5zdGF0Lmdvb2QgLm57Y29s' +
  'b3I6dmFyKC0tb2spfQoKLmJ0bntiYWNrZ3JvdW5kOnZhcigtLWJyYW5kKTtjb2xvcjojZmZmO2JvcmRlcjowO3BhZGRpbmc6MTFw' +
  'eCAxNnB4O2JvcmRlci1yYWRpdXM6MTBweDtmb250LXdlaWdodDo2MDA7Y3Vyc29yOnBvaW50ZXJ9Ci5idG46YWN0aXZle29wYWNp' +
  'dHk6Ljg1fQouYnRuLnNlY3tiYWNrZ3JvdW5kOiNmZmY7Y29sb3I6dmFyKC0taW5rKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxp' +
  'bmUpfQouYnRuLmdob3N0e2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Y29sb3I6dmFyKC0tYnJhbmQtMik7Ym9yZGVyOjA7cGFkZGlu' +
  'Zzo4cHggNHB4O2ZvbnQtd2VpZ2h0OjYwMH0KLmJ0bi5uYXZ7YmFja2dyb3VuZDp2YXIoLS1hY2NlbnQpfQouYnRuLm9re2JhY2tn' +
  'cm91bmQ6dmFyKC0tb2spfQouYnRuLmJhZHtiYWNrZ3JvdW5kOnZhcigtLWJhZCl9Ci5idG4uc217cGFkZGluZzo3cHggMTFweDtm' +
  'b250LXNpemU6MTNweDtib3JkZXItcmFkaXVzOjhweH0KLmJ0bi5ibG9ja3t3aWR0aDoxMDAlO2Rpc3BsYXk6YmxvY2t9Ci5idG5b' +
  'ZGlzYWJsZWRde29wYWNpdHk6LjV9CgpsYWJlbHtkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMnB4O2ZvbnQtd2VpZ2h0OjYwMDtj' +
  'b2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luOjAgMCA0cHh9CmlucHV0LHNlbGVjdCx0ZXh0YXJlYXsKICB3aWR0aDoxMDAlO3BhZGRp' +
  'bmc6MTFweCAxMnB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMHB4O2JhY2tncm91bmQ6I2Zm' +
  'ZjsKfQppbnB1dDpmb2N1cyxzZWxlY3Q6Zm9jdXMsdGV4dGFyZWE6Zm9jdXN7b3V0bGluZToycHggc29saWQgI2NmZTBmMjtib3Jk' +
  'ZXItY29sb3I6dmFyKC0tYnJhbmQtMil9CnRleHRhcmVhe21pbi1oZWlnaHQ6OTBweDtyZXNpemU6dmVydGljYWx9Ci5maWVsZHtt' +
  'YXJnaW4tYm90dG9tOjEwcHh9Ci5oaW50e2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW4tdG9wOjRweH0K' +
  'Ci5saXN0e2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjhweH0KLml0ZW17CiAgYmFja2dyb3VuZDojZmZm' +
  'O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLWxlZnQ6NHB4IHNvbGlkIHZhcigtLWxpbmUpOwogIGJvcmRlci1y' +
  'YWRpdXM6dmFyKC0tcik7cGFkZGluZzoxMXB4IDEycHg7Ym94LXNoYWRvdzp2YXIoLS1zaCk7Y3Vyc29yOnBvaW50ZXI7Cn0KLml0' +
  'ZW0ucC1SdXNoe2JvcmRlci1sZWZ0LWNvbG9yOnZhcigtLXdhcm4pfQouaXRlbS5wLVNhbWVEYXl7Ym9yZGVyLWxlZnQtY29sb3I6' +
  'dmFyKC0tcnVzaCl9Ci5pdGVtLm92ZXJkdWV7Ym9yZGVyLWxlZnQtY29sb3I6dmFyKC0tYmFkKX0KLml0ZW0gLnR7Zm9udC13ZWln' +
  'aHQ6NjAwfQouaXRlbSAubXtmb250LXNpemU6MTIuNXB4O2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW4tdG9wOjJweH0KLml0ZW0g' +
  'LnJ7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7Z2FwOjEw' +
  'cHh9CgoucGlsbHtkaXNwbGF5OmlubGluZS1ibG9jaztmb250LXNpemU6MTFweDtmb250LXdlaWdodDo3MDA7cGFkZGluZzozcHgg' +
  'OHB4O2JvcmRlci1yYWRpdXM6OTlweDtiYWNrZ3JvdW5kOiNlZWYxZjU7Y29sb3I6IzQxNTA2Yjt3aGl0ZS1zcGFjZTpub3dyYXB9' +
  'Ci5waWxsLlNlcnZlZHtiYWNrZ3JvdW5kOiNlM2Y1ZWE7Y29sb3I6dmFyKC0tb2spfQoucGlsbC5QZW5kaW5ne2JhY2tncm91bmQ6' +
  'I2ZkZjBlMztjb2xvcjp2YXIoLS13YXJuKX0KLnBpbGwuQXNzaWduZWR7YmFja2dyb3VuZDojZTdlZWZiO2NvbG9yOnZhcigtLWJy' +
  'YW5kLTIpfQoucGlsbC5BdHRlbXB0ZWR7YmFja2dyb3VuZDojZmRmM2QzO2NvbG9yOiM4YTYxMDB9Ci5waWxsLk5vbkVzdHtiYWNr' +
  'Z3JvdW5kOiNmZGU4ZTY7Y29sb3I6dmFyKC0tYmFkKX0KLnBpbGwuQ2FuY2VsbGVkLC5waWxsLk9uSG9sZHtiYWNrZ3JvdW5kOiNl' +
  'Y2VmZjM7Y29sb3I6IzVhNjQ3Mn0KLnBpbGwucnVzaHtiYWNrZ3JvdW5kOiNmZGVjZGM7Y29sb3I6dmFyKC0tcnVzaCl9Ci5waWxs' +
  'LlBhaWR7YmFja2dyb3VuZDojZTNmNWVhO2NvbG9yOnZhcigtLW9rKX0KLnBpbGwuT3BlbiwucGlsbC5VbnBhaWR7YmFja2dyb3Vu' +
  'ZDojZmRmMGUzO2NvbG9yOnZhcigtLXdhcm4pfQoKdGFibGUudGJse3dpZHRoOjEwMCU7Ym9yZGVyLWNvbGxhcHNlOmNvbGxhcHNl' +
  'O2ZvbnQtc2l6ZToxMy41cHh9CnRhYmxlLnRibCB0aHt0ZXh0LWFsaWduOmxlZnQ7Zm9udC1zaXplOjExLjVweDt0ZXh0LXRyYW5z' +
  'Zm9ybTp1cHBlcmNhc2U7bGV0dGVyLXNwYWNpbmc6LjRweDtjb2xvcjp2YXIoLS1tdXRlZCk7cGFkZGluZzo2cHggNnB4O2JvcmRl' +
  'ci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWxpbmUpfQp0YWJsZS50YmwgdGR7cGFkZGluZzo5cHggNnB4O2JvcmRlci1ib3R0b206' +
  'MXB4IHNvbGlkIHZhcigtLWxpbmUpO3ZlcnRpY2FsLWFsaWduOnRvcH0KdGFibGUudGJsIHRyOmxhc3QtY2hpbGQgdGR7Ym9yZGVy' +
  'LWJvdHRvbTowfQoubnVte3RleHQtYWxpZ246cmlnaHR9CgouYXR0e2JvcmRlci1sZWZ0OjNweCBzb2xpZCB2YXIoLS1saW5lKTtw' +
  'YWRkaW5nOjhweCAwIDhweCAxMnB4O21hcmdpbi1ib3R0b206OHB4fQouYXR0LlNlcnZlZHtib3JkZXItbGVmdC1jb2xvcjp2YXIo' +
  'LS1vayl9Ci5hdHQgLmh7Zm9udC13ZWlnaHQ6NjAwO2ZvbnQtc2l6ZToxMy41cHh9Ci5hdHQgLm17Zm9udC1zaXplOjEyLjVweDtj' +
  'b2xvcjp2YXIoLS1tdXRlZCl9Cgouc2hlZXR7cG9zaXRpb246Zml4ZWQ7aW5zZXQ6MDt6LWluZGV4OjUwO2JhY2tncm91bmQ6cmdi' +
  'YSgxMiwxOCwyOCwuNSk7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmZsZXgtZW5kO2p1c3RpZnktY29udGVudDpjZW50ZXJ9Ci5z' +
  'aGVldCAuaW5uZXJ7YmFja2dyb3VuZDojZmZmO3dpZHRoOjEwMCU7bWF4LXdpZHRoOjY0MHB4O21heC1oZWlnaHQ6OTJ2aDtvdmVy' +
  'ZmxvdzphdXRvO2JvcmRlci1yYWRpdXM6MTZweCAxNnB4IDAgMDtwYWRkaW5nOjE2cHggMTZweCBjYWxjKDIwcHggKyBlbnYoc2Fm' +
  'ZS1hcmVhLWluc2V0LWJvdHRvbSkpfQpAbWVkaWEobWluLXdpZHRoOjcyMHB4KXsuc2hlZXR7YWxpZ24taXRlbXM6Y2VudGVyfS5z' +
  'aGVldCAuaW5uZXJ7Ym9yZGVyLXJhZGl1czoxNnB4O21heC1oZWlnaHQ6ODh2aH19Ci5zaGVldCBoMnttYXJnaW46MCAwIDEycHg7' +
  'Zm9udC1zaXplOjE3cHh9Ci5zaGVldCAuY2xvc2V7cG9zaXRpb246YWJzb2x1dGU7cmlnaHQ6MTRweDt0b3A6MTRweH0KCi50b2Fz' +
  'dHtwb3NpdGlvbjpmaXhlZDtsZWZ0OjUwJTt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTtib3R0b206NzhweDt6LWluZGV4OjYw' +
  'O2JhY2tncm91bmQ6IzEyMTYxZjtjb2xvcjojZmZmO3BhZGRpbmc6MTFweCAxNnB4O2JvcmRlci1yYWRpdXM6MTBweDtmb250LXNp' +
  'emU6MTRweDttYXgtd2lkdGg6OTAlO2JveC1zaGFkb3c6MCA4cHggMjRweCByZ2JhKDAsMCwwLC4yNSl9Ci50b2FzdC5iYWR7YmFj' +
  'a2dyb3VuZDp2YXIoLS1iYWQpfQoKLmVtcHR5e3RleHQtYWxpZ246Y2VudGVyO2NvbG9yOnZhcigtLW11dGVkKTtwYWRkaW5nOjI4' +
  'cHggMTBweDtmb250LXNpemU6MTRweH0KLnRva2Vuc3tkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjZweDttYXJnaW4t' +
  'dG9wOjZweH0KLnRva2VucyBidXR0b257Zm9udDoxMnB4LzEgbW9ub3NwYWNlO3BhZGRpbmc6NnB4IDhweDtib3JkZXI6MXB4IHNv' +
  'bGlkIHZhcigtLWxpbmUpO2JhY2tncm91bmQ6I2Y4ZmFmYztib3JkZXItcmFkaXVzOjZweDtjdXJzb3I6cG9pbnRlcn0KcHJlLnBy' +
  'ZXZ7YmFja2dyb3VuZDojZjhmYWZjO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czo4cHg7cGFkZGlu' +
  'ZzoxMnB4O3doaXRlLXNwYWNlOnByZS13cmFwO2ZvbnQ6MTJweC8xLjUgIkNvdXJpZXIgTmV3Iixtb25vc3BhY2U7bWF4LWhlaWdo' +
  'dDozNDBweDtvdmVyZmxvdzphdXRvfQojcmVhZGVye3dpZHRoOjEwMCU7Ym9yZGVyLXJhZGl1czoxMnB4O292ZXJmbG93OmhpZGRl' +
  'bjtiYWNrZ3JvdW5kOiMwMDA7bWluLWhlaWdodDoyNDBweH0KI3JlYWRlciB2aWRlb3t3aWR0aDoxMDAlO2Rpc3BsYXk6YmxvY2t9' +
  'CgoubG9naW57bWF4LXdpZHRoOjM4MHB4O21hcmdpbjo4dmggYXV0bztwYWRkaW5nOjAgMThweH0KLmxvZ2luIC5sb2dve3RleHQt' +
  'YWxpZ246Y2VudGVyO21hcmdpbi1ib3R0b206MjBweH0KLmxvZ2luIC5sb2dvIGJ7Zm9udC1zaXplOjI2cHg7Y29sb3I6dmFyKC0t' +
  'YnJhbmQpO2xldHRlci1zcGFjaW5nOi0uNHB4fQoubG9naW4gLmxvZ28gZGl2e2ZvbnQtc2l6ZToxMi41cHg7Y29sb3I6dmFyKC0t' +
  'bXV0ZWQpO21hcmdpbi10b3A6MnB4fQoKLmRyb3B6b25le2JhY2tncm91bmQ6I2Y4ZmFmYztib3JkZXI6MS41cHggZGFzaGVkICNj' +
  'NmQyZTA7Ym9yZGVyLXJhZGl1czp2YXIoLS1yKTtwYWRkaW5nOjEycHg7bWFyZ2luLWJvdHRvbToxNHB4fQouZHJvcHpvbmUgaW5w' +
  'dXRbdHlwZT1maWxlXXtiYWNrZ3JvdW5kOiNmZmY7cGFkZGluZzo5cHg7Zm9udC1zaXplOjEzcHh9Ci5kcm9wem9uZSAuaGludHtt' +
  'YXJnaW4tdG9wOjhweDtsaW5lLWhlaWdodDoxLjQ1fQoKLyogbGFiZWwgc2hlZXQgZ3JpZCAqLwoubGdyaWR7ZGlzcGxheTpncmlk' +
  'O2dhcDozcHg7YmFja2dyb3VuZDojZWVmMWY1O3BhZGRpbmc6NnB4O2JvcmRlci1yYWRpdXM6OHB4O2JvcmRlcjoxcHggc29saWQg' +
  'dmFyKC0tbGluZSl9Ci5sY2VsbHthc3BlY3QtcmF0aW86NS8yO2JvcmRlcjoxcHggc29saWQgI2M5ZDRlMDtiYWNrZ3JvdW5kOiNm' +
  'ZmY7Ym9yZGVyLXJhZGl1czozcHg7Y3Vyc29yOnBvaW50ZXI7CiAgZm9udDo2MDAgMTFweCBzeXN0ZW0tdWk7Y29sb3I6dmFyKC0t' +
  'bXV0ZWQpO3BhZGRpbmc6MDttaW4taGVpZ2h0OjIycHg7ZGlzcGxheTpmbGV4OwogIGFsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5' +
  'LWNvbnRlbnQ6Y2VudGVyfQoubGNlbGwudXNlZHtiYWNrZ3JvdW5kOiNkN2RkZTU7Y29sb3I6IzhhOTRhMjtib3JkZXItY29sb3I6' +
  'I2MyY2NkOH0KLmxjZWxsLm5leHR7YmFja2dyb3VuZDojZTNmNWVhO2JvcmRlci1jb2xvcjp2YXIoLS1vayk7Y29sb3I6dmFyKC0t' +
  'b2spfQoubGNlbGw6YWN0aXZle3RyYW5zZm9ybTpzY2FsZSguOTYpfQoKPC9zdHlsZT4KPGxpbmsgcmVsPSJpY29uIiBocmVmPSJk' +
  'YXRhOmltYWdlL3N2Zyt4bWwsPHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAzMiAz' +
  'Mic+PHJlY3Qgd2lkdGg9JzMyJyBoZWlnaHQ9JzMyJyByeD0nNycgZmlsbD0nJTIzMWUzYTVmJy8+PHRleHQgeD0nMTYnIHk9JzIz' +
  'JyBmb250LXNpemU9JzE5JyBmb250LWZhbWlseT0nc3lzdGVtLXVpJyBmb250LXdlaWdodD0nNzAwJyBmaWxsPSd3aGl0ZScgdGV4' +
  'dC1hbmNob3I9J21pZGRsZSc+UzwvdGV4dD48L3N2Zz4iPgo8L2hlYWQ+Cjxib2R5Pgo8ZGl2IGlkPSJhcHAiPjwvZGl2Pgo8c2Ny' +
  'aXB0IHNyYz0iaHR0cHM6Ly9jZG4uanNkZWxpdnIubmV0L25wbS9AenhpbmcvbGlicmFyeUAwLjIxLjMvdW1kL2luZGV4Lm1pbi5q' +
  'cyI+PC9zY3JpcHQ+CjxzY3JpcHQ+Ci8qIFNlcnZlVHJhY2sg4oCUIGZpZWxkLWZpcnN0IHByb2Nlc3Mgc2VydmluZyBtYW5hZ2Vy' +
  'ICovCihmdW5jdGlvbiAoKSB7Cid1c2Ugc3RyaWN0JzsKCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBoZWxwZXJzIC0tICovCmNvbnN0ICQgPSBzZWwgPT4gZG9jdW1lbnQucXVlcnlTZWxlY3Rv' +
  'cihzZWwpOwpjb25zdCBhcHAgPSAkKCcjYXBwJyk7CmNvbnN0IFMgPSB7IG1lOiBudWxsLCB2aWV3OiAnZGFzaCcsIHBhcmFtczog' +
  'e30sIGNhY2hlOiB7fSB9OwoKY29uc3QgZXNjID0gcyA9PiBTdHJpbmcocyA9PSBudWxsID8gJycgOiBzKQogIC5yZXBsYWNlKC8m' +
  'L2csICcmYW1wOycpLnJlcGxhY2UoLzwvZywgJyZsdDsnKS5yZXBsYWNlKC8+L2csICcmZ3Q7JykKICAucmVwbGFjZSgvIi9nLCAn' +
  'JnF1b3Q7JykucmVwbGFjZSgvJy9nLCAnJiMzOTsnKTsKCmNvbnN0IG1vbmV5ID0gdiA9PiAnJCcgKyBOdW1iZXIodiB8fCAwKS50' +
  'b0ZpeGVkKDIpOwpjb25zdCBjbHMgPSBzID0+IFN0cmluZyhzIHx8ICcnKS5yZXBsYWNlKC9bXkEtWmEtel0vZywgJycpOwoKZnVu' +
  'Y3Rpb24gZm10RGF0ZSh2LCBvcHRzKSB7CiAgaWYgKCF2KSByZXR1cm4gJyc7CiAgY29uc3QgZCA9IG5ldyBEYXRlKHYpOwogIHJl' +
  'dHVybiBkLnRvTG9jYWxlRGF0ZVN0cmluZygnZW4tVVMnLCBvcHRzIHx8IHsgbW9udGg6ICdzaG9ydCcsIGRheTogJ251bWVyaWMn' +
  'LCB5ZWFyOiAnbnVtZXJpYycgfSk7Cn0KZnVuY3Rpb24gZm10RGF0ZU9ubHkodikgeyAvLyBkYXRlIGNvbHVtbnMgY29tZSBiYWNr' +
  'IGFzIFlZWVktTU0tREQgb3IgSVNPIG1pZG5pZ2h0IFVUQwogIGlmICghdikgcmV0dXJuICcnOwogIGNvbnN0IHMgPSBTdHJpbmco' +
  'dikuc2xpY2UoMCwgMTApLnNwbGl0KCctJyk7CiAgcmV0dXJuIGAkeytzWzFdfS8keytzWzJdfS8ke3NbMF0uc2xpY2UoMil9YDsK' +
  'fQpmdW5jdGlvbiBmbXREVCh2KSB7CiAgaWYgKCF2KSByZXR1cm4gJyc7CiAgcmV0dXJuIG5ldyBEYXRlKHYpLnRvTG9jYWxlU3Ry' +
  'aW5nKCdlbi1VUycsCiAgICB7IG1vbnRoOiAnc2hvcnQnLCBkYXk6ICdudW1lcmljJywgaG91cjogJ251bWVyaWMnLCBtaW51dGU6' +
  'ICcyLWRpZ2l0JyB9KTsKfQpmdW5jdGlvbiBkYXlzT3V0KHYpIHsKICBpZiAoIXYpIHJldHVybiBudWxsOwogIGNvbnN0IGR1ZSA9' +
  'IG5ldyBEYXRlKFN0cmluZyh2KS5zbGljZSgwLCAxMCkgKyAnVDEyOjAwOjAwJyk7CiAgcmV0dXJuIE1hdGgucm91bmQoKGR1ZSAt' +
  'IG5ldyBEYXRlKCkpIC8gODY0ZTUpOwp9CmNvbnN0IHRvZGF5SVNPID0gKCkgPT4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnNs' +
  'aWNlKDAsIDEwKTsKCmFzeW5jIGZ1bmN0aW9uIGFwaShwYXRoLCBvcHRzKSB7CiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goJy9h' +
  'cGknICsgcGF0aCwgT2JqZWN0LmFzc2lnbih7CiAgICBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNv' +
  'bicgfSwgY3JlZGVudGlhbHM6ICdzYW1lLW9yaWdpbicKICB9LCBvcHRzIHx8IHt9KSk7CiAgY29uc3QgZGF0YSA9IGF3YWl0IHJl' +
  'cy5qc29uKCkuY2F0Y2goKCkgPT4gKHt9KSk7CiAgLy8gQSA0MDEgZnJvbSAvbG9naW4gbWVhbnMgdGhlIGNyZWRlbnRpYWxzIHdl' +
  'cmUgd3JvbmcsIG5vdCB0aGF0IGEgc2Vzc2lvbgogIC8vIGxhcHNlZC4gVHJlYXRpbmcgdGhlIHR3byB0aGUgc2FtZSBzaG93ZWQg' +
  'IlNpZ25lZCBvdXQiIHRvIHNvbWVvbmUgd2hvIGhhZAogIC8vIHNpbXBseSBtaXN0eXBlZCBhIHBhc3N3b3JkLCB3aGljaCBpcyBh' +
  'Y3RpdmVseSBtaXNsZWFkaW5nLgogIGlmIChyZXMuc3RhdHVzID09PSA0MDEgJiYgcGF0aCAhPT0gJy9sb2dpbicpIHsKICAgIFMu' +
  'bWUgPSBudWxsOwogICAgcmVuZGVyKCk7CiAgICB0aHJvdyBuZXcgRXJyb3IoZGF0YS5lcnJvciB8fCAnU2lnbmVkIG91dCcpOwog' +
  'IH0KICBpZiAoIXJlcy5vaykgdGhyb3cgbmV3IEVycm9yKGRhdGEuZXJyb3IgfHwgJ1JlcXVlc3QgZmFpbGVkJyk7CiAgcmV0dXJu' +
  'IGRhdGE7Cn0KCmZ1bmN0aW9uIHRvYXN0KG1zZywgYmFkKSB7CiAgY29uc3QgdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2Rp' +
  'dicpOwogIHQuY2xhc3NOYW1lID0gJ3RvYXN0JyArIChiYWQgPyAnIGJhZCcgOiAnJyk7CiAgdC50ZXh0Q29udGVudCA9IG1zZzsK' +
  'ICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKHQpOwogIHNldFRpbWVvdXQoKCkgPT4gdC5yZW1vdmUoKSwgMzIwMCk7Cn0KCmZ1' +
  'bmN0aW9uIGdvKHZpZXcsIHBhcmFtcykgeyBTLnZpZXcgPSB2aWV3OyBTLnBhcmFtcyA9IHBhcmFtcyB8fCB7fTsgd2luZG93LnNj' +
  'cm9sbFRvKDAsIDApOyByZW5kZXIoKTsgfQoKLyogbW9kYWwgc2hlZXQgKi8KbGV0IHNoZWV0RWwgPSBudWxsOwpmdW5jdGlvbiBz' +
  'aGVldCh0aXRsZSwgYm9keUh0bWwsIG9uTW91bnQpIHsKICBjbG9zZVNoZWV0KCk7CiAgc2hlZXRFbCA9IGRvY3VtZW50LmNyZWF0' +
  'ZUVsZW1lbnQoJ2RpdicpOwogIHNoZWV0RWwuY2xhc3NOYW1lID0gJ3NoZWV0JzsKICBzaGVldEVsLmlubmVySFRNTCA9IGA8ZGl2' +
  'IGNsYXNzPSJpbm5lciI+PGgyPiR7ZXNjKHRpdGxlKX08L2gyPiR7Ym9keUh0bWx9PC9kaXY+YDsKICBzaGVldEVsLmFkZEV2ZW50' +
  'TGlzdGVuZXIoJ2NsaWNrJywgZSA9PiB7IGlmIChlLnRhcmdldCA9PT0gc2hlZXRFbCkgY2xvc2VTaGVldCgpOyB9KTsKICBkb2N1' +
  'bWVudC5ib2R5LmFwcGVuZENoaWxkKHNoZWV0RWwpOwogIGlmIChvbk1vdW50KSBvbk1vdW50KHNoZWV0RWwpOwp9CmZ1bmN0aW9u' +
  'IGNsb3NlU2hlZXQoKSB7CiAgaWYgKHNoZWV0RWwpIHsgc2hlZXRFbC5yZW1vdmUoKTsgc2hlZXRFbCA9IG51bGw7IH0KICBpZiAo' +
  'd2luZG93Ll9fc3RvcFNjYW4pIHsgd2luZG93Ll9fc3RvcFNjYW4oKTsgd2luZG93Ll9fc3RvcFNjYW4gPSBudWxsOyB9Cn0Kd2lu' +
  'ZG93LmNsb3NlU2hlZXQgPSBjbG9zZVNoZWV0OwoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLSBtYXBzIGxpbmtpbmcgLS0gKi8KY29uc3QgaXNJT1MgPSAoKSA9PiAvaVBhZHxpUGhvbmV8aVBvZC8udGVz' +
  'dChuYXZpZ2F0b3IudXNlckFnZW50KSB8fAogIChuYXZpZ2F0b3IucGxhdGZvcm0gPT09ICdNYWNJbnRlbCcgJiYgbmF2aWdhdG9y' +
  'Lm1heFRvdWNoUG9pbnRzID4gMSk7CgpmdW5jdGlvbiBhZGRyT2YoaikgewogIHJldHVybiBbai5hZGRyZXNzMSwgai5hZGRyZXNz' +
  'Miwgai5jaXR5LCBqLnN0YXRlLCBqLnppcF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJywgJyk7Cn0KZnVuY3Rpb24gYXBwbGVVcmwo' +
  'YSkgeyByZXR1cm4gJ2h0dHBzOi8vbWFwcy5hcHBsZS5jb20vP2RhZGRyPScgKyBlbmNvZGVVUklDb21wb25lbnQoYSkgKyAnJmRp' +
  'cmZsZz1kJzsgfQpmdW5jdGlvbiBnb29nbGVVcmwoYSkgewogIHJldHVybiAnaHR0cHM6Ly93d3cuZ29vZ2xlLmNvbS9tYXBzL2Rp' +
  'ci8/YXBpPTEmZGVzdGluYXRpb249JyArIGVuY29kZVVSSUNvbXBvbmVudChhKSArICcmdHJhdmVsbW9kZT1kcml2aW5nJzsKfQpm' +
  'dW5jdGlvbiBuYXZVcmwoYSkgeyByZXR1cm4gaXNJT1MoKSA/IGFwcGxlVXJsKGEpIDogZ29vZ2xlVXJsKGEpOyB9CmZ1bmN0aW9u' +
  'IHJvdXRlVXJsKGxpc3QpIHsKICBjb25zdCBzdG9wcyA9IGxpc3QubWFwKGFkZHJPZikuZmlsdGVyKEJvb2xlYW4pOwogIGlmICgh' +
  'c3RvcHMubGVuZ3RoKSByZXR1cm4gbnVsbDsKICBjb25zdCBkZXN0ID0gc3RvcHNbc3RvcHMubGVuZ3RoIC0gMV07CiAgY29uc3Qg' +
  'd2F5ID0gc3RvcHMuc2xpY2UoMCwgLTEpLnNsaWNlKDAsIDkpLm1hcChlbmNvZGVVUklDb21wb25lbnQpLmpvaW4oJ3wnKTsKICBy' +
  'ZXR1cm4gJ2h0dHBzOi8vd3d3Lmdvb2dsZS5jb20vbWFwcy9kaXIvP2FwaT0xJm9yaWdpbj1DdXJyZW50K0xvY2F0aW9uJmRlc3Rp' +
  'bmF0aW9uPScgKwogICAgZW5jb2RlVVJJQ29tcG9uZW50KGRlc3QpICsgKHdheSA/ICcmd2F5cG9pbnRzPScgKyB3YXkgOiAnJykg' +
  'KyAnJnRyYXZlbG1vZGU9ZHJpdmluZyc7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0gbGF5b3V0IC0tICovCmNvbnN0IGlzQWRtaW4gPSAoKSA9PiBTLm1lICYmIFMubWUucm9sZSA9PT0g' +
  'J2FkbWluJzsKCmNvbnN0IFRBQlMgPSAoKSA9PiBpc0FkbWluKCkKICA/IFtbJ2Rhc2gnLCAnVG9kYXknLCAn4peOJ10sIFsnam9i' +
  'cycsICdKb2JzJywgJ+KWpCddLCBbJ3NjYW4nLCAnU2NhbicsICfilqUnXSwKICAgICBbJ3Rvb2xzJywgJ1Rvb2xzJywgJ+Kcgidd' +
  'LCBbJ3Byb3BlcnR5JywgJ1Byb3AnLCAn4oyCJ10sIFsnbW9uZXknLCAnQmlsbCcsICckJ10sIFsnYWRtaW4nLCAnU2V0dXAnLCAn' +
  '4pqZJ11dCiAgOiBbWydkYXNoJywgJ015IERheScsICfil44nXSwgWydqb2JzJywgJ0pvYnMnLCAn4pakJ10sIFsnc2NhbicsICdT' +
  'Y2FuJywgJ+KWpSddLAogICAgIFsndG9vbHMnLCAnVG9vbHMnLCAn4pyCJ10sIFsncHJvcGVydHknLCAnUHJvcCcsICfijIInXSwg' +
  'Wydtb25leScsICdQYXknLCAnJCddXTsKCmZ1bmN0aW9uIHNoZWxsKGlubmVyKSB7CiAgY29uc3QgdGFicyA9IFRBQlMoKS5tYXAo' +
  'KFt2LCBsYWJlbCwgaWNdKSA9PgogICAgYDxidXR0b24gZGF0YS10YWI9IiR7dn0iIGNsYXNzPSIke1MudmlldyA9PT0gdiB8fCAo' +
  'diA9PT0gJ2pvYnMnICYmIFMudmlldyA9PT0gJ2pvYicpID8gJ29uJyA6ICcnfSI+CiAgICAgIDxzcGFuIGNsYXNzPSJpYyI+JHtp' +
  'Y308L3NwYW4+JHtlc2MobGFiZWwpfTwvYnV0dG9uPmApLmpvaW4oJycpOwogIHJldHVybiBgCiAgICA8ZGl2IGNsYXNzPSJ0b3Bi' +
  'YXIiPgogICAgICA8ZGl2IGNsYXNzPSJicmFuZCI+U2VydmVUcmFjazxzbWFsbD4ke2VzYyhTLm1lLm5hbWUpfSDCtyAke1MubWUu' +
  'cm9sZSA9PT0gJ2FkbWluJyA/ICdBZG1pbicgOiAnRmllbGQgc2VydmVyJ308L3NtYWxsPjwvZGl2PgogICAgICA8ZGl2IGNsYXNz' +
  'PSJzcGFjZXIiPjwvZGl2PgogICAgICA8YnV0dG9uIGlkPSJsb2dvdXQiPlNpZ24gb3V0PC9idXR0b24+CiAgICA8L2Rpdj4KICAg' +
  'IDxkaXYgY2xhc3M9IndyYXAiPiR7aW5uZXJ9PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJ0YWJzIj4ke3RhYnN9PC9kaXY+YDsKfQoK' +
  'ZnVuY3Rpb24gYmluZFNoZWxsKCkgewogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXRhYl0nKS5mb3JFYWNoKGIg' +
  'PT4KICAgIGIub25jbGljayA9ICgpID0+IGdvKGIuZGF0YXNldC50YWIpKTsKICBjb25zdCBsbyA9ICQoJyNsb2dvdXQnKTsKICBp' +
  'ZiAobG8pIGxvLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7IGF3YWl0IGFwaSgnL2xvZ291dCcsIHsgbWV0aG9kOiAnUE9TVCcgfSk7' +
  'IFMubWUgPSBudWxsOyByZW5kZXIoKTsgfTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0gbG9naW4gLS0gKi8KZnVuY3Rpb24gbG9naW5WaWV3KCkgewogIGFwcC5pbm5lckhUTUwgPSBg' +
  'PGRpdiBjbGFzcz0ibG9naW4iPgogICAgPGRpdiBjbGFzcz0ibG9nbyI+PGI+U2VydmVUcmFjazwvYj48ZGl2PlByb2Nlc3Mgc2Vy' +
  'dmluZyBtYW5hZ2VtZW50PC9kaXY+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQi' +
  'PjxsYWJlbD5FbWFpbDwvbGFiZWw+PGlucHV0IGlkPSJlbWFpbCIgdHlwZT0iZW1haWwiIGF1dG9jb21wbGV0ZT0idXNlcm5hbWUi' +
  'IGlucHV0bW9kZT0iZW1haWwiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBhc3N3b3JkPC9sYWJlbD48' +
  'aW5wdXQgaWQ9InB3IiB0eXBlPSJwYXNzd29yZCIgYXV0b2NvbXBsZXRlPSJjdXJyZW50LXBhc3N3b3JkIj48L2Rpdj4KICAgICAg' +
  'PGJ1dHRvbiBjbGFzcz0iYnRuIGJsb2NrIiBpZD0ic2lnbmluIj5TaWduIGluPC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9Imhp' +
  'bnQiIGlkPSJlcnIiIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQpO21hcmdpbi10b3A6MTBweCI+PC9kaXY+CiAgICAgIDxkaXYgY2xh' +
  'c3M9ImhpbnQiIHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlcjttYXJnaW4tdG9wOjE0cHgiPgogICAgICAgIEJlZW4gZ2l2ZW4gYW4g' +
  'YWNjZXNzIGNvZGU/IDxhIGhyZWY9IiMiIGlkPSJoYXZlQ29kZSI+U2V0IHVwIHlvdXIgYWNjb3VudDwvYT48L2Rpdj4KICAgIDwv' +
  'ZGl2PjwvZGl2PmA7CiAgY29uc3Qgc3VibWl0ID0gYXN5bmMgKCkgPT4gewogICAgJCgnI2VycicpLnRleHRDb250ZW50ID0gJyc7' +
  'CiAgICB0cnkgewogICAgICBTLm1lID0gYXdhaXQgYXBpKCcvbG9naW4nLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0' +
  'cmluZ2lmeSh7IGVtYWlsOiAkKCcjZW1haWwnKS52YWx1ZSwgcGFzc3dvcmQ6ICQoJyNwdycpLnZhbHVlIH0pIH0pOwogICAgICBn' +
  'bygnZGFzaCcpOwogICAgfSBjYXRjaCAoZSkgeyAkKCcjZXJyJykudGV4dENvbnRlbnQgPSBlLm1lc3NhZ2U7IH0KICB9OwogICQo' +
  'JyNzaWduaW4nKS5vbmNsaWNrID0gc3VibWl0OwogICQoJyNwdycpLm9ua2V5ZG93biA9IGUgPT4geyBpZiAoZS5rZXkgPT09ICdF' +
  'bnRlcicpIHN1Ym1pdCgpOyB9OwogICQoJyNoYXZlQ29kZScpLm9uY2xpY2sgPSBlID0+IHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBy' +
  'ZWRlZW1WaWV3KCk7IH07CiAgJCgnI2VtYWlsJykuZm9jdXMoKTsKfQoKCi8qIFJlZGVlbWluZyBhIGNvZGUgY3JlYXRlcyB0aGUg' +
  'YWNjb3VudCwgc28gc29tZW9uZSBjYW4gYmUgc2V0IHVwIHdpdGhvdXQgYW4KICAgYWRtaW4ga2V5aW5nIGluIHRoZWlyIGRldGFp' +
  'bHMuICovCmZ1bmN0aW9uIHJlZGVlbVZpZXcoKSB7CiAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJsb2dpbiI+CiAgICA8' +
  'ZGl2IGNsYXNzPSJsb2dvIj48Yj5TZXJ2ZVRyYWNrPC9iPjxkaXY+U2V0IHVwIHlvdXIgYWNjb3VudDwvZGl2PjwvZGl2PgogICAg' +
  'PGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+QWNjZXNzIGNvZGU8L2xhYmVsPgogICAg' +
  'ICAgIDxpbnB1dCBpZD0icl9jb2RlIiBwbGFjZWhvbGRlcj0iQUJDRC1FRkdILUpLTE0iIGF1dG9jYXBpdGFsaXplPSJjaGFyYWN0' +
  'ZXJzIiBzdHlsZT0idGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJl' +
  'bD5Zb3VyIG5hbWU8L2xhYmVsPjxpbnB1dCBpZD0icl9uYW1lIiBhdXRvY29tcGxldGU9Im5hbWUiPjwvZGl2PgogICAgICA8ZGl2' +
  'IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkVtYWlsPC9sYWJlbD48aW5wdXQgaWQ9InJfZW1haWwiIHR5cGU9ImVtYWlsIiBpbnB1dG1v' +
  'ZGU9ImVtYWlsIiBhdXRvY29tcGxldGU9ImVtYWlsIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5DaG9v' +
  'c2UgYSBwYXNzd29yZDwvbGFiZWw+CiAgICAgICAgPGlucHV0IGlkPSJyX3B3IiB0eXBlPSJwYXNzd29yZCIgYXV0b2NvbXBsZXRl' +
  'PSJuZXctcGFzc3dvcmQiIHBsYWNlaG9sZGVyPSJBdCBsZWFzdCA4IGNoYXJhY3RlcnMiPjwvZGl2PgogICAgICA8YnV0dG9uIGNs' +
  'YXNzPSJidG4gYmxvY2siIGlkPSJyX2dvIj5DcmVhdGUgbXkgYWNjb3VudDwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJoaW50' +
  'IiBpZD0icl9lcnIiIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQpO21hcmdpbi10b3A6MTBweCI+PC9kaXY+CiAgICAgIDxkaXYgY2xh' +
  'c3M9ImhpbnQiIHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlcjttYXJnaW4tdG9wOjE0cHgiPgogICAgICAgIDxhIGhyZWY9IiMiIGlk' +
  'PSJyX2JhY2siPkJhY2sgdG8gc2lnbiBpbjwvYT48L2Rpdj4KICAgIDwvZGl2PjwvZGl2PmA7CgogICQoJyNyX2JhY2snKS5vbmNs' +
  'aWNrID0gZSA9PiB7IGUucHJldmVudERlZmF1bHQoKTsgbG9naW5WaWV3KCk7IH07CiAgY29uc3QgZ28gPSBhc3luYyAoKSA9PiB7' +
  'CiAgICAkKCcjcl9lcnInKS50ZXh0Q29udGVudCA9ICcnOwogICAgdHJ5IHsKICAgICAgUy5tZSA9IGF3YWl0IGFwaSgnL3JlZGVl' +
  'bScsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsKICAgICAgICBjb2RlOiAkKCcjcl9jb2RlJykudmFs' +
  'dWUsIG5hbWU6ICQoJyNyX25hbWUnKS52YWx1ZSwKICAgICAgICBlbWFpbDogJCgnI3JfZW1haWwnKS52YWx1ZSwgcGFzc3dvcmQ6' +
  'ICQoJyNyX3B3JykudmFsdWUKICAgICAgfSkgfSk7CiAgICAgIHRvYXN0KCdXZWxjb21lLCAnICsgUy5tZS5uYW1lKTsKICAgICAg' +
  'Z28yKCk7CiAgICB9IGNhdGNoIChlKSB7ICQoJyNyX2VycicpLnRleHRDb250ZW50ID0gZS5tZXNzYWdlOyB9CiAgfTsKICBjb25z' +
  'dCBnbzIgPSAoKSA9PiB7IFMudmlldyA9ICdkYXNoJzsgUy5wYXJhbXMgPSB7fTsgcmVuZGVyKCk7IH07CiAgJCgnI3JfZ28nKS5v' +
  'bmNsaWNrID0gZ287CiAgJCgnI3JfcHcnKS5vbmtleWRvd24gPSBlID0+IHsgaWYgKGUua2V5ID09PSAnRW50ZXInKSBnbygpOyB9' +
  'OwogICQoJyNyX2NvZGUnKS5mb2N1cygpOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tIGRhc2hib2FyZCAtLSAqLwphc3luYyBmdW5jdGlvbiBkYXNoVmlldygpIHsKICBjb25zdCBbc3RhdHMs' +
  'IGpvYnNdID0gYXdhaXQgUHJvbWlzZS5hbGwoW2FwaSgnL3N0YXRzJyksIGFwaSgnL2pvYnM/b3Blbj0xJyldKTsKICBjb25zdCBv' +
  'dmVyZHVlID0gam9icy5maWx0ZXIoaiA9PiB7IGNvbnN0IGQgPSBkYXlzT3V0KGouZHVlX2RhdGUpOyByZXR1cm4gZCAhPT0gbnVs' +
  'bCAmJiBkIDwgMDsgfSk7CiAgY29uc3QgdG9kYXkgPSBqb2JzLmZpbHRlcihqID0+IHsgY29uc3QgZCA9IGRheXNPdXQoai5kdWVf' +
  'ZGF0ZSk7IHJldHVybiBkICE9PSBudWxsICYmIGQgPj0gMCAmJiBkIDw9IDE7IH0pOwogIGNvbnN0IHJ1c2ggPSBqb2JzLmZpbHRl' +
  'cihqID0+IGoucHJpb3JpdHkgIT09ICdSb3V0aW5lJyk7CiAgY29uc3QgbWluZSA9IGlzQWRtaW4oKSA/IGpvYnMgOiBqb2JzOwoK' +
  'ICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj4ke2lzQWRtaW4oKSA/ICdPcGVyYXRpb25zIHRv' +
  'ZGF5JyA6ICdNeSBkYXknfTwvaDE+CiAgICA8ZGl2IGNsYXNzPSJzdGF0cyI+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxkaXYg' +
  'Y2xhc3M9Im4iPiR7c3RhdHMub3Blbl9qb2JzfTwvZGl2PjxkaXYgY2xhc3M9ImwiPk9wZW4gam9iczwvZGl2PjwvZGl2PgogICAg' +
  'ICA8ZGl2IGNsYXNzPSJzdGF0ICR7c3RhdHMub3ZlcmR1ZSA/ICdhbGVydCcgOiAnJ30iPjxkaXYgY2xhc3M9Im4iPiR7c3RhdHMu' +
  'b3ZlcmR1ZX08L2Rpdj48ZGl2IGNsYXNzPSJsIj5QYXN0IGR1ZTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdGF0Ij48' +
  'ZGl2IGNsYXNzPSJuIj4ke3N0YXRzLnJ1c2h9PC9kaXY+PGRpdiBjbGFzcz0ibCI+UnVzaCAvIHNhbWUgZGF5PC9kaXY+PC9kaXY+' +
  'CiAgICAgIDxkaXYgY2xhc3M9InN0YXQgZ29vZCI+PGRpdiBjbGFzcz0ibiI+JHtzdGF0cy5zZXJ2ZWRfN2R9PC9kaXY+PGRpdiBj' +
  'bGFzcz0ibCI+U2VydmVkLCA3IGRheXM8L2Rpdj48L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAg' +
  'ICA8aDI+Um91dGUgbXkgZGF5IDxzcGFuIGNsYXNzPSJzdWIiPuKAlCAke21pbmUubGVuZ3RofSBvcGVuIHN0b3Ake21pbmUubGVu' +
  'Z3RoID09PSAxID8gJycgOiAncyd9PC9zcGFuPjwvaDI+CiAgICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDot' +
  'NHB4Ij5PcGVucyBHb29nbGUgTWFwcyB3aXRoIHlvdXIgc3RvcHMgaW4gb3JkZXIgKHVwIHRvIDEwKS4gTm8gbWFwcGluZyBmZWVz' +
  'IOKAlCBpdCBqdXN0IGhhbmRzIG9mZiB0byB0aGUgYXBwIHlvdSBhbHJlYWR5IGhhdmUuPC9wPgogICAgICA8ZGl2IGNsYXNzPSJy' +
  'b3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBuYXYiIGlkPSJyb3V0ZUJ0biIg' +
  'JHttaW5lLmxlbmd0aCA/ICcnIDogJ2Rpc2FibGVkJ30+U3RhcnQgcm91dGUgKCR7TWF0aC5taW4obWluZS5sZW5ndGgsIDEwKX0g' +
  'c3RvcHMpPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9InJvdXRlTGlzdCI+U2VlIG9yZGVy' +
  'PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgJHtzZWN0aW9uKCdQYXN0IGR1ZScsIG92ZXJkdWUpfQogICAg' +
  'JHtzZWN0aW9uKCdEdWUgdG9kYXkgb3IgdG9tb3Jyb3cnLCB0b2RheSl9CiAgICAke3NlY3Rpb24oJ1J1c2ggJmFtcDsgc2FtZSBk' +
  'YXknLCBydXNoLmZpbHRlcihqID0+ICFvdmVyZHVlLmluY2x1ZGVzKGopICYmICF0b2RheS5pbmNsdWRlcyhqKSkpfQogICAgJHtv' +
  'dmVyZHVlLmxlbmd0aCArIHRvZGF5Lmxlbmd0aCArIHJ1c2gubGVuZ3RoID09PSAwCiAgICAgID8gYDxkaXYgY2xhc3M9ImNhcmQi' +
  'PjxkaXYgY2xhc3M9ImVtcHR5Ij5Ob3RoaW5nIHVyZ2VudC4gJHttaW5lLmxlbmd0aH0gb3BlbiBqb2Ike21pbmUubGVuZ3RoID09' +
  'PSAxID8gJycgOiAncyd9IHRvdGFsIOKAlCBzZWUgdGhlIEpvYnMgdGFiLjwvZGl2PjwvZGl2PmAgOiAnJ30KICBgKTsKICBiaW5k' +
  'U2hlbGwoKTsKICBiaW5kSm9iSXRlbXMoKTsKICBjb25zdCByYiA9ICQoJyNyb3V0ZUJ0bicpOwogIGlmIChyYikgcmIub25jbGlj' +
  'ayA9ICgpID0+IHsKICAgIGNvbnN0IHVybCA9IHJvdXRlVXJsKG1pbmUuc2xpY2UoMCwgMTApKTsKICAgIGlmICh1cmwpIHdpbmRv' +
  'dy5vcGVuKHVybCwgJ19ibGFuaycpOwogIH07CiAgJCgnI3JvdXRlTGlzdCcpLm9uY2xpY2sgPSAoKSA9PiBzaGVldCgnUm91dGUg' +
  'b3JkZXInLCBgCiAgICA8cCBjbGFzcz0iaGludCI+T3JkZXJlZCBieSBwcmlvcml0eSwgdGhlbiBkdWUgZGF0ZS4gVGFwIGFueSBz' +
  'dG9wIHRvIG5hdmlnYXRlIHRvIGl0IGFsb25lLjwvcD4KICAgIDxkaXYgY2xhc3M9Imxpc3QiPiR7bWluZS5zbGljZSgwLCAxMCku' +
  'bWFwKChqLCBpKSA9PiBgCiAgICAgIDxkaXYgY2xhc3M9Iml0ZW0iIGRhdGEtbmF2PSIke2VzYyhhZGRyT2YoaikpfSI+CiAgICAg' +
  'ICAgPGRpdiBjbGFzcz0iciI+PGRpdj48ZGl2IGNsYXNzPSJ0Ij4ke2kgKyAxfS4gJHtlc2Moai5yZWNpcGllbnRfbmFtZSl9PC9k' +
  'aXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibSI+JHtlc2MoYWRkck9mKGopKX08L2Rpdj48L2Rpdj4KICAgICAgICA8c3BhbiBjbGFz' +
  'cz0icGlsbCAke2NscyhqLnByaW9yaXR5KX0iPiR7ZXNjKGoucHJpb3JpdHkpfTwvc3Bhbj48L2Rpdj48L2Rpdj5gKS5qb2luKCcn' +
  'KX08L2Rpdj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgYmxvY2siIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiIG9uY2xpY2s9' +
  'ImNsb3NlU2hlZXQoKSI+Q2xvc2U8L2J1dHRvbj5gLAogICAgZWwgPT4gZWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtbmF2XScp' +
  'LmZvckVhY2gobiA9PgogICAgICBuLm9uY2xpY2sgPSAoKSA9PiB3aW5kb3cub3BlbihuYXZVcmwobi5kYXRhc2V0Lm5hdiksICdf' +
  'YmxhbmsnKSkpOwp9CgpmdW5jdGlvbiBzZWN0aW9uKHRpdGxlLCBsaXN0KSB7CiAgaWYgKCFsaXN0Lmxlbmd0aCkgcmV0dXJuICcn' +
  'OwogIHJldHVybiBgPGRpdiBjbGFzcz0iY2FyZCI+PGgyPiR7dGl0bGV9IDxzcGFuIGNsYXNzPSJzdWIiPiR7bGlzdC5sZW5ndGh9' +
  'PC9zcGFuPjwvaDI+CiAgICA8ZGl2IGNsYXNzPSJsaXN0Ij4ke2xpc3QubWFwKGpvYkl0ZW0pLmpvaW4oJycpfTwvZGl2PjwvZGl2' +
  'PmA7Cn0KCmZ1bmN0aW9uIGpvYkl0ZW0oaikgewogIGNvbnN0IGQgPSBkYXlzT3V0KGouZHVlX2RhdGUpOwogIGNvbnN0IGxhdGUg' +
  'PSBkICE9PSBudWxsICYmIGQgPCAwICYmICFbJ1NlcnZlZCcsICdOb24tRXN0JywgJ0NhbmNlbGxlZCddLmluY2x1ZGVzKGouc3Rh' +
  'dHVzKTsKICBjb25zdCBkdWUgPSBqLmR1ZV9kYXRlCiAgICA/IChsYXRlID8gYDxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQp' +
  'O2ZvbnQtd2VpZ2h0OjYwMCI+JHtNYXRoLmFicyhkKX1kIHBhc3QgZHVlPC9zcGFuPmAKICAgICAgICAgICAgOiAoZCA9PT0gMCA/' +
  'ICdkdWUgdG9kYXknIDogZCA9PT0gMSA/ICdkdWUgdG9tb3Jyb3cnIDogJ2R1ZSAnICsgZm10RGF0ZU9ubHkoai5kdWVfZGF0ZSkp' +
  'KQogICAgOiAnbm8gZHVlIGRhdGUnOwogIHJldHVybiBgPGRpdiBjbGFzcz0iaXRlbSBwLSR7Y2xzKGoucHJpb3JpdHkpfSAke2xh' +
  'dGUgPyAnb3ZlcmR1ZScgOiAnJ30iIGRhdGEtam9iPSIke2ouaWR9Ij4KICAgIDxkaXYgY2xhc3M9InIiPgogICAgICA8ZGl2Pgog' +
  'ICAgICAgIDxkaXYgY2xhc3M9InQiPiR7ZXNjKGoucmVjaXBpZW50X25hbWUpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im0i' +
  'PiR7ZXNjKGouam9iX251bWJlcil9IMK3ICR7ZXNjKGouY2l0eSB8fCAnJyl9JHtqLmNpdHkgPyAnLCAnIDogJyd9JHtlc2Moai5z' +
  'dGF0ZSB8fCAnJyl9IMK3ICR7ZHVlfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im0iPiR7ZXNjKGouY2xpZW50X25hbWUgfHwg' +
  'J05vIGNsaWVudCcpfSR7ai5zZXJ2ZXJfbmFtZSA/ICcg4oaSICcgKyBlc2Moai5zZXJ2ZXJfbmFtZSkgOiAnJ30ke2ouYXR0ZW1w' +
  'dF9jb3VudCA/ICcgwrcgJyArIGouYXR0ZW1wdF9jb3VudCArICcgYXR0ZW1wdCcgKyAoai5hdHRlbXB0X2NvdW50ID09PSAxID8g' +
  'JycgOiAncycpIDogJyd9PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJ0ZXh0LWFsaWduOnJpZ2h0Ij4KICAg' +
  'ICAgICA8c3BhbiBjbGFzcz0icGlsbCAke2NscyhqLnN0YXR1cyl9Ij4ke2VzYyhqLnN0YXR1cyl9PC9zcGFuPgogICAgICAgICR7' +
  'ai5wcmlvcml0eSAhPT0gJ1JvdXRpbmUnID8gYDxkaXYgc3R5bGU9Im1hcmdpbi10b3A6NXB4Ij48c3BhbiBjbGFzcz0icGlsbCBy' +
  'dXNoIj4ke2VzYyhqLnByaW9yaXR5KX08L3NwYW4+PC9kaXY+YCA6ICcnfQogICAgICA8L2Rpdj4KICAgIDwvZGl2PjwvZGl2PmA7' +
  'Cn0KCmZ1bmN0aW9uIGJpbmRKb2JJdGVtcygpIHsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1qb2JdJykuZm9y' +
  'RWFjaChlbCA9PgogICAgZWwub25jbGljayA9ICgpID0+IGdvKCdqb2InLCB7IGlkOiBlbC5kYXRhc2V0LmpvYiB9KSk7Cn0KCi8q' +
  'IC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBqb2JzIC0tICov' +
  'CmFzeW5jIGZ1bmN0aW9uIGpvYnNWaWV3KCkgewogIGNvbnN0IGYgPSBTLnBhcmFtczsKICBjb25zdCBxcyA9IG5ldyBVUkxTZWFy' +
  'Y2hQYXJhbXMoKTsKICBpZiAoZi5zdGF0dXMpIHFzLnNldCgnc3RhdHVzJywgZi5zdGF0dXMpOwogIGlmIChmLnEpIHFzLnNldCgn' +
  'cScsIGYucSk7CiAgaWYgKGYub3BlbikgcXMuc2V0KCdvcGVuJywgJzEnKTsKICBjb25zdCBqb2JzID0gYXdhaXQgYXBpKCcvam9i' +
  'cz8nICsgcXMudG9TdHJpbmcoKSk7CgogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8aDEgY2xhc3M9InBhZ2UiPiR7aXNB' +
  'ZG1pbigpID8gJ0pvYnMnIDogJ015IGpvYnMnfTwvaDE+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGRpdiBjbGFzcz0i' +
  'cm93Ij4KICAgICAgICA8aW5wdXQgaWQ9InEiIHBsYWNlaG9sZGVyPSJTZWFyY2ggbmFtZSwgY2FzZSAjLCBqb2IgIywgYWRkcmVz' +
  'cyIgdmFsdWU9IiR7ZXNjKGYucSB8fCAnJyl9IiBzdHlsZT0iZmxleDoxO21pbi13aWR0aDoxNjBweCI+CiAgICAgICAgPHNlbGVj' +
  'dCBpZD0ic3RhdHVzIiBzdHlsZT0id2lkdGg6YXV0byI+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSIiPkFueSBzdGF0dXM8L29w' +
  'dGlvbj4KICAgICAgICAgICR7WydQZW5kaW5nJywgJ0Fzc2lnbmVkJywgJ0F0dGVtcHRlZCcsICdTZXJ2ZWQnLCAnTm9uLUVzdCcs' +
  'ICdPbiBIb2xkJywgJ0NhbmNlbGxlZCddCiAgICAgICAgICAgIC5tYXAocyA9PiBgPG9wdGlvbiAke2Yuc3RhdHVzID09PSBzID8g' +
  'J3NlbGVjdGVkJyA6ICcnfT4ke3N9PC9vcHRpb24+YCkuam9pbignJyl9CiAgICAgICAgPC9zZWxlY3Q+CiAgICAgICAgPGxhYmVs' +
  'IHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo2cHg7bWFyZ2luOjA7Zm9udC1zaXplOjEzcHgiPgog' +
  'ICAgICAgICAgPGlucHV0IHR5cGU9ImNoZWNrYm94IiBpZD0ib3Blbk9ubHkiICR7Zi5vcGVuID8gJ2NoZWNrZWQnIDogJyd9IHN0' +
  'eWxlPSJ3aWR0aDphdXRvIj4gT3BlbiBvbmx5PC9sYWJlbD4KICAgICAgPC9kaXY+CiAgICAgICR7aXNBZG1pbigpID8gJzxidXR0' +
  'b24gY2xhc3M9ImJ0biBibG9jayIgaWQ9Im5ld0pvYiIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+KyBOZXcgam9iPC9idXR0b24+' +
  'JyA6ICcnfQogICAgPC9kaXY+CiAgICAke2pvYnMubGVuZ3RoID8gYDxkaXYgY2xhc3M9Imxpc3QiPiR7am9icy5tYXAoam9iSXRl' +
  'bSkuam9pbignJyl9PC9kaXY+YAogICAgICA6ICc8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJlbXB0eSI+Tm8gam9icyBt' +
  'YXRjaC48L2Rpdj48L2Rpdj4nfQogIGApOwogIGJpbmRTaGVsbCgpOyBiaW5kSm9iSXRlbXMoKTsKICBjb25zdCBhcHBseSA9ICgp' +
  'ID0+IGdvKCdqb2JzJywgeyBxOiAkKCcjcScpLnZhbHVlLnRyaW0oKSwgc3RhdHVzOiAkKCcjc3RhdHVzJykudmFsdWUsIG9wZW46' +
  'ICQoJyNvcGVuT25seScpLmNoZWNrZWQgfSk7CiAgJCgnI3EnKS5vbmtleWRvd24gPSBlID0+IHsgaWYgKGUua2V5ID09PSAnRW50' +
  'ZXInKSBhcHBseSgpOyB9OwogICQoJyNzdGF0dXMnKS5vbmNoYW5nZSA9IGFwcGx5OwogICQoJyNvcGVuT25seScpLm9uY2hhbmdl' +
  'ID0gYXBwbHk7CiAgaWYgKCQoJyNuZXdKb2InKSkgJCgnI25ld0pvYicpLm9uY2xpY2sgPSAoKSA9PiBqb2JGb3JtKG51bGwpOwp9' +
  'CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gam9iIGZvcm0g' +
  'LS0gKi8KYXN5bmMgZnVuY3Rpb24gam9iRm9ybShqb2IpIHsKICBjb25zdCBbY2xpZW50cywgdXNlcnNdID0gYXdhaXQgUHJvbWlz' +
  'ZS5hbGwoW2FwaSgnL2NsaWVudHMnKSwgYXBpKCcvdXNlcnMnKV0pOwogIGNvbnN0IHYgPSBqb2IgfHwgeyBzZXJ2aWNlX3R5cGU6' +
  'ICdQZXJzb25hbCcsIHByaW9yaXR5OiAnUm91dGluZScsIHN0YXR1czogJ1BlbmRpbmcnIH07CiAgY29uc3Qgb3B0ID0gKGxpc3Qs' +
  'IHNlbCwgbGFiZWwpID0+IGxpc3QubWFwKHggPT4KICAgIGA8b3B0aW9uIHZhbHVlPSIke3guaWR9IiAke1N0cmluZyhzZWwpID09' +
  'PSBTdHJpbmcoeC5pZCkgPyAnc2VsZWN0ZWQnIDogJyd9PiR7ZXNjKGxhYmVsKHgpKX08L29wdGlvbj5gKS5qb2luKCcnKTsKCiAg' +
  'c2hlZXQoam9iID8gJ0VkaXQgJyArIGpvYi5qb2JfbnVtYmVyIDogJ05ldyBqb2InLCBgCiAgICA8ZGl2IGNsYXNzPSJkcm9wem9u' +
  'ZSI+CiAgICAgIDxsYWJlbD5TdGFydCBmcm9tIHRoZSBwYXBlcnM8L2xhYmVsPgogICAgICA8aW5wdXQgdHlwZT0iZmlsZSIgaWQ9' +
  'ImZfcGRmIiBhY2NlcHQ9ImFwcGxpY2F0aW9uL3BkZiwucGRmIj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgaWQ9InBkZk1zZyI+' +
  'UGljayB0aGUgc3VtbW9ucywgY2l0YXRpb24sIHN1YnBvZW5hIG9yIGNvbXBsYWludCBhcyBhIFBERiBhbmQgSSdsbAogICAgICAg' +
  'IHJlYWQgd2hhdCBJIGNhbiBpbnRvIHRoZSBmb3JtIGJlbG93LiBBbHdheXMgY2hlY2sgaXQgYWdhaW5zdCB0aGUgZG9jdW1lbnQg' +
  'YmVmb3JlIHNhdmluZy48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgIDxkaXYgY2xhc3M9' +
  'ImZpZWxkIj48bGFiZWw+Q2xpZW50PC9sYWJlbD48c2VsZWN0IGlkPSJmX2NsaWVudF9pZCI+CiAgICAgICAgPG9wdGlvbiB2YWx1' +
  'ZT0iIj7igJQgbm9uZSDigJQ8L29wdGlvbj4ke29wdChjbGllbnRzLCB2LmNsaWVudF9pZCwgYyA9PiBjLm5hbWUpfTwvc2VsZWN0' +
  'PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkFzc2lnbiB0bzwvbGFiZWw+PHNlbGVjdCBpZD0iZl9hc3Np' +
  'Z25lZF90byI+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0iIj7igJQgdW5hc3NpZ25lZCDigJQ8L29wdGlvbj4ke29wdCh1c2Vycy5m' +
  'aWx0ZXIodSA9PiB1LmFjdGl2ZSksIHYuYXNzaWduZWRfdG8sIHUgPT4gdS5uYW1lKX08L3NlbGVjdD48L2Rpdj4KICAgIDwvZGl2' +
  'PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5QZXJzb24gLyBlbnRpdHkgdG8gc2VydmUgKjwvbGFiZWw+PGlucHV0IGlk' +
  'PSJmX3JlY2lwaWVudF9uYW1lIiB2YWx1ZT0iJHtlc2Modi5yZWNpcGllbnRfbmFtZSl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9' +
  'ImZpZWxkIj48bGFiZWw+U2VydmljZSBhZGRyZXNzPC9sYWJlbD48aW5wdXQgaWQ9ImZfYWRkcmVzczEiIHBsYWNlaG9sZGVyPSJT' +
  'dHJlZXQgYWRkcmVzcyIgdmFsdWU9IiR7ZXNjKHYuYWRkcmVzczEpfSI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkIGczIj4K' +
  'ICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5BcHQgLyB1bml0PC9sYWJlbD48aW5wdXQgaWQ9ImZfYWRkcmVzczIiIHZh' +
  'bHVlPSIke2VzYyh2LmFkZHJlc3MyKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNpdHk8L2xhYmVs' +
  'PjxpbnB1dCBpZD0iZl9jaXR5IiB2YWx1ZT0iJHtlc2Modi5jaXR5KX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+' +
  'PGxhYmVsPlN0YXRlIC8gWklQPC9sYWJlbD4KICAgICAgICA8ZGl2IGNsYXNzPSJyb3ciPjxpbnB1dCBpZD0iZl9zdGF0ZSIgc3R5' +
  'bGU9IndpZHRoOjcwcHgiIG1heGxlbmd0aD0iMiIgdmFsdWU9IiR7ZXNjKHYuc3RhdGUpfSI+CiAgICAgICAgPGlucHV0IGlkPSJm' +
  'X3ppcCIgc3R5bGU9ImZsZXg6MSIgaW5wdXRtb2RlPSJudW1lcmljIiB2YWx1ZT0iJHtlc2Modi56aXApfSI+PC9kaXY+PC9kaXY+' +
  'CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UmVjaXBpZW50IG5vdGVzIChkZXNjcmlwdGlvbiwgd29y' +
  'ayBob3VycywgdmVoaWNsZSwgZ2F0ZSBjb2RlKTwvbGFiZWw+CiAgICAgIDx0ZXh0YXJlYSBpZD0iZl9yZWNpcGllbnRfbm90ZXMi' +
  'IHN0eWxlPSJtaW4taGVpZ2h0OjYwcHgiPiR7ZXNjKHYucmVjaXBpZW50X25vdGVzKX08L3RleHRhcmVhPjwvZGl2PgogICAgPGRp' +
  'diBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q2FzZSBudW1iZXI8L2xhYmVsPjxpbnB1' +
  'dCBpZD0iZl9jYXNlX251bWJlciIgdmFsdWU9IiR7ZXNjKHYuY2FzZV9udW1iZXIpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9' +
  'ImZpZWxkIj48bGFiZWw+Q291cnQ8L2xhYmVsPjxpbnB1dCBpZD0iZl9jb3VydCIgdmFsdWU9IiR7ZXNjKHYuY291cnQpfSI+PC9k' +
  'aXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGxhaW50aWZmPC9sYWJlbD48aW5wdXQgaWQ9ImZfcGxhaW50aWZm' +
  'IiB2YWx1ZT0iJHtlc2Modi5wbGFpbnRpZmYpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RGVmZW5k' +
  'YW50PC9sYWJlbD48aW5wdXQgaWQ9ImZfZGVmZW5kYW50IiB2YWx1ZT0iJHtlc2Modi5kZWZlbmRhbnQpfSI+PC9kaXY+CiAgICA8' +
  'L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RG9jdW1lbnRzIHRvIHNlcnZlPC9sYWJlbD48aW5wdXQgaWQ9ImZf' +
  'ZG9jdW1lbnRzIiBwbGFjZWhvbGRlcj0iU3VtbW9ucyBhbmQgQ29tcGxhaW50IiB2YWx1ZT0iJHtlc2Modi5kb2N1bWVudHMpfSI+' +
  'PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkIGczIj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5TZXJ2aWNlIHR5' +
  'cGU8L2xhYmVsPjxzZWxlY3QgaWQ9ImZfc2VydmljZV90eXBlIj4KICAgICAgICAke1snUGVyc29uYWwnLCAnU3Vic3RpdHV0ZScs' +
  'ICdQb3N0aW5nJywgJ0NlcnRpZmllZCBNYWlsJywgJ0NvcnBvcmF0ZSddLm1hcChzID0+IGA8b3B0aW9uICR7di5zZXJ2aWNlX3R5' +
  'cGUgPT09IHMgPyAnc2VsZWN0ZWQnIDogJyd9PiR7c308L29wdGlvbj5gKS5qb2luKCcnKX08L3NlbGVjdD48L2Rpdj4KICAgICAg' +
  'PGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Qcmlvcml0eTwvbGFiZWw+PHNlbGVjdCBpZD0iZl9wcmlvcml0eSI+CiAgICAgICAg' +
  'JHtbJ1JvdXRpbmUnLCAnUnVzaCcsICdTYW1lIERheSddLm1hcChzID0+IGA8b3B0aW9uICR7di5wcmlvcml0eSA9PT0gcyA/ICdz' +
  'ZWxlY3RlZCcgOiAnJ30+JHtzfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJm' +
  'aWVsZCI+PGxhYmVsPkR1ZSBkYXRlPC9sYWJlbD48aW5wdXQgaWQ9ImZfZHVlX2RhdGUiIHR5cGU9ImRhdGUiIHZhbHVlPSIke3Yu' +
  'ZHVlX2RhdGUgPyBTdHJpbmcodi5kdWVfZGF0ZSkuc2xpY2UoMCwgMTApIDogJyd9Ij48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRp' +
  'diBjbGFzcz0iZ3JpZCBnMyI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q2xpZW50IGZlZTwvbGFiZWw+PGlucHV0' +
  'IGlkPSJmX2NsaWVudF9mZWUiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgdmFsdWU9IiR7di5jbGllbnRfZmVlIHx8ICcnfSI+' +
  'PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U2VydmVyIHBheTwvbGFiZWw+PGlucHV0IGlkPSJmX3NlcnZl' +
  'cl9wYXkiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgdmFsdWU9IiR7di5zZXJ2ZXJfcGF5IHx8ICcnfSI+PC9kaXY+CiAgICAg' +
  'IDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U3RhdHVzPC9sYWJlbD48c2VsZWN0IGlkPSJmX3N0YXR1cyI+CiAgICAgICAgJHtb' +
  'J1BlbmRpbmcnLCAnQXNzaWduZWQnLCAnQXR0ZW1wdGVkJywgJ1NlcnZlZCcsICdOb24tRXN0JywgJ09uIEhvbGQnLCAnQ2FuY2Vs' +
  'bGVkJ10ubWFwKHMgPT4gYDxvcHRpb24gJHt2LnN0YXR1cyA9PT0gcyA/ICdzZWxlY3RlZCcgOiAnJ30+JHtzfTwvb3B0aW9uPmAp' +
  'LmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkludGVybmFs' +
  'IG5vdGVzPC9sYWJlbD48dGV4dGFyZWEgaWQ9ImZfbm90ZXMiIHN0eWxlPSJtaW4taGVpZ2h0OjYwcHgiPiR7ZXNjKHYubm90ZXMp' +
  'fTwvdGV4dGFyZWE+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjZweCI+CiAgICAgIDxidXR0' +
  'b24gY2xhc3M9ImJ0biIgaWQ9InNhdmUiPiR7am9iID8gJ1NhdmUgY2hhbmdlcycgOiAnQ3JlYXRlIGpvYid9PC9idXR0b24+CiAg' +
  'ICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIG9uY2xpY2s9ImNsb3NlU2hlZXQoKSI+Q2FuY2VsPC9idXR0b24+CiAgICAgICR7' +
  'am9iID8gJzxidXR0b24gY2xhc3M9ImJ0biBnaG9zdCIgaWQ9ImRlbCIgc3R5bGU9ImNvbG9yOnZhcigtLWJhZCk7bWFyZ2luLWxl' +
  'ZnQ6YXV0byI+RGVsZXRlPC9idXR0b24+JyA6ICcnfQogICAgPC9kaXY+YCwgZWwgPT4gewogICAgLyogLS0tLSByZWFkIGEgc3Vt' +
  'bW9ucy9jaXRhdGlvbiBQREYgYW5kIGZpbGwgd2hhdCB3ZSBjYW4gLS0tLSAqLwogICAgY29uc3QgcGRmTXNnID0gZWwucXVlcnlT' +
  'ZWxlY3RvcignI3BkZk1zZycpOwogICAgY29uc3QgRklMTEFCTEUgPSBbJ2Nhc2VfbnVtYmVyJywgJ2NvdXJ0JywgJ3BsYWludGlm' +
  'ZicsICdkZWZlbmRhbnQnLCAncmVjaXBpZW50X25hbWUnLAogICAgICAnYWRkcmVzczEnLCAnYWRkcmVzczInLCAnY2l0eScsICdz' +
  'dGF0ZScsICd6aXAnLCAnZG9jdW1lbnRzJ107CiAgICBjb25zdCBMQUJFTFMgPSB7CiAgICAgIGNhc2VfbnVtYmVyOiAnY2FzZSBu' +
  'dW1iZXInLCBjb3VydDogJ2NvdXJ0JywgcGxhaW50aWZmOiAncGxhaW50aWZmJywgZGVmZW5kYW50OiAnZGVmZW5kYW50JywKICAg' +
  'ICAgcmVjaXBpZW50X25hbWU6ICdwZXJzb24gdG8gc2VydmUnLCBhZGRyZXNzMTogJ2FkZHJlc3MnLCBhZGRyZXNzMjogJ3VuaXQn' +
  'LCBjaXR5OiAnY2l0eScsCiAgICAgIHN0YXRlOiAnc3RhdGUnLCB6aXA6ICdaSVAnLCBkb2N1bWVudHM6ICdkb2N1bWVudHMnCiAg' +
  'ICB9OwogICAgZWwucXVlcnlTZWxlY3RvcignI2ZfcGRmJykub25jaGFuZ2UgPSBhc3luYyBlID0+IHsKICAgICAgY29uc3QgZmls' +
  'ZSA9IGUudGFyZ2V0LmZpbGVzICYmIGUudGFyZ2V0LmZpbGVzWzBdOwogICAgICBpZiAoIWZpbGUpIHJldHVybjsKICAgICAgcGRm' +
  'TXNnLmlubmVySFRNTCA9ICdSZWFkaW5nICcgKyBlc2MoZmlsZS5uYW1lKSArICfigKYnOwogICAgICB0cnkgewogICAgICAgIGNv' +
  'bnN0IGRhdGEgPSBhd2FpdCBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHsKICAgICAgICAgIGNvbnN0IHIgPSBuZXcgRmlsZVJl' +
  'YWRlcigpOwogICAgICAgICAgci5vbmxvYWQgPSAoKSA9PiByZXMoU3RyaW5nKHIucmVzdWx0KS5zcGxpdCgnLCcpWzFdKTsKICAg' +
  'ICAgICAgIHIub25lcnJvciA9ICgpID0+IHJlaihuZXcgRXJyb3IoJ0NvdWxkIG5vdCByZWFkIHRoYXQgZmlsZScpKTsKICAgICAg' +
  'ICAgIHIucmVhZEFzRGF0YVVSTChmaWxlKTsKICAgICAgICB9KTsKICAgICAgICBjb25zdCBvdXQgPSBhd2FpdCBhcGkoJy9wYXJz' +
  'ZS1kb2N1bWVudCcsIHsKICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IG5hbWU6IGZpbGUu' +
  'bmFtZSwgZGF0YSB9KQogICAgICAgIH0pOwogICAgICAgIGlmIChvdXQud2FybmluZykgeyBwZGZNc2cuaW5uZXJIVE1MID0gJzxi' +
  'IHN0eWxlPSJjb2xvcjp2YXIoLS13YXJuKSI+JyArIGVzYyhvdXQud2FybmluZykgKyAnPC9iPic7IHJldHVybjsgfQogICAgICAg' +
  'IGNvbnN0IGZpbGxlZCA9IFtdLCBza2lwcGVkID0gW10sIG1pc3NlZCA9IFtdOwogICAgICAgIGZvciAoY29uc3QgZiBvZiBGSUxM' +
  'QUJMRSkgewogICAgICAgICAgY29uc3QgaW5wdXQgPSBlbC5xdWVyeVNlbGVjdG9yKCcjZl8nICsgZik7CiAgICAgICAgICBpZiAo' +
  'IWlucHV0KSBjb250aW51ZTsKICAgICAgICAgIGNvbnN0IHZhbCA9IG91dC5maWVsZHNbZl07CiAgICAgICAgICBpZiAoIXZhbCkg' +
  'eyBtaXNzZWQucHVzaChMQUJFTFNbZl0pOyBjb250aW51ZTsgfQogICAgICAgICAgaWYgKGlucHV0LnZhbHVlICYmIGlucHV0LnZh' +
  'bHVlLnRyaW0oKSAmJiBpbnB1dC52YWx1ZS50cmltKCkgIT09IFN0cmluZyh2YWwpLnRyaW0oKSkgewogICAgICAgICAgICBza2lw' +
  'cGVkLnB1c2goTEFCRUxTW2ZdKTsKICAgICAgICAgICAgY29udGludWU7CiAgICAgICAgICB9CiAgICAgICAgICBpbnB1dC52YWx1' +
  'ZSA9IHZhbDsKICAgICAgICAgIGlucHV0LnN0eWxlLmJhY2tncm91bmQgPSAnI2U5ZjZlZSc7CiAgICAgICAgICBzZXRUaW1lb3V0' +
  'KCgpID0+IHsgaW5wdXQuc3R5bGUuYmFja2dyb3VuZCA9ICcnOyB9LCA0MDAwKTsKICAgICAgICAgIGZpbGxlZC5wdXNoKExBQkVM' +
  'U1tmXSk7CiAgICAgICAgfQogICAgICAgIGxldCBtc2c7CiAgICAgICAgaWYgKGZpbGxlZC5sZW5ndGgpIHsKICAgICAgICAgIG1z' +
  'ZyA9ICc8YiBzdHlsZT0iY29sb3I6dmFyKC0tb2spIj5GaWxsZWQgJyArIGZpbGxlZC5sZW5ndGggKyAnIGZpZWxkJyArIChmaWxs' +
  'ZWQubGVuZ3RoID09PSAxID8gJycgOiAncycpICsKICAgICAgICAgICAgJzwvYj4gZnJvbSAnICsgZXNjKGZpbGUubmFtZSkgKyAn' +
  'ICgnICsgKG91dC5wYWdlcyB8fCAnPycpICsgJyBwYWdlJyArIChvdXQucGFnZXMgPT09IDEgPyAnJyA6ICdzJykgKyAnKTogJyAr' +
  'CiAgICAgICAgICAgIGVzYyhmaWxsZWQuam9pbignLCAnKSkgKyAnLic7CiAgICAgICAgfSBlbHNlIGlmIChza2lwcGVkLmxlbmd0' +
  'aCkgewogICAgICAgICAgbXNnID0gJzxiIHN0eWxlPSJjb2xvcjp2YXIoLS13YXJuKSI+RXZlcnl0aGluZyBJIGZvdW5kIHdhcyBh' +
  'bHJlYWR5IGZpbGxlZCBpbjwvYj4g4oCUIG5vdGhpbmcgb2YgeW91cnMgd2FzICcgKwogICAgICAgICAgICAnb3ZlcndyaXR0ZW4u' +
  'IENsZWFyIGEgZmllbGQgZmlyc3QgaWYgeW91IHdhbnQgdGhlIGRvY3VtZW50XCdzIHZlcnNpb24gb2YgaXQuJzsKICAgICAgICB9' +
  'IGVsc2UgewogICAgICAgICAgbXNnID0gJzxiIHN0eWxlPSJjb2xvcjp2YXIoLS13YXJuKSI+Tm90aGluZyByZWNvZ25pc2FibGUg' +
  'Zm91bmQ8L2I+IGluICcgKyBlc2MoZmlsZS5uYW1lKSArCiAgICAgICAgICAgICcuIEl0IG1heSBiZSBsYWlkIG91dCBkaWZmZXJl' +
  'bnRseSB0byB0aGUgZG9jdW1lbnRzIHRoaXMgY2FuIHJlYWQg4oCUIGZpbGwgdGhlIGpvYiBpbiBieSBoYW5kLic7CiAgICAgICAg' +
  'fQogICAgICAgIGlmIChmaWxsZWQubGVuZ3RoICYmIHNraXBwZWQubGVuZ3RoKSBtc2cgKz0gJyBMZWZ0IHlvdXIgZXhpc3Rpbmcg' +
  'JyArIGVzYyhza2lwcGVkLmpvaW4oJywgJykpICsgJyBhbG9uZS4nOwogICAgICAgIGlmIChtaXNzZWQubGVuZ3RoKSBtc2cgKz0g' +
  'JyBOb3QgZm91bmQ6ICcgKyBlc2MobWlzc2VkLmpvaW4oJywgJykpICsgJy4nOwogICAgICAgIG1zZyArPSAnPGJyPjxiPkNoZWNr' +
  'IGV2ZXJ5IGZpbGxlZCBmaWVsZCBhZ2FpbnN0IHRoZSBkb2N1bWVudCBiZWZvcmUgc2F2aW5nLjwvYj4nOwogICAgICAgIHBkZk1z' +
  'Zy5pbm5lckhUTUwgPSBtc2c7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIHBkZk1zZy5pbm5lckhUTUwgPSAnPGIgc3R5' +
  'bGU9ImNvbG9yOnZhcigtLWJhZCkiPicgKyBlc2MoZXJyLm1lc3NhZ2UpICsgJzwvYj4nOwogICAgICB9CiAgICB9OwoKICAgIC8v' +
  'IGF1dG8tZmlsbCBmZWUvcGF5IGRlZmF1bHRzIGZyb20gdGhlIHNlbGVjdGVkIGNsaWVudCAvIHNlcnZlcgogICAgZWwucXVlcnlT' +
  'ZWxlY3RvcignI2ZfY2xpZW50X2lkJykub25jaGFuZ2UgPSBlID0+IHsKICAgICAgY29uc3QgYyA9IGNsaWVudHMuZmluZCh4ID0+' +
  'IFN0cmluZyh4LmlkKSA9PT0gZS50YXJnZXQudmFsdWUpOwogICAgICBpZiAoYyAmJiBjLmRlZmF1bHRfZmVlICYmICFlbC5xdWVy' +
  'eVNlbGVjdG9yKCcjZl9jbGllbnRfZmVlJykudmFsdWUpCiAgICAgICAgZWwucXVlcnlTZWxlY3RvcignI2ZfY2xpZW50X2ZlZScp' +
  'LnZhbHVlID0gTnVtYmVyKGMuZGVmYXVsdF9mZWUpLnRvRml4ZWQoMik7CiAgICB9OwogICAgZWwucXVlcnlTZWxlY3RvcignI2Zf' +
  'YXNzaWduZWRfdG8nKS5vbmNoYW5nZSA9IGUgPT4gewogICAgICBjb25zdCB1ID0gdXNlcnMuZmluZCh4ID0+IFN0cmluZyh4Lmlk' +
  'KSA9PT0gZS50YXJnZXQudmFsdWUpOwogICAgICBpZiAodSAmJiB1LmRlZmF1bHRfcGF5ICYmICFlbC5xdWVyeVNlbGVjdG9yKCcj' +
  'Zl9zZXJ2ZXJfcGF5JykudmFsdWUpCiAgICAgICAgZWwucXVlcnlTZWxlY3RvcignI2Zfc2VydmVyX3BheScpLnZhbHVlID0gTnVt' +
  'YmVyKHUuZGVmYXVsdF9wYXkpLnRvRml4ZWQoMik7CiAgICB9OwogICAgZWwucXVlcnlTZWxlY3RvcignI3NhdmUnKS5vbmNsaWNr' +
  'ID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBib2R5ID0ge307CiAgICAgIFsnY2xpZW50X2lkJywnYXNzaWduZWRfdG8nLCdy' +
  'ZWNpcGllbnRfbmFtZScsJ2FkZHJlc3MxJywnYWRkcmVzczInLCdjaXR5Jywnc3RhdGUnLCd6aXAnLCdyZWNpcGllbnRfbm90ZXMn' +
  'LAogICAgICAgJ2Nhc2VfbnVtYmVyJywnY291cnQnLCdwbGFpbnRpZmYnLCdkZWZlbmRhbnQnLCdkb2N1bWVudHMnLCdzZXJ2aWNl' +
  'X3R5cGUnLCdwcmlvcml0eScsJ2R1ZV9kYXRlJywKICAgICAgICdjbGllbnRfZmVlJywnc2VydmVyX3BheScsJ3N0YXR1cycsJ25v' +
  'dGVzJ10uZm9yRWFjaChmID0+IHsgYm9keVtmXSA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNmXycgKyBmKS52YWx1ZTsgfSk7CiAgICAg' +
  'IGlmICghYm9keS5yZWNpcGllbnRfbmFtZS50cmltKCkpIHJldHVybiB0b2FzdCgnV2hvIGFyZSB3ZSBzZXJ2aW5nPycsIHRydWUp' +
  'OwogICAgICB0cnkgewogICAgICAgIGNvbnN0IHNhdmVkID0gam9iCiAgICAgICAgICA/IGF3YWl0IGFwaSgnL2pvYnMvJyArIGpv' +
  'Yi5pZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pCiAgICAgICAgICA6IGF3YWl0IGFw' +
  'aSgnL2pvYnMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KTsKICAgICAgICBjbG9zZVNo' +
  'ZWV0KCk7IHRvYXN0KGpvYiA/ICdTYXZlZCcgOiAnSm9iICcgKyBzYXZlZC5qb2JfbnVtYmVyICsgJyBjcmVhdGVkJyk7CiAgICAg' +
  'ICAgZ28oJ2pvYicsIHsgaWQ6IHNhdmVkLmlkIH0pOwogICAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7' +
  'IH0KICAgIH07CiAgICBpZiAoZWwucXVlcnlTZWxlY3RvcignI2RlbCcpKSBlbC5xdWVyeVNlbGVjdG9yKCcjZGVsJykub25jbGlj' +
  'ayA9IGFzeW5jICgpID0+IHsKICAgICAgaWYgKCFjb25maXJtKCdEZWxldGUgdGhpcyBqb2IgYW5kIGFsbCBpdHMgYXR0ZW1wdHM/' +
  'JykpIHJldHVybjsKICAgICAgYXdhaXQgYXBpKCcvam9icy8nICsgam9iLmlkLCB7IG1ldGhvZDogJ0RFTEVURScgfSk7CiAgICAg' +
  'IGNsb3NlU2hlZXQoKTsgdG9hc3QoJ0RlbGV0ZWQnKTsgZ28oJ2pvYnMnKTsKICAgIH07CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gam9iIGRldGFpbCAtLSAqLwphc3luYyBmdW5j' +
  'dGlvbiBqb2JWaWV3KCkgewogIGNvbnN0IGogPSBhd2FpdCBhcGkoJy9qb2JzLycgKyBTLnBhcmFtcy5pZCk7CiAgY29uc3QgYWRk' +
  'ciA9IGFkZHJPZihqKTsKICBjb25zdCBkb25lID0gWydTZXJ2ZWQnLCAnTm9uLUVzdCcsICdDYW5jZWxsZWQnXS5pbmNsdWRlcyhq' +
  'LnN0YXR1cyk7CgogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tYm90' +
  'dG9tOjhweCI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBnaG9zdCIgaWQ9ImJhY2siPuKAuSBCYWNrPC9idXR0b24+CiAgICAg' +
  'IDxkaXYgY2xhc3M9InNwYWNlciIgc3R5bGU9ImZsZXg6MSI+PC9kaXY+CiAgICAgIDxzcGFuIGNsYXNzPSJwaWxsICR7Y2xzKGou' +
  'c3RhdHVzKX0iPiR7ZXNjKGouc3RhdHVzKX08L3NwYW4+CiAgICAgICR7ai5wcmlvcml0eSAhPT0gJ1JvdXRpbmUnID8gYDxzcGFu' +
  'IGNsYXNzPSJwaWxsIHJ1c2giPiR7ZXNjKGoucHJpb3JpdHkpfTwvc3Bhbj5gIDogJyd9CiAgICA8L2Rpdj4KICAgIDxoMSBjbGFz' +
  'cz0icGFnZSIgc3R5bGU9Im1hcmdpbi10b3A6MCI+JHtlc2Moai5yZWNpcGllbnRfbmFtZSl9PC9oMT4KCiAgICA8ZGl2IGNsYXNz' +
  'PSJjYXJkIj4KICAgICAgPGRpdiBjbGFzcz0ibSIgc3R5bGU9ImNvbG9yOnZhcigtLW11dGVkKTtmb250LXNpemU6MTNweDttYXJn' +
  'aW4tYm90dG9tOjhweCI+JHtlc2Moai5qb2JfbnVtYmVyKX0gwrcgJHtlc2Moai5jbGllbnRfbmFtZSB8fCAnTm8gY2xpZW50Jyl9' +
  'PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxNXB4O2ZvbnQtd2VpZ2h0OjYwMCI+JHtlc2MoYWRkciB8fCAnTm8g' +
  'YWRkcmVzcyBvbiBmaWxlJyl9PC9kaXY+CiAgICAgICR7ai5yZWNpcGllbnRfbm90ZXMgPyBgPGRpdiBjbGFzcz0iaGludCIgc3R5' +
  'bGU9Im1hcmdpbi10b3A6NnB4Ij4ke2VzYyhqLnJlY2lwaWVudF9ub3Rlcyl9PC9kaXY+YCA6ICcnfQogICAgICA8ZGl2IGNsYXNz' +
  'PSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBuYXYiIGlkPSJuYXZCdG4i' +
  'ICR7YWRkciA/ICcnIDogJ2Rpc2FibGVkJ30+TmF2aWdhdGUg4pa4PC9idXR0b24+CiAgICAgICAgJHshZG9uZSA/ICc8YnV0dG9u' +
  'IGNsYXNzPSJidG4gb2siIGlkPSJhdHRCdG4iPkxvZyBhdHRlbXB0PC9idXR0b24+JyA6ICcnfQogICAgICA8L2Rpdj4KICAgICAg' +
  'JHthZGRyID8gYDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+T3BlbnMgJHtpc0lPUygpID8gJ0FwcGxl' +
  'IE1hcHMnIDogJ0dvb2dsZSBNYXBzJ30gwrcKICAgICAgICA8YSBocmVmPSIke2lzSU9TKCkgPyBnb29nbGVVcmwoYWRkcikgOiBh' +
  'cHBsZVVybChhZGRyKX0iIHRhcmdldD0iX2JsYW5rIj51c2UgJHtpc0lPUygpID8gJ0dvb2dsZScgOiAnQXBwbGUnfSBNYXBzIGlu' +
  'c3RlYWQ8L2E+PC9kaXY+YCA6ICcnfQogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5BdHRlbXB0' +
  'cyA8c3BhbiBjbGFzcz0ic3ViIj4ke2ouYXR0ZW1wdHMubGVuZ3RofTwvc3Bhbj48L2gyPgogICAgICAke2ouYXR0ZW1wdHMubGVu' +
  'Z3RoID8gai5hdHRlbXB0cy5tYXAoYSA9PiBgCiAgICAgICAgPGRpdiBjbGFzcz0iYXR0ICR7Y2xzKGEub3V0Y29tZSl9Ij4KICAg' +
  'ICAgICAgIDxkaXYgY2xhc3M9ImgiPiR7ZXNjKGEub3V0Y29tZSl9JHthLm1hbm5lciA/ICcg4oCUICcgKyBlc2MoYS5tYW5uZXIp' +
  'IDogJyd9PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJtIj4ke2ZtdERUKGEuYXR0ZW1wdGVkX2F0KX0gwrcgJHtlc2MoYS5z' +
  'ZXJ2ZXJfbmFtZSB8fCAnJyl9PC9kaXY+CiAgICAgICAgICAke2EucGVyc29uX3NlcnZlZCA/IGA8ZGl2IGNsYXNzPSJtIj5TZXJ2' +
  'ZWQ6ICR7ZXNjKGEucGVyc29uX3NlcnZlZCl9JHthLnJlbGF0aW9uc2hpcCA/ICcgKCcgKyBlc2MoYS5yZWxhdGlvbnNoaXApICsg' +
  'JyknIDogJyd9PC9kaXY+YCA6ICcnfQogICAgICAgICAgJHthLmRlc2NyaXB0aW9uID8gYDxkaXYgY2xhc3M9Im0iPkRlc2NyaXB0' +
  'aW9uOiAke2VzYyhhLmRlc2NyaXB0aW9uKX08L2Rpdj5gIDogJyd9CiAgICAgICAgICAke2Eubm90ZXMgPyBgPGRpdiBjbGFzcz0i' +
  'bSI+JHtlc2MoYS5ub3Rlcyl9PC9kaXY+YCA6ICcnfQogICAgICAgICAgJHthLmxhdCAhPSBudWxsID8gYDxkaXYgY2xhc3M9Im0i' +
  'PkdQUyAke051bWJlcihhLmxhdCkudG9GaXhlZCg1KX0sICR7TnVtYmVyKGEubG5nKS50b0ZpeGVkKDUpfQogICAgICAgICAgICAk' +
  'e2EuYWNjdXJhY3lfbSA/ICfCsScgKyBNYXRoLnJvdW5kKGEuYWNjdXJhY3lfbSkgKyAnbScgOiAnJ30gwrcKICAgICAgICAgICAg' +
  'PGEgaHJlZj0iaHR0cHM6Ly93d3cuZ29vZ2xlLmNvbS9tYXBzP3E9JHthLmxhdH0sJHthLmxuZ30iIHRhcmdldD0iX2JsYW5rIj5t' +
  'YXA8L2E+PC9kaXY+YCA6ICcnfQogICAgICAgIDwvZGl2PmApLmpvaW4oJycpCiAgICAgICAgOiAnPGRpdiBjbGFzcz0iZW1wdHki' +
  'Pk5vIGF0dGVtcHRzIGxvZ2dlZCB5ZXQuPC9kaXY+J30KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8' +
  'aDI+UGFwZXJ3b3JrPC9oMj4KICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNt' +
  'IiBpZD0iYWZmQnRuIj5BZmZpZGF2aXQ8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0iY292' +
  'ZXJCdG4iPkNvdmVyIHNoZWV0ICsgYmFyY29kZTwvYnV0dG9uPgogICAgICAgICR7ai5jYXNlX251bWJlciA/ICc8YnV0dG9uIGNs' +
  'YXNzPSJidG4gc2VjIHNtIiBpZD0ibG9va3VwQnRuIj5Mb29rIHVwIGNhc2U8L2J1dHRvbj4nIDogJyd9CiAgICAgIDwvZGl2Pgog' +
  'ICAgICA8ZGl2IHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlcjttYXJnaW4tdG9wOjE0cHgiPgogICAgICAgIDxpbWcgc3JjPSIvYmFy' +
  'Y29kZS8ke2VuY29kZVVSSUNvbXBvbmVudChqLmpvYl9udW1iZXIpfS5zdmciIGFsdD0iYmFyY29kZSIgc3R5bGU9Im1heC13aWR0' +
  'aDoxMDAlIj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkNhc2UgZGV0' +
  'YWlsPC9oMj4KICAgICAgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgICAgICR7W1snQ2FzZScsIGouY2FzZV9udW1iZXJdLCBbJ0Nv' +
  'dXJ0Jywgai5jb3VydF0sIFsnUGxhaW50aWZmJywgai5wbGFpbnRpZmZdLCBbJ0RlZmVuZGFudCcsIGouZGVmZW5kYW50XSwKICAg' +
  'ICAgICAgICBbJ0RvY3VtZW50cycsIGouZG9jdW1lbnRzXSwgWydTZXJ2aWNlIHR5cGUnLCBqLnNlcnZpY2VfdHlwZV0sIFsnRHVl' +
  'JywgZm10RGF0ZU9ubHkoai5kdWVfZGF0ZSldLAogICAgICAgICAgIFsnQXNzaWduZWQgdG8nLCBqLnNlcnZlcl9uYW1lXSwgWydD' +
  'bGllbnQgZmVlJywgai5jbGllbnRfZmVlID8gbW9uZXkoai5jbGllbnRfZmVlKSA6ICcnXSwKICAgICAgICAgICBbJ1NlcnZlciBw' +
  'YXknLCBqLnNlcnZlcl9wYXkgPyBtb25leShqLnNlcnZlcl9wYXkpIDogJyddLAogICAgICAgICAgIFsnU2VydmVkJywgai5zZXJ2' +
  'ZWRfYXQgPyBmbXREVChqLnNlcnZlZF9hdCkgKyAnIOKAlCAnICsgZXNjKGouc2VydmVkX21hbm5lciB8fCAnJykgOiAnJ10sCiAg' +
  'ICAgICAgICAgWydOb3RlcycsIGoubm90ZXNdXQogICAgICAgICAgLmZpbHRlcihyID0+IHJbMV0pLm1hcChyID0+IGA8dHI+PHRo' +
  'IHN0eWxlPSJ3aWR0aDozNCUiPiR7clswXX08L3RoPjx0ZD4ke2VzYyhyWzFdKX08L3RkPjwvdHI+YCkuam9pbignJyl9CiAgICAg' +
  'IDwvdGFibGU+CiAgICAgICR7aXNBZG1pbigpID8gJzxidXR0b24gY2xhc3M9ImJ0biBzZWMgYmxvY2sgc20iIGlkPSJlZGl0QnRu' +
  'IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij5FZGl0IGpvYjwvYnV0dG9uPicgOiAnJ30KICAgIDwvZGl2PmApOwogIGJpbmRTaGVs' +
  'bCgpOwogICQoJyNiYWNrJykub25jbGljayA9ICgpID0+IGdvKCdqb2JzJywgUy5jYWNoZS5qb2JGaWx0ZXIgfHwge30pOwogIGlm' +
  'ICgkKCcjbmF2QnRuJykpICQoJyNuYXZCdG4nKS5vbmNsaWNrID0gKCkgPT4gd2luZG93Lm9wZW4obmF2VXJsKGFkZHIpLCAnX2Js' +
  'YW5rJyk7CiAgaWYgKCQoJyNhdHRCdG4nKSkgJCgnI2F0dEJ0bicpLm9uY2xpY2sgPSAoKSA9PiBhdHRlbXB0Rm9ybShqKTsKICBp' +
  'ZiAoJCgnI2VkaXRCdG4nKSkgJCgnI2VkaXRCdG4nKS5vbmNsaWNrID0gKCkgPT4gam9iRm9ybShqKTsKICAkKCcjY292ZXJCdG4n' +
  'KS5vbmNsaWNrID0gKCkgPT4gd2luZG93Lm9wZW4oJy9wcmludC9jb3ZlcnNoZWV0LycgKyBqLmlkLCAnX2JsYW5rJyk7CiAgJCgn' +
  'I2FmZkJ0bicpLm9uY2xpY2sgPSAoKSA9PiBhZmZpZGF2aXRTaGVldChqKTsKICBpZiAoJCgnI2xvb2t1cEJ0bicpKSAkKCcjbG9v' +
  'a3VwQnRuJykub25jbGljayA9ICgpID0+IGNhc2VMb29rdXBTaGVldChqKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBsb2cgYXR0ZW1wdCAtLSAqLwpjb25zdCBPVVRDT01FUyA9IFsnU2VydmVk' +
  'JywgJ05vIEFuc3dlcicsICdCYWQgQWRkcmVzcycsICdNb3ZlZCcsICdSZWZ1c2VkJywgJ0V2YWRpbmcnLCAnT3RoZXInXTsKCmZ1' +
  'bmN0aW9uIGF0dGVtcHRGb3JtKGpvYikgewogIHNoZWV0KCdMb2cgYXR0ZW1wdCDigJQgJyArIGpvYi5yZWNpcGllbnRfbmFtZSwg' +
  'YAogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5PdXRjb21lPC9sYWJlbD4KICAgICAgPGRpdiBjbGFzcz0icm93IiBpZD0i' +
  'b3V0Y29tZXMiPiR7T1VUQ09NRVMubWFwKG8gPT4KICAgICAgICBgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgZGF0YS1vPSIk' +
  'e299Ij4ke299PC9idXR0b24+YCkuam9pbignJyl9PC9kaXY+PC9kaXY+CiAgICA8ZGl2IGlkPSJzZXJ2ZWRGaWVsZHMiIHN0eWxl' +
  'PSJkaXNwbGF5Om5vbmUiPgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxh' +
  'YmVsPk1hbm5lcjwvbGFiZWw+PHNlbGVjdCBpZD0iYV9tYW5uZXIiPgogICAgICAgICAgJHtbJ1BlcnNvbmFsJywgJ1N1YnN0aXR1' +
  'dGUnLCAnUG9zdGVkJywgJ0NvcnBvcmF0ZScsICdDZXJ0aWZpZWQgTWFpbCddLm1hcChzID0+IGA8b3B0aW9uPiR7c308L29wdGlv' +
  'bj5gKS5qb2luKCcnKX08L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBlcnNvbiBzZXJ2' +
  'ZWQ8L2xhYmVsPjxpbnB1dCBpZD0iYV9wZXJzb25fc2VydmVkIiB2YWx1ZT0iJHtlc2Moam9iLnJlY2lwaWVudF9uYW1lKX0iPjwv' +
  'ZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxs' +
  'YWJlbD5SZWxhdGlvbnNoaXAgKGlmIHN1YnN0aXR1dGUpPC9sYWJlbD48aW5wdXQgaWQ9ImFfcmVsYXRpb25zaGlwIiBwbGFjZWhv' +
  'bGRlcj0iY28tcmVzaWRlbnQsIGNvLXdvcmtlci4uLiI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5E' +
  'ZXNjcmlwdGlvbjwvbGFiZWw+PGlucHV0IGlkPSJhX2Rlc2NyaXB0aW9uIiBwbGFjZWhvbGRlcj0iVy9GLCA0MHMsIDUnNiZxdW90' +
  'OywgYnJvd24gaGFpciI+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVs' +
  'Pk5vdGVzPC9sYWJlbD48dGV4dGFyZWEgaWQ9ImFfbm90ZXMiIHBsYWNlaG9sZGVyPSJMaWdodHMgb24sIG5vIGFuc3dlciBhdCBm' +
  'cm9udCBkb29yLiBTaWx2ZXIgQ2l2aWMgaW4gZHJpdmV3YXkuIj48L3RleHRhcmVhPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmll' +
  'bGQiPjxsYWJlbD5XaGVuPC9sYWJlbD48aW5wdXQgaWQ9ImFfd2hlbiIgdHlwZT0iZGF0ZXRpbWUtbG9jYWwiIHZhbHVlPSIke2xv' +
  'Y2FsTm93KCl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOiNmOGZhZmM7Ym94LXNoYWRv' +
  'dzpub25lO21hcmdpbi1ib3R0b206MTJweCI+CiAgICAgIDxkaXYgY2xhc3M9InJvdyI+PGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBz' +
  'bSIgaWQ9Imdwc0J0biI+Q2FwdHVyZSBHUFM8L2J1dHRvbj4KICAgICAgPHNwYW4gY2xhc3M9ImhpbnQiIGlkPSJncHNPdXQiIHN0' +
  'eWxlPSJtYXJnaW46MCI+Tm90IGNhcHR1cmVkPC9zcGFuPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJyb3ciPgog' +
  'ICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJzYXZlQXR0IiBkaXNhYmxlZD5QaWNrIGFuIG91dGNvbWU8L2J1dHRvbj4KICAg' +
  'ICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5DYW5jZWw8L2J1dHRvbj4KICAgIDwvZGl2' +
  'PmAsIGVsID0+IHsKICAgIGxldCBvdXRjb21lID0gbnVsbCwgZ3BzID0gbnVsbDsKICAgIGVsLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tk' +
  'YXRhLW9dJykuZm9yRWFjaChiID0+IGIub25jbGljayA9ICgpID0+IHsKICAgICAgb3V0Y29tZSA9IGIuZGF0YXNldC5vOwogICAg' +
  'ICBlbC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1vXScpLmZvckVhY2goeCA9PiB7IHguY2xhc3NOYW1lID0gJ2J0biBzZWMgc20n' +
  'OyB9KTsKICAgICAgYi5jbGFzc05hbWUgPSAnYnRuIHNtJyArIChvdXRjb21lID09PSAnU2VydmVkJyA/ICcgb2snIDogJycpOwog' +
  'ICAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2VydmVkRmllbGRzJykuc3R5bGUuZGlzcGxheSA9IG91dGNvbWUgPT09ICdTZXJ2ZWQn' +
  'ID8gJycgOiAnbm9uZSc7CiAgICAgIGNvbnN0IHMgPSBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZUF0dCcpOwogICAgICBzLmRpc2Fi' +
  'bGVkID0gZmFsc2U7CiAgICAgIHMudGV4dENvbnRlbnQgPSBvdXRjb21lID09PSAnU2VydmVkJyA/ICdTYXZlIOKAlCBtYXJrcyBq' +
  'b2IgU0VSVkVEJyA6ICdTYXZlIGF0dGVtcHQnOwogICAgfSk7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjZ3BzQnRuJykub25jbGlj' +
  'ayA9ICgpID0+IHsKICAgICAgY29uc3Qgb3V0ID0gZWwucXVlcnlTZWxlY3RvcignI2dwc091dCcpOwogICAgICBpZiAoIW5hdmln' +
  'YXRvci5nZW9sb2NhdGlvbikgcmV0dXJuIG91dC50ZXh0Q29udGVudCA9ICdOb3Qgc3VwcG9ydGVkIG9uIHRoaXMgZGV2aWNlJzsK' +
  'ICAgICAgb3V0LnRleHRDb250ZW50ID0gJ0xvY2F0aW5n4oCmJzsKICAgICAgbmF2aWdhdG9yLmdlb2xvY2F0aW9uLmdldEN1cnJl' +
  'bnRQb3NpdGlvbihwb3MgPT4gewogICAgICAgIGdwcyA9IHsgbGF0OiBwb3MuY29vcmRzLmxhdGl0dWRlLCBsbmc6IHBvcy5jb29y' +
  'ZHMubG9uZ2l0dWRlLCBhY2N1cmFjeV9tOiBwb3MuY29vcmRzLmFjY3VyYWN5IH07CiAgICAgICAgb3V0LmlubmVySFRNTCA9IGA8' +
  'YiBzdHlsZT0iY29sb3I6dmFyKC0tb2spIj7inJMgJHtncHMubGF0LnRvRml4ZWQoNSl9LCAke2dwcy5sbmcudG9GaXhlZCg1KX08' +
  'L2I+IMKxJHtNYXRoLnJvdW5kKGdwcy5hY2N1cmFjeV9tKX1tYDsKICAgICAgfSwgZXJyID0+IHsgb3V0LnRleHRDb250ZW50ID0g' +
  'J0ZhaWxlZDogJyArIGVyci5tZXNzYWdlOyB9LAogICAgICAgIHsgZW5hYmxlSGlnaEFjY3VyYWN5OiB0cnVlLCB0aW1lb3V0OiAx' +
  'NTAwMCwgbWF4aW11bUFnZTogMCB9KTsKICAgIH07CiAgICAvLyBhdXRvLWNhcHR1cmUgb24gb3BlbiDigJQgdGhlIGFmZmlkYXZp' +
  'dCBpcyBzdHJvbmdlciB3aGVuIGV2ZXJ5IGF0dGVtcHQgaGFzIGNvb3JkaW5hdGVzCiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjZ3Bz' +
  'QnRuJykuY2xpY2soKTsKCiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZUF0dCcpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAg' +
  'ICAgIGNvbnN0IGJvZHkgPSBPYmplY3QuYXNzaWduKHsKICAgICAgICBvdXRjb21lLAogICAgICAgIGF0dGVtcHRlZF9hdDogZWwu' +
  'cXVlcnlTZWxlY3RvcignI2Ffd2hlbicpLnZhbHVlIHx8IG51bGwsCiAgICAgICAgbm90ZXM6IGVsLnF1ZXJ5U2VsZWN0b3IoJyNh' +
  'X25vdGVzJykudmFsdWUKICAgICAgfSwgZ3BzIHx8IHt9KTsKICAgICAgaWYgKG91dGNvbWUgPT09ICdTZXJ2ZWQnKSB7CiAgICAg' +
  'ICAgYm9keS5tYW5uZXIgPSBlbC5xdWVyeVNlbGVjdG9yKCcjYV9tYW5uZXInKS52YWx1ZTsKICAgICAgICBib2R5LnBlcnNvbl9z' +
  'ZXJ2ZWQgPSBlbC5xdWVyeVNlbGVjdG9yKCcjYV9wZXJzb25fc2VydmVkJykudmFsdWU7CiAgICAgICAgYm9keS5yZWxhdGlvbnNo' +
  'aXAgPSBlbC5xdWVyeVNlbGVjdG9yKCcjYV9yZWxhdGlvbnNoaXAnKS52YWx1ZTsKICAgICAgICBib2R5LmRlc2NyaXB0aW9uID0g' +
  'ZWwucXVlcnlTZWxlY3RvcignI2FfZGVzY3JpcHRpb24nKS52YWx1ZTsKICAgICAgfQogICAgICB0cnkgewogICAgICAgIGF3YWl0' +
  'IGFwaSgnL2pvYnMvJyArIGpvYi5pZCArICcvYXR0ZW1wdHMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lm' +
  'eShib2R5KSB9KTsKICAgICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KG91dGNvbWUgPT09ICdTZXJ2ZWQnID8gJ1NlcnZlZCDigJQg' +
  'am9iIGNsb3NlZCBvdXQnIDogJ0F0dGVtcHQgbG9nZ2VkJyk7CiAgICAgICAgZ28oJ2pvYicsIHsgaWQ6IGpvYi5pZCB9KTsKICAg' +
  'ICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgICB9OwogIH0pOwp9CgpmdW5jdGlvbiBsb2NhbE5v' +
  'dygpIHsKICBjb25zdCBkID0gbmV3IERhdGUoRGF0ZS5ub3coKSAtIG5ldyBEYXRlKCkuZ2V0VGltZXpvbmVPZmZzZXQoKSAqIDYw' +
  'MDAwKTsKICByZXR1cm4gZC50b0lTT1N0cmluZygpLnNsaWNlKDAsIDE2KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBhZmZpZGF2aXQgLS0gKi8KYXN5bmMgZnVuY3Rpb24gYWZmaWRhdml0' +
  'U2hlZXQoam9iKSB7CiAgY29uc3QgdGVtcGxhdGVzID0gYXdhaXQgYXBpKCcvdGVtcGxhdGVzJyk7CiAgY29uc3QgbG9hZCA9IGFz' +
  'eW5jIGlkID0+IHsKICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9qb2JzLycgKyBqb2IuaWQgKyAnL2FmZmlkYXZpdCcgKyAoaWQg' +
  'PyAnP3RlbXBsYXRlX2lkPScgKyBpZCA6ICcnKSk7CiAgICByZXR1cm4gcjsKICB9OwogIGNvbnN0IGZpcnN0ID0gYXdhaXQgbG9h' +
  'ZCgpOwogIHNoZWV0KCdBZmZpZGF2aXQg4oCUICcgKyBqb2Iuam9iX251bWJlciwgYAogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxs' +
  'YWJlbD5UZW1wbGF0ZTwvbGFiZWw+PHNlbGVjdCBpZD0idHBsIj4KICAgICAgJHt0ZW1wbGF0ZXMubWFwKHQgPT4gYDxvcHRpb24g' +
  'dmFsdWU9IiR7dC5pZH0iICR7dC5pZCA9PT0gZmlyc3QudGVtcGxhdGVfaWQgPyAnc2VsZWN0ZWQnIDogJyd9PiR7ZXNjKHQubmFt' +
  'ZSl9JHt0Lmp1cmlzZGljdGlvbiA/ICcg4oCUICcgKyBlc2ModC5qdXJpc2RpY3Rpb24pIDogJyd9PC9vcHRpb24+YCkuam9pbign' +
  'Jyl9CiAgICA8L3NlbGVjdD48L2Rpdj4KICAgIDxwcmUgY2xhc3M9InByZXYiIGlkPSJwcmV2Ij4ke2VzYyhmaXJzdC50ZXh0KX08' +
  'L3ByZT4KICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0' +
  'biIgaWQ9InByaW50QWZmIj5QcmludCAvIHNhdmUgUERGPC9idXR0b24+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIGlk' +
  'PSJjb3B5QWZmIj5Db3B5IHRleHQ8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25jbGljaz0iY2xvc2VT' +
  'aGVldCgpIj5DbG9zZTwvYnV0dG9uPgogICAgPC9kaXY+YCwgZWwgPT4gewogICAgY29uc3Qgc2VsID0gZWwucXVlcnlTZWxlY3Rv' +
  'cignI3RwbCcpOwogICAgc2VsLm9uY2hhbmdlID0gYXN5bmMgKCkgPT4geyBlbC5xdWVyeVNlbGVjdG9yKCcjcHJldicpLnRleHRD' +
  'b250ZW50ID0gKGF3YWl0IGxvYWQoc2VsLnZhbHVlKSkudGV4dDsgfTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNwcmludEFmZicp' +
  'Lm9uY2xpY2sgPSAoKSA9PgogICAgICB3aW5kb3cub3BlbignL3ByaW50L2FmZmlkYXZpdC8nICsgam9iLmlkICsgJz90ZW1wbGF0' +
  'ZV9pZD0nICsgc2VsLnZhbHVlLCAnX2JsYW5rJyk7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjY29weUFmZicpLm9uY2xpY2sgPSBh' +
  'c3luYyAoKSA9PiB7CiAgICAgIGF3YWl0IG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KGVsLnF1ZXJ5U2VsZWN0b3IoJyNw' +
  'cmV2JykudGV4dENvbnRlbnQpOwogICAgICB0b2FzdCgnQ29waWVkJyk7CiAgICB9OwogIH0pOwp9CgovKiAtLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSB0b29scyAtLS0gKi8KLyogTGFiZWwgbWFrZXIu' +
  'IFRoZSBwb2ludCBvZiB0aGUgc2hlZXQgZ3JpZCBpcyB0aGF0IGxhYmVsIHNoZWV0cyBhcmUgZXhwZW5zaXZlCiAgIGFuZCByYXJl' +
  'bHkgdXNlZCB1cCBpbiBvbmUgZ286IG1hcmsgd2hpY2ggb25lcyB5b3UndmUgYWxyZWFkeSBwZWVsZWQgb2ZmIGFuZAogICB0aGUg' +
  'cHJpbnRlciBza2lwcyB0aGVtLCBzbyBhIHBhcnQtdXNlZCBzaGVldCBnb2VzIGJhY2sgaW4gYW5kIGNhcnJpZXMgb24uICovCmFz' +
  'eW5jIGZ1bmN0aW9uIHRvb2xzVmlldygpIHsKICBjb25zdCBbbGF5b3V0cywgaW5pdFNoZWV0LCBqb2JzXSA9IGF3YWl0IFByb21p' +
  'c2UuYWxsKFsKICAgIGFwaSgnL2xhYmVsLWxheW91dHMnKSwgYXBpKCcvbGFiZWwtc2hlZXQnKSwgYXBpKCcvam9icz9vcGVuPTEn' +
  'KQogIF0pOwogIFMuY2FjaGUuc2hlZXQgPSBpbml0U2hlZXQ7CiAgUy5jYWNoZS5waWNrZWQgPSBTLmNhY2hlLnBpY2tlZCB8fCBb' +
  'XTsKCiAgYXBwLmlubmVySFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFnZSI+VG9vbHM8L2gxPgoKICAgIDxkaXYgY2xh' +
  'c3M9ImNhcmQiPgogICAgICA8aDI+TGFiZWwgbWFrZXIgPHNwYW4gY2xhc3M9InN1YiI+cHJpbnRzIG9ubHkgdGhlIGxhYmVscyB5' +
  'b3UgaGF2ZW4ndCB1c2VkPC9zcGFuPjwvaDI+CgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkxhYmVsIHNoZWV0PC9s' +
  'YWJlbD4KICAgICAgICA8c2VsZWN0IGlkPSJsYXlvdXQiPgogICAgICAgICAgJHtsYXlvdXRzLm1hcChsID0+IGA8b3B0aW9uIHZh' +
  'bHVlPSIke2wua2V5fSIgJHtsLmtleSA9PT0gaW5pdFNoZWV0LmxheW91dCA/ICdzZWxlY3RlZCcgOiAnJ30+CiAgICAgICAgICAg' +
  'ICR7ZXNjKGwubmFtZSl9IOKAlCAke2VzYyhsLnNpemUpfTwvb3B0aW9uPmApLmpvaW4oJycpfQogICAgICAgIDwvc2VsZWN0Pgog' +
  'ICAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPk9mZmljZSBEZXBvdCBzaGVldHMgcHJpbnQgYW4gQXZlcnkgZXF1aXZhbGVudCBudW1i' +
  'ZXIgb24gdGhlIHBhY2thZ2UgZnJvbnQg4oCUCiAgICAgICAgICBtYXRjaCB0aGF0LiBDaGFuZ2luZyB0aGUgc2hlZXQgY2xlYXJz' +
  'IHRoZSB1c2VkIG1hcmtzLCBzaW5jZSBwb3NpdGlvbiA3IG9uIGEgMzAtdXAgc2hlZXQKICAgICAgICAgIGlzbid0IHBvc2l0aW9u' +
  'IDcgb24gYSAxMC11cCBvbmUuPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGxhYmVsPldoaWNoIGxhYmVscyBhcmUgYWxyZWFk' +
  'eSBnb25lPzwvbGFiZWw+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tYm90dG9tOjhweCI+VGFwIHRoZSBv' +
  'bmVzIGFscmVhZHkgcGVlbGVkIG9mZi4gR3JleSA9IHVzZWQgYW5kIHNraXBwZWQuCiAgICAgICAgTnVtYmVyZWQgZ3JlZW4gPSB3' +
  'aGVyZSB5b3VyIG5leHQgbGFiZWxzIHdpbGwgbGFuZCwgaW4gb3JkZXIuPC9kaXY+CiAgICAgIDxkaXYgaWQ9ImdyaWQiPjwvZGl2' +
  'PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxzcGFuIGNsYXNzPSJwaWxs' +
  'IiBpZD0iZnJlZUNvdW50Ij48L3NwYW4+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9Im5ld1NoZWV0Ij5G' +
  'cmVzaCBzaGVldDwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJhbGxVc2VkIj5NYXJrIGFs' +
  'bCB1c2VkPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5X' +
  'aG8gdG8gcHJpbnQgPHNwYW4gY2xhc3M9InN1YiIgaWQ9InBpY2tDb3VudCI+PC9zcGFuPjwvaDI+CiAgICAgIDxpbnB1dCBpZD0i' +
  'am9iRmlsdGVyIiBwbGFjZWhvbGRlcj0iRmlsdGVyIGJ5IG5hbWUsIGNpdHkgb3Igam9iIG51bWJlciIgc3R5bGU9Im1hcmdpbi1i' +
  'b3R0b206OHB4Ij4KICAgICAgPGRpdiBjbGFzcz0ibGlzdCIgaWQ9ImpvYlBpY2siIHN0eWxlPSJtYXgtaGVpZ2h0OjMyMHB4O292' +
  'ZXJmbG93OmF1dG8iPgogICAgICAgICR7am9icy5sZW5ndGggPyBqb2JzLm1hcChqID0+IGAKICAgICAgICAgIDxkaXYgY2xhc3M9' +
  'Iml0ZW0iIGRhdGEtcGljaz0iJHtqLmlkfSI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9InIiPjxkaXY+CiAgICAgICAgICAgICAg' +
  'PGRpdiBjbGFzcz0idCI+JHtlc2Moai5yZWNpcGllbnRfbmFtZSl9PC9kaXY+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibSI+' +
  'JHtlc2Moai5qb2JfbnVtYmVyKX0gwrcgJHtlc2MoW2ouYWRkcmVzczEsIGouY2l0eV0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJywg' +
  'JykgfHwgJ25vIGFkZHJlc3MnKX08L2Rpdj4KICAgICAgICAgICAgPC9kaXY+PHNwYW4gY2xhc3M9InBpbGwiIGRhdGEtdGljaz0i' +
  'JHtqLmlkfSI+YWRkPC9zcGFuPjwvZGl2PgogICAgICAgICAgPC9kaXY+YCkuam9pbignJykKICAgICAgICAgIDogJzxkaXYgY2xh' +
  'c3M9ImVtcHR5Ij5ObyBvcGVuIGpvYnMgdG8gbGFiZWwuPC9kaXY+J30KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2' +
  'IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPlByaW50PC9oMj4KICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgICA8YnV0dG9u' +
  'IGNsYXNzPSJidG4iIGlkPSJwcmludEJ0biIgZGlzYWJsZWQ+UHJpbnQgbGFiZWxzPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBj' +
  'bGFzcz0iYnRuIHNlYyBzbSIgaWQ9InRlc3RCdG4iPkFsaWdubWVudCB0ZXN0PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8' +
  'ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPkluIHRoZSBwcmludCBkaWFsb2cgc2V0IHNjYWxlIHRvIDxi' +
  'PjEwMCU8L2I+IGFuZCB0dXJuIG9mZgogICAgICAgICJmaXQgdG8gcGFnZSIg4oCUIHNjYWxpbmcgaXMgd2hhdCB0aHJvd3MgbGFi' +
  'ZWwgYWxpZ25tZW50IG9mZi48L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij48' +
  'bGFiZWw+TnVkZ2UsIGlmIHlvdXIgcHJpbnRlciBydW5zIG9mZjwvbGFiZWw+CiAgICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAg' +
  'ICAgICAgIDxzcGFuIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjAiPlJpZ2h0PC9zcGFuPgogICAgICAgICAgPGlucHV0IGlk' +
  'PSJvZmZYIiB0eXBlPSJudW1iZXIiIHN0ZXA9IjAuMDEiIG1pbj0iLTAuNSIgbWF4PSIwLjUiIHZhbHVlPSIke2luaXRTaGVldC5v' +
  'ZmZzZXRfeH0iIHN0eWxlPSJ3aWR0aDo5MHB4Ij4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjAi' +
  'PkRvd248L3NwYW4+CiAgICAgICAgICA8aW5wdXQgaWQ9Im9mZlkiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgbWluPSItMC41' +
  'IiBtYXg9IjAuNSIgdmFsdWU9IiR7aW5pdFNoZWV0Lm9mZnNldF95fSIgc3R5bGU9IndpZHRoOjkwcHgiPgogICAgICAgICAgPGJ1' +
  'dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9InNhdmVPZmYiPlNhdmU8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8' +
  'ZGl2IGNsYXNzPSJoaW50Ij5JbmNoZXMuIFByaW50IHRoZSBhbGlnbm1lbnQgdGVzdCBvbiBwbGFpbiBwYXBlciwgaG9sZCBpdCBh' +
  'Z2FpbnN0IGEgcmVhbCBzaGVldCwKICAgICAgICAgIGFuZCBudWRnZSB1bnRpbCB0aGUgYm94ZXMgbGluZSB1cC48L2Rpdj4KICAg' +
  'ICAgPC9kaXY+CiAgICA8L2Rpdj5gKTsKICBiaW5kU2hlbGwoKTsKCiAgY29uc3QgbGF5b3V0TWV0YSA9ICgpID0+IGxheW91dHMu' +
  'ZmluZChsID0+IGwua2V5ID09PSBTLmNhY2hlLnNoZWV0LmxheW91dCkgfHwgbGF5b3V0c1swXTsKCiAgZnVuY3Rpb24gZHJhd0dy' +
  'aWQoKSB7CiAgICBjb25zdCBtZXRhID0gbGF5b3V0TWV0YSgpOwogICAgY29uc3QgcyA9IFMuY2FjaGUuc2hlZXQ7CiAgICBjb25z' +
  'dCB1c2VkID0gbmV3IFNldChzLnVzZWQubWFwKE51bWJlcikpOwogICAgY29uc3QgZnJlZSA9IFtdOwogICAgZm9yIChsZXQgaSA9' +
  'IDA7IGkgPCBtZXRhLmNhcGFjaXR5OyBpKyspIGlmICghdXNlZC5oYXMoaSkpIGZyZWUucHVzaChpKTsKICAgIGNvbnN0IG9yZGVy' +
  'ID0gbmV3IE1hcChmcmVlLnNsaWNlKDAsIFMuY2FjaGUucGlja2VkLmxlbmd0aCkubWFwKChwb3MsIG4pID0+IFtwb3MsIG4gKyAx' +
  'XSkpOwoKICAgICQoJyNncmlkJykuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImxncmlkIiBzdHlsZT0iZ3JpZC10ZW1wbGF0ZS1j' +
  'b2x1bW5zOnJlcGVhdCgke21ldGEuY29sc30sMWZyKSI+YCArCiAgICAgIEFycmF5LmZyb20oeyBsZW5ndGg6IG1ldGEuY2FwYWNp' +
  'dHkgfSwgKF8sIGkpID0+IHsKICAgICAgICBjb25zdCBpc1VzZWQgPSB1c2VkLmhhcyhpKTsKICAgICAgICBjb25zdCBuID0gb3Jk' +
  'ZXIuZ2V0KGkpOwogICAgICAgIHJldHVybiBgPGJ1dHRvbiBjbGFzcz0ibGNlbGwke2lzVXNlZCA/ICcgdXNlZCcgOiAnJ30ke24g' +
  'PyAnIG5leHQnIDogJyd9IiBkYXRhLWNlbGw9IiR7aX0iCiAgICAgICAgICB0aXRsZT0iUG9zaXRpb24gJHtpICsgMX0iPiR7aXNV' +
  'c2VkID8gJ8OXJyA6IChuIHx8ICcnKX08L2J1dHRvbj5gOwogICAgICB9KS5qb2luKCcnKSArICc8L2Rpdj4nOwoKICAgICQoJyNm' +
  'cmVlQ291bnQnKS50ZXh0Q29udGVudCA9IGZyZWUubGVuZ3RoICsgJyBvZiAnICsgbWV0YS5jYXBhY2l0eSArICcgbGVmdCc7CiAg' +
  'ICAkKCcjcGlja0NvdW50JykudGV4dENvbnRlbnQgPSBTLmNhY2hlLnBpY2tlZC5sZW5ndGggKyAnIHNlbGVjdGVkJzsKICAgIGNv' +
  'bnN0IG92ZXIgPSBTLmNhY2hlLnBpY2tlZC5sZW5ndGggPiBmcmVlLmxlbmd0aDsKICAgIGNvbnN0IGJ0biA9ICQoJyNwcmludEJ0' +
  'bicpOwogICAgYnRuLmRpc2FibGVkID0gIVMuY2FjaGUucGlja2VkLmxlbmd0aDsKICAgIGJ0bi50ZXh0Q29udGVudCA9IG92ZXIK' +
  'ICAgICAgPyBgUHJpbnQgJHtmcmVlLmxlbmd0aH0gbm93ICgke1MuY2FjaGUucGlja2VkLmxlbmd0aCAtIGZyZWUubGVuZ3RofSB3' +
  'b24ndCBmaXQpYAogICAgICA6IGBQcmludCAke1MuY2FjaGUucGlja2VkLmxlbmd0aH0gbGFiZWwke1MuY2FjaGUucGlja2VkLmxl' +
  'bmd0aCA9PT0gMSA/ICcnIDogJ3MnfWA7CgogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtY2VsbF0nKS5mb3JF' +
  'YWNoKGMgPT4gYy5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBpID0gK2MuZGF0YXNldC5jZWxsOwogICAgICBj' +
  'b25zdCBzZXQgPSBuZXcgU2V0KFMuY2FjaGUuc2hlZXQudXNlZC5tYXAoTnVtYmVyKSk7CiAgICAgIHNldC5oYXMoaSkgPyBzZXQu' +
  'ZGVsZXRlKGkpIDogc2V0LmFkZChpKTsKICAgICAgYXdhaXQgc2F2ZVNoZWV0KHsgdXNlZDogWy4uLnNldF0gfSk7CiAgICB9KTsK' +
  'ICB9CgogIGFzeW5jIGZ1bmN0aW9uIHNhdmVTaGVldChwYXRjaCkgewogICAgdHJ5IHsKICAgICAgUy5jYWNoZS5zaGVldCA9IGF3' +
  'YWl0IGFwaSgnL2xhYmVsLXNoZWV0JywgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHBhdGNoKSB9KTsK' +
  'ICAgICAgZHJhd0dyaWQoKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH0KCiAgJCgnI2xh' +
  'eW91dCcpLm9uY2hhbmdlID0gZSA9PiBzYXZlU2hlZXQoeyBsYXlvdXQ6IGUudGFyZ2V0LnZhbHVlIH0pOwogICQoJyNuZXdTaGVl' +
  'dCcpLm9uY2xpY2sgPSAoKSA9PiBzYXZlU2hlZXQoeyB1c2VkOiBbXSB9KTsKICAkKCcjYWxsVXNlZCcpLm9uY2xpY2sgPSAoKSA9' +
  'PgogICAgc2F2ZVNoZWV0KHsgdXNlZDogQXJyYXkuZnJvbSh7IGxlbmd0aDogbGF5b3V0TWV0YSgpLmNhcGFjaXR5IH0sIChfLCBp' +
  'KSA9PiBpKSB9KTsKICAkKCcjc2F2ZU9mZicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBhd2FpdCBzYXZlU2hlZXQoeyBv' +
  'ZmZzZXRfeDogTnVtYmVyKCQoJyNvZmZYJykudmFsdWUpIHx8IDAsIG9mZnNldF95OiBOdW1iZXIoJCgnI29mZlknKS52YWx1ZSkg' +
  'fHwgMCB9KTsKICAgIHRvYXN0KCdBbGlnbm1lbnQgc2F2ZWQnKTsKICB9OwoKICBjb25zdCBwYWludCA9ICgpID0+IGRvY3VtZW50' +
  'LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXRpY2tdJykuZm9yRWFjaCh0ID0+IHsKICAgIGNvbnN0IG9uID0gUy5jYWNoZS5waWNr' +
  'ZWQuaW5jbHVkZXMoK3QuZGF0YXNldC50aWNrKTsKICAgIHQudGV4dENvbnRlbnQgPSBvbiA/ICfinJMgYWRkZWQnIDogJ2FkZCc7' +
  'CiAgICB0LmNsYXNzTmFtZSA9IG9uID8gJ3BpbGwgU2VydmVkJyA6ICdwaWxsJzsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVj' +
  'dG9yQWxsKCdbZGF0YS1waWNrXScpLmZvckVhY2gocm93ID0+IHJvdy5vbmNsaWNrID0gKCkgPT4gewogICAgY29uc3QgaWQgPSAr' +
  'cm93LmRhdGFzZXQucGljazsKICAgIGNvbnN0IGkgPSBTLmNhY2hlLnBpY2tlZC5pbmRleE9mKGlkKTsKICAgIGkgPT09IC0xID8g' +
  'Uy5jYWNoZS5waWNrZWQucHVzaChpZCkgOiBTLmNhY2hlLnBpY2tlZC5zcGxpY2UoaSwgMSk7CiAgICBwYWludCgpOyBkcmF3R3Jp' +
  'ZCgpOwogIH0pOwogICQoJyNqb2JGaWx0ZXInKS5vbmlucHV0ID0gZSA9PiB7CiAgICBjb25zdCB2ID0gZS50YXJnZXQudmFsdWUu' +
  'dG9Mb3dlckNhc2UoKTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBpY2tdJykuZm9yRWFjaChyID0+IHsK' +
  'ICAgICAgci5zdHlsZS5kaXNwbGF5ID0gci5pbm5lclRleHQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyh2KSA/ICcnIDogJ25vbmUn' +
  'OwogICAgfSk7CiAgfTsKCiAgJCgnI3Rlc3RCdG4nKS5vbmNsaWNrID0gKCkgPT4gewogICAgY29uc3QgaWRzID0gUy5jYWNoZS5w' +
  'aWNrZWQubGVuZ3RoID8gUy5jYWNoZS5waWNrZWQgOiAoam9ic1swXSA/IFtqb2JzWzBdLmlkXSA6IFtdKTsKICAgIGlmICghaWRz' +
  'Lmxlbmd0aCkgcmV0dXJuIHRvYXN0KCdBZGQgYXQgbGVhc3Qgb25lIGpvYiBmaXJzdCcsIHRydWUpOwogICAgd2luZG93Lm9wZW4o' +
  'Jy9wcmludC9sYWJlbHM/Z3VpZGVzPTEmaWRzPScgKyBpZHMuam9pbignLCcpLCAnX2JsYW5rJyk7CiAgfTsKCiAgJCgnI3ByaW50' +
  'QnRuJykub25jbGljayA9ICgpID0+IHsKICAgIGNvbnN0IG1ldGEgPSBsYXlvdXRNZXRhKCk7CiAgICBjb25zdCB1c2VkID0gbmV3' +
  'IFNldChTLmNhY2hlLnNoZWV0LnVzZWQubWFwKE51bWJlcikpOwogICAgY29uc3QgZnJlZSA9IFtdOwogICAgZm9yIChsZXQgaSA9' +
  'IDA7IGkgPCBtZXRhLmNhcGFjaXR5OyBpKyspIGlmICghdXNlZC5oYXMoaSkpIGZyZWUucHVzaChpKTsKICAgIGNvbnN0IHdpbGxV' +
  'c2UgPSBmcmVlLnNsaWNlKDAsIFMuY2FjaGUucGlja2VkLmxlbmd0aCk7CiAgICB3aW5kb3cub3BlbignL3ByaW50L2xhYmVscz9p' +
  'ZHM9JyArIFMuY2FjaGUucGlja2VkLmpvaW4oJywnKSwgJ19ibGFuaycpOwoKICAgIGNvbmZpcm1QcmludGVkKHdpbGxVc2UpOwog' +
  'IH07CgogIGZ1bmN0aW9uIGNvbmZpcm1QcmludGVkKHdpbGxVc2UpIHsKICAgIHNoZWV0KCdEaWQgdGhleSBwcmludD8nLCBgCiAg' +
  'ICAgIDxwIGNsYXNzPSJoaW50Ij5Pbmx5IG1hcmsgdGhlc2UgdXNlZCBvbmNlIHRoZSBzaGVldCBhY3R1YWxseSBjYW1lIG91dCBy' +
  'aWdodCDigJQgaWYgdGhlIHByaW50ZXIKICAgICAgICBqYW1tZWQgb3IgdGhlIGFsaWdubWVudCB3YXMgb2ZmLCBzYXkgbm8gYW5k' +
  'IG5vdGhpbmcgY2hhbmdlcy48L3A+CiAgICAgIDxwPjxiPiR7d2lsbFVzZS5sZW5ndGh9PC9iPiBwb3NpdGlvbiR7d2lsbFVzZS5s' +
  'ZW5ndGggPT09IDEgPyAnJyA6ICdzJ30gd291bGQgYmUgbWFya2VkIHVzZWQ6CiAgICAgICAgJHt3aWxsVXNlLm1hcChpID0+IGkg' +
  'KyAxKS5qb2luKCcsICcpfTwvcD4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij4KICAgICAg' +
  'ICA8YnV0dG9uIGNsYXNzPSJidG4gb2siIGlkPSJ5ZXNVc2VkIj5ZZXMg4oCUIG1hcmsgdGhlbSB1c2VkPC9idXR0b24+CiAgICAg' +
  'ICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5Obywga2VlcCB0aGVtIGZyZWU8L2J1dHRv' +
  'bj4KICAgICAgPC9kaXY+YCwgZWwgPT4gewogICAgICBlbC5xdWVyeVNlbGVjdG9yKCcjeWVzVXNlZCcpLm9uY2xpY2sgPSBhc3lu' +
  'YyAoKSA9PiB7CiAgICAgICAgY29uc3Qgc2V0ID0gbmV3IFNldChTLmNhY2hlLnNoZWV0LnVzZWQubWFwKE51bWJlcikpOwogICAg' +
  'ICAgIHdpbGxVc2UuZm9yRWFjaChpID0+IHNldC5hZGQoaSkpOwogICAgICAgIGF3YWl0IHNhdmVTaGVldCh7IHVzZWQ6IFsuLi5z' +
  'ZXRdIH0pOwogICAgICAgIFMuY2FjaGUucGlja2VkID0gW107CiAgICAgICAgY2xvc2VTaGVldCgpOwogICAgICAgIHRvYXN0KCdT' +
  'aGVldCB1cGRhdGVkIOKAlCAnICsgUy5jYWNoZS5zaGVldC5mcmVlICsgJyBsYWJlbHMgbGVmdCcpOwogICAgICAgIGdvKCd0b29s' +
  'cycpOwogICAgICB9OwogICAgfSk7CiAgfQoKICBwYWludCgpOwogIGRyYXdHcmlkKCk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gcHJvcGVydHkgc2VhcmNoIC0tICovCi8qIFR3byBkaWZmZXJlbnQg' +
  'cmVjb3JkcyBzeXN0ZW1zLCBhbmQgdGhlIGRpZmZlcmVuY2UgbWF0dGVyczoKICAgdGhlIGNvdW50eSBDTEVSSyBob2xkcyBkZWVk' +
  'cyBhbmQgbGllbnMgKHdobyBib3VnaHQsIHNvbGQsIG9yIGhhcyBhIGNsYWltKSwKICAgdGhlIEFQUFJBSVNBTCBESVNUUklDVCBo' +
  'b2xkcyB3aG8gb3ducyBpdCBub3cgYW5kIHdoZXJlIHRoZWlyIHRheCBiaWxsIGlzCiAgIHBvc3RlZCAtLSB3aGljaCBpcyB1c3Vh' +
  'bGx5IHRoZSBiZXR0ZXIgbGVhZCB3aGVuIGFuIGFkZHJlc3MgaGFzIGdvbmUgc3RhbGUuICovCmNvbnN0IENPVU5USUVTID0gWwog' +
  'IHsKICAgIG5hbWU6ICdIaWRhbGdvIENvdW50eScsCiAgICBjbGVyazogeyB1cmw6ICdodHRwczovL2hpZGFsZ28udHgucHVibGlj' +
  'c2VhcmNoLnVzLycsIG5vdGU6ICdEZWVkcywgbGllbnMsIHRyYW5zZmVycy4gR3JhbnRvci9ncmFudGVlLCBkb2MgbnVtYmVyLCBm' +
  'dWxsLXRleHQgT0NSLiBObyBsb2dpbi4nIH0sCiAgICBjYWQ6IHsgdXJsOiAnaHR0cHM6Ly9oaWRhbGdvLnByb2RpZ3ljYWQuY29t' +
  'L3Byb3BlcnR5LXNlYXJjaCcsIG5vdGU6ICdDdXJyZW50IG93bmVyLCBtYWlsaW5nIGFkZHJlc3MsIHNpdHVzIGFkZHJlc3MsIHZh' +
  'bHVhdGlvbi4nIH0sCiAgICBjYWRBbHQ6IHsgdXJsOiAnaHR0cHM6Ly9wcm9wYWNjZXNzLmhpZGFsZ29hZC5vcmcvQ2xpZW50REIv' +
  'UHJvcGVydHlTZWFyY2guYXNweD9jaWQ9MScsIG5vdGU6ICdPbGRlciBIaWRhbGdvIENBRCBzZWFyY2gsIGlmIHRoZSBuZXcgb25l' +
  'IGlzIGRvd24uJyB9CiAgfSwKICB7CiAgICBuYW1lOiAnQ2FtZXJvbiBDb3VudHknLAogICAgY2xlcms6IHsgdXJsOiAnaHR0cHM6' +
  'Ly9jYW1lcm9uLnR4LnB1YmxpY3NlYXJjaC51cy8nLCBub3RlOiAnRGVlZHMsIGxpZW5zLCB0cmFuc2ZlcnMsIGZvcmVjbG9zdXJl' +
  'IHBvc3RpbmdzLiBObyBsb2dpbi4nIH0sCiAgICBjYWQ6IHsgdXJsOiAnaHR0cHM6Ly9jYW1lcm9uLnByb2RpZ3ljYWQuY29tLycs' +
  'IG5vdGU6ICdDdXJyZW50IG93bmVyLCBtYWlsaW5nIGFkZHJlc3MsIHNpdHVzIGFkZHJlc3MsIHZhbHVhdGlvbi4nIH0sCiAgICBj' +
  'YWRBbHQ6IHsgdXJsOiAnaHR0cDovL3Byb3BhY2Nlc3MuY2FtZXJvbmNhZC5vcmcvY2xpZW50ZGIvUHJvcGVydHlTZWFyY2guYXNw' +
  'eD9jaWQ9MScsIG5vdGU6ICdPbGRlciBDYW1lcm9uIENBRCBzZWFyY2gsIGlmIHRoZSBuZXcgb25lIGlzIGRvd24uJyB9CiAgfSwK' +
  'ICB7CiAgICBuYW1lOiAnU3RhcnIgQ291bnR5JywKICAgIGNsZXJrOiB7IHVybDogJ2h0dHBzOi8vc3RhcnIudHgucHVibGljc2Vh' +
  'cmNoLnVzLycsIG5vdGU6ICdEZWVkcywgbGllbnMsIHRyYW5zZmVycy4gU2FtZSBzeXN0ZW0gYXMgSGlkYWxnbyBhbmQgQ2FtZXJv' +
  'bi4nIH0sCiAgICBjYWQ6IHsgdXJsOiAnaHR0cHM6Ly9lc2VhcmNoLnN0YXJyY2FkLm9yZy8nLCBub3RlOiAnQ3VycmVudCBvd25l' +
  'ciwgbWFpbGluZyBhZGRyZXNzLCBzaXR1cyBhZGRyZXNzLicgfQogIH0KXTsKCmZ1bmN0aW9uIHByb3BlcnR5VmlldygpIHsKICBj' +
  'b25zdCByb3dzID0gQ09VTlRJRVMubWFwKChjLCBjaSkgPT4gYAogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj4ke2Vz' +
  'YyhjLm5hbWUpfTwvaDI+CiAgICAgIDxkaXYgY2xhc3M9Imxpc3QiPgogICAgICAgIDxkaXYgY2xhc3M9Iml0ZW0iIGRhdGEtcHJv' +
  'cD0iJHtjaX06Y2FkIj4KICAgICAgICAgIDxkaXYgY2xhc3M9InQiPkFwcHJhaXNhbCBkaXN0cmljdCDigJQgd2hvIG93bnMgaXQg' +
  'bm93PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJtIj4ke2VzYyhjLmNhZC5ub3RlKX08L2Rpdj4KICAgICAgICA8L2Rpdj4K' +
  'ICAgICAgICA8ZGl2IGNsYXNzPSJpdGVtIiBkYXRhLXByb3A9IiR7Y2l9OmNsZXJrIj4KICAgICAgICAgIDxkaXYgY2xhc3M9InQi' +
  'PkNvdW50eSBjbGVyayDigJQgZGVlZHMgJmFtcDsgbGllbnM8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9Im0iPiR7ZXNjKGMu' +
  'Y2xlcmsubm90ZSl9PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgJHtjLmNhZEFsdCA/IGA8ZGl2IGNsYXNzPSJpdGVtIiBk' +
  'YXRhLXByb3A9IiR7Y2l9OmNhZEFsdCI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ0Ij5BcHByYWlzYWwgZGlzdHJpY3QgKG9sZGVy' +
  'IHNlYXJjaCk8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9Im0iPiR7ZXNjKGMuY2FkQWx0Lm5vdGUpfTwvZGl2PgogICAgICAg' +
  'IDwvZGl2PmAgOiAnJ30KICAgICAgPC9kaXY+CiAgICA8L2Rpdj5gKS5qb2luKCcnKTsKCiAgYXBwLmlubmVySFRNTCA9IHNoZWxs' +
  'KGAKICAgIDxoMSBjbGFzcz0icGFnZSI+UHJvcGVydHkgcmVjb3JkczwvaDE+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAg' +
  'PGxhYmVsPk5hbWUgb3IgYWRkcmVzcyB0byBsb29rIHVwPC9sYWJlbD4KICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgICA8' +
  'aW5wdXQgaWQ9InByb3BRIiBwbGFjZWhvbGRlcj0iR0FSWkEgTUFSSUEgIG9yICAxMjA0IEUgTWFpbiBTdCIgc3R5bGU9ImZsZXg6' +
  'MTttaW4td2lkdGg6MTYwcHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9InByb3BDb3B5Ij5Db3B5PC9idXR0' +
  'b24+CiAgICAgIDwvZGl2PgogICAgICA8cCBjbGFzcz0iaGludCI+VGhlc2Ugc2l0ZXMgY2FuJ3QgYmUgbGlua2VkIHRvIHdpdGgg' +
  'YSBzZWFyY2ggdGVybSwgc28gdGFwcGluZyBvbmUgY29waWVzIHdoYXQgeW91IHR5cGVkCiAgICAgICAgYW5kIG9wZW5zIHRoZWly' +
  'IHNlYXJjaCBwYWdlIOKAlCBwYXN0ZSBpdCBpbnRvIHRoZWlyIGJveC48L3A+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJj' +
  'YXJkIiBzdHlsZT0iYmFja2dyb3VuZDojZjhmYWZjO2JveC1zaGFkb3c6bm9uZSI+CiAgICAgIDxoMj5XaGljaCBvbmUgZG8geW91' +
  'IHdhbnQ/PC9oMj4KICAgICAgPHAgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MCI+CiAgICAgICAgPGI+QXBwcmFpc2FsIGRp' +
  'c3RyaWN0PC9iPiDigJQgY3VycmVudCBvd25lciBhbmQgdGhlIG1haWxpbmcgYWRkcmVzcyB0aGUgdGF4IGJpbGwgZ29lcyB0by4g' +
  'QmVzdCBmb3IKICAgICAgICBjb25maXJtaW5nIHRoZSBwZXJzb24gb24geW91ciBwYXBlcnMgaXMgdGllZCB0byB0aGUgYWRkcmVz' +
  'cywgYW5kIGZvciBmaW5kaW5nIHNvbWV3aGVyZSBlbHNlIHRvIHRyeS48YnI+PGJyPgogICAgICAgIDxiPkNvdW50eSBjbGVyazwv' +
  'Yj4g4oCUIGRlZWRzLCBsaWVucyBhbmQgdHJhbnNmZXJzLiBCZXN0IGZvciBoaXN0b3J5OiB3aG8gc29sZCBpdCwgd2hlbiwgYW5k' +
  'IHdobyBob2xkcyBhIGNsYWltLgogICAgICAgIFdvbid0IHJlbGlhYmx5IHRlbGwgeW91IHdobyBsaXZlcyB0aGVyZSBub3cuPC9w' +
  'PgogICAgPC9kaXY+CgogICAgJHtyb3dzfQoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5' +
  'bGU9Im1hcmdpbjowIj5BIG1haWxpbmcgYWRkcmVzcyBmcm9tIHRoZSBhcHByYWlzYWwgZGlzdHJpY3QgaXMgYSBsZWFkLCBub3Qg' +
  'cHJvb2Ygb2YKICAgICAgICByZXNpZGVuY2Ug4oCUIHBsZW50eSBvZiBvd25lcnMgaGF2ZSBwb3N0IGdvbmUgdG8gYW4gYWdlbnQs' +
  'IGEgcmVsYXRpdmUsIG9yIGFub3RoZXIgc3RhdGUuIFRyZWF0IGl0IGFzIGEKICAgICAgICBwbGFjZSB0byBhdHRlbXB0LCBhbmQg' +
  'cmVjb3JkIHdoYXQgeW91IGFjdHVhbGx5IGZpbmQgaW4gdGhlIGF0dGVtcHQgbm90ZXMuPC9wPgogICAgPC9kaXY+YCk7CiAgYmlu' +
  'ZFNoZWxsKCk7CgogIGNvbnN0IGNvcHlUZXJtID0gYXN5bmMgKCkgPT4gewogICAgY29uc3QgdiA9ICQoJyNwcm9wUScpLnZhbHVl' +
  'LnRyaW0oKTsKICAgIGlmICghdikgcmV0dXJuIGZhbHNlOwogICAgdHJ5IHsgYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0' +
  'ZVRleHQodik7IHJldHVybiB0cnVlOyB9IGNhdGNoIChlKSB7IHJldHVybiBmYWxzZTsgfQogIH07CiAgJCgnI3Byb3BDb3B5Jyku' +
  'b25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIGNvbnN0IHYgPSAkKCcjcHJvcFEnKS52YWx1ZS50cmltKCk7CiAgICBpZiAoIXYp' +
  'IHJldHVybiB0b2FzdCgnVHlwZSBhIG5hbWUgb3IgYWRkcmVzcyBmaXJzdCcsIHRydWUpOwogICAgdG9hc3QoYXdhaXQgY29weVRl' +
  'cm0oKSA/ICdDb3BpZWQgIicgKyB2ICsgJyInIDogJ0NvcHkgZmFpbGVkIOKAlCBzZWxlY3QgaXQgYnkgaGFuZCcpOwogIH07CiAg' +
  'ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcHJvcF0nKS5mb3JFYWNoKHJvdyA9PiByb3cub25jbGljayA9IGFzeW5j' +
  'ICgpID0+IHsKICAgIGNvbnN0IFtjaSwgd2hpY2hdID0gcm93LmRhdGFzZXQucHJvcC5zcGxpdCgnOicpOwogICAgY29uc3QgdGFy' +
  'Z2V0ID0gQ09VTlRJRVNbK2NpXVt3aGljaF07CiAgICBjb25zdCBoYWQgPSAkKCcjcHJvcFEnKS52YWx1ZS50cmltKCk7CiAgICBj' +
  'b25zdCBvayA9IGhhZCA/IGF3YWl0IGNvcHlUZXJtKCkgOiBmYWxzZTsKICAgIHRvYXN0KG9rID8gJ0NvcGllZCAiJyArIGhhZCAr' +
  'ICciIOKAlCBwYXN0ZSBpdCBpbnRvIHRoZWlyIHNlYXJjaCcgOiAnT3BlbmluZyAnICsgQ09VTlRJRVNbK2NpXS5uYW1lKTsKICAg' +
  'IHdpbmRvdy5vcGVuKHRhcmdldC51cmwsICdfYmxhbmsnKTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gY2FzZSBsb29rdXAgLS0gKi8KLyogTm9uZSBvZiB0aGVzZSBwb3J0YWxzIGFj' +
  'Y2VwdCBhIGNhc2UgbnVtYmVyIGluIHRoZSBVUkwgLS0gSGlkYWxnbydzIHJ1bnMgb24KICAgc2Vzc2lvbi1iYXNlZCBmb3JtIHBv' +
  'c3RzLCBDYW1lcm9uJ3Mgc2l0cyBiZWhpbmQgYSBKYXZhU2NyaXB0IGdhdGUuIFNvIHRoaXMKICAgY29waWVzIHRoZSBudW1iZXIg' +
  'dG8gdGhlIGNsaXBib2FyZCBhbmQgb3BlbnMgdGhlIHJpZ2h0IHNlYXJjaCBwYWdlLiBObwogICBzY3JhcGluZywgbm90aGluZyB0' +
  'byBicmVhayB3aGVuIHRoZXkgcmVkZXNpZ24uICovCmNvbnN0IFRYX1BPUlRBTFMgPSBbCiAgeyBuYW1lOiAncmU6U2VhcmNoVFgg' +
  '4oCUIHN0YXRld2lkZScsIHVybDogJ2h0dHBzOi8vcmVzZWFyY2gudHhjb3VydHMuZ292LycsCiAgICBub3RlOiAnRnJlZSBhY2Nv' +
  'dW50IHJlcXVpcmVkLiBEaXN0cmljdCwgY291bnR5IGFuZCBwcm9iYXRlIGNvdXJ0cyBpbiBhbGwgMjU0IGNvdW50aWVzLiAnICsK' +
  'ICAgICAgICAgICdQdWJsaWMgdmlldyBzdGFydHMgYXQgZmlsaW5ncyBmcm9tIDEgTm92IDIwMTguIEp1c3RpY2Utb2YtdGhlLXBl' +
  'YWNlIGV2aWN0aW9ucyBhcmUgcGF0Y2h5LicgfSwKICB7IG5hbWU6ICdIaWRhbGdvIENvdW50eSDigJQgRGlzdHJpY3QgQ2xlcmsg' +
  'Y2FzZSBzZWFyY2gnLCB1cmw6ICdodHRwczovL3BhLmNvLmhpZGFsZ28udHgudXMvZGVmYXVsdC5hc3B4JywKICAgIG5vdGU6ICdD' +
  'aXZpbCBhbmQgY3JpbWluYWwgY2FzZXMuIEZyZWUsIG5vIGxvZ2luLicgfSwKICB7IG5hbWU6ICdDYW1lcm9uIENvdW50eSDigJQg' +
  'Y291cnQgcG9ydGFscycsIHVybDogJ2h0dHBzOi8vd3d3LmNhbWVyb25jb3VudHl0eC5nb3YvY2FtZXJvbi1jb3VudHktcG9ydGFs' +
  'cy8nLAogICAgbm90ZTogJ0luZGV4IHBhZ2UgZm9yIHRoZSBjb3VudHlcJ3MgZGlzdHJpY3QgYW5kIGNvdW50eSBjbGVyayBzZWFy' +
  'Y2hlcy4nIH0sCiAgeyBuYW1lOiAnQ2FtZXJvbiBDb3VudHkg4oCUIERpc3RyaWN0IENsZXJrIHJlY29yZHMnLCB1cmw6ICdodHRw' +
  'czovL2tvZmlsZXF1aWNrbGlua3MuY29tL2NhbWVyb25kYy8nLAogICAgbm90ZTogJ0Rpc3RyaWN0IENsZXJrIHJlY29yZCBzZWFy' +
  'Y2guJyB9LAogIHsgbmFtZTogJ0hpZGFsZ28gQ291bnR5IOKAlCBwcm9wZXJ0eSAvIG9mZmljaWFsIHJlY29yZHMnLCB1cmw6ICdo' +
  'dHRwczovL2hpZGFsZ28udHgucHVibGljc2VhcmNoLnVzLycsCiAgICBub3RlOiAnRGVlZHMsIGxpZW5zIGFuZCBvd25lcnNoaXAg' +
  'ZnJvbSB0aGUgQ291bnR5IENsZXJrIOKAlCBwcm9wZXJ0eSwgbm90IGxhd3N1aXRzLiAnICsKICAgICAgICAgICdVc2VmdWwgZm9y' +
  'IGNvbmZpcm1pbmcgd2hvIGFjdHVhbGx5IG93bnMgYW4gYWRkcmVzcy4nIH0KXTsKCmZ1bmN0aW9uIGNhc2VMb29rdXBTaGVldChq' +
  'b2IpIHsKICBzaGVldCgnTG9vayB1cCAnICsgam9iLmNhc2VfbnVtYmVyLCBgCiAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0i' +
  'YmFja2dyb3VuZDojZjhmYWZjO2JveC1zaGFkb3c6bm9uZTt0ZXh0LWFsaWduOmNlbnRlciI+CiAgICAgIDxkaXYgc3R5bGU9ImZv' +
  'bnQ6NjAwIDIwcHgvMS4zIG1vbm9zcGFjZTtsZXR0ZXItc3BhY2luZzouNXB4Ij4ke2VzYyhqb2IuY2FzZV9udW1iZXIpfTwvZGl2' +
  'PgogICAgICA8ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyhqb2IuY291cnQgfHwgJ2NvdXJ0IG5vdCByZWNvcmRlZCcpfTwvZGl2Pgog' +
  'ICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc20iIGlkPSJjb3B5Q2FzZSIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+Q29weSBjYXNl' +
  'IG51bWJlcjwvYnV0dG9uPgogICAgPC9kaXY+CiAgICA8cCBjbGFzcz0iaGludCI+VGhlc2UgcG9ydGFscyBjYW4ndCBiZSBsaW5r' +
  'ZWQgdG8gZGlyZWN0bHkgd2l0aCBhIGNhc2UgbnVtYmVyLCBzbyB0YXBwaW5nIG9uZSBjb3BpZXMKICAgICAgdGhlIG51bWJlciBh' +
  'bmQgb3BlbnMgdGhlaXIgc2VhcmNoIHBhZ2Ug4oCUIHBhc3RlIGl0IGludG8gdGhlaXIgYm94LjwvcD4KICAgIDxkaXYgY2xhc3M9' +
  'Imxpc3QiPgogICAgICAke1RYX1BPUlRBTFMubWFwKChwLCBpKSA9PiBgCiAgICAgICAgPGRpdiBjbGFzcz0iaXRlbSIgZGF0YS1w' +
  'b3J0YWw9IiR7aX0iPgogICAgICAgICAgPGRpdiBjbGFzcz0idCI+JHtlc2MocC5uYW1lKX08L2Rpdj4KICAgICAgICAgIDxkaXYg' +
  'Y2xhc3M9Im0iPiR7ZXNjKHAubm90ZSl9PC9kaXY+CiAgICAgICAgPC9kaXY+YCkuam9pbignJyl9CiAgICA8L2Rpdj4KICAgIDxw' +
  'IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij5Db3VydCByZWNvcmRzIHJhcmVseSBwdWJsaXNoIGEgZGVmZW5k' +
  'YW50J3Mgc2VydmljZSBhZGRyZXNzIOKAlAogICAgICB0aGF0IG5vcm1hbGx5IG9ubHkgZXhpc3RzIG9uIHRoZSBjbGllbnQncyBw' +
  'YWNrZXQuPC9wPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBibG9jayIgc3R5bGU9Im1hcmdpbi10b3A6OHB4IiBvbmNsaWNr' +
  'PSJjbG9zZVNoZWV0KCkiPkNsb3NlPC9idXR0b24+YCwgZWwgPT4gewogICAgY29uc3QgY29weSA9IGFzeW5jICgpID0+IHsKICAg' +
  'ICAgdHJ5IHsgYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoam9iLmNhc2VfbnVtYmVyKTsgcmV0dXJuIHRydWU7' +
  'IH0KICAgICAgY2F0Y2ggKGUpIHsgcmV0dXJuIGZhbHNlOyB9CiAgICB9OwogICAgZWwucXVlcnlTZWxlY3RvcignI2NvcHlDYXNl' +
  'Jykub25jbGljayA9IGFzeW5jICgpID0+CiAgICAgIHRvYXN0KGF3YWl0IGNvcHkoKSA/ICdDb3BpZWQgJyArIGpvYi5jYXNlX251' +
  'bWJlciA6ICdDb3B5IGZhaWxlZCDigJQgc2VsZWN0IGl0IGJ5IGhhbmQnLCBmYWxzZSk7CiAgICBlbC5xdWVyeVNlbGVjdG9yQWxs' +
  'KCdbZGF0YS1wb3J0YWxdJykuZm9yRWFjaChyb3cgPT4gcm93Lm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IHAg' +
  'PSBUWF9QT1JUQUxTWytyb3cuZGF0YXNldC5wb3J0YWxdOwogICAgICBjb25zdCBvayA9IGF3YWl0IGNvcHkoKTsKICAgICAgdG9h' +
  'c3Qob2sgPyAnQ2FzZSBudW1iZXIgY29waWVkIOKAlCBwYXN0ZSBpdCBpbnRvIHRoZWlyIHNlYXJjaCcgOiAnT3BlbmluZyAnICsg' +
  'cC5uYW1lKTsKICAgICAgd2luZG93Lm9wZW4ocC51cmwsICdfYmxhbmsnKTsKICAgIH0pOwogIH0pOwp9CgovKiAtLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gc2NhbiAtLSAqLwpmdW5jdGlvbiBz' +
  'Y2FuVmlldygpIHsKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5TY2FuIGEgcGFja2V0PC9o' +
  'MT4KICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6MCI+UG9pbnQg' +
  'dGhlIGNhbWVyYSBhdCB0aGUgYmFyY29kZSBvbiB0aGUgY292ZXIgc2hlZXQgdG8gb3BlbiB0aGF0IGpvYi4gSWYgdGhlIGNhbWVy' +
  'YQogICAgICB3b24ndCBjb29wZXJhdGUsIHR5cGUgdGhlIGpvYiBudW1iZXIgaW5zdGVhZCDigJQgaXQgd29ya3MgdGhlIHNhbWUu' +
  'PC9wPgogICAgICA8ZGl2IGlkPSJyZWFkZXIiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9w' +
  'OjEycHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InN0YXJ0U2NhbiI+U3RhcnQgY2FtZXJhPC9idXR0b24+CiAg' +
  'ICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgaWQ9InN0b3BTY2FuQnRuIiBzdHlsZT0iZGlzcGxheTpub25lIj5TdG9wPC9i' +
  'dXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBpZD0ic2Nhbk1zZyI+PC9kaXY+CiAgICA8L2Rpdj4K' +
  'ICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+RW50ZXIgam9iIG51bWJlcjwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InJv' +
  'dyI+CiAgICAgICAgPGlucHV0IGlkPSJtYW51YWwiIHBsYWNlaG9sZGVyPSJTVC0xMDAwMSIgc3R5bGU9ImZsZXg6MTt0ZXh0LXRy' +
  'YW5zZm9ybTp1cHBlcmNhc2UiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9Im1hbnVhbEdvIj5PcGVuPC9idXR0b24+' +
  'CiAgICAgIDwvZGl2PgogICAgPC9kaXY+YCk7CiAgYmluZFNoZWxsKCk7CgogIGNvbnN0IG9wZW4gPSBhc3luYyBjb2RlID0+IHsK' +
  'ICAgIHRyeSB7CiAgICAgIGNvbnN0IGogPSBhd2FpdCBhcGkoJy9sb29rdXAvJyArIGVuY29kZVVSSUNvbXBvbmVudChjb2RlKSk7' +
  'CiAgICAgIGlmICh3aW5kb3cuX19zdG9wU2NhbikgeyB3aW5kb3cuX19zdG9wU2NhbigpOyB3aW5kb3cuX19zdG9wU2NhbiA9IG51' +
  'bGw7IH0KICAgICAgdG9hc3QoJ09wZW5pbmcgJyArIGouam9iX251bWJlcik7CiAgICAgIGdvKCdqb2InLCB7IGlkOiBqLmlkIH0p' +
  'OwogICAgfSBjYXRjaCAoZSkgeyAkKCcjc2Nhbk1zZycpLnRleHRDb250ZW50ID0gZS5tZXNzYWdlOyB0b2FzdChlLm1lc3NhZ2Us' +
  'IHRydWUpOyB9CiAgfTsKCiAgJCgnI21hbnVhbEdvJykub25jbGljayA9ICgpID0+IHsgY29uc3QgdiA9ICQoJyNtYW51YWwnKS52' +
  'YWx1ZS50cmltKCk7IGlmICh2KSBvcGVuKHYpOyB9OwogICQoJyNtYW51YWwnKS5vbmtleWRvd24gPSBlID0+IHsgaWYgKGUua2V5' +
  'ID09PSAnRW50ZXInKSAkKCcjbWFudWFsR28nKS5jbGljaygpOyB9OwoKICAkKCcjc3RhcnRTY2FuJykub25jbGljayA9IGFzeW5j' +
  'ICgpID0+IHsKICAgIGNvbnN0IG1zZyA9ICQoJyNzY2FuTXNnJyk7CiAgICBpZiAoIXdpbmRvdy5aWGluZykgcmV0dXJuIG1zZy50' +
  'ZXh0Q29udGVudCA9ICdTY2FubmVyIGxpYnJhcnkgZGlkIG5vdCBsb2FkIOKAlCB1c2UgdGhlIGpvYiBudW1iZXIgYm94IGJlbG93' +
  'Lic7CiAgICB0cnkgewogICAgICBjb25zdCByZWFkZXIgPSBuZXcgWlhpbmcuQnJvd3Nlck11bHRpRm9ybWF0UmVhZGVyKCk7CiAg' +
  'ICAgIGNvbnN0IHZpZGVvID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndmlkZW8nKTsKICAgICAgdmlkZW8uc2V0QXR0cmlidXRl' +
  'KCdwbGF5c2lubGluZScsICd0cnVlJyk7CiAgICAgICQoJyNyZWFkZXInKS5pbm5lckhUTUwgPSAnJzsKICAgICAgJCgnI3JlYWRl' +
  'cicpLmFwcGVuZENoaWxkKHZpZGVvKTsKICAgICAgJCgnI3N0YXJ0U2NhbicpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgICAg' +
  'ICQoJyNzdG9wU2NhbkJ0bicpLnN0eWxlLmRpc3BsYXkgPSAnJzsKICAgICAgbXNnLnRleHRDb250ZW50ID0gJ0xvb2tpbmcgZm9y' +
  'IGEgYmFyY29kZeKApic7CiAgICAgIGxldCBoYW5kbGVkID0gZmFsc2U7CiAgICAgIGF3YWl0IHJlYWRlci5kZWNvZGVGcm9tQ29u' +
  'c3RyYWludHMoCiAgICAgICAgeyB2aWRlbzogeyBmYWNpbmdNb2RlOiAnZW52aXJvbm1lbnQnIH0gfSwgdmlkZW8sCiAgICAgICAg' +
  'KHJlc3VsdCkgPT4geyBpZiAocmVzdWx0ICYmICFoYW5kbGVkKSB7IGhhbmRsZWQgPSB0cnVlOyBvcGVuKHJlc3VsdC5nZXRUZXh0' +
  'KCkpOyB9IH0pOwogICAgICB3aW5kb3cuX19zdG9wU2NhbiA9ICgpID0+IHsKICAgICAgICB0cnkgeyByZWFkZXIucmVzZXQoKTsg' +
  'fSBjYXRjaCAoZSkge30KICAgICAgICAkKCcjcmVhZGVyJykuaW5uZXJIVE1MID0gJyc7CiAgICAgICAgY29uc3QgcyA9ICQoJyNz' +
  'dGFydFNjYW4nKSwgc3QgPSAkKCcjc3RvcFNjYW5CdG4nKTsKICAgICAgICBpZiAocykgcy5zdHlsZS5kaXNwbGF5ID0gJyc7CiAg' +
  'ICAgICAgaWYgKHN0KSBzdC5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogICAgICB9OwogICAgICAkKCcjc3RvcFNjYW5CdG4nKS5v' +
  'bmNsaWNrID0gKCkgPT4geyB3aW5kb3cuX19zdG9wU2NhbigpOyB3aW5kb3cuX19zdG9wU2NhbiA9IG51bGw7IG1zZy50ZXh0Q29u' +
  'dGVudCA9ICcnOyB9OwogICAgfSBjYXRjaCAoZSkgewogICAgICBtc2cudGV4dENvbnRlbnQgPSAnQ2FtZXJhIHVuYXZhaWxhYmxl' +
  'ICgnICsgZS5tZXNzYWdlICsgJykuIFVzZSB0aGUgam9iIG51bWJlciBib3ggYmVsb3cuJzsKICAgICAgJCgnI3N0YXJ0U2Nhbicp' +
  'LnN0eWxlLmRpc3BsYXkgPSAnJzsKICAgICAgJCgnI3N0b3BTY2FuQnRuJykuc3R5bGUuZGlzcGxheSA9ICdub25lJzsKICAgIH0K' +
  'ICB9Owp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBt' +
  'b25leSAtLSAqLwphc3luYyBmdW5jdGlvbiBtb25leVZpZXcoKSB7CiAgaWYgKCFpc0FkbWluKCkpIHJldHVybiBteVBheVZpZXco' +
  'KTsKICBjb25zdCBbc3RhdGVtZW50cywgaW52b2ljZXMsIHVzZXJzLCBjbGllbnRzXSA9IGF3YWl0IFByb21pc2UuYWxsKAogICAg' +
  'W2FwaSgnL3N0YXRlbWVudHMnKSwgYXBpKCcvaW52b2ljZXMnKSwgYXBpKCcvdXNlcnMnKSwgYXBpKCcvY2xpZW50cycpXSk7Cgog' +
  'IGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8aDEgY2xhc3M9InBhZ2UiPkJpbGxpbmcgJmFtcDsgcGF5PC9oMT4KCiAgICA8' +
  'ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkNvbnRyYWN0b3Igc3RhdGVtZW50cyA8c3BhbiBjbGFzcz0ic3ViIj53aGF0IHlv' +
  'dSBvd2UgeW91ciBzZXJ2ZXJzPC9zcGFuPjwvaDI+CiAgICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDotNHB4' +
  'Ij5QdWxscyBldmVyeSBjb21wbGV0ZWQgc2VydmUgaW4gdGhlIHBlcmlvZCB0aGF0IGhhc24ndCBiZWVuIHBhaWQgb3V0IHlldCwg' +
  'YXQgdGhlCiAgICAgIHBlci1qb2IgcmF0ZSBvbiB0aGUgam9iLiBOb3RoaW5nIGdldHMgY291bnRlZCB0d2ljZS48L3A+CiAgICAg' +
  'IDxkaXYgY2xhc3M9ImdyaWQgZzIiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48' +
  'bGFiZWw+U2VydmVyPC9sYWJlbD48c2VsZWN0IGlkPSJzX3NlcnZlciI+CiAgICAgICAgICAke3VzZXJzLmZpbHRlcih1ID0+IHUu' +
  'YWN0aXZlKS5tYXAodSA9PiBgPG9wdGlvbiB2YWx1ZT0iJHt1LmlkfSI+JHtlc2ModS5uYW1lKX08L29wdGlvbj5gKS5qb2luKCcn' +
  'KX08L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJhbGlnbi1pdGVtczpmbGV4LWVuZDtnYXA6' +
  'NnB4Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0iZmxleDoxO21hcmdpbjowIj48bGFiZWw+RnJvbTwvbGFi' +
  'ZWw+PGlucHV0IHR5cGU9ImRhdGUiIGlkPSJzX3N0YXJ0IiB2YWx1ZT0iJHtmaXJzdE9mTW9udGgoKX0iPjwvZGl2PgogICAgICAg' +
  'ICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJmbGV4OjE7bWFyZ2luOjAiPjxsYWJlbD5UbzwvbGFiZWw+PGlucHV0IHR5cGU9' +
  'ImRhdGUiIGlkPSJzX2VuZCIgdmFsdWU9IiR7dG9kYXlJU08oKX0iPjwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4K' +
  'ICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBz' +
  'ZWMgc20iIGlkPSJzX3ByZXYiPlByZXZpZXc8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc20iIGlkPSJzX21h' +
  'a2UiPkNyZWF0ZSBzdGF0ZW1lbnQ8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgaWQ9InNfb3V0Ij48L2Rpdj4KICAg' +
  'ICAgJHtzdGF0ZW1lbnRzLmxlbmd0aCA/IGA8dGFibGUgY2xhc3M9InRibCIgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+CiAgICAg' +
  'ICAgPHRyPjx0aD5TZXJ2ZXI8L3RoPjx0aD5QZXJpb2Q8L3RoPjx0aCBjbGFzcz0ibnVtIj5Kb2JzPC90aD48dGggY2xhc3M9Im51' +
  'bSI+VG90YWw8L3RoPjx0aD48L3RoPjx0aD48L3RoPjwvdHI+CiAgICAgICAgJHtzdGF0ZW1lbnRzLm1hcChzID0+IGA8dHI+CiAg' +
  'ICAgICAgICA8dGQ+JHtlc2Mocy5zZXJ2ZXJfbmFtZSl9PC90ZD48dGQ+JHtmbXREYXRlT25seShzLnBlcmlvZF9zdGFydCl94oCT' +
  'JHtmbXREYXRlT25seShzLnBlcmlvZF9lbmQpfTwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHtzLmpvYl9jb3VudH08' +
  'L3RkPjx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KHMudG90YWwpfTwvdGQ+CiAgICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InBpbGwg' +
  'JHtjbHMocy5zdGF0dXMpfSI+JHtlc2Mocy5zdGF0dXMpfTwvc3Bhbj48L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPjxh' +
  'IGhyZWY9Ii9wcmludC9zdGF0ZW1lbnQvJHtzLmlkfSIgdGFyZ2V0PSJfYmxhbmsiPnByaW50PC9hPgogICAgICAgICAgICAke3Mu' +
  'c3RhdHVzICE9PSAnUGFpZCcgPyBgIMK3IDxhIGhyZWY9IiMiIGRhdGEtcGFpZD0iJHtzLmlkfSI+bWFyayBwYWlkPC9hPmAgOiAn' +
  'J308L3RkPgogICAgICAgIDwvdHI+YCkuam9pbignJyl9PC90YWJsZT5gIDogJyd9CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNz' +
  'PSJjYXJkIj4KICAgICAgPGgyPkNsaWVudCBpbnZvaWNlczwvaDI+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICAg' +
  'IDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q2xpZW50PC9sYWJlbD48c2VsZWN0IGlkPSJpX2NsaWVudCI+CiAgICAgICAgICAk' +
  'e2NsaWVudHMuZmlsdGVyKGMgPT4gYy5hY3RpdmUpLm1hcChjID0+IGA8b3B0aW9uIHZhbHVlPSIke2MuaWR9Ij4ke2VzYyhjLm5h' +
  'bWUpfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9ImFs' +
  'aWduLWl0ZW1zOmZsZXgtZW5kO2dhcDo2cHgiPgogICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJmbGV4OjE7bWFy' +
  'Z2luOjAiPjxsYWJlbD5Gcm9tPC9sYWJlbD48aW5wdXQgdHlwZT0iZGF0ZSIgaWQ9Imlfc3RhcnQiIHZhbHVlPSIke2ZpcnN0T2ZN' +
  'b250aCgpfSI+PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCIgc3R5bGU9ImZsZXg6MTttYXJnaW46MCI+PGxhYmVs' +
  'PlRvPC9sYWJlbD48aW5wdXQgdHlwZT0iZGF0ZSIgaWQ9ImlfZW5kIiB2YWx1ZT0iJHt0b2RheUlTTygpfSI+PC9kaXY+CiAgICAg' +
  'ICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+CiAgICAg' +
  'ICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9ImlfcHJldiI+UHJldmlldzwvYnV0dG9uPgogICAgICAgIDxidXR0b24g' +
  'Y2xhc3M9ImJ0biBzbSIgaWQ9ImlfbWFrZSI+Q3JlYXRlIGludm9pY2U8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYg' +
  'aWQ9Imlfb3V0Ij48L2Rpdj4KICAgICAgJHtpbnZvaWNlcy5sZW5ndGggPyBgPHRhYmxlIGNsYXNzPSJ0YmwiIHN0eWxlPSJtYXJn' +
  'aW4tdG9wOjE0cHgiPgogICAgICAgIDx0cj48dGg+Q2xpZW50PC90aD48dGg+UGVyaW9kPC90aD48dGggY2xhc3M9Im51bSI+Sm9i' +
  'czwvdGg+PHRoIGNsYXNzPSJudW0iPlRvdGFsPC90aD48dGg+PC90aD48dGg+PC90aD48L3RyPgogICAgICAgICR7aW52b2ljZXMu' +
  'bWFwKHMgPT4gYDx0cj4KICAgICAgICAgIDx0ZD4ke2VzYyhzLmNsaWVudF9uYW1lKX08L3RkPjx0ZD4ke2ZtdERhdGVPbmx5KHMu' +
  'cGVyaW9kX3N0YXJ0KX3igJMke2ZtdERhdGVPbmx5KHMucGVyaW9kX2VuZCl9PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVt' +
  'Ij4ke3Muam9iX2NvdW50fTwvdGQ+PHRkIGNsYXNzPSJudW0iPiR7bW9uZXkocy50b3RhbCl9PC90ZD4KICAgICAgICAgIDx0ZD48' +
  'c3BhbiBjbGFzcz0icGlsbCAke2NscyhzLnN0YXR1cyl9Ij4ke2VzYyhzLnN0YXR1cyl9PC9zcGFuPjwvdGQ+CiAgICAgICAgICA8' +
  'dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iL3ByaW50L2ludm9pY2UvJHtzLmlkfSIgdGFyZ2V0PSJfYmxhbmsiPnByaW50PC9hPgog' +
  'ICAgICAgICAgICAke3Muc3RhdHVzICE9PSAnUGFpZCcgPyBgIMK3IDxhIGhyZWY9IiMiIGRhdGEtaXBhaWQ9IiR7cy5pZH0iPm1h' +
  'cmsgcGFpZDwvYT5gIDogJyd9PC90ZD4KICAgICAgICA8L3RyPmApLmpvaW4oJycpfTwvdGFibGU+YCA6ICcnfQogICAgPC9kaXY+' +
  'YCk7CiAgYmluZFNoZWxsKCk7CgogIGNvbnN0IGxpbmVzVGFibGUgPSAociwga2V5KSA9PiByLmxpbmVzLmxlbmd0aAogICAgPyBg' +
  'PHRhYmxlIGNsYXNzPSJ0YmwiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPjx0cj48dGg+RGF0ZTwvdGg+PHRoPkpvYjwvdGg+PHRo' +
  'PlJlY2lwaWVudDwvdGg+PHRoIGNsYXNzPSJudW0iPiR7a2V5ID09PSAncGF5JyA/ICdQYXknIDogJ0ZlZSd9PC90aD48L3RyPgog' +
  'ICAgICAgJHtyLmxpbmVzLm1hcChsID0+IGA8dHI+PHRkPiR7Zm10RGF0ZU9ubHkobC5zZXJ2ZWRfYXQpfTwvdGQ+PHRkPiR7ZXNj' +
  'KGwuam9iX251bWJlcil9PC90ZD4KICAgICAgIDx0ZD4ke2VzYyhsLnJlY2lwaWVudF9uYW1lKX08L3RkPjx0ZCBjbGFzcz0ibnVt' +
  'Ij4ke21vbmV5KGtleSA9PT0gJ3BheScgPyBsLnNlcnZlcl9wYXkgOiBsLmNsaWVudF9mZWUpfTwvdGQ+PC90cj5gKS5qb2luKCcn' +
  'KX0KICAgICAgIDx0cj48dGQgY29sc3Bhbj0iMyI+PGI+JHtyLmNvdW50fSBqb2Iocyk8L2I+PC90ZD48dGQgY2xhc3M9Im51bSI+' +
  'PGI+JHttb25leShyLnRvdGFsKX08L2I+PC90ZD48L3RyPjwvdGFibGU+YAogICAgOiAnPGRpdiBjbGFzcz0iaGludCI+Tm90aGlu' +
  'ZyB1bmJpbGxlZCBpbiB0aGF0IHdpbmRvdy48L2Rpdj4nOwoKICAkKCcjc19wcmV2Jykub25jbGljayA9IGFzeW5jICgpID0+IHsK' +
  'ICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9zdGF0ZW1lbnRzL3ByZXZpZXcnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09O' +
  'LnN0cmluZ2lmeSgKICAgICAgeyBzZXJ2ZXJfaWQ6ICQoJyNzX3NlcnZlcicpLnZhbHVlLCBzdGFydDogJCgnI3Nfc3RhcnQnKS52' +
  'YWx1ZSwgZW5kOiAkKCcjc19lbmQnKS52YWx1ZSB9KSB9KTsKICAgICQoJyNzX291dCcpLmlubmVySFRNTCA9IGxpbmVzVGFibGUo' +
  'ciwgJ3BheScpOwogIH07CiAgJCgnI3NfbWFrZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBhd2Fp' +
  'dCBhcGkoJy9zdGF0ZW1lbnRzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoCiAgICAgICAgeyBzZXJ2' +
  'ZXJfaWQ6ICQoJyNzX3NlcnZlcicpLnZhbHVlLCBzdGFydDogJCgnI3Nfc3RhcnQnKS52YWx1ZSwgZW5kOiAkKCcjc19lbmQnKS52' +
  'YWx1ZSB9KSB9KTsKICAgICAgdG9hc3QoJ1N0YXRlbWVudCBjcmVhdGVkJyk7IGdvKCdtb25leScpOwogICAgfSBjYXRjaCAoZSkg' +
  'eyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKICAkKCcjaV9wcmV2Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAg' +
  'IGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9pbnZvaWNlcy9wcmV2aWV3JywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJp' +
  'bmdpZnkoCiAgICAgIHsgY2xpZW50X2lkOiAkKCcjaV9jbGllbnQnKS52YWx1ZSwgc3RhcnQ6ICQoJyNpX3N0YXJ0JykudmFsdWUs' +
  'IGVuZDogJCgnI2lfZW5kJykudmFsdWUgfSkgfSk7CiAgICAkKCcjaV9vdXQnKS5pbm5lckhUTUwgPSBsaW5lc1RhYmxlKHIsICdm' +
  'ZWUnKTsKICB9OwogICQoJyNpX21ha2UnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAgICAgYXdhaXQgYXBp' +
  'KCcvaW52b2ljZXMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSgKICAgICAgICB7IGNsaWVudF9pZDog' +
  'JCgnI2lfY2xpZW50JykudmFsdWUsIHN0YXJ0OiAkKCcjaV9zdGFydCcpLnZhbHVlLCBlbmQ6ICQoJyNpX2VuZCcpLnZhbHVlIH0p' +
  'IH0pOwogICAgICB0b2FzdCgnSW52b2ljZSBjcmVhdGVkJyk7IGdvKCdtb25leScpOwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChl' +
  'Lm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1wYWlkXScpLmZvckVhY2go' +
  'YSA9PiBhLm9uY2xpY2sgPSBhc3luYyBlID0+IHsKICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgIGF3YWl0IGFwaSgnL3N0YXRl' +
  'bWVudHMvJyArIGEuZGF0YXNldC5wYWlkLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBzdGF0dXM6' +
  'ICdQYWlkJyB9KSB9KTsKICAgIHRvYXN0KCdNYXJrZWQgcGFpZCcpOyBnbygnbW9uZXknKTsKICB9KTsKICBkb2N1bWVudC5xdWVy' +
  'eVNlbGVjdG9yQWxsKCdbZGF0YS1pcGFpZF0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNrID0gYXN5bmMgZSA9PiB7CiAgICBlLnBy' +
  'ZXZlbnREZWZhdWx0KCk7CiAgICBhd2FpdCBhcGkoJy9pbnZvaWNlcy8nICsgYS5kYXRhc2V0LmlwYWlkLCB7IG1ldGhvZDogJ1BB' +
  'VENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBzdGF0dXM6ICdQYWlkJyB9KSB9KTsKICAgIHRvYXN0KCdNYXJrZWQgcGFpZCcp' +
  'OyBnbygnbW9uZXknKTsKICB9KTsKfQoKZnVuY3Rpb24gZmlyc3RPZk1vbnRoKCkgewogIGNvbnN0IGQgPSBuZXcgRGF0ZSgpOyBy' +
  'ZXR1cm4gbmV3IERhdGUoZC5nZXRGdWxsWWVhcigpLCBkLmdldE1vbnRoKCksIDEpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTAp' +
  'Owp9Cgphc3luYyBmdW5jdGlvbiBteVBheVZpZXcoKSB7CiAgY29uc3QgW3N0YXRlbWVudHMsIHN0YXRzXSA9IGF3YWl0IFByb21p' +
  'c2UuYWxsKFthcGkoJy9zdGF0ZW1lbnRzJyksIGFwaSgnL3N0YXRzJyldKTsKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAg' +
  'PGgxIGNsYXNzPSJwYWdlIj5NeSBwYXk8L2gxPgogICAgPGRpdiBjbGFzcz0ic3RhdHMiPgogICAgICA8ZGl2IGNsYXNzPSJzdGF0' +
  'IGdvb2QiPjxkaXYgY2xhc3M9Im4iPiR7bW9uZXkoc3RhdHMudW5iaWxsZWQpfTwvZGl2PjxkaXYgY2xhc3M9ImwiPkVhcm5lZCwg' +
  'bm90IHlldCBvbiBhIHN0YXRlbWVudDwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdGF0Ij48ZGl2IGNsYXNzPSJuIj4k' +
  'e3N0YXRzLnNlcnZlZF83ZH08L2Rpdj48ZGl2IGNsYXNzPSJsIj5TZXJ2ZXMgY29tcGxldGVkLCA3IGRheXM8L2Rpdj48L2Rpdj4K' +
  'ICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2FyZCI+PGgyPlN0YXRlbWVudHM8L2gyPgogICAgJHtzdGF0ZW1lbnRzLmxlbmd0' +
  'aCA/IGA8dGFibGUgY2xhc3M9InRibCI+CiAgICAgIDx0cj48dGg+UGVyaW9kPC90aD48dGggY2xhc3M9Im51bSI+Sm9iczwvdGg+' +
  'PHRoIGNsYXNzPSJudW0iPlRvdGFsPC90aD48dGg+PC90aD48dGg+PC90aD48L3RyPgogICAgICAke3N0YXRlbWVudHMubWFwKHMg' +
  'PT4gYDx0cj48dGQ+JHtmbXREYXRlT25seShzLnBlcmlvZF9zdGFydCl94oCTJHtmbXREYXRlT25seShzLnBlcmlvZF9lbmQpfTwv' +
  'dGQ+CiAgICAgICAgPHRkIGNsYXNzPSJudW0iPiR7cy5qb2JfY291bnR9PC90ZD48dGQgY2xhc3M9Im51bSI+JHttb25leShzLnRv' +
  'dGFsKX08L3RkPgogICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icGlsbCAke2NscyhzLnN0YXR1cyl9Ij4ke2VzYyhzLnN0YXR1cyl9' +
  'PC9zcGFuPjwvdGQ+CiAgICAgICAgPHRkIGNsYXNzPSJudW0iPjxhIGhyZWY9Ii9wcmludC9zdGF0ZW1lbnQvJHtzLmlkfSIgdGFy' +
  'Z2V0PSJfYmxhbmsiPnByaW50PC9hPjwvdGQ+PC90cj5gKS5qb2luKCcnKX0KICAgICAgPC90YWJsZT5gIDogJzxkaXYgY2xhc3M9' +
  'ImVtcHR5Ij5ObyBzdGF0ZW1lbnRzIHlldC48L2Rpdj4nfQogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj48aDI+Q2hh' +
  'bmdlIHBhc3N3b3JkPC9oMj4KICAgICAgPGRpdiBjbGFzcz0iaGludCI+VGhpcyBpcyB5b3VyIG9uZSBwYXNzd29yZCBmb3IgZXZl' +
  'cnkgYXBwLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGlucHV0IGlkPSJvcHciIHR5cGU9InBhc3N3b3JkIiBwbGFj' +
  'ZWhvbGRlcj0iQ3VycmVudCBwYXNzd29yZCI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48aW5wdXQgaWQ9Im5wdyIg' +
  'dHlwZT0icGFzc3dvcmQiIHBsYWNlaG9sZGVyPSJOZXcgcGFzc3dvcmQgKDgrIGNoYXJhY3RlcnMpIj48L2Rpdj4KICAgICAgPGJ1' +
  'dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0ic2F2ZVB3Ij5VcGRhdGU8L2J1dHRvbj48L2Rpdj5gKTsKICBiaW5kU2hlbGwoKTsKICAk' +
  'KCcjc2F2ZVB3Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9t' +
  'ZS9wYXNzd29yZCcsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsKICAgICAgICBwYXNzd29yZDogJCgn' +
  'I25wdycpLnZhbHVlLCBvbGRfcGFzc3dvcmQ6ICQoJyNvcHcnKS52YWx1ZSB9KSB9KTsKICAgICAgJCgnI29wdycpLnZhbHVlID0g' +
  'Jyc7ICQoJyNucHcnKS52YWx1ZSA9ICcnOwogICAgICB0b2FzdChyLmV2ZXJ5d2hlcmUgPT09IGZhbHNlID8gJ0NoYW5nZWQgaGVy' +
  'ZSDigJQgb3RoZXIgYXBwcyBzdGlsbCBoYXZlIHRoZSBvbGQgb25lJyA6ICdQYXNzd29yZCB1cGRhdGVkIGV2ZXJ5d2hlcmUnKTsK' +
  'ICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07Cn0KCgpmdW5jdGlvbiBjb2Rlc1RhYmxlKGxp' +
  'c3QpIHsKICBpZiAoIWxpc3QubGVuZ3RoKSByZXR1cm4gJzxkaXYgY2xhc3M9ImhpbnQiPk5vIGNvZGVzIHlldC48L2Rpdj4nOwog' +
  'IHJldHVybiBgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgPHRyPjx0aD5Db2RlPC90aD48dGg+R3JhbnRzPC90aD48dGg+VXNlZDwv' +
  'dGg+PHRoPjwvdGg+PHRoPjwvdGg+PC90cj4KICAgICR7bGlzdC5tYXAoYyA9PiBgPHRyPgogICAgICA8dGQ+PHNwYW4gc3R5bGU9' +
  'ImZvbnQ6NjAwIDEzcHggbW9ub3NwYWNlO2xldHRlci1zcGFjaW5nOi41cHgiPiR7ZXNjKGMuY29kZSl9PC9zcGFuPgogICAgICAg' +
  'ICR7Yy5ub3RlID8gYDxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKGMubm90ZSl9PC9kaXY+YCA6ICcnfQogICAgICAgICR7Yy5yZWRl' +
  'bXB0aW9ucyAmJiBjLnJlZGVtcHRpb25zLmxlbmd0aCA/IGA8ZGl2IGNsYXNzPSJoaW50Ij4ke2MucmVkZW1wdGlvbnMubWFwKHIg' +
  'PT4gZXNjKHIuZW1haWwpKS5qb2luKCcsICcpfTwvZGl2PmAgOiAnJ308L3RkPgogICAgICA8dGQ+JHtjLnJvbGUgPT09ICdhZG1p' +
  'bicgPyAnQWRtaW4nIDogJ0ZpZWxkIHNlcnZlcid9CiAgICAgICAgJHtjLmV4cGlyZXNfYXQgPyBgPGRpdiBjbGFzcz0iaGludCI+' +
  'dG8gJHtmbXREYXRlT25seShjLmV4cGlyZXNfYXQpfTwvZGl2PmAgOiAnJ308L3RkPgogICAgICA8dGQ+JHtjLnVzZWRfY291bnR9' +
  'LyR7Yy5tYXhfdXNlc308L3RkPgogICAgICA8dGQ+PHNwYW4gY2xhc3M9InBpbGwgJHtjLnN0YXRlID09PSAnQWN0aXZlJyA/ICdT' +
  'ZXJ2ZWQnIDogJyd9Ij4ke2VzYyhjLnN0YXRlKX08L3NwYW4+PC90ZD4KICAgICAgPHRkIGNsYXNzPSJudW0iPgogICAgICAgIDxh' +
  'IGhyZWY9IiMiIGRhdGEtY29weT0iJHtlc2MoYy5jb2RlKX0iPmNvcHk8L2E+CiAgICAgICAgJHtjLnN0YXRlID09PSAnQWN0aXZl' +
  'JyA/IGAgwrcgPGEgaHJlZj0iIyIgZGF0YS1yZXZva2U9IiR7Yy5pZH0iPnJldm9rZTwvYT5gIDogJyd9CiAgICAgIDwvdGQ+PC90' +
  'cj5gKS5qb2luKCcnKX08L3RhYmxlPmA7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tIGFkbWluIC0tICovCmFzeW5jIGZ1bmN0aW9uIGFkbWluVmlldygpIHsKICAvLyBGZXRjaCBldmVy' +
  'eXRoaW5nIGJlZm9yZSBkcmF3aW5nLiBQb3B1bGF0aW5nIGNhcmRzIGFmdGVyIHJlbmRlciBtYWRlIHRoZQogIC8vIHBhZ2UgZ3Jv' +
  'dyB1bmRlciB0aGUgdXNlcidzIGZpbmdlciwgc28gYSB0YXAgY291bGQgbGFuZCBvbiB0aGUgd3Jvbmcgcm93LgogIGNvbnN0IFt1' +
  'c2VycywgY2xpZW50cywgdGVtcGxhdGVzLCBjb2RlcywgcG9ydGFsc10gPSBhd2FpdCBQcm9taXNlLmFsbChbCiAgICBhcGkoJy91' +
  'c2VycycpLCBhcGkoJy9jbGllbnRzJyksIGFwaSgnL3RlbXBsYXRlcycpLAogICAgYXBpKCcvY29kZXMnKS5jYXRjaCgoKSA9PiBb' +
  'XSksIGFwaSgnL3BvcnRhbHMnKS5jYXRjaCgoKSA9PiBbXSkKICBdKTsKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgx' +
  'IGNsYXNzPSJwYWdlIj5TZXR1cDwvaDE+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5UZWFtIDxzcGFuIGNsYXNz' +
  'PSJzdWIiPiR7dXNlcnMubGVuZ3RofTwvc3Bhbj48L2gyPgogICAgICA8dGFibGUgY2xhc3M9InRibCI+CiAgICAgICAgPHRyPjx0' +
  'aD5OYW1lPC90aD48dGg+Um9sZTwvdGg+PHRoIGNsYXNzPSJudW0iPlJhdGU8L3RoPjx0aD48L3RoPjwvdHI+CiAgICAgICAgJHt1' +
  'c2Vycy5tYXAodSA9PiBgPHRyPjx0ZD4ke2VzYyh1Lm5hbWUpfTxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKHUuZW1haWwpfTwvZGl2' +
  'PjwvdGQ+CiAgICAgICAgICA8dGQ+JHtlc2ModS5yb2xlKX0ke3UuYWN0aXZlID8gJycgOiAnIDxzcGFuIGNsYXNzPSJwaWxsIj5v' +
  'ZmY8L3NwYW4+J308L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPiR7bW9uZXkodS5kZWZhdWx0X3BheSl9PC90ZD4KICAg' +
  'ICAgICAgIDx0ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIjIiBkYXRhLXVzZXI9IiR7dS5pZH0iPmVkaXQ8L2E+PC90ZD48L3RyPmAp' +
  'LmpvaW4oJycpfQogICAgICA8L3RhYmxlPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIGJsb2NrIHNtIiBpZD0ibmV3VXNl' +
  'ciIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+KyBBZGQgcGVyc29uPC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNz' +
  'PSJjYXJkIj4KICAgICAgPGgyPkNsaWVudHMgPHNwYW4gY2xhc3M9InN1YiI+JHtjbGllbnRzLmxlbmd0aH08L3NwYW4+PC9oMj4K' +
  'ICAgICAgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgICAgIDx0cj48dGg+TmFtZTwvdGg+PHRoIGNsYXNzPSJudW0iPkRlZmF1bHQg' +
  'ZmVlPC90aD48dGg+PC90aD48L3RyPgogICAgICAgICR7Y2xpZW50cy5tYXAoYyA9PiBgPHRyPjx0ZD4ke2VzYyhjLm5hbWUpfTxk' +
  'aXYgY2xhc3M9ImhpbnQiPiR7ZXNjKGMuY29udGFjdF9uYW1lIHx8ICcnKX0gJHtlc2MoYy5waG9uZSB8fCAnJyl9PC9kaXY+PC90' +
  'ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KGMuZGVmYXVsdF9mZWUpfTwvdGQ+CiAgICAgICAgICA8dGQgY2xh' +
  'c3M9Im51bSI+PGEgaHJlZj0iIyIgZGF0YS1jbGllbnQ9IiR7Yy5pZH0iPmVkaXQ8L2E+PC90ZD48L3RyPmApLmpvaW4oJycpfQog' +
  'ICAgICA8L3RhYmxlPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIGJsb2NrIHNtIiBpZD0ibmV3Q2xpZW50IiBzdHlsZT0i' +
  'bWFyZ2luLXRvcDoxMHB4Ij4rIEFkZCBjbGllbnQ8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgog' +
  'ICAgICA8aDI+QWZmaWRhdml0IHRlbXBsYXRlcyA8c3BhbiBjbGFzcz0ic3ViIj4ke3RlbXBsYXRlcy5sZW5ndGh9PC9zcGFuPjwv' +
  'aDI+CiAgICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDotNHB4Ij5Xcml0ZSB5b3VyIG93biB3b3JkaW5nIHBl' +
  'ciBjb3VudHkgb3IgY2xpZW50LiBNZXJnZSBmaWVsZHMgZmlsbCBpbiBmcm9tIHRoZSBqb2IsCiAgICAgIGluY2x1ZGluZyB0aGUg' +
  'ZnVsbCBhdHRlbXB0IGxvZyB3aXRoIEdQUy48L3A+CiAgICAgIDx0YWJsZSBjbGFzcz0idGJsIj4KICAgICAgICAke3RlbXBsYXRl' +
  'cy5tYXAodCA9PiBgPHRyPjx0ZD4ke2VzYyh0Lm5hbWUpfTxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKHQuanVyaXNkaWN0aW9uIHx8' +
  'ICcnKX08L2Rpdj48L3RkPgogICAgICAgICAgPHRkPiR7dC5pc19kZWZhdWx0ID8gJzxzcGFuIGNsYXNzPSJwaWxsIFNlcnZlZCI+' +
  'ZGVmYXVsdDwvc3Bhbj4nIDogJyd9PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIjIiBkYXRhLXRwbD0i' +
  'JHt0LmlkfSI+ZWRpdDwvYT48L3RkPjwvdHI+YCkuam9pbignJyl9CiAgICAgIDwvdGFibGU+CiAgICAgIDxidXR0b24gY2xhc3M9' +
  'ImJ0biBzZWMgYmxvY2sgc20iIGlkPSJuZXdUcGwiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPisgTmV3IHRlbXBsYXRlPC9idXR0' +
  'b24+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkFjY2VzcyBjb2RlcyA8c3BhbiBjbGFzcz0i' +
  'c3ViIj5sZXQgcGVvcGxlIHNldCB1cCB0aGVpciBvd24gYWNjb3VudDwvc3Bhbj48L2gyPgogICAgICA8cCBjbGFzcz0iaGludCIg' +
  'c3R5bGU9Im1hcmdpbi10b3A6LTRweCI+R2VuZXJhdGUgYSBjb2RlIGFuZCBzZW5kIGl0IG92ZXIuIFRoZXkgZW50ZXIgaXQgb24g' +
  'dGhlIHNpZ24taW4KICAgICAgICBzY3JlZW4gdW5kZXIgIlNldCB1cCB5b3VyIGFjY291bnQiLCBwaWNrIHRoZWlyIG93biBwYXNz' +
  'd29yZCwgYW5kIHRoZXkncmUgaW4g4oCUIG5vIG5lZWQgdG8ga2V5IGluCiAgICAgICAgdGhlaXIgZGV0YWlscyBvciBzaGFyZSBh' +
  'IHBhc3N3b3JkIHdpdGggdGhlbS48L3A+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzMiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgi' +
  'PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+VGhleSBiZWNvbWU8L2xhYmVsPjxzZWxlY3QgaWQ9ImNfcm9sZSI+' +
  'CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJzZXJ2ZXIiPkZpZWxkIHNlcnZlcjwvb3B0aW9uPjxvcHRpb24gdmFsdWU9ImFkbWlu' +
  'Ij5BZG1pbjwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+SG93IG1hbnkg' +
  'Y2FuIHVzZSBpdDwvbGFiZWw+PGlucHV0IGlkPSJjX3VzZXMiIHR5cGU9Im51bWJlciIgbWluPSIxIiBtYXg9IjUwMCIgdmFsdWU9' +
  'IjEiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RXhwaXJlcyAob3B0aW9uYWwpPC9sYWJlbD48aW5w' +
  'dXQgaWQ9ImNfZXhwIiB0eXBlPSJkYXRlIj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgog' +
  'ICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGF5IHBlciBzZXJ2ZSAoZmllbGQgc2VydmVycyk8L2xhYmVsPjxpbnB1' +
  'dCBpZD0iY19wYXkiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgcGxhY2Vob2xkZXI9IjQ1LjAwIj48L2Rpdj4KICAgICAgICA8' +
  'ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk5vdGUgdG8geW91cnNlbGY8L2xhYmVsPjxpbnB1dCBpZD0iY19ub3RlIiBwbGFjZWhv' +
  'bGRlcj0iRm9yIE1hcmlhIOKAlCBldmljdGlvbnMiPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRu' +
  'IHNtIiBpZD0iY19tYWtlIj5HZW5lcmF0ZSBhIGNvZGU8L2J1dHRvbj4KICAgICAgPGRpdiBpZD0iY19saXN0IiBzdHlsZT0ibWFy' +
  'Z2luLXRvcDoxMnB4Ij4ke2NvZGVzVGFibGUoY29kZXMpfTwvZGl2PgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+' +
  'CiAgICAgIDxoMj5Db3VydCBwb3J0YWwgcHJvYmUgPHNwYW4gY2xhc3M9InN1YiI+ZXhwZXJpbWVudGFsPC9zcGFuPjwvaDI+CiAg' +
  'ICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDotNHB4Ij5Bc2tzIHRoZSBzZXJ2ZXIgdG8gZmV0Y2ggYSBjb3Vu' +
  'dHkgcG9ydGFsIGFuZCByZXBvcnQgd2hhdCBjYW1lIGJhY2sg4oCUCiAgICAgICAgc3RhdHVzLCBjb29raWVzLCBmb3JtcywgbGlu' +
  'a3MuIFRoaXMgaXMgdGhlIGdyb3VuZHdvcmsgZm9yIGF1dG9tYXRpYyBjYXNlIGxvb2t1cDogdGhlc2UgcG9ydGFscyBjYW4ndCBi' +
  'ZQogICAgICAgIHJlYWNoZWQgZnJvbSB3aGVyZSB0aGlzIGFwcCB3YXMgd3JpdHRlbiwgc28gdGhlIHNlcnZlciBoYXMgdG8gZ28g' +
  'YW5kIGxvb2suIFJ1biBvbmUgYW5kIHNlbmQgbWUgdGhlIHJlc3VsdC48L3A+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgaWQ9InBy' +
  'b2JlQnRucyIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+JHtwb3J0YWxzLm1hcChwdCA9PgogICAgICAgIGA8YnV0dG9uIGNsYXNz' +
  'PSJidG4gc2VjIHNtIiBkYXRhLXByb2JlPSIke2VzYyhwdC5rZXkpfSI+JHtlc2MocHQubGFiZWwpfTwvYnV0dG9uPmApLmpvaW4o' +
  'JycpfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxpbnB1dCBp' +
  'ZD0icHJvYmVVcmwiIHBsYWNlaG9sZGVyPSLigKZvciBhIHNwZWNpZmljIHBhZ2UgVVJMIiBzdHlsZT0iZmxleDoxO21pbi13aWR0' +
  'aDoxNTBweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9InByb2JlR28iPlByb2JlIFVSTDwvYnV0dG9u' +
  'PgogICAgICA8L2Rpdj4KICAgICAgPHByZSBjbGFzcz0icHJldiIgaWQ9InByb2JlT3V0IiBzdHlsZT0iZGlzcGxheTpub25lO21h' +
  'cmdpbi10b3A6MTBweCI+PC9wcmU+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20gYmxvY2siIGlkPSJjb3B5UHJvYmUi' +
  'IHN0eWxlPSJkaXNwbGF5Om5vbmU7bWFyZ2luLXRvcDo4cHgiPkNvcHkgcmVzdWx0PC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8' +
  'ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPk15IGFjY291bnQ8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJoaW50Ij5PbmUgcGFz' +
  'c3dvcmQsIGV2ZXJ5IGFwcC4gQ2hhbmdpbmcgaXQgaGVyZSBjaGFuZ2VzIGl0IGV2ZXJ5d2hlcmUuPC9kaXY+CiAgICAgIDxkaXYg' +
  'Y2xhc3M9ImZpZWxkIj48bGFiZWw+Q3VycmVudCBwYXNzd29yZDwvbGFiZWw+PGlucHV0IGlkPSJvcHciIHR5cGU9InBhc3N3b3Jk' +
  'IiBwbGFjZWhvbGRlcj0idGhlIG9uZSB5b3Ugc2lnbmVkIGluIHdpdGgiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+' +
  'PGxhYmVsPk5ldyBwYXNzd29yZDwvbGFiZWw+PGlucHV0IGlkPSJucHciIHR5cGU9InBhc3N3b3JkIiBwbGFjZWhvbGRlcj0iOCsg' +
  'Y2hhcmFjdGVycyI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9InNhdmVQdyI+VXBkYXRlIHBhc3N3b3Jk' +
  'PC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIGlkPSJidWlsZFN0YW1wIiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij5i' +
  'dWlsZCDigKY8L2Rpdj4KICAgIDwvZGl2PmApOwogIGJpbmRTaGVsbCgpOwoKICBmZXRjaCgnL2FwaS9idWlsZCcpLnRoZW4ociA9' +
  'PiByLmpzb24oKSkudGhlbihiID0+IHsKICAgIGNvbnN0IGVsID0gJCgnI2J1aWxkU3RhbXAnKTsKICAgIGlmIChlbCkgZWwudGV4' +
  'dENvbnRlbnQgPSAnU2VydmVUcmFjayBidWlsZCAnICsgYi5idWlsZCArIChiLnByb2JlVGFyZ2V0cyA/ICcgwrcgYm9vdCBwcm9i' +
  'ZSBhcm1lZCcgOiAnJyk7CiAgfSkuY2F0Y2goKCkgPT4ge30pOwoKCiAgLyogLS0tLSBhY2Nlc3MgY29kZXMgLS0tLSAqLwogIGFz' +
  'eW5jIGZ1bmN0aW9uIGRyYXdDb2RlcygpIHsKICAgICQoJyNjX2xpc3QnKS5pbm5lckhUTUwgPSBjb2Rlc1RhYmxlKGF3YWl0IGFw' +
  'aSgnL2NvZGVzJykpOwogICAgd2lyZUNvZGVzKCk7CiAgfQoKICBmdW5jdGlvbiB3aXJlQ29kZXMoKSB7CiAgICBkb2N1bWVudC5x' +
  'dWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1jb3B5XScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sgPSBhc3luYyBlID0+IHsKICAgICAg' +
  'ZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICB0cnkgeyBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dChhLmRhdGFz' +
  'ZXQuY29weSk7IHRvYXN0KCdDb3BpZWQgJyArIGEuZGF0YXNldC5jb3B5KTsgfQogICAgICBjYXRjaCAoZXJyKSB7IHRvYXN0KCdT' +
  'ZWxlY3QgaXQgYW5kIGNvcHkgYnkgaGFuZCcsIHRydWUpOyB9CiAgICB9KTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwo' +
  'J1tkYXRhLXJldm9rZV0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNrID0gYXN5bmMgZSA9PiB7CiAgICAgIGUucHJldmVudERlZmF1' +
  'bHQoKTsKICAgICAgaWYgKCFjb25maXJtKCdSZXZva2UgdGhpcyBjb2RlPyBBbnlvbmUgd2hvIGFscmVhZHkgdXNlZCBpdCBrZWVw' +
  'cyB0aGVpciBhY2NvdW50LicpKSByZXR1cm47CiAgICAgIGF3YWl0IGFwaSgnL2NvZGVzLycgKyBhLmRhdGFzZXQucmV2b2tlLCB7' +
  'IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyByZXZva2VkOiB0cnVlIH0pIH0pOwogICAgICB0b2FzdCgn' +
  'UmV2b2tlZCcpOyBkcmF3Q29kZXMoKTsKICAgIH0pOwogIH0KICB3aXJlQ29kZXMoKTsKCiAgJCgnI2NfbWFrZScpLm9uY2xpY2sg' +
  'PSBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBjb25zdCBtYWRlID0gYXdhaXQgYXBpKCcvY29kZXMnLCB7IG1ldGhvZDog' +
  'J1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgcm9sZTogJCgnI2Nfcm9sZScpLnZhbHVlLAogICAgICAgIG1h' +
  'eF91c2VzOiAkKCcjY191c2VzJykudmFsdWUsCiAgICAgICAgZXhwaXJlc19hdDogJCgnI2NfZXhwJykudmFsdWUgfHwgbnVsbCwK' +
  'ICAgICAgICBkZWZhdWx0X3BheTogJCgnI2NfcGF5JykudmFsdWUgfHwgMCwKICAgICAgICBub3RlOiAkKCcjY19ub3RlJykudmFs' +
  'dWUKICAgICAgfSkgfSk7CiAgICAgICQoJyNjX25vdGUnKS52YWx1ZSA9ICcnOwogICAgICB0b2FzdCgnQ29kZSAnICsgbWFkZS5j' +
  'b2RlKTsKICAgICAgZHJhd0NvZGVzKCk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9Owog' +
  'IGRyYXdDb2RlcygpLmNhdGNoKCgpID0+IHt9KTsKCiAgLyogLS0tLSBwb3J0YWwgcHJvYmUgLS0tLSAqLwogIGNvbnN0IHByb2Jl' +
  'T3V0ID0gJCgnI3Byb2JlT3V0Jyk7CiAgY29uc3QgcnVuUHJvYmUgPSBhc3luYyBib2R5ID0+IHsKICAgIHByb2JlT3V0LnN0eWxl' +
  'LmRpc3BsYXkgPSAnJzsKICAgIHByb2JlT3V0LnRleHRDb250ZW50ID0gJ1Byb2JpbmfigKYgKHRoaXMgY2FuIHRha2UgdXAgdG8g' +
  'MjAgc2Vjb25kcyknOwogICAgJCgnI2NvcHlQcm9iZScpLnN0eWxlLmRpc3BsYXkgPSAnJzsKICAgIHRyeSB7CiAgICAgIGNvbnN0' +
  'IHIgPSBhd2FpdCBhcGkoJy9wb3J0YWwtcHJvYmUnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5' +
  'KSB9KTsKICAgICAgcHJvYmVPdXQudGV4dENvbnRlbnQgPSBKU09OLnN0cmluZ2lmeShyLCBudWxsLCAyKTsKICAgIH0gY2F0Y2gg' +
  'KGUpIHsKICAgICAgcHJvYmVPdXQudGV4dENvbnRlbnQgPSAnUHJvYmUgZmFpbGVkOiAnICsgZS5tZXNzYWdlOwogICAgfQogIH07' +
  'CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcHJvYmVdJykuZm9yRWFjaChiID0+CiAgICBiLm9uY2xpY2sgPSAo' +
  'KSA9PiBydW5Qcm9iZSh7IHBvcnRhbDogYi5kYXRhc2V0LnByb2JlIH0pKTsKICAkKCcjcHJvYmVHbycpLm9uY2xpY2sgPSAoKSA9' +
  'PiB7CiAgICBjb25zdCB1ID0gJCgnI3Byb2JlVXJsJykudmFsdWUudHJpbSgpOwogICAgaWYgKHUpIHJ1blByb2JlKHsgdXJsOiB1' +
  'IH0pOwogIH07CiAgJCgnI2NvcHlQcm9iZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgeyBhd2FpdCBuYXZpZ2F0' +
  'b3IuY2xpcGJvYXJkLndyaXRlVGV4dChwcm9iZU91dC50ZXh0Q29udGVudCk7IHRvYXN0KCdDb3BpZWQnKTsgfQogICAgY2F0Y2gg' +
  'KGUpIHsgdG9hc3QoJ1NlbGVjdCB0aGUgdGV4dCBhbmQgY29weSBpdCBieSBoYW5kJywgdHJ1ZSk7IH0KICB9OwoKICBkb2N1bWVu' +
  'dC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS11c2VyXScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sgPSBlID0+IHsKICAgIGUucHJl' +
  'dmVudERlZmF1bHQoKTsgdXNlckZvcm0odXNlcnMuZmluZCh1ID0+IFN0cmluZyh1LmlkKSA9PT0gYS5kYXRhc2V0LnVzZXIpKTsK' +
  'ICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1jbGllbnRdJykuZm9yRWFjaChhID0+IGEub25jbGljayA9' +
  'IGUgPT4gewogICAgZS5wcmV2ZW50RGVmYXVsdCgpOyBjbGllbnRGb3JtKGNsaWVudHMuZmluZChjID0+IFN0cmluZyhjLmlkKSA9' +
  'PT0gYS5kYXRhc2V0LmNsaWVudCkpOwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXRwbF0nKS5mb3JF' +
  'YWNoKGEgPT4gYS5vbmNsaWNrID0gZSA9PiB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7IHRlbXBsYXRlRm9ybSh0ZW1wbGF0ZXMu' +
  'ZmluZCh0ID0+IFN0cmluZyh0LmlkKSA9PT0gYS5kYXRhc2V0LnRwbCkpOwogIH0pOwogICQoJyNuZXdVc2VyJykub25jbGljayA9' +
  'ICgpID0+IHVzZXJGb3JtKG51bGwpOwogICQoJyNuZXdDbGllbnQnKS5vbmNsaWNrID0gKCkgPT4gY2xpZW50Rm9ybShudWxsKTsK' +
  'ICAkKCcjbmV3VHBsJykub25jbGljayA9ICgpID0+IHRlbXBsYXRlRm9ybShudWxsKTsKICAkKCcjc2F2ZVB3Jykub25jbGljayA9' +
  'IGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9tZS9wYXNzd29yZCcsIHsgbWV0aG9k' +
  'OiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsKICAgICAgICBwYXNzd29yZDogJCgnI25wdycpLnZhbHVlLCBvbGRfcGFz' +
  'c3dvcmQ6ICQoJyNvcHcnKS52YWx1ZSB9KSB9KTsKICAgICAgJCgnI29wdycpLnZhbHVlID0gJyc7ICQoJyNucHcnKS52YWx1ZSA9' +
  'ICcnOwogICAgICB0b2FzdChyLmV2ZXJ5d2hlcmUgPT09IGZhbHNlID8gJ0NoYW5nZWQgaGVyZSDigJQgb3RoZXIgYXBwcyBzdGls' +
  'bCBoYXZlIHRoZSBvbGQgb25lJyA6ICdQYXNzd29yZCB1cGRhdGVkIGV2ZXJ5d2hlcmUnKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9h' +
  'c3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07Cn0KCmZ1bmN0aW9uIHVzZXJGb3JtKHUpIHsKICBjb25zdCB2ID0gdSB8fCB7IHJv' +
  'bGU6ICdzZXJ2ZXInLCBhY3RpdmU6IHRydWUgfTsKICBzaGVldCh1ID8gJ0VkaXQgJyArIHUubmFtZSA6ICdBZGQgcGVyc29uJywg' +
  'YAogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5OYW1lPC9sYWJlbD48aW5wdXQgaWQ9InVfbmFtZSIgdmFsdWU9IiR7ZXNj' +
  'KHYubmFtZSl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RW1haWwgKHVzZWQgdG8gc2lnbiBpbik8L2xh' +
  'YmVsPjxpbnB1dCBpZD0idV9lbWFpbCIgdHlwZT0iZW1haWwiIHZhbHVlPSIke2VzYyh2LmVtYWlsKX0iPjwvZGl2PgogICAgPGRp' +
  'diBjbGFzcz0iZmllbGQiPjxsYWJlbD4ke3UgPyAnTmV3IHBhc3N3b3JkIChsZWF2ZSBibGFuayB0byBrZWVwKScgOiAnUGFzc3dv' +
  'cmQnfTwvbGFiZWw+PGlucHV0IGlkPSJ1X3Bhc3N3b3JkIiB0eXBlPSJ0ZXh0IiBwbGFjZWhvbGRlcj0iJHt1ID8gJ3VuY2hhbmdl' +
  'ZCcgOiAnc2V0IGEgcGFzc3dvcmQnfSI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgPGRpdiBjbGFzcz0i' +
  'ZmllbGQiPjxsYWJlbD5Sb2xlPC9sYWJlbD48c2VsZWN0IGlkPSJ1X3JvbGUiPgogICAgICAgIDxvcHRpb24gdmFsdWU9InNlcnZl' +
  'ciIgJHt2LnJvbGUgPT09ICdzZXJ2ZXInID8gJ3NlbGVjdGVkJyA6ICcnfT5GaWVsZCBzZXJ2ZXI8L29wdGlvbj4KICAgICAgICA8' +
  'b3B0aW9uIHZhbHVlPSJhZG1pbiIgJHt2LnJvbGUgPT09ICdhZG1pbicgPyAnc2VsZWN0ZWQnIDogJyd9PkFkbWluPC9vcHRpb24+' +
  'PC9zZWxlY3Q+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RGVmYXVsdCBwYXkgcGVyIHNlcnZlPC9sYWJl' +
  'bD48aW5wdXQgaWQ9InVfZGVmYXVsdF9wYXkiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgdmFsdWU9IiR7di5kZWZhdWx0X3Bh' +
  'eSB8fCAnJ30iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBob25lPC9sYWJlbD48aW5wdXQgaWQ9InVf' +
  'cGhvbmUiIHZhbHVlPSIke2VzYyh2LnBob25lKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkxpY2Vu' +
  'c2UgLyByZWdpc3RyYXRpb24gIzwvbGFiZWw+PGlucHV0IGlkPSJ1X2xpY2Vuc2Vfbm8iIHZhbHVlPSIke2VzYyh2LmxpY2Vuc2Vf' +
  'bm8pfSI+PC9kaXY+CiAgICA8L2Rpdj4KICAgICR7dSA/IGA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlN0YXR1czwvbGFiZWw+' +
  'PHNlbGVjdCBpZD0idV9hY3RpdmUiPgogICAgICA8b3B0aW9uIHZhbHVlPSJ0cnVlIiAke3YuYWN0aXZlID8gJ3NlbGVjdGVkJyA6' +
  'ICcnfT5BY3RpdmU8L29wdGlvbj4KICAgICAgPG9wdGlvbiB2YWx1ZT0iZmFsc2UiICR7IXYuYWN0aXZlID8gJ3NlbGVjdGVkJyA6' +
  'ICcnfT5EZWFjdGl2YXRlZDwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2PmAgOiAnJ30KICAgIDxkaXYgY2xhc3M9InJvdyI+PGJ1dHRv' +
  'biBjbGFzcz0iYnRuIiBpZD0ic2F2ZSI+U2F2ZTwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25jbGljaz0i' +
  'Y2xvc2VTaGVldCgpIj5DYW5jZWw8L2J1dHRvbj48L2Rpdj5gLCBlbCA9PiB7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZScp' +
  'Lm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IGJvZHkgPSB7CiAgICAgICAgbmFtZTogZWwucXVlcnlTZWxlY3Rv' +
  'cignI3VfbmFtZScpLnZhbHVlLCBlbWFpbDogZWwucXVlcnlTZWxlY3RvcignI3VfZW1haWwnKS52YWx1ZSwKICAgICAgICByb2xl' +
  'OiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9yb2xlJykudmFsdWUsIHBob25lOiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9waG9uZScpLnZh' +
  'bHVlLAogICAgICAgIGxpY2Vuc2Vfbm86IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X2xpY2Vuc2Vfbm8nKS52YWx1ZSwKICAgICAgICBk' +
  'ZWZhdWx0X3BheTogZWwucXVlcnlTZWxlY3RvcignI3VfZGVmYXVsdF9wYXknKS52YWx1ZSB8fCAwCiAgICAgIH07CiAgICAgIGNv' +
  'bnN0IHB3ID0gZWwucXVlcnlTZWxlY3RvcignI3VfcGFzc3dvcmQnKS52YWx1ZTsKICAgICAgaWYgKHB3KSBib2R5LnBhc3N3b3Jk' +
  'ID0gcHc7CiAgICAgIGlmICh1KSBib2R5LmFjdGl2ZSA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X2FjdGl2ZScpLnZhbHVlID09PSAn' +
  'dHJ1ZSc7CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgKHUgPyBhcGkoJy91c2Vycy8nICsgdS5pZCwgeyBtZXRob2Q6ICdQQVRD' +
  'SCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pCiAgICAgICAgICAgICAgICAgOiBhcGkoJy91c2VycycsIHsgbWV0aG9k' +
  'OiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pKTsKICAgICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KCdTYXZl' +
  'ZCcpOyBnbygnYWRtaW4nKTsKICAgICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgICB9OwogIH0p' +
  'Owp9CgpmdW5jdGlvbiBjbGllbnRGb3JtKGMpIHsKICBjb25zdCB2ID0gYyB8fCB7fTsKICBzaGVldChjID8gJ0VkaXQgJyArIGMu' +
  'bmFtZSA6ICdBZGQgY2xpZW50JywgYAogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5GaXJtIC8gY2xpZW50IG5hbWU8L2xh' +
  'YmVsPjxpbnB1dCBpZD0iY19uYW1lIiB2YWx1ZT0iJHtlc2Modi5uYW1lKX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZCBn' +
  'MiI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q29udGFjdDwvbGFiZWw+PGlucHV0IGlkPSJjX2NvbnRhY3RfbmFt' +
  'ZSIgdmFsdWU9IiR7ZXNjKHYuY29udGFjdF9uYW1lKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBo' +
  'b25lPC9sYWJlbD48aW5wdXQgaWQ9ImNfcGhvbmUiIHZhbHVlPSIke2VzYyh2LnBob25lKX0iPjwvZGl2PgogICAgICA8ZGl2IGNs' +
  'YXNzPSJmaWVsZCI+PGxhYmVsPkVtYWlsPC9sYWJlbD48aW5wdXQgaWQ9ImNfZW1haWwiIHR5cGU9ImVtYWlsIiB2YWx1ZT0iJHtl' +
  'c2Modi5lbWFpbCl9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5EZWZhdWx0IGZlZSBwZXIgc2VydmU8' +
  'L2xhYmVsPjxpbnB1dCBpZD0iY19kZWZhdWx0X2ZlZSIgdHlwZT0ibnVtYmVyIiBzdGVwPSIwLjAxIiB2YWx1ZT0iJHt2LmRlZmF1' +
  'bHRfZmVlIHx8ICcnfSI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+QmlsbGluZyBhZGRy' +
  'ZXNzPC9sYWJlbD48dGV4dGFyZWEgaWQ9ImNfYWRkcmVzcyIgc3R5bGU9Im1pbi1oZWlnaHQ6NjBweCI+JHtlc2Modi5hZGRyZXNz' +
  'KX08L3RleHRhcmVhPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Ob3RlczwvbGFiZWw+PHRleHRhcmVhIGlk' +
  'PSJjX25vdGVzIiBzdHlsZT0ibWluLWhlaWdodDo2MHB4Ij4ke2VzYyh2Lm5vdGVzKX08L3RleHRhcmVhPjwvZGl2PgogICAgPGRp' +
  'diBjbGFzcz0icm93Ij48YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJzYXZlIj5TYXZlPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNz' +
  'PSJidG4gc2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNhbmNlbDwvYnV0dG9uPjwvZGl2PmAsIGVsID0+IHsKICAgIGVsLnF1' +
  'ZXJ5U2VsZWN0b3IoJyNzYXZlJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgYm9keSA9IHt9OwogICAgICBb' +
  'J25hbWUnLCdjb250YWN0X25hbWUnLCdwaG9uZScsJ2VtYWlsJywnZGVmYXVsdF9mZWUnLCdhZGRyZXNzJywnbm90ZXMnXQogICAg' +
  'ICAgIC5mb3JFYWNoKGYgPT4gYm9keVtmXSA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNjXycgKyBmKS52YWx1ZSk7CiAgICAgIHRyeSB7' +
  'CiAgICAgICAgYXdhaXQgKGMgPyBhcGkoJy9jbGllbnRzLycgKyBjLmlkLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5z' +
  'dHJpbmdpZnkoYm9keSkgfSkKICAgICAgICAgICAgICAgICA6IGFwaSgnL2NsaWVudHMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5' +
  'OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KSk7CiAgICAgICAgY2xvc2VTaGVldCgpOyB0b2FzdCgnU2F2ZWQnKTsgZ28oJ2FkbWlu' +
  'Jyk7CiAgICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogICAgfTsKICB9KTsKfQoKYXN5bmMgZnVu' +
  'Y3Rpb24gdGVtcGxhdGVGb3JtKHQpIHsKICBjb25zdCBmaWVsZHMgPSBhd2FpdCBhcGkoJy90ZW1wbGF0ZS1maWVsZHMnKTsKICBj' +
  'b25zdCB2ID0gdCB8fCB7IGJvZHk6ICcnLCBpc19kZWZhdWx0OiBmYWxzZSB9OwogIHNoZWV0KHQgPyAnRWRpdCB0ZW1wbGF0ZScg' +
  'OiAnTmV3IGFmZmlkYXZpdCB0ZW1wbGF0ZScsIGAKICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICA8ZGl2IGNsYXNzPSJm' +
  'aWVsZCI+PGxhYmVsPlRlbXBsYXRlIG5hbWU8L2xhYmVsPjxpbnB1dCBpZD0idF9uYW1lIiB2YWx1ZT0iJHtlc2Modi5uYW1lKX0i' +
  'PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkp1cmlzZGljdGlvbiAvIGNvdXJ0PC9sYWJlbD48aW5wdXQg' +
  'aWQ9InRfanVyaXNkaWN0aW9uIiB2YWx1ZT0iJHtlc2Modi5qdXJpc2RpY3Rpb24pfSI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxk' +
  'aXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Qm9keTwvbGFiZWw+CiAgICAgIDx0ZXh0YXJlYSBpZD0idF9ib2R5IiBzdHlsZT0ibWlu' +
  'LWhlaWdodDoyMjBweDtmb250OjEyLjVweC8xLjUgJ0NvdXJpZXIgTmV3Jyxtb25vc3BhY2UiPiR7ZXNjKHYuYm9keSl9PC90ZXh0' +
  'YXJlYT4KICAgICAgPGRpdiBjbGFzcz0iaGludCI+Q2xpY2sgYSBmaWVsZCB0byBpbnNlcnQgaXQgYXQgdGhlIGN1cnNvcjo8L2Rp' +
  'dj4KICAgICAgPGRpdiBjbGFzcz0idG9rZW5zIj4ke2ZpZWxkcy5tYXAoZiA9PiBgPGJ1dHRvbiBkYXRhLWY9IiR7ZlswXX0iIHRp' +
  'dGxlPSIke2VzYyhmWzFdKX0iPnt7JHtmWzBdfX19PC9idXR0b24+YCkuam9pbignJyl9PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxs' +
  'YWJlbCBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6OHB4Ij48aW5wdXQgdHlwZT0iY2hlY2tib3gi' +
  'IGlkPSJ0X2RlZmF1bHQiIHN0eWxlPSJ3aWR0aDphdXRvIiAke3YuaXNfZGVmYXVsdCA/ICdjaGVja2VkJyA6ICcnfT4gVXNlIGFz' +
  'IHRoZSBkZWZhdWx0IHRlbXBsYXRlPC9sYWJlbD4KICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+' +
  'CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InNhdmUiPlNhdmU8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRu' +
  'IHNlYyIgaWQ9InByZXZpZXciPlByZXZpZXcgd2l0aCByZWFsIGpvYjwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4g' +
  'c2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNhbmNlbDwvYnV0dG9uPgogICAgICAke3QgPyAnPGJ1dHRvbiBjbGFzcz0iYnRu' +
  'IGdob3N0IiBpZD0iZGVsIiBzdHlsZT0iY29sb3I6dmFyKC0tYmFkKTttYXJnaW4tbGVmdDphdXRvIj5EZWxldGU8L2J1dHRvbj4n' +
  'IDogJyd9CiAgICA8L2Rpdj4KICAgIDxwcmUgY2xhc3M9InByZXYiIGlkPSJ0cHJldiIgc3R5bGU9ImRpc3BsYXk6bm9uZTttYXJn' +
  'aW4tdG9wOjEycHgiPjwvcHJlPmAsIGVsID0+IHsKICAgIGNvbnN0IHRhID0gZWwucXVlcnlTZWxlY3RvcignI3RfYm9keScpOwog' +
  'ICAgZWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtZl0nKS5mb3JFYWNoKGIgPT4gYi5vbmNsaWNrID0gKCkgPT4gewogICAgICBj' +
  'b25zdCB0b2sgPSAne3snICsgYi5kYXRhc2V0LmYgKyAnfX0nOwogICAgICBjb25zdCBzID0gdGEuc2VsZWN0aW9uU3RhcnQsIGUg' +
  'PSB0YS5zZWxlY3Rpb25FbmQ7CiAgICAgIHRhLnZhbHVlID0gdGEudmFsdWUuc2xpY2UoMCwgcykgKyB0b2sgKyB0YS52YWx1ZS5z' +
  'bGljZShlKTsKICAgICAgdGEuZm9jdXMoKTsgdGEuc2VsZWN0aW9uU3RhcnQgPSB0YS5zZWxlY3Rpb25FbmQgPSBzICsgdG9rLmxl' +
  'bmd0aDsKICAgIH0pOwogICAgZWwucXVlcnlTZWxlY3RvcignI3ByZXZpZXcnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAg' +
  'ICBjb25zdCByID0gYXdhaXQgYXBpKCcvdGVtcGxhdGVzL3ByZXZpZXcnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0' +
  'cmluZ2lmeSh7IGJvZHk6IHRhLnZhbHVlIH0pIH0pOwogICAgICBjb25zdCBwID0gZWwucXVlcnlTZWxlY3RvcignI3RwcmV2Jyk7' +
  'CiAgICAgIHAuc3R5bGUuZGlzcGxheSA9ICcnOyBwLnRleHRDb250ZW50ID0gci50ZXh0OwogICAgfTsKICAgIGVsLnF1ZXJ5U2Vs' +
  'ZWN0b3IoJyNzYXZlJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgYm9keSA9IHsKICAgICAgICBuYW1lOiBl' +
  'bC5xdWVyeVNlbGVjdG9yKCcjdF9uYW1lJykudmFsdWUsIGp1cmlzZGljdGlvbjogZWwucXVlcnlTZWxlY3RvcignI3RfanVyaXNk' +
  'aWN0aW9uJykudmFsdWUsCiAgICAgICAgYm9keTogdGEudmFsdWUsIGlzX2RlZmF1bHQ6IGVsLnF1ZXJ5U2VsZWN0b3IoJyN0X2Rl' +
  'ZmF1bHQnKS5jaGVja2VkCiAgICAgIH07CiAgICAgIGlmICghYm9keS5uYW1lLnRyaW0oKSkgcmV0dXJuIHRvYXN0KCdHaXZlIHRo' +
  'ZSB0ZW1wbGF0ZSBhIG5hbWUnLCB0cnVlKTsKICAgICAgdHJ5IHsKICAgICAgICBhd2FpdCAodCA/IGFwaSgnL3RlbXBsYXRlcy8n' +
  'ICsgdC5pZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pCiAgICAgICAgICAgICAgICAg' +
  'OiBhcGkoJy90ZW1wbGF0ZXMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KSk7CiAgICAg' +
  'ICAgY2xvc2VTaGVldCgpOyB0b2FzdCgnU2F2ZWQnKTsgZ28oJ2FkbWluJyk7CiAgICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5t' +
  'ZXNzYWdlLCB0cnVlKTsgfQogICAgfTsKICAgIGlmIChlbC5xdWVyeVNlbGVjdG9yKCcjZGVsJykpIGVsLnF1ZXJ5U2VsZWN0b3Io' +
  'JyNkZWwnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBpZiAoIWNvbmZpcm0oJ0RlbGV0ZSB0aGlzIHRlbXBsYXRlPycp' +
  'KSByZXR1cm47CiAgICAgIGF3YWl0IGFwaSgnL3RlbXBsYXRlcy8nICsgdC5pZCwgeyBtZXRob2Q6ICdERUxFVEUnIH0pOwogICAg' +
  'ICBjbG9zZVNoZWV0KCk7IHRvYXN0KCdEZWxldGVkJyk7IGdvKCdhZG1pbicpOwogICAgfTsKICB9KTsKfQoKLyogLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGJvb3QgLS0gKi8KY29uc3QgVklF' +
  'V1MgPSB7IGRhc2g6IGRhc2hWaWV3LCBqb2JzOiBqb2JzVmlldywgam9iOiBqb2JWaWV3LCBzY2FuOiBzY2FuVmlldywKICB0b29s' +
  'czogdG9vbHNWaWV3LCBwcm9wZXJ0eTogcHJvcGVydHlWaWV3LCBtb25leTogbW9uZXlWaWV3LCBhZG1pbjogYWRtaW5WaWV3IH07' +
  'Cgphc3luYyBmdW5jdGlvbiByZW5kZXIoKSB7CiAgY2xvc2VTaGVldCgpOwogIGlmICghUy5tZSkgcmV0dXJuIGxvZ2luVmlldygp' +
  'OwogIGlmIChTLnZpZXcgPT09ICdqb2JzJykgUy5jYWNoZS5qb2JGaWx0ZXIgPSBTLnBhcmFtczsKICBjb25zdCBmbiA9IFZJRVdT' +
  'W1Mudmlld10gfHwgZGFzaFZpZXc7CiAgdHJ5IHsKICAgIGFwcC5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0id3JhcCI+PGRpdiBj' +
  'bGFzcz0iZW1wdHkiPkxvYWRpbmfigKY8L2Rpdj48L2Rpdj4nOwogICAgYXdhaXQgZm4oKTsKICB9IGNhdGNoIChlKSB7CiAgICBp' +
  'ZiAoUy5tZSkgeyBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYDxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImVtcHR5Ij4ke2Vz' +
  'YyhlLm1lc3NhZ2UpfTwvZGl2PjwvZGl2PmApOyBiaW5kU2hlbGwoKTsgfQogIH0KfQoKKGFzeW5jIGZ1bmN0aW9uIGJvb3QoKSB7' +
  'CiAgdHJ5IHsgUy5tZSA9IGF3YWl0IGFwaSgnL21lJyk7IH0gY2F0Y2ggKGUpIHsgUy5tZSA9IG51bGw7IH0KICByZW5kZXIoKTsK' +
  'fSkoKTsKfSkoKTsKCjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K'
, 'base64').toString('utf8');

/* ------------------------------------------------ bundled: code128.js --- */
const code128 = (() => {
// Minimal Code 128-B encoder -> SVG. No dependencies.
const PATTERNS = [
  '11011001100','11001101100','11001100110','10010011000','10010001100','10001001100',
  '10011001000','10011000100','10001100100','11001001000','11001000100','11000100100',
  '10110011100','10011011100','10011001110','10111001100','10011101100','10011100110',
  '11001110010','11001011100','11001001110','11011100100','11001110100','11101101110',
  '11101001100','11100101100','11100100110','11101100100','11100110100','11100110010',
  '11011011000','11011000110','11000110110','10100011000','10001011000','10001000110',
  '10110001000','10001101000','10001100010','11010001000','11000101000','11000100010',
  '10110111000','10110001110','10001101110','10111011000','10111000110','10001110110',
  '11101110110','11010001110','11000101110','11011101000','11011100010','11011101110',
  '11101011000','11101000110','11100010110','11101101000','11101100010','11100011010',
  '11101111010','11001000010','11110001010','10100110000','10100001100','10010110000',
  '10010000110','10000101100','10000100110','10110010000','10110000100','10011010000',
  '10011000010','10000110100','10000110010','11000010010','11001010000','11110111010',
  '11000010100','10001111010','10100111100','10010111100','10010011110','10111100100',
  '10011110100','10011110010','11110100100','11110010100','11110010010','11011011110',
  '11011110110','11110110110','10101111000','10100011110','10001011110','10111101000',
  '10111100010','11110101000','11110100010','10111011110','10111101110','11101011110',
  '11110101110','11010000100','11010010000','11010011100','11000111010'
];
const STOP = '1100011101011';

function encode(text) {
  const value = String(text || '').replace(/[^\x20-\x7E]/g, '');
  const codes = [104]; // Start B
  for (const ch of value) codes.push(ch.charCodeAt(0) - 32);
  let sum = 104;
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
  codes.push(sum % 103);
  let bits = codes.map(c => PATTERNS[c]).join('') + STOP;
  return { bits, value };
}

// Returns an SVG string for the barcode.
function toSVG(text, { height = 60, moduleWidth = 2, showText = true } = {}) {
  const { bits, value } = encode(text);
  const quiet = 10 * moduleWidth;
  const width = bits.length * moduleWidth + quiet * 2;
  const textH = showText ? 18 : 0;
  let rects = '';
  let x = quiet;
  let i = 0;
  while (i < bits.length) {
    let run = 1;
    while (i + run < bits.length && bits[i + run] === bits[i]) run++;
    if (bits[i] === '1') {
      rects += `<rect x="${x}" y="0" width="${run * moduleWidth}" height="${height}" fill="#000"/>`;
    }
    x += run * moduleWidth;
    i += run;
  }
  const label = showText
    ? `<text x="${width / 2}" y="${height + 14}" font-family="monospace" font-size="13" text-anchor="middle" fill="#000">${value}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + textH}" viewBox="0 0 ${width} ${height + textH}"><rect width="${width}" height="${height + textH}" fill="#fff"/>${rects}${label}</svg>`;
}

return { toSVG };

})();

/* -------------------------------------------------- bundled: merge.js --- */
const merge = (() => {
// Affidavit merge-field rendering.

const FIELDS = [
  ['job_number', 'Job number'],
  ['case_number', 'Case number'],
  ['court', 'Court name'],
  ['plaintiff', 'Plaintiff'],
  ['defendant', 'Defendant'],
  ['client_name', 'Client / law firm'],
  ['recipient_name', 'Person or entity to be served'],
  ['recipient_notes', 'Recipient notes'],
  ['service_address', 'Full service address'],
  ['documents', 'Documents served'],
  ['service_type', 'Service type ordered'],
  ['due_date', 'Due date'],
  ['served_date', 'Date of successful service'],
  ['served_time', 'Time of successful service'],
  ['served_manner', 'Manner of service (Personal, Substitute, Posted...)'],
  ['served_person', 'Name of person actually handed the papers'],
  ['served_description', 'Physical description of person served'],
  ['served_gps', 'GPS coordinates recorded at service'],
  ['attempts_list', 'Full list of attempts with date, time, outcome, GPS'],
  ['attempt_count', 'Number of attempts made'],
  ['server_name', 'Process server name'],
  ['server_license', 'Process server license/registration'],
  ['client_fee', 'Fee charged to client'],
  ['today', "Today's date"]
];

const money = v => (v == null ? '' : '$' + Number(v).toFixed(2));

function fmtDate(d, tz) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', {
    timeZone: tz, year: 'numeric', month: 'long', day: 'numeric'
  });
}
function fmtTime(d, tz) {
  if (!d) return '';
  return new Date(d).toLocaleTimeString('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit'
  });
}

function buildContext(job, attempts, server, client, tz = 'America/New_York') {
  const addr = [
    [job.address1, job.address2].filter(Boolean).join(' '),
    job.city, [job.state, job.zip].filter(Boolean).join(' ')
  ].filter(Boolean).join(', ');

  const served = attempts.find(a => a.outcome === 'Served');
  const gps = served && served.lat != null
    ? `${Number(served.lat).toFixed(6)}, ${Number(served.lng).toFixed(6)}`
    : '';

  const list = attempts.length
    ? attempts.map((a, i) => {
        const g = a.lat != null ? ` [GPS ${Number(a.lat).toFixed(5)}, ${Number(a.lng).toFixed(5)}]` : '';
        const n = a.notes ? ` - ${a.notes}` : '';
        return `  ${i + 1}. ${fmtDate(a.attempted_at, tz)} at ${fmtTime(a.attempted_at, tz)} - ${a.outcome}${n}${g}`;
      }).join('\n')
    : '  No attempts recorded.';

  return {
    job_number: job.job_number || '',
    case_number: job.case_number || '',
    court: job.court || '',
    plaintiff: job.plaintiff || '',
    defendant: job.defendant || '',
    client_name: client ? client.name : '',
    recipient_name: job.recipient_name || '',
    recipient_notes: job.recipient_notes || '',
    service_address: addr,
    documents: job.documents || '',
    service_type: job.service_type || '',
    due_date: fmtDate(job.due_date, tz),
    served_date: fmtDate(job.served_at || (served && served.attempted_at), tz),
    served_time: fmtTime(job.served_at || (served && served.attempted_at), tz),
    served_manner: job.served_manner || (served && served.manner) || '',
    served_person: job.served_person || (served && served.person_served) || '',
    served_description: (served && served.description) || '',
    served_gps: gps,
    attempts_list: list,
    attempt_count: String(attempts.length),
    server_name: server ? server.name : '',
    server_license: server && server.license_no ? `, License #${server.license_no}` : '',
    client_fee: money(job.client_fee),
    today: fmtDate(new Date(), tz)
  };
}

function render(body, ctx) {
  return String(body).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, key) => {
    const k = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ctx, k) ? ctx[k] : m;
  });
}

return { FIELDS, buildContext, render };

})();

/* ----------------------------------------------- bundled: docparse.js --- */
const docparse = (() => {
/* Extract job fields from the text of a summons, citation, subpoena or complaint.
 *
 * These documents have no standard layout, so this works on the conventions that
 * hold across most of them: a caption block naming the parties, a labelled case
 * number, a "TO:" line naming who gets served, and a street address near it.
 * Everything returned is a suggestion for a human to confirm -- never silently
 * trusted. Fields we can't find are simply omitted.
 */

const STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC'
};
const STATE_ABBRS = new Set(Object.values(STATES));

const STREET_SUFFIX = /\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|cir|circle|way|pl|place|pkwy|parkway|ter|terrace|trl|trail|hwy|highway|route|rt|loop|run|path|pike|plaza|square|sq)\b\.?/i;
const UNIT = /\b(apt|apartment|unit|suite|ste|#|bldg|building|floor|fl|rm|room|lot|trlr|space|spc)\b\.?\s*[\w-]*/i;

// Document types, most specific first.
const DOC_TYPES = [
  [/subpoena\s+duces\s+tecum/i, 'Subpoena Duces Tecum'],
  [/complaint\s+in\s+forcible\s+entry\s+and\s+detainer/i, 'Complaint in Forcible Entry and Detainer'],
  [/forcible\s+entry\s+and\s+detainer/i, 'Forcible Entry and Detainer'],
  [/(three|3)[\s-]day\s+notice/i, '3-Day Notice'],
  [/notice\s+to\s+(vacate|quit|leave)/i, 'Notice to Vacate'],
  [/unlawful\s+detainer/i, 'Unlawful Detainer'],
  [/writ\s+of\s+(execution|possession|garnishment|attachment)/i, 'Writ'],
  [/(order|notice)\s+to\s+show\s+cause/i, 'Order to Show Cause'],
  [/temporary\s+restraining\s+order/i, 'Temporary Restraining Order'],
  [/civil\s+protection\s+order/i, 'Civil Protection Order'],
  [/small\s+claims/i, 'Small Claims'],
  [/garnishment/i, 'Garnishment'],
  [/\bsummons\b/i, 'Summons'],
  [/\bcitation\b/i, 'Citation'],
  [/\bsubpoena\b/i, 'Subpoena'],
  [/\bcomplaint\b/i, 'Complaint'],
  [/original\s+petition|\bpetition\b/i, 'Petition'],
  [/\bmotion\b/i, 'Motion'],
  [/divorce|dissolution\s+of\s+marriage/i, 'Divorce Papers'],
  [/eviction/i, 'Eviction Papers']
];

const COURT_WORDS = /(court of common pleas|municipal court|superior court|district court|circuit court|justice court|county court|probate court|family court|magistrate court|justice of the peace|court of appeals|supreme court|small claims court|\bcourt\b)/i;

const clean = s => String(s || '').replace(/\s+/g, ' ').trim().replace(/[,;:]+$/, '');

// Strip caption punctuation and role words from a party name.
function tidyParty(s) {
  let v = clean(s)
    .replace(/^(and\s+)?/i, '')
    .replace(/\s*[,;]?\s*(plaintiffs?|defendants?|petitioners?|respondents?|appellants?|appellees?)\s*[,.;]?\s*$/i, '')
    // drop entity descriptors that follow the name: ", an individual",
    // ", a California corporation", ", an Ohio limited liability company"
    .replace(/,\s*(an?|the)\s+[A-Za-z .]{0,24}?(individual|corporation|company|partnership|association|trust|entity|llc|l\.l\.c\.)\b.*$/i, '')
    .replace(/,\s*(individually|jointly|et\s+al\.?)\b.*$/i, '')
    .replace(/[,]+$/, '')
    .trim();
  if (/^(vs?\.?|versus)$/i.test(v)) return '';
  return v;
}

const looksLikeName = s => {
  const v = clean(s);
  if (v.length < 3 || v.length > 90) return false;
  if (/^(plaintiffs?|defendants?|vs?\.?|versus|case|cause|no\.?|summons|citation|complaint|subpoena)\b/i.test(v)) return false;
  if (/^\d/.test(v)) return false;              // an address, not a name
  if (COURT_WORDS.test(v) && /county|state|court/i.test(v)) return false;
  return /[A-Za-z]{2}/.test(v);
};

function parseCaseNumber(text) {
  const patterns = [
    /\b(?:case|cause|docket|court\s+file)\s*(?:no\.?|number|#)\s*(?:\([^)]*\))?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/.]{3,24})/i,
    /\bcase\s*(?:no\.?|number|#)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/.]{3,24})/i,
    /(?:^|\s)no\.\s*([0-9]{2,4}[-\/][A-Z]{1,3}[-\/][0-9]{3,8})/im,
    /(?:^|\s)no\.\s*([A-Z]{1,4}[-\s]?[0-9]{2,4}[-\/][0-9]{3,8})/im
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].replace(/[.,]$/, '').trim();
  }
  return '';
}

function parseCourt(lines) {
  for (let i = 0; i < lines.length; i++) {
    const l = clean(lines[i]);
    if (!l || l.length > 95) continue;
    if (!COURT_WORDS.test(l)) continue;
    if (/\b(this court|the court|at this court|in court)\b/i.test(l) && !/^in the|^the\s+\w+\s+court/i.test(l)) continue;
    let court = l.replace(/^in\s+the\s+/i, '').replace(/^for\s+the\s+/i, '');
    const next = clean(lines[i + 1] || '');
    if (next && next.length < 70 && !/case|cause|no\.|plaintiff|defendant/i.test(next) &&
        /(county|parish|division|district|precinct|,\s*[A-Z]{2}$|state of)/i.test(next)) {
      court += ', ' + next;
    }
    return court.replace(/\s*,\s*$/, '');
  }
  return '';
}

// Caption style: a line reading "Plaintiff," with the party named just above it.
function partyFromCaption(lines, role) {
  const re = new RegExp('^\\s*[,\\-]?\\s*' + role + 's?\\s*[,.;]?\\s*$', 'i');
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(clean(lines[i]))) continue;
    for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
      const cand = tidyParty(lines[j]);
      if (looksLikeName(cand)) return cand;
    }
  }
  return '';
}

// Label style: "NOTICE TO DEFENDANT (AVISO...): NAME" or the name on the next line.
function partyFromLabel(text, lines, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1] && looksLikeName(tidyParty(m[1]))) return tidyParty(m[1]);
    // label alone on its line -> take the following line
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const inline = lines[i].replace(re, '').trim();
      if (looksLikeName(tidyParty(inline))) return tidyParty(inline);
      for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
        const cand = tidyParty(lines[j]);
        if (looksLikeName(cand)) return cand;
      }
    }
  }
  return '';
}

function parseAddress(lines, anchorIdx) {
  const isCityLine = l => {
    const m = clean(l).match(/^(.+?)[,\s]+([A-Za-z]{2}|[A-Za-z .]{4,20})[,\s]+(\d{5})(?:-\d{4})?$/);
    if (!m) return null;
    const cityRaw = m[1].replace(/[,]+$/, '').trim();
    let st = m[2].trim();
    if (st.length > 2) {
      const abbr = STATES[st.toLowerCase()];
      if (!abbr) return null;
      st = abbr;
    } else if (!STATE_ABBRS.has(st.toUpperCase())) return null;
    if (!cityRaw || /\d/.test(cityRaw)) return null;
    return { city: cityRaw, state: st.toUpperCase(), zip: m[3] };
  };

  const isStreetLine = l => {
    const v = clean(l);
    if (!/^\d{1,6}[A-Za-z]?\s+\S/.test(v)) return false;
    if (v.length > 80) return false;
    return STREET_SUFFIX.test(v) || UNIT.test(v) || /^\d+\s+[NSEW]\.?\s+\w/i.test(v);
  };

  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const city = isCityLine(lines[i]);
    if (!city) continue;
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      if (!isStreetLine(lines[j])) continue;
      let street = clean(lines[j]);
      let address2 = '';
      const unitSplit = street.match(/^(.*?),\s*((?:apt|apartment|unit|suite|ste|#|bldg|building|floor|fl|rm|room|lot|space|spc)\b\.?\s*[\w-]*)$/i);
      if (unitSplit) { street = clean(unitSplit[1]); address2 = clean(unitSplit[2]); }
      // extra lines between street and city (unit on its own line)
      if (!address2 && j + 1 < i) {
        const mid = clean(lines[j + 1]);
        if (mid && UNIT.test(mid) && mid.length < 30) address2 = mid;
      }
      candidates.push({ idx: j, address1: street, address2, ...city });
      break;
    }
  }
  if (!candidates.length) return null;
  if (anchorIdx >= 0) {
    // prefer the address that appears just after whoever is being served
    const after = candidates.filter(c => c.idx >= anchorIdx).sort((a, b) => a.idx - b.idx);
    if (after.length) return after[0];
  }
  return candidates[0];
}

function parseDocuments(text) {
  const found = [];
  for (const [re, label] of DOC_TYPES) {
    if (found.length >= 3) break;
    if (!re.test(text)) continue;
    // don't add "Complaint" when we already matched a more specific complaint type
    if (found.some(f => f.toLowerCase().includes(label.toLowerCase()))) continue;
    if (label === 'Complaint' && found.some(f => /complaint/i.test(f))) continue;
    if (label === 'Subpoena' && found.some(f => /subpoena/i.test(f))) continue;
    if (label === 'Petition' && found.some(f => /petition/i.test(f))) continue;
    // one eviction-notice label is enough
    if (label === 'Notice to Vacate' && found.some(f => /notice|detainer/i.test(f))) continue;
    if (label === '3-Day Notice' && found.some(f => /detainer|notice/i.test(f))) continue;
    if (label === 'Forcible Entry and Detainer' && found.some(f => /detainer/i.test(f))) continue;
    found.push(label);
  }
  return found.slice(0, 3).join(' and ');
}

function parse(rawText) {
  const text = String(rawText || '').replace(/\r/g, '');
  const lines = text.split('\n').map(l => l.replace(/ /g, ' ').trimEnd());

  const case_number = parseCaseNumber(text);
  const court = parseCourt(lines);

  let plaintiff = partyFromCaption(lines, 'plaintiff') ||
    partyFromLabel(text, lines, [
      /you\s+are\s+being\s+sued\s+by\s+plaintiff[^:]*:\s*(.*)/i,
      /plaintiff[’'s]*\s*name\s*[:.]\s*(.*)/i
    ]);
  let defendant = partyFromCaption(lines, 'defendant') ||
    partyFromLabel(text, lines, [
      /notice\s+to\s+defendant[^:]*:\s*(.*)/i,
      /to\s+the\s+defendant\s*[:.]\s*(.*)/i
    ]);
  if (!plaintiff) plaintiff = partyFromCaption(lines, 'petitioner');
  if (!defendant) defendant = partyFromCaption(lines, 'respondent');

  // Who actually gets handed the papers
  let recipient_name = '';
  let anchorIdx = -1;
  const toPatterns = [
    /^\s*to\s+the\s+defendant\s*[:.]\s*(.*)$/i,
    /^\s*to\s*[:.]\s*(.*)$/i,
    /^\s*notice\s+to\s+defendant[^:]*:\s*(.*)$/i
  ];
  for (let i = 0; i < lines.length && !recipient_name; i++) {
    for (const re of toPatterns) {
      const m = lines[i].match(re);
      if (!m) continue;
      let cand = tidyParty((m[1] || '').replace(/,?\s*(defendant|greetings?)\b.*$/i, ''));
      if (!looksLikeName(cand)) {
        for (let j = i + 1; j <= i + 2 && j < lines.length; j++) {
          const nxt = tidyParty(lines[j]);
          if (looksLikeName(nxt)) { cand = nxt; break; }
        }
      }
      if (looksLikeName(cand)) { recipient_name = cand; anchorIdx = i; break; }
    }
  }
  if (!recipient_name && defendant) {
    recipient_name = defendant;
    anchorIdx = lines.findIndex(l => clean(l).toLowerCase().includes(defendant.toLowerCase().slice(0, 12)));
  }

  const addr = parseAddress(lines, anchorIdx);
  const documents = parseDocuments(text);

  const out = { case_number, court, plaintiff, defendant, recipient_name, documents };
  if (addr) {
    out.address1 = addr.address1;
    out.address2 = addr.address2 || '';
    out.city = addr.city;
    out.state = addr.state;
    out.zip = addr.zip;
  }
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}

return { parse };

})();

/* ------------------------------------------------- bundled: portal.js --- */
const portal = (() => {
/* County court portal access.
 *
 * These portals are session-based ASP.NET apps with no documented interface, so
 * everything here is best-effort and defensive: it must never throw into the
 * request handler, and every failure has to explain itself well enough to debug
 * from a log line. The probe exists because the portals cannot be reached from
 * the development sandbox -- it runs on the deployed server and reports what the
 * sites actually return, so parsing can be written against real structure.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Only these hosts may be fetched. Without this the probe is an open proxy
// (server-side request forgery) into anything reachable from the server.
const ALLOWED_HOSTS = new Set([
  'pa.co.hidalgo.tx.us',
  'hidalgo.tx.publicsearch.us',
  'www.hidalgocounty.us',
  'www.cameroncountytx.gov',
  'kofilequicklinks.com',
  'cameroncountycourt.org',
  'research.txcourts.gov',
  // found by probing Cameron's own county-clerk page
  'portalprod24.co.cameron.tx.us',
  'online.idocket.com',
  // property records: county clerks (Kofile PublicSearch) and appraisal districts
  'cameron.tx.publicsearch.us',
  'starr.tx.publicsearch.us',
  'hidalgo.prodigycad.com',
  'cameron.prodigycad.com',
  'esearch.starrcad.org',
  'propaccess.hidalgoad.org',
  'propaccess.cameroncad.org'
]);

const PORTALS = {
  hidalgo: { label: 'Hidalgo County District Clerk', start: 'https://pa.co.hidalgo.tx.us/default.aspx' },
  cameron_portals: { label: 'Cameron County portals', start: 'https://www.cameroncountytx.gov/cameron-county-portals/' },
  cameron_dc: { label: 'Cameron County District Clerk', start: 'https://kofilequicklinks.com/camerondc/' },
  research: { label: 're:SearchTX', start: 'https://research.txcourts.gov/' }
};

function hostAllowed(url) {
  try { return ALLOWED_HOSTS.has(new URL(url).hostname); } catch (e) { return false; }
}

/* ------------------------------------------------------- fetch plumbing -- */

function absolutise(base, href) {
  try { return new URL(href, base).toString(); } catch (e) { return null; }
}

// Follows redirects manually so cookies set mid-chain are carried forward --
// the usual cause of an apparent "too many redirects" loop.
async function get(url, jar, opts = {}) {
  const hops = [];
  let current = url;
  for (let i = 0; i < 8; i++) {
    if (!hostAllowed(current)) throw new Error('Host not allowed: ' + current);
    const headers = Object.assign({
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }, opts.headers || {});
    const cookie = [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
    if (cookie) headers.Cookie = cookie;
    // Odyssey Public Access drives its menu by building a form in JavaScript and
    // posting it, so form-encoded bodies are the norm here.
    if ((opts.method || 'GET').toUpperCase() === 'POST' && opts.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const res = await fetch(current, {
      method: opts.method || 'GET',
      headers,
      body: opts.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeout || 20000)
    });

    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const c of setCookies) {
      const kv = c.split(';')[0];
      const eq = kv.indexOf('=');
      if (eq > 0) jar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }

    hops.push({ url: current, status: res.status, setCookies: setCookies.length });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return { res, body: '', hops };
      const next = absolutise(current, loc);
      if (!next) return { res, body: '', hops };
      current = next;
      opts = { headers: opts.headers, timeout: opts.timeout }; // redirects become GETs
      continue;
    }
    const body = await res.text();
    return { res, body, hops, finalUrl: current };
  }
  return { res: null, body: '', hops, error: 'Too many redirects (8 hops)' };
}

/* ------------------------------------------------------------ HTML bits -- */

const stripTags = h => String(h || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#\d+;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function title(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripTags(m[1]).slice(0, 120) : '';
}

// Pull out forms with their action, method and input names -- enough to tell
// whether a case-number search can be posted, and what it expects.
function forms(html, baseUrl) {
  const out = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 6) {
    const attrs = m[1];
    const inner = m[2];
    const action = (attrs.match(/action\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const method = ((attrs.match(/method\s*=\s*["']([^"']*)["']/i) || [])[1] || 'GET').toUpperCase();
    const id = (attrs.match(/\bid\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const inputs = [];
    const ire = /<(input|select|textarea)\b([^>]*)>/gi;
    let im;
    while ((im = ire.exec(inner)) && inputs.length < 40) {
      const a = im[2];
      const name = (a.match(/name\s*=\s*["']([^"']*)["']/i) || [])[1];
      if (!name) continue;
      const type = (a.match(/type\s*=\s*["']([^"']*)["']/i) || [])[1] || im[1].toLowerCase();
      if (/^__(VIEWSTATE|EVENTVALIDATION|VIEWSTATEGENERATOR)/i.test(name)) {
        inputs.push({ name, type, hidden_aspnet: true });
      } else {
        inputs.push({ name, type });
      }
    }
    out.push({ id, action: absolutise(baseUrl, action) || action, method, inputs });
  }
  return out;
}

function links(html, baseUrl) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) && out.length < 45) {
    const href = absolutise(baseUrl, m[1]);
    const text = stripTags(m[2]).slice(0, 70);
    if (!href || seen.has(href)) continue;
    if (/^(mailto:|tel:|javascript:)/i.test(m[1])) continue;
    seen.add(href);
    out.push({ href, text });
  }
  return out;
}

// Script tags reveal whether a page is a JavaScript app and, often, the API it
// talks to -- far more useful than scraping rendered HTML if endpoints exist.
function scripts(html, baseUrl) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 25) {
    const src = (m[1].match(/src\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (src) out.push({ src: absolutise(baseUrl, src) || src });
    else if (m[2] && m[2].trim().length > 40) {
      out.push({ inline: m[2].replace(/\s+/g, ' ').trim().slice(0, 300) });
    }
  }
  return out;
}

const looksLikeBotWall = html =>
  /javascript is required|enable javascript|incapsula|cloudflare|attention required|access denied|are you a human/i
    .test(String(html).slice(0, 4000));

/* ---------------------------------------------------------------- probe -- */

async function probe(key) {
  const portal = PORTALS[key];
  if (!portal) return { error: 'Unknown portal: ' + key };
  const jar = new Map();
  const started = Date.now();
  try {
    const { res, body, hops, finalUrl, error } = await get(portal.start, jar);
    if (error) return { portal: key, label: portal.label, hops, error };
    const html = body || '';
    return {
      portal: key,
      label: portal.label,
      start: portal.start,
      finalUrl: finalUrl || portal.start,
      status: res ? res.status : 0,
      contentType: res ? res.headers.get('content-type') : '',
      ms: Date.now() - started,
      bytes: html.length,
      title: title(html),
      cookies: [...jar.keys()],
      hops,
      botWall: looksLikeBotWall(html),
      aspnet: /__VIEWSTATE/.test(html),
      forms: forms(html, finalUrl || portal.start),
      links: links(html, finalUrl || portal.start),
      textSnippet: stripTags(html).slice(0, 700)
    };
  } catch (e) {
    return {
      portal: key, label: portal.label, start: portal.start,
      ms: Date.now() - started,
      error: e.name === 'TimeoutError' ? 'Timed out after 20s' : (e.message || String(e)),
      cookies: [...jar.keys()]
    };
  }
}

// Probe an arbitrary page on an allowed host -- used to walk deeper into a
// portal once the first probe reveals where the search page lives.
// opts.raw: include a slice of the untouched HTML. Rendered text and extracted
// links both proved lossy on JavaScript-driven portals -- the menu links simply
// are not anchors -- so sometimes the source itself is the only honest answer.
async function probeUrl(url, opts = {}) {
  if (!hostAllowed(url)) return { error: 'That host is not on the allow-list: ' + url };
  const jar = new Map();
  const started = Date.now();
  const notes = [];
  try {
    // Optional warm-up requests share the cookie jar. Portals that hand out an
    // anonymous session on first contact need this: a POST sent cold is bounced
    // to the login handler and its body is discarded by the redirect.
    for (const w of [].concat(opts.warmup || [])) {
      if (!hostAllowed(w)) return { url, error: 'Warm-up host not on the allow-list: ' + w };
      const r = await get(w, jar);
      notes.push({ warmup: w, status: r.res ? r.res.status : 0, cookies: [...jar.keys()] });
    }

    const request = { method: opts.method, body: opts.body, headers: opts.headers };
    let { res, body, hops, finalUrl, error } = await get(url, jar, request);

    // If we were redirected through a login/session handler and picked up
    // cookies on the way, the original request never really ran. Now that the
    // jar is populated, run it once more for real.
    const bouncedToLogin = hops && hops.length > 1 &&
      hops.some(h => /login|signin|default\.aspx/i.test(h.url)) &&
      hops.some(h => h.setCookies > 0);
    if (!error && bouncedToLogin && jar.size) {
      notes.push({ retry: 'session established, repeating the request', cookies: [...jar.keys()] });
      const again = await get(url, jar, request);
      if (!again.error) ({ res, body, hops, finalUrl } = again);
    }

    if (error) return { url, hops, notes, error };
    const html = body || '';
    const base = finalUrl || url;
    const out = {
      url, finalUrl: base,
      status: res ? res.status : 0,
      ms: Date.now() - started,
      bytes: html.length,
      title: title(html),
      cookies: [...jar.keys()],
      hops,
      notes,
      botWall: looksLikeBotWall(html),
      captcha: /recaptcha|hcaptcha|CaptchaEnabled"\s*:\s*true/i.test(html),
      aspnet: /__VIEWSTATE/.test(html),
      forms: forms(html, base),
      links: links(html, base),
      scripts: scripts(html, base),
      textSnippet: stripTags(html).slice(0, 500)
    };
    if (opts.raw) out.raw = html.replace(/\s+/g, ' ').slice(0, Number(opts.raw) || 6000);
    return out;
  } catch (e) {
    return { url, ms: Date.now() - started, error: e.message || String(e) };
  }
}

return { probe, probeUrl, PORTALS, ALLOWED_HOSTS, stripTags, forms, links, scripts, title, get, looksLikeBotWall };

})();

/* ------------------------------------------------- bundled: labels.js --- */
const labels = (() => {
/* Label sheet geometry and rendering.
 *
 * All measurements are inches on US Letter (8.5 x 11), because that is how
 * label sheets are actually specified and converting to points or millimetres
 * just adds rounding error between here and the printer driver.
 *
 * Positions are numbered left-to-right, top-to-bottom, starting at zero -- the
 * same order a person peels them off.
 */

const LAYOUTS = {
  avery5160: {
    name: 'Avery 5160 / 8160 — 30 per sheet',
    size: '1" x 2 5/8"', cols: 3, rows: 10,
    w: 2.625, h: 1.0, left: 0.1875, top: 0.5, gapX: 0.125, gapY: 0
  },
  avery5161: {
    name: 'Avery 5161 / 8161 — 20 per sheet',
    size: '1" x 4"', cols: 2, rows: 10,
    w: 4.0, h: 1.0, left: 0.15625, top: 0.5, gapX: 0.1875, gapY: 0
  },
  avery5162: {
    name: 'Avery 5162 / 8162 — 14 per sheet',
    size: '1 1/3" x 4"', cols: 2, rows: 7,
    w: 4.0, h: 1.333, left: 0.15625, top: 0.833, gapX: 0.1875, gapY: 0
  },
  avery5163: {
    name: 'Avery 5163 / 8163 — 10 per sheet',
    size: '2" x 4"', cols: 2, rows: 5,
    w: 4.0, h: 2.0, left: 0.15625, top: 0.5, gapX: 0.1875, gapY: 0
  },
  avery5164: {
    name: 'Avery 5164 / 8164 — 6 per sheet',
    size: '3 1/3" x 4"', cols: 2, rows: 3,
    w: 4.0, h: 3.333, left: 0.15625, top: 0.5, gapX: 0.1875, gapY: 0
  },
  avery5167: {
    name: 'Avery 5167 / 8167 — 80 per sheet',
    size: '1/2" x 1 3/4"', cols: 4, rows: 20,
    w: 1.75, h: 0.5, left: 0.28125, top: 0.5, gapX: 0.3125, gapY: 0
  }
};

const capacity = key => {
  const l = LAYOUTS[key];
  return l ? l.cols * l.rows : 0;
};

// Top-left corner of a position, in inches, including printer drift correction.
function positionAt(layout, index, offsetX = 0, offsetY = 0) {
  const l = LAYOUTS[layout];
  if (!l) return null;
  const col = index % l.cols;
  const row = Math.floor(index / l.cols);
  if (row >= l.rows) return null;
  return {
    x: l.left + col * (l.w + l.gapX) + Number(offsetX || 0),
    y: l.top + row * (l.h + l.gapY) + Number(offsetY || 0),
    w: l.w, h: l.h
  };
}

// The free positions, in peel order, skipping any already used.
function freePositions(layout, used) {
  const total = capacity(layout);
  const taken = new Set((used || []).map(Number));
  const out = [];
  for (let i = 0; i < total; i++) if (!taken.has(i)) out.push(i);
  return out;
}

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Renders a print-ready sheet. Each label is absolutely positioned at its exact
   inch coordinates so the browser cannot reflow them onto the wrong square. */
function renderSheet({ layout, used, offsetX, offsetY, labels, guides }) {
  const l = LAYOUTS[layout];
  if (!l) return '<p>Unknown label layout.</p>';
  const free = freePositions(layout, used);
  const placed = [];

  labels.forEach((label, n) => {
    const index = free[n];
    if (index === undefined) return;              // sheet ran out
    const p = positionAt(layout, index, offsetX, offsetY);
    if (!p) return;
    // Font sized off label height so a 1" label and a 2" label both look right.
    const nameSize = Math.min(13, Math.max(9, p.h * 9));
    const lineSize = Math.min(12, Math.max(8, p.h * 8));
    placed.push(`
      <div class="lbl" style="left:${p.x}in;top:${p.y}in;width:${p.w}in;height:${p.h}in">
        <div class="inner" style="font-size:${lineSize}pt">
          <div class="nm" style="font-size:${nameSize}pt">${esc(label.name)}</div>
          ${label.lines.map(x => `<div>${esc(x)}</div>`).join('')}
        </div>
      </div>`);
  });

  const guideBoxes = guides ? Array.from({ length: capacity(layout) }, (_, i) => {
    const p = positionAt(layout, i, offsetX, offsetY);
    return `<div class="guide" style="left:${p.x}in;top:${p.y}in;width:${p.w}in;height:${p.h}in"></div>`;
  }).join('') : '';

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Labels — ${esc(l.name)}</title>
<style>
  @page { size: 8.5in 11in; margin: 0; }
  html,body { margin:0; padding:0; }
  body { font-family: Helvetica, Arial, sans-serif; -webkit-print-color-adjust: exact; }
  .sheet { position:relative; width:8.5in; height:11in; overflow:hidden; }
  .lbl { position:absolute; overflow:hidden; box-sizing:border-box; padding:0.09in 0.12in;
         display:flex; align-items:center; }
  .lbl .inner { width:100%; line-height:1.25; }
  .lbl .nm { font-weight:700; }
  .guide { position:absolute; box-sizing:border-box; border:1px dashed #bbb; }
  .bar { font:13px system-ui; padding:10px 14px; background:#111; color:#fff; }
  .bar button { font:13px system-ui; padding:7px 14px; margin-left:8px; border:0;
                border-radius:6px; background:#fff; color:#111; cursor:pointer; }
  @media print { .bar { display:none; } .guide { display:none; } }
</style></head><body>
<div class="bar">
  ${l.name} · ${placed.length} label${placed.length === 1 ? '' : 's'} placed
  · print at 100% scale, no "fit to page"
  <button onclick="window.print()">Print</button>
</div>
<div class="sheet">${guideBoxes}${placed.join('')}</div>
</body></html>`;
}

return { LAYOUTS, capacity, positionAt, freePositions, renderSheet };

})();

/* ------------------------------------------------ bundled: central.js --- */
const central = (() => {
/* Central accounts — the same file in every app.
 *
 * One account works everywhere: My Apps holds the passwords and the plans, and
 * each app asks it. The app proves itself with a slug and a secret that live in
 * its environment variables, never in this source.
 *
 * Three things this deliberately does:
 *
 *  - Never locks anybody out. My Apps runs on a free plan that sleeps, so the
 *    first call after an idle spell can take the best part of a minute. Calls
 *    retry once, and every caller is expected to fall back to its own local
 *    password if central cannot be reached at all.
 *
 *  - Tells the app whether an account exists (`known`), which the generic
 *    "wrong email or password" message hides from the browser. That is what
 *    lets an app recognise an old local-only account and migrate it, without
 *    letting a stranger discover which emails are registered. It is safe here
 *    because the caller had to present the app secret to ask.
 *
 *  - Reports `unavailable` rather than pretending a failure is a wrong
 *    password, so the caller can tell "no" apart from "couldn't ask".
 */

const URL_BASE = (process.env.MY_APPS_URL || '').replace(/\/+$/, '');
const SLUG = process.env.MY_APPS_SLUG || '';
const SECRET = process.env.MY_APPS_SECRET || '';

const enabled = () => Boolean(URL_BASE && SLUG && SECRET);

async function call(path, body, { timeout = 12000, retry = true } = {}) {
  if (!enabled()) {
    return { ok: false, unavailable: true, status: 503, error: 'Central accounts are not configured' };
  }
  try {
    const res = await fetch(URL_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ slug: SLUG, secret: SECRET }, body)),
      signal: AbortSignal.timeout(timeout)
    });
    /* Insist on a JSON answer. If the other end is an older build that has no
       such route, it may well answer 200 with an HTML sign-in page — and
       treating that as "yes, signed in" would be the worst possible bug. */
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await res.json().catch(() => null) : null;
    if (!data || typeof data !== 'object') {
      return { ok: false, unavailable: true, status: res.status,
               error: 'Accounts service gave an answer this app did not understand' };
    }
    if (res.ok) return Object.assign({ ok: true }, data);
    // 5xx is central having a bad day, not an answer about this account.
    if (res.status >= 500) {
      if (retry) return call(path, body, { timeout: 25000, retry: false });
      return { ok: false, unavailable: true, status: res.status, error: 'Accounts service is unavailable' };
    }
    return Object.assign({ ok: false, status: res.status, error: data.error || 'Rejected' }, data);
  } catch (e) {
    // A cold start on the free plan looks exactly like a timeout. Wait longer once.
    if (retry) return call(path, body, { timeout: 40000, retry: false });
    return { ok: false, unavailable: true, status: 503, error: 'Accounts service is unreachable' };
  }
}

/* Wake My Apps up before anyone needs it.
 *
 * On the free plan it sleeps after fifteen idle minutes and takes the best part
 * of a minute to come back. Signing in would then take that minute. So the page
 * that shows the sign-in form pings it first: by the time an email and password
 * have been typed, it is already awake. Fire and forget — a failure here means
 * nothing, the sign-in path handles being unable to reach it. */
let lastWarm = 0;
function warm() {
  if (!enabled() || Date.now() - lastWarm < 60000) return;
  lastWarm = Date.now();
  fetch(URL_BASE + '/healthz', { signal: AbortSignal.timeout(45000) }).catch(() => {});
}

const login = (email, password) => call('/api/v1/auth/login', { email, password });

const register = ({ email, password, name, code }) =>
  call('/api/v1/auth/register', { email, password, name, code });

const changePassword = ({ email, oldPassword, newPassword }) =>
  call('/api/v1/auth/change-password', { email, oldPassword, newPassword });

const status = ({ email }) => call('/api/v1/status', { account: email });

return { enabled, warm, login, register, changePassword, status, call };

})();

/* ----------------------------------------------------- bundled: db.js --- */
const { q, init } = (() => {
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: /localhost|127\.0\.0\.1|sslmode=disable/.test(connectionString) ? false : { rejectUnauthorized: false },
  max: 5
});

const q = (text, params) => pool.query(text, params);

const DEFAULT_TEMPLATE = `AFFIDAVIT OF SERVICE

{{court}}

{{plaintiff}}, Plaintiff
    vs.
{{defendant}}, Defendant

Case No. {{case_number}}

STATE OF ______________  )
                         ) ss.
COUNTY OF ____________   )

The undersigned, being first duly sworn, deposes and says that he/she is over the
age of eighteen years, is not a party to this action, and is authorized to serve
process in the jurisdiction where service was effected.

That on {{served_date}} at {{served_time}}, at {{service_address}}, the undersigned
served the following documents: {{documents}}

upon {{recipient_name}} by {{served_manner}} service, by delivering a true and
correct copy to {{served_person}}.

Description of person served: {{served_description}}

RECORD OF ATTEMPTS:
{{attempts_list}}

GPS coordinates of service: {{served_gps}}

Fee for service: {{client_fee}}

I declare under penalty of perjury that the foregoing is true and correct.

_______________________________        Date: {{today}}
{{server_name}}
Process Server{{server_license}}

Subscribed and sworn to before me this ______ day of ______________, 20____.

_______________________________
Notary Public`;

async function init() {
  await q(SCHEMA);

  // seed admin
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const { rows } = await q('SELECT id FROM users WHERE role = $1 LIMIT 1', ['admin']);
  if (!rows.length) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'changeme123', 10);
    await q(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'admin')
       ON CONFLICT (email) DO NOTHING`,
      [process.env.ADMIN_NAME || 'Administrator', email, hash]
    );
    console.log('Seeded admin user:', email);
  }

  // Account recovery. Passwords are stored hashed, so a forgotten one can only
  // be replaced, never read. Set ADMIN_RESET_PASSWORD, redeploy, sign in, then
  // clear the variable so it isn't left lying around in the service config.
  const reset = process.env.ADMIN_RESET_PASSWORD;
  if (reset && reset.length >= 8) {
    const target = (process.env.ADMIN_EMAIL || '').toLowerCase();
    const hash = await bcrypt.hash(reset, 10);
    const { rows: hit } = target
      ? await q('UPDATE users SET password_hash=$1, active=TRUE WHERE lower(email)=$2 RETURNING email', [hash, target])
      : await q(`UPDATE users SET password_hash=$1, active=TRUE
                 WHERE id = (SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1) RETURNING email`, [hash]);
    console.log(hit.length
      ? 'ADMIN PASSWORD RESET applied for ' + hit[0].email + ' — clear ADMIN_RESET_PASSWORD now.'
      : 'ADMIN PASSWORD RESET requested but no user matched ' + (target || '(no admin found)'));
  } else if (reset) {
    console.log('ADMIN_RESET_PASSWORD ignored: must be at least 8 characters.');
  }

  // Log who can actually sign in — the fastest answer to "my login doesn't work".
  const who = await q("SELECT email, role, active FROM users ORDER BY role, email");
  console.log('Accounts: ' + who.rows.map(u => `${u.email} (${u.role}${u.active ? '' : ', INACTIVE'})`).join(', '));

  const t = await q('SELECT count(*)::int AS n FROM affidavit_templates');
  if (!t.rows[0].n) {
    await q(
      `INSERT INTO affidavit_templates (name, jurisdiction, body, is_default)
       VALUES ($1,$2,$3,TRUE)`,
      ['General Affidavit of Service', 'Generic', DEFAULT_TEMPLATE]
    );
  }
}

return { q, pool, init, DEFAULT_TEMPLATE };

})();

const app = express();
const BUILD = '2026-08-31.13';           // shown in Setup so uploads can be confirmed
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TZ = process.env.TIMEZONE || 'America/New_York';

app.use(express.json({ limit: '14mb' }));
app.use(cookieParser());

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

/* Sign in.
 *
 * My Apps holds the account, so one sign-in works across every app. But this is
 * the tool the day's work runs on, and My Apps sits on a free plan that sleeps,
 * so being unable to reach it must never mean being unable to work. Hence a
 * local mirror of the password, refreshed on every successful central sign-in.
 *
 * The order matters:
 *   central says yes          -> in, and the mirror is refreshed
 *   central says no, knows it -> refused (central is the authority)
 *   central has never heard of them -> fall back to the local password, and if
 *                                that works, enrol the account centrally
 *   central unreachable       -> fall back to the mirror, and say so in the log
 */
async function localUserFor(email) {
  const { rows } = await q('SELECT * FROM users WHERE lower(email)=$1', [email]);
  return rows[0] || null;
}

async function mirrorPassword(userId, password) {
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(password, 10), userId]);
}

function issueSession(res, user) {
  res.cookie('st_token', sign(user), {
    httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5,
    secure: process.env.NODE_ENV === 'production'
  });
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

app.post('/api/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const WRONG = { error: 'Wrong email or password' };

  const user = await localUserFor(email);
  const localOk = () => user && user.active && bcrypt.compare(password, user.password_hash);

  if (!central.enabled()) {
    if (!(await localOk())) return res.status(401).json(WRONG);
    return res.json(issueSession(res, user));
  }

  let c = await central.login(email, password);
  if (c.ok && !c.user) {
    c = { ok: false, unavailable: true, error: 'Accounts service gave an answer this app did not understand' };
  }

  if (c.ok) {
    // Jobs point at a local user row, so every central account needs one here.
    let u = user;
    if (!u) {
      const { rows } = await q(
        `INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,'server')
         RETURNING id,name,email,role,active`,
        [c.user.name || email.split('@')[0], email, await bcrypt.hash(password, 10)]);
      u = rows[0];
      console.log(`Central account ${email} signed in for the first time — local record created`);
    } else {
      if (!u.active) return res.status(401).json({ error: 'This account has been turned off in ServeTrack' });
      await mirrorPassword(u.id, password);
    }
    return res.json(issueSession(res, u));
  }

  if (c.unavailable) {
    if (!(await localOk())) return res.status(401).json(WRONG);
    console.warn(`My Apps unreachable (${c.error}) — ${email} signed in against the local password`);
    return res.json(issueSession(res, user));
  }

  if (c.suspended) return res.status(401).json({ error: 'This account has been suspended' });

  // Central knows this account and rejected the password: that is the answer.
  if (c.known) return res.status(401).json(WRONG);

  // Central has never seen it. An account from before central sign-in existed —
  // check it here, and if it is good, hand it over to My Apps for next time.
  if (!(await localOk())) return res.status(401).json(WRONG);
  const enrol = await central.register({ email, password, name: user.name });
  console.log(enrol.ok
    ? `Local account ${email} enrolled with My Apps`
    : `Could not enrol ${email} with My Apps: ${enrol.error}`);
  return res.json(issueSession(res, user));
}));

app.post('/api/logout', (req, res) => { res.clearCookie('st_token'); res.json({ ok: true }); });

app.get('/api/me', auth, (req, res) => res.json(req.user));

/* Changing a password changes it everywhere, because there is only one.
   The old password is required when central holds the account — it is the only
   thing proving the person at the keyboard is the account holder and not
   somebody who walked up to an unlocked phone. */
app.post('/api/me/password', auth, wrap(async (req, res) => {
  const pw = String(req.body.password || '');
  const old = String(req.body.old_password || '');
  if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  if (central.enabled()) {
    const c = await central.changePassword({ email: req.user.email, oldPassword: old, newPassword: pw });
    if (c.ok) {
      await mirrorPassword(req.user.id, pw);
      return res.json({ ok: true, everywhere: true });
    }
    // Central holds this account and said no. That is the answer.
    if (!c.unavailable && c.known) return res.status(c.status || 400).json({ error: c.error });
    if (!c.unavailable && c.status && c.status !== 401) {
      return res.status(c.status).json({ error: c.error });
    }

    // Either central is unreachable, or it has never heard of this account.
    // Check the current password here before changing anything.
    const { rows } = await q('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!(await bcrypt.compare(old, rows[0].password_hash))) {
      return res.status(401).json({ error: 'Current password is wrong' });
    }
    await mirrorPassword(req.user.id, pw);
    if (c.unavailable) {
      console.warn(`Password for ${req.user.email} changed here only — My Apps was unreachable`);
      return res.json({ ok: true, everywhere: false });
    }
    const enrol = await central.register({ email: req.user.email, password: pw, name: req.user.name });
    console.log(enrol.ok
      ? `${req.user.email} enrolled with My Apps while changing their password`
      : `Could not enrol ${req.user.email} with My Apps: ${enrol.error}`);
    return res.json({ ok: true, everywhere: enrol.ok });
  }

  await mirrorPassword(req.user.id, pw);
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
  const password = String(b.password || 'changeme123');
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await q(
    `INSERT INTO users (name,email,password_hash,role,phone,license_no,county,default_pay)
     VALUES ($1,lower($2),$3,$4,$5,$6,$7,$8) RETURNING id,name,email,role,phone,license_no,county,default_pay,active`,
    [b.name, b.email, hash, b.role || 'server', b.phone || null, b.license_no || null, b.county || null, b.default_pay || 0]
  );
  const user = rows[0];
  // The same person, added once, works in every app.
  const c = await centralEnrol(user.email, password, user.name);
  res.json(Object.assign(user, { central: c.note }));
}));

/* Create the central account, and only create it.
 *
 * Deliberately never overwrites an existing one. Somebody holding a valid
 * access code must not be able to sign up as an email that already belongs to
 * someone, and so take over their account in every app. If the email is already
 * spoken for centrally, they keep the password they already have. */
async function centralEnrol(email, password, name) {
  if (!central.enabled()) return { ok: false, note: null };
  const made = await central.register({ email, password, name });
  if (made.ok) return { ok: true, note: 'Account created for every app' };
  if (made.status === 409) {
    return { ok: true, note: 'That email already has an account — its existing password still applies' };
  }
  console.warn(`Central account create failed for ${email}: ${made.error}`);
  return { ok: false, note: 'Created here only — My Apps said: ' + made.error };
}

/* An admin deliberately setting somebody's password: create the central account
   if there is none, otherwise reset it. This changes the password in every app,
   which is the point, and My Apps logs every one. */
async function centralReset(email, password, name) {
  if (!central.enabled()) return { ok: false, note: null };
  const made = await central.register({ email, password, name });
  if (made.ok) return { ok: true, note: 'Account created for every app' };
  if (made.status === 409) {
    const set = await central.call('/api/v1/auth/admin-set-password', { email, newPassword: password });
    if (set.ok) return { ok: true, note: 'Password updated for every app' };
    console.warn(`Central password reset failed for ${email}: ${set.error}`);
    return { ok: false, note: 'Set here only — My Apps said: ' + set.error };
  }
  console.warn(`Central account create failed for ${email}: ${made.error}`);
  return { ok: false, note: 'Set here only — My Apps said: ' + made.error };
}

app.patch('/api/users/:id', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  let centralNote = null;
  if (b.password) {
    const pw = String(b.password);
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(pw, 10), req.params.id]);
    const { rows: who } = await q('SELECT email,name FROM users WHERE id=$1', [req.params.id]);
    if (who.length) centralNote = (await centralReset(who[0].email, pw, who[0].name)).note;
  }
  const { rows } = await q(
    `UPDATE users SET name=COALESCE($1,name), email=COALESCE(lower($2),email), role=COALESCE($3,role),
       phone=COALESCE($4,phone), license_no=COALESCE($5,license_no), county=COALESCE($6,county),
       default_pay=COALESCE($7,default_pay), active=COALESCE($8,active)
     WHERE id=$9 RETURNING id,name,email,role,phone,license_no,county,default_pay,active`,
    [b.name, b.email, b.role, b.phone, b.license_no, b.county, b.default_pay, b.active, req.params.id]
  );
  res.json(Object.assign(rows[0], { central: centralNote }));
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
  // Only insert fields the caller actually supplied, so the column defaults in
  // schema.sql (status, service_type, priority) still apply instead of being
  // overwritten with nulls.
  const cols = ['job_number'];
  const params = [await nextJobNumber()];
  for (const f of JOB_FIELDS) {
    if (b[f] !== undefined && b[f] !== null && b[f] !== '') { cols.push(f); params.push(b[f]); }
  }
  const ph = params.map((_, i) => '$' + (i + 1)).join(',');
  const { rows } = await q(
    `INSERT INTO jobs (${cols.join(',')}) VALUES (${ph}) RETURNING *`, params
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

/* --------------------------------------------------- document auto-fill --- */

const MAX_PDF_BYTES = 10 * 1024 * 1024;

app.post('/api/parse-document', auth, admin, wrap(async (req, res) => {
  const b64 = String(req.body.data || '').replace(/^data:[^,]*,/, '');
  if (!b64) return res.status(400).json({ error: 'No file received' });
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'That file came through empty' });
  if (buf.length > MAX_PDF_BYTES) {
    return res.status(413).json({ error: 'That PDF is larger than 10 MB. Try just the first few pages.' });
  }
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') {
    return res.status(400).json({ error: 'That is not a PDF. Only PDF documents can be read.' });
  }

  let text = '';
  let pages = 0;
  try {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const result = await parser.getText();
    text = result.text || '';
    pages = result.total || result.pages || 0;
  } catch (e) {
    console.error('pdf parse failed:', e.message);
    return res.status(422).json({ error: 'Could not read that PDF: ' + e.message });
  }

  const letters = (text.match(/[A-Za-z]/g) || []).length;
  if (letters < 40) {
    return res.json({
      fields: {}, pages,
      warning: 'This PDF has no readable text — it is most likely a scan or photo of the papers. ' +
               'Fill the job in by hand, or ask the client for the original PDF from their filing system.'
    });
  }

  const fields = docparse.parse(text);
  res.json({ fields, pages, chars: text.length });
}));



/* -------------------------------------------------------- access codes --- */
/* Hand out a code instead of creating accounts by hand. The alphabet skips
   0/O/1/I so a code read aloud or off a scrap of paper can't be mistyped. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  const pick = n => Array.from(crypto.randomBytes(n))
    .map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${pick(4)}-${pick(4)}-${pick(4)}`;
}

const codeState = c => {
  if (c.revoked) return 'Revoked';
  if (c.expires_at && new Date(c.expires_at) < new Date(new Date().toDateString())) return 'Expired';
  if (c.used_count >= c.max_uses) return 'Used up';
  return 'Active';
};

app.get('/api/codes', auth, admin, wrap(async (req, res) => {
  const { rows } = await q(`
    SELECT c.*, u.name AS created_by_name,
      (SELECT json_agg(json_build_object('email', r.email, 'at', r.redeemed_at) ORDER BY r.redeemed_at)
       FROM code_redemptions r WHERE r.code_id = c.id) AS redemptions
    FROM access_codes c LEFT JOIN users u ON u.id = c.created_by
    ORDER BY c.created_at DESC LIMIT 200`);
  res.json(rows.map(c => Object.assign(c, { state: codeState(c), redemptions: c.redemptions || [] })));
}));

app.post('/api/codes', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  const role = b.role === 'admin' ? 'admin' : 'server';
  const maxUses = Math.min(500, Math.max(1, Number(b.max_uses) || 1));
  const { rows } = await q(
    `INSERT INTO access_codes (code, role, max_uses, expires_at, note, default_pay, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [newCode(), role, maxUses, b.expires_at || null, b.note || null, b.default_pay || 0, req.user.id]
  );
  res.json(Object.assign(rows[0], { state: 'Active', redemptions: [] }));
}));

app.patch('/api/codes/:id', auth, admin, wrap(async (req, res) => {
  const { rows } = await q(
    'UPDATE access_codes SET revoked = COALESCE($1, revoked) WHERE id=$2 RETURNING *',
    [typeof req.body.revoked === 'boolean' ? req.body.revoked : null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such code' });
  res.json(Object.assign(rows[0], { state: codeState(rows[0]) }));
}));

app.delete('/api/codes/:id', auth, admin, wrap(async (req, res) => {
  await q('DELETE FROM access_codes WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// Public: redeem a code to create your own account.
app.post('/api/redeem', wrap(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!code) return res.status(400).json({ error: 'Enter your access code' });
  if (!name) return res.status(400).json({ error: 'Enter your name' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (password.length < 8) return res.status(400).json({ error: 'Choose a password of at least 8 characters' });

  const { rows: cr } = await q('SELECT * FROM access_codes WHERE upper(code)=$1', [code]);
  const c = cr[0];

  /* Not one of ServeTrack's own codes. It may be a My Apps code, which is
     signed rather than stored — nothing here has ever seen it before, and that
     is by design. Let My Apps judge it. */
  if (!c) {
    if (!central.enabled()) return res.status(404).json({ error: "That code isn't recognised" });
    const { rows: taken } = await q('SELECT id FROM users WHERE lower(email)=$1', [email]);
    if (taken.length) return res.status(409).json({ error: 'An account already uses that email — sign in instead' });

    const made = await central.register({ email, password, name, code });
    if (!made.ok) {
      return res.status(made.unavailable ? 503 : (made.status || 400))
        .json({ error: made.unavailable ? "Couldn't reach the accounts service — try again in a minute" : made.error });
    }
    if (made.codeError) return res.status(410).json({ error: made.codeError });

    const { rows: ur } = await q(
      `INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,'server')
       RETURNING id,name,email,role`, [name, email, await bcrypt.hash(password, 10)]);
    console.log(`${email} signed up with a My Apps code — ${made.plan} until ${made.expires_on || 'n/a'}`);
    return res.json(issueSession(res, ur[0]));
  }

  const state = codeState(c);
  if (state !== 'Active') return res.status(410).json({ error: `That code is ${state.toLowerCase()}` });

  const { rows: existing } = await q('SELECT id FROM users WHERE lower(email)=$1', [email]);
  if (existing.length) return res.status(409).json({ error: 'An account already uses that email — sign in instead' });

  // Claim a use before creating the account, and only if one is still going:
  // two people redeeming the last use at once must not both get in.
  const { rows: claimed } = await q(
    `UPDATE access_codes SET used_count = used_count + 1
     WHERE id=$1 AND revoked=FALSE AND used_count < max_uses RETURNING *`, [c.id]);
  if (!claimed.length) return res.status(410).json({ error: 'That code has just been used up' });

  const hash = await bcrypt.hash(password, 10);
  const { rows: ur } = await q(
    `INSERT INTO users (name,email,password_hash,role,default_pay)
     VALUES ($1,$2,$3,$4,$5) RETURNING id,name,email,role`,
    [name, email, hash, c.role, c.default_pay || 0]
  );
  const user = ur[0];
  await q('INSERT INTO code_redemptions (code_id,user_id,email) VALUES ($1,$2,$3)', [c.id, user.id, email]);
  console.log(`Access code ${c.code} redeemed by ${email} as ${c.role}`);

  // The account they just made should be the one account they have everywhere.
  const enrol = await centralEnrol(email, password, name);
  if (!enrol.ok && central.enabled()) console.warn(`New account ${email} is local-only for now`);

  res.json(issueSession(res, user));
}));

/* --------------------------------------------------------- label sheets --- */

async function currentSheet(userId) {
  const { rows } = await q('SELECT * FROM label_sheets WHERE user_id=$1', [userId]);
  if (rows.length) return rows[0];
  const ins = await q(
    'INSERT INTO label_sheets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING *', [userId]
  );
  if (ins.rows.length) return ins.rows[0];
  return (await q('SELECT * FROM label_sheets WHERE user_id=$1', [userId])).rows[0];
}

app.get('/api/label-layouts', auth, (req, res) =>
  res.json(Object.entries(labels.LAYOUTS).map(([key, l]) => ({
    key, name: l.name, size: l.size, cols: l.cols, rows: l.rows, capacity: l.cols * l.rows
  }))));

app.get('/api/label-sheet', auth, wrap(async (req, res) => {
  const sheet = await currentSheet(req.user.id);
  res.json({
    layout: sheet.layout,
    used: sheet.used || [],
    offset_x: Number(sheet.offset_x),
    offset_y: Number(sheet.offset_y),
    capacity: labels.capacity(sheet.layout),
    free: labels.freePositions(sheet.layout, sheet.used || []).length
  });
}));

app.patch('/api/label-sheet', auth, wrap(async (req, res) => {
  const b = req.body;
  await currentSheet(req.user.id);
  const layout = b.layout && labels.LAYOUTS[b.layout] ? b.layout : null;

  // Changing layout invalidates the used-positions map: position 7 on a 30-up
  // sheet is not position 7 on a 10-up sheet.
  let used = null;
  if (Array.isArray(b.used)) {
    const cap = labels.capacity(layout || (await currentSheet(req.user.id)).layout);
    used = [...new Set(b.used.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < cap))].sort((x, y) => x - y);
  }
  if (layout && !Array.isArray(b.used)) used = [];

  const { rows } = await q(
    `UPDATE label_sheets SET
       layout   = COALESCE($1, layout),
       used     = COALESCE($2::int[], used),
       offset_x = COALESCE($3, offset_x),
       offset_y = COALESCE($4, offset_y),
       updated_at = NOW()
     WHERE user_id=$5 RETURNING *`,
    [layout, used, b.offset_x, b.offset_y, req.user.id]
  );
  const sheet = rows[0];
  res.json({
    layout: sheet.layout, used: sheet.used || [],
    offset_x: Number(sheet.offset_x), offset_y: Number(sheet.offset_y),
    capacity: labels.capacity(sheet.layout),
    free: labels.freePositions(sheet.layout, sheet.used || []).length
  });
}));

// Turn jobs into label content: who is being served and where.
async function labelsForJobs(user, ids) {
  if (!ids.length) return [];
  const own = user.role === 'admin' ? '' : ' AND assigned_to = ' + Number(user.id);
  const { rows } = await q(
    `SELECT id, job_number, recipient_name, address1, address2, city, state, zip
     FROM jobs WHERE id = ANY($1::int[])${own}`, [ids]
  );
  const byId = new Map(rows.map(r => [r.id, r]));
  return ids.map(id => byId.get(id)).filter(Boolean).map(j => {
    const lines = [];
    if (j.address1) lines.push(j.address1);
    if (j.address2) lines.push(j.address2);
    const cityLine = [j.city, [j.state, j.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (cityLine) lines.push(cityLine);
    return { name: j.recipient_name || j.job_number, lines };
  });
}

app.get('/print/labels', auth, wrap(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean);
  const sheet = await currentSheet(req.user.id);
  const content = await labelsForJobs(req.user, ids);
  if (!content.length) return res.status(400).send('Nothing to print — pick at least one job.');
  const free = labels.freePositions(sheet.layout, sheet.used || []).length;
  if (!free) {
    return res.status(409).send(
      'Every label on this sheet is marked used, so there is nowhere to print. ' +
      'Put a fresh sheet in and tap "Fresh sheet" in the label maker.');
  }
  res.send(labels.renderSheet({
    layout: sheet.layout,
    used: sheet.used || [],
    offsetX: Number(sheet.offset_x),
    offsetY: Number(sheet.offset_y),
    labels: content,
    guides: req.query.guides === '1'
  }));
}));

/* ------------------------------------------------------ portal probing --- */

app.get('/api/portals', auth, admin, (req, res) =>
  res.json(Object.entries(portal.PORTALS).map(([k, v]) => ({ key: k, label: v.label, start: v.start }))));

app.post('/api/portal-probe', auth, admin, wrap(async (req, res) => {
  const started = Date.now();
  const out = req.body.url
    ? await portal.probeUrl(String(req.body.url), { raw: req.body.raw })
    : await portal.probe(String(req.body.portal || ''));
  console.log('portal probe', req.body.url || req.body.portal, '->',
    out.error ? 'ERROR ' + out.error : out.status + ' ' + (out.title || ''), (Date.now() - started) + 'ms');
  res.json(out);
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
app.get('/api/build', (req, res) => res.json({ build: BUILD, probeTargets: !!process.env.PROBE_TARGETS }));
// Loading the app is the earliest warning that somebody is about to sign in,
// so this is where My Apps gets woken.
app.get('*', (req, res) => {
  central.warm();
  res.type('html').send(INDEX_HTML);
});

/* Boot-time portal probe.
 *
 * Set PROBE_TARGETS to a comma-separated list of portal keys or full URLs and
 * the server probes each one at startup and writes the result to the log. This
 * exists so reconnaissance can be driven from the deployment side: the portals
 * are unreachable from the environment this was written in, but the server can
 * see them. Output is chunked because long log lines get truncated.
 */
function logLong(prefix, text) {
  const SIZE = 1200;
  const total = Math.ceil(text.length / SIZE) || 1;
  for (let i = 0; i < total; i++) {
    console.log(`${prefix} [${i + 1}/${total}] ${text.slice(i * SIZE, (i + 1) * SIZE)}`);
  }
}

function parseTargets(raw) {
  const v = String(raw || '').trim();
  if (!v) return [];
  // A JSON array allows full control: method, body and headers, which the
  // comma-separated form cannot express. Anything else keeps the simple syntax.
  if (v.startsWith('[')) {
    try {
      const arr = JSON.parse(v);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      console.log('PROBE_TARGETS is not valid JSON: ' + e.message);
      return [];
    }
  }
  return v.split(',').map(s => s.trim()).filter(Boolean).map(t => {
    const [url, mode] = t.split('|');
    return {
      url,
      raw: /^raw/.test(mode || '') ? (Number((mode.split(':')[1] || 0)) || 6000) : 0
    };
  });
}

async function bootProbe() {
  const targets = parseTargets(process.env.PROBE_TARGETS);
  if (!targets.length) return;
  console.log(`=== PORTAL PROBE START: ${targets.length} target(s) ===`);
  for (const t of targets) {
    const label = t.label || t.url || t.portal || 'target';
    try {
      const out = t.url
        ? await portal.probeUrl(t.url, {
            raw: t.raw, method: t.method, body: t.body, headers: t.headers, warmup: t.warmup
          })
        : await portal.probe(t.portal);
      logLong('PROBE ' + label, JSON.stringify(out));
    } catch (e) {
      console.log('PROBE ' + label + ' THREW ' + (e && e.message ? e.message : String(e)));
    }
  }
  console.log('=== PORTAL PROBE END ===');
}

init()
  .then(() => app.listen(PORT, () => {
    console.log('ServeTrack listening on ' + PORT + ' (build ' + BUILD + ')');
    bootProbe().catch(e => console.log('bootProbe failed: ' + e.message));
  }))
  .catch(err => { console.error('Startup failed:', err); process.exit(1); });
