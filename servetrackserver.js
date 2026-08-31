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
  'aCAtLSAqLwovKiBUd28gZGlmZmVyZW50IHJlY29yZHMgc3lzdGVtcywgYW5kIHRoZSBkaWZmZXJlbmNlIG1hdHRlcnM6CiAgIHRo' +
  'ZSBjb3VudHkgQ0xFUksgaG9sZHMgZGVlZHMgYW5kIGxpZW5zICh3aG8gYm91Z2h0LCBzb2xkLCBvciBoYXMgYSBjbGFpbSksCiAg' +
  'IHRoZSBBUFBSQUlTQUwgRElTVFJJQ1QgaG9sZHMgd2hvIG93bnMgaXQgbm93IGFuZCB3aGVyZSB0aGVpciB0YXggYmlsbCBpcwog' +
  'ICBwb3N0ZWQgLS0gd2hpY2ggaXMgdXN1YWxseSB0aGUgYmV0dGVyIGxlYWQgd2hlbiBhbiBhZGRyZXNzIGhhcyBnb25lIHN0YWxl' +
  'LiAqLwpjb25zdCBDT1VOVElFUyA9IFsKICB7CiAgICBuYW1lOiAnSGlkYWxnbyBDb3VudHknLAogICAgY2xlcms6IHsgdXJsOiAn' +
  'aHR0cHM6Ly9oaWRhbGdvLnR4LnB1YmxpY3NlYXJjaC51cy8nLCBub3RlOiAnRGVlZHMsIGxpZW5zLCB0cmFuc2ZlcnMuIEdyYW50' +
  'b3IvZ3JhbnRlZSwgZG9jIG51bWJlciwgZnVsbC10ZXh0IE9DUi4gTm8gbG9naW4uJyB9LAogICAgY2FkOiB7IHVybDogJ2h0dHBz' +
  'Oi8vaGlkYWxnby5wcm9kaWd5Y2FkLmNvbS9wcm9wZXJ0eS1zZWFyY2gnLCBub3RlOiAnQ3VycmVudCBvd25lciwgbWFpbGluZyBh' +
  'ZGRyZXNzLCBzaXR1cyBhZGRyZXNzLCB2YWx1YXRpb24uJyB9LAogICAgY2FkQWx0OiB7IHVybDogJ2h0dHBzOi8vcHJvcGFjY2Vz' +
  'cy5oaWRhbGdvYWQub3JnL0NsaWVudERCL1Byb3BlcnR5U2VhcmNoLmFzcHg/Y2lkPTEnLCBub3RlOiAnT2xkZXIgSGlkYWxnbyBD' +
  'QUQgc2VhcmNoLCBpZiB0aGUgbmV3IG9uZSBpcyBkb3duLicgfQogIH0sCiAgewogICAgbmFtZTogJ0NhbWVyb24gQ291bnR5JywK' +
  'ICAgIGNsZXJrOiB7IHVybDogJ2h0dHBzOi8vY2FtZXJvbi50eC5wdWJsaWNzZWFyY2gudXMvJywgbm90ZTogJ0RlZWRzLCBsaWVu' +
  'cywgdHJhbnNmZXJzLCBmb3JlY2xvc3VyZSBwb3N0aW5ncy4gTm8gbG9naW4uJyB9LAogICAgY2FkOiB7IHVybDogJ2h0dHBzOi8v' +
  'Y2FtZXJvbi5wcm9kaWd5Y2FkLmNvbS8nLCBub3RlOiAnQ3VycmVudCBvd25lciwgbWFpbGluZyBhZGRyZXNzLCBzaXR1cyBhZGRy' +
  'ZXNzLCB2YWx1YXRpb24uJyB9LAogICAgY2FkQWx0OiB7IHVybDogJ2h0dHA6Ly9wcm9wYWNjZXNzLmNhbWVyb25jYWQub3JnL2Ns' +
  'aWVudGRiL1Byb3BlcnR5U2VhcmNoLmFzcHg/Y2lkPTEnLCBub3RlOiAnT2xkZXIgQ2FtZXJvbiBDQUQgc2VhcmNoLCBpZiB0aGUg' +
  'bmV3IG9uZSBpcyBkb3duLicgfQogIH0sCiAgewogICAgbmFtZTogJ1N0YXJyIENvdW50eScsCiAgICBjbGVyazogeyB1cmw6ICdo' +
  'dHRwczovL3N0YXJyLnR4LnB1YmxpY3NlYXJjaC51cy8nLCBub3RlOiAnRGVlZHMsIGxpZW5zLCB0cmFuc2ZlcnMuIFNhbWUgc3lz' +
  'dGVtIGFzIEhpZGFsZ28gYW5kIENhbWVyb24uJyB9LAogICAgY2FkOiB7IHVybDogJ2h0dHBzOi8vZXNlYXJjaC5zdGFycmNhZC5v' +
  'cmcvJywgbm90ZTogJ0N1cnJlbnQgb3duZXIsIG1haWxpbmcgYWRkcmVzcywgc2l0dXMgYWRkcmVzcy4nIH0KICB9Cl07CgpmdW5j' +
  'dGlvbiBwcm9wZXJ0eVZpZXcoKSB7CiAgY29uc3Qgcm93cyA9IENPVU5USUVTLm1hcCgoYywgY2kpID0+IGAKICAgIDxkaXYgY2xh' +
  'c3M9ImNhcmQiPgogICAgICA8aDI+JHtlc2MoYy5uYW1lKX08L2gyPgogICAgICA8ZGl2IGNsYXNzPSJsaXN0Ij4KICAgICAgICA8' +
  'ZGl2IGNsYXNzPSJpdGVtIiBkYXRhLXByb3A9IiR7Y2l9OmNhZCI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ0Ij5BcHByYWlzYWwg' +
  'ZGlzdHJpY3Qg4oCUIHdobyBvd25zIGl0IG5vdzwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0ibSI+JHtlc2MoYy5jYWQubm90' +
  'ZSl9PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaXRlbSIgZGF0YS1wcm9wPSIke2NpfTpjbGVyayI+' +
  'CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ0Ij5Db3VudHkgY2xlcmsg4oCUIGRlZWRzICZhbXA7IGxpZW5zPC9kaXY+CiAgICAgICAg' +
  'ICA8ZGl2IGNsYXNzPSJtIj4ke2VzYyhjLmNsZXJrLm5vdGUpfTwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgICR7Yy5jYWRB' +
  'bHQgPyBgPGRpdiBjbGFzcz0iaXRlbSIgZGF0YS1wcm9wPSIke2NpfTpjYWRBbHQiPgogICAgICAgICAgPGRpdiBjbGFzcz0idCI+' +
  'QXBwcmFpc2FsIGRpc3RyaWN0IChvbGRlciBzZWFyY2gpPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJtIj4ke2VzYyhjLmNh' +
  'ZEFsdC5ub3RlKX08L2Rpdj4KICAgICAgICA8L2Rpdj5gIDogJyd9CiAgICAgIDwvZGl2PgogICAgPC9kaXY+YCkuam9pbignJyk7' +
  'CgogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8aDEgY2xhc3M9InBhZ2UiPlByb3BlcnR5IHJlY29yZHM8L2gxPgogICAg' +
  'PGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxsYWJlbD5OYW1lIG9yIGFkZHJlc3MgdG8gbG9vayB1cDwvbGFiZWw+CiAgICAgIDxk' +
  'aXYgY2xhc3M9InJvdyI+CiAgICAgICAgPGlucHV0IGlkPSJwcm9wUSIgcGxhY2Vob2xkZXI9IkdBUlpBIE1BUklBICBvciAgMTIw' +
  'NCBFIE1haW4gU3QiIHN0eWxlPSJmbGV4OjE7bWluLXdpZHRoOjE2MHB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc20i' +
  'IGlkPSJwcm9wQ29weSI+Q29weTwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPHAgY2xhc3M9ImhpbnQiPlRoZXNlIHNpdGVz' +
  'IGNhbid0IGJlIGxpbmtlZCB0byB3aXRoIGEgc2VhcmNoIHRlcm0sIHNvIHRhcHBpbmcgb25lIGNvcGllcyB3aGF0IHlvdSB0eXBl' +
  'ZAogICAgICAgIGFuZCBvcGVucyB0aGVpciBzZWFyY2ggcGFnZSDigJQgcGFzdGUgaXQgaW50byB0aGVpciBib3guPC9wPgogICAg' +
  'PC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6I2Y4ZmFmYztib3gtc2hhZG93Om5vbmUiPgog' +
  'ICAgICA8aDI+V2hpY2ggb25lIGRvIHlvdSB3YW50PzwvaDI+CiAgICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjAi' +
  'PgogICAgICAgIDxiPkFwcHJhaXNhbCBkaXN0cmljdDwvYj4g4oCUIGN1cnJlbnQgb3duZXIgYW5kIHRoZSBtYWlsaW5nIGFkZHJl' +
  'c3MgdGhlIHRheCBiaWxsIGdvZXMgdG8uIEJlc3QgZm9yCiAgICAgICAgY29uZmlybWluZyB0aGUgcGVyc29uIG9uIHlvdXIgcGFw' +
  'ZXJzIGlzIHRpZWQgdG8gdGhlIGFkZHJlc3MsIGFuZCBmb3IgZmluZGluZyBzb21ld2hlcmUgZWxzZSB0byB0cnkuPGJyPjxicj4K' +
  'ICAgICAgICA8Yj5Db3VudHkgY2xlcms8L2I+IOKAlCBkZWVkcywgbGllbnMgYW5kIHRyYW5zZmVycy4gQmVzdCBmb3IgaGlzdG9y' +
  'eTogd2hvIHNvbGQgaXQsIHdoZW4sIGFuZCB3aG8gaG9sZHMgYSBjbGFpbS4KICAgICAgICBXb24ndCByZWxpYWJseSB0ZWxsIHlv' +
  'dSB3aG8gbGl2ZXMgdGhlcmUgbm93LjwvcD4KICAgIDwvZGl2PgoKICAgICR7cm93c30KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4K' +
  'ICAgICAgPHAgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MCI+QSBtYWlsaW5nIGFkZHJlc3MgZnJvbSB0aGUgYXBwcmFpc2Fs' +
  'IGRpc3RyaWN0IGlzIGEgbGVhZCwgbm90IHByb29mIG9mCiAgICAgICAgcmVzaWRlbmNlIOKAlCBwbGVudHkgb2Ygb3duZXJzIGhh' +
  'dmUgcG9zdCBnb25lIHRvIGFuIGFnZW50LCBhIHJlbGF0aXZlLCBvciBhbm90aGVyIHN0YXRlLiBUcmVhdCBpdCBhcyBhCiAgICAg' +
  'ICAgcGxhY2UgdG8gYXR0ZW1wdCwgYW5kIHJlY29yZCB3aGF0IHlvdSBhY3R1YWxseSBmaW5kIGluIHRoZSBhdHRlbXB0IG5vdGVz' +
  'LjwvcD4KICAgIDwvZGl2PmApOwogIGJpbmRTaGVsbCgpOwoKICBjb25zdCBjb3B5VGVybSA9IGFzeW5jICgpID0+IHsKICAgIGNv' +
  'bnN0IHYgPSAkKCcjcHJvcFEnKS52YWx1ZS50cmltKCk7CiAgICBpZiAoIXYpIHJldHVybiBmYWxzZTsKICAgIHRyeSB7IGF3YWl0' +
  'IG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KHYpOyByZXR1cm4gdHJ1ZTsgfSBjYXRjaCAoZSkgeyByZXR1cm4gZmFsc2U7' +
  'IH0KICB9OwogICQoJyNwcm9wQ29weScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBjb25zdCB2ID0gJCgnI3Byb3BRJyku' +
  'dmFsdWUudHJpbSgpOwogICAgaWYgKCF2KSByZXR1cm4gdG9hc3QoJ1R5cGUgYSBuYW1lIG9yIGFkZHJlc3MgZmlyc3QnLCB0cnVl' +
  'KTsKICAgIHRvYXN0KGF3YWl0IGNvcHlUZXJtKCkgPyAnQ29waWVkICInICsgdiArICciJyA6ICdDb3B5IGZhaWxlZCDigJQgc2Vs' +
  'ZWN0IGl0IGJ5IGhhbmQnKTsKICB9OwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXByb3BdJykuZm9yRWFjaChy' +
  'b3cgPT4gcm93Lm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBjb25zdCBbY2ksIHdoaWNoXSA9IHJvdy5kYXRhc2V0LnByb3Au' +
  'c3BsaXQoJzonKTsKICAgIGNvbnN0IHRhcmdldCA9IENPVU5USUVTWytjaV1bd2hpY2hdOwogICAgY29uc3QgaGFkID0gJCgnI3By' +
  'b3BRJykudmFsdWUudHJpbSgpOwogICAgY29uc3Qgb2sgPSBoYWQgPyBhd2FpdCBjb3B5VGVybSgpIDogZmFsc2U7CiAgICB0b2Fz' +
  'dChvayA/ICdDb3BpZWQgIicgKyBoYWQgKyAnIiDigJQgcGFzdGUgaXQgaW50byB0aGVpciBzZWFyY2gnIDogJ09wZW5pbmcgJyAr' +
  'IENPVU5USUVTWytjaV0ubmFtZSk7CiAgICB3aW5kb3cub3Blbih0YXJnZXQudXJsLCAnX2JsYW5rJyk7CiAgfSk7Cn0KCi8qIC0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGNhc2UgbG9va3VwIC0tICovCi8q' +
  'IE5vbmUgb2YgdGhlc2UgcG9ydGFscyBhY2NlcHQgYSBjYXNlIG51bWJlciBpbiB0aGUgVVJMIC0tIEhpZGFsZ28ncyBydW5zIG9u' +
  'CiAgIHNlc3Npb24tYmFzZWQgZm9ybSBwb3N0cywgQ2FtZXJvbidzIHNpdHMgYmVoaW5kIGEgSmF2YVNjcmlwdCBnYXRlLiBTbyB0' +
  'aGlzCiAgIGNvcGllcyB0aGUgbnVtYmVyIHRvIHRoZSBjbGlwYm9hcmQgYW5kIG9wZW5zIHRoZSByaWdodCBzZWFyY2ggcGFnZS4g' +
  'Tm8KICAgc2NyYXBpbmcsIG5vdGhpbmcgdG8gYnJlYWsgd2hlbiB0aGV5IHJlZGVzaWduLiAqLwpjb25zdCBUWF9QT1JUQUxTID0g' +
  'WwogIHsgbmFtZTogJ3JlOlNlYXJjaFRYIOKAlCBzdGF0ZXdpZGUnLCB1cmw6ICdodHRwczovL3Jlc2VhcmNoLnR4Y291cnRzLmdv' +
  'di8nLAogICAgbm90ZTogJ0ZyZWUgYWNjb3VudCByZXF1aXJlZC4gRGlzdHJpY3QsIGNvdW50eSBhbmQgcHJvYmF0ZSBjb3VydHMg' +
  'aW4gYWxsIDI1NCBjb3VudGllcy4gJyArCiAgICAgICAgICAnUHVibGljIHZpZXcgc3RhcnRzIGF0IGZpbGluZ3MgZnJvbSAxIE5v' +
  'diAyMDE4LiBKdXN0aWNlLW9mLXRoZS1wZWFjZSBldmljdGlvbnMgYXJlIHBhdGNoeS4nIH0sCiAgeyBuYW1lOiAnSGlkYWxnbyBD' +
  'b3VudHkg4oCUIERpc3RyaWN0IENsZXJrIGNhc2Ugc2VhcmNoJywgdXJsOiAnaHR0cHM6Ly9wYS5jby5oaWRhbGdvLnR4LnVzL2Rl' +
  'ZmF1bHQuYXNweCcsCiAgICBub3RlOiAnQ2l2aWwgYW5kIGNyaW1pbmFsIGNhc2VzLiBGcmVlLCBubyBsb2dpbi4nIH0sCiAgeyBu' +
  'YW1lOiAnQ2FtZXJvbiBDb3VudHkg4oCUIGNvdXJ0IHBvcnRhbHMnLCB1cmw6ICdodHRwczovL3d3dy5jYW1lcm9uY291bnR5dHgu' +
  'Z292L2NhbWVyb24tY291bnR5LXBvcnRhbHMvJywKICAgIG5vdGU6ICdJbmRleCBwYWdlIGZvciB0aGUgY291bnR5XCdzIGRpc3Ry' +
  'aWN0IGFuZCBjb3VudHkgY2xlcmsgc2VhcmNoZXMuJyB9LAogIHsgbmFtZTogJ0NhbWVyb24gQ291bnR5IOKAlCBEaXN0cmljdCBD' +
  'bGVyayByZWNvcmRzJywgdXJsOiAnaHR0cHM6Ly9rb2ZpbGVxdWlja2xpbmtzLmNvbS9jYW1lcm9uZGMvJywKICAgIG5vdGU6ICdE' +
  'aXN0cmljdCBDbGVyayByZWNvcmQgc2VhcmNoLicgfSwKICB7IG5hbWU6ICdIaWRhbGdvIENvdW50eSDigJQgcHJvcGVydHkgLyBv' +
  'ZmZpY2lhbCByZWNvcmRzJywgdXJsOiAnaHR0cHM6Ly9oaWRhbGdvLnR4LnB1YmxpY3NlYXJjaC51cy8nLAogICAgbm90ZTogJ0Rl' +
  'ZWRzLCBsaWVucyBhbmQgb3duZXJzaGlwIGZyb20gdGhlIENvdW50eSBDbGVyayDigJQgcHJvcGVydHksIG5vdCBsYXdzdWl0cy4g' +
  'JyArCiAgICAgICAgICAnVXNlZnVsIGZvciBjb25maXJtaW5nIHdobyBhY3R1YWxseSBvd25zIGFuIGFkZHJlc3MuJyB9Cl07Cgpm' +
  'dW5jdGlvbiBjYXNlTG9va3VwU2hlZXQoam9iKSB7CiAgc2hlZXQoJ0xvb2sgdXAgJyArIGpvYi5jYXNlX251bWJlciwgYAogICAg' +
  'PGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6I2Y4ZmFmYztib3gtc2hhZG93Om5vbmU7dGV4dC1hbGlnbjpjZW50' +
  'ZXIiPgogICAgICA8ZGl2IHN0eWxlPSJmb250OjYwMCAyMHB4LzEuMyBtb25vc3BhY2U7bGV0dGVyLXNwYWNpbmc6LjVweCI+JHtl' +
  'c2Moam9iLmNhc2VfbnVtYmVyKX08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGludCI+JHtlc2Moam9iLmNvdXJ0IHx8ICdjb3Vy' +
  'dCBub3QgcmVjb3JkZWQnKX08L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0iY29weUNhc2UiIHN0eWxlPSJt' +
  'YXJnaW4tdG9wOjEwcHgiPkNvcHkgY2FzZSBudW1iZXI8L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPHAgY2xhc3M9ImhpbnQiPlRo' +
  'ZXNlIHBvcnRhbHMgY2FuJ3QgYmUgbGlua2VkIHRvIGRpcmVjdGx5IHdpdGggYSBjYXNlIG51bWJlciwgc28gdGFwcGluZyBvbmUg' +
  'Y29waWVzCiAgICAgIHRoZSBudW1iZXIgYW5kIG9wZW5zIHRoZWlyIHNlYXJjaCBwYWdlIOKAlCBwYXN0ZSBpdCBpbnRvIHRoZWly' +
  'IGJveC48L3A+CiAgICA8ZGl2IGNsYXNzPSJsaXN0Ij4KICAgICAgJHtUWF9QT1JUQUxTLm1hcCgocCwgaSkgPT4gYAogICAgICAg' +
  'IDxkaXYgY2xhc3M9Iml0ZW0iIGRhdGEtcG9ydGFsPSIke2l9Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9InQiPiR7ZXNjKHAubmFt' +
  'ZSl9PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJtIj4ke2VzYyhwLm5vdGUpfTwvZGl2PgogICAgICAgIDwvZGl2PmApLmpv' +
  'aW4oJycpfQogICAgPC9kaXY+CiAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+Q291cnQgcmVjb3Jk' +
  'cyByYXJlbHkgcHVibGlzaCBhIGRlZmVuZGFudCdzIHNlcnZpY2UgYWRkcmVzcyDigJQKICAgICAgdGhhdCBub3JtYWxseSBvbmx5' +
  'IGV4aXN0cyBvbiB0aGUgY2xpZW50J3MgcGFja2V0LjwvcD4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgYmxvY2siIHN0eWxl' +
  'PSJtYXJnaW4tdG9wOjhweCIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5DbG9zZTwvYnV0dG9uPmAsIGVsID0+IHsKICAgIGNvbnN0' +
  'IGNvcHkgPSBhc3luYyAoKSA9PiB7CiAgICAgIHRyeSB7IGF3YWl0IG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KGpvYi5j' +
  'YXNlX251bWJlcik7IHJldHVybiB0cnVlOyB9CiAgICAgIGNhdGNoIChlKSB7IHJldHVybiBmYWxzZTsgfQogICAgfTsKICAgIGVs' +
  'LnF1ZXJ5U2VsZWN0b3IoJyNjb3B5Q2FzZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PgogICAgICB0b2FzdChhd2FpdCBjb3B5KCkg' +
  'PyAnQ29waWVkICcgKyBqb2IuY2FzZV9udW1iZXIgOiAnQ29weSBmYWlsZWQg4oCUIHNlbGVjdCBpdCBieSBoYW5kJywgZmFsc2Up' +
  'OwogICAgZWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcG9ydGFsXScpLmZvckVhY2gocm93ID0+IHJvdy5vbmNsaWNrID0gYXN5' +
  'bmMgKCkgPT4gewogICAgICBjb25zdCBwID0gVFhfUE9SVEFMU1srcm93LmRhdGFzZXQucG9ydGFsXTsKICAgICAgY29uc3Qgb2sg' +
  'PSBhd2FpdCBjb3B5KCk7CiAgICAgIHRvYXN0KG9rID8gJ0Nhc2UgbnVtYmVyIGNvcGllZCDigJQgcGFzdGUgaXQgaW50byB0aGVp' +
  'ciBzZWFyY2gnIDogJ09wZW5pbmcgJyArIHAubmFtZSk7CiAgICAgIHdpbmRvdy5vcGVuKHAudXJsLCAnX2JsYW5rJyk7CiAgICB9' +
  'KTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tIHNjYW4gLS0gKi8KZnVuY3Rpb24gc2NhblZpZXcoKSB7CiAgYXBwLmlubmVySFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFz' +
  'cz0icGFnZSI+U2NhbiBhIHBhY2tldDwvaDE+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPHAgY2xhc3M9ImhpbnQiIHN0' +
  'eWxlPSJtYXJnaW4tdG9wOjAiPlBvaW50IHRoZSBjYW1lcmEgYXQgdGhlIGJhcmNvZGUgb24gdGhlIGNvdmVyIHNoZWV0IHRvIG9w' +
  'ZW4gdGhhdCBqb2IuIElmIHRoZSBjYW1lcmEKICAgICAgd29uJ3QgY29vcGVyYXRlLCB0eXBlIHRoZSBqb2IgbnVtYmVyIGluc3Rl' +
  'YWQg4oCUIGl0IHdvcmtzIHRoZSBzYW1lLjwvcD4KICAgICAgPGRpdiBpZD0icmVhZGVyIj48L2Rpdj4KICAgICAgPGRpdiBjbGFz' +
  'cz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJzdGFydFNjYW4i' +
  'PlN0YXJ0IGNhbWVyYTwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIGlkPSJzdG9wU2NhbkJ0biIgc3R5' +
  'bGU9ImRpc3BsYXk6bm9uZSI+U3RvcDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgaWQ9InNj' +
  'YW5Nc2ciPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkVudGVyIGpvYiBudW1iZXI8' +
  'L2gyPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAgIDxpbnB1dCBpZD0ibWFudWFsIiBwbGFjZWhvbGRlcj0iU1QtMTAw' +
  'MDEiIHN0eWxlPSJmbGV4OjE7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlIj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlk' +
  'PSJtYW51YWxHbyI+T3BlbjwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PmApOwogIGJpbmRTaGVsbCgpOwoKICBjb25z' +
  'dCBvcGVuID0gYXN5bmMgY29kZSA9PiB7CiAgICB0cnkgewogICAgICBjb25zdCBqID0gYXdhaXQgYXBpKCcvbG9va3VwLycgKyBl' +
  'bmNvZGVVUklDb21wb25lbnQoY29kZSkpOwogICAgICBpZiAod2luZG93Ll9fc3RvcFNjYW4pIHsgd2luZG93Ll9fc3RvcFNjYW4o' +
  'KTsgd2luZG93Ll9fc3RvcFNjYW4gPSBudWxsOyB9CiAgICAgIHRvYXN0KCdPcGVuaW5nICcgKyBqLmpvYl9udW1iZXIpOwogICAg' +
  'ICBnbygnam9iJywgeyBpZDogai5pZCB9KTsKICAgIH0gY2F0Y2ggKGUpIHsgJCgnI3NjYW5Nc2cnKS50ZXh0Q29udGVudCA9IGUu' +
  'bWVzc2FnZTsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07CgogICQoJyNtYW51YWxHbycpLm9uY2xpY2sgPSAoKSA9PiB7' +
  'IGNvbnN0IHYgPSAkKCcjbWFudWFsJykudmFsdWUudHJpbSgpOyBpZiAodikgb3Blbih2KTsgfTsKICAkKCcjbWFudWFsJykub25r' +
  'ZXlkb3duID0gZSA9PiB7IGlmIChlLmtleSA9PT0gJ0VudGVyJykgJCgnI21hbnVhbEdvJykuY2xpY2soKTsgfTsKCiAgJCgnI3N0' +
  'YXJ0U2NhbicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBjb25zdCBtc2cgPSAkKCcjc2Nhbk1zZycpOwogICAgaWYgKCF3' +
  'aW5kb3cuWlhpbmcpIHJldHVybiBtc2cudGV4dENvbnRlbnQgPSAnU2Nhbm5lciBsaWJyYXJ5IGRpZCBub3QgbG9hZCDigJQgdXNl' +
  'IHRoZSBqb2IgbnVtYmVyIGJveCBiZWxvdy4nOwogICAgdHJ5IHsKICAgICAgY29uc3QgcmVhZGVyID0gbmV3IFpYaW5nLkJyb3dz' +
  'ZXJNdWx0aUZvcm1hdFJlYWRlcigpOwogICAgICBjb25zdCB2aWRlbyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3ZpZGVvJyk7' +
  'CiAgICAgIHZpZGVvLnNldEF0dHJpYnV0ZSgncGxheXNpbmxpbmUnLCAndHJ1ZScpOwogICAgICAkKCcjcmVhZGVyJykuaW5uZXJI' +
  'VE1MID0gJyc7CiAgICAgICQoJyNyZWFkZXInKS5hcHBlbmRDaGlsZCh2aWRlbyk7CiAgICAgICQoJyNzdGFydFNjYW4nKS5zdHls' +
  'ZS5kaXNwbGF5ID0gJ25vbmUnOwogICAgICAkKCcjc3RvcFNjYW5CdG4nKS5zdHlsZS5kaXNwbGF5ID0gJyc7CiAgICAgIG1zZy50' +
  'ZXh0Q29udGVudCA9ICdMb29raW5nIGZvciBhIGJhcmNvZGXigKYnOwogICAgICBsZXQgaGFuZGxlZCA9IGZhbHNlOwogICAgICBh' +
  'd2FpdCByZWFkZXIuZGVjb2RlRnJvbUNvbnN0cmFpbnRzKAogICAgICAgIHsgdmlkZW86IHsgZmFjaW5nTW9kZTogJ2Vudmlyb25t' +
  'ZW50JyB9IH0sIHZpZGVvLAogICAgICAgIChyZXN1bHQpID0+IHsgaWYgKHJlc3VsdCAmJiAhaGFuZGxlZCkgeyBoYW5kbGVkID0g' +
  'dHJ1ZTsgb3BlbihyZXN1bHQuZ2V0VGV4dCgpKTsgfSB9KTsKICAgICAgd2luZG93Ll9fc3RvcFNjYW4gPSAoKSA9PiB7CiAgICAg' +
  'ICAgdHJ5IHsgcmVhZGVyLnJlc2V0KCk7IH0gY2F0Y2ggKGUpIHt9CiAgICAgICAgJCgnI3JlYWRlcicpLmlubmVySFRNTCA9ICcn' +
  'OwogICAgICAgIGNvbnN0IHMgPSAkKCcjc3RhcnRTY2FuJyksIHN0ID0gJCgnI3N0b3BTY2FuQnRuJyk7CiAgICAgICAgaWYgKHMp' +
  'IHMuc3R5bGUuZGlzcGxheSA9ICcnOwogICAgICAgIGlmIChzdCkgc3Quc3R5bGUuZGlzcGxheSA9ICdub25lJzsKICAgICAgfTsK' +
  'ICAgICAgJCgnI3N0b3BTY2FuQnRuJykub25jbGljayA9ICgpID0+IHsgd2luZG93Ll9fc3RvcFNjYW4oKTsgd2luZG93Ll9fc3Rv' +
  'cFNjYW4gPSBudWxsOyBtc2cudGV4dENvbnRlbnQgPSAnJzsgfTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgbXNnLnRleHRDb250' +
  'ZW50ID0gJ0NhbWVyYSB1bmF2YWlsYWJsZSAoJyArIGUubWVzc2FnZSArICcpLiBVc2UgdGhlIGpvYiBudW1iZXIgYm94IGJlbG93' +
  'Lic7CiAgICAgICQoJyNzdGFydFNjYW4nKS5zdHlsZS5kaXNwbGF5ID0gJyc7CiAgICAgICQoJyNzdG9wU2NhbkJ0bicpLnN0eWxl' +
  'LmRpc3BsYXkgPSAnbm9uZSc7CiAgICB9CiAgfTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gbW9uZXkgLS0gKi8KYXN5bmMgZnVuY3Rpb24gbW9uZXlWaWV3KCkgewogIGlmICghaXNB' +
  'ZG1pbigpKSByZXR1cm4gbXlQYXlWaWV3KCk7CiAgY29uc3QgW3N0YXRlbWVudHMsIGludm9pY2VzLCB1c2VycywgY2xpZW50cywg' +
  'YXJdID0gYXdhaXQgUHJvbWlzZS5hbGwoCiAgICBbYXBpKCcvc3RhdGVtZW50cycpLCBhcGkoJy9pbnZvaWNlcycpLCBhcGkoJy91' +
  'c2VycycpLCBhcGkoJy9jbGllbnRzJyksIGFwaSgnL3JlY2VpdmFibGVzJyldKTsKCiAgLyogTW9uZXkgb3dlZCwgb2xkZXN0IGZp' +
  'cnN0LiAiVW5iaWxsZWQiIGlzIGRlbGliZXJhdGVseSBub3QgcGFydCBvZiB0aGUKICAgICB0b3RhbCDigJQgdGhhdCBpcyB3b3Jr' +
  'IHlvdSBoYXZlIG5vdCBhc2tlZCB0byBiZSBwYWlkIGZvciB5ZXQsIHdoaWNoIGlzIGEKICAgICBkaWZmZXJlbnQgcHJvYmxlbSBm' +
  'cm9tIGEgZmlybSB0aGF0IGlzIHNsb3cgdG8gcGF5LiAqLwogIGNvbnN0IG93ZWQgPSBhci5jbGllbnRzLmZpbHRlcihjID0+IE51' +
  'bWJlcihjLmJhbGFuY2UpID4gMCk7CiAgY29uc3QgYnVja2V0ID0gKHYsIHdhcm4pID0+IGA8ZGl2IGNsYXNzPSJzdGF0JHt2ID4g' +
  'MCAmJiB3YXJuID8gJyBiYWQnIDogJyd9IiBzdHlsZT0iZmxleDoxIj4KICAgICAgPGRpdiBjbGFzcz0ibiIgc3R5bGU9ImZvbnQt' +
  'c2l6ZToxNnB4Ij4ke21vbmV5KHYpfTwvZGl2PjxkaXYgY2xhc3M9ImwiPiR7d2FybiB8fCAnQ3VycmVudCd9PC9kaXY+PC9kaXY+' +
  'YDsKCiAgYXBwLmlubmVySFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFnZSI+QmlsbGluZyAmYW1wOyBwYXk8L2gxPgoK' +
  'ICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+T3V0c3RhbmRpbmcgPHNwYW4gY2xhc3M9InN1YiI+d2hhdCB5b3VyIGF0' +
  'dG9ybmV5cyBvd2UgeW91PC9zcGFuPjwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQgYmlnIiBzdHlsZT0ibWFyZ2luLXRvcDo2' +
  'cHgiPgogICAgICAgIDxkaXYgY2xhc3M9Im4iPiR7bW9uZXkoYXIudG90YWwpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Imwi' +
  'PiR7b3dlZC5sZW5ndGggPyBvd2VkLmxlbmd0aCArICcgZmlybScgKyAob3dlZC5sZW5ndGggPT09IDEgPyAnJyA6ICdzJykgKyAn' +
  'IHdpdGggYSBiYWxhbmNlJwogICAgICAgICAgOiAnRXZlcnlvbmUgaXMgcGFpZCB1cCd9PC9kaXY+CiAgICAgIDwvZGl2PgogICAg' +
  'ICAke2FyLnRvdGFsID4gMCA/IGA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJnYXA6NnB4O21hcmdpbi10b3A6MTBweCI+CiAgICAg' +
  'ICAgJHtidWNrZXQoYXIuYnVja2V0cy5kMCl9JHtidWNrZXQoYXIuYnVja2V0cy5kMzAsICczMCsgZGF5cycpfQogICAgICAgICR7' +
  'YnVja2V0KGFyLmJ1Y2tldHMuZDYwLCAnNjArIGRheXMnKX0ke2J1Y2tldChhci5idWNrZXRzLmQ5MCwgJzkwKyBkYXlzJyl9CiAg' +
  'ICAgIDwvZGl2PmAgOiAnJ30KICAgICAgJHtvd2VkLmxlbmd0aCA/IGA8dGFibGUgY2xhc3M9InRibCIgc3R5bGU9Im1hcmdpbi10' +
  'b3A6MTRweCI+CiAgICAgICAgPHRyPjx0aD5BdHRvcm5leTwvdGg+PHRoIGNsYXNzPSJudW0iPk93ZWQ8L3RoPjx0aCBjbGFzcz0i' +
  'bnVtIj5PbGRlc3Q8L3RoPjx0aD48L3RoPjwvdHI+CiAgICAgICAgJHtvd2VkLm1hcChjID0+IHsKICAgICAgICAgIGNvbnN0IGFn' +
  'ZSA9IE1hdGguZmxvb3IoKERhdGUubm93KCkgLSBuZXcgRGF0ZShjLm9sZGVzdF9pbnZvaWNlKS5nZXRUaW1lKCkpIC8gODY0ZTUp' +
  'OwogICAgICAgICAgcmV0dXJuIGA8dHI+CiAgICAgICAgICAgIDx0ZD4ke2VzYyhjLmNsaWVudF9uYW1lKX08ZGl2IGNsYXNzPSJo' +
  'aW50IiBzdHlsZT0ibWFyZ2luOjAiPiR7Yy5pbnZvaWNlX2NvdW50fSBpbnZvaWNlJHsKICAgICAgICAgICAgICBjLmludm9pY2Vf' +
  'Y291bnQgPT09IDEgPyAnJyA6ICdzJ308L2Rpdj48L3RkPgogICAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHttb25leShjLmJh' +
  'bGFuY2UpfTwvdGQ+CiAgICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIiR7YWdlID49IDYwID8gJyBzdHlsZT0iY29sb3I6dmFyKC0t' +
  'YmFkKTtmb250LXdlaWdodDo3MDAiJyA6ICcnfT4ke2FnZX1kPC90ZD4KICAgICAgICAgICAgPHRkIGNsYXNzPSJudW0iPjxhIGhy' +
  'ZWY9Ii9wcmludC9hY2NvdW50LyR7Yy5jbGllbnRfaWR9IiB0YXJnZXQ9Il9ibGFuayI+c3RhdGVtZW50PC9hPjwvdGQ+CiAgICAg' +
  'ICAgICA8L3RyPmA7CiAgICAgICAgfSkuam9pbignJyl9PC90YWJsZT5gIDogJyd9CiAgICAgICR7YXIudW5iaWxsZWQgPiAwID8g' +
  'YDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPlNlcGFyYXRlbHksIDxiPiR7bW9uZXkoYXIudW5iaWxs' +
  'ZWQpfTwvYj4KICAgICAgICBvZiBzZXJ2ZWQgd29yayBoYXMgbm90IGJlZW4gcHV0IG9uIGFuIGludm9pY2UgeWV0IOKAlCB0aGF0' +
  'IGlzIG1vbmV5IHlvdSBoYXZlIG5vdCBhc2tlZCBmb3IuPC9kaXY+YCA6ICcnfQogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0i' +
  'Y2FyZCI+CiAgICAgIDxoMj5Db250cmFjdG9yIHN0YXRlbWVudHMgPHNwYW4gY2xhc3M9InN1YiI+d2hhdCB5b3Ugb3dlIHlvdXIg' +
  'c2VydmVyczwvc3Bhbj48L2gyPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6LTRweCI+UHVsbHMgZXZl' +
  'cnkgY29tcGxldGVkIHNlcnZlIGluIHRoZSBwZXJpb2QgdGhhdCBoYXNuJ3QgYmVlbiBwYWlkIG91dCB5ZXQsIGF0IHRoZQogICAg' +
  'ICBwZXItam9iIHJhdGUgb24gdGhlIGpvYi4gTm90aGluZyBnZXRzIGNvdW50ZWQgdHdpY2UuPC9wPgogICAgICA8ZGl2IGNsYXNz' +
  'PSJncmlkIGcyIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlNlcnZl' +
  'cjwvbGFiZWw+PHNlbGVjdCBpZD0ic19zZXJ2ZXIiPgogICAgICAgICAgJHt1c2Vycy5maWx0ZXIodSA9PiB1LmFjdGl2ZSkubWFw' +
  'KHUgPT4gYDxvcHRpb24gdmFsdWU9IiR7dS5pZH0iPiR7ZXNjKHUubmFtZSl9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+' +
  'PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0iYWxpZ24taXRlbXM6ZmxleC1lbmQ7Z2FwOjZweCI+CiAgICAg' +
  'ICAgICA8ZGl2IGNsYXNzPSJmaWVsZCIgc3R5bGU9ImZsZXg6MTttYXJnaW46MCI+PGxhYmVsPkZyb208L2xhYmVsPjxpbnB1dCB0' +
  'eXBlPSJkYXRlIiBpZD0ic19zdGFydCIgdmFsdWU9IiR7Zmlyc3RPZk1vbnRoKCl9Ij48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xh' +
  'c3M9ImZpZWxkIiBzdHlsZT0iZmxleDoxO21hcmdpbjowIj48bGFiZWw+VG88L2xhYmVsPjxpbnB1dCB0eXBlPSJkYXRlIiBpZD0i' +
  'c19lbmQiIHZhbHVlPSIke3RvZGF5SVNPKCl9Ij48L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYg' +
  'Y2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0i' +
  'c19wcmV2Ij5QcmV2aWV3PC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0ic19tYWtlIj5DcmVhdGUg' +
  'c3RhdGVtZW50PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGlkPSJzX291dCI+PC9kaXY+CiAgICAgICR7c3RhdGVt' +
  'ZW50cy5sZW5ndGggPyBgPHRhYmxlIGNsYXNzPSJ0YmwiIHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPgogICAgICAgIDx0cj48dGg+' +
  'U2VydmVyPC90aD48dGg+UGVyaW9kPC90aD48dGggY2xhc3M9Im51bSI+Sm9iczwvdGg+PHRoIGNsYXNzPSJudW0iPlRvdGFsPC90' +
  'aD48dGg+PC90aD48dGg+PC90aD48L3RyPgogICAgICAgICR7c3RhdGVtZW50cy5tYXAocyA9PiBgPHRyPgogICAgICAgICAgPHRk' +
  'PiR7ZXNjKHMuc2VydmVyX25hbWUpfTwvdGQ+PHRkPiR7Zm10RGF0ZU9ubHkocy5wZXJpb2Rfc3RhcnQpfeKAkyR7Zm10RGF0ZU9u' +
  'bHkocy5wZXJpb2RfZW5kKX08L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPiR7cy5qb2JfY291bnR9PC90ZD48dGQgY2xh' +
  'c3M9Im51bSI+JHttb25leShzLnRvdGFsKX08L3RkPgogICAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJwaWxsICR7Y2xzKHMuc3Rh' +
  'dHVzKX0iPiR7ZXNjKHMuc3RhdHVzKX08L3NwYW4+PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIvcHJp' +
  'bnQvc3RhdGVtZW50LyR7cy5pZH0iIHRhcmdldD0iX2JsYW5rIj5wcmludDwvYT4KICAgICAgICAgICAgJHtzLnN0YXR1cyAhPT0g' +
  'J1BhaWQnID8gYCDCtyA8YSBocmVmPSIjIiBkYXRhLXBhaWQ9IiR7cy5pZH0iPm1hcmsgcGFpZDwvYT5gIDogJyd9PC90ZD4KICAg' +
  'ICAgICA8L3RyPmApLmpvaW4oJycpfTwvdGFibGU+YCA6ICcnfQogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAg' +
  'ICAgIDxoMj5DbGllbnQgaW52b2ljZXM8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgICA8ZGl2IGNsYXNz' +
  'PSJmaWVsZCI+PGxhYmVsPkNsaWVudDwvbGFiZWw+PHNlbGVjdCBpZD0iaV9jbGllbnQiPgogICAgICAgICAgJHtjbGllbnRzLmZp' +
  'bHRlcihjID0+IGMuYWN0aXZlKS5tYXAoYyA9PiBgPG9wdGlvbiB2YWx1ZT0iJHtjLmlkfSI+JHtlc2MoYy5uYW1lKX08L29wdGlv' +
  'bj5gKS5qb2luKCcnKX08L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJhbGlnbi1pdGVtczpm' +
  'bGV4LWVuZDtnYXA6NnB4Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0iZmxleDoxO21hcmdpbjowIj48bGFi' +
  'ZWw+RnJvbTwvbGFiZWw+PGlucHV0IHR5cGU9ImRhdGUiIGlkPSJpX3N0YXJ0IiB2YWx1ZT0iJHtmaXJzdE9mTW9udGgoKX0iPjwv' +
  'ZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJmbGV4OjE7bWFyZ2luOjAiPjxsYWJlbD5UbzwvbGFiZWw+' +
  'PGlucHV0IHR5cGU9ImRhdGUiIGlkPSJpX2VuZCIgdmFsdWU9IiR7dG9kYXlJU08oKX0iPjwvZGl2PgogICAgICAgIDwvZGl2Pgog' +
  'ICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPgogICAgICAgIDxidXR0b24g' +
  'Y2xhc3M9ImJ0biBzZWMgc20iIGlkPSJpX3ByZXYiPlByZXZpZXc8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4g' +
  'c20iIGlkPSJpX21ha2UiPkNyZWF0ZSBpbnZvaWNlPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGlkPSJpX291dCI+' +
  'PC9kaXY+CiAgICAgICR7aW52b2ljZXMubGVuZ3RoID8gYDx0YWJsZSBjbGFzcz0idGJsIiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4' +
  'Ij4KICAgICAgICA8dHI+PHRoPkNsaWVudDwvdGg+PHRoPlBlcmlvZDwvdGg+PHRoIGNsYXNzPSJudW0iPkpvYnM8L3RoPjx0aCBj' +
  'bGFzcz0ibnVtIj5Ub3RhbDwvdGg+PHRoPjwvdGg+PHRoPjwvdGg+PC90cj4KICAgICAgICAke2ludm9pY2VzLm1hcChzID0+IGA8' +
  'dHI+CiAgICAgICAgICA8dGQ+JHtlc2Mocy5jbGllbnRfbmFtZSl9PC90ZD48dGQ+JHtmbXREYXRlT25seShzLnBlcmlvZF9zdGFy' +
  'dCl94oCTJHtmbXREYXRlT25seShzLnBlcmlvZF9lbmQpfTwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHtzLmpvYl9j' +
  'b3VudH08L3RkPjx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KHMudG90YWwpfTwvdGQ+CiAgICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9' +
  'InBpbGwgJHtjbHMocy5zdGF0dXMpfSI+JHtlc2Mocy5zdGF0dXMpfTwvc3Bhbj48L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJu' +
  'dW0iPjxhIGhyZWY9Ii9wcmludC9pbnZvaWNlLyR7cy5pZH0iIHRhcmdldD0iX2JsYW5rIj5wcmludDwvYT4KICAgICAgICAgICAg' +
  'JHtzLnN0YXR1cyAhPT0gJ1BhaWQnID8gYCDCtyA8YSBocmVmPSIjIiBkYXRhLWlwYWlkPSIke3MuaWR9Ij5tYXJrIHBhaWQ8L2E+' +
  'YCA6ICcnfTwvdGQ+CiAgICAgICAgPC90cj5gKS5qb2luKCcnKX08L3RhYmxlPmAgOiAnJ30KICAgIDwvZGl2PmApOwogIGJpbmRT' +
  'aGVsbCgpOwoKICBjb25zdCBsaW5lc1RhYmxlID0gKHIsIGtleSkgPT4gci5saW5lcy5sZW5ndGgKICAgID8gYDx0YWJsZSBjbGFz' +
  'cz0idGJsIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij48dHI+PHRoPkRhdGU8L3RoPjx0aD5Kb2I8L3RoPjx0aD5SZWNpcGllbnQ8' +
  'L3RoPjx0aCBjbGFzcz0ibnVtIj4ke2tleSA9PT0gJ3BheScgPyAnUGF5JyA6ICdGZWUnfTwvdGg+PC90cj4KICAgICAgICR7ci5s' +
  'aW5lcy5tYXAobCA9PiBgPHRyPjx0ZD4ke2ZtdERhdGVPbmx5KGwuc2VydmVkX2F0KX08L3RkPjx0ZD4ke2VzYyhsLmpvYl9udW1i' +
  'ZXIpfTwvdGQ+CiAgICAgICA8dGQ+JHtlc2MobC5yZWNpcGllbnRfbmFtZSl9PC90ZD48dGQgY2xhc3M9Im51bSI+JHttb25leShr' +
  'ZXkgPT09ICdwYXknID8gbC5zZXJ2ZXJfcGF5IDogbC5jbGllbnRfZmVlKX08L3RkPjwvdHI+YCkuam9pbignJyl9CiAgICAgICA8' +
  'dHI+PHRkIGNvbHNwYW49IjMiPjxiPiR7ci5jb3VudH0gam9iKHMpPC9iPjwvdGQ+PHRkIGNsYXNzPSJudW0iPjxiPiR7bW9uZXko' +
  'ci50b3RhbCl9PC9iPjwvdGQ+PC90cj48L3RhYmxlPmAKICAgIDogJzxkaXYgY2xhc3M9ImhpbnQiPk5vdGhpbmcgdW5iaWxsZWQg' +
  'aW4gdGhhdCB3aW5kb3cuPC9kaXY+JzsKCiAgJCgnI3NfcHJldicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBjb25zdCBy' +
  'ID0gYXdhaXQgYXBpKCcvc3RhdGVtZW50cy9wcmV2aWV3JywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnko' +
  'CiAgICAgIHsgc2VydmVyX2lkOiAkKCcjc19zZXJ2ZXInKS52YWx1ZSwgc3RhcnQ6ICQoJyNzX3N0YXJ0JykudmFsdWUsIGVuZDog' +
  'JCgnI3NfZW5kJykudmFsdWUgfSkgfSk7CiAgICAkKCcjc19vdXQnKS5pbm5lckhUTUwgPSBsaW5lc1RhYmxlKHIsICdwYXknKTsK' +
  'ICB9OwogICQoJyNzX21ha2UnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAgICAgYXdhaXQgYXBpKCcvc3Rh' +
  'dGVtZW50cycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KAogICAgICAgIHsgc2VydmVyX2lkOiAkKCcj' +
  'c19zZXJ2ZXInKS52YWx1ZSwgc3RhcnQ6ICQoJyNzX3N0YXJ0JykudmFsdWUsIGVuZDogJCgnI3NfZW5kJykudmFsdWUgfSkgfSk7' +
  'CiAgICAgIHRvYXN0KCdTdGF0ZW1lbnQgY3JlYXRlZCcpOyBnbygnbW9uZXknKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5t' +
  'ZXNzYWdlLCB0cnVlKTsgfQogIH07CiAgJCgnI2lfcHJldicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBjb25zdCByID0g' +
  'YXdhaXQgYXBpKCcvaW52b2ljZXMvcHJldmlldycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KAogICAg' +
  'ICB7IGNsaWVudF9pZDogJCgnI2lfY2xpZW50JykudmFsdWUsIHN0YXJ0OiAkKCcjaV9zdGFydCcpLnZhbHVlLCBlbmQ6ICQoJyNp' +
  'X2VuZCcpLnZhbHVlIH0pIH0pOwogICAgJCgnI2lfb3V0JykuaW5uZXJIVE1MID0gbGluZXNUYWJsZShyLCAnZmVlJyk7CiAgfTsK' +
  'ICAkKCcjaV9tYWtlJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGF3YWl0IGFwaSgnL2ludm9pY2Vz' +
  'JywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoCiAgICAgICAgeyBjbGllbnRfaWQ6ICQoJyNpX2NsaWVu' +
  'dCcpLnZhbHVlLCBzdGFydDogJCgnI2lfc3RhcnQnKS52YWx1ZSwgZW5kOiAkKCcjaV9lbmQnKS52YWx1ZSB9KSB9KTsKICAgICAg' +
  'dG9hc3QoJ0ludm9pY2UgY3JlYXRlZCcpOyBnbygnbW9uZXknKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0' +
  'cnVlKTsgfQogIH07CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcGFpZF0nKS5mb3JFYWNoKGEgPT4gYS5vbmNs' +
  'aWNrID0gYXN5bmMgZSA9PiB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICBhd2FpdCBhcGkoJy9zdGF0ZW1lbnRzLycgKyBh' +
  'LmRhdGFzZXQucGFpZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgc3RhdHVzOiAnUGFpZCcgfSkg' +
  'fSk7CiAgICB0b2FzdCgnTWFya2VkIHBhaWQnKTsgZ28oJ21vbmV5Jyk7CiAgfSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFs' +
  'bCgnW2RhdGEtaXBhaWRdJykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGFzeW5jIGUgPT4gewogICAgZS5wcmV2ZW50RGVmYXVs' +
  'dCgpOwogICAgYXdhaXQgYXBpKCcvaW52b2ljZXMvJyArIGEuZGF0YXNldC5pcGFpZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6' +
  'IEpTT04uc3RyaW5naWZ5KHsgc3RhdHVzOiAnUGFpZCcgfSkgfSk7CiAgICB0b2FzdCgnTWFya2VkIHBhaWQnKTsgZ28oJ21vbmV5' +
  'Jyk7CiAgfSk7Cn0KCmZ1bmN0aW9uIGZpcnN0T2ZNb250aCgpIHsKICBjb25zdCBkID0gbmV3IERhdGUoKTsgcmV0dXJuIG5ldyBE' +
  'YXRlKGQuZ2V0RnVsbFllYXIoKSwgZC5nZXRNb250aCgpLCAxKS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKTsKfQoKYXN5bmMg' +
  'ZnVuY3Rpb24gbXlQYXlWaWV3KCkgewogIGNvbnN0IFtzdGF0ZW1lbnRzLCBzdGF0c10gPSBhd2FpdCBQcm9taXNlLmFsbChbYXBp' +
  'KCcvc3RhdGVtZW50cycpLCBhcGkoJy9zdGF0cycpXSk7CiAgYXBwLmlubmVySFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0i' +
  'cGFnZSI+TXkgcGF5PC9oMT4KICAgIDxkaXYgY2xhc3M9InN0YXRzIj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdCBnb29kIj48ZGl2' +
  'IGNsYXNzPSJuIj4ke21vbmV5KHN0YXRzLnVuYmlsbGVkKX08L2Rpdj48ZGl2IGNsYXNzPSJsIj5FYXJuZWQsIG5vdCB5ZXQgb24g' +
  'YSBzdGF0ZW1lbnQ8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdCI+PGRpdiBjbGFzcz0ibiI+JHtzdGF0cy5zZXJ2' +
  'ZWRfN2R9PC9kaXY+PGRpdiBjbGFzcz0ibCI+U2VydmVzIGNvbXBsZXRlZCwgNyBkYXlzPC9kaXY+PC9kaXY+CiAgICA8L2Rpdj4K' +
  'ICAgIDxkaXYgY2xhc3M9ImNhcmQiPjxoMj5TdGF0ZW1lbnRzPC9oMj4KICAgICR7c3RhdGVtZW50cy5sZW5ndGggPyBgPHRhYmxl' +
  'IGNsYXNzPSJ0YmwiPgogICAgICA8dHI+PHRoPlBlcmlvZDwvdGg+PHRoIGNsYXNzPSJudW0iPkpvYnM8L3RoPjx0aCBjbGFzcz0i' +
  'bnVtIj5Ub3RhbDwvdGg+PHRoPjwvdGg+PHRoPjwvdGg+PC90cj4KICAgICAgJHtzdGF0ZW1lbnRzLm1hcChzID0+IGA8dHI+PHRk' +
  'PiR7Zm10RGF0ZU9ubHkocy5wZXJpb2Rfc3RhcnQpfeKAkyR7Zm10RGF0ZU9ubHkocy5wZXJpb2RfZW5kKX08L3RkPgogICAgICAg' +
  'IDx0ZCBjbGFzcz0ibnVtIj4ke3Muam9iX2NvdW50fTwvdGQ+PHRkIGNsYXNzPSJudW0iPiR7bW9uZXkocy50b3RhbCl9PC90ZD4K' +
  'ICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InBpbGwgJHtjbHMocy5zdGF0dXMpfSI+JHtlc2Mocy5zdGF0dXMpfTwvc3Bhbj48L3Rk' +
  'PgogICAgICAgIDx0ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIvcHJpbnQvc3RhdGVtZW50LyR7cy5pZH0iIHRhcmdldD0iX2JsYW5r' +
  'Ij5wcmludDwvYT48L3RkPjwvdHI+YCkuam9pbignJyl9CiAgICAgIDwvdGFibGU+YCA6ICc8ZGl2IGNsYXNzPSJlbXB0eSI+Tm8g' +
  'c3RhdGVtZW50cyB5ZXQuPC9kaXY+J30KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2FyZCI+PGgyPkNoYW5nZSBwYXNzd29y' +
  'ZDwvaDI+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPlRoaXMgaXMgeW91ciBvbmUgcGFzc3dvcmQgZm9yIGV2ZXJ5IGFwcC48L2Rp' +
  'dj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxpbnB1dCBpZD0ib3B3IiB0eXBlPSJwYXNzd29yZCIgcGxhY2Vob2xkZXI9IkN1' +
  'cnJlbnQgcGFzc3dvcmQiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGlucHV0IGlkPSJucHciIHR5cGU9InBhc3N3' +
  'b3JkIiBwbGFjZWhvbGRlcj0iTmV3IHBhc3N3b3JkICg4KyBjaGFyYWN0ZXJzKSI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9' +
  'ImJ0biBzbSIgaWQ9InNhdmVQdyI+VXBkYXRlPC9idXR0b24+PC9kaXY+YCk7CiAgYmluZFNoZWxsKCk7CiAgJCgnI3NhdmVQdycp' +
  'Lm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBjb25zdCByID0gYXdhaXQgYXBpKCcvbWUvcGFzc3dvcmQn' +
  'LCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgcGFzc3dvcmQ6ICQoJyNucHcnKS52YWx1' +
  'ZSwgb2xkX3Bhc3N3b3JkOiAkKCcjb3B3JykudmFsdWUgfSkgfSk7CiAgICAgICQoJyNvcHcnKS52YWx1ZSA9ICcnOyAkKCcjbnB3' +
  'JykudmFsdWUgPSAnJzsKICAgICAgdG9hc3Qoci5ldmVyeXdoZXJlID09PSBmYWxzZSA/ICdDaGFuZ2VkIGhlcmUg4oCUIG90aGVy' +
  'IGFwcHMgc3RpbGwgaGF2ZSB0aGUgb2xkIG9uZScgOiAnUGFzc3dvcmQgdXBkYXRlZCBldmVyeXdoZXJlJyk7CiAgICB9IGNhdGNo' +
  'IChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9Owp9CgoKZnVuY3Rpb24gY29kZXNUYWJsZShsaXN0KSB7CiAgaWYg' +
  'KCFsaXN0Lmxlbmd0aCkgcmV0dXJuICc8ZGl2IGNsYXNzPSJoaW50Ij5ObyBjb2RlcyB5ZXQuPC9kaXY+JzsKICByZXR1cm4gYDx0' +
  'YWJsZSBjbGFzcz0idGJsIj4KICAgIDx0cj48dGg+Q29kZTwvdGg+PHRoPkdyYW50czwvdGg+PHRoPlVzZWQ8L3RoPjx0aD48L3Ro' +
  'Pjx0aD48L3RoPjwvdHI+CiAgICAke2xpc3QubWFwKGMgPT4gYDx0cj4KICAgICAgPHRkPjxzcGFuIHN0eWxlPSJmb250OjYwMCAx' +
  'M3B4IG1vbm9zcGFjZTtsZXR0ZXItc3BhY2luZzouNXB4Ij4ke2VzYyhjLmNvZGUpfTwvc3Bhbj4KICAgICAgICAke2Mubm90ZSA/' +
  'IGA8ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyhjLm5vdGUpfTwvZGl2PmAgOiAnJ30KICAgICAgICAke2MucmVkZW1wdGlvbnMgJiYg' +
  'Yy5yZWRlbXB0aW9ucy5sZW5ndGggPyBgPGRpdiBjbGFzcz0iaGludCI+JHtjLnJlZGVtcHRpb25zLm1hcChyID0+IGVzYyhyLmVt' +
  'YWlsKSkuam9pbignLCAnKX08L2Rpdj5gIDogJyd9PC90ZD4KICAgICAgPHRkPiR7Yy5yb2xlID09PSAnYWRtaW4nID8gJ0FkbWlu' +
  'JyA6ICdGaWVsZCBzZXJ2ZXInfQogICAgICAgICR7Yy5leHBpcmVzX2F0ID8gYDxkaXYgY2xhc3M9ImhpbnQiPnRvICR7Zm10RGF0' +
  'ZU9ubHkoYy5leHBpcmVzX2F0KX08L2Rpdj5gIDogJyd9PC90ZD4KICAgICAgPHRkPiR7Yy51c2VkX2NvdW50fS8ke2MubWF4X3Vz' +
  'ZXN9PC90ZD4KICAgICAgPHRkPjxzcGFuIGNsYXNzPSJwaWxsICR7Yy5zdGF0ZSA9PT0gJ0FjdGl2ZScgPyAnU2VydmVkJyA6ICcn' +
  'fSI+JHtlc2MoYy5zdGF0ZSl9PC9zcGFuPjwvdGQ+CiAgICAgIDx0ZCBjbGFzcz0ibnVtIj4KICAgICAgICA8YSBocmVmPSIjIiBk' +
  'YXRhLWNvcHk9IiR7ZXNjKGMuY29kZSl9Ij5jb3B5PC9hPgogICAgICAgICR7Yy5zdGF0ZSA9PT0gJ0FjdGl2ZScgPyBgIMK3IDxh' +
  'IGhyZWY9IiMiIGRhdGEtcmV2b2tlPSIke2MuaWR9Ij5yZXZva2U8L2E+YCA6ICcnfQogICAgICA8L3RkPjwvdHI+YCkuam9pbign' +
  'Jyl9PC90YWJsZT5gOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLSBhZG1pbiAtLSAqLwphc3luYyBmdW5jdGlvbiBhZG1pblZpZXcoKSB7CiAgLy8gRmV0Y2ggZXZlcnl0aGluZyBiZWZv' +
  'cmUgZHJhd2luZy4gUG9wdWxhdGluZyBjYXJkcyBhZnRlciByZW5kZXIgbWFkZSB0aGUKICAvLyBwYWdlIGdyb3cgdW5kZXIgdGhl' +
  'IHVzZXIncyBmaW5nZXIsIHNvIGEgdGFwIGNvdWxkIGxhbmQgb24gdGhlIHdyb25nIHJvdy4KICBjb25zdCBbdXNlcnMsIGNsaWVu' +
  'dHMsIHRlbXBsYXRlcywgY29kZXMsIHBvcnRhbHMsIGNvbXBhbmllc10gPSBhd2FpdCBQcm9taXNlLmFsbChbCiAgICBhcGkoJy91' +
  'c2VycycpLCBhcGkoJy9jbGllbnRzJyksIGFwaSgnL3RlbXBsYXRlcycpLAogICAgYXBpKCcvY29kZXMnKS5jYXRjaCgoKSA9PiBb' +
  'XSksIGFwaSgnL3BvcnRhbHMnKS5jYXRjaCgoKSA9PiBbXSksCiAgICBhcGkoJy9jb21wYW5pZXMnKS5jYXRjaCgoKSA9PiBbXSkK' +
  'ICBdKTsKICBjb25zdCBoZXJlID0gY29tcGFuaWVzLmZpbmQoYyA9PiBTLm1lLmNvbXBhbnkgJiYgYy5pZCA9PT0gUy5tZS5jb21w' +
  'YW55LmlkKSB8fCBjb21wYW5pZXNbMF0gfHwge307CiAgYXBwLmlubmVySFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFn' +
  'ZSI+U2V0dXA8L2gxPgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+JHtpc093bmVyKCkgPyAnVGhpcyBjb21wYW55' +
  'JyA6ICdZb3VyIGNvbXBhbnknfQogICAgICAgIDxzcGFuIGNsYXNzPSJzdWIiPiR7ZXNjKGhlcmUucGxhbiA9PT0gJ3BybycgPyAn' +
  'UHJvJyA6ICdGcmVlJyl9JHsKICAgICAgICAgIGhlcmUucGxhbl9leHBpcmVzID8gJyB1bnRpbCAnICsgZm10RGF0ZU9ubHkoaGVy' +
  'ZS5wbGFuX2V4cGlyZXMpIDogJyd9PC9zcGFuPjwvaDI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+TmFtZTwvbGFi' +
  'ZWw+PGlucHV0IGlkPSJjb05hbWUiIHZhbHVlPSIke2VzYyhoZXJlLm5hbWUgfHwgJycpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xh' +
  'c3M9ImZpZWxkIj48bGFiZWw+Q29udGFjdCBlbWFpbDwvbGFiZWw+PGlucHV0IGlkPSJjb0VtYWlsIiB2YWx1ZT0iJHtlc2MoaGVy' +
  'ZS5jb250YWN0X2VtYWlsIHx8ICcnKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBob25lPC9sYWJl' +
  'bD48aW5wdXQgaWQ9ImNvUGhvbmUiIHZhbHVlPSIke2VzYyhoZXJlLnBob25lIHx8ICcnKX0iPjwvZGl2PgogICAgICA8YnV0dG9u' +
  'IGNsYXNzPSJidG4gc20iIGlkPSJjb1NhdmUiPlNhdmU8L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1h' +
  'cmdpbi10b3A6OHB4Ij5UaGlzIG5hbWUgYXBwZWFycyBvbiB5b3VyIGludm9pY2VzIGFuZCBwYXkgc3RhdGVtZW50cy48L2Rpdj4K' +
  'ICAgIDwvZGl2PgoKICAgICR7aXNPd25lcigpID8gYDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+QWxsIGNvbXBhbmllcyA8' +
  'c3BhbiBjbGFzcz0ic3ViIj4ke2NvbXBhbmllcy5sZW5ndGh9PC9zcGFuPjwvaDI+CiAgICAgIDx0YWJsZSBjbGFzcz0idGJsIj4K' +
  'ICAgICAgICA8dHI+PHRoPkNvbXBhbnk8L3RoPjx0aCBjbGFzcz0ibnVtIj5QZW9wbGU8L3RoPjx0aCBjbGFzcz0ibnVtIj5PcGVu' +
  'PC90aD48dGg+PC90aD48L3RyPgogICAgICAgICR7Y29tcGFuaWVzLm1hcChjID0+IGA8dHI+CiAgICAgICAgICA8dGQ+JHtlc2Mo' +
  'Yy5uYW1lKX0ke1MubWUuY29tcGFueSAmJiBjLmlkID09PSBTLm1lLmNvbXBhbnkuaWQgPyAnIDxzcGFuIGNsYXNzPSJwaWxsIj55' +
  'b3UgYXJlIGhlcmU8L3NwYW4+JyA6ICcnfQogICAgICAgICAgICA8ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyhjLmFkbWluX2VtYWls' +
  'IHx8ICdubyBhZG1pbiB5ZXQnKX0gwrcgJHtjLnBsYW4gPT09ICdwcm8nID8gJ1BybycgOiAnRnJlZSd9PC9kaXY+PC90ZD4KICAg' +
  'ICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke2MucGVvcGxlID8/ICfigJQnfTwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+' +
  'JHtjLm9wZW5fam9icyA/PyAn4oCUJ308L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPiR7Uy5tZS5jb21wYW55ICYmIGMu' +
  'aWQgPT09IFMubWUuY29tcGFueS5pZAogICAgICAgICAgICA/ICcnIDogYDxhIGhyZWY9IiMiIGRhdGEtZW50ZXI9IiR7Yy5pZH0i' +
  'PmVudGVyPC9hPmB9PC90ZD48L3RyPmApLmpvaW4oJycpfQogICAgICA8L3RhYmxlPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCIg' +
  'c3R5bGU9Im1hcmdpbi10b3A6MTJweCI+PGxhYmVsPlN0YXJ0IGFub3RoZXIgY29tcGFueTwvbGFiZWw+CiAgICAgICAgPGlucHV0' +
  'IGlkPSJuZXdDb05hbWUiIHBsYWNlaG9sZGVyPSJDb21wYW55IG5hbWUiPjwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4g' +
  'c20iIGlkPSJuZXdDbyI+Q3JlYXRlIGNvbXBhbnk8L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdp' +
  'bi10b3A6OHB4Ij5DcmVhdGluZyBhIGNvbXBhbnkgZ2l2ZXMgaXQgaXRzIG93biBqb2JzLCBjbGllbnRzIGFuZAogICAgICAgIGJp' +
  'bGxpbmcuIEFkZCBpdHMgYWRtaW5pc3RyYXRvciBmcm9tIGluc2lkZSBpdCwgb3IgaGFuZCB0aGVtIGFuIGFjY2VzcyBjb2RlLjwv' +
  'ZGl2PgogICAgPC9kaXY+YCA6ICcnfQoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+VGVhbSA8c3BhbiBjbGFzcz0i' +
  'c3ViIj4ke3VzZXJzLmxlbmd0aH08L3NwYW4+PC9oMj4KICAgICAgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgICAgIDx0cj48dGg+' +
  'TmFtZTwvdGg+PHRoPlJvbGU8L3RoPjx0aCBjbGFzcz0ibnVtIj5SYXRlPC90aD48dGg+PC90aD48L3RyPgogICAgICAgICR7dXNl' +
  'cnMubWFwKHUgPT4gYDx0cj48dGQ+JHtlc2ModS5uYW1lKX08ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyh1LmVtYWlsKX08L2Rpdj48' +
  'L3RkPgogICAgICAgICAgPHRkPiR7ZXNjKHUucm9sZSl9JHt1LmFjdGl2ZSA/ICcnIDogJyA8c3BhbiBjbGFzcz0icGlsbCI+b2Zm' +
  'PC9zcGFuPid9PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KHUuZGVmYXVsdF9wYXkpfTwvdGQ+CiAgICAg' +
  'ICAgICA8dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iIyIgZGF0YS11c2VyPSIke3UuaWR9Ij5lZGl0PC9hPjwvdGQ+PC90cj5gKS5q' +
  'b2luKCcnKX0KICAgICAgPC90YWJsZT4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBibG9jayBzbSIgaWQ9Im5ld1VzZXIi' +
  'IHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPisgQWRkIHBlcnNvbjwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0i' +
  'Y2FyZCI+CiAgICAgIDxoMj5DbGllbnRzIDxzcGFuIGNsYXNzPSJzdWIiPiR7Y2xpZW50cy5sZW5ndGh9PC9zcGFuPjwvaDI+CiAg' +
  'ICAgIDx0YWJsZSBjbGFzcz0idGJsIj4KICAgICAgICA8dHI+PHRoPk5hbWU8L3RoPjx0aCBjbGFzcz0ibnVtIj5EZWZhdWx0IGZl' +
  'ZTwvdGg+PHRoPjwvdGg+PC90cj4KICAgICAgICAke2NsaWVudHMubWFwKGMgPT4gYDx0cj48dGQ+JHtlc2MoYy5uYW1lKX08ZGl2' +
  'IGNsYXNzPSJoaW50Ij4ke2VzYyhjLmNvbnRhY3RfbmFtZSB8fCAnJyl9ICR7ZXNjKGMucGhvbmUgfHwgJycpfTwvZGl2PjwvdGQ+' +
  'CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHttb25leShjLmRlZmF1bHRfZmVlKX08L3RkPgogICAgICAgICAgPHRkIGNsYXNz' +
  'PSJudW0iPjxhIGhyZWY9IiMiIGRhdGEtY2xpZW50PSIke2MuaWR9Ij5lZGl0PC9hPjwvdGQ+PC90cj5gKS5qb2luKCcnKX0KICAg' +
  'ICAgPC90YWJsZT4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBibG9jayBzbSIgaWQ9Im5ld0NsaWVudCIgc3R5bGU9Im1h' +
  'cmdpbi10b3A6MTBweCI+KyBBZGQgY2xpZW50PC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAg' +
  'ICAgPGgyPkFmZmlkYXZpdCB0ZW1wbGF0ZXMgPHNwYW4gY2xhc3M9InN1YiI+JHt0ZW1wbGF0ZXMubGVuZ3RofTwvc3Bhbj48L2gy' +
  'PgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6LTRweCI+V3JpdGUgeW91ciBvd24gd29yZGluZyBwZXIg' +
  'Y291bnR5IG9yIGNsaWVudC4gTWVyZ2UgZmllbGRzIGZpbGwgaW4gZnJvbSB0aGUgam9iLAogICAgICBpbmNsdWRpbmcgdGhlIGZ1' +
  'bGwgYXR0ZW1wdCBsb2cgd2l0aCBHUFMuPC9wPgogICAgICA8dGFibGUgY2xhc3M9InRibCI+CiAgICAgICAgJHt0ZW1wbGF0ZXMu' +
  'bWFwKHQgPT4gYDx0cj48dGQ+JHtlc2ModC5uYW1lKX08ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyh0Lmp1cmlzZGljdGlvbiB8fCAn' +
  'Jyl9PC9kaXY+PC90ZD4KICAgICAgICAgIDx0ZD4ke3QuaXNfZGVmYXVsdCA/ICc8c3BhbiBjbGFzcz0icGlsbCBTZXJ2ZWQiPmRl' +
  'ZmF1bHQ8L3NwYW4+JyA6ICcnfTwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iIyIgZGF0YS10cGw9IiR7' +
  'dC5pZH0iPmVkaXQ8L2E+PC90ZD48L3RyPmApLmpvaW4oJycpfQogICAgICA8L3RhYmxlPgogICAgICA8YnV0dG9uIGNsYXNzPSJi' +
  'dG4gc2VjIGJsb2NrIHNtIiBpZD0ibmV3VHBsIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4rIE5ldyB0ZW1wbGF0ZTwvYnV0dG9u' +
  'PgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5BY2Nlc3MgY29kZXMgPHNwYW4gY2xhc3M9InN1' +
  'YiI+bGV0IHBlb3BsZSBzZXQgdXAgdGhlaXIgb3duIGFjY291bnQ8L3NwYW4+PC9oMj4KICAgICAgPHAgY2xhc3M9ImhpbnQiIHN0' +
  'eWxlPSJtYXJnaW4tdG9wOi00cHgiPkdlbmVyYXRlIGEgY29kZSBhbmQgc2VuZCBpdCBvdmVyLiBUaGV5IGVudGVyIGl0IG9uIHRo' +
  'ZSBzaWduLWluCiAgICAgICAgc2NyZWVuIHVuZGVyICJTZXQgdXAgeW91ciBhY2NvdW50IiwgcGljayB0aGVpciBvd24gcGFzc3dv' +
  'cmQsIGFuZCB0aGV5J3JlIGluIOKAlCBubyBuZWVkIHRvIGtleSBpbgogICAgICAgIHRoZWlyIGRldGFpbHMgb3Igc2hhcmUgYSBw' +
  'YXNzd29yZCB3aXRoIHRoZW0uPC9wPgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGczIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4K' +
  'ICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlRoZXkgYmVjb21lPC9sYWJlbD48c2VsZWN0IGlkPSJjX3JvbGUiPgog' +
  'ICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2VydmVyIj5GaWVsZCBzZXJ2ZXI8L29wdGlvbj48b3B0aW9uIHZhbHVlPSJhZG1pbiI+' +
  'QWRtaW48L29wdGlvbj48L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkhvdyBtYW55IGNh' +
  'biB1c2UgaXQ8L2xhYmVsPjxpbnB1dCBpZD0iY191c2VzIiB0eXBlPSJudW1iZXIiIG1pbj0iMSIgbWF4PSI1MDAiIHZhbHVlPSIx' +
  'Ij48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkV4cGlyZXMgKG9wdGlvbmFsKTwvbGFiZWw+PGlucHV0' +
  'IGlkPSJjX2V4cCIgdHlwZT0iZGF0ZSI+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAg' +
  'ICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBheSBwZXIgc2VydmUgKGZpZWxkIHNlcnZlcnMpPC9sYWJlbD48aW5wdXQg' +
  'aWQ9ImNfcGF5IiB0eXBlPSJudW1iZXIiIHN0ZXA9IjAuMDEiIHBsYWNlaG9sZGVyPSI0NS4wMCI+PC9kaXY+CiAgICAgICAgPGRp' +
  'diBjbGFzcz0iZmllbGQiPjxsYWJlbD5Ob3RlIHRvIHlvdXJzZWxmPC9sYWJlbD48aW5wdXQgaWQ9ImNfbm90ZSIgcGxhY2Vob2xk' +
  'ZXI9IkZvciBNYXJpYSDigJQgZXZpY3Rpb25zIj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBz' +
  'bSIgaWQ9ImNfbWFrZSI+R2VuZXJhdGUgYSBjb2RlPC9idXR0b24+CiAgICAgIDxkaXYgaWQ9ImNfbGlzdCIgc3R5bGU9Im1hcmdp' +
  'bi10b3A6MTJweCI+JHtjb2Rlc1RhYmxlKGNvZGVzKX08L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgog' +
  'ICAgICA8aDI+Q291cnQgcG9ydGFsIHByb2JlIDxzcGFuIGNsYXNzPSJzdWIiPmV4cGVyaW1lbnRhbDwvc3Bhbj48L2gyPgogICAg' +
  'ICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6LTRweCI+QXNrcyB0aGUgc2VydmVyIHRvIGZldGNoIGEgY291bnR5' +
  'IHBvcnRhbCBhbmQgcmVwb3J0IHdoYXQgY2FtZSBiYWNrIOKAlAogICAgICAgIHN0YXR1cywgY29va2llcywgZm9ybXMsIGxpbmtz' +
  'LiBUaGlzIGlzIHRoZSBncm91bmR3b3JrIGZvciBhdXRvbWF0aWMgY2FzZSBsb29rdXA6IHRoZXNlIHBvcnRhbHMgY2FuJ3QgYmUK' +
  'ICAgICAgICByZWFjaGVkIGZyb20gd2hlcmUgdGhpcyBhcHAgd2FzIHdyaXR0ZW4sIHNvIHRoZSBzZXJ2ZXIgaGFzIHRvIGdvIGFu' +
  'ZCBsb29rLiBSdW4gb25lIGFuZCBzZW5kIG1lIHRoZSByZXN1bHQuPC9wPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIGlkPSJwcm9i' +
  'ZUJ0bnMiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPiR7cG9ydGFscy5tYXAocHQgPT4KICAgICAgICBgPGJ1dHRvbiBjbGFzcz0i' +
  'YnRuIHNlYyBzbSIgZGF0YS1wcm9iZT0iJHtlc2MocHQua2V5KX0iPiR7ZXNjKHB0LmxhYmVsKX08L2J1dHRvbj5gKS5qb2luKCcn' +
  'KX08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4KICAgICAgICA8aW5wdXQgaWQ9' +
  'InByb2JlVXJsIiBwbGFjZWhvbGRlcj0i4oCmb3IgYSBzcGVjaWZpYyBwYWdlIFVSTCIgc3R5bGU9ImZsZXg6MTttaW4td2lkdGg6' +
  'MTUwcHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJwcm9iZUdvIj5Qcm9iZSBVUkw8L2J1dHRvbj4K' +
  'ICAgICAgPC9kaXY+CiAgICAgIDxwcmUgY2xhc3M9InByZXYiIGlkPSJwcm9iZU91dCIgc3R5bGU9ImRpc3BsYXk6bm9uZTttYXJn' +
  'aW4tdG9wOjEwcHgiPjwvcHJlPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIGJsb2NrIiBpZD0iY29weVByb2JlIiBz' +
  'dHlsZT0iZGlzcGxheTpub25lO21hcmdpbi10b3A6OHB4Ij5Db3B5IHJlc3VsdDwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPGRp' +
  'diBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5NeSBhY2NvdW50PC9oMj4KICAgICAgPGRpdiBjbGFzcz0iaGludCI+T25lIHBhc3N3' +
  'b3JkLCBldmVyeSBhcHAuIENoYW5naW5nIGl0IGhlcmUgY2hhbmdlcyBpdCBldmVyeXdoZXJlLjwvZGl2PgogICAgICA8ZGl2IGNs' +
  'YXNzPSJmaWVsZCI+PGxhYmVsPkN1cnJlbnQgcGFzc3dvcmQ8L2xhYmVsPjxpbnB1dCBpZD0ib3B3IiB0eXBlPSJwYXNzd29yZCIg' +
  'cGxhY2Vob2xkZXI9InRoZSBvbmUgeW91IHNpZ25lZCBpbiB3aXRoIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxs' +
  'YWJlbD5OZXcgcGFzc3dvcmQ8L2xhYmVsPjxpbnB1dCBpZD0ibnB3IiB0eXBlPSJwYXNzd29yZCIgcGxhY2Vob2xkZXI9IjgrIGNo' +
  'YXJhY3RlcnMiPjwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc20iIGlkPSJzYXZlUHciPlVwZGF0ZSBwYXNzd29yZDwv' +
  'YnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBpZD0iYnVpbGRTdGFtcCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+YnVp' +
  'bGQg4oCmPC9kaXY+CiAgICA8L2Rpdj5gKTsKICBiaW5kU2hlbGwoKTsKCiAgZmV0Y2goJy9hcGkvYnVpbGQnKS50aGVuKHIgPT4g' +
  'ci5qc29uKCkpLnRoZW4oYiA9PiB7CiAgICBjb25zdCBlbCA9ICQoJyNidWlsZFN0YW1wJyk7CiAgICBpZiAoZWwpIGVsLnRleHRD' +
  'b250ZW50ID0gJ1NlcnZlVHJhY2sgYnVpbGQgJyArIGIuYnVpbGQgKyAoYi5wcm9iZVRhcmdldHMgPyAnIMK3IGJvb3QgcHJvYmUg' +
  'YXJtZWQnIDogJycpOwogIH0pLmNhdGNoKCgpID0+IHt9KTsKCgogIC8qIC0tLS0gYWNjZXNzIGNvZGVzIC0tLS0gKi8KICBhc3lu' +
  'YyBmdW5jdGlvbiBkcmF3Q29kZXMoKSB7CiAgICAkKCcjY19saXN0JykuaW5uZXJIVE1MID0gY29kZXNUYWJsZShhd2FpdCBhcGko' +
  'Jy9jb2RlcycpKTsKICAgIHdpcmVDb2RlcygpOwogIH0KCiAgZnVuY3Rpb24gd2lyZUNvZGVzKCkgewogICAgZG9jdW1lbnQucXVl' +
  'cnlTZWxlY3RvckFsbCgnW2RhdGEtY29weV0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNrID0gYXN5bmMgZSA9PiB7CiAgICAgIGUu' +
  'cHJldmVudERlZmF1bHQoKTsKICAgICAgdHJ5IHsgYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoYS5kYXRhc2V0' +
  'LmNvcHkpOyB0b2FzdCgnQ29waWVkICcgKyBhLmRhdGFzZXQuY29weSk7IH0KICAgICAgY2F0Y2ggKGVycikgeyB0b2FzdCgnU2Vs' +
  'ZWN0IGl0IGFuZCBjb3B5IGJ5IGhhbmQnLCB0cnVlKTsgfQogICAgfSk7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdb' +
  'ZGF0YS1yZXZva2VdJykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGFzeW5jIGUgPT4gewogICAgICBlLnByZXZlbnREZWZhdWx0' +
  'KCk7CiAgICAgIGlmICghY29uZmlybSgnUmV2b2tlIHRoaXMgY29kZT8gQW55b25lIHdobyBhbHJlYWR5IHVzZWQgaXQga2VlcHMg' +
  'dGhlaXIgYWNjb3VudC4nKSkgcmV0dXJuOwogICAgICBhd2FpdCBhcGkoJy9jb2Rlcy8nICsgYS5kYXRhc2V0LnJldm9rZSwgeyBt' +
  'ZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcmV2b2tlZDogdHJ1ZSB9KSB9KTsKICAgICAgdG9hc3QoJ1Jl' +
  'dm9rZWQnKTsgZHJhd0NvZGVzKCk7CiAgICB9KTsKICB9CiAgd2lyZUNvZGVzKCk7CgogICQoJyNjX21ha2UnKS5vbmNsaWNrID0g' +
  'YXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAgICAgY29uc3QgbWFkZSA9IGF3YWl0IGFwaSgnL2NvZGVzJywgeyBtZXRob2Q6ICdQ' +
  'T1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHJvbGU6ICQoJyNjX3JvbGUnKS52YWx1ZSwKICAgICAgICBtYXhf' +
  'dXNlczogJCgnI2NfdXNlcycpLnZhbHVlLAogICAgICAgIGV4cGlyZXNfYXQ6ICQoJyNjX2V4cCcpLnZhbHVlIHx8IG51bGwsCiAg' +
  'ICAgICAgZGVmYXVsdF9wYXk6ICQoJyNjX3BheScpLnZhbHVlIHx8IDAsCiAgICAgICAgbm90ZTogJCgnI2Nfbm90ZScpLnZhbHVl' +
  'CiAgICAgIH0pIH0pOwogICAgICAkKCcjY19ub3RlJykudmFsdWUgPSAnJzsKICAgICAgdG9hc3QoJ0NvZGUgJyArIG1hZGUuY29k' +
  'ZSk7CiAgICAgIGRyYXdDb2RlcygpOwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKICBk' +
  'cmF3Q29kZXMoKS5jYXRjaCgoKSA9PiB7fSk7CgogIC8qIC0tLS0gcG9ydGFsIHByb2JlIC0tLS0gKi8KICBjb25zdCBwcm9iZU91' +
  'dCA9ICQoJyNwcm9iZU91dCcpOwogIGNvbnN0IHJ1blByb2JlID0gYXN5bmMgYm9keSA9PiB7CiAgICBwcm9iZU91dC5zdHlsZS5k' +
  'aXNwbGF5ID0gJyc7CiAgICBwcm9iZU91dC50ZXh0Q29udGVudCA9ICdQcm9iaW5n4oCmICh0aGlzIGNhbiB0YWtlIHVwIHRvIDIw' +
  'IHNlY29uZHMpJzsKICAgICQoJyNjb3B5UHJvYmUnKS5zdHlsZS5kaXNwbGF5ID0gJyc7CiAgICB0cnkgewogICAgICBjb25zdCBy' +
  'ID0gYXdhaXQgYXBpKCcvcG9ydGFsLXByb2JlJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkg' +
  'fSk7CiAgICAgIHByb2JlT3V0LnRleHRDb250ZW50ID0gSlNPTi5zdHJpbmdpZnkociwgbnVsbCwgMik7CiAgICB9IGNhdGNoIChl' +
  'KSB7CiAgICAgIHByb2JlT3V0LnRleHRDb250ZW50ID0gJ1Byb2JlIGZhaWxlZDogJyArIGUubWVzc2FnZTsKICAgIH0KICB9Owog' +
  'IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXByb2JlXScpLmZvckVhY2goYiA9PgogICAgYi5vbmNsaWNrID0gKCkg' +
  'PT4gcnVuUHJvYmUoeyBwb3J0YWw6IGIuZGF0YXNldC5wcm9iZSB9KSk7CiAgJCgnI3Byb2JlR28nKS5vbmNsaWNrID0gKCkgPT4g' +
  'ewogICAgY29uc3QgdSA9ICQoJyNwcm9iZVVybCcpLnZhbHVlLnRyaW0oKTsKICAgIGlmICh1KSBydW5Qcm9iZSh7IHVybDogdSB9' +
  'KTsKICB9OwogICQoJyNjb3B5UHJvYmUnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsgYXdhaXQgbmF2aWdhdG9y' +
  'LmNsaXBib2FyZC53cml0ZVRleHQocHJvYmVPdXQudGV4dENvbnRlbnQpOyB0b2FzdCgnQ29waWVkJyk7IH0KICAgIGNhdGNoIChl' +
  'KSB7IHRvYXN0KCdTZWxlY3QgdGhlIHRleHQgYW5kIGNvcHkgaXQgYnkgaGFuZCcsIHRydWUpOyB9CiAgfTsKCiAgZG9jdW1lbnQu' +
  'cXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdXNlcl0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNrID0gZSA9PiB7CiAgICBlLnByZXZl' +
  'bnREZWZhdWx0KCk7IHVzZXJGb3JtKHVzZXJzLmZpbmQodSA9PiBTdHJpbmcodS5pZCkgPT09IGEuZGF0YXNldC51c2VyKSk7CiAg' +
  'fSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtY2xpZW50XScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sgPSBl' +
  'ID0+IHsKICAgIGUucHJldmVudERlZmF1bHQoKTsgY2xpZW50Rm9ybShjbGllbnRzLmZpbmQoYyA9PiBTdHJpbmcoYy5pZCkgPT09' +
  'IGEuZGF0YXNldC5jbGllbnQpKTsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS10cGxdJykuZm9yRWFj' +
  'aChhID0+IGEub25jbGljayA9IGUgPT4gewogICAgZS5wcmV2ZW50RGVmYXVsdCgpOyB0ZW1wbGF0ZUZvcm0odGVtcGxhdGVzLmZp' +
  'bmQodCA9PiBTdHJpbmcodC5pZCkgPT09IGEuZGF0YXNldC50cGwpKTsKICB9KTsKICBjb25zdCBjb1NhdmUgPSAkKCcjY29TYXZl' +
  'Jyk7CiAgaWYgKGNvU2F2ZSkgY29TYXZlLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBhd2FpdCBhcGko' +
  'Jy9jb21wYW5pZXMvJyArIChoZXJlLmlkKSwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsKICAgICAg' +
  'ICBuYW1lOiAkKCcjY29OYW1lJykudmFsdWUsIGNvbnRhY3RfZW1haWw6ICQoJyNjb0VtYWlsJykudmFsdWUsIHBob25lOiAkKCcj' +
  'Y29QaG9uZScpLnZhbHVlIH0pIH0pOwogICAgICBTLm1lID0gYXdhaXQgYXBpKCcvbWUnKTsKICAgICAgdG9hc3QoJ0NvbXBhbnkg' +
  'c2F2ZWQnKTsKICAgICAgcmVuZGVyKCk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9Owog' +
  'IGNvbnN0IG5ld0NvID0gJCgnI25ld0NvJyk7CiAgaWYgKG5ld0NvKSBuZXdDby5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAg' +
  'Y29uc3QgbmFtZSA9ICQoJyNuZXdDb05hbWUnKS52YWx1ZS50cmltKCk7CiAgICBpZiAoIW5hbWUpIHJldHVybiB0b2FzdCgnR2l2' +
  'ZSB0aGUgY29tcGFueSBhIG5hbWUnLCB0cnVlKTsKICAgIHRyeSB7CiAgICAgIGF3YWl0IGFwaSgnL2NvbXBhbmllcycsIHsgbWV0' +
  'aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgbmFtZSB9KSB9KTsKICAgICAgUy5tZSA9IGF3YWl0IGFwaSgnL21l' +
  'Jyk7CiAgICAgIHRvYXN0KG5hbWUgKyAnIGNyZWF0ZWQnKTsKICAgICAgcmVuZGVyKCk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0' +
  'KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9OwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWVudGVyXScpLmZvckVh' +
  'Y2goYSA9PiBhLm9uY2xpY2sgPSBhc3luYyBlID0+IHsKICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgIHRyeSB7CiAgICAgIGNv' +
  'bnN0IG91dCA9IGF3YWl0IGFwaSgnL2NvbXBhbmllcy8nICsgYS5kYXRhc2V0LmVudGVyICsgJy9lbnRlcicsIHsgbWV0aG9kOiAn' +
  'UE9TVCcgfSk7CiAgICAgIFMubWUgPSBhd2FpdCBhcGkoJy9tZScpOwogICAgICB0b2FzdCgnTm93IGluICcgKyBvdXQuY29tcGFu' +
  'eS5uYW1lKTsKICAgICAgcmVuZGVyKCk7CiAgICB9IGNhdGNoIChlcnIpIHsgdG9hc3QoZXJyLm1lc3NhZ2UsIHRydWUpOyB9CiAg' +
  'fSk7CiAgJCgnI25ld1VzZXInKS5vbmNsaWNrID0gKCkgPT4gdXNlckZvcm0obnVsbCk7CiAgJCgnI25ld0NsaWVudCcpLm9uY2xp' +
  'Y2sgPSAoKSA9PiBjbGllbnRGb3JtKG51bGwpOwogICQoJyNuZXdUcGwnKS5vbmNsaWNrID0gKCkgPT4gdGVtcGxhdGVGb3JtKG51' +
  'bGwpOwogICQoJyNzYXZlUHcnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAgICAgY29uc3QgciA9IGF3YWl0' +
  'IGFwaSgnL21lL3Bhc3N3b3JkJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHBhc3N3' +
  'b3JkOiAkKCcjbnB3JykudmFsdWUsIG9sZF9wYXNzd29yZDogJCgnI29wdycpLnZhbHVlIH0pIH0pOwogICAgICAkKCcjb3B3Jyku' +
  'dmFsdWUgPSAnJzsgJCgnI25wdycpLnZhbHVlID0gJyc7CiAgICAgIHRvYXN0KHIuZXZlcnl3aGVyZSA9PT0gZmFsc2UgPyAnQ2hh' +
  'bmdlZCBoZXJlIOKAlCBvdGhlciBhcHBzIHN0aWxsIGhhdmUgdGhlIG9sZCBvbmUnIDogJ1Bhc3N3b3JkIHVwZGF0ZWQgZXZlcnl3' +
  'aGVyZScpOwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKfQoKZnVuY3Rpb24gdXNlckZv' +
  'cm0odSkgewogIGNvbnN0IHYgPSB1IHx8IHsgcm9sZTogJ3NlcnZlcicsIGFjdGl2ZTogdHJ1ZSB9OwogIHNoZWV0KHUgPyAnRWRp' +
  'dCAnICsgdS5uYW1lIDogJ0FkZCBwZXJzb24nLCBgCiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk5hbWU8L2xhYmVsPjxp' +
  'bnB1dCBpZD0idV9uYW1lIiB2YWx1ZT0iJHtlc2Modi5uYW1lKX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJl' +
  'bD5FbWFpbCAodXNlZCB0byBzaWduIGluKTwvbGFiZWw+PGlucHV0IGlkPSJ1X2VtYWlsIiB0eXBlPSJlbWFpbCIgdmFsdWU9IiR7' +
  'ZXNjKHYuZW1haWwpfSI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPiR7dSA/ICdOZXcgcGFzc3dvcmQgKGxl' +
  'YXZlIGJsYW5rIHRvIGtlZXApJyA6ICdQYXNzd29yZCd9PC9sYWJlbD48aW5wdXQgaWQ9InVfcGFzc3dvcmQiIHR5cGU9InRleHQi' +
  'IHBsYWNlaG9sZGVyPSIke3UgPyAndW5jaGFuZ2VkJyA6ICdzZXQgYSBwYXNzd29yZCd9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9' +
  'ImdyaWQgZzIiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlJvbGU8L2xhYmVsPjxzZWxlY3QgaWQ9InVfcm9sZSI+' +
  'CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2VydmVyIiAke3Yucm9sZSA9PT0gJ3NlcnZlcicgPyAnc2VsZWN0ZWQnIDogJyd9PkZp' +
  'ZWxkIHNlcnZlcjwvb3B0aW9uPgogICAgICAgIDxvcHRpb24gdmFsdWU9ImFkbWluIiAke3Yucm9sZSA9PT0gJ2FkbWluJyA/ICdz' +
  'ZWxlY3RlZCcgOiAnJ30+QWRtaW48L29wdGlvbj4KICAgICAgICAke2lzT3duZXIoKSA/IGA8b3B0aW9uIHZhbHVlPSJvd25lciIg' +
  'JHt2LnJvbGUgPT09ICdvd25lcicgPyAnc2VsZWN0ZWQnIDogJyd9Pk93bmVyIChldmVyeSBjb21wYW55KTwvb3B0aW9uPmAgOiAn' +
  'J30KICAgICAgPC9zZWxlY3Q+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RGVmYXVsdCBwYXkgcGVyIHNl' +
  'cnZlPC9sYWJlbD48aW5wdXQgaWQ9InVfZGVmYXVsdF9wYXkiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgdmFsdWU9IiR7di5k' +
  'ZWZhdWx0X3BheSB8fCAnJ30iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBob25lPC9sYWJlbD48aW5w' +
  'dXQgaWQ9InVfcGhvbmUiIHZhbHVlPSIke2VzYyh2LnBob25lKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxh' +
  'YmVsPkxpY2Vuc2UgLyByZWdpc3RyYXRpb24gIzwvbGFiZWw+PGlucHV0IGlkPSJ1X2xpY2Vuc2Vfbm8iIHZhbHVlPSIke2VzYyh2' +
  'LmxpY2Vuc2Vfbm8pfSI+PC9kaXY+CiAgICA8L2Rpdj4KICAgICR7dSA/IGA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlN0YXR1' +
  'czwvbGFiZWw+PHNlbGVjdCBpZD0idV9hY3RpdmUiPgogICAgICA8b3B0aW9uIHZhbHVlPSJ0cnVlIiAke3YuYWN0aXZlID8gJ3Nl' +
  'bGVjdGVkJyA6ICcnfT5BY3RpdmU8L29wdGlvbj4KICAgICAgPG9wdGlvbiB2YWx1ZT0iZmFsc2UiICR7IXYuYWN0aXZlID8gJ3Nl' +
  'bGVjdGVkJyA6ICcnfT5EZWFjdGl2YXRlZDwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2PmAgOiAnJ30KICAgIDxkaXYgY2xhc3M9InJv' +
  'dyI+PGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0ic2F2ZSI+U2F2ZTwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIg' +
  'b25jbGljaz0iY2xvc2VTaGVldCgpIj5DYW5jZWw8L2J1dHRvbj48L2Rpdj5gLCBlbCA9PiB7CiAgICBlbC5xdWVyeVNlbGVjdG9y' +
  'KCcjc2F2ZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IGJvZHkgPSB7CiAgICAgICAgbmFtZTogZWwucXVl' +
  'cnlTZWxlY3RvcignI3VfbmFtZScpLnZhbHVlLCBlbWFpbDogZWwucXVlcnlTZWxlY3RvcignI3VfZW1haWwnKS52YWx1ZSwKICAg' +
  'ICAgICByb2xlOiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9yb2xlJykudmFsdWUsIHBob25lOiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9w' +
  'aG9uZScpLnZhbHVlLAogICAgICAgIGxpY2Vuc2Vfbm86IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X2xpY2Vuc2Vfbm8nKS52YWx1ZSwK' +
  'ICAgICAgICBkZWZhdWx0X3BheTogZWwucXVlcnlTZWxlY3RvcignI3VfZGVmYXVsdF9wYXknKS52YWx1ZSB8fCAwCiAgICAgIH07' +
  'CiAgICAgIGNvbnN0IHB3ID0gZWwucXVlcnlTZWxlY3RvcignI3VfcGFzc3dvcmQnKS52YWx1ZTsKICAgICAgaWYgKHB3KSBib2R5' +
  'LnBhc3N3b3JkID0gcHc7CiAgICAgIGlmICh1KSBib2R5LmFjdGl2ZSA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X2FjdGl2ZScpLnZh' +
  'bHVlID09PSAndHJ1ZSc7CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgKHUgPyBhcGkoJy91c2Vycy8nICsgdS5pZCwgeyBtZXRo' +
  'b2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pCiAgICAgICAgICAgICAgICAgOiBhcGkoJy91c2Vycycs' +
  'IHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pKTsKICAgICAgICBjbG9zZVNoZWV0KCk7IHRv' +
  'YXN0KCdTYXZlZCcpOyBnbygnYWRtaW4nKTsKICAgICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAg' +
  'ICB9OwogIH0pOwp9CgpmdW5jdGlvbiBjbGllbnRGb3JtKGMpIHsKICBjb25zdCB2ID0gYyB8fCB7fTsKICBzaGVldChjID8gJ0Vk' +
  'aXQgJyArIGMubmFtZSA6ICdBZGQgY2xpZW50JywgYAogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5GaXJtIC8gY2xpZW50' +
  'IG5hbWU8L2xhYmVsPjxpbnB1dCBpZD0iY19uYW1lIiB2YWx1ZT0iJHtlc2Modi5uYW1lKX0iPjwvZGl2PgogICAgPGRpdiBjbGFz' +
  'cz0iZ3JpZCBnMiI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q29udGFjdDwvbGFiZWw+PGlucHV0IGlkPSJjX2Nv' +
  'bnRhY3RfbmFtZSIgdmFsdWU9IiR7ZXNjKHYuY29udGFjdF9uYW1lKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+' +
  'PGxhYmVsPlBob25lPC9sYWJlbD48aW5wdXQgaWQ9ImNfcGhvbmUiIHZhbHVlPSIke2VzYyh2LnBob25lKX0iPjwvZGl2PgogICAg' +
  'ICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkVtYWlsPC9sYWJlbD48aW5wdXQgaWQ9ImNfZW1haWwiIHR5cGU9ImVtYWlsIiB2' +
  'YWx1ZT0iJHtlc2Modi5lbWFpbCl9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5EZWZhdWx0IGZlZSBw' +
  'ZXIgc2VydmU8L2xhYmVsPjxpbnB1dCBpZD0iY19kZWZhdWx0X2ZlZSIgdHlwZT0ibnVtYmVyIiBzdGVwPSIwLjAxIiB2YWx1ZT0i' +
  'JHt2LmRlZmF1bHRfZmVlIHx8ICcnfSI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Qmls' +
  'bGluZyBhZGRyZXNzPC9sYWJlbD48dGV4dGFyZWEgaWQ9ImNfYWRkcmVzcyIgc3R5bGU9Im1pbi1oZWlnaHQ6NjBweCI+JHtlc2Mo' +
  'di5hZGRyZXNzKX08L3RleHRhcmVhPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Ob3RlczwvbGFiZWw+PHRl' +
  'eHRhcmVhIGlkPSJjX25vdGVzIiBzdHlsZT0ibWluLWhlaWdodDo2MHB4Ij4ke2VzYyh2Lm5vdGVzKX08L3RleHRhcmVhPjwvZGl2' +
  'PgogICAgPGRpdiBjbGFzcz0icm93Ij48YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJzYXZlIj5TYXZlPC9idXR0b24+CiAgICA8YnV0' +
  'dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNhbmNlbDwvYnV0dG9uPjwvZGl2PmAsIGVsID0+IHsK' +
  'ICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNzYXZlJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgYm9keSA9IHt9' +
  'OwogICAgICBbJ25hbWUnLCdjb250YWN0X25hbWUnLCdwaG9uZScsJ2VtYWlsJywnZGVmYXVsdF9mZWUnLCdhZGRyZXNzJywnbm90' +
  'ZXMnXQogICAgICAgIC5mb3JFYWNoKGYgPT4gYm9keVtmXSA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNjXycgKyBmKS52YWx1ZSk7CiAg' +
  'ICAgIHRyeSB7CiAgICAgICAgYXdhaXQgKGMgPyBhcGkoJy9jbGllbnRzLycgKyBjLmlkLCB7IG1ldGhvZDogJ1BBVENIJywgYm9k' +
  'eTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSkKICAgICAgICAgICAgICAgICA6IGFwaSgnL2NsaWVudHMnLCB7IG1ldGhvZDogJ1BP' +
  'U1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KSk7CiAgICAgICAgY2xvc2VTaGVldCgpOyB0b2FzdCgnU2F2ZWQnKTsg' +
  'Z28oJ2FkbWluJyk7CiAgICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogICAgfTsKICB9KTsKfQoK' +
  'YXN5bmMgZnVuY3Rpb24gdGVtcGxhdGVGb3JtKHQpIHsKICBjb25zdCBmaWVsZHMgPSBhd2FpdCBhcGkoJy90ZW1wbGF0ZS1maWVs' +
  'ZHMnKTsKICBjb25zdCB2ID0gdCB8fCB7IGJvZHk6ICcnLCBpc19kZWZhdWx0OiBmYWxzZSB9OwogIHNoZWV0KHQgPyAnRWRpdCB0' +
  'ZW1wbGF0ZScgOiAnTmV3IGFmZmlkYXZpdCB0ZW1wbGF0ZScsIGAKICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICA8ZGl2' +
  'IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlRlbXBsYXRlIG5hbWU8L2xhYmVsPjxpbnB1dCBpZD0idF9uYW1lIiB2YWx1ZT0iJHtlc2Mo' +
  'di5uYW1lKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkp1cmlzZGljdGlvbiAvIGNvdXJ0PC9sYWJl' +
  'bD48aW5wdXQgaWQ9InRfanVyaXNkaWN0aW9uIiB2YWx1ZT0iJHtlc2Modi5qdXJpc2RpY3Rpb24pfSI+PC9kaXY+CiAgICA8L2Rp' +
  'dj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Qm9keTwvbGFiZWw+CiAgICAgIDx0ZXh0YXJlYSBpZD0idF9ib2R5IiBz' +
  'dHlsZT0ibWluLWhlaWdodDoyMjBweDtmb250OjEyLjVweC8xLjUgJ0NvdXJpZXIgTmV3Jyxtb25vc3BhY2UiPiR7ZXNjKHYuYm9k' +
  'eSl9PC90ZXh0YXJlYT4KICAgICAgPGRpdiBjbGFzcz0iaGludCI+Q2xpY2sgYSBmaWVsZCB0byBpbnNlcnQgaXQgYXQgdGhlIGN1' +
  'cnNvcjo8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idG9rZW5zIj4ke2ZpZWxkcy5tYXAoZiA9PiBgPGJ1dHRvbiBkYXRhLWY9IiR7' +
  'ZlswXX0iIHRpdGxlPSIke2VzYyhmWzFdKX0iPnt7JHtmWzBdfX19PC9idXR0b24+YCkuam9pbignJyl9PC9kaXY+CiAgICA8L2Rp' +
  'dj4KICAgIDxsYWJlbCBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6OHB4Ij48aW5wdXQgdHlwZT0i' +
  'Y2hlY2tib3giIGlkPSJ0X2RlZmF1bHQiIHN0eWxlPSJ3aWR0aDphdXRvIiAke3YuaXNfZGVmYXVsdCA/ICdjaGVja2VkJyA6ICcn' +
  'fT4gVXNlIGFzIHRoZSBkZWZhdWx0IHRlbXBsYXRlPC9sYWJlbD4KICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10' +
  'b3A6MTJweCI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InNhdmUiPlNhdmU8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBj' +
  'bGFzcz0iYnRuIHNlYyIgaWQ9InByZXZpZXciPlByZXZpZXcgd2l0aCByZWFsIGpvYjwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNs' +
  'YXNzPSJidG4gc2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNhbmNlbDwvYnV0dG9uPgogICAgICAke3QgPyAnPGJ1dHRvbiBj' +
  'bGFzcz0iYnRuIGdob3N0IiBpZD0iZGVsIiBzdHlsZT0iY29sb3I6dmFyKC0tYmFkKTttYXJnaW4tbGVmdDphdXRvIj5EZWxldGU8' +
  'L2J1dHRvbj4nIDogJyd9CiAgICA8L2Rpdj4KICAgIDxwcmUgY2xhc3M9InByZXYiIGlkPSJ0cHJldiIgc3R5bGU9ImRpc3BsYXk6' +
  'bm9uZTttYXJnaW4tdG9wOjEycHgiPjwvcHJlPmAsIGVsID0+IHsKICAgIGNvbnN0IHRhID0gZWwucXVlcnlTZWxlY3RvcignI3Rf' +
  'Ym9keScpOwogICAgZWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtZl0nKS5mb3JFYWNoKGIgPT4gYi5vbmNsaWNrID0gKCkgPT4g' +
  'ewogICAgICBjb25zdCB0b2sgPSAne3snICsgYi5kYXRhc2V0LmYgKyAnfX0nOwogICAgICBjb25zdCBzID0gdGEuc2VsZWN0aW9u' +
  'U3RhcnQsIGUgPSB0YS5zZWxlY3Rpb25FbmQ7CiAgICAgIHRhLnZhbHVlID0gdGEudmFsdWUuc2xpY2UoMCwgcykgKyB0b2sgKyB0' +
  'YS52YWx1ZS5zbGljZShlKTsKICAgICAgdGEuZm9jdXMoKTsgdGEuc2VsZWN0aW9uU3RhcnQgPSB0YS5zZWxlY3Rpb25FbmQgPSBz' +
  'ICsgdG9rLmxlbmd0aDsKICAgIH0pOwogICAgZWwucXVlcnlTZWxlY3RvcignI3ByZXZpZXcnKS5vbmNsaWNrID0gYXN5bmMgKCkg' +
  'PT4gewogICAgICBjb25zdCByID0gYXdhaXQgYXBpKCcvdGVtcGxhdGVzL3ByZXZpZXcnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5' +
  'OiBKU09OLnN0cmluZ2lmeSh7IGJvZHk6IHRhLnZhbHVlIH0pIH0pOwogICAgICBjb25zdCBwID0gZWwucXVlcnlTZWxlY3Rvcign' +
  'I3RwcmV2Jyk7CiAgICAgIHAuc3R5bGUuZGlzcGxheSA9ICcnOyBwLnRleHRDb250ZW50ID0gci50ZXh0OwogICAgfTsKICAgIGVs' +
  'LnF1ZXJ5U2VsZWN0b3IoJyNzYXZlJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgYm9keSA9IHsKICAgICAg' +
  'ICBuYW1lOiBlbC5xdWVyeVNlbGVjdG9yKCcjdF9uYW1lJykudmFsdWUsIGp1cmlzZGljdGlvbjogZWwucXVlcnlTZWxlY3Rvcign' +
  'I3RfanVyaXNkaWN0aW9uJykudmFsdWUsCiAgICAgICAgYm9keTogdGEudmFsdWUsIGlzX2RlZmF1bHQ6IGVsLnF1ZXJ5U2VsZWN0' +
  'b3IoJyN0X2RlZmF1bHQnKS5jaGVja2VkCiAgICAgIH07CiAgICAgIGlmICghYm9keS5uYW1lLnRyaW0oKSkgcmV0dXJuIHRvYXN0' +
  'KCdHaXZlIHRoZSB0ZW1wbGF0ZSBhIG5hbWUnLCB0cnVlKTsKICAgICAgdHJ5IHsKICAgICAgICBhd2FpdCAodCA/IGFwaSgnL3Rl' +
  'bXBsYXRlcy8nICsgdC5pZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pCiAgICAgICAg' +
  'ICAgICAgICAgOiBhcGkoJy90ZW1wbGF0ZXMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9' +
  'KSk7CiAgICAgICAgY2xvc2VTaGVldCgpOyB0b2FzdCgnU2F2ZWQnKTsgZ28oJ2FkbWluJyk7CiAgICAgIH0gY2F0Y2ggKGUpIHsg' +
  'dG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogICAgfTsKICAgIGlmIChlbC5xdWVyeVNlbGVjdG9yKCcjZGVsJykpIGVsLnF1ZXJ5' +
  'U2VsZWN0b3IoJyNkZWwnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBpZiAoIWNvbmZpcm0oJ0RlbGV0ZSB0aGlzIHRl' +
  'bXBsYXRlPycpKSByZXR1cm47CiAgICAgIGF3YWl0IGFwaSgnL3RlbXBsYXRlcy8nICsgdC5pZCwgeyBtZXRob2Q6ICdERUxFVEUn' +
  'IH0pOwogICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KCdEZWxldGVkJyk7IGdvKCdhZG1pbicpOwogICAgfTsKICB9KTsKfQoKLyog' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGJvb3QgLS0gKi8K' +
  'Y29uc3QgVklFV1MgPSB7IGRhc2g6IGRhc2hWaWV3LCBqb2JzOiBqb2JzVmlldywgam9iOiBqb2JWaWV3LCBzY2FuOiBzY2FuVmll' +
  'dywKICB0b29sczogdG9vbHNWaWV3LCBwcm9wZXJ0eTogcHJvcGVydHlWaWV3LCBtb25leTogbW9uZXlWaWV3LCBhZG1pbjogYWRt' +
  'aW5WaWV3IH07Cgphc3luYyBmdW5jdGlvbiByZW5kZXIoKSB7CiAgY2xvc2VTaGVldCgpOwogIGlmICghUy5tZSkgcmV0dXJuIGxv' +
  'Z2luVmlldygpOwogIGlmIChTLnZpZXcgPT09ICdqb2JzJykgUy5jYWNoZS5qb2JGaWx0ZXIgPSBTLnBhcmFtczsKICBjb25zdCBm' +
  'biA9IFZJRVdTW1Mudmlld10gfHwgZGFzaFZpZXc7CiAgdHJ5IHsKICAgIGFwcC5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0id3Jh' +
  'cCI+PGRpdiBjbGFzcz0iZW1wdHkiPkxvYWRpbmfigKY8L2Rpdj48L2Rpdj4nOwogICAgYXdhaXQgZm4oKTsKICB9IGNhdGNoIChl' +
  'KSB7CiAgICBpZiAoUy5tZSkgeyBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYDxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImVt' +
  'cHR5Ij4ke2VzYyhlLm1lc3NhZ2UpfTwvZGl2PjwvZGl2PmApOyBiaW5kU2hlbGwoKTsgfQogIH0KfQoKKGFzeW5jIGZ1bmN0aW9u' +
  'IGJvb3QoKSB7CiAgdHJ5IHsgUy5tZSA9IGF3YWl0IGFwaSgnL21lJyk7IH0gY2F0Y2ggKGUpIHsgUy5tZSA9IG51bGw7IH0KICBy' +
  'ZW5kZXIoKTsKfSkoKTsKfSkoKTsKCjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K'
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
const BUILD = '2026-08-31.20';           // shown in Setup so uploads can be confirmed
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
