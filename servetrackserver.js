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
  'Ljk3KX0KLnBob3RvLWhpZGRlbntmb250LXN0eWxlOml0YWxpYztvcGFjaXR5Oi43NX0KCjwvc3R5bGU+CjxsaW5rIHJlbD0iaWNv' +
  'biIgaHJlZj0iZGF0YTppbWFnZS9zdmcreG1sLDxzdmcgeG1sbnM9J2h0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnJyB2aWV3Qm94' +
  'PScwIDAgMzIgMzInPjxyZWN0IHdpZHRoPSczMicgaGVpZ2h0PSczMicgcng9JzcnIGZpbGw9JyUyMzFlM2E1ZicvPjx0ZXh0IHg9' +
  'JzE2JyB5PScyMycgZm9udC1zaXplPScxOScgZm9udC1mYW1pbHk9J3N5c3RlbS11aScgZm9udC13ZWlnaHQ9JzcwMCcgZmlsbD0n' +
  'd2hpdGUnIHRleHQtYW5jaG9yPSdtaWRkbGUnPlM8L3RleHQ+PC9zdmc+Ij4KPC9oZWFkPgo8Ym9keT4KPGRpdiBpZD0iYXBwIj48' +
  'L2Rpdj4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldC9ucG0vQHp4aW5nL2xpYnJhcnlAMC4yMS4zL3VtZC9p' +
  'bmRleC5taW4uanMiPjwvc2NyaXB0Pgo8c2NyaXB0PgovKiBTZXJ2ZVRyYWNrIOKAlCBmaWVsZC1maXJzdCBwcm9jZXNzIHNlcnZp' +
  'bmcgbWFuYWdlciAqLwooZnVuY3Rpb24gKCkgewondXNlIHN0cmljdCc7CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gaGVscGVycyAtLSAqLwpjb25zdCAkID0gc2VsID0+IGRvY3VtZW50LnF1' +
  'ZXJ5U2VsZWN0b3Ioc2VsKTsKY29uc3QgYXBwID0gJCgnI2FwcCcpOwpjb25zdCBTID0geyBtZTogbnVsbCwgdmlldzogJ2Rhc2gn' +
  'LCBwYXJhbXM6IHt9LCBjYWNoZToge30gfTsKCmNvbnN0IGVzYyA9IHMgPT4gU3RyaW5nKHMgPT0gbnVsbCA/ICcnIDogcykKICAu' +
  'cmVwbGFjZSgvJi9nLCAnJmFtcDsnKS5yZXBsYWNlKC88L2csICcmbHQ7JykucmVwbGFjZSgvPi9nLCAnJmd0OycpCiAgLnJlcGxh' +
  'Y2UoLyIvZywgJyZxdW90OycpLnJlcGxhY2UoLycvZywgJyYjMzk7Jyk7Cgpjb25zdCBtb25leSA9IHYgPT4gJyQnICsgTnVtYmVy' +
  'KHYgfHwgMCkudG9GaXhlZCgyKTsKY29uc3QgY2xzID0gcyA9PiBTdHJpbmcocyB8fCAnJykucmVwbGFjZSgvW15BLVphLXpdL2cs' +
  'ICcnKTsKCmZ1bmN0aW9uIGZtdERhdGUodiwgb3B0cykgewogIGlmICghdikgcmV0dXJuICcnOwogIGNvbnN0IGQgPSBuZXcgRGF0' +
  'ZSh2KTsKICByZXR1cm4gZC50b0xvY2FsZURhdGVTdHJpbmcoJ2VuLVVTJywgb3B0cyB8fCB7IG1vbnRoOiAnc2hvcnQnLCBkYXk6' +
  'ICdudW1lcmljJywgeWVhcjogJ251bWVyaWMnIH0pOwp9CmZ1bmN0aW9uIGZtdERhdGVPbmx5KHYpIHsgLy8gZGF0ZSBjb2x1bW5z' +
  'IGNvbWUgYmFjayBhcyBZWVlZLU1NLUREIG9yIElTTyBtaWRuaWdodCBVVEMKICBpZiAoIXYpIHJldHVybiAnJzsKICBjb25zdCBz' +
  'ID0gU3RyaW5nKHYpLnNsaWNlKDAsIDEwKS5zcGxpdCgnLScpOwogIHJldHVybiBgJHsrc1sxXX0vJHsrc1syXX0vJHtzWzBdLnNs' +
  'aWNlKDIpfWA7Cn0KZnVuY3Rpb24gZm10RFQodikgewogIGlmICghdikgcmV0dXJuICcnOwogIHJldHVybiBuZXcgRGF0ZSh2KS50' +
  'b0xvY2FsZVN0cmluZygnZW4tVVMnLAogICAgeyBtb250aDogJ3Nob3J0JywgZGF5OiAnbnVtZXJpYycsIGhvdXI6ICdudW1lcmlj' +
  'JywgbWludXRlOiAnMi1kaWdpdCcgfSk7Cn0KZnVuY3Rpb24gZGF5c091dCh2KSB7CiAgaWYgKCF2KSByZXR1cm4gbnVsbDsKICBj' +
  'b25zdCBkdWUgPSBuZXcgRGF0ZShTdHJpbmcodikuc2xpY2UoMCwgMTApICsgJ1QxMjowMDowMCcpOwogIHJldHVybiBNYXRoLnJv' +
  'dW5kKChkdWUgLSBuZXcgRGF0ZSgpKSAvIDg2NGU1KTsKfQpjb25zdCB0b2RheUlTTyA9ICgpID0+IG5ldyBEYXRlKCkudG9JU09T' +
  'dHJpbmcoKS5zbGljZSgwLCAxMCk7Cgphc3luYyBmdW5jdGlvbiBhcGkocGF0aCwgb3B0cykgewogIGNvbnN0IHJlcyA9IGF3YWl0' +
  'IGZldGNoKCcvYXBpJyArIHBhdGgsIE9iamVjdC5hc3NpZ24oewogICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxp' +
  'Y2F0aW9uL2pzb24nIH0sIGNyZWRlbnRpYWxzOiAnc2FtZS1vcmlnaW4nCiAgfSwgb3B0cyB8fCB7fSkpOwogIGNvbnN0IGRhdGEg' +
  'PSBhd2FpdCByZXMuanNvbigpLmNhdGNoKCgpID0+ICh7fSkpOwogIC8vIEEgNDAxIGZyb20gL2xvZ2luIG1lYW5zIHRoZSBjcmVk' +
  'ZW50aWFscyB3ZXJlIHdyb25nLCBub3QgdGhhdCBhIHNlc3Npb24KICAvLyBsYXBzZWQuIFRyZWF0aW5nIHRoZSB0d28gdGhlIHNh' +
  'bWUgc2hvd2VkICJTaWduZWQgb3V0IiB0byBzb21lb25lIHdobyBoYWQKICAvLyBzaW1wbHkgbWlzdHlwZWQgYSBwYXNzd29yZCwg' +
  'd2hpY2ggaXMgYWN0aXZlbHkgbWlzbGVhZGluZy4KICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxICYmIHBhdGggIT09ICcvbG9naW4n' +
  'KSB7CiAgICBTLm1lID0gbnVsbDsKICAgIHJlbmRlcigpOwogICAgdGhyb3cgbmV3IEVycm9yKGRhdGEuZXJyb3IgfHwgJ1NpZ25l' +
  'ZCBvdXQnKTsKICB9CiAgaWYgKCFyZXMub2spIHRocm93IG5ldyBFcnJvcihkYXRhLmVycm9yIHx8ICdSZXF1ZXN0IGZhaWxlZCcp' +
  'OwogIHJldHVybiBkYXRhOwp9CgpmdW5jdGlvbiB0b2FzdChtc2csIGJhZCkgewogIGNvbnN0IHQgPSBkb2N1bWVudC5jcmVhdGVF' +
  'bGVtZW50KCdkaXYnKTsKICB0LmNsYXNzTmFtZSA9ICd0b2FzdCcgKyAoYmFkID8gJyBiYWQnIDogJycpOwogIHQudGV4dENvbnRl' +
  'bnQgPSBtc2c7CiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZCh0KTsKICBzZXRUaW1lb3V0KCgpID0+IHQucmVtb3ZlKCksIDMy' +
  'MDApOwp9CgpmdW5jdGlvbiBnbyh2aWV3LCBwYXJhbXMpIHsgUy52aWV3ID0gdmlldzsgUy5wYXJhbXMgPSBwYXJhbXMgfHwge307' +
  'IHdpbmRvdy5zY3JvbGxUbygwLCAwKTsgcmVuZGVyKCk7IH0KCi8qIG1vZGFsIHNoZWV0ICovCmxldCBzaGVldEVsID0gbnVsbDsK' +
  'ZnVuY3Rpb24gc2hlZXQodGl0bGUsIGJvZHlIdG1sLCBvbk1vdW50KSB7CiAgY2xvc2VTaGVldCgpOwogIHNoZWV0RWwgPSBkb2N1' +
  'bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICBzaGVldEVsLmNsYXNzTmFtZSA9ICdzaGVldCc7CiAgc2hlZXRFbC5pbm5lckhU' +
  'TUwgPSBgPGRpdiBjbGFzcz0iaW5uZXIiPjxoMj4ke2VzYyh0aXRsZSl9PC9oMj4ke2JvZHlIdG1sfTwvZGl2PmA7CiAgc2hlZXRF' +
  'bC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGUgPT4geyBpZiAoZS50YXJnZXQgPT09IHNoZWV0RWwpIGNsb3NlU2hlZXQoKTsg' +
  'fSk7CiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChzaGVldEVsKTsKICBpZiAob25Nb3VudCkgb25Nb3VudChzaGVldEVsKTsK' +
  'fQpmdW5jdGlvbiBjbG9zZVNoZWV0KCkgewogIGlmIChzaGVldEVsKSB7IHNoZWV0RWwucmVtb3ZlKCk7IHNoZWV0RWwgPSBudWxs' +
  'OyB9CiAgaWYgKHdpbmRvdy5fX3N0b3BTY2FuKSB7IHdpbmRvdy5fX3N0b3BTY2FuKCk7IHdpbmRvdy5fX3N0b3BTY2FuID0gbnVs' +
  'bDsgfQp9CndpbmRvdy5jbG9zZVNoZWV0ID0gY2xvc2VTaGVldDsKCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gbWFwcyBsaW5raW5nIC0tICovCmNvbnN0IGlzSU9TID0gKCkgPT4gL2lQYWR8aVBob25l' +
  'fGlQb2QvLnRlc3QobmF2aWdhdG9yLnVzZXJBZ2VudCkgfHwKICAobmF2aWdhdG9yLnBsYXRmb3JtID09PSAnTWFjSW50ZWwnICYm' +
  'IG5hdmlnYXRvci5tYXhUb3VjaFBvaW50cyA+IDEpOwoKZnVuY3Rpb24gYWRkck9mKGopIHsKICByZXR1cm4gW2ouYWRkcmVzczEs' +
  'IGouYWRkcmVzczIsIGouY2l0eSwgai5zdGF0ZSwgai56aXBdLmZpbHRlcihCb29sZWFuKS5qb2luKCcsICcpOwp9CmZ1bmN0aW9u' +
  'IGFwcGxlVXJsKGEpIHsgcmV0dXJuICdodHRwczovL21hcHMuYXBwbGUuY29tLz9kYWRkcj0nICsgZW5jb2RlVVJJQ29tcG9uZW50' +
  'KGEpICsgJyZkaXJmbGc9ZCc7IH0KZnVuY3Rpb24gZ29vZ2xlVXJsKGEpIHsKICByZXR1cm4gJ2h0dHBzOi8vd3d3Lmdvb2dsZS5j' +
  'b20vbWFwcy9kaXIvP2FwaT0xJmRlc3RpbmF0aW9uPScgKyBlbmNvZGVVUklDb21wb25lbnQoYSkgKyAnJnRyYXZlbG1vZGU9ZHJp' +
  'dmluZyc7Cn0KZnVuY3Rpb24gbmF2VXJsKGEpIHsgcmV0dXJuIGlzSU9TKCkgPyBhcHBsZVVybChhKSA6IGdvb2dsZVVybChhKTsg' +
  'fQpmdW5jdGlvbiByb3V0ZVVybChsaXN0KSB7CiAgY29uc3Qgc3RvcHMgPSBsaXN0Lm1hcChhZGRyT2YpLmZpbHRlcihCb29sZWFu' +
  'KTsKICBpZiAoIXN0b3BzLmxlbmd0aCkgcmV0dXJuIG51bGw7CiAgY29uc3QgZGVzdCA9IHN0b3BzW3N0b3BzLmxlbmd0aCAtIDFd' +
  'OwogIGNvbnN0IHdheSA9IHN0b3BzLnNsaWNlKDAsIC0xKS5zbGljZSgwLCA5KS5tYXAoZW5jb2RlVVJJQ29tcG9uZW50KS5qb2lu' +
  'KCd8Jyk7CiAgcmV0dXJuICdodHRwczovL3d3dy5nb29nbGUuY29tL21hcHMvZGlyLz9hcGk9MSZvcmlnaW49Q3VycmVudCtMb2Nh' +
  'dGlvbiZkZXN0aW5hdGlvbj0nICsKICAgIGVuY29kZVVSSUNvbXBvbmVudChkZXN0KSArICh3YXkgPyAnJndheXBvaW50cz0nICsg' +
  'd2F5IDogJycpICsgJyZ0cmF2ZWxtb2RlPWRyaXZpbmcnOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGxheW91dCAtLSAqLwpjb25zdCBpc0FkbWluID0gKCkgPT4gUy5tZSAmJiAoUy5t' +
  'ZS5yb2xlID09PSAnYWRtaW4nIHx8IFMubWUucm9sZSA9PT0gJ293bmVyJyk7CmNvbnN0IGlzT3duZXIgPSAoKSA9PiBTLm1lICYm' +
  'IFMubWUucm9sZSA9PT0gJ293bmVyJzsKY29uc3Qgcm9sZUxhYmVsID0gKCkgPT4gUy5tZS5yb2xlID09PSAnb3duZXInID8gJ093' +
  'bmVyJwogIDogKFMubWUucm9sZSA9PT0gJ2FkbWluJyA/ICdBZG1pbicgOiAnRmllbGQgc2VydmVyJyk7Cgpjb25zdCBUQUJTID0g' +
  'KCkgPT4gaXNBZG1pbigpCiAgPyBbWydkYXNoJywgJ1RvZGF5JywgJ+KXjiddLCBbJ2pvYnMnLCAnSm9icycsICfilqQnXSwgWydz' +
  'Y2FuJywgJ1NjYW4nLCAn4palJ10sCiAgICAgWyd0b29scycsICdUb29scycsICfinIInXSwgWydwcm9wZXJ0eScsICdQcm9wJywg' +
  'J+KMgiddLCBbJ21vbmV5JywgJ0JpbGwnLCAnJCddLCBbJ2FkbWluJywgJ1NldHVwJywgJ+KamSddXQogIDogW1snZGFzaCcsICdN' +
  'eSBEYXknLCAn4peOJ10sIFsnam9icycsICdKb2JzJywgJ+KWpCddLCBbJ3NjYW4nLCAnU2NhbicsICfilqUnXSwKICAgICBbJ3Rv' +
  'b2xzJywgJ1Rvb2xzJywgJ+KcgiddLCBbJ3Byb3BlcnR5JywgJ1Byb3AnLCAn4oyCJ10sIFsnbW9uZXknLCAnUGF5JywgJyQnXV07' +
  'CgpmdW5jdGlvbiBzaGVsbChpbm5lcikgewogIGNvbnN0IHRhYnMgPSBUQUJTKCkubWFwKChbdiwgbGFiZWwsIGljXSkgPT4KICAg' +
  'IGA8YnV0dG9uIGRhdGEtdGFiPSIke3Z9IiBjbGFzcz0iJHtTLnZpZXcgPT09IHYgfHwgKHYgPT09ICdqb2JzJyAmJiBTLnZpZXcg' +
  'PT09ICdqb2InKSA/ICdvbicgOiAnJ30iPgogICAgICA8c3BhbiBjbGFzcz0iaWMiPiR7aWN9PC9zcGFuPiR7ZXNjKGxhYmVsKX08' +
  'L2J1dHRvbj5gKS5qb2luKCcnKTsKICBjb25zdCBzdXBwb3J0QmFyID0gUy5tZS5zdXBwb3J0CiAgICA/IGA8ZGl2IHN0eWxlPSJi' +
  'YWNrZ3JvdW5kOiNDMjQxMEM7Y29sb3I6I2ZmZjt0ZXh0LWFsaWduOmNlbnRlcjtmb250LXNpemU6MTIuNXB4OwogICAgICAgIHBh' +
  'ZGRpbmc6NnB4IDEwcHg7Zm9udC13ZWlnaHQ6NjAwIj5TdXBwb3J0IHZpZXcg4oCUIG5hbWVzICZhbXA7IGRvY3VtZW50cyBhcmUg' +
  'aGlkZGVuLgogICAgICAgIFRoaXMgaXMgJHtlc2MoUy5tZS5jb21wYW55ID8gUy5tZS5jb21wYW55Lm5hbWUgOiAnYSBjdXN0b21l' +
  'ciBjb21wYW55Jyl9LCBub3QgeW91cnMuPC9kaXY+YAogICAgOiAnJzsKICByZXR1cm4gYCR7c3VwcG9ydEJhcn0KICAgIDxkaXYg' +
  'Y2xhc3M9InRvcGJhciI+CiAgICAgIDxkaXYgY2xhc3M9ImJyYW5kIj5TZXJ2ZVRyYWNrPHNtYWxsPiR7ZXNjKFMubWUuY29tcGFu' +
  'eSA/IFMubWUuY29tcGFueS5uYW1lIDogJycpfSR7CiAgICAgICAgUy5tZS5jb21wYW55ID8gJyDCtyAnIDogJyd9JHtlc2MoUy5t' +
  'ZS5uYW1lKX0gwrcgJHtyb2xlTGFiZWwoKX08L3NtYWxsPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzcGFjZXIiPjwvZGl2Pgog' +
  'ICAgICAke2lzT3duZXIoKSAmJiAoUy5tZS5jb21wYW5pZXMgfHwgW10pLmxlbmd0aCA+IDEKICAgICAgICA/IGA8c2VsZWN0IGlk' +
  'PSJjb1N3aXRjaCIgdGl0bGU9IldoaWNoIGNvbXBhbnkgeW91IGFyZSB3b3JraW5nIGluIj4kewogICAgICAgICAgICAoUy5tZS5j' +
  'b21wYW5pZXMgfHwgW10pLm1hcChjID0+IGA8b3B0aW9uIHZhbHVlPSIke2MuaWR9IiR7CiAgICAgICAgICAgICAgUy5tZS5jb21w' +
  'YW55ICYmIGMuaWQgPT09IFMubWUuY29tcGFueS5pZCA/ICcgc2VsZWN0ZWQnIDogJyd9PiR7ZXNjKGMubmFtZSl9PC9vcHRpb24+' +
  'YCkuam9pbignJykKICAgICAgICAgIH08L3NlbGVjdD5gIDogJyd9CiAgICAgIDxidXR0b24gaWQ9ImxvZ291dCI+U2lnbiBvdXQ8' +
  'L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0id3JhcCI+JHtpbm5lcn08L2Rpdj4KICAgIDxkaXYgY2xhc3M9InRh' +
  'YnMiPiR7dGFic308L2Rpdj5gOwp9CgpmdW5jdGlvbiBiaW5kU2hlbGwoKSB7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgn' +
  'W2RhdGEtdGFiXScpLmZvckVhY2goYiA9PgogICAgYi5vbmNsaWNrID0gKCkgPT4gZ28oYi5kYXRhc2V0LnRhYikpOwogIGNvbnN0' +
  'IGxvID0gJCgnI2xvZ291dCcpOwogIGlmIChsbykgbG8ub25jbGljayA9IGFzeW5jICgpID0+IHsgYXdhaXQgYXBpKCcvbG9nb3V0' +
  'JywgeyBtZXRob2Q6ICdQT1NUJyB9KTsgUy5tZSA9IG51bGw7IHJlbmRlcigpOyB9OwogIGNvbnN0IHN3ID0gJCgnI2NvU3dpdGNo' +
  'Jyk7CiAgaWYgKHN3KSBzdy5vbmNoYW5nZSA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IG91dCA9IGF3YWl0' +
  'IGFwaSgnL2NvbXBhbmllcy8nICsgc3cudmFsdWUgKyAnL2VudGVyJywgeyBtZXRob2Q6ICdQT1NUJyB9KTsKICAgICAgUy5tZSA9' +
  'IGF3YWl0IGFwaSgnL21lJyk7CiAgICAgIHRvYXN0KCdOb3cgaW4gJyArIG91dC5jb21wYW55Lm5hbWUpOwogICAgICByZW5kZXIo' +
  'KTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGxvZ2luIC0tICovCmZ1bmN0aW9uIGxvZ2luVmll' +
  'dygpIHsKICBhcHAuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImxvZ2luIj4KICAgIDxkaXYgY2xhc3M9ImxvZ28iPjxiPlNlcnZl' +
  'VHJhY2s8L2I+PGRpdj5Qcm9jZXNzIHNlcnZpbmcgbWFuYWdlbWVudDwvZGl2PjwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2FyZCI+' +
  'CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RW1haWw8L2xhYmVsPjxpbnB1dCBpZD0iZW1haWwiIHR5cGU9ImVtYWls' +
  'IiBhdXRvY29tcGxldGU9InVzZXJuYW1lIiBpbnB1dG1vZGU9ImVtYWlsIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQi' +
  'PjxsYWJlbD5QYXNzd29yZDwvbGFiZWw+PGlucHV0IGlkPSJwdyIgdHlwZT0icGFzc3dvcmQiIGF1dG9jb21wbGV0ZT0iY3VycmVu' +
  'dC1wYXNzd29yZCI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBibG9jayIgaWQ9InNpZ25pbiI+U2lnbiBpbjwvYnV0' +
  'dG9uPgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBpZD0iZXJyIiBzdHlsZT0iY29sb3I6dmFyKC0tYmFkKTttYXJnaW4tdG9wOjEw' +
  'cHgiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXI7bWFyZ2luLXRvcDoxNHB4' +
  'Ij4KICAgICAgICBCZWVuIGdpdmVuIGFuIGFjY2VzcyBjb2RlPyA8YSBocmVmPSIjIiBpZD0iaGF2ZUNvZGUiPlNldCB1cCB5b3Vy' +
  'IGFjY291bnQ8L2E+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlcjttYXJnaW4t' +
  'dG9wOjEwcHgiPgogICAgICAgIDxhIGhyZWY9Ii9wcml2YWN5IiB0YXJnZXQ9Il9ibGFuayI+UHJpdmFjeSBzdGF0ZW1lbnQ8L2E+' +
  'PC9kaXY+CiAgICA8L2Rpdj48L2Rpdj5gOwogIGNvbnN0IHN1Ym1pdCA9IGFzeW5jICgpID0+IHsKICAgICQoJyNlcnInKS50ZXh0' +
  'Q29udGVudCA9ICcnOwogICAgdHJ5IHsKICAgICAgYXdhaXQgYXBpKCcvbG9naW4nLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBK' +
  'U09OLnN0cmluZ2lmeSh7IGVtYWlsOiAkKCcjZW1haWwnKS52YWx1ZSwgcGFzc3dvcmQ6ICQoJyNwdycpLnZhbHVlIH0pIH0pOwog' +
  'ICAgICBTLm1lID0gYXdhaXQgYXBpKCcvbWUnKTsKICAgICAgZ28oJ2Rhc2gnKTsKICAgIH0gY2F0Y2ggKGUpIHsgJCgnI2Vycicp' +
  'LnRleHRDb250ZW50ID0gZS5tZXNzYWdlOyB9CiAgfTsKICAkKCcjc2lnbmluJykub25jbGljayA9IHN1Ym1pdDsKICAkKCcjcHcn' +
  'KS5vbmtleWRvd24gPSBlID0+IHsgaWYgKGUua2V5ID09PSAnRW50ZXInKSBzdWJtaXQoKTsgfTsKICAkKCcjaGF2ZUNvZGUnKS5v' +
  'bmNsaWNrID0gZSA9PiB7IGUucHJldmVudERlZmF1bHQoKTsgcmVkZWVtVmlldygpOyB9OwogICQoJyNlbWFpbCcpLmZvY3VzKCk7' +
  'Cn0KCgovKiBSZWRlZW1pbmcgYSBjb2RlIGNyZWF0ZXMgdGhlIGFjY291bnQsIHNvIHNvbWVvbmUgY2FuIGJlIHNldCB1cCB3aXRo' +
  'b3V0IGFuCiAgIGFkbWluIGtleWluZyBpbiB0aGVpciBkZXRhaWxzLiAqLwpmdW5jdGlvbiByZWRlZW1WaWV3KCkgewogIGFwcC5p' +
  'bm5lckhUTUwgPSBgPGRpdiBjbGFzcz0ibG9naW4iPgogICAgPGRpdiBjbGFzcz0ibG9nbyI+PGI+U2VydmVUcmFjazwvYj48ZGl2' +
  'PlNldCB1cCB5b3VyIGFjY291bnQ8L2Rpdj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJm' +
  'aWVsZCI+PGxhYmVsPkFjY2VzcyBjb2RlPC9sYWJlbD4KICAgICAgICA8aW5wdXQgaWQ9InJfY29kZSIgcGxhY2Vob2xkZXI9IkFC' +
  'Q0QtRUZHSC1KS0xNIiBhdXRvY2FwaXRhbGl6ZT0iY2hhcmFjdGVycyIgc3R5bGU9InRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZSI+' +
  'PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+WW91ciBuYW1lPC9sYWJlbD48aW5wdXQgaWQ9InJfbmFtZSIg' +
  'YXV0b2NvbXBsZXRlPSJuYW1lIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5FbWFpbDwvbGFiZWw+PGlu' +
  'cHV0IGlkPSJyX2VtYWlsIiB0eXBlPSJlbWFpbCIgaW5wdXRtb2RlPSJlbWFpbCIgYXV0b2NvbXBsZXRlPSJlbWFpbCI+PC9kaXY+' +
  'CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q2hvb3NlIGEgcGFzc3dvcmQ8L2xhYmVsPgogICAgICAgIDxpbnB1dCBp' +
  'ZD0icl9wdyIgdHlwZT0icGFzc3dvcmQiIGF1dG9jb21wbGV0ZT0ibmV3LXBhc3N3b3JkIiBwbGFjZWhvbGRlcj0iQXQgbGVhc3Qg' +
  'OCBjaGFyYWN0ZXJzIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Zb3VyIGNvbXBhbnkgPHNwYW4gY2xh' +
  'c3M9ImhpbnQiPuKAlCBvbmx5IGlmIHlvdSBhcmUgc3RhcnRpbmcgYSBuZXcgb25lPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgPGlu' +
  'cHV0IGlkPSJyX2NvIiBwbGFjZWhvbGRlcj0iZS5nLiBSaW8gR3JhbmRlIFByb2Nlc3MgU2VydmluZyI+PC9kaXY+CiAgICAgIDxi' +
  'dXR0b24gY2xhc3M9ImJ0biBibG9jayIgaWQ9InJfZ28iPkNyZWF0ZSBteSBhY2NvdW50PC9idXR0b24+CiAgICAgIDxkaXYgY2xh' +
  'c3M9ImhpbnQiIGlkPSJyX2VyciIgc3R5bGU9ImNvbG9yOnZhcigtLWJhZCk7bWFyZ2luLXRvcDoxMHB4Ij48L2Rpdj4KICAgICAg' +
  'PGRpdiBjbGFzcz0iaGludCIgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyO21hcmdpbi10b3A6MTRweCI+CiAgICAgICAgPGEgaHJl' +
  'Zj0iIyIgaWQ9InJfYmFjayI+QmFjayB0byBzaWduIGluPC9hPjwvZGl2PgogICAgPC9kaXY+PC9kaXY+YDsKCiAgJCgnI3JfYmFj' +
  'aycpLm9uY2xpY2sgPSBlID0+IHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBsb2dpblZpZXcoKTsgfTsKICBjb25zdCBnbyA9IGFzeW5j' +
  'ICgpID0+IHsKICAgICQoJyNyX2VycicpLnRleHRDb250ZW50ID0gJyc7CiAgICB0cnkgewogICAgICBjb25zdCBtYWRlID0gYXdh' +
  'aXQgYXBpKCcvcmVkZWVtJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoewogICAgICAgIGNvZGU6ICQo' +
  'JyNyX2NvZGUnKS52YWx1ZSwgbmFtZTogJCgnI3JfbmFtZScpLnZhbHVlLCBjb21wYW55OiAkKCcjcl9jbycpLnZhbHVlLAogICAg' +
  'ICAgIGVtYWlsOiAkKCcjcl9lbWFpbCcpLnZhbHVlLCBwYXNzd29yZDogJCgnI3JfcHcnKS52YWx1ZQogICAgICB9KSB9KTsKICAg' +
  'ICAgUy5tZSA9IGF3YWl0IGFwaSgnL21lJyk7CiAgICAgIHRvYXN0KCdXZWxjb21lLCAnICsgbWFkZS5uYW1lKTsKICAgICAgZ28y' +
  'KCk7CiAgICB9IGNhdGNoIChlKSB7ICQoJyNyX2VycicpLnRleHRDb250ZW50ID0gZS5tZXNzYWdlOyB9CiAgfTsKICBjb25zdCBn' +
  'bzIgPSAoKSA9PiB7IFMudmlldyA9ICdkYXNoJzsgUy5wYXJhbXMgPSB7fTsgcmVuZGVyKCk7IH07CiAgJCgnI3JfZ28nKS5vbmNs' +
  'aWNrID0gZ287CiAgJCgnI3JfcHcnKS5vbmtleWRvd24gPSBlID0+IHsgaWYgKGUua2V5ID09PSAnRW50ZXInKSBnbygpOyB9Owog' +
  'ICQoJyNyX2NvZGUnKS5mb2N1cygpOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tIGRhc2hib2FyZCAtLSAqLwphc3luYyBmdW5jdGlvbiBkYXNoVmlldygpIHsKICBjb25zdCBbc3RhdHMsIGpv' +
  'YnNdID0gYXdhaXQgUHJvbWlzZS5hbGwoW2FwaSgnL3N0YXRzJyksIGFwaSgnL2pvYnM/b3Blbj0xJyldKTsKICBjb25zdCBvdmVy' +
  'ZHVlID0gam9icy5maWx0ZXIoaiA9PiB7IGNvbnN0IGQgPSBkYXlzT3V0KGouZHVlX2RhdGUpOyByZXR1cm4gZCAhPT0gbnVsbCAm' +
  'JiBkIDwgMDsgfSk7CiAgY29uc3QgdG9kYXkgPSBqb2JzLmZpbHRlcihqID0+IHsgY29uc3QgZCA9IGRheXNPdXQoai5kdWVfZGF0' +
  'ZSk7IHJldHVybiBkICE9PSBudWxsICYmIGQgPj0gMCAmJiBkIDw9IDE7IH0pOwogIGNvbnN0IHJ1c2ggPSBqb2JzLmZpbHRlcihq' +
  'ID0+IGoucHJpb3JpdHkgIT09ICdSb3V0aW5lJyk7CiAgY29uc3QgbWluZSA9IGlzQWRtaW4oKSA/IGpvYnMgOiBqb2JzOwoKICBh' +
  'cHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj4ke2lzQWRtaW4oKSA/ICdPcGVyYXRpb25zIHRvZGF5' +
  'JyA6ICdNeSBkYXknfTwvaDE+CiAgICA8ZGl2IGNsYXNzPSJzdGF0cyI+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxkaXYgY2xh' +
  'c3M9Im4iPiR7c3RhdHMub3Blbl9qb2JzfTwvZGl2PjxkaXYgY2xhc3M9ImwiPk9wZW4gam9iczwvZGl2PjwvZGl2PgogICAgICA8' +
  'ZGl2IGNsYXNzPSJzdGF0ICR7c3RhdHMub3ZlcmR1ZSA/ICdhbGVydCcgOiAnJ30iPjxkaXYgY2xhc3M9Im4iPiR7c3RhdHMub3Zl' +
  'cmR1ZX08L2Rpdj48ZGl2IGNsYXNzPSJsIj5QYXN0IGR1ZTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdGF0Ij48ZGl2' +
  'IGNsYXNzPSJuIj4ke3N0YXRzLnJ1c2h9PC9kaXY+PGRpdiBjbGFzcz0ibCI+UnVzaCAvIHNhbWUgZGF5PC9kaXY+PC9kaXY+CiAg' +
  'ICAgIDxkaXYgY2xhc3M9InN0YXQgZ29vZCI+PGRpdiBjbGFzcz0ibiI+JHtzdGF0cy5zZXJ2ZWRfN2R9PC9kaXY+PGRpdiBjbGFz' +
  'cz0ibCI+U2VydmVkLCA3IGRheXM8L2Rpdj48L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8' +
  'aDI+Um91dGUgbXkgZGF5IDxzcGFuIGNsYXNzPSJzdWIiPuKAlCAke21pbmUubGVuZ3RofSBvcGVuIHN0b3Ake21pbmUubGVuZ3Ro' +
  'ID09PSAxID8gJycgOiAncyd9PC9zcGFuPjwvaDI+CiAgICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDotNHB4' +
  'Ij5PcGVucyBHb29nbGUgTWFwcyB3aXRoIHlvdXIgc3RvcHMgaW4gb3JkZXIgKHVwIHRvIDEwKS4gTm8gbWFwcGluZyBmZWVzIOKA' +
  'lCBpdCBqdXN0IGhhbmRzIG9mZiB0byB0aGUgYXBwIHlvdSBhbHJlYWR5IGhhdmUuPC9wPgogICAgICA8ZGl2IGNsYXNzPSJyb3ci' +
  'IHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBuYXYiIGlkPSJyb3V0ZUJ0biIgJHtt' +
  'aW5lLmxlbmd0aCA/ICcnIDogJ2Rpc2FibGVkJ30+U3RhcnQgcm91dGUgKCR7TWF0aC5taW4obWluZS5sZW5ndGgsIDEwKX0gc3Rv' +
  'cHMpPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9InJvdXRlTGlzdCI+U2VlIG9yZGVyPC9i' +
  'dXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgJHtzZWN0aW9uKCdQYXN0IGR1ZScsIG92ZXJkdWUpfQogICAgJHtz' +
  'ZWN0aW9uKCdEdWUgdG9kYXkgb3IgdG9tb3Jyb3cnLCB0b2RheSl9CiAgICAke3NlY3Rpb24oJ1J1c2ggJmFtcDsgc2FtZSBkYXkn' +
  'LCBydXNoLmZpbHRlcihqID0+ICFvdmVyZHVlLmluY2x1ZGVzKGopICYmICF0b2RheS5pbmNsdWRlcyhqKSkpfQogICAgJHtvdmVy' +
  'ZHVlLmxlbmd0aCArIHRvZGF5Lmxlbmd0aCArIHJ1c2gubGVuZ3RoID09PSAwCiAgICAgID8gYDxkaXYgY2xhc3M9ImNhcmQiPjxk' +
  'aXYgY2xhc3M9ImVtcHR5Ij5Ob3RoaW5nIHVyZ2VudC4gJHttaW5lLmxlbmd0aH0gb3BlbiBqb2Ike21pbmUubGVuZ3RoID09PSAx' +
  'ID8gJycgOiAncyd9IHRvdGFsIOKAlCBzZWUgdGhlIEpvYnMgdGFiLjwvZGl2PjwvZGl2PmAgOiAnJ30KICBgKTsKICBiaW5kU2hl' +
  'bGwoKTsKICBiaW5kSm9iSXRlbXMoKTsKICBjb25zdCByYiA9ICQoJyNyb3V0ZUJ0bicpOwogIGlmIChyYikgcmIub25jbGljayA9' +
  'ICgpID0+IHsKICAgIGNvbnN0IHVybCA9IHJvdXRlVXJsKG1pbmUuc2xpY2UoMCwgMTApKTsKICAgIGlmICh1cmwpIHdpbmRvdy5v' +
  'cGVuKHVybCwgJ19ibGFuaycpOwogIH07CiAgJCgnI3JvdXRlTGlzdCcpLm9uY2xpY2sgPSAoKSA9PiBzaGVldCgnUm91dGUgb3Jk' +
  'ZXInLCBgCiAgICA8cCBjbGFzcz0iaGludCI+T3JkZXJlZCBieSBwcmlvcml0eSwgdGhlbiBkdWUgZGF0ZS4gVGFwIGFueSBzdG9w' +
  'IHRvIG5hdmlnYXRlIHRvIGl0IGFsb25lLjwvcD4KICAgIDxkaXYgY2xhc3M9Imxpc3QiPiR7bWluZS5zbGljZSgwLCAxMCkubWFw' +
  'KChqLCBpKSA9PiBgCiAgICAgIDxkaXYgY2xhc3M9Iml0ZW0iIGRhdGEtbmF2PSIke2VzYyhhZGRyT2YoaikpfSI+CiAgICAgICAg' +
  'PGRpdiBjbGFzcz0iciI+PGRpdj48ZGl2IGNsYXNzPSJ0Ij4ke2kgKyAxfS4gJHtlc2Moai5yZWNpcGllbnRfbmFtZSl9PC9kaXY+' +
  'CiAgICAgICAgPGRpdiBjbGFzcz0ibSI+JHtlc2MoYWRkck9mKGopKX08L2Rpdj48L2Rpdj4KICAgICAgICA8c3BhbiBjbGFzcz0i' +
  'cGlsbCAke2NscyhqLnByaW9yaXR5KX0iPiR7ZXNjKGoucHJpb3JpdHkpfTwvc3Bhbj48L2Rpdj48L2Rpdj5gKS5qb2luKCcnKX08' +
  'L2Rpdj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgYmxvY2siIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiIG9uY2xpY2s9ImNs' +
  'b3NlU2hlZXQoKSI+Q2xvc2U8L2J1dHRvbj5gLAogICAgZWwgPT4gZWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtbmF2XScpLmZv' +
  'ckVhY2gobiA9PgogICAgICBuLm9uY2xpY2sgPSAoKSA9PiB3aW5kb3cub3BlbihuYXZVcmwobi5kYXRhc2V0Lm5hdiksICdfYmxh' +
  'bmsnKSkpOwp9CgpmdW5jdGlvbiBzZWN0aW9uKHRpdGxlLCBsaXN0KSB7CiAgaWYgKCFsaXN0Lmxlbmd0aCkgcmV0dXJuICcnOwog' +
  'IHJldHVybiBgPGRpdiBjbGFzcz0iY2FyZCI+PGgyPiR7dGl0bGV9IDxzcGFuIGNsYXNzPSJzdWIiPiR7bGlzdC5sZW5ndGh9PC9z' +
  'cGFuPjwvaDI+CiAgICA8ZGl2IGNsYXNzPSJsaXN0Ij4ke2xpc3QubWFwKGpvYkl0ZW0pLmpvaW4oJycpfTwvZGl2PjwvZGl2PmA7' +
  'Cn0KCmZ1bmN0aW9uIGpvYkl0ZW0oaikgewogIGNvbnN0IGQgPSBkYXlzT3V0KGouZHVlX2RhdGUpOwogIGNvbnN0IGxhdGUgPSBk' +
  'ICE9PSBudWxsICYmIGQgPCAwICYmICFbJ1NlcnZlZCcsICdOb24tRXN0JywgJ0NhbmNlbGxlZCddLmluY2x1ZGVzKGouc3RhdHVz' +
  'KTsKICBjb25zdCBkdWUgPSBqLmR1ZV9kYXRlCiAgICA/IChsYXRlID8gYDxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQpO2Zv' +
  'bnQtd2VpZ2h0OjYwMCI+JHtNYXRoLmFicyhkKX1kIHBhc3QgZHVlPC9zcGFuPmAKICAgICAgICAgICAgOiAoZCA9PT0gMCA/ICdk' +
  'dWUgdG9kYXknIDogZCA9PT0gMSA/ICdkdWUgdG9tb3Jyb3cnIDogJ2R1ZSAnICsgZm10RGF0ZU9ubHkoai5kdWVfZGF0ZSkpKQog' +
  'ICAgOiAnbm8gZHVlIGRhdGUnOwogIHJldHVybiBgPGRpdiBjbGFzcz0iaXRlbSBwLSR7Y2xzKGoucHJpb3JpdHkpfSAke2xhdGUg' +
  'PyAnb3ZlcmR1ZScgOiAnJ30iIGRhdGEtam9iPSIke2ouaWR9Ij4KICAgIDxkaXYgY2xhc3M9InIiPgogICAgICA8ZGl2PgogICAg' +
  'ICAgIDxkaXYgY2xhc3M9InQiPiR7ZXNjKGoucmVjaXBpZW50X25hbWUpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im0iPiR7' +
  'ZXNjKGouam9iX251bWJlcil9IMK3ICR7ZXNjKGouY2l0eSB8fCAnJyl9JHtqLmNpdHkgPyAnLCAnIDogJyd9JHtlc2Moai5zdGF0' +
  'ZSB8fCAnJyl9IMK3ICR7ZHVlfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im0iPiR7ZXNjKGouY2xpZW50X25hbWUgfHwgJ05v' +
  'IGNsaWVudCcpfSR7ai5zZXJ2ZXJfbmFtZSA/ICcg4oaSICcgKyBlc2Moai5zZXJ2ZXJfbmFtZSkgOiAnJ30ke2ouYXR0ZW1wdF9j' +
  'b3VudCA/ICcgwrcgJyArIGouYXR0ZW1wdF9jb3VudCArICcgYXR0ZW1wdCcgKyAoai5hdHRlbXB0X2NvdW50ID09PSAxID8gJycg' +
  'OiAncycpIDogJyd9PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJ0ZXh0LWFsaWduOnJpZ2h0Ij4KICAgICAg' +
  'ICA8c3BhbiBjbGFzcz0icGlsbCAke2NscyhqLnN0YXR1cyl9Ij4ke2VzYyhqLnN0YXR1cyl9PC9zcGFuPgogICAgICAgICR7ai5w' +
  'cmlvcml0eSAhPT0gJ1JvdXRpbmUnID8gYDxkaXYgc3R5bGU9Im1hcmdpbi10b3A6NXB4Ij48c3BhbiBjbGFzcz0icGlsbCBydXNo' +
  'Ij4ke2VzYyhqLnByaW9yaXR5KX08L3NwYW4+PC9kaXY+YCA6ICcnfQogICAgICA8L2Rpdj4KICAgIDwvZGl2PjwvZGl2PmA7Cn0K' +
  'CmZ1bmN0aW9uIGJpbmRKb2JJdGVtcygpIHsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1qb2JdJykuZm9yRWFj' +
  'aChlbCA9PgogICAgZWwub25jbGljayA9ICgpID0+IGdvKCdqb2InLCB7IGlkOiBlbC5kYXRhc2V0LmpvYiB9KSk7Cn0KCi8qIC0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBqb2JzIC0tICovCmFz' +
  'eW5jIGZ1bmN0aW9uIGpvYnNWaWV3KCkgewogIGNvbnN0IGYgPSBTLnBhcmFtczsKICBjb25zdCBxcyA9IG5ldyBVUkxTZWFyY2hQ' +
  'YXJhbXMoKTsKICBpZiAoZi5zdGF0dXMpIHFzLnNldCgnc3RhdHVzJywgZi5zdGF0dXMpOwogIGlmIChmLnEpIHFzLnNldCgncScs' +
  'IGYucSk7CiAgaWYgKGYub3BlbikgcXMuc2V0KCdvcGVuJywgJzEnKTsKICBjb25zdCBqb2JzID0gYXdhaXQgYXBpKCcvam9icz8n' +
  'ICsgcXMudG9TdHJpbmcoKSk7CgogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8aDEgY2xhc3M9InBhZ2UiPiR7aXNBZG1p' +
  'bigpID8gJ0pvYnMnIDogJ015IGpvYnMnfTwvaDE+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGRpdiBjbGFzcz0icm93' +
  'Ij4KICAgICAgICA8aW5wdXQgaWQ9InEiIHBsYWNlaG9sZGVyPSJTZWFyY2ggbmFtZSwgY2FzZSAjLCBqb2IgIywgYWRkcmVzcyIg' +
  'dmFsdWU9IiR7ZXNjKGYucSB8fCAnJyl9IiBzdHlsZT0iZmxleDoxO21pbi13aWR0aDoxNjBweCI+CiAgICAgICAgPHNlbGVjdCBp' +
  'ZD0ic3RhdHVzIiBzdHlsZT0id2lkdGg6YXV0byI+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSIiPkFueSBzdGF0dXM8L29wdGlv' +
  'bj4KICAgICAgICAgICR7WydQZW5kaW5nJywgJ0Fzc2lnbmVkJywgJ0F0dGVtcHRlZCcsICdTZXJ2ZWQnLCAnTm9uLUVzdCcsICdP' +
  'biBIb2xkJywgJ0NhbmNlbGxlZCddCiAgICAgICAgICAgIC5tYXAocyA9PiBgPG9wdGlvbiAke2Yuc3RhdHVzID09PSBzID8gJ3Nl' +
  'bGVjdGVkJyA6ICcnfT4ke3N9PC9vcHRpb24+YCkuam9pbignJyl9CiAgICAgICAgPC9zZWxlY3Q+CiAgICAgICAgPGxhYmVsIHN0' +
  'eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo2cHg7bWFyZ2luOjA7Zm9udC1zaXplOjEzcHgiPgogICAg' +
  'ICAgICAgPGlucHV0IHR5cGU9ImNoZWNrYm94IiBpZD0ib3Blbk9ubHkiICR7Zi5vcGVuID8gJ2NoZWNrZWQnIDogJyd9IHN0eWxl' +
  'PSJ3aWR0aDphdXRvIj4gT3BlbiBvbmx5PC9sYWJlbD4KICAgICAgPC9kaXY+CiAgICAgICR7aXNBZG1pbigpID8gJzxidXR0b24g' +
  'Y2xhc3M9ImJ0biBibG9jayIgaWQ9Im5ld0pvYiIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+KyBOZXcgam9iPC9idXR0b24+JyA6' +
  'ICcnfQogICAgPC9kaXY+CiAgICAke2pvYnMubGVuZ3RoID8gYDxkaXYgY2xhc3M9Imxpc3QiPiR7am9icy5tYXAoam9iSXRlbSku' +
  'am9pbignJyl9PC9kaXY+YAogICAgICA6ICc8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJlbXB0eSI+Tm8gam9icyBtYXRj' +
  'aC48L2Rpdj48L2Rpdj4nfQogIGApOwogIGJpbmRTaGVsbCgpOyBiaW5kSm9iSXRlbXMoKTsKICBjb25zdCBhcHBseSA9ICgpID0+' +
  'IGdvKCdqb2JzJywgeyBxOiAkKCcjcScpLnZhbHVlLnRyaW0oKSwgc3RhdHVzOiAkKCcjc3RhdHVzJykudmFsdWUsIG9wZW46ICQo' +
  'JyNvcGVuT25seScpLmNoZWNrZWQgfSk7CiAgJCgnI3EnKS5vbmtleWRvd24gPSBlID0+IHsgaWYgKGUua2V5ID09PSAnRW50ZXIn' +
  'KSBhcHBseSgpOyB9OwogICQoJyNzdGF0dXMnKS5vbmNoYW5nZSA9IGFwcGx5OwogICQoJyNvcGVuT25seScpLm9uY2hhbmdlID0g' +
  'YXBwbHk7CiAgaWYgKCQoJyNuZXdKb2InKSkgJCgnI25ld0pvYicpLm9uY2xpY2sgPSAoKSA9PiBqb2JGb3JtKG51bGwpOwp9Cgov' +
  'KiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gam9iIGZvcm0gLS0g' +
  'Ki8KYXN5bmMgZnVuY3Rpb24gam9iRm9ybShqb2IpIHsKICBjb25zdCBbY2xpZW50cywgdXNlcnNdID0gYXdhaXQgUHJvbWlzZS5h' +
  'bGwoW2FwaSgnL2NsaWVudHMnKSwgYXBpKCcvdXNlcnMnKV0pOwogIGNvbnN0IHYgPSBqb2IgfHwgeyBzZXJ2aWNlX3R5cGU6ICdQ' +
  'ZXJzb25hbCcsIHByaW9yaXR5OiAnUm91dGluZScsIHN0YXR1czogJ1BlbmRpbmcnIH07CiAgY29uc3Qgb3B0ID0gKGxpc3QsIHNl' +
  'bCwgbGFiZWwpID0+IGxpc3QubWFwKHggPT4KICAgIGA8b3B0aW9uIHZhbHVlPSIke3guaWR9IiAke1N0cmluZyhzZWwpID09PSBT' +
  'dHJpbmcoeC5pZCkgPyAnc2VsZWN0ZWQnIDogJyd9PiR7ZXNjKGxhYmVsKHgpKX08L29wdGlvbj5gKS5qb2luKCcnKTsKCiAgc2hl' +
  'ZXQoam9iID8gJ0VkaXQgJyArIGpvYi5qb2JfbnVtYmVyIDogJ05ldyBqb2InLCBgCiAgICA8ZGl2IGNsYXNzPSJkcm9wem9uZSI+' +
  'CiAgICAgIDxsYWJlbD5TdGFydCBmcm9tIHRoZSBwYXBlcnM8L2xhYmVsPgogICAgICA8aW5wdXQgdHlwZT0iZmlsZSIgaWQ9ImZf' +
  'cGRmIiBhY2NlcHQ9ImFwcGxpY2F0aW9uL3BkZiwucGRmIj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgaWQ9InBkZk1zZyI+UGlj' +
  'ayB0aGUgc3VtbW9ucywgY2l0YXRpb24sIHN1YnBvZW5hIG9yIGNvbXBsYWludCBhcyBhIFBERiBhbmQgSSdsbAogICAgICAgIHJl' +
  'YWQgd2hhdCBJIGNhbiBpbnRvIHRoZSBmb3JtIGJlbG93LiBBbHdheXMgY2hlY2sgaXQgYWdhaW5zdCB0aGUgZG9jdW1lbnQgYmVm' +
  'b3JlIHNhdmluZy48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgIDxkaXYgY2xhc3M9ImZp' +
  'ZWxkIj48bGFiZWw+Q2xpZW50PC9sYWJlbD48c2VsZWN0IGlkPSJmX2NsaWVudF9pZCI+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0i' +
  'Ij7igJQgbm9uZSDigJQ8L29wdGlvbj4ke29wdChjbGllbnRzLCB2LmNsaWVudF9pZCwgYyA9PiBjLm5hbWUpfTwvc2VsZWN0Pjwv' +
  'ZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkFzc2lnbiB0bzwvbGFiZWw+PHNlbGVjdCBpZD0iZl9hc3NpZ25l' +
  'ZF90byI+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0iIj7igJQgdW5hc3NpZ25lZCDigJQ8L29wdGlvbj4ke29wdCh1c2Vycy5maWx0' +
  'ZXIodSA9PiB1LmFjdGl2ZSksIHYuYXNzaWduZWRfdG8sIHUgPT4gdS5uYW1lKX08L3NlbGVjdD48L2Rpdj4KICAgIDwvZGl2Pgog' +
  'ICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5QZXJzb24gLyBlbnRpdHkgdG8gc2VydmUgKjwvbGFiZWw+PGlucHV0IGlkPSJm' +
  'X3JlY2lwaWVudF9uYW1lIiB2YWx1ZT0iJHtlc2Modi5yZWNpcGllbnRfbmFtZSl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZp' +
  'ZWxkIj48bGFiZWw+U2VydmljZSBhZGRyZXNzPC9sYWJlbD48aW5wdXQgaWQ9ImZfYWRkcmVzczEiIHBsYWNlaG9sZGVyPSJTdHJl' +
  'ZXQgYWRkcmVzcyIgdmFsdWU9IiR7ZXNjKHYuYWRkcmVzczEpfSI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkIGczIj4KICAg' +
  'ICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5BcHQgLyB1bml0PC9sYWJlbD48aW5wdXQgaWQ9ImZfYWRkcmVzczIiIHZhbHVl' +
  'PSIke2VzYyh2LmFkZHJlc3MyKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNpdHk8L2xhYmVsPjxp' +
  'bnB1dCBpZD0iZl9jaXR5IiB2YWx1ZT0iJHtlc2Modi5jaXR5KX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxh' +
  'YmVsPlN0YXRlIC8gWklQPC9sYWJlbD4KICAgICAgICA8ZGl2IGNsYXNzPSJyb3ciPjxpbnB1dCBpZD0iZl9zdGF0ZSIgc3R5bGU9' +
  'IndpZHRoOjcwcHgiIG1heGxlbmd0aD0iMiIgdmFsdWU9IiR7ZXNjKHYuc3RhdGUpfSI+CiAgICAgICAgPGlucHV0IGlkPSJmX3pp' +
  'cCIgc3R5bGU9ImZsZXg6MSIgaW5wdXRtb2RlPSJudW1lcmljIiB2YWx1ZT0iJHtlc2Modi56aXApfSI+PC9kaXY+PC9kaXY+CiAg' +
  'ICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UmVjaXBpZW50IG5vdGVzIChkZXNjcmlwdGlvbiwgd29yayBo' +
  'b3VycywgdmVoaWNsZSwgZ2F0ZSBjb2RlKTwvbGFiZWw+CiAgICAgIDx0ZXh0YXJlYSBpZD0iZl9yZWNpcGllbnRfbm90ZXMiIHN0' +
  'eWxlPSJtaW4taGVpZ2h0OjYwcHgiPiR7ZXNjKHYucmVjaXBpZW50X25vdGVzKX08L3RleHRhcmVhPjwvZGl2PgogICAgPGRpdiBj' +
  'bGFzcz0iZ3JpZCBnMiI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q2FzZSBudW1iZXI8L2xhYmVsPjxpbnB1dCBp' +
  'ZD0iZl9jYXNlX251bWJlciIgdmFsdWU9IiR7ZXNjKHYuY2FzZV9udW1iZXIpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZp' +
  'ZWxkIj48bGFiZWw+Q291cnQ8L2xhYmVsPjxpbnB1dCBpZD0iZl9jb3VydCIgdmFsdWU9IiR7ZXNjKHYuY291cnQpfSI+PC9kaXY+' +
  'CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGxhaW50aWZmPC9sYWJlbD48aW5wdXQgaWQ9ImZfcGxhaW50aWZmIiB2' +
  'YWx1ZT0iJHtlc2Modi5wbGFpbnRpZmYpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RGVmZW5kYW50' +
  'PC9sYWJlbD48aW5wdXQgaWQ9ImZfZGVmZW5kYW50IiB2YWx1ZT0iJHtlc2Modi5kZWZlbmRhbnQpfSI+PC9kaXY+CiAgICA8L2Rp' +
  'dj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RG9jdW1lbnRzIHRvIHNlcnZlPC9sYWJlbD48aW5wdXQgaWQ9ImZfZG9j' +
  'dW1lbnRzIiBwbGFjZWhvbGRlcj0iU3VtbW9ucyBhbmQgQ29tcGxhaW50IiB2YWx1ZT0iJHtlc2Modi5kb2N1bWVudHMpfSI+PC9k' +
  'aXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkIGczIj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5TZXJ2aWNlIHR5cGU8' +
  'L2xhYmVsPjxzZWxlY3QgaWQ9ImZfc2VydmljZV90eXBlIj4KICAgICAgICAke1snUGVyc29uYWwnLCAnU3Vic3RpdHV0ZScsICdQ' +
  'b3N0aW5nJywgJ0NlcnRpZmllZCBNYWlsJywgJ0NvcnBvcmF0ZSddLm1hcChzID0+IGA8b3B0aW9uICR7di5zZXJ2aWNlX3R5cGUg' +
  'PT09IHMgPyAnc2VsZWN0ZWQnIDogJyd9PiR7c308L29wdGlvbj5gKS5qb2luKCcnKX08L3NlbGVjdD48L2Rpdj4KICAgICAgPGRp' +
  'diBjbGFzcz0iZmllbGQiPjxsYWJlbD5Qcmlvcml0eTwvbGFiZWw+PHNlbGVjdCBpZD0iZl9wcmlvcml0eSI+CiAgICAgICAgJHtb' +
  'J1JvdXRpbmUnLCAnUnVzaCcsICdTYW1lIERheSddLm1hcChzID0+IGA8b3B0aW9uICR7di5wcmlvcml0eSA9PT0gcyA/ICdzZWxl' +
  'Y3RlZCcgOiAnJ30+JHtzfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVs' +
  'ZCI+PGxhYmVsPkR1ZSBkYXRlPC9sYWJlbD48aW5wdXQgaWQ9ImZfZHVlX2RhdGUiIHR5cGU9ImRhdGUiIHZhbHVlPSIke3YuZHVl' +
  'X2RhdGUgPyBTdHJpbmcodi5kdWVfZGF0ZSkuc2xpY2UoMCwgMTApIDogJyd9Ij48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBj' +
  'bGFzcz0iZ3JpZCBnMyI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q2xpZW50IGZlZTwvbGFiZWw+PGlucHV0IGlk' +
  'PSJmX2NsaWVudF9mZWUiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgdmFsdWU9IiR7di5jbGllbnRfZmVlIHx8ICcnfSI+PC9k' +
  'aXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U2VydmVyIHBheTwvbGFiZWw+PGlucHV0IGlkPSJmX3NlcnZlcl9w' +
  'YXkiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgdmFsdWU9IiR7di5zZXJ2ZXJfcGF5IHx8ICcnfSI+PC9kaXY+CiAgICAgIDxk' +
  'aXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U3RhdHVzPC9sYWJlbD48c2VsZWN0IGlkPSJmX3N0YXR1cyI+CiAgICAgICAgJHtbJ1Bl' +
  'bmRpbmcnLCAnQXNzaWduZWQnLCAnQXR0ZW1wdGVkJywgJ1NlcnZlZCcsICdOb24tRXN0JywgJ09uIEhvbGQnLCAnQ2FuY2VsbGVk' +
  'J10ubWFwKHMgPT4gYDxvcHRpb24gJHt2LnN0YXR1cyA9PT0gcyA/ICdzZWxlY3RlZCcgOiAnJ30+JHtzfTwvb3B0aW9uPmApLmpv' +
  'aW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkludGVybmFsIG5v' +
  'dGVzPC9sYWJlbD48dGV4dGFyZWEgaWQ9ImZfbm90ZXMiIHN0eWxlPSJtaW4taGVpZ2h0OjYwcHgiPiR7ZXNjKHYubm90ZXMpfTwv' +
  'dGV4dGFyZWE+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjZweCI+CiAgICAgIDxidXR0b24g' +
  'Y2xhc3M9ImJ0biIgaWQ9InNhdmUiPiR7am9iID8gJ1NhdmUgY2hhbmdlcycgOiAnQ3JlYXRlIGpvYid9PC9idXR0b24+CiAgICAg' +
  'IDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIG9uY2xpY2s9ImNsb3NlU2hlZXQoKSI+Q2FuY2VsPC9idXR0b24+CiAgICAgICR7am9i' +
  'ID8gJzxidXR0b24gY2xhc3M9ImJ0biBnaG9zdCIgaWQ9ImRlbCIgc3R5bGU9ImNvbG9yOnZhcigtLWJhZCk7bWFyZ2luLWxlZnQ6' +
  'YXV0byI+RGVsZXRlPC9idXR0b24+JyA6ICcnfQogICAgPC9kaXY+YCwgZWwgPT4gewogICAgLyogLS0tLSByZWFkIGEgc3VtbW9u' +
  'cy9jaXRhdGlvbiBQREYgYW5kIGZpbGwgd2hhdCB3ZSBjYW4gLS0tLSAqLwogICAgY29uc3QgcGRmTXNnID0gZWwucXVlcnlTZWxl' +
  'Y3RvcignI3BkZk1zZycpOwogICAgY29uc3QgRklMTEFCTEUgPSBbJ2Nhc2VfbnVtYmVyJywgJ2NvdXJ0JywgJ3BsYWludGlmZics' +
  'ICdkZWZlbmRhbnQnLCAncmVjaXBpZW50X25hbWUnLAogICAgICAnYWRkcmVzczEnLCAnYWRkcmVzczInLCAnY2l0eScsICdzdGF0' +
  'ZScsICd6aXAnLCAnZG9jdW1lbnRzJ107CiAgICBjb25zdCBMQUJFTFMgPSB7CiAgICAgIGNhc2VfbnVtYmVyOiAnY2FzZSBudW1i' +
  'ZXInLCBjb3VydDogJ2NvdXJ0JywgcGxhaW50aWZmOiAncGxhaW50aWZmJywgZGVmZW5kYW50OiAnZGVmZW5kYW50JywKICAgICAg' +
  'cmVjaXBpZW50X25hbWU6ICdwZXJzb24gdG8gc2VydmUnLCBhZGRyZXNzMTogJ2FkZHJlc3MnLCBhZGRyZXNzMjogJ3VuaXQnLCBj' +
  'aXR5OiAnY2l0eScsCiAgICAgIHN0YXRlOiAnc3RhdGUnLCB6aXA6ICdaSVAnLCBkb2N1bWVudHM6ICdkb2N1bWVudHMnCiAgICB9' +
  'OwogICAgZWwucXVlcnlTZWxlY3RvcignI2ZfcGRmJykub25jaGFuZ2UgPSBhc3luYyBlID0+IHsKICAgICAgY29uc3QgZmlsZSA9' +
  'IGUudGFyZ2V0LmZpbGVzICYmIGUudGFyZ2V0LmZpbGVzWzBdOwogICAgICBpZiAoIWZpbGUpIHJldHVybjsKICAgICAgcGRmTXNn' +
  'LmlubmVySFRNTCA9ICdSZWFkaW5nICcgKyBlc2MoZmlsZS5uYW1lKSArICfigKYnOwogICAgICB0cnkgewogICAgICAgIGNvbnN0' +
  'IGRhdGEgPSBhd2FpdCBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHsKICAgICAgICAgIGNvbnN0IHIgPSBuZXcgRmlsZVJlYWRl' +
  'cigpOwogICAgICAgICAgci5vbmxvYWQgPSAoKSA9PiByZXMoU3RyaW5nKHIucmVzdWx0KS5zcGxpdCgnLCcpWzFdKTsKICAgICAg' +
  'ICAgIHIub25lcnJvciA9ICgpID0+IHJlaihuZXcgRXJyb3IoJ0NvdWxkIG5vdCByZWFkIHRoYXQgZmlsZScpKTsKICAgICAgICAg' +
  'IHIucmVhZEFzRGF0YVVSTChmaWxlKTsKICAgICAgICB9KTsKICAgICAgICBjb25zdCBvdXQgPSBhd2FpdCBhcGkoJy9wYXJzZS1k' +
  'b2N1bWVudCcsIHsKICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IG5hbWU6IGZpbGUubmFt' +
  'ZSwgZGF0YSB9KQogICAgICAgIH0pOwogICAgICAgIGlmIChvdXQud2FybmluZykgeyBwZGZNc2cuaW5uZXJIVE1MID0gJzxiIHN0' +
  'eWxlPSJjb2xvcjp2YXIoLS13YXJuKSI+JyArIGVzYyhvdXQud2FybmluZykgKyAnPC9iPic7IHJldHVybjsgfQogICAgICAgIGNv' +
  'bnN0IGZpbGxlZCA9IFtdLCBza2lwcGVkID0gW10sIG1pc3NlZCA9IFtdOwogICAgICAgIGZvciAoY29uc3QgZiBvZiBGSUxMQUJM' +
  'RSkgewogICAgICAgICAgY29uc3QgaW5wdXQgPSBlbC5xdWVyeVNlbGVjdG9yKCcjZl8nICsgZik7CiAgICAgICAgICBpZiAoIWlu' +
  'cHV0KSBjb250aW51ZTsKICAgICAgICAgIGNvbnN0IHZhbCA9IG91dC5maWVsZHNbZl07CiAgICAgICAgICBpZiAoIXZhbCkgeyBt' +
  'aXNzZWQucHVzaChMQUJFTFNbZl0pOyBjb250aW51ZTsgfQogICAgICAgICAgaWYgKGlucHV0LnZhbHVlICYmIGlucHV0LnZhbHVl' +
  'LnRyaW0oKSAmJiBpbnB1dC52YWx1ZS50cmltKCkgIT09IFN0cmluZyh2YWwpLnRyaW0oKSkgewogICAgICAgICAgICBza2lwcGVk' +
  'LnB1c2goTEFCRUxTW2ZdKTsKICAgICAgICAgICAgY29udGludWU7CiAgICAgICAgICB9CiAgICAgICAgICBpbnB1dC52YWx1ZSA9' +
  'IHZhbDsKICAgICAgICAgIGlucHV0LnN0eWxlLmJhY2tncm91bmQgPSAnI2U5ZjZlZSc7CiAgICAgICAgICBzZXRUaW1lb3V0KCgp' +
  'ID0+IHsgaW5wdXQuc3R5bGUuYmFja2dyb3VuZCA9ICcnOyB9LCA0MDAwKTsKICAgICAgICAgIGZpbGxlZC5wdXNoKExBQkVMU1tm' +
  'XSk7CiAgICAgICAgfQogICAgICAgIGxldCBtc2c7CiAgICAgICAgaWYgKGZpbGxlZC5sZW5ndGgpIHsKICAgICAgICAgIG1zZyA9' +
  'ICc8YiBzdHlsZT0iY29sb3I6dmFyKC0tb2spIj5GaWxsZWQgJyArIGZpbGxlZC5sZW5ndGggKyAnIGZpZWxkJyArIChmaWxsZWQu' +
  'bGVuZ3RoID09PSAxID8gJycgOiAncycpICsKICAgICAgICAgICAgJzwvYj4gZnJvbSAnICsgZXNjKGZpbGUubmFtZSkgKyAnICgn' +
  'ICsgKG91dC5wYWdlcyB8fCAnPycpICsgJyBwYWdlJyArIChvdXQucGFnZXMgPT09IDEgPyAnJyA6ICdzJykgKyAnKTogJyArCiAg' +
  'ICAgICAgICAgIGVzYyhmaWxsZWQuam9pbignLCAnKSkgKyAnLic7CiAgICAgICAgfSBlbHNlIGlmIChza2lwcGVkLmxlbmd0aCkg' +
  'ewogICAgICAgICAgbXNnID0gJzxiIHN0eWxlPSJjb2xvcjp2YXIoLS13YXJuKSI+RXZlcnl0aGluZyBJIGZvdW5kIHdhcyBhbHJl' +
  'YWR5IGZpbGxlZCBpbjwvYj4g4oCUIG5vdGhpbmcgb2YgeW91cnMgd2FzICcgKwogICAgICAgICAgICAnb3ZlcndyaXR0ZW4uIENs' +
  'ZWFyIGEgZmllbGQgZmlyc3QgaWYgeW91IHdhbnQgdGhlIGRvY3VtZW50XCdzIHZlcnNpb24gb2YgaXQuJzsKICAgICAgICB9IGVs' +
  'c2UgewogICAgICAgICAgbXNnID0gJzxiIHN0eWxlPSJjb2xvcjp2YXIoLS13YXJuKSI+Tm90aGluZyByZWNvZ25pc2FibGUgZm91' +
  'bmQ8L2I+IGluICcgKyBlc2MoZmlsZS5uYW1lKSArCiAgICAgICAgICAgICcuIEl0IG1heSBiZSBsYWlkIG91dCBkaWZmZXJlbnRs' +
  'eSB0byB0aGUgZG9jdW1lbnRzIHRoaXMgY2FuIHJlYWQg4oCUIGZpbGwgdGhlIGpvYiBpbiBieSBoYW5kLic7CiAgICAgICAgfQog' +
  'ICAgICAgIGlmIChmaWxsZWQubGVuZ3RoICYmIHNraXBwZWQubGVuZ3RoKSBtc2cgKz0gJyBMZWZ0IHlvdXIgZXhpc3RpbmcgJyAr' +
  'IGVzYyhza2lwcGVkLmpvaW4oJywgJykpICsgJyBhbG9uZS4nOwogICAgICAgIGlmIChtaXNzZWQubGVuZ3RoKSBtc2cgKz0gJyBO' +
  'b3QgZm91bmQ6ICcgKyBlc2MobWlzc2VkLmpvaW4oJywgJykpICsgJy4nOwogICAgICAgIG1zZyArPSAnPGJyPjxiPkNoZWNrIGV2' +
  'ZXJ5IGZpbGxlZCBmaWVsZCBhZ2FpbnN0IHRoZSBkb2N1bWVudCBiZWZvcmUgc2F2aW5nLjwvYj4nOwogICAgICAgIHBkZk1zZy5p' +
  'bm5lckhUTUwgPSBtc2c7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIHBkZk1zZy5pbm5lckhUTUwgPSAnPGIgc3R5bGU9' +
  'ImNvbG9yOnZhcigtLWJhZCkiPicgKyBlc2MoZXJyLm1lc3NhZ2UpICsgJzwvYj4nOwogICAgICB9CiAgICB9OwoKICAgIC8vIGF1' +
  'dG8tZmlsbCBmZWUvcGF5IGRlZmF1bHRzIGZyb20gdGhlIHNlbGVjdGVkIGNsaWVudCAvIHNlcnZlcgogICAgZWwucXVlcnlTZWxl' +
  'Y3RvcignI2ZfY2xpZW50X2lkJykub25jaGFuZ2UgPSBlID0+IHsKICAgICAgY29uc3QgYyA9IGNsaWVudHMuZmluZCh4ID0+IFN0' +
  'cmluZyh4LmlkKSA9PT0gZS50YXJnZXQudmFsdWUpOwogICAgICBpZiAoYyAmJiBjLmRlZmF1bHRfZmVlICYmICFlbC5xdWVyeVNl' +
  'bGVjdG9yKCcjZl9jbGllbnRfZmVlJykudmFsdWUpCiAgICAgICAgZWwucXVlcnlTZWxlY3RvcignI2ZfY2xpZW50X2ZlZScpLnZh' +
  'bHVlID0gTnVtYmVyKGMuZGVmYXVsdF9mZWUpLnRvRml4ZWQoMik7CiAgICB9OwogICAgZWwucXVlcnlTZWxlY3RvcignI2ZfYXNz' +
  'aWduZWRfdG8nKS5vbmNoYW5nZSA9IGUgPT4gewogICAgICBjb25zdCB1ID0gdXNlcnMuZmluZCh4ID0+IFN0cmluZyh4LmlkKSA9' +
  'PT0gZS50YXJnZXQudmFsdWUpOwogICAgICBpZiAodSAmJiB1LmRlZmF1bHRfcGF5ICYmICFlbC5xdWVyeVNlbGVjdG9yKCcjZl9z' +
  'ZXJ2ZXJfcGF5JykudmFsdWUpCiAgICAgICAgZWwucXVlcnlTZWxlY3RvcignI2Zfc2VydmVyX3BheScpLnZhbHVlID0gTnVtYmVy' +
  'KHUuZGVmYXVsdF9wYXkpLnRvRml4ZWQoMik7CiAgICB9OwogICAgZWwucXVlcnlTZWxlY3RvcignI3NhdmUnKS5vbmNsaWNrID0g' +
  'YXN5bmMgKCkgPT4gewogICAgICBjb25zdCBib2R5ID0ge307CiAgICAgIFsnY2xpZW50X2lkJywnYXNzaWduZWRfdG8nLCdyZWNp' +
  'cGllbnRfbmFtZScsJ2FkZHJlc3MxJywnYWRkcmVzczInLCdjaXR5Jywnc3RhdGUnLCd6aXAnLCdyZWNpcGllbnRfbm90ZXMnLAog' +
  'ICAgICAgJ2Nhc2VfbnVtYmVyJywnY291cnQnLCdwbGFpbnRpZmYnLCdkZWZlbmRhbnQnLCdkb2N1bWVudHMnLCdzZXJ2aWNlX3R5' +
  'cGUnLCdwcmlvcml0eScsJ2R1ZV9kYXRlJywKICAgICAgICdjbGllbnRfZmVlJywnc2VydmVyX3BheScsJ3N0YXR1cycsJ25vdGVz' +
  'J10uZm9yRWFjaChmID0+IHsgYm9keVtmXSA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNmXycgKyBmKS52YWx1ZTsgfSk7CiAgICAgIGlm' +
  'ICghYm9keS5yZWNpcGllbnRfbmFtZS50cmltKCkpIHJldHVybiB0b2FzdCgnV2hvIGFyZSB3ZSBzZXJ2aW5nPycsIHRydWUpOwog' +
  'ICAgICB0cnkgewogICAgICAgIGNvbnN0IHNhdmVkID0gam9iCiAgICAgICAgICA/IGF3YWl0IGFwaSgnL2pvYnMvJyArIGpvYi5p' +
  'ZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pCiAgICAgICAgICA6IGF3YWl0IGFwaSgn' +
  'L2pvYnMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KTsKICAgICAgICBjbG9zZVNoZWV0' +
  'KCk7IHRvYXN0KGpvYiA/ICdTYXZlZCcgOiAnSm9iICcgKyBzYXZlZC5qb2JfbnVtYmVyICsgJyBjcmVhdGVkJyk7CiAgICAgICAg' +
  'Z28oJ2pvYicsIHsgaWQ6IHNhdmVkLmlkIH0pOwogICAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0K' +
  'ICAgIH07CiAgICBpZiAoZWwucXVlcnlTZWxlY3RvcignI2RlbCcpKSBlbC5xdWVyeVNlbGVjdG9yKCcjZGVsJykub25jbGljayA9' +
  'IGFzeW5jICgpID0+IHsKICAgICAgaWYgKCFjb25maXJtKCdEZWxldGUgdGhpcyBqb2IgYW5kIGFsbCBpdHMgYXR0ZW1wdHM/Jykp' +
  'IHJldHVybjsKICAgICAgYXdhaXQgYXBpKCcvam9icy8nICsgam9iLmlkLCB7IG1ldGhvZDogJ0RFTEVURScgfSk7CiAgICAgIGNs' +
  'b3NlU2hlZXQoKTsgdG9hc3QoJ0RlbGV0ZWQnKTsgZ28oJ2pvYnMnKTsKICAgIH07CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gam9iIGRldGFpbCAtLSAqLwphc3luYyBmdW5jdGlv' +
  'biBqb2JWaWV3KCkgewogIGNvbnN0IGogPSBhd2FpdCBhcGkoJy9qb2JzLycgKyBTLnBhcmFtcy5pZCk7CiAgY29uc3QgYWRkciA9' +
  'IGFkZHJPZihqKTsKICBjb25zdCBkb25lID0gWydTZXJ2ZWQnLCAnTm9uLUVzdCcsICdDYW5jZWxsZWQnXS5pbmNsdWRlcyhqLnN0' +
  'YXR1cyk7CgogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tYm90dG9t' +
  'OjhweCI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBnaG9zdCIgaWQ9ImJhY2siPuKAuSBCYWNrPC9idXR0b24+CiAgICAgIDxk' +
  'aXYgY2xhc3M9InNwYWNlciIgc3R5bGU9ImZsZXg6MSI+PC9kaXY+CiAgICAgIDxzcGFuIGNsYXNzPSJwaWxsICR7Y2xzKGouc3Rh' +
  'dHVzKX0iPiR7ZXNjKGouc3RhdHVzKX08L3NwYW4+CiAgICAgICR7ai5wcmlvcml0eSAhPT0gJ1JvdXRpbmUnID8gYDxzcGFuIGNs' +
  'YXNzPSJwaWxsIHJ1c2giPiR7ZXNjKGoucHJpb3JpdHkpfTwvc3Bhbj5gIDogJyd9CiAgICA8L2Rpdj4KICAgIDxoMSBjbGFzcz0i' +
  'cGFnZSIgc3R5bGU9Im1hcmdpbi10b3A6MCI+JHtlc2Moai5yZWNpcGllbnRfbmFtZSl9PC9oMT4KCiAgICA8ZGl2IGNsYXNzPSJj' +
  'YXJkIj4KICAgICAgPGRpdiBjbGFzcz0ibSIgc3R5bGU9ImNvbG9yOnZhcigtLW11dGVkKTtmb250LXNpemU6MTNweDttYXJnaW4t' +
  'Ym90dG9tOjhweCI+JHtlc2Moai5qb2JfbnVtYmVyKX0gwrcgJHtlc2Moai5jbGllbnRfbmFtZSB8fCAnTm8gY2xpZW50Jyl9PC9k' +
  'aXY+CiAgICAgIDxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxNXB4O2ZvbnQtd2VpZ2h0OjYwMCI+JHtlc2MoYWRkciB8fCAnTm8gYWRk' +
  'cmVzcyBvbiBmaWxlJyl9PC9kaXY+CiAgICAgICR7ai5yZWNpcGllbnRfbm90ZXMgPyBgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9' +
  'Im1hcmdpbi10b3A6NnB4Ij4ke2VzYyhqLnJlY2lwaWVudF9ub3Rlcyl9PC9kaXY+YCA6ICcnfQogICAgICA8ZGl2IGNsYXNzPSJy' +
  'b3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBuYXYiIGlkPSJuYXZCdG4iICR7' +
  'YWRkciA/ICcnIDogJ2Rpc2FibGVkJ30+TmF2aWdhdGUg4pa4PC9idXR0b24+CiAgICAgICAgJHshZG9uZSA/ICc8YnV0dG9uIGNs' +
  'YXNzPSJidG4gb2siIGlkPSJhdHRCdG4iPkxvZyBhdHRlbXB0PC9idXR0b24+JyA6ICcnfQogICAgICA8L2Rpdj4KICAgICAgJHth' +
  'ZGRyID8gYDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+T3BlbnMgJHtpc0lPUygpID8gJ0FwcGxlIE1h' +
  'cHMnIDogJ0dvb2dsZSBNYXBzJ30gwrcKICAgICAgICA8YSBocmVmPSIke2lzSU9TKCkgPyBnb29nbGVVcmwoYWRkcikgOiBhcHBs' +
  'ZVVybChhZGRyKX0iIHRhcmdldD0iX2JsYW5rIj51c2UgJHtpc0lPUygpID8gJ0dvb2dsZScgOiAnQXBwbGUnfSBNYXBzIGluc3Rl' +
  'YWQ8L2E+PC9kaXY+YCA6ICcnfQogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5BdHRlbXB0cyA8' +
  'c3BhbiBjbGFzcz0ic3ViIj4ke2ouYXR0ZW1wdHMubGVuZ3RofTwvc3Bhbj48L2gyPgogICAgICAke2ouYXR0ZW1wdHMubGVuZ3Ro' +
  'ID8gai5hdHRlbXB0cy5tYXAoYSA9PiBgCiAgICAgICAgPGRpdiBjbGFzcz0iYXR0ICR7Y2xzKGEub3V0Y29tZSl9Ij4KICAgICAg' +
  'ICAgIDxkaXYgY2xhc3M9ImgiPiR7ZXNjKGEub3V0Y29tZSl9JHthLm1hbm5lciA/ICcg4oCUICcgKyBlc2MoYS5tYW5uZXIpIDog' +
  'Jyd9PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJtIj4ke2ZtdERUKGEuYXR0ZW1wdGVkX2F0KX0gwrcgJHtlc2MoYS5zZXJ2' +
  'ZXJfbmFtZSB8fCAnJyl9PC9kaXY+CiAgICAgICAgICAke2EucGVyc29uX3NlcnZlZCA/IGA8ZGl2IGNsYXNzPSJtIj5TZXJ2ZWQ6' +
  'ICR7ZXNjKGEucGVyc29uX3NlcnZlZCl9JHthLnJlbGF0aW9uc2hpcCA/ICcgKCcgKyBlc2MoYS5yZWxhdGlvbnNoaXApICsgJykn' +
  'IDogJyd9PC9kaXY+YCA6ICcnfQogICAgICAgICAgJHthLmRlc2NyaXB0aW9uID8gYDxkaXYgY2xhc3M9Im0iPkRlc2NyaXB0aW9u' +
  'OiAke2VzYyhhLmRlc2NyaXB0aW9uKX08L2Rpdj5gIDogJyd9CiAgICAgICAgICAke2Eubm90ZXMgPyBgPGRpdiBjbGFzcz0ibSI+' +
  'JHtlc2MoYS5ub3Rlcyl9PC9kaXY+YCA6ICcnfQogICAgICAgICAgJHthLmxhdCAhPSBudWxsID8gYDxkaXYgY2xhc3M9Im0iPkdQ' +
  'UyAke051bWJlcihhLmxhdCkudG9GaXhlZCg1KX0sICR7TnVtYmVyKGEubG5nKS50b0ZpeGVkKDUpfQogICAgICAgICAgICAke2Eu' +
  'YWNjdXJhY3lfbSA/ICfCsScgKyBNYXRoLnJvdW5kKGEuYWNjdXJhY3lfbSkgKyAnbScgOiAnJ30gwrcKICAgICAgICAgICAgPGEg' +
  'aHJlZj0iaHR0cHM6Ly93d3cuZ29vZ2xlLmNvbS9tYXBzP3E9JHthLmxhdH0sJHthLmxuZ30iIHRhcmdldD0iX2JsYW5rIj5tYXA8' +
  'L2E+PC9kaXY+YCA6ICcnfQogICAgICAgICAgJHtwaG90b1N0cmlwKGEsIGopfQogICAgICAgIDwvZGl2PmApLmpvaW4oJycpCiAg' +
  'ICAgICAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPk5vIGF0dGVtcHRzIGxvZ2dlZCB5ZXQuPC9kaXY+J30KICAgIDwvZGl2PgoKICAg' +
  'IDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+UGFwZXJ3b3JrPC9oMj4KICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAg' +
  'ICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0iYWZmQnRuIj5BZmZpZGF2aXQ8L2J1dHRvbj4KICAgICAgICA8YnV0dG9u' +
  'IGNsYXNzPSJidG4gc2VjIHNtIiBpZD0iY292ZXJCdG4iPkNvdmVyIHNoZWV0ICsgYmFyY29kZTwvYnV0dG9uPgogICAgICAgICR7' +
  'ai5jYXNlX251bWJlciA/ICc8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0ibG9va3VwQnRuIj5Mb29rIHVwIGNhc2U8L2J1' +
  'dHRvbj4nIDogJyd9CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlcjttYXJnaW4tdG9wOjE0' +
  'cHgiPgogICAgICAgIDxpbWcgc3JjPSIvYmFyY29kZS8ke2VuY29kZVVSSUNvbXBvbmVudChqLmpvYl9udW1iZXIpfS5zdmciIGFs' +
  'dD0iYmFyY29kZSIgc3R5bGU9Im1heC13aWR0aDoxMDAlIj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNz' +
  'PSJjYXJkIj4KICAgICAgPGgyPkNhc2UgZGV0YWlsPC9oMj4KICAgICAgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgICAgICR7W1sn' +
  'Q2FzZScsIGouY2FzZV9udW1iZXJdLCBbJ0NvdXJ0Jywgai5jb3VydF0sIFsnUGxhaW50aWZmJywgai5wbGFpbnRpZmZdLCBbJ0Rl' +
  'ZmVuZGFudCcsIGouZGVmZW5kYW50XSwKICAgICAgICAgICBbJ0RvY3VtZW50cycsIGouZG9jdW1lbnRzXSwgWydTZXJ2aWNlIHR5' +
  'cGUnLCBqLnNlcnZpY2VfdHlwZV0sIFsnRHVlJywgZm10RGF0ZU9ubHkoai5kdWVfZGF0ZSldLAogICAgICAgICAgIFsnQXNzaWdu' +
  'ZWQgdG8nLCBqLnNlcnZlcl9uYW1lXSwgWydDbGllbnQgZmVlJywgai5jbGllbnRfZmVlID8gbW9uZXkoai5jbGllbnRfZmVlKSA6' +
  'ICcnXSwKICAgICAgICAgICBbJ1NlcnZlciBwYXknLCBqLnNlcnZlcl9wYXkgPyBtb25leShqLnNlcnZlcl9wYXkpIDogJyddLAog' +
  'ICAgICAgICAgIFsnU2VydmVkJywgai5zZXJ2ZWRfYXQgPyBmbXREVChqLnNlcnZlZF9hdCkgKyAnIOKAlCAnICsgZXNjKGouc2Vy' +
  'dmVkX21hbm5lciB8fCAnJykgOiAnJ10sCiAgICAgICAgICAgWydOb3RlcycsIGoubm90ZXNdXQogICAgICAgICAgLmZpbHRlcihy' +
  'ID0+IHJbMV0pLm1hcChyID0+IGA8dHI+PHRoIHN0eWxlPSJ3aWR0aDozNCUiPiR7clswXX08L3RoPjx0ZD4ke2VzYyhyWzFdKX08' +
  'L3RkPjwvdHI+YCkuam9pbignJyl9CiAgICAgIDwvdGFibGU+CiAgICAgICR7aXNBZG1pbigpID8gJzxidXR0b24gY2xhc3M9ImJ0' +
  'biBzZWMgYmxvY2sgc20iIGlkPSJlZGl0QnRuIiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij5FZGl0IGpvYjwvYnV0dG9uPicgOiAn' +
  'J30KICAgIDwvZGl2PmApOwogIGJpbmRTaGVsbCgpOwogICQoJyNiYWNrJykub25jbGljayA9ICgpID0+IGdvKCdqb2JzJywgUy5j' +
  'YWNoZS5qb2JGaWx0ZXIgfHwge30pOwogIGlmICgkKCcjbmF2QnRuJykpICQoJyNuYXZCdG4nKS5vbmNsaWNrID0gKCkgPT4gd2lu' +
  'ZG93Lm9wZW4obmF2VXJsKGFkZHIpLCAnX2JsYW5rJyk7CiAgaWYgKCQoJyNhdHRCdG4nKSkgJCgnI2F0dEJ0bicpLm9uY2xpY2sg' +
  'PSAoKSA9PiBhdHRlbXB0Rm9ybShqKTsKICBpZiAoJCgnI2VkaXRCdG4nKSkgJCgnI2VkaXRCdG4nKS5vbmNsaWNrID0gKCkgPT4g' +
  'am9iRm9ybShqKTsKICAkKCcjY292ZXJCdG4nKS5vbmNsaWNrID0gKCkgPT4gd2luZG93Lm9wZW4oJy9wcmludC9jb3ZlcnNoZWV0' +
  'LycgKyBqLmlkLCAnX2JsYW5rJyk7CiAgJCgnI2FmZkJ0bicpLm9uY2xpY2sgPSAoKSA9PiBhZmZpZGF2aXRTaGVldChqKTsKICBp' +
  'ZiAoJCgnI2xvb2t1cEJ0bicpKSAkKCcjbG9va3VwQnRuJykub25jbGljayA9ICgpID0+IGNhc2VMb29rdXBTaGVldChqKTsKICBi' +
  'aW5kUGhvdG9TdHJpcHMoaik7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tIHBob3RvcyAtLSAqLwovKiBBIHBob25lIGNhbWVyYSBtYWtlcyBhIDRNQiwgNDAwMHB4IHBpY3R1cmUuIE5vYm9k' +
  'eSBuZWVkcyB0aGF0IHRvIHByb3ZlIGEKICogZG9vciB3YXMga25vY2tlZCBvbiwgYW5kIHNlbmRpbmcgaXQgb3ZlciBhIHBhcmtp' +
  'bmctbG90IHNpZ25hbCBpcyBob3cgYQogKiBzZXJ2ZXIgZ2l2ZXMgdXAgYW5kIHN0b3BzIHRha2luZyBwaG90b3MgYXQgYWxsLiBT' +
  'byBldmVyeSBzaG90IGlzIGRyYXduCiAqIGludG8gYSBjYW52YXMgYXQgMTYwMHB4IG9uIGl0cyBsb25nIHNpZGUgYW5kIHJlLWVu' +
  'Y29kZWQgYXMgSlBFRyBiZWZvcmUgaXQKICogbGVhdmVzIHRoZSBwaG9uZSDigJQgYWJvdXQgMjUwS0IsIHN0aWxsIHNoYXJwIGVu' +
  'b3VnaCB0byByZWFkIGEgaG91c2UgbnVtYmVyLiAqLwpjb25zdCBQSE9UT19NQVhfRURHRSA9IDE2MDA7CmNvbnN0IFBIT1RPX1FV' +
  'QUxJVFkgPSAwLjcyOwoKZnVuY3Rpb24gc2hyaW5rUGhvdG8oZmlsZSkgewogIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwg' +
  'cmVqZWN0KSA9PiB7CiAgICBjb25zdCBpbWcgPSBuZXcgSW1hZ2UoKTsKICAgIGNvbnN0IHVybCA9IFVSTC5jcmVhdGVPYmplY3RV' +
  'UkwoZmlsZSk7CiAgICBpbWcub25sb2FkID0gKCkgPT4gewogICAgICBVUkwucmV2b2tlT2JqZWN0VVJMKHVybCk7CiAgICAgIGNv' +
  'bnN0IHNjYWxlID0gTWF0aC5taW4oMSwgUEhPVE9fTUFYX0VER0UgLyBNYXRoLm1heChpbWcud2lkdGgsIGltZy5oZWlnaHQpKTsK' +
  'ICAgICAgY29uc3QgdyA9IE1hdGgucm91bmQoaW1nLndpZHRoICogc2NhbGUpLCBoID0gTWF0aC5yb3VuZChpbWcuaGVpZ2h0ICog' +
  'c2NhbGUpOwogICAgICBjb25zdCBjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnY2FudmFzJyk7CiAgICAgIGMud2lkdGggPSB3' +
  'OyBjLmhlaWdodCA9IGg7CiAgICAgIGMuZ2V0Q29udGV4dCgnMmQnKS5kcmF3SW1hZ2UoaW1nLCAwLCAwLCB3LCBoKTsKICAgICAg' +
  'Y29uc3QgZGF0YSA9IGMudG9EYXRhVVJMKCdpbWFnZS9qcGVnJywgUEhPVE9fUVVBTElUWSkuc3BsaXQoJywnKVsxXTsKICAgICAg' +
  'aWYgKCFkYXRhKSByZXR1cm4gcmVqZWN0KG5ldyBFcnJvcignVGhpcyBwaG9uZSBjb3VsZCBub3QgcHJvY2VzcyB0aGF0IHBob3Rv' +
  'JykpOwogICAgICByZXNvbHZlKHsgZGF0YSwgbWltZTogJ2ltYWdlL2pwZWcnLCB3aWR0aDogdywgaGVpZ2h0OiBoIH0pOwogICAg' +
  'fTsKICAgIGltZy5vbmVycm9yID0gKCkgPT4geyBVUkwucmV2b2tlT2JqZWN0VVJMKHVybCk7IHJlamVjdChuZXcgRXJyb3IoJ1Ro' +
  'YXQgZmlsZSBpcyBub3QgYSBwaG90bycpKTsgfTsKICAgIGltZy5zcmMgPSB1cmw7CiAgfSk7Cn0KCi8vIFVwbG9hZHMgb25lIGF0' +
  'IGEgdGltZTogYSBzZXJ2ZXIgb24gYSB3ZWFrIHNpZ25hbCBnZXRzIHBhcnRpYWwgc3VjY2VzcyByYXRoZXIKLy8gdGhhbiBvbmUg' +
  'Z2lhbnQgcmVxdWVzdCB0aGF0IGZhaWxzIHdob2xlLgphc3luYyBmdW5jdGlvbiB1cGxvYWRQaG90b3MoYXR0ZW1wdElkLCBmaWxl' +
  'cywgb25Qcm9ncmVzcykgewogIGNvbnN0IGRvbmUgPSBbXTsKICBmb3IgKGxldCBpID0gMDsgaSA8IGZpbGVzLmxlbmd0aDsgaSsr' +
  'KSB7CiAgICBpZiAob25Qcm9ncmVzcykgb25Qcm9ncmVzcyhpICsgMSwgZmlsZXMubGVuZ3RoKTsKICAgIGNvbnN0IHNob3QgPSBh' +
  'd2FpdCBzaHJpbmtQaG90byhmaWxlc1tpXSk7CiAgICBkb25lLnB1c2goYXdhaXQgYXBpKCcvYXR0ZW1wdHMvJyArIGF0dGVtcHRJ' +
  'ZCArICcvcGhvdG9zJywgewogICAgICBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoc2hvdCkKICAgIH0pKTsK' +
  'ICB9CiAgcmV0dXJuIGRvbmU7Cn0KCmZ1bmN0aW9uIHBob3RvU3RyaXAoYSwgam9iKSB7CiAgY29uc3QgY2FuRWRpdCA9ICFqb2Iu' +
  'cGhvdG9zX2hpZGRlbiAmJiAoaXNBZG1pbigpIHx8IGpvYi5hc3NpZ25lZF90byA9PT0gUy5tZS5pZCk7CiAgaWYgKGpvYi5waG90' +
  'b3NfaGlkZGVuKSB7CiAgICByZXR1cm4gYS5waG90b19jb3VudAogICAgICA/IGA8ZGl2IGNsYXNzPSJtIHBob3RvLWhpZGRlbiI+' +
  'JHthLnBob3RvX2NvdW50fSBwaG90byR7YS5waG90b19jb3VudCA+IDEgPyAncycgOiAnJ30g4oCUIGhpZGRlbiBpbiBzdXBwb3J0' +
  'IHZpZXc8L2Rpdj5gCiAgICAgIDogJyc7CiAgfQogIGNvbnN0IHRodW1icyA9IChhLnBob3RvcyB8fCBbXSkubWFwKHAgPT4KICAg' +
  'IGA8YnV0dG9uIGNsYXNzPSJ0aHVtYiIgZGF0YS1waG90bz0iJHtwLmlkfSIgdGl0bGU9IiR7ZXNjKHAuY2FwdGlvbiB8fCAnJyl9' +
  'Ij4KICAgICAgIDxpbWcgc3JjPSIvcGhvdG8vJHtwLmlkfSIgYWx0PSIke2VzYyhwLmNhcHRpb24gfHwgJ0F0dGVtcHQgcGhvdG8n' +
  'KX0iIGxvYWRpbmc9ImxhenkiPgogICAgICAgJHtwLmNhcHRpb24gPyBgPHNwYW4gY2xhc3M9ImNhcCI+JHtlc2MocC5jYXB0aW9u' +
  'KX08L3NwYW4+YCA6ICcnfQogICAgIDwvYnV0dG9uPmApLmpvaW4oJycpOwogIHJldHVybiBgPGRpdiBjbGFzcz0icGhvdG9zIiBk' +
  'YXRhLWF0dGVtcHQ9IiR7YS5pZH0iPgogICAgJHt0aHVtYnN9CiAgICAke2NhbkVkaXQgPyBgPGJ1dHRvbiBjbGFzcz0idGh1bWIg' +
  'YWRkIiBkYXRhLWFkZD0iJHthLmlkfSI+77yLPHNwYW4+UGhvdG88L3NwYW4+PC9idXR0b24+YCA6ICcnfQogIDwvZGl2PmA7Cn0K' +
  'CmZ1bmN0aW9uIGJpbmRQaG90b1N0cmlwcyhqb2IpIHsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1waG90b10n' +
  'KS5mb3JFYWNoKGIgPT4gewogICAgYi5vbmNsaWNrID0gKCkgPT4gcGhvdG9WaWV3ZXIoam9iLCBOdW1iZXIoYi5kYXRhc2V0LnBo' +
  'b3RvKSk7CiAgfSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWRkXScpLmZvckVhY2goYiA9PiB7CiAgICBi' +
  'Lm9uY2xpY2sgPSAoKSA9PiBwaWNrUGhvdG9zKGFzeW5jIGZpbGVzID0+IHsKICAgICAgY29uc3QgbGFiZWwgPSBiLnF1ZXJ5U2Vs' +
  'ZWN0b3IoJ3NwYW4nKTsKICAgICAgY29uc3Qgd2FzID0gbGFiZWwudGV4dENvbnRlbnQ7CiAgICAgIGIuZGlzYWJsZWQgPSB0cnVl' +
  'OwogICAgICB0cnkgewogICAgICAgIGF3YWl0IHVwbG9hZFBob3RvcyhOdW1iZXIoYi5kYXRhc2V0LmFkZCksIGZpbGVzLAogICAg' +
  'ICAgICAgKG4sIHRvdGFsKSA9PiB7IGxhYmVsLnRleHRDb250ZW50ID0gbiArICcvJyArIHRvdGFsOyB9KTsKICAgICAgICB0b2Fz' +
  'dChmaWxlcy5sZW5ndGggPiAxID8gZmlsZXMubGVuZ3RoICsgJyBwaG90b3MgYWRkZWQnIDogJ1Bob3RvIGFkZGVkJyk7CiAgICAg' +
  'ICAgZ28oJ2pvYicsIHsgaWQ6IGpvYi5pZCB9KTsKICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgIGIuZGlzYWJsZWQgPSBmYWxz' +
  'ZTsgbGFiZWwudGV4dENvbnRlbnQgPSB3YXM7CiAgICAgICAgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsKICAgICAgfQogICAgfSk7' +
  'CiAgfSk7Cn0KCi8vIE9uZSBoaWRkZW4gaW5wdXQsIHJldXNlZC4gY2FwdHVyZT0iZW52aXJvbm1lbnQiIG9wZW5zIHRoZSByZWFy' +
  'IGNhbWVyYQovLyBzdHJhaWdodCBhd2F5IG9uIGEgcGhvbmU7IG9uIGEgZGVza3RvcCBpdCBpcyBhbiBvcmRpbmFyeSBmaWxlIHBp' +
  'Y2tlci4KZnVuY3Rpb24gcGlja1Bob3RvcyhvblBpY2tlZCkgewogIGNvbnN0IGlucCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQo' +
  'J2lucHV0Jyk7CiAgaW5wLnR5cGUgPSAnZmlsZSc7CiAgaW5wLmFjY2VwdCA9ICdpbWFnZS8qJzsKICBpbnAubXVsdGlwbGUgPSB0' +
  'cnVlOwogIGlucC5zZXRBdHRyaWJ1dGUoJ2NhcHR1cmUnLCAnZW52aXJvbm1lbnQnKTsKICBpbnAuc3R5bGUuZGlzcGxheSA9ICdu' +
  'b25lJzsKICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGlucCk7CiAgaW5wLm9uY2hhbmdlID0gKCkgPT4gewogICAgY29uc3Qg' +
  'ZmlsZXMgPSBBcnJheS5mcm9tKGlucC5maWxlcyB8fCBbXSk7CiAgICBpbnAucmVtb3ZlKCk7CiAgICBpZiAoZmlsZXMubGVuZ3Ro' +
  'KSBvblBpY2tlZChmaWxlcyk7CiAgfTsKICBpbnAuY2xpY2soKTsKfQoKZnVuY3Rpb24gcGhvdG9WaWV3ZXIoam9iLCBpZCkgewog' +
  'IGNvbnN0IGFsbCA9IGpvYi5hdHRlbXB0cy5mbGF0TWFwKGEgPT4gYS5waG90b3MgfHwgW10pOwogIGNvbnN0IHAgPSBhbGwuZmlu' +
  'ZCh4ID0+IHguaWQgPT09IGlkKTsKICBpZiAoIXApIHJldHVybjsKICBjb25zdCBjYW5FZGl0ID0gaXNBZG1pbigpIHx8IGpvYi5h' +
  'c3NpZ25lZF90byA9PT0gUy5tZS5pZDsKICBzaGVldCgnUGhvdG8nLCBgCiAgICA8aW1nIHNyYz0iL3Bob3RvLyR7cC5pZH0iIGFs' +
  'dD0iIiBzdHlsZT0id2lkdGg6MTAwJTtib3JkZXItcmFkaXVzOjEycHg7ZGlzcGxheTpibG9jayI+CiAgICA8ZGl2IGNsYXNzPSJm' +
  'aWVsZCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+PGxhYmVsPkNhcHRpb248L2xhYmVsPgogICAgICA8aW5wdXQgaWQ9InBfY2Fw' +
  'IiB2YWx1ZT0iJHtlc2MocC5jYXB0aW9uIHx8ICcnKX0iIHBsYWNlaG9sZGVyPSJGcm9udCBkb29yLCBubyBhbnN3ZXIiCiAgICAg' +
  'ICAgJHtjYW5FZGl0ID8gJycgOiAnZGlzYWJsZWQnfT48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImhpbnQiPiR7TWF0aC5yb3VuZChw' +
  'LmJ5dGVzIC8gMTAyNCl9IEtCIMK3IGFkZGVkICR7Zm10RFQocC5jcmVhdGVkX2F0KX08L2Rpdj4KICAgICR7Y2FuRWRpdCA/IGA8' +
  'ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJwX3Nh' +
  'dmUiPlNhdmUgY2FwdGlvbjwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBpZD0icF9kZWwiPkRlbGV0ZSBw' +
  'aG90bzwvYnV0dG9uPgogICAgPC9kaXY+YCA6ICcnfWAsIGVsID0+IHsKICAgIGlmICghY2FuRWRpdCkgcmV0dXJuOwogICAgZWwu' +
  'cXVlcnlTZWxlY3RvcignI3Bfc2F2ZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQg' +
  'YXBpKCcvcGhvdG9zLycgKyBwLmlkLCB7CiAgICAgICAgICBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsg' +
  'Y2FwdGlvbjogZWwucXVlcnlTZWxlY3RvcignI3BfY2FwJykudmFsdWUgfSkKICAgICAgICB9KTsKICAgICAgICBjbG9zZVNoZWV0' +
  'KCk7IHRvYXN0KCdDYXB0aW9uIHNhdmVkJyk7IGdvKCdqb2InLCB7IGlkOiBqb2IuaWQgfSk7CiAgICAgIH0gY2F0Y2ggKGUpIHsg' +
  'dG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogICAgfTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNwX2RlbCcpLm9uY2xpY2sgPSBh' +
  'c3luYyAoKSA9PiB7CiAgICAgIGlmICghY29uZmlybSgnRGVsZXRlIHRoaXMgcGhvdG8/IEl0IGlzIHBhcnQgb2YgdGhlIHJlY29y' +
  'ZCBmb3IgdGhpcyBhdHRlbXB0LicpKSByZXR1cm47CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgYXBpKCcvcGhvdG9zLycgKyBw' +
  'LmlkLCB7IG1ldGhvZDogJ0RFTEVURScgfSk7CiAgICAgICAgY2xvc2VTaGVldCgpOyB0b2FzdCgnUGhvdG8gZGVsZXRlZCcpOyBn' +
  'bygnam9iJywgeyBpZDogam9iLmlkIH0pOwogICAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICAg' +
  'IH07CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gbG9n' +
  'IGF0dGVtcHQgLS0gKi8KY29uc3QgT1VUQ09NRVMgPSBbJ1NlcnZlZCcsICdObyBBbnN3ZXInLCAnQmFkIEFkZHJlc3MnLCAnTW92' +
  'ZWQnLCAnUmVmdXNlZCcsICdFdmFkaW5nJywgJ090aGVyJ107CgpmdW5jdGlvbiBhdHRlbXB0Rm9ybShqb2IpIHsKICBzaGVldCgn' +
  'TG9nIGF0dGVtcHQg4oCUICcgKyBqb2IucmVjaXBpZW50X25hbWUsIGAKICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+T3V0' +
  'Y29tZTwvbGFiZWw+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgaWQ9Im91dGNvbWVzIj4ke09VVENPTUVTLm1hcChvID0+CiAgICAg' +
  'ICAgYDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGRhdGEtbz0iJHtvfSI+JHtvfTwvYnV0dG9uPmApLmpvaW4oJycpfTwvZGl2' +
  'PjwvZGl2PgogICAgPGRpdiBpZD0ic2VydmVkRmllbGRzIiBzdHlsZT0iZGlzcGxheTpub25lIj4KICAgICAgPGRpdiBjbGFzcz0i' +
  'Z3JpZCBnMiI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5NYW5uZXI8L2xhYmVsPjxzZWxlY3QgaWQ9ImFfbWFu' +
  'bmVyIj4KICAgICAgICAgICR7WydQZXJzb25hbCcsICdTdWJzdGl0dXRlJywgJ1Bvc3RlZCcsICdDb3Jwb3JhdGUnLCAnQ2VydGlm' +
  'aWVkIE1haWwnXS5tYXAocyA9PiBgPG9wdGlvbj4ke3N9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9kaXY+CiAgICAg' +
  'ICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5QZXJzb24gc2VydmVkPC9sYWJlbD48aW5wdXQgaWQ9ImFfcGVyc29uX3NlcnZl' +
  'ZCIgdmFsdWU9IiR7ZXNjKGpvYi5yZWNpcGllbnRfbmFtZSl9Ij48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9' +
  'ImdyaWQgZzIiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UmVsYXRpb25zaGlwIChpZiBzdWJzdGl0dXRlKTwv' +
  'bGFiZWw+PGlucHV0IGlkPSJhX3JlbGF0aW9uc2hpcCIgcGxhY2Vob2xkZXI9ImNvLXJlc2lkZW50LCBjby13b3JrZXIuLi4iPjwv' +
  'ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RGVzY3JpcHRpb248L2xhYmVsPjxpbnB1dCBpZD0iYV9kZXNj' +
  'cmlwdGlvbiIgcGxhY2Vob2xkZXI9IlcvRiwgNDBzLCA1JzYmcXVvdDssIGJyb3duIGhhaXIiPjwvZGl2PgogICAgICA8L2Rpdj4K' +
  'ICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Ob3RlczwvbGFiZWw+PHRleHRhcmVhIGlkPSJhX25vdGVz' +
  'IiBwbGFjZWhvbGRlcj0iTGlnaHRzIG9uLCBubyBhbnN3ZXIgYXQgZnJvbnQgZG9vci4gU2lsdmVyIENpdmljIGluIGRyaXZld2F5' +
  'LiI+PC90ZXh0YXJlYT48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+V2hlbjwvbGFiZWw+PGlucHV0IGlkPSJh' +
  'X3doZW4iIHR5cGU9ImRhdGV0aW1lLWxvY2FsIiB2YWx1ZT0iJHtsb2NhbE5vdygpfSI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJj' +
  'YXJkIiBzdHlsZT0iYmFja2dyb3VuZDojZjhmYWZjO2JveC1zaGFkb3c6bm9uZTttYXJnaW4tYm90dG9tOjEycHgiPgogICAgICA8' +
  'ZGl2IGNsYXNzPSJyb3ciPjxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJncHNCdG4iPkNhcHR1cmUgR1BTPC9idXR0b24+' +
  'CiAgICAgIDxzcGFuIGNsYXNzPSJoaW50IiBpZD0iZ3BzT3V0IiBzdHlsZT0ibWFyZ2luOjAiPk5vdCBjYXB0dXJlZDwvc3Bhbj48' +
  'L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5QaG90b3M8L2xhYmVsPgogICAgICA8ZGl2IGNs' +
  'YXNzPSJwaG90b3MiIGlkPSJwZW5kUGhvdG9zIj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJ0aHVtYiBhZGQiIGlkPSJwaG90b0J0' +
  'biIgdHlwZT0iYnV0dG9uIj7vvIs8c3Bhbj5QaG90bzwvc3Bhbj48L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xh' +
  'c3M9ImhpbnQiPlRoZSBkb29yLCB0aGUgbnVtYmVyLCB0aGUgbm90aWNlLCB0aGUgY2FyLiBUaGV5IGdvIG9uIHRoZSBhdHRlbXB0' +
  'CiAgICAgIGFuZCBvbiB0aGUgcmVwb3J0IHlvdXIgY2xpZW50IHNlZXMuPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9' +
  'InJvdyI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InNhdmVBdHQiIGRpc2FibGVkPlBpY2sgYW4gb3V0Y29tZTwvYnV0' +
  'dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNhbmNlbDwvYnV0dG9uPgog' +
  'ICAgPC9kaXY+YCwgZWwgPT4gewogICAgbGV0IG91dGNvbWUgPSBudWxsLCBncHMgPSBudWxsOwogICAgLyogUGhvdG9zIGFyZSBw' +
  'aWNrZWQgYmVmb3JlIHRoZSBhdHRlbXB0IGV4aXN0cywgc28gdGhleSBhcmUgaGVsZCBoZXJlIGFuZAogICAgICAgdXBsb2FkZWQg' +
  'b25jZSBzYXZpbmcgZ2l2ZXMgdXMgYW4gYXR0ZW1wdCBpZC4gKi8KICAgIGNvbnN0IHBlbmRpbmcgPSBbXTsKICAgIGNvbnN0IHN0' +
  'cmlwID0gZWwucXVlcnlTZWxlY3RvcignI3BlbmRQaG90b3MnKTsKICAgIGNvbnN0IGFkZEJ0biA9IGVsLnF1ZXJ5U2VsZWN0b3Io' +
  'JyNwaG90b0J0bicpOwogICAgY29uc3QgZHJhd1BlbmRpbmcgPSAoKSA9PiB7CiAgICAgIHN0cmlwLnF1ZXJ5U2VsZWN0b3JBbGwo' +
  'Jy5wZW5kJykuZm9yRWFjaChuID0+IG4ucmVtb3ZlKCkpOwogICAgICBwZW5kaW5nLmZvckVhY2goKGYsIGkpID0+IHsKICAgICAg' +
  'ICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7CiAgICAgICAgYi50eXBlID0gJ2J1dHRvbic7CiAg' +
  'ICAgICAgYi5jbGFzc05hbWUgPSAndGh1bWIgcGVuZCc7CiAgICAgICAgYi50aXRsZSA9ICdSZW1vdmUnOwogICAgICAgIGIuaW5u' +
  'ZXJIVE1MID0gYDxpbWcgc3JjPSIke1VSTC5jcmVhdGVPYmplY3RVUkwoZil9IiBhbHQ9IiI+PHNwYW4gY2xhc3M9IngiPsOXPC9z' +
  'cGFuPmA7CiAgICAgICAgYi5vbmNsaWNrID0gKCkgPT4geyBwZW5kaW5nLnNwbGljZShpLCAxKTsgZHJhd1BlbmRpbmcoKTsgfTsK' +
  'ICAgICAgICBzdHJpcC5pbnNlcnRCZWZvcmUoYiwgYWRkQnRuKTsKICAgICAgfSk7CiAgICAgIGFkZEJ0bi5xdWVyeVNlbGVjdG9y' +
  'KCdzcGFuJykudGV4dENvbnRlbnQgPSBwZW5kaW5nLmxlbmd0aCA/IGBQaG90byAoJHtwZW5kaW5nLmxlbmd0aH0pYCA6ICdQaG90' +
  'byc7CiAgICB9OwogICAgYWRkQnRuLm9uY2xpY2sgPSAoKSA9PiBwaWNrUGhvdG9zKGZpbGVzID0+IHsgcGVuZGluZy5wdXNoKC4u' +
  'LmZpbGVzKTsgZHJhd1BlbmRpbmcoKTsgfSk7CiAgICBlbC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1vXScpLmZvckVhY2goYiA9' +
  'PiBiLm9uY2xpY2sgPSAoKSA9PiB7CiAgICAgIG91dGNvbWUgPSBiLmRhdGFzZXQubzsKICAgICAgZWwucXVlcnlTZWxlY3RvckFs' +
  'bCgnW2RhdGEtb10nKS5mb3JFYWNoKHggPT4geyB4LmNsYXNzTmFtZSA9ICdidG4gc2VjIHNtJzsgfSk7CiAgICAgIGIuY2xhc3NO' +
  'YW1lID0gJ2J0biBzbScgKyAob3V0Y29tZSA9PT0gJ1NlcnZlZCcgPyAnIG9rJyA6ICcnKTsKICAgICAgZWwucXVlcnlTZWxlY3Rv' +
  'cignI3NlcnZlZEZpZWxkcycpLnN0eWxlLmRpc3BsYXkgPSBvdXRjb21lID09PSAnU2VydmVkJyA/ICcnIDogJ25vbmUnOwogICAg' +
  'ICBjb25zdCBzID0gZWwucXVlcnlTZWxlY3RvcignI3NhdmVBdHQnKTsKICAgICAgcy5kaXNhYmxlZCA9IGZhbHNlOwogICAgICBz' +
  'LnRleHRDb250ZW50ID0gb3V0Y29tZSA9PT0gJ1NlcnZlZCcgPyAnU2F2ZSDigJQgbWFya3Mgam9iIFNFUlZFRCcgOiAnU2F2ZSBh' +
  'dHRlbXB0JzsKICAgIH0pOwogICAgZWwucXVlcnlTZWxlY3RvcignI2dwc0J0bicpLm9uY2xpY2sgPSAoKSA9PiB7CiAgICAgIGNv' +
  'bnN0IG91dCA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNncHNPdXQnKTsKICAgICAgaWYgKCFuYXZpZ2F0b3IuZ2VvbG9jYXRpb24pIHJl' +
  'dHVybiBvdXQudGV4dENvbnRlbnQgPSAnTm90IHN1cHBvcnRlZCBvbiB0aGlzIGRldmljZSc7CiAgICAgIG91dC50ZXh0Q29udGVu' +
  'dCA9ICdMb2NhdGluZ+KApic7CiAgICAgIG5hdmlnYXRvci5nZW9sb2NhdGlvbi5nZXRDdXJyZW50UG9zaXRpb24ocG9zID0+IHsK' +
  'ICAgICAgICBncHMgPSB7IGxhdDogcG9zLmNvb3Jkcy5sYXRpdHVkZSwgbG5nOiBwb3MuY29vcmRzLmxvbmdpdHVkZSwgYWNjdXJh' +
  'Y3lfbTogcG9zLmNvb3Jkcy5hY2N1cmFjeSB9OwogICAgICAgIG91dC5pbm5lckhUTUwgPSBgPGIgc3R5bGU9ImNvbG9yOnZhcigt' +
  'LW9rKSI+4pyTICR7Z3BzLmxhdC50b0ZpeGVkKDUpfSwgJHtncHMubG5nLnRvRml4ZWQoNSl9PC9iPiDCsSR7TWF0aC5yb3VuZChn' +
  'cHMuYWNjdXJhY3lfbSl9bWA7CiAgICAgIH0sIGVyciA9PiB7IG91dC50ZXh0Q29udGVudCA9ICdGYWlsZWQ6ICcgKyBlcnIubWVz' +
  'c2FnZTsgfSwKICAgICAgICB7IGVuYWJsZUhpZ2hBY2N1cmFjeTogdHJ1ZSwgdGltZW91dDogMTUwMDAsIG1heGltdW1BZ2U6IDAg' +
  'fSk7CiAgICB9OwogICAgLy8gYXV0by1jYXB0dXJlIG9uIG9wZW4g4oCUIHRoZSBhZmZpZGF2aXQgaXMgc3Ryb25nZXIgd2hlbiBl' +
  'dmVyeSBhdHRlbXB0IGhhcyBjb29yZGluYXRlcwogICAgZWwucXVlcnlTZWxlY3RvcignI2dwc0J0bicpLmNsaWNrKCk7CgogICAg' +
  'ZWwucXVlcnlTZWxlY3RvcignI3NhdmVBdHQnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBib2R5ID0gT2Jq' +
  'ZWN0LmFzc2lnbih7CiAgICAgICAgb3V0Y29tZSwKICAgICAgICBhdHRlbXB0ZWRfYXQ6IGVsLnF1ZXJ5U2VsZWN0b3IoJyNhX3do' +
  'ZW4nKS52YWx1ZSB8fCBudWxsLAogICAgICAgIG5vdGVzOiBlbC5xdWVyeVNlbGVjdG9yKCcjYV9ub3RlcycpLnZhbHVlCiAgICAg' +
  'IH0sIGdwcyB8fCB7fSk7CiAgICAgIGlmIChvdXRjb21lID09PSAnU2VydmVkJykgewogICAgICAgIGJvZHkubWFubmVyID0gZWwu' +
  'cXVlcnlTZWxlY3RvcignI2FfbWFubmVyJykudmFsdWU7CiAgICAgICAgYm9keS5wZXJzb25fc2VydmVkID0gZWwucXVlcnlTZWxl' +
  'Y3RvcignI2FfcGVyc29uX3NlcnZlZCcpLnZhbHVlOwogICAgICAgIGJvZHkucmVsYXRpb25zaGlwID0gZWwucXVlcnlTZWxlY3Rv' +
  'cignI2FfcmVsYXRpb25zaGlwJykudmFsdWU7CiAgICAgICAgYm9keS5kZXNjcmlwdGlvbiA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNh' +
  'X2Rlc2NyaXB0aW9uJykudmFsdWU7CiAgICAgIH0KICAgICAgY29uc3Qgc2F2ZSA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNzYXZlQXR0' +
  'Jyk7CiAgICAgIGNvbnN0IHdhcyA9IHNhdmUudGV4dENvbnRlbnQ7CiAgICAgIHNhdmUuZGlzYWJsZWQgPSB0cnVlOwogICAgICB0' +
  'cnkgewogICAgICAgIGNvbnN0IGF0dCA9IGF3YWl0IGFwaSgnL2pvYnMvJyArIGpvYi5pZCArICcvYXR0ZW1wdHMnLCB7IG1ldGhv' +
  'ZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KTsKICAgICAgICAvKiBUaGUgYXR0ZW1wdCBpcyBzYXZlZCBh' +
  'dCB0aGlzIHBvaW50LiBJZiBhIHBob3RvIGZhaWxzIHRvIHVwbG9hZCBhZnRlcgogICAgICAgICAgIHRoYXQg4oCUIGRlYWQgc2ln' +
  'bmFsIGluIGEgZHJpdmV3YXkg4oCUIHRoZSBhdHRlbXB0IHN0aWxsIHN0YW5kcyBhbmQgdGhlCiAgICAgICAgICAgc2VydmVyIGlz' +
  'IHRvbGQgd2hpY2ggb25lcyB0byByZXRyeSBmcm9tIHRoZSBqb2Igc2NyZWVuLCByYXRoZXIgdGhhbgogICAgICAgICAgIGxvc2lu' +
  'ZyB0aGUgd2hvbGUgZW50cnkuICovCiAgICAgICAgbGV0IGZhaWxlZCA9IDA7CiAgICAgICAgaWYgKHBlbmRpbmcubGVuZ3RoKSB7' +
  'CiAgICAgICAgICB0cnkgewogICAgICAgICAgICBhd2FpdCB1cGxvYWRQaG90b3MoYXR0LmlkLCBwZW5kaW5nLAogICAgICAgICAg' +
  'ICAgIChuLCB0b3RhbCkgPT4geyBzYXZlLnRleHRDb250ZW50ID0gYFNlbmRpbmcgcGhvdG8gJHtufSBvZiAke3RvdGFsfeKApmA7' +
  'IH0pOwogICAgICAgICAgfSBjYXRjaCAoZSkgeyBmYWlsZWQgPSAxOyB9CiAgICAgICAgfQogICAgICAgIGNsb3NlU2hlZXQoKTsK' +
  'ICAgICAgICB0b2FzdChmYWlsZWQgPyAnQXR0ZW1wdCBzYXZlZCDigJQgYSBwaG90byBkaWQgbm90IHNlbmQsIGFkZCBpdCBhZ2Fp' +
  'biBmcm9tIHRoZSBqb2InCiAgICAgICAgICA6IG91dGNvbWUgPT09ICdTZXJ2ZWQnID8gJ1NlcnZlZCDigJQgam9iIGNsb3NlZCBv' +
  'dXQnIDogJ0F0dGVtcHQgbG9nZ2VkJywgISFmYWlsZWQpOwogICAgICAgIGdvKCdqb2InLCB7IGlkOiBqb2IuaWQgfSk7CiAgICAg' +
  'IH0gY2F0Y2ggKGUpIHsgc2F2ZS5kaXNhYmxlZCA9IGZhbHNlOyBzYXZlLnRleHRDb250ZW50ID0gd2FzOyB0b2FzdChlLm1lc3Nh' +
  'Z2UsIHRydWUpOyB9CiAgICB9OwogIH0pOwp9CgpmdW5jdGlvbiBsb2NhbE5vdygpIHsKICBjb25zdCBkID0gbmV3IERhdGUoRGF0' +
  'ZS5ub3coKSAtIG5ldyBEYXRlKCkuZ2V0VGltZXpvbmVPZmZzZXQoKSAqIDYwMDAwKTsKICByZXR1cm4gZC50b0lTT1N0cmluZygp' +
  'LnNsaWNlKDAsIDE2KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLSBhZmZpZGF2aXQgLS0gKi8KYXN5bmMgZnVuY3Rpb24gYWZmaWRhdml0U2hlZXQoam9iKSB7CiAgY29uc3QgdGVtcGxhdGVz' +
  'ID0gYXdhaXQgYXBpKCcvdGVtcGxhdGVzJyk7CiAgY29uc3QgbG9hZCA9IGFzeW5jIGlkID0+IHsKICAgIGNvbnN0IHIgPSBhd2Fp' +
  'dCBhcGkoJy9qb2JzLycgKyBqb2IuaWQgKyAnL2FmZmlkYXZpdCcgKyAoaWQgPyAnP3RlbXBsYXRlX2lkPScgKyBpZCA6ICcnKSk7' +
  'CiAgICByZXR1cm4gcjsKICB9OwogIGNvbnN0IGZpcnN0ID0gYXdhaXQgbG9hZCgpOwogIHNoZWV0KCdBZmZpZGF2aXQg4oCUICcg' +
  'KyBqb2Iuam9iX251bWJlciwgYAogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5UZW1wbGF0ZTwvbGFiZWw+PHNlbGVjdCBp' +
  'ZD0idHBsIj4KICAgICAgJHt0ZW1wbGF0ZXMubWFwKHQgPT4gYDxvcHRpb24gdmFsdWU9IiR7dC5pZH0iICR7dC5pZCA9PT0gZmly' +
  'c3QudGVtcGxhdGVfaWQgPyAnc2VsZWN0ZWQnIDogJyd9PiR7ZXNjKHQubmFtZSl9JHt0Lmp1cmlzZGljdGlvbiA/ICcg4oCUICcg' +
  'KyBlc2ModC5qdXJpc2RpY3Rpb24pIDogJyd9PC9vcHRpb24+YCkuam9pbignJyl9CiAgICA8L3NlbGVjdD48L2Rpdj4KICAgIDxw' +
  'cmUgY2xhc3M9InByZXYiIGlkPSJwcmV2Ij4ke2VzYyhmaXJzdC50ZXh0KX08L3ByZT4KICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5' +
  'bGU9Im1hcmdpbi10b3A6MTJweCI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InByaW50QWZmIj5QcmludCAvIHNhdmUg' +
  'UERGPC9idXR0b24+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIGlkPSJjb3B5QWZmIj5Db3B5IHRleHQ8L2J1dHRvbj4K' +
  'ICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5DbG9zZTwvYnV0dG9uPgogICAgPC9k' +
  'aXY+YCwgZWwgPT4gewogICAgY29uc3Qgc2VsID0gZWwucXVlcnlTZWxlY3RvcignI3RwbCcpOwogICAgc2VsLm9uY2hhbmdlID0g' +
  'YXN5bmMgKCkgPT4geyBlbC5xdWVyeVNlbGVjdG9yKCcjcHJldicpLnRleHRDb250ZW50ID0gKGF3YWl0IGxvYWQoc2VsLnZhbHVl' +
  'KSkudGV4dDsgfTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNwcmludEFmZicpLm9uY2xpY2sgPSAoKSA9PgogICAgICB3aW5kb3cu' +
  'b3BlbignL3ByaW50L2FmZmlkYXZpdC8nICsgam9iLmlkICsgJz90ZW1wbGF0ZV9pZD0nICsgc2VsLnZhbHVlLCAnX2JsYW5rJyk7' +
  'CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjY29weUFmZicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGF3YWl0IG5hdmln' +
  'YXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KGVsLnF1ZXJ5U2VsZWN0b3IoJyNwcmV2JykudGV4dENvbnRlbnQpOwogICAgICB0b2Fz' +
  'dCgnQ29waWVkJyk7CiAgICB9OwogIH0pOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLSB0b29scyAtLS0gKi8KLyogTGFiZWwgbWFrZXIuIFRoZSBwb2ludCBvZiB0aGUgc2hlZXQgZ3JpZCBp' +
  'cyB0aGF0IGxhYmVsIHNoZWV0cyBhcmUgZXhwZW5zaXZlCiAgIGFuZCByYXJlbHkgdXNlZCB1cCBpbiBvbmUgZ286IG1hcmsgd2hp' +
  'Y2ggb25lcyB5b3UndmUgYWxyZWFkeSBwZWVsZWQgb2ZmIGFuZAogICB0aGUgcHJpbnRlciBza2lwcyB0aGVtLCBzbyBhIHBhcnQt' +
  'dXNlZCBzaGVldCBnb2VzIGJhY2sgaW4gYW5kIGNhcnJpZXMgb24uICovCmFzeW5jIGZ1bmN0aW9uIHRvb2xzVmlldygpIHsKICBj' +
  'b25zdCBbbGF5b3V0cywgaW5pdFNoZWV0LCBqb2JzXSA9IGF3YWl0IFByb21pc2UuYWxsKFsKICAgIGFwaSgnL2xhYmVsLWxheW91' +
  'dHMnKSwgYXBpKCcvbGFiZWwtc2hlZXQnKSwgYXBpKCcvam9icz9vcGVuPTEnKQogIF0pOwogIFMuY2FjaGUuc2hlZXQgPSBpbml0' +
  'U2hlZXQ7CiAgUy5jYWNoZS5waWNrZWQgPSBTLmNhY2hlLnBpY2tlZCB8fCBbXTsKCiAgYXBwLmlubmVySFRNTCA9IHNoZWxsKGAK' +
  'ICAgIDxoMSBjbGFzcz0icGFnZSI+VG9vbHM8L2gxPgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+TGFiZWwgbWFr' +
  'ZXIgPHNwYW4gY2xhc3M9InN1YiI+cHJpbnRzIG9ubHkgdGhlIGxhYmVscyB5b3UgaGF2ZW4ndCB1c2VkPC9zcGFuPjwvaDI+Cgog' +
  'ICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkxhYmVsIHNoZWV0PC9sYWJlbD4KICAgICAgICA8c2VsZWN0IGlkPSJsYXlv' +
  'dXQiPgogICAgICAgICAgJHtsYXlvdXRzLm1hcChsID0+IGA8b3B0aW9uIHZhbHVlPSIke2wua2V5fSIgJHtsLmtleSA9PT0gaW5p' +
  'dFNoZWV0LmxheW91dCA/ICdzZWxlY3RlZCcgOiAnJ30+CiAgICAgICAgICAgICR7ZXNjKGwubmFtZSl9IOKAlCAke2VzYyhsLnNp' +
  'emUpfTwvb3B0aW9uPmApLmpvaW4oJycpfQogICAgICAgIDwvc2VsZWN0PgogICAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPk9mZmlj' +
  'ZSBEZXBvdCBzaGVldHMgcHJpbnQgYW4gQXZlcnkgZXF1aXZhbGVudCBudW1iZXIgb24gdGhlIHBhY2thZ2UgZnJvbnQg4oCUCiAg' +
  'ICAgICAgICBtYXRjaCB0aGF0LiBDaGFuZ2luZyB0aGUgc2hlZXQgY2xlYXJzIHRoZSB1c2VkIG1hcmtzLCBzaW5jZSBwb3NpdGlv' +
  'biA3IG9uIGEgMzAtdXAgc2hlZXQKICAgICAgICAgIGlzbid0IHBvc2l0aW9uIDcgb24gYSAxMC11cCBvbmUuPC9kaXY+CiAgICAg' +
  'IDwvZGl2PgoKICAgICAgPGxhYmVsPldoaWNoIGxhYmVscyBhcmUgYWxyZWFkeSBnb25lPzwvbGFiZWw+CiAgICAgIDxkaXYgY2xh' +
  'c3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tYm90dG9tOjhweCI+VGFwIHRoZSBvbmVzIGFscmVhZHkgcGVlbGVkIG9mZi4gR3JleSA9' +
  'IHVzZWQgYW5kIHNraXBwZWQuCiAgICAgICAgTnVtYmVyZWQgZ3JlZW4gPSB3aGVyZSB5b3VyIG5leHQgbGFiZWxzIHdpbGwgbGFu' +
  'ZCwgaW4gb3JkZXIuPC9kaXY+CiAgICAgIDxkaXYgaWQ9ImdyaWQiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxl' +
  'PSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxzcGFuIGNsYXNzPSJwaWxsIiBpZD0iZnJlZUNvdW50Ij48L3NwYW4+CiAgICAg' +
  'ICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9Im5ld1NoZWV0Ij5GcmVzaCBzaGVldDwvYnV0dG9uPgogICAgICAgIDxi' +
  'dXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJhbGxVc2VkIj5NYXJrIGFsbCB1c2VkPC9idXR0b24+CiAgICAgIDwvZGl2Pgog' +
  'ICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5XaG8gdG8gcHJpbnQgPHNwYW4gY2xhc3M9InN1YiIg' +
  'aWQ9InBpY2tDb3VudCI+PC9zcGFuPjwvaDI+CiAgICAgIDxpbnB1dCBpZD0iam9iRmlsdGVyIiBwbGFjZWhvbGRlcj0iRmlsdGVy' +
  'IGJ5IG5hbWUsIGNpdHkgb3Igam9iIG51bWJlciIgc3R5bGU9Im1hcmdpbi1ib3R0b206OHB4Ij4KICAgICAgPGRpdiBjbGFzcz0i' +
  'bGlzdCIgaWQ9ImpvYlBpY2siIHN0eWxlPSJtYXgtaGVpZ2h0OjMyMHB4O292ZXJmbG93OmF1dG8iPgogICAgICAgICR7am9icy5s' +
  'ZW5ndGggPyBqb2JzLm1hcChqID0+IGAKICAgICAgICAgIDxkaXYgY2xhc3M9Iml0ZW0iIGRhdGEtcGljaz0iJHtqLmlkfSI+CiAg' +
  'ICAgICAgICAgIDxkaXYgY2xhc3M9InIiPjxkaXY+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0idCI+JHtlc2Moai5yZWNpcGll' +
  'bnRfbmFtZSl9PC9kaXY+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibSI+JHtlc2Moai5qb2JfbnVtYmVyKX0gwrcgJHtlc2Mo' +
  'W2ouYWRkcmVzczEsIGouY2l0eV0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJywgJykgfHwgJ25vIGFkZHJlc3MnKX08L2Rpdj4KICAg' +
  'ICAgICAgICAgPC9kaXY+PHNwYW4gY2xhc3M9InBpbGwiIGRhdGEtdGljaz0iJHtqLmlkfSI+YWRkPC9zcGFuPjwvZGl2PgogICAg' +
  'ICAgICAgPC9kaXY+YCkuam9pbignJykKICAgICAgICAgIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij5ObyBvcGVuIGpvYnMgdG8gbGFi' +
  'ZWwuPC9kaXY+J30KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPlByaW50' +
  'PC9oMj4KICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJwcmludEJ0biIgZGlz' +
  'YWJsZWQ+UHJpbnQgbGFiZWxzPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9InRlc3RCdG4i' +
  'PkFsaWdubWVudCB0ZXN0PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2lu' +
  'LXRvcDo4cHgiPkluIHRoZSBwcmludCBkaWFsb2cgc2V0IHNjYWxlIHRvIDxiPjEwMCU8L2I+IGFuZCB0dXJuIG9mZgogICAgICAg' +
  'ICJmaXQgdG8gcGFnZSIg4oCUIHNjYWxpbmcgaXMgd2hhdCB0aHJvd3MgbGFiZWwgYWxpZ25tZW50IG9mZi48L2Rpdj4KCiAgICAg' +
  'IDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij48bGFiZWw+TnVkZ2UsIGlmIHlvdXIgcHJpbnRlciBy' +
  'dW5zIG9mZjwvbGFiZWw+CiAgICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJoaW50IiBzdHls' +
  'ZT0ibWFyZ2luOjAiPlJpZ2h0PC9zcGFuPgogICAgICAgICAgPGlucHV0IGlkPSJvZmZYIiB0eXBlPSJudW1iZXIiIHN0ZXA9IjAu' +
  'MDEiIG1pbj0iLTAuNSIgbWF4PSIwLjUiIHZhbHVlPSIke2luaXRTaGVldC5vZmZzZXRfeH0iIHN0eWxlPSJ3aWR0aDo5MHB4Ij4K' +
  'ICAgICAgICAgIDxzcGFuIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjAiPkRvd248L3NwYW4+CiAgICAgICAgICA8aW5wdXQg' +
  'aWQ9Im9mZlkiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgbWluPSItMC41IiBtYXg9IjAuNSIgdmFsdWU9IiR7aW5pdFNoZWV0' +
  'Lm9mZnNldF95fSIgc3R5bGU9IndpZHRoOjkwcHgiPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9InNh' +
  'dmVPZmYiPlNhdmU8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoaW50Ij5JbmNoZXMuIFByaW50' +
  'IHRoZSBhbGlnbm1lbnQgdGVzdCBvbiBwbGFpbiBwYXBlciwgaG9sZCBpdCBhZ2FpbnN0IGEgcmVhbCBzaGVldCwKICAgICAgICAg' +
  'IGFuZCBudWRnZSB1bnRpbCB0aGUgYm94ZXMgbGluZSB1cC48L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj5gKTsKICBiaW5k' +
  'U2hlbGwoKTsKCiAgY29uc3QgbGF5b3V0TWV0YSA9ICgpID0+IGxheW91dHMuZmluZChsID0+IGwua2V5ID09PSBTLmNhY2hlLnNo' +
  'ZWV0LmxheW91dCkgfHwgbGF5b3V0c1swXTsKCiAgZnVuY3Rpb24gZHJhd0dyaWQoKSB7CiAgICBjb25zdCBtZXRhID0gbGF5b3V0' +
  'TWV0YSgpOwogICAgY29uc3QgcyA9IFMuY2FjaGUuc2hlZXQ7CiAgICBjb25zdCB1c2VkID0gbmV3IFNldChzLnVzZWQubWFwKE51' +
  'bWJlcikpOwogICAgY29uc3QgZnJlZSA9IFtdOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBtZXRhLmNhcGFjaXR5OyBpKyspIGlm' +
  'ICghdXNlZC5oYXMoaSkpIGZyZWUucHVzaChpKTsKICAgIGNvbnN0IG9yZGVyID0gbmV3IE1hcChmcmVlLnNsaWNlKDAsIFMuY2Fj' +
  'aGUucGlja2VkLmxlbmd0aCkubWFwKChwb3MsIG4pID0+IFtwb3MsIG4gKyAxXSkpOwoKICAgICQoJyNncmlkJykuaW5uZXJIVE1M' +
  'ID0gYDxkaXYgY2xhc3M9ImxncmlkIiBzdHlsZT0iZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgke21ldGEuY29sc30sMWZy' +
  'KSI+YCArCiAgICAgIEFycmF5LmZyb20oeyBsZW5ndGg6IG1ldGEuY2FwYWNpdHkgfSwgKF8sIGkpID0+IHsKICAgICAgICBjb25z' +
  'dCBpc1VzZWQgPSB1c2VkLmhhcyhpKTsKICAgICAgICBjb25zdCBuID0gb3JkZXIuZ2V0KGkpOwogICAgICAgIHJldHVybiBgPGJ1' +
  'dHRvbiBjbGFzcz0ibGNlbGwke2lzVXNlZCA/ICcgdXNlZCcgOiAnJ30ke24gPyAnIG5leHQnIDogJyd9IiBkYXRhLWNlbGw9IiR7' +
  'aX0iCiAgICAgICAgICB0aXRsZT0iUG9zaXRpb24gJHtpICsgMX0iPiR7aXNVc2VkID8gJ8OXJyA6IChuIHx8ICcnKX08L2J1dHRv' +
  'bj5gOwogICAgICB9KS5qb2luKCcnKSArICc8L2Rpdj4nOwoKICAgICQoJyNmcmVlQ291bnQnKS50ZXh0Q29udGVudCA9IGZyZWUu' +
  'bGVuZ3RoICsgJyBvZiAnICsgbWV0YS5jYXBhY2l0eSArICcgbGVmdCc7CiAgICAkKCcjcGlja0NvdW50JykudGV4dENvbnRlbnQg' +
  'PSBTLmNhY2hlLnBpY2tlZC5sZW5ndGggKyAnIHNlbGVjdGVkJzsKICAgIGNvbnN0IG92ZXIgPSBTLmNhY2hlLnBpY2tlZC5sZW5n' +
  'dGggPiBmcmVlLmxlbmd0aDsKICAgIGNvbnN0IGJ0biA9ICQoJyNwcmludEJ0bicpOwogICAgYnRuLmRpc2FibGVkID0gIVMuY2Fj' +
  'aGUucGlja2VkLmxlbmd0aDsKICAgIGJ0bi50ZXh0Q29udGVudCA9IG92ZXIKICAgICAgPyBgUHJpbnQgJHtmcmVlLmxlbmd0aH0g' +
  'bm93ICgke1MuY2FjaGUucGlja2VkLmxlbmd0aCAtIGZyZWUubGVuZ3RofSB3b24ndCBmaXQpYAogICAgICA6IGBQcmludCAke1Mu' +
  'Y2FjaGUucGlja2VkLmxlbmd0aH0gbGFiZWwke1MuY2FjaGUucGlja2VkLmxlbmd0aCA9PT0gMSA/ICcnIDogJ3MnfWA7CgogICAg' +
  'ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtY2VsbF0nKS5mb3JFYWNoKGMgPT4gYy5vbmNsaWNrID0gYXN5bmMgKCkg' +
  'PT4gewogICAgICBjb25zdCBpID0gK2MuZGF0YXNldC5jZWxsOwogICAgICBjb25zdCBzZXQgPSBuZXcgU2V0KFMuY2FjaGUuc2hl' +
  'ZXQudXNlZC5tYXAoTnVtYmVyKSk7CiAgICAgIHNldC5oYXMoaSkgPyBzZXQuZGVsZXRlKGkpIDogc2V0LmFkZChpKTsKICAgICAg' +
  'YXdhaXQgc2F2ZVNoZWV0KHsgdXNlZDogWy4uLnNldF0gfSk7CiAgICB9KTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHNhdmVTaGVl' +
  'dChwYXRjaCkgewogICAgdHJ5IHsKICAgICAgUy5jYWNoZS5zaGVldCA9IGF3YWl0IGFwaSgnL2xhYmVsLXNoZWV0JywgeyBtZXRo' +
  'b2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHBhdGNoKSB9KTsKICAgICAgZHJhd0dyaWQoKTsKICAgIH0gY2F0Y2gg' +
  'KGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH0KCiAgJCgnI2xheW91dCcpLm9uY2hhbmdlID0gZSA9PiBzYXZlU2hl' +
  'ZXQoeyBsYXlvdXQ6IGUudGFyZ2V0LnZhbHVlIH0pOwogICQoJyNuZXdTaGVldCcpLm9uY2xpY2sgPSAoKSA9PiBzYXZlU2hlZXQo' +
  'eyB1c2VkOiBbXSB9KTsKICAkKCcjYWxsVXNlZCcpLm9uY2xpY2sgPSAoKSA9PgogICAgc2F2ZVNoZWV0KHsgdXNlZDogQXJyYXku' +
  'ZnJvbSh7IGxlbmd0aDogbGF5b3V0TWV0YSgpLmNhcGFjaXR5IH0sIChfLCBpKSA9PiBpKSB9KTsKICAkKCcjc2F2ZU9mZicpLm9u' +
  'Y2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBhd2FpdCBzYXZlU2hlZXQoeyBvZmZzZXRfeDogTnVtYmVyKCQoJyNvZmZYJykudmFs' +
  'dWUpIHx8IDAsIG9mZnNldF95OiBOdW1iZXIoJCgnI29mZlknKS52YWx1ZSkgfHwgMCB9KTsKICAgIHRvYXN0KCdBbGlnbm1lbnQg' +
  'c2F2ZWQnKTsKICB9OwoKICBjb25zdCBwYWludCA9ICgpID0+IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXRpY2td' +
  'JykuZm9yRWFjaCh0ID0+IHsKICAgIGNvbnN0IG9uID0gUy5jYWNoZS5waWNrZWQuaW5jbHVkZXMoK3QuZGF0YXNldC50aWNrKTsK' +
  'ICAgIHQudGV4dENvbnRlbnQgPSBvbiA/ICfinJMgYWRkZWQnIDogJ2FkZCc7CiAgICB0LmNsYXNzTmFtZSA9IG9uID8gJ3BpbGwg' +
  'U2VydmVkJyA6ICdwaWxsJzsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1waWNrXScpLmZvckVhY2go' +
  'cm93ID0+IHJvdy5vbmNsaWNrID0gKCkgPT4gewogICAgY29uc3QgaWQgPSArcm93LmRhdGFzZXQucGljazsKICAgIGNvbnN0IGkg' +
  'PSBTLmNhY2hlLnBpY2tlZC5pbmRleE9mKGlkKTsKICAgIGkgPT09IC0xID8gUy5jYWNoZS5waWNrZWQucHVzaChpZCkgOiBTLmNh' +
  'Y2hlLnBpY2tlZC5zcGxpY2UoaSwgMSk7CiAgICBwYWludCgpOyBkcmF3R3JpZCgpOwogIH0pOwogICQoJyNqb2JGaWx0ZXInKS5v' +
  'bmlucHV0ID0gZSA9PiB7CiAgICBjb25zdCB2ID0gZS50YXJnZXQudmFsdWUudG9Mb3dlckNhc2UoKTsKICAgIGRvY3VtZW50LnF1' +
  'ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBpY2tdJykuZm9yRWFjaChyID0+IHsKICAgICAgci5zdHlsZS5kaXNwbGF5ID0gci5pbm5l' +
  'clRleHQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyh2KSA/ICcnIDogJ25vbmUnOwogICAgfSk7CiAgfTsKCiAgJCgnI3Rlc3RCdG4n' +
  'KS5vbmNsaWNrID0gKCkgPT4gewogICAgY29uc3QgaWRzID0gUy5jYWNoZS5waWNrZWQubGVuZ3RoID8gUy5jYWNoZS5waWNrZWQg' +
  'OiAoam9ic1swXSA/IFtqb2JzWzBdLmlkXSA6IFtdKTsKICAgIGlmICghaWRzLmxlbmd0aCkgcmV0dXJuIHRvYXN0KCdBZGQgYXQg' +
  'bGVhc3Qgb25lIGpvYiBmaXJzdCcsIHRydWUpOwogICAgd2luZG93Lm9wZW4oJy9wcmludC9sYWJlbHM/Z3VpZGVzPTEmaWRzPScg' +
  'KyBpZHMuam9pbignLCcpLCAnX2JsYW5rJyk7CiAgfTsKCiAgJCgnI3ByaW50QnRuJykub25jbGljayA9ICgpID0+IHsKICAgIGNv' +
  'bnN0IG1ldGEgPSBsYXlvdXRNZXRhKCk7CiAgICBjb25zdCB1c2VkID0gbmV3IFNldChTLmNhY2hlLnNoZWV0LnVzZWQubWFwKE51' +
  'bWJlcikpOwogICAgY29uc3QgZnJlZSA9IFtdOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBtZXRhLmNhcGFjaXR5OyBpKyspIGlm' +
  'ICghdXNlZC5oYXMoaSkpIGZyZWUucHVzaChpKTsKICAgIGNvbnN0IHdpbGxVc2UgPSBmcmVlLnNsaWNlKDAsIFMuY2FjaGUucGlj' +
  'a2VkLmxlbmd0aCk7CiAgICB3aW5kb3cub3BlbignL3ByaW50L2xhYmVscz9pZHM9JyArIFMuY2FjaGUucGlja2VkLmpvaW4oJywn' +
  'KSwgJ19ibGFuaycpOwoKICAgIGNvbmZpcm1QcmludGVkKHdpbGxVc2UpOwogIH07CgogIGZ1bmN0aW9uIGNvbmZpcm1QcmludGVk' +
  'KHdpbGxVc2UpIHsKICAgIHNoZWV0KCdEaWQgdGhleSBwcmludD8nLCBgCiAgICAgIDxwIGNsYXNzPSJoaW50Ij5Pbmx5IG1hcmsg' +
  'dGhlc2UgdXNlZCBvbmNlIHRoZSBzaGVldCBhY3R1YWxseSBjYW1lIG91dCByaWdodCDigJQgaWYgdGhlIHByaW50ZXIKICAgICAg' +
  'ICBqYW1tZWQgb3IgdGhlIGFsaWdubWVudCB3YXMgb2ZmLCBzYXkgbm8gYW5kIG5vdGhpbmcgY2hhbmdlcy48L3A+CiAgICAgIDxw' +
  'PjxiPiR7d2lsbFVzZS5sZW5ndGh9PC9iPiBwb3NpdGlvbiR7d2lsbFVzZS5sZW5ndGggPT09IDEgPyAnJyA6ICdzJ30gd291bGQg' +
  'YmUgbWFya2VkIHVzZWQ6CiAgICAgICAgJHt3aWxsVXNlLm1hcChpID0+IGkgKyAxKS5qb2luKCcsICcpfTwvcD4KICAgICAgPGRp' +
  'diBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gb2siIGlkPSJ5' +
  'ZXNVc2VkIj5ZZXMg4oCUIG1hcmsgdGhlbSB1c2VkPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25j' +
  'bGljaz0iY2xvc2VTaGVldCgpIj5Obywga2VlcCB0aGVtIGZyZWU8L2J1dHRvbj4KICAgICAgPC9kaXY+YCwgZWwgPT4gewogICAg' +
  'ICBlbC5xdWVyeVNlbGVjdG9yKCcjeWVzVXNlZCcpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgICAgY29uc3Qgc2V0ID0g' +
  'bmV3IFNldChTLmNhY2hlLnNoZWV0LnVzZWQubWFwKE51bWJlcikpOwogICAgICAgIHdpbGxVc2UuZm9yRWFjaChpID0+IHNldC5h' +
  'ZGQoaSkpOwogICAgICAgIGF3YWl0IHNhdmVTaGVldCh7IHVzZWQ6IFsuLi5zZXRdIH0pOwogICAgICAgIFMuY2FjaGUucGlja2Vk' +
  'ID0gW107CiAgICAgICAgY2xvc2VTaGVldCgpOwogICAgICAgIHRvYXN0KCdTaGVldCB1cGRhdGVkIOKAlCAnICsgUy5jYWNoZS5z' +
  'aGVldC5mcmVlICsgJyBsYWJlbHMgbGVmdCcpOwogICAgICAgIGdvKCd0b29scycpOwogICAgICB9OwogICAgfSk7CiAgfQoKICBw' +
  'YWludCgpOwogIGRyYXdHcmlkKCk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0gcHJvcGVydHkgc2VhcmNoIC0tICovCi8qIFR3byBkaWZmZXJlbnQgcmVjb3JkcyBzeXN0ZW1zLCBhbmQgdGhlIGRpZmZl' +
  'cmVuY2UgbWF0dGVyczoKICAgdGhlIGNvdW50eSBDTEVSSyBob2xkcyBkZWVkcyBhbmQgbGllbnMgKHdobyBib3VnaHQsIHNvbGQs' +
  'IG9yIGhhcyBhIGNsYWltKSwKICAgdGhlIEFQUFJBSVNBTCBESVNUUklDVCBob2xkcyB3aG8gb3ducyBpdCBub3cgYW5kIHdoZXJl' +
  'IHRoZWlyIHRheCBiaWxsIGlzCiAgIHBvc3RlZCAtLSB3aGljaCBpcyB1c3VhbGx5IHRoZSBiZXR0ZXIgbGVhZCB3aGVuIGFuIGFk' +
  'ZHJlc3MgaGFzIGdvbmUgc3RhbGUuICovCmNvbnN0IENPVU5USUVTID0gWwogIHsKICAgIG5hbWU6ICdIaWRhbGdvIENvdW50eScs' +
  'CiAgICBjbGVyazogeyB1cmw6ICdodHRwczovL2hpZGFsZ28udHgucHVibGljc2VhcmNoLnVzLycsIG5vdGU6ICdEZWVkcywgbGll' +
  'bnMsIHRyYW5zZmVycy4gR3JhbnRvci9ncmFudGVlLCBkb2MgbnVtYmVyLCBmdWxsLXRleHQgT0NSLiBObyBsb2dpbi4nIH0sCiAg' +
  'ICBjYWQ6IHsgdXJsOiAnaHR0cHM6Ly9oaWRhbGdvLnByb2RpZ3ljYWQuY29tL3Byb3BlcnR5LXNlYXJjaCcsIG5vdGU6ICdDdXJy' +
  'ZW50IG93bmVyLCBtYWlsaW5nIGFkZHJlc3MsIHNpdHVzIGFkZHJlc3MsIHZhbHVhdGlvbi4nIH0sCiAgICBjYWRBbHQ6IHsgdXJs' +
  'OiAnaHR0cHM6Ly9wcm9wYWNjZXNzLmhpZGFsZ29hZC5vcmcvQ2xpZW50REIvUHJvcGVydHlTZWFyY2guYXNweD9jaWQ9MScsIG5v' +
  'dGU6ICdPbGRlciBIaWRhbGdvIENBRCBzZWFyY2gsIGlmIHRoZSBuZXcgb25lIGlzIGRvd24uJyB9CiAgfSwKICB7CiAgICBuYW1l' +
  'OiAnQ2FtZXJvbiBDb3VudHknLAogICAgY2xlcms6IHsgdXJsOiAnaHR0cHM6Ly9jYW1lcm9uLnR4LnB1YmxpY3NlYXJjaC51cy8n' +
  'LCBub3RlOiAnRGVlZHMsIGxpZW5zLCB0cmFuc2ZlcnMsIGZvcmVjbG9zdXJlIHBvc3RpbmdzLiBObyBsb2dpbi4nIH0sCiAgICBj' +
  'YWQ6IHsgdXJsOiAnaHR0cHM6Ly9jYW1lcm9uLnByb2RpZ3ljYWQuY29tLycsIG5vdGU6ICdDdXJyZW50IG93bmVyLCBtYWlsaW5n' +
  'IGFkZHJlc3MsIHNpdHVzIGFkZHJlc3MsIHZhbHVhdGlvbi4nIH0sCiAgICBjYWRBbHQ6IHsgdXJsOiAnaHR0cDovL3Byb3BhY2Nl' +
  'c3MuY2FtZXJvbmNhZC5vcmcvY2xpZW50ZGIvUHJvcGVydHlTZWFyY2guYXNweD9jaWQ9MScsIG5vdGU6ICdPbGRlciBDYW1lcm9u' +
  'IENBRCBzZWFyY2gsIGlmIHRoZSBuZXcgb25lIGlzIGRvd24uJyB9CiAgfSwKICB7CiAgICBuYW1lOiAnU3RhcnIgQ291bnR5JywK' +
  'ICAgIGNsZXJrOiB7IHVybDogJ2h0dHBzOi8vc3RhcnIudHgucHVibGljc2VhcmNoLnVzLycsIG5vdGU6ICdEZWVkcywgbGllbnMs' +
  'IHRyYW5zZmVycy4gU2FtZSBzeXN0ZW0gYXMgSGlkYWxnbyBhbmQgQ2FtZXJvbi4nIH0sCiAgICBjYWQ6IHsgdXJsOiAnaHR0cHM6' +
  'Ly9lc2VhcmNoLnN0YXJyY2FkLm9yZy8nLCBub3RlOiAnQ3VycmVudCBvd25lciwgbWFpbGluZyBhZGRyZXNzLCBzaXR1cyBhZGRy' +
  'ZXNzLicgfQogIH0KXTsKCmZ1bmN0aW9uIHByb3BlcnR5VmlldygpIHsKICBjb25zdCByb3dzID0gQ09VTlRJRVMubWFwKChjLCBj' +
  'aSkgPT4gYAogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj4ke2VzYyhjLm5hbWUpfTwvaDI+CiAgICAgIDxkaXYgY2xh' +
  'c3M9Imxpc3QiPgogICAgICAgIDxkaXYgY2xhc3M9Iml0ZW0iIGRhdGEtcHJvcD0iJHtjaX06Y2FkIj4KICAgICAgICAgIDxkaXYg' +
  'Y2xhc3M9InQiPkFwcHJhaXNhbCBkaXN0cmljdCDigJQgd2hvIG93bnMgaXQgbm93PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNz' +
  'PSJtIj4ke2VzYyhjLmNhZC5ub3RlKX08L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJpdGVtIiBkYXRh' +
  'LXByb3A9IiR7Y2l9OmNsZXJrIj4KICAgICAgICAgIDxkaXYgY2xhc3M9InQiPkNvdW50eSBjbGVyayDigJQgZGVlZHMgJmFtcDsg' +
  'bGllbnM8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9Im0iPiR7ZXNjKGMuY2xlcmsubm90ZSl9PC9kaXY+CiAgICAgICAgPC9k' +
  'aXY+CiAgICAgICAgJHtjLmNhZEFsdCA/IGA8ZGl2IGNsYXNzPSJpdGVtIiBkYXRhLXByb3A9IiR7Y2l9OmNhZEFsdCI+CiAgICAg' +
  'ICAgICA8ZGl2IGNsYXNzPSJ0Ij5BcHByYWlzYWwgZGlzdHJpY3QgKG9sZGVyIHNlYXJjaCk8L2Rpdj4KICAgICAgICAgIDxkaXYg' +
  'Y2xhc3M9Im0iPiR7ZXNjKGMuY2FkQWx0Lm5vdGUpfTwvZGl2PgogICAgICAgIDwvZGl2PmAgOiAnJ30KICAgICAgPC9kaXY+CiAg' +
  'ICA8L2Rpdj5gKS5qb2luKCcnKTsKCiAgYXBwLmlubmVySFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFnZSI+UHJvcGVy' +
  'dHkgcmVjb3JkczwvaDE+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGxhYmVsPk5hbWUgb3IgYWRkcmVzcyB0byBsb29r' +
  'IHVwPC9sYWJlbD4KICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgICA8aW5wdXQgaWQ9InByb3BRIiBwbGFjZWhvbGRlcj0i' +
  'R0FSWkEgTUFSSUEgIG9yICAxMjA0IEUgTWFpbiBTdCIgc3R5bGU9ImZsZXg6MTttaW4td2lkdGg6MTYwcHgiPgogICAgICAgIDxi' +
  'dXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9InByb3BDb3B5Ij5Db3B5PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8cCBjbGFz' +
  'cz0iaGludCI+VGhlc2Ugc2l0ZXMgY2FuJ3QgYmUgbGlua2VkIHRvIHdpdGggYSBzZWFyY2ggdGVybSwgc28gdGFwcGluZyBvbmUg' +
  'Y29waWVzIHdoYXQgeW91IHR5cGVkCiAgICAgICAgYW5kIG9wZW5zIHRoZWlyIHNlYXJjaCBwYWdlIOKAlCBwYXN0ZSBpdCBpbnRv' +
  'IHRoZWlyIGJveC48L3A+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDojZjhmYWZj' +
  'O2JveC1zaGFkb3c6bm9uZSI+CiAgICAgIDxoMj5XaGljaCBvbmUgZG8geW91IHdhbnQ/PC9oMj4KICAgICAgPHAgY2xhc3M9Imhp' +
  'bnQiIHN0eWxlPSJtYXJnaW46MCI+CiAgICAgICAgPGI+QXBwcmFpc2FsIGRpc3RyaWN0PC9iPiDigJQgY3VycmVudCBvd25lciBh' +
  'bmQgdGhlIG1haWxpbmcgYWRkcmVzcyB0aGUgdGF4IGJpbGwgZ29lcyB0by4gQmVzdCBmb3IKICAgICAgICBjb25maXJtaW5nIHRo' +
  'ZSBwZXJzb24gb24geW91ciBwYXBlcnMgaXMgdGllZCB0byB0aGUgYWRkcmVzcywgYW5kIGZvciBmaW5kaW5nIHNvbWV3aGVyZSBl' +
  'bHNlIHRvIHRyeS48YnI+PGJyPgogICAgICAgIDxiPkNvdW50eSBjbGVyazwvYj4g4oCUIGRlZWRzLCBsaWVucyBhbmQgdHJhbnNm' +
  'ZXJzLiBCZXN0IGZvciBoaXN0b3J5OiB3aG8gc29sZCBpdCwgd2hlbiwgYW5kIHdobyBob2xkcyBhIGNsYWltLgogICAgICAgIFdv' +
  'bid0IHJlbGlhYmx5IHRlbGwgeW91IHdobyBsaXZlcyB0aGVyZSBub3cuPC9wPgogICAgPC9kaXY+CgogICAgJHtyb3dzfQoKICAg' +
  'IDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbjowIj5BIG1haWxpbmcgYWRkcmVz' +
  'cyBmcm9tIHRoZSBhcHByYWlzYWwgZGlzdHJpY3QgaXMgYSBsZWFkLCBub3QgcHJvb2Ygb2YKICAgICAgICByZXNpZGVuY2Ug4oCU' +
  'IHBsZW50eSBvZiBvd25lcnMgaGF2ZSBwb3N0IGdvbmUgdG8gYW4gYWdlbnQsIGEgcmVsYXRpdmUsIG9yIGFub3RoZXIgc3RhdGUu' +
  'IFRyZWF0IGl0IGFzIGEKICAgICAgICBwbGFjZSB0byBhdHRlbXB0LCBhbmQgcmVjb3JkIHdoYXQgeW91IGFjdHVhbGx5IGZpbmQg' +
  'aW4gdGhlIGF0dGVtcHQgbm90ZXMuPC9wPgogICAgPC9kaXY+YCk7CiAgYmluZFNoZWxsKCk7CgogIGNvbnN0IGNvcHlUZXJtID0g' +
  'YXN5bmMgKCkgPT4gewogICAgY29uc3QgdiA9ICQoJyNwcm9wUScpLnZhbHVlLnRyaW0oKTsKICAgIGlmICghdikgcmV0dXJuIGZh' +
  'bHNlOwogICAgdHJ5IHsgYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQodik7IHJldHVybiB0cnVlOyB9IGNhdGNo' +
  'IChlKSB7IHJldHVybiBmYWxzZTsgfQogIH07CiAgJCgnI3Byb3BDb3B5Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIGNv' +
  'bnN0IHYgPSAkKCcjcHJvcFEnKS52YWx1ZS50cmltKCk7CiAgICBpZiAoIXYpIHJldHVybiB0b2FzdCgnVHlwZSBhIG5hbWUgb3Ig' +
  'YWRkcmVzcyBmaXJzdCcsIHRydWUpOwogICAgdG9hc3QoYXdhaXQgY29weVRlcm0oKSA/ICdDb3BpZWQgIicgKyB2ICsgJyInIDog' +
  'J0NvcHkgZmFpbGVkIOKAlCBzZWxlY3QgaXQgYnkgaGFuZCcpOwogIH07CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2Rh' +
  'dGEtcHJvcF0nKS5mb3JFYWNoKHJvdyA9PiByb3cub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIGNvbnN0IFtjaSwgd2hpY2hd' +
  'ID0gcm93LmRhdGFzZXQucHJvcC5zcGxpdCgnOicpOwogICAgY29uc3QgdGFyZ2V0ID0gQ09VTlRJRVNbK2NpXVt3aGljaF07CiAg' +
  'ICBjb25zdCBoYWQgPSAkKCcjcHJvcFEnKS52YWx1ZS50cmltKCk7CiAgICBjb25zdCBvayA9IGhhZCA/IGF3YWl0IGNvcHlUZXJt' +
  'KCkgOiBmYWxzZTsKICAgIHRvYXN0KG9rID8gJ0NvcGllZCAiJyArIGhhZCArICciIOKAlCBwYXN0ZSBpdCBpbnRvIHRoZWlyIHNl' +
  'YXJjaCcgOiAnT3BlbmluZyAnICsgQ09VTlRJRVNbK2NpXS5uYW1lKTsKICAgIHdpbmRvdy5vcGVuKHRhcmdldC51cmwsICdfYmxh' +
  'bmsnKTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g' +
  'Y2FzZSBsb29rdXAgLS0gKi8KLyogTm9uZSBvZiB0aGVzZSBwb3J0YWxzIGFjY2VwdCBhIGNhc2UgbnVtYmVyIGluIHRoZSBVUkwg' +
  'LS0gSGlkYWxnbydzIHJ1bnMgb24KICAgc2Vzc2lvbi1iYXNlZCBmb3JtIHBvc3RzLCBDYW1lcm9uJ3Mgc2l0cyBiZWhpbmQgYSBK' +
  'YXZhU2NyaXB0IGdhdGUuIFNvIHRoaXMKICAgY29waWVzIHRoZSBudW1iZXIgdG8gdGhlIGNsaXBib2FyZCBhbmQgb3BlbnMgdGhl' +
  'IHJpZ2h0IHNlYXJjaCBwYWdlLiBObwogICBzY3JhcGluZywgbm90aGluZyB0byBicmVhayB3aGVuIHRoZXkgcmVkZXNpZ24uICov' +
  'CmNvbnN0IFRYX1BPUlRBTFMgPSBbCiAgeyBuYW1lOiAncmU6U2VhcmNoVFgg4oCUIHN0YXRld2lkZScsIHVybDogJ2h0dHBzOi8v' +
  'cmVzZWFyY2gudHhjb3VydHMuZ292LycsCiAgICBub3RlOiAnRnJlZSBhY2NvdW50IHJlcXVpcmVkLiBEaXN0cmljdCwgY291bnR5' +
  'IGFuZCBwcm9iYXRlIGNvdXJ0cyBpbiBhbGwgMjU0IGNvdW50aWVzLiAnICsKICAgICAgICAgICdQdWJsaWMgdmlldyBzdGFydHMg' +
  'YXQgZmlsaW5ncyBmcm9tIDEgTm92IDIwMTguIEp1c3RpY2Utb2YtdGhlLXBlYWNlIGV2aWN0aW9ucyBhcmUgcGF0Y2h5LicgfSwK' +
  'ICB7IG5hbWU6ICdIaWRhbGdvIENvdW50eSDigJQgRGlzdHJpY3QgQ2xlcmsgY2FzZSBzZWFyY2gnLCB1cmw6ICdodHRwczovL3Bh' +
  'LmNvLmhpZGFsZ28udHgudXMvZGVmYXVsdC5hc3B4JywKICAgIG5vdGU6ICdDaXZpbCBhbmQgY3JpbWluYWwgY2FzZXMuIEZyZWUs' +
  'IG5vIGxvZ2luLicgfSwKICB7IG5hbWU6ICdDYW1lcm9uIENvdW50eSDigJQgY291cnQgcG9ydGFscycsIHVybDogJ2h0dHBzOi8v' +
  'd3d3LmNhbWVyb25jb3VudHl0eC5nb3YvY2FtZXJvbi1jb3VudHktcG9ydGFscy8nLAogICAgbm90ZTogJ0luZGV4IHBhZ2UgZm9y' +
  'IHRoZSBjb3VudHlcJ3MgZGlzdHJpY3QgYW5kIGNvdW50eSBjbGVyayBzZWFyY2hlcy4nIH0sCiAgeyBuYW1lOiAnQ2FtZXJvbiBD' +
  'b3VudHkg4oCUIERpc3RyaWN0IENsZXJrIHJlY29yZHMnLCB1cmw6ICdodHRwczovL2tvZmlsZXF1aWNrbGlua3MuY29tL2NhbWVy' +
  'b25kYy8nLAogICAgbm90ZTogJ0Rpc3RyaWN0IENsZXJrIHJlY29yZCBzZWFyY2guJyB9LAogIHsgbmFtZTogJ0hpZGFsZ28gQ291' +
  'bnR5IOKAlCBwcm9wZXJ0eSAvIG9mZmljaWFsIHJlY29yZHMnLCB1cmw6ICdodHRwczovL2hpZGFsZ28udHgucHVibGljc2VhcmNo' +
  'LnVzLycsCiAgICBub3RlOiAnRGVlZHMsIGxpZW5zIGFuZCBvd25lcnNoaXAgZnJvbSB0aGUgQ291bnR5IENsZXJrIOKAlCBwcm9w' +
  'ZXJ0eSwgbm90IGxhd3N1aXRzLiAnICsKICAgICAgICAgICdVc2VmdWwgZm9yIGNvbmZpcm1pbmcgd2hvIGFjdHVhbGx5IG93bnMg' +
  'YW4gYWRkcmVzcy4nIH0KXTsKCmZ1bmN0aW9uIGNhc2VMb29rdXBTaGVldChqb2IpIHsKICBzaGVldCgnTG9vayB1cCAnICsgam9i' +
  'LmNhc2VfbnVtYmVyLCBgCiAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDojZjhmYWZjO2JveC1zaGFkb3c6' +
  'bm9uZTt0ZXh0LWFsaWduOmNlbnRlciI+CiAgICAgIDxkaXYgc3R5bGU9ImZvbnQ6NjAwIDIwcHgvMS4zIG1vbm9zcGFjZTtsZXR0' +
  'ZXItc3BhY2luZzouNXB4Ij4ke2VzYyhqb2IuY2FzZV9udW1iZXIpfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaW50Ij4ke2Vz' +
  'Yyhqb2IuY291cnQgfHwgJ2NvdXJ0IG5vdCByZWNvcmRlZCcpfTwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc20iIGlk' +
  'PSJjb3B5Q2FzZSIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+Q29weSBjYXNlIG51bWJlcjwvYnV0dG9uPgogICAgPC9kaXY+CiAg' +
  'ICA8cCBjbGFzcz0iaGludCI+VGhlc2UgcG9ydGFscyBjYW4ndCBiZSBsaW5rZWQgdG8gZGlyZWN0bHkgd2l0aCBhIGNhc2UgbnVt' +
  'YmVyLCBzbyB0YXBwaW5nIG9uZSBjb3BpZXMKICAgICAgdGhlIG51bWJlciBhbmQgb3BlbnMgdGhlaXIgc2VhcmNoIHBhZ2Ug4oCU' +
  'IHBhc3RlIGl0IGludG8gdGhlaXIgYm94LjwvcD4KICAgIDxkaXYgY2xhc3M9Imxpc3QiPgogICAgICAke1RYX1BPUlRBTFMubWFw' +
  'KChwLCBpKSA9PiBgCiAgICAgICAgPGRpdiBjbGFzcz0iaXRlbSIgZGF0YS1wb3J0YWw9IiR7aX0iPgogICAgICAgICAgPGRpdiBj' +
  'bGFzcz0idCI+JHtlc2MocC5uYW1lKX08L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9Im0iPiR7ZXNjKHAubm90ZSl9PC9kaXY+' +
  'CiAgICAgICAgPC9kaXY+YCkuam9pbignJyl9CiAgICA8L2Rpdj4KICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRv' +
  'cDoxMnB4Ij5Db3VydCByZWNvcmRzIHJhcmVseSBwdWJsaXNoIGEgZGVmZW5kYW50J3Mgc2VydmljZSBhZGRyZXNzIOKAlAogICAg' +
  'ICB0aGF0IG5vcm1hbGx5IG9ubHkgZXhpc3RzIG9uIHRoZSBjbGllbnQncyBwYWNrZXQuPC9wPgogICAgPGJ1dHRvbiBjbGFzcz0i' +
  'YnRuIHNlYyBibG9jayIgc3R5bGU9Im1hcmdpbi10b3A6OHB4IiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNsb3NlPC9idXR0b24+' +
  'YCwgZWwgPT4gewogICAgY29uc3QgY29weSA9IGFzeW5jICgpID0+IHsKICAgICAgdHJ5IHsgYXdhaXQgbmF2aWdhdG9yLmNsaXBi' +
  'b2FyZC53cml0ZVRleHQoam9iLmNhc2VfbnVtYmVyKTsgcmV0dXJuIHRydWU7IH0KICAgICAgY2F0Y2ggKGUpIHsgcmV0dXJuIGZh' +
  'bHNlOyB9CiAgICB9OwogICAgZWwucXVlcnlTZWxlY3RvcignI2NvcHlDYXNlJykub25jbGljayA9IGFzeW5jICgpID0+CiAgICAg' +
  'IHRvYXN0KGF3YWl0IGNvcHkoKSA/ICdDb3BpZWQgJyArIGpvYi5jYXNlX251bWJlciA6ICdDb3B5IGZhaWxlZCDigJQgc2VsZWN0' +
  'IGl0IGJ5IGhhbmQnLCBmYWxzZSk7CiAgICBlbC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1wb3J0YWxdJykuZm9yRWFjaChyb3cg' +
  'PT4gcm93Lm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IHAgPSBUWF9QT1JUQUxTWytyb3cuZGF0YXNldC5wb3J0' +
  'YWxdOwogICAgICBjb25zdCBvayA9IGF3YWl0IGNvcHkoKTsKICAgICAgdG9hc3Qob2sgPyAnQ2FzZSBudW1iZXIgY29waWVkIOKA' +
  'lCBwYXN0ZSBpdCBpbnRvIHRoZWlyIHNlYXJjaCcgOiAnT3BlbmluZyAnICsgcC5uYW1lKTsKICAgICAgd2luZG93Lm9wZW4ocC51' +
  'cmwsICdfYmxhbmsnKTsKICAgIH0pOwogIH0pOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gc2NhbiAtLSAqLwpmdW5jdGlvbiBzY2FuVmlldygpIHsKICBhcHAuaW5uZXJIVE1MID0g' +
  'c2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5TY2FuIGEgcGFja2V0PC9oMT4KICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAg' +
  'ICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6MCI+UG9pbnQgdGhlIGNhbWVyYSBhdCB0aGUgYmFyY29kZSBvbiB0' +
  'aGUgY292ZXIgc2hlZXQgdG8gb3BlbiB0aGF0IGpvYi4gSWYgdGhlIGNhbWVyYQogICAgICB3b24ndCBjb29wZXJhdGUsIHR5cGUg' +
  'dGhlIGpvYiBudW1iZXIgaW5zdGVhZCDigJQgaXQgd29ya3MgdGhlIHNhbWUuPC9wPgogICAgICA8ZGl2IGlkPSJyZWFkZXIiPjwv' +
  'ZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9' +
  'ImJ0biIgaWQ9InN0YXJ0U2NhbiI+U3RhcnQgY2FtZXJhPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIg' +
  'aWQ9InN0b3BTY2FuQnRuIiBzdHlsZT0iZGlzcGxheTpub25lIj5TdG9wPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2' +
  'IGNsYXNzPSJoaW50IiBpZD0ic2Nhbk1zZyI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8' +
  'aDI+RW50ZXIgam9iIG51bWJlcjwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InJvdyI+CiAgICAgICAgPGlucHV0IGlkPSJtYW51YWwi' +
  'IHBsYWNlaG9sZGVyPSJTVC0xMDAwMSIgc3R5bGU9ImZsZXg6MTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2UiPgogICAgICAgIDxi' +
  'dXR0b24gY2xhc3M9ImJ0biIgaWQ9Im1hbnVhbEdvIj5PcGVuPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+YCk7CiAg' +
  'YmluZFNoZWxsKCk7CgogIGNvbnN0IG9wZW4gPSBhc3luYyBjb2RlID0+IHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IGogPSBhd2Fp' +
  'dCBhcGkoJy9sb29rdXAvJyArIGVuY29kZVVSSUNvbXBvbmVudChjb2RlKSk7CiAgICAgIGlmICh3aW5kb3cuX19zdG9wU2Nhbikg' +
  'eyB3aW5kb3cuX19zdG9wU2NhbigpOyB3aW5kb3cuX19zdG9wU2NhbiA9IG51bGw7IH0KICAgICAgdG9hc3QoJ09wZW5pbmcgJyAr' +
  'IGouam9iX251bWJlcik7CiAgICAgIGdvKCdqb2InLCB7IGlkOiBqLmlkIH0pOwogICAgfSBjYXRjaCAoZSkgeyAkKCcjc2Nhbk1z' +
  'ZycpLnRleHRDb250ZW50ID0gZS5tZXNzYWdlOyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKCiAgJCgnI21hbnVhbEdv' +
  'Jykub25jbGljayA9ICgpID0+IHsgY29uc3QgdiA9ICQoJyNtYW51YWwnKS52YWx1ZS50cmltKCk7IGlmICh2KSBvcGVuKHYpOyB9' +
  'OwogICQoJyNtYW51YWwnKS5vbmtleWRvd24gPSBlID0+IHsgaWYgKGUua2V5ID09PSAnRW50ZXInKSAkKCcjbWFudWFsR28nKS5j' +
  'bGljaygpOyB9OwoKICAkKCcjc3RhcnRTY2FuJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIGNvbnN0IG1zZyA9ICQoJyNz' +
  'Y2FuTXNnJyk7CiAgICBpZiAoIXdpbmRvdy5aWGluZykgcmV0dXJuIG1zZy50ZXh0Q29udGVudCA9ICdTY2FubmVyIGxpYnJhcnkg' +
  'ZGlkIG5vdCBsb2FkIOKAlCB1c2UgdGhlIGpvYiBudW1iZXIgYm94IGJlbG93Lic7CiAgICB0cnkgewogICAgICBjb25zdCByZWFk' +
  'ZXIgPSBuZXcgWlhpbmcuQnJvd3Nlck11bHRpRm9ybWF0UmVhZGVyKCk7CiAgICAgIGNvbnN0IHZpZGVvID0gZG9jdW1lbnQuY3Jl' +
  'YXRlRWxlbWVudCgndmlkZW8nKTsKICAgICAgdmlkZW8uc2V0QXR0cmlidXRlKCdwbGF5c2lubGluZScsICd0cnVlJyk7CiAgICAg' +
  'ICQoJyNyZWFkZXInKS5pbm5lckhUTUwgPSAnJzsKICAgICAgJCgnI3JlYWRlcicpLmFwcGVuZENoaWxkKHZpZGVvKTsKICAgICAg' +
  'JCgnI3N0YXJ0U2NhbicpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgICAgICQoJyNzdG9wU2NhbkJ0bicpLnN0eWxlLmRpc3Bs' +
  'YXkgPSAnJzsKICAgICAgbXNnLnRleHRDb250ZW50ID0gJ0xvb2tpbmcgZm9yIGEgYmFyY29kZeKApic7CiAgICAgIGxldCBoYW5k' +
  'bGVkID0gZmFsc2U7CiAgICAgIGF3YWl0IHJlYWRlci5kZWNvZGVGcm9tQ29uc3RyYWludHMoCiAgICAgICAgeyB2aWRlbzogeyBm' +
  'YWNpbmdNb2RlOiAnZW52aXJvbm1lbnQnIH0gfSwgdmlkZW8sCiAgICAgICAgKHJlc3VsdCkgPT4geyBpZiAocmVzdWx0ICYmICFo' +
  'YW5kbGVkKSB7IGhhbmRsZWQgPSB0cnVlOyBvcGVuKHJlc3VsdC5nZXRUZXh0KCkpOyB9IH0pOwogICAgICB3aW5kb3cuX19zdG9w' +
  'U2NhbiA9ICgpID0+IHsKICAgICAgICB0cnkgeyByZWFkZXIucmVzZXQoKTsgfSBjYXRjaCAoZSkge30KICAgICAgICAkKCcjcmVh' +
  'ZGVyJykuaW5uZXJIVE1MID0gJyc7CiAgICAgICAgY29uc3QgcyA9ICQoJyNzdGFydFNjYW4nKSwgc3QgPSAkKCcjc3RvcFNjYW5C' +
  'dG4nKTsKICAgICAgICBpZiAocykgcy5zdHlsZS5kaXNwbGF5ID0gJyc7CiAgICAgICAgaWYgKHN0KSBzdC5zdHlsZS5kaXNwbGF5' +
  'ID0gJ25vbmUnOwogICAgICB9OwogICAgICAkKCcjc3RvcFNjYW5CdG4nKS5vbmNsaWNrID0gKCkgPT4geyB3aW5kb3cuX19zdG9w' +
  'U2NhbigpOyB3aW5kb3cuX19zdG9wU2NhbiA9IG51bGw7IG1zZy50ZXh0Q29udGVudCA9ICcnOyB9OwogICAgfSBjYXRjaCAoZSkg' +
  'ewogICAgICBtc2cudGV4dENvbnRlbnQgPSAnQ2FtZXJhIHVuYXZhaWxhYmxlICgnICsgZS5tZXNzYWdlICsgJykuIFVzZSB0aGUg' +
  'am9iIG51bWJlciBib3ggYmVsb3cuJzsKICAgICAgJCgnI3N0YXJ0U2NhbicpLnN0eWxlLmRpc3BsYXkgPSAnJzsKICAgICAgJCgn' +
  'I3N0b3BTY2FuQnRuJykuc3R5bGUuZGlzcGxheSA9ICdub25lJzsKICAgIH0KICB9Owp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBtb25leSAtLSAqLwphc3luYyBmdW5jdGlvbiBtb25l' +
  'eVZpZXcoKSB7CiAgaWYgKCFpc0FkbWluKCkpIHJldHVybiBteVBheVZpZXcoKTsKICBjb25zdCBbc3RhdGVtZW50cywgaW52b2lj' +
  'ZXMsIHVzZXJzLCBjbGllbnRzXSA9IGF3YWl0IFByb21pc2UuYWxsKAogICAgW2FwaSgnL3N0YXRlbWVudHMnKSwgYXBpKCcvaW52' +
  'b2ljZXMnKSwgYXBpKCcvdXNlcnMnKSwgYXBpKCcvY2xpZW50cycpXSk7CgogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8' +
  'aDEgY2xhc3M9InBhZ2UiPkJpbGxpbmcgJmFtcDsgcGF5PC9oMT4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkNv' +
  'bnRyYWN0b3Igc3RhdGVtZW50cyA8c3BhbiBjbGFzcz0ic3ViIj53aGF0IHlvdSBvd2UgeW91ciBzZXJ2ZXJzPC9zcGFuPjwvaDI+' +
  'CiAgICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDotNHB4Ij5QdWxscyBldmVyeSBjb21wbGV0ZWQgc2VydmUg' +
  'aW4gdGhlIHBlcmlvZCB0aGF0IGhhc24ndCBiZWVuIHBhaWQgb3V0IHlldCwgYXQgdGhlCiAgICAgIHBlci1qb2IgcmF0ZSBvbiB0' +
  'aGUgam9iLiBOb3RoaW5nIGdldHMgY291bnRlZCB0d2ljZS48L3A+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiIHN0eWxlPSJt' +
  'YXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U2VydmVyPC9sYWJlbD48c2VsZWN0IGlk' +
  'PSJzX3NlcnZlciI+CiAgICAgICAgICAke3VzZXJzLmZpbHRlcih1ID0+IHUuYWN0aXZlKS5tYXAodSA9PiBgPG9wdGlvbiB2YWx1' +
  'ZT0iJHt1LmlkfSI+JHtlc2ModS5uYW1lKX08L29wdGlvbj5gKS5qb2luKCcnKX08L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2' +
  'IGNsYXNzPSJyb3ciIHN0eWxlPSJhbGlnbi1pdGVtczpmbGV4LWVuZDtnYXA6NnB4Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZp' +
  'ZWxkIiBzdHlsZT0iZmxleDoxO21hcmdpbjowIj48bGFiZWw+RnJvbTwvbGFiZWw+PGlucHV0IHR5cGU9ImRhdGUiIGlkPSJzX3N0' +
  'YXJ0IiB2YWx1ZT0iJHtmaXJzdE9mTW9udGgoKX0iPjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJm' +
  'bGV4OjE7bWFyZ2luOjAiPjxsYWJlbD5UbzwvbGFiZWw+PGlucHV0IHR5cGU9ImRhdGUiIGlkPSJzX2VuZCIgdmFsdWU9IiR7dG9k' +
  'YXlJU08oKX0iPjwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0i' +
  'bWFyZ2luLXRvcDo4cHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJzX3ByZXYiPlByZXZpZXc8L2J1' +
  'dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc20iIGlkPSJzX21ha2UiPkNyZWF0ZSBzdGF0ZW1lbnQ8L2J1dHRvbj4K' +
  'ICAgICAgPC9kaXY+CiAgICAgIDxkaXYgaWQ9InNfb3V0Ij48L2Rpdj4KICAgICAgJHtzdGF0ZW1lbnRzLmxlbmd0aCA/IGA8dGFi' +
  'bGUgY2xhc3M9InRibCIgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+CiAgICAgICAgPHRyPjx0aD5TZXJ2ZXI8L3RoPjx0aD5QZXJp' +
  'b2Q8L3RoPjx0aCBjbGFzcz0ibnVtIj5Kb2JzPC90aD48dGggY2xhc3M9Im51bSI+VG90YWw8L3RoPjx0aD48L3RoPjx0aD48L3Ro' +
  'PjwvdHI+CiAgICAgICAgJHtzdGF0ZW1lbnRzLm1hcChzID0+IGA8dHI+CiAgICAgICAgICA8dGQ+JHtlc2Mocy5zZXJ2ZXJfbmFt' +
  'ZSl9PC90ZD48dGQ+JHtmbXREYXRlT25seShzLnBlcmlvZF9zdGFydCl94oCTJHtmbXREYXRlT25seShzLnBlcmlvZF9lbmQpfTwv' +
  'dGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHtzLmpvYl9jb3VudH08L3RkPjx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KHMu' +
  'dG90YWwpfTwvdGQ+CiAgICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InBpbGwgJHtjbHMocy5zdGF0dXMpfSI+JHtlc2Mocy5zdGF0' +
  'dXMpfTwvc3Bhbj48L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPjxhIGhyZWY9Ii9wcmludC9zdGF0ZW1lbnQvJHtzLmlk' +
  'fSIgdGFyZ2V0PSJfYmxhbmsiPnByaW50PC9hPgogICAgICAgICAgICAke3Muc3RhdHVzICE9PSAnUGFpZCcgPyBgIMK3IDxhIGhy' +
  'ZWY9IiMiIGRhdGEtcGFpZD0iJHtzLmlkfSI+bWFyayBwYWlkPC9hPmAgOiAnJ308L3RkPgogICAgICAgIDwvdHI+YCkuam9pbign' +
  'Jyl9PC90YWJsZT5gIDogJyd9CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkNsaWVudCBpbnZv' +
  'aWNlczwvaDI+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q2xp' +
  'ZW50PC9sYWJlbD48c2VsZWN0IGlkPSJpX2NsaWVudCI+CiAgICAgICAgICAke2NsaWVudHMuZmlsdGVyKGMgPT4gYy5hY3RpdmUp' +
  'Lm1hcChjID0+IGA8b3B0aW9uIHZhbHVlPSIke2MuaWR9Ij4ke2VzYyhjLm5hbWUpfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2Vs' +
  'ZWN0PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9ImFsaWduLWl0ZW1zOmZsZXgtZW5kO2dhcDo2cHgiPgog' +
  'ICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJmbGV4OjE7bWFyZ2luOjAiPjxsYWJlbD5Gcm9tPC9sYWJlbD48aW5w' +
  'dXQgdHlwZT0iZGF0ZSIgaWQ9Imlfc3RhcnQiIHZhbHVlPSIke2ZpcnN0T2ZNb250aCgpfSI+PC9kaXY+CiAgICAgICAgICA8ZGl2' +
  'IGNsYXNzPSJmaWVsZCIgc3R5bGU9ImZsZXg6MTttYXJnaW46MCI+PGxhYmVsPlRvPC9sYWJlbD48aW5wdXQgdHlwZT0iZGF0ZSIg' +
  'aWQ9ImlfZW5kIiB2YWx1ZT0iJHt0b2RheUlTTygpfSI+PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8' +
  'ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIg' +
  'aWQ9ImlfcHJldiI+UHJldmlldzwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9ImlfbWFrZSI+Q3Jl' +
  'YXRlIGludm9pY2U8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgaWQ9Imlfb3V0Ij48L2Rpdj4KICAgICAgJHtpbnZv' +
  'aWNlcy5sZW5ndGggPyBgPHRhYmxlIGNsYXNzPSJ0YmwiIHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPgogICAgICAgIDx0cj48dGg+' +
  'Q2xpZW50PC90aD48dGg+UGVyaW9kPC90aD48dGggY2xhc3M9Im51bSI+Sm9iczwvdGg+PHRoIGNsYXNzPSJudW0iPlRvdGFsPC90' +
  'aD48dGg+PC90aD48dGg+PC90aD48L3RyPgogICAgICAgICR7aW52b2ljZXMubWFwKHMgPT4gYDx0cj4KICAgICAgICAgIDx0ZD4k' +
  'e2VzYyhzLmNsaWVudF9uYW1lKX08L3RkPjx0ZD4ke2ZtdERhdGVPbmx5KHMucGVyaW9kX3N0YXJ0KX3igJMke2ZtdERhdGVPbmx5' +
  'KHMucGVyaW9kX2VuZCl9PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke3Muam9iX2NvdW50fTwvdGQ+PHRkIGNsYXNz' +
  'PSJudW0iPiR7bW9uZXkocy50b3RhbCl9PC90ZD4KICAgICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icGlsbCAke2NscyhzLnN0YXR1' +
  'cyl9Ij4ke2VzYyhzLnN0YXR1cyl9PC9zcGFuPjwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iL3ByaW50' +
  'L2ludm9pY2UvJHtzLmlkfSIgdGFyZ2V0PSJfYmxhbmsiPnByaW50PC9hPgogICAgICAgICAgICAke3Muc3RhdHVzICE9PSAnUGFp' +
  'ZCcgPyBgIMK3IDxhIGhyZWY9IiMiIGRhdGEtaXBhaWQ9IiR7cy5pZH0iPm1hcmsgcGFpZDwvYT5gIDogJyd9PC90ZD4KICAgICAg' +
  'ICA8L3RyPmApLmpvaW4oJycpfTwvdGFibGU+YCA6ICcnfQogICAgPC9kaXY+YCk7CiAgYmluZFNoZWxsKCk7CgogIGNvbnN0IGxp' +
  'bmVzVGFibGUgPSAociwga2V5KSA9PiByLmxpbmVzLmxlbmd0aAogICAgPyBgPHRhYmxlIGNsYXNzPSJ0YmwiIHN0eWxlPSJtYXJn' +
  'aW4tdG9wOjEwcHgiPjx0cj48dGg+RGF0ZTwvdGg+PHRoPkpvYjwvdGg+PHRoPlJlY2lwaWVudDwvdGg+PHRoIGNsYXNzPSJudW0i' +
  'PiR7a2V5ID09PSAncGF5JyA/ICdQYXknIDogJ0ZlZSd9PC90aD48L3RyPgogICAgICAgJHtyLmxpbmVzLm1hcChsID0+IGA8dHI+' +
  'PHRkPiR7Zm10RGF0ZU9ubHkobC5zZXJ2ZWRfYXQpfTwvdGQ+PHRkPiR7ZXNjKGwuam9iX251bWJlcil9PC90ZD4KICAgICAgIDx0' +
  'ZD4ke2VzYyhsLnJlY2lwaWVudF9uYW1lKX08L3RkPjx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KGtleSA9PT0gJ3BheScgPyBsLnNl' +
  'cnZlcl9wYXkgOiBsLmNsaWVudF9mZWUpfTwvdGQ+PC90cj5gKS5qb2luKCcnKX0KICAgICAgIDx0cj48dGQgY29sc3Bhbj0iMyI+' +
  'PGI+JHtyLmNvdW50fSBqb2Iocyk8L2I+PC90ZD48dGQgY2xhc3M9Im51bSI+PGI+JHttb25leShyLnRvdGFsKX08L2I+PC90ZD48' +
  'L3RyPjwvdGFibGU+YAogICAgOiAnPGRpdiBjbGFzcz0iaGludCI+Tm90aGluZyB1bmJpbGxlZCBpbiB0aGF0IHdpbmRvdy48L2Rp' +
  'dj4nOwoKICAkKCcjc19wcmV2Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9zdGF0' +
  'ZW1lbnRzL3ByZXZpZXcnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSgKICAgICAgeyBzZXJ2ZXJfaWQ6' +
  'ICQoJyNzX3NlcnZlcicpLnZhbHVlLCBzdGFydDogJCgnI3Nfc3RhcnQnKS52YWx1ZSwgZW5kOiAkKCcjc19lbmQnKS52YWx1ZSB9' +
  'KSB9KTsKICAgICQoJyNzX291dCcpLmlubmVySFRNTCA9IGxpbmVzVGFibGUociwgJ3BheScpOwogIH07CiAgJCgnI3NfbWFrZScp' +
  'Lm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBhd2FpdCBhcGkoJy9zdGF0ZW1lbnRzJywgeyBtZXRob2Q6' +
  'ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoCiAgICAgICAgeyBzZXJ2ZXJfaWQ6ICQoJyNzX3NlcnZlcicpLnZhbHVlLCBz' +
  'dGFydDogJCgnI3Nfc3RhcnQnKS52YWx1ZSwgZW5kOiAkKCcjc19lbmQnKS52YWx1ZSB9KSB9KTsKICAgICAgdG9hc3QoJ1N0YXRl' +
  'bWVudCBjcmVhdGVkJyk7IGdvKCdtb25leScpOwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAg' +
  'fTsKICAkKCcjaV9wcmV2Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9pbnZvaWNl' +
  'cy9wcmV2aWV3JywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoCiAgICAgIHsgY2xpZW50X2lkOiAkKCcj' +
  'aV9jbGllbnQnKS52YWx1ZSwgc3RhcnQ6ICQoJyNpX3N0YXJ0JykudmFsdWUsIGVuZDogJCgnI2lfZW5kJykudmFsdWUgfSkgfSk7' +
  'CiAgICAkKCcjaV9vdXQnKS5pbm5lckhUTUwgPSBsaW5lc1RhYmxlKHIsICdmZWUnKTsKICB9OwogICQoJyNpX21ha2UnKS5vbmNs' +
  'aWNrID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAgICAgYXdhaXQgYXBpKCcvaW52b2ljZXMnLCB7IG1ldGhvZDogJ1BPU1Qn' +
  'LCBib2R5OiBKU09OLnN0cmluZ2lmeSgKICAgICAgICB7IGNsaWVudF9pZDogJCgnI2lfY2xpZW50JykudmFsdWUsIHN0YXJ0OiAk' +
  'KCcjaV9zdGFydCcpLnZhbHVlLCBlbmQ6ICQoJyNpX2VuZCcpLnZhbHVlIH0pIH0pOwogICAgICB0b2FzdCgnSW52b2ljZSBjcmVh' +
  'dGVkJyk7IGdvKCdtb25leScpOwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKICBkb2N1' +
  'bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1wYWlkXScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sgPSBhc3luYyBlID0+IHsK' +
  'ICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgIGF3YWl0IGFwaSgnL3N0YXRlbWVudHMvJyArIGEuZGF0YXNldC5wYWlkLCB7IG1l' +
  'dGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBzdGF0dXM6ICdQYWlkJyB9KSB9KTsKICAgIHRvYXN0KCdNYXJr' +
  'ZWQgcGFpZCcpOyBnbygnbW9uZXknKTsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1pcGFpZF0nKS5m' +
  'b3JFYWNoKGEgPT4gYS5vbmNsaWNrID0gYXN5bmMgZSA9PiB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICBhd2FpdCBhcGko' +
  'Jy9pbnZvaWNlcy8nICsgYS5kYXRhc2V0LmlwYWlkLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBz' +
  'dGF0dXM6ICdQYWlkJyB9KSB9KTsKICAgIHRvYXN0KCdNYXJrZWQgcGFpZCcpOyBnbygnbW9uZXknKTsKICB9KTsKfQoKZnVuY3Rp' +
  'b24gZmlyc3RPZk1vbnRoKCkgewogIGNvbnN0IGQgPSBuZXcgRGF0ZSgpOyByZXR1cm4gbmV3IERhdGUoZC5nZXRGdWxsWWVhcigp' +
  'LCBkLmdldE1vbnRoKCksIDEpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApOwp9Cgphc3luYyBmdW5jdGlvbiBteVBheVZpZXco' +
  'KSB7CiAgY29uc3QgW3N0YXRlbWVudHMsIHN0YXRzXSA9IGF3YWl0IFByb21pc2UuYWxsKFthcGkoJy9zdGF0ZW1lbnRzJyksIGFw' +
  'aSgnL3N0YXRzJyldKTsKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5NeSBwYXk8L2gxPgog' +
  'ICAgPGRpdiBjbGFzcz0ic3RhdHMiPgogICAgICA8ZGl2IGNsYXNzPSJzdGF0IGdvb2QiPjxkaXYgY2xhc3M9Im4iPiR7bW9uZXko' +
  'c3RhdHMudW5iaWxsZWQpfTwvZGl2PjxkaXYgY2xhc3M9ImwiPkVhcm5lZCwgbm90IHlldCBvbiBhIHN0YXRlbWVudDwvZGl2Pjwv' +
  'ZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdGF0Ij48ZGl2IGNsYXNzPSJuIj4ke3N0YXRzLnNlcnZlZF83ZH08L2Rpdj48ZGl2IGNs' +
  'YXNzPSJsIj5TZXJ2ZXMgY29tcGxldGVkLCA3IGRheXM8L2Rpdj48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2Fy' +
  'ZCI+PGgyPlN0YXRlbWVudHM8L2gyPgogICAgJHtzdGF0ZW1lbnRzLmxlbmd0aCA/IGA8dGFibGUgY2xhc3M9InRibCI+CiAgICAg' +
  'IDx0cj48dGg+UGVyaW9kPC90aD48dGggY2xhc3M9Im51bSI+Sm9iczwvdGg+PHRoIGNsYXNzPSJudW0iPlRvdGFsPC90aD48dGg+' +
  'PC90aD48dGg+PC90aD48L3RyPgogICAgICAke3N0YXRlbWVudHMubWFwKHMgPT4gYDx0cj48dGQ+JHtmbXREYXRlT25seShzLnBl' +
  'cmlvZF9zdGFydCl94oCTJHtmbXREYXRlT25seShzLnBlcmlvZF9lbmQpfTwvdGQ+CiAgICAgICAgPHRkIGNsYXNzPSJudW0iPiR7' +
  'cy5qb2JfY291bnR9PC90ZD48dGQgY2xhc3M9Im51bSI+JHttb25leShzLnRvdGFsKX08L3RkPgogICAgICAgIDx0ZD48c3BhbiBj' +
  'bGFzcz0icGlsbCAke2NscyhzLnN0YXR1cyl9Ij4ke2VzYyhzLnN0YXR1cyl9PC9zcGFuPjwvdGQ+CiAgICAgICAgPHRkIGNsYXNz' +
  'PSJudW0iPjxhIGhyZWY9Ii9wcmludC9zdGF0ZW1lbnQvJHtzLmlkfSIgdGFyZ2V0PSJfYmxhbmsiPnByaW50PC9hPjwvdGQ+PC90' +
  'cj5gKS5qb2luKCcnKX0KICAgICAgPC90YWJsZT5gIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij5ObyBzdGF0ZW1lbnRzIHlldC48L2Rp' +
  'dj4nfQogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj48aDI+Q2hhbmdlIHBhc3N3b3JkPC9oMj4KICAgICAgPGRpdiBj' +
  'bGFzcz0iaGludCI+VGhpcyBpcyB5b3VyIG9uZSBwYXNzd29yZCBmb3IgZXZlcnkgYXBwLjwvZGl2PgogICAgICA8ZGl2IGNsYXNz' +
  'PSJmaWVsZCI+PGlucHV0IGlkPSJvcHciIHR5cGU9InBhc3N3b3JkIiBwbGFjZWhvbGRlcj0iQ3VycmVudCBwYXNzd29yZCI+PC9k' +
  'aXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48aW5wdXQgaWQ9Im5wdyIgdHlwZT0icGFzc3dvcmQiIHBsYWNlaG9sZGVyPSJO' +
  'ZXcgcGFzc3dvcmQgKDgrIGNoYXJhY3RlcnMpIj48L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0ic2F2ZVB3' +
  'Ij5VcGRhdGU8L2J1dHRvbj48L2Rpdj5gKTsKICBiaW5kU2hlbGwoKTsKICAkKCcjc2F2ZVB3Jykub25jbGljayA9IGFzeW5jICgp' +
  'ID0+IHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9tZS9wYXNzd29yZCcsIHsgbWV0aG9kOiAnUE9TVCcs' +
  'IGJvZHk6IEpTT04uc3RyaW5naWZ5KHsKICAgICAgICBwYXNzd29yZDogJCgnI25wdycpLnZhbHVlLCBvbGRfcGFzc3dvcmQ6ICQo' +
  'JyNvcHcnKS52YWx1ZSB9KSB9KTsKICAgICAgJCgnI29wdycpLnZhbHVlID0gJyc7ICQoJyNucHcnKS52YWx1ZSA9ICcnOwogICAg' +
  'ICB0b2FzdChyLmV2ZXJ5d2hlcmUgPT09IGZhbHNlID8gJ0NoYW5nZWQgaGVyZSDigJQgb3RoZXIgYXBwcyBzdGlsbCBoYXZlIHRo' +
  'ZSBvbGQgb25lJyA6ICdQYXNzd29yZCB1cGRhdGVkIGV2ZXJ5d2hlcmUnKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNz' +
  'YWdlLCB0cnVlKTsgfQogIH07Cn0KCgpmdW5jdGlvbiBjb2Rlc1RhYmxlKGxpc3QpIHsKICBpZiAoIWxpc3QubGVuZ3RoKSByZXR1' +
  'cm4gJzxkaXYgY2xhc3M9ImhpbnQiPk5vIGNvZGVzIHlldC48L2Rpdj4nOwogIHJldHVybiBgPHRhYmxlIGNsYXNzPSJ0YmwiPgog' +
  'ICAgPHRyPjx0aD5Db2RlPC90aD48dGg+R3JhbnRzPC90aD48dGg+VXNlZDwvdGg+PHRoPjwvdGg+PHRoPjwvdGg+PC90cj4KICAg' +
  'ICR7bGlzdC5tYXAoYyA9PiBgPHRyPgogICAgICA8dGQ+PHNwYW4gc3R5bGU9ImZvbnQ6NjAwIDEzcHggbW9ub3NwYWNlO2xldHRl' +
  'ci1zcGFjaW5nOi41cHgiPiR7ZXNjKGMuY29kZSl9PC9zcGFuPgogICAgICAgICR7Yy5ub3RlID8gYDxkaXYgY2xhc3M9ImhpbnQi' +
  'PiR7ZXNjKGMubm90ZSl9PC9kaXY+YCA6ICcnfQogICAgICAgICR7Yy5yZWRlbXB0aW9ucyAmJiBjLnJlZGVtcHRpb25zLmxlbmd0' +
  'aCA/IGA8ZGl2IGNsYXNzPSJoaW50Ij4ke2MucmVkZW1wdGlvbnMubWFwKHIgPT4gZXNjKHIuZW1haWwpKS5qb2luKCcsICcpfTwv' +
  'ZGl2PmAgOiAnJ308L3RkPgogICAgICA8dGQ+JHtjLnJvbGUgPT09ICdhZG1pbicgPyAnQWRtaW4nIDogJ0ZpZWxkIHNlcnZlcid9' +
  'CiAgICAgICAgJHtjLmV4cGlyZXNfYXQgPyBgPGRpdiBjbGFzcz0iaGludCI+dG8gJHtmbXREYXRlT25seShjLmV4cGlyZXNfYXQp' +
  'fTwvZGl2PmAgOiAnJ308L3RkPgogICAgICA8dGQ+JHtjLnVzZWRfY291bnR9LyR7Yy5tYXhfdXNlc308L3RkPgogICAgICA8dGQ+' +
  'PHNwYW4gY2xhc3M9InBpbGwgJHtjLnN0YXRlID09PSAnQWN0aXZlJyA/ICdTZXJ2ZWQnIDogJyd9Ij4ke2VzYyhjLnN0YXRlKX08' +
  'L3NwYW4+PC90ZD4KICAgICAgPHRkIGNsYXNzPSJudW0iPgogICAgICAgIDxhIGhyZWY9IiMiIGRhdGEtY29weT0iJHtlc2MoYy5j' +
  'b2RlKX0iPmNvcHk8L2E+CiAgICAgICAgJHtjLnN0YXRlID09PSAnQWN0aXZlJyA/IGAgwrcgPGEgaHJlZj0iIyIgZGF0YS1yZXZv' +
  'a2U9IiR7Yy5pZH0iPnJldm9rZTwvYT5gIDogJyd9CiAgICAgIDwvdGQ+PC90cj5gKS5qb2luKCcnKX08L3RhYmxlPmA7Cn0KCi8q' +
  'IC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGFkbWluIC0tICov' +
  'CmFzeW5jIGZ1bmN0aW9uIGFkbWluVmlldygpIHsKICAvLyBGZXRjaCBldmVyeXRoaW5nIGJlZm9yZSBkcmF3aW5nLiBQb3B1bGF0' +
  'aW5nIGNhcmRzIGFmdGVyIHJlbmRlciBtYWRlIHRoZQogIC8vIHBhZ2UgZ3JvdyB1bmRlciB0aGUgdXNlcidzIGZpbmdlciwgc28g' +
  'YSB0YXAgY291bGQgbGFuZCBvbiB0aGUgd3Jvbmcgcm93LgogIGNvbnN0IFt1c2VycywgY2xpZW50cywgdGVtcGxhdGVzLCBjb2Rl' +
  'cywgcG9ydGFscywgY29tcGFuaWVzXSA9IGF3YWl0IFByb21pc2UuYWxsKFsKICAgIGFwaSgnL3VzZXJzJyksIGFwaSgnL2NsaWVu' +
  'dHMnKSwgYXBpKCcvdGVtcGxhdGVzJyksCiAgICBhcGkoJy9jb2RlcycpLmNhdGNoKCgpID0+IFtdKSwgYXBpKCcvcG9ydGFscycp' +
  'LmNhdGNoKCgpID0+IFtdKSwKICAgIGFwaSgnL2NvbXBhbmllcycpLmNhdGNoKCgpID0+IFtdKQogIF0pOwogIGNvbnN0IGhlcmUg' +
  'PSBjb21wYW5pZXMuZmluZChjID0+IFMubWUuY29tcGFueSAmJiBjLmlkID09PSBTLm1lLmNvbXBhbnkuaWQpIHx8IGNvbXBhbmll' +
  'c1swXSB8fCB7fTsKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5TZXR1cDwvaDE+CgogICAg' +
  'PGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj4ke2lzT3duZXIoKSA/ICdUaGlzIGNvbXBhbnknIDogJ1lvdXIgY29tcGFueSd9' +
  'CiAgICAgICAgPHNwYW4gY2xhc3M9InN1YiI+JHtlc2MoaGVyZS5wbGFuID09PSAncHJvJyA/ICdQcm8nIDogJ0ZyZWUnKX0kewog' +
  'ICAgICAgICAgaGVyZS5wbGFuX2V4cGlyZXMgPyAnIHVudGlsICcgKyBmbXREYXRlT25seShoZXJlLnBsYW5fZXhwaXJlcykgOiAn' +
  'J308L3NwYW4+PC9oMj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5OYW1lPC9sYWJlbD48aW5wdXQgaWQ9ImNvTmFt' +
  'ZSIgdmFsdWU9IiR7ZXNjKGhlcmUubmFtZSB8fCAnJyl9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5D' +
  'b250YWN0IGVtYWlsPC9sYWJlbD48aW5wdXQgaWQ9ImNvRW1haWwiIHZhbHVlPSIke2VzYyhoZXJlLmNvbnRhY3RfZW1haWwgfHwg' +
  'JycpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGhvbmU8L2xhYmVsPjxpbnB1dCBpZD0iY29QaG9u' +
  'ZSIgdmFsdWU9IiR7ZXNjKGhlcmUucGhvbmUgfHwgJycpfSI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9' +
  'ImNvU2F2ZSI+U2F2ZTwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPlRoaXMg' +
  'bmFtZSBhcHBlYXJzIG9uIHlvdXIgaW52b2ljZXMgYW5kIHBheSBzdGF0ZW1lbnRzLjwvZGl2PgogICAgPC9kaXY+CgogICAgJHtp' +
  'c093bmVyKCkgPyBgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5BbGwgY29tcGFuaWVzIDxzcGFuIGNsYXNzPSJzdWIiPiR7' +
  'Y29tcGFuaWVzLmxlbmd0aH08L3NwYW4+PC9oMj4KICAgICAgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgICAgIDx0cj48dGg+Q29t' +
  'cGFueTwvdGg+PHRoIGNsYXNzPSJudW0iPlBlb3BsZTwvdGg+PHRoIGNsYXNzPSJudW0iPk9wZW48L3RoPjx0aD48L3RoPjwvdHI+' +
  'CiAgICAgICAgJHtjb21wYW5pZXMubWFwKGMgPT4gYDx0cj4KICAgICAgICAgIDx0ZD4ke2VzYyhjLm5hbWUpfSR7Uy5tZS5jb21w' +
  'YW55ICYmIGMuaWQgPT09IFMubWUuY29tcGFueS5pZCA/ICcgPHNwYW4gY2xhc3M9InBpbGwiPnlvdSBhcmUgaGVyZTwvc3Bhbj4n' +
  'IDogJyd9CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKGMuYWRtaW5fZW1haWwgfHwgJ25vIGFkbWluIHlldCcp' +
  'fSDCtyAke2MucGxhbiA9PT0gJ3BybycgPyAnUHJvJyA6ICdGcmVlJ308L2Rpdj48L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJu' +
  'dW0iPiR7Yy5wZW9wbGUgPz8gJ+KAlCd9PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke2Mub3Blbl9qb2JzID8/ICfi' +
  'gJQnfTwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHtTLm1lLmNvbXBhbnkgJiYgYy5pZCA9PT0gUy5tZS5jb21wYW55' +
  'LmlkCiAgICAgICAgICAgID8gJycgOiBgPGEgaHJlZj0iIyIgZGF0YS1lbnRlcj0iJHtjLmlkfSI+ZW50ZXI8L2E+YH08L3RkPjwv' +
  'dHI+YCkuam9pbignJyl9CiAgICAgIDwvdGFibGU+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0ibWFyZ2luLXRvcDox' +
  'MnB4Ij48bGFiZWw+U3RhcnQgYW5vdGhlciBjb21wYW55PC9sYWJlbD4KICAgICAgICA8aW5wdXQgaWQ9Im5ld0NvTmFtZSIgcGxh' +
  'Y2Vob2xkZXI9IkNvbXBhbnkgbmFtZSI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9Im5ld0NvIj5DcmVh' +
  'dGUgY29tcGFueTwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPkNyZWF0aW5n' +
  'IGEgY29tcGFueSBnaXZlcyBpdCBpdHMgb3duIGpvYnMsIGNsaWVudHMgYW5kCiAgICAgICAgYmlsbGluZy4gQWRkIGl0cyBhZG1p' +
  'bmlzdHJhdG9yIGZyb20gaW5zaWRlIGl0LCBvciBoYW5kIHRoZW0gYW4gYWNjZXNzIGNvZGUuPC9kaXY+CiAgICA8L2Rpdj5gIDog' +
  'Jyd9CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5UZWFtIDxzcGFuIGNsYXNzPSJzdWIiPiR7dXNlcnMubGVuZ3Ro' +
  'fTwvc3Bhbj48L2gyPgogICAgICA8dGFibGUgY2xhc3M9InRibCI+CiAgICAgICAgPHRyPjx0aD5OYW1lPC90aD48dGg+Um9sZTwv' +
  'dGg+PHRoIGNsYXNzPSJudW0iPlJhdGU8L3RoPjx0aD48L3RoPjwvdHI+CiAgICAgICAgJHt1c2Vycy5tYXAodSA9PiBgPHRyPjx0' +
  'ZD4ke2VzYyh1Lm5hbWUpfTxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKHUuZW1haWwpfTwvZGl2PjwvdGQ+CiAgICAgICAgICA8dGQ+' +
  'JHtlc2ModS5yb2xlKX0ke3UuYWN0aXZlID8gJycgOiAnIDxzcGFuIGNsYXNzPSJwaWxsIj5vZmY8L3NwYW4+J308L3RkPgogICAg' +
  'ICAgICAgPHRkIGNsYXNzPSJudW0iPiR7bW9uZXkodS5kZWZhdWx0X3BheSl9PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVt' +
  'Ij48YSBocmVmPSIjIiBkYXRhLXVzZXI9IiR7dS5pZH0iPmVkaXQ8L2E+PC90ZD48L3RyPmApLmpvaW4oJycpfQogICAgICA8L3Rh' +
  'YmxlPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIGJsb2NrIHNtIiBpZD0ibmV3VXNlciIgc3R5bGU9Im1hcmdpbi10b3A6' +
  'MTBweCI+KyBBZGQgcGVyc29uPC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkNs' +
  'aWVudHMgPHNwYW4gY2xhc3M9InN1YiI+JHtjbGllbnRzLmxlbmd0aH08L3NwYW4+PC9oMj4KICAgICAgPHRhYmxlIGNsYXNzPSJ0' +
  'YmwiPgogICAgICAgIDx0cj48dGg+TmFtZTwvdGg+PHRoIGNsYXNzPSJudW0iPkRlZmF1bHQgZmVlPC90aD48dGg+PC90aD48L3Ry' +
  'PgogICAgICAgICR7Y2xpZW50cy5tYXAoYyA9PiBgPHRyPjx0ZD4ke2VzYyhjLm5hbWUpfTxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNj' +
  'KGMuY29udGFjdF9uYW1lIHx8ICcnKX0gJHtlc2MoYy5waG9uZSB8fCAnJyl9PC9kaXY+PC90ZD4KICAgICAgICAgIDx0ZCBjbGFz' +
  'cz0ibnVtIj4ke21vbmV5KGMuZGVmYXVsdF9mZWUpfTwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iIyIg' +
  'ZGF0YS1jbGllbnQ9IiR7Yy5pZH0iPmVkaXQ8L2E+PC90ZD48L3RyPmApLmpvaW4oJycpfQogICAgICA8L3RhYmxlPgogICAgICA8' +
  'YnV0dG9uIGNsYXNzPSJidG4gc2VjIGJsb2NrIHNtIiBpZD0ibmV3Q2xpZW50IiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4rIEFk' +
  'ZCBjbGllbnQ8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+QWZmaWRhdml0IHRl' +
  'bXBsYXRlcyA8c3BhbiBjbGFzcz0ic3ViIj4ke3RlbXBsYXRlcy5sZW5ndGh9PC9zcGFuPjwvaDI+CiAgICAgIDxwIGNsYXNzPSJo' +
  'aW50IiBzdHlsZT0ibWFyZ2luLXRvcDotNHB4Ij5Xcml0ZSB5b3VyIG93biB3b3JkaW5nIHBlciBjb3VudHkgb3IgY2xpZW50LiBN' +
  'ZXJnZSBmaWVsZHMgZmlsbCBpbiBmcm9tIHRoZSBqb2IsCiAgICAgIGluY2x1ZGluZyB0aGUgZnVsbCBhdHRlbXB0IGxvZyB3aXRo' +
  'IEdQUy48L3A+CiAgICAgIDx0YWJsZSBjbGFzcz0idGJsIj4KICAgICAgICAke3RlbXBsYXRlcy5tYXAodCA9PiBgPHRyPjx0ZD4k' +
  'e2VzYyh0Lm5hbWUpfTxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKHQuanVyaXNkaWN0aW9uIHx8ICcnKX08L2Rpdj48L3RkPgogICAg' +
  'ICAgICAgPHRkPiR7dC5pc19kZWZhdWx0ID8gJzxzcGFuIGNsYXNzPSJwaWxsIFNlcnZlZCI+ZGVmYXVsdDwvc3Bhbj4nIDogJyd9' +
  'PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIjIiBkYXRhLXRwbD0iJHt0LmlkfSI+ZWRpdDwvYT48L3Rk' +
  'PjwvdHI+YCkuam9pbignJyl9CiAgICAgIDwvdGFibGU+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgYmxvY2sgc20iIGlk' +
  'PSJuZXdUcGwiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPisgTmV3IHRlbXBsYXRlPC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8' +
  'ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkFjY2VzcyBjb2RlcyA8c3BhbiBjbGFzcz0ic3ViIj5sZXQgcGVvcGxlIHNldCB1' +
  'cCB0aGVpciBvd24gYWNjb3VudDwvc3Bhbj48L2gyPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6LTRw' +
  'eCI+R2VuZXJhdGUgYSBjb2RlIGFuZCBzZW5kIGl0IG92ZXIuIFRoZXkgZW50ZXIgaXQgb24gdGhlIHNpZ24taW4KICAgICAgICBz' +
  'Y3JlZW4gdW5kZXIgIlNldCB1cCB5b3VyIGFjY291bnQiLCBwaWNrIHRoZWlyIG93biBwYXNzd29yZCwgYW5kIHRoZXkncmUgaW4g' +
  '4oCUIG5vIG5lZWQgdG8ga2V5IGluCiAgICAgICAgdGhlaXIgZGV0YWlscyBvciBzaGFyZSBhIHBhc3N3b3JkIHdpdGggdGhlbS48' +
  'L3A+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzMiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxkaXYgY2xhc3M9' +
  'ImZpZWxkIj48bGFiZWw+VGhleSBiZWNvbWU8L2xhYmVsPjxzZWxlY3QgaWQ9ImNfcm9sZSI+CiAgICAgICAgICA8b3B0aW9uIHZh' +
  'bHVlPSJzZXJ2ZXIiPkZpZWxkIHNlcnZlcjwvb3B0aW9uPjxvcHRpb24gdmFsdWU9ImFkbWluIj5BZG1pbjwvb3B0aW9uPjwvc2Vs' +
  'ZWN0PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+SG93IG1hbnkgY2FuIHVzZSBpdDwvbGFiZWw+PGlu' +
  'cHV0IGlkPSJjX3VzZXMiIHR5cGU9Im51bWJlciIgbWluPSIxIiBtYXg9IjUwMCIgdmFsdWU9IjEiPjwvZGl2PgogICAgICAgIDxk' +
  'aXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RXhwaXJlcyAob3B0aW9uYWwpPC9sYWJlbD48aW5wdXQgaWQ9ImNfZXhwIiB0eXBlPSJk' +
  'YXRlIj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICAgIDxkaXYgY2xhc3M9ImZp' +
  'ZWxkIj48bGFiZWw+UGF5IHBlciBzZXJ2ZSAoZmllbGQgc2VydmVycyk8L2xhYmVsPjxpbnB1dCBpZD0iY19wYXkiIHR5cGU9Im51' +
  'bWJlciIgc3RlcD0iMC4wMSIgcGxhY2Vob2xkZXI9IjQ1LjAwIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxh' +
  'YmVsPk5vdGUgdG8geW91cnNlbGY8L2xhYmVsPjxpbnB1dCBpZD0iY19ub3RlIiBwbGFjZWhvbGRlcj0iRm9yIE1hcmlhIOKAlCBl' +
  'dmljdGlvbnMiPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0iY19tYWtlIj5HZW5l' +
  'cmF0ZSBhIGNvZGU8L2J1dHRvbj4KICAgICAgPGRpdiBpZD0iY19saXN0IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij4ke2NvZGVz' +
  'VGFibGUoY29kZXMpfTwvZGl2PgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5Db3VydCBwb3J0' +
  'YWwgcHJvYmUgPHNwYW4gY2xhc3M9InN1YiI+ZXhwZXJpbWVudGFsPC9zcGFuPjwvaDI+CiAgICAgIDxwIGNsYXNzPSJoaW50IiBz' +
  'dHlsZT0ibWFyZ2luLXRvcDotNHB4Ij5Bc2tzIHRoZSBzZXJ2ZXIgdG8gZmV0Y2ggYSBjb3VudHkgcG9ydGFsIGFuZCByZXBvcnQg' +
  'd2hhdCBjYW1lIGJhY2sg4oCUCiAgICAgICAgc3RhdHVzLCBjb29raWVzLCBmb3JtcywgbGlua3MuIFRoaXMgaXMgdGhlIGdyb3Vu' +
  'ZHdvcmsgZm9yIGF1dG9tYXRpYyBjYXNlIGxvb2t1cDogdGhlc2UgcG9ydGFscyBjYW4ndCBiZQogICAgICAgIHJlYWNoZWQgZnJv' +
  'bSB3aGVyZSB0aGlzIGFwcCB3YXMgd3JpdHRlbiwgc28gdGhlIHNlcnZlciBoYXMgdG8gZ28gYW5kIGxvb2suIFJ1biBvbmUgYW5k' +
  'IHNlbmQgbWUgdGhlIHJlc3VsdC48L3A+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgaWQ9InByb2JlQnRucyIgc3R5bGU9Im1hcmdp' +
  'bi10b3A6MTBweCI+JHtwb3J0YWxzLm1hcChwdCA9PgogICAgICAgIGA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBkYXRhLXBy' +
  'b2JlPSIke2VzYyhwdC5rZXkpfSI+JHtlc2MocHQubGFiZWwpfTwvYnV0dG9uPmApLmpvaW4oJycpfTwvZGl2PgogICAgICA8ZGl2' +
  'IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxpbnB1dCBpZD0icHJvYmVVcmwiIHBsYWNlaG9s' +
  'ZGVyPSLigKZvciBhIHNwZWNpZmljIHBhZ2UgVVJMIiBzdHlsZT0iZmxleDoxO21pbi13aWR0aDoxNTBweCI+CiAgICAgICAgPGJ1' +
  'dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9InByb2JlR28iPlByb2JlIFVSTDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAg' +
  'PHByZSBjbGFzcz0icHJldiIgaWQ9InByb2JlT3V0IiBzdHlsZT0iZGlzcGxheTpub25lO21hcmdpbi10b3A6MTBweCI+PC9wcmU+' +
  'CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20gYmxvY2siIGlkPSJjb3B5UHJvYmUiIHN0eWxlPSJkaXNwbGF5Om5vbmU7' +
  'bWFyZ2luLXRvcDo4cHgiPkNvcHkgcmVzdWx0PC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAg' +
  'ICAgPGgyPk15IGFjY291bnQ8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJoaW50Ij5PbmUgcGFzc3dvcmQsIGV2ZXJ5IGFwcC4gQ2hh' +
  'bmdpbmcgaXQgaGVyZSBjaGFuZ2VzIGl0IGV2ZXJ5d2hlcmUuPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+' +
  'Q3VycmVudCBwYXNzd29yZDwvbGFiZWw+PGlucHV0IGlkPSJvcHciIHR5cGU9InBhc3N3b3JkIiBwbGFjZWhvbGRlcj0idGhlIG9u' +
  'ZSB5b3Ugc2lnbmVkIGluIHdpdGgiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk5ldyBwYXNzd29yZDwv' +
  'bGFiZWw+PGlucHV0IGlkPSJucHciIHR5cGU9InBhc3N3b3JkIiBwbGFjZWhvbGRlcj0iOCsgY2hhcmFjdGVycyI+PC9kaXY+CiAg' +
  'ICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9InNhdmVQdyI+VXBkYXRlIHBhc3N3b3JkPC9idXR0b24+CiAgICAgIDxkaXYg' +
  'Y2xhc3M9ImhpbnQiIGlkPSJidWlsZFN0YW1wIiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij5idWlsZCDigKY8L2Rpdj4KICAgIDwv' +
  'ZGl2PmApOwogIGJpbmRTaGVsbCgpOwoKICBmZXRjaCgnL2FwaS9idWlsZCcpLnRoZW4ociA9PiByLmpzb24oKSkudGhlbihiID0+' +
  'IHsKICAgIGNvbnN0IGVsID0gJCgnI2J1aWxkU3RhbXAnKTsKICAgIGlmIChlbCkgZWwudGV4dENvbnRlbnQgPSAnU2VydmVUcmFj' +
  'ayBidWlsZCAnICsgYi5idWlsZCArIChiLnByb2JlVGFyZ2V0cyA/ICcgwrcgYm9vdCBwcm9iZSBhcm1lZCcgOiAnJyk7CiAgfSku' +
  'Y2F0Y2goKCkgPT4ge30pOwoKCiAgLyogLS0tLSBhY2Nlc3MgY29kZXMgLS0tLSAqLwogIGFzeW5jIGZ1bmN0aW9uIGRyYXdDb2Rl' +
  'cygpIHsKICAgICQoJyNjX2xpc3QnKS5pbm5lckhUTUwgPSBjb2Rlc1RhYmxlKGF3YWl0IGFwaSgnL2NvZGVzJykpOwogICAgd2ly' +
  'ZUNvZGVzKCk7CiAgfQoKICBmdW5jdGlvbiB3aXJlQ29kZXMoKSB7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0' +
  'YS1jb3B5XScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sgPSBhc3luYyBlID0+IHsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwog' +
  'ICAgICB0cnkgeyBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dChhLmRhdGFzZXQuY29weSk7IHRvYXN0KCdDb3Bp' +
  'ZWQgJyArIGEuZGF0YXNldC5jb3B5KTsgfQogICAgICBjYXRjaCAoZXJyKSB7IHRvYXN0KCdTZWxlY3QgaXQgYW5kIGNvcHkgYnkg' +
  'aGFuZCcsIHRydWUpOyB9CiAgICB9KTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXJldm9rZV0nKS5mb3JF' +
  'YWNoKGEgPT4gYS5vbmNsaWNrID0gYXN5bmMgZSA9PiB7CiAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgaWYgKCFjb25m' +
  'aXJtKCdSZXZva2UgdGhpcyBjb2RlPyBBbnlvbmUgd2hvIGFscmVhZHkgdXNlZCBpdCBrZWVwcyB0aGVpciBhY2NvdW50LicpKSBy' +
  'ZXR1cm47CiAgICAgIGF3YWl0IGFwaSgnL2NvZGVzLycgKyBhLmRhdGFzZXQucmV2b2tlLCB7IG1ldGhvZDogJ1BBVENIJywgYm9k' +
  'eTogSlNPTi5zdHJpbmdpZnkoeyByZXZva2VkOiB0cnVlIH0pIH0pOwogICAgICB0b2FzdCgnUmV2b2tlZCcpOyBkcmF3Q29kZXMo' +
  'KTsKICAgIH0pOwogIH0KICB3aXJlQ29kZXMoKTsKCiAgJCgnI2NfbWFrZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0' +
  'cnkgewogICAgICBjb25zdCBtYWRlID0gYXdhaXQgYXBpKCcvY29kZXMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0' +
  'cmluZ2lmeSh7CiAgICAgICAgcm9sZTogJCgnI2Nfcm9sZScpLnZhbHVlLAogICAgICAgIG1heF91c2VzOiAkKCcjY191c2VzJyku' +
  'dmFsdWUsCiAgICAgICAgZXhwaXJlc19hdDogJCgnI2NfZXhwJykudmFsdWUgfHwgbnVsbCwKICAgICAgICBkZWZhdWx0X3BheTog' +
  'JCgnI2NfcGF5JykudmFsdWUgfHwgMCwKICAgICAgICBub3RlOiAkKCcjY19ub3RlJykudmFsdWUKICAgICAgfSkgfSk7CiAgICAg' +
  'ICQoJyNjX25vdGUnKS52YWx1ZSA9ICcnOwogICAgICB0b2FzdCgnQ29kZSAnICsgbWFkZS5jb2RlKTsKICAgICAgZHJhd0NvZGVz' +
  'KCk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9OwogIGRyYXdDb2RlcygpLmNhdGNoKCgp' +
  'ID0+IHt9KTsKCiAgLyogLS0tLSBwb3J0YWwgcHJvYmUgLS0tLSAqLwogIGNvbnN0IHByb2JlT3V0ID0gJCgnI3Byb2JlT3V0Jyk7' +
  'CiAgY29uc3QgcnVuUHJvYmUgPSBhc3luYyBib2R5ID0+IHsKICAgIHByb2JlT3V0LnN0eWxlLmRpc3BsYXkgPSAnJzsKICAgIHBy' +
  'b2JlT3V0LnRleHRDb250ZW50ID0gJ1Byb2JpbmfigKYgKHRoaXMgY2FuIHRha2UgdXAgdG8gMjAgc2Vjb25kcyknOwogICAgJCgn' +
  'I2NvcHlQcm9iZScpLnN0eWxlLmRpc3BsYXkgPSAnJzsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9wb3J0' +
  'YWwtcHJvYmUnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KTsKICAgICAgcHJvYmVPdXQu' +
  'dGV4dENvbnRlbnQgPSBKU09OLnN0cmluZ2lmeShyLCBudWxsLCAyKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgcHJvYmVPdXQu' +
  'dGV4dENvbnRlbnQgPSAnUHJvYmUgZmFpbGVkOiAnICsgZS5tZXNzYWdlOwogICAgfQogIH07CiAgZG9jdW1lbnQucXVlcnlTZWxl' +
  'Y3RvckFsbCgnW2RhdGEtcHJvYmVdJykuZm9yRWFjaChiID0+CiAgICBiLm9uY2xpY2sgPSAoKSA9PiBydW5Qcm9iZSh7IHBvcnRh' +
  'bDogYi5kYXRhc2V0LnByb2JlIH0pKTsKICAkKCcjcHJvYmVHbycpLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBjb25zdCB1ID0gJCgn' +
  'I3Byb2JlVXJsJykudmFsdWUudHJpbSgpOwogICAgaWYgKHUpIHJ1blByb2JlKHsgdXJsOiB1IH0pOwogIH07CiAgJCgnI2NvcHlQ' +
  'cm9iZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgeyBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4' +
  'dChwcm9iZU91dC50ZXh0Q29udGVudCk7IHRvYXN0KCdDb3BpZWQnKTsgfQogICAgY2F0Y2ggKGUpIHsgdG9hc3QoJ1NlbGVjdCB0' +
  'aGUgdGV4dCBhbmQgY29weSBpdCBieSBoYW5kJywgdHJ1ZSk7IH0KICB9OwoKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdb' +
  'ZGF0YS11c2VyXScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sgPSBlID0+IHsKICAgIGUucHJldmVudERlZmF1bHQoKTsgdXNlckZv' +
  'cm0odXNlcnMuZmluZCh1ID0+IFN0cmluZyh1LmlkKSA9PT0gYS5kYXRhc2V0LnVzZXIpKTsKICB9KTsKICBkb2N1bWVudC5xdWVy' +
  'eVNlbGVjdG9yQWxsKCdbZGF0YS1jbGllbnRdJykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGUgPT4gewogICAgZS5wcmV2ZW50' +
  'RGVmYXVsdCgpOyBjbGllbnRGb3JtKGNsaWVudHMuZmluZChjID0+IFN0cmluZyhjLmlkKSA9PT0gYS5kYXRhc2V0LmNsaWVudCkp' +
  'OwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXRwbF0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNrID0g' +
  'ZSA9PiB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7IHRlbXBsYXRlRm9ybSh0ZW1wbGF0ZXMuZmluZCh0ID0+IFN0cmluZyh0Lmlk' +
  'KSA9PT0gYS5kYXRhc2V0LnRwbCkpOwogIH0pOwogIGNvbnN0IGNvU2F2ZSA9ICQoJyNjb1NhdmUnKTsKICBpZiAoY29TYXZlKSBj' +
  'b1NhdmUub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGF3YWl0IGFwaSgnL2NvbXBhbmllcy8nICsgKGhl' +
  'cmUuaWQpLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoewogICAgICAgIG5hbWU6ICQoJyNjb05hbWUn' +
  'KS52YWx1ZSwgY29udGFjdF9lbWFpbDogJCgnI2NvRW1haWwnKS52YWx1ZSwgcGhvbmU6ICQoJyNjb1Bob25lJykudmFsdWUgfSkg' +
  'fSk7CiAgICAgIFMubWUgPSBhd2FpdCBhcGkoJy9tZScpOwogICAgICB0b2FzdCgnQ29tcGFueSBzYXZlZCcpOwogICAgICByZW5k' +
  'ZXIoKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07CiAgY29uc3QgbmV3Q28gPSAkKCcj' +
  'bmV3Q28nKTsKICBpZiAobmV3Q28pIG5ld0NvLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBjb25zdCBuYW1lID0gJCgnI25l' +
  'd0NvTmFtZScpLnZhbHVlLnRyaW0oKTsKICAgIGlmICghbmFtZSkgcmV0dXJuIHRvYXN0KCdHaXZlIHRoZSBjb21wYW55IGEgbmFt' +
  'ZScsIHRydWUpOwogICAgdHJ5IHsKICAgICAgYXdhaXQgYXBpKCcvY29tcGFuaWVzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTog' +
  'SlNPTi5zdHJpbmdpZnkoeyBuYW1lIH0pIH0pOwogICAgICBTLm1lID0gYXdhaXQgYXBpKCcvbWUnKTsKICAgICAgdG9hc3QobmFt' +
  'ZSArICcgY3JlYXRlZCcpOwogICAgICByZW5kZXIoKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsg' +
  'fQogIH07CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtZW50ZXJdJykuZm9yRWFjaChhID0+IGEub25jbGljayA9' +
  'IGFzeW5jIGUgPT4gewogICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgdHJ5IHsKICAgICAgY29uc3Qgb3V0ID0gYXdhaXQgYXBp' +
  'KCcvY29tcGFuaWVzLycgKyBhLmRhdGFzZXQuZW50ZXIgKyAnL2VudGVyJywgeyBtZXRob2Q6ICdQT1NUJyB9KTsKICAgICAgUy5t' +
  'ZSA9IGF3YWl0IGFwaSgnL21lJyk7CiAgICAgIHRvYXN0KCdOb3cgaW4gJyArIG91dC5jb21wYW55Lm5hbWUpOwogICAgICByZW5k' +
  'ZXIoKTsKICAgIH0gY2F0Y2ggKGVycikgeyB0b2FzdChlcnIubWVzc2FnZSwgdHJ1ZSk7IH0KICB9KTsKICAkKCcjbmV3VXNlcicp' +
  'Lm9uY2xpY2sgPSAoKSA9PiB1c2VyRm9ybShudWxsKTsKICAkKCcjbmV3Q2xpZW50Jykub25jbGljayA9ICgpID0+IGNsaWVudEZv' +
  'cm0obnVsbCk7CiAgJCgnI25ld1RwbCcpLm9uY2xpY2sgPSAoKSA9PiB0ZW1wbGF0ZUZvcm0obnVsbCk7CiAgJCgnI3NhdmVQdycp' +
  'Lm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBjb25zdCByID0gYXdhaXQgYXBpKCcvbWUvcGFzc3dvcmQn' +
  'LCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgcGFzc3dvcmQ6ICQoJyNucHcnKS52YWx1' +
  'ZSwgb2xkX3Bhc3N3b3JkOiAkKCcjb3B3JykudmFsdWUgfSkgfSk7CiAgICAgICQoJyNvcHcnKS52YWx1ZSA9ICcnOyAkKCcjbnB3' +
  'JykudmFsdWUgPSAnJzsKICAgICAgdG9hc3Qoci5ldmVyeXdoZXJlID09PSBmYWxzZSA/ICdDaGFuZ2VkIGhlcmUg4oCUIG90aGVy' +
  'IGFwcHMgc3RpbGwgaGF2ZSB0aGUgb2xkIG9uZScgOiAnUGFzc3dvcmQgdXBkYXRlZCBldmVyeXdoZXJlJyk7CiAgICB9IGNhdGNo' +
  'IChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9Owp9CgpmdW5jdGlvbiB1c2VyRm9ybSh1KSB7CiAgY29uc3QgdiA9' +
  'IHUgfHwgeyByb2xlOiAnc2VydmVyJywgYWN0aXZlOiB0cnVlIH07CiAgc2hlZXQodSA/ICdFZGl0ICcgKyB1Lm5hbWUgOiAnQWRk' +
  'IHBlcnNvbicsIGAKICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+TmFtZTwvbGFiZWw+PGlucHV0IGlkPSJ1X25hbWUiIHZh' +
  'bHVlPSIke2VzYyh2Lm5hbWUpfSI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkVtYWlsICh1c2VkIHRvIHNp' +
  'Z24gaW4pPC9sYWJlbD48aW5wdXQgaWQ9InVfZW1haWwiIHR5cGU9ImVtYWlsIiB2YWx1ZT0iJHtlc2Modi5lbWFpbCl9Ij48L2Rp' +
  'dj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+JHt1ID8gJ05ldyBwYXNzd29yZCAobGVhdmUgYmxhbmsgdG8ga2VlcCkn' +
  'IDogJ1Bhc3N3b3JkJ308L2xhYmVsPjxpbnB1dCBpZD0idV9wYXNzd29yZCIgdHlwZT0idGV4dCIgcGxhY2Vob2xkZXI9IiR7dSA/' +
  'ICd1bmNoYW5nZWQnIDogJ3NldCBhIHBhc3N3b3JkJ30iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgIDxk' +
  'aXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Um9sZTwvbGFiZWw+PHNlbGVjdCBpZD0idV9yb2xlIj4KICAgICAgICA8b3B0aW9uIHZh' +
  'bHVlPSJzZXJ2ZXIiICR7di5yb2xlID09PSAnc2VydmVyJyA/ICdzZWxlY3RlZCcgOiAnJ30+RmllbGQgc2VydmVyPC9vcHRpb24+' +
  'CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYWRtaW4iICR7di5yb2xlID09PSAnYWRtaW4nID8gJ3NlbGVjdGVkJyA6ICcnfT5BZG1p' +
  'bjwvb3B0aW9uPgogICAgICAgICR7aXNPd25lcigpID8gYDxvcHRpb24gdmFsdWU9Im93bmVyIiAke3Yucm9sZSA9PT0gJ293bmVy' +
  'JyA/ICdzZWxlY3RlZCcgOiAnJ30+T3duZXIgKGV2ZXJ5IGNvbXBhbnkpPC9vcHRpb24+YCA6ICcnfQogICAgICA8L3NlbGVjdD48' +
  'L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5EZWZhdWx0IHBheSBwZXIgc2VydmU8L2xhYmVsPjxpbnB1dCBp' +
  'ZD0idV9kZWZhdWx0X3BheSIgdHlwZT0ibnVtYmVyIiBzdGVwPSIwLjAxIiB2YWx1ZT0iJHt2LmRlZmF1bHRfcGF5IHx8ICcnfSI+' +
  'PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGhvbmU8L2xhYmVsPjxpbnB1dCBpZD0idV9waG9uZSIgdmFs' +
  'dWU9IiR7ZXNjKHYucGhvbmUpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+TGljZW5zZSAvIHJlZ2lz' +
  'dHJhdGlvbiAjPC9sYWJlbD48aW5wdXQgaWQ9InVfbGljZW5zZV9ubyIgdmFsdWU9IiR7ZXNjKHYubGljZW5zZV9ubyl9Ij48L2Rp' +
  'dj4KICAgIDwvZGl2PgogICAgJHt1ID8gYDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U3RhdHVzPC9sYWJlbD48c2VsZWN0IGlk' +
  'PSJ1X2FjdGl2ZSI+CiAgICAgIDxvcHRpb24gdmFsdWU9InRydWUiICR7di5hY3RpdmUgPyAnc2VsZWN0ZWQnIDogJyd9PkFjdGl2' +
  'ZTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJmYWxzZSIgJHshdi5hY3RpdmUgPyAnc2VsZWN0ZWQnIDogJyd9PkRlYWN0' +
  'aXZhdGVkPC9vcHRpb24+PC9zZWxlY3Q+PC9kaXY+YCA6ICcnfQogICAgPGRpdiBjbGFzcz0icm93Ij48YnV0dG9uIGNsYXNzPSJi' +
  'dG4iIGlkPSJzYXZlIj5TYXZlPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0' +
  'KCkiPkNhbmNlbDwvYnV0dG9uPjwvZGl2PmAsIGVsID0+IHsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNzYXZlJykub25jbGljayA9' +
  'IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgYm9keSA9IHsKICAgICAgICBuYW1lOiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9uYW1l' +
  'JykudmFsdWUsIGVtYWlsOiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9lbWFpbCcpLnZhbHVlLAogICAgICAgIHJvbGU6IGVsLnF1ZXJ5' +
  'U2VsZWN0b3IoJyN1X3JvbGUnKS52YWx1ZSwgcGhvbmU6IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X3Bob25lJykudmFsdWUsCiAgICAg' +
  'ICAgbGljZW5zZV9ubzogZWwucXVlcnlTZWxlY3RvcignI3VfbGljZW5zZV9ubycpLnZhbHVlLAogICAgICAgIGRlZmF1bHRfcGF5' +
  'OiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9kZWZhdWx0X3BheScpLnZhbHVlIHx8IDAKICAgICAgfTsKICAgICAgY29uc3QgcHcgPSBl' +
  'bC5xdWVyeVNlbGVjdG9yKCcjdV9wYXNzd29yZCcpLnZhbHVlOwogICAgICBpZiAocHcpIGJvZHkucGFzc3dvcmQgPSBwdzsKICAg' +
  'ICAgaWYgKHUpIGJvZHkuYWN0aXZlID0gZWwucXVlcnlTZWxlY3RvcignI3VfYWN0aXZlJykudmFsdWUgPT09ICd0cnVlJzsKICAg' +
  'ICAgdHJ5IHsKICAgICAgICBhd2FpdCAodSA/IGFwaSgnL3VzZXJzLycgKyB1LmlkLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTog' +
  'SlNPTi5zdHJpbmdpZnkoYm9keSkgfSkKICAgICAgICAgICAgICAgICA6IGFwaSgnL3VzZXJzJywgeyBtZXRob2Q6ICdQT1NUJywg' +
  'Ym9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSkpOwogICAgICAgIGNsb3NlU2hlZXQoKTsgdG9hc3QoJ1NhdmVkJyk7IGdvKCdh' +
  'ZG1pbicpOwogICAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICAgIH07CiAgfSk7Cn0KCmZ1bmN0' +
  'aW9uIGNsaWVudEZvcm0oYykgewogIGNvbnN0IHYgPSBjIHx8IHt9OwogIHNoZWV0KGMgPyAnRWRpdCAnICsgYy5uYW1lIDogJ0Fk' +
  'ZCBjbGllbnQnLCBgCiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkZpcm0gLyBjbGllbnQgbmFtZTwvbGFiZWw+PGlucHV0' +
  'IGlkPSJjX25hbWUiIHZhbHVlPSIke2VzYyh2Lm5hbWUpfSI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAg' +
  'PGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Db250YWN0PC9sYWJlbD48aW5wdXQgaWQ9ImNfY29udGFjdF9uYW1lIiB2YWx1ZT0i' +
  'JHtlc2Modi5jb250YWN0X25hbWUpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGhvbmU8L2xhYmVs' +
  'PjxpbnB1dCBpZD0iY19waG9uZSIgdmFsdWU9IiR7ZXNjKHYucGhvbmUpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxk' +
  'Ij48bGFiZWw+RW1haWw8L2xhYmVsPjxpbnB1dCBpZD0iY19lbWFpbCIgdHlwZT0iZW1haWwiIHZhbHVlPSIke2VzYyh2LmVtYWls' +
  'KX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkRlZmF1bHQgZmVlIHBlciBzZXJ2ZTwvbGFiZWw+PGlu' +
  'cHV0IGlkPSJjX2RlZmF1bHRfZmVlIiB0eXBlPSJudW1iZXIiIHN0ZXA9IjAuMDEiIHZhbHVlPSIke3YuZGVmYXVsdF9mZWUgfHwg' +
  'Jyd9Ij48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5CaWxsaW5nIGFkZHJlc3M8L2xhYmVs' +
  'Pjx0ZXh0YXJlYSBpZD0iY19hZGRyZXNzIiBzdHlsZT0ibWluLWhlaWdodDo2MHB4Ij4ke2VzYyh2LmFkZHJlc3MpfTwvdGV4dGFy' +
  'ZWE+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk5vdGVzPC9sYWJlbD48dGV4dGFyZWEgaWQ9ImNfbm90ZXMi' +
  'IHN0eWxlPSJtaW4taGVpZ2h0OjYwcHgiPiR7ZXNjKHYubm90ZXMpfTwvdGV4dGFyZWE+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJy' +
  'b3ciPjxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InNhdmUiPlNhdmU8L2J1dHRvbj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMi' +
  'IG9uY2xpY2s9ImNsb3NlU2hlZXQoKSI+Q2FuY2VsPC9idXR0b24+PC9kaXY+YCwgZWwgPT4gewogICAgZWwucXVlcnlTZWxlY3Rv' +
  'cignI3NhdmUnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBib2R5ID0ge307CiAgICAgIFsnbmFtZScsJ2Nv' +
  'bnRhY3RfbmFtZScsJ3Bob25lJywnZW1haWwnLCdkZWZhdWx0X2ZlZScsJ2FkZHJlc3MnLCdub3RlcyddCiAgICAgICAgLmZvckVh' +
  'Y2goZiA9PiBib2R5W2ZdID0gZWwucXVlcnlTZWxlY3RvcignI2NfJyArIGYpLnZhbHVlKTsKICAgICAgdHJ5IHsKICAgICAgICBh' +
  'd2FpdCAoYyA/IGFwaSgnL2NsaWVudHMvJyArIGMuaWQsIHsgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBKU09OLnN0cmluZ2lmeShi' +
  'b2R5KSB9KQogICAgICAgICAgICAgICAgIDogYXBpKCcvY2xpZW50cycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3Ry' +
  'aW5naWZ5KGJvZHkpIH0pKTsKICAgICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KCdTYXZlZCcpOyBnbygnYWRtaW4nKTsKICAgICAg' +
  'fSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgICB9OwogIH0pOwp9Cgphc3luYyBmdW5jdGlvbiB0ZW1w' +
  'bGF0ZUZvcm0odCkgewogIGNvbnN0IGZpZWxkcyA9IGF3YWl0IGFwaSgnL3RlbXBsYXRlLWZpZWxkcycpOwogIGNvbnN0IHYgPSB0' +
  'IHx8IHsgYm9keTogJycsIGlzX2RlZmF1bHQ6IGZhbHNlIH07CiAgc2hlZXQodCA/ICdFZGl0IHRlbXBsYXRlJyA6ICdOZXcgYWZm' +
  'aWRhdml0IHRlbXBsYXRlJywgYAogICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFi' +
  'ZWw+VGVtcGxhdGUgbmFtZTwvbGFiZWw+PGlucHV0IGlkPSJ0X25hbWUiIHZhbHVlPSIke2VzYyh2Lm5hbWUpfSI+PC9kaXY+CiAg' +
  'ICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+SnVyaXNkaWN0aW9uIC8gY291cnQ8L2xhYmVsPjxpbnB1dCBpZD0idF9qdXJp' +
  'c2RpY3Rpb24iIHZhbHVlPSIke2VzYyh2Lmp1cmlzZGljdGlvbil9Ij48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0i' +
  'ZmllbGQiPjxsYWJlbD5Cb2R5PC9sYWJlbD4KICAgICAgPHRleHRhcmVhIGlkPSJ0X2JvZHkiIHN0eWxlPSJtaW4taGVpZ2h0OjIy' +
  'MHB4O2ZvbnQ6MTIuNXB4LzEuNSAnQ291cmllciBOZXcnLG1vbm9zcGFjZSI+JHtlc2Modi5ib2R5KX08L3RleHRhcmVhPgogICAg' +
  'ICA8ZGl2IGNsYXNzPSJoaW50Ij5DbGljayBhIGZpZWxkIHRvIGluc2VydCBpdCBhdCB0aGUgY3Vyc29yOjwvZGl2PgogICAgICA8' +
  'ZGl2IGNsYXNzPSJ0b2tlbnMiPiR7ZmllbGRzLm1hcChmID0+IGA8YnV0dG9uIGRhdGEtZj0iJHtmWzBdfSIgdGl0bGU9IiR7ZXNj' +
  'KGZbMV0pfSI+e3ske2ZbMF19fX08L2J1dHRvbj5gKS5qb2luKCcnKX08L2Rpdj4KICAgIDwvZGl2PgogICAgPGxhYmVsIHN0eWxl' +
  'PSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHgiPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgaWQ9InRfZGVm' +
  'YXVsdCIgc3R5bGU9IndpZHRoOmF1dG8iICR7di5pc19kZWZhdWx0ID8gJ2NoZWNrZWQnIDogJyd9PiBVc2UgYXMgdGhlIGRlZmF1' +
  'bHQgdGVtcGxhdGU8L2xhYmVsPgogICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij4KICAgICAgPGJ1' +
  'dHRvbiBjbGFzcz0iYnRuIiBpZD0ic2F2ZSI+U2F2ZTwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBpZD0i' +
  'cHJldmlldyI+UHJldmlldyB3aXRoIHJlYWwgam9iPC9idXR0b24+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIG9uY2xp' +
  'Y2s9ImNsb3NlU2hlZXQoKSI+Q2FuY2VsPC9idXR0b24+CiAgICAgICR7dCA/ICc8YnV0dG9uIGNsYXNzPSJidG4gZ2hvc3QiIGlk' +
  'PSJkZWwiIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQpO21hcmdpbi1sZWZ0OmF1dG8iPkRlbGV0ZTwvYnV0dG9uPicgOiAnJ30KICAg' +
  'IDwvZGl2PgogICAgPHByZSBjbGFzcz0icHJldiIgaWQ9InRwcmV2IiBzdHlsZT0iZGlzcGxheTpub25lO21hcmdpbi10b3A6MTJw' +
  'eCI+PC9wcmU+YCwgZWwgPT4gewogICAgY29uc3QgdGEgPSBlbC5xdWVyeVNlbGVjdG9yKCcjdF9ib2R5Jyk7CiAgICBlbC5xdWVy' +
  'eVNlbGVjdG9yQWxsKCdbZGF0YS1mXScpLmZvckVhY2goYiA9PiBiLm9uY2xpY2sgPSAoKSA9PiB7CiAgICAgIGNvbnN0IHRvayA9' +
  'ICd7eycgKyBiLmRhdGFzZXQuZiArICd9fSc7CiAgICAgIGNvbnN0IHMgPSB0YS5zZWxlY3Rpb25TdGFydCwgZSA9IHRhLnNlbGVj' +
  'dGlvbkVuZDsKICAgICAgdGEudmFsdWUgPSB0YS52YWx1ZS5zbGljZSgwLCBzKSArIHRvayArIHRhLnZhbHVlLnNsaWNlKGUpOwog' +
  'ICAgICB0YS5mb2N1cygpOyB0YS5zZWxlY3Rpb25TdGFydCA9IHRhLnNlbGVjdGlvbkVuZCA9IHMgKyB0b2subGVuZ3RoOwogICAg' +
  'fSk7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjcHJldmlldycpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IHIg' +
  'PSBhd2FpdCBhcGkoJy90ZW1wbGF0ZXMvcHJldmlldycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsg' +
  'Ym9keTogdGEudmFsdWUgfSkgfSk7CiAgICAgIGNvbnN0IHAgPSBlbC5xdWVyeVNlbGVjdG9yKCcjdHByZXYnKTsKICAgICAgcC5z' +
  'dHlsZS5kaXNwbGF5ID0gJyc7IHAudGV4dENvbnRlbnQgPSByLnRleHQ7CiAgICB9OwogICAgZWwucXVlcnlTZWxlY3RvcignI3Nh' +
  'dmUnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBib2R5ID0gewogICAgICAgIG5hbWU6IGVsLnF1ZXJ5U2Vs' +
  'ZWN0b3IoJyN0X25hbWUnKS52YWx1ZSwganVyaXNkaWN0aW9uOiBlbC5xdWVyeVNlbGVjdG9yKCcjdF9qdXJpc2RpY3Rpb24nKS52' +
  'YWx1ZSwKICAgICAgICBib2R5OiB0YS52YWx1ZSwgaXNfZGVmYXVsdDogZWwucXVlcnlTZWxlY3RvcignI3RfZGVmYXVsdCcpLmNo' +
  'ZWNrZWQKICAgICAgfTsKICAgICAgaWYgKCFib2R5Lm5hbWUudHJpbSgpKSByZXR1cm4gdG9hc3QoJ0dpdmUgdGhlIHRlbXBsYXRl' +
  'IGEgbmFtZScsIHRydWUpOwogICAgICB0cnkgewogICAgICAgIGF3YWl0ICh0ID8gYXBpKCcvdGVtcGxhdGVzLycgKyB0LmlkLCB7' +
  'IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSkKICAgICAgICAgICAgICAgICA6IGFwaSgnL3Rl' +
  'bXBsYXRlcycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pKTsKICAgICAgICBjbG9zZVNo' +
  'ZWV0KCk7IHRvYXN0KCdTYXZlZCcpOyBnbygnYWRtaW4nKTsKICAgICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRy' +
  'dWUpOyB9CiAgICB9OwogICAgaWYgKGVsLnF1ZXJ5U2VsZWN0b3IoJyNkZWwnKSkgZWwucXVlcnlTZWxlY3RvcignI2RlbCcpLm9u' +
  'Y2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGlmICghY29uZmlybSgnRGVsZXRlIHRoaXMgdGVtcGxhdGU/JykpIHJldHVybjsK' +
  'ICAgICAgYXdhaXQgYXBpKCcvdGVtcGxhdGVzLycgKyB0LmlkLCB7IG1ldGhvZDogJ0RFTEVURScgfSk7CiAgICAgIGNsb3NlU2hl' +
  'ZXQoKTsgdG9hc3QoJ0RlbGV0ZWQnKTsgZ28oJ2FkbWluJyk7CiAgICB9OwogIH0pOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gYm9vdCAtLSAqLwpjb25zdCBWSUVXUyA9IHsgZGFz' +
  'aDogZGFzaFZpZXcsIGpvYnM6IGpvYnNWaWV3LCBqb2I6IGpvYlZpZXcsIHNjYW46IHNjYW5WaWV3LAogIHRvb2xzOiB0b29sc1Zp' +
  'ZXcsIHByb3BlcnR5OiBwcm9wZXJ0eVZpZXcsIG1vbmV5OiBtb25leVZpZXcsIGFkbWluOiBhZG1pblZpZXcgfTsKCmFzeW5jIGZ1' +
  'bmN0aW9uIHJlbmRlcigpIHsKICBjbG9zZVNoZWV0KCk7CiAgaWYgKCFTLm1lKSByZXR1cm4gbG9naW5WaWV3KCk7CiAgaWYgKFMu' +
  'dmlldyA9PT0gJ2pvYnMnKSBTLmNhY2hlLmpvYkZpbHRlciA9IFMucGFyYW1zOwogIGNvbnN0IGZuID0gVklFV1NbUy52aWV3XSB8' +
  'fCBkYXNoVmlldzsKICB0cnkgewogICAgYXBwLmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJ3cmFwIj48ZGl2IGNsYXNzPSJlbXB0' +
  'eSI+TG9hZGluZ+KApjwvZGl2PjwvZGl2Pic7CiAgICBhd2FpdCBmbigpOwogIH0gY2F0Y2ggKGUpIHsKICAgIGlmIChTLm1lKSB7' +
  'IGFwcC5pbm5lckhUTUwgPSBzaGVsbChgPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0iZW1wdHkiPiR7ZXNjKGUubWVzc2Fn' +
  'ZSl9PC9kaXY+PC9kaXY+YCk7IGJpbmRTaGVsbCgpOyB9CiAgfQp9CgooYXN5bmMgZnVuY3Rpb24gYm9vdCgpIHsKICB0cnkgeyBT' +
  'Lm1lID0gYXdhaXQgYXBpKCcvbWUnKTsgfSBjYXRjaCAoZSkgeyBTLm1lID0gbnVsbDsgfQogIHJlbmRlcigpOwp9KSgpOwp9KSgp' +
  'OwoKPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo='
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
const BUILD = '2026-08-31.18';           // shown in Setup so uploads can be confirmed
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
