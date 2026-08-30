/* ServeTrack — process serving management.
 *
 * Single-file server. Bundles the barcode encoder, affidavit merge engine,
 * database layer and schema so the whole app deploys as three files:
 * server.js, index.html, package.json.
 */
const path = require('path');
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
  'ZXItYm94fQpodG1sLGJvZHl7bWFyZ2luOjA7cGFkZGluZzowfQpib2R5ewogIGZvbnQ6MTVweC8xLjUgLWFwcGxlLXN5c3RlbSxC' +
  'bGlua01hY1N5c3RlbUZvbnQsIlNlZ29lIFVJIixSb2JvdG8sSGVsdmV0aWNhLEFyaWFsLHNhbnMtc2VyaWY7CiAgYmFja2dyb3Vu' +
  'ZDp2YXIoLS1iZyk7IGNvbG9yOnZhcigtLWluayk7IC13ZWJraXQtdGV4dC1zaXplLWFkanVzdDoxMDAlOwp9CmF7Y29sb3I6dmFy' +
  'KC0tYnJhbmQtMil9CmJ1dHRvbixpbnB1dCxzZWxlY3QsdGV4dGFyZWF7Zm9udDppbmhlcml0O2NvbG9yOmluaGVyaXR9CgovKiAt' +
  'LS0tLS0tLS0tIHNoZWxsIC0tLS0tLS0tLS0gKi8KI2FwcHttaW4taGVpZ2h0OjEwMHZofQoudG9wYmFyewogIHBvc2l0aW9uOnN0' +
  'aWNreTt0b3A6MDt6LWluZGV4OjIwO2JhY2tncm91bmQ6dmFyKC0tYnJhbmQpO2NvbG9yOiNmZmY7CiAgZGlzcGxheTpmbGV4O2Fs' +
  'aWduLWl0ZW1zOmNlbnRlcjtnYXA6MTBweDtwYWRkaW5nOjEycHggMTRweDsKICBwYWRkaW5nLXRvcDpjYWxjKDEycHggKyBlbnYo' +
  'c2FmZS1hcmVhLWluc2V0LXRvcCkpOwp9Ci50b3BiYXIgLmJyYW5ke2ZvbnQtd2VpZ2h0OjcwMDtsZXR0ZXItc3BhY2luZzouMnB4' +
  'fQoudG9wYmFyIC5icmFuZCBzbWFsbHtkaXNwbGF5OmJsb2NrO2ZvbnQtd2VpZ2h0OjQwMDtmb250LXNpemU6MTFweDtvcGFjaXR5' +
  'Oi43O2xldHRlci1zcGFjaW5nOi40cHh9Ci50b3BiYXIgLnNwYWNlcntmbGV4OjF9Ci50b3BiYXIgYnV0dG9ue2JhY2tncm91bmQ6' +
  'cmdiYSgyNTUsMjU1LDI1NSwuMTQpO2JvcmRlcjowO2NvbG9yOiNmZmY7cGFkZGluZzo3cHggMTJweDtib3JkZXItcmFkaXVzOjhw' +
  'eH0KLndyYXB7bWF4LXdpZHRoOjExMDBweDttYXJnaW46MCBhdXRvO3BhZGRpbmc6MTRweCAxNHB4IDk2cHh9CgovKiBib3R0b20g' +
  'dGFicyAobW9iaWxlKSAqLwoudGFic3sKICBwb3NpdGlvbjpmaXhlZDtsZWZ0OjA7cmlnaHQ6MDtib3R0b206MDt6LWluZGV4OjMw' +
  'O2JhY2tncm91bmQ6I2ZmZjtib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1saW5lKTsKICBkaXNwbGF5OmZsZXg7cGFkZGluZy1i' +
  'b3R0b206ZW52KHNhZmUtYXJlYS1pbnNldC1ib3R0b20pOwp9Ci50YWJzIGJ1dHRvbnsKICBmbGV4OjE7YmFja2dyb3VuZDpub25l' +
  'O2JvcmRlcjowO3BhZGRpbmc6OXB4IDFweCAxMHB4O2ZvbnQtc2l6ZToxMHB4O2NvbG9yOnZhcigtLW11dGVkKTsKICBkaXNwbGF5' +
  'OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6M3B4OwogIG1pbi13aWR0aDowO3doaXRl' +
  'LXNwYWNlOm5vd3JhcDtsZXR0ZXItc3BhY2luZzotLjFweDsKfQoudGFicyBidXR0b24gLmlje2ZvbnQtc2l6ZToxOXB4O2xpbmUt' +
  'aGVpZ2h0OjF9Ci50YWJzIGJ1dHRvbi5vbntjb2xvcjp2YXIoLS1icmFuZCk7Zm9udC13ZWlnaHQ6NjAwfQoKLyogLS0tLS0tLS0t' +
  'LSBwaWVjZXMgLS0tLS0tLS0tLSAqLwouY2FyZHtiYWNrZ3JvdW5kOnZhcigtLWNhcmQpO2JvcmRlcjoxcHggc29saWQgdmFyKC0t' +
  'bGluZSk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yKTtib3gtc2hhZG93OnZhcigtLXNoKTtwYWRkaW5nOjE0cHg7bWFyZ2luLWJvdHRv' +
  'bToxMnB4fQouY2FyZCBoMnttYXJnaW46MCAwIDEwcHg7Zm9udC1zaXplOjE1cHh9Ci5jYXJkIGgyIC5zdWJ7Zm9udC13ZWlnaHQ6' +
  'NDAwO2NvbG9yOnZhcigtLW11dGVkKTtmb250LXNpemU6MTJweH0KaDEucGFnZXtmb250LXNpemU6MjBweDttYXJnaW46NHB4IDAg' +
  'MTRweH0KLnJvd3tkaXNwbGF5OmZsZXg7Z2FwOjhweDtmbGV4LXdyYXA6d3JhcDthbGlnbi1pdGVtczpjZW50ZXJ9Ci5ncmlke2Rp' +
  'c3BsYXk6Z3JpZDtnYXA6MTBweH0KQG1lZGlhKG1pbi13aWR0aDo3MjBweCl7IC5nMntncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZy' +
  'IDFmcn0gLmcze2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMywxZnIpfSB9Cgouc3RhdHN7ZGlzcGxheTpncmlkO2dyaWQt' +
  'dGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMiwxZnIpO2dhcDoxMHB4O21hcmdpbi1ib3R0b206MTJweH0KQG1lZGlhKG1pbi13aWR0' +
  'aDo3MjBweCl7LnN0YXRze2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNCwxZnIpfX0KLnN0YXR7YmFja2dyb3VuZDojZmZm' +
  'O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yKTtwYWRkaW5nOjEycHg7Ym94LXNoYWRv' +
  'dzp2YXIoLS1zaCl9Ci5zdGF0IC5ue2ZvbnQtc2l6ZToyNnB4O2ZvbnQtd2VpZ2h0OjcwMDtsaW5lLWhlaWdodDoxLjF9Ci5zdGF0' +
  'IC5se2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW4tdG9wOjJweH0KLnN0YXQuYWxlcnQgLm57Y29sb3I6' +
  'dmFyKC0tYmFkKX0KLnN0YXQuZ29vZCAubntjb2xvcjp2YXIoLS1vayl9CgouYnRue2JhY2tncm91bmQ6dmFyKC0tYnJhbmQpO2Nv' +
  'bG9yOiNmZmY7Ym9yZGVyOjA7cGFkZGluZzoxMXB4IDE2cHg7Ym9yZGVyLXJhZGl1czoxMHB4O2ZvbnQtd2VpZ2h0OjYwMDtjdXJz' +
  'b3I6cG9pbnRlcn0KLmJ0bjphY3RpdmV7b3BhY2l0eTouODV9Ci5idG4uc2Vje2JhY2tncm91bmQ6I2ZmZjtjb2xvcjp2YXIoLS1p' +
  'bmspO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSl9Ci5idG4uZ2hvc3R7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjp2' +
  'YXIoLS1icmFuZC0yKTtib3JkZXI6MDtwYWRkaW5nOjhweCA0cHg7Zm9udC13ZWlnaHQ6NjAwfQouYnRuLm5hdntiYWNrZ3JvdW5k' +
  'OnZhcigtLWFjY2VudCl9Ci5idG4ub2t7YmFja2dyb3VuZDp2YXIoLS1vayl9Ci5idG4uYmFke2JhY2tncm91bmQ6dmFyKC0tYmFk' +
  'KX0KLmJ0bi5zbXtwYWRkaW5nOjdweCAxMXB4O2ZvbnQtc2l6ZToxM3B4O2JvcmRlci1yYWRpdXM6OHB4fQouYnRuLmJsb2Nre3dp' +
  'ZHRoOjEwMCU7ZGlzcGxheTpibG9ja30KLmJ0bltkaXNhYmxlZF17b3BhY2l0eTouNX0KCmxhYmVse2Rpc3BsYXk6YmxvY2s7Zm9u' +
  'dC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW46MCAwIDRweH0KaW5wdXQsc2VsZWN0' +
  'LHRleHRhcmVhewogIHdpZHRoOjEwMCU7cGFkZGluZzoxMXB4IDEycHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3Jk' +
  'ZXItcmFkaXVzOjEwcHg7YmFja2dyb3VuZDojZmZmOwp9CmlucHV0OmZvY3VzLHNlbGVjdDpmb2N1cyx0ZXh0YXJlYTpmb2N1c3tv' +
  'dXRsaW5lOjJweCBzb2xpZCAjY2ZlMGYyO2JvcmRlci1jb2xvcjp2YXIoLS1icmFuZC0yKX0KdGV4dGFyZWF7bWluLWhlaWdodDo5' +
  'MHB4O3Jlc2l6ZTp2ZXJ0aWNhbH0KLmZpZWxke21hcmdpbi1ib3R0b206MTBweH0KLmhpbnR7Zm9udC1zaXplOjEycHg7Y29sb3I6' +
  'dmFyKC0tbXV0ZWQpO21hcmdpbi10b3A6NHB4fQoKLmxpc3R7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6' +
  'OHB4fQouaXRlbXsKICBiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItbGVmdDo0cHgg' +
  'c29saWQgdmFyKC0tbGluZSk7CiAgYm9yZGVyLXJhZGl1czp2YXIoLS1yKTtwYWRkaW5nOjExcHggMTJweDtib3gtc2hhZG93OnZh' +
  'cigtLXNoKTtjdXJzb3I6cG9pbnRlcjsKfQouaXRlbS5wLVJ1c2h7Ym9yZGVyLWxlZnQtY29sb3I6dmFyKC0td2Fybil9Ci5pdGVt' +
  'LnAtU2FtZURheXtib3JkZXItbGVmdC1jb2xvcjp2YXIoLS1ydXNoKX0KLml0ZW0ub3ZlcmR1ZXtib3JkZXItbGVmdC1jb2xvcjp2' +
  'YXIoLS1iYWQpfQouaXRlbSAudHtmb250LXdlaWdodDo2MDB9Ci5pdGVtIC5te2ZvbnQtc2l6ZToxMi41cHg7Y29sb3I6dmFyKC0t' +
  'bXV0ZWQpO21hcmdpbi10b3A6MnB4fQouaXRlbSAucntkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47' +
  'YWxpZ24taXRlbXM6ZmxleC1zdGFydDtnYXA6MTBweH0KCi5waWxse2Rpc3BsYXk6aW5saW5lLWJsb2NrO2ZvbnQtc2l6ZToxMXB4' +
  'O2ZvbnQtd2VpZ2h0OjcwMDtwYWRkaW5nOjNweCA4cHg7Ym9yZGVyLXJhZGl1czo5OXB4O2JhY2tncm91bmQ6I2VlZjFmNTtjb2xv' +
  'cjojNDE1MDZiO3doaXRlLXNwYWNlOm5vd3JhcH0KLnBpbGwuU2VydmVke2JhY2tncm91bmQ6I2UzZjVlYTtjb2xvcjp2YXIoLS1v' +
  'ayl9Ci5waWxsLlBlbmRpbmd7YmFja2dyb3VuZDojZmRmMGUzO2NvbG9yOnZhcigtLXdhcm4pfQoucGlsbC5Bc3NpZ25lZHtiYWNr' +
  'Z3JvdW5kOiNlN2VlZmI7Y29sb3I6dmFyKC0tYnJhbmQtMil9Ci5waWxsLkF0dGVtcHRlZHtiYWNrZ3JvdW5kOiNmZGYzZDM7Y29s' +
  'b3I6IzhhNjEwMH0KLnBpbGwuTm9uRXN0e2JhY2tncm91bmQ6I2ZkZThlNjtjb2xvcjp2YXIoLS1iYWQpfQoucGlsbC5DYW5jZWxs' +
  'ZWQsLnBpbGwuT25Ib2xke2JhY2tncm91bmQ6I2VjZWZmMztjb2xvcjojNWE2NDcyfQoucGlsbC5ydXNoe2JhY2tncm91bmQ6I2Zk' +
  'ZWNkYztjb2xvcjp2YXIoLS1ydXNoKX0KLnBpbGwuUGFpZHtiYWNrZ3JvdW5kOiNlM2Y1ZWE7Y29sb3I6dmFyKC0tb2spfQoucGls' +
  'bC5PcGVuLC5waWxsLlVucGFpZHtiYWNrZ3JvdW5kOiNmZGYwZTM7Y29sb3I6dmFyKC0td2Fybil9Cgp0YWJsZS50Ymx7d2lkdGg6' +
  'MTAwJTtib3JkZXItY29sbGFwc2U6Y29sbGFwc2U7Zm9udC1zaXplOjEzLjVweH0KdGFibGUudGJsIHRoe3RleHQtYWxpZ246bGVm' +
  'dDtmb250LXNpemU6MTEuNXB4O3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtsZXR0ZXItc3BhY2luZzouNHB4O2NvbG9yOnZhcigt' +
  'LW11dGVkKTtwYWRkaW5nOjZweCA2cHg7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tbGluZSl9CnRhYmxlLnRibCB0ZHtw' +
  'YWRkaW5nOjlweCA2cHg7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tbGluZSk7dmVydGljYWwtYWxpZ246dG9wfQp0YWJs' +
  'ZS50YmwgdHI6bGFzdC1jaGlsZCB0ZHtib3JkZXItYm90dG9tOjB9Ci5udW17dGV4dC1hbGlnbjpyaWdodH0KCi5hdHR7Ym9yZGVy' +
  'LWxlZnQ6M3B4IHNvbGlkIHZhcigtLWxpbmUpO3BhZGRpbmc6OHB4IDAgOHB4IDEycHg7bWFyZ2luLWJvdHRvbTo4cHh9Ci5hdHQu' +
  'U2VydmVke2JvcmRlci1sZWZ0LWNvbG9yOnZhcigtLW9rKX0KLmF0dCAuaHtmb250LXdlaWdodDo2MDA7Zm9udC1zaXplOjEzLjVw' +
  'eH0KLmF0dCAubXtmb250LXNpemU6MTIuNXB4O2NvbG9yOnZhcigtLW11dGVkKX0KCi5zaGVldHtwb3NpdGlvbjpmaXhlZDtpbnNl' +
  'dDowO3otaW5kZXg6NTA7YmFja2dyb3VuZDpyZ2JhKDEyLDE4LDI4LC41KTtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6ZmxleC1l' +
  'bmQ7anVzdGlmeS1jb250ZW50OmNlbnRlcn0KLnNoZWV0IC5pbm5lcntiYWNrZ3JvdW5kOiNmZmY7d2lkdGg6MTAwJTttYXgtd2lk' +
  'dGg6NjQwcHg7bWF4LWhlaWdodDo5MnZoO292ZXJmbG93OmF1dG87Ym9yZGVyLXJhZGl1czoxNnB4IDE2cHggMCAwO3BhZGRpbmc6' +
  'MTZweCAxNnB4IGNhbGMoMjBweCArIGVudihzYWZlLWFyZWEtaW5zZXQtYm90dG9tKSl9CkBtZWRpYShtaW4td2lkdGg6NzIwcHgp' +
  'ey5zaGVldHthbGlnbi1pdGVtczpjZW50ZXJ9LnNoZWV0IC5pbm5lcntib3JkZXItcmFkaXVzOjE2cHg7bWF4LWhlaWdodDo4OHZo' +
  'fX0KLnNoZWV0IGgye21hcmdpbjowIDAgMTJweDtmb250LXNpemU6MTdweH0KLnNoZWV0IC5jbG9zZXtwb3NpdGlvbjphYnNvbHV0' +
  'ZTtyaWdodDoxNHB4O3RvcDoxNHB4fQoKLnRvYXN0e3Bvc2l0aW9uOmZpeGVkO2xlZnQ6NTAlO3RyYW5zZm9ybTp0cmFuc2xhdGVY' +
  'KC01MCUpO2JvdHRvbTo3OHB4O3otaW5kZXg6NjA7YmFja2dyb3VuZDojMTIxNjFmO2NvbG9yOiNmZmY7cGFkZGluZzoxMXB4IDE2' +
  'cHg7Ym9yZGVyLXJhZGl1czoxMHB4O2ZvbnQtc2l6ZToxNHB4O21heC13aWR0aDo5MCU7Ym94LXNoYWRvdzowIDhweCAyNHB4IHJn' +
  'YmEoMCwwLDAsLjI1KX0KLnRvYXN0LmJhZHtiYWNrZ3JvdW5kOnZhcigtLWJhZCl9CgouZW1wdHl7dGV4dC1hbGlnbjpjZW50ZXI7' +
  'Y29sb3I6dmFyKC0tbXV0ZWQpO3BhZGRpbmc6MjhweCAxMHB4O2ZvbnQtc2l6ZToxNHB4fQoudG9rZW5ze2Rpc3BsYXk6ZmxleDtm' +
  'bGV4LXdyYXA6d3JhcDtnYXA6NnB4O21hcmdpbi10b3A6NnB4fQoudG9rZW5zIGJ1dHRvbntmb250OjEycHgvMSBtb25vc3BhY2U7' +
  'cGFkZGluZzo2cHggOHB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojZjhmYWZjO2JvcmRlci1yYWRp' +
  'dXM6NnB4O2N1cnNvcjpwb2ludGVyfQpwcmUucHJldntiYWNrZ3JvdW5kOiNmOGZhZmM7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1s' +
  'aW5lKTtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjEycHg7d2hpdGUtc3BhY2U6cHJlLXdyYXA7Zm9udDoxMnB4LzEuNSAiQ291' +
  'cmllciBOZXciLG1vbm9zcGFjZTttYXgtaGVpZ2h0OjM0MHB4O292ZXJmbG93OmF1dG99CiNyZWFkZXJ7d2lkdGg6MTAwJTtib3Jk' +
  'ZXItcmFkaXVzOjEycHg7b3ZlcmZsb3c6aGlkZGVuO2JhY2tncm91bmQ6IzAwMDttaW4taGVpZ2h0OjI0MHB4fQojcmVhZGVyIHZp' +
  'ZGVve3dpZHRoOjEwMCU7ZGlzcGxheTpibG9ja30KCi5sb2dpbnttYXgtd2lkdGg6MzgwcHg7bWFyZ2luOjh2aCBhdXRvO3BhZGRp' +
  'bmc6MCAxOHB4fQoubG9naW4gLmxvZ297dGV4dC1hbGlnbjpjZW50ZXI7bWFyZ2luLWJvdHRvbToyMHB4fQoubG9naW4gLmxvZ28g' +
  'Yntmb250LXNpemU6MjZweDtjb2xvcjp2YXIoLS1icmFuZCk7bGV0dGVyLXNwYWNpbmc6LS40cHh9Ci5sb2dpbiAubG9nbyBkaXZ7' +
  'Zm9udC1zaXplOjEyLjVweDtjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luLXRvcDoycHh9CgouZHJvcHpvbmV7YmFja2dyb3VuZDoj' +
  'ZjhmYWZjO2JvcmRlcjoxLjVweCBkYXNoZWQgI2M2ZDJlMDtib3JkZXItcmFkaXVzOnZhcigtLXIpO3BhZGRpbmc6MTJweDttYXJn' +
  'aW4tYm90dG9tOjE0cHh9Ci5kcm9wem9uZSBpbnB1dFt0eXBlPWZpbGVde2JhY2tncm91bmQ6I2ZmZjtwYWRkaW5nOjlweDtmb250' +
  'LXNpemU6MTNweH0KLmRyb3B6b25lIC5oaW50e21hcmdpbi10b3A6OHB4O2xpbmUtaGVpZ2h0OjEuNDV9CgovKiBsYWJlbCBzaGVl' +
  'dCBncmlkICovCi5sZ3JpZHtkaXNwbGF5OmdyaWQ7Z2FwOjNweDtiYWNrZ3JvdW5kOiNlZWYxZjU7cGFkZGluZzo2cHg7Ym9yZGVy' +
  'LXJhZGl1czo4cHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX0KLmxjZWxse2FzcGVjdC1yYXRpbzo1LzI7Ym9yZGVyOjFw' +
  'eCBzb2xpZCAjYzlkNGUwO2JhY2tncm91bmQ6I2ZmZjtib3JkZXItcmFkaXVzOjNweDtjdXJzb3I6cG9pbnRlcjsKICBmb250OjYw' +
  'MCAxMXB4IHN5c3RlbS11aTtjb2xvcjp2YXIoLS1tdXRlZCk7cGFkZGluZzowO21pbi1oZWlnaHQ6MjJweDtkaXNwbGF5OmZsZXg7' +
  'CiAgYWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXJ9Ci5sY2VsbC51c2Vke2JhY2tncm91bmQ6I2Q3ZGRl' +
  'NTtjb2xvcjojOGE5NGEyO2JvcmRlci1jb2xvcjojYzJjY2Q4fQoubGNlbGwubmV4dHtiYWNrZ3JvdW5kOiNlM2Y1ZWE7Ym9yZGVy' +
  'LWNvbG9yOnZhcigtLW9rKTtjb2xvcjp2YXIoLS1vayl9Ci5sY2VsbDphY3RpdmV7dHJhbnNmb3JtOnNjYWxlKC45Nil9Cgo8L3N0' +
  'eWxlPgo8bGluayByZWw9Imljb24iIGhyZWY9ImRhdGE6aW1hZ2Uvc3ZnK3htbCw8c3ZnIHhtbG5zPSdodHRwOi8vd3d3LnczLm9y' +
  'Zy8yMDAwL3N2Zycgdmlld0JveD0nMCAwIDMyIDMyJz48cmVjdCB3aWR0aD0nMzInIGhlaWdodD0nMzInIHJ4PSc3JyBmaWxsPScl' +
  'MjMxZTNhNWYnLz48dGV4dCB4PScxNicgeT0nMjMnIGZvbnQtc2l6ZT0nMTknIGZvbnQtZmFtaWx5PSdzeXN0ZW0tdWknIGZvbnQt' +
  'd2VpZ2h0PSc3MDAnIGZpbGw9J3doaXRlJyB0ZXh0LWFuY2hvcj0nbWlkZGxlJz5TPC90ZXh0Pjwvc3ZnPiI+CjwvaGVhZD4KPGJv' +
  'ZHk+CjxkaXYgaWQ9ImFwcCI+PC9kaXY+CjxzY3JpcHQgc3JjPSJodHRwczovL2Nkbi5qc2RlbGl2ci5uZXQvbnBtL0B6eGluZy9s' +
  'aWJyYXJ5QDAuMjEuMy91bWQvaW5kZXgubWluLmpzIj48L3NjcmlwdD4KPHNjcmlwdD4KLyogU2VydmVUcmFjayDigJQgZmllbGQt' +
  'Zmlyc3QgcHJvY2VzcyBzZXJ2aW5nIG1hbmFnZXIgKi8KKGZ1bmN0aW9uICgpIHsKJ3VzZSBzdHJpY3QnOwoKLyogLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGhlbHBlcnMgLS0gKi8KY29uc3QgJCA9' +
  'IHNlbCA9PiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKHNlbCk7CmNvbnN0IGFwcCA9ICQoJyNhcHAnKTsKY29uc3QgUyA9IHsgbWU6' +
  'IG51bGwsIHZpZXc6ICdkYXNoJywgcGFyYW1zOiB7fSwgY2FjaGU6IHt9IH07Cgpjb25zdCBlc2MgPSBzID0+IFN0cmluZyhzID09' +
  'IG51bGwgPyAnJyA6IHMpCiAgLnJlcGxhY2UoLyYvZywgJyZhbXA7JykucmVwbGFjZSgvPC9nLCAnJmx0OycpLnJlcGxhY2UoLz4v' +
  'ZywgJyZndDsnKQogIC5yZXBsYWNlKC8iL2csICcmcXVvdDsnKS5yZXBsYWNlKC8nL2csICcmIzM5OycpOwoKY29uc3QgbW9uZXkg' +
  'PSB2ID0+ICckJyArIE51bWJlcih2IHx8IDApLnRvRml4ZWQoMik7CmNvbnN0IGNscyA9IHMgPT4gU3RyaW5nKHMgfHwgJycpLnJl' +
  'cGxhY2UoL1teQS1aYS16XS9nLCAnJyk7CgpmdW5jdGlvbiBmbXREYXRlKHYsIG9wdHMpIHsKICBpZiAoIXYpIHJldHVybiAnJzsK' +
  'ICBjb25zdCBkID0gbmV3IERhdGUodik7CiAgcmV0dXJuIGQudG9Mb2NhbGVEYXRlU3RyaW5nKCdlbi1VUycsIG9wdHMgfHwgeyBt' +
  'b250aDogJ3Nob3J0JywgZGF5OiAnbnVtZXJpYycsIHllYXI6ICdudW1lcmljJyB9KTsKfQpmdW5jdGlvbiBmbXREYXRlT25seSh2' +
  'KSB7IC8vIGRhdGUgY29sdW1ucyBjb21lIGJhY2sgYXMgWVlZWS1NTS1ERCBvciBJU08gbWlkbmlnaHQgVVRDCiAgaWYgKCF2KSBy' +
  'ZXR1cm4gJyc7CiAgY29uc3QgcyA9IFN0cmluZyh2KS5zbGljZSgwLCAxMCkuc3BsaXQoJy0nKTsKICByZXR1cm4gYCR7K3NbMV19' +
  'LyR7K3NbMl19LyR7c1swXS5zbGljZSgyKX1gOwp9CmZ1bmN0aW9uIGZtdERUKHYpIHsKICBpZiAoIXYpIHJldHVybiAnJzsKICBy' +
  'ZXR1cm4gbmV3IERhdGUodikudG9Mb2NhbGVTdHJpbmcoJ2VuLVVTJywKICAgIHsgbW9udGg6ICdzaG9ydCcsIGRheTogJ251bWVy' +
  'aWMnLCBob3VyOiAnbnVtZXJpYycsIG1pbnV0ZTogJzItZGlnaXQnIH0pOwp9CmZ1bmN0aW9uIGRheXNPdXQodikgewogIGlmICgh' +
  'dikgcmV0dXJuIG51bGw7CiAgY29uc3QgZHVlID0gbmV3IERhdGUoU3RyaW5nKHYpLnNsaWNlKDAsIDEwKSArICdUMTI6MDA6MDAn' +
  'KTsKICByZXR1cm4gTWF0aC5yb3VuZCgoZHVlIC0gbmV3IERhdGUoKSkgLyA4NjRlNSk7Cn0KY29uc3QgdG9kYXlJU08gPSAoKSA9' +
  'PiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApOwoKYXN5bmMgZnVuY3Rpb24gYXBpKHBhdGgsIG9wdHMpIHsK' +
  'ICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaCgnL2FwaScgKyBwYXRoLCBPYmplY3QuYXNzaWduKHsKICAgIGhlYWRlcnM6IHsgJ0Nv' +
  'bnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9LCBjcmVkZW50aWFsczogJ3NhbWUtb3JpZ2luJwogIH0sIG9wdHMgfHwg' +
  'e30pKTsKICBjb25zdCBkYXRhID0gYXdhaXQgcmVzLmpzb24oKS5jYXRjaCgoKSA9PiAoe30pKTsKICAvLyBBIDQwMSBmcm9tIC9s' +
  'b2dpbiBtZWFucyB0aGUgY3JlZGVudGlhbHMgd2VyZSB3cm9uZywgbm90IHRoYXQgYSBzZXNzaW9uCiAgLy8gbGFwc2VkLiBUcmVh' +
  'dGluZyB0aGUgdHdvIHRoZSBzYW1lIHNob3dlZCAiU2lnbmVkIG91dCIgdG8gc29tZW9uZSB3aG8gaGFkCiAgLy8gc2ltcGx5IG1p' +
  'c3R5cGVkIGEgcGFzc3dvcmQsIHdoaWNoIGlzIGFjdGl2ZWx5IG1pc2xlYWRpbmcuCiAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSAm' +
  'JiBwYXRoICE9PSAnL2xvZ2luJykgewogICAgUy5tZSA9IG51bGw7CiAgICByZW5kZXIoKTsKICAgIHRocm93IG5ldyBFcnJvcihk' +
  'YXRhLmVycm9yIHx8ICdTaWduZWQgb3V0Jyk7CiAgfQogIGlmICghcmVzLm9rKSB0aHJvdyBuZXcgRXJyb3IoZGF0YS5lcnJvciB8' +
  'fCAnUmVxdWVzdCBmYWlsZWQnKTsKICByZXR1cm4gZGF0YTsKfQoKZnVuY3Rpb24gdG9hc3QobXNnLCBiYWQpIHsKICBjb25zdCB0' +
  'ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgdC5jbGFzc05hbWUgPSAndG9hc3QnICsgKGJhZCA/ICcgYmFkJyA6' +
  'ICcnKTsKICB0LnRleHRDb250ZW50ID0gbXNnOwogIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQodCk7CiAgc2V0VGltZW91dCgo' +
  'KSA9PiB0LnJlbW92ZSgpLCAzMjAwKTsKfQoKZnVuY3Rpb24gZ28odmlldywgcGFyYW1zKSB7IFMudmlldyA9IHZpZXc7IFMucGFy' +
  'YW1zID0gcGFyYW1zIHx8IHt9OyB3aW5kb3cuc2Nyb2xsVG8oMCwgMCk7IHJlbmRlcigpOyB9CgovKiBtb2RhbCBzaGVldCAqLwps' +
  'ZXQgc2hlZXRFbCA9IG51bGw7CmZ1bmN0aW9uIHNoZWV0KHRpdGxlLCBib2R5SHRtbCwgb25Nb3VudCkgewogIGNsb3NlU2hlZXQo' +
  'KTsKICBzaGVldEVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgc2hlZXRFbC5jbGFzc05hbWUgPSAnc2hlZXQn' +
  'OwogIHNoZWV0RWwuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImlubmVyIj48aDI+JHtlc2ModGl0bGUpfTwvaDI+JHtib2R5SHRt' +
  'bH08L2Rpdj5gOwogIHNoZWV0RWwuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBlID0+IHsgaWYgKGUudGFyZ2V0ID09PSBzaGVl' +
  'dEVsKSBjbG9zZVNoZWV0KCk7IH0pOwogIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoc2hlZXRFbCk7CiAgaWYgKG9uTW91bnQp' +
  'IG9uTW91bnQoc2hlZXRFbCk7Cn0KZnVuY3Rpb24gY2xvc2VTaGVldCgpIHsKICBpZiAoc2hlZXRFbCkgeyBzaGVldEVsLnJlbW92' +
  'ZSgpOyBzaGVldEVsID0gbnVsbDsgfQogIGlmICh3aW5kb3cuX19zdG9wU2NhbikgeyB3aW5kb3cuX19zdG9wU2NhbigpOyB3aW5k' +
  'b3cuX19zdG9wU2NhbiA9IG51bGw7IH0KfQp3aW5kb3cuY2xvc2VTaGVldCA9IGNsb3NlU2hlZXQ7CgovKiAtLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIG1hcHMgbGlua2luZyAtLSAqLwpjb25zdCBpc0lPUyA9' +
  'ICgpID0+IC9pUGFkfGlQaG9uZXxpUG9kLy50ZXN0KG5hdmlnYXRvci51c2VyQWdlbnQpIHx8CiAgKG5hdmlnYXRvci5wbGF0Zm9y' +
  'bSA9PT0gJ01hY0ludGVsJyAmJiBuYXZpZ2F0b3IubWF4VG91Y2hQb2ludHMgPiAxKTsKCmZ1bmN0aW9uIGFkZHJPZihqKSB7CiAg' +
  'cmV0dXJuIFtqLmFkZHJlc3MxLCBqLmFkZHJlc3MyLCBqLmNpdHksIGouc3RhdGUsIGouemlwXS5maWx0ZXIoQm9vbGVhbikuam9p' +
  'bignLCAnKTsKfQpmdW5jdGlvbiBhcHBsZVVybChhKSB7IHJldHVybiAnaHR0cHM6Ly9tYXBzLmFwcGxlLmNvbS8/ZGFkZHI9JyAr' +
  'IGVuY29kZVVSSUNvbXBvbmVudChhKSArICcmZGlyZmxnPWQnOyB9CmZ1bmN0aW9uIGdvb2dsZVVybChhKSB7CiAgcmV0dXJuICdo' +
  'dHRwczovL3d3dy5nb29nbGUuY29tL21hcHMvZGlyLz9hcGk9MSZkZXN0aW5hdGlvbj0nICsgZW5jb2RlVVJJQ29tcG9uZW50KGEp' +
  'ICsgJyZ0cmF2ZWxtb2RlPWRyaXZpbmcnOwp9CmZ1bmN0aW9uIG5hdlVybChhKSB7IHJldHVybiBpc0lPUygpID8gYXBwbGVVcmwo' +
  'YSkgOiBnb29nbGVVcmwoYSk7IH0KZnVuY3Rpb24gcm91dGVVcmwobGlzdCkgewogIGNvbnN0IHN0b3BzID0gbGlzdC5tYXAoYWRk' +
  'ck9mKS5maWx0ZXIoQm9vbGVhbik7CiAgaWYgKCFzdG9wcy5sZW5ndGgpIHJldHVybiBudWxsOwogIGNvbnN0IGRlc3QgPSBzdG9w' +
  'c1tzdG9wcy5sZW5ndGggLSAxXTsKICBjb25zdCB3YXkgPSBzdG9wcy5zbGljZSgwLCAtMSkuc2xpY2UoMCwgOSkubWFwKGVuY29k' +
  'ZVVSSUNvbXBvbmVudCkuam9pbignfCcpOwogIHJldHVybiAnaHR0cHM6Ly93d3cuZ29vZ2xlLmNvbS9tYXBzL2Rpci8/YXBpPTEm' +
  'b3JpZ2luPUN1cnJlbnQrTG9jYXRpb24mZGVzdGluYXRpb249JyArCiAgICBlbmNvZGVVUklDb21wb25lbnQoZGVzdCkgKyAod2F5' +
  'ID8gJyZ3YXlwb2ludHM9JyArIHdheSA6ICcnKSArICcmdHJhdmVsbW9kZT1kcml2aW5nJzsKfQoKLyogLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBsYXlvdXQgLS0gKi8KY29uc3QgaXNBZG1pbiA9' +
  'ICgpID0+IFMubWUgJiYgUy5tZS5yb2xlID09PSAnYWRtaW4nOwoKY29uc3QgVEFCUyA9ICgpID0+IGlzQWRtaW4oKQogID8gW1sn' +
  'ZGFzaCcsICdUb2RheScsICfil44nXSwgWydqb2JzJywgJ0pvYnMnLCAn4pakJ10sIFsnc2NhbicsICdTY2FuJywgJ+KWpSddLAog' +
  'ICAgIFsndG9vbHMnLCAnVG9vbHMnLCAn4pyCJ10sIFsncHJvcGVydHknLCAnUHJvcCcsICfijIInXSwgWydtb25leScsICdCaWxs' +
  'JywgJyQnXSwgWydhZG1pbicsICdTZXR1cCcsICfimpknXV0KICA6IFtbJ2Rhc2gnLCAnTXkgRGF5JywgJ+KXjiddLCBbJ2pvYnMn' +
  'LCAnSm9icycsICfilqQnXSwgWydzY2FuJywgJ1NjYW4nLCAn4palJ10sCiAgICAgWyd0b29scycsICdUb29scycsICfinIInXSwg' +
  'Wydwcm9wZXJ0eScsICdQcm9wJywgJ+KMgiddLCBbJ21vbmV5JywgJ1BheScsICckJ11dOwoKZnVuY3Rpb24gc2hlbGwoaW5uZXIp' +
  'IHsKICBjb25zdCB0YWJzID0gVEFCUygpLm1hcCgoW3YsIGxhYmVsLCBpY10pID0+CiAgICBgPGJ1dHRvbiBkYXRhLXRhYj0iJHt2' +
  'fSIgY2xhc3M9IiR7Uy52aWV3ID09PSB2IHx8ICh2ID09PSAnam9icycgJiYgUy52aWV3ID09PSAnam9iJykgPyAnb24nIDogJyd9' +
  'Ij4KICAgICAgPHNwYW4gY2xhc3M9ImljIj4ke2ljfTwvc3Bhbj4ke2VzYyhsYWJlbCl9PC9idXR0b24+YCkuam9pbignJyk7CiAg' +
  'cmV0dXJuIGAKICAgIDxkaXYgY2xhc3M9InRvcGJhciI+CiAgICAgIDxkaXYgY2xhc3M9ImJyYW5kIj5TZXJ2ZVRyYWNrPHNtYWxs' +
  'PiR7ZXNjKFMubWUubmFtZSl9IMK3ICR7Uy5tZS5yb2xlID09PSAnYWRtaW4nID8gJ0FkbWluJyA6ICdGaWVsZCBzZXJ2ZXInfTwv' +
  'c21hbGw+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InNwYWNlciI+PC9kaXY+CiAgICAgIDxidXR0b24gaWQ9ImxvZ291dCI+U2ln' +
  'biBvdXQ8L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0id3JhcCI+JHtpbm5lcn08L2Rpdj4KICAgIDxkaXYgY2xh' +
  'c3M9InRhYnMiPiR7dGFic308L2Rpdj5gOwp9CgpmdW5jdGlvbiBiaW5kU2hlbGwoKSB7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3Rv' +
  'ckFsbCgnW2RhdGEtdGFiXScpLmZvckVhY2goYiA9PgogICAgYi5vbmNsaWNrID0gKCkgPT4gZ28oYi5kYXRhc2V0LnRhYikpOwog' +
  'IGNvbnN0IGxvID0gJCgnI2xvZ291dCcpOwogIGlmIChsbykgbG8ub25jbGljayA9IGFzeW5jICgpID0+IHsgYXdhaXQgYXBpKCcv' +
  'bG9nb3V0JywgeyBtZXRob2Q6ICdQT1NUJyB9KTsgUy5tZSA9IG51bGw7IHJlbmRlcigpOyB9Owp9CgovKiAtLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBsb2dpbiAtLSAqLwpmdW5jdGlvbiBsb2dp' +
  'blZpZXcoKSB7CiAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJsb2dpbiI+CiAgICA8ZGl2IGNsYXNzPSJsb2dvIj48Yj5T' +
  'ZXJ2ZVRyYWNrPC9iPjxkaXY+UHJvY2VzcyBzZXJ2aW5nIG1hbmFnZW1lbnQ8L2Rpdj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImNh' +
  'cmQiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkVtYWlsPC9sYWJlbD48aW5wdXQgaWQ9ImVtYWlsIiB0eXBlPSJl' +
  'bWFpbCIgYXV0b2NvbXBsZXRlPSJ1c2VybmFtZSIgaW5wdXRtb2RlPSJlbWFpbCI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZp' +
  'ZWxkIj48bGFiZWw+UGFzc3dvcmQ8L2xhYmVsPjxpbnB1dCBpZD0icHciIHR5cGU9InBhc3N3b3JkIiBhdXRvY29tcGxldGU9ImN1' +
  'cnJlbnQtcGFzc3dvcmQiPjwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYmxvY2siIGlkPSJzaWduaW4iPlNpZ24gaW48' +
  'L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgaWQ9ImVyciIgc3R5bGU9ImNvbG9yOnZhcigtLWJhZCk7bWFyZ2luLXRv' +
  'cDoxMHB4Ij48L2Rpdj4KICAgIDwvZGl2PjwvZGl2PmA7CiAgY29uc3Qgc3VibWl0ID0gYXN5bmMgKCkgPT4gewogICAgJCgnI2Vy' +
  'cicpLnRleHRDb250ZW50ID0gJyc7CiAgICB0cnkgewogICAgICBTLm1lID0gYXdhaXQgYXBpKCcvbG9naW4nLCB7IG1ldGhvZDog' +
  'J1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVtYWlsOiAkKCcjZW1haWwnKS52YWx1ZSwgcGFzc3dvcmQ6ICQoJyNwdycp' +
  'LnZhbHVlIH0pIH0pOwogICAgICBnbygnZGFzaCcpOwogICAgfSBjYXRjaCAoZSkgeyAkKCcjZXJyJykudGV4dENvbnRlbnQgPSBl' +
  'Lm1lc3NhZ2U7IH0KICB9OwogICQoJyNzaWduaW4nKS5vbmNsaWNrID0gc3VibWl0OwogICQoJyNwdycpLm9ua2V5ZG93biA9IGUg' +
  'PT4geyBpZiAoZS5rZXkgPT09ICdFbnRlcicpIHN1Ym1pdCgpOyB9OwogICQoJyNlbWFpbCcpLmZvY3VzKCk7Cn0KCi8qIC0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gZGFzaGJvYXJkIC0tICovCmFzeW5j' +
  'IGZ1bmN0aW9uIGRhc2hWaWV3KCkgewogIGNvbnN0IFtzdGF0cywgam9ic10gPSBhd2FpdCBQcm9taXNlLmFsbChbYXBpKCcvc3Rh' +
  'dHMnKSwgYXBpKCcvam9icz9vcGVuPTEnKV0pOwogIGNvbnN0IG92ZXJkdWUgPSBqb2JzLmZpbHRlcihqID0+IHsgY29uc3QgZCA9' +
  'IGRheXNPdXQoai5kdWVfZGF0ZSk7IHJldHVybiBkICE9PSBudWxsICYmIGQgPCAwOyB9KTsKICBjb25zdCB0b2RheSA9IGpvYnMu' +
  'ZmlsdGVyKGogPT4geyBjb25zdCBkID0gZGF5c091dChqLmR1ZV9kYXRlKTsgcmV0dXJuIGQgIT09IG51bGwgJiYgZCA+PSAwICYm' +
  'IGQgPD0gMTsgfSk7CiAgY29uc3QgcnVzaCA9IGpvYnMuZmlsdGVyKGogPT4gai5wcmlvcml0eSAhPT0gJ1JvdXRpbmUnKTsKICBj' +
  'b25zdCBtaW5lID0gaXNBZG1pbigpID8gam9icyA6IGpvYnM7CgogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8aDEgY2xh' +
  'c3M9InBhZ2UiPiR7aXNBZG1pbigpID8gJ09wZXJhdGlvbnMgdG9kYXknIDogJ015IGRheSd9PC9oMT4KICAgIDxkaXYgY2xhc3M9' +
  'InN0YXRzIj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdCI+PGRpdiBjbGFzcz0ibiI+JHtzdGF0cy5vcGVuX2pvYnN9PC9kaXY+PGRp' +
  'diBjbGFzcz0ibCI+T3BlbiBqb2JzPC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQgJHtzdGF0cy5vdmVyZHVlID8g' +
  'J2FsZXJ0JyA6ICcnfSI+PGRpdiBjbGFzcz0ibiI+JHtzdGF0cy5vdmVyZHVlfTwvZGl2PjxkaXYgY2xhc3M9ImwiPlBhc3QgZHVl' +
  'PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxkaXYgY2xhc3M9Im4iPiR7c3RhdHMucnVzaH08L2Rpdj48ZGl2' +
  'IGNsYXNzPSJsIj5SdXNoIC8gc2FtZSBkYXk8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdCBnb29kIj48ZGl2IGNs' +
  'YXNzPSJuIj4ke3N0YXRzLnNlcnZlZF83ZH08L2Rpdj48ZGl2IGNsYXNzPSJsIj5TZXJ2ZWQsIDcgZGF5czwvZGl2PjwvZGl2Pgog' +
  'ICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5Sb3V0ZSBteSBkYXkgPHNwYW4gY2xhc3M9InN1YiI+' +
  '4oCUICR7bWluZS5sZW5ndGh9IG9wZW4gc3RvcCR7bWluZS5sZW5ndGggPT09IDEgPyAnJyA6ICdzJ308L3NwYW4+PC9oMj4KICAg' +
  'ICAgPHAgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOi00cHgiPk9wZW5zIEdvb2dsZSBNYXBzIHdpdGggeW91ciBzdG9w' +
  'cyBpbiBvcmRlciAodXAgdG8gMTApLiBObyBtYXBwaW5nIGZlZXMg4oCUIGl0IGp1c3QgaGFuZHMgb2ZmIHRvIHRoZSBhcHAgeW91' +
  'IGFscmVhZHkgaGF2ZS48L3A+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICAgICAg' +
  'PGJ1dHRvbiBjbGFzcz0iYnRuIG5hdiIgaWQ9InJvdXRlQnRuIiAke21pbmUubGVuZ3RoID8gJycgOiAnZGlzYWJsZWQnfT5TdGFy' +
  'dCByb3V0ZSAoJHtNYXRoLm1pbihtaW5lLmxlbmd0aCwgMTApfSBzdG9wcyk8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNz' +
  'PSJidG4gc2VjIHNtIiBpZD0icm91dGVMaXN0Ij5TZWUgb3JkZXI8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAg' +
  'ICAke3NlY3Rpb24oJ1Bhc3QgZHVlJywgb3ZlcmR1ZSl9CiAgICAke3NlY3Rpb24oJ0R1ZSB0b2RheSBvciB0b21vcnJvdycsIHRv' +
  'ZGF5KX0KICAgICR7c2VjdGlvbignUnVzaCAmYW1wOyBzYW1lIGRheScsIHJ1c2guZmlsdGVyKGogPT4gIW92ZXJkdWUuaW5jbHVk' +
  'ZXMoaikgJiYgIXRvZGF5LmluY2x1ZGVzKGopKSl9CiAgICAke292ZXJkdWUubGVuZ3RoICsgdG9kYXkubGVuZ3RoICsgcnVzaC5s' +
  'ZW5ndGggPT09IDAKICAgICAgPyBgPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0iZW1wdHkiPk5vdGhpbmcgdXJnZW50LiAk' +
  'e21pbmUubGVuZ3RofSBvcGVuIGpvYiR7bWluZS5sZW5ndGggPT09IDEgPyAnJyA6ICdzJ30gdG90YWwg4oCUIHNlZSB0aGUgSm9i' +
  'cyB0YWIuPC9kaXY+PC9kaXY+YCA6ICcnfQogIGApOwogIGJpbmRTaGVsbCgpOwogIGJpbmRKb2JJdGVtcygpOwogIGNvbnN0IHJi' +
  'ID0gJCgnI3JvdXRlQnRuJyk7CiAgaWYgKHJiKSByYi5vbmNsaWNrID0gKCkgPT4gewogICAgY29uc3QgdXJsID0gcm91dGVVcmwo' +
  'bWluZS5zbGljZSgwLCAxMCkpOwogICAgaWYgKHVybCkgd2luZG93Lm9wZW4odXJsLCAnX2JsYW5rJyk7CiAgfTsKICAkKCcjcm91' +
  'dGVMaXN0Jykub25jbGljayA9ICgpID0+IHNoZWV0KCdSb3V0ZSBvcmRlcicsIGAKICAgIDxwIGNsYXNzPSJoaW50Ij5PcmRlcmVk' +
  'IGJ5IHByaW9yaXR5LCB0aGVuIGR1ZSBkYXRlLiBUYXAgYW55IHN0b3AgdG8gbmF2aWdhdGUgdG8gaXQgYWxvbmUuPC9wPgogICAg' +
  'PGRpdiBjbGFzcz0ibGlzdCI+JHttaW5lLnNsaWNlKDAsIDEwKS5tYXAoKGosIGkpID0+IGAKICAgICAgPGRpdiBjbGFzcz0iaXRl' +
  'bSIgZGF0YS1uYXY9IiR7ZXNjKGFkZHJPZihqKSl9Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJyIj48ZGl2PjxkaXYgY2xhc3M9InQi' +
  'PiR7aSArIDF9LiAke2VzYyhqLnJlY2lwaWVudF9uYW1lKX08L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtIj4ke2VzYyhhZGRy' +
  'T2YoaikpfTwvZGl2PjwvZGl2PgogICAgICAgIDxzcGFuIGNsYXNzPSJwaWxsICR7Y2xzKGoucHJpb3JpdHkpfSI+JHtlc2Moai5w' +
  'cmlvcml0eSl9PC9zcGFuPjwvZGl2PjwvZGl2PmApLmpvaW4oJycpfTwvZGl2PgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBi' +
  'bG9jayIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5DbG9zZTwvYnV0dG9uPmAsCiAgICBl' +
  'bCA9PiBlbC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1uYXZdJykuZm9yRWFjaChuID0+CiAgICAgIG4ub25jbGljayA9ICgpID0+' +
  'IHdpbmRvdy5vcGVuKG5hdlVybChuLmRhdGFzZXQubmF2KSwgJ19ibGFuaycpKSk7Cn0KCmZ1bmN0aW9uIHNlY3Rpb24odGl0bGUs' +
  'IGxpc3QpIHsKICBpZiAoIWxpc3QubGVuZ3RoKSByZXR1cm4gJyc7CiAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJjYXJkIj48aDI+JHt0' +
  'aXRsZX0gPHNwYW4gY2xhc3M9InN1YiI+JHtsaXN0Lmxlbmd0aH08L3NwYW4+PC9oMj4KICAgIDxkaXYgY2xhc3M9Imxpc3QiPiR7' +
  'bGlzdC5tYXAoam9iSXRlbSkuam9pbignJyl9PC9kaXY+PC9kaXY+YDsKfQoKZnVuY3Rpb24gam9iSXRlbShqKSB7CiAgY29uc3Qg' +
  'ZCA9IGRheXNPdXQoai5kdWVfZGF0ZSk7CiAgY29uc3QgbGF0ZSA9IGQgIT09IG51bGwgJiYgZCA8IDAgJiYgIVsnU2VydmVkJywg' +
  'J05vbi1Fc3QnLCAnQ2FuY2VsbGVkJ10uaW5jbHVkZXMoai5zdGF0dXMpOwogIGNvbnN0IGR1ZSA9IGouZHVlX2RhdGUKICAgID8g' +
  'KGxhdGUgPyBgPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLWJhZCk7Zm9udC13ZWlnaHQ6NjAwIj4ke01hdGguYWJzKGQpfWQgcGFz' +
  'dCBkdWU8L3NwYW4+YAogICAgICAgICAgICA6IChkID09PSAwID8gJ2R1ZSB0b2RheScgOiBkID09PSAxID8gJ2R1ZSB0b21vcnJv' +
  'dycgOiAnZHVlICcgKyBmbXREYXRlT25seShqLmR1ZV9kYXRlKSkpCiAgICA6ICdubyBkdWUgZGF0ZSc7CiAgcmV0dXJuIGA8ZGl2' +
  'IGNsYXNzPSJpdGVtIHAtJHtjbHMoai5wcmlvcml0eSl9ICR7bGF0ZSA/ICdvdmVyZHVlJyA6ICcnfSIgZGF0YS1qb2I9IiR7ai5p' +
  'ZH0iPgogICAgPGRpdiBjbGFzcz0iciI+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0idCI+JHtlc2Moai5yZWNpcGll' +
  'bnRfbmFtZSl9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibSI+JHtlc2Moai5qb2JfbnVtYmVyKX0gwrcgJHtlc2Moai5jaXR5' +
  'IHx8ICcnKX0ke2ouY2l0eSA/ICcsICcgOiAnJ30ke2VzYyhqLnN0YXRlIHx8ICcnKX0gwrcgJHtkdWV9PC9kaXY+CiAgICAgICAg' +
  'PGRpdiBjbGFzcz0ibSI+JHtlc2Moai5jbGllbnRfbmFtZSB8fCAnTm8gY2xpZW50Jyl9JHtqLnNlcnZlcl9uYW1lID8gJyDihpIg' +
  'JyArIGVzYyhqLnNlcnZlcl9uYW1lKSA6ICcnfSR7ai5hdHRlbXB0X2NvdW50ID8gJyDCtyAnICsgai5hdHRlbXB0X2NvdW50ICsg' +
  'JyBhdHRlbXB0JyArIChqLmF0dGVtcHRfY291bnQgPT09IDEgPyAnJyA6ICdzJykgOiAnJ308L2Rpdj4KICAgICAgPC9kaXY+CiAg' +
  'ICAgIDxkaXYgc3R5bGU9InRleHQtYWxpZ246cmlnaHQiPgogICAgICAgIDxzcGFuIGNsYXNzPSJwaWxsICR7Y2xzKGouc3RhdHVz' +
  'KX0iPiR7ZXNjKGouc3RhdHVzKX08L3NwYW4+CiAgICAgICAgJHtqLnByaW9yaXR5ICE9PSAnUm91dGluZScgPyBgPGRpdiBzdHls' +
  'ZT0ibWFyZ2luLXRvcDo1cHgiPjxzcGFuIGNsYXNzPSJwaWxsIHJ1c2giPiR7ZXNjKGoucHJpb3JpdHkpfTwvc3Bhbj48L2Rpdj5g' +
  'IDogJyd9CiAgICAgIDwvZGl2PgogICAgPC9kaXY+PC9kaXY+YDsKfQoKZnVuY3Rpb24gYmluZEpvYkl0ZW1zKCkgewogIGRvY3Vt' +
  'ZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWpvYl0nKS5mb3JFYWNoKGVsID0+CiAgICBlbC5vbmNsaWNrID0gKCkgPT4gZ28o' +
  'J2pvYicsIHsgaWQ6IGVsLmRhdGFzZXQuam9iIH0pKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGpvYnMgLS0gKi8KYXN5bmMgZnVuY3Rpb24gam9ic1ZpZXcoKSB7CiAgY29uc3Qg' +
  'ZiA9IFMucGFyYW1zOwogIGNvbnN0IHFzID0gbmV3IFVSTFNlYXJjaFBhcmFtcygpOwogIGlmIChmLnN0YXR1cykgcXMuc2V0KCdz' +
  'dGF0dXMnLCBmLnN0YXR1cyk7CiAgaWYgKGYucSkgcXMuc2V0KCdxJywgZi5xKTsKICBpZiAoZi5vcGVuKSBxcy5zZXQoJ29wZW4n' +
  'LCAnMScpOwogIGNvbnN0IGpvYnMgPSBhd2FpdCBhcGkoJy9qb2JzPycgKyBxcy50b1N0cmluZygpKTsKCiAgYXBwLmlubmVySFRN' +
  'TCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFnZSI+JHtpc0FkbWluKCkgPyAnSm9icycgOiAnTXkgam9icyd9PC9oMT4KICAg' +
  'IDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAgIDxpbnB1dCBpZD0icSIgcGxhY2Vob2xk' +
  'ZXI9IlNlYXJjaCBuYW1lLCBjYXNlICMsIGpvYiAjLCBhZGRyZXNzIiB2YWx1ZT0iJHtlc2MoZi5xIHx8ICcnKX0iIHN0eWxlPSJm' +
  'bGV4OjE7bWluLXdpZHRoOjE2MHB4Ij4KICAgICAgICA8c2VsZWN0IGlkPSJzdGF0dXMiIHN0eWxlPSJ3aWR0aDphdXRvIj4KICAg' +
  'ICAgICAgIDxvcHRpb24gdmFsdWU9IiI+QW55IHN0YXR1czwvb3B0aW9uPgogICAgICAgICAgJHtbJ1BlbmRpbmcnLCAnQXNzaWdu' +
  'ZWQnLCAnQXR0ZW1wdGVkJywgJ1NlcnZlZCcsICdOb24tRXN0JywgJ09uIEhvbGQnLCAnQ2FuY2VsbGVkJ10KICAgICAgICAgICAg' +
  'Lm1hcChzID0+IGA8b3B0aW9uICR7Zi5zdGF0dXMgPT09IHMgPyAnc2VsZWN0ZWQnIDogJyd9PiR7c308L29wdGlvbj5gKS5qb2lu' +
  'KCcnKX0KICAgICAgICA8L3NlbGVjdD4KICAgICAgICA8bGFiZWwgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50' +
  'ZXI7Z2FwOjZweDttYXJnaW46MDtmb250LXNpemU6MTNweCI+CiAgICAgICAgICA8aW5wdXQgdHlwZT0iY2hlY2tib3giIGlkPSJv' +
  'cGVuT25seSIgJHtmLm9wZW4gPyAnY2hlY2tlZCcgOiAnJ30gc3R5bGU9IndpZHRoOmF1dG8iPiBPcGVuIG9ubHk8L2xhYmVsPgog' +
  'ICAgICA8L2Rpdj4KICAgICAgJHtpc0FkbWluKCkgPyAnPGJ1dHRvbiBjbGFzcz0iYnRuIGJsb2NrIiBpZD0ibmV3Sm9iIiBzdHls' +
  'ZT0ibWFyZ2luLXRvcDoxMHB4Ij4rIE5ldyBqb2I8L2J1dHRvbj4nIDogJyd9CiAgICA8L2Rpdj4KICAgICR7am9icy5sZW5ndGgg' +
  'PyBgPGRpdiBjbGFzcz0ibGlzdCI+JHtqb2JzLm1hcChqb2JJdGVtKS5qb2luKCcnKX08L2Rpdj5gCiAgICAgIDogJzxkaXYgY2xh' +
  'c3M9ImNhcmQiPjxkaXYgY2xhc3M9ImVtcHR5Ij5ObyBqb2JzIG1hdGNoLjwvZGl2PjwvZGl2Pid9CiAgYCk7CiAgYmluZFNoZWxs' +
  'KCk7IGJpbmRKb2JJdGVtcygpOwogIGNvbnN0IGFwcGx5ID0gKCkgPT4gZ28oJ2pvYnMnLCB7IHE6ICQoJyNxJykudmFsdWUudHJp' +
  'bSgpLCBzdGF0dXM6ICQoJyNzdGF0dXMnKS52YWx1ZSwgb3BlbjogJCgnI29wZW5Pbmx5JykuY2hlY2tlZCB9KTsKICAkKCcjcScp' +
  'Lm9ua2V5ZG93biA9IGUgPT4geyBpZiAoZS5rZXkgPT09ICdFbnRlcicpIGFwcGx5KCk7IH07CiAgJCgnI3N0YXR1cycpLm9uY2hh' +
  'bmdlID0gYXBwbHk7CiAgJCgnI29wZW5Pbmx5Jykub25jaGFuZ2UgPSBhcHBseTsKICBpZiAoJCgnI25ld0pvYicpKSAkKCcjbmV3' +
  'Sm9iJykub25jbGljayA9ICgpID0+IGpvYkZvcm0obnVsbCk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBqb2IgZm9ybSAtLSAqLwphc3luYyBmdW5jdGlvbiBqb2JGb3JtKGpvYikgewog' +
  'IGNvbnN0IFtjbGllbnRzLCB1c2Vyc10gPSBhd2FpdCBQcm9taXNlLmFsbChbYXBpKCcvY2xpZW50cycpLCBhcGkoJy91c2Vycycp' +
  'XSk7CiAgY29uc3QgdiA9IGpvYiB8fCB7IHNlcnZpY2VfdHlwZTogJ1BlcnNvbmFsJywgcHJpb3JpdHk6ICdSb3V0aW5lJywgc3Rh' +
  'dHVzOiAnUGVuZGluZycgfTsKICBjb25zdCBvcHQgPSAobGlzdCwgc2VsLCBsYWJlbCkgPT4gbGlzdC5tYXAoeCA9PgogICAgYDxv' +
  'cHRpb24gdmFsdWU9IiR7eC5pZH0iICR7U3RyaW5nKHNlbCkgPT09IFN0cmluZyh4LmlkKSA/ICdzZWxlY3RlZCcgOiAnJ30+JHtl' +
  'c2MobGFiZWwoeCkpfTwvb3B0aW9uPmApLmpvaW4oJycpOwoKICBzaGVldChqb2IgPyAnRWRpdCAnICsgam9iLmpvYl9udW1iZXIg' +
  'OiAnTmV3IGpvYicsIGAKICAgIDxkaXYgY2xhc3M9ImRyb3B6b25lIj4KICAgICAgPGxhYmVsPlN0YXJ0IGZyb20gdGhlIHBhcGVy' +
  'czwvbGFiZWw+CiAgICAgIDxpbnB1dCB0eXBlPSJmaWxlIiBpZD0iZl9wZGYiIGFjY2VwdD0iYXBwbGljYXRpb24vcGRmLC5wZGYi' +
  'PgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBpZD0icGRmTXNnIj5QaWNrIHRoZSBzdW1tb25zLCBjaXRhdGlvbiwgc3VicG9lbmEg' +
  'b3IgY29tcGxhaW50IGFzIGEgUERGIGFuZCBJJ2xsCiAgICAgICAgcmVhZCB3aGF0IEkgY2FuIGludG8gdGhlIGZvcm0gYmVsb3cu' +
  'IEFsd2F5cyBjaGVjayBpdCBhZ2FpbnN0IHRoZSBkb2N1bWVudCBiZWZvcmUgc2F2aW5nLjwvZGl2PgogICAgPC9kaXY+CiAgICA8' +
  'ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5DbGllbnQ8L2xhYmVsPjxzZWxlY3Qg' +
  'aWQ9ImZfY2xpZW50X2lkIj4KICAgICAgICA8b3B0aW9uIHZhbHVlPSIiPuKAlCBub25lIOKAlDwvb3B0aW9uPiR7b3B0KGNsaWVu' +
  'dHMsIHYuY2xpZW50X2lkLCBjID0+IGMubmFtZSl9PC9zZWxlY3Q+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFi' +
  'ZWw+QXNzaWduIHRvPC9sYWJlbD48c2VsZWN0IGlkPSJmX2Fzc2lnbmVkX3RvIj4KICAgICAgICA8b3B0aW9uIHZhbHVlPSIiPuKA' +
  'lCB1bmFzc2lnbmVkIOKAlDwvb3B0aW9uPiR7b3B0KHVzZXJzLmZpbHRlcih1ID0+IHUuYWN0aXZlKSwgdi5hc3NpZ25lZF90bywg' +
  'dSA9PiB1Lm5hbWUpfTwvc2VsZWN0PjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBlcnNv' +
  'biAvIGVudGl0eSB0byBzZXJ2ZSAqPC9sYWJlbD48aW5wdXQgaWQ9ImZfcmVjaXBpZW50X25hbWUiIHZhbHVlPSIke2VzYyh2LnJl' +
  'Y2lwaWVudF9uYW1lKX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5TZXJ2aWNlIGFkZHJlc3M8L2xhYmVs' +
  'PjxpbnB1dCBpZD0iZl9hZGRyZXNzMSIgcGxhY2Vob2xkZXI9IlN0cmVldCBhZGRyZXNzIiB2YWx1ZT0iJHtlc2Modi5hZGRyZXNz' +
  'MSl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQgZzMiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkFwdCAv' +
  'IHVuaXQ8L2xhYmVsPjxpbnB1dCBpZD0iZl9hZGRyZXNzMiIgdmFsdWU9IiR7ZXNjKHYuYWRkcmVzczIpfSI+PC9kaXY+CiAgICAg' +
  'IDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q2l0eTwvbGFiZWw+PGlucHV0IGlkPSJmX2NpdHkiIHZhbHVlPSIke2VzYyh2LmNp' +
  'dHkpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U3RhdGUgLyBaSVA8L2xhYmVsPgogICAgICAgIDxk' +
  'aXYgY2xhc3M9InJvdyI+PGlucHV0IGlkPSJmX3N0YXRlIiBzdHlsZT0id2lkdGg6NzBweCIgbWF4bGVuZ3RoPSIyIiB2YWx1ZT0i' +
  'JHtlc2Modi5zdGF0ZSl9Ij4KICAgICAgICA8aW5wdXQgaWQ9ImZfemlwIiBzdHlsZT0iZmxleDoxIiBpbnB1dG1vZGU9Im51bWVy' +
  'aWMiIHZhbHVlPSIke2VzYyh2LnppcCl9Ij48L2Rpdj48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxs' +
  'YWJlbD5SZWNpcGllbnQgbm90ZXMgKGRlc2NyaXB0aW9uLCB3b3JrIGhvdXJzLCB2ZWhpY2xlLCBnYXRlIGNvZGUpPC9sYWJlbD4K' +
  'ICAgICAgPHRleHRhcmVhIGlkPSJmX3JlY2lwaWVudF9ub3RlcyIgc3R5bGU9Im1pbi1oZWlnaHQ6NjBweCI+JHtlc2Modi5yZWNp' +
  'cGllbnRfbm90ZXMpfTwvdGV4dGFyZWE+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgPGRpdiBjbGFzcz0i' +
  'ZmllbGQiPjxsYWJlbD5DYXNlIG51bWJlcjwvbGFiZWw+PGlucHV0IGlkPSJmX2Nhc2VfbnVtYmVyIiB2YWx1ZT0iJHtlc2Modi5j' +
  'YXNlX251bWJlcil9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Db3VydDwvbGFiZWw+PGlucHV0IGlk' +
  'PSJmX2NvdXJ0IiB2YWx1ZT0iJHtlc2Modi5jb3VydCl9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Q' +
  'bGFpbnRpZmY8L2xhYmVsPjxpbnB1dCBpZD0iZl9wbGFpbnRpZmYiIHZhbHVlPSIke2VzYyh2LnBsYWludGlmZil9Ij48L2Rpdj4K' +
  'ICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5EZWZlbmRhbnQ8L2xhYmVsPjxpbnB1dCBpZD0iZl9kZWZlbmRhbnQiIHZh' +
  'bHVlPSIke2VzYyh2LmRlZmVuZGFudCl9Ij48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5E' +
  'b2N1bWVudHMgdG8gc2VydmU8L2xhYmVsPjxpbnB1dCBpZD0iZl9kb2N1bWVudHMiIHBsYWNlaG9sZGVyPSJTdW1tb25zIGFuZCBD' +
  'b21wbGFpbnQiIHZhbHVlPSIke2VzYyh2LmRvY3VtZW50cyl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQgZzMiPgogICAg' +
  'ICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlNlcnZpY2UgdHlwZTwvbGFiZWw+PHNlbGVjdCBpZD0iZl9zZXJ2aWNlX3R5cGUi' +
  'PgogICAgICAgICR7WydQZXJzb25hbCcsICdTdWJzdGl0dXRlJywgJ1Bvc3RpbmcnLCAnQ2VydGlmaWVkIE1haWwnLCAnQ29ycG9y' +
  'YXRlJ10ubWFwKHMgPT4gYDxvcHRpb24gJHt2LnNlcnZpY2VfdHlwZSA9PT0gcyA/ICdzZWxlY3RlZCcgOiAnJ30+JHtzfTwvb3B0' +
  'aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlByaW9yaXR5PC9s' +
  'YWJlbD48c2VsZWN0IGlkPSJmX3ByaW9yaXR5Ij4KICAgICAgICAke1snUm91dGluZScsICdSdXNoJywgJ1NhbWUgRGF5J10ubWFw' +
  'KHMgPT4gYDxvcHRpb24gJHt2LnByaW9yaXR5ID09PSBzID8gJ3NlbGVjdGVkJyA6ICcnfT4ke3N9PC9vcHRpb24+YCkuam9pbign' +
  'Jyl9PC9zZWxlY3Q+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RHVlIGRhdGU8L2xhYmVsPjxpbnB1dCBp' +
  'ZD0iZl9kdWVfZGF0ZSIgdHlwZT0iZGF0ZSIgdmFsdWU9IiR7di5kdWVfZGF0ZSA/IFN0cmluZyh2LmR1ZV9kYXRlKS5zbGljZSgw' +
  'LCAxMCkgOiAnJ30iPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkIGczIj4KICAgICAgPGRpdiBjbGFzcz0i' +
  'ZmllbGQiPjxsYWJlbD5DbGllbnQgZmVlPC9sYWJlbD48aW5wdXQgaWQ9ImZfY2xpZW50X2ZlZSIgdHlwZT0ibnVtYmVyIiBzdGVw' +
  'PSIwLjAxIiB2YWx1ZT0iJHt2LmNsaWVudF9mZWUgfHwgJyd9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJl' +
  'bD5TZXJ2ZXIgcGF5PC9sYWJlbD48aW5wdXQgaWQ9ImZfc2VydmVyX3BheSIgdHlwZT0ibnVtYmVyIiBzdGVwPSIwLjAxIiB2YWx1' +
  'ZT0iJHt2LnNlcnZlcl9wYXkgfHwgJyd9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5TdGF0dXM8L2xh' +
  'YmVsPjxzZWxlY3QgaWQ9ImZfc3RhdHVzIj4KICAgICAgICAke1snUGVuZGluZycsICdBc3NpZ25lZCcsICdBdHRlbXB0ZWQnLCAn' +
  'U2VydmVkJywgJ05vbi1Fc3QnLCAnT24gSG9sZCcsICdDYW5jZWxsZWQnXS5tYXAocyA9PiBgPG9wdGlvbiAke3Yuc3RhdHVzID09' +
  'PSBzID8gJ3NlbGVjdGVkJyA6ICcnfT4ke3N9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9kaXY+CiAgICA8L2Rpdj4K' +
  'ICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+SW50ZXJuYWwgbm90ZXM8L2xhYmVsPjx0ZXh0YXJlYSBpZD0iZl9ub3RlcyIg' +
  'c3R5bGU9Im1pbi1oZWlnaHQ6NjBweCI+JHtlc2Modi5ub3Rlcyl9PC90ZXh0YXJlYT48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InJv' +
  'dyIgc3R5bGU9Im1hcmdpbi10b3A6NnB4Ij4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0ic2F2ZSI+JHtqb2IgPyAnU2F2' +
  'ZSBjaGFuZ2VzJyA6ICdDcmVhdGUgam9iJ308L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25jbGljaz0i' +
  'Y2xvc2VTaGVldCgpIj5DYW5jZWw8L2J1dHRvbj4KICAgICAgJHtqb2IgPyAnPGJ1dHRvbiBjbGFzcz0iYnRuIGdob3N0IiBpZD0i' +
  'ZGVsIiBzdHlsZT0iY29sb3I6dmFyKC0tYmFkKTttYXJnaW4tbGVmdDphdXRvIj5EZWxldGU8L2J1dHRvbj4nIDogJyd9CiAgICA8' +
  'L2Rpdj5gLCBlbCA9PiB7CiAgICAvKiAtLS0tIHJlYWQgYSBzdW1tb25zL2NpdGF0aW9uIFBERiBhbmQgZmlsbCB3aGF0IHdlIGNh' +
  'biAtLS0tICovCiAgICBjb25zdCBwZGZNc2cgPSBlbC5xdWVyeVNlbGVjdG9yKCcjcGRmTXNnJyk7CiAgICBjb25zdCBGSUxMQUJM' +
  'RSA9IFsnY2FzZV9udW1iZXInLCAnY291cnQnLCAncGxhaW50aWZmJywgJ2RlZmVuZGFudCcsICdyZWNpcGllbnRfbmFtZScsCiAg' +
  'ICAgICdhZGRyZXNzMScsICdhZGRyZXNzMicsICdjaXR5JywgJ3N0YXRlJywgJ3ppcCcsICdkb2N1bWVudHMnXTsKICAgIGNvbnN0' +
  'IExBQkVMUyA9IHsKICAgICAgY2FzZV9udW1iZXI6ICdjYXNlIG51bWJlcicsIGNvdXJ0OiAnY291cnQnLCBwbGFpbnRpZmY6ICdw' +
  'bGFpbnRpZmYnLCBkZWZlbmRhbnQ6ICdkZWZlbmRhbnQnLAogICAgICByZWNpcGllbnRfbmFtZTogJ3BlcnNvbiB0byBzZXJ2ZScs' +
  'IGFkZHJlc3MxOiAnYWRkcmVzcycsIGFkZHJlc3MyOiAndW5pdCcsIGNpdHk6ICdjaXR5JywKICAgICAgc3RhdGU6ICdzdGF0ZScs' +
  'IHppcDogJ1pJUCcsIGRvY3VtZW50czogJ2RvY3VtZW50cycKICAgIH07CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjZl9wZGYnKS5v' +
  'bmNoYW5nZSA9IGFzeW5jIGUgPT4gewogICAgICBjb25zdCBmaWxlID0gZS50YXJnZXQuZmlsZXMgJiYgZS50YXJnZXQuZmlsZXNb' +
  'MF07CiAgICAgIGlmICghZmlsZSkgcmV0dXJuOwogICAgICBwZGZNc2cuaW5uZXJIVE1MID0gJ1JlYWRpbmcgJyArIGVzYyhmaWxl' +
  'Lm5hbWUpICsgJ+KApic7CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IG5ldyBQcm9taXNlKChyZXMsIHJl' +
  'aikgPT4gewogICAgICAgICAgY29uc3QgciA9IG5ldyBGaWxlUmVhZGVyKCk7CiAgICAgICAgICByLm9ubG9hZCA9ICgpID0+IHJl' +
  'cyhTdHJpbmcoci5yZXN1bHQpLnNwbGl0KCcsJylbMV0pOwogICAgICAgICAgci5vbmVycm9yID0gKCkgPT4gcmVqKG5ldyBFcnJv' +
  'cignQ291bGQgbm90IHJlYWQgdGhhdCBmaWxlJykpOwogICAgICAgICAgci5yZWFkQXNEYXRhVVJMKGZpbGUpOwogICAgICAgIH0p' +
  'OwogICAgICAgIGNvbnN0IG91dCA9IGF3YWl0IGFwaSgnL3BhcnNlLWRvY3VtZW50JywgewogICAgICAgICAgbWV0aG9kOiAnUE9T' +
  'VCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgbmFtZTogZmlsZS5uYW1lLCBkYXRhIH0pCiAgICAgICAgfSk7CiAgICAgICAgaWYg' +
  'KG91dC53YXJuaW5nKSB7IHBkZk1zZy5pbm5lckhUTUwgPSAnPGIgc3R5bGU9ImNvbG9yOnZhcigtLXdhcm4pIj4nICsgZXNjKG91' +
  'dC53YXJuaW5nKSArICc8L2I+JzsgcmV0dXJuOyB9CiAgICAgICAgY29uc3QgZmlsbGVkID0gW10sIHNraXBwZWQgPSBbXSwgbWlz' +
  'c2VkID0gW107CiAgICAgICAgZm9yIChjb25zdCBmIG9mIEZJTExBQkxFKSB7CiAgICAgICAgICBjb25zdCBpbnB1dCA9IGVsLnF1' +
  'ZXJ5U2VsZWN0b3IoJyNmXycgKyBmKTsKICAgICAgICAgIGlmICghaW5wdXQpIGNvbnRpbnVlOwogICAgICAgICAgY29uc3QgdmFs' +
  'ID0gb3V0LmZpZWxkc1tmXTsKICAgICAgICAgIGlmICghdmFsKSB7IG1pc3NlZC5wdXNoKExBQkVMU1tmXSk7IGNvbnRpbnVlOyB9' +
  'CiAgICAgICAgICBpZiAoaW5wdXQudmFsdWUgJiYgaW5wdXQudmFsdWUudHJpbSgpICYmIGlucHV0LnZhbHVlLnRyaW0oKSAhPT0g' +
  'U3RyaW5nKHZhbCkudHJpbSgpKSB7CiAgICAgICAgICAgIHNraXBwZWQucHVzaChMQUJFTFNbZl0pOwogICAgICAgICAgICBjb250' +
  'aW51ZTsKICAgICAgICAgIH0KICAgICAgICAgIGlucHV0LnZhbHVlID0gdmFsOwogICAgICAgICAgaW5wdXQuc3R5bGUuYmFja2dy' +
  'b3VuZCA9ICcjZTlmNmVlJzsKICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4geyBpbnB1dC5zdHlsZS5iYWNrZ3JvdW5kID0gJyc7' +
  'IH0sIDQwMDApOwogICAgICAgICAgZmlsbGVkLnB1c2goTEFCRUxTW2ZdKTsKICAgICAgICB9CiAgICAgICAgbGV0IG1zZzsKICAg' +
  'ICAgICBpZiAoZmlsbGVkLmxlbmd0aCkgewogICAgICAgICAgbXNnID0gJzxiIHN0eWxlPSJjb2xvcjp2YXIoLS1vaykiPkZpbGxl' +
  'ZCAnICsgZmlsbGVkLmxlbmd0aCArICcgZmllbGQnICsgKGZpbGxlZC5sZW5ndGggPT09IDEgPyAnJyA6ICdzJykgKwogICAgICAg' +
  'ICAgICAnPC9iPiBmcm9tICcgKyBlc2MoZmlsZS5uYW1lKSArICcgKCcgKyAob3V0LnBhZ2VzIHx8ICc/JykgKyAnIHBhZ2UnICsg' +
  'KG91dC5wYWdlcyA9PT0gMSA/ICcnIDogJ3MnKSArICcpOiAnICsKICAgICAgICAgICAgZXNjKGZpbGxlZC5qb2luKCcsICcpKSAr' +
  'ICcuJzsKICAgICAgICB9IGVsc2UgaWYgKHNraXBwZWQubGVuZ3RoKSB7CiAgICAgICAgICBtc2cgPSAnPGIgc3R5bGU9ImNvbG9y' +
  'OnZhcigtLXdhcm4pIj5FdmVyeXRoaW5nIEkgZm91bmQgd2FzIGFscmVhZHkgZmlsbGVkIGluPC9iPiDigJQgbm90aGluZyBvZiB5' +
  'b3VycyB3YXMgJyArCiAgICAgICAgICAgICdvdmVyd3JpdHRlbi4gQ2xlYXIgYSBmaWVsZCBmaXJzdCBpZiB5b3Ugd2FudCB0aGUg' +
  'ZG9jdW1lbnRcJ3MgdmVyc2lvbiBvZiBpdC4nOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBtc2cgPSAnPGIgc3R5bGU9ImNv' +
  'bG9yOnZhcigtLXdhcm4pIj5Ob3RoaW5nIHJlY29nbmlzYWJsZSBmb3VuZDwvYj4gaW4gJyArIGVzYyhmaWxlLm5hbWUpICsKICAg' +
  'ICAgICAgICAgJy4gSXQgbWF5IGJlIGxhaWQgb3V0IGRpZmZlcmVudGx5IHRvIHRoZSBkb2N1bWVudHMgdGhpcyBjYW4gcmVhZCDi' +
  'gJQgZmlsbCB0aGUgam9iIGluIGJ5IGhhbmQuJzsKICAgICAgICB9CiAgICAgICAgaWYgKGZpbGxlZC5sZW5ndGggJiYgc2tpcHBl' +
  'ZC5sZW5ndGgpIG1zZyArPSAnIExlZnQgeW91ciBleGlzdGluZyAnICsgZXNjKHNraXBwZWQuam9pbignLCAnKSkgKyAnIGFsb25l' +
  'Lic7CiAgICAgICAgaWYgKG1pc3NlZC5sZW5ndGgpIG1zZyArPSAnIE5vdCBmb3VuZDogJyArIGVzYyhtaXNzZWQuam9pbignLCAn' +
  'KSkgKyAnLic7CiAgICAgICAgbXNnICs9ICc8YnI+PGI+Q2hlY2sgZXZlcnkgZmlsbGVkIGZpZWxkIGFnYWluc3QgdGhlIGRvY3Vt' +
  'ZW50IGJlZm9yZSBzYXZpbmcuPC9iPic7CiAgICAgICAgcGRmTXNnLmlubmVySFRNTCA9IG1zZzsKICAgICAgfSBjYXRjaCAoZXJy' +
  'KSB7CiAgICAgICAgcGRmTXNnLmlubmVySFRNTCA9ICc8YiBzdHlsZT0iY29sb3I6dmFyKC0tYmFkKSI+JyArIGVzYyhlcnIubWVz' +
  'c2FnZSkgKyAnPC9iPic7CiAgICAgIH0KICAgIH07CgogICAgLy8gYXV0by1maWxsIGZlZS9wYXkgZGVmYXVsdHMgZnJvbSB0aGUg' +
  'c2VsZWN0ZWQgY2xpZW50IC8gc2VydmVyCiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjZl9jbGllbnRfaWQnKS5vbmNoYW5nZSA9IGUg' +
  'PT4gewogICAgICBjb25zdCBjID0gY2xpZW50cy5maW5kKHggPT4gU3RyaW5nKHguaWQpID09PSBlLnRhcmdldC52YWx1ZSk7CiAg' +
  'ICAgIGlmIChjICYmIGMuZGVmYXVsdF9mZWUgJiYgIWVsLnF1ZXJ5U2VsZWN0b3IoJyNmX2NsaWVudF9mZWUnKS52YWx1ZSkKICAg' +
  'ICAgICBlbC5xdWVyeVNlbGVjdG9yKCcjZl9jbGllbnRfZmVlJykudmFsdWUgPSBOdW1iZXIoYy5kZWZhdWx0X2ZlZSkudG9GaXhl' +
  'ZCgyKTsKICAgIH07CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjZl9hc3NpZ25lZF90bycpLm9uY2hhbmdlID0gZSA9PiB7CiAgICAg' +
  'IGNvbnN0IHUgPSB1c2Vycy5maW5kKHggPT4gU3RyaW5nKHguaWQpID09PSBlLnRhcmdldC52YWx1ZSk7CiAgICAgIGlmICh1ICYm' +
  'IHUuZGVmYXVsdF9wYXkgJiYgIWVsLnF1ZXJ5U2VsZWN0b3IoJyNmX3NlcnZlcl9wYXknKS52YWx1ZSkKICAgICAgICBlbC5xdWVy' +
  'eVNlbGVjdG9yKCcjZl9zZXJ2ZXJfcGF5JykudmFsdWUgPSBOdW1iZXIodS5kZWZhdWx0X3BheSkudG9GaXhlZCgyKTsKICAgIH07' +
  'CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IGJvZHkgPSB7' +
  'fTsKICAgICAgWydjbGllbnRfaWQnLCdhc3NpZ25lZF90bycsJ3JlY2lwaWVudF9uYW1lJywnYWRkcmVzczEnLCdhZGRyZXNzMics' +
  'J2NpdHknLCdzdGF0ZScsJ3ppcCcsJ3JlY2lwaWVudF9ub3RlcycsCiAgICAgICAnY2FzZV9udW1iZXInLCdjb3VydCcsJ3BsYWlu' +
  'dGlmZicsJ2RlZmVuZGFudCcsJ2RvY3VtZW50cycsJ3NlcnZpY2VfdHlwZScsJ3ByaW9yaXR5JywnZHVlX2RhdGUnLAogICAgICAg' +
  'J2NsaWVudF9mZWUnLCdzZXJ2ZXJfcGF5Jywnc3RhdHVzJywnbm90ZXMnXS5mb3JFYWNoKGYgPT4geyBib2R5W2ZdID0gZWwucXVl' +
  'cnlTZWxlY3RvcignI2ZfJyArIGYpLnZhbHVlOyB9KTsKICAgICAgaWYgKCFib2R5LnJlY2lwaWVudF9uYW1lLnRyaW0oKSkgcmV0' +
  'dXJuIHRvYXN0KCdXaG8gYXJlIHdlIHNlcnZpbmc/JywgdHJ1ZSk7CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3Qgc2F2ZWQgPSBq' +
  'b2IKICAgICAgICAgID8gYXdhaXQgYXBpKCcvam9icy8nICsgam9iLmlkLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5z' +
  'dHJpbmdpZnkoYm9keSkgfSkKICAgICAgICAgIDogYXdhaXQgYXBpKCcvam9icycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpT' +
  'T04uc3RyaW5naWZ5KGJvZHkpIH0pOwogICAgICAgIGNsb3NlU2hlZXQoKTsgdG9hc3Qoam9iID8gJ1NhdmVkJyA6ICdKb2IgJyAr' +
  'IHNhdmVkLmpvYl9udW1iZXIgKyAnIGNyZWF0ZWQnKTsKICAgICAgICBnbygnam9iJywgeyBpZDogc2F2ZWQuaWQgfSk7CiAgICAg' +
  'IH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogICAgfTsKICAgIGlmIChlbC5xdWVyeVNlbGVjdG9yKCcj' +
  'ZGVsJykpIGVsLnF1ZXJ5U2VsZWN0b3IoJyNkZWwnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBpZiAoIWNvbmZpcm0o' +
  'J0RlbGV0ZSB0aGlzIGpvYiBhbmQgYWxsIGl0cyBhdHRlbXB0cz8nKSkgcmV0dXJuOwogICAgICBhd2FpdCBhcGkoJy9qb2JzLycg' +
  'KyBqb2IuaWQsIHsgbWV0aG9kOiAnREVMRVRFJyB9KTsKICAgICAgY2xvc2VTaGVldCgpOyB0b2FzdCgnRGVsZXRlZCcpOyBnbygn' +
  'am9icycpOwogICAgfTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLSBqb2IgZGV0YWlsIC0tICovCmFzeW5jIGZ1bmN0aW9uIGpvYlZpZXcoKSB7CiAgY29uc3QgaiA9IGF3YWl0IGFw' +
  'aSgnL2pvYnMvJyArIFMucGFyYW1zLmlkKTsKICBjb25zdCBhZGRyID0gYWRkck9mKGopOwogIGNvbnN0IGRvbmUgPSBbJ1NlcnZl' +
  'ZCcsICdOb24tRXN0JywgJ0NhbmNlbGxlZCddLmluY2x1ZGVzKGouc3RhdHVzKTsKCiAgYXBwLmlubmVySFRNTCA9IHNoZWxsKGAK' +
  'ICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi1ib3R0b206OHB4Ij4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGdo' +
  'b3N0IiBpZD0iYmFjayI+4oC5IEJhY2s8L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0ic3BhY2VyIiBzdHlsZT0iZmxleDoxIj48' +
  'L2Rpdj4KICAgICAgPHNwYW4gY2xhc3M9InBpbGwgJHtjbHMoai5zdGF0dXMpfSI+JHtlc2Moai5zdGF0dXMpfTwvc3Bhbj4KICAg' +
  'ICAgJHtqLnByaW9yaXR5ICE9PSAnUm91dGluZScgPyBgPHNwYW4gY2xhc3M9InBpbGwgcnVzaCI+JHtlc2Moai5wcmlvcml0eSl9' +
  'PC9zcGFuPmAgOiAnJ30KICAgIDwvZGl2PgogICAgPGgxIGNsYXNzPSJwYWdlIiBzdHlsZT0ibWFyZ2luLXRvcDowIj4ke2VzYyhq' +
  'LnJlY2lwaWVudF9uYW1lKX08L2gxPgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJtIiBzdHlsZT0i' +
  'Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxM3B4O21hcmdpbi1ib3R0b206OHB4Ij4ke2VzYyhqLmpvYl9udW1iZXIpfSDC' +
  'tyAke2VzYyhqLmNsaWVudF9uYW1lIHx8ICdObyBjbGllbnQnKX08L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0iZm9udC1zaXplOjE1' +
  'cHg7Zm9udC13ZWlnaHQ6NjAwIj4ke2VzYyhhZGRyIHx8ICdObyBhZGRyZXNzIG9uIGZpbGUnKX08L2Rpdj4KICAgICAgJHtqLnJl' +
  'Y2lwaWVudF9ub3RlcyA/IGA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDo2cHgiPiR7ZXNjKGoucmVjaXBpZW50' +
  'X25vdGVzKX08L2Rpdj5gIDogJyd9CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+CiAgICAg' +
  'ICAgPGJ1dHRvbiBjbGFzcz0iYnRuIG5hdiIgaWQ9Im5hdkJ0biIgJHthZGRyID8gJycgOiAnZGlzYWJsZWQnfT5OYXZpZ2F0ZSDi' +
  'lrg8L2J1dHRvbj4KICAgICAgICAkeyFkb25lID8gJzxidXR0b24gY2xhc3M9ImJ0biBvayIgaWQ9ImF0dEJ0biI+TG9nIGF0dGVt' +
  'cHQ8L2J1dHRvbj4nIDogJyd9CiAgICAgIDwvZGl2PgogICAgICAke2FkZHIgPyBgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1h' +
  'cmdpbi10b3A6OHB4Ij5PcGVucyAke2lzSU9TKCkgPyAnQXBwbGUgTWFwcycgOiAnR29vZ2xlIE1hcHMnfSDCtwogICAgICAgIDxh' +
  'IGhyZWY9IiR7aXNJT1MoKSA/IGdvb2dsZVVybChhZGRyKSA6IGFwcGxlVXJsKGFkZHIpfSIgdGFyZ2V0PSJfYmxhbmsiPnVzZSAk' +
  'e2lzSU9TKCkgPyAnR29vZ2xlJyA6ICdBcHBsZSd9IE1hcHMgaW5zdGVhZDwvYT48L2Rpdj5gIDogJyd9CiAgICA8L2Rpdj4KCiAg' +
  'ICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkF0dGVtcHRzIDxzcGFuIGNsYXNzPSJzdWIiPiR7ai5hdHRlbXB0cy5sZW5n' +
  'dGh9PC9zcGFuPjwvaDI+CiAgICAgICR7ai5hdHRlbXB0cy5sZW5ndGggPyBqLmF0dGVtcHRzLm1hcChhID0+IGAKICAgICAgICA8' +
  'ZGl2IGNsYXNzPSJhdHQgJHtjbHMoYS5vdXRjb21lKX0iPgogICAgICAgICAgPGRpdiBjbGFzcz0iaCI+JHtlc2MoYS5vdXRjb21l' +
  'KX0ke2EubWFubmVyID8gJyDigJQgJyArIGVzYyhhLm1hbm5lcikgOiAnJ308L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9Im0i' +
  'PiR7Zm10RFQoYS5hdHRlbXB0ZWRfYXQpfSDCtyAke2VzYyhhLnNlcnZlcl9uYW1lIHx8ICcnKX08L2Rpdj4KICAgICAgICAgICR7' +
  'YS5wZXJzb25fc2VydmVkID8gYDxkaXYgY2xhc3M9Im0iPlNlcnZlZDogJHtlc2MoYS5wZXJzb25fc2VydmVkKX0ke2EucmVsYXRp' +
  'b25zaGlwID8gJyAoJyArIGVzYyhhLnJlbGF0aW9uc2hpcCkgKyAnKScgOiAnJ308L2Rpdj5gIDogJyd9CiAgICAgICAgICAke2Eu' +
  'ZGVzY3JpcHRpb24gPyBgPGRpdiBjbGFzcz0ibSI+RGVzY3JpcHRpb246ICR7ZXNjKGEuZGVzY3JpcHRpb24pfTwvZGl2PmAgOiAn' +
  'J30KICAgICAgICAgICR7YS5ub3RlcyA/IGA8ZGl2IGNsYXNzPSJtIj4ke2VzYyhhLm5vdGVzKX08L2Rpdj5gIDogJyd9CiAgICAg' +
  'ICAgICAke2EubGF0ICE9IG51bGwgPyBgPGRpdiBjbGFzcz0ibSI+R1BTICR7TnVtYmVyKGEubGF0KS50b0ZpeGVkKDUpfSwgJHtO' +
  'dW1iZXIoYS5sbmcpLnRvRml4ZWQoNSl9CiAgICAgICAgICAgICR7YS5hY2N1cmFjeV9tID8gJ8KxJyArIE1hdGgucm91bmQoYS5h' +
  'Y2N1cmFjeV9tKSArICdtJyA6ICcnfSDCtwogICAgICAgICAgICA8YSBocmVmPSJodHRwczovL3d3dy5nb29nbGUuY29tL21hcHM/' +
  'cT0ke2EubGF0fSwke2EubG5nfSIgdGFyZ2V0PSJfYmxhbmsiPm1hcDwvYT48L2Rpdj5gIDogJyd9CiAgICAgICAgPC9kaXY+YCku' +
  'am9pbignJykKICAgICAgICA6ICc8ZGl2IGNsYXNzPSJlbXB0eSI+Tm8gYXR0ZW1wdHMgbG9nZ2VkIHlldC48L2Rpdj4nfQogICAg' +
  'PC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5QYXBlcndvcms8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJy' +
  'b3ciPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJhZmZCdG4iPkFmZmlkYXZpdDwvYnV0dG9uPgogICAg' +
  'ICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJjb3ZlckJ0biI+Q292ZXIgc2hlZXQgKyBiYXJjb2RlPC9idXR0b24+' +
  'CiAgICAgICAgJHtqLmNhc2VfbnVtYmVyID8gJzxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJsb29rdXBCdG4iPkxvb2sg' +
  'dXAgY2FzZTwvYnV0dG9uPicgOiAnJ30KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyO21h' +
  'cmdpbi10b3A6MTRweCI+CiAgICAgICAgPGltZyBzcmM9Ii9iYXJjb2RlLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGouam9iX251bWJl' +
  'cil9LnN2ZyIgYWx0PSJiYXJjb2RlIiBzdHlsZT0ibWF4LXdpZHRoOjEwMCUiPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAg' +
  'IDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+Q2FzZSBkZXRhaWw8L2gyPgogICAgICA8dGFibGUgY2xhc3M9InRibCI+CiAg' +
  'ICAgICAgJHtbWydDYXNlJywgai5jYXNlX251bWJlcl0sIFsnQ291cnQnLCBqLmNvdXJ0XSwgWydQbGFpbnRpZmYnLCBqLnBsYWlu' +
  'dGlmZl0sIFsnRGVmZW5kYW50Jywgai5kZWZlbmRhbnRdLAogICAgICAgICAgIFsnRG9jdW1lbnRzJywgai5kb2N1bWVudHNdLCBb' +
  'J1NlcnZpY2UgdHlwZScsIGouc2VydmljZV90eXBlXSwgWydEdWUnLCBmbXREYXRlT25seShqLmR1ZV9kYXRlKV0sCiAgICAgICAg' +
  'ICAgWydBc3NpZ25lZCB0bycsIGouc2VydmVyX25hbWVdLCBbJ0NsaWVudCBmZWUnLCBqLmNsaWVudF9mZWUgPyBtb25leShqLmNs' +
  'aWVudF9mZWUpIDogJyddLAogICAgICAgICAgIFsnU2VydmVyIHBheScsIGouc2VydmVyX3BheSA/IG1vbmV5KGouc2VydmVyX3Bh' +
  'eSkgOiAnJ10sCiAgICAgICAgICAgWydTZXJ2ZWQnLCBqLnNlcnZlZF9hdCA/IGZtdERUKGouc2VydmVkX2F0KSArICcg4oCUICcg' +
  'KyBlc2Moai5zZXJ2ZWRfbWFubmVyIHx8ICcnKSA6ICcnXSwKICAgICAgICAgICBbJ05vdGVzJywgai5ub3Rlc11dCiAgICAgICAg' +
  'ICAuZmlsdGVyKHIgPT4gclsxXSkubWFwKHIgPT4gYDx0cj48dGggc3R5bGU9IndpZHRoOjM0JSI+JHtyWzBdfTwvdGg+PHRkPiR7' +
  'ZXNjKHJbMV0pfTwvdGQ+PC90cj5gKS5qb2luKCcnKX0KICAgICAgPC90YWJsZT4KICAgICAgJHtpc0FkbWluKCkgPyAnPGJ1dHRv' +
  'biBjbGFzcz0iYnRuIHNlYyBibG9jayBzbSIgaWQ9ImVkaXRCdG4iIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPkVkaXQgam9iPC9i' +
  'dXR0b24+JyA6ICcnfQogICAgPC9kaXY+YCk7CiAgYmluZFNoZWxsKCk7CiAgJCgnI2JhY2snKS5vbmNsaWNrID0gKCkgPT4gZ28o' +
  'J2pvYnMnLCBTLmNhY2hlLmpvYkZpbHRlciB8fCB7fSk7CiAgaWYgKCQoJyNuYXZCdG4nKSkgJCgnI25hdkJ0bicpLm9uY2xpY2sg' +
  'PSAoKSA9PiB3aW5kb3cub3BlbihuYXZVcmwoYWRkciksICdfYmxhbmsnKTsKICBpZiAoJCgnI2F0dEJ0bicpKSAkKCcjYXR0QnRu' +
  'Jykub25jbGljayA9ICgpID0+IGF0dGVtcHRGb3JtKGopOwogIGlmICgkKCcjZWRpdEJ0bicpKSAkKCcjZWRpdEJ0bicpLm9uY2xp' +
  'Y2sgPSAoKSA9PiBqb2JGb3JtKGopOwogICQoJyNjb3ZlckJ0bicpLm9uY2xpY2sgPSAoKSA9PiB3aW5kb3cub3BlbignL3ByaW50' +
  'L2NvdmVyc2hlZXQvJyArIGouaWQsICdfYmxhbmsnKTsKICAkKCcjYWZmQnRuJykub25jbGljayA9ICgpID0+IGFmZmlkYXZpdFNo' +
  'ZWV0KGopOwogIGlmICgkKCcjbG9va3VwQnRuJykpICQoJyNsb29rdXBCdG4nKS5vbmNsaWNrID0gKCkgPT4gY2FzZUxvb2t1cFNo' +
  'ZWV0KGopOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGxvZyBh' +
  'dHRlbXB0IC0tICovCmNvbnN0IE9VVENPTUVTID0gWydTZXJ2ZWQnLCAnTm8gQW5zd2VyJywgJ0JhZCBBZGRyZXNzJywgJ01vdmVk' +
  'JywgJ1JlZnVzZWQnLCAnRXZhZGluZycsICdPdGhlciddOwoKZnVuY3Rpb24gYXR0ZW1wdEZvcm0oam9iKSB7CiAgc2hlZXQoJ0xv' +
  'ZyBhdHRlbXB0IOKAlCAnICsgam9iLnJlY2lwaWVudF9uYW1lLCBgCiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk91dGNv' +
  'bWU8L2xhYmVsPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIGlkPSJvdXRjb21lcyI+JHtPVVRDT01FUy5tYXAobyA9PgogICAgICAg' +
  'IGA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBkYXRhLW89IiR7b30iPiR7b308L2J1dHRvbj5gKS5qb2luKCcnKX08L2Rpdj48' +
  'L2Rpdj4KICAgIDxkaXYgaWQ9InNlcnZlZEZpZWxkcyIgc3R5bGU9ImRpc3BsYXk6bm9uZSI+CiAgICAgIDxkaXYgY2xhc3M9Imdy' +
  'aWQgZzIiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+TWFubmVyPC9sYWJlbD48c2VsZWN0IGlkPSJhX21hbm5l' +
  'ciI+CiAgICAgICAgICAke1snUGVyc29uYWwnLCAnU3Vic3RpdHV0ZScsICdQb3N0ZWQnLCAnQ29ycG9yYXRlJywgJ0NlcnRpZmll' +
  'ZCBNYWlsJ10ubWFwKHMgPT4gYDxvcHRpb24+JHtzfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAgICAg' +
  'IDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGVyc29uIHNlcnZlZDwvbGFiZWw+PGlucHV0IGlkPSJhX3BlcnNvbl9zZXJ2ZWQi' +
  'IHZhbHVlPSIke2VzYyhqb2IucmVjaXBpZW50X25hbWUpfSI+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJn' +
  'cmlkIGcyIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlJlbGF0aW9uc2hpcCAoaWYgc3Vic3RpdHV0ZSk8L2xh' +
  'YmVsPjxpbnB1dCBpZD0iYV9yZWxhdGlvbnNoaXAiIHBsYWNlaG9sZGVyPSJjby1yZXNpZGVudCwgY28td29ya2VyLi4uIj48L2Rp' +
  'dj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkRlc2NyaXB0aW9uPC9sYWJlbD48aW5wdXQgaWQ9ImFfZGVzY3Jp' +
  'cHRpb24iIHBsYWNlaG9sZGVyPSJXL0YsIDQwcywgNSc2JnF1b3Q7LCBicm93biBoYWlyIj48L2Rpdj4KICAgICAgPC9kaXY+CiAg' +
  'ICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Tm90ZXM8L2xhYmVsPjx0ZXh0YXJlYSBpZD0iYV9ub3RlcyIg' +
  'cGxhY2Vob2xkZXI9IkxpZ2h0cyBvbiwgbm8gYW5zd2VyIGF0IGZyb250IGRvb3IuIFNpbHZlciBDaXZpYyBpbiBkcml2ZXdheS4i' +
  'PjwvdGV4dGFyZWE+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPldoZW48L2xhYmVsPjxpbnB1dCBpZD0iYV93' +
  'aGVuIiB0eXBlPSJkYXRldGltZS1sb2NhbCIgdmFsdWU9IiR7bG9jYWxOb3coKX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2Fy' +
  'ZCIgc3R5bGU9ImJhY2tncm91bmQ6I2Y4ZmFmYztib3gtc2hhZG93Om5vbmU7bWFyZ2luLWJvdHRvbToxMnB4Ij4KICAgICAgPGRp' +
  'diBjbGFzcz0icm93Ij48YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0iZ3BzQnRuIj5DYXB0dXJlIEdQUzwvYnV0dG9uPgog' +
  'ICAgICA8c3BhbiBjbGFzcz0iaGludCIgaWQ9Imdwc091dCIgc3R5bGU9Im1hcmdpbjowIj5Ob3QgY2FwdHVyZWQ8L3NwYW4+PC9k' +
  'aXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InJvdyI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InNhdmVBdHQi' +
  'IGRpc2FibGVkPlBpY2sgYW4gb3V0Y29tZTwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJj' +
  'bG9zZVNoZWV0KCkiPkNhbmNlbDwvYnV0dG9uPgogICAgPC9kaXY+YCwgZWwgPT4gewogICAgbGV0IG91dGNvbWUgPSBudWxsLCBn' +
  'cHMgPSBudWxsOwogICAgZWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtb10nKS5mb3JFYWNoKGIgPT4gYi5vbmNsaWNrID0gKCkg' +
  'PT4gewogICAgICBvdXRjb21lID0gYi5kYXRhc2V0Lm87CiAgICAgIGVsLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLW9dJykuZm9y' +
  'RWFjaCh4ID0+IHsgeC5jbGFzc05hbWUgPSAnYnRuIHNlYyBzbSc7IH0pOwogICAgICBiLmNsYXNzTmFtZSA9ICdidG4gc20nICsg' +
  'KG91dGNvbWUgPT09ICdTZXJ2ZWQnID8gJyBvaycgOiAnJyk7CiAgICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNzZXJ2ZWRGaWVsZHMn' +
  'KS5zdHlsZS5kaXNwbGF5ID0gb3V0Y29tZSA9PT0gJ1NlcnZlZCcgPyAnJyA6ICdub25lJzsKICAgICAgY29uc3QgcyA9IGVsLnF1' +
  'ZXJ5U2VsZWN0b3IoJyNzYXZlQXR0Jyk7CiAgICAgIHMuZGlzYWJsZWQgPSBmYWxzZTsKICAgICAgcy50ZXh0Q29udGVudCA9IG91' +
  'dGNvbWUgPT09ICdTZXJ2ZWQnID8gJ1NhdmUg4oCUIG1hcmtzIGpvYiBTRVJWRUQnIDogJ1NhdmUgYXR0ZW1wdCc7CiAgICB9KTsK' +
  'ICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNncHNCdG4nKS5vbmNsaWNrID0gKCkgPT4gewogICAgICBjb25zdCBvdXQgPSBlbC5xdWVy' +
  'eVNlbGVjdG9yKCcjZ3BzT3V0Jyk7CiAgICAgIGlmICghbmF2aWdhdG9yLmdlb2xvY2F0aW9uKSByZXR1cm4gb3V0LnRleHRDb250' +
  'ZW50ID0gJ05vdCBzdXBwb3J0ZWQgb24gdGhpcyBkZXZpY2UnOwogICAgICBvdXQudGV4dENvbnRlbnQgPSAnTG9jYXRpbmfigKYn' +
  'OwogICAgICBuYXZpZ2F0b3IuZ2VvbG9jYXRpb24uZ2V0Q3VycmVudFBvc2l0aW9uKHBvcyA9PiB7CiAgICAgICAgZ3BzID0geyBs' +
  'YXQ6IHBvcy5jb29yZHMubGF0aXR1ZGUsIGxuZzogcG9zLmNvb3Jkcy5sb25naXR1ZGUsIGFjY3VyYWN5X206IHBvcy5jb29yZHMu' +
  'YWNjdXJhY3kgfTsKICAgICAgICBvdXQuaW5uZXJIVE1MID0gYDxiIHN0eWxlPSJjb2xvcjp2YXIoLS1vaykiPuKckyAke2dwcy5s' +
  'YXQudG9GaXhlZCg1KX0sICR7Z3BzLmxuZy50b0ZpeGVkKDUpfTwvYj4gwrEke01hdGgucm91bmQoZ3BzLmFjY3VyYWN5X20pfW1g' +
  'OwogICAgICB9LCBlcnIgPT4geyBvdXQudGV4dENvbnRlbnQgPSAnRmFpbGVkOiAnICsgZXJyLm1lc3NhZ2U7IH0sCiAgICAgICAg' +
  'eyBlbmFibGVIaWdoQWNjdXJhY3k6IHRydWUsIHRpbWVvdXQ6IDE1MDAwLCBtYXhpbXVtQWdlOiAwIH0pOwogICAgfTsKICAgIC8v' +
  'IGF1dG8tY2FwdHVyZSBvbiBvcGVuIOKAlCB0aGUgYWZmaWRhdml0IGlzIHN0cm9uZ2VyIHdoZW4gZXZlcnkgYXR0ZW1wdCBoYXMg' +
  'Y29vcmRpbmF0ZXMKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNncHNCdG4nKS5jbGljaygpOwoKICAgIGVsLnF1ZXJ5U2VsZWN0b3Io' +
  'JyNzYXZlQXR0Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgYm9keSA9IE9iamVjdC5hc3NpZ24oewogICAg' +
  'ICAgIG91dGNvbWUsCiAgICAgICAgYXR0ZW1wdGVkX2F0OiBlbC5xdWVyeVNlbGVjdG9yKCcjYV93aGVuJykudmFsdWUgfHwgbnVs' +
  'bCwKICAgICAgICBub3RlczogZWwucXVlcnlTZWxlY3RvcignI2Ffbm90ZXMnKS52YWx1ZQogICAgICB9LCBncHMgfHwge30pOwog' +
  'ICAgICBpZiAob3V0Y29tZSA9PT0gJ1NlcnZlZCcpIHsKICAgICAgICBib2R5Lm1hbm5lciA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNh' +
  'X21hbm5lcicpLnZhbHVlOwogICAgICAgIGJvZHkucGVyc29uX3NlcnZlZCA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNhX3BlcnNvbl9z' +
  'ZXJ2ZWQnKS52YWx1ZTsKICAgICAgICBib2R5LnJlbGF0aW9uc2hpcCA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNhX3JlbGF0aW9uc2hp' +
  'cCcpLnZhbHVlOwogICAgICAgIGJvZHkuZGVzY3JpcHRpb24gPSBlbC5xdWVyeVNlbGVjdG9yKCcjYV9kZXNjcmlwdGlvbicpLnZh' +
  'bHVlOwogICAgICB9CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgYXBpKCcvam9icy8nICsgam9iLmlkICsgJy9hdHRlbXB0cycs' +
  'IHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pOwogICAgICAgIGNsb3NlU2hlZXQoKTsgdG9h' +
  'c3Qob3V0Y29tZSA9PT0gJ1NlcnZlZCcgPyAnU2VydmVkIOKAlCBqb2IgY2xvc2VkIG91dCcgOiAnQXR0ZW1wdCBsb2dnZWQnKTsK' +
  'ICAgICAgICBnbygnam9iJywgeyBpZDogam9iLmlkIH0pOwogICAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1' +
  'ZSk7IH0KICAgIH07CiAgfSk7Cn0KCmZ1bmN0aW9uIGxvY2FsTm93KCkgewogIGNvbnN0IGQgPSBuZXcgRGF0ZShEYXRlLm5vdygp' +
  'IC0gbmV3IERhdGUoKS5nZXRUaW1lem9uZU9mZnNldCgpICogNjAwMDApOwogIHJldHVybiBkLnRvSVNPU3RyaW5nKCkuc2xpY2Uo' +
  'MCwgMTYpOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGFm' +
  'ZmlkYXZpdCAtLSAqLwphc3luYyBmdW5jdGlvbiBhZmZpZGF2aXRTaGVldChqb2IpIHsKICBjb25zdCB0ZW1wbGF0ZXMgPSBhd2Fp' +
  'dCBhcGkoJy90ZW1wbGF0ZXMnKTsKICBjb25zdCBsb2FkID0gYXN5bmMgaWQgPT4gewogICAgY29uc3QgciA9IGF3YWl0IGFwaSgn' +
  'L2pvYnMvJyArIGpvYi5pZCArICcvYWZmaWRhdml0JyArIChpZCA/ICc/dGVtcGxhdGVfaWQ9JyArIGlkIDogJycpKTsKICAgIHJl' +
  'dHVybiByOwogIH07CiAgY29uc3QgZmlyc3QgPSBhd2FpdCBsb2FkKCk7CiAgc2hlZXQoJ0FmZmlkYXZpdCDigJQgJyArIGpvYi5q' +
  'b2JfbnVtYmVyLCBgCiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlRlbXBsYXRlPC9sYWJlbD48c2VsZWN0IGlkPSJ0cGwi' +
  'PgogICAgICAke3RlbXBsYXRlcy5tYXAodCA9PiBgPG9wdGlvbiB2YWx1ZT0iJHt0LmlkfSIgJHt0LmlkID09PSBmaXJzdC50ZW1w' +
  'bGF0ZV9pZCA/ICdzZWxlY3RlZCcgOiAnJ30+JHtlc2ModC5uYW1lKX0ke3QuanVyaXNkaWN0aW9uID8gJyDigJQgJyArIGVzYyh0' +
  'Lmp1cmlzZGljdGlvbikgOiAnJ308L29wdGlvbj5gKS5qb2luKCcnKX0KICAgIDwvc2VsZWN0PjwvZGl2PgogICAgPHByZSBjbGFz' +
  'cz0icHJldiIgaWQ9InByZXYiPiR7ZXNjKGZpcnN0LnRleHQpfTwvcHJlPgogICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFy' +
  'Z2luLXRvcDoxMnB4Ij4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0icHJpbnRBZmYiPlByaW50IC8gc2F2ZSBQREY8L2J1' +
  'dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgaWQ9ImNvcHlBZmYiPkNvcHkgdGV4dDwvYnV0dG9uPgogICAgICA8' +
  'YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNsb3NlPC9idXR0b24+CiAgICA8L2Rpdj5gLCBl' +
  'bCA9PiB7CiAgICBjb25zdCBzZWwgPSBlbC5xdWVyeVNlbGVjdG9yKCcjdHBsJyk7CiAgICBzZWwub25jaGFuZ2UgPSBhc3luYyAo' +
  'KSA9PiB7IGVsLnF1ZXJ5U2VsZWN0b3IoJyNwcmV2JykudGV4dENvbnRlbnQgPSAoYXdhaXQgbG9hZChzZWwudmFsdWUpKS50ZXh0' +
  'OyB9OwogICAgZWwucXVlcnlTZWxlY3RvcignI3ByaW50QWZmJykub25jbGljayA9ICgpID0+CiAgICAgIHdpbmRvdy5vcGVuKCcv' +
  'cHJpbnQvYWZmaWRhdml0LycgKyBqb2IuaWQgKyAnP3RlbXBsYXRlX2lkPScgKyBzZWwudmFsdWUsICdfYmxhbmsnKTsKICAgIGVs' +
  'LnF1ZXJ5U2VsZWN0b3IoJyNjb3B5QWZmJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgYXdhaXQgbmF2aWdhdG9yLmNs' +
  'aXBib2FyZC53cml0ZVRleHQoZWwucXVlcnlTZWxlY3RvcignI3ByZXYnKS50ZXh0Q29udGVudCk7CiAgICAgIHRvYXN0KCdDb3Bp' +
  'ZWQnKTsKICAgIH07CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tIHRvb2xzIC0tLSAqLwovKiBMYWJlbCBtYWtlci4gVGhlIHBvaW50IG9mIHRoZSBzaGVldCBncmlkIGlzIHRoYXQg' +
  'bGFiZWwgc2hlZXRzIGFyZSBleHBlbnNpdmUKICAgYW5kIHJhcmVseSB1c2VkIHVwIGluIG9uZSBnbzogbWFyayB3aGljaCBvbmVz' +
  'IHlvdSd2ZSBhbHJlYWR5IHBlZWxlZCBvZmYgYW5kCiAgIHRoZSBwcmludGVyIHNraXBzIHRoZW0sIHNvIGEgcGFydC11c2VkIHNo' +
  'ZWV0IGdvZXMgYmFjayBpbiBhbmQgY2FycmllcyBvbi4gKi8KYXN5bmMgZnVuY3Rpb24gdG9vbHNWaWV3KCkgewogIGNvbnN0IFts' +
  'YXlvdXRzLCBpbml0U2hlZXQsIGpvYnNdID0gYXdhaXQgUHJvbWlzZS5hbGwoWwogICAgYXBpKCcvbGFiZWwtbGF5b3V0cycpLCBh' +
  'cGkoJy9sYWJlbC1zaGVldCcpLCBhcGkoJy9qb2JzP29wZW49MScpCiAgXSk7CiAgUy5jYWNoZS5zaGVldCA9IGluaXRTaGVldDsK' +
  'ICBTLmNhY2hlLnBpY2tlZCA9IFMuY2FjaGUucGlja2VkIHx8IFtdOwoKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgx' +
  'IGNsYXNzPSJwYWdlIj5Ub29sczwvaDE+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5MYWJlbCBtYWtlciA8c3Bh' +
  'biBjbGFzcz0ic3ViIj5wcmludHMgb25seSB0aGUgbGFiZWxzIHlvdSBoYXZlbid0IHVzZWQ8L3NwYW4+PC9oMj4KCiAgICAgIDxk' +
  'aXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+TGFiZWwgc2hlZXQ8L2xhYmVsPgogICAgICAgIDxzZWxlY3QgaWQ9ImxheW91dCI+CiAg' +
  'ICAgICAgICAke2xheW91dHMubWFwKGwgPT4gYDxvcHRpb24gdmFsdWU9IiR7bC5rZXl9IiAke2wua2V5ID09PSBpbml0U2hlZXQu' +
  'bGF5b3V0ID8gJ3NlbGVjdGVkJyA6ICcnfT4KICAgICAgICAgICAgJHtlc2MobC5uYW1lKX0g4oCUICR7ZXNjKGwuc2l6ZSl9PC9v' +
  'cHRpb24+YCkuam9pbignJyl9CiAgICAgICAgPC9zZWxlY3Q+CiAgICAgICAgPGRpdiBjbGFzcz0iaGludCI+T2ZmaWNlIERlcG90' +
  'IHNoZWV0cyBwcmludCBhbiBBdmVyeSBlcXVpdmFsZW50IG51bWJlciBvbiB0aGUgcGFja2FnZSBmcm9udCDigJQKICAgICAgICAg' +
  'IG1hdGNoIHRoYXQuIENoYW5naW5nIHRoZSBzaGVldCBjbGVhcnMgdGhlIHVzZWQgbWFya3MsIHNpbmNlIHBvc2l0aW9uIDcgb24g' +
  'YSAzMC11cCBzaGVldAogICAgICAgICAgaXNuJ3QgcG9zaXRpb24gNyBvbiBhIDEwLXVwIG9uZS48L2Rpdj4KICAgICAgPC9kaXY+' +
  'CgogICAgICA8bGFiZWw+V2hpY2ggbGFiZWxzIGFyZSBhbHJlYWR5IGdvbmU/PC9sYWJlbD4KICAgICAgPGRpdiBjbGFzcz0iaGlu' +
  'dCIgc3R5bGU9Im1hcmdpbi1ib3R0b206OHB4Ij5UYXAgdGhlIG9uZXMgYWxyZWFkeSBwZWVsZWQgb2ZmLiBHcmV5ID0gdXNlZCBh' +
  'bmQgc2tpcHBlZC4KICAgICAgICBOdW1iZXJlZCBncmVlbiA9IHdoZXJlIHlvdXIgbmV4dCBsYWJlbHMgd2lsbCBsYW5kLCBpbiBv' +
  'cmRlci48L2Rpdj4KICAgICAgPGRpdiBpZD0iZ3JpZCI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdp' +
  'bi10b3A6MTBweCI+CiAgICAgICAgPHNwYW4gY2xhc3M9InBpbGwiIGlkPSJmcmVlQ291bnQiPjwvc3Bhbj4KICAgICAgICA8YnV0' +
  'dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0ibmV3U2hlZXQiPkZyZXNoIHNoZWV0PC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBj' +
  'bGFzcz0iYnRuIHNlYyBzbSIgaWQ9ImFsbFVzZWQiPk1hcmsgYWxsIHVzZWQ8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L2Rp' +
  'dj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPldobyB0byBwcmludCA8c3BhbiBjbGFzcz0ic3ViIiBpZD0icGlj' +
  'a0NvdW50Ij48L3NwYW4+PC9oMj4KICAgICAgPGlucHV0IGlkPSJqb2JGaWx0ZXIiIHBsYWNlaG9sZGVyPSJGaWx0ZXIgYnkgbmFt' +
  'ZSwgY2l0eSBvciBqb2IgbnVtYmVyIiBzdHlsZT0ibWFyZ2luLWJvdHRvbTo4cHgiPgogICAgICA8ZGl2IGNsYXNzPSJsaXN0IiBp' +
  'ZD0iam9iUGljayIgc3R5bGU9Im1heC1oZWlnaHQ6MzIwcHg7b3ZlcmZsb3c6YXV0byI+CiAgICAgICAgJHtqb2JzLmxlbmd0aCA/' +
  'IGpvYnMubWFwKGogPT4gYAogICAgICAgICAgPGRpdiBjbGFzcz0iaXRlbSIgZGF0YS1waWNrPSIke2ouaWR9Ij4KICAgICAgICAg' +
  'ICAgPGRpdiBjbGFzcz0iciI+PGRpdj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJ0Ij4ke2VzYyhqLnJlY2lwaWVudF9uYW1l' +
  'KX08L2Rpdj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJtIj4ke2VzYyhqLmpvYl9udW1iZXIpfSDCtyAke2VzYyhbai5hZGRy' +
  'ZXNzMSwgai5jaXR5XS5maWx0ZXIoQm9vbGVhbikuam9pbignLCAnKSB8fCAnbm8gYWRkcmVzcycpfTwvZGl2PgogICAgICAgICAg' +
  'ICA8L2Rpdj48c3BhbiBjbGFzcz0icGlsbCIgZGF0YS10aWNrPSIke2ouaWR9Ij5hZGQ8L3NwYW4+PC9kaXY+CiAgICAgICAgICA8' +
  'L2Rpdj5gKS5qb2luKCcnKQogICAgICAgICAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPk5vIG9wZW4gam9icyB0byBsYWJlbC48L2Rp' +
  'dj4nfQogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+UHJpbnQ8L2gyPgog' +
  'ICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InByaW50QnRuIiBkaXNhYmxlZD5Q' +
  'cmludCBsYWJlbHM8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0idGVzdEJ0biI+QWxpZ25t' +
  'ZW50IHRlc3Q8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjhw' +
  'eCI+SW4gdGhlIHByaW50IGRpYWxvZyBzZXQgc2NhbGUgdG8gPGI+MTAwJTwvYj4gYW5kIHR1cm4gb2ZmCiAgICAgICAgImZpdCB0' +
  'byBwYWdlIiDigJQgc2NhbGluZyBpcyB3aGF0IHRocm93cyBsYWJlbCBhbGlnbm1lbnQgb2ZmLjwvZGl2PgoKICAgICAgPGRpdiBj' +
  'bGFzcz0iZmllbGQiIHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPjxsYWJlbD5OdWRnZSwgaWYgeW91ciBwcmludGVyIHJ1bnMgb2Zm' +
  'PC9sYWJlbD4KICAgICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJn' +
  'aW46MCI+UmlnaHQ8L3NwYW4+CiAgICAgICAgICA8aW5wdXQgaWQ9Im9mZlgiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgbWlu' +
  'PSItMC41IiBtYXg9IjAuNSIgdmFsdWU9IiR7aW5pdFNoZWV0Lm9mZnNldF94fSIgc3R5bGU9IndpZHRoOjkwcHgiPgogICAgICAg' +
  'ICAgPHNwYW4gY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MCI+RG93bjwvc3Bhbj4KICAgICAgICAgIDxpbnB1dCBpZD0ib2Zm' +
  'WSIgdHlwZT0ibnVtYmVyIiBzdGVwPSIwLjAxIiBtaW49Ii0wLjUiIG1heD0iMC41IiB2YWx1ZT0iJHtpbml0U2hlZXQub2Zmc2V0' +
  'X3l9IiBzdHlsZT0id2lkdGg6OTBweCI+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0ic2F2ZU9mZiI+' +
  'U2F2ZTwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPkluY2hlcy4gUHJpbnQgdGhlIGFs' +
  'aWdubWVudCB0ZXN0IG9uIHBsYWluIHBhcGVyLCBob2xkIGl0IGFnYWluc3QgYSByZWFsIHNoZWV0LAogICAgICAgICAgYW5kIG51' +
  'ZGdlIHVudGlsIHRoZSBib3hlcyBsaW5lIHVwLjwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PmApOwogIGJpbmRTaGVsbCgp' +
  'OwoKICBjb25zdCBsYXlvdXRNZXRhID0gKCkgPT4gbGF5b3V0cy5maW5kKGwgPT4gbC5rZXkgPT09IFMuY2FjaGUuc2hlZXQubGF5' +
  'b3V0KSB8fCBsYXlvdXRzWzBdOwoKICBmdW5jdGlvbiBkcmF3R3JpZCgpIHsKICAgIGNvbnN0IG1ldGEgPSBsYXlvdXRNZXRhKCk7' +
  'CiAgICBjb25zdCBzID0gUy5jYWNoZS5zaGVldDsKICAgIGNvbnN0IHVzZWQgPSBuZXcgU2V0KHMudXNlZC5tYXAoTnVtYmVyKSk7' +
  'CiAgICBjb25zdCBmcmVlID0gW107CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1ldGEuY2FwYWNpdHk7IGkrKykgaWYgKCF1c2Vk' +
  'LmhhcyhpKSkgZnJlZS5wdXNoKGkpOwogICAgY29uc3Qgb3JkZXIgPSBuZXcgTWFwKGZyZWUuc2xpY2UoMCwgUy5jYWNoZS5waWNr' +
  'ZWQubGVuZ3RoKS5tYXAoKHBvcywgbikgPT4gW3BvcywgbiArIDFdKSk7CgogICAgJCgnI2dyaWQnKS5pbm5lckhUTUwgPSBgPGRp' +
  'diBjbGFzcz0ibGdyaWQiIHN0eWxlPSJncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KCR7bWV0YS5jb2xzfSwxZnIpIj5gICsK' +
  'ICAgICAgQXJyYXkuZnJvbSh7IGxlbmd0aDogbWV0YS5jYXBhY2l0eSB9LCAoXywgaSkgPT4gewogICAgICAgIGNvbnN0IGlzVXNl' +
  'ZCA9IHVzZWQuaGFzKGkpOwogICAgICAgIGNvbnN0IG4gPSBvcmRlci5nZXQoaSk7CiAgICAgICAgcmV0dXJuIGA8YnV0dG9uIGNs' +
  'YXNzPSJsY2VsbCR7aXNVc2VkID8gJyB1c2VkJyA6ICcnfSR7biA/ICcgbmV4dCcgOiAnJ30iIGRhdGEtY2VsbD0iJHtpfSIKICAg' +
  'ICAgICAgIHRpdGxlPSJQb3NpdGlvbiAke2kgKyAxfSI+JHtpc1VzZWQgPyAnw5cnIDogKG4gfHwgJycpfTwvYnV0dG9uPmA7CiAg' +
  'ICAgIH0pLmpvaW4oJycpICsgJzwvZGl2Pic7CgogICAgJCgnI2ZyZWVDb3VudCcpLnRleHRDb250ZW50ID0gZnJlZS5sZW5ndGgg' +
  'KyAnIG9mICcgKyBtZXRhLmNhcGFjaXR5ICsgJyBsZWZ0JzsKICAgICQoJyNwaWNrQ291bnQnKS50ZXh0Q29udGVudCA9IFMuY2Fj' +
  'aGUucGlja2VkLmxlbmd0aCArICcgc2VsZWN0ZWQnOwogICAgY29uc3Qgb3ZlciA9IFMuY2FjaGUucGlja2VkLmxlbmd0aCA+IGZy' +
  'ZWUubGVuZ3RoOwogICAgY29uc3QgYnRuID0gJCgnI3ByaW50QnRuJyk7CiAgICBidG4uZGlzYWJsZWQgPSAhUy5jYWNoZS5waWNr' +
  'ZWQubGVuZ3RoOwogICAgYnRuLnRleHRDb250ZW50ID0gb3ZlcgogICAgICA/IGBQcmludCAke2ZyZWUubGVuZ3RofSBub3cgKCR7' +
  'Uy5jYWNoZS5waWNrZWQubGVuZ3RoIC0gZnJlZS5sZW5ndGh9IHdvbid0IGZpdClgCiAgICAgIDogYFByaW50ICR7Uy5jYWNoZS5w' +
  'aWNrZWQubGVuZ3RofSBsYWJlbCR7Uy5jYWNoZS5waWNrZWQubGVuZ3RoID09PSAxID8gJycgOiAncyd9YDsKCiAgICBkb2N1bWVu' +
  'dC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1jZWxsXScpLmZvckVhY2goYyA9PiBjLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAg' +
  'ICAgIGNvbnN0IGkgPSArYy5kYXRhc2V0LmNlbGw7CiAgICAgIGNvbnN0IHNldCA9IG5ldyBTZXQoUy5jYWNoZS5zaGVldC51c2Vk' +
  'Lm1hcChOdW1iZXIpKTsKICAgICAgc2V0LmhhcyhpKSA/IHNldC5kZWxldGUoaSkgOiBzZXQuYWRkKGkpOwogICAgICBhd2FpdCBz' +
  'YXZlU2hlZXQoeyB1c2VkOiBbLi4uc2V0XSB9KTsKICAgIH0pOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVNoZWV0KHBhdGNo' +
  'KSB7CiAgICB0cnkgewogICAgICBTLmNhY2hlLnNoZWV0ID0gYXdhaXQgYXBpKCcvbGFiZWwtc2hlZXQnLCB7IG1ldGhvZDogJ1BB' +
  'VENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkocGF0Y2gpIH0pOwogICAgICBkcmF3R3JpZCgpOwogICAgfSBjYXRjaCAoZSkgeyB0' +
  'b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfQoKICAkKCcjbGF5b3V0Jykub25jaGFuZ2UgPSBlID0+IHNhdmVTaGVldCh7IGxh' +
  'eW91dDogZS50YXJnZXQudmFsdWUgfSk7CiAgJCgnI25ld1NoZWV0Jykub25jbGljayA9ICgpID0+IHNhdmVTaGVldCh7IHVzZWQ6' +
  'IFtdIH0pOwogICQoJyNhbGxVc2VkJykub25jbGljayA9ICgpID0+CiAgICBzYXZlU2hlZXQoeyB1c2VkOiBBcnJheS5mcm9tKHsg' +
  'bGVuZ3RoOiBsYXlvdXRNZXRhKCkuY2FwYWNpdHkgfSwgKF8sIGkpID0+IGkpIH0pOwogICQoJyNzYXZlT2ZmJykub25jbGljayA9' +
  'IGFzeW5jICgpID0+IHsKICAgIGF3YWl0IHNhdmVTaGVldCh7IG9mZnNldF94OiBOdW1iZXIoJCgnI29mZlgnKS52YWx1ZSkgfHwg' +
  'MCwgb2Zmc2V0X3k6IE51bWJlcigkKCcjb2ZmWScpLnZhbHVlKSB8fCAwIH0pOwogICAgdG9hc3QoJ0FsaWdubWVudCBzYXZlZCcp' +
  'OwogIH07CgogIGNvbnN0IHBhaW50ID0gKCkgPT4gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdGlja10nKS5mb3JF' +
  'YWNoKHQgPT4gewogICAgY29uc3Qgb24gPSBTLmNhY2hlLnBpY2tlZC5pbmNsdWRlcygrdC5kYXRhc2V0LnRpY2spOwogICAgdC50' +
  'ZXh0Q29udGVudCA9IG9uID8gJ+KckyBhZGRlZCcgOiAnYWRkJzsKICAgIHQuY2xhc3NOYW1lID0gb24gPyAncGlsbCBTZXJ2ZWQn' +
  'IDogJ3BpbGwnOwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBpY2tdJykuZm9yRWFjaChyb3cgPT4g' +
  'cm93Lm9uY2xpY2sgPSAoKSA9PiB7CiAgICBjb25zdCBpZCA9ICtyb3cuZGF0YXNldC5waWNrOwogICAgY29uc3QgaSA9IFMuY2Fj' +
  'aGUucGlja2VkLmluZGV4T2YoaWQpOwogICAgaSA9PT0gLTEgPyBTLmNhY2hlLnBpY2tlZC5wdXNoKGlkKSA6IFMuY2FjaGUucGlj' +
  'a2VkLnNwbGljZShpLCAxKTsKICAgIHBhaW50KCk7IGRyYXdHcmlkKCk7CiAgfSk7CiAgJCgnI2pvYkZpbHRlcicpLm9uaW5wdXQg' +
  'PSBlID0+IHsKICAgIGNvbnN0IHYgPSBlLnRhcmdldC52YWx1ZS50b0xvd2VyQ2FzZSgpOwogICAgZG9jdW1lbnQucXVlcnlTZWxl' +
  'Y3RvckFsbCgnW2RhdGEtcGlja10nKS5mb3JFYWNoKHIgPT4gewogICAgICByLnN0eWxlLmRpc3BsYXkgPSByLmlubmVyVGV4dC50' +
  'b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHYpID8gJycgOiAnbm9uZSc7CiAgICB9KTsKICB9OwoKICAkKCcjdGVzdEJ0bicpLm9uY2xp' +
  'Y2sgPSAoKSA9PiB7CiAgICBjb25zdCBpZHMgPSBTLmNhY2hlLnBpY2tlZC5sZW5ndGggPyBTLmNhY2hlLnBpY2tlZCA6IChqb2Jz' +
  'WzBdID8gW2pvYnNbMF0uaWRdIDogW10pOwogICAgaWYgKCFpZHMubGVuZ3RoKSByZXR1cm4gdG9hc3QoJ0FkZCBhdCBsZWFzdCBv' +
  'bmUgam9iIGZpcnN0JywgdHJ1ZSk7CiAgICB3aW5kb3cub3BlbignL3ByaW50L2xhYmVscz9ndWlkZXM9MSZpZHM9JyArIGlkcy5q' +
  'b2luKCcsJyksICdfYmxhbmsnKTsKICB9OwoKICAkKCcjcHJpbnRCdG4nKS5vbmNsaWNrID0gKCkgPT4gewogICAgY29uc3QgbWV0' +
  'YSA9IGxheW91dE1ldGEoKTsKICAgIGNvbnN0IHVzZWQgPSBuZXcgU2V0KFMuY2FjaGUuc2hlZXQudXNlZC5tYXAoTnVtYmVyKSk7' +
  'CiAgICBjb25zdCBmcmVlID0gW107CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1ldGEuY2FwYWNpdHk7IGkrKykgaWYgKCF1c2Vk' +
  'LmhhcyhpKSkgZnJlZS5wdXNoKGkpOwogICAgY29uc3Qgd2lsbFVzZSA9IGZyZWUuc2xpY2UoMCwgUy5jYWNoZS5waWNrZWQubGVu' +
  'Z3RoKTsKICAgIHdpbmRvdy5vcGVuKCcvcHJpbnQvbGFiZWxzP2lkcz0nICsgUy5jYWNoZS5waWNrZWQuam9pbignLCcpLCAnX2Js' +
  'YW5rJyk7CgogICAgY29uZmlybVByaW50ZWQod2lsbFVzZSk7CiAgfTsKCiAgZnVuY3Rpb24gY29uZmlybVByaW50ZWQod2lsbFVz' +
  'ZSkgewogICAgc2hlZXQoJ0RpZCB0aGV5IHByaW50PycsIGAKICAgICAgPHAgY2xhc3M9ImhpbnQiPk9ubHkgbWFyayB0aGVzZSB1' +
  'c2VkIG9uY2UgdGhlIHNoZWV0IGFjdHVhbGx5IGNhbWUgb3V0IHJpZ2h0IOKAlCBpZiB0aGUgcHJpbnRlcgogICAgICAgIGphbW1l' +
  'ZCBvciB0aGUgYWxpZ25tZW50IHdhcyBvZmYsIHNheSBubyBhbmQgbm90aGluZyBjaGFuZ2VzLjwvcD4KICAgICAgPHA+PGI+JHt3' +
  'aWxsVXNlLmxlbmd0aH08L2I+IHBvc2l0aW9uJHt3aWxsVXNlLmxlbmd0aCA9PT0gMSA/ICcnIDogJ3MnfSB3b3VsZCBiZSBtYXJr' +
  'ZWQgdXNlZDoKICAgICAgICAke3dpbGxVc2UubWFwKGkgPT4gaSArIDEpLmpvaW4oJywgJyl9PC9wPgogICAgICA8ZGl2IGNsYXNz' +
  'PSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBvayIgaWQ9Inllc1VzZWQi' +
  'PlllcyDigJQgbWFyayB0aGVtIHVzZWQ8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJj' +
  'bG9zZVNoZWV0KCkiPk5vLCBrZWVwIHRoZW0gZnJlZTwvYnV0dG9uPgogICAgICA8L2Rpdj5gLCBlbCA9PiB7CiAgICAgIGVsLnF1' +
  'ZXJ5U2VsZWN0b3IoJyN5ZXNVc2VkJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgICBjb25zdCBzZXQgPSBuZXcgU2V0' +
  'KFMuY2FjaGUuc2hlZXQudXNlZC5tYXAoTnVtYmVyKSk7CiAgICAgICAgd2lsbFVzZS5mb3JFYWNoKGkgPT4gc2V0LmFkZChpKSk7' +
  'CiAgICAgICAgYXdhaXQgc2F2ZVNoZWV0KHsgdXNlZDogWy4uLnNldF0gfSk7CiAgICAgICAgUy5jYWNoZS5waWNrZWQgPSBbXTsK' +
  'ICAgICAgICBjbG9zZVNoZWV0KCk7CiAgICAgICAgdG9hc3QoJ1NoZWV0IHVwZGF0ZWQg4oCUICcgKyBTLmNhY2hlLnNoZWV0LmZy' +
  'ZWUgKyAnIGxhYmVscyBsZWZ0Jyk7CiAgICAgICAgZ28oJ3Rvb2xzJyk7CiAgICAgIH07CiAgICB9KTsKICB9CgogIHBhaW50KCk7' +
  'CiAgZHJhd0dyaWQoKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBw' +
  'cm9wZXJ0eSBzZWFyY2ggLS0gKi8KLyogVHdvIGRpZmZlcmVudCByZWNvcmRzIHN5c3RlbXMsIGFuZCB0aGUgZGlmZmVyZW5jZSBt' +
  'YXR0ZXJzOgogICB0aGUgY291bnR5IENMRVJLIGhvbGRzIGRlZWRzIGFuZCBsaWVucyAod2hvIGJvdWdodCwgc29sZCwgb3IgaGFz' +
  'IGEgY2xhaW0pLAogICB0aGUgQVBQUkFJU0FMIERJU1RSSUNUIGhvbGRzIHdobyBvd25zIGl0IG5vdyBhbmQgd2hlcmUgdGhlaXIg' +
  'dGF4IGJpbGwgaXMKICAgcG9zdGVkIC0tIHdoaWNoIGlzIHVzdWFsbHkgdGhlIGJldHRlciBsZWFkIHdoZW4gYW4gYWRkcmVzcyBo' +
  'YXMgZ29uZSBzdGFsZS4gKi8KY29uc3QgQ09VTlRJRVMgPSBbCiAgewogICAgbmFtZTogJ0hpZGFsZ28gQ291bnR5JywKICAgIGNs' +
  'ZXJrOiB7IHVybDogJ2h0dHBzOi8vaGlkYWxnby50eC5wdWJsaWNzZWFyY2gudXMvJywgbm90ZTogJ0RlZWRzLCBsaWVucywgdHJh' +
  'bnNmZXJzLiBHcmFudG9yL2dyYW50ZWUsIGRvYyBudW1iZXIsIGZ1bGwtdGV4dCBPQ1IuIE5vIGxvZ2luLicgfSwKICAgIGNhZDog' +
  'eyB1cmw6ICdodHRwczovL2hpZGFsZ28ucHJvZGlneWNhZC5jb20vcHJvcGVydHktc2VhcmNoJywgbm90ZTogJ0N1cnJlbnQgb3du' +
  'ZXIsIG1haWxpbmcgYWRkcmVzcywgc2l0dXMgYWRkcmVzcywgdmFsdWF0aW9uLicgfSwKICAgIGNhZEFsdDogeyB1cmw6ICdodHRw' +
  'czovL3Byb3BhY2Nlc3MuaGlkYWxnb2FkLm9yZy9DbGllbnREQi9Qcm9wZXJ0eVNlYXJjaC5hc3B4P2NpZD0xJywgbm90ZTogJ09s' +
  'ZGVyIEhpZGFsZ28gQ0FEIHNlYXJjaCwgaWYgdGhlIG5ldyBvbmUgaXMgZG93bi4nIH0KICB9LAogIHsKICAgIG5hbWU6ICdDYW1l' +
  'cm9uIENvdW50eScsCiAgICBjbGVyazogeyB1cmw6ICdodHRwczovL2NhbWVyb24udHgucHVibGljc2VhcmNoLnVzLycsIG5vdGU6' +
  'ICdEZWVkcywgbGllbnMsIHRyYW5zZmVycywgZm9yZWNsb3N1cmUgcG9zdGluZ3MuIE5vIGxvZ2luLicgfSwKICAgIGNhZDogeyB1' +
  'cmw6ICdodHRwczovL2NhbWVyb24ucHJvZGlneWNhZC5jb20vJywgbm90ZTogJ0N1cnJlbnQgb3duZXIsIG1haWxpbmcgYWRkcmVz' +
  'cywgc2l0dXMgYWRkcmVzcywgdmFsdWF0aW9uLicgfSwKICAgIGNhZEFsdDogeyB1cmw6ICdodHRwOi8vcHJvcGFjY2Vzcy5jYW1l' +
  'cm9uY2FkLm9yZy9jbGllbnRkYi9Qcm9wZXJ0eVNlYXJjaC5hc3B4P2NpZD0xJywgbm90ZTogJ09sZGVyIENhbWVyb24gQ0FEIHNl' +
  'YXJjaCwgaWYgdGhlIG5ldyBvbmUgaXMgZG93bi4nIH0KICB9LAogIHsKICAgIG5hbWU6ICdTdGFyciBDb3VudHknLAogICAgY2xl' +
  'cms6IHsgdXJsOiAnaHR0cHM6Ly9zdGFyci50eC5wdWJsaWNzZWFyY2gudXMvJywgbm90ZTogJ0RlZWRzLCBsaWVucywgdHJhbnNm' +
  'ZXJzLiBTYW1lIHN5c3RlbSBhcyBIaWRhbGdvIGFuZCBDYW1lcm9uLicgfSwKICAgIGNhZDogeyB1cmw6ICdodHRwczovL2VzZWFy' +
  'Y2guc3RhcnJjYWQub3JnLycsIG5vdGU6ICdDdXJyZW50IG93bmVyLCBtYWlsaW5nIGFkZHJlc3MsIHNpdHVzIGFkZHJlc3MuJyB9' +
  'CiAgfQpdOwoKZnVuY3Rpb24gcHJvcGVydHlWaWV3KCkgewogIGNvbnN0IHJvd3MgPSBDT1VOVElFUy5tYXAoKGMsIGNpKSA9PiBg' +
  'CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPiR7ZXNjKGMubmFtZSl9PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ibGlz' +
  'dCI+CiAgICAgICAgPGRpdiBjbGFzcz0iaXRlbSIgZGF0YS1wcm9wPSIke2NpfTpjYWQiPgogICAgICAgICAgPGRpdiBjbGFzcz0i' +
  'dCI+QXBwcmFpc2FsIGRpc3RyaWN0IOKAlCB3aG8gb3ducyBpdCBub3c8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9Im0iPiR7' +
  'ZXNjKGMuY2FkLm5vdGUpfTwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Iml0ZW0iIGRhdGEtcHJvcD0i' +
  'JHtjaX06Y2xlcmsiPgogICAgICAgICAgPGRpdiBjbGFzcz0idCI+Q291bnR5IGNsZXJrIOKAlCBkZWVkcyAmYW1wOyBsaWVuczwv' +
  'ZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0ibSI+JHtlc2MoYy5jbGVyay5ub3RlKX08L2Rpdj4KICAgICAgICA8L2Rpdj4KICAg' +
  'ICAgICAke2MuY2FkQWx0ID8gYDxkaXYgY2xhc3M9Iml0ZW0iIGRhdGEtcHJvcD0iJHtjaX06Y2FkQWx0Ij4KICAgICAgICAgIDxk' +
  'aXYgY2xhc3M9InQiPkFwcHJhaXNhbCBkaXN0cmljdCAob2xkZXIgc2VhcmNoKTwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0i' +
  'bSI+JHtlc2MoYy5jYWRBbHQubm90ZSl9PC9kaXY+CiAgICAgICAgPC9kaXY+YCA6ICcnfQogICAgICA8L2Rpdj4KICAgIDwvZGl2' +
  'PmApLmpvaW4oJycpOwoKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5Qcm9wZXJ0eSByZWNv' +
  'cmRzPC9oMT4KICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8bGFiZWw+TmFtZSBvciBhZGRyZXNzIHRvIGxvb2sgdXA8L2xh' +
  'YmVsPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAgIDxpbnB1dCBpZD0icHJvcFEiIHBsYWNlaG9sZGVyPSJHQVJaQSBN' +
  'QVJJQSAgb3IgIDEyMDQgRSBNYWluIFN0IiBzdHlsZT0iZmxleDoxO21pbi13aWR0aDoxNjBweCI+CiAgICAgICAgPGJ1dHRvbiBj' +
  'bGFzcz0iYnRuIHNtIiBpZD0icHJvcENvcHkiPkNvcHk8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxwIGNsYXNzPSJoaW50' +
  'Ij5UaGVzZSBzaXRlcyBjYW4ndCBiZSBsaW5rZWQgdG8gd2l0aCBhIHNlYXJjaCB0ZXJtLCBzbyB0YXBwaW5nIG9uZSBjb3BpZXMg' +
  'd2hhdCB5b3UgdHlwZWQKICAgICAgICBhbmQgb3BlbnMgdGhlaXIgc2VhcmNoIHBhZ2Ug4oCUIHBhc3RlIGl0IGludG8gdGhlaXIg' +
  'Ym94LjwvcD4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOiNmOGZhZmM7Ym94LXNo' +
  'YWRvdzpub25lIj4KICAgICAgPGgyPldoaWNoIG9uZSBkbyB5b3Ugd2FudD88L2gyPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5' +
  'bGU9Im1hcmdpbjowIj4KICAgICAgICA8Yj5BcHByYWlzYWwgZGlzdHJpY3Q8L2I+IOKAlCBjdXJyZW50IG93bmVyIGFuZCB0aGUg' +
  'bWFpbGluZyBhZGRyZXNzIHRoZSB0YXggYmlsbCBnb2VzIHRvLiBCZXN0IGZvcgogICAgICAgIGNvbmZpcm1pbmcgdGhlIHBlcnNv' +
  'biBvbiB5b3VyIHBhcGVycyBpcyB0aWVkIHRvIHRoZSBhZGRyZXNzLCBhbmQgZm9yIGZpbmRpbmcgc29tZXdoZXJlIGVsc2UgdG8g' +
  'dHJ5Ljxicj48YnI+CiAgICAgICAgPGI+Q291bnR5IGNsZXJrPC9iPiDigJQgZGVlZHMsIGxpZW5zIGFuZCB0cmFuc2ZlcnMuIEJl' +
  'c3QgZm9yIGhpc3Rvcnk6IHdobyBzb2xkIGl0LCB3aGVuLCBhbmQgd2hvIGhvbGRzIGEgY2xhaW0uCiAgICAgICAgV29uJ3QgcmVs' +
  'aWFibHkgdGVsbCB5b3Ugd2hvIGxpdmVzIHRoZXJlIG5vdy48L3A+CiAgICA8L2Rpdj4KCiAgICAke3Jvd3N9CgogICAgPGRpdiBj' +
  'bGFzcz0iY2FyZCI+CiAgICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjAiPkEgbWFpbGluZyBhZGRyZXNzIGZyb20g' +
  'dGhlIGFwcHJhaXNhbCBkaXN0cmljdCBpcyBhIGxlYWQsIG5vdCBwcm9vZiBvZgogICAgICAgIHJlc2lkZW5jZSDigJQgcGxlbnR5' +
  'IG9mIG93bmVycyBoYXZlIHBvc3QgZ29uZSB0byBhbiBhZ2VudCwgYSByZWxhdGl2ZSwgb3IgYW5vdGhlciBzdGF0ZS4gVHJlYXQg' +
  'aXQgYXMgYQogICAgICAgIHBsYWNlIHRvIGF0dGVtcHQsIGFuZCByZWNvcmQgd2hhdCB5b3UgYWN0dWFsbHkgZmluZCBpbiB0aGUg' +
  'YXR0ZW1wdCBub3Rlcy48L3A+CiAgICA8L2Rpdj5gKTsKICBiaW5kU2hlbGwoKTsKCiAgY29uc3QgY29weVRlcm0gPSBhc3luYyAo' +
  'KSA9PiB7CiAgICBjb25zdCB2ID0gJCgnI3Byb3BRJykudmFsdWUudHJpbSgpOwogICAgaWYgKCF2KSByZXR1cm4gZmFsc2U7CiAg' +
  'ICB0cnkgeyBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dCh2KTsgcmV0dXJuIHRydWU7IH0gY2F0Y2ggKGUpIHsg' +
  'cmV0dXJuIGZhbHNlOyB9CiAgfTsKICAkKCcjcHJvcENvcHknKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgY29uc3QgdiA9' +
  'ICQoJyNwcm9wUScpLnZhbHVlLnRyaW0oKTsKICAgIGlmICghdikgcmV0dXJuIHRvYXN0KCdUeXBlIGEgbmFtZSBvciBhZGRyZXNz' +
  'IGZpcnN0JywgdHJ1ZSk7CiAgICB0b2FzdChhd2FpdCBjb3B5VGVybSgpID8gJ0NvcGllZCAiJyArIHYgKyAnIicgOiAnQ29weSBm' +
  'YWlsZWQg4oCUIHNlbGVjdCBpdCBieSBoYW5kJyk7CiAgfTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1wcm9w' +
  'XScpLmZvckVhY2gocm93ID0+IHJvdy5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgY29uc3QgW2NpLCB3aGljaF0gPSByb3cu' +
  'ZGF0YXNldC5wcm9wLnNwbGl0KCc6Jyk7CiAgICBjb25zdCB0YXJnZXQgPSBDT1VOVElFU1srY2ldW3doaWNoXTsKICAgIGNvbnN0' +
  'IGhhZCA9ICQoJyNwcm9wUScpLnZhbHVlLnRyaW0oKTsKICAgIGNvbnN0IG9rID0gaGFkID8gYXdhaXQgY29weVRlcm0oKSA6IGZh' +
  'bHNlOwogICAgdG9hc3Qob2sgPyAnQ29waWVkICInICsgaGFkICsgJyIg4oCUIHBhc3RlIGl0IGludG8gdGhlaXIgc2VhcmNoJyA6' +
  'ICdPcGVuaW5nICcgKyBDT1VOVElFU1srY2ldLm5hbWUpOwogICAgd2luZG93Lm9wZW4odGFyZ2V0LnVybCwgJ19ibGFuaycpOwog' +
  'IH0pOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBjYXNlIGxv' +
  'b2t1cCAtLSAqLwovKiBOb25lIG9mIHRoZXNlIHBvcnRhbHMgYWNjZXB0IGEgY2FzZSBudW1iZXIgaW4gdGhlIFVSTCAtLSBIaWRh' +
  'bGdvJ3MgcnVucyBvbgogICBzZXNzaW9uLWJhc2VkIGZvcm0gcG9zdHMsIENhbWVyb24ncyBzaXRzIGJlaGluZCBhIEphdmFTY3Jp' +
  'cHQgZ2F0ZS4gU28gdGhpcwogICBjb3BpZXMgdGhlIG51bWJlciB0byB0aGUgY2xpcGJvYXJkIGFuZCBvcGVucyB0aGUgcmlnaHQg' +
  'c2VhcmNoIHBhZ2UuIE5vCiAgIHNjcmFwaW5nLCBub3RoaW5nIHRvIGJyZWFrIHdoZW4gdGhleSByZWRlc2lnbi4gKi8KY29uc3Qg' +
  'VFhfUE9SVEFMUyA9IFsKICB7IG5hbWU6ICdyZTpTZWFyY2hUWCDigJQgc3RhdGV3aWRlJywgdXJsOiAnaHR0cHM6Ly9yZXNlYXJj' +
  'aC50eGNvdXJ0cy5nb3YvJywKICAgIG5vdGU6ICdGcmVlIGFjY291bnQgcmVxdWlyZWQuIERpc3RyaWN0LCBjb3VudHkgYW5kIHBy' +
  'b2JhdGUgY291cnRzIGluIGFsbCAyNTQgY291bnRpZXMuICcgKwogICAgICAgICAgJ1B1YmxpYyB2aWV3IHN0YXJ0cyBhdCBmaWxp' +
  'bmdzIGZyb20gMSBOb3YgMjAxOC4gSnVzdGljZS1vZi10aGUtcGVhY2UgZXZpY3Rpb25zIGFyZSBwYXRjaHkuJyB9LAogIHsgbmFt' +
  'ZTogJ0hpZGFsZ28gQ291bnR5IOKAlCBEaXN0cmljdCBDbGVyayBjYXNlIHNlYXJjaCcsIHVybDogJ2h0dHBzOi8vcGEuY28uaGlk' +
  'YWxnby50eC51cy9kZWZhdWx0LmFzcHgnLAogICAgbm90ZTogJ0NpdmlsIGFuZCBjcmltaW5hbCBjYXNlcy4gRnJlZSwgbm8gbG9n' +
  'aW4uJyB9LAogIHsgbmFtZTogJ0NhbWVyb24gQ291bnR5IOKAlCBjb3VydCBwb3J0YWxzJywgdXJsOiAnaHR0cHM6Ly93d3cuY2Ft' +
  'ZXJvbmNvdW50eXR4Lmdvdi9jYW1lcm9uLWNvdW50eS1wb3J0YWxzLycsCiAgICBub3RlOiAnSW5kZXggcGFnZSBmb3IgdGhlIGNv' +
  'dW50eVwncyBkaXN0cmljdCBhbmQgY291bnR5IGNsZXJrIHNlYXJjaGVzLicgfSwKICB7IG5hbWU6ICdDYW1lcm9uIENvdW50eSDi' +
  'gJQgRGlzdHJpY3QgQ2xlcmsgcmVjb3JkcycsIHVybDogJ2h0dHBzOi8va29maWxlcXVpY2tsaW5rcy5jb20vY2FtZXJvbmRjLycs' +
  'CiAgICBub3RlOiAnRGlzdHJpY3QgQ2xlcmsgcmVjb3JkIHNlYXJjaC4nIH0sCiAgeyBuYW1lOiAnSGlkYWxnbyBDb3VudHkg4oCU' +
  'IHByb3BlcnR5IC8gb2ZmaWNpYWwgcmVjb3JkcycsIHVybDogJ2h0dHBzOi8vaGlkYWxnby50eC5wdWJsaWNzZWFyY2gudXMvJywK' +
  'ICAgIG5vdGU6ICdEZWVkcywgbGllbnMgYW5kIG93bmVyc2hpcCBmcm9tIHRoZSBDb3VudHkgQ2xlcmsg4oCUIHByb3BlcnR5LCBu' +
  'b3QgbGF3c3VpdHMuICcgKwogICAgICAgICAgJ1VzZWZ1bCBmb3IgY29uZmlybWluZyB3aG8gYWN0dWFsbHkgb3ducyBhbiBhZGRy' +
  'ZXNzLicgfQpdOwoKZnVuY3Rpb24gY2FzZUxvb2t1cFNoZWV0KGpvYikgewogIHNoZWV0KCdMb29rIHVwICcgKyBqb2IuY2FzZV9u' +
  'dW1iZXIsIGAKICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOiNmOGZhZmM7Ym94LXNoYWRvdzpub25lO3Rl' +
  'eHQtYWxpZ246Y2VudGVyIj4KICAgICAgPGRpdiBzdHlsZT0iZm9udDo2MDAgMjBweC8xLjMgbW9ub3NwYWNlO2xldHRlci1zcGFj' +
  'aW5nOi41cHgiPiR7ZXNjKGpvYi5jYXNlX251bWJlcil9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKGpvYi5j' +
  'b3VydCB8fCAnY291cnQgbm90IHJlY29yZGVkJyl9PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9ImNvcHlD' +
  'YXNlIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij5Db3B5IGNhc2UgbnVtYmVyPC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDxwIGNs' +
  'YXNzPSJoaW50Ij5UaGVzZSBwb3J0YWxzIGNhbid0IGJlIGxpbmtlZCB0byBkaXJlY3RseSB3aXRoIGEgY2FzZSBudW1iZXIsIHNv' +
  'IHRhcHBpbmcgb25lIGNvcGllcwogICAgICB0aGUgbnVtYmVyIGFuZCBvcGVucyB0aGVpciBzZWFyY2ggcGFnZSDigJQgcGFzdGUg' +
  'aXQgaW50byB0aGVpciBib3guPC9wPgogICAgPGRpdiBjbGFzcz0ibGlzdCI+CiAgICAgICR7VFhfUE9SVEFMUy5tYXAoKHAsIGkp' +
  'ID0+IGAKICAgICAgICA8ZGl2IGNsYXNzPSJpdGVtIiBkYXRhLXBvcnRhbD0iJHtpfSI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ0' +
  'Ij4ke2VzYyhwLm5hbWUpfTwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0ibSI+JHtlc2MocC5ub3RlKX08L2Rpdj4KICAgICAg' +
  'ICA8L2Rpdj5gKS5qb2luKCcnKX0KICAgIDwvZGl2PgogICAgPHAgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgi' +
  'PkNvdXJ0IHJlY29yZHMgcmFyZWx5IHB1Ymxpc2ggYSBkZWZlbmRhbnQncyBzZXJ2aWNlIGFkZHJlc3Mg4oCUCiAgICAgIHRoYXQg' +
  'bm9ybWFsbHkgb25seSBleGlzdHMgb24gdGhlIGNsaWVudCdzIHBhY2tldC48L3A+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2Vj' +
  'IGJsb2NrIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiIG9uY2xpY2s9ImNsb3NlU2hlZXQoKSI+Q2xvc2U8L2J1dHRvbj5gLCBlbCA9' +
  'PiB7CiAgICBjb25zdCBjb3B5ID0gYXN5bmMgKCkgPT4gewogICAgICB0cnkgeyBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndy' +
  'aXRlVGV4dChqb2IuY2FzZV9udW1iZXIpOyByZXR1cm4gdHJ1ZTsgfQogICAgICBjYXRjaCAoZSkgeyByZXR1cm4gZmFsc2U7IH0K' +
  'ICAgIH07CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjY29weUNhc2UnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4KICAgICAgdG9hc3Qo' +
  'YXdhaXQgY29weSgpID8gJ0NvcGllZCAnICsgam9iLmNhc2VfbnVtYmVyIDogJ0NvcHkgZmFpbGVkIOKAlCBzZWxlY3QgaXQgYnkg' +
  'aGFuZCcsIGZhbHNlKTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBvcnRhbF0nKS5mb3JFYWNoKHJvdyA9PiByb3cu' +
  'b25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgcCA9IFRYX1BPUlRBTFNbK3Jvdy5kYXRhc2V0LnBvcnRhbF07CiAg' +
  'ICAgIGNvbnN0IG9rID0gYXdhaXQgY29weSgpOwogICAgICB0b2FzdChvayA/ICdDYXNlIG51bWJlciBjb3BpZWQg4oCUIHBhc3Rl' +
  'IGl0IGludG8gdGhlaXIgc2VhcmNoJyA6ICdPcGVuaW5nICcgKyBwLm5hbWUpOwogICAgICB3aW5kb3cub3BlbihwLnVybCwgJ19i' +
  'bGFuaycpOwogICAgfSk7CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLSBzY2FuIC0tICovCmZ1bmN0aW9uIHNjYW5WaWV3KCkgewogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChg' +
  'CiAgICA8aDEgY2xhc3M9InBhZ2UiPlNjYW4gYSBwYWNrZXQ8L2gxPgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxwIGNs' +
  'YXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDowIj5Qb2ludCB0aGUgY2FtZXJhIGF0IHRoZSBiYXJjb2RlIG9uIHRoZSBjb3Zl' +
  'ciBzaGVldCB0byBvcGVuIHRoYXQgam9iLiBJZiB0aGUgY2FtZXJhCiAgICAgIHdvbid0IGNvb3BlcmF0ZSwgdHlwZSB0aGUgam9i' +
  'IG51bWJlciBpbnN0ZWFkIOKAlCBpdCB3b3JrcyB0aGUgc2FtZS48L3A+CiAgICAgIDxkaXYgaWQ9InJlYWRlciI+PC9kaXY+CiAg' +
  'ICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBp' +
  'ZD0ic3RhcnRTY2FuIj5TdGFydCBjYW1lcmE8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBpZD0ic3Rv' +
  'cFNjYW5CdG4iIHN0eWxlPSJkaXNwbGF5Om5vbmUiPlN0b3A8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9' +
  'ImhpbnQiIGlkPSJzY2FuTXNnIj48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5FbnRl' +
  'ciBqb2IgbnVtYmVyPC9oMj4KICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgICA8aW5wdXQgaWQ9Im1hbnVhbCIgcGxhY2Vo' +
  'b2xkZXI9IlNULTEwMDAxIiBzdHlsZT0iZmxleDoxO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZSI+CiAgICAgICAgPGJ1dHRvbiBj' +
  'bGFzcz0iYnRuIiBpZD0ibWFudWFsR28iPk9wZW48L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj5gKTsKICBiaW5kU2hl' +
  'bGwoKTsKCiAgY29uc3Qgb3BlbiA9IGFzeW5jIGNvZGUgPT4gewogICAgdHJ5IHsKICAgICAgY29uc3QgaiA9IGF3YWl0IGFwaSgn' +
  'L2xvb2t1cC8nICsgZW5jb2RlVVJJQ29tcG9uZW50KGNvZGUpKTsKICAgICAgaWYgKHdpbmRvdy5fX3N0b3BTY2FuKSB7IHdpbmRv' +
  'dy5fX3N0b3BTY2FuKCk7IHdpbmRvdy5fX3N0b3BTY2FuID0gbnVsbDsgfQogICAgICB0b2FzdCgnT3BlbmluZyAnICsgai5qb2Jf' +
  'bnVtYmVyKTsKICAgICAgZ28oJ2pvYicsIHsgaWQ6IGouaWQgfSk7CiAgICB9IGNhdGNoIChlKSB7ICQoJyNzY2FuTXNnJykudGV4' +
  'dENvbnRlbnQgPSBlLm1lc3NhZ2U7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9OwoKICAkKCcjbWFudWFsR28nKS5vbmNs' +
  'aWNrID0gKCkgPT4geyBjb25zdCB2ID0gJCgnI21hbnVhbCcpLnZhbHVlLnRyaW0oKTsgaWYgKHYpIG9wZW4odik7IH07CiAgJCgn' +
  'I21hbnVhbCcpLm9ua2V5ZG93biA9IGUgPT4geyBpZiAoZS5rZXkgPT09ICdFbnRlcicpICQoJyNtYW51YWxHbycpLmNsaWNrKCk7' +
  'IH07CgogICQoJyNzdGFydFNjYW4nKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgY29uc3QgbXNnID0gJCgnI3NjYW5Nc2cn' +
  'KTsKICAgIGlmICghd2luZG93LlpYaW5nKSByZXR1cm4gbXNnLnRleHRDb250ZW50ID0gJ1NjYW5uZXIgbGlicmFyeSBkaWQgbm90' +
  'IGxvYWQg4oCUIHVzZSB0aGUgam9iIG51bWJlciBib3ggYmVsb3cuJzsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJlYWRlciA9IG5l' +
  'dyBaWGluZy5Ccm93c2VyTXVsdGlGb3JtYXRSZWFkZXIoKTsKICAgICAgY29uc3QgdmlkZW8gPSBkb2N1bWVudC5jcmVhdGVFbGVt' +
  'ZW50KCd2aWRlbycpOwogICAgICB2aWRlby5zZXRBdHRyaWJ1dGUoJ3BsYXlzaW5saW5lJywgJ3RydWUnKTsKICAgICAgJCgnI3Jl' +
  'YWRlcicpLmlubmVySFRNTCA9ICcnOwogICAgICAkKCcjcmVhZGVyJykuYXBwZW5kQ2hpbGQodmlkZW8pOwogICAgICAkKCcjc3Rh' +
  'cnRTY2FuJykuc3R5bGUuZGlzcGxheSA9ICdub25lJzsKICAgICAgJCgnI3N0b3BTY2FuQnRuJykuc3R5bGUuZGlzcGxheSA9ICcn' +
  'OwogICAgICBtc2cudGV4dENvbnRlbnQgPSAnTG9va2luZyBmb3IgYSBiYXJjb2Rl4oCmJzsKICAgICAgbGV0IGhhbmRsZWQgPSBm' +
  'YWxzZTsKICAgICAgYXdhaXQgcmVhZGVyLmRlY29kZUZyb21Db25zdHJhaW50cygKICAgICAgICB7IHZpZGVvOiB7IGZhY2luZ01v' +
  'ZGU6ICdlbnZpcm9ubWVudCcgfSB9LCB2aWRlbywKICAgICAgICAocmVzdWx0KSA9PiB7IGlmIChyZXN1bHQgJiYgIWhhbmRsZWQp' +
  'IHsgaGFuZGxlZCA9IHRydWU7IG9wZW4ocmVzdWx0LmdldFRleHQoKSk7IH0gfSk7CiAgICAgIHdpbmRvdy5fX3N0b3BTY2FuID0g' +
  'KCkgPT4gewogICAgICAgIHRyeSB7IHJlYWRlci5yZXNldCgpOyB9IGNhdGNoIChlKSB7fQogICAgICAgICQoJyNyZWFkZXInKS5p' +
  'bm5lckhUTUwgPSAnJzsKICAgICAgICBjb25zdCBzID0gJCgnI3N0YXJ0U2NhbicpLCBzdCA9ICQoJyNzdG9wU2NhbkJ0bicpOwog' +
  'ICAgICAgIGlmIChzKSBzLnN0eWxlLmRpc3BsYXkgPSAnJzsKICAgICAgICBpZiAoc3QpIHN0LnN0eWxlLmRpc3BsYXkgPSAnbm9u' +
  'ZSc7CiAgICAgIH07CiAgICAgICQoJyNzdG9wU2NhbkJ0bicpLm9uY2xpY2sgPSAoKSA9PiB7IHdpbmRvdy5fX3N0b3BTY2FuKCk7' +
  'IHdpbmRvdy5fX3N0b3BTY2FuID0gbnVsbDsgbXNnLnRleHRDb250ZW50ID0gJyc7IH07CiAgICB9IGNhdGNoIChlKSB7CiAgICAg' +
  'IG1zZy50ZXh0Q29udGVudCA9ICdDYW1lcmEgdW5hdmFpbGFibGUgKCcgKyBlLm1lc3NhZ2UgKyAnKS4gVXNlIHRoZSBqb2IgbnVt' +
  'YmVyIGJveCBiZWxvdy4nOwogICAgICAkKCcjc3RhcnRTY2FuJykuc3R5bGUuZGlzcGxheSA9ICcnOwogICAgICAkKCcjc3RvcFNj' +
  'YW5CdG4nKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogICAgfQogIH07Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIG1vbmV5IC0tICovCmFzeW5jIGZ1bmN0aW9uIG1vbmV5Vmlldygp' +
  'IHsKICBpZiAoIWlzQWRtaW4oKSkgcmV0dXJuIG15UGF5VmlldygpOwogIGNvbnN0IFtzdGF0ZW1lbnRzLCBpbnZvaWNlcywgdXNl' +
  'cnMsIGNsaWVudHNdID0gYXdhaXQgUHJvbWlzZS5hbGwoCiAgICBbYXBpKCcvc3RhdGVtZW50cycpLCBhcGkoJy9pbnZvaWNlcycp' +
  'LCBhcGkoJy91c2VycycpLCBhcGkoJy9jbGllbnRzJyldKTsKCiAgYXBwLmlubmVySFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFz' +
  'cz0icGFnZSI+QmlsbGluZyAmYW1wOyBwYXk8L2gxPgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+Q29udHJhY3Rv' +
  'ciBzdGF0ZW1lbnRzIDxzcGFuIGNsYXNzPSJzdWIiPndoYXQgeW91IG93ZSB5b3VyIHNlcnZlcnM8L3NwYW4+PC9oMj4KICAgICAg' +
  'PHAgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOi00cHgiPlB1bGxzIGV2ZXJ5IGNvbXBsZXRlZCBzZXJ2ZSBpbiB0aGUg' +
  'cGVyaW9kIHRoYXQgaGFzbid0IGJlZW4gcGFpZCBvdXQgeWV0LCBhdCB0aGUKICAgICAgcGVyLWpvYiByYXRlIG9uIHRoZSBqb2Iu' +
  'IE5vdGhpbmcgZ2V0cyBjb3VudGVkIHR3aWNlLjwvcD4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiIgc3R5bGU9Im1hcmdpbi10' +
  'b3A6MTBweCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5TZXJ2ZXI8L2xhYmVsPjxzZWxlY3QgaWQ9InNfc2Vy' +
  'dmVyIj4KICAgICAgICAgICR7dXNlcnMuZmlsdGVyKHUgPT4gdS5hY3RpdmUpLm1hcCh1ID0+IGA8b3B0aW9uIHZhbHVlPSIke3Uu' +
  'aWR9Ij4ke2VzYyh1Lm5hbWUpfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9' +
  'InJvdyIgc3R5bGU9ImFsaWduLWl0ZW1zOmZsZXgtZW5kO2dhcDo2cHgiPgogICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0' +
  'eWxlPSJmbGV4OjE7bWFyZ2luOjAiPjxsYWJlbD5Gcm9tPC9sYWJlbD48aW5wdXQgdHlwZT0iZGF0ZSIgaWQ9InNfc3RhcnQiIHZh' +
  'bHVlPSIke2ZpcnN0T2ZNb250aCgpfSI+PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCIgc3R5bGU9ImZsZXg6MTtt' +
  'YXJnaW46MCI+PGxhYmVsPlRvPC9sYWJlbD48aW5wdXQgdHlwZT0iZGF0ZSIgaWQ9InNfZW5kIiB2YWx1ZT0iJHt0b2RheUlTTygp' +
  'fSI+PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4t' +
  'dG9wOjhweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9InNfcHJldiI+UHJldmlldzwvYnV0dG9uPgog' +
  'ICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9InNfbWFrZSI+Q3JlYXRlIHN0YXRlbWVudDwvYnV0dG9uPgogICAgICA8' +
  'L2Rpdj4KICAgICAgPGRpdiBpZD0ic19vdXQiPjwvZGl2PgogICAgICAke3N0YXRlbWVudHMubGVuZ3RoID8gYDx0YWJsZSBjbGFz' +
  'cz0idGJsIiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij4KICAgICAgICA8dHI+PHRoPlNlcnZlcjwvdGg+PHRoPlBlcmlvZDwvdGg+' +
  'PHRoIGNsYXNzPSJudW0iPkpvYnM8L3RoPjx0aCBjbGFzcz0ibnVtIj5Ub3RhbDwvdGg+PHRoPjwvdGg+PHRoPjwvdGg+PC90cj4K' +
  'ICAgICAgICAke3N0YXRlbWVudHMubWFwKHMgPT4gYDx0cj4KICAgICAgICAgIDx0ZD4ke2VzYyhzLnNlcnZlcl9uYW1lKX08L3Rk' +
  'Pjx0ZD4ke2ZtdERhdGVPbmx5KHMucGVyaW9kX3N0YXJ0KX3igJMke2ZtdERhdGVPbmx5KHMucGVyaW9kX2VuZCl9PC90ZD4KICAg' +
  'ICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke3Muam9iX2NvdW50fTwvdGQ+PHRkIGNsYXNzPSJudW0iPiR7bW9uZXkocy50b3RhbCl9' +
  'PC90ZD4KICAgICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icGlsbCAke2NscyhzLnN0YXR1cyl9Ij4ke2VzYyhzLnN0YXR1cyl9PC9z' +
  'cGFuPjwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iL3ByaW50L3N0YXRlbWVudC8ke3MuaWR9IiB0YXJn' +
  'ZXQ9Il9ibGFuayI+cHJpbnQ8L2E+CiAgICAgICAgICAgICR7cy5zdGF0dXMgIT09ICdQYWlkJyA/IGAgwrcgPGEgaHJlZj0iIyIg' +
  'ZGF0YS1wYWlkPSIke3MuaWR9Ij5tYXJrIHBhaWQ8L2E+YCA6ICcnfTwvdGQ+CiAgICAgICAgPC90cj5gKS5qb2luKCcnKX08L3Rh' +
  'YmxlPmAgOiAnJ30KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+Q2xpZW50IGludm9pY2VzPC9o' +
  'Mj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5DbGllbnQ8L2xh' +
  'YmVsPjxzZWxlY3QgaWQ9ImlfY2xpZW50Ij4KICAgICAgICAgICR7Y2xpZW50cy5maWx0ZXIoYyA9PiBjLmFjdGl2ZSkubWFwKGMg' +
  'PT4gYDxvcHRpb24gdmFsdWU9IiR7Yy5pZH0iPiR7ZXNjKGMubmFtZSl9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9k' +
  'aXY+CiAgICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0iYWxpZ24taXRlbXM6ZmxleC1lbmQ7Z2FwOjZweCI+CiAgICAgICAg' +
  'ICA8ZGl2IGNsYXNzPSJmaWVsZCIgc3R5bGU9ImZsZXg6MTttYXJnaW46MCI+PGxhYmVsPkZyb208L2xhYmVsPjxpbnB1dCB0eXBl' +
  'PSJkYXRlIiBpZD0iaV9zdGFydCIgdmFsdWU9IiR7Zmlyc3RPZk1vbnRoKCl9Ij48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9' +
  'ImZpZWxkIiBzdHlsZT0iZmxleDoxO21hcmdpbjowIj48bGFiZWw+VG88L2xhYmVsPjxpbnB1dCB0eXBlPSJkYXRlIiBpZD0iaV9l' +
  'bmQiIHZhbHVlPSIke3RvZGF5SVNPKCl9Ij48L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xh' +
  'c3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0iaV9w' +
  'cmV2Ij5QcmV2aWV3PC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0iaV9tYWtlIj5DcmVhdGUgaW52' +
  'b2ljZTwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBpZD0iaV9vdXQiPjwvZGl2PgogICAgICAke2ludm9pY2VzLmxl' +
  'bmd0aCA/IGA8dGFibGUgY2xhc3M9InRibCIgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+CiAgICAgICAgPHRyPjx0aD5DbGllbnQ8' +
  'L3RoPjx0aD5QZXJpb2Q8L3RoPjx0aCBjbGFzcz0ibnVtIj5Kb2JzPC90aD48dGggY2xhc3M9Im51bSI+VG90YWw8L3RoPjx0aD48' +
  'L3RoPjx0aD48L3RoPjwvdHI+CiAgICAgICAgJHtpbnZvaWNlcy5tYXAocyA9PiBgPHRyPgogICAgICAgICAgPHRkPiR7ZXNjKHMu' +
  'Y2xpZW50X25hbWUpfTwvdGQ+PHRkPiR7Zm10RGF0ZU9ubHkocy5wZXJpb2Rfc3RhcnQpfeKAkyR7Zm10RGF0ZU9ubHkocy5wZXJp' +
  'b2RfZW5kKX08L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPiR7cy5qb2JfY291bnR9PC90ZD48dGQgY2xhc3M9Im51bSI+' +
  'JHttb25leShzLnRvdGFsKX08L3RkPgogICAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJwaWxsICR7Y2xzKHMuc3RhdHVzKX0iPiR7' +
  'ZXNjKHMuc3RhdHVzKX08L3NwYW4+PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIvcHJpbnQvaW52b2lj' +
  'ZS8ke3MuaWR9IiB0YXJnZXQ9Il9ibGFuayI+cHJpbnQ8L2E+CiAgICAgICAgICAgICR7cy5zdGF0dXMgIT09ICdQYWlkJyA/IGAg' +
  'wrcgPGEgaHJlZj0iIyIgZGF0YS1pcGFpZD0iJHtzLmlkfSI+bWFyayBwYWlkPC9hPmAgOiAnJ308L3RkPgogICAgICAgIDwvdHI+' +
  'YCkuam9pbignJyl9PC90YWJsZT5gIDogJyd9CiAgICA8L2Rpdj5gKTsKICBiaW5kU2hlbGwoKTsKCiAgY29uc3QgbGluZXNUYWJs' +
  'ZSA9IChyLCBrZXkpID0+IHIubGluZXMubGVuZ3RoCiAgICA/IGA8dGFibGUgY2xhc3M9InRibCIgc3R5bGU9Im1hcmdpbi10b3A6' +
  'MTBweCI+PHRyPjx0aD5EYXRlPC90aD48dGg+Sm9iPC90aD48dGg+UmVjaXBpZW50PC90aD48dGggY2xhc3M9Im51bSI+JHtrZXkg' +
  'PT09ICdwYXknID8gJ1BheScgOiAnRmVlJ308L3RoPjwvdHI+CiAgICAgICAke3IubGluZXMubWFwKGwgPT4gYDx0cj48dGQ+JHtm' +
  'bXREYXRlT25seShsLnNlcnZlZF9hdCl9PC90ZD48dGQ+JHtlc2MobC5qb2JfbnVtYmVyKX08L3RkPgogICAgICAgPHRkPiR7ZXNj' +
  'KGwucmVjaXBpZW50X25hbWUpfTwvdGQ+PHRkIGNsYXNzPSJudW0iPiR7bW9uZXkoa2V5ID09PSAncGF5JyA/IGwuc2VydmVyX3Bh' +
  'eSA6IGwuY2xpZW50X2ZlZSl9PC90ZD48L3RyPmApLmpvaW4oJycpfQogICAgICAgPHRyPjx0ZCBjb2xzcGFuPSIzIj48Yj4ke3Iu' +
  'Y291bnR9IGpvYihzKTwvYj48L3RkPjx0ZCBjbGFzcz0ibnVtIj48Yj4ke21vbmV5KHIudG90YWwpfTwvYj48L3RkPjwvdHI+PC90' +
  'YWJsZT5gCiAgICA6ICc8ZGl2IGNsYXNzPSJoaW50Ij5Ob3RoaW5nIHVuYmlsbGVkIGluIHRoYXQgd2luZG93LjwvZGl2Pic7Cgog' +
  'ICQoJyNzX3ByZXYnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgY29uc3QgciA9IGF3YWl0IGFwaSgnL3N0YXRlbWVudHMv' +
  'cHJldmlldycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KAogICAgICB7IHNlcnZlcl9pZDogJCgnI3Nf' +
  'c2VydmVyJykudmFsdWUsIHN0YXJ0OiAkKCcjc19zdGFydCcpLnZhbHVlLCBlbmQ6ICQoJyNzX2VuZCcpLnZhbHVlIH0pIH0pOwog' +
  'ICAgJCgnI3Nfb3V0JykuaW5uZXJIVE1MID0gbGluZXNUYWJsZShyLCAncGF5Jyk7CiAgfTsKICAkKCcjc19tYWtlJykub25jbGlj' +
  'ayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGF3YWl0IGFwaSgnL3N0YXRlbWVudHMnLCB7IG1ldGhvZDogJ1BPU1Qn' +
  'LCBib2R5OiBKU09OLnN0cmluZ2lmeSgKICAgICAgICB7IHNlcnZlcl9pZDogJCgnI3Nfc2VydmVyJykudmFsdWUsIHN0YXJ0OiAk' +
  'KCcjc19zdGFydCcpLnZhbHVlLCBlbmQ6ICQoJyNzX2VuZCcpLnZhbHVlIH0pIH0pOwogICAgICB0b2FzdCgnU3RhdGVtZW50IGNy' +
  'ZWF0ZWQnKTsgZ28oJ21vbmV5Jyk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9OwogICQo' +
  'JyNpX3ByZXYnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgY29uc3QgciA9IGF3YWl0IGFwaSgnL2ludm9pY2VzL3ByZXZp' +
  'ZXcnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSgKICAgICAgeyBjbGllbnRfaWQ6ICQoJyNpX2NsaWVu' +
  'dCcpLnZhbHVlLCBzdGFydDogJCgnI2lfc3RhcnQnKS52YWx1ZSwgZW5kOiAkKCcjaV9lbmQnKS52YWx1ZSB9KSB9KTsKICAgICQo' +
  'JyNpX291dCcpLmlubmVySFRNTCA9IGxpbmVzVGFibGUociwgJ2ZlZScpOwogIH07CiAgJCgnI2lfbWFrZScpLm9uY2xpY2sgPSBh' +
  'c3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBhd2FpdCBhcGkoJy9pbnZvaWNlcycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6' +
  'IEpTT04uc3RyaW5naWZ5KAogICAgICAgIHsgY2xpZW50X2lkOiAkKCcjaV9jbGllbnQnKS52YWx1ZSwgc3RhcnQ6ICQoJyNpX3N0' +
  'YXJ0JykudmFsdWUsIGVuZDogJCgnI2lfZW5kJykudmFsdWUgfSkgfSk7CiAgICAgIHRvYXN0KCdJbnZvaWNlIGNyZWF0ZWQnKTsg' +
  'Z28oJ21vbmV5Jyk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9OwogIGRvY3VtZW50LnF1' +
  'ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBhaWRdJykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGFzeW5jIGUgPT4gewogICAgZS5w' +
  'cmV2ZW50RGVmYXVsdCgpOwogICAgYXdhaXQgYXBpKCcvc3RhdGVtZW50cy8nICsgYS5kYXRhc2V0LnBhaWQsIHsgbWV0aG9kOiAn' +
  'UEFUQ0gnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHN0YXR1czogJ1BhaWQnIH0pIH0pOwogICAgdG9hc3QoJ01hcmtlZCBwYWlk' +
  'Jyk7IGdvKCdtb25leScpOwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWlwYWlkXScpLmZvckVhY2go' +
  'YSA9PiBhLm9uY2xpY2sgPSBhc3luYyBlID0+IHsKICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgIGF3YWl0IGFwaSgnL2ludm9p' +
  'Y2VzLycgKyBhLmRhdGFzZXQuaXBhaWQsIHsgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHN0YXR1czog' +
  'J1BhaWQnIH0pIH0pOwogICAgdG9hc3QoJ01hcmtlZCBwYWlkJyk7IGdvKCdtb25leScpOwogIH0pOwp9CgpmdW5jdGlvbiBmaXJz' +
  'dE9mTW9udGgoKSB7CiAgY29uc3QgZCA9IG5ldyBEYXRlKCk7IHJldHVybiBuZXcgRGF0ZShkLmdldEZ1bGxZZWFyKCksIGQuZ2V0' +
  'TW9udGgoKSwgMSkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCk7Cn0KCmFzeW5jIGZ1bmN0aW9uIG15UGF5VmlldygpIHsKICBj' +
  'b25zdCBbc3RhdGVtZW50cywgc3RhdHNdID0gYXdhaXQgUHJvbWlzZS5hbGwoW2FwaSgnL3N0YXRlbWVudHMnKSwgYXBpKCcvc3Rh' +
  'dHMnKV0pOwogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8aDEgY2xhc3M9InBhZ2UiPk15IHBheTwvaDE+CiAgICA8ZGl2' +
  'IGNsYXNzPSJzdGF0cyI+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQgZ29vZCI+PGRpdiBjbGFzcz0ibiI+JHttb25leShzdGF0cy51' +
  'bmJpbGxlZCl9PC9kaXY+PGRpdiBjbGFzcz0ibCI+RWFybmVkLCBub3QgeWV0IG9uIGEgc3RhdGVtZW50PC9kaXY+PC9kaXY+CiAg' +
  'ICAgIDxkaXYgY2xhc3M9InN0YXQiPjxkaXYgY2xhc3M9Im4iPiR7c3RhdHMuc2VydmVkXzdkfTwvZGl2PjxkaXYgY2xhc3M9Imwi' +
  'PlNlcnZlcyBjb21wbGV0ZWQsIDcgZGF5czwvZGl2PjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj48aDI+' +
  'U3RhdGVtZW50czwvaDI+CiAgICAke3N0YXRlbWVudHMubGVuZ3RoID8gYDx0YWJsZSBjbGFzcz0idGJsIj4KICAgICAgPHRyPjx0' +
  'aD5QZXJpb2Q8L3RoPjx0aCBjbGFzcz0ibnVtIj5Kb2JzPC90aD48dGggY2xhc3M9Im51bSI+VG90YWw8L3RoPjx0aD48L3RoPjx0' +
  'aD48L3RoPjwvdHI+CiAgICAgICR7c3RhdGVtZW50cy5tYXAocyA9PiBgPHRyPjx0ZD4ke2ZtdERhdGVPbmx5KHMucGVyaW9kX3N0' +
  'YXJ0KX3igJMke2ZtdERhdGVPbmx5KHMucGVyaW9kX2VuZCl9PC90ZD4KICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHtzLmpvYl9j' +
  'b3VudH08L3RkPjx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KHMudG90YWwpfTwvdGQ+CiAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJw' +
  'aWxsICR7Y2xzKHMuc3RhdHVzKX0iPiR7ZXNjKHMuc3RhdHVzKX08L3NwYW4+PC90ZD4KICAgICAgICA8dGQgY2xhc3M9Im51bSI+' +
  'PGEgaHJlZj0iL3ByaW50L3N0YXRlbWVudC8ke3MuaWR9IiB0YXJnZXQ9Il9ibGFuayI+cHJpbnQ8L2E+PC90ZD48L3RyPmApLmpv' +
  'aW4oJycpfQogICAgICA8L3RhYmxlPmAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPk5vIHN0YXRlbWVudHMgeWV0LjwvZGl2Pid9CiAg' +
  'ICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImNhcmQiPjxoMj5DaGFuZ2UgcGFzc3dvcmQ8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJm' +
  'aWVsZCI+PGlucHV0IGlkPSJucHciIHR5cGU9InBhc3N3b3JkIiBwbGFjZWhvbGRlcj0iTmV3IHBhc3N3b3JkICg4KyBjaGFyYWN0' +
  'ZXJzKSI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9InNhdmVQdyI+VXBkYXRlPC9idXR0b24+PC9kaXY+' +
  'YCk7CiAgYmluZFNoZWxsKCk7CiAgJCgnI3NhdmVQdycpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgeyBhd2FpdCBh' +
  'cGkoJy9tZS9wYXNzd29yZCcsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcGFzc3dvcmQ6ICQoJyNu' +
  'cHcnKS52YWx1ZSB9KSB9KTsgdG9hc3QoJ1Bhc3N3b3JkIHVwZGF0ZWQnKTsgfQogICAgY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNz' +
  'YWdlLCB0cnVlKTsgfQogIH07Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tIGFkbWluIC0tICovCmFzeW5jIGZ1bmN0aW9uIGFkbWluVmlldygpIHsKICBjb25zdCBbdXNlcnMsIGNsaWVu' +
  'dHMsIHRlbXBsYXRlc10gPSBhd2FpdCBQcm9taXNlLmFsbChbYXBpKCcvdXNlcnMnKSwgYXBpKCcvY2xpZW50cycpLCBhcGkoJy90' +
  'ZW1wbGF0ZXMnKV0pOwogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8aDEgY2xhc3M9InBhZ2UiPlNldHVwPC9oMT4KCiAg' +
  'ICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPlRlYW0gPHNwYW4gY2xhc3M9InN1YiI+JHt1c2Vycy5sZW5ndGh9PC9zcGFu' +
  'PjwvaDI+CiAgICAgIDx0YWJsZSBjbGFzcz0idGJsIj4KICAgICAgICA8dHI+PHRoPk5hbWU8L3RoPjx0aD5Sb2xlPC90aD48dGgg' +
  'Y2xhc3M9Im51bSI+UmF0ZTwvdGg+PHRoPjwvdGg+PC90cj4KICAgICAgICAke3VzZXJzLm1hcCh1ID0+IGA8dHI+PHRkPiR7ZXNj' +
  'KHUubmFtZSl9PGRpdiBjbGFzcz0iaGludCI+JHtlc2ModS5lbWFpbCl9PC9kaXY+PC90ZD4KICAgICAgICAgIDx0ZD4ke2VzYyh1' +
  'LnJvbGUpfSR7dS5hY3RpdmUgPyAnJyA6ICcgPHNwYW4gY2xhc3M9InBpbGwiPm9mZjwvc3Bhbj4nfTwvdGQ+CiAgICAgICAgICA8' +
  'dGQgY2xhc3M9Im51bSI+JHttb25leSh1LmRlZmF1bHRfcGF5KX08L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPjxhIGhy' +
  'ZWY9IiMiIGRhdGEtdXNlcj0iJHt1LmlkfSI+ZWRpdDwvYT48L3RkPjwvdHI+YCkuam9pbignJyl9CiAgICAgIDwvdGFibGU+CiAg' +
  'ICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgYmxvY2sgc20iIGlkPSJuZXdVc2VyIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4r' +
  'IEFkZCBwZXJzb248L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+Q2xpZW50cyA8' +
  'c3BhbiBjbGFzcz0ic3ViIj4ke2NsaWVudHMubGVuZ3RofTwvc3Bhbj48L2gyPgogICAgICA8dGFibGUgY2xhc3M9InRibCI+CiAg' +
  'ICAgICAgPHRyPjx0aD5OYW1lPC90aD48dGggY2xhc3M9Im51bSI+RGVmYXVsdCBmZWU8L3RoPjx0aD48L3RoPjwvdHI+CiAgICAg' +
  'ICAgJHtjbGllbnRzLm1hcChjID0+IGA8dHI+PHRkPiR7ZXNjKGMubmFtZSl9PGRpdiBjbGFzcz0iaGludCI+JHtlc2MoYy5jb250' +
  'YWN0X25hbWUgfHwgJycpfSAke2VzYyhjLnBob25lIHx8ICcnKX08L2Rpdj48L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0i' +
  'PiR7bW9uZXkoYy5kZWZhdWx0X2ZlZSl9PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIjIiBkYXRhLWNs' +
  'aWVudD0iJHtjLmlkfSI+ZWRpdDwvYT48L3RkPjwvdHI+YCkuam9pbignJyl9CiAgICAgIDwvdGFibGU+CiAgICAgIDxidXR0b24g' +
  'Y2xhc3M9ImJ0biBzZWMgYmxvY2sgc20iIGlkPSJuZXdDbGllbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPisgQWRkIGNsaWVu' +
  'dDwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5BZmZpZGF2aXQgdGVtcGxhdGVz' +
  'IDxzcGFuIGNsYXNzPSJzdWIiPiR7dGVtcGxhdGVzLmxlbmd0aH08L3NwYW4+PC9oMj4KICAgICAgPHAgY2xhc3M9ImhpbnQiIHN0' +
  'eWxlPSJtYXJnaW4tdG9wOi00cHgiPldyaXRlIHlvdXIgb3duIHdvcmRpbmcgcGVyIGNvdW50eSBvciBjbGllbnQuIE1lcmdlIGZp' +
  'ZWxkcyBmaWxsIGluIGZyb20gdGhlIGpvYiwKICAgICAgaW5jbHVkaW5nIHRoZSBmdWxsIGF0dGVtcHQgbG9nIHdpdGggR1BTLjwv' +
  'cD4KICAgICAgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgICAgICR7dGVtcGxhdGVzLm1hcCh0ID0+IGA8dHI+PHRkPiR7ZXNjKHQu' +
  'bmFtZSl9PGRpdiBjbGFzcz0iaGludCI+JHtlc2ModC5qdXJpc2RpY3Rpb24gfHwgJycpfTwvZGl2PjwvdGQ+CiAgICAgICAgICA8' +
  'dGQ+JHt0LmlzX2RlZmF1bHQgPyAnPHNwYW4gY2xhc3M9InBpbGwgU2VydmVkIj5kZWZhdWx0PC9zcGFuPicgOiAnJ308L3RkPgog' +
  'ICAgICAgICAgPHRkIGNsYXNzPSJudW0iPjxhIGhyZWY9IiMiIGRhdGEtdHBsPSIke3QuaWR9Ij5lZGl0PC9hPjwvdGQ+PC90cj5g' +
  'KS5qb2luKCcnKX0KICAgICAgPC90YWJsZT4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBibG9jayBzbSIgaWQ9Im5ld1Rw' +
  'bCIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+KyBOZXcgdGVtcGxhdGU8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xh' +
  'c3M9ImNhcmQiPgogICAgICA8aDI+Q291cnQgcG9ydGFsIHByb2JlIDxzcGFuIGNsYXNzPSJzdWIiPmV4cGVyaW1lbnRhbDwvc3Bh' +
  'bj48L2gyPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6LTRweCI+QXNrcyB0aGUgc2VydmVyIHRvIGZl' +
  'dGNoIGEgY291bnR5IHBvcnRhbCBhbmQgcmVwb3J0IHdoYXQgY2FtZSBiYWNrIOKAlAogICAgICAgIHN0YXR1cywgY29va2llcywg' +
  'Zm9ybXMsIGxpbmtzLiBUaGlzIGlzIHRoZSBncm91bmR3b3JrIGZvciBhdXRvbWF0aWMgY2FzZSBsb29rdXA6IHRoZXNlIHBvcnRh' +
  'bHMgY2FuJ3QgYmUKICAgICAgICByZWFjaGVkIGZyb20gd2hlcmUgdGhpcyBhcHAgd2FzIHdyaXR0ZW4sIHNvIHRoZSBzZXJ2ZXIg' +
  'aGFzIHRvIGdvIGFuZCBsb29rLiBSdW4gb25lIGFuZCBzZW5kIG1lIHRoZSByZXN1bHQuPC9wPgogICAgICA8ZGl2IGNsYXNzPSJy' +
  'b3ciIGlkPSJwcm9iZUJ0bnMiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0' +
  'eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxpbnB1dCBpZD0icHJvYmVVcmwiIHBsYWNlaG9sZGVyPSLigKZvciBhIHNw' +
  'ZWNpZmljIHBhZ2UgVVJMIiBzdHlsZT0iZmxleDoxO21pbi13aWR0aDoxNTBweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRu' +
  'IHNlYyBzbSIgaWQ9InByb2JlR28iPlByb2JlIFVSTDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPHByZSBjbGFzcz0icHJl' +
  'diIgaWQ9InByb2JlT3V0IiBzdHlsZT0iZGlzcGxheTpub25lO21hcmdpbi10b3A6MTBweCI+PC9wcmU+CiAgICAgIDxidXR0b24g' +
  'Y2xhc3M9ImJ0biBzZWMgc20gYmxvY2siIGlkPSJjb3B5UHJvYmUiIHN0eWxlPSJkaXNwbGF5Om5vbmU7bWFyZ2luLXRvcDo4cHgi' +
  'PkNvcHkgcmVzdWx0PC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPk15IGFjY291' +
  'bnQ8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk5ldyBwYXNzd29yZDwvbGFiZWw+PGlucHV0IGlkPSJucHci' +
  'IHR5cGU9InBhc3N3b3JkIiBwbGFjZWhvbGRlcj0iOCsgY2hhcmFjdGVycyI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0' +
  'biBzbSIgaWQ9InNhdmVQdyI+VXBkYXRlIHBhc3N3b3JkPC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIGlkPSJidWls' +
  'ZFN0YW1wIiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij5idWlsZCDigKY8L2Rpdj4KICAgIDwvZGl2PmApOwogIGJpbmRTaGVsbCgp' +
  'OwoKICBmZXRjaCgnL2FwaS9idWlsZCcpLnRoZW4ociA9PiByLmpzb24oKSkudGhlbihiID0+IHsKICAgIGNvbnN0IGVsID0gJCgn' +
  'I2J1aWxkU3RhbXAnKTsKICAgIGlmIChlbCkgZWwudGV4dENvbnRlbnQgPSAnU2VydmVUcmFjayBidWlsZCAnICsgYi5idWlsZCAr' +
  'IChiLnByb2JlVGFyZ2V0cyA/ICcgwrcgYm9vdCBwcm9iZSBhcm1lZCcgOiAnJyk7CiAgfSkuY2F0Y2goKCkgPT4ge30pOwoKICAv' +
  'KiAtLS0tIHBvcnRhbCBwcm9iZSAtLS0tICovCiAgY29uc3QgcHJvYmVPdXQgPSAkKCcjcHJvYmVPdXQnKTsKICBjb25zdCBydW5Q' +
  'cm9iZSA9IGFzeW5jIGJvZHkgPT4gewogICAgcHJvYmVPdXQuc3R5bGUuZGlzcGxheSA9ICcnOwogICAgcHJvYmVPdXQudGV4dENv' +
  'bnRlbnQgPSAnUHJvYmluZ+KApiAodGhpcyBjYW4gdGFrZSB1cCB0byAyMCBzZWNvbmRzKSc7CiAgICAkKCcjY29weVByb2JlJyku' +
  'c3R5bGUuZGlzcGxheSA9ICcnOwogICAgdHJ5IHsKICAgICAgY29uc3QgciA9IGF3YWl0IGFwaSgnL3BvcnRhbC1wcm9iZScsIHsg' +
  'bWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pOwogICAgICBwcm9iZU91dC50ZXh0Q29udGVudCA9' +
  'IEpTT04uc3RyaW5naWZ5KHIsIG51bGwsIDIpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBwcm9iZU91dC50ZXh0Q29udGVudCA9' +
  'ICdQcm9iZSBmYWlsZWQ6ICcgKyBlLm1lc3NhZ2U7CiAgICB9CiAgfTsKICBhcGkoJy9wb3J0YWxzJykudGhlbihsaXN0ID0+IHsK' +
  'ICAgICQoJyNwcm9iZUJ0bnMnKS5pbm5lckhUTUwgPSBsaXN0Lm1hcChwID0+CiAgICAgIGA8YnV0dG9uIGNsYXNzPSJidG4gc2Vj' +
  'IHNtIiBkYXRhLXByb2JlPSIke2VzYyhwLmtleSl9Ij4ke2VzYyhwLmxhYmVsKX08L2J1dHRvbj5gKS5qb2luKCcnKTsKICAgIGRv' +
  'Y3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXByb2JlXScpLmZvckVhY2goYiA9PgogICAgICBiLm9uY2xpY2sgPSAoKSA9' +
  'PiBydW5Qcm9iZSh7IHBvcnRhbDogYi5kYXRhc2V0LnByb2JlIH0pKTsKICB9KS5jYXRjaCgoKSA9PiB7fSk7CiAgJCgnI3Byb2Jl' +
  'R28nKS5vbmNsaWNrID0gKCkgPT4gewogICAgY29uc3QgdSA9ICQoJyNwcm9iZVVybCcpLnZhbHVlLnRyaW0oKTsKICAgIGlmICh1' +
  'KSBydW5Qcm9iZSh7IHVybDogdSB9KTsKICB9OwogICQoJyNjb3B5UHJvYmUnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAg' +
  'dHJ5IHsgYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQocHJvYmVPdXQudGV4dENvbnRlbnQpOyB0b2FzdCgnQ29w' +
  'aWVkJyk7IH0KICAgIGNhdGNoIChlKSB7IHRvYXN0KCdTZWxlY3QgdGhlIHRleHQgYW5kIGNvcHkgaXQgYnkgaGFuZCcsIHRydWUp' +
  'OyB9CiAgfTsKCiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdXNlcl0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNr' +
  'ID0gZSA9PiB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7IHVzZXJGb3JtKHVzZXJzLmZpbmQodSA9PiBTdHJpbmcodS5pZCkgPT09' +
  'IGEuZGF0YXNldC51c2VyKSk7CiAgfSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtY2xpZW50XScpLmZvckVh' +
  'Y2goYSA9PiBhLm9uY2xpY2sgPSBlID0+IHsKICAgIGUucHJldmVudERlZmF1bHQoKTsgY2xpZW50Rm9ybShjbGllbnRzLmZpbmQo' +
  'YyA9PiBTdHJpbmcoYy5pZCkgPT09IGEuZGF0YXNldC5jbGllbnQpKTsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxs' +
  'KCdbZGF0YS10cGxdJykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGUgPT4gewogICAgZS5wcmV2ZW50RGVmYXVsdCgpOyB0ZW1w' +
  'bGF0ZUZvcm0odGVtcGxhdGVzLmZpbmQodCA9PiBTdHJpbmcodC5pZCkgPT09IGEuZGF0YXNldC50cGwpKTsKICB9KTsKICAkKCcj' +
  'bmV3VXNlcicpLm9uY2xpY2sgPSAoKSA9PiB1c2VyRm9ybShudWxsKTsKICAkKCcjbmV3Q2xpZW50Jykub25jbGljayA9ICgpID0+' +
  'IGNsaWVudEZvcm0obnVsbCk7CiAgJCgnI25ld1RwbCcpLm9uY2xpY2sgPSAoKSA9PiB0ZW1wbGF0ZUZvcm0obnVsbCk7CiAgJCgn' +
  'I3NhdmVQdycpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgeyBhd2FpdCBhcGkoJy9tZS9wYXNzd29yZCcsIHsgbWV0' +
  'aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcGFzc3dvcmQ6ICQoJyNucHcnKS52YWx1ZSB9KSB9KTsgdG9hc3Qo' +
  'J1Bhc3N3b3JkIHVwZGF0ZWQnKTsgfQogICAgY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07Cn0KCmZ1' +
  'bmN0aW9uIHVzZXJGb3JtKHUpIHsKICBjb25zdCB2ID0gdSB8fCB7IHJvbGU6ICdzZXJ2ZXInLCBhY3RpdmU6IHRydWUgfTsKICBz' +
  'aGVldCh1ID8gJ0VkaXQgJyArIHUubmFtZSA6ICdBZGQgcGVyc29uJywgYAogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5O' +
  'YW1lPC9sYWJlbD48aW5wdXQgaWQ9InVfbmFtZSIgdmFsdWU9IiR7ZXNjKHYubmFtZSl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9' +
  'ImZpZWxkIj48bGFiZWw+RW1haWwgKHVzZWQgdG8gc2lnbiBpbik8L2xhYmVsPjxpbnB1dCBpZD0idV9lbWFpbCIgdHlwZT0iZW1h' +
  'aWwiIHZhbHVlPSIke2VzYyh2LmVtYWlsKX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD4ke3UgPyAnTmV3' +
  'IHBhc3N3b3JkIChsZWF2ZSBibGFuayB0byBrZWVwKScgOiAnUGFzc3dvcmQnfTwvbGFiZWw+PGlucHV0IGlkPSJ1X3Bhc3N3b3Jk' +
  'IiB0eXBlPSJ0ZXh0IiBwbGFjZWhvbGRlcj0iJHt1ID8gJ3VuY2hhbmdlZCcgOiAnc2V0IGEgcGFzc3dvcmQnfSI+PC9kaXY+CiAg' +
  'ICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Sb2xlPC9sYWJlbD48c2VsZWN0' +
  'IGlkPSJ1X3JvbGUiPgogICAgICAgIDxvcHRpb24gdmFsdWU9InNlcnZlciIgJHt2LnJvbGUgPT09ICdzZXJ2ZXInID8gJ3NlbGVj' +
  'dGVkJyA6ICcnfT5GaWVsZCBzZXJ2ZXI8L29wdGlvbj4KICAgICAgICA8b3B0aW9uIHZhbHVlPSJhZG1pbiIgJHt2LnJvbGUgPT09' +
  'ICdhZG1pbicgPyAnc2VsZWN0ZWQnIDogJyd9PkFkbWluPC9vcHRpb24+PC9zZWxlY3Q+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9' +
  'ImZpZWxkIj48bGFiZWw+RGVmYXVsdCBwYXkgcGVyIHNlcnZlPC9sYWJlbD48aW5wdXQgaWQ9InVfZGVmYXVsdF9wYXkiIHR5cGU9' +
  'Im51bWJlciIgc3RlcD0iMC4wMSIgdmFsdWU9IiR7di5kZWZhdWx0X3BheSB8fCAnJ30iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNz' +
  'PSJmaWVsZCI+PGxhYmVsPlBob25lPC9sYWJlbD48aW5wdXQgaWQ9InVfcGhvbmUiIHZhbHVlPSIke2VzYyh2LnBob25lKX0iPjwv' +
  'ZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkxpY2Vuc2UgLyByZWdpc3RyYXRpb24gIzwvbGFiZWw+PGlucHV0' +
  'IGlkPSJ1X2xpY2Vuc2Vfbm8iIHZhbHVlPSIke2VzYyh2LmxpY2Vuc2Vfbm8pfSI+PC9kaXY+CiAgICA8L2Rpdj4KICAgICR7dSA/' +
  'IGA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlN0YXR1czwvbGFiZWw+PHNlbGVjdCBpZD0idV9hY3RpdmUiPgogICAgICA8b3B0' +
  'aW9uIHZhbHVlPSJ0cnVlIiAke3YuYWN0aXZlID8gJ3NlbGVjdGVkJyA6ICcnfT5BY3RpdmU8L29wdGlvbj4KICAgICAgPG9wdGlv' +
  'biB2YWx1ZT0iZmFsc2UiICR7IXYuYWN0aXZlID8gJ3NlbGVjdGVkJyA6ICcnfT5EZWFjdGl2YXRlZDwvb3B0aW9uPjwvc2VsZWN0' +
  'PjwvZGl2PmAgOiAnJ30KICAgIDxkaXYgY2xhc3M9InJvdyI+PGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0ic2F2ZSI+U2F2ZTwvYnV0' +
  'dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5DYW5jZWw8L2J1dHRvbj48L2Rp' +
  'dj5gLCBlbCA9PiB7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNv' +
  'bnN0IGJvZHkgPSB7CiAgICAgICAgbmFtZTogZWwucXVlcnlTZWxlY3RvcignI3VfbmFtZScpLnZhbHVlLCBlbWFpbDogZWwucXVl' +
  'cnlTZWxlY3RvcignI3VfZW1haWwnKS52YWx1ZSwKICAgICAgICByb2xlOiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9yb2xlJykudmFs' +
  'dWUsIHBob25lOiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9waG9uZScpLnZhbHVlLAogICAgICAgIGxpY2Vuc2Vfbm86IGVsLnF1ZXJ5' +
  'U2VsZWN0b3IoJyN1X2xpY2Vuc2Vfbm8nKS52YWx1ZSwKICAgICAgICBkZWZhdWx0X3BheTogZWwucXVlcnlTZWxlY3RvcignI3Vf' +
  'ZGVmYXVsdF9wYXknKS52YWx1ZSB8fCAwCiAgICAgIH07CiAgICAgIGNvbnN0IHB3ID0gZWwucXVlcnlTZWxlY3RvcignI3VfcGFz' +
  'c3dvcmQnKS52YWx1ZTsKICAgICAgaWYgKHB3KSBib2R5LnBhc3N3b3JkID0gcHc7CiAgICAgIGlmICh1KSBib2R5LmFjdGl2ZSA9' +
  'IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X2FjdGl2ZScpLnZhbHVlID09PSAndHJ1ZSc7CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQg' +
  'KHUgPyBhcGkoJy91c2Vycy8nICsgdS5pZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0p' +
  'CiAgICAgICAgICAgICAgICAgOiBhcGkoJy91c2VycycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJv' +
  'ZHkpIH0pKTsKICAgICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KCdTYXZlZCcpOyBnbygnYWRtaW4nKTsKICAgICAgfSBjYXRjaCAo' +
  'ZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgICB9OwogIH0pOwp9CgpmdW5jdGlvbiBjbGllbnRGb3JtKGMpIHsKICBj' +
  'b25zdCB2ID0gYyB8fCB7fTsKICBzaGVldChjID8gJ0VkaXQgJyArIGMubmFtZSA6ICdBZGQgY2xpZW50JywgYAogICAgPGRpdiBj' +
  'bGFzcz0iZmllbGQiPjxsYWJlbD5GaXJtIC8gY2xpZW50IG5hbWU8L2xhYmVsPjxpbnB1dCBpZD0iY19uYW1lIiB2YWx1ZT0iJHtl' +
  'c2Modi5uYW1lKX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFi' +
  'ZWw+Q29udGFjdDwvbGFiZWw+PGlucHV0IGlkPSJjX2NvbnRhY3RfbmFtZSIgdmFsdWU9IiR7ZXNjKHYuY29udGFjdF9uYW1lKX0i' +
  'PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBob25lPC9sYWJlbD48aW5wdXQgaWQ9ImNfcGhvbmUiIHZh' +
  'bHVlPSIke2VzYyh2LnBob25lKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkVtYWlsPC9sYWJlbD48' +
  'aW5wdXQgaWQ9ImNfZW1haWwiIHR5cGU9ImVtYWlsIiB2YWx1ZT0iJHtlc2Modi5lbWFpbCl9Ij48L2Rpdj4KICAgICAgPGRpdiBj' +
  'bGFzcz0iZmllbGQiPjxsYWJlbD5EZWZhdWx0IGZlZSBwZXIgc2VydmU8L2xhYmVsPjxpbnB1dCBpZD0iY19kZWZhdWx0X2ZlZSIg' +
  'dHlwZT0ibnVtYmVyIiBzdGVwPSIwLjAxIiB2YWx1ZT0iJHt2LmRlZmF1bHRfZmVlIHx8ICcnfSI+PC9kaXY+CiAgICA8L2Rpdj4K' +
  'ICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+QmlsbGluZyBhZGRyZXNzPC9sYWJlbD48dGV4dGFyZWEgaWQ9ImNfYWRkcmVz' +
  'cyIgc3R5bGU9Im1pbi1oZWlnaHQ6NjBweCI+JHtlc2Modi5hZGRyZXNzKX08L3RleHRhcmVhPjwvZGl2PgogICAgPGRpdiBjbGFz' +
  'cz0iZmllbGQiPjxsYWJlbD5Ob3RlczwvbGFiZWw+PHRleHRhcmVhIGlkPSJjX25vdGVzIiBzdHlsZT0ibWluLWhlaWdodDo2MHB4' +
  'Ij4ke2VzYyh2Lm5vdGVzKX08L3RleHRhcmVhPjwvZGl2PgogICAgPGRpdiBjbGFzcz0icm93Ij48YnV0dG9uIGNsYXNzPSJidG4i' +
  'IGlkPSJzYXZlIj5TYXZlPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCki' +
  'PkNhbmNlbDwvYnV0dG9uPjwvZGl2PmAsIGVsID0+IHsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNzYXZlJykub25jbGljayA9IGFz' +
  'eW5jICgpID0+IHsKICAgICAgY29uc3QgYm9keSA9IHt9OwogICAgICBbJ25hbWUnLCdjb250YWN0X25hbWUnLCdwaG9uZScsJ2Vt' +
  'YWlsJywnZGVmYXVsdF9mZWUnLCdhZGRyZXNzJywnbm90ZXMnXQogICAgICAgIC5mb3JFYWNoKGYgPT4gYm9keVtmXSA9IGVsLnF1' +
  'ZXJ5U2VsZWN0b3IoJyNjXycgKyBmKS52YWx1ZSk7CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgKGMgPyBhcGkoJy9jbGllbnRz' +
  'LycgKyBjLmlkLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSkKICAgICAgICAgICAgICAg' +
  'ICA6IGFwaSgnL2NsaWVudHMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KSk7CiAgICAg' +
  'ICAgY2xvc2VTaGVldCgpOyB0b2FzdCgnU2F2ZWQnKTsgZ28oJ2FkbWluJyk7CiAgICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5t' +
  'ZXNzYWdlLCB0cnVlKTsgfQogICAgfTsKICB9KTsKfQoKYXN5bmMgZnVuY3Rpb24gdGVtcGxhdGVGb3JtKHQpIHsKICBjb25zdCBm' +
  'aWVsZHMgPSBhd2FpdCBhcGkoJy90ZW1wbGF0ZS1maWVsZHMnKTsKICBjb25zdCB2ID0gdCB8fCB7IGJvZHk6ICcnLCBpc19kZWZh' +
  'dWx0OiBmYWxzZSB9OwogIHNoZWV0KHQgPyAnRWRpdCB0ZW1wbGF0ZScgOiAnTmV3IGFmZmlkYXZpdCB0ZW1wbGF0ZScsIGAKICAg' +
  'IDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlRlbXBsYXRlIG5hbWU8L2xhYmVs' +
  'PjxpbnB1dCBpZD0idF9uYW1lIiB2YWx1ZT0iJHtlc2Modi5uYW1lKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+' +
  'PGxhYmVsPkp1cmlzZGljdGlvbiAvIGNvdXJ0PC9sYWJlbD48aW5wdXQgaWQ9InRfanVyaXNkaWN0aW9uIiB2YWx1ZT0iJHtlc2Mo' +
  'di5qdXJpc2RpY3Rpb24pfSI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Qm9keTwvbGFi' +
  'ZWw+CiAgICAgIDx0ZXh0YXJlYSBpZD0idF9ib2R5IiBzdHlsZT0ibWluLWhlaWdodDoyMjBweDtmb250OjEyLjVweC8xLjUgJ0Nv' +
  'dXJpZXIgTmV3Jyxtb25vc3BhY2UiPiR7ZXNjKHYuYm9keSl9PC90ZXh0YXJlYT4KICAgICAgPGRpdiBjbGFzcz0iaGludCI+Q2xp' +
  'Y2sgYSBmaWVsZCB0byBpbnNlcnQgaXQgYXQgdGhlIGN1cnNvcjo8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idG9rZW5zIj4ke2Zp' +
  'ZWxkcy5tYXAoZiA9PiBgPGJ1dHRvbiBkYXRhLWY9IiR7ZlswXX0iIHRpdGxlPSIke2VzYyhmWzFdKX0iPnt7JHtmWzBdfX19PC9i' +
  'dXR0b24+YCkuam9pbignJyl9PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxsYWJlbCBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0' +
  'ZW1zOmNlbnRlcjtnYXA6OHB4Ij48aW5wdXQgdHlwZT0iY2hlY2tib3giIGlkPSJ0X2RlZmF1bHQiIHN0eWxlPSJ3aWR0aDphdXRv' +
  'IiAke3YuaXNfZGVmYXVsdCA/ICdjaGVja2VkJyA6ICcnfT4gVXNlIGFzIHRoZSBkZWZhdWx0IHRlbXBsYXRlPC9sYWJlbD4KICAg' +
  'IDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InNh' +
  'dmUiPlNhdmU8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgaWQ9InByZXZpZXciPlByZXZpZXcgd2l0aCBy' +
  'ZWFsIGpvYjwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNhbmNl' +
  'bDwvYnV0dG9uPgogICAgICAke3QgPyAnPGJ1dHRvbiBjbGFzcz0iYnRuIGdob3N0IiBpZD0iZGVsIiBzdHlsZT0iY29sb3I6dmFy' +
  'KC0tYmFkKTttYXJnaW4tbGVmdDphdXRvIj5EZWxldGU8L2J1dHRvbj4nIDogJyd9CiAgICA8L2Rpdj4KICAgIDxwcmUgY2xhc3M9' +
  'InByZXYiIGlkPSJ0cHJldiIgc3R5bGU9ImRpc3BsYXk6bm9uZTttYXJnaW4tdG9wOjEycHgiPjwvcHJlPmAsIGVsID0+IHsKICAg' +
  'IGNvbnN0IHRhID0gZWwucXVlcnlTZWxlY3RvcignI3RfYm9keScpOwogICAgZWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtZl0n' +
  'KS5mb3JFYWNoKGIgPT4gYi5vbmNsaWNrID0gKCkgPT4gewogICAgICBjb25zdCB0b2sgPSAne3snICsgYi5kYXRhc2V0LmYgKyAn' +
  'fX0nOwogICAgICBjb25zdCBzID0gdGEuc2VsZWN0aW9uU3RhcnQsIGUgPSB0YS5zZWxlY3Rpb25FbmQ7CiAgICAgIHRhLnZhbHVl' +
  'ID0gdGEudmFsdWUuc2xpY2UoMCwgcykgKyB0b2sgKyB0YS52YWx1ZS5zbGljZShlKTsKICAgICAgdGEuZm9jdXMoKTsgdGEuc2Vs' +
  'ZWN0aW9uU3RhcnQgPSB0YS5zZWxlY3Rpb25FbmQgPSBzICsgdG9rLmxlbmd0aDsKICAgIH0pOwogICAgZWwucXVlcnlTZWxlY3Rv' +
  'cignI3ByZXZpZXcnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCByID0gYXdhaXQgYXBpKCcvdGVtcGxhdGVz' +
  'L3ByZXZpZXcnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGJvZHk6IHRhLnZhbHVlIH0pIH0pOwog' +
  'ICAgICBjb25zdCBwID0gZWwucXVlcnlTZWxlY3RvcignI3RwcmV2Jyk7CiAgICAgIHAuc3R5bGUuZGlzcGxheSA9ICcnOyBwLnRl' +
  'eHRDb250ZW50ID0gci50ZXh0OwogICAgfTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNzYXZlJykub25jbGljayA9IGFzeW5jICgp' +
  'ID0+IHsKICAgICAgY29uc3QgYm9keSA9IHsKICAgICAgICBuYW1lOiBlbC5xdWVyeVNlbGVjdG9yKCcjdF9uYW1lJykudmFsdWUs' +
  'IGp1cmlzZGljdGlvbjogZWwucXVlcnlTZWxlY3RvcignI3RfanVyaXNkaWN0aW9uJykudmFsdWUsCiAgICAgICAgYm9keTogdGEu' +
  'dmFsdWUsIGlzX2RlZmF1bHQ6IGVsLnF1ZXJ5U2VsZWN0b3IoJyN0X2RlZmF1bHQnKS5jaGVja2VkCiAgICAgIH07CiAgICAgIGlm' +
  'ICghYm9keS5uYW1lLnRyaW0oKSkgcmV0dXJuIHRvYXN0KCdHaXZlIHRoZSB0ZW1wbGF0ZSBhIG5hbWUnLCB0cnVlKTsKICAgICAg' +
  'dHJ5IHsKICAgICAgICBhd2FpdCAodCA/IGFwaSgnL3RlbXBsYXRlcy8nICsgdC5pZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6' +
  'IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pCiAgICAgICAgICAgICAgICAgOiBhcGkoJy90ZW1wbGF0ZXMnLCB7IG1ldGhvZDogJ1BP' +
  'U1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KSk7CiAgICAgICAgY2xvc2VTaGVldCgpOyB0b2FzdCgnU2F2ZWQnKTsg' +
  'Z28oJ2FkbWluJyk7CiAgICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogICAgfTsKICAgIGlmIChl' +
  'bC5xdWVyeVNlbGVjdG9yKCcjZGVsJykpIGVsLnF1ZXJ5U2VsZWN0b3IoJyNkZWwnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewog' +
  'ICAgICBpZiAoIWNvbmZpcm0oJ0RlbGV0ZSB0aGlzIHRlbXBsYXRlPycpKSByZXR1cm47CiAgICAgIGF3YWl0IGFwaSgnL3RlbXBs' +
  'YXRlcy8nICsgdC5pZCwgeyBtZXRob2Q6ICdERUxFVEUnIH0pOwogICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KCdEZWxldGVkJyk7' +
  'IGdvKCdhZG1pbicpOwogICAgfTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tIGJvb3QgLS0gKi8KY29uc3QgVklFV1MgPSB7IGRhc2g6IGRhc2hWaWV3LCBqb2JzOiBqb2Jz' +
  'Vmlldywgam9iOiBqb2JWaWV3LCBzY2FuOiBzY2FuVmlldywKICB0b29sczogdG9vbHNWaWV3LCBwcm9wZXJ0eTogcHJvcGVydHlW' +
  'aWV3LCBtb25leTogbW9uZXlWaWV3LCBhZG1pbjogYWRtaW5WaWV3IH07Cgphc3luYyBmdW5jdGlvbiByZW5kZXIoKSB7CiAgY2xv' +
  'c2VTaGVldCgpOwogIGlmICghUy5tZSkgcmV0dXJuIGxvZ2luVmlldygpOwogIGlmIChTLnZpZXcgPT09ICdqb2JzJykgUy5jYWNo' +
  'ZS5qb2JGaWx0ZXIgPSBTLnBhcmFtczsKICBjb25zdCBmbiA9IFZJRVdTW1Mudmlld10gfHwgZGFzaFZpZXc7CiAgdHJ5IHsKICAg' +
  'IGFwcC5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0id3JhcCI+PGRpdiBjbGFzcz0iZW1wdHkiPkxvYWRpbmfigKY8L2Rpdj48L2Rp' +
  'dj4nOwogICAgYXdhaXQgZm4oKTsKICB9IGNhdGNoIChlKSB7CiAgICBpZiAoUy5tZSkgeyBhcHAuaW5uZXJIVE1MID0gc2hlbGwo' +
  'YDxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImVtcHR5Ij4ke2VzYyhlLm1lc3NhZ2UpfTwvZGl2PjwvZGl2PmApOyBiaW5k' +
  'U2hlbGwoKTsgfQogIH0KfQoKKGFzeW5jIGZ1bmN0aW9uIGJvb3QoKSB7CiAgdHJ5IHsgUy5tZSA9IGF3YWl0IGFwaSgnL21lJyk7' +
  'IH0gY2F0Y2ggKGUpIHsgUy5tZSA9IG51bGw7IH0KICByZW5kZXIoKTsKfSkoKTsKfSkoKTsKCjwvc2NyaXB0Pgo8L2JvZHk+Cjwv' +
  'aHRtbD4K'
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
const BUILD = '2026-08-18.11';           // shown in Setup so uploads can be confirmed
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
app.get('*', (req, res) => res.type('html').send(INDEX_HTML));

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
