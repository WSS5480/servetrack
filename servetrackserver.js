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
  'PG1ldGEgbmFtZT0idGhlbWUtY29sb3IiIGNvbnRlbnQ9IiMwQjRGRDMiPgo8dGl0bGU+U2VydmVUcmFjazwvdGl0bGU+CjxsaW5r' +
  'IHJlbD0ibWFuaWZlc3QiIGhyZWY9Ii9tYW5pZmVzdC53ZWJtYW5pZmVzdCI+CjxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWIt' +
  'YXBwLWNhcGFibGUiIGNvbnRlbnQ9InllcyI+CjxtZXRhIG5hbWU9ImFwcGxlLW1vYmlsZS13ZWItYXBwLXN0YXR1cy1iYXItc3R5' +
  'bGUiIGNvbnRlbnQ9ImJsYWNrLXRyYW5zbHVjZW50Ij4KPG1ldGEgbmFtZT0iYXBwbGUtbW9iaWxlLXdlYi1hcHAtdGl0bGUiIGNv' +
  'bnRlbnQ9IlNlcnZlVHJhY2siPgo8bGluayByZWw9ImFwcGxlLXRvdWNoLWljb24iIGhyZWY9Ii9hcHBsZS10b3VjaC1pY29uLnBu' +
  'ZyI+CjxzdHlsZT4KLyogUlRPNFUgaG91c2UgY29sb3VyczogdGhlIHJveWFsIGJsdWUgY2FycmllcyBzdHJ1Y3R1cmUsIHRoZSBv' +
  'cmFuZ2UgaXMgc3BlbnQKICAgb25seSBvbiB0aGUgb25lIGFjdGlvbiB0aGF0IG1hdHRlcnMgb24gYSBzY3JlZW4uICovCjpyb290' +
  'ewogIC0tYmc6I0VERjJGQjsgLS1jYXJkOiNmZmY7IC0taW5rOiMxMDE4MjI7IC0tbXV0ZWQ6IzVBNkE4MDsgLS1saW5lOiNEQkU0' +
  'RjI7CiAgLS1icmFuZDojMEI0RkQzOyAtLWJyYW5kLTI6IzBBM0ZBODsgLS1hY2NlbnQ6I0YyNjYwRDsgLS1hY2NlbnQtMjojRDk1' +
  'NTBBOwogIC0tb2s6IzBGN0I0NTsgLS13YXJuOiNCNDUzMDk7IC0tYmFkOiNCNDIzMTg7IC0tcnVzaDojQzI0MTBDOwogIC0tcjox' +
  'MnB4OyAtLXNoOjAgMXB4IDJweCByZ2JhKDExLDQwLDkwLC4wNiksMCAycHggNnB4IHJnYmEoMTEsNDAsOTAsLjA4KTsKfQoqe2Jv' +
  'eC1zaXppbmc6Ym9yZGVyLWJveH0KaHRtbCxib2R5e21hcmdpbjowO3BhZGRpbmc6MH0KLyogVGhlIHN0aWNreSBoZWFkZXIgYW5k' +
  'IGZpeGVkIHRhYiBiYXIgb3ZlcmxhcCB0aGUgdmlld3BvcnQsIHNvIGFueXRoaW5nIHRoZQogICBicm93c2VyIHNjcm9sbHMgaW50' +
  'byB2aWV3IGNhbiBsYW5kIHVuZGVybmVhdGggdGhlbSBhbmQgc3dhbGxvdyB0aGUgdGFwLgogICBTY3JvbGwgcGFkZGluZyBrZWVw' +
  'cyBzY3JvbGxlZC10byBjb250ZW50IGNsZWFyIG9mIGJvdGguICovCmh0bWx7c2Nyb2xsLXBhZGRpbmctdG9wOjc2cHg7c2Nyb2xs' +
  'LXBhZGRpbmctYm90dG9tOjk2cHh9CmJvZHl7CiAgZm9udDoxNXB4LzEuNSAtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9u' +
  'dCwiU2Vnb2UgVUkiLFJvYm90byxIZWx2ZXRpY2EsQXJpYWwsc2Fucy1zZXJpZjsKICBiYWNrZ3JvdW5kOnZhcigtLWJnKTsgY29s' +
  'b3I6dmFyKC0taW5rKTsgLXdlYmtpdC10ZXh0LXNpemUtYWRqdXN0OjEwMCU7Cn0KYXtjb2xvcjp2YXIoLS1icmFuZC0yKX0KYnV0' +
  'dG9uLGlucHV0LHNlbGVjdCx0ZXh0YXJlYXtmb250OmluaGVyaXQ7Y29sb3I6aW5oZXJpdH0KCi8qIC0tLS0tLS0tLS0gc2hlbGwg' +
  'LS0tLS0tLS0tLSAqLwojYXBwe21pbi1oZWlnaHQ6MTAwdmh9Ci50b3BiYXJ7CiAgcG9zaXRpb246c3RpY2t5O3RvcDowO3otaW5k' +
  'ZXg6MjA7YmFja2dyb3VuZDp2YXIoLS1icmFuZCk7Y29sb3I6I2ZmZjsKICBkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVy' +
  'O2dhcDoxMHB4O3BhZGRpbmc6MTJweCAxNHB4OwogIHBhZGRpbmctdG9wOmNhbGMoMTJweCArIGVudihzYWZlLWFyZWEtaW5zZXQt' +
  'dG9wKSk7Cn0KLnRvcGJhciAuYnJhbmR7Zm9udC13ZWlnaHQ6NzAwO2xldHRlci1zcGFjaW5nOi4ycHh9Ci50b3BiYXIgLmJyYW5k' +
  'IHNtYWxse2Rpc3BsYXk6YmxvY2s7Zm9udC13ZWlnaHQ6NDAwO2ZvbnQtc2l6ZToxMXB4O29wYWNpdHk6LjgyO2xldHRlci1zcGFj' +
  'aW5nOi40cHh9Ci50b3BiYXIgLnNwYWNlcntmbGV4OjF9Ci50b3BiYXIgYnV0dG9ue2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1' +
  'NSwuMTQpO2JvcmRlcjowO2NvbG9yOiNmZmY7cGFkZGluZzo3cHggMTJweDtib3JkZXItcmFkaXVzOjhweH0KLndyYXB7bWF4LXdp' +
  'ZHRoOjExMDBweDttYXJnaW46MCBhdXRvO3BhZGRpbmc6MTRweCAxNHB4IDk2cHh9CgovKiBib3R0b20gdGFicyAobW9iaWxlKSAq' +
  'LwoudGFic3sKICBwb3NpdGlvbjpmaXhlZDtsZWZ0OjA7cmlnaHQ6MDtib3R0b206MDt6LWluZGV4OjMwO2JhY2tncm91bmQ6I2Zm' +
  'Zjtib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1saW5lKTsKICBkaXNwbGF5OmZsZXg7cGFkZGluZy1ib3R0b206ZW52KHNhZmUt' +
  'YXJlYS1pbnNldC1ib3R0b20pOwp9Ci50YWJzIGJ1dHRvbnsKICBmbGV4OjE7YmFja2dyb3VuZDpub25lO2JvcmRlcjowO3BhZGRp' +
  'bmc6OXB4IDFweCAxMHB4O2ZvbnQtc2l6ZToxMHB4O2NvbG9yOnZhcigtLW11dGVkKTsKICBkaXNwbGF5OmZsZXg7ZmxleC1kaXJl' +
  'Y3Rpb246Y29sdW1uO2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6M3B4OwogIG1pbi13aWR0aDowO3doaXRlLXNwYWNlOm5vd3JhcDts' +
  'ZXR0ZXItc3BhY2luZzotLjFweDsKfQoudGFicyBidXR0b24gLmlje2ZvbnQtc2l6ZToxOXB4O2xpbmUtaGVpZ2h0OjF9Ci50YWJz' +
  'IGJ1dHRvbi5vbntjb2xvcjp2YXIoLS1icmFuZCk7Zm9udC13ZWlnaHQ6NjAwfQoKLyogLS0tLS0tLS0tLSBwaWVjZXMgLS0tLS0t' +
  'LS0tLSAqLwouY2FyZHtiYWNrZ3JvdW5kOnZhcigtLWNhcmQpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJh' +
  'ZGl1czp2YXIoLS1yKTtib3gtc2hhZG93OnZhcigtLXNoKTtwYWRkaW5nOjE0cHg7bWFyZ2luLWJvdHRvbToxMnB4fQouY2FyZCBo' +
  'MnttYXJnaW46MCAwIDEwcHg7Zm9udC1zaXplOjE1cHh9Ci5jYXJkIGgyIC5zdWJ7Zm9udC13ZWlnaHQ6NDAwO2NvbG9yOnZhcigt' +
  'LW11dGVkKTtmb250LXNpemU6MTJweH0KaDEucGFnZXtmb250LXNpemU6MjBweDttYXJnaW46NHB4IDAgMTRweH0KLnJvd3tkaXNw' +
  'bGF5OmZsZXg7Z2FwOjhweDtmbGV4LXdyYXA6d3JhcDthbGlnbi1pdGVtczpjZW50ZXJ9Ci5ncmlke2Rpc3BsYXk6Z3JpZDtnYXA6' +
  'MTBweH0KQG1lZGlhKG1pbi13aWR0aDo3MjBweCl7IC5nMntncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDFmcn0gLmcze2dyaWQt' +
  'dGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMywxZnIpfSB9Cgouc3RhdHN7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1u' +
  'czpyZXBlYXQoMiwxZnIpO2dhcDoxMHB4O21hcmdpbi1ib3R0b206MTJweH0KQG1lZGlhKG1pbi13aWR0aDo3MjBweCl7LnN0YXRz' +
  'e2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNCwxZnIpfX0KLnN0YXR7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoxcHggc29s' +
  'aWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yKTtwYWRkaW5nOjEycHg7Ym94LXNoYWRvdzp2YXIoLS1zaCl9Ci5z' +
  'dGF0IC5ue2ZvbnQtc2l6ZToyNnB4O2ZvbnQtd2VpZ2h0OjcwMDtsaW5lLWhlaWdodDoxLjF9Ci5zdGF0IC5se2ZvbnQtc2l6ZTox' +
  'MnB4O2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW4tdG9wOjJweH0KLnN0YXQuYWxlcnQgLm57Y29sb3I6dmFyKC0tYmFkKX0KLnN0' +
  'YXQuZ29vZCAubntjb2xvcjp2YXIoLS1vayl9CgouYnRue2JhY2tncm91bmQ6dmFyKC0tYWNjZW50KTtjb2xvcjojZmZmO2JvcmRl' +
  'cjowO3BhZGRpbmc6MTFweCAxNnB4O2JvcmRlci1yYWRpdXM6OTk5cHg7CiAgZm9udC13ZWlnaHQ6NzAwO2N1cnNvcjpwb2ludGVy' +
  'O2JveC1zaGFkb3c6MCAxcHggMnB4IHJnYmEoMTgwLDcwLDEwLC4yNSl9Ci5idG46YWN0aXZle2JhY2tncm91bmQ6dmFyKC0tYWNj' +
  'ZW50LTIpfQouYnRuLnNlY3tiYWNrZ3JvdW5kOiNmZmY7Y29sb3I6dmFyKC0tYnJhbmQpO2JvcmRlcjoxLjVweCBzb2xpZCB2YXIo' +
  'LS1icmFuZCk7Ym94LXNoYWRvdzpub25lfQouYnRuLmJsdWV7YmFja2dyb3VuZDp2YXIoLS1icmFuZCl9Ci5idG4uZ2hvc3R7YmFj' +
  'a2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjp2YXIoLS1icmFuZC0yKTtib3JkZXI6MDtwYWRkaW5nOjhweCA0cHg7Zm9udC13ZWln' +
  'aHQ6NjAwO2JveC1zaGFkb3c6bm9uZX0KLmJ0bi5uYXZ7YmFja2dyb3VuZDp2YXIoLS1icmFuZCl9Ci5idG4ub2t7YmFja2dyb3Vu' +
  'ZDp2YXIoLS1vayl9Ci5idG4uYmFke2JhY2tncm91bmQ6dmFyKC0tYmFkKX0KLmJ0bi5zbXtwYWRkaW5nOjdweCAxMXB4O2ZvbnQt' +
  'c2l6ZToxM3B4O2JvcmRlci1yYWRpdXM6OHB4fQouYnRuLmJsb2Nre3dpZHRoOjEwMCU7ZGlzcGxheTpibG9ja30KLmJ0bltkaXNh' +
  'YmxlZF17b3BhY2l0eTouNX0KCmxhYmVse2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NjAwO2NvbG9y' +
  'OnZhcigtLW11dGVkKTttYXJnaW46MCAwIDRweH0KaW5wdXQsc2VsZWN0LHRleHRhcmVhewogIHdpZHRoOjEwMCU7cGFkZGluZzox' +
  'MXB4IDEycHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEwcHg7YmFja2dyb3VuZDojZmZmOwp9' +
  'CmlucHV0OmZvY3VzLHNlbGVjdDpmb2N1cyx0ZXh0YXJlYTpmb2N1c3tvdXRsaW5lOjJweCBzb2xpZCAjQkJEMkY3O2JvcmRlci1j' +
  'b2xvcjp2YXIoLS1icmFuZCl9CnRleHRhcmVhe21pbi1oZWlnaHQ6OTBweDtyZXNpemU6dmVydGljYWx9Ci5maWVsZHttYXJnaW4t' +
  'Ym90dG9tOjEwcHh9Ci5oaW50e2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW4tdG9wOjRweH0KCi5saXN0' +
  'e2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjhweH0KLml0ZW17CiAgYmFja2dyb3VuZDojZmZmO2JvcmRl' +
  'cjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLWxlZnQ6NHB4IHNvbGlkIHZhcigtLWxpbmUpOwogIGJvcmRlci1yYWRpdXM6' +
  'dmFyKC0tcik7cGFkZGluZzoxMXB4IDEycHg7Ym94LXNoYWRvdzp2YXIoLS1zaCk7Y3Vyc29yOnBvaW50ZXI7Cn0KLml0ZW0ucC1S' +
  'dXNoe2JvcmRlci1sZWZ0LWNvbG9yOnZhcigtLXdhcm4pfQouaXRlbS5wLVNhbWVEYXl7Ym9yZGVyLWxlZnQtY29sb3I6dmFyKC0t' +
  'cnVzaCl9Ci5pdGVtLm92ZXJkdWV7Ym9yZGVyLWxlZnQtY29sb3I6dmFyKC0tYmFkKX0KLml0ZW0gLnR7Zm9udC13ZWlnaHQ6NjAw' +
  'fQouaXRlbSAubXtmb250LXNpemU6MTIuNXB4O2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW4tdG9wOjJweH0KLml0ZW0gLnJ7ZGlz' +
  'cGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7Z2FwOjEwcHh9Cgou' +
  'cGlsbHtkaXNwbGF5OmlubGluZS1ibG9jaztmb250LXNpemU6MTFweDtmb250LXdlaWdodDo3MDA7cGFkZGluZzozcHggOHB4O2Jv' +
  'cmRlci1yYWRpdXM6OTlweDtiYWNrZ3JvdW5kOiNFOEVFRjg7Y29sb3I6IzNDNEM2Njt3aGl0ZS1zcGFjZTpub3dyYXB9Ci5waWxs' +
  'LlNlcnZlZHtiYWNrZ3JvdW5kOiNlM2Y1ZWE7Y29sb3I6dmFyKC0tb2spfQoucGlsbC5QZW5kaW5ne2JhY2tncm91bmQ6I2ZkZjBl' +
  'Mztjb2xvcjp2YXIoLS13YXJuKX0KLnBpbGwuQXNzaWduZWR7YmFja2dyb3VuZDojRTNFQ0ZEO2NvbG9yOnZhcigtLWJyYW5kLTIp' +
  'fQoucGlsbC5BdHRlbXB0ZWR7YmFja2dyb3VuZDojZmRmM2QzO2NvbG9yOiM4YTYxMDB9Ci5waWxsLk5vbkVzdHtiYWNrZ3JvdW5k' +
  'OiNmZGU4ZTY7Y29sb3I6dmFyKC0tYmFkKX0KLnBpbGwuQ2FuY2VsbGVkLC5waWxsLk9uSG9sZHtiYWNrZ3JvdW5kOiNlY2VmZjM7' +
  'Y29sb3I6IzVhNjQ3Mn0KLnBpbGwucnVzaHtiYWNrZ3JvdW5kOiNGREU4RDY7Y29sb3I6dmFyKC0tcnVzaCl9Ci5waWxsLlBhaWR7' +
  'YmFja2dyb3VuZDojZTNmNWVhO2NvbG9yOnZhcigtLW9rKX0KLnBpbGwuT3BlbiwucGlsbC5VbnBhaWR7YmFja2dyb3VuZDojZmRm' +
  'MGUzO2NvbG9yOnZhcigtLXdhcm4pfQoKdGFibGUudGJse3dpZHRoOjEwMCU7Ym9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlO2ZvbnQt' +
  'c2l6ZToxMy41cHh9CnRhYmxlLnRibCB0aHt0ZXh0LWFsaWduOmxlZnQ7Zm9udC1zaXplOjExLjVweDt0ZXh0LXRyYW5zZm9ybTp1' +
  'cHBlcmNhc2U7bGV0dGVyLXNwYWNpbmc6LjRweDtjb2xvcjp2YXIoLS1tdXRlZCk7cGFkZGluZzo2cHggNnB4O2JvcmRlci1ib3R0' +
  'b206MXB4IHNvbGlkIHZhcigtLWxpbmUpfQp0YWJsZS50YmwgdGR7cGFkZGluZzo5cHggNnB4O2JvcmRlci1ib3R0b206MXB4IHNv' +
  'bGlkIHZhcigtLWxpbmUpO3ZlcnRpY2FsLWFsaWduOnRvcH0KdGFibGUudGJsIHRyOmxhc3QtY2hpbGQgdGR7Ym9yZGVyLWJvdHRv' +
  'bTowfQoubnVte3RleHQtYWxpZ246cmlnaHR9CgouYXR0e2JvcmRlci1sZWZ0OjNweCBzb2xpZCB2YXIoLS1saW5lKTtwYWRkaW5n' +
  'OjhweCAwIDhweCAxMnB4O21hcmdpbi1ib3R0b206OHB4fQouYXR0LlNlcnZlZHtib3JkZXItbGVmdC1jb2xvcjp2YXIoLS1vayl9' +
  'Ci5hdHQgLmh7Zm9udC13ZWlnaHQ6NjAwO2ZvbnQtc2l6ZToxMy41cHh9Ci5hdHQgLm17Zm9udC1zaXplOjEyLjVweDtjb2xvcjp2' +
  'YXIoLS1tdXRlZCl9Cgouc2hlZXR7cG9zaXRpb246Zml4ZWQ7aW5zZXQ6MDt6LWluZGV4OjUwO2JhY2tncm91bmQ6cmdiYSgxMiwx' +
  'OCwyOCwuNSk7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmZsZXgtZW5kO2p1c3RpZnktY29udGVudDpjZW50ZXJ9Ci5zaGVldCAu' +
  'aW5uZXJ7YmFja2dyb3VuZDojZmZmO3dpZHRoOjEwMCU7bWF4LXdpZHRoOjY0MHB4O21heC1oZWlnaHQ6OTJ2aDtvdmVyZmxvdzph' +
  'dXRvO2JvcmRlci1yYWRpdXM6MTZweCAxNnB4IDAgMDtwYWRkaW5nOjE2cHggMTZweCBjYWxjKDIwcHggKyBlbnYoc2FmZS1hcmVh' +
  'LWluc2V0LWJvdHRvbSkpfQpAbWVkaWEobWluLXdpZHRoOjcyMHB4KXsuc2hlZXR7YWxpZ24taXRlbXM6Y2VudGVyfS5zaGVldCAu' +
  'aW5uZXJ7Ym9yZGVyLXJhZGl1czoxNnB4O21heC1oZWlnaHQ6ODh2aH19Ci5zaGVldCBoMnttYXJnaW46MCAwIDEycHg7Zm9udC1z' +
  'aXplOjE3cHh9Ci5zaGVldCAuY2xvc2V7cG9zaXRpb246YWJzb2x1dGU7cmlnaHQ6MTRweDt0b3A6MTRweH0KCi50b2FzdHtwb3Np' +
  'dGlvbjpmaXhlZDtsZWZ0OjUwJTt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTtib3R0b206NzhweDt6LWluZGV4OjYwO2JhY2tn' +
  'cm91bmQ6IzEyMTYxZjtjb2xvcjojZmZmO3BhZGRpbmc6MTFweCAxNnB4O2JvcmRlci1yYWRpdXM6MTBweDtmb250LXNpemU6MTRw' +
  'eDttYXgtd2lkdGg6OTAlO2JveC1zaGFkb3c6MCA4cHggMjRweCByZ2JhKDAsMCwwLC4yNSl9Ci50b2FzdC5iYWR7YmFja2dyb3Vu' +
  'ZDp2YXIoLS1iYWQpfQoKLmVtcHR5e3RleHQtYWxpZ246Y2VudGVyO2NvbG9yOnZhcigtLW11dGVkKTtwYWRkaW5nOjI4cHggMTBw' +
  'eDtmb250LXNpemU6MTRweH0KLnRva2Vuc3tkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjZweDttYXJnaW4tdG9wOjZw' +
  'eH0KLnRva2VucyBidXR0b257Zm9udDoxMnB4LzEgbW9ub3NwYWNlO3BhZGRpbmc6NnB4IDhweDtib3JkZXI6MXB4IHNvbGlkIHZh' +
  'cigtLWxpbmUpO2JhY2tncm91bmQ6I2Y4ZmFmYztib3JkZXItcmFkaXVzOjZweDtjdXJzb3I6cG9pbnRlcn0KcHJlLnByZXZ7YmFj' +
  'a2dyb3VuZDojZjhmYWZjO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czo4cHg7cGFkZGluZzoxMnB4' +
  'O3doaXRlLXNwYWNlOnByZS13cmFwO2ZvbnQ6MTJweC8xLjUgIkNvdXJpZXIgTmV3Iixtb25vc3BhY2U7bWF4LWhlaWdodDozNDBw' +
  'eDtvdmVyZmxvdzphdXRvfQojcmVhZGVye3dpZHRoOjEwMCU7Ym9yZGVyLXJhZGl1czoxMnB4O292ZXJmbG93OmhpZGRlbjtiYWNr' +
  'Z3JvdW5kOiMwMDA7bWluLWhlaWdodDoyNDBweH0KI3JlYWRlciB2aWRlb3t3aWR0aDoxMDAlO2Rpc3BsYXk6YmxvY2t9CgovKiBU' +
  'aGUgc2lnbi1pbiBzY3JlZW4gaXMgdGhlIG9ubHkgcGxhY2UgdGhlIHR3byBob3VzZSBjb2xvdXJzIHNpdCB0b2dldGhlciBhdAog' +
  'ICBmdWxsIHN0cmVuZ3RoIOKAlCBibHVlIG5hbWUsIG9yYW5nZSBhY3Rpb24sIG9uIHRoZSBzb2Z0IGdyb3VuZC4gKi8KLmxvZ2lu' +
  'e21heC13aWR0aDozODBweDttYXJnaW46N3ZoIGF1dG87cGFkZGluZzowIDE4cHh9Ci5sb2dpbiAubG9nb3t0ZXh0LWFsaWduOmNl' +
  'bnRlcjttYXJnaW4tYm90dG9tOjIycHh9Ci5sb2dpbiAubG9nbyBie2ZvbnQtc2l6ZTozMHB4O2NvbG9yOnZhcigtLWJyYW5kKTts' +
  'ZXR0ZXItc3BhY2luZzotLjZweH0KLmxvZ2luIC5sb2dvIGRpdntmb250LXNpemU6MTIuNXB4O2NvbG9yOnZhcigtLW11dGVkKTtt' +
  'YXJnaW4tdG9wOjNweDtsZXR0ZXItc3BhY2luZzouM3B4fQoubG9naW4gLmNhcmR7Ym9yZGVyLXJhZGl1czoxNnB4O3BhZGRpbmc6' +
  'MjBweCAxOHB4fQoKLmRyb3B6b25le2JhY2tncm91bmQ6I0Y2RjlGRTtib3JkZXI6MS41cHggZGFzaGVkICNCQkNDRTg7Ym9yZGVy' +
  'LXJhZGl1czp2YXIoLS1yKTtwYWRkaW5nOjEycHg7bWFyZ2luLWJvdHRvbToxNHB4fQouZHJvcHpvbmUgaW5wdXRbdHlwZT1maWxl' +
  'XXtiYWNrZ3JvdW5kOiNmZmY7cGFkZGluZzo5cHg7Zm9udC1zaXplOjEzcHh9Ci5kcm9wem9uZSAuaGludHttYXJnaW4tdG9wOjhw' +
  'eDtsaW5lLWhlaWdodDoxLjQ1fQoKLyogbGFiZWwgc2hlZXQgZ3JpZCAqLwoubGdyaWR7ZGlzcGxheTpncmlkO2dhcDozcHg7YmFj' +
  'a2dyb3VuZDojRThFRUY4O3BhZGRpbmc6NnB4O2JvcmRlci1yYWRpdXM6OHB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSl9' +
  'Ci5sY2VsbHthc3BlY3QtcmF0aW86NS8yO2JvcmRlcjoxcHggc29saWQgI2M5ZDRlMDtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyLXJh' +
  'ZGl1czozcHg7Y3Vyc29yOnBvaW50ZXI7CiAgZm9udDo2MDAgMTFweCBzeXN0ZW0tdWk7Y29sb3I6dmFyKC0tbXV0ZWQpO3BhZGRp' +
  'bmc6MDttaW4taGVpZ2h0OjIycHg7ZGlzcGxheTpmbGV4OwogIGFsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2Vu' +
  'dGVyfQoubGNlbGwudXNlZHtiYWNrZ3JvdW5kOiNkN2RkZTU7Y29sb3I6IzhhOTRhMjtib3JkZXItY29sb3I6I2MyY2NkOH0KLmxj' +
  'ZWxsLm5leHR7YmFja2dyb3VuZDojZTNmNWVhO2JvcmRlci1jb2xvcjp2YXIoLS1vayk7Y29sb3I6dmFyKC0tb2spfQoubGNlbGw6' +
  'YWN0aXZle3RyYW5zZm9ybTpzY2FsZSguOTYpfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLSBwaG90b3MgLS0tICovCi8qIEEgaG9yaXpvbnRhbCBzdHJpcCB1bmRlciBlYWNoIGF0dGVtcHQu' +
  'IFRodW1ibmFpbHMgYXJlIHNxdWFyZSBzbyBhIHJvdyBvZgogICBtaXhlZCBwb3J0cmFpdCBhbmQgbGFuZHNjYXBlIHNob3RzIHN0' +
  'aWxsIHJlYWRzIGFzIGEgdGlkeSBsaW5lLiAqLwoucGhvdG9ze2Rpc3BsYXk6ZmxleDtnYXA6OHB4O292ZXJmbG93LXg6YXV0bztw' +
  'YWRkaW5nOjEwcHggMCAycHg7LXdlYmtpdC1vdmVyZmxvdy1zY3JvbGxpbmc6dG91Y2h9Ci5waG90b3M6Oi13ZWJraXQtc2Nyb2xs' +
  'YmFye2hlaWdodDowfQoudGh1bWJ7cG9zaXRpb246cmVsYXRpdmU7ZmxleDowIDAgYXV0bzt3aWR0aDo3NnB4O2hlaWdodDo3NnB4' +
  'O3BhZGRpbmc6MDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpOwogIGJvcmRlci1yYWRpdXM6MTBweDtvdmVyZmxvdzpoaWRk' +
  'ZW47YmFja2dyb3VuZDp2YXIoLS1jYXJkKTtjdXJzb3I6cG9pbnRlcjtkaXNwbGF5OmJsb2NrfQoudGh1bWIgaW1ne3dpZHRoOjEw' +
  'MCU7aGVpZ2h0OjEwMCU7b2JqZWN0LWZpdDpjb3ZlcjtkaXNwbGF5OmJsb2NrfQoudGh1bWIgLmNhcHtwb3NpdGlvbjphYnNvbHV0' +
  'ZTtsZWZ0OjA7cmlnaHQ6MDtib3R0b206MDtwYWRkaW5nOjNweCA1cHg7Zm9udDo2MDAgMTBweCBzeXN0ZW0tdWk7CiAgY29sb3I6' +
  'I2ZmZjtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgwZGVnLHJnYmEoMCwwLDAsLjY4KSx0cmFuc3BhcmVudCk7dGV4dC1hbGln' +
  'bjpsZWZ0OwogIHdoaXRlLXNwYWNlOm5vd3JhcDtvdmVyZmxvdzpoaWRkZW47dGV4dC1vdmVyZmxvdzplbGxpcHNpc30KLnRodW1i' +
  'IC54e3Bvc2l0aW9uOmFic29sdXRlO3RvcDozcHg7cmlnaHQ6M3B4O3dpZHRoOjE5cHg7aGVpZ2h0OjE5cHg7Ym9yZGVyLXJhZGl1' +
  'czo1MCU7CiAgYmFja2dyb3VuZDpyZ2JhKDAsMCwwLC42KTtjb2xvcjojZmZmO2ZvbnQ6NzAwIDEzcHgvMTlweCBzeXN0ZW0tdWk7' +
  'dGV4dC1hbGlnbjpjZW50ZXJ9Ci50aHVtYi5hZGR7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjthbGlnbi1pdGVt' +
  'czpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtnYXA6MnB4OwogIGJvcmRlcjoxLjVweCBkYXNoZWQgdmFyKC0tYnJhbmQp' +
  'O2NvbG9yOnZhcigtLWJyYW5kKTtiYWNrZ3JvdW5kOiNGMkY2RkU7CiAgZm9udDo3MDAgMTlweCBzeXN0ZW0tdWl9Ci50aHVtYi5h' +
  'ZGQgc3Bhbntmb250OjcwMCAxMHB4IHN5c3RlbS11aTtsZXR0ZXItc3BhY2luZzouMDJlbX0KLnRodW1iOmFjdGl2ZXt0cmFuc2Zv' +
  'cm06c2NhbGUoLjk3KX0KLnBob3RvLWhpZGRlbntmb250LXN0eWxlOml0YWxpYztvcGFjaXR5Oi43NX0KCi8qIFJlY2VpdmFibGVz' +
  'OiBvbmUgYmlnIG51bWJlciwgdGhlbiB0aGUgYWdpbmcgcm93IHVuZGVyIGl0LiAqLwouc3RhdC5iaWcgLm57Zm9udC1zaXplOjMy' +
  'cHh9Ci5zdGF0LmJhZCAubntjb2xvcjp2YXIoLS1iYWQpfQoKLyogVGhlIGluc3RhbGwgYmFyLiBTaXRzIGFib3ZlIHRoZSB0YWIg' +
  'YmFyLCBvdXQgb2YgdGhlIHdheSBvZiB0aGUgdGh1bWIuICovCiNhMmhze3Bvc2l0aW9uOmZpeGVkO2xlZnQ6MTBweDtyaWdodDox' +
  'MHB4O2JvdHRvbTpjYWxjKDc4cHggKyBlbnYoc2FmZS1hcmVhLWluc2V0LWJvdHRvbSkpO3otaW5kZXg6OTA7CiAgZGlzcGxheTpu' +
  'b25lO2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTBweDtiYWNrZ3JvdW5kOnZhcigtLWNhcmQsI2ZmZik7CiAgYm9yZGVyOjFweCBz' +
  'b2xpZCB2YXIoLS1saW5lLCNEQkU0RjIpO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjEwcHggMTJweDsKICBib3gtc2hhZG93' +
  'OjAgOHB4IDI2cHggcmdiYSgxMSw0MCw5MCwuMTYpfQojYTJocy5vbntkaXNwbGF5OmZsZXh9CiNhMmhzIC5haXt3aWR0aDozNHB4' +
  'O2hlaWdodDozNHB4O2JvcmRlci1yYWRpdXM6OXB4O2ZsZXg6bm9uZX0KI2EyaHMgLmF0e2ZsZXg6MTttaW4td2lkdGg6MDtmb250' +
  'LXNpemU6MTIuNXB4O2xpbmUtaGVpZ2h0OjEuNDU7Y29sb3I6dmFyKC0tbXV0ZWQsIzVBNkE4MCl9CiNhMmhzIC5hdCBie2NvbG9y' +
  'OnZhcigtLWluaywjMTAxODIyKTtkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxM3B4O21hcmdpbi1ib3R0b206MXB4fQojYTJocyBi' +
  'dXR0b257YmFja2dyb3VuZDp2YXIoLS1hY2NlbnQsI0YyNjYwRCk7Y29sb3I6I2ZmZjtib3JkZXI6MDtib3JkZXItcmFkaXVzOjk5' +
  'OXB4OwogIHBhZGRpbmc6OHB4IDE0cHg7Zm9udC13ZWlnaHQ6NzAwO2ZvbnQtc2l6ZToxM3B4O2N1cnNvcjpwb2ludGVyfQojYTJo' +
  'cyAueHtiYWNrZ3JvdW5kOm5vbmU7Y29sb3I6dmFyKC0tbXV0ZWQsIzg4OTRBNik7Zm9udC1zaXplOjE5cHg7cGFkZGluZzowIDRw' +
  'eDtmb250LXdlaWdodDo2MDB9CkBtZWRpYSBhbGwgYW5kIChkaXNwbGF5LW1vZGU6c3RhbmRhbG9uZSl7I2EyaHN7ZGlzcGxheTpu' +
  'b25lIWltcG9ydGFudH19Cgo8L3N0eWxlPgo8bGluayByZWw9Imljb24iIGhyZWY9ImRhdGE6aW1hZ2Uvc3ZnK3htbCw8c3ZnIHht' +
  'bG5zPSdodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Zycgdmlld0JveD0nMCAwIDMyIDMyJz48cmVjdCB3aWR0aD0nMzInIGhlaWdo' +
  'dD0nMzInIHJ4PSc3JyBmaWxsPSclMjMxZTNhNWYnLz48dGV4dCB4PScxNicgeT0nMjMnIGZvbnQtc2l6ZT0nMTknIGZvbnQtZmFt' +
  'aWx5PSdzeXN0ZW0tdWknIGZvbnQtd2VpZ2h0PSc3MDAnIGZpbGw9J3doaXRlJyB0ZXh0LWFuY2hvcj0nbWlkZGxlJz5TPC90ZXh0' +
  'Pjwvc3ZnPiI+CjwvaGVhZD4KPGJvZHk+CjxkaXYgaWQ9ImFwcCI+PC9kaXY+CjxzY3JpcHQgc3JjPSJodHRwczovL2Nkbi5qc2Rl' +
  'bGl2ci5uZXQvbnBtL0B6eGluZy9saWJyYXJ5QDAuMjEuMy91bWQvaW5kZXgubWluLmpzIj48L3NjcmlwdD4KPHNjcmlwdD4KLyog' +
  'U2VydmVUcmFjayDigJQgZmllbGQtZmlyc3QgcHJvY2VzcyBzZXJ2aW5nIG1hbmFnZXIgKi8KKGZ1bmN0aW9uICgpIHsKJ3VzZSBz' +
  'dHJpY3QnOwoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGhl' +
  'bHBlcnMgLS0gKi8KY29uc3QgJCA9IHNlbCA9PiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKHNlbCk7CmNvbnN0IGFwcCA9ICQoJyNh' +
  'cHAnKTsKY29uc3QgUyA9IHsgbWU6IG51bGwsIHZpZXc6ICdkYXNoJywgcGFyYW1zOiB7fSwgY2FjaGU6IHt9IH07Cgpjb25zdCBl' +
  'c2MgPSBzID0+IFN0cmluZyhzID09IG51bGwgPyAnJyA6IHMpCiAgLnJlcGxhY2UoLyYvZywgJyZhbXA7JykucmVwbGFjZSgvPC9n' +
  'LCAnJmx0OycpLnJlcGxhY2UoLz4vZywgJyZndDsnKQogIC5yZXBsYWNlKC8iL2csICcmcXVvdDsnKS5yZXBsYWNlKC8nL2csICcm' +
  'IzM5OycpOwoKY29uc3QgbW9uZXkgPSB2ID0+ICckJyArIE51bWJlcih2IHx8IDApLnRvRml4ZWQoMik7CmNvbnN0IGNscyA9IHMg' +
  'PT4gU3RyaW5nKHMgfHwgJycpLnJlcGxhY2UoL1teQS1aYS16XS9nLCAnJyk7CgpmdW5jdGlvbiBmbXREYXRlKHYsIG9wdHMpIHsK' +
  'ICBpZiAoIXYpIHJldHVybiAnJzsKICBjb25zdCBkID0gbmV3IERhdGUodik7CiAgcmV0dXJuIGQudG9Mb2NhbGVEYXRlU3RyaW5n' +
  'KCdlbi1VUycsIG9wdHMgfHwgeyBtb250aDogJ3Nob3J0JywgZGF5OiAnbnVtZXJpYycsIHllYXI6ICdudW1lcmljJyB9KTsKfQpm' +
  'dW5jdGlvbiBmbXREYXRlT25seSh2KSB7IC8vIGRhdGUgY29sdW1ucyBjb21lIGJhY2sgYXMgWVlZWS1NTS1ERCBvciBJU08gbWlk' +
  'bmlnaHQgVVRDCiAgaWYgKCF2KSByZXR1cm4gJyc7CiAgY29uc3QgcyA9IFN0cmluZyh2KS5zbGljZSgwLCAxMCkuc3BsaXQoJy0n' +
  'KTsKICByZXR1cm4gYCR7K3NbMV19LyR7K3NbMl19LyR7c1swXS5zbGljZSgyKX1gOwp9CmZ1bmN0aW9uIGZtdERUKHYpIHsKICBp' +
  'ZiAoIXYpIHJldHVybiAnJzsKICByZXR1cm4gbmV3IERhdGUodikudG9Mb2NhbGVTdHJpbmcoJ2VuLVVTJywKICAgIHsgbW9udGg6' +
  'ICdzaG9ydCcsIGRheTogJ251bWVyaWMnLCBob3VyOiAnbnVtZXJpYycsIG1pbnV0ZTogJzItZGlnaXQnIH0pOwp9CmZ1bmN0aW9u' +
  'IGRheXNPdXQodikgewogIGlmICghdikgcmV0dXJuIG51bGw7CiAgY29uc3QgZHVlID0gbmV3IERhdGUoU3RyaW5nKHYpLnNsaWNl' +
  'KDAsIDEwKSArICdUMTI6MDA6MDAnKTsKICByZXR1cm4gTWF0aC5yb3VuZCgoZHVlIC0gbmV3IERhdGUoKSkgLyA4NjRlNSk7Cn0K' +
  'Y29uc3QgdG9kYXlJU08gPSAoKSA9PiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApOwoKYXN5bmMgZnVuY3Rp' +
  'b24gYXBpKHBhdGgsIG9wdHMpIHsKICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaCgnL2FwaScgKyBwYXRoLCBPYmplY3QuYXNzaWdu' +
  'KHsKICAgIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9LCBjcmVkZW50aWFsczogJ3NhbWUt' +
  'b3JpZ2luJwogIH0sIG9wdHMgfHwge30pKTsKICBjb25zdCBkYXRhID0gYXdhaXQgcmVzLmpzb24oKS5jYXRjaCgoKSA9PiAoe30p' +
  'KTsKICAvLyBBIDQwMSBmcm9tIC9sb2dpbiBtZWFucyB0aGUgY3JlZGVudGlhbHMgd2VyZSB3cm9uZywgbm90IHRoYXQgYSBzZXNz' +
  'aW9uCiAgLy8gbGFwc2VkLiBUcmVhdGluZyB0aGUgdHdvIHRoZSBzYW1lIHNob3dlZCAiU2lnbmVkIG91dCIgdG8gc29tZW9uZSB3' +
  'aG8gaGFkCiAgLy8gc2ltcGx5IG1pc3R5cGVkIGEgcGFzc3dvcmQsIHdoaWNoIGlzIGFjdGl2ZWx5IG1pc2xlYWRpbmcuCiAgaWYg' +
  'KHJlcy5zdGF0dXMgPT09IDQwMSAmJiBwYXRoICE9PSAnL2xvZ2luJykgewogICAgUy5tZSA9IG51bGw7CiAgICByZW5kZXIoKTsK' +
  'ICAgIHRocm93IG5ldyBFcnJvcihkYXRhLmVycm9yIHx8ICdTaWduZWQgb3V0Jyk7CiAgfQogIGlmICghcmVzLm9rKSB0aHJvdyBu' +
  'ZXcgRXJyb3IoZGF0YS5lcnJvciB8fCAnUmVxdWVzdCBmYWlsZWQnKTsKICByZXR1cm4gZGF0YTsKfQoKZnVuY3Rpb24gdG9hc3Qo' +
  'bXNnLCBiYWQpIHsKICBjb25zdCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgdC5jbGFzc05hbWUgPSAndG9h' +
  'c3QnICsgKGJhZCA/ICcgYmFkJyA6ICcnKTsKICB0LnRleHRDb250ZW50ID0gbXNnOwogIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hp' +
  'bGQodCk7CiAgc2V0VGltZW91dCgoKSA9PiB0LnJlbW92ZSgpLCAzMjAwKTsKfQoKZnVuY3Rpb24gZ28odmlldywgcGFyYW1zKSB7' +
  'IFMudmlldyA9IHZpZXc7IFMucGFyYW1zID0gcGFyYW1zIHx8IHt9OyB3aW5kb3cuc2Nyb2xsVG8oMCwgMCk7IHJlbmRlcigpOyB9' +
  'CgovKiBtb2RhbCBzaGVldCAqLwpsZXQgc2hlZXRFbCA9IG51bGw7CmZ1bmN0aW9uIHNoZWV0KHRpdGxlLCBib2R5SHRtbCwgb25N' +
  'b3VudCkgewogIGNsb3NlU2hlZXQoKTsKICBzaGVldEVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgc2hlZXRF' +
  'bC5jbGFzc05hbWUgPSAnc2hlZXQnOwogIHNoZWV0RWwuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImlubmVyIj48aDI+JHtlc2Mo' +
  'dGl0bGUpfTwvaDI+JHtib2R5SHRtbH08L2Rpdj5gOwogIHNoZWV0RWwuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBlID0+IHsg' +
  'aWYgKGUudGFyZ2V0ID09PSBzaGVldEVsKSBjbG9zZVNoZWV0KCk7IH0pOwogIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoc2hl' +
  'ZXRFbCk7CiAgaWYgKG9uTW91bnQpIG9uTW91bnQoc2hlZXRFbCk7Cn0KZnVuY3Rpb24gY2xvc2VTaGVldCgpIHsKICBpZiAoc2hl' +
  'ZXRFbCkgeyBzaGVldEVsLnJlbW92ZSgpOyBzaGVldEVsID0gbnVsbDsgfQogIGlmICh3aW5kb3cuX19zdG9wU2NhbikgeyB3aW5k' +
  'b3cuX19zdG9wU2NhbigpOyB3aW5kb3cuX19zdG9wU2NhbiA9IG51bGw7IH0KfQp3aW5kb3cuY2xvc2VTaGVldCA9IGNsb3NlU2hl' +
  'ZXQ7CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIG1hcHMgbGlua2lu' +
  'ZyAtLSAqLwpjb25zdCBpc0lPUyA9ICgpID0+IC9pUGFkfGlQaG9uZXxpUG9kLy50ZXN0KG5hdmlnYXRvci51c2VyQWdlbnQpIHx8' +
  'CiAgKG5hdmlnYXRvci5wbGF0Zm9ybSA9PT0gJ01hY0ludGVsJyAmJiBuYXZpZ2F0b3IubWF4VG91Y2hQb2ludHMgPiAxKTsKCmZ1' +
  'bmN0aW9uIGFkZHJPZihqKSB7CiAgcmV0dXJuIFtqLmFkZHJlc3MxLCBqLmFkZHJlc3MyLCBqLmNpdHksIGouc3RhdGUsIGouemlw' +
  'XS5maWx0ZXIoQm9vbGVhbikuam9pbignLCAnKTsKfQpmdW5jdGlvbiBhcHBsZVVybChhKSB7IHJldHVybiAnaHR0cHM6Ly9tYXBz' +
  'LmFwcGxlLmNvbS8/ZGFkZHI9JyArIGVuY29kZVVSSUNvbXBvbmVudChhKSArICcmZGlyZmxnPWQnOyB9CmZ1bmN0aW9uIGdvb2ds' +
  'ZVVybChhKSB7CiAgcmV0dXJuICdodHRwczovL3d3dy5nb29nbGUuY29tL21hcHMvZGlyLz9hcGk9MSZkZXN0aW5hdGlvbj0nICsg' +
  'ZW5jb2RlVVJJQ29tcG9uZW50KGEpICsgJyZ0cmF2ZWxtb2RlPWRyaXZpbmcnOwp9CmZ1bmN0aW9uIG5hdlVybChhKSB7IHJldHVy' +
  'biBpc0lPUygpID8gYXBwbGVVcmwoYSkgOiBnb29nbGVVcmwoYSk7IH0KZnVuY3Rpb24gcm91dGVVcmwobGlzdCkgewogIGNvbnN0' +
  'IHN0b3BzID0gbGlzdC5tYXAoYWRkck9mKS5maWx0ZXIoQm9vbGVhbik7CiAgaWYgKCFzdG9wcy5sZW5ndGgpIHJldHVybiBudWxs' +
  'OwogIGNvbnN0IGRlc3QgPSBzdG9wc1tzdG9wcy5sZW5ndGggLSAxXTsKICBjb25zdCB3YXkgPSBzdG9wcy5zbGljZSgwLCAtMSku' +
  'c2xpY2UoMCwgOSkubWFwKGVuY29kZVVSSUNvbXBvbmVudCkuam9pbignfCcpOwogIHJldHVybiAnaHR0cHM6Ly93d3cuZ29vZ2xl' +
  'LmNvbS9tYXBzL2Rpci8/YXBpPTEmb3JpZ2luPUN1cnJlbnQrTG9jYXRpb24mZGVzdGluYXRpb249JyArCiAgICBlbmNvZGVVUklD' +
  'b21wb25lbnQoZGVzdCkgKyAod2F5ID8gJyZ3YXlwb2ludHM9JyArIHdheSA6ICcnKSArICcmdHJhdmVsbW9kZT1kcml2aW5nJzsK' +
  'fQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBsYXlvdXQg' +
  'LS0gKi8KY29uc3QgaXNBZG1pbiA9ICgpID0+IFMubWUgJiYgKFMubWUucm9sZSA9PT0gJ2FkbWluJyB8fCBTLm1lLnJvbGUgPT09' +
  'ICdvd25lcicpOwpjb25zdCBpc093bmVyID0gKCkgPT4gUy5tZSAmJiBTLm1lLnJvbGUgPT09ICdvd25lcic7CmNvbnN0IHJvbGVM' +
  'YWJlbCA9ICgpID0+IFMubWUucm9sZSA9PT0gJ293bmVyJyA/ICdPd25lcicKICA6IChTLm1lLnJvbGUgPT09ICdhZG1pbicgPyAn' +
  'QWRtaW4nIDogJ0ZpZWxkIHNlcnZlcicpOwoKY29uc3QgVEFCUyA9ICgpID0+IGlzQWRtaW4oKQogID8gW1snZGFzaCcsICdUb2Rh' +
  'eScsICfil44nXSwgWydqb2JzJywgJ0pvYnMnLCAn4pakJ10sIFsnc2NhbicsICdTY2FuJywgJ+KWpSddLAogICAgIFsndG9vbHMn' +
  'LCAnVG9vbHMnLCAn4pyCJ10sIFsncHJvcGVydHknLCAnUHJvcCcsICfijIInXSwgWydtb25leScsICdCaWxsJywgJyQnXSwgWydh' +
  'ZG1pbicsICdTZXR1cCcsICfimpknXV0KICA6IFtbJ2Rhc2gnLCAnTXkgRGF5JywgJ+KXjiddLCBbJ2pvYnMnLCAnSm9icycsICfi' +
  'lqQnXSwgWydzY2FuJywgJ1NjYW4nLCAn4palJ10sCiAgICAgWyd0b29scycsICdUb29scycsICfinIInXSwgWydwcm9wZXJ0eScs' +
  'ICdQcm9wJywgJ+KMgiddLCBbJ21vbmV5JywgJ1BheScsICckJ11dOwoKZnVuY3Rpb24gc2hlbGwoaW5uZXIpIHsKICBjb25zdCB0' +
  'YWJzID0gVEFCUygpLm1hcCgoW3YsIGxhYmVsLCBpY10pID0+CiAgICBgPGJ1dHRvbiBkYXRhLXRhYj0iJHt2fSIgY2xhc3M9IiR7' +
  'Uy52aWV3ID09PSB2IHx8ICh2ID09PSAnam9icycgJiYgUy52aWV3ID09PSAnam9iJykgPyAnb24nIDogJyd9Ij4KICAgICAgPHNw' +
  'YW4gY2xhc3M9ImljIj4ke2ljfTwvc3Bhbj4ke2VzYyhsYWJlbCl9PC9idXR0b24+YCkuam9pbignJyk7CiAgY29uc3Qgc3VwcG9y' +
  'dEJhciA9IFMubWUuc3VwcG9ydAogICAgPyBgPGRpdiBzdHlsZT0iYmFja2dyb3VuZDojQzI0MTBDO2NvbG9yOiNmZmY7dGV4dC1h' +
  'bGlnbjpjZW50ZXI7Zm9udC1zaXplOjEyLjVweDsKICAgICAgICBwYWRkaW5nOjZweCAxMHB4O2ZvbnQtd2VpZ2h0OjYwMCI+U3Vw' +
  'cG9ydCB2aWV3IOKAlCBuYW1lcyAmYW1wOyBkb2N1bWVudHMgYXJlIGhpZGRlbi4KICAgICAgICBUaGlzIGlzICR7ZXNjKFMubWUu' +
  'Y29tcGFueSA/IFMubWUuY29tcGFueS5uYW1lIDogJ2EgY3VzdG9tZXIgY29tcGFueScpfSwgbm90IHlvdXJzLjwvZGl2PmAKICAg' +
  'IDogJyc7CiAgcmV0dXJuIGAke3N1cHBvcnRCYXJ9CiAgICA8ZGl2IGNsYXNzPSJ0b3BiYXIiPgogICAgICA8ZGl2IGNsYXNzPSJi' +
  'cmFuZCI+U2VydmVUcmFjazxzbWFsbD4ke2VzYyhTLm1lLmNvbXBhbnkgPyBTLm1lLmNvbXBhbnkubmFtZSA6ICcnKX0kewogICAg' +
  'ICAgIFMubWUuY29tcGFueSA/ICcgwrcgJyA6ICcnfSR7ZXNjKFMubWUubmFtZSl9IMK3ICR7cm9sZUxhYmVsKCl9PC9zbWFsbD48' +
  'L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3BhY2VyIj48L2Rpdj4KICAgICAgJHtpc093bmVyKCkgJiYgKFMubWUuY29tcGFuaWVz' +
  'IHx8IFtdKS5sZW5ndGggPiAxCiAgICAgICAgPyBgPHNlbGVjdCBpZD0iY29Td2l0Y2giIHRpdGxlPSJXaGljaCBjb21wYW55IHlv' +
  'dSBhcmUgd29ya2luZyBpbiI+JHsKICAgICAgICAgICAgKFMubWUuY29tcGFuaWVzIHx8IFtdKS5tYXAoYyA9PiBgPG9wdGlvbiB2' +
  'YWx1ZT0iJHtjLmlkfSIkewogICAgICAgICAgICAgIFMubWUuY29tcGFueSAmJiBjLmlkID09PSBTLm1lLmNvbXBhbnkuaWQgPyAn' +
  'IHNlbGVjdGVkJyA6ICcnfT4ke2VzYyhjLm5hbWUpfTwvb3B0aW9uPmApLmpvaW4oJycpCiAgICAgICAgICB9PC9zZWxlY3Q+YCA6' +
  'ICcnfQogICAgICA8YnV0dG9uIGlkPSJsb2dvdXQiPlNpZ24gb3V0PC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9' +
  'IndyYXAiPiR7aW5uZXJ9PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJ0YWJzIj4ke3RhYnN9PC9kaXY+YDsKfQoKZnVuY3Rpb24gYmlu' +
  'ZFNoZWxsKCkgewogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXRhYl0nKS5mb3JFYWNoKGIgPT4KICAgIGIub25j' +
  'bGljayA9ICgpID0+IGdvKGIuZGF0YXNldC50YWIpKTsKICBjb25zdCBsbyA9ICQoJyNsb2dvdXQnKTsKICBpZiAobG8pIGxvLm9u' +
  'Y2xpY2sgPSBhc3luYyAoKSA9PiB7IGF3YWl0IGFwaSgnL2xvZ291dCcsIHsgbWV0aG9kOiAnUE9TVCcgfSk7IFMubWUgPSBudWxs' +
  'OyByZW5kZXIoKTsgfTsKICBjb25zdCBzdyA9ICQoJyNjb1N3aXRjaCcpOwogIGlmIChzdykgc3cub25jaGFuZ2UgPSBhc3luYyAo' +
  'KSA9PiB7CiAgICB0cnkgewogICAgICBjb25zdCBvdXQgPSBhd2FpdCBhcGkoJy9jb21wYW5pZXMvJyArIHN3LnZhbHVlICsgJy9l' +
  'bnRlcicsIHsgbWV0aG9kOiAnUE9TVCcgfSk7CiAgICAgIFMubWUgPSBhd2FpdCBhcGkoJy9tZScpOwogICAgICB0b2FzdCgnTm93' +
  'IGluICcgKyBvdXQuY29tcGFueS5uYW1lKTsKICAgICAgcmVuZGVyKCk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2Fn' +
  'ZSwgdHJ1ZSk7IH0KICB9Owp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLSBsb2dpbiAtLSAqLwpmdW5jdGlvbiBsb2dpblZpZXcoKSB7CiAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNz' +
  'PSJsb2dpbiI+CiAgICA8ZGl2IGNsYXNzPSJsb2dvIj48Yj5TZXJ2ZVRyYWNrPC9iPjxkaXY+UHJvY2VzcyBzZXJ2aW5nIG1hbmFn' +
  'ZW1lbnQ8L2Rpdj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkVt' +
  'YWlsPC9sYWJlbD48aW5wdXQgaWQ9ImVtYWlsIiB0eXBlPSJlbWFpbCIgYXV0b2NvbXBsZXRlPSJ1c2VybmFtZSIgaW5wdXRtb2Rl' +
  'PSJlbWFpbCI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGFzc3dvcmQ8L2xhYmVsPjxpbnB1dCBpZD0i' +
  'cHciIHR5cGU9InBhc3N3b3JkIiBhdXRvY29tcGxldGU9ImN1cnJlbnQtcGFzc3dvcmQiPjwvZGl2PgogICAgICA8YnV0dG9uIGNs' +
  'YXNzPSJidG4gYmxvY2siIGlkPSJzaWduaW4iPlNpZ24gaW48L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgaWQ9ImVy' +
  'ciIgc3R5bGU9ImNvbG9yOnZhcigtLWJhZCk7bWFyZ2luLXRvcDoxMHB4Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIg' +
  'c3R5bGU9InRleHQtYWxpZ246Y2VudGVyO21hcmdpbi10b3A6MTRweCI+CiAgICAgICAgQmVlbiBnaXZlbiBhbiBhY2Nlc3MgY29k' +
  'ZT8gPGEgaHJlZj0iIyIgaWQ9ImhhdmVDb2RlIj5TZXQgdXAgeW91ciBhY2NvdW50PC9hPjwvZGl2PgogICAgICA8ZGl2IGNsYXNz' +
  'PSJoaW50IiBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXI7bWFyZ2luLXRvcDoxMHB4Ij4KICAgICAgICA8YSBocmVmPSIvcHJpdmFj' +
  'eSIgdGFyZ2V0PSJfYmxhbmsiPlByaXZhY3kgc3RhdGVtZW50PC9hPjwvZGl2PgogICAgPC9kaXY+PC9kaXY+YDsKICBjb25zdCBz' +
  'dWJtaXQgPSBhc3luYyAoKSA9PiB7CiAgICAkKCcjZXJyJykudGV4dENvbnRlbnQgPSAnJzsKICAgIHRyeSB7CiAgICAgIGF3YWl0' +
  'IGFwaSgnL2xvZ2luJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlbWFpbDogJCgnI2VtYWlsJyku' +
  'dmFsdWUsIHBhc3N3b3JkOiAkKCcjcHcnKS52YWx1ZSB9KSB9KTsKICAgICAgUy5tZSA9IGF3YWl0IGFwaSgnL21lJyk7CiAgICAg' +
  'IGdvKCdkYXNoJyk7CiAgICB9IGNhdGNoIChlKSB7ICQoJyNlcnInKS50ZXh0Q29udGVudCA9IGUubWVzc2FnZTsgfQogIH07CiAg' +
  'JCgnI3NpZ25pbicpLm9uY2xpY2sgPSBzdWJtaXQ7CiAgJCgnI3B3Jykub25rZXlkb3duID0gZSA9PiB7IGlmIChlLmtleSA9PT0g' +
  'J0VudGVyJykgc3VibWl0KCk7IH07CiAgJCgnI2hhdmVDb2RlJykub25jbGljayA9IGUgPT4geyBlLnByZXZlbnREZWZhdWx0KCk7' +
  'IHJlZGVlbVZpZXcoKTsgfTsKICAkKCcjZW1haWwnKS5mb2N1cygpOwp9CgoKLyogUmVkZWVtaW5nIGEgY29kZSBjcmVhdGVzIHRo' +
  'ZSBhY2NvdW50LCBzbyBzb21lb25lIGNhbiBiZSBzZXQgdXAgd2l0aG91dCBhbgogICBhZG1pbiBrZXlpbmcgaW4gdGhlaXIgZGV0' +
  'YWlscy4gKi8KZnVuY3Rpb24gcmVkZWVtVmlldygpIHsKICBhcHAuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImxvZ2luIj4KICAg' +
  'IDxkaXYgY2xhc3M9ImxvZ28iPjxiPlNlcnZlVHJhY2s8L2I+PGRpdj5TZXQgdXAgeW91ciBhY2NvdW50PC9kaXY+PC9kaXY+CiAg' +
  'ICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5BY2Nlc3MgY29kZTwvbGFiZWw+CiAg' +
  'ICAgICAgPGlucHV0IGlkPSJyX2NvZGUiIHBsYWNlaG9sZGVyPSJBQkNELUVGR0gtSktMTSIgYXV0b2NhcGl0YWxpemU9ImNoYXJh' +
  'Y3RlcnMiIHN0eWxlPSJ0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2UiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxh' +
  'YmVsPllvdXIgbmFtZTwvbGFiZWw+PGlucHV0IGlkPSJyX25hbWUiIGF1dG9jb21wbGV0ZT0ibmFtZSI+PC9kaXY+CiAgICAgIDxk' +
  'aXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RW1haWw8L2xhYmVsPjxpbnB1dCBpZD0icl9lbWFpbCIgdHlwZT0iZW1haWwiIGlucHV0' +
  'bW9kZT0iZW1haWwiIGF1dG9jb21wbGV0ZT0iZW1haWwiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNo' +
  'b29zZSBhIHBhc3N3b3JkPC9sYWJlbD4KICAgICAgICA8aW5wdXQgaWQ9InJfcHciIHR5cGU9InBhc3N3b3JkIiBhdXRvY29tcGxl' +
  'dGU9Im5ldy1wYXNzd29yZCIgcGxhY2Vob2xkZXI9IkF0IGxlYXN0IDggY2hhcmFjdGVycyI+PC9kaXY+CiAgICAgIDxkaXYgY2xh' +
  'c3M9ImZpZWxkIj48bGFiZWw+WW91ciBjb21wYW55IDxzcGFuIGNsYXNzPSJoaW50Ij7igJQgb25seSBpZiB5b3UgYXJlIHN0YXJ0' +
  'aW5nIGEgbmV3IG9uZTwvc3Bhbj48L2xhYmVsPgogICAgICAgIDxpbnB1dCBpZD0icl9jbyIgcGxhY2Vob2xkZXI9ImUuZy4gUmlv' +
  'IEdyYW5kZSBQcm9jZXNzIFNlcnZpbmciPjwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYmxvY2siIGlkPSJyX2dvIj5D' +
  'cmVhdGUgbXkgYWNjb3VudDwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBpZD0icl9lcnIiIHN0eWxlPSJjb2xvcjp2' +
  'YXIoLS1iYWQpO21hcmdpbi10b3A6MTBweCI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJ0ZXh0LWFsaWdu' +
  'OmNlbnRlcjttYXJnaW4tdG9wOjE0cHgiPgogICAgICAgIDxhIGhyZWY9IiMiIGlkPSJyX2JhY2siPkJhY2sgdG8gc2lnbiBpbjwv' +
  'YT48L2Rpdj4KICAgIDwvZGl2PjwvZGl2PmA7CgogICQoJyNyX2JhY2snKS5vbmNsaWNrID0gZSA9PiB7IGUucHJldmVudERlZmF1' +
  'bHQoKTsgbG9naW5WaWV3KCk7IH07CiAgY29uc3QgZ28gPSBhc3luYyAoKSA9PiB7CiAgICAkKCcjcl9lcnInKS50ZXh0Q29udGVu' +
  'dCA9ICcnOwogICAgdHJ5IHsKICAgICAgY29uc3QgbWFkZSA9IGF3YWl0IGFwaSgnL3JlZGVlbScsIHsgbWV0aG9kOiAnUE9TVCcs' +
  'IGJvZHk6IEpTT04uc3RyaW5naWZ5KHsKICAgICAgICBjb2RlOiAkKCcjcl9jb2RlJykudmFsdWUsIG5hbWU6ICQoJyNyX25hbWUn' +
  'KS52YWx1ZSwgY29tcGFueTogJCgnI3JfY28nKS52YWx1ZSwKICAgICAgICBlbWFpbDogJCgnI3JfZW1haWwnKS52YWx1ZSwgcGFz' +
  'c3dvcmQ6ICQoJyNyX3B3JykudmFsdWUKICAgICAgfSkgfSk7CiAgICAgIFMubWUgPSBhd2FpdCBhcGkoJy9tZScpOwogICAgICB0' +
  'b2FzdCgnV2VsY29tZSwgJyArIG1hZGUubmFtZSk7CiAgICAgIGdvMigpOwogICAgfSBjYXRjaCAoZSkgeyAkKCcjcl9lcnInKS50' +
  'ZXh0Q29udGVudCA9IGUubWVzc2FnZTsgfQogIH07CiAgY29uc3QgZ28yID0gKCkgPT4geyBTLnZpZXcgPSAnZGFzaCc7IFMucGFy' +
  'YW1zID0ge307IHJlbmRlcigpOyB9OwogICQoJyNyX2dvJykub25jbGljayA9IGdvOwogICQoJyNyX3B3Jykub25rZXlkb3duID0g' +
  'ZSA9PiB7IGlmIChlLmtleSA9PT0gJ0VudGVyJykgZ28oKTsgfTsKICAkKCcjcl9jb2RlJykuZm9jdXMoKTsKfQoKLyogLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBkYXNoYm9hcmQgLS0gKi8KYXN5bmMg' +
  'ZnVuY3Rpb24gZGFzaFZpZXcoKSB7CiAgY29uc3QgW3N0YXRzLCBqb2JzXSA9IGF3YWl0IFByb21pc2UuYWxsKFthcGkoJy9zdGF0' +
  'cycpLCBhcGkoJy9qb2JzP29wZW49MScpXSk7CiAgY29uc3Qgb3ZlcmR1ZSA9IGpvYnMuZmlsdGVyKGogPT4geyBjb25zdCBkID0g' +
  'ZGF5c091dChqLmR1ZV9kYXRlKTsgcmV0dXJuIGQgIT09IG51bGwgJiYgZCA8IDA7IH0pOwogIGNvbnN0IHRvZGF5ID0gam9icy5m' +
  'aWx0ZXIoaiA9PiB7IGNvbnN0IGQgPSBkYXlzT3V0KGouZHVlX2RhdGUpOyByZXR1cm4gZCAhPT0gbnVsbCAmJiBkID49IDAgJiYg' +
  'ZCA8PSAxOyB9KTsKICBjb25zdCBydXNoID0gam9icy5maWx0ZXIoaiA9PiBqLnByaW9yaXR5ICE9PSAnUm91dGluZScpOwogIGNv' +
  'bnN0IG1pbmUgPSBpc0FkbWluKCkgPyBqb2JzIDogam9iczsKCiAgYXBwLmlubmVySFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFz' +
  'cz0icGFnZSI+JHtpc0FkbWluKCkgPyAnT3BlcmF0aW9ucyB0b2RheScgOiAnTXkgZGF5J308L2gxPgogICAgPGRpdiBjbGFzcz0i' +
  'c3RhdHMiPgogICAgICA8ZGl2IGNsYXNzPSJzdGF0Ij48ZGl2IGNsYXNzPSJuIj4ke3N0YXRzLm9wZW5fam9ic308L2Rpdj48ZGl2' +
  'IGNsYXNzPSJsIj5PcGVuIGpvYnM8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdCAke3N0YXRzLm92ZXJkdWUgPyAn' +
  'YWxlcnQnIDogJyd9Ij48ZGl2IGNsYXNzPSJuIj4ke3N0YXRzLm92ZXJkdWV9PC9kaXY+PGRpdiBjbGFzcz0ibCI+UGFzdCBkdWU8' +
  'L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdCI+PGRpdiBjbGFzcz0ibiI+JHtzdGF0cy5ydXNofTwvZGl2PjxkaXYg' +
  'Y2xhc3M9ImwiPlJ1c2ggLyBzYW1lIGRheTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdGF0IGdvb2QiPjxkaXYgY2xh' +
  'c3M9Im4iPiR7c3RhdHMuc2VydmVkXzdkfTwvZGl2PjxkaXYgY2xhc3M9ImwiPlNlcnZlZCwgNyBkYXlzPC9kaXY+PC9kaXY+CiAg' +
  'ICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPlJvdXRlIG15IGRheSA8c3BhbiBjbGFzcz0ic3ViIj7i' +
  'gJQgJHttaW5lLmxlbmd0aH0gb3BlbiBzdG9wJHttaW5lLmxlbmd0aCA9PT0gMSA/ICcnIDogJ3MnfTwvc3Bhbj48L2gyPgogICAg' +
  'ICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6LTRweCI+T3BlbnMgR29vZ2xlIE1hcHMgd2l0aCB5b3VyIHN0b3Bz' +
  'IGluIG9yZGVyICh1cCB0byAxMCkuIE5vIG1hcHBpbmcgZmVlcyDigJQgaXQganVzdCBoYW5kcyBvZmYgdG8gdGhlIGFwcCB5b3Ug' +
  'YWxyZWFkeSBoYXZlLjwvcD4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4KICAgICAgICA8' +
  'YnV0dG9uIGNsYXNzPSJidG4gbmF2IiBpZD0icm91dGVCdG4iICR7bWluZS5sZW5ndGggPyAnJyA6ICdkaXNhYmxlZCd9PlN0YXJ0' +
  'IHJvdXRlICgke01hdGgubWluKG1pbmUubGVuZ3RoLCAxMCl9IHN0b3BzKTwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9' +
  'ImJ0biBzZWMgc20iIGlkPSJyb3V0ZUxpc3QiPlNlZSBvcmRlcjwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAg' +
  'ICR7c2VjdGlvbignUGFzdCBkdWUnLCBvdmVyZHVlKX0KICAgICR7c2VjdGlvbignRHVlIHRvZGF5IG9yIHRvbW9ycm93JywgdG9k' +
  'YXkpfQogICAgJHtzZWN0aW9uKCdSdXNoICZhbXA7IHNhbWUgZGF5JywgcnVzaC5maWx0ZXIoaiA9PiAhb3ZlcmR1ZS5pbmNsdWRl' +
  'cyhqKSAmJiAhdG9kYXkuaW5jbHVkZXMoaikpKX0KICAgICR7b3ZlcmR1ZS5sZW5ndGggKyB0b2RheS5sZW5ndGggKyBydXNoLmxl' +
  'bmd0aCA9PT0gMAogICAgICA/IGA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJlbXB0eSI+Tm90aGluZyB1cmdlbnQuICR7' +
  'bWluZS5sZW5ndGh9IG9wZW4gam9iJHttaW5lLmxlbmd0aCA9PT0gMSA/ICcnIDogJ3MnfSB0b3RhbCDigJQgc2VlIHRoZSBKb2Jz' +
  'IHRhYi48L2Rpdj48L2Rpdj5gIDogJyd9CiAgYCk7CiAgYmluZFNoZWxsKCk7CiAgYmluZEpvYkl0ZW1zKCk7CiAgY29uc3QgcmIg' +
  'PSAkKCcjcm91dGVCdG4nKTsKICBpZiAocmIpIHJiLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBjb25zdCB1cmwgPSByb3V0ZVVybCht' +
  'aW5lLnNsaWNlKDAsIDEwKSk7CiAgICBpZiAodXJsKSB3aW5kb3cub3Blbih1cmwsICdfYmxhbmsnKTsKICB9OwogICQoJyNyb3V0' +
  'ZUxpc3QnKS5vbmNsaWNrID0gKCkgPT4gc2hlZXQoJ1JvdXRlIG9yZGVyJywgYAogICAgPHAgY2xhc3M9ImhpbnQiPk9yZGVyZWQg' +
  'YnkgcHJpb3JpdHksIHRoZW4gZHVlIGRhdGUuIFRhcCBhbnkgc3RvcCB0byBuYXZpZ2F0ZSB0byBpdCBhbG9uZS48L3A+CiAgICA8' +
  'ZGl2IGNsYXNzPSJsaXN0Ij4ke21pbmUuc2xpY2UoMCwgMTApLm1hcCgoaiwgaSkgPT4gYAogICAgICA8ZGl2IGNsYXNzPSJpdGVt' +
  'IiBkYXRhLW5hdj0iJHtlc2MoYWRkck9mKGopKX0iPgogICAgICAgIDxkaXYgY2xhc3M9InIiPjxkaXY+PGRpdiBjbGFzcz0idCI+' +
  'JHtpICsgMX0uICR7ZXNjKGoucmVjaXBpZW50X25hbWUpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im0iPiR7ZXNjKGFkZHJP' +
  'ZihqKSl9PC9kaXY+PC9kaXY+CiAgICAgICAgPHNwYW4gY2xhc3M9InBpbGwgJHtjbHMoai5wcmlvcml0eSl9Ij4ke2VzYyhqLnBy' +
  'aW9yaXR5KX08L3NwYW4+PC9kaXY+PC9kaXY+YCkuam9pbignJyl9PC9kaXY+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIGJs' +
  'b2NrIiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4IiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNsb3NlPC9idXR0b24+YCwKICAgIGVs' +
  'ID0+IGVsLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLW5hdl0nKS5mb3JFYWNoKG4gPT4KICAgICAgbi5vbmNsaWNrID0gKCkgPT4g' +
  'd2luZG93Lm9wZW4obmF2VXJsKG4uZGF0YXNldC5uYXYpLCAnX2JsYW5rJykpKTsKfQoKZnVuY3Rpb24gc2VjdGlvbih0aXRsZSwg' +
  'bGlzdCkgewogIGlmICghbGlzdC5sZW5ndGgpIHJldHVybiAnJzsKICByZXR1cm4gYDxkaXYgY2xhc3M9ImNhcmQiPjxoMj4ke3Rp' +
  'dGxlfSA8c3BhbiBjbGFzcz0ic3ViIj4ke2xpc3QubGVuZ3RofTwvc3Bhbj48L2gyPgogICAgPGRpdiBjbGFzcz0ibGlzdCI+JHts' +
  'aXN0Lm1hcChqb2JJdGVtKS5qb2luKCcnKX08L2Rpdj48L2Rpdj5gOwp9CgpmdW5jdGlvbiBqb2JJdGVtKGopIHsKICBjb25zdCBk' +
  'ID0gZGF5c091dChqLmR1ZV9kYXRlKTsKICBjb25zdCBsYXRlID0gZCAhPT0gbnVsbCAmJiBkIDwgMCAmJiAhWydTZXJ2ZWQnLCAn' +
  'Tm9uLUVzdCcsICdDYW5jZWxsZWQnXS5pbmNsdWRlcyhqLnN0YXR1cyk7CiAgY29uc3QgZHVlID0gai5kdWVfZGF0ZQogICAgPyAo' +
  'bGF0ZSA/IGA8c3BhbiBzdHlsZT0iY29sb3I6dmFyKC0tYmFkKTtmb250LXdlaWdodDo2MDAiPiR7TWF0aC5hYnMoZCl9ZCBwYXN0' +
  'IGR1ZTwvc3Bhbj5gCiAgICAgICAgICAgIDogKGQgPT09IDAgPyAnZHVlIHRvZGF5JyA6IGQgPT09IDEgPyAnZHVlIHRvbW9ycm93' +
  'JyA6ICdkdWUgJyArIGZtdERhdGVPbmx5KGouZHVlX2RhdGUpKSkKICAgIDogJ25vIGR1ZSBkYXRlJzsKICByZXR1cm4gYDxkaXYg' +
  'Y2xhc3M9Iml0ZW0gcC0ke2NscyhqLnByaW9yaXR5KX0gJHtsYXRlID8gJ292ZXJkdWUnIDogJyd9IiBkYXRhLWpvYj0iJHtqLmlk' +
  'fSI+CiAgICA8ZGl2IGNsYXNzPSJyIj4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0Ij4ke2VzYyhqLnJlY2lwaWVu' +
  'dF9uYW1lKX08L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtIj4ke2VzYyhqLmpvYl9udW1iZXIpfSDCtyAke2VzYyhqLmNpdHkg' +
  'fHwgJycpfSR7ai5jaXR5ID8gJywgJyA6ICcnfSR7ZXNjKGouc3RhdGUgfHwgJycpfSDCtyAke2R1ZX08L2Rpdj4KICAgICAgICA8' +
  'ZGl2IGNsYXNzPSJtIj4ke2VzYyhqLmNsaWVudF9uYW1lIHx8ICdObyBjbGllbnQnKX0ke2ouc2VydmVyX25hbWUgPyAnIOKGkiAn' +
  'ICsgZXNjKGouc2VydmVyX25hbWUpIDogJyd9JHtqLmF0dGVtcHRfY291bnQgPyAnIMK3ICcgKyBqLmF0dGVtcHRfY291bnQgKyAn' +
  'IGF0dGVtcHQnICsgKGouYXR0ZW1wdF9jb3VudCA9PT0gMSA/ICcnIDogJ3MnKSA6ICcnfTwvZGl2PgogICAgICA8L2Rpdj4KICAg' +
  'ICAgPGRpdiBzdHlsZT0idGV4dC1hbGlnbjpyaWdodCI+CiAgICAgICAgPHNwYW4gY2xhc3M9InBpbGwgJHtjbHMoai5zdGF0dXMp' +
  'fSI+JHtlc2Moai5zdGF0dXMpfTwvc3Bhbj4KICAgICAgICAke2oucHJpb3JpdHkgIT09ICdSb3V0aW5lJyA/IGA8ZGl2IHN0eWxl' +
  'PSJtYXJnaW4tdG9wOjVweCI+PHNwYW4gY2xhc3M9InBpbGwgcnVzaCI+JHtlc2Moai5wcmlvcml0eSl9PC9zcGFuPjwvZGl2PmAg' +
  'OiAnJ30KICAgICAgPC9kaXY+CiAgICA8L2Rpdj48L2Rpdj5gOwp9CgpmdW5jdGlvbiBiaW5kSm9iSXRlbXMoKSB7CiAgZG9jdW1l' +
  'bnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtam9iXScpLmZvckVhY2goZWwgPT4KICAgIGVsLm9uY2xpY2sgPSAoKSA9PiBnbygn' +
  'am9iJywgeyBpZDogZWwuZGF0YXNldC5qb2IgfSkpOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gam9icyAtLSAqLwphc3luYyBmdW5jdGlvbiBqb2JzVmlldygpIHsKICBjb25zdCBm' +
  'ID0gUy5wYXJhbXM7CiAgY29uc3QgcXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKCk7CiAgaWYgKGYuc3RhdHVzKSBxcy5zZXQoJ3N0' +
  'YXR1cycsIGYuc3RhdHVzKTsKICBpZiAoZi5xKSBxcy5zZXQoJ3EnLCBmLnEpOwogIGlmIChmLm9wZW4pIHFzLnNldCgnb3Blbics' +
  'ICcxJyk7CiAgY29uc3Qgam9icyA9IGF3YWl0IGFwaSgnL2pvYnM/JyArIHFzLnRvU3RyaW5nKCkpOwoKICBhcHAuaW5uZXJIVE1M' +
  'ID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj4ke2lzQWRtaW4oKSA/ICdKb2JzJyA6ICdNeSBqb2JzJ308L2gxPgogICAg' +
  'PGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9InJvdyI+CiAgICAgICAgPGlucHV0IGlkPSJxIiBwbGFjZWhvbGRl' +
  'cj0iU2VhcmNoIG5hbWUsIGNhc2UgIywgam9iICMsIGFkZHJlc3MiIHZhbHVlPSIke2VzYyhmLnEgfHwgJycpfSIgc3R5bGU9ImZs' +
  'ZXg6MTttaW4td2lkdGg6MTYwcHgiPgogICAgICAgIDxzZWxlY3QgaWQ9InN0YXR1cyIgc3R5bGU9IndpZHRoOmF1dG8iPgogICAg' +
  'ICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5Bbnkgc3RhdHVzPC9vcHRpb24+CiAgICAgICAgICAke1snUGVuZGluZycsICdBc3NpZ25l' +
  'ZCcsICdBdHRlbXB0ZWQnLCAnU2VydmVkJywgJ05vbi1Fc3QnLCAnT24gSG9sZCcsICdDYW5jZWxsZWQnXQogICAgICAgICAgICAu' +
  'bWFwKHMgPT4gYDxvcHRpb24gJHtmLnN0YXR1cyA9PT0gcyA/ICdzZWxlY3RlZCcgOiAnJ30+JHtzfTwvb3B0aW9uPmApLmpvaW4o' +
  'JycpfQogICAgICAgIDwvc2VsZWN0PgogICAgICAgIDxsYWJlbCBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRl' +
  'cjtnYXA6NnB4O21hcmdpbjowO2ZvbnQtc2l6ZToxM3B4Ij4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJjaGVja2JveCIgaWQ9Im9w' +
  'ZW5Pbmx5IiAke2Yub3BlbiA/ICdjaGVja2VkJyA6ICcnfSBzdHlsZT0id2lkdGg6YXV0byI+IE9wZW4gb25seTwvbGFiZWw+CiAg' +
  'ICAgIDwvZGl2PgogICAgICAke2lzQWRtaW4oKSA/ICc8YnV0dG9uIGNsYXNzPSJidG4gYmxvY2siIGlkPSJuZXdKb2IiIHN0eWxl' +
  'PSJtYXJnaW4tdG9wOjEwcHgiPisgTmV3IGpvYjwvYnV0dG9uPicgOiAnJ30KICAgIDwvZGl2PgogICAgJHtqb2JzLmxlbmd0aCA/' +
  'IGA8ZGl2IGNsYXNzPSJsaXN0Ij4ke2pvYnMubWFwKGpvYkl0ZW0pLmpvaW4oJycpfTwvZGl2PmAKICAgICAgOiAnPGRpdiBjbGFz' +
  'cz0iY2FyZCI+PGRpdiBjbGFzcz0iZW1wdHkiPk5vIGpvYnMgbWF0Y2guPC9kaXY+PC9kaXY+J30KICBgKTsKICBiaW5kU2hlbGwo' +
  'KTsgYmluZEpvYkl0ZW1zKCk7CiAgY29uc3QgYXBwbHkgPSAoKSA9PiBnbygnam9icycsIHsgcTogJCgnI3EnKS52YWx1ZS50cmlt' +
  'KCksIHN0YXR1czogJCgnI3N0YXR1cycpLnZhbHVlLCBvcGVuOiAkKCcjb3Blbk9ubHknKS5jaGVja2VkIH0pOwogICQoJyNxJyku' +
  'b25rZXlkb3duID0gZSA9PiB7IGlmIChlLmtleSA9PT0gJ0VudGVyJykgYXBwbHkoKTsgfTsKICAkKCcjc3RhdHVzJykub25jaGFu' +
  'Z2UgPSBhcHBseTsKICAkKCcjb3Blbk9ubHknKS5vbmNoYW5nZSA9IGFwcGx5OwogIGlmICgkKCcjbmV3Sm9iJykpICQoJyNuZXdK' +
  'b2InKS5vbmNsaWNrID0gKCkgPT4gam9iRm9ybShudWxsKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGpvYiBmb3JtIC0tICovCmFzeW5jIGZ1bmN0aW9uIGpvYkZvcm0oam9iKSB7CiAg' +
  'Y29uc3QgW2NsaWVudHMsIHVzZXJzXSA9IGF3YWl0IFByb21pc2UuYWxsKFthcGkoJy9jbGllbnRzJyksIGFwaSgnL3VzZXJzJyld' +
  'KTsKICBjb25zdCB2ID0gam9iIHx8IHsgc2VydmljZV90eXBlOiAnUGVyc29uYWwnLCBwcmlvcml0eTogJ1JvdXRpbmUnLCBzdGF0' +
  'dXM6ICdQZW5kaW5nJyB9OwogIGNvbnN0IG9wdCA9IChsaXN0LCBzZWwsIGxhYmVsKSA9PiBsaXN0Lm1hcCh4ID0+CiAgICBgPG9w' +
  'dGlvbiB2YWx1ZT0iJHt4LmlkfSIgJHtTdHJpbmcoc2VsKSA9PT0gU3RyaW5nKHguaWQpID8gJ3NlbGVjdGVkJyA6ICcnfT4ke2Vz' +
  'YyhsYWJlbCh4KSl9PC9vcHRpb24+YCkuam9pbignJyk7CgogIHNoZWV0KGpvYiA/ICdFZGl0ICcgKyBqb2Iuam9iX251bWJlciA6' +
  'ICdOZXcgam9iJywgYAogICAgPGRpdiBjbGFzcz0iZHJvcHpvbmUiPgogICAgICA8bGFiZWw+U3RhcnQgZnJvbSB0aGUgcGFwZXJz' +
  'PC9sYWJlbD4KICAgICAgPGlucHV0IHR5cGU9ImZpbGUiIGlkPSJmX3BkZiIgYWNjZXB0PSJhcHBsaWNhdGlvbi9wZGYsLnBkZiI+' +
  'CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIGlkPSJwZGZNc2ciPlBpY2sgdGhlIHN1bW1vbnMsIGNpdGF0aW9uLCBzdWJwb2VuYSBv' +
  'ciBjb21wbGFpbnQgYXMgYSBQREYgYW5kIEknbGwKICAgICAgICByZWFkIHdoYXQgSSBjYW4gaW50byB0aGUgZm9ybSBiZWxvdy4g' +
  'QWx3YXlzIGNoZWNrIGl0IGFnYWluc3QgdGhlIGRvY3VtZW50IGJlZm9yZSBzYXZpbmcuPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxk' +
  'aXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNsaWVudDwvbGFiZWw+PHNlbGVjdCBp' +
  'ZD0iZl9jbGllbnRfaWQiPgogICAgICAgIDxvcHRpb24gdmFsdWU9IiI+4oCUIG5vbmUg4oCUPC9vcHRpb24+JHtvcHQoY2xpZW50' +
  'cywgdi5jbGllbnRfaWQsIGMgPT4gYy5uYW1lKX08L3NlbGVjdD48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJl' +
  'bD5Bc3NpZ24gdG88L2xhYmVsPjxzZWxlY3QgaWQ9ImZfYXNzaWduZWRfdG8iPgogICAgICAgIDxvcHRpb24gdmFsdWU9IiI+4oCU' +
  'IHVuYXNzaWduZWQg4oCUPC9vcHRpb24+JHtvcHQodXNlcnMuZmlsdGVyKHUgPT4gdS5hY3RpdmUpLCB2LmFzc2lnbmVkX3RvLCB1' +
  'ID0+IHUubmFtZSl9PC9zZWxlY3Q+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGVyc29u' +
  'IC8gZW50aXR5IHRvIHNlcnZlICo8L2xhYmVsPjxpbnB1dCBpZD0iZl9yZWNpcGllbnRfbmFtZSIgdmFsdWU9IiR7ZXNjKHYucmVj' +
  'aXBpZW50X25hbWUpfSI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlNlcnZpY2UgYWRkcmVzczwvbGFiZWw+' +
  'PGlucHV0IGlkPSJmX2FkZHJlc3MxIiBwbGFjZWhvbGRlcj0iU3RyZWV0IGFkZHJlc3MiIHZhbHVlPSIke2VzYyh2LmFkZHJlc3Mx' +
  'KX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZCBnMyI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+QXB0IC8g' +
  'dW5pdDwvbGFiZWw+PGlucHV0IGlkPSJmX2FkZHJlc3MyIiB2YWx1ZT0iJHtlc2Modi5hZGRyZXNzMil9Ij48L2Rpdj4KICAgICAg' +
  'PGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5DaXR5PC9sYWJlbD48aW5wdXQgaWQ9ImZfY2l0eSIgdmFsdWU9IiR7ZXNjKHYuY2l0' +
  'eSl9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5TdGF0ZSAvIFpJUDwvbGFiZWw+CiAgICAgICAgPGRp' +
  'diBjbGFzcz0icm93Ij48aW5wdXQgaWQ9ImZfc3RhdGUiIHN0eWxlPSJ3aWR0aDo3MHB4IiBtYXhsZW5ndGg9IjIiIHZhbHVlPSIk' +
  'e2VzYyh2LnN0YXRlKX0iPgogICAgICAgIDxpbnB1dCBpZD0iZl96aXAiIHN0eWxlPSJmbGV4OjEiIGlucHV0bW9kZT0ibnVtZXJp' +
  'YyIgdmFsdWU9IiR7ZXNjKHYuemlwKX0iPjwvZGl2PjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxh' +
  'YmVsPlJlY2lwaWVudCBub3RlcyAoZGVzY3JpcHRpb24sIHdvcmsgaG91cnMsIHZlaGljbGUsIGdhdGUgY29kZSk8L2xhYmVsPgog' +
  'ICAgICA8dGV4dGFyZWEgaWQ9ImZfcmVjaXBpZW50X25vdGVzIiBzdHlsZT0ibWluLWhlaWdodDo2MHB4Ij4ke2VzYyh2LnJlY2lw' +
  'aWVudF9ub3Rlcyl9PC90ZXh0YXJlYT48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICA8ZGl2IGNsYXNzPSJm' +
  'aWVsZCI+PGxhYmVsPkNhc2UgbnVtYmVyPC9sYWJlbD48aW5wdXQgaWQ9ImZfY2FzZV9udW1iZXIiIHZhbHVlPSIke2VzYyh2LmNh' +
  'c2VfbnVtYmVyKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNvdXJ0PC9sYWJlbD48aW5wdXQgaWQ9' +
  'ImZfY291cnQiIHZhbHVlPSIke2VzYyh2LmNvdXJ0KX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBs' +
  'YWludGlmZjwvbGFiZWw+PGlucHV0IGlkPSJmX3BsYWludGlmZiIgdmFsdWU9IiR7ZXNjKHYucGxhaW50aWZmKX0iPjwvZGl2Pgog' +
  'ICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkRlZmVuZGFudDwvbGFiZWw+PGlucHV0IGlkPSJmX2RlZmVuZGFudCIgdmFs' +
  'dWU9IiR7ZXNjKHYuZGVmZW5kYW50KX0iPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkRv' +
  'Y3VtZW50cyB0byBzZXJ2ZTwvbGFiZWw+PGlucHV0IGlkPSJmX2RvY3VtZW50cyIgcGxhY2Vob2xkZXI9IlN1bW1vbnMgYW5kIENv' +
  'bXBsYWludCIgdmFsdWU9IiR7ZXNjKHYuZG9jdW1lbnRzKX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZCBnMyI+CiAgICAg' +
  'IDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U2VydmljZSB0eXBlPC9sYWJlbD48c2VsZWN0IGlkPSJmX3NlcnZpY2VfdHlwZSI+' +
  'CiAgICAgICAgJHtbJ1BlcnNvbmFsJywgJ1N1YnN0aXR1dGUnLCAnUG9zdGluZycsICdDZXJ0aWZpZWQgTWFpbCcsICdDb3Jwb3Jh' +
  'dGUnXS5tYXAocyA9PiBgPG9wdGlvbiAke3Yuc2VydmljZV90eXBlID09PSBzID8gJ3NlbGVjdGVkJyA6ICcnfT4ke3N9PC9vcHRp' +
  'b24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UHJpb3JpdHk8L2xh' +
  'YmVsPjxzZWxlY3QgaWQ9ImZfcHJpb3JpdHkiPgogICAgICAgICR7WydSb3V0aW5lJywgJ1J1c2gnLCAnU2FtZSBEYXknXS5tYXAo' +
  'cyA9PiBgPG9wdGlvbiAke3YucHJpb3JpdHkgPT09IHMgPyAnc2VsZWN0ZWQnIDogJyd9PiR7c308L29wdGlvbj5gKS5qb2luKCcn' +
  'KX08L3NlbGVjdD48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5EdWUgZGF0ZTwvbGFiZWw+PGlucHV0IGlk' +
  'PSJmX2R1ZV9kYXRlIiB0eXBlPSJkYXRlIiB2YWx1ZT0iJHt2LmR1ZV9kYXRlID8gU3RyaW5nKHYuZHVlX2RhdGUpLnNsaWNlKDAs' +
  'IDEwKSA6ICcnfSI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQgZzMiPgogICAgICA8ZGl2IGNsYXNzPSJm' +
  'aWVsZCI+PGxhYmVsPkNsaWVudCBmZWU8L2xhYmVsPjxpbnB1dCBpZD0iZl9jbGllbnRfZmVlIiB0eXBlPSJudW1iZXIiIHN0ZXA9' +
  'IjAuMDEiIHZhbHVlPSIke3YuY2xpZW50X2ZlZSB8fCAnJ30iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVs' +
  'PlNlcnZlciBwYXk8L2xhYmVsPjxpbnB1dCBpZD0iZl9zZXJ2ZXJfcGF5IiB0eXBlPSJudW1iZXIiIHN0ZXA9IjAuMDEiIHZhbHVl' +
  'PSIke3Yuc2VydmVyX3BheSB8fCAnJ30iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlN0YXR1czwvbGFi' +
  'ZWw+PHNlbGVjdCBpZD0iZl9zdGF0dXMiPgogICAgICAgICR7WydQZW5kaW5nJywgJ0Fzc2lnbmVkJywgJ0F0dGVtcHRlZCcsICdT' +
  'ZXJ2ZWQnLCAnTm9uLUVzdCcsICdPbiBIb2xkJywgJ0NhbmNlbGxlZCddLm1hcChzID0+IGA8b3B0aW9uICR7di5zdGF0dXMgPT09' +
  'IHMgPyAnc2VsZWN0ZWQnIDogJyd9PiR7c308L29wdGlvbj5gKS5qb2luKCcnKX08L3NlbGVjdD48L2Rpdj4KICAgIDwvZGl2Pgog' +
  'ICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5JbnRlcm5hbCBub3RlczwvbGFiZWw+PHRleHRhcmVhIGlkPSJmX25vdGVzIiBz' +
  'dHlsZT0ibWluLWhlaWdodDo2MHB4Ij4ke2VzYyh2Lm5vdGVzKX08L3RleHRhcmVhPjwvZGl2PgogICAgPGRpdiBjbGFzcz0icm93' +
  'IiBzdHlsZT0ibWFyZ2luLXRvcDo2cHgiPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJzYXZlIj4ke2pvYiA/ICdTYXZl' +
  'IGNoYW5nZXMnIDogJ0NyZWF0ZSBqb2InfTwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJj' +
  'bG9zZVNoZWV0KCkiPkNhbmNlbDwvYnV0dG9uPgogICAgICAke2pvYiA/ICc8YnV0dG9uIGNsYXNzPSJidG4gZ2hvc3QiIGlkPSJk' +
  'ZWwiIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQpO21hcmdpbi1sZWZ0OmF1dG8iPkRlbGV0ZTwvYnV0dG9uPicgOiAnJ30KICAgIDwv' +
  'ZGl2PmAsIGVsID0+IHsKICAgIC8qIC0tLS0gcmVhZCBhIHN1bW1vbnMvY2l0YXRpb24gUERGIGFuZCBmaWxsIHdoYXQgd2UgY2Fu' +
  'IC0tLS0gKi8KICAgIGNvbnN0IHBkZk1zZyA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNwZGZNc2cnKTsKICAgIGNvbnN0IEZJTExBQkxF' +
  'ID0gWydjYXNlX251bWJlcicsICdjb3VydCcsICdwbGFpbnRpZmYnLCAnZGVmZW5kYW50JywgJ3JlY2lwaWVudF9uYW1lJywKICAg' +
  'ICAgJ2FkZHJlc3MxJywgJ2FkZHJlc3MyJywgJ2NpdHknLCAnc3RhdGUnLCAnemlwJywgJ2RvY3VtZW50cyddOwogICAgY29uc3Qg' +
  'TEFCRUxTID0gewogICAgICBjYXNlX251bWJlcjogJ2Nhc2UgbnVtYmVyJywgY291cnQ6ICdjb3VydCcsIHBsYWludGlmZjogJ3Bs' +
  'YWludGlmZicsIGRlZmVuZGFudDogJ2RlZmVuZGFudCcsCiAgICAgIHJlY2lwaWVudF9uYW1lOiAncGVyc29uIHRvIHNlcnZlJywg' +
  'YWRkcmVzczE6ICdhZGRyZXNzJywgYWRkcmVzczI6ICd1bml0JywgY2l0eTogJ2NpdHknLAogICAgICBzdGF0ZTogJ3N0YXRlJywg' +
  'emlwOiAnWklQJywgZG9jdW1lbnRzOiAnZG9jdW1lbnRzJwogICAgfTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNmX3BkZicpLm9u' +
  'Y2hhbmdlID0gYXN5bmMgZSA9PiB7CiAgICAgIGNvbnN0IGZpbGUgPSBlLnRhcmdldC5maWxlcyAmJiBlLnRhcmdldC5maWxlc1sw' +
  'XTsKICAgICAgaWYgKCFmaWxlKSByZXR1cm47CiAgICAgIHBkZk1zZy5pbm5lckhUTUwgPSAnUmVhZGluZyAnICsgZXNjKGZpbGUu' +
  'bmFtZSkgKyAn4oCmJzsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgbmV3IFByb21pc2UoKHJlcywgcmVq' +
  'KSA9PiB7CiAgICAgICAgICBjb25zdCByID0gbmV3IEZpbGVSZWFkZXIoKTsKICAgICAgICAgIHIub25sb2FkID0gKCkgPT4gcmVz' +
  'KFN0cmluZyhyLnJlc3VsdCkuc3BsaXQoJywnKVsxXSk7CiAgICAgICAgICByLm9uZXJyb3IgPSAoKSA9PiByZWoobmV3IEVycm9y' +
  'KCdDb3VsZCBub3QgcmVhZCB0aGF0IGZpbGUnKSk7CiAgICAgICAgICByLnJlYWRBc0RhdGFVUkwoZmlsZSk7CiAgICAgICAgfSk7' +
  'CiAgICAgICAgY29uc3Qgb3V0ID0gYXdhaXQgYXBpKCcvcGFyc2UtZG9jdW1lbnQnLCB7CiAgICAgICAgICBtZXRob2Q6ICdQT1NU' +
  'JywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBuYW1lOiBmaWxlLm5hbWUsIGRhdGEgfSkKICAgICAgICB9KTsKICAgICAgICBpZiAo' +
  'b3V0Lndhcm5pbmcpIHsgcGRmTXNnLmlubmVySFRNTCA9ICc8YiBzdHlsZT0iY29sb3I6dmFyKC0td2FybikiPicgKyBlc2Mob3V0' +
  'Lndhcm5pbmcpICsgJzwvYj4nOyByZXR1cm47IH0KICAgICAgICBjb25zdCBmaWxsZWQgPSBbXSwgc2tpcHBlZCA9IFtdLCBtaXNz' +
  'ZWQgPSBbXTsKICAgICAgICBmb3IgKGNvbnN0IGYgb2YgRklMTEFCTEUpIHsKICAgICAgICAgIGNvbnN0IGlucHV0ID0gZWwucXVl' +
  'cnlTZWxlY3RvcignI2ZfJyArIGYpOwogICAgICAgICAgaWYgKCFpbnB1dCkgY29udGludWU7CiAgICAgICAgICBjb25zdCB2YWwg' +
  'PSBvdXQuZmllbGRzW2ZdOwogICAgICAgICAgaWYgKCF2YWwpIHsgbWlzc2VkLnB1c2goTEFCRUxTW2ZdKTsgY29udGludWU7IH0K' +
  'ICAgICAgICAgIGlmIChpbnB1dC52YWx1ZSAmJiBpbnB1dC52YWx1ZS50cmltKCkgJiYgaW5wdXQudmFsdWUudHJpbSgpICE9PSBT' +
  'dHJpbmcodmFsKS50cmltKCkpIHsKICAgICAgICAgICAgc2tpcHBlZC5wdXNoKExBQkVMU1tmXSk7CiAgICAgICAgICAgIGNvbnRp' +
  'bnVlOwogICAgICAgICAgfQogICAgICAgICAgaW5wdXQudmFsdWUgPSB2YWw7CiAgICAgICAgICBpbnB1dC5zdHlsZS5iYWNrZ3Jv' +
  'dW5kID0gJyNlOWY2ZWUnOwogICAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7IGlucHV0LnN0eWxlLmJhY2tncm91bmQgPSAnJzsg' +
  'fSwgNDAwMCk7CiAgICAgICAgICBmaWxsZWQucHVzaChMQUJFTFNbZl0pOwogICAgICAgIH0KICAgICAgICBsZXQgbXNnOwogICAg' +
  'ICAgIGlmIChmaWxsZWQubGVuZ3RoKSB7CiAgICAgICAgICBtc2cgPSAnPGIgc3R5bGU9ImNvbG9yOnZhcigtLW9rKSI+RmlsbGVk' +
  'ICcgKyBmaWxsZWQubGVuZ3RoICsgJyBmaWVsZCcgKyAoZmlsbGVkLmxlbmd0aCA9PT0gMSA/ICcnIDogJ3MnKSArCiAgICAgICAg' +
  'ICAgICc8L2I+IGZyb20gJyArIGVzYyhmaWxlLm5hbWUpICsgJyAoJyArIChvdXQucGFnZXMgfHwgJz8nKSArICcgcGFnZScgKyAo' +
  'b3V0LnBhZ2VzID09PSAxID8gJycgOiAncycpICsgJyk6ICcgKwogICAgICAgICAgICBlc2MoZmlsbGVkLmpvaW4oJywgJykpICsg' +
  'Jy4nOwogICAgICAgIH0gZWxzZSBpZiAoc2tpcHBlZC5sZW5ndGgpIHsKICAgICAgICAgIG1zZyA9ICc8YiBzdHlsZT0iY29sb3I6' +
  'dmFyKC0td2FybikiPkV2ZXJ5dGhpbmcgSSBmb3VuZCB3YXMgYWxyZWFkeSBmaWxsZWQgaW48L2I+IOKAlCBub3RoaW5nIG9mIHlv' +
  'dXJzIHdhcyAnICsKICAgICAgICAgICAgJ292ZXJ3cml0dGVuLiBDbGVhciBhIGZpZWxkIGZpcnN0IGlmIHlvdSB3YW50IHRoZSBk' +
  'b2N1bWVudFwncyB2ZXJzaW9uIG9mIGl0Lic7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIG1zZyA9ICc8YiBzdHlsZT0iY29s' +
  'b3I6dmFyKC0td2FybikiPk5vdGhpbmcgcmVjb2duaXNhYmxlIGZvdW5kPC9iPiBpbiAnICsgZXNjKGZpbGUubmFtZSkgKwogICAg' +
  'ICAgICAgICAnLiBJdCBtYXkgYmUgbGFpZCBvdXQgZGlmZmVyZW50bHkgdG8gdGhlIGRvY3VtZW50cyB0aGlzIGNhbiByZWFkIOKA' +
  'lCBmaWxsIHRoZSBqb2IgaW4gYnkgaGFuZC4nOwogICAgICAgIH0KICAgICAgICBpZiAoZmlsbGVkLmxlbmd0aCAmJiBza2lwcGVk' +
  'Lmxlbmd0aCkgbXNnICs9ICcgTGVmdCB5b3VyIGV4aXN0aW5nICcgKyBlc2Moc2tpcHBlZC5qb2luKCcsICcpKSArICcgYWxvbmUu' +
  'JzsKICAgICAgICBpZiAobWlzc2VkLmxlbmd0aCkgbXNnICs9ICcgTm90IGZvdW5kOiAnICsgZXNjKG1pc3NlZC5qb2luKCcsICcp' +
  'KSArICcuJzsKICAgICAgICBtc2cgKz0gJzxicj48Yj5DaGVjayBldmVyeSBmaWxsZWQgZmllbGQgYWdhaW5zdCB0aGUgZG9jdW1l' +
  'bnQgYmVmb3JlIHNhdmluZy48L2I+JzsKICAgICAgICBwZGZNc2cuaW5uZXJIVE1MID0gbXNnOwogICAgICB9IGNhdGNoIChlcnIp' +
  'IHsKICAgICAgICBwZGZNc2cuaW5uZXJIVE1MID0gJzxiIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQpIj4nICsgZXNjKGVyci5tZXNz' +
  'YWdlKSArICc8L2I+JzsKICAgICAgfQogICAgfTsKCiAgICAvLyBhdXRvLWZpbGwgZmVlL3BheSBkZWZhdWx0cyBmcm9tIHRoZSBz' +
  'ZWxlY3RlZCBjbGllbnQgLyBzZXJ2ZXIKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNmX2NsaWVudF9pZCcpLm9uY2hhbmdlID0gZSA9' +
  'PiB7CiAgICAgIGNvbnN0IGMgPSBjbGllbnRzLmZpbmQoeCA9PiBTdHJpbmcoeC5pZCkgPT09IGUudGFyZ2V0LnZhbHVlKTsKICAg' +
  'ICAgaWYgKGMgJiYgYy5kZWZhdWx0X2ZlZSAmJiAhZWwucXVlcnlTZWxlY3RvcignI2ZfY2xpZW50X2ZlZScpLnZhbHVlKQogICAg' +
  'ICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNmX2NsaWVudF9mZWUnKS52YWx1ZSA9IE51bWJlcihjLmRlZmF1bHRfZmVlKS50b0ZpeGVk' +
  'KDIpOwogICAgfTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNmX2Fzc2lnbmVkX3RvJykub25jaGFuZ2UgPSBlID0+IHsKICAgICAg' +
  'Y29uc3QgdSA9IHVzZXJzLmZpbmQoeCA9PiBTdHJpbmcoeC5pZCkgPT09IGUudGFyZ2V0LnZhbHVlKTsKICAgICAgaWYgKHUgJiYg' +
  'dS5kZWZhdWx0X3BheSAmJiAhZWwucXVlcnlTZWxlY3RvcignI2Zfc2VydmVyX3BheScpLnZhbHVlKQogICAgICAgIGVsLnF1ZXJ5' +
  'U2VsZWN0b3IoJyNmX3NlcnZlcl9wYXknKS52YWx1ZSA9IE51bWJlcih1LmRlZmF1bHRfcGF5KS50b0ZpeGVkKDIpOwogICAgfTsK' +
  'ICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNzYXZlJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgYm9keSA9IHt9' +
  'OwogICAgICBbJ2NsaWVudF9pZCcsJ2Fzc2lnbmVkX3RvJywncmVjaXBpZW50X25hbWUnLCdhZGRyZXNzMScsJ2FkZHJlc3MyJywn' +
  'Y2l0eScsJ3N0YXRlJywnemlwJywncmVjaXBpZW50X25vdGVzJywKICAgICAgICdjYXNlX251bWJlcicsJ2NvdXJ0JywncGxhaW50' +
  'aWZmJywnZGVmZW5kYW50JywnZG9jdW1lbnRzJywnc2VydmljZV90eXBlJywncHJpb3JpdHknLCdkdWVfZGF0ZScsCiAgICAgICAn' +
  'Y2xpZW50X2ZlZScsJ3NlcnZlcl9wYXknLCdzdGF0dXMnLCdub3RlcyddLmZvckVhY2goZiA9PiB7IGJvZHlbZl0gPSBlbC5xdWVy' +
  'eVNlbGVjdG9yKCcjZl8nICsgZikudmFsdWU7IH0pOwogICAgICBpZiAoIWJvZHkucmVjaXBpZW50X25hbWUudHJpbSgpKSByZXR1' +
  'cm4gdG9hc3QoJ1dobyBhcmUgd2Ugc2VydmluZz8nLCB0cnVlKTsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBzYXZlZCA9IGpv' +
  'YgogICAgICAgICAgPyBhd2FpdCBhcGkoJy9qb2JzLycgKyBqb2IuaWQsIHsgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBKU09OLnN0' +
  'cmluZ2lmeShib2R5KSB9KQogICAgICAgICAgOiBhd2FpdCBhcGkoJy9qb2JzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNP' +
  'Ti5zdHJpbmdpZnkoYm9keSkgfSk7CiAgICAgICAgY2xvc2VTaGVldCgpOyB0b2FzdChqb2IgPyAnU2F2ZWQnIDogJ0pvYiAnICsg' +
  'c2F2ZWQuam9iX251bWJlciArICcgY3JlYXRlZCcpOwogICAgICAgIGdvKCdqb2InLCB7IGlkOiBzYXZlZC5pZCB9KTsKICAgICAg' +
  'fSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgICB9OwogICAgaWYgKGVsLnF1ZXJ5U2VsZWN0b3IoJyNk' +
  'ZWwnKSkgZWwucXVlcnlTZWxlY3RvcignI2RlbCcpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGlmICghY29uZmlybSgn' +
  'RGVsZXRlIHRoaXMgam9iIGFuZCBhbGwgaXRzIGF0dGVtcHRzPycpKSByZXR1cm47CiAgICAgIGF3YWl0IGFwaSgnL2pvYnMvJyAr' +
  'IGpvYi5pZCwgeyBtZXRob2Q6ICdERUxFVEUnIH0pOwogICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KCdEZWxldGVkJyk7IGdvKCdq' +
  'b2JzJyk7CiAgICB9OwogIH0pOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tIGpvYiBkZXRhaWwgLS0gKi8KYXN5bmMgZnVuY3Rpb24gam9iVmlldygpIHsKICBjb25zdCBqID0gYXdhaXQgYXBp' +
  'KCcvam9icy8nICsgUy5wYXJhbXMuaWQpOwogIGNvbnN0IGFkZHIgPSBhZGRyT2Yoaik7CiAgY29uc3QgZG9uZSA9IFsnU2VydmVk' +
  'JywgJ05vbi1Fc3QnLCAnQ2FuY2VsbGVkJ10uaW5jbHVkZXMoai5zdGF0dXMpOwoKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAog' +
  'ICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLWJvdHRvbTo4cHgiPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gZ2hv' +
  'c3QiIGlkPSJiYWNrIj7igLkgQmFjazwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJzcGFjZXIiIHN0eWxlPSJmbGV4OjEiPjwv' +
  'ZGl2PgogICAgICA8c3BhbiBjbGFzcz0icGlsbCAke2NscyhqLnN0YXR1cyl9Ij4ke2VzYyhqLnN0YXR1cyl9PC9zcGFuPgogICAg' +
  'ICAke2oucHJpb3JpdHkgIT09ICdSb3V0aW5lJyA/IGA8c3BhbiBjbGFzcz0icGlsbCBydXNoIj4ke2VzYyhqLnByaW9yaXR5KX08' +
  'L3NwYW4+YCA6ICcnfQogICAgPC9kaXY+CiAgICA8aDEgY2xhc3M9InBhZ2UiIHN0eWxlPSJtYXJnaW4tdG9wOjAiPiR7ZXNjKGou' +
  'cmVjaXBpZW50X25hbWUpfTwvaDE+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9Im0iIHN0eWxlPSJj' +
  'b2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEzcHg7bWFyZ2luLWJvdHRvbTo4cHgiPiR7ZXNjKGouam9iX251bWJlcil9IMK3' +
  'ICR7ZXNjKGouY2xpZW50X25hbWUgfHwgJ05vIGNsaWVudCcpfTwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJmb250LXNpemU6MTVw' +
  'eDtmb250LXdlaWdodDo2MDAiPiR7ZXNjKGFkZHIgfHwgJ05vIGFkZHJlc3Mgb24gZmlsZScpfTwvZGl2PgogICAgICAke2oucmVj' +
  'aXBpZW50X25vdGVzID8gYDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjZweCI+JHtlc2Moai5yZWNpcGllbnRf' +
  'bm90ZXMpfTwvZGl2PmAgOiAnJ30KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij4KICAgICAg' +
  'ICA8YnV0dG9uIGNsYXNzPSJidG4gbmF2IiBpZD0ibmF2QnRuIiAke2FkZHIgPyAnJyA6ICdkaXNhYmxlZCd9Pk5hdmlnYXRlIOKW' +
  'uDwvYnV0dG9uPgogICAgICAgICR7IWRvbmUgPyAnPGJ1dHRvbiBjbGFzcz0iYnRuIG9rIiBpZD0iYXR0QnRuIj5Mb2cgYXR0ZW1w' +
  'dDwvYnV0dG9uPicgOiAnJ30KICAgICAgPC9kaXY+CiAgICAgICR7YWRkciA/IGA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFy' +
  'Z2luLXRvcDo4cHgiPk9wZW5zICR7aXNJT1MoKSA/ICdBcHBsZSBNYXBzJyA6ICdHb29nbGUgTWFwcyd9IMK3CiAgICAgICAgPGEg' +
  'aHJlZj0iJHtpc0lPUygpID8gZ29vZ2xlVXJsKGFkZHIpIDogYXBwbGVVcmwoYWRkcil9IiB0YXJnZXQ9Il9ibGFuayI+dXNlICR7' +
  'aXNJT1MoKSA/ICdHb29nbGUnIDogJ0FwcGxlJ30gTWFwcyBpbnN0ZWFkPC9hPjwvZGl2PmAgOiAnJ30KICAgIDwvZGl2PgoKICAg' +
  'IDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+QXR0ZW1wdHMgPHNwYW4gY2xhc3M9InN1YiI+JHtqLmF0dGVtcHRzLmxlbmd0' +
  'aH08L3NwYW4+PC9oMj4KICAgICAgJHtqLmF0dGVtcHRzLmxlbmd0aCA/IGouYXR0ZW1wdHMubWFwKGEgPT4gYAogICAgICAgIDxk' +
  'aXYgY2xhc3M9ImF0dCAke2NscyhhLm91dGNvbWUpfSI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJoIj4ke2VzYyhhLm91dGNvbWUp' +
  'fSR7YS5tYW5uZXIgPyAnIOKAlCAnICsgZXNjKGEubWFubmVyKSA6ICcnfTwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0ibSI+' +
  'JHtmbXREVChhLmF0dGVtcHRlZF9hdCl9IMK3ICR7ZXNjKGEuc2VydmVyX25hbWUgfHwgJycpfTwvZGl2PgogICAgICAgICAgJHth' +
  'LnBlcnNvbl9zZXJ2ZWQgPyBgPGRpdiBjbGFzcz0ibSI+U2VydmVkOiAke2VzYyhhLnBlcnNvbl9zZXJ2ZWQpfSR7YS5yZWxhdGlv' +
  'bnNoaXAgPyAnICgnICsgZXNjKGEucmVsYXRpb25zaGlwKSArICcpJyA6ICcnfTwvZGl2PmAgOiAnJ30KICAgICAgICAgICR7YS5k' +
  'ZXNjcmlwdGlvbiA/IGA8ZGl2IGNsYXNzPSJtIj5EZXNjcmlwdGlvbjogJHtlc2MoYS5kZXNjcmlwdGlvbil9PC9kaXY+YCA6ICcn' +
  'fQogICAgICAgICAgJHthLm5vdGVzID8gYDxkaXYgY2xhc3M9Im0iPiR7ZXNjKGEubm90ZXMpfTwvZGl2PmAgOiAnJ30KICAgICAg' +
  'ICAgICR7YS5sYXQgIT0gbnVsbCA/IGA8ZGl2IGNsYXNzPSJtIj5HUFMgJHtOdW1iZXIoYS5sYXQpLnRvRml4ZWQoNSl9LCAke051' +
  'bWJlcihhLmxuZykudG9GaXhlZCg1KX0KICAgICAgICAgICAgJHthLmFjY3VyYWN5X20gPyAnwrEnICsgTWF0aC5yb3VuZChhLmFj' +
  'Y3VyYWN5X20pICsgJ20nIDogJyd9IMK3CiAgICAgICAgICAgIDxhIGhyZWY9Imh0dHBzOi8vd3d3Lmdvb2dsZS5jb20vbWFwcz9x' +
  'PSR7YS5sYXR9LCR7YS5sbmd9IiB0YXJnZXQ9Il9ibGFuayI+bWFwPC9hPjwvZGl2PmAgOiAnJ30KICAgICAgICAgICR7cGhvdG9T' +
  'dHJpcChhLCBqKX0KICAgICAgICA8L2Rpdj5gKS5qb2luKCcnKQogICAgICAgIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij5ObyBhdHRl' +
  'bXB0cyBsb2dnZWQgeWV0LjwvZGl2Pid9CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPlBhcGVy' +
  'd29yazwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InJvdyI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9ImFm' +
  'ZkJ0biI+QWZmaWRhdml0PC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9InJlcG9ydEJ0biI+' +
  'Q2xpZW50IHJlcG9ydDwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJjb3ZlckJ0biI+Q292' +
  'ZXIgc2hlZXQgKyBiYXJjb2RlPC9idXR0b24+CiAgICAgICAgJHtqLmNhc2VfbnVtYmVyID8gJzxidXR0b24gY2xhc3M9ImJ0biBz' +
  'ZWMgc20iIGlkPSJsb29rdXBCdG4iPkxvb2sgdXAgY2FzZTwvYnV0dG9uPicgOiAnJ30KICAgICAgPC9kaXY+CiAgICAgIDxkaXYg' +
  'c3R5bGU9InRleHQtYWxpZ246Y2VudGVyO21hcmdpbi10b3A6MTRweCI+CiAgICAgICAgPGltZyBzcmM9Ii9iYXJjb2RlLyR7ZW5j' +
  'b2RlVVJJQ29tcG9uZW50KGouam9iX251bWJlcil9LnN2ZyIgYWx0PSJiYXJjb2RlIiBzdHlsZT0ibWF4LXdpZHRoOjEwMCUiPgog' +
  'ICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+Q2FzZSBkZXRhaWw8L2gyPgog' +
  'ICAgICA8dGFibGUgY2xhc3M9InRibCI+CiAgICAgICAgJHtbWydDYXNlJywgai5jYXNlX251bWJlcl0sIFsnQ291cnQnLCBqLmNv' +
  'dXJ0XSwgWydQbGFpbnRpZmYnLCBqLnBsYWludGlmZl0sIFsnRGVmZW5kYW50Jywgai5kZWZlbmRhbnRdLAogICAgICAgICAgIFsn' +
  'RG9jdW1lbnRzJywgai5kb2N1bWVudHNdLCBbJ1NlcnZpY2UgdHlwZScsIGouc2VydmljZV90eXBlXSwgWydEdWUnLCBmbXREYXRl' +
  'T25seShqLmR1ZV9kYXRlKV0sCiAgICAgICAgICAgWydBc3NpZ25lZCB0bycsIGouc2VydmVyX25hbWVdLCBbJ0NsaWVudCBmZWUn' +
  'LCBqLmNsaWVudF9mZWUgPyBtb25leShqLmNsaWVudF9mZWUpIDogJyddLAogICAgICAgICAgIFsnU2VydmVyIHBheScsIGouc2Vy' +
  'dmVyX3BheSA/IG1vbmV5KGouc2VydmVyX3BheSkgOiAnJ10sCiAgICAgICAgICAgWydTZXJ2ZWQnLCBqLnNlcnZlZF9hdCA/IGZt' +
  'dERUKGouc2VydmVkX2F0KSArICcg4oCUICcgKyBlc2Moai5zZXJ2ZWRfbWFubmVyIHx8ICcnKSA6ICcnXSwKICAgICAgICAgICBb' +
  'J05vdGVzJywgai5ub3Rlc11dCiAgICAgICAgICAuZmlsdGVyKHIgPT4gclsxXSkubWFwKHIgPT4gYDx0cj48dGggc3R5bGU9Indp' +
  'ZHRoOjM0JSI+JHtyWzBdfTwvdGg+PHRkPiR7ZXNjKHJbMV0pfTwvdGQ+PC90cj5gKS5qb2luKCcnKX0KICAgICAgPC90YWJsZT4K' +
  'ICAgICAgJHtpc0FkbWluKCkgPyAnPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBibG9jayBzbSIgaWQ9ImVkaXRCdG4iIHN0eWxlPSJt' +
  'YXJnaW4tdG9wOjEycHgiPkVkaXQgam9iPC9idXR0b24+JyA6ICcnfQogICAgPC9kaXY+YCk7CiAgYmluZFNoZWxsKCk7CiAgJCgn' +
  'I2JhY2snKS5vbmNsaWNrID0gKCkgPT4gZ28oJ2pvYnMnLCBTLmNhY2hlLmpvYkZpbHRlciB8fCB7fSk7CiAgaWYgKCQoJyNuYXZC' +
  'dG4nKSkgJCgnI25hdkJ0bicpLm9uY2xpY2sgPSAoKSA9PiB3aW5kb3cub3BlbihuYXZVcmwoYWRkciksICdfYmxhbmsnKTsKICBp' +
  'ZiAoJCgnI2F0dEJ0bicpKSAkKCcjYXR0QnRuJykub25jbGljayA9ICgpID0+IGF0dGVtcHRGb3JtKGopOwogIGlmICgkKCcjZWRp' +
  'dEJ0bicpKSAkKCcjZWRpdEJ0bicpLm9uY2xpY2sgPSAoKSA9PiBqb2JGb3JtKGopOwogICQoJyNjb3ZlckJ0bicpLm9uY2xpY2sg' +
  'PSAoKSA9PiB3aW5kb3cub3BlbignL3ByaW50L2NvdmVyc2hlZXQvJyArIGouaWQsICdfYmxhbmsnKTsKICAkKCcjYWZmQnRuJyku' +
  'b25jbGljayA9ICgpID0+IGFmZmlkYXZpdFNoZWV0KGopOwogICQoJyNyZXBvcnRCdG4nKS5vbmNsaWNrID0gKCkgPT4gd2luZG93' +
  'Lm9wZW4oJy9wcmludC9yZXBvcnQvJyArIGouaWQsICdfYmxhbmsnKTsKICBpZiAoJCgnI2xvb2t1cEJ0bicpKSAkKCcjbG9va3Vw' +
  'QnRuJykub25jbGljayA9ICgpID0+IGNhc2VMb29rdXBTaGVldChqKTsKICBiaW5kUGhvdG9TdHJpcHMoaik7Cn0KCi8qIC0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIHBob3RvcyAtLSAqLwovKiBBIHBo' +
  'b25lIGNhbWVyYSBtYWtlcyBhIDRNQiwgNDAwMHB4IHBpY3R1cmUuIE5vYm9keSBuZWVkcyB0aGF0IHRvIHByb3ZlIGEKICogZG9v' +
  'ciB3YXMga25vY2tlZCBvbiwgYW5kIHNlbmRpbmcgaXQgb3ZlciBhIHBhcmtpbmctbG90IHNpZ25hbCBpcyBob3cgYQogKiBzZXJ2' +
  'ZXIgZ2l2ZXMgdXAgYW5kIHN0b3BzIHRha2luZyBwaG90b3MgYXQgYWxsLiBTbyBldmVyeSBzaG90IGlzIGRyYXduCiAqIGludG8g' +
  'YSBjYW52YXMgYXQgMTYwMHB4IG9uIGl0cyBsb25nIHNpZGUgYW5kIHJlLWVuY29kZWQgYXMgSlBFRyBiZWZvcmUgaXQKICogbGVh' +
  'dmVzIHRoZSBwaG9uZSDigJQgYWJvdXQgMjUwS0IsIHN0aWxsIHNoYXJwIGVub3VnaCB0byByZWFkIGEgaG91c2UgbnVtYmVyLiAq' +
  'Lwpjb25zdCBQSE9UT19NQVhfRURHRSA9IDE2MDA7CmNvbnN0IFBIT1RPX1FVQUxJVFkgPSAwLjcyOwoKZnVuY3Rpb24gc2hyaW5r' +
  'UGhvdG8oZmlsZSkgewogIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7CiAgICBjb25zdCBpbWcgPSBu' +
  'ZXcgSW1hZ2UoKTsKICAgIGNvbnN0IHVybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwoZmlsZSk7CiAgICBpbWcub25sb2FkID0gKCkg' +
  'PT4gewogICAgICBVUkwucmV2b2tlT2JqZWN0VVJMKHVybCk7CiAgICAgIGNvbnN0IHNjYWxlID0gTWF0aC5taW4oMSwgUEhPVE9f' +
  'TUFYX0VER0UgLyBNYXRoLm1heChpbWcud2lkdGgsIGltZy5oZWlnaHQpKTsKICAgICAgY29uc3QgdyA9IE1hdGgucm91bmQoaW1n' +
  'LndpZHRoICogc2NhbGUpLCBoID0gTWF0aC5yb3VuZChpbWcuaGVpZ2h0ICogc2NhbGUpOwogICAgICBjb25zdCBjID0gZG9jdW1l' +
  'bnQuY3JlYXRlRWxlbWVudCgnY2FudmFzJyk7CiAgICAgIGMud2lkdGggPSB3OyBjLmhlaWdodCA9IGg7CiAgICAgIGMuZ2V0Q29u' +
  'dGV4dCgnMmQnKS5kcmF3SW1hZ2UoaW1nLCAwLCAwLCB3LCBoKTsKICAgICAgY29uc3QgZGF0YSA9IGMudG9EYXRhVVJMKCdpbWFn' +
  'ZS9qcGVnJywgUEhPVE9fUVVBTElUWSkuc3BsaXQoJywnKVsxXTsKICAgICAgaWYgKCFkYXRhKSByZXR1cm4gcmVqZWN0KG5ldyBF' +
  'cnJvcignVGhpcyBwaG9uZSBjb3VsZCBub3QgcHJvY2VzcyB0aGF0IHBob3RvJykpOwogICAgICByZXNvbHZlKHsgZGF0YSwgbWlt' +
  'ZTogJ2ltYWdlL2pwZWcnLCB3aWR0aDogdywgaGVpZ2h0OiBoIH0pOwogICAgfTsKICAgIGltZy5vbmVycm9yID0gKCkgPT4geyBV' +
  'UkwucmV2b2tlT2JqZWN0VVJMKHVybCk7IHJlamVjdChuZXcgRXJyb3IoJ1RoYXQgZmlsZSBpcyBub3QgYSBwaG90bycpKTsgfTsK' +
  'ICAgIGltZy5zcmMgPSB1cmw7CiAgfSk7Cn0KCi8vIFVwbG9hZHMgb25lIGF0IGEgdGltZTogYSBzZXJ2ZXIgb24gYSB3ZWFrIHNp' +
  'Z25hbCBnZXRzIHBhcnRpYWwgc3VjY2VzcyByYXRoZXIKLy8gdGhhbiBvbmUgZ2lhbnQgcmVxdWVzdCB0aGF0IGZhaWxzIHdob2xl' +
  'Lgphc3luYyBmdW5jdGlvbiB1cGxvYWRQaG90b3MoYXR0ZW1wdElkLCBmaWxlcywgb25Qcm9ncmVzcykgewogIGNvbnN0IGRvbmUg' +
  'PSBbXTsKICBmb3IgKGxldCBpID0gMDsgaSA8IGZpbGVzLmxlbmd0aDsgaSsrKSB7CiAgICBpZiAob25Qcm9ncmVzcykgb25Qcm9n' +
  'cmVzcyhpICsgMSwgZmlsZXMubGVuZ3RoKTsKICAgIGNvbnN0IHNob3QgPSBhd2FpdCBzaHJpbmtQaG90byhmaWxlc1tpXSk7CiAg' +
  'ICBkb25lLnB1c2goYXdhaXQgYXBpKCcvYXR0ZW1wdHMvJyArIGF0dGVtcHRJZCArICcvcGhvdG9zJywgewogICAgICBtZXRob2Q6' +
  'ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoc2hvdCkKICAgIH0pKTsKICB9CiAgcmV0dXJuIGRvbmU7Cn0KCmZ1bmN0aW9u' +
  'IHBob3RvU3RyaXAoYSwgam9iKSB7CiAgY29uc3QgY2FuRWRpdCA9ICFqb2IucGhvdG9zX2hpZGRlbiAmJiAoaXNBZG1pbigpIHx8' +
  'IGpvYi5hc3NpZ25lZF90byA9PT0gUy5tZS5pZCk7CiAgaWYgKGpvYi5waG90b3NfaGlkZGVuKSB7CiAgICByZXR1cm4gYS5waG90' +
  'b19jb3VudAogICAgICA/IGA8ZGl2IGNsYXNzPSJtIHBob3RvLWhpZGRlbiI+JHthLnBob3RvX2NvdW50fSBwaG90byR7YS5waG90' +
  'b19jb3VudCA+IDEgPyAncycgOiAnJ30g4oCUIGhpZGRlbiBpbiBzdXBwb3J0IHZpZXc8L2Rpdj5gCiAgICAgIDogJyc7CiAgfQog' +
  'IGNvbnN0IHRodW1icyA9IChhLnBob3RvcyB8fCBbXSkubWFwKHAgPT4KICAgIGA8YnV0dG9uIGNsYXNzPSJ0aHVtYiIgZGF0YS1w' +
  'aG90bz0iJHtwLmlkfSIgdGl0bGU9IiR7ZXNjKHAuY2FwdGlvbiB8fCAnJyl9Ij4KICAgICAgIDxpbWcgc3JjPSIvcGhvdG8vJHtw' +
  'LmlkfSIgYWx0PSIke2VzYyhwLmNhcHRpb24gfHwgJ0F0dGVtcHQgcGhvdG8nKX0iIGxvYWRpbmc9ImxhenkiPgogICAgICAgJHtw' +
  'LmNhcHRpb24gPyBgPHNwYW4gY2xhc3M9ImNhcCI+JHtlc2MocC5jYXB0aW9uKX08L3NwYW4+YCA6ICcnfQogICAgIDwvYnV0dG9u' +
  'PmApLmpvaW4oJycpOwogIHJldHVybiBgPGRpdiBjbGFzcz0icGhvdG9zIiBkYXRhLWF0dGVtcHQ9IiR7YS5pZH0iPgogICAgJHt0' +
  'aHVtYnN9CiAgICAke2NhbkVkaXQgPyBgPGJ1dHRvbiBjbGFzcz0idGh1bWIgYWRkIiBkYXRhLWFkZD0iJHthLmlkfSI+77yLPHNw' +
  'YW4+UGhvdG88L3NwYW4+PC9idXR0b24+YCA6ICcnfQogIDwvZGl2PmA7Cn0KCmZ1bmN0aW9uIGJpbmRQaG90b1N0cmlwcyhqb2Ip' +
  'IHsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1waG90b10nKS5mb3JFYWNoKGIgPT4gewogICAgYi5vbmNsaWNr' +
  'ID0gKCkgPT4gcGhvdG9WaWV3ZXIoam9iLCBOdW1iZXIoYi5kYXRhc2V0LnBob3RvKSk7CiAgfSk7CiAgZG9jdW1lbnQucXVlcnlT' +
  'ZWxlY3RvckFsbCgnW2RhdGEtYWRkXScpLmZvckVhY2goYiA9PiB7CiAgICBiLm9uY2xpY2sgPSAoKSA9PiBwaWNrUGhvdG9zKGFz' +
  'eW5jIGZpbGVzID0+IHsKICAgICAgY29uc3QgbGFiZWwgPSBiLnF1ZXJ5U2VsZWN0b3IoJ3NwYW4nKTsKICAgICAgY29uc3Qgd2Fz' +
  'ID0gbGFiZWwudGV4dENvbnRlbnQ7CiAgICAgIGIuZGlzYWJsZWQgPSB0cnVlOwogICAgICB0cnkgewogICAgICAgIGF3YWl0IHVw' +
  'bG9hZFBob3RvcyhOdW1iZXIoYi5kYXRhc2V0LmFkZCksIGZpbGVzLAogICAgICAgICAgKG4sIHRvdGFsKSA9PiB7IGxhYmVsLnRl' +
  'eHRDb250ZW50ID0gbiArICcvJyArIHRvdGFsOyB9KTsKICAgICAgICB0b2FzdChmaWxlcy5sZW5ndGggPiAxID8gZmlsZXMubGVu' +
  'Z3RoICsgJyBwaG90b3MgYWRkZWQnIDogJ1Bob3RvIGFkZGVkJyk7CiAgICAgICAgZ28oJ2pvYicsIHsgaWQ6IGpvYi5pZCB9KTsK' +
  'ICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgIGIuZGlzYWJsZWQgPSBmYWxzZTsgbGFiZWwudGV4dENvbnRlbnQgPSB3YXM7CiAg' +
  'ICAgICAgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsKICAgICAgfQogICAgfSk7CiAgfSk7Cn0KCi8vIE9uZSBoaWRkZW4gaW5wdXQs' +
  'IHJldXNlZC4gY2FwdHVyZT0iZW52aXJvbm1lbnQiIG9wZW5zIHRoZSByZWFyIGNhbWVyYQovLyBzdHJhaWdodCBhd2F5IG9uIGEg' +
  'cGhvbmU7IG9uIGEgZGVza3RvcCBpdCBpcyBhbiBvcmRpbmFyeSBmaWxlIHBpY2tlci4KZnVuY3Rpb24gcGlja1Bob3RvcyhvblBp' +
  'Y2tlZCkgewogIGNvbnN0IGlucCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7CiAgaW5wLnR5cGUgPSAnZmlsZSc7' +
  'CiAgaW5wLmFjY2VwdCA9ICdpbWFnZS8qJzsKICBpbnAubXVsdGlwbGUgPSB0cnVlOwogIGlucC5zZXRBdHRyaWJ1dGUoJ2NhcHR1' +
  'cmUnLCAnZW52aXJvbm1lbnQnKTsKICBpbnAuc3R5bGUuZGlzcGxheSA9ICdub25lJzsKICBkb2N1bWVudC5ib2R5LmFwcGVuZENo' +
  'aWxkKGlucCk7CiAgaW5wLm9uY2hhbmdlID0gKCkgPT4gewogICAgY29uc3QgZmlsZXMgPSBBcnJheS5mcm9tKGlucC5maWxlcyB8' +
  'fCBbXSk7CiAgICBpbnAucmVtb3ZlKCk7CiAgICBpZiAoZmlsZXMubGVuZ3RoKSBvblBpY2tlZChmaWxlcyk7CiAgfTsKICBpbnAu' +
  'Y2xpY2soKTsKfQoKZnVuY3Rpb24gcGhvdG9WaWV3ZXIoam9iLCBpZCkgewogIGNvbnN0IGFsbCA9IGpvYi5hdHRlbXB0cy5mbGF0' +
  'TWFwKGEgPT4gYS5waG90b3MgfHwgW10pOwogIGNvbnN0IHAgPSBhbGwuZmluZCh4ID0+IHguaWQgPT09IGlkKTsKICBpZiAoIXAp' +
  'IHJldHVybjsKICBjb25zdCBjYW5FZGl0ID0gaXNBZG1pbigpIHx8IGpvYi5hc3NpZ25lZF90byA9PT0gUy5tZS5pZDsKICBzaGVl' +
  'dCgnUGhvdG8nLCBgCiAgICA8aW1nIHNyYz0iL3Bob3RvLyR7cC5pZH0iIGFsdD0iIiBzdHlsZT0id2lkdGg6MTAwJTtib3JkZXIt' +
  'cmFkaXVzOjEycHg7ZGlzcGxheTpibG9jayI+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+' +
  'PGxhYmVsPkNhcHRpb248L2xhYmVsPgogICAgICA8aW5wdXQgaWQ9InBfY2FwIiB2YWx1ZT0iJHtlc2MocC5jYXB0aW9uIHx8ICcn' +
  'KX0iIHBsYWNlaG9sZGVyPSJGcm9udCBkb29yLCBubyBhbnN3ZXIiCiAgICAgICAgJHtjYW5FZGl0ID8gJycgOiAnZGlzYWJsZWQn' +
  'fT48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImhpbnQiPiR7TWF0aC5yb3VuZChwLmJ5dGVzIC8gMTAyNCl9IEtCIMK3IGFkZGVkICR7' +
  'Zm10RFQocC5jcmVhdGVkX2F0KX08L2Rpdj4KICAgICR7Y2FuRWRpdCA/IGA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4t' +
  'dG9wOjEycHgiPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJwX3NhdmUiPlNhdmUgY2FwdGlvbjwvYnV0dG9uPgogICAg' +
  'ICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBpZD0icF9kZWwiPkRlbGV0ZSBwaG90bzwvYnV0dG9uPgogICAgPC9kaXY+YCA6ICcn' +
  'fWAsIGVsID0+IHsKICAgIGlmICghY2FuRWRpdCkgcmV0dXJuOwogICAgZWwucXVlcnlTZWxlY3RvcignI3Bfc2F2ZScpLm9uY2xp' +
  'Y2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgYXBpKCcvcGhvdG9zLycgKyBwLmlkLCB7CiAgICAg' +
  'ICAgICBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FwdGlvbjogZWwucXVlcnlTZWxlY3RvcignI3Bf' +
  'Y2FwJykudmFsdWUgfSkKICAgICAgICB9KTsKICAgICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KCdDYXB0aW9uIHNhdmVkJyk7IGdv' +
  'KCdqb2InLCB7IGlkOiBqb2IuaWQgfSk7CiAgICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogICAg' +
  'fTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNwX2RlbCcpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGlmICghY29uZmly' +
  'bSgnRGVsZXRlIHRoaXMgcGhvdG8/IEl0IGlzIHBhcnQgb2YgdGhlIHJlY29yZCBmb3IgdGhpcyBhdHRlbXB0LicpKSByZXR1cm47' +
  'CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgYXBpKCcvcGhvdG9zLycgKyBwLmlkLCB7IG1ldGhvZDogJ0RFTEVURScgfSk7CiAg' +
  'ICAgICAgY2xvc2VTaGVldCgpOyB0b2FzdCgnUGhvdG8gZGVsZXRlZCcpOyBnbygnam9iJywgeyBpZDogam9iLmlkIH0pOwogICAg' +
  'ICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICAgIH07CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gbG9nIGF0dGVtcHQgLS0gKi8KY29uc3QgT1VUQ09NRVMg' +
  'PSBbJ1NlcnZlZCcsICdObyBBbnN3ZXInLCAnQmFkIEFkZHJlc3MnLCAnTW92ZWQnLCAnUmVmdXNlZCcsICdFdmFkaW5nJywgJ090' +
  'aGVyJ107CgpmdW5jdGlvbiBhdHRlbXB0Rm9ybShqb2IpIHsKICBzaGVldCgnTG9nIGF0dGVtcHQg4oCUICcgKyBqb2IucmVjaXBp' +
  'ZW50X25hbWUsIGAKICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+T3V0Y29tZTwvbGFiZWw+CiAgICAgIDxkaXYgY2xhc3M9' +
  'InJvdyIgaWQ9Im91dGNvbWVzIj4ke09VVENPTUVTLm1hcChvID0+CiAgICAgICAgYDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20i' +
  'IGRhdGEtbz0iJHtvfSI+JHtvfTwvYnV0dG9uPmApLmpvaW4oJycpfTwvZGl2PjwvZGl2PgogICAgPGRpdiBpZD0ic2VydmVkRmll' +
  'bGRzIiBzdHlsZT0iZGlzcGxheTpub25lIj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgICAgPGRpdiBjbGFzcz0i' +
  'ZmllbGQiPjxsYWJlbD5NYW5uZXI8L2xhYmVsPjxzZWxlY3QgaWQ9ImFfbWFubmVyIj4KICAgICAgICAgICR7WydQZXJzb25hbCcs' +
  'ICdTdWJzdGl0dXRlJywgJ1Bvc3RlZCcsICdDb3Jwb3JhdGUnLCAnQ2VydGlmaWVkIE1haWwnXS5tYXAocyA9PiBgPG9wdGlvbj4k' +
  'e3N9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Q' +
  'ZXJzb24gc2VydmVkPC9sYWJlbD48aW5wdXQgaWQ9ImFfcGVyc29uX3NlcnZlZCIgdmFsdWU9IiR7ZXNjKGpvYi5yZWNpcGllbnRf' +
  'bmFtZSl9Ij48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICAgIDxkaXYgY2xhc3M9' +
  'ImZpZWxkIj48bGFiZWw+UmVsYXRpb25zaGlwIChpZiBzdWJzdGl0dXRlKTwvbGFiZWw+PGlucHV0IGlkPSJhX3JlbGF0aW9uc2hp' +
  'cCIgcGxhY2Vob2xkZXI9ImNvLXJlc2lkZW50LCBjby13b3JrZXIuLi4iPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxk' +
  'Ij48bGFiZWw+RGVzY3JpcHRpb248L2xhYmVsPjxpbnB1dCBpZD0iYV9kZXNjcmlwdGlvbiIgcGxhY2Vob2xkZXI9IlcvRiwgNDBz' +
  'LCA1JzYmcXVvdDssIGJyb3duIGhhaXIiPjwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmll' +
  'bGQiPjxsYWJlbD5Ob3RlczwvbGFiZWw+PHRleHRhcmVhIGlkPSJhX25vdGVzIiBwbGFjZWhvbGRlcj0iTGlnaHRzIG9uLCBubyBh' +
  'bnN3ZXIgYXQgZnJvbnQgZG9vci4gU2lsdmVyIENpdmljIGluIGRyaXZld2F5LiI+PC90ZXh0YXJlYT48L2Rpdj4KICAgIDxkaXYg' +
  'Y2xhc3M9ImZpZWxkIj48bGFiZWw+V2hlbjwvbGFiZWw+PGlucHV0IGlkPSJhX3doZW4iIHR5cGU9ImRhdGV0aW1lLWxvY2FsIiB2' +
  'YWx1ZT0iJHtsb2NhbE5vdygpfSI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3VuZDojZjhmYWZj' +
  'O2JveC1zaGFkb3c6bm9uZTttYXJnaW4tYm90dG9tOjEycHgiPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciPjxidXR0b24gY2xhc3M9' +
  'ImJ0biBzZWMgc20iIGlkPSJncHNCdG4iPkNhcHR1cmUgR1BTPC9idXR0b24+CiAgICAgIDxzcGFuIGNsYXNzPSJoaW50IiBpZD0i' +
  'Z3BzT3V0IiBzdHlsZT0ibWFyZ2luOjAiPk5vdCBjYXB0dXJlZDwvc3Bhbj48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFz' +
  'cz0iZmllbGQiPjxsYWJlbD5QaG90b3M8L2xhYmVsPgogICAgICA8ZGl2IGNsYXNzPSJwaG90b3MiIGlkPSJwZW5kUGhvdG9zIj4K' +
  'ICAgICAgICA8YnV0dG9uIGNsYXNzPSJ0aHVtYiBhZGQiIGlkPSJwaG90b0J0biIgdHlwZT0iYnV0dG9uIj7vvIs8c3Bhbj5QaG90' +
  'bzwvc3Bhbj48L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPlRoZSBkb29yLCB0aGUgbnVtYmVy' +
  'LCB0aGUgbm90aWNlLCB0aGUgY2FyLiBUaGV5IGdvIG9uIHRoZSBhdHRlbXB0CiAgICAgIGFuZCBvbiB0aGUgcmVwb3J0IHlvdXIg' +
  'Y2xpZW50IHNlZXMuPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InJvdyI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0' +
  'biIgaWQ9InNhdmVBdHQiIGRpc2FibGVkPlBpY2sgYW4gb3V0Y29tZTwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4g' +
  'c2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNhbmNlbDwvYnV0dG9uPgogICAgPC9kaXY+YCwgZWwgPT4gewogICAgbGV0IG91' +
  'dGNvbWUgPSBudWxsLCBncHMgPSBudWxsOwogICAgLyogUGhvdG9zIGFyZSBwaWNrZWQgYmVmb3JlIHRoZSBhdHRlbXB0IGV4aXN0' +
  'cywgc28gdGhleSBhcmUgaGVsZCBoZXJlIGFuZAogICAgICAgdXBsb2FkZWQgb25jZSBzYXZpbmcgZ2l2ZXMgdXMgYW4gYXR0ZW1w' +
  'dCBpZC4gKi8KICAgIGNvbnN0IHBlbmRpbmcgPSBbXTsKICAgIGNvbnN0IHN0cmlwID0gZWwucXVlcnlTZWxlY3RvcignI3BlbmRQ' +
  'aG90b3MnKTsKICAgIGNvbnN0IGFkZEJ0biA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNwaG90b0J0bicpOwogICAgY29uc3QgZHJhd1Bl' +
  'bmRpbmcgPSAoKSA9PiB7CiAgICAgIHN0cmlwLnF1ZXJ5U2VsZWN0b3JBbGwoJy5wZW5kJykuZm9yRWFjaChuID0+IG4ucmVtb3Zl' +
  'KCkpOwogICAgICBwZW5kaW5nLmZvckVhY2goKGYsIGkpID0+IHsKICAgICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxl' +
  'bWVudCgnYnV0dG9uJyk7CiAgICAgICAgYi50eXBlID0gJ2J1dHRvbic7CiAgICAgICAgYi5jbGFzc05hbWUgPSAndGh1bWIgcGVu' +
  'ZCc7CiAgICAgICAgYi50aXRsZSA9ICdSZW1vdmUnOwogICAgICAgIGIuaW5uZXJIVE1MID0gYDxpbWcgc3JjPSIke1VSTC5jcmVh' +
  'dGVPYmplY3RVUkwoZil9IiBhbHQ9IiI+PHNwYW4gY2xhc3M9IngiPsOXPC9zcGFuPmA7CiAgICAgICAgYi5vbmNsaWNrID0gKCkg' +
  'PT4geyBwZW5kaW5nLnNwbGljZShpLCAxKTsgZHJhd1BlbmRpbmcoKTsgfTsKICAgICAgICBzdHJpcC5pbnNlcnRCZWZvcmUoYiwg' +
  'YWRkQnRuKTsKICAgICAgfSk7CiAgICAgIGFkZEJ0bi5xdWVyeVNlbGVjdG9yKCdzcGFuJykudGV4dENvbnRlbnQgPSBwZW5kaW5n' +
  'Lmxlbmd0aCA/IGBQaG90byAoJHtwZW5kaW5nLmxlbmd0aH0pYCA6ICdQaG90byc7CiAgICB9OwogICAgYWRkQnRuLm9uY2xpY2sg' +
  'PSAoKSA9PiBwaWNrUGhvdG9zKGZpbGVzID0+IHsgcGVuZGluZy5wdXNoKC4uLmZpbGVzKTsgZHJhd1BlbmRpbmcoKTsgfSk7CiAg' +
  'ICBlbC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1vXScpLmZvckVhY2goYiA9PiBiLm9uY2xpY2sgPSAoKSA9PiB7CiAgICAgIG91' +
  'dGNvbWUgPSBiLmRhdGFzZXQubzsKICAgICAgZWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtb10nKS5mb3JFYWNoKHggPT4geyB4' +
  'LmNsYXNzTmFtZSA9ICdidG4gc2VjIHNtJzsgfSk7CiAgICAgIGIuY2xhc3NOYW1lID0gJ2J0biBzbScgKyAob3V0Y29tZSA9PT0g' +
  'J1NlcnZlZCcgPyAnIG9rJyA6ICcnKTsKICAgICAgZWwucXVlcnlTZWxlY3RvcignI3NlcnZlZEZpZWxkcycpLnN0eWxlLmRpc3Bs' +
  'YXkgPSBvdXRjb21lID09PSAnU2VydmVkJyA/ICcnIDogJ25vbmUnOwogICAgICBjb25zdCBzID0gZWwucXVlcnlTZWxlY3Rvcign' +
  'I3NhdmVBdHQnKTsKICAgICAgcy5kaXNhYmxlZCA9IGZhbHNlOwogICAgICBzLnRleHRDb250ZW50ID0gb3V0Y29tZSA9PT0gJ1Nl' +
  'cnZlZCcgPyAnU2F2ZSDigJQgbWFya3Mgam9iIFNFUlZFRCcgOiAnU2F2ZSBhdHRlbXB0JzsKICAgIH0pOwogICAgZWwucXVlcnlT' +
  'ZWxlY3RvcignI2dwc0J0bicpLm9uY2xpY2sgPSAoKSA9PiB7CiAgICAgIGNvbnN0IG91dCA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNn' +
  'cHNPdXQnKTsKICAgICAgaWYgKCFuYXZpZ2F0b3IuZ2VvbG9jYXRpb24pIHJldHVybiBvdXQudGV4dENvbnRlbnQgPSAnTm90IHN1' +
  'cHBvcnRlZCBvbiB0aGlzIGRldmljZSc7CiAgICAgIG91dC50ZXh0Q29udGVudCA9ICdMb2NhdGluZ+KApic7CiAgICAgIG5hdmln' +
  'YXRvci5nZW9sb2NhdGlvbi5nZXRDdXJyZW50UG9zaXRpb24ocG9zID0+IHsKICAgICAgICBncHMgPSB7IGxhdDogcG9zLmNvb3Jk' +
  'cy5sYXRpdHVkZSwgbG5nOiBwb3MuY29vcmRzLmxvbmdpdHVkZSwgYWNjdXJhY3lfbTogcG9zLmNvb3Jkcy5hY2N1cmFjeSB9Owog' +
  'ICAgICAgIG91dC5pbm5lckhUTUwgPSBgPGIgc3R5bGU9ImNvbG9yOnZhcigtLW9rKSI+4pyTICR7Z3BzLmxhdC50b0ZpeGVkKDUp' +
  'fSwgJHtncHMubG5nLnRvRml4ZWQoNSl9PC9iPiDCsSR7TWF0aC5yb3VuZChncHMuYWNjdXJhY3lfbSl9bWA7CiAgICAgIH0sIGVy' +
  'ciA9PiB7IG91dC50ZXh0Q29udGVudCA9ICdGYWlsZWQ6ICcgKyBlcnIubWVzc2FnZTsgfSwKICAgICAgICB7IGVuYWJsZUhpZ2hB' +
  'Y2N1cmFjeTogdHJ1ZSwgdGltZW91dDogMTUwMDAsIG1heGltdW1BZ2U6IDAgfSk7CiAgICB9OwogICAgLy8gYXV0by1jYXB0dXJl' +
  'IG9uIG9wZW4g4oCUIHRoZSBhZmZpZGF2aXQgaXMgc3Ryb25nZXIgd2hlbiBldmVyeSBhdHRlbXB0IGhhcyBjb29yZGluYXRlcwog' +
  'ICAgZWwucXVlcnlTZWxlY3RvcignI2dwc0J0bicpLmNsaWNrKCk7CgogICAgZWwucXVlcnlTZWxlY3RvcignI3NhdmVBdHQnKS5v' +
  'bmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBib2R5ID0gT2JqZWN0LmFzc2lnbih7CiAgICAgICAgb3V0Y29tZSwK' +
  'ICAgICAgICBhdHRlbXB0ZWRfYXQ6IGVsLnF1ZXJ5U2VsZWN0b3IoJyNhX3doZW4nKS52YWx1ZSB8fCBudWxsLAogICAgICAgIG5v' +
  'dGVzOiBlbC5xdWVyeVNlbGVjdG9yKCcjYV9ub3RlcycpLnZhbHVlCiAgICAgIH0sIGdwcyB8fCB7fSk7CiAgICAgIGlmIChvdXRj' +
  'b21lID09PSAnU2VydmVkJykgewogICAgICAgIGJvZHkubWFubmVyID0gZWwucXVlcnlTZWxlY3RvcignI2FfbWFubmVyJykudmFs' +
  'dWU7CiAgICAgICAgYm9keS5wZXJzb25fc2VydmVkID0gZWwucXVlcnlTZWxlY3RvcignI2FfcGVyc29uX3NlcnZlZCcpLnZhbHVl' +
  'OwogICAgICAgIGJvZHkucmVsYXRpb25zaGlwID0gZWwucXVlcnlTZWxlY3RvcignI2FfcmVsYXRpb25zaGlwJykudmFsdWU7CiAg' +
  'ICAgICAgYm9keS5kZXNjcmlwdGlvbiA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNhX2Rlc2NyaXB0aW9uJykudmFsdWU7CiAgICAgIH0K' +
  'ICAgICAgY29uc3Qgc2F2ZSA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNzYXZlQXR0Jyk7CiAgICAgIGNvbnN0IHdhcyA9IHNhdmUudGV4' +
  'dENvbnRlbnQ7CiAgICAgIHNhdmUuZGlzYWJsZWQgPSB0cnVlOwogICAgICB0cnkgewogICAgICAgIGNvbnN0IGF0dCA9IGF3YWl0' +
  'IGFwaSgnL2pvYnMvJyArIGpvYi5pZCArICcvYXR0ZW1wdHMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lm' +
  'eShib2R5KSB9KTsKICAgICAgICAvKiBUaGUgYXR0ZW1wdCBpcyBzYXZlZCBhdCB0aGlzIHBvaW50LiBJZiBhIHBob3RvIGZhaWxz' +
  'IHRvIHVwbG9hZCBhZnRlcgogICAgICAgICAgIHRoYXQg4oCUIGRlYWQgc2lnbmFsIGluIGEgZHJpdmV3YXkg4oCUIHRoZSBhdHRl' +
  'bXB0IHN0aWxsIHN0YW5kcyBhbmQgdGhlCiAgICAgICAgICAgc2VydmVyIGlzIHRvbGQgd2hpY2ggb25lcyB0byByZXRyeSBmcm9t' +
  'IHRoZSBqb2Igc2NyZWVuLCByYXRoZXIgdGhhbgogICAgICAgICAgIGxvc2luZyB0aGUgd2hvbGUgZW50cnkuICovCiAgICAgICAg' +
  'bGV0IGZhaWxlZCA9IDA7CiAgICAgICAgaWYgKHBlbmRpbmcubGVuZ3RoKSB7CiAgICAgICAgICB0cnkgewogICAgICAgICAgICBh' +
  'd2FpdCB1cGxvYWRQaG90b3MoYXR0LmlkLCBwZW5kaW5nLAogICAgICAgICAgICAgIChuLCB0b3RhbCkgPT4geyBzYXZlLnRleHRD' +
  'b250ZW50ID0gYFNlbmRpbmcgcGhvdG8gJHtufSBvZiAke3RvdGFsfeKApmA7IH0pOwogICAgICAgICAgfSBjYXRjaCAoZSkgeyBm' +
  'YWlsZWQgPSAxOyB9CiAgICAgICAgfQogICAgICAgIGNsb3NlU2hlZXQoKTsKICAgICAgICB0b2FzdChmYWlsZWQgPyAnQXR0ZW1w' +
  'dCBzYXZlZCDigJQgYSBwaG90byBkaWQgbm90IHNlbmQsIGFkZCBpdCBhZ2FpbiBmcm9tIHRoZSBqb2InCiAgICAgICAgICA6IG91' +
  'dGNvbWUgPT09ICdTZXJ2ZWQnID8gJ1NlcnZlZCDigJQgam9iIGNsb3NlZCBvdXQnIDogJ0F0dGVtcHQgbG9nZ2VkJywgISFmYWls' +
  'ZWQpOwogICAgICAgIGdvKCdqb2InLCB7IGlkOiBqb2IuaWQgfSk7CiAgICAgIH0gY2F0Y2ggKGUpIHsgc2F2ZS5kaXNhYmxlZCA9' +
  'IGZhbHNlOyBzYXZlLnRleHRDb250ZW50ID0gd2FzOyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgICB9OwogIH0pOwp9Cgpm' +
  'dW5jdGlvbiBsb2NhbE5vdygpIHsKICBjb25zdCBkID0gbmV3IERhdGUoRGF0ZS5ub3coKSAtIG5ldyBEYXRlKCkuZ2V0VGltZXpv' +
  'bmVPZmZzZXQoKSAqIDYwMDAwKTsKICByZXR1cm4gZC50b0lTT1N0cmluZygpLnNsaWNlKDAsIDE2KTsKfQoKLyogLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBhZmZpZGF2aXQgLS0gKi8KYXN5bmMgZnVu' +
  'Y3Rpb24gYWZmaWRhdml0U2hlZXQoam9iKSB7CiAgY29uc3QgdGVtcGxhdGVzID0gYXdhaXQgYXBpKCcvdGVtcGxhdGVzJyk7CiAg' +
  'Y29uc3QgbG9hZCA9IGFzeW5jIGlkID0+IHsKICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9qb2JzLycgKyBqb2IuaWQgKyAnL2Fm' +
  'ZmlkYXZpdCcgKyAoaWQgPyAnP3RlbXBsYXRlX2lkPScgKyBpZCA6ICcnKSk7CiAgICByZXR1cm4gcjsKICB9OwogIGNvbnN0IGZp' +
  'cnN0ID0gYXdhaXQgbG9hZCgpOwogIHNoZWV0KCdBZmZpZGF2aXQg4oCUICcgKyBqb2Iuam9iX251bWJlciwgYAogICAgPGRpdiBj' +
  'bGFzcz0iZmllbGQiPjxsYWJlbD5UZW1wbGF0ZTwvbGFiZWw+PHNlbGVjdCBpZD0idHBsIj4KICAgICAgJHt0ZW1wbGF0ZXMubWFw' +
  'KHQgPT4gYDxvcHRpb24gdmFsdWU9IiR7dC5pZH0iICR7dC5pZCA9PT0gZmlyc3QudGVtcGxhdGVfaWQgPyAnc2VsZWN0ZWQnIDog' +
  'Jyd9PiR7ZXNjKHQubmFtZSl9JHt0Lmp1cmlzZGljdGlvbiA/ICcg4oCUICcgKyBlc2ModC5qdXJpc2RpY3Rpb24pIDogJyd9PC9v' +
  'cHRpb24+YCkuam9pbignJyl9CiAgICA8L3NlbGVjdD48L2Rpdj4KICAgIDxwcmUgY2xhc3M9InByZXYiIGlkPSJwcmV2Ij4ke2Vz' +
  'YyhmaXJzdC50ZXh0KX08L3ByZT4KICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+CiAgICAgIDxi' +
  'dXR0b24gY2xhc3M9ImJ0biIgaWQ9InByaW50QWZmIj5QcmludCAvIHNhdmUgUERGPC9idXR0b24+CiAgICAgIDxidXR0b24gY2xh' +
  'c3M9ImJ0biBzZWMiIGlkPSJjb3B5QWZmIj5Db3B5IHRleHQ8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIg' +
  'b25jbGljaz0iY2xvc2VTaGVldCgpIj5DbG9zZTwvYnV0dG9uPgogICAgPC9kaXY+YCwgZWwgPT4gewogICAgY29uc3Qgc2VsID0g' +
  'ZWwucXVlcnlTZWxlY3RvcignI3RwbCcpOwogICAgc2VsLm9uY2hhbmdlID0gYXN5bmMgKCkgPT4geyBlbC5xdWVyeVNlbGVjdG9y' +
  'KCcjcHJldicpLnRleHRDb250ZW50ID0gKGF3YWl0IGxvYWQoc2VsLnZhbHVlKSkudGV4dDsgfTsKICAgIGVsLnF1ZXJ5U2VsZWN0' +
  'b3IoJyNwcmludEFmZicpLm9uY2xpY2sgPSAoKSA9PgogICAgICB3aW5kb3cub3BlbignL3ByaW50L2FmZmlkYXZpdC8nICsgam9i' +
  'LmlkICsgJz90ZW1wbGF0ZV9pZD0nICsgc2VsLnZhbHVlLCAnX2JsYW5rJyk7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjY29weUFm' +
  'ZicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGF3YWl0IG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KGVsLnF1' +
  'ZXJ5U2VsZWN0b3IoJyNwcmV2JykudGV4dENvbnRlbnQpOwogICAgICB0b2FzdCgnQ29waWVkJyk7CiAgICB9OwogIH0pOwp9Cgov' +
  'KiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSB0b29scyAtLS0gKi8K' +
  'LyogTGFiZWwgbWFrZXIuIFRoZSBwb2ludCBvZiB0aGUgc2hlZXQgZ3JpZCBpcyB0aGF0IGxhYmVsIHNoZWV0cyBhcmUgZXhwZW5z' +
  'aXZlCiAgIGFuZCByYXJlbHkgdXNlZCB1cCBpbiBvbmUgZ286IG1hcmsgd2hpY2ggb25lcyB5b3UndmUgYWxyZWFkeSBwZWVsZWQg' +
  'b2ZmIGFuZAogICB0aGUgcHJpbnRlciBza2lwcyB0aGVtLCBzbyBhIHBhcnQtdXNlZCBzaGVldCBnb2VzIGJhY2sgaW4gYW5kIGNh' +
  'cnJpZXMgb24uICovCmFzeW5jIGZ1bmN0aW9uIHRvb2xzVmlldygpIHsKICBjb25zdCBbbGF5b3V0cywgaW5pdFNoZWV0LCBqb2Jz' +
  'XSA9IGF3YWl0IFByb21pc2UuYWxsKFsKICAgIGFwaSgnL2xhYmVsLWxheW91dHMnKSwgYXBpKCcvbGFiZWwtc2hlZXQnKSwgYXBp' +
  'KCcvam9icz9vcGVuPTEnKQogIF0pOwogIFMuY2FjaGUuc2hlZXQgPSBpbml0U2hlZXQ7CiAgUy5jYWNoZS5waWNrZWQgPSBTLmNh' +
  'Y2hlLnBpY2tlZCB8fCBbXTsKCiAgYXBwLmlubmVySFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFnZSI+VG9vbHM8L2gx' +
  'PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+TGFiZWwgbWFrZXIgPHNwYW4gY2xhc3M9InN1YiI+cHJpbnRzIG9u' +
  'bHkgdGhlIGxhYmVscyB5b3UgaGF2ZW4ndCB1c2VkPC9zcGFuPjwvaDI+CgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVs' +
  'PkxhYmVsIHNoZWV0PC9sYWJlbD4KICAgICAgICA8c2VsZWN0IGlkPSJsYXlvdXQiPgogICAgICAgICAgJHtsYXlvdXRzLm1hcChs' +
  'ID0+IGA8b3B0aW9uIHZhbHVlPSIke2wua2V5fSIgJHtsLmtleSA9PT0gaW5pdFNoZWV0LmxheW91dCA/ICdzZWxlY3RlZCcgOiAn' +
  'J30+CiAgICAgICAgICAgICR7ZXNjKGwubmFtZSl9IOKAlCAke2VzYyhsLnNpemUpfTwvb3B0aW9uPmApLmpvaW4oJycpfQogICAg' +
  'ICAgIDwvc2VsZWN0PgogICAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPk9mZmljZSBEZXBvdCBzaGVldHMgcHJpbnQgYW4gQXZlcnkg' +
  'ZXF1aXZhbGVudCBudW1iZXIgb24gdGhlIHBhY2thZ2UgZnJvbnQg4oCUCiAgICAgICAgICBtYXRjaCB0aGF0LiBDaGFuZ2luZyB0' +
  'aGUgc2hlZXQgY2xlYXJzIHRoZSB1c2VkIG1hcmtzLCBzaW5jZSBwb3NpdGlvbiA3IG9uIGEgMzAtdXAgc2hlZXQKICAgICAgICAg' +
  'IGlzbid0IHBvc2l0aW9uIDcgb24gYSAxMC11cCBvbmUuPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGxhYmVsPldoaWNoIGxh' +
  'YmVscyBhcmUgYWxyZWFkeSBnb25lPzwvbGFiZWw+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tYm90dG9t' +
  'OjhweCI+VGFwIHRoZSBvbmVzIGFscmVhZHkgcGVlbGVkIG9mZi4gR3JleSA9IHVzZWQgYW5kIHNraXBwZWQuCiAgICAgICAgTnVt' +
  'YmVyZWQgZ3JlZW4gPSB3aGVyZSB5b3VyIG5leHQgbGFiZWxzIHdpbGwgbGFuZCwgaW4gb3JkZXIuPC9kaXY+CiAgICAgIDxkaXYg' +
  'aWQ9ImdyaWQiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxz' +
  'cGFuIGNsYXNzPSJwaWxsIiBpZD0iZnJlZUNvdW50Ij48L3NwYW4+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIg' +
  'aWQ9Im5ld1NoZWV0Ij5GcmVzaCBzaGVldDwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJh' +
  'bGxVc2VkIj5NYXJrIGFsbCB1c2VkPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2Fy' +
  'ZCI+CiAgICAgIDxoMj5XaG8gdG8gcHJpbnQgPHNwYW4gY2xhc3M9InN1YiIgaWQ9InBpY2tDb3VudCI+PC9zcGFuPjwvaDI+CiAg' +
  'ICAgIDxpbnB1dCBpZD0iam9iRmlsdGVyIiBwbGFjZWhvbGRlcj0iRmlsdGVyIGJ5IG5hbWUsIGNpdHkgb3Igam9iIG51bWJlciIg' +
  'c3R5bGU9Im1hcmdpbi1ib3R0b206OHB4Ij4KICAgICAgPGRpdiBjbGFzcz0ibGlzdCIgaWQ9ImpvYlBpY2siIHN0eWxlPSJtYXgt' +
  'aGVpZ2h0OjMyMHB4O292ZXJmbG93OmF1dG8iPgogICAgICAgICR7am9icy5sZW5ndGggPyBqb2JzLm1hcChqID0+IGAKICAgICAg' +
  'ICAgIDxkaXYgY2xhc3M9Iml0ZW0iIGRhdGEtcGljaz0iJHtqLmlkfSI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9InIiPjxkaXY+' +
  'CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0idCI+JHtlc2Moai5yZWNpcGllbnRfbmFtZSl9PC9kaXY+CiAgICAgICAgICAgICAg' +
  'PGRpdiBjbGFzcz0ibSI+JHtlc2Moai5qb2JfbnVtYmVyKX0gwrcgJHtlc2MoW2ouYWRkcmVzczEsIGouY2l0eV0uZmlsdGVyKEJv' +
  'b2xlYW4pLmpvaW4oJywgJykgfHwgJ25vIGFkZHJlc3MnKX08L2Rpdj4KICAgICAgICAgICAgPC9kaXY+PHNwYW4gY2xhc3M9InBp' +
  'bGwiIGRhdGEtdGljaz0iJHtqLmlkfSI+YWRkPC9zcGFuPjwvZGl2PgogICAgICAgICAgPC9kaXY+YCkuam9pbignJykKICAgICAg' +
  'ICAgIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij5ObyBvcGVuIGpvYnMgdG8gbGFiZWwuPC9kaXY+J30KICAgICAgPC9kaXY+CiAgICA8' +
  'L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPlByaW50PC9oMj4KICAgICAgPGRpdiBjbGFzcz0icm93Ij4K' +
  'ICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJwcmludEJ0biIgZGlzYWJsZWQ+UHJpbnQgbGFiZWxzPC9idXR0b24+CiAg' +
  'ICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9InRlc3RCdG4iPkFsaWdubWVudCB0ZXN0PC9idXR0b24+CiAgICAg' +
  'IDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPkluIHRoZSBwcmludCBkaWFsb2cg' +
  'c2V0IHNjYWxlIHRvIDxiPjEwMCU8L2I+IGFuZCB0dXJuIG9mZgogICAgICAgICJmaXQgdG8gcGFnZSIg4oCUIHNjYWxpbmcgaXMg' +
  'd2hhdCB0aHJvd3MgbGFiZWwgYWxpZ25tZW50IG9mZi48L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0ibWFy' +
  'Z2luLXRvcDoxNHB4Ij48bGFiZWw+TnVkZ2UsIGlmIHlvdXIgcHJpbnRlciBydW5zIG9mZjwvbGFiZWw+CiAgICAgICAgPGRpdiBj' +
  'bGFzcz0icm93Ij4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjAiPlJpZ2h0PC9zcGFuPgogICAg' +
  'ICAgICAgPGlucHV0IGlkPSJvZmZYIiB0eXBlPSJudW1iZXIiIHN0ZXA9IjAuMDEiIG1pbj0iLTAuNSIgbWF4PSIwLjUiIHZhbHVl' +
  'PSIke2luaXRTaGVldC5vZmZzZXRfeH0iIHN0eWxlPSJ3aWR0aDo5MHB4Ij4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJoaW50IiBz' +
  'dHlsZT0ibWFyZ2luOjAiPkRvd248L3NwYW4+CiAgICAgICAgICA8aW5wdXQgaWQ9Im9mZlkiIHR5cGU9Im51bWJlciIgc3RlcD0i' +
  'MC4wMSIgbWluPSItMC41IiBtYXg9IjAuNSIgdmFsdWU9IiR7aW5pdFNoZWV0Lm9mZnNldF95fSIgc3R5bGU9IndpZHRoOjkwcHgi' +
  'PgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9InNhdmVPZmYiPlNhdmU8L2J1dHRvbj4KICAgICAgICA8' +
  'L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoaW50Ij5JbmNoZXMuIFByaW50IHRoZSBhbGlnbm1lbnQgdGVzdCBvbiBwbGFpbiBw' +
  'YXBlciwgaG9sZCBpdCBhZ2FpbnN0IGEgcmVhbCBzaGVldCwKICAgICAgICAgIGFuZCBudWRnZSB1bnRpbCB0aGUgYm94ZXMgbGlu' +
  'ZSB1cC48L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj5gKTsKICBiaW5kU2hlbGwoKTsKCiAgY29uc3QgbGF5b3V0TWV0YSA9' +
  'ICgpID0+IGxheW91dHMuZmluZChsID0+IGwua2V5ID09PSBTLmNhY2hlLnNoZWV0LmxheW91dCkgfHwgbGF5b3V0c1swXTsKCiAg' +
  'ZnVuY3Rpb24gZHJhd0dyaWQoKSB7CiAgICBjb25zdCBtZXRhID0gbGF5b3V0TWV0YSgpOwogICAgY29uc3QgcyA9IFMuY2FjaGUu' +
  'c2hlZXQ7CiAgICBjb25zdCB1c2VkID0gbmV3IFNldChzLnVzZWQubWFwKE51bWJlcikpOwogICAgY29uc3QgZnJlZSA9IFtdOwog' +
  'ICAgZm9yIChsZXQgaSA9IDA7IGkgPCBtZXRhLmNhcGFjaXR5OyBpKyspIGlmICghdXNlZC5oYXMoaSkpIGZyZWUucHVzaChpKTsK' +
  'ICAgIGNvbnN0IG9yZGVyID0gbmV3IE1hcChmcmVlLnNsaWNlKDAsIFMuY2FjaGUucGlja2VkLmxlbmd0aCkubWFwKChwb3MsIG4p' +
  'ID0+IFtwb3MsIG4gKyAxXSkpOwoKICAgICQoJyNncmlkJykuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImxncmlkIiBzdHlsZT0i' +
  'Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgke21ldGEuY29sc30sMWZyKSI+YCArCiAgICAgIEFycmF5LmZyb20oeyBsZW5n' +
  'dGg6IG1ldGEuY2FwYWNpdHkgfSwgKF8sIGkpID0+IHsKICAgICAgICBjb25zdCBpc1VzZWQgPSB1c2VkLmhhcyhpKTsKICAgICAg' +
  'ICBjb25zdCBuID0gb3JkZXIuZ2V0KGkpOwogICAgICAgIHJldHVybiBgPGJ1dHRvbiBjbGFzcz0ibGNlbGwke2lzVXNlZCA/ICcg' +
  'dXNlZCcgOiAnJ30ke24gPyAnIG5leHQnIDogJyd9IiBkYXRhLWNlbGw9IiR7aX0iCiAgICAgICAgICB0aXRsZT0iUG9zaXRpb24g' +
  'JHtpICsgMX0iPiR7aXNVc2VkID8gJ8OXJyA6IChuIHx8ICcnKX08L2J1dHRvbj5gOwogICAgICB9KS5qb2luKCcnKSArICc8L2Rp' +
  'dj4nOwoKICAgICQoJyNmcmVlQ291bnQnKS50ZXh0Q29udGVudCA9IGZyZWUubGVuZ3RoICsgJyBvZiAnICsgbWV0YS5jYXBhY2l0' +
  'eSArICcgbGVmdCc7CiAgICAkKCcjcGlja0NvdW50JykudGV4dENvbnRlbnQgPSBTLmNhY2hlLnBpY2tlZC5sZW5ndGggKyAnIHNl' +
  'bGVjdGVkJzsKICAgIGNvbnN0IG92ZXIgPSBTLmNhY2hlLnBpY2tlZC5sZW5ndGggPiBmcmVlLmxlbmd0aDsKICAgIGNvbnN0IGJ0' +
  'biA9ICQoJyNwcmludEJ0bicpOwogICAgYnRuLmRpc2FibGVkID0gIVMuY2FjaGUucGlja2VkLmxlbmd0aDsKICAgIGJ0bi50ZXh0' +
  'Q29udGVudCA9IG92ZXIKICAgICAgPyBgUHJpbnQgJHtmcmVlLmxlbmd0aH0gbm93ICgke1MuY2FjaGUucGlja2VkLmxlbmd0aCAt' +
  'IGZyZWUubGVuZ3RofSB3b24ndCBmaXQpYAogICAgICA6IGBQcmludCAke1MuY2FjaGUucGlja2VkLmxlbmd0aH0gbGFiZWwke1Mu' +
  'Y2FjaGUucGlja2VkLmxlbmd0aCA9PT0gMSA/ICcnIDogJ3MnfWA7CgogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2Rh' +
  'dGEtY2VsbF0nKS5mb3JFYWNoKGMgPT4gYy5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBpID0gK2MuZGF0YXNl' +
  'dC5jZWxsOwogICAgICBjb25zdCBzZXQgPSBuZXcgU2V0KFMuY2FjaGUuc2hlZXQudXNlZC5tYXAoTnVtYmVyKSk7CiAgICAgIHNl' +
  'dC5oYXMoaSkgPyBzZXQuZGVsZXRlKGkpIDogc2V0LmFkZChpKTsKICAgICAgYXdhaXQgc2F2ZVNoZWV0KHsgdXNlZDogWy4uLnNl' +
  'dF0gfSk7CiAgICB9KTsKICB9CgogIGFzeW5jIGZ1bmN0aW9uIHNhdmVTaGVldChwYXRjaCkgewogICAgdHJ5IHsKICAgICAgUy5j' +
  'YWNoZS5zaGVldCA9IGF3YWl0IGFwaSgnL2xhYmVsLXNoZWV0JywgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5n' +
  'aWZ5KHBhdGNoKSB9KTsKICAgICAgZHJhd0dyaWQoKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsg' +
  'fQogIH0KCiAgJCgnI2xheW91dCcpLm9uY2hhbmdlID0gZSA9PiBzYXZlU2hlZXQoeyBsYXlvdXQ6IGUudGFyZ2V0LnZhbHVlIH0p' +
  'OwogICQoJyNuZXdTaGVldCcpLm9uY2xpY2sgPSAoKSA9PiBzYXZlU2hlZXQoeyB1c2VkOiBbXSB9KTsKICAkKCcjYWxsVXNlZCcp' +
  'Lm9uY2xpY2sgPSAoKSA9PgogICAgc2F2ZVNoZWV0KHsgdXNlZDogQXJyYXkuZnJvbSh7IGxlbmd0aDogbGF5b3V0TWV0YSgpLmNh' +
  'cGFjaXR5IH0sIChfLCBpKSA9PiBpKSB9KTsKICAkKCcjc2F2ZU9mZicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBhd2Fp' +
  'dCBzYXZlU2hlZXQoeyBvZmZzZXRfeDogTnVtYmVyKCQoJyNvZmZYJykudmFsdWUpIHx8IDAsIG9mZnNldF95OiBOdW1iZXIoJCgn' +
  'I29mZlknKS52YWx1ZSkgfHwgMCB9KTsKICAgIHRvYXN0KCdBbGlnbm1lbnQgc2F2ZWQnKTsKICB9OwoKICBjb25zdCBwYWludCA9' +
  'ICgpID0+IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXRpY2tdJykuZm9yRWFjaCh0ID0+IHsKICAgIGNvbnN0IG9u' +
  'ID0gUy5jYWNoZS5waWNrZWQuaW5jbHVkZXMoK3QuZGF0YXNldC50aWNrKTsKICAgIHQudGV4dENvbnRlbnQgPSBvbiA/ICfinJMg' +
  'YWRkZWQnIDogJ2FkZCc7CiAgICB0LmNsYXNzTmFtZSA9IG9uID8gJ3BpbGwgU2VydmVkJyA6ICdwaWxsJzsKICB9KTsKICBkb2N1' +
  'bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1waWNrXScpLmZvckVhY2gocm93ID0+IHJvdy5vbmNsaWNrID0gKCkgPT4gewog' +
  'ICAgY29uc3QgaWQgPSArcm93LmRhdGFzZXQucGljazsKICAgIGNvbnN0IGkgPSBTLmNhY2hlLnBpY2tlZC5pbmRleE9mKGlkKTsK' +
  'ICAgIGkgPT09IC0xID8gUy5jYWNoZS5waWNrZWQucHVzaChpZCkgOiBTLmNhY2hlLnBpY2tlZC5zcGxpY2UoaSwgMSk7CiAgICBw' +
  'YWludCgpOyBkcmF3R3JpZCgpOwogIH0pOwogICQoJyNqb2JGaWx0ZXInKS5vbmlucHV0ID0gZSA9PiB7CiAgICBjb25zdCB2ID0g' +
  'ZS50YXJnZXQudmFsdWUudG9Mb3dlckNhc2UoKTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBpY2tdJyku' +
  'Zm9yRWFjaChyID0+IHsKICAgICAgci5zdHlsZS5kaXNwbGF5ID0gci5pbm5lclRleHQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyh2' +
  'KSA/ICcnIDogJ25vbmUnOwogICAgfSk7CiAgfTsKCiAgJCgnI3Rlc3RCdG4nKS5vbmNsaWNrID0gKCkgPT4gewogICAgY29uc3Qg' +
  'aWRzID0gUy5jYWNoZS5waWNrZWQubGVuZ3RoID8gUy5jYWNoZS5waWNrZWQgOiAoam9ic1swXSA/IFtqb2JzWzBdLmlkXSA6IFtd' +
  'KTsKICAgIGlmICghaWRzLmxlbmd0aCkgcmV0dXJuIHRvYXN0KCdBZGQgYXQgbGVhc3Qgb25lIGpvYiBmaXJzdCcsIHRydWUpOwog' +
  'ICAgd2luZG93Lm9wZW4oJy9wcmludC9sYWJlbHM/Z3VpZGVzPTEmaWRzPScgKyBpZHMuam9pbignLCcpLCAnX2JsYW5rJyk7CiAg' +
  'fTsKCiAgJCgnI3ByaW50QnRuJykub25jbGljayA9ICgpID0+IHsKICAgIGNvbnN0IG1ldGEgPSBsYXlvdXRNZXRhKCk7CiAgICBj' +
  'b25zdCB1c2VkID0gbmV3IFNldChTLmNhY2hlLnNoZWV0LnVzZWQubWFwKE51bWJlcikpOwogICAgY29uc3QgZnJlZSA9IFtdOwog' +
  'ICAgZm9yIChsZXQgaSA9IDA7IGkgPCBtZXRhLmNhcGFjaXR5OyBpKyspIGlmICghdXNlZC5oYXMoaSkpIGZyZWUucHVzaChpKTsK' +
  'ICAgIGNvbnN0IHdpbGxVc2UgPSBmcmVlLnNsaWNlKDAsIFMuY2FjaGUucGlja2VkLmxlbmd0aCk7CiAgICB3aW5kb3cub3Blbign' +
  'L3ByaW50L2xhYmVscz9pZHM9JyArIFMuY2FjaGUucGlja2VkLmpvaW4oJywnKSwgJ19ibGFuaycpOwoKICAgIGNvbmZpcm1Qcmlu' +
  'dGVkKHdpbGxVc2UpOwogIH07CgogIGZ1bmN0aW9uIGNvbmZpcm1QcmludGVkKHdpbGxVc2UpIHsKICAgIHNoZWV0KCdEaWQgdGhl' +
  'eSBwcmludD8nLCBgCiAgICAgIDxwIGNsYXNzPSJoaW50Ij5Pbmx5IG1hcmsgdGhlc2UgdXNlZCBvbmNlIHRoZSBzaGVldCBhY3R1' +
  'YWxseSBjYW1lIG91dCByaWdodCDigJQgaWYgdGhlIHByaW50ZXIKICAgICAgICBqYW1tZWQgb3IgdGhlIGFsaWdubWVudCB3YXMg' +
  'b2ZmLCBzYXkgbm8gYW5kIG5vdGhpbmcgY2hhbmdlcy48L3A+CiAgICAgIDxwPjxiPiR7d2lsbFVzZS5sZW5ndGh9PC9iPiBwb3Np' +
  'dGlvbiR7d2lsbFVzZS5sZW5ndGggPT09IDEgPyAnJyA6ICdzJ30gd291bGQgYmUgbWFya2VkIHVzZWQ6CiAgICAgICAgJHt3aWxs' +
  'VXNlLm1hcChpID0+IGkgKyAxKS5qb2luKCcsICcpfTwvcD4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRv' +
  'cDoxMnB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gb2siIGlkPSJ5ZXNVc2VkIj5ZZXMg4oCUIG1hcmsgdGhlbSB1c2Vk' +
  'PC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5Obywga2VlcCB0' +
  'aGVtIGZyZWU8L2J1dHRvbj4KICAgICAgPC9kaXY+YCwgZWwgPT4gewogICAgICBlbC5xdWVyeVNlbGVjdG9yKCcjeWVzVXNlZCcp' +
  'Lm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgICAgY29uc3Qgc2V0ID0gbmV3IFNldChTLmNhY2hlLnNoZWV0LnVzZWQubWFw' +
  'KE51bWJlcikpOwogICAgICAgIHdpbGxVc2UuZm9yRWFjaChpID0+IHNldC5hZGQoaSkpOwogICAgICAgIGF3YWl0IHNhdmVTaGVl' +
  'dCh7IHVzZWQ6IFsuLi5zZXRdIH0pOwogICAgICAgIFMuY2FjaGUucGlja2VkID0gW107CiAgICAgICAgY2xvc2VTaGVldCgpOwog' +
  'ICAgICAgIHRvYXN0KCdTaGVldCB1cGRhdGVkIOKAlCAnICsgUy5jYWNoZS5zaGVldC5mcmVlICsgJyBsYWJlbHMgbGVmdCcpOwog' +
  'ICAgICAgIGdvKCd0b29scycpOwogICAgICB9OwogICAgfSk7CiAgfQoKICBwYWludCgpOwogIGRyYXdHcmlkKCk7Cn0KCi8qIC0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gcHJvcGVydHkgc2VhcmNoIC0tICovCi8q' +
  'IFRoZSBzYW1lIGxvb2t1cCB0aGUgRGVhbCBGaW5kZXIgcnVucywgYWdhaW5zdCB0aGUgc2FtZSBjb3VudHkgYXBwcmFpc2FsCiAq' +
  'IHJvbGxzLCBiZWNhdXNlIGEgcHJvY2VzcyBzZXJ2ZXIgbmVlZHMgZXhhY3RseSB3aGF0IGEgYnV5ZXIgbmVlZHM6IHdobyBvd25z' +
  'CiAqIHRoaXMgYWRkcmVzcywgYW5kIHdoZXJlIGRvZXMgdGhlaXIgcG9zdCBhY3R1YWxseSBnby4KICoKICogVGhlIHJvbGxzIGFy' +
  'ZSBwdWJsaXNoZWQgYXMgQXJjR0lTIGZlYXR1cmUgbGF5ZXJzLCBzbyB0aGUgYnJvd3NlciBhc2tzIHRoZQogKiBjb3VudHkgZGly' +
  'ZWN0bHkg4oCUIG5vIGtleSwgbm8gc2VydmVyIGluIHRoZSBtaWRkbGUsIG5vdGhpbmcgY2FjaGVkIHRoYXQgY291bGQKICogZ28g' +
  'c3RhbGUuIEZpZWxkIG5hbWVzIGRpZmZlciBwZXIgY291bnR5LCBzbyBlYWNoIG9uZSBjYXJyaWVzIGl0cyBvd24gbWFwLAogKiB2' +
  'ZXJpZmllZCBhZ2FpbnN0IHRoZSBsaXZlIGxheWVyIHJhdGhlciB0aGFuIGd1ZXNzZWQuCiAqLwpjb25zdCBDQUQgPSAoKCkgPT4g' +
  'ewogIGNvbnN0IGNhbWVyb25GaWVsZHMgPSB1cHBlciA9PiB7CiAgICBjb25zdCBuID0gKGEsIGIpID0+ICh1cHBlciA/IGIgOiBh' +
  'KTsKICAgIHJldHVybiB7CiAgICAgIGFkZHI6IG4oJ3NpdHVzZGlzcGwnLCAnc2l0dXNEaXNwbCcpLAogICAgICBhZGRyUGFydHM6' +
  'IFtuKCdzaXR1c25vJywgJ3NpdHVzTm8nKSwgbignc2l0cGZ4JywgJ3NpdFBmeCcpLCBuKCdzaXRzdHInLCAnc2l0U3RyJyksIG4o' +
  'J3NpdHNmeCcsICdzaXRTZngnKV0sCiAgICAgIGNpdHk6IG4oJ3NpdGNpdHknLCAnc2l0Q2l0eScpLCB6aXA6IG4oJ3NpdHppcCcs' +
  'ICdzaXRaaXAnKSwKICAgICAgb3duZXI6ICdvd25lcicsIG1haWw6ICdhZGRyMScsIG1haWxjaXR5OiBuKCdhZGRyY2l0eScsICdh' +
  'ZGRyQ2l0eScpLAogICAgICBtYWlsc3RhdGU6IG4oJ2FkZHJzdGF0ZScsICdhZGRyU3RhdGUnKSwgbWFpbHppcDogbignYWRkcnpp' +
  'cCcsICdhZGRyWmlwJyksCiAgICAgIHNxZnQ6IG4oJ2x2Z2FyZWEnLCAnbHZnQXJlYScpLCB5ZWFyOiBuKCd5cmJ1aWx0JywgJ3ly' +
  'QnVpbHQnKSwgY2FkOiAnbWFya2V0JywKICAgICAgY2xzOiBuKCdzdGF0ZWNkJywgJ3N0YXRlQ2QnKSwgZXhlbXB0OiAnZXhtcycs' +
  'IHBpZDogbigncHJvcF9pZCcsICdQUk9QX0lEJyksCiAgICAgIGdlbzogbignZ2VvX2lkJywgJ2dlb0lEJyksCiAgICAgIGRlZWQ6' +
  'IHsgZGF0ZTogbignZGVlZGR0JywgJ2RlZWREdCcpLCByZWM6IG4oJ2RlZWRyZWNkdCcsICdkZWVkUmVjRHQnKSwKICAgICAgICAg' +
  'ICAgICB0eXBlOiBuKCdkZWVkdHlwZScsICdkZWVkVHlwZScpLCB2b2w6ICd2b2x1bWUnLCBwYWdlOiAncGFnZScsIG51bTogbign' +
  'ZG9jbnVtJywgJ2RvY051bScpIH0KICAgIH07CiAgfTsKICByZXR1cm4gewogICAgJ1RYfEhJREFMR08nOiB7CiAgICAgIGxhYmVs' +
  'OiAnSGlkYWxnbyBDQUQgMjAyNiBjZXJ0aWZpZWQgcm9sbCcsIGNsZXJrOiAnaGlkYWxnbycsCiAgICAgIHE6ICdodHRwczovL3Nl' +
  'cnZpY2VzOS5hcmNnaXMuY29tL2R3TURQNTVIVGZvajRuMWMvYXJjZ2lzL3Jlc3Qvc2VydmljZXMvSENBRF9QQVJDRUxTXzIwMjYv' +
  'RmVhdHVyZVNlcnZlci8xL3F1ZXJ5JywKICAgICAgZjogeyBhZGRyOiAnc2l0dXMnLCBvd25lcjogJ25hbWUnLCBtYWlsOiAnYWRk' +
  'ckRlbGl2ZXJ5TGluZScsIG1haWxjaXR5OiAnYWRkckNpdHknLAogICAgICAgICAgIG1haWxzdGF0ZTogJ2FkZHJTdGF0ZScsIG1h' +
  'aWx6aXA6ICdhZGRyWmlwJywgc3FmdDogJ2ltcHJ2TWFpbkFyZWEnLAogICAgICAgICAgIHllYXI6ICdpbXBydkFjdHVhbFllYXJC' +
  'dWlsdCcsIGNhZDogJ21hcmtldFZhbHVlJywgY2xzOiAnc3RhdGVDZCcsCiAgICAgICAgICAgZXhlbXB0OiAnZXhlbXB0aW9ucycs' +
  'IHBpZDogJ1BST1BfSUQnLCBnZW86ICdnZW9JRCcsIHVuaXQ6ICd0YXhpbmdVbml0cycsCiAgICAgICAgICAgbGVnYWw6ICdsZWdh' +
  'bERlc2NyaXB0aW9uJywKICAgICAgICAgICBkZWVkOiB7IGRhdGU6ICdkZWVkRHQnLCB0eXBlOiAnZGVlZFR5cGUnLCBudW06ICdp' +
  'bnN0cnVtZW50TnVtJyB9IH0sCiAgICAgIGxpbms6IHBpZCA9PiAnaHR0cHM6Ly9oaWRhbGdvLnByb2RpZ3ljYWQuY29tL3Byb3Bl' +
  'cnR5LWRldGFpbC8nICsgcGlkLAogICAgICBjaXRpZXM6IHsgJ01jQWxsZW4nOiAnQ01MJywgJ0VkaW5idXJnJzogJ0NFQicsICdN' +
  'aXNzaW9uJzogJ0NNUycsICdQaGFycic6ICdDUFInLCAnV2VzbGFjbyc6ICdDV0wnLAogICAgICAgICAgICAgICAgJ1NhbiBKdWFu' +
  'JzogJ0NTSicsICdEb25uYSc6ICdDRE4nLCAnTWVyY2VkZXMnOiAnQ01DJywgJ0FsYW1vJzogJ0NBTycsICdIaWRhbGdvJzogJ0NI' +
  'RCcsCiAgICAgICAgICAgICAgICAnTGEgSm95YSc6ICdDTEonLCAnUGFsbXZpZXcnOiAnQ1BNJywgJ0FsdG9uJzogJ0NBTicgfQog' +
  'ICAgfSwKICAgICdUWHxDQU1FUk9OJzogewogICAgICBsYWJlbDogJ0NhbWVyb24gQ0FEIDIwMjYgcm9sbCcsIGNsZXJrOiAnY2Ft' +
  'ZXJvbicsCiAgICAgIHE6ICdodHRwczovL2NvYmdpcy5icm93bnN2aWxsZXR4Lmdvdi9hcmNnaXMvcmVzdC9zZXJ2aWNlcy9Ib3N0' +
  'ZWQvQ0NBRF9QYXJjZWxzXzA5MDgyMDI1L0ZlYXR1cmVTZXJ2ZXIvMC9xdWVyeScsCiAgICAgIGY6IGNhbWVyb25GaWVsZHMoZmFs' +
  'c2UpLAogICAgICBhbHQ6IHsgcTogJ2h0dHBzOi8vc2VydmljZXMyLmFyY2dpcy5jb20vNm9hTE1aRVpsa3RiUXB5aS9hcmNnaXMv' +
  'cmVzdC9zZXJ2aWNlcy9DQ0FEX1BhcmNlbHNfVmlldy9GZWF0dXJlU2VydmVyLzAvcXVlcnknLAogICAgICAgICAgICAgbGFiZWw6' +
  'ICdDYW1lcm9uIENBRCAyMDI1IHJvbGwgKEVzcmkgbWlycm9yKScsIGY6IGNhbWVyb25GaWVsZHModHJ1ZSkgfSwKICAgICAgY2l0' +
  'aWVzOiB7ICdCcm93bnN2aWxsZSc6ICdDQlInLCAnSGFybGluZ2VuJzogJ0NIRycsICdTYW4gQmVuaXRvJzogJ0NTQicsICdMYSBG' +
  'ZXJpYSc6ICdDTEYnLAogICAgICAgICAgICAgICAgJ0xvcyBGcmVzbm9zJzogJ0NMTycsICdTb3V0aCBQYWRyZSBJc2xhbmQnOiAn' +
  'Q1NQJywgJ1JpbyBIb25kbyc6ICdDUkgnLCAnUG9ydCBJc2FiZWwnOiAnQ1BJJyB9CiAgICB9LAogICAgJ1RYfFNUQVJSJzogewog' +
  'ICAgICBsYWJlbDogJ1N0YXJyIENBRCBwYXJjZWxzJywgY2xlcms6ICdzdGFycicsCiAgICAgIHE6ICdodHRwczovL3V0aWxpdHku' +
  'YXJjZ2lzLmNvbS91c3JzdmNzL3NlcnZlcnMvZmYwNWFmNDI5MzQ3NGI0NWFiZjM5MDc1MjUwZWZlNzgvcmVzdC9zZXJ2aWNlcy9T' +
  'dGFyckNBRFdlYlNlcnZpY2UvRmVhdHVyZVNlcnZlci8wL3F1ZXJ5JywKICAgICAgZjogeyBhZGRyUGFydHM6IFsnc2l0dXNfbnVt' +
  'JywgJ3NpdHVzX3N0cmVldF9wcmVmeCcsICdzaXR1c19zdHJlZXQnLCAnc2l0dXNfc3RyZWV0X3N1Zml4J10sCiAgICAgICAgICAg' +
  'YWRkcjogJ3NpdHVzX3N0cmVldCcsIGNpdHk6ICdzaXR1c19jaXR5JywgemlwOiAnc2l0dXNfemlwJywKICAgICAgICAgICBvd25l' +
  'cjogJ2ZpbGVfYXNfbmFtZScsIG1haWw6ICdhZGRyX2xpbmUxJywgbWFpbGNpdHk6ICdhZGRyX2NpdHknLAogICAgICAgICAgIG1h' +
  'aWxzdGF0ZTogJ2FkZHJfc3RhdGUnLCBtYWlsemlwOiAnemlwJywgY2FkOiAnbWFya2V0JywKICAgICAgICAgICBwaWQ6ICdwcm9w' +
  'X2lkJywgZ2VvOiAnZ2VvX2lkJywgdW5pdDogJ2NpdHknLCBsZWdhbDogJ2xlZ2FsX2Rlc2MnLAogICAgICAgICAgIGRlZWQ6IHsg' +
  'ZGF0ZTogJ0RlZWRfRGF0ZScsIHZvbDogJ1ZvbHVtZScsIHBhZ2U6ICdQYWdlJywgbnVtOiAnTnVtYmVyJyB9IH0sCiAgICAgIGNp' +
  'dGllczogeyAnUmlvIEdyYW5kZSBDaXR5JzogJ1JJTyBHUkFOREUgQ0lUWScsICdSb21hJzogJ1JPTUEnLCAnTGEgR3J1bGxhJzog' +
  'J0xBIEdSVUxMQScsCiAgICAgICAgICAgICAgICAnRXNjb2JhcmVzJzogJ0VTQ09CQVJFUycgfSwKICAgICAgY2l0eUlzVGV4dDog' +
  'dHJ1ZSwKICAgICAgbm90ZTogIlN0YXJyJ3Mgcm9sbCBwdWJsaXNoZXMgbm8gYnVpbGRpbmcgc3F1YXJlIGZvb3RhZ2Ugb3IgeWVh' +
  'ciBidWlsdC4iCiAgICB9CiAgfTsKfSkoKTsKCmNvbnN0IHNxbEVzYyA9IHYgPT4gU3RyaW5nKHYpLnJlcGxhY2UoLycvZywgIicn' +
  'Iik7CmNvbnN0IG56ID0gdiA9PiB7IGNvbnN0IG4gPSBwYXJzZUZsb2F0KHYpOyByZXR1cm4gaXNGaW5pdGUobikgPyBuIDogMDsg' +
  'fTsKY29uc3QgdGl0bGVDYXNlID0gdiA9PiBTdHJpbmcodiA9PSBudWxsID8gJycgOiB2KS50b0xvd2VyQ2FzZSgpCiAgLnJlcGxh' +
  'Y2UoL1xiKFthLXpdKS9nLCBtID0+IG0udG9VcHBlckNhc2UoKSkKICAucmVwbGFjZSgvXGIoVHh8SWl8SWlpfEl2fExsY3xMcHxJ' +
  'bmN8UG8pXGIvZywgbSA9PiBtLnRvVXBwZXJDYXNlKCkpLnRyaW0oKTsKCmZ1bmN0aW9uIHNwbGl0U2l0dXModikgewogIGNvbnN0' +
  'IHMgPSBTdHJpbmcodiA9PSBudWxsID8gJycgOiB2KS50cmltKCk7CiAgY29uc3QgbSA9IHMubWF0Y2goL14oLio/KSxccyooW14s' +
  'XSopLFxzKltBLVpdezJ9XGIvKTsKICBpZiAobSkgcmV0dXJuIHsgYWRkcjogbVsxXS50cmltKCksIGNpdHk6IG1bMl0udHJpbSgp' +
  'IH07CiAgcmV0dXJuIHsgYWRkcjogcy5yZXBsYWNlKC8sXHMqVFhccyokL2ksICcnKS50cmltKCksIGNpdHk6ICcnIH07Cn0KCi8q' +
  'IEEgc3RyaW5naWZpZWQgb2JqZWN0IGluIG91dEZpZWxkcyBtYWtlcyBBcmNHSVMgcmVqZWN0IHRoZSB3aG9sZSBxdWVyeSwgc28K' +
  'ICAgdGhlIG1hcCBpcyBmbGF0dGVuZWQgY2FyZWZ1bGx5OiBzdHJpbmdzIHBhc3MsIGFycmF5cyBzcHJlYWQsIHRoZSBuZXN0ZWQg' +
  'ZGVlZAogICBvYmplY3QgY29udHJpYnV0ZXMgaXRzIHZhbHVlcywgYW55dGhpbmcgZWxzZSBpcyBkcm9wcGVkLiAqLwpmdW5jdGlv' +
  'biBmaWVsZExpc3QoRykgewogIGNvbnN0IG91dCA9IFtdOwogIGZvciAoY29uc3QgayBpbiBHKSB7CiAgICBjb25zdCB2ID0gR1tr' +
  'XTsKICAgIGlmICghdikgY29udGludWU7CiAgICBpZiAodHlwZW9mIHYgPT09ICdzdHJpbmcnKSB7IG91dC5wdXNoKHYpOyBjb250' +
  'aW51ZTsgfQogICAgaWYgKEFycmF5LmlzQXJyYXkodikpIHsgdi5mb3JFYWNoKHggPT4geyBpZiAodHlwZW9mIHggPT09ICdzdHJp' +
  'bmcnICYmIHgpIG91dC5wdXNoKHgpOyB9KTsgY29udGludWU7IH0KICAgIGlmICh0eXBlb2YgdiA9PT0gJ29iamVjdCcpIHsgZm9y' +
  'IChjb25zdCBrayBpbiB2KSBpZiAodHlwZW9mIHZba2tdID09PSAnc3RyaW5nJyAmJiB2W2trXSkgb3V0LnB1c2godltra10pOyB9' +
  'CiAgfQogIHJldHVybiBvdXQuZmlsdGVyKCh4LCBpKSA9PiBvdXQuaW5kZXhPZih4KSA9PT0gaSk7Cn0KCi8vIENvdW50aWVzIHN0' +
  'b3JlIHRoZSBkZWVkIGRhdGUgdGhyZWUgd2F5czogSVNPIHN0cmluZywgVVMgc3RyaW5nLCBlcG9jaCBtcy4KZnVuY3Rpb24gZGVl' +
  'ZERhdGUodikgewogIGlmICh2ID09IG51bGwgfHwgdiA9PT0gJycpIHJldHVybiAnJzsKICBjb25zdCBuID0gTnVtYmVyKHYpOwog' +
  'IGlmIChpc0Zpbml0ZShuKSAmJiBuID4gMTAwMDAwMDAwMDApIHsKICAgIGNvbnN0IGQgPSBuZXcgRGF0ZShuKTsKICAgIHJldHVy' +
  'biBpc0Zpbml0ZShkLmdldFRpbWUoKSkgPyBkLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApIDogJyc7CiAgfQogIGNvbnN0IHMg' +
  'PSBTdHJpbmcodikudHJpbSgpOwogIGxldCBtID0gcy5tYXRjaCgvXihcZHs0fSktKFxkezJ9KS0oXGR7Mn0pLyk7CiAgaWYgKG0p' +
  'IHJldHVybiBtWzBdOwogIG0gPSBzLm1hdGNoKC9eKFxkezEsMn0pXC8oXGR7MSwyfSlcLyhcZHs0fSkvKTsKICBpZiAobSkgcmV0' +
  'dXJuIG1bM10gKyAnLScgKyAoJzAnICsgbVsxXSkuc2xpY2UoLTIpICsgJy0nICsgKCcwJyArIG1bMl0pLnNsaWNlKC0yKTsKICBy' +
  'ZXR1cm4gcy5zbGljZSgwLCAxMCk7Cn0KZnVuY3Rpb24gZGVlZE9mKEcsIGEpIHsKICBjb25zdCBkID0gRyAmJiBHLmRlZWQ7CiAg' +
  'aWYgKCFkKSByZXR1cm4gbnVsbDsKICBjb25zdCBnID0gayA9PiAoZFtrXSA/IFN0cmluZyhhW2Rba11dID09IG51bGwgPyAnJyA6' +
  'IGFbZFtrXV0pLnRyaW0oKSA6ICcnKTsKICBjb25zdCBvID0geyBkYXRlOiBkZWVkRGF0ZShkLmRhdGUgPyBhW2QuZGF0ZV0gOiAn' +
  'JyksIHJlYzogZGVlZERhdGUoZC5yZWMgPyBhW2QucmVjXSA6ICcnKSwKICAgICAgICAgICAgICB0eXBlOiBnKCd0eXBlJyksIHZv' +
  'bDogZygndm9sJyksIHBhZ2U6IGcoJ3BhZ2UnKSwgbnVtOiBnKCdudW0nKSB9OwogIHJldHVybiAoby5kYXRlIHx8IG8ucmVjIHx8' +
  'IG8ubnVtIHx8IG8udm9sKSA/IG8gOiBudWxsOwp9CgovKiBSb2xscyBmaWxlIG93bmVycyBsYXN0LW5hbWUtZmlyc3QgYW5kIGJv' +
  'bHQgb24gZXZlcnl0aGluZyBmcm9tIGEgc3BvdXNlIHRvIGFuCiAgIGVzdGF0ZTogIk1BREVSTyBKT1JHRSAmIExJRElBIiwgIkdB' +
  'UlpBIE1BUklBIEVUVVgiLiBTZWFyY2hpbmcgdGhhdCB3aG9sZQogICBzdHJpbmcgZmluZHMgZXhhY3RseSB0aGUgb25lIHBhcmNl' +
  'bCB5b3Ugc3RhcnRlZCBmcm9tLCBzbyBpdCBpcyBjdXQgYmFjayB0bwogICB0aGUgcGFydCB0aGF0IGlkZW50aWZpZXMgdGhlIGZh' +
  'bWlseS4gKi8KY29uc3QgT1dOSlVOSyA9IC9eKEVUQUx8RVR8QUx8RVRVWHxFVFZJUnxVWHxKUnxTUnxJSXxJSUl8SVZ8VFJVU1RF' +
  'RXxUUnxUUlVTVHxFU1R8RVNUQVRFfE9GfFRIRXxMSUZFfEVTVEFURVM/KSQvOwpmdW5jdGlvbiBvd25lclF1ZXJ5KG5hbWUsIHRv' +
  'a2VucykgewogIGNvbnN0IHQgPSBTdHJpbmcobmFtZSB8fCAnJykudG9VcHBlckNhc2UoKQogICAgLnJlcGxhY2UoLyYuKiQvLCAn' +
  'JykKICAgIC5yZXBsYWNlKC9bXkEtWjAtOSBdL2csICcgJykKICAgIC5zcGxpdCgvXHMrLykuZmlsdGVyKEJvb2xlYW4pCiAgICAu' +
  'ZmlsdGVyKHggPT4gIU9XTkpVTksudGVzdCh4KSk7CiAgcmV0dXJuIHQuc2xpY2UoMCwgdG9rZW5zIHx8IDIpLmpvaW4oJyAnKTsK' +
  'fQoKLyogRXZlcnkgY291bnR5IHNwZWxscyB0aGUgc3VmZml4IGRpZmZlcmVudGx5LCBzbyBpdCBpcyBkcm9wcGVkIGJlZm9yZSBz' +
  'ZWFyY2hpbmcKICAgYW5kIHRoZSByZXN0IG1hdGNoZWQgbG9vc2VseS4gKi8KY29uc3QgU1VGRklYRVMgPSAvXihTVHxTVFJFRVR8' +
  'QVZFfEFWRU5VRXxSRHxST0FEfERSfERSSVZFfExOfExBTkV8QkxWRHxCT1VMRVZBUkR8Q1R8Q09VUlR8Q0lSfENJUkNMRXxQTHxQ' +
  'TEFDRXxIV1l8SElHSFdBWXxUUkx8VFJBSUx8V0FZfFBLV1l8UEFSS1dBWXxBUFR8VU5JVHxTVEUpJC87CmZ1bmN0aW9uIGFkZHJU' +
  'b2tlbnMocSkgewogIGNvbnN0IHQgPSBTdHJpbmcocSB8fCAnJykudG9VcHBlckNhc2UoKS5yZXBsYWNlKC9bXkEtWjAtOSBdL2cs' +
  'ICcgJykuc3BsaXQoL1xzKy8pLmZpbHRlcihCb29sZWFuKTsKICBjb25zdCBrZWVwID0gdC5maWx0ZXIoKHYsIGkpID0+IGkgPT09' +
  'IDAgfHwgIVNVRkZJWEVTLnRlc3QodikpOwogIHJldHVybiBrZWVwLmxlbmd0aCA/IGtlZXAgOiB0Owp9Cgpjb25zdCBjbGVya1Nl' +
  'YXJjaCA9IChrZXksIHEpID0+IHsKICBjb25zdCBzcmMgPSBDQURba2V5XTsKICBpZiAoIXNyYyB8fCAhc3JjLmNsZXJrKSByZXR1' +
  'cm4gJyc7CiAgcmV0dXJuICdodHRwczovLycgKyBzcmMuY2xlcmsgKyAnLnR4LnB1YmxpY3NlYXJjaC51cy9yZXN1bHRzP19jb3Vy' +
  'dElkPSZkZXBhcnRtZW50PVJQJyArCiAgICAgICAgICcmbGltaXQ9NTAmb2Zmc2V0PTAmcT0nICsgZW5jb2RlVVJJQ29tcG9uZW50' +
  'KFN0cmluZyhxIHx8ICcnKS50cmltKCkpICsKICAgICAgICAgJyZzZWFyY2hPY3JUZXh0PWZhbHNlJnNlYXJjaFR5cGU9cXVpY2tT' +
  'ZWFyY2gnOwp9OwoKYXN5bmMgZnVuY3Rpb24gY2FkSlNPTih1KSB7CiAgY29uc3QgciA9IGF3YWl0IGZldGNoKHUsIHsgbW9kZTog' +
  'J2NvcnMnIH0pOwogIGlmICghci5vaykgdGhyb3cgbmV3IEVycm9yKCdIVFRQICcgKyByLnN0YXR1cyk7CiAgY29uc3QgaiA9IGF3' +
  'YWl0IHIuanNvbigpOwogIGlmIChqLmVycm9yKSB0aHJvdyBuZXcgRXJyb3Ioai5lcnJvci5tZXNzYWdlIHx8ICgnQ291bnR5IHNl' +
  'cnZlciBlcnJvciAnICsgai5lcnJvci5jb2RlKSk7CiAgcmV0dXJuIGo7Cn0KCmFzeW5jIGZ1bmN0aW9uIGNhZExvb2t1cChrZXks' +
  'IG1vZGUsIHJhdywgY2l0eSwgb3ZlcnJpZGUpIHsKICBjb25zdCBzcmMgPSBvdmVycmlkZSB8fCBDQURba2V5XTsKICBjb25zdCBH' +
  'ID0gc3JjLmYgfHwge30sIEcyID0gc3JjLmYyIHx8IHt9OwogIGNvbnN0IHcgPSBbXTsKICBpZiAobW9kZSA9PT0gJ2FkZHInKSB7' +
  'CiAgICBpZiAoIUcuYWRkcikgdGhyb3cgbmV3IEVycm9yKCJUaGF0IGNvdW50eSdzIHJvbGwgaGFzIG5vIGFkZHJlc3MgY29sdW1u' +
  'LiIpOwogICAgdy5wdXNoKCdVUFBFUignICsgRy5hZGRyICsgIikgTElLRSAnJSIgKyBzcWxFc2MoYWRkclRva2VucyhyYXcpLmpv' +
  'aW4oJyUnKSkgKyAiJSciKTsKICB9IGVsc2UgewogICAgaWYgKCFHLm93bmVyKSB0aHJvdyBuZXcgRXJyb3IoIlRoYXQgY291bnR5' +
  'J3Mgcm9sbCBoYXMgbm8gb3duZXIgY29sdW1uLiIpOwogICAgdy5wdXNoKCdVUFBFUignICsgRy5vd25lciArICIpIExJS0UgJyUi' +
  'ICsgc3FsRXNjKHJhdy50b1VwcGVyQ2FzZSgpKSArICIlJyIpOwogIH0KICBpZiAoY2l0eSkgewogICAgY29uc3QgY29kZSA9IChD' +
  'QURba2V5XS5jaXRpZXMgfHwge30pW2NpdHldOwogICAgaWYgKGNvZGUgJiYgRy51bml0KSB7CiAgICAgIHcucHVzaChDQURba2V5' +
  'XS5jaXR5SXNUZXh0CiAgICAgICAgPyAnVVBQRVIoJyArIEcudW5pdCArICIpIExJS0UgJyUiICsgc3FsRXNjKGNvZGUudG9VcHBl' +
  'ckNhc2UoKSkgKyAiJSciCiAgICAgICAgOiBHLnVuaXQgKyAiIExJS0UgJyUiICsgY29kZSArICIlJyIpOwogICAgfSBlbHNlIGlm' +
  'IChHLmNpdHkpIHsKICAgICAgdy5wdXNoKCdVUFBFUignICsgRy5jaXR5ICsgIikgTElLRSAnJSIgKyBzcWxFc2MoY2l0eS50b1Vw' +
  'cGVyQ2FzZSgpKSArICIlJyIpOwogICAgfQogIH0KICBjb25zdCBvdXRGID0gZmllbGRMaXN0KEcpOwogIGZvciAoY29uc3QgayBp' +
  'biBHMikgaWYgKEcyW2tdKSBvdXRGLnB1c2goRzJba10pOwoKICBjb25zdCBxcCA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoewogICAg' +
  'd2hlcmU6IHcuam9pbignIEFORCAnKSwgb3V0RmllbGRzOiBvdXRGLmpvaW4oJywnKSwgcmV0dXJuR2VvbWV0cnk6ICdmYWxzZScs' +
  'CiAgICByZXN1bHRSZWNvcmRDb3VudDogJzYwJywgZjogJ2pzb24nLCByZXR1cm5DZW50cm9pZDogJ3RydWUnLCBvdXRTUjogJzQz' +
  'MjYnCiAgfSk7CiAgY29uc3QgciA9IGF3YWl0IGNhZEpTT04oc3JjLnEgKyAnPycgKyBxcCk7CiAgcmV0dXJuIChyLmZlYXR1cmVz' +
  'IHx8IFtdKS5tYXAoZnQgPT4gewogICAgY29uc3QgYSA9IGZ0LmF0dHJpYnV0ZXMgfHwge30sIGN0ID0gZnQuY2VudHJvaWQgfHwg' +
  'e307CiAgICBsZXQgc3AgPSBzcGxpdFNpdHVzKGFbRy5hZGRyXSk7CiAgICBpZiAoRy5hZGRyUGFydHMpIHsKICAgICAgY29uc3Qg' +
  'Yml0cyA9IEcuYWRkclBhcnRzLm1hcChrayA9PiBTdHJpbmcoYVtra10gPT0gbnVsbCA/ICcnIDogYVtra10pLnRyaW0oKSkKICAg' +
  'ICAgICAuZmlsdGVyKHggPT4geCAmJiB4ICE9PSAnMCcpOwogICAgICBpZiAoYml0cy5sZW5ndGgpIHNwID0geyBhZGRyOiBiaXRz' +
  'LmpvaW4oJyAnKS5yZXBsYWNlKC9ccysvZywgJyAnKSwgY2l0eTogJycgfTsKICAgIH0KICAgIGNvbnN0IG1jaXR5ID0gRy5tYWls' +
  'Y2l0eSA/IFN0cmluZyhhW0cubWFpbGNpdHldIHx8ICcnKS50cmltKCkgOiAnJzsKICAgIGNvbnN0IHBjaXR5ID0gKEcuY2l0eSAm' +
  'JiBhW0cuY2l0eV0pID8gU3RyaW5nKGFbRy5jaXR5XSkudHJpbSgpIDogc3AuY2l0eTsKICAgIGNvbnN0IGV4ID0gRy5leGVtcHQg' +
  'PyBTdHJpbmcoYVtHLmV4ZW1wdF0gfHwgJycpLnRyaW0oKSA6ICcnOwogICAgY29uc3QgcGlkID0gRy5waWQgPyBhW0cucGlkXSA6' +
  'ICcnOwogICAgcmV0dXJuIHsKICAgICAgbGF0OiBpc0Zpbml0ZShjdC55KSA/IGN0LnkgOiBudWxsLCBsb246IGlzRmluaXRlKGN0' +
  'LngpID8gY3QueCA6IG51bGwsCiAgICAgIGFkZHJlc3M6IHRpdGxlQ2FzZShzcC5hZGRyKSB8fCAn4oCUJywgY2l0eTogdGl0bGVD' +
  'YXNlKHBjaXR5KSB8fCBjaXR5LAogICAgICB6aXA6IEcuemlwID8gU3RyaW5nKGFbRy56aXBdIHx8ICcnKS5zbGljZSgwLCA1KSA6' +
  'ICcnLAogICAgICBzcWZ0OiBHLnNxZnQgPyBueihhW0cuc3FmdF0pIDogMCwgeWVhcjogRy55ZWFyID8gbnooYVtHLnllYXJdKSA6' +
  'IDAsCiAgICAgIGNsczogRy5jbHMgPyBTdHJpbmcoYVtHLmNsc10gfHwgJycpLnRyaW0oKSA6ICcnLAogICAgICBvd25lcjogdGl0' +
  'bGVDYXNlKGFbRy5vd25lcl0gfHwgJycpLAogICAgICBtYWlsOiB0aXRsZUNhc2UoW2FbRy5tYWlsXSwgbWNpdHksIEcubWFpbHN0' +
  'YXRlID8gYVtHLm1haWxzdGF0ZV0gOiAnJywKICAgICAgICAgICAgICAgICAgICAgICBHLm1haWx6aXAgPyBhW0cubWFpbHppcF0g' +
  'OiAnJ10uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJywgJykpLAogICAgICBtYWlsY2l0eTogdGl0bGVDYXNlKG1jaXR5KSwKICAgICAg' +
  'ZXhlbXB0OiBleCwgaG9tZXN0ZWFkOiAvXGJIU1xiL2kudGVzdChleCksCiAgICAgIG91dG9mdG93bjogISEobWNpdHkgJiYgcGNp' +
  'dHkgJiYgbWNpdHkudG9VcHBlckNhc2UoKSAhPT0gcGNpdHkudG9VcHBlckNhc2UoKSksCiAgICAgIGxlZ2FsOiBHLmxlZ2FsID8g' +
  'U3RyaW5nKGFbRy5sZWdhbF0gfHwgJycpLnRyaW0oKSA6ICcnLAogICAgICBkZWVkOiBkZWVkT2YoRywgYSksCiAgICAgIHBpZCwg' +
  'Z2VvOiBHLmdlbyA/IGFbRy5nZW9dIDogJycsIGxpbms6IChDQURba2V5XS5saW5rICYmIHBpZCkgPyBDQURba2V5XS5saW5rKHBp' +
  'ZCkgOiAnJwogICAgfTsKICB9KTsKfQoKbGV0IFBST1AgPSB7IGtleTogJ1RYfEhJREFMR08nLCBtb2RlOiAnYWRkcicsIHJlc3Vs' +
  'dHM6IFtdLCBqb2JJZDogbnVsbCB9OwoKZnVuY3Rpb24gcHJvcGVydHlWaWV3KCkgewogIGNvbnN0IHNyYyA9IENBRFtQUk9QLmtl' +
  'eV07CiAgY29uc3QgY2l0eU9wdHMgPSBbJzxvcHRpb24gdmFsdWU9IiI+QW55IGNpdHk8L29wdGlvbj4nXQogICAgLmNvbmNhdChP' +
  'YmplY3Qua2V5cyhzcmMuY2l0aWVzIHx8IHt9KS5tYXAoYyA9PiBgPG9wdGlvbj4ke2VzYyhjKX08L29wdGlvbj5gKSkuam9pbign' +
  'Jyk7CgogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8aDEgY2xhc3M9InBhZ2UiPlByb3BlcnR5IHJlY29yZHM8L2gxPgoK' +
  'ICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIGlkPSJwcm9wTW9kZSIgc3R5bGU9ImdhcDo2cHgi' +
  'PgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biAke1BST1AubW9kZSA9PT0gJ2FkZHInID8gJycgOiAnc2VjICd9c20iIGRhdGEt' +
  'bT0iYWRkciI+QnkgYWRkcmVzczwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biAke1BST1AubW9kZSA9PT0gJ293' +
  'bmVyJyA/ICcnIDogJ3NlYyAnfXNtIiBkYXRhLW09Im93bmVyIj5CeSBvd25lcjwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAg' +
  'PGRpdiBjbGFzcz0iZ3JpZCBnMiIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxs' +
  'YWJlbD5Db3VudHk8L2xhYmVsPjxzZWxlY3QgaWQ9InByb3BDb3VudHkiPgogICAgICAgICAgJHtPYmplY3Qua2V5cyhDQUQpLnNv' +
  'cnQoKS5tYXAoayA9PiBgPG9wdGlvbiB2YWx1ZT0iJHtlc2Moayl9IiR7ayA9PT0gUFJPUC5rZXkgPyAnIHNlbGVjdGVkJyA6ICcn' +
  'fT4kewogICAgICAgICAgICBlc2Moay5zcGxpdCgnfCcpWzFdLnJlcGxhY2UoL1xiKFx3KShcdyopL2csIChtLCBhLCBiKSA9PiBh' +
  'ICsgYi50b0xvd2VyQ2FzZSgpKSl9IENvdW50eSwgVFg8L29wdGlvbj5gKS5qb2luKCcnKX0KICAgICAgICA8L3NlbGVjdD48L2Rp' +
  'dj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNpdHkgPHNwYW4gY2xhc3M9InN1YiI+b3B0aW9uYWw8L3NwYW4+' +
  'PC9sYWJlbD4KICAgICAgICAgIDxzZWxlY3QgaWQ9InByb3BDaXR5Ij4ke2NpdHlPcHRzfTwvc2VsZWN0PjwvZGl2PgogICAgICA8' +
  'L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbCBpZD0icHJvcExhYmVsIj4ke1BST1AubW9kZSA9PT0gJ2FkZHIn' +
  'ID8gJ0FkZHJlc3MnIDogJ093bmVyIG5hbWUnfTwvbGFiZWw+CiAgICAgICAgPGlucHV0IGlkPSJwcm9wUSIgcGxhY2Vob2xkZXI9' +
  'IiR7UFJPUC5tb2RlID09PSAnYWRkcicgPyAnMTgwNiBBc2ggQXZlJyA6ICdHYXJ6YSd9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFz' +
  'cz0icm93Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJwcm9wR28iPlNlYXJjaDwvYnV0dG9uPgogICAgICAgIDxi' +
  'dXR0b24gY2xhc3M9ImJ0biBzZWMiIGlkPSJwcm9wQ2xlYXIiPkNsZWFyPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8cCBj' +
  'bGFzcz0iaGludCIgaWQ9InByb3BIaW50Ij48L3A+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGlkPSJwcm9wU3RhdHVzIj48L2Rpdj4K' +
  'ICAgIDxkaXYgaWQ9InByb3BPdXQiPjwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8cCBjbGFzcz0iaGludCIg' +
  'c3R5bGU9Im1hcmdpbjowIj5BIG1haWxpbmcgYWRkcmVzcyBmcm9tIHRoZSBhcHByYWlzYWwgZGlzdHJpY3QgaXMgYSBsZWFkLCBu' +
  'b3QgcHJvb2Ygb2YKICAgICAgICByZXNpZGVuY2Ug4oCUIHBsZW50eSBvZiBvd25lcnMgaGF2ZSBwb3N0IGdvaW5nIHRvIGFuIGFn' +
  'ZW50LCBhIHJlbGF0aXZlLCBvciBhbm90aGVyIHN0YXRlLiBUcmVhdCBpdCBhcyBhCiAgICAgICAgcGxhY2UgdG8gYXR0ZW1wdCwg' +
  'YW5kIHJlY29yZCB3aGF0IHlvdSBhY3R1YWxseSBmaW5kIGluIHRoZSBhdHRlbXB0IG5vdGVzLjwvcD4KICAgIDwvZGl2PmApOwog' +
  'IGJpbmRTaGVsbCgpOwoKICBjb25zdCBoaW50ID0gKCkgPT4gewogICAgY29uc3QgcyA9IENBRFtQUk9QLmtleV07CiAgICAkKCcj' +
  'cHJvcEhpbnQnKS5pbm5lckhUTUwgPSAoUFJPUC5tb2RlID09PSAnYWRkcicKICAgICAgPyAnU3RyZWV0IG51bWJlciBhbmQgbmFt' +
  'ZSBpcyBlbm91Z2gg4oCUIHRoZSBzdWZmaXggaXMgZHJvcHBlZCBiZWZvcmUgc2VhcmNoaW5nLCBiZWNhdXNlIGV2ZXJ5IGNvdW50' +
  'eSBzcGVsbHMgaXQgZGlmZmVyZW50bHkuJwogICAgICA6ICdBIHN1cm5hbWUgYWxvbmUgd29ya3MgYW5kIGZpbmRzIGV2ZXJ5IHBh' +
  'cmNlbCB0aGF0IG93bmVyIGhvbGRzIGluIHRoZSBjb3VudHkuIFJlY29yZHMgYXJlIGZpbGVkIGxhc3QgbmFtZSBmaXJzdCwgc28g' +
  'PGk+R2FyemE8L2k+IGJlYXRzIDxpPk1hcmlhIEdhcnphPC9pPi4nKQogICAgICArIChzLm5vdGUgPyAnIDxiPicgKyBlc2Mocy5u' +
  'b3RlKSArICc8L2I+JyA6ICcnKTsKICB9OwogIGhpbnQoKTsKCiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnI3Byb3BNb2Rl' +
  'IFtkYXRhLW1dJykuZm9yRWFjaChiID0+IGIub25jbGljayA9ICgpID0+IHsKICAgIFBST1AubW9kZSA9IGIuZGF0YXNldC5tOyBw' +
  'cm9wZXJ0eVZpZXcoKTsKICB9KTsKICAkKCcjcHJvcENvdW50eScpLm9uY2hhbmdlID0gKCkgPT4geyBQUk9QLmtleSA9ICQoJyNw' +
  'cm9wQ291bnR5JykudmFsdWU7IHByb3BlcnR5VmlldygpOyB9OwogICQoJyNwcm9wQ2xlYXInKS5vbmNsaWNrID0gKCkgPT4geyBQ' +
  'Uk9QLnJlc3VsdHMgPSBbXTsgJCgnI3Byb3BPdXQnKS5pbm5lckhUTUwgPSAnJzsgJCgnI3Byb3BTdGF0dXMnKS5pbm5lckhUTUwg' +
  'PSAnJzsgJCgnI3Byb3BRJykudmFsdWUgPSAnJzsgfTsKICAkKCcjcHJvcFEnKS5vbmtleWRvd24gPSBlID0+IHsgaWYgKGUua2V5' +
  'ID09PSAnRW50ZXInKSB7IGUucHJldmVudERlZmF1bHQoKTsgJCgnI3Byb3BHbycpLmNsaWNrKCk7IH0gfTsKICAkKCcjcHJvcEdv' +
  'Jykub25jbGljayA9ICgpID0+IHJ1blByb3BlcnR5U2VhcmNoKCQoJyNwcm9wUScpLnZhbHVlLnRyaW0oKSwgJCgnI3Byb3BDaXR5' +
  'JykudmFsdWUpOwogIGlmIChQUk9QLnJlc3VsdHMubGVuZ3RoKSBkcmF3UHJvcGVydHkoKTsKfQoKYXN5bmMgZnVuY3Rpb24gcnVu' +
  'UHJvcGVydHlTZWFyY2gocmF3LCBjaXR5KSB7CiAgaWYgKCFyYXcpIHJldHVybiB0b2FzdCgnVHlwZSBzb21ldGhpbmcgdG8gbG9v' +
  'ayB1cCcsIHRydWUpOwogIGNvbnN0IHN0YXQgPSAkKCcjcHJvcFN0YXR1cycpOwogIGNvbnN0IHNyYyA9IENBRFtQUk9QLmtleV07' +
  'CiAgc3RhdC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbjowIj5B' +
  'c2tpbmcgJHtlc2Moc3JjLmxhYmVsKX3igKY8L2Rpdj48L2Rpdj5gOwogICQoJyNwcm9wT3V0JykuaW5uZXJIVE1MID0gJyc7CiAg' +
  'dHJ5IHsKICAgIGxldCByb3dzOwogICAgdHJ5IHsKICAgICAgcm93cyA9IGF3YWl0IGNhZExvb2t1cChQUk9QLmtleSwgUFJPUC5t' +
  'b2RlLCByYXcsIGNpdHkpOwogICAgfSBjYXRjaCAoZSkgewogICAgICAvLyBDYW1lcm9uIHB1Ymxpc2hlcyB0aGUgc2FtZSByb2xs' +
  'IHR3aWNlOyBpZiB0aGUgZmlyc3QgaXMgZG93biwgdHJ5IHRoZSBtaXJyb3IuCiAgICAgIGlmICghc3JjLmFsdCkgdGhyb3cgZTsK' +
  'ICAgICAgcm93cyA9IGF3YWl0IGNhZExvb2t1cChQUk9QLmtleSwgUFJPUC5tb2RlLCByYXcsIGNpdHksIHNyYy5hbHQpOwogICAg' +
  'fQogICAgUFJPUC5yZXN1bHRzID0gcm93czsKICAgIHN0YXQuaW5uZXJIVE1MID0gcm93cy5sZW5ndGgKICAgICAgPyBgPGRpdiBj' +
  'bGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbjowIj4ke3Jvd3MubGVuZ3RofSByZWNvcmQke3Jvd3Mu' +
  'bGVuZ3RoID09PSAxID8gJycgOiAncyd9IGZyb20gJHtlc2Moc3JjLmxhYmVsKX08L2Rpdj48L2Rpdj5gCiAgICAgIDogYDxkaXYg' +
  'Y2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MCI+Tm90aGluZyBtYXRjaGVkIGluICR7ZXNjKHNy' +
  'Yy5sYWJlbCl9LiBUcnkgZmV3ZXIgd29yZHMsIG9yIGRyb3AgdGhlIGNpdHkuPC9kaXY+PC9kaXY+YDsKICAgIGRyYXdQcm9wZXJ0' +
  'eSgpOwogIH0gY2F0Y2ggKGUpIHsKICAgIFBST1AucmVzdWx0cyA9IFtdOwogICAgc3RhdC5pbm5lckhUTUwgPSBgPGRpdiBjbGFz' +
  'cz0iY2FyZCI+PGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbjowO2NvbG9yOnZhcigtLWJhZCkiPlRoZSBjb3VudHkgZGlk' +
  'IG5vdCBhbnN3ZXI6ICR7ZXNjKGUubWVzc2FnZSl9PC9kaXY+PC9kaXY+YDsKICAgICQoJyNwcm9wT3V0JykuaW5uZXJIVE1MID0g' +
  'Jyc7CiAgfQp9CgpmdW5jdGlvbiBkcmF3UHJvcGVydHkoKSB7CiAgY29uc3Qgb3V0ID0gJCgnI3Byb3BPdXQnKTsKICBpZiAoIW91' +
  'dCkgcmV0dXJuOwogIG91dC5pbm5lckhUTUwgPSBQUk9QLnJlc3VsdHMubWFwKChyLCBpKSA9PiB7CiAgICBjb25zdCBMID0gKGss' +
  'IHYpID0+IGA8dHI+PHRoIHN0eWxlPSJ3aWR0aDozOCUiPiR7a308L3RoPjx0ZD4ke3Z9PC90ZD48L3RyPmA7CiAgICBjb25zdCBk' +
  'ID0gci5kZWVkOwogICAgbGV0IGRlZWRMaW5lID0gJyc7CiAgICBpZiAoZCkgewogICAgICBjb25zdCBiaXRzID0gW107CiAgICAg' +
  'IGlmIChkLmRhdGUpIGJpdHMucHVzaChlc2MoZC5kYXRlKSk7CiAgICAgIGlmIChkLnR5cGUpIGJpdHMucHVzaChlc2MoZC50eXBl' +
  'KSk7CiAgICAgIGlmIChkLm51bSkgYml0cy5wdXNoKCdpbnN0LiAnICsgZXNjKGQubnVtKSk7CiAgICAgIGlmIChkLnZvbCAmJiBk' +
  'LnBhZ2UpIGJpdHMucHVzaCgndm9sICcgKyBlc2MoZC52b2wpICsgJyBwZyAnICsgZXNjKGQucGFnZSkpOwogICAgICBkZWVkTGlu' +
  'ZSA9IGJpdHMuam9pbignIMK3ICcpOwogICAgfQogICAgY29uc3QgZnVsbCA9IFtyLmFkZHJlc3MsIFtyLmNpdHksIHIuemlwXS5m' +
  'aWx0ZXIoQm9vbGVhbikuam9pbignICcpXS5maWx0ZXIoQm9vbGVhbikuam9pbignLCAnKTsKICAgIHJldHVybiBgPGRpdiBjbGFz' +
  'cz0iY2FyZCI+CiAgICAgIDxoMj4ke2VzYyhyLmFkZHJlc3MpfTwvaDI+CiAgICAgIDxkaXYgY2xhc3M9Im0iIHN0eWxlPSJjb2xv' +
  'cjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjEzcHgiPiR7ZXNjKFtyLmNpdHksIHIuemlwXS5maWx0ZXIoQm9vbGVhbikuam9pbign' +
  'ICcpKX08L2Rpdj4KICAgICAgPHRhYmxlIGNsYXNzPSJ0YmwiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgICR7TCgn' +
  'T3duZXInLCAnPGI+JyArIGVzYyhyLm93bmVyIHx8ICfigJQnKSArICc8L2I+Jyl9CiAgICAgICAgJHtyLm1haWwgPyBMKCdNYWls' +
  'cyB0bycsIGVzYyhyLm1haWwpKSA6ICcnfQogICAgICAgICR7TCgnTGl2ZXMgdGhlcmU/Jywgci5ob21lc3RlYWQKICAgICAgICAg' +
  'ICAgPyAnPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLW9rKTtmb250LXdlaWdodDo2MDAiPkhvbWVzdGVhZCBvbiBmaWxlIOKAlCBv' +
  'd25lci1vY2N1cGllZDwvc3Bhbj4nCiAgICAgICAgICAgIDogJ05vIGhvbWVzdGVhZCBleGVtcHRpb24nICsgKHIub3V0b2Z0b3du' +
  'ID8gJyDCtyA8Yj5tYWlscyBvdXQgb2YgdG93bjwvYj4nIDogJycpKX0KICAgICAgICAke3IueWVhciA/IEwoJ0J1aWx0Jywgci55' +
  'ZWFyKSA6ICcnfQogICAgICAgICR7ci5zcWZ0ID8gTCgnU2l6ZScsIE1hdGgucm91bmQoci5zcWZ0KS50b0xvY2FsZVN0cmluZygp' +
  'ICsgJyBzcSBmdCcpIDogJyd9CiAgICAgICAgJHtyLmxlZ2FsID8gTCgnTGVnYWwnLCBlc2Moci5sZWdhbCkpIDogJyd9CiAgICAg' +
  'ICAgJHtyLmdlbyA/IEwoJ0dlb2dyYXBoaWMgSUQnLCBlc2Moci5nZW8pKSA6ICcnfQogICAgICAgICR7ZGVlZExpbmUgPyBMKCdM' +
  'YXN0IGRlZWQnLCBkZWVkTGluZSkgOiAnJ30KICAgICAgPC90YWJsZT4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFy' +
  'Z2luLXRvcDoxMHB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBkYXRhLXBjb3B5PSIke2VzYyhmdWxsKX0i' +
  'PkNvcHkgYWRkcmVzczwvYnV0dG9uPgogICAgICAgICR7ci5tYWlsID8gYDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGRhdGEt' +
  'cGNvcHk9IiR7ZXNjKHIubWFpbCl9Ij5Db3B5IG1haWxpbmcgYWRkcmVzczwvYnV0dG9uPmAgOiAnJ30KICAgICAgICAke3Iub3du' +
  'ZXIgPyBgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgZGF0YS1wb3duZXI9IiR7ZXNjKG93bmVyUXVlcnkoci5vd25lcikpfSI+' +
  'TW9yZSBieSB0aGlzIG93bmVyPC9idXR0b24+YCA6ICcnfQogICAgICAgICR7ci5sYXQgIT0gbnVsbCA/IGA8YSBjbGFzcz0iYnRu' +
  'IHNlYyBzbSIgdGFyZ2V0PSJfYmxhbmsiCiAgICAgICAgICAgaHJlZj0iaHR0cHM6Ly93d3cuZ29vZ2xlLmNvbS9tYXBzL3NlYXJj' +
  'aC8/YXBpPTEmcXVlcnk9JHtyLmxhdH0sJHtyLmxvbn0iPk1hcDwvYT5gIDogJyd9CiAgICAgICAgJHtyLmxpbmsgPyBgPGEgY2xh' +
  'c3M9ImJ0biBzZWMgc20iIHRhcmdldD0iX2JsYW5rIiBocmVmPSIke2VzYyhyLmxpbmspfSI+Q291bnR5IHJlY29yZCDihpc8L2E+' +
  'YCA6ICcnfQogICAgICAgICR7ci5vd25lciA/IGA8YSBjbGFzcz0iYnRuIHNlYyBzbSIgdGFyZ2V0PSJfYmxhbmsiCiAgICAgICAg' +
  'ICAgaHJlZj0iJHtlc2MoY2xlcmtTZWFyY2goUFJPUC5rZXksIChkICYmIGQubnVtKSA/IGQubnVtIDogb3duZXJRdWVyeShyLm93' +
  'bmVyKSkpfSI+RGVlZHMgJmFtcDsgbGllbnMg4oaXPC9hPmAgOiAnJ30KICAgICAgPC9kaXY+CiAgICA8L2Rpdj5gOwogIH0pLmpv' +
  'aW4oJycpOwoKICBvdXQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcGNvcHldJykuZm9yRWFjaChiID0+IGIub25jbGljayA9IGFz' +
  'eW5jICgpID0+IHsKICAgIHRyeSB7IGF3YWl0IG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KGIuZGF0YXNldC5wY29weSk7' +
  'IHRvYXN0KCdDb3BpZWQnKTsgfQogICAgY2F0Y2ggKGUpIHsgdG9hc3QoJ0NvcHkgZmFpbGVkIOKAlCBzZWxlY3QgaXQgYnkgaGFu' +
  'ZCcsIHRydWUpOyB9CiAgfSk7CiAgb3V0LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBvd25lcl0nKS5mb3JFYWNoKGIgPT4gYi5v' +
  'bmNsaWNrID0gKCkgPT4gewogICAgUFJPUC5tb2RlID0gJ293bmVyJzsKICAgIHByb3BlcnR5VmlldygpOwogICAgJCgnI3Byb3BR' +
  'JykudmFsdWUgPSBiLmRhdGFzZXQucG93bmVyOwogICAgcnVuUHJvcGVydHlTZWFyY2goYi5kYXRhc2V0LnBvd25lciwgJycpOwog' +
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
  'cnMsIGNsaWVudHMsIGFyXSA9IGF3YWl0IFByb21pc2UuYWxsKAogICAgW2FwaSgnL3N0YXRlbWVudHMnKSwgYXBpKCcvaW52b2lj' +
  'ZXMnKSwgYXBpKCcvdXNlcnMnKSwgYXBpKCcvY2xpZW50cycpLCBhcGkoJy9yZWNlaXZhYmxlcycpXSk7CgogIC8qIE1vbmV5IG93' +
  'ZWQsIG9sZGVzdCBmaXJzdC4gIlVuYmlsbGVkIiBpcyBkZWxpYmVyYXRlbHkgbm90IHBhcnQgb2YgdGhlCiAgICAgdG90YWwg4oCU' +
  'IHRoYXQgaXMgd29yayB5b3UgaGF2ZSBub3QgYXNrZWQgdG8gYmUgcGFpZCBmb3IgeWV0LCB3aGljaCBpcyBhCiAgICAgZGlmZmVy' +
  'ZW50IHByb2JsZW0gZnJvbSBhIGZpcm0gdGhhdCBpcyBzbG93IHRvIHBheS4gKi8KICBjb25zdCBvd2VkID0gYXIuY2xpZW50cy5m' +
  'aWx0ZXIoYyA9PiBOdW1iZXIoYy5iYWxhbmNlKSA+IDApOwogIGNvbnN0IGJ1Y2tldCA9ICh2LCB3YXJuKSA9PiBgPGRpdiBjbGFz' +
  'cz0ic3RhdCR7diA+IDAgJiYgd2FybiA/ICcgYmFkJyA6ICcnfSIgc3R5bGU9ImZsZXg6MSI+CiAgICAgIDxkaXYgY2xhc3M9Im4i' +
  'IHN0eWxlPSJmb250LXNpemU6MTZweCI+JHttb25leSh2KX08L2Rpdj48ZGl2IGNsYXNzPSJsIj4ke3dhcm4gfHwgJ0N1cnJlbnQn' +
  'fTwvZGl2PjwvZGl2PmA7CgogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8aDEgY2xhc3M9InBhZ2UiPkJpbGxpbmcgJmFt' +
  'cDsgcGF5PC9oMT4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPk91dHN0YW5kaW5nIDxzcGFuIGNsYXNzPSJzdWIi' +
  'PndoYXQgeW91ciBhdHRvcm5leXMgb3dlIHlvdTwvc3Bhbj48L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdGF0IGJpZyIgc3R5bGU9' +
  'Im1hcmdpbi10b3A6NnB4Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJuIj4ke21vbmV5KGFyLnRvdGFsKX08L2Rpdj4KICAgICAgICA8' +
  'ZGl2IGNsYXNzPSJsIj4ke293ZWQubGVuZ3RoID8gb3dlZC5sZW5ndGggKyAnIGZpcm0nICsgKG93ZWQubGVuZ3RoID09PSAxID8g' +
  'JycgOiAncycpICsgJyB3aXRoIGEgYmFsYW5jZScKICAgICAgICAgIDogJ0V2ZXJ5b25lIGlzIHBhaWQgdXAnfTwvZGl2PgogICAg' +
  'ICA8L2Rpdj4KICAgICAgJHthci50b3RhbCA+IDAgPyBgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0iZ2FwOjZweDttYXJnaW4tdG9w' +
  'OjEwcHgiPgogICAgICAgICR7YnVja2V0KGFyLmJ1Y2tldHMuZDApfSR7YnVja2V0KGFyLmJ1Y2tldHMuZDMwLCAnMzArIGRheXMn' +
  'KX0KICAgICAgICAke2J1Y2tldChhci5idWNrZXRzLmQ2MCwgJzYwKyBkYXlzJyl9JHtidWNrZXQoYXIuYnVja2V0cy5kOTAsICc5' +
  'MCsgZGF5cycpfQogICAgICA8L2Rpdj5gIDogJyd9CiAgICAgICR7b3dlZC5sZW5ndGggPyBgPHRhYmxlIGNsYXNzPSJ0YmwiIHN0' +
  'eWxlPSJtYXJnaW4tdG9wOjE0cHgiPgogICAgICAgIDx0cj48dGg+QXR0b3JuZXk8L3RoPjx0aCBjbGFzcz0ibnVtIj5Pd2VkPC90' +
  'aD48dGggY2xhc3M9Im51bSI+T2xkZXN0PC90aD48dGg+PC90aD48L3RyPgogICAgICAgICR7b3dlZC5tYXAoYyA9PiB7CiAgICAg' +
  'ICAgICBjb25zdCBhZ2UgPSBNYXRoLmZsb29yKChEYXRlLm5vdygpIC0gbmV3IERhdGUoYy5vbGRlc3RfaW52b2ljZSkuZ2V0VGlt' +
  'ZSgpKSAvIDg2NGU1KTsKICAgICAgICAgIHJldHVybiBgPHRyPgogICAgICAgICAgICA8dGQ+JHtlc2MoYy5jbGllbnRfbmFtZSl9' +
  'PGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbjowIj4ke2MuaW52b2ljZV9jb3VudH0gaW52b2ljZSR7CiAgICAgICAgICAg' +
  'ICAgYy5pbnZvaWNlX2NvdW50ID09PSAxID8gJycgOiAncyd9PC9kaXY+PC90ZD4KICAgICAgICAgICAgPHRkIGNsYXNzPSJudW0i' +
  'PiR7bW9uZXkoYy5iYWxhbmNlKX08L3RkPgogICAgICAgICAgICA8dGQgY2xhc3M9Im51bSIke2FnZSA+PSA2MCA/ICcgc3R5bGU9' +
  'ImNvbG9yOnZhcigtLWJhZCk7Zm9udC13ZWlnaHQ6NzAwIicgOiAnJ30+JHthZ2V9ZDwvdGQ+CiAgICAgICAgICAgIDx0ZCBjbGFz' +
  'cz0ibnVtIj48YSBocmVmPSIvcHJpbnQvYWNjb3VudC8ke2MuY2xpZW50X2lkfSIgdGFyZ2V0PSJfYmxhbmsiPnN0YXRlbWVudDwv' +
  'YT48L3RkPgogICAgICAgICAgPC90cj5gOwogICAgICAgIH0pLmpvaW4oJycpfTwvdGFibGU+YCA6ICcnfQogICAgICAke2FyLnVu' +
  'YmlsbGVkID4gMCA/IGA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij5TZXBhcmF0ZWx5LCA8Yj4ke21v' +
  'bmV5KGFyLnVuYmlsbGVkKX08L2I+CiAgICAgICAgb2Ygc2VydmVkIHdvcmsgaGFzIG5vdCBiZWVuIHB1dCBvbiBhbiBpbnZvaWNl' +
  'IHlldCDigJQgdGhhdCBpcyBtb25leSB5b3UgaGF2ZSBub3QgYXNrZWQgZm9yLjwvZGl2PmAgOiAnJ30KICAgIDwvZGl2PgoKICAg' +
  'IDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+Q29udHJhY3RvciBzdGF0ZW1lbnRzIDxzcGFuIGNsYXNzPSJzdWIiPndoYXQg' +
  'eW91IG93ZSB5b3VyIHNlcnZlcnM8L3NwYW4+PC9oMj4KICAgICAgPHAgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOi00' +
  'cHgiPlB1bGxzIGV2ZXJ5IGNvbXBsZXRlZCBzZXJ2ZSBpbiB0aGUgcGVyaW9kIHRoYXQgaGFzbid0IGJlZW4gcGFpZCBvdXQgeWV0' +
  'LCBhdCB0aGUKICAgICAgcGVyLWpvYiByYXRlIG9uIHRoZSBqb2IuIE5vdGhpbmcgZ2V0cyBjb3VudGVkIHR3aWNlLjwvcD4KICAg' +
  'ICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQi' +
  'PjxsYWJlbD5TZXJ2ZXI8L2xhYmVsPjxzZWxlY3QgaWQ9InNfc2VydmVyIj4KICAgICAgICAgICR7dXNlcnMuZmlsdGVyKHUgPT4g' +
  'dS5hY3RpdmUpLm1hcCh1ID0+IGA8b3B0aW9uIHZhbHVlPSIke3UuaWR9Ij4ke2VzYyh1Lm5hbWUpfTwvb3B0aW9uPmApLmpvaW4o' +
  'JycpfTwvc2VsZWN0PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9ImFsaWduLWl0ZW1zOmZsZXgtZW5kO2dh' +
  'cDo2cHgiPgogICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJmbGV4OjE7bWFyZ2luOjAiPjxsYWJlbD5Gcm9tPC9s' +
  'YWJlbD48aW5wdXQgdHlwZT0iZGF0ZSIgaWQ9InNfc3RhcnQiIHZhbHVlPSIke2ZpcnN0T2ZNb250aCgpfSI+PC9kaXY+CiAgICAg' +
  'ICAgICA8ZGl2IGNsYXNzPSJmaWVsZCIgc3R5bGU9ImZsZXg6MTttYXJnaW46MCI+PGxhYmVsPlRvPC9sYWJlbD48aW5wdXQgdHlw' +
  'ZT0iZGF0ZSIgaWQ9InNfZW5kIiB2YWx1ZT0iJHt0b2RheUlTTygpfSI+PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2' +
  'PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRu' +
  'IHNlYyBzbSIgaWQ9InNfcHJldiI+UHJldmlldzwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9InNf' +
  'bWFrZSI+Q3JlYXRlIHN0YXRlbWVudDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBpZD0ic19vdXQiPjwvZGl2Pgog' +
  'ICAgICAke3N0YXRlbWVudHMubGVuZ3RoID8gYDx0YWJsZSBjbGFzcz0idGJsIiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij4KICAg' +
  'ICAgICA8dHI+PHRoPlNlcnZlcjwvdGg+PHRoPlBlcmlvZDwvdGg+PHRoIGNsYXNzPSJudW0iPkpvYnM8L3RoPjx0aCBjbGFzcz0i' +
  'bnVtIj5Ub3RhbDwvdGg+PHRoPjwvdGg+PHRoPjwvdGg+PC90cj4KICAgICAgICAke3N0YXRlbWVudHMubWFwKHMgPT4gYDx0cj4K' +
  'ICAgICAgICAgIDx0ZD4ke2VzYyhzLnNlcnZlcl9uYW1lKX08L3RkPjx0ZD4ke2ZtdERhdGVPbmx5KHMucGVyaW9kX3N0YXJ0KX3i' +
  'gJMke2ZtdERhdGVPbmx5KHMucGVyaW9kX2VuZCl9PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke3Muam9iX2NvdW50' +
  'fTwvdGQ+PHRkIGNsYXNzPSJudW0iPiR7bW9uZXkocy50b3RhbCl9PC90ZD4KICAgICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icGls' +
  'bCAke2NscyhzLnN0YXR1cyl9Ij4ke2VzYyhzLnN0YXR1cyl9PC9zcGFuPjwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+' +
  'PGEgaHJlZj0iL3ByaW50L3N0YXRlbWVudC8ke3MuaWR9IiB0YXJnZXQ9Il9ibGFuayI+cHJpbnQ8L2E+CiAgICAgICAgICAgICR7' +
  'cy5zdGF0dXMgIT09ICdQYWlkJyA/IGAgwrcgPGEgaHJlZj0iIyIgZGF0YS1wYWlkPSIke3MuaWR9Ij5tYXJrIHBhaWQ8L2E+YCA6' +
  'ICcnfTwvdGQ+CiAgICAgICAgPC90cj5gKS5qb2luKCcnKX08L3RhYmxlPmAgOiAnJ30KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xh' +
  'c3M9ImNhcmQiPgogICAgICA8aDI+Q2xpZW50IGludm9pY2VzPC9oMj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAg' +
  'ICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5DbGllbnQ8L2xhYmVsPjxzZWxlY3QgaWQ9ImlfY2xpZW50Ij4KICAgICAgICAg' +
  'ICR7Y2xpZW50cy5maWx0ZXIoYyA9PiBjLmFjdGl2ZSkubWFwKGMgPT4gYDxvcHRpb24gdmFsdWU9IiR7Yy5pZH0iPiR7ZXNjKGMu' +
  'bmFtZSl9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0i' +
  'YWxpZ24taXRlbXM6ZmxleC1lbmQ7Z2FwOjZweCI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCIgc3R5bGU9ImZsZXg6MTtt' +
  'YXJnaW46MCI+PGxhYmVsPkZyb208L2xhYmVsPjxpbnB1dCB0eXBlPSJkYXRlIiBpZD0iaV9zdGFydCIgdmFsdWU9IiR7Zmlyc3RP' +
  'Zk1vbnRoKCl9Ij48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0iZmxleDoxO21hcmdpbjowIj48bGFi' +
  'ZWw+VG88L2xhYmVsPjxpbnB1dCB0eXBlPSJkYXRlIiBpZD0iaV9lbmQiIHZhbHVlPSIke3RvZGF5SVNPKCl9Ij48L2Rpdj4KICAg' +
  'ICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAg' +
  'ICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0iaV9wcmV2Ij5QcmV2aWV3PC9idXR0b24+CiAgICAgICAgPGJ1dHRv' +
  'biBjbGFzcz0iYnRuIHNtIiBpZD0iaV9tYWtlIj5DcmVhdGUgaW52b2ljZTwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRp' +
  'diBpZD0iaV9vdXQiPjwvZGl2PgogICAgICAke2ludm9pY2VzLmxlbmd0aCA/IGA8dGFibGUgY2xhc3M9InRibCIgc3R5bGU9Im1h' +
  'cmdpbi10b3A6MTRweCI+CiAgICAgICAgPHRyPjx0aD5DbGllbnQ8L3RoPjx0aD5QZXJpb2Q8L3RoPjx0aCBjbGFzcz0ibnVtIj5K' +
  'b2JzPC90aD48dGggY2xhc3M9Im51bSI+VG90YWw8L3RoPjx0aD48L3RoPjx0aD48L3RoPjwvdHI+CiAgICAgICAgJHtpbnZvaWNl' +
  'cy5tYXAocyA9PiBgPHRyPgogICAgICAgICAgPHRkPiR7ZXNjKHMuY2xpZW50X25hbWUpfTwvdGQ+PHRkPiR7Zm10RGF0ZU9ubHko' +
  'cy5wZXJpb2Rfc3RhcnQpfeKAkyR7Zm10RGF0ZU9ubHkocy5wZXJpb2RfZW5kKX08L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJu' +
  'dW0iPiR7cy5qb2JfY291bnR9PC90ZD48dGQgY2xhc3M9Im51bSI+JHttb25leShzLnRvdGFsKX08L3RkPgogICAgICAgICAgPHRk' +
  'PjxzcGFuIGNsYXNzPSJwaWxsICR7Y2xzKHMuc3RhdHVzKX0iPiR7ZXNjKHMuc3RhdHVzKX08L3NwYW4+PC90ZD4KICAgICAgICAg' +
  'IDx0ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIvcHJpbnQvaW52b2ljZS8ke3MuaWR9IiB0YXJnZXQ9Il9ibGFuayI+cHJpbnQ8L2E+' +
  'CiAgICAgICAgICAgICR7cy5zdGF0dXMgIT09ICdQYWlkJyA/IGAgwrcgPGEgaHJlZj0iIyIgZGF0YS1pcGFpZD0iJHtzLmlkfSI+' +
  'bWFyayBwYWlkPC9hPmAgOiAnJ308L3RkPgogICAgICAgIDwvdHI+YCkuam9pbignJyl9PC90YWJsZT5gIDogJyd9CiAgICA8L2Rp' +
  'dj5gKTsKICBiaW5kU2hlbGwoKTsKCiAgY29uc3QgbGluZXNUYWJsZSA9IChyLCBrZXkpID0+IHIubGluZXMubGVuZ3RoCiAgICA/' +
  'IGA8dGFibGUgY2xhc3M9InRibCIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+PHRyPjx0aD5EYXRlPC90aD48dGg+Sm9iPC90aD48' +
  'dGg+UmVjaXBpZW50PC90aD48dGggY2xhc3M9Im51bSI+JHtrZXkgPT09ICdwYXknID8gJ1BheScgOiAnRmVlJ308L3RoPjwvdHI+' +
  'CiAgICAgICAke3IubGluZXMubWFwKGwgPT4gYDx0cj48dGQ+JHtmbXREYXRlT25seShsLnNlcnZlZF9hdCl9PC90ZD48dGQ+JHtl' +
  'c2MobC5qb2JfbnVtYmVyKX08L3RkPgogICAgICAgPHRkPiR7ZXNjKGwucmVjaXBpZW50X25hbWUpfTwvdGQ+PHRkIGNsYXNzPSJu' +
  'dW0iPiR7bW9uZXkoa2V5ID09PSAncGF5JyA/IGwuc2VydmVyX3BheSA6IGwuY2xpZW50X2ZlZSl9PC90ZD48L3RyPmApLmpvaW4o' +
  'JycpfQogICAgICAgPHRyPjx0ZCBjb2xzcGFuPSIzIj48Yj4ke3IuY291bnR9IGpvYihzKTwvYj48L3RkPjx0ZCBjbGFzcz0ibnVt' +
  'Ij48Yj4ke21vbmV5KHIudG90YWwpfTwvYj48L3RkPjwvdHI+PC90YWJsZT5gCiAgICA6ICc8ZGl2IGNsYXNzPSJoaW50Ij5Ob3Ro' +
  'aW5nIHVuYmlsbGVkIGluIHRoYXQgd2luZG93LjwvZGl2Pic7CgogICQoJyNzX3ByZXYnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4g' +
  'ewogICAgY29uc3QgciA9IGF3YWl0IGFwaSgnL3N0YXRlbWVudHMvcHJldmlldycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpT' +
  'T04uc3RyaW5naWZ5KAogICAgICB7IHNlcnZlcl9pZDogJCgnI3Nfc2VydmVyJykudmFsdWUsIHN0YXJ0OiAkKCcjc19zdGFydCcp' +
  'LnZhbHVlLCBlbmQ6ICQoJyNzX2VuZCcpLnZhbHVlIH0pIH0pOwogICAgJCgnI3Nfb3V0JykuaW5uZXJIVE1MID0gbGluZXNUYWJs' +
  'ZShyLCAncGF5Jyk7CiAgfTsKICAkKCcjc19tYWtlJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGF3' +
  'YWl0IGFwaSgnL3N0YXRlbWVudHMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSgKICAgICAgICB7IHNl' +
  'cnZlcl9pZDogJCgnI3Nfc2VydmVyJykudmFsdWUsIHN0YXJ0OiAkKCcjc19zdGFydCcpLnZhbHVlLCBlbmQ6ICQoJyNzX2VuZCcp' +
  'LnZhbHVlIH0pIH0pOwogICAgICB0b2FzdCgnU3RhdGVtZW50IGNyZWF0ZWQnKTsgZ28oJ21vbmV5Jyk7CiAgICB9IGNhdGNoIChl' +
  'KSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9OwogICQoJyNpX3ByZXYnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewog' +
  'ICAgY29uc3QgciA9IGF3YWl0IGFwaSgnL2ludm9pY2VzL3ByZXZpZXcnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0' +
  'cmluZ2lmeSgKICAgICAgeyBjbGllbnRfaWQ6ICQoJyNpX2NsaWVudCcpLnZhbHVlLCBzdGFydDogJCgnI2lfc3RhcnQnKS52YWx1' +
  'ZSwgZW5kOiAkKCcjaV9lbmQnKS52YWx1ZSB9KSB9KTsKICAgICQoJyNpX291dCcpLmlubmVySFRNTCA9IGxpbmVzVGFibGUociwg' +
  'J2ZlZScpOwogIH07CiAgJCgnI2lfbWFrZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBhd2FpdCBh' +
  'cGkoJy9pbnZvaWNlcycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KAogICAgICAgIHsgY2xpZW50X2lk' +
  'OiAkKCcjaV9jbGllbnQnKS52YWx1ZSwgc3RhcnQ6ICQoJyNpX3N0YXJ0JykudmFsdWUsIGVuZDogJCgnI2lfZW5kJykudmFsdWUg' +
  'fSkgfSk7CiAgICAgIHRvYXN0KCdJbnZvaWNlIGNyZWF0ZWQnKTsgZ28oJ21vbmV5Jyk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0' +
  'KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9OwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBhaWRdJykuZm9yRWFj' +
  'aChhID0+IGEub25jbGljayA9IGFzeW5jIGUgPT4gewogICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgYXdhaXQgYXBpKCcvc3Rh' +
  'dGVtZW50cy8nICsgYS5kYXRhc2V0LnBhaWQsIHsgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHN0YXR1' +
  'czogJ1BhaWQnIH0pIH0pOwogICAgdG9hc3QoJ01hcmtlZCBwYWlkJyk7IGdvKCdtb25leScpOwogIH0pOwogIGRvY3VtZW50LnF1' +
  'ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWlwYWlkXScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sgPSBhc3luYyBlID0+IHsKICAgIGUu' +
  'cHJldmVudERlZmF1bHQoKTsKICAgIGF3YWl0IGFwaSgnL2ludm9pY2VzLycgKyBhLmRhdGFzZXQuaXBhaWQsIHsgbWV0aG9kOiAn' +
  'UEFUQ0gnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHN0YXR1czogJ1BhaWQnIH0pIH0pOwogICAgdG9hc3QoJ01hcmtlZCBwYWlk' +
  'Jyk7IGdvKCdtb25leScpOwogIH0pOwp9CgpmdW5jdGlvbiBmaXJzdE9mTW9udGgoKSB7CiAgY29uc3QgZCA9IG5ldyBEYXRlKCk7' +
  'IHJldHVybiBuZXcgRGF0ZShkLmdldEZ1bGxZZWFyKCksIGQuZ2V0TW9udGgoKSwgMSkudG9JU09TdHJpbmcoKS5zbGljZSgwLCAx' +
  'MCk7Cn0KCmFzeW5jIGZ1bmN0aW9uIG15UGF5VmlldygpIHsKICBjb25zdCBbc3RhdGVtZW50cywgc3RhdHNdID0gYXdhaXQgUHJv' +
  'bWlzZS5hbGwoW2FwaSgnL3N0YXRlbWVudHMnKSwgYXBpKCcvc3RhdHMnKV0pOwogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAg' +
  'ICA8aDEgY2xhc3M9InBhZ2UiPk15IHBheTwvaDE+CiAgICA8ZGl2IGNsYXNzPSJzdGF0cyI+CiAgICAgIDxkaXYgY2xhc3M9InN0' +
  'YXQgZ29vZCI+PGRpdiBjbGFzcz0ibiI+JHttb25leShzdGF0cy51bmJpbGxlZCl9PC9kaXY+PGRpdiBjbGFzcz0ibCI+RWFybmVk' +
  'LCBub3QgeWV0IG9uIGEgc3RhdGVtZW50PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxkaXYgY2xhc3M9Im4i' +
  'PiR7c3RhdHMuc2VydmVkXzdkfTwvZGl2PjxkaXYgY2xhc3M9ImwiPlNlcnZlcyBjb21wbGV0ZWQsIDcgZGF5czwvZGl2PjwvZGl2' +
  'PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj48aDI+U3RhdGVtZW50czwvaDI+CiAgICAke3N0YXRlbWVudHMubGVu' +
  'Z3RoID8gYDx0YWJsZSBjbGFzcz0idGJsIj4KICAgICAgPHRyPjx0aD5QZXJpb2Q8L3RoPjx0aCBjbGFzcz0ibnVtIj5Kb2JzPC90' +
  'aD48dGggY2xhc3M9Im51bSI+VG90YWw8L3RoPjx0aD48L3RoPjx0aD48L3RoPjwvdHI+CiAgICAgICR7c3RhdGVtZW50cy5tYXAo' +
  'cyA9PiBgPHRyPjx0ZD4ke2ZtdERhdGVPbmx5KHMucGVyaW9kX3N0YXJ0KX3igJMke2ZtdERhdGVPbmx5KHMucGVyaW9kX2VuZCl9' +
  'PC90ZD4KICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHtzLmpvYl9jb3VudH08L3RkPjx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KHMu' +
  'dG90YWwpfTwvdGQ+CiAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJwaWxsICR7Y2xzKHMuc3RhdHVzKX0iPiR7ZXNjKHMuc3RhdHVz' +
  'KX08L3NwYW4+PC90ZD4KICAgICAgICA8dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iL3ByaW50L3N0YXRlbWVudC8ke3MuaWR9IiB0' +
  'YXJnZXQ9Il9ibGFuayI+cHJpbnQ8L2E+PC90ZD48L3RyPmApLmpvaW4oJycpfQogICAgICA8L3RhYmxlPmAgOiAnPGRpdiBjbGFz' +
  'cz0iZW1wdHkiPk5vIHN0YXRlbWVudHMgeWV0LjwvZGl2Pid9CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImNhcmQiPjxoMj5D' +
  'aGFuZ2UgcGFzc3dvcmQ8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJoaW50Ij5UaGlzIGlzIHlvdXIgb25lIHBhc3N3b3JkIGZvciBl' +
  'dmVyeSBhcHAuPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48aW5wdXQgaWQ9Im9wdyIgdHlwZT0icGFzc3dvcmQiIHBs' +
  'YWNlaG9sZGVyPSJDdXJyZW50IHBhc3N3b3JkIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxpbnB1dCBpZD0ibnB3' +
  'IiB0eXBlPSJwYXNzd29yZCIgcGxhY2Vob2xkZXI9Ik5ldyBwYXNzd29yZCAoOCsgY2hhcmFjdGVycykiPjwvZGl2PgogICAgICA8' +
  'YnV0dG9uIGNsYXNzPSJidG4gc20iIGlkPSJzYXZlUHciPlVwZGF0ZTwvYnV0dG9uPjwvZGl2PmApOwogIGJpbmRTaGVsbCgpOwog' +
  'ICQoJyNzYXZlUHcnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAgICAgY29uc3QgciA9IGF3YWl0IGFwaSgn' +
  'L21lL3Bhc3N3b3JkJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHBhc3N3b3JkOiAk' +
  'KCcjbnB3JykudmFsdWUsIG9sZF9wYXNzd29yZDogJCgnI29wdycpLnZhbHVlIH0pIH0pOwogICAgICAkKCcjb3B3JykudmFsdWUg' +
  'PSAnJzsgJCgnI25wdycpLnZhbHVlID0gJyc7CiAgICAgIHRvYXN0KHIuZXZlcnl3aGVyZSA9PT0gZmFsc2UgPyAnQ2hhbmdlZCBo' +
  'ZXJlIOKAlCBvdGhlciBhcHBzIHN0aWxsIGhhdmUgdGhlIG9sZCBvbmUnIDogJ1Bhc3N3b3JkIHVwZGF0ZWQgZXZlcnl3aGVyZScp' +
  'OwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKfQoKCmZ1bmN0aW9uIGNvZGVzVGFibGUo' +
  'bGlzdCkgewogIGlmICghbGlzdC5sZW5ndGgpIHJldHVybiAnPGRpdiBjbGFzcz0iaGludCI+Tm8gY29kZXMgeWV0LjwvZGl2Pic7' +
  'CiAgcmV0dXJuIGA8dGFibGUgY2xhc3M9InRibCI+CiAgICA8dHI+PHRoPkNvZGU8L3RoPjx0aD5HcmFudHM8L3RoPjx0aD5Vc2Vk' +
  'PC90aD48dGg+PC90aD48dGg+PC90aD48L3RyPgogICAgJHtsaXN0Lm1hcChjID0+IGA8dHI+CiAgICAgIDx0ZD48c3BhbiBzdHls' +
  'ZT0iZm9udDo2MDAgMTNweCBtb25vc3BhY2U7bGV0dGVyLXNwYWNpbmc6LjVweCI+JHtlc2MoYy5jb2RlKX08L3NwYW4+CiAgICAg' +
  'ICAgJHtjLm5vdGUgPyBgPGRpdiBjbGFzcz0iaGludCI+JHtlc2MoYy5ub3RlKX08L2Rpdj5gIDogJyd9CiAgICAgICAgJHtjLnJl' +
  'ZGVtcHRpb25zICYmIGMucmVkZW1wdGlvbnMubGVuZ3RoID8gYDxkaXYgY2xhc3M9ImhpbnQiPiR7Yy5yZWRlbXB0aW9ucy5tYXAo' +
  'ciA9PiBlc2Moci5lbWFpbCkpLmpvaW4oJywgJyl9PC9kaXY+YCA6ICcnfTwvdGQ+CiAgICAgIDx0ZD4ke2Mucm9sZSA9PT0gJ2Fk' +
  'bWluJyA/ICdBZG1pbicgOiAnRmllbGQgc2VydmVyJ30KICAgICAgICAke2MuZXhwaXJlc19hdCA/IGA8ZGl2IGNsYXNzPSJoaW50' +
  'Ij50byAke2ZtdERhdGVPbmx5KGMuZXhwaXJlc19hdCl9PC9kaXY+YCA6ICcnfTwvdGQ+CiAgICAgIDx0ZD4ke2MudXNlZF9jb3Vu' +
  'dH0vJHtjLm1heF91c2VzfTwvdGQ+CiAgICAgIDx0ZD48c3BhbiBjbGFzcz0icGlsbCAke2Muc3RhdGUgPT09ICdBY3RpdmUnID8g' +
  'J1NlcnZlZCcgOiAnJ30iPiR7ZXNjKGMuc3RhdGUpfTwvc3Bhbj48L3RkPgogICAgICA8dGQgY2xhc3M9Im51bSI+CiAgICAgICAg' +
  'PGEgaHJlZj0iIyIgZGF0YS1jb3B5PSIke2VzYyhjLmNvZGUpfSI+Y29weTwvYT4KICAgICAgICAke2Muc3RhdGUgPT09ICdBY3Rp' +
  'dmUnID8gYCDCtyA8YSBocmVmPSIjIiBkYXRhLXJldm9rZT0iJHtjLmlkfSI+cmV2b2tlPC9hPmAgOiAnJ30KICAgICAgPC90ZD48' +
  'L3RyPmApLmpvaW4oJycpfTwvdGFibGU+YDsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0gYWRtaW4gLS0gKi8KYXN5bmMgZnVuY3Rpb24gYWRtaW5WaWV3KCkgewogIC8vIEZldGNoIGV2' +
  'ZXJ5dGhpbmcgYmVmb3JlIGRyYXdpbmcuIFBvcHVsYXRpbmcgY2FyZHMgYWZ0ZXIgcmVuZGVyIG1hZGUgdGhlCiAgLy8gcGFnZSBn' +
  'cm93IHVuZGVyIHRoZSB1c2VyJ3MgZmluZ2VyLCBzbyBhIHRhcCBjb3VsZCBsYW5kIG9uIHRoZSB3cm9uZyByb3cuCiAgY29uc3Qg' +
  'W3VzZXJzLCBjbGllbnRzLCB0ZW1wbGF0ZXMsIGNvZGVzLCBwb3J0YWxzLCBjb21wYW5pZXNdID0gYXdhaXQgUHJvbWlzZS5hbGwo' +
  'WwogICAgYXBpKCcvdXNlcnMnKSwgYXBpKCcvY2xpZW50cycpLCBhcGkoJy90ZW1wbGF0ZXMnKSwKICAgIGFwaSgnL2NvZGVzJyku' +
  'Y2F0Y2goKCkgPT4gW10pLCBhcGkoJy9wb3J0YWxzJykuY2F0Y2goKCkgPT4gW10pLAogICAgYXBpKCcvY29tcGFuaWVzJykuY2F0' +
  'Y2goKCkgPT4gW10pCiAgXSk7CiAgY29uc3QgaGVyZSA9IGNvbXBhbmllcy5maW5kKGMgPT4gUy5tZS5jb21wYW55ICYmIGMuaWQg' +
  'PT09IFMubWUuY29tcGFueS5pZCkgfHwgY29tcGFuaWVzWzBdIHx8IHt9OwogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8' +
  'aDEgY2xhc3M9InBhZ2UiPlNldHVwPC9oMT4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPiR7aXNPd25lcigpID8g' +
  'J1RoaXMgY29tcGFueScgOiAnWW91ciBjb21wYW55J30KICAgICAgICA8c3BhbiBjbGFzcz0ic3ViIj4ke2VzYyhoZXJlLnBsYW4g' +
  'PT09ICdwcm8nID8gJ1BybycgOiAnRnJlZScpfSR7CiAgICAgICAgICBoZXJlLnBsYW5fZXhwaXJlcyA/ICcgdW50aWwgJyArIGZt' +
  'dERhdGVPbmx5KGhlcmUucGxhbl9leHBpcmVzKSA6ICcnfTwvc3Bhbj48L2gyPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxh' +
  'YmVsPk5hbWU8L2xhYmVsPjxpbnB1dCBpZD0iY29OYW1lIiB2YWx1ZT0iJHtlc2MoaGVyZS5uYW1lIHx8ICcnKX0iPjwvZGl2Pgog' +
  'ICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNvbnRhY3QgZW1haWw8L2xhYmVsPjxpbnB1dCBpZD0iY29FbWFpbCIgdmFs' +
  'dWU9IiR7ZXNjKGhlcmUuY29udGFjdF9lbWFpbCB8fCAnJyl9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJl' +
  'bD5QaG9uZTwvbGFiZWw+PGlucHV0IGlkPSJjb1Bob25lIiB2YWx1ZT0iJHtlc2MoaGVyZS5waG9uZSB8fCAnJyl9Ij48L2Rpdj4K' +
  'ICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0iY29TYXZlIj5TYXZlPC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9Imhp' +
  'bnQiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+VGhpcyBuYW1lIGFwcGVhcnMgb24geW91ciBpbnZvaWNlcyBhbmQgcGF5IHN0YXRl' +
  'bWVudHMuPC9kaXY+CiAgICA8L2Rpdj4KCiAgICAke2lzT3duZXIoKSA/IGA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkFs' +
  'bCBjb21wYW5pZXMgPHNwYW4gY2xhc3M9InN1YiI+JHtjb21wYW5pZXMubGVuZ3RofTwvc3Bhbj48L2gyPgogICAgICA8dGFibGUg' +
  'Y2xhc3M9InRibCI+CiAgICAgICAgPHRyPjx0aD5Db21wYW55PC90aD48dGggY2xhc3M9Im51bSI+UGVvcGxlPC90aD48dGggY2xh' +
  'c3M9Im51bSI+T3BlbjwvdGg+PHRoPjwvdGg+PC90cj4KICAgICAgICAke2NvbXBhbmllcy5tYXAoYyA9PiBgPHRyPgogICAgICAg' +
  'ICAgPHRkPiR7ZXNjKGMubmFtZSl9JHtTLm1lLmNvbXBhbnkgJiYgYy5pZCA9PT0gUy5tZS5jb21wYW55LmlkID8gJyA8c3BhbiBj' +
  'bGFzcz0icGlsbCI+eW91IGFyZSBoZXJlPC9zcGFuPicgOiAnJ30KICAgICAgICAgICAgPGRpdiBjbGFzcz0iaGludCI+JHtlc2Mo' +
  'Yy5hZG1pbl9lbWFpbCB8fCAnbm8gYWRtaW4geWV0Jyl9IMK3ICR7Yy5wbGFuID09PSAncHJvJyA/ICdQcm8nIDogJ0ZyZWUnfTwv' +
  'ZGl2PjwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHtjLnBlb3BsZSA/PyAn4oCUJ308L3RkPgogICAgICAgICAgPHRk' +
  'IGNsYXNzPSJudW0iPiR7Yy5vcGVuX2pvYnMgPz8gJ+KAlCd9PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke1MubWUu' +
  'Y29tcGFueSAmJiBjLmlkID09PSBTLm1lLmNvbXBhbnkuaWQKICAgICAgICAgICAgPyAnJyA6IGA8YSBocmVmPSIjIiBkYXRhLWVu' +
  'dGVyPSIke2MuaWR9Ij5lbnRlcjwvYT5gfTwvdGQ+PC90cj5gKS5qb2luKCcnKX0KICAgICAgPC90YWJsZT4KICAgICAgPGRpdiBj' +
  'bGFzcz0iZmllbGQiIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPjxsYWJlbD5TdGFydCBhbm90aGVyIGNvbXBhbnk8L2xhYmVsPgog' +
  'ICAgICAgIDxpbnB1dCBpZD0ibmV3Q29OYW1lIiBwbGFjZWhvbGRlcj0iQ29tcGFueSBuYW1lIj48L2Rpdj4KICAgICAgPGJ1dHRv' +
  'biBjbGFzcz0iYnRuIHNtIiBpZD0ibmV3Q28iPkNyZWF0ZSBjb21wYW55PC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQi' +
  'IHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+Q3JlYXRpbmcgYSBjb21wYW55IGdpdmVzIGl0IGl0cyBvd24gam9icywgY2xpZW50cyBh' +
  'bmQKICAgICAgICBiaWxsaW5nLiBBZGQgaXRzIGFkbWluaXN0cmF0b3IgZnJvbSBpbnNpZGUgaXQsIG9yIGhhbmQgdGhlbSBhbiBh' +
  'Y2Nlc3MgY29kZS48L2Rpdj4KICAgIDwvZGl2PmAgOiAnJ30KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPlRlYW0g' +
  'PHNwYW4gY2xhc3M9InN1YiI+JHt1c2Vycy5sZW5ndGh9PC9zcGFuPjwvaDI+CiAgICAgIDx0YWJsZSBjbGFzcz0idGJsIj4KICAg' +
  'ICAgICA8dHI+PHRoPk5hbWU8L3RoPjx0aD5Sb2xlPC90aD48dGggY2xhc3M9Im51bSI+UmF0ZTwvdGg+PHRoPjwvdGg+PC90cj4K' +
  'ICAgICAgICAke3VzZXJzLm1hcCh1ID0+IGA8dHI+PHRkPiR7ZXNjKHUubmFtZSl9PGRpdiBjbGFzcz0iaGludCI+JHtlc2ModS5l' +
  'bWFpbCl9PC9kaXY+PC90ZD4KICAgICAgICAgIDx0ZD4ke2VzYyh1LnJvbGUpfSR7dS5hY3RpdmUgPyAnJyA6ICcgPHNwYW4gY2xh' +
  'c3M9InBpbGwiPm9mZjwvc3Bhbj4nfTwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHttb25leSh1LmRlZmF1bHRfcGF5' +
  'KX08L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPjxhIGhyZWY9IiMiIGRhdGEtdXNlcj0iJHt1LmlkfSI+ZWRpdDwvYT48' +
  'L3RkPjwvdHI+YCkuam9pbignJyl9CiAgICAgIDwvdGFibGU+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgYmxvY2sgc20i' +
  'IGlkPSJuZXdVc2VyIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4rIEFkZCBwZXJzb248L2J1dHRvbj4KICAgIDwvZGl2PgoKICAg' +
  'IDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+Q2xpZW50cyA8c3BhbiBjbGFzcz0ic3ViIj4ke2NsaWVudHMubGVuZ3RofTwv' +
  'c3Bhbj48L2gyPgogICAgICA8dGFibGUgY2xhc3M9InRibCI+CiAgICAgICAgPHRyPjx0aD5OYW1lPC90aD48dGggY2xhc3M9Im51' +
  'bSI+RGVmYXVsdCBmZWU8L3RoPjx0aD48L3RoPjwvdHI+CiAgICAgICAgJHtjbGllbnRzLm1hcChjID0+IGA8dHI+PHRkPiR7ZXNj' +
  'KGMubmFtZSl9PGRpdiBjbGFzcz0iaGludCI+JHtlc2MoYy5jb250YWN0X25hbWUgfHwgJycpfSAke2VzYyhjLnBob25lIHx8ICcn' +
  'KX08L2Rpdj48L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPiR7bW9uZXkoYy5kZWZhdWx0X2ZlZSl9PC90ZD4KICAgICAg' +
  'ICAgIDx0ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIjIiBkYXRhLWNsaWVudD0iJHtjLmlkfSI+ZWRpdDwvYT48L3RkPjwvdHI+YCku' +
  'am9pbignJyl9CiAgICAgIDwvdGFibGU+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgYmxvY2sgc20iIGlkPSJuZXdDbGll' +
  'bnQiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPisgQWRkIGNsaWVudDwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFz' +
  'cz0iY2FyZCI+CiAgICAgIDxoMj5BZmZpZGF2aXQgdGVtcGxhdGVzIDxzcGFuIGNsYXNzPSJzdWIiPiR7dGVtcGxhdGVzLmxlbmd0' +
  'aH08L3NwYW4+PC9oMj4KICAgICAgPHAgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOi00cHgiPldyaXRlIHlvdXIgb3du' +
  'IHdvcmRpbmcgcGVyIGNvdW50eSBvciBjbGllbnQuIE1lcmdlIGZpZWxkcyBmaWxsIGluIGZyb20gdGhlIGpvYiwKICAgICAgaW5j' +
  'bHVkaW5nIHRoZSBmdWxsIGF0dGVtcHQgbG9nIHdpdGggR1BTLjwvcD4KICAgICAgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgICAg' +
  'ICR7dGVtcGxhdGVzLm1hcCh0ID0+IGA8dHI+PHRkPiR7ZXNjKHQubmFtZSl9PGRpdiBjbGFzcz0iaGludCI+JHtlc2ModC5qdXJp' +
  'c2RpY3Rpb24gfHwgJycpfTwvZGl2PjwvdGQ+CiAgICAgICAgICA8dGQ+JHt0LmlzX2RlZmF1bHQgPyAnPHNwYW4gY2xhc3M9InBp' +
  'bGwgU2VydmVkIj5kZWZhdWx0PC9zcGFuPicgOiAnJ308L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPjxhIGhyZWY9IiMi' +
  'IGRhdGEtdHBsPSIke3QuaWR9Ij5lZGl0PC9hPjwvdGQ+PC90cj5gKS5qb2luKCcnKX0KICAgICAgPC90YWJsZT4KICAgICAgPGJ1' +
  'dHRvbiBjbGFzcz0iYnRuIHNlYyBibG9jayBzbSIgaWQ9Im5ld1RwbCIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+KyBOZXcgdGVt' +
  'cGxhdGU8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+QWNjZXNzIGNvZGVzIDxz' +
  'cGFuIGNsYXNzPSJzdWIiPmxldCBwZW9wbGUgc2V0IHVwIHRoZWlyIG93biBhY2NvdW50PC9zcGFuPjwvaDI+CiAgICAgIDxwIGNs' +
  'YXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDotNHB4Ij5HZW5lcmF0ZSBhIGNvZGUgYW5kIHNlbmQgaXQgb3Zlci4gVGhleSBl' +
  'bnRlciBpdCBvbiB0aGUgc2lnbi1pbgogICAgICAgIHNjcmVlbiB1bmRlciAiU2V0IHVwIHlvdXIgYWNjb3VudCIsIHBpY2sgdGhl' +
  'aXIgb3duIHBhc3N3b3JkLCBhbmQgdGhleSdyZSBpbiDigJQgbm8gbmVlZCB0byBrZXkgaW4KICAgICAgICB0aGVpciBkZXRhaWxz' +
  'IG9yIHNoYXJlIGEgcGFzc3dvcmQgd2l0aCB0aGVtLjwvcD4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMyIgc3R5bGU9Im1hcmdp' +
  'bi10b3A6MTBweCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5UaGV5IGJlY29tZTwvbGFiZWw+PHNlbGVjdCBp' +
  'ZD0iY19yb2xlIj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InNlcnZlciI+RmllbGQgc2VydmVyPC9vcHRpb24+PG9wdGlvbiB2' +
  'YWx1ZT0iYWRtaW4iPkFkbWluPC9vcHRpb24+PC9zZWxlY3Q+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJl' +
  'bD5Ib3cgbWFueSBjYW4gdXNlIGl0PC9sYWJlbD48aW5wdXQgaWQ9ImNfdXNlcyIgdHlwZT0ibnVtYmVyIiBtaW49IjEiIG1heD0i' +
  'NTAwIiB2YWx1ZT0iMSI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5FeHBpcmVzIChvcHRpb25hbCk8' +
  'L2xhYmVsPjxpbnB1dCBpZD0iY19leHAiIHR5cGU9ImRhdGUiPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0i' +
  'Z3JpZCBnMiI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5QYXkgcGVyIHNlcnZlIChmaWVsZCBzZXJ2ZXJzKTwv' +
  'bGFiZWw+PGlucHV0IGlkPSJjX3BheSIgdHlwZT0ibnVtYmVyIiBzdGVwPSIwLjAxIiBwbGFjZWhvbGRlcj0iNDUuMDAiPjwvZGl2' +
  'PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Tm90ZSB0byB5b3Vyc2VsZjwvbGFiZWw+PGlucHV0IGlkPSJjX25v' +
  'dGUiIHBsYWNlaG9sZGVyPSJGb3IgTWFyaWEg4oCUIGV2aWN0aW9ucyI+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8YnV0dG9u' +
  'IGNsYXNzPSJidG4gc20iIGlkPSJjX21ha2UiPkdlbmVyYXRlIGEgY29kZTwvYnV0dG9uPgogICAgICA8ZGl2IGlkPSJjX2xpc3Qi' +
  'IHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPiR7Y29kZXNUYWJsZShjb2Rlcyl9PC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNs' +
  'YXNzPSJjYXJkIj4KICAgICAgPGgyPkNvdXJ0IHBvcnRhbCBwcm9iZSA8c3BhbiBjbGFzcz0ic3ViIj5leHBlcmltZW50YWw8L3Nw' +
  'YW4+PC9oMj4KICAgICAgPHAgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOi00cHgiPkFza3MgdGhlIHNlcnZlciB0byBm' +
  'ZXRjaCBhIGNvdW50eSBwb3J0YWwgYW5kIHJlcG9ydCB3aGF0IGNhbWUgYmFjayDigJQKICAgICAgICBzdGF0dXMsIGNvb2tpZXMs' +
  'IGZvcm1zLCBsaW5rcy4gVGhpcyBpcyB0aGUgZ3JvdW5kd29yayBmb3IgYXV0b21hdGljIGNhc2UgbG9va3VwOiB0aGVzZSBwb3J0' +
  'YWxzIGNhbid0IGJlCiAgICAgICAgcmVhY2hlZCBmcm9tIHdoZXJlIHRoaXMgYXBwIHdhcyB3cml0dGVuLCBzbyB0aGUgc2VydmVy' +
  'IGhhcyB0byBnbyBhbmQgbG9vay4gUnVuIG9uZSBhbmQgc2VuZCBtZSB0aGUgcmVzdWx0LjwvcD4KICAgICAgPGRpdiBjbGFzcz0i' +
  'cm93IiBpZD0icHJvYmVCdG5zIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4ke3BvcnRhbHMubWFwKHB0ID0+CiAgICAgICAgYDxi' +
  'dXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGRhdGEtcHJvYmU9IiR7ZXNjKHB0LmtleSl9Ij4ke2VzYyhwdC5sYWJlbCl9PC9idXR0' +
  'b24+YCkuam9pbignJyl9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICAg' +
  'ICAgPGlucHV0IGlkPSJwcm9iZVVybCIgcGxhY2Vob2xkZXI9IuKApm9yIGEgc3BlY2lmaWMgcGFnZSBVUkwiIHN0eWxlPSJmbGV4' +
  'OjE7bWluLXdpZHRoOjE1MHB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0icHJvYmVHbyI+UHJvYmUg' +
  'VVJMPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8cHJlIGNsYXNzPSJwcmV2IiBpZD0icHJvYmVPdXQiIHN0eWxlPSJkaXNw' +
  'bGF5Om5vbmU7bWFyZ2luLXRvcDoxMHB4Ij48L3ByZT4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSBibG9jayIgaWQ9' +
  'ImNvcHlQcm9iZSIgc3R5bGU9ImRpc3BsYXk6bm9uZTttYXJnaW4tdG9wOjhweCI+Q29weSByZXN1bHQ8L2J1dHRvbj4KICAgIDwv' +
  'ZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+TXkgYWNjb3VudDwvaDI+CiAgICAgIDxkaXYgY2xhc3M9Imhp' +
  'bnQiPk9uZSBwYXNzd29yZCwgZXZlcnkgYXBwLiBDaGFuZ2luZyBpdCBoZXJlIGNoYW5nZXMgaXQgZXZlcnl3aGVyZS48L2Rpdj4K' +
  'ICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5DdXJyZW50IHBhc3N3b3JkPC9sYWJlbD48aW5wdXQgaWQ9Im9wdyIgdHlw' +
  'ZT0icGFzc3dvcmQiIHBsYWNlaG9sZGVyPSJ0aGUgb25lIHlvdSBzaWduZWQgaW4gd2l0aCI+PC9kaXY+CiAgICAgIDxkaXYgY2xh' +
  'c3M9ImZpZWxkIj48bGFiZWw+TmV3IHBhc3N3b3JkPC9sYWJlbD48aW5wdXQgaWQ9Im5wdyIgdHlwZT0icGFzc3dvcmQiIHBsYWNl' +
  'aG9sZGVyPSI4KyBjaGFyYWN0ZXJzIj48L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0ic2F2ZVB3Ij5VcGRh' +
  'dGUgcGFzc3dvcmQ8L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgaWQ9ImJ1aWxkU3RhbXAiIHN0eWxlPSJtYXJnaW4t' +
  'dG9wOjEycHgiPmJ1aWxkIOKApjwvZGl2PgogICAgPC9kaXY+YCk7CiAgYmluZFNoZWxsKCk7CgogIGZldGNoKCcvYXBpL2J1aWxk' +
  'JykudGhlbihyID0+IHIuanNvbigpKS50aGVuKGIgPT4gewogICAgY29uc3QgZWwgPSAkKCcjYnVpbGRTdGFtcCcpOwogICAgaWYg' +
  'KGVsKSBlbC50ZXh0Q29udGVudCA9ICdTZXJ2ZVRyYWNrIGJ1aWxkICcgKyBiLmJ1aWxkICsgKGIucHJvYmVUYXJnZXRzID8gJyDC' +
  'tyBib290IHByb2JlIGFybWVkJyA6ICcnKTsKICB9KS5jYXRjaCgoKSA9PiB7fSk7CgoKICAvKiAtLS0tIGFjY2VzcyBjb2RlcyAt' +
  'LS0tICovCiAgYXN5bmMgZnVuY3Rpb24gZHJhd0NvZGVzKCkgewogICAgJCgnI2NfbGlzdCcpLmlubmVySFRNTCA9IGNvZGVzVGFi' +
  'bGUoYXdhaXQgYXBpKCcvY29kZXMnKSk7CiAgICB3aXJlQ29kZXMoKTsKICB9CgogIGZ1bmN0aW9uIHdpcmVDb2RlcygpIHsKICAg' +
  'IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWNvcHldJykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGFzeW5jIGUg' +
  'PT4gewogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgIHRyeSB7IGF3YWl0IG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVU' +
  'ZXh0KGEuZGF0YXNldC5jb3B5KTsgdG9hc3QoJ0NvcGllZCAnICsgYS5kYXRhc2V0LmNvcHkpOyB9CiAgICAgIGNhdGNoIChlcnIp' +
  'IHsgdG9hc3QoJ1NlbGVjdCBpdCBhbmQgY29weSBieSBoYW5kJywgdHJ1ZSk7IH0KICAgIH0pOwogICAgZG9jdW1lbnQucXVlcnlT' +
  'ZWxlY3RvckFsbCgnW2RhdGEtcmV2b2tlXScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sgPSBhc3luYyBlID0+IHsKICAgICAgZS5w' +
  'cmV2ZW50RGVmYXVsdCgpOwogICAgICBpZiAoIWNvbmZpcm0oJ1Jldm9rZSB0aGlzIGNvZGU/IEFueW9uZSB3aG8gYWxyZWFkeSB1' +
  'c2VkIGl0IGtlZXBzIHRoZWlyIGFjY291bnQuJykpIHJldHVybjsKICAgICAgYXdhaXQgYXBpKCcvY29kZXMvJyArIGEuZGF0YXNl' +
  'dC5yZXZva2UsIHsgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHJldm9rZWQ6IHRydWUgfSkgfSk7CiAg' +
  'ICAgIHRvYXN0KCdSZXZva2VkJyk7IGRyYXdDb2RlcygpOwogICAgfSk7CiAgfQogIHdpcmVDb2RlcygpOwoKICAkKCcjY19tYWtl' +
  'Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IG1hZGUgPSBhd2FpdCBhcGkoJy9jb2Rlcycs' +
  'IHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsKICAgICAgICByb2xlOiAkKCcjY19yb2xlJykudmFsdWUs' +
  'CiAgICAgICAgbWF4X3VzZXM6ICQoJyNjX3VzZXMnKS52YWx1ZSwKICAgICAgICBleHBpcmVzX2F0OiAkKCcjY19leHAnKS52YWx1' +
  'ZSB8fCBudWxsLAogICAgICAgIGRlZmF1bHRfcGF5OiAkKCcjY19wYXknKS52YWx1ZSB8fCAwLAogICAgICAgIG5vdGU6ICQoJyNj' +
  'X25vdGUnKS52YWx1ZQogICAgICB9KSB9KTsKICAgICAgJCgnI2Nfbm90ZScpLnZhbHVlID0gJyc7CiAgICAgIHRvYXN0KCdDb2Rl' +
  'ICcgKyBtYWRlLmNvZGUpOwogICAgICBkcmF3Q29kZXMoKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVl' +
  'KTsgfQogIH07CiAgZHJhd0NvZGVzKCkuY2F0Y2goKCkgPT4ge30pOwoKICAvKiAtLS0tIHBvcnRhbCBwcm9iZSAtLS0tICovCiAg' +
  'Y29uc3QgcHJvYmVPdXQgPSAkKCcjcHJvYmVPdXQnKTsKICBjb25zdCBydW5Qcm9iZSA9IGFzeW5jIGJvZHkgPT4gewogICAgcHJv' +
  'YmVPdXQuc3R5bGUuZGlzcGxheSA9ICcnOwogICAgcHJvYmVPdXQudGV4dENvbnRlbnQgPSAnUHJvYmluZ+KApiAodGhpcyBjYW4g' +
  'dGFrZSB1cCB0byAyMCBzZWNvbmRzKSc7CiAgICAkKCcjY29weVByb2JlJykuc3R5bGUuZGlzcGxheSA9ICcnOwogICAgdHJ5IHsK' +
  'ICAgICAgY29uc3QgciA9IGF3YWl0IGFwaSgnL3BvcnRhbC1wcm9iZScsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3Ry' +
  'aW5naWZ5KGJvZHkpIH0pOwogICAgICBwcm9iZU91dC50ZXh0Q29udGVudCA9IEpTT04uc3RyaW5naWZ5KHIsIG51bGwsIDIpOwog' +
  'ICAgfSBjYXRjaCAoZSkgewogICAgICBwcm9iZU91dC50ZXh0Q29udGVudCA9ICdQcm9iZSBmYWlsZWQ6ICcgKyBlLm1lc3NhZ2U7' +
  'CiAgICB9CiAgfTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1wcm9iZV0nKS5mb3JFYWNoKGIgPT4KICAgIGIu' +
  'b25jbGljayA9ICgpID0+IHJ1blByb2JlKHsgcG9ydGFsOiBiLmRhdGFzZXQucHJvYmUgfSkpOwogICQoJyNwcm9iZUdvJykub25j' +
  'bGljayA9ICgpID0+IHsKICAgIGNvbnN0IHUgPSAkKCcjcHJvYmVVcmwnKS52YWx1ZS50cmltKCk7CiAgICBpZiAodSkgcnVuUHJv' +
  'YmUoeyB1cmw6IHUgfSk7CiAgfTsKICAkKCcjY29weVByb2JlJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7IGF3' +
  'YWl0IG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KHByb2JlT3V0LnRleHRDb250ZW50KTsgdG9hc3QoJ0NvcGllZCcpOyB9' +
  'CiAgICBjYXRjaCAoZSkgeyB0b2FzdCgnU2VsZWN0IHRoZSB0ZXh0IGFuZCBjb3B5IGl0IGJ5IGhhbmQnLCB0cnVlKTsgfQogIH07' +
  'CgogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXVzZXJdJykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGUgPT4g' +
  'ewogICAgZS5wcmV2ZW50RGVmYXVsdCgpOyB1c2VyRm9ybSh1c2Vycy5maW5kKHUgPT4gU3RyaW5nKHUuaWQpID09PSBhLmRhdGFz' +
  'ZXQudXNlcikpOwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWNsaWVudF0nKS5mb3JFYWNoKGEgPT4g' +
  'YS5vbmNsaWNrID0gZSA9PiB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7IGNsaWVudEZvcm0oY2xpZW50cy5maW5kKGMgPT4gU3Ry' +
  'aW5nKGMuaWQpID09PSBhLmRhdGFzZXQuY2xpZW50KSk7CiAgfSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEt' +
  'dHBsXScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sgPSBlID0+IHsKICAgIGUucHJldmVudERlZmF1bHQoKTsgdGVtcGxhdGVGb3Jt' +
  'KHRlbXBsYXRlcy5maW5kKHQgPT4gU3RyaW5nKHQuaWQpID09PSBhLmRhdGFzZXQudHBsKSk7CiAgfSk7CiAgY29uc3QgY29TYXZl' +
  'ID0gJCgnI2NvU2F2ZScpOwogIGlmIChjb1NhdmUpIGNvU2F2ZS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAg' +
  'ICAgYXdhaXQgYXBpKCcvY29tcGFuaWVzLycgKyAoaGVyZS5pZCksIHsgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBKU09OLnN0cmlu' +
  'Z2lmeSh7CiAgICAgICAgbmFtZTogJCgnI2NvTmFtZScpLnZhbHVlLCBjb250YWN0X2VtYWlsOiAkKCcjY29FbWFpbCcpLnZhbHVl' +
  'LCBwaG9uZTogJCgnI2NvUGhvbmUnKS52YWx1ZSB9KSB9KTsKICAgICAgUy5tZSA9IGF3YWl0IGFwaSgnL21lJyk7CiAgICAgIHRv' +
  'YXN0KCdDb21wYW55IHNhdmVkJyk7CiAgICAgIHJlbmRlcigpOwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRy' +
  'dWUpOyB9CiAgfTsKICBjb25zdCBuZXdDbyA9ICQoJyNuZXdDbycpOwogIGlmIChuZXdDbykgbmV3Q28ub25jbGljayA9IGFzeW5j' +
  'ICgpID0+IHsKICAgIGNvbnN0IG5hbWUgPSAkKCcjbmV3Q29OYW1lJykudmFsdWUudHJpbSgpOwogICAgaWYgKCFuYW1lKSByZXR1' +
  'cm4gdG9hc3QoJ0dpdmUgdGhlIGNvbXBhbnkgYSBuYW1lJywgdHJ1ZSk7CiAgICB0cnkgewogICAgICBhd2FpdCBhcGkoJy9jb21w' +
  'YW5pZXMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IG5hbWUgfSkgfSk7CiAgICAgIFMubWUgPSBh' +
  'd2FpdCBhcGkoJy9tZScpOwogICAgICB0b2FzdChuYW1lICsgJyBjcmVhdGVkJyk7CiAgICAgIHJlbmRlcigpOwogICAgfSBjYXRj' +
  'aCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1l' +
  'bnRlcl0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNrID0gYXN5bmMgZSA9PiB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICB0' +
  'cnkgewogICAgICBjb25zdCBvdXQgPSBhd2FpdCBhcGkoJy9jb21wYW5pZXMvJyArIGEuZGF0YXNldC5lbnRlciArICcvZW50ZXIn' +
  'LCB7IG1ldGhvZDogJ1BPU1QnIH0pOwogICAgICBTLm1lID0gYXdhaXQgYXBpKCcvbWUnKTsKICAgICAgdG9hc3QoJ05vdyBpbiAn' +
  'ICsgb3V0LmNvbXBhbnkubmFtZSk7CiAgICAgIHJlbmRlcigpOwogICAgfSBjYXRjaCAoZXJyKSB7IHRvYXN0KGVyci5tZXNzYWdl' +
  'LCB0cnVlKTsgfQogIH0pOwogICQoJyNuZXdVc2VyJykub25jbGljayA9ICgpID0+IHVzZXJGb3JtKG51bGwpOwogICQoJyNuZXdD' +
  'bGllbnQnKS5vbmNsaWNrID0gKCkgPT4gY2xpZW50Rm9ybShudWxsKTsKICAkKCcjbmV3VHBsJykub25jbGljayA9ICgpID0+IHRl' +
  'bXBsYXRlRm9ybShudWxsKTsKICAkKCcjc2F2ZVB3Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGNv' +
  'bnN0IHIgPSBhd2FpdCBhcGkoJy9tZS9wYXNzd29yZCcsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsK' +
  'ICAgICAgICBwYXNzd29yZDogJCgnI25wdycpLnZhbHVlLCBvbGRfcGFzc3dvcmQ6ICQoJyNvcHcnKS52YWx1ZSB9KSB9KTsKICAg' +
  'ICAgJCgnI29wdycpLnZhbHVlID0gJyc7ICQoJyNucHcnKS52YWx1ZSA9ICcnOwogICAgICB0b2FzdChyLmV2ZXJ5d2hlcmUgPT09' +
  'IGZhbHNlID8gJ0NoYW5nZWQgaGVyZSDigJQgb3RoZXIgYXBwcyBzdGlsbCBoYXZlIHRoZSBvbGQgb25lJyA6ICdQYXNzd29yZCB1' +
  'cGRhdGVkIGV2ZXJ5d2hlcmUnKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07Cn0KCmZ1' +
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
  'ICdhZG1pbicgPyAnc2VsZWN0ZWQnIDogJyd9PkFkbWluPC9vcHRpb24+CiAgICAgICAgJHtpc093bmVyKCkgPyBgPG9wdGlvbiB2' +
  'YWx1ZT0ib3duZXIiICR7di5yb2xlID09PSAnb3duZXInID8gJ3NlbGVjdGVkJyA6ICcnfT5Pd25lciAoZXZlcnkgY29tcGFueSk8' +
  'L29wdGlvbj5gIDogJyd9CiAgICAgIDwvc2VsZWN0PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkRlZmF1' +
  'bHQgcGF5IHBlciBzZXJ2ZTwvbGFiZWw+PGlucHV0IGlkPSJ1X2RlZmF1bHRfcGF5IiB0eXBlPSJudW1iZXIiIHN0ZXA9IjAuMDEi' +
  'IHZhbHVlPSIke3YuZGVmYXVsdF9wYXkgfHwgJyd9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5QaG9u' +
  'ZTwvbGFiZWw+PGlucHV0IGlkPSJ1X3Bob25lIiB2YWx1ZT0iJHtlc2Modi5waG9uZSl9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFz' +
  'cz0iZmllbGQiPjxsYWJlbD5MaWNlbnNlIC8gcmVnaXN0cmF0aW9uICM8L2xhYmVsPjxpbnB1dCBpZD0idV9saWNlbnNlX25vIiB2' +
  'YWx1ZT0iJHtlc2Modi5saWNlbnNlX25vKX0iPjwvZGl2PgogICAgPC9kaXY+CiAgICAke3UgPyBgPGRpdiBjbGFzcz0iZmllbGQi' +
  'PjxsYWJlbD5TdGF0dXM8L2xhYmVsPjxzZWxlY3QgaWQ9InVfYWN0aXZlIj4KICAgICAgPG9wdGlvbiB2YWx1ZT0idHJ1ZSIgJHt2' +
  'LmFjdGl2ZSA/ICdzZWxlY3RlZCcgOiAnJ30+QWN0aXZlPC9vcHRpb24+CiAgICAgIDxvcHRpb24gdmFsdWU9ImZhbHNlIiAkeyF2' +
  'LmFjdGl2ZSA/ICdzZWxlY3RlZCcgOiAnJ30+RGVhY3RpdmF0ZWQ8L29wdGlvbj48L3NlbGVjdD48L2Rpdj5gIDogJyd9CiAgICA8' +
  'ZGl2IGNsYXNzPSJyb3ciPjxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InNhdmUiPlNhdmU8L2J1dHRvbj4KICAgIDxidXR0b24gY2xh' +
  'c3M9ImJ0biBzZWMiIG9uY2xpY2s9ImNsb3NlU2hlZXQoKSI+Q2FuY2VsPC9idXR0b24+PC9kaXY+YCwgZWwgPT4gewogICAgZWwu' +
  'cXVlcnlTZWxlY3RvcignI3NhdmUnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBib2R5ID0gewogICAgICAg' +
  'IG5hbWU6IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X25hbWUnKS52YWx1ZSwgZW1haWw6IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X2VtYWls' +
  'JykudmFsdWUsCiAgICAgICAgcm9sZTogZWwucXVlcnlTZWxlY3RvcignI3Vfcm9sZScpLnZhbHVlLCBwaG9uZTogZWwucXVlcnlT' +
  'ZWxlY3RvcignI3VfcGhvbmUnKS52YWx1ZSwKICAgICAgICBsaWNlbnNlX25vOiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9saWNlbnNl' +
  'X25vJykudmFsdWUsCiAgICAgICAgZGVmYXVsdF9wYXk6IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X2RlZmF1bHRfcGF5JykudmFsdWUg' +
  'fHwgMAogICAgICB9OwogICAgICBjb25zdCBwdyA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X3Bhc3N3b3JkJykudmFsdWU7CiAgICAg' +
  'IGlmIChwdykgYm9keS5wYXNzd29yZCA9IHB3OwogICAgICBpZiAodSkgYm9keS5hY3RpdmUgPSBlbC5xdWVyeVNlbGVjdG9yKCcj' +
  'dV9hY3RpdmUnKS52YWx1ZSA9PT0gJ3RydWUnOwogICAgICB0cnkgewogICAgICAgIGF3YWl0ICh1ID8gYXBpKCcvdXNlcnMvJyAr' +
  'IHUuaWQsIHsgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KQogICAgICAgICAgICAgICAgIDog' +
  'YXBpKCcvdXNlcnMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KSk7CiAgICAgICAgY2xv' +
  'c2VTaGVldCgpOyB0b2FzdCgnU2F2ZWQnKTsgZ28oJ2FkbWluJyk7CiAgICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdl' +
  'LCB0cnVlKTsgfQogICAgfTsKICB9KTsKfQoKZnVuY3Rpb24gY2xpZW50Rm9ybShjKSB7CiAgY29uc3QgdiA9IGMgfHwge307CiAg' +
  'c2hlZXQoYyA/ICdFZGl0ICcgKyBjLm5hbWUgOiAnQWRkIGNsaWVudCcsIGAKICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+' +
  'RmlybSAvIGNsaWVudCBuYW1lPC9sYWJlbD48aW5wdXQgaWQ9ImNfbmFtZSIgdmFsdWU9IiR7ZXNjKHYubmFtZSl9Ij48L2Rpdj4K' +
  'ICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNvbnRhY3Q8L2xhYmVsPjxp' +
  'bnB1dCBpZD0iY19jb250YWN0X25hbWUiIHZhbHVlPSIke2VzYyh2LmNvbnRhY3RfbmFtZSl9Ij48L2Rpdj4KICAgICAgPGRpdiBj' +
  'bGFzcz0iZmllbGQiPjxsYWJlbD5QaG9uZTwvbGFiZWw+PGlucHV0IGlkPSJjX3Bob25lIiB2YWx1ZT0iJHtlc2Modi5waG9uZSl9' +
  'Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5FbWFpbDwvbGFiZWw+PGlucHV0IGlkPSJjX2VtYWlsIiB0' +
  'eXBlPSJlbWFpbCIgdmFsdWU9IiR7ZXNjKHYuZW1haWwpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+' +
  'RGVmYXVsdCBmZWUgcGVyIHNlcnZlPC9sYWJlbD48aW5wdXQgaWQ9ImNfZGVmYXVsdF9mZWUiIHR5cGU9Im51bWJlciIgc3RlcD0i' +
  'MC4wMSIgdmFsdWU9IiR7di5kZWZhdWx0X2ZlZSB8fCAnJ30iPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVs' +
  'ZCI+PGxhYmVsPkJpbGxpbmcgYWRkcmVzczwvbGFiZWw+PHRleHRhcmVhIGlkPSJjX2FkZHJlc3MiIHN0eWxlPSJtaW4taGVpZ2h0' +
  'OjYwcHgiPiR7ZXNjKHYuYWRkcmVzcyl9PC90ZXh0YXJlYT48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Tm90' +
  'ZXM8L2xhYmVsPjx0ZXh0YXJlYSBpZD0iY19ub3RlcyIgc3R5bGU9Im1pbi1oZWlnaHQ6NjBweCI+JHtlc2Modi5ub3Rlcyl9PC90' +
  'ZXh0YXJlYT48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InJvdyI+PGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0ic2F2ZSI+U2F2ZTwvYnV0' +
  'dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5DYW5jZWw8L2J1dHRvbj48L2Rp' +
  'dj5gLCBlbCA9PiB7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNv' +
  'bnN0IGJvZHkgPSB7fTsKICAgICAgWyduYW1lJywnY29udGFjdF9uYW1lJywncGhvbmUnLCdlbWFpbCcsJ2RlZmF1bHRfZmVlJywn' +
  'YWRkcmVzcycsJ25vdGVzJ10KICAgICAgICAuZm9yRWFjaChmID0+IGJvZHlbZl0gPSBlbC5xdWVyeVNlbGVjdG9yKCcjY18nICsg' +
  'ZikudmFsdWUpOwogICAgICB0cnkgewogICAgICAgIGF3YWl0IChjID8gYXBpKCcvY2xpZW50cy8nICsgYy5pZCwgeyBtZXRob2Q6' +
  'ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pCiAgICAgICAgICAgICAgICAgOiBhcGkoJy9jbGllbnRzJywg' +
  'eyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSkpOwogICAgICAgIGNsb3NlU2hlZXQoKTsgdG9h' +
  'c3QoJ1NhdmVkJyk7IGdvKCdhZG1pbicpOwogICAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICAg' +
  'IH07CiAgfSk7Cn0KCmFzeW5jIGZ1bmN0aW9uIHRlbXBsYXRlRm9ybSh0KSB7CiAgY29uc3QgZmllbGRzID0gYXdhaXQgYXBpKCcv' +
  'dGVtcGxhdGUtZmllbGRzJyk7CiAgY29uc3QgdiA9IHQgfHwgeyBib2R5OiAnJywgaXNfZGVmYXVsdDogZmFsc2UgfTsKICBzaGVl' +
  'dCh0ID8gJ0VkaXQgdGVtcGxhdGUnIDogJ05ldyBhZmZpZGF2aXQgdGVtcGxhdGUnLCBgCiAgICA8ZGl2IGNsYXNzPSJncmlkIGcy' +
  'Ij4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5UZW1wbGF0ZSBuYW1lPC9sYWJlbD48aW5wdXQgaWQ9InRfbmFtZSIg' +
  'dmFsdWU9IiR7ZXNjKHYubmFtZSl9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5KdXJpc2RpY3Rpb24g' +
  'LyBjb3VydDwvbGFiZWw+PGlucHV0IGlkPSJ0X2p1cmlzZGljdGlvbiIgdmFsdWU9IiR7ZXNjKHYuanVyaXNkaWN0aW9uKX0iPjwv' +
  'ZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkJvZHk8L2xhYmVsPgogICAgICA8dGV4dGFyZWEg' +
  'aWQ9InRfYm9keSIgc3R5bGU9Im1pbi1oZWlnaHQ6MjIwcHg7Zm9udDoxMi41cHgvMS41ICdDb3VyaWVyIE5ldycsbW9ub3NwYWNl' +
  'Ij4ke2VzYyh2LmJvZHkpfTwvdGV4dGFyZWE+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPkNsaWNrIGEgZmllbGQgdG8gaW5zZXJ0' +
  'IGl0IGF0IHRoZSBjdXJzb3I6PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InRva2VucyI+JHtmaWVsZHMubWFwKGYgPT4gYDxidXR0' +
  'b24gZGF0YS1mPSIke2ZbMF19IiB0aXRsZT0iJHtlc2MoZlsxXSl9Ij57eyR7ZlswXX19fTwvYnV0dG9uPmApLmpvaW4oJycpfTwv' +
  'ZGl2PgogICAgPC9kaXY+CiAgICA8bGFiZWwgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweCI+' +
  'PGlucHV0IHR5cGU9ImNoZWNrYm94IiBpZD0idF9kZWZhdWx0IiBzdHlsZT0id2lkdGg6YXV0byIgJHt2LmlzX2RlZmF1bHQgPyAn' +
  'Y2hlY2tlZCcgOiAnJ30+IFVzZSBhcyB0aGUgZGVmYXVsdCB0ZW1wbGF0ZTwvbGFiZWw+CiAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0' +
  'eWxlPSJtYXJnaW4tdG9wOjEycHgiPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJzYXZlIj5TYXZlPC9idXR0b24+CiAg' +
  'ICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIGlkPSJwcmV2aWV3Ij5QcmV2aWV3IHdpdGggcmVhbCBqb2I8L2J1dHRvbj4KICAg' +
  'ICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5DYW5jZWw8L2J1dHRvbj4KICAgICAgJHt0' +
  'ID8gJzxidXR0b24gY2xhc3M9ImJ0biBnaG9zdCIgaWQ9ImRlbCIgc3R5bGU9ImNvbG9yOnZhcigtLWJhZCk7bWFyZ2luLWxlZnQ6' +
  'YXV0byI+RGVsZXRlPC9idXR0b24+JyA6ICcnfQogICAgPC9kaXY+CiAgICA8cHJlIGNsYXNzPSJwcmV2IiBpZD0idHByZXYiIHN0' +
  'eWxlPSJkaXNwbGF5Om5vbmU7bWFyZ2luLXRvcDoxMnB4Ij48L3ByZT5gLCBlbCA9PiB7CiAgICBjb25zdCB0YSA9IGVsLnF1ZXJ5' +
  'U2VsZWN0b3IoJyN0X2JvZHknKTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWZdJykuZm9yRWFjaChiID0+IGIub25j' +
  'bGljayA9ICgpID0+IHsKICAgICAgY29uc3QgdG9rID0gJ3t7JyArIGIuZGF0YXNldC5mICsgJ319JzsKICAgICAgY29uc3QgcyA9' +
  'IHRhLnNlbGVjdGlvblN0YXJ0LCBlID0gdGEuc2VsZWN0aW9uRW5kOwogICAgICB0YS52YWx1ZSA9IHRhLnZhbHVlLnNsaWNlKDAs' +
  'IHMpICsgdG9rICsgdGEudmFsdWUuc2xpY2UoZSk7CiAgICAgIHRhLmZvY3VzKCk7IHRhLnNlbGVjdGlvblN0YXJ0ID0gdGEuc2Vs' +
  'ZWN0aW9uRW5kID0gcyArIHRvay5sZW5ndGg7CiAgICB9KTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNwcmV2aWV3Jykub25jbGlj' +
  'ayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgciA9IGF3YWl0IGFwaSgnL3RlbXBsYXRlcy9wcmV2aWV3JywgeyBtZXRob2Q6' +
  'ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBib2R5OiB0YS52YWx1ZSB9KSB9KTsKICAgICAgY29uc3QgcCA9IGVsLnF1' +
  'ZXJ5U2VsZWN0b3IoJyN0cHJldicpOwogICAgICBwLnN0eWxlLmRpc3BsYXkgPSAnJzsgcC50ZXh0Q29udGVudCA9IHIudGV4dDsK' +
  'ICAgIH07CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IGJv' +
  'ZHkgPSB7CiAgICAgICAgbmFtZTogZWwucXVlcnlTZWxlY3RvcignI3RfbmFtZScpLnZhbHVlLCBqdXJpc2RpY3Rpb246IGVsLnF1' +
  'ZXJ5U2VsZWN0b3IoJyN0X2p1cmlzZGljdGlvbicpLnZhbHVlLAogICAgICAgIGJvZHk6IHRhLnZhbHVlLCBpc19kZWZhdWx0OiBl' +
  'bC5xdWVyeVNlbGVjdG9yKCcjdF9kZWZhdWx0JykuY2hlY2tlZAogICAgICB9OwogICAgICBpZiAoIWJvZHkubmFtZS50cmltKCkp' +
  'IHJldHVybiB0b2FzdCgnR2l2ZSB0aGUgdGVtcGxhdGUgYSBuYW1lJywgdHJ1ZSk7CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQg' +
  'KHQgPyBhcGkoJy90ZW1wbGF0ZXMvJyArIHQuaWQsIHsgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5' +
  'KSB9KQogICAgICAgICAgICAgICAgIDogYXBpKCcvdGVtcGxhdGVzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJp' +
  'bmdpZnkoYm9keSkgfSkpOwogICAgICAgIGNsb3NlU2hlZXQoKTsgdG9hc3QoJ1NhdmVkJyk7IGdvKCdhZG1pbicpOwogICAgICB9' +
  'IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICAgIH07CiAgICBpZiAoZWwucXVlcnlTZWxlY3RvcignI2Rl' +
  'bCcpKSBlbC5xdWVyeVNlbGVjdG9yKCcjZGVsJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgaWYgKCFjb25maXJtKCdE' +
  'ZWxldGUgdGhpcyB0ZW1wbGF0ZT8nKSkgcmV0dXJuOwogICAgICBhd2FpdCBhcGkoJy90ZW1wbGF0ZXMvJyArIHQuaWQsIHsgbWV0' +
  'aG9kOiAnREVMRVRFJyB9KTsKICAgICAgY2xvc2VTaGVldCgpOyB0b2FzdCgnRGVsZXRlZCcpOyBnbygnYWRtaW4nKTsKICAgIH07' +
  'CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LSBib290IC0tICovCmNvbnN0IFZJRVdTID0geyBkYXNoOiBkYXNoVmlldywgam9iczogam9ic1ZpZXcsIGpvYjogam9iVmlldywg' +
  'c2Nhbjogc2NhblZpZXcsCiAgdG9vbHM6IHRvb2xzVmlldywgcHJvcGVydHk6IHByb3BlcnR5VmlldywgbW9uZXk6IG1vbmV5Vmll' +
  'dywgYWRtaW46IGFkbWluVmlldyB9OwoKYXN5bmMgZnVuY3Rpb24gcmVuZGVyKCkgewogIGNsb3NlU2hlZXQoKTsKICBpZiAoIVMu' +
  'bWUpIHJldHVybiBsb2dpblZpZXcoKTsKICBpZiAoUy52aWV3ID09PSAnam9icycpIFMuY2FjaGUuam9iRmlsdGVyID0gUy5wYXJh' +
  'bXM7CiAgY29uc3QgZm4gPSBWSUVXU1tTLnZpZXddIHx8IGRhc2hWaWV3OwogIHRyeSB7CiAgICBhcHAuaW5uZXJIVE1MID0gJzxk' +
  'aXYgY2xhc3M9IndyYXAiPjxkaXYgY2xhc3M9ImVtcHR5Ij5Mb2FkaW5n4oCmPC9kaXY+PC9kaXY+JzsKICAgIGF3YWl0IGZuKCk7' +
  'CiAgfSBjYXRjaCAoZSkgewogICAgaWYgKFMubWUpIHsgYXBwLmlubmVySFRNTCA9IHNoZWxsKGA8ZGl2IGNsYXNzPSJjYXJkIj48' +
  'ZGl2IGNsYXNzPSJlbXB0eSI+JHtlc2MoZS5tZXNzYWdlKX08L2Rpdj48L2Rpdj5gKTsgYmluZFNoZWxsKCk7IH0KICB9Cn0KCihh' +
  'c3luYyBmdW5jdGlvbiBib290KCkgewogIHRyeSB7IFMubWUgPSBhd2FpdCBhcGkoJy9tZScpOyB9IGNhdGNoIChlKSB7IFMubWUg' +
  'PSBudWxsOyB9CiAgcmVuZGVyKCk7Cn0pKCk7Cn0pKCk7CgovKiAtLS0tIGluc3RhbGxhYmxlIGFwcCAtLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tCiAgIEEgc2VydmljZSB3b3JrZXIgcGx1cyBhIG1hbmlmZXN0' +
  'IGlzIHRoZSB3aG9sZSBkaWZmZXJlbmNlIGJldHdlZW4gYSB3ZWIgcGFnZQogICBhbmQgc29tZXRoaW5nIHRoYXQgbGl2ZXMgb24g' +
  'dGhlIGhvbWUgc2NyZWVuIHdpdGggaXRzIG93biBpY29uIGFuZCBubyBicm93c2VyCiAgIGJhcnMuIE5vIHN0b3JlLCBubyByZXZp' +
  'ZXcsIG5vIGRldmVsb3BlciBhY2NvdW50LgoKICAgVGhlIGJhciB3YWl0cyBhIGNvdXBsZSBvZiBzZWNvbmRzIHNvIGl0IG5ldmVy' +
  'IGxhbmRzIG9uIHRvcCBvZiB3aGF0IHNvbWVvbmUKICAgaXMgcmVhZGluZywgYW5kIG9uY2UgZGlzbWlzc2VkIGl0IHN0YXlzIGRp' +
  'c21pc3NlZCBvbiB0aGF0IGRldmljZS4gICAgICAgICAgKi8KKGZ1bmN0aW9uICgpIHsKICBpZiAoJ3NlcnZpY2VXb3JrZXInIGlu' +
  'IG5hdmlnYXRvcikgewogICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ2xvYWQnLCBmdW5jdGlvbiAoKSB7CiAgICAgIG5hdmln' +
  'YXRvci5zZXJ2aWNlV29ya2VyLnJlZ2lzdGVyKCcvc3cuanMnKS5jYXRjaChmdW5jdGlvbiAoKSB7fSk7CiAgICB9KTsKICB9CiAg' +
  'dmFyIHN0YW5kYWxvbmUgPSB3aW5kb3cubWF0Y2hNZWRpYSgnKGRpc3BsYXktbW9kZTogc3RhbmRhbG9uZSknKS5tYXRjaGVzCiAg' +
  'ICAgICAgICAgICAgICB8fCB3aW5kb3cubmF2aWdhdG9yLnN0YW5kYWxvbmUgPT09IHRydWU7CiAgaWYgKHN0YW5kYWxvbmUpIHJl' +
  'dHVybjsKCiAgdmFyIEtFWSA9ICdzdF9hMmhzJzsKICB0cnkgeyBpZiAobG9jYWxTdG9yYWdlLmdldEl0ZW0oS0VZKSA9PT0gJzEn' +
  'KSByZXR1cm47IH0gY2F0Y2ggKGUpIHt9CgogIHZhciBpb3MgPSAvaXBob25lfGlwYWR8aXBvZC9pLnRlc3QobmF2aWdhdG9yLnVz' +
  'ZXJBZ2VudCk7CiAgdmFyIGJhciA9IG51bGwsIGRlZmVycmVkID0gbnVsbDsKCiAgZnVuY3Rpb24gYnVpbGQoaHRtbCkgewogICAg' +
  'YmFyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICBiYXIuaWQgPSAnYTJocyc7CiAgICBiYXIuaW5uZXJIVE1M' +
  'ID0gJzxpbWcgY2xhc3M9ImFpIiBzcmM9Ii9pY29uLTE5Mi5wbmciIGFsdD0iIj4nICsgaHRtbCArCiAgICAgICc8YnV0dG9uIGNs' +
  'YXNzPSJ4IiBhcmlhLWxhYmVsPSJEaXNtaXNzIj4mdGltZXM7PC9idXR0b24+JzsKICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hp' +
  'bGQoYmFyKTsKICAgIGJhci5xdWVyeVNlbGVjdG9yKCcueCcpLm9uY2xpY2sgPSBmdW5jdGlvbiAoKSB7CiAgICAgIGJhci5jbGFz' +
  'c0xpc3QucmVtb3ZlKCdvbicpOwogICAgICB0cnkgeyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShLRVksICcxJyk7IH0gY2F0Y2ggKGUp' +
  'IHt9CiAgICB9OwogICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7IGJhci5jbGFzc0xpc3QuYWRkKCdvbicpOyB9LCAyNjAwKTsK' +
  'ICB9CgogIGlmIChpb3MpIHsKICAgIGJ1aWxkKCc8ZGl2IGNsYXNzPSJhdCI+PGI+UHV0IFNlcnZlVHJhY2sgb24geW91ciBob21l' +
  'IHNjcmVlbjwvYj4nICsKICAgICAgICAgICdUYXAgU2hhcmUsIHRoZW4gPGIgc3R5bGU9ImRpc3BsYXk6aW5saW5lIj5BZGQgdG8g' +
  'SG9tZSBTY3JlZW48L2I+LjwvZGl2PicpOwogIH0gZWxzZSB7CiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignYmVmb3JlaW5z' +
  'dGFsbHByb21wdCcsIGZ1bmN0aW9uIChldikgewogICAgICBldi5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBkZWZlcnJlZCA9IGV2' +
  'OwogICAgICBpZiAoYmFyKSByZXR1cm47CiAgICAgIGJ1aWxkKCc8ZGl2IGNsYXNzPSJhdCI+PGI+SW5zdGFsbCBTZXJ2ZVRyYWNr' +
  'PC9iPlJ1bnMgZnVsbCBzY3JlZW4sIG9wZW5zIHN0cmFpZ2h0IHRvIHlvdXIgd29yay48L2Rpdj4nICsKICAgICAgICAgICAgJzxi' +
  'dXR0b24gaWQ9ImEyaHNHbyI+SW5zdGFsbDwvYnV0dG9uPicpOwogICAgICB2YXIgZ28gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJ' +
  'ZCgnYTJoc0dvJyk7CiAgICAgIGlmIChnbykgZ28ub25jbGljayA9IGZ1bmN0aW9uICgpIHsKICAgICAgICBiYXIuY2xhc3NMaXN0' +
  'LnJlbW92ZSgnb24nKTsKICAgICAgICBkZWZlcnJlZC5wcm9tcHQoKTsKICAgICAgICBkZWZlcnJlZCA9IG51bGw7CiAgICAgICAg' +
  'dHJ5IHsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oS0VZLCAnMScpOyB9IGNhdGNoIChlKSB7fQogICAgICB9OwogICAgfSk7CiAgfQp9' +
  'KSgpOwoKPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo='
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
const BUILD = '2026-08-31.22';           // shown in Setup so uploads can be confirmed
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

/* ------------------------------------------------------- installable --- */
/* This app ships as one file, so the three things a browser needs before it
   will offer to install something — a manifest, a service worker, and icons —
   are served from here rather than sitting on disk. The icons are the real PNG
   bytes, carried inline so there is nothing else to deploy. */

const ICONS = {
  '/icon-192.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAEmElEQVR42u3dPU4bURiF4ZkRRSR+qrRp6CIBG2ARsAsalkPjXcAisgFASkeTNpUBKR2pSBGBwfadnzvneesIO3fO+517GY9pm4mxe3b30mC2PN8ct1N6P62wI1mKVuiRLEMr+EgWoRV8JIvQCj6SRWgFH8kidMKPmiidsVbwkdwGnfAjuQ064UeyBJ3wI1mCTviRLEEn/EiWoBN+JEvQCT+SJeiEH8kSdMKPZAk6y4RkOtMfyS3QCT+SJbAFgi2Q6Y/UFtAA0ACmP1JbQANAA5j+SG0BDQANYPojtQU0ADQAEC2A7Q9St0EaABoAIABAACCL1gEYGgAIZSfxP/10fVTl+/7560/z/duXXl9j7/zeFkjwpytA0zS9S5AkQif89YpgvQgQezFJQID4i0gCAsRPMBIQIJ4hJCCA6R8twVzXUwOQQAOABAQACQgAEhAAJCAASEAAkIAAIAEBQAICgAQEAAkIABIQACQgAEhAAJCAACABAUACAoAEBAAJCAASEAAkIABIQACQgAAgwXTYcWnrYYivRU9DA4AAAAEAAgAEAAgAEAAgAEAAgAAAAVAVjxcHFoEA2eF/vDggAgFAAgLEh10bEMCk1wYEsM3RBgRAfBt4ImwFP+5+V/V+T64Ot5Zgf7HUAMgK/ytp4SfATMIPAkRj+hNA+IWfABB+AhTg9PhrzPR3BkCVEtj6lMF9gAolKHHjSvg1AECA2jD9CSD8wk8AgACmv+lPAOEXfgJA+Alg+oMAwm/6E0D4hZ8AAAFMf6zCh+FWMMajkSU+5Xl7+dCcunwaoLbwe/8EiA5PqelPAgJUR+nwgwDCDwIABFiTtx6F7OsB9D6nfy0P9xNg4hK8hrS0BMI/Pu4DfCDB/zelTq4Oi91keuypraABygR0xV9Z6etnr4O7vQQYPPwlAiz8BKg6/CWDLPwEqDL8Q/17EGCy4R+jMUx/Akwq/EOcGYSfAJMOv+0NAaqm5GR9SwLTnwCxEgg/ATQBCEAC058AgRIIPwFIIPyTxadBV3B7+TDaH6Lb9nlenxLVAEUCOMajhiVe0wPxBCgWniElKPlaJCDAJIMJApCAZASYKqsOkH2FtI+f6yBMgKokEP7h8WvQTUO0WBb7uMP+YunLbDVAfZS4WeWGFwFiJRB+AmgCECBRAtIQIFKC/cVS+AkwbwneC7jgTw+/BnUu0AAAAQACzIe983tX13pqACBWAC1gHeMbgATWL34LRALrFn8GIIH1eot29+zuJe3iPl0fSbhBkSsA8G8L9Hxz3FoGJPJ8c9y6D4DsBrAEIABAACBUAAdhJB6ANQA0gCUAAWyDELj90QDQAO+ZAcx9+msAaICPDAHmOv01ADTAZ00B5jb9NQA0wLrGAHOZ/h82AAkw5/DbAsEWaFuDgFqn/6cbgASYY/jX2gKRAHML/9pnABJgTuHf6BBMAswl/BsJQALMJfwbC0ACzCH8WwlAAtQe/q0FIAFqDn/TNE3R8PqiXdQS/GINoA1Qa/iLN4A2QC3B710AIqCGXcVgWxYiYIrb6cH37ETAlM6Rox5ayYAxQj8ZAUgh7GPzFzNVQKy7L4VtAAAAAElFTkSuQmCC', 'base64'),
  '/icon-512.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAAN4ElEQVR42u3cPU5bWxuG4e0tF5ESqGjTpIsUZwIMgsyCJsNJwyzCIJhAHOl0adJSQZBOx6kiIQ4/Bm97r/U+11V+0qeDN5jnXssoi4EmvT1Z33oKQAU356uFp9Ae3xQDDyAQBADGHkAUCAAMPoAgEAAYfABBIACMPgBiQAAYfQDEgAAw+gCIAQFg+AEQAgLA6AMgBgSA4QdACAgAww+AEBAAhh8AISAADD8AQkAAGH4AhMBLjcYfAPK2Y+GbBwB5twHlXpThB0AIPK/URwDGHwAbE3QDYPgBcBsQdgNg/AGwPWEBYPwBsEGvs/DQAWA7PX4k0N0NgPEHwDaFBYDxB8BGTWPhoQLAtHr4SKD5GwDjD4DbgLAAMP4AiICwADD+AIiAsAAw/gCIgLAAMP4AiICwADD+AIiAsAAw/gCIgLAAMP4AiICwADD+AIiAsAAw/gCIgLAAMP4AiID5tnBMe8EAIAJmCADjDwDzb+NY/QUCgAiYMQCMPwC0s5VjtRcEACKgoRsAAKAdOw8Ap38AaG87x95fAACIgIYCwPgDQLtb6m8AACDQTgLA6R8A2t7UsZcvFABEQKMBYPwBoI8I8DcAABBosgBw+geAfm4Bxta+IABg95vrIwAACLR1ADj9A0B/twBuAADADYDTPwAk3AKMc/2HAYD5IsBHAAAQ6FUB4PQPAH3fArgBAAA3AE7/AJBwC+AGAADcADj9A0DCLYAbAABwA+D0DwAJtwBuAADADYDTPwAk3AK4AQAANwAAgAAYXP8DQG822W43AADgBsDpHwASbgHcAACAGwAAIDoAXP8DQN+e2nI3AADgBgAAiA0A1/8AUMNjm+4GAADcAAAAkQHg+h8Aanlo290AAIAbAABAAAAA9QPA5/8AUNP9jXcDAADpNwAAgAAAAKoHgM//AaC2u1vvBgAAkm8AAAABAAAIAACgXAD4A0AAyPB3890AAEDqDQAAIAAAAAEAAAgAAEAAAAACAADowMK/AUBL/nz/5CEE+Of3v8PH928iX/u7Lz/9ACAAwODnBsAwDLERIAYQABh+ogNABIgBBACGn9AAEAFCgHn4I0CMP80FgfcJuAHALzSCBt9NgNsA3ABg/BEG3j/ePwgA/PJCBHgfgQDALy1EgPcTCAD8skIEeF+BAMAvKUSA9xcIAEAEAAIApxNEgPcZCAD8UkIEeL8hAABEAAgAcBpBBHjfIQAARAAIAHAKQQR4/yEAAEQACAAAEQACAEAEgACgAp8/IgK8DxEAACIABACACAABACACQAAAiAAQAAAiAAQAgAgAAQAgAkAAAIgAEAAAIgAEAIAIAAEAIAJAAACIABAAgAjwEBAAACIABACACAABACACQAAAiAAQAAAiAAQAgAgAAQAgAkAAAIgAEAAAIgAEAIAIAAEAIAJAAACIABAAACIABACACAABACACQAAAiAAQAAAiAAEAgAhAAAAgAhAAAIgABAAAIgABAIAIQAAAIAIQAAAiAAQAgAgAAQAgAkAAAIgAEAAAIgAEAIAIAAEAIAJAAACIABAAACIABACACAABACACEAAAiAAEAAAiAAEAgAhAAAAgAhAAAIgABAAAIgABAIAIQAAAIAIQAACIAAQAACIAAQCACEAAACACEAAAIgAEAIAIgBdZegTAvn18/8ZDADcAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAEAAAAACAAAQAACAAAAo5vr00ENAAAAkjr8IQAAABMeAEEAAAISc/jf930EAABQdf7cBCACA0PF3G4AAAMBtAAIAIOn07zYAAQAQPv4iAAEAICSEAAIAIOX07zYAAQAQPv5uAxAAAKHj7zYAAQCA2wAEAEDS6d9tAAIAIHz8RQACAECECAEEAEDq6VsEIAAAQsfWbQACACD4pC0CEAAAwaEiBJjb0iMg0cX60kMo5vO3D12GwMHZlW8eAgAMPynjPwyD8WdWPgLA+AMIADD+OP07/SMAwPhj/I0/AgDA+Bt/BAA4/QMIAACnf6d/BACA8Tf+CAAAQAAAOP2DAAAw/iAAYCLHqyMPwfgbfxAAAIAAwC0ATv9O/wgAEAEYf+OPAAARACAAoEoECAGnf6d/GIalR4DbAFpzfXpo/MENAGD8jT8IAABAAABO/07/IAAA42/8QQAAAAIAcPp3+gcBABh/448AADD+xh8BAAAIAACnf6d/BACA8QcBAAAIAACnfxAAAMYfBABg/I0/CAAAQAAATv9O/yAAAONv/EEAAAACAHD6d/oHAQAYf+MPAgAw/sYfBAAAIAAAp3+nfwQAgPEHAQAACAAAp38QAADGHwQAYPyNPwgAAEAAAE7/Tv8gAADjb/xBAAAAAgBw+nf6BwEAGH/jDwIAwPiDAACc/oHXWnoEpLpYX3oIL/D52wenfxAAYPiNf/t+fP01HPv2gQDA8JP7fT9eHXkYcIe/AcD4U/b072cABAAQPP6AAMDpn+KeGn8/CyAAgKKnf0AAgBNf2PhvcvXvZwIEABA2/oAAAAABAOD0DwIAMP7GHwQA9Os1//qbv36vPf7+RUAQAPDo+KdFgOgBAQCxtwD3RzBlFJOu/p3+QQDARiNYPQJ87g8CAGJvAZ4bQdfj9X8GQABA8QG4PwKbjnvFCEg5/T/0fQeGYekRkHoSvD49fPFgVrl6Thh/ow8CAP7npeN/dzgPzq76f/2dxxuwPR8BYPz3/P/v/fXPpUJ4gQCAzsev1xE1/oAAwPiHjanxBwQAxj98VAEEAMY/IAKc/gEBgPEPG1jjDwgAjL+hBRAAGP/qEeD0DwgAjH/Y6Bp/QABg/EWI8QcEAMbfCAMCAIx/qa/L6R8QABj/sK/P+AMCAOPv6wQQABj/6l+v0z8gADD+YV+38QcEAMY/7Os3/oAAwPh7HQACAONf/fU4/QMCgPIqjsY2A278AQGACAi/CQAQAIiAgAhw+gcEACIgLAKMPyAAEAFhEWD8AQEAg48DAAQAIqB4BDj9AwIAwiLA+AMCAMJvAgAEAIgA3wtAAIDh8T0ABAAGCM8eEAAYIgAEACIAzxsEABglPGcQAGCcAAQAiAA8W6hl6RGQNlT+cZ1p/fj6axjWl819XcerI98ccAMA9waL8s/yYn05XDQYJiAAYMZBEAGZ33dAABA4Am4Cck7/m/4MgAAAI4bnBgIAqp/+jZmfBRAAgAjwrEAAQOqJz7BlPCO3ACAAQAR4NiAAAEMHCAAQAXgeIADA6HkOgACATmz778EbPz8TIADACdhrBwQAJJ34Eoew4mt2+gcBAAbRawUBAG4BDKOfARAAUHYAfByQ9/qm+r6DAACDUDYCKr0uww9PW3oEJIfAVs6uhuvTQ88EcAMAaQ7OrrwWQACACPAaAAEAIsDXDggAEAEAAgBEgK8XEAAgAnydgAAAEQAgAEAECBRAAIAIMP6AAAARYPwBAQAiAEAAgAgQIYAAgLARPji7Mv6AAICkCDD8gACAxiJg1+Ns/AEBAGG3AcYfEAAQFgHGH9jE0iOAdiLg+vTQ8AMCAJJvAzaJAaMPCAAoHAMAU/M3AAAgAAAAAQBPePflp4cA3ocIAABAAAAAAoCaXD+C9x8CAAAQAACAAKAs15DgfYcAAAAEAE4jgPcbAgC/lADvMwQAAMYfAYBfUAAIAEQA4H2FAMAvK/B+AgGAX1rgfQQCAL+8oNx7x/sHAYBfZCCcQQDglxp4n8B2Fm9P1rceA/v25/snDwEMPwIAIQBGH/YaAMMwDCIAQQBGnxw356vF0mPAL0eAPP4IEAAEAAAgAAAAAQAACAAAQAAAAF0FwM35auFRAEB9fzffDQAApN4AAAACAAAQAABA2QDwh4AAUNvdrXcDAADJNwAAgAAAAFICwN8BAEBN9zfeDQAApN8AAAACAABICQB/BwAAtTy07W4AAMANAAAQGwA+BgCAGh7bdDcAAOAGAACIDgAfAwBA357acjcAAOAGAACIDwAfAwBAn57bcDcAAOAGwC0AAFQ//bsBAAA3AACAALjDxwAA0IdNN9sNAAC4AXALAADVT/9uAADADYBbAABIOP27AQAANwBuAQAg4fTvBgAA3AC4BQCAhNO/GwAAcAPgFgAAEk7/W98AiAAA6G/8tw4AAKBPWweAWwAA6Ov07wYAANwAuAUAgITT/6Q3ACIAAPoY/0kDAADox6QB4BYAANo//e/kBkAEAED72zr28oUCgPFvPAAAgLbtLADcAgBAu1s69vqFA4DxbzQARAAAtLmd/gYAAALtJQDcAgBAW5s5VntBAGD8GwoAEQAA7WzkWP0FAoDxbyAARAAAzL+JY9oLBoD08Z81AEQAAMZ/PmP6AwCAxO0bPQgAyNu80QMBgLytGz0YAMjbuNEDAoC8bRs9KADI27TRAwOAvC0bPTgAyNuw0QMEgLzt6mpc356sb/1YAWD4A24A3AYAYKPCA0AEAGCbptH1mPpIAADDH3ID4DYAABsUHgAiAADb8zqlxtNHAgAY/pAbALcBANiY8BsAtwEAGP7wABACABj+x42+gQCQtx1R4+g2AACHxsAAEAIApA9/dAAIAQBSh18ACAEAwx9MAAgBAMMvABADAEZfACAEAAy/ABADYgDA6AsAMQCA0RcAYgAAoy8ABAEABl8ACAIADL4AEAWiAMDYCwAEAmDg2af/AKEo2dGcX/SRAAAAAElFTkSuQmCC', 'base64'),
  '/apple-touch-icon.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAYAAAA9zQYyAAAEVElEQVR42u3dO04bXRjH4ZkjikhcqrRp6CJhNsAiYBc0LIeGXcAi2ABGSkeTloqLlI5USMjIXDwzZ855z/NbQOLPefh/r41J+q6Ato+XL52q7/lq0c/9GHqAFQl4D7Ei4e4hViTcPciKBDvBrEhvBvQgK9JaJ5gVaa17kBVprRPMirTWCWZFQp1gViTUCWZFQp1gViTUCWZFQp1gViTUydOkSCXrrEgrnWBWJNRODsU/Oayzal3pBLMioXZyKO7JYZ1V+0pbaMV/UShVD9q5oQhnh4WWk0MqGrRzQ1HODgstJ4cEtJSh3v0sCy0BLU3fVgv/kU+XB9U81j9//3W/f/2Y7NffObl1Q4OcF3TXdZOijgw7JOgaIa+CzoE6IuwEcx24PV9eFELdYKFAR1ubXKgjPW8WGmoLbZ3joY7y/FloqC20oAZaUAMtqIGGGmhBDbSgBlrTom4dNtDWGmhBDbSgBlpQA62GUQMNNdCCGmhBDbSgBloNowYaaqAFNdCCOkNb/jjLKsdf/xU5Cy2gJaAloCWgBbQEtAS0BLQEdDs9nu55EoCOhRlqoC010Cod8OPpXtOwgQ66xq2iBjrwadEiaqDhB1p1AW3prvYTK2+6Xt4X/fgOz/cHfzHsXjxYaJhjFB0z0BVhHrrObmiFwtzCOgMNM9ARO1r8dDcDDbW7uby8bVco6jHeN25tnS10ocEMtAS0dQZaMAOtPLWOGehg6yygnRpAC2ag5W4G2joLaKcG0HJqRMmHk96U6ydXxvgU3fXyPvTHXi10Q5hvzu6yPmagYZ4cc+7HDrRGbxWzgM6yojl/XQH9rtcXV6/oxsY3xamx+tgF9IfoSlpUmL+et+269d/kODzfH/x+7xjfQAHXQo8GbghI3w0EuijMQ2DCDHSRmMcECjPQRWDOsegCepa7Nse/bWKdgc6KZR1amIEOh1pAh0BtnYEOgxpmoEOhhhloqDVJPsvxBvUcL/Ruzu66bsMP6fuMh4Ve2/XyPvsH6If+fn5aBehPYeRCPdbvAzXQ2bAJ6CZQ+4IBOgxqmIGevI/eLSgdoHc6gJ4N9dhfHDC/z/vQXwUy8H3q3YuH7shTbKFLatPvKPpOJNDhUAvoEKh9AQAdBjXMXhRWiXr1xSLIQLur5eSQwoLeObn1p+n5s9Cy0FbGOgMtAW2lPV/frN8+Xr5E/cN6ujwgtrEv/NCgwW7v/2BNgJYbWqoT9PPVovc0KELPV4veQsvJIQEt5QLtjlaE+9lCy8khVQHa2aHazw0LLSeHVA1oZ4dqPjcstOKfHFZata7z2oWGWjVidnIo/slhpVXrOn+60FCrJsxODrVzclhp1bbOX15oqFUD5m+dHFCrdMzfvqGhVsmYN3pRCLVKxbwRaKhVKuaNQUOtEjF3XdeNgtJfJ6a5IQ9eaGut0jCPttDWWqWMYSr9AQrmWRfaWmvO0cu2pnBDnOP3meU8gBviUKABB3iq/gOdxiMtqOGqWgAAAABJRU5ErkJggg==', 'base64'),
};
for (const [path, bytes] of Object.entries(ICONS)) {
  app.get(path, (req, res) => {
    res.set('Cache-Control', 'public, max-age=604800');
    res.type('image/png').send(bytes);
  });
}

app.get('/manifest.webmanifest', async (req, res) => {
  res.type('application/manifest+json').json({
    name: 'ServeTrack',
    short_name: 'ServeTrack',
    description: 'Jobs, attempts, affidavits and billing for a process serving company.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#EDF2FB',
    theme_color: '#0B4FD3',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ]
  });
});

const SERVICE_WORKER = "/* Service worker \u2014 the piece that makes this installable.\n *\n * Deliberately conservative, because this app shows live data:\n *\n *   the app shell   network first, cache as a fallback  \u2014 a deploy shows up\n *                                                         immediately, and the\n *                                                         app still opens when\n *                                                         the phone has no signal\n *   anything /api/  network only                        \u2014 never serve a stale\n *                                                         job, school or invoice\n *   icons           cache first                         \u2014 they never change\n */\nvar VERSION = 'st-2026-08-31';\nvar SHELL = VERSION + '-shell';\n\nself.addEventListener('install', function (e) {\n  e.waitUntil(\n    caches.open(SHELL)\n      .then(function (c) { return c.addAll(['/icon-192.png', '/icon-512.png']); })\n      .catch(function () { /* one missing icon must not sink the install */ })\n      .then(function () { return self.skipWaiting(); })\n  );\n});\n\nself.addEventListener('activate', function (e) {\n  e.waitUntil(\n    caches.keys().then(function (keys) {\n      return Promise.all(keys.map(function (k) { if (k !== SHELL) return caches.delete(k); }));\n    }).then(function () { return self.clients.claim(); })\n  );\n});\n\nself.addEventListener('fetch', function (e) {\n  var req = e.request;\n  if (req.method !== 'GET') return;\n  var url;\n  try { url = new URL(req.url); } catch (err) { return; }\n  if (url.origin !== self.location.origin) return;\n\n  // Live data is never cached, and neither is anything that prints.\n  if (/^\\/(api|print|photo|barcode)\\//.test(url.pathname)) return;\n\n  if (/\\.(png|ico|svg|webmanifest)$/.test(url.pathname)) {\n    e.respondWith(\n      caches.match(req).then(function (hit) {\n        return hit || fetch(req).then(function (r) {\n          if (r && r.ok) { var copy = r.clone(); caches.open(SHELL).then(function (c) { c.put(req, copy); }); }\n          return r;\n        });\n      })\n    );\n    return;\n  }\n\n  e.respondWith(\n    fetch(req).then(function (r) {\n      if (r && r.ok && req.mode === 'navigate') {\n        var copy = r.clone();\n        caches.open(SHELL).then(function (c) { c.put(req, copy); });\n      }\n      return r;\n    }).catch(function () {\n      return caches.match(req).then(function (hit) {\n        return hit || caches.match('/') || new Response('Offline', { status: 503 });\n      });\n    })\n  );\n});\n";
app.get('/sw.js', (req, res) => {
  // Must not itself be cached, or a fixed worker can never replace a broken one.
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript').send(SERVICE_WORKER);
});

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
