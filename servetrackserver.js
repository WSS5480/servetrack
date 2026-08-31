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

-- Every company using ServeTrack is separate. Its jobs, clients, invoices,
-- statements, templates and people belong to it and are never visible to
-- another company. Scoping is enforced in every query, not by convention.
CREATE TABLE IF NOT EXISTS companies (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  contact_email TEXT,
  phone      TEXT,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'server',   -- owner | admin | server
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


/* ------------------------------------------------------------ companies --- */
/* Added by ALTER rather than in the CREATE above so a database that predates
   companies picks them up on the next start. db.js backfills the values. */

ALTER TABLE users               ADD COLUMN IF NOT EXISTS company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE clients             ADD COLUMN IF NOT EXISTS company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE jobs                ADD COLUMN IF NOT EXISTS company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE affidavit_templates ADD COLUMN IF NOT EXISTS company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE statements          ADD COLUMN IF NOT EXISTS company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE invoices            ADD COLUMN IF NOT EXISTS company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE access_codes        ADD COLUMN IF NOT EXISTS company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE;

-- The owner works inside one company at a time and can switch between them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;

-- A subscription is bought by a company, not by a person — the same way the
-- After School Scheduler puts the plan on the school. Everyone in the company
-- is covered by it.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan         TEXT NOT NULL DEFAULT 'free';   -- free | pro
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_expires DATE;

-- A job number identifies a job within its company. Two companies may each
-- have an ST-10001; they are different jobs.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_company_number_idx ON jobs(company_id, job_number);

CREATE INDEX IF NOT EXISTS users_company_idx      ON users(company_id);
CREATE INDEX IF NOT EXISTS clients_company_idx    ON clients(company_id);
CREATE INDEX IF NOT EXISTS jobs_company_idx       ON jobs(company_id);
CREATE INDEX IF NOT EXISTS templates_company_idx  ON affidavit_templates(company_id);
CREATE INDEX IF NOT EXISTS statements_company_idx ON statements(company_id);
CREATE INDEX IF NOT EXISTS invoices_company_idx   ON invoices(company_id);
CREATE INDEX IF NOT EXISTS codes_company_idx      ON access_codes(company_id);
`;


/* --------------------------------------------- bundled: the entire UI --- */
/* index.html (markup + styles + client script) encoded so the app ships as
   a single JavaScript file. Decoded once at startup. */
const INDEX_HTML = Buffer.from(
  'PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9InV0Zi04Ij4KPG1ldGEgbmFtZT0i' +
  'dmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCxpbml0aWFsLXNjYWxlPTEsdmlld3BvcnQtZml0PWNvdmVyIj4K' +
  'PG1ldGEgbmFtZT0idGhlbWUtY29sb3IiIGNvbnRlbnQ9IiMxZTNhNWYiPgo8dGl0bGU+U2VydmVUcmFjazwvdGl0bGU+CjxzdHls' +
  'ZT4KLyogUlRPNFUgaG91c2UgY29sb3VyczogdGhlIHJveWFsIGJsdWUgY2FycmllcyBzdHJ1Y3R1cmUsIHRoZSBvcmFuZ2UgaXMg' +
  'c3BlbnQKICAgb25seSBvbiB0aGUgb25lIGFjdGlvbiB0aGF0IG1hdHRlcnMgb24gYSBzY3JlZW4uICovCjpyb290ewogIC0tYmc6' +
  'I0VERjJGQjsgLS1jYXJkOiNmZmY7IC0taW5rOiMxMDE4MjI7IC0tbXV0ZWQ6IzVBNkE4MDsgLS1saW5lOiNEQkU0RjI7CiAgLS1i' +
  'cmFuZDojMEI0RkQzOyAtLWJyYW5kLTI6IzBBM0ZBODsgLS1hY2NlbnQ6I0YyNjYwRDsgLS1hY2NlbnQtMjojRDk1NTBBOwogIC0t' +
  'b2s6IzBGN0I0NTsgLS13YXJuOiNCNDUzMDk7IC0tYmFkOiNCNDIzMTg7IC0tcnVzaDojQzI0MTBDOwogIC0tcjoxMnB4OyAtLXNo' +
  'OjAgMXB4IDJweCByZ2JhKDExLDQwLDkwLC4wNiksMCAycHggNnB4IHJnYmEoMTEsNDAsOTAsLjA4KTsKfQoqe2JveC1zaXppbmc6' +
  'Ym9yZGVyLWJveH0KaHRtbCxib2R5e21hcmdpbjowO3BhZGRpbmc6MH0KLyogVGhlIHN0aWNreSBoZWFkZXIgYW5kIGZpeGVkIHRh' +
  'YiBiYXIgb3ZlcmxhcCB0aGUgdmlld3BvcnQsIHNvIGFueXRoaW5nIHRoZQogICBicm93c2VyIHNjcm9sbHMgaW50byB2aWV3IGNh' +
  'biBsYW5kIHVuZGVybmVhdGggdGhlbSBhbmQgc3dhbGxvdyB0aGUgdGFwLgogICBTY3JvbGwgcGFkZGluZyBrZWVwcyBzY3JvbGxl' +
  'ZC10byBjb250ZW50IGNsZWFyIG9mIGJvdGguICovCmh0bWx7c2Nyb2xsLXBhZGRpbmctdG9wOjc2cHg7c2Nyb2xsLXBhZGRpbmct' +
  'Ym90dG9tOjk2cHh9CmJvZHl7CiAgZm9udDoxNXB4LzEuNSAtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCwiU2Vnb2Ug' +
  'VUkiLFJvYm90byxIZWx2ZXRpY2EsQXJpYWwsc2Fucy1zZXJpZjsKICBiYWNrZ3JvdW5kOnZhcigtLWJnKTsgY29sb3I6dmFyKC0t' +
  'aW5rKTsgLXdlYmtpdC10ZXh0LXNpemUtYWRqdXN0OjEwMCU7Cn0KYXtjb2xvcjp2YXIoLS1icmFuZC0yKX0KYnV0dG9uLGlucHV0' +
  'LHNlbGVjdCx0ZXh0YXJlYXtmb250OmluaGVyaXQ7Y29sb3I6aW5oZXJpdH0KCi8qIC0tLS0tLS0tLS0gc2hlbGwgLS0tLS0tLS0t' +
  'LSAqLwojYXBwe21pbi1oZWlnaHQ6MTAwdmh9Ci50b3BiYXJ7CiAgcG9zaXRpb246c3RpY2t5O3RvcDowO3otaW5kZXg6MjA7YmFj' +
  'a2dyb3VuZDp2YXIoLS1icmFuZCk7Y29sb3I6I2ZmZjsKICBkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMHB4' +
  'O3BhZGRpbmc6MTJweCAxNHB4OwogIHBhZGRpbmctdG9wOmNhbGMoMTJweCArIGVudihzYWZlLWFyZWEtaW5zZXQtdG9wKSk7Cn0K' +
  'LnRvcGJhciAuYnJhbmR7Zm9udC13ZWlnaHQ6NzAwO2xldHRlci1zcGFjaW5nOi4ycHh9Ci50b3BiYXIgLmJyYW5kIHNtYWxse2Rp' +
  'c3BsYXk6YmxvY2s7Zm9udC13ZWlnaHQ6NDAwO2ZvbnQtc2l6ZToxMXB4O29wYWNpdHk6LjgyO2xldHRlci1zcGFjaW5nOi40cHh9' +
  'Ci50b3BiYXIgLnNwYWNlcntmbGV4OjF9Ci50b3BiYXIgYnV0dG9ue2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuMTQpO2Jv' +
  'cmRlcjowO2NvbG9yOiNmZmY7cGFkZGluZzo3cHggMTJweDtib3JkZXItcmFkaXVzOjhweH0KLndyYXB7bWF4LXdpZHRoOjExMDBw' +
  'eDttYXJnaW46MCBhdXRvO3BhZGRpbmc6MTRweCAxNHB4IDk2cHh9CgovKiBib3R0b20gdGFicyAobW9iaWxlKSAqLwoudGFic3sK' +
  'ICBwb3NpdGlvbjpmaXhlZDtsZWZ0OjA7cmlnaHQ6MDtib3R0b206MDt6LWluZGV4OjMwO2JhY2tncm91bmQ6I2ZmZjtib3JkZXIt' +
  'dG9wOjFweCBzb2xpZCB2YXIoLS1saW5lKTsKICBkaXNwbGF5OmZsZXg7cGFkZGluZy1ib3R0b206ZW52KHNhZmUtYXJlYS1pbnNl' +
  'dC1ib3R0b20pOwp9Ci50YWJzIGJ1dHRvbnsKICBmbGV4OjE7YmFja2dyb3VuZDpub25lO2JvcmRlcjowO3BhZGRpbmc6OXB4IDFw' +
  'eCAxMHB4O2ZvbnQtc2l6ZToxMHB4O2NvbG9yOnZhcigtLW11dGVkKTsKICBkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29s' +
  'dW1uO2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6M3B4OwogIG1pbi13aWR0aDowO3doaXRlLXNwYWNlOm5vd3JhcDtsZXR0ZXItc3Bh' +
  'Y2luZzotLjFweDsKfQoudGFicyBidXR0b24gLmlje2ZvbnQtc2l6ZToxOXB4O2xpbmUtaGVpZ2h0OjF9Ci50YWJzIGJ1dHRvbi5v' +
  'bntjb2xvcjp2YXIoLS1icmFuZCk7Zm9udC13ZWlnaHQ6NjAwfQoKLyogLS0tLS0tLS0tLSBwaWVjZXMgLS0tLS0tLS0tLSAqLwou' +
  'Y2FyZHtiYWNrZ3JvdW5kOnZhcigtLWNhcmQpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czp2YXIo' +
  'LS1yKTtib3gtc2hhZG93OnZhcigtLXNoKTtwYWRkaW5nOjE0cHg7bWFyZ2luLWJvdHRvbToxMnB4fQouY2FyZCBoMnttYXJnaW46' +
  'MCAwIDEwcHg7Zm9udC1zaXplOjE1cHh9Ci5jYXJkIGgyIC5zdWJ7Zm9udC13ZWlnaHQ6NDAwO2NvbG9yOnZhcigtLW11dGVkKTtm' +
  'b250LXNpemU6MTJweH0KaDEucGFnZXtmb250LXNpemU6MjBweDttYXJnaW46NHB4IDAgMTRweH0KLnJvd3tkaXNwbGF5OmZsZXg7' +
  'Z2FwOjhweDtmbGV4LXdyYXA6d3JhcDthbGlnbi1pdGVtczpjZW50ZXJ9Ci5ncmlke2Rpc3BsYXk6Z3JpZDtnYXA6MTBweH0KQG1l' +
  'ZGlhKG1pbi13aWR0aDo3MjBweCl7IC5nMntncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcn0gLmcze2dyaWQtdGVtcGxhdGUt' +
  'Y29sdW1uczpyZXBlYXQoMywxZnIpfSB9Cgouc3RhdHN7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQo' +
  'MiwxZnIpO2dhcDoxMHB4O21hcmdpbi1ib3R0b206MTJweH0KQG1lZGlhKG1pbi13aWR0aDo3MjBweCl7LnN0YXRze2dyaWQtdGVt' +
  'cGxhdGUtY29sdW1uczpyZXBlYXQoNCwxZnIpfX0KLnN0YXR7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoxcHggc29saWQgdmFyKC0t' +
  'bGluZSk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yKTtwYWRkaW5nOjEycHg7Ym94LXNoYWRvdzp2YXIoLS1zaCl9Ci5zdGF0IC5ue2Zv' +
  'bnQtc2l6ZToyNnB4O2ZvbnQtd2VpZ2h0OjcwMDtsaW5lLWhlaWdodDoxLjF9Ci5zdGF0IC5se2ZvbnQtc2l6ZToxMnB4O2NvbG9y' +
  'OnZhcigtLW11dGVkKTttYXJnaW4tdG9wOjJweH0KLnN0YXQuYWxlcnQgLm57Y29sb3I6dmFyKC0tYmFkKX0KLnN0YXQuZ29vZCAu' +
  'bntjb2xvcjp2YXIoLS1vayl9CgouYnRue2JhY2tncm91bmQ6dmFyKC0tYWNjZW50KTtjb2xvcjojZmZmO2JvcmRlcjowO3BhZGRp' +
  'bmc6MTFweCAxNnB4O2JvcmRlci1yYWRpdXM6OTk5cHg7CiAgZm9udC13ZWlnaHQ6NzAwO2N1cnNvcjpwb2ludGVyO2JveC1zaGFk' +
  'b3c6MCAxcHggMnB4IHJnYmEoMTgwLDcwLDEwLC4yNSl9Ci5idG46YWN0aXZle2JhY2tncm91bmQ6dmFyKC0tYWNjZW50LTIpfQou' +
  'YnRuLnNlY3tiYWNrZ3JvdW5kOiNmZmY7Y29sb3I6dmFyKC0tYnJhbmQpO2JvcmRlcjoxLjVweCBzb2xpZCB2YXIoLS1icmFuZCk7' +
  'Ym94LXNoYWRvdzpub25lfQouYnRuLmJsdWV7YmFja2dyb3VuZDp2YXIoLS1icmFuZCl9Ci5idG4uZ2hvc3R7YmFja2dyb3VuZDp0' +
  'cmFuc3BhcmVudDtjb2xvcjp2YXIoLS1icmFuZC0yKTtib3JkZXI6MDtwYWRkaW5nOjhweCA0cHg7Zm9udC13ZWlnaHQ6NjAwO2Jv' +
  'eC1zaGFkb3c6bm9uZX0KLmJ0bi5uYXZ7YmFja2dyb3VuZDp2YXIoLS1icmFuZCl9Ci5idG4ub2t7YmFja2dyb3VuZDp2YXIoLS1v' +
  'ayl9Ci5idG4uYmFke2JhY2tncm91bmQ6dmFyKC0tYmFkKX0KLmJ0bi5zbXtwYWRkaW5nOjdweCAxMXB4O2ZvbnQtc2l6ZToxM3B4' +
  'O2JvcmRlci1yYWRpdXM6OHB4fQouYnRuLmJsb2Nre3dpZHRoOjEwMCU7ZGlzcGxheTpibG9ja30KLmJ0bltkaXNhYmxlZF17b3Bh' +
  'Y2l0eTouNX0KCmxhYmVse2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOnZhcigtLW11' +
  'dGVkKTttYXJnaW46MCAwIDRweH0KaW5wdXQsc2VsZWN0LHRleHRhcmVhewogIHdpZHRoOjEwMCU7cGFkZGluZzoxMXB4IDEycHg7' +
  'Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEwcHg7YmFja2dyb3VuZDojZmZmOwp9CmlucHV0OmZv' +
  'Y3VzLHNlbGVjdDpmb2N1cyx0ZXh0YXJlYTpmb2N1c3tvdXRsaW5lOjJweCBzb2xpZCAjQkJEMkY3O2JvcmRlci1jb2xvcjp2YXIo' +
  'LS1icmFuZCl9CnRleHRhcmVhe21pbi1oZWlnaHQ6OTBweDtyZXNpemU6dmVydGljYWx9Ci5maWVsZHttYXJnaW4tYm90dG9tOjEw' +
  'cHh9Ci5oaW50e2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW4tdG9wOjRweH0KCi5saXN0e2Rpc3BsYXk6' +
  'ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjhweH0KLml0ZW17CiAgYmFja2dyb3VuZDojZmZmO2JvcmRlcjoxcHggc29s' +
  'aWQgdmFyKC0tbGluZSk7Ym9yZGVyLWxlZnQ6NHB4IHNvbGlkIHZhcigtLWxpbmUpOwogIGJvcmRlci1yYWRpdXM6dmFyKC0tcik7' +
  'cGFkZGluZzoxMXB4IDEycHg7Ym94LXNoYWRvdzp2YXIoLS1zaCk7Y3Vyc29yOnBvaW50ZXI7Cn0KLml0ZW0ucC1SdXNoe2JvcmRl' +
  'ci1sZWZ0LWNvbG9yOnZhcigtLXdhcm4pfQouaXRlbS5wLVNhbWVEYXl7Ym9yZGVyLWxlZnQtY29sb3I6dmFyKC0tcnVzaCl9Ci5p' +
  'dGVtLm92ZXJkdWV7Ym9yZGVyLWxlZnQtY29sb3I6dmFyKC0tYmFkKX0KLml0ZW0gLnR7Zm9udC13ZWlnaHQ6NjAwfQouaXRlbSAu' +
  'bXtmb250LXNpemU6MTIuNXB4O2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW4tdG9wOjJweH0KLml0ZW0gLnJ7ZGlzcGxheTpmbGV4' +
  'O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7Z2FwOjEwcHh9CgoucGlsbHtkaXNw' +
  'bGF5OmlubGluZS1ibG9jaztmb250LXNpemU6MTFweDtmb250LXdlaWdodDo3MDA7cGFkZGluZzozcHggOHB4O2JvcmRlci1yYWRp' +
  'dXM6OTlweDtiYWNrZ3JvdW5kOiNFOEVFRjg7Y29sb3I6IzNDNEM2Njt3aGl0ZS1zcGFjZTpub3dyYXB9Ci5waWxsLlNlcnZlZHti' +
  'YWNrZ3JvdW5kOiNlM2Y1ZWE7Y29sb3I6dmFyKC0tb2spfQoucGlsbC5QZW5kaW5ne2JhY2tncm91bmQ6I2ZkZjBlMztjb2xvcjp2' +
  'YXIoLS13YXJuKX0KLnBpbGwuQXNzaWduZWR7YmFja2dyb3VuZDojRTNFQ0ZEO2NvbG9yOnZhcigtLWJyYW5kLTIpfQoucGlsbC5B' +
  'dHRlbXB0ZWR7YmFja2dyb3VuZDojZmRmM2QzO2NvbG9yOiM4YTYxMDB9Ci5waWxsLk5vbkVzdHtiYWNrZ3JvdW5kOiNmZGU4ZTY7' +
  'Y29sb3I6dmFyKC0tYmFkKX0KLnBpbGwuQ2FuY2VsbGVkLC5waWxsLk9uSG9sZHtiYWNrZ3JvdW5kOiNlY2VmZjM7Y29sb3I6IzVh' +
  'NjQ3Mn0KLnBpbGwucnVzaHtiYWNrZ3JvdW5kOiNGREU4RDY7Y29sb3I6dmFyKC0tcnVzaCl9Ci5waWxsLlBhaWR7YmFja2dyb3Vu' +
  'ZDojZTNmNWVhO2NvbG9yOnZhcigtLW9rKX0KLnBpbGwuT3BlbiwucGlsbC5VbnBhaWR7YmFja2dyb3VuZDojZmRmMGUzO2NvbG9y' +
  'OnZhcigtLXdhcm4pfQoKdGFibGUudGJse3dpZHRoOjEwMCU7Ym9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlO2ZvbnQtc2l6ZToxMy41' +
  'cHh9CnRhYmxlLnRibCB0aHt0ZXh0LWFsaWduOmxlZnQ7Zm9udC1zaXplOjExLjVweDt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7' +
  'bGV0dGVyLXNwYWNpbmc6LjRweDtjb2xvcjp2YXIoLS1tdXRlZCk7cGFkZGluZzo2cHggNnB4O2JvcmRlci1ib3R0b206MXB4IHNv' +
  'bGlkIHZhcigtLWxpbmUpfQp0YWJsZS50YmwgdGR7cGFkZGluZzo5cHggNnB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigt' +
  'LWxpbmUpO3ZlcnRpY2FsLWFsaWduOnRvcH0KdGFibGUudGJsIHRyOmxhc3QtY2hpbGQgdGR7Ym9yZGVyLWJvdHRvbTowfQoubnVt' +
  'e3RleHQtYWxpZ246cmlnaHR9CgouYXR0e2JvcmRlci1sZWZ0OjNweCBzb2xpZCB2YXIoLS1saW5lKTtwYWRkaW5nOjhweCAwIDhw' +
  'eCAxMnB4O21hcmdpbi1ib3R0b206OHB4fQouYXR0LlNlcnZlZHtib3JkZXItbGVmdC1jb2xvcjp2YXIoLS1vayl9Ci5hdHQgLmh7' +
  'Zm9udC13ZWlnaHQ6NjAwO2ZvbnQtc2l6ZToxMy41cHh9Ci5hdHQgLm17Zm9udC1zaXplOjEyLjVweDtjb2xvcjp2YXIoLS1tdXRl' +
  'ZCl9Cgouc2hlZXR7cG9zaXRpb246Zml4ZWQ7aW5zZXQ6MDt6LWluZGV4OjUwO2JhY2tncm91bmQ6cmdiYSgxMiwxOCwyOCwuNSk7' +
  'ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmZsZXgtZW5kO2p1c3RpZnktY29udGVudDpjZW50ZXJ9Ci5zaGVldCAuaW5uZXJ7YmFj' +
  'a2dyb3VuZDojZmZmO3dpZHRoOjEwMCU7bWF4LXdpZHRoOjY0MHB4O21heC1oZWlnaHQ6OTJ2aDtvdmVyZmxvdzphdXRvO2JvcmRl' +
  'ci1yYWRpdXM6MTZweCAxNnB4IDAgMDtwYWRkaW5nOjE2cHggMTZweCBjYWxjKDIwcHggKyBlbnYoc2FmZS1hcmVhLWluc2V0LWJv' +
  'dHRvbSkpfQpAbWVkaWEobWluLXdpZHRoOjcyMHB4KXsuc2hlZXR7YWxpZ24taXRlbXM6Y2VudGVyfS5zaGVldCAuaW5uZXJ7Ym9y' +
  'ZGVyLXJhZGl1czoxNnB4O21heC1oZWlnaHQ6ODh2aH19Ci5zaGVldCBoMnttYXJnaW46MCAwIDEycHg7Zm9udC1zaXplOjE3cHh9' +
  'Ci5zaGVldCAuY2xvc2V7cG9zaXRpb246YWJzb2x1dGU7cmlnaHQ6MTRweDt0b3A6MTRweH0KCi50b2FzdHtwb3NpdGlvbjpmaXhl' +
  'ZDtsZWZ0OjUwJTt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTtib3R0b206NzhweDt6LWluZGV4OjYwO2JhY2tncm91bmQ6IzEy' +
  'MTYxZjtjb2xvcjojZmZmO3BhZGRpbmc6MTFweCAxNnB4O2JvcmRlci1yYWRpdXM6MTBweDtmb250LXNpemU6MTRweDttYXgtd2lk' +
  'dGg6OTAlO2JveC1zaGFkb3c6MCA4cHggMjRweCByZ2JhKDAsMCwwLC4yNSl9Ci50b2FzdC5iYWR7YmFja2dyb3VuZDp2YXIoLS1i' +
  'YWQpfQoKLmVtcHR5e3RleHQtYWxpZ246Y2VudGVyO2NvbG9yOnZhcigtLW11dGVkKTtwYWRkaW5nOjI4cHggMTBweDtmb250LXNp' +
  'emU6MTRweH0KLnRva2Vuc3tkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjZweDttYXJnaW4tdG9wOjZweH0KLnRva2Vu' +
  'cyBidXR0b257Zm9udDoxMnB4LzEgbW9ub3NwYWNlO3BhZGRpbmc6NnB4IDhweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUp' +
  'O2JhY2tncm91bmQ6I2Y4ZmFmYztib3JkZXItcmFkaXVzOjZweDtjdXJzb3I6cG9pbnRlcn0KcHJlLnByZXZ7YmFja2dyb3VuZDoj' +
  'ZjhmYWZjO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czo4cHg7cGFkZGluZzoxMnB4O3doaXRlLXNw' +
  'YWNlOnByZS13cmFwO2ZvbnQ6MTJweC8xLjUgIkNvdXJpZXIgTmV3Iixtb25vc3BhY2U7bWF4LWhlaWdodDozNDBweDtvdmVyZmxv' +
  'dzphdXRvfQojcmVhZGVye3dpZHRoOjEwMCU7Ym9yZGVyLXJhZGl1czoxMnB4O292ZXJmbG93OmhpZGRlbjtiYWNrZ3JvdW5kOiMw' +
  'MDA7bWluLWhlaWdodDoyNDBweH0KI3JlYWRlciB2aWRlb3t3aWR0aDoxMDAlO2Rpc3BsYXk6YmxvY2t9CgovKiBUaGUgc2lnbi1p' +
  'biBzY3JlZW4gaXMgdGhlIG9ubHkgcGxhY2UgdGhlIHR3byBob3VzZSBjb2xvdXJzIHNpdCB0b2dldGhlciBhdAogICBmdWxsIHN0' +
  'cmVuZ3RoIOKAlCBibHVlIG5hbWUsIG9yYW5nZSBhY3Rpb24sIG9uIHRoZSBzb2Z0IGdyb3VuZC4gKi8KLmxvZ2lue21heC13aWR0' +
  'aDozODBweDttYXJnaW46N3ZoIGF1dG87cGFkZGluZzowIDE4cHh9Ci5sb2dpbiAubG9nb3t0ZXh0LWFsaWduOmNlbnRlcjttYXJn' +
  'aW4tYm90dG9tOjIycHh9Ci5sb2dpbiAubG9nbyBie2ZvbnQtc2l6ZTozMHB4O2NvbG9yOnZhcigtLWJyYW5kKTtsZXR0ZXItc3Bh' +
  'Y2luZzotLjZweH0KLmxvZ2luIC5sb2dvIGRpdntmb250LXNpemU6MTIuNXB4O2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW4tdG9w' +
  'OjNweDtsZXR0ZXItc3BhY2luZzouM3B4fQoubG9naW4gLmNhcmR7Ym9yZGVyLXJhZGl1czoxNnB4O3BhZGRpbmc6MjBweCAxOHB4' +
  'fQoKLmRyb3B6b25le2JhY2tncm91bmQ6I0Y2RjlGRTtib3JkZXI6MS41cHggZGFzaGVkICNCQkNDRTg7Ym9yZGVyLXJhZGl1czp2' +
  'YXIoLS1yKTtwYWRkaW5nOjEycHg7bWFyZ2luLWJvdHRvbToxNHB4fQouZHJvcHpvbmUgaW5wdXRbdHlwZT1maWxlXXtiYWNrZ3Jv' +
  'dW5kOiNmZmY7cGFkZGluZzo5cHg7Zm9udC1zaXplOjEzcHh9Ci5kcm9wem9uZSAuaGludHttYXJnaW4tdG9wOjhweDtsaW5lLWhl' +
  'aWdodDoxLjQ1fQoKLyogbGFiZWwgc2hlZXQgZ3JpZCAqLwoubGdyaWR7ZGlzcGxheTpncmlkO2dhcDozcHg7YmFja2dyb3VuZDoj' +
  'RThFRUY4O3BhZGRpbmc6NnB4O2JvcmRlci1yYWRpdXM6OHB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSl9Ci5sY2VsbHth' +
  'c3BlY3QtcmF0aW86NS8yO2JvcmRlcjoxcHggc29saWQgI2M5ZDRlMDtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyLXJhZGl1czozcHg7' +
  'Y3Vyc29yOnBvaW50ZXI7CiAgZm9udDo2MDAgMTFweCBzeXN0ZW0tdWk7Y29sb3I6dmFyKC0tbXV0ZWQpO3BhZGRpbmc6MDttaW4t' +
  'aGVpZ2h0OjIycHg7ZGlzcGxheTpmbGV4OwogIGFsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyfQoubGNl' +
  'bGwudXNlZHtiYWNrZ3JvdW5kOiNkN2RkZTU7Y29sb3I6IzhhOTRhMjtib3JkZXItY29sb3I6I2MyY2NkOH0KLmxjZWxsLm5leHR7' +
  'YmFja2dyb3VuZDojZTNmNWVhO2JvcmRlci1jb2xvcjp2YXIoLS1vayk7Y29sb3I6dmFyKC0tb2spfQoubGNlbGw6YWN0aXZle3Ry' +
  'YW5zZm9ybTpzY2FsZSguOTYpfQoKPC9zdHlsZT4KPGxpbmsgcmVsPSJpY29uIiBocmVmPSJkYXRhOmltYWdlL3N2Zyt4bWwsPHN2' +
  'ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAzMiAzMic+PHJlY3Qgd2lkdGg9JzMyJyBo' +
  'ZWlnaHQ9JzMyJyByeD0nNycgZmlsbD0nJTIzMWUzYTVmJy8+PHRleHQgeD0nMTYnIHk9JzIzJyBmb250LXNpemU9JzE5JyBmb250' +
  'LWZhbWlseT0nc3lzdGVtLXVpJyBmb250LXdlaWdodD0nNzAwJyBmaWxsPSd3aGl0ZScgdGV4dC1hbmNob3I9J21pZGRsZSc+Uzwv' +
  'dGV4dD48L3N2Zz4iPgo8L2hlYWQ+Cjxib2R5Pgo8ZGl2IGlkPSJhcHAiPjwvZGl2Pgo8c2NyaXB0IHNyYz0iaHR0cHM6Ly9jZG4u' +
  'anNkZWxpdnIubmV0L25wbS9AenhpbmcvbGlicmFyeUAwLjIxLjMvdW1kL2luZGV4Lm1pbi5qcyI+PC9zY3JpcHQ+CjxzY3JpcHQ+' +
  'Ci8qIFNlcnZlVHJhY2sg4oCUIGZpZWxkLWZpcnN0IHByb2Nlc3Mgc2VydmluZyBtYW5hZ2VyICovCihmdW5jdGlvbiAoKSB7Cid1' +
  'c2Ugc3RyaWN0JzsKCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LSBoZWxwZXJzIC0tICovCmNvbnN0ICQgPSBzZWwgPT4gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWwpOwpjb25zdCBhcHAgPSAk' +
  'KCcjYXBwJyk7CmNvbnN0IFMgPSB7IG1lOiBudWxsLCB2aWV3OiAnZGFzaCcsIHBhcmFtczoge30sIGNhY2hlOiB7fSB9OwoKY29u' +
  'c3QgZXNjID0gcyA9PiBTdHJpbmcocyA9PSBudWxsID8gJycgOiBzKQogIC5yZXBsYWNlKC8mL2csICcmYW1wOycpLnJlcGxhY2Uo' +
  'LzwvZywgJyZsdDsnKS5yZXBsYWNlKC8+L2csICcmZ3Q7JykKICAucmVwbGFjZSgvIi9nLCAnJnF1b3Q7JykucmVwbGFjZSgvJy9n' +
  'LCAnJiMzOTsnKTsKCmNvbnN0IG1vbmV5ID0gdiA9PiAnJCcgKyBOdW1iZXIodiB8fCAwKS50b0ZpeGVkKDIpOwpjb25zdCBjbHMg' +
  'PSBzID0+IFN0cmluZyhzIHx8ICcnKS5yZXBsYWNlKC9bXkEtWmEtel0vZywgJycpOwoKZnVuY3Rpb24gZm10RGF0ZSh2LCBvcHRz' +
  'KSB7CiAgaWYgKCF2KSByZXR1cm4gJyc7CiAgY29uc3QgZCA9IG5ldyBEYXRlKHYpOwogIHJldHVybiBkLnRvTG9jYWxlRGF0ZVN0' +
  'cmluZygnZW4tVVMnLCBvcHRzIHx8IHsgbW9udGg6ICdzaG9ydCcsIGRheTogJ251bWVyaWMnLCB5ZWFyOiAnbnVtZXJpYycgfSk7' +
  'Cn0KZnVuY3Rpb24gZm10RGF0ZU9ubHkodikgeyAvLyBkYXRlIGNvbHVtbnMgY29tZSBiYWNrIGFzIFlZWVktTU0tREQgb3IgSVNP' +
  'IG1pZG5pZ2h0IFVUQwogIGlmICghdikgcmV0dXJuICcnOwogIGNvbnN0IHMgPSBTdHJpbmcodikuc2xpY2UoMCwgMTApLnNwbGl0' +
  'KCctJyk7CiAgcmV0dXJuIGAkeytzWzFdfS8keytzWzJdfS8ke3NbMF0uc2xpY2UoMil9YDsKfQpmdW5jdGlvbiBmbXREVCh2KSB7' +
  'CiAgaWYgKCF2KSByZXR1cm4gJyc7CiAgcmV0dXJuIG5ldyBEYXRlKHYpLnRvTG9jYWxlU3RyaW5nKCdlbi1VUycsCiAgICB7IG1v' +
  'bnRoOiAnc2hvcnQnLCBkYXk6ICdudW1lcmljJywgaG91cjogJ251bWVyaWMnLCBtaW51dGU6ICcyLWRpZ2l0JyB9KTsKfQpmdW5j' +
  'dGlvbiBkYXlzT3V0KHYpIHsKICBpZiAoIXYpIHJldHVybiBudWxsOwogIGNvbnN0IGR1ZSA9IG5ldyBEYXRlKFN0cmluZyh2KS5z' +
  'bGljZSgwLCAxMCkgKyAnVDEyOjAwOjAwJyk7CiAgcmV0dXJuIE1hdGgucm91bmQoKGR1ZSAtIG5ldyBEYXRlKCkpIC8gODY0ZTUp' +
  'Owp9CmNvbnN0IHRvZGF5SVNPID0gKCkgPT4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKTsKCmFzeW5jIGZ1' +
  'bmN0aW9uIGFwaShwYXRoLCBvcHRzKSB7CiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goJy9hcGknICsgcGF0aCwgT2JqZWN0LmFz' +
  'c2lnbih7CiAgICBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSwgY3JlZGVudGlhbHM6ICdz' +
  'YW1lLW9yaWdpbicKICB9LCBvcHRzIHx8IHt9KSk7CiAgY29uc3QgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCkuY2F0Y2goKCkgPT4g' +
  'KHt9KSk7CiAgLy8gQSA0MDEgZnJvbSAvbG9naW4gbWVhbnMgdGhlIGNyZWRlbnRpYWxzIHdlcmUgd3JvbmcsIG5vdCB0aGF0IGEg' +
  'c2Vzc2lvbgogIC8vIGxhcHNlZC4gVHJlYXRpbmcgdGhlIHR3byB0aGUgc2FtZSBzaG93ZWQgIlNpZ25lZCBvdXQiIHRvIHNvbWVv' +
  'bmUgd2hvIGhhZAogIC8vIHNpbXBseSBtaXN0eXBlZCBhIHBhc3N3b3JkLCB3aGljaCBpcyBhY3RpdmVseSBtaXNsZWFkaW5nLgog' +
  'IGlmIChyZXMuc3RhdHVzID09PSA0MDEgJiYgcGF0aCAhPT0gJy9sb2dpbicpIHsKICAgIFMubWUgPSBudWxsOwogICAgcmVuZGVy' +
  'KCk7CiAgICB0aHJvdyBuZXcgRXJyb3IoZGF0YS5lcnJvciB8fCAnU2lnbmVkIG91dCcpOwogIH0KICBpZiAoIXJlcy5vaykgdGhy' +
  'b3cgbmV3IEVycm9yKGRhdGEuZXJyb3IgfHwgJ1JlcXVlc3QgZmFpbGVkJyk7CiAgcmV0dXJuIGRhdGE7Cn0KCmZ1bmN0aW9uIHRv' +
  'YXN0KG1zZywgYmFkKSB7CiAgY29uc3QgdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogIHQuY2xhc3NOYW1lID0g' +
  'J3RvYXN0JyArIChiYWQgPyAnIGJhZCcgOiAnJyk7CiAgdC50ZXh0Q29udGVudCA9IG1zZzsKICBkb2N1bWVudC5ib2R5LmFwcGVu' +
  'ZENoaWxkKHQpOwogIHNldFRpbWVvdXQoKCkgPT4gdC5yZW1vdmUoKSwgMzIwMCk7Cn0KCmZ1bmN0aW9uIGdvKHZpZXcsIHBhcmFt' +
  'cykgeyBTLnZpZXcgPSB2aWV3OyBTLnBhcmFtcyA9IHBhcmFtcyB8fCB7fTsgd2luZG93LnNjcm9sbFRvKDAsIDApOyByZW5kZXIo' +
  'KTsgfQoKLyogbW9kYWwgc2hlZXQgKi8KbGV0IHNoZWV0RWwgPSBudWxsOwpmdW5jdGlvbiBzaGVldCh0aXRsZSwgYm9keUh0bWws' +
  'IG9uTW91bnQpIHsKICBjbG9zZVNoZWV0KCk7CiAgc2hlZXRFbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogIHNo' +
  'ZWV0RWwuY2xhc3NOYW1lID0gJ3NoZWV0JzsKICBzaGVldEVsLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJpbm5lciI+PGgyPiR7' +
  'ZXNjKHRpdGxlKX08L2gyPiR7Ym9keUh0bWx9PC9kaXY+YDsKICBzaGVldEVsLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZSA9' +
  'PiB7IGlmIChlLnRhcmdldCA9PT0gc2hlZXRFbCkgY2xvc2VTaGVldCgpOyB9KTsKICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxk' +
  'KHNoZWV0RWwpOwogIGlmIChvbk1vdW50KSBvbk1vdW50KHNoZWV0RWwpOwp9CmZ1bmN0aW9uIGNsb3NlU2hlZXQoKSB7CiAgaWYg' +
  'KHNoZWV0RWwpIHsgc2hlZXRFbC5yZW1vdmUoKTsgc2hlZXRFbCA9IG51bGw7IH0KICBpZiAod2luZG93Ll9fc3RvcFNjYW4pIHsg' +
  'd2luZG93Ll9fc3RvcFNjYW4oKTsgd2luZG93Ll9fc3RvcFNjYW4gPSBudWxsOyB9Cn0Kd2luZG93LmNsb3NlU2hlZXQgPSBjbG9z' +
  'ZVNoZWV0OwoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBtYXBzIGxp' +
  'bmtpbmcgLS0gKi8KY29uc3QgaXNJT1MgPSAoKSA9PiAvaVBhZHxpUGhvbmV8aVBvZC8udGVzdChuYXZpZ2F0b3IudXNlckFnZW50' +
  'KSB8fAogIChuYXZpZ2F0b3IucGxhdGZvcm0gPT09ICdNYWNJbnRlbCcgJiYgbmF2aWdhdG9yLm1heFRvdWNoUG9pbnRzID4gMSk7' +
  'CgpmdW5jdGlvbiBhZGRyT2YoaikgewogIHJldHVybiBbai5hZGRyZXNzMSwgai5hZGRyZXNzMiwgai5jaXR5LCBqLnN0YXRlLCBq' +
  'LnppcF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJywgJyk7Cn0KZnVuY3Rpb24gYXBwbGVVcmwoYSkgeyByZXR1cm4gJ2h0dHBzOi8v' +
  'bWFwcy5hcHBsZS5jb20vP2RhZGRyPScgKyBlbmNvZGVVUklDb21wb25lbnQoYSkgKyAnJmRpcmZsZz1kJzsgfQpmdW5jdGlvbiBn' +
  'b29nbGVVcmwoYSkgewogIHJldHVybiAnaHR0cHM6Ly93d3cuZ29vZ2xlLmNvbS9tYXBzL2Rpci8/YXBpPTEmZGVzdGluYXRpb249' +
  'JyArIGVuY29kZVVSSUNvbXBvbmVudChhKSArICcmdHJhdmVsbW9kZT1kcml2aW5nJzsKfQpmdW5jdGlvbiBuYXZVcmwoYSkgeyBy' +
  'ZXR1cm4gaXNJT1MoKSA/IGFwcGxlVXJsKGEpIDogZ29vZ2xlVXJsKGEpOyB9CmZ1bmN0aW9uIHJvdXRlVXJsKGxpc3QpIHsKICBj' +
  'b25zdCBzdG9wcyA9IGxpc3QubWFwKGFkZHJPZikuZmlsdGVyKEJvb2xlYW4pOwogIGlmICghc3RvcHMubGVuZ3RoKSByZXR1cm4g' +
  'bnVsbDsKICBjb25zdCBkZXN0ID0gc3RvcHNbc3RvcHMubGVuZ3RoIC0gMV07CiAgY29uc3Qgd2F5ID0gc3RvcHMuc2xpY2UoMCwg' +
  'LTEpLnNsaWNlKDAsIDkpLm1hcChlbmNvZGVVUklDb21wb25lbnQpLmpvaW4oJ3wnKTsKICByZXR1cm4gJ2h0dHBzOi8vd3d3Lmdv' +
  'b2dsZS5jb20vbWFwcy9kaXIvP2FwaT0xJm9yaWdpbj1DdXJyZW50K0xvY2F0aW9uJmRlc3RpbmF0aW9uPScgKwogICAgZW5jb2Rl' +
  'VVJJQ29tcG9uZW50KGRlc3QpICsgKHdheSA/ICcmd2F5cG9pbnRzPScgKyB3YXkgOiAnJykgKyAnJnRyYXZlbG1vZGU9ZHJpdmlu' +
  'Zyc7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gbGF5' +
  'b3V0IC0tICovCmNvbnN0IGlzQWRtaW4gPSAoKSA9PiBTLm1lICYmIChTLm1lLnJvbGUgPT09ICdhZG1pbicgfHwgUy5tZS5yb2xl' +
  'ID09PSAnb3duZXInKTsKY29uc3QgaXNPd25lciA9ICgpID0+IFMubWUgJiYgUy5tZS5yb2xlID09PSAnb3duZXInOwpjb25zdCBy' +
  'b2xlTGFiZWwgPSAoKSA9PiBTLm1lLnJvbGUgPT09ICdvd25lcicgPyAnT3duZXInCiAgOiAoUy5tZS5yb2xlID09PSAnYWRtaW4n' +
  'ID8gJ0FkbWluJyA6ICdGaWVsZCBzZXJ2ZXInKTsKCmNvbnN0IFRBQlMgPSAoKSA9PiBpc0FkbWluKCkKICA/IFtbJ2Rhc2gnLCAn' +
  'VG9kYXknLCAn4peOJ10sIFsnam9icycsICdKb2JzJywgJ+KWpCddLCBbJ3NjYW4nLCAnU2NhbicsICfilqUnXSwKICAgICBbJ3Rv' +
  'b2xzJywgJ1Rvb2xzJywgJ+KcgiddLCBbJ3Byb3BlcnR5JywgJ1Byb3AnLCAn4oyCJ10sIFsnbW9uZXknLCAnQmlsbCcsICckJ10s' +
  'IFsnYWRtaW4nLCAnU2V0dXAnLCAn4pqZJ11dCiAgOiBbWydkYXNoJywgJ015IERheScsICfil44nXSwgWydqb2JzJywgJ0pvYnMn' +
  'LCAn4pakJ10sIFsnc2NhbicsICdTY2FuJywgJ+KWpSddLAogICAgIFsndG9vbHMnLCAnVG9vbHMnLCAn4pyCJ10sIFsncHJvcGVy' +
  'dHknLCAnUHJvcCcsICfijIInXSwgWydtb25leScsICdQYXknLCAnJCddXTsKCmZ1bmN0aW9uIHNoZWxsKGlubmVyKSB7CiAgY29u' +
  'c3QgdGFicyA9IFRBQlMoKS5tYXAoKFt2LCBsYWJlbCwgaWNdKSA9PgogICAgYDxidXR0b24gZGF0YS10YWI9IiR7dn0iIGNsYXNz' +
  'PSIke1MudmlldyA9PT0gdiB8fCAodiA9PT0gJ2pvYnMnICYmIFMudmlldyA9PT0gJ2pvYicpID8gJ29uJyA6ICcnfSI+CiAgICAg' +
  'IDxzcGFuIGNsYXNzPSJpYyI+JHtpY308L3NwYW4+JHtlc2MobGFiZWwpfTwvYnV0dG9uPmApLmpvaW4oJycpOwogIGNvbnN0IHN1' +
  'cHBvcnRCYXIgPSBTLm1lLnN1cHBvcnQKICAgID8gYDxkaXYgc3R5bGU9ImJhY2tncm91bmQ6I0MyNDEwQztjb2xvcjojZmZmO3Rl' +
  'eHQtYWxpZ246Y2VudGVyO2ZvbnQtc2l6ZToxMi41cHg7CiAgICAgICAgcGFkZGluZzo2cHggMTBweDtmb250LXdlaWdodDo2MDAi' +
  'PlN1cHBvcnQgdmlldyDigJQgbmFtZXMgJmFtcDsgZG9jdW1lbnRzIGFyZSBoaWRkZW4uCiAgICAgICAgVGhpcyBpcyAke2VzYyhT' +
  'Lm1lLmNvbXBhbnkgPyBTLm1lLmNvbXBhbnkubmFtZSA6ICdhIGN1c3RvbWVyIGNvbXBhbnknKX0sIG5vdCB5b3Vycy48L2Rpdj5g' +
  'CiAgICA6ICcnOwogIHJldHVybiBgJHtzdXBwb3J0QmFyfQogICAgPGRpdiBjbGFzcz0idG9wYmFyIj4KICAgICAgPGRpdiBjbGFz' +
  'cz0iYnJhbmQiPlNlcnZlVHJhY2s8c21hbGw+JHtlc2MoUy5tZS5jb21wYW55ID8gUy5tZS5jb21wYW55Lm5hbWUgOiAnJyl9JHsK' +
  'ICAgICAgICBTLm1lLmNvbXBhbnkgPyAnIMK3ICcgOiAnJ30ke2VzYyhTLm1lLm5hbWUpfSDCtyAke3JvbGVMYWJlbCgpfTwvc21h' +
  'bGw+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InNwYWNlciI+PC9kaXY+CiAgICAgICR7aXNPd25lcigpICYmIChTLm1lLmNvbXBh' +
  'bmllcyB8fCBbXSkubGVuZ3RoID4gMQogICAgICAgID8gYDxzZWxlY3QgaWQ9ImNvU3dpdGNoIiB0aXRsZT0iV2hpY2ggY29tcGFu' +
  'eSB5b3UgYXJlIHdvcmtpbmcgaW4iPiR7CiAgICAgICAgICAgIChTLm1lLmNvbXBhbmllcyB8fCBbXSkubWFwKGMgPT4gYDxvcHRp' +
  'b24gdmFsdWU9IiR7Yy5pZH0iJHsKICAgICAgICAgICAgICBTLm1lLmNvbXBhbnkgJiYgYy5pZCA9PT0gUy5tZS5jb21wYW55Lmlk' +
  'ID8gJyBzZWxlY3RlZCcgOiAnJ30+JHtlc2MoYy5uYW1lKX08L29wdGlvbj5gKS5qb2luKCcnKQogICAgICAgICAgfTwvc2VsZWN0' +
  'PmAgOiAnJ30KICAgICAgPGJ1dHRvbiBpZD0ibG9nb3V0Ij5TaWduIG91dDwvYnV0dG9uPgogICAgPC9kaXY+CiAgICA8ZGl2IGNs' +
  'YXNzPSJ3cmFwIj4ke2lubmVyfTwvZGl2PgogICAgPGRpdiBjbGFzcz0idGFicyI+JHt0YWJzfTwvZGl2PmA7Cn0KCmZ1bmN0aW9u' +
  'IGJpbmRTaGVsbCgpIHsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS10YWJdJykuZm9yRWFjaChiID0+CiAgICBi' +
  'Lm9uY2xpY2sgPSAoKSA9PiBnbyhiLmRhdGFzZXQudGFiKSk7CiAgY29uc3QgbG8gPSAkKCcjbG9nb3V0Jyk7CiAgaWYgKGxvKSBs' +
  'by5vbmNsaWNrID0gYXN5bmMgKCkgPT4geyBhd2FpdCBhcGkoJy9sb2dvdXQnLCB7IG1ldGhvZDogJ1BPU1QnIH0pOyBTLm1lID0g' +
  'bnVsbDsgcmVuZGVyKCk7IH07CiAgY29uc3Qgc3cgPSAkKCcjY29Td2l0Y2gnKTsKICBpZiAoc3cpIHN3Lm9uY2hhbmdlID0gYXN5' +
  'bmMgKCkgPT4gewogICAgdHJ5IHsKICAgICAgY29uc3Qgb3V0ID0gYXdhaXQgYXBpKCcvY29tcGFuaWVzLycgKyBzdy52YWx1ZSAr' +
  'ICcvZW50ZXInLCB7IG1ldGhvZDogJ1BPU1QnIH0pOwogICAgICBTLm1lID0gYXdhaXQgYXBpKCcvbWUnKTsKICAgICAgdG9hc3Qo' +
  'J05vdyBpbiAnICsgb3V0LmNvbXBhbnkubmFtZSk7CiAgICAgIHJlbmRlcigpOwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1l' +
  'c3NhZ2UsIHRydWUpOyB9CiAgfTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0gbG9naW4gLS0gKi8KZnVuY3Rpb24gbG9naW5WaWV3KCkgewogIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBj' +
  'bGFzcz0ibG9naW4iPgogICAgPGRpdiBjbGFzcz0ibG9nbyI+PGI+U2VydmVUcmFjazwvYj48ZGl2PlByb2Nlc3Mgc2VydmluZyBt' +
  'YW5hZ2VtZW50PC9kaXY+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJl' +
  'bD5FbWFpbDwvbGFiZWw+PGlucHV0IGlkPSJlbWFpbCIgdHlwZT0iZW1haWwiIGF1dG9jb21wbGV0ZT0idXNlcm5hbWUiIGlucHV0' +
  'bW9kZT0iZW1haWwiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBhc3N3b3JkPC9sYWJlbD48aW5wdXQg' +
  'aWQ9InB3IiB0eXBlPSJwYXNzd29yZCIgYXV0b2NvbXBsZXRlPSJjdXJyZW50LXBhc3N3b3JkIj48L2Rpdj4KICAgICAgPGJ1dHRv' +
  'biBjbGFzcz0iYnRuIGJsb2NrIiBpZD0ic2lnbmluIj5TaWduIGluPC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIGlk' +
  'PSJlcnIiIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQpO21hcmdpbi10b3A6MTBweCI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Imhp' +
  'bnQiIHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlcjttYXJnaW4tdG9wOjE0cHgiPgogICAgICAgIEJlZW4gZ2l2ZW4gYW4gYWNjZXNz' +
  'IGNvZGU/IDxhIGhyZWY9IiMiIGlkPSJoYXZlQ29kZSI+U2V0IHVwIHlvdXIgYWNjb3VudDwvYT48L2Rpdj4KICAgICAgPGRpdiBj' +
  'bGFzcz0iaGludCIgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyO21hcmdpbi10b3A6MTBweCI+CiAgICAgICAgPGEgaHJlZj0iL3By' +
  'aXZhY3kiIHRhcmdldD0iX2JsYW5rIj5Qcml2YWN5IHN0YXRlbWVudDwvYT48L2Rpdj4KICAgIDwvZGl2PjwvZGl2PmA7CiAgY29u' +
  'c3Qgc3VibWl0ID0gYXN5bmMgKCkgPT4gewogICAgJCgnI2VycicpLnRleHRDb250ZW50ID0gJyc7CiAgICB0cnkgewogICAgICBh' +
  'd2FpdCBhcGkoJy9sb2dpbicsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZW1haWw6ICQoJyNlbWFp' +
  'bCcpLnZhbHVlLCBwYXNzd29yZDogJCgnI3B3JykudmFsdWUgfSkgfSk7CiAgICAgIFMubWUgPSBhd2FpdCBhcGkoJy9tZScpOwog' +
  'ICAgICBnbygnZGFzaCcpOwogICAgfSBjYXRjaCAoZSkgeyAkKCcjZXJyJykudGV4dENvbnRlbnQgPSBlLm1lc3NhZ2U7IH0KICB9' +
  'OwogICQoJyNzaWduaW4nKS5vbmNsaWNrID0gc3VibWl0OwogICQoJyNwdycpLm9ua2V5ZG93biA9IGUgPT4geyBpZiAoZS5rZXkg' +
  'PT09ICdFbnRlcicpIHN1Ym1pdCgpOyB9OwogICQoJyNoYXZlQ29kZScpLm9uY2xpY2sgPSBlID0+IHsgZS5wcmV2ZW50RGVmYXVs' +
  'dCgpOyByZWRlZW1WaWV3KCk7IH07CiAgJCgnI2VtYWlsJykuZm9jdXMoKTsKfQoKCi8qIFJlZGVlbWluZyBhIGNvZGUgY3JlYXRl' +
  'cyB0aGUgYWNjb3VudCwgc28gc29tZW9uZSBjYW4gYmUgc2V0IHVwIHdpdGhvdXQgYW4KICAgYWRtaW4ga2V5aW5nIGluIHRoZWly' +
  'IGRldGFpbHMuICovCmZ1bmN0aW9uIHJlZGVlbVZpZXcoKSB7CiAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJsb2dpbiI+' +
  'CiAgICA8ZGl2IGNsYXNzPSJsb2dvIj48Yj5TZXJ2ZVRyYWNrPC9iPjxkaXY+U2V0IHVwIHlvdXIgYWNjb3VudDwvZGl2PjwvZGl2' +
  'PgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+QWNjZXNzIGNvZGU8L2xhYmVs' +
  'PgogICAgICAgIDxpbnB1dCBpZD0icl9jb2RlIiBwbGFjZWhvbGRlcj0iQUJDRC1FRkdILUpLTE0iIGF1dG9jYXBpdGFsaXplPSJj' +
  'aGFyYWN0ZXJzIiBzdHlsZT0idGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQi' +
  'PjxsYWJlbD5Zb3VyIG5hbWU8L2xhYmVsPjxpbnB1dCBpZD0icl9uYW1lIiBhdXRvY29tcGxldGU9Im5hbWUiPjwvZGl2PgogICAg' +
  'ICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkVtYWlsPC9sYWJlbD48aW5wdXQgaWQ9InJfZW1haWwiIHR5cGU9ImVtYWlsIiBp' +
  'bnB1dG1vZGU9ImVtYWlsIiBhdXRvY29tcGxldGU9ImVtYWlsIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJl' +
  'bD5DaG9vc2UgYSBwYXNzd29yZDwvbGFiZWw+CiAgICAgICAgPGlucHV0IGlkPSJyX3B3IiB0eXBlPSJwYXNzd29yZCIgYXV0b2Nv' +
  'bXBsZXRlPSJuZXctcGFzc3dvcmQiIHBsYWNlaG9sZGVyPSJBdCBsZWFzdCA4IGNoYXJhY3RlcnMiPjwvZGl2PgogICAgICA8ZGl2' +
  'IGNsYXNzPSJmaWVsZCI+PGxhYmVsPllvdXIgY29tcGFueSA8c3BhbiBjbGFzcz0iaGludCI+4oCUIG9ubHkgaWYgeW91IGFyZSBz' +
  'dGFydGluZyBhIG5ldyBvbmU8L3NwYW4+PC9sYWJlbD4KICAgICAgICA8aW5wdXQgaWQ9InJfY28iIHBsYWNlaG9sZGVyPSJlLmcu' +
  'IFJpbyBHcmFuZGUgUHJvY2VzcyBTZXJ2aW5nIj48L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJsb2NrIiBpZD0icl9n' +
  'byI+Q3JlYXRlIG15IGFjY291bnQ8L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgaWQ9InJfZXJyIiBzdHlsZT0iY29s' +
  'b3I6dmFyKC0tYmFkKTttYXJnaW4tdG9wOjEwcHgiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0idGV4dC1h' +
  'bGlnbjpjZW50ZXI7bWFyZ2luLXRvcDoxNHB4Ij4KICAgICAgICA8YSBocmVmPSIjIiBpZD0icl9iYWNrIj5CYWNrIHRvIHNpZ24g' +
  'aW48L2E+PC9kaXY+CiAgICA8L2Rpdj48L2Rpdj5gOwoKICAkKCcjcl9iYWNrJykub25jbGljayA9IGUgPT4geyBlLnByZXZlbnRE' +
  'ZWZhdWx0KCk7IGxvZ2luVmlldygpOyB9OwogIGNvbnN0IGdvID0gYXN5bmMgKCkgPT4gewogICAgJCgnI3JfZXJyJykudGV4dENv' +
  'bnRlbnQgPSAnJzsKICAgIHRyeSB7CiAgICAgIGNvbnN0IG1hZGUgPSBhd2FpdCBhcGkoJy9yZWRlZW0nLCB7IG1ldGhvZDogJ1BP' +
  'U1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgY29kZTogJCgnI3JfY29kZScpLnZhbHVlLCBuYW1lOiAkKCcjcl9u' +
  'YW1lJykudmFsdWUsIGNvbXBhbnk6ICQoJyNyX2NvJykudmFsdWUsCiAgICAgICAgZW1haWw6ICQoJyNyX2VtYWlsJykudmFsdWUs' +
  'IHBhc3N3b3JkOiAkKCcjcl9wdycpLnZhbHVlCiAgICAgIH0pIH0pOwogICAgICBTLm1lID0gYXdhaXQgYXBpKCcvbWUnKTsKICAg' +
  'ICAgdG9hc3QoJ1dlbGNvbWUsICcgKyBtYWRlLm5hbWUpOwogICAgICBnbzIoKTsKICAgIH0gY2F0Y2ggKGUpIHsgJCgnI3JfZXJy' +
  'JykudGV4dENvbnRlbnQgPSBlLm1lc3NhZ2U7IH0KICB9OwogIGNvbnN0IGdvMiA9ICgpID0+IHsgUy52aWV3ID0gJ2Rhc2gnOyBT' +
  'LnBhcmFtcyA9IHt9OyByZW5kZXIoKTsgfTsKICAkKCcjcl9nbycpLm9uY2xpY2sgPSBnbzsKICAkKCcjcl9wdycpLm9ua2V5ZG93' +
  'biA9IGUgPT4geyBpZiAoZS5rZXkgPT09ICdFbnRlcicpIGdvKCk7IH07CiAgJCgnI3JfY29kZScpLmZvY3VzKCk7Cn0KCi8qIC0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gZGFzaGJvYXJkIC0tICovCmFz' +
  'eW5jIGZ1bmN0aW9uIGRhc2hWaWV3KCkgewogIGNvbnN0IFtzdGF0cywgam9ic10gPSBhd2FpdCBQcm9taXNlLmFsbChbYXBpKCcv' +
  'c3RhdHMnKSwgYXBpKCcvam9icz9vcGVuPTEnKV0pOwogIGNvbnN0IG92ZXJkdWUgPSBqb2JzLmZpbHRlcihqID0+IHsgY29uc3Qg' +
  'ZCA9IGRheXNPdXQoai5kdWVfZGF0ZSk7IHJldHVybiBkICE9PSBudWxsICYmIGQgPCAwOyB9KTsKICBjb25zdCB0b2RheSA9IGpv' +
  'YnMuZmlsdGVyKGogPT4geyBjb25zdCBkID0gZGF5c091dChqLmR1ZV9kYXRlKTsgcmV0dXJuIGQgIT09IG51bGwgJiYgZCA+PSAw' +
  'ICYmIGQgPD0gMTsgfSk7CiAgY29uc3QgcnVzaCA9IGpvYnMuZmlsdGVyKGogPT4gai5wcmlvcml0eSAhPT0gJ1JvdXRpbmUnKTsK' +
  'ICBjb25zdCBtaW5lID0gaXNBZG1pbigpID8gam9icyA6IGpvYnM7CgogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8aDEg' +
  'Y2xhc3M9InBhZ2UiPiR7aXNBZG1pbigpID8gJ09wZXJhdGlvbnMgdG9kYXknIDogJ015IGRheSd9PC9oMT4KICAgIDxkaXYgY2xh' +
  'c3M9InN0YXRzIj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdCI+PGRpdiBjbGFzcz0ibiI+JHtzdGF0cy5vcGVuX2pvYnN9PC9kaXY+' +
  'PGRpdiBjbGFzcz0ibCI+T3BlbiBqb2JzPC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQgJHtzdGF0cy5vdmVyZHVl' +
  'ID8gJ2FsZXJ0JyA6ICcnfSI+PGRpdiBjbGFzcz0ibiI+JHtzdGF0cy5vdmVyZHVlfTwvZGl2PjxkaXYgY2xhc3M9ImwiPlBhc3Qg' +
  'ZHVlPC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxkaXYgY2xhc3M9Im4iPiR7c3RhdHMucnVzaH08L2Rpdj48' +
  'ZGl2IGNsYXNzPSJsIj5SdXNoIC8gc2FtZSBkYXk8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdCBnb29kIj48ZGl2' +
  'IGNsYXNzPSJuIj4ke3N0YXRzLnNlcnZlZF83ZH08L2Rpdj48ZGl2IGNsYXNzPSJsIj5TZXJ2ZWQsIDcgZGF5czwvZGl2PjwvZGl2' +
  'PgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5Sb3V0ZSBteSBkYXkgPHNwYW4gY2xhc3M9InN1' +
  'YiI+4oCUICR7bWluZS5sZW5ndGh9IG9wZW4gc3RvcCR7bWluZS5sZW5ndGggPT09IDEgPyAnJyA6ICdzJ308L3NwYW4+PC9oMj4K' +
  'ICAgICAgPHAgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOi00cHgiPk9wZW5zIEdvb2dsZSBNYXBzIHdpdGggeW91ciBz' +
  'dG9wcyBpbiBvcmRlciAodXAgdG8gMTApLiBObyBtYXBwaW5nIGZlZXMg4oCUIGl0IGp1c3QgaGFuZHMgb2ZmIHRvIHRoZSBhcHAg' +
  'eW91IGFscmVhZHkgaGF2ZS48L3A+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICAg' +
  'ICAgPGJ1dHRvbiBjbGFzcz0iYnRuIG5hdiIgaWQ9InJvdXRlQnRuIiAke21pbmUubGVuZ3RoID8gJycgOiAnZGlzYWJsZWQnfT5T' +
  'dGFydCByb3V0ZSAoJHtNYXRoLm1pbihtaW5lLmxlbmd0aCwgMTApfSBzdG9wcyk8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNs' +
  'YXNzPSJidG4gc2VjIHNtIiBpZD0icm91dGVMaXN0Ij5TZWUgb3JkZXI8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4K' +
  'CiAgICAke3NlY3Rpb24oJ1Bhc3QgZHVlJywgb3ZlcmR1ZSl9CiAgICAke3NlY3Rpb24oJ0R1ZSB0b2RheSBvciB0b21vcnJvdycs' +
  'IHRvZGF5KX0KICAgICR7c2VjdGlvbignUnVzaCAmYW1wOyBzYW1lIGRheScsIHJ1c2guZmlsdGVyKGogPT4gIW92ZXJkdWUuaW5j' +
  'bHVkZXMoaikgJiYgIXRvZGF5LmluY2x1ZGVzKGopKSl9CiAgICAke292ZXJkdWUubGVuZ3RoICsgdG9kYXkubGVuZ3RoICsgcnVz' +
  'aC5sZW5ndGggPT09IDAKICAgICAgPyBgPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0iZW1wdHkiPk5vdGhpbmcgdXJnZW50' +
  'LiAke21pbmUubGVuZ3RofSBvcGVuIGpvYiR7bWluZS5sZW5ndGggPT09IDEgPyAnJyA6ICdzJ30gdG90YWwg4oCUIHNlZSB0aGUg' +
  'Sm9icyB0YWIuPC9kaXY+PC9kaXY+YCA6ICcnfQogIGApOwogIGJpbmRTaGVsbCgpOwogIGJpbmRKb2JJdGVtcygpOwogIGNvbnN0' +
  'IHJiID0gJCgnI3JvdXRlQnRuJyk7CiAgaWYgKHJiKSByYi5vbmNsaWNrID0gKCkgPT4gewogICAgY29uc3QgdXJsID0gcm91dGVV' +
  'cmwobWluZS5zbGljZSgwLCAxMCkpOwogICAgaWYgKHVybCkgd2luZG93Lm9wZW4odXJsLCAnX2JsYW5rJyk7CiAgfTsKICAkKCcj' +
  'cm91dGVMaXN0Jykub25jbGljayA9ICgpID0+IHNoZWV0KCdSb3V0ZSBvcmRlcicsIGAKICAgIDxwIGNsYXNzPSJoaW50Ij5PcmRl' +
  'cmVkIGJ5IHByaW9yaXR5LCB0aGVuIGR1ZSBkYXRlLiBUYXAgYW55IHN0b3AgdG8gbmF2aWdhdGUgdG8gaXQgYWxvbmUuPC9wPgog' +
  'ICAgPGRpdiBjbGFzcz0ibGlzdCI+JHttaW5lLnNsaWNlKDAsIDEwKS5tYXAoKGosIGkpID0+IGAKICAgICAgPGRpdiBjbGFzcz0i' +
  'aXRlbSIgZGF0YS1uYXY9IiR7ZXNjKGFkZHJPZihqKSl9Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJyIj48ZGl2PjxkaXYgY2xhc3M9' +
  'InQiPiR7aSArIDF9LiAke2VzYyhqLnJlY2lwaWVudF9uYW1lKX08L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtIj4ke2VzYyhh' +
  'ZGRyT2YoaikpfTwvZGl2PjwvZGl2PgogICAgICAgIDxzcGFuIGNsYXNzPSJwaWxsICR7Y2xzKGoucHJpb3JpdHkpfSI+JHtlc2Mo' +
  'ai5wcmlvcml0eSl9PC9zcGFuPjwvZGl2PjwvZGl2PmApLmpvaW4oJycpfTwvZGl2PgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNl' +
  'YyBibG9jayIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5DbG9zZTwvYnV0dG9uPmAsCiAg' +
  'ICBlbCA9PiBlbC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1uYXZdJykuZm9yRWFjaChuID0+CiAgICAgIG4ub25jbGljayA9ICgp' +
  'ID0+IHdpbmRvdy5vcGVuKG5hdlVybChuLmRhdGFzZXQubmF2KSwgJ19ibGFuaycpKSk7Cn0KCmZ1bmN0aW9uIHNlY3Rpb24odGl0' +
  'bGUsIGxpc3QpIHsKICBpZiAoIWxpc3QubGVuZ3RoKSByZXR1cm4gJyc7CiAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJjYXJkIj48aDI+' +
  'JHt0aXRsZX0gPHNwYW4gY2xhc3M9InN1YiI+JHtsaXN0Lmxlbmd0aH08L3NwYW4+PC9oMj4KICAgIDxkaXYgY2xhc3M9Imxpc3Qi' +
  'PiR7bGlzdC5tYXAoam9iSXRlbSkuam9pbignJyl9PC9kaXY+PC9kaXY+YDsKfQoKZnVuY3Rpb24gam9iSXRlbShqKSB7CiAgY29u' +
  'c3QgZCA9IGRheXNPdXQoai5kdWVfZGF0ZSk7CiAgY29uc3QgbGF0ZSA9IGQgIT09IG51bGwgJiYgZCA8IDAgJiYgIVsnU2VydmVk' +
  'JywgJ05vbi1Fc3QnLCAnQ2FuY2VsbGVkJ10uaW5jbHVkZXMoai5zdGF0dXMpOwogIGNvbnN0IGR1ZSA9IGouZHVlX2RhdGUKICAg' +
  'ID8gKGxhdGUgPyBgPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLWJhZCk7Zm9udC13ZWlnaHQ6NjAwIj4ke01hdGguYWJzKGQpfWQg' +
  'cGFzdCBkdWU8L3NwYW4+YAogICAgICAgICAgICA6IChkID09PSAwID8gJ2R1ZSB0b2RheScgOiBkID09PSAxID8gJ2R1ZSB0b21v' +
  'cnJvdycgOiAnZHVlICcgKyBmbXREYXRlT25seShqLmR1ZV9kYXRlKSkpCiAgICA6ICdubyBkdWUgZGF0ZSc7CiAgcmV0dXJuIGA8' +
  'ZGl2IGNsYXNzPSJpdGVtIHAtJHtjbHMoai5wcmlvcml0eSl9ICR7bGF0ZSA/ICdvdmVyZHVlJyA6ICcnfSIgZGF0YS1qb2I9IiR7' +
  'ai5pZH0iPgogICAgPGRpdiBjbGFzcz0iciI+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0idCI+JHtlc2Moai5yZWNp' +
  'cGllbnRfbmFtZSl9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibSI+JHtlc2Moai5qb2JfbnVtYmVyKX0gwrcgJHtlc2Moai5j' +
  'aXR5IHx8ICcnKX0ke2ouY2l0eSA/ICcsICcgOiAnJ30ke2VzYyhqLnN0YXRlIHx8ICcnKX0gwrcgJHtkdWV9PC9kaXY+CiAgICAg' +
  'ICAgPGRpdiBjbGFzcz0ibSI+JHtlc2Moai5jbGllbnRfbmFtZSB8fCAnTm8gY2xpZW50Jyl9JHtqLnNlcnZlcl9uYW1lID8gJyDi' +
  'hpIgJyArIGVzYyhqLnNlcnZlcl9uYW1lKSA6ICcnfSR7ai5hdHRlbXB0X2NvdW50ID8gJyDCtyAnICsgai5hdHRlbXB0X2NvdW50' +
  'ICsgJyBhdHRlbXB0JyArIChqLmF0dGVtcHRfY291bnQgPT09IDEgPyAnJyA6ICdzJykgOiAnJ308L2Rpdj4KICAgICAgPC9kaXY+' +
  'CiAgICAgIDxkaXYgc3R5bGU9InRleHQtYWxpZ246cmlnaHQiPgogICAgICAgIDxzcGFuIGNsYXNzPSJwaWxsICR7Y2xzKGouc3Rh' +
  'dHVzKX0iPiR7ZXNjKGouc3RhdHVzKX08L3NwYW4+CiAgICAgICAgJHtqLnByaW9yaXR5ICE9PSAnUm91dGluZScgPyBgPGRpdiBz' +
  'dHlsZT0ibWFyZ2luLXRvcDo1cHgiPjxzcGFuIGNsYXNzPSJwaWxsIHJ1c2giPiR7ZXNjKGoucHJpb3JpdHkpfTwvc3Bhbj48L2Rp' +
  'dj5gIDogJyd9CiAgICAgIDwvZGl2PgogICAgPC9kaXY+PC9kaXY+YDsKfQoKZnVuY3Rpb24gYmluZEpvYkl0ZW1zKCkgewogIGRv' +
  'Y3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWpvYl0nKS5mb3JFYWNoKGVsID0+CiAgICBlbC5vbmNsaWNrID0gKCkgPT4g' +
  'Z28oJ2pvYicsIHsgaWQ6IGVsLmRhdGFzZXQuam9iIH0pKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGpvYnMgLS0gKi8KYXN5bmMgZnVuY3Rpb24gam9ic1ZpZXcoKSB7CiAgY29u' +
  'c3QgZiA9IFMucGFyYW1zOwogIGNvbnN0IHFzID0gbmV3IFVSTFNlYXJjaFBhcmFtcygpOwogIGlmIChmLnN0YXR1cykgcXMuc2V0' +
  'KCdzdGF0dXMnLCBmLnN0YXR1cyk7CiAgaWYgKGYucSkgcXMuc2V0KCdxJywgZi5xKTsKICBpZiAoZi5vcGVuKSBxcy5zZXQoJ29w' +
  'ZW4nLCAnMScpOwogIGNvbnN0IGpvYnMgPSBhd2FpdCBhcGkoJy9qb2JzPycgKyBxcy50b1N0cmluZygpKTsKCiAgYXBwLmlubmVy' +
  'SFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFnZSI+JHtpc0FkbWluKCkgPyAnSm9icycgOiAnTXkgam9icyd9PC9oMT4K' +
  'ICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAgIDxpbnB1dCBpZD0icSIgcGxhY2Vo' +
  'b2xkZXI9IlNlYXJjaCBuYW1lLCBjYXNlICMsIGpvYiAjLCBhZGRyZXNzIiB2YWx1ZT0iJHtlc2MoZi5xIHx8ICcnKX0iIHN0eWxl' +
  'PSJmbGV4OjE7bWluLXdpZHRoOjE2MHB4Ij4KICAgICAgICA8c2VsZWN0IGlkPSJzdGF0dXMiIHN0eWxlPSJ3aWR0aDphdXRvIj4K' +
  'ICAgICAgICAgIDxvcHRpb24gdmFsdWU9IiI+QW55IHN0YXR1czwvb3B0aW9uPgogICAgICAgICAgJHtbJ1BlbmRpbmcnLCAnQXNz' +
  'aWduZWQnLCAnQXR0ZW1wdGVkJywgJ1NlcnZlZCcsICdOb24tRXN0JywgJ09uIEhvbGQnLCAnQ2FuY2VsbGVkJ10KICAgICAgICAg' +
  'ICAgLm1hcChzID0+IGA8b3B0aW9uICR7Zi5zdGF0dXMgPT09IHMgPyAnc2VsZWN0ZWQnIDogJyd9PiR7c308L29wdGlvbj5gKS5q' +
  'b2luKCcnKX0KICAgICAgICA8L3NlbGVjdD4KICAgICAgICA8bGFiZWwgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpj' +
  'ZW50ZXI7Z2FwOjZweDttYXJnaW46MDtmb250LXNpemU6MTNweCI+CiAgICAgICAgICA8aW5wdXQgdHlwZT0iY2hlY2tib3giIGlk' +
  'PSJvcGVuT25seSIgJHtmLm9wZW4gPyAnY2hlY2tlZCcgOiAnJ30gc3R5bGU9IndpZHRoOmF1dG8iPiBPcGVuIG9ubHk8L2xhYmVs' +
  'PgogICAgICA8L2Rpdj4KICAgICAgJHtpc0FkbWluKCkgPyAnPGJ1dHRvbiBjbGFzcz0iYnRuIGJsb2NrIiBpZD0ibmV3Sm9iIiBz' +
  'dHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4rIE5ldyBqb2I8L2J1dHRvbj4nIDogJyd9CiAgICA8L2Rpdj4KICAgICR7am9icy5sZW5n' +
  'dGggPyBgPGRpdiBjbGFzcz0ibGlzdCI+JHtqb2JzLm1hcChqb2JJdGVtKS5qb2luKCcnKX08L2Rpdj5gCiAgICAgIDogJzxkaXYg' +
  'Y2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImVtcHR5Ij5ObyBqb2JzIG1hdGNoLjwvZGl2PjwvZGl2Pid9CiAgYCk7CiAgYmluZFNo' +
  'ZWxsKCk7IGJpbmRKb2JJdGVtcygpOwogIGNvbnN0IGFwcGx5ID0gKCkgPT4gZ28oJ2pvYnMnLCB7IHE6ICQoJyNxJykudmFsdWUu' +
  'dHJpbSgpLCBzdGF0dXM6ICQoJyNzdGF0dXMnKS52YWx1ZSwgb3BlbjogJCgnI29wZW5Pbmx5JykuY2hlY2tlZCB9KTsKICAkKCcj' +
  'cScpLm9ua2V5ZG93biA9IGUgPT4geyBpZiAoZS5rZXkgPT09ICdFbnRlcicpIGFwcGx5KCk7IH07CiAgJCgnI3N0YXR1cycpLm9u' +
  'Y2hhbmdlID0gYXBwbHk7CiAgJCgnI29wZW5Pbmx5Jykub25jaGFuZ2UgPSBhcHBseTsKICBpZiAoJCgnI25ld0pvYicpKSAkKCcj' +
  'bmV3Sm9iJykub25jbGljayA9ICgpID0+IGpvYkZvcm0obnVsbCk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBqb2IgZm9ybSAtLSAqLwphc3luYyBmdW5jdGlvbiBqb2JGb3JtKGpvYikg' +
  'ewogIGNvbnN0IFtjbGllbnRzLCB1c2Vyc10gPSBhd2FpdCBQcm9taXNlLmFsbChbYXBpKCcvY2xpZW50cycpLCBhcGkoJy91c2Vy' +
  'cycpXSk7CiAgY29uc3QgdiA9IGpvYiB8fCB7IHNlcnZpY2VfdHlwZTogJ1BlcnNvbmFsJywgcHJpb3JpdHk6ICdSb3V0aW5lJywg' +
  'c3RhdHVzOiAnUGVuZGluZycgfTsKICBjb25zdCBvcHQgPSAobGlzdCwgc2VsLCBsYWJlbCkgPT4gbGlzdC5tYXAoeCA9PgogICAg' +
  'YDxvcHRpb24gdmFsdWU9IiR7eC5pZH0iICR7U3RyaW5nKHNlbCkgPT09IFN0cmluZyh4LmlkKSA/ICdzZWxlY3RlZCcgOiAnJ30+' +
  'JHtlc2MobGFiZWwoeCkpfTwvb3B0aW9uPmApLmpvaW4oJycpOwoKICBzaGVldChqb2IgPyAnRWRpdCAnICsgam9iLmpvYl9udW1i' +
  'ZXIgOiAnTmV3IGpvYicsIGAKICAgIDxkaXYgY2xhc3M9ImRyb3B6b25lIj4KICAgICAgPGxhYmVsPlN0YXJ0IGZyb20gdGhlIHBh' +
  'cGVyczwvbGFiZWw+CiAgICAgIDxpbnB1dCB0eXBlPSJmaWxlIiBpZD0iZl9wZGYiIGFjY2VwdD0iYXBwbGljYXRpb24vcGRmLC5w' +
  'ZGYiPgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBpZD0icGRmTXNnIj5QaWNrIHRoZSBzdW1tb25zLCBjaXRhdGlvbiwgc3VicG9l' +
  'bmEgb3IgY29tcGxhaW50IGFzIGEgUERGIGFuZCBJJ2xsCiAgICAgICAgcmVhZCB3aGF0IEkgY2FuIGludG8gdGhlIGZvcm0gYmVs' +
  'b3cuIEFsd2F5cyBjaGVjayBpdCBhZ2FpbnN0IHRoZSBkb2N1bWVudCBiZWZvcmUgc2F2aW5nLjwvZGl2PgogICAgPC9kaXY+CiAg' +
  'ICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5DbGllbnQ8L2xhYmVsPjxzZWxl' +
  'Y3QgaWQ9ImZfY2xpZW50X2lkIj4KICAgICAgICA8b3B0aW9uIHZhbHVlPSIiPuKAlCBub25lIOKAlDwvb3B0aW9uPiR7b3B0KGNs' +
  'aWVudHMsIHYuY2xpZW50X2lkLCBjID0+IGMubmFtZSl9PC9zZWxlY3Q+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48' +
  'bGFiZWw+QXNzaWduIHRvPC9sYWJlbD48c2VsZWN0IGlkPSJmX2Fzc2lnbmVkX3RvIj4KICAgICAgICA8b3B0aW9uIHZhbHVlPSIi' +
  'PuKAlCB1bmFzc2lnbmVkIOKAlDwvb3B0aW9uPiR7b3B0KHVzZXJzLmZpbHRlcih1ID0+IHUuYWN0aXZlKSwgdi5hc3NpZ25lZF90' +
  'bywgdSA9PiB1Lm5hbWUpfTwvc2VsZWN0PjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBl' +
  'cnNvbiAvIGVudGl0eSB0byBzZXJ2ZSAqPC9sYWJlbD48aW5wdXQgaWQ9ImZfcmVjaXBpZW50X25hbWUiIHZhbHVlPSIke2VzYyh2' +
  'LnJlY2lwaWVudF9uYW1lKX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5TZXJ2aWNlIGFkZHJlc3M8L2xh' +
  'YmVsPjxpbnB1dCBpZD0iZl9hZGRyZXNzMSIgcGxhY2Vob2xkZXI9IlN0cmVldCBhZGRyZXNzIiB2YWx1ZT0iJHtlc2Modi5hZGRy' +
  'ZXNzMSl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQgZzMiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkFw' +
  'dCAvIHVuaXQ8L2xhYmVsPjxpbnB1dCBpZD0iZl9hZGRyZXNzMiIgdmFsdWU9IiR7ZXNjKHYuYWRkcmVzczIpfSI+PC9kaXY+CiAg' +
  'ICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q2l0eTwvbGFiZWw+PGlucHV0IGlkPSJmX2NpdHkiIHZhbHVlPSIke2VzYyh2' +
  'LmNpdHkpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U3RhdGUgLyBaSVA8L2xhYmVsPgogICAgICAg' +
  'IDxkaXYgY2xhc3M9InJvdyI+PGlucHV0IGlkPSJmX3N0YXRlIiBzdHlsZT0id2lkdGg6NzBweCIgbWF4bGVuZ3RoPSIyIiB2YWx1' +
  'ZT0iJHtlc2Modi5zdGF0ZSl9Ij4KICAgICAgICA8aW5wdXQgaWQ9ImZfemlwIiBzdHlsZT0iZmxleDoxIiBpbnB1dG1vZGU9Im51' +
  'bWVyaWMiIHZhbHVlPSIke2VzYyh2LnppcCl9Ij48L2Rpdj48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQi' +
  'PjxsYWJlbD5SZWNpcGllbnQgbm90ZXMgKGRlc2NyaXB0aW9uLCB3b3JrIGhvdXJzLCB2ZWhpY2xlLCBnYXRlIGNvZGUpPC9sYWJl' +
  'bD4KICAgICAgPHRleHRhcmVhIGlkPSJmX3JlY2lwaWVudF9ub3RlcyIgc3R5bGU9Im1pbi1oZWlnaHQ6NjBweCI+JHtlc2Modi5y' +
  'ZWNpcGllbnRfbm90ZXMpfTwvdGV4dGFyZWE+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgPGRpdiBjbGFz' +
  'cz0iZmllbGQiPjxsYWJlbD5DYXNlIG51bWJlcjwvbGFiZWw+PGlucHV0IGlkPSJmX2Nhc2VfbnVtYmVyIiB2YWx1ZT0iJHtlc2Mo' +
  'di5jYXNlX251bWJlcil9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Db3VydDwvbGFiZWw+PGlucHV0' +
  'IGlkPSJmX2NvdXJ0IiB2YWx1ZT0iJHtlc2Modi5jb3VydCl9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJl' +
  'bD5QbGFpbnRpZmY8L2xhYmVsPjxpbnB1dCBpZD0iZl9wbGFpbnRpZmYiIHZhbHVlPSIke2VzYyh2LnBsYWludGlmZil9Ij48L2Rp' +
  'dj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5EZWZlbmRhbnQ8L2xhYmVsPjxpbnB1dCBpZD0iZl9kZWZlbmRhbnQi' +
  'IHZhbHVlPSIke2VzYyh2LmRlZmVuZGFudCl9Ij48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJl' +
  'bD5Eb2N1bWVudHMgdG8gc2VydmU8L2xhYmVsPjxpbnB1dCBpZD0iZl9kb2N1bWVudHMiIHBsYWNlaG9sZGVyPSJTdW1tb25zIGFu' +
  'ZCBDb21wbGFpbnQiIHZhbHVlPSIke2VzYyh2LmRvY3VtZW50cyl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQgZzMiPgog' +
  'ICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlNlcnZpY2UgdHlwZTwvbGFiZWw+PHNlbGVjdCBpZD0iZl9zZXJ2aWNlX3R5' +
  'cGUiPgogICAgICAgICR7WydQZXJzb25hbCcsICdTdWJzdGl0dXRlJywgJ1Bvc3RpbmcnLCAnQ2VydGlmaWVkIE1haWwnLCAnQ29y' +
  'cG9yYXRlJ10ubWFwKHMgPT4gYDxvcHRpb24gJHt2LnNlcnZpY2VfdHlwZSA9PT0gcyA/ICdzZWxlY3RlZCcgOiAnJ30+JHtzfTwv' +
  'b3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlByaW9yaXR5' +
  'PC9sYWJlbD48c2VsZWN0IGlkPSJmX3ByaW9yaXR5Ij4KICAgICAgICAke1snUm91dGluZScsICdSdXNoJywgJ1NhbWUgRGF5J10u' +
  'bWFwKHMgPT4gYDxvcHRpb24gJHt2LnByaW9yaXR5ID09PSBzID8gJ3NlbGVjdGVkJyA6ICcnfT4ke3N9PC9vcHRpb24+YCkuam9p' +
  'bignJyl9PC9zZWxlY3Q+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RHVlIGRhdGU8L2xhYmVsPjxpbnB1' +
  'dCBpZD0iZl9kdWVfZGF0ZSIgdHlwZT0iZGF0ZSIgdmFsdWU9IiR7di5kdWVfZGF0ZSA/IFN0cmluZyh2LmR1ZV9kYXRlKS5zbGlj' +
  'ZSgwLCAxMCkgOiAnJ30iPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkIGczIj4KICAgICAgPGRpdiBjbGFz' +
  'cz0iZmllbGQiPjxsYWJlbD5DbGllbnQgZmVlPC9sYWJlbD48aW5wdXQgaWQ9ImZfY2xpZW50X2ZlZSIgdHlwZT0ibnVtYmVyIiBz' +
  'dGVwPSIwLjAxIiB2YWx1ZT0iJHt2LmNsaWVudF9mZWUgfHwgJyd9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxs' +
  'YWJlbD5TZXJ2ZXIgcGF5PC9sYWJlbD48aW5wdXQgaWQ9ImZfc2VydmVyX3BheSIgdHlwZT0ibnVtYmVyIiBzdGVwPSIwLjAxIiB2' +
  'YWx1ZT0iJHt2LnNlcnZlcl9wYXkgfHwgJyd9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5TdGF0dXM8' +
  'L2xhYmVsPjxzZWxlY3QgaWQ9ImZfc3RhdHVzIj4KICAgICAgICAke1snUGVuZGluZycsICdBc3NpZ25lZCcsICdBdHRlbXB0ZWQn' +
  'LCAnU2VydmVkJywgJ05vbi1Fc3QnLCAnT24gSG9sZCcsICdDYW5jZWxsZWQnXS5tYXAocyA9PiBgPG9wdGlvbiAke3Yuc3RhdHVz' +
  'ID09PSBzID8gJ3NlbGVjdGVkJyA6ICcnfT4ke3N9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9kaXY+CiAgICA8L2Rp' +
  'dj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+SW50ZXJuYWwgbm90ZXM8L2xhYmVsPjx0ZXh0YXJlYSBpZD0iZl9ub3Rl' +
  'cyIgc3R5bGU9Im1pbi1oZWlnaHQ6NjBweCI+JHtlc2Modi5ub3Rlcyl9PC90ZXh0YXJlYT48L2Rpdj4KICAgIDxkaXYgY2xhc3M9' +
  'InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6NnB4Ij4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0ic2F2ZSI+JHtqb2IgPyAn' +
  'U2F2ZSBjaGFuZ2VzJyA6ICdDcmVhdGUgam9iJ308L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25jbGlj' +
  'az0iY2xvc2VTaGVldCgpIj5DYW5jZWw8L2J1dHRvbj4KICAgICAgJHtqb2IgPyAnPGJ1dHRvbiBjbGFzcz0iYnRuIGdob3N0IiBp' +
  'ZD0iZGVsIiBzdHlsZT0iY29sb3I6dmFyKC0tYmFkKTttYXJnaW4tbGVmdDphdXRvIj5EZWxldGU8L2J1dHRvbj4nIDogJyd9CiAg' +
  'ICA8L2Rpdj5gLCBlbCA9PiB7CiAgICAvKiAtLS0tIHJlYWQgYSBzdW1tb25zL2NpdGF0aW9uIFBERiBhbmQgZmlsbCB3aGF0IHdl' +
  'IGNhbiAtLS0tICovCiAgICBjb25zdCBwZGZNc2cgPSBlbC5xdWVyeVNlbGVjdG9yKCcjcGRmTXNnJyk7CiAgICBjb25zdCBGSUxM' +
  'QUJMRSA9IFsnY2FzZV9udW1iZXInLCAnY291cnQnLCAncGxhaW50aWZmJywgJ2RlZmVuZGFudCcsICdyZWNpcGllbnRfbmFtZScs' +
  'CiAgICAgICdhZGRyZXNzMScsICdhZGRyZXNzMicsICdjaXR5JywgJ3N0YXRlJywgJ3ppcCcsICdkb2N1bWVudHMnXTsKICAgIGNv' +
  'bnN0IExBQkVMUyA9IHsKICAgICAgY2FzZV9udW1iZXI6ICdjYXNlIG51bWJlcicsIGNvdXJ0OiAnY291cnQnLCBwbGFpbnRpZmY6' +
  'ICdwbGFpbnRpZmYnLCBkZWZlbmRhbnQ6ICdkZWZlbmRhbnQnLAogICAgICByZWNpcGllbnRfbmFtZTogJ3BlcnNvbiB0byBzZXJ2' +
  'ZScsIGFkZHJlc3MxOiAnYWRkcmVzcycsIGFkZHJlc3MyOiAndW5pdCcsIGNpdHk6ICdjaXR5JywKICAgICAgc3RhdGU6ICdzdGF0' +
  'ZScsIHppcDogJ1pJUCcsIGRvY3VtZW50czogJ2RvY3VtZW50cycKICAgIH07CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjZl9wZGYn' +
  'KS5vbmNoYW5nZSA9IGFzeW5jIGUgPT4gewogICAgICBjb25zdCBmaWxlID0gZS50YXJnZXQuZmlsZXMgJiYgZS50YXJnZXQuZmls' +
  'ZXNbMF07CiAgICAgIGlmICghZmlsZSkgcmV0dXJuOwogICAgICBwZGZNc2cuaW5uZXJIVE1MID0gJ1JlYWRpbmcgJyArIGVzYyhm' +
  'aWxlLm5hbWUpICsgJ+KApic7CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IG5ldyBQcm9taXNlKChyZXMs' +
  'IHJlaikgPT4gewogICAgICAgICAgY29uc3QgciA9IG5ldyBGaWxlUmVhZGVyKCk7CiAgICAgICAgICByLm9ubG9hZCA9ICgpID0+' +
  'IHJlcyhTdHJpbmcoci5yZXN1bHQpLnNwbGl0KCcsJylbMV0pOwogICAgICAgICAgci5vbmVycm9yID0gKCkgPT4gcmVqKG5ldyBF' +
  'cnJvcignQ291bGQgbm90IHJlYWQgdGhhdCBmaWxlJykpOwogICAgICAgICAgci5yZWFkQXNEYXRhVVJMKGZpbGUpOwogICAgICAg' +
  'IH0pOwogICAgICAgIGNvbnN0IG91dCA9IGF3YWl0IGFwaSgnL3BhcnNlLWRvY3VtZW50JywgewogICAgICAgICAgbWV0aG9kOiAn' +
  'UE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgbmFtZTogZmlsZS5uYW1lLCBkYXRhIH0pCiAgICAgICAgfSk7CiAgICAgICAg' +
  'aWYgKG91dC53YXJuaW5nKSB7IHBkZk1zZy5pbm5lckhUTUwgPSAnPGIgc3R5bGU9ImNvbG9yOnZhcigtLXdhcm4pIj4nICsgZXNj' +
  'KG91dC53YXJuaW5nKSArICc8L2I+JzsgcmV0dXJuOyB9CiAgICAgICAgY29uc3QgZmlsbGVkID0gW10sIHNraXBwZWQgPSBbXSwg' +
  'bWlzc2VkID0gW107CiAgICAgICAgZm9yIChjb25zdCBmIG9mIEZJTExBQkxFKSB7CiAgICAgICAgICBjb25zdCBpbnB1dCA9IGVs' +
  'LnF1ZXJ5U2VsZWN0b3IoJyNmXycgKyBmKTsKICAgICAgICAgIGlmICghaW5wdXQpIGNvbnRpbnVlOwogICAgICAgICAgY29uc3Qg' +
  'dmFsID0gb3V0LmZpZWxkc1tmXTsKICAgICAgICAgIGlmICghdmFsKSB7IG1pc3NlZC5wdXNoKExBQkVMU1tmXSk7IGNvbnRpbnVl' +
  'OyB9CiAgICAgICAgICBpZiAoaW5wdXQudmFsdWUgJiYgaW5wdXQudmFsdWUudHJpbSgpICYmIGlucHV0LnZhbHVlLnRyaW0oKSAh' +
  'PT0gU3RyaW5nKHZhbCkudHJpbSgpKSB7CiAgICAgICAgICAgIHNraXBwZWQucHVzaChMQUJFTFNbZl0pOwogICAgICAgICAgICBj' +
  'b250aW51ZTsKICAgICAgICAgIH0KICAgICAgICAgIGlucHV0LnZhbHVlID0gdmFsOwogICAgICAgICAgaW5wdXQuc3R5bGUuYmFj' +
  'a2dyb3VuZCA9ICcjZTlmNmVlJzsKICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4geyBpbnB1dC5zdHlsZS5iYWNrZ3JvdW5kID0g' +
  'Jyc7IH0sIDQwMDApOwogICAgICAgICAgZmlsbGVkLnB1c2goTEFCRUxTW2ZdKTsKICAgICAgICB9CiAgICAgICAgbGV0IG1zZzsK' +
  'ICAgICAgICBpZiAoZmlsbGVkLmxlbmd0aCkgewogICAgICAgICAgbXNnID0gJzxiIHN0eWxlPSJjb2xvcjp2YXIoLS1vaykiPkZp' +
  'bGxlZCAnICsgZmlsbGVkLmxlbmd0aCArICcgZmllbGQnICsgKGZpbGxlZC5sZW5ndGggPT09IDEgPyAnJyA6ICdzJykgKwogICAg' +
  'ICAgICAgICAnPC9iPiBmcm9tICcgKyBlc2MoZmlsZS5uYW1lKSArICcgKCcgKyAob3V0LnBhZ2VzIHx8ICc/JykgKyAnIHBhZ2Un' +
  'ICsgKG91dC5wYWdlcyA9PT0gMSA/ICcnIDogJ3MnKSArICcpOiAnICsKICAgICAgICAgICAgZXNjKGZpbGxlZC5qb2luKCcsICcp' +
  'KSArICcuJzsKICAgICAgICB9IGVsc2UgaWYgKHNraXBwZWQubGVuZ3RoKSB7CiAgICAgICAgICBtc2cgPSAnPGIgc3R5bGU9ImNv' +
  'bG9yOnZhcigtLXdhcm4pIj5FdmVyeXRoaW5nIEkgZm91bmQgd2FzIGFscmVhZHkgZmlsbGVkIGluPC9iPiDigJQgbm90aGluZyBv' +
  'ZiB5b3VycyB3YXMgJyArCiAgICAgICAgICAgICdvdmVyd3JpdHRlbi4gQ2xlYXIgYSBmaWVsZCBmaXJzdCBpZiB5b3Ugd2FudCB0' +
  'aGUgZG9jdW1lbnRcJ3MgdmVyc2lvbiBvZiBpdC4nOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBtc2cgPSAnPGIgc3R5bGU9' +
  'ImNvbG9yOnZhcigtLXdhcm4pIj5Ob3RoaW5nIHJlY29nbmlzYWJsZSBmb3VuZDwvYj4gaW4gJyArIGVzYyhmaWxlLm5hbWUpICsK' +
  'ICAgICAgICAgICAgJy4gSXQgbWF5IGJlIGxhaWQgb3V0IGRpZmZlcmVudGx5IHRvIHRoZSBkb2N1bWVudHMgdGhpcyBjYW4gcmVh' +
  'ZCDigJQgZmlsbCB0aGUgam9iIGluIGJ5IGhhbmQuJzsKICAgICAgICB9CiAgICAgICAgaWYgKGZpbGxlZC5sZW5ndGggJiYgc2tp' +
  'cHBlZC5sZW5ndGgpIG1zZyArPSAnIExlZnQgeW91ciBleGlzdGluZyAnICsgZXNjKHNraXBwZWQuam9pbignLCAnKSkgKyAnIGFs' +
  'b25lLic7CiAgICAgICAgaWYgKG1pc3NlZC5sZW5ndGgpIG1zZyArPSAnIE5vdCBmb3VuZDogJyArIGVzYyhtaXNzZWQuam9pbign' +
  'LCAnKSkgKyAnLic7CiAgICAgICAgbXNnICs9ICc8YnI+PGI+Q2hlY2sgZXZlcnkgZmlsbGVkIGZpZWxkIGFnYWluc3QgdGhlIGRv' +
  'Y3VtZW50IGJlZm9yZSBzYXZpbmcuPC9iPic7CiAgICAgICAgcGRmTXNnLmlubmVySFRNTCA9IG1zZzsKICAgICAgfSBjYXRjaCAo' +
  'ZXJyKSB7CiAgICAgICAgcGRmTXNnLmlubmVySFRNTCA9ICc8YiBzdHlsZT0iY29sb3I6dmFyKC0tYmFkKSI+JyArIGVzYyhlcnIu' +
  'bWVzc2FnZSkgKyAnPC9iPic7CiAgICAgIH0KICAgIH07CgogICAgLy8gYXV0by1maWxsIGZlZS9wYXkgZGVmYXVsdHMgZnJvbSB0' +
  'aGUgc2VsZWN0ZWQgY2xpZW50IC8gc2VydmVyCiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjZl9jbGllbnRfaWQnKS5vbmNoYW5nZSA9' +
  'IGUgPT4gewogICAgICBjb25zdCBjID0gY2xpZW50cy5maW5kKHggPT4gU3RyaW5nKHguaWQpID09PSBlLnRhcmdldC52YWx1ZSk7' +
  'CiAgICAgIGlmIChjICYmIGMuZGVmYXVsdF9mZWUgJiYgIWVsLnF1ZXJ5U2VsZWN0b3IoJyNmX2NsaWVudF9mZWUnKS52YWx1ZSkK' +
  'ICAgICAgICBlbC5xdWVyeVNlbGVjdG9yKCcjZl9jbGllbnRfZmVlJykudmFsdWUgPSBOdW1iZXIoYy5kZWZhdWx0X2ZlZSkudG9G' +
  'aXhlZCgyKTsKICAgIH07CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjZl9hc3NpZ25lZF90bycpLm9uY2hhbmdlID0gZSA9PiB7CiAg' +
  'ICAgIGNvbnN0IHUgPSB1c2Vycy5maW5kKHggPT4gU3RyaW5nKHguaWQpID09PSBlLnRhcmdldC52YWx1ZSk7CiAgICAgIGlmICh1' +
  'ICYmIHUuZGVmYXVsdF9wYXkgJiYgIWVsLnF1ZXJ5U2VsZWN0b3IoJyNmX3NlcnZlcl9wYXknKS52YWx1ZSkKICAgICAgICBlbC5x' +
  'dWVyeVNlbGVjdG9yKCcjZl9zZXJ2ZXJfcGF5JykudmFsdWUgPSBOdW1iZXIodS5kZWZhdWx0X3BheSkudG9GaXhlZCgyKTsKICAg' +
  'IH07CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IGJvZHkg' +
  'PSB7fTsKICAgICAgWydjbGllbnRfaWQnLCdhc3NpZ25lZF90bycsJ3JlY2lwaWVudF9uYW1lJywnYWRkcmVzczEnLCdhZGRyZXNz' +
  'MicsJ2NpdHknLCdzdGF0ZScsJ3ppcCcsJ3JlY2lwaWVudF9ub3RlcycsCiAgICAgICAnY2FzZV9udW1iZXInLCdjb3VydCcsJ3Bs' +
  'YWludGlmZicsJ2RlZmVuZGFudCcsJ2RvY3VtZW50cycsJ3NlcnZpY2VfdHlwZScsJ3ByaW9yaXR5JywnZHVlX2RhdGUnLAogICAg' +
  'ICAgJ2NsaWVudF9mZWUnLCdzZXJ2ZXJfcGF5Jywnc3RhdHVzJywnbm90ZXMnXS5mb3JFYWNoKGYgPT4geyBib2R5W2ZdID0gZWwu' +
  'cXVlcnlTZWxlY3RvcignI2ZfJyArIGYpLnZhbHVlOyB9KTsKICAgICAgaWYgKCFib2R5LnJlY2lwaWVudF9uYW1lLnRyaW0oKSkg' +
  'cmV0dXJuIHRvYXN0KCdXaG8gYXJlIHdlIHNlcnZpbmc/JywgdHJ1ZSk7CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3Qgc2F2ZWQg' +
  'PSBqb2IKICAgICAgICAgID8gYXdhaXQgYXBpKCcvam9icy8nICsgam9iLmlkLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNP' +
  'Ti5zdHJpbmdpZnkoYm9keSkgfSkKICAgICAgICAgIDogYXdhaXQgYXBpKCcvam9icycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6' +
  'IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pOwogICAgICAgIGNsb3NlU2hlZXQoKTsgdG9hc3Qoam9iID8gJ1NhdmVkJyA6ICdKb2Ig' +
  'JyArIHNhdmVkLmpvYl9udW1iZXIgKyAnIGNyZWF0ZWQnKTsKICAgICAgICBnbygnam9iJywgeyBpZDogc2F2ZWQuaWQgfSk7CiAg' +
  'ICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogICAgfTsKICAgIGlmIChlbC5xdWVyeVNlbGVjdG9y' +
  'KCcjZGVsJykpIGVsLnF1ZXJ5U2VsZWN0b3IoJyNkZWwnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBpZiAoIWNvbmZp' +
  'cm0oJ0RlbGV0ZSB0aGlzIGpvYiBhbmQgYWxsIGl0cyBhdHRlbXB0cz8nKSkgcmV0dXJuOwogICAgICBhd2FpdCBhcGkoJy9qb2Jz' +
  'LycgKyBqb2IuaWQsIHsgbWV0aG9kOiAnREVMRVRFJyB9KTsKICAgICAgY2xvc2VTaGVldCgpOyB0b2FzdCgnRGVsZXRlZCcpOyBn' +
  'bygnam9icycpOwogICAgfTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLSBqb2IgZGV0YWlsIC0tICovCmFzeW5jIGZ1bmN0aW9uIGpvYlZpZXcoKSB7CiAgY29uc3QgaiA9IGF3YWl0' +
  'IGFwaSgnL2pvYnMvJyArIFMucGFyYW1zLmlkKTsKICBjb25zdCBhZGRyID0gYWRkck9mKGopOwogIGNvbnN0IGRvbmUgPSBbJ1Nl' +
  'cnZlZCcsICdOb24tRXN0JywgJ0NhbmNlbGxlZCddLmluY2x1ZGVzKGouc3RhdHVzKTsKCiAgYXBwLmlubmVySFRNTCA9IHNoZWxs' +
  'KGAKICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi1ib3R0b206OHB4Ij4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRu' +
  'IGdob3N0IiBpZD0iYmFjayI+4oC5IEJhY2s8L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0ic3BhY2VyIiBzdHlsZT0iZmxleDox' +
  'Ij48L2Rpdj4KICAgICAgPHNwYW4gY2xhc3M9InBpbGwgJHtjbHMoai5zdGF0dXMpfSI+JHtlc2Moai5zdGF0dXMpfTwvc3Bhbj4K' +
  'ICAgICAgJHtqLnByaW9yaXR5ICE9PSAnUm91dGluZScgPyBgPHNwYW4gY2xhc3M9InBpbGwgcnVzaCI+JHtlc2Moai5wcmlvcml0' +
  'eSl9PC9zcGFuPmAgOiAnJ30KICAgIDwvZGl2PgogICAgPGgxIGNsYXNzPSJwYWdlIiBzdHlsZT0ibWFyZ2luLXRvcDowIj4ke2Vz' +
  'YyhqLnJlY2lwaWVudF9uYW1lKX08L2gxPgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJtIiBzdHls' +
  'ZT0iY29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxM3B4O21hcmdpbi1ib3R0b206OHB4Ij4ke2VzYyhqLmpvYl9udW1iZXIp' +
  'fSDCtyAke2VzYyhqLmNsaWVudF9uYW1lIHx8ICdObyBjbGllbnQnKX08L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0iZm9udC1zaXpl' +
  'OjE1cHg7Zm9udC13ZWlnaHQ6NjAwIj4ke2VzYyhhZGRyIHx8ICdObyBhZGRyZXNzIG9uIGZpbGUnKX08L2Rpdj4KICAgICAgJHtq' +
  'LnJlY2lwaWVudF9ub3RlcyA/IGA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDo2cHgiPiR7ZXNjKGoucmVjaXBp' +
  'ZW50X25vdGVzKX08L2Rpdj5gIDogJyd9CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+CiAg' +
  'ICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIG5hdiIgaWQ9Im5hdkJ0biIgJHthZGRyID8gJycgOiAnZGlzYWJsZWQnfT5OYXZpZ2F0' +
  'ZSDilrg8L2J1dHRvbj4KICAgICAgICAkeyFkb25lID8gJzxidXR0b24gY2xhc3M9ImJ0biBvayIgaWQ9ImF0dEJ0biI+TG9nIGF0' +
  'dGVtcHQ8L2J1dHRvbj4nIDogJyd9CiAgICAgIDwvZGl2PgogICAgICAke2FkZHIgPyBgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9' +
  'Im1hcmdpbi10b3A6OHB4Ij5PcGVucyAke2lzSU9TKCkgPyAnQXBwbGUgTWFwcycgOiAnR29vZ2xlIE1hcHMnfSDCtwogICAgICAg' +
  'IDxhIGhyZWY9IiR7aXNJT1MoKSA/IGdvb2dsZVVybChhZGRyKSA6IGFwcGxlVXJsKGFkZHIpfSIgdGFyZ2V0PSJfYmxhbmsiPnVz' +
  'ZSAke2lzSU9TKCkgPyAnR29vZ2xlJyA6ICdBcHBsZSd9IE1hcHMgaW5zdGVhZDwvYT48L2Rpdj5gIDogJyd9CiAgICA8L2Rpdj4K' +
  'CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkF0dGVtcHRzIDxzcGFuIGNsYXNzPSJzdWIiPiR7ai5hdHRlbXB0cy5s' +
  'ZW5ndGh9PC9zcGFuPjwvaDI+CiAgICAgICR7ai5hdHRlbXB0cy5sZW5ndGggPyBqLmF0dGVtcHRzLm1hcChhID0+IGAKICAgICAg' +
  'ICA8ZGl2IGNsYXNzPSJhdHQgJHtjbHMoYS5vdXRjb21lKX0iPgogICAgICAgICAgPGRpdiBjbGFzcz0iaCI+JHtlc2MoYS5vdXRj' +
  'b21lKX0ke2EubWFubmVyID8gJyDigJQgJyArIGVzYyhhLm1hbm5lcikgOiAnJ308L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9' +
  'Im0iPiR7Zm10RFQoYS5hdHRlbXB0ZWRfYXQpfSDCtyAke2VzYyhhLnNlcnZlcl9uYW1lIHx8ICcnKX08L2Rpdj4KICAgICAgICAg' +
  'ICR7YS5wZXJzb25fc2VydmVkID8gYDxkaXYgY2xhc3M9Im0iPlNlcnZlZDogJHtlc2MoYS5wZXJzb25fc2VydmVkKX0ke2EucmVs' +
  'YXRpb25zaGlwID8gJyAoJyArIGVzYyhhLnJlbGF0aW9uc2hpcCkgKyAnKScgOiAnJ308L2Rpdj5gIDogJyd9CiAgICAgICAgICAk' +
  'e2EuZGVzY3JpcHRpb24gPyBgPGRpdiBjbGFzcz0ibSI+RGVzY3JpcHRpb246ICR7ZXNjKGEuZGVzY3JpcHRpb24pfTwvZGl2PmAg' +
  'OiAnJ30KICAgICAgICAgICR7YS5ub3RlcyA/IGA8ZGl2IGNsYXNzPSJtIj4ke2VzYyhhLm5vdGVzKX08L2Rpdj5gIDogJyd9CiAg' +
  'ICAgICAgICAke2EubGF0ICE9IG51bGwgPyBgPGRpdiBjbGFzcz0ibSI+R1BTICR7TnVtYmVyKGEubGF0KS50b0ZpeGVkKDUpfSwg' +
  'JHtOdW1iZXIoYS5sbmcpLnRvRml4ZWQoNSl9CiAgICAgICAgICAgICR7YS5hY2N1cmFjeV9tID8gJ8KxJyArIE1hdGgucm91bmQo' +
  'YS5hY2N1cmFjeV9tKSArICdtJyA6ICcnfSDCtwogICAgICAgICAgICA8YSBocmVmPSJodHRwczovL3d3dy5nb29nbGUuY29tL21h' +
  'cHM/cT0ke2EubGF0fSwke2EubG5nfSIgdGFyZ2V0PSJfYmxhbmsiPm1hcDwvYT48L2Rpdj5gIDogJyd9CiAgICAgICAgPC9kaXY+' +
  'YCkuam9pbignJykKICAgICAgICA6ICc8ZGl2IGNsYXNzPSJlbXB0eSI+Tm8gYXR0ZW1wdHMgbG9nZ2VkIHlldC48L2Rpdj4nfQog' +
  'ICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5QYXBlcndvcms8L2gyPgogICAgICA8ZGl2IGNsYXNz' +
  'PSJyb3ciPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJhZmZCdG4iPkFmZmlkYXZpdDwvYnV0dG9uPgog' +
  'ICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJjb3ZlckJ0biI+Q292ZXIgc2hlZXQgKyBiYXJjb2RlPC9idXR0' +
  'b24+CiAgICAgICAgJHtqLmNhc2VfbnVtYmVyID8gJzxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJsb29rdXBCdG4iPkxv' +
  'b2sgdXAgY2FzZTwvYnV0dG9uPicgOiAnJ30KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9InRleHQtYWxpZ246Y2VudGVy' +
  'O21hcmdpbi10b3A6MTRweCI+CiAgICAgICAgPGltZyBzcmM9Ii9iYXJjb2RlLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGouam9iX251' +
  'bWJlcil9LnN2ZyIgYWx0PSJiYXJjb2RlIiBzdHlsZT0ibWF4LXdpZHRoOjEwMCUiPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoK' +
  'ICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+Q2FzZSBkZXRhaWw8L2gyPgogICAgICA8dGFibGUgY2xhc3M9InRibCI+' +
  'CiAgICAgICAgJHtbWydDYXNlJywgai5jYXNlX251bWJlcl0sIFsnQ291cnQnLCBqLmNvdXJ0XSwgWydQbGFpbnRpZmYnLCBqLnBs' +
  'YWludGlmZl0sIFsnRGVmZW5kYW50Jywgai5kZWZlbmRhbnRdLAogICAgICAgICAgIFsnRG9jdW1lbnRzJywgai5kb2N1bWVudHNd' +
  'LCBbJ1NlcnZpY2UgdHlwZScsIGouc2VydmljZV90eXBlXSwgWydEdWUnLCBmbXREYXRlT25seShqLmR1ZV9kYXRlKV0sCiAgICAg' +
  'ICAgICAgWydBc3NpZ25lZCB0bycsIGouc2VydmVyX25hbWVdLCBbJ0NsaWVudCBmZWUnLCBqLmNsaWVudF9mZWUgPyBtb25leShq' +
  'LmNsaWVudF9mZWUpIDogJyddLAogICAgICAgICAgIFsnU2VydmVyIHBheScsIGouc2VydmVyX3BheSA/IG1vbmV5KGouc2VydmVy' +
  'X3BheSkgOiAnJ10sCiAgICAgICAgICAgWydTZXJ2ZWQnLCBqLnNlcnZlZF9hdCA/IGZtdERUKGouc2VydmVkX2F0KSArICcg4oCU' +
  'ICcgKyBlc2Moai5zZXJ2ZWRfbWFubmVyIHx8ICcnKSA6ICcnXSwKICAgICAgICAgICBbJ05vdGVzJywgai5ub3Rlc11dCiAgICAg' +
  'ICAgICAuZmlsdGVyKHIgPT4gclsxXSkubWFwKHIgPT4gYDx0cj48dGggc3R5bGU9IndpZHRoOjM0JSI+JHtyWzBdfTwvdGg+PHRk' +
  'PiR7ZXNjKHJbMV0pfTwvdGQ+PC90cj5gKS5qb2luKCcnKX0KICAgICAgPC90YWJsZT4KICAgICAgJHtpc0FkbWluKCkgPyAnPGJ1' +
  'dHRvbiBjbGFzcz0iYnRuIHNlYyBibG9jayBzbSIgaWQ9ImVkaXRCdG4iIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPkVkaXQgam9i' +
  'PC9idXR0b24+JyA6ICcnfQogICAgPC9kaXY+YCk7CiAgYmluZFNoZWxsKCk7CiAgJCgnI2JhY2snKS5vbmNsaWNrID0gKCkgPT4g' +
  'Z28oJ2pvYnMnLCBTLmNhY2hlLmpvYkZpbHRlciB8fCB7fSk7CiAgaWYgKCQoJyNuYXZCdG4nKSkgJCgnI25hdkJ0bicpLm9uY2xp' +
  'Y2sgPSAoKSA9PiB3aW5kb3cub3BlbihuYXZVcmwoYWRkciksICdfYmxhbmsnKTsKICBpZiAoJCgnI2F0dEJ0bicpKSAkKCcjYXR0' +
  'QnRuJykub25jbGljayA9ICgpID0+IGF0dGVtcHRGb3JtKGopOwogIGlmICgkKCcjZWRpdEJ0bicpKSAkKCcjZWRpdEJ0bicpLm9u' +
  'Y2xpY2sgPSAoKSA9PiBqb2JGb3JtKGopOwogICQoJyNjb3ZlckJ0bicpLm9uY2xpY2sgPSAoKSA9PiB3aW5kb3cub3BlbignL3By' +
  'aW50L2NvdmVyc2hlZXQvJyArIGouaWQsICdfYmxhbmsnKTsKICAkKCcjYWZmQnRuJykub25jbGljayA9ICgpID0+IGFmZmlkYXZp' +
  'dFNoZWV0KGopOwogIGlmICgkKCcjbG9va3VwQnRuJykpICQoJyNsb29rdXBCdG4nKS5vbmNsaWNrID0gKCkgPT4gY2FzZUxvb2t1' +
  'cFNoZWV0KGopOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGxv' +
  'ZyBhdHRlbXB0IC0tICovCmNvbnN0IE9VVENPTUVTID0gWydTZXJ2ZWQnLCAnTm8gQW5zd2VyJywgJ0JhZCBBZGRyZXNzJywgJ01v' +
  'dmVkJywgJ1JlZnVzZWQnLCAnRXZhZGluZycsICdPdGhlciddOwoKZnVuY3Rpb24gYXR0ZW1wdEZvcm0oam9iKSB7CiAgc2hlZXQo' +
  'J0xvZyBhdHRlbXB0IOKAlCAnICsgam9iLnJlY2lwaWVudF9uYW1lLCBgCiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk91' +
  'dGNvbWU8L2xhYmVsPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIGlkPSJvdXRjb21lcyI+JHtPVVRDT01FUy5tYXAobyA9PgogICAg' +
  'ICAgIGA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBkYXRhLW89IiR7b30iPiR7b308L2J1dHRvbj5gKS5qb2luKCcnKX08L2Rp' +
  'dj48L2Rpdj4KICAgIDxkaXYgaWQ9InNlcnZlZEZpZWxkcyIgc3R5bGU9ImRpc3BsYXk6bm9uZSI+CiAgICAgIDxkaXYgY2xhc3M9' +
  'ImdyaWQgZzIiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+TWFubmVyPC9sYWJlbD48c2VsZWN0IGlkPSJhX21h' +
  'bm5lciI+CiAgICAgICAgICAke1snUGVyc29uYWwnLCAnU3Vic3RpdHV0ZScsICdQb3N0ZWQnLCAnQ29ycG9yYXRlJywgJ0NlcnRp' +
  'ZmllZCBNYWlsJ10ubWFwKHMgPT4gYDxvcHRpb24+JHtzfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAg' +
  'ICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGVyc29uIHNlcnZlZDwvbGFiZWw+PGlucHV0IGlkPSJhX3BlcnNvbl9zZXJ2' +
  'ZWQiIHZhbHVlPSIke2VzYyhqb2IucmVjaXBpZW50X25hbWUpfSI+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNz' +
  'PSJncmlkIGcyIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlJlbGF0aW9uc2hpcCAoaWYgc3Vic3RpdHV0ZSk8' +
  'L2xhYmVsPjxpbnB1dCBpZD0iYV9yZWxhdGlvbnNoaXAiIHBsYWNlaG9sZGVyPSJjby1yZXNpZGVudCwgY28td29ya2VyLi4uIj48' +
  'L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkRlc2NyaXB0aW9uPC9sYWJlbD48aW5wdXQgaWQ9ImFfZGVz' +
  'Y3JpcHRpb24iIHBsYWNlaG9sZGVyPSJXL0YsIDQwcywgNSc2JnF1b3Q7LCBicm93biBoYWlyIj48L2Rpdj4KICAgICAgPC9kaXY+' +
  'CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Tm90ZXM8L2xhYmVsPjx0ZXh0YXJlYSBpZD0iYV9ub3Rl' +
  'cyIgcGxhY2Vob2xkZXI9IkxpZ2h0cyBvbiwgbm8gYW5zd2VyIGF0IGZyb250IGRvb3IuIFNpbHZlciBDaXZpYyBpbiBkcml2ZXdh' +
  'eS4iPjwvdGV4dGFyZWE+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPldoZW48L2xhYmVsPjxpbnB1dCBpZD0i' +
  'YV93aGVuIiB0eXBlPSJkYXRldGltZS1sb2NhbCIgdmFsdWU9IiR7bG9jYWxOb3coKX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0i' +
  'Y2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6I2Y4ZmFmYztib3gtc2hhZG93Om5vbmU7bWFyZ2luLWJvdHRvbToxMnB4Ij4KICAgICAg' +
  'PGRpdiBjbGFzcz0icm93Ij48YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0iZ3BzQnRuIj5DYXB0dXJlIEdQUzwvYnV0dG9u' +
  'PgogICAgICA8c3BhbiBjbGFzcz0iaGludCIgaWQ9Imdwc091dCIgc3R5bGU9Im1hcmdpbjowIj5Ob3QgY2FwdHVyZWQ8L3NwYW4+' +
  'PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InJvdyI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InNhdmVB' +
  'dHQiIGRpc2FibGVkPlBpY2sgYW4gb3V0Y29tZTwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNr' +
  'PSJjbG9zZVNoZWV0KCkiPkNhbmNlbDwvYnV0dG9uPgogICAgPC9kaXY+YCwgZWwgPT4gewogICAgbGV0IG91dGNvbWUgPSBudWxs' +
  'LCBncHMgPSBudWxsOwogICAgZWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtb10nKS5mb3JFYWNoKGIgPT4gYi5vbmNsaWNrID0g' +
  'KCkgPT4gewogICAgICBvdXRjb21lID0gYi5kYXRhc2V0Lm87CiAgICAgIGVsLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLW9dJyku' +
  'Zm9yRWFjaCh4ID0+IHsgeC5jbGFzc05hbWUgPSAnYnRuIHNlYyBzbSc7IH0pOwogICAgICBiLmNsYXNzTmFtZSA9ICdidG4gc20n' +
  'ICsgKG91dGNvbWUgPT09ICdTZXJ2ZWQnID8gJyBvaycgOiAnJyk7CiAgICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNzZXJ2ZWRGaWVs' +
  'ZHMnKS5zdHlsZS5kaXNwbGF5ID0gb3V0Y29tZSA9PT0gJ1NlcnZlZCcgPyAnJyA6ICdub25lJzsKICAgICAgY29uc3QgcyA9IGVs' +
  'LnF1ZXJ5U2VsZWN0b3IoJyNzYXZlQXR0Jyk7CiAgICAgIHMuZGlzYWJsZWQgPSBmYWxzZTsKICAgICAgcy50ZXh0Q29udGVudCA9' +
  'IG91dGNvbWUgPT09ICdTZXJ2ZWQnID8gJ1NhdmUg4oCUIG1hcmtzIGpvYiBTRVJWRUQnIDogJ1NhdmUgYXR0ZW1wdCc7CiAgICB9' +
  'KTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNncHNCdG4nKS5vbmNsaWNrID0gKCkgPT4gewogICAgICBjb25zdCBvdXQgPSBlbC5x' +
  'dWVyeVNlbGVjdG9yKCcjZ3BzT3V0Jyk7CiAgICAgIGlmICghbmF2aWdhdG9yLmdlb2xvY2F0aW9uKSByZXR1cm4gb3V0LnRleHRD' +
  'b250ZW50ID0gJ05vdCBzdXBwb3J0ZWQgb24gdGhpcyBkZXZpY2UnOwogICAgICBvdXQudGV4dENvbnRlbnQgPSAnTG9jYXRpbmfi' +
  'gKYnOwogICAgICBuYXZpZ2F0b3IuZ2VvbG9jYXRpb24uZ2V0Q3VycmVudFBvc2l0aW9uKHBvcyA9PiB7CiAgICAgICAgZ3BzID0g' +
  'eyBsYXQ6IHBvcy5jb29yZHMubGF0aXR1ZGUsIGxuZzogcG9zLmNvb3Jkcy5sb25naXR1ZGUsIGFjY3VyYWN5X206IHBvcy5jb29y' +
  'ZHMuYWNjdXJhY3kgfTsKICAgICAgICBvdXQuaW5uZXJIVE1MID0gYDxiIHN0eWxlPSJjb2xvcjp2YXIoLS1vaykiPuKckyAke2dw' +
  'cy5sYXQudG9GaXhlZCg1KX0sICR7Z3BzLmxuZy50b0ZpeGVkKDUpfTwvYj4gwrEke01hdGgucm91bmQoZ3BzLmFjY3VyYWN5X20p' +
  'fW1gOwogICAgICB9LCBlcnIgPT4geyBvdXQudGV4dENvbnRlbnQgPSAnRmFpbGVkOiAnICsgZXJyLm1lc3NhZ2U7IH0sCiAgICAg' +
  'ICAgeyBlbmFibGVIaWdoQWNjdXJhY3k6IHRydWUsIHRpbWVvdXQ6IDE1MDAwLCBtYXhpbXVtQWdlOiAwIH0pOwogICAgfTsKICAg' +
  'IC8vIGF1dG8tY2FwdHVyZSBvbiBvcGVuIOKAlCB0aGUgYWZmaWRhdml0IGlzIHN0cm9uZ2VyIHdoZW4gZXZlcnkgYXR0ZW1wdCBo' +
  'YXMgY29vcmRpbmF0ZXMKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNncHNCdG4nKS5jbGljaygpOwoKICAgIGVsLnF1ZXJ5U2VsZWN0' +
  'b3IoJyNzYXZlQXR0Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgYm9keSA9IE9iamVjdC5hc3NpZ24oewog' +
  'ICAgICAgIG91dGNvbWUsCiAgICAgICAgYXR0ZW1wdGVkX2F0OiBlbC5xdWVyeVNlbGVjdG9yKCcjYV93aGVuJykudmFsdWUgfHwg' +
  'bnVsbCwKICAgICAgICBub3RlczogZWwucXVlcnlTZWxlY3RvcignI2Ffbm90ZXMnKS52YWx1ZQogICAgICB9LCBncHMgfHwge30p' +
  'OwogICAgICBpZiAob3V0Y29tZSA9PT0gJ1NlcnZlZCcpIHsKICAgICAgICBib2R5Lm1hbm5lciA9IGVsLnF1ZXJ5U2VsZWN0b3Io' +
  'JyNhX21hbm5lcicpLnZhbHVlOwogICAgICAgIGJvZHkucGVyc29uX3NlcnZlZCA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNhX3BlcnNv' +
  'bl9zZXJ2ZWQnKS52YWx1ZTsKICAgICAgICBib2R5LnJlbGF0aW9uc2hpcCA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNhX3JlbGF0aW9u' +
  'c2hpcCcpLnZhbHVlOwogICAgICAgIGJvZHkuZGVzY3JpcHRpb24gPSBlbC5xdWVyeVNlbGVjdG9yKCcjYV9kZXNjcmlwdGlvbicp' +
  'LnZhbHVlOwogICAgICB9CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgYXBpKCcvam9icy8nICsgam9iLmlkICsgJy9hdHRlbXB0' +
  'cycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pOwogICAgICAgIGNsb3NlU2hlZXQoKTsg' +
  'dG9hc3Qob3V0Y29tZSA9PT0gJ1NlcnZlZCcgPyAnU2VydmVkIOKAlCBqb2IgY2xvc2VkIG91dCcgOiAnQXR0ZW1wdCBsb2dnZWQn' +
  'KTsKICAgICAgICBnbygnam9iJywgeyBpZDogam9iLmlkIH0pOwogICAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwg' +
  'dHJ1ZSk7IH0KICAgIH07CiAgfSk7Cn0KCmZ1bmN0aW9uIGxvY2FsTm93KCkgewogIGNvbnN0IGQgPSBuZXcgRGF0ZShEYXRlLm5v' +
  'dygpIC0gbmV3IERhdGUoKS5nZXRUaW1lem9uZU9mZnNldCgpICogNjAwMDApOwogIHJldHVybiBkLnRvSVNPU3RyaW5nKCkuc2xp' +
  'Y2UoMCwgMTYpOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'IGFmZmlkYXZpdCAtLSAqLwphc3luYyBmdW5jdGlvbiBhZmZpZGF2aXRTaGVldChqb2IpIHsKICBjb25zdCB0ZW1wbGF0ZXMgPSBh' +
  'd2FpdCBhcGkoJy90ZW1wbGF0ZXMnKTsKICBjb25zdCBsb2FkID0gYXN5bmMgaWQgPT4gewogICAgY29uc3QgciA9IGF3YWl0IGFw' +
  'aSgnL2pvYnMvJyArIGpvYi5pZCArICcvYWZmaWRhdml0JyArIChpZCA/ICc/dGVtcGxhdGVfaWQ9JyArIGlkIDogJycpKTsKICAg' +
  'IHJldHVybiByOwogIH07CiAgY29uc3QgZmlyc3QgPSBhd2FpdCBsb2FkKCk7CiAgc2hlZXQoJ0FmZmlkYXZpdCDigJQgJyArIGpv' +
  'Yi5qb2JfbnVtYmVyLCBgCiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlRlbXBsYXRlPC9sYWJlbD48c2VsZWN0IGlkPSJ0' +
  'cGwiPgogICAgICAke3RlbXBsYXRlcy5tYXAodCA9PiBgPG9wdGlvbiB2YWx1ZT0iJHt0LmlkfSIgJHt0LmlkID09PSBmaXJzdC50' +
  'ZW1wbGF0ZV9pZCA/ICdzZWxlY3RlZCcgOiAnJ30+JHtlc2ModC5uYW1lKX0ke3QuanVyaXNkaWN0aW9uID8gJyDigJQgJyArIGVz' +
  'Yyh0Lmp1cmlzZGljdGlvbikgOiAnJ308L29wdGlvbj5gKS5qb2luKCcnKX0KICAgIDwvc2VsZWN0PjwvZGl2PgogICAgPHByZSBj' +
  'bGFzcz0icHJldiIgaWQ9InByZXYiPiR7ZXNjKGZpcnN0LnRleHQpfTwvcHJlPgogICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0i' +
  'bWFyZ2luLXRvcDoxMnB4Ij4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0icHJpbnRBZmYiPlByaW50IC8gc2F2ZSBQREY8' +
  'L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgaWQ9ImNvcHlBZmYiPkNvcHkgdGV4dDwvYnV0dG9uPgogICAg' +
  'ICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNsb3NlPC9idXR0b24+CiAgICA8L2Rpdj5g' +
  'LCBlbCA9PiB7CiAgICBjb25zdCBzZWwgPSBlbC5xdWVyeVNlbGVjdG9yKCcjdHBsJyk7CiAgICBzZWwub25jaGFuZ2UgPSBhc3lu' +
  'YyAoKSA9PiB7IGVsLnF1ZXJ5U2VsZWN0b3IoJyNwcmV2JykudGV4dENvbnRlbnQgPSAoYXdhaXQgbG9hZChzZWwudmFsdWUpKS50' +
  'ZXh0OyB9OwogICAgZWwucXVlcnlTZWxlY3RvcignI3ByaW50QWZmJykub25jbGljayA9ICgpID0+CiAgICAgIHdpbmRvdy5vcGVu' +
  'KCcvcHJpbnQvYWZmaWRhdml0LycgKyBqb2IuaWQgKyAnP3RlbXBsYXRlX2lkPScgKyBzZWwudmFsdWUsICdfYmxhbmsnKTsKICAg' +
  'IGVsLnF1ZXJ5U2VsZWN0b3IoJyNjb3B5QWZmJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgYXdhaXQgbmF2aWdhdG9y' +
  'LmNsaXBib2FyZC53cml0ZVRleHQoZWwucXVlcnlTZWxlY3RvcignI3ByZXYnKS50ZXh0Q29udGVudCk7CiAgICAgIHRvYXN0KCdD' +
  'b3BpZWQnKTsKICAgIH07CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tIHRvb2xzIC0tLSAqLwovKiBMYWJlbCBtYWtlci4gVGhlIHBvaW50IG9mIHRoZSBzaGVldCBncmlkIGlzIHRo' +
  'YXQgbGFiZWwgc2hlZXRzIGFyZSBleHBlbnNpdmUKICAgYW5kIHJhcmVseSB1c2VkIHVwIGluIG9uZSBnbzogbWFyayB3aGljaCBv' +
  'bmVzIHlvdSd2ZSBhbHJlYWR5IHBlZWxlZCBvZmYgYW5kCiAgIHRoZSBwcmludGVyIHNraXBzIHRoZW0sIHNvIGEgcGFydC11c2Vk' +
  'IHNoZWV0IGdvZXMgYmFjayBpbiBhbmQgY2FycmllcyBvbi4gKi8KYXN5bmMgZnVuY3Rpb24gdG9vbHNWaWV3KCkgewogIGNvbnN0' +
  'IFtsYXlvdXRzLCBpbml0U2hlZXQsIGpvYnNdID0gYXdhaXQgUHJvbWlzZS5hbGwoWwogICAgYXBpKCcvbGFiZWwtbGF5b3V0cycp' +
  'LCBhcGkoJy9sYWJlbC1zaGVldCcpLCBhcGkoJy9qb2JzP29wZW49MScpCiAgXSk7CiAgUy5jYWNoZS5zaGVldCA9IGluaXRTaGVl' +
  'dDsKICBTLmNhY2hlLnBpY2tlZCA9IFMuY2FjaGUucGlja2VkIHx8IFtdOwoKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAg' +
  'PGgxIGNsYXNzPSJwYWdlIj5Ub29sczwvaDE+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5MYWJlbCBtYWtlciA8' +
  'c3BhbiBjbGFzcz0ic3ViIj5wcmludHMgb25seSB0aGUgbGFiZWxzIHlvdSBoYXZlbid0IHVzZWQ8L3NwYW4+PC9oMj4KCiAgICAg' +
  'IDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+TGFiZWwgc2hlZXQ8L2xhYmVsPgogICAgICAgIDxzZWxlY3QgaWQ9ImxheW91dCI+' +
  'CiAgICAgICAgICAke2xheW91dHMubWFwKGwgPT4gYDxvcHRpb24gdmFsdWU9IiR7bC5rZXl9IiAke2wua2V5ID09PSBpbml0U2hl' +
  'ZXQubGF5b3V0ID8gJ3NlbGVjdGVkJyA6ICcnfT4KICAgICAgICAgICAgJHtlc2MobC5uYW1lKX0g4oCUICR7ZXNjKGwuc2l6ZSl9' +
  'PC9vcHRpb24+YCkuam9pbignJyl9CiAgICAgICAgPC9zZWxlY3Q+CiAgICAgICAgPGRpdiBjbGFzcz0iaGludCI+T2ZmaWNlIERl' +
  'cG90IHNoZWV0cyBwcmludCBhbiBBdmVyeSBlcXVpdmFsZW50IG51bWJlciBvbiB0aGUgcGFja2FnZSBmcm9udCDigJQKICAgICAg' +
  'ICAgIG1hdGNoIHRoYXQuIENoYW5naW5nIHRoZSBzaGVldCBjbGVhcnMgdGhlIHVzZWQgbWFya3MsIHNpbmNlIHBvc2l0aW9uIDcg' +
  'b24gYSAzMC11cCBzaGVldAogICAgICAgICAgaXNuJ3QgcG9zaXRpb24gNyBvbiBhIDEwLXVwIG9uZS48L2Rpdj4KICAgICAgPC9k' +
  'aXY+CgogICAgICA8bGFiZWw+V2hpY2ggbGFiZWxzIGFyZSBhbHJlYWR5IGdvbmU/PC9sYWJlbD4KICAgICAgPGRpdiBjbGFzcz0i' +
  'aGludCIgc3R5bGU9Im1hcmdpbi1ib3R0b206OHB4Ij5UYXAgdGhlIG9uZXMgYWxyZWFkeSBwZWVsZWQgb2ZmLiBHcmV5ID0gdXNl' +
  'ZCBhbmQgc2tpcHBlZC4KICAgICAgICBOdW1iZXJlZCBncmVlbiA9IHdoZXJlIHlvdXIgbmV4dCBsYWJlbHMgd2lsbCBsYW5kLCBp' +
  'biBvcmRlci48L2Rpdj4KICAgICAgPGRpdiBpZD0iZ3JpZCI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1h' +
  'cmdpbi10b3A6MTBweCI+CiAgICAgICAgPHNwYW4gY2xhc3M9InBpbGwiIGlkPSJmcmVlQ291bnQiPjwvc3Bhbj4KICAgICAgICA8' +
  'YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0ibmV3U2hlZXQiPkZyZXNoIHNoZWV0PC9idXR0b24+CiAgICAgICAgPGJ1dHRv' +
  'biBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9ImFsbFVzZWQiPk1hcmsgYWxsIHVzZWQ8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8' +
  'L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPldobyB0byBwcmludCA8c3BhbiBjbGFzcz0ic3ViIiBpZD0i' +
  'cGlja0NvdW50Ij48L3NwYW4+PC9oMj4KICAgICAgPGlucHV0IGlkPSJqb2JGaWx0ZXIiIHBsYWNlaG9sZGVyPSJGaWx0ZXIgYnkg' +
  'bmFtZSwgY2l0eSBvciBqb2IgbnVtYmVyIiBzdHlsZT0ibWFyZ2luLWJvdHRvbTo4cHgiPgogICAgICA8ZGl2IGNsYXNzPSJsaXN0' +
  'IiBpZD0iam9iUGljayIgc3R5bGU9Im1heC1oZWlnaHQ6MzIwcHg7b3ZlcmZsb3c6YXV0byI+CiAgICAgICAgJHtqb2JzLmxlbmd0' +
  'aCA/IGpvYnMubWFwKGogPT4gYAogICAgICAgICAgPGRpdiBjbGFzcz0iaXRlbSIgZGF0YS1waWNrPSIke2ouaWR9Ij4KICAgICAg' +
  'ICAgICAgPGRpdiBjbGFzcz0iciI+PGRpdj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJ0Ij4ke2VzYyhqLnJlY2lwaWVudF9u' +
  'YW1lKX08L2Rpdj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJtIj4ke2VzYyhqLmpvYl9udW1iZXIpfSDCtyAke2VzYyhbai5h' +
  'ZGRyZXNzMSwgai5jaXR5XS5maWx0ZXIoQm9vbGVhbikuam9pbignLCAnKSB8fCAnbm8gYWRkcmVzcycpfTwvZGl2PgogICAgICAg' +
  'ICAgICA8L2Rpdj48c3BhbiBjbGFzcz0icGlsbCIgZGF0YS10aWNrPSIke2ouaWR9Ij5hZGQ8L3NwYW4+PC9kaXY+CiAgICAgICAg' +
  'ICA8L2Rpdj5gKS5qb2luKCcnKQogICAgICAgICAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPk5vIG9wZW4gam9icyB0byBsYWJlbC48' +
  'L2Rpdj4nfQogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+UHJpbnQ8L2gy' +
  'PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InByaW50QnRuIiBkaXNhYmxl' +
  'ZD5QcmludCBsYWJlbHM8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0idGVzdEJ0biI+QWxp' +
  'Z25tZW50IHRlc3Q8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9w' +
  'OjhweCI+SW4gdGhlIHByaW50IGRpYWxvZyBzZXQgc2NhbGUgdG8gPGI+MTAwJTwvYj4gYW5kIHR1cm4gb2ZmCiAgICAgICAgImZp' +
  'dCB0byBwYWdlIiDigJQgc2NhbGluZyBpcyB3aGF0IHRocm93cyBsYWJlbCBhbGlnbm1lbnQgb2ZmLjwvZGl2PgoKICAgICAgPGRp' +
  'diBjbGFzcz0iZmllbGQiIHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPjxsYWJlbD5OdWRnZSwgaWYgeW91ciBwcmludGVyIHJ1bnMg' +
  'b2ZmPC9sYWJlbD4KICAgICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImhpbnQiIHN0eWxlPSJt' +
  'YXJnaW46MCI+UmlnaHQ8L3NwYW4+CiAgICAgICAgICA8aW5wdXQgaWQ9Im9mZlgiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIg' +
  'bWluPSItMC41IiBtYXg9IjAuNSIgdmFsdWU9IiR7aW5pdFNoZWV0Lm9mZnNldF94fSIgc3R5bGU9IndpZHRoOjkwcHgiPgogICAg' +
  'ICAgICAgPHNwYW4gY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MCI+RG93bjwvc3Bhbj4KICAgICAgICAgIDxpbnB1dCBpZD0i' +
  'b2ZmWSIgdHlwZT0ibnVtYmVyIiBzdGVwPSIwLjAxIiBtaW49Ii0wLjUiIG1heD0iMC41IiB2YWx1ZT0iJHtpbml0U2hlZXQub2Zm' +
  'c2V0X3l9IiBzdHlsZT0id2lkdGg6OTBweCI+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0ic2F2ZU9m' +
  'ZiI+U2F2ZTwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPkluY2hlcy4gUHJpbnQgdGhl' +
  'IGFsaWdubWVudCB0ZXN0IG9uIHBsYWluIHBhcGVyLCBob2xkIGl0IGFnYWluc3QgYSByZWFsIHNoZWV0LAogICAgICAgICAgYW5k' +
  'IG51ZGdlIHVudGlsIHRoZSBib3hlcyBsaW5lIHVwLjwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PmApOwogIGJpbmRTaGVs' +
  'bCgpOwoKICBjb25zdCBsYXlvdXRNZXRhID0gKCkgPT4gbGF5b3V0cy5maW5kKGwgPT4gbC5rZXkgPT09IFMuY2FjaGUuc2hlZXQu' +
  'bGF5b3V0KSB8fCBsYXlvdXRzWzBdOwoKICBmdW5jdGlvbiBkcmF3R3JpZCgpIHsKICAgIGNvbnN0IG1ldGEgPSBsYXlvdXRNZXRh' +
  'KCk7CiAgICBjb25zdCBzID0gUy5jYWNoZS5zaGVldDsKICAgIGNvbnN0IHVzZWQgPSBuZXcgU2V0KHMudXNlZC5tYXAoTnVtYmVy' +
  'KSk7CiAgICBjb25zdCBmcmVlID0gW107CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1ldGEuY2FwYWNpdHk7IGkrKykgaWYgKCF1' +
  'c2VkLmhhcyhpKSkgZnJlZS5wdXNoKGkpOwogICAgY29uc3Qgb3JkZXIgPSBuZXcgTWFwKGZyZWUuc2xpY2UoMCwgUy5jYWNoZS5w' +
  'aWNrZWQubGVuZ3RoKS5tYXAoKHBvcywgbikgPT4gW3BvcywgbiArIDFdKSk7CgogICAgJCgnI2dyaWQnKS5pbm5lckhUTUwgPSBg' +
  'PGRpdiBjbGFzcz0ibGdyaWQiIHN0eWxlPSJncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KCR7bWV0YS5jb2xzfSwxZnIpIj5g' +
  'ICsKICAgICAgQXJyYXkuZnJvbSh7IGxlbmd0aDogbWV0YS5jYXBhY2l0eSB9LCAoXywgaSkgPT4gewogICAgICAgIGNvbnN0IGlz' +
  'VXNlZCA9IHVzZWQuaGFzKGkpOwogICAgICAgIGNvbnN0IG4gPSBvcmRlci5nZXQoaSk7CiAgICAgICAgcmV0dXJuIGA8YnV0dG9u' +
  'IGNsYXNzPSJsY2VsbCR7aXNVc2VkID8gJyB1c2VkJyA6ICcnfSR7biA/ICcgbmV4dCcgOiAnJ30iIGRhdGEtY2VsbD0iJHtpfSIK' +
  'ICAgICAgICAgIHRpdGxlPSJQb3NpdGlvbiAke2kgKyAxfSI+JHtpc1VzZWQgPyAnw5cnIDogKG4gfHwgJycpfTwvYnV0dG9uPmA7' +
  'CiAgICAgIH0pLmpvaW4oJycpICsgJzwvZGl2Pic7CgogICAgJCgnI2ZyZWVDb3VudCcpLnRleHRDb250ZW50ID0gZnJlZS5sZW5n' +
  'dGggKyAnIG9mICcgKyBtZXRhLmNhcGFjaXR5ICsgJyBsZWZ0JzsKICAgICQoJyNwaWNrQ291bnQnKS50ZXh0Q29udGVudCA9IFMu' +
  'Y2FjaGUucGlja2VkLmxlbmd0aCArICcgc2VsZWN0ZWQnOwogICAgY29uc3Qgb3ZlciA9IFMuY2FjaGUucGlja2VkLmxlbmd0aCA+' +
  'IGZyZWUubGVuZ3RoOwogICAgY29uc3QgYnRuID0gJCgnI3ByaW50QnRuJyk7CiAgICBidG4uZGlzYWJsZWQgPSAhUy5jYWNoZS5w' +
  'aWNrZWQubGVuZ3RoOwogICAgYnRuLnRleHRDb250ZW50ID0gb3ZlcgogICAgICA/IGBQcmludCAke2ZyZWUubGVuZ3RofSBub3cg' +
  'KCR7Uy5jYWNoZS5waWNrZWQubGVuZ3RoIC0gZnJlZS5sZW5ndGh9IHdvbid0IGZpdClgCiAgICAgIDogYFByaW50ICR7Uy5jYWNo' +
  'ZS5waWNrZWQubGVuZ3RofSBsYWJlbCR7Uy5jYWNoZS5waWNrZWQubGVuZ3RoID09PSAxID8gJycgOiAncyd9YDsKCiAgICBkb2N1' +
  'bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1jZWxsXScpLmZvckVhY2goYyA9PiBjLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7' +
  'CiAgICAgIGNvbnN0IGkgPSArYy5kYXRhc2V0LmNlbGw7CiAgICAgIGNvbnN0IHNldCA9IG5ldyBTZXQoUy5jYWNoZS5zaGVldC51' +
  'c2VkLm1hcChOdW1iZXIpKTsKICAgICAgc2V0LmhhcyhpKSA/IHNldC5kZWxldGUoaSkgOiBzZXQuYWRkKGkpOwogICAgICBhd2Fp' +
  'dCBzYXZlU2hlZXQoeyB1c2VkOiBbLi4uc2V0XSB9KTsKICAgIH0pOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVNoZWV0KHBh' +
  'dGNoKSB7CiAgICB0cnkgewogICAgICBTLmNhY2hlLnNoZWV0ID0gYXdhaXQgYXBpKCcvbGFiZWwtc2hlZXQnLCB7IG1ldGhvZDog' +
  'J1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkocGF0Y2gpIH0pOwogICAgICBkcmF3R3JpZCgpOwogICAgfSBjYXRjaCAoZSkg' +
  'eyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfQoKICAkKCcjbGF5b3V0Jykub25jaGFuZ2UgPSBlID0+IHNhdmVTaGVldCh7' +
  'IGxheW91dDogZS50YXJnZXQudmFsdWUgfSk7CiAgJCgnI25ld1NoZWV0Jykub25jbGljayA9ICgpID0+IHNhdmVTaGVldCh7IHVz' +
  'ZWQ6IFtdIH0pOwogICQoJyNhbGxVc2VkJykub25jbGljayA9ICgpID0+CiAgICBzYXZlU2hlZXQoeyB1c2VkOiBBcnJheS5mcm9t' +
  'KHsgbGVuZ3RoOiBsYXlvdXRNZXRhKCkuY2FwYWNpdHkgfSwgKF8sIGkpID0+IGkpIH0pOwogICQoJyNzYXZlT2ZmJykub25jbGlj' +
  'ayA9IGFzeW5jICgpID0+IHsKICAgIGF3YWl0IHNhdmVTaGVldCh7IG9mZnNldF94OiBOdW1iZXIoJCgnI29mZlgnKS52YWx1ZSkg' +
  'fHwgMCwgb2Zmc2V0X3k6IE51bWJlcigkKCcjb2ZmWScpLnZhbHVlKSB8fCAwIH0pOwogICAgdG9hc3QoJ0FsaWdubWVudCBzYXZl' +
  'ZCcpOwogIH07CgogIGNvbnN0IHBhaW50ID0gKCkgPT4gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdGlja10nKS5m' +
  'b3JFYWNoKHQgPT4gewogICAgY29uc3Qgb24gPSBTLmNhY2hlLnBpY2tlZC5pbmNsdWRlcygrdC5kYXRhc2V0LnRpY2spOwogICAg' +
  'dC50ZXh0Q29udGVudCA9IG9uID8gJ+KckyBhZGRlZCcgOiAnYWRkJzsKICAgIHQuY2xhc3NOYW1lID0gb24gPyAncGlsbCBTZXJ2' +
  'ZWQnIDogJ3BpbGwnOwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBpY2tdJykuZm9yRWFjaChyb3cg' +
  'PT4gcm93Lm9uY2xpY2sgPSAoKSA9PiB7CiAgICBjb25zdCBpZCA9ICtyb3cuZGF0YXNldC5waWNrOwogICAgY29uc3QgaSA9IFMu' +
  'Y2FjaGUucGlja2VkLmluZGV4T2YoaWQpOwogICAgaSA9PT0gLTEgPyBTLmNhY2hlLnBpY2tlZC5wdXNoKGlkKSA6IFMuY2FjaGUu' +
  'cGlja2VkLnNwbGljZShpLCAxKTsKICAgIHBhaW50KCk7IGRyYXdHcmlkKCk7CiAgfSk7CiAgJCgnI2pvYkZpbHRlcicpLm9uaW5w' +
  'dXQgPSBlID0+IHsKICAgIGNvbnN0IHYgPSBlLnRhcmdldC52YWx1ZS50b0xvd2VyQ2FzZSgpOwogICAgZG9jdW1lbnQucXVlcnlT' +
  'ZWxlY3RvckFsbCgnW2RhdGEtcGlja10nKS5mb3JFYWNoKHIgPT4gewogICAgICByLnN0eWxlLmRpc3BsYXkgPSByLmlubmVyVGV4' +
  'dC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHYpID8gJycgOiAnbm9uZSc7CiAgICB9KTsKICB9OwoKICAkKCcjdGVzdEJ0bicpLm9u' +
  'Y2xpY2sgPSAoKSA9PiB7CiAgICBjb25zdCBpZHMgPSBTLmNhY2hlLnBpY2tlZC5sZW5ndGggPyBTLmNhY2hlLnBpY2tlZCA6IChq' +
  'b2JzWzBdID8gW2pvYnNbMF0uaWRdIDogW10pOwogICAgaWYgKCFpZHMubGVuZ3RoKSByZXR1cm4gdG9hc3QoJ0FkZCBhdCBsZWFz' +
  'dCBvbmUgam9iIGZpcnN0JywgdHJ1ZSk7CiAgICB3aW5kb3cub3BlbignL3ByaW50L2xhYmVscz9ndWlkZXM9MSZpZHM9JyArIGlk' +
  'cy5qb2luKCcsJyksICdfYmxhbmsnKTsKICB9OwoKICAkKCcjcHJpbnRCdG4nKS5vbmNsaWNrID0gKCkgPT4gewogICAgY29uc3Qg' +
  'bWV0YSA9IGxheW91dE1ldGEoKTsKICAgIGNvbnN0IHVzZWQgPSBuZXcgU2V0KFMuY2FjaGUuc2hlZXQudXNlZC5tYXAoTnVtYmVy' +
  'KSk7CiAgICBjb25zdCBmcmVlID0gW107CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1ldGEuY2FwYWNpdHk7IGkrKykgaWYgKCF1' +
  'c2VkLmhhcyhpKSkgZnJlZS5wdXNoKGkpOwogICAgY29uc3Qgd2lsbFVzZSA9IGZyZWUuc2xpY2UoMCwgUy5jYWNoZS5waWNrZWQu' +
  'bGVuZ3RoKTsKICAgIHdpbmRvdy5vcGVuKCcvcHJpbnQvbGFiZWxzP2lkcz0nICsgUy5jYWNoZS5waWNrZWQuam9pbignLCcpLCAn' +
  'X2JsYW5rJyk7CgogICAgY29uZmlybVByaW50ZWQod2lsbFVzZSk7CiAgfTsKCiAgZnVuY3Rpb24gY29uZmlybVByaW50ZWQod2ls' +
  'bFVzZSkgewogICAgc2hlZXQoJ0RpZCB0aGV5IHByaW50PycsIGAKICAgICAgPHAgY2xhc3M9ImhpbnQiPk9ubHkgbWFyayB0aGVz' +
  'ZSB1c2VkIG9uY2UgdGhlIHNoZWV0IGFjdHVhbGx5IGNhbWUgb3V0IHJpZ2h0IOKAlCBpZiB0aGUgcHJpbnRlcgogICAgICAgIGph' +
  'bW1lZCBvciB0aGUgYWxpZ25tZW50IHdhcyBvZmYsIHNheSBubyBhbmQgbm90aGluZyBjaGFuZ2VzLjwvcD4KICAgICAgPHA+PGI+' +
  'JHt3aWxsVXNlLmxlbmd0aH08L2I+IHBvc2l0aW9uJHt3aWxsVXNlLmxlbmd0aCA9PT0gMSA/ICcnIDogJ3MnfSB3b3VsZCBiZSBt' +
  'YXJrZWQgdXNlZDoKICAgICAgICAke3dpbGxVc2UubWFwKGkgPT4gaSArIDEpLmpvaW4oJywgJyl9PC9wPgogICAgICA8ZGl2IGNs' +
  'YXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBvayIgaWQ9Inllc1Vz' +
  'ZWQiPlllcyDigJQgbWFyayB0aGVtIHVzZWQ8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNr' +
  'PSJjbG9zZVNoZWV0KCkiPk5vLCBrZWVwIHRoZW0gZnJlZTwvYnV0dG9uPgogICAgICA8L2Rpdj5gLCBlbCA9PiB7CiAgICAgIGVs' +
  'LnF1ZXJ5U2VsZWN0b3IoJyN5ZXNVc2VkJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgICBjb25zdCBzZXQgPSBuZXcg' +
  'U2V0KFMuY2FjaGUuc2hlZXQudXNlZC5tYXAoTnVtYmVyKSk7CiAgICAgICAgd2lsbFVzZS5mb3JFYWNoKGkgPT4gc2V0LmFkZChp' +
  'KSk7CiAgICAgICAgYXdhaXQgc2F2ZVNoZWV0KHsgdXNlZDogWy4uLnNldF0gfSk7CiAgICAgICAgUy5jYWNoZS5waWNrZWQgPSBb' +
  'XTsKICAgICAgICBjbG9zZVNoZWV0KCk7CiAgICAgICAgdG9hc3QoJ1NoZWV0IHVwZGF0ZWQg4oCUICcgKyBTLmNhY2hlLnNoZWV0' +
  'LmZyZWUgKyAnIGxhYmVscyBsZWZ0Jyk7CiAgICAgICAgZ28oJ3Rvb2xzJyk7CiAgICAgIH07CiAgICB9KTsKICB9CgogIHBhaW50' +
  'KCk7CiAgZHJhd0dyaWQoKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LSBwcm9wZXJ0eSBzZWFyY2ggLS0gKi8KLyogVHdvIGRpZmZlcmVudCByZWNvcmRzIHN5c3RlbXMsIGFuZCB0aGUgZGlmZmVyZW5j' +
  'ZSBtYXR0ZXJzOgogICB0aGUgY291bnR5IENMRVJLIGhvbGRzIGRlZWRzIGFuZCBsaWVucyAod2hvIGJvdWdodCwgc29sZCwgb3Ig' +
  'aGFzIGEgY2xhaW0pLAogICB0aGUgQVBQUkFJU0FMIERJU1RSSUNUIGhvbGRzIHdobyBvd25zIGl0IG5vdyBhbmQgd2hlcmUgdGhl' +
  'aXIgdGF4IGJpbGwgaXMKICAgcG9zdGVkIC0tIHdoaWNoIGlzIHVzdWFsbHkgdGhlIGJldHRlciBsZWFkIHdoZW4gYW4gYWRkcmVz' +
  'cyBoYXMgZ29uZSBzdGFsZS4gKi8KY29uc3QgQ09VTlRJRVMgPSBbCiAgewogICAgbmFtZTogJ0hpZGFsZ28gQ291bnR5JywKICAg' +
  'IGNsZXJrOiB7IHVybDogJ2h0dHBzOi8vaGlkYWxnby50eC5wdWJsaWNzZWFyY2gudXMvJywgbm90ZTogJ0RlZWRzLCBsaWVucywg' +
  'dHJhbnNmZXJzLiBHcmFudG9yL2dyYW50ZWUsIGRvYyBudW1iZXIsIGZ1bGwtdGV4dCBPQ1IuIE5vIGxvZ2luLicgfSwKICAgIGNh' +
  'ZDogeyB1cmw6ICdodHRwczovL2hpZGFsZ28ucHJvZGlneWNhZC5jb20vcHJvcGVydHktc2VhcmNoJywgbm90ZTogJ0N1cnJlbnQg' +
  'b3duZXIsIG1haWxpbmcgYWRkcmVzcywgc2l0dXMgYWRkcmVzcywgdmFsdWF0aW9uLicgfSwKICAgIGNhZEFsdDogeyB1cmw6ICdo' +
  'dHRwczovL3Byb3BhY2Nlc3MuaGlkYWxnb2FkLm9yZy9DbGllbnREQi9Qcm9wZXJ0eVNlYXJjaC5hc3B4P2NpZD0xJywgbm90ZTog' +
  'J09sZGVyIEhpZGFsZ28gQ0FEIHNlYXJjaCwgaWYgdGhlIG5ldyBvbmUgaXMgZG93bi4nIH0KICB9LAogIHsKICAgIG5hbWU6ICdD' +
  'YW1lcm9uIENvdW50eScsCiAgICBjbGVyazogeyB1cmw6ICdodHRwczovL2NhbWVyb24udHgucHVibGljc2VhcmNoLnVzLycsIG5v' +
  'dGU6ICdEZWVkcywgbGllbnMsIHRyYW5zZmVycywgZm9yZWNsb3N1cmUgcG9zdGluZ3MuIE5vIGxvZ2luLicgfSwKICAgIGNhZDog' +
  'eyB1cmw6ICdodHRwczovL2NhbWVyb24ucHJvZGlneWNhZC5jb20vJywgbm90ZTogJ0N1cnJlbnQgb3duZXIsIG1haWxpbmcgYWRk' +
  'cmVzcywgc2l0dXMgYWRkcmVzcywgdmFsdWF0aW9uLicgfSwKICAgIGNhZEFsdDogeyB1cmw6ICdodHRwOi8vcHJvcGFjY2Vzcy5j' +
  'YW1lcm9uY2FkLm9yZy9jbGllbnRkYi9Qcm9wZXJ0eVNlYXJjaC5hc3B4P2NpZD0xJywgbm90ZTogJ09sZGVyIENhbWVyb24gQ0FE' +
  'IHNlYXJjaCwgaWYgdGhlIG5ldyBvbmUgaXMgZG93bi4nIH0KICB9LAogIHsKICAgIG5hbWU6ICdTdGFyciBDb3VudHknLAogICAg' +
  'Y2xlcms6IHsgdXJsOiAnaHR0cHM6Ly9zdGFyci50eC5wdWJsaWNzZWFyY2gudXMvJywgbm90ZTogJ0RlZWRzLCBsaWVucywgdHJh' +
  'bnNmZXJzLiBTYW1lIHN5c3RlbSBhcyBIaWRhbGdvIGFuZCBDYW1lcm9uLicgfSwKICAgIGNhZDogeyB1cmw6ICdodHRwczovL2Vz' +
  'ZWFyY2guc3RhcnJjYWQub3JnLycsIG5vdGU6ICdDdXJyZW50IG93bmVyLCBtYWlsaW5nIGFkZHJlc3MsIHNpdHVzIGFkZHJlc3Mu' +
  'JyB9CiAgfQpdOwoKZnVuY3Rpb24gcHJvcGVydHlWaWV3KCkgewogIGNvbnN0IHJvd3MgPSBDT1VOVElFUy5tYXAoKGMsIGNpKSA9' +
  'PiBgCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPiR7ZXNjKGMubmFtZSl9PC9oMj4KICAgICAgPGRpdiBjbGFzcz0i' +
  'bGlzdCI+CiAgICAgICAgPGRpdiBjbGFzcz0iaXRlbSIgZGF0YS1wcm9wPSIke2NpfTpjYWQiPgogICAgICAgICAgPGRpdiBjbGFz' +
  'cz0idCI+QXBwcmFpc2FsIGRpc3RyaWN0IOKAlCB3aG8gb3ducyBpdCBub3c8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9Im0i' +
  'PiR7ZXNjKGMuY2FkLm5vdGUpfTwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Iml0ZW0iIGRhdGEtcHJv' +
  'cD0iJHtjaX06Y2xlcmsiPgogICAgICAgICAgPGRpdiBjbGFzcz0idCI+Q291bnR5IGNsZXJrIOKAlCBkZWVkcyAmYW1wOyBsaWVu' +
  'czwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0ibSI+JHtlc2MoYy5jbGVyay5ub3RlKX08L2Rpdj4KICAgICAgICA8L2Rpdj4K' +
  'ICAgICAgICAke2MuY2FkQWx0ID8gYDxkaXYgY2xhc3M9Iml0ZW0iIGRhdGEtcHJvcD0iJHtjaX06Y2FkQWx0Ij4KICAgICAgICAg' +
  'IDxkaXYgY2xhc3M9InQiPkFwcHJhaXNhbCBkaXN0cmljdCAob2xkZXIgc2VhcmNoKTwvZGl2PgogICAgICAgICAgPGRpdiBjbGFz' +
  'cz0ibSI+JHtlc2MoYy5jYWRBbHQubm90ZSl9PC9kaXY+CiAgICAgICAgPC9kaXY+YCA6ICcnfQogICAgICA8L2Rpdj4KICAgIDwv' +
  'ZGl2PmApLmpvaW4oJycpOwoKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5Qcm9wZXJ0eSBy' +
  'ZWNvcmRzPC9oMT4KICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8bGFiZWw+TmFtZSBvciBhZGRyZXNzIHRvIGxvb2sgdXA8' +
  'L2xhYmVsPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAgIDxpbnB1dCBpZD0icHJvcFEiIHBsYWNlaG9sZGVyPSJHQVJa' +
  'QSBNQVJJQSAgb3IgIDEyMDQgRSBNYWluIFN0IiBzdHlsZT0iZmxleDoxO21pbi13aWR0aDoxNjBweCI+CiAgICAgICAgPGJ1dHRv' +
  'biBjbGFzcz0iYnRuIHNtIiBpZD0icHJvcENvcHkiPkNvcHk8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxwIGNsYXNzPSJo' +
  'aW50Ij5UaGVzZSBzaXRlcyBjYW4ndCBiZSBsaW5rZWQgdG8gd2l0aCBhIHNlYXJjaCB0ZXJtLCBzbyB0YXBwaW5nIG9uZSBjb3Bp' +
  'ZXMgd2hhdCB5b3UgdHlwZWQKICAgICAgICBhbmQgb3BlbnMgdGhlaXIgc2VhcmNoIHBhZ2Ug4oCUIHBhc3RlIGl0IGludG8gdGhl' +
  'aXIgYm94LjwvcD4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOiNmOGZhZmM7Ym94' +
  'LXNoYWRvdzpub25lIj4KICAgICAgPGgyPldoaWNoIG9uZSBkbyB5b3Ugd2FudD88L2gyPgogICAgICA8cCBjbGFzcz0iaGludCIg' +
  'c3R5bGU9Im1hcmdpbjowIj4KICAgICAgICA8Yj5BcHByYWlzYWwgZGlzdHJpY3Q8L2I+IOKAlCBjdXJyZW50IG93bmVyIGFuZCB0' +
  'aGUgbWFpbGluZyBhZGRyZXNzIHRoZSB0YXggYmlsbCBnb2VzIHRvLiBCZXN0IGZvcgogICAgICAgIGNvbmZpcm1pbmcgdGhlIHBl' +
  'cnNvbiBvbiB5b3VyIHBhcGVycyBpcyB0aWVkIHRvIHRoZSBhZGRyZXNzLCBhbmQgZm9yIGZpbmRpbmcgc29tZXdoZXJlIGVsc2Ug' +
  'dG8gdHJ5Ljxicj48YnI+CiAgICAgICAgPGI+Q291bnR5IGNsZXJrPC9iPiDigJQgZGVlZHMsIGxpZW5zIGFuZCB0cmFuc2ZlcnMu' +
  'IEJlc3QgZm9yIGhpc3Rvcnk6IHdobyBzb2xkIGl0LCB3aGVuLCBhbmQgd2hvIGhvbGRzIGEgY2xhaW0uCiAgICAgICAgV29uJ3Qg' +
  'cmVsaWFibHkgdGVsbCB5b3Ugd2hvIGxpdmVzIHRoZXJlIG5vdy48L3A+CiAgICA8L2Rpdj4KCiAgICAke3Jvd3N9CgogICAgPGRp' +
  'diBjbGFzcz0iY2FyZCI+CiAgICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjAiPkEgbWFpbGluZyBhZGRyZXNzIGZy' +
  'b20gdGhlIGFwcHJhaXNhbCBkaXN0cmljdCBpcyBhIGxlYWQsIG5vdCBwcm9vZiBvZgogICAgICAgIHJlc2lkZW5jZSDigJQgcGxl' +
  'bnR5IG9mIG93bmVycyBoYXZlIHBvc3QgZ29uZSB0byBhbiBhZ2VudCwgYSByZWxhdGl2ZSwgb3IgYW5vdGhlciBzdGF0ZS4gVHJl' +
  'YXQgaXQgYXMgYQogICAgICAgIHBsYWNlIHRvIGF0dGVtcHQsIGFuZCByZWNvcmQgd2hhdCB5b3UgYWN0dWFsbHkgZmluZCBpbiB0' +
  'aGUgYXR0ZW1wdCBub3Rlcy48L3A+CiAgICA8L2Rpdj5gKTsKICBiaW5kU2hlbGwoKTsKCiAgY29uc3QgY29weVRlcm0gPSBhc3lu' +
  'YyAoKSA9PiB7CiAgICBjb25zdCB2ID0gJCgnI3Byb3BRJykudmFsdWUudHJpbSgpOwogICAgaWYgKCF2KSByZXR1cm4gZmFsc2U7' +
  'CiAgICB0cnkgeyBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dCh2KTsgcmV0dXJuIHRydWU7IH0gY2F0Y2ggKGUp' +
  'IHsgcmV0dXJuIGZhbHNlOyB9CiAgfTsKICAkKCcjcHJvcENvcHknKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgY29uc3Qg' +
  'diA9ICQoJyNwcm9wUScpLnZhbHVlLnRyaW0oKTsKICAgIGlmICghdikgcmV0dXJuIHRvYXN0KCdUeXBlIGEgbmFtZSBvciBhZGRy' +
  'ZXNzIGZpcnN0JywgdHJ1ZSk7CiAgICB0b2FzdChhd2FpdCBjb3B5VGVybSgpID8gJ0NvcGllZCAiJyArIHYgKyAnIicgOiAnQ29w' +
  'eSBmYWlsZWQg4oCUIHNlbGVjdCBpdCBieSBoYW5kJyk7CiAgfTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1w' +
  'cm9wXScpLmZvckVhY2gocm93ID0+IHJvdy5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgY29uc3QgW2NpLCB3aGljaF0gPSBy' +
  'b3cuZGF0YXNldC5wcm9wLnNwbGl0KCc6Jyk7CiAgICBjb25zdCB0YXJnZXQgPSBDT1VOVElFU1srY2ldW3doaWNoXTsKICAgIGNv' +
  'bnN0IGhhZCA9ICQoJyNwcm9wUScpLnZhbHVlLnRyaW0oKTsKICAgIGNvbnN0IG9rID0gaGFkID8gYXdhaXQgY29weVRlcm0oKSA6' +
  'IGZhbHNlOwogICAgdG9hc3Qob2sgPyAnQ29waWVkICInICsgaGFkICsgJyIg4oCUIHBhc3RlIGl0IGludG8gdGhlaXIgc2VhcmNo' +
  'JyA6ICdPcGVuaW5nICcgKyBDT1VOVElFU1srY2ldLm5hbWUpOwogICAgd2luZG93Lm9wZW4odGFyZ2V0LnVybCwgJ19ibGFuaycp' +
  'OwogIH0pOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBjYXNl' +
  'IGxvb2t1cCAtLSAqLwovKiBOb25lIG9mIHRoZXNlIHBvcnRhbHMgYWNjZXB0IGEgY2FzZSBudW1iZXIgaW4gdGhlIFVSTCAtLSBI' +
  'aWRhbGdvJ3MgcnVucyBvbgogICBzZXNzaW9uLWJhc2VkIGZvcm0gcG9zdHMsIENhbWVyb24ncyBzaXRzIGJlaGluZCBhIEphdmFT' +
  'Y3JpcHQgZ2F0ZS4gU28gdGhpcwogICBjb3BpZXMgdGhlIG51bWJlciB0byB0aGUgY2xpcGJvYXJkIGFuZCBvcGVucyB0aGUgcmln' +
  'aHQgc2VhcmNoIHBhZ2UuIE5vCiAgIHNjcmFwaW5nLCBub3RoaW5nIHRvIGJyZWFrIHdoZW4gdGhleSByZWRlc2lnbi4gKi8KY29u' +
  'c3QgVFhfUE9SVEFMUyA9IFsKICB7IG5hbWU6ICdyZTpTZWFyY2hUWCDigJQgc3RhdGV3aWRlJywgdXJsOiAnaHR0cHM6Ly9yZXNl' +
  'YXJjaC50eGNvdXJ0cy5nb3YvJywKICAgIG5vdGU6ICdGcmVlIGFjY291bnQgcmVxdWlyZWQuIERpc3RyaWN0LCBjb3VudHkgYW5k' +
  'IHByb2JhdGUgY291cnRzIGluIGFsbCAyNTQgY291bnRpZXMuICcgKwogICAgICAgICAgJ1B1YmxpYyB2aWV3IHN0YXJ0cyBhdCBm' +
  'aWxpbmdzIGZyb20gMSBOb3YgMjAxOC4gSnVzdGljZS1vZi10aGUtcGVhY2UgZXZpY3Rpb25zIGFyZSBwYXRjaHkuJyB9LAogIHsg' +
  'bmFtZTogJ0hpZGFsZ28gQ291bnR5IOKAlCBEaXN0cmljdCBDbGVyayBjYXNlIHNlYXJjaCcsIHVybDogJ2h0dHBzOi8vcGEuY28u' +
  'aGlkYWxnby50eC51cy9kZWZhdWx0LmFzcHgnLAogICAgbm90ZTogJ0NpdmlsIGFuZCBjcmltaW5hbCBjYXNlcy4gRnJlZSwgbm8g' +
  'bG9naW4uJyB9LAogIHsgbmFtZTogJ0NhbWVyb24gQ291bnR5IOKAlCBjb3VydCBwb3J0YWxzJywgdXJsOiAnaHR0cHM6Ly93d3cu' +
  'Y2FtZXJvbmNvdW50eXR4Lmdvdi9jYW1lcm9uLWNvdW50eS1wb3J0YWxzLycsCiAgICBub3RlOiAnSW5kZXggcGFnZSBmb3IgdGhl' +
  'IGNvdW50eVwncyBkaXN0cmljdCBhbmQgY291bnR5IGNsZXJrIHNlYXJjaGVzLicgfSwKICB7IG5hbWU6ICdDYW1lcm9uIENvdW50' +
  'eSDigJQgRGlzdHJpY3QgQ2xlcmsgcmVjb3JkcycsIHVybDogJ2h0dHBzOi8va29maWxlcXVpY2tsaW5rcy5jb20vY2FtZXJvbmRj' +
  'LycsCiAgICBub3RlOiAnRGlzdHJpY3QgQ2xlcmsgcmVjb3JkIHNlYXJjaC4nIH0sCiAgeyBuYW1lOiAnSGlkYWxnbyBDb3VudHkg' +
  '4oCUIHByb3BlcnR5IC8gb2ZmaWNpYWwgcmVjb3JkcycsIHVybDogJ2h0dHBzOi8vaGlkYWxnby50eC5wdWJsaWNzZWFyY2gudXMv' +
  'JywKICAgIG5vdGU6ICdEZWVkcywgbGllbnMgYW5kIG93bmVyc2hpcCBmcm9tIHRoZSBDb3VudHkgQ2xlcmsg4oCUIHByb3BlcnR5' +
  'LCBub3QgbGF3c3VpdHMuICcgKwogICAgICAgICAgJ1VzZWZ1bCBmb3IgY29uZmlybWluZyB3aG8gYWN0dWFsbHkgb3ducyBhbiBh' +
  'ZGRyZXNzLicgfQpdOwoKZnVuY3Rpb24gY2FzZUxvb2t1cFNoZWV0KGpvYikgewogIHNoZWV0KCdMb29rIHVwICcgKyBqb2IuY2Fz' +
  'ZV9udW1iZXIsIGAKICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOiNmOGZhZmM7Ym94LXNoYWRvdzpub25l' +
  'O3RleHQtYWxpZ246Y2VudGVyIj4KICAgICAgPGRpdiBzdHlsZT0iZm9udDo2MDAgMjBweC8xLjMgbW9ub3NwYWNlO2xldHRlci1z' +
  'cGFjaW5nOi41cHgiPiR7ZXNjKGpvYi5jYXNlX251bWJlcil9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKGpv' +
  'Yi5jb3VydCB8fCAnY291cnQgbm90IHJlY29yZGVkJyl9PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9ImNv' +
  'cHlDYXNlIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij5Db3B5IGNhc2UgbnVtYmVyPC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDxw' +
  'IGNsYXNzPSJoaW50Ij5UaGVzZSBwb3J0YWxzIGNhbid0IGJlIGxpbmtlZCB0byBkaXJlY3RseSB3aXRoIGEgY2FzZSBudW1iZXIs' +
  'IHNvIHRhcHBpbmcgb25lIGNvcGllcwogICAgICB0aGUgbnVtYmVyIGFuZCBvcGVucyB0aGVpciBzZWFyY2ggcGFnZSDigJQgcGFz' +
  'dGUgaXQgaW50byB0aGVpciBib3guPC9wPgogICAgPGRpdiBjbGFzcz0ibGlzdCI+CiAgICAgICR7VFhfUE9SVEFMUy5tYXAoKHAs' +
  'IGkpID0+IGAKICAgICAgICA8ZGl2IGNsYXNzPSJpdGVtIiBkYXRhLXBvcnRhbD0iJHtpfSI+CiAgICAgICAgICA8ZGl2IGNsYXNz' +
  'PSJ0Ij4ke2VzYyhwLm5hbWUpfTwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0ibSI+JHtlc2MocC5ub3RlKX08L2Rpdj4KICAg' +
  'ICAgICA8L2Rpdj5gKS5qb2luKCcnKX0KICAgIDwvZGl2PgogICAgPHAgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjEy' +
  'cHgiPkNvdXJ0IHJlY29yZHMgcmFyZWx5IHB1Ymxpc2ggYSBkZWZlbmRhbnQncyBzZXJ2aWNlIGFkZHJlc3Mg4oCUCiAgICAgIHRo' +
  'YXQgbm9ybWFsbHkgb25seSBleGlzdHMgb24gdGhlIGNsaWVudCdzIHBhY2tldC48L3A+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4g' +
  'c2VjIGJsb2NrIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiIG9uY2xpY2s9ImNsb3NlU2hlZXQoKSI+Q2xvc2U8L2J1dHRvbj5gLCBl' +
  'bCA9PiB7CiAgICBjb25zdCBjb3B5ID0gYXN5bmMgKCkgPT4gewogICAgICB0cnkgeyBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJk' +
  'LndyaXRlVGV4dChqb2IuY2FzZV9udW1iZXIpOyByZXR1cm4gdHJ1ZTsgfQogICAgICBjYXRjaCAoZSkgeyByZXR1cm4gZmFsc2U7' +
  'IH0KICAgIH07CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjY29weUNhc2UnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4KICAgICAgdG9h' +
  'c3QoYXdhaXQgY29weSgpID8gJ0NvcGllZCAnICsgam9iLmNhc2VfbnVtYmVyIDogJ0NvcHkgZmFpbGVkIOKAlCBzZWxlY3QgaXQg' +
  'YnkgaGFuZCcsIGZhbHNlKTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBvcnRhbF0nKS5mb3JFYWNoKHJvdyA9PiBy' +
  'b3cub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgcCA9IFRYX1BPUlRBTFNbK3Jvdy5kYXRhc2V0LnBvcnRhbF07' +
  'CiAgICAgIGNvbnN0IG9rID0gYXdhaXQgY29weSgpOwogICAgICB0b2FzdChvayA/ICdDYXNlIG51bWJlciBjb3BpZWQg4oCUIHBh' +
  'c3RlIGl0IGludG8gdGhlaXIgc2VhcmNoJyA6ICdPcGVuaW5nICcgKyBwLm5hbWUpOwogICAgICB3aW5kb3cub3BlbihwLnVybCwg' +
  'J19ibGFuaycpOwogICAgfSk7CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLSBzY2FuIC0tICovCmZ1bmN0aW9uIHNjYW5WaWV3KCkgewogIGFwcC5pbm5lckhUTUwgPSBzaGVs' +
  'bChgCiAgICA8aDEgY2xhc3M9InBhZ2UiPlNjYW4gYSBwYWNrZXQ8L2gxPgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxw' +
  'IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDowIj5Qb2ludCB0aGUgY2FtZXJhIGF0IHRoZSBiYXJjb2RlIG9uIHRoZSBj' +
  'b3ZlciBzaGVldCB0byBvcGVuIHRoYXQgam9iLiBJZiB0aGUgY2FtZXJhCiAgICAgIHdvbid0IGNvb3BlcmF0ZSwgdHlwZSB0aGUg' +
  'am9iIG51bWJlciBpbnN0ZWFkIOKAlCBpdCB3b3JrcyB0aGUgc2FtZS48L3A+CiAgICAgIDxkaXYgaWQ9InJlYWRlciI+PC9kaXY+' +
  'CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRu' +
  'IiBpZD0ic3RhcnRTY2FuIj5TdGFydCBjYW1lcmE8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBpZD0i' +
  'c3RvcFNjYW5CdG4iIHN0eWxlPSJkaXNwbGF5Om5vbmUiPlN0b3A8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xh' +
  'c3M9ImhpbnQiIGlkPSJzY2FuTXNnIj48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5F' +
  'bnRlciBqb2IgbnVtYmVyPC9oMj4KICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgICA8aW5wdXQgaWQ9Im1hbnVhbCIgcGxh' +
  'Y2Vob2xkZXI9IlNULTEwMDAxIiBzdHlsZT0iZmxleDoxO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZSI+CiAgICAgICAgPGJ1dHRv' +
  'biBjbGFzcz0iYnRuIiBpZD0ibWFudWFsR28iPk9wZW48L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj5gKTsKICBiaW5k' +
  'U2hlbGwoKTsKCiAgY29uc3Qgb3BlbiA9IGFzeW5jIGNvZGUgPT4gewogICAgdHJ5IHsKICAgICAgY29uc3QgaiA9IGF3YWl0IGFw' +
  'aSgnL2xvb2t1cC8nICsgZW5jb2RlVVJJQ29tcG9uZW50KGNvZGUpKTsKICAgICAgaWYgKHdpbmRvdy5fX3N0b3BTY2FuKSB7IHdp' +
  'bmRvdy5fX3N0b3BTY2FuKCk7IHdpbmRvdy5fX3N0b3BTY2FuID0gbnVsbDsgfQogICAgICB0b2FzdCgnT3BlbmluZyAnICsgai5q' +
  'b2JfbnVtYmVyKTsKICAgICAgZ28oJ2pvYicsIHsgaWQ6IGouaWQgfSk7CiAgICB9IGNhdGNoIChlKSB7ICQoJyNzY2FuTXNnJyku' +
  'dGV4dENvbnRlbnQgPSBlLm1lc3NhZ2U7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9OwoKICAkKCcjbWFudWFsR28nKS5v' +
  'bmNsaWNrID0gKCkgPT4geyBjb25zdCB2ID0gJCgnI21hbnVhbCcpLnZhbHVlLnRyaW0oKTsgaWYgKHYpIG9wZW4odik7IH07CiAg' +
  'JCgnI21hbnVhbCcpLm9ua2V5ZG93biA9IGUgPT4geyBpZiAoZS5rZXkgPT09ICdFbnRlcicpICQoJyNtYW51YWxHbycpLmNsaWNr' +
  'KCk7IH07CgogICQoJyNzdGFydFNjYW4nKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgY29uc3QgbXNnID0gJCgnI3NjYW5N' +
  'c2cnKTsKICAgIGlmICghd2luZG93LlpYaW5nKSByZXR1cm4gbXNnLnRleHRDb250ZW50ID0gJ1NjYW5uZXIgbGlicmFyeSBkaWQg' +
  'bm90IGxvYWQg4oCUIHVzZSB0aGUgam9iIG51bWJlciBib3ggYmVsb3cuJzsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHJlYWRlciA9' +
  'IG5ldyBaWGluZy5Ccm93c2VyTXVsdGlGb3JtYXRSZWFkZXIoKTsKICAgICAgY29uc3QgdmlkZW8gPSBkb2N1bWVudC5jcmVhdGVF' +
  'bGVtZW50KCd2aWRlbycpOwogICAgICB2aWRlby5zZXRBdHRyaWJ1dGUoJ3BsYXlzaW5saW5lJywgJ3RydWUnKTsKICAgICAgJCgn' +
  'I3JlYWRlcicpLmlubmVySFRNTCA9ICcnOwogICAgICAkKCcjcmVhZGVyJykuYXBwZW5kQ2hpbGQodmlkZW8pOwogICAgICAkKCcj' +
  'c3RhcnRTY2FuJykuc3R5bGUuZGlzcGxheSA9ICdub25lJzsKICAgICAgJCgnI3N0b3BTY2FuQnRuJykuc3R5bGUuZGlzcGxheSA9' +
  'ICcnOwogICAgICBtc2cudGV4dENvbnRlbnQgPSAnTG9va2luZyBmb3IgYSBiYXJjb2Rl4oCmJzsKICAgICAgbGV0IGhhbmRsZWQg' +
  'PSBmYWxzZTsKICAgICAgYXdhaXQgcmVhZGVyLmRlY29kZUZyb21Db25zdHJhaW50cygKICAgICAgICB7IHZpZGVvOiB7IGZhY2lu' +
  'Z01vZGU6ICdlbnZpcm9ubWVudCcgfSB9LCB2aWRlbywKICAgICAgICAocmVzdWx0KSA9PiB7IGlmIChyZXN1bHQgJiYgIWhhbmRs' +
  'ZWQpIHsgaGFuZGxlZCA9IHRydWU7IG9wZW4ocmVzdWx0LmdldFRleHQoKSk7IH0gfSk7CiAgICAgIHdpbmRvdy5fX3N0b3BTY2Fu' +
  'ID0gKCkgPT4gewogICAgICAgIHRyeSB7IHJlYWRlci5yZXNldCgpOyB9IGNhdGNoIChlKSB7fQogICAgICAgICQoJyNyZWFkZXIn' +
  'KS5pbm5lckhUTUwgPSAnJzsKICAgICAgICBjb25zdCBzID0gJCgnI3N0YXJ0U2NhbicpLCBzdCA9ICQoJyNzdG9wU2NhbkJ0bicp' +
  'OwogICAgICAgIGlmIChzKSBzLnN0eWxlLmRpc3BsYXkgPSAnJzsKICAgICAgICBpZiAoc3QpIHN0LnN0eWxlLmRpc3BsYXkgPSAn' +
  'bm9uZSc7CiAgICAgIH07CiAgICAgICQoJyNzdG9wU2NhbkJ0bicpLm9uY2xpY2sgPSAoKSA9PiB7IHdpbmRvdy5fX3N0b3BTY2Fu' +
  'KCk7IHdpbmRvdy5fX3N0b3BTY2FuID0gbnVsbDsgbXNnLnRleHRDb250ZW50ID0gJyc7IH07CiAgICB9IGNhdGNoIChlKSB7CiAg' +
  'ICAgIG1zZy50ZXh0Q29udGVudCA9ICdDYW1lcmEgdW5hdmFpbGFibGUgKCcgKyBlLm1lc3NhZ2UgKyAnKS4gVXNlIHRoZSBqb2Ig' +
  'bnVtYmVyIGJveCBiZWxvdy4nOwogICAgICAkKCcjc3RhcnRTY2FuJykuc3R5bGUuZGlzcGxheSA9ICcnOwogICAgICAkKCcjc3Rv' +
  'cFNjYW5CdG4nKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogICAgfQogIH07Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIG1vbmV5IC0tICovCmFzeW5jIGZ1bmN0aW9uIG1vbmV5Vmll' +
  'dygpIHsKICBpZiAoIWlzQWRtaW4oKSkgcmV0dXJuIG15UGF5VmlldygpOwogIGNvbnN0IFtzdGF0ZW1lbnRzLCBpbnZvaWNlcywg' +
  'dXNlcnMsIGNsaWVudHNdID0gYXdhaXQgUHJvbWlzZS5hbGwoCiAgICBbYXBpKCcvc3RhdGVtZW50cycpLCBhcGkoJy9pbnZvaWNl' +
  'cycpLCBhcGkoJy91c2VycycpLCBhcGkoJy9jbGllbnRzJyldKTsKCiAgYXBwLmlubmVySFRNTCA9IHNoZWxsKGAKICAgIDxoMSBj' +
  'bGFzcz0icGFnZSI+QmlsbGluZyAmYW1wOyBwYXk8L2gxPgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+Q29udHJh' +
  'Y3RvciBzdGF0ZW1lbnRzIDxzcGFuIGNsYXNzPSJzdWIiPndoYXQgeW91IG93ZSB5b3VyIHNlcnZlcnM8L3NwYW4+PC9oMj4KICAg' +
  'ICAgPHAgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOi00cHgiPlB1bGxzIGV2ZXJ5IGNvbXBsZXRlZCBzZXJ2ZSBpbiB0' +
  'aGUgcGVyaW9kIHRoYXQgaGFzbid0IGJlZW4gcGFpZCBvdXQgeWV0LCBhdCB0aGUKICAgICAgcGVyLWpvYiByYXRlIG9uIHRoZSBq' +
  'b2IuIE5vdGhpbmcgZ2V0cyBjb3VudGVkIHR3aWNlLjwvcD4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiIgc3R5bGU9Im1hcmdp' +
  'bi10b3A6MTBweCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5TZXJ2ZXI8L2xhYmVsPjxzZWxlY3QgaWQ9InNf' +
  'c2VydmVyIj4KICAgICAgICAgICR7dXNlcnMuZmlsdGVyKHUgPT4gdS5hY3RpdmUpLm1hcCh1ID0+IGA8b3B0aW9uIHZhbHVlPSIk' +
  'e3UuaWR9Ij4ke2VzYyh1Lm5hbWUpfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAgICAgIDxkaXYgY2xh' +
  'c3M9InJvdyIgc3R5bGU9ImFsaWduLWl0ZW1zOmZsZXgtZW5kO2dhcDo2cHgiPgogICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQi' +
  'IHN0eWxlPSJmbGV4OjE7bWFyZ2luOjAiPjxsYWJlbD5Gcm9tPC9sYWJlbD48aW5wdXQgdHlwZT0iZGF0ZSIgaWQ9InNfc3RhcnQi' +
  'IHZhbHVlPSIke2ZpcnN0T2ZNb250aCgpfSI+PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCIgc3R5bGU9ImZsZXg6' +
  'MTttYXJnaW46MCI+PGxhYmVsPlRvPC9sYWJlbD48aW5wdXQgdHlwZT0iZGF0ZSIgaWQ9InNfZW5kIiB2YWx1ZT0iJHt0b2RheUlT' +
  'TygpfSI+PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJn' +
  'aW4tdG9wOjhweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9InNfcHJldiI+UHJldmlldzwvYnV0dG9u' +
  'PgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9InNfbWFrZSI+Q3JlYXRlIHN0YXRlbWVudDwvYnV0dG9uPgogICAg' +
  'ICA8L2Rpdj4KICAgICAgPGRpdiBpZD0ic19vdXQiPjwvZGl2PgogICAgICAke3N0YXRlbWVudHMubGVuZ3RoID8gYDx0YWJsZSBj' +
  'bGFzcz0idGJsIiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij4KICAgICAgICA8dHI+PHRoPlNlcnZlcjwvdGg+PHRoPlBlcmlvZDwv' +
  'dGg+PHRoIGNsYXNzPSJudW0iPkpvYnM8L3RoPjx0aCBjbGFzcz0ibnVtIj5Ub3RhbDwvdGg+PHRoPjwvdGg+PHRoPjwvdGg+PC90' +
  'cj4KICAgICAgICAke3N0YXRlbWVudHMubWFwKHMgPT4gYDx0cj4KICAgICAgICAgIDx0ZD4ke2VzYyhzLnNlcnZlcl9uYW1lKX08' +
  'L3RkPjx0ZD4ke2ZtdERhdGVPbmx5KHMucGVyaW9kX3N0YXJ0KX3igJMke2ZtdERhdGVPbmx5KHMucGVyaW9kX2VuZCl9PC90ZD4K' +
  'ICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke3Muam9iX2NvdW50fTwvdGQ+PHRkIGNsYXNzPSJudW0iPiR7bW9uZXkocy50b3Rh' +
  'bCl9PC90ZD4KICAgICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icGlsbCAke2NscyhzLnN0YXR1cyl9Ij4ke2VzYyhzLnN0YXR1cyl9' +
  'PC9zcGFuPjwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iL3ByaW50L3N0YXRlbWVudC8ke3MuaWR9IiB0' +
  'YXJnZXQ9Il9ibGFuayI+cHJpbnQ8L2E+CiAgICAgICAgICAgICR7cy5zdGF0dXMgIT09ICdQYWlkJyA/IGAgwrcgPGEgaHJlZj0i' +
  'IyIgZGF0YS1wYWlkPSIke3MuaWR9Ij5tYXJrIHBhaWQ8L2E+YCA6ICcnfTwvdGQ+CiAgICAgICAgPC90cj5gKS5qb2luKCcnKX08' +
  'L3RhYmxlPmAgOiAnJ30KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+Q2xpZW50IGludm9pY2Vz' +
  'PC9oMj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5DbGllbnQ8' +
  'L2xhYmVsPjxzZWxlY3QgaWQ9ImlfY2xpZW50Ij4KICAgICAgICAgICR7Y2xpZW50cy5maWx0ZXIoYyA9PiBjLmFjdGl2ZSkubWFw' +
  'KGMgPT4gYDxvcHRpb24gdmFsdWU9IiR7Yy5pZH0iPiR7ZXNjKGMubmFtZSl9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+' +
  'PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0iYWxpZ24taXRlbXM6ZmxleC1lbmQ7Z2FwOjZweCI+CiAgICAg' +
  'ICAgICA8ZGl2IGNsYXNzPSJmaWVsZCIgc3R5bGU9ImZsZXg6MTttYXJnaW46MCI+PGxhYmVsPkZyb208L2xhYmVsPjxpbnB1dCB0' +
  'eXBlPSJkYXRlIiBpZD0iaV9zdGFydCIgdmFsdWU9IiR7Zmlyc3RPZk1vbnRoKCl9Ij48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xh' +
  'c3M9ImZpZWxkIiBzdHlsZT0iZmxleDoxO21hcmdpbjowIj48bGFiZWw+VG88L2xhYmVsPjxpbnB1dCB0eXBlPSJkYXRlIiBpZD0i' +
  'aV9lbmQiIHZhbHVlPSIke3RvZGF5SVNPKCl9Ij48L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYg' +
  'Y2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0i' +
  'aV9wcmV2Ij5QcmV2aWV3PC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0iaV9tYWtlIj5DcmVhdGUg' +
  'aW52b2ljZTwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBpZD0iaV9vdXQiPjwvZGl2PgogICAgICAke2ludm9pY2Vz' +
  'Lmxlbmd0aCA/IGA8dGFibGUgY2xhc3M9InRibCIgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+CiAgICAgICAgPHRyPjx0aD5DbGll' +
  'bnQ8L3RoPjx0aD5QZXJpb2Q8L3RoPjx0aCBjbGFzcz0ibnVtIj5Kb2JzPC90aD48dGggY2xhc3M9Im51bSI+VG90YWw8L3RoPjx0' +
  'aD48L3RoPjx0aD48L3RoPjwvdHI+CiAgICAgICAgJHtpbnZvaWNlcy5tYXAocyA9PiBgPHRyPgogICAgICAgICAgPHRkPiR7ZXNj' +
  'KHMuY2xpZW50X25hbWUpfTwvdGQ+PHRkPiR7Zm10RGF0ZU9ubHkocy5wZXJpb2Rfc3RhcnQpfeKAkyR7Zm10RGF0ZU9ubHkocy5w' +
  'ZXJpb2RfZW5kKX08L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPiR7cy5qb2JfY291bnR9PC90ZD48dGQgY2xhc3M9Im51' +
  'bSI+JHttb25leShzLnRvdGFsKX08L3RkPgogICAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJwaWxsICR7Y2xzKHMuc3RhdHVzKX0i' +
  'PiR7ZXNjKHMuc3RhdHVzKX08L3NwYW4+PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIvcHJpbnQvaW52' +
  'b2ljZS8ke3MuaWR9IiB0YXJnZXQ9Il9ibGFuayI+cHJpbnQ8L2E+CiAgICAgICAgICAgICR7cy5zdGF0dXMgIT09ICdQYWlkJyA/' +
  'IGAgwrcgPGEgaHJlZj0iIyIgZGF0YS1pcGFpZD0iJHtzLmlkfSI+bWFyayBwYWlkPC9hPmAgOiAnJ308L3RkPgogICAgICAgIDwv' +
  'dHI+YCkuam9pbignJyl9PC90YWJsZT5gIDogJyd9CiAgICA8L2Rpdj5gKTsKICBiaW5kU2hlbGwoKTsKCiAgY29uc3QgbGluZXNU' +
  'YWJsZSA9IChyLCBrZXkpID0+IHIubGluZXMubGVuZ3RoCiAgICA/IGA8dGFibGUgY2xhc3M9InRibCIgc3R5bGU9Im1hcmdpbi10' +
  'b3A6MTBweCI+PHRyPjx0aD5EYXRlPC90aD48dGg+Sm9iPC90aD48dGg+UmVjaXBpZW50PC90aD48dGggY2xhc3M9Im51bSI+JHtr' +
  'ZXkgPT09ICdwYXknID8gJ1BheScgOiAnRmVlJ308L3RoPjwvdHI+CiAgICAgICAke3IubGluZXMubWFwKGwgPT4gYDx0cj48dGQ+' +
  'JHtmbXREYXRlT25seShsLnNlcnZlZF9hdCl9PC90ZD48dGQ+JHtlc2MobC5qb2JfbnVtYmVyKX08L3RkPgogICAgICAgPHRkPiR7' +
  'ZXNjKGwucmVjaXBpZW50X25hbWUpfTwvdGQ+PHRkIGNsYXNzPSJudW0iPiR7bW9uZXkoa2V5ID09PSAncGF5JyA/IGwuc2VydmVy' +
  'X3BheSA6IGwuY2xpZW50X2ZlZSl9PC90ZD48L3RyPmApLmpvaW4oJycpfQogICAgICAgPHRyPjx0ZCBjb2xzcGFuPSIzIj48Yj4k' +
  'e3IuY291bnR9IGpvYihzKTwvYj48L3RkPjx0ZCBjbGFzcz0ibnVtIj48Yj4ke21vbmV5KHIudG90YWwpfTwvYj48L3RkPjwvdHI+' +
  'PC90YWJsZT5gCiAgICA6ICc8ZGl2IGNsYXNzPSJoaW50Ij5Ob3RoaW5nIHVuYmlsbGVkIGluIHRoYXQgd2luZG93LjwvZGl2Pic7' +
  'CgogICQoJyNzX3ByZXYnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgY29uc3QgciA9IGF3YWl0IGFwaSgnL3N0YXRlbWVu' +
  'dHMvcHJldmlldycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KAogICAgICB7IHNlcnZlcl9pZDogJCgn' +
  'I3Nfc2VydmVyJykudmFsdWUsIHN0YXJ0OiAkKCcjc19zdGFydCcpLnZhbHVlLCBlbmQ6ICQoJyNzX2VuZCcpLnZhbHVlIH0pIH0p' +
  'OwogICAgJCgnI3Nfb3V0JykuaW5uZXJIVE1MID0gbGluZXNUYWJsZShyLCAncGF5Jyk7CiAgfTsKICAkKCcjc19tYWtlJykub25j' +
  'bGljayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGF3YWl0IGFwaSgnL3N0YXRlbWVudHMnLCB7IG1ldGhvZDogJ1BP' +
  'U1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSgKICAgICAgICB7IHNlcnZlcl9pZDogJCgnI3Nfc2VydmVyJykudmFsdWUsIHN0YXJ0' +
  'OiAkKCcjc19zdGFydCcpLnZhbHVlLCBlbmQ6ICQoJyNzX2VuZCcpLnZhbHVlIH0pIH0pOwogICAgICB0b2FzdCgnU3RhdGVtZW50' +
  'IGNyZWF0ZWQnKTsgZ28oJ21vbmV5Jyk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9Owog' +
  'ICQoJyNpX3ByZXYnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgY29uc3QgciA9IGF3YWl0IGFwaSgnL2ludm9pY2VzL3By' +
  'ZXZpZXcnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSgKICAgICAgeyBjbGllbnRfaWQ6ICQoJyNpX2Ns' +
  'aWVudCcpLnZhbHVlLCBzdGFydDogJCgnI2lfc3RhcnQnKS52YWx1ZSwgZW5kOiAkKCcjaV9lbmQnKS52YWx1ZSB9KSB9KTsKICAg' +
  'ICQoJyNpX291dCcpLmlubmVySFRNTCA9IGxpbmVzVGFibGUociwgJ2ZlZScpOwogIH07CiAgJCgnI2lfbWFrZScpLm9uY2xpY2sg' +
  'PSBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBhd2FpdCBhcGkoJy9pbnZvaWNlcycsIHsgbWV0aG9kOiAnUE9TVCcsIGJv' +
  'ZHk6IEpTT04uc3RyaW5naWZ5KAogICAgICAgIHsgY2xpZW50X2lkOiAkKCcjaV9jbGllbnQnKS52YWx1ZSwgc3RhcnQ6ICQoJyNp' +
  'X3N0YXJ0JykudmFsdWUsIGVuZDogJCgnI2lfZW5kJykudmFsdWUgfSkgfSk7CiAgICAgIHRvYXN0KCdJbnZvaWNlIGNyZWF0ZWQn' +
  'KTsgZ28oJ21vbmV5Jyk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9OwogIGRvY3VtZW50' +
  'LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBhaWRdJykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGFzeW5jIGUgPT4gewogICAg' +
  'ZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgYXdhaXQgYXBpKCcvc3RhdGVtZW50cy8nICsgYS5kYXRhc2V0LnBhaWQsIHsgbWV0aG9k' +
  'OiAnUEFUQ0gnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHN0YXR1czogJ1BhaWQnIH0pIH0pOwogICAgdG9hc3QoJ01hcmtlZCBw' +
  'YWlkJyk7IGdvKCdtb25leScpOwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWlwYWlkXScpLmZvckVh' +
  'Y2goYSA9PiBhLm9uY2xpY2sgPSBhc3luYyBlID0+IHsKICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgIGF3YWl0IGFwaSgnL2lu' +
  'dm9pY2VzLycgKyBhLmRhdGFzZXQuaXBhaWQsIHsgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHN0YXR1' +
  'czogJ1BhaWQnIH0pIH0pOwogICAgdG9hc3QoJ01hcmtlZCBwYWlkJyk7IGdvKCdtb25leScpOwogIH0pOwp9CgpmdW5jdGlvbiBm' +
  'aXJzdE9mTW9udGgoKSB7CiAgY29uc3QgZCA9IG5ldyBEYXRlKCk7IHJldHVybiBuZXcgRGF0ZShkLmdldEZ1bGxZZWFyKCksIGQu' +
  'Z2V0TW9udGgoKSwgMSkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCk7Cn0KCmFzeW5jIGZ1bmN0aW9uIG15UGF5VmlldygpIHsK' +
  'ICBjb25zdCBbc3RhdGVtZW50cywgc3RhdHNdID0gYXdhaXQgUHJvbWlzZS5hbGwoW2FwaSgnL3N0YXRlbWVudHMnKSwgYXBpKCcv' +
  'c3RhdHMnKV0pOwogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8aDEgY2xhc3M9InBhZ2UiPk15IHBheTwvaDE+CiAgICA8' +
  'ZGl2IGNsYXNzPSJzdGF0cyI+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQgZ29vZCI+PGRpdiBjbGFzcz0ibiI+JHttb25leShzdGF0' +
  'cy51bmJpbGxlZCl9PC9kaXY+PGRpdiBjbGFzcz0ibCI+RWFybmVkLCBub3QgeWV0IG9uIGEgc3RhdGVtZW50PC9kaXY+PC9kaXY+' +
  'CiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxkaXYgY2xhc3M9Im4iPiR7c3RhdHMuc2VydmVkXzdkfTwvZGl2PjxkaXYgY2xhc3M9' +
  'ImwiPlNlcnZlcyBjb21wbGV0ZWQsIDcgZGF5czwvZGl2PjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj48' +
  'aDI+U3RhdGVtZW50czwvaDI+CiAgICAke3N0YXRlbWVudHMubGVuZ3RoID8gYDx0YWJsZSBjbGFzcz0idGJsIj4KICAgICAgPHRy' +
  'Pjx0aD5QZXJpb2Q8L3RoPjx0aCBjbGFzcz0ibnVtIj5Kb2JzPC90aD48dGggY2xhc3M9Im51bSI+VG90YWw8L3RoPjx0aD48L3Ro' +
  'Pjx0aD48L3RoPjwvdHI+CiAgICAgICR7c3RhdGVtZW50cy5tYXAocyA9PiBgPHRyPjx0ZD4ke2ZtdERhdGVPbmx5KHMucGVyaW9k' +
  'X3N0YXJ0KX3igJMke2ZtdERhdGVPbmx5KHMucGVyaW9kX2VuZCl9PC90ZD4KICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHtzLmpv' +
  'Yl9jb3VudH08L3RkPjx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KHMudG90YWwpfTwvdGQ+CiAgICAgICAgPHRkPjxzcGFuIGNsYXNz' +
  'PSJwaWxsICR7Y2xzKHMuc3RhdHVzKX0iPiR7ZXNjKHMuc3RhdHVzKX08L3NwYW4+PC90ZD4KICAgICAgICA8dGQgY2xhc3M9Im51' +
  'bSI+PGEgaHJlZj0iL3ByaW50L3N0YXRlbWVudC8ke3MuaWR9IiB0YXJnZXQ9Il9ibGFuayI+cHJpbnQ8L2E+PC90ZD48L3RyPmAp' +
  'LmpvaW4oJycpfQogICAgICA8L3RhYmxlPmAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPk5vIHN0YXRlbWVudHMgeWV0LjwvZGl2Pid9' +
  'CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImNhcmQiPjxoMj5DaGFuZ2UgcGFzc3dvcmQ8L2gyPgogICAgICA8ZGl2IGNsYXNz' +
  'PSJoaW50Ij5UaGlzIGlzIHlvdXIgb25lIHBhc3N3b3JkIGZvciBldmVyeSBhcHAuPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZp' +
  'ZWxkIj48aW5wdXQgaWQ9Im9wdyIgdHlwZT0icGFzc3dvcmQiIHBsYWNlaG9sZGVyPSJDdXJyZW50IHBhc3N3b3JkIj48L2Rpdj4K' +
  'ICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxpbnB1dCBpZD0ibnB3IiB0eXBlPSJwYXNzd29yZCIgcGxhY2Vob2xkZXI9Ik5ldyBw' +
  'YXNzd29yZCAoOCsgY2hhcmFjdGVycykiPjwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc20iIGlkPSJzYXZlUHciPlVw' +
  'ZGF0ZTwvYnV0dG9uPjwvZGl2PmApOwogIGJpbmRTaGVsbCgpOwogICQoJyNzYXZlUHcnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4g' +
  'ewogICAgdHJ5IHsKICAgICAgY29uc3QgciA9IGF3YWl0IGFwaSgnL21lL3Bhc3N3b3JkJywgeyBtZXRob2Q6ICdQT1NUJywgYm9k' +
  'eTogSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHBhc3N3b3JkOiAkKCcjbnB3JykudmFsdWUsIG9sZF9wYXNzd29yZDogJCgnI29w' +
  'dycpLnZhbHVlIH0pIH0pOwogICAgICAkKCcjb3B3JykudmFsdWUgPSAnJzsgJCgnI25wdycpLnZhbHVlID0gJyc7CiAgICAgIHRv' +
  'YXN0KHIuZXZlcnl3aGVyZSA9PT0gZmFsc2UgPyAnQ2hhbmdlZCBoZXJlIOKAlCBvdGhlciBhcHBzIHN0aWxsIGhhdmUgdGhlIG9s' +
  'ZCBvbmUnIDogJ1Bhc3N3b3JkIHVwZGF0ZWQgZXZlcnl3aGVyZScpOwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2Us' +
  'IHRydWUpOyB9CiAgfTsKfQoKCmZ1bmN0aW9uIGNvZGVzVGFibGUobGlzdCkgewogIGlmICghbGlzdC5sZW5ndGgpIHJldHVybiAn' +
  'PGRpdiBjbGFzcz0iaGludCI+Tm8gY29kZXMgeWV0LjwvZGl2Pic7CiAgcmV0dXJuIGA8dGFibGUgY2xhc3M9InRibCI+CiAgICA8' +
  'dHI+PHRoPkNvZGU8L3RoPjx0aD5HcmFudHM8L3RoPjx0aD5Vc2VkPC90aD48dGg+PC90aD48dGg+PC90aD48L3RyPgogICAgJHts' +
  'aXN0Lm1hcChjID0+IGA8dHI+CiAgICAgIDx0ZD48c3BhbiBzdHlsZT0iZm9udDo2MDAgMTNweCBtb25vc3BhY2U7bGV0dGVyLXNw' +
  'YWNpbmc6LjVweCI+JHtlc2MoYy5jb2RlKX08L3NwYW4+CiAgICAgICAgJHtjLm5vdGUgPyBgPGRpdiBjbGFzcz0iaGludCI+JHtl' +
  'c2MoYy5ub3RlKX08L2Rpdj5gIDogJyd9CiAgICAgICAgJHtjLnJlZGVtcHRpb25zICYmIGMucmVkZW1wdGlvbnMubGVuZ3RoID8g' +
  'YDxkaXYgY2xhc3M9ImhpbnQiPiR7Yy5yZWRlbXB0aW9ucy5tYXAociA9PiBlc2Moci5lbWFpbCkpLmpvaW4oJywgJyl9PC9kaXY+' +
  'YCA6ICcnfTwvdGQ+CiAgICAgIDx0ZD4ke2Mucm9sZSA9PT0gJ2FkbWluJyA/ICdBZG1pbicgOiAnRmllbGQgc2VydmVyJ30KICAg' +
  'ICAgICAke2MuZXhwaXJlc19hdCA/IGA8ZGl2IGNsYXNzPSJoaW50Ij50byAke2ZtdERhdGVPbmx5KGMuZXhwaXJlc19hdCl9PC9k' +
  'aXY+YCA6ICcnfTwvdGQ+CiAgICAgIDx0ZD4ke2MudXNlZF9jb3VudH0vJHtjLm1heF91c2VzfTwvdGQ+CiAgICAgIDx0ZD48c3Bh' +
  'biBjbGFzcz0icGlsbCAke2Muc3RhdGUgPT09ICdBY3RpdmUnID8gJ1NlcnZlZCcgOiAnJ30iPiR7ZXNjKGMuc3RhdGUpfTwvc3Bh' +
  'bj48L3RkPgogICAgICA8dGQgY2xhc3M9Im51bSI+CiAgICAgICAgPGEgaHJlZj0iIyIgZGF0YS1jb3B5PSIke2VzYyhjLmNvZGUp' +
  'fSI+Y29weTwvYT4KICAgICAgICAke2Muc3RhdGUgPT09ICdBY3RpdmUnID8gYCDCtyA8YSBocmVmPSIjIiBkYXRhLXJldm9rZT0i' +
  'JHtjLmlkfSI+cmV2b2tlPC9hPmAgOiAnJ30KICAgICAgPC90ZD48L3RyPmApLmpvaW4oJycpfTwvdGFibGU+YDsKfQoKLyogLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gYWRtaW4gLS0gKi8KYXN5' +
  'bmMgZnVuY3Rpb24gYWRtaW5WaWV3KCkgewogIC8vIEZldGNoIGV2ZXJ5dGhpbmcgYmVmb3JlIGRyYXdpbmcuIFBvcHVsYXRpbmcg' +
  'Y2FyZHMgYWZ0ZXIgcmVuZGVyIG1hZGUgdGhlCiAgLy8gcGFnZSBncm93IHVuZGVyIHRoZSB1c2VyJ3MgZmluZ2VyLCBzbyBhIHRh' +
  'cCBjb3VsZCBsYW5kIG9uIHRoZSB3cm9uZyByb3cuCiAgY29uc3QgW3VzZXJzLCBjbGllbnRzLCB0ZW1wbGF0ZXMsIGNvZGVzLCBw' +
  'b3J0YWxzLCBjb21wYW5pZXNdID0gYXdhaXQgUHJvbWlzZS5hbGwoWwogICAgYXBpKCcvdXNlcnMnKSwgYXBpKCcvY2xpZW50cycp' +
  'LCBhcGkoJy90ZW1wbGF0ZXMnKSwKICAgIGFwaSgnL2NvZGVzJykuY2F0Y2goKCkgPT4gW10pLCBhcGkoJy9wb3J0YWxzJykuY2F0' +
  'Y2goKCkgPT4gW10pLAogICAgYXBpKCcvY29tcGFuaWVzJykuY2F0Y2goKCkgPT4gW10pCiAgXSk7CiAgY29uc3QgaGVyZSA9IGNv' +
  'bXBhbmllcy5maW5kKGMgPT4gUy5tZS5jb21wYW55ICYmIGMuaWQgPT09IFMubWUuY29tcGFueS5pZCkgfHwgY29tcGFuaWVzWzBd' +
  'IHx8IHt9OwogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8aDEgY2xhc3M9InBhZ2UiPlNldHVwPC9oMT4KCiAgICA8ZGl2' +
  'IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPiR7aXNPd25lcigpID8gJ1RoaXMgY29tcGFueScgOiAnWW91ciBjb21wYW55J30KICAg' +
  'ICAgICA8c3BhbiBjbGFzcz0ic3ViIj4ke2VzYyhoZXJlLnBsYW4gPT09ICdwcm8nID8gJ1BybycgOiAnRnJlZScpfSR7CiAgICAg' +
  'ICAgICBoZXJlLnBsYW5fZXhwaXJlcyA/ICcgdW50aWwgJyArIGZtdERhdGVPbmx5KGhlcmUucGxhbl9leHBpcmVzKSA6ICcnfTwv' +
  'c3Bhbj48L2gyPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk5hbWU8L2xhYmVsPjxpbnB1dCBpZD0iY29OYW1lIiB2' +
  'YWx1ZT0iJHtlc2MoaGVyZS5uYW1lIHx8ICcnKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNvbnRh' +
  'Y3QgZW1haWw8L2xhYmVsPjxpbnB1dCBpZD0iY29FbWFpbCIgdmFsdWU9IiR7ZXNjKGhlcmUuY29udGFjdF9lbWFpbCB8fCAnJyl9' +
  'Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5QaG9uZTwvbGFiZWw+PGlucHV0IGlkPSJjb1Bob25lIiB2' +
  'YWx1ZT0iJHtlc2MoaGVyZS5waG9uZSB8fCAnJyl9Ij48L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0iY29T' +
  'YXZlIj5TYXZlPC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+VGhpcyBuYW1l' +
  'IGFwcGVhcnMgb24geW91ciBpbnZvaWNlcyBhbmQgcGF5IHN0YXRlbWVudHMuPC9kaXY+CiAgICA8L2Rpdj4KCiAgICAke2lzT3du' +
  'ZXIoKSA/IGA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkFsbCBjb21wYW5pZXMgPHNwYW4gY2xhc3M9InN1YiI+JHtjb21w' +
  'YW5pZXMubGVuZ3RofTwvc3Bhbj48L2gyPgogICAgICA8dGFibGUgY2xhc3M9InRibCI+CiAgICAgICAgPHRyPjx0aD5Db21wYW55' +
  'PC90aD48dGggY2xhc3M9Im51bSI+UGVvcGxlPC90aD48dGggY2xhc3M9Im51bSI+T3BlbjwvdGg+PHRoPjwvdGg+PC90cj4KICAg' +
  'ICAgICAke2NvbXBhbmllcy5tYXAoYyA9PiBgPHRyPgogICAgICAgICAgPHRkPiR7ZXNjKGMubmFtZSl9JHtTLm1lLmNvbXBhbnkg' +
  'JiYgYy5pZCA9PT0gUy5tZS5jb21wYW55LmlkID8gJyA8c3BhbiBjbGFzcz0icGlsbCI+eW91IGFyZSBoZXJlPC9zcGFuPicgOiAn' +
  'J30KICAgICAgICAgICAgPGRpdiBjbGFzcz0iaGludCI+JHtlc2MoYy5hZG1pbl9lbWFpbCB8fCAnbm8gYWRtaW4geWV0Jyl9IMK3' +
  'ICR7Yy5wbGFuID09PSAncHJvJyA/ICdQcm8nIDogJ0ZyZWUnfTwvZGl2PjwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+' +
  'JHtjLnBlb3BsZSA/PyAn4oCUJ308L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPiR7Yy5vcGVuX2pvYnMgPz8gJ+KAlCd9' +
  'PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke1MubWUuY29tcGFueSAmJiBjLmlkID09PSBTLm1lLmNvbXBhbnkuaWQK' +
  'ICAgICAgICAgICAgPyAnJyA6IGA8YSBocmVmPSIjIiBkYXRhLWVudGVyPSIke2MuaWR9Ij5lbnRlcjwvYT5gfTwvdGQ+PC90cj5g' +
  'KS5qb2luKCcnKX0KICAgICAgPC90YWJsZT4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgi' +
  'PjxsYWJlbD5TdGFydCBhbm90aGVyIGNvbXBhbnk8L2xhYmVsPgogICAgICAgIDxpbnB1dCBpZD0ibmV3Q29OYW1lIiBwbGFjZWhv' +
  'bGRlcj0iQ29tcGFueSBuYW1lIj48L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0ibmV3Q28iPkNyZWF0ZSBj' +
  'b21wYW55PC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+Q3JlYXRpbmcgYSBj' +
  'b21wYW55IGdpdmVzIGl0IGl0cyBvd24gam9icywgY2xpZW50cyBhbmQKICAgICAgICBiaWxsaW5nLiBBZGQgaXRzIGFkbWluaXN0' +
  'cmF0b3IgZnJvbSBpbnNpZGUgaXQsIG9yIGhhbmQgdGhlbSBhbiBhY2Nlc3MgY29kZS48L2Rpdj4KICAgIDwvZGl2PmAgOiAnJ30K' +
  'CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPlRlYW0gPHNwYW4gY2xhc3M9InN1YiI+JHt1c2Vycy5sZW5ndGh9PC9z' +
  'cGFuPjwvaDI+CiAgICAgIDx0YWJsZSBjbGFzcz0idGJsIj4KICAgICAgICA8dHI+PHRoPk5hbWU8L3RoPjx0aD5Sb2xlPC90aD48' +
  'dGggY2xhc3M9Im51bSI+UmF0ZTwvdGg+PHRoPjwvdGg+PC90cj4KICAgICAgICAke3VzZXJzLm1hcCh1ID0+IGA8dHI+PHRkPiR7' +
  'ZXNjKHUubmFtZSl9PGRpdiBjbGFzcz0iaGludCI+JHtlc2ModS5lbWFpbCl9PC9kaXY+PC90ZD4KICAgICAgICAgIDx0ZD4ke2Vz' +
  'Yyh1LnJvbGUpfSR7dS5hY3RpdmUgPyAnJyA6ICcgPHNwYW4gY2xhc3M9InBpbGwiPm9mZjwvc3Bhbj4nfTwvdGQ+CiAgICAgICAg' +
  'ICA8dGQgY2xhc3M9Im51bSI+JHttb25leSh1LmRlZmF1bHRfcGF5KX08L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPjxh' +
  'IGhyZWY9IiMiIGRhdGEtdXNlcj0iJHt1LmlkfSI+ZWRpdDwvYT48L3RkPjwvdHI+YCkuam9pbignJyl9CiAgICAgIDwvdGFibGU+' +
  'CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgYmxvY2sgc20iIGlkPSJuZXdVc2VyIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4' +
  'Ij4rIEFkZCBwZXJzb248L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+Q2xpZW50' +
  'cyA8c3BhbiBjbGFzcz0ic3ViIj4ke2NsaWVudHMubGVuZ3RofTwvc3Bhbj48L2gyPgogICAgICA8dGFibGUgY2xhc3M9InRibCI+' +
  'CiAgICAgICAgPHRyPjx0aD5OYW1lPC90aD48dGggY2xhc3M9Im51bSI+RGVmYXVsdCBmZWU8L3RoPjx0aD48L3RoPjwvdHI+CiAg' +
  'ICAgICAgJHtjbGllbnRzLm1hcChjID0+IGA8dHI+PHRkPiR7ZXNjKGMubmFtZSl9PGRpdiBjbGFzcz0iaGludCI+JHtlc2MoYy5j' +
  'b250YWN0X25hbWUgfHwgJycpfSAke2VzYyhjLnBob25lIHx8ICcnKX08L2Rpdj48L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJu' +
  'dW0iPiR7bW9uZXkoYy5kZWZhdWx0X2ZlZSl9PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIjIiBkYXRh' +
  'LWNsaWVudD0iJHtjLmlkfSI+ZWRpdDwvYT48L3RkPjwvdHI+YCkuam9pbignJyl9CiAgICAgIDwvdGFibGU+CiAgICAgIDxidXR0' +
  'b24gY2xhc3M9ImJ0biBzZWMgYmxvY2sgc20iIGlkPSJuZXdDbGllbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPisgQWRkIGNs' +
  'aWVudDwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5BZmZpZGF2aXQgdGVtcGxh' +
  'dGVzIDxzcGFuIGNsYXNzPSJzdWIiPiR7dGVtcGxhdGVzLmxlbmd0aH08L3NwYW4+PC9oMj4KICAgICAgPHAgY2xhc3M9ImhpbnQi' +
  'IHN0eWxlPSJtYXJnaW4tdG9wOi00cHgiPldyaXRlIHlvdXIgb3duIHdvcmRpbmcgcGVyIGNvdW50eSBvciBjbGllbnQuIE1lcmdl' +
  'IGZpZWxkcyBmaWxsIGluIGZyb20gdGhlIGpvYiwKICAgICAgaW5jbHVkaW5nIHRoZSBmdWxsIGF0dGVtcHQgbG9nIHdpdGggR1BT' +
  'LjwvcD4KICAgICAgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgICAgICR7dGVtcGxhdGVzLm1hcCh0ID0+IGA8dHI+PHRkPiR7ZXNj' +
  'KHQubmFtZSl9PGRpdiBjbGFzcz0iaGludCI+JHtlc2ModC5qdXJpc2RpY3Rpb24gfHwgJycpfTwvZGl2PjwvdGQ+CiAgICAgICAg' +
  'ICA8dGQ+JHt0LmlzX2RlZmF1bHQgPyAnPHNwYW4gY2xhc3M9InBpbGwgU2VydmVkIj5kZWZhdWx0PC9zcGFuPicgOiAnJ308L3Rk' +
  'PgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPjxhIGhyZWY9IiMiIGRhdGEtdHBsPSIke3QuaWR9Ij5lZGl0PC9hPjwvdGQ+PC90' +
  'cj5gKS5qb2luKCcnKX0KICAgICAgPC90YWJsZT4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBibG9jayBzbSIgaWQ9Im5l' +
  'd1RwbCIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+KyBOZXcgdGVtcGxhdGU8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxkaXYg' +
  'Y2xhc3M9ImNhcmQiPgogICAgICA8aDI+QWNjZXNzIGNvZGVzIDxzcGFuIGNsYXNzPSJzdWIiPmxldCBwZW9wbGUgc2V0IHVwIHRo' +
  'ZWlyIG93biBhY2NvdW50PC9zcGFuPjwvaDI+CiAgICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDotNHB4Ij5H' +
  'ZW5lcmF0ZSBhIGNvZGUgYW5kIHNlbmQgaXQgb3Zlci4gVGhleSBlbnRlciBpdCBvbiB0aGUgc2lnbi1pbgogICAgICAgIHNjcmVl' +
  'biB1bmRlciAiU2V0IHVwIHlvdXIgYWNjb3VudCIsIHBpY2sgdGhlaXIgb3duIHBhc3N3b3JkLCBhbmQgdGhleSdyZSBpbiDigJQg' +
  'bm8gbmVlZCB0byBrZXkgaW4KICAgICAgICB0aGVpciBkZXRhaWxzIG9yIHNoYXJlIGEgcGFzc3dvcmQgd2l0aCB0aGVtLjwvcD4K' +
  'ICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMyIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmll' +
  'bGQiPjxsYWJlbD5UaGV5IGJlY29tZTwvbGFiZWw+PHNlbGVjdCBpZD0iY19yb2xlIj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9' +
  'InNlcnZlciI+RmllbGQgc2VydmVyPC9vcHRpb24+PG9wdGlvbiB2YWx1ZT0iYWRtaW4iPkFkbWluPC9vcHRpb24+PC9zZWxlY3Q+' +
  'PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Ib3cgbWFueSBjYW4gdXNlIGl0PC9sYWJlbD48aW5wdXQg' +
  'aWQ9ImNfdXNlcyIgdHlwZT0ibnVtYmVyIiBtaW49IjEiIG1heD0iNTAwIiB2YWx1ZT0iMSI+PC9kaXY+CiAgICAgICAgPGRpdiBj' +
  'bGFzcz0iZmllbGQiPjxsYWJlbD5FeHBpcmVzIChvcHRpb25hbCk8L2xhYmVsPjxpbnB1dCBpZD0iY19leHAiIHR5cGU9ImRhdGUi' +
  'PjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQi' +
  'PjxsYWJlbD5QYXkgcGVyIHNlcnZlIChmaWVsZCBzZXJ2ZXJzKTwvbGFiZWw+PGlucHV0IGlkPSJjX3BheSIgdHlwZT0ibnVtYmVy' +
  'IiBzdGVwPSIwLjAxIiBwbGFjZWhvbGRlcj0iNDUuMDAiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+' +
  'Tm90ZSB0byB5b3Vyc2VsZjwvbGFiZWw+PGlucHV0IGlkPSJjX25vdGUiIHBsYWNlaG9sZGVyPSJGb3IgTWFyaWEg4oCUIGV2aWN0' +
  'aW9ucyI+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc20iIGlkPSJjX21ha2UiPkdlbmVyYXRl' +
  'IGEgY29kZTwvYnV0dG9uPgogICAgICA8ZGl2IGlkPSJjX2xpc3QiIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPiR7Y29kZXNUYWJs' +
  'ZShjb2Rlcyl9PC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkNvdXJ0IHBvcnRhbCBw' +
  'cm9iZSA8c3BhbiBjbGFzcz0ic3ViIj5leHBlcmltZW50YWw8L3NwYW4+PC9oMj4KICAgICAgPHAgY2xhc3M9ImhpbnQiIHN0eWxl' +
  'PSJtYXJnaW4tdG9wOi00cHgiPkFza3MgdGhlIHNlcnZlciB0byBmZXRjaCBhIGNvdW50eSBwb3J0YWwgYW5kIHJlcG9ydCB3aGF0' +
  'IGNhbWUgYmFjayDigJQKICAgICAgICBzdGF0dXMsIGNvb2tpZXMsIGZvcm1zLCBsaW5rcy4gVGhpcyBpcyB0aGUgZ3JvdW5kd29y' +
  'ayBmb3IgYXV0b21hdGljIGNhc2UgbG9va3VwOiB0aGVzZSBwb3J0YWxzIGNhbid0IGJlCiAgICAgICAgcmVhY2hlZCBmcm9tIHdo' +
  'ZXJlIHRoaXMgYXBwIHdhcyB3cml0dGVuLCBzbyB0aGUgc2VydmVyIGhhcyB0byBnbyBhbmQgbG9vay4gUnVuIG9uZSBhbmQgc2Vu' +
  'ZCBtZSB0aGUgcmVzdWx0LjwvcD4KICAgICAgPGRpdiBjbGFzcz0icm93IiBpZD0icHJvYmVCdG5zIiBzdHlsZT0ibWFyZ2luLXRv' +
  'cDoxMHB4Ij4ke3BvcnRhbHMubWFwKHB0ID0+CiAgICAgICAgYDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGRhdGEtcHJvYmU9' +
  'IiR7ZXNjKHB0LmtleSl9Ij4ke2VzYyhwdC5sYWJlbCl9PC9idXR0b24+YCkuam9pbignJyl9PC9kaXY+CiAgICAgIDxkaXYgY2xh' +
  'c3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICAgICAgPGlucHV0IGlkPSJwcm9iZVVybCIgcGxhY2Vob2xkZXI9' +
  'IuKApm9yIGEgc3BlY2lmaWMgcGFnZSBVUkwiIHN0eWxlPSJmbGV4OjE7bWluLXdpZHRoOjE1MHB4Ij4KICAgICAgICA8YnV0dG9u' +
  'IGNsYXNzPSJidG4gc2VjIHNtIiBpZD0icHJvYmVHbyI+UHJvYmUgVVJMPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8cHJl' +
  'IGNsYXNzPSJwcmV2IiBpZD0icHJvYmVPdXQiIHN0eWxlPSJkaXNwbGF5Om5vbmU7bWFyZ2luLXRvcDoxMHB4Ij48L3ByZT4KICAg' +
  'ICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSBibG9jayIgaWQ9ImNvcHlQcm9iZSIgc3R5bGU9ImRpc3BsYXk6bm9uZTttYXJn' +
  'aW4tdG9wOjhweCI+Q29weSByZXN1bHQ8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8' +
  'aDI+TXkgYWNjb3VudDwvaDI+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPk9uZSBwYXNzd29yZCwgZXZlcnkgYXBwLiBDaGFuZ2lu' +
  'ZyBpdCBoZXJlIGNoYW5nZXMgaXQgZXZlcnl3aGVyZS48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5DdXJy' +
  'ZW50IHBhc3N3b3JkPC9sYWJlbD48aW5wdXQgaWQ9Im9wdyIgdHlwZT0icGFzc3dvcmQiIHBsYWNlaG9sZGVyPSJ0aGUgb25lIHlv' +
  'dSBzaWduZWQgaW4gd2l0aCI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+TmV3IHBhc3N3b3JkPC9sYWJl' +
  'bD48aW5wdXQgaWQ9Im5wdyIgdHlwZT0icGFzc3dvcmQiIHBsYWNlaG9sZGVyPSI4KyBjaGFyYWN0ZXJzIj48L2Rpdj4KICAgICAg' +
  'PGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0ic2F2ZVB3Ij5VcGRhdGUgcGFzc3dvcmQ8L2J1dHRvbj4KICAgICAgPGRpdiBjbGFz' +
  'cz0iaGludCIgaWQ9ImJ1aWxkU3RhbXAiIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPmJ1aWxkIOKApjwvZGl2PgogICAgPC9kaXY+' +
  'YCk7CiAgYmluZFNoZWxsKCk7CgogIGZldGNoKCcvYXBpL2J1aWxkJykudGhlbihyID0+IHIuanNvbigpKS50aGVuKGIgPT4gewog' +
  'ICAgY29uc3QgZWwgPSAkKCcjYnVpbGRTdGFtcCcpOwogICAgaWYgKGVsKSBlbC50ZXh0Q29udGVudCA9ICdTZXJ2ZVRyYWNrIGJ1' +
  'aWxkICcgKyBiLmJ1aWxkICsgKGIucHJvYmVUYXJnZXRzID8gJyDCtyBib290IHByb2JlIGFybWVkJyA6ICcnKTsKICB9KS5jYXRj' +
  'aCgoKSA9PiB7fSk7CgoKICAvKiAtLS0tIGFjY2VzcyBjb2RlcyAtLS0tICovCiAgYXN5bmMgZnVuY3Rpb24gZHJhd0NvZGVzKCkg' +
  'ewogICAgJCgnI2NfbGlzdCcpLmlubmVySFRNTCA9IGNvZGVzVGFibGUoYXdhaXQgYXBpKCcvY29kZXMnKSk7CiAgICB3aXJlQ29k' +
  'ZXMoKTsKICB9CgogIGZ1bmN0aW9uIHdpcmVDb2RlcygpIHsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWNv' +
  'cHldJykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGFzeW5jIGUgPT4gewogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAg' +
  'IHRyeSB7IGF3YWl0IG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KGEuZGF0YXNldC5jb3B5KTsgdG9hc3QoJ0NvcGllZCAn' +
  'ICsgYS5kYXRhc2V0LmNvcHkpOyB9CiAgICAgIGNhdGNoIChlcnIpIHsgdG9hc3QoJ1NlbGVjdCBpdCBhbmQgY29weSBieSBoYW5k' +
  'JywgdHJ1ZSk7IH0KICAgIH0pOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcmV2b2tlXScpLmZvckVhY2go' +
  'YSA9PiBhLm9uY2xpY2sgPSBhc3luYyBlID0+IHsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBpZiAoIWNvbmZpcm0o' +
  'J1Jldm9rZSB0aGlzIGNvZGU/IEFueW9uZSB3aG8gYWxyZWFkeSB1c2VkIGl0IGtlZXBzIHRoZWlyIGFjY291bnQuJykpIHJldHVy' +
  'bjsKICAgICAgYXdhaXQgYXBpKCcvY29kZXMvJyArIGEuZGF0YXNldC5yZXZva2UsIHsgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBK' +
  'U09OLnN0cmluZ2lmeSh7IHJldm9rZWQ6IHRydWUgfSkgfSk7CiAgICAgIHRvYXN0KCdSZXZva2VkJyk7IGRyYXdDb2RlcygpOwog' +
  'ICAgfSk7CiAgfQogIHdpcmVDb2RlcygpOwoKICAkKCcjY19tYWtlJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7' +
  'CiAgICAgIGNvbnN0IG1hZGUgPSBhd2FpdCBhcGkoJy9jb2RlcycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5n' +
  'aWZ5KHsKICAgICAgICByb2xlOiAkKCcjY19yb2xlJykudmFsdWUsCiAgICAgICAgbWF4X3VzZXM6ICQoJyNjX3VzZXMnKS52YWx1' +
  'ZSwKICAgICAgICBleHBpcmVzX2F0OiAkKCcjY19leHAnKS52YWx1ZSB8fCBudWxsLAogICAgICAgIGRlZmF1bHRfcGF5OiAkKCcj' +
  'Y19wYXknKS52YWx1ZSB8fCAwLAogICAgICAgIG5vdGU6ICQoJyNjX25vdGUnKS52YWx1ZQogICAgICB9KSB9KTsKICAgICAgJCgn' +
  'I2Nfbm90ZScpLnZhbHVlID0gJyc7CiAgICAgIHRvYXN0KCdDb2RlICcgKyBtYWRlLmNvZGUpOwogICAgICBkcmF3Q29kZXMoKTsK' +
  'ICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07CiAgZHJhd0NvZGVzKCkuY2F0Y2goKCkgPT4g' +
  'e30pOwoKICAvKiAtLS0tIHBvcnRhbCBwcm9iZSAtLS0tICovCiAgY29uc3QgcHJvYmVPdXQgPSAkKCcjcHJvYmVPdXQnKTsKICBj' +
  'b25zdCBydW5Qcm9iZSA9IGFzeW5jIGJvZHkgPT4gewogICAgcHJvYmVPdXQuc3R5bGUuZGlzcGxheSA9ICcnOwogICAgcHJvYmVP' +
  'dXQudGV4dENvbnRlbnQgPSAnUHJvYmluZ+KApiAodGhpcyBjYW4gdGFrZSB1cCB0byAyMCBzZWNvbmRzKSc7CiAgICAkKCcjY29w' +
  'eVByb2JlJykuc3R5bGUuZGlzcGxheSA9ICcnOwogICAgdHJ5IHsKICAgICAgY29uc3QgciA9IGF3YWl0IGFwaSgnL3BvcnRhbC1w' +
  'cm9iZScsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pOwogICAgICBwcm9iZU91dC50ZXh0' +
  'Q29udGVudCA9IEpTT04uc3RyaW5naWZ5KHIsIG51bGwsIDIpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBwcm9iZU91dC50ZXh0' +
  'Q29udGVudCA9ICdQcm9iZSBmYWlsZWQ6ICcgKyBlLm1lc3NhZ2U7CiAgICB9CiAgfTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9y' +
  'QWxsKCdbZGF0YS1wcm9iZV0nKS5mb3JFYWNoKGIgPT4KICAgIGIub25jbGljayA9ICgpID0+IHJ1blByb2JlKHsgcG9ydGFsOiBi' +
  'LmRhdGFzZXQucHJvYmUgfSkpOwogICQoJyNwcm9iZUdvJykub25jbGljayA9ICgpID0+IHsKICAgIGNvbnN0IHUgPSAkKCcjcHJv' +
  'YmVVcmwnKS52YWx1ZS50cmltKCk7CiAgICBpZiAodSkgcnVuUHJvYmUoeyB1cmw6IHUgfSk7CiAgfTsKICAkKCcjY29weVByb2Jl' +
  'Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7IGF3YWl0IG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KHBy' +
  'b2JlT3V0LnRleHRDb250ZW50KTsgdG9hc3QoJ0NvcGllZCcpOyB9CiAgICBjYXRjaCAoZSkgeyB0b2FzdCgnU2VsZWN0IHRoZSB0' +
  'ZXh0IGFuZCBjb3B5IGl0IGJ5IGhhbmQnLCB0cnVlKTsgfQogIH07CgogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRh' +
  'LXVzZXJdJykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGUgPT4gewogICAgZS5wcmV2ZW50RGVmYXVsdCgpOyB1c2VyRm9ybSh1' +
  'c2Vycy5maW5kKHUgPT4gU3RyaW5nKHUuaWQpID09PSBhLmRhdGFzZXQudXNlcikpOwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2Vs' +
  'ZWN0b3JBbGwoJ1tkYXRhLWNsaWVudF0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNrID0gZSA9PiB7CiAgICBlLnByZXZlbnREZWZh' +
  'dWx0KCk7IGNsaWVudEZvcm0oY2xpZW50cy5maW5kKGMgPT4gU3RyaW5nKGMuaWQpID09PSBhLmRhdGFzZXQuY2xpZW50KSk7CiAg' +
  'fSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdHBsXScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sgPSBlID0+' +
  'IHsKICAgIGUucHJldmVudERlZmF1bHQoKTsgdGVtcGxhdGVGb3JtKHRlbXBsYXRlcy5maW5kKHQgPT4gU3RyaW5nKHQuaWQpID09' +
  'PSBhLmRhdGFzZXQudHBsKSk7CiAgfSk7CiAgY29uc3QgY29TYXZlID0gJCgnI2NvU2F2ZScpOwogIGlmIChjb1NhdmUpIGNvU2F2' +
  'ZS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAgICAgYXdhaXQgYXBpKCcvY29tcGFuaWVzLycgKyAoaGVyZS5p' +
  'ZCksIHsgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgbmFtZTogJCgnI2NvTmFtZScpLnZh' +
  'bHVlLCBjb250YWN0X2VtYWlsOiAkKCcjY29FbWFpbCcpLnZhbHVlLCBwaG9uZTogJCgnI2NvUGhvbmUnKS52YWx1ZSB9KSB9KTsK' +
  'ICAgICAgUy5tZSA9IGF3YWl0IGFwaSgnL21lJyk7CiAgICAgIHRvYXN0KCdDb21wYW55IHNhdmVkJyk7CiAgICAgIHJlbmRlcigp' +
  'OwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKICBjb25zdCBuZXdDbyA9ICQoJyNuZXdD' +
  'bycpOwogIGlmIChuZXdDbykgbmV3Q28ub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIGNvbnN0IG5hbWUgPSAkKCcjbmV3Q29O' +
  'YW1lJykudmFsdWUudHJpbSgpOwogICAgaWYgKCFuYW1lKSByZXR1cm4gdG9hc3QoJ0dpdmUgdGhlIGNvbXBhbnkgYSBuYW1lJywg' +
  'dHJ1ZSk7CiAgICB0cnkgewogICAgICBhd2FpdCBhcGkoJy9jb21wYW5pZXMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09O' +
  'LnN0cmluZ2lmeSh7IG5hbWUgfSkgfSk7CiAgICAgIFMubWUgPSBhd2FpdCBhcGkoJy9tZScpOwogICAgICB0b2FzdChuYW1lICsg' +
  'JyBjcmVhdGVkJyk7CiAgICAgIHJlbmRlcigpOwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAg' +
  'fTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1lbnRlcl0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNrID0gYXN5' +
  'bmMgZSA9PiB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICB0cnkgewogICAgICBjb25zdCBvdXQgPSBhd2FpdCBhcGkoJy9j' +
  'b21wYW5pZXMvJyArIGEuZGF0YXNldC5lbnRlciArICcvZW50ZXInLCB7IG1ldGhvZDogJ1BPU1QnIH0pOwogICAgICBTLm1lID0g' +
  'YXdhaXQgYXBpKCcvbWUnKTsKICAgICAgdG9hc3QoJ05vdyBpbiAnICsgb3V0LmNvbXBhbnkubmFtZSk7CiAgICAgIHJlbmRlcigp' +
  'OwogICAgfSBjYXRjaCAoZXJyKSB7IHRvYXN0KGVyci5tZXNzYWdlLCB0cnVlKTsgfQogIH0pOwogICQoJyNuZXdVc2VyJykub25j' +
  'bGljayA9ICgpID0+IHVzZXJGb3JtKG51bGwpOwogICQoJyNuZXdDbGllbnQnKS5vbmNsaWNrID0gKCkgPT4gY2xpZW50Rm9ybShu' +
  'dWxsKTsKICAkKCcjbmV3VHBsJykub25jbGljayA9ICgpID0+IHRlbXBsYXRlRm9ybShudWxsKTsKICAkKCcjc2F2ZVB3Jykub25j' +
  'bGljayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9tZS9wYXNzd29yZCcsIHsg' +
  'bWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsKICAgICAgICBwYXNzd29yZDogJCgnI25wdycpLnZhbHVlLCBv' +
  'bGRfcGFzc3dvcmQ6ICQoJyNvcHcnKS52YWx1ZSB9KSB9KTsKICAgICAgJCgnI29wdycpLnZhbHVlID0gJyc7ICQoJyNucHcnKS52' +
  'YWx1ZSA9ICcnOwogICAgICB0b2FzdChyLmV2ZXJ5d2hlcmUgPT09IGZhbHNlID8gJ0NoYW5nZWQgaGVyZSDigJQgb3RoZXIgYXBw' +
  'cyBzdGlsbCBoYXZlIHRoZSBvbGQgb25lJyA6ICdQYXNzd29yZCB1cGRhdGVkIGV2ZXJ5d2hlcmUnKTsKICAgIH0gY2F0Y2ggKGUp' +
  'IHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07Cn0KCmZ1bmN0aW9uIHVzZXJGb3JtKHUpIHsKICBjb25zdCB2ID0gdSB8' +
  'fCB7IHJvbGU6ICdzZXJ2ZXInLCBhY3RpdmU6IHRydWUgfTsKICBzaGVldCh1ID8gJ0VkaXQgJyArIHUubmFtZSA6ICdBZGQgcGVy' +
  'c29uJywgYAogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5OYW1lPC9sYWJlbD48aW5wdXQgaWQ9InVfbmFtZSIgdmFsdWU9' +
  'IiR7ZXNjKHYubmFtZSl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RW1haWwgKHVzZWQgdG8gc2lnbiBp' +
  'bik8L2xhYmVsPjxpbnB1dCBpZD0idV9lbWFpbCIgdHlwZT0iZW1haWwiIHZhbHVlPSIke2VzYyh2LmVtYWlsKX0iPjwvZGl2Pgog' +
  'ICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD4ke3UgPyAnTmV3IHBhc3N3b3JkIChsZWF2ZSBibGFuayB0byBrZWVwKScgOiAn' +
  'UGFzc3dvcmQnfTwvbGFiZWw+PGlucHV0IGlkPSJ1X3Bhc3N3b3JkIiB0eXBlPSJ0ZXh0IiBwbGFjZWhvbGRlcj0iJHt1ID8gJ3Vu' +
  'Y2hhbmdlZCcgOiAnc2V0IGEgcGFzc3dvcmQnfSI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgPGRpdiBj' +
  'bGFzcz0iZmllbGQiPjxsYWJlbD5Sb2xlPC9sYWJlbD48c2VsZWN0IGlkPSJ1X3JvbGUiPgogICAgICAgIDxvcHRpb24gdmFsdWU9' +
  'InNlcnZlciIgJHt2LnJvbGUgPT09ICdzZXJ2ZXInID8gJ3NlbGVjdGVkJyA6ICcnfT5GaWVsZCBzZXJ2ZXI8L29wdGlvbj4KICAg' +
  'ICAgICA8b3B0aW9uIHZhbHVlPSJhZG1pbiIgJHt2LnJvbGUgPT09ICdhZG1pbicgPyAnc2VsZWN0ZWQnIDogJyd9PkFkbWluPC9v' +
  'cHRpb24+CiAgICAgICAgJHtpc093bmVyKCkgPyBgPG9wdGlvbiB2YWx1ZT0ib3duZXIiICR7di5yb2xlID09PSAnb3duZXInID8g' +
  'J3NlbGVjdGVkJyA6ICcnfT5Pd25lciAoZXZlcnkgY29tcGFueSk8L29wdGlvbj5gIDogJyd9CiAgICAgIDwvc2VsZWN0PjwvZGl2' +
  'PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkRlZmF1bHQgcGF5IHBlciBzZXJ2ZTwvbGFiZWw+PGlucHV0IGlkPSJ1' +
  'X2RlZmF1bHRfcGF5IiB0eXBlPSJudW1iZXIiIHN0ZXA9IjAuMDEiIHZhbHVlPSIke3YuZGVmYXVsdF9wYXkgfHwgJyd9Ij48L2Rp' +
  'dj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5QaG9uZTwvbGFiZWw+PGlucHV0IGlkPSJ1X3Bob25lIiB2YWx1ZT0i' +
  'JHtlc2Modi5waG9uZSl9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5MaWNlbnNlIC8gcmVnaXN0cmF0' +
  'aW9uICM8L2xhYmVsPjxpbnB1dCBpZD0idV9saWNlbnNlX25vIiB2YWx1ZT0iJHtlc2Modi5saWNlbnNlX25vKX0iPjwvZGl2Pgog' +
  'ICAgPC9kaXY+CiAgICAke3UgPyBgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5TdGF0dXM8L2xhYmVsPjxzZWxlY3QgaWQ9InVf' +
  'YWN0aXZlIj4KICAgICAgPG9wdGlvbiB2YWx1ZT0idHJ1ZSIgJHt2LmFjdGl2ZSA/ICdzZWxlY3RlZCcgOiAnJ30+QWN0aXZlPC9v' +
  'cHRpb24+CiAgICAgIDxvcHRpb24gdmFsdWU9ImZhbHNlIiAkeyF2LmFjdGl2ZSA/ICdzZWxlY3RlZCcgOiAnJ30+RGVhY3RpdmF0' +
  'ZWQ8L29wdGlvbj48L3NlbGVjdD48L2Rpdj5gIDogJyd9CiAgICA8ZGl2IGNsYXNzPSJyb3ciPjxidXR0b24gY2xhc3M9ImJ0biIg' +
  'aWQ9InNhdmUiPlNhdmU8L2J1dHRvbj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIG9uY2xpY2s9ImNsb3NlU2hlZXQoKSI+' +
  'Q2FuY2VsPC9idXR0b24+PC9kaXY+YCwgZWwgPT4gewogICAgZWwucXVlcnlTZWxlY3RvcignI3NhdmUnKS5vbmNsaWNrID0gYXN5' +
  'bmMgKCkgPT4gewogICAgICBjb25zdCBib2R5ID0gewogICAgICAgIG5hbWU6IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X25hbWUnKS52' +
  'YWx1ZSwgZW1haWw6IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X2VtYWlsJykudmFsdWUsCiAgICAgICAgcm9sZTogZWwucXVlcnlTZWxl' +
  'Y3RvcignI3Vfcm9sZScpLnZhbHVlLCBwaG9uZTogZWwucXVlcnlTZWxlY3RvcignI3VfcGhvbmUnKS52YWx1ZSwKICAgICAgICBs' +
  'aWNlbnNlX25vOiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9saWNlbnNlX25vJykudmFsdWUsCiAgICAgICAgZGVmYXVsdF9wYXk6IGVs' +
  'LnF1ZXJ5U2VsZWN0b3IoJyN1X2RlZmF1bHRfcGF5JykudmFsdWUgfHwgMAogICAgICB9OwogICAgICBjb25zdCBwdyA9IGVsLnF1' +
  'ZXJ5U2VsZWN0b3IoJyN1X3Bhc3N3b3JkJykudmFsdWU7CiAgICAgIGlmIChwdykgYm9keS5wYXNzd29yZCA9IHB3OwogICAgICBp' +
  'ZiAodSkgYm9keS5hY3RpdmUgPSBlbC5xdWVyeVNlbGVjdG9yKCcjdV9hY3RpdmUnKS52YWx1ZSA9PT0gJ3RydWUnOwogICAgICB0' +
  'cnkgewogICAgICAgIGF3YWl0ICh1ID8gYXBpKCcvdXNlcnMvJyArIHUuaWQsIHsgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBKU09O' +
  'LnN0cmluZ2lmeShib2R5KSB9KQogICAgICAgICAgICAgICAgIDogYXBpKCcvdXNlcnMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5' +
  'OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KSk7CiAgICAgICAgY2xvc2VTaGVldCgpOyB0b2FzdCgnU2F2ZWQnKTsgZ28oJ2FkbWlu' +
  'Jyk7CiAgICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogICAgfTsKICB9KTsKfQoKZnVuY3Rpb24g' +
  'Y2xpZW50Rm9ybShjKSB7CiAgY29uc3QgdiA9IGMgfHwge307CiAgc2hlZXQoYyA/ICdFZGl0ICcgKyBjLm5hbWUgOiAnQWRkIGNs' +
  'aWVudCcsIGAKICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RmlybSAvIGNsaWVudCBuYW1lPC9sYWJlbD48aW5wdXQgaWQ9' +
  'ImNfbmFtZSIgdmFsdWU9IiR7ZXNjKHYubmFtZSl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICA8ZGl2' +
  'IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNvbnRhY3Q8L2xhYmVsPjxpbnB1dCBpZD0iY19jb250YWN0X25hbWUiIHZhbHVlPSIke2Vz' +
  'Yyh2LmNvbnRhY3RfbmFtZSl9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5QaG9uZTwvbGFiZWw+PGlu' +
  'cHV0IGlkPSJjX3Bob25lIiB2YWx1ZT0iJHtlc2Modi5waG9uZSl9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxs' +
  'YWJlbD5FbWFpbDwvbGFiZWw+PGlucHV0IGlkPSJjX2VtYWlsIiB0eXBlPSJlbWFpbCIgdmFsdWU9IiR7ZXNjKHYuZW1haWwpfSI+' +
  'PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RGVmYXVsdCBmZWUgcGVyIHNlcnZlPC9sYWJlbD48aW5wdXQg' +
  'aWQ9ImNfZGVmYXVsdF9mZWUiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgdmFsdWU9IiR7di5kZWZhdWx0X2ZlZSB8fCAnJ30i' +
  'PjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkJpbGxpbmcgYWRkcmVzczwvbGFiZWw+PHRl' +
  'eHRhcmVhIGlkPSJjX2FkZHJlc3MiIHN0eWxlPSJtaW4taGVpZ2h0OjYwcHgiPiR7ZXNjKHYuYWRkcmVzcyl9PC90ZXh0YXJlYT48' +
  'L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Tm90ZXM8L2xhYmVsPjx0ZXh0YXJlYSBpZD0iY19ub3RlcyIgc3R5' +
  'bGU9Im1pbi1oZWlnaHQ6NjBweCI+JHtlc2Modi5ub3Rlcyl9PC90ZXh0YXJlYT48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InJvdyI+' +
  'PGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0ic2F2ZSI+U2F2ZTwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25j' +
  'bGljaz0iY2xvc2VTaGVldCgpIj5DYW5jZWw8L2J1dHRvbj48L2Rpdj5gLCBlbCA9PiB7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcj' +
  'c2F2ZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IGJvZHkgPSB7fTsKICAgICAgWyduYW1lJywnY29udGFj' +
  'dF9uYW1lJywncGhvbmUnLCdlbWFpbCcsJ2RlZmF1bHRfZmVlJywnYWRkcmVzcycsJ25vdGVzJ10KICAgICAgICAuZm9yRWFjaChm' +
  'ID0+IGJvZHlbZl0gPSBlbC5xdWVyeVNlbGVjdG9yKCcjY18nICsgZikudmFsdWUpOwogICAgICB0cnkgewogICAgICAgIGF3YWl0' +
  'IChjID8gYXBpKCcvY2xpZW50cy8nICsgYy5pZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkp' +
  'IH0pCiAgICAgICAgICAgICAgICAgOiBhcGkoJy9jbGllbnRzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdp' +
  'ZnkoYm9keSkgfSkpOwogICAgICAgIGNsb3NlU2hlZXQoKTsgdG9hc3QoJ1NhdmVkJyk7IGdvKCdhZG1pbicpOwogICAgICB9IGNh' +
  'dGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICAgIH07CiAgfSk7Cn0KCmFzeW5jIGZ1bmN0aW9uIHRlbXBsYXRl' +
  'Rm9ybSh0KSB7CiAgY29uc3QgZmllbGRzID0gYXdhaXQgYXBpKCcvdGVtcGxhdGUtZmllbGRzJyk7CiAgY29uc3QgdiA9IHQgfHwg' +
  'eyBib2R5OiAnJywgaXNfZGVmYXVsdDogZmFsc2UgfTsKICBzaGVldCh0ID8gJ0VkaXQgdGVtcGxhdGUnIDogJ05ldyBhZmZpZGF2' +
  'aXQgdGVtcGxhdGUnLCBgCiAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5U' +
  'ZW1wbGF0ZSBuYW1lPC9sYWJlbD48aW5wdXQgaWQ9InRfbmFtZSIgdmFsdWU9IiR7ZXNjKHYubmFtZSl9Ij48L2Rpdj4KICAgICAg' +
  'PGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5KdXJpc2RpY3Rpb24gLyBjb3VydDwvbGFiZWw+PGlucHV0IGlkPSJ0X2p1cmlzZGlj' +
  'dGlvbiIgdmFsdWU9IiR7ZXNjKHYuanVyaXNkaWN0aW9uKX0iPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVs' +
  'ZCI+PGxhYmVsPkJvZHk8L2xhYmVsPgogICAgICA8dGV4dGFyZWEgaWQ9InRfYm9keSIgc3R5bGU9Im1pbi1oZWlnaHQ6MjIwcHg7' +
  'Zm9udDoxMi41cHgvMS41ICdDb3VyaWVyIE5ldycsbW9ub3NwYWNlIj4ke2VzYyh2LmJvZHkpfTwvdGV4dGFyZWE+CiAgICAgIDxk' +
  'aXYgY2xhc3M9ImhpbnQiPkNsaWNrIGEgZmllbGQgdG8gaW5zZXJ0IGl0IGF0IHRoZSBjdXJzb3I6PC9kaXY+CiAgICAgIDxkaXYg' +
  'Y2xhc3M9InRva2VucyI+JHtmaWVsZHMubWFwKGYgPT4gYDxidXR0b24gZGF0YS1mPSIke2ZbMF19IiB0aXRsZT0iJHtlc2MoZlsx' +
  'XSl9Ij57eyR7ZlswXX19fTwvYnV0dG9uPmApLmpvaW4oJycpfTwvZGl2PgogICAgPC9kaXY+CiAgICA8bGFiZWwgc3R5bGU9ImRp' +
  'c3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweCI+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBpZD0idF9kZWZhdWx0' +
  'IiBzdHlsZT0id2lkdGg6YXV0byIgJHt2LmlzX2RlZmF1bHQgPyAnY2hlY2tlZCcgOiAnJ30+IFVzZSBhcyB0aGUgZGVmYXVsdCB0' +
  'ZW1wbGF0ZTwvbGFiZWw+CiAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPgogICAgICA8YnV0dG9u' +
  'IGNsYXNzPSJidG4iIGlkPSJzYXZlIj5TYXZlPC9idXR0b24+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIGlkPSJwcmV2' +
  'aWV3Ij5QcmV2aWV3IHdpdGggcmVhbCBqb2I8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25jbGljaz0i' +
  'Y2xvc2VTaGVldCgpIj5DYW5jZWw8L2J1dHRvbj4KICAgICAgJHt0ID8gJzxidXR0b24gY2xhc3M9ImJ0biBnaG9zdCIgaWQ9ImRl' +
  'bCIgc3R5bGU9ImNvbG9yOnZhcigtLWJhZCk7bWFyZ2luLWxlZnQ6YXV0byI+RGVsZXRlPC9idXR0b24+JyA6ICcnfQogICAgPC9k' +
  'aXY+CiAgICA8cHJlIGNsYXNzPSJwcmV2IiBpZD0idHByZXYiIHN0eWxlPSJkaXNwbGF5Om5vbmU7bWFyZ2luLXRvcDoxMnB4Ij48' +
  'L3ByZT5gLCBlbCA9PiB7CiAgICBjb25zdCB0YSA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyN0X2JvZHknKTsKICAgIGVsLnF1ZXJ5U2Vs' +
  'ZWN0b3JBbGwoJ1tkYXRhLWZdJykuZm9yRWFjaChiID0+IGIub25jbGljayA9ICgpID0+IHsKICAgICAgY29uc3QgdG9rID0gJ3t7' +
  'JyArIGIuZGF0YXNldC5mICsgJ319JzsKICAgICAgY29uc3QgcyA9IHRhLnNlbGVjdGlvblN0YXJ0LCBlID0gdGEuc2VsZWN0aW9u' +
  'RW5kOwogICAgICB0YS52YWx1ZSA9IHRhLnZhbHVlLnNsaWNlKDAsIHMpICsgdG9rICsgdGEudmFsdWUuc2xpY2UoZSk7CiAgICAg' +
  'IHRhLmZvY3VzKCk7IHRhLnNlbGVjdGlvblN0YXJ0ID0gdGEuc2VsZWN0aW9uRW5kID0gcyArIHRvay5sZW5ndGg7CiAgICB9KTsK' +
  'ICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNwcmV2aWV3Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgciA9IGF3' +
  'YWl0IGFwaSgnL3RlbXBsYXRlcy9wcmV2aWV3JywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBib2R5' +
  'OiB0YS52YWx1ZSB9KSB9KTsKICAgICAgY29uc3QgcCA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyN0cHJldicpOwogICAgICBwLnN0eWxl' +
  'LmRpc3BsYXkgPSAnJzsgcC50ZXh0Q29udGVudCA9IHIudGV4dDsKICAgIH07CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZScp' +
  'Lm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IGJvZHkgPSB7CiAgICAgICAgbmFtZTogZWwucXVlcnlTZWxlY3Rv' +
  'cignI3RfbmFtZScpLnZhbHVlLCBqdXJpc2RpY3Rpb246IGVsLnF1ZXJ5U2VsZWN0b3IoJyN0X2p1cmlzZGljdGlvbicpLnZhbHVl' +
  'LAogICAgICAgIGJvZHk6IHRhLnZhbHVlLCBpc19kZWZhdWx0OiBlbC5xdWVyeVNlbGVjdG9yKCcjdF9kZWZhdWx0JykuY2hlY2tl' +
  'ZAogICAgICB9OwogICAgICBpZiAoIWJvZHkubmFtZS50cmltKCkpIHJldHVybiB0b2FzdCgnR2l2ZSB0aGUgdGVtcGxhdGUgYSBu' +
  'YW1lJywgdHJ1ZSk7CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgKHQgPyBhcGkoJy90ZW1wbGF0ZXMvJyArIHQuaWQsIHsgbWV0' +
  'aG9kOiAnUEFUQ0gnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KQogICAgICAgICAgICAgICAgIDogYXBpKCcvdGVtcGxh' +
  'dGVzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSkpOwogICAgICAgIGNsb3NlU2hlZXQo' +
  'KTsgdG9hc3QoJ1NhdmVkJyk7IGdvKCdhZG1pbicpOwogICAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7' +
  'IH0KICAgIH07CiAgICBpZiAoZWwucXVlcnlTZWxlY3RvcignI2RlbCcpKSBlbC5xdWVyeVNlbGVjdG9yKCcjZGVsJykub25jbGlj' +
  'ayA9IGFzeW5jICgpID0+IHsKICAgICAgaWYgKCFjb25maXJtKCdEZWxldGUgdGhpcyB0ZW1wbGF0ZT8nKSkgcmV0dXJuOwogICAg' +
  'ICBhd2FpdCBhcGkoJy90ZW1wbGF0ZXMvJyArIHQuaWQsIHsgbWV0aG9kOiAnREVMRVRFJyB9KTsKICAgICAgY2xvc2VTaGVldCgp' +
  'OyB0b2FzdCgnRGVsZXRlZCcpOyBnbygnYWRtaW4nKTsKICAgIH07CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBib290IC0tICovCmNvbnN0IFZJRVdTID0geyBkYXNoOiBk' +
  'YXNoVmlldywgam9iczogam9ic1ZpZXcsIGpvYjogam9iVmlldywgc2Nhbjogc2NhblZpZXcsCiAgdG9vbHM6IHRvb2xzVmlldywg' +
  'cHJvcGVydHk6IHByb3BlcnR5VmlldywgbW9uZXk6IG1vbmV5VmlldywgYWRtaW46IGFkbWluVmlldyB9OwoKYXN5bmMgZnVuY3Rp' +
  'b24gcmVuZGVyKCkgewogIGNsb3NlU2hlZXQoKTsKICBpZiAoIVMubWUpIHJldHVybiBsb2dpblZpZXcoKTsKICBpZiAoUy52aWV3' +
  'ID09PSAnam9icycpIFMuY2FjaGUuam9iRmlsdGVyID0gUy5wYXJhbXM7CiAgY29uc3QgZm4gPSBWSUVXU1tTLnZpZXddIHx8IGRh' +
  'c2hWaWV3OwogIHRyeSB7CiAgICBhcHAuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9IndyYXAiPjxkaXYgY2xhc3M9ImVtcHR5Ij5M' +
  'b2FkaW5n4oCmPC9kaXY+PC9kaXY+JzsKICAgIGF3YWl0IGZuKCk7CiAgfSBjYXRjaCAoZSkgewogICAgaWYgKFMubWUpIHsgYXBw' +
  'LmlubmVySFRNTCA9IHNoZWxsKGA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJlbXB0eSI+JHtlc2MoZS5tZXNzYWdlKX08' +
  'L2Rpdj48L2Rpdj5gKTsgYmluZFNoZWxsKCk7IH0KICB9Cn0KCihhc3luYyBmdW5jdGlvbiBib290KCkgewogIHRyeSB7IFMubWUg' +
  'PSBhd2FpdCBhcGkoJy9tZScpOyB9IGNhdGNoIChlKSB7IFMubWUgPSBudWxsOyB9CiAgcmVuZGVyKCk7Cn0pKCk7Cn0pKCk7Cgo8' +
  'L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg=='
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
const { q, init, createCompany } = (() => {
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

  /* ------------------------------------------------------- companies ---
   *
   * ServeTrack began life serving one company, so everything in it was
   * implicitly that company's. Now that several companies share it, every row
   * needs to say whose it is. This runs on every start and does nothing once
   * the work is done.
   *
   * Existing data all belongs to whoever was using it before, so it is moved
   * into a single company rather than guessed at. Name it with COMPANY_NAME.
   */
  let { rows: firstCo } = await q('SELECT id FROM companies ORDER BY id LIMIT 1');
  if (!firstCo.length) {
    const { rows: made } = await q(
      'INSERT INTO companies (name) VALUES ($1) RETURNING id',
      [process.env.COMPANY_NAME || 'My Company']);
    firstCo = made;
    console.log('Created the first company: ' + (process.env.COMPANY_NAME || 'My Company'));
  }
  const homeCompany = firstCo[0].id;

  for (const table of ['users', 'clients', 'jobs', 'affidavit_templates',
                       'statements', 'invoices', 'access_codes']) {
    const { rowCount } = await q(
      `UPDATE ${table} SET company_id=$1 WHERE company_id IS NULL`, [homeCompany]);
    if (rowCount) console.log(`Moved ${rowCount} row(s) in ${table} into company ${homeCompany}.`);
  }

  // seed admin
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const { rows } = await q('SELECT id FROM users WHERE role IN (\'admin\',\'owner\') LIMIT 1');
  if (!rows.length) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'changeme123', 10);
    await q(
      `INSERT INTO users (name, email, password_hash, role, company_id) VALUES ($1,$2,$3,'admin',$4)
       ON CONFLICT (email) DO NOTHING`,
      [process.env.ADMIN_NAME || 'Administrator', email, hash, homeCompany]
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
  const who = await q(`SELECT u.email, u.role, u.active, c.name AS company
                       FROM users u LEFT JOIN companies c ON c.id=u.company_id
                       ORDER BY c.name NULLS FIRST, u.role, u.email`);
  console.log('Accounts: ' + who.rows.map(u =>
    `${u.email} (${u.role}${u.company ? ' @ ' + u.company : ''}${u.active ? '' : ', INACTIVE'})`).join(', '));

  /* Every company starts with a usable affidavit rather than a blank page. */
  const { rows: noTpl } = await q(`
    SELECT c.id FROM companies c
    WHERE NOT EXISTS (SELECT 1 FROM affidavit_templates t WHERE t.company_id = c.id)`);
  for (const c of noTpl) {
    await q(
      `INSERT INTO affidavit_templates (name, jurisdiction, body, is_default, company_id)
       VALUES ($1,$2,$3,TRUE,$4)`,
      ['General Affidavit of Service', 'Generic', DEFAULT_TEMPLATE, c.id]
    );
  }
  if (noTpl.length) console.log(`Gave ${noTpl.length} company(ies) a starting affidavit template.`);
}

/* Create a company and, optionally, its first administrator. Used by the owner
   console and by db.js when a brand new database comes up. */
async function createCompany({ name, contact_email, phone }) {
  const { rows } = await q(
    'INSERT INTO companies (name, contact_email, phone) VALUES ($1,$2,$3) RETURNING *',
    [String(name || '').trim() || 'Untitled company', contact_email || null, phone || null]);
  const co = rows[0];
  await q(
    `INSERT INTO affidavit_templates (name, jurisdiction, body, is_default, company_id)
     VALUES ($1,$2,$3,TRUE,$4)`,
    ['General Affidavit of Service', 'Generic', DEFAULT_TEMPLATE, co.id]);
  return co;
}

return { q, pool, init, createCompany, DEFAULT_TEMPLATE };

})();

const app = express();
const BUILD = '2026-08-31.17';           // shown in Setup so uploads can be confirmed
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TZ = process.env.TIMEZONE || 'America/New_York';

app.use(express.json({ limit: '14mb' }));
app.use(cookieParser());

/* ------------------------------------------------------------- privacy --- */
/* Public, linked from the sign-in screen. Written in plain language on
   purpose: the people reading it are process servers and their clients. */
const PRIVACY_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ServeTrack — Privacy</title>
<style>body{font:16px/1.65 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#101822;
background:#EDF2FB;margin:0;padding:28px 18px}main{max-width:660px;margin:0 auto;
background:#fff;border:1px solid #DBE4F2;border-radius:14px;padding:24px 22px}
h1{font-size:26px;margin:0 0 4px;color:#0B4FD3}
h2{font-size:18px;margin:26px 0 6px;color:#101822}
p,li{margin:8px 0}a{color:#0A3FA8}.d{color:#5A6A80;font-size:14px}</style></head><body><main>
<h1>ServeTrack Privacy Statement</h1>
<p class="d">Last updated 31 August 2026</p>

<h2>Your company's data is yours</h2>
<p>Every company on ServeTrack is separate. Your jobs, clients, case details,
documents, invoices, pay statements and people are visible only to accounts
inside your company. No other company can see them, and the app enforces this on
the server for every request, not just on the screen.</p>

<h2>What the platform owner can and cannot see</h2>
<p>The operator of ServeTrack can enter your company only in a restricted
support view, to help with problems. In support view the app masks every
personal name, party, case number, client identity and document field before
the page leaves the server, and it refuses to produce affidavits, cover sheets,
labels, invoices or statements. The operator sees counts, statuses, dates and
amounts — enough to fix a problem, not enough to read your cases. Your own
screens are never affected.</p>

<h2>What we store</h2>
<ul>
<li><b>Your account:</b> name, email, and a scrambled (hashed) form of your
password — the readable password is never stored, so it cannot be read back.</li>
<li><b>Your work:</b> the jobs, clients, attempts, templates and billing records
your company creates, stored so the app can show them back to you.</li>
<li><b>Location of service attempts:</b> when a field server logs an attempt,
the device's GPS position is recorded with it. That is deliberate — it is what
makes an affidavit of service stand up — and everyone using the app should know
it happens.</li>
<li><b>Uploaded court papers:</b> a PDF you upload to fill in a job is read once
in memory to pull out the case details, and is not kept.</li>
</ul>

<h2>Cookies and tracking</h2>
<p>One cookie, used to keep you signed in. No advertising, no trackers, no
analytics, and your data is never sold or shared for marketing.</p>

<h2>Where it lives</h2>
<p>ServeTrack runs on Render (United States) with data in a managed PostgreSQL
database. Like any hosted software, the operator administers that
infrastructure; day-to-day access to your data happens through the app, under
the restrictions above.</p>

<h2>Your choices</h2>
<p>You can change your password at any time (it changes across all connected
apps at once), and a company administrator can deactivate any of their own
accounts. To ask about your data or request deletion, contact
<a href="mailto:steve.smith@buddyrents.com">steve.smith@buddyrents.com</a>.</p>

<p class="d">If this statement changes, the date above changes with it.</p>
</main></body></html>`;
app.get('/privacy', (req, res) => res.type('html').send(PRIVACY_PAGE));

/* ---------------------------------------------------------------- auth --- */

function sign(user) {
  return jwt.sign({ id: user.id, role: user.role, name: user.name }, SECRET, { expiresIn: '30d' });
}

/* Which company the signed-in person is working in.
 *
 * Everybody except the owner is pinned to their own company and cannot reach
 * outside it. The owner works inside one company at a time and can switch —
 * that keeps every query below identical whoever is asking, instead of having
 * one set of rules for the owner and another for everyone else. A merged view
 * across companies would be both confusing and easy to get wrong.
 */
const companyOf = u => (u.role === 'owner' ? (u.active_company_id || u.company_id) : u.company_id);

/* Support view.
 *
 * The owner can step into any company to help — but a customer's business is
 * their business. Inside a company that is not the owner's own, every person's
 * name, the parties, and the document fields are masked BEFORE they leave the
 * server, so there is nothing on the wire to peek at, and anything that would
 * print or merge the real details (affidavits, cover sheets, labels, invoices)
 * is switched off. The company's own admin and servers see everything, always.
 */
const supportView = req => req.user.role === 'owner' && req.companyId !== req.user.company_id;

// "Maria Ruiz" -> "M████ R███": enough shape to troubleshoot, nothing to read.
const maskText = v => (v == null || v === '') ? v
  : String(v).split(/\s+/).map(w => (w[0] || '') + '█'.repeat(Math.max(1, Math.min(w.length - 1, 8)))).join(' ');

const maskFields = (row, fields) => {
  if (!row) return row;
  for (const f of fields) if (row[f] !== undefined) row[f] = maskText(row[f]);
  return row;
};
const JOB_MASK = ['recipient_name', 'recipient_notes', 'plaintiff', 'defendant',
  'served_person', 'documents', 'notes', 'client_name', 'case_number'];
const CLIENT_MASK = ['name', 'contact_name', 'email', 'phone', 'notes'];
const ATTEMPT_MASK = ['person_served', 'relationship', 'description', 'notes'];

const maskJob = (req, j) => supportView(req) ? maskFields(j, JOB_MASK) : j;
const maskJobs = (req, rows) => supportView(req) ? rows.map(j => maskFields(j, JOB_MASK)) : rows;

const noPrintInSupport = (req, res) => {
  if (!supportView(req)) return false;
  res.status(403).send('Hidden in support view — names and documents are not shown in a company that is not yours.');
  return true;
};

async function auth(req, res, next) {
  const token = req.cookies.st_token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const payload = jwt.verify(token, SECRET);
    const { rows } = await q(
      `SELECT id,name,email,role,license_no,default_pay,active,company_id,active_company_id
       FROM users WHERE id=$1`, [payload.id]);
    if (!rows.length || !rows[0].active) return res.status(401).json({ error: 'Account inactive' });
    req.user = rows[0];
    req.companyId = companyOf(req.user);
    if (!req.companyId) {
      return res.status(403).json({ error: 'Your account is not attached to a company yet' });
    }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired' });
  }
}

// The owner administers every company, so counts as an admin inside whichever
// one they are currently working in.
const isAdmin = u => u.role === 'admin' || u.role === 'owner';

const admin = (req, res, next) =>
  isAdmin(req.user) ? next() : res.status(403).json({ error: 'Admins only' });

const ownerOnly = (req, res, next) =>
  req.user.role === 'owner' ? next() : res.status(403).json({ error: 'Owner only' });

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
    /* My Apps decides who the owner is, and that carries into every app —
       which is the point of one sign-in. It can promote, never demote: an
       admin here stays an admin whatever My Apps says about them. */
    let u = user;
    if (!u) {
      if (c.role !== 'owner') {
        // A central account with no place in any company. Somebody has to invite
        // them, or they start their own company with a code.
        return res.status(403).json({
          error: 'That account is not set up with a company here — ask your administrator for an access code'
        });
      }
      const { rows: anyCo } = await q('SELECT id FROM companies ORDER BY id LIMIT 1');
      const home = anyCo.length ? anyCo[0].id : (await createCompany({ name: 'My Company' })).id;
      const { rows } = await q(
        `INSERT INTO users (name,email,password_hash,role,company_id,active_company_id)
         VALUES ($1,$2,$3,'owner',$4,$4) RETURNING id,name,email,role,active`,
        [c.user.name || email.split('@')[0], email, await bcrypt.hash(password, 10), home]);
      u = rows[0];
      console.log(`Owner ${email} signed in for the first time — local record created`);
    } else {
      if (!u.active) return res.status(401).json({ error: 'This account has been turned off in ServeTrack' });
      await mirrorPassword(u.id, password);
      if (c.role === 'owner' && u.role !== 'owner') {
        await q("UPDATE users SET role='owner' WHERE id=$1", [u.id]);
        u.role = 'owner';
        console.log(`${email} promoted to owner by My Apps`);
      }
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

/* Who am I, which company am I in, and what is that company on.
   The owner also gets the list of companies so the app can offer a switcher. */
app.get('/api/me', auth, wrap(async (req, res) => {
  const { rows: co } = await q('SELECT id,name,plan,plan_expires FROM companies WHERE id=$1', [req.companyId]);
  const me = Object.assign({}, req.user, {
    company: co[0] || null,
    is_admin: isAdmin(req.user),
    support: supportView(req)
  });
  if (req.user.role === 'owner') {
    me.companies = (await q('SELECT id,name FROM companies ORDER BY name')).rows;
  }
  res.json(me);
}));

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
    `SELECT id,name,email,role,phone,license_no,county,default_pay,active FROM users
     WHERE company_id=$1 ORDER BY active DESC, name`, [req.companyId]
  );
  res.json(rows);
}));

app.post('/api/users', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  const password = String(b.password || 'changeme123');
  const hash = await bcrypt.hash(password, 10);
  // Only the owner may make another owner; an admin can only make people
  // inside their own company, and only up to admin.
  const role = req.user.role === 'owner'
    ? (['owner', 'admin', 'server'].includes(b.role) ? b.role : 'server')
    : (b.role === 'admin' ? 'admin' : 'server');
  const { rows } = await q(
    `INSERT INTO users (name,email,password_hash,role,phone,license_no,county,default_pay,company_id)
     VALUES ($1,lower($2),$3,$4,$5,$6,$7,$8,$9)
     RETURNING id,name,email,role,phone,license_no,county,default_pay,active`,
    [b.name, b.email, hash, role, b.phone || null, b.license_no || null, b.county || null,
     b.default_pay || 0, req.companyId]
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
    const { rows: who } = await q('SELECT email,name FROM users WHERE id=$1 AND company_id=$2',
      [req.params.id, req.companyId]);
    if (who.length) centralNote = (await centralReset(who[0].email, pw, who[0].name)).note;
  }
  // An admin cannot promote anybody to owner, and cannot touch the owner.
  const newRole = b.role === undefined ? null
    : (req.user.role === 'owner' ? b.role : (b.role === 'admin' ? 'admin' : 'server'));
  const { rows } = await q(
    `UPDATE users SET name=COALESCE($1,name), email=COALESCE(lower($2),email), role=COALESCE($3,role),
       phone=COALESCE($4,phone), license_no=COALESCE($5,license_no), county=COALESCE($6,county),
       default_pay=COALESCE($7,default_pay), active=COALESCE($8,active)
     WHERE id=$9 AND company_id=$10 AND (role <> 'owner' OR $11)
     RETURNING id,name,email,role,phone,license_no,county,default_pay,active`,
    [b.name, b.email, newRole, b.phone, b.license_no, b.county, b.default_pay, b.active,
     req.params.id, req.companyId, req.user.role === 'owner']
  );
  if (!rows.length) return res.status(404).json({ error: 'No such person in this company' });
  res.json(Object.assign(rows[0], { central: centralNote }));
}));

/* ------------------------------------------------------------- clients --- */

app.get('/api/clients', auth, wrap(async (req, res) => {
  const { rows } = await q(
    'SELECT * FROM clients WHERE company_id=$1 ORDER BY active DESC, name', [req.companyId]);
  res.json(supportView(req) ? rows.map(c => maskFields(c, CLIENT_MASK)) : rows);
}));

app.post('/api/clients', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  const { rows } = await q(
    `INSERT INTO clients (name,contact_name,email,phone,address,default_fee,notes,company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [b.name, b.contact_name || null, b.email || null, b.phone || null, b.address || null,
     b.default_fee || 0, b.notes || null, req.companyId]
  );
  res.json(rows[0]);
}));

app.patch('/api/clients/:id', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  const { rows } = await q(
    `UPDATE clients SET name=COALESCE($1,name), contact_name=COALESCE($2,contact_name),
       email=COALESCE($3,email), phone=COALESCE($4,phone), address=COALESCE($5,address),
       default_fee=COALESCE($6,default_fee), notes=COALESCE($7,notes), active=COALESCE($8,active)
     WHERE id=$9 AND company_id=$10 RETURNING *`,
    [b.name, b.contact_name, b.email, b.phone, b.address, b.default_fee, b.notes, b.active,
     req.params.id, req.companyId]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such client in this company' });
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

/* Job numbers run per company, so each one starts at ST-10001 and nobody can
   infer how much work another company is doing. The max is used rather than a
   count so deleting a job never hands its number to the next one. */
async function nextJobNumber(companyId) {
  const { rows } = await q(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(job_number, '\\D', '', 'g'), '')::bigint), 10000) AS n
     FROM jobs WHERE company_id=$1`, [companyId]);
  return 'ST-' + String(Number(rows[0].n) + 1);
}

app.get('/api/jobs', auth, wrap(async (req, res) => {
  const where = [];
  const params = [];
  // pushes a value and returns its placeholder, e.g. "$1"
  const p = val => { params.push(val); return '$' + params.length; };

  where.push('j.company_id = ' + p(req.companyId));
  if (!isAdmin(req.user)) where.push('j.assigned_to = ' + p(req.user.id));
  else if (req.query.assigned_to) where.push('j.assigned_to = ' + p(req.query.assigned_to));

  if (req.query.status) where.push('j.status = ' + p(req.query.status));
  if (req.query.client_id) where.push('j.client_id = ' + p(req.query.client_id));
  if (req.query.open === '1') where.push("j.status IN ('Pending','Assigned','Attempted','On Hold')");
  if (req.query.q) {
    const i = p('%' + req.query.q + '%');
    where.push(`(j.recipient_name ILIKE ${i} OR j.case_number ILIKE ${i} OR j.job_number ILIKE ${i}
      OR j.address1 ILIKE ${i} OR j.defendant ILIKE ${i} OR j.plaintiff ILIKE ${i} OR j.city ILIKE ${i})`);
  }
  const sql = JOB_SELECT + ' WHERE ' + where.join(' AND ') +
    ` ORDER BY CASE j.priority WHEN 'Same Day' THEN 0 WHEN 'Rush' THEN 1 ELSE 2 END,
             j.due_date NULLS LAST, j.id DESC LIMIT 500`;
  const { rows } = await q(sql, params);
  res.json(maskJobs(req, rows));
}));

app.get('/api/jobs/:id', auth, wrap(async (req, res) => {
  const { rows } = await q(JOB_SELECT + ' WHERE j.id=$1 AND j.company_id=$2',
    [req.params.id, req.companyId]);
  const job = rows[0];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!isAdmin(req.user) && job.assigned_to !== req.user.id) {
    return res.status(403).json({ error: 'Not your job' });
  }
  const att = await q(
    `SELECT a.*, u.name AS server_name FROM attempts a
     LEFT JOIN users u ON u.id=a.server_id WHERE a.job_id=$1 ORDER BY a.attempted_at`,
    [req.params.id]
  );
  job.attempts = supportView(req) ? att.rows.map(a => maskFields(a, ATTEMPT_MASK)) : att.rows;
  res.json(maskJob(req, job));
}));

// Barcode scan lookup: accepts job number or raw id
app.get('/api/lookup/:code', auth, wrap(async (req, res) => {
  const code = String(req.params.code).trim().toUpperCase();
  const { rows } = await q(
    `SELECT id, job_number, recipient_name, status, assigned_to FROM jobs
     WHERE company_id=$2 AND (upper(job_number)=$1 OR CAST(id AS TEXT)=$1)`,
    [code, req.companyId]
  );
  if (!rows.length) return res.status(404).json({ error: 'No job matches ' + code });
  if (!isAdmin(req.user) && rows[0].assigned_to !== req.user.id) {
    return res.status(403).json({ error: 'That job is not assigned to you' });
  }
  res.json(maskJob(req, rows[0]));
}));

const JOB_FIELDS = ['client_id','case_number','court','plaintiff','defendant','recipient_name','recipient_notes',
  'address1','address2','city','state','zip','service_type','documents','priority','due_date','status',
  'assigned_to','client_fee','server_pay','notes'];

app.post('/api/jobs', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  // Only insert fields the caller actually supplied, so the column defaults in
  // schema.sql (status, service_type, priority) still apply instead of being
  // overwritten with nulls.
  const cols = ['job_number', 'company_id'];
  const params = [await nextJobNumber(req.companyId), req.companyId];
  for (const f of JOB_FIELDS) {
    if (b[f] !== undefined && b[f] !== null && b[f] !== '') { cols.push(f); params.push(b[f]); }
  }
  // A job may only point at this company's client and this company's server.
  if (b.client_id) {
    const { rows: ok } = await q('SELECT 1 FROM clients WHERE id=$1 AND company_id=$2', [b.client_id, req.companyId]);
    if (!ok.length) return res.status(400).json({ error: 'No such client in this company' });
  }
  if (b.assigned_to) {
    const { rows: ok } = await q('SELECT 1 FROM users WHERE id=$1 AND company_id=$2', [b.assigned_to, req.companyId]);
    if (!ok.length) return res.status(400).json({ error: 'No such person in this company' });
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
  if (b.client_id) {
    const { rows: ok } = await q('SELECT 1 FROM clients WHERE id=$1 AND company_id=$2', [b.client_id, req.companyId]);
    if (!ok.length) return res.status(400).json({ error: 'No such client in this company' });
  }
  if (b.assigned_to) {
    const { rows: ok } = await q('SELECT 1 FROM users WHERE id=$1 AND company_id=$2', [b.assigned_to, req.companyId]);
    if (!ok.length) return res.status(400).json({ error: 'No such person in this company' });
  }
  params.push(req.params.id, req.companyId);
  const { rows } = await q(
    `UPDATE jobs SET ${sets.join(',')}, updated_at=NOW()
     WHERE id=$${params.length - 1} AND company_id=$${params.length} RETURNING *`, params
  );
  if (!rows.length) return res.status(404).json({ error: 'No such job in this company' });
  res.json(rows[0]);
}));

app.delete('/api/jobs/:id', auth, admin, wrap(async (req, res) => {
  await q('DELETE FROM jobs WHERE id=$1 AND company_id=$2', [req.params.id, req.companyId]);
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
    WHERE c.company_id = $1
    ORDER BY c.created_at DESC LIMIT 200`, [req.companyId]);
  res.json(rows.map(c => Object.assign(c, { state: codeState(c), redemptions: c.redemptions || [] })));
}));

app.post('/api/codes', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  const role = b.role === 'admin' ? 'admin' : 'server';
  const maxUses = Math.min(500, Math.max(1, Number(b.max_uses) || 1));
  const { rows } = await q(
    `INSERT INTO access_codes (code, role, max_uses, expires_at, note, default_pay, created_by, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [newCode(), role, maxUses, b.expires_at || null, b.note || null, b.default_pay || 0,
     req.user.id, req.companyId]
  );
  res.json(Object.assign(rows[0], { state: 'Active', redemptions: [] }));
}));

app.patch('/api/codes/:id', auth, admin, wrap(async (req, res) => {
  const { rows } = await q(
    'UPDATE access_codes SET revoked = COALESCE($1, revoked) WHERE id=$2 AND company_id=$3 RETURNING *',
    [typeof req.body.revoked === 'boolean' ? req.body.revoked : null, req.params.id, req.companyId]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such code' });
  res.json(Object.assign(rows[0], { state: codeState(rows[0]) }));
}));

app.delete('/api/codes/:id', auth, admin, wrap(async (req, res) => {
  await q('DELETE FROM access_codes WHERE id=$1 AND company_id=$2', [req.params.id, req.companyId]);
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

  const companyName = String(req.body.company || '').trim();
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

    /* A My Apps code is how a new company buys ServeTrack, so it does not join
       an existing company — it starts one, with this person as its administrator.
       That is the same shape as registering a school in the Scheduler. */
    const co = await createCompany({ name: companyName || (name + "'s company"), contact_email: email });
    if (made.plan === 'pro') {
      await q('UPDATE companies SET plan=$1, plan_expires=$2 WHERE id=$3',
        ['pro', made.expires_on || null, co.id]);
    }
    const { rows: ur } = await q(
      `INSERT INTO users (name,email,password_hash,role,company_id) VALUES ($1,$2,$3,'admin',$4)
       RETURNING id,name,email,role`, [name, email, await bcrypt.hash(password, 10), co.id]);
    console.log(`New company "${co.name}" started by ${email} — ${made.plan} until ${made.expires_on || 'n/a'}`);
    return res.json(Object.assign(issueSession(res, ur[0]), { company: co.name }));
  }

  const state = codeState(c);
  if (state !== 'Active') return res.status(410).json({ error: `That code is ${state.toLowerCase()}` });

  const { rows: existing } = await q('SELECT id FROM users WHERE lower(email)=$1', [email]);
  if (existing.length) return res.status(409).json({ error: 'An account already uses that email — sign in instead' });

  /* The email may already be an account in one of the other apps. If so this is
     the same person joining a company here, not a new account: they must use
     the password they already have, or they would end up with two different
     ones and no way to tell which is which. Checked before the code is spent,
     so a failed attempt does not burn somebody else's invitation. */
  if (central.enabled()) {
    const known = await central.login(email, password);
    if (!known.ok && known.known) {
      return res.status(known.suspended ? 403 : 401).json({
        error: known.suspended
          ? 'That account has been suspended'
          : 'That email already has an account — use your existing password to join'
      });
    }
  }

  // Claim a use before creating the account, and only if one is still going:
  // two people redeeming the last use at once must not both get in.
  const { rows: claimed } = await q(
    `UPDATE access_codes SET used_count = used_count + 1
     WHERE id=$1 AND revoked=FALSE AND used_count < max_uses RETURNING *`, [c.id]);
  if (!claimed.length) return res.status(410).json({ error: 'That code has just been used up' });

  const hash = await bcrypt.hash(password, 10);
  // A ServeTrack access code is an invitation into the company that issued it.
  const { rows: ur } = await q(
    `INSERT INTO users (name,email,password_hash,role,default_pay,company_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role`,
    [name, email, hash, c.role === 'owner' ? 'admin' : c.role, c.default_pay || 0, c.company_id]
  );
  const user = ur[0];
  await q('INSERT INTO code_redemptions (code_id,user_id,email) VALUES ($1,$2,$3)', [c.id, user.id, email]);
  console.log(`Access code ${c.code} redeemed by ${email} as ${c.role}`);

  // The account they just made should be the one account they have everywhere.
  const enrol = await centralEnrol(email, password, name);
  if (!enrol.ok && central.enabled()) console.warn(`New account ${email} is local-only for now`);

  res.json(issueSession(res, user));
}));

/* ------------------------------------------------------------ companies --- */
/* Every company is a separate business using ServeTrack. Its admin runs it; the
   owner (that's you) can see them all and step into any one of them. */

app.get('/api/companies', auth, wrap(async (req, res) => {
  if (req.user.role !== 'owner') {
    const { rows } = await q('SELECT * FROM companies WHERE id=$1', [req.companyId]);
    return res.json(rows);
  }
  const { rows } = await q(`
    SELECT c.*,
      (SELECT count(*)::int FROM users u WHERE u.company_id=c.id AND u.active) AS people,
      (SELECT count(*)::int FROM jobs j WHERE j.company_id=c.id) AS jobs,
      (SELECT count(*)::int FROM jobs j WHERE j.company_id=c.id
        AND j.status IN ('Pending','Assigned','Attempted','On Hold')) AS open_jobs,
      (SELECT u.email FROM users u WHERE u.company_id=c.id AND u.role='admin'
        ORDER BY u.id LIMIT 1) AS admin_email
    FROM companies c ORDER BY c.name`);
  res.json(rows);
}));

app.post('/api/companies', auth, ownerOnly, wrap(async (req, res) => {
  const co = await createCompany(req.body || {});
  console.log(`Company created: ${co.name} (#${co.id})`);
  res.json(co);
}));

app.patch('/api/companies/:id', auth, admin, wrap(async (req, res) => {
  // An admin may rename their own company; only the owner may touch another's.
  if (req.user.role !== 'owner' && Number(req.params.id) !== Number(req.companyId)) {
    return res.status(403).json({ error: 'Not your company' });
  }
  const b = req.body;
  const plan = req.user.role === 'owner' ? b.plan : null;          // only the owner sets the plan
  const { rows } = await q(
    `UPDATE companies SET name=COALESCE($1,name), contact_email=COALESCE($2,contact_email),
       phone=COALESCE($3,phone), active=COALESCE($4,active), plan=COALESCE($5,plan),
       plan_expires=COALESCE($6,plan_expires)
     WHERE id=$7 RETURNING *`,
    [b.name, b.contact_email, b.phone, req.user.role === 'owner' ? b.active : null,
     plan, req.user.role === 'owner' ? b.plan_expires : null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such company' });
  res.json(rows[0]);
}));

/* The owner works inside one company at a time. Switching is deliberate and
   recorded on the account, so a refresh or a second device stays where it was. */
app.post('/api/companies/:id/enter', auth, ownerOnly, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM companies WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'No such company' });
  await q('UPDATE users SET active_company_id=$1 WHERE id=$2', [rows[0].id, req.user.id]);
  console.log(`${req.user.email} entered ${rows[0].name}`);
  res.json({ ok: true, company: rows[0] });
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
async function labelsForJobs(user, ids, companyId) {
  if (!ids.length) return [];
  const own = isAdmin(user) ? '' : ' AND assigned_to = ' + Number(user.id);
  const { rows } = await q(
    `SELECT id, job_number, recipient_name, address1, address2, city, state, zip
     FROM jobs WHERE id = ANY($1::int[]) AND company_id = $2${own}`, [ids, companyId]
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
  if (noPrintInSupport(req, res)) return;
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean);
  const sheet = await currentSheet(req.user.id);
  const content = await labelsForJobs(req.user, ids, req.companyId);
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
  const { rows: jr } = await q('SELECT * FROM jobs WHERE id=$1 AND company_id=$2',
    [req.params.id, req.companyId]);
  const job = jr[0];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!isAdmin(req.user) && job.assigned_to !== req.user.id) {
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
  await q(`DELETE FROM attempts WHERE id=$1
           AND job_id IN (SELECT id FROM jobs WHERE company_id=$2)`, [req.params.id, req.companyId]);
  res.json({ ok: true });
}));

/* --------------------------------------------------------- route my day --- */

app.get('/api/route', auth, wrap(async (req, res) => {
  const serverId = isAdmin(req.user) && req.query.server_id ? req.query.server_id : req.user.id;
  const { rows } = await q(
    `SELECT id, job_number, recipient_name, address1, address2, city, state, zip, priority, due_date, status
     FROM jobs
     WHERE assigned_to=$1 AND company_id=$2 AND status IN ('Pending','Assigned','Attempted')
     ORDER BY CASE priority WHEN 'Same Day' THEN 0 WHEN 'Rush' THEN 1 ELSE 2 END, due_date NULLS LAST`,
    [serverId, req.companyId]
  );
  res.json(rows);
}));

/* ----------------------------------------------------------- templates --- */

app.get('/api/template-fields', auth, (req, res) => res.json(merge.FIELDS));

app.get('/api/templates', auth, wrap(async (req, res) => {
  const { rows } = await q(
    'SELECT * FROM affidavit_templates WHERE company_id=$1 ORDER BY is_default DESC, name',
    [req.companyId]);
  res.json(rows);
}));

app.post('/api/templates', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  if (b.is_default) {
    await q('UPDATE affidavit_templates SET is_default=FALSE WHERE company_id=$1', [req.companyId]);
  }
  const { rows } = await q(
    `INSERT INTO affidavit_templates (name,jurisdiction,body,is_default,company_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [b.name, b.jurisdiction || null, b.body || '', !!b.is_default, req.companyId]
  );
  res.json(rows[0]);
}));

app.patch('/api/templates/:id', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  if (b.is_default) {
    await q('UPDATE affidavit_templates SET is_default=FALSE WHERE company_id=$1', [req.companyId]);
  }
  const { rows } = await q(
    `UPDATE affidavit_templates SET name=COALESCE($1,name), jurisdiction=COALESCE($2,jurisdiction),
       body=COALESCE($3,body), is_default=COALESCE($4,is_default), updated_at=NOW()
     WHERE id=$5 AND company_id=$6 RETURNING *`,
    [b.name, b.jurisdiction, b.body, b.is_default, req.params.id, req.companyId]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such template in this company' });
  res.json(rows[0]);
}));

app.delete('/api/templates/:id', auth, admin, wrap(async (req, res) => {
  await q('DELETE FROM affidavit_templates WHERE id=$1 AND company_id=$2',
    [req.params.id, req.companyId]);
  res.json({ ok: true });
}));

async function affidavitText(jobId, templateId, companyId) {
  const { rows: jr } = await q(
    `SELECT j.*, c.name AS c_name FROM jobs j LEFT JOIN clients c ON c.id=j.client_id
     WHERE j.id=$1 AND j.company_id=$2`, [jobId, companyId]
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
    ? (await q('SELECT * FROM affidavit_templates WHERE id=$1 AND company_id=$2',
        [templateId, companyId])).rows[0]
    : (await q(`SELECT * FROM affidavit_templates WHERE company_id=$1
                ORDER BY is_default DESC, id LIMIT 1`, [companyId])).rows[0];
  if (!tpl) return null;
  const ctx = merge.buildContext(job, attempts, ur[0], { name: job.c_name }, TZ);
  return { job, template: tpl, text: merge.render(tpl.body, ctx) };
}

app.get('/api/jobs/:id/affidavit', auth, wrap(async (req, res) => {
  if (supportView(req)) {
    return res.status(403).json({ error: 'Affidavits are hidden in support view — they merge real names and case details' });
  }
  const out = await affidavitText(req.params.id, req.query.template_id, req.companyId);
  if (!out) return res.status(404).json({ error: 'Job or template not found' });
  res.json({ text: out.text, template_id: out.template.id, template_name: out.template.name });
}));

// Live preview while editing a template
app.post('/api/templates/preview', auth, admin, wrap(async (req, res) => {
  const { rows: jr } = req.body.job_id
    ? await q(`SELECT j.*, c.name AS c_name FROM jobs j LEFT JOIN clients c ON c.id=j.client_id
               WHERE j.id=$1 AND j.company_id=$2`, [req.body.job_id, req.companyId])
    : await q(`SELECT j.*, c.name AS c_name FROM jobs j LEFT JOIN clients c ON c.id=j.client_id
               WHERE j.company_id=$1
               ORDER BY (j.status='Served') DESC, j.id DESC LIMIT 1`, [req.companyId]);
  if (!jr.length) return res.json({ text: merge.render(req.body.body || '', {}) });
  const job = jr[0];
  const { rows: attempts } = await q('SELECT * FROM attempts WHERE job_id=$1 ORDER BY attempted_at', [job.id]);
  const { rows: ur } = job.assigned_to ? await q('SELECT * FROM users WHERE id=$1', [job.assigned_to]) : { rows: [] };
  const ctx = merge.buildContext(job, attempts, ur[0], { name: job.c_name }, TZ);
  res.json({ text: merge.render(req.body.body || '', ctx), job_number: job.job_number });
}));

/* ---------------------------------------------------------- statements --- */

app.get('/api/statements', auth, wrap(async (req, res) => {
  const own = !isAdmin(req.user) ? ' AND s.server_id=' + Number(req.user.id) : '';
  const { rows } = await q(
    `SELECT s.*, u.name AS server_name FROM statements s
     JOIN users u ON u.id=s.server_id
     WHERE s.company_id=$1${own} ORDER BY s.created_at DESC`, [req.companyId]
  );
  res.json(rows);
}));

app.post('/api/statements/preview', auth, admin, wrap(async (req, res) => {
  const { server_id, start, end } = req.body;
  const { rows } = await q(
    `SELECT j.id, j.job_number, j.recipient_name, j.served_at, j.server_pay, j.status, c.name AS client_name
     FROM jobs j LEFT JOIN clients c ON c.id=j.client_id
     WHERE j.assigned_to=$1 AND j.company_id=$4 AND j.statement_id IS NULL AND j.status='Served'
       AND j.served_at::date BETWEEN $2 AND $3
     ORDER BY j.served_at`,
    [server_id, start, end, req.companyId]
  );
  const total = rows.reduce((s, r) => s + Number(r.server_pay || 0), 0);
  res.json({ lines: rows, total, count: rows.length });
}));

app.post('/api/statements', auth, admin, wrap(async (req, res) => {
  const { server_id, start, end } = req.body;
  const { rows: lines } = await q(
    `SELECT id, server_pay FROM jobs
     WHERE assigned_to=$1 AND company_id=$4 AND statement_id IS NULL AND status='Served'
       AND served_at::date BETWEEN $2 AND $3`,
    [server_id, start, end, req.companyId]
  );
  if (!lines.length) return res.status(400).json({ error: 'No unbilled completed serves in that period' });
  const total = lines.reduce((s, r) => s + Number(r.server_pay || 0), 0);
  const { rows } = await q(
    `INSERT INTO statements (server_id,period_start,period_end,total,job_count,company_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [server_id, start, end, total, lines.length, req.companyId]
  );
  await q('UPDATE jobs SET statement_id=$1 WHERE id = ANY($2::int[]) AND company_id=$3',
    [rows[0].id, lines.map(l => l.id), req.companyId]);
  res.json(rows[0]);
}));

app.patch('/api/statements/:id', auth, admin, wrap(async (req, res) => {
  const paid = req.body.status === 'Paid';
  const { rows } = await q(
    'UPDATE statements SET status=$1, paid_at=$2 WHERE id=$3 AND company_id=$4 RETURNING *',
    [req.body.status, paid ? new Date() : null, req.params.id, req.companyId]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such statement in this company' });
  res.json(rows[0]);
}));

app.delete('/api/statements/:id', auth, admin, wrap(async (req, res) => {
  await q('UPDATE jobs SET statement_id=NULL WHERE statement_id=$1 AND company_id=$2',
    [req.params.id, req.companyId]);
  await q('DELETE FROM statements WHERE id=$1 AND company_id=$2', [req.params.id, req.companyId]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------ invoices --- */

app.get('/api/invoices', auth, admin, wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT i.*, c.name AS client_name FROM invoices i JOIN clients c ON c.id=i.client_id
     WHERE i.company_id=$1 ORDER BY i.created_at DESC`, [req.companyId]
  );
  res.json(rows);
}));

app.post('/api/invoices/preview', auth, admin, wrap(async (req, res) => {
  const { client_id, start, end } = req.body;
  const { rows } = await q(
    `SELECT id, job_number, recipient_name, case_number, served_at, client_fee, status FROM jobs
     WHERE client_id=$1 AND company_id=$4 AND invoice_id IS NULL AND status IN ('Served','Non-Est')
       AND COALESCE(served_at, updated_at)::date BETWEEN $2 AND $3
     ORDER BY served_at`,
    [client_id, start, end, req.companyId]
  );
  res.json({ lines: rows, total: rows.reduce((s, r) => s + Number(r.client_fee || 0), 0), count: rows.length });
}));

app.post('/api/invoices', auth, admin, wrap(async (req, res) => {
  const { client_id, start, end } = req.body;
  const { rows: lines } = await q(
    `SELECT id, client_fee FROM jobs WHERE client_id=$1 AND company_id=$4 AND invoice_id IS NULL
     AND status IN ('Served','Non-Est') AND COALESCE(served_at, updated_at)::date BETWEEN $2 AND $3`,
    [client_id, start, end, req.companyId]
  );
  if (!lines.length) return res.status(400).json({ error: 'Nothing unbilled in that period' });
  const total = lines.reduce((s, r) => s + Number(r.client_fee || 0), 0);
  const { rows } = await q(
    `INSERT INTO invoices (client_id,period_start,period_end,total,job_count,company_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [client_id, start, end, total, lines.length, req.companyId]
  );
  await q('UPDATE jobs SET invoice_id=$1 WHERE id = ANY($2::int[]) AND company_id=$3',
    [rows[0].id, lines.map(l => l.id), req.companyId]);
  res.json(rows[0]);
}));

app.patch('/api/invoices/:id', auth, admin, wrap(async (req, res) => {
  const paid = req.body.status === 'Paid';
  const { rows } = await q(
    'UPDATE invoices SET status=$1, paid_at=$2 WHERE id=$3 AND company_id=$4 RETURNING *',
    [req.body.status, paid ? new Date() : null, req.params.id, req.companyId]);
  if (!rows.length) return res.status(404).json({ error: 'No such invoice in this company' });
  res.json(rows[0]);
}));

/* --------------------------------------------------------------- stats --- */

app.get('/api/stats', auth, wrap(async (req, res) => {
  const mine = !isAdmin(req.user) ? ' AND assigned_to=' + Number(req.user.id) : '';
  const { rows } = await q(`
    SELECT
      count(*) FILTER (WHERE status IN ('Pending','Assigned','Attempted','On Hold'))::int AS open_jobs,
      count(*) FILTER (WHERE status='Pending')::int AS unassigned,
      count(*) FILTER (WHERE status IN ('Pending','Assigned','Attempted')
                       AND due_date IS NOT NULL AND due_date < CURRENT_DATE)::int AS overdue,
      count(*) FILTER (WHERE status='Served' AND served_at > NOW() - INTERVAL '7 days')::int AS served_7d,
      count(*) FILTER (WHERE priority IN ('Rush','Same Day')
                       AND status IN ('Pending','Assigned','Attempted'))::int AS rush
    FROM jobs WHERE company_id=$1 ${mine}`, [req.companyId]);
  const unbilled = isAdmin(req.user)
    ? (await q(`SELECT COALESCE(sum(client_fee),0)::float AS v FROM jobs
                WHERE company_id=$1 AND invoice_id IS NULL AND status='Served'`, [req.companyId])).rows[0].v
    : (await q(`SELECT COALESCE(sum(server_pay),0)::float AS v FROM jobs
                WHERE company_id=$2 AND statement_id IS NULL AND status='Served' AND assigned_to=$1`,
               [req.user.id, req.companyId])).rows[0].v;
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
  if (noPrintInSupport(req, res)) return;
  const out = await affidavitText(req.params.id, req.query.template_id, req.companyId);
  if (!out) return res.status(404).send('Not found');
  res.send(printPage(`Affidavit ${out.job.job_number}`, `<pre>${esc(out.text)}</pre>`));
}));

app.get('/print/coversheet/:id', auth, wrap(async (req, res) => {
  if (noPrintInSupport(req, res)) return;
  const { rows } = await q(
    `SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id=j.client_id
     WHERE j.id=$1 AND j.company_id=$2`,
    [req.params.id, req.companyId]
  );
  const j = rows[0];
  if (!j) return res.status(404).send('Not found');
  if (!isAdmin(req.user) && j.assigned_to !== req.user.id) return res.status(403).send('Not your job');
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

const companyName = async id =>
  ((await q('SELECT name FROM companies WHERE id=$1', [id])).rows[0] || {}).name || 'ServeTrack';

app.get('/print/statement/:id', auth, wrap(async (req, res) => {
  if (noPrintInSupport(req, res)) return;
  const { rows: sr } = await q(
    `SELECT s.*, u.name AS server_name, u.license_no, u.email FROM statements s
     JOIN users u ON u.id=s.server_id WHERE s.id=$1 AND s.company_id=$2`,
    [req.params.id, req.companyId]
  );
  const s = sr[0];
  if (!s) return res.status(404).send('Not found');
  if (!isAdmin(req.user) && s.server_id !== req.user.id) return res.status(403).send('Forbidden');
  const { rows: lines } = await q(
    `SELECT j.job_number, j.recipient_name, j.served_at, j.server_pay, c.name AS client_name
     FROM jobs j LEFT JOIN clients c ON c.id=j.client_id
     WHERE j.statement_id=$1 AND j.company_id=$2 ORDER BY j.served_at`,
    [req.params.id, req.companyId]
  );
  const d = v => v ? new Date(v).toLocaleDateString('en-US', { timeZone: TZ }) : '';
  res.send(printPage('Statement #' + s.id, `
    <h1>${esc(await companyName(req.companyId))} — Contractor Pay Statement</h1>
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
  if (noPrintInSupport(req, res)) return;
  const { rows: ir } = await q(
    `SELECT i.*, c.name AS client_name, c.address, c.contact_name FROM invoices i
     JOIN clients c ON c.id=i.client_id WHERE i.id=$1 AND i.company_id=$2`,
    [req.params.id, req.companyId]
  );
  const inv = ir[0];
  if (!inv) return res.status(404).send('Not found');
  const { rows: lines } = await q(
    `SELECT job_number, recipient_name, case_number, served_at, client_fee, status FROM jobs
     WHERE invoice_id=$1 AND company_id=$2 ORDER BY served_at`,
    [req.params.id, req.companyId]
  );
  const d = v => v ? new Date(v).toLocaleDateString('en-US', { timeZone: TZ }) : '';
  res.send(printPage('Invoice #' + inv.id, `
    <h1>${esc(await companyName(req.companyId))} — Invoice</h1>
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
