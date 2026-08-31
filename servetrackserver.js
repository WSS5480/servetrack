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

/* Photos taken at the door, attached to the attempt they belong to.
 *
 * The bytes live here rather than in a bucket so a company's evidence has
 * exactly one home, backed up with everything else, and reachable only through
 * a signed-in request this server has already checked against the company. The
 * phone shrinks each shot before it is sent; the server refuses anything that
 * arrives too big anyway. ON DELETE CASCADE from attempts means removing an
 * attempt takes its photos with it — there is no way to orphan evidence. */
CREATE TABLE IF NOT EXISTS attempt_photos (
  id          SERIAL PRIMARY KEY,
  attempt_id  INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  company_id  INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  caption     TEXT,
  mime        TEXT NOT NULL DEFAULT 'image/jpeg',
  bytes       INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  data        BYTEA NOT NULL,
  taken_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS attempt_photos_attempt_idx ON attempt_photos(attempt_id);
CREATE INDEX IF NOT EXISTS attempt_photos_job_idx     ON attempt_photos(job_id);
CREATE INDEX IF NOT EXISTS attempt_photos_company_idx ON attempt_photos(company_id);
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
  'YW5zZm9ybTpzY2FsZSguOTYpfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLSBwaG90b3MgLS0tICovCi8qIEEgaG9yaXpvbnRhbCBzdHJpcCB1bmRlciBlYWNoIGF0dGVtcHQuIFRodW1ibmFp' +
  'bHMgYXJlIHNxdWFyZSBzbyBhIHJvdyBvZgogICBtaXhlZCBwb3J0cmFpdCBhbmQgbGFuZHNjYXBlIHNob3RzIHN0aWxsIHJlYWRz' +
  'IGFzIGEgdGlkeSBsaW5lLiAqLwoucGhvdG9ze2Rpc3BsYXk6ZmxleDtnYXA6OHB4O292ZXJmbG93LXg6YXV0bztwYWRkaW5nOjEw' +
  'cHggMCAycHg7LXdlYmtpdC1vdmVyZmxvdy1zY3JvbGxpbmc6dG91Y2h9Ci5waG90b3M6Oi13ZWJraXQtc2Nyb2xsYmFye2hlaWdo' +
  'dDowfQoudGh1bWJ7cG9zaXRpb246cmVsYXRpdmU7ZmxleDowIDAgYXV0bzt3aWR0aDo3NnB4O2hlaWdodDo3NnB4O3BhZGRpbmc6' +
  'MDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpOwogIGJvcmRlci1yYWRpdXM6MTBweDtvdmVyZmxvdzpoaWRkZW47YmFja2dy' +
  'b3VuZDp2YXIoLS1jYXJkKTtjdXJzb3I6cG9pbnRlcjtkaXNwbGF5OmJsb2NrfQoudGh1bWIgaW1ne3dpZHRoOjEwMCU7aGVpZ2h0' +
  'OjEwMCU7b2JqZWN0LWZpdDpjb3ZlcjtkaXNwbGF5OmJsb2NrfQoudGh1bWIgLmNhcHtwb3NpdGlvbjphYnNvbHV0ZTtsZWZ0OjA7' +
  'cmlnaHQ6MDtib3R0b206MDtwYWRkaW5nOjNweCA1cHg7Zm9udDo2MDAgMTBweCBzeXN0ZW0tdWk7CiAgY29sb3I6I2ZmZjtiYWNr' +
  'Z3JvdW5kOmxpbmVhci1ncmFkaWVudCgwZGVnLHJnYmEoMCwwLDAsLjY4KSx0cmFuc3BhcmVudCk7dGV4dC1hbGlnbjpsZWZ0Owog' +
  'IHdoaXRlLXNwYWNlOm5vd3JhcDtvdmVyZmxvdzpoaWRkZW47dGV4dC1vdmVyZmxvdzplbGxpcHNpc30KLnRodW1iIC54e3Bvc2l0' +
  'aW9uOmFic29sdXRlO3RvcDozcHg7cmlnaHQ6M3B4O3dpZHRoOjE5cHg7aGVpZ2h0OjE5cHg7Ym9yZGVyLXJhZGl1czo1MCU7CiAg' +
  'YmFja2dyb3VuZDpyZ2JhKDAsMCwwLC42KTtjb2xvcjojZmZmO2ZvbnQ6NzAwIDEzcHgvMTlweCBzeXN0ZW0tdWk7dGV4dC1hbGln' +
  'bjpjZW50ZXJ9Ci50aHVtYi5hZGR7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjthbGlnbi1pdGVtczpjZW50ZXI7' +
  'anVzdGlmeS1jb250ZW50OmNlbnRlcjtnYXA6MnB4OwogIGJvcmRlcjoxLjVweCBkYXNoZWQgdmFyKC0tYnJhbmQpO2NvbG9yOnZh' +
  'cigtLWJyYW5kKTtiYWNrZ3JvdW5kOiNGMkY2RkU7CiAgZm9udDo3MDAgMTlweCBzeXN0ZW0tdWl9Ci50aHVtYi5hZGQgc3Bhbntm' +
  'b250OjcwMCAxMHB4IHN5c3RlbS11aTtsZXR0ZXItc3BhY2luZzouMDJlbX0KLnRodW1iOmFjdGl2ZXt0cmFuc2Zvcm06c2NhbGUo' +
  'Ljk3KX0KLnBob3RvLWhpZGRlbntmb250LXN0eWxlOml0YWxpYztvcGFjaXR5Oi43NX0KCi8qIFJlY2VpdmFibGVzOiBvbmUgYmln' +
  'IG51bWJlciwgdGhlbiB0aGUgYWdpbmcgcm93IHVuZGVyIGl0LiAqLwouc3RhdC5iaWcgLm57Zm9udC1zaXplOjMycHh9Ci5zdGF0' +
  'LmJhZCAubntjb2xvcjp2YXIoLS1iYWQpfQoKPC9zdHlsZT4KPGxpbmsgcmVsPSJpY29uIiBocmVmPSJkYXRhOmltYWdlL3N2Zyt4' +
  'bWwsPHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAzMiAzMic+PHJlY3Qgd2lkdGg9' +
  'JzMyJyBoZWlnaHQ9JzMyJyByeD0nNycgZmlsbD0nJTIzMWUzYTVmJy8+PHRleHQgeD0nMTYnIHk9JzIzJyBmb250LXNpemU9JzE5' +
  'JyBmb250LWZhbWlseT0nc3lzdGVtLXVpJyBmb250LXdlaWdodD0nNzAwJyBmaWxsPSd3aGl0ZScgdGV4dC1hbmNob3I9J21pZGRs' +
  'ZSc+UzwvdGV4dD48L3N2Zz4iPgo8L2hlYWQ+Cjxib2R5Pgo8ZGl2IGlkPSJhcHAiPjwvZGl2Pgo8c2NyaXB0IHNyYz0iaHR0cHM6' +
  'Ly9jZG4uanNkZWxpdnIubmV0L25wbS9AenhpbmcvbGlicmFyeUAwLjIxLjMvdW1kL2luZGV4Lm1pbi5qcyI+PC9zY3JpcHQ+Cjxz' +
  'Y3JpcHQ+Ci8qIFNlcnZlVHJhY2sg4oCUIGZpZWxkLWZpcnN0IHByb2Nlc3Mgc2VydmluZyBtYW5hZ2VyICovCihmdW5jdGlvbiAo' +
  'KSB7Cid1c2Ugc3RyaWN0JzsKCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLSBoZWxwZXJzIC0tICovCmNvbnN0ICQgPSBzZWwgPT4gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWwpOwpjb25zdCBh' +
  'cHAgPSAkKCcjYXBwJyk7CmNvbnN0IFMgPSB7IG1lOiBudWxsLCB2aWV3OiAnZGFzaCcsIHBhcmFtczoge30sIGNhY2hlOiB7fSB9' +
  'OwoKY29uc3QgZXNjID0gcyA9PiBTdHJpbmcocyA9PSBudWxsID8gJycgOiBzKQogIC5yZXBsYWNlKC8mL2csICcmYW1wOycpLnJl' +
  'cGxhY2UoLzwvZywgJyZsdDsnKS5yZXBsYWNlKC8+L2csICcmZ3Q7JykKICAucmVwbGFjZSgvIi9nLCAnJnF1b3Q7JykucmVwbGFj' +
  'ZSgvJy9nLCAnJiMzOTsnKTsKCmNvbnN0IG1vbmV5ID0gdiA9PiAnJCcgKyBOdW1iZXIodiB8fCAwKS50b0ZpeGVkKDIpOwpjb25z' +
  'dCBjbHMgPSBzID0+IFN0cmluZyhzIHx8ICcnKS5yZXBsYWNlKC9bXkEtWmEtel0vZywgJycpOwoKZnVuY3Rpb24gZm10RGF0ZSh2' +
  'LCBvcHRzKSB7CiAgaWYgKCF2KSByZXR1cm4gJyc7CiAgY29uc3QgZCA9IG5ldyBEYXRlKHYpOwogIHJldHVybiBkLnRvTG9jYWxl' +
  'RGF0ZVN0cmluZygnZW4tVVMnLCBvcHRzIHx8IHsgbW9udGg6ICdzaG9ydCcsIGRheTogJ251bWVyaWMnLCB5ZWFyOiAnbnVtZXJp' +
  'YycgfSk7Cn0KZnVuY3Rpb24gZm10RGF0ZU9ubHkodikgeyAvLyBkYXRlIGNvbHVtbnMgY29tZSBiYWNrIGFzIFlZWVktTU0tREQg' +
  'b3IgSVNPIG1pZG5pZ2h0IFVUQwogIGlmICghdikgcmV0dXJuICcnOwogIGNvbnN0IHMgPSBTdHJpbmcodikuc2xpY2UoMCwgMTAp' +
  'LnNwbGl0KCctJyk7CiAgcmV0dXJuIGAkeytzWzFdfS8keytzWzJdfS8ke3NbMF0uc2xpY2UoMil9YDsKfQpmdW5jdGlvbiBmbXRE' +
  'VCh2KSB7CiAgaWYgKCF2KSByZXR1cm4gJyc7CiAgcmV0dXJuIG5ldyBEYXRlKHYpLnRvTG9jYWxlU3RyaW5nKCdlbi1VUycsCiAg' +
  'ICB7IG1vbnRoOiAnc2hvcnQnLCBkYXk6ICdudW1lcmljJywgaG91cjogJ251bWVyaWMnLCBtaW51dGU6ICcyLWRpZ2l0JyB9KTsK' +
  'fQpmdW5jdGlvbiBkYXlzT3V0KHYpIHsKICBpZiAoIXYpIHJldHVybiBudWxsOwogIGNvbnN0IGR1ZSA9IG5ldyBEYXRlKFN0cmlu' +
  'Zyh2KS5zbGljZSgwLCAxMCkgKyAnVDEyOjAwOjAwJyk7CiAgcmV0dXJuIE1hdGgucm91bmQoKGR1ZSAtIG5ldyBEYXRlKCkpIC8g' +
  'ODY0ZTUpOwp9CmNvbnN0IHRvZGF5SVNPID0gKCkgPT4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKTsKCmFz' +
  'eW5jIGZ1bmN0aW9uIGFwaShwYXRoLCBvcHRzKSB7CiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goJy9hcGknICsgcGF0aCwgT2Jq' +
  'ZWN0LmFzc2lnbih7CiAgICBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSwgY3JlZGVudGlh' +
  'bHM6ICdzYW1lLW9yaWdpbicKICB9LCBvcHRzIHx8IHt9KSk7CiAgY29uc3QgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCkuY2F0Y2go' +
  'KCkgPT4gKHt9KSk7CiAgLy8gQSA0MDEgZnJvbSAvbG9naW4gbWVhbnMgdGhlIGNyZWRlbnRpYWxzIHdlcmUgd3JvbmcsIG5vdCB0' +
  'aGF0IGEgc2Vzc2lvbgogIC8vIGxhcHNlZC4gVHJlYXRpbmcgdGhlIHR3byB0aGUgc2FtZSBzaG93ZWQgIlNpZ25lZCBvdXQiIHRv' +
  'IHNvbWVvbmUgd2hvIGhhZAogIC8vIHNpbXBseSBtaXN0eXBlZCBhIHBhc3N3b3JkLCB3aGljaCBpcyBhY3RpdmVseSBtaXNsZWFk' +
  'aW5nLgogIGlmIChyZXMuc3RhdHVzID09PSA0MDEgJiYgcGF0aCAhPT0gJy9sb2dpbicpIHsKICAgIFMubWUgPSBudWxsOwogICAg' +
  'cmVuZGVyKCk7CiAgICB0aHJvdyBuZXcgRXJyb3IoZGF0YS5lcnJvciB8fCAnU2lnbmVkIG91dCcpOwogIH0KICBpZiAoIXJlcy5v' +
  'aykgdGhyb3cgbmV3IEVycm9yKGRhdGEuZXJyb3IgfHwgJ1JlcXVlc3QgZmFpbGVkJyk7CiAgcmV0dXJuIGRhdGE7Cn0KCmZ1bmN0' +
  'aW9uIHRvYXN0KG1zZywgYmFkKSB7CiAgY29uc3QgdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogIHQuY2xhc3NO' +
  'YW1lID0gJ3RvYXN0JyArIChiYWQgPyAnIGJhZCcgOiAnJyk7CiAgdC50ZXh0Q29udGVudCA9IG1zZzsKICBkb2N1bWVudC5ib2R5' +
  'LmFwcGVuZENoaWxkKHQpOwogIHNldFRpbWVvdXQoKCkgPT4gdC5yZW1vdmUoKSwgMzIwMCk7Cn0KCmZ1bmN0aW9uIGdvKHZpZXcs' +
  'IHBhcmFtcykgeyBTLnZpZXcgPSB2aWV3OyBTLnBhcmFtcyA9IHBhcmFtcyB8fCB7fTsgd2luZG93LnNjcm9sbFRvKDAsIDApOyBy' +
  'ZW5kZXIoKTsgfQoKLyogbW9kYWwgc2hlZXQgKi8KbGV0IHNoZWV0RWwgPSBudWxsOwpmdW5jdGlvbiBzaGVldCh0aXRsZSwgYm9k' +
  'eUh0bWwsIG9uTW91bnQpIHsKICBjbG9zZVNoZWV0KCk7CiAgc2hlZXRFbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2Rpdicp' +
  'OwogIHNoZWV0RWwuY2xhc3NOYW1lID0gJ3NoZWV0JzsKICBzaGVldEVsLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJpbm5lciI+' +
  'PGgyPiR7ZXNjKHRpdGxlKX08L2gyPiR7Ym9keUh0bWx9PC9kaXY+YDsKICBzaGVldEVsLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNr' +
  'JywgZSA9PiB7IGlmIChlLnRhcmdldCA9PT0gc2hlZXRFbCkgY2xvc2VTaGVldCgpOyB9KTsKICBkb2N1bWVudC5ib2R5LmFwcGVu' +
  'ZENoaWxkKHNoZWV0RWwpOwogIGlmIChvbk1vdW50KSBvbk1vdW50KHNoZWV0RWwpOwp9CmZ1bmN0aW9uIGNsb3NlU2hlZXQoKSB7' +
  'CiAgaWYgKHNoZWV0RWwpIHsgc2hlZXRFbC5yZW1vdmUoKTsgc2hlZXRFbCA9IG51bGw7IH0KICBpZiAod2luZG93Ll9fc3RvcFNj' +
  'YW4pIHsgd2luZG93Ll9fc3RvcFNjYW4oKTsgd2luZG93Ll9fc3RvcFNjYW4gPSBudWxsOyB9Cn0Kd2luZG93LmNsb3NlU2hlZXQg' +
  'PSBjbG9zZVNoZWV0OwoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBt' +
  'YXBzIGxpbmtpbmcgLS0gKi8KY29uc3QgaXNJT1MgPSAoKSA9PiAvaVBhZHxpUGhvbmV8aVBvZC8udGVzdChuYXZpZ2F0b3IudXNl' +
  'ckFnZW50KSB8fAogIChuYXZpZ2F0b3IucGxhdGZvcm0gPT09ICdNYWNJbnRlbCcgJiYgbmF2aWdhdG9yLm1heFRvdWNoUG9pbnRz' +
  'ID4gMSk7CgpmdW5jdGlvbiBhZGRyT2YoaikgewogIHJldHVybiBbai5hZGRyZXNzMSwgai5hZGRyZXNzMiwgai5jaXR5LCBqLnN0' +
  'YXRlLCBqLnppcF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJywgJyk7Cn0KZnVuY3Rpb24gYXBwbGVVcmwoYSkgeyByZXR1cm4gJ2h0' +
  'dHBzOi8vbWFwcy5hcHBsZS5jb20vP2RhZGRyPScgKyBlbmNvZGVVUklDb21wb25lbnQoYSkgKyAnJmRpcmZsZz1kJzsgfQpmdW5j' +
  'dGlvbiBnb29nbGVVcmwoYSkgewogIHJldHVybiAnaHR0cHM6Ly93d3cuZ29vZ2xlLmNvbS9tYXBzL2Rpci8/YXBpPTEmZGVzdGlu' +
  'YXRpb249JyArIGVuY29kZVVSSUNvbXBvbmVudChhKSArICcmdHJhdmVsbW9kZT1kcml2aW5nJzsKfQpmdW5jdGlvbiBuYXZVcmwo' +
  'YSkgeyByZXR1cm4gaXNJT1MoKSA/IGFwcGxlVXJsKGEpIDogZ29vZ2xlVXJsKGEpOyB9CmZ1bmN0aW9uIHJvdXRlVXJsKGxpc3Qp' +
  'IHsKICBjb25zdCBzdG9wcyA9IGxpc3QubWFwKGFkZHJPZikuZmlsdGVyKEJvb2xlYW4pOwogIGlmICghc3RvcHMubGVuZ3RoKSBy' +
  'ZXR1cm4gbnVsbDsKICBjb25zdCBkZXN0ID0gc3RvcHNbc3RvcHMubGVuZ3RoIC0gMV07CiAgY29uc3Qgd2F5ID0gc3RvcHMuc2xp' +
  'Y2UoMCwgLTEpLnNsaWNlKDAsIDkpLm1hcChlbmNvZGVVUklDb21wb25lbnQpLmpvaW4oJ3wnKTsKICByZXR1cm4gJ2h0dHBzOi8v' +
  'd3d3Lmdvb2dsZS5jb20vbWFwcy9kaXIvP2FwaT0xJm9yaWdpbj1DdXJyZW50K0xvY2F0aW9uJmRlc3RpbmF0aW9uPScgKwogICAg' +
  'ZW5jb2RlVVJJQ29tcG9uZW50KGRlc3QpICsgKHdheSA/ICcmd2F5cG9pbnRzPScgKyB3YXkgOiAnJykgKyAnJnRyYXZlbG1vZGU9' +
  'ZHJpdmluZyc7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0gbGF5b3V0IC0tICovCmNvbnN0IGlzQWRtaW4gPSAoKSA9PiBTLm1lICYmIChTLm1lLnJvbGUgPT09ICdhZG1pbicgfHwgUy5t' +
  'ZS5yb2xlID09PSAnb3duZXInKTsKY29uc3QgaXNPd25lciA9ICgpID0+IFMubWUgJiYgUy5tZS5yb2xlID09PSAnb3duZXInOwpj' +
  'b25zdCByb2xlTGFiZWwgPSAoKSA9PiBTLm1lLnJvbGUgPT09ICdvd25lcicgPyAnT3duZXInCiAgOiAoUy5tZS5yb2xlID09PSAn' +
  'YWRtaW4nID8gJ0FkbWluJyA6ICdGaWVsZCBzZXJ2ZXInKTsKCmNvbnN0IFRBQlMgPSAoKSA9PiBpc0FkbWluKCkKICA/IFtbJ2Rh' +
  'c2gnLCAnVG9kYXknLCAn4peOJ10sIFsnam9icycsICdKb2JzJywgJ+KWpCddLCBbJ3NjYW4nLCAnU2NhbicsICfilqUnXSwKICAg' +
  'ICBbJ3Rvb2xzJywgJ1Rvb2xzJywgJ+KcgiddLCBbJ3Byb3BlcnR5JywgJ1Byb3AnLCAn4oyCJ10sIFsnbW9uZXknLCAnQmlsbCcs' +
  'ICckJ10sIFsnYWRtaW4nLCAnU2V0dXAnLCAn4pqZJ11dCiAgOiBbWydkYXNoJywgJ015IERheScsICfil44nXSwgWydqb2JzJywg' +
  'J0pvYnMnLCAn4pakJ10sIFsnc2NhbicsICdTY2FuJywgJ+KWpSddLAogICAgIFsndG9vbHMnLCAnVG9vbHMnLCAn4pyCJ10sIFsn' +
  'cHJvcGVydHknLCAnUHJvcCcsICfijIInXSwgWydtb25leScsICdQYXknLCAnJCddXTsKCmZ1bmN0aW9uIHNoZWxsKGlubmVyKSB7' +
  'CiAgY29uc3QgdGFicyA9IFRBQlMoKS5tYXAoKFt2LCBsYWJlbCwgaWNdKSA9PgogICAgYDxidXR0b24gZGF0YS10YWI9IiR7dn0i' +
  'IGNsYXNzPSIke1MudmlldyA9PT0gdiB8fCAodiA9PT0gJ2pvYnMnICYmIFMudmlldyA9PT0gJ2pvYicpID8gJ29uJyA6ICcnfSI+' +
  'CiAgICAgIDxzcGFuIGNsYXNzPSJpYyI+JHtpY308L3NwYW4+JHtlc2MobGFiZWwpfTwvYnV0dG9uPmApLmpvaW4oJycpOwogIGNv' +
  'bnN0IHN1cHBvcnRCYXIgPSBTLm1lLnN1cHBvcnQKICAgID8gYDxkaXYgc3R5bGU9ImJhY2tncm91bmQ6I0MyNDEwQztjb2xvcjoj' +
  'ZmZmO3RleHQtYWxpZ246Y2VudGVyO2ZvbnQtc2l6ZToxMi41cHg7CiAgICAgICAgcGFkZGluZzo2cHggMTBweDtmb250LXdlaWdo' +
  'dDo2MDAiPlN1cHBvcnQgdmlldyDigJQgbmFtZXMgJmFtcDsgZG9jdW1lbnRzIGFyZSBoaWRkZW4uCiAgICAgICAgVGhpcyBpcyAk' +
  'e2VzYyhTLm1lLmNvbXBhbnkgPyBTLm1lLmNvbXBhbnkubmFtZSA6ICdhIGN1c3RvbWVyIGNvbXBhbnknKX0sIG5vdCB5b3Vycy48' +
  'L2Rpdj5gCiAgICA6ICcnOwogIHJldHVybiBgJHtzdXBwb3J0QmFyfQogICAgPGRpdiBjbGFzcz0idG9wYmFyIj4KICAgICAgPGRp' +
  'diBjbGFzcz0iYnJhbmQiPlNlcnZlVHJhY2s8c21hbGw+JHtlc2MoUy5tZS5jb21wYW55ID8gUy5tZS5jb21wYW55Lm5hbWUgOiAn' +
  'Jyl9JHsKICAgICAgICBTLm1lLmNvbXBhbnkgPyAnIMK3ICcgOiAnJ30ke2VzYyhTLm1lLm5hbWUpfSDCtyAke3JvbGVMYWJlbCgp' +
  'fTwvc21hbGw+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InNwYWNlciI+PC9kaXY+CiAgICAgICR7aXNPd25lcigpICYmIChTLm1l' +
  'LmNvbXBhbmllcyB8fCBbXSkubGVuZ3RoID4gMQogICAgICAgID8gYDxzZWxlY3QgaWQ9ImNvU3dpdGNoIiB0aXRsZT0iV2hpY2gg' +
  'Y29tcGFueSB5b3UgYXJlIHdvcmtpbmcgaW4iPiR7CiAgICAgICAgICAgIChTLm1lLmNvbXBhbmllcyB8fCBbXSkubWFwKGMgPT4g' +
  'YDxvcHRpb24gdmFsdWU9IiR7Yy5pZH0iJHsKICAgICAgICAgICAgICBTLm1lLmNvbXBhbnkgJiYgYy5pZCA9PT0gUy5tZS5jb21w' +
  'YW55LmlkID8gJyBzZWxlY3RlZCcgOiAnJ30+JHtlc2MoYy5uYW1lKX08L29wdGlvbj5gKS5qb2luKCcnKQogICAgICAgICAgfTwv' +
  'c2VsZWN0PmAgOiAnJ30KICAgICAgPGJ1dHRvbiBpZD0ibG9nb3V0Ij5TaWduIG91dDwvYnV0dG9uPgogICAgPC9kaXY+CiAgICA8' +
  'ZGl2IGNsYXNzPSJ3cmFwIj4ke2lubmVyfTwvZGl2PgogICAgPGRpdiBjbGFzcz0idGFicyI+JHt0YWJzfTwvZGl2PmA7Cn0KCmZ1' +
  'bmN0aW9uIGJpbmRTaGVsbCgpIHsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS10YWJdJykuZm9yRWFjaChiID0+' +
  'CiAgICBiLm9uY2xpY2sgPSAoKSA9PiBnbyhiLmRhdGFzZXQudGFiKSk7CiAgY29uc3QgbG8gPSAkKCcjbG9nb3V0Jyk7CiAgaWYg' +
  'KGxvKSBsby5vbmNsaWNrID0gYXN5bmMgKCkgPT4geyBhd2FpdCBhcGkoJy9sb2dvdXQnLCB7IG1ldGhvZDogJ1BPU1QnIH0pOyBT' +
  'Lm1lID0gbnVsbDsgcmVuZGVyKCk7IH07CiAgY29uc3Qgc3cgPSAkKCcjY29Td2l0Y2gnKTsKICBpZiAoc3cpIHN3Lm9uY2hhbmdl' +
  'ID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAgICAgY29uc3Qgb3V0ID0gYXdhaXQgYXBpKCcvY29tcGFuaWVzLycgKyBzdy52' +
  'YWx1ZSArICcvZW50ZXInLCB7IG1ldGhvZDogJ1BPU1QnIH0pOwogICAgICBTLm1lID0gYXdhaXQgYXBpKCcvbWUnKTsKICAgICAg' +
  'dG9hc3QoJ05vdyBpbiAnICsgb3V0LmNvbXBhbnkubmFtZSk7CiAgICAgIHJlbmRlcigpOwogICAgfSBjYXRjaCAoZSkgeyB0b2Fz' +
  'dChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0gbG9naW4gLS0gKi8KZnVuY3Rpb24gbG9naW5WaWV3KCkgewogIGFwcC5pbm5lckhUTUwgPSBg' +
  'PGRpdiBjbGFzcz0ibG9naW4iPgogICAgPGRpdiBjbGFzcz0ibG9nbyI+PGI+U2VydmVUcmFjazwvYj48ZGl2PlByb2Nlc3Mgc2Vy' +
  'dmluZyBtYW5hZ2VtZW50PC9kaXY+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQi' +
  'PjxsYWJlbD5FbWFpbDwvbGFiZWw+PGlucHV0IGlkPSJlbWFpbCIgdHlwZT0iZW1haWwiIGF1dG9jb21wbGV0ZT0idXNlcm5hbWUi' +
  'IGlucHV0bW9kZT0iZW1haWwiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBhc3N3b3JkPC9sYWJlbD48' +
  'aW5wdXQgaWQ9InB3IiB0eXBlPSJwYXNzd29yZCIgYXV0b2NvbXBsZXRlPSJjdXJyZW50LXBhc3N3b3JkIj48L2Rpdj4KICAgICAg' +
  'PGJ1dHRvbiBjbGFzcz0iYnRuIGJsb2NrIiBpZD0ic2lnbmluIj5TaWduIGluPC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9Imhp' +
  'bnQiIGlkPSJlcnIiIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQpO21hcmdpbi10b3A6MTBweCI+PC9kaXY+CiAgICAgIDxkaXYgY2xh' +
  'c3M9ImhpbnQiIHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlcjttYXJnaW4tdG9wOjE0cHgiPgogICAgICAgIEJlZW4gZ2l2ZW4gYW4g' +
  'YWNjZXNzIGNvZGU/IDxhIGhyZWY9IiMiIGlkPSJoYXZlQ29kZSI+U2V0IHVwIHlvdXIgYWNjb3VudDwvYT48L2Rpdj4KICAgICAg' +
  'PGRpdiBjbGFzcz0iaGludCIgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyO21hcmdpbi10b3A6MTBweCI+CiAgICAgICAgPGEgaHJl' +
  'Zj0iL3ByaXZhY3kiIHRhcmdldD0iX2JsYW5rIj5Qcml2YWN5IHN0YXRlbWVudDwvYT48L2Rpdj4KICAgIDwvZGl2PjwvZGl2PmA7' +
  'CiAgY29uc3Qgc3VibWl0ID0gYXN5bmMgKCkgPT4gewogICAgJCgnI2VycicpLnRleHRDb250ZW50ID0gJyc7CiAgICB0cnkgewog' +
  'ICAgICBhd2FpdCBhcGkoJy9sb2dpbicsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZW1haWw6ICQo' +
  'JyNlbWFpbCcpLnZhbHVlLCBwYXNzd29yZDogJCgnI3B3JykudmFsdWUgfSkgfSk7CiAgICAgIFMubWUgPSBhd2FpdCBhcGkoJy9t' +
  'ZScpOwogICAgICBnbygnZGFzaCcpOwogICAgfSBjYXRjaCAoZSkgeyAkKCcjZXJyJykudGV4dENvbnRlbnQgPSBlLm1lc3NhZ2U7' +
  'IH0KICB9OwogICQoJyNzaWduaW4nKS5vbmNsaWNrID0gc3VibWl0OwogICQoJyNwdycpLm9ua2V5ZG93biA9IGUgPT4geyBpZiAo' +
  'ZS5rZXkgPT09ICdFbnRlcicpIHN1Ym1pdCgpOyB9OwogICQoJyNoYXZlQ29kZScpLm9uY2xpY2sgPSBlID0+IHsgZS5wcmV2ZW50' +
  'RGVmYXVsdCgpOyByZWRlZW1WaWV3KCk7IH07CiAgJCgnI2VtYWlsJykuZm9jdXMoKTsKfQoKCi8qIFJlZGVlbWluZyBhIGNvZGUg' +
  'Y3JlYXRlcyB0aGUgYWNjb3VudCwgc28gc29tZW9uZSBjYW4gYmUgc2V0IHVwIHdpdGhvdXQgYW4KICAgYWRtaW4ga2V5aW5nIGlu' +
  'IHRoZWlyIGRldGFpbHMuICovCmZ1bmN0aW9uIHJlZGVlbVZpZXcoKSB7CiAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJs' +
  'b2dpbiI+CiAgICA8ZGl2IGNsYXNzPSJsb2dvIj48Yj5TZXJ2ZVRyYWNrPC9iPjxkaXY+U2V0IHVwIHlvdXIgYWNjb3VudDwvZGl2' +
  'PjwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+QWNjZXNzIGNvZGU8' +
  'L2xhYmVsPgogICAgICAgIDxpbnB1dCBpZD0icl9jb2RlIiBwbGFjZWhvbGRlcj0iQUJDRC1FRkdILUpLTE0iIGF1dG9jYXBpdGFs' +
  'aXplPSJjaGFyYWN0ZXJzIiBzdHlsZT0idGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0i' +
  'ZmllbGQiPjxsYWJlbD5Zb3VyIG5hbWU8L2xhYmVsPjxpbnB1dCBpZD0icl9uYW1lIiBhdXRvY29tcGxldGU9Im5hbWUiPjwvZGl2' +
  'PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkVtYWlsPC9sYWJlbD48aW5wdXQgaWQ9InJfZW1haWwiIHR5cGU9ImVt' +
  'YWlsIiBpbnB1dG1vZGU9ImVtYWlsIiBhdXRvY29tcGxldGU9ImVtYWlsIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQi' +
  'PjxsYWJlbD5DaG9vc2UgYSBwYXNzd29yZDwvbGFiZWw+CiAgICAgICAgPGlucHV0IGlkPSJyX3B3IiB0eXBlPSJwYXNzd29yZCIg' +
  'YXV0b2NvbXBsZXRlPSJuZXctcGFzc3dvcmQiIHBsYWNlaG9sZGVyPSJBdCBsZWFzdCA4IGNoYXJhY3RlcnMiPjwvZGl2PgogICAg' +
  'ICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPllvdXIgY29tcGFueSA8c3BhbiBjbGFzcz0iaGludCI+4oCUIG9ubHkgaWYgeW91' +
  'IGFyZSBzdGFydGluZyBhIG5ldyBvbmU8L3NwYW4+PC9sYWJlbD4KICAgICAgICA8aW5wdXQgaWQ9InJfY28iIHBsYWNlaG9sZGVy' +
  'PSJlLmcuIFJpbyBHcmFuZGUgUHJvY2VzcyBTZXJ2aW5nIj48L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJsb2NrIiBp' +
  'ZD0icl9nbyI+Q3JlYXRlIG15IGFjY291bnQ8L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgaWQ9InJfZXJyIiBzdHls' +
  'ZT0iY29sb3I6dmFyKC0tYmFkKTttYXJnaW4tdG9wOjEwcHgiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0i' +
  'dGV4dC1hbGlnbjpjZW50ZXI7bWFyZ2luLXRvcDoxNHB4Ij4KICAgICAgICA8YSBocmVmPSIjIiBpZD0icl9iYWNrIj5CYWNrIHRv' +
  'IHNpZ24gaW48L2E+PC9kaXY+CiAgICA8L2Rpdj48L2Rpdj5gOwoKICAkKCcjcl9iYWNrJykub25jbGljayA9IGUgPT4geyBlLnBy' +
  'ZXZlbnREZWZhdWx0KCk7IGxvZ2luVmlldygpOyB9OwogIGNvbnN0IGdvID0gYXN5bmMgKCkgPT4gewogICAgJCgnI3JfZXJyJyku' +
  'dGV4dENvbnRlbnQgPSAnJzsKICAgIHRyeSB7CiAgICAgIGNvbnN0IG1hZGUgPSBhd2FpdCBhcGkoJy9yZWRlZW0nLCB7IG1ldGhv' +
  'ZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgY29kZTogJCgnI3JfY29kZScpLnZhbHVlLCBuYW1lOiAk' +
  'KCcjcl9uYW1lJykudmFsdWUsIGNvbXBhbnk6ICQoJyNyX2NvJykudmFsdWUsCiAgICAgICAgZW1haWw6ICQoJyNyX2VtYWlsJyku' +
  'dmFsdWUsIHBhc3N3b3JkOiAkKCcjcl9wdycpLnZhbHVlCiAgICAgIH0pIH0pOwogICAgICBTLm1lID0gYXdhaXQgYXBpKCcvbWUn' +
  'KTsKICAgICAgdG9hc3QoJ1dlbGNvbWUsICcgKyBtYWRlLm5hbWUpOwogICAgICBnbzIoKTsKICAgIH0gY2F0Y2ggKGUpIHsgJCgn' +
  'I3JfZXJyJykudGV4dENvbnRlbnQgPSBlLm1lc3NhZ2U7IH0KICB9OwogIGNvbnN0IGdvMiA9ICgpID0+IHsgUy52aWV3ID0gJ2Rh' +
  'c2gnOyBTLnBhcmFtcyA9IHt9OyByZW5kZXIoKTsgfTsKICAkKCcjcl9nbycpLm9uY2xpY2sgPSBnbzsKICAkKCcjcl9wdycpLm9u' +
  'a2V5ZG93biA9IGUgPT4geyBpZiAoZS5rZXkgPT09ICdFbnRlcicpIGdvKCk7IH07CiAgJCgnI3JfY29kZScpLmZvY3VzKCk7Cn0K' +
  'Ci8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gZGFzaGJvYXJkIC0t' +
  'ICovCmFzeW5jIGZ1bmN0aW9uIGRhc2hWaWV3KCkgewogIGNvbnN0IFtzdGF0cywgam9ic10gPSBhd2FpdCBQcm9taXNlLmFsbChb' +
  'YXBpKCcvc3RhdHMnKSwgYXBpKCcvam9icz9vcGVuPTEnKV0pOwogIGNvbnN0IG92ZXJkdWUgPSBqb2JzLmZpbHRlcihqID0+IHsg' +
  'Y29uc3QgZCA9IGRheXNPdXQoai5kdWVfZGF0ZSk7IHJldHVybiBkICE9PSBudWxsICYmIGQgPCAwOyB9KTsKICBjb25zdCB0b2Rh' +
  'eSA9IGpvYnMuZmlsdGVyKGogPT4geyBjb25zdCBkID0gZGF5c091dChqLmR1ZV9kYXRlKTsgcmV0dXJuIGQgIT09IG51bGwgJiYg' +
  'ZCA+PSAwICYmIGQgPD0gMTsgfSk7CiAgY29uc3QgcnVzaCA9IGpvYnMuZmlsdGVyKGogPT4gai5wcmlvcml0eSAhPT0gJ1JvdXRp' +
  'bmUnKTsKICBjb25zdCBtaW5lID0gaXNBZG1pbigpID8gam9icyA6IGpvYnM7CgogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAg' +
  'ICA8aDEgY2xhc3M9InBhZ2UiPiR7aXNBZG1pbigpID8gJ09wZXJhdGlvbnMgdG9kYXknIDogJ015IGRheSd9PC9oMT4KICAgIDxk' +
  'aXYgY2xhc3M9InN0YXRzIj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdCI+PGRpdiBjbGFzcz0ibiI+JHtzdGF0cy5vcGVuX2pvYnN9' +
  'PC9kaXY+PGRpdiBjbGFzcz0ibCI+T3BlbiBqb2JzPC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQgJHtzdGF0cy5v' +
  'dmVyZHVlID8gJ2FsZXJ0JyA6ICcnfSI+PGRpdiBjbGFzcz0ibiI+JHtzdGF0cy5vdmVyZHVlfTwvZGl2PjxkaXYgY2xhc3M9Imwi' +
  'PlBhc3QgZHVlPC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxkaXYgY2xhc3M9Im4iPiR7c3RhdHMucnVzaH08' +
  'L2Rpdj48ZGl2IGNsYXNzPSJsIj5SdXNoIC8gc2FtZSBkYXk8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdCBnb29k' +
  'Ij48ZGl2IGNsYXNzPSJuIj4ke3N0YXRzLnNlcnZlZF83ZH08L2Rpdj48ZGl2IGNsYXNzPSJsIj5TZXJ2ZWQsIDcgZGF5czwvZGl2' +
  'PjwvZGl2PgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5Sb3V0ZSBteSBkYXkgPHNwYW4gY2xh' +
  'c3M9InN1YiI+4oCUICR7bWluZS5sZW5ndGh9IG9wZW4gc3RvcCR7bWluZS5sZW5ndGggPT09IDEgPyAnJyA6ICdzJ308L3NwYW4+' +
  'PC9oMj4KICAgICAgPHAgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOi00cHgiPk9wZW5zIEdvb2dsZSBNYXBzIHdpdGgg' +
  'eW91ciBzdG9wcyBpbiBvcmRlciAodXAgdG8gMTApLiBObyBtYXBwaW5nIGZlZXMg4oCUIGl0IGp1c3QgaGFuZHMgb2ZmIHRvIHRo' +
  'ZSBhcHAgeW91IGFscmVhZHkgaGF2ZS48L3A+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+' +
  'CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIG5hdiIgaWQ9InJvdXRlQnRuIiAke21pbmUubGVuZ3RoID8gJycgOiAnZGlzYWJs' +
  'ZWQnfT5TdGFydCByb3V0ZSAoJHtNYXRoLm1pbihtaW5lLmxlbmd0aCwgMTApfSBzdG9wcyk8L2J1dHRvbj4KICAgICAgICA8YnV0' +
  'dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0icm91dGVMaXN0Ij5TZWUgb3JkZXI8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8' +
  'L2Rpdj4KCiAgICAke3NlY3Rpb24oJ1Bhc3QgZHVlJywgb3ZlcmR1ZSl9CiAgICAke3NlY3Rpb24oJ0R1ZSB0b2RheSBvciB0b21v' +
  'cnJvdycsIHRvZGF5KX0KICAgICR7c2VjdGlvbignUnVzaCAmYW1wOyBzYW1lIGRheScsIHJ1c2guZmlsdGVyKGogPT4gIW92ZXJk' +
  'dWUuaW5jbHVkZXMoaikgJiYgIXRvZGF5LmluY2x1ZGVzKGopKSl9CiAgICAke292ZXJkdWUubGVuZ3RoICsgdG9kYXkubGVuZ3Ro' +
  'ICsgcnVzaC5sZW5ndGggPT09IDAKICAgICAgPyBgPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0iZW1wdHkiPk5vdGhpbmcg' +
  'dXJnZW50LiAke21pbmUubGVuZ3RofSBvcGVuIGpvYiR7bWluZS5sZW5ndGggPT09IDEgPyAnJyA6ICdzJ30gdG90YWwg4oCUIHNl' +
  'ZSB0aGUgSm9icyB0YWIuPC9kaXY+PC9kaXY+YCA6ICcnfQogIGApOwogIGJpbmRTaGVsbCgpOwogIGJpbmRKb2JJdGVtcygpOwog' +
  'IGNvbnN0IHJiID0gJCgnI3JvdXRlQnRuJyk7CiAgaWYgKHJiKSByYi5vbmNsaWNrID0gKCkgPT4gewogICAgY29uc3QgdXJsID0g' +
  'cm91dGVVcmwobWluZS5zbGljZSgwLCAxMCkpOwogICAgaWYgKHVybCkgd2luZG93Lm9wZW4odXJsLCAnX2JsYW5rJyk7CiAgfTsK' +
  'ICAkKCcjcm91dGVMaXN0Jykub25jbGljayA9ICgpID0+IHNoZWV0KCdSb3V0ZSBvcmRlcicsIGAKICAgIDxwIGNsYXNzPSJoaW50' +
  'Ij5PcmRlcmVkIGJ5IHByaW9yaXR5LCB0aGVuIGR1ZSBkYXRlLiBUYXAgYW55IHN0b3AgdG8gbmF2aWdhdGUgdG8gaXQgYWxvbmUu' +
  'PC9wPgogICAgPGRpdiBjbGFzcz0ibGlzdCI+JHttaW5lLnNsaWNlKDAsIDEwKS5tYXAoKGosIGkpID0+IGAKICAgICAgPGRpdiBj' +
  'bGFzcz0iaXRlbSIgZGF0YS1uYXY9IiR7ZXNjKGFkZHJPZihqKSl9Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJyIj48ZGl2PjxkaXYg' +
  'Y2xhc3M9InQiPiR7aSArIDF9LiAke2VzYyhqLnJlY2lwaWVudF9uYW1lKX08L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtIj4k' +
  'e2VzYyhhZGRyT2YoaikpfTwvZGl2PjwvZGl2PgogICAgICAgIDxzcGFuIGNsYXNzPSJwaWxsICR7Y2xzKGoucHJpb3JpdHkpfSI+' +
  'JHtlc2Moai5wcmlvcml0eSl9PC9zcGFuPjwvZGl2PjwvZGl2PmApLmpvaW4oJycpfTwvZGl2PgogICAgPGJ1dHRvbiBjbGFzcz0i' +
  'YnRuIHNlYyBibG9jayIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5DbG9zZTwvYnV0dG9u' +
  'PmAsCiAgICBlbCA9PiBlbC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1uYXZdJykuZm9yRWFjaChuID0+CiAgICAgIG4ub25jbGlj' +
  'ayA9ICgpID0+IHdpbmRvdy5vcGVuKG5hdlVybChuLmRhdGFzZXQubmF2KSwgJ19ibGFuaycpKSk7Cn0KCmZ1bmN0aW9uIHNlY3Rp' +
  'b24odGl0bGUsIGxpc3QpIHsKICBpZiAoIWxpc3QubGVuZ3RoKSByZXR1cm4gJyc7CiAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJjYXJk' +
  'Ij48aDI+JHt0aXRsZX0gPHNwYW4gY2xhc3M9InN1YiI+JHtsaXN0Lmxlbmd0aH08L3NwYW4+PC9oMj4KICAgIDxkaXYgY2xhc3M9' +
  'Imxpc3QiPiR7bGlzdC5tYXAoam9iSXRlbSkuam9pbignJyl9PC9kaXY+PC9kaXY+YDsKfQoKZnVuY3Rpb24gam9iSXRlbShqKSB7' +
  'CiAgY29uc3QgZCA9IGRheXNPdXQoai5kdWVfZGF0ZSk7CiAgY29uc3QgbGF0ZSA9IGQgIT09IG51bGwgJiYgZCA8IDAgJiYgIVsn' +
  'U2VydmVkJywgJ05vbi1Fc3QnLCAnQ2FuY2VsbGVkJ10uaW5jbHVkZXMoai5zdGF0dXMpOwogIGNvbnN0IGR1ZSA9IGouZHVlX2Rh' +
  'dGUKICAgID8gKGxhdGUgPyBgPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLWJhZCk7Zm9udC13ZWlnaHQ6NjAwIj4ke01hdGguYWJz' +
  'KGQpfWQgcGFzdCBkdWU8L3NwYW4+YAogICAgICAgICAgICA6IChkID09PSAwID8gJ2R1ZSB0b2RheScgOiBkID09PSAxID8gJ2R1' +
  'ZSB0b21vcnJvdycgOiAnZHVlICcgKyBmbXREYXRlT25seShqLmR1ZV9kYXRlKSkpCiAgICA6ICdubyBkdWUgZGF0ZSc7CiAgcmV0' +
  'dXJuIGA8ZGl2IGNsYXNzPSJpdGVtIHAtJHtjbHMoai5wcmlvcml0eSl9ICR7bGF0ZSA/ICdvdmVyZHVlJyA6ICcnfSIgZGF0YS1q' +
  'b2I9IiR7ai5pZH0iPgogICAgPGRpdiBjbGFzcz0iciI+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0idCI+JHtlc2Mo' +
  'ai5yZWNpcGllbnRfbmFtZSl9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibSI+JHtlc2Moai5qb2JfbnVtYmVyKX0gwrcgJHtl' +
  'c2Moai5jaXR5IHx8ICcnKX0ke2ouY2l0eSA/ICcsICcgOiAnJ30ke2VzYyhqLnN0YXRlIHx8ICcnKX0gwrcgJHtkdWV9PC9kaXY+' +
  'CiAgICAgICAgPGRpdiBjbGFzcz0ibSI+JHtlc2Moai5jbGllbnRfbmFtZSB8fCAnTm8gY2xpZW50Jyl9JHtqLnNlcnZlcl9uYW1l' +
  'ID8gJyDihpIgJyArIGVzYyhqLnNlcnZlcl9uYW1lKSA6ICcnfSR7ai5hdHRlbXB0X2NvdW50ID8gJyDCtyAnICsgai5hdHRlbXB0' +
  'X2NvdW50ICsgJyBhdHRlbXB0JyArIChqLmF0dGVtcHRfY291bnQgPT09IDEgPyAnJyA6ICdzJykgOiAnJ308L2Rpdj4KICAgICAg' +
  'PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9InRleHQtYWxpZ246cmlnaHQiPgogICAgICAgIDxzcGFuIGNsYXNzPSJwaWxsICR7Y2xz' +
  'KGouc3RhdHVzKX0iPiR7ZXNjKGouc3RhdHVzKX08L3NwYW4+CiAgICAgICAgJHtqLnByaW9yaXR5ICE9PSAnUm91dGluZScgPyBg' +
  'PGRpdiBzdHlsZT0ibWFyZ2luLXRvcDo1cHgiPjxzcGFuIGNsYXNzPSJwaWxsIHJ1c2giPiR7ZXNjKGoucHJpb3JpdHkpfTwvc3Bh' +
  'bj48L2Rpdj5gIDogJyd9CiAgICAgIDwvZGl2PgogICAgPC9kaXY+PC9kaXY+YDsKfQoKZnVuY3Rpb24gYmluZEpvYkl0ZW1zKCkg' +
  'ewogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWpvYl0nKS5mb3JFYWNoKGVsID0+CiAgICBlbC5vbmNsaWNrID0g' +
  'KCkgPT4gZ28oJ2pvYicsIHsgaWQ6IGVsLmRhdGFzZXQuam9iIH0pKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGpvYnMgLS0gKi8KYXN5bmMgZnVuY3Rpb24gam9ic1ZpZXcoKSB7' +
  'CiAgY29uc3QgZiA9IFMucGFyYW1zOwogIGNvbnN0IHFzID0gbmV3IFVSTFNlYXJjaFBhcmFtcygpOwogIGlmIChmLnN0YXR1cykg' +
  'cXMuc2V0KCdzdGF0dXMnLCBmLnN0YXR1cyk7CiAgaWYgKGYucSkgcXMuc2V0KCdxJywgZi5xKTsKICBpZiAoZi5vcGVuKSBxcy5z' +
  'ZXQoJ29wZW4nLCAnMScpOwogIGNvbnN0IGpvYnMgPSBhd2FpdCBhcGkoJy9qb2JzPycgKyBxcy50b1N0cmluZygpKTsKCiAgYXBw' +
  'LmlubmVySFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFnZSI+JHtpc0FkbWluKCkgPyAnSm9icycgOiAnTXkgam9icyd9' +
  'PC9oMT4KICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAgIDxpbnB1dCBpZD0icSIg' +
  'cGxhY2Vob2xkZXI9IlNlYXJjaCBuYW1lLCBjYXNlICMsIGpvYiAjLCBhZGRyZXNzIiB2YWx1ZT0iJHtlc2MoZi5xIHx8ICcnKX0i' +
  'IHN0eWxlPSJmbGV4OjE7bWluLXdpZHRoOjE2MHB4Ij4KICAgICAgICA8c2VsZWN0IGlkPSJzdGF0dXMiIHN0eWxlPSJ3aWR0aDph' +
  'dXRvIj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9IiI+QW55IHN0YXR1czwvb3B0aW9uPgogICAgICAgICAgJHtbJ1BlbmRpbmcn' +
  'LCAnQXNzaWduZWQnLCAnQXR0ZW1wdGVkJywgJ1NlcnZlZCcsICdOb24tRXN0JywgJ09uIEhvbGQnLCAnQ2FuY2VsbGVkJ10KICAg' +
  'ICAgICAgICAgLm1hcChzID0+IGA8b3B0aW9uICR7Zi5zdGF0dXMgPT09IHMgPyAnc2VsZWN0ZWQnIDogJyd9PiR7c308L29wdGlv' +
  'bj5gKS5qb2luKCcnKX0KICAgICAgICA8L3NlbGVjdD4KICAgICAgICA8bGFiZWwgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1p' +
  'dGVtczpjZW50ZXI7Z2FwOjZweDttYXJnaW46MDtmb250LXNpemU6MTNweCI+CiAgICAgICAgICA8aW5wdXQgdHlwZT0iY2hlY2ti' +
  'b3giIGlkPSJvcGVuT25seSIgJHtmLm9wZW4gPyAnY2hlY2tlZCcgOiAnJ30gc3R5bGU9IndpZHRoOmF1dG8iPiBPcGVuIG9ubHk8' +
  'L2xhYmVsPgogICAgICA8L2Rpdj4KICAgICAgJHtpc0FkbWluKCkgPyAnPGJ1dHRvbiBjbGFzcz0iYnRuIGJsb2NrIiBpZD0ibmV3' +
  'Sm9iIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4rIE5ldyBqb2I8L2J1dHRvbj4nIDogJyd9CiAgICA8L2Rpdj4KICAgICR7am9i' +
  'cy5sZW5ndGggPyBgPGRpdiBjbGFzcz0ibGlzdCI+JHtqb2JzLm1hcChqb2JJdGVtKS5qb2luKCcnKX08L2Rpdj5gCiAgICAgIDog' +
  'JzxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImVtcHR5Ij5ObyBqb2JzIG1hdGNoLjwvZGl2PjwvZGl2Pid9CiAgYCk7CiAg' +
  'YmluZFNoZWxsKCk7IGJpbmRKb2JJdGVtcygpOwogIGNvbnN0IGFwcGx5ID0gKCkgPT4gZ28oJ2pvYnMnLCB7IHE6ICQoJyNxJyku' +
  'dmFsdWUudHJpbSgpLCBzdGF0dXM6ICQoJyNzdGF0dXMnKS52YWx1ZSwgb3BlbjogJCgnI29wZW5Pbmx5JykuY2hlY2tlZCB9KTsK' +
  'ICAkKCcjcScpLm9ua2V5ZG93biA9IGUgPT4geyBpZiAoZS5rZXkgPT09ICdFbnRlcicpIGFwcGx5KCk7IH07CiAgJCgnI3N0YXR1' +
  'cycpLm9uY2hhbmdlID0gYXBwbHk7CiAgJCgnI29wZW5Pbmx5Jykub25jaGFuZ2UgPSBhcHBseTsKICBpZiAoJCgnI25ld0pvYicp' +
  'KSAkKCcjbmV3Sm9iJykub25jbGljayA9ICgpID0+IGpvYkZvcm0obnVsbCk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBqb2IgZm9ybSAtLSAqLwphc3luYyBmdW5jdGlvbiBqb2JGb3Jt' +
  'KGpvYikgewogIGNvbnN0IFtjbGllbnRzLCB1c2Vyc10gPSBhd2FpdCBQcm9taXNlLmFsbChbYXBpKCcvY2xpZW50cycpLCBhcGko' +
  'Jy91c2VycycpXSk7CiAgY29uc3QgdiA9IGpvYiB8fCB7IHNlcnZpY2VfdHlwZTogJ1BlcnNvbmFsJywgcHJpb3JpdHk6ICdSb3V0' +
  'aW5lJywgc3RhdHVzOiAnUGVuZGluZycgfTsKICBjb25zdCBvcHQgPSAobGlzdCwgc2VsLCBsYWJlbCkgPT4gbGlzdC5tYXAoeCA9' +
  'PgogICAgYDxvcHRpb24gdmFsdWU9IiR7eC5pZH0iICR7U3RyaW5nKHNlbCkgPT09IFN0cmluZyh4LmlkKSA/ICdzZWxlY3RlZCcg' +
  'OiAnJ30+JHtlc2MobGFiZWwoeCkpfTwvb3B0aW9uPmApLmpvaW4oJycpOwoKICBzaGVldChqb2IgPyAnRWRpdCAnICsgam9iLmpv' +
  'Yl9udW1iZXIgOiAnTmV3IGpvYicsIGAKICAgIDxkaXYgY2xhc3M9ImRyb3B6b25lIj4KICAgICAgPGxhYmVsPlN0YXJ0IGZyb20g' +
  'dGhlIHBhcGVyczwvbGFiZWw+CiAgICAgIDxpbnB1dCB0eXBlPSJmaWxlIiBpZD0iZl9wZGYiIGFjY2VwdD0iYXBwbGljYXRpb24v' +
  'cGRmLC5wZGYiPgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBpZD0icGRmTXNnIj5QaWNrIHRoZSBzdW1tb25zLCBjaXRhdGlvbiwg' +
  'c3VicG9lbmEgb3IgY29tcGxhaW50IGFzIGEgUERGIGFuZCBJJ2xsCiAgICAgICAgcmVhZCB3aGF0IEkgY2FuIGludG8gdGhlIGZv' +
  'cm0gYmVsb3cuIEFsd2F5cyBjaGVjayBpdCBhZ2FpbnN0IHRoZSBkb2N1bWVudCBiZWZvcmUgc2F2aW5nLjwvZGl2PgogICAgPC9k' +
  'aXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5DbGllbnQ8L2xhYmVs' +
  'PjxzZWxlY3QgaWQ9ImZfY2xpZW50X2lkIj4KICAgICAgICA8b3B0aW9uIHZhbHVlPSIiPuKAlCBub25lIOKAlDwvb3B0aW9uPiR7' +
  'b3B0KGNsaWVudHMsIHYuY2xpZW50X2lkLCBjID0+IGMubmFtZSl9PC9zZWxlY3Q+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZp' +
  'ZWxkIj48bGFiZWw+QXNzaWduIHRvPC9sYWJlbD48c2VsZWN0IGlkPSJmX2Fzc2lnbmVkX3RvIj4KICAgICAgICA8b3B0aW9uIHZh' +
  'bHVlPSIiPuKAlCB1bmFzc2lnbmVkIOKAlDwvb3B0aW9uPiR7b3B0KHVzZXJzLmZpbHRlcih1ID0+IHUuYWN0aXZlKSwgdi5hc3Np' +
  'Z25lZF90bywgdSA9PiB1Lm5hbWUpfTwvc2VsZWN0PjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxh' +
  'YmVsPlBlcnNvbiAvIGVudGl0eSB0byBzZXJ2ZSAqPC9sYWJlbD48aW5wdXQgaWQ9ImZfcmVjaXBpZW50X25hbWUiIHZhbHVlPSIk' +
  'e2VzYyh2LnJlY2lwaWVudF9uYW1lKX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5TZXJ2aWNlIGFkZHJl' +
  'c3M8L2xhYmVsPjxpbnB1dCBpZD0iZl9hZGRyZXNzMSIgcGxhY2Vob2xkZXI9IlN0cmVldCBhZGRyZXNzIiB2YWx1ZT0iJHtlc2Mo' +
  'di5hZGRyZXNzMSl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQgZzMiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxh' +
  'YmVsPkFwdCAvIHVuaXQ8L2xhYmVsPjxpbnB1dCBpZD0iZl9hZGRyZXNzMiIgdmFsdWU9IiR7ZXNjKHYuYWRkcmVzczIpfSI+PC9k' +
  'aXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q2l0eTwvbGFiZWw+PGlucHV0IGlkPSJmX2NpdHkiIHZhbHVlPSIk' +
  'e2VzYyh2LmNpdHkpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U3RhdGUgLyBaSVA8L2xhYmVsPgog' +
  'ICAgICAgIDxkaXYgY2xhc3M9InJvdyI+PGlucHV0IGlkPSJmX3N0YXRlIiBzdHlsZT0id2lkdGg6NzBweCIgbWF4bGVuZ3RoPSIy' +
  'IiB2YWx1ZT0iJHtlc2Modi5zdGF0ZSl9Ij4KICAgICAgICA8aW5wdXQgaWQ9ImZfemlwIiBzdHlsZT0iZmxleDoxIiBpbnB1dG1v' +
  'ZGU9Im51bWVyaWMiIHZhbHVlPSIke2VzYyh2LnppcCl9Ij48L2Rpdj48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0i' +
  'ZmllbGQiPjxsYWJlbD5SZWNpcGllbnQgbm90ZXMgKGRlc2NyaXB0aW9uLCB3b3JrIGhvdXJzLCB2ZWhpY2xlLCBnYXRlIGNvZGUp' +
  'PC9sYWJlbD4KICAgICAgPHRleHRhcmVhIGlkPSJmX3JlY2lwaWVudF9ub3RlcyIgc3R5bGU9Im1pbi1oZWlnaHQ6NjBweCI+JHtl' +
  'c2Modi5yZWNpcGllbnRfbm90ZXMpfTwvdGV4dGFyZWE+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgPGRp' +
  'diBjbGFzcz0iZmllbGQiPjxsYWJlbD5DYXNlIG51bWJlcjwvbGFiZWw+PGlucHV0IGlkPSJmX2Nhc2VfbnVtYmVyIiB2YWx1ZT0i' +
  'JHtlc2Modi5jYXNlX251bWJlcil9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Db3VydDwvbGFiZWw+' +
  'PGlucHV0IGlkPSJmX2NvdXJ0IiB2YWx1ZT0iJHtlc2Modi5jb3VydCl9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQi' +
  'PjxsYWJlbD5QbGFpbnRpZmY8L2xhYmVsPjxpbnB1dCBpZD0iZl9wbGFpbnRpZmYiIHZhbHVlPSIke2VzYyh2LnBsYWludGlmZil9' +
  'Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5EZWZlbmRhbnQ8L2xhYmVsPjxpbnB1dCBpZD0iZl9kZWZl' +
  'bmRhbnQiIHZhbHVlPSIke2VzYyh2LmRlZmVuZGFudCl9Ij48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQi' +
  'PjxsYWJlbD5Eb2N1bWVudHMgdG8gc2VydmU8L2xhYmVsPjxpbnB1dCBpZD0iZl9kb2N1bWVudHMiIHBsYWNlaG9sZGVyPSJTdW1t' +
  'b25zIGFuZCBDb21wbGFpbnQiIHZhbHVlPSIke2VzYyh2LmRvY3VtZW50cyl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQg' +
  'ZzMiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlNlcnZpY2UgdHlwZTwvbGFiZWw+PHNlbGVjdCBpZD0iZl9zZXJ2' +
  'aWNlX3R5cGUiPgogICAgICAgICR7WydQZXJzb25hbCcsICdTdWJzdGl0dXRlJywgJ1Bvc3RpbmcnLCAnQ2VydGlmaWVkIE1haWwn' +
  'LCAnQ29ycG9yYXRlJ10ubWFwKHMgPT4gYDxvcHRpb24gJHt2LnNlcnZpY2VfdHlwZSA9PT0gcyA/ICdzZWxlY3RlZCcgOiAnJ30+' +
  'JHtzfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBy' +
  'aW9yaXR5PC9sYWJlbD48c2VsZWN0IGlkPSJmX3ByaW9yaXR5Ij4KICAgICAgICAke1snUm91dGluZScsICdSdXNoJywgJ1NhbWUg' +
  'RGF5J10ubWFwKHMgPT4gYDxvcHRpb24gJHt2LnByaW9yaXR5ID09PSBzID8gJ3NlbGVjdGVkJyA6ICcnfT4ke3N9PC9vcHRpb24+' +
  'YCkuam9pbignJyl9PC9zZWxlY3Q+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RHVlIGRhdGU8L2xhYmVs' +
  'PjxpbnB1dCBpZD0iZl9kdWVfZGF0ZSIgdHlwZT0iZGF0ZSIgdmFsdWU9IiR7di5kdWVfZGF0ZSA/IFN0cmluZyh2LmR1ZV9kYXRl' +
  'KS5zbGljZSgwLCAxMCkgOiAnJ30iPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkIGczIj4KICAgICAgPGRp' +
  'diBjbGFzcz0iZmllbGQiPjxsYWJlbD5DbGllbnQgZmVlPC9sYWJlbD48aW5wdXQgaWQ9ImZfY2xpZW50X2ZlZSIgdHlwZT0ibnVt' +
  'YmVyIiBzdGVwPSIwLjAxIiB2YWx1ZT0iJHt2LmNsaWVudF9mZWUgfHwgJyd9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmll' +
  'bGQiPjxsYWJlbD5TZXJ2ZXIgcGF5PC9sYWJlbD48aW5wdXQgaWQ9ImZfc2VydmVyX3BheSIgdHlwZT0ibnVtYmVyIiBzdGVwPSIw' +
  'LjAxIiB2YWx1ZT0iJHt2LnNlcnZlcl9wYXkgfHwgJyd9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5T' +
  'dGF0dXM8L2xhYmVsPjxzZWxlY3QgaWQ9ImZfc3RhdHVzIj4KICAgICAgICAke1snUGVuZGluZycsICdBc3NpZ25lZCcsICdBdHRl' +
  'bXB0ZWQnLCAnU2VydmVkJywgJ05vbi1Fc3QnLCAnT24gSG9sZCcsICdDYW5jZWxsZWQnXS5tYXAocyA9PiBgPG9wdGlvbiAke3Yu' +
  'c3RhdHVzID09PSBzID8gJ3NlbGVjdGVkJyA6ICcnfT4ke3N9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9kaXY+CiAg' +
  'ICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+SW50ZXJuYWwgbm90ZXM8L2xhYmVsPjx0ZXh0YXJlYSBpZD0i' +
  'Zl9ub3RlcyIgc3R5bGU9Im1pbi1oZWlnaHQ6NjBweCI+JHtlc2Modi5ub3Rlcyl9PC90ZXh0YXJlYT48L2Rpdj4KICAgIDxkaXYg' +
  'Y2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6NnB4Ij4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0ic2F2ZSI+JHtq' +
  'b2IgPyAnU2F2ZSBjaGFuZ2VzJyA6ICdDcmVhdGUgam9iJ308L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIg' +
  'b25jbGljaz0iY2xvc2VTaGVldCgpIj5DYW5jZWw8L2J1dHRvbj4KICAgICAgJHtqb2IgPyAnPGJ1dHRvbiBjbGFzcz0iYnRuIGdo' +
  'b3N0IiBpZD0iZGVsIiBzdHlsZT0iY29sb3I6dmFyKC0tYmFkKTttYXJnaW4tbGVmdDphdXRvIj5EZWxldGU8L2J1dHRvbj4nIDog' +
  'Jyd9CiAgICA8L2Rpdj5gLCBlbCA9PiB7CiAgICAvKiAtLS0tIHJlYWQgYSBzdW1tb25zL2NpdGF0aW9uIFBERiBhbmQgZmlsbCB3' +
  'aGF0IHdlIGNhbiAtLS0tICovCiAgICBjb25zdCBwZGZNc2cgPSBlbC5xdWVyeVNlbGVjdG9yKCcjcGRmTXNnJyk7CiAgICBjb25z' +
  'dCBGSUxMQUJMRSA9IFsnY2FzZV9udW1iZXInLCAnY291cnQnLCAncGxhaW50aWZmJywgJ2RlZmVuZGFudCcsICdyZWNpcGllbnRf' +
  'bmFtZScsCiAgICAgICdhZGRyZXNzMScsICdhZGRyZXNzMicsICdjaXR5JywgJ3N0YXRlJywgJ3ppcCcsICdkb2N1bWVudHMnXTsK' +
  'ICAgIGNvbnN0IExBQkVMUyA9IHsKICAgICAgY2FzZV9udW1iZXI6ICdjYXNlIG51bWJlcicsIGNvdXJ0OiAnY291cnQnLCBwbGFp' +
  'bnRpZmY6ICdwbGFpbnRpZmYnLCBkZWZlbmRhbnQ6ICdkZWZlbmRhbnQnLAogICAgICByZWNpcGllbnRfbmFtZTogJ3BlcnNvbiB0' +
  'byBzZXJ2ZScsIGFkZHJlc3MxOiAnYWRkcmVzcycsIGFkZHJlc3MyOiAndW5pdCcsIGNpdHk6ICdjaXR5JywKICAgICAgc3RhdGU6' +
  'ICdzdGF0ZScsIHppcDogJ1pJUCcsIGRvY3VtZW50czogJ2RvY3VtZW50cycKICAgIH07CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcj' +
  'Zl9wZGYnKS5vbmNoYW5nZSA9IGFzeW5jIGUgPT4gewogICAgICBjb25zdCBmaWxlID0gZS50YXJnZXQuZmlsZXMgJiYgZS50YXJn' +
  'ZXQuZmlsZXNbMF07CiAgICAgIGlmICghZmlsZSkgcmV0dXJuOwogICAgICBwZGZNc2cuaW5uZXJIVE1MID0gJ1JlYWRpbmcgJyAr' +
  'IGVzYyhmaWxlLm5hbWUpICsgJ+KApic7CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IG5ldyBQcm9taXNl' +
  'KChyZXMsIHJlaikgPT4gewogICAgICAgICAgY29uc3QgciA9IG5ldyBGaWxlUmVhZGVyKCk7CiAgICAgICAgICByLm9ubG9hZCA9' +
  'ICgpID0+IHJlcyhTdHJpbmcoci5yZXN1bHQpLnNwbGl0KCcsJylbMV0pOwogICAgICAgICAgci5vbmVycm9yID0gKCkgPT4gcmVq' +
  'KG5ldyBFcnJvcignQ291bGQgbm90IHJlYWQgdGhhdCBmaWxlJykpOwogICAgICAgICAgci5yZWFkQXNEYXRhVVJMKGZpbGUpOwog' +
  'ICAgICAgIH0pOwogICAgICAgIGNvbnN0IG91dCA9IGF3YWl0IGFwaSgnL3BhcnNlLWRvY3VtZW50JywgewogICAgICAgICAgbWV0' +
  'aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgbmFtZTogZmlsZS5uYW1lLCBkYXRhIH0pCiAgICAgICAgfSk7CiAg' +
  'ICAgICAgaWYgKG91dC53YXJuaW5nKSB7IHBkZk1zZy5pbm5lckhUTUwgPSAnPGIgc3R5bGU9ImNvbG9yOnZhcigtLXdhcm4pIj4n' +
  'ICsgZXNjKG91dC53YXJuaW5nKSArICc8L2I+JzsgcmV0dXJuOyB9CiAgICAgICAgY29uc3QgZmlsbGVkID0gW10sIHNraXBwZWQg' +
  'PSBbXSwgbWlzc2VkID0gW107CiAgICAgICAgZm9yIChjb25zdCBmIG9mIEZJTExBQkxFKSB7CiAgICAgICAgICBjb25zdCBpbnB1' +
  'dCA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNmXycgKyBmKTsKICAgICAgICAgIGlmICghaW5wdXQpIGNvbnRpbnVlOwogICAgICAgICAg' +
  'Y29uc3QgdmFsID0gb3V0LmZpZWxkc1tmXTsKICAgICAgICAgIGlmICghdmFsKSB7IG1pc3NlZC5wdXNoKExBQkVMU1tmXSk7IGNv' +
  'bnRpbnVlOyB9CiAgICAgICAgICBpZiAoaW5wdXQudmFsdWUgJiYgaW5wdXQudmFsdWUudHJpbSgpICYmIGlucHV0LnZhbHVlLnRy' +
  'aW0oKSAhPT0gU3RyaW5nKHZhbCkudHJpbSgpKSB7CiAgICAgICAgICAgIHNraXBwZWQucHVzaChMQUJFTFNbZl0pOwogICAgICAg' +
  'ICAgICBjb250aW51ZTsKICAgICAgICAgIH0KICAgICAgICAgIGlucHV0LnZhbHVlID0gdmFsOwogICAgICAgICAgaW5wdXQuc3R5' +
  'bGUuYmFja2dyb3VuZCA9ICcjZTlmNmVlJzsKICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4geyBpbnB1dC5zdHlsZS5iYWNrZ3Jv' +
  'dW5kID0gJyc7IH0sIDQwMDApOwogICAgICAgICAgZmlsbGVkLnB1c2goTEFCRUxTW2ZdKTsKICAgICAgICB9CiAgICAgICAgbGV0' +
  'IG1zZzsKICAgICAgICBpZiAoZmlsbGVkLmxlbmd0aCkgewogICAgICAgICAgbXNnID0gJzxiIHN0eWxlPSJjb2xvcjp2YXIoLS1v' +
  'aykiPkZpbGxlZCAnICsgZmlsbGVkLmxlbmd0aCArICcgZmllbGQnICsgKGZpbGxlZC5sZW5ndGggPT09IDEgPyAnJyA6ICdzJykg' +
  'KwogICAgICAgICAgICAnPC9iPiBmcm9tICcgKyBlc2MoZmlsZS5uYW1lKSArICcgKCcgKyAob3V0LnBhZ2VzIHx8ICc/JykgKyAn' +
  'IHBhZ2UnICsgKG91dC5wYWdlcyA9PT0gMSA/ICcnIDogJ3MnKSArICcpOiAnICsKICAgICAgICAgICAgZXNjKGZpbGxlZC5qb2lu' +
  'KCcsICcpKSArICcuJzsKICAgICAgICB9IGVsc2UgaWYgKHNraXBwZWQubGVuZ3RoKSB7CiAgICAgICAgICBtc2cgPSAnPGIgc3R5' +
  'bGU9ImNvbG9yOnZhcigtLXdhcm4pIj5FdmVyeXRoaW5nIEkgZm91bmQgd2FzIGFscmVhZHkgZmlsbGVkIGluPC9iPiDigJQgbm90' +
  'aGluZyBvZiB5b3VycyB3YXMgJyArCiAgICAgICAgICAgICdvdmVyd3JpdHRlbi4gQ2xlYXIgYSBmaWVsZCBmaXJzdCBpZiB5b3Ug' +
  'd2FudCB0aGUgZG9jdW1lbnRcJ3MgdmVyc2lvbiBvZiBpdC4nOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBtc2cgPSAnPGIg' +
  'c3R5bGU9ImNvbG9yOnZhcigtLXdhcm4pIj5Ob3RoaW5nIHJlY29nbmlzYWJsZSBmb3VuZDwvYj4gaW4gJyArIGVzYyhmaWxlLm5h' +
  'bWUpICsKICAgICAgICAgICAgJy4gSXQgbWF5IGJlIGxhaWQgb3V0IGRpZmZlcmVudGx5IHRvIHRoZSBkb2N1bWVudHMgdGhpcyBj' +
  'YW4gcmVhZCDigJQgZmlsbCB0aGUgam9iIGluIGJ5IGhhbmQuJzsKICAgICAgICB9CiAgICAgICAgaWYgKGZpbGxlZC5sZW5ndGgg' +
  'JiYgc2tpcHBlZC5sZW5ndGgpIG1zZyArPSAnIExlZnQgeW91ciBleGlzdGluZyAnICsgZXNjKHNraXBwZWQuam9pbignLCAnKSkg' +
  'KyAnIGFsb25lLic7CiAgICAgICAgaWYgKG1pc3NlZC5sZW5ndGgpIG1zZyArPSAnIE5vdCBmb3VuZDogJyArIGVzYyhtaXNzZWQu' +
  'am9pbignLCAnKSkgKyAnLic7CiAgICAgICAgbXNnICs9ICc8YnI+PGI+Q2hlY2sgZXZlcnkgZmlsbGVkIGZpZWxkIGFnYWluc3Qg' +
  'dGhlIGRvY3VtZW50IGJlZm9yZSBzYXZpbmcuPC9iPic7CiAgICAgICAgcGRmTXNnLmlubmVySFRNTCA9IG1zZzsKICAgICAgfSBj' +
  'YXRjaCAoZXJyKSB7CiAgICAgICAgcGRmTXNnLmlubmVySFRNTCA9ICc8YiBzdHlsZT0iY29sb3I6dmFyKC0tYmFkKSI+JyArIGVz' +
  'YyhlcnIubWVzc2FnZSkgKyAnPC9iPic7CiAgICAgIH0KICAgIH07CgogICAgLy8gYXV0by1maWxsIGZlZS9wYXkgZGVmYXVsdHMg' +
  'ZnJvbSB0aGUgc2VsZWN0ZWQgY2xpZW50IC8gc2VydmVyCiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjZl9jbGllbnRfaWQnKS5vbmNo' +
  'YW5nZSA9IGUgPT4gewogICAgICBjb25zdCBjID0gY2xpZW50cy5maW5kKHggPT4gU3RyaW5nKHguaWQpID09PSBlLnRhcmdldC52' +
  'YWx1ZSk7CiAgICAgIGlmIChjICYmIGMuZGVmYXVsdF9mZWUgJiYgIWVsLnF1ZXJ5U2VsZWN0b3IoJyNmX2NsaWVudF9mZWUnKS52' +
  'YWx1ZSkKICAgICAgICBlbC5xdWVyeVNlbGVjdG9yKCcjZl9jbGllbnRfZmVlJykudmFsdWUgPSBOdW1iZXIoYy5kZWZhdWx0X2Zl' +
  'ZSkudG9GaXhlZCgyKTsKICAgIH07CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjZl9hc3NpZ25lZF90bycpLm9uY2hhbmdlID0gZSA9' +
  'PiB7CiAgICAgIGNvbnN0IHUgPSB1c2Vycy5maW5kKHggPT4gU3RyaW5nKHguaWQpID09PSBlLnRhcmdldC52YWx1ZSk7CiAgICAg' +
  'IGlmICh1ICYmIHUuZGVmYXVsdF9wYXkgJiYgIWVsLnF1ZXJ5U2VsZWN0b3IoJyNmX3NlcnZlcl9wYXknKS52YWx1ZSkKICAgICAg' +
  'ICBlbC5xdWVyeVNlbGVjdG9yKCcjZl9zZXJ2ZXJfcGF5JykudmFsdWUgPSBOdW1iZXIodS5kZWZhdWx0X3BheSkudG9GaXhlZCgy' +
  'KTsKICAgIH07CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0' +
  'IGJvZHkgPSB7fTsKICAgICAgWydjbGllbnRfaWQnLCdhc3NpZ25lZF90bycsJ3JlY2lwaWVudF9uYW1lJywnYWRkcmVzczEnLCdh' +
  'ZGRyZXNzMicsJ2NpdHknLCdzdGF0ZScsJ3ppcCcsJ3JlY2lwaWVudF9ub3RlcycsCiAgICAgICAnY2FzZV9udW1iZXInLCdjb3Vy' +
  'dCcsJ3BsYWludGlmZicsJ2RlZmVuZGFudCcsJ2RvY3VtZW50cycsJ3NlcnZpY2VfdHlwZScsJ3ByaW9yaXR5JywnZHVlX2RhdGUn' +
  'LAogICAgICAgJ2NsaWVudF9mZWUnLCdzZXJ2ZXJfcGF5Jywnc3RhdHVzJywnbm90ZXMnXS5mb3JFYWNoKGYgPT4geyBib2R5W2Zd' +
  'ID0gZWwucXVlcnlTZWxlY3RvcignI2ZfJyArIGYpLnZhbHVlOyB9KTsKICAgICAgaWYgKCFib2R5LnJlY2lwaWVudF9uYW1lLnRy' +
  'aW0oKSkgcmV0dXJuIHRvYXN0KCdXaG8gYXJlIHdlIHNlcnZpbmc/JywgdHJ1ZSk7CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3Qg' +
  'c2F2ZWQgPSBqb2IKICAgICAgICAgID8gYXdhaXQgYXBpKCcvam9icy8nICsgam9iLmlkLCB7IG1ldGhvZDogJ1BBVENIJywgYm9k' +
  'eTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSkKICAgICAgICAgIDogYXdhaXQgYXBpKCcvam9icycsIHsgbWV0aG9kOiAnUE9TVCcs' +
  'IGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pOwogICAgICAgIGNsb3NlU2hlZXQoKTsgdG9hc3Qoam9iID8gJ1NhdmVkJyA6' +
  'ICdKb2IgJyArIHNhdmVkLmpvYl9udW1iZXIgKyAnIGNyZWF0ZWQnKTsKICAgICAgICBnbygnam9iJywgeyBpZDogc2F2ZWQuaWQg' +
  'fSk7CiAgICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogICAgfTsKICAgIGlmIChlbC5xdWVyeVNl' +
  'bGVjdG9yKCcjZGVsJykpIGVsLnF1ZXJ5U2VsZWN0b3IoJyNkZWwnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBpZiAo' +
  'IWNvbmZpcm0oJ0RlbGV0ZSB0aGlzIGpvYiBhbmQgYWxsIGl0cyBhdHRlbXB0cz8nKSkgcmV0dXJuOwogICAgICBhd2FpdCBhcGko' +
  'Jy9qb2JzLycgKyBqb2IuaWQsIHsgbWV0aG9kOiAnREVMRVRFJyB9KTsKICAgICAgY2xvc2VTaGVldCgpOyB0b2FzdCgnRGVsZXRl' +
  'ZCcpOyBnbygnam9icycpOwogICAgfTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLSBqb2IgZGV0YWlsIC0tICovCmFzeW5jIGZ1bmN0aW9uIGpvYlZpZXcoKSB7CiAgY29uc3QgaiA9' +
  'IGF3YWl0IGFwaSgnL2pvYnMvJyArIFMucGFyYW1zLmlkKTsKICBjb25zdCBhZGRyID0gYWRkck9mKGopOwogIGNvbnN0IGRvbmUg' +
  'PSBbJ1NlcnZlZCcsICdOb24tRXN0JywgJ0NhbmNlbGxlZCddLmluY2x1ZGVzKGouc3RhdHVzKTsKCiAgYXBwLmlubmVySFRNTCA9' +
  'IHNoZWxsKGAKICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi1ib3R0b206OHB4Ij4KICAgICAgPGJ1dHRvbiBjbGFz' +
  'cz0iYnRuIGdob3N0IiBpZD0iYmFjayI+4oC5IEJhY2s8L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0ic3BhY2VyIiBzdHlsZT0i' +
  'ZmxleDoxIj48L2Rpdj4KICAgICAgPHNwYW4gY2xhc3M9InBpbGwgJHtjbHMoai5zdGF0dXMpfSI+JHtlc2Moai5zdGF0dXMpfTwv' +
  'c3Bhbj4KICAgICAgJHtqLnByaW9yaXR5ICE9PSAnUm91dGluZScgPyBgPHNwYW4gY2xhc3M9InBpbGwgcnVzaCI+JHtlc2Moai5w' +
  'cmlvcml0eSl9PC9zcGFuPmAgOiAnJ30KICAgIDwvZGl2PgogICAgPGgxIGNsYXNzPSJwYWdlIiBzdHlsZT0ibWFyZ2luLXRvcDow' +
  'Ij4ke2VzYyhqLnJlY2lwaWVudF9uYW1lKX08L2gxPgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJt' +
  'IiBzdHlsZT0iY29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxM3B4O21hcmdpbi1ib3R0b206OHB4Ij4ke2VzYyhqLmpvYl9u' +
  'dW1iZXIpfSDCtyAke2VzYyhqLmNsaWVudF9uYW1lIHx8ICdObyBjbGllbnQnKX08L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0iZm9u' +
  'dC1zaXplOjE1cHg7Zm9udC13ZWlnaHQ6NjAwIj4ke2VzYyhhZGRyIHx8ICdObyBhZGRyZXNzIG9uIGZpbGUnKX08L2Rpdj4KICAg' +
  'ICAgJHtqLnJlY2lwaWVudF9ub3RlcyA/IGA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDo2cHgiPiR7ZXNjKGou' +
  'cmVjaXBpZW50X25vdGVzKX08L2Rpdj5gIDogJyd9CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTJw' +
  'eCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIG5hdiIgaWQ9Im5hdkJ0biIgJHthZGRyID8gJycgOiAnZGlzYWJsZWQnfT5O' +
  'YXZpZ2F0ZSDilrg8L2J1dHRvbj4KICAgICAgICAkeyFkb25lID8gJzxidXR0b24gY2xhc3M9ImJ0biBvayIgaWQ9ImF0dEJ0biI+' +
  'TG9nIGF0dGVtcHQ8L2J1dHRvbj4nIDogJyd9CiAgICAgIDwvZGl2PgogICAgICAke2FkZHIgPyBgPGRpdiBjbGFzcz0iaGludCIg' +
  'c3R5bGU9Im1hcmdpbi10b3A6OHB4Ij5PcGVucyAke2lzSU9TKCkgPyAnQXBwbGUgTWFwcycgOiAnR29vZ2xlIE1hcHMnfSDCtwog' +
  'ICAgICAgIDxhIGhyZWY9IiR7aXNJT1MoKSA/IGdvb2dsZVVybChhZGRyKSA6IGFwcGxlVXJsKGFkZHIpfSIgdGFyZ2V0PSJfYmxh' +
  'bmsiPnVzZSAke2lzSU9TKCkgPyAnR29vZ2xlJyA6ICdBcHBsZSd9IE1hcHMgaW5zdGVhZDwvYT48L2Rpdj5gIDogJyd9CiAgICA8' +
  'L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkF0dGVtcHRzIDxzcGFuIGNsYXNzPSJzdWIiPiR7ai5hdHRl' +
  'bXB0cy5sZW5ndGh9PC9zcGFuPjwvaDI+CiAgICAgICR7ai5hdHRlbXB0cy5sZW5ndGggPyBqLmF0dGVtcHRzLm1hcChhID0+IGAK' +
  'ICAgICAgICA8ZGl2IGNsYXNzPSJhdHQgJHtjbHMoYS5vdXRjb21lKX0iPgogICAgICAgICAgPGRpdiBjbGFzcz0iaCI+JHtlc2Mo' +
  'YS5vdXRjb21lKX0ke2EubWFubmVyID8gJyDigJQgJyArIGVzYyhhLm1hbm5lcikgOiAnJ308L2Rpdj4KICAgICAgICAgIDxkaXYg' +
  'Y2xhc3M9Im0iPiR7Zm10RFQoYS5hdHRlbXB0ZWRfYXQpfSDCtyAke2VzYyhhLnNlcnZlcl9uYW1lIHx8ICcnKX08L2Rpdj4KICAg' +
  'ICAgICAgICR7YS5wZXJzb25fc2VydmVkID8gYDxkaXYgY2xhc3M9Im0iPlNlcnZlZDogJHtlc2MoYS5wZXJzb25fc2VydmVkKX0k' +
  'e2EucmVsYXRpb25zaGlwID8gJyAoJyArIGVzYyhhLnJlbGF0aW9uc2hpcCkgKyAnKScgOiAnJ308L2Rpdj5gIDogJyd9CiAgICAg' +
  'ICAgICAke2EuZGVzY3JpcHRpb24gPyBgPGRpdiBjbGFzcz0ibSI+RGVzY3JpcHRpb246ICR7ZXNjKGEuZGVzY3JpcHRpb24pfTwv' +
  'ZGl2PmAgOiAnJ30KICAgICAgICAgICR7YS5ub3RlcyA/IGA8ZGl2IGNsYXNzPSJtIj4ke2VzYyhhLm5vdGVzKX08L2Rpdj5gIDog' +
  'Jyd9CiAgICAgICAgICAke2EubGF0ICE9IG51bGwgPyBgPGRpdiBjbGFzcz0ibSI+R1BTICR7TnVtYmVyKGEubGF0KS50b0ZpeGVk' +
  'KDUpfSwgJHtOdW1iZXIoYS5sbmcpLnRvRml4ZWQoNSl9CiAgICAgICAgICAgICR7YS5hY2N1cmFjeV9tID8gJ8KxJyArIE1hdGgu' +
  'cm91bmQoYS5hY2N1cmFjeV9tKSArICdtJyA6ICcnfSDCtwogICAgICAgICAgICA8YSBocmVmPSJodHRwczovL3d3dy5nb29nbGUu' +
  'Y29tL21hcHM/cT0ke2EubGF0fSwke2EubG5nfSIgdGFyZ2V0PSJfYmxhbmsiPm1hcDwvYT48L2Rpdj5gIDogJyd9CiAgICAgICAg' +
  'ICAke3Bob3RvU3RyaXAoYSwgail9CiAgICAgICAgPC9kaXY+YCkuam9pbignJykKICAgICAgICA6ICc8ZGl2IGNsYXNzPSJlbXB0' +
  'eSI+Tm8gYXR0ZW1wdHMgbG9nZ2VkIHlldC48L2Rpdj4nfQogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAg' +
  'IDxoMj5QYXBlcndvcms8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMg' +
  'c20iIGlkPSJhZmZCdG4iPkFmZmlkYXZpdDwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJy' +
  'ZXBvcnRCdG4iPkNsaWVudCByZXBvcnQ8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0iY292' +
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
  'I2FmZkJ0bicpLm9uY2xpY2sgPSAoKSA9PiBhZmZpZGF2aXRTaGVldChqKTsKICAkKCcjcmVwb3J0QnRuJykub25jbGljayA9ICgp' +
  'ID0+IHdpbmRvdy5vcGVuKCcvcHJpbnQvcmVwb3J0LycgKyBqLmlkLCAnX2JsYW5rJyk7CiAgaWYgKCQoJyNsb29rdXBCdG4nKSkg' +
  'JCgnI2xvb2t1cEJ0bicpLm9uY2xpY2sgPSAoKSA9PiBjYXNlTG9va3VwU2hlZXQoaik7CiAgYmluZFBob3RvU3RyaXBzKGopOwp9' +
  'CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBwaG90b3MgLS0g' +
  'Ki8KLyogQSBwaG9uZSBjYW1lcmEgbWFrZXMgYSA0TUIsIDQwMDBweCBwaWN0dXJlLiBOb2JvZHkgbmVlZHMgdGhhdCB0byBwcm92' +
  'ZSBhCiAqIGRvb3Igd2FzIGtub2NrZWQgb24sIGFuZCBzZW5kaW5nIGl0IG92ZXIgYSBwYXJraW5nLWxvdCBzaWduYWwgaXMgaG93' +
  'IGEKICogc2VydmVyIGdpdmVzIHVwIGFuZCBzdG9wcyB0YWtpbmcgcGhvdG9zIGF0IGFsbC4gU28gZXZlcnkgc2hvdCBpcyBkcmF3' +
  'bgogKiBpbnRvIGEgY2FudmFzIGF0IDE2MDBweCBvbiBpdHMgbG9uZyBzaWRlIGFuZCByZS1lbmNvZGVkIGFzIEpQRUcgYmVmb3Jl' +
  'IGl0CiAqIGxlYXZlcyB0aGUgcGhvbmUg4oCUIGFib3V0IDI1MEtCLCBzdGlsbCBzaGFycCBlbm91Z2ggdG8gcmVhZCBhIGhvdXNl' +
  'IG51bWJlci4gKi8KY29uc3QgUEhPVE9fTUFYX0VER0UgPSAxNjAwOwpjb25zdCBQSE9UT19RVUFMSVRZID0gMC43MjsKCmZ1bmN0' +
  'aW9uIHNocmlua1Bob3RvKGZpbGUpIHsKICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gewogICAgY29u' +
  'c3QgaW1nID0gbmV3IEltYWdlKCk7CiAgICBjb25zdCB1cmwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKGZpbGUpOwogICAgaW1nLm9u' +
  'bG9hZCA9ICgpID0+IHsKICAgICAgVVJMLnJldm9rZU9iamVjdFVSTCh1cmwpOwogICAgICBjb25zdCBzY2FsZSA9IE1hdGgubWlu' +
  'KDEsIFBIT1RPX01BWF9FREdFIC8gTWF0aC5tYXgoaW1nLndpZHRoLCBpbWcuaGVpZ2h0KSk7CiAgICAgIGNvbnN0IHcgPSBNYXRo' +
  'LnJvdW5kKGltZy53aWR0aCAqIHNjYWxlKSwgaCA9IE1hdGgucm91bmQoaW1nLmhlaWdodCAqIHNjYWxlKTsKICAgICAgY29uc3Qg' +
  'YyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2NhbnZhcycpOwogICAgICBjLndpZHRoID0gdzsgYy5oZWlnaHQgPSBoOwogICAg' +
  'ICBjLmdldENvbnRleHQoJzJkJykuZHJhd0ltYWdlKGltZywgMCwgMCwgdywgaCk7CiAgICAgIGNvbnN0IGRhdGEgPSBjLnRvRGF0' +
  'YVVSTCgnaW1hZ2UvanBlZycsIFBIT1RPX1FVQUxJVFkpLnNwbGl0KCcsJylbMV07CiAgICAgIGlmICghZGF0YSkgcmV0dXJuIHJl' +
  'amVjdChuZXcgRXJyb3IoJ1RoaXMgcGhvbmUgY291bGQgbm90IHByb2Nlc3MgdGhhdCBwaG90bycpKTsKICAgICAgcmVzb2x2ZSh7' +
  'IGRhdGEsIG1pbWU6ICdpbWFnZS9qcGVnJywgd2lkdGg6IHcsIGhlaWdodDogaCB9KTsKICAgIH07CiAgICBpbWcub25lcnJvciA9' +
  'ICgpID0+IHsgVVJMLnJldm9rZU9iamVjdFVSTCh1cmwpOyByZWplY3QobmV3IEVycm9yKCdUaGF0IGZpbGUgaXMgbm90IGEgcGhv' +
  'dG8nKSk7IH07CiAgICBpbWcuc3JjID0gdXJsOwogIH0pOwp9CgovLyBVcGxvYWRzIG9uZSBhdCBhIHRpbWU6IGEgc2VydmVyIG9u' +
  'IGEgd2VhayBzaWduYWwgZ2V0cyBwYXJ0aWFsIHN1Y2Nlc3MgcmF0aGVyCi8vIHRoYW4gb25lIGdpYW50IHJlcXVlc3QgdGhhdCBm' +
  'YWlscyB3aG9sZS4KYXN5bmMgZnVuY3Rpb24gdXBsb2FkUGhvdG9zKGF0dGVtcHRJZCwgZmlsZXMsIG9uUHJvZ3Jlc3MpIHsKICBj' +
  'b25zdCBkb25lID0gW107CiAgZm9yIChsZXQgaSA9IDA7IGkgPCBmaWxlcy5sZW5ndGg7IGkrKykgewogICAgaWYgKG9uUHJvZ3Jl' +
  'c3MpIG9uUHJvZ3Jlc3MoaSArIDEsIGZpbGVzLmxlbmd0aCk7CiAgICBjb25zdCBzaG90ID0gYXdhaXQgc2hyaW5rUGhvdG8oZmls' +
  'ZXNbaV0pOwogICAgZG9uZS5wdXNoKGF3YWl0IGFwaSgnL2F0dGVtcHRzLycgKyBhdHRlbXB0SWQgKyAnL3Bob3RvcycsIHsKICAg' +
  'ICAgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHNob3QpCiAgICB9KSk7CiAgfQogIHJldHVybiBkb25lOwp9' +
  'CgpmdW5jdGlvbiBwaG90b1N0cmlwKGEsIGpvYikgewogIGNvbnN0IGNhbkVkaXQgPSAham9iLnBob3Rvc19oaWRkZW4gJiYgKGlz' +
  'QWRtaW4oKSB8fCBqb2IuYXNzaWduZWRfdG8gPT09IFMubWUuaWQpOwogIGlmIChqb2IucGhvdG9zX2hpZGRlbikgewogICAgcmV0' +
  'dXJuIGEucGhvdG9fY291bnQKICAgICAgPyBgPGRpdiBjbGFzcz0ibSBwaG90by1oaWRkZW4iPiR7YS5waG90b19jb3VudH0gcGhv' +
  'dG8ke2EucGhvdG9fY291bnQgPiAxID8gJ3MnIDogJyd9IOKAlCBoaWRkZW4gaW4gc3VwcG9ydCB2aWV3PC9kaXY+YAogICAgICA6' +
  'ICcnOwogIH0KICBjb25zdCB0aHVtYnMgPSAoYS5waG90b3MgfHwgW10pLm1hcChwID0+CiAgICBgPGJ1dHRvbiBjbGFzcz0idGh1' +
  'bWIiIGRhdGEtcGhvdG89IiR7cC5pZH0iIHRpdGxlPSIke2VzYyhwLmNhcHRpb24gfHwgJycpfSI+CiAgICAgICA8aW1nIHNyYz0i' +
  'L3Bob3RvLyR7cC5pZH0iIGFsdD0iJHtlc2MocC5jYXB0aW9uIHx8ICdBdHRlbXB0IHBob3RvJyl9IiBsb2FkaW5nPSJsYXp5Ij4K' +
  'ICAgICAgICR7cC5jYXB0aW9uID8gYDxzcGFuIGNsYXNzPSJjYXAiPiR7ZXNjKHAuY2FwdGlvbil9PC9zcGFuPmAgOiAnJ30KICAg' +
  'ICA8L2J1dHRvbj5gKS5qb2luKCcnKTsKICByZXR1cm4gYDxkaXYgY2xhc3M9InBob3RvcyIgZGF0YS1hdHRlbXB0PSIke2EuaWR9' +
  'Ij4KICAgICR7dGh1bWJzfQogICAgJHtjYW5FZGl0ID8gYDxidXR0b24gY2xhc3M9InRodW1iIGFkZCIgZGF0YS1hZGQ9IiR7YS5p' +
  'ZH0iPu+8izxzcGFuPlBob3RvPC9zcGFuPjwvYnV0dG9uPmAgOiAnJ30KICA8L2Rpdj5gOwp9CgpmdW5jdGlvbiBiaW5kUGhvdG9T' +
  'dHJpcHMoam9iKSB7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcGhvdG9dJykuZm9yRWFjaChiID0+IHsKICAg' +
  'IGIub25jbGljayA9ICgpID0+IHBob3RvVmlld2VyKGpvYiwgTnVtYmVyKGIuZGF0YXNldC5waG90bykpOwogIH0pOwogIGRvY3Vt' +
  'ZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFkZF0nKS5mb3JFYWNoKGIgPT4gewogICAgYi5vbmNsaWNrID0gKCkgPT4gcGlj' +
  'a1Bob3Rvcyhhc3luYyBmaWxlcyA9PiB7CiAgICAgIGNvbnN0IGxhYmVsID0gYi5xdWVyeVNlbGVjdG9yKCdzcGFuJyk7CiAgICAg' +
  'IGNvbnN0IHdhcyA9IGxhYmVsLnRleHRDb250ZW50OwogICAgICBiLmRpc2FibGVkID0gdHJ1ZTsKICAgICAgdHJ5IHsKICAgICAg' +
  'ICBhd2FpdCB1cGxvYWRQaG90b3MoTnVtYmVyKGIuZGF0YXNldC5hZGQpLCBmaWxlcywKICAgICAgICAgIChuLCB0b3RhbCkgPT4g' +
  'eyBsYWJlbC50ZXh0Q29udGVudCA9IG4gKyAnLycgKyB0b3RhbDsgfSk7CiAgICAgICAgdG9hc3QoZmlsZXMubGVuZ3RoID4gMSA/' +
  'IGZpbGVzLmxlbmd0aCArICcgcGhvdG9zIGFkZGVkJyA6ICdQaG90byBhZGRlZCcpOwogICAgICAgIGdvKCdqb2InLCB7IGlkOiBq' +
  'b2IuaWQgfSk7CiAgICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgICBiLmRpc2FibGVkID0gZmFsc2U7IGxhYmVsLnRleHRDb250ZW50' +
  'ID0gd2FzOwogICAgICAgIHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7CiAgICAgIH0KICAgIH0pOwogIH0pOwp9CgovLyBPbmUgaGlk' +
  'ZGVuIGlucHV0LCByZXVzZWQuIGNhcHR1cmU9ImVudmlyb25tZW50IiBvcGVucyB0aGUgcmVhciBjYW1lcmEKLy8gc3RyYWlnaHQg' +
  'YXdheSBvbiBhIHBob25lOyBvbiBhIGRlc2t0b3AgaXQgaXMgYW4gb3JkaW5hcnkgZmlsZSBwaWNrZXIuCmZ1bmN0aW9uIHBpY2tQ' +
  'aG90b3Mob25QaWNrZWQpIHsKICBjb25zdCBpbnAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpOwogIGlucC50eXBl' +
  'ID0gJ2ZpbGUnOwogIGlucC5hY2NlcHQgPSAnaW1hZ2UvKic7CiAgaW5wLm11bHRpcGxlID0gdHJ1ZTsKICBpbnAuc2V0QXR0cmli' +
  'dXRlKCdjYXB0dXJlJywgJ2Vudmlyb25tZW50Jyk7CiAgaW5wLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgZG9jdW1lbnQuYm9k' +
  'eS5hcHBlbmRDaGlsZChpbnApOwogIGlucC5vbmNoYW5nZSA9ICgpID0+IHsKICAgIGNvbnN0IGZpbGVzID0gQXJyYXkuZnJvbShp' +
  'bnAuZmlsZXMgfHwgW10pOwogICAgaW5wLnJlbW92ZSgpOwogICAgaWYgKGZpbGVzLmxlbmd0aCkgb25QaWNrZWQoZmlsZXMpOwog' +
  'IH07CiAgaW5wLmNsaWNrKCk7Cn0KCmZ1bmN0aW9uIHBob3RvVmlld2VyKGpvYiwgaWQpIHsKICBjb25zdCBhbGwgPSBqb2IuYXR0' +
  'ZW1wdHMuZmxhdE1hcChhID0+IGEucGhvdG9zIHx8IFtdKTsKICBjb25zdCBwID0gYWxsLmZpbmQoeCA9PiB4LmlkID09PSBpZCk7' +
  'CiAgaWYgKCFwKSByZXR1cm47CiAgY29uc3QgY2FuRWRpdCA9IGlzQWRtaW4oKSB8fCBqb2IuYXNzaWduZWRfdG8gPT09IFMubWUu' +
  'aWQ7CiAgc2hlZXQoJ1Bob3RvJywgYAogICAgPGltZyBzcmM9Ii9waG90by8ke3AuaWR9IiBhbHQ9IiIgc3R5bGU9IndpZHRoOjEw' +
  'MCU7Ym9yZGVyLXJhZGl1czoxMnB4O2Rpc3BsYXk6YmxvY2siPgogICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJtYXJnaW4t' +
  'dG9wOjEycHgiPjxsYWJlbD5DYXB0aW9uPC9sYWJlbD4KICAgICAgPGlucHV0IGlkPSJwX2NhcCIgdmFsdWU9IiR7ZXNjKHAuY2Fw' +
  'dGlvbiB8fCAnJyl9IiBwbGFjZWhvbGRlcj0iRnJvbnQgZG9vciwgbm8gYW5zd2VyIgogICAgICAgICR7Y2FuRWRpdCA/ICcnIDog' +
  'J2Rpc2FibGVkJ30+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJoaW50Ij4ke01hdGgucm91bmQocC5ieXRlcyAvIDEwMjQpfSBLQiDC' +
  'tyBhZGRlZCAke2ZtdERUKHAuY3JlYXRlZF9hdCl9PC9kaXY+CiAgICAke2NhbkVkaXQgPyBgPGRpdiBjbGFzcz0icm93IiBzdHls' +
  'ZT0ibWFyZ2luLXRvcDoxMnB4Ij4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0icF9zYXZlIj5TYXZlIGNhcHRpb248L2J1' +
  'dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgaWQ9InBfZGVsIj5EZWxldGUgcGhvdG88L2J1dHRvbj4KICAgIDwv' +
  'ZGl2PmAgOiAnJ31gLCBlbCA9PiB7CiAgICBpZiAoIWNhbkVkaXQpIHJldHVybjsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNwX3Nh' +
  'dmUnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICB0cnkgewogICAgICAgIGF3YWl0IGFwaSgnL3Bob3Rvcy8nICsgcC5p' +
  'ZCwgewogICAgICAgICAgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNhcHRpb246IGVsLnF1ZXJ5U2Vs' +
  'ZWN0b3IoJyNwX2NhcCcpLnZhbHVlIH0pCiAgICAgICAgfSk7CiAgICAgICAgY2xvc2VTaGVldCgpOyB0b2FzdCgnQ2FwdGlvbiBz' +
  'YXZlZCcpOyBnbygnam9iJywgeyBpZDogam9iLmlkIH0pOwogICAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1' +
  'ZSk7IH0KICAgIH07CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjcF9kZWwnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBp' +
  'ZiAoIWNvbmZpcm0oJ0RlbGV0ZSB0aGlzIHBob3RvPyBJdCBpcyBwYXJ0IG9mIHRoZSByZWNvcmQgZm9yIHRoaXMgYXR0ZW1wdC4n' +
  'KSkgcmV0dXJuOwogICAgICB0cnkgewogICAgICAgIGF3YWl0IGFwaSgnL3Bob3Rvcy8nICsgcC5pZCwgeyBtZXRob2Q6ICdERUxF' +
  'VEUnIH0pOwogICAgICAgIGNsb3NlU2hlZXQoKTsgdG9hc3QoJ1Bob3RvIGRlbGV0ZWQnKTsgZ28oJ2pvYicsIHsgaWQ6IGpvYi5p' +
  'ZCB9KTsKICAgICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgICB9OwogIH0pOwp9CgovKiAtLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGxvZyBhdHRlbXB0IC0tICovCmNvbnN0' +
  'IE9VVENPTUVTID0gWydTZXJ2ZWQnLCAnTm8gQW5zd2VyJywgJ0JhZCBBZGRyZXNzJywgJ01vdmVkJywgJ1JlZnVzZWQnLCAnRXZh' +
  'ZGluZycsICdPdGhlciddOwoKZnVuY3Rpb24gYXR0ZW1wdEZvcm0oam9iKSB7CiAgc2hlZXQoJ0xvZyBhdHRlbXB0IOKAlCAnICsg' +
  'am9iLnJlY2lwaWVudF9uYW1lLCBgCiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk91dGNvbWU8L2xhYmVsPgogICAgICA8' +
  'ZGl2IGNsYXNzPSJyb3ciIGlkPSJvdXRjb21lcyI+JHtPVVRDT01FUy5tYXAobyA9PgogICAgICAgIGA8YnV0dG9uIGNsYXNzPSJi' +
  'dG4gc2VjIHNtIiBkYXRhLW89IiR7b30iPiR7b308L2J1dHRvbj5gKS5qb2luKCcnKX08L2Rpdj48L2Rpdj4KICAgIDxkaXYgaWQ9' +
  'InNlcnZlZEZpZWxkcyIgc3R5bGU9ImRpc3BsYXk6bm9uZSI+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICAgIDxk' +
  'aXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+TWFubmVyPC9sYWJlbD48c2VsZWN0IGlkPSJhX21hbm5lciI+CiAgICAgICAgICAke1sn' +
  'UGVyc29uYWwnLCAnU3Vic3RpdHV0ZScsICdQb3N0ZWQnLCAnQ29ycG9yYXRlJywgJ0NlcnRpZmllZCBNYWlsJ10ubWFwKHMgPT4g' +
  'YDxvcHRpb24+JHtzfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxk' +
  'Ij48bGFiZWw+UGVyc29uIHNlcnZlZDwvbGFiZWw+PGlucHV0IGlkPSJhX3BlcnNvbl9zZXJ2ZWQiIHZhbHVlPSIke2VzYyhqb2Iu' +
  'cmVjaXBpZW50X25hbWUpfSI+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgICA8' +
  'ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlJlbGF0aW9uc2hpcCAoaWYgc3Vic3RpdHV0ZSk8L2xhYmVsPjxpbnB1dCBpZD0iYV9y' +
  'ZWxhdGlvbnNoaXAiIHBsYWNlaG9sZGVyPSJjby1yZXNpZGVudCwgY28td29ya2VyLi4uIj48L2Rpdj4KICAgICAgICA8ZGl2IGNs' +
  'YXNzPSJmaWVsZCI+PGxhYmVsPkRlc2NyaXB0aW9uPC9sYWJlbD48aW5wdXQgaWQ9ImFfZGVzY3JpcHRpb24iIHBsYWNlaG9sZGVy' +
  'PSJXL0YsIDQwcywgNSc2JnF1b3Q7LCBicm93biBoYWlyIj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYg' +
  'Y2xhc3M9ImZpZWxkIj48bGFiZWw+Tm90ZXM8L2xhYmVsPjx0ZXh0YXJlYSBpZD0iYV9ub3RlcyIgcGxhY2Vob2xkZXI9IkxpZ2h0' +
  'cyBvbiwgbm8gYW5zd2VyIGF0IGZyb250IGRvb3IuIFNpbHZlciBDaXZpYyBpbiBkcml2ZXdheS4iPjwvdGV4dGFyZWE+PC9kaXY+' +
  'CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPldoZW48L2xhYmVsPjxpbnB1dCBpZD0iYV93aGVuIiB0eXBlPSJkYXRldGlt' +
  'ZS1sb2NhbCIgdmFsdWU9IiR7bG9jYWxOb3coKX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91' +
  'bmQ6I2Y4ZmFmYztib3gtc2hhZG93Om5vbmU7bWFyZ2luLWJvdHRvbToxMnB4Ij4KICAgICAgPGRpdiBjbGFzcz0icm93Ij48YnV0' +
  'dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0iZ3BzQnRuIj5DYXB0dXJlIEdQUzwvYnV0dG9uPgogICAgICA8c3BhbiBjbGFzcz0i' +
  'aGludCIgaWQ9Imdwc091dCIgc3R5bGU9Im1hcmdpbjowIj5Ob3QgY2FwdHVyZWQ8L3NwYW4+PC9kaXY+CiAgICA8L2Rpdj4KICAg' +
  'IDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGhvdG9zPC9sYWJlbD4KICAgICAgPGRpdiBjbGFzcz0icGhvdG9zIiBpZD0icGVu' +
  'ZFBob3RvcyI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0idGh1bWIgYWRkIiBpZD0icGhvdG9CdG4iIHR5cGU9ImJ1dHRvbiI+77yL' +
  'PHNwYW4+UGhvdG88L3NwYW4+PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaW50Ij5UaGUgZG9vciwg' +
  'dGhlIG51bWJlciwgdGhlIG5vdGljZSwgdGhlIGNhci4gVGhleSBnbyBvbiB0aGUgYXR0ZW1wdAogICAgICBhbmQgb24gdGhlIHJl' +
  'cG9ydCB5b3VyIGNsaWVudCBzZWVzLjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICA8YnV0dG9u' +
  'IGNsYXNzPSJidG4iIGlkPSJzYXZlQXR0IiBkaXNhYmxlZD5QaWNrIGFuIG91dGNvbWU8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBj' +
  'bGFzcz0iYnRuIHNlYyIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5DYW5jZWw8L2J1dHRvbj4KICAgIDwvZGl2PmAsIGVsID0+IHsK' +
  'ICAgIGxldCBvdXRjb21lID0gbnVsbCwgZ3BzID0gbnVsbDsKICAgIC8qIFBob3RvcyBhcmUgcGlja2VkIGJlZm9yZSB0aGUgYXR0' +
  'ZW1wdCBleGlzdHMsIHNvIHRoZXkgYXJlIGhlbGQgaGVyZSBhbmQKICAgICAgIHVwbG9hZGVkIG9uY2Ugc2F2aW5nIGdpdmVzIHVz' +
  'IGFuIGF0dGVtcHQgaWQuICovCiAgICBjb25zdCBwZW5kaW5nID0gW107CiAgICBjb25zdCBzdHJpcCA9IGVsLnF1ZXJ5U2VsZWN0' +
  'b3IoJyNwZW5kUGhvdG9zJyk7CiAgICBjb25zdCBhZGRCdG4gPSBlbC5xdWVyeVNlbGVjdG9yKCcjcGhvdG9CdG4nKTsKICAgIGNv' +
  'bnN0IGRyYXdQZW5kaW5nID0gKCkgPT4gewogICAgICBzdHJpcC5xdWVyeVNlbGVjdG9yQWxsKCcucGVuZCcpLmZvckVhY2gobiA9' +
  'PiBuLnJlbW92ZSgpKTsKICAgICAgcGVuZGluZy5mb3JFYWNoKChmLCBpKSA9PiB7CiAgICAgICAgY29uc3QgYiA9IGRvY3VtZW50' +
  'LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOwogICAgICAgIGIudHlwZSA9ICdidXR0b24nOwogICAgICAgIGIuY2xhc3NOYW1lID0g' +
  'J3RodW1iIHBlbmQnOwogICAgICAgIGIudGl0bGUgPSAnUmVtb3ZlJzsKICAgICAgICBiLmlubmVySFRNTCA9IGA8aW1nIHNyYz0i' +
  'JHtVUkwuY3JlYXRlT2JqZWN0VVJMKGYpfSIgYWx0PSIiPjxzcGFuIGNsYXNzPSJ4Ij7Dlzwvc3Bhbj5gOwogICAgICAgIGIub25j' +
  'bGljayA9ICgpID0+IHsgcGVuZGluZy5zcGxpY2UoaSwgMSk7IGRyYXdQZW5kaW5nKCk7IH07CiAgICAgICAgc3RyaXAuaW5zZXJ0' +
  'QmVmb3JlKGIsIGFkZEJ0bik7CiAgICAgIH0pOwogICAgICBhZGRCdG4ucXVlcnlTZWxlY3Rvcignc3BhbicpLnRleHRDb250ZW50' +
  'ID0gcGVuZGluZy5sZW5ndGggPyBgUGhvdG8gKCR7cGVuZGluZy5sZW5ndGh9KWAgOiAnUGhvdG8nOwogICAgfTsKICAgIGFkZEJ0' +
  'bi5vbmNsaWNrID0gKCkgPT4gcGlja1Bob3RvcyhmaWxlcyA9PiB7IHBlbmRpbmcucHVzaCguLi5maWxlcyk7IGRyYXdQZW5kaW5n' +
  'KCk7IH0pOwogICAgZWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtb10nKS5mb3JFYWNoKGIgPT4gYi5vbmNsaWNrID0gKCkgPT4g' +
  'ewogICAgICBvdXRjb21lID0gYi5kYXRhc2V0Lm87CiAgICAgIGVsLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLW9dJykuZm9yRWFj' +
  'aCh4ID0+IHsgeC5jbGFzc05hbWUgPSAnYnRuIHNlYyBzbSc7IH0pOwogICAgICBiLmNsYXNzTmFtZSA9ICdidG4gc20nICsgKG91' +
  'dGNvbWUgPT09ICdTZXJ2ZWQnID8gJyBvaycgOiAnJyk7CiAgICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNzZXJ2ZWRGaWVsZHMnKS5z' +
  'dHlsZS5kaXNwbGF5ID0gb3V0Y29tZSA9PT0gJ1NlcnZlZCcgPyAnJyA6ICdub25lJzsKICAgICAgY29uc3QgcyA9IGVsLnF1ZXJ5' +
  'U2VsZWN0b3IoJyNzYXZlQXR0Jyk7CiAgICAgIHMuZGlzYWJsZWQgPSBmYWxzZTsKICAgICAgcy50ZXh0Q29udGVudCA9IG91dGNv' +
  'bWUgPT09ICdTZXJ2ZWQnID8gJ1NhdmUg4oCUIG1hcmtzIGpvYiBTRVJWRUQnIDogJ1NhdmUgYXR0ZW1wdCc7CiAgICB9KTsKICAg' +
  'IGVsLnF1ZXJ5U2VsZWN0b3IoJyNncHNCdG4nKS5vbmNsaWNrID0gKCkgPT4gewogICAgICBjb25zdCBvdXQgPSBlbC5xdWVyeVNl' +
  'bGVjdG9yKCcjZ3BzT3V0Jyk7CiAgICAgIGlmICghbmF2aWdhdG9yLmdlb2xvY2F0aW9uKSByZXR1cm4gb3V0LnRleHRDb250ZW50' +
  'ID0gJ05vdCBzdXBwb3J0ZWQgb24gdGhpcyBkZXZpY2UnOwogICAgICBvdXQudGV4dENvbnRlbnQgPSAnTG9jYXRpbmfigKYnOwog' +
  'ICAgICBuYXZpZ2F0b3IuZ2VvbG9jYXRpb24uZ2V0Q3VycmVudFBvc2l0aW9uKHBvcyA9PiB7CiAgICAgICAgZ3BzID0geyBsYXQ6' +
  'IHBvcy5jb29yZHMubGF0aXR1ZGUsIGxuZzogcG9zLmNvb3Jkcy5sb25naXR1ZGUsIGFjY3VyYWN5X206IHBvcy5jb29yZHMuYWNj' +
  'dXJhY3kgfTsKICAgICAgICBvdXQuaW5uZXJIVE1MID0gYDxiIHN0eWxlPSJjb2xvcjp2YXIoLS1vaykiPuKckyAke2dwcy5sYXQu' +
  'dG9GaXhlZCg1KX0sICR7Z3BzLmxuZy50b0ZpeGVkKDUpfTwvYj4gwrEke01hdGgucm91bmQoZ3BzLmFjY3VyYWN5X20pfW1gOwog' +
  'ICAgICB9LCBlcnIgPT4geyBvdXQudGV4dENvbnRlbnQgPSAnRmFpbGVkOiAnICsgZXJyLm1lc3NhZ2U7IH0sCiAgICAgICAgeyBl' +
  'bmFibGVIaWdoQWNjdXJhY3k6IHRydWUsIHRpbWVvdXQ6IDE1MDAwLCBtYXhpbXVtQWdlOiAwIH0pOwogICAgfTsKICAgIC8vIGF1' +
  'dG8tY2FwdHVyZSBvbiBvcGVuIOKAlCB0aGUgYWZmaWRhdml0IGlzIHN0cm9uZ2VyIHdoZW4gZXZlcnkgYXR0ZW1wdCBoYXMgY29v' +
  'cmRpbmF0ZXMKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNncHNCdG4nKS5jbGljaygpOwoKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNz' +
  'YXZlQXR0Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgYm9keSA9IE9iamVjdC5hc3NpZ24oewogICAgICAg' +
  'IG91dGNvbWUsCiAgICAgICAgYXR0ZW1wdGVkX2F0OiBlbC5xdWVyeVNlbGVjdG9yKCcjYV93aGVuJykudmFsdWUgfHwgbnVsbCwK' +
  'ICAgICAgICBub3RlczogZWwucXVlcnlTZWxlY3RvcignI2Ffbm90ZXMnKS52YWx1ZQogICAgICB9LCBncHMgfHwge30pOwogICAg' +
  'ICBpZiAob3V0Y29tZSA9PT0gJ1NlcnZlZCcpIHsKICAgICAgICBib2R5Lm1hbm5lciA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNhX21h' +
  'bm5lcicpLnZhbHVlOwogICAgICAgIGJvZHkucGVyc29uX3NlcnZlZCA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNhX3BlcnNvbl9zZXJ2' +
  'ZWQnKS52YWx1ZTsKICAgICAgICBib2R5LnJlbGF0aW9uc2hpcCA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNhX3JlbGF0aW9uc2hpcCcp' +
  'LnZhbHVlOwogICAgICAgIGJvZHkuZGVzY3JpcHRpb24gPSBlbC5xdWVyeVNlbGVjdG9yKCcjYV9kZXNjcmlwdGlvbicpLnZhbHVl' +
  'OwogICAgICB9CiAgICAgIGNvbnN0IHNhdmUgPSBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZUF0dCcpOwogICAgICBjb25zdCB3YXMg' +
  'PSBzYXZlLnRleHRDb250ZW50OwogICAgICBzYXZlLmRpc2FibGVkID0gdHJ1ZTsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBh' +
  'dHQgPSBhd2FpdCBhcGkoJy9qb2JzLycgKyBqb2IuaWQgKyAnL2F0dGVtcHRzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNP' +
  'Ti5zdHJpbmdpZnkoYm9keSkgfSk7CiAgICAgICAgLyogVGhlIGF0dGVtcHQgaXMgc2F2ZWQgYXQgdGhpcyBwb2ludC4gSWYgYSBw' +
  'aG90byBmYWlscyB0byB1cGxvYWQgYWZ0ZXIKICAgICAgICAgICB0aGF0IOKAlCBkZWFkIHNpZ25hbCBpbiBhIGRyaXZld2F5IOKA' +
  'lCB0aGUgYXR0ZW1wdCBzdGlsbCBzdGFuZHMgYW5kIHRoZQogICAgICAgICAgIHNlcnZlciBpcyB0b2xkIHdoaWNoIG9uZXMgdG8g' +
  'cmV0cnkgZnJvbSB0aGUgam9iIHNjcmVlbiwgcmF0aGVyIHRoYW4KICAgICAgICAgICBsb3NpbmcgdGhlIHdob2xlIGVudHJ5LiAq' +
  'LwogICAgICAgIGxldCBmYWlsZWQgPSAwOwogICAgICAgIGlmIChwZW5kaW5nLmxlbmd0aCkgewogICAgICAgICAgdHJ5IHsKICAg' +
  'ICAgICAgICAgYXdhaXQgdXBsb2FkUGhvdG9zKGF0dC5pZCwgcGVuZGluZywKICAgICAgICAgICAgICAobiwgdG90YWwpID0+IHsg' +
  'c2F2ZS50ZXh0Q29udGVudCA9IGBTZW5kaW5nIHBob3RvICR7bn0gb2YgJHt0b3RhbH3igKZgOyB9KTsKICAgICAgICAgIH0gY2F0' +
  'Y2ggKGUpIHsgZmFpbGVkID0gMTsgfQogICAgICAgIH0KICAgICAgICBjbG9zZVNoZWV0KCk7CiAgICAgICAgdG9hc3QoZmFpbGVk' +
  'ID8gJ0F0dGVtcHQgc2F2ZWQg4oCUIGEgcGhvdG8gZGlkIG5vdCBzZW5kLCBhZGQgaXQgYWdhaW4gZnJvbSB0aGUgam9iJwogICAg' +
  'ICAgICAgOiBvdXRjb21lID09PSAnU2VydmVkJyA/ICdTZXJ2ZWQg4oCUIGpvYiBjbG9zZWQgb3V0JyA6ICdBdHRlbXB0IGxvZ2dl' +
  'ZCcsICEhZmFpbGVkKTsKICAgICAgICBnbygnam9iJywgeyBpZDogam9iLmlkIH0pOwogICAgICB9IGNhdGNoIChlKSB7IHNhdmUu' +
  'ZGlzYWJsZWQgPSBmYWxzZTsgc2F2ZS50ZXh0Q29udGVudCA9IHdhczsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogICAgfTsK' +
  'ICB9KTsKfQoKZnVuY3Rpb24gbG9jYWxOb3coKSB7CiAgY29uc3QgZCA9IG5ldyBEYXRlKERhdGUubm93KCkgLSBuZXcgRGF0ZSgp' +
  'LmdldFRpbWV6b25lT2Zmc2V0KCkgKiA2MDAwMCk7CiAgcmV0dXJuIGQudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxNik7Cn0KCi8q' +
  'IC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gYWZmaWRhdml0IC0tICov' +
  'CmFzeW5jIGZ1bmN0aW9uIGFmZmlkYXZpdFNoZWV0KGpvYikgewogIGNvbnN0IHRlbXBsYXRlcyA9IGF3YWl0IGFwaSgnL3RlbXBs' +
  'YXRlcycpOwogIGNvbnN0IGxvYWQgPSBhc3luYyBpZCA9PiB7CiAgICBjb25zdCByID0gYXdhaXQgYXBpKCcvam9icy8nICsgam9i' +
  'LmlkICsgJy9hZmZpZGF2aXQnICsgKGlkID8gJz90ZW1wbGF0ZV9pZD0nICsgaWQgOiAnJykpOwogICAgcmV0dXJuIHI7CiAgfTsK' +
  'ICBjb25zdCBmaXJzdCA9IGF3YWl0IGxvYWQoKTsKICBzaGVldCgnQWZmaWRhdml0IOKAlCAnICsgam9iLmpvYl9udW1iZXIsIGAK' +
  'ICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+VGVtcGxhdGU8L2xhYmVsPjxzZWxlY3QgaWQ9InRwbCI+CiAgICAgICR7dGVt' +
  'cGxhdGVzLm1hcCh0ID0+IGA8b3B0aW9uIHZhbHVlPSIke3QuaWR9IiAke3QuaWQgPT09IGZpcnN0LnRlbXBsYXRlX2lkID8gJ3Nl' +
  'bGVjdGVkJyA6ICcnfT4ke2VzYyh0Lm5hbWUpfSR7dC5qdXJpc2RpY3Rpb24gPyAnIOKAlCAnICsgZXNjKHQuanVyaXNkaWN0aW9u' +
  'KSA6ICcnfTwvb3B0aW9uPmApLmpvaW4oJycpfQogICAgPC9zZWxlY3Q+PC9kaXY+CiAgICA8cHJlIGNsYXNzPSJwcmV2IiBpZD0i' +
  'cHJldiI+JHtlc2MoZmlyc3QudGV4dCl9PC9wcmU+CiAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgi' +
  'PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJwcmludEFmZiI+UHJpbnQgLyBzYXZlIFBERjwvYnV0dG9uPgogICAgICA8' +
  'YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBpZD0iY29weUFmZiI+Q29weSB0ZXh0PC9idXR0b24+CiAgICAgIDxidXR0b24gY2xhc3M9' +
  'ImJ0biBzZWMiIG9uY2xpY2s9ImNsb3NlU2hlZXQoKSI+Q2xvc2U8L2J1dHRvbj4KICAgIDwvZGl2PmAsIGVsID0+IHsKICAgIGNv' +
  'bnN0IHNlbCA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyN0cGwnKTsKICAgIHNlbC5vbmNoYW5nZSA9IGFzeW5jICgpID0+IHsgZWwucXVl' +
  'cnlTZWxlY3RvcignI3ByZXYnKS50ZXh0Q29udGVudCA9IChhd2FpdCBsb2FkKHNlbC52YWx1ZSkpLnRleHQ7IH07CiAgICBlbC5x' +
  'dWVyeVNlbGVjdG9yKCcjcHJpbnRBZmYnKS5vbmNsaWNrID0gKCkgPT4KICAgICAgd2luZG93Lm9wZW4oJy9wcmludC9hZmZpZGF2' +
  'aXQvJyArIGpvYi5pZCArICc/dGVtcGxhdGVfaWQ9JyArIHNlbC52YWx1ZSwgJ19ibGFuaycpOwogICAgZWwucXVlcnlTZWxlY3Rv' +
  'cignI2NvcHlBZmYnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRl' +
  'VGV4dChlbC5xdWVyeVNlbGVjdG9yKCcjcHJldicpLnRleHRDb250ZW50KTsKICAgICAgdG9hc3QoJ0NvcGllZCcpOwogICAgfTsK' +
  'ICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gdG9v' +
  'bHMgLS0tICovCi8qIExhYmVsIG1ha2VyLiBUaGUgcG9pbnQgb2YgdGhlIHNoZWV0IGdyaWQgaXMgdGhhdCBsYWJlbCBzaGVldHMg' +
  'YXJlIGV4cGVuc2l2ZQogICBhbmQgcmFyZWx5IHVzZWQgdXAgaW4gb25lIGdvOiBtYXJrIHdoaWNoIG9uZXMgeW91J3ZlIGFscmVh' +
  'ZHkgcGVlbGVkIG9mZiBhbmQKICAgdGhlIHByaW50ZXIgc2tpcHMgdGhlbSwgc28gYSBwYXJ0LXVzZWQgc2hlZXQgZ29lcyBiYWNr' +
  'IGluIGFuZCBjYXJyaWVzIG9uLiAqLwphc3luYyBmdW5jdGlvbiB0b29sc1ZpZXcoKSB7CiAgY29uc3QgW2xheW91dHMsIGluaXRT' +
  'aGVldCwgam9ic10gPSBhd2FpdCBQcm9taXNlLmFsbChbCiAgICBhcGkoJy9sYWJlbC1sYXlvdXRzJyksIGFwaSgnL2xhYmVsLXNo' +
  'ZWV0JyksIGFwaSgnL2pvYnM/b3Blbj0xJykKICBdKTsKICBTLmNhY2hlLnNoZWV0ID0gaW5pdFNoZWV0OwogIFMuY2FjaGUucGlj' +
  'a2VkID0gUy5jYWNoZS5waWNrZWQgfHwgW107CgogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8aDEgY2xhc3M9InBhZ2Ui' +
  'PlRvb2xzPC9oMT4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkxhYmVsIG1ha2VyIDxzcGFuIGNsYXNzPSJzdWIi' +
  'PnByaW50cyBvbmx5IHRoZSBsYWJlbHMgeW91IGhhdmVuJ3QgdXNlZDwvc3Bhbj48L2gyPgoKICAgICAgPGRpdiBjbGFzcz0iZmll' +
  'bGQiPjxsYWJlbD5MYWJlbCBzaGVldDwvbGFiZWw+CiAgICAgICAgPHNlbGVjdCBpZD0ibGF5b3V0Ij4KICAgICAgICAgICR7bGF5' +
  'b3V0cy5tYXAobCA9PiBgPG9wdGlvbiB2YWx1ZT0iJHtsLmtleX0iICR7bC5rZXkgPT09IGluaXRTaGVldC5sYXlvdXQgPyAnc2Vs' +
  'ZWN0ZWQnIDogJyd9PgogICAgICAgICAgICAke2VzYyhsLm5hbWUpfSDigJQgJHtlc2MobC5zaXplKX08L29wdGlvbj5gKS5qb2lu' +
  'KCcnKX0KICAgICAgICA8L3NlbGVjdD4KICAgICAgICA8ZGl2IGNsYXNzPSJoaW50Ij5PZmZpY2UgRGVwb3Qgc2hlZXRzIHByaW50' +
  'IGFuIEF2ZXJ5IGVxdWl2YWxlbnQgbnVtYmVyIG9uIHRoZSBwYWNrYWdlIGZyb250IOKAlAogICAgICAgICAgbWF0Y2ggdGhhdC4g' +
  'Q2hhbmdpbmcgdGhlIHNoZWV0IGNsZWFycyB0aGUgdXNlZCBtYXJrcywgc2luY2UgcG9zaXRpb24gNyBvbiBhIDMwLXVwIHNoZWV0' +
  'CiAgICAgICAgICBpc24ndCBwb3NpdGlvbiA3IG9uIGEgMTAtdXAgb25lLjwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDxsYWJl' +
  'bD5XaGljaCBsYWJlbHMgYXJlIGFscmVhZHkgZ29uZT88L2xhYmVsPgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFy' +
  'Z2luLWJvdHRvbTo4cHgiPlRhcCB0aGUgb25lcyBhbHJlYWR5IHBlZWxlZCBvZmYuIEdyZXkgPSB1c2VkIGFuZCBza2lwcGVkLgog' +
  'ICAgICAgIE51bWJlcmVkIGdyZWVuID0gd2hlcmUgeW91ciBuZXh0IGxhYmVscyB3aWxsIGxhbmQsIGluIG9yZGVyLjwvZGl2Pgog' +
  'ICAgICA8ZGl2IGlkPSJncmlkIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4K' +
  'ICAgICAgICA8c3BhbiBjbGFzcz0icGlsbCIgaWQ9ImZyZWVDb3VudCI+PC9zcGFuPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0' +
  'biBzZWMgc20iIGlkPSJuZXdTaGVldCI+RnJlc2ggc2hlZXQ8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2Vj' +
  'IHNtIiBpZD0iYWxsVXNlZCI+TWFyayBhbGwgdXNlZDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxkaXYg' +
  'Y2xhc3M9ImNhcmQiPgogICAgICA8aDI+V2hvIHRvIHByaW50IDxzcGFuIGNsYXNzPSJzdWIiIGlkPSJwaWNrQ291bnQiPjwvc3Bh' +
  'bj48L2gyPgogICAgICA8aW5wdXQgaWQ9ImpvYkZpbHRlciIgcGxhY2Vob2xkZXI9IkZpbHRlciBieSBuYW1lLCBjaXR5IG9yIGpv' +
  'YiBudW1iZXIiIHN0eWxlPSJtYXJnaW4tYm90dG9tOjhweCI+CiAgICAgIDxkaXYgY2xhc3M9Imxpc3QiIGlkPSJqb2JQaWNrIiBz' +
  'dHlsZT0ibWF4LWhlaWdodDozMjBweDtvdmVyZmxvdzphdXRvIj4KICAgICAgICAke2pvYnMubGVuZ3RoID8gam9icy5tYXAoaiA9' +
  'PiBgCiAgICAgICAgICA8ZGl2IGNsYXNzPSJpdGVtIiBkYXRhLXBpY2s9IiR7ai5pZH0iPgogICAgICAgICAgICA8ZGl2IGNsYXNz' +
  'PSJyIj48ZGl2PgogICAgICAgICAgICAgIDxkaXYgY2xhc3M9InQiPiR7ZXNjKGoucmVjaXBpZW50X25hbWUpfTwvZGl2PgogICAg' +
  'ICAgICAgICAgIDxkaXYgY2xhc3M9Im0iPiR7ZXNjKGouam9iX251bWJlcil9IMK3ICR7ZXNjKFtqLmFkZHJlc3MxLCBqLmNpdHld' +
  'LmZpbHRlcihCb29sZWFuKS5qb2luKCcsICcpIHx8ICdubyBhZGRyZXNzJyl9PC9kaXY+CiAgICAgICAgICAgIDwvZGl2PjxzcGFu' +
  'IGNsYXNzPSJwaWxsIiBkYXRhLXRpY2s9IiR7ai5pZH0iPmFkZDwvc3Bhbj48L2Rpdj4KICAgICAgICAgIDwvZGl2PmApLmpvaW4o' +
  'JycpCiAgICAgICAgICA6ICc8ZGl2IGNsYXNzPSJlbXB0eSI+Tm8gb3BlbiBqb2JzIHRvIGxhYmVsLjwvZGl2Pid9CiAgICAgIDwv' +
  'ZGl2PgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5QcmludDwvaDI+CiAgICAgIDxkaXYgY2xh' +
  'c3M9InJvdyI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0icHJpbnRCdG4iIGRpc2FibGVkPlByaW50IGxhYmVsczwv' +
  'YnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJ0ZXN0QnRuIj5BbGlnbm1lbnQgdGVzdDwvYnV0' +
  'dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij5JbiB0aGUgcHJp' +
  'bnQgZGlhbG9nIHNldCBzY2FsZSB0byA8Yj4xMDAlPC9iPiBhbmQgdHVybiBvZmYKICAgICAgICAiZml0IHRvIHBhZ2UiIOKAlCBz' +
  'Y2FsaW5nIGlzIHdoYXQgdGhyb3dzIGxhYmVsIGFsaWdubWVudCBvZmYuPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCIg' +
  'c3R5bGU9Im1hcmdpbi10b3A6MTRweCI+PGxhYmVsPk51ZGdlLCBpZiB5b3VyIHByaW50ZXIgcnVucyBvZmY8L2xhYmVsPgogICAg' +
  'ICAgIDxkaXYgY2xhc3M9InJvdyI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbjowIj5SaWdodDwv' +
  'c3Bhbj4KICAgICAgICAgIDxpbnB1dCBpZD0ib2ZmWCIgdHlwZT0ibnVtYmVyIiBzdGVwPSIwLjAxIiBtaW49Ii0wLjUiIG1heD0i' +
  'MC41IiB2YWx1ZT0iJHtpbml0U2hlZXQub2Zmc2V0X3h9IiBzdHlsZT0id2lkdGg6OTBweCI+CiAgICAgICAgICA8c3BhbiBjbGFz' +
  'cz0iaGludCIgc3R5bGU9Im1hcmdpbjowIj5Eb3duPC9zcGFuPgogICAgICAgICAgPGlucHV0IGlkPSJvZmZZIiB0eXBlPSJudW1i' +
  'ZXIiIHN0ZXA9IjAuMDEiIG1pbj0iLTAuNSIgbWF4PSIwLjUiIHZhbHVlPSIke2luaXRTaGVldC5vZmZzZXRfeX0iIHN0eWxlPSJ3' +
  'aWR0aDo5MHB4Ij4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJzYXZlT2ZmIj5TYXZlPC9idXR0b24+' +
  'CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGludCI+SW5jaGVzLiBQcmludCB0aGUgYWxpZ25tZW50IHRlc3Qg' +
  'b24gcGxhaW4gcGFwZXIsIGhvbGQgaXQgYWdhaW5zdCBhIHJlYWwgc2hlZXQsCiAgICAgICAgICBhbmQgbnVkZ2UgdW50aWwgdGhl' +
  'IGJveGVzIGxpbmUgdXAuPC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+YCk7CiAgYmluZFNoZWxsKCk7CgogIGNvbnN0IGxh' +
  'eW91dE1ldGEgPSAoKSA9PiBsYXlvdXRzLmZpbmQobCA9PiBsLmtleSA9PT0gUy5jYWNoZS5zaGVldC5sYXlvdXQpIHx8IGxheW91' +
  'dHNbMF07CgogIGZ1bmN0aW9uIGRyYXdHcmlkKCkgewogICAgY29uc3QgbWV0YSA9IGxheW91dE1ldGEoKTsKICAgIGNvbnN0IHMg' +
  'PSBTLmNhY2hlLnNoZWV0OwogICAgY29uc3QgdXNlZCA9IG5ldyBTZXQocy51c2VkLm1hcChOdW1iZXIpKTsKICAgIGNvbnN0IGZy' +
  'ZWUgPSBbXTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbWV0YS5jYXBhY2l0eTsgaSsrKSBpZiAoIXVzZWQuaGFzKGkpKSBmcmVl' +
  'LnB1c2goaSk7CiAgICBjb25zdCBvcmRlciA9IG5ldyBNYXAoZnJlZS5zbGljZSgwLCBTLmNhY2hlLnBpY2tlZC5sZW5ndGgpLm1h' +
  'cCgocG9zLCBuKSA9PiBbcG9zLCBuICsgMV0pKTsKCiAgICAkKCcjZ3JpZCcpLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJsZ3Jp' +
  'ZCIgc3R5bGU9ImdyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoJHttZXRhLmNvbHN9LDFmcikiPmAgKwogICAgICBBcnJheS5m' +
  'cm9tKHsgbGVuZ3RoOiBtZXRhLmNhcGFjaXR5IH0sIChfLCBpKSA9PiB7CiAgICAgICAgY29uc3QgaXNVc2VkID0gdXNlZC5oYXMo' +
  'aSk7CiAgICAgICAgY29uc3QgbiA9IG9yZGVyLmdldChpKTsKICAgICAgICByZXR1cm4gYDxidXR0b24gY2xhc3M9ImxjZWxsJHtp' +
  'c1VzZWQgPyAnIHVzZWQnIDogJyd9JHtuID8gJyBuZXh0JyA6ICcnfSIgZGF0YS1jZWxsPSIke2l9IgogICAgICAgICAgdGl0bGU9' +
  'IlBvc2l0aW9uICR7aSArIDF9Ij4ke2lzVXNlZCA/ICfDlycgOiAobiB8fCAnJyl9PC9idXR0b24+YDsKICAgICAgfSkuam9pbign' +
  'JykgKyAnPC9kaXY+JzsKCiAgICAkKCcjZnJlZUNvdW50JykudGV4dENvbnRlbnQgPSBmcmVlLmxlbmd0aCArICcgb2YgJyArIG1l' +
  'dGEuY2FwYWNpdHkgKyAnIGxlZnQnOwogICAgJCgnI3BpY2tDb3VudCcpLnRleHRDb250ZW50ID0gUy5jYWNoZS5waWNrZWQubGVu' +
  'Z3RoICsgJyBzZWxlY3RlZCc7CiAgICBjb25zdCBvdmVyID0gUy5jYWNoZS5waWNrZWQubGVuZ3RoID4gZnJlZS5sZW5ndGg7CiAg' +
  'ICBjb25zdCBidG4gPSAkKCcjcHJpbnRCdG4nKTsKICAgIGJ0bi5kaXNhYmxlZCA9ICFTLmNhY2hlLnBpY2tlZC5sZW5ndGg7CiAg' +
  'ICBidG4udGV4dENvbnRlbnQgPSBvdmVyCiAgICAgID8gYFByaW50ICR7ZnJlZS5sZW5ndGh9IG5vdyAoJHtTLmNhY2hlLnBpY2tl' +
  'ZC5sZW5ndGggLSBmcmVlLmxlbmd0aH0gd29uJ3QgZml0KWAKICAgICAgOiBgUHJpbnQgJHtTLmNhY2hlLnBpY2tlZC5sZW5ndGh9' +
  'IGxhYmVsJHtTLmNhY2hlLnBpY2tlZC5sZW5ndGggPT09IDEgPyAnJyA6ICdzJ31gOwoKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0' +
  'b3JBbGwoJ1tkYXRhLWNlbGxdJykuZm9yRWFjaChjID0+IGMub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgaSA9' +
  'ICtjLmRhdGFzZXQuY2VsbDsKICAgICAgY29uc3Qgc2V0ID0gbmV3IFNldChTLmNhY2hlLnNoZWV0LnVzZWQubWFwKE51bWJlcikp' +
  'OwogICAgICBzZXQuaGFzKGkpID8gc2V0LmRlbGV0ZShpKSA6IHNldC5hZGQoaSk7CiAgICAgIGF3YWl0IHNhdmVTaGVldCh7IHVz' +
  'ZWQ6IFsuLi5zZXRdIH0pOwogICAgfSk7CiAgfQoKICBhc3luYyBmdW5jdGlvbiBzYXZlU2hlZXQocGF0Y2gpIHsKICAgIHRyeSB7' +
  'CiAgICAgIFMuY2FjaGUuc2hlZXQgPSBhd2FpdCBhcGkoJy9sYWJlbC1zaGVldCcsIHsgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBK' +
  'U09OLnN0cmluZ2lmeShwYXRjaCkgfSk7CiAgICAgIGRyYXdHcmlkKCk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2Fn' +
  'ZSwgdHJ1ZSk7IH0KICB9CgogICQoJyNsYXlvdXQnKS5vbmNoYW5nZSA9IGUgPT4gc2F2ZVNoZWV0KHsgbGF5b3V0OiBlLnRhcmdl' +
  'dC52YWx1ZSB9KTsKICAkKCcjbmV3U2hlZXQnKS5vbmNsaWNrID0gKCkgPT4gc2F2ZVNoZWV0KHsgdXNlZDogW10gfSk7CiAgJCgn' +
  'I2FsbFVzZWQnKS5vbmNsaWNrID0gKCkgPT4KICAgIHNhdmVTaGVldCh7IHVzZWQ6IEFycmF5LmZyb20oeyBsZW5ndGg6IGxheW91' +
  'dE1ldGEoKS5jYXBhY2l0eSB9LCAoXywgaSkgPT4gaSkgfSk7CiAgJCgnI3NhdmVPZmYnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4g' +
  'ewogICAgYXdhaXQgc2F2ZVNoZWV0KHsgb2Zmc2V0X3g6IE51bWJlcigkKCcjb2ZmWCcpLnZhbHVlKSB8fCAwLCBvZmZzZXRfeTog' +
  'TnVtYmVyKCQoJyNvZmZZJykudmFsdWUpIHx8IDAgfSk7CiAgICB0b2FzdCgnQWxpZ25tZW50IHNhdmVkJyk7CiAgfTsKCiAgY29u' +
  'c3QgcGFpbnQgPSAoKSA9PiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS10aWNrXScpLmZvckVhY2godCA9PiB7CiAg' +
  'ICBjb25zdCBvbiA9IFMuY2FjaGUucGlja2VkLmluY2x1ZGVzKCt0LmRhdGFzZXQudGljayk7CiAgICB0LnRleHRDb250ZW50ID0g' +
  'b24gPyAn4pyTIGFkZGVkJyA6ICdhZGQnOwogICAgdC5jbGFzc05hbWUgPSBvbiA/ICdwaWxsIFNlcnZlZCcgOiAncGlsbCc7CiAg' +
  'fSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcGlja10nKS5mb3JFYWNoKHJvdyA9PiByb3cub25jbGljayA9' +
  'ICgpID0+IHsKICAgIGNvbnN0IGlkID0gK3Jvdy5kYXRhc2V0LnBpY2s7CiAgICBjb25zdCBpID0gUy5jYWNoZS5waWNrZWQuaW5k' +
  'ZXhPZihpZCk7CiAgICBpID09PSAtMSA/IFMuY2FjaGUucGlja2VkLnB1c2goaWQpIDogUy5jYWNoZS5waWNrZWQuc3BsaWNlKGks' +
  'IDEpOwogICAgcGFpbnQoKTsgZHJhd0dyaWQoKTsKICB9KTsKICAkKCcjam9iRmlsdGVyJykub25pbnB1dCA9IGUgPT4gewogICAg' +
  'Y29uc3QgdiA9IGUudGFyZ2V0LnZhbHVlLnRvTG93ZXJDYXNlKCk7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0' +
  'YS1waWNrXScpLmZvckVhY2gociA9PiB7CiAgICAgIHIuc3R5bGUuZGlzcGxheSA9IHIuaW5uZXJUZXh0LnRvTG93ZXJDYXNlKCku' +
  'aW5jbHVkZXModikgPyAnJyA6ICdub25lJzsKICAgIH0pOwogIH07CgogICQoJyN0ZXN0QnRuJykub25jbGljayA9ICgpID0+IHsK' +
  'ICAgIGNvbnN0IGlkcyA9IFMuY2FjaGUucGlja2VkLmxlbmd0aCA/IFMuY2FjaGUucGlja2VkIDogKGpvYnNbMF0gPyBbam9ic1sw' +
  'XS5pZF0gOiBbXSk7CiAgICBpZiAoIWlkcy5sZW5ndGgpIHJldHVybiB0b2FzdCgnQWRkIGF0IGxlYXN0IG9uZSBqb2IgZmlyc3Qn' +
  'LCB0cnVlKTsKICAgIHdpbmRvdy5vcGVuKCcvcHJpbnQvbGFiZWxzP2d1aWRlcz0xJmlkcz0nICsgaWRzLmpvaW4oJywnKSwgJ19i' +
  'bGFuaycpOwogIH07CgogICQoJyNwcmludEJ0bicpLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBjb25zdCBtZXRhID0gbGF5b3V0TWV0' +
  'YSgpOwogICAgY29uc3QgdXNlZCA9IG5ldyBTZXQoUy5jYWNoZS5zaGVldC51c2VkLm1hcChOdW1iZXIpKTsKICAgIGNvbnN0IGZy' +
  'ZWUgPSBbXTsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbWV0YS5jYXBhY2l0eTsgaSsrKSBpZiAoIXVzZWQuaGFzKGkpKSBmcmVl' +
  'LnB1c2goaSk7CiAgICBjb25zdCB3aWxsVXNlID0gZnJlZS5zbGljZSgwLCBTLmNhY2hlLnBpY2tlZC5sZW5ndGgpOwogICAgd2lu' +
  'ZG93Lm9wZW4oJy9wcmludC9sYWJlbHM/aWRzPScgKyBTLmNhY2hlLnBpY2tlZC5qb2luKCcsJyksICdfYmxhbmsnKTsKCiAgICBj' +
  'b25maXJtUHJpbnRlZCh3aWxsVXNlKTsKICB9OwoKICBmdW5jdGlvbiBjb25maXJtUHJpbnRlZCh3aWxsVXNlKSB7CiAgICBzaGVl' +
  'dCgnRGlkIHRoZXkgcHJpbnQ/JywgYAogICAgICA8cCBjbGFzcz0iaGludCI+T25seSBtYXJrIHRoZXNlIHVzZWQgb25jZSB0aGUg' +
  'c2hlZXQgYWN0dWFsbHkgY2FtZSBvdXQgcmlnaHQg4oCUIGlmIHRoZSBwcmludGVyCiAgICAgICAgamFtbWVkIG9yIHRoZSBhbGln' +
  'bm1lbnQgd2FzIG9mZiwgc2F5IG5vIGFuZCBub3RoaW5nIGNoYW5nZXMuPC9wPgogICAgICA8cD48Yj4ke3dpbGxVc2UubGVuZ3Ro' +
  'fTwvYj4gcG9zaXRpb24ke3dpbGxVc2UubGVuZ3RoID09PSAxID8gJycgOiAncyd9IHdvdWxkIGJlIG1hcmtlZCB1c2VkOgogICAg' +
  'ICAgICR7d2lsbFVzZS5tYXAoaSA9PiBpICsgMSkuam9pbignLCAnKX08L3A+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9' +
  'Im1hcmdpbi10b3A6MTJweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIG9rIiBpZD0ieWVzVXNlZCI+WWVzIOKAlCBtYXJr' +
  'IHRoZW0gdXNlZDwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIG9uY2xpY2s9ImNsb3NlU2hlZXQoKSI+' +
  'Tm8sIGtlZXAgdGhlbSBmcmVlPC9idXR0b24+CiAgICAgIDwvZGl2PmAsIGVsID0+IHsKICAgICAgZWwucXVlcnlTZWxlY3Rvcign' +
  'I3llc1VzZWQnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICAgIGNvbnN0IHNldCA9IG5ldyBTZXQoUy5jYWNoZS5zaGVl' +
  'dC51c2VkLm1hcChOdW1iZXIpKTsKICAgICAgICB3aWxsVXNlLmZvckVhY2goaSA9PiBzZXQuYWRkKGkpKTsKICAgICAgICBhd2Fp' +
  'dCBzYXZlU2hlZXQoeyB1c2VkOiBbLi4uc2V0XSB9KTsKICAgICAgICBTLmNhY2hlLnBpY2tlZCA9IFtdOwogICAgICAgIGNsb3Nl' +
  'U2hlZXQoKTsKICAgICAgICB0b2FzdCgnU2hlZXQgdXBkYXRlZCDigJQgJyArIFMuY2FjaGUuc2hlZXQuZnJlZSArICcgbGFiZWxz' +
  'IGxlZnQnKTsKICAgICAgICBnbygndG9vbHMnKTsKICAgICAgfTsKICAgIH0pOwogIH0KCiAgcGFpbnQoKTsKICBkcmF3R3JpZCgp' +
  'Owp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIHByb3BlcnR5IHNlYXJj' +
  'aCAtLSAqLwovKiBUaGUgc2FtZSBsb29rdXAgdGhlIERlYWwgRmluZGVyIHJ1bnMsIGFnYWluc3QgdGhlIHNhbWUgY291bnR5IGFw' +
  'cHJhaXNhbAogKiByb2xscywgYmVjYXVzZSBhIHByb2Nlc3Mgc2VydmVyIG5lZWRzIGV4YWN0bHkgd2hhdCBhIGJ1eWVyIG5lZWRz' +
  'OiB3aG8gb3ducwogKiB0aGlzIGFkZHJlc3MsIGFuZCB3aGVyZSBkb2VzIHRoZWlyIHBvc3QgYWN0dWFsbHkgZ28uCiAqCiAqIFRo' +
  'ZSByb2xscyBhcmUgcHVibGlzaGVkIGFzIEFyY0dJUyBmZWF0dXJlIGxheWVycywgc28gdGhlIGJyb3dzZXIgYXNrcyB0aGUKICog' +
  'Y291bnR5IGRpcmVjdGx5IOKAlCBubyBrZXksIG5vIHNlcnZlciBpbiB0aGUgbWlkZGxlLCBub3RoaW5nIGNhY2hlZCB0aGF0IGNv' +
  'dWxkCiAqIGdvIHN0YWxlLiBGaWVsZCBuYW1lcyBkaWZmZXIgcGVyIGNvdW50eSwgc28gZWFjaCBvbmUgY2FycmllcyBpdHMgb3du' +
  'IG1hcCwKICogdmVyaWZpZWQgYWdhaW5zdCB0aGUgbGl2ZSBsYXllciByYXRoZXIgdGhhbiBndWVzc2VkLgogKi8KY29uc3QgQ0FE' +
  'ID0gKCgpID0+IHsKICBjb25zdCBjYW1lcm9uRmllbGRzID0gdXBwZXIgPT4gewogICAgY29uc3QgbiA9IChhLCBiKSA9PiAodXBw' +
  'ZXIgPyBiIDogYSk7CiAgICByZXR1cm4gewogICAgICBhZGRyOiBuKCdzaXR1c2Rpc3BsJywgJ3NpdHVzRGlzcGwnKSwKICAgICAg' +
  'YWRkclBhcnRzOiBbbignc2l0dXNubycsICdzaXR1c05vJyksIG4oJ3NpdHBmeCcsICdzaXRQZngnKSwgbignc2l0c3RyJywgJ3Np' +
  'dFN0cicpLCBuKCdzaXRzZngnLCAnc2l0U2Z4JyldLAogICAgICBjaXR5OiBuKCdzaXRjaXR5JywgJ3NpdENpdHknKSwgemlwOiBu' +
  'KCdzaXR6aXAnLCAnc2l0WmlwJyksCiAgICAgIG93bmVyOiAnb3duZXInLCBtYWlsOiAnYWRkcjEnLCBtYWlsY2l0eTogbignYWRk' +
  'cmNpdHknLCAnYWRkckNpdHknKSwKICAgICAgbWFpbHN0YXRlOiBuKCdhZGRyc3RhdGUnLCAnYWRkclN0YXRlJyksIG1haWx6aXA6' +
  'IG4oJ2FkZHJ6aXAnLCAnYWRkclppcCcpLAogICAgICBzcWZ0OiBuKCdsdmdhcmVhJywgJ2x2Z0FyZWEnKSwgeWVhcjogbigneXJi' +
  'dWlsdCcsICd5ckJ1aWx0JyksIGNhZDogJ21hcmtldCcsCiAgICAgIGNsczogbignc3RhdGVjZCcsICdzdGF0ZUNkJyksIGV4ZW1w' +
  'dDogJ2V4bXMnLCBwaWQ6IG4oJ3Byb3BfaWQnLCAnUFJPUF9JRCcpLAogICAgICBnZW86IG4oJ2dlb19pZCcsICdnZW9JRCcpLAog' +
  'ICAgICBkZWVkOiB7IGRhdGU6IG4oJ2RlZWRkdCcsICdkZWVkRHQnKSwgcmVjOiBuKCdkZWVkcmVjZHQnLCAnZGVlZFJlY0R0Jyks' +
  'CiAgICAgICAgICAgICAgdHlwZTogbignZGVlZHR5cGUnLCAnZGVlZFR5cGUnKSwgdm9sOiAndm9sdW1lJywgcGFnZTogJ3BhZ2Un' +
  'LCBudW06IG4oJ2RvY251bScsICdkb2NOdW0nKSB9CiAgICB9OwogIH07CiAgcmV0dXJuIHsKICAgICdUWHxISURBTEdPJzogewog' +
  'ICAgICBsYWJlbDogJ0hpZGFsZ28gQ0FEIDIwMjYgY2VydGlmaWVkIHJvbGwnLCBjbGVyazogJ2hpZGFsZ28nLAogICAgICBxOiAn' +
  'aHR0cHM6Ly9zZXJ2aWNlczkuYXJjZ2lzLmNvbS9kd01EUDU1SFRmb2o0bjFjL2FyY2dpcy9yZXN0L3NlcnZpY2VzL0hDQURfUEFS' +
  'Q0VMU18yMDI2L0ZlYXR1cmVTZXJ2ZXIvMS9xdWVyeScsCiAgICAgIGY6IHsgYWRkcjogJ3NpdHVzJywgb3duZXI6ICduYW1lJywg' +
  'bWFpbDogJ2FkZHJEZWxpdmVyeUxpbmUnLCBtYWlsY2l0eTogJ2FkZHJDaXR5JywKICAgICAgICAgICBtYWlsc3RhdGU6ICdhZGRy' +
  'U3RhdGUnLCBtYWlsemlwOiAnYWRkclppcCcsIHNxZnQ6ICdpbXBydk1haW5BcmVhJywKICAgICAgICAgICB5ZWFyOiAnaW1wcnZB' +
  'Y3R1YWxZZWFyQnVpbHQnLCBjYWQ6ICdtYXJrZXRWYWx1ZScsIGNsczogJ3N0YXRlQ2QnLAogICAgICAgICAgIGV4ZW1wdDogJ2V4' +
  'ZW1wdGlvbnMnLCBwaWQ6ICdQUk9QX0lEJywgZ2VvOiAnZ2VvSUQnLCB1bml0OiAndGF4aW5nVW5pdHMnLAogICAgICAgICAgIGxl' +
  'Z2FsOiAnbGVnYWxEZXNjcmlwdGlvbicsCiAgICAgICAgICAgZGVlZDogeyBkYXRlOiAnZGVlZER0JywgdHlwZTogJ2RlZWRUeXBl' +
  'JywgbnVtOiAnaW5zdHJ1bWVudE51bScgfSB9LAogICAgICBsaW5rOiBwaWQgPT4gJ2h0dHBzOi8vaGlkYWxnby5wcm9kaWd5Y2Fk' +
  'LmNvbS9wcm9wZXJ0eS1kZXRhaWwvJyArIHBpZCwKICAgICAgY2l0aWVzOiB7ICdNY0FsbGVuJzogJ0NNTCcsICdFZGluYnVyZyc6' +
  'ICdDRUInLCAnTWlzc2lvbic6ICdDTVMnLCAnUGhhcnInOiAnQ1BSJywgJ1dlc2xhY28nOiAnQ1dMJywKICAgICAgICAgICAgICAg' +
  'ICdTYW4gSnVhbic6ICdDU0onLCAnRG9ubmEnOiAnQ0ROJywgJ01lcmNlZGVzJzogJ0NNQycsICdBbGFtbyc6ICdDQU8nLCAnSGlk' +
  'YWxnbyc6ICdDSEQnLAogICAgICAgICAgICAgICAgJ0xhIEpveWEnOiAnQ0xKJywgJ1BhbG12aWV3JzogJ0NQTScsICdBbHRvbic6' +
  'ICdDQU4nIH0KICAgIH0sCiAgICAnVFh8Q0FNRVJPTic6IHsKICAgICAgbGFiZWw6ICdDYW1lcm9uIENBRCAyMDI2IHJvbGwnLCBj' +
  'bGVyazogJ2NhbWVyb24nLAogICAgICBxOiAnaHR0cHM6Ly9jb2JnaXMuYnJvd25zdmlsbGV0eC5nb3YvYXJjZ2lzL3Jlc3Qvc2Vy' +
  'dmljZXMvSG9zdGVkL0NDQURfUGFyY2Vsc18wOTA4MjAyNS9GZWF0dXJlU2VydmVyLzAvcXVlcnknLAogICAgICBmOiBjYW1lcm9u' +
  'RmllbGRzKGZhbHNlKSwKICAgICAgYWx0OiB7IHE6ICdodHRwczovL3NlcnZpY2VzMi5hcmNnaXMuY29tLzZvYUxNWkVabGt0YlFw' +
  'eWkvYXJjZ2lzL3Jlc3Qvc2VydmljZXMvQ0NBRF9QYXJjZWxzX1ZpZXcvRmVhdHVyZVNlcnZlci8wL3F1ZXJ5JywKICAgICAgICAg' +
  'ICAgIGxhYmVsOiAnQ2FtZXJvbiBDQUQgMjAyNSByb2xsIChFc3JpIG1pcnJvciknLCBmOiBjYW1lcm9uRmllbGRzKHRydWUpIH0s' +
  'CiAgICAgIGNpdGllczogeyAnQnJvd25zdmlsbGUnOiAnQ0JSJywgJ0hhcmxpbmdlbic6ICdDSEcnLCAnU2FuIEJlbml0byc6ICdD' +
  'U0InLCAnTGEgRmVyaWEnOiAnQ0xGJywKICAgICAgICAgICAgICAgICdMb3MgRnJlc25vcyc6ICdDTE8nLCAnU291dGggUGFkcmUg' +
  'SXNsYW5kJzogJ0NTUCcsICdSaW8gSG9uZG8nOiAnQ1JIJywgJ1BvcnQgSXNhYmVsJzogJ0NQSScgfQogICAgfSwKICAgICdUWHxT' +
  'VEFSUic6IHsKICAgICAgbGFiZWw6ICdTdGFyciBDQUQgcGFyY2VscycsIGNsZXJrOiAnc3RhcnInLAogICAgICBxOiAnaHR0cHM6' +
  'Ly91dGlsaXR5LmFyY2dpcy5jb20vdXNyc3Zjcy9zZXJ2ZXJzL2ZmMDVhZjQyOTM0NzRiNDVhYmYzOTA3NTI1MGVmZTc4L3Jlc3Qv' +
  'c2VydmljZXMvU3RhcnJDQURXZWJTZXJ2aWNlL0ZlYXR1cmVTZXJ2ZXIvMC9xdWVyeScsCiAgICAgIGY6IHsgYWRkclBhcnRzOiBb' +
  'J3NpdHVzX251bScsICdzaXR1c19zdHJlZXRfcHJlZngnLCAnc2l0dXNfc3RyZWV0JywgJ3NpdHVzX3N0cmVldF9zdWZpeCddLAog' +
  'ICAgICAgICAgIGFkZHI6ICdzaXR1c19zdHJlZXQnLCBjaXR5OiAnc2l0dXNfY2l0eScsIHppcDogJ3NpdHVzX3ppcCcsCiAgICAg' +
  'ICAgICAgb3duZXI6ICdmaWxlX2FzX25hbWUnLCBtYWlsOiAnYWRkcl9saW5lMScsIG1haWxjaXR5OiAnYWRkcl9jaXR5JywKICAg' +
  'ICAgICAgICBtYWlsc3RhdGU6ICdhZGRyX3N0YXRlJywgbWFpbHppcDogJ3ppcCcsIGNhZDogJ21hcmtldCcsCiAgICAgICAgICAg' +
  'cGlkOiAncHJvcF9pZCcsIGdlbzogJ2dlb19pZCcsIHVuaXQ6ICdjaXR5JywgbGVnYWw6ICdsZWdhbF9kZXNjJywKICAgICAgICAg' +
  'ICBkZWVkOiB7IGRhdGU6ICdEZWVkX0RhdGUnLCB2b2w6ICdWb2x1bWUnLCBwYWdlOiAnUGFnZScsIG51bTogJ051bWJlcicgfSB9' +
  'LAogICAgICBjaXRpZXM6IHsgJ1JpbyBHcmFuZGUgQ2l0eSc6ICdSSU8gR1JBTkRFIENJVFknLCAnUm9tYSc6ICdST01BJywgJ0xh' +
  'IEdydWxsYSc6ICdMQSBHUlVMTEEnLAogICAgICAgICAgICAgICAgJ0VzY29iYXJlcyc6ICdFU0NPQkFSRVMnIH0sCiAgICAgIGNp' +
  'dHlJc1RleHQ6IHRydWUsCiAgICAgIG5vdGU6ICJTdGFycidzIHJvbGwgcHVibGlzaGVzIG5vIGJ1aWxkaW5nIHNxdWFyZSBmb290' +
  'YWdlIG9yIHllYXIgYnVpbHQuIgogICAgfQogIH07Cn0pKCk7Cgpjb25zdCBzcWxFc2MgPSB2ID0+IFN0cmluZyh2KS5yZXBsYWNl' +
  'KC8nL2csICInJyIpOwpjb25zdCBueiA9IHYgPT4geyBjb25zdCBuID0gcGFyc2VGbG9hdCh2KTsgcmV0dXJuIGlzRmluaXRlKG4p' +
  'ID8gbiA6IDA7IH07CmNvbnN0IHRpdGxlQ2FzZSA9IHYgPT4gU3RyaW5nKHYgPT0gbnVsbCA/ICcnIDogdikudG9Mb3dlckNhc2Uo' +
  'KQogIC5yZXBsYWNlKC9cYihbYS16XSkvZywgbSA9PiBtLnRvVXBwZXJDYXNlKCkpCiAgLnJlcGxhY2UoL1xiKFR4fElpfElpaXxJ' +
  'dnxMbGN8THB8SW5jfFBvKVxiL2csIG0gPT4gbS50b1VwcGVyQ2FzZSgpKS50cmltKCk7CgpmdW5jdGlvbiBzcGxpdFNpdHVzKHYp' +
  'IHsKICBjb25zdCBzID0gU3RyaW5nKHYgPT0gbnVsbCA/ICcnIDogdikudHJpbSgpOwogIGNvbnN0IG0gPSBzLm1hdGNoKC9eKC4q' +
  'PyksXHMqKFteLF0qKSxccypbQS1aXXsyfVxiLyk7CiAgaWYgKG0pIHJldHVybiB7IGFkZHI6IG1bMV0udHJpbSgpLCBjaXR5OiBt' +
  'WzJdLnRyaW0oKSB9OwogIHJldHVybiB7IGFkZHI6IHMucmVwbGFjZSgvLFxzKlRYXHMqJC9pLCAnJykudHJpbSgpLCBjaXR5OiAn' +
  'JyB9Owp9CgovKiBBIHN0cmluZ2lmaWVkIG9iamVjdCBpbiBvdXRGaWVsZHMgbWFrZXMgQXJjR0lTIHJlamVjdCB0aGUgd2hvbGUg' +
  'cXVlcnksIHNvCiAgIHRoZSBtYXAgaXMgZmxhdHRlbmVkIGNhcmVmdWxseTogc3RyaW5ncyBwYXNzLCBhcnJheXMgc3ByZWFkLCB0' +
  'aGUgbmVzdGVkIGRlZWQKICAgb2JqZWN0IGNvbnRyaWJ1dGVzIGl0cyB2YWx1ZXMsIGFueXRoaW5nIGVsc2UgaXMgZHJvcHBlZC4g' +
  'Ki8KZnVuY3Rpb24gZmllbGRMaXN0KEcpIHsKICBjb25zdCBvdXQgPSBbXTsKICBmb3IgKGNvbnN0IGsgaW4gRykgewogICAgY29u' +
  'c3QgdiA9IEdba107CiAgICBpZiAoIXYpIGNvbnRpbnVlOwogICAgaWYgKHR5cGVvZiB2ID09PSAnc3RyaW5nJykgeyBvdXQucHVz' +
  'aCh2KTsgY29udGludWU7IH0KICAgIGlmIChBcnJheS5pc0FycmF5KHYpKSB7IHYuZm9yRWFjaCh4ID0+IHsgaWYgKHR5cGVvZiB4' +
  'ID09PSAnc3RyaW5nJyAmJiB4KSBvdXQucHVzaCh4KTsgfSk7IGNvbnRpbnVlOyB9CiAgICBpZiAodHlwZW9mIHYgPT09ICdvYmpl' +
  'Y3QnKSB7IGZvciAoY29uc3Qga2sgaW4gdikgaWYgKHR5cGVvZiB2W2trXSA9PT0gJ3N0cmluZycgJiYgdltra10pIG91dC5wdXNo' +
  'KHZba2tdKTsgfQogIH0KICByZXR1cm4gb3V0LmZpbHRlcigoeCwgaSkgPT4gb3V0LmluZGV4T2YoeCkgPT09IGkpOwp9CgovLyBD' +
  'b3VudGllcyBzdG9yZSB0aGUgZGVlZCBkYXRlIHRocmVlIHdheXM6IElTTyBzdHJpbmcsIFVTIHN0cmluZywgZXBvY2ggbXMuCmZ1' +
  'bmN0aW9uIGRlZWREYXRlKHYpIHsKICBpZiAodiA9PSBudWxsIHx8IHYgPT09ICcnKSByZXR1cm4gJyc7CiAgY29uc3QgbiA9IE51' +
  'bWJlcih2KTsKICBpZiAoaXNGaW5pdGUobikgJiYgbiA+IDEwMDAwMDAwMDAwKSB7CiAgICBjb25zdCBkID0gbmV3IERhdGUobik7' +
  'CiAgICByZXR1cm4gaXNGaW5pdGUoZC5nZXRUaW1lKCkpID8gZC50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKSA6ICcnOwogIH0K' +
  'ICBjb25zdCBzID0gU3RyaW5nKHYpLnRyaW0oKTsKICBsZXQgbSA9IHMubWF0Y2goL14oXGR7NH0pLShcZHsyfSktKFxkezJ9KS8p' +
  'OwogIGlmIChtKSByZXR1cm4gbVswXTsKICBtID0gcy5tYXRjaCgvXihcZHsxLDJ9KVwvKFxkezEsMn0pXC8oXGR7NH0pLyk7CiAg' +
  'aWYgKG0pIHJldHVybiBtWzNdICsgJy0nICsgKCcwJyArIG1bMV0pLnNsaWNlKC0yKSArICctJyArICgnMCcgKyBtWzJdKS5zbGlj' +
  'ZSgtMik7CiAgcmV0dXJuIHMuc2xpY2UoMCwgMTApOwp9CmZ1bmN0aW9uIGRlZWRPZihHLCBhKSB7CiAgY29uc3QgZCA9IEcgJiYg' +
  'Ry5kZWVkOwogIGlmICghZCkgcmV0dXJuIG51bGw7CiAgY29uc3QgZyA9IGsgPT4gKGRba10gPyBTdHJpbmcoYVtkW2tdXSA9PSBu' +
  'dWxsID8gJycgOiBhW2Rba11dKS50cmltKCkgOiAnJyk7CiAgY29uc3QgbyA9IHsgZGF0ZTogZGVlZERhdGUoZC5kYXRlID8gYVtk' +
  'LmRhdGVdIDogJycpLCByZWM6IGRlZWREYXRlKGQucmVjID8gYVtkLnJlY10gOiAnJyksCiAgICAgICAgICAgICAgdHlwZTogZygn' +
  'dHlwZScpLCB2b2w6IGcoJ3ZvbCcpLCBwYWdlOiBnKCdwYWdlJyksIG51bTogZygnbnVtJykgfTsKICByZXR1cm4gKG8uZGF0ZSB8' +
  'fCBvLnJlYyB8fCBvLm51bSB8fCBvLnZvbCkgPyBvIDogbnVsbDsKfQoKLyogUm9sbHMgZmlsZSBvd25lcnMgbGFzdC1uYW1lLWZp' +
  'cnN0IGFuZCBib2x0IG9uIGV2ZXJ5dGhpbmcgZnJvbSBhIHNwb3VzZSB0byBhbgogICBlc3RhdGU6ICJNQURFUk8gSk9SR0UgJiBM' +
  'SURJQSIsICJHQVJaQSBNQVJJQSBFVFVYIi4gU2VhcmNoaW5nIHRoYXQgd2hvbGUKICAgc3RyaW5nIGZpbmRzIGV4YWN0bHkgdGhl' +
  'IG9uZSBwYXJjZWwgeW91IHN0YXJ0ZWQgZnJvbSwgc28gaXQgaXMgY3V0IGJhY2sgdG8KICAgdGhlIHBhcnQgdGhhdCBpZGVudGlm' +
  'aWVzIHRoZSBmYW1pbHkuICovCmNvbnN0IE9XTkpVTksgPSAvXihFVEFMfEVUfEFMfEVUVVh8RVRWSVJ8VVh8SlJ8U1J8SUl8SUlJ' +
  'fElWfFRSVVNURUV8VFJ8VFJVU1R8RVNUfEVTVEFURXxPRnxUSEV8TElGRXxFU1RBVEVTPykkLzsKZnVuY3Rpb24gb3duZXJRdWVy' +
  'eShuYW1lLCB0b2tlbnMpIHsKICBjb25zdCB0ID0gU3RyaW5nKG5hbWUgfHwgJycpLnRvVXBwZXJDYXNlKCkKICAgIC5yZXBsYWNl' +
  'KC8mLiokLywgJycpCiAgICAucmVwbGFjZSgvW15BLVowLTkgXS9nLCAnICcpCiAgICAuc3BsaXQoL1xzKy8pLmZpbHRlcihCb29s' +
  'ZWFuKQogICAgLmZpbHRlcih4ID0+ICFPV05KVU5LLnRlc3QoeCkpOwogIHJldHVybiB0LnNsaWNlKDAsIHRva2VucyB8fCAyKS5q' +
  'b2luKCcgJyk7Cn0KCi8qIEV2ZXJ5IGNvdW50eSBzcGVsbHMgdGhlIHN1ZmZpeCBkaWZmZXJlbnRseSwgc28gaXQgaXMgZHJvcHBl' +
  'ZCBiZWZvcmUgc2VhcmNoaW5nCiAgIGFuZCB0aGUgcmVzdCBtYXRjaGVkIGxvb3NlbHkuICovCmNvbnN0IFNVRkZJWEVTID0gL14o' +
  'U1R8U1RSRUVUfEFWRXxBVkVOVUV8UkR8Uk9BRHxEUnxEUklWRXxMTnxMQU5FfEJMVkR8Qk9VTEVWQVJEfENUfENPVVJUfENJUnxD' +
  'SVJDTEV8UEx8UExBQ0V8SFdZfEhJR0hXQVl8VFJMfFRSQUlMfFdBWXxQS1dZfFBBUktXQVl8QVBUfFVOSVR8U1RFKSQvOwpmdW5j' +
  'dGlvbiBhZGRyVG9rZW5zKHEpIHsKICBjb25zdCB0ID0gU3RyaW5nKHEgfHwgJycpLnRvVXBwZXJDYXNlKCkucmVwbGFjZSgvW15B' +
  'LVowLTkgXS9nLCAnICcpLnNwbGl0KC9ccysvKS5maWx0ZXIoQm9vbGVhbik7CiAgY29uc3Qga2VlcCA9IHQuZmlsdGVyKCh2LCBp' +
  'KSA9PiBpID09PSAwIHx8ICFTVUZGSVhFUy50ZXN0KHYpKTsKICByZXR1cm4ga2VlcC5sZW5ndGggPyBrZWVwIDogdDsKfQoKY29u' +
  'c3QgY2xlcmtTZWFyY2ggPSAoa2V5LCBxKSA9PiB7CiAgY29uc3Qgc3JjID0gQ0FEW2tleV07CiAgaWYgKCFzcmMgfHwgIXNyYy5j' +
  'bGVyaykgcmV0dXJuICcnOwogIHJldHVybiAnaHR0cHM6Ly8nICsgc3JjLmNsZXJrICsgJy50eC5wdWJsaWNzZWFyY2gudXMvcmVz' +
  'dWx0cz9fY291cnRJZD0mZGVwYXJ0bWVudD1SUCcgKwogICAgICAgICAnJmxpbWl0PTUwJm9mZnNldD0wJnE9JyArIGVuY29kZVVS' +
  'SUNvbXBvbmVudChTdHJpbmcocSB8fCAnJykudHJpbSgpKSArCiAgICAgICAgICcmc2VhcmNoT2NyVGV4dD1mYWxzZSZzZWFyY2hU' +
  'eXBlPXF1aWNrU2VhcmNoJzsKfTsKCmFzeW5jIGZ1bmN0aW9uIGNhZEpTT04odSkgewogIGNvbnN0IHIgPSBhd2FpdCBmZXRjaCh1' +
  'LCB7IG1vZGU6ICdjb3JzJyB9KTsKICBpZiAoIXIub2spIHRocm93IG5ldyBFcnJvcignSFRUUCAnICsgci5zdGF0dXMpOwogIGNv' +
  'bnN0IGogPSBhd2FpdCByLmpzb24oKTsKICBpZiAoai5lcnJvcikgdGhyb3cgbmV3IEVycm9yKGouZXJyb3IubWVzc2FnZSB8fCAo' +
  'J0NvdW50eSBzZXJ2ZXIgZXJyb3IgJyArIGouZXJyb3IuY29kZSkpOwogIHJldHVybiBqOwp9Cgphc3luYyBmdW5jdGlvbiBjYWRM' +
  'b29rdXAoa2V5LCBtb2RlLCByYXcsIGNpdHksIG92ZXJyaWRlKSB7CiAgY29uc3Qgc3JjID0gb3ZlcnJpZGUgfHwgQ0FEW2tleV07' +
  'CiAgY29uc3QgRyA9IHNyYy5mIHx8IHt9LCBHMiA9IHNyYy5mMiB8fCB7fTsKICBjb25zdCB3ID0gW107CiAgaWYgKG1vZGUgPT09' +
  'ICdhZGRyJykgewogICAgaWYgKCFHLmFkZHIpIHRocm93IG5ldyBFcnJvcigiVGhhdCBjb3VudHkncyByb2xsIGhhcyBubyBhZGRy' +
  'ZXNzIGNvbHVtbi4iKTsKICAgIHcucHVzaCgnVVBQRVIoJyArIEcuYWRkciArICIpIExJS0UgJyUiICsgc3FsRXNjKGFkZHJUb2tl' +
  'bnMocmF3KS5qb2luKCclJykpICsgIiUnIik7CiAgfSBlbHNlIHsKICAgIGlmICghRy5vd25lcikgdGhyb3cgbmV3IEVycm9yKCJU' +
  'aGF0IGNvdW50eSdzIHJvbGwgaGFzIG5vIG93bmVyIGNvbHVtbi4iKTsKICAgIHcucHVzaCgnVVBQRVIoJyArIEcub3duZXIgKyAi' +
  'KSBMSUtFICclIiArIHNxbEVzYyhyYXcudG9VcHBlckNhc2UoKSkgKyAiJSciKTsKICB9CiAgaWYgKGNpdHkpIHsKICAgIGNvbnN0' +
  'IGNvZGUgPSAoQ0FEW2tleV0uY2l0aWVzIHx8IHt9KVtjaXR5XTsKICAgIGlmIChjb2RlICYmIEcudW5pdCkgewogICAgICB3LnB1' +
  'c2goQ0FEW2tleV0uY2l0eUlzVGV4dAogICAgICAgID8gJ1VQUEVSKCcgKyBHLnVuaXQgKyAiKSBMSUtFICclIiArIHNxbEVzYyhj' +
  'b2RlLnRvVXBwZXJDYXNlKCkpICsgIiUnIgogICAgICAgIDogRy51bml0ICsgIiBMSUtFICclIiArIGNvZGUgKyAiJSciKTsKICAg' +
  'IH0gZWxzZSBpZiAoRy5jaXR5KSB7CiAgICAgIHcucHVzaCgnVVBQRVIoJyArIEcuY2l0eSArICIpIExJS0UgJyUiICsgc3FsRXNj' +
  'KGNpdHkudG9VcHBlckNhc2UoKSkgKyAiJSciKTsKICAgIH0KICB9CiAgY29uc3Qgb3V0RiA9IGZpZWxkTGlzdChHKTsKICBmb3Ig' +
  'KGNvbnN0IGsgaW4gRzIpIGlmIChHMltrXSkgb3V0Ri5wdXNoKEcyW2tdKTsKCiAgY29uc3QgcXAgPSBuZXcgVVJMU2VhcmNoUGFy' +
  'YW1zKHsKICAgIHdoZXJlOiB3LmpvaW4oJyBBTkQgJyksIG91dEZpZWxkczogb3V0Ri5qb2luKCcsJyksIHJldHVybkdlb21ldHJ5' +
  'OiAnZmFsc2UnLAogICAgcmVzdWx0UmVjb3JkQ291bnQ6ICc2MCcsIGY6ICdqc29uJywgcmV0dXJuQ2VudHJvaWQ6ICd0cnVlJywg' +
  'b3V0U1I6ICc0MzI2JwogIH0pOwogIGNvbnN0IHIgPSBhd2FpdCBjYWRKU09OKHNyYy5xICsgJz8nICsgcXApOwogIHJldHVybiAo' +
  'ci5mZWF0dXJlcyB8fCBbXSkubWFwKGZ0ID0+IHsKICAgIGNvbnN0IGEgPSBmdC5hdHRyaWJ1dGVzIHx8IHt9LCBjdCA9IGZ0LmNl' +
  'bnRyb2lkIHx8IHt9OwogICAgbGV0IHNwID0gc3BsaXRTaXR1cyhhW0cuYWRkcl0pOwogICAgaWYgKEcuYWRkclBhcnRzKSB7CiAg' +
  'ICAgIGNvbnN0IGJpdHMgPSBHLmFkZHJQYXJ0cy5tYXAoa2sgPT4gU3RyaW5nKGFba2tdID09IG51bGwgPyAnJyA6IGFba2tdKS50' +
  'cmltKCkpCiAgICAgICAgLmZpbHRlcih4ID0+IHggJiYgeCAhPT0gJzAnKTsKICAgICAgaWYgKGJpdHMubGVuZ3RoKSBzcCA9IHsg' +
  'YWRkcjogYml0cy5qb2luKCcgJykucmVwbGFjZSgvXHMrL2csICcgJyksIGNpdHk6ICcnIH07CiAgICB9CiAgICBjb25zdCBtY2l0' +
  'eSA9IEcubWFpbGNpdHkgPyBTdHJpbmcoYVtHLm1haWxjaXR5XSB8fCAnJykudHJpbSgpIDogJyc7CiAgICBjb25zdCBwY2l0eSA9' +
  'IChHLmNpdHkgJiYgYVtHLmNpdHldKSA/IFN0cmluZyhhW0cuY2l0eV0pLnRyaW0oKSA6IHNwLmNpdHk7CiAgICBjb25zdCBleCA9' +
  'IEcuZXhlbXB0ID8gU3RyaW5nKGFbRy5leGVtcHRdIHx8ICcnKS50cmltKCkgOiAnJzsKICAgIGNvbnN0IHBpZCA9IEcucGlkID8g' +
  'YVtHLnBpZF0gOiAnJzsKICAgIHJldHVybiB7CiAgICAgIGxhdDogaXNGaW5pdGUoY3QueSkgPyBjdC55IDogbnVsbCwgbG9uOiBp' +
  'c0Zpbml0ZShjdC54KSA/IGN0LnggOiBudWxsLAogICAgICBhZGRyZXNzOiB0aXRsZUNhc2Uoc3AuYWRkcikgfHwgJ+KAlCcsIGNp' +
  'dHk6IHRpdGxlQ2FzZShwY2l0eSkgfHwgY2l0eSwKICAgICAgemlwOiBHLnppcCA/IFN0cmluZyhhW0cuemlwXSB8fCAnJykuc2xp' +
  'Y2UoMCwgNSkgOiAnJywKICAgICAgc3FmdDogRy5zcWZ0ID8gbnooYVtHLnNxZnRdKSA6IDAsIHllYXI6IEcueWVhciA/IG56KGFb' +
  'Ry55ZWFyXSkgOiAwLAogICAgICBjbHM6IEcuY2xzID8gU3RyaW5nKGFbRy5jbHNdIHx8ICcnKS50cmltKCkgOiAnJywKICAgICAg' +
  'b3duZXI6IHRpdGxlQ2FzZShhW0cub3duZXJdIHx8ICcnKSwKICAgICAgbWFpbDogdGl0bGVDYXNlKFthW0cubWFpbF0sIG1jaXR5' +
  'LCBHLm1haWxzdGF0ZSA/IGFbRy5tYWlsc3RhdGVdIDogJycsCiAgICAgICAgICAgICAgICAgICAgICAgRy5tYWlsemlwID8gYVtH' +
  'Lm1haWx6aXBdIDogJyddLmZpbHRlcihCb29sZWFuKS5qb2luKCcsICcpKSwKICAgICAgbWFpbGNpdHk6IHRpdGxlQ2FzZShtY2l0' +
  'eSksCiAgICAgIGV4ZW1wdDogZXgsIGhvbWVzdGVhZDogL1xiSFNcYi9pLnRlc3QoZXgpLAogICAgICBvdXRvZnRvd246ICEhKG1j' +
  'aXR5ICYmIHBjaXR5ICYmIG1jaXR5LnRvVXBwZXJDYXNlKCkgIT09IHBjaXR5LnRvVXBwZXJDYXNlKCkpLAogICAgICBsZWdhbDog' +
  'Ry5sZWdhbCA/IFN0cmluZyhhW0cubGVnYWxdIHx8ICcnKS50cmltKCkgOiAnJywKICAgICAgZGVlZDogZGVlZE9mKEcsIGEpLAog' +
  'ICAgICBwaWQsIGdlbzogRy5nZW8gPyBhW0cuZ2VvXSA6ICcnLCBsaW5rOiAoQ0FEW2tleV0ubGluayAmJiBwaWQpID8gQ0FEW2tl' +
  'eV0ubGluayhwaWQpIDogJycKICAgIH07CiAgfSk7Cn0KCmxldCBQUk9QID0geyBrZXk6ICdUWHxISURBTEdPJywgbW9kZTogJ2Fk' +
  'ZHInLCByZXN1bHRzOiBbXSwgam9iSWQ6IG51bGwgfTsKCmZ1bmN0aW9uIHByb3BlcnR5VmlldygpIHsKICBjb25zdCBzcmMgPSBD' +
  'QURbUFJPUC5rZXldOwogIGNvbnN0IGNpdHlPcHRzID0gWyc8b3B0aW9uIHZhbHVlPSIiPkFueSBjaXR5PC9vcHRpb24+J10KICAg' +
  'IC5jb25jYXQoT2JqZWN0LmtleXMoc3JjLmNpdGllcyB8fCB7fSkubWFwKGMgPT4gYDxvcHRpb24+JHtlc2MoYyl9PC9vcHRpb24+' +
  'YCkpLmpvaW4oJycpOwoKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5Qcm9wZXJ0eSByZWNv' +
  'cmRzPC9oMT4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGRpdiBjbGFzcz0icm93IiBpZD0icHJvcE1vZGUiIHN0eWxl' +
  'PSJnYXA6NnB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gJHtQUk9QLm1vZGUgPT09ICdhZGRyJyA/ICcnIDogJ3NlYyAn' +
  'fXNtIiBkYXRhLW09ImFkZHIiPkJ5IGFkZHJlc3M8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gJHtQUk9QLm1v' +
  'ZGUgPT09ICdvd25lcicgPyAnJyA6ICdzZWMgJ31zbSIgZGF0YS1tPSJvd25lciI+Qnkgb3duZXI8L2J1dHRvbj4KICAgICAgPC9k' +
  'aXY+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxkaXYgY2xhc3M9' +
  'ImZpZWxkIj48bGFiZWw+Q291bnR5PC9sYWJlbD48c2VsZWN0IGlkPSJwcm9wQ291bnR5Ij4KICAgICAgICAgICR7T2JqZWN0Lmtl' +
  'eXMoQ0FEKS5zb3J0KCkubWFwKGsgPT4gYDxvcHRpb24gdmFsdWU9IiR7ZXNjKGspfSIke2sgPT09IFBST1Aua2V5ID8gJyBzZWxl' +
  'Y3RlZCcgOiAnJ30+JHsKICAgICAgICAgICAgZXNjKGsuc3BsaXQoJ3wnKVsxXS5yZXBsYWNlKC9cYihcdykoXHcqKS9nLCAobSwg' +
  'YSwgYikgPT4gYSArIGIudG9Mb3dlckNhc2UoKSkpfSBDb3VudHksIFRYPC9vcHRpb24+YCkuam9pbignJyl9CiAgICAgICAgPC9z' +
  'ZWxlY3Q+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5DaXR5IDxzcGFuIGNsYXNzPSJzdWIiPm9wdGlv' +
  'bmFsPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICA8c2VsZWN0IGlkPSJwcm9wQ2l0eSI+JHtjaXR5T3B0c308L3NlbGVjdD48L2Rp' +
  'dj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWwgaWQ9InByb3BMYWJlbCI+JHtQUk9QLm1vZGUg' +
  'PT09ICdhZGRyJyA/ICdBZGRyZXNzJyA6ICdPd25lciBuYW1lJ308L2xhYmVsPgogICAgICAgIDxpbnB1dCBpZD0icHJvcFEiIHBs' +
  'YWNlaG9sZGVyPSIke1BST1AubW9kZSA9PT0gJ2FkZHInID8gJzE4MDYgQXNoIEF2ZScgOiAnR2FyemEnfSI+PC9kaXY+CiAgICAg' +
  'IDxkaXYgY2xhc3M9InJvdyI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0icHJvcEdvIj5TZWFyY2g8L2J1dHRvbj4K' +
  'ICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBpZD0icHJvcENsZWFyIj5DbGVhcjwvYnV0dG9uPgogICAgICA8L2Rpdj4K' +
  'ICAgICAgPHAgY2xhc3M9ImhpbnQiIGlkPSJwcm9wSGludCI+PC9wPgogICAgPC9kaXY+CgogICAgPGRpdiBpZD0icHJvcFN0YXR1' +
  'cyI+PC9kaXY+CiAgICA8ZGl2IGlkPSJwcm9wT3V0Ij48L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPHAgY2xh' +
  'c3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MCI+QSBtYWlsaW5nIGFkZHJlc3MgZnJvbSB0aGUgYXBwcmFpc2FsIGRpc3RyaWN0IGlz' +
  'IGEgbGVhZCwgbm90IHByb29mIG9mCiAgICAgICAgcmVzaWRlbmNlIOKAlCBwbGVudHkgb2Ygb3duZXJzIGhhdmUgcG9zdCBnb2lu' +
  'ZyB0byBhbiBhZ2VudCwgYSByZWxhdGl2ZSwgb3IgYW5vdGhlciBzdGF0ZS4gVHJlYXQgaXQgYXMgYQogICAgICAgIHBsYWNlIHRv' +
  'IGF0dGVtcHQsIGFuZCByZWNvcmQgd2hhdCB5b3UgYWN0dWFsbHkgZmluZCBpbiB0aGUgYXR0ZW1wdCBub3Rlcy48L3A+CiAgICA8' +
  'L2Rpdj5gKTsKICBiaW5kU2hlbGwoKTsKCiAgY29uc3QgaGludCA9ICgpID0+IHsKICAgIGNvbnN0IHMgPSBDQURbUFJPUC5rZXld' +
  'OwogICAgJCgnI3Byb3BIaW50JykuaW5uZXJIVE1MID0gKFBST1AubW9kZSA9PT0gJ2FkZHInCiAgICAgID8gJ1N0cmVldCBudW1i' +
  'ZXIgYW5kIG5hbWUgaXMgZW5vdWdoIOKAlCB0aGUgc3VmZml4IGlzIGRyb3BwZWQgYmVmb3JlIHNlYXJjaGluZywgYmVjYXVzZSBl' +
  'dmVyeSBjb3VudHkgc3BlbGxzIGl0IGRpZmZlcmVudGx5LicKICAgICAgOiAnQSBzdXJuYW1lIGFsb25lIHdvcmtzIGFuZCBmaW5k' +
  'cyBldmVyeSBwYXJjZWwgdGhhdCBvd25lciBob2xkcyBpbiB0aGUgY291bnR5LiBSZWNvcmRzIGFyZSBmaWxlZCBsYXN0IG5hbWUg' +
  'Zmlyc3QsIHNvIDxpPkdhcnphPC9pPiBiZWF0cyA8aT5NYXJpYSBHYXJ6YTwvaT4uJykKICAgICAgKyAocy5ub3RlID8gJyA8Yj4n' +
  'ICsgZXNjKHMubm90ZSkgKyAnPC9iPicgOiAnJyk7CiAgfTsKICBoaW50KCk7CgogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwo' +
  'JyNwcm9wTW9kZSBbZGF0YS1tXScpLmZvckVhY2goYiA9PiBiLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBQUk9QLm1vZGUgPSBiLmRh' +
  'dGFzZXQubTsgcHJvcGVydHlWaWV3KCk7CiAgfSk7CiAgJCgnI3Byb3BDb3VudHknKS5vbmNoYW5nZSA9ICgpID0+IHsgUFJPUC5r' +
  'ZXkgPSAkKCcjcHJvcENvdW50eScpLnZhbHVlOyBwcm9wZXJ0eVZpZXcoKTsgfTsKICAkKCcjcHJvcENsZWFyJykub25jbGljayA9' +
  'ICgpID0+IHsgUFJPUC5yZXN1bHRzID0gW107ICQoJyNwcm9wT3V0JykuaW5uZXJIVE1MID0gJyc7ICQoJyNwcm9wU3RhdHVzJyku' +
  'aW5uZXJIVE1MID0gJyc7ICQoJyNwcm9wUScpLnZhbHVlID0gJyc7IH07CiAgJCgnI3Byb3BRJykub25rZXlkb3duID0gZSA9PiB7' +
  'IGlmIChlLmtleSA9PT0gJ0VudGVyJykgeyBlLnByZXZlbnREZWZhdWx0KCk7ICQoJyNwcm9wR28nKS5jbGljaygpOyB9IH07CiAg' +
  'JCgnI3Byb3BHbycpLm9uY2xpY2sgPSAoKSA9PiBydW5Qcm9wZXJ0eVNlYXJjaCgkKCcjcHJvcFEnKS52YWx1ZS50cmltKCksICQo' +
  'JyNwcm9wQ2l0eScpLnZhbHVlKTsKICBpZiAoUFJPUC5yZXN1bHRzLmxlbmd0aCkgZHJhd1Byb3BlcnR5KCk7Cn0KCmFzeW5jIGZ1' +
  'bmN0aW9uIHJ1blByb3BlcnR5U2VhcmNoKHJhdywgY2l0eSkgewogIGlmICghcmF3KSByZXR1cm4gdG9hc3QoJ1R5cGUgc29tZXRo' +
  'aW5nIHRvIGxvb2sgdXAnLCB0cnVlKTsKICBjb25zdCBzdGF0ID0gJCgnI3Byb3BTdGF0dXMnKTsKICBjb25zdCBzcmMgPSBDQURb' +
  'UFJPUC5rZXldOwogIHN0YXQuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJt' +
  'YXJnaW46MCI+QXNraW5nICR7ZXNjKHNyYy5sYWJlbCl94oCmPC9kaXY+PC9kaXY+YDsKICAkKCcjcHJvcE91dCcpLmlubmVySFRN' +
  'TCA9ICcnOwogIHRyeSB7CiAgICBsZXQgcm93czsKICAgIHRyeSB7CiAgICAgIHJvd3MgPSBhd2FpdCBjYWRMb29rdXAoUFJPUC5r' +
  'ZXksIFBST1AubW9kZSwgcmF3LCBjaXR5KTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgLy8gQ2FtZXJvbiBwdWJsaXNoZXMgdGhl' +
  'IHNhbWUgcm9sbCB0d2ljZTsgaWYgdGhlIGZpcnN0IGlzIGRvd24sIHRyeSB0aGUgbWlycm9yLgogICAgICBpZiAoIXNyYy5hbHQp' +
  'IHRocm93IGU7CiAgICAgIHJvd3MgPSBhd2FpdCBjYWRMb29rdXAoUFJPUC5rZXksIFBST1AubW9kZSwgcmF3LCBjaXR5LCBzcmMu' +
  'YWx0KTsKICAgIH0KICAgIFBST1AucmVzdWx0cyA9IHJvd3M7CiAgICBzdGF0LmlubmVySFRNTCA9IHJvd3MubGVuZ3RoCiAgICAg' +
  'ID8gYDxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MCI+JHtyb3dzLmxlbmd0aH0gcmVj' +
  'b3JkJHtyb3dzLmxlbmd0aCA9PT0gMSA/ICcnIDogJ3MnfSBmcm9tICR7ZXNjKHNyYy5sYWJlbCl9PC9kaXY+PC9kaXY+YAogICAg' +
  'ICA6IGA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjAiPk5vdGhpbmcgbWF0Y2hlZCBp' +
  'biAke2VzYyhzcmMubGFiZWwpfS4gVHJ5IGZld2VyIHdvcmRzLCBvciBkcm9wIHRoZSBjaXR5LjwvZGl2PjwvZGl2PmA7CiAgICBk' +
  'cmF3UHJvcGVydHkoKTsKICB9IGNhdGNoIChlKSB7CiAgICBQUk9QLnJlc3VsdHMgPSBbXTsKICAgIHN0YXQuaW5uZXJIVE1MID0g' +
  'YDxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MDtjb2xvcjp2YXIoLS1iYWQpIj5UaGUg' +
  'Y291bnR5IGRpZCBub3QgYW5zd2VyOiAke2VzYyhlLm1lc3NhZ2UpfTwvZGl2PjwvZGl2PmA7CiAgICAkKCcjcHJvcE91dCcpLmlu' +
  'bmVySFRNTCA9ICcnOwogIH0KfQoKZnVuY3Rpb24gZHJhd1Byb3BlcnR5KCkgewogIGNvbnN0IG91dCA9ICQoJyNwcm9wT3V0Jyk7' +
  'CiAgaWYgKCFvdXQpIHJldHVybjsKICBvdXQuaW5uZXJIVE1MID0gUFJPUC5yZXN1bHRzLm1hcCgociwgaSkgPT4gewogICAgY29u' +
  'c3QgTCA9IChrLCB2KSA9PiBgPHRyPjx0aCBzdHlsZT0id2lkdGg6MzglIj4ke2t9PC90aD48dGQ+JHt2fTwvdGQ+PC90cj5gOwog' +
  'ICAgY29uc3QgZCA9IHIuZGVlZDsKICAgIGxldCBkZWVkTGluZSA9ICcnOwogICAgaWYgKGQpIHsKICAgICAgY29uc3QgYml0cyA9' +
  'IFtdOwogICAgICBpZiAoZC5kYXRlKSBiaXRzLnB1c2goZXNjKGQuZGF0ZSkpOwogICAgICBpZiAoZC50eXBlKSBiaXRzLnB1c2go' +
  'ZXNjKGQudHlwZSkpOwogICAgICBpZiAoZC5udW0pIGJpdHMucHVzaCgnaW5zdC4gJyArIGVzYyhkLm51bSkpOwogICAgICBpZiAo' +
  'ZC52b2wgJiYgZC5wYWdlKSBiaXRzLnB1c2goJ3ZvbCAnICsgZXNjKGQudm9sKSArICcgcGcgJyArIGVzYyhkLnBhZ2UpKTsKICAg' +
  'ICAgZGVlZExpbmUgPSBiaXRzLmpvaW4oJyDCtyAnKTsKICAgIH0KICAgIGNvbnN0IGZ1bGwgPSBbci5hZGRyZXNzLCBbci5jaXR5' +
  'LCByLnppcF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJyAnKV0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJywgJyk7CiAgICByZXR1cm4g' +
  'YDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+JHtlc2Moci5hZGRyZXNzKX08L2gyPgogICAgICA8ZGl2IGNsYXNzPSJtIiBz' +
  'dHlsZT0iY29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxM3B4Ij4ke2VzYyhbci5jaXR5LCByLnppcF0uZmlsdGVyKEJvb2xl' +
  'YW4pLmpvaW4oJyAnKSl9PC9kaXY+CiAgICAgIDx0YWJsZSBjbGFzcz0idGJsIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4KICAg' +
  'ICAgICAke0woJ093bmVyJywgJzxiPicgKyBlc2Moci5vd25lciB8fCAn4oCUJykgKyAnPC9iPicpfQogICAgICAgICR7ci5tYWls' +
  'ID8gTCgnTWFpbHMgdG8nLCBlc2Moci5tYWlsKSkgOiAnJ30KICAgICAgICAke0woJ0xpdmVzIHRoZXJlPycsIHIuaG9tZXN0ZWFk' +
  'CiAgICAgICAgICAgID8gJzxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS1vayk7Zm9udC13ZWlnaHQ6NjAwIj5Ib21lc3RlYWQgb24g' +
  'ZmlsZSDigJQgb3duZXItb2NjdXBpZWQ8L3NwYW4+JwogICAgICAgICAgICA6ICdObyBob21lc3RlYWQgZXhlbXB0aW9uJyArIChy' +
  'Lm91dG9mdG93biA/ICcgwrcgPGI+bWFpbHMgb3V0IG9mIHRvd248L2I+JyA6ICcnKSl9CiAgICAgICAgJHtyLnllYXIgPyBMKCdC' +
  'dWlsdCcsIHIueWVhcikgOiAnJ30KICAgICAgICAke3Iuc3FmdCA/IEwoJ1NpemUnLCBNYXRoLnJvdW5kKHIuc3FmdCkudG9Mb2Nh' +
  'bGVTdHJpbmcoKSArICcgc3EgZnQnKSA6ICcnfQogICAgICAgICR7ci5sZWdhbCA/IEwoJ0xlZ2FsJywgZXNjKHIubGVnYWwpKSA6' +
  'ICcnfQogICAgICAgICR7ci5nZW8gPyBMKCdHZW9ncmFwaGljIElEJywgZXNjKHIuZ2VvKSkgOiAnJ30KICAgICAgICAke2RlZWRM' +
  'aW5lID8gTCgnTGFzdCBkZWVkJywgZGVlZExpbmUpIDogJyd9CiAgICAgIDwvdGFibGU+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIg' +
  'c3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgZGF0YS1wY29weT0iJHtl' +
  'c2MoZnVsbCl9Ij5Db3B5IGFkZHJlc3M8L2J1dHRvbj4KICAgICAgICAke3IubWFpbCA/IGA8YnV0dG9uIGNsYXNzPSJidG4gc2Vj' +
  'IHNtIiBkYXRhLXBjb3B5PSIke2VzYyhyLm1haWwpfSI+Q29weSBtYWlsaW5nIGFkZHJlc3M8L2J1dHRvbj5gIDogJyd9CiAgICAg' +
  'ICAgJHtyLm93bmVyID8gYDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGRhdGEtcG93bmVyPSIke2VzYyhvd25lclF1ZXJ5KHIu' +
  'b3duZXIpKX0iPk1vcmUgYnkgdGhpcyBvd25lcjwvYnV0dG9uPmAgOiAnJ30KICAgICAgICAke3IubGF0ICE9IG51bGwgPyBgPGEg' +
  'Y2xhc3M9ImJ0biBzZWMgc20iIHRhcmdldD0iX2JsYW5rIgogICAgICAgICAgIGhyZWY9Imh0dHBzOi8vd3d3Lmdvb2dsZS5jb20v' +
  'bWFwcy9zZWFyY2gvP2FwaT0xJnF1ZXJ5PSR7ci5sYXR9LCR7ci5sb259Ij5NYXA8L2E+YCA6ICcnfQogICAgICAgICR7ci5saW5r' +
  'ID8gYDxhIGNsYXNzPSJidG4gc2VjIHNtIiB0YXJnZXQ9Il9ibGFuayIgaHJlZj0iJHtlc2Moci5saW5rKX0iPkNvdW50eSByZWNv' +
  'cmQg4oaXPC9hPmAgOiAnJ30KICAgICAgICAke3Iub3duZXIgPyBgPGEgY2xhc3M9ImJ0biBzZWMgc20iIHRhcmdldD0iX2JsYW5r' +
  'IgogICAgICAgICAgIGhyZWY9IiR7ZXNjKGNsZXJrU2VhcmNoKFBST1Aua2V5LCAoZCAmJiBkLm51bSkgPyBkLm51bSA6IG93bmVy' +
  'UXVlcnkoci5vd25lcikpKX0iPkRlZWRzICZhbXA7IGxpZW5zIOKGlzwvYT5gIDogJyd9CiAgICAgIDwvZGl2PgogICAgPC9kaXY+' +
  'YDsKICB9KS5qb2luKCcnKTsKCiAgb3V0LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBjb3B5XScpLmZvckVhY2goYiA9PiBiLm9u' +
  'Y2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgeyBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dChiLmRhdGFz' +
  'ZXQucGNvcHkpOyB0b2FzdCgnQ29waWVkJyk7IH0KICAgIGNhdGNoIChlKSB7IHRvYXN0KCdDb3B5IGZhaWxlZCDigJQgc2VsZWN0' +
  'IGl0IGJ5IGhhbmQnLCB0cnVlKTsgfQogIH0pOwogIG91dC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1wb3duZXJdJykuZm9yRWFj' +
  'aChiID0+IGIub25jbGljayA9ICgpID0+IHsKICAgIFBST1AubW9kZSA9ICdvd25lcic7CiAgICBwcm9wZXJ0eVZpZXcoKTsKICAg' +
  'ICQoJyNwcm9wUScpLnZhbHVlID0gYi5kYXRhc2V0LnBvd25lcjsKICAgIHJ1blByb3BlcnR5U2VhcmNoKGIuZGF0YXNldC5wb3du' +
  'ZXIsICcnKTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0gY2FzZSBsb29rdXAgLS0gKi8KLyogTm9uZSBvZiB0aGVzZSBwb3J0YWxzIGFjY2VwdCBhIGNhc2UgbnVtYmVyIGluIHRoZSBV' +
  'UkwgLS0gSGlkYWxnbydzIHJ1bnMgb24KICAgc2Vzc2lvbi1iYXNlZCBmb3JtIHBvc3RzLCBDYW1lcm9uJ3Mgc2l0cyBiZWhpbmQg' +
  'YSBKYXZhU2NyaXB0IGdhdGUuIFNvIHRoaXMKICAgY29waWVzIHRoZSBudW1iZXIgdG8gdGhlIGNsaXBib2FyZCBhbmQgb3BlbnMg' +
  'dGhlIHJpZ2h0IHNlYXJjaCBwYWdlLiBObwogICBzY3JhcGluZywgbm90aGluZyB0byBicmVhayB3aGVuIHRoZXkgcmVkZXNpZ24u' +
  'ICovCmNvbnN0IFRYX1BPUlRBTFMgPSBbCiAgeyBuYW1lOiAncmU6U2VhcmNoVFgg4oCUIHN0YXRld2lkZScsIHVybDogJ2h0dHBz' +
  'Oi8vcmVzZWFyY2gudHhjb3VydHMuZ292LycsCiAgICBub3RlOiAnRnJlZSBhY2NvdW50IHJlcXVpcmVkLiBEaXN0cmljdCwgY291' +
  'bnR5IGFuZCBwcm9iYXRlIGNvdXJ0cyBpbiBhbGwgMjU0IGNvdW50aWVzLiAnICsKICAgICAgICAgICdQdWJsaWMgdmlldyBzdGFy' +
  'dHMgYXQgZmlsaW5ncyBmcm9tIDEgTm92IDIwMTguIEp1c3RpY2Utb2YtdGhlLXBlYWNlIGV2aWN0aW9ucyBhcmUgcGF0Y2h5Licg' +
  'fSwKICB7IG5hbWU6ICdIaWRhbGdvIENvdW50eSDigJQgRGlzdHJpY3QgQ2xlcmsgY2FzZSBzZWFyY2gnLCB1cmw6ICdodHRwczov' +
  'L3BhLmNvLmhpZGFsZ28udHgudXMvZGVmYXVsdC5hc3B4JywKICAgIG5vdGU6ICdDaXZpbCBhbmQgY3JpbWluYWwgY2FzZXMuIEZy' +
  'ZWUsIG5vIGxvZ2luLicgfSwKICB7IG5hbWU6ICdDYW1lcm9uIENvdW50eSDigJQgY291cnQgcG9ydGFscycsIHVybDogJ2h0dHBz' +
  'Oi8vd3d3LmNhbWVyb25jb3VudHl0eC5nb3YvY2FtZXJvbi1jb3VudHktcG9ydGFscy8nLAogICAgbm90ZTogJ0luZGV4IHBhZ2Ug' +
  'Zm9yIHRoZSBjb3VudHlcJ3MgZGlzdHJpY3QgYW5kIGNvdW50eSBjbGVyayBzZWFyY2hlcy4nIH0sCiAgeyBuYW1lOiAnQ2FtZXJv' +
  'biBDb3VudHkg4oCUIERpc3RyaWN0IENsZXJrIHJlY29yZHMnLCB1cmw6ICdodHRwczovL2tvZmlsZXF1aWNrbGlua3MuY29tL2Nh' +
  'bWVyb25kYy8nLAogICAgbm90ZTogJ0Rpc3RyaWN0IENsZXJrIHJlY29yZCBzZWFyY2guJyB9LAogIHsgbmFtZTogJ0hpZGFsZ28g' +
  'Q291bnR5IOKAlCBwcm9wZXJ0eSAvIG9mZmljaWFsIHJlY29yZHMnLCB1cmw6ICdodHRwczovL2hpZGFsZ28udHgucHVibGljc2Vh' +
  'cmNoLnVzLycsCiAgICBub3RlOiAnRGVlZHMsIGxpZW5zIGFuZCBvd25lcnNoaXAgZnJvbSB0aGUgQ291bnR5IENsZXJrIOKAlCBw' +
  'cm9wZXJ0eSwgbm90IGxhd3N1aXRzLiAnICsKICAgICAgICAgICdVc2VmdWwgZm9yIGNvbmZpcm1pbmcgd2hvIGFjdHVhbGx5IG93' +
  'bnMgYW4gYWRkcmVzcy4nIH0KXTsKCmZ1bmN0aW9uIGNhc2VMb29rdXBTaGVldChqb2IpIHsKICBzaGVldCgnTG9vayB1cCAnICsg' +
  'am9iLmNhc2VfbnVtYmVyLCBgCiAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDojZjhmYWZjO2JveC1zaGFk' +
  'b3c6bm9uZTt0ZXh0LWFsaWduOmNlbnRlciI+CiAgICAgIDxkaXYgc3R5bGU9ImZvbnQ6NjAwIDIwcHgvMS4zIG1vbm9zcGFjZTts' +
  'ZXR0ZXItc3BhY2luZzouNXB4Ij4ke2VzYyhqb2IuY2FzZV9udW1iZXIpfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaW50Ij4k' +
  'e2VzYyhqb2IuY291cnQgfHwgJ2NvdXJ0IG5vdCByZWNvcmRlZCcpfTwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc20i' +
  'IGlkPSJjb3B5Q2FzZSIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+Q29weSBjYXNlIG51bWJlcjwvYnV0dG9uPgogICAgPC9kaXY+' +
  'CiAgICA8cCBjbGFzcz0iaGludCI+VGhlc2UgcG9ydGFscyBjYW4ndCBiZSBsaW5rZWQgdG8gZGlyZWN0bHkgd2l0aCBhIGNhc2Ug' +
  'bnVtYmVyLCBzbyB0YXBwaW5nIG9uZSBjb3BpZXMKICAgICAgdGhlIG51bWJlciBhbmQgb3BlbnMgdGhlaXIgc2VhcmNoIHBhZ2Ug' +
  '4oCUIHBhc3RlIGl0IGludG8gdGhlaXIgYm94LjwvcD4KICAgIDxkaXYgY2xhc3M9Imxpc3QiPgogICAgICAke1RYX1BPUlRBTFMu' +
  'bWFwKChwLCBpKSA9PiBgCiAgICAgICAgPGRpdiBjbGFzcz0iaXRlbSIgZGF0YS1wb3J0YWw9IiR7aX0iPgogICAgICAgICAgPGRp' +
  'diBjbGFzcz0idCI+JHtlc2MocC5uYW1lKX08L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9Im0iPiR7ZXNjKHAubm90ZSl9PC9k' +
  'aXY+CiAgICAgICAgPC9kaXY+YCkuam9pbignJyl9CiAgICA8L2Rpdj4KICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2lu' +
  'LXRvcDoxMnB4Ij5Db3VydCByZWNvcmRzIHJhcmVseSBwdWJsaXNoIGEgZGVmZW5kYW50J3Mgc2VydmljZSBhZGRyZXNzIOKAlAog' +
  'ICAgICB0aGF0IG5vcm1hbGx5IG9ubHkgZXhpc3RzIG9uIHRoZSBjbGllbnQncyBwYWNrZXQuPC9wPgogICAgPGJ1dHRvbiBjbGFz' +
  'cz0iYnRuIHNlYyBibG9jayIgc3R5bGU9Im1hcmdpbi10b3A6OHB4IiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNsb3NlPC9idXR0' +
  'b24+YCwgZWwgPT4gewogICAgY29uc3QgY29weSA9IGFzeW5jICgpID0+IHsKICAgICAgdHJ5IHsgYXdhaXQgbmF2aWdhdG9yLmNs' +
  'aXBib2FyZC53cml0ZVRleHQoam9iLmNhc2VfbnVtYmVyKTsgcmV0dXJuIHRydWU7IH0KICAgICAgY2F0Y2ggKGUpIHsgcmV0dXJu' +
  'IGZhbHNlOyB9CiAgICB9OwogICAgZWwucXVlcnlTZWxlY3RvcignI2NvcHlDYXNlJykub25jbGljayA9IGFzeW5jICgpID0+CiAg' +
  'ICAgIHRvYXN0KGF3YWl0IGNvcHkoKSA/ICdDb3BpZWQgJyArIGpvYi5jYXNlX251bWJlciA6ICdDb3B5IGZhaWxlZCDigJQgc2Vs' +
  'ZWN0IGl0IGJ5IGhhbmQnLCBmYWxzZSk7CiAgICBlbC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1wb3J0YWxdJykuZm9yRWFjaChy' +
  'b3cgPT4gcm93Lm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IHAgPSBUWF9QT1JUQUxTWytyb3cuZGF0YXNldC5w' +
  'b3J0YWxdOwogICAgICBjb25zdCBvayA9IGF3YWl0IGNvcHkoKTsKICAgICAgdG9hc3Qob2sgPyAnQ2FzZSBudW1iZXIgY29waWVk' +
  'IOKAlCBwYXN0ZSBpdCBpbnRvIHRoZWlyIHNlYXJjaCcgOiAnT3BlbmluZyAnICsgcC5uYW1lKTsKICAgICAgd2luZG93Lm9wZW4o' +
  'cC51cmwsICdfYmxhbmsnKTsKICAgIH0pOwogIH0pOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gc2NhbiAtLSAqLwpmdW5jdGlvbiBzY2FuVmlldygpIHsKICBhcHAuaW5uZXJIVE1M' +
  'ID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5TY2FuIGEgcGFja2V0PC9oMT4KICAgIDxkaXYgY2xhc3M9ImNhcmQiPgog' +
  'ICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6MCI+UG9pbnQgdGhlIGNhbWVyYSBhdCB0aGUgYmFyY29kZSBv' +
  'biB0aGUgY292ZXIgc2hlZXQgdG8gb3BlbiB0aGF0IGpvYi4gSWYgdGhlIGNhbWVyYQogICAgICB3b24ndCBjb29wZXJhdGUsIHR5' +
  'cGUgdGhlIGpvYiBudW1iZXIgaW5zdGVhZCDigJQgaXQgd29ya3MgdGhlIHNhbWUuPC9wPgogICAgICA8ZGl2IGlkPSJyZWFkZXIi' +
  'PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPgogICAgICAgIDxidXR0b24gY2xh' +
  'c3M9ImJ0biIgaWQ9InN0YXJ0U2NhbiI+U3RhcnQgY2FtZXJhPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNl' +
  'YyIgaWQ9InN0b3BTY2FuQnRuIiBzdHlsZT0iZGlzcGxheTpub25lIj5TdG9wPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8' +
  'ZGl2IGNsYXNzPSJoaW50IiBpZD0ic2Nhbk1zZyI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAg' +
  'ICA8aDI+RW50ZXIgam9iIG51bWJlcjwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InJvdyI+CiAgICAgICAgPGlucHV0IGlkPSJtYW51' +
  'YWwiIHBsYWNlaG9sZGVyPSJTVC0xMDAwMSIgc3R5bGU9ImZsZXg6MTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2UiPgogICAgICAg' +
  'IDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9Im1hbnVhbEdvIj5PcGVuPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+YCk7' +
  'CiAgYmluZFNoZWxsKCk7CgogIGNvbnN0IG9wZW4gPSBhc3luYyBjb2RlID0+IHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IGogPSBh' +
  'd2FpdCBhcGkoJy9sb29rdXAvJyArIGVuY29kZVVSSUNvbXBvbmVudChjb2RlKSk7CiAgICAgIGlmICh3aW5kb3cuX19zdG9wU2Nh' +
  'bikgeyB3aW5kb3cuX19zdG9wU2NhbigpOyB3aW5kb3cuX19zdG9wU2NhbiA9IG51bGw7IH0KICAgICAgdG9hc3QoJ09wZW5pbmcg' +
  'JyArIGouam9iX251bWJlcik7CiAgICAgIGdvKCdqb2InLCB7IGlkOiBqLmlkIH0pOwogICAgfSBjYXRjaCAoZSkgeyAkKCcjc2Nh' +
  'bk1zZycpLnRleHRDb250ZW50ID0gZS5tZXNzYWdlOyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKCiAgJCgnI21hbnVh' +
  'bEdvJykub25jbGljayA9ICgpID0+IHsgY29uc3QgdiA9ICQoJyNtYW51YWwnKS52YWx1ZS50cmltKCk7IGlmICh2KSBvcGVuKHYp' +
  'OyB9OwogICQoJyNtYW51YWwnKS5vbmtleWRvd24gPSBlID0+IHsgaWYgKGUua2V5ID09PSAnRW50ZXInKSAkKCcjbWFudWFsR28n' +
  'KS5jbGljaygpOyB9OwoKICAkKCcjc3RhcnRTY2FuJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIGNvbnN0IG1zZyA9ICQo' +
  'JyNzY2FuTXNnJyk7CiAgICBpZiAoIXdpbmRvdy5aWGluZykgcmV0dXJuIG1zZy50ZXh0Q29udGVudCA9ICdTY2FubmVyIGxpYnJh' +
  'cnkgZGlkIG5vdCBsb2FkIOKAlCB1c2UgdGhlIGpvYiBudW1iZXIgYm94IGJlbG93Lic7CiAgICB0cnkgewogICAgICBjb25zdCBy' +
  'ZWFkZXIgPSBuZXcgWlhpbmcuQnJvd3Nlck11bHRpRm9ybWF0UmVhZGVyKCk7CiAgICAgIGNvbnN0IHZpZGVvID0gZG9jdW1lbnQu' +
  'Y3JlYXRlRWxlbWVudCgndmlkZW8nKTsKICAgICAgdmlkZW8uc2V0QXR0cmlidXRlKCdwbGF5c2lubGluZScsICd0cnVlJyk7CiAg' +
  'ICAgICQoJyNyZWFkZXInKS5pbm5lckhUTUwgPSAnJzsKICAgICAgJCgnI3JlYWRlcicpLmFwcGVuZENoaWxkKHZpZGVvKTsKICAg' +
  'ICAgJCgnI3N0YXJ0U2NhbicpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgICAgICQoJyNzdG9wU2NhbkJ0bicpLnN0eWxlLmRp' +
  'c3BsYXkgPSAnJzsKICAgICAgbXNnLnRleHRDb250ZW50ID0gJ0xvb2tpbmcgZm9yIGEgYmFyY29kZeKApic7CiAgICAgIGxldCBo' +
  'YW5kbGVkID0gZmFsc2U7CiAgICAgIGF3YWl0IHJlYWRlci5kZWNvZGVGcm9tQ29uc3RyYWludHMoCiAgICAgICAgeyB2aWRlbzog' +
  'eyBmYWNpbmdNb2RlOiAnZW52aXJvbm1lbnQnIH0gfSwgdmlkZW8sCiAgICAgICAgKHJlc3VsdCkgPT4geyBpZiAocmVzdWx0ICYm' +
  'ICFoYW5kbGVkKSB7IGhhbmRsZWQgPSB0cnVlOyBvcGVuKHJlc3VsdC5nZXRUZXh0KCkpOyB9IH0pOwogICAgICB3aW5kb3cuX19z' +
  'dG9wU2NhbiA9ICgpID0+IHsKICAgICAgICB0cnkgeyByZWFkZXIucmVzZXQoKTsgfSBjYXRjaCAoZSkge30KICAgICAgICAkKCcj' +
  'cmVhZGVyJykuaW5uZXJIVE1MID0gJyc7CiAgICAgICAgY29uc3QgcyA9ICQoJyNzdGFydFNjYW4nKSwgc3QgPSAkKCcjc3RvcFNj' +
  'YW5CdG4nKTsKICAgICAgICBpZiAocykgcy5zdHlsZS5kaXNwbGF5ID0gJyc7CiAgICAgICAgaWYgKHN0KSBzdC5zdHlsZS5kaXNw' +
  'bGF5ID0gJ25vbmUnOwogICAgICB9OwogICAgICAkKCcjc3RvcFNjYW5CdG4nKS5vbmNsaWNrID0gKCkgPT4geyB3aW5kb3cuX19z' +
  'dG9wU2NhbigpOyB3aW5kb3cuX19zdG9wU2NhbiA9IG51bGw7IG1zZy50ZXh0Q29udGVudCA9ICcnOyB9OwogICAgfSBjYXRjaCAo' +
  'ZSkgewogICAgICBtc2cudGV4dENvbnRlbnQgPSAnQ2FtZXJhIHVuYXZhaWxhYmxlICgnICsgZS5tZXNzYWdlICsgJykuIFVzZSB0' +
  'aGUgam9iIG51bWJlciBib3ggYmVsb3cuJzsKICAgICAgJCgnI3N0YXJ0U2NhbicpLnN0eWxlLmRpc3BsYXkgPSAnJzsKICAgICAg' +
  'JCgnI3N0b3BTY2FuQnRuJykuc3R5bGUuZGlzcGxheSA9ICdub25lJzsKICAgIH0KICB9Owp9CgovKiAtLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBtb25leSAtLSAqLwphc3luYyBmdW5jdGlvbiBt' +
  'b25leVZpZXcoKSB7CiAgaWYgKCFpc0FkbWluKCkpIHJldHVybiBteVBheVZpZXcoKTsKICBjb25zdCBbc3RhdGVtZW50cywgaW52' +
  'b2ljZXMsIHVzZXJzLCBjbGllbnRzLCBhcl0gPSBhd2FpdCBQcm9taXNlLmFsbCgKICAgIFthcGkoJy9zdGF0ZW1lbnRzJyksIGFw' +
  'aSgnL2ludm9pY2VzJyksIGFwaSgnL3VzZXJzJyksIGFwaSgnL2NsaWVudHMnKSwgYXBpKCcvcmVjZWl2YWJsZXMnKV0pOwoKICAv' +
  'KiBNb25leSBvd2VkLCBvbGRlc3QgZmlyc3QuICJVbmJpbGxlZCIgaXMgZGVsaWJlcmF0ZWx5IG5vdCBwYXJ0IG9mIHRoZQogICAg' +
  'IHRvdGFsIOKAlCB0aGF0IGlzIHdvcmsgeW91IGhhdmUgbm90IGFza2VkIHRvIGJlIHBhaWQgZm9yIHlldCwgd2hpY2ggaXMgYQog' +
  'ICAgIGRpZmZlcmVudCBwcm9ibGVtIGZyb20gYSBmaXJtIHRoYXQgaXMgc2xvdyB0byBwYXkuICovCiAgY29uc3Qgb3dlZCA9IGFy' +
  'LmNsaWVudHMuZmlsdGVyKGMgPT4gTnVtYmVyKGMuYmFsYW5jZSkgPiAwKTsKICBjb25zdCBidWNrZXQgPSAodiwgd2FybikgPT4g' +
  'YDxkaXYgY2xhc3M9InN0YXQke3YgPiAwICYmIHdhcm4gPyAnIGJhZCcgOiAnJ30iIHN0eWxlPSJmbGV4OjEiPgogICAgICA8ZGl2' +
  'IGNsYXNzPSJuIiBzdHlsZT0iZm9udC1zaXplOjE2cHgiPiR7bW9uZXkodil9PC9kaXY+PGRpdiBjbGFzcz0ibCI+JHt3YXJuIHx8' +
  'ICdDdXJyZW50J308L2Rpdj48L2Rpdj5gOwoKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5C' +
  'aWxsaW5nICZhbXA7IHBheTwvaDE+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5PdXRzdGFuZGluZyA8c3BhbiBj' +
  'bGFzcz0ic3ViIj53aGF0IHlvdXIgYXR0b3JuZXlzIG93ZSB5b3U8L3NwYW4+PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdCBi' +
  'aWciIHN0eWxlPSJtYXJnaW4tdG9wOjZweCI+CiAgICAgICAgPGRpdiBjbGFzcz0ibiI+JHttb25leShhci50b3RhbCl9PC9kaXY+' +
  'CiAgICAgICAgPGRpdiBjbGFzcz0ibCI+JHtvd2VkLmxlbmd0aCA/IG93ZWQubGVuZ3RoICsgJyBmaXJtJyArIChvd2VkLmxlbmd0' +
  'aCA9PT0gMSA/ICcnIDogJ3MnKSArICcgd2l0aCBhIGJhbGFuY2UnCiAgICAgICAgICA6ICdFdmVyeW9uZSBpcyBwYWlkIHVwJ308' +
  'L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgICR7YXIudG90YWwgPiAwID8gYDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9ImdhcDo2cHg7' +
  'bWFyZ2luLXRvcDoxMHB4Ij4KICAgICAgICAke2J1Y2tldChhci5idWNrZXRzLmQwKX0ke2J1Y2tldChhci5idWNrZXRzLmQzMCwg' +
  'JzMwKyBkYXlzJyl9CiAgICAgICAgJHtidWNrZXQoYXIuYnVja2V0cy5kNjAsICc2MCsgZGF5cycpfSR7YnVja2V0KGFyLmJ1Y2tl' +
  'dHMuZDkwLCAnOTArIGRheXMnKX0KICAgICAgPC9kaXY+YCA6ICcnfQogICAgICAke293ZWQubGVuZ3RoID8gYDx0YWJsZSBjbGFz' +
  'cz0idGJsIiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij4KICAgICAgICA8dHI+PHRoPkF0dG9ybmV5PC90aD48dGggY2xhc3M9Im51' +
  'bSI+T3dlZDwvdGg+PHRoIGNsYXNzPSJudW0iPk9sZGVzdDwvdGg+PHRoPjwvdGg+PC90cj4KICAgICAgICAke293ZWQubWFwKGMg' +
  'PT4gewogICAgICAgICAgY29uc3QgYWdlID0gTWF0aC5mbG9vcigoRGF0ZS5ub3coKSAtIG5ldyBEYXRlKGMub2xkZXN0X2ludm9p' +
  'Y2UpLmdldFRpbWUoKSkgLyA4NjRlNSk7CiAgICAgICAgICByZXR1cm4gYDx0cj4KICAgICAgICAgICAgPHRkPiR7ZXNjKGMuY2xp' +
  'ZW50X25hbWUpfTxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MCI+JHtjLmludm9pY2VfY291bnR9IGludm9pY2Ukewog' +
  'ICAgICAgICAgICAgIGMuaW52b2ljZV9jb3VudCA9PT0gMSA/ICcnIDogJ3MnfTwvZGl2PjwvdGQ+CiAgICAgICAgICAgIDx0ZCBj' +
  'bGFzcz0ibnVtIj4ke21vbmV5KGMuYmFsYW5jZSl9PC90ZD4KICAgICAgICAgICAgPHRkIGNsYXNzPSJudW0iJHthZ2UgPj0gNjAg' +
  'PyAnIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQpO2ZvbnQtd2VpZ2h0OjcwMCInIDogJyd9PiR7YWdlfWQ8L3RkPgogICAgICAgICAg' +
  'ICA8dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iL3ByaW50L2FjY291bnQvJHtjLmNsaWVudF9pZH0iIHRhcmdldD0iX2JsYW5rIj5z' +
  'dGF0ZW1lbnQ8L2E+PC90ZD4KICAgICAgICAgIDwvdHI+YDsKICAgICAgICB9KS5qb2luKCcnKX08L3RhYmxlPmAgOiAnJ30KICAg' +
  'ICAgJHthci51bmJpbGxlZCA+IDAgPyBgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+U2VwYXJhdGVs' +
  'eSwgPGI+JHttb25leShhci51bmJpbGxlZCl9PC9iPgogICAgICAgIG9mIHNlcnZlZCB3b3JrIGhhcyBub3QgYmVlbiBwdXQgb24g' +
  'YW4gaW52b2ljZSB5ZXQg4oCUIHRoYXQgaXMgbW9uZXkgeW91IGhhdmUgbm90IGFza2VkIGZvci48L2Rpdj5gIDogJyd9CiAgICA8' +
  'L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkNvbnRyYWN0b3Igc3RhdGVtZW50cyA8c3BhbiBjbGFzcz0i' +
  'c3ViIj53aGF0IHlvdSBvd2UgeW91ciBzZXJ2ZXJzPC9zcGFuPjwvaDI+CiAgICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFy' +
  'Z2luLXRvcDotNHB4Ij5QdWxscyBldmVyeSBjb21wbGV0ZWQgc2VydmUgaW4gdGhlIHBlcmlvZCB0aGF0IGhhc24ndCBiZWVuIHBh' +
  'aWQgb3V0IHlldCwgYXQgdGhlCiAgICAgIHBlci1qb2IgcmF0ZSBvbiB0aGUgam9iLiBOb3RoaW5nIGdldHMgY291bnRlZCB0d2lj' +
  'ZS48L3A+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxkaXYgY2xh' +
  'c3M9ImZpZWxkIj48bGFiZWw+U2VydmVyPC9sYWJlbD48c2VsZWN0IGlkPSJzX3NlcnZlciI+CiAgICAgICAgICAke3VzZXJzLmZp' +
  'bHRlcih1ID0+IHUuYWN0aXZlKS5tYXAodSA9PiBgPG9wdGlvbiB2YWx1ZT0iJHt1LmlkfSI+JHtlc2ModS5uYW1lKX08L29wdGlv' +
  'bj5gKS5qb2luKCcnKX08L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJhbGlnbi1pdGVtczpm' +
  'bGV4LWVuZDtnYXA6NnB4Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0iZmxleDoxO21hcmdpbjowIj48bGFi' +
  'ZWw+RnJvbTwvbGFiZWw+PGlucHV0IHR5cGU9ImRhdGUiIGlkPSJzX3N0YXJ0IiB2YWx1ZT0iJHtmaXJzdE9mTW9udGgoKX0iPjwv' +
  'ZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJmbGV4OjE7bWFyZ2luOjAiPjxsYWJlbD5UbzwvbGFiZWw+' +
  'PGlucHV0IHR5cGU9ImRhdGUiIGlkPSJzX2VuZCIgdmFsdWU9IiR7dG9kYXlJU08oKX0iPjwvZGl2PgogICAgICAgIDwvZGl2Pgog' +
  'ICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPgogICAgICAgIDxidXR0b24g' +
  'Y2xhc3M9ImJ0biBzZWMgc20iIGlkPSJzX3ByZXYiPlByZXZpZXc8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4g' +
  'c20iIGlkPSJzX21ha2UiPkNyZWF0ZSBzdGF0ZW1lbnQ8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgaWQ9InNfb3V0' +
  'Ij48L2Rpdj4KICAgICAgJHtzdGF0ZW1lbnRzLmxlbmd0aCA/IGA8dGFibGUgY2xhc3M9InRibCIgc3R5bGU9Im1hcmdpbi10b3A6' +
  'MTRweCI+CiAgICAgICAgPHRyPjx0aD5TZXJ2ZXI8L3RoPjx0aD5QZXJpb2Q8L3RoPjx0aCBjbGFzcz0ibnVtIj5Kb2JzPC90aD48' +
  'dGggY2xhc3M9Im51bSI+VG90YWw8L3RoPjx0aD48L3RoPjx0aD48L3RoPjwvdHI+CiAgICAgICAgJHtzdGF0ZW1lbnRzLm1hcChz' +
  'ID0+IGA8dHI+CiAgICAgICAgICA8dGQ+JHtlc2Mocy5zZXJ2ZXJfbmFtZSl9PC90ZD48dGQ+JHtmbXREYXRlT25seShzLnBlcmlv' +
  'ZF9zdGFydCl94oCTJHtmbXREYXRlT25seShzLnBlcmlvZF9lbmQpfTwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHtz' +
  'LmpvYl9jb3VudH08L3RkPjx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KHMudG90YWwpfTwvdGQ+CiAgICAgICAgICA8dGQ+PHNwYW4g' +
  'Y2xhc3M9InBpbGwgJHtjbHMocy5zdGF0dXMpfSI+JHtlc2Mocy5zdGF0dXMpfTwvc3Bhbj48L3RkPgogICAgICAgICAgPHRkIGNs' +
  'YXNzPSJudW0iPjxhIGhyZWY9Ii9wcmludC9zdGF0ZW1lbnQvJHtzLmlkfSIgdGFyZ2V0PSJfYmxhbmsiPnByaW50PC9hPgogICAg' +
  'ICAgICAgICAke3Muc3RhdHVzICE9PSAnUGFpZCcgPyBgIMK3IDxhIGhyZWY9IiMiIGRhdGEtcGFpZD0iJHtzLmlkfSI+bWFyayBw' +
  'YWlkPC9hPmAgOiAnJ308L3RkPgogICAgICAgIDwvdHI+YCkuam9pbignJyl9PC90YWJsZT5gIDogJyd9CiAgICA8L2Rpdj4KCiAg' +
  'ICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkNsaWVudCBpbnZvaWNlczwvaDI+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQg' +
  'ZzIiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q2xpZW50PC9sYWJlbD48c2VsZWN0IGlkPSJpX2NsaWVudCI+' +
  'CiAgICAgICAgICAke2NsaWVudHMuZmlsdGVyKGMgPT4gYy5hY3RpdmUpLm1hcChjID0+IGA8b3B0aW9uIHZhbHVlPSIke2MuaWR9' +
  'Ij4ke2VzYyhjLm5hbWUpfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJv' +
  'dyIgc3R5bGU9ImFsaWduLWl0ZW1zOmZsZXgtZW5kO2dhcDo2cHgiPgogICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxl' +
  'PSJmbGV4OjE7bWFyZ2luOjAiPjxsYWJlbD5Gcm9tPC9sYWJlbD48aW5wdXQgdHlwZT0iZGF0ZSIgaWQ9Imlfc3RhcnQiIHZhbHVl' +
  'PSIke2ZpcnN0T2ZNb250aCgpfSI+PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCIgc3R5bGU9ImZsZXg6MTttYXJn' +
  'aW46MCI+PGxhYmVsPlRvPC9sYWJlbD48aW5wdXQgdHlwZT0iZGF0ZSIgaWQ9ImlfZW5kIiB2YWx1ZT0iJHt0b2RheUlTTygpfSI+' +
  'PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9w' +
  'OjhweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9ImlfcHJldiI+UHJldmlldzwvYnV0dG9uPgogICAg' +
  'ICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9ImlfbWFrZSI+Q3JlYXRlIGludm9pY2U8L2J1dHRvbj4KICAgICAgPC9kaXY+' +
  'CiAgICAgIDxkaXYgaWQ9Imlfb3V0Ij48L2Rpdj4KICAgICAgJHtpbnZvaWNlcy5sZW5ndGggPyBgPHRhYmxlIGNsYXNzPSJ0Ymwi' +
  'IHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPgogICAgICAgIDx0cj48dGg+Q2xpZW50PC90aD48dGg+UGVyaW9kPC90aD48dGggY2xh' +
  'c3M9Im51bSI+Sm9iczwvdGg+PHRoIGNsYXNzPSJudW0iPlRvdGFsPC90aD48dGg+PC90aD48dGg+PC90aD48L3RyPgogICAgICAg' +
  'ICR7aW52b2ljZXMubWFwKHMgPT4gYDx0cj4KICAgICAgICAgIDx0ZD4ke2VzYyhzLmNsaWVudF9uYW1lKX08L3RkPjx0ZD4ke2Zt' +
  'dERhdGVPbmx5KHMucGVyaW9kX3N0YXJ0KX3igJMke2ZtdERhdGVPbmx5KHMucGVyaW9kX2VuZCl9PC90ZD4KICAgICAgICAgIDx0' +
  'ZCBjbGFzcz0ibnVtIj4ke3Muam9iX2NvdW50fTwvdGQ+PHRkIGNsYXNzPSJudW0iPiR7bW9uZXkocy50b3RhbCl9PC90ZD4KICAg' +
  'ICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icGlsbCAke2NscyhzLnN0YXR1cyl9Ij4ke2VzYyhzLnN0YXR1cyl9PC9zcGFuPjwvdGQ+' +
  'CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iL3ByaW50L2ludm9pY2UvJHtzLmlkfSIgdGFyZ2V0PSJfYmxhbmsi' +
  'PnByaW50PC9hPgogICAgICAgICAgICAke3Muc3RhdHVzICE9PSAnUGFpZCcgPyBgIMK3IDxhIGhyZWY9IiMiIGRhdGEtaXBhaWQ9' +
  'IiR7cy5pZH0iPm1hcmsgcGFpZDwvYT5gIDogJyd9PC90ZD4KICAgICAgICA8L3RyPmApLmpvaW4oJycpfTwvdGFibGU+YCA6ICcn' +
  'fQogICAgPC9kaXY+YCk7CiAgYmluZFNoZWxsKCk7CgogIGNvbnN0IGxpbmVzVGFibGUgPSAociwga2V5KSA9PiByLmxpbmVzLmxl' +
  'bmd0aAogICAgPyBgPHRhYmxlIGNsYXNzPSJ0YmwiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPjx0cj48dGg+RGF0ZTwvdGg+PHRo' +
  'PkpvYjwvdGg+PHRoPlJlY2lwaWVudDwvdGg+PHRoIGNsYXNzPSJudW0iPiR7a2V5ID09PSAncGF5JyA/ICdQYXknIDogJ0ZlZSd9' +
  'PC90aD48L3RyPgogICAgICAgJHtyLmxpbmVzLm1hcChsID0+IGA8dHI+PHRkPiR7Zm10RGF0ZU9ubHkobC5zZXJ2ZWRfYXQpfTwv' +
  'dGQ+PHRkPiR7ZXNjKGwuam9iX251bWJlcil9PC90ZD4KICAgICAgIDx0ZD4ke2VzYyhsLnJlY2lwaWVudF9uYW1lKX08L3RkPjx0' +
  'ZCBjbGFzcz0ibnVtIj4ke21vbmV5KGtleSA9PT0gJ3BheScgPyBsLnNlcnZlcl9wYXkgOiBsLmNsaWVudF9mZWUpfTwvdGQ+PC90' +
  'cj5gKS5qb2luKCcnKX0KICAgICAgIDx0cj48dGQgY29sc3Bhbj0iMyI+PGI+JHtyLmNvdW50fSBqb2Iocyk8L2I+PC90ZD48dGQg' +
  'Y2xhc3M9Im51bSI+PGI+JHttb25leShyLnRvdGFsKX08L2I+PC90ZD48L3RyPjwvdGFibGU+YAogICAgOiAnPGRpdiBjbGFzcz0i' +
  'aGludCI+Tm90aGluZyB1bmJpbGxlZCBpbiB0aGF0IHdpbmRvdy48L2Rpdj4nOwoKICAkKCcjc19wcmV2Jykub25jbGljayA9IGFz' +
  'eW5jICgpID0+IHsKICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9zdGF0ZW1lbnRzL3ByZXZpZXcnLCB7IG1ldGhvZDogJ1BPU1Qn' +
  'LCBib2R5OiBKU09OLnN0cmluZ2lmeSgKICAgICAgeyBzZXJ2ZXJfaWQ6ICQoJyNzX3NlcnZlcicpLnZhbHVlLCBzdGFydDogJCgn' +
  'I3Nfc3RhcnQnKS52YWx1ZSwgZW5kOiAkKCcjc19lbmQnKS52YWx1ZSB9KSB9KTsKICAgICQoJyNzX291dCcpLmlubmVySFRNTCA9' +
  'IGxpbmVzVGFibGUociwgJ3BheScpOwogIH07CiAgJCgnI3NfbWFrZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkg' +
  'ewogICAgICBhd2FpdCBhcGkoJy9zdGF0ZW1lbnRzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoCiAg' +
  'ICAgICAgeyBzZXJ2ZXJfaWQ6ICQoJyNzX3NlcnZlcicpLnZhbHVlLCBzdGFydDogJCgnI3Nfc3RhcnQnKS52YWx1ZSwgZW5kOiAk' +
  'KCcjc19lbmQnKS52YWx1ZSB9KSB9KTsKICAgICAgdG9hc3QoJ1N0YXRlbWVudCBjcmVhdGVkJyk7IGdvKCdtb25leScpOwogICAg' +
  'fSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKICAkKCcjaV9wcmV2Jykub25jbGljayA9IGFzeW5j' +
  'ICgpID0+IHsKICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9pbnZvaWNlcy9wcmV2aWV3JywgeyBtZXRob2Q6ICdQT1NUJywgYm9k' +
  'eTogSlNPTi5zdHJpbmdpZnkoCiAgICAgIHsgY2xpZW50X2lkOiAkKCcjaV9jbGllbnQnKS52YWx1ZSwgc3RhcnQ6ICQoJyNpX3N0' +
  'YXJ0JykudmFsdWUsIGVuZDogJCgnI2lfZW5kJykudmFsdWUgfSkgfSk7CiAgICAkKCcjaV9vdXQnKS5pbm5lckhUTUwgPSBsaW5l' +
  'c1RhYmxlKHIsICdmZWUnKTsKICB9OwogICQoJyNpX21ha2UnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAg' +
  'ICAgYXdhaXQgYXBpKCcvaW52b2ljZXMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSgKICAgICAgICB7' +
  'IGNsaWVudF9pZDogJCgnI2lfY2xpZW50JykudmFsdWUsIHN0YXJ0OiAkKCcjaV9zdGFydCcpLnZhbHVlLCBlbmQ6ICQoJyNpX2Vu' +
  'ZCcpLnZhbHVlIH0pIH0pOwogICAgICB0b2FzdCgnSW52b2ljZSBjcmVhdGVkJyk7IGdvKCdtb25leScpOwogICAgfSBjYXRjaCAo' +
  'ZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1wYWlk' +
  'XScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sgPSBhc3luYyBlID0+IHsKICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgIGF3YWl0' +
  'IGFwaSgnL3N0YXRlbWVudHMvJyArIGEuZGF0YXNldC5wYWlkLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdp' +
  'ZnkoeyBzdGF0dXM6ICdQYWlkJyB9KSB9KTsKICAgIHRvYXN0KCdNYXJrZWQgcGFpZCcpOyBnbygnbW9uZXknKTsKICB9KTsKICBk' +
  'b2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1pcGFpZF0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNrID0gYXN5bmMgZSA9' +
  'PiB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICBhd2FpdCBhcGkoJy9pbnZvaWNlcy8nICsgYS5kYXRhc2V0LmlwYWlkLCB7' +
  'IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBzdGF0dXM6ICdQYWlkJyB9KSB9KTsKICAgIHRvYXN0KCdN' +
  'YXJrZWQgcGFpZCcpOyBnbygnbW9uZXknKTsKICB9KTsKfQoKZnVuY3Rpb24gZmlyc3RPZk1vbnRoKCkgewogIGNvbnN0IGQgPSBu' +
  'ZXcgRGF0ZSgpOyByZXR1cm4gbmV3IERhdGUoZC5nZXRGdWxsWWVhcigpLCBkLmdldE1vbnRoKCksIDEpLnRvSVNPU3RyaW5nKCku' +
  'c2xpY2UoMCwgMTApOwp9Cgphc3luYyBmdW5jdGlvbiBteVBheVZpZXcoKSB7CiAgY29uc3QgW3N0YXRlbWVudHMsIHN0YXRzXSA9' +
  'IGF3YWl0IFByb21pc2UuYWxsKFthcGkoJy9zdGF0ZW1lbnRzJyksIGFwaSgnL3N0YXRzJyldKTsKICBhcHAuaW5uZXJIVE1MID0g' +
  'c2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5NeSBwYXk8L2gxPgogICAgPGRpdiBjbGFzcz0ic3RhdHMiPgogICAgICA8ZGl2' +
  'IGNsYXNzPSJzdGF0IGdvb2QiPjxkaXYgY2xhc3M9Im4iPiR7bW9uZXkoc3RhdHMudW5iaWxsZWQpfTwvZGl2PjxkaXYgY2xhc3M9' +
  'ImwiPkVhcm5lZCwgbm90IHlldCBvbiBhIHN0YXRlbWVudDwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdGF0Ij48ZGl2' +
  'IGNsYXNzPSJuIj4ke3N0YXRzLnNlcnZlZF83ZH08L2Rpdj48ZGl2IGNsYXNzPSJsIj5TZXJ2ZXMgY29tcGxldGVkLCA3IGRheXM8' +
  'L2Rpdj48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2FyZCI+PGgyPlN0YXRlbWVudHM8L2gyPgogICAgJHtzdGF0' +
  'ZW1lbnRzLmxlbmd0aCA/IGA8dGFibGUgY2xhc3M9InRibCI+CiAgICAgIDx0cj48dGg+UGVyaW9kPC90aD48dGggY2xhc3M9Im51' +
  'bSI+Sm9iczwvdGg+PHRoIGNsYXNzPSJudW0iPlRvdGFsPC90aD48dGg+PC90aD48dGg+PC90aD48L3RyPgogICAgICAke3N0YXRl' +
  'bWVudHMubWFwKHMgPT4gYDx0cj48dGQ+JHtmbXREYXRlT25seShzLnBlcmlvZF9zdGFydCl94oCTJHtmbXREYXRlT25seShzLnBl' +
  'cmlvZF9lbmQpfTwvdGQ+CiAgICAgICAgPHRkIGNsYXNzPSJudW0iPiR7cy5qb2JfY291bnR9PC90ZD48dGQgY2xhc3M9Im51bSI+' +
  'JHttb25leShzLnRvdGFsKX08L3RkPgogICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icGlsbCAke2NscyhzLnN0YXR1cyl9Ij4ke2Vz' +
  'YyhzLnN0YXR1cyl9PC9zcGFuPjwvdGQ+CiAgICAgICAgPHRkIGNsYXNzPSJudW0iPjxhIGhyZWY9Ii9wcmludC9zdGF0ZW1lbnQv' +
  'JHtzLmlkfSIgdGFyZ2V0PSJfYmxhbmsiPnByaW50PC9hPjwvdGQ+PC90cj5gKS5qb2luKCcnKX0KICAgICAgPC90YWJsZT5gIDog' +
  'JzxkaXYgY2xhc3M9ImVtcHR5Ij5ObyBzdGF0ZW1lbnRzIHlldC48L2Rpdj4nfQogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJj' +
  'YXJkIj48aDI+Q2hhbmdlIHBhc3N3b3JkPC9oMj4KICAgICAgPGRpdiBjbGFzcz0iaGludCI+VGhpcyBpcyB5b3VyIG9uZSBwYXNz' +
  'd29yZCBmb3IgZXZlcnkgYXBwLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGlucHV0IGlkPSJvcHciIHR5cGU9InBh' +
  'c3N3b3JkIiBwbGFjZWhvbGRlcj0iQ3VycmVudCBwYXNzd29yZCI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48aW5w' +
  'dXQgaWQ9Im5wdyIgdHlwZT0icGFzc3dvcmQiIHBsYWNlaG9sZGVyPSJOZXcgcGFzc3dvcmQgKDgrIGNoYXJhY3RlcnMpIj48L2Rp' +
  'dj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0ic2F2ZVB3Ij5VcGRhdGU8L2J1dHRvbj48L2Rpdj5gKTsKICBiaW5k' +
  'U2hlbGwoKTsKICAkKCcjc2F2ZVB3Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHIgPSBh' +
  'd2FpdCBhcGkoJy9tZS9wYXNzd29yZCcsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsKICAgICAgICBw' +
  'YXNzd29yZDogJCgnI25wdycpLnZhbHVlLCBvbGRfcGFzc3dvcmQ6ICQoJyNvcHcnKS52YWx1ZSB9KSB9KTsKICAgICAgJCgnI29w' +
  'dycpLnZhbHVlID0gJyc7ICQoJyNucHcnKS52YWx1ZSA9ICcnOwogICAgICB0b2FzdChyLmV2ZXJ5d2hlcmUgPT09IGZhbHNlID8g' +
  'J0NoYW5nZWQgaGVyZSDigJQgb3RoZXIgYXBwcyBzdGlsbCBoYXZlIHRoZSBvbGQgb25lJyA6ICdQYXNzd29yZCB1cGRhdGVkIGV2' +
  'ZXJ5d2hlcmUnKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07Cn0KCgpmdW5jdGlvbiBj' +
  'b2Rlc1RhYmxlKGxpc3QpIHsKICBpZiAoIWxpc3QubGVuZ3RoKSByZXR1cm4gJzxkaXYgY2xhc3M9ImhpbnQiPk5vIGNvZGVzIHll' +
  'dC48L2Rpdj4nOwogIHJldHVybiBgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgPHRyPjx0aD5Db2RlPC90aD48dGg+R3JhbnRzPC90' +
  'aD48dGg+VXNlZDwvdGg+PHRoPjwvdGg+PHRoPjwvdGg+PC90cj4KICAgICR7bGlzdC5tYXAoYyA9PiBgPHRyPgogICAgICA8dGQ+' +
  'PHNwYW4gc3R5bGU9ImZvbnQ6NjAwIDEzcHggbW9ub3NwYWNlO2xldHRlci1zcGFjaW5nOi41cHgiPiR7ZXNjKGMuY29kZSl9PC9z' +
  'cGFuPgogICAgICAgICR7Yy5ub3RlID8gYDxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKGMubm90ZSl9PC9kaXY+YCA6ICcnfQogICAg' +
  'ICAgICR7Yy5yZWRlbXB0aW9ucyAmJiBjLnJlZGVtcHRpb25zLmxlbmd0aCA/IGA8ZGl2IGNsYXNzPSJoaW50Ij4ke2MucmVkZW1w' +
  'dGlvbnMubWFwKHIgPT4gZXNjKHIuZW1haWwpKS5qb2luKCcsICcpfTwvZGl2PmAgOiAnJ308L3RkPgogICAgICA8dGQ+JHtjLnJv' +
  'bGUgPT09ICdhZG1pbicgPyAnQWRtaW4nIDogJ0ZpZWxkIHNlcnZlcid9CiAgICAgICAgJHtjLmV4cGlyZXNfYXQgPyBgPGRpdiBj' +
  'bGFzcz0iaGludCI+dG8gJHtmbXREYXRlT25seShjLmV4cGlyZXNfYXQpfTwvZGl2PmAgOiAnJ308L3RkPgogICAgICA8dGQ+JHtj' +
  'LnVzZWRfY291bnR9LyR7Yy5tYXhfdXNlc308L3RkPgogICAgICA8dGQ+PHNwYW4gY2xhc3M9InBpbGwgJHtjLnN0YXRlID09PSAn' +
  'QWN0aXZlJyA/ICdTZXJ2ZWQnIDogJyd9Ij4ke2VzYyhjLnN0YXRlKX08L3NwYW4+PC90ZD4KICAgICAgPHRkIGNsYXNzPSJudW0i' +
  'PgogICAgICAgIDxhIGhyZWY9IiMiIGRhdGEtY29weT0iJHtlc2MoYy5jb2RlKX0iPmNvcHk8L2E+CiAgICAgICAgJHtjLnN0YXRl' +
  'ID09PSAnQWN0aXZlJyA/IGAgwrcgPGEgaHJlZj0iIyIgZGF0YS1yZXZva2U9IiR7Yy5pZH0iPnJldm9rZTwvYT5gIDogJyd9CiAg' +
  'ICAgIDwvdGQ+PC90cj5gKS5qb2luKCcnKX08L3RhYmxlPmA7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGFkbWluIC0tICovCmFzeW5jIGZ1bmN0aW9uIGFkbWluVmlldygpIHsKICAv' +
  'LyBGZXRjaCBldmVyeXRoaW5nIGJlZm9yZSBkcmF3aW5nLiBQb3B1bGF0aW5nIGNhcmRzIGFmdGVyIHJlbmRlciBtYWRlIHRoZQog' +
  'IC8vIHBhZ2UgZ3JvdyB1bmRlciB0aGUgdXNlcidzIGZpbmdlciwgc28gYSB0YXAgY291bGQgbGFuZCBvbiB0aGUgd3Jvbmcgcm93' +
  'LgogIGNvbnN0IFt1c2VycywgY2xpZW50cywgdGVtcGxhdGVzLCBjb2RlcywgcG9ydGFscywgY29tcGFuaWVzXSA9IGF3YWl0IFBy' +
  'b21pc2UuYWxsKFsKICAgIGFwaSgnL3VzZXJzJyksIGFwaSgnL2NsaWVudHMnKSwgYXBpKCcvdGVtcGxhdGVzJyksCiAgICBhcGko' +
  'Jy9jb2RlcycpLmNhdGNoKCgpID0+IFtdKSwgYXBpKCcvcG9ydGFscycpLmNhdGNoKCgpID0+IFtdKSwKICAgIGFwaSgnL2NvbXBh' +
  'bmllcycpLmNhdGNoKCgpID0+IFtdKQogIF0pOwogIGNvbnN0IGhlcmUgPSBjb21wYW5pZXMuZmluZChjID0+IFMubWUuY29tcGFu' +
  'eSAmJiBjLmlkID09PSBTLm1lLmNvbXBhbnkuaWQpIHx8IGNvbXBhbmllc1swXSB8fCB7fTsKICBhcHAuaW5uZXJIVE1MID0gc2hl' +
  'bGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5TZXR1cDwvaDE+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj4ke2lz' +
  'T3duZXIoKSA/ICdUaGlzIGNvbXBhbnknIDogJ1lvdXIgY29tcGFueSd9CiAgICAgICAgPHNwYW4gY2xhc3M9InN1YiI+JHtlc2Mo' +
  'aGVyZS5wbGFuID09PSAncHJvJyA/ICdQcm8nIDogJ0ZyZWUnKX0kewogICAgICAgICAgaGVyZS5wbGFuX2V4cGlyZXMgPyAnIHVu' +
  'dGlsICcgKyBmbXREYXRlT25seShoZXJlLnBsYW5fZXhwaXJlcykgOiAnJ308L3NwYW4+PC9oMj4KICAgICAgPGRpdiBjbGFzcz0i' +
  'ZmllbGQiPjxsYWJlbD5OYW1lPC9sYWJlbD48aW5wdXQgaWQ9ImNvTmFtZSIgdmFsdWU9IiR7ZXNjKGhlcmUubmFtZSB8fCAnJyl9' +
  'Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Db250YWN0IGVtYWlsPC9sYWJlbD48aW5wdXQgaWQ9ImNv' +
  'RW1haWwiIHZhbHVlPSIke2VzYyhoZXJlLmNvbnRhY3RfZW1haWwgfHwgJycpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZp' +
  'ZWxkIj48bGFiZWw+UGhvbmU8L2xhYmVsPjxpbnB1dCBpZD0iY29QaG9uZSIgdmFsdWU9IiR7ZXNjKGhlcmUucGhvbmUgfHwgJycp' +
  'fSI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9ImNvU2F2ZSI+U2F2ZTwvYnV0dG9uPgogICAgICA8ZGl2' +
  'IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPlRoaXMgbmFtZSBhcHBlYXJzIG9uIHlvdXIgaW52b2ljZXMgYW5k' +
  'IHBheSBzdGF0ZW1lbnRzLjwvZGl2PgogICAgPC9kaXY+CgogICAgJHtpc093bmVyKCkgPyBgPGRpdiBjbGFzcz0iY2FyZCI+CiAg' +
  'ICAgIDxoMj5BbGwgY29tcGFuaWVzIDxzcGFuIGNsYXNzPSJzdWIiPiR7Y29tcGFuaWVzLmxlbmd0aH08L3NwYW4+PC9oMj4KICAg' +
  'ICAgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgICAgIDx0cj48dGg+Q29tcGFueTwvdGg+PHRoIGNsYXNzPSJudW0iPlBlb3BsZTwv' +
  'dGg+PHRoIGNsYXNzPSJudW0iPk9wZW48L3RoPjx0aD48L3RoPjwvdHI+CiAgICAgICAgJHtjb21wYW5pZXMubWFwKGMgPT4gYDx0' +
  'cj4KICAgICAgICAgIDx0ZD4ke2VzYyhjLm5hbWUpfSR7Uy5tZS5jb21wYW55ICYmIGMuaWQgPT09IFMubWUuY29tcGFueS5pZCA/' +
  'ICcgPHNwYW4gY2xhc3M9InBpbGwiPnlvdSBhcmUgaGVyZTwvc3Bhbj4nIDogJyd9CiAgICAgICAgICAgIDxkaXYgY2xhc3M9Imhp' +
  'bnQiPiR7ZXNjKGMuYWRtaW5fZW1haWwgfHwgJ25vIGFkbWluIHlldCcpfSDCtyAke2MucGxhbiA9PT0gJ3BybycgPyAnUHJvJyA6' +
  'ICdGcmVlJ308L2Rpdj48L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPiR7Yy5wZW9wbGUgPz8gJ+KAlCd9PC90ZD4KICAg' +
  'ICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke2Mub3Blbl9qb2JzID8/ICfigJQnfTwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51' +
  'bSI+JHtTLm1lLmNvbXBhbnkgJiYgYy5pZCA9PT0gUy5tZS5jb21wYW55LmlkCiAgICAgICAgICAgID8gJycgOiBgPGEgaHJlZj0i' +
  'IyIgZGF0YS1lbnRlcj0iJHtjLmlkfSI+ZW50ZXI8L2E+YH08L3RkPjwvdHI+YCkuam9pbignJyl9CiAgICAgIDwvdGFibGU+CiAg' +
  'ICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij48bGFiZWw+U3RhcnQgYW5vdGhlciBjb21wYW55' +
  'PC9sYWJlbD4KICAgICAgICA8aW5wdXQgaWQ9Im5ld0NvTmFtZSIgcGxhY2Vob2xkZXI9IkNvbXBhbnkgbmFtZSI+PC9kaXY+CiAg' +
  'ICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9Im5ld0NvIj5DcmVhdGUgY29tcGFueTwvYnV0dG9uPgogICAgICA8ZGl2IGNs' +
  'YXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPkNyZWF0aW5nIGEgY29tcGFueSBnaXZlcyBpdCBpdHMgb3duIGpvYnMs' +
  'IGNsaWVudHMgYW5kCiAgICAgICAgYmlsbGluZy4gQWRkIGl0cyBhZG1pbmlzdHJhdG9yIGZyb20gaW5zaWRlIGl0LCBvciBoYW5k' +
  'IHRoZW0gYW4gYWNjZXNzIGNvZGUuPC9kaXY+CiAgICA8L2Rpdj5gIDogJyd9CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAg' +
  'IDxoMj5UZWFtIDxzcGFuIGNsYXNzPSJzdWIiPiR7dXNlcnMubGVuZ3RofTwvc3Bhbj48L2gyPgogICAgICA8dGFibGUgY2xhc3M9' +
  'InRibCI+CiAgICAgICAgPHRyPjx0aD5OYW1lPC90aD48dGg+Um9sZTwvdGg+PHRoIGNsYXNzPSJudW0iPlJhdGU8L3RoPjx0aD48' +
  'L3RoPjwvdHI+CiAgICAgICAgJHt1c2Vycy5tYXAodSA9PiBgPHRyPjx0ZD4ke2VzYyh1Lm5hbWUpfTxkaXYgY2xhc3M9ImhpbnQi' +
  'PiR7ZXNjKHUuZW1haWwpfTwvZGl2PjwvdGQ+CiAgICAgICAgICA8dGQ+JHtlc2ModS5yb2xlKX0ke3UuYWN0aXZlID8gJycgOiAn' +
  'IDxzcGFuIGNsYXNzPSJwaWxsIj5vZmY8L3NwYW4+J308L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPiR7bW9uZXkodS5k' +
  'ZWZhdWx0X3BheSl9PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIjIiBkYXRhLXVzZXI9IiR7dS5pZH0i' +
  'PmVkaXQ8L2E+PC90ZD48L3RyPmApLmpvaW4oJycpfQogICAgICA8L3RhYmxlPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2Vj' +
  'IGJsb2NrIHNtIiBpZD0ibmV3VXNlciIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+KyBBZGQgcGVyc29uPC9idXR0b24+CiAgICA8' +
  'L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkNsaWVudHMgPHNwYW4gY2xhc3M9InN1YiI+JHtjbGllbnRz' +
  'Lmxlbmd0aH08L3NwYW4+PC9oMj4KICAgICAgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgICAgIDx0cj48dGg+TmFtZTwvdGg+PHRo' +
  'IGNsYXNzPSJudW0iPkRlZmF1bHQgZmVlPC90aD48dGg+PC90aD48L3RyPgogICAgICAgICR7Y2xpZW50cy5tYXAoYyA9PiBgPHRy' +
  'Pjx0ZD4ke2VzYyhjLm5hbWUpfTxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKGMuY29udGFjdF9uYW1lIHx8ICcnKX0gJHtlc2MoYy5w' +
  'aG9uZSB8fCAnJyl9PC9kaXY+PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KGMuZGVmYXVsdF9mZWUpfTwv' +
  'dGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iIyIgZGF0YS1jbGllbnQ9IiR7Yy5pZH0iPmVkaXQ8L2E+PC90' +
  'ZD48L3RyPmApLmpvaW4oJycpfQogICAgICA8L3RhYmxlPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIGJsb2NrIHNtIiBp' +
  'ZD0ibmV3Q2xpZW50IiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4rIEFkZCBjbGllbnQ8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAg' +
  'IDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+QWZmaWRhdml0IHRlbXBsYXRlcyA8c3BhbiBjbGFzcz0ic3ViIj4ke3RlbXBs' +
  'YXRlcy5sZW5ndGh9PC9zcGFuPjwvaDI+CiAgICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDotNHB4Ij5Xcml0' +
  'ZSB5b3VyIG93biB3b3JkaW5nIHBlciBjb3VudHkgb3IgY2xpZW50LiBNZXJnZSBmaWVsZHMgZmlsbCBpbiBmcm9tIHRoZSBqb2Is' +
  'CiAgICAgIGluY2x1ZGluZyB0aGUgZnVsbCBhdHRlbXB0IGxvZyB3aXRoIEdQUy48L3A+CiAgICAgIDx0YWJsZSBjbGFzcz0idGJs' +
  'Ij4KICAgICAgICAke3RlbXBsYXRlcy5tYXAodCA9PiBgPHRyPjx0ZD4ke2VzYyh0Lm5hbWUpfTxkaXYgY2xhc3M9ImhpbnQiPiR7' +
  'ZXNjKHQuanVyaXNkaWN0aW9uIHx8ICcnKX08L2Rpdj48L3RkPgogICAgICAgICAgPHRkPiR7dC5pc19kZWZhdWx0ID8gJzxzcGFu' +
  'IGNsYXNzPSJwaWxsIFNlcnZlZCI+ZGVmYXVsdDwvc3Bhbj4nIDogJyd9PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj48' +
  'YSBocmVmPSIjIiBkYXRhLXRwbD0iJHt0LmlkfSI+ZWRpdDwvYT48L3RkPjwvdHI+YCkuam9pbignJyl9CiAgICAgIDwvdGFibGU+' +
  'CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgYmxvY2sgc20iIGlkPSJuZXdUcGwiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgi' +
  'PisgTmV3IHRlbXBsYXRlPC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkFjY2Vz' +
  'cyBjb2RlcyA8c3BhbiBjbGFzcz0ic3ViIj5sZXQgcGVvcGxlIHNldCB1cCB0aGVpciBvd24gYWNjb3VudDwvc3Bhbj48L2gyPgog' +
  'ICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6LTRweCI+R2VuZXJhdGUgYSBjb2RlIGFuZCBzZW5kIGl0IG92' +
  'ZXIuIFRoZXkgZW50ZXIgaXQgb24gdGhlIHNpZ24taW4KICAgICAgICBzY3JlZW4gdW5kZXIgIlNldCB1cCB5b3VyIGFjY291bnQi' +
  'LCBwaWNrIHRoZWlyIG93biBwYXNzd29yZCwgYW5kIHRoZXkncmUgaW4g4oCUIG5vIG5lZWQgdG8ga2V5IGluCiAgICAgICAgdGhl' +
  'aXIgZGV0YWlscyBvciBzaGFyZSBhIHBhc3N3b3JkIHdpdGggdGhlbS48L3A+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzMiIHN0' +
  'eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+VGhleSBiZWNvbWU8L2xhYmVs' +
  'PjxzZWxlY3QgaWQ9ImNfcm9sZSI+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJzZXJ2ZXIiPkZpZWxkIHNlcnZlcjwvb3B0aW9u' +
  'PjxvcHRpb24gdmFsdWU9ImFkbWluIj5BZG1pbjwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZp' +
  'ZWxkIj48bGFiZWw+SG93IG1hbnkgY2FuIHVzZSBpdDwvbGFiZWw+PGlucHV0IGlkPSJjX3VzZXMiIHR5cGU9Im51bWJlciIgbWlu' +
  'PSIxIiBtYXg9IjUwMCIgdmFsdWU9IjEiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RXhwaXJlcyAo' +
  'b3B0aW9uYWwpPC9sYWJlbD48aW5wdXQgaWQ9ImNfZXhwIiB0eXBlPSJkYXRlIj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxk' +
  'aXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGF5IHBlciBzZXJ2ZSAoZmllbGQg' +
  'c2VydmVycyk8L2xhYmVsPjxpbnB1dCBpZD0iY19wYXkiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgcGxhY2Vob2xkZXI9IjQ1' +
  'LjAwIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk5vdGUgdG8geW91cnNlbGY8L2xhYmVsPjxpbnB1' +
  'dCBpZD0iY19ub3RlIiBwbGFjZWhvbGRlcj0iRm9yIE1hcmlhIOKAlCBldmljdGlvbnMiPjwvZGl2PgogICAgICA8L2Rpdj4KICAg' +
  'ICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0iY19tYWtlIj5HZW5lcmF0ZSBhIGNvZGU8L2J1dHRvbj4KICAgICAgPGRpdiBp' +
  'ZD0iY19saXN0IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij4ke2NvZGVzVGFibGUoY29kZXMpfTwvZGl2PgogICAgPC9kaXY+Cgog' +
  'ICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5Db3VydCBwb3J0YWwgcHJvYmUgPHNwYW4gY2xhc3M9InN1YiI+ZXhwZXJp' +
  'bWVudGFsPC9zcGFuPjwvaDI+CiAgICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDotNHB4Ij5Bc2tzIHRoZSBz' +
  'ZXJ2ZXIgdG8gZmV0Y2ggYSBjb3VudHkgcG9ydGFsIGFuZCByZXBvcnQgd2hhdCBjYW1lIGJhY2sg4oCUCiAgICAgICAgc3RhdHVz' +
  'LCBjb29raWVzLCBmb3JtcywgbGlua3MuIFRoaXMgaXMgdGhlIGdyb3VuZHdvcmsgZm9yIGF1dG9tYXRpYyBjYXNlIGxvb2t1cDog' +
  'dGhlc2UgcG9ydGFscyBjYW4ndCBiZQogICAgICAgIHJlYWNoZWQgZnJvbSB3aGVyZSB0aGlzIGFwcCB3YXMgd3JpdHRlbiwgc28g' +
  'dGhlIHNlcnZlciBoYXMgdG8gZ28gYW5kIGxvb2suIFJ1biBvbmUgYW5kIHNlbmQgbWUgdGhlIHJlc3VsdC48L3A+CiAgICAgIDxk' +
  'aXYgY2xhc3M9InJvdyIgaWQ9InByb2JlQnRucyIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+JHtwb3J0YWxzLm1hcChwdCA9Pgog' +
  'ICAgICAgIGA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBkYXRhLXByb2JlPSIke2VzYyhwdC5rZXkpfSI+JHtlc2MocHQubGFi' +
  'ZWwpfTwvYnV0dG9uPmApLmpvaW4oJycpfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEw' +
  'cHgiPgogICAgICAgIDxpbnB1dCBpZD0icHJvYmVVcmwiIHBsYWNlaG9sZGVyPSLigKZvciBhIHNwZWNpZmljIHBhZ2UgVVJMIiBz' +
  'dHlsZT0iZmxleDoxO21pbi13aWR0aDoxNTBweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9InByb2Jl' +
  'R28iPlByb2JlIFVSTDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPHByZSBjbGFzcz0icHJldiIgaWQ9InByb2JlT3V0IiBz' +
  'dHlsZT0iZGlzcGxheTpub25lO21hcmdpbi10b3A6MTBweCI+PC9wcmU+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20g' +
  'YmxvY2siIGlkPSJjb3B5UHJvYmUiIHN0eWxlPSJkaXNwbGF5Om5vbmU7bWFyZ2luLXRvcDo4cHgiPkNvcHkgcmVzdWx0PC9idXR0' +
  'b24+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPk15IGFjY291bnQ8L2gyPgogICAgICA8ZGl2' +
  'IGNsYXNzPSJoaW50Ij5PbmUgcGFzc3dvcmQsIGV2ZXJ5IGFwcC4gQ2hhbmdpbmcgaXQgaGVyZSBjaGFuZ2VzIGl0IGV2ZXJ5d2hl' +
  'cmUuPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q3VycmVudCBwYXNzd29yZDwvbGFiZWw+PGlucHV0IGlk' +
  'PSJvcHciIHR5cGU9InBhc3N3b3JkIiBwbGFjZWhvbGRlcj0idGhlIG9uZSB5b3Ugc2lnbmVkIGluIHdpdGgiPjwvZGl2PgogICAg' +
  'ICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk5ldyBwYXNzd29yZDwvbGFiZWw+PGlucHV0IGlkPSJucHciIHR5cGU9InBhc3N3' +
  'b3JkIiBwbGFjZWhvbGRlcj0iOCsgY2hhcmFjdGVycyI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9InNh' +
  'dmVQdyI+VXBkYXRlIHBhc3N3b3JkPC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIGlkPSJidWlsZFN0YW1wIiBzdHls' +
  'ZT0ibWFyZ2luLXRvcDoxMnB4Ij5idWlsZCDigKY8L2Rpdj4KICAgIDwvZGl2PmApOwogIGJpbmRTaGVsbCgpOwoKICBmZXRjaCgn' +
  'L2FwaS9idWlsZCcpLnRoZW4ociA9PiByLmpzb24oKSkudGhlbihiID0+IHsKICAgIGNvbnN0IGVsID0gJCgnI2J1aWxkU3RhbXAn' +
  'KTsKICAgIGlmIChlbCkgZWwudGV4dENvbnRlbnQgPSAnU2VydmVUcmFjayBidWlsZCAnICsgYi5idWlsZCArIChiLnByb2JlVGFy' +
  'Z2V0cyA/ICcgwrcgYm9vdCBwcm9iZSBhcm1lZCcgOiAnJyk7CiAgfSkuY2F0Y2goKCkgPT4ge30pOwoKCiAgLyogLS0tLSBhY2Nl' +
  'c3MgY29kZXMgLS0tLSAqLwogIGFzeW5jIGZ1bmN0aW9uIGRyYXdDb2RlcygpIHsKICAgICQoJyNjX2xpc3QnKS5pbm5lckhUTUwg' +
  'PSBjb2Rlc1RhYmxlKGF3YWl0IGFwaSgnL2NvZGVzJykpOwogICAgd2lyZUNvZGVzKCk7CiAgfQoKICBmdW5jdGlvbiB3aXJlQ29k' +
  'ZXMoKSB7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1jb3B5XScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sg' +
  'PSBhc3luYyBlID0+IHsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICB0cnkgeyBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJv' +
  'YXJkLndyaXRlVGV4dChhLmRhdGFzZXQuY29weSk7IHRvYXN0KCdDb3BpZWQgJyArIGEuZGF0YXNldC5jb3B5KTsgfQogICAgICBj' +
  'YXRjaCAoZXJyKSB7IHRvYXN0KCdTZWxlY3QgaXQgYW5kIGNvcHkgYnkgaGFuZCcsIHRydWUpOyB9CiAgICB9KTsKICAgIGRvY3Vt' +
  'ZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXJldm9rZV0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNrID0gYXN5bmMgZSA9PiB7' +
  'CiAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgaWYgKCFjb25maXJtKCdSZXZva2UgdGhpcyBjb2RlPyBBbnlvbmUgd2hv' +
  'IGFscmVhZHkgdXNlZCBpdCBrZWVwcyB0aGVpciBhY2NvdW50LicpKSByZXR1cm47CiAgICAgIGF3YWl0IGFwaSgnL2NvZGVzLycg' +
  'KyBhLmRhdGFzZXQucmV2b2tlLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyByZXZva2VkOiB0cnVl' +
  'IH0pIH0pOwogICAgICB0b2FzdCgnUmV2b2tlZCcpOyBkcmF3Q29kZXMoKTsKICAgIH0pOwogIH0KICB3aXJlQ29kZXMoKTsKCiAg' +
  'JCgnI2NfbWFrZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBjb25zdCBtYWRlID0gYXdhaXQgYXBp' +
  'KCcvY29kZXMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgcm9sZTogJCgnI2Nfcm9s' +
  'ZScpLnZhbHVlLAogICAgICAgIG1heF91c2VzOiAkKCcjY191c2VzJykudmFsdWUsCiAgICAgICAgZXhwaXJlc19hdDogJCgnI2Nf' +
  'ZXhwJykudmFsdWUgfHwgbnVsbCwKICAgICAgICBkZWZhdWx0X3BheTogJCgnI2NfcGF5JykudmFsdWUgfHwgMCwKICAgICAgICBu' +
  'b3RlOiAkKCcjY19ub3RlJykudmFsdWUKICAgICAgfSkgfSk7CiAgICAgICQoJyNjX25vdGUnKS52YWx1ZSA9ICcnOwogICAgICB0' +
  'b2FzdCgnQ29kZSAnICsgbWFkZS5jb2RlKTsKICAgICAgZHJhd0NvZGVzKCk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVz' +
  'c2FnZSwgdHJ1ZSk7IH0KICB9OwogIGRyYXdDb2RlcygpLmNhdGNoKCgpID0+IHt9KTsKCiAgLyogLS0tLSBwb3J0YWwgcHJvYmUg' +
  'LS0tLSAqLwogIGNvbnN0IHByb2JlT3V0ID0gJCgnI3Byb2JlT3V0Jyk7CiAgY29uc3QgcnVuUHJvYmUgPSBhc3luYyBib2R5ID0+' +
  'IHsKICAgIHByb2JlT3V0LnN0eWxlLmRpc3BsYXkgPSAnJzsKICAgIHByb2JlT3V0LnRleHRDb250ZW50ID0gJ1Byb2JpbmfigKYg' +
  'KHRoaXMgY2FuIHRha2UgdXAgdG8gMjAgc2Vjb25kcyknOwogICAgJCgnI2NvcHlQcm9iZScpLnN0eWxlLmRpc3BsYXkgPSAnJzsK' +
  'ICAgIHRyeSB7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9wb3J0YWwtcHJvYmUnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5' +
  'OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KTsKICAgICAgcHJvYmVPdXQudGV4dENvbnRlbnQgPSBKU09OLnN0cmluZ2lmeShyLCBu' +
  'dWxsLCAyKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgcHJvYmVPdXQudGV4dENvbnRlbnQgPSAnUHJvYmUgZmFpbGVkOiAnICsg' +
  'ZS5tZXNzYWdlOwogICAgfQogIH07CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcHJvYmVdJykuZm9yRWFjaChi' +
  'ID0+CiAgICBiLm9uY2xpY2sgPSAoKSA9PiBydW5Qcm9iZSh7IHBvcnRhbDogYi5kYXRhc2V0LnByb2JlIH0pKTsKICAkKCcjcHJv' +
  'YmVHbycpLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBjb25zdCB1ID0gJCgnI3Byb2JlVXJsJykudmFsdWUudHJpbSgpOwogICAgaWYg' +
  'KHUpIHJ1blByb2JlKHsgdXJsOiB1IH0pOwogIH07CiAgJCgnI2NvcHlQcm9iZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAg' +
  'ICB0cnkgeyBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dChwcm9iZU91dC50ZXh0Q29udGVudCk7IHRvYXN0KCdD' +
  'b3BpZWQnKTsgfQogICAgY2F0Y2ggKGUpIHsgdG9hc3QoJ1NlbGVjdCB0aGUgdGV4dCBhbmQgY29weSBpdCBieSBoYW5kJywgdHJ1' +
  'ZSk7IH0KICB9OwoKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS11c2VyXScpLmZvckVhY2goYSA9PiBhLm9uY2xp' +
  'Y2sgPSBlID0+IHsKICAgIGUucHJldmVudERlZmF1bHQoKTsgdXNlckZvcm0odXNlcnMuZmluZCh1ID0+IFN0cmluZyh1LmlkKSA9' +
  'PT0gYS5kYXRhc2V0LnVzZXIpKTsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1jbGllbnRdJykuZm9y' +
  'RWFjaChhID0+IGEub25jbGljayA9IGUgPT4gewogICAgZS5wcmV2ZW50RGVmYXVsdCgpOyBjbGllbnRGb3JtKGNsaWVudHMuZmlu' +
  'ZChjID0+IFN0cmluZyhjLmlkKSA9PT0gYS5kYXRhc2V0LmNsaWVudCkpOwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JB' +
  'bGwoJ1tkYXRhLXRwbF0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNrID0gZSA9PiB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7IHRl' +
  'bXBsYXRlRm9ybSh0ZW1wbGF0ZXMuZmluZCh0ID0+IFN0cmluZyh0LmlkKSA9PT0gYS5kYXRhc2V0LnRwbCkpOwogIH0pOwogIGNv' +
  'bnN0IGNvU2F2ZSA9ICQoJyNjb1NhdmUnKTsKICBpZiAoY29TYXZlKSBjb1NhdmUub25jbGljayA9IGFzeW5jICgpID0+IHsKICAg' +
  'IHRyeSB7CiAgICAgIGF3YWl0IGFwaSgnL2NvbXBhbmllcy8nICsgKGhlcmUuaWQpLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTog' +
  'SlNPTi5zdHJpbmdpZnkoewogICAgICAgIG5hbWU6ICQoJyNjb05hbWUnKS52YWx1ZSwgY29udGFjdF9lbWFpbDogJCgnI2NvRW1h' +
  'aWwnKS52YWx1ZSwgcGhvbmU6ICQoJyNjb1Bob25lJykudmFsdWUgfSkgfSk7CiAgICAgIFMubWUgPSBhd2FpdCBhcGkoJy9tZScp' +
  'OwogICAgICB0b2FzdCgnQ29tcGFueSBzYXZlZCcpOwogICAgICByZW5kZXIoKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5t' +
  'ZXNzYWdlLCB0cnVlKTsgfQogIH07CiAgY29uc3QgbmV3Q28gPSAkKCcjbmV3Q28nKTsKICBpZiAobmV3Q28pIG5ld0NvLm9uY2xp' +
  'Y2sgPSBhc3luYyAoKSA9PiB7CiAgICBjb25zdCBuYW1lID0gJCgnI25ld0NvTmFtZScpLnZhbHVlLnRyaW0oKTsKICAgIGlmICgh' +
  'bmFtZSkgcmV0dXJuIHRvYXN0KCdHaXZlIHRoZSBjb21wYW55IGEgbmFtZScsIHRydWUpOwogICAgdHJ5IHsKICAgICAgYXdhaXQg' +
  'YXBpKCcvY29tcGFuaWVzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBuYW1lIH0pIH0pOwogICAg' +
  'ICBTLm1lID0gYXdhaXQgYXBpKCcvbWUnKTsKICAgICAgdG9hc3QobmFtZSArICcgY3JlYXRlZCcpOwogICAgICByZW5kZXIoKTsK' +
  'ICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFs' +
  'bCgnW2RhdGEtZW50ZXJdJykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGFzeW5jIGUgPT4gewogICAgZS5wcmV2ZW50RGVmYXVs' +
  'dCgpOwogICAgdHJ5IHsKICAgICAgY29uc3Qgb3V0ID0gYXdhaXQgYXBpKCcvY29tcGFuaWVzLycgKyBhLmRhdGFzZXQuZW50ZXIg' +
  'KyAnL2VudGVyJywgeyBtZXRob2Q6ICdQT1NUJyB9KTsKICAgICAgUy5tZSA9IGF3YWl0IGFwaSgnL21lJyk7CiAgICAgIHRvYXN0' +
  'KCdOb3cgaW4gJyArIG91dC5jb21wYW55Lm5hbWUpOwogICAgICByZW5kZXIoKTsKICAgIH0gY2F0Y2ggKGVycikgeyB0b2FzdChl' +
  'cnIubWVzc2FnZSwgdHJ1ZSk7IH0KICB9KTsKICAkKCcjbmV3VXNlcicpLm9uY2xpY2sgPSAoKSA9PiB1c2VyRm9ybShudWxsKTsK' +
  'ICAkKCcjbmV3Q2xpZW50Jykub25jbGljayA9ICgpID0+IGNsaWVudEZvcm0obnVsbCk7CiAgJCgnI25ld1RwbCcpLm9uY2xpY2sg' +
  'PSAoKSA9PiB0ZW1wbGF0ZUZvcm0obnVsbCk7CiAgJCgnI3NhdmVQdycpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkg' +
  'ewogICAgICBjb25zdCByID0gYXdhaXQgYXBpKCcvbWUvcGFzc3dvcmQnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0' +
  'cmluZ2lmeSh7CiAgICAgICAgcGFzc3dvcmQ6ICQoJyNucHcnKS52YWx1ZSwgb2xkX3Bhc3N3b3JkOiAkKCcjb3B3JykudmFsdWUg' +
  'fSkgfSk7CiAgICAgICQoJyNvcHcnKS52YWx1ZSA9ICcnOyAkKCcjbnB3JykudmFsdWUgPSAnJzsKICAgICAgdG9hc3Qoci5ldmVy' +
  'eXdoZXJlID09PSBmYWxzZSA/ICdDaGFuZ2VkIGhlcmUg4oCUIG90aGVyIGFwcHMgc3RpbGwgaGF2ZSB0aGUgb2xkIG9uZScgOiAn' +
  'UGFzc3dvcmQgdXBkYXRlZCBldmVyeXdoZXJlJyk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0K' +
  'ICB9Owp9CgpmdW5jdGlvbiB1c2VyRm9ybSh1KSB7CiAgY29uc3QgdiA9IHUgfHwgeyByb2xlOiAnc2VydmVyJywgYWN0aXZlOiB0' +
  'cnVlIH07CiAgc2hlZXQodSA/ICdFZGl0ICcgKyB1Lm5hbWUgOiAnQWRkIHBlcnNvbicsIGAKICAgIDxkaXYgY2xhc3M9ImZpZWxk' +
  'Ij48bGFiZWw+TmFtZTwvbGFiZWw+PGlucHV0IGlkPSJ1X25hbWUiIHZhbHVlPSIke2VzYyh2Lm5hbWUpfSI+PC9kaXY+CiAgICA8' +
  'ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkVtYWlsICh1c2VkIHRvIHNpZ24gaW4pPC9sYWJlbD48aW5wdXQgaWQ9InVfZW1haWwi' +
  'IHR5cGU9ImVtYWlsIiB2YWx1ZT0iJHtlc2Modi5lbWFpbCl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+' +
  'JHt1ID8gJ05ldyBwYXNzd29yZCAobGVhdmUgYmxhbmsgdG8ga2VlcCknIDogJ1Bhc3N3b3JkJ308L2xhYmVsPjxpbnB1dCBpZD0i' +
  'dV9wYXNzd29yZCIgdHlwZT0idGV4dCIgcGxhY2Vob2xkZXI9IiR7dSA/ICd1bmNoYW5nZWQnIDogJ3NldCBhIHBhc3N3b3JkJ30i' +
  'PjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Um9sZTwvbGFi' +
  'ZWw+PHNlbGVjdCBpZD0idV9yb2xlIj4KICAgICAgICA8b3B0aW9uIHZhbHVlPSJzZXJ2ZXIiICR7di5yb2xlID09PSAnc2VydmVy' +
  'JyA/ICdzZWxlY3RlZCcgOiAnJ30+RmllbGQgc2VydmVyPC9vcHRpb24+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYWRtaW4iICR7' +
  'di5yb2xlID09PSAnYWRtaW4nID8gJ3NlbGVjdGVkJyA6ICcnfT5BZG1pbjwvb3B0aW9uPgogICAgICAgICR7aXNPd25lcigpID8g' +
  'YDxvcHRpb24gdmFsdWU9Im93bmVyIiAke3Yucm9sZSA9PT0gJ293bmVyJyA/ICdzZWxlY3RlZCcgOiAnJ30+T3duZXIgKGV2ZXJ5' +
  'IGNvbXBhbnkpPC9vcHRpb24+YCA6ICcnfQogICAgICA8L3NlbGVjdD48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxs' +
  'YWJlbD5EZWZhdWx0IHBheSBwZXIgc2VydmU8L2xhYmVsPjxpbnB1dCBpZD0idV9kZWZhdWx0X3BheSIgdHlwZT0ibnVtYmVyIiBz' +
  'dGVwPSIwLjAxIiB2YWx1ZT0iJHt2LmRlZmF1bHRfcGF5IHx8ICcnfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48' +
  'bGFiZWw+UGhvbmU8L2xhYmVsPjxpbnB1dCBpZD0idV9waG9uZSIgdmFsdWU9IiR7ZXNjKHYucGhvbmUpfSI+PC9kaXY+CiAgICAg' +
  'IDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+TGljZW5zZSAvIHJlZ2lzdHJhdGlvbiAjPC9sYWJlbD48aW5wdXQgaWQ9InVfbGlj' +
  'ZW5zZV9ubyIgdmFsdWU9IiR7ZXNjKHYubGljZW5zZV9ubyl9Ij48L2Rpdj4KICAgIDwvZGl2PgogICAgJHt1ID8gYDxkaXYgY2xh' +
  'c3M9ImZpZWxkIj48bGFiZWw+U3RhdHVzPC9sYWJlbD48c2VsZWN0IGlkPSJ1X2FjdGl2ZSI+CiAgICAgIDxvcHRpb24gdmFsdWU9' +
  'InRydWUiICR7di5hY3RpdmUgPyAnc2VsZWN0ZWQnIDogJyd9PkFjdGl2ZTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJm' +
  'YWxzZSIgJHshdi5hY3RpdmUgPyAnc2VsZWN0ZWQnIDogJyd9PkRlYWN0aXZhdGVkPC9vcHRpb24+PC9zZWxlY3Q+PC9kaXY+YCA6' +
  'ICcnfQogICAgPGRpdiBjbGFzcz0icm93Ij48YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJzYXZlIj5TYXZlPC9idXR0b24+CiAgICA8' +
  'YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNhbmNlbDwvYnV0dG9uPjwvZGl2PmAsIGVsID0+' +
  'IHsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNzYXZlJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgYm9keSA9' +
  'IHsKICAgICAgICBuYW1lOiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9uYW1lJykudmFsdWUsIGVtYWlsOiBlbC5xdWVyeVNlbGVjdG9y' +
  'KCcjdV9lbWFpbCcpLnZhbHVlLAogICAgICAgIHJvbGU6IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X3JvbGUnKS52YWx1ZSwgcGhvbmU6' +
  'IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X3Bob25lJykudmFsdWUsCiAgICAgICAgbGljZW5zZV9ubzogZWwucXVlcnlTZWxlY3Rvcign' +
  'I3VfbGljZW5zZV9ubycpLnZhbHVlLAogICAgICAgIGRlZmF1bHRfcGF5OiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9kZWZhdWx0X3Bh' +
  'eScpLnZhbHVlIHx8IDAKICAgICAgfTsKICAgICAgY29uc3QgcHcgPSBlbC5xdWVyeVNlbGVjdG9yKCcjdV9wYXNzd29yZCcpLnZh' +
  'bHVlOwogICAgICBpZiAocHcpIGJvZHkucGFzc3dvcmQgPSBwdzsKICAgICAgaWYgKHUpIGJvZHkuYWN0aXZlID0gZWwucXVlcnlT' +
  'ZWxlY3RvcignI3VfYWN0aXZlJykudmFsdWUgPT09ICd0cnVlJzsKICAgICAgdHJ5IHsKICAgICAgICBhd2FpdCAodSA/IGFwaSgn' +
  'L3VzZXJzLycgKyB1LmlkLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSkKICAgICAgICAg' +
  'ICAgICAgICA6IGFwaSgnL3VzZXJzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSkpOwog' +
  'ICAgICAgIGNsb3NlU2hlZXQoKTsgdG9hc3QoJ1NhdmVkJyk7IGdvKCdhZG1pbicpOwogICAgICB9IGNhdGNoIChlKSB7IHRvYXN0' +
  'KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICAgIH07CiAgfSk7Cn0KCmZ1bmN0aW9uIGNsaWVudEZvcm0oYykgewogIGNvbnN0IHYgPSBj' +
  'IHx8IHt9OwogIHNoZWV0KGMgPyAnRWRpdCAnICsgYy5uYW1lIDogJ0FkZCBjbGllbnQnLCBgCiAgICA8ZGl2IGNsYXNzPSJmaWVs' +
  'ZCI+PGxhYmVsPkZpcm0gLyBjbGllbnQgbmFtZTwvbGFiZWw+PGlucHV0IGlkPSJjX25hbWUiIHZhbHVlPSIke2VzYyh2Lm5hbWUp' +
  'fSI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Db250YWN0' +
  'PC9sYWJlbD48aW5wdXQgaWQ9ImNfY29udGFjdF9uYW1lIiB2YWx1ZT0iJHtlc2Modi5jb250YWN0X25hbWUpfSI+PC9kaXY+CiAg' +
  'ICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGhvbmU8L2xhYmVsPjxpbnB1dCBpZD0iY19waG9uZSIgdmFsdWU9IiR7ZXNj' +
  'KHYucGhvbmUpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RW1haWw8L2xhYmVsPjxpbnB1dCBpZD0i' +
  'Y19lbWFpbCIgdHlwZT0iZW1haWwiIHZhbHVlPSIke2VzYyh2LmVtYWlsKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVs' +
  'ZCI+PGxhYmVsPkRlZmF1bHQgZmVlIHBlciBzZXJ2ZTwvbGFiZWw+PGlucHV0IGlkPSJjX2RlZmF1bHRfZmVlIiB0eXBlPSJudW1i' +
  'ZXIiIHN0ZXA9IjAuMDEiIHZhbHVlPSIke3YuZGVmYXVsdF9mZWUgfHwgJyd9Ij48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBj' +
  'bGFzcz0iZmllbGQiPjxsYWJlbD5CaWxsaW5nIGFkZHJlc3M8L2xhYmVsPjx0ZXh0YXJlYSBpZD0iY19hZGRyZXNzIiBzdHlsZT0i' +
  'bWluLWhlaWdodDo2MHB4Ij4ke2VzYyh2LmFkZHJlc3MpfTwvdGV4dGFyZWE+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+' +
  'PGxhYmVsPk5vdGVzPC9sYWJlbD48dGV4dGFyZWEgaWQ9ImNfbm90ZXMiIHN0eWxlPSJtaW4taGVpZ2h0OjYwcHgiPiR7ZXNjKHYu' +
  'bm90ZXMpfTwvdGV4dGFyZWE+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJyb3ciPjxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InNhdmUi' +
  'PlNhdmU8L2J1dHRvbj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIG9uY2xpY2s9ImNsb3NlU2hlZXQoKSI+Q2FuY2VsPC9i' +
  'dXR0b24+PC9kaXY+YCwgZWwgPT4gewogICAgZWwucXVlcnlTZWxlY3RvcignI3NhdmUnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4g' +
  'ewogICAgICBjb25zdCBib2R5ID0ge307CiAgICAgIFsnbmFtZScsJ2NvbnRhY3RfbmFtZScsJ3Bob25lJywnZW1haWwnLCdkZWZh' +
  'dWx0X2ZlZScsJ2FkZHJlc3MnLCdub3RlcyddCiAgICAgICAgLmZvckVhY2goZiA9PiBib2R5W2ZdID0gZWwucXVlcnlTZWxlY3Rv' +
  'cignI2NfJyArIGYpLnZhbHVlKTsKICAgICAgdHJ5IHsKICAgICAgICBhd2FpdCAoYyA/IGFwaSgnL2NsaWVudHMvJyArIGMuaWQs' +
  'IHsgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KQogICAgICAgICAgICAgICAgIDogYXBpKCcv' +
  'Y2xpZW50cycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pKTsKICAgICAgICBjbG9zZVNo' +
  'ZWV0KCk7IHRvYXN0KCdTYXZlZCcpOyBnbygnYWRtaW4nKTsKICAgICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRy' +
  'dWUpOyB9CiAgICB9OwogIH0pOwp9Cgphc3luYyBmdW5jdGlvbiB0ZW1wbGF0ZUZvcm0odCkgewogIGNvbnN0IGZpZWxkcyA9IGF3' +
  'YWl0IGFwaSgnL3RlbXBsYXRlLWZpZWxkcycpOwogIGNvbnN0IHYgPSB0IHx8IHsgYm9keTogJycsIGlzX2RlZmF1bHQ6IGZhbHNl' +
  'IH07CiAgc2hlZXQodCA/ICdFZGl0IHRlbXBsYXRlJyA6ICdOZXcgYWZmaWRhdml0IHRlbXBsYXRlJywgYAogICAgPGRpdiBjbGFz' +
  'cz0iZ3JpZCBnMiI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+VGVtcGxhdGUgbmFtZTwvbGFiZWw+PGlucHV0IGlk' +
  'PSJ0X25hbWUiIHZhbHVlPSIke2VzYyh2Lm5hbWUpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+SnVy' +
  'aXNkaWN0aW9uIC8gY291cnQ8L2xhYmVsPjxpbnB1dCBpZD0idF9qdXJpc2RpY3Rpb24iIHZhbHVlPSIke2VzYyh2Lmp1cmlzZGlj' +
  'dGlvbil9Ij48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Cb2R5PC9sYWJlbD4KICAgICAg' +
  'PHRleHRhcmVhIGlkPSJ0X2JvZHkiIHN0eWxlPSJtaW4taGVpZ2h0OjIyMHB4O2ZvbnQ6MTIuNXB4LzEuNSAnQ291cmllciBOZXcn' +
  'LG1vbm9zcGFjZSI+JHtlc2Modi5ib2R5KX08L3RleHRhcmVhPgogICAgICA8ZGl2IGNsYXNzPSJoaW50Ij5DbGljayBhIGZpZWxk' +
  'IHRvIGluc2VydCBpdCBhdCB0aGUgY3Vyc29yOjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0b2tlbnMiPiR7ZmllbGRzLm1hcChm' +
  'ID0+IGA8YnV0dG9uIGRhdGEtZj0iJHtmWzBdfSIgdGl0bGU9IiR7ZXNjKGZbMV0pfSI+e3ske2ZbMF19fX08L2J1dHRvbj5gKS5q' +
  'b2luKCcnKX08L2Rpdj4KICAgIDwvZGl2PgogICAgPGxhYmVsIHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVy' +
  'O2dhcDo4cHgiPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgaWQ9InRfZGVmYXVsdCIgc3R5bGU9IndpZHRoOmF1dG8iICR7di5pc19k' +
  'ZWZhdWx0ID8gJ2NoZWNrZWQnIDogJyd9PiBVc2UgYXMgdGhlIGRlZmF1bHQgdGVtcGxhdGU8L2xhYmVsPgogICAgPGRpdiBjbGFz' +
  'cz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0ic2F2ZSI+U2F2ZTwv' +
  'YnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBpZD0icHJldmlldyI+UHJldmlldyB3aXRoIHJlYWwgam9iPC9i' +
  'dXR0b24+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIG9uY2xpY2s9ImNsb3NlU2hlZXQoKSI+Q2FuY2VsPC9idXR0b24+' +
  'CiAgICAgICR7dCA/ICc8YnV0dG9uIGNsYXNzPSJidG4gZ2hvc3QiIGlkPSJkZWwiIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQpO21h' +
  'cmdpbi1sZWZ0OmF1dG8iPkRlbGV0ZTwvYnV0dG9uPicgOiAnJ30KICAgIDwvZGl2PgogICAgPHByZSBjbGFzcz0icHJldiIgaWQ9' +
  'InRwcmV2IiBzdHlsZT0iZGlzcGxheTpub25lO21hcmdpbi10b3A6MTJweCI+PC9wcmU+YCwgZWwgPT4gewogICAgY29uc3QgdGEg' +
  'PSBlbC5xdWVyeVNlbGVjdG9yKCcjdF9ib2R5Jyk7CiAgICBlbC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1mXScpLmZvckVhY2go' +
  'YiA9PiBiLm9uY2xpY2sgPSAoKSA9PiB7CiAgICAgIGNvbnN0IHRvayA9ICd7eycgKyBiLmRhdGFzZXQuZiArICd9fSc7CiAgICAg' +
  'IGNvbnN0IHMgPSB0YS5zZWxlY3Rpb25TdGFydCwgZSA9IHRhLnNlbGVjdGlvbkVuZDsKICAgICAgdGEudmFsdWUgPSB0YS52YWx1' +
  'ZS5zbGljZSgwLCBzKSArIHRvayArIHRhLnZhbHVlLnNsaWNlKGUpOwogICAgICB0YS5mb2N1cygpOyB0YS5zZWxlY3Rpb25TdGFy' +
  'dCA9IHRhLnNlbGVjdGlvbkVuZCA9IHMgKyB0b2subGVuZ3RoOwogICAgfSk7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjcHJldmll' +
  'dycpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy90ZW1wbGF0ZXMvcHJldmlldycs' +
  'IHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgYm9keTogdGEudmFsdWUgfSkgfSk7CiAgICAgIGNvbnN0' +
  'IHAgPSBlbC5xdWVyeVNlbGVjdG9yKCcjdHByZXYnKTsKICAgICAgcC5zdHlsZS5kaXNwbGF5ID0gJyc7IHAudGV4dENvbnRlbnQg' +
  'PSByLnRleHQ7CiAgICB9OwogICAgZWwucXVlcnlTZWxlY3RvcignI3NhdmUnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAg' +
  'ICBjb25zdCBib2R5ID0gewogICAgICAgIG5hbWU6IGVsLnF1ZXJ5U2VsZWN0b3IoJyN0X25hbWUnKS52YWx1ZSwganVyaXNkaWN0' +
  'aW9uOiBlbC5xdWVyeVNlbGVjdG9yKCcjdF9qdXJpc2RpY3Rpb24nKS52YWx1ZSwKICAgICAgICBib2R5OiB0YS52YWx1ZSwgaXNf' +
  'ZGVmYXVsdDogZWwucXVlcnlTZWxlY3RvcignI3RfZGVmYXVsdCcpLmNoZWNrZWQKICAgICAgfTsKICAgICAgaWYgKCFib2R5Lm5h' +
  'bWUudHJpbSgpKSByZXR1cm4gdG9hc3QoJ0dpdmUgdGhlIHRlbXBsYXRlIGEgbmFtZScsIHRydWUpOwogICAgICB0cnkgewogICAg' +
  'ICAgIGF3YWl0ICh0ID8gYXBpKCcvdGVtcGxhdGVzLycgKyB0LmlkLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJp' +
  'bmdpZnkoYm9keSkgfSkKICAgICAgICAgICAgICAgICA6IGFwaSgnL3RlbXBsYXRlcycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6' +
  'IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pKTsKICAgICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KCdTYXZlZCcpOyBnbygnYWRtaW4n' +
  'KTsKICAgICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgICB9OwogICAgaWYgKGVsLnF1ZXJ5U2Vs' +
  'ZWN0b3IoJyNkZWwnKSkgZWwucXVlcnlTZWxlY3RvcignI2RlbCcpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGlmICgh' +
  'Y29uZmlybSgnRGVsZXRlIHRoaXMgdGVtcGxhdGU/JykpIHJldHVybjsKICAgICAgYXdhaXQgYXBpKCcvdGVtcGxhdGVzLycgKyB0' +
  'LmlkLCB7IG1ldGhvZDogJ0RFTEVURScgfSk7CiAgICAgIGNsb3NlU2hlZXQoKTsgdG9hc3QoJ0RlbGV0ZWQnKTsgZ28oJ2FkbWlu' +
  'Jyk7CiAgICB9OwogIH0pOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0gYm9vdCAtLSAqLwpjb25zdCBWSUVXUyA9IHsgZGFzaDogZGFzaFZpZXcsIGpvYnM6IGpvYnNWaWV3LCBqb2I6' +
  'IGpvYlZpZXcsIHNjYW46IHNjYW5WaWV3LAogIHRvb2xzOiB0b29sc1ZpZXcsIHByb3BlcnR5OiBwcm9wZXJ0eVZpZXcsIG1vbmV5' +
  'OiBtb25leVZpZXcsIGFkbWluOiBhZG1pblZpZXcgfTsKCmFzeW5jIGZ1bmN0aW9uIHJlbmRlcigpIHsKICBjbG9zZVNoZWV0KCk7' +
  'CiAgaWYgKCFTLm1lKSByZXR1cm4gbG9naW5WaWV3KCk7CiAgaWYgKFMudmlldyA9PT0gJ2pvYnMnKSBTLmNhY2hlLmpvYkZpbHRl' +
  'ciA9IFMucGFyYW1zOwogIGNvbnN0IGZuID0gVklFV1NbUy52aWV3XSB8fCBkYXNoVmlldzsKICB0cnkgewogICAgYXBwLmlubmVy' +
  'SFRNTCA9ICc8ZGl2IGNsYXNzPSJ3cmFwIj48ZGl2IGNsYXNzPSJlbXB0eSI+TG9hZGluZ+KApjwvZGl2PjwvZGl2Pic7CiAgICBh' +
  'd2FpdCBmbigpOwogIH0gY2F0Y2ggKGUpIHsKICAgIGlmIChTLm1lKSB7IGFwcC5pbm5lckhUTUwgPSBzaGVsbChgPGRpdiBjbGFz' +
  'cz0iY2FyZCI+PGRpdiBjbGFzcz0iZW1wdHkiPiR7ZXNjKGUubWVzc2FnZSl9PC9kaXY+PC9kaXY+YCk7IGJpbmRTaGVsbCgpOyB9' +
  'CiAgfQp9CgooYXN5bmMgZnVuY3Rpb24gYm9vdCgpIHsKICB0cnkgeyBTLm1lID0gYXdhaXQgYXBpKCcvbWUnKTsgfSBjYXRjaCAo' +
  'ZSkgeyBTLm1lID0gbnVsbDsgfQogIHJlbmRlcigpOwp9KSgpOwp9KSgpOwoKPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo='
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
const BUILD = '2026-08-31.21';           // shown in Setup so uploads can be confirmed
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
labels, invoices or statements. Photographs taken at a service attempt cannot be
masked the way a name can, so in support view they are refused outright: the
operator is told only that photos exist, and never receives one. The operator
sees counts, statuses, dates and amounts — enough to fix a problem, not enough
to read your cases. Your own screens are never affected.</p>

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
<li><b>Photographs of service attempts:</b> a field server can attach photos to
an attempt — the door, the house number, a posted notice, a vehicle. They are
stored with that attempt, inside your company, and they appear on the affidavit
and on the report your client sees. Anyone in the photograph is there because
they were photographed at the address being served; the photos are evidence of
service and are used for nothing else. Your company's admins can delete any of
them at any time.</li>
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
  /* The platform operator is not one of a company's people. Their local record
     has to sit in some company for the app to have anywhere to put it, but it
     must never show up in a customer's team list, their "assign to" menus, or
     their pay statements — the company's staff are their own. Only an owner
     sees owners. */
  const hideOwners = req.user.role === 'owner' ? '' : " AND role <> 'owner'";
  const { rows } = await q(
    `SELECT id,name,email,role,phone,license_no,county,default_pay,active FROM users
     WHERE company_id=$1${hideOwners} ORDER BY active DESC, name`, [req.companyId]
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
    /* This ran before any of the checks below it, and it was scoped to nothing:
       an id was enough to set anyone's password, in any company, including an
       owner's. The same two rules that guard the update below now guard it —
       your own company only, and never an owner unless you are one. */
    const pw = String(b.password);
    const { rows: who } = await q(
      `SELECT email,name FROM users WHERE id=$1 AND company_id=$2 AND (role <> 'owner' OR $3)`,
      [req.params.id, req.companyId, req.user.role === 'owner']);
    if (!who.length) return res.status(404).json({ error: 'No such person in your company' });
    await q('UPDATE users SET password_hash=$1 WHERE id=$2 AND company_id=$3',
      [await bcrypt.hash(pw, 10), req.params.id, req.companyId]);
    centralNote = (await centralReset(who[0].email, pw, who[0].name)).note;
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
  /* Photos ride along with their attempt. In support view the operator is told
     how many exist — enough to answer "did the server document it?" — but
     never the ids, so there is nothing to fetch. */
  const { rows: pics } = await q(
    `SELECT id, attempt_id, caption, mime, bytes, width, height, created_at
     FROM attempt_photos WHERE job_id=$1 ORDER BY id`, [req.params.id]);
  const hidden = supportView(req);
  for (const a of att.rows) {
    const mine = pics.filter(p => p.attempt_id === a.id);
    a.photo_count = mine.length;
    a.photos = hidden ? [] : mine;
  }
  job.photos_hidden = hidden;
  job.attempts = hidden ? att.rows.map(a => maskFields(a, ATTEMPT_MASK)) : att.rows;
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

/* ------------------------------------------------------ attempt photos --- */
/* What a server photographs at the door is the strongest part of the record:
 * the house number, the car in the drive, the posted notice, the papers in
 * someone's hand. It belongs to the attempt, so it inherits the attempt's
 * permissions exactly — the company's admins, and the server whose job it is.
 *
 * The platform operator is the one person who must never see these. A photo
 * cannot be masked the way a name can, so in support view they are not listed,
 * not served, and not printed: the operator sees only that photos exist. */

const MAX_PHOTO_BYTES = 3 * 1024 * 1024;      // the phone sends ~200-400KB; this is the ceiling
const MAX_PHOTOS_PER_ATTEMPT = 12;
const PHOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Loads the attempt and proves the caller is allowed to touch it.
async function attemptForPhoto(req, id) {
  const { rows } = await q(
    `SELECT a.id, a.job_id, j.assigned_to FROM attempts a
     JOIN jobs j ON j.id = a.job_id
     WHERE a.id = $1 AND j.company_id = $2`, [id, req.companyId]);
  const att = rows[0];
  if (!att) return { error: 404, message: 'Attempt not found' };
  if (!isAdmin(req.user) && att.assigned_to !== req.user.id) {
    return { error: 403, message: 'Not your job' };
  }
  return { att };
}

app.post('/api/attempts/:id/photos', auth, wrap(async (req, res) => {
  if (supportView(req)) return res.status(403).json({ error: 'Not available in support view' });
  const { att, error, message } = await attemptForPhoto(req, req.params.id);
  if (error) return res.status(error).json({ error: message });

  const mime = String(req.body.mime || 'image/jpeg').toLowerCase();
  if (!PHOTO_MIME.has(mime)) {
    return res.status(400).json({ error: 'A photo has to be a JPEG, PNG or WebP' });
  }
  // Accepts a bare base64 string or a full data: URL, whichever the phone sent.
  const b64 = String(req.body.data || '').replace(/^data:[^,]*,/, '').trim();
  const buf = b64 ? Buffer.from(b64, 'base64') : null;
  if (!buf || !buf.length) return res.status(400).json({ error: 'That photo did not arrive' });
  if (buf.length > MAX_PHOTO_BYTES) {
    return res.status(413).json({ error: 'That photo is too big — try taking it again' });
  }

  const { rows: c } = await q('SELECT count(*)::int AS n FROM attempt_photos WHERE attempt_id=$1', [att.id]);
  if (c[0].n >= MAX_PHOTOS_PER_ATTEMPT) {
    return res.status(400).json({ error: `One attempt holds up to ${MAX_PHOTOS_PER_ATTEMPT} photos` });
  }

  const { rows } = await q(
    `INSERT INTO attempt_photos (attempt_id,job_id,company_id,caption,mime,bytes,width,height,data,taken_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, attempt_id, caption, mime, bytes, width, height, created_at`,
    [att.id, att.job_id, req.companyId, (req.body.caption || '').trim().slice(0, 300) || null,
     mime, buf.length, req.body.width || null, req.body.height || null, buf, req.user.id]);
  res.json(rows[0]);
}));

app.patch('/api/photos/:id', auth, wrap(async (req, res) => {
  if (supportView(req)) return res.status(403).json({ error: 'Not available in support view' });
  const { rows: pr } = await q(
    `SELECT p.id, p.attempt_id FROM attempt_photos p WHERE p.id=$1 AND p.company_id=$2`,
    [req.params.id, req.companyId]);
  if (!pr.length) return res.status(404).json({ error: 'Photo not found' });
  const { error, message } = await attemptForPhoto(req, pr[0].attempt_id);
  if (error) return res.status(error).json({ error: message });
  const { rows } = await q(
    `UPDATE attempt_photos SET caption=$1 WHERE id=$2 AND company_id=$3
     RETURNING id, attempt_id, caption, mime, bytes, width, height, created_at`,
    [(req.body.caption || '').trim().slice(0, 300) || null, req.params.id, req.companyId]);
  res.json(rows[0]);
}));

app.delete('/api/photos/:id', auth, wrap(async (req, res) => {
  if (supportView(req)) return res.status(403).json({ error: 'Not available in support view' });
  const { rows: pr } = await q(
    'SELECT id, attempt_id FROM attempt_photos WHERE id=$1 AND company_id=$2',
    [req.params.id, req.companyId]);
  if (!pr.length) return res.status(404).json({ error: 'Photo not found' });
  const { error, message } = await attemptForPhoto(req, pr[0].attempt_id);
  if (error) return res.status(error).json({ error: message });
  await q('DELETE FROM attempt_photos WHERE id=$1 AND company_id=$2', [req.params.id, req.companyId]);
  res.json({ ok: true });
}));

/* The bytes themselves. Same permission check as everything else — a photo is
   never reachable by guessing an id from another company. */
app.get('/photo/:id', auth, wrap(async (req, res) => {
  if (supportView(req)) return res.status(403).send('Not available in support view');
  const { rows } = await q(
    'SELECT attempt_id, mime, data FROM attempt_photos WHERE id=$1 AND company_id=$2',
    [req.params.id, req.companyId]);
  if (!rows.length) return res.status(404).send('Not found');
  /* A bytes URL answers "not found" for anything the caller may not have,
     rather than "forbidden" — there is no reason to confirm that someone
     else's photo exists at this id. */
  const { error } = await attemptForPhoto(req, rows[0].attempt_id);
  if (error) return res.status(404).send('Not found');
  res.set('Cache-Control', 'private, max-age=86400');
  res.type(rows[0].mime).send(rows[0].data);
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

  /* Photographs go on their own page after the sworn text, captioned with the
     attempt they belong to. A notary signs the words; the exhibit page is what
     answers "prove you were there" when service is challenged. Base64 keeps the
     print self-contained, so it survives being saved as a PDF or emailed. */
  const { rows: pics } = await q(
    `SELECT p.id, p.caption, p.mime, p.data, a.outcome, a.attempted_at
     FROM attempt_photos p JOIN attempts a ON a.id = p.attempt_id
     WHERE p.job_id = $1 AND p.company_id = $2
     ORDER BY a.attempted_at, p.id`, [req.params.id, req.companyId]);

  const exhibit = pics.length ? `
    <div style="page-break-before:always">
      <h1 style="font-size:15pt;margin:0 0 4px">EXHIBIT A — PHOTOGRAPHS OF SERVICE ATTEMPTS</h1>
      <div class="meta">${esc(out.job.job_number)}${out.job.case_number
        ? ' &nbsp;·&nbsp; Case ' + esc(out.job.case_number) : ''} &nbsp;·&nbsp;
        ${pics.length} photograph${pics.length > 1 ? 's' : ''}</div>
      ${pics.map((p, i) => `
        <div style="margin:14px 0;page-break-inside:avoid">
          <img src="data:${p.mime};base64,${p.data.toString('base64')}"
               style="max-width:100%;max-height:4.2in;border:1px solid #999">
          <div style="font-size:9.5pt;margin-top:3px">
            <b>Photo ${i + 1}</b> — ${esc(p.outcome)},
            ${new Date(p.attempted_at).toLocaleString('en-US', { timeZone: TZ })}${
              p.caption ? ' — ' + esc(p.caption) : ''}
          </div>
        </div>`).join('')}
    </div>` : '';

  res.send(printPage(`Affidavit ${out.job.job_number}`, `<pre>${esc(out.text)}</pre>${exhibit}`));
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

/* ------------------------------------------------------- receivables --- */
/* "Who owes me, and how long have they owed it."
 *
 * Aging is measured from the invoice date, in the usual 30/60/90 buckets a
 * bookkeeper expects. Everything is computed in SQL against invoices that are
 * not marked Paid, so this cannot drift from what the invoice list shows. */
app.get('/api/receivables', auth, admin, wrap(async (req, res) => {
  const { rows } = await q(`
    SELECT c.id AS client_id, c.name AS client_name, c.email, c.phone,
           count(*)::int                                   AS invoice_count,
           COALESCE(sum(i.total), 0)::float                AS balance,
           min(i.created_at)                               AS oldest_invoice,
           COALESCE(sum(i.total) FILTER (WHERE i.created_at >  NOW() - INTERVAL '30 days'), 0)::float AS d0,
           COALESCE(sum(i.total) FILTER (WHERE i.created_at <= NOW() - INTERVAL '30 days'
                                          AND i.created_at >  NOW() - INTERVAL '60 days'), 0)::float AS d30,
           COALESCE(sum(i.total) FILTER (WHERE i.created_at <= NOW() - INTERVAL '60 days'
                                          AND i.created_at >  NOW() - INTERVAL '90 days'), 0)::float AS d60,
           COALESCE(sum(i.total) FILTER (WHERE i.created_at <= NOW() - INTERVAL '90 days'), 0)::float AS d90
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.company_id = $1 AND i.status <> 'Paid'
    GROUP BY c.id, c.name, c.email, c.phone
    ORDER BY sum(i.total) DESC`, [req.companyId]);

  const clients = supportView(req) ? rows.map(r => maskFields(r, CLIENT_MASK)) : rows;
  const sum = k => clients.reduce((t, r) => t + Number(r[k] || 0), 0);
  res.json({
    clients,
    total: sum('balance'),
    buckets: { d0: sum('d0'), d30: sum('d30'), d60: sum('d60'), d90: sum('d90') },
    /* Work that is done but not yet on an invoice. Not money owed yet — money
       you have not asked for. Kept separate on purpose. */
    unbilled: (await q(`SELECT COALESCE(sum(client_fee),0)::float v FROM jobs
                        WHERE company_id=$1 AND invoice_id IS NULL AND status='Served'`,
                       [req.companyId])).rows[0].v
  });
}));

/* Every unpaid invoice for one attorney, for the statement of account. */
app.get('/api/receivables/:clientId', auth, admin, wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT i.* FROM invoices i WHERE i.client_id=$1 AND i.company_id=$2 AND i.status <> 'Paid'
     ORDER BY i.created_at`, [req.params.clientId, req.companyId]);
  res.json(rows);
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

/* ---------------------------------------------- attorney service report --- */
/* The affidavit is for the court. The invoice is for the money. Neither tells
 * the attorney what actually happened at the door — which is what they ring up
 * to ask about. This is that document: the whole story of a job, attempt by
 * attempt, with the photographs, in something you can email to a law firm.
 */
app.get('/print/report/:id', auth, wrap(async (req, res) => {
  if (noPrintInSupport(req, res)) return;
  const { rows: jr } = await q(
    `SELECT j.*, c.name AS client_name, c.contact_name, c.address AS client_address
     FROM jobs j LEFT JOIN clients c ON c.id=j.client_id
     WHERE j.id=$1 AND j.company_id=$2`, [req.params.id, req.companyId]);
  const j = jr[0];
  if (!j) return res.status(404).send('Not found');
  if (!isAdmin(req.user) && j.assigned_to !== req.user.id) return res.status(403).send('Not your job');

  const { rows: attempts } = await q(
    `SELECT a.*, u.name AS server_name FROM attempts a
     LEFT JOIN users u ON u.id=a.server_id WHERE a.job_id=$1 ORDER BY a.attempted_at`,
    [req.params.id]);
  const { rows: pics } = await q(
    `SELECT id, attempt_id, caption, mime, data FROM attempt_photos
     WHERE job_id=$1 AND company_id=$2 ORDER BY id`, [req.params.id, req.companyId]);

  const d  = v => v ? new Date(v).toLocaleDateString('en-US', { timeZone: TZ }) : '';
  const dt = v => v ? new Date(v).toLocaleString('en-US', { timeZone: TZ }) : '';
  const addr = [j.address1, j.address2, [j.city, j.state, j.zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  const served = j.status === 'Served';

  const row = (label, value) => value
    ? `<tr><th style="width:30%">${label}</th><td>${esc(value)}</td></tr>` : '';

  const timeline = attempts.length ? attempts.map((a, i) => {
    const mine = pics.filter(p => p.attempt_id === a.id);
    return `
    <div style="margin:0 0 16px;padding-left:12px;border-left:3px solid ${
      a.outcome === 'Served' ? '#0F7B45' : '#DBE4F2'};page-break-inside:avoid">
      <div style="font:600 13px system-ui">Attempt ${i + 1} — ${esc(a.outcome)}${
        a.manner ? ' (' + esc(a.manner) + ')' : ''}</div>
      <div style="font:12px system-ui;color:#5A6A80">${dt(a.attempted_at)}${
        a.server_name ? ' · served by ' + esc(a.server_name) : ''}</div>
      ${a.person_served ? `<div style="font:12px system-ui">Accepted by: <b>${esc(a.person_served)}</b>${
        a.relationship ? ' (' + esc(a.relationship) + ')' : ''}</div>` : ''}
      ${a.description ? `<div style="font:12px system-ui">Description: ${esc(a.description)}</div>` : ''}
      ${a.notes ? `<div style="font:12px system-ui;margin-top:3px">${esc(a.notes)}</div>` : ''}
      ${a.lat != null ? `<div style="font:11.5px system-ui;color:#5A6A80">GPS ${
        Number(a.lat).toFixed(5)}, ${Number(a.lng).toFixed(5)}${
        a.accuracy_m ? ' ±' + Math.round(a.accuracy_m) + 'm' : ''}</div>` : ''}
      ${mine.length ? `<div style="margin-top:8px">${mine.map(p => `
        <div style="display:inline-block;vertical-align:top;margin:0 8px 8px 0;width:2.3in">
          <img src="data:${p.mime};base64,${p.data.toString('base64')}"
               style="width:100%;border:1px solid #999">
          ${p.caption ? `<div style="font:10.5px system-ui;color:#5A6A80">${esc(p.caption)}</div>` : ''}
        </div>`).join('')}</div>` : ''}
    </div>`;
  }).join('') : '<p style="font:12px system-ui;color:#5A6A80">No attempts recorded yet.</p>';

  res.send(printPage('Service report ' + j.job_number, `
    <h1>${esc(await companyName(req.companyId))} — Service Report</h1>
    <div class="meta">
      <b>${esc(j.job_number)}</b>${j.case_number ? ' &nbsp;·&nbsp; Case ' + esc(j.case_number) : ''}
      &nbsp;·&nbsp; prepared ${d(new Date())}<br>
      ${j.client_name ? 'For: <b>' + esc(j.client_name) + '</b>' +
        (j.contact_name ? ' — ' + esc(j.contact_name) : '') : ''}
    </div>

    <h2>Status</h2>
    <p style="font:600 14px system-ui;color:${served ? '#0F7B45' : '#B45309'};margin:0">
      ${served ? 'SERVED — ' + dt(j.served_at) : esc(String(j.status || '').toUpperCase())}
      ${served && j.served_manner ? ' · ' + esc(j.served_manner) : ''}
      ${served && j.served_person ? ' · accepted by ' + esc(j.served_person) : ''}
    </p>
    <p style="font:12px system-ui;color:#5A6A80;margin:4px 0 0">
      ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}${
        pics.length ? ` · ${pics.length} photograph${pics.length === 1 ? '' : 's'}` : ''}</p>

    <h2>What we were asked to serve</h2>
    <table>
      ${row('Serve', j.recipient_name)}
      ${row('Address', addr)}
      ${row('Documents', j.documents)}
      ${row('Court', j.court)}
      ${row('Plaintiff', j.plaintiff)}
      ${row('Defendant', j.defendant)}
      ${row('Service type', j.service_type)}
      ${row('Received', d(j.created_at))}
      ${row('Due', d(j.due_date))}
    </table>

    <h2>What happened</h2>
    ${timeline}`));
}));

/* --------------------------------------------- statement of account --- */
/* Everything one attorney currently owes, oldest first — the page you attach
 * to "just checking in on these". */
app.get('/print/account/:clientId', auth, admin, wrap(async (req, res) => {
  if (noPrintInSupport(req, res)) return;
  const { rows: cr } = await q('SELECT * FROM clients WHERE id=$1 AND company_id=$2',
    [req.params.clientId, req.companyId]);
  const c = cr[0];
  if (!c) return res.status(404).send('Not found');
  const { rows: inv } = await q(
    `SELECT * FROM invoices WHERE client_id=$1 AND company_id=$2 AND status <> 'Paid'
     ORDER BY created_at`, [req.params.clientId, req.companyId]);

  const d = v => v ? new Date(v).toLocaleDateString('en-US', { timeZone: TZ }) : '';
  const days = v => Math.floor((Date.now() - new Date(v).getTime()) / 864e5);
  const total = inv.reduce((t, i) => t + Number(i.total || 0), 0);

  res.send(printPage('Statement of account — ' + c.name, `
    <h1>${esc(await companyName(req.companyId))} — Statement of Account</h1>
    <div class="meta">
      <b>${esc(c.name)}</b>${c.contact_name ? ' — ' + esc(c.contact_name) : ''}<br>
      ${esc(c.address || '')}<br>
      As of ${d(new Date())}
    </div>
    <table>
      <thead><tr><th>Invoice</th><th>Dated</th><th>Period</th>
        <th class="num">Age</th><th class="num">Amount</th></tr></thead>
      <tbody>
      ${inv.map(i => `<tr>
        <td>#${i.id}</td><td>${d(i.created_at)}</td>
        <td>${d(i.period_start)} – ${d(i.period_end)}</td>
        <td class="num">${days(i.created_at)} days</td>
        <td class="num">$${Number(i.total).toFixed(2)}</td></tr>`).join('')}
      <tr class="tot"><td colspan="4">${inv.length} unpaid invoice(s) — TOTAL DUE</td>
        <td class="num">$${total.toFixed(2)}</td></tr>
      </tbody>
    </table>
    ${inv.length ? '' : '<p style="font:12px system-ui;color:#0F7B45">Nothing outstanding — this account is clear.</p>'}`));
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
