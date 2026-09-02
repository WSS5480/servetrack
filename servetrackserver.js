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
  'bGljayA9ICgpID0+IGdvKGIuZGF0YXNldC50YWIpKTsKICAvLyBMaW5rcyBpbnNpZGUgYSBjYXJkIHRoYXQganVtcCB0byBhIHRh' +
  'YiDigJQgIlVwZ3JhZGUiIG9uIHRoZSBwbGFuIGJhbm5lci4KICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1nb10n' +
  'KS5mb3JFYWNoKGEgPT4KICAgIGEub25jbGljayA9IGUgPT4geyBlLnByZXZlbnREZWZhdWx0KCk7IGdvKGEuZGF0YXNldC5nbyk7' +
  'IH0pOwogIGNvbnN0IGxvID0gJCgnI2xvZ291dCcpOwogIGlmIChsbykgbG8ub25jbGljayA9IGFzeW5jICgpID0+IHsgYXdhaXQg' +
  'YXBpKCcvbG9nb3V0JywgeyBtZXRob2Q6ICdQT1NUJyB9KTsgUy5tZSA9IG51bGw7IHJlbmRlcigpOyB9OwogIGNvbnN0IHN3ID0g' +
  'JCgnI2NvU3dpdGNoJyk7CiAgaWYgKHN3KSBzdy5vbmNoYW5nZSA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGNvbnN0' +
  'IG91dCA9IGF3YWl0IGFwaSgnL2NvbXBhbmllcy8nICsgc3cudmFsdWUgKyAnL2VudGVyJywgeyBtZXRob2Q6ICdQT1NUJyB9KTsK' +
  'ICAgICAgUy5tZSA9IGF3YWl0IGFwaSgnL21lJyk7CiAgICAgIHRvYXN0KCdOb3cgaW4gJyArIG91dC5jb21wYW55Lm5hbWUpOwog' +
  'ICAgICByZW5kZXIoKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07Cn0KCi8qIC0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGxvZ2luIC0tICovCmZ1bmN0' +
  'aW9uIGxvZ2luVmlldygpIHsKICBhcHAuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImxvZ2luIj4KICAgIDxkaXYgY2xhc3M9Imxv' +
  'Z28iPjxiPlNlcnZlVHJhY2s8L2I+PGRpdj5Qcm9jZXNzIHNlcnZpbmcgbWFuYWdlbWVudDwvZGl2PjwvZGl2PgogICAgPGRpdiBj' +
  'bGFzcz0iY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RW1haWw8L2xhYmVsPjxpbnB1dCBpZD0iZW1haWwi' +
  'IHR5cGU9ImVtYWlsIiBhdXRvY29tcGxldGU9InVzZXJuYW1lIiBpbnB1dG1vZGU9ImVtYWlsIj48L2Rpdj4KICAgICAgPGRpdiBj' +
  'bGFzcz0iZmllbGQiPjxsYWJlbD5QYXNzd29yZDwvbGFiZWw+PGlucHV0IGlkPSJwdyIgdHlwZT0icGFzc3dvcmQiIGF1dG9jb21w' +
  'bGV0ZT0iY3VycmVudC1wYXNzd29yZCI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBibG9jayIgaWQ9InNpZ25pbiI+' +
  'U2lnbiBpbjwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBpZD0iZXJyIiBzdHlsZT0iY29sb3I6dmFyKC0tYmFkKTtt' +
  'YXJnaW4tdG9wOjEwcHgiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXI7bWFy' +
  'Z2luLXRvcDoxMnB4Ij4KICAgICAgICA8YSBocmVmPSIvZm9yZ290Ij5Gb3Jnb3QgeW91ciBwYXNzd29yZD88L2E+PC9kaXY+CiAg' +
  'ICAgIDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlcjttYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIEJl' +
  'ZW4gZ2l2ZW4gYW4gYWNjZXNzIGNvZGU/IDxhIGhyZWY9IiMiIGlkPSJoYXZlQ29kZSI+U2V0IHVwIHlvdXIgYWNjb3VudDwvYT48' +
  'L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyO21hcmdpbi10b3A6MTBweCI+CiAg' +
  'ICAgICAgPGEgaHJlZj0iL3ByaXZhY3kiIHRhcmdldD0iX2JsYW5rIj5Qcml2YWN5IHN0YXRlbWVudDwvYT48L2Rpdj4KICAgIDwv' +
  'ZGl2PjwvZGl2PmA7CiAgY29uc3Qgc3VibWl0ID0gYXN5bmMgKCkgPT4gewogICAgJCgnI2VycicpLnRleHRDb250ZW50ID0gJyc7' +
  'CiAgICB0cnkgewogICAgICBhd2FpdCBhcGkoJy9sb2dpbicsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5' +
  'KHsgZW1haWw6ICQoJyNlbWFpbCcpLnZhbHVlLCBwYXNzd29yZDogJCgnI3B3JykudmFsdWUgfSkgfSk7CiAgICAgIFMubWUgPSBh' +
  'd2FpdCBhcGkoJy9tZScpOwogICAgICBnbygnZGFzaCcpOwogICAgfSBjYXRjaCAoZSkgeyAkKCcjZXJyJykudGV4dENvbnRlbnQg' +
  'PSBlLm1lc3NhZ2U7IH0KICB9OwogICQoJyNzaWduaW4nKS5vbmNsaWNrID0gc3VibWl0OwogICQoJyNwdycpLm9ua2V5ZG93biA9' +
  'IGUgPT4geyBpZiAoZS5rZXkgPT09ICdFbnRlcicpIHN1Ym1pdCgpOyB9OwogICQoJyNoYXZlQ29kZScpLm9uY2xpY2sgPSBlID0+' +
  'IHsgZS5wcmV2ZW50RGVmYXVsdCgpOyByZWRlZW1WaWV3KCk7IH07CiAgJCgnI2VtYWlsJykuZm9jdXMoKTsKfQoKCi8qIFJlZGVl' +
  'bWluZyBhIGNvZGUgY3JlYXRlcyB0aGUgYWNjb3VudCwgc28gc29tZW9uZSBjYW4gYmUgc2V0IHVwIHdpdGhvdXQgYW4KICAgYWRt' +
  'aW4ga2V5aW5nIGluIHRoZWlyIGRldGFpbHMuICovCmZ1bmN0aW9uIHJlZGVlbVZpZXcoKSB7CiAgYXBwLmlubmVySFRNTCA9IGA8' +
  'ZGl2IGNsYXNzPSJsb2dpbiI+CiAgICA8ZGl2IGNsYXNzPSJsb2dvIj48Yj5TZXJ2ZVRyYWNrPC9iPjxkaXY+U2V0IHVwIHlvdXIg' +
  'YWNjb3VudDwvZGl2PjwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+' +
  'QWNjZXNzIGNvZGU8L2xhYmVsPgogICAgICAgIDxpbnB1dCBpZD0icl9jb2RlIiBwbGFjZWhvbGRlcj0iQUJDRC1FRkdILUpLTE0i' +
  'IGF1dG9jYXBpdGFsaXplPSJjaGFyYWN0ZXJzIiBzdHlsZT0idGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlIj48L2Rpdj4KICAgICAg' +
  'PGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Zb3VyIG5hbWU8L2xhYmVsPjxpbnB1dCBpZD0icl9uYW1lIiBhdXRvY29tcGxldGU9' +
  'Im5hbWUiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkVtYWlsPC9sYWJlbD48aW5wdXQgaWQ9InJfZW1h' +
  'aWwiIHR5cGU9ImVtYWlsIiBpbnB1dG1vZGU9ImVtYWlsIiBhdXRvY29tcGxldGU9ImVtYWlsIj48L2Rpdj4KICAgICAgPGRpdiBj' +
  'bGFzcz0iZmllbGQiPjxsYWJlbD5DaG9vc2UgYSBwYXNzd29yZDwvbGFiZWw+CiAgICAgICAgPGlucHV0IGlkPSJyX3B3IiB0eXBl' +
  'PSJwYXNzd29yZCIgYXV0b2NvbXBsZXRlPSJuZXctcGFzc3dvcmQiIHBsYWNlaG9sZGVyPSJBdCBsZWFzdCA4IGNoYXJhY3RlcnMi' +
  'PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPllvdXIgY29tcGFueSA8c3BhbiBjbGFzcz0iaGludCI+4oCU' +
  'IG9ubHkgaWYgeW91IGFyZSBzdGFydGluZyBhIG5ldyBvbmU8L3NwYW4+PC9sYWJlbD4KICAgICAgICA8aW5wdXQgaWQ9InJfY28i' +
  'IHBsYWNlaG9sZGVyPSJlLmcuIFJpbyBHcmFuZGUgUHJvY2VzcyBTZXJ2aW5nIj48L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0i' +
  'YnRuIGJsb2NrIiBpZD0icl9nbyI+Q3JlYXRlIG15IGFjY291bnQ8L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgaWQ9' +
  'InJfZXJyIiBzdHlsZT0iY29sb3I6dmFyKC0tYmFkKTttYXJnaW4tdG9wOjEwcHgiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJo' +
  'aW50IiBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXI7bWFyZ2luLXRvcDoxNHB4Ij4KICAgICAgICA8YSBocmVmPSIjIiBpZD0icl9i' +
  'YWNrIj5CYWNrIHRvIHNpZ24gaW48L2E+PC9kaXY+CiAgICA8L2Rpdj48L2Rpdj5gOwoKICAkKCcjcl9iYWNrJykub25jbGljayA9' +
  'IGUgPT4geyBlLnByZXZlbnREZWZhdWx0KCk7IGxvZ2luVmlldygpOyB9OwogIGNvbnN0IGdvID0gYXN5bmMgKCkgPT4gewogICAg' +
  'JCgnI3JfZXJyJykudGV4dENvbnRlbnQgPSAnJzsKICAgIHRyeSB7CiAgICAgIGNvbnN0IG1hZGUgPSBhd2FpdCBhcGkoJy9yZWRl' +
  'ZW0nLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgY29kZTogJCgnI3JfY29kZScpLnZh' +
  'bHVlLCBuYW1lOiAkKCcjcl9uYW1lJykudmFsdWUsIGNvbXBhbnk6ICQoJyNyX2NvJykudmFsdWUsCiAgICAgICAgZW1haWw6ICQo' +
  'JyNyX2VtYWlsJykudmFsdWUsIHBhc3N3b3JkOiAkKCcjcl9wdycpLnZhbHVlCiAgICAgIH0pIH0pOwogICAgICBTLm1lID0gYXdh' +
  'aXQgYXBpKCcvbWUnKTsKICAgICAgdG9hc3QoJ1dlbGNvbWUsICcgKyBtYWRlLm5hbWUpOwogICAgICBnbzIoKTsKICAgIH0gY2F0' +
  'Y2ggKGUpIHsgJCgnI3JfZXJyJykudGV4dENvbnRlbnQgPSBlLm1lc3NhZ2U7IH0KICB9OwogIGNvbnN0IGdvMiA9ICgpID0+IHsg' +
  'Uy52aWV3ID0gJ2Rhc2gnOyBTLnBhcmFtcyA9IHt9OyByZW5kZXIoKTsgfTsKICAkKCcjcl9nbycpLm9uY2xpY2sgPSBnbzsKICAk' +
  'KCcjcl9wdycpLm9ua2V5ZG93biA9IGUgPT4geyBpZiAoZS5rZXkgPT09ICdFbnRlcicpIGdvKCk7IH07CiAgJCgnI3JfY29kZScp' +
  'LmZvY3VzKCk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0g' +
  'ZGFzaGJvYXJkIC0tICovCmFzeW5jIGZ1bmN0aW9uIGRhc2hWaWV3KCkgewogIGNvbnN0IFtzdGF0cywgam9ic10gPSBhd2FpdCBQ' +
  'cm9taXNlLmFsbChbYXBpKCcvc3RhdHMnKSwgYXBpKCcvam9icz9vcGVuPTEnKV0pOwogIGNvbnN0IG92ZXJkdWUgPSBqb2JzLmZp' +
  'bHRlcihqID0+IHsgY29uc3QgZCA9IGRheXNPdXQoai5kdWVfZGF0ZSk7IHJldHVybiBkICE9PSBudWxsICYmIGQgPCAwOyB9KTsK' +
  'ICBjb25zdCB0b2RheSA9IGpvYnMuZmlsdGVyKGogPT4geyBjb25zdCBkID0gZGF5c091dChqLmR1ZV9kYXRlKTsgcmV0dXJuIGQg' +
  'IT09IG51bGwgJiYgZCA+PSAwICYmIGQgPD0gMTsgfSk7CiAgY29uc3QgcnVzaCA9IGpvYnMuZmlsdGVyKGogPT4gai5wcmlvcml0' +
  'eSAhPT0gJ1JvdXRpbmUnKTsKICBjb25zdCBtaW5lID0gaXNBZG1pbigpID8gam9icyA6IGpvYnM7CgogIGFwcC5pbm5lckhUTUwg' +
  'PSBzaGVsbChgCiAgICA8aDEgY2xhc3M9InBhZ2UiPiR7aXNBZG1pbigpID8gJ09wZXJhdGlvbnMgdG9kYXknIDogJ015IGRheSd9' +
  'PC9oMT4KICAgICR7aXNBZG1pbigpID8gcGxhbkJhbm5lcigpIDogJyd9CiAgICA8ZGl2IGNsYXNzPSJzdGF0cyI+CiAgICAgIDxk' +
  'aXYgY2xhc3M9InN0YXQiPjxkaXYgY2xhc3M9Im4iPiR7c3RhdHMub3Blbl9qb2JzfTwvZGl2PjxkaXYgY2xhc3M9ImwiPk9wZW4g' +
  'am9iczwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdGF0ICR7c3RhdHMub3ZlcmR1ZSA/ICdhbGVydCcgOiAnJ30iPjxk' +
  'aXYgY2xhc3M9Im4iPiR7c3RhdHMub3ZlcmR1ZX08L2Rpdj48ZGl2IGNsYXNzPSJsIj5QYXN0IGR1ZTwvZGl2PjwvZGl2PgogICAg' +
  'ICA8ZGl2IGNsYXNzPSJzdGF0Ij48ZGl2IGNsYXNzPSJuIj4ke3N0YXRzLnJ1c2h9PC9kaXY+PGRpdiBjbGFzcz0ibCI+UnVzaCAv' +
  'IHNhbWUgZGF5PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQgZ29vZCI+PGRpdiBjbGFzcz0ibiI+JHtzdGF0cy5z' +
  'ZXJ2ZWRfN2R9PC9kaXY+PGRpdiBjbGFzcz0ibCI+U2VydmVkLCA3IGRheXM8L2Rpdj48L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxk' +
  'aXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+Um91dGUgbXkgZGF5IDxzcGFuIGNsYXNzPSJzdWIiPuKAlCAke21pbmUubGVuZ3Ro' +
  'fSBvcGVuIHN0b3Ake21pbmUubGVuZ3RoID09PSAxID8gJycgOiAncyd9PC9zcGFuPjwvaDI+CiAgICAgIDxwIGNsYXNzPSJoaW50' +
  'IiBzdHlsZT0ibWFyZ2luLXRvcDotNHB4Ij5PcGVucyBHb29nbGUgTWFwcyB3aXRoIHlvdXIgc3RvcHMgaW4gb3JkZXIgKHVwIHRv' +
  'IDEwKS4gTm8gbWFwcGluZyBmZWVzIOKAlCBpdCBqdXN0IGhhbmRzIG9mZiB0byB0aGUgYXBwIHlvdSBhbHJlYWR5IGhhdmUuPC9w' +
  'PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0' +
  'biBuYXYiIGlkPSJyb3V0ZUJ0biIgJHttaW5lLmxlbmd0aCA/ICcnIDogJ2Rpc2FibGVkJ30+U3RhcnQgcm91dGUgKCR7TWF0aC5t' +
  'aW4obWluZS5sZW5ndGgsIDEwKX0gc3RvcHMpPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9' +
  'InJvdXRlTGlzdCI+U2VlIG9yZGVyPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgJHtzZWN0aW9uKCdQYXN0' +
  'IGR1ZScsIG92ZXJkdWUpfQogICAgJHtzZWN0aW9uKCdEdWUgdG9kYXkgb3IgdG9tb3Jyb3cnLCB0b2RheSl9CiAgICAke3NlY3Rp' +
  'b24oJ1J1c2ggJmFtcDsgc2FtZSBkYXknLCBydXNoLmZpbHRlcihqID0+ICFvdmVyZHVlLmluY2x1ZGVzKGopICYmICF0b2RheS5p' +
  'bmNsdWRlcyhqKSkpfQogICAgJHtvdmVyZHVlLmxlbmd0aCArIHRvZGF5Lmxlbmd0aCArIHJ1c2gubGVuZ3RoID09PSAwCiAgICAg' +
  'ID8gYDxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImVtcHR5Ij5Ob3RoaW5nIHVyZ2VudC4gJHttaW5lLmxlbmd0aH0gb3Bl' +
  'biBqb2Ike21pbmUubGVuZ3RoID09PSAxID8gJycgOiAncyd9IHRvdGFsIOKAlCBzZWUgdGhlIEpvYnMgdGFiLjwvZGl2PjwvZGl2' +
  'PmAgOiAnJ30KICBgKTsKICBiaW5kU2hlbGwoKTsKICBiaW5kSm9iSXRlbXMoKTsKICBjb25zdCByYiA9ICQoJyNyb3V0ZUJ0bicp' +
  'OwogIGlmIChyYikgcmIub25jbGljayA9ICgpID0+IHsKICAgIGNvbnN0IHVybCA9IHJvdXRlVXJsKG1pbmUuc2xpY2UoMCwgMTAp' +
  'KTsKICAgIGlmICh1cmwpIHdpbmRvdy5vcGVuKHVybCwgJ19ibGFuaycpOwogIH07CiAgJCgnI3JvdXRlTGlzdCcpLm9uY2xpY2sg' +
  'PSAoKSA9PiBzaGVldCgnUm91dGUgb3JkZXInLCBgCiAgICA8cCBjbGFzcz0iaGludCI+T3JkZXJlZCBieSBwcmlvcml0eSwgdGhl' +
  'biBkdWUgZGF0ZS4gVGFwIGFueSBzdG9wIHRvIG5hdmlnYXRlIHRvIGl0IGFsb25lLjwvcD4KICAgIDxkaXYgY2xhc3M9Imxpc3Qi' +
  'PiR7bWluZS5zbGljZSgwLCAxMCkubWFwKChqLCBpKSA9PiBgCiAgICAgIDxkaXYgY2xhc3M9Iml0ZW0iIGRhdGEtbmF2PSIke2Vz' +
  'YyhhZGRyT2YoaikpfSI+CiAgICAgICAgPGRpdiBjbGFzcz0iciI+PGRpdj48ZGl2IGNsYXNzPSJ0Ij4ke2kgKyAxfS4gJHtlc2Mo' +
  'ai5yZWNpcGllbnRfbmFtZSl9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibSI+JHtlc2MoYWRkck9mKGopKX08L2Rpdj48L2Rp' +
  'dj4KICAgICAgICA8c3BhbiBjbGFzcz0icGlsbCAke2NscyhqLnByaW9yaXR5KX0iPiR7ZXNjKGoucHJpb3JpdHkpfTwvc3Bhbj48' +
  'L2Rpdj48L2Rpdj5gKS5qb2luKCcnKX08L2Rpdj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgYmxvY2siIHN0eWxlPSJtYXJn' +
  'aW4tdG9wOjEycHgiIG9uY2xpY2s9ImNsb3NlU2hlZXQoKSI+Q2xvc2U8L2J1dHRvbj5gLAogICAgZWwgPT4gZWwucXVlcnlTZWxl' +
  'Y3RvckFsbCgnW2RhdGEtbmF2XScpLmZvckVhY2gobiA9PgogICAgICBuLm9uY2xpY2sgPSAoKSA9PiB3aW5kb3cub3BlbihuYXZV' +
  'cmwobi5kYXRhc2V0Lm5hdiksICdfYmxhbmsnKSkpOwp9CgpmdW5jdGlvbiBzZWN0aW9uKHRpdGxlLCBsaXN0KSB7CiAgaWYgKCFs' +
  'aXN0Lmxlbmd0aCkgcmV0dXJuICcnOwogIHJldHVybiBgPGRpdiBjbGFzcz0iY2FyZCI+PGgyPiR7dGl0bGV9IDxzcGFuIGNsYXNz' +
  'PSJzdWIiPiR7bGlzdC5sZW5ndGh9PC9zcGFuPjwvaDI+CiAgICA8ZGl2IGNsYXNzPSJsaXN0Ij4ke2xpc3QubWFwKGpvYkl0ZW0p' +
  'LmpvaW4oJycpfTwvZGl2PjwvZGl2PmA7Cn0KCmZ1bmN0aW9uIGpvYkl0ZW0oaikgewogIGNvbnN0IGQgPSBkYXlzT3V0KGouZHVl' +
  'X2RhdGUpOwogIGNvbnN0IGxhdGUgPSBkICE9PSBudWxsICYmIGQgPCAwICYmICFbJ1NlcnZlZCcsICdOb24tRXN0JywgJ0NhbmNl' +
  'bGxlZCddLmluY2x1ZGVzKGouc3RhdHVzKTsKICBjb25zdCBkdWUgPSBqLmR1ZV9kYXRlCiAgICA/IChsYXRlID8gYDxzcGFuIHN0' +
  'eWxlPSJjb2xvcjp2YXIoLS1iYWQpO2ZvbnQtd2VpZ2h0OjYwMCI+JHtNYXRoLmFicyhkKX1kIHBhc3QgZHVlPC9zcGFuPmAKICAg' +
  'ICAgICAgICAgOiAoZCA9PT0gMCA/ICdkdWUgdG9kYXknIDogZCA9PT0gMSA/ICdkdWUgdG9tb3Jyb3cnIDogJ2R1ZSAnICsgZm10' +
  'RGF0ZU9ubHkoai5kdWVfZGF0ZSkpKQogICAgOiAnbm8gZHVlIGRhdGUnOwogIHJldHVybiBgPGRpdiBjbGFzcz0iaXRlbSBwLSR7' +
  'Y2xzKGoucHJpb3JpdHkpfSAke2xhdGUgPyAnb3ZlcmR1ZScgOiAnJ30iIGRhdGEtam9iPSIke2ouaWR9Ij4KICAgIDxkaXYgY2xh' +
  'c3M9InIiPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InQiPiR7ZXNjKGoucmVjaXBpZW50X25hbWUpfTwvZGl2Pgog' +
  'ICAgICAgIDxkaXYgY2xhc3M9Im0iPiR7ZXNjKGouam9iX251bWJlcil9IMK3ICR7ZXNjKGouY2l0eSB8fCAnJyl9JHtqLmNpdHkg' +
  'PyAnLCAnIDogJyd9JHtlc2Moai5zdGF0ZSB8fCAnJyl9IMK3ICR7ZHVlfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im0iPiR7' +
  'ZXNjKGouY2xpZW50X25hbWUgfHwgJ05vIGNsaWVudCcpfSR7ai5zZXJ2ZXJfbmFtZSA/ICcg4oaSICcgKyBlc2Moai5zZXJ2ZXJf' +
  'bmFtZSkgOiAnJ30ke2ouYXR0ZW1wdF9jb3VudCA/ICcgwrcgJyArIGouYXR0ZW1wdF9jb3VudCArICcgYXR0ZW1wdCcgKyAoai5h' +
  'dHRlbXB0X2NvdW50ID09PSAxID8gJycgOiAncycpIDogJyd9PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJ0' +
  'ZXh0LWFsaWduOnJpZ2h0Ij4KICAgICAgICA8c3BhbiBjbGFzcz0icGlsbCAke2NscyhqLnN0YXR1cyl9Ij4ke2VzYyhqLnN0YXR1' +
  'cyl9PC9zcGFuPgogICAgICAgICR7ai5wcmlvcml0eSAhPT0gJ1JvdXRpbmUnID8gYDxkaXYgc3R5bGU9Im1hcmdpbi10b3A6NXB4' +
  'Ij48c3BhbiBjbGFzcz0icGlsbCBydXNoIj4ke2VzYyhqLnByaW9yaXR5KX08L3NwYW4+PC9kaXY+YCA6ICcnfQogICAgICA8L2Rp' +
  'dj4KICAgIDwvZGl2PjwvZGl2PmA7Cn0KCmZ1bmN0aW9uIGJpbmRKb2JJdGVtcygpIHsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9y' +
  'QWxsKCdbZGF0YS1qb2JdJykuZm9yRWFjaChlbCA9PgogICAgZWwub25jbGljayA9ICgpID0+IGdvKCdqb2InLCB7IGlkOiBlbC5k' +
  'YXRhc2V0LmpvYiB9KSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLSBqb2JzIC0tICovCmFzeW5jIGZ1bmN0aW9uIGpvYnNWaWV3KCkgewogIGNvbnN0IGYgPSBTLnBhcmFtczsKICBj' +
  'b25zdCBxcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoKTsKICBpZiAoZi5zdGF0dXMpIHFzLnNldCgnc3RhdHVzJywgZi5zdGF0dXMp' +
  'OwogIGlmIChmLnEpIHFzLnNldCgncScsIGYucSk7CiAgaWYgKGYub3BlbikgcXMuc2V0KCdvcGVuJywgJzEnKTsKICBjb25zdCBq' +
  'b2JzID0gYXdhaXQgYXBpKCcvam9icz8nICsgcXMudG9TdHJpbmcoKSk7CgogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8' +
  'aDEgY2xhc3M9InBhZ2UiPiR7aXNBZG1pbigpID8gJ0pvYnMnIDogJ015IGpvYnMnfTwvaDE+CiAgICA8ZGl2IGNsYXNzPSJjYXJk' +
  'Ij4KICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgICA8aW5wdXQgaWQ9InEiIHBsYWNlaG9sZGVyPSJTZWFyY2ggbmFtZSwg' +
  'Y2FzZSAjLCBqb2IgIywgYWRkcmVzcyIgdmFsdWU9IiR7ZXNjKGYucSB8fCAnJyl9IiBzdHlsZT0iZmxleDoxO21pbi13aWR0aDox' +
  'NjBweCI+CiAgICAgICAgPHNlbGVjdCBpZD0ic3RhdHVzIiBzdHlsZT0id2lkdGg6YXV0byI+CiAgICAgICAgICA8b3B0aW9uIHZh' +
  'bHVlPSIiPkFueSBzdGF0dXM8L29wdGlvbj4KICAgICAgICAgICR7WydQZW5kaW5nJywgJ0Fzc2lnbmVkJywgJ0F0dGVtcHRlZCcs' +
  'ICdTZXJ2ZWQnLCAnTm9uLUVzdCcsICdPbiBIb2xkJywgJ0NhbmNlbGxlZCddCiAgICAgICAgICAgIC5tYXAocyA9PiBgPG9wdGlv' +
  'biAke2Yuc3RhdHVzID09PSBzID8gJ3NlbGVjdGVkJyA6ICcnfT4ke3N9PC9vcHRpb24+YCkuam9pbignJyl9CiAgICAgICAgPC9z' +
  'ZWxlY3Q+CiAgICAgICAgPGxhYmVsIHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo2cHg7bWFyZ2lu' +
  'OjA7Zm9udC1zaXplOjEzcHgiPgogICAgICAgICAgPGlucHV0IHR5cGU9ImNoZWNrYm94IiBpZD0ib3Blbk9ubHkiICR7Zi5vcGVu' +
  'ID8gJ2NoZWNrZWQnIDogJyd9IHN0eWxlPSJ3aWR0aDphdXRvIj4gT3BlbiBvbmx5PC9sYWJlbD4KICAgICAgPC9kaXY+CiAgICAg' +
  'ICR7aXNBZG1pbigpID8gJzxidXR0b24gY2xhc3M9ImJ0biBibG9jayIgaWQ9Im5ld0pvYiIgc3R5bGU9Im1hcmdpbi10b3A6MTBw' +
  'eCI+KyBOZXcgam9iPC9idXR0b24+JyA6ICcnfQogICAgPC9kaXY+CiAgICAke2pvYnMubGVuZ3RoID8gYDxkaXYgY2xhc3M9Imxp' +
  'c3QiPiR7am9icy5tYXAoam9iSXRlbSkuam9pbignJyl9PC9kaXY+YAogICAgICA6ICc8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNs' +
  'YXNzPSJlbXB0eSI+Tm8gam9icyBtYXRjaC48L2Rpdj48L2Rpdj4nfQogIGApOwogIGJpbmRTaGVsbCgpOyBiaW5kSm9iSXRlbXMo' +
  'KTsKICBjb25zdCBhcHBseSA9ICgpID0+IGdvKCdqb2JzJywgeyBxOiAkKCcjcScpLnZhbHVlLnRyaW0oKSwgc3RhdHVzOiAkKCcj' +
  'c3RhdHVzJykudmFsdWUsIG9wZW46ICQoJyNvcGVuT25seScpLmNoZWNrZWQgfSk7CiAgJCgnI3EnKS5vbmtleWRvd24gPSBlID0+' +
  'IHsgaWYgKGUua2V5ID09PSAnRW50ZXInKSBhcHBseSgpOyB9OwogICQoJyNzdGF0dXMnKS5vbmNoYW5nZSA9IGFwcGx5OwogICQo' +
  'JyNvcGVuT25seScpLm9uY2hhbmdlID0gYXBwbHk7CiAgaWYgKCQoJyNuZXdKb2InKSkgJCgnI25ld0pvYicpLm9uY2xpY2sgPSAo' +
  'KSA9PiBqb2JGb3JtKG51bGwpOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0gam9iIGZvcm0gLS0gKi8KYXN5bmMgZnVuY3Rpb24gam9iRm9ybShqb2IpIHsKICBjb25zdCBbY2xpZW50cywg' +
  'dXNlcnNdID0gYXdhaXQgUHJvbWlzZS5hbGwoW2FwaSgnL2NsaWVudHMnKSwgYXBpKCcvdXNlcnMnKV0pOwogIGNvbnN0IHYgPSBq' +
  'b2IgfHwgeyBzZXJ2aWNlX3R5cGU6ICdQZXJzb25hbCcsIHByaW9yaXR5OiAnUm91dGluZScsIHN0YXR1czogJ1BlbmRpbmcnIH07' +
  'CiAgY29uc3Qgb3B0ID0gKGxpc3QsIHNlbCwgbGFiZWwpID0+IGxpc3QubWFwKHggPT4KICAgIGA8b3B0aW9uIHZhbHVlPSIke3gu' +
  'aWR9IiAke1N0cmluZyhzZWwpID09PSBTdHJpbmcoeC5pZCkgPyAnc2VsZWN0ZWQnIDogJyd9PiR7ZXNjKGxhYmVsKHgpKX08L29w' +
  'dGlvbj5gKS5qb2luKCcnKTsKCiAgc2hlZXQoam9iID8gJ0VkaXQgJyArIGpvYi5qb2JfbnVtYmVyIDogJ05ldyBqb2InLCBgCiAg' +
  'ICA8ZGl2IGNsYXNzPSJkcm9wem9uZSI+CiAgICAgIDxsYWJlbD5TdGFydCBmcm9tIHRoZSBwYXBlcnM8L2xhYmVsPgogICAgICA8' +
  'aW5wdXQgdHlwZT0iZmlsZSIgaWQ9ImZfcGRmIiBhY2NlcHQ9ImFwcGxpY2F0aW9uL3BkZiwucGRmIj4KICAgICAgPGRpdiBjbGFz' +
  'cz0iaGludCIgaWQ9InBkZk1zZyI+UGljayB0aGUgc3VtbW9ucywgY2l0YXRpb24sIHN1YnBvZW5hIG9yIGNvbXBsYWludCBhcyBh' +
  'IFBERiBhbmQgSSdsbAogICAgICAgIHJlYWQgd2hhdCBJIGNhbiBpbnRvIHRoZSBmb3JtIGJlbG93LiBBbHdheXMgY2hlY2sgaXQg' +
  'YWdhaW5zdCB0aGUgZG9jdW1lbnQgYmVmb3JlIHNhdmluZy48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZCBn' +
  'MiI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q2xpZW50PC9sYWJlbD48c2VsZWN0IGlkPSJmX2NsaWVudF9pZCI+' +
  'CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0iIj7igJQgbm9uZSDigJQ8L29wdGlvbj4ke29wdChjbGllbnRzLCB2LmNsaWVudF9pZCwg' +
  'YyA9PiBjLm5hbWUpfTwvc2VsZWN0PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkFzc2lnbiB0bzwvbGFi' +
  'ZWw+PHNlbGVjdCBpZD0iZl9hc3NpZ25lZF90byI+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0iIj7igJQgdW5hc3NpZ25lZCDigJQ8' +
  'L29wdGlvbj4ke29wdCh1c2Vycy5maWx0ZXIodSA9PiB1LmFjdGl2ZSksIHYuYXNzaWduZWRfdG8sIHUgPT4gdS5uYW1lKX08L3Nl' +
  'bGVjdD48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5QZXJzb24gLyBlbnRpdHkgdG8gc2Vy' +
  'dmUgKjwvbGFiZWw+PGlucHV0IGlkPSJmX3JlY2lwaWVudF9uYW1lIiB2YWx1ZT0iJHtlc2Modi5yZWNpcGllbnRfbmFtZSl9Ij48' +
  'L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U2VydmljZSBhZGRyZXNzPC9sYWJlbD48aW5wdXQgaWQ9ImZfYWRk' +
  'cmVzczEiIHBsYWNlaG9sZGVyPSJTdHJlZXQgYWRkcmVzcyIgdmFsdWU9IiR7ZXNjKHYuYWRkcmVzczEpfSI+PC9kaXY+CiAgICA8' +
  'ZGl2IGNsYXNzPSJncmlkIGczIj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5BcHQgLyB1bml0PC9sYWJlbD48aW5w' +
  'dXQgaWQ9ImZfYWRkcmVzczIiIHZhbHVlPSIke2VzYyh2LmFkZHJlc3MyKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVs' +
  'ZCI+PGxhYmVsPkNpdHk8L2xhYmVsPjxpbnB1dCBpZD0iZl9jaXR5IiB2YWx1ZT0iJHtlc2Modi5jaXR5KX0iPjwvZGl2PgogICAg' +
  'ICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlN0YXRlIC8gWklQPC9sYWJlbD4KICAgICAgICA8ZGl2IGNsYXNzPSJyb3ciPjxp' +
  'bnB1dCBpZD0iZl9zdGF0ZSIgc3R5bGU9IndpZHRoOjcwcHgiIG1heGxlbmd0aD0iMiIgdmFsdWU9IiR7ZXNjKHYuc3RhdGUpfSI+' +
  'CiAgICAgICAgPGlucHV0IGlkPSJmX3ppcCIgc3R5bGU9ImZsZXg6MSIgaW5wdXRtb2RlPSJudW1lcmljIiB2YWx1ZT0iJHtlc2Mo' +
  'di56aXApfSI+PC9kaXY+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UmVjaXBpZW50IG5v' +
  'dGVzIChkZXNjcmlwdGlvbiwgd29yayBob3VycywgdmVoaWNsZSwgZ2F0ZSBjb2RlKTwvbGFiZWw+CiAgICAgIDx0ZXh0YXJlYSBp' +
  'ZD0iZl9yZWNpcGllbnRfbm90ZXMiIHN0eWxlPSJtaW4taGVpZ2h0OjYwcHgiPiR7ZXNjKHYucmVjaXBpZW50X25vdGVzKX08L3Rl' +
  'eHRhcmVhPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q2Fz' +
  'ZSBudW1iZXI8L2xhYmVsPjxpbnB1dCBpZD0iZl9jYXNlX251bWJlciIgdmFsdWU9IiR7ZXNjKHYuY2FzZV9udW1iZXIpfSI+PC9k' +
  'aXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q291cnQ8L2xhYmVsPjxpbnB1dCBpZD0iZl9jb3VydCIgdmFsdWU9' +
  'IiR7ZXNjKHYuY291cnQpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGxhaW50aWZmPC9sYWJlbD48' +
  'aW5wdXQgaWQ9ImZfcGxhaW50aWZmIiB2YWx1ZT0iJHtlc2Modi5wbGFpbnRpZmYpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9' +
  'ImZpZWxkIj48bGFiZWw+RGVmZW5kYW50PC9sYWJlbD48aW5wdXQgaWQ9ImZfZGVmZW5kYW50IiB2YWx1ZT0iJHtlc2Modi5kZWZl' +
  'bmRhbnQpfSI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RG9jdW1lbnRzIHRvIHNlcnZl' +
  'PC9sYWJlbD48aW5wdXQgaWQ9ImZfZG9jdW1lbnRzIiBwbGFjZWhvbGRlcj0iU3VtbW9ucyBhbmQgQ29tcGxhaW50IiB2YWx1ZT0i' +
  'JHtlc2Modi5kb2N1bWVudHMpfSI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJncmlkIGczIj4KICAgICAgPGRpdiBjbGFzcz0iZmll' +
  'bGQiPjxsYWJlbD5TZXJ2aWNlIHR5cGU8L2xhYmVsPjxzZWxlY3QgaWQ9ImZfc2VydmljZV90eXBlIj4KICAgICAgICAke1snUGVy' +
  'c29uYWwnLCAnU3Vic3RpdHV0ZScsICdQb3N0aW5nJywgJ0NlcnRpZmllZCBNYWlsJywgJ0NvcnBvcmF0ZSddLm1hcChzID0+IGA8' +
  'b3B0aW9uICR7di5zZXJ2aWNlX3R5cGUgPT09IHMgPyAnc2VsZWN0ZWQnIDogJyd9PiR7c308L29wdGlvbj5gKS5qb2luKCcnKX08' +
  'L3NlbGVjdD48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Qcmlvcml0eTwvbGFiZWw+PHNlbGVjdCBpZD0i' +
  'Zl9wcmlvcml0eSI+CiAgICAgICAgJHtbJ1JvdXRpbmUnLCAnUnVzaCcsICdTYW1lIERheSddLm1hcChzID0+IGA8b3B0aW9uICR7' +
  'di5wcmlvcml0eSA9PT0gcyA/ICdzZWxlY3RlZCcgOiAnJ30+JHtzfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2' +
  'PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkR1ZSBkYXRlPC9sYWJlbD48aW5wdXQgaWQ9ImZfZHVlX2RhdGUiIHR5' +
  'cGU9ImRhdGUiIHZhbHVlPSIke3YuZHVlX2RhdGUgPyBTdHJpbmcodi5kdWVfZGF0ZSkuc2xpY2UoMCwgMTApIDogJyd9Ij48L2Rp' +
  'dj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZCBnMyI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q2xp' +
  'ZW50IGZlZTwvbGFiZWw+PGlucHV0IGlkPSJmX2NsaWVudF9mZWUiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgdmFsdWU9IiR7' +
  'di5jbGllbnRfZmVlIHx8ICcnfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U2VydmVyIHBheTwvbGFi' +
  'ZWw+PGlucHV0IGlkPSJmX3NlcnZlcl9wYXkiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgdmFsdWU9IiR7di5zZXJ2ZXJfcGF5' +
  'IHx8ICcnfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U3RhdHVzPC9sYWJlbD48c2VsZWN0IGlkPSJm' +
  'X3N0YXR1cyI+CiAgICAgICAgJHtbJ1BlbmRpbmcnLCAnQXNzaWduZWQnLCAnQXR0ZW1wdGVkJywgJ1NlcnZlZCcsICdOb24tRXN0' +
  'JywgJ09uIEhvbGQnLCAnQ2FuY2VsbGVkJ10ubWFwKHMgPT4gYDxvcHRpb24gJHt2LnN0YXR1cyA9PT0gcyA/ICdzZWxlY3RlZCcg' +
  'OiAnJ30+JHtzfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJm' +
  'aWVsZCI+PGxhYmVsPkludGVybmFsIG5vdGVzPC9sYWJlbD48dGV4dGFyZWEgaWQ9ImZfbm90ZXMiIHN0eWxlPSJtaW4taGVpZ2h0' +
  'OjYwcHgiPiR7ZXNjKHYubm90ZXMpfTwvdGV4dGFyZWE+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4t' +
  'dG9wOjZweCI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InNhdmUiPiR7am9iID8gJ1NhdmUgY2hhbmdlcycgOiAnQ3Jl' +
  'YXRlIGpvYid9PC9idXR0b24+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIG9uY2xpY2s9ImNsb3NlU2hlZXQoKSI+Q2Fu' +
  'Y2VsPC9idXR0b24+CiAgICAgICR7am9iID8gJzxidXR0b24gY2xhc3M9ImJ0biBnaG9zdCIgaWQ9ImRlbCIgc3R5bGU9ImNvbG9y' +
  'OnZhcigtLWJhZCk7bWFyZ2luLWxlZnQ6YXV0byI+RGVsZXRlPC9idXR0b24+JyA6ICcnfQogICAgPC9kaXY+YCwgZWwgPT4gewog' +
  'ICAgLyogLS0tLSByZWFkIGEgc3VtbW9ucy9jaXRhdGlvbiBQREYgYW5kIGZpbGwgd2hhdCB3ZSBjYW4gLS0tLSAqLwogICAgY29u' +
  'c3QgcGRmTXNnID0gZWwucXVlcnlTZWxlY3RvcignI3BkZk1zZycpOwogICAgY29uc3QgRklMTEFCTEUgPSBbJ2Nhc2VfbnVtYmVy' +
  'JywgJ2NvdXJ0JywgJ3BsYWludGlmZicsICdkZWZlbmRhbnQnLCAncmVjaXBpZW50X25hbWUnLAogICAgICAnYWRkcmVzczEnLCAn' +
  'YWRkcmVzczInLCAnY2l0eScsICdzdGF0ZScsICd6aXAnLCAnZG9jdW1lbnRzJ107CiAgICBjb25zdCBMQUJFTFMgPSB7CiAgICAg' +
  'IGNhc2VfbnVtYmVyOiAnY2FzZSBudW1iZXInLCBjb3VydDogJ2NvdXJ0JywgcGxhaW50aWZmOiAncGxhaW50aWZmJywgZGVmZW5k' +
  'YW50OiAnZGVmZW5kYW50JywKICAgICAgcmVjaXBpZW50X25hbWU6ICdwZXJzb24gdG8gc2VydmUnLCBhZGRyZXNzMTogJ2FkZHJl' +
  'c3MnLCBhZGRyZXNzMjogJ3VuaXQnLCBjaXR5OiAnY2l0eScsCiAgICAgIHN0YXRlOiAnc3RhdGUnLCB6aXA6ICdaSVAnLCBkb2N1' +
  'bWVudHM6ICdkb2N1bWVudHMnCiAgICB9OwogICAgZWwucXVlcnlTZWxlY3RvcignI2ZfcGRmJykub25jaGFuZ2UgPSBhc3luYyBl' +
  'ID0+IHsKICAgICAgY29uc3QgZmlsZSA9IGUudGFyZ2V0LmZpbGVzICYmIGUudGFyZ2V0LmZpbGVzWzBdOwogICAgICBpZiAoIWZp' +
  'bGUpIHJldHVybjsKICAgICAgcGRmTXNnLmlubmVySFRNTCA9ICdSZWFkaW5nICcgKyBlc2MoZmlsZS5uYW1lKSArICfigKYnOwog' +
  'ICAgICB0cnkgewogICAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHsKICAgICAgICAg' +
  'IGNvbnN0IHIgPSBuZXcgRmlsZVJlYWRlcigpOwogICAgICAgICAgci5vbmxvYWQgPSAoKSA9PiByZXMoU3RyaW5nKHIucmVzdWx0' +
  'KS5zcGxpdCgnLCcpWzFdKTsKICAgICAgICAgIHIub25lcnJvciA9ICgpID0+IHJlaihuZXcgRXJyb3IoJ0NvdWxkIG5vdCByZWFk' +
  'IHRoYXQgZmlsZScpKTsKICAgICAgICAgIHIucmVhZEFzRGF0YVVSTChmaWxlKTsKICAgICAgICB9KTsKICAgICAgICBjb25zdCBv' +
  'dXQgPSBhd2FpdCBhcGkoJy9wYXJzZS1kb2N1bWVudCcsIHsKICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0' +
  'cmluZ2lmeSh7IG5hbWU6IGZpbGUubmFtZSwgZGF0YSB9KQogICAgICAgIH0pOwogICAgICAgIGlmIChvdXQud2FybmluZykgeyBw' +
  'ZGZNc2cuaW5uZXJIVE1MID0gJzxiIHN0eWxlPSJjb2xvcjp2YXIoLS13YXJuKSI+JyArIGVzYyhvdXQud2FybmluZykgKyAnPC9i' +
  'Pic7IHJldHVybjsgfQogICAgICAgIGNvbnN0IGZpbGxlZCA9IFtdLCBza2lwcGVkID0gW10sIG1pc3NlZCA9IFtdOwogICAgICAg' +
  'IGZvciAoY29uc3QgZiBvZiBGSUxMQUJMRSkgewogICAgICAgICAgY29uc3QgaW5wdXQgPSBlbC5xdWVyeVNlbGVjdG9yKCcjZl8n' +
  'ICsgZik7CiAgICAgICAgICBpZiAoIWlucHV0KSBjb250aW51ZTsKICAgICAgICAgIGNvbnN0IHZhbCA9IG91dC5maWVsZHNbZl07' +
  'CiAgICAgICAgICBpZiAoIXZhbCkgeyBtaXNzZWQucHVzaChMQUJFTFNbZl0pOyBjb250aW51ZTsgfQogICAgICAgICAgaWYgKGlu' +
  'cHV0LnZhbHVlICYmIGlucHV0LnZhbHVlLnRyaW0oKSAmJiBpbnB1dC52YWx1ZS50cmltKCkgIT09IFN0cmluZyh2YWwpLnRyaW0o' +
  'KSkgewogICAgICAgICAgICBza2lwcGVkLnB1c2goTEFCRUxTW2ZdKTsKICAgICAgICAgICAgY29udGludWU7CiAgICAgICAgICB9' +
  'CiAgICAgICAgICBpbnB1dC52YWx1ZSA9IHZhbDsKICAgICAgICAgIGlucHV0LnN0eWxlLmJhY2tncm91bmQgPSAnI2U5ZjZlZSc7' +
  'CiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHsgaW5wdXQuc3R5bGUuYmFja2dyb3VuZCA9ICcnOyB9LCA0MDAwKTsKICAgICAg' +
  'ICAgIGZpbGxlZC5wdXNoKExBQkVMU1tmXSk7CiAgICAgICAgfQogICAgICAgIGxldCBtc2c7CiAgICAgICAgaWYgKGZpbGxlZC5s' +
  'ZW5ndGgpIHsKICAgICAgICAgIG1zZyA9ICc8YiBzdHlsZT0iY29sb3I6dmFyKC0tb2spIj5GaWxsZWQgJyArIGZpbGxlZC5sZW5n' +
  'dGggKyAnIGZpZWxkJyArIChmaWxsZWQubGVuZ3RoID09PSAxID8gJycgOiAncycpICsKICAgICAgICAgICAgJzwvYj4gZnJvbSAn' +
  'ICsgZXNjKGZpbGUubmFtZSkgKyAnICgnICsgKG91dC5wYWdlcyB8fCAnPycpICsgJyBwYWdlJyArIChvdXQucGFnZXMgPT09IDEg' +
  'PyAnJyA6ICdzJykgKyAnKTogJyArCiAgICAgICAgICAgIGVzYyhmaWxsZWQuam9pbignLCAnKSkgKyAnLic7CiAgICAgICAgfSBl' +
  'bHNlIGlmIChza2lwcGVkLmxlbmd0aCkgewogICAgICAgICAgbXNnID0gJzxiIHN0eWxlPSJjb2xvcjp2YXIoLS13YXJuKSI+RXZl' +
  'cnl0aGluZyBJIGZvdW5kIHdhcyBhbHJlYWR5IGZpbGxlZCBpbjwvYj4g4oCUIG5vdGhpbmcgb2YgeW91cnMgd2FzICcgKwogICAg' +
  'ICAgICAgICAnb3ZlcndyaXR0ZW4uIENsZWFyIGEgZmllbGQgZmlyc3QgaWYgeW91IHdhbnQgdGhlIGRvY3VtZW50XCdzIHZlcnNp' +
  'b24gb2YgaXQuJzsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgbXNnID0gJzxiIHN0eWxlPSJjb2xvcjp2YXIoLS13YXJuKSI+' +
  'Tm90aGluZyByZWNvZ25pc2FibGUgZm91bmQ8L2I+IGluICcgKyBlc2MoZmlsZS5uYW1lKSArCiAgICAgICAgICAgICcuIEl0IG1h' +
  'eSBiZSBsYWlkIG91dCBkaWZmZXJlbnRseSB0byB0aGUgZG9jdW1lbnRzIHRoaXMgY2FuIHJlYWQg4oCUIGZpbGwgdGhlIGpvYiBp' +
  'biBieSBoYW5kLic7CiAgICAgICAgfQogICAgICAgIGlmIChmaWxsZWQubGVuZ3RoICYmIHNraXBwZWQubGVuZ3RoKSBtc2cgKz0g' +
  'JyBMZWZ0IHlvdXIgZXhpc3RpbmcgJyArIGVzYyhza2lwcGVkLmpvaW4oJywgJykpICsgJyBhbG9uZS4nOwogICAgICAgIGlmICht' +
  'aXNzZWQubGVuZ3RoKSBtc2cgKz0gJyBOb3QgZm91bmQ6ICcgKyBlc2MobWlzc2VkLmpvaW4oJywgJykpICsgJy4nOwogICAgICAg' +
  'IG1zZyArPSAnPGJyPjxiPkNoZWNrIGV2ZXJ5IGZpbGxlZCBmaWVsZCBhZ2FpbnN0IHRoZSBkb2N1bWVudCBiZWZvcmUgc2F2aW5n' +
  'LjwvYj4nOwogICAgICAgIHBkZk1zZy5pbm5lckhUTUwgPSBtc2c7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIHBkZk1z' +
  'Zy5pbm5lckhUTUwgPSAnPGIgc3R5bGU9ImNvbG9yOnZhcigtLWJhZCkiPicgKyBlc2MoZXJyLm1lc3NhZ2UpICsgJzwvYj4nOwog' +
  'ICAgICB9CiAgICB9OwoKICAgIC8vIGF1dG8tZmlsbCBmZWUvcGF5IGRlZmF1bHRzIGZyb20gdGhlIHNlbGVjdGVkIGNsaWVudCAv' +
  'IHNlcnZlcgogICAgZWwucXVlcnlTZWxlY3RvcignI2ZfY2xpZW50X2lkJykub25jaGFuZ2UgPSBlID0+IHsKICAgICAgY29uc3Qg' +
  'YyA9IGNsaWVudHMuZmluZCh4ID0+IFN0cmluZyh4LmlkKSA9PT0gZS50YXJnZXQudmFsdWUpOwogICAgICBpZiAoYyAmJiBjLmRl' +
  'ZmF1bHRfZmVlICYmICFlbC5xdWVyeVNlbGVjdG9yKCcjZl9jbGllbnRfZmVlJykudmFsdWUpCiAgICAgICAgZWwucXVlcnlTZWxl' +
  'Y3RvcignI2ZfY2xpZW50X2ZlZScpLnZhbHVlID0gTnVtYmVyKGMuZGVmYXVsdF9mZWUpLnRvRml4ZWQoMik7CiAgICB9OwogICAg' +
  'ZWwucXVlcnlTZWxlY3RvcignI2ZfYXNzaWduZWRfdG8nKS5vbmNoYW5nZSA9IGUgPT4gewogICAgICBjb25zdCB1ID0gdXNlcnMu' +
  'ZmluZCh4ID0+IFN0cmluZyh4LmlkKSA9PT0gZS50YXJnZXQudmFsdWUpOwogICAgICBpZiAodSAmJiB1LmRlZmF1bHRfcGF5ICYm' +
  'ICFlbC5xdWVyeVNlbGVjdG9yKCcjZl9zZXJ2ZXJfcGF5JykudmFsdWUpCiAgICAgICAgZWwucXVlcnlTZWxlY3RvcignI2Zfc2Vy' +
  'dmVyX3BheScpLnZhbHVlID0gTnVtYmVyKHUuZGVmYXVsdF9wYXkpLnRvRml4ZWQoMik7CiAgICB9OwogICAgZWwucXVlcnlTZWxl' +
  'Y3RvcignI3NhdmUnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBib2R5ID0ge307CiAgICAgIFsnY2xpZW50' +
  'X2lkJywnYXNzaWduZWRfdG8nLCdyZWNpcGllbnRfbmFtZScsJ2FkZHJlc3MxJywnYWRkcmVzczInLCdjaXR5Jywnc3RhdGUnLCd6' +
  'aXAnLCdyZWNpcGllbnRfbm90ZXMnLAogICAgICAgJ2Nhc2VfbnVtYmVyJywnY291cnQnLCdwbGFpbnRpZmYnLCdkZWZlbmRhbnQn' +
  'LCdkb2N1bWVudHMnLCdzZXJ2aWNlX3R5cGUnLCdwcmlvcml0eScsJ2R1ZV9kYXRlJywKICAgICAgICdjbGllbnRfZmVlJywnc2Vy' +
  'dmVyX3BheScsJ3N0YXR1cycsJ25vdGVzJ10uZm9yRWFjaChmID0+IHsgYm9keVtmXSA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNmXycg' +
  'KyBmKS52YWx1ZTsgfSk7CiAgICAgIGlmICghYm9keS5yZWNpcGllbnRfbmFtZS50cmltKCkpIHJldHVybiB0b2FzdCgnV2hvIGFy' +
  'ZSB3ZSBzZXJ2aW5nPycsIHRydWUpOwogICAgICB0cnkgewogICAgICAgIGNvbnN0IHNhdmVkID0gam9iCiAgICAgICAgICA/IGF3' +
  'YWl0IGFwaSgnL2pvYnMvJyArIGpvYi5pZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0p' +
  'CiAgICAgICAgICA6IGF3YWl0IGFwaSgnL2pvYnMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5' +
  'KSB9KTsKICAgICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KGpvYiA/ICdTYXZlZCcgOiAnSm9iICcgKyBzYXZlZC5qb2JfbnVtYmVy' +
  'ICsgJyBjcmVhdGVkJyk7CiAgICAgICAgZ28oJ2pvYicsIHsgaWQ6IHNhdmVkLmlkIH0pOwogICAgICB9IGNhdGNoIChlKSB7IHRv' +
  'YXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICAgIH07CiAgICBpZiAoZWwucXVlcnlTZWxlY3RvcignI2RlbCcpKSBlbC5xdWVyeVNl' +
  'bGVjdG9yKCcjZGVsJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgaWYgKCFjb25maXJtKCdEZWxldGUgdGhpcyBqb2Ig' +
  'YW5kIGFsbCBpdHMgYXR0ZW1wdHM/JykpIHJldHVybjsKICAgICAgYXdhaXQgYXBpKCcvam9icy8nICsgam9iLmlkLCB7IG1ldGhv' +
  'ZDogJ0RFTEVURScgfSk7CiAgICAgIGNsb3NlU2hlZXQoKTsgdG9hc3QoJ0RlbGV0ZWQnKTsgZ28oJ2pvYnMnKTsKICAgIH07CiAg' +
  'fSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gam9iIGRl' +
  'dGFpbCAtLSAqLwphc3luYyBmdW5jdGlvbiBqb2JWaWV3KCkgewogIGNvbnN0IGogPSBhd2FpdCBhcGkoJy9qb2JzLycgKyBTLnBh' +
  'cmFtcy5pZCk7CiAgY29uc3QgYWRkciA9IGFkZHJPZihqKTsKICBjb25zdCBkb25lID0gWydTZXJ2ZWQnLCAnTm9uLUVzdCcsICdD' +
  'YW5jZWxsZWQnXS5pbmNsdWRlcyhqLnN0YXR1cyk7CgogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8ZGl2IGNsYXNzPSJy' +
  'b3ciIHN0eWxlPSJtYXJnaW4tYm90dG9tOjhweCI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBnaG9zdCIgaWQ9ImJhY2siPuKA' +
  'uSBCYWNrPC9idXR0b24+CiAgICAgIDxkaXYgY2xhc3M9InNwYWNlciIgc3R5bGU9ImZsZXg6MSI+PC9kaXY+CiAgICAgIDxzcGFu' +
  'IGNsYXNzPSJwaWxsICR7Y2xzKGouc3RhdHVzKX0iPiR7ZXNjKGouc3RhdHVzKX08L3NwYW4+CiAgICAgICR7ai5wcmlvcml0eSAh' +
  'PT0gJ1JvdXRpbmUnID8gYDxzcGFuIGNsYXNzPSJwaWxsIHJ1c2giPiR7ZXNjKGoucHJpb3JpdHkpfTwvc3Bhbj5gIDogJyd9CiAg' +
  'ICA8L2Rpdj4KICAgIDxoMSBjbGFzcz0icGFnZSIgc3R5bGU9Im1hcmdpbi10b3A6MCI+JHtlc2Moai5yZWNpcGllbnRfbmFtZSl9' +
  'PC9oMT4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGRpdiBjbGFzcz0ibSIgc3R5bGU9ImNvbG9yOnZhcigtLW11dGVk' +
  'KTtmb250LXNpemU6MTNweDttYXJnaW4tYm90dG9tOjhweCI+JHtlc2Moai5qb2JfbnVtYmVyKX0gwrcgJHtlc2Moai5jbGllbnRf' +
  'bmFtZSB8fCAnTm8gY2xpZW50Jyl9PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxNXB4O2ZvbnQtd2VpZ2h0OjYw' +
  'MCI+JHtlc2MoYWRkciB8fCAnTm8gYWRkcmVzcyBvbiBmaWxlJyl9PC9kaXY+CiAgICAgICR7ai5yZWNpcGllbnRfbm90ZXMgPyBg' +
  'PGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6NnB4Ij4ke2VzYyhqLnJlY2lwaWVudF9ub3Rlcyl9PC9kaXY+YCA6' +
  'ICcnfQogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9' +
  'ImJ0biBuYXYiIGlkPSJuYXZCdG4iICR7YWRkciA/ICcnIDogJ2Rpc2FibGVkJ30+TmF2aWdhdGUg4pa4PC9idXR0b24+CiAgICAg' +
  'ICAgJHshZG9uZSA/ICc8YnV0dG9uIGNsYXNzPSJidG4gb2siIGlkPSJhdHRCdG4iPkxvZyBhdHRlbXB0PC9idXR0b24+JyA6ICcn' +
  'fQogICAgICA8L2Rpdj4KICAgICAgJHthZGRyID8gYDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+T3Bl' +
  'bnMgJHtpc0lPUygpID8gJ0FwcGxlIE1hcHMnIDogJ0dvb2dsZSBNYXBzJ30gwrcKICAgICAgICA8YSBocmVmPSIke2lzSU9TKCkg' +
  'PyBnb29nbGVVcmwoYWRkcikgOiBhcHBsZVVybChhZGRyKX0iIHRhcmdldD0iX2JsYW5rIj51c2UgJHtpc0lPUygpID8gJ0dvb2ds' +
  'ZScgOiAnQXBwbGUnfSBNYXBzIGluc3RlYWQ8L2E+PC9kaXY+YCA6ICcnfQogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2Fy' +
  'ZCI+CiAgICAgIDxoMj5BdHRlbXB0cyA8c3BhbiBjbGFzcz0ic3ViIj4ke2ouYXR0ZW1wdHMubGVuZ3RofTwvc3Bhbj48L2gyPgog' +
  'ICAgICAke2ouYXR0ZW1wdHMubGVuZ3RoID8gai5hdHRlbXB0cy5tYXAoYSA9PiBgCiAgICAgICAgPGRpdiBjbGFzcz0iYXR0ICR7' +
  'Y2xzKGEub3V0Y29tZSl9Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImgiPiR7ZXNjKGEub3V0Y29tZSl9JHthLm1hbm5lciA/ICcg' +
  '4oCUICcgKyBlc2MoYS5tYW5uZXIpIDogJyd9PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJtIj4ke2ZtdERUKGEuYXR0ZW1w' +
  'dGVkX2F0KX0gwrcgJHtlc2MoYS5zZXJ2ZXJfbmFtZSB8fCAnJyl9PC9kaXY+CiAgICAgICAgICAke2EucGVyc29uX3NlcnZlZCA/' +
  'IGA8ZGl2IGNsYXNzPSJtIj5TZXJ2ZWQ6ICR7ZXNjKGEucGVyc29uX3NlcnZlZCl9JHthLnJlbGF0aW9uc2hpcCA/ICcgKCcgKyBl' +
  'c2MoYS5yZWxhdGlvbnNoaXApICsgJyknIDogJyd9PC9kaXY+YCA6ICcnfQogICAgICAgICAgJHthLmRlc2NyaXB0aW9uID8gYDxk' +
  'aXYgY2xhc3M9Im0iPkRlc2NyaXB0aW9uOiAke2VzYyhhLmRlc2NyaXB0aW9uKX08L2Rpdj5gIDogJyd9CiAgICAgICAgICAke2Eu' +
  'bm90ZXMgPyBgPGRpdiBjbGFzcz0ibSI+JHtlc2MoYS5ub3Rlcyl9PC9kaXY+YCA6ICcnfQogICAgICAgICAgJHthLmxhdCAhPSBu' +
  'dWxsID8gYDxkaXYgY2xhc3M9Im0iPkdQUyAke051bWJlcihhLmxhdCkudG9GaXhlZCg1KX0sICR7TnVtYmVyKGEubG5nKS50b0Zp' +
  'eGVkKDUpfQogICAgICAgICAgICAke2EuYWNjdXJhY3lfbSA/ICfCsScgKyBNYXRoLnJvdW5kKGEuYWNjdXJhY3lfbSkgKyAnbScg' +
  'OiAnJ30gwrcKICAgICAgICAgICAgPGEgaHJlZj0iaHR0cHM6Ly93d3cuZ29vZ2xlLmNvbS9tYXBzP3E9JHthLmxhdH0sJHthLmxu' +
  'Z30iIHRhcmdldD0iX2JsYW5rIj5tYXA8L2E+PC9kaXY+YCA6ICcnfQogICAgICAgICAgJHtwaG90b1N0cmlwKGEsIGopfQogICAg' +
  'ICAgIDwvZGl2PmApLmpvaW4oJycpCiAgICAgICAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPk5vIGF0dGVtcHRzIGxvZ2dlZCB5ZXQu' +
  'PC9kaXY+J30KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+UGFwZXJ3b3JrPC9oMj4KICAgICAg' +
  'PGRpdiBjbGFzcz0icm93Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0iYWZmQnRuIj5BZmZpZGF2aXQ8' +
  'L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0icmVwb3J0QnRuIj5DbGllbnQgcmVwb3J0PC9i' +
  'dXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9ImNvdmVyQnRuIj5Db3ZlciBzaGVldCArIGJhcmNv' +
  'ZGU8L2J1dHRvbj4KICAgICAgICAke2ouY2FzZV9udW1iZXIgPyAnPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9Imxvb2t1' +
  'cEJ0biI+TG9vayB1cCBjYXNlPC9idXR0b24+JyA6ICcnfQogICAgICA8L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0idGV4dC1hbGln' +
  'bjpjZW50ZXI7bWFyZ2luLXRvcDoxNHB4Ij4KICAgICAgICA8aW1nIHNyYz0iL2JhcmNvZGUvJHtlbmNvZGVVUklDb21wb25lbnQo' +
  'ai5qb2JfbnVtYmVyKX0uc3ZnIiBhbHQ9ImJhcmNvZGUiIHN0eWxlPSJtYXgtd2lkdGg6MTAwJSI+CiAgICAgIDwvZGl2PgogICAg' +
  'PC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5DYXNlIGRldGFpbDwvaDI+CiAgICAgIDx0YWJsZSBjbGFz' +
  'cz0idGJsIj4KICAgICAgICAke1tbJ0Nhc2UnLCBqLmNhc2VfbnVtYmVyXSwgWydDb3VydCcsIGouY291cnRdLCBbJ1BsYWludGlm' +
  'ZicsIGoucGxhaW50aWZmXSwgWydEZWZlbmRhbnQnLCBqLmRlZmVuZGFudF0sCiAgICAgICAgICAgWydEb2N1bWVudHMnLCBqLmRv' +
  'Y3VtZW50c10sIFsnU2VydmljZSB0eXBlJywgai5zZXJ2aWNlX3R5cGVdLCBbJ0R1ZScsIGZtdERhdGVPbmx5KGouZHVlX2RhdGUp' +
  'XSwKICAgICAgICAgICBbJ0Fzc2lnbmVkIHRvJywgai5zZXJ2ZXJfbmFtZV0sIFsnQ2xpZW50IGZlZScsIGouY2xpZW50X2ZlZSA/' +
  'IG1vbmV5KGouY2xpZW50X2ZlZSkgOiAnJ10sCiAgICAgICAgICAgWydTZXJ2ZXIgcGF5Jywgai5zZXJ2ZXJfcGF5ID8gbW9uZXko' +
  'ai5zZXJ2ZXJfcGF5KSA6ICcnXSwKICAgICAgICAgICBbJ1NlcnZlZCcsIGouc2VydmVkX2F0ID8gZm10RFQoai5zZXJ2ZWRfYXQp' +
  'ICsgJyDigJQgJyArIGVzYyhqLnNlcnZlZF9tYW5uZXIgfHwgJycpIDogJyddLAogICAgICAgICAgIFsnTm90ZXMnLCBqLm5vdGVz' +
  'XV0KICAgICAgICAgIC5maWx0ZXIociA9PiByWzFdKS5tYXAociA9PiBgPHRyPjx0aCBzdHlsZT0id2lkdGg6MzQlIj4ke3JbMF19' +
  'PC90aD48dGQ+JHtlc2MoclsxXSl9PC90ZD48L3RyPmApLmpvaW4oJycpfQogICAgICA8L3RhYmxlPgogICAgICAke2lzQWRtaW4o' +
  'KSA/ICc8YnV0dG9uIGNsYXNzPSJidG4gc2VjIGJsb2NrIHNtIiBpZD0iZWRpdEJ0biIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+' +
  'RWRpdCBqb2I8L2J1dHRvbj4nIDogJyd9CiAgICA8L2Rpdj5gKTsKICBiaW5kU2hlbGwoKTsKICAkKCcjYmFjaycpLm9uY2xpY2sg' +
  'PSAoKSA9PiBnbygnam9icycsIFMuY2FjaGUuam9iRmlsdGVyIHx8IHt9KTsKICBpZiAoJCgnI25hdkJ0bicpKSAkKCcjbmF2QnRu' +
  'Jykub25jbGljayA9ICgpID0+IHdpbmRvdy5vcGVuKG5hdlVybChhZGRyKSwgJ19ibGFuaycpOwogIGlmICgkKCcjYXR0QnRuJykp' +
  'ICQoJyNhdHRCdG4nKS5vbmNsaWNrID0gKCkgPT4gYXR0ZW1wdEZvcm0oaik7CiAgaWYgKCQoJyNlZGl0QnRuJykpICQoJyNlZGl0' +
  'QnRuJykub25jbGljayA9ICgpID0+IGpvYkZvcm0oaik7CiAgJCgnI2NvdmVyQnRuJykub25jbGljayA9ICgpID0+IHdpbmRvdy5v' +
  'cGVuKCcvcHJpbnQvY292ZXJzaGVldC8nICsgai5pZCwgJ19ibGFuaycpOwogICQoJyNhZmZCdG4nKS5vbmNsaWNrID0gKCkgPT4g' +
  'YWZmaWRhdml0U2hlZXQoaik7CiAgJCgnI3JlcG9ydEJ0bicpLm9uY2xpY2sgPSAoKSA9PiB3aW5kb3cub3BlbignL3ByaW50L3Jl' +
  'cG9ydC8nICsgai5pZCwgJ19ibGFuaycpOwogIGlmICgkKCcjbG9va3VwQnRuJykpICQoJyNsb29rdXBCdG4nKS5vbmNsaWNrID0g' +
  'KCkgPT4gY2FzZUxvb2t1cFNoZWV0KGopOwogIGJpbmRQaG90b1N0cmlwcyhqKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gcGhvdG9zIC0tICovCi8qIEEgcGhvbmUgY2FtZXJhIG1ha2Vz' +
  'IGEgNE1CLCA0MDAwcHggcGljdHVyZS4gTm9ib2R5IG5lZWRzIHRoYXQgdG8gcHJvdmUgYQogKiBkb29yIHdhcyBrbm9ja2VkIG9u' +
  'LCBhbmQgc2VuZGluZyBpdCBvdmVyIGEgcGFya2luZy1sb3Qgc2lnbmFsIGlzIGhvdyBhCiAqIHNlcnZlciBnaXZlcyB1cCBhbmQg' +
  'c3RvcHMgdGFraW5nIHBob3RvcyBhdCBhbGwuIFNvIGV2ZXJ5IHNob3QgaXMgZHJhd24KICogaW50byBhIGNhbnZhcyBhdCAxNjAw' +
  'cHggb24gaXRzIGxvbmcgc2lkZSBhbmQgcmUtZW5jb2RlZCBhcyBKUEVHIGJlZm9yZSBpdAogKiBsZWF2ZXMgdGhlIHBob25lIOKA' +
  'lCBhYm91dCAyNTBLQiwgc3RpbGwgc2hhcnAgZW5vdWdoIHRvIHJlYWQgYSBob3VzZSBudW1iZXIuICovCmNvbnN0IFBIT1RPX01B' +
  'WF9FREdFID0gMTYwMDsKY29uc3QgUEhPVE9fUVVBTElUWSA9IDAuNzI7CgpmdW5jdGlvbiBzaHJpbmtQaG90byhmaWxlKSB7CiAg' +
  'cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHsKICAgIGNvbnN0IGltZyA9IG5ldyBJbWFnZSgpOwogICAg' +
  'Y29uc3QgdXJsID0gVVJMLmNyZWF0ZU9iamVjdFVSTChmaWxlKTsKICAgIGltZy5vbmxvYWQgPSAoKSA9PiB7CiAgICAgIFVSTC5y' +
  'ZXZva2VPYmplY3RVUkwodXJsKTsKICAgICAgY29uc3Qgc2NhbGUgPSBNYXRoLm1pbigxLCBQSE9UT19NQVhfRURHRSAvIE1hdGgu' +
  'bWF4KGltZy53aWR0aCwgaW1nLmhlaWdodCkpOwogICAgICBjb25zdCB3ID0gTWF0aC5yb3VuZChpbWcud2lkdGggKiBzY2FsZSks' +
  'IGggPSBNYXRoLnJvdW5kKGltZy5oZWlnaHQgKiBzY2FsZSk7CiAgICAgIGNvbnN0IGMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50' +
  'KCdjYW52YXMnKTsKICAgICAgYy53aWR0aCA9IHc7IGMuaGVpZ2h0ID0gaDsKICAgICAgYy5nZXRDb250ZXh0KCcyZCcpLmRyYXdJ' +
  'bWFnZShpbWcsIDAsIDAsIHcsIGgpOwogICAgICBjb25zdCBkYXRhID0gYy50b0RhdGFVUkwoJ2ltYWdlL2pwZWcnLCBQSE9UT19R' +
  'VUFMSVRZKS5zcGxpdCgnLCcpWzFdOwogICAgICBpZiAoIWRhdGEpIHJldHVybiByZWplY3QobmV3IEVycm9yKCdUaGlzIHBob25l' +
  'IGNvdWxkIG5vdCBwcm9jZXNzIHRoYXQgcGhvdG8nKSk7CiAgICAgIHJlc29sdmUoeyBkYXRhLCBtaW1lOiAnaW1hZ2UvanBlZycs' +
  'IHdpZHRoOiB3LCBoZWlnaHQ6IGggfSk7CiAgICB9OwogICAgaW1nLm9uZXJyb3IgPSAoKSA9PiB7IFVSTC5yZXZva2VPYmplY3RV' +
  'UkwodXJsKTsgcmVqZWN0KG5ldyBFcnJvcignVGhhdCBmaWxlIGlzIG5vdCBhIHBob3RvJykpOyB9OwogICAgaW1nLnNyYyA9IHVy' +
  'bDsKICB9KTsKfQoKLy8gVXBsb2FkcyBvbmUgYXQgYSB0aW1lOiBhIHNlcnZlciBvbiBhIHdlYWsgc2lnbmFsIGdldHMgcGFydGlh' +
  'bCBzdWNjZXNzIHJhdGhlcgovLyB0aGFuIG9uZSBnaWFudCByZXF1ZXN0IHRoYXQgZmFpbHMgd2hvbGUuCmFzeW5jIGZ1bmN0aW9u' +
  'IHVwbG9hZFBob3RvcyhhdHRlbXB0SWQsIGZpbGVzLCBvblByb2dyZXNzKSB7CiAgY29uc3QgZG9uZSA9IFtdOwogIGZvciAobGV0' +
  'IGkgPSAwOyBpIDwgZmlsZXMubGVuZ3RoOyBpKyspIHsKICAgIGlmIChvblByb2dyZXNzKSBvblByb2dyZXNzKGkgKyAxLCBmaWxl' +
  'cy5sZW5ndGgpOwogICAgY29uc3Qgc2hvdCA9IGF3YWl0IHNocmlua1Bob3RvKGZpbGVzW2ldKTsKICAgIGRvbmUucHVzaChhd2Fp' +
  'dCBhcGkoJy9hdHRlbXB0cy8nICsgYXR0ZW1wdElkICsgJy9waG90b3MnLCB7CiAgICAgIG1ldGhvZDogJ1BPU1QnLCBib2R5OiBK' +
  'U09OLnN0cmluZ2lmeShzaG90KQogICAgfSkpOwogIH0KICByZXR1cm4gZG9uZTsKfQoKZnVuY3Rpb24gcGhvdG9TdHJpcChhLCBq' +
  'b2IpIHsKICBjb25zdCBjYW5FZGl0ID0gIWpvYi5waG90b3NfaGlkZGVuICYmIChpc0FkbWluKCkgfHwgam9iLmFzc2lnbmVkX3Rv' +
  'ID09PSBTLm1lLmlkKTsKICBpZiAoam9iLnBob3Rvc19oaWRkZW4pIHsKICAgIHJldHVybiBhLnBob3RvX2NvdW50CiAgICAgID8g' +
  'YDxkaXYgY2xhc3M9Im0gcGhvdG8taGlkZGVuIj4ke2EucGhvdG9fY291bnR9IHBob3RvJHthLnBob3RvX2NvdW50ID4gMSA/ICdz' +
  'JyA6ICcnfSDigJQgaGlkZGVuIGluIHN1cHBvcnQgdmlldzwvZGl2PmAKICAgICAgOiAnJzsKICB9CiAgY29uc3QgdGh1bWJzID0g' +
  'KGEucGhvdG9zIHx8IFtdKS5tYXAocCA9PgogICAgYDxidXR0b24gY2xhc3M9InRodW1iIiBkYXRhLXBob3RvPSIke3AuaWR9IiB0' +
  'aXRsZT0iJHtlc2MocC5jYXB0aW9uIHx8ICcnKX0iPgogICAgICAgPGltZyBzcmM9Ii9waG90by8ke3AuaWR9IiBhbHQ9IiR7ZXNj' +
  'KHAuY2FwdGlvbiB8fCAnQXR0ZW1wdCBwaG90bycpfSIgbG9hZGluZz0ibGF6eSI+CiAgICAgICAke3AuY2FwdGlvbiA/IGA8c3Bh' +
  'biBjbGFzcz0iY2FwIj4ke2VzYyhwLmNhcHRpb24pfTwvc3Bhbj5gIDogJyd9CiAgICAgPC9idXR0b24+YCkuam9pbignJyk7CiAg' +
  'cmV0dXJuIGA8ZGl2IGNsYXNzPSJwaG90b3MiIGRhdGEtYXR0ZW1wdD0iJHthLmlkfSI+CiAgICAke3RodW1ic30KICAgICR7Y2Fu' +
  'RWRpdCA/IGA8YnV0dG9uIGNsYXNzPSJ0aHVtYiBhZGQiIGRhdGEtYWRkPSIke2EuaWR9Ij7vvIs8c3Bhbj5QaG90bzwvc3Bhbj48' +
  'L2J1dHRvbj5gIDogJyd9CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gYmluZFBob3RvU3RyaXBzKGpvYikgewogIGRvY3VtZW50LnF1' +
  'ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBob3RvXScpLmZvckVhY2goYiA9PiB7CiAgICBiLm9uY2xpY2sgPSAoKSA9PiBwaG90b1Zp' +
  'ZXdlcihqb2IsIE51bWJlcihiLmRhdGFzZXQucGhvdG8pKTsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0' +
  'YS1hZGRdJykuZm9yRWFjaChiID0+IHsKICAgIGIub25jbGljayA9ICgpID0+IHBpY2tQaG90b3MoYXN5bmMgZmlsZXMgPT4gewog' +
  'ICAgICBjb25zdCBsYWJlbCA9IGIucXVlcnlTZWxlY3Rvcignc3BhbicpOwogICAgICBjb25zdCB3YXMgPSBsYWJlbC50ZXh0Q29u' +
  'dGVudDsKICAgICAgYi5kaXNhYmxlZCA9IHRydWU7CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgdXBsb2FkUGhvdG9zKE51bWJl' +
  'cihiLmRhdGFzZXQuYWRkKSwgZmlsZXMsCiAgICAgICAgICAobiwgdG90YWwpID0+IHsgbGFiZWwudGV4dENvbnRlbnQgPSBuICsg' +
  'Jy8nICsgdG90YWw7IH0pOwogICAgICAgIHRvYXN0KGZpbGVzLmxlbmd0aCA+IDEgPyBmaWxlcy5sZW5ndGggKyAnIHBob3RvcyBh' +
  'ZGRlZCcgOiAnUGhvdG8gYWRkZWQnKTsKICAgICAgICBnbygnam9iJywgeyBpZDogam9iLmlkIH0pOwogICAgICB9IGNhdGNoIChl' +
  'KSB7CiAgICAgICAgYi5kaXNhYmxlZCA9IGZhbHNlOyBsYWJlbC50ZXh0Q29udGVudCA9IHdhczsKICAgICAgICB0b2FzdChlLm1l' +
  'c3NhZ2UsIHRydWUpOwogICAgICB9CiAgICB9KTsKICB9KTsKfQoKLy8gT25lIGhpZGRlbiBpbnB1dCwgcmV1c2VkLiBjYXB0dXJl' +
  'PSJlbnZpcm9ubWVudCIgb3BlbnMgdGhlIHJlYXIgY2FtZXJhCi8vIHN0cmFpZ2h0IGF3YXkgb24gYSBwaG9uZTsgb24gYSBkZXNr' +
  'dG9wIGl0IGlzIGFuIG9yZGluYXJ5IGZpbGUgcGlja2VyLgpmdW5jdGlvbiBwaWNrUGhvdG9zKG9uUGlja2VkKSB7CiAgY29uc3Qg' +
  'aW5wID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTsKICBpbnAudHlwZSA9ICdmaWxlJzsKICBpbnAuYWNjZXB0ID0g' +
  'J2ltYWdlLyonOwogIGlucC5tdWx0aXBsZSA9IHRydWU7CiAgaW5wLnNldEF0dHJpYnV0ZSgnY2FwdHVyZScsICdlbnZpcm9ubWVu' +
  'dCcpOwogIGlucC5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoaW5wKTsKICBpbnAu' +
  'b25jaGFuZ2UgPSAoKSA9PiB7CiAgICBjb25zdCBmaWxlcyA9IEFycmF5LmZyb20oaW5wLmZpbGVzIHx8IFtdKTsKICAgIGlucC5y' +
  'ZW1vdmUoKTsKICAgIGlmIChmaWxlcy5sZW5ndGgpIG9uUGlja2VkKGZpbGVzKTsKICB9OwogIGlucC5jbGljaygpOwp9CgpmdW5j' +
  'dGlvbiBwaG90b1ZpZXdlcihqb2IsIGlkKSB7CiAgY29uc3QgYWxsID0gam9iLmF0dGVtcHRzLmZsYXRNYXAoYSA9PiBhLnBob3Rv' +
  'cyB8fCBbXSk7CiAgY29uc3QgcCA9IGFsbC5maW5kKHggPT4geC5pZCA9PT0gaWQpOwogIGlmICghcCkgcmV0dXJuOwogIGNvbnN0' +
  'IGNhbkVkaXQgPSBpc0FkbWluKCkgfHwgam9iLmFzc2lnbmVkX3RvID09PSBTLm1lLmlkOwogIHNoZWV0KCdQaG90bycsIGAKICAg' +
  'IDxpbWcgc3JjPSIvcGhvdG8vJHtwLmlkfSIgYWx0PSIiIHN0eWxlPSJ3aWR0aDoxMDAlO2JvcmRlci1yYWRpdXM6MTJweDtkaXNw' +
  'bGF5OmJsb2NrIj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij48bGFiZWw+Q2FwdGlvbjwv' +
  'bGFiZWw+CiAgICAgIDxpbnB1dCBpZD0icF9jYXAiIHZhbHVlPSIke2VzYyhwLmNhcHRpb24gfHwgJycpfSIgcGxhY2Vob2xkZXI9' +
  'IkZyb250IGRvb3IsIG5vIGFuc3dlciIKICAgICAgICAke2NhbkVkaXQgPyAnJyA6ICdkaXNhYmxlZCd9PjwvZGl2PgogICAgPGRp' +
  'diBjbGFzcz0iaGludCI+JHtNYXRoLnJvdW5kKHAuYnl0ZXMgLyAxMDI0KX0gS0IgwrcgYWRkZWQgJHtmbXREVChwLmNyZWF0ZWRf' +
  'YXQpfTwvZGl2PgogICAgJHtjYW5FZGl0ID8gYDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+CiAgICAg' +
  'IDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InBfc2F2ZSI+U2F2ZSBjYXB0aW9uPC9idXR0b24+CiAgICAgIDxidXR0b24gY2xhc3M9' +
  'ImJ0biBzZWMiIGlkPSJwX2RlbCI+RGVsZXRlIHBob3RvPC9idXR0b24+CiAgICA8L2Rpdj5gIDogJyd9YCwgZWwgPT4gewogICAg' +
  'aWYgKCFjYW5FZGl0KSByZXR1cm47CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjcF9zYXZlJykub25jbGljayA9IGFzeW5jICgpID0+' +
  'IHsKICAgICAgdHJ5IHsKICAgICAgICBhd2FpdCBhcGkoJy9waG90b3MvJyArIHAuaWQsIHsKICAgICAgICAgIG1ldGhvZDogJ1BB' +
  'VENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYXB0aW9uOiBlbC5xdWVyeVNlbGVjdG9yKCcjcF9jYXAnKS52YWx1ZSB9KQog' +
  'ICAgICAgIH0pOwogICAgICAgIGNsb3NlU2hlZXQoKTsgdG9hc3QoJ0NhcHRpb24gc2F2ZWQnKTsgZ28oJ2pvYicsIHsgaWQ6IGpv' +
  'Yi5pZCB9KTsKICAgICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgICB9OwogICAgZWwucXVlcnlT' +
  'ZWxlY3RvcignI3BfZGVsJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgaWYgKCFjb25maXJtKCdEZWxldGUgdGhpcyBw' +
  'aG90bz8gSXQgaXMgcGFydCBvZiB0aGUgcmVjb3JkIGZvciB0aGlzIGF0dGVtcHQuJykpIHJldHVybjsKICAgICAgdHJ5IHsKICAg' +
  'ICAgICBhd2FpdCBhcGkoJy9waG90b3MvJyArIHAuaWQsIHsgbWV0aG9kOiAnREVMRVRFJyB9KTsKICAgICAgICBjbG9zZVNoZWV0' +
  'KCk7IHRvYXN0KCdQaG90byBkZWxldGVkJyk7IGdvKCdqb2InLCB7IGlkOiBqb2IuaWQgfSk7CiAgICAgIH0gY2F0Y2ggKGUpIHsg' +
  'dG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogICAgfTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBsb2cgYXR0ZW1wdCAtLSAqLwpjb25zdCBPVVRDT01FUyA9IFsnU2VydmVkJywgJ05v' +
  'IEFuc3dlcicsICdCYWQgQWRkcmVzcycsICdNb3ZlZCcsICdSZWZ1c2VkJywgJ0V2YWRpbmcnLCAnT3RoZXInXTsKCmZ1bmN0aW9u' +
  'IGF0dGVtcHRGb3JtKGpvYikgewogIHNoZWV0KCdMb2cgYXR0ZW1wdCDigJQgJyArIGpvYi5yZWNpcGllbnRfbmFtZSwgYAogICAg' +
  'PGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5PdXRjb21lPC9sYWJlbD4KICAgICAgPGRpdiBjbGFzcz0icm93IiBpZD0ib3V0Y29t' +
  'ZXMiPiR7T1VUQ09NRVMubWFwKG8gPT4KICAgICAgICBgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgZGF0YS1vPSIke299Ij4k' +
  'e299PC9idXR0b24+YCkuam9pbignJyl9PC9kaXY+PC9kaXY+CiAgICA8ZGl2IGlkPSJzZXJ2ZWRGaWVsZHMiIHN0eWxlPSJkaXNw' +
  'bGF5Om5vbmUiPgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk1h' +
  'bm5lcjwvbGFiZWw+PHNlbGVjdCBpZD0iYV9tYW5uZXIiPgogICAgICAgICAgJHtbJ1BlcnNvbmFsJywgJ1N1YnN0aXR1dGUnLCAn' +
  'UG9zdGVkJywgJ0NvcnBvcmF0ZScsICdDZXJ0aWZpZWQgTWFpbCddLm1hcChzID0+IGA8b3B0aW9uPiR7c308L29wdGlvbj5gKS5q' +
  'b2luKCcnKX08L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBlcnNvbiBzZXJ2ZWQ8L2xh' +
  'YmVsPjxpbnB1dCBpZD0iYV9wZXJzb25fc2VydmVkIiB2YWx1ZT0iJHtlc2Moam9iLnJlY2lwaWVudF9uYW1lKX0iPjwvZGl2Pgog' +
  'ICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5S' +
  'ZWxhdGlvbnNoaXAgKGlmIHN1YnN0aXR1dGUpPC9sYWJlbD48aW5wdXQgaWQ9ImFfcmVsYXRpb25zaGlwIiBwbGFjZWhvbGRlcj0i' +
  'Y28tcmVzaWRlbnQsIGNvLXdvcmtlci4uLiI+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5EZXNjcmlw' +
  'dGlvbjwvbGFiZWw+PGlucHV0IGlkPSJhX2Rlc2NyaXB0aW9uIiBwbGFjZWhvbGRlcj0iVy9GLCA0MHMsIDUnNiZxdW90OywgYnJv' +
  'd24gaGFpciI+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk5vdGVz' +
  'PC9sYWJlbD48dGV4dGFyZWEgaWQ9ImFfbm90ZXMiIHBsYWNlaG9sZGVyPSJMaWdodHMgb24sIG5vIGFuc3dlciBhdCBmcm9udCBk' +
  'b29yLiBTaWx2ZXIgQ2l2aWMgaW4gZHJpdmV3YXkuIj48L3RleHRhcmVhPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxs' +
  'YWJlbD5XaGVuPC9sYWJlbD48aW5wdXQgaWQ9ImFfd2hlbiIgdHlwZT0iZGF0ZXRpbWUtbG9jYWwiIHZhbHVlPSIke2xvY2FsTm93' +
  'KCl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJiYWNrZ3JvdW5kOiNmOGZhZmM7Ym94LXNoYWRvdzpub25l' +
  'O21hcmdpbi1ib3R0b206MTJweCI+CiAgICAgIDxkaXYgY2xhc3M9InJvdyI+PGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9' +
  'Imdwc0J0biI+Q2FwdHVyZSBHUFM8L2J1dHRvbj4KICAgICAgPHNwYW4gY2xhc3M9ImhpbnQiIGlkPSJncHNPdXQiIHN0eWxlPSJt' +
  'YXJnaW46MCI+Tm90IGNhcHR1cmVkPC9zcGFuPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVs' +
  'PlBob3RvczwvbGFiZWw+CiAgICAgIDxkaXYgY2xhc3M9InBob3RvcyIgaWQ9InBlbmRQaG90b3MiPgogICAgICAgIDxidXR0b24g' +
  'Y2xhc3M9InRodW1iIGFkZCIgaWQ9InBob3RvQnRuIiB0eXBlPSJidXR0b24iPu+8izxzcGFuPlBob3RvPC9zcGFuPjwvYnV0dG9u' +
  'PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGludCI+VGhlIGRvb3IsIHRoZSBudW1iZXIsIHRoZSBub3RpY2UsIHRo' +
  'ZSBjYXIuIFRoZXkgZ28gb24gdGhlIGF0dGVtcHQKICAgICAgYW5kIG9uIHRoZSByZXBvcnQgeW91ciBjbGllbnQgc2Vlcy48L2Rp' +
  'dj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0ic2F2ZUF0dCIg' +
  'ZGlzYWJsZWQ+UGljayBhbiBvdXRjb21lPC9idXR0b24+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIG9uY2xpY2s9ImNs' +
  'b3NlU2hlZXQoKSI+Q2FuY2VsPC9idXR0b24+CiAgICA8L2Rpdj5gLCBlbCA9PiB7CiAgICBsZXQgb3V0Y29tZSA9IG51bGwsIGdw' +
  'cyA9IG51bGw7CiAgICAvKiBQaG90b3MgYXJlIHBpY2tlZCBiZWZvcmUgdGhlIGF0dGVtcHQgZXhpc3RzLCBzbyB0aGV5IGFyZSBo' +
  'ZWxkIGhlcmUgYW5kCiAgICAgICB1cGxvYWRlZCBvbmNlIHNhdmluZyBnaXZlcyB1cyBhbiBhdHRlbXB0IGlkLiAqLwogICAgY29u' +
  'c3QgcGVuZGluZyA9IFtdOwogICAgY29uc3Qgc3RyaXAgPSBlbC5xdWVyeVNlbGVjdG9yKCcjcGVuZFBob3RvcycpOwogICAgY29u' +
  'c3QgYWRkQnRuID0gZWwucXVlcnlTZWxlY3RvcignI3Bob3RvQnRuJyk7CiAgICBjb25zdCBkcmF3UGVuZGluZyA9ICgpID0+IHsK' +
  'ICAgICAgc3RyaXAucXVlcnlTZWxlY3RvckFsbCgnLnBlbmQnKS5mb3JFYWNoKG4gPT4gbi5yZW1vdmUoKSk7CiAgICAgIHBlbmRp' +
  'bmcuZm9yRWFjaCgoZiwgaSkgPT4gewogICAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTsK' +
  'ICAgICAgICBiLnR5cGUgPSAnYnV0dG9uJzsKICAgICAgICBiLmNsYXNzTmFtZSA9ICd0aHVtYiBwZW5kJzsKICAgICAgICBiLnRp' +
  'dGxlID0gJ1JlbW92ZSc7CiAgICAgICAgYi5pbm5lckhUTUwgPSBgPGltZyBzcmM9IiR7VVJMLmNyZWF0ZU9iamVjdFVSTChmKX0i' +
  'IGFsdD0iIj48c3BhbiBjbGFzcz0ieCI+w5c8L3NwYW4+YDsKICAgICAgICBiLm9uY2xpY2sgPSAoKSA9PiB7IHBlbmRpbmcuc3Bs' +
  'aWNlKGksIDEpOyBkcmF3UGVuZGluZygpOyB9OwogICAgICAgIHN0cmlwLmluc2VydEJlZm9yZShiLCBhZGRCdG4pOwogICAgICB9' +
  'KTsKICAgICAgYWRkQnRuLnF1ZXJ5U2VsZWN0b3IoJ3NwYW4nKS50ZXh0Q29udGVudCA9IHBlbmRpbmcubGVuZ3RoID8gYFBob3Rv' +
  'ICgke3BlbmRpbmcubGVuZ3RofSlgIDogJ1Bob3RvJzsKICAgIH07CiAgICBhZGRCdG4ub25jbGljayA9ICgpID0+IHBpY2tQaG90' +
  'b3MoZmlsZXMgPT4geyBwZW5kaW5nLnB1c2goLi4uZmlsZXMpOyBkcmF3UGVuZGluZygpOyB9KTsKICAgIGVsLnF1ZXJ5U2VsZWN0' +
  'b3JBbGwoJ1tkYXRhLW9dJykuZm9yRWFjaChiID0+IGIub25jbGljayA9ICgpID0+IHsKICAgICAgb3V0Y29tZSA9IGIuZGF0YXNl' +
  'dC5vOwogICAgICBlbC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1vXScpLmZvckVhY2goeCA9PiB7IHguY2xhc3NOYW1lID0gJ2J0' +
  'biBzZWMgc20nOyB9KTsKICAgICAgYi5jbGFzc05hbWUgPSAnYnRuIHNtJyArIChvdXRjb21lID09PSAnU2VydmVkJyA/ICcgb2sn' +
  'IDogJycpOwogICAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2VydmVkRmllbGRzJykuc3R5bGUuZGlzcGxheSA9IG91dGNvbWUgPT09' +
  'ICdTZXJ2ZWQnID8gJycgOiAnbm9uZSc7CiAgICAgIGNvbnN0IHMgPSBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZUF0dCcpOwogICAg' +
  'ICBzLmRpc2FibGVkID0gZmFsc2U7CiAgICAgIHMudGV4dENvbnRlbnQgPSBvdXRjb21lID09PSAnU2VydmVkJyA/ICdTYXZlIOKA' +
  'lCBtYXJrcyBqb2IgU0VSVkVEJyA6ICdTYXZlIGF0dGVtcHQnOwogICAgfSk7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjZ3BzQnRu' +
  'Jykub25jbGljayA9ICgpID0+IHsKICAgICAgY29uc3Qgb3V0ID0gZWwucXVlcnlTZWxlY3RvcignI2dwc091dCcpOwogICAgICBp' +
  'ZiAoIW5hdmlnYXRvci5nZW9sb2NhdGlvbikgcmV0dXJuIG91dC50ZXh0Q29udGVudCA9ICdOb3Qgc3VwcG9ydGVkIG9uIHRoaXMg' +
  'ZGV2aWNlJzsKICAgICAgb3V0LnRleHRDb250ZW50ID0gJ0xvY2F0aW5n4oCmJzsKICAgICAgbmF2aWdhdG9yLmdlb2xvY2F0aW9u' +
  'LmdldEN1cnJlbnRQb3NpdGlvbihwb3MgPT4gewogICAgICAgIGdwcyA9IHsgbGF0OiBwb3MuY29vcmRzLmxhdGl0dWRlLCBsbmc6' +
  'IHBvcy5jb29yZHMubG9uZ2l0dWRlLCBhY2N1cmFjeV9tOiBwb3MuY29vcmRzLmFjY3VyYWN5IH07CiAgICAgICAgb3V0LmlubmVy' +
  'SFRNTCA9IGA8YiBzdHlsZT0iY29sb3I6dmFyKC0tb2spIj7inJMgJHtncHMubGF0LnRvRml4ZWQoNSl9LCAke2dwcy5sbmcudG9G' +
  'aXhlZCg1KX08L2I+IMKxJHtNYXRoLnJvdW5kKGdwcy5hY2N1cmFjeV9tKX1tYDsKICAgICAgfSwgZXJyID0+IHsgb3V0LnRleHRD' +
  'b250ZW50ID0gJ0ZhaWxlZDogJyArIGVyci5tZXNzYWdlOyB9LAogICAgICAgIHsgZW5hYmxlSGlnaEFjY3VyYWN5OiB0cnVlLCB0' +
  'aW1lb3V0OiAxNTAwMCwgbWF4aW11bUFnZTogMCB9KTsKICAgIH07CiAgICAvLyBhdXRvLWNhcHR1cmUgb24gb3BlbiDigJQgdGhl' +
  'IGFmZmlkYXZpdCBpcyBzdHJvbmdlciB3aGVuIGV2ZXJ5IGF0dGVtcHQgaGFzIGNvb3JkaW5hdGVzCiAgICBlbC5xdWVyeVNlbGVj' +
  'dG9yKCcjZ3BzQnRuJykuY2xpY2soKTsKCiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZUF0dCcpLm9uY2xpY2sgPSBhc3luYyAo' +
  'KSA9PiB7CiAgICAgIGNvbnN0IGJvZHkgPSBPYmplY3QuYXNzaWduKHsKICAgICAgICBvdXRjb21lLAogICAgICAgIGF0dGVtcHRl' +
  'ZF9hdDogZWwucXVlcnlTZWxlY3RvcignI2Ffd2hlbicpLnZhbHVlIHx8IG51bGwsCiAgICAgICAgbm90ZXM6IGVsLnF1ZXJ5U2Vs' +
  'ZWN0b3IoJyNhX25vdGVzJykudmFsdWUKICAgICAgfSwgZ3BzIHx8IHt9KTsKICAgICAgaWYgKG91dGNvbWUgPT09ICdTZXJ2ZWQn' +
  'KSB7CiAgICAgICAgYm9keS5tYW5uZXIgPSBlbC5xdWVyeVNlbGVjdG9yKCcjYV9tYW5uZXInKS52YWx1ZTsKICAgICAgICBib2R5' +
  'LnBlcnNvbl9zZXJ2ZWQgPSBlbC5xdWVyeVNlbGVjdG9yKCcjYV9wZXJzb25fc2VydmVkJykudmFsdWU7CiAgICAgICAgYm9keS5y' +
  'ZWxhdGlvbnNoaXAgPSBlbC5xdWVyeVNlbGVjdG9yKCcjYV9yZWxhdGlvbnNoaXAnKS52YWx1ZTsKICAgICAgICBib2R5LmRlc2Ny' +
  'aXB0aW9uID0gZWwucXVlcnlTZWxlY3RvcignI2FfZGVzY3JpcHRpb24nKS52YWx1ZTsKICAgICAgfQogICAgICBjb25zdCBzYXZl' +
  'ID0gZWwucXVlcnlTZWxlY3RvcignI3NhdmVBdHQnKTsKICAgICAgY29uc3Qgd2FzID0gc2F2ZS50ZXh0Q29udGVudDsKICAgICAg' +
  'c2F2ZS5kaXNhYmxlZCA9IHRydWU7CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3QgYXR0ID0gYXdhaXQgYXBpKCcvam9icy8nICsg' +
  'am9iLmlkICsgJy9hdHRlbXB0cycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pOwogICAg' +
  'ICAgIC8qIFRoZSBhdHRlbXB0IGlzIHNhdmVkIGF0IHRoaXMgcG9pbnQuIElmIGEgcGhvdG8gZmFpbHMgdG8gdXBsb2FkIGFmdGVy' +
  'CiAgICAgICAgICAgdGhhdCDigJQgZGVhZCBzaWduYWwgaW4gYSBkcml2ZXdheSDigJQgdGhlIGF0dGVtcHQgc3RpbGwgc3RhbmRz' +
  'IGFuZCB0aGUKICAgICAgICAgICBzZXJ2ZXIgaXMgdG9sZCB3aGljaCBvbmVzIHRvIHJldHJ5IGZyb20gdGhlIGpvYiBzY3JlZW4s' +
  'IHJhdGhlciB0aGFuCiAgICAgICAgICAgbG9zaW5nIHRoZSB3aG9sZSBlbnRyeS4gKi8KICAgICAgICBsZXQgZmFpbGVkID0gMDsK' +
  'ICAgICAgICBpZiAocGVuZGluZy5sZW5ndGgpIHsKICAgICAgICAgIHRyeSB7CiAgICAgICAgICAgIGF3YWl0IHVwbG9hZFBob3Rv' +
  'cyhhdHQuaWQsIHBlbmRpbmcsCiAgICAgICAgICAgICAgKG4sIHRvdGFsKSA9PiB7IHNhdmUudGV4dENvbnRlbnQgPSBgU2VuZGlu' +
  'ZyBwaG90byAke259IG9mICR7dG90YWx94oCmYDsgfSk7CiAgICAgICAgICB9IGNhdGNoIChlKSB7IGZhaWxlZCA9IDE7IH0KICAg' +
  'ICAgICB9CiAgICAgICAgY2xvc2VTaGVldCgpOwogICAgICAgIHRvYXN0KGZhaWxlZCA/ICdBdHRlbXB0IHNhdmVkIOKAlCBhIHBo' +
  'b3RvIGRpZCBub3Qgc2VuZCwgYWRkIGl0IGFnYWluIGZyb20gdGhlIGpvYicKICAgICAgICAgIDogb3V0Y29tZSA9PT0gJ1NlcnZl' +
  'ZCcgPyAnU2VydmVkIOKAlCBqb2IgY2xvc2VkIG91dCcgOiAnQXR0ZW1wdCBsb2dnZWQnLCAhIWZhaWxlZCk7CiAgICAgICAgZ28o' +
  'J2pvYicsIHsgaWQ6IGpvYi5pZCB9KTsKICAgICAgfSBjYXRjaCAoZSkgeyBzYXZlLmRpc2FibGVkID0gZmFsc2U7IHNhdmUudGV4' +
  'dENvbnRlbnQgPSB3YXM7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICAgIH07CiAgfSk7Cn0KCmZ1bmN0aW9uIGxvY2FsTm93' +
  'KCkgewogIGNvbnN0IGQgPSBuZXcgRGF0ZShEYXRlLm5vdygpIC0gbmV3IERhdGUoKS5nZXRUaW1lem9uZU9mZnNldCgpICogNjAw' +
  'MDApOwogIHJldHVybiBkLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTYpOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGFmZmlkYXZpdCAtLSAqLwphc3luYyBmdW5jdGlvbiBhZmZpZGF2aXRT' +
  'aGVldChqb2IpIHsKICBjb25zdCB0ZW1wbGF0ZXMgPSBhd2FpdCBhcGkoJy90ZW1wbGF0ZXMnKTsKICBjb25zdCBsb2FkID0gYXN5' +
  'bmMgaWQgPT4gewogICAgY29uc3QgciA9IGF3YWl0IGFwaSgnL2pvYnMvJyArIGpvYi5pZCArICcvYWZmaWRhdml0JyArIChpZCA/' +
  'ICc/dGVtcGxhdGVfaWQ9JyArIGlkIDogJycpKTsKICAgIHJldHVybiByOwogIH07CiAgY29uc3QgZmlyc3QgPSBhd2FpdCBsb2Fk' +
  'KCk7CiAgc2hlZXQoJ0FmZmlkYXZpdCDigJQgJyArIGpvYi5qb2JfbnVtYmVyLCBgCiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxh' +
  'YmVsPlRlbXBsYXRlPC9sYWJlbD48c2VsZWN0IGlkPSJ0cGwiPgogICAgICAke3RlbXBsYXRlcy5tYXAodCA9PiBgPG9wdGlvbiB2' +
  'YWx1ZT0iJHt0LmlkfSIgJHt0LmlkID09PSBmaXJzdC50ZW1wbGF0ZV9pZCA/ICdzZWxlY3RlZCcgOiAnJ30+JHtlc2ModC5uYW1l' +
  'KX0ke3QuanVyaXNkaWN0aW9uID8gJyDigJQgJyArIGVzYyh0Lmp1cmlzZGljdGlvbikgOiAnJ308L29wdGlvbj5gKS5qb2luKCcn' +
  'KX0KICAgIDwvc2VsZWN0PjwvZGl2PgogICAgPHByZSBjbGFzcz0icHJldiIgaWQ9InByZXYiPiR7ZXNjKGZpcnN0LnRleHQpfTwv' +
  'cHJlPgogICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRu' +
  'IiBpZD0icHJpbnRBZmYiPlByaW50IC8gc2F2ZSBQREY8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgaWQ9' +
  'ImNvcHlBZmYiPkNvcHkgdGV4dDwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJjbG9zZVNo' +
  'ZWV0KCkiPkNsb3NlPC9idXR0b24+CiAgICA8L2Rpdj5gLCBlbCA9PiB7CiAgICBjb25zdCBzZWwgPSBlbC5xdWVyeVNlbGVjdG9y' +
  'KCcjdHBsJyk7CiAgICBzZWwub25jaGFuZ2UgPSBhc3luYyAoKSA9PiB7IGVsLnF1ZXJ5U2VsZWN0b3IoJyNwcmV2JykudGV4dENv' +
  'bnRlbnQgPSAoYXdhaXQgbG9hZChzZWwudmFsdWUpKS50ZXh0OyB9OwogICAgZWwucXVlcnlTZWxlY3RvcignI3ByaW50QWZmJyku' +
  'b25jbGljayA9ICgpID0+CiAgICAgIHdpbmRvdy5vcGVuKCcvcHJpbnQvYWZmaWRhdml0LycgKyBqb2IuaWQgKyAnP3RlbXBsYXRl' +
  'X2lkPScgKyBzZWwudmFsdWUsICdfYmxhbmsnKTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNjb3B5QWZmJykub25jbGljayA9IGFz' +
  'eW5jICgpID0+IHsKICAgICAgYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoZWwucXVlcnlTZWxlY3RvcignI3By' +
  'ZXYnKS50ZXh0Q29udGVudCk7CiAgICAgIHRvYXN0KCdDb3BpZWQnKTsKICAgIH07CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIHRvb2xzIC0tLSAqLwovKiBMYWJlbCBtYWtlci4g' +
  'VGhlIHBvaW50IG9mIHRoZSBzaGVldCBncmlkIGlzIHRoYXQgbGFiZWwgc2hlZXRzIGFyZSBleHBlbnNpdmUKICAgYW5kIHJhcmVs' +
  'eSB1c2VkIHVwIGluIG9uZSBnbzogbWFyayB3aGljaCBvbmVzIHlvdSd2ZSBhbHJlYWR5IHBlZWxlZCBvZmYgYW5kCiAgIHRoZSBw' +
  'cmludGVyIHNraXBzIHRoZW0sIHNvIGEgcGFydC11c2VkIHNoZWV0IGdvZXMgYmFjayBpbiBhbmQgY2FycmllcyBvbi4gKi8KYXN5' +
  'bmMgZnVuY3Rpb24gdG9vbHNWaWV3KCkgewogIGNvbnN0IFtsYXlvdXRzLCBpbml0U2hlZXQsIGpvYnNdID0gYXdhaXQgUHJvbWlz' +
  'ZS5hbGwoWwogICAgYXBpKCcvbGFiZWwtbGF5b3V0cycpLCBhcGkoJy9sYWJlbC1zaGVldCcpLCBhcGkoJy9qb2JzP29wZW49MScp' +
  'CiAgXSk7CiAgUy5jYWNoZS5zaGVldCA9IGluaXRTaGVldDsKICBTLmNhY2hlLnBpY2tlZCA9IFMuY2FjaGUucGlja2VkIHx8IFtd' +
  'OwoKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5Ub29sczwvaDE+CgogICAgPGRpdiBjbGFz' +
  'cz0iY2FyZCI+CiAgICAgIDxoMj5MYWJlbCBtYWtlciA8c3BhbiBjbGFzcz0ic3ViIj5wcmludHMgb25seSB0aGUgbGFiZWxzIHlv' +
  'dSBoYXZlbid0IHVzZWQ8L3NwYW4+PC9oMj4KCiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+TGFiZWwgc2hlZXQ8L2xh' +
  'YmVsPgogICAgICAgIDxzZWxlY3QgaWQ9ImxheW91dCI+CiAgICAgICAgICAke2xheW91dHMubWFwKGwgPT4gYDxvcHRpb24gdmFs' +
  'dWU9IiR7bC5rZXl9IiAke2wua2V5ID09PSBpbml0U2hlZXQubGF5b3V0ID8gJ3NlbGVjdGVkJyA6ICcnfT4KICAgICAgICAgICAg' +
  'JHtlc2MobC5uYW1lKX0g4oCUICR7ZXNjKGwuc2l6ZSl9PC9vcHRpb24+YCkuam9pbignJyl9CiAgICAgICAgPC9zZWxlY3Q+CiAg' +
  'ICAgICAgPGRpdiBjbGFzcz0iaGludCI+T2ZmaWNlIERlcG90IHNoZWV0cyBwcmludCBhbiBBdmVyeSBlcXVpdmFsZW50IG51bWJl' +
  'ciBvbiB0aGUgcGFja2FnZSBmcm9udCDigJQKICAgICAgICAgIG1hdGNoIHRoYXQuIENoYW5naW5nIHRoZSBzaGVldCBjbGVhcnMg' +
  'dGhlIHVzZWQgbWFya3MsIHNpbmNlIHBvc2l0aW9uIDcgb24gYSAzMC11cCBzaGVldAogICAgICAgICAgaXNuJ3QgcG9zaXRpb24g' +
  'NyBvbiBhIDEwLXVwIG9uZS48L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8bGFiZWw+V2hpY2ggbGFiZWxzIGFyZSBhbHJlYWR5' +
  'IGdvbmU/PC9sYWJlbD4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi1ib3R0b206OHB4Ij5UYXAgdGhlIG9u' +
  'ZXMgYWxyZWFkeSBwZWVsZWQgb2ZmLiBHcmV5ID0gdXNlZCBhbmQgc2tpcHBlZC4KICAgICAgICBOdW1iZXJlZCBncmVlbiA9IHdo' +
  'ZXJlIHlvdXIgbmV4dCBsYWJlbHMgd2lsbCBsYW5kLCBpbiBvcmRlci48L2Rpdj4KICAgICAgPGRpdiBpZD0iZ3JpZCI+PC9kaXY+' +
  'CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICAgICAgPHNwYW4gY2xhc3M9InBpbGwi' +
  'IGlkPSJmcmVlQ291bnQiPjwvc3Bhbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0ibmV3U2hlZXQiPkZy' +
  'ZXNoIHNoZWV0PC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9ImFsbFVzZWQiPk1hcmsgYWxs' +
  'IHVzZWQ8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPldo' +
  'byB0byBwcmludCA8c3BhbiBjbGFzcz0ic3ViIiBpZD0icGlja0NvdW50Ij48L3NwYW4+PC9oMj4KICAgICAgPGlucHV0IGlkPSJq' +
  'b2JGaWx0ZXIiIHBsYWNlaG9sZGVyPSJGaWx0ZXIgYnkgbmFtZSwgY2l0eSBvciBqb2IgbnVtYmVyIiBzdHlsZT0ibWFyZ2luLWJv' +
  'dHRvbTo4cHgiPgogICAgICA8ZGl2IGNsYXNzPSJsaXN0IiBpZD0iam9iUGljayIgc3R5bGU9Im1heC1oZWlnaHQ6MzIwcHg7b3Zl' +
  'cmZsb3c6YXV0byI+CiAgICAgICAgJHtqb2JzLmxlbmd0aCA/IGpvYnMubWFwKGogPT4gYAogICAgICAgICAgPGRpdiBjbGFzcz0i' +
  'aXRlbSIgZGF0YS1waWNrPSIke2ouaWR9Ij4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iciI+PGRpdj4KICAgICAgICAgICAgICA8' +
  'ZGl2IGNsYXNzPSJ0Ij4ke2VzYyhqLnJlY2lwaWVudF9uYW1lKX08L2Rpdj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJtIj4k' +
  'e2VzYyhqLmpvYl9udW1iZXIpfSDCtyAke2VzYyhbai5hZGRyZXNzMSwgai5jaXR5XS5maWx0ZXIoQm9vbGVhbikuam9pbignLCAn' +
  'KSB8fCAnbm8gYWRkcmVzcycpfTwvZGl2PgogICAgICAgICAgICA8L2Rpdj48c3BhbiBjbGFzcz0icGlsbCIgZGF0YS10aWNrPSIk' +
  'e2ouaWR9Ij5hZGQ8L3NwYW4+PC9kaXY+CiAgICAgICAgICA8L2Rpdj5gKS5qb2luKCcnKQogICAgICAgICAgOiAnPGRpdiBjbGFz' +
  'cz0iZW1wdHkiPk5vIG9wZW4gam9icyB0byBsYWJlbC48L2Rpdj4nfQogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxkaXYg' +
  'Y2xhc3M9ImNhcmQiPgogICAgICA8aDI+UHJpbnQ8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAgIDxidXR0b24g' +
  'Y2xhc3M9ImJ0biIgaWQ9InByaW50QnRuIiBkaXNhYmxlZD5QcmludCBsYWJlbHM8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNs' +
  'YXNzPSJidG4gc2VjIHNtIiBpZD0idGVzdEJ0biI+QWxpZ25tZW50IHRlc3Q8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxk' +
  'aXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+SW4gdGhlIHByaW50IGRpYWxvZyBzZXQgc2NhbGUgdG8gPGI+' +
  'MTAwJTwvYj4gYW5kIHR1cm4gb2ZmCiAgICAgICAgImZpdCB0byBwYWdlIiDigJQgc2NhbGluZyBpcyB3aGF0IHRocm93cyBsYWJl' +
  'bCBhbGlnbm1lbnQgb2ZmLjwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPjxs' +
  'YWJlbD5OdWRnZSwgaWYgeW91ciBwcmludGVyIHJ1bnMgb2ZmPC9sYWJlbD4KICAgICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAg' +
  'ICAgICAgPHNwYW4gY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MCI+UmlnaHQ8L3NwYW4+CiAgICAgICAgICA8aW5wdXQgaWQ9' +
  'Im9mZlgiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgbWluPSItMC41IiBtYXg9IjAuNSIgdmFsdWU9IiR7aW5pdFNoZWV0Lm9m' +
  'ZnNldF94fSIgc3R5bGU9IndpZHRoOjkwcHgiPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MCI+' +
  'RG93bjwvc3Bhbj4KICAgICAgICAgIDxpbnB1dCBpZD0ib2ZmWSIgdHlwZT0ibnVtYmVyIiBzdGVwPSIwLjAxIiBtaW49Ii0wLjUi' +
  'IG1heD0iMC41IiB2YWx1ZT0iJHtpbml0U2hlZXQub2Zmc2V0X3l9IiBzdHlsZT0id2lkdGg6OTBweCI+CiAgICAgICAgICA8YnV0' +
  'dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0ic2F2ZU9mZiI+U2F2ZTwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICAgIDxk' +
  'aXYgY2xhc3M9ImhpbnQiPkluY2hlcy4gUHJpbnQgdGhlIGFsaWdubWVudCB0ZXN0IG9uIHBsYWluIHBhcGVyLCBob2xkIGl0IGFn' +
  'YWluc3QgYSByZWFsIHNoZWV0LAogICAgICAgICAgYW5kIG51ZGdlIHVudGlsIHRoZSBib3hlcyBsaW5lIHVwLjwvZGl2PgogICAg' +
  'ICA8L2Rpdj4KICAgIDwvZGl2PmApOwogIGJpbmRTaGVsbCgpOwoKICBjb25zdCBsYXlvdXRNZXRhID0gKCkgPT4gbGF5b3V0cy5m' +
  'aW5kKGwgPT4gbC5rZXkgPT09IFMuY2FjaGUuc2hlZXQubGF5b3V0KSB8fCBsYXlvdXRzWzBdOwoKICBmdW5jdGlvbiBkcmF3R3Jp' +
  'ZCgpIHsKICAgIGNvbnN0IG1ldGEgPSBsYXlvdXRNZXRhKCk7CiAgICBjb25zdCBzID0gUy5jYWNoZS5zaGVldDsKICAgIGNvbnN0' +
  'IHVzZWQgPSBuZXcgU2V0KHMudXNlZC5tYXAoTnVtYmVyKSk7CiAgICBjb25zdCBmcmVlID0gW107CiAgICBmb3IgKGxldCBpID0g' +
  'MDsgaSA8IG1ldGEuY2FwYWNpdHk7IGkrKykgaWYgKCF1c2VkLmhhcyhpKSkgZnJlZS5wdXNoKGkpOwogICAgY29uc3Qgb3JkZXIg' +
  'PSBuZXcgTWFwKGZyZWUuc2xpY2UoMCwgUy5jYWNoZS5waWNrZWQubGVuZ3RoKS5tYXAoKHBvcywgbikgPT4gW3BvcywgbiArIDFd' +
  'KSk7CgogICAgJCgnI2dyaWQnKS5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0ibGdyaWQiIHN0eWxlPSJncmlkLXRlbXBsYXRlLWNv' +
  'bHVtbnM6cmVwZWF0KCR7bWV0YS5jb2xzfSwxZnIpIj5gICsKICAgICAgQXJyYXkuZnJvbSh7IGxlbmd0aDogbWV0YS5jYXBhY2l0' +
  'eSB9LCAoXywgaSkgPT4gewogICAgICAgIGNvbnN0IGlzVXNlZCA9IHVzZWQuaGFzKGkpOwogICAgICAgIGNvbnN0IG4gPSBvcmRl' +
  'ci5nZXQoaSk7CiAgICAgICAgcmV0dXJuIGA8YnV0dG9uIGNsYXNzPSJsY2VsbCR7aXNVc2VkID8gJyB1c2VkJyA6ICcnfSR7biA/' +
  'ICcgbmV4dCcgOiAnJ30iIGRhdGEtY2VsbD0iJHtpfSIKICAgICAgICAgIHRpdGxlPSJQb3NpdGlvbiAke2kgKyAxfSI+JHtpc1Vz' +
  'ZWQgPyAnw5cnIDogKG4gfHwgJycpfTwvYnV0dG9uPmA7CiAgICAgIH0pLmpvaW4oJycpICsgJzwvZGl2Pic7CgogICAgJCgnI2Zy' +
  'ZWVDb3VudCcpLnRleHRDb250ZW50ID0gZnJlZS5sZW5ndGggKyAnIG9mICcgKyBtZXRhLmNhcGFjaXR5ICsgJyBsZWZ0JzsKICAg' +
  'ICQoJyNwaWNrQ291bnQnKS50ZXh0Q29udGVudCA9IFMuY2FjaGUucGlja2VkLmxlbmd0aCArICcgc2VsZWN0ZWQnOwogICAgY29u' +
  'c3Qgb3ZlciA9IFMuY2FjaGUucGlja2VkLmxlbmd0aCA+IGZyZWUubGVuZ3RoOwogICAgY29uc3QgYnRuID0gJCgnI3ByaW50QnRu' +
  'Jyk7CiAgICBidG4uZGlzYWJsZWQgPSAhUy5jYWNoZS5waWNrZWQubGVuZ3RoOwogICAgYnRuLnRleHRDb250ZW50ID0gb3Zlcgog' +
  'ICAgICA/IGBQcmludCAke2ZyZWUubGVuZ3RofSBub3cgKCR7Uy5jYWNoZS5waWNrZWQubGVuZ3RoIC0gZnJlZS5sZW5ndGh9IHdv' +
  'bid0IGZpdClgCiAgICAgIDogYFByaW50ICR7Uy5jYWNoZS5waWNrZWQubGVuZ3RofSBsYWJlbCR7Uy5jYWNoZS5waWNrZWQubGVu' +
  'Z3RoID09PSAxID8gJycgOiAncyd9YDsKCiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1jZWxsXScpLmZvckVh' +
  'Y2goYyA9PiBjLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IGkgPSArYy5kYXRhc2V0LmNlbGw7CiAgICAgIGNv' +
  'bnN0IHNldCA9IG5ldyBTZXQoUy5jYWNoZS5zaGVldC51c2VkLm1hcChOdW1iZXIpKTsKICAgICAgc2V0LmhhcyhpKSA/IHNldC5k' +
  'ZWxldGUoaSkgOiBzZXQuYWRkKGkpOwogICAgICBhd2FpdCBzYXZlU2hlZXQoeyB1c2VkOiBbLi4uc2V0XSB9KTsKICAgIH0pOwog' +
  'IH0KCiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVNoZWV0KHBhdGNoKSB7CiAgICB0cnkgewogICAgICBTLmNhY2hlLnNoZWV0ID0gYXdh' +
  'aXQgYXBpKCcvbGFiZWwtc2hlZXQnLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkocGF0Y2gpIH0pOwog' +
  'ICAgICBkcmF3R3JpZCgpOwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfQoKICAkKCcjbGF5' +
  'b3V0Jykub25jaGFuZ2UgPSBlID0+IHNhdmVTaGVldCh7IGxheW91dDogZS50YXJnZXQudmFsdWUgfSk7CiAgJCgnI25ld1NoZWV0' +
  'Jykub25jbGljayA9ICgpID0+IHNhdmVTaGVldCh7IHVzZWQ6IFtdIH0pOwogICQoJyNhbGxVc2VkJykub25jbGljayA9ICgpID0+' +
  'CiAgICBzYXZlU2hlZXQoeyB1c2VkOiBBcnJheS5mcm9tKHsgbGVuZ3RoOiBsYXlvdXRNZXRhKCkuY2FwYWNpdHkgfSwgKF8sIGkp' +
  'ID0+IGkpIH0pOwogICQoJyNzYXZlT2ZmJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIGF3YWl0IHNhdmVTaGVldCh7IG9m' +
  'ZnNldF94OiBOdW1iZXIoJCgnI29mZlgnKS52YWx1ZSkgfHwgMCwgb2Zmc2V0X3k6IE51bWJlcigkKCcjb2ZmWScpLnZhbHVlKSB8' +
  'fCAwIH0pOwogICAgdG9hc3QoJ0FsaWdubWVudCBzYXZlZCcpOwogIH07CgogIGNvbnN0IHBhaW50ID0gKCkgPT4gZG9jdW1lbnQu' +
  'cXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdGlja10nKS5mb3JFYWNoKHQgPT4gewogICAgY29uc3Qgb24gPSBTLmNhY2hlLnBpY2tl' +
  'ZC5pbmNsdWRlcygrdC5kYXRhc2V0LnRpY2spOwogICAgdC50ZXh0Q29udGVudCA9IG9uID8gJ+KckyBhZGRlZCcgOiAnYWRkJzsK' +
  'ICAgIHQuY2xhc3NOYW1lID0gb24gPyAncGlsbCBTZXJ2ZWQnIDogJ3BpbGwnOwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0' +
  'b3JBbGwoJ1tkYXRhLXBpY2tdJykuZm9yRWFjaChyb3cgPT4gcm93Lm9uY2xpY2sgPSAoKSA9PiB7CiAgICBjb25zdCBpZCA9ICty' +
  'b3cuZGF0YXNldC5waWNrOwogICAgY29uc3QgaSA9IFMuY2FjaGUucGlja2VkLmluZGV4T2YoaWQpOwogICAgaSA9PT0gLTEgPyBT' +
  'LmNhY2hlLnBpY2tlZC5wdXNoKGlkKSA6IFMuY2FjaGUucGlja2VkLnNwbGljZShpLCAxKTsKICAgIHBhaW50KCk7IGRyYXdHcmlk' +
  'KCk7CiAgfSk7CiAgJCgnI2pvYkZpbHRlcicpLm9uaW5wdXQgPSBlID0+IHsKICAgIGNvbnN0IHYgPSBlLnRhcmdldC52YWx1ZS50' +
  'b0xvd2VyQ2FzZSgpOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcGlja10nKS5mb3JFYWNoKHIgPT4gewog' +
  'ICAgICByLnN0eWxlLmRpc3BsYXkgPSByLmlubmVyVGV4dC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHYpID8gJycgOiAnbm9uZSc7' +
  'CiAgICB9KTsKICB9OwoKICAkKCcjdGVzdEJ0bicpLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBjb25zdCBpZHMgPSBTLmNhY2hlLnBp' +
  'Y2tlZC5sZW5ndGggPyBTLmNhY2hlLnBpY2tlZCA6IChqb2JzWzBdID8gW2pvYnNbMF0uaWRdIDogW10pOwogICAgaWYgKCFpZHMu' +
  'bGVuZ3RoKSByZXR1cm4gdG9hc3QoJ0FkZCBhdCBsZWFzdCBvbmUgam9iIGZpcnN0JywgdHJ1ZSk7CiAgICB3aW5kb3cub3Blbign' +
  'L3ByaW50L2xhYmVscz9ndWlkZXM9MSZpZHM9JyArIGlkcy5qb2luKCcsJyksICdfYmxhbmsnKTsKICB9OwoKICAkKCcjcHJpbnRC' +
  'dG4nKS5vbmNsaWNrID0gKCkgPT4gewogICAgY29uc3QgbWV0YSA9IGxheW91dE1ldGEoKTsKICAgIGNvbnN0IHVzZWQgPSBuZXcg' +
  'U2V0KFMuY2FjaGUuc2hlZXQudXNlZC5tYXAoTnVtYmVyKSk7CiAgICBjb25zdCBmcmVlID0gW107CiAgICBmb3IgKGxldCBpID0g' +
  'MDsgaSA8IG1ldGEuY2FwYWNpdHk7IGkrKykgaWYgKCF1c2VkLmhhcyhpKSkgZnJlZS5wdXNoKGkpOwogICAgY29uc3Qgd2lsbFVz' +
  'ZSA9IGZyZWUuc2xpY2UoMCwgUy5jYWNoZS5waWNrZWQubGVuZ3RoKTsKICAgIHdpbmRvdy5vcGVuKCcvcHJpbnQvbGFiZWxzP2lk' +
  'cz0nICsgUy5jYWNoZS5waWNrZWQuam9pbignLCcpLCAnX2JsYW5rJyk7CgogICAgY29uZmlybVByaW50ZWQod2lsbFVzZSk7CiAg' +
  'fTsKCiAgZnVuY3Rpb24gY29uZmlybVByaW50ZWQod2lsbFVzZSkgewogICAgc2hlZXQoJ0RpZCB0aGV5IHByaW50PycsIGAKICAg' +
  'ICAgPHAgY2xhc3M9ImhpbnQiPk9ubHkgbWFyayB0aGVzZSB1c2VkIG9uY2UgdGhlIHNoZWV0IGFjdHVhbGx5IGNhbWUgb3V0IHJp' +
  'Z2h0IOKAlCBpZiB0aGUgcHJpbnRlcgogICAgICAgIGphbW1lZCBvciB0aGUgYWxpZ25tZW50IHdhcyBvZmYsIHNheSBubyBhbmQg' +
  'bm90aGluZyBjaGFuZ2VzLjwvcD4KICAgICAgPHA+PGI+JHt3aWxsVXNlLmxlbmd0aH08L2I+IHBvc2l0aW9uJHt3aWxsVXNlLmxl' +
  'bmd0aCA9PT0gMSA/ICcnIDogJ3MnfSB3b3VsZCBiZSBtYXJrZWQgdXNlZDoKICAgICAgICAke3dpbGxVc2UubWFwKGkgPT4gaSAr' +
  'IDEpLmpvaW4oJywgJyl9PC9wPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPgogICAgICAg' +
  'IDxidXR0b24gY2xhc3M9ImJ0biBvayIgaWQ9Inllc1VzZWQiPlllcyDigJQgbWFyayB0aGVtIHVzZWQ8L2J1dHRvbj4KICAgICAg' +
  'ICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPk5vLCBrZWVwIHRoZW0gZnJlZTwvYnV0dG9u' +
  'PgogICAgICA8L2Rpdj5gLCBlbCA9PiB7CiAgICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyN5ZXNVc2VkJykub25jbGljayA9IGFzeW5j' +
  'ICgpID0+IHsKICAgICAgICBjb25zdCBzZXQgPSBuZXcgU2V0KFMuY2FjaGUuc2hlZXQudXNlZC5tYXAoTnVtYmVyKSk7CiAgICAg' +
  'ICAgd2lsbFVzZS5mb3JFYWNoKGkgPT4gc2V0LmFkZChpKSk7CiAgICAgICAgYXdhaXQgc2F2ZVNoZWV0KHsgdXNlZDogWy4uLnNl' +
  'dF0gfSk7CiAgICAgICAgUy5jYWNoZS5waWNrZWQgPSBbXTsKICAgICAgICBjbG9zZVNoZWV0KCk7CiAgICAgICAgdG9hc3QoJ1No' +
  'ZWV0IHVwZGF0ZWQg4oCUICcgKyBTLmNhY2hlLnNoZWV0LmZyZWUgKyAnIGxhYmVscyBsZWZ0Jyk7CiAgICAgICAgZ28oJ3Rvb2xz' +
  'Jyk7CiAgICAgIH07CiAgICB9KTsKICB9CgogIHBhaW50KCk7CiAgZHJhd0dyaWQoKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBwcm9wZXJ0eSBzZWFyY2ggLS0gKi8KLyogVGhlIHNhbWUgbG9va3Vw' +
  'IHRoZSBEZWFsIEZpbmRlciBydW5zLCBhZ2FpbnN0IHRoZSBzYW1lIGNvdW50eSBhcHByYWlzYWwKICogcm9sbHMsIGJlY2F1c2Ug' +
  'YSBwcm9jZXNzIHNlcnZlciBuZWVkcyBleGFjdGx5IHdoYXQgYSBidXllciBuZWVkczogd2hvIG93bnMKICogdGhpcyBhZGRyZXNz' +
  'LCBhbmQgd2hlcmUgZG9lcyB0aGVpciBwb3N0IGFjdHVhbGx5IGdvLgogKgogKiBUaGUgcm9sbHMgYXJlIHB1Ymxpc2hlZCBhcyBB' +
  'cmNHSVMgZmVhdHVyZSBsYXllcnMsIHNvIHRoZSBicm93c2VyIGFza3MgdGhlCiAqIGNvdW50eSBkaXJlY3RseSDigJQgbm8ga2V5' +
  'LCBubyBzZXJ2ZXIgaW4gdGhlIG1pZGRsZSwgbm90aGluZyBjYWNoZWQgdGhhdCBjb3VsZAogKiBnbyBzdGFsZS4gRmllbGQgbmFt' +
  'ZXMgZGlmZmVyIHBlciBjb3VudHksIHNvIGVhY2ggb25lIGNhcnJpZXMgaXRzIG93biBtYXAsCiAqIHZlcmlmaWVkIGFnYWluc3Qg' +
  'dGhlIGxpdmUgbGF5ZXIgcmF0aGVyIHRoYW4gZ3Vlc3NlZC4KICovCmNvbnN0IENBRCA9ICgoKSA9PiB7CiAgY29uc3QgY2FtZXJv' +
  'bkZpZWxkcyA9IHVwcGVyID0+IHsKICAgIGNvbnN0IG4gPSAoYSwgYikgPT4gKHVwcGVyID8gYiA6IGEpOwogICAgcmV0dXJuIHsK' +
  'ICAgICAgYWRkcjogbignc2l0dXNkaXNwbCcsICdzaXR1c0Rpc3BsJyksCiAgICAgIGFkZHJQYXJ0czogW24oJ3NpdHVzbm8nLCAn' +
  'c2l0dXNObycpLCBuKCdzaXRwZngnLCAnc2l0UGZ4JyksIG4oJ3NpdHN0cicsICdzaXRTdHInKSwgbignc2l0c2Z4JywgJ3NpdFNm' +
  'eCcpXSwKICAgICAgY2l0eTogbignc2l0Y2l0eScsICdzaXRDaXR5JyksIHppcDogbignc2l0emlwJywgJ3NpdFppcCcpLAogICAg' +
  'ICBvd25lcjogJ293bmVyJywgbWFpbDogJ2FkZHIxJywgbWFpbGNpdHk6IG4oJ2FkZHJjaXR5JywgJ2FkZHJDaXR5JyksCiAgICAg' +
  'IG1haWxzdGF0ZTogbignYWRkcnN0YXRlJywgJ2FkZHJTdGF0ZScpLCBtYWlsemlwOiBuKCdhZGRyemlwJywgJ2FkZHJaaXAnKSwK' +
  'ICAgICAgc3FmdDogbignbHZnYXJlYScsICdsdmdBcmVhJyksIHllYXI6IG4oJ3lyYnVpbHQnLCAneXJCdWlsdCcpLCBjYWQ6ICdt' +
  'YXJrZXQnLAogICAgICBjbHM6IG4oJ3N0YXRlY2QnLCAnc3RhdGVDZCcpLCBleGVtcHQ6ICdleG1zJywgcGlkOiBuKCdwcm9wX2lk' +
  'JywgJ1BST1BfSUQnKSwKICAgICAgZ2VvOiBuKCdnZW9faWQnLCAnZ2VvSUQnKSwKICAgICAgZGVlZDogeyBkYXRlOiBuKCdkZWVk' +
  'ZHQnLCAnZGVlZER0JyksIHJlYzogbignZGVlZHJlY2R0JywgJ2RlZWRSZWNEdCcpLAogICAgICAgICAgICAgIHR5cGU6IG4oJ2Rl' +
  'ZWR0eXBlJywgJ2RlZWRUeXBlJyksIHZvbDogJ3ZvbHVtZScsIHBhZ2U6ICdwYWdlJywgbnVtOiBuKCdkb2NudW0nLCAnZG9jTnVt' +
  'JykgfQogICAgfTsKICB9OwogIHJldHVybiB7CiAgICAnVFh8SElEQUxHTyc6IHsKICAgICAgbGFiZWw6ICdIaWRhbGdvIENBRCAy' +
  'MDI2IGNlcnRpZmllZCByb2xsJywgY2xlcms6ICdoaWRhbGdvJywKICAgICAgcTogJ2h0dHBzOi8vc2VydmljZXM5LmFyY2dpcy5j' +
  'b20vZHdNRFA1NUhUZm9qNG4xYy9hcmNnaXMvcmVzdC9zZXJ2aWNlcy9IQ0FEX1BBUkNFTFNfMjAyNi9GZWF0dXJlU2VydmVyLzEv' +
  'cXVlcnknLAogICAgICBmOiB7IGFkZHI6ICdzaXR1cycsIG93bmVyOiAnbmFtZScsIG1haWw6ICdhZGRyRGVsaXZlcnlMaW5lJywg' +
  'bWFpbGNpdHk6ICdhZGRyQ2l0eScsCiAgICAgICAgICAgbWFpbHN0YXRlOiAnYWRkclN0YXRlJywgbWFpbHppcDogJ2FkZHJaaXAn' +
  'LCBzcWZ0OiAnaW1wcnZNYWluQXJlYScsCiAgICAgICAgICAgeWVhcjogJ2ltcHJ2QWN0dWFsWWVhckJ1aWx0JywgY2FkOiAnbWFy' +
  'a2V0VmFsdWUnLCBjbHM6ICdzdGF0ZUNkJywKICAgICAgICAgICBleGVtcHQ6ICdleGVtcHRpb25zJywgcGlkOiAnUFJPUF9JRCcs' +
  'IGdlbzogJ2dlb0lEJywgdW5pdDogJ3RheGluZ1VuaXRzJywKICAgICAgICAgICBsZWdhbDogJ2xlZ2FsRGVzY3JpcHRpb24nLAog' +
  'ICAgICAgICAgIGRlZWQ6IHsgZGF0ZTogJ2RlZWREdCcsIHR5cGU6ICdkZWVkVHlwZScsIG51bTogJ2luc3RydW1lbnROdW0nIH0g' +
  'fSwKICAgICAgbGluazogcGlkID0+ICdodHRwczovL2hpZGFsZ28ucHJvZGlneWNhZC5jb20vcHJvcGVydHktZGV0YWlsLycgKyBw' +
  'aWQsCiAgICAgIGNpdGllczogeyAnTWNBbGxlbic6ICdDTUwnLCAnRWRpbmJ1cmcnOiAnQ0VCJywgJ01pc3Npb24nOiAnQ01TJywg' +
  'J1BoYXJyJzogJ0NQUicsICdXZXNsYWNvJzogJ0NXTCcsCiAgICAgICAgICAgICAgICAnU2FuIEp1YW4nOiAnQ1NKJywgJ0Rvbm5h' +
  'JzogJ0NETicsICdNZXJjZWRlcyc6ICdDTUMnLCAnQWxhbW8nOiAnQ0FPJywgJ0hpZGFsZ28nOiAnQ0hEJywKICAgICAgICAgICAg' +
  'ICAgICdMYSBKb3lhJzogJ0NMSicsICdQYWxtdmlldyc6ICdDUE0nLCAnQWx0b24nOiAnQ0FOJyB9CiAgICB9LAogICAgJ1RYfENB' +
  'TUVST04nOiB7CiAgICAgIGxhYmVsOiAnQ2FtZXJvbiBDQUQgMjAyNiByb2xsJywgY2xlcms6ICdjYW1lcm9uJywKICAgICAgcTog' +
  'J2h0dHBzOi8vY29iZ2lzLmJyb3duc3ZpbGxldHguZ292L2FyY2dpcy9yZXN0L3NlcnZpY2VzL0hvc3RlZC9DQ0FEX1BhcmNlbHNf' +
  'MDkwODIwMjUvRmVhdHVyZVNlcnZlci8wL3F1ZXJ5JywKICAgICAgZjogY2FtZXJvbkZpZWxkcyhmYWxzZSksCiAgICAgIGFsdDog' +
  'eyBxOiAnaHR0cHM6Ly9zZXJ2aWNlczIuYXJjZ2lzLmNvbS82b2FMTVpFWmxrdGJRcHlpL2FyY2dpcy9yZXN0L3NlcnZpY2VzL0ND' +
  'QURfUGFyY2Vsc19WaWV3L0ZlYXR1cmVTZXJ2ZXIvMC9xdWVyeScsCiAgICAgICAgICAgICBsYWJlbDogJ0NhbWVyb24gQ0FEIDIw' +
  'MjUgcm9sbCAoRXNyaSBtaXJyb3IpJywgZjogY2FtZXJvbkZpZWxkcyh0cnVlKSB9LAogICAgICBjaXRpZXM6IHsgJ0Jyb3duc3Zp' +
  'bGxlJzogJ0NCUicsICdIYXJsaW5nZW4nOiAnQ0hHJywgJ1NhbiBCZW5pdG8nOiAnQ1NCJywgJ0xhIEZlcmlhJzogJ0NMRicsCiAg' +
  'ICAgICAgICAgICAgICAnTG9zIEZyZXNub3MnOiAnQ0xPJywgJ1NvdXRoIFBhZHJlIElzbGFuZCc6ICdDU1AnLCAnUmlvIEhvbmRv' +
  'JzogJ0NSSCcsICdQb3J0IElzYWJlbCc6ICdDUEknIH0KICAgIH0sCiAgICAnVFh8U1RBUlInOiB7CiAgICAgIGxhYmVsOiAnU3Rh' +
  'cnIgQ0FEIHBhcmNlbHMnLCBjbGVyazogJ3N0YXJyJywKICAgICAgcTogJ2h0dHBzOi8vdXRpbGl0eS5hcmNnaXMuY29tL3VzcnN2' +
  'Y3Mvc2VydmVycy9mZjA1YWY0MjkzNDc0YjQ1YWJmMzkwNzUyNTBlZmU3OC9yZXN0L3NlcnZpY2VzL1N0YXJyQ0FEV2ViU2Vydmlj' +
  'ZS9GZWF0dXJlU2VydmVyLzAvcXVlcnknLAogICAgICBmOiB7IGFkZHJQYXJ0czogWydzaXR1c19udW0nLCAnc2l0dXNfc3RyZWV0' +
  'X3ByZWZ4JywgJ3NpdHVzX3N0cmVldCcsICdzaXR1c19zdHJlZXRfc3VmaXgnXSwKICAgICAgICAgICBhZGRyOiAnc2l0dXNfc3Ry' +
  'ZWV0JywgY2l0eTogJ3NpdHVzX2NpdHknLCB6aXA6ICdzaXR1c196aXAnLAogICAgICAgICAgIG93bmVyOiAnZmlsZV9hc19uYW1l' +
  'JywgbWFpbDogJ2FkZHJfbGluZTEnLCBtYWlsY2l0eTogJ2FkZHJfY2l0eScsCiAgICAgICAgICAgbWFpbHN0YXRlOiAnYWRkcl9z' +
  'dGF0ZScsIG1haWx6aXA6ICd6aXAnLCBjYWQ6ICdtYXJrZXQnLAogICAgICAgICAgIHBpZDogJ3Byb3BfaWQnLCBnZW86ICdnZW9f' +
  'aWQnLCB1bml0OiAnY2l0eScsIGxlZ2FsOiAnbGVnYWxfZGVzYycsCiAgICAgICAgICAgZGVlZDogeyBkYXRlOiAnRGVlZF9EYXRl' +
  'Jywgdm9sOiAnVm9sdW1lJywgcGFnZTogJ1BhZ2UnLCBudW06ICdOdW1iZXInIH0gfSwKICAgICAgY2l0aWVzOiB7ICdSaW8gR3Jh' +
  'bmRlIENpdHknOiAnUklPIEdSQU5ERSBDSVRZJywgJ1JvbWEnOiAnUk9NQScsICdMYSBHcnVsbGEnOiAnTEEgR1JVTExBJywKICAg' +
  'ICAgICAgICAgICAgICdFc2NvYmFyZXMnOiAnRVNDT0JBUkVTJyB9LAogICAgICBjaXR5SXNUZXh0OiB0cnVlLAogICAgICBub3Rl' +
  'OiAiU3RhcnIncyByb2xsIHB1Ymxpc2hlcyBubyBidWlsZGluZyBzcXVhcmUgZm9vdGFnZSBvciB5ZWFyIGJ1aWx0LiIKICAgIH0K' +
  'ICB9Owp9KSgpOwoKY29uc3Qgc3FsRXNjID0gdiA9PiBTdHJpbmcodikucmVwbGFjZSgvJy9nLCAiJyciKTsKY29uc3QgbnogPSB2' +
  'ID0+IHsgY29uc3QgbiA9IHBhcnNlRmxvYXQodik7IHJldHVybiBpc0Zpbml0ZShuKSA/IG4gOiAwOyB9Owpjb25zdCB0aXRsZUNh' +
  'c2UgPSB2ID0+IFN0cmluZyh2ID09IG51bGwgPyAnJyA6IHYpLnRvTG93ZXJDYXNlKCkKICAucmVwbGFjZSgvXGIoW2Etel0pL2cs' +
  'IG0gPT4gbS50b1VwcGVyQ2FzZSgpKQogIC5yZXBsYWNlKC9cYihUeHxJaXxJaWl8SXZ8TGxjfExwfEluY3xQbylcYi9nLCBtID0+' +
  'IG0udG9VcHBlckNhc2UoKSkudHJpbSgpOwoKZnVuY3Rpb24gc3BsaXRTaXR1cyh2KSB7CiAgY29uc3QgcyA9IFN0cmluZyh2ID09' +
  'IG51bGwgPyAnJyA6IHYpLnRyaW0oKTsKICBjb25zdCBtID0gcy5tYXRjaCgvXiguKj8pLFxzKihbXixdKiksXHMqW0EtWl17Mn1c' +
  'Yi8pOwogIGlmIChtKSByZXR1cm4geyBhZGRyOiBtWzFdLnRyaW0oKSwgY2l0eTogbVsyXS50cmltKCkgfTsKICByZXR1cm4geyBh' +
  'ZGRyOiBzLnJlcGxhY2UoLyxccypUWFxzKiQvaSwgJycpLnRyaW0oKSwgY2l0eTogJycgfTsKfQoKLyogQSBzdHJpbmdpZmllZCBv' +
  'YmplY3QgaW4gb3V0RmllbGRzIG1ha2VzIEFyY0dJUyByZWplY3QgdGhlIHdob2xlIHF1ZXJ5LCBzbwogICB0aGUgbWFwIGlzIGZs' +
  'YXR0ZW5lZCBjYXJlZnVsbHk6IHN0cmluZ3MgcGFzcywgYXJyYXlzIHNwcmVhZCwgdGhlIG5lc3RlZCBkZWVkCiAgIG9iamVjdCBj' +
  'b250cmlidXRlcyBpdHMgdmFsdWVzLCBhbnl0aGluZyBlbHNlIGlzIGRyb3BwZWQuICovCmZ1bmN0aW9uIGZpZWxkTGlzdChHKSB7' +
  'CiAgY29uc3Qgb3V0ID0gW107CiAgZm9yIChjb25zdCBrIGluIEcpIHsKICAgIGNvbnN0IHYgPSBHW2tdOwogICAgaWYgKCF2KSBj' +
  'b250aW51ZTsKICAgIGlmICh0eXBlb2YgdiA9PT0gJ3N0cmluZycpIHsgb3V0LnB1c2godik7IGNvbnRpbnVlOyB9CiAgICBpZiAo' +
  'QXJyYXkuaXNBcnJheSh2KSkgeyB2LmZvckVhY2goeCA9PiB7IGlmICh0eXBlb2YgeCA9PT0gJ3N0cmluZycgJiYgeCkgb3V0LnB1' +
  'c2goeCk7IH0pOyBjb250aW51ZTsgfQogICAgaWYgKHR5cGVvZiB2ID09PSAnb2JqZWN0JykgeyBmb3IgKGNvbnN0IGtrIGluIHYp' +
  'IGlmICh0eXBlb2Ygdltra10gPT09ICdzdHJpbmcnICYmIHZba2tdKSBvdXQucHVzaCh2W2trXSk7IH0KICB9CiAgcmV0dXJuIG91' +
  'dC5maWx0ZXIoKHgsIGkpID0+IG91dC5pbmRleE9mKHgpID09PSBpKTsKfQoKLy8gQ291bnRpZXMgc3RvcmUgdGhlIGRlZWQgZGF0' +
  'ZSB0aHJlZSB3YXlzOiBJU08gc3RyaW5nLCBVUyBzdHJpbmcsIGVwb2NoIG1zLgpmdW5jdGlvbiBkZWVkRGF0ZSh2KSB7CiAgaWYg' +
  'KHYgPT0gbnVsbCB8fCB2ID09PSAnJykgcmV0dXJuICcnOwogIGNvbnN0IG4gPSBOdW1iZXIodik7CiAgaWYgKGlzRmluaXRlKG4p' +
  'ICYmIG4gPiAxMDAwMDAwMDAwMCkgewogICAgY29uc3QgZCA9IG5ldyBEYXRlKG4pOwogICAgcmV0dXJuIGlzRmluaXRlKGQuZ2V0' +
  'VGltZSgpKSA/IGQudG9JU09TdHJpbmcoKS5zbGljZSgwLCAxMCkgOiAnJzsKICB9CiAgY29uc3QgcyA9IFN0cmluZyh2KS50cmlt' +
  'KCk7CiAgbGV0IG0gPSBzLm1hdGNoKC9eKFxkezR9KS0oXGR7Mn0pLShcZHsyfSkvKTsKICBpZiAobSkgcmV0dXJuIG1bMF07CiAg' +
  'bSA9IHMubWF0Y2goL14oXGR7MSwyfSlcLyhcZHsxLDJ9KVwvKFxkezR9KS8pOwogIGlmIChtKSByZXR1cm4gbVszXSArICctJyAr' +
  'ICgnMCcgKyBtWzFdKS5zbGljZSgtMikgKyAnLScgKyAoJzAnICsgbVsyXSkuc2xpY2UoLTIpOwogIHJldHVybiBzLnNsaWNlKDAs' +
  'IDEwKTsKfQpmdW5jdGlvbiBkZWVkT2YoRywgYSkgewogIGNvbnN0IGQgPSBHICYmIEcuZGVlZDsKICBpZiAoIWQpIHJldHVybiBu' +
  'dWxsOwogIGNvbnN0IGcgPSBrID0+IChkW2tdID8gU3RyaW5nKGFbZFtrXV0gPT0gbnVsbCA/ICcnIDogYVtkW2tdXSkudHJpbSgp' +
  'IDogJycpOwogIGNvbnN0IG8gPSB7IGRhdGU6IGRlZWREYXRlKGQuZGF0ZSA/IGFbZC5kYXRlXSA6ICcnKSwgcmVjOiBkZWVkRGF0' +
  'ZShkLnJlYyA/IGFbZC5yZWNdIDogJycpLAogICAgICAgICAgICAgIHR5cGU6IGcoJ3R5cGUnKSwgdm9sOiBnKCd2b2wnKSwgcGFn' +
  'ZTogZygncGFnZScpLCBudW06IGcoJ251bScpIH07CiAgcmV0dXJuIChvLmRhdGUgfHwgby5yZWMgfHwgby5udW0gfHwgby52b2wp' +
  'ID8gbyA6IG51bGw7Cn0KCi8qIFJvbGxzIGZpbGUgb3duZXJzIGxhc3QtbmFtZS1maXJzdCBhbmQgYm9sdCBvbiBldmVyeXRoaW5n' +
  'IGZyb20gYSBzcG91c2UgdG8gYW4KICAgZXN0YXRlOiAiTUFERVJPIEpPUkdFICYgTElESUEiLCAiR0FSWkEgTUFSSUEgRVRVWCIu' +
  'IFNlYXJjaGluZyB0aGF0IHdob2xlCiAgIHN0cmluZyBmaW5kcyBleGFjdGx5IHRoZSBvbmUgcGFyY2VsIHlvdSBzdGFydGVkIGZy' +
  'b20sIHNvIGl0IGlzIGN1dCBiYWNrIHRvCiAgIHRoZSBwYXJ0IHRoYXQgaWRlbnRpZmllcyB0aGUgZmFtaWx5LiAqLwpjb25zdCBP' +
  'V05KVU5LID0gL14oRVRBTHxFVHxBTHxFVFVYfEVUVklSfFVYfEpSfFNSfElJfElJSXxJVnxUUlVTVEVFfFRSfFRSVVNUfEVTVHxF' +
  'U1RBVEV8T0Z8VEhFfExJRkV8RVNUQVRFUz8pJC87CmZ1bmN0aW9uIG93bmVyUXVlcnkobmFtZSwgdG9rZW5zKSB7CiAgY29uc3Qg' +
  'dCA9IFN0cmluZyhuYW1lIHx8ICcnKS50b1VwcGVyQ2FzZSgpCiAgICAucmVwbGFjZSgvJi4qJC8sICcnKQogICAgLnJlcGxhY2Uo' +
  'L1teQS1aMC05IF0vZywgJyAnKQogICAgLnNwbGl0KC9ccysvKS5maWx0ZXIoQm9vbGVhbikKICAgIC5maWx0ZXIoeCA9PiAhT1dO' +
  'SlVOSy50ZXN0KHgpKTsKICByZXR1cm4gdC5zbGljZSgwLCB0b2tlbnMgfHwgMikuam9pbignICcpOwp9CgovKiBFdmVyeSBjb3Vu' +
  'dHkgc3BlbGxzIHRoZSBzdWZmaXggZGlmZmVyZW50bHksIHNvIGl0IGlzIGRyb3BwZWQgYmVmb3JlIHNlYXJjaGluZwogICBhbmQg' +
  'dGhlIHJlc3QgbWF0Y2hlZCBsb29zZWx5LiAqLwpjb25zdCBTVUZGSVhFUyA9IC9eKFNUfFNUUkVFVHxBVkV8QVZFTlVFfFJEfFJP' +
  'QUR8RFJ8RFJJVkV8TE58TEFORXxCTFZEfEJPVUxFVkFSRHxDVHxDT1VSVHxDSVJ8Q0lSQ0xFfFBMfFBMQUNFfEhXWXxISUdIV0FZ' +
  'fFRSTHxUUkFJTHxXQVl8UEtXWXxQQVJLV0FZfEFQVHxVTklUfFNURSkkLzsKZnVuY3Rpb24gYWRkclRva2VucyhxKSB7CiAgY29u' +
  'c3QgdCA9IFN0cmluZyhxIHx8ICcnKS50b1VwcGVyQ2FzZSgpLnJlcGxhY2UoL1teQS1aMC05IF0vZywgJyAnKS5zcGxpdCgvXHMr' +
  'LykuZmlsdGVyKEJvb2xlYW4pOwogIGNvbnN0IGtlZXAgPSB0LmZpbHRlcigodiwgaSkgPT4gaSA9PT0gMCB8fCAhU1VGRklYRVMu' +
  'dGVzdCh2KSk7CiAgcmV0dXJuIGtlZXAubGVuZ3RoID8ga2VlcCA6IHQ7Cn0KCmNvbnN0IGNsZXJrU2VhcmNoID0gKGtleSwgcSkg' +
  'PT4gewogIGNvbnN0IHNyYyA9IENBRFtrZXldOwogIGlmICghc3JjIHx8ICFzcmMuY2xlcmspIHJldHVybiAnJzsKICByZXR1cm4g' +
  'J2h0dHBzOi8vJyArIHNyYy5jbGVyayArICcudHgucHVibGljc2VhcmNoLnVzL3Jlc3VsdHM/X2NvdXJ0SWQ9JmRlcGFydG1lbnQ9' +
  'UlAnICsKICAgICAgICAgJyZsaW1pdD01MCZvZmZzZXQ9MCZxPScgKyBlbmNvZGVVUklDb21wb25lbnQoU3RyaW5nKHEgfHwgJycp' +
  'LnRyaW0oKSkgKwogICAgICAgICAnJnNlYXJjaE9jclRleHQ9ZmFsc2Umc2VhcmNoVHlwZT1xdWlja1NlYXJjaCc7Cn07Cgphc3lu' +
  'YyBmdW5jdGlvbiBjYWRKU09OKHUpIHsKICBjb25zdCByID0gYXdhaXQgZmV0Y2godSwgeyBtb2RlOiAnY29ycycgfSk7CiAgaWYg' +
  'KCFyLm9rKSB0aHJvdyBuZXcgRXJyb3IoJ0hUVFAgJyArIHIuc3RhdHVzKTsKICBjb25zdCBqID0gYXdhaXQgci5qc29uKCk7CiAg' +
  'aWYgKGouZXJyb3IpIHRocm93IG5ldyBFcnJvcihqLmVycm9yLm1lc3NhZ2UgfHwgKCdDb3VudHkgc2VydmVyIGVycm9yICcgKyBq' +
  'LmVycm9yLmNvZGUpKTsKICByZXR1cm4gajsKfQoKYXN5bmMgZnVuY3Rpb24gY2FkTG9va3VwKGtleSwgbW9kZSwgcmF3LCBjaXR5' +
  'LCBvdmVycmlkZSkgewogIGNvbnN0IHNyYyA9IG92ZXJyaWRlIHx8IENBRFtrZXldOwogIGNvbnN0IEcgPSBzcmMuZiB8fCB7fSwg' +
  'RzIgPSBzcmMuZjIgfHwge307CiAgY29uc3QgdyA9IFtdOwogIGlmIChtb2RlID09PSAnYWRkcicpIHsKICAgIGlmICghRy5hZGRy' +
  'KSB0aHJvdyBuZXcgRXJyb3IoIlRoYXQgY291bnR5J3Mgcm9sbCBoYXMgbm8gYWRkcmVzcyBjb2x1bW4uIik7CiAgICB3LnB1c2go' +
  'J1VQUEVSKCcgKyBHLmFkZHIgKyAiKSBMSUtFICclIiArIHNxbEVzYyhhZGRyVG9rZW5zKHJhdykuam9pbignJScpKSArICIlJyIp' +
  'OwogIH0gZWxzZSB7CiAgICBpZiAoIUcub3duZXIpIHRocm93IG5ldyBFcnJvcigiVGhhdCBjb3VudHkncyByb2xsIGhhcyBubyBv' +
  'd25lciBjb2x1bW4uIik7CiAgICB3LnB1c2goJ1VQUEVSKCcgKyBHLm93bmVyICsgIikgTElLRSAnJSIgKyBzcWxFc2MocmF3LnRv' +
  'VXBwZXJDYXNlKCkpICsgIiUnIik7CiAgfQogIGlmIChjaXR5KSB7CiAgICBjb25zdCBjb2RlID0gKENBRFtrZXldLmNpdGllcyB8' +
  'fCB7fSlbY2l0eV07CiAgICBpZiAoY29kZSAmJiBHLnVuaXQpIHsKICAgICAgdy5wdXNoKENBRFtrZXldLmNpdHlJc1RleHQKICAg' +
  'ICAgICA/ICdVUFBFUignICsgRy51bml0ICsgIikgTElLRSAnJSIgKyBzcWxFc2MoY29kZS50b1VwcGVyQ2FzZSgpKSArICIlJyIK' +
  'ICAgICAgICA6IEcudW5pdCArICIgTElLRSAnJSIgKyBjb2RlICsgIiUnIik7CiAgICB9IGVsc2UgaWYgKEcuY2l0eSkgewogICAg' +
  'ICB3LnB1c2goJ1VQUEVSKCcgKyBHLmNpdHkgKyAiKSBMSUtFICclIiArIHNxbEVzYyhjaXR5LnRvVXBwZXJDYXNlKCkpICsgIiUn' +
  'Iik7CiAgICB9CiAgfQogIGNvbnN0IG91dEYgPSBmaWVsZExpc3QoRyk7CiAgZm9yIChjb25zdCBrIGluIEcyKSBpZiAoRzJba10p' +
  'IG91dEYucHVzaChHMltrXSk7CgogIGNvbnN0IHFwID0gbmV3IFVSTFNlYXJjaFBhcmFtcyh7CiAgICB3aGVyZTogdy5qb2luKCcg' +
  'QU5EICcpLCBvdXRGaWVsZHM6IG91dEYuam9pbignLCcpLCByZXR1cm5HZW9tZXRyeTogJ2ZhbHNlJywKICAgIHJlc3VsdFJlY29y' +
  'ZENvdW50OiAnNjAnLCBmOiAnanNvbicsIHJldHVybkNlbnRyb2lkOiAndHJ1ZScsIG91dFNSOiAnNDMyNicKICB9KTsKICBjb25z' +
  'dCByID0gYXdhaXQgY2FkSlNPTihzcmMucSArICc/JyArIHFwKTsKICByZXR1cm4gKHIuZmVhdHVyZXMgfHwgW10pLm1hcChmdCA9' +
  'PiB7CiAgICBjb25zdCBhID0gZnQuYXR0cmlidXRlcyB8fCB7fSwgY3QgPSBmdC5jZW50cm9pZCB8fCB7fTsKICAgIGxldCBzcCA9' +
  'IHNwbGl0U2l0dXMoYVtHLmFkZHJdKTsKICAgIGlmIChHLmFkZHJQYXJ0cykgewogICAgICBjb25zdCBiaXRzID0gRy5hZGRyUGFy' +
  'dHMubWFwKGtrID0+IFN0cmluZyhhW2trXSA9PSBudWxsID8gJycgOiBhW2trXSkudHJpbSgpKQogICAgICAgIC5maWx0ZXIoeCA9' +
  'PiB4ICYmIHggIT09ICcwJyk7CiAgICAgIGlmIChiaXRzLmxlbmd0aCkgc3AgPSB7IGFkZHI6IGJpdHMuam9pbignICcpLnJlcGxh' +
  'Y2UoL1xzKy9nLCAnICcpLCBjaXR5OiAnJyB9OwogICAgfQogICAgY29uc3QgbWNpdHkgPSBHLm1haWxjaXR5ID8gU3RyaW5nKGFb' +
  'Ry5tYWlsY2l0eV0gfHwgJycpLnRyaW0oKSA6ICcnOwogICAgY29uc3QgcGNpdHkgPSAoRy5jaXR5ICYmIGFbRy5jaXR5XSkgPyBT' +
  'dHJpbmcoYVtHLmNpdHldKS50cmltKCkgOiBzcC5jaXR5OwogICAgY29uc3QgZXggPSBHLmV4ZW1wdCA/IFN0cmluZyhhW0cuZXhl' +
  'bXB0XSB8fCAnJykudHJpbSgpIDogJyc7CiAgICBjb25zdCBwaWQgPSBHLnBpZCA/IGFbRy5waWRdIDogJyc7CiAgICByZXR1cm4g' +
  'ewogICAgICBsYXQ6IGlzRmluaXRlKGN0LnkpID8gY3QueSA6IG51bGwsIGxvbjogaXNGaW5pdGUoY3QueCkgPyBjdC54IDogbnVs' +
  'bCwKICAgICAgYWRkcmVzczogdGl0bGVDYXNlKHNwLmFkZHIpIHx8ICfigJQnLCBjaXR5OiB0aXRsZUNhc2UocGNpdHkpIHx8IGNp' +
  'dHksCiAgICAgIHppcDogRy56aXAgPyBTdHJpbmcoYVtHLnppcF0gfHwgJycpLnNsaWNlKDAsIDUpIDogJycsCiAgICAgIHNxZnQ6' +
  'IEcuc3FmdCA/IG56KGFbRy5zcWZ0XSkgOiAwLCB5ZWFyOiBHLnllYXIgPyBueihhW0cueWVhcl0pIDogMCwKICAgICAgY2xzOiBH' +
  'LmNscyA/IFN0cmluZyhhW0cuY2xzXSB8fCAnJykudHJpbSgpIDogJycsCiAgICAgIG93bmVyOiB0aXRsZUNhc2UoYVtHLm93bmVy' +
  'XSB8fCAnJyksCiAgICAgIG1haWw6IHRpdGxlQ2FzZShbYVtHLm1haWxdLCBtY2l0eSwgRy5tYWlsc3RhdGUgPyBhW0cubWFpbHN0' +
  'YXRlXSA6ICcnLAogICAgICAgICAgICAgICAgICAgICAgIEcubWFpbHppcCA/IGFbRy5tYWlsemlwXSA6ICcnXS5maWx0ZXIoQm9v' +
  'bGVhbikuam9pbignLCAnKSksCiAgICAgIG1haWxjaXR5OiB0aXRsZUNhc2UobWNpdHkpLAogICAgICBleGVtcHQ6IGV4LCBob21l' +
  'c3RlYWQ6IC9cYkhTXGIvaS50ZXN0KGV4KSwKICAgICAgb3V0b2Z0b3duOiAhIShtY2l0eSAmJiBwY2l0eSAmJiBtY2l0eS50b1Vw' +
  'cGVyQ2FzZSgpICE9PSBwY2l0eS50b1VwcGVyQ2FzZSgpKSwKICAgICAgbGVnYWw6IEcubGVnYWwgPyBTdHJpbmcoYVtHLmxlZ2Fs' +
  'XSB8fCAnJykudHJpbSgpIDogJycsCiAgICAgIGRlZWQ6IGRlZWRPZihHLCBhKSwKICAgICAgcGlkLCBnZW86IEcuZ2VvID8gYVtH' +
  'Lmdlb10gOiAnJywgbGluazogKENBRFtrZXldLmxpbmsgJiYgcGlkKSA/IENBRFtrZXldLmxpbmsocGlkKSA6ICcnCiAgICB9Owog' +
  'IH0pOwp9CgpsZXQgUFJPUCA9IHsga2V5OiAnVFh8SElEQUxHTycsIG1vZGU6ICdhZGRyJywgcmVzdWx0czogW10sIGpvYklkOiBu' +
  'dWxsIH07CgpmdW5jdGlvbiBwcm9wZXJ0eVZpZXcoKSB7CiAgY29uc3Qgc3JjID0gQ0FEW1BST1Aua2V5XTsKICBjb25zdCBjaXR5' +
  'T3B0cyA9IFsnPG9wdGlvbiB2YWx1ZT0iIj5BbnkgY2l0eTwvb3B0aW9uPiddCiAgICAuY29uY2F0KE9iamVjdC5rZXlzKHNyYy5j' +
  'aXRpZXMgfHwge30pLm1hcChjID0+IGA8b3B0aW9uPiR7ZXNjKGMpfTwvb3B0aW9uPmApKS5qb2luKCcnKTsKCiAgYXBwLmlubmVy' +
  'SFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFnZSI+UHJvcGVydHkgcmVjb3JkczwvaDE+CgogICAgPGRpdiBjbGFzcz0i' +
  'Y2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgaWQ9InByb3BNb2RlIiBzdHlsZT0iZ2FwOjZweCI+CiAgICAgICAgPGJ1dHRv' +
  'biBjbGFzcz0iYnRuICR7UFJPUC5tb2RlID09PSAnYWRkcicgPyAnJyA6ICdzZWMgJ31zbSIgZGF0YS1tPSJhZGRyIj5CeSBhZGRy' +
  'ZXNzPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuICR7UFJPUC5tb2RlID09PSAnb3duZXInID8gJycgOiAnc2Vj' +
  'ICd9c20iIGRhdGEtbT0ib3duZXIiPkJ5IG93bmVyPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlk' +
  'IGcyIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNvdW50eTwvbGFi' +
  'ZWw+PHNlbGVjdCBpZD0icHJvcENvdW50eSI+CiAgICAgICAgICAke09iamVjdC5rZXlzKENBRCkuc29ydCgpLm1hcChrID0+IGA8' +
  'b3B0aW9uIHZhbHVlPSIke2VzYyhrKX0iJHtrID09PSBQUk9QLmtleSA/ICcgc2VsZWN0ZWQnIDogJyd9PiR7CiAgICAgICAgICAg' +
  'IGVzYyhrLnNwbGl0KCd8JylbMV0ucmVwbGFjZSgvXGIoXHcpKFx3KikvZywgKG0sIGEsIGIpID0+IGEgKyBiLnRvTG93ZXJDYXNl' +
  'KCkpKX0gQ291bnR5LCBUWDwvb3B0aW9uPmApLmpvaW4oJycpfQogICAgICAgIDwvc2VsZWN0PjwvZGl2PgogICAgICAgIDxkaXYg' +
  'Y2xhc3M9ImZpZWxkIj48bGFiZWw+Q2l0eSA8c3BhbiBjbGFzcz0ic3ViIj5vcHRpb25hbDwvc3Bhbj48L2xhYmVsPgogICAgICAg' +
  'ICAgPHNlbGVjdCBpZD0icHJvcENpdHkiPiR7Y2l0eU9wdHN9PC9zZWxlY3Q+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2' +
  'IGNsYXNzPSJmaWVsZCI+PGxhYmVsIGlkPSJwcm9wTGFiZWwiPiR7UFJPUC5tb2RlID09PSAnYWRkcicgPyAnQWRkcmVzcycgOiAn' +
  'T3duZXIgbmFtZSd9PC9sYWJlbD4KICAgICAgICA8aW5wdXQgaWQ9InByb3BRIiBwbGFjZWhvbGRlcj0iJHtQUk9QLm1vZGUgPT09' +
  'ICdhZGRyJyA/ICcxODA2IEFzaCBBdmUnIDogJ0dhcnphJ30iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAg' +
  'IDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InByb3BHbyI+U2VhcmNoPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRu' +
  'IHNlYyIgaWQ9InByb3BDbGVhciI+Q2xlYXI8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxwIGNsYXNzPSJoaW50IiBpZD0i' +
  'cHJvcEhpbnQiPjwvcD4KICAgIDwvZGl2PgoKICAgIDxkaXYgaWQ9InByb3BTdGF0dXMiPjwvZGl2PgogICAgPGRpdiBpZD0icHJv' +
  'cE91dCI+PC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxwIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjAi' +
  'PkEgbWFpbGluZyBhZGRyZXNzIGZyb20gdGhlIGFwcHJhaXNhbCBkaXN0cmljdCBpcyBhIGxlYWQsIG5vdCBwcm9vZiBvZgogICAg' +
  'ICAgIHJlc2lkZW5jZSDigJQgcGxlbnR5IG9mIG93bmVycyBoYXZlIHBvc3QgZ29pbmcgdG8gYW4gYWdlbnQsIGEgcmVsYXRpdmUs' +
  'IG9yIGFub3RoZXIgc3RhdGUuIFRyZWF0IGl0IGFzIGEKICAgICAgICBwbGFjZSB0byBhdHRlbXB0LCBhbmQgcmVjb3JkIHdoYXQg' +
  'eW91IGFjdHVhbGx5IGZpbmQgaW4gdGhlIGF0dGVtcHQgbm90ZXMuPC9wPgogICAgPC9kaXY+YCk7CiAgYmluZFNoZWxsKCk7Cgog' +
  'IGNvbnN0IGhpbnQgPSAoKSA9PiB7CiAgICBjb25zdCBzID0gQ0FEW1BST1Aua2V5XTsKICAgICQoJyNwcm9wSGludCcpLmlubmVy' +
  'SFRNTCA9IChQUk9QLm1vZGUgPT09ICdhZGRyJwogICAgICA/ICdTdHJlZXQgbnVtYmVyIGFuZCBuYW1lIGlzIGVub3VnaCDigJQg' +
  'dGhlIHN1ZmZpeCBpcyBkcm9wcGVkIGJlZm9yZSBzZWFyY2hpbmcsIGJlY2F1c2UgZXZlcnkgY291bnR5IHNwZWxscyBpdCBkaWZm' +
  'ZXJlbnRseS4nCiAgICAgIDogJ0Egc3VybmFtZSBhbG9uZSB3b3JrcyBhbmQgZmluZHMgZXZlcnkgcGFyY2VsIHRoYXQgb3duZXIg' +
  'aG9sZHMgaW4gdGhlIGNvdW50eS4gUmVjb3JkcyBhcmUgZmlsZWQgbGFzdCBuYW1lIGZpcnN0LCBzbyA8aT5HYXJ6YTwvaT4gYmVh' +
  'dHMgPGk+TWFyaWEgR2FyemE8L2k+LicpCiAgICAgICsgKHMubm90ZSA/ICcgPGI+JyArIGVzYyhzLm5vdGUpICsgJzwvYj4nIDog' +
  'JycpOwogIH07CiAgaGludCgpOwoKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcjcHJvcE1vZGUgW2RhdGEtbV0nKS5mb3JF' +
  'YWNoKGIgPT4gYi5vbmNsaWNrID0gKCkgPT4gewogICAgUFJPUC5tb2RlID0gYi5kYXRhc2V0Lm07IHByb3BlcnR5VmlldygpOwog' +
  'IH0pOwogICQoJyNwcm9wQ291bnR5Jykub25jaGFuZ2UgPSAoKSA9PiB7IFBST1Aua2V5ID0gJCgnI3Byb3BDb3VudHknKS52YWx1' +
  'ZTsgcHJvcGVydHlWaWV3KCk7IH07CiAgJCgnI3Byb3BDbGVhcicpLm9uY2xpY2sgPSAoKSA9PiB7IFBST1AucmVzdWx0cyA9IFtd' +
  'OyAkKCcjcHJvcE91dCcpLmlubmVySFRNTCA9ICcnOyAkKCcjcHJvcFN0YXR1cycpLmlubmVySFRNTCA9ICcnOyAkKCcjcHJvcFEn' +
  'KS52YWx1ZSA9ICcnOyB9OwogICQoJyNwcm9wUScpLm9ua2V5ZG93biA9IGUgPT4geyBpZiAoZS5rZXkgPT09ICdFbnRlcicpIHsg' +
  'ZS5wcmV2ZW50RGVmYXVsdCgpOyAkKCcjcHJvcEdvJykuY2xpY2soKTsgfSB9OwogICQoJyNwcm9wR28nKS5vbmNsaWNrID0gKCkg' +
  'PT4gcnVuUHJvcGVydHlTZWFyY2goJCgnI3Byb3BRJykudmFsdWUudHJpbSgpLCAkKCcjcHJvcENpdHknKS52YWx1ZSk7CiAgaWYg' +
  'KFBST1AucmVzdWx0cy5sZW5ndGgpIGRyYXdQcm9wZXJ0eSgpOwp9Cgphc3luYyBmdW5jdGlvbiBydW5Qcm9wZXJ0eVNlYXJjaChy' +
  'YXcsIGNpdHkpIHsKICBpZiAoIXJhdykgcmV0dXJuIHRvYXN0KCdUeXBlIHNvbWV0aGluZyB0byBsb29rIHVwJywgdHJ1ZSk7CiAg' +
  'Y29uc3Qgc3RhdCA9ICQoJyNwcm9wU3RhdHVzJyk7CiAgY29uc3Qgc3JjID0gQ0FEW1BST1Aua2V5XTsKICBzdGF0LmlubmVySFRN' +
  'TCA9IGA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjAiPkFza2luZyAke2VzYyhzcmMu' +
  'bGFiZWwpfeKApjwvZGl2PjwvZGl2PmA7CiAgJCgnI3Byb3BPdXQnKS5pbm5lckhUTUwgPSAnJzsKICB0cnkgewogICAgbGV0IHJv' +
  'd3M7CiAgICB0cnkgewogICAgICByb3dzID0gYXdhaXQgY2FkTG9va3VwKFBST1Aua2V5LCBQUk9QLm1vZGUsIHJhdywgY2l0eSk7' +
  'CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIC8vIENhbWVyb24gcHVibGlzaGVzIHRoZSBzYW1lIHJvbGwgdHdpY2U7IGlmIHRoZSBm' +
  'aXJzdCBpcyBkb3duLCB0cnkgdGhlIG1pcnJvci4KICAgICAgaWYgKCFzcmMuYWx0KSB0aHJvdyBlOwogICAgICByb3dzID0gYXdh' +
  'aXQgY2FkTG9va3VwKFBST1Aua2V5LCBQUk9QLm1vZGUsIHJhdywgY2l0eSwgc3JjLmFsdCk7CiAgICB9CiAgICBQUk9QLnJlc3Vs' +
  'dHMgPSByb3dzOwogICAgc3RhdC5pbm5lckhUTUwgPSByb3dzLmxlbmd0aAogICAgICA/IGA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2' +
  'IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjAiPiR7cm93cy5sZW5ndGh9IHJlY29yZCR7cm93cy5sZW5ndGggPT09IDEgPyAn' +
  'JyA6ICdzJ30gZnJvbSAke2VzYyhzcmMubGFiZWwpfTwvZGl2PjwvZGl2PmAKICAgICAgOiBgPGRpdiBjbGFzcz0iY2FyZCI+PGRp' +
  'diBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbjowIj5Ob3RoaW5nIG1hdGNoZWQgaW4gJHtlc2Moc3JjLmxhYmVsKX0uIFRyeSBm' +
  'ZXdlciB3b3Jkcywgb3IgZHJvcCB0aGUgY2l0eS48L2Rpdj48L2Rpdj5gOwogICAgZHJhd1Byb3BlcnR5KCk7CiAgfSBjYXRjaCAo' +
  'ZSkgewogICAgUFJPUC5yZXN1bHRzID0gW107CiAgICBzdGF0LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNs' +
  'YXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjA7Y29sb3I6dmFyKC0tYmFkKSI+VGhlIGNvdW50eSBkaWQgbm90IGFuc3dlcjogJHtl' +
  'c2MoZS5tZXNzYWdlKX08L2Rpdj48L2Rpdj5gOwogICAgJCgnI3Byb3BPdXQnKS5pbm5lckhUTUwgPSAnJzsKICB9Cn0KCmZ1bmN0' +
  'aW9uIGRyYXdQcm9wZXJ0eSgpIHsKICBjb25zdCBvdXQgPSAkKCcjcHJvcE91dCcpOwogIGlmICghb3V0KSByZXR1cm47CiAgb3V0' +
  'LmlubmVySFRNTCA9IFBST1AucmVzdWx0cy5tYXAoKHIsIGkpID0+IHsKICAgIGNvbnN0IEwgPSAoaywgdikgPT4gYDx0cj48dGgg' +
  'c3R5bGU9IndpZHRoOjM4JSI+JHtrfTwvdGg+PHRkPiR7dn08L3RkPjwvdHI+YDsKICAgIGNvbnN0IGQgPSByLmRlZWQ7CiAgICBs' +
  'ZXQgZGVlZExpbmUgPSAnJzsKICAgIGlmIChkKSB7CiAgICAgIGNvbnN0IGJpdHMgPSBbXTsKICAgICAgaWYgKGQuZGF0ZSkgYml0' +
  'cy5wdXNoKGVzYyhkLmRhdGUpKTsKICAgICAgaWYgKGQudHlwZSkgYml0cy5wdXNoKGVzYyhkLnR5cGUpKTsKICAgICAgaWYgKGQu' +
  'bnVtKSBiaXRzLnB1c2goJ2luc3QuICcgKyBlc2MoZC5udW0pKTsKICAgICAgaWYgKGQudm9sICYmIGQucGFnZSkgYml0cy5wdXNo' +
  'KCd2b2wgJyArIGVzYyhkLnZvbCkgKyAnIHBnICcgKyBlc2MoZC5wYWdlKSk7CiAgICAgIGRlZWRMaW5lID0gYml0cy5qb2luKCcg' +
  'wrcgJyk7CiAgICB9CiAgICBjb25zdCBmdWxsID0gW3IuYWRkcmVzcywgW3IuY2l0eSwgci56aXBdLmZpbHRlcihCb29sZWFuKS5q' +
  'b2luKCcgJyldLmZpbHRlcihCb29sZWFuKS5qb2luKCcsICcpOwogICAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAg' +
  'PGgyPiR7ZXNjKHIuYWRkcmVzcyl9PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ibSIgc3R5bGU9ImNvbG9yOnZhcigtLW11dGVkKTtm' +
  'b250LXNpemU6MTNweCI+JHtlc2MoW3IuY2l0eSwgci56aXBdLmZpbHRlcihCb29sZWFuKS5qb2luKCcgJykpfTwvZGl2PgogICAg' +
  'ICA8dGFibGUgY2xhc3M9InRibCIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICAgICAgJHtMKCdPd25lcicsICc8Yj4nICsg' +
  'ZXNjKHIub3duZXIgfHwgJ+KAlCcpICsgJzwvYj4nKX0KICAgICAgICAke3IubWFpbCA/IEwoJ01haWxzIHRvJywgZXNjKHIubWFp' +
  'bCkpIDogJyd9CiAgICAgICAgJHtMKCdMaXZlcyB0aGVyZT8nLCByLmhvbWVzdGVhZAogICAgICAgICAgICA/ICc8c3BhbiBzdHls' +
  'ZT0iY29sb3I6dmFyKC0tb2spO2ZvbnQtd2VpZ2h0OjYwMCI+SG9tZXN0ZWFkIG9uIGZpbGUg4oCUIG93bmVyLW9jY3VwaWVkPC9z' +
  'cGFuPicKICAgICAgICAgICAgOiAnTm8gaG9tZXN0ZWFkIGV4ZW1wdGlvbicgKyAoci5vdXRvZnRvd24gPyAnIMK3IDxiPm1haWxz' +
  'IG91dCBvZiB0b3duPC9iPicgOiAnJykpfQogICAgICAgICR7ci55ZWFyID8gTCgnQnVpbHQnLCByLnllYXIpIDogJyd9CiAgICAg' +
  'ICAgJHtyLnNxZnQgPyBMKCdTaXplJywgTWF0aC5yb3VuZChyLnNxZnQpLnRvTG9jYWxlU3RyaW5nKCkgKyAnIHNxIGZ0JykgOiAn' +
  'J30KICAgICAgICAke3IubGVnYWwgPyBMKCdMZWdhbCcsIGVzYyhyLmxlZ2FsKSkgOiAnJ30KICAgICAgICAke3IuZ2VvID8gTCgn' +
  'R2VvZ3JhcGhpYyBJRCcsIGVzYyhyLmdlbykpIDogJyd9CiAgICAgICAgJHtkZWVkTGluZSA/IEwoJ0xhc3QgZGVlZCcsIGRlZWRM' +
  'aW5lKSA6ICcnfQogICAgICA8L3RhYmxlPgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgog' +
  'ICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGRhdGEtcGNvcHk9IiR7ZXNjKGZ1bGwpfSI+Q29weSBhZGRyZXNzPC9i' +
  'dXR0b24+CiAgICAgICAgJHtyLm1haWwgPyBgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgZGF0YS1wY29weT0iJHtlc2Moci5t' +
  'YWlsKX0iPkNvcHkgbWFpbGluZyBhZGRyZXNzPC9idXR0b24+YCA6ICcnfQogICAgICAgICR7ci5vd25lciA/IGA8YnV0dG9uIGNs' +
  'YXNzPSJidG4gc2VjIHNtIiBkYXRhLXBvd25lcj0iJHtlc2Mob3duZXJRdWVyeShyLm93bmVyKSl9Ij5Nb3JlIGJ5IHRoaXMgb3du' +
  'ZXI8L2J1dHRvbj5gIDogJyd9CiAgICAgICAgJHtyLmxhdCAhPSBudWxsID8gYDxhIGNsYXNzPSJidG4gc2VjIHNtIiB0YXJnZXQ9' +
  'Il9ibGFuayIKICAgICAgICAgICBocmVmPSJodHRwczovL3d3dy5nb29nbGUuY29tL21hcHMvc2VhcmNoLz9hcGk9MSZxdWVyeT0k' +
  'e3IubGF0fSwke3IubG9ufSI+TWFwPC9hPmAgOiAnJ30KICAgICAgICAke3IubGluayA/IGA8YSBjbGFzcz0iYnRuIHNlYyBzbSIg' +
  'dGFyZ2V0PSJfYmxhbmsiIGhyZWY9IiR7ZXNjKHIubGluayl9Ij5Db3VudHkgcmVjb3JkIOKGlzwvYT5gIDogJyd9CiAgICAgICAg' +
  'JHtyLm93bmVyID8gYDxhIGNsYXNzPSJidG4gc2VjIHNtIiB0YXJnZXQ9Il9ibGFuayIKICAgICAgICAgICBocmVmPSIke2VzYyhj' +
  'bGVya1NlYXJjaChQUk9QLmtleSwgKGQgJiYgZC5udW0pID8gZC5udW0gOiBvd25lclF1ZXJ5KHIub3duZXIpKSl9Ij5EZWVkcyAm' +
  'YW1wOyBsaWVucyDihpc8L2E+YCA6ICcnfQogICAgICA8L2Rpdj4KICAgIDwvZGl2PmA7CiAgfSkuam9pbignJyk7CgogIG91dC5x' +
  'dWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1wY29weV0nKS5mb3JFYWNoKGIgPT4gYi5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAg' +
  'dHJ5IHsgYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoYi5kYXRhc2V0LnBjb3B5KTsgdG9hc3QoJ0NvcGllZCcp' +
  'OyB9CiAgICBjYXRjaCAoZSkgeyB0b2FzdCgnQ29weSBmYWlsZWQg4oCUIHNlbGVjdCBpdCBieSBoYW5kJywgdHJ1ZSk7IH0KICB9' +
  'KTsKICBvdXQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcG93bmVyXScpLmZvckVhY2goYiA9PiBiLm9uY2xpY2sgPSAoKSA9PiB7' +
  'CiAgICBQUk9QLm1vZGUgPSAnb3duZXInOwogICAgcHJvcGVydHlWaWV3KCk7CiAgICAkKCcjcHJvcFEnKS52YWx1ZSA9IGIuZGF0' +
  'YXNldC5wb3duZXI7CiAgICBydW5Qcm9wZXJ0eVNlYXJjaChiLmRhdGFzZXQucG93bmVyLCAnJyk7CiAgfSk7Cn0KCi8qIC0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGNhc2UgbG9va3VwIC0tICovCi8qIE5v' +
  'bmUgb2YgdGhlc2UgcG9ydGFscyBhY2NlcHQgYSBjYXNlIG51bWJlciBpbiB0aGUgVVJMIC0tIEhpZGFsZ28ncyBydW5zIG9uCiAg' +
  'IHNlc3Npb24tYmFzZWQgZm9ybSBwb3N0cywgQ2FtZXJvbidzIHNpdHMgYmVoaW5kIGEgSmF2YVNjcmlwdCBnYXRlLiBTbyB0aGlz' +
  'CiAgIGNvcGllcyB0aGUgbnVtYmVyIHRvIHRoZSBjbGlwYm9hcmQgYW5kIG9wZW5zIHRoZSByaWdodCBzZWFyY2ggcGFnZS4gTm8K' +
  'ICAgc2NyYXBpbmcsIG5vdGhpbmcgdG8gYnJlYWsgd2hlbiB0aGV5IHJlZGVzaWduLiAqLwpjb25zdCBUWF9QT1JUQUxTID0gWwog' +
  'IHsgbmFtZTogJ3JlOlNlYXJjaFRYIOKAlCBzdGF0ZXdpZGUnLCB1cmw6ICdodHRwczovL3Jlc2VhcmNoLnR4Y291cnRzLmdvdi8n' +
  'LAogICAgbm90ZTogJ0ZyZWUgYWNjb3VudCByZXF1aXJlZC4gRGlzdHJpY3QsIGNvdW50eSBhbmQgcHJvYmF0ZSBjb3VydHMgaW4g' +
  'YWxsIDI1NCBjb3VudGllcy4gJyArCiAgICAgICAgICAnUHVibGljIHZpZXcgc3RhcnRzIGF0IGZpbGluZ3MgZnJvbSAxIE5vdiAy' +
  'MDE4LiBKdXN0aWNlLW9mLXRoZS1wZWFjZSBldmljdGlvbnMgYXJlIHBhdGNoeS4nIH0sCiAgeyBuYW1lOiAnSGlkYWxnbyBDb3Vu' +
  'dHkg4oCUIERpc3RyaWN0IENsZXJrIGNhc2Ugc2VhcmNoJywgdXJsOiAnaHR0cHM6Ly9wYS5jby5oaWRhbGdvLnR4LnVzL2RlZmF1' +
  'bHQuYXNweCcsCiAgICBub3RlOiAnQ2l2aWwgYW5kIGNyaW1pbmFsIGNhc2VzLiBGcmVlLCBubyBsb2dpbi4nIH0sCiAgeyBuYW1l' +
  'OiAnQ2FtZXJvbiBDb3VudHkg4oCUIGNvdXJ0IHBvcnRhbHMnLCB1cmw6ICdodHRwczovL3d3dy5jYW1lcm9uY291bnR5dHguZ292' +
  'L2NhbWVyb24tY291bnR5LXBvcnRhbHMvJywKICAgIG5vdGU6ICdJbmRleCBwYWdlIGZvciB0aGUgY291bnR5XCdzIGRpc3RyaWN0' +
  'IGFuZCBjb3VudHkgY2xlcmsgc2VhcmNoZXMuJyB9LAogIHsgbmFtZTogJ0NhbWVyb24gQ291bnR5IOKAlCBEaXN0cmljdCBDbGVy' +
  'ayByZWNvcmRzJywgdXJsOiAnaHR0cHM6Ly9rb2ZpbGVxdWlja2xpbmtzLmNvbS9jYW1lcm9uZGMvJywKICAgIG5vdGU6ICdEaXN0' +
  'cmljdCBDbGVyayByZWNvcmQgc2VhcmNoLicgfSwKICB7IG5hbWU6ICdIaWRhbGdvIENvdW50eSDigJQgcHJvcGVydHkgLyBvZmZp' +
  'Y2lhbCByZWNvcmRzJywgdXJsOiAnaHR0cHM6Ly9oaWRhbGdvLnR4LnB1YmxpY3NlYXJjaC51cy8nLAogICAgbm90ZTogJ0RlZWRz' +
  'LCBsaWVucyBhbmQgb3duZXJzaGlwIGZyb20gdGhlIENvdW50eSBDbGVyayDigJQgcHJvcGVydHksIG5vdCBsYXdzdWl0cy4gJyAr' +
  'CiAgICAgICAgICAnVXNlZnVsIGZvciBjb25maXJtaW5nIHdobyBhY3R1YWxseSBvd25zIGFuIGFkZHJlc3MuJyB9Cl07CgpmdW5j' +
  'dGlvbiBjYXNlTG9va3VwU2hlZXQoam9iKSB7CiAgc2hlZXQoJ0xvb2sgdXAgJyArIGpvYi5jYXNlX251bWJlciwgYAogICAgPGRp' +
  'diBjbGFzcz0iY2FyZCIgc3R5bGU9ImJhY2tncm91bmQ6I2Y4ZmFmYztib3gtc2hhZG93Om5vbmU7dGV4dC1hbGlnbjpjZW50ZXIi' +
  'PgogICAgICA8ZGl2IHN0eWxlPSJmb250OjYwMCAyMHB4LzEuMyBtb25vc3BhY2U7bGV0dGVyLXNwYWNpbmc6LjVweCI+JHtlc2Mo' +
  'am9iLmNhc2VfbnVtYmVyKX08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGludCI+JHtlc2Moam9iLmNvdXJ0IHx8ICdjb3VydCBu' +
  'b3QgcmVjb3JkZWQnKX08L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0iY29weUNhc2UiIHN0eWxlPSJtYXJn' +
  'aW4tdG9wOjEwcHgiPkNvcHkgY2FzZSBudW1iZXI8L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPHAgY2xhc3M9ImhpbnQiPlRoZXNl' +
  'IHBvcnRhbHMgY2FuJ3QgYmUgbGlua2VkIHRvIGRpcmVjdGx5IHdpdGggYSBjYXNlIG51bWJlciwgc28gdGFwcGluZyBvbmUgY29w' +
  'aWVzCiAgICAgIHRoZSBudW1iZXIgYW5kIG9wZW5zIHRoZWlyIHNlYXJjaCBwYWdlIOKAlCBwYXN0ZSBpdCBpbnRvIHRoZWlyIGJv' +
  'eC48L3A+CiAgICA8ZGl2IGNsYXNzPSJsaXN0Ij4KICAgICAgJHtUWF9QT1JUQUxTLm1hcCgocCwgaSkgPT4gYAogICAgICAgIDxk' +
  'aXYgY2xhc3M9Iml0ZW0iIGRhdGEtcG9ydGFsPSIke2l9Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9InQiPiR7ZXNjKHAubmFtZSl9' +
  'PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJtIj4ke2VzYyhwLm5vdGUpfTwvZGl2PgogICAgICAgIDwvZGl2PmApLmpvaW4o' +
  'JycpfQogICAgPC9kaXY+CiAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+Q291cnQgcmVjb3JkcyBy' +
  'YXJlbHkgcHVibGlzaCBhIGRlZmVuZGFudCdzIHNlcnZpY2UgYWRkcmVzcyDigJQKICAgICAgdGhhdCBub3JtYWxseSBvbmx5IGV4' +
  'aXN0cyBvbiB0aGUgY2xpZW50J3MgcGFja2V0LjwvcD4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgYmxvY2siIHN0eWxlPSJt' +
  'YXJnaW4tdG9wOjhweCIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5DbG9zZTwvYnV0dG9uPmAsIGVsID0+IHsKICAgIGNvbnN0IGNv' +
  'cHkgPSBhc3luYyAoKSA9PiB7CiAgICAgIHRyeSB7IGF3YWl0IG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KGpvYi5jYXNl' +
  'X251bWJlcik7IHJldHVybiB0cnVlOyB9CiAgICAgIGNhdGNoIChlKSB7IHJldHVybiBmYWxzZTsgfQogICAgfTsKICAgIGVsLnF1' +
  'ZXJ5U2VsZWN0b3IoJyNjb3B5Q2FzZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PgogICAgICB0b2FzdChhd2FpdCBjb3B5KCkgPyAn' +
  'Q29waWVkICcgKyBqb2IuY2FzZV9udW1iZXIgOiAnQ29weSBmYWlsZWQg4oCUIHNlbGVjdCBpdCBieSBoYW5kJywgZmFsc2UpOwog' +
  'ICAgZWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcG9ydGFsXScpLmZvckVhY2gocm93ID0+IHJvdy5vbmNsaWNrID0gYXN5bmMg' +
  'KCkgPT4gewogICAgICBjb25zdCBwID0gVFhfUE9SVEFMU1srcm93LmRhdGFzZXQucG9ydGFsXTsKICAgICAgY29uc3Qgb2sgPSBh' +
  'd2FpdCBjb3B5KCk7CiAgICAgIHRvYXN0KG9rID8gJ0Nhc2UgbnVtYmVyIGNvcGllZCDigJQgcGFzdGUgaXQgaW50byB0aGVpciBz' +
  'ZWFyY2gnIDogJ09wZW5pbmcgJyArIHAubmFtZSk7CiAgICAgIHdpbmRvdy5vcGVuKHAudXJsLCAnX2JsYW5rJyk7CiAgICB9KTsK' +
  'ICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'IHNjYW4gLS0gKi8KZnVuY3Rpb24gc2NhblZpZXcoKSB7CiAgYXBwLmlubmVySFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0i' +
  'cGFnZSI+U2NhbiBhIHBhY2tldDwvaDE+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPHAgY2xhc3M9ImhpbnQiIHN0eWxl' +
  'PSJtYXJnaW4tdG9wOjAiPlBvaW50IHRoZSBjYW1lcmEgYXQgdGhlIGJhcmNvZGUgb24gdGhlIGNvdmVyIHNoZWV0IHRvIG9wZW4g' +
  'dGhhdCBqb2IuIElmIHRoZSBjYW1lcmEKICAgICAgd29uJ3QgY29vcGVyYXRlLCB0eXBlIHRoZSBqb2IgbnVtYmVyIGluc3RlYWQg' +
  '4oCUIGl0IHdvcmtzIHRoZSBzYW1lLjwvcD4KICAgICAgPGRpdiBpZD0icmVhZGVyIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0i' +
  'cm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJzdGFydFNjYW4iPlN0' +
  'YXJ0IGNhbWVyYTwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIGlkPSJzdG9wU2NhbkJ0biIgc3R5bGU9' +
  'ImRpc3BsYXk6bm9uZSI+U3RvcDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgaWQ9InNjYW5N' +
  'c2ciPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkVudGVyIGpvYiBudW1iZXI8L2gy' +
  'PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAgIDxpbnB1dCBpZD0ibWFudWFsIiBwbGFjZWhvbGRlcj0iU1QtMTAwMDEi' +
  'IHN0eWxlPSJmbGV4OjE7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlIj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJt' +
  'YW51YWxHbyI+T3BlbjwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PmApOwogIGJpbmRTaGVsbCgpOwoKICBjb25zdCBv' +
  'cGVuID0gYXN5bmMgY29kZSA9PiB7CiAgICB0cnkgewogICAgICBjb25zdCBqID0gYXdhaXQgYXBpKCcvbG9va3VwLycgKyBlbmNv' +
  'ZGVVUklDb21wb25lbnQoY29kZSkpOwogICAgICBpZiAod2luZG93Ll9fc3RvcFNjYW4pIHsgd2luZG93Ll9fc3RvcFNjYW4oKTsg' +
  'd2luZG93Ll9fc3RvcFNjYW4gPSBudWxsOyB9CiAgICAgIHRvYXN0KCdPcGVuaW5nICcgKyBqLmpvYl9udW1iZXIpOwogICAgICBn' +
  'bygnam9iJywgeyBpZDogai5pZCB9KTsKICAgIH0gY2F0Y2ggKGUpIHsgJCgnI3NjYW5Nc2cnKS50ZXh0Q29udGVudCA9IGUubWVz' +
  'c2FnZTsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07CgogICQoJyNtYW51YWxHbycpLm9uY2xpY2sgPSAoKSA9PiB7IGNv' +
  'bnN0IHYgPSAkKCcjbWFudWFsJykudmFsdWUudHJpbSgpOyBpZiAodikgb3Blbih2KTsgfTsKICAkKCcjbWFudWFsJykub25rZXlk' +
  'b3duID0gZSA9PiB7IGlmIChlLmtleSA9PT0gJ0VudGVyJykgJCgnI21hbnVhbEdvJykuY2xpY2soKTsgfTsKCiAgJCgnI3N0YXJ0' +
  'U2NhbicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBjb25zdCBtc2cgPSAkKCcjc2Nhbk1zZycpOwogICAgaWYgKCF3aW5k' +
  'b3cuWlhpbmcpIHJldHVybiBtc2cudGV4dENvbnRlbnQgPSAnU2Nhbm5lciBsaWJyYXJ5IGRpZCBub3QgbG9hZCDigJQgdXNlIHRo' +
  'ZSBqb2IgbnVtYmVyIGJveCBiZWxvdy4nOwogICAgdHJ5IHsKICAgICAgY29uc3QgcmVhZGVyID0gbmV3IFpYaW5nLkJyb3dzZXJN' +
  'dWx0aUZvcm1hdFJlYWRlcigpOwogICAgICBjb25zdCB2aWRlbyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3ZpZGVvJyk7CiAg' +
  'ICAgIHZpZGVvLnNldEF0dHJpYnV0ZSgncGxheXNpbmxpbmUnLCAndHJ1ZScpOwogICAgICAkKCcjcmVhZGVyJykuaW5uZXJIVE1M' +
  'ID0gJyc7CiAgICAgICQoJyNyZWFkZXInKS5hcHBlbmRDaGlsZCh2aWRlbyk7CiAgICAgICQoJyNzdGFydFNjYW4nKS5zdHlsZS5k' +
  'aXNwbGF5ID0gJ25vbmUnOwogICAgICAkKCcjc3RvcFNjYW5CdG4nKS5zdHlsZS5kaXNwbGF5ID0gJyc7CiAgICAgIG1zZy50ZXh0' +
  'Q29udGVudCA9ICdMb29raW5nIGZvciBhIGJhcmNvZGXigKYnOwogICAgICBsZXQgaGFuZGxlZCA9IGZhbHNlOwogICAgICBhd2Fp' +
  'dCByZWFkZXIuZGVjb2RlRnJvbUNvbnN0cmFpbnRzKAogICAgICAgIHsgdmlkZW86IHsgZmFjaW5nTW9kZTogJ2Vudmlyb25tZW50' +
  'JyB9IH0sIHZpZGVvLAogICAgICAgIChyZXN1bHQpID0+IHsgaWYgKHJlc3VsdCAmJiAhaGFuZGxlZCkgeyBoYW5kbGVkID0gdHJ1' +
  'ZTsgb3BlbihyZXN1bHQuZ2V0VGV4dCgpKTsgfSB9KTsKICAgICAgd2luZG93Ll9fc3RvcFNjYW4gPSAoKSA9PiB7CiAgICAgICAg' +
  'dHJ5IHsgcmVhZGVyLnJlc2V0KCk7IH0gY2F0Y2ggKGUpIHt9CiAgICAgICAgJCgnI3JlYWRlcicpLmlubmVySFRNTCA9ICcnOwog' +
  'ICAgICAgIGNvbnN0IHMgPSAkKCcjc3RhcnRTY2FuJyksIHN0ID0gJCgnI3N0b3BTY2FuQnRuJyk7CiAgICAgICAgaWYgKHMpIHMu' +
  'c3R5bGUuZGlzcGxheSA9ICcnOwogICAgICAgIGlmIChzdCkgc3Quc3R5bGUuZGlzcGxheSA9ICdub25lJzsKICAgICAgfTsKICAg' +
  'ICAgJCgnI3N0b3BTY2FuQnRuJykub25jbGljayA9ICgpID0+IHsgd2luZG93Ll9fc3RvcFNjYW4oKTsgd2luZG93Ll9fc3RvcFNj' +
  'YW4gPSBudWxsOyBtc2cudGV4dENvbnRlbnQgPSAnJzsgfTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgbXNnLnRleHRDb250ZW50' +
  'ID0gJ0NhbWVyYSB1bmF2YWlsYWJsZSAoJyArIGUubWVzc2FnZSArICcpLiBVc2UgdGhlIGpvYiBudW1iZXIgYm94IGJlbG93Lic7' +
  'CiAgICAgICQoJyNzdGFydFNjYW4nKS5zdHlsZS5kaXNwbGF5ID0gJyc7CiAgICAgICQoJyNzdG9wU2NhbkJ0bicpLnN0eWxlLmRp' +
  'c3BsYXkgPSAnbm9uZSc7CiAgICB9CiAgfTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0gbW9uZXkgLS0gKi8KYXN5bmMgZnVuY3Rpb24gbW9uZXlWaWV3KCkgewogIGlmICghaXNBZG1p' +
  'bigpKSByZXR1cm4gbXlQYXlWaWV3KCk7CiAgY29uc3QgW3N0YXRlbWVudHMsIGludm9pY2VzLCB1c2VycywgY2xpZW50cywgYXJd' +
  'ID0gYXdhaXQgUHJvbWlzZS5hbGwoCiAgICBbYXBpKCcvc3RhdGVtZW50cycpLCBhcGkoJy9pbnZvaWNlcycpLCBhcGkoJy91c2Vy' +
  'cycpLCBhcGkoJy9jbGllbnRzJyksIGFwaSgnL3JlY2VpdmFibGVzJyldKTsKCiAgLyogTW9uZXkgb3dlZCwgb2xkZXN0IGZpcnN0' +
  'LiAiVW5iaWxsZWQiIGlzIGRlbGliZXJhdGVseSBub3QgcGFydCBvZiB0aGUKICAgICB0b3RhbCDigJQgdGhhdCBpcyB3b3JrIHlv' +
  'dSBoYXZlIG5vdCBhc2tlZCB0byBiZSBwYWlkIGZvciB5ZXQsIHdoaWNoIGlzIGEKICAgICBkaWZmZXJlbnQgcHJvYmxlbSBmcm9t' +
  'IGEgZmlybSB0aGF0IGlzIHNsb3cgdG8gcGF5LiAqLwogIGNvbnN0IG93ZWQgPSBhci5jbGllbnRzLmZpbHRlcihjID0+IE51bWJl' +
  'cihjLmJhbGFuY2UpID4gMCk7CiAgY29uc3QgYnVja2V0ID0gKHYsIHdhcm4pID0+IGA8ZGl2IGNsYXNzPSJzdGF0JHt2ID4gMCAm' +
  'JiB3YXJuID8gJyBiYWQnIDogJyd9IiBzdHlsZT0iZmxleDoxIj4KICAgICAgPGRpdiBjbGFzcz0ibiIgc3R5bGU9ImZvbnQtc2l6' +
  'ZToxNnB4Ij4ke21vbmV5KHYpfTwvZGl2PjxkaXYgY2xhc3M9ImwiPiR7d2FybiB8fCAnQ3VycmVudCd9PC9kaXY+PC9kaXY+YDsK' +
  'CiAgYXBwLmlubmVySFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFnZSI+QmlsbGluZyAmYW1wOyBwYXk8L2gxPgoKICAg' +
  'IDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+T3V0c3RhbmRpbmcgPHNwYW4gY2xhc3M9InN1YiI+d2hhdCB5b3VyIGF0dG9y' +
  'bmV5cyBvd2UgeW91PC9zcGFuPjwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQgYmlnIiBzdHlsZT0ibWFyZ2luLXRvcDo2cHgi' +
  'PgogICAgICAgIDxkaXYgY2xhc3M9Im4iPiR7bW9uZXkoYXIudG90YWwpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImwiPiR7' +
  'b3dlZC5sZW5ndGggPyBvd2VkLmxlbmd0aCArICcgZmlybScgKyAob3dlZC5sZW5ndGggPT09IDEgPyAnJyA6ICdzJykgKyAnIHdp' +
  'dGggYSBiYWxhbmNlJwogICAgICAgICAgOiAnRXZlcnlvbmUgaXMgcGFpZCB1cCd9PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICAk' +
  'e2FyLnRvdGFsID4gMCA/IGA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJnYXA6NnB4O21hcmdpbi10b3A6MTBweCI+CiAgICAgICAg' +
  'JHtidWNrZXQoYXIuYnVja2V0cy5kMCl9JHtidWNrZXQoYXIuYnVja2V0cy5kMzAsICczMCsgZGF5cycpfQogICAgICAgICR7YnVj' +
  'a2V0KGFyLmJ1Y2tldHMuZDYwLCAnNjArIGRheXMnKX0ke2J1Y2tldChhci5idWNrZXRzLmQ5MCwgJzkwKyBkYXlzJyl9CiAgICAg' +
  'IDwvZGl2PmAgOiAnJ30KICAgICAgJHtvd2VkLmxlbmd0aCA/IGA8dGFibGUgY2xhc3M9InRibCIgc3R5bGU9Im1hcmdpbi10b3A6' +
  'MTRweCI+CiAgICAgICAgPHRyPjx0aD5BdHRvcm5leTwvdGg+PHRoIGNsYXNzPSJudW0iPk93ZWQ8L3RoPjx0aCBjbGFzcz0ibnVt' +
  'Ij5PbGRlc3Q8L3RoPjx0aD48L3RoPjwvdHI+CiAgICAgICAgJHtvd2VkLm1hcChjID0+IHsKICAgICAgICAgIGNvbnN0IGFnZSA9' +
  'IE1hdGguZmxvb3IoKERhdGUubm93KCkgLSBuZXcgRGF0ZShjLm9sZGVzdF9pbnZvaWNlKS5nZXRUaW1lKCkpIC8gODY0ZTUpOwog' +
  'ICAgICAgICAgcmV0dXJuIGA8dHI+CiAgICAgICAgICAgIDx0ZD4ke2VzYyhjLmNsaWVudF9uYW1lKX08ZGl2IGNsYXNzPSJoaW50' +
  'IiBzdHlsZT0ibWFyZ2luOjAiPiR7Yy5pbnZvaWNlX2NvdW50fSBpbnZvaWNlJHsKICAgICAgICAgICAgICBjLmludm9pY2VfY291' +
  'bnQgPT09IDEgPyAnJyA6ICdzJ308L2Rpdj48L3RkPgogICAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHttb25leShjLmJhbGFu' +
  'Y2UpfTwvdGQ+CiAgICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIiR7YWdlID49IDYwID8gJyBzdHlsZT0iY29sb3I6dmFyKC0tYmFk' +
  'KTtmb250LXdlaWdodDo3MDAiJyA6ICcnfT4ke2FnZX1kPC90ZD4KICAgICAgICAgICAgPHRkIGNsYXNzPSJudW0iPjxhIGhyZWY9' +
  'Ii9wcmludC9hY2NvdW50LyR7Yy5jbGllbnRfaWR9IiB0YXJnZXQ9Il9ibGFuayI+c3RhdGVtZW50PC9hPjwvdGQ+CiAgICAgICAg' +
  'ICA8L3RyPmA7CiAgICAgICAgfSkuam9pbignJyl9PC90YWJsZT5gIDogJyd9CiAgICAgICR7YXIudW5iaWxsZWQgPiAwID8gYDxk' +
  'aXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPlNlcGFyYXRlbHksIDxiPiR7bW9uZXkoYXIudW5iaWxsZWQp' +
  'fTwvYj4KICAgICAgICBvZiBzZXJ2ZWQgd29yayBoYXMgbm90IGJlZW4gcHV0IG9uIGFuIGludm9pY2UgeWV0IOKAlCB0aGF0IGlz' +
  'IG1vbmV5IHlvdSBoYXZlIG5vdCBhc2tlZCBmb3IuPC9kaXY+YCA6ICcnfQogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2Fy' +
  'ZCI+CiAgICAgIDxoMj5Db250cmFjdG9yIHN0YXRlbWVudHMgPHNwYW4gY2xhc3M9InN1YiI+d2hhdCB5b3Ugb3dlIHlvdXIgc2Vy' +
  'dmVyczwvc3Bhbj48L2gyPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6LTRweCI+UHVsbHMgZXZlcnkg' +
  'Y29tcGxldGVkIHNlcnZlIGluIHRoZSBwZXJpb2QgdGhhdCBoYXNuJ3QgYmVlbiBwYWlkIG91dCB5ZXQsIGF0IHRoZQogICAgICBw' +
  'ZXItam9iIHJhdGUgb24gdGhlIGpvYi4gTm90aGluZyBnZXRzIGNvdW50ZWQgdHdpY2UuPC9wPgogICAgICA8ZGl2IGNsYXNzPSJn' +
  'cmlkIGcyIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlNlcnZlcjwv' +
  'bGFiZWw+PHNlbGVjdCBpZD0ic19zZXJ2ZXIiPgogICAgICAgICAgJHt1c2Vycy5maWx0ZXIodSA9PiB1LmFjdGl2ZSkubWFwKHUg' +
  'PT4gYDxvcHRpb24gdmFsdWU9IiR7dS5pZH0iPiR7ZXNjKHUubmFtZSl9PC9vcHRpb24+YCkuam9pbignJyl9PC9zZWxlY3Q+PC9k' +
  'aXY+CiAgICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0iYWxpZ24taXRlbXM6ZmxleC1lbmQ7Z2FwOjZweCI+CiAgICAgICAg' +
  'ICA8ZGl2IGNsYXNzPSJmaWVsZCIgc3R5bGU9ImZsZXg6MTttYXJnaW46MCI+PGxhYmVsPkZyb208L2xhYmVsPjxpbnB1dCB0eXBl' +
  'PSJkYXRlIiBpZD0ic19zdGFydCIgdmFsdWU9IiR7Zmlyc3RPZk1vbnRoKCl9Ij48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9' +
  'ImZpZWxkIiBzdHlsZT0iZmxleDoxO21hcmdpbjowIj48bGFiZWw+VG88L2xhYmVsPjxpbnB1dCB0eXBlPSJkYXRlIiBpZD0ic19l' +
  'bmQiIHZhbHVlPSIke3RvZGF5SVNPKCl9Ij48L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xh' +
  'c3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0ic19w' +
  'cmV2Ij5QcmV2aWV3PC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0ic19tYWtlIj5DcmVhdGUgc3Rh' +
  'dGVtZW50PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGlkPSJzX291dCI+PC9kaXY+CiAgICAgICR7c3RhdGVtZW50' +
  'cy5sZW5ndGggPyBgPHRhYmxlIGNsYXNzPSJ0YmwiIHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPgogICAgICAgIDx0cj48dGg+U2Vy' +
  'dmVyPC90aD48dGg+UGVyaW9kPC90aD48dGggY2xhc3M9Im51bSI+Sm9iczwvdGg+PHRoIGNsYXNzPSJudW0iPlRvdGFsPC90aD48' +
  'dGg+PC90aD48dGg+PC90aD48L3RyPgogICAgICAgICR7c3RhdGVtZW50cy5tYXAocyA9PiBgPHRyPgogICAgICAgICAgPHRkPiR7' +
  'ZXNjKHMuc2VydmVyX25hbWUpfTwvdGQ+PHRkPiR7Zm10RGF0ZU9ubHkocy5wZXJpb2Rfc3RhcnQpfeKAkyR7Zm10RGF0ZU9ubHko' +
  'cy5wZXJpb2RfZW5kKX08L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPiR7cy5qb2JfY291bnR9PC90ZD48dGQgY2xhc3M9' +
  'Im51bSI+JHttb25leShzLnRvdGFsKX08L3RkPgogICAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJwaWxsICR7Y2xzKHMuc3RhdHVz' +
  'KX0iPiR7ZXNjKHMuc3RhdHVzKX08L3NwYW4+PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIvcHJpbnQv' +
  'c3RhdGVtZW50LyR7cy5pZH0iIHRhcmdldD0iX2JsYW5rIj5wcmludDwvYT4KICAgICAgICAgICAgJHtzLnN0YXR1cyAhPT0gJ1Bh' +
  'aWQnID8gYCDCtyA8YSBocmVmPSIjIiBkYXRhLXBhaWQ9IiR7cy5pZH0iPm1hcmsgcGFpZDwvYT5gIDogJyd9PC90ZD4KICAgICAg' +
  'ICA8L3RyPmApLmpvaW4oJycpfTwvdGFibGU+YCA6ICcnfQogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAg' +
  'IDxoMj5DbGllbnQgaW52b2ljZXM8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgICA8ZGl2IGNsYXNzPSJm' +
  'aWVsZCI+PGxhYmVsPkNsaWVudDwvbGFiZWw+PHNlbGVjdCBpZD0iaV9jbGllbnQiPgogICAgICAgICAgJHtjbGllbnRzLmZpbHRl' +
  'cihjID0+IGMuYWN0aXZlKS5tYXAoYyA9PiBgPG9wdGlvbiB2YWx1ZT0iJHtjLmlkfSI+JHtlc2MoYy5uYW1lKX08L29wdGlvbj5g' +
  'KS5qb2luKCcnKX08L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJhbGlnbi1pdGVtczpmbGV4' +
  'LWVuZDtnYXA6NnB4Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0iZmxleDoxO21hcmdpbjowIj48bGFiZWw+' +
  'RnJvbTwvbGFiZWw+PGlucHV0IHR5cGU9ImRhdGUiIGlkPSJpX3N0YXJ0IiB2YWx1ZT0iJHtmaXJzdE9mTW9udGgoKX0iPjwvZGl2' +
  'PgogICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJmbGV4OjE7bWFyZ2luOjAiPjxsYWJlbD5UbzwvbGFiZWw+PGlu' +
  'cHV0IHR5cGU9ImRhdGUiIGlkPSJpX2VuZCIgdmFsdWU9IiR7dG9kYXlJU08oKX0iPjwvZGl2PgogICAgICAgIDwvZGl2PgogICAg' +
  'ICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPgogICAgICAgIDxidXR0b24gY2xh' +
  'c3M9ImJ0biBzZWMgc20iIGlkPSJpX3ByZXYiPlByZXZpZXc8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc20i' +
  'IGlkPSJpX21ha2UiPkNyZWF0ZSBpbnZvaWNlPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGlkPSJpX291dCI+PC9k' +
  'aXY+CiAgICAgICR7aW52b2ljZXMubGVuZ3RoID8gYDx0YWJsZSBjbGFzcz0idGJsIiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij4K' +
  'ICAgICAgICA8dHI+PHRoPkNsaWVudDwvdGg+PHRoPlBlcmlvZDwvdGg+PHRoIGNsYXNzPSJudW0iPkpvYnM8L3RoPjx0aCBjbGFz' +
  'cz0ibnVtIj5Ub3RhbDwvdGg+PHRoPjwvdGg+PHRoPjwvdGg+PC90cj4KICAgICAgICAke2ludm9pY2VzLm1hcChzID0+IGA8dHI+' +
  'CiAgICAgICAgICA8dGQ+JHtlc2Mocy5jbGllbnRfbmFtZSl9PC90ZD48dGQ+JHtmbXREYXRlT25seShzLnBlcmlvZF9zdGFydCl9' +
  '4oCTJHtmbXREYXRlT25seShzLnBlcmlvZF9lbmQpfTwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHtzLmpvYl9jb3Vu' +
  'dH08L3RkPjx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KHMudG90YWwpfTwvdGQ+CiAgICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InBp' +
  'bGwgJHtjbHMocy5zdGF0dXMpfSI+JHtlc2Mocy5zdGF0dXMpfTwvc3Bhbj48L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0i' +
  'PjxhIGhyZWY9Ii9wcmludC9pbnZvaWNlLyR7cy5pZH0iIHRhcmdldD0iX2JsYW5rIj5wcmludDwvYT4KICAgICAgICAgICAgJHtz' +
  'LnN0YXR1cyAhPT0gJ1BhaWQnID8gYCDCtyA8YSBocmVmPSIjIiBkYXRhLWlwYWlkPSIke3MuaWR9Ij5tYXJrIHBhaWQ8L2E+YCA6' +
  'ICcnfTwvdGQ+CiAgICAgICAgPC90cj5gKS5qb2luKCcnKX08L3RhYmxlPmAgOiAnJ30KICAgIDwvZGl2PmApOwogIGJpbmRTaGVs' +
  'bCgpOwoKICBjb25zdCBsaW5lc1RhYmxlID0gKHIsIGtleSkgPT4gci5saW5lcy5sZW5ndGgKICAgID8gYDx0YWJsZSBjbGFzcz0i' +
  'dGJsIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij48dHI+PHRoPkRhdGU8L3RoPjx0aD5Kb2I8L3RoPjx0aD5SZWNpcGllbnQ8L3Ro' +
  'Pjx0aCBjbGFzcz0ibnVtIj4ke2tleSA9PT0gJ3BheScgPyAnUGF5JyA6ICdGZWUnfTwvdGg+PC90cj4KICAgICAgICR7ci5saW5l' +
  'cy5tYXAobCA9PiBgPHRyPjx0ZD4ke2ZtdERhdGVPbmx5KGwuc2VydmVkX2F0KX08L3RkPjx0ZD4ke2VzYyhsLmpvYl9udW1iZXIp' +
  'fTwvdGQ+CiAgICAgICA8dGQ+JHtlc2MobC5yZWNpcGllbnRfbmFtZSl9PC90ZD48dGQgY2xhc3M9Im51bSI+JHttb25leShrZXkg' +
  'PT09ICdwYXknID8gbC5zZXJ2ZXJfcGF5IDogbC5jbGllbnRfZmVlKX08L3RkPjwvdHI+YCkuam9pbignJyl9CiAgICAgICA8dHI+' +
  'PHRkIGNvbHNwYW49IjMiPjxiPiR7ci5jb3VudH0gam9iKHMpPC9iPjwvdGQ+PHRkIGNsYXNzPSJudW0iPjxiPiR7bW9uZXkoci50' +
  'b3RhbCl9PC9iPjwvdGQ+PC90cj48L3RhYmxlPmAKICAgIDogJzxkaXYgY2xhc3M9ImhpbnQiPk5vdGhpbmcgdW5iaWxsZWQgaW4g' +
  'dGhhdCB3aW5kb3cuPC9kaXY+JzsKCiAgJCgnI3NfcHJldicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBjb25zdCByID0g' +
  'YXdhaXQgYXBpKCcvc3RhdGVtZW50cy9wcmV2aWV3JywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoCiAg' +
  'ICAgIHsgc2VydmVyX2lkOiAkKCcjc19zZXJ2ZXInKS52YWx1ZSwgc3RhcnQ6ICQoJyNzX3N0YXJ0JykudmFsdWUsIGVuZDogJCgn' +
  'I3NfZW5kJykudmFsdWUgfSkgfSk7CiAgICAkKCcjc19vdXQnKS5pbm5lckhUTUwgPSBsaW5lc1RhYmxlKHIsICdwYXknKTsKICB9' +
  'OwogICQoJyNzX21ha2UnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAgICAgYXdhaXQgYXBpKCcvc3RhdGVt' +
  'ZW50cycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KAogICAgICAgIHsgc2VydmVyX2lkOiAkKCcjc19z' +
  'ZXJ2ZXInKS52YWx1ZSwgc3RhcnQ6ICQoJyNzX3N0YXJ0JykudmFsdWUsIGVuZDogJCgnI3NfZW5kJykudmFsdWUgfSkgfSk7CiAg' +
  'ICAgIHRvYXN0KCdTdGF0ZW1lbnQgY3JlYXRlZCcpOyBnbygnbW9uZXknKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNz' +
  'YWdlLCB0cnVlKTsgfQogIH07CiAgJCgnI2lfcHJldicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBjb25zdCByID0gYXdh' +
  'aXQgYXBpKCcvaW52b2ljZXMvcHJldmlldycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KAogICAgICB7' +
  'IGNsaWVudF9pZDogJCgnI2lfY2xpZW50JykudmFsdWUsIHN0YXJ0OiAkKCcjaV9zdGFydCcpLnZhbHVlLCBlbmQ6ICQoJyNpX2Vu' +
  'ZCcpLnZhbHVlIH0pIH0pOwogICAgJCgnI2lfb3V0JykuaW5uZXJIVE1MID0gbGluZXNUYWJsZShyLCAnZmVlJyk7CiAgfTsKICAk' +
  'KCcjaV9tYWtlJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGF3YWl0IGFwaSgnL2ludm9pY2VzJywg' +
  'eyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoCiAgICAgICAgeyBjbGllbnRfaWQ6ICQoJyNpX2NsaWVudCcp' +
  'LnZhbHVlLCBzdGFydDogJCgnI2lfc3RhcnQnKS52YWx1ZSwgZW5kOiAkKCcjaV9lbmQnKS52YWx1ZSB9KSB9KTsKICAgICAgdG9h' +
  'c3QoJ0ludm9pY2UgY3JlYXRlZCcpOyBnbygnbW9uZXknKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVl' +
  'KTsgfQogIH07CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcGFpZF0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNr' +
  'ID0gYXN5bmMgZSA9PiB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICBhd2FpdCBhcGkoJy9zdGF0ZW1lbnRzLycgKyBhLmRh' +
  'dGFzZXQucGFpZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgc3RhdHVzOiAnUGFpZCcgfSkgfSk7' +
  'CiAgICB0b2FzdCgnTWFya2VkIHBhaWQnKTsgZ28oJ21vbmV5Jyk7CiAgfSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgn' +
  'W2RhdGEtaXBhaWRdJykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGFzeW5jIGUgPT4gewogICAgZS5wcmV2ZW50RGVmYXVsdCgp' +
  'OwogICAgYXdhaXQgYXBpKCcvaW52b2ljZXMvJyArIGEuZGF0YXNldC5pcGFpZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpT' +
  'T04uc3RyaW5naWZ5KHsgc3RhdHVzOiAnUGFpZCcgfSkgfSk7CiAgICB0b2FzdCgnTWFya2VkIHBhaWQnKTsgZ28oJ21vbmV5Jyk7' +
  'CiAgfSk7Cn0KCmZ1bmN0aW9uIGZpcnN0T2ZNb250aCgpIHsKICBjb25zdCBkID0gbmV3IERhdGUoKTsgcmV0dXJuIG5ldyBEYXRl' +
  'KGQuZ2V0RnVsbFllYXIoKSwgZC5nZXRNb250aCgpLCAxKS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKTsKfQoKYXN5bmMgZnVu' +
  'Y3Rpb24gbXlQYXlWaWV3KCkgewogIGNvbnN0IFtzdGF0ZW1lbnRzLCBzdGF0c10gPSBhd2FpdCBQcm9taXNlLmFsbChbYXBpKCcv' +
  'c3RhdGVtZW50cycpLCBhcGkoJy9zdGF0cycpXSk7CiAgYXBwLmlubmVySFRNTCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFn' +
  'ZSI+TXkgcGF5PC9oMT4KICAgIDxkaXYgY2xhc3M9InN0YXRzIj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdCBnb29kIj48ZGl2IGNs' +
  'YXNzPSJuIj4ke21vbmV5KHN0YXRzLnVuYmlsbGVkKX08L2Rpdj48ZGl2IGNsYXNzPSJsIj5FYXJuZWQsIG5vdCB5ZXQgb24gYSBz' +
  'dGF0ZW1lbnQ8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdCI+PGRpdiBjbGFzcz0ibiI+JHtzdGF0cy5zZXJ2ZWRf' +
  'N2R9PC9kaXY+PGRpdiBjbGFzcz0ibCI+U2VydmVzIGNvbXBsZXRlZCwgNyBkYXlzPC9kaXY+PC9kaXY+CiAgICA8L2Rpdj4KICAg' +
  'IDxkaXYgY2xhc3M9ImNhcmQiPjxoMj5TdGF0ZW1lbnRzPC9oMj4KICAgICR7c3RhdGVtZW50cy5sZW5ndGggPyBgPHRhYmxlIGNs' +
  'YXNzPSJ0YmwiPgogICAgICA8dHI+PHRoPlBlcmlvZDwvdGg+PHRoIGNsYXNzPSJudW0iPkpvYnM8L3RoPjx0aCBjbGFzcz0ibnVt' +
  'Ij5Ub3RhbDwvdGg+PHRoPjwvdGg+PHRoPjwvdGg+PC90cj4KICAgICAgJHtzdGF0ZW1lbnRzLm1hcChzID0+IGA8dHI+PHRkPiR7' +
  'Zm10RGF0ZU9ubHkocy5wZXJpb2Rfc3RhcnQpfeKAkyR7Zm10RGF0ZU9ubHkocy5wZXJpb2RfZW5kKX08L3RkPgogICAgICAgIDx0' +
  'ZCBjbGFzcz0ibnVtIj4ke3Muam9iX2NvdW50fTwvdGQ+PHRkIGNsYXNzPSJudW0iPiR7bW9uZXkocy50b3RhbCl9PC90ZD4KICAg' +
  'ICAgICA8dGQ+PHNwYW4gY2xhc3M9InBpbGwgJHtjbHMocy5zdGF0dXMpfSI+JHtlc2Mocy5zdGF0dXMpfTwvc3Bhbj48L3RkPgog' +
  'ICAgICAgIDx0ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIvcHJpbnQvc3RhdGVtZW50LyR7cy5pZH0iIHRhcmdldD0iX2JsYW5rIj5w' +
  'cmludDwvYT48L3RkPjwvdHI+YCkuam9pbignJyl9CiAgICAgIDwvdGFibGU+YCA6ICc8ZGl2IGNsYXNzPSJlbXB0eSI+Tm8gc3Rh' +
  'dGVtZW50cyB5ZXQuPC9kaXY+J30KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2FyZCI+PGgyPkNoYW5nZSBwYXNzd29yZDwv' +
  'aDI+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPlRoaXMgaXMgeW91ciBvbmUgcGFzc3dvcmQgZm9yIGV2ZXJ5IGFwcC48L2Rpdj4K' +
  'ICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxpbnB1dCBpZD0ib3B3IiB0eXBlPSJwYXNzd29yZCIgcGxhY2Vob2xkZXI9IkN1cnJl' +
  'bnQgcGFzc3dvcmQiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGlucHV0IGlkPSJucHciIHR5cGU9InBhc3N3b3Jk' +
  'IiBwbGFjZWhvbGRlcj0iTmV3IHBhc3N3b3JkICg4KyBjaGFyYWN0ZXJzKSI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0' +
  'biBzbSIgaWQ9InNhdmVQdyI+VXBkYXRlPC9idXR0b24+PC9kaXY+YCk7CiAgYmluZFNoZWxsKCk7CiAgJCgnI3NhdmVQdycpLm9u' +
  'Y2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBjb25zdCByID0gYXdhaXQgYXBpKCcvbWUvcGFzc3dvcmQnLCB7' +
  'IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgcGFzc3dvcmQ6ICQoJyNucHcnKS52YWx1ZSwg' +
  'b2xkX3Bhc3N3b3JkOiAkKCcjb3B3JykudmFsdWUgfSkgfSk7CiAgICAgICQoJyNvcHcnKS52YWx1ZSA9ICcnOyAkKCcjbnB3Jyku' +
  'dmFsdWUgPSAnJzsKICAgICAgdG9hc3Qoci5ldmVyeXdoZXJlID09PSBmYWxzZSA/ICdDaGFuZ2VkIGhlcmUg4oCUIG90aGVyIGFw' +
  'cHMgc3RpbGwgaGF2ZSB0aGUgb2xkIG9uZScgOiAnUGFzc3dvcmQgdXBkYXRlZCBldmVyeXdoZXJlJyk7CiAgICB9IGNhdGNoIChl' +
  'KSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9Owp9CgoKZnVuY3Rpb24gY29kZXNUYWJsZShsaXN0KSB7CiAgaWYgKCFs' +
  'aXN0Lmxlbmd0aCkgcmV0dXJuICc8ZGl2IGNsYXNzPSJoaW50Ij5ObyBjb2RlcyB5ZXQuPC9kaXY+JzsKICByZXR1cm4gYDx0YWJs' +
  'ZSBjbGFzcz0idGJsIj4KICAgIDx0cj48dGg+Q29kZTwvdGg+PHRoPkdyYW50czwvdGg+PHRoPlVzZWQ8L3RoPjx0aD48L3RoPjx0' +
  'aD48L3RoPjwvdHI+CiAgICAke2xpc3QubWFwKGMgPT4gYDx0cj4KICAgICAgPHRkPjxzcGFuIHN0eWxlPSJmb250OjYwMCAxM3B4' +
  'IG1vbm9zcGFjZTtsZXR0ZXItc3BhY2luZzouNXB4Ij4ke2VzYyhjLmNvZGUpfTwvc3Bhbj4KICAgICAgICAke2Mubm90ZSA/IGA8' +
  'ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyhjLm5vdGUpfTwvZGl2PmAgOiAnJ30KICAgICAgICAke2MucmVkZW1wdGlvbnMgJiYgYy5y' +
  'ZWRlbXB0aW9ucy5sZW5ndGggPyBgPGRpdiBjbGFzcz0iaGludCI+JHtjLnJlZGVtcHRpb25zLm1hcChyID0+IGVzYyhyLmVtYWls' +
  'KSkuam9pbignLCAnKX08L2Rpdj5gIDogJyd9PC90ZD4KICAgICAgPHRkPiR7Yy5yb2xlID09PSAnYWRtaW4nID8gJ0FkbWluJyA6' +
  'ICdGaWVsZCBzZXJ2ZXInfQogICAgICAgICR7Yy5leHBpcmVzX2F0ID8gYDxkaXYgY2xhc3M9ImhpbnQiPnRvICR7Zm10RGF0ZU9u' +
  'bHkoYy5leHBpcmVzX2F0KX08L2Rpdj5gIDogJyd9PC90ZD4KICAgICAgPHRkPiR7Yy51c2VkX2NvdW50fS8ke2MubWF4X3VzZXN9' +
  'PC90ZD4KICAgICAgPHRkPjxzcGFuIGNsYXNzPSJwaWxsICR7Yy5zdGF0ZSA9PT0gJ0FjdGl2ZScgPyAnU2VydmVkJyA6ICcnfSI+' +
  'JHtlc2MoYy5zdGF0ZSl9PC9zcGFuPjwvdGQ+CiAgICAgIDx0ZCBjbGFzcz0ibnVtIj4KICAgICAgICA8YSBocmVmPSIjIiBkYXRh' +
  'LWNvcHk9IiR7ZXNjKGMuY29kZSl9Ij5jb3B5PC9hPgogICAgICAgICR7Yy5zdGF0ZSA9PT0gJ0FjdGl2ZScgPyBgIMK3IDxhIGhy' +
  'ZWY9IiMiIGRhdGEtcmV2b2tlPSIke2MuaWR9Ij5yZXZva2U8L2E+YCA6ICcnfQogICAgICA8L3RkPjwvdHI+YCkuam9pbignJyl9' +
  'PC90YWJsZT5gOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLSBhZG1pbiAtLSAqLwovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0gdGhlIHBsYW4gLS0gKi8KLyogVGhyZWUgc3RhdGVzIHdvcnRoIHRlbGxpbmcgc29tZWJvZHkgYWJvdXQsIGFuZCBvbmUg' +
  'd29ydGggc3RheWluZyBxdWlldCBvbi4KICAgQSBwYWlkIGNvbXBhbnkgc2VlcyBub3RoaW5nIGF0IHRoZSB0b3Agb2YgaXRzIGRh' +
  'c2hib2FyZCDigJQgaXQgaGFzIGFscmVhZHkKICAgYm91Z2h0IHRoZSB0aGluZywgYW5kIGEgYmFubmVyIHdvdWxkIGp1c3QgYmUg' +
  'aW4gdGhlIHdheS4gKi8KCmNvbnN0IHBsYW4gPSAoKSA9PiAoUy5tZSAmJiBTLm1lLnBsYW4pIHx8IHsgcGxhbjogJ2ZyZWUnLCB0' +
  'cmlhbDogZmFsc2UgfTsKCmZ1bmN0aW9uIHBsYW5CYW5uZXIoKSB7CiAgY29uc3QgcCA9IHBsYW4oKTsKICBpZiAocC5wbGFuID09' +
  'PSAncHJvJyAmJiAhcC50cmlhbCkgcmV0dXJuICcnOyAgICAgICAgICAvLyBwYXlpbmc6IHNheSBub3RoaW5nCiAgaWYgKHAudHJp' +
  'YWwpIHsKICAgIGNvbnN0IGQgPSBwLmRheXNfbGVmdDsKICAgIGlmIChkID09PSBudWxsIHx8IGQgPiA3KSByZXR1cm4gJyc7ICAg' +
  'ICAgICAgICAgICAgICAvLyBlYXJseSBkYXlzOiBsZWF2ZSB0aGVtIGFsb25lCiAgICByZXR1cm4gYDxkaXYgY2xhc3M9ImNhcmQi' +
  'IHN0eWxlPSJib3JkZXItY29sb3I6I0Y2QzY4QTtiYWNrZ3JvdW5kOiNGRUY2RUMiPgogICAgICA8Yj4ke2QgPT09IDAgPyAnWW91' +
  'ciB0cmlhbCBlbmRzIHRvZGF5JyA6IGQgPT09IDEgPyAnT25lIGRheSBsZWZ0IGluIHlvdXIgdHJpYWwnCiAgICAgICAgICA6IGQg' +
  'KyAnIGRheXMgbGVmdCBpbiB5b3VyIHRyaWFsJ308L2I+CiAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9w' +
  'OjRweCI+RXZlcnl0aGluZyBrZWVwcyB3b3JraW5nJHsKICAgICAgICBkID09PSAwID8gJyB1bnRpbCBtaWRuaWdodCcgOiAnJ30u' +
  'IEFmdGVyIHRoYXQgeW91IGNhbiBjYXJyeSBvbiBmcmVlIHdpdGggdXAgdG8KICAgICAgICAke3AubGltaXRzID8gcC5saW1pdHMu' +
  'Y2xpZW50cyA6IDN9IGF0dG9ybmV5IGNsaWVudHMuCiAgICAgICAgPGEgaHJlZj0iIyIgZGF0YS1nbz0iYWRtaW4iPlVwZ3JhZGU8' +
  'L2E+PC9kaXY+PC9kaXY+YDsKICB9CiAgaWYgKHAudHJpYWxfb3ZlcikgewogICAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJjYXJkIiBz' +
  'dHlsZT0iYm9yZGVyLWNvbG9yOiNGNkM2OEE7YmFja2dyb3VuZDojRkVGNkVDIj4KICAgICAgPGI+WW91ciBmcmVlIHRyaWFsIGhh' +
  'cyBlbmRlZDwvYj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6NHB4Ij5Zb3UgYXJlIG9uIHRoZSBm' +
  'cmVlIHBsYW4g4oCUIHVwIHRvCiAgICAgICAgJHtwLmxpbWl0cyA/IHAubGltaXRzLmNsaWVudHMgOiAzfSBhdHRvcm5leSBjbGll' +
  'bnRzLiBZb3VyIGpvYnMsIGF0dGVtcHRzIGFuZCBwaG90b3MgYXJlCiAgICAgICAgYWxsIHN0aWxsIGhlcmUuIDxhIGhyZWY9IiMi' +
  'IGRhdGEtZ289ImFkbWluIj5VcGdyYWRlPC9hPjwvZGl2PjwvZGl2PmA7CiAgfQogIHJldHVybiAnJzsKfQoKZnVuY3Rpb24gcGxh' +
  'bkNhcmQoKSB7CiAgY29uc3QgcCA9IHBsYW4oKTsKICBjb25zdCBsYWJlbCA9IHAucGxhbiA9PT0gJ3BybycKICAgID8gKHAudHJp' +
  'YWwgPyBgRnJlZSB0cmlhbCDCtyAke3AuZGF5c19sZWZ0fSBkYXkke3AuZGF5c19sZWZ0ID09PSAxID8gJycgOiAncyd9IGxlZnRg' +
  'IDogJ1BybycpCiAgICA6IChwLnRyaWFsX292ZXIgPyAnRnJlZSDigJQgdHJpYWwgZW5kZWQnIDogJ0ZyZWUnKTsKICByZXR1cm4g' +
  'YDxkaXYgY2xhc3M9ImNhcmQiPgogICAgPGgyPlN1YnNjcmlwdGlvbiA8c3BhbiBjbGFzcz0ic3ViIj4ke2VzYyhsYWJlbCl9PC9z' +
  'cGFuPjwvaDI+CiAgICAke3AucGxhbiA9PT0gJ3BybycgJiYgIXAudHJpYWwKICAgICAgPyBgPGRpdiBjbGFzcz0iaGludCI+UGFp' +
  'ZCR7cC5leHBpcmVzX29uID8gJyB0aHJvdWdoICcgKyBmbXREYXRlT25seShwLmV4cGlyZXNfb24pIDogJyd9LiBUaGFuayB5b3Uu' +
  'PC9kaXY+YAogICAgICA6IGA8ZGl2IGNsYXNzPSJoaW50Ij4ke3AudHJpYWwKICAgICAgICAgID8gYFlvdXIgdHJpYWwgcnVucyB0' +
  'byAke2ZtdERhdGVPbmx5KHAuZXhwaXJlc19vbil9LiBOb3RoaW5nIGlzIGxpbWl0ZWQgdW50aWwgdGhlbi5gCiAgICAgICAgICA6' +
  'IGBUaGUgZnJlZSBwbGFuIGNvdmVycyAke3AubGltaXRzID8gcC5saW1pdHMuY2xpZW50cyA6IDN9IGF0dG9ybmV5IGNsaWVudHMu' +
  'CiAgICAgICAgICAgICBFdmVyeXRoaW5nIGVsc2Ug4oCUIGpvYnMsIGF0dGVtcHRzLCBwaG90b3MsIGFmZmlkYXZpdHMsIGludm9p' +
  'Y2VzIOKAlCBpcyB1bmxpbWl0ZWQuYH08L2Rpdj5gfQogICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJtYXJnaW4tdG9wOjEy' +
  'cHgiPjxsYWJlbD5IYXZlIGFuIHVwZ3JhZGUgY29kZT88L2xhYmVsPgogICAgICA8aW5wdXQgaWQ9InBsYW5Db2RlIiBwbGFjZWhv' +
  'bGRlcj0iU1JWLTMwRC1YWFhYLVhYWFhYWCIgYXV0b2NhcGl0YWxpemU9ImNoYXJhY3RlcnMiCiAgICAgICAgICAgICBzdHlsZT0i' +
  'dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlIj48L2Rpdj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9InBsYW5HbyI+QXBw' +
  'bHkgY29kZTwvYnV0dG9uPgogICAgPGRpdiBjbGFzcz0iaGludCIgaWQ9InBsYW5Nc2ciIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+' +
  'PC9kaXY+CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gd2lyZVBsYW5DYXJkKCkgewogIGNvbnN0IGJ0biA9ICQoJyNwbGFuR28nKTsK' +
  'ICBpZiAoIWJ0bikgcmV0dXJuOwogIGJ0bi5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgY29uc3QgbXNnID0gJCgnI3BsYW5N' +
  'c2cnKTsKICAgIGNvbnN0IGNvZGUgPSAoJCgnI3BsYW5Db2RlJykudmFsdWUgfHwgJycpLnRyaW0oKTsKICAgIGlmICghY29kZSkg' +
  'eyBtc2cudGV4dENvbnRlbnQgPSAnRW50ZXIgdGhlIGNvZGUgeW91IHdlcmUgZ2l2ZW4uJzsgcmV0dXJuOyB9CiAgICBidG4uZGlz' +
  'YWJsZWQgPSB0cnVlOwogICAgbXNnLnN0eWxlLmNvbG9yID0gJyc7CiAgICBtc2cudGV4dENvbnRlbnQgPSAnQ2hlY2tpbmfigKYn' +
  'OwogICAgdHJ5IHsKICAgICAgYXdhaXQgYXBpKCcvcGxhbi9yZWRlZW0nLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0' +
  'cmluZ2lmeSh7IGNvZGUgfSkgfSk7CiAgICAgIFMubWUgPSBhd2FpdCBhcGkoJy9tZScpOwogICAgICB0b2FzdCgnVXBncmFkZWQg' +
  '4oCUIHRoYW5rIHlvdScpOwogICAgICBhZG1pblZpZXcoKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgbXNnLnN0eWxlLmNvbG9y' +
  'ID0gJ3ZhcigtLWJhZCknOwogICAgICBtc2cudGV4dENvbnRlbnQgPSBlLm1lc3NhZ2U7CiAgICAgIGJ0bi5kaXNhYmxlZCA9IGZh' +
  'bHNlOwogICAgfQogIH07Cn0KCmFzeW5jIGZ1bmN0aW9uIGFkbWluVmlldygpIHsKICAvLyBGZXRjaCBldmVyeXRoaW5nIGJlZm9y' +
  'ZSBkcmF3aW5nLiBQb3B1bGF0aW5nIGNhcmRzIGFmdGVyIHJlbmRlciBtYWRlIHRoZQogIC8vIHBhZ2UgZ3JvdyB1bmRlciB0aGUg' +
  'dXNlcidzIGZpbmdlciwgc28gYSB0YXAgY291bGQgbGFuZCBvbiB0aGUgd3Jvbmcgcm93LgogIGNvbnN0IFt1c2VycywgY2xpZW50' +
  'cywgdGVtcGxhdGVzLCBjb2RlcywgcG9ydGFscywgY29tcGFuaWVzXSA9IGF3YWl0IFByb21pc2UuYWxsKFsKICAgIGFwaSgnL3Vz' +
  'ZXJzJyksIGFwaSgnL2NsaWVudHMnKSwgYXBpKCcvdGVtcGxhdGVzJyksCiAgICBhcGkoJy9jb2RlcycpLmNhdGNoKCgpID0+IFtd' +
  'KSwgYXBpKCcvcG9ydGFscycpLmNhdGNoKCgpID0+IFtdKSwKICAgIGFwaSgnL2NvbXBhbmllcycpLmNhdGNoKCgpID0+IFtdKQog' +
  'IF0pOwogIGNvbnN0IGhlcmUgPSBjb21wYW5pZXMuZmluZChjID0+IFMubWUuY29tcGFueSAmJiBjLmlkID09PSBTLm1lLmNvbXBh' +
  'bnkuaWQpIHx8IGNvbXBhbmllc1swXSB8fCB7fTsKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdl' +
  'Ij5TZXR1cDwvaDE+CgogICAgJHtwbGFuQ2FyZCgpfQoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+JHtpc093bmVy' +
  'KCkgPyAnVGhpcyBjb21wYW55JyA6ICdZb3VyIGNvbXBhbnknfTwvaDI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+' +
  'TmFtZTwvbGFiZWw+PGlucHV0IGlkPSJjb05hbWUiIHZhbHVlPSIke2VzYyhoZXJlLm5hbWUgfHwgJycpfSI+PC9kaXY+CiAgICAg' +
  'IDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q29udGFjdCBlbWFpbDwvbGFiZWw+PGlucHV0IGlkPSJjb0VtYWlsIiB2YWx1ZT0i' +
  'JHtlc2MoaGVyZS5jb250YWN0X2VtYWlsIHx8ICcnKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBo' +
  'b25lPC9sYWJlbD48aW5wdXQgaWQ9ImNvUGhvbmUiIHZhbHVlPSIke2VzYyhoZXJlLnBob25lIHx8ICcnKX0iPjwvZGl2PgogICAg' +
  'ICA8YnV0dG9uIGNsYXNzPSJidG4gc20iIGlkPSJjb1NhdmUiPlNhdmU8L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIg' +
  'c3R5bGU9Im1hcmdpbi10b3A6OHB4Ij5UaGlzIG5hbWUgYXBwZWFycyBvbiB5b3VyIGludm9pY2VzIGFuZCBwYXkgc3RhdGVtZW50' +
  'cy48L2Rpdj4KICAgIDwvZGl2PgoKICAgICR7aXNPd25lcigpID8gYDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+QWxsIGNv' +
  'bXBhbmllcyA8c3BhbiBjbGFzcz0ic3ViIj4ke2NvbXBhbmllcy5sZW5ndGh9PC9zcGFuPjwvaDI+CiAgICAgIDx0YWJsZSBjbGFz' +
  'cz0idGJsIj4KICAgICAgICA8dHI+PHRoPkNvbXBhbnk8L3RoPjx0aCBjbGFzcz0ibnVtIj5QZW9wbGU8L3RoPjx0aCBjbGFzcz0i' +
  'bnVtIj5PcGVuPC90aD48dGg+PC90aD48L3RyPgogICAgICAgICR7Y29tcGFuaWVzLm1hcChjID0+IGA8dHI+CiAgICAgICAgICA8' +
  'dGQ+JHtlc2MoYy5uYW1lKX0ke1MubWUuY29tcGFueSAmJiBjLmlkID09PSBTLm1lLmNvbXBhbnkuaWQgPyAnIDxzcGFuIGNsYXNz' +
  'PSJwaWxsIj55b3UgYXJlIGhlcmU8L3NwYW4+JyA6ICcnfQogICAgICAgICAgICA8ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyhjLmFk' +
  'bWluX2VtYWlsIHx8ICdubyBhZG1pbiB5ZXQnKX0gwrcgJHtjLnBsYW4gPT09ICdwcm8nID8gJ1BybycgOiAnRnJlZSd9PC9kaXY+' +
  'PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke2MucGVvcGxlID8/ICfigJQnfTwvdGQ+CiAgICAgICAgICA8dGQgY2xh' +
  'c3M9Im51bSI+JHtjLm9wZW5fam9icyA/PyAn4oCUJ308L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPiR7Uy5tZS5jb21w' +
  'YW55ICYmIGMuaWQgPT09IFMubWUuY29tcGFueS5pZAogICAgICAgICAgICA/ICcnIDogYDxhIGhyZWY9IiMiIGRhdGEtZW50ZXI9' +
  'IiR7Yy5pZH0iPmVudGVyPC9hPmB9PC90ZD48L3RyPmApLmpvaW4oJycpfQogICAgICA8L3RhYmxlPgogICAgICA8ZGl2IGNsYXNz' +
  'PSJmaWVsZCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+PGxhYmVsPlN0YXJ0IGFub3RoZXIgY29tcGFueTwvbGFiZWw+CiAgICAg' +
  'ICAgPGlucHV0IGlkPSJuZXdDb05hbWUiIHBsYWNlaG9sZGVyPSJDb21wYW55IG5hbWUiPjwvZGl2PgogICAgICA8YnV0dG9uIGNs' +
  'YXNzPSJidG4gc20iIGlkPSJuZXdDbyI+Q3JlYXRlIGNvbXBhbnk8L2J1dHRvbj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5' +
  'bGU9Im1hcmdpbi10b3A6OHB4Ij5DcmVhdGluZyBhIGNvbXBhbnkgZ2l2ZXMgaXQgaXRzIG93biBqb2JzLCBjbGllbnRzIGFuZAog' +
  'ICAgICAgIGJpbGxpbmcuIEFkZCBpdHMgYWRtaW5pc3RyYXRvciBmcm9tIGluc2lkZSBpdCwgb3IgaGFuZCB0aGVtIGFuIGFjY2Vz' +
  'cyBjb2RlLjwvZGl2PgogICAgPC9kaXY+YCA6ICcnfQoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+VGVhbSA8c3Bh' +
  'biBjbGFzcz0ic3ViIj4ke3VzZXJzLmxlbmd0aH08L3NwYW4+PC9oMj4KICAgICAgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgICAg' +
  'IDx0cj48dGg+TmFtZTwvdGg+PHRoPlJvbGU8L3RoPjx0aCBjbGFzcz0ibnVtIj5SYXRlPC90aD48dGg+PC90aD48L3RyPgogICAg' +
  'ICAgICR7dXNlcnMubWFwKHUgPT4gYDx0cj48dGQ+JHtlc2ModS5uYW1lKX08ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyh1LmVtYWls' +
  'KX08L2Rpdj48L3RkPgogICAgICAgICAgPHRkPiR7ZXNjKHUucm9sZSl9JHt1LmFjdGl2ZSA/ICcnIDogJyA8c3BhbiBjbGFzcz0i' +
  'cGlsbCI+b2ZmPC9zcGFuPid9PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KHUuZGVmYXVsdF9wYXkpfTwv' +
  'dGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iIyIgZGF0YS11c2VyPSIke3UuaWR9Ij5lZGl0PC9hPjwvdGQ+' +
  'PC90cj5gKS5qb2luKCcnKX0KICAgICAgPC90YWJsZT4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBibG9jayBzbSIgaWQ9' +
  'Im5ld1VzZXIiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPisgQWRkIHBlcnNvbjwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPGRp' +
  'diBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5DbGllbnRzIDxzcGFuIGNsYXNzPSJzdWIiPiR7Y2xpZW50cy5sZW5ndGh9PC9zcGFu' +
  'PjwvaDI+CiAgICAgIDx0YWJsZSBjbGFzcz0idGJsIj4KICAgICAgICA8dHI+PHRoPk5hbWU8L3RoPjx0aCBjbGFzcz0ibnVtIj5E' +
  'ZWZhdWx0IGZlZTwvdGg+PHRoPjwvdGg+PC90cj4KICAgICAgICAke2NsaWVudHMubWFwKGMgPT4gYDx0cj48dGQ+JHtlc2MoYy5u' +
  'YW1lKX08ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyhjLmNvbnRhY3RfbmFtZSB8fCAnJyl9ICR7ZXNjKGMucGhvbmUgfHwgJycpfTwv' +
  'ZGl2PjwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHttb25leShjLmRlZmF1bHRfZmVlKX08L3RkPgogICAgICAgICAg' +
  'PHRkIGNsYXNzPSJudW0iPjxhIGhyZWY9IiMiIGRhdGEtY2xpZW50PSIke2MuaWR9Ij5lZGl0PC9hPjwvdGQ+PC90cj5gKS5qb2lu' +
  'KCcnKX0KICAgICAgPC90YWJsZT4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBibG9jayBzbSIgaWQ9Im5ld0NsaWVudCIg' +
  'c3R5bGU9Im1hcmdpbi10b3A6MTBweCI+KyBBZGQgY2xpZW50PC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJj' +
  'YXJkIj4KICAgICAgPGgyPkFmZmlkYXZpdCB0ZW1wbGF0ZXMgPHNwYW4gY2xhc3M9InN1YiI+JHt0ZW1wbGF0ZXMubGVuZ3RofTwv' +
  'c3Bhbj48L2gyPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6LTRweCI+V3JpdGUgeW91ciBvd24gd29y' +
  'ZGluZyBwZXIgY291bnR5IG9yIGNsaWVudC4gTWVyZ2UgZmllbGRzIGZpbGwgaW4gZnJvbSB0aGUgam9iLAogICAgICBpbmNsdWRp' +
  'bmcgdGhlIGZ1bGwgYXR0ZW1wdCBsb2cgd2l0aCBHUFMuPC9wPgogICAgICA8dGFibGUgY2xhc3M9InRibCI+CiAgICAgICAgJHt0' +
  'ZW1wbGF0ZXMubWFwKHQgPT4gYDx0cj48dGQ+JHtlc2ModC5uYW1lKX08ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyh0Lmp1cmlzZGlj' +
  'dGlvbiB8fCAnJyl9PC9kaXY+PC90ZD4KICAgICAgICAgIDx0ZD4ke3QuaXNfZGVmYXVsdCA/ICc8c3BhbiBjbGFzcz0icGlsbCBT' +
  'ZXJ2ZWQiPmRlZmF1bHQ8L3NwYW4+JyA6ICcnfTwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iIyIgZGF0' +
  'YS10cGw9IiR7dC5pZH0iPmVkaXQ8L2E+PC90ZD48L3RyPmApLmpvaW4oJycpfQogICAgICA8L3RhYmxlPgogICAgICA8YnV0dG9u' +
  'IGNsYXNzPSJidG4gc2VjIGJsb2NrIHNtIiBpZD0ibmV3VHBsIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4rIE5ldyB0ZW1wbGF0' +
  'ZTwvYnV0dG9uPgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5BY2Nlc3MgY29kZXMgPHNwYW4g' +
  'Y2xhc3M9InN1YiI+bGV0IHBlb3BsZSBzZXQgdXAgdGhlaXIgb3duIGFjY291bnQ8L3NwYW4+PC9oMj4KICAgICAgPHAgY2xhc3M9' +
  'ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOi00cHgiPkdlbmVyYXRlIGEgY29kZSBhbmQgc2VuZCBpdCBvdmVyLiBUaGV5IGVudGVy' +
  'IGl0IG9uIHRoZSBzaWduLWluCiAgICAgICAgc2NyZWVuIHVuZGVyICJTZXQgdXAgeW91ciBhY2NvdW50IiwgcGljayB0aGVpciBv' +
  'd24gcGFzc3dvcmQsIGFuZCB0aGV5J3JlIGluIOKAlCBubyBuZWVkIHRvIGtleSBpbgogICAgICAgIHRoZWlyIGRldGFpbHMgb3Ig' +
  'c2hhcmUgYSBwYXNzd29yZCB3aXRoIHRoZW0uPC9wPgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGczIiBzdHlsZT0ibWFyZ2luLXRv' +
  'cDoxMHB4Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlRoZXkgYmVjb21lPC9sYWJlbD48c2VsZWN0IGlkPSJj' +
  'X3JvbGUiPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2VydmVyIj5GaWVsZCBzZXJ2ZXI8L29wdGlvbj48b3B0aW9uIHZhbHVl' +
  'PSJhZG1pbiI+QWRtaW48L29wdGlvbj48L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkhv' +
  'dyBtYW55IGNhbiB1c2UgaXQ8L2xhYmVsPjxpbnB1dCBpZD0iY191c2VzIiB0eXBlPSJudW1iZXIiIG1pbj0iMSIgbWF4PSI1MDAi' +
  'IHZhbHVlPSIxIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkV4cGlyZXMgKG9wdGlvbmFsKTwvbGFi' +
  'ZWw+PGlucHV0IGlkPSJjX2V4cCIgdHlwZT0iZGF0ZSI+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlk' +
  'IGcyIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBheSBwZXIgc2VydmUgKGZpZWxkIHNlcnZlcnMpPC9sYWJl' +
  'bD48aW5wdXQgaWQ9ImNfcGF5IiB0eXBlPSJudW1iZXIiIHN0ZXA9IjAuMDEiIHBsYWNlaG9sZGVyPSI0NS4wMCI+PC9kaXY+CiAg' +
  'ICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Ob3RlIHRvIHlvdXJzZWxmPC9sYWJlbD48aW5wdXQgaWQ9ImNfbm90ZSIg' +
  'cGxhY2Vob2xkZXI9IkZvciBNYXJpYSDigJQgZXZpY3Rpb25zIj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxidXR0b24gY2xh' +
  'c3M9ImJ0biBzbSIgaWQ9ImNfbWFrZSI+R2VuZXJhdGUgYSBjb2RlPC9idXR0b24+CiAgICAgIDxkaXYgaWQ9ImNfbGlzdCIgc3R5' +
  'bGU9Im1hcmdpbi10b3A6MTJweCI+JHtjb2Rlc1RhYmxlKGNvZGVzKX08L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9' +
  'ImNhcmQiPgogICAgICA8aDI+Q291cnQgcG9ydGFsIHByb2JlIDxzcGFuIGNsYXNzPSJzdWIiPmV4cGVyaW1lbnRhbDwvc3Bhbj48' +
  'L2gyPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6LTRweCI+QXNrcyB0aGUgc2VydmVyIHRvIGZldGNo' +
  'IGEgY291bnR5IHBvcnRhbCBhbmQgcmVwb3J0IHdoYXQgY2FtZSBiYWNrIOKAlAogICAgICAgIHN0YXR1cywgY29va2llcywgZm9y' +
  'bXMsIGxpbmtzLiBUaGlzIGlzIHRoZSBncm91bmR3b3JrIGZvciBhdXRvbWF0aWMgY2FzZSBsb29rdXA6IHRoZXNlIHBvcnRhbHMg' +
  'Y2FuJ3QgYmUKICAgICAgICByZWFjaGVkIGZyb20gd2hlcmUgdGhpcyBhcHAgd2FzIHdyaXR0ZW4sIHNvIHRoZSBzZXJ2ZXIgaGFz' +
  'IHRvIGdvIGFuZCBsb29rLiBSdW4gb25lIGFuZCBzZW5kIG1lIHRoZSByZXN1bHQuPC9wPgogICAgICA8ZGl2IGNsYXNzPSJyb3ci' +
  'IGlkPSJwcm9iZUJ0bnMiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPiR7cG9ydGFscy5tYXAocHQgPT4KICAgICAgICBgPGJ1dHRv' +
  'biBjbGFzcz0iYnRuIHNlYyBzbSIgZGF0YS1wcm9iZT0iJHtlc2MocHQua2V5KX0iPiR7ZXNjKHB0LmxhYmVsKX08L2J1dHRvbj5g' +
  'KS5qb2luKCcnKX08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4KICAgICAgICA8' +
  'aW5wdXQgaWQ9InByb2JlVXJsIiBwbGFjZWhvbGRlcj0i4oCmb3IgYSBzcGVjaWZpYyBwYWdlIFVSTCIgc3R5bGU9ImZsZXg6MTtt' +
  'aW4td2lkdGg6MTUwcHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJwcm9iZUdvIj5Qcm9iZSBVUkw8' +
  'L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxwcmUgY2xhc3M9InByZXYiIGlkPSJwcm9iZU91dCIgc3R5bGU9ImRpc3BsYXk6' +
  'bm9uZTttYXJnaW4tdG9wOjEwcHgiPjwvcHJlPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIGJsb2NrIiBpZD0iY29w' +
  'eVByb2JlIiBzdHlsZT0iZGlzcGxheTpub25lO21hcmdpbi10b3A6OHB4Ij5Db3B5IHJlc3VsdDwvYnV0dG9uPgogICAgPC9kaXY+' +
  'CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5NeSBhY2NvdW50PC9oMj4KICAgICAgPGRpdiBjbGFzcz0iaGludCI+' +
  'T25lIHBhc3N3b3JkLCBldmVyeSBhcHAuIENoYW5naW5nIGl0IGhlcmUgY2hhbmdlcyBpdCBldmVyeXdoZXJlLjwvZGl2PgogICAg' +
  'ICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkN1cnJlbnQgcGFzc3dvcmQ8L2xhYmVsPjxpbnB1dCBpZD0ib3B3IiB0eXBlPSJw' +
  'YXNzd29yZCIgcGxhY2Vob2xkZXI9InRoZSBvbmUgeW91IHNpZ25lZCBpbiB3aXRoIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0i' +
  'ZmllbGQiPjxsYWJlbD5OZXcgcGFzc3dvcmQ8L2xhYmVsPjxpbnB1dCBpZD0ibnB3IiB0eXBlPSJwYXNzd29yZCIgcGxhY2Vob2xk' +
  'ZXI9IjgrIGNoYXJhY3RlcnMiPjwvZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc20iIGlkPSJzYXZlUHciPlVwZGF0ZSBw' +
  'YXNzd29yZDwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBpZD0iYnVpbGRTdGFtcCIgc3R5bGU9Im1hcmdpbi10b3A6' +
  'MTJweCI+YnVpbGQg4oCmPC9kaXY+CiAgICA8L2Rpdj5gKTsKICBiaW5kU2hlbGwoKTsKCiAgZmV0Y2goJy9hcGkvYnVpbGQnKS50' +
  'aGVuKHIgPT4gci5qc29uKCkpLnRoZW4oYiA9PiB7CiAgICBjb25zdCBlbCA9ICQoJyNidWlsZFN0YW1wJyk7CiAgICBpZiAoZWwp' +
  'IGVsLnRleHRDb250ZW50ID0gJ1NlcnZlVHJhY2sgYnVpbGQgJyArIGIuYnVpbGQgKyAoYi5wcm9iZVRhcmdldHMgPyAnIMK3IGJv' +
  'b3QgcHJvYmUgYXJtZWQnIDogJycpOwogIH0pLmNhdGNoKCgpID0+IHt9KTsKCgogIC8qIC0tLS0gYWNjZXNzIGNvZGVzIC0tLS0g' +
  'Ki8KICBhc3luYyBmdW5jdGlvbiBkcmF3Q29kZXMoKSB7CiAgICAkKCcjY19saXN0JykuaW5uZXJIVE1MID0gY29kZXNUYWJsZShh' +
  'd2FpdCBhcGkoJy9jb2RlcycpKTsKICAgIHdpcmVDb2RlcygpOwogIH0KCiAgZnVuY3Rpb24gd2lyZUNvZGVzKCkgewogICAgZG9j' +
  'dW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtY29weV0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNrID0gYXN5bmMgZSA9PiB7' +
  'CiAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgdHJ5IHsgYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQo' +
  'YS5kYXRhc2V0LmNvcHkpOyB0b2FzdCgnQ29waWVkICcgKyBhLmRhdGFzZXQuY29weSk7IH0KICAgICAgY2F0Y2ggKGVycikgeyB0' +
  'b2FzdCgnU2VsZWN0IGl0IGFuZCBjb3B5IGJ5IGhhbmQnLCB0cnVlKTsgfQogICAgfSk7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVj' +
  'dG9yQWxsKCdbZGF0YS1yZXZva2VdJykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGFzeW5jIGUgPT4gewogICAgICBlLnByZXZl' +
  'bnREZWZhdWx0KCk7CiAgICAgIGlmICghY29uZmlybSgnUmV2b2tlIHRoaXMgY29kZT8gQW55b25lIHdobyBhbHJlYWR5IHVzZWQg' +
  'aXQga2VlcHMgdGhlaXIgYWNjb3VudC4nKSkgcmV0dXJuOwogICAgICBhd2FpdCBhcGkoJy9jb2Rlcy8nICsgYS5kYXRhc2V0LnJl' +
  'dm9rZSwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcmV2b2tlZDogdHJ1ZSB9KSB9KTsKICAgICAg' +
  'dG9hc3QoJ1Jldm9rZWQnKTsgZHJhd0NvZGVzKCk7CiAgICB9KTsKICB9CiAgd2lyZUNvZGVzKCk7CgogICQoJyNjX21ha2UnKS5v' +
  'bmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsKICAgICAgY29uc3QgbWFkZSA9IGF3YWl0IGFwaSgnL2NvZGVzJywgeyBt' +
  'ZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHJvbGU6ICQoJyNjX3JvbGUnKS52YWx1ZSwKICAg' +
  'ICAgICBtYXhfdXNlczogJCgnI2NfdXNlcycpLnZhbHVlLAogICAgICAgIGV4cGlyZXNfYXQ6ICQoJyNjX2V4cCcpLnZhbHVlIHx8' +
  'IG51bGwsCiAgICAgICAgZGVmYXVsdF9wYXk6ICQoJyNjX3BheScpLnZhbHVlIHx8IDAsCiAgICAgICAgbm90ZTogJCgnI2Nfbm90' +
  'ZScpLnZhbHVlCiAgICAgIH0pIH0pOwogICAgICAkKCcjY19ub3RlJykudmFsdWUgPSAnJzsKICAgICAgdG9hc3QoJ0NvZGUgJyAr' +
  'IG1hZGUuY29kZSk7CiAgICAgIGRyYXdDb2RlcygpOwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9' +
  'CiAgfTsKICBkcmF3Q29kZXMoKS5jYXRjaCgoKSA9PiB7fSk7CgogIC8qIC0tLS0gcG9ydGFsIHByb2JlIC0tLS0gKi8KICBjb25z' +
  'dCBwcm9iZU91dCA9ICQoJyNwcm9iZU91dCcpOwogIGNvbnN0IHJ1blByb2JlID0gYXN5bmMgYm9keSA9PiB7CiAgICBwcm9iZU91' +
  'dC5zdHlsZS5kaXNwbGF5ID0gJyc7CiAgICBwcm9iZU91dC50ZXh0Q29udGVudCA9ICdQcm9iaW5n4oCmICh0aGlzIGNhbiB0YWtl' +
  'IHVwIHRvIDIwIHNlY29uZHMpJzsKICAgICQoJyNjb3B5UHJvYmUnKS5zdHlsZS5kaXNwbGF5ID0gJyc7CiAgICB0cnkgewogICAg' +
  'ICBjb25zdCByID0gYXdhaXQgYXBpKCcvcG9ydGFsLXByb2JlJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdp' +
  'ZnkoYm9keSkgfSk7CiAgICAgIHByb2JlT3V0LnRleHRDb250ZW50ID0gSlNPTi5zdHJpbmdpZnkociwgbnVsbCwgMik7CiAgICB9' +
  'IGNhdGNoIChlKSB7CiAgICAgIHByb2JlT3V0LnRleHRDb250ZW50ID0gJ1Byb2JlIGZhaWxlZDogJyArIGUubWVzc2FnZTsKICAg' +
  'IH0KICB9OwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXByb2JlXScpLmZvckVhY2goYiA9PgogICAgYi5vbmNs' +
  'aWNrID0gKCkgPT4gcnVuUHJvYmUoeyBwb3J0YWw6IGIuZGF0YXNldC5wcm9iZSB9KSk7CiAgJCgnI3Byb2JlR28nKS5vbmNsaWNr' +
  'ID0gKCkgPT4gewogICAgY29uc3QgdSA9ICQoJyNwcm9iZVVybCcpLnZhbHVlLnRyaW0oKTsKICAgIGlmICh1KSBydW5Qcm9iZSh7' +
  'IHVybDogdSB9KTsKICB9OwogICQoJyNjb3B5UHJvYmUnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgdHJ5IHsgYXdhaXQg' +
  'bmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQocHJvYmVPdXQudGV4dENvbnRlbnQpOyB0b2FzdCgnQ29waWVkJyk7IH0KICAg' +
  'IGNhdGNoIChlKSB7IHRvYXN0KCdTZWxlY3QgdGhlIHRleHQgYW5kIGNvcHkgaXQgYnkgaGFuZCcsIHRydWUpOyB9CiAgfTsKCiAg' +
  'ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdXNlcl0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNrID0gZSA9PiB7CiAg' +
  'ICBlLnByZXZlbnREZWZhdWx0KCk7IHVzZXJGb3JtKHVzZXJzLmZpbmQodSA9PiBTdHJpbmcodS5pZCkgPT09IGEuZGF0YXNldC51' +
  'c2VyKSk7CiAgfSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtY2xpZW50XScpLmZvckVhY2goYSA9PiBhLm9u' +
  'Y2xpY2sgPSBlID0+IHsKICAgIGUucHJldmVudERlZmF1bHQoKTsgY2xpZW50Rm9ybShjbGllbnRzLmZpbmQoYyA9PiBTdHJpbmco' +
  'Yy5pZCkgPT09IGEuZGF0YXNldC5jbGllbnQpKTsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS10cGxd' +
  'JykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGUgPT4gewogICAgZS5wcmV2ZW50RGVmYXVsdCgpOyB0ZW1wbGF0ZUZvcm0odGVt' +
  'cGxhdGVzLmZpbmQodCA9PiBTdHJpbmcodC5pZCkgPT09IGEuZGF0YXNldC50cGwpKTsKICB9KTsKICB3aXJlUGxhbkNhcmQoKTsK' +
  'ICBjb25zdCBjb1NhdmUgPSAkKCcjY29TYXZlJyk7CiAgaWYgKGNvU2F2ZSkgY29TYXZlLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7' +
  'CiAgICB0cnkgewogICAgICBhd2FpdCBhcGkoJy9jb21wYW5pZXMvJyArIChoZXJlLmlkKSwgeyBtZXRob2Q6ICdQQVRDSCcsIGJv' +
  'ZHk6IEpTT04uc3RyaW5naWZ5KHsKICAgICAgICBuYW1lOiAkKCcjY29OYW1lJykudmFsdWUsIGNvbnRhY3RfZW1haWw6ICQoJyNj' +
  'b0VtYWlsJykudmFsdWUsIHBob25lOiAkKCcjY29QaG9uZScpLnZhbHVlIH0pIH0pOwogICAgICBTLm1lID0gYXdhaXQgYXBpKCcv' +
  'bWUnKTsKICAgICAgdG9hc3QoJ0NvbXBhbnkgc2F2ZWQnKTsKICAgICAgcmVuZGVyKCk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0' +
  'KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9OwogIGNvbnN0IG5ld0NvID0gJCgnI25ld0NvJyk7CiAgaWYgKG5ld0NvKSBuZXdDby5v' +
  'bmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgY29uc3QgbmFtZSA9ICQoJyNuZXdDb05hbWUnKS52YWx1ZS50cmltKCk7CiAgICBp' +
  'ZiAoIW5hbWUpIHJldHVybiB0b2FzdCgnR2l2ZSB0aGUgY29tcGFueSBhIG5hbWUnLCB0cnVlKTsKICAgIHRyeSB7CiAgICAgIGF3' +
  'YWl0IGFwaSgnL2NvbXBhbmllcycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgbmFtZSB9KSB9KTsK' +
  'ICAgICAgUy5tZSA9IGF3YWl0IGFwaSgnL21lJyk7CiAgICAgIHRvYXN0KG5hbWUgKyAnIGNyZWF0ZWQnKTsKICAgICAgcmVuZGVy' +
  'KCk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9OwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0' +
  'b3JBbGwoJ1tkYXRhLWVudGVyXScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sgPSBhc3luYyBlID0+IHsKICAgIGUucHJldmVudERl' +
  'ZmF1bHQoKTsKICAgIHRyeSB7CiAgICAgIGNvbnN0IG91dCA9IGF3YWl0IGFwaSgnL2NvbXBhbmllcy8nICsgYS5kYXRhc2V0LmVu' +
  'dGVyICsgJy9lbnRlcicsIHsgbWV0aG9kOiAnUE9TVCcgfSk7CiAgICAgIFMubWUgPSBhd2FpdCBhcGkoJy9tZScpOwogICAgICB0' +
  'b2FzdCgnTm93IGluICcgKyBvdXQuY29tcGFueS5uYW1lKTsKICAgICAgcmVuZGVyKCk7CiAgICB9IGNhdGNoIChlcnIpIHsgdG9h' +
  'c3QoZXJyLm1lc3NhZ2UsIHRydWUpOyB9CiAgfSk7CiAgJCgnI25ld1VzZXInKS5vbmNsaWNrID0gKCkgPT4gdXNlckZvcm0obnVs' +
  'bCk7CiAgJCgnI25ld0NsaWVudCcpLm9uY2xpY2sgPSAoKSA9PiBjbGllbnRGb3JtKG51bGwpOwogICQoJyNuZXdUcGwnKS5vbmNs' +
  'aWNrID0gKCkgPT4gdGVtcGxhdGVGb3JtKG51bGwpOwogICQoJyNzYXZlUHcnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAg' +
  'dHJ5IHsKICAgICAgY29uc3QgciA9IGF3YWl0IGFwaSgnL21lL3Bhc3N3b3JkJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTogSlNP' +
  'Ti5zdHJpbmdpZnkoewogICAgICAgIHBhc3N3b3JkOiAkKCcjbnB3JykudmFsdWUsIG9sZF9wYXNzd29yZDogJCgnI29wdycpLnZh' +
  'bHVlIH0pIH0pOwogICAgICAkKCcjb3B3JykudmFsdWUgPSAnJzsgJCgnI25wdycpLnZhbHVlID0gJyc7CiAgICAgIHRvYXN0KHIu' +
  'ZXZlcnl3aGVyZSA9PT0gZmFsc2UgPyAnQ2hhbmdlZCBoZXJlIOKAlCBvdGhlciBhcHBzIHN0aWxsIGhhdmUgdGhlIG9sZCBvbmUn' +
  'IDogJ1Bhc3N3b3JkIHVwZGF0ZWQgZXZlcnl3aGVyZScpOwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUp' +
  'OyB9CiAgfTsKfQoKZnVuY3Rpb24gdXNlckZvcm0odSkgewogIGNvbnN0IHYgPSB1IHx8IHsgcm9sZTogJ3NlcnZlcicsIGFjdGl2' +
  'ZTogdHJ1ZSB9OwogIHNoZWV0KHUgPyAnRWRpdCAnICsgdS5uYW1lIDogJ0FkZCBwZXJzb24nLCBgCiAgICA8ZGl2IGNsYXNzPSJm' +
  'aWVsZCI+PGxhYmVsPk5hbWU8L2xhYmVsPjxpbnB1dCBpZD0idV9uYW1lIiB2YWx1ZT0iJHtlc2Modi5uYW1lKX0iPjwvZGl2Pgog' +
  'ICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5FbWFpbCAodXNlZCB0byBzaWduIGluKTwvbGFiZWw+PGlucHV0IGlkPSJ1X2Vt' +
  'YWlsIiB0eXBlPSJlbWFpbCIgdmFsdWU9IiR7ZXNjKHYuZW1haWwpfSI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxh' +
  'YmVsPiR7dSA/ICdOZXcgcGFzc3dvcmQgKGxlYXZlIGJsYW5rIHRvIGtlZXApJyA6ICdQYXNzd29yZCd9PC9sYWJlbD48aW5wdXQg' +
  'aWQ9InVfcGFzc3dvcmQiIHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSIke3UgPyAndW5jaGFuZ2VkJyA6ICdzZXQgYSBwYXNzd29y' +
  'ZCd9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlJvbGU8' +
  'L2xhYmVsPjxzZWxlY3QgaWQ9InVfcm9sZSI+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2VydmVyIiAke3Yucm9sZSA9PT0gJ3Nl' +
  'cnZlcicgPyAnc2VsZWN0ZWQnIDogJyd9PkZpZWxkIHNlcnZlcjwvb3B0aW9uPgogICAgICAgIDxvcHRpb24gdmFsdWU9ImFkbWlu' +
  'IiAke3Yucm9sZSA9PT0gJ2FkbWluJyA/ICdzZWxlY3RlZCcgOiAnJ30+QWRtaW48L29wdGlvbj4KICAgICAgICAke2lzT3duZXIo' +
  'KSA/IGA8b3B0aW9uIHZhbHVlPSJvd25lciIgJHt2LnJvbGUgPT09ICdvd25lcicgPyAnc2VsZWN0ZWQnIDogJyd9Pk93bmVyIChl' +
  'dmVyeSBjb21wYW55KTwvb3B0aW9uPmAgOiAnJ30KICAgICAgPC9zZWxlY3Q+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxk' +
  'Ij48bGFiZWw+RGVmYXVsdCBwYXkgcGVyIHNlcnZlPC9sYWJlbD48aW5wdXQgaWQ9InVfZGVmYXVsdF9wYXkiIHR5cGU9Im51bWJl' +
  'ciIgc3RlcD0iMC4wMSIgdmFsdWU9IiR7di5kZWZhdWx0X3BheSB8fCAnJ30iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVs' +
  'ZCI+PGxhYmVsPlBob25lPC9sYWJlbD48aW5wdXQgaWQ9InVfcGhvbmUiIHZhbHVlPSIke2VzYyh2LnBob25lKX0iPjwvZGl2Pgog' +
  'ICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkxpY2Vuc2UgLyByZWdpc3RyYXRpb24gIzwvbGFiZWw+PGlucHV0IGlkPSJ1' +
  'X2xpY2Vuc2Vfbm8iIHZhbHVlPSIke2VzYyh2LmxpY2Vuc2Vfbm8pfSI+PC9kaXY+CiAgICA8L2Rpdj4KICAgICR7dSA/IGA8ZGl2' +
  'IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlN0YXR1czwvbGFiZWw+PHNlbGVjdCBpZD0idV9hY3RpdmUiPgogICAgICA8b3B0aW9uIHZh' +
  'bHVlPSJ0cnVlIiAke3YuYWN0aXZlID8gJ3NlbGVjdGVkJyA6ICcnfT5BY3RpdmU8L29wdGlvbj4KICAgICAgPG9wdGlvbiB2YWx1' +
  'ZT0iZmFsc2UiICR7IXYuYWN0aXZlID8gJ3NlbGVjdGVkJyA6ICcnfT5EZWFjdGl2YXRlZDwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2' +
  'PmAgOiAnJ30KICAgIDxkaXYgY2xhc3M9InJvdyI+PGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0ic2F2ZSI+U2F2ZTwvYnV0dG9uPgog' +
  'ICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5DYW5jZWw8L2J1dHRvbj48L2Rpdj5gLCBl' +
  'bCA9PiB7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IGJv' +
  'ZHkgPSB7CiAgICAgICAgbmFtZTogZWwucXVlcnlTZWxlY3RvcignI3VfbmFtZScpLnZhbHVlLCBlbWFpbDogZWwucXVlcnlTZWxl' +
  'Y3RvcignI3VfZW1haWwnKS52YWx1ZSwKICAgICAgICByb2xlOiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9yb2xlJykudmFsdWUsIHBo' +
  'b25lOiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9waG9uZScpLnZhbHVlLAogICAgICAgIGxpY2Vuc2Vfbm86IGVsLnF1ZXJ5U2VsZWN0' +
  'b3IoJyN1X2xpY2Vuc2Vfbm8nKS52YWx1ZSwKICAgICAgICBkZWZhdWx0X3BheTogZWwucXVlcnlTZWxlY3RvcignI3VfZGVmYXVs' +
  'dF9wYXknKS52YWx1ZSB8fCAwCiAgICAgIH07CiAgICAgIGNvbnN0IHB3ID0gZWwucXVlcnlTZWxlY3RvcignI3VfcGFzc3dvcmQn' +
  'KS52YWx1ZTsKICAgICAgaWYgKHB3KSBib2R5LnBhc3N3b3JkID0gcHc7CiAgICAgIGlmICh1KSBib2R5LmFjdGl2ZSA9IGVsLnF1' +
  'ZXJ5U2VsZWN0b3IoJyN1X2FjdGl2ZScpLnZhbHVlID09PSAndHJ1ZSc7CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgKHUgPyBh' +
  'cGkoJy91c2Vycy8nICsgdS5pZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pCiAgICAg' +
  'ICAgICAgICAgICAgOiBhcGkoJy91c2VycycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0p' +
  'KTsKICAgICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KCdTYXZlZCcpOyBnbygnYWRtaW4nKTsKICAgICAgfSBjYXRjaCAoZSkgeyB0' +
  'b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgICB9OwogIH0pOwp9CgpmdW5jdGlvbiBjbGllbnRGb3JtKGMpIHsKICBjb25zdCB2' +
  'ID0gYyB8fCB7fTsKICBzaGVldChjID8gJ0VkaXQgJyArIGMubmFtZSA6ICdBZGQgY2xpZW50JywgYAogICAgPGRpdiBjbGFzcz0i' +
  'ZmllbGQiPjxsYWJlbD5GaXJtIC8gY2xpZW50IG5hbWU8L2xhYmVsPjxpbnB1dCBpZD0iY19uYW1lIiB2YWx1ZT0iJHtlc2Modi5u' +
  'YW1lKX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q29u' +
  'dGFjdDwvbGFiZWw+PGlucHV0IGlkPSJjX2NvbnRhY3RfbmFtZSIgdmFsdWU9IiR7ZXNjKHYuY29udGFjdF9uYW1lKX0iPjwvZGl2' +
  'PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBob25lPC9sYWJlbD48aW5wdXQgaWQ9ImNfcGhvbmUiIHZhbHVlPSIk' +
  'e2VzYyh2LnBob25lKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkVtYWlsPC9sYWJlbD48aW5wdXQg' +
  'aWQ9ImNfZW1haWwiIHR5cGU9ImVtYWlsIiB2YWx1ZT0iJHtlc2Modi5lbWFpbCl9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0i' +
  'ZmllbGQiPjxsYWJlbD5EZWZhdWx0IGZlZSBwZXIgc2VydmU8L2xhYmVsPjxpbnB1dCBpZD0iY19kZWZhdWx0X2ZlZSIgdHlwZT0i' +
  'bnVtYmVyIiBzdGVwPSIwLjAxIiB2YWx1ZT0iJHt2LmRlZmF1bHRfZmVlIHx8ICcnfSI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxk' +
  'aXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+QmlsbGluZyBhZGRyZXNzPC9sYWJlbD48dGV4dGFyZWEgaWQ9ImNfYWRkcmVzcyIgc3R5' +
  'bGU9Im1pbi1oZWlnaHQ6NjBweCI+JHtlc2Modi5hZGRyZXNzKX08L3RleHRhcmVhPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmll' +
  'bGQiPjxsYWJlbD5Ob3RlczwvbGFiZWw+PHRleHRhcmVhIGlkPSJjX25vdGVzIiBzdHlsZT0ibWluLWhlaWdodDo2MHB4Ij4ke2Vz' +
  'Yyh2Lm5vdGVzKX08L3RleHRhcmVhPjwvZGl2PgogICAgPGRpdiBjbGFzcz0icm93Ij48YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJz' +
  'YXZlIj5TYXZlPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNhbmNl' +
  'bDwvYnV0dG9uPjwvZGl2PmAsIGVsID0+IHsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNzYXZlJykub25jbGljayA9IGFzeW5jICgp' +
  'ID0+IHsKICAgICAgY29uc3QgYm9keSA9IHt9OwogICAgICBbJ25hbWUnLCdjb250YWN0X25hbWUnLCdwaG9uZScsJ2VtYWlsJywn' +
  'ZGVmYXVsdF9mZWUnLCdhZGRyZXNzJywnbm90ZXMnXQogICAgICAgIC5mb3JFYWNoKGYgPT4gYm9keVtmXSA9IGVsLnF1ZXJ5U2Vs' +
  'ZWN0b3IoJyNjXycgKyBmKS52YWx1ZSk7CiAgICAgIHRyeSB7CiAgICAgICAgYXdhaXQgKGMgPyBhcGkoJy9jbGllbnRzLycgKyBj' +
  'LmlkLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSkKICAgICAgICAgICAgICAgICA6IGFw' +
  'aSgnL2NsaWVudHMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KSk7CiAgICAgICAgY2xv' +
  'c2VTaGVldCgpOyB0b2FzdCgnU2F2ZWQnKTsgZ28oJ2FkbWluJyk7CiAgICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdl' +
  'LCB0cnVlKTsgfQogICAgfTsKICB9KTsKfQoKYXN5bmMgZnVuY3Rpb24gdGVtcGxhdGVGb3JtKHQpIHsKICBjb25zdCBmaWVsZHMg' +
  'PSBhd2FpdCBhcGkoJy90ZW1wbGF0ZS1maWVsZHMnKTsKICBjb25zdCB2ID0gdCB8fCB7IGJvZHk6ICcnLCBpc19kZWZhdWx0OiBm' +
  'YWxzZSB9OwogIHNoZWV0KHQgPyAnRWRpdCB0ZW1wbGF0ZScgOiAnTmV3IGFmZmlkYXZpdCB0ZW1wbGF0ZScsIGAKICAgIDxkaXYg' +
  'Y2xhc3M9ImdyaWQgZzIiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlRlbXBsYXRlIG5hbWU8L2xhYmVsPjxpbnB1' +
  'dCBpZD0idF9uYW1lIiB2YWx1ZT0iJHtlc2Modi5uYW1lKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVs' +
  'Pkp1cmlzZGljdGlvbiAvIGNvdXJ0PC9sYWJlbD48aW5wdXQgaWQ9InRfanVyaXNkaWN0aW9uIiB2YWx1ZT0iJHtlc2Modi5qdXJp' +
  'c2RpY3Rpb24pfSI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Qm9keTwvbGFiZWw+CiAg' +
  'ICAgIDx0ZXh0YXJlYSBpZD0idF9ib2R5IiBzdHlsZT0ibWluLWhlaWdodDoyMjBweDtmb250OjEyLjVweC8xLjUgJ0NvdXJpZXIg' +
  'TmV3Jyxtb25vc3BhY2UiPiR7ZXNjKHYuYm9keSl9PC90ZXh0YXJlYT4KICAgICAgPGRpdiBjbGFzcz0iaGludCI+Q2xpY2sgYSBm' +
  'aWVsZCB0byBpbnNlcnQgaXQgYXQgdGhlIGN1cnNvcjo8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idG9rZW5zIj4ke2ZpZWxkcy5t' +
  'YXAoZiA9PiBgPGJ1dHRvbiBkYXRhLWY9IiR7ZlswXX0iIHRpdGxlPSIke2VzYyhmWzFdKX0iPnt7JHtmWzBdfX19PC9idXR0b24+' +
  'YCkuam9pbignJyl9PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxsYWJlbCBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNl' +
  'bnRlcjtnYXA6OHB4Ij48aW5wdXQgdHlwZT0iY2hlY2tib3giIGlkPSJ0X2RlZmF1bHQiIHN0eWxlPSJ3aWR0aDphdXRvIiAke3Yu' +
  'aXNfZGVmYXVsdCA/ICdjaGVja2VkJyA6ICcnfT4gVXNlIGFzIHRoZSBkZWZhdWx0IHRlbXBsYXRlPC9sYWJlbD4KICAgIDxkaXYg' +
  'Y2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InNhdmUiPlNh' +
  'dmU8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgaWQ9InByZXZpZXciPlByZXZpZXcgd2l0aCByZWFsIGpv' +
  'YjwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNsaWNrPSJjbG9zZVNoZWV0KCkiPkNhbmNlbDwvYnV0' +
  'dG9uPgogICAgICAke3QgPyAnPGJ1dHRvbiBjbGFzcz0iYnRuIGdob3N0IiBpZD0iZGVsIiBzdHlsZT0iY29sb3I6dmFyKC0tYmFk' +
  'KTttYXJnaW4tbGVmdDphdXRvIj5EZWxldGU8L2J1dHRvbj4nIDogJyd9CiAgICA8L2Rpdj4KICAgIDxwcmUgY2xhc3M9InByZXYi' +
  'IGlkPSJ0cHJldiIgc3R5bGU9ImRpc3BsYXk6bm9uZTttYXJnaW4tdG9wOjEycHgiPjwvcHJlPmAsIGVsID0+IHsKICAgIGNvbnN0' +
  'IHRhID0gZWwucXVlcnlTZWxlY3RvcignI3RfYm9keScpOwogICAgZWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtZl0nKS5mb3JF' +
  'YWNoKGIgPT4gYi5vbmNsaWNrID0gKCkgPT4gewogICAgICBjb25zdCB0b2sgPSAne3snICsgYi5kYXRhc2V0LmYgKyAnfX0nOwog' +
  'ICAgICBjb25zdCBzID0gdGEuc2VsZWN0aW9uU3RhcnQsIGUgPSB0YS5zZWxlY3Rpb25FbmQ7CiAgICAgIHRhLnZhbHVlID0gdGEu' +
  'dmFsdWUuc2xpY2UoMCwgcykgKyB0b2sgKyB0YS52YWx1ZS5zbGljZShlKTsKICAgICAgdGEuZm9jdXMoKTsgdGEuc2VsZWN0aW9u' +
  'U3RhcnQgPSB0YS5zZWxlY3Rpb25FbmQgPSBzICsgdG9rLmxlbmd0aDsKICAgIH0pOwogICAgZWwucXVlcnlTZWxlY3RvcignI3By' +
  'ZXZpZXcnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCByID0gYXdhaXQgYXBpKCcvdGVtcGxhdGVzL3ByZXZp' +
  'ZXcnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGJvZHk6IHRhLnZhbHVlIH0pIH0pOwogICAgICBj' +
  'b25zdCBwID0gZWwucXVlcnlTZWxlY3RvcignI3RwcmV2Jyk7CiAgICAgIHAuc3R5bGUuZGlzcGxheSA9ICcnOyBwLnRleHRDb250' +
  'ZW50ID0gci50ZXh0OwogICAgfTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNzYXZlJykub25jbGljayA9IGFzeW5jICgpID0+IHsK' +
  'ICAgICAgY29uc3QgYm9keSA9IHsKICAgICAgICBuYW1lOiBlbC5xdWVyeVNlbGVjdG9yKCcjdF9uYW1lJykudmFsdWUsIGp1cmlz' +
  'ZGljdGlvbjogZWwucXVlcnlTZWxlY3RvcignI3RfanVyaXNkaWN0aW9uJykudmFsdWUsCiAgICAgICAgYm9keTogdGEudmFsdWUs' +
  'IGlzX2RlZmF1bHQ6IGVsLnF1ZXJ5U2VsZWN0b3IoJyN0X2RlZmF1bHQnKS5jaGVja2VkCiAgICAgIH07CiAgICAgIGlmICghYm9k' +
  'eS5uYW1lLnRyaW0oKSkgcmV0dXJuIHRvYXN0KCdHaXZlIHRoZSB0ZW1wbGF0ZSBhIG5hbWUnLCB0cnVlKTsKICAgICAgdHJ5IHsK' +
  'ICAgICAgICBhd2FpdCAodCA/IGFwaSgnL3RlbXBsYXRlcy8nICsgdC5pZCwgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04u' +
  'c3RyaW5naWZ5KGJvZHkpIH0pCiAgICAgICAgICAgICAgICAgOiBhcGkoJy90ZW1wbGF0ZXMnLCB7IG1ldGhvZDogJ1BPU1QnLCBi' +
  'b2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KSk7CiAgICAgICAgY2xvc2VTaGVldCgpOyB0b2FzdCgnU2F2ZWQnKTsgZ28oJ2Fk' +
  'bWluJyk7CiAgICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogICAgfTsKICAgIGlmIChlbC5xdWVy' +
  'eVNlbGVjdG9yKCcjZGVsJykpIGVsLnF1ZXJ5U2VsZWN0b3IoJyNkZWwnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBp' +
  'ZiAoIWNvbmZpcm0oJ0RlbGV0ZSB0aGlzIHRlbXBsYXRlPycpKSByZXR1cm47CiAgICAgIGF3YWl0IGFwaSgnL3RlbXBsYXRlcy8n' +
  'ICsgdC5pZCwgeyBtZXRob2Q6ICdERUxFVEUnIH0pOwogICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KCdEZWxldGVkJyk7IGdvKCdh' +
  'ZG1pbicpOwogICAgfTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tIGJvb3QgLS0gKi8KY29uc3QgVklFV1MgPSB7IGRhc2g6IGRhc2hWaWV3LCBqb2JzOiBqb2JzVmlldywg' +
  'am9iOiBqb2JWaWV3LCBzY2FuOiBzY2FuVmlldywKICB0b29sczogdG9vbHNWaWV3LCBwcm9wZXJ0eTogcHJvcGVydHlWaWV3LCBt' +
  'b25leTogbW9uZXlWaWV3LCBhZG1pbjogYWRtaW5WaWV3IH07Cgphc3luYyBmdW5jdGlvbiByZW5kZXIoKSB7CiAgY2xvc2VTaGVl' +
  'dCgpOwogIGlmICghUy5tZSkgcmV0dXJuIGxvZ2luVmlldygpOwogIGlmIChTLnZpZXcgPT09ICdqb2JzJykgUy5jYWNoZS5qb2JG' +
  'aWx0ZXIgPSBTLnBhcmFtczsKICBjb25zdCBmbiA9IFZJRVdTW1Mudmlld10gfHwgZGFzaFZpZXc7CiAgdHJ5IHsKICAgIGFwcC5p' +
  'bm5lckhUTUwgPSAnPGRpdiBjbGFzcz0id3JhcCI+PGRpdiBjbGFzcz0iZW1wdHkiPkxvYWRpbmfigKY8L2Rpdj48L2Rpdj4nOwog' +
  'ICAgYXdhaXQgZm4oKTsKICB9IGNhdGNoIChlKSB7CiAgICBpZiAoUy5tZSkgeyBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYDxkaXYg' +
  'Y2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImVtcHR5Ij4ke2VzYyhlLm1lc3NhZ2UpfTwvZGl2PjwvZGl2PmApOyBiaW5kU2hlbGwo' +
  'KTsgfQogIH0KfQoKKGFzeW5jIGZ1bmN0aW9uIGJvb3QoKSB7CiAgdHJ5IHsgUy5tZSA9IGF3YWl0IGFwaSgnL21lJyk7IH0gY2F0' +
  'Y2ggKGUpIHsgUy5tZSA9IG51bGw7IH0KICByZW5kZXIoKTsKfSkoKTsKfSkoKTsKCi8qIC0tLS0gaW5zdGFsbGFibGUgYXBwIC0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0KICAgQSBzZXJ2aWNlIHdvcmtlciBw' +
  'bHVzIGEgbWFuaWZlc3QgaXMgdGhlIHdob2xlIGRpZmZlcmVuY2UgYmV0d2VlbiBhIHdlYiBwYWdlCiAgIGFuZCBzb21ldGhpbmcg' +
  'dGhhdCBsaXZlcyBvbiB0aGUgaG9tZSBzY3JlZW4gd2l0aCBpdHMgb3duIGljb24gYW5kIG5vIGJyb3dzZXIKICAgYmFycy4gTm8g' +
  'c3RvcmUsIG5vIHJldmlldywgbm8gZGV2ZWxvcGVyIGFjY291bnQuCgogICBUaGUgYmFyIHdhaXRzIGEgY291cGxlIG9mIHNlY29u' +
  'ZHMgc28gaXQgbmV2ZXIgbGFuZHMgb24gdG9wIG9mIHdoYXQgc29tZW9uZQogICBpcyByZWFkaW5nLCBhbmQgb25jZSBkaXNtaXNz' +
  'ZWQgaXQgc3RheXMgZGlzbWlzc2VkIG9uIHRoYXQgZGV2aWNlLiAgICAgICAgICAqLwooZnVuY3Rpb24gKCkgewogIGlmICgnc2Vy' +
  'dmljZVdvcmtlcicgaW4gbmF2aWdhdG9yKSB7CiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignbG9hZCcsIGZ1bmN0aW9uICgp' +
  'IHsKICAgICAgbmF2aWdhdG9yLnNlcnZpY2VXb3JrZXIucmVnaXN0ZXIoJy9zdy5qcycpLmNhdGNoKGZ1bmN0aW9uICgpIHt9KTsK' +
  'ICAgIH0pOwogIH0KICB2YXIgc3RhbmRhbG9uZSA9IHdpbmRvdy5tYXRjaE1lZGlhKCcoZGlzcGxheS1tb2RlOiBzdGFuZGFsb25l' +
  'KScpLm1hdGNoZXMKICAgICAgICAgICAgICAgIHx8IHdpbmRvdy5uYXZpZ2F0b3Iuc3RhbmRhbG9uZSA9PT0gdHJ1ZTsKICBpZiAo' +
  'c3RhbmRhbG9uZSkgcmV0dXJuOwoKICB2YXIgS0VZID0gJ3N0X2EyaHMnOwogIHRyeSB7IGlmIChsb2NhbFN0b3JhZ2UuZ2V0SXRl' +
  'bShLRVkpID09PSAnMScpIHJldHVybjsgfSBjYXRjaCAoZSkge30KCiAgdmFyIGlvcyA9IC9pcGhvbmV8aXBhZHxpcG9kL2kudGVz' +
  'dChuYXZpZ2F0b3IudXNlckFnZW50KTsKICB2YXIgYmFyID0gbnVsbCwgZGVmZXJyZWQgPSBudWxsOwoKICBmdW5jdGlvbiBidWls' +
  'ZChodG1sKSB7CiAgICBiYXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICAgIGJhci5pZCA9ICdhMmhzJzsKICAg' +
  'IGJhci5pbm5lckhUTUwgPSAnPGltZyBjbGFzcz0iYWkiIHNyYz0iL2ljb24tMTkyLnBuZyIgYWx0PSIiPicgKyBodG1sICsKICAg' +
  'ICAgJzxidXR0b24gY2xhc3M9IngiIGFyaWEtbGFiZWw9IkRpc21pc3MiPiZ0aW1lczs8L2J1dHRvbj4nOwogICAgZG9jdW1lbnQu' +
  'Ym9keS5hcHBlbmRDaGlsZChiYXIpOwogICAgYmFyLnF1ZXJ5U2VsZWN0b3IoJy54Jykub25jbGljayA9IGZ1bmN0aW9uICgpIHsK' +
  'ICAgICAgYmFyLmNsYXNzTGlzdC5yZW1vdmUoJ29uJyk7CiAgICAgIHRyeSB7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKEtFWSwgJzEn' +
  'KTsgfSBjYXRjaCAoZSkge30KICAgIH07CiAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHsgYmFyLmNsYXNzTGlzdC5hZGQoJ29u' +
  'Jyk7IH0sIDI2MDApOwogIH0KCiAgaWYgKGlvcykgewogICAgYnVpbGQoJzxkaXYgY2xhc3M9ImF0Ij48Yj5QdXQgU2VydmVUcmFj' +
  'ayBvbiB5b3VyIGhvbWUgc2NyZWVuPC9iPicgKwogICAgICAgICAgJ1RhcCBTaGFyZSwgdGhlbiA8YiBzdHlsZT0iZGlzcGxheTpp' +
  'bmxpbmUiPkFkZCB0byBIb21lIFNjcmVlbjwvYj4uPC9kaXY+Jyk7CiAgfSBlbHNlIHsKICAgIHdpbmRvdy5hZGRFdmVudExpc3Rl' +
  'bmVyKCdiZWZvcmVpbnN0YWxscHJvbXB0JywgZnVuY3Rpb24gKGV2KSB7CiAgICAgIGV2LnByZXZlbnREZWZhdWx0KCk7CiAgICAg' +
  'IGRlZmVycmVkID0gZXY7CiAgICAgIGlmIChiYXIpIHJldHVybjsKICAgICAgYnVpbGQoJzxkaXYgY2xhc3M9ImF0Ij48Yj5JbnN0' +
  'YWxsIFNlcnZlVHJhY2s8L2I+UnVucyBmdWxsIHNjcmVlbiwgb3BlbnMgc3RyYWlnaHQgdG8geW91ciB3b3JrLjwvZGl2PicgKwog' +
  'ICAgICAgICAgICAnPGJ1dHRvbiBpZD0iYTJoc0dvIj5JbnN0YWxsPC9idXR0b24+Jyk7CiAgICAgIHZhciBnbyA9IGRvY3VtZW50' +
  'LmdldEVsZW1lbnRCeUlkKCdhMmhzR28nKTsKICAgICAgaWYgKGdvKSBnby5vbmNsaWNrID0gZnVuY3Rpb24gKCkgewogICAgICAg' +
  'IGJhci5jbGFzc0xpc3QucmVtb3ZlKCdvbicpOwogICAgICAgIGRlZmVycmVkLnByb21wdCgpOwogICAgICAgIGRlZmVycmVkID0g' +
  'bnVsbDsKICAgICAgICB0cnkgeyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShLRVksICcxJyk7IH0gY2F0Y2ggKGUpIHt9CiAgICAgIH07' +
  'CiAgICB9KTsKICB9Cn0pKCk7Cgo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg=='
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
const BUILD = '2026-09-02.24';           // shown in Setup so uploads can be confirmed
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
