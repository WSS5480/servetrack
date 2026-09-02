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

-- These three are a copy of what My Apps last said, not a second opinion.
-- My Apps decides the plan; this is what the app falls back on when it cannot
-- be reached, so an outage there never stops work here.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_source  TEXT NOT NULL DEFAULT '';       -- trial | code | stripe | manual
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_checked TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS trial_started BOOLEAN NOT NULL DEFAULT FALSE;

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
  'LCAnVG9vbHMnLCAn4pyCJ10sIFsnZmluZCcsICdGaW5kJywgJ+KMlSddLCBbJ21vbmV5JywgJ0JpbGwnLCAnJCddLCBbJ2FkbWlu' +
  'JywgJ1NldHVwJywgJ+KamSddXQogIDogW1snZGFzaCcsICdNeSBEYXknLCAn4peOJ10sIFsnam9icycsICdKb2JzJywgJ+KWpCdd' +
  'LCBbJ3NjYW4nLCAnU2NhbicsICfilqUnXSwKICAgICBbJ3Rvb2xzJywgJ1Rvb2xzJywgJ+KcgiddLCBbJ2ZpbmQnLCAnRmluZCcs' +
  'ICfijJUnXSwgWydtb25leScsICdQYXknLCAnJCddXTsKCmZ1bmN0aW9uIHNoZWxsKGlubmVyKSB7CiAgY29uc3QgdGFicyA9IFRB' +
  'QlMoKS5tYXAoKFt2LCBsYWJlbCwgaWNdKSA9PgogICAgYDxidXR0b24gZGF0YS10YWI9IiR7dn0iIGNsYXNzPSIke1MudmlldyA9' +
  'PT0gdiB8fCAodiA9PT0gJ2pvYnMnICYmIFMudmlldyA9PT0gJ2pvYicpID8gJ29uJyA6ICcnfSI+CiAgICAgIDxzcGFuIGNsYXNz' +
  'PSJpYyI+JHtpY308L3NwYW4+JHtlc2MobGFiZWwpfTwvYnV0dG9uPmApLmpvaW4oJycpOwogIGNvbnN0IHN1cHBvcnRCYXIgPSBT' +
  'Lm1lLnN1cHBvcnQKICAgID8gYDxkaXYgc3R5bGU9ImJhY2tncm91bmQ6I0MyNDEwQztjb2xvcjojZmZmO3RleHQtYWxpZ246Y2Vu' +
  'dGVyO2ZvbnQtc2l6ZToxMi41cHg7CiAgICAgICAgcGFkZGluZzo2cHggMTBweDtmb250LXdlaWdodDo2MDAiPlN1cHBvcnQgdmll' +
  'dyDigJQgbmFtZXMgJmFtcDsgZG9jdW1lbnRzIGFyZSBoaWRkZW4uCiAgICAgICAgVGhpcyBpcyAke2VzYyhTLm1lLmNvbXBhbnkg' +
  'PyBTLm1lLmNvbXBhbnkubmFtZSA6ICdhIGN1c3RvbWVyIGNvbXBhbnknKX0sIG5vdCB5b3Vycy48L2Rpdj5gCiAgICA6ICcnOwog' +
  'IHJldHVybiBgJHtzdXBwb3J0QmFyfQogICAgPGRpdiBjbGFzcz0idG9wYmFyIj4KICAgICAgPGRpdiBjbGFzcz0iYnJhbmQiPlNl' +
  'cnZlVHJhY2s8c21hbGw+JHtlc2MoUy5tZS5jb21wYW55ID8gUy5tZS5jb21wYW55Lm5hbWUgOiAnJyl9JHsKICAgICAgICBTLm1l' +
  'LmNvbXBhbnkgPyAnIMK3ICcgOiAnJ30ke2VzYyhTLm1lLm5hbWUpfSDCtyAke3JvbGVMYWJlbCgpfTwvc21hbGw+PC9kaXY+CiAg' +
  'ICAgIDxkaXYgY2xhc3M9InNwYWNlciI+PC9kaXY+CiAgICAgICR7aXNPd25lcigpICYmIChTLm1lLmNvbXBhbmllcyB8fCBbXSku' +
  'bGVuZ3RoID4gMQogICAgICAgID8gYDxzZWxlY3QgaWQ9ImNvU3dpdGNoIiB0aXRsZT0iV2hpY2ggY29tcGFueSB5b3UgYXJlIHdv' +
  'cmtpbmcgaW4iPiR7CiAgICAgICAgICAgIChTLm1lLmNvbXBhbmllcyB8fCBbXSkubWFwKGMgPT4gYDxvcHRpb24gdmFsdWU9IiR7' +
  'Yy5pZH0iJHsKICAgICAgICAgICAgICBTLm1lLmNvbXBhbnkgJiYgYy5pZCA9PT0gUy5tZS5jb21wYW55LmlkID8gJyBzZWxlY3Rl' +
  'ZCcgOiAnJ30+JHtlc2MoYy5uYW1lKX08L29wdGlvbj5gKS5qb2luKCcnKQogICAgICAgICAgfTwvc2VsZWN0PmAgOiAnJ30KICAg' +
  'ICAgPGJ1dHRvbiBpZD0ibG9nb3V0Ij5TaWduIG91dDwvYnV0dG9uPgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJ3cmFwIj4k' +
  'e2lubmVyfTwvZGl2PgogICAgPGRpdiBjbGFzcz0idGFicyI+JHt0YWJzfTwvZGl2PmA7Cn0KCmZ1bmN0aW9uIGJpbmRTaGVsbCgp' +
  'IHsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS10YWJdJykuZm9yRWFjaChiID0+CiAgICBiLm9uY2xpY2sgPSAo' +
  'KSA9PiBnbyhiLmRhdGFzZXQudGFiKSk7CiAgLy8gTGlua3MgaW5zaWRlIGEgY2FyZCB0aGF0IGp1bXAgdG8gYSB0YWIg4oCUICJV' +
  'cGdyYWRlIiBvbiB0aGUgcGxhbiBiYW5uZXIuCiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtZ29dJykuZm9yRWFj' +
  'aChhID0+CiAgICBhLm9uY2xpY2sgPSBlID0+IHsgZS5wcmV2ZW50RGVmYXVsdCgpOyBnbyhhLmRhdGFzZXQuZ28pOyB9KTsKICBj' +
  'b25zdCBsbyA9ICQoJyNsb2dvdXQnKTsKICBpZiAobG8pIGxvLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7IGF3YWl0IGFwaSgnL2xv' +
  'Z291dCcsIHsgbWV0aG9kOiAnUE9TVCcgfSk7IFMubWUgPSBudWxsOyByZW5kZXIoKTsgfTsKICBjb25zdCBzdyA9ICQoJyNjb1N3' +
  'aXRjaCcpOwogIGlmIChzdykgc3cub25jaGFuZ2UgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBjb25zdCBvdXQgPSBh' +
  'd2FpdCBhcGkoJy9jb21wYW5pZXMvJyArIHN3LnZhbHVlICsgJy9lbnRlcicsIHsgbWV0aG9kOiAnUE9TVCcgfSk7CiAgICAgIFMu' +
  'bWUgPSBhd2FpdCBhcGkoJy9tZScpOwogICAgICB0b2FzdCgnTm93IGluICcgKyBvdXQuY29tcGFueS5uYW1lKTsKICAgICAgcmVu' +
  'ZGVyKCk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9Owp9CgovKiAtLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBsb2dpbiAtLSAqLwpmdW5jdGlvbiBsb2dp' +
  'blZpZXcoKSB7CiAgYXBwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJsb2dpbiI+CiAgICA8ZGl2IGNsYXNzPSJsb2dvIj48Yj5T' +
  'ZXJ2ZVRyYWNrPC9iPjxkaXY+UHJvY2VzcyBzZXJ2aW5nIG1hbmFnZW1lbnQ8L2Rpdj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImNh' +
  'cmQiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkVtYWlsPC9sYWJlbD48aW5wdXQgaWQ9ImVtYWlsIiB0eXBlPSJl' +
  'bWFpbCIgYXV0b2NvbXBsZXRlPSJ1c2VybmFtZSIgaW5wdXRtb2RlPSJlbWFpbCI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZp' +
  'ZWxkIj48bGFiZWw+UGFzc3dvcmQ8L2xhYmVsPjxpbnB1dCBpZD0icHciIHR5cGU9InBhc3N3b3JkIiBhdXRvY29tcGxldGU9ImN1' +
  'cnJlbnQtcGFzc3dvcmQiPjwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYmxvY2siIGlkPSJzaWduaW4iPlNpZ24gaW48' +
  'L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgaWQ9ImVyciIgc3R5bGU9ImNvbG9yOnZhcigtLWJhZCk7bWFyZ2luLXRv' +
  'cDoxMHB4Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyO21hcmdpbi10b3A6' +
  'MTJweCI+CiAgICAgICAgPGEgaHJlZj0iL2ZvcmdvdCI+Rm9yZ290IHlvdXIgcGFzc3dvcmQ/PC9hPjwvZGl2PgogICAgICA8ZGl2' +
  'IGNsYXNzPSJoaW50IiBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXI7bWFyZ2luLXRvcDoxMHB4Ij4KICAgICAgICBCZWVuIGdpdmVu' +
  'IGFuIGFjY2VzcyBjb2RlPyA8YSBocmVmPSIjIiBpZD0iaGF2ZUNvZGUiPlNldCB1cCB5b3VyIGFjY291bnQ8L2E+PC9kaXY+CiAg' +
  'ICAgIDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlcjttYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxh' +
  'IGhyZWY9Ii9wcml2YWN5IiB0YXJnZXQ9Il9ibGFuayI+UHJpdmFjeSBzdGF0ZW1lbnQ8L2E+PC9kaXY+CiAgICA8L2Rpdj48L2Rp' +
  'dj5gOwogIGNvbnN0IHN1Ym1pdCA9IGFzeW5jICgpID0+IHsKICAgICQoJyNlcnInKS50ZXh0Q29udGVudCA9ICcnOwogICAgdHJ5' +
  'IHsKICAgICAgYXdhaXQgYXBpKCcvbG9naW4nLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVtYWls' +
  'OiAkKCcjZW1haWwnKS52YWx1ZSwgcGFzc3dvcmQ6ICQoJyNwdycpLnZhbHVlIH0pIH0pOwogICAgICBTLm1lID0gYXdhaXQgYXBp' +
  'KCcvbWUnKTsKICAgICAgZ28oJ2Rhc2gnKTsKICAgIH0gY2F0Y2ggKGUpIHsgJCgnI2VycicpLnRleHRDb250ZW50ID0gZS5tZXNz' +
  'YWdlOyB9CiAgfTsKICAkKCcjc2lnbmluJykub25jbGljayA9IHN1Ym1pdDsKICAkKCcjcHcnKS5vbmtleWRvd24gPSBlID0+IHsg' +
  'aWYgKGUua2V5ID09PSAnRW50ZXInKSBzdWJtaXQoKTsgfTsKICAkKCcjaGF2ZUNvZGUnKS5vbmNsaWNrID0gZSA9PiB7IGUucHJl' +
  'dmVudERlZmF1bHQoKTsgcmVkZWVtVmlldygpOyB9OwogICQoJyNlbWFpbCcpLmZvY3VzKCk7Cn0KCgovKiBSZWRlZW1pbmcgYSBj' +
  'b2RlIGNyZWF0ZXMgdGhlIGFjY291bnQsIHNvIHNvbWVvbmUgY2FuIGJlIHNldCB1cCB3aXRob3V0IGFuCiAgIGFkbWluIGtleWlu' +
  'ZyBpbiB0aGVpciBkZXRhaWxzLiAqLwpmdW5jdGlvbiByZWRlZW1WaWV3KCkgewogIGFwcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFz' +
  'cz0ibG9naW4iPgogICAgPGRpdiBjbGFzcz0ibG9nbyI+PGI+U2VydmVUcmFjazwvYj48ZGl2PlNldCB1cCB5b3VyIGFjY291bnQ8' +
  'L2Rpdj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkFjY2VzcyBj' +
  'b2RlPC9sYWJlbD4KICAgICAgICA8aW5wdXQgaWQ9InJfY29kZSIgcGxhY2Vob2xkZXI9IkFCQ0QtRUZHSC1KS0xNIiBhdXRvY2Fw' +
  'aXRhbGl6ZT0iY2hhcmFjdGVycyIgc3R5bGU9InRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZSI+PC9kaXY+CiAgICAgIDxkaXYgY2xh' +
  'c3M9ImZpZWxkIj48bGFiZWw+WW91ciBuYW1lPC9sYWJlbD48aW5wdXQgaWQ9InJfbmFtZSIgYXV0b2NvbXBsZXRlPSJuYW1lIj48' +
  'L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5FbWFpbDwvbGFiZWw+PGlucHV0IGlkPSJyX2VtYWlsIiB0eXBl' +
  'PSJlbWFpbCIgaW5wdXRtb2RlPSJlbWFpbCIgYXV0b2NvbXBsZXRlPSJlbWFpbCI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZp' +
  'ZWxkIj48bGFiZWw+Q2hvb3NlIGEgcGFzc3dvcmQ8L2xhYmVsPgogICAgICAgIDxpbnB1dCBpZD0icl9wdyIgdHlwZT0icGFzc3dv' +
  'cmQiIGF1dG9jb21wbGV0ZT0ibmV3LXBhc3N3b3JkIiBwbGFjZWhvbGRlcj0iQXQgbGVhc3QgOCBjaGFyYWN0ZXJzIj48L2Rpdj4K' +
  'ICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Zb3VyIGNvbXBhbnkgPHNwYW4gY2xhc3M9ImhpbnQiPuKAlCBvbmx5IGlm' +
  'IHlvdSBhcmUgc3RhcnRpbmcgYSBuZXcgb25lPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgPGlucHV0IGlkPSJyX2NvIiBwbGFjZWhv' +
  'bGRlcj0iZS5nLiBSaW8gR3JhbmRlIFByb2Nlc3MgU2VydmluZyI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBibG9j' +
  'ayIgaWQ9InJfZ28iPkNyZWF0ZSBteSBhY2NvdW50PC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIGlkPSJyX2VyciIg' +
  'c3R5bGU9ImNvbG9yOnZhcigtLWJhZCk7bWFyZ2luLXRvcDoxMHB4Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5' +
  'bGU9InRleHQtYWxpZ246Y2VudGVyO21hcmdpbi10b3A6MTRweCI+CiAgICAgICAgPGEgaHJlZj0iIyIgaWQ9InJfYmFjayI+QmFj' +
  'ayB0byBzaWduIGluPC9hPjwvZGl2PgogICAgPC9kaXY+PC9kaXY+YDsKCiAgJCgnI3JfYmFjaycpLm9uY2xpY2sgPSBlID0+IHsg' +
  'ZS5wcmV2ZW50RGVmYXVsdCgpOyBsb2dpblZpZXcoKTsgfTsKICBjb25zdCBnbyA9IGFzeW5jICgpID0+IHsKICAgICQoJyNyX2Vy' +
  'cicpLnRleHRDb250ZW50ID0gJyc7CiAgICB0cnkgewogICAgICBjb25zdCBtYWRlID0gYXdhaXQgYXBpKCcvcmVkZWVtJywgeyBt' +
  'ZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoewogICAgICAgIGNvZGU6ICQoJyNyX2NvZGUnKS52YWx1ZSwgbmFt' +
  'ZTogJCgnI3JfbmFtZScpLnZhbHVlLCBjb21wYW55OiAkKCcjcl9jbycpLnZhbHVlLAogICAgICAgIGVtYWlsOiAkKCcjcl9lbWFp' +
  'bCcpLnZhbHVlLCBwYXNzd29yZDogJCgnI3JfcHcnKS52YWx1ZQogICAgICB9KSB9KTsKICAgICAgUy5tZSA9IGF3YWl0IGFwaSgn' +
  'L21lJyk7CiAgICAgIHRvYXN0KCdXZWxjb21lLCAnICsgbWFkZS5uYW1lKTsKICAgICAgZ28yKCk7CiAgICB9IGNhdGNoIChlKSB7' +
  'ICQoJyNyX2VycicpLnRleHRDb250ZW50ID0gZS5tZXNzYWdlOyB9CiAgfTsKICBjb25zdCBnbzIgPSAoKSA9PiB7IFMudmlldyA9' +
  'ICdkYXNoJzsgUy5wYXJhbXMgPSB7fTsgcmVuZGVyKCk7IH07CiAgJCgnI3JfZ28nKS5vbmNsaWNrID0gZ287CiAgJCgnI3JfcHcn' +
  'KS5vbmtleWRvd24gPSBlID0+IHsgaWYgKGUua2V5ID09PSAnRW50ZXInKSBnbygpOyB9OwogICQoJyNyX2NvZGUnKS5mb2N1cygp' +
  'Owp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGRhc2hib2Fy' +
  'ZCAtLSAqLwphc3luYyBmdW5jdGlvbiBkYXNoVmlldygpIHsKICBjb25zdCBbc3RhdHMsIGpvYnNdID0gYXdhaXQgUHJvbWlzZS5h' +
  'bGwoW2FwaSgnL3N0YXRzJyksIGFwaSgnL2pvYnM/b3Blbj0xJyldKTsKICBjb25zdCBvdmVyZHVlID0gam9icy5maWx0ZXIoaiA9' +
  'PiB7IGNvbnN0IGQgPSBkYXlzT3V0KGouZHVlX2RhdGUpOyByZXR1cm4gZCAhPT0gbnVsbCAmJiBkIDwgMDsgfSk7CiAgY29uc3Qg' +
  'dG9kYXkgPSBqb2JzLmZpbHRlcihqID0+IHsgY29uc3QgZCA9IGRheXNPdXQoai5kdWVfZGF0ZSk7IHJldHVybiBkICE9PSBudWxs' +
  'ICYmIGQgPj0gMCAmJiBkIDw9IDE7IH0pOwogIGNvbnN0IHJ1c2ggPSBqb2JzLmZpbHRlcihqID0+IGoucHJpb3JpdHkgIT09ICdS' +
  'b3V0aW5lJyk7CiAgY29uc3QgbWluZSA9IGlzQWRtaW4oKSA/IGpvYnMgOiBqb2JzOwoKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwo' +
  'YAogICAgPGgxIGNsYXNzPSJwYWdlIj4ke2lzQWRtaW4oKSA/ICdPcGVyYXRpb25zIHRvZGF5JyA6ICdNeSBkYXknfTwvaDE+CiAg' +
  'ICAke2lzQWRtaW4oKSA/IHBsYW5CYW5uZXIoKSA6ICcnfQogICAgPGRpdiBjbGFzcz0ic3RhdHMiPgogICAgICA8ZGl2IGNsYXNz' +
  'PSJzdGF0Ij48ZGl2IGNsYXNzPSJuIj4ke3N0YXRzLm9wZW5fam9ic308L2Rpdj48ZGl2IGNsYXNzPSJsIj5PcGVuIGpvYnM8L2Rp' +
  'dj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdCAke3N0YXRzLm92ZXJkdWUgPyAnYWxlcnQnIDogJyd9Ij48ZGl2IGNsYXNz' +
  'PSJuIj4ke3N0YXRzLm92ZXJkdWV9PC9kaXY+PGRpdiBjbGFzcz0ibCI+UGFzdCBkdWU8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBj' +
  'bGFzcz0ic3RhdCI+PGRpdiBjbGFzcz0ibiI+JHtzdGF0cy5ydXNofTwvZGl2PjxkaXYgY2xhc3M9ImwiPlJ1c2ggLyBzYW1lIGRh' +
  'eTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdGF0IGdvb2QiPjxkaXYgY2xhc3M9Im4iPiR7c3RhdHMuc2VydmVkXzdk' +
  'fTwvZGl2PjxkaXYgY2xhc3M9ImwiPlNlcnZlZCwgNyBkYXlzPC9kaXY+PC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNz' +
  'PSJjYXJkIj4KICAgICAgPGgyPlJvdXRlIG15IGRheSA8c3BhbiBjbGFzcz0ic3ViIj7igJQgJHttaW5lLmxlbmd0aH0gb3BlbiBz' +
  'dG9wJHttaW5lLmxlbmd0aCA9PT0gMSA/ICcnIDogJ3MnfTwvc3Bhbj48L2gyPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9' +
  'Im1hcmdpbi10b3A6LTRweCI+T3BlbnMgR29vZ2xlIE1hcHMgd2l0aCB5b3VyIHN0b3BzIGluIG9yZGVyICh1cCB0byAxMCkuIE5v' +
  'IG1hcHBpbmcgZmVlcyDigJQgaXQganVzdCBoYW5kcyBvZmYgdG8gdGhlIGFwcCB5b3UgYWxyZWFkeSBoYXZlLjwvcD4KICAgICAg' +
  'PGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gbmF2IiBp' +
  'ZD0icm91dGVCdG4iICR7bWluZS5sZW5ndGggPyAnJyA6ICdkaXNhYmxlZCd9PlN0YXJ0IHJvdXRlICgke01hdGgubWluKG1pbmUu' +
  'bGVuZ3RoLCAxMCl9IHN0b3BzKTwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJyb3V0ZUxp' +
  'c3QiPlNlZSBvcmRlcjwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgICR7c2VjdGlvbignUGFzdCBkdWUnLCBv' +
  'dmVyZHVlKX0KICAgICR7c2VjdGlvbignRHVlIHRvZGF5IG9yIHRvbW9ycm93JywgdG9kYXkpfQogICAgJHtzZWN0aW9uKCdSdXNo' +
  'ICZhbXA7IHNhbWUgZGF5JywgcnVzaC5maWx0ZXIoaiA9PiAhb3ZlcmR1ZS5pbmNsdWRlcyhqKSAmJiAhdG9kYXkuaW5jbHVkZXMo' +
  'aikpKX0KICAgICR7b3ZlcmR1ZS5sZW5ndGggKyB0b2RheS5sZW5ndGggKyBydXNoLmxlbmd0aCA9PT0gMAogICAgICA/IGA8ZGl2' +
  'IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJlbXB0eSI+Tm90aGluZyB1cmdlbnQuICR7bWluZS5sZW5ndGh9IG9wZW4gam9iJHtt' +
  'aW5lLmxlbmd0aCA9PT0gMSA/ICcnIDogJ3MnfSB0b3RhbCDigJQgc2VlIHRoZSBKb2JzIHRhYi48L2Rpdj48L2Rpdj5gIDogJyd9' +
  'CiAgYCk7CiAgYmluZFNoZWxsKCk7CiAgYmluZEpvYkl0ZW1zKCk7CiAgY29uc3QgcmIgPSAkKCcjcm91dGVCdG4nKTsKICBpZiAo' +
  'cmIpIHJiLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBjb25zdCB1cmwgPSByb3V0ZVVybChtaW5lLnNsaWNlKDAsIDEwKSk7CiAgICBp' +
  'ZiAodXJsKSB3aW5kb3cub3Blbih1cmwsICdfYmxhbmsnKTsKICB9OwogICQoJyNyb3V0ZUxpc3QnKS5vbmNsaWNrID0gKCkgPT4g' +
  'c2hlZXQoJ1JvdXRlIG9yZGVyJywgYAogICAgPHAgY2xhc3M9ImhpbnQiPk9yZGVyZWQgYnkgcHJpb3JpdHksIHRoZW4gZHVlIGRh' +
  'dGUuIFRhcCBhbnkgc3RvcCB0byBuYXZpZ2F0ZSB0byBpdCBhbG9uZS48L3A+CiAgICA8ZGl2IGNsYXNzPSJsaXN0Ij4ke21pbmUu' +
  'c2xpY2UoMCwgMTApLm1hcCgoaiwgaSkgPT4gYAogICAgICA8ZGl2IGNsYXNzPSJpdGVtIiBkYXRhLW5hdj0iJHtlc2MoYWRkck9m' +
  'KGopKX0iPgogICAgICAgIDxkaXYgY2xhc3M9InIiPjxkaXY+PGRpdiBjbGFzcz0idCI+JHtpICsgMX0uICR7ZXNjKGoucmVjaXBp' +
  'ZW50X25hbWUpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im0iPiR7ZXNjKGFkZHJPZihqKSl9PC9kaXY+PC9kaXY+CiAgICAg' +
  'ICAgPHNwYW4gY2xhc3M9InBpbGwgJHtjbHMoai5wcmlvcml0eSl9Ij4ke2VzYyhqLnByaW9yaXR5KX08L3NwYW4+PC9kaXY+PC9k' +
  'aXY+YCkuam9pbignJyl9PC9kaXY+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIGJsb2NrIiBzdHlsZT0ibWFyZ2luLXRvcDox' +
  'MnB4IiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNsb3NlPC9idXR0b24+YCwKICAgIGVsID0+IGVsLnF1ZXJ5U2VsZWN0b3JBbGwo' +
  'J1tkYXRhLW5hdl0nKS5mb3JFYWNoKG4gPT4KICAgICAgbi5vbmNsaWNrID0gKCkgPT4gd2luZG93Lm9wZW4obmF2VXJsKG4uZGF0' +
  'YXNldC5uYXYpLCAnX2JsYW5rJykpKTsKfQoKZnVuY3Rpb24gc2VjdGlvbih0aXRsZSwgbGlzdCkgewogIGlmICghbGlzdC5sZW5n' +
  'dGgpIHJldHVybiAnJzsKICByZXR1cm4gYDxkaXYgY2xhc3M9ImNhcmQiPjxoMj4ke3RpdGxlfSA8c3BhbiBjbGFzcz0ic3ViIj4k' +
  'e2xpc3QubGVuZ3RofTwvc3Bhbj48L2gyPgogICAgPGRpdiBjbGFzcz0ibGlzdCI+JHtsaXN0Lm1hcChqb2JJdGVtKS5qb2luKCcn' +
  'KX08L2Rpdj48L2Rpdj5gOwp9CgpmdW5jdGlvbiBqb2JJdGVtKGopIHsKICBjb25zdCBkID0gZGF5c091dChqLmR1ZV9kYXRlKTsK' +
  'ICBjb25zdCBsYXRlID0gZCAhPT0gbnVsbCAmJiBkIDwgMCAmJiAhWydTZXJ2ZWQnLCAnTm9uLUVzdCcsICdDYW5jZWxsZWQnXS5p' +
  'bmNsdWRlcyhqLnN0YXR1cyk7CiAgY29uc3QgZHVlID0gai5kdWVfZGF0ZQogICAgPyAobGF0ZSA/IGA8c3BhbiBzdHlsZT0iY29s' +
  'b3I6dmFyKC0tYmFkKTtmb250LXdlaWdodDo2MDAiPiR7TWF0aC5hYnMoZCl9ZCBwYXN0IGR1ZTwvc3Bhbj5gCiAgICAgICAgICAg' +
  'IDogKGQgPT09IDAgPyAnZHVlIHRvZGF5JyA6IGQgPT09IDEgPyAnZHVlIHRvbW9ycm93JyA6ICdkdWUgJyArIGZtdERhdGVPbmx5' +
  'KGouZHVlX2RhdGUpKSkKICAgIDogJ25vIGR1ZSBkYXRlJzsKICByZXR1cm4gYDxkaXYgY2xhc3M9Iml0ZW0gcC0ke2NscyhqLnBy' +
  'aW9yaXR5KX0gJHtsYXRlID8gJ292ZXJkdWUnIDogJyd9IiBkYXRhLWpvYj0iJHtqLmlkfSI+CiAgICA8ZGl2IGNsYXNzPSJyIj4K' +
  'ICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0Ij4ke2VzYyhqLnJlY2lwaWVudF9uYW1lKX08L2Rpdj4KICAgICAgICA8' +
  'ZGl2IGNsYXNzPSJtIj4ke2VzYyhqLmpvYl9udW1iZXIpfSDCtyAke2VzYyhqLmNpdHkgfHwgJycpfSR7ai5jaXR5ID8gJywgJyA6' +
  'ICcnfSR7ZXNjKGouc3RhdGUgfHwgJycpfSDCtyAke2R1ZX08L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtIj4ke2VzYyhqLmNs' +
  'aWVudF9uYW1lIHx8ICdObyBjbGllbnQnKX0ke2ouc2VydmVyX25hbWUgPyAnIOKGkiAnICsgZXNjKGouc2VydmVyX25hbWUpIDog' +
  'Jyd9JHtqLmF0dGVtcHRfY291bnQgPyAnIMK3ICcgKyBqLmF0dGVtcHRfY291bnQgKyAnIGF0dGVtcHQnICsgKGouYXR0ZW1wdF9j' +
  'b3VudCA9PT0gMSA/ICcnIDogJ3MnKSA6ICcnfTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0idGV4dC1hbGln' +
  'bjpyaWdodCI+CiAgICAgICAgPHNwYW4gY2xhc3M9InBpbGwgJHtjbHMoai5zdGF0dXMpfSI+JHtlc2Moai5zdGF0dXMpfTwvc3Bh' +
  'bj4KICAgICAgICAke2oucHJpb3JpdHkgIT09ICdSb3V0aW5lJyA/IGA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjVweCI+PHNwYW4g' +
  'Y2xhc3M9InBpbGwgcnVzaCI+JHtlc2Moai5wcmlvcml0eSl9PC9zcGFuPjwvZGl2PmAgOiAnJ30KICAgICAgPC9kaXY+CiAgICA8' +
  'L2Rpdj48L2Rpdj5gOwp9CgpmdW5jdGlvbiBiaW5kSm9iSXRlbXMoKSB7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2Rh' +
  'dGEtam9iXScpLmZvckVhY2goZWwgPT4KICAgIGVsLm9uY2xpY2sgPSAoKSA9PiBnbygnam9iJywgeyBpZDogZWwuZGF0YXNldC5q' +
  'b2IgfSkpOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0gam9icyAtLSAqLwphc3luYyBmdW5jdGlvbiBqb2JzVmlldygpIHsKICBjb25zdCBmID0gUy5wYXJhbXM7CiAgY29uc3QgcXMg' +
  'PSBuZXcgVVJMU2VhcmNoUGFyYW1zKCk7CiAgaWYgKGYuc3RhdHVzKSBxcy5zZXQoJ3N0YXR1cycsIGYuc3RhdHVzKTsKICBpZiAo' +
  'Zi5xKSBxcy5zZXQoJ3EnLCBmLnEpOwogIGlmIChmLm9wZW4pIHFzLnNldCgnb3BlbicsICcxJyk7CiAgY29uc3Qgam9icyA9IGF3' +
  'YWl0IGFwaSgnL2pvYnM/JyArIHFzLnRvU3RyaW5nKCkpOwoKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgxIGNsYXNz' +
  'PSJwYWdlIj4ke2lzQWRtaW4oKSA/ICdKb2JzJyA6ICdNeSBqb2JzJ308L2gxPgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAg' +
  'IDxkaXYgY2xhc3M9InJvdyI+CiAgICAgICAgPGlucHV0IGlkPSJxIiBwbGFjZWhvbGRlcj0iU2VhcmNoIG5hbWUsIGNhc2UgIywg' +
  'am9iICMsIGFkZHJlc3MiIHZhbHVlPSIke2VzYyhmLnEgfHwgJycpfSIgc3R5bGU9ImZsZXg6MTttaW4td2lkdGg6MTYwcHgiPgog' +
  'ICAgICAgIDxzZWxlY3QgaWQ9InN0YXR1cyIgc3R5bGU9IndpZHRoOmF1dG8iPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5B' +
  'bnkgc3RhdHVzPC9vcHRpb24+CiAgICAgICAgICAke1snUGVuZGluZycsICdBc3NpZ25lZCcsICdBdHRlbXB0ZWQnLCAnU2VydmVk' +
  'JywgJ05vbi1Fc3QnLCAnT24gSG9sZCcsICdDYW5jZWxsZWQnXQogICAgICAgICAgICAubWFwKHMgPT4gYDxvcHRpb24gJHtmLnN0' +
  'YXR1cyA9PT0gcyA/ICdzZWxlY3RlZCcgOiAnJ30+JHtzfTwvb3B0aW9uPmApLmpvaW4oJycpfQogICAgICAgIDwvc2VsZWN0Pgog' +
  'ICAgICAgIDxsYWJlbCBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6NnB4O21hcmdpbjowO2ZvbnQt' +
  'c2l6ZToxM3B4Ij4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJjaGVja2JveCIgaWQ9Im9wZW5Pbmx5IiAke2Yub3BlbiA/ICdjaGVj' +
  'a2VkJyA6ICcnfSBzdHlsZT0id2lkdGg6YXV0byI+IE9wZW4gb25seTwvbGFiZWw+CiAgICAgIDwvZGl2PgogICAgICAke2lzQWRt' +
  'aW4oKSA/ICc8YnV0dG9uIGNsYXNzPSJidG4gYmxvY2siIGlkPSJuZXdKb2IiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPisgTmV3' +
  'IGpvYjwvYnV0dG9uPicgOiAnJ30KICAgIDwvZGl2PgogICAgJHtqb2JzLmxlbmd0aCA/IGA8ZGl2IGNsYXNzPSJsaXN0Ij4ke2pv' +
  'YnMubWFwKGpvYkl0ZW0pLmpvaW4oJycpfTwvZGl2PmAKICAgICAgOiAnPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0iZW1w' +
  'dHkiPk5vIGpvYnMgbWF0Y2guPC9kaXY+PC9kaXY+J30KICBgKTsKICBiaW5kU2hlbGwoKTsgYmluZEpvYkl0ZW1zKCk7CiAgY29u' +
  'c3QgYXBwbHkgPSAoKSA9PiBnbygnam9icycsIHsgcTogJCgnI3EnKS52YWx1ZS50cmltKCksIHN0YXR1czogJCgnI3N0YXR1cycp' +
  'LnZhbHVlLCBvcGVuOiAkKCcjb3Blbk9ubHknKS5jaGVja2VkIH0pOwogICQoJyNxJykub25rZXlkb3duID0gZSA9PiB7IGlmIChl' +
  'LmtleSA9PT0gJ0VudGVyJykgYXBwbHkoKTsgfTsKICAkKCcjc3RhdHVzJykub25jaGFuZ2UgPSBhcHBseTsKICAkKCcjb3Blbk9u' +
  'bHknKS5vbmNoYW5nZSA9IGFwcGx5OwogIGlmICgkKCcjbmV3Sm9iJykpICQoJyNuZXdKb2InKS5vbmNsaWNrID0gKCkgPT4gam9i' +
  'Rm9ybShudWxsKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tIGpvYiBmb3JtIC0tICovCmFzeW5jIGZ1bmN0aW9uIGpvYkZvcm0oam9iKSB7CiAgY29uc3QgW2NsaWVudHMsIHVzZXJzXSA9' +
  'IGF3YWl0IFByb21pc2UuYWxsKFthcGkoJy9jbGllbnRzJyksIGFwaSgnL3VzZXJzJyldKTsKICBjb25zdCB2ID0gam9iIHx8IHsg' +
  'c2VydmljZV90eXBlOiAnUGVyc29uYWwnLCBwcmlvcml0eTogJ1JvdXRpbmUnLCBzdGF0dXM6ICdQZW5kaW5nJyB9OwogIGNvbnN0' +
  'IG9wdCA9IChsaXN0LCBzZWwsIGxhYmVsKSA9PiBsaXN0Lm1hcCh4ID0+CiAgICBgPG9wdGlvbiB2YWx1ZT0iJHt4LmlkfSIgJHtT' +
  'dHJpbmcoc2VsKSA9PT0gU3RyaW5nKHguaWQpID8gJ3NlbGVjdGVkJyA6ICcnfT4ke2VzYyhsYWJlbCh4KSl9PC9vcHRpb24+YCku' +
  'am9pbignJyk7CgogIHNoZWV0KGpvYiA/ICdFZGl0ICcgKyBqb2Iuam9iX251bWJlciA6ICdOZXcgam9iJywgYAogICAgPGRpdiBj' +
  'bGFzcz0iZHJvcHpvbmUiPgogICAgICA8bGFiZWw+U3RhcnQgZnJvbSB0aGUgcGFwZXJzPC9sYWJlbD4KICAgICAgPGlucHV0IHR5' +
  'cGU9ImZpbGUiIGlkPSJmX3BkZiIgYWNjZXB0PSJhcHBsaWNhdGlvbi9wZGYsLnBkZiI+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQi' +
  'IGlkPSJwZGZNc2ciPlBpY2sgdGhlIHN1bW1vbnMsIGNpdGF0aW9uLCBzdWJwb2VuYSBvciBjb21wbGFpbnQgYXMgYSBQREYgYW5k' +
  'IEknbGwKICAgICAgICByZWFkIHdoYXQgSSBjYW4gaW50byB0aGUgZm9ybSBiZWxvdy4gQWx3YXlzIGNoZWNrIGl0IGFnYWluc3Qg' +
  'dGhlIGRvY3VtZW50IGJlZm9yZSBzYXZpbmcuPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAg' +
  'ICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNsaWVudDwvbGFiZWw+PHNlbGVjdCBpZD0iZl9jbGllbnRfaWQiPgogICAgICAg' +
  'IDxvcHRpb24gdmFsdWU9IiI+4oCUIG5vbmUg4oCUPC9vcHRpb24+JHtvcHQoY2xpZW50cywgdi5jbGllbnRfaWQsIGMgPT4gYy5u' +
  'YW1lKX08L3NlbGVjdD48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Bc3NpZ24gdG88L2xhYmVsPjxzZWxl' +
  'Y3QgaWQ9ImZfYXNzaWduZWRfdG8iPgogICAgICAgIDxvcHRpb24gdmFsdWU9IiI+4oCUIHVuYXNzaWduZWQg4oCUPC9vcHRpb24+' +
  'JHtvcHQodXNlcnMuZmlsdGVyKHUgPT4gdS5hY3RpdmUpLCB2LmFzc2lnbmVkX3RvLCB1ID0+IHUubmFtZSl9PC9zZWxlY3Q+PC9k' +
  'aXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGVyc29uIC8gZW50aXR5IHRvIHNlcnZlICo8L2xh' +
  'YmVsPjxpbnB1dCBpZD0iZl9yZWNpcGllbnRfbmFtZSIgdmFsdWU9IiR7ZXNjKHYucmVjaXBpZW50X25hbWUpfSI+PC9kaXY+CiAg' +
  'ICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlNlcnZpY2UgYWRkcmVzczwvbGFiZWw+PGlucHV0IGlkPSJmX2FkZHJlc3MxIiBw' +
  'bGFjZWhvbGRlcj0iU3RyZWV0IGFkZHJlc3MiIHZhbHVlPSIke2VzYyh2LmFkZHJlc3MxKX0iPjwvZGl2PgogICAgPGRpdiBjbGFz' +
  'cz0iZ3JpZCBnMyI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+QXB0IC8gdW5pdDwvbGFiZWw+PGlucHV0IGlkPSJm' +
  'X2FkZHJlc3MyIiB2YWx1ZT0iJHtlc2Modi5hZGRyZXNzMil9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJl' +
  'bD5DaXR5PC9sYWJlbD48aW5wdXQgaWQ9ImZfY2l0eSIgdmFsdWU9IiR7ZXNjKHYuY2l0eSl9Ij48L2Rpdj4KICAgICAgPGRpdiBj' +
  'bGFzcz0iZmllbGQiPjxsYWJlbD5TdGF0ZSAvIFpJUDwvbGFiZWw+CiAgICAgICAgPGRpdiBjbGFzcz0icm93Ij48aW5wdXQgaWQ9' +
  'ImZfc3RhdGUiIHN0eWxlPSJ3aWR0aDo3MHB4IiBtYXhsZW5ndGg9IjIiIHZhbHVlPSIke2VzYyh2LnN0YXRlKX0iPgogICAgICAg' +
  'IDxpbnB1dCBpZD0iZl96aXAiIHN0eWxlPSJmbGV4OjEiIGlucHV0bW9kZT0ibnVtZXJpYyIgdmFsdWU9IiR7ZXNjKHYuemlwKX0i' +
  'PjwvZGl2PjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlJlY2lwaWVudCBub3RlcyAoZGVz' +
  'Y3JpcHRpb24sIHdvcmsgaG91cnMsIHZlaGljbGUsIGdhdGUgY29kZSk8L2xhYmVsPgogICAgICA8dGV4dGFyZWEgaWQ9ImZfcmVj' +
  'aXBpZW50X25vdGVzIiBzdHlsZT0ibWluLWhlaWdodDo2MHB4Ij4ke2VzYyh2LnJlY2lwaWVudF9ub3Rlcyl9PC90ZXh0YXJlYT48' +
  'L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNhc2UgbnVtYmVy' +
  'PC9sYWJlbD48aW5wdXQgaWQ9ImZfY2FzZV9udW1iZXIiIHZhbHVlPSIke2VzYyh2LmNhc2VfbnVtYmVyKX0iPjwvZGl2PgogICAg' +
  'ICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNvdXJ0PC9sYWJlbD48aW5wdXQgaWQ9ImZfY291cnQiIHZhbHVlPSIke2VzYyh2' +
  'LmNvdXJ0KX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBsYWludGlmZjwvbGFiZWw+PGlucHV0IGlk' +
  'PSJmX3BsYWludGlmZiIgdmFsdWU9IiR7ZXNjKHYucGxhaW50aWZmKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+' +
  'PGxhYmVsPkRlZmVuZGFudDwvbGFiZWw+PGlucHV0IGlkPSJmX2RlZmVuZGFudCIgdmFsdWU9IiR7ZXNjKHYuZGVmZW5kYW50KX0i' +
  'PjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkRvY3VtZW50cyB0byBzZXJ2ZTwvbGFiZWw+' +
  'PGlucHV0IGlkPSJmX2RvY3VtZW50cyIgcGxhY2Vob2xkZXI9IlN1bW1vbnMgYW5kIENvbXBsYWludCIgdmFsdWU9IiR7ZXNjKHYu' +
  'ZG9jdW1lbnRzKX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZCBnMyI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFi' +
  'ZWw+U2VydmljZSB0eXBlPC9sYWJlbD48c2VsZWN0IGlkPSJmX3NlcnZpY2VfdHlwZSI+CiAgICAgICAgJHtbJ1BlcnNvbmFsJywg' +
  'J1N1YnN0aXR1dGUnLCAnUG9zdGluZycsICdDZXJ0aWZpZWQgTWFpbCcsICdDb3Jwb3JhdGUnXS5tYXAocyA9PiBgPG9wdGlvbiAk' +
  'e3Yuc2VydmljZV90eXBlID09PSBzID8gJ3NlbGVjdGVkJyA6ICcnfT4ke3N9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+' +
  'PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UHJpb3JpdHk8L2xhYmVsPjxzZWxlY3QgaWQ9ImZfcHJpb3Jp' +
  'dHkiPgogICAgICAgICR7WydSb3V0aW5lJywgJ1J1c2gnLCAnU2FtZSBEYXknXS5tYXAocyA9PiBgPG9wdGlvbiAke3YucHJpb3Jp' +
  'dHkgPT09IHMgPyAnc2VsZWN0ZWQnIDogJyd9PiR7c308L29wdGlvbj5gKS5qb2luKCcnKX08L3NlbGVjdD48L2Rpdj4KICAgICAg' +
  'PGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5EdWUgZGF0ZTwvbGFiZWw+PGlucHV0IGlkPSJmX2R1ZV9kYXRlIiB0eXBlPSJkYXRl' +
  'IiB2YWx1ZT0iJHt2LmR1ZV9kYXRlID8gU3RyaW5nKHYuZHVlX2RhdGUpLnNsaWNlKDAsIDEwKSA6ICcnfSI+PC9kaXY+CiAgICA8' +
  'L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQgZzMiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNsaWVudCBmZWU8' +
  'L2xhYmVsPjxpbnB1dCBpZD0iZl9jbGllbnRfZmVlIiB0eXBlPSJudW1iZXIiIHN0ZXA9IjAuMDEiIHZhbHVlPSIke3YuY2xpZW50' +
  'X2ZlZSB8fCAnJ30iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlNlcnZlciBwYXk8L2xhYmVsPjxpbnB1' +
  'dCBpZD0iZl9zZXJ2ZXJfcGF5IiB0eXBlPSJudW1iZXIiIHN0ZXA9IjAuMDEiIHZhbHVlPSIke3Yuc2VydmVyX3BheSB8fCAnJ30i' +
  'PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlN0YXR1czwvbGFiZWw+PHNlbGVjdCBpZD0iZl9zdGF0dXMi' +
  'PgogICAgICAgICR7WydQZW5kaW5nJywgJ0Fzc2lnbmVkJywgJ0F0dGVtcHRlZCcsICdTZXJ2ZWQnLCAnTm9uLUVzdCcsICdPbiBI' +
  'b2xkJywgJ0NhbmNlbGxlZCddLm1hcChzID0+IGA8b3B0aW9uICR7di5zdGF0dXMgPT09IHMgPyAnc2VsZWN0ZWQnIDogJyd9PiR7' +
  'c308L29wdGlvbj5gKS5qb2luKCcnKX08L3NlbGVjdD48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxs' +
  'YWJlbD5JbnRlcm5hbCBub3RlczwvbGFiZWw+PHRleHRhcmVhIGlkPSJmX25vdGVzIiBzdHlsZT0ibWluLWhlaWdodDo2MHB4Ij4k' +
  'e2VzYyh2Lm5vdGVzKX08L3RleHRhcmVhPjwvZGl2PgogICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDo2cHgi' +
  'PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJzYXZlIj4ke2pvYiA/ICdTYXZlIGNoYW5nZXMnIDogJ0NyZWF0ZSBqb2In' +
  'fTwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNhbmNlbDwvYnV0' +
  'dG9uPgogICAgICAke2pvYiA/ICc8YnV0dG9uIGNsYXNzPSJidG4gZ2hvc3QiIGlkPSJkZWwiIHN0eWxlPSJjb2xvcjp2YXIoLS1i' +
  'YWQpO21hcmdpbi1sZWZ0OmF1dG8iPkRlbGV0ZTwvYnV0dG9uPicgOiAnJ30KICAgIDwvZGl2PmAsIGVsID0+IHsKICAgIC8qIC0t' +
  'LS0gcmVhZCBhIHN1bW1vbnMvY2l0YXRpb24gUERGIGFuZCBmaWxsIHdoYXQgd2UgY2FuIC0tLS0gKi8KICAgIGNvbnN0IHBkZk1z' +
  'ZyA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNwZGZNc2cnKTsKICAgIGNvbnN0IEZJTExBQkxFID0gWydjYXNlX251bWJlcicsICdjb3Vy' +
  'dCcsICdwbGFpbnRpZmYnLCAnZGVmZW5kYW50JywgJ3JlY2lwaWVudF9uYW1lJywKICAgICAgJ2FkZHJlc3MxJywgJ2FkZHJlc3My' +
  'JywgJ2NpdHknLCAnc3RhdGUnLCAnemlwJywgJ2RvY3VtZW50cyddOwogICAgY29uc3QgTEFCRUxTID0gewogICAgICBjYXNlX251' +
  'bWJlcjogJ2Nhc2UgbnVtYmVyJywgY291cnQ6ICdjb3VydCcsIHBsYWludGlmZjogJ3BsYWludGlmZicsIGRlZmVuZGFudDogJ2Rl' +
  'ZmVuZGFudCcsCiAgICAgIHJlY2lwaWVudF9uYW1lOiAncGVyc29uIHRvIHNlcnZlJywgYWRkcmVzczE6ICdhZGRyZXNzJywgYWRk' +
  'cmVzczI6ICd1bml0JywgY2l0eTogJ2NpdHknLAogICAgICBzdGF0ZTogJ3N0YXRlJywgemlwOiAnWklQJywgZG9jdW1lbnRzOiAn' +
  'ZG9jdW1lbnRzJwogICAgfTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNmX3BkZicpLm9uY2hhbmdlID0gYXN5bmMgZSA9PiB7CiAg' +
  'ICAgIGNvbnN0IGZpbGUgPSBlLnRhcmdldC5maWxlcyAmJiBlLnRhcmdldC5maWxlc1swXTsKICAgICAgaWYgKCFmaWxlKSByZXR1' +
  'cm47CiAgICAgIHBkZk1zZy5pbm5lckhUTUwgPSAnUmVhZGluZyAnICsgZXNjKGZpbGUubmFtZSkgKyAn4oCmJzsKICAgICAgdHJ5' +
  'IHsKICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgbmV3IFByb21pc2UoKHJlcywgcmVqKSA9PiB7CiAgICAgICAgICBjb25zdCBy' +
  'ID0gbmV3IEZpbGVSZWFkZXIoKTsKICAgICAgICAgIHIub25sb2FkID0gKCkgPT4gcmVzKFN0cmluZyhyLnJlc3VsdCkuc3BsaXQo' +
  'JywnKVsxXSk7CiAgICAgICAgICByLm9uZXJyb3IgPSAoKSA9PiByZWoobmV3IEVycm9yKCdDb3VsZCBub3QgcmVhZCB0aGF0IGZp' +
  'bGUnKSk7CiAgICAgICAgICByLnJlYWRBc0RhdGFVUkwoZmlsZSk7CiAgICAgICAgfSk7CiAgICAgICAgY29uc3Qgb3V0ID0gYXdh' +
  'aXQgYXBpKCcvcGFyc2UtZG9jdW1lbnQnLCB7CiAgICAgICAgICBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnko' +
  'eyBuYW1lOiBmaWxlLm5hbWUsIGRhdGEgfSkKICAgICAgICB9KTsKICAgICAgICBpZiAob3V0Lndhcm5pbmcpIHsgcGRmTXNnLmlu' +
  'bmVySFRNTCA9ICc8YiBzdHlsZT0iY29sb3I6dmFyKC0td2FybikiPicgKyBlc2Mob3V0Lndhcm5pbmcpICsgJzwvYj4nOyByZXR1' +
  'cm47IH0KICAgICAgICBjb25zdCBmaWxsZWQgPSBbXSwgc2tpcHBlZCA9IFtdLCBtaXNzZWQgPSBbXTsKICAgICAgICBmb3IgKGNv' +
  'bnN0IGYgb2YgRklMTEFCTEUpIHsKICAgICAgICAgIGNvbnN0IGlucHV0ID0gZWwucXVlcnlTZWxlY3RvcignI2ZfJyArIGYpOwog' +
  'ICAgICAgICAgaWYgKCFpbnB1dCkgY29udGludWU7CiAgICAgICAgICBjb25zdCB2YWwgPSBvdXQuZmllbGRzW2ZdOwogICAgICAg' +
  'ICAgaWYgKCF2YWwpIHsgbWlzc2VkLnB1c2goTEFCRUxTW2ZdKTsgY29udGludWU7IH0KICAgICAgICAgIGlmIChpbnB1dC52YWx1' +
  'ZSAmJiBpbnB1dC52YWx1ZS50cmltKCkgJiYgaW5wdXQudmFsdWUudHJpbSgpICE9PSBTdHJpbmcodmFsKS50cmltKCkpIHsKICAg' +
  'ICAgICAgICAgc2tpcHBlZC5wdXNoKExBQkVMU1tmXSk7CiAgICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgICAgfQogICAgICAg' +
  'ICAgaW5wdXQudmFsdWUgPSB2YWw7CiAgICAgICAgICBpbnB1dC5zdHlsZS5iYWNrZ3JvdW5kID0gJyNlOWY2ZWUnOwogICAgICAg' +
  'ICAgc2V0VGltZW91dCgoKSA9PiB7IGlucHV0LnN0eWxlLmJhY2tncm91bmQgPSAnJzsgfSwgNDAwMCk7CiAgICAgICAgICBmaWxs' +
  'ZWQucHVzaChMQUJFTFNbZl0pOwogICAgICAgIH0KICAgICAgICBsZXQgbXNnOwogICAgICAgIGlmIChmaWxsZWQubGVuZ3RoKSB7' +
  'CiAgICAgICAgICBtc2cgPSAnPGIgc3R5bGU9ImNvbG9yOnZhcigtLW9rKSI+RmlsbGVkICcgKyBmaWxsZWQubGVuZ3RoICsgJyBm' +
  'aWVsZCcgKyAoZmlsbGVkLmxlbmd0aCA9PT0gMSA/ICcnIDogJ3MnKSArCiAgICAgICAgICAgICc8L2I+IGZyb20gJyArIGVzYyhm' +
  'aWxlLm5hbWUpICsgJyAoJyArIChvdXQucGFnZXMgfHwgJz8nKSArICcgcGFnZScgKyAob3V0LnBhZ2VzID09PSAxID8gJycgOiAn' +
  'cycpICsgJyk6ICcgKwogICAgICAgICAgICBlc2MoZmlsbGVkLmpvaW4oJywgJykpICsgJy4nOwogICAgICAgIH0gZWxzZSBpZiAo' +
  'c2tpcHBlZC5sZW5ndGgpIHsKICAgICAgICAgIG1zZyA9ICc8YiBzdHlsZT0iY29sb3I6dmFyKC0td2FybikiPkV2ZXJ5dGhpbmcg' +
  'SSBmb3VuZCB3YXMgYWxyZWFkeSBmaWxsZWQgaW48L2I+IOKAlCBub3RoaW5nIG9mIHlvdXJzIHdhcyAnICsKICAgICAgICAgICAg' +
  'J292ZXJ3cml0dGVuLiBDbGVhciBhIGZpZWxkIGZpcnN0IGlmIHlvdSB3YW50IHRoZSBkb2N1bWVudFwncyB2ZXJzaW9uIG9mIGl0' +
  'Lic7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIG1zZyA9ICc8YiBzdHlsZT0iY29sb3I6dmFyKC0td2FybikiPk5vdGhpbmcg' +
  'cmVjb2duaXNhYmxlIGZvdW5kPC9iPiBpbiAnICsgZXNjKGZpbGUubmFtZSkgKwogICAgICAgICAgICAnLiBJdCBtYXkgYmUgbGFp' +
  'ZCBvdXQgZGlmZmVyZW50bHkgdG8gdGhlIGRvY3VtZW50cyB0aGlzIGNhbiByZWFkIOKAlCBmaWxsIHRoZSBqb2IgaW4gYnkgaGFu' +
  'ZC4nOwogICAgICAgIH0KICAgICAgICBpZiAoZmlsbGVkLmxlbmd0aCAmJiBza2lwcGVkLmxlbmd0aCkgbXNnICs9ICcgTGVmdCB5' +
  'b3VyIGV4aXN0aW5nICcgKyBlc2Moc2tpcHBlZC5qb2luKCcsICcpKSArICcgYWxvbmUuJzsKICAgICAgICBpZiAobWlzc2VkLmxl' +
  'bmd0aCkgbXNnICs9ICcgTm90IGZvdW5kOiAnICsgZXNjKG1pc3NlZC5qb2luKCcsICcpKSArICcuJzsKICAgICAgICBtc2cgKz0g' +
  'Jzxicj48Yj5DaGVjayBldmVyeSBmaWxsZWQgZmllbGQgYWdhaW5zdCB0aGUgZG9jdW1lbnQgYmVmb3JlIHNhdmluZy48L2I+JzsK' +
  'ICAgICAgICBwZGZNc2cuaW5uZXJIVE1MID0gbXNnOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICBwZGZNc2cuaW5uZXJI' +
  'VE1MID0gJzxiIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQpIj4nICsgZXNjKGVyci5tZXNzYWdlKSArICc8L2I+JzsKICAgICAgfQog' +
  'ICAgfTsKCiAgICAvLyBhdXRvLWZpbGwgZmVlL3BheSBkZWZhdWx0cyBmcm9tIHRoZSBzZWxlY3RlZCBjbGllbnQgLyBzZXJ2ZXIK' +
  'ICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNmX2NsaWVudF9pZCcpLm9uY2hhbmdlID0gZSA9PiB7CiAgICAgIGNvbnN0IGMgPSBjbGll' +
  'bnRzLmZpbmQoeCA9PiBTdHJpbmcoeC5pZCkgPT09IGUudGFyZ2V0LnZhbHVlKTsKICAgICAgaWYgKGMgJiYgYy5kZWZhdWx0X2Zl' +
  'ZSAmJiAhZWwucXVlcnlTZWxlY3RvcignI2ZfY2xpZW50X2ZlZScpLnZhbHVlKQogICAgICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNm' +
  'X2NsaWVudF9mZWUnKS52YWx1ZSA9IE51bWJlcihjLmRlZmF1bHRfZmVlKS50b0ZpeGVkKDIpOwogICAgfTsKICAgIGVsLnF1ZXJ5' +
  'U2VsZWN0b3IoJyNmX2Fzc2lnbmVkX3RvJykub25jaGFuZ2UgPSBlID0+IHsKICAgICAgY29uc3QgdSA9IHVzZXJzLmZpbmQoeCA9' +
  'PiBTdHJpbmcoeC5pZCkgPT09IGUudGFyZ2V0LnZhbHVlKTsKICAgICAgaWYgKHUgJiYgdS5kZWZhdWx0X3BheSAmJiAhZWwucXVl' +
  'cnlTZWxlY3RvcignI2Zfc2VydmVyX3BheScpLnZhbHVlKQogICAgICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNmX3NlcnZlcl9wYXkn' +
  'KS52YWx1ZSA9IE51bWJlcih1LmRlZmF1bHRfcGF5KS50b0ZpeGVkKDIpOwogICAgfTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNz' +
  'YXZlJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgYm9keSA9IHt9OwogICAgICBbJ2NsaWVudF9pZCcsJ2Fz' +
  'c2lnbmVkX3RvJywncmVjaXBpZW50X25hbWUnLCdhZGRyZXNzMScsJ2FkZHJlc3MyJywnY2l0eScsJ3N0YXRlJywnemlwJywncmVj' +
  'aXBpZW50X25vdGVzJywKICAgICAgICdjYXNlX251bWJlcicsJ2NvdXJ0JywncGxhaW50aWZmJywnZGVmZW5kYW50JywnZG9jdW1l' +
  'bnRzJywnc2VydmljZV90eXBlJywncHJpb3JpdHknLCdkdWVfZGF0ZScsCiAgICAgICAnY2xpZW50X2ZlZScsJ3NlcnZlcl9wYXkn' +
  'LCdzdGF0dXMnLCdub3RlcyddLmZvckVhY2goZiA9PiB7IGJvZHlbZl0gPSBlbC5xdWVyeVNlbGVjdG9yKCcjZl8nICsgZikudmFs' +
  'dWU7IH0pOwogICAgICBpZiAoIWJvZHkucmVjaXBpZW50X25hbWUudHJpbSgpKSByZXR1cm4gdG9hc3QoJ1dobyBhcmUgd2Ugc2Vy' +
  'dmluZz8nLCB0cnVlKTsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBzYXZlZCA9IGpvYgogICAgICAgICAgPyBhd2FpdCBhcGko' +
  'Jy9qb2JzLycgKyBqb2IuaWQsIHsgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KQogICAgICAg' +
  'ICAgOiBhd2FpdCBhcGkoJy9qb2JzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSk7CiAg' +
  'ICAgICAgY2xvc2VTaGVldCgpOyB0b2FzdChqb2IgPyAnU2F2ZWQnIDogJ0pvYiAnICsgc2F2ZWQuam9iX251bWJlciArICcgY3Jl' +
  'YXRlZCcpOwogICAgICAgIGdvKCdqb2InLCB7IGlkOiBzYXZlZC5pZCB9KTsKICAgICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1l' +
  'c3NhZ2UsIHRydWUpOyB9CiAgICB9OwogICAgaWYgKGVsLnF1ZXJ5U2VsZWN0b3IoJyNkZWwnKSkgZWwucXVlcnlTZWxlY3Rvcign' +
  'I2RlbCcpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGlmICghY29uZmlybSgnRGVsZXRlIHRoaXMgam9iIGFuZCBhbGwg' +
  'aXRzIGF0dGVtcHRzPycpKSByZXR1cm47CiAgICAgIGF3YWl0IGFwaSgnL2pvYnMvJyArIGpvYi5pZCwgeyBtZXRob2Q6ICdERUxF' +
  'VEUnIH0pOwogICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KCdEZWxldGVkJyk7IGdvKCdqb2JzJyk7CiAgICB9OwogIH0pOwp9Cgov' +
  'KiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGpvYiBkZXRhaWwgLS0g' +
  'Ki8KYXN5bmMgZnVuY3Rpb24gam9iVmlldygpIHsKICBjb25zdCBqID0gYXdhaXQgYXBpKCcvam9icy8nICsgUy5wYXJhbXMuaWQp' +
  'OwogIGNvbnN0IGFkZHIgPSBhZGRyT2Yoaik7CiAgY29uc3QgZG9uZSA9IFsnU2VydmVkJywgJ05vbi1Fc3QnLCAnQ2FuY2VsbGVk' +
  'J10uaW5jbHVkZXMoai5zdGF0dXMpOwoKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGRpdiBjbGFzcz0icm93IiBzdHls' +
  'ZT0ibWFyZ2luLWJvdHRvbTo4cHgiPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gZ2hvc3QiIGlkPSJiYWNrIj7igLkgQmFjazwv' +
  'YnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJzcGFjZXIiIHN0eWxlPSJmbGV4OjEiPjwvZGl2PgogICAgICA8c3BhbiBjbGFzcz0i' +
  'cGlsbCAke2NscyhqLnN0YXR1cyl9Ij4ke2VzYyhqLnN0YXR1cyl9PC9zcGFuPgogICAgICAke2oucHJpb3JpdHkgIT09ICdSb3V0' +
  'aW5lJyA/IGA8c3BhbiBjbGFzcz0icGlsbCBydXNoIj4ke2VzYyhqLnByaW9yaXR5KX08L3NwYW4+YCA6ICcnfQogICAgPC9kaXY+' +
  'CiAgICA8aDEgY2xhc3M9InBhZ2UiIHN0eWxlPSJtYXJnaW4tdG9wOjAiPiR7ZXNjKGoucmVjaXBpZW50X25hbWUpfTwvaDE+Cgog' +
  'ICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9Im0iIHN0eWxlPSJjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1z' +
  'aXplOjEzcHg7bWFyZ2luLWJvdHRvbTo4cHgiPiR7ZXNjKGouam9iX251bWJlcil9IMK3ICR7ZXNjKGouY2xpZW50X25hbWUgfHwg' +
  'J05vIGNsaWVudCcpfTwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJmb250LXNpemU6MTVweDtmb250LXdlaWdodDo2MDAiPiR7ZXNj' +
  'KGFkZHIgfHwgJ05vIGFkZHJlc3Mgb24gZmlsZScpfTwvZGl2PgogICAgICAke2oucmVjaXBpZW50X25vdGVzID8gYDxkaXYgY2xh' +
  'c3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjZweCI+JHtlc2Moai5yZWNpcGllbnRfbm90ZXMpfTwvZGl2PmAgOiAnJ30KICAg' +
  'ICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gbmF2' +
  'IiBpZD0ibmF2QnRuIiAke2FkZHIgPyAnJyA6ICdkaXNhYmxlZCd9Pk5hdmlnYXRlIOKWuDwvYnV0dG9uPgogICAgICAgICR7IWRv' +
  'bmUgPyAnPGJ1dHRvbiBjbGFzcz0iYnRuIG9rIiBpZD0iYXR0QnRuIj5Mb2cgYXR0ZW1wdDwvYnV0dG9uPicgOiAnJ30KICAgICAg' +
  'PC9kaXY+CiAgICAgICR7YWRkciA/IGA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPk9wZW5zICR7aXNJ' +
  'T1MoKSA/ICdBcHBsZSBNYXBzJyA6ICdHb29nbGUgTWFwcyd9IMK3CiAgICAgICAgPGEgaHJlZj0iJHtpc0lPUygpID8gZ29vZ2xl' +
  'VXJsKGFkZHIpIDogYXBwbGVVcmwoYWRkcil9IiB0YXJnZXQ9Il9ibGFuayI+dXNlICR7aXNJT1MoKSA/ICdHb29nbGUnIDogJ0Fw' +
  'cGxlJ30gTWFwcyBpbnN0ZWFkPC9hPjwvZGl2PmAgOiAnJ30KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAg' +
  'ICA8aDI+QXR0ZW1wdHMgPHNwYW4gY2xhc3M9InN1YiI+JHtqLmF0dGVtcHRzLmxlbmd0aH08L3NwYW4+PC9oMj4KICAgICAgJHtq' +
  'LmF0dGVtcHRzLmxlbmd0aCA/IGouYXR0ZW1wdHMubWFwKGEgPT4gYAogICAgICAgIDxkaXYgY2xhc3M9ImF0dCAke2NscyhhLm91' +
  'dGNvbWUpfSI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJoIj4ke2VzYyhhLm91dGNvbWUpfSR7YS5tYW5uZXIgPyAnIOKAlCAnICsg' +
  'ZXNjKGEubWFubmVyKSA6ICcnfTwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0ibSI+JHtmbXREVChhLmF0dGVtcHRlZF9hdCl9' +
  'IMK3ICR7ZXNjKGEuc2VydmVyX25hbWUgfHwgJycpfTwvZGl2PgogICAgICAgICAgJHthLnBlcnNvbl9zZXJ2ZWQgPyBgPGRpdiBj' +
  'bGFzcz0ibSI+U2VydmVkOiAke2VzYyhhLnBlcnNvbl9zZXJ2ZWQpfSR7YS5yZWxhdGlvbnNoaXAgPyAnICgnICsgZXNjKGEucmVs' +
  'YXRpb25zaGlwKSArICcpJyA6ICcnfTwvZGl2PmAgOiAnJ30KICAgICAgICAgICR7YS5kZXNjcmlwdGlvbiA/IGA8ZGl2IGNsYXNz' +
  'PSJtIj5EZXNjcmlwdGlvbjogJHtlc2MoYS5kZXNjcmlwdGlvbil9PC9kaXY+YCA6ICcnfQogICAgICAgICAgJHthLm5vdGVzID8g' +
  'YDxkaXYgY2xhc3M9Im0iPiR7ZXNjKGEubm90ZXMpfTwvZGl2PmAgOiAnJ30KICAgICAgICAgICR7YS5sYXQgIT0gbnVsbCA/IGA8' +
  'ZGl2IGNsYXNzPSJtIj5HUFMgJHtOdW1iZXIoYS5sYXQpLnRvRml4ZWQoNSl9LCAke051bWJlcihhLmxuZykudG9GaXhlZCg1KX0K' +
  'ICAgICAgICAgICAgJHthLmFjY3VyYWN5X20gPyAnwrEnICsgTWF0aC5yb3VuZChhLmFjY3VyYWN5X20pICsgJ20nIDogJyd9IMK3' +
  'CiAgICAgICAgICAgIDxhIGhyZWY9Imh0dHBzOi8vd3d3Lmdvb2dsZS5jb20vbWFwcz9xPSR7YS5sYXR9LCR7YS5sbmd9IiB0YXJn' +
  'ZXQ9Il9ibGFuayI+bWFwPC9hPjwvZGl2PmAgOiAnJ30KICAgICAgICAgICR7cGhvdG9TdHJpcChhLCBqKX0KICAgICAgICA8L2Rp' +
  'dj5gKS5qb2luKCcnKQogICAgICAgIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij5ObyBhdHRlbXB0cyBsb2dnZWQgeWV0LjwvZGl2Pid9' +
  'CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPlBhcGVyd29yazwvaDI+CiAgICAgIDxkaXYgY2xh' +
  'c3M9InJvdyI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9ImFmZkJ0biI+QWZmaWRhdml0PC9idXR0b24+' +
  'CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9InJlcG9ydEJ0biI+Q2xpZW50IHJlcG9ydDwvYnV0dG9uPgog' +
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
  'dFNoZWV0KGopOwogICQoJyNyZXBvcnRCdG4nKS5vbmNsaWNrID0gKCkgPT4gd2luZG93Lm9wZW4oJy9wcmludC9yZXBvcnQvJyAr' +
  'IGouaWQsICdfYmxhbmsnKTsKICBpZiAoJCgnI2xvb2t1cEJ0bicpKSAkKCcjbG9va3VwQnRuJykub25jbGljayA9ICgpID0+IGNh' +
  'c2VMb29rdXBTaGVldChqKTsKICBiaW5kUGhvdG9TdHJpcHMoaik7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIHBob3RvcyAtLSAqLwovKiBBIHBob25lIGNhbWVyYSBtYWtlcyBhIDRNQiwg' +
  'NDAwMHB4IHBpY3R1cmUuIE5vYm9keSBuZWVkcyB0aGF0IHRvIHByb3ZlIGEKICogZG9vciB3YXMga25vY2tlZCBvbiwgYW5kIHNl' +
  'bmRpbmcgaXQgb3ZlciBhIHBhcmtpbmctbG90IHNpZ25hbCBpcyBob3cgYQogKiBzZXJ2ZXIgZ2l2ZXMgdXAgYW5kIHN0b3BzIHRh' +
  'a2luZyBwaG90b3MgYXQgYWxsLiBTbyBldmVyeSBzaG90IGlzIGRyYXduCiAqIGludG8gYSBjYW52YXMgYXQgMTYwMHB4IG9uIGl0' +
  'cyBsb25nIHNpZGUgYW5kIHJlLWVuY29kZWQgYXMgSlBFRyBiZWZvcmUgaXQKICogbGVhdmVzIHRoZSBwaG9uZSDigJQgYWJvdXQg' +
  'MjUwS0IsIHN0aWxsIHNoYXJwIGVub3VnaCB0byByZWFkIGEgaG91c2UgbnVtYmVyLiAqLwpjb25zdCBQSE9UT19NQVhfRURHRSA9' +
  'IDE2MDA7CmNvbnN0IFBIT1RPX1FVQUxJVFkgPSAwLjcyOwoKZnVuY3Rpb24gc2hyaW5rUGhvdG8oZmlsZSkgewogIHJldHVybiBu' +
  'ZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7CiAgICBjb25zdCBpbWcgPSBuZXcgSW1hZ2UoKTsKICAgIGNvbnN0IHVy' +
  'bCA9IFVSTC5jcmVhdGVPYmplY3RVUkwoZmlsZSk7CiAgICBpbWcub25sb2FkID0gKCkgPT4gewogICAgICBVUkwucmV2b2tlT2Jq' +
  'ZWN0VVJMKHVybCk7CiAgICAgIGNvbnN0IHNjYWxlID0gTWF0aC5taW4oMSwgUEhPVE9fTUFYX0VER0UgLyBNYXRoLm1heChpbWcu' +
  'd2lkdGgsIGltZy5oZWlnaHQpKTsKICAgICAgY29uc3QgdyA9IE1hdGgucm91bmQoaW1nLndpZHRoICogc2NhbGUpLCBoID0gTWF0' +
  'aC5yb3VuZChpbWcuaGVpZ2h0ICogc2NhbGUpOwogICAgICBjb25zdCBjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnY2FudmFz' +
  'Jyk7CiAgICAgIGMud2lkdGggPSB3OyBjLmhlaWdodCA9IGg7CiAgICAgIGMuZ2V0Q29udGV4dCgnMmQnKS5kcmF3SW1hZ2UoaW1n' +
  'LCAwLCAwLCB3LCBoKTsKICAgICAgY29uc3QgZGF0YSA9IGMudG9EYXRhVVJMKCdpbWFnZS9qcGVnJywgUEhPVE9fUVVBTElUWSku' +
  'c3BsaXQoJywnKVsxXTsKICAgICAgaWYgKCFkYXRhKSByZXR1cm4gcmVqZWN0KG5ldyBFcnJvcignVGhpcyBwaG9uZSBjb3VsZCBu' +
  'b3QgcHJvY2VzcyB0aGF0IHBob3RvJykpOwogICAgICByZXNvbHZlKHsgZGF0YSwgbWltZTogJ2ltYWdlL2pwZWcnLCB3aWR0aDog' +
  'dywgaGVpZ2h0OiBoIH0pOwogICAgfTsKICAgIGltZy5vbmVycm9yID0gKCkgPT4geyBVUkwucmV2b2tlT2JqZWN0VVJMKHVybCk7' +
  'IHJlamVjdChuZXcgRXJyb3IoJ1RoYXQgZmlsZSBpcyBub3QgYSBwaG90bycpKTsgfTsKICAgIGltZy5zcmMgPSB1cmw7CiAgfSk7' +
  'Cn0KCi8vIFVwbG9hZHMgb25lIGF0IGEgdGltZTogYSBzZXJ2ZXIgb24gYSB3ZWFrIHNpZ25hbCBnZXRzIHBhcnRpYWwgc3VjY2Vz' +
  'cyByYXRoZXIKLy8gdGhhbiBvbmUgZ2lhbnQgcmVxdWVzdCB0aGF0IGZhaWxzIHdob2xlLgphc3luYyBmdW5jdGlvbiB1cGxvYWRQ' +
  'aG90b3MoYXR0ZW1wdElkLCBmaWxlcywgb25Qcm9ncmVzcykgewogIGNvbnN0IGRvbmUgPSBbXTsKICBmb3IgKGxldCBpID0gMDsg' +
  'aSA8IGZpbGVzLmxlbmd0aDsgaSsrKSB7CiAgICBpZiAob25Qcm9ncmVzcykgb25Qcm9ncmVzcyhpICsgMSwgZmlsZXMubGVuZ3Ro' +
  'KTsKICAgIGNvbnN0IHNob3QgPSBhd2FpdCBzaHJpbmtQaG90byhmaWxlc1tpXSk7CiAgICBkb25lLnB1c2goYXdhaXQgYXBpKCcv' +
  'YXR0ZW1wdHMvJyArIGF0dGVtcHRJZCArICcvcGhvdG9zJywgewogICAgICBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJp' +
  'bmdpZnkoc2hvdCkKICAgIH0pKTsKICB9CiAgcmV0dXJuIGRvbmU7Cn0KCmZ1bmN0aW9uIHBob3RvU3RyaXAoYSwgam9iKSB7CiAg' +
  'Y29uc3QgY2FuRWRpdCA9ICFqb2IucGhvdG9zX2hpZGRlbiAmJiAoaXNBZG1pbigpIHx8IGpvYi5hc3NpZ25lZF90byA9PT0gUy5t' +
  'ZS5pZCk7CiAgaWYgKGpvYi5waG90b3NfaGlkZGVuKSB7CiAgICByZXR1cm4gYS5waG90b19jb3VudAogICAgICA/IGA8ZGl2IGNs' +
  'YXNzPSJtIHBob3RvLWhpZGRlbiI+JHthLnBob3RvX2NvdW50fSBwaG90byR7YS5waG90b19jb3VudCA+IDEgPyAncycgOiAnJ30g' +
  '4oCUIGhpZGRlbiBpbiBzdXBwb3J0IHZpZXc8L2Rpdj5gCiAgICAgIDogJyc7CiAgfQogIGNvbnN0IHRodW1icyA9IChhLnBob3Rv' +
  'cyB8fCBbXSkubWFwKHAgPT4KICAgIGA8YnV0dG9uIGNsYXNzPSJ0aHVtYiIgZGF0YS1waG90bz0iJHtwLmlkfSIgdGl0bGU9IiR7' +
  'ZXNjKHAuY2FwdGlvbiB8fCAnJyl9Ij4KICAgICAgIDxpbWcgc3JjPSIvcGhvdG8vJHtwLmlkfSIgYWx0PSIke2VzYyhwLmNhcHRp' +
  'b24gfHwgJ0F0dGVtcHQgcGhvdG8nKX0iIGxvYWRpbmc9ImxhenkiPgogICAgICAgJHtwLmNhcHRpb24gPyBgPHNwYW4gY2xhc3M9' +
  'ImNhcCI+JHtlc2MocC5jYXB0aW9uKX08L3NwYW4+YCA6ICcnfQogICAgIDwvYnV0dG9uPmApLmpvaW4oJycpOwogIHJldHVybiBg' +
  'PGRpdiBjbGFzcz0icGhvdG9zIiBkYXRhLWF0dGVtcHQ9IiR7YS5pZH0iPgogICAgJHt0aHVtYnN9CiAgICAke2NhbkVkaXQgPyBg' +
  'PGJ1dHRvbiBjbGFzcz0idGh1bWIgYWRkIiBkYXRhLWFkZD0iJHthLmlkfSI+77yLPHNwYW4+UGhvdG88L3NwYW4+PC9idXR0b24+' +
  'YCA6ICcnfQogIDwvZGl2PmA7Cn0KCmZ1bmN0aW9uIGJpbmRQaG90b1N0cmlwcyhqb2IpIHsKICBkb2N1bWVudC5xdWVyeVNlbGVj' +
  'dG9yQWxsKCdbZGF0YS1waG90b10nKS5mb3JFYWNoKGIgPT4gewogICAgYi5vbmNsaWNrID0gKCkgPT4gcGhvdG9WaWV3ZXIoam9i' +
  'LCBOdW1iZXIoYi5kYXRhc2V0LnBob3RvKSk7CiAgfSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWRkXScp' +
  'LmZvckVhY2goYiA9PiB7CiAgICBiLm9uY2xpY2sgPSAoKSA9PiBwaWNrUGhvdG9zKGFzeW5jIGZpbGVzID0+IHsKICAgICAgY29u' +
  'c3QgbGFiZWwgPSBiLnF1ZXJ5U2VsZWN0b3IoJ3NwYW4nKTsKICAgICAgY29uc3Qgd2FzID0gbGFiZWwudGV4dENvbnRlbnQ7CiAg' +
  'ICAgIGIuZGlzYWJsZWQgPSB0cnVlOwogICAgICB0cnkgewogICAgICAgIGF3YWl0IHVwbG9hZFBob3RvcyhOdW1iZXIoYi5kYXRh' +
  'c2V0LmFkZCksIGZpbGVzLAogICAgICAgICAgKG4sIHRvdGFsKSA9PiB7IGxhYmVsLnRleHRDb250ZW50ID0gbiArICcvJyArIHRv' +
  'dGFsOyB9KTsKICAgICAgICB0b2FzdChmaWxlcy5sZW5ndGggPiAxID8gZmlsZXMubGVuZ3RoICsgJyBwaG90b3MgYWRkZWQnIDog' +
  'J1Bob3RvIGFkZGVkJyk7CiAgICAgICAgZ28oJ2pvYicsIHsgaWQ6IGpvYi5pZCB9KTsKICAgICAgfSBjYXRjaCAoZSkgewogICAg' +
  'ICAgIGIuZGlzYWJsZWQgPSBmYWxzZTsgbGFiZWwudGV4dENvbnRlbnQgPSB3YXM7CiAgICAgICAgdG9hc3QoZS5tZXNzYWdlLCB0' +
  'cnVlKTsKICAgICAgfQogICAgfSk7CiAgfSk7Cn0KCi8vIE9uZSBoaWRkZW4gaW5wdXQsIHJldXNlZC4gY2FwdHVyZT0iZW52aXJv' +
  'bm1lbnQiIG9wZW5zIHRoZSByZWFyIGNhbWVyYQovLyBzdHJhaWdodCBhd2F5IG9uIGEgcGhvbmU7IG9uIGEgZGVza3RvcCBpdCBp' +
  'cyBhbiBvcmRpbmFyeSBmaWxlIHBpY2tlci4KZnVuY3Rpb24gcGlja1Bob3RvcyhvblBpY2tlZCkgewogIGNvbnN0IGlucCA9IGRv' +
  'Y3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7CiAgaW5wLnR5cGUgPSAnZmlsZSc7CiAgaW5wLmFjY2VwdCA9ICdpbWFnZS8q' +
  'JzsKICBpbnAubXVsdGlwbGUgPSB0cnVlOwogIGlucC5zZXRBdHRyaWJ1dGUoJ2NhcHR1cmUnLCAnZW52aXJvbm1lbnQnKTsKICBp' +
  'bnAuc3R5bGUuZGlzcGxheSA9ICdub25lJzsKICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGlucCk7CiAgaW5wLm9uY2hhbmdl' +
  'ID0gKCkgPT4gewogICAgY29uc3QgZmlsZXMgPSBBcnJheS5mcm9tKGlucC5maWxlcyB8fCBbXSk7CiAgICBpbnAucmVtb3ZlKCk7' +
  'CiAgICBpZiAoZmlsZXMubGVuZ3RoKSBvblBpY2tlZChmaWxlcyk7CiAgfTsKICBpbnAuY2xpY2soKTsKfQoKZnVuY3Rpb24gcGhv' +
  'dG9WaWV3ZXIoam9iLCBpZCkgewogIGNvbnN0IGFsbCA9IGpvYi5hdHRlbXB0cy5mbGF0TWFwKGEgPT4gYS5waG90b3MgfHwgW10p' +
  'OwogIGNvbnN0IHAgPSBhbGwuZmluZCh4ID0+IHguaWQgPT09IGlkKTsKICBpZiAoIXApIHJldHVybjsKICBjb25zdCBjYW5FZGl0' +
  'ID0gaXNBZG1pbigpIHx8IGpvYi5hc3NpZ25lZF90byA9PT0gUy5tZS5pZDsKICBzaGVldCgnUGhvdG8nLCBgCiAgICA8aW1nIHNy' +
  'Yz0iL3Bob3RvLyR7cC5pZH0iIGFsdD0iIiBzdHlsZT0id2lkdGg6MTAwJTtib3JkZXItcmFkaXVzOjEycHg7ZGlzcGxheTpibG9j' +
  'ayI+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+PGxhYmVsPkNhcHRpb248L2xhYmVsPgog' +
  'ICAgICA8aW5wdXQgaWQ9InBfY2FwIiB2YWx1ZT0iJHtlc2MocC5jYXB0aW9uIHx8ICcnKX0iIHBsYWNlaG9sZGVyPSJGcm9udCBk' +
  'b29yLCBubyBhbnN3ZXIiCiAgICAgICAgJHtjYW5FZGl0ID8gJycgOiAnZGlzYWJsZWQnfT48L2Rpdj4KICAgIDxkaXYgY2xhc3M9' +
  'ImhpbnQiPiR7TWF0aC5yb3VuZChwLmJ5dGVzIC8gMTAyNCl9IEtCIMK3IGFkZGVkICR7Zm10RFQocC5jcmVhdGVkX2F0KX08L2Rp' +
  'dj4KICAgICR7Y2FuRWRpdCA/IGA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPgogICAgICA8YnV0dG9u' +
  'IGNsYXNzPSJidG4iIGlkPSJwX3NhdmUiPlNhdmUgY2FwdGlvbjwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2Vj' +
  'IiBpZD0icF9kZWwiPkRlbGV0ZSBwaG90bzwvYnV0dG9uPgogICAgPC9kaXY+YCA6ICcnfWAsIGVsID0+IHsKICAgIGlmICghY2Fu' +
  'RWRpdCkgcmV0dXJuOwogICAgZWwucXVlcnlTZWxlY3RvcignI3Bfc2F2ZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAg' +
  'IHRyeSB7CiAgICAgICAgYXdhaXQgYXBpKCcvcGhvdG9zLycgKyBwLmlkLCB7CiAgICAgICAgICBtZXRob2Q6ICdQQVRDSCcsIGJv' +
  'ZHk6IEpTT04uc3RyaW5naWZ5KHsgY2FwdGlvbjogZWwucXVlcnlTZWxlY3RvcignI3BfY2FwJykudmFsdWUgfSkKICAgICAgICB9' +
  'KTsKICAgICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KCdDYXB0aW9uIHNhdmVkJyk7IGdvKCdqb2InLCB7IGlkOiBqb2IuaWQgfSk7' +
  'CiAgICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogICAgfTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3Io' +
  'JyNwX2RlbCcpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGlmICghY29uZmlybSgnRGVsZXRlIHRoaXMgcGhvdG8/IEl0' +
  'IGlzIHBhcnQgb2YgdGhlIHJlY29yZCBmb3IgdGhpcyBhdHRlbXB0LicpKSByZXR1cm47CiAgICAgIHRyeSB7CiAgICAgICAgYXdh' +
  'aXQgYXBpKCcvcGhvdG9zLycgKyBwLmlkLCB7IG1ldGhvZDogJ0RFTEVURScgfSk7CiAgICAgICAgY2xvc2VTaGVldCgpOyB0b2Fz' +
  'dCgnUGhvdG8gZGVsZXRlZCcpOyBnbygnam9iJywgeyBpZDogam9iLmlkIH0pOwogICAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUu' +
  'bWVzc2FnZSwgdHJ1ZSk7IH0KICAgIH07CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0gbG9nIGF0dGVtcHQgLS0gKi8KY29uc3QgT1VUQ09NRVMgPSBbJ1NlcnZlZCcsICdObyBBbnN3ZXIn' +
  'LCAnQmFkIEFkZHJlc3MnLCAnTW92ZWQnLCAnUmVmdXNlZCcsICdFdmFkaW5nJywgJ090aGVyJ107CgpmdW5jdGlvbiBhdHRlbXB0' +
  'Rm9ybShqb2IpIHsKICBzaGVldCgnTG9nIGF0dGVtcHQg4oCUICcgKyBqb2IucmVjaXBpZW50X25hbWUsIGAKICAgIDxkaXYgY2xh' +
  'c3M9ImZpZWxkIj48bGFiZWw+T3V0Y29tZTwvbGFiZWw+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgaWQ9Im91dGNvbWVzIj4ke09V' +
  'VENPTUVTLm1hcChvID0+CiAgICAgICAgYDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGRhdGEtbz0iJHtvfSI+JHtvfTwvYnV0' +
  'dG9uPmApLmpvaW4oJycpfTwvZGl2PjwvZGl2PgogICAgPGRpdiBpZD0ic2VydmVkRmllbGRzIiBzdHlsZT0iZGlzcGxheTpub25l' +
  'Ij4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5NYW5uZXI8L2xh' +
  'YmVsPjxzZWxlY3QgaWQ9ImFfbWFubmVyIj4KICAgICAgICAgICR7WydQZXJzb25hbCcsICdTdWJzdGl0dXRlJywgJ1Bvc3RlZCcs' +
  'ICdDb3Jwb3JhdGUnLCAnQ2VydGlmaWVkIE1haWwnXS5tYXAocyA9PiBgPG9wdGlvbj4ke3N9PC9vcHRpb24+YCkuam9pbignJyl9' +
  'PC9zZWxlY3Q+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5QZXJzb24gc2VydmVkPC9sYWJlbD48aW5w' +
  'dXQgaWQ9ImFfcGVyc29uX3NlcnZlZCIgdmFsdWU9IiR7ZXNjKGpvYi5yZWNpcGllbnRfbmFtZSl9Ij48L2Rpdj4KICAgICAgPC9k' +
  'aXY+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UmVsYXRpb25z' +
  'aGlwIChpZiBzdWJzdGl0dXRlKTwvbGFiZWw+PGlucHV0IGlkPSJhX3JlbGF0aW9uc2hpcCIgcGxhY2Vob2xkZXI9ImNvLXJlc2lk' +
  'ZW50LCBjby13b3JrZXIuLi4iPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RGVzY3JpcHRpb248L2xh' +
  'YmVsPjxpbnB1dCBpZD0iYV9kZXNjcmlwdGlvbiIgcGxhY2Vob2xkZXI9IlcvRiwgNDBzLCA1JzYmcXVvdDssIGJyb3duIGhhaXIi' +
  'PjwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Ob3RlczwvbGFiZWw+' +
  'PHRleHRhcmVhIGlkPSJhX25vdGVzIiBwbGFjZWhvbGRlcj0iTGlnaHRzIG9uLCBubyBhbnN3ZXIgYXQgZnJvbnQgZG9vci4gU2ls' +
  'dmVyIENpdmljIGluIGRyaXZld2F5LiI+PC90ZXh0YXJlYT48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+V2hl' +
  'cmUgPHNwYW4gY2xhc3M9ImhpbnQiPuKAlCBvbmx5IGlmIG5vdCB0aGUgYWRkcmVzcyBvbiB0aGUgam9iPC9zcGFuPjwvbGFiZWw+' +
  'CiAgICAgIDxpbnB1dCBpZD0iYV9hZGRyIiBwbGFjZWhvbGRlcj0iJHtlc2MoW2pvYi5hZGRyZXNzMSwgam9iLmNpdHldLmZpbHRl' +
  'cihCb29sZWFuKS5qb2luKCcsICcpKX0iPgogICAgICA8ZGl2IGNsYXNzPSJoaW50Ij5BIHdvcmsgYWRkcmVzcywgYSByZWxhdGl2' +
  'ZSdzIGhvdXNlLCB3aGVyZXZlciBhIG5laWdoYm91ciBzZW50IHlvdS4KICAgICAgICBJdCBnb2VzIG9uIHRoZSByZWNvcmQgYW5k' +
  'IHR1cm5zIHVwIG5leHQgdGltZSB5b3Ugc2VhcmNoIHRoaXMgcGVyc29uLjwvZGl2PjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmll' +
  'bGQiPjxsYWJlbD5XaGVuPC9sYWJlbD48aW5wdXQgaWQ9ImFfd2hlbiIgdHlwZT0iZGF0ZXRpbWUtbG9jYWwiIHZhbHVlPSIke2xv' +
  'Y2FsTm93KCl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOiNmOGZhZmM7Ym94LXNoYWRv' +
  'dzpub25lO21hcmdpbi1ib3R0b206MTJweCI+CiAgICAgIDxkaXYgY2xhc3M9InJvdyI+PGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBz' +
  'bSIgaWQ9Imdwc0J0biI+Q2FwdHVyZSBHUFM8L2J1dHRvbj4KICAgICAgPHNwYW4gY2xhc3M9ImhpbnQiIGlkPSJncHNPdXQiIHN0' +
  'eWxlPSJtYXJnaW46MCI+Tm90IGNhcHR1cmVkPC9zcGFuPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+' +
  'PGxhYmVsPlBob3RvczwvbGFiZWw+CiAgICAgIDxkaXYgY2xhc3M9InBob3RvcyIgaWQ9InBlbmRQaG90b3MiPgogICAgICAgIDxi' +
  'dXR0b24gY2xhc3M9InRodW1iIGFkZCIgaWQ9InBob3RvQnRuIiB0eXBlPSJidXR0b24iPu+8izxzcGFuPlBob3RvPC9zcGFuPjwv' +
  'YnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGludCI+VGhlIGRvb3IsIHRoZSBudW1iZXIsIHRoZSBub3Rp' +
  'Y2UsIHRoZSBjYXIuIFRoZXkgZ28gb24gdGhlIGF0dGVtcHQKICAgICAgYW5kIG9uIHRoZSByZXBvcnQgeW91ciBjbGllbnQgc2Vl' +
  'cy48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0ic2F2' +
  'ZUF0dCIgZGlzYWJsZWQ+UGljayBhbiBvdXRjb21lPC9idXR0b24+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIG9uY2xp' +
  'Y2s9ImNsb3NlU2hlZXQoKSI+Q2FuY2VsPC9idXR0b24+CiAgICA8L2Rpdj5gLCBlbCA9PiB7CiAgICBsZXQgb3V0Y29tZSA9IG51' +
  'bGwsIGdwcyA9IG51bGw7CiAgICAvKiBQaG90b3MgYXJlIHBpY2tlZCBiZWZvcmUgdGhlIGF0dGVtcHQgZXhpc3RzLCBzbyB0aGV5' +
  'IGFyZSBoZWxkIGhlcmUgYW5kCiAgICAgICB1cGxvYWRlZCBvbmNlIHNhdmluZyBnaXZlcyB1cyBhbiBhdHRlbXB0IGlkLiAqLwog' +
  'ICAgY29uc3QgcGVuZGluZyA9IFtdOwogICAgY29uc3Qgc3RyaXAgPSBlbC5xdWVyeVNlbGVjdG9yKCcjcGVuZFBob3RvcycpOwog' +
  'ICAgY29uc3QgYWRkQnRuID0gZWwucXVlcnlTZWxlY3RvcignI3Bob3RvQnRuJyk7CiAgICBjb25zdCBkcmF3UGVuZGluZyA9ICgp' +
  'ID0+IHsKICAgICAgc3RyaXAucXVlcnlTZWxlY3RvckFsbCgnLnBlbmQnKS5mb3JFYWNoKG4gPT4gbi5yZW1vdmUoKSk7CiAgICAg' +
  'IHBlbmRpbmcuZm9yRWFjaCgoZiwgaSkgPT4gewogICAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0' +
  'b24nKTsKICAgICAgICBiLnR5cGUgPSAnYnV0dG9uJzsKICAgICAgICBiLmNsYXNzTmFtZSA9ICd0aHVtYiBwZW5kJzsKICAgICAg' +
  'ICBiLnRpdGxlID0gJ1JlbW92ZSc7CiAgICAgICAgYi5pbm5lckhUTUwgPSBgPGltZyBzcmM9IiR7VVJMLmNyZWF0ZU9iamVjdFVS' +
  'TChmKX0iIGFsdD0iIj48c3BhbiBjbGFzcz0ieCI+w5c8L3NwYW4+YDsKICAgICAgICBiLm9uY2xpY2sgPSAoKSA9PiB7IHBlbmRp' +
  'bmcuc3BsaWNlKGksIDEpOyBkcmF3UGVuZGluZygpOyB9OwogICAgICAgIHN0cmlwLmluc2VydEJlZm9yZShiLCBhZGRCdG4pOwog' +
  'ICAgICB9KTsKICAgICAgYWRkQnRuLnF1ZXJ5U2VsZWN0b3IoJ3NwYW4nKS50ZXh0Q29udGVudCA9IHBlbmRpbmcubGVuZ3RoID8g' +
  'YFBob3RvICgke3BlbmRpbmcubGVuZ3RofSlgIDogJ1Bob3RvJzsKICAgIH07CiAgICBhZGRCdG4ub25jbGljayA9ICgpID0+IHBp' +
  'Y2tQaG90b3MoZmlsZXMgPT4geyBwZW5kaW5nLnB1c2goLi4uZmlsZXMpOyBkcmF3UGVuZGluZygpOyB9KTsKICAgIGVsLnF1ZXJ5' +
  'U2VsZWN0b3JBbGwoJ1tkYXRhLW9dJykuZm9yRWFjaChiID0+IGIub25jbGljayA9ICgpID0+IHsKICAgICAgb3V0Y29tZSA9IGIu' +
  'ZGF0YXNldC5vOwogICAgICBlbC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1vXScpLmZvckVhY2goeCA9PiB7IHguY2xhc3NOYW1l' +
  'ID0gJ2J0biBzZWMgc20nOyB9KTsKICAgICAgYi5jbGFzc05hbWUgPSAnYnRuIHNtJyArIChvdXRjb21lID09PSAnU2VydmVkJyA/' +
  'ICcgb2snIDogJycpOwogICAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2VydmVkRmllbGRzJykuc3R5bGUuZGlzcGxheSA9IG91dGNv' +
  'bWUgPT09ICdTZXJ2ZWQnID8gJycgOiAnbm9uZSc7CiAgICAgIGNvbnN0IHMgPSBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZUF0dCcp' +
  'OwogICAgICBzLmRpc2FibGVkID0gZmFsc2U7CiAgICAgIHMudGV4dENvbnRlbnQgPSBvdXRjb21lID09PSAnU2VydmVkJyA/ICdT' +
  'YXZlIOKAlCBtYXJrcyBqb2IgU0VSVkVEJyA6ICdTYXZlIGF0dGVtcHQnOwogICAgfSk7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcj' +
  'Z3BzQnRuJykub25jbGljayA9ICgpID0+IHsKICAgICAgY29uc3Qgb3V0ID0gZWwucXVlcnlTZWxlY3RvcignI2dwc091dCcpOwog' +
  'ICAgICBpZiAoIW5hdmlnYXRvci5nZW9sb2NhdGlvbikgcmV0dXJuIG91dC50ZXh0Q29udGVudCA9ICdOb3Qgc3VwcG9ydGVkIG9u' +
  'IHRoaXMgZGV2aWNlJzsKICAgICAgb3V0LnRleHRDb250ZW50ID0gJ0xvY2F0aW5n4oCmJzsKICAgICAgbmF2aWdhdG9yLmdlb2xv' +
  'Y2F0aW9uLmdldEN1cnJlbnRQb3NpdGlvbihwb3MgPT4gewogICAgICAgIGdwcyA9IHsgbGF0OiBwb3MuY29vcmRzLmxhdGl0dWRl' +
  'LCBsbmc6IHBvcy5jb29yZHMubG9uZ2l0dWRlLCBhY2N1cmFjeV9tOiBwb3MuY29vcmRzLmFjY3VyYWN5IH07CiAgICAgICAgb3V0' +
  'LmlubmVySFRNTCA9IGA8YiBzdHlsZT0iY29sb3I6dmFyKC0tb2spIj7inJMgJHtncHMubGF0LnRvRml4ZWQoNSl9LCAke2dwcy5s' +
  'bmcudG9GaXhlZCg1KX08L2I+IMKxJHtNYXRoLnJvdW5kKGdwcy5hY2N1cmFjeV9tKX1tYDsKICAgICAgfSwgZXJyID0+IHsgb3V0' +
  'LnRleHRDb250ZW50ID0gJ0ZhaWxlZDogJyArIGVyci5tZXNzYWdlOyB9LAogICAgICAgIHsgZW5hYmxlSGlnaEFjY3VyYWN5OiB0' +
  'cnVlLCB0aW1lb3V0OiAxNTAwMCwgbWF4aW11bUFnZTogMCB9KTsKICAgIH07CiAgICAvLyBhdXRvLWNhcHR1cmUgb24gb3BlbiDi' +
  'gJQgdGhlIGFmZmlkYXZpdCBpcyBzdHJvbmdlciB3aGVuIGV2ZXJ5IGF0dGVtcHQgaGFzIGNvb3JkaW5hdGVzCiAgICBlbC5xdWVy' +
  'eVNlbGVjdG9yKCcjZ3BzQnRuJykuY2xpY2soKTsKCiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZUF0dCcpLm9uY2xpY2sgPSBh' +
  'c3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IGJvZHkgPSBPYmplY3QuYXNzaWduKHsKICAgICAgICBvdXRjb21lLAogICAgICAgIGF0' +
  'dGVtcHRlZF9hdDogZWwucXVlcnlTZWxlY3RvcignI2Ffd2hlbicpLnZhbHVlIHx8IG51bGwsCiAgICAgICAgbm90ZXM6IGVsLnF1' +
  'ZXJ5U2VsZWN0b3IoJyNhX25vdGVzJykudmFsdWUsCiAgICAgICAgLy8gQmxhbmsgbWVhbnMgdGhlIGFkZHJlc3Mgb24gdGhlIGpv' +
  'Yiwgd2hpY2ggdGhlIHNlcnZlciBmaWxscyBpbi4KICAgICAgICBhZGRyZXNzX3VzZWQ6IChlbC5xdWVyeVNlbGVjdG9yKCcjYV9h' +
  'ZGRyJykudmFsdWUgfHwgJycpLnRyaW0oKSB8fCB1bmRlZmluZWQKICAgICAgfSwgZ3BzIHx8IHt9KTsKICAgICAgaWYgKG91dGNv' +
  'bWUgPT09ICdTZXJ2ZWQnKSB7CiAgICAgICAgYm9keS5tYW5uZXIgPSBlbC5xdWVyeVNlbGVjdG9yKCcjYV9tYW5uZXInKS52YWx1' +
  'ZTsKICAgICAgICBib2R5LnBlcnNvbl9zZXJ2ZWQgPSBlbC5xdWVyeVNlbGVjdG9yKCcjYV9wZXJzb25fc2VydmVkJykudmFsdWU7' +
  'CiAgICAgICAgYm9keS5yZWxhdGlvbnNoaXAgPSBlbC5xdWVyeVNlbGVjdG9yKCcjYV9yZWxhdGlvbnNoaXAnKS52YWx1ZTsKICAg' +
  'ICAgICBib2R5LmRlc2NyaXB0aW9uID0gZWwucXVlcnlTZWxlY3RvcignI2FfZGVzY3JpcHRpb24nKS52YWx1ZTsKICAgICAgfQog' +
  'ICAgICBjb25zdCBzYXZlID0gZWwucXVlcnlTZWxlY3RvcignI3NhdmVBdHQnKTsKICAgICAgY29uc3Qgd2FzID0gc2F2ZS50ZXh0' +
  'Q29udGVudDsKICAgICAgc2F2ZS5kaXNhYmxlZCA9IHRydWU7CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3QgYXR0ID0gYXdhaXQg' +
  'YXBpKCcvam9icy8nICsgam9iLmlkICsgJy9hdHRlbXB0cycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5' +
  'KGJvZHkpIH0pOwogICAgICAgIC8qIFRoZSBhdHRlbXB0IGlzIHNhdmVkIGF0IHRoaXMgcG9pbnQuIElmIGEgcGhvdG8gZmFpbHMg' +
  'dG8gdXBsb2FkIGFmdGVyCiAgICAgICAgICAgdGhhdCDigJQgZGVhZCBzaWduYWwgaW4gYSBkcml2ZXdheSDigJQgdGhlIGF0dGVt' +
  'cHQgc3RpbGwgc3RhbmRzIGFuZCB0aGUKICAgICAgICAgICBzZXJ2ZXIgaXMgdG9sZCB3aGljaCBvbmVzIHRvIHJldHJ5IGZyb20g' +
  'dGhlIGpvYiBzY3JlZW4sIHJhdGhlciB0aGFuCiAgICAgICAgICAgbG9zaW5nIHRoZSB3aG9sZSBlbnRyeS4gKi8KICAgICAgICBs' +
  'ZXQgZmFpbGVkID0gMDsKICAgICAgICBpZiAocGVuZGluZy5sZW5ndGgpIHsKICAgICAgICAgIHRyeSB7CiAgICAgICAgICAgIGF3' +
  'YWl0IHVwbG9hZFBob3RvcyhhdHQuaWQsIHBlbmRpbmcsCiAgICAgICAgICAgICAgKG4sIHRvdGFsKSA9PiB7IHNhdmUudGV4dENv' +
  'bnRlbnQgPSBgU2VuZGluZyBwaG90byAke259IG9mICR7dG90YWx94oCmYDsgfSk7CiAgICAgICAgICB9IGNhdGNoIChlKSB7IGZh' +
  'aWxlZCA9IDE7IH0KICAgICAgICB9CiAgICAgICAgY2xvc2VTaGVldCgpOwogICAgICAgIHRvYXN0KGZhaWxlZCA/ICdBdHRlbXB0' +
  'IHNhdmVkIOKAlCBhIHBob3RvIGRpZCBub3Qgc2VuZCwgYWRkIGl0IGFnYWluIGZyb20gdGhlIGpvYicKICAgICAgICAgIDogb3V0' +
  'Y29tZSA9PT0gJ1NlcnZlZCcgPyAnU2VydmVkIOKAlCBqb2IgY2xvc2VkIG91dCcgOiAnQXR0ZW1wdCBsb2dnZWQnLCAhIWZhaWxl' +
  'ZCk7CiAgICAgICAgZ28oJ2pvYicsIHsgaWQ6IGpvYi5pZCB9KTsKICAgICAgfSBjYXRjaCAoZSkgeyBzYXZlLmRpc2FibGVkID0g' +
  'ZmFsc2U7IHNhdmUudGV4dENvbnRlbnQgPSB3YXM7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICAgIH07CiAgfSk7Cn0KCmZ1' +
  'bmN0aW9uIGxvY2FsTm93KCkgewogIGNvbnN0IGQgPSBuZXcgRGF0ZShEYXRlLm5vdygpIC0gbmV3IERhdGUoKS5nZXRUaW1lem9u' +
  'ZU9mZnNldCgpICogNjAwMDApOwogIHJldHVybiBkLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTYpOwp9CgovKiAtLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGFmZmlkYXZpdCAtLSAqLwphc3luYyBmdW5j' +
  'dGlvbiBhZmZpZGF2aXRTaGVldChqb2IpIHsKICBjb25zdCB0ZW1wbGF0ZXMgPSBhd2FpdCBhcGkoJy90ZW1wbGF0ZXMnKTsKICBj' +
  'b25zdCBsb2FkID0gYXN5bmMgaWQgPT4gewogICAgY29uc3QgciA9IGF3YWl0IGFwaSgnL2pvYnMvJyArIGpvYi5pZCArICcvYWZm' +
  'aWRhdml0JyArIChpZCA/ICc/dGVtcGxhdGVfaWQ9JyArIGlkIDogJycpKTsKICAgIHJldHVybiByOwogIH07CiAgY29uc3QgZmly' +
  'c3QgPSBhd2FpdCBsb2FkKCk7CiAgc2hlZXQoJ0FmZmlkYXZpdCDigJQgJyArIGpvYi5qb2JfbnVtYmVyLCBgCiAgICA8ZGl2IGNs' +
  'YXNzPSJmaWVsZCI+PGxhYmVsPlRlbXBsYXRlPC9sYWJlbD48c2VsZWN0IGlkPSJ0cGwiPgogICAgICAke3RlbXBsYXRlcy5tYXAo' +
  'dCA9PiBgPG9wdGlvbiB2YWx1ZT0iJHt0LmlkfSIgJHt0LmlkID09PSBmaXJzdC50ZW1wbGF0ZV9pZCA/ICdzZWxlY3RlZCcgOiAn' +
  'J30+JHtlc2ModC5uYW1lKX0ke3QuanVyaXNkaWN0aW9uID8gJyDigJQgJyArIGVzYyh0Lmp1cmlzZGljdGlvbikgOiAnJ308L29w' +
  'dGlvbj5gKS5qb2luKCcnKX0KICAgIDwvc2VsZWN0PjwvZGl2PgogICAgPHByZSBjbGFzcz0icHJldiIgaWQ9InByZXYiPiR7ZXNj' +
  'KGZpcnN0LnRleHQpfTwvcHJlPgogICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij4KICAgICAgPGJ1' +
  'dHRvbiBjbGFzcz0iYnRuIiBpZD0icHJpbnRBZmYiPlByaW50IC8gc2F2ZSBQREY8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFz' +
  'cz0iYnRuIHNlYyIgaWQ9ImNvcHlBZmYiPkNvcHkgdGV4dDwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBv' +
  'bmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNsb3NlPC9idXR0b24+CiAgICA8L2Rpdj5gLCBlbCA9PiB7CiAgICBjb25zdCBzZWwgPSBl' +
  'bC5xdWVyeVNlbGVjdG9yKCcjdHBsJyk7CiAgICBzZWwub25jaGFuZ2UgPSBhc3luYyAoKSA9PiB7IGVsLnF1ZXJ5U2VsZWN0b3Io' +
  'JyNwcmV2JykudGV4dENvbnRlbnQgPSAoYXdhaXQgbG9hZChzZWwudmFsdWUpKS50ZXh0OyB9OwogICAgZWwucXVlcnlTZWxlY3Rv' +
  'cignI3ByaW50QWZmJykub25jbGljayA9ICgpID0+CiAgICAgIHdpbmRvdy5vcGVuKCcvcHJpbnQvYWZmaWRhdml0LycgKyBqb2Iu' +
  'aWQgKyAnP3RlbXBsYXRlX2lkPScgKyBzZWwudmFsdWUsICdfYmxhbmsnKTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNjb3B5QWZm' +
  'Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoZWwucXVl' +
  'cnlTZWxlY3RvcignI3ByZXYnKS50ZXh0Q29udGVudCk7CiAgICAgIHRvYXN0KCdDb3BpZWQnKTsKICAgIH07CiAgfSk7Cn0KCi8q' +
  'IC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIHRvb2xzIC0tLSAqLwov' +
  'KiBMYWJlbCBtYWtlci4gVGhlIHBvaW50IG9mIHRoZSBzaGVldCBncmlkIGlzIHRoYXQgbGFiZWwgc2hlZXRzIGFyZSBleHBlbnNp' +
  'dmUKICAgYW5kIHJhcmVseSB1c2VkIHVwIGluIG9uZSBnbzogbWFyayB3aGljaCBvbmVzIHlvdSd2ZSBhbHJlYWR5IHBlZWxlZCBv' +
  'ZmYgYW5kCiAgIHRoZSBwcmludGVyIHNraXBzIHRoZW0sIHNvIGEgcGFydC11c2VkIHNoZWV0IGdvZXMgYmFjayBpbiBhbmQgY2Fy' +
  'cmllcyBvbi4gKi8KYXN5bmMgZnVuY3Rpb24gdG9vbHNWaWV3KCkgewogIGNvbnN0IFtsYXlvdXRzLCBpbml0U2hlZXQsIGpvYnNd' +
  'ID0gYXdhaXQgUHJvbWlzZS5hbGwoWwogICAgYXBpKCcvbGFiZWwtbGF5b3V0cycpLCBhcGkoJy9sYWJlbC1zaGVldCcpLCBhcGko' +
  'Jy9qb2JzP29wZW49MScpCiAgXSk7CiAgUy5jYWNoZS5zaGVldCA9IGluaXRTaGVldDsKICBTLmNhY2hlLnBpY2tlZCA9IFMuY2Fj' +
  'aGUucGlja2VkIHx8IFtdOwoKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5Ub29sczwvaDE+' +
  'CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5MYWJlbCBtYWtlciA8c3BhbiBjbGFzcz0ic3ViIj5wcmludHMgb25s' +
  'eSB0aGUgbGFiZWxzIHlvdSBoYXZlbid0IHVzZWQ8L3NwYW4+PC9oMj4KCiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+' +
  'TGFiZWwgc2hlZXQ8L2xhYmVsPgogICAgICAgIDxzZWxlY3QgaWQ9ImxheW91dCI+CiAgICAgICAgICAke2xheW91dHMubWFwKGwg' +
  'PT4gYDxvcHRpb24gdmFsdWU9IiR7bC5rZXl9IiAke2wua2V5ID09PSBpbml0U2hlZXQubGF5b3V0ID8gJ3NlbGVjdGVkJyA6ICcn' +
  'fT4KICAgICAgICAgICAgJHtlc2MobC5uYW1lKX0g4oCUICR7ZXNjKGwuc2l6ZSl9PC9vcHRpb24+YCkuam9pbignJyl9CiAgICAg' +
  'ICAgPC9zZWxlY3Q+CiAgICAgICAgPGRpdiBjbGFzcz0iaGludCI+T2ZmaWNlIERlcG90IHNoZWV0cyBwcmludCBhbiBBdmVyeSBl' +
  'cXVpdmFsZW50IG51bWJlciBvbiB0aGUgcGFja2FnZSBmcm9udCDigJQKICAgICAgICAgIG1hdGNoIHRoYXQuIENoYW5naW5nIHRo' +
  'ZSBzaGVldCBjbGVhcnMgdGhlIHVzZWQgbWFya3MsIHNpbmNlIHBvc2l0aW9uIDcgb24gYSAzMC11cCBzaGVldAogICAgICAgICAg' +
  'aXNuJ3QgcG9zaXRpb24gNyBvbiBhIDEwLXVwIG9uZS48L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8bGFiZWw+V2hpY2ggbGFi' +
  'ZWxzIGFyZSBhbHJlYWR5IGdvbmU/PC9sYWJlbD4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi1ib3R0b206' +
  'OHB4Ij5UYXAgdGhlIG9uZXMgYWxyZWFkeSBwZWVsZWQgb2ZmLiBHcmV5ID0gdXNlZCBhbmQgc2tpcHBlZC4KICAgICAgICBOdW1i' +
  'ZXJlZCBncmVlbiA9IHdoZXJlIHlvdXIgbmV4dCBsYWJlbHMgd2lsbCBsYW5kLCBpbiBvcmRlci48L2Rpdj4KICAgICAgPGRpdiBp' +
  'ZD0iZ3JpZCI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICAgICAgPHNw' +
  'YW4gY2xhc3M9InBpbGwiIGlkPSJmcmVlQ291bnQiPjwvc3Bhbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBp' +
  'ZD0ibmV3U2hlZXQiPkZyZXNoIHNoZWV0PC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9ImFs' +
  'bFVzZWQiPk1hcmsgYWxsIHVzZWQ8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJk' +
  'Ij4KICAgICAgPGgyPldobyB0byBwcmludCA8c3BhbiBjbGFzcz0ic3ViIiBpZD0icGlja0NvdW50Ij48L3NwYW4+PC9oMj4KICAg' +
  'ICAgPGlucHV0IGlkPSJqb2JGaWx0ZXIiIHBsYWNlaG9sZGVyPSJGaWx0ZXIgYnkgbmFtZSwgY2l0eSBvciBqb2IgbnVtYmVyIiBz' +
  'dHlsZT0ibWFyZ2luLWJvdHRvbTo4cHgiPgogICAgICA8ZGl2IGNsYXNzPSJsaXN0IiBpZD0iam9iUGljayIgc3R5bGU9Im1heC1o' +
  'ZWlnaHQ6MzIwcHg7b3ZlcmZsb3c6YXV0byI+CiAgICAgICAgJHtqb2JzLmxlbmd0aCA/IGpvYnMubWFwKGogPT4gYAogICAgICAg' +
  'ICAgPGRpdiBjbGFzcz0iaXRlbSIgZGF0YS1waWNrPSIke2ouaWR9Ij4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iciI+PGRpdj4K' +
  'ICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJ0Ij4ke2VzYyhqLnJlY2lwaWVudF9uYW1lKX08L2Rpdj4KICAgICAgICAgICAgICA8' +
  'ZGl2IGNsYXNzPSJtIj4ke2VzYyhqLmpvYl9udW1iZXIpfSDCtyAke2VzYyhbai5hZGRyZXNzMSwgai5jaXR5XS5maWx0ZXIoQm9v' +
  'bGVhbikuam9pbignLCAnKSB8fCAnbm8gYWRkcmVzcycpfTwvZGl2PgogICAgICAgICAgICA8L2Rpdj48c3BhbiBjbGFzcz0icGls' +
  'bCIgZGF0YS10aWNrPSIke2ouaWR9Ij5hZGQ8L3NwYW4+PC9kaXY+CiAgICAgICAgICA8L2Rpdj5gKS5qb2luKCcnKQogICAgICAg' +
  'ICAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPk5vIG9wZW4gam9icyB0byBsYWJlbC48L2Rpdj4nfQogICAgICA8L2Rpdj4KICAgIDwv' +
  'ZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+UHJpbnQ8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciPgog' +
  'ICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InByaW50QnRuIiBkaXNhYmxlZD5QcmludCBsYWJlbHM8L2J1dHRvbj4KICAg' +
  'ICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0idGVzdEJ0biI+QWxpZ25tZW50IHRlc3Q8L2J1dHRvbj4KICAgICAg' +
  'PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+SW4gdGhlIHByaW50IGRpYWxvZyBz' +
  'ZXQgc2NhbGUgdG8gPGI+MTAwJTwvYj4gYW5kIHR1cm4gb2ZmCiAgICAgICAgImZpdCB0byBwYWdlIiDigJQgc2NhbGluZyBpcyB3' +
  'aGF0IHRocm93cyBsYWJlbCBhbGlnbm1lbnQgb2ZmLjwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJtYXJn' +
  'aW4tdG9wOjE0cHgiPjxsYWJlbD5OdWRnZSwgaWYgeW91ciBwcmludGVyIHJ1bnMgb2ZmPC9sYWJlbD4KICAgICAgICA8ZGl2IGNs' +
  'YXNzPSJyb3ciPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MCI+UmlnaHQ8L3NwYW4+CiAgICAg' +
  'ICAgICA8aW5wdXQgaWQ9Im9mZlgiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgbWluPSItMC41IiBtYXg9IjAuNSIgdmFsdWU9' +
  'IiR7aW5pdFNoZWV0Lm9mZnNldF94fSIgc3R5bGU9IndpZHRoOjkwcHgiPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImhpbnQiIHN0' +
  'eWxlPSJtYXJnaW46MCI+RG93bjwvc3Bhbj4KICAgICAgICAgIDxpbnB1dCBpZD0ib2ZmWSIgdHlwZT0ibnVtYmVyIiBzdGVwPSIw' +
  'LjAxIiBtaW49Ii0wLjUiIG1heD0iMC41IiB2YWx1ZT0iJHtpbml0U2hlZXQub2Zmc2V0X3l9IiBzdHlsZT0id2lkdGg6OTBweCI+' +
  'CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0ic2F2ZU9mZiI+U2F2ZTwvYnV0dG9uPgogICAgICAgIDwv' +
  'ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPkluY2hlcy4gUHJpbnQgdGhlIGFsaWdubWVudCB0ZXN0IG9uIHBsYWluIHBh' +
  'cGVyLCBob2xkIGl0IGFnYWluc3QgYSByZWFsIHNoZWV0LAogICAgICAgICAgYW5kIG51ZGdlIHVudGlsIHRoZSBib3hlcyBsaW5l' +
  'IHVwLjwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PmApOwogIGJpbmRTaGVsbCgpOwoKICBjb25zdCBsYXlvdXRNZXRhID0g' +
  'KCkgPT4gbGF5b3V0cy5maW5kKGwgPT4gbC5rZXkgPT09IFMuY2FjaGUuc2hlZXQubGF5b3V0KSB8fCBsYXlvdXRzWzBdOwoKICBm' +
  'dW5jdGlvbiBkcmF3R3JpZCgpIHsKICAgIGNvbnN0IG1ldGEgPSBsYXlvdXRNZXRhKCk7CiAgICBjb25zdCBzID0gUy5jYWNoZS5z' +
  'aGVldDsKICAgIGNvbnN0IHVzZWQgPSBuZXcgU2V0KHMudXNlZC5tYXAoTnVtYmVyKSk7CiAgICBjb25zdCBmcmVlID0gW107CiAg' +
  'ICBmb3IgKGxldCBpID0gMDsgaSA8IG1ldGEuY2FwYWNpdHk7IGkrKykgaWYgKCF1c2VkLmhhcyhpKSkgZnJlZS5wdXNoKGkpOwog' +
  'ICAgY29uc3Qgb3JkZXIgPSBuZXcgTWFwKGZyZWUuc2xpY2UoMCwgUy5jYWNoZS5waWNrZWQubGVuZ3RoKS5tYXAoKHBvcywgbikg' +
  'PT4gW3BvcywgbiArIDFdKSk7CgogICAgJCgnI2dyaWQnKS5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0ibGdyaWQiIHN0eWxlPSJn' +
  'cmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KCR7bWV0YS5jb2xzfSwxZnIpIj5gICsKICAgICAgQXJyYXkuZnJvbSh7IGxlbmd0' +
  'aDogbWV0YS5jYXBhY2l0eSB9LCAoXywgaSkgPT4gewogICAgICAgIGNvbnN0IGlzVXNlZCA9IHVzZWQuaGFzKGkpOwogICAgICAg' +
  'IGNvbnN0IG4gPSBvcmRlci5nZXQoaSk7CiAgICAgICAgcmV0dXJuIGA8YnV0dG9uIGNsYXNzPSJsY2VsbCR7aXNVc2VkID8gJyB1' +
  'c2VkJyA6ICcnfSR7biA/ICcgbmV4dCcgOiAnJ30iIGRhdGEtY2VsbD0iJHtpfSIKICAgICAgICAgIHRpdGxlPSJQb3NpdGlvbiAk' +
  'e2kgKyAxfSI+JHtpc1VzZWQgPyAnw5cnIDogKG4gfHwgJycpfTwvYnV0dG9uPmA7CiAgICAgIH0pLmpvaW4oJycpICsgJzwvZGl2' +
  'Pic7CgogICAgJCgnI2ZyZWVDb3VudCcpLnRleHRDb250ZW50ID0gZnJlZS5sZW5ndGggKyAnIG9mICcgKyBtZXRhLmNhcGFjaXR5' +
  'ICsgJyBsZWZ0JzsKICAgICQoJyNwaWNrQ291bnQnKS50ZXh0Q29udGVudCA9IFMuY2FjaGUucGlja2VkLmxlbmd0aCArICcgc2Vs' +
  'ZWN0ZWQnOwogICAgY29uc3Qgb3ZlciA9IFMuY2FjaGUucGlja2VkLmxlbmd0aCA+IGZyZWUubGVuZ3RoOwogICAgY29uc3QgYnRu' +
  'ID0gJCgnI3ByaW50QnRuJyk7CiAgICBidG4uZGlzYWJsZWQgPSAhUy5jYWNoZS5waWNrZWQubGVuZ3RoOwogICAgYnRuLnRleHRD' +
  'b250ZW50ID0gb3ZlcgogICAgICA/IGBQcmludCAke2ZyZWUubGVuZ3RofSBub3cgKCR7Uy5jYWNoZS5waWNrZWQubGVuZ3RoIC0g' +
  'ZnJlZS5sZW5ndGh9IHdvbid0IGZpdClgCiAgICAgIDogYFByaW50ICR7Uy5jYWNoZS5waWNrZWQubGVuZ3RofSBsYWJlbCR7Uy5j' +
  'YWNoZS5waWNrZWQubGVuZ3RoID09PSAxID8gJycgOiAncyd9YDsKCiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0' +
  'YS1jZWxsXScpLmZvckVhY2goYyA9PiBjLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IGkgPSArYy5kYXRhc2V0' +
  'LmNlbGw7CiAgICAgIGNvbnN0IHNldCA9IG5ldyBTZXQoUy5jYWNoZS5zaGVldC51c2VkLm1hcChOdW1iZXIpKTsKICAgICAgc2V0' +
  'LmhhcyhpKSA/IHNldC5kZWxldGUoaSkgOiBzZXQuYWRkKGkpOwogICAgICBhd2FpdCBzYXZlU2hlZXQoeyB1c2VkOiBbLi4uc2V0' +
  'XSB9KTsKICAgIH0pOwogIH0KCiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVNoZWV0KHBhdGNoKSB7CiAgICB0cnkgewogICAgICBTLmNh' +
  'Y2hlLnNoZWV0ID0gYXdhaXQgYXBpKCcvbGFiZWwtc2hlZXQnLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdp' +
  'ZnkocGF0Y2gpIH0pOwogICAgICBkcmF3R3JpZCgpOwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9' +
  'CiAgfQoKICAkKCcjbGF5b3V0Jykub25jaGFuZ2UgPSBlID0+IHNhdmVTaGVldCh7IGxheW91dDogZS50YXJnZXQudmFsdWUgfSk7' +
  'CiAgJCgnI25ld1NoZWV0Jykub25jbGljayA9ICgpID0+IHNhdmVTaGVldCh7IHVzZWQ6IFtdIH0pOwogICQoJyNhbGxVc2VkJyku' +
  'b25jbGljayA9ICgpID0+CiAgICBzYXZlU2hlZXQoeyB1c2VkOiBBcnJheS5mcm9tKHsgbGVuZ3RoOiBsYXlvdXRNZXRhKCkuY2Fw' +
  'YWNpdHkgfSwgKF8sIGkpID0+IGkpIH0pOwogICQoJyNzYXZlT2ZmJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIGF3YWl0' +
  'IHNhdmVTaGVldCh7IG9mZnNldF94OiBOdW1iZXIoJCgnI29mZlgnKS52YWx1ZSkgfHwgMCwgb2Zmc2V0X3k6IE51bWJlcigkKCcj' +
  'b2ZmWScpLnZhbHVlKSB8fCAwIH0pOwogICAgdG9hc3QoJ0FsaWdubWVudCBzYXZlZCcpOwogIH07CgogIGNvbnN0IHBhaW50ID0g' +
  'KCkgPT4gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdGlja10nKS5mb3JFYWNoKHQgPT4gewogICAgY29uc3Qgb24g' +
  'PSBTLmNhY2hlLnBpY2tlZC5pbmNsdWRlcygrdC5kYXRhc2V0LnRpY2spOwogICAgdC50ZXh0Q29udGVudCA9IG9uID8gJ+KckyBh' +
  'ZGRlZCcgOiAnYWRkJzsKICAgIHQuY2xhc3NOYW1lID0gb24gPyAncGlsbCBTZXJ2ZWQnIDogJ3BpbGwnOwogIH0pOwogIGRvY3Vt' +
  'ZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBpY2tdJykuZm9yRWFjaChyb3cgPT4gcm93Lm9uY2xpY2sgPSAoKSA9PiB7CiAg' +
  'ICBjb25zdCBpZCA9ICtyb3cuZGF0YXNldC5waWNrOwogICAgY29uc3QgaSA9IFMuY2FjaGUucGlja2VkLmluZGV4T2YoaWQpOwog' +
  'ICAgaSA9PT0gLTEgPyBTLmNhY2hlLnBpY2tlZC5wdXNoKGlkKSA6IFMuY2FjaGUucGlja2VkLnNwbGljZShpLCAxKTsKICAgIHBh' +
  'aW50KCk7IGRyYXdHcmlkKCk7CiAgfSk7CiAgJCgnI2pvYkZpbHRlcicpLm9uaW5wdXQgPSBlID0+IHsKICAgIGNvbnN0IHYgPSBl' +
  'LnRhcmdldC52YWx1ZS50b0xvd2VyQ2FzZSgpOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcGlja10nKS5m' +
  'b3JFYWNoKHIgPT4gewogICAgICByLnN0eWxlLmRpc3BsYXkgPSByLmlubmVyVGV4dC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHYp' +
  'ID8gJycgOiAnbm9uZSc7CiAgICB9KTsKICB9OwoKICAkKCcjdGVzdEJ0bicpLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBjb25zdCBp' +
  'ZHMgPSBTLmNhY2hlLnBpY2tlZC5sZW5ndGggPyBTLmNhY2hlLnBpY2tlZCA6IChqb2JzWzBdID8gW2pvYnNbMF0uaWRdIDogW10p' +
  'OwogICAgaWYgKCFpZHMubGVuZ3RoKSByZXR1cm4gdG9hc3QoJ0FkZCBhdCBsZWFzdCBvbmUgam9iIGZpcnN0JywgdHJ1ZSk7CiAg' +
  'ICB3aW5kb3cub3BlbignL3ByaW50L2xhYmVscz9ndWlkZXM9MSZpZHM9JyArIGlkcy5qb2luKCcsJyksICdfYmxhbmsnKTsKICB9' +
  'OwoKICAkKCcjcHJpbnRCdG4nKS5vbmNsaWNrID0gKCkgPT4gewogICAgY29uc3QgbWV0YSA9IGxheW91dE1ldGEoKTsKICAgIGNv' +
  'bnN0IHVzZWQgPSBuZXcgU2V0KFMuY2FjaGUuc2hlZXQudXNlZC5tYXAoTnVtYmVyKSk7CiAgICBjb25zdCBmcmVlID0gW107CiAg' +
  'ICBmb3IgKGxldCBpID0gMDsgaSA8IG1ldGEuY2FwYWNpdHk7IGkrKykgaWYgKCF1c2VkLmhhcyhpKSkgZnJlZS5wdXNoKGkpOwog' +
  'ICAgY29uc3Qgd2lsbFVzZSA9IGZyZWUuc2xpY2UoMCwgUy5jYWNoZS5waWNrZWQubGVuZ3RoKTsKICAgIHdpbmRvdy5vcGVuKCcv' +
  'cHJpbnQvbGFiZWxzP2lkcz0nICsgUy5jYWNoZS5waWNrZWQuam9pbignLCcpLCAnX2JsYW5rJyk7CgogICAgY29uZmlybVByaW50' +
  'ZWQod2lsbFVzZSk7CiAgfTsKCiAgZnVuY3Rpb24gY29uZmlybVByaW50ZWQod2lsbFVzZSkgewogICAgc2hlZXQoJ0RpZCB0aGV5' +
  'IHByaW50PycsIGAKICAgICAgPHAgY2xhc3M9ImhpbnQiPk9ubHkgbWFyayB0aGVzZSB1c2VkIG9uY2UgdGhlIHNoZWV0IGFjdHVh' +
  'bGx5IGNhbWUgb3V0IHJpZ2h0IOKAlCBpZiB0aGUgcHJpbnRlcgogICAgICAgIGphbW1lZCBvciB0aGUgYWxpZ25tZW50IHdhcyBv' +
  'ZmYsIHNheSBubyBhbmQgbm90aGluZyBjaGFuZ2VzLjwvcD4KICAgICAgPHA+PGI+JHt3aWxsVXNlLmxlbmd0aH08L2I+IHBvc2l0' +
  'aW9uJHt3aWxsVXNlLmxlbmd0aCA9PT0gMSA/ICcnIDogJ3MnfSB3b3VsZCBiZSBtYXJrZWQgdXNlZDoKICAgICAgICAke3dpbGxV' +
  'c2UubWFwKGkgPT4gaSArIDEpLmpvaW4oJywgJyl9PC9wPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9w' +
  'OjEycHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBvayIgaWQ9Inllc1VzZWQiPlllcyDigJQgbWFyayB0aGVtIHVzZWQ8' +
  'L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPk5vLCBrZWVwIHRo' +
  'ZW0gZnJlZTwvYnV0dG9uPgogICAgICA8L2Rpdj5gLCBlbCA9PiB7CiAgICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyN5ZXNVc2VkJyku' +
  'b25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgICBjb25zdCBzZXQgPSBuZXcgU2V0KFMuY2FjaGUuc2hlZXQudXNlZC5tYXAo' +
  'TnVtYmVyKSk7CiAgICAgICAgd2lsbFVzZS5mb3JFYWNoKGkgPT4gc2V0LmFkZChpKSk7CiAgICAgICAgYXdhaXQgc2F2ZVNoZWV0' +
  'KHsgdXNlZDogWy4uLnNldF0gfSk7CiAgICAgICAgUy5jYWNoZS5waWNrZWQgPSBbXTsKICAgICAgICBjbG9zZVNoZWV0KCk7CiAg' +
  'ICAgICAgdG9hc3QoJ1NoZWV0IHVwZGF0ZWQg4oCUICcgKyBTLmNhY2hlLnNoZWV0LmZyZWUgKyAnIGxhYmVscyBsZWZ0Jyk7CiAg' +
  'ICAgICAgZ28oJ3Rvb2xzJyk7CiAgICAgIH07CiAgICB9KTsKICB9CgogIHBhaW50KCk7CiAgZHJhd0dyaWQoKTsKfQoKLyogLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBwcm9wZXJ0eSBzZWFyY2ggLS0gKi8KLyog' +
  'VGhlIHNhbWUgbG9va3VwIHRoZSBEZWFsIEZpbmRlciBydW5zLCBhZ2FpbnN0IHRoZSBzYW1lIGNvdW50eSBhcHByYWlzYWwKICog' +
  'cm9sbHMsIGJlY2F1c2UgYSBwcm9jZXNzIHNlcnZlciBuZWVkcyBleGFjdGx5IHdoYXQgYSBidXllciBuZWVkczogd2hvIG93bnMK' +
  'ICogdGhpcyBhZGRyZXNzLCBhbmQgd2hlcmUgZG9lcyB0aGVpciBwb3N0IGFjdHVhbGx5IGdvLgogKgogKiBUaGUgcm9sbHMgYXJl' +
  'IHB1Ymxpc2hlZCBhcyBBcmNHSVMgZmVhdHVyZSBsYXllcnMsIHNvIHRoZSBicm93c2VyIGFza3MgdGhlCiAqIGNvdW50eSBkaXJl' +
  'Y3RseSDigJQgbm8ga2V5LCBubyBzZXJ2ZXIgaW4gdGhlIG1pZGRsZSwgbm90aGluZyBjYWNoZWQgdGhhdCBjb3VsZAogKiBnbyBz' +
  'dGFsZS4gRmllbGQgbmFtZXMgZGlmZmVyIHBlciBjb3VudHksIHNvIGVhY2ggb25lIGNhcnJpZXMgaXRzIG93biBtYXAsCiAqIHZl' +
  'cmlmaWVkIGFnYWluc3QgdGhlIGxpdmUgbGF5ZXIgcmF0aGVyIHRoYW4gZ3Vlc3NlZC4KICovCmNvbnN0IENBRCA9ICgoKSA9PiB7' +
  'CiAgY29uc3QgY2FtZXJvbkZpZWxkcyA9IHVwcGVyID0+IHsKICAgIGNvbnN0IG4gPSAoYSwgYikgPT4gKHVwcGVyID8gYiA6IGEp' +
  'OwogICAgcmV0dXJuIHsKICAgICAgYWRkcjogbignc2l0dXNkaXNwbCcsICdzaXR1c0Rpc3BsJyksCiAgICAgIGFkZHJQYXJ0czog' +
  'W24oJ3NpdHVzbm8nLCAnc2l0dXNObycpLCBuKCdzaXRwZngnLCAnc2l0UGZ4JyksIG4oJ3NpdHN0cicsICdzaXRTdHInKSwgbign' +
  'c2l0c2Z4JywgJ3NpdFNmeCcpXSwKICAgICAgY2l0eTogbignc2l0Y2l0eScsICdzaXRDaXR5JyksIHppcDogbignc2l0emlwJywg' +
  'J3NpdFppcCcpLAogICAgICBvd25lcjogJ293bmVyJywgbWFpbDogJ2FkZHIxJywgbWFpbGNpdHk6IG4oJ2FkZHJjaXR5JywgJ2Fk' +
  'ZHJDaXR5JyksCiAgICAgIG1haWxzdGF0ZTogbignYWRkcnN0YXRlJywgJ2FkZHJTdGF0ZScpLCBtYWlsemlwOiBuKCdhZGRyemlw' +
  'JywgJ2FkZHJaaXAnKSwKICAgICAgc3FmdDogbignbHZnYXJlYScsICdsdmdBcmVhJyksIHllYXI6IG4oJ3lyYnVpbHQnLCAneXJC' +
  'dWlsdCcpLCBjYWQ6ICdtYXJrZXQnLAogICAgICBjbHM6IG4oJ3N0YXRlY2QnLCAnc3RhdGVDZCcpLCBleGVtcHQ6ICdleG1zJywg' +
  'cGlkOiBuKCdwcm9wX2lkJywgJ1BST1BfSUQnKSwKICAgICAgZ2VvOiBuKCdnZW9faWQnLCAnZ2VvSUQnKSwKICAgICAgZGVlZDog' +
  'eyBkYXRlOiBuKCdkZWVkZHQnLCAnZGVlZER0JyksIHJlYzogbignZGVlZHJlY2R0JywgJ2RlZWRSZWNEdCcpLAogICAgICAgICAg' +
  'ICAgIHR5cGU6IG4oJ2RlZWR0eXBlJywgJ2RlZWRUeXBlJyksIHZvbDogJ3ZvbHVtZScsIHBhZ2U6ICdwYWdlJywgbnVtOiBuKCdk' +
  'b2NudW0nLCAnZG9jTnVtJykgfQogICAgfTsKICB9OwogIHJldHVybiB7CiAgICAnVFh8SElEQUxHTyc6IHsKICAgICAgbGFiZWw6' +
  'ICdIaWRhbGdvIENBRCAyMDI2IGNlcnRpZmllZCByb2xsJywgY2xlcms6ICdoaWRhbGdvJywKICAgICAgcTogJ2h0dHBzOi8vc2Vy' +
  'dmljZXM5LmFyY2dpcy5jb20vZHdNRFA1NUhUZm9qNG4xYy9hcmNnaXMvcmVzdC9zZXJ2aWNlcy9IQ0FEX1BBUkNFTFNfMjAyNi9G' +
  'ZWF0dXJlU2VydmVyLzEvcXVlcnknLAogICAgICBmOiB7IGFkZHI6ICdzaXR1cycsIG93bmVyOiAnbmFtZScsIG1haWw6ICdhZGRy' +
  'RGVsaXZlcnlMaW5lJywgbWFpbGNpdHk6ICdhZGRyQ2l0eScsCiAgICAgICAgICAgbWFpbHN0YXRlOiAnYWRkclN0YXRlJywgbWFp' +
  'bHppcDogJ2FkZHJaaXAnLCBzcWZ0OiAnaW1wcnZNYWluQXJlYScsCiAgICAgICAgICAgeWVhcjogJ2ltcHJ2QWN0dWFsWWVhckJ1' +
  'aWx0JywgY2FkOiAnbWFya2V0VmFsdWUnLCBjbHM6ICdzdGF0ZUNkJywKICAgICAgICAgICBleGVtcHQ6ICdleGVtcHRpb25zJywg' +
  'cGlkOiAnUFJPUF9JRCcsIGdlbzogJ2dlb0lEJywgdW5pdDogJ3RheGluZ1VuaXRzJywKICAgICAgICAgICBsZWdhbDogJ2xlZ2Fs' +
  'RGVzY3JpcHRpb24nLAogICAgICAgICAgIGRlZWQ6IHsgZGF0ZTogJ2RlZWREdCcsIHR5cGU6ICdkZWVkVHlwZScsIG51bTogJ2lu' +
  'c3RydW1lbnROdW0nIH0gfSwKICAgICAgbGluazogcGlkID0+ICdodHRwczovL2hpZGFsZ28ucHJvZGlneWNhZC5jb20vcHJvcGVy' +
  'dHktZGV0YWlsLycgKyBwaWQsCiAgICAgIGNpdGllczogeyAnTWNBbGxlbic6ICdDTUwnLCAnRWRpbmJ1cmcnOiAnQ0VCJywgJ01p' +
  'c3Npb24nOiAnQ01TJywgJ1BoYXJyJzogJ0NQUicsICdXZXNsYWNvJzogJ0NXTCcsCiAgICAgICAgICAgICAgICAnU2FuIEp1YW4n' +
  'OiAnQ1NKJywgJ0Rvbm5hJzogJ0NETicsICdNZXJjZWRlcyc6ICdDTUMnLCAnQWxhbW8nOiAnQ0FPJywgJ0hpZGFsZ28nOiAnQ0hE' +
  'JywKICAgICAgICAgICAgICAgICdMYSBKb3lhJzogJ0NMSicsICdQYWxtdmlldyc6ICdDUE0nLCAnQWx0b24nOiAnQ0FOJyB9CiAg' +
  'ICB9LAogICAgJ1RYfENBTUVST04nOiB7CiAgICAgIGxhYmVsOiAnQ2FtZXJvbiBDQUQgMjAyNiByb2xsJywgY2xlcms6ICdjYW1l' +
  'cm9uJywKICAgICAgcTogJ2h0dHBzOi8vY29iZ2lzLmJyb3duc3ZpbGxldHguZ292L2FyY2dpcy9yZXN0L3NlcnZpY2VzL0hvc3Rl' +
  'ZC9DQ0FEX1BhcmNlbHNfMDkwODIwMjUvRmVhdHVyZVNlcnZlci8wL3F1ZXJ5JywKICAgICAgZjogY2FtZXJvbkZpZWxkcyhmYWxz' +
  'ZSksCiAgICAgIGFsdDogeyBxOiAnaHR0cHM6Ly9zZXJ2aWNlczIuYXJjZ2lzLmNvbS82b2FMTVpFWmxrdGJRcHlpL2FyY2dpcy9y' +
  'ZXN0L3NlcnZpY2VzL0NDQURfUGFyY2Vsc19WaWV3L0ZlYXR1cmVTZXJ2ZXIvMC9xdWVyeScsCiAgICAgICAgICAgICBsYWJlbDog' +
  'J0NhbWVyb24gQ0FEIDIwMjUgcm9sbCAoRXNyaSBtaXJyb3IpJywgZjogY2FtZXJvbkZpZWxkcyh0cnVlKSB9LAogICAgICBjaXRp' +
  'ZXM6IHsgJ0Jyb3duc3ZpbGxlJzogJ0NCUicsICdIYXJsaW5nZW4nOiAnQ0hHJywgJ1NhbiBCZW5pdG8nOiAnQ1NCJywgJ0xhIEZl' +
  'cmlhJzogJ0NMRicsCiAgICAgICAgICAgICAgICAnTG9zIEZyZXNub3MnOiAnQ0xPJywgJ1NvdXRoIFBhZHJlIElzbGFuZCc6ICdD' +
  'U1AnLCAnUmlvIEhvbmRvJzogJ0NSSCcsICdQb3J0IElzYWJlbCc6ICdDUEknIH0KICAgIH0sCiAgICAnVFh8U1RBUlInOiB7CiAg' +
  'ICAgIGxhYmVsOiAnU3RhcnIgQ0FEIHBhcmNlbHMnLCBjbGVyazogJ3N0YXJyJywKICAgICAgcTogJ2h0dHBzOi8vdXRpbGl0eS5h' +
  'cmNnaXMuY29tL3VzcnN2Y3Mvc2VydmVycy9mZjA1YWY0MjkzNDc0YjQ1YWJmMzkwNzUyNTBlZmU3OC9yZXN0L3NlcnZpY2VzL1N0' +
  'YXJyQ0FEV2ViU2VydmljZS9GZWF0dXJlU2VydmVyLzAvcXVlcnknLAogICAgICBmOiB7IGFkZHJQYXJ0czogWydzaXR1c19udW0n' +
  'LCAnc2l0dXNfc3RyZWV0X3ByZWZ4JywgJ3NpdHVzX3N0cmVldCcsICdzaXR1c19zdHJlZXRfc3VmaXgnXSwKICAgICAgICAgICBh' +
  'ZGRyOiAnc2l0dXNfc3RyZWV0JywgY2l0eTogJ3NpdHVzX2NpdHknLCB6aXA6ICdzaXR1c196aXAnLAogICAgICAgICAgIG93bmVy' +
  'OiAnZmlsZV9hc19uYW1lJywgbWFpbDogJ2FkZHJfbGluZTEnLCBtYWlsY2l0eTogJ2FkZHJfY2l0eScsCiAgICAgICAgICAgbWFp' +
  'bHN0YXRlOiAnYWRkcl9zdGF0ZScsIG1haWx6aXA6ICd6aXAnLCBjYWQ6ICdtYXJrZXQnLAogICAgICAgICAgIHBpZDogJ3Byb3Bf' +
  'aWQnLCBnZW86ICdnZW9faWQnLCB1bml0OiAnY2l0eScsIGxlZ2FsOiAnbGVnYWxfZGVzYycsCiAgICAgICAgICAgZGVlZDogeyBk' +
  'YXRlOiAnRGVlZF9EYXRlJywgdm9sOiAnVm9sdW1lJywgcGFnZTogJ1BhZ2UnLCBudW06ICdOdW1iZXInIH0gfSwKICAgICAgY2l0' +
  'aWVzOiB7ICdSaW8gR3JhbmRlIENpdHknOiAnUklPIEdSQU5ERSBDSVRZJywgJ1JvbWEnOiAnUk9NQScsICdMYSBHcnVsbGEnOiAn' +
  'TEEgR1JVTExBJywKICAgICAgICAgICAgICAgICdFc2NvYmFyZXMnOiAnRVNDT0JBUkVTJyB9LAogICAgICBjaXR5SXNUZXh0OiB0' +
  'cnVlLAogICAgICBub3RlOiAiU3RhcnIncyByb2xsIHB1Ymxpc2hlcyBubyBidWlsZGluZyBzcXVhcmUgZm9vdGFnZSBvciB5ZWFy' +
  'IGJ1aWx0LiIKICAgIH0KICB9Owp9KSgpOwoKY29uc3Qgc3FsRXNjID0gdiA9PiBTdHJpbmcodikucmVwbGFjZSgvJy9nLCAiJyci' +
  'KTsKY29uc3QgbnogPSB2ID0+IHsgY29uc3QgbiA9IHBhcnNlRmxvYXQodik7IHJldHVybiBpc0Zpbml0ZShuKSA/IG4gOiAwOyB9' +
  'Owpjb25zdCB0aXRsZUNhc2UgPSB2ID0+IFN0cmluZyh2ID09IG51bGwgPyAnJyA6IHYpLnRvTG93ZXJDYXNlKCkKICAucmVwbGFj' +
  'ZSgvXGIoW2Etel0pL2csIG0gPT4gbS50b1VwcGVyQ2FzZSgpKQogIC5yZXBsYWNlKC9cYihUeHxJaXxJaWl8SXZ8TGxjfExwfElu' +
  'Y3xQbylcYi9nLCBtID0+IG0udG9VcHBlckNhc2UoKSkudHJpbSgpOwoKZnVuY3Rpb24gc3BsaXRTaXR1cyh2KSB7CiAgY29uc3Qg' +
  'cyA9IFN0cmluZyh2ID09IG51bGwgPyAnJyA6IHYpLnRyaW0oKTsKICBjb25zdCBtID0gcy5tYXRjaCgvXiguKj8pLFxzKihbXixd' +
  'KiksXHMqW0EtWl17Mn1cYi8pOwogIGlmIChtKSByZXR1cm4geyBhZGRyOiBtWzFdLnRyaW0oKSwgY2l0eTogbVsyXS50cmltKCkg' +
  'fTsKICByZXR1cm4geyBhZGRyOiBzLnJlcGxhY2UoLyxccypUWFxzKiQvaSwgJycpLnRyaW0oKSwgY2l0eTogJycgfTsKfQoKLyog' +
  'QSBzdHJpbmdpZmllZCBvYmplY3QgaW4gb3V0RmllbGRzIG1ha2VzIEFyY0dJUyByZWplY3QgdGhlIHdob2xlIHF1ZXJ5LCBzbwog' +
  'ICB0aGUgbWFwIGlzIGZsYXR0ZW5lZCBjYXJlZnVsbHk6IHN0cmluZ3MgcGFzcywgYXJyYXlzIHNwcmVhZCwgdGhlIG5lc3RlZCBk' +
  'ZWVkCiAgIG9iamVjdCBjb250cmlidXRlcyBpdHMgdmFsdWVzLCBhbnl0aGluZyBlbHNlIGlzIGRyb3BwZWQuICovCmZ1bmN0aW9u' +
  'IGZpZWxkTGlzdChHKSB7CiAgY29uc3Qgb3V0ID0gW107CiAgZm9yIChjb25zdCBrIGluIEcpIHsKICAgIGNvbnN0IHYgPSBHW2td' +
  'OwogICAgaWYgKCF2KSBjb250aW51ZTsKICAgIGlmICh0eXBlb2YgdiA9PT0gJ3N0cmluZycpIHsgb3V0LnB1c2godik7IGNvbnRp' +
  'bnVlOyB9CiAgICBpZiAoQXJyYXkuaXNBcnJheSh2KSkgeyB2LmZvckVhY2goeCA9PiB7IGlmICh0eXBlb2YgeCA9PT0gJ3N0cmlu' +
  'ZycgJiYgeCkgb3V0LnB1c2goeCk7IH0pOyBjb250aW51ZTsgfQogICAgaWYgKHR5cGVvZiB2ID09PSAnb2JqZWN0JykgeyBmb3Ig' +
  'KGNvbnN0IGtrIGluIHYpIGlmICh0eXBlb2Ygdltra10gPT09ICdzdHJpbmcnICYmIHZba2tdKSBvdXQucHVzaCh2W2trXSk7IH0K' +
  'ICB9CiAgcmV0dXJuIG91dC5maWx0ZXIoKHgsIGkpID0+IG91dC5pbmRleE9mKHgpID09PSBpKTsKfQoKLy8gQ291bnRpZXMgc3Rv' +
  'cmUgdGhlIGRlZWQgZGF0ZSB0aHJlZSB3YXlzOiBJU08gc3RyaW5nLCBVUyBzdHJpbmcsIGVwb2NoIG1zLgpmdW5jdGlvbiBkZWVk' +
  'RGF0ZSh2KSB7CiAgaWYgKHYgPT0gbnVsbCB8fCB2ID09PSAnJykgcmV0dXJuICcnOwogIGNvbnN0IG4gPSBOdW1iZXIodik7CiAg' +
  'aWYgKGlzRmluaXRlKG4pICYmIG4gPiAxMDAwMDAwMDAwMCkgewogICAgY29uc3QgZCA9IG5ldyBEYXRlKG4pOwogICAgcmV0dXJu' +
  'IGlzRmluaXRlKGQuZ2V0VGltZSgpKSA/IGQudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCkgOiAnJzsKICB9CiAgY29uc3QgcyA9' +
  'IFN0cmluZyh2KS50cmltKCk7CiAgbGV0IG0gPSBzLm1hdGNoKC9eKFxkezR9KS0oXGR7Mn0pLShcZHsyfSkvKTsKICBpZiAobSkg' +
  'cmV0dXJuIG1bMF07CiAgbSA9IHMubWF0Y2goL14oXGR7MSwyfSlcLyhcZHsxLDJ9KVwvKFxkezR9KS8pOwogIGlmIChtKSByZXR1' +
  'cm4gbVszXSArICctJyArICgnMCcgKyBtWzFdKS5zbGljZSgtMikgKyAnLScgKyAoJzAnICsgbVsyXSkuc2xpY2UoLTIpOwogIHJl' +
  'dHVybiBzLnNsaWNlKDAsIDEwKTsKfQpmdW5jdGlvbiBkZWVkT2YoRywgYSkgewogIGNvbnN0IGQgPSBHICYmIEcuZGVlZDsKICBp' +
  'ZiAoIWQpIHJldHVybiBudWxsOwogIGNvbnN0IGcgPSBrID0+IChkW2tdID8gU3RyaW5nKGFbZFtrXV0gPT0gbnVsbCA/ICcnIDog' +
  'YVtkW2tdXSkudHJpbSgpIDogJycpOwogIGNvbnN0IG8gPSB7IGRhdGU6IGRlZWREYXRlKGQuZGF0ZSA/IGFbZC5kYXRlXSA6ICcn' +
  'KSwgcmVjOiBkZWVkRGF0ZShkLnJlYyA/IGFbZC5yZWNdIDogJycpLAogICAgICAgICAgICAgIHR5cGU6IGcoJ3R5cGUnKSwgdm9s' +
  'OiBnKCd2b2wnKSwgcGFnZTogZygncGFnZScpLCBudW06IGcoJ251bScpIH07CiAgcmV0dXJuIChvLmRhdGUgfHwgby5yZWMgfHwg' +
  'by5udW0gfHwgby52b2wpID8gbyA6IG51bGw7Cn0KCi8qIFJvbGxzIGZpbGUgb3duZXJzIGxhc3QtbmFtZS1maXJzdCBhbmQgYm9s' +
  'dCBvbiBldmVyeXRoaW5nIGZyb20gYSBzcG91c2UgdG8gYW4KICAgZXN0YXRlOiAiTUFERVJPIEpPUkdFICYgTElESUEiLCAiR0FS' +
  'WkEgTUFSSUEgRVRVWCIuIFNlYXJjaGluZyB0aGF0IHdob2xlCiAgIHN0cmluZyBmaW5kcyBleGFjdGx5IHRoZSBvbmUgcGFyY2Vs' +
  'IHlvdSBzdGFydGVkIGZyb20sIHNvIGl0IGlzIGN1dCBiYWNrIHRvCiAgIHRoZSBwYXJ0IHRoYXQgaWRlbnRpZmllcyB0aGUgZmFt' +
  'aWx5LiAqLwpjb25zdCBPV05KVU5LID0gL14oRVRBTHxFVHxBTHxFVFVYfEVUVklSfFVYfEpSfFNSfElJfElJSXxJVnxUUlVTVEVF' +
  'fFRSfFRSVVNUfEVTVHxFU1RBVEV8T0Z8VEhFfExJRkV8RVNUQVRFUz8pJC87CmZ1bmN0aW9uIG93bmVyUXVlcnkobmFtZSwgdG9r' +
  'ZW5zKSB7CiAgY29uc3QgdCA9IFN0cmluZyhuYW1lIHx8ICcnKS50b1VwcGVyQ2FzZSgpCiAgICAucmVwbGFjZSgvJi4qJC8sICcn' +
  'KQogICAgLnJlcGxhY2UoL1teQS1aMC05IF0vZywgJyAnKQogICAgLnNwbGl0KC9ccysvKS5maWx0ZXIoQm9vbGVhbikKICAgIC5m' +
  'aWx0ZXIoeCA9PiAhT1dOSlVOSy50ZXN0KHgpKTsKICByZXR1cm4gdC5zbGljZSgwLCB0b2tlbnMgfHwgMikuam9pbignICcpOwp9' +
  'CgovKiBFdmVyeSBjb3VudHkgc3BlbGxzIHRoZSBzdWZmaXggZGlmZmVyZW50bHksIHNvIGl0IGlzIGRyb3BwZWQgYmVmb3JlIHNl' +
  'YXJjaGluZwogICBhbmQgdGhlIHJlc3QgbWF0Y2hlZCBsb29zZWx5LiAqLwpjb25zdCBTVUZGSVhFUyA9IC9eKFNUfFNUUkVFVHxB' +
  'VkV8QVZFTlVFfFJEfFJPQUR8RFJ8RFJJVkV8TE58TEFORXxCTFZEfEJPVUxFVkFSRHxDVHxDT1VSVHxDSVJ8Q0lSQ0xFfFBMfFBM' +
  'QUNFfEhXWXxISUdIV0FZfFRSTHxUUkFJTHxXQVl8UEtXWXxQQVJLV0FZfEFQVHxVTklUfFNURSkkLzsKZnVuY3Rpb24gYWRkclRv' +
  'a2VucyhxKSB7CiAgY29uc3QgdCA9IFN0cmluZyhxIHx8ICcnKS50b1VwcGVyQ2FzZSgpLnJlcGxhY2UoL1teQS1aMC05IF0vZywg' +
  'JyAnKS5zcGxpdCgvXHMrLykuZmlsdGVyKEJvb2xlYW4pOwogIGNvbnN0IGtlZXAgPSB0LmZpbHRlcigodiwgaSkgPT4gaSA9PT0g' +
  'MCB8fCAhU1VGRklYRVMudGVzdCh2KSk7CiAgcmV0dXJuIGtlZXAubGVuZ3RoID8ga2VlcCA6IHQ7Cn0KCmNvbnN0IGNsZXJrU2Vh' +
  'cmNoID0gKGtleSwgcSkgPT4gewogIGNvbnN0IHNyYyA9IENBRFtrZXldOwogIGlmICghc3JjIHx8ICFzcmMuY2xlcmspIHJldHVy' +
  'biAnJzsKICByZXR1cm4gJ2h0dHBzOi8vJyArIHNyYy5jbGVyayArICcudHgucHVibGljc2VhcmNoLnVzL3Jlc3VsdHM/X2NvdXJ0' +
  'SWQ9JmRlcGFydG1lbnQ9UlAnICsKICAgICAgICAgJyZsaW1pdD01MCZvZmZzZXQ9MCZxPScgKyBlbmNvZGVVUklDb21wb25lbnQo' +
  'U3RyaW5nKHEgfHwgJycpLnRyaW0oKSkgKwogICAgICAgICAnJnNlYXJjaE9jclRleHQ9ZmFsc2Umc2VhcmNoVHlwZT1xdWlja1Nl' +
  'YXJjaCc7Cn07Cgphc3luYyBmdW5jdGlvbiBjYWRKU09OKHUpIHsKICBjb25zdCByID0gYXdhaXQgZmV0Y2godSwgeyBtb2RlOiAn' +
  'Y29ycycgfSk7CiAgaWYgKCFyLm9rKSB0aHJvdyBuZXcgRXJyb3IoJ0hUVFAgJyArIHIuc3RhdHVzKTsKICBjb25zdCBqID0gYXdh' +
  'aXQgci5qc29uKCk7CiAgaWYgKGouZXJyb3IpIHRocm93IG5ldyBFcnJvcihqLmVycm9yLm1lc3NhZ2UgfHwgKCdDb3VudHkgc2Vy' +
  'dmVyIGVycm9yICcgKyBqLmVycm9yLmNvZGUpKTsKICByZXR1cm4gajsKfQoKYXN5bmMgZnVuY3Rpb24gY2FkTG9va3VwKGtleSwg' +
  'bW9kZSwgcmF3LCBjaXR5LCBvdmVycmlkZSkgewogIGNvbnN0IHNyYyA9IG92ZXJyaWRlIHx8IENBRFtrZXldOwogIGNvbnN0IEcg' +
  'PSBzcmMuZiB8fCB7fSwgRzIgPSBzcmMuZjIgfHwge307CiAgY29uc3QgdyA9IFtdOwogIGlmIChtb2RlID09PSAnYWRkcicpIHsK' +
  'ICAgIGlmICghRy5hZGRyKSB0aHJvdyBuZXcgRXJyb3IoIlRoYXQgY291bnR5J3Mgcm9sbCBoYXMgbm8gYWRkcmVzcyBjb2x1bW4u' +
  'Iik7CiAgICB3LnB1c2goJ1VQUEVSKCcgKyBHLmFkZHIgKyAiKSBMSUtFICclIiArIHNxbEVzYyhhZGRyVG9rZW5zKHJhdykuam9p' +
  'bignJScpKSArICIlJyIpOwogIH0gZWxzZSB7CiAgICBpZiAoIUcub3duZXIpIHRocm93IG5ldyBFcnJvcigiVGhhdCBjb3VudHkn' +
  'cyByb2xsIGhhcyBubyBvd25lciBjb2x1bW4uIik7CiAgICB3LnB1c2goJ1VQUEVSKCcgKyBHLm93bmVyICsgIikgTElLRSAnJSIg' +
  'KyBzcWxFc2MocmF3LnRvVXBwZXJDYXNlKCkpICsgIiUnIik7CiAgfQogIGlmIChjaXR5KSB7CiAgICBjb25zdCBjb2RlID0gKENB' +
  'RFtrZXldLmNpdGllcyB8fCB7fSlbY2l0eV07CiAgICBpZiAoY29kZSAmJiBHLnVuaXQpIHsKICAgICAgdy5wdXNoKENBRFtrZXld' +
  'LmNpdHlJc1RleHQKICAgICAgICA/ICdVUFBFUignICsgRy51bml0ICsgIikgTElLRSAnJSIgKyBzcWxFc2MoY29kZS50b1VwcGVy' +
  'Q2FzZSgpKSArICIlJyIKICAgICAgICA6IEcudW5pdCArICIgTElLRSAnJSIgKyBjb2RlICsgIiUnIik7CiAgICB9IGVsc2UgaWYg' +
  'KEcuY2l0eSkgewogICAgICB3LnB1c2goJ1VQUEVSKCcgKyBHLmNpdHkgKyAiKSBMSUtFICclIiArIHNxbEVzYyhjaXR5LnRvVXBw' +
  'ZXJDYXNlKCkpICsgIiUnIik7CiAgICB9CiAgfQogIGNvbnN0IG91dEYgPSBmaWVsZExpc3QoRyk7CiAgZm9yIChjb25zdCBrIGlu' +
  'IEcyKSBpZiAoRzJba10pIG91dEYucHVzaChHMltrXSk7CgogIGNvbnN0IHFwID0gbmV3IFVSTFNlYXJjaFBhcmFtcyh7CiAgICB3' +
  'aGVyZTogdy5qb2luKCcgQU5EICcpLCBvdXRGaWVsZHM6IG91dEYuam9pbignLCcpLCByZXR1cm5HZW9tZXRyeTogJ2ZhbHNlJywK' +
  'ICAgIHJlc3VsdFJlY29yZENvdW50OiAnNjAnLCBmOiAnanNvbicsIHJldHVybkNlbnRyb2lkOiAndHJ1ZScsIG91dFNSOiAnNDMy' +
  'NicKICB9KTsKICBjb25zdCByID0gYXdhaXQgY2FkSlNPTihzcmMucSArICc/JyArIHFwKTsKICByZXR1cm4gKHIuZmVhdHVyZXMg' +
  'fHwgW10pLm1hcChmdCA9PiB7CiAgICBjb25zdCBhID0gZnQuYXR0cmlidXRlcyB8fCB7fSwgY3QgPSBmdC5jZW50cm9pZCB8fCB7' +
  'fTsKICAgIGxldCBzcCA9IHNwbGl0U2l0dXMoYVtHLmFkZHJdKTsKICAgIGlmIChHLmFkZHJQYXJ0cykgewogICAgICBjb25zdCBi' +
  'aXRzID0gRy5hZGRyUGFydHMubWFwKGtrID0+IFN0cmluZyhhW2trXSA9PSBudWxsID8gJycgOiBhW2trXSkudHJpbSgpKQogICAg' +
  'ICAgIC5maWx0ZXIoeCA9PiB4ICYmIHggIT09ICcwJyk7CiAgICAgIGlmIChiaXRzLmxlbmd0aCkgc3AgPSB7IGFkZHI6IGJpdHMu' +
  'am9pbignICcpLnJlcGxhY2UoL1xzKy9nLCAnICcpLCBjaXR5OiAnJyB9OwogICAgfQogICAgY29uc3QgbWNpdHkgPSBHLm1haWxj' +
  'aXR5ID8gU3RyaW5nKGFbRy5tYWlsY2l0eV0gfHwgJycpLnRyaW0oKSA6ICcnOwogICAgY29uc3QgcGNpdHkgPSAoRy5jaXR5ICYm' +
  'IGFbRy5jaXR5XSkgPyBTdHJpbmcoYVtHLmNpdHldKS50cmltKCkgOiBzcC5jaXR5OwogICAgY29uc3QgZXggPSBHLmV4ZW1wdCA/' +
  'IFN0cmluZyhhW0cuZXhlbXB0XSB8fCAnJykudHJpbSgpIDogJyc7CiAgICBjb25zdCBwaWQgPSBHLnBpZCA/IGFbRy5waWRdIDog' +
  'Jyc7CiAgICByZXR1cm4gewogICAgICBsYXQ6IGlzRmluaXRlKGN0LnkpID8gY3QueSA6IG51bGwsIGxvbjogaXNGaW5pdGUoY3Qu' +
  'eCkgPyBjdC54IDogbnVsbCwKICAgICAgYWRkcmVzczogdGl0bGVDYXNlKHNwLmFkZHIpIHx8ICfigJQnLCBjaXR5OiB0aXRsZUNh' +
  'c2UocGNpdHkpIHx8IGNpdHksCiAgICAgIHppcDogRy56aXAgPyBTdHJpbmcoYVtHLnppcF0gfHwgJycpLnNsaWNlKDAsIDUpIDog' +
  'JycsCiAgICAgIHNxZnQ6IEcuc3FmdCA/IG56KGFbRy5zcWZ0XSkgOiAwLCB5ZWFyOiBHLnllYXIgPyBueihhW0cueWVhcl0pIDog' +
  'MCwKICAgICAgY2xzOiBHLmNscyA/IFN0cmluZyhhW0cuY2xzXSB8fCAnJykudHJpbSgpIDogJycsCiAgICAgIG93bmVyOiB0aXRs' +
  'ZUNhc2UoYVtHLm93bmVyXSB8fCAnJyksCiAgICAgIG1haWw6IHRpdGxlQ2FzZShbYVtHLm1haWxdLCBtY2l0eSwgRy5tYWlsc3Rh' +
  'dGUgPyBhW0cubWFpbHN0YXRlXSA6ICcnLAogICAgICAgICAgICAgICAgICAgICAgIEcubWFpbHppcCA/IGFbRy5tYWlsemlwXSA6' +
  'ICcnXS5maWx0ZXIoQm9vbGVhbikuam9pbignLCAnKSksCiAgICAgIG1haWxjaXR5OiB0aXRsZUNhc2UobWNpdHkpLAogICAgICBl' +
  'eGVtcHQ6IGV4LCBob21lc3RlYWQ6IC9cYkhTXGIvaS50ZXN0KGV4KSwKICAgICAgb3V0b2Z0b3duOiAhIShtY2l0eSAmJiBwY2l0' +
  'eSAmJiBtY2l0eS50b1VwcGVyQ2FzZSgpICE9PSBwY2l0eS50b1VwcGVyQ2FzZSgpKSwKICAgICAgbGVnYWw6IEcubGVnYWwgPyBT' +
  'dHJpbmcoYVtHLmxlZ2FsXSB8fCAnJykudHJpbSgpIDogJycsCiAgICAgIGRlZWQ6IGRlZWRPZihHLCBhKSwKICAgICAgcGlkLCBn' +
  'ZW86IEcuZ2VvID8gYVtHLmdlb10gOiAnJywgbGluazogKENBRFtrZXldLmxpbmsgJiYgcGlkKSA/IENBRFtrZXldLmxpbmsocGlk' +
  'KSA6ICcnCiAgICB9OwogIH0pOwp9CgpsZXQgUFJPUCA9IHsga2V5OiAnVFh8SElEQUxHTycsIG1vZGU6ICdhZGRyJywgcmVzdWx0' +
  'czogW10sIGpvYklkOiBudWxsLCBwZW5kaW5nOiBudWxsIH07CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gZmluZCAtLS0tLS0gKi8KLyogVGhyZWUgbG9va3VwcyBiZWhpbmQgb25lIHRhYiwg' +
  'YmVjYXVzZSBpbiBwcmFjdGljZSB0aGV5IGFyZSBvbmUgam9iOiB5b3UgaGF2ZQogICBhIG5hbWUgYW5kIGEgc3RhbGUgYWRkcmVz' +
  'cywgYW5kIHlvdSBhcmUgdHJ5aW5nIHRvIHR1cm4gdGhhdCBpbnRvIGEgZG9vci4KCiAgIFBlb3BsZSBhbmQgQWRkcmVzcyBzZWFy' +
  'Y2ggd2hhdCB0aGlzIGNvbXBhbnkgYWxyZWFkeSBrbm93cyDigJQgd2hpY2ggaXMgdGhlIGJlc3QKICAgc2tpcC10cmFjZSBkYXRh' +
  'YmFzZSBhIHdvcmtpbmcgc2VydmVyIGhhcyBhbmQsIHVudGlsIG5vdywgdGhlIGxlYXN0IHVzZWQuCiAgIFByb3BlcnR5IGdvZXMg' +
  'b3V0IHRvIHRoZSBjb3VudHkgYXBwcmFpc2FsIHJvbGwuICAgICAgICAgICAgICAgICAgICAgICAgICAgKi8KCmxldCBGSU5EID0g' +
  'eyB0YWI6ICdwZW9wbGUnLCBxOiAnJywgcGVvcGxlOiBbXSwgcGxhY2VzOiBbXSwgcGVyc29uOiBudWxsLCBidXN5OiBmYWxzZSwg' +
  'cmFuOiBmYWxzZSB9OwoKY29uc3Qgb3V0Y29tZVBpbGwgPSBvID0+IHsKICBjb25zdCBiYWQgPSAvYmFkIGFkZHJlc3N8bW92ZWR8' +
  'ZXZhZC9pLnRlc3Qobyk7CiAgY29uc3QgZ29vZCA9IC9zZXJ2ZWQvaS50ZXN0KG8pOwogIHJldHVybiBgPHNwYW4gY2xhc3M9InBp' +
  'bGwke2dvb2QgPyAnIG9rJyA6IGJhZCA/ICcgd2FybicgOiAnJ30iPiR7ZXNjKG8pfTwvc3Bhbj5gOwp9OwoKZnVuY3Rpb24gZmlu' +
  'ZFZpZXcoKSB7CiAgY29uc3QgdGFiID0gKGssIGxhYmVsKSA9PgogICAgYDxidXR0b24gY2xhc3M9ImJ0biAke0ZJTkQudGFiID09' +
  'PSBrID8gJycgOiAnc2VjICd9c20iIGRhdGEtZnQ9IiR7a30iPiR7bGFiZWx9PC9idXR0b24+YDsKCiAgYXBwLmlubmVySFRNTCA9' +
  'IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFnZSI+RmluZDwvaDE+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGRpdiBj' +
  'bGFzcz0icm93IiBzdHlsZT0iZ2FwOjZweCI+CiAgICAgICAgJHt0YWIoJ3Blb3BsZScsICdQZXJzb24nKX0ke3RhYignYWRkcmVz' +
  'cycsICdBZGRyZXNzJyl9JHt0YWIoJ3Byb3BlcnR5JywgJ1Byb3BlcnR5Jyl9CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGlkPSJm' +
  'aW5kQm9keSIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgaWQ9ImZpbmRPdXQiPjwv' +
  'ZGl2PmApOwogIGJpbmRTaGVsbCgpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWZ0XScpLmZvckVhY2goYiA9' +
  'PiBiLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBGSU5ELnRhYiA9IGIuZGF0YXNldC5mdDsKICAgIEZJTkQucmFuID0gZmFsc2U7CiAg' +
  'ICBpZiAoRklORC50YWIgPT09ICdwcm9wZXJ0eScpIHJldHVybiBwcm9wZXJ0eVZpZXcoKTsKICAgIGZpbmRWaWV3KCk7CiAgfSk7' +
  'CiAgZHJhd0ZpbmRGb3JtKCk7Cn0KCmZ1bmN0aW9uIGRyYXdGaW5kRm9ybSgpIHsKICBjb25zdCBib2R5ID0gJCgnI2ZpbmRCb2R5' +
  'Jyk7CiAgY29uc3QgcGVyc29uID0gRklORC50YWIgPT09ICdwZW9wbGUnOwogIGJvZHkuaW5uZXJIVE1MID0gYAogICAgPGRpdiBj' +
  'bGFzcz0iZmllbGQiPjxsYWJlbD4ke3BlcnNvbiA/ICdOYW1lJyA6ICdBZGRyZXNzJ308L2xhYmVsPgogICAgICA8aW5wdXQgaWQ9' +
  'ImZpbmRRIiB2YWx1ZT0iJHtlc2MoRklORC5xKX0iIGF1dG9jb21wbGV0ZT0ib2ZmIgogICAgICAgIHBsYWNlaG9sZGVyPSIke3Bl' +
  'cnNvbiA/ICdNYXJpYSBHYXJ6YScgOiAnMTgwNiBBc2ggQXZlJ30iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAg' +
  'PGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0iZmluZEdvIj5TZWFyY2g8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNl' +
  'YyIgaWQ9ImZpbmRDbGVhciI+Q2xlYXI8L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPHAgY2xhc3M9ImhpbnQiPiR7cGVyc29uCiAg' +
  'ICAgID8gJ0V2ZXJ5IGpvYiwgYWRkcmVzcyBhbmQgYXR0ZW1wdCBvbiBmaWxlIGZvciB0aGF0IG5hbWUg4oCUIGZpcnN0IGFuZCBs' +
  'YXN0IG5hbWUgaW4gZWl0aGVyIG9yZGVyLicKICAgICAgOiAnRXZlcnlvbmUgeW91IGhhdmUgdHJpZWQgdG8gc2VydmUgYXQgYW4g' +
  'YWRkcmVzcywgYW5kIHdobyBhbnN3ZXJlZCB0aGUgZG9vci4nfTwvcD5gOwoKICAkKCcjZmluZEdvJykub25jbGljayA9IHJ1bkZp' +
  'bmQ7CiAgJCgnI2ZpbmRDbGVhcicpLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBGSU5ELnEgPSAnJzsgRklORC5wZW9wbGUgPSBbXTsg' +
  'RklORC5wbGFjZXMgPSBbXTsgRklORC5wZXJzb24gPSBudWxsOyBGSU5ELnJhbiA9IGZhbHNlOwogICAgZmluZFZpZXcoKTsKICB9' +
  'OwogIGNvbnN0IGlucHV0ID0gJCgnI2ZpbmRRJyk7CiAgaW5wdXQub25rZXlkb3duID0gZSA9PiB7IGlmIChlLmtleSA9PT0gJ0Vu' +
  'dGVyJykgcnVuRmluZCgpOyB9OwogIGlmICghRklORC5wZXJzb24pIGlucHV0LmZvY3VzKCk7CiAgZHJhd0ZpbmRSZXN1bHRzKCk7' +
  'Cn0KCmFzeW5jIGZ1bmN0aW9uIHJ1bkZpbmQoKSB7CiAgY29uc3QgdGVybSA9ICgkKCcjZmluZFEnKS52YWx1ZSB8fCAnJykudHJp' +
  'bSgpOwogIEZJTkQucSA9IHRlcm07CiAgRklORC5wZXJzb24gPSBudWxsOwogIGlmICh0ZXJtLmxlbmd0aCA8IDIpIHsgdG9hc3Qo' +
  'J1R5cGUgYXQgbGVhc3QgdHdvIGNoYXJhY3RlcnMnLCB0cnVlKTsgcmV0dXJuOyB9CiAgRklORC5idXN5ID0gdHJ1ZTsgRklORC5y' +
  'YW4gPSB0cnVlOwogICQoJyNmaW5kT3V0JykuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImVtcHR5' +
  'Ij5TZWFyY2hpbmfigKY8L2Rpdj48L2Rpdj4nOwogIHRyeSB7CiAgICBpZiAoRklORC50YWIgPT09ICdwZW9wbGUnKSB7CiAgICAg' +
  'IGNvbnN0IGQgPSBhd2FpdCBhcGkoJy9wZW9wbGU/cT0nICsgZW5jb2RlVVJJQ29tcG9uZW50KHRlcm0pKTsKICAgICAgRklORC5w' +
  'ZW9wbGUgPSBkLnBlb3BsZSB8fCBbXTsKICAgIH0gZWxzZSB7CiAgICAgIGNvbnN0IGQgPSBhd2FpdCBhcGkoJy9wZW9wbGUvYXQ/' +
  'cT0nICsgZW5jb2RlVVJJQ29tcG9uZW50KHRlcm0pKTsKICAgICAgRklORC5wbGFjZXMgPSBkLmFkZHJlc3NlcyB8fCBbXTsKICAg' +
  'IH0KICB9IGNhdGNoIChlKSB7CiAgICBGSU5ELnBlb3BsZSA9IFtdOyBGSU5ELnBsYWNlcyA9IFtdOwogICAgdG9hc3QoZS5tZXNz' +
  'YWdlLCB0cnVlKTsKICB9CiAgRklORC5idXN5ID0gZmFsc2U7CiAgZHJhd0ZpbmRSZXN1bHRzKCk7Cn0KCmZ1bmN0aW9uIGRyYXdG' +
  'aW5kUmVzdWx0cygpIHsKICBjb25zdCBvdXQgPSAkKCcjZmluZE91dCcpOwogIGlmICghb3V0KSByZXR1cm47CiAgaWYgKEZJTkQu' +
  'cGVyc29uKSByZXR1cm4gZHJhd1BlcnNvbihvdXQpOwogIGlmICghRklORC5yYW4pIHsgb3V0LmlubmVySFRNTCA9ICcnOyByZXR1' +
  'cm47IH0KCiAgaWYgKEZJTkQudGFiID09PSAncGVvcGxlJykgewogICAgaWYgKCFGSU5ELnBlb3BsZS5sZW5ndGgpIHsKICAgICAg' +
  'LyogTm90aGluZyBvZiB5b3VyIG93biBpcyB0aGUgbW9tZW50IHRoZSBwdWJsaWMgcmVjb3JkcyBtYXR0ZXIgbW9zdCDigJQgYQog' +
  'ICAgICAgICBkZWZlbmRhbnQgeW91IGhhdmUgbmV2ZXIgc2VydmVkIGJlZm9yZSBpcyBleGFjdGx5IHdobyB5b3UgaGF2ZSB0byBn' +
  'bwogICAgICAgICBhbmQgZmluZC4gU2VuZGluZyBzb21lYm9keSB0byBhIGRlYWQgZW5kIGhlcmUgd291bGQgd2FzdGUgdGhlIHNl' +
  'YXJjaC4gKi8KICAgICAgb3V0LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJlbXB0eSI+CiAgICAg' +
  'ICAgTm8gb25lIGJ5IHRoYXQgbmFtZSBpbiB5b3VyIHJlY29yZHMuPGJyPjxzcGFuIGNsYXNzPSJoaW50Ij5Ob2JvZHkgeW91IGhh' +
  'dmUKICAgICAgICB3b3JrZWQgb24gYmVmb3JlIOKAlCBzbyB0aGUgcHVibGljIHJlY29yZHMgYmVsb3cgYXJlIHRoZSBwbGFjZSB0' +
  'byBzdGFydC48L3NwYW4+PC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY2FyZCIgaWQ9InB1YkNhcmQiPgogICAgICAg' +
  'ICAgPGgyPlB1YmxpYyByZWNvcmRzIDxzcGFuIGNsYXNzPSJzdWIiIGlkPSJwdWJTdGF0dXMiPmxvb2tpbmfigKY8L3NwYW4+PC9o' +
  'Mj4KICAgICAgICAgIDxkaXYgaWQ9InB1Yk91dCI+PC9kaXY+CiAgICAgICAgPC9kaXY+YDsKICAgICAgbG9hZFB1YmxpYyh7IG5h' +
  'bWU6IEZJTkQucSB9KTsKICAgICAgcmV0dXJuOwogICAgfQogICAgb3V0LmlubmVySFRNTCA9IEZJTkQucGVvcGxlLm1hcChwID0+' +
  'IGAKICAgICAgPGRpdiBjbGFzcz0iY2FyZCBwZXJzb24iIGRhdGEta2V5PSIke2VzYyhwLmtleSl9IiBzdHlsZT0iY3Vyc29yOnBv' +
  'aW50ZXIiPgogICAgICAgIDxoMj4ke2VzYyhwLm5hbWUpfSA8c3BhbiBjbGFzcz0ic3ViIj4ke3Auc3RhdHMuam9ic30gam9iJHtw' +
  'LnN0YXRzLmpvYnMgPT09IDEgPyAnJyA6ICdzJ308L3NwYW4+PC9oMj4KICAgICAgICAke3AudmFyaWFudHMubGVuZ3RoID4gMSA/' +
  'IGA8ZGl2IGNsYXNzPSJoaW50Ij5hbHNvIG9uIGZpbGUgYXMgJHsKICAgICAgICAgIGVzYyhwLnZhcmlhbnRzLmZpbHRlcih2ID0+' +
  'IHYgIT09IHAubmFtZSkuam9pbignIMK3ICcpKX08L2Rpdj5gIDogJyd9CiAgICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9' +
  'Im1hcmdpbi10b3A6NnB4Ij4KICAgICAgICAgICR7cC5zdGF0cy5hdHRlbXB0c30gYXR0ZW1wdCR7cC5zdGF0cy5hdHRlbXB0cyA9' +
  'PT0gMSA/ICcnIDogJ3MnfSDCtwogICAgICAgICAgJHtwLmFkZHJlc3Nlcy5sZW5ndGh9IGFkZHJlc3Mke3AuYWRkcmVzc2VzLmxl' +
  'bmd0aCA9PT0gMSA/ICcnIDogJ2VzJ30KICAgICAgICAgICR7cC5zdGF0cy5zZXJ2ZWQgPyBgIMK3IDxiIHN0eWxlPSJjb2xvcjp2' +
  'YXIoLS1nb29kKSI+c2VydmVkICR7cC5zdGF0cy5zZXJ2ZWR9w5c8L2I+YCA6ICcnfQogICAgICAgICAgJHtwLnN0YXRzLmV2YXNp' +
  'dmUgPyBgIMK3IDxiIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQpIj5ldmFzaXZlPC9iPmAgOiAnJ30KICAgICAgICAgICR7cC5zdGF0' +
  'cy5iYWRfYWRkcmVzcyA/IGAgwrcgJHtwLnN0YXRzLmJhZF9hZGRyZXNzfSBiYWQgYWRkcmVzc2AgOiAnJ30KICAgICAgICA8L2Rp' +
  'dj4KICAgICAgICAke3AuYWRkcmVzc2VzLnNsaWNlKDAsIDIpLm1hcChhID0+IGA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFy' +
  'Z2luLXRvcDo0cHgiPgogICAgICAgICAg4oyCICR7ZXNjKGEubGluZSl9JHthLmNpdHkgPyAnLCAnICsgZXNjKGEuY2l0eSkgOiAn' +
  'J30KICAgICAgICAgICR7YS5hdHRlbXB0cyA/IGA8c3BhbiBjbGFzcz0ic3ViIj4g4oCUICR7YS5hdHRlbXB0c30gYXR0ZW1wdCR7' +
  'YS5hdHRlbXB0cyA9PT0gMSA/ICcnIDogJ3MnfTwvc3Bhbj5gIDogJyd9CiAgICAgICAgPC9kaXY+YCkuam9pbignJyl9CiAgICAg' +
  'ICAgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4O2NvbG9yOnZhcigtLWJyYW5kKTtmb250LXdlaWdodDo3' +
  'MDAiPk9wZW4g4oaSPC9kaXY+CiAgICAgIDwvZGl2PmApLmpvaW4oJycpOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgn' +
  'LnBlcnNvbicpLmZvckVhY2goYyA9PiBjLm9uY2xpY2sgPSAoKSA9PiBvcGVuUGVyc29uKGMuZGF0YXNldC5rZXkpKTsKICAgIHJl' +
  'dHVybjsKICB9CgogIGlmICghRklORC5wbGFjZXMubGVuZ3RoKSB7CiAgICBvdXQuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImNh' +
  'cmQiPjxkaXYgY2xhc3M9ImVtcHR5Ij4KICAgICAgTm90aGluZyBvbiBmaWxlIGF0IHRoYXQgYWRkcmVzcy48YnI+PHNwYW4gY2xh' +
  'c3M9ImhpbnQiPk5ldmVyIGJlZW4gdGhlcmUg4oCUIHNvIHRyeQogICAgICB0aGUgcHVibGljIHJlY29yZHMgYmVsb3csIG9yIHRo' +
  'ZSBjb3VudHkgcm9sbCB1bmRlciBQcm9wZXJ0eSBmb3Igd2hvIG93bnMgaXQuPC9zcGFuPjwvZGl2PjwvZGl2PgogICAgICA8ZGl2' +
  'IGNsYXNzPSJjYXJkIiBpZD0icHViQ2FyZCI+CiAgICAgICAgPGgyPlB1YmxpYyByZWNvcmRzIDxzcGFuIGNsYXNzPSJzdWIiIGlk' +
  'PSJwdWJTdGF0dXMiPmxvb2tpbmfigKY8L3NwYW4+PC9oMj4KICAgICAgICA8ZGl2IGlkPSJwdWJPdXQiPjwvZGl2PgogICAgICA8' +
  'L2Rpdj5gOwogICAgbG9hZFB1YmxpYyh7IGFkZHJlc3M6IEZJTkQucSB9KTsKICAgIHJldHVybjsKICB9CiAgb3V0LmlubmVySFRN' +
  'TCA9IEZJTkQucGxhY2VzLm1hcChhID0+IGAKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+JHtlc2MoYS5saW5lKX0g' +
  'PHNwYW4gY2xhc3M9InN1YiI+JHtlc2MoW2EuY2l0eSwgYS5zdGF0ZV0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJywgJykpfTwvc3Bh' +
  'bj48L2gyPgogICAgICA8ZGl2IGNsYXNzPSJoaW50Ij4ke2EuYXR0ZW1wdHN9IGF0dGVtcHQke2EuYXR0ZW1wdHMgPT09IDEgPyAn' +
  'JyA6ICdzJ30kewogICAgICAgIGEubGFzdCA/ICcgwrcgbGFzdCAnICsgZm10RFQoYS5sYXN0KSA6ICcnfQogICAgICAgICR7T2Jq' +
  'ZWN0LmVudHJpZXMoYS5vdXRjb21lcyB8fCB7fSkubWFwKChbbywgbl0pID0+IGAgwrcgJHtlc2Mobyl9IMOXJHtufWApLmpvaW4o' +
  'JycpfTwvZGl2PgoKICAgICAgPGRpdiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij48Yj5UcmllZCBoZXJlPC9iPjwvZGl2PgogICAg' +
  'ICAke2EucGVvcGxlLm1hcChwID0+IGA8ZGl2IGNsYXNzPSJoaW50IiBkYXRhLXBrPSIke2VzYyhwLmtleSl9IgogICAgICAgIHN0' +
  'eWxlPSJtYXJnaW4tdG9wOjNweDtjb2xvcjp2YXIoLS1icmFuZCk7Y3Vyc29yOnBvaW50ZXIiPgogICAgICAgICR7ZXNjKHAubmFt' +
  'ZSl9IDxzcGFuIGNsYXNzPSJzdWIiPuKAlCAke09iamVjdC5lbnRyaWVzKHAuc3RhdHVzZXMpLm1hcCgoW3MsIG5dKSA9PgogICAg' +
  'ICAgICAgZXNjKHMpICsgKG4gPiAxID8gJyDDlycgKyBuIDogJycpKS5qb2luKCcsICcpfTwvc3Bhbj48L2Rpdj5gKS5qb2luKCcn' +
  'KX0KCiAgICAgICR7YS5hbnN3ZXJlZC5sZW5ndGggPyBgPGRpdiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij48Yj5BbnN3ZXJlZCB0' +
  'aGUgZG9vcjwvYj4KICAgICAgICA8ZGl2IGNsYXNzPSJoaW50Ij5Vc2VmdWwgZm9yIHN1YnN0aXR1dGVkIHNlcnZpY2Ug4oCUIHNv' +
  'bWVvbmUgb2Ygc3VpdGFibGUgYWdlIHlvdSBoYXZlCiAgICAgICAgICBhbHJlYWR5IG1ldCBhbmQgcmVjb3JkZWQuPC9kaXY+CiAg' +
  'ICAgICAgJHthLmFuc3dlcmVkLm1hcCh3ID0+IGA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDozcHgiPgogICAg' +
  'ICAgICAgJHtlc2Mody5uYW1lKX0ke3cucmVsYXRpb25zaGlwID8gYCA8c3BhbiBjbGFzcz0ic3ViIj7igJQgJHtlc2Mody5yZWxh' +
  'dGlvbnNoaXApfTwvc3Bhbj5gIDogJyd9CiAgICAgICAgICA8c3BhbiBjbGFzcz0ic3ViIj7CtyAke3cudGltZXN9w5csIGxhc3Qg' +
  'JHtmbXREVCh3Lmxhc3QpfTwvc3Bhbj48L2Rpdj5gKS5qb2luKCcnKX0KICAgICAgPC9kaXY+YCA6ICcnfQogICAgPC9kaXY+YCku' +
  'am9pbignJykgKyBgCiAgICA8ZGl2IGNsYXNzPSJjYXJkIiBpZD0icHViQ2FyZCI+CiAgICAgIDxoMj5QdWJsaWMgcmVjb3JkcyA8' +
  'c3BhbiBjbGFzcz0ic3ViIiBpZD0icHViU3RhdHVzIj5sb29raW5n4oCmPC9zcGFuPjwvaDI+CiAgICAgIDxkaXYgaWQ9InB1Yk91' +
  'dCI+PC9kaXY+CiAgICA8L2Rpdj5gOwoKICAvLyBBbnkgYnVzaW5lc3MgdHJhZGluZyBhdCB0aGlzIGFkZHJlc3MsIGZyb20gdGhl' +
  'IHNhbGVzIHRheCBwZXJtaXQgcm9sbC4KICBsb2FkUHVibGljKHsgYWRkcmVzczogRklORC5xIH0pOwogIGRvY3VtZW50LnF1ZXJ5' +
  'U2VsZWN0b3JBbGwoJ1tkYXRhLXBrXScpLmZvckVhY2goZWwgPT4KICAgIGVsLm9uY2xpY2sgPSAoKSA9PiB7IEZJTkQudGFiID0g' +
  'J3Blb3BsZSc7IG9wZW5QZXJzb24oZWwuZGF0YXNldC5wayk7IH0pOwp9CgovKiAtLS0tIHB1YmxpYyByZWNvcmRzIC0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLQogICBGcmVlIGdvdmVybm1lbnQgc291cmNlcywg' +
  'c2hvd24gdW5kZXIgdGhlIHBlcnNvbidzIG93biBoaXN0b3J5IGJlY2F1c2UgdGhhdAogICBpcyB0aGUgb3JkZXIgeW91IHNob3Vs' +
  'ZCByZWFkIHRoZW0gaW46IHdoYXQgeW91IGtub3csIHRoZW4gd2hhdCBpcyBjbGFpbWVkLiAgKi8KYXN5bmMgZnVuY3Rpb24gbG9h' +
  'ZFB1YmxpYyhxKSB7CiAgY29uc3QgYm94ID0gJCgnI3B1Yk91dCcpLCBzdGF0dXMgPSAkKCcjcHViU3RhdHVzJyk7CiAgaWYgKCFi' +
  'b3gpIHJldHVybjsKICBjb25zdCBxcyA9IHEubmFtZSA/ICduYW1lPScgKyBlbmNvZGVVUklDb21wb25lbnQocS5uYW1lKQogICAg' +
  'ICAgICAgICAgICAgICAgIDogJ2FkZHJlc3M9JyArIGVuY29kZVVSSUNvbXBvbmVudChxLmFkZHJlc3MpOwogIGxldCBkOwogIHRy' +
  'eSB7CiAgICBkID0gYXdhaXQgYXBpKCcvcGVvcGxlL3B1YmxpYz8nICsgcXMpOwogIH0gY2F0Y2ggKGUpIHsKICAgIHN0YXR1cy50' +
  'ZXh0Q29udGVudCA9ICcnOwogICAgYm94LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJoaW50Ij5Db3VsZG4ndCByZWFjaCB0aGUg' +
  'cHVibGljIHJlY29yZHMgc2VydmljZXMg4oCUICR7ZXNjKGUubWVzc2FnZSl9LgogICAgICBOb3RoaW5nIGVsc2Ugb24gdGhpcyBw' +
  'YWdlIGRlcGVuZHMgb24gdGhlbS48L2Rpdj5gOwogICAgcmV0dXJuOwogIH0KCiAgY29uc3QgYWxsID0gZC5zb3VyY2VzIHx8IFtd' +
  'OwogIGNvbnN0IHdpdGhIaXRzID0gYWxsLmZpbHRlcihzID0+IHMucmVzdWx0cy5sZW5ndGgpOwogIGNvbnN0IGJyb2tlID0gYWxs' +
  'LmZpbHRlcihzID0+ICFzLm9rKTsKICBjb25zdCB0b3RhbCA9IHdpdGhIaXRzLnJlZHVjZSgobiwgcykgPT4gbiArIHMucmVzdWx0' +
  'cy5sZW5ndGgsIDApOwoKICAvKiAiTm90aGluZyBmb3VuZCIgYW5kICJjb3VsZG4ndCBhc2siIGFyZSBkaWZmZXJlbnQgYW5zd2Vy' +
  'cywgYW5kIHNvbWVib2R5CiAgICAgZGVjaWRpbmcgd2hldGhlciB0byBzdG9wIGxvb2tpbmcgbmVlZHMgdG8ga25vdyB3aGljaCBv' +
  'bmUgdGhleSBnb3QuICovCiAgY29uc3QgYWxsRG93biA9IGFsbC5sZW5ndGggJiYgYnJva2UubGVuZ3RoID09PSBhbGwubGVuZ3Ro' +
  'OwogIHN0YXR1cy50ZXh0Q29udGVudCA9IGFsbERvd24gPyAiY291bGRuJ3QgcmVhY2ggdGhlbSIKICAgIDogdG90YWwgPyBgJHt0' +
  'b3RhbH0gcG9zc2libGUgbWF0Y2gke3RvdGFsID09PSAxID8gJycgOiAnZXMnfWAKICAgIDogJ25vdGhpbmcgZm91bmQnOwoKICBp' +
  'ZiAoYWxsRG93bikgewogICAgYm94LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0iY29sb3I6dmFyKC0tYmFk' +
  'KSI+PGI+Tm9uZSBvZiB0aGUgcHVibGljIHJlY29yZHMKICAgICAgc2VydmljZXMgYW5zd2VyZWQ8L2I+LCBzbyB0aGlzIHRlbGxz' +
  'IHlvdSBub3RoaW5nIGVpdGhlciB3YXkg4oCUIGl0IGlzIG5vdCB0aGUgc2FtZSBhcwogICAgICBmaW5kaW5nIG5vdGhpbmcuICR7' +
  'YnJva2UubWFwKHMgPT4gZXNjKHMubGFiZWwpICsgJyDigJQgJyArIGVzYyhzLmVycm9yKSkuam9pbignOyAnKX0uPC9kaXY+CiAg' +
  'ICAgIDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjZweCI+WW91ciBvd24gcmVjb3JkcyBhYm92ZSBhcmUgdW5h' +
  'ZmZlY3RlZC4KICAgICAgICA8YSBocmVmPSIjIiBpZD0icHViUmV0cnkiPlRyeSBhZ2FpbjwvYT48L2Rpdj5gOwogICAgY29uc3Qg' +
  'YWdhaW4gPSAkKCcjcHViUmV0cnknKTsKICAgIGlmIChhZ2FpbikgYWdhaW4ub25jbGljayA9IGUgPT4gewogICAgICBlLnByZXZl' +
  'bnREZWZhdWx0KCk7CiAgICAgIHN0YXR1cy50ZXh0Q29udGVudCA9ICdsb29raW5n4oCmJzsKICAgICAgYm94LmlubmVySFRNTCA9' +
  'ICcnOwogICAgICBsb2FkUHVibGljKHEpOwogICAgfTsKICAgIHJldHVybjsKICB9CgogIGlmICghd2l0aEhpdHMubGVuZ3RoKSB7' +
  'CiAgICBib3guaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImhpbnQiPk5vdGhpbmcgdW5kZXIgdGhhdCBuYW1lIGluCiAgICAgICR7' +
  'YnJva2UubGVuZ3RoID8gJ3RoZSBzb3VyY2VzIHRoYXQgYW5zd2VyZWQnIDogJ3RoZSBmcmVlIGdvdmVybm1lbnQgc291cmNlcyd9' +
  'IOKAlAogICAgICBjb21wYW55IGZpbGluZ3MsIHNhbGVzIHRheCBwZXJtaXRzLCB0cmFkZSBsaWNlbmNlcyBvciB0aGUgaGVhbHRo' +
  'Y2FyZSByZWdpc3RyeS4KICAgICAgVGhhdCBpcyBjb21tb24gZm9yIHNvbWVvbmUgd2hvIHJlbnRzIGFuZCB3b3JrcyBmb3IgYSB3' +
  'YWdlLjwvZGl2PgogICAgICAke2Jyb2tlLmxlbmd0aCA/IGA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDo2cHg7' +
  'Y29sb3I6dmFyKC0tYmFkKSI+CiAgICAgICAgQ291bGRuJ3QgcmVhY2g6ICR7YnJva2UubWFwKHMgPT4gZXNjKHMubGFiZWwpICsg' +
  'JyAoJyArIGVzYyhzLmVycm9yKSArICcpJykuam9pbignLCAnKX0g4oCUCiAgICAgICAgc28gdGhpcyBpcyBub3QgYSBjb21wbGV0' +
  'ZSBhbnN3ZXIuPC9kaXY+YCA6ICcnfWA7CiAgICByZXR1cm47CiAgfQoKICBib3guaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFz' +
  'cz0iaGludCIgc3R5bGU9Im1hcmdpbi1ib3R0b206MTBweCI+JHtlc2MoZC5ub3RlKX08L2Rpdj4KICAgICR7d2l0aEhpdHMubWFw' +
  'KHMgPT4gYAogICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPgogICAgICAgIDxkaXY+PGI+JHtlc2Mocy5sYWJlbCl9' +
  'PC9iPiA8c3BhbiBjbGFzcz0ic3ViIj4ke3MucmVzdWx0cy5sZW5ndGh9PC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9' +
  'ImhpbnQiIHN0eWxlPSJtYXJnaW4tYm90dG9tOjZweCI+JHtlc2Mocy53aGF0KX08L2Rpdj4KICAgICAgICAke3MucmVzdWx0cy5z' +
  'bGljZSgwLCAxMikubWFwKHIgPT4gYAogICAgICAgICAgPGRpdiBzdHlsZT0icGFkZGluZzo3cHggMDtib3JkZXItYm90dG9tOjFw' +
  'eCBzb2xpZCB2YXIoLS1saW5lKSI+CiAgICAgICAgICAgIDxkaXY+PGI+JHtlc2Moci5uYW1lKX08L2I+IDxzcGFuIGNsYXNzPSJw' +
  'aWxsIj4ke2VzYyhyLmtpbmQpfTwvc3Bhbj48L2Rpdj4KICAgICAgICAgICAgJHtyLmFkZHJlc3MgPyBgPGRpdiBjbGFzcz0iaGlu' +
  'dCI+JHtlc2Moci5hZGRyZXNzKX0kewogICAgICAgICAgICAgIHIuY2l0eSA/ICcsICcgKyBlc2Moci5jaXR5KSA6ICcnfSR7ci56' +
  'aXAgPyAnICcgKyBlc2Moci56aXApIDogJyd9PC9kaXY+YCA6ICcnfQogICAgICAgICAgICAke3IuZGV0YWlsID8gYDxkaXYgY2xh' +
  'c3M9ImhpbnQiPiR7ZXNjKHIuZGV0YWlsKX08L2Rpdj5gIDogJyd9CiAgICAgICAgICAgICR7ci5hZGRyZXNzID8gYDxkaXYgc3R5' +
  'bGU9Im1hcmdpbi10b3A6NXB4Ij48YSBjbGFzcz0iYnRuIHNlYyBzbSIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiCiAg' +
  'ICAgICAgICAgICAgaHJlZj0iaHR0cHM6Ly93d3cuZ29vZ2xlLmNvbS9tYXBzL3NlYXJjaC8/YXBpPTEmcXVlcnk9JHtlbmNvZGVV' +
  'UklDb21wb25lbnQoCiAgICAgICAgICAgICAgICBbci5hZGRyZXNzLCByLmNpdHksIHIuc3RhdGUsIHIuemlwXS5maWx0ZXIoQm9v' +
  'bGVhbikuam9pbignICcpKX0iPk1hcDwvYT48L2Rpdj5gIDogJyd9CiAgICAgICAgICA8L2Rpdj5gKS5qb2luKCcnKX0KICAgICAg' +
  'ICAke3MucmVzdWx0cy5sZW5ndGggPiAxMiA/IGA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDo2cHgiPgogICAg' +
  'ICAgICAgYW5kICR7cy5yZXN1bHRzLmxlbmd0aCAtIDEyfSBtb3JlIOKAlCBuYXJyb3cgdGhlIG5hbWUgaWYgbm9uZSBvZiB0aGVz' +
  'ZSBmaXQuPC9kaXY+YCA6ICcnfQogICAgICA8L2Rpdj5gKS5qb2luKCcnKX0KICAgICR7YnJva2UubGVuZ3RoID8gYDxkaXYgY2xh' +
  'c3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHg7Y29sb3I6dmFyKC0tYmFkKSI+CiAgICAgIENvdWxkbid0IHJlYWNoOiAk' +
  'e2Jyb2tlLm1hcChzID0+IGVzYyhzLmxhYmVsKSkuam9pbignLCAnKX0uIFRyeSBhZ2FpbiBpbiBhIG1vbWVudC48L2Rpdj5gIDog' +
  'Jyd9YDsKfQoKYXN5bmMgZnVuY3Rpb24gb3BlblBlcnNvbihrZXkpIHsKICB0cnkgewogICAgRklORC5wZXJzb24gPSBhd2FpdCBh' +
  'cGkoJy9wZW9wbGUvb25lP2tleT0nICsgZW5jb2RlVVJJQ29tcG9uZW50KGtleSkpOwogICAgZmluZFZpZXcoKTsKICB9IGNhdGNo' +
  'IChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KfQoKZnVuY3Rpb24gZHJhd1BlcnNvbihvdXQpIHsKICBjb25zdCBwID0g' +
  'RklORC5wZXJzb247CiAgY29uc3QgcyA9IHAuc3RhdHM7CiAgb3V0LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9ImNhcmQi' +
  'PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpm' +
  'bGV4LXN0YXJ0Ij4KICAgICAgICA8ZGl2PjxoMiBzdHlsZT0ibWFyZ2luOjAiPiR7ZXNjKHAubmFtZSl9PC9oMj4KICAgICAgICAg' +
  'ICR7cC52YXJpYW50cy5sZW5ndGggPiAxID8gYDxkaXYgY2xhc3M9ImhpbnQiPmFsc286ICR7CiAgICAgICAgICAgIGVzYyhwLnZh' +
  'cmlhbnRzLmZpbHRlcih2ID0+IHYgIT09IHAubmFtZSkuam9pbignIMK3ICcpKX08L2Rpdj5gIDogJyd9PC9kaXY+CiAgICAgICAg' +
  'PGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9InBCYWNrIj5CYWNrPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2' +
  'IGNsYXNzPSJzdGF0cyIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+CiAgICAgICAgPGRpdiBjbGFzcz0ic3RhdCI+PGRpdiBjbGFz' +
  'cz0ibiI+JHtzLmpvYnN9PC9kaXY+PGRpdiBjbGFzcz0ibCI+Sm9iczwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InN0' +
  'YXQiPjxkaXYgY2xhc3M9Im4iPiR7cy5hdHRlbXB0c308L2Rpdj48ZGl2IGNsYXNzPSJsIj5BdHRlbXB0czwvZGl2PjwvZGl2Pgog' +
  'ICAgICAgIDxkaXYgY2xhc3M9InN0YXQgJHtzLnNlcnZlZCA/ICdnb29kJyA6ICcnfSI+PGRpdiBjbGFzcz0ibiI+JHtzLnNlcnZl' +
  'ZH08L2Rpdj48ZGl2IGNsYXNzPSJsIj5TZXJ2ZWQ8L2Rpdj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJzdGF0ICR7cy5ldmFz' +
  'aXZlID8gJ2FsZXJ0JyA6ICcnfSI+PGRpdiBjbGFzcz0ibiI+JHtwLmFkZHJlc3Nlcy5sZW5ndGh9PC9kaXY+PGRpdiBjbGFzcz0i' +
  'bCI+QWRkcmVzc2VzPC9kaXY+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAg' +
  'ICAgIDxoMj5BZGRyZXNzZXMgPHNwYW4gY2xhc3M9InN1YiI+bW9zdCBhdHRlbXB0ZWQgZmlyc3Q8L3NwYW4+PC9oMj4KICAgICAg' +
  'JHtwLmFkZHJlc3Nlcy5tYXAoYSA9PiBgPGRpdiBzdHlsZT0icGFkZGluZzo5cHggMDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2' +
  'YXIoLS1saW5lKSI+CiAgICAgICAgPGRpdj48Yj4ke2VzYyhhLmxpbmUpfTwvYj4ke2EuY2l0eSA/IGA8c3BhbiBjbGFzcz0ic3Vi' +
  'Ij4gJHtlc2MoYS5jaXR5KX0kewogICAgICAgICAgYS56aXAgPyAnICcgKyBlc2MoYS56aXApIDogJyd9PC9zcGFuPmAgOiAnJ308' +
  'L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoaW50Ij4ke2EuYXR0ZW1wdHMKICAgICAgICAgID8gYCR7YS5hdHRlbXB0c30gYXR0' +
  'ZW1wdCR7YS5hdHRlbXB0cyA9PT0gMSA/ICcnIDogJ3MnfSDCtyAkewogICAgICAgICAgICAgIE9iamVjdC5lbnRyaWVzKGEub3V0' +
  'Y29tZXMpLm1hcCgoW28sIG5dKSA9PiBlc2MobykgKyAobiA+IDEgPyAnIMOXJyArIG4gOiAnJykpLmpvaW4oJywgJyl9CiAgICAg' +
  'ICAgICAgICAke2EubGFzdCA/ICcgwrcgbGFzdCAnICsgZm10RFQoYS5sYXN0KSA6ICcnfWAKICAgICAgICAgIDogJ29uIGZpbGUs' +
  'IG5ldmVyIGF0dGVtcHRlZCd9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDo2cHg7Z2Fw' +
  'OjZweCI+CiAgICAgICAgICA8YSBjbGFzcz0iYnRuIHNlYyBzbSIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiCiAgICAg' +
  'ICAgICAgICBocmVmPSJodHRwczovL3d3dy5nb29nbGUuY29tL21hcHMvc2VhcmNoLz9hcGk9MSZxdWVyeT0kewogICAgICAgICAg' +
  'ICAgICBlbmNvZGVVUklDb21wb25lbnQoW2EubGluZSwgYS5jaXR5LCBhLnN0YXRlLCBhLnppcF0uZmlsdGVyKEJvb2xlYW4pLmpv' +
  'aW4oJyAnKSl9Ij5NYXA8L2E+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBkYXRhLWxvb2t1cD0iJHtlc2Mo' +
  'YS5saW5lKX0iPldobyBlbHNlIGlzIGhlcmU8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+YCkuam9pbignJykg' +
  'fHwgJzxkaXYgY2xhc3M9ImVtcHR5Ij5ObyBhZGRyZXNzZXMgb24gZmlsZS48L2Rpdj4nfQogICAgPC9kaXY+CgogICAgPGRpdiBj' +
  'bGFzcz0iY2FyZCI+CiAgICAgIDxoMj5Kb2JzIDxzcGFuIGNsYXNzPSJzdWIiPiR7cC5qb2JzLmxlbmd0aH08L3NwYW4+PC9oMj4K' +
  'ICAgICAgJHtwLmpvYnMubWFwKGogPT4gYDxkaXYgc3R5bGU9InBhZGRpbmc6OHB4IDA7Ym9yZGVyLWJvdHRvbToxcHggc29saWQg' +
  'dmFyKC0tbGluZSkiPgogICAgICAgIDxkaXY+PGI+JHtlc2Moai5qb2JfbnVtYmVyIHx8ICcnKX08L2I+IDxzcGFuIGNsYXNzPSJw' +
  'aWxsIj4ke2VzYyhqLnN0YXR1cyl9PC9zcGFuPgogICAgICAgICAgJHtqLmNhc2VfbnVtYmVyID8gYDxzcGFuIGNsYXNzPSJzdWIi' +
  'PiAke2VzYyhqLmNhc2VfbnVtYmVyKX08L3NwYW4+YCA6ICcnfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNj' +
  'KGouY2xpZW50X25hbWUgfHwgJ25vIGNsaWVudCcpfSR7CiAgICAgICAgICBqLmFkZHJlc3MgPyAnIMK3ICcgKyBlc2Moai5hZGRy' +
  'ZXNzKSA6ICcnfTwvZGl2PgogICAgICAgICR7ai5ub3RlcyA/IGA8ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyhqLm5vdGVzKX08L2Rp' +
  'dj5gIDogJyd9CiAgICAgIDwvZGl2PmApLmpvaW4oJycpfQogICAgPC9kaXY+CgogICAgJHtwLnRpbWVsaW5lLmxlbmd0aCA/IGA8' +
  'ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkV2ZXJ5IGF0dGVtcHQgPHNwYW4gY2xhc3M9InN1YiI+bmV3ZXN0IGZpcnN0PC9z' +
  'cGFuPjwvaDI+CiAgICAgICR7cC50aW1lbGluZS5tYXAodCA9PiBgPGRpdiBzdHlsZT0icGFkZGluZzo4cHggMDtib3JkZXItYm90' +
  'dG9tOjFweCBzb2xpZCB2YXIoLS1saW5lKSI+CiAgICAgICAgPGRpdj4ke291dGNvbWVQaWxsKHQub3V0Y29tZSl9IDxzcGFuIGNs' +
  'YXNzPSJzdWIiPiR7Zm10RFQodC53aGVuKX0kewogICAgICAgICAgdC5zZXJ2ZXIgPyAnIMK3ICcgKyBlc2ModC5zZXJ2ZXIpIDog' +
  'Jyd9PC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKHQuYWRkcmVzcyB8fCAnJyl9PC9kaXY+CiAg' +
  'ICAgICAgJHt0LnBlcnNvbl9zZXJ2ZWQgPyBgPGRpdiBjbGFzcz0iaGludCI+U3Bva2UgdG8gPGI+JHtlc2ModC5wZXJzb25fc2Vy' +
  'dmVkKX08L2I+JHsKICAgICAgICAgIHQucmVsYXRpb25zaGlwID8gJyDigJQgJyArIGVzYyh0LnJlbGF0aW9uc2hpcCkgOiAnJ308' +
  'L2Rpdj5gIDogJyd9CiAgICAgICAgJHt0Lm5vdGVzID8gYDxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKHQubm90ZXMpfTwvZGl2PmAg' +
  'OiAnJ30KICAgICAgPC9kaXY+YCkuam9pbignJyl9CiAgICA8L2Rpdj5gIDogJyd9CgogICAgPGRpdiBjbGFzcz0iY2FyZCIgaWQ9' +
  'InB1YkNhcmQiPgogICAgICA8aDI+UHVibGljIHJlY29yZHMgPHNwYW4gY2xhc3M9InN1YiIgaWQ9InB1YlN0YXR1cyI+bG9va2lu' +
  'Z+KApjwvc3Bhbj48L2gyPgogICAgICA8ZGl2IGlkPSJwdWJPdXQiPjwvZGl2PgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0i' +
  'Y2FyZCI+CiAgICAgIDxoMj5Mb29rIGZ1cnRoZXI8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLWJv' +
  'dHRvbToxMHB4Ij5UaGUgY291bnR5IGFwcHJhaXNhbCByb2xsIGlzIHRoZSBvdGhlciBmcmVlCiAgICAgICAgc291cmNlIHdvcnRo' +
  'IHRyeWluZyDigJQgYSBtYWlsaW5nIGFkZHJlc3MgZGlmZmVyZW50IGZyb20gdGhlIHByb3BlcnR5IGFkZHJlc3MgaXMgdGhlCiAg' +
  'ICAgICAgc3Ryb25nZXN0IGxlYWQgdGhlcmUgaXMuPC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InBDb3VudHki' +
  'PlNlYXJjaCB0aGUgY291bnR5IHJvbGwgZm9yIHRoaXMgbmFtZTwvYnV0dG9uPgogICAgPC9kaXY+YDsKCiAgLyogRmlyZWQgYWZ0' +
  'ZXIgdGhlIHBhZ2UgaXMgYWxyZWFkeSBvbiBzY3JlZW4sIG5ldmVyIGF3YWl0ZWQgYmVmb3JlIGl0LiBGb3VyCiAgICAgZ292ZXJu' +
  'bWVudCBzZXJ2aWNlcywgYW55IG9mIHdoaWNoIG1heSBiZSBzbG93IOKAlCB0aGUgcGVyc29uJ3Mgb3duIGhpc3RvcnkKICAgICBt' +
  'dXN0IG5vdCB3YWl0IGJlaGluZCB0aGVtLiAqLwogIGxvYWRQdWJsaWMoeyBuYW1lOiBwLm5hbWUgfSk7CgogICQoJyNwQmFjaycp' +
  'Lm9uY2xpY2sgPSAoKSA9PiB7IEZJTkQucGVyc29uID0gbnVsbDsgZmluZFZpZXcoKTsgfTsKICAkKCcjcENvdW50eScpLm9uY2xp' +
  'Y2sgPSAoKSA9PiB7CiAgICBQUk9QLm1vZGUgPSAnb3duZXInOwogICAgUFJPUC5wZW5kaW5nID0gcC5uYW1lOwogICAgcHJvcGVy' +
  'dHlWaWV3KCk7CiAgfTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1sb29rdXBdJykuZm9yRWFjaChiID0+IGIu' +
  'b25jbGljayA9ICgpID0+IHsKICAgIEZJTkQudGFiID0gJ2FkZHJlc3MnOwogICAgRklORC5xID0gYi5kYXRhc2V0Lmxvb2t1cDsK' +
  'ICAgIEZJTkQucGVyc29uID0gbnVsbDsKICAgIGZpbmRWaWV3KCk7CiAgICBzZXRUaW1lb3V0KHJ1bkZpbmQsIDApOwogIH0pOwp9' +
  'CgpmdW5jdGlvbiBwcm9wZXJ0eVZpZXcoKSB7CiAgY29uc3Qgc3JjID0gQ0FEW1BST1Aua2V5XTsKICBjb25zdCBjaXR5T3B0cyA9' +
  'IFsnPG9wdGlvbiB2YWx1ZT0iIj5BbnkgY2l0eTwvb3B0aW9uPiddCiAgICAuY29uY2F0KE9iamVjdC5rZXlzKHNyYy5jaXRpZXMg' +
  'fHwge30pLm1hcChjID0+IGA8b3B0aW9uPiR7ZXNjKGMpfTwvb3B0aW9uPmApKS5qb2luKCcnKTsKCiAgYXBwLmlubmVySFRNTCA9' +
  'IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFnZSI+RmluZDwvaDE+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxkaXYg' +
  'Y2xhc3M9InJvdyIgc3R5bGU9ImdhcDo2cHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGRhdGEtZnQ9InBl' +
  'b3BsZSI+UGVyc29uPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgZGF0YS1mdD0iYWRkcmVzcyI+' +
  'QWRkcmVzczwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgZGF0YS1mdD0icHJvcGVydHkiPlByb3BlcnR5' +
  'PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIGlkPSJwcm9wTW9kZSIgc3R5bGU9ImdhcDo2cHg7' +
  'bWFyZ2luLXRvcDoxMnB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gJHtQUk9QLm1vZGUgPT09ICdhZGRyJyA/ICcnIDog' +
  'J3NlYyAnfXNtIiBkYXRhLW09ImFkZHIiPkJ5IGFkZHJlc3M8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gJHtQ' +
  'Uk9QLm1vZGUgPT09ICdvd25lcicgPyAnJyA6ICdzZWMgJ31zbSIgZGF0YS1tPSJvd25lciI+Qnkgb3duZXI8L2J1dHRvbj4KICAg' +
  'ICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxkaXYg' +
  'Y2xhc3M9ImZpZWxkIj48bGFiZWw+Q291bnR5PC9sYWJlbD48c2VsZWN0IGlkPSJwcm9wQ291bnR5Ij4KICAgICAgICAgICR7T2Jq' +
  'ZWN0LmtleXMoQ0FEKS5zb3J0KCkubWFwKGsgPT4gYDxvcHRpb24gdmFsdWU9IiR7ZXNjKGspfSIke2sgPT09IFBST1Aua2V5ID8g' +
  'JyBzZWxlY3RlZCcgOiAnJ30+JHsKICAgICAgICAgICAgZXNjKGsuc3BsaXQoJ3wnKVsxXS5yZXBsYWNlKC9cYihcdykoXHcqKS9n' +
  'LCAobSwgYSwgYikgPT4gYSArIGIudG9Mb3dlckNhc2UoKSkpfSBDb3VudHksIFRYPC9vcHRpb24+YCkuam9pbignJyl9CiAgICAg' +
  'ICAgPC9zZWxlY3Q+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5DaXR5IDxzcGFuIGNsYXNzPSJzdWIi' +
  'Pm9wdGlvbmFsPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICA8c2VsZWN0IGlkPSJwcm9wQ2l0eSI+JHtjaXR5T3B0c308L3NlbGVj' +
  'dD48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWwgaWQ9InByb3BMYWJlbCI+JHtQUk9Q' +
  'Lm1vZGUgPT09ICdhZGRyJyA/ICdBZGRyZXNzJyA6ICdPd25lciBuYW1lJ308L2xhYmVsPgogICAgICAgIDxpbnB1dCBpZD0icHJv' +
  'cFEiIHBsYWNlaG9sZGVyPSIke1BST1AubW9kZSA9PT0gJ2FkZHInID8gJzE4MDYgQXNoIEF2ZScgOiAnR2FyemEnfSI+PC9kaXY+' +
  'CiAgICAgIDxkaXYgY2xhc3M9InJvdyI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0icHJvcEdvIj5TZWFyY2g8L2J1' +
  'dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBpZD0icHJvcENsZWFyIj5DbGVhcjwvYnV0dG9uPgogICAgICA8' +
  'L2Rpdj4KICAgICAgPHAgY2xhc3M9ImhpbnQiIGlkPSJwcm9wSGludCI+PC9wPgogICAgPC9kaXY+CgogICAgPGRpdiBpZD0icHJv' +
  'cFN0YXR1cyI+PC9kaXY+CiAgICA8ZGl2IGlkPSJwcm9wT3V0Ij48L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAg' +
  'PHAgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MCI+QSBtYWlsaW5nIGFkZHJlc3MgZnJvbSB0aGUgYXBwcmFpc2FsIGRpc3Ry' +
  'aWN0IGlzIGEgbGVhZCwgbm90IHByb29mIG9mCiAgICAgICAgcmVzaWRlbmNlIOKAlCBwbGVudHkgb2Ygb3duZXJzIGhhdmUgcG9z' +
  'dCBnb2luZyB0byBhbiBhZ2VudCwgYSByZWxhdGl2ZSwgb3IgYW5vdGhlciBzdGF0ZS4gVHJlYXQgaXQgYXMgYQogICAgICAgIHBs' +
  'YWNlIHRvIGF0dGVtcHQsIGFuZCByZWNvcmQgd2hhdCB5b3UgYWN0dWFsbHkgZmluZCBpbiB0aGUgYXR0ZW1wdCBub3Rlcy48L3A+' +
  'CiAgICA8L2Rpdj5gKTsKICBiaW5kU2hlbGwoKTsKCiAgY29uc3QgaGludCA9ICgpID0+IHsKICAgIGNvbnN0IHMgPSBDQURbUFJP' +
  'UC5rZXldOwogICAgJCgnI3Byb3BIaW50JykuaW5uZXJIVE1MID0gKFBST1AubW9kZSA9PT0gJ2FkZHInCiAgICAgID8gJ1N0cmVl' +
  'dCBudW1iZXIgYW5kIG5hbWUgaXMgZW5vdWdoIOKAlCB0aGUgc3VmZml4IGlzIGRyb3BwZWQgYmVmb3JlIHNlYXJjaGluZywgYmVj' +
  'YXVzZSBldmVyeSBjb3VudHkgc3BlbGxzIGl0IGRpZmZlcmVudGx5LicKICAgICAgOiAnQSBzdXJuYW1lIGFsb25lIHdvcmtzIGFu' +
  'ZCBmaW5kcyBldmVyeSBwYXJjZWwgdGhhdCBvd25lciBob2xkcyBpbiB0aGUgY291bnR5LiBSZWNvcmRzIGFyZSBmaWxlZCBsYXN0' +
  'IG5hbWUgZmlyc3QsIHNvIDxpPkdhcnphPC9pPiBiZWF0cyA8aT5NYXJpYSBHYXJ6YTwvaT4uJykKICAgICAgKyAocy5ub3RlID8g' +
  'JyA8Yj4nICsgZXNjKHMubm90ZSkgKyAnPC9iPicgOiAnJyk7CiAgfTsKICBoaW50KCk7CgogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0' +
  'b3JBbGwoJyNwcm9wTW9kZSBbZGF0YS1tXScpLmZvckVhY2goYiA9PiBiLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBQUk9QLm1vZGUg' +
  'PSBiLmRhdGFzZXQubTsgcHJvcGVydHlWaWV3KCk7CiAgfSk7CiAgJCgnI3Byb3BDb3VudHknKS5vbmNoYW5nZSA9ICgpID0+IHsg' +
  'UFJPUC5rZXkgPSAkKCcjcHJvcENvdW50eScpLnZhbHVlOyBwcm9wZXJ0eVZpZXcoKTsgfTsKICAkKCcjcHJvcENsZWFyJykub25j' +
  'bGljayA9ICgpID0+IHsgUFJPUC5yZXN1bHRzID0gW107ICQoJyNwcm9wT3V0JykuaW5uZXJIVE1MID0gJyc7ICQoJyNwcm9wU3Rh' +
  'dHVzJykuaW5uZXJIVE1MID0gJyc7ICQoJyNwcm9wUScpLnZhbHVlID0gJyc7IH07CiAgJCgnI3Byb3BRJykub25rZXlkb3duID0g' +
  'ZSA9PiB7IGlmIChlLmtleSA9PT0gJ0VudGVyJykgeyBlLnByZXZlbnREZWZhdWx0KCk7ICQoJyNwcm9wR28nKS5jbGljaygpOyB9' +
  'IH07CiAgJCgnI3Byb3BHbycpLm9uY2xpY2sgPSAoKSA9PiBydW5Qcm9wZXJ0eVNlYXJjaCgkKCcjcHJvcFEnKS52YWx1ZS50cmlt' +
  'KCksICQoJyNwcm9wQ2l0eScpLnZhbHVlKTsKCiAgLy8gQ29taW5nIGhlcmUgZnJvbSBhIHBlcnNvbidzIHBhZ2U6IHRoZWlyIG5h' +
  'bWUgaXMgYWxyZWFkeSB0eXBlZCBpbiwgYW5kIHRoZQogIC8vIHNlYXJjaCBydW5zIHNvIHRoZSBhbnN3ZXIgaXMgb24gc2NyZWVu' +
  'IGJ5IHRoZSB0aW1lIHRoZXkgbG9vayB1cC4KICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1mdF0nKS5mb3JFYWNo' +
  'KGIgPT4gYi5vbmNsaWNrID0gKCkgPT4gewogICAgaWYgKGIuZGF0YXNldC5mdCA9PT0gJ3Byb3BlcnR5JykgcmV0dXJuOwogICAg' +
  'RklORC50YWIgPSBiLmRhdGFzZXQuZnQ7CiAgICBGSU5ELnJhbiA9IGZhbHNlOwogICAgRklORC5wZXJzb24gPSBudWxsOwogICAg' +
  'ZmluZFZpZXcoKTsKICB9KTsKICBpZiAoUFJPUC5wZW5kaW5nKSB7CiAgICBjb25zdCBuYW1lID0gUFJPUC5wZW5kaW5nOwogICAg' +
  'UFJPUC5wZW5kaW5nID0gbnVsbDsKICAgICQoJyNwcm9wUScpLnZhbHVlID0gbmFtZTsKICAgIHJ1blByb3BlcnR5U2VhcmNoKG5h' +
  'bWUsICcnKTsKICAgIHJldHVybjsKICB9CiAgaWYgKFBST1AucmVzdWx0cy5sZW5ndGgpIGRyYXdQcm9wZXJ0eSgpOwp9Cgphc3lu' +
  'YyBmdW5jdGlvbiBydW5Qcm9wZXJ0eVNlYXJjaChyYXcsIGNpdHkpIHsKICBpZiAoIXJhdykgcmV0dXJuIHRvYXN0KCdUeXBlIHNv' +
  'bWV0aGluZyB0byBsb29rIHVwJywgdHJ1ZSk7CiAgY29uc3Qgc3RhdCA9ICQoJyNwcm9wU3RhdHVzJyk7CiAgY29uc3Qgc3JjID0g' +
  'Q0FEW1BST1Aua2V5XTsKICBzdGF0LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJoaW50IiBzdHls' +
  'ZT0ibWFyZ2luOjAiPkFza2luZyAke2VzYyhzcmMubGFiZWwpfeKApjwvZGl2PjwvZGl2PmA7CiAgJCgnI3Byb3BPdXQnKS5pbm5l' +
  'ckhUTUwgPSAnJzsKICB0cnkgewogICAgbGV0IHJvd3M7CiAgICB0cnkgewogICAgICByb3dzID0gYXdhaXQgY2FkTG9va3VwKFBS' +
  'T1Aua2V5LCBQUk9QLm1vZGUsIHJhdywgY2l0eSk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIC8vIENhbWVyb24gcHVibGlzaGVz' +
  'IHRoZSBzYW1lIHJvbGwgdHdpY2U7IGlmIHRoZSBmaXJzdCBpcyBkb3duLCB0cnkgdGhlIG1pcnJvci4KICAgICAgaWYgKCFzcmMu' +
  'YWx0KSB0aHJvdyBlOwogICAgICByb3dzID0gYXdhaXQgY2FkTG9va3VwKFBST1Aua2V5LCBQUk9QLm1vZGUsIHJhdywgY2l0eSwg' +
  'c3JjLmFsdCk7CiAgICB9CiAgICBQUk9QLnJlc3VsdHMgPSByb3dzOwogICAgc3RhdC5pbm5lckhUTUwgPSByb3dzLmxlbmd0aAog' +
  'ICAgICA/IGA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjAiPiR7cm93cy5sZW5ndGh9' +
  'IHJlY29yZCR7cm93cy5sZW5ndGggPT09IDEgPyAnJyA6ICdzJ30gZnJvbSAke2VzYyhzcmMubGFiZWwpfTwvZGl2PjwvZGl2PmAK' +
  'ICAgICAgOiBgPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbjowIj5Ob3RoaW5nIG1hdGNo' +
  'ZWQgaW4gJHtlc2Moc3JjLmxhYmVsKX0uIFRyeSBmZXdlciB3b3Jkcywgb3IgZHJvcCB0aGUgY2l0eS48L2Rpdj48L2Rpdj5gOwog' +
  'ICAgZHJhd1Byb3BlcnR5KCk7CiAgfSBjYXRjaCAoZSkgewogICAgUFJPUC5yZXN1bHRzID0gW107CiAgICBzdGF0LmlubmVySFRN' +
  'TCA9IGA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjA7Y29sb3I6dmFyKC0tYmFkKSI+' +
  'VGhlIGNvdW50eSBkaWQgbm90IGFuc3dlcjogJHtlc2MoZS5tZXNzYWdlKX08L2Rpdj48L2Rpdj5gOwogICAgJCgnI3Byb3BPdXQn' +
  'KS5pbm5lckhUTUwgPSAnJzsKICB9Cn0KCmZ1bmN0aW9uIGRyYXdQcm9wZXJ0eSgpIHsKICBjb25zdCBvdXQgPSAkKCcjcHJvcE91' +
  'dCcpOwogIGlmICghb3V0KSByZXR1cm47CiAgb3V0LmlubmVySFRNTCA9IFBST1AucmVzdWx0cy5tYXAoKHIsIGkpID0+IHsKICAg' +
  'IGNvbnN0IEwgPSAoaywgdikgPT4gYDx0cj48dGggc3R5bGU9IndpZHRoOjM4JSI+JHtrfTwvdGg+PHRkPiR7dn08L3RkPjwvdHI+' +
  'YDsKICAgIGNvbnN0IGQgPSByLmRlZWQ7CiAgICBsZXQgZGVlZExpbmUgPSAnJzsKICAgIGlmIChkKSB7CiAgICAgIGNvbnN0IGJp' +
  'dHMgPSBbXTsKICAgICAgaWYgKGQuZGF0ZSkgYml0cy5wdXNoKGVzYyhkLmRhdGUpKTsKICAgICAgaWYgKGQudHlwZSkgYml0cy5w' +
  'dXNoKGVzYyhkLnR5cGUpKTsKICAgICAgaWYgKGQubnVtKSBiaXRzLnB1c2goJ2luc3QuICcgKyBlc2MoZC5udW0pKTsKICAgICAg' +
  'aWYgKGQudm9sICYmIGQucGFnZSkgYml0cy5wdXNoKCd2b2wgJyArIGVzYyhkLnZvbCkgKyAnIHBnICcgKyBlc2MoZC5wYWdlKSk7' +
  'CiAgICAgIGRlZWRMaW5lID0gYml0cy5qb2luKCcgwrcgJyk7CiAgICB9CiAgICBjb25zdCBmdWxsID0gW3IuYWRkcmVzcywgW3Iu' +
  'Y2l0eSwgci56aXBdLmZpbHRlcihCb29sZWFuKS5qb2luKCcgJyldLmZpbHRlcihCb29sZWFuKS5qb2luKCcsICcpOwogICAgcmV0' +
  'dXJuIGA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPiR7ZXNjKHIuYWRkcmVzcyl9PC9oMj4KICAgICAgPGRpdiBjbGFzcz0i' +
  'bSIgc3R5bGU9ImNvbG9yOnZhcigtLW11dGVkKTtmb250LXNpemU6MTNweCI+JHtlc2MoW3IuY2l0eSwgci56aXBdLmZpbHRlcihC' +
  'b29sZWFuKS5qb2luKCcgJykpfTwvZGl2PgogICAgICA8dGFibGUgY2xhc3M9InRibCIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+' +
  'CiAgICAgICAgJHtMKCdPd25lcicsICc8Yj4nICsgZXNjKHIub3duZXIgfHwgJ+KAlCcpICsgJzwvYj4nKX0KICAgICAgICAke3Iu' +
  'bWFpbCA/IEwoJ01haWxzIHRvJywgZXNjKHIubWFpbCkpIDogJyd9CiAgICAgICAgJHtMKCdMaXZlcyB0aGVyZT8nLCByLmhvbWVz' +
  'dGVhZAogICAgICAgICAgICA/ICc8c3BhbiBzdHlsZT0iY29sb3I6dmFyKC0tb2spO2ZvbnQtd2VpZ2h0OjYwMCI+SG9tZXN0ZWFk' +
  'IG9uIGZpbGUg4oCUIG93bmVyLW9jY3VwaWVkPC9zcGFuPicKICAgICAgICAgICAgOiAnTm8gaG9tZXN0ZWFkIGV4ZW1wdGlvbicg' +
  'KyAoci5vdXRvZnRvd24gPyAnIMK3IDxiPm1haWxzIG91dCBvZiB0b3duPC9iPicgOiAnJykpfQogICAgICAgICR7ci55ZWFyID8g' +
  'TCgnQnVpbHQnLCByLnllYXIpIDogJyd9CiAgICAgICAgJHtyLnNxZnQgPyBMKCdTaXplJywgTWF0aC5yb3VuZChyLnNxZnQpLnRv' +
  'TG9jYWxlU3RyaW5nKCkgKyAnIHNxIGZ0JykgOiAnJ30KICAgICAgICAke3IubGVnYWwgPyBMKCdMZWdhbCcsIGVzYyhyLmxlZ2Fs' +
  'KSkgOiAnJ30KICAgICAgICAke3IuZ2VvID8gTCgnR2VvZ3JhcGhpYyBJRCcsIGVzYyhyLmdlbykpIDogJyd9CiAgICAgICAgJHtk' +
  'ZWVkTGluZSA/IEwoJ0xhc3QgZGVlZCcsIGRlZWRMaW5lKSA6ICcnfQogICAgICA8L3RhYmxlPgogICAgICA8ZGl2IGNsYXNzPSJy' +
  'b3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGRhdGEtcGNvcHk9' +
  'IiR7ZXNjKGZ1bGwpfSI+Q29weSBhZGRyZXNzPC9idXR0b24+CiAgICAgICAgJHtyLm1haWwgPyBgPGJ1dHRvbiBjbGFzcz0iYnRu' +
  'IHNlYyBzbSIgZGF0YS1wY29weT0iJHtlc2Moci5tYWlsKX0iPkNvcHkgbWFpbGluZyBhZGRyZXNzPC9idXR0b24+YCA6ICcnfQog' +
  'ICAgICAgICR7ci5vd25lciA/IGA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBkYXRhLXBvd25lcj0iJHtlc2Mob3duZXJRdWVy' +
  'eShyLm93bmVyKSl9Ij5Nb3JlIGJ5IHRoaXMgb3duZXI8L2J1dHRvbj5gIDogJyd9CiAgICAgICAgJHtyLmxhdCAhPSBudWxsID8g' +
  'YDxhIGNsYXNzPSJidG4gc2VjIHNtIiB0YXJnZXQ9Il9ibGFuayIKICAgICAgICAgICBocmVmPSJodHRwczovL3d3dy5nb29nbGUu' +
  'Y29tL21hcHMvc2VhcmNoLz9hcGk9MSZxdWVyeT0ke3IubGF0fSwke3IubG9ufSI+TWFwPC9hPmAgOiAnJ30KICAgICAgICAke3Iu' +
  'bGluayA/IGA8YSBjbGFzcz0iYnRuIHNlYyBzbSIgdGFyZ2V0PSJfYmxhbmsiIGhyZWY9IiR7ZXNjKHIubGluayl9Ij5Db3VudHkg' +
  'cmVjb3JkIOKGlzwvYT5gIDogJyd9CiAgICAgICAgJHtyLm93bmVyID8gYDxhIGNsYXNzPSJidG4gc2VjIHNtIiB0YXJnZXQ9Il9i' +
  'bGFuayIKICAgICAgICAgICBocmVmPSIke2VzYyhjbGVya1NlYXJjaChQUk9QLmtleSwgKGQgJiYgZC5udW0pID8gZC5udW0gOiBv' +
  'd25lclF1ZXJ5KHIub3duZXIpKSl9Ij5EZWVkcyAmYW1wOyBsaWVucyDihpc8L2E+YCA6ICcnfQogICAgICA8L2Rpdj4KICAgIDwv' +
  'ZGl2PmA7CiAgfSkuam9pbignJyk7CgogIG91dC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1wY29weV0nKS5mb3JFYWNoKGIgPT4g' +
  'Yi5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsgYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoYi5k' +
  'YXRhc2V0LnBjb3B5KTsgdG9hc3QoJ0NvcGllZCcpOyB9CiAgICBjYXRjaCAoZSkgeyB0b2FzdCgnQ29weSBmYWlsZWQg4oCUIHNl' +
  'bGVjdCBpdCBieSBoYW5kJywgdHJ1ZSk7IH0KICB9KTsKICBvdXQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcG93bmVyXScpLmZv' +
  'ckVhY2goYiA9PiBiLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBQUk9QLm1vZGUgPSAnb3duZXInOwogICAgcHJvcGVydHlWaWV3KCk7' +
  'CiAgICAkKCcjcHJvcFEnKS52YWx1ZSA9IGIuZGF0YXNldC5wb3duZXI7CiAgICBydW5Qcm9wZXJ0eVNlYXJjaChiLmRhdGFzZXQu' +
  'cG93bmVyLCAnJyk7CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tIGNhc2UgbG9va3VwIC0tICovCi8qIE5vbmUgb2YgdGhlc2UgcG9ydGFscyBhY2NlcHQgYSBjYXNlIG51bWJlciBpbiB0' +
  'aGUgVVJMIC0tIEhpZGFsZ28ncyBydW5zIG9uCiAgIHNlc3Npb24tYmFzZWQgZm9ybSBwb3N0cywgQ2FtZXJvbidzIHNpdHMgYmVo' +
  'aW5kIGEgSmF2YVNjcmlwdCBnYXRlLiBTbyB0aGlzCiAgIGNvcGllcyB0aGUgbnVtYmVyIHRvIHRoZSBjbGlwYm9hcmQgYW5kIG9w' +
  'ZW5zIHRoZSByaWdodCBzZWFyY2ggcGFnZS4gTm8KICAgc2NyYXBpbmcsIG5vdGhpbmcgdG8gYnJlYWsgd2hlbiB0aGV5IHJlZGVz' +
  'aWduLiAqLwpjb25zdCBUWF9QT1JUQUxTID0gWwogIHsgbmFtZTogJ3JlOlNlYXJjaFRYIOKAlCBzdGF0ZXdpZGUnLCB1cmw6ICdo' +
  'dHRwczovL3Jlc2VhcmNoLnR4Y291cnRzLmdvdi8nLAogICAgbm90ZTogJ0ZyZWUgYWNjb3VudCByZXF1aXJlZC4gRGlzdHJpY3Qs' +
  'IGNvdW50eSBhbmQgcHJvYmF0ZSBjb3VydHMgaW4gYWxsIDI1NCBjb3VudGllcy4gJyArCiAgICAgICAgICAnUHVibGljIHZpZXcg' +
  'c3RhcnRzIGF0IGZpbGluZ3MgZnJvbSAxIE5vdiAyMDE4LiBKdXN0aWNlLW9mLXRoZS1wZWFjZSBldmljdGlvbnMgYXJlIHBhdGNo' +
  'eS4nIH0sCiAgeyBuYW1lOiAnSGlkYWxnbyBDb3VudHkg4oCUIERpc3RyaWN0IENsZXJrIGNhc2Ugc2VhcmNoJywgdXJsOiAnaHR0' +
  'cHM6Ly9wYS5jby5oaWRhbGdvLnR4LnVzL2RlZmF1bHQuYXNweCcsCiAgICBub3RlOiAnQ2l2aWwgYW5kIGNyaW1pbmFsIGNhc2Vz' +
  'LiBGcmVlLCBubyBsb2dpbi4nIH0sCiAgeyBuYW1lOiAnQ2FtZXJvbiBDb3VudHkg4oCUIGNvdXJ0IHBvcnRhbHMnLCB1cmw6ICdo' +
  'dHRwczovL3d3dy5jYW1lcm9uY291bnR5dHguZ292L2NhbWVyb24tY291bnR5LXBvcnRhbHMvJywKICAgIG5vdGU6ICdJbmRleCBw' +
  'YWdlIGZvciB0aGUgY291bnR5XCdzIGRpc3RyaWN0IGFuZCBjb3VudHkgY2xlcmsgc2VhcmNoZXMuJyB9LAogIHsgbmFtZTogJ0Nh' +
  'bWVyb24gQ291bnR5IOKAlCBEaXN0cmljdCBDbGVyayByZWNvcmRzJywgdXJsOiAnaHR0cHM6Ly9rb2ZpbGVxdWlja2xpbmtzLmNv' +
  'bS9jYW1lcm9uZGMvJywKICAgIG5vdGU6ICdEaXN0cmljdCBDbGVyayByZWNvcmQgc2VhcmNoLicgfSwKICB7IG5hbWU6ICdIaWRh' +
  'bGdvIENvdW50eSDigJQgcHJvcGVydHkgLyBvZmZpY2lhbCByZWNvcmRzJywgdXJsOiAnaHR0cHM6Ly9oaWRhbGdvLnR4LnB1Ymxp' +
  'Y3NlYXJjaC51cy8nLAogICAgbm90ZTogJ0RlZWRzLCBsaWVucyBhbmQgb3duZXJzaGlwIGZyb20gdGhlIENvdW50eSBDbGVyayDi' +
  'gJQgcHJvcGVydHksIG5vdCBsYXdzdWl0cy4gJyArCiAgICAgICAgICAnVXNlZnVsIGZvciBjb25maXJtaW5nIHdobyBhY3R1YWxs' +
  'eSBvd25zIGFuIGFkZHJlc3MuJyB9Cl07CgpmdW5jdGlvbiBjYXNlTG9va3VwU2hlZXQoam9iKSB7CiAgc2hlZXQoJ0xvb2sgdXAg' +
  'JyArIGpvYi5jYXNlX251bWJlciwgYAogICAgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6I2Y4ZmFmYztib3gt' +
  'c2hhZG93Om5vbmU7dGV4dC1hbGlnbjpjZW50ZXIiPgogICAgICA8ZGl2IHN0eWxlPSJmb250OjYwMCAyMHB4LzEuMyBtb25vc3Bh' +
  'Y2U7bGV0dGVyLXNwYWNpbmc6LjVweCI+JHtlc2Moam9iLmNhc2VfbnVtYmVyKX08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGlu' +
  'dCI+JHtlc2Moam9iLmNvdXJ0IHx8ICdjb3VydCBub3QgcmVjb3JkZWQnKX08L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRu' +
  'IHNtIiBpZD0iY29weUNhc2UiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPkNvcHkgY2FzZSBudW1iZXI8L2J1dHRvbj4KICAgIDwv' +
  'ZGl2PgogICAgPHAgY2xhc3M9ImhpbnQiPlRoZXNlIHBvcnRhbHMgY2FuJ3QgYmUgbGlua2VkIHRvIGRpcmVjdGx5IHdpdGggYSBj' +
  'YXNlIG51bWJlciwgc28gdGFwcGluZyBvbmUgY29waWVzCiAgICAgIHRoZSBudW1iZXIgYW5kIG9wZW5zIHRoZWlyIHNlYXJjaCBw' +
  'YWdlIOKAlCBwYXN0ZSBpdCBpbnRvIHRoZWlyIGJveC48L3A+CiAgICA8ZGl2IGNsYXNzPSJsaXN0Ij4KICAgICAgJHtUWF9QT1JU' +
  'QUxTLm1hcCgocCwgaSkgPT4gYAogICAgICAgIDxkaXYgY2xhc3M9Iml0ZW0iIGRhdGEtcG9ydGFsPSIke2l9Ij4KICAgICAgICAg' +
  'IDxkaXYgY2xhc3M9InQiPiR7ZXNjKHAubmFtZSl9PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJtIj4ke2VzYyhwLm5vdGUp' +
  'fTwvZGl2PgogICAgICAgIDwvZGl2PmApLmpvaW4oJycpfQogICAgPC9kaXY+CiAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1h' +
  'cmdpbi10b3A6MTJweCI+Q291cnQgcmVjb3JkcyByYXJlbHkgcHVibGlzaCBhIGRlZmVuZGFudCdzIHNlcnZpY2UgYWRkcmVzcyDi' +
  'gJQKICAgICAgdGhhdCBub3JtYWxseSBvbmx5IGV4aXN0cyBvbiB0aGUgY2xpZW50J3MgcGFja2V0LjwvcD4KICAgIDxidXR0b24g' +
  'Y2xhc3M9ImJ0biBzZWMgYmxvY2siIHN0eWxlPSJtYXJnaW4tdG9wOjhweCIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5DbG9zZTwv' +
  'YnV0dG9uPmAsIGVsID0+IHsKICAgIGNvbnN0IGNvcHkgPSBhc3luYyAoKSA9PiB7CiAgICAgIHRyeSB7IGF3YWl0IG5hdmlnYXRv' +
  'ci5jbGlwYm9hcmQud3JpdGVUZXh0KGpvYi5jYXNlX251bWJlcik7IHJldHVybiB0cnVlOyB9CiAgICAgIGNhdGNoIChlKSB7IHJl' +
  'dHVybiBmYWxzZTsgfQogICAgfTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNjb3B5Q2FzZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9' +
  'PgogICAgICB0b2FzdChhd2FpdCBjb3B5KCkgPyAnQ29waWVkICcgKyBqb2IuY2FzZV9udW1iZXIgOiAnQ29weSBmYWlsZWQg4oCU' +
  'IHNlbGVjdCBpdCBieSBoYW5kJywgZmFsc2UpOwogICAgZWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcG9ydGFsXScpLmZvckVh' +
  'Y2gocm93ID0+IHJvdy5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBwID0gVFhfUE9SVEFMU1srcm93LmRhdGFz' +
  'ZXQucG9ydGFsXTsKICAgICAgY29uc3Qgb2sgPSBhd2FpdCBjb3B5KCk7CiAgICAgIHRvYXN0KG9rID8gJ0Nhc2UgbnVtYmVyIGNv' +
  'cGllZCDigJQgcGFzdGUgaXQgaW50byB0aGVpciBzZWFyY2gnIDogJ09wZW5pbmcgJyArIHAubmFtZSk7CiAgICAgIHdpbmRvdy5v' +
  'cGVuKHAudXJsLCAnX2JsYW5rJyk7CiAgICB9KTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIHNjYW4gLS0gKi8KZnVuY3Rpb24gc2NhblZpZXcoKSB7CiAgYXBwLmlubmVy' +
  'SFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFnZSI+U2NhbiBhIHBhY2tldDwvaDE+CiAgICA8ZGl2IGNsYXNzPSJjYXJk' +
  'Ij4KICAgICAgPHAgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjAiPlBvaW50IHRoZSBjYW1lcmEgYXQgdGhlIGJhcmNv' +
  'ZGUgb24gdGhlIGNvdmVyIHNoZWV0IHRvIG9wZW4gdGhhdCBqb2IuIElmIHRoZSBjYW1lcmEKICAgICAgd29uJ3QgY29vcGVyYXRl' +
  'LCB0eXBlIHRoZSBqb2IgbnVtYmVyIGluc3RlYWQg4oCUIGl0IHdvcmtzIHRoZSBzYW1lLjwvcD4KICAgICAgPGRpdiBpZD0icmVh' +
  'ZGVyIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij4KICAgICAgICA8YnV0dG9u' +
  'IGNsYXNzPSJidG4iIGlkPSJzdGFydFNjYW4iPlN0YXJ0IGNhbWVyYTwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0' +
  'biBzZWMiIGlkPSJzdG9wU2NhbkJ0biIgc3R5bGU9ImRpc3BsYXk6bm9uZSI+U3RvcDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAg' +
  'ICAgPGRpdiBjbGFzcz0iaGludCIgaWQ9InNjYW5Nc2ciPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4K' +
  'ICAgICAgPGgyPkVudGVyIGpvYiBudW1iZXI8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAgIDxpbnB1dCBpZD0i' +
  'bWFudWFsIiBwbGFjZWhvbGRlcj0iU1QtMTAwMDEiIHN0eWxlPSJmbGV4OjE7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlIj4KICAg' +
  'ICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJtYW51YWxHbyI+T3BlbjwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvZGl2' +
  'PmApOwogIGJpbmRTaGVsbCgpOwoKICBjb25zdCBvcGVuID0gYXN5bmMgY29kZSA9PiB7CiAgICB0cnkgewogICAgICBjb25zdCBq' +
  'ID0gYXdhaXQgYXBpKCcvbG9va3VwLycgKyBlbmNvZGVVUklDb21wb25lbnQoY29kZSkpOwogICAgICBpZiAod2luZG93Ll9fc3Rv' +
  'cFNjYW4pIHsgd2luZG93Ll9fc3RvcFNjYW4oKTsgd2luZG93Ll9fc3RvcFNjYW4gPSBudWxsOyB9CiAgICAgIHRvYXN0KCdPcGVu' +
  'aW5nICcgKyBqLmpvYl9udW1iZXIpOwogICAgICBnbygnam9iJywgeyBpZDogai5pZCB9KTsKICAgIH0gY2F0Y2ggKGUpIHsgJCgn' +
  'I3NjYW5Nc2cnKS50ZXh0Q29udGVudCA9IGUubWVzc2FnZTsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07CgogICQoJyNt' +
  'YW51YWxHbycpLm9uY2xpY2sgPSAoKSA9PiB7IGNvbnN0IHYgPSAkKCcjbWFudWFsJykudmFsdWUudHJpbSgpOyBpZiAodikgb3Bl' +
  'bih2KTsgfTsKICAkKCcjbWFudWFsJykub25rZXlkb3duID0gZSA9PiB7IGlmIChlLmtleSA9PT0gJ0VudGVyJykgJCgnI21hbnVh' +
  'bEdvJykuY2xpY2soKTsgfTsKCiAgJCgnI3N0YXJ0U2NhbicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBjb25zdCBtc2cg' +
  'PSAkKCcjc2Nhbk1zZycpOwogICAgaWYgKCF3aW5kb3cuWlhpbmcpIHJldHVybiBtc2cudGV4dENvbnRlbnQgPSAnU2Nhbm5lciBs' +
  'aWJyYXJ5IGRpZCBub3QgbG9hZCDigJQgdXNlIHRoZSBqb2IgbnVtYmVyIGJveCBiZWxvdy4nOwogICAgdHJ5IHsKICAgICAgY29u' +
  'c3QgcmVhZGVyID0gbmV3IFpYaW5nLkJyb3dzZXJNdWx0aUZvcm1hdFJlYWRlcigpOwogICAgICBjb25zdCB2aWRlbyA9IGRvY3Vt' +
  'ZW50LmNyZWF0ZUVsZW1lbnQoJ3ZpZGVvJyk7CiAgICAgIHZpZGVvLnNldEF0dHJpYnV0ZSgncGxheXNpbmxpbmUnLCAndHJ1ZScp' +
  'OwogICAgICAkKCcjcmVhZGVyJykuaW5uZXJIVE1MID0gJyc7CiAgICAgICQoJyNyZWFkZXInKS5hcHBlbmRDaGlsZCh2aWRlbyk7' +
  'CiAgICAgICQoJyNzdGFydFNjYW4nKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogICAgICAkKCcjc3RvcFNjYW5CdG4nKS5zdHls' +
  'ZS5kaXNwbGF5ID0gJyc7CiAgICAgIG1zZy50ZXh0Q29udGVudCA9ICdMb29raW5nIGZvciBhIGJhcmNvZGXigKYnOwogICAgICBs' +
  'ZXQgaGFuZGxlZCA9IGZhbHNlOwogICAgICBhd2FpdCByZWFkZXIuZGVjb2RlRnJvbUNvbnN0cmFpbnRzKAogICAgICAgIHsgdmlk' +
  'ZW86IHsgZmFjaW5nTW9kZTogJ2Vudmlyb25tZW50JyB9IH0sIHZpZGVvLAogICAgICAgIChyZXN1bHQpID0+IHsgaWYgKHJlc3Vs' +
  'dCAmJiAhaGFuZGxlZCkgeyBoYW5kbGVkID0gdHJ1ZTsgb3BlbihyZXN1bHQuZ2V0VGV4dCgpKTsgfSB9KTsKICAgICAgd2luZG93' +
  'Ll9fc3RvcFNjYW4gPSAoKSA9PiB7CiAgICAgICAgdHJ5IHsgcmVhZGVyLnJlc2V0KCk7IH0gY2F0Y2ggKGUpIHt9CiAgICAgICAg' +
  'JCgnI3JlYWRlcicpLmlubmVySFRNTCA9ICcnOwogICAgICAgIGNvbnN0IHMgPSAkKCcjc3RhcnRTY2FuJyksIHN0ID0gJCgnI3N0' +
  'b3BTY2FuQnRuJyk7CiAgICAgICAgaWYgKHMpIHMuc3R5bGUuZGlzcGxheSA9ICcnOwogICAgICAgIGlmIChzdCkgc3Quc3R5bGUu' +
  'ZGlzcGxheSA9ICdub25lJzsKICAgICAgfTsKICAgICAgJCgnI3N0b3BTY2FuQnRuJykub25jbGljayA9ICgpID0+IHsgd2luZG93' +
  'Ll9fc3RvcFNjYW4oKTsgd2luZG93Ll9fc3RvcFNjYW4gPSBudWxsOyBtc2cudGV4dENvbnRlbnQgPSAnJzsgfTsKICAgIH0gY2F0' +
  'Y2ggKGUpIHsKICAgICAgbXNnLnRleHRDb250ZW50ID0gJ0NhbWVyYSB1bmF2YWlsYWJsZSAoJyArIGUubWVzc2FnZSArICcpLiBV' +
  'c2UgdGhlIGpvYiBudW1iZXIgYm94IGJlbG93Lic7CiAgICAgICQoJyNzdGFydFNjYW4nKS5zdHlsZS5kaXNwbGF5ID0gJyc7CiAg' +
  'ICAgICQoJyNzdG9wU2NhbkJ0bicpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgICB9CiAgfTsKfQoKLyogLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gbW9uZXkgLS0gKi8KYXN5bmMgZnVuY3Rp' +
  'b24gbW9uZXlWaWV3KCkgewogIGlmICghaXNBZG1pbigpKSByZXR1cm4gbXlQYXlWaWV3KCk7CiAgY29uc3QgW3N0YXRlbWVudHMs' +
  'IGludm9pY2VzLCB1c2VycywgY2xpZW50cywgYXJdID0gYXdhaXQgUHJvbWlzZS5hbGwoCiAgICBbYXBpKCcvc3RhdGVtZW50cycp' +
  'LCBhcGkoJy9pbnZvaWNlcycpLCBhcGkoJy91c2VycycpLCBhcGkoJy9jbGllbnRzJyksIGFwaSgnL3JlY2VpdmFibGVzJyldKTsK' +
  'CiAgLyogTW9uZXkgb3dlZCwgb2xkZXN0IGZpcnN0LiAiVW5iaWxsZWQiIGlzIGRlbGliZXJhdGVseSBub3QgcGFydCBvZiB0aGUK' +
  'ICAgICB0b3RhbCDigJQgdGhhdCBpcyB3b3JrIHlvdSBoYXZlIG5vdCBhc2tlZCB0byBiZSBwYWlkIGZvciB5ZXQsIHdoaWNoIGlz' +
  'IGEKICAgICBkaWZmZXJlbnQgcHJvYmxlbSBmcm9tIGEgZmlybSB0aGF0IGlzIHNsb3cgdG8gcGF5LiAqLwogIGNvbnN0IG93ZWQg' +
  'PSBhci5jbGllbnRzLmZpbHRlcihjID0+IE51bWJlcihjLmJhbGFuY2UpID4gMCk7CiAgY29uc3QgYnVja2V0ID0gKHYsIHdhcm4p' +
  'ID0+IGA8ZGl2IGNsYXNzPSJzdGF0JHt2ID4gMCAmJiB3YXJuID8gJyBiYWQnIDogJyd9IiBzdHlsZT0iZmxleDoxIj4KICAgICAg' +
  'PGRpdiBjbGFzcz0ibiIgc3R5bGU9ImZvbnQtc2l6ZToxNnB4Ij4ke21vbmV5KHYpfTwvZGl2PjxkaXYgY2xhc3M9ImwiPiR7d2Fy' +
  'biB8fCAnQ3VycmVudCd9PC9kaXY+PC9kaXY+YDsKCiAgYXBwLmlubmVySFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFn' +
  'ZSI+QmlsbGluZyAmYW1wOyBwYXk8L2gxPgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+T3V0c3RhbmRpbmcgPHNw' +
  'YW4gY2xhc3M9InN1YiI+d2hhdCB5b3VyIGF0dG9ybmV5cyBvd2UgeW91PC9zcGFuPjwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InN0' +
  'YXQgYmlnIiBzdHlsZT0ibWFyZ2luLXRvcDo2cHgiPgogICAgICAgIDxkaXYgY2xhc3M9Im4iPiR7bW9uZXkoYXIudG90YWwpfTwv' +
  'ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImwiPiR7b3dlZC5sZW5ndGggPyBvd2VkLmxlbmd0aCArICcgZmlybScgKyAob3dlZC5s' +
  'ZW5ndGggPT09IDEgPyAnJyA6ICdzJykgKyAnIHdpdGggYSBiYWxhbmNlJwogICAgICAgICAgOiAnRXZlcnlvbmUgaXMgcGFpZCB1' +
  'cCd9PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICAke2FyLnRvdGFsID4gMCA/IGA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJnYXA6' +
  'NnB4O21hcmdpbi10b3A6MTBweCI+CiAgICAgICAgJHtidWNrZXQoYXIuYnVja2V0cy5kMCl9JHtidWNrZXQoYXIuYnVja2V0cy5k' +
  'MzAsICczMCsgZGF5cycpfQogICAgICAgICR7YnVja2V0KGFyLmJ1Y2tldHMuZDYwLCAnNjArIGRheXMnKX0ke2J1Y2tldChhci5i' +
  'dWNrZXRzLmQ5MCwgJzkwKyBkYXlzJyl9CiAgICAgIDwvZGl2PmAgOiAnJ30KICAgICAgJHtvd2VkLmxlbmd0aCA/IGA8dGFibGUg' +
  'Y2xhc3M9InRibCIgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+CiAgICAgICAgPHRyPjx0aD5BdHRvcm5leTwvdGg+PHRoIGNsYXNz' +
  'PSJudW0iPk93ZWQ8L3RoPjx0aCBjbGFzcz0ibnVtIj5PbGRlc3Q8L3RoPjx0aD48L3RoPjwvdHI+CiAgICAgICAgJHtvd2VkLm1h' +
  'cChjID0+IHsKICAgICAgICAgIGNvbnN0IGFnZSA9IE1hdGguZmxvb3IoKERhdGUubm93KCkgLSBuZXcgRGF0ZShjLm9sZGVzdF9p' +
  'bnZvaWNlKS5nZXRUaW1lKCkpIC8gODY0ZTUpOwogICAgICAgICAgcmV0dXJuIGA8dHI+CiAgICAgICAgICAgIDx0ZD4ke2VzYyhj' +
  'LmNsaWVudF9uYW1lKX08ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjAiPiR7Yy5pbnZvaWNlX2NvdW50fSBpbnZvaWNl' +
  'JHsKICAgICAgICAgICAgICBjLmludm9pY2VfY291bnQgPT09IDEgPyAnJyA6ICdzJ308L2Rpdj48L3RkPgogICAgICAgICAgICA8' +
  'dGQgY2xhc3M9Im51bSI+JHttb25leShjLmJhbGFuY2UpfTwvdGQ+CiAgICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIiR7YWdlID49' +
  'IDYwID8gJyBzdHlsZT0iY29sb3I6dmFyKC0tYmFkKTtmb250LXdlaWdodDo3MDAiJyA6ICcnfT4ke2FnZX1kPC90ZD4KICAgICAg' +
  'ICAgICAgPHRkIGNsYXNzPSJudW0iPjxhIGhyZWY9Ii9wcmludC9hY2NvdW50LyR7Yy5jbGllbnRfaWR9IiB0YXJnZXQ9Il9ibGFu' +
  'ayI+c3RhdGVtZW50PC9hPjwvdGQ+CiAgICAgICAgICA8L3RyPmA7CiAgICAgICAgfSkuam9pbignJyl9PC90YWJsZT5gIDogJyd9' +
  'CiAgICAgICR7YXIudW5iaWxsZWQgPiAwID8gYDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPlNlcGFy' +
  'YXRlbHksIDxiPiR7bW9uZXkoYXIudW5iaWxsZWQpfTwvYj4KICAgICAgICBvZiBzZXJ2ZWQgd29yayBoYXMgbm90IGJlZW4gcHV0' +
  'IG9uIGFuIGludm9pY2UgeWV0IOKAlCB0aGF0IGlzIG1vbmV5IHlvdSBoYXZlIG5vdCBhc2tlZCBmb3IuPC9kaXY+YCA6ICcnfQog' +
  'ICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5Db250cmFjdG9yIHN0YXRlbWVudHMgPHNwYW4gY2xh' +
  'c3M9InN1YiI+d2hhdCB5b3Ugb3dlIHlvdXIgc2VydmVyczwvc3Bhbj48L2gyPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9' +
  'Im1hcmdpbi10b3A6LTRweCI+UHVsbHMgZXZlcnkgY29tcGxldGVkIHNlcnZlIGluIHRoZSBwZXJpb2QgdGhhdCBoYXNuJ3QgYmVl' +
  'biBwYWlkIG91dCB5ZXQsIGF0IHRoZQogICAgICBwZXItam9iIHJhdGUgb24gdGhlIGpvYi4gTm90aGluZyBnZXRzIGNvdW50ZWQg' +
  'dHdpY2UuPC9wPgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4KICAgICAgICA8ZGl2' +
  'IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlNlcnZlcjwvbGFiZWw+PHNlbGVjdCBpZD0ic19zZXJ2ZXIiPgogICAgICAgICAgJHt1c2Vy' +
  'cy5maWx0ZXIodSA9PiB1LmFjdGl2ZSkubWFwKHUgPT4gYDxvcHRpb24gdmFsdWU9IiR7dS5pZH0iPiR7ZXNjKHUubmFtZSl9PC9v' +
  'cHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0iYWxpZ24taXRl' +
  'bXM6ZmxleC1lbmQ7Z2FwOjZweCI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCIgc3R5bGU9ImZsZXg6MTttYXJnaW46MCI+' +
  'PGxhYmVsPkZyb208L2xhYmVsPjxpbnB1dCB0eXBlPSJkYXRlIiBpZD0ic19zdGFydCIgdmFsdWU9IiR7Zmlyc3RPZk1vbnRoKCl9' +
  'Ij48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0iZmxleDoxO21hcmdpbjowIj48bGFiZWw+VG88L2xh' +
  'YmVsPjxpbnB1dCB0eXBlPSJkYXRlIiBpZD0ic19lbmQiIHZhbHVlPSIke3RvZGF5SVNPKCl9Ij48L2Rpdj4KICAgICAgICA8L2Rp' +
  'dj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAgICAgICA8YnV0' +
  'dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0ic19wcmV2Ij5QcmV2aWV3PC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0i' +
  'YnRuIHNtIiBpZD0ic19tYWtlIj5DcmVhdGUgc3RhdGVtZW50PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGlkPSJz' +
  'X291dCI+PC9kaXY+CiAgICAgICR7c3RhdGVtZW50cy5sZW5ndGggPyBgPHRhYmxlIGNsYXNzPSJ0YmwiIHN0eWxlPSJtYXJnaW4t' +
  'dG9wOjE0cHgiPgogICAgICAgIDx0cj48dGg+U2VydmVyPC90aD48dGg+UGVyaW9kPC90aD48dGggY2xhc3M9Im51bSI+Sm9iczwv' +
  'dGg+PHRoIGNsYXNzPSJudW0iPlRvdGFsPC90aD48dGg+PC90aD48dGg+PC90aD48L3RyPgogICAgICAgICR7c3RhdGVtZW50cy5t' +
  'YXAocyA9PiBgPHRyPgogICAgICAgICAgPHRkPiR7ZXNjKHMuc2VydmVyX25hbWUpfTwvdGQ+PHRkPiR7Zm10RGF0ZU9ubHkocy5w' +
  'ZXJpb2Rfc3RhcnQpfeKAkyR7Zm10RGF0ZU9ubHkocy5wZXJpb2RfZW5kKX08L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0i' +
  'PiR7cy5qb2JfY291bnR9PC90ZD48dGQgY2xhc3M9Im51bSI+JHttb25leShzLnRvdGFsKX08L3RkPgogICAgICAgICAgPHRkPjxz' +
  'cGFuIGNsYXNzPSJwaWxsICR7Y2xzKHMuc3RhdHVzKX0iPiR7ZXNjKHMuc3RhdHVzKX08L3NwYW4+PC90ZD4KICAgICAgICAgIDx0' +
  'ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIvcHJpbnQvc3RhdGVtZW50LyR7cy5pZH0iIHRhcmdldD0iX2JsYW5rIj5wcmludDwvYT4K' +
  'ICAgICAgICAgICAgJHtzLnN0YXR1cyAhPT0gJ1BhaWQnID8gYCDCtyA8YSBocmVmPSIjIiBkYXRhLXBhaWQ9IiR7cy5pZH0iPm1h' +
  'cmsgcGFpZDwvYT5gIDogJyd9PC90ZD4KICAgICAgICA8L3RyPmApLmpvaW4oJycpfTwvdGFibGU+YCA6ICcnfQogICAgPC9kaXY+' +
  'CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5DbGllbnQgaW52b2ljZXM8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJn' +
  'cmlkIGcyIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNsaWVudDwvbGFiZWw+PHNlbGVjdCBpZD0iaV9jbGll' +
  'bnQiPgogICAgICAgICAgJHtjbGllbnRzLmZpbHRlcihjID0+IGMuYWN0aXZlKS5tYXAoYyA9PiBgPG9wdGlvbiB2YWx1ZT0iJHtj' +
  'LmlkfSI+JHtlc2MoYy5uYW1lKX08L29wdGlvbj5gKS5qb2luKCcnKX08L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNz' +
  'PSJyb3ciIHN0eWxlPSJhbGlnbi1pdGVtczpmbGV4LWVuZDtnYXA6NnB4Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBz' +
  'dHlsZT0iZmxleDoxO21hcmdpbjowIj48bGFiZWw+RnJvbTwvbGFiZWw+PGlucHV0IHR5cGU9ImRhdGUiIGlkPSJpX3N0YXJ0IiB2' +
  'YWx1ZT0iJHtmaXJzdE9mTW9udGgoKX0iPjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJmbGV4OjE7' +
  'bWFyZ2luOjAiPjxsYWJlbD5UbzwvbGFiZWw+PGlucHV0IHR5cGU9ImRhdGUiIGlkPSJpX2VuZCIgdmFsdWU9IiR7dG9kYXlJU08o' +
  'KX0iPjwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2lu' +
  'LXRvcDo4cHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJpX3ByZXYiPlByZXZpZXc8L2J1dHRvbj4K' +
  'ICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc20iIGlkPSJpX21ha2UiPkNyZWF0ZSBpbnZvaWNlPC9idXR0b24+CiAgICAgIDwv' +
  'ZGl2PgogICAgICA8ZGl2IGlkPSJpX291dCI+PC9kaXY+CiAgICAgICR7aW52b2ljZXMubGVuZ3RoID8gYDx0YWJsZSBjbGFzcz0i' +
  'dGJsIiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij4KICAgICAgICA8dHI+PHRoPkNsaWVudDwvdGg+PHRoPlBlcmlvZDwvdGg+PHRo' +
  'IGNsYXNzPSJudW0iPkpvYnM8L3RoPjx0aCBjbGFzcz0ibnVtIj5Ub3RhbDwvdGg+PHRoPjwvdGg+PHRoPjwvdGg+PC90cj4KICAg' +
  'ICAgICAke2ludm9pY2VzLm1hcChzID0+IGA8dHI+CiAgICAgICAgICA8dGQ+JHtlc2Mocy5jbGllbnRfbmFtZSl9PC90ZD48dGQ+' +
  'JHtmbXREYXRlT25seShzLnBlcmlvZF9zdGFydCl94oCTJHtmbXREYXRlT25seShzLnBlcmlvZF9lbmQpfTwvdGQ+CiAgICAgICAg' +
  'ICA8dGQgY2xhc3M9Im51bSI+JHtzLmpvYl9jb3VudH08L3RkPjx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KHMudG90YWwpfTwvdGQ+' +
  'CiAgICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InBpbGwgJHtjbHMocy5zdGF0dXMpfSI+JHtlc2Mocy5zdGF0dXMpfTwvc3Bhbj48' +
  'L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPjxhIGhyZWY9Ii9wcmludC9pbnZvaWNlLyR7cy5pZH0iIHRhcmdldD0iX2Js' +
  'YW5rIj5wcmludDwvYT4KICAgICAgICAgICAgJHtzLnN0YXR1cyAhPT0gJ1BhaWQnID8gYCDCtyA8YSBocmVmPSIjIiBkYXRhLWlw' +
  'YWlkPSIke3MuaWR9Ij5tYXJrIHBhaWQ8L2E+YCA6ICcnfTwvdGQ+CiAgICAgICAgPC90cj5gKS5qb2luKCcnKX08L3RhYmxlPmAg' +
  'OiAnJ30KICAgIDwvZGl2PmApOwogIGJpbmRTaGVsbCgpOwoKICBjb25zdCBsaW5lc1RhYmxlID0gKHIsIGtleSkgPT4gci5saW5l' +
  'cy5sZW5ndGgKICAgID8gYDx0YWJsZSBjbGFzcz0idGJsIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij48dHI+PHRoPkRhdGU8L3Ro' +
  'Pjx0aD5Kb2I8L3RoPjx0aD5SZWNpcGllbnQ8L3RoPjx0aCBjbGFzcz0ibnVtIj4ke2tleSA9PT0gJ3BheScgPyAnUGF5JyA6ICdG' +
  'ZWUnfTwvdGg+PC90cj4KICAgICAgICR7ci5saW5lcy5tYXAobCA9PiBgPHRyPjx0ZD4ke2ZtdERhdGVPbmx5KGwuc2VydmVkX2F0' +
  'KX08L3RkPjx0ZD4ke2VzYyhsLmpvYl9udW1iZXIpfTwvdGQ+CiAgICAgICA8dGQ+JHtlc2MobC5yZWNpcGllbnRfbmFtZSl9PC90' +
  'ZD48dGQgY2xhc3M9Im51bSI+JHttb25leShrZXkgPT09ICdwYXknID8gbC5zZXJ2ZXJfcGF5IDogbC5jbGllbnRfZmVlKX08L3Rk' +
  'PjwvdHI+YCkuam9pbignJyl9CiAgICAgICA8dHI+PHRkIGNvbHNwYW49IjMiPjxiPiR7ci5jb3VudH0gam9iKHMpPC9iPjwvdGQ+' +
  'PHRkIGNsYXNzPSJudW0iPjxiPiR7bW9uZXkoci50b3RhbCl9PC9iPjwvdGQ+PC90cj48L3RhYmxlPmAKICAgIDogJzxkaXYgY2xh' +
  'c3M9ImhpbnQiPk5vdGhpbmcgdW5iaWxsZWQgaW4gdGhhdCB3aW5kb3cuPC9kaXY+JzsKCiAgJCgnI3NfcHJldicpLm9uY2xpY2sg' +
  'PSBhc3luYyAoKSA9PiB7CiAgICBjb25zdCByID0gYXdhaXQgYXBpKCcvc3RhdGVtZW50cy9wcmV2aWV3JywgeyBtZXRob2Q6ICdQ' +
  'T1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoCiAgICAgIHsgc2VydmVyX2lkOiAkKCcjc19zZXJ2ZXInKS52YWx1ZSwgc3RhcnQ6' +
  'ICQoJyNzX3N0YXJ0JykudmFsdWUsIGVuZDogJCgnI3NfZW5kJykudmFsdWUgfSkgfSk7CiAgICAkKCcjc19vdXQnKS5pbm5lckhU' +
  'TUwgPSBsaW5lc1RhYmxlKHIsICdwYXknKTsKICB9OwogICQoJyNzX21ha2UnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAg' +
  'dHJ5IHsKICAgICAgYXdhaXQgYXBpKCcvc3RhdGVtZW50cycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5' +
  'KAogICAgICAgIHsgc2VydmVyX2lkOiAkKCcjc19zZXJ2ZXInKS52YWx1ZSwgc3RhcnQ6ICQoJyNzX3N0YXJ0JykudmFsdWUsIGVu' +
  'ZDogJCgnI3NfZW5kJykudmFsdWUgfSkgfSk7CiAgICAgIHRvYXN0KCdTdGF0ZW1lbnQgY3JlYXRlZCcpOyBnbygnbW9uZXknKTsK' +
  'ICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07CiAgJCgnI2lfcHJldicpLm9uY2xpY2sgPSBh' +
  'c3luYyAoKSA9PiB7CiAgICBjb25zdCByID0gYXdhaXQgYXBpKCcvaW52b2ljZXMvcHJldmlldycsIHsgbWV0aG9kOiAnUE9TVCcs' +
  'IGJvZHk6IEpTT04uc3RyaW5naWZ5KAogICAgICB7IGNsaWVudF9pZDogJCgnI2lfY2xpZW50JykudmFsdWUsIHN0YXJ0OiAkKCcj' +
  'aV9zdGFydCcpLnZhbHVlLCBlbmQ6ICQoJyNpX2VuZCcpLnZhbHVlIH0pIH0pOwogICAgJCgnI2lfb3V0JykuaW5uZXJIVE1MID0g' +
  'bGluZXNUYWJsZShyLCAnZmVlJyk7CiAgfTsKICAkKCcjaV9tYWtlJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7' +
  'CiAgICAgIGF3YWl0IGFwaSgnL2ludm9pY2VzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoCiAgICAg' +
  'ICAgeyBjbGllbnRfaWQ6ICQoJyNpX2NsaWVudCcpLnZhbHVlLCBzdGFydDogJCgnI2lfc3RhcnQnKS52YWx1ZSwgZW5kOiAkKCcj' +
  'aV9lbmQnKS52YWx1ZSB9KSB9KTsKICAgICAgdG9hc3QoJ0ludm9pY2UgY3JlYXRlZCcpOyBnbygnbW9uZXknKTsKICAgIH0gY2F0' +
  'Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEt' +
  'cGFpZF0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNrID0gYXN5bmMgZSA9PiB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICBh' +
  'd2FpdCBhcGkoJy9zdGF0ZW1lbnRzLycgKyBhLmRhdGFzZXQucGFpZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3Ry' +
  'aW5naWZ5KHsgc3RhdHVzOiAnUGFpZCcgfSkgfSk7CiAgICB0b2FzdCgnTWFya2VkIHBhaWQnKTsgZ28oJ21vbmV5Jyk7CiAgfSk7' +
  'CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtaXBhaWRdJykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGFzeW5j' +
  'IGUgPT4gewogICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgYXdhaXQgYXBpKCcvaW52b2ljZXMvJyArIGEuZGF0YXNldC5pcGFp' +
  'ZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgc3RhdHVzOiAnUGFpZCcgfSkgfSk7CiAgICB0b2Fz' +
  'dCgnTWFya2VkIHBhaWQnKTsgZ28oJ21vbmV5Jyk7CiAgfSk7Cn0KCmZ1bmN0aW9uIGZpcnN0T2ZNb250aCgpIHsKICBjb25zdCBk' +
  'ID0gbmV3IERhdGUoKTsgcmV0dXJuIG5ldyBEYXRlKGQuZ2V0RnVsbFllYXIoKSwgZC5nZXRNb250aCgpLCAxKS50b0lTT1N0cmlu' +
  'ZygpLnNsaWNlKDAsIDEwKTsKfQoKYXN5bmMgZnVuY3Rpb24gbXlQYXlWaWV3KCkgewogIGNvbnN0IFtzdGF0ZW1lbnRzLCBzdGF0' +
  'c10gPSBhd2FpdCBQcm9taXNlLmFsbChbYXBpKCcvc3RhdGVtZW50cycpLCBhcGkoJy9zdGF0cycpXSk7CiAgYXBwLmlubmVySFRN' +
  'TCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFnZSI+TXkgcGF5PC9oMT4KICAgIDxkaXYgY2xhc3M9InN0YXRzIj4KICAgICAg' +
  'PGRpdiBjbGFzcz0ic3RhdCBnb29kIj48ZGl2IGNsYXNzPSJuIj4ke21vbmV5KHN0YXRzLnVuYmlsbGVkKX08L2Rpdj48ZGl2IGNs' +
  'YXNzPSJsIj5FYXJuZWQsIG5vdCB5ZXQgb24gYSBzdGF0ZW1lbnQ8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdCI+' +
  'PGRpdiBjbGFzcz0ibiI+JHtzdGF0cy5zZXJ2ZWRfN2R9PC9kaXY+PGRpdiBjbGFzcz0ibCI+U2VydmVzIGNvbXBsZXRlZCwgNyBk' +
  'YXlzPC9kaXY+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImNhcmQiPjxoMj5TdGF0ZW1lbnRzPC9oMj4KICAgICR7' +
  'c3RhdGVtZW50cy5sZW5ndGggPyBgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgICA8dHI+PHRoPlBlcmlvZDwvdGg+PHRoIGNsYXNz' +
  'PSJudW0iPkpvYnM8L3RoPjx0aCBjbGFzcz0ibnVtIj5Ub3RhbDwvdGg+PHRoPjwvdGg+PHRoPjwvdGg+PC90cj4KICAgICAgJHtz' +
  'dGF0ZW1lbnRzLm1hcChzID0+IGA8dHI+PHRkPiR7Zm10RGF0ZU9ubHkocy5wZXJpb2Rfc3RhcnQpfeKAkyR7Zm10RGF0ZU9ubHko' +
  'cy5wZXJpb2RfZW5kKX08L3RkPgogICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke3Muam9iX2NvdW50fTwvdGQ+PHRkIGNsYXNzPSJu' +
  'dW0iPiR7bW9uZXkocy50b3RhbCl9PC90ZD4KICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InBpbGwgJHtjbHMocy5zdGF0dXMpfSI+' +
  'JHtlc2Mocy5zdGF0dXMpfTwvc3Bhbj48L3RkPgogICAgICAgIDx0ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIvcHJpbnQvc3RhdGVt' +
  'ZW50LyR7cy5pZH0iIHRhcmdldD0iX2JsYW5rIj5wcmludDwvYT48L3RkPjwvdHI+YCkuam9pbignJyl9CiAgICAgIDwvdGFibGU+' +
  'YCA6ICc8ZGl2IGNsYXNzPSJlbXB0eSI+Tm8gc3RhdGVtZW50cyB5ZXQuPC9kaXY+J30KICAgIDwvZGl2PgogICAgPGRpdiBjbGFz' +
  'cz0iY2FyZCI+PGgyPkNoYW5nZSBwYXNzd29yZDwvaDI+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPlRoaXMgaXMgeW91ciBvbmUg' +
  'cGFzc3dvcmQgZm9yIGV2ZXJ5IGFwcC48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxpbnB1dCBpZD0ib3B3IiB0eXBl' +
  'PSJwYXNzd29yZCIgcGxhY2Vob2xkZXI9IkN1cnJlbnQgcGFzc3dvcmQiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+' +
  'PGlucHV0IGlkPSJucHciIHR5cGU9InBhc3N3b3JkIiBwbGFjZWhvbGRlcj0iTmV3IHBhc3N3b3JkICg4KyBjaGFyYWN0ZXJzKSI+' +
  'PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9InNhdmVQdyI+VXBkYXRlPC9idXR0b24+PC9kaXY+YCk7CiAg' +
  'YmluZFNoZWxsKCk7CiAgJCgnI3NhdmVQdycpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBjb25zdCBy' +
  'ID0gYXdhaXQgYXBpKCcvbWUvcGFzc3dvcmQnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7CiAgICAg' +
  'ICAgcGFzc3dvcmQ6ICQoJyNucHcnKS52YWx1ZSwgb2xkX3Bhc3N3b3JkOiAkKCcjb3B3JykudmFsdWUgfSkgfSk7CiAgICAgICQo' +
  'JyNvcHcnKS52YWx1ZSA9ICcnOyAkKCcjbnB3JykudmFsdWUgPSAnJzsKICAgICAgdG9hc3Qoci5ldmVyeXdoZXJlID09PSBmYWxz' +
  'ZSA/ICdDaGFuZ2VkIGhlcmUg4oCUIG90aGVyIGFwcHMgc3RpbGwgaGF2ZSB0aGUgb2xkIG9uZScgOiAnUGFzc3dvcmQgdXBkYXRl' +
  'ZCBldmVyeXdoZXJlJyk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9Owp9CgoKZnVuY3Rp' +
  'b24gY29kZXNUYWJsZShsaXN0KSB7CiAgaWYgKCFsaXN0Lmxlbmd0aCkgcmV0dXJuICc8ZGl2IGNsYXNzPSJoaW50Ij5ObyBjb2Rl' +
  'cyB5ZXQuPC9kaXY+JzsKICByZXR1cm4gYDx0YWJsZSBjbGFzcz0idGJsIj4KICAgIDx0cj48dGg+Q29kZTwvdGg+PHRoPkdyYW50' +
  'czwvdGg+PHRoPlVzZWQ8L3RoPjx0aD48L3RoPjx0aD48L3RoPjwvdHI+CiAgICAke2xpc3QubWFwKGMgPT4gYDx0cj4KICAgICAg' +
  'PHRkPjxzcGFuIHN0eWxlPSJmb250OjYwMCAxM3B4IG1vbm9zcGFjZTtsZXR0ZXItc3BhY2luZzouNXB4Ij4ke2VzYyhjLmNvZGUp' +
  'fTwvc3Bhbj4KICAgICAgICAke2Mubm90ZSA/IGA8ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyhjLm5vdGUpfTwvZGl2PmAgOiAnJ30K' +
  'ICAgICAgICAke2MucmVkZW1wdGlvbnMgJiYgYy5yZWRlbXB0aW9ucy5sZW5ndGggPyBgPGRpdiBjbGFzcz0iaGludCI+JHtjLnJl' +
  'ZGVtcHRpb25zLm1hcChyID0+IGVzYyhyLmVtYWlsKSkuam9pbignLCAnKX08L2Rpdj5gIDogJyd9PC90ZD4KICAgICAgPHRkPiR7' +
  'Yy5yb2xlID09PSAnYWRtaW4nID8gJ0FkbWluJyA6ICdGaWVsZCBzZXJ2ZXInfQogICAgICAgICR7Yy5leHBpcmVzX2F0ID8gYDxk' +
  'aXYgY2xhc3M9ImhpbnQiPnRvICR7Zm10RGF0ZU9ubHkoYy5leHBpcmVzX2F0KX08L2Rpdj5gIDogJyd9PC90ZD4KICAgICAgPHRk' +
  'PiR7Yy51c2VkX2NvdW50fS8ke2MubWF4X3VzZXN9PC90ZD4KICAgICAgPHRkPjxzcGFuIGNsYXNzPSJwaWxsICR7Yy5zdGF0ZSA9' +
  'PT0gJ0FjdGl2ZScgPyAnU2VydmVkJyA6ICcnfSI+JHtlc2MoYy5zdGF0ZSl9PC9zcGFuPjwvdGQ+CiAgICAgIDx0ZCBjbGFzcz0i' +
  'bnVtIj4KICAgICAgICA8YSBocmVmPSIjIiBkYXRhLWNvcHk9IiR7ZXNjKGMuY29kZSl9Ij5jb3B5PC9hPgogICAgICAgICR7Yy5z' +
  'dGF0ZSA9PT0gJ0FjdGl2ZScgPyBgIMK3IDxhIGhyZWY9IiMiIGRhdGEtcmV2b2tlPSIke2MuaWR9Ij5yZXZva2U8L2E+YCA6ICcn' +
  'fQogICAgICA8L3RkPjwvdHI+YCkuam9pbignJyl9PC90YWJsZT5gOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBhZG1pbiAtLSAqLwovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gdGhlIHBsYW4gLS0gKi8KLyogVGhyZWUgc3RhdGVzIHdvcnRoIHRl' +
  'bGxpbmcgc29tZWJvZHkgYWJvdXQsIGFuZCBvbmUgd29ydGggc3RheWluZyBxdWlldCBvbi4KICAgQSBwYWlkIGNvbXBhbnkgc2Vl' +
  'cyBub3RoaW5nIGF0IHRoZSB0b3Agb2YgaXRzIGRhc2hib2FyZCDigJQgaXQgaGFzIGFscmVhZHkKICAgYm91Z2h0IHRoZSB0aGlu' +
  'ZywgYW5kIGEgYmFubmVyIHdvdWxkIGp1c3QgYmUgaW4gdGhlIHdheS4gKi8KCmNvbnN0IHBsYW4gPSAoKSA9PiAoUy5tZSAmJiBT' +
  'Lm1lLnBsYW4pIHx8IHsgcGxhbjogJ2ZyZWUnLCB0cmlhbDogZmFsc2UgfTsKCmZ1bmN0aW9uIHBsYW5CYW5uZXIoKSB7CiAgY29u' +
  'c3QgcCA9IHBsYW4oKTsKICBpZiAocC5wbGFuID09PSAncHJvJyAmJiAhcC50cmlhbCkgcmV0dXJuICcnOyAgICAgICAgICAvLyBw' +
  'YXlpbmc6IHNheSBub3RoaW5nCiAgaWYgKHAudHJpYWwpIHsKICAgIGNvbnN0IGQgPSBwLmRheXNfbGVmdDsKICAgIGlmIChkID09' +
  'PSBudWxsIHx8IGQgPiA3KSByZXR1cm4gJyc7ICAgICAgICAgICAgICAgICAvLyBlYXJseSBkYXlzOiBsZWF2ZSB0aGVtIGFsb25l' +
  'CiAgICByZXR1cm4gYDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJib3JkZXItY29sb3I6I0Y2QzY4QTtiYWNrZ3JvdW5kOiNGRUY2' +
  'RUMiPgogICAgICA8Yj4ke2QgPT09IDAgPyAnWW91ciB0cmlhbCBlbmRzIHRvZGF5JyA6IGQgPT09IDEgPyAnT25lIGRheSBsZWZ0' +
  'IGluIHlvdXIgdHJpYWwnCiAgICAgICAgICA6IGQgKyAnIGRheXMgbGVmdCBpbiB5b3VyIHRyaWFsJ308L2I+CiAgICAgIDxkaXYg' +
  'Y2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjRweCI+RXZlcnl0aGluZyBrZWVwcyB3b3JraW5nJHsKICAgICAgICBkID09' +
  'PSAwID8gJyB1bnRpbCBtaWRuaWdodCcgOiAnJ30uIEFmdGVyIHRoYXQgeW91IGNhbiBjYXJyeSBvbiBmcmVlIHdpdGggdXAgdG8K' +
  'ICAgICAgICAke3AubGltaXRzID8gcC5saW1pdHMuY2xpZW50cyA6IDN9IGF0dG9ybmV5IGNsaWVudHMuCiAgICAgICAgPGEgaHJl' +
  'Zj0iIyIgZGF0YS1nbz0iYWRtaW4iPlVwZ3JhZGU8L2E+PC9kaXY+PC9kaXY+YDsKICB9CiAgaWYgKHAudHJpYWxfb3Zlcikgewog' +
  'ICAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYm9yZGVyLWNvbG9yOiNGNkM2OEE7YmFja2dyb3VuZDojRkVGNkVD' +
  'Ij4KICAgICAgPGI+WW91ciBmcmVlIHRyaWFsIGhhcyBlbmRlZDwvYj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1h' +
  'cmdpbi10b3A6NHB4Ij5Zb3UgYXJlIG9uIHRoZSBmcmVlIHBsYW4g4oCUIHVwIHRvCiAgICAgICAgJHtwLmxpbWl0cyA/IHAubGlt' +
  'aXRzLmNsaWVudHMgOiAzfSBhdHRvcm5leSBjbGllbnRzLiBZb3VyIGpvYnMsIGF0dGVtcHRzIGFuZCBwaG90b3MgYXJlCiAgICAg' +
  'ICAgYWxsIHN0aWxsIGhlcmUuIDxhIGhyZWY9IiMiIGRhdGEtZ289ImFkbWluIj5VcGdyYWRlPC9hPjwvZGl2PjwvZGl2PmA7CiAg' +
  'fQogIHJldHVybiAnJzsKfQoKZnVuY3Rpb24gcGxhbkNhcmQoKSB7CiAgY29uc3QgcCA9IHBsYW4oKTsKICBjb25zdCBsYWJlbCA9' +
  'IHAucGxhbiA9PT0gJ3BybycKICAgID8gKHAudHJpYWwgPyBgRnJlZSB0cmlhbCDCtyAke3AuZGF5c19sZWZ0fSBkYXkke3AuZGF5' +
  'c19sZWZ0ID09PSAxID8gJycgOiAncyd9IGxlZnRgIDogJ1BybycpCiAgICA6IChwLnRyaWFsX292ZXIgPyAnRnJlZSDigJQgdHJp' +
  'YWwgZW5kZWQnIDogJ0ZyZWUnKTsKICByZXR1cm4gYDxkaXYgY2xhc3M9ImNhcmQiPgogICAgPGgyPlN1YnNjcmlwdGlvbiA8c3Bh' +
  'biBjbGFzcz0ic3ViIj4ke2VzYyhsYWJlbCl9PC9zcGFuPjwvaDI+CiAgICAke3AucGxhbiA9PT0gJ3BybycgJiYgIXAudHJpYWwK' +
  'ICAgICAgPyBgPGRpdiBjbGFzcz0iaGludCI+UGFpZCR7cC5leHBpcmVzX29uID8gJyB0aHJvdWdoICcgKyBmbXREYXRlT25seShw' +
  'LmV4cGlyZXNfb24pIDogJyd9LiBUaGFuayB5b3UuPC9kaXY+YAogICAgICA6IGA8ZGl2IGNsYXNzPSJoaW50Ij4ke3AudHJpYWwK' +
  'ICAgICAgICAgID8gYFlvdXIgdHJpYWwgcnVucyB0byAke2ZtdERhdGVPbmx5KHAuZXhwaXJlc19vbil9LiBOb3RoaW5nIGlzIGxp' +
  'bWl0ZWQgdW50aWwgdGhlbi5gCiAgICAgICAgICA6IGBUaGUgZnJlZSBwbGFuIGNvdmVycyAke3AubGltaXRzID8gcC5saW1pdHMu' +
  'Y2xpZW50cyA6IDN9IGF0dG9ybmV5IGNsaWVudHMuCiAgICAgICAgICAgICBFdmVyeXRoaW5nIGVsc2Ug4oCUIGpvYnMsIGF0dGVt' +
  'cHRzLCBwaG90b3MsIGFmZmlkYXZpdHMsIGludm9pY2VzIOKAlCBpcyB1bmxpbWl0ZWQuYH08L2Rpdj5gfQogICAgPGRpdiBjbGFz' +
  'cz0iZmllbGQiIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPjxsYWJlbD5IYXZlIGFuIHVwZ3JhZGUgY29kZT88L2xhYmVsPgogICAg' +
  'ICA8aW5wdXQgaWQ9InBsYW5Db2RlIiBwbGFjZWhvbGRlcj0iU1JWLTMwRC1YWFhYLVhYWFhYWCIgYXV0b2NhcGl0YWxpemU9ImNo' +
  'YXJhY3RlcnMiCiAgICAgICAgICAgICBzdHlsZT0idGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlIj48L2Rpdj4KICAgIDxidXR0b24g' +
  'Y2xhc3M9ImJ0biBzbSIgaWQ9InBsYW5HbyI+QXBwbHkgY29kZTwvYnV0dG9uPgogICAgPGRpdiBjbGFzcz0iaGludCIgaWQ9InBs' +
  'YW5Nc2ciIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+PC9kaXY+CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gd2lyZVBsYW5DYXJkKCkg' +
  'ewogIGNvbnN0IGJ0biA9ICQoJyNwbGFuR28nKTsKICBpZiAoIWJ0bikgcmV0dXJuOwogIGJ0bi5vbmNsaWNrID0gYXN5bmMgKCkg' +
  'PT4gewogICAgY29uc3QgbXNnID0gJCgnI3BsYW5Nc2cnKTsKICAgIGNvbnN0IGNvZGUgPSAoJCgnI3BsYW5Db2RlJykudmFsdWUg' +
  'fHwgJycpLnRyaW0oKTsKICAgIGlmICghY29kZSkgeyBtc2cudGV4dENvbnRlbnQgPSAnRW50ZXIgdGhlIGNvZGUgeW91IHdlcmUg' +
  'Z2l2ZW4uJzsgcmV0dXJuOyB9CiAgICBidG4uZGlzYWJsZWQgPSB0cnVlOwogICAgbXNnLnN0eWxlLmNvbG9yID0gJyc7CiAgICBt' +
  'c2cudGV4dENvbnRlbnQgPSAnQ2hlY2tpbmfigKYnOwogICAgdHJ5IHsKICAgICAgYXdhaXQgYXBpKCcvcGxhbi9yZWRlZW0nLCB7' +
  'IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNvZGUgfSkgfSk7CiAgICAgIFMubWUgPSBhd2FpdCBhcGko' +
  'Jy9tZScpOwogICAgICB0b2FzdCgnVXBncmFkZWQg4oCUIHRoYW5rIHlvdScpOwogICAgICBhZG1pblZpZXcoKTsKICAgIH0gY2F0' +
  'Y2ggKGUpIHsKICAgICAgbXNnLnN0eWxlLmNvbG9yID0gJ3ZhcigtLWJhZCknOwogICAgICBtc2cudGV4dENvbnRlbnQgPSBlLm1l' +
  'c3NhZ2U7CiAgICAgIGJ0bi5kaXNhYmxlZCA9IGZhbHNlOwogICAgfQogIH07Cn0KCmFzeW5jIGZ1bmN0aW9uIGFkbWluVmlldygp' +
  'IHsKICAvLyBGZXRjaCBldmVyeXRoaW5nIGJlZm9yZSBkcmF3aW5nLiBQb3B1bGF0aW5nIGNhcmRzIGFmdGVyIHJlbmRlciBtYWRl' +
  'IHRoZQogIC8vIHBhZ2UgZ3JvdyB1bmRlciB0aGUgdXNlcidzIGZpbmdlciwgc28gYSB0YXAgY291bGQgbGFuZCBvbiB0aGUgd3Jv' +
  'bmcgcm93LgogIGNvbnN0IFt1c2VycywgY2xpZW50cywgdGVtcGxhdGVzLCBjb2RlcywgcG9ydGFscywgY29tcGFuaWVzXSA9IGF3' +
  'YWl0IFByb21pc2UuYWxsKFsKICAgIGFwaSgnL3VzZXJzJyksIGFwaSgnL2NsaWVudHMnKSwgYXBpKCcvdGVtcGxhdGVzJyksCiAg' +
  'ICBhcGkoJy9jb2RlcycpLmNhdGNoKCgpID0+IFtdKSwgYXBpKCcvcG9ydGFscycpLmNhdGNoKCgpID0+IFtdKSwKICAgIGFwaSgn' +
  'L2NvbXBhbmllcycpLmNhdGNoKCgpID0+IFtdKQogIF0pOwogIGNvbnN0IGhlcmUgPSBjb21wYW5pZXMuZmluZChjID0+IFMubWUu' +
  'Y29tcGFueSAmJiBjLmlkID09PSBTLm1lLmNvbXBhbnkuaWQpIHx8IGNvbXBhbmllc1swXSB8fCB7fTsKICBhcHAuaW5uZXJIVE1M' +
  'ID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5TZXR1cDwvaDE+CgogICAgJHtwbGFuQ2FyZCgpfQoKICAgIDxkaXYgY2xh' +
  'c3M9ImNhcmQiPgogICAgICA8aDI+JHtpc093bmVyKCkgPyAnVGhpcyBjb21wYW55JyA6ICdZb3VyIGNvbXBhbnknfTwvaDI+CiAg' +
  'ICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+TmFtZTwvbGFiZWw+PGlucHV0IGlkPSJjb05hbWUiIHZhbHVlPSIke2VzYyho' +
  'ZXJlLm5hbWUgfHwgJycpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q29udGFjdCBlbWFpbDwvbGFi' +
  'ZWw+PGlucHV0IGlkPSJjb0VtYWlsIiB2YWx1ZT0iJHtlc2MoaGVyZS5jb250YWN0X2VtYWlsIHx8ICcnKX0iPjwvZGl2PgogICAg' +
  'ICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBob25lPC9sYWJlbD48aW5wdXQgaWQ9ImNvUGhvbmUiIHZhbHVlPSIke2VzYyho' +
  'ZXJlLnBob25lIHx8ICcnKX0iPjwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc20iIGlkPSJjb1NhdmUiPlNhdmU8L2J1' +
  'dHRvbj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij5UaGlzIG5hbWUgYXBwZWFycyBvbiB5' +
  'b3VyIGludm9pY2VzIGFuZCBwYXkgc3RhdGVtZW50cy48L2Rpdj4KICAgIDwvZGl2PgoKICAgICR7aXNPd25lcigpID8gYDxkaXYg' +
  'Y2xhc3M9ImNhcmQiPgogICAgICA8aDI+QWxsIGNvbXBhbmllcyA8c3BhbiBjbGFzcz0ic3ViIj4ke2NvbXBhbmllcy5sZW5ndGh9' +
  'PC9zcGFuPjwvaDI+CiAgICAgIDx0YWJsZSBjbGFzcz0idGJsIj4KICAgICAgICA8dHI+PHRoPkNvbXBhbnk8L3RoPjx0aCBjbGFz' +
  'cz0ibnVtIj5QZW9wbGU8L3RoPjx0aCBjbGFzcz0ibnVtIj5PcGVuPC90aD48dGg+PC90aD48L3RyPgogICAgICAgICR7Y29tcGFu' +
  'aWVzLm1hcChjID0+IGA8dHI+CiAgICAgICAgICA8dGQ+JHtlc2MoYy5uYW1lKX0ke1MubWUuY29tcGFueSAmJiBjLmlkID09PSBT' +
  'Lm1lLmNvbXBhbnkuaWQgPyAnIDxzcGFuIGNsYXNzPSJwaWxsIj55b3UgYXJlIGhlcmU8L3NwYW4+JyA6ICcnfQogICAgICAgICAg' +
  'ICA8ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyhjLmFkbWluX2VtYWlsIHx8ICdubyBhZG1pbiB5ZXQnKX0gwrcgJHtjLnBsYW4gPT09' +
  'ICdwcm8nID8gJ1BybycgOiAnRnJlZSd9PC9kaXY+PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke2MucGVvcGxlID8/' +
  'ICfigJQnfTwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHtjLm9wZW5fam9icyA/PyAn4oCUJ308L3RkPgogICAgICAg' +
  'ICAgPHRkIGNsYXNzPSJudW0iPiR7Uy5tZS5jb21wYW55ICYmIGMuaWQgPT09IFMubWUuY29tcGFueS5pZAogICAgICAgICAgICA/' +
  'ICcnIDogYDxhIGhyZWY9IiMiIGRhdGEtZW50ZXI9IiR7Yy5pZH0iPmVudGVyPC9hPmB9PC90ZD48L3RyPmApLmpvaW4oJycpfQog' +
  'ICAgICA8L3RhYmxlPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+PGxhYmVsPlN0YXJ0' +
  'IGFub3RoZXIgY29tcGFueTwvbGFiZWw+CiAgICAgICAgPGlucHV0IGlkPSJuZXdDb05hbWUiIHBsYWNlaG9sZGVyPSJDb21wYW55' +
  'IG5hbWUiPjwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc20iIGlkPSJuZXdDbyI+Q3JlYXRlIGNvbXBhbnk8L2J1dHRv' +
  'bj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij5DcmVhdGluZyBhIGNvbXBhbnkgZ2l2ZXMg' +
  'aXQgaXRzIG93biBqb2JzLCBjbGllbnRzIGFuZAogICAgICAgIGJpbGxpbmcuIEFkZCBpdHMgYWRtaW5pc3RyYXRvciBmcm9tIGlu' +
  'c2lkZSBpdCwgb3IgaGFuZCB0aGVtIGFuIGFjY2VzcyBjb2RlLjwvZGl2PgogICAgPC9kaXY+YCA6ICcnfQoKICAgIDxkaXYgY2xh' +
  'c3M9ImNhcmQiPgogICAgICA8aDI+VGVhbSA8c3BhbiBjbGFzcz0ic3ViIj4ke3VzZXJzLmxlbmd0aH08L3NwYW4+PC9oMj4KICAg' +
  'ICAgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgICAgIDx0cj48dGg+TmFtZTwvdGg+PHRoPlJvbGU8L3RoPjx0aCBjbGFzcz0ibnVt' +
  'Ij5SYXRlPC90aD48dGg+PC90aD48L3RyPgogICAgICAgICR7dXNlcnMubWFwKHUgPT4gYDx0cj48dGQ+JHtlc2ModS5uYW1lKX08' +
  'ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyh1LmVtYWlsKX08L2Rpdj48L3RkPgogICAgICAgICAgPHRkPiR7ZXNjKHUucm9sZSl9JHt1' +
  'LmFjdGl2ZSA/ICcnIDogJyA8c3BhbiBjbGFzcz0icGlsbCI+b2ZmPC9zcGFuPid9PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0i' +
  'bnVtIj4ke21vbmV5KHUuZGVmYXVsdF9wYXkpfTwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iIyIgZGF0' +
  'YS11c2VyPSIke3UuaWR9Ij5lZGl0PC9hPjwvdGQ+PC90cj5gKS5qb2luKCcnKX0KICAgICAgPC90YWJsZT4KICAgICAgPGJ1dHRv' +
  'biBjbGFzcz0iYnRuIHNlYyBibG9jayBzbSIgaWQ9Im5ld1VzZXIiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPisgQWRkIHBlcnNv' +
  'bjwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5DbGllbnRzIDxzcGFuIGNsYXNz' +
  'PSJzdWIiPiR7Y2xpZW50cy5sZW5ndGh9PC9zcGFuPjwvaDI+CiAgICAgIDx0YWJsZSBjbGFzcz0idGJsIj4KICAgICAgICA8dHI+' +
  'PHRoPk5hbWU8L3RoPjx0aCBjbGFzcz0ibnVtIj5EZWZhdWx0IGZlZTwvdGg+PHRoPjwvdGg+PC90cj4KICAgICAgICAke2NsaWVu' +
  'dHMubWFwKGMgPT4gYDx0cj48dGQ+JHtlc2MoYy5uYW1lKX08ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyhjLmNvbnRhY3RfbmFtZSB8' +
  'fCAnJyl9ICR7ZXNjKGMucGhvbmUgfHwgJycpfTwvZGl2PjwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHttb25leShj' +
  'LmRlZmF1bHRfZmVlKX08L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPjxhIGhyZWY9IiMiIGRhdGEtY2xpZW50PSIke2Mu' +
  'aWR9Ij5lZGl0PC9hPjwvdGQ+PC90cj5gKS5qb2luKCcnKX0KICAgICAgPC90YWJsZT4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRu' +
  'IHNlYyBibG9jayBzbSIgaWQ9Im5ld0NsaWVudCIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+KyBBZGQgY2xpZW50PC9idXR0b24+' +
  'CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkFmZmlkYXZpdCB0ZW1wbGF0ZXMgPHNwYW4gY2xh' +
  'c3M9InN1YiI+JHt0ZW1wbGF0ZXMubGVuZ3RofTwvc3Bhbj48L2gyPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdp' +
  'bi10b3A6LTRweCI+V3JpdGUgeW91ciBvd24gd29yZGluZyBwZXIgY291bnR5IG9yIGNsaWVudC4gTWVyZ2UgZmllbGRzIGZpbGwg' +
  'aW4gZnJvbSB0aGUgam9iLAogICAgICBpbmNsdWRpbmcgdGhlIGZ1bGwgYXR0ZW1wdCBsb2cgd2l0aCBHUFMuPC9wPgogICAgICA8' +
  'dGFibGUgY2xhc3M9InRibCI+CiAgICAgICAgJHt0ZW1wbGF0ZXMubWFwKHQgPT4gYDx0cj48dGQ+JHtlc2ModC5uYW1lKX08ZGl2' +
  'IGNsYXNzPSJoaW50Ij4ke2VzYyh0Lmp1cmlzZGljdGlvbiB8fCAnJyl9PC9kaXY+PC90ZD4KICAgICAgICAgIDx0ZD4ke3QuaXNf' +
  'ZGVmYXVsdCA/ICc8c3BhbiBjbGFzcz0icGlsbCBTZXJ2ZWQiPmRlZmF1bHQ8L3NwYW4+JyA6ICcnfTwvdGQ+CiAgICAgICAgICA8' +
  'dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iIyIgZGF0YS10cGw9IiR7dC5pZH0iPmVkaXQ8L2E+PC90ZD48L3RyPmApLmpvaW4oJycp' +
  'fQogICAgICA8L3RhYmxlPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIGJsb2NrIHNtIiBpZD0ibmV3VHBsIiBzdHlsZT0i' +
  'bWFyZ2luLXRvcDoxMHB4Ij4rIE5ldyB0ZW1wbGF0ZTwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+' +
  'CiAgICAgIDxoMj5BY2Nlc3MgY29kZXMgPHNwYW4gY2xhc3M9InN1YiI+bGV0IHBlb3BsZSBzZXQgdXAgdGhlaXIgb3duIGFjY291' +
  'bnQ8L3NwYW4+PC9oMj4KICAgICAgPHAgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOi00cHgiPkdlbmVyYXRlIGEgY29k' +
  'ZSBhbmQgc2VuZCBpdCBvdmVyLiBUaGV5IGVudGVyIGl0IG9uIHRoZSBzaWduLWluCiAgICAgICAgc2NyZWVuIHVuZGVyICJTZXQg' +
  'dXAgeW91ciBhY2NvdW50IiwgcGljayB0aGVpciBvd24gcGFzc3dvcmQsIGFuZCB0aGV5J3JlIGluIOKAlCBubyBuZWVkIHRvIGtl' +
  'eSBpbgogICAgICAgIHRoZWlyIGRldGFpbHMgb3Igc2hhcmUgYSBwYXNzd29yZCB3aXRoIHRoZW0uPC9wPgogICAgICA8ZGl2IGNs' +
  'YXNzPSJncmlkIGczIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlRo' +
  'ZXkgYmVjb21lPC9sYWJlbD48c2VsZWN0IGlkPSJjX3JvbGUiPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2VydmVyIj5GaWVs' +
  'ZCBzZXJ2ZXI8L29wdGlvbj48b3B0aW9uIHZhbHVlPSJhZG1pbiI+QWRtaW48L29wdGlvbj48L3NlbGVjdD48L2Rpdj4KICAgICAg' +
  'ICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkhvdyBtYW55IGNhbiB1c2UgaXQ8L2xhYmVsPjxpbnB1dCBpZD0iY191c2VzIiB0' +
  'eXBlPSJudW1iZXIiIG1pbj0iMSIgbWF4PSI1MDAiIHZhbHVlPSIxIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+' +
  'PGxhYmVsPkV4cGlyZXMgKG9wdGlvbmFsKTwvbGFiZWw+PGlucHV0IGlkPSJjX2V4cCIgdHlwZT0iZGF0ZSI+PC9kaXY+CiAgICAg' +
  'IDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBheSBw' +
  'ZXIgc2VydmUgKGZpZWxkIHNlcnZlcnMpPC9sYWJlbD48aW5wdXQgaWQ9ImNfcGF5IiB0eXBlPSJudW1iZXIiIHN0ZXA9IjAuMDEi' +
  'IHBsYWNlaG9sZGVyPSI0NS4wMCI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Ob3RlIHRvIHlvdXJz' +
  'ZWxmPC9sYWJlbD48aW5wdXQgaWQ9ImNfbm90ZSIgcGxhY2Vob2xkZXI9IkZvciBNYXJpYSDigJQgZXZpY3Rpb25zIj48L2Rpdj4K' +
  'ICAgICAgPC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9ImNfbWFrZSI+R2VuZXJhdGUgYSBjb2RlPC9idXR0' +
  'b24+CiAgICAgIDxkaXYgaWQ9ImNfbGlzdCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+JHtjb2Rlc1RhYmxlKGNvZGVzKX08L2Rp' +
  'dj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+Q291cnQgcG9ydGFsIHByb2JlIDxzcGFuIGNs' +
  'YXNzPSJzdWIiPmV4cGVyaW1lbnRhbDwvc3Bhbj48L2gyPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6' +
  'LTRweCI+QXNrcyB0aGUgc2VydmVyIHRvIGZldGNoIGEgY291bnR5IHBvcnRhbCBhbmQgcmVwb3J0IHdoYXQgY2FtZSBiYWNrIOKA' +
  'lAogICAgICAgIHN0YXR1cywgY29va2llcywgZm9ybXMsIGxpbmtzLiBUaGlzIGlzIHRoZSBncm91bmR3b3JrIGZvciBhdXRvbWF0' +
  'aWMgY2FzZSBsb29rdXA6IHRoZXNlIHBvcnRhbHMgY2FuJ3QgYmUKICAgICAgICByZWFjaGVkIGZyb20gd2hlcmUgdGhpcyBhcHAg' +
  'd2FzIHdyaXR0ZW4sIHNvIHRoZSBzZXJ2ZXIgaGFzIHRvIGdvIGFuZCBsb29rLiBSdW4gb25lIGFuZCBzZW5kIG1lIHRoZSByZXN1' +
  'bHQuPC9wPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIGlkPSJwcm9iZUJ0bnMiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPiR7cG9y' +
  'dGFscy5tYXAocHQgPT4KICAgICAgICBgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgZGF0YS1wcm9iZT0iJHtlc2MocHQua2V5' +
  'KX0iPiR7ZXNjKHB0LmxhYmVsKX08L2J1dHRvbj5gKS5qb2luKCcnKX08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHls' +
  'ZT0ibWFyZ2luLXRvcDoxMHB4Ij4KICAgICAgICA8aW5wdXQgaWQ9InByb2JlVXJsIiBwbGFjZWhvbGRlcj0i4oCmb3IgYSBzcGVj' +
  'aWZpYyBwYWdlIFVSTCIgc3R5bGU9ImZsZXg6MTttaW4td2lkdGg6MTUwcHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBz' +
  'ZWMgc20iIGlkPSJwcm9iZUdvIj5Qcm9iZSBVUkw8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxwcmUgY2xhc3M9InByZXYi' +
  'IGlkPSJwcm9iZU91dCIgc3R5bGU9ImRpc3BsYXk6bm9uZTttYXJnaW4tdG9wOjEwcHgiPjwvcHJlPgogICAgICA8YnV0dG9uIGNs' +
  'YXNzPSJidG4gc2VjIHNtIGJsb2NrIiBpZD0iY29weVByb2JlIiBzdHlsZT0iZGlzcGxheTpub25lO21hcmdpbi10b3A6OHB4Ij5D' +
  'b3B5IHJlc3VsdDwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5NeSBhY2NvdW50' +
  'PC9oMj4KICAgICAgPGRpdiBjbGFzcz0iaGludCI+T25lIHBhc3N3b3JkLCBldmVyeSBhcHAuIENoYW5naW5nIGl0IGhlcmUgY2hh' +
  'bmdlcyBpdCBldmVyeXdoZXJlLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkN1cnJlbnQgcGFzc3dvcmQ8' +
  'L2xhYmVsPjxpbnB1dCBpZD0ib3B3IiB0eXBlPSJwYXNzd29yZCIgcGxhY2Vob2xkZXI9InRoZSBvbmUgeW91IHNpZ25lZCBpbiB3' +
  'aXRoIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5OZXcgcGFzc3dvcmQ8L2xhYmVsPjxpbnB1dCBpZD0i' +
  'bnB3IiB0eXBlPSJwYXNzd29yZCIgcGxhY2Vob2xkZXI9IjgrIGNoYXJhY3RlcnMiPjwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNz' +
  'PSJidG4gc20iIGlkPSJzYXZlUHciPlVwZGF0ZSBwYXNzd29yZDwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBpZD0i' +
  'YnVpbGRTdGFtcCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+YnVpbGQg4oCmPC9kaXY+CiAgICA8L2Rpdj5gKTsKICBiaW5kU2hl' +
  'bGwoKTsKCiAgZmV0Y2goJy9hcGkvYnVpbGQnKS50aGVuKHIgPT4gci5qc29uKCkpLnRoZW4oYiA9PiB7CiAgICBjb25zdCBlbCA9' +
  'ICQoJyNidWlsZFN0YW1wJyk7CiAgICBpZiAoZWwpIGVsLnRleHRDb250ZW50ID0gJ1NlcnZlVHJhY2sgYnVpbGQgJyArIGIuYnVp' +
  'bGQgKyAoYi5wcm9iZVRhcmdldHMgPyAnIMK3IGJvb3QgcHJvYmUgYXJtZWQnIDogJycpOwogIH0pLmNhdGNoKCgpID0+IHt9KTsK' +
  'CgogIC8qIC0tLS0gYWNjZXNzIGNvZGVzIC0tLS0gKi8KICBhc3luYyBmdW5jdGlvbiBkcmF3Q29kZXMoKSB7CiAgICAkKCcjY19s' +
  'aXN0JykuaW5uZXJIVE1MID0gY29kZXNUYWJsZShhd2FpdCBhcGkoJy9jb2RlcycpKTsKICAgIHdpcmVDb2RlcygpOwogIH0KCiAg' +
  'ZnVuY3Rpb24gd2lyZUNvZGVzKCkgewogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtY29weV0nKS5mb3JFYWNo' +
  'KGEgPT4gYS5vbmNsaWNrID0gYXN5bmMgZSA9PiB7CiAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgdHJ5IHsgYXdhaXQg' +
  'bmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoYS5kYXRhc2V0LmNvcHkpOyB0b2FzdCgnQ29waWVkICcgKyBhLmRhdGFzZXQu' +
  'Y29weSk7IH0KICAgICAgY2F0Y2ggKGVycikgeyB0b2FzdCgnU2VsZWN0IGl0IGFuZCBjb3B5IGJ5IGhhbmQnLCB0cnVlKTsgfQog' +
  'ICAgfSk7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1yZXZva2VdJykuZm9yRWFjaChhID0+IGEub25jbGlj' +
  'ayA9IGFzeW5jIGUgPT4gewogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgIGlmICghY29uZmlybSgnUmV2b2tlIHRoaXMg' +
  'Y29kZT8gQW55b25lIHdobyBhbHJlYWR5IHVzZWQgaXQga2VlcHMgdGhlaXIgYWNjb3VudC4nKSkgcmV0dXJuOwogICAgICBhd2Fp' +
  'dCBhcGkoJy9jb2Rlcy8nICsgYS5kYXRhc2V0LnJldm9rZSwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5' +
  'KHsgcmV2b2tlZDogdHJ1ZSB9KSB9KTsKICAgICAgdG9hc3QoJ1Jldm9rZWQnKTsgZHJhd0NvZGVzKCk7CiAgICB9KTsKICB9CiAg' +
  'd2lyZUNvZGVzKCk7CgogICQoJyNjX21ha2UnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAgICAgY29uc3Qg' +
  'bWFkZSA9IGF3YWl0IGFwaSgnL2NvZGVzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoewogICAgICAg' +
  'IHJvbGU6ICQoJyNjX3JvbGUnKS52YWx1ZSwKICAgICAgICBtYXhfdXNlczogJCgnI2NfdXNlcycpLnZhbHVlLAogICAgICAgIGV4' +
  'cGlyZXNfYXQ6ICQoJyNjX2V4cCcpLnZhbHVlIHx8IG51bGwsCiAgICAgICAgZGVmYXVsdF9wYXk6ICQoJyNjX3BheScpLnZhbHVl' +
  'IHx8IDAsCiAgICAgICAgbm90ZTogJCgnI2Nfbm90ZScpLnZhbHVlCiAgICAgIH0pIH0pOwogICAgICAkKCcjY19ub3RlJykudmFs' +
  'dWUgPSAnJzsKICAgICAgdG9hc3QoJ0NvZGUgJyArIG1hZGUuY29kZSk7CiAgICAgIGRyYXdDb2RlcygpOwogICAgfSBjYXRjaCAo' +
  'ZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKICBkcmF3Q29kZXMoKS5jYXRjaCgoKSA9PiB7fSk7CgogIC8qIC0t' +
  'LS0gcG9ydGFsIHByb2JlIC0tLS0gKi8KICBjb25zdCBwcm9iZU91dCA9ICQoJyNwcm9iZU91dCcpOwogIGNvbnN0IHJ1blByb2Jl' +
  'ID0gYXN5bmMgYm9keSA9PiB7CiAgICBwcm9iZU91dC5zdHlsZS5kaXNwbGF5ID0gJyc7CiAgICBwcm9iZU91dC50ZXh0Q29udGVu' +
  'dCA9ICdQcm9iaW5n4oCmICh0aGlzIGNhbiB0YWtlIHVwIHRvIDIwIHNlY29uZHMpJzsKICAgICQoJyNjb3B5UHJvYmUnKS5zdHls' +
  'ZS5kaXNwbGF5ID0gJyc7CiAgICB0cnkgewogICAgICBjb25zdCByID0gYXdhaXQgYXBpKCcvcG9ydGFsLXByb2JlJywgeyBtZXRo' +
  'b2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSk7CiAgICAgIHByb2JlT3V0LnRleHRDb250ZW50ID0gSlNP' +
  'Ti5zdHJpbmdpZnkociwgbnVsbCwgMik7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIHByb2JlT3V0LnRleHRDb250ZW50ID0gJ1By' +
  'b2JlIGZhaWxlZDogJyArIGUubWVzc2FnZTsKICAgIH0KICB9OwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBy' +
  'b2JlXScpLmZvckVhY2goYiA9PgogICAgYi5vbmNsaWNrID0gKCkgPT4gcnVuUHJvYmUoeyBwb3J0YWw6IGIuZGF0YXNldC5wcm9i' +
  'ZSB9KSk7CiAgJCgnI3Byb2JlR28nKS5vbmNsaWNrID0gKCkgPT4gewogICAgY29uc3QgdSA9ICQoJyNwcm9iZVVybCcpLnZhbHVl' +
  'LnRyaW0oKTsKICAgIGlmICh1KSBydW5Qcm9iZSh7IHVybDogdSB9KTsKICB9OwogICQoJyNjb3B5UHJvYmUnKS5vbmNsaWNrID0g' +
  'YXN5bmMgKCkgPT4gewogICAgdHJ5IHsgYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQocHJvYmVPdXQudGV4dENv' +
  'bnRlbnQpOyB0b2FzdCgnQ29waWVkJyk7IH0KICAgIGNhdGNoIChlKSB7IHRvYXN0KCdTZWxlY3QgdGhlIHRleHQgYW5kIGNvcHkg' +
  'aXQgYnkgaGFuZCcsIHRydWUpOyB9CiAgfTsKCiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdXNlcl0nKS5mb3JF' +
  'YWNoKGEgPT4gYS5vbmNsaWNrID0gZSA9PiB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7IHVzZXJGb3JtKHVzZXJzLmZpbmQodSA9' +
  'PiBTdHJpbmcodS5pZCkgPT09IGEuZGF0YXNldC51c2VyKSk7CiAgfSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2Rh' +
  'dGEtY2xpZW50XScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sgPSBlID0+IHsKICAgIGUucHJldmVudERlZmF1bHQoKTsgY2xpZW50' +
  'Rm9ybShjbGllbnRzLmZpbmQoYyA9PiBTdHJpbmcoYy5pZCkgPT09IGEuZGF0YXNldC5jbGllbnQpKTsKICB9KTsKICBkb2N1bWVu' +
  'dC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS10cGxdJykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGUgPT4gewogICAgZS5wcmV2' +
  'ZW50RGVmYXVsdCgpOyB0ZW1wbGF0ZUZvcm0odGVtcGxhdGVzLmZpbmQodCA9PiBTdHJpbmcodC5pZCkgPT09IGEuZGF0YXNldC50' +
  'cGwpKTsKICB9KTsKICB3aXJlUGxhbkNhcmQoKTsKICBjb25zdCBjb1NhdmUgPSAkKCcjY29TYXZlJyk7CiAgaWYgKGNvU2F2ZSkg' +
  'Y29TYXZlLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBhd2FpdCBhcGkoJy9jb21wYW5pZXMvJyArICho' +
  'ZXJlLmlkKSwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsKICAgICAgICBuYW1lOiAkKCcjY29OYW1l' +
  'JykudmFsdWUsIGNvbnRhY3RfZW1haWw6ICQoJyNjb0VtYWlsJykudmFsdWUsIHBob25lOiAkKCcjY29QaG9uZScpLnZhbHVlIH0p' +
  'IH0pOwogICAgICBTLm1lID0gYXdhaXQgYXBpKCcvbWUnKTsKICAgICAgdG9hc3QoJ0NvbXBhbnkgc2F2ZWQnKTsKICAgICAgcmVu' +
  'ZGVyKCk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9OwogIGNvbnN0IG5ld0NvID0gJCgn' +
  'I25ld0NvJyk7CiAgaWYgKG5ld0NvKSBuZXdDby5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgY29uc3QgbmFtZSA9ICQoJyNu' +
  'ZXdDb05hbWUnKS52YWx1ZS50cmltKCk7CiAgICBpZiAoIW5hbWUpIHJldHVybiB0b2FzdCgnR2l2ZSB0aGUgY29tcGFueSBhIG5h' +
  'bWUnLCB0cnVlKTsKICAgIHRyeSB7CiAgICAgIGF3YWl0IGFwaSgnL2NvbXBhbmllcycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6' +
  'IEpTT04uc3RyaW5naWZ5KHsgbmFtZSB9KSB9KTsKICAgICAgUy5tZSA9IGF3YWl0IGFwaSgnL21lJyk7CiAgICAgIHRvYXN0KG5h' +
  'bWUgKyAnIGNyZWF0ZWQnKTsKICAgICAgcmVuZGVyKCk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7' +
  'IH0KICB9OwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWVudGVyXScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sg' +
  'PSBhc3luYyBlID0+IHsKICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgIHRyeSB7CiAgICAgIGNvbnN0IG91dCA9IGF3YWl0IGFw' +
  'aSgnL2NvbXBhbmllcy8nICsgYS5kYXRhc2V0LmVudGVyICsgJy9lbnRlcicsIHsgbWV0aG9kOiAnUE9TVCcgfSk7CiAgICAgIFMu' +
  'bWUgPSBhd2FpdCBhcGkoJy9tZScpOwogICAgICB0b2FzdCgnTm93IGluICcgKyBvdXQuY29tcGFueS5uYW1lKTsKICAgICAgcmVu' +
  'ZGVyKCk7CiAgICB9IGNhdGNoIChlcnIpIHsgdG9hc3QoZXJyLm1lc3NhZ2UsIHRydWUpOyB9CiAgfSk7CiAgJCgnI25ld1VzZXIn' +
  'KS5vbmNsaWNrID0gKCkgPT4gdXNlckZvcm0obnVsbCk7CiAgJCgnI25ld0NsaWVudCcpLm9uY2xpY2sgPSAoKSA9PiBjbGllbnRG' +
  'b3JtKG51bGwpOwogICQoJyNuZXdUcGwnKS5vbmNsaWNrID0gKCkgPT4gdGVtcGxhdGVGb3JtKG51bGwpOwogICQoJyNzYXZlUHcn' +
  'KS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAgICAgY29uc3QgciA9IGF3YWl0IGFwaSgnL21lL3Bhc3N3b3Jk' +
  'JywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHBhc3N3b3JkOiAkKCcjbnB3JykudmFs' +
  'dWUsIG9sZF9wYXNzd29yZDogJCgnI29wdycpLnZhbHVlIH0pIH0pOwogICAgICAkKCcjb3B3JykudmFsdWUgPSAnJzsgJCgnI25w' +
  'dycpLnZhbHVlID0gJyc7CiAgICAgIHRvYXN0KHIuZXZlcnl3aGVyZSA9PT0gZmFsc2UgPyAnQ2hhbmdlZCBoZXJlIOKAlCBvdGhl' +
  'ciBhcHBzIHN0aWxsIGhhdmUgdGhlIG9sZCBvbmUnIDogJ1Bhc3N3b3JkIHVwZGF0ZWQgZXZlcnl3aGVyZScpOwogICAgfSBjYXRj' +
  'aCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKfQoKZnVuY3Rpb24gdXNlckZvcm0odSkgewogIGNvbnN0IHYg' +
  'PSB1IHx8IHsgcm9sZTogJ3NlcnZlcicsIGFjdGl2ZTogdHJ1ZSB9OwogIHNoZWV0KHUgPyAnRWRpdCAnICsgdS5uYW1lIDogJ0Fk' +
  'ZCBwZXJzb24nLCBgCiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk5hbWU8L2xhYmVsPjxpbnB1dCBpZD0idV9uYW1lIiB2' +
  'YWx1ZT0iJHtlc2Modi5uYW1lKX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5FbWFpbCAodXNlZCB0byBz' +
  'aWduIGluKTwvbGFiZWw+PGlucHV0IGlkPSJ1X2VtYWlsIiB0eXBlPSJlbWFpbCIgdmFsdWU9IiR7ZXNjKHYuZW1haWwpfSI+PC9k' +
  'aXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPiR7dSA/ICdOZXcgcGFzc3dvcmQgKGxlYXZlIGJsYW5rIHRvIGtlZXAp' +
  'JyA6ICdQYXNzd29yZCd9PC9sYWJlbD48aW5wdXQgaWQ9InVfcGFzc3dvcmQiIHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSIke3Ug' +
  'PyAndW5jaGFuZ2VkJyA6ICdzZXQgYSBwYXNzd29yZCd9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICA8' +
  'ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlJvbGU8L2xhYmVsPjxzZWxlY3QgaWQ9InVfcm9sZSI+CiAgICAgICAgPG9wdGlvbiB2' +
  'YWx1ZT0ic2VydmVyIiAke3Yucm9sZSA9PT0gJ3NlcnZlcicgPyAnc2VsZWN0ZWQnIDogJyd9PkZpZWxkIHNlcnZlcjwvb3B0aW9u' +
  'PgogICAgICAgIDxvcHRpb24gdmFsdWU9ImFkbWluIiAke3Yucm9sZSA9PT0gJ2FkbWluJyA/ICdzZWxlY3RlZCcgOiAnJ30+QWRt' +
  'aW48L29wdGlvbj4KICAgICAgICAke2lzT3duZXIoKSA/IGA8b3B0aW9uIHZhbHVlPSJvd25lciIgJHt2LnJvbGUgPT09ICdvd25l' +
  'cicgPyAnc2VsZWN0ZWQnIDogJyd9Pk93bmVyIChldmVyeSBjb21wYW55KTwvb3B0aW9uPmAgOiAnJ30KICAgICAgPC9zZWxlY3Q+' +
  'PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RGVmYXVsdCBwYXkgcGVyIHNlcnZlPC9sYWJlbD48aW5wdXQg' +
  'aWQ9InVfZGVmYXVsdF9wYXkiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgdmFsdWU9IiR7di5kZWZhdWx0X3BheSB8fCAnJ30i' +
  'PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBob25lPC9sYWJlbD48aW5wdXQgaWQ9InVfcGhvbmUiIHZh' +
  'bHVlPSIke2VzYyh2LnBob25lKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkxpY2Vuc2UgLyByZWdp' +
  'c3RyYXRpb24gIzwvbGFiZWw+PGlucHV0IGlkPSJ1X2xpY2Vuc2Vfbm8iIHZhbHVlPSIke2VzYyh2LmxpY2Vuc2Vfbm8pfSI+PC9k' +
  'aXY+CiAgICA8L2Rpdj4KICAgICR7dSA/IGA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlN0YXR1czwvbGFiZWw+PHNlbGVjdCBp' +
  'ZD0idV9hY3RpdmUiPgogICAgICA8b3B0aW9uIHZhbHVlPSJ0cnVlIiAke3YuYWN0aXZlID8gJ3NlbGVjdGVkJyA6ICcnfT5BY3Rp' +
  'dmU8L29wdGlvbj4KICAgICAgPG9wdGlvbiB2YWx1ZT0iZmFsc2UiICR7IXYuYWN0aXZlID8gJ3NlbGVjdGVkJyA6ICcnfT5EZWFj' +
  'dGl2YXRlZDwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2PmAgOiAnJ30KICAgIDxkaXYgY2xhc3M9InJvdyI+PGJ1dHRvbiBjbGFzcz0i' +
  'YnRuIiBpZD0ic2F2ZSI+U2F2ZTwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25jbGljaz0iY2xvc2VTaGVl' +
  'dCgpIj5DYW5jZWw8L2J1dHRvbj48L2Rpdj5gLCBlbCA9PiB7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZScpLm9uY2xpY2sg' +
  'PSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IGJvZHkgPSB7CiAgICAgICAgbmFtZTogZWwucXVlcnlTZWxlY3RvcignI3VfbmFt' +
  'ZScpLnZhbHVlLCBlbWFpbDogZWwucXVlcnlTZWxlY3RvcignI3VfZW1haWwnKS52YWx1ZSwKICAgICAgICByb2xlOiBlbC5xdWVy' +
  'eVNlbGVjdG9yKCcjdV9yb2xlJykudmFsdWUsIHBob25lOiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9waG9uZScpLnZhbHVlLAogICAg' +
  'ICAgIGxpY2Vuc2Vfbm86IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X2xpY2Vuc2Vfbm8nKS52YWx1ZSwKICAgICAgICBkZWZhdWx0X3Bh' +
  'eTogZWwucXVlcnlTZWxlY3RvcignI3VfZGVmYXVsdF9wYXknKS52YWx1ZSB8fCAwCiAgICAgIH07CiAgICAgIGNvbnN0IHB3ID0g' +
  'ZWwucXVlcnlTZWxlY3RvcignI3VfcGFzc3dvcmQnKS52YWx1ZTsKICAgICAgaWYgKHB3KSBib2R5LnBhc3N3b3JkID0gcHc7CiAg' +
  'ICAgIGlmICh1KSBib2R5LmFjdGl2ZSA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X2FjdGl2ZScpLnZhbHVlID09PSAndHJ1ZSc7CiAg' +
  'ICAgIHRyeSB7CiAgICAgICAgYXdhaXQgKHUgPyBhcGkoJy91c2Vycy8nICsgdS5pZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6' +
  'IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pCiAgICAgICAgICAgICAgICAgOiBhcGkoJy91c2VycycsIHsgbWV0aG9kOiAnUE9TVCcs' +
  'IGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pKTsKICAgICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KCdTYXZlZCcpOyBnbygn' +
  'YWRtaW4nKTsKICAgICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgICB9OwogIH0pOwp9CgpmdW5j' +
  'dGlvbiBjbGllbnRGb3JtKGMpIHsKICBjb25zdCB2ID0gYyB8fCB7fTsKICBzaGVldChjID8gJ0VkaXQgJyArIGMubmFtZSA6ICdB' +
  'ZGQgY2xpZW50JywgYAogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5GaXJtIC8gY2xpZW50IG5hbWU8L2xhYmVsPjxpbnB1' +
  'dCBpZD0iY19uYW1lIiB2YWx1ZT0iJHtlc2Modi5uYW1lKX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAg' +
  'IDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q29udGFjdDwvbGFiZWw+PGlucHV0IGlkPSJjX2NvbnRhY3RfbmFtZSIgdmFsdWU9' +
  'IiR7ZXNjKHYuY29udGFjdF9uYW1lKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBob25lPC9sYWJl' +
  'bD48aW5wdXQgaWQ9ImNfcGhvbmUiIHZhbHVlPSIke2VzYyh2LnBob25lKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVs' +
  'ZCI+PGxhYmVsPkVtYWlsPC9sYWJlbD48aW5wdXQgaWQ9ImNfZW1haWwiIHR5cGU9ImVtYWlsIiB2YWx1ZT0iJHtlc2Modi5lbWFp' +
  'bCl9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5EZWZhdWx0IGZlZSBwZXIgc2VydmU8L2xhYmVsPjxp' +
  'bnB1dCBpZD0iY19kZWZhdWx0X2ZlZSIgdHlwZT0ibnVtYmVyIiBzdGVwPSIwLjAxIiB2YWx1ZT0iJHt2LmRlZmF1bHRfZmVlIHx8' +
  'ICcnfSI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+QmlsbGluZyBhZGRyZXNzPC9sYWJl' +
  'bD48dGV4dGFyZWEgaWQ9ImNfYWRkcmVzcyIgc3R5bGU9Im1pbi1oZWlnaHQ6NjBweCI+JHtlc2Modi5hZGRyZXNzKX08L3RleHRh' +
  'cmVhPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Ob3RlczwvbGFiZWw+PHRleHRhcmVhIGlkPSJjX25vdGVz' +
  'IiBzdHlsZT0ibWluLWhlaWdodDo2MHB4Ij4ke2VzYyh2Lm5vdGVzKX08L3RleHRhcmVhPjwvZGl2PgogICAgPGRpdiBjbGFzcz0i' +
  'cm93Ij48YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJzYXZlIj5TYXZlPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2Vj' +
  'IiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNhbmNlbDwvYnV0dG9uPjwvZGl2PmAsIGVsID0+IHsKICAgIGVsLnF1ZXJ5U2VsZWN0' +
  'b3IoJyNzYXZlJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgYm9keSA9IHt9OwogICAgICBbJ25hbWUnLCdj' +
  'b250YWN0X25hbWUnLCdwaG9uZScsJ2VtYWlsJywnZGVmYXVsdF9mZWUnLCdhZGRyZXNzJywnbm90ZXMnXQogICAgICAgIC5mb3JF' +
  'YWNoKGYgPT4gYm9keVtmXSA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNjXycgKyBmKS52YWx1ZSk7CiAgICAgIHRyeSB7CiAgICAgICAg' +
  'YXdhaXQgKGMgPyBhcGkoJy9jbGllbnRzLycgKyBjLmlkLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnko' +
  'Ym9keSkgfSkKICAgICAgICAgICAgICAgICA6IGFwaSgnL2NsaWVudHMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0' +
  'cmluZ2lmeShib2R5KSB9KSk7CiAgICAgICAgY2xvc2VTaGVldCgpOyB0b2FzdCgnU2F2ZWQnKTsgZ28oJ2FkbWluJyk7CiAgICAg' +
  'IH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogICAgfTsKICB9KTsKfQoKYXN5bmMgZnVuY3Rpb24gdGVt' +
  'cGxhdGVGb3JtKHQpIHsKICBjb25zdCBmaWVsZHMgPSBhd2FpdCBhcGkoJy90ZW1wbGF0ZS1maWVsZHMnKTsKICBjb25zdCB2ID0g' +
  'dCB8fCB7IGJvZHk6ICcnLCBpc19kZWZhdWx0OiBmYWxzZSB9OwogIHNoZWV0KHQgPyAnRWRpdCB0ZW1wbGF0ZScgOiAnTmV3IGFm' +
  'ZmlkYXZpdCB0ZW1wbGF0ZScsIGAKICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxh' +
  'YmVsPlRlbXBsYXRlIG5hbWU8L2xhYmVsPjxpbnB1dCBpZD0idF9uYW1lIiB2YWx1ZT0iJHtlc2Modi5uYW1lKX0iPjwvZGl2Pgog' +
  'ICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkp1cmlzZGljdGlvbiAvIGNvdXJ0PC9sYWJlbD48aW5wdXQgaWQ9InRfanVy' +
  'aXNkaWN0aW9uIiB2YWx1ZT0iJHtlc2Modi5qdXJpc2RpY3Rpb24pfSI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9' +
  'ImZpZWxkIj48bGFiZWw+Qm9keTwvbGFiZWw+CiAgICAgIDx0ZXh0YXJlYSBpZD0idF9ib2R5IiBzdHlsZT0ibWluLWhlaWdodDoy' +
  'MjBweDtmb250OjEyLjVweC8xLjUgJ0NvdXJpZXIgTmV3Jyxtb25vc3BhY2UiPiR7ZXNjKHYuYm9keSl9PC90ZXh0YXJlYT4KICAg' +
  'ICAgPGRpdiBjbGFzcz0iaGludCI+Q2xpY2sgYSBmaWVsZCB0byBpbnNlcnQgaXQgYXQgdGhlIGN1cnNvcjo8L2Rpdj4KICAgICAg' +
  'PGRpdiBjbGFzcz0idG9rZW5zIj4ke2ZpZWxkcy5tYXAoZiA9PiBgPGJ1dHRvbiBkYXRhLWY9IiR7ZlswXX0iIHRpdGxlPSIke2Vz' +
  'YyhmWzFdKX0iPnt7JHtmWzBdfX19PC9idXR0b24+YCkuam9pbignJyl9PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxsYWJlbCBzdHls' +
  'ZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6OHB4Ij48aW5wdXQgdHlwZT0iY2hlY2tib3giIGlkPSJ0X2Rl' +
  'ZmF1bHQiIHN0eWxlPSJ3aWR0aDphdXRvIiAke3YuaXNfZGVmYXVsdCA/ICdjaGVja2VkJyA6ICcnfT4gVXNlIGFzIHRoZSBkZWZh' +
  'dWx0IHRlbXBsYXRlPC9sYWJlbD4KICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+CiAgICAgIDxi' +
  'dXR0b24gY2xhc3M9ImJ0biIgaWQ9InNhdmUiPlNhdmU8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgaWQ9' +
  'InByZXZpZXciPlByZXZpZXcgd2l0aCByZWFsIGpvYjwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNs' +
  'aWNrPSJjbG9zZVNoZWV0KCkiPkNhbmNlbDwvYnV0dG9uPgogICAgICAke3QgPyAnPGJ1dHRvbiBjbGFzcz0iYnRuIGdob3N0IiBp' +
  'ZD0iZGVsIiBzdHlsZT0iY29sb3I6dmFyKC0tYmFkKTttYXJnaW4tbGVmdDphdXRvIj5EZWxldGU8L2J1dHRvbj4nIDogJyd9CiAg' +
  'ICA8L2Rpdj4KICAgIDxwcmUgY2xhc3M9InByZXYiIGlkPSJ0cHJldiIgc3R5bGU9ImRpc3BsYXk6bm9uZTttYXJnaW4tdG9wOjEy' +
  'cHgiPjwvcHJlPmAsIGVsID0+IHsKICAgIGNvbnN0IHRhID0gZWwucXVlcnlTZWxlY3RvcignI3RfYm9keScpOwogICAgZWwucXVl' +
  'cnlTZWxlY3RvckFsbCgnW2RhdGEtZl0nKS5mb3JFYWNoKGIgPT4gYi5vbmNsaWNrID0gKCkgPT4gewogICAgICBjb25zdCB0b2sg' +
  'PSAne3snICsgYi5kYXRhc2V0LmYgKyAnfX0nOwogICAgICBjb25zdCBzID0gdGEuc2VsZWN0aW9uU3RhcnQsIGUgPSB0YS5zZWxl' +
  'Y3Rpb25FbmQ7CiAgICAgIHRhLnZhbHVlID0gdGEudmFsdWUuc2xpY2UoMCwgcykgKyB0b2sgKyB0YS52YWx1ZS5zbGljZShlKTsK' +
  'ICAgICAgdGEuZm9jdXMoKTsgdGEuc2VsZWN0aW9uU3RhcnQgPSB0YS5zZWxlY3Rpb25FbmQgPSBzICsgdG9rLmxlbmd0aDsKICAg' +
  'IH0pOwogICAgZWwucXVlcnlTZWxlY3RvcignI3ByZXZpZXcnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBy' +
  'ID0gYXdhaXQgYXBpKCcvdGVtcGxhdGVzL3ByZXZpZXcnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7' +
  'IGJvZHk6IHRhLnZhbHVlIH0pIH0pOwogICAgICBjb25zdCBwID0gZWwucXVlcnlTZWxlY3RvcignI3RwcmV2Jyk7CiAgICAgIHAu' +
  'c3R5bGUuZGlzcGxheSA9ICcnOyBwLnRleHRDb250ZW50ID0gci50ZXh0OwogICAgfTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNz' +
  'YXZlJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgYm9keSA9IHsKICAgICAgICBuYW1lOiBlbC5xdWVyeVNl' +
  'bGVjdG9yKCcjdF9uYW1lJykudmFsdWUsIGp1cmlzZGljdGlvbjogZWwucXVlcnlTZWxlY3RvcignI3RfanVyaXNkaWN0aW9uJyku' +
  'dmFsdWUsCiAgICAgICAgYm9keTogdGEudmFsdWUsIGlzX2RlZmF1bHQ6IGVsLnF1ZXJ5U2VsZWN0b3IoJyN0X2RlZmF1bHQnKS5j' +
  'aGVja2VkCiAgICAgIH07CiAgICAgIGlmICghYm9keS5uYW1lLnRyaW0oKSkgcmV0dXJuIHRvYXN0KCdHaXZlIHRoZSB0ZW1wbGF0' +
  'ZSBhIG5hbWUnLCB0cnVlKTsKICAgICAgdHJ5IHsKICAgICAgICBhd2FpdCAodCA/IGFwaSgnL3RlbXBsYXRlcy8nICsgdC5pZCwg' +
  'eyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pCiAgICAgICAgICAgICAgICAgOiBhcGkoJy90' +
  'ZW1wbGF0ZXMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KSk7CiAgICAgICAgY2xvc2VT' +
  'aGVldCgpOyB0b2FzdCgnU2F2ZWQnKTsgZ28oJ2FkbWluJyk7CiAgICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0' +
  'cnVlKTsgfQogICAgfTsKICAgIGlmIChlbC5xdWVyeVNlbGVjdG9yKCcjZGVsJykpIGVsLnF1ZXJ5U2VsZWN0b3IoJyNkZWwnKS5v' +
  'bmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBpZiAoIWNvbmZpcm0oJ0RlbGV0ZSB0aGlzIHRlbXBsYXRlPycpKSByZXR1cm47' +
  'CiAgICAgIGF3YWl0IGFwaSgnL3RlbXBsYXRlcy8nICsgdC5pZCwgeyBtZXRob2Q6ICdERUxFVEUnIH0pOwogICAgICBjbG9zZVNo' +
  'ZWV0KCk7IHRvYXN0KCdEZWxldGVkJyk7IGdvKCdhZG1pbicpOwogICAgfTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGJvb3QgLS0gKi8KY29uc3QgVklFV1MgPSB7IGRh' +
  'c2g6IGRhc2hWaWV3LCBqb2JzOiBqb2JzVmlldywgam9iOiBqb2JWaWV3LCBzY2FuOiBzY2FuVmlldywKICB0b29sczogdG9vbHNW' +
  'aWV3LCBmaW5kOiBmaW5kVmlldywgcHJvcGVydHk6IHByb3BlcnR5VmlldywgbW9uZXk6IG1vbmV5VmlldywgYWRtaW46IGFkbWlu' +
  'VmlldyB9OwoKYXN5bmMgZnVuY3Rpb24gcmVuZGVyKCkgewogIGNsb3NlU2hlZXQoKTsKICBpZiAoIVMubWUpIHJldHVybiBsb2dp' +
  'blZpZXcoKTsKICBpZiAoUy52aWV3ID09PSAnam9icycpIFMuY2FjaGUuam9iRmlsdGVyID0gUy5wYXJhbXM7CiAgY29uc3QgZm4g' +
  'PSBWSUVXU1tTLnZpZXddIHx8IGRhc2hWaWV3OwogIHRyeSB7CiAgICBhcHAuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9IndyYXAi' +
  'PjxkaXYgY2xhc3M9ImVtcHR5Ij5Mb2FkaW5n4oCmPC9kaXY+PC9kaXY+JzsKICAgIGF3YWl0IGZuKCk7CiAgfSBjYXRjaCAoZSkg' +
  'ewogICAgaWYgKFMubWUpIHsgYXBwLmlubmVySFRNTCA9IHNoZWxsKGA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJlbXB0' +
  'eSI+JHtlc2MoZS5tZXNzYWdlKX08L2Rpdj48L2Rpdj5gKTsgYmluZFNoZWxsKCk7IH0KICB9Cn0KCihhc3luYyBmdW5jdGlvbiBi' +
  'b290KCkgewogIHRyeSB7IFMubWUgPSBhd2FpdCBhcGkoJy9tZScpOyB9IGNhdGNoIChlKSB7IFMubWUgPSBudWxsOyB9CiAgcmVu' +
  'ZGVyKCk7Cn0pKCk7Cn0pKCk7CgovKiAtLS0tIGluc3RhbGxhYmxlIGFwcCAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tCiAgIEEgc2VydmljZSB3b3JrZXIgcGx1cyBhIG1hbmlmZXN0IGlzIHRoZSB3aG9sZSBk' +
  'aWZmZXJlbmNlIGJldHdlZW4gYSB3ZWIgcGFnZQogICBhbmQgc29tZXRoaW5nIHRoYXQgbGl2ZXMgb24gdGhlIGhvbWUgc2NyZWVu' +
  'IHdpdGggaXRzIG93biBpY29uIGFuZCBubyBicm93c2VyCiAgIGJhcnMuIE5vIHN0b3JlLCBubyByZXZpZXcsIG5vIGRldmVsb3Bl' +
  'ciBhY2NvdW50LgoKICAgVGhlIGJhciB3YWl0cyBhIGNvdXBsZSBvZiBzZWNvbmRzIHNvIGl0IG5ldmVyIGxhbmRzIG9uIHRvcCBv' +
  'ZiB3aGF0IHNvbWVvbmUKICAgaXMgcmVhZGluZywgYW5kIG9uY2UgZGlzbWlzc2VkIGl0IHN0YXlzIGRpc21pc3NlZCBvbiB0aGF0' +
  'IGRldmljZS4gICAgICAgICAgKi8KKGZ1bmN0aW9uICgpIHsKICBpZiAoJ3NlcnZpY2VXb3JrZXInIGluIG5hdmlnYXRvcikgewog' +
  'ICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ2xvYWQnLCBmdW5jdGlvbiAoKSB7CiAgICAgIG5hdmlnYXRvci5zZXJ2aWNlV29y' +
  'a2VyLnJlZ2lzdGVyKCcvc3cuanMnKS5jYXRjaChmdW5jdGlvbiAoKSB7fSk7CiAgICB9KTsKICB9CiAgdmFyIHN0YW5kYWxvbmUg' +
  'PSB3aW5kb3cubWF0Y2hNZWRpYSgnKGRpc3BsYXktbW9kZTogc3RhbmRhbG9uZSknKS5tYXRjaGVzCiAgICAgICAgICAgICAgICB8' +
  'fCB3aW5kb3cubmF2aWdhdG9yLnN0YW5kYWxvbmUgPT09IHRydWU7CiAgaWYgKHN0YW5kYWxvbmUpIHJldHVybjsKCiAgdmFyIEtF' +
  'WSA9ICdzdF9hMmhzJzsKICB0cnkgeyBpZiAobG9jYWxTdG9yYWdlLmdldEl0ZW0oS0VZKSA9PT0gJzEnKSByZXR1cm47IH0gY2F0' +
  'Y2ggKGUpIHt9CgogIHZhciBpb3MgPSAvaXBob25lfGlwYWR8aXBvZC9pLnRlc3QobmF2aWdhdG9yLnVzZXJBZ2VudCk7CiAgdmFy' +
  'IGJhciA9IG51bGwsIGRlZmVycmVkID0gbnVsbDsKCiAgZnVuY3Rpb24gYnVpbGQoaHRtbCkgewogICAgYmFyID0gZG9jdW1lbnQu' +
  'Y3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICBiYXIuaWQgPSAnYTJocyc7CiAgICBiYXIuaW5uZXJIVE1MID0gJzxpbWcgY2xhc3M9' +
  'ImFpIiBzcmM9Ii9pY29uLTE5Mi5wbmciIGFsdD0iIj4nICsgaHRtbCArCiAgICAgICc8YnV0dG9uIGNsYXNzPSJ4IiBhcmlhLWxh' +
  'YmVsPSJEaXNtaXNzIj4mdGltZXM7PC9idXR0b24+JzsKICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYmFyKTsKICAgIGJh' +
  'ci5xdWVyeVNlbGVjdG9yKCcueCcpLm9uY2xpY2sgPSBmdW5jdGlvbiAoKSB7CiAgICAgIGJhci5jbGFzc0xpc3QucmVtb3ZlKCdv' +
  'bicpOwogICAgICB0cnkgeyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShLRVksICcxJyk7IH0gY2F0Y2ggKGUpIHt9CiAgICB9OwogICAg' +
  'c2V0VGltZW91dChmdW5jdGlvbiAoKSB7IGJhci5jbGFzc0xpc3QuYWRkKCdvbicpOyB9LCAyNjAwKTsKICB9CgogIGlmIChpb3Mp' +
  'IHsKICAgIGJ1aWxkKCc8ZGl2IGNsYXNzPSJhdCI+PGI+UHV0IFNlcnZlVHJhY2sgb24geW91ciBob21lIHNjcmVlbjwvYj4nICsK' +
  'ICAgICAgICAgICdUYXAgU2hhcmUsIHRoZW4gPGIgc3R5bGU9ImRpc3BsYXk6aW5saW5lIj5BZGQgdG8gSG9tZSBTY3JlZW48L2I+' +
  'LjwvZGl2PicpOwogIH0gZWxzZSB7CiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignYmVmb3JlaW5zdGFsbHByb21wdCcsIGZ1' +
  'bmN0aW9uIChldikgewogICAgICBldi5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBkZWZlcnJlZCA9IGV2OwogICAgICBpZiAoYmFy' +
  'KSByZXR1cm47CiAgICAgIGJ1aWxkKCc8ZGl2IGNsYXNzPSJhdCI+PGI+SW5zdGFsbCBTZXJ2ZVRyYWNrPC9iPlJ1bnMgZnVsbCBz' +
  'Y3JlZW4sIG9wZW5zIHN0cmFpZ2h0IHRvIHlvdXIgd29yay48L2Rpdj4nICsKICAgICAgICAgICAgJzxidXR0b24gaWQ9ImEyaHNH' +
  'byI+SW5zdGFsbDwvYnV0dG9uPicpOwogICAgICB2YXIgZ28gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYTJoc0dvJyk7CiAg' +
  'ICAgIGlmIChnbykgZ28ub25jbGljayA9IGZ1bmN0aW9uICgpIHsKICAgICAgICBiYXIuY2xhc3NMaXN0LnJlbW92ZSgnb24nKTsK' +
  'ICAgICAgICBkZWZlcnJlZC5wcm9tcHQoKTsKICAgICAgICBkZWZlcnJlZCA9IG51bGw7CiAgICAgICAgdHJ5IHsgbG9jYWxTdG9y' +
  'YWdlLnNldEl0ZW0oS0VZLCAnMScpOyB9IGNhdGNoIChlKSB7fQogICAgICB9OwogICAgfSk7CiAgfQp9KSgpOwoKPC9zY3JpcHQ+' +
  'CjwvYm9keT4KPC9odG1sPgo='
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

/* ---------------------------------------------------------------- plans --- */
/* A plan belongs to the company that pays, not to whoever happens to be signed
   in — so these are keyed by tenant ("company:3"), and the answer is the same
   whichever member of staff asks.

   The caller is expected to keep the last answer somewhere of its own. If My
   Apps cannot be reached, an app must go on working on what it last knew: an
   accounts service having a bad afternoon is not a reason to stop a process
   server from filing an affidavit. */

const plan = tenant => call('/api/v1/plan', { tenant });

const startTrial = (tenant, tenantName) => call('/api/v1/trial', { tenant, tenantName });

const redeemForTenant = ({ tenant, tenantName, code }) =>
  call('/api/v1/redeem-tenant', { tenant, tenantName, code });

return { enabled, warm, login, register, changePassword, status, call,
                   plan, startTrial, redeemForTenant };

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
const BUILD = '2026-09-02.27';           // shown in Setup so uploads can be confirmed
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

/* Forgotten passwords are handled by My Apps, because that is where passwords
   are. This is only a signpost, so every app can carry the same plain link and
   none of them needs to know the address at build time. */
app.get('/forgot', (req, res) => {
  const base = (process.env.MY_APPS_URL || '').replace(/\/+$/, '');
  if (!base) {
    return res.type('html').send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
       <body style="font:16px/1.6 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;background:#EDF2FB;
       color:#101822;margin:0;padding:40px 20px"><div style="max-width:420px;margin:0 auto;background:#fff;
       border:1px solid #DBE4F2;border-radius:14px;padding:24px">
       <h1 style="margin:0 0 8px;font-size:21px;color:#0B4FD3">Reset your password</h1>
       <p>Contact <a href="mailto:steve.smith@buddyrents.com">steve.smith@buddyrents.com</a>
          and your password will be reset for you.</p>
       <p><a href="/">Back to ServeTrack</a></p></div></body>`);
  }
  res.redirect(302, base + '/forgot?app=' + encodeURIComponent('ServeTrack'));
});

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

/* ------------------------------------------------------------ the plan --- */
/* A company gets everything for thirty days, then falls back to a free tier
 * that stops at three attorney clients.
 *
 * My Apps decides the plan. This app keeps a copy on the company row and reads
 * only that copy when deciding whether to allow something, which matters more
 * than it sounds: the check happens on the path where somebody is adding a
 * client, and that path must not wait on a network call to a service that may
 * be asleep. The copy is refreshed in the background on sign-in and every ten
 * minutes thereafter. If My Apps cannot be reached, the last known plan stands.
 *
 * Set FREE_CLIENTS to 0 for no ceiling at all.                              */

const FREE_CLIENTS = Number(process.env.FREE_CLIENTS ?? 3);
const PLAN_RECHECK_MS = 10 * 60 * 1000;
const tenantKey = companyId => 'company:' + companyId;

/* A DATE column arrives from pg as a JS Date, and String()-ing one gives
   "Fri Sep 05 2026 ...", which sliced to ten characters is "Fri Sep 05" — a
   date the browser cannot read. Always go through the ISO form. */
const dateISO = v => {
  if (!v) return null;
  if (v instanceof Date) {
    return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  return String(v).slice(0, 10);
};

/* What the stored copy means today. Expiry is applied here as well as in My
   Apps, so a trial ends on time even during an outage. */
function planOf(co) {
  if (!co) return { plan: 'free', trial: false, days_left: null, expires_on: null, source: '' };
  const expired = co.plan === 'pro' && co.plan_expires &&
                  new Date(co.plan_expires) < new Date(new Date().toDateString());
  const plan = expired ? 'free' : (co.plan || 'free');
  const days = plan === 'pro' && co.plan_expires
    ? Math.max(0, Math.round((new Date(co.plan_expires) - new Date(new Date().toDateString())) / 86400000))
    : null;
  return {
    plan,
    source: co.plan_source || '',
    expires_on: dateISO(co.plan_expires),
    days_left: days,
    trial: plan === 'pro' && co.plan_source === 'trial',
    /* On free, with a trial as the last thing that happened, means the trial
       is what ran out — whether this app noticed the date passing or My Apps
       told us. Both routes have to say the same thing to the customer. */
    trial_over: plan === 'free' && co.plan_source === 'trial',
    limits: plan === 'free' && FREE_CLIENTS > 0 ? { clients: FREE_CLIENTS } : null
  };
}

async function companyRow(companyId) {
  const { rows } = await q(
    `SELECT id,name,plan,plan_expires,plan_source,plan_checked,trial_started
       FROM companies WHERE id=$1`, [companyId]);
  return rows[0] || null;
}

/* Ask My Apps what this company is on, and write down the answer.
   Never throws and never blocks anything: on any failure the stored copy is
   left exactly as it was and the caller carries on with it. */
async function refreshPlan(companyId, { force = false } = {}) {
  const co = await companyRow(companyId);
  if (!co) return null;
  if (!central.enabled()) return co;
  if (!force && co.plan_checked && Date.now() - new Date(co.plan_checked).getTime() < PLAN_RECHECK_MS) {
    return co;
  }

  try {
    /* The first ask of a company's life starts its trial; every ask after that
       is just a question. startTrial answers with the plan either way, so this
       is one call, not two. */
    const answer = co.trial_started
      ? await central.plan(tenantKey(companyId))
      : await central.startTrial(tenantKey(companyId), co.name);

    if (!answer.ok) return co;

    await q(
      `UPDATE companies
          SET plan=$1, plan_expires=$2, plan_source=$3, plan_checked=NOW(), trial_started=TRUE
        WHERE id=$4`,
      [answer.plan === 'pro' ? 'pro' : 'free', answer.expires_on || null,
       answer.source || '', companyId]);

    if (answer.started) {
      console.log(`${co.name}: ${answer.days_left}-day trial started`);
    }
    return await companyRow(companyId);
  } catch (e) {
    console.error(`Could not refresh the plan for ${co.name}: ${e.message}`);
    return co;
  }
}

/* The one question the app asks before letting somebody add a client. Returns
   null to allow, or the sentence to show them. */
async function clientLimitMessage(companyId) {
  if (!FREE_CLIENTS) return null;
  const p = planOf(await companyRow(companyId));
  if (p.plan !== 'free') return null;
  const { rows } = await q(
    'SELECT count(*)::int n FROM clients WHERE company_id=$1 AND active', [companyId]);
  if (rows[0].n < FREE_CLIENTS) return null;
  return p.trial_over
    ? `Your free trial has ended. The free plan covers ${FREE_CLIENTS} attorney clients — ` +
      `upgrade to add more, or deactivate one you no longer work for.`
    : `The free plan covers ${FREE_CLIENTS} attorney clients. Upgrade to add more, ` +
      `or deactivate one you no longer work for.`;
}

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
  /* This is the call every page makes on load, which makes it the natural
     place to keep the plan current — and the first one of a company's life is
     what starts its trial. It cannot fail loudly: refreshPlan swallows its own
     errors and hands back whatever was last known. */
  const co = await refreshPlan(req.companyId);
  const me = Object.assign({}, req.user, {
    company: co ? { id: co.id, name: co.name, plan: co.plan, plan_expires: dateISO(co.plan_expires) } : null,
    plan: planOf(co),
    is_admin: isAdmin(req.user),
    support: supportView(req)
  });
  if (req.user.role === 'owner') {
    me.companies = (await q('SELECT id,name FROM companies ORDER BY name')).rows;
  }
  res.json(me);
}));

/* Redeem an upgrade code against this company.
 *
 * The code is verified by My Apps, not here — this app never learns the signing
 * secret, so a copy of this source is no help in making one. A code is spent
 * once; My Apps enforces that, and the answer either upgrades the company or
 * explains why not. */
app.post('/api/plan/redeem', auth, admin, wrap(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Enter your upgrade code' });
  if (!central.enabled()) {
    return res.status(503).json({ error: 'This app is not connected to My Apps yet' });
  }
  const co = await companyRow(req.companyId);
  const out = await central.redeemForTenant({
    tenant: tenantKey(req.companyId), tenantName: co && co.name, code });

  if (!out.ok) {
    return res.status(out.unavailable ? 503 : 400).json({
      error: out.unavailable
        ? "Couldn't reach the accounts service — try again in a moment."
        : out.error
    });
  }
  const fresh = await refreshPlan(req.companyId, { force: true });
  console.log(`${co && co.name}: upgraded with a code until ${out.expires_on}`);
  res.json({ ok: true, plan: planOf(fresh) });
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
  const blocked = await clientLimitMessage(req.companyId);
  if (blocked) return res.status(402).json({ error: blocked, upgrade: true });
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

/* -------------------------------------------------------------- people --- */
/* Everything this company already knows about a person, gathered in one place.
 *
 * The most valuable skip-trace database a working process server has is his own
 * history: where somebody actually was, who answered the door, which addresses
 * turned out to be stale. Until now that sat in separate jobs — the same
 * defendant sent by three different attorneys looked like three unrelated
 * records with no way to see they were the same person.
 *
 * On matching: names are grouped by a normalised key so that "GARZA, MARIA" and
 * "Maria Garza" land together. It is deliberately not clever beyond that. Two
 * people really can share a name, and in this line of work serving the wrong
 * Maria Garza is a serious mistake, so candidates are shown side by side with
 * the evidence — addresses, dates, attorneys — and the judgement is left to the
 * person who has to sign the affidavit.
 */

const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V', 'MD', 'DDS', 'ESQ']);

/* "GARZA, MARIA E JR" and "maria garza" both become "GARZA MARIA".
   Middle initials are dropped: they are present on court paper and absent from
   everything else, and keeping them splits one person into two. */
function nameKey(raw) {
  const cleaned = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z\s,]/g, ' ')
    .replace(/,/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !SUFFIXES.has(t))
    .filter(t => t.length > 1);            // drop middle initials
  return [...new Set(cleaned)].sort().join(' ');
}

/* Addresses are compared on the street line only. Unit numbers matter for
   knocking on the right door but not for deciding it is the same building, and
   "APT 4" versus "#4" would otherwise look like two places. */
const ABBREV = { STREET: 'ST', ROAD: 'RD', AVENUE: 'AVE', DRIVE: 'DR', LANE: 'LN',
  BOULEVARD: 'BLVD', COURT: 'CT', CIRCLE: 'CIR', HIGHWAY: 'HWY', PLACE: 'PL',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W' };

function addrKey(raw) {
  /* Only the first comma-separated part. An attempt records the whole address
     — "1806 Ash Ave, McAllen, TX 78501" — while the job holds the street line
     on its own, and comparing the two whole made one building look like two. */
  return String(raw || '')
    .split(',')[0]
    .toUpperCase()
    .replace(/[.#]/g, ' ')
    .replace(/\b(APT|UNIT|STE|SUITE|LOT|TRLR|BLDG|RM)\b.*$/, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(t => ABBREV[t] || t)
    .join(' ')
    .trim();
}

const PEOPLE_SQL = `
  SELECT j.id, j.job_number, j.recipient_name, j.defendant, j.plaintiff, j.case_number,
         j.address1, j.address2, j.city, j.state, j.zip, j.status, j.service_type,
         j.due_date, j.created_at, j.served_at, j.recipient_notes,
         c.id AS client_id, c.name AS client_name
    FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
   WHERE j.company_id = $1`;

const ATTEMPTS_FOR = `
  SELECT a.job_id, a.attempted_at, a.outcome, a.manner, a.person_served,
         a.relationship, a.description, a.notes, a.address_used, a.lat, a.lng,
         u.name AS server_name
    FROM attempts a
    LEFT JOIN users u ON u.id = a.server_id
   WHERE a.job_id = ANY($1::int[])
   ORDER BY a.attempted_at DESC`;

/* One person, assembled from however many jobs mention them. */
function buildPerson(jobs, attempts) {
  const byJob = {};
  for (const a of attempts) (byJob[a.job_id] = byJob[a.job_id] || []).push(a);

  const addresses = {};
  /* `city`, `state` and `zip` come from the job, so they may only be attached
     to the job's own address. An attempt made somewhere else — a workplace in
     the next town — carries its own city inside the line, and borrowing the
     job's would put a confidently wrong city on a skip-trace lead. */
  const note = (line, city, state, zip, source) => {
    if (!line) return null;
    const key = addrKey(line);
    if (!key) return null;
    const a = addresses[key] || (addresses[key] = {
      key, line, city: city || '', state: state || '', zip: zip || '',
      attempts: 0, outcomes: {}, first: null, last: null, sources: new Set()
    });
    a.sources.add(source);
    if (city && !a.city) a.city = city;
    if (zip && !a.zip) a.zip = zip;
    return a;
  };

  const timeline = [];
  const clients = {};
  const variants = new Set();

  for (const j of jobs) {
    variants.add(j.recipient_name);
    if (j.defendant && nameKey(j.defendant) === nameKey(j.recipient_name)) variants.add(j.defendant);
    if (j.client_name) clients[j.client_name] = (clients[j.client_name] || 0) + 1;
    note(j.address1, j.city, j.state, j.zip, 'on file');

    for (const a of (byJob[j.id] || [])) {
      const where = a.address_used || j.address1;
      const sameAsJob = addrKey(where) === addrKey(j.address1);
      const at = sameAsJob
        ? note(where, j.city, j.state, j.zip, 'attempted')
        : note(where, '', '', '', 'attempted elsewhere');
      if (at) {
        at.attempts++;
        at.outcomes[a.outcome] = (at.outcomes[a.outcome] || 0) + 1;
        const when = a.attempted_at;
        if (!at.first || when < at.first) at.first = when;
        if (!at.last || when > at.last) at.last = when;
      }
      timeline.push({
        when: a.attempted_at, outcome: a.outcome, manner: a.manner,
        person_served: a.person_served, relationship: a.relationship,
        notes: a.notes, address: a.address_used || j.address1,
        server: a.server_name, job_number: j.job_number, job_id: j.id
      });
    }
  }

  timeline.sort((x, y) => new Date(y.when) - new Date(x.when));

  const list = Object.values(addresses).map(a =>
    Object.assign({}, a, { sources: [...a.sources] }));
  /* Most-attempted first, then most recent: the address you are most likely to
     want at the top. */
  list.sort((a, b) => (b.attempts - a.attempts) || (new Date(b.last || 0) - new Date(a.last || 0)));

  const served = jobs.filter(j => j.status === 'Served');
  return {
    name: jobs[0].recipient_name,
    variants: [...variants],
    jobs: jobs.map(j => ({
      id: j.id, job_number: j.job_number, case_number: j.case_number,
      status: j.status, client_id: j.client_id, client_name: j.client_name,
      plaintiff: j.plaintiff, service_type: j.service_type,
      address: [j.address1, j.city, j.state].filter(Boolean).join(', '),
      created_at: j.created_at, served_at: j.served_at, due_date: j.due_date,
      notes: j.recipient_notes
    })),
    addresses: list,
    timeline: timeline.slice(0, 60),
    clients: Object.entries(clients).map(([name, n]) => ({ name, jobs: n })),
    stats: {
      jobs: jobs.length,
      attempts: timeline.length,
      served: served.length,
      last_served_at: served.length ? served[0].served_at : null,
      evasive: timeline.filter(t => /evad/i.test(t.outcome || '')).length,
      bad_address: timeline.filter(t => /bad address|moved/i.test(t.outcome || '')).length
    }
  };
}

/* Search by name. Returns candidates, not a verdict. */
app.get('/api/people', auth, wrap(async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 2) return res.json({ people: [] });

  /* Every word has to appear somewhere in the name, in any order, so "garza
     maria" and "maria garza" both find her. */
  const words = term.split(/[\s,]+/).filter(w => w.length > 1).slice(0, 5);
  const params = [req.companyId];
  const clauses = words.map(w => {
    params.push('%' + w + '%');
    const i = '$' + params.length;
    return `(j.recipient_name ILIKE ${i} OR j.defendant ILIKE ${i})`;
  });
  const { rows: jobs } = await q(
    `${PEOPLE_SQL} AND ${clauses.join(' AND ') || 'TRUE'} ORDER BY j.created_at DESC LIMIT 400`,
    params);
  if (!jobs.length) return res.json({ people: [] });

  const { rows: attempts } = await q(ATTEMPTS_FOR, [jobs.map(j => j.id)]);

  const groups = {};
  for (const j of jobs) {
    const k = nameKey(j.recipient_name);
    (groups[k] = groups[k] || []).push(j);
  }
  const people = Object.entries(groups)
    .map(([key, list]) => Object.assign({ key }, buildPerson(list, attempts)))
    .sort((a, b) => b.stats.jobs - a.stats.jobs);

  res.json({ people: supportView(req) ? people.map(maskPerson) : people });
}));

/* One person in full, by the key the search handed back. */
app.get('/api/people/one', auth, wrap(async (req, res) => {
  const key = String(req.query.key || '').trim();
  if (!key) return res.status(400).json({ error: 'No person given' });

  /* The key is derived, not stored, so the only way to find its members is to
     recompute it — over this company's jobs only. */
  const { rows: all } = await q(`${PEOPLE_SQL} ORDER BY j.created_at DESC LIMIT 3000`, [req.companyId]);
  const mine = all.filter(j => nameKey(j.recipient_name) === key);
  if (!mine.length) return res.status(404).json({ error: 'Nobody by that name in your records' });

  const { rows: attempts } = await q(ATTEMPTS_FOR, [mine.map(j => j.id)]);
  const person = Object.assign({ key }, buildPerson(mine, attempts));
  res.json(supportView(req) ? maskPerson(person) : person);
}));

/* Search by address: who has this company ever tried to serve here, and who
   answered the door. The second half is what makes substituted service
   possible — a co-resident of suitable age you have already met and recorded. */
app.get('/api/people/at', auth, wrap(async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 3) return res.json({ addresses: [] });
  const key = addrKey(term);

  const { rows: jobs } = await q(
    `${PEOPLE_SQL} AND (j.address1 ILIKE $2 OR j.address2 ILIKE $2)
     ORDER BY j.created_at DESC LIMIT 400`,
    [req.companyId, '%' + term + '%']);

  /* Attempts can record an address that is not the one on the job — a work
     address, a relative's house — so those are searched too. */
  const { rows: viaAttempt } = await q(
    `${PEOPLE_SQL.replace('WHERE j.company_id = $1', `
       WHERE j.company_id = $1 AND j.id IN (
         SELECT a.job_id FROM attempts a WHERE a.address_used ILIKE $2)`)}
     ORDER BY j.created_at DESC LIMIT 400`,
    [req.companyId, '%' + term + '%']);

  const seen = new Set(jobs.map(j => j.id));
  const merged = jobs.concat(viaAttempt.filter(j => !seen.has(j.id)));
  if (!merged.length) return res.json({ addresses: [] });

  const { rows: attempts } = await q(ATTEMPTS_FOR, [merged.map(j => j.id)]);
  const byJob = {};
  for (const a of attempts) (byJob[a.job_id] = byJob[a.job_id] || []).push(a);

  const places = {};
  const placeAt = (k, line, j) => places[k] || (places[k] = {
    key: k, line, city: j.city || '', state: j.state || '', zip: j.zip || '',
    people: {}, answered: {}, attempts: 0, outcomes: {}, last: null
  });
  const wanted = k => k && (!key || k.includes(key) || key.includes(k));

  for (const j of merged) {
    const jobAttempts = byJob[j.id] || [];

    /* Distinct places this job touched. Going through the raw list instead
       would count a job's two attempts once for its address line and again for
       each attempt line — which is how "2 attempts" became "6". */
    const lines = new Map();
    for (const line of [j.address1, ...jobAttempts.map(a => a.address_used)]) {
      const k = addrKey(line);
      if (wanted(k) && !lines.has(k)) lines.set(k, line);
    }

    for (const [k, line] of lines) {
      const place = placeAt(k, line, j);
      const pk = nameKey(j.recipient_name);
      const p = place.people[pk] ||
        (place.people[pk] = { key: pk, name: j.recipient_name, jobs: 0, statuses: {} });
      p.jobs++;                                    // once per job, not per line
      p.statuses[j.status] = (p.statuses[j.status] || 0) + 1;
    }

    // And every attempt counted exactly once, against the place it happened.
    for (const a of jobAttempts) {
      const k = addrKey(a.address_used || j.address1);
      if (!wanted(k) || !places[k]) continue;
      const place = places[k];
      place.attempts++;
      place.outcomes[a.outcome] = (place.outcomes[a.outcome] || 0) + 1;
      if (!place.last || a.attempted_at > place.last) place.last = a.attempted_at;
      /* Anyone who actually came to the door, and what they said they were.
         This is the answer to "who else lives there". */
      if (a.person_served) {
        const who = a.person_served.trim();
        const rec = place.answered[who.toUpperCase()] ||
          (place.answered[who.toUpperCase()] = {
            name: who, relationship: a.relationship || '', times: 0, last: null });
        rec.times++;
        if (a.relationship && !rec.relationship) rec.relationship = a.relationship;
        if (!rec.last || a.attempted_at > rec.last) rec.last = a.attempted_at;
      }
    }
  }

  const out = Object.values(places).map(p => Object.assign({}, p, {
    people: Object.values(p.people),
    answered: Object.values(p.answered).sort((a, b) => b.times - a.times)
  })).sort((a, b) => b.attempts - a.attempts);

  res.json({ addresses: supportView(req) ? out.map(maskPlace) : out });
}));

/* ------------------------------------------------- public records --------
 *
 * Free sources, no account and no key. Each one was checked by hand before it
 * was written in here; a source that turned out to be a web page rather than
 * something a program can ask is not included, however useful it sounds.
 *
 *   Franchise taxpayers   every LLC and corporation in Texas, with a street
 *                         address. If they run a business, this is a live
 *                         address when the home one has gone stale.
 *   Sales tax permits     the same, plus the outlet — the actual storefront,
 *                         which is often a better door than the mailing address.
 *   TDLR licences         trades and cosmetology. County only, no street, so it
 *                         confirms a person rather than finding one.
 *   NPI registry          anyone in healthcare, with practice and mailing
 *                         addresses. In the Valley that is a lot of people.
 *
 * Two rules govern all of it. Nothing found here is written into anybody's
 * records — it is a lead to go and check, and it is labelled with where it came
 * from and when. And no lookup may ever hold up the page: each source has its
 * own short timeout, each is allowed to fail on its own, and the person's own
 * history is already on screen before any of this is asked for.
 */

/* Overridable so the tests can point all of this at a stand-in and make each
   source slow, broken or empty on demand — none of which the real services
   will do politely when asked. */
const SOCRATA = process.env.PUBLIC_RECORDS_BASE || 'https://data.texas.gov/resource/';
const NPI_BASE = process.env.NPI_BASE || 'https://npiregistry.cms.hhs.gov/api/';
const PUBLIC_TIMEOUT = Number(process.env.PUBLIC_TIMEOUT_MS || 12000);
const PUBLIC_CACHE_MS = 6 * 60 * 60 * 1000;      // these change daily at most
const publicCache = new Map();

/* A single quote is how you end a string in SoQL, so a name like O'Brien would
   otherwise be a broken query at best. Doubling it is the escape. */
const soql = s => String(s || '').replace(/'/g, "''");

async function getJson(url, timeout = PUBLIC_TIMEOUT) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) throw new Error('answered with ' + (type || 'no content type'));
  return res.json();
}

/* Government data shouts. Putting it back into normal case makes it readable on
   a phone, but a couple of things must survive: McAllen is a city he will read
   fifty times a week, and a directional or a state abbreviation turned into
   "N." or "Tx" looks like a mistake. */
const KEEP_UPPER = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'TX', 'US', 'FM',
  'LLC', 'LLP', 'LP', 'PC', 'PO', 'DDS', 'MD', 'LVN', 'RN', 'DBA', 'II', 'III', 'IV']);

const titleCaseName = s => String(s || '').replace(/[\w']+/g, t => {
  const up = t.toUpperCase();
  if (KEEP_UPPER.has(up)) return up;
  if (/^\d/.test(t)) return up;                       // 3301, 78501, 1st
  const word = t[0].toUpperCase() + t.slice(1).toLowerCase();
  // McAllen, MacDonald, O'Brien
  return word
    .replace(/^(Mc|Mac)([a-z])/, (m, p, c) => p + c.toUpperCase())
    .replace(/^O'([a-z])/, (m, c) => "O'" + c.toUpperCase());
});

/* Each source turns its own rows into the one shape the app renders, so the
   browser never has to know which service a lead came from. */
const SOURCES = {
  franchise: {
    label: 'Texas franchise taxpayers',
    what: 'Companies registered with the Comptroller',
    async byName(name) {
      const rows = await getJson(`${SOCRATA}9cir-efmm.json?$limit=25&$where=` +
        encodeURIComponent(`upper(taxpayer_name) like '%${soql(name.toUpperCase())}%'`));
      return rows.map(r => ({
        name: titleCaseName(r.taxpayer_name),
        address: titleCaseName(r.taxpayer_address || ''),
        city: titleCaseName(r.taxpayer_city || ''),
        state: r.taxpayer_state || 'TX',
        zip: r.taxpayer_zip || '',
        kind: 'Business',
        detail: [r.sos_status_code === 'A' ? 'active' : 'inactive',
                 r.secretary_of_state_sos_or_coa_file_number
                   ? 'SOS ' + r.secretary_of_state_sos_or_coa_file_number : '']
                .filter(Boolean).join(' · ')
      }));
    }
  },

  salestax: {
    label: 'Texas sales tax permits',
    what: 'Businesses with a permit, and where they actually trade',
    async byName(name) {
      const n = soql(name.toUpperCase());
      const rows = await getJson(`${SOCRATA}jrea-zgmq.json?$limit=25&$where=` +
        encodeURIComponent(`upper(taxpayer_name) like '%${n}%' OR upper(outlet_name) like '%${n}%'`));
      return rows.map(r => ({
        name: titleCaseName(r.outlet_name || r.taxpayer_name),
        address: titleCaseName(r.outlet_address || r.taxpayer_address || ''),
        city: titleCaseName(r.outlet_city || r.taxpayer_city || ''),
        state: r.outlet_state || 'TX',
        zip: r.outlet_zip_code || r.taxpayer_zip_code || '',
        kind: 'Storefront',
        detail: [r.taxpayer_name && r.taxpayer_name !== r.outlet_name
                   ? 'owner ' + titleCaseName(r.taxpayer_name) : '',
                 r.outlet_permit_issue_date ? 'since ' + String(r.outlet_permit_issue_date).slice(0, 10) : '']
                .filter(Boolean).join(' · ')
      }));
    },
    async byAddress(addr) {
      const a = soql(addr.toUpperCase());
      const rows = await getJson(`${SOCRATA}jrea-zgmq.json?$limit=25&$where=` +
        encodeURIComponent(`upper(outlet_address) like '%${a}%'`));
      return rows.map(r => ({
        name: titleCaseName(r.outlet_name || r.taxpayer_name),
        address: titleCaseName(r.outlet_address || ''),
        city: titleCaseName(r.outlet_city || ''),
        state: r.outlet_state || 'TX',
        zip: r.outlet_zip_code || '',
        kind: 'Business at this address',
        detail: r.taxpayer_name ? 'owner ' + titleCaseName(r.taxpayer_name) : ''
      }));
    }
  },

  tdlr: {
    label: 'Texas licensed trades',
    what: 'A/C, electrical, cosmetology and the rest — county only, no street',
    async byName(name) {
      const n = soql(name.toUpperCase());
      const rows = await getJson(`${SOCRATA}7358-krk7.json?$limit=25&$where=` +
        encodeURIComponent(`upper(owner_name) like '%${n}%' OR upper(business_name) like '%${n}%'`));
      return rows.map(r => ({
        name: titleCaseName(r.owner_name || r.business_name),
        address: '',
        city: '',
        state: 'TX',
        zip: '',
        kind: 'Licence',
        detail: [r.license_type, r.business_county ? titleCaseName(r.business_county) + ' County' : '',
                 r.license_expiration_date_mmddccyy ? 'expires ' + r.license_expiration_date_mmddccyy : '']
                .filter(Boolean).join(' · ')
      }));
    }
  },

  npi: {
    label: 'Healthcare providers',
    what: 'The national provider registry — practice and mailing addresses',
    async byName(name) {
      /* This one wants the name split, and will not take a bare surname
         without a state, so Texas is always supplied. */
      const parts = String(name).trim().split(/[\s,]+/).filter(Boolean);
      const last = parts.length > 1 ? parts[parts.length - 1] : parts[0];
      const first = parts.length > 1 ? parts[0] : '';
      const url = NPI_BASE + (NPI_BASE.includes('?') ? '&' : '?') +
        'version=2.1&limit=20&state=TX' +
        `&last_name=${encodeURIComponent(last)}` +
        (first ? `&first_name=${encodeURIComponent(first)}` : '');
      const data = await getJson(url);
      const out = [];
      for (const r of (data.results || [])) {
        const b = r.basic || {};
        const who = [b.first_name, b.last_name].filter(Boolean).join(' ') ||
                    b.organization_name || '';
        for (const a of (r.addresses || [])) {
          out.push({
            name: titleCaseName(who),
            address: titleCaseName([a.address_1, a.address_2].filter(Boolean).join(' ')),
            city: titleCaseName(a.city || ''),
            state: a.state || 'TX',
            zip: String(a.postal_code || '').slice(0, 5),
            kind: a.address_purpose === 'MAILING' ? 'Mailing address' : 'Practice address',
            detail: [b.credential, a.telephone_number].filter(Boolean).join(' · ')
          });
        }
      }
      return out;
    }
  }
};

/* Ask them all at once. One slow or broken source must not delay or spoil the
   others, so each is raced against its own timeout and reported separately —
   "couldn't reach it" is a different answer from "nothing found", and a person
   deciding where to knock deserves to know which one they got. */
async function publicRecords(kind, term) {
  const key = kind + '|' + term.toUpperCase();
  const hit = publicCache.get(key);
  if (hit && Date.now() - hit.at < PUBLIC_CACHE_MS) return hit.out;

  const usable = Object.entries(SOURCES).filter(([, s]) => s[kind]);
  const out = await Promise.all(usable.map(async ([id, s]) => {
    const started = Date.now();
    try {
      const results = await s[kind](term);
      return { id, label: s.label, what: s.what, ok: true,
               ms: Date.now() - started, results };
    } catch (e) {
      const why = /timeout|abort/i.test(e.message)
        ? 'took too long to answer' : e.message;
      console.warn(`public records: ${id} failed — ${why}`);
      return { id, label: s.label, what: s.what, ok: false,
               ms: Date.now() - started, error: why, results: [] };
    }
  }));

  publicCache.set(key, { at: Date.now(), out });
  if (publicCache.size > 300) publicCache.delete(publicCache.keys().next().value);
  return out;
}

app.get('/api/people/public', auth, wrap(async (req, res) => {
  /* Support view hides your customers' people from whoever is helping you.
     Handing that same person a public-records search on a name would walk
     straight around it. */
  if (supportView(req)) {
    return res.status(403).json({ error: 'Not available in support view' });
  }
  const name = String(req.query.name || '').trim();
  const address = String(req.query.address || '').trim();
  if (name.length < 3 && address.length < 4) {
    return res.json({ sources: [] });
  }
  const sources = name
    ? await publicRecords('byName', name)
    : await publicRecords('byAddress', address);
  res.json({
    sources,
    note: 'Public records. A lead to go and check, not a fact — nothing here ' +
          'has been added to your records.'
  });
}));

/* ---- where a paid skip-trace service plugs in ------------------------------
 *
 * TLO, IRB, Delvepoint and the rest all answer the same question — "what else
 * is known about this name or this address" — and all of them want a
 * credentialed account and a permissible purpose, which service of process is.
 *
 * When there is one to plug in, it goes here: one function, taking a name and
 * whatever is already known, returning addresses and phones in the same shape
 * the browser already renders. Nothing above needs to change, and the app goes
 * on working exactly as it does now if the call fails or is not configured —
 * the same rule the plan and accounts services follow.
 *
 * Deliberately not written until there is a real account behind it. A stub
 * that returns nothing is indistinguishable from a service that is down, and
 * would be one more thing to mistrust when a search comes back empty.
 */
app.get('/api/people/external', auth, wrap(async (req, res) => {
  res.json({
    configured: false,
    note: 'No paid data service is connected. Your own records and the county ' +
          'appraisal roll are what this app searches today.'
  });
}));

/* Support view exists so somebody can be helped without their customers' names
   and case details leaving the database. A people search is precisely the thing
   that must not become a way around that, so it is masked here rather than in
   the browser. */
function maskPerson(p) {
  /* A fresh object rather than masking in place: maskFields edits the row it is
     given, and the unmasked one is still referenced by the list it came from. */
  return Object.assign({}, p, {
    name: maskText(p.name),
    variants: ['—'],
    clients: [],
    jobs: (p.jobs || []).map(j => maskFields(Object.assign({}, j),
      ['case_number', 'client_name', 'plaintiff', 'notes', 'address'])),
    addresses: (p.addresses || []).map(a => Object.assign({}, a, { line: '—', city: '—', zip: '' })),
    timeline: (p.timeline || []).map(t => maskFields(Object.assign({}, t),
      ['person_served', 'relationship', 'notes', 'address']))
  });
}

function maskPlace(p) {
  return Object.assign({}, p, {
    line: '—', city: '—', zip: '',
    people: (p.people || []).map(x => Object.assign({}, x, { name: '—' })),
    answered: (p.answered || []).map(x => Object.assign({}, x, { name: '—', relationship: '—' }))
  });
}

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
  /* Where the attempt actually happened, which is not always the address on the
     job — a work address, a relative's house, the address a neighbour gave you.
     That is the most useful thing a process server learns in a day, and until
     now it was thrown away and replaced with the address on the paperwork. */
  const addr = String(b.address_used || '').trim() ||
    [job.address1, job.city, job.state, job.zip].filter(Boolean).join(', ');
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
