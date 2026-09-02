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

-- The vehicle seen at an attempt. Kept as real fields rather than a sentence in
-- the notes, because a plate is the one thing you can read from the kerb that
-- ties a person to an address — and it is only useful if it can be searched.
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS plate       TEXT;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS plate_state TEXT;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS plate_key   TEXT;   -- normalised, for matching
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS vehicle     TEXT;   -- colour, make, model
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS vin         TEXT;
CREATE INDEX IF NOT EXISTS attempts_plate_idx ON attempts(plate_key);

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
  'dmVyIENpdmljIGluIGRyaXZld2F5LiI+PC90ZXh0YXJlYT48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+VmVo' +
  'aWNsZSA8c3BhbiBjbGFzcz0iaGludCI+4oCUIGlmIHRoZXJlIGlzIG9uZSBhdCB0aGUgYWRkcmVzczwvc3Bhbj48L2xhYmVsPgog' +
  'ICAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgICA8aW5wdXQgaWQ9ImFfcGxhdGUiIHBsYWNlaG9sZGVyPSJQbGF0ZSDi' +
  'gJQgRFhLNDQ3MSIgYXV0b2NhcGl0YWxpemU9ImNoYXJhY3RlcnMiCiAgICAgICAgICBzdHlsZT0idGV4dC10cmFuc2Zvcm06dXBw' +
  'ZXJjYXNlIj4KICAgICAgICA8aW5wdXQgaWQ9ImFfcGxhdGVfc3RhdGUiIHBsYWNlaG9sZGVyPSJUWCIgbWF4bGVuZ3RoPSIyIgog' +
  'ICAgICAgICAgc3R5bGU9InRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZSI+CiAgICAgIDwvZGl2PgogICAgICA8aW5wdXQgaWQ9ImFf' +
  'dmVoaWNsZSIgcGxhY2Vob2xkZXI9IlNpbHZlciBIb25kYSBDaXZpYyIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAgICAgPGRp' +
  'diBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPgogICAgICAgIDxpbnB1dCBpZD0iYV92aW4iIHBsYWNlaG9sZGVy' +
  'PSJWSU4g4oCUIG9wdGlvbmFsIiBhdXRvY2FwaXRhbGl6ZT0iY2hhcmFjdGVycyIKICAgICAgICAgIHN0eWxlPSJ0ZXh0LXRyYW5z' +
  'Zm9ybTp1cHBlcmNhc2U7ZmxleDoxIj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0idmluR28iIHR5cGU9' +
  'ImJ1dHRvbiI+RGVjb2RlPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBpZD0idmluT3V0IiBz' +
  'dHlsZT0ibWFyZ2luLXRvcDo2cHgiPkEgcGxhdGUgd3JpdHRlbiBkb3duIGhlcmUgaXMKICAgICAgICBzZWFyY2hhYmxlIGxhdGVy' +
  'IOKAlCB0aGUgc2FtZSBjYXIgYXQgYSBzZWNvbmQgYWRkcmVzcyBpcyBob3cgeW91IGNvbm5lY3QgdGhlbS48L2Rpdj4KICAgIDwv' +
  'ZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5XaGVyZSA8c3BhbiBjbGFzcz0iaGludCI+4oCUIG9ubHkgaWYgbm90' +
  'IHRoZSBhZGRyZXNzIG9uIHRoZSBqb2I8L3NwYW4+PC9sYWJlbD4KICAgICAgPGlucHV0IGlkPSJhX2FkZHIiIHBsYWNlaG9sZGVy' +
  'PSIke2VzYyhbam9iLmFkZHJlc3MxLCBqb2IuY2l0eV0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJywgJykpfSI+CiAgICAgIDxkaXYg' +
  'Y2xhc3M9ImhpbnQiPkEgd29yayBhZGRyZXNzLCBhIHJlbGF0aXZlJ3MgaG91c2UsIHdoZXJldmVyIGEgbmVpZ2hib3VyIHNlbnQg' +
  'eW91LgogICAgICAgIEl0IGdvZXMgb24gdGhlIHJlY29yZCBhbmQgdHVybnMgdXAgbmV4dCB0aW1lIHlvdSBzZWFyY2ggdGhpcyBw' +
  'ZXJzb24uPC9kaXY+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPldoZW48L2xhYmVsPjxpbnB1dCBpZD0iYV93' +
  'aGVuIiB0eXBlPSJkYXRldGltZS1sb2NhbCIgdmFsdWU9IiR7bG9jYWxOb3coKX0iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2Fy' +
  'ZCIgc3R5bGU9ImJhY2tncm91bmQ6I2Y4ZmFmYztib3gtc2hhZG93Om5vbmU7bWFyZ2luLWJvdHRvbToxMnB4Ij4KICAgICAgPGRp' +
  'diBjbGFzcz0icm93Ij48YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBpZD0iZ3BzQnRuIj5DYXB0dXJlIEdQUzwvYnV0dG9uPgog' +
  'ICAgICA8c3BhbiBjbGFzcz0iaGludCIgaWQ9Imdwc091dCIgc3R5bGU9Im1hcmdpbjowIj5Ob3QgY2FwdHVyZWQ8L3NwYW4+PC9k' +
  'aXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGhvdG9zPC9sYWJlbD4KICAgICAgPGRpdiBjbGFz' +
  'cz0icGhvdG9zIiBpZD0icGVuZFBob3RvcyI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0idGh1bWIgYWRkIiBpZD0icGhvdG9CdG4i' +
  'IHR5cGU9ImJ1dHRvbiI+77yLPHNwYW4+UGhvdG88L3NwYW4+PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNz' +
  'PSJoaW50Ij5UaGUgZG9vciwgdGhlIG51bWJlciwgdGhlIG5vdGljZSwgdGhlIGNhci4gVGhleSBnbyBvbiB0aGUgYXR0ZW1wdAog' +
  'ICAgICBhbmQgb24gdGhlIHJlcG9ydCB5b3VyIGNsaWVudCBzZWVzLjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJy' +
  'b3ciPgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJzYXZlQXR0IiBkaXNhYmxlZD5QaWNrIGFuIG91dGNvbWU8L2J1dHRv' +
  'bj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5DYW5jZWw8L2J1dHRvbj4KICAg' +
  'IDwvZGl2PmAsIGVsID0+IHsKICAgIGxldCBvdXRjb21lID0gbnVsbCwgZ3BzID0gbnVsbDsKICAgIC8qIFBob3RvcyBhcmUgcGlj' +
  'a2VkIGJlZm9yZSB0aGUgYXR0ZW1wdCBleGlzdHMsIHNvIHRoZXkgYXJlIGhlbGQgaGVyZSBhbmQKICAgICAgIHVwbG9hZGVkIG9u' +
  'Y2Ugc2F2aW5nIGdpdmVzIHVzIGFuIGF0dGVtcHQgaWQuICovCiAgICBjb25zdCBwZW5kaW5nID0gW107CiAgICBjb25zdCBzdHJp' +
  'cCA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNwZW5kUGhvdG9zJyk7CiAgICBjb25zdCBhZGRCdG4gPSBlbC5xdWVyeVNlbGVjdG9yKCcj' +
  'cGhvdG9CdG4nKTsKICAgIGNvbnN0IGRyYXdQZW5kaW5nID0gKCkgPT4gewogICAgICBzdHJpcC5xdWVyeVNlbGVjdG9yQWxsKCcu' +
  'cGVuZCcpLmZvckVhY2gobiA9PiBuLnJlbW92ZSgpKTsKICAgICAgcGVuZGluZy5mb3JFYWNoKChmLCBpKSA9PiB7CiAgICAgICAg' +
  'Y29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOwogICAgICAgIGIudHlwZSA9ICdidXR0b24nOwogICAg' +
  'ICAgIGIuY2xhc3NOYW1lID0gJ3RodW1iIHBlbmQnOwogICAgICAgIGIudGl0bGUgPSAnUmVtb3ZlJzsKICAgICAgICBiLmlubmVy' +
  'SFRNTCA9IGA8aW1nIHNyYz0iJHtVUkwuY3JlYXRlT2JqZWN0VVJMKGYpfSIgYWx0PSIiPjxzcGFuIGNsYXNzPSJ4Ij7Dlzwvc3Bh' +
  'bj5gOwogICAgICAgIGIub25jbGljayA9ICgpID0+IHsgcGVuZGluZy5zcGxpY2UoaSwgMSk7IGRyYXdQZW5kaW5nKCk7IH07CiAg' +
  'ICAgICAgc3RyaXAuaW5zZXJ0QmVmb3JlKGIsIGFkZEJ0bik7CiAgICAgIH0pOwogICAgICBhZGRCdG4ucXVlcnlTZWxlY3Rvcign' +
  'c3BhbicpLnRleHRDb250ZW50ID0gcGVuZGluZy5sZW5ndGggPyBgUGhvdG8gKCR7cGVuZGluZy5sZW5ndGh9KWAgOiAnUGhvdG8n' +
  'OwogICAgfTsKICAgIGFkZEJ0bi5vbmNsaWNrID0gKCkgPT4gcGlja1Bob3RvcyhmaWxlcyA9PiB7IHBlbmRpbmcucHVzaCguLi5m' +
  'aWxlcyk7IGRyYXdQZW5kaW5nKCk7IH0pOwogICAgZWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtb10nKS5mb3JFYWNoKGIgPT4g' +
  'Yi5vbmNsaWNrID0gKCkgPT4gewogICAgICBvdXRjb21lID0gYi5kYXRhc2V0Lm87CiAgICAgIGVsLnF1ZXJ5U2VsZWN0b3JBbGwo' +
  'J1tkYXRhLW9dJykuZm9yRWFjaCh4ID0+IHsgeC5jbGFzc05hbWUgPSAnYnRuIHNlYyBzbSc7IH0pOwogICAgICBiLmNsYXNzTmFt' +
  'ZSA9ICdidG4gc20nICsgKG91dGNvbWUgPT09ICdTZXJ2ZWQnID8gJyBvaycgOiAnJyk7CiAgICAgIGVsLnF1ZXJ5U2VsZWN0b3Io' +
  'JyNzZXJ2ZWRGaWVsZHMnKS5zdHlsZS5kaXNwbGF5ID0gb3V0Y29tZSA9PT0gJ1NlcnZlZCcgPyAnJyA6ICdub25lJzsKICAgICAg' +
  'Y29uc3QgcyA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNzYXZlQXR0Jyk7CiAgICAgIHMuZGlzYWJsZWQgPSBmYWxzZTsKICAgICAgcy50' +
  'ZXh0Q29udGVudCA9IG91dGNvbWUgPT09ICdTZXJ2ZWQnID8gJ1NhdmUg4oCUIG1hcmtzIGpvYiBTRVJWRUQnIDogJ1NhdmUgYXR0' +
  'ZW1wdCc7CiAgICB9KTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNncHNCdG4nKS5vbmNsaWNrID0gKCkgPT4gewogICAgICBjb25z' +
  'dCBvdXQgPSBlbC5xdWVyeVNlbGVjdG9yKCcjZ3BzT3V0Jyk7CiAgICAgIGlmICghbmF2aWdhdG9yLmdlb2xvY2F0aW9uKSByZXR1' +
  'cm4gb3V0LnRleHRDb250ZW50ID0gJ05vdCBzdXBwb3J0ZWQgb24gdGhpcyBkZXZpY2UnOwogICAgICBvdXQudGV4dENvbnRlbnQg' +
  'PSAnTG9jYXRpbmfigKYnOwogICAgICBuYXZpZ2F0b3IuZ2VvbG9jYXRpb24uZ2V0Q3VycmVudFBvc2l0aW9uKHBvcyA9PiB7CiAg' +
  'ICAgICAgZ3BzID0geyBsYXQ6IHBvcy5jb29yZHMubGF0aXR1ZGUsIGxuZzogcG9zLmNvb3Jkcy5sb25naXR1ZGUsIGFjY3VyYWN5' +
  'X206IHBvcy5jb29yZHMuYWNjdXJhY3kgfTsKICAgICAgICBvdXQuaW5uZXJIVE1MID0gYDxiIHN0eWxlPSJjb2xvcjp2YXIoLS1v' +
  'aykiPuKckyAke2dwcy5sYXQudG9GaXhlZCg1KX0sICR7Z3BzLmxuZy50b0ZpeGVkKDUpfTwvYj4gwrEke01hdGgucm91bmQoZ3Bz' +
  'LmFjY3VyYWN5X20pfW1gOwogICAgICB9LCBlcnIgPT4geyBvdXQudGV4dENvbnRlbnQgPSAnRmFpbGVkOiAnICsgZXJyLm1lc3Nh' +
  'Z2U7IH0sCiAgICAgICAgeyBlbmFibGVIaWdoQWNjdXJhY3k6IHRydWUsIHRpbWVvdXQ6IDE1MDAwLCBtYXhpbXVtQWdlOiAwIH0p' +
  'OwogICAgfTsKICAgIC8vIGF1dG8tY2FwdHVyZSBvbiBvcGVuIOKAlCB0aGUgYWZmaWRhdml0IGlzIHN0cm9uZ2VyIHdoZW4gZXZl' +
  'cnkgYXR0ZW1wdCBoYXMgY29vcmRpbmF0ZXMKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNncHNCdG4nKS5jbGljaygpOwoKICAgIC8q' +
  'IERlY29kaW5nIGEgVklOIHNheXMgd2hhdCB0aGUgY2FyIGlzLCBub3Qgd2hvIG93bnMgaXQg4oCUIHdoaWNoIGlzIHdoeSBpdCBp' +
  'cwogICAgICAgZnJlZS4gSXQgZmlsbHMgdGhlIGRlc2NyaXB0aW9uIGJveCBzbyBpdCBlbmRzIHVwIG9uIHRoZSBhZmZpZGF2aXQu' +
  'ICovCiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjdmluR28nKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCB2aW4g' +
  'PSAoZWwucXVlcnlTZWxlY3RvcignI2FfdmluJykudmFsdWUgfHwgJycpLnRyaW0oKTsKICAgICAgY29uc3Qgb3V0ID0gZWwucXVl' +
  'cnlTZWxlY3RvcignI3Zpbk91dCcpOwogICAgICBpZiAoIXZpbikgeyBvdXQudGV4dENvbnRlbnQgPSAnVHlwZSBhIFZJTiBmaXJz' +
  'dC4nOyByZXR1cm47IH0KICAgICAgb3V0LnRleHRDb250ZW50ID0gJ0RlY29kaW5n4oCmJzsKICAgICAgdHJ5IHsKICAgICAgICBj' +
  'b25zdCBkID0gYXdhaXQgYXBpKCcvdmluLycgKyBlbmNvZGVVUklDb21wb25lbnQodmluKSk7CiAgICAgICAgaWYgKCFkLm9rKSB7' +
  'IG91dC50ZXh0Q29udGVudCA9IGQuZXJyb3I7IHJldHVybjsgfQogICAgICAgIG91dC5pbm5lckhUTUwgPSBgPGI+JHtlc2MoZC52' +
  'ZWhpY2xlLnN1bW1hcnkpfTwvYj5gOwogICAgICAgIGNvbnN0IGJveCA9IGVsLnF1ZXJ5U2VsZWN0b3IoJyNhX3ZlaGljbGUnKTsK' +
  'ICAgICAgICBpZiAoIWJveC52YWx1ZS50cmltKCkpIGJveC52YWx1ZSA9IGQudmVoaWNsZS5zdW1tYXJ5OwogICAgICB9IGNhdGNo' +
  'IChlKSB7IG91dC50ZXh0Q29udGVudCA9IGUubWVzc2FnZTsgfQogICAgfTsKCiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjc2F2ZUF0' +
  'dCcpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IGJvZHkgPSBPYmplY3QuYXNzaWduKHsKICAgICAgICBvdXRj' +
  'b21lLAogICAgICAgIGF0dGVtcHRlZF9hdDogZWwucXVlcnlTZWxlY3RvcignI2Ffd2hlbicpLnZhbHVlIHx8IG51bGwsCiAgICAg' +
  'ICAgbm90ZXM6IGVsLnF1ZXJ5U2VsZWN0b3IoJyNhX25vdGVzJykudmFsdWUsCiAgICAgICAgLy8gQmxhbmsgbWVhbnMgdGhlIGFk' +
  'ZHJlc3Mgb24gdGhlIGpvYiwgd2hpY2ggdGhlIHNlcnZlciBmaWxscyBpbi4KICAgICAgICBhZGRyZXNzX3VzZWQ6IChlbC5xdWVy' +
  'eVNlbGVjdG9yKCcjYV9hZGRyJykudmFsdWUgfHwgJycpLnRyaW0oKSB8fCB1bmRlZmluZWQsCiAgICAgICAgcGxhdGU6IChlbC5x' +
  'dWVyeVNlbGVjdG9yKCcjYV9wbGF0ZScpLnZhbHVlIHx8ICcnKS50cmltKCkgfHwgdW5kZWZpbmVkLAogICAgICAgIHBsYXRlX3N0' +
  'YXRlOiAoZWwucXVlcnlTZWxlY3RvcignI2FfcGxhdGVfc3RhdGUnKS52YWx1ZSB8fCAnJykudHJpbSgpIHx8IHVuZGVmaW5lZCwK' +
  'ICAgICAgICB2ZWhpY2xlOiAoZWwucXVlcnlTZWxlY3RvcignI2FfdmVoaWNsZScpLnZhbHVlIHx8ICcnKS50cmltKCkgfHwgdW5k' +
  'ZWZpbmVkLAogICAgICAgIHZpbjogKGVsLnF1ZXJ5U2VsZWN0b3IoJyNhX3ZpbicpLnZhbHVlIHx8ICcnKS50cmltKCkgfHwgdW5k' +
  'ZWZpbmVkCiAgICAgIH0sIGdwcyB8fCB7fSk7CiAgICAgIGlmIChvdXRjb21lID09PSAnU2VydmVkJykgewogICAgICAgIGJvZHku' +
  'bWFubmVyID0gZWwucXVlcnlTZWxlY3RvcignI2FfbWFubmVyJykudmFsdWU7CiAgICAgICAgYm9keS5wZXJzb25fc2VydmVkID0g' +
  'ZWwucXVlcnlTZWxlY3RvcignI2FfcGVyc29uX3NlcnZlZCcpLnZhbHVlOwogICAgICAgIGJvZHkucmVsYXRpb25zaGlwID0gZWwu' +
  'cXVlcnlTZWxlY3RvcignI2FfcmVsYXRpb25zaGlwJykudmFsdWU7CiAgICAgICAgYm9keS5kZXNjcmlwdGlvbiA9IGVsLnF1ZXJ5' +
  'U2VsZWN0b3IoJyNhX2Rlc2NyaXB0aW9uJykudmFsdWU7CiAgICAgIH0KICAgICAgY29uc3Qgc2F2ZSA9IGVsLnF1ZXJ5U2VsZWN0' +
  'b3IoJyNzYXZlQXR0Jyk7CiAgICAgIGNvbnN0IHdhcyA9IHNhdmUudGV4dENvbnRlbnQ7CiAgICAgIHNhdmUuZGlzYWJsZWQgPSB0' +
  'cnVlOwogICAgICB0cnkgewogICAgICAgIGNvbnN0IGF0dCA9IGF3YWl0IGFwaSgnL2pvYnMvJyArIGpvYi5pZCArICcvYXR0ZW1w' +
  'dHMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KTsKICAgICAgICAvKiBUaGUgYXR0ZW1w' +
  'dCBpcyBzYXZlZCBhdCB0aGlzIHBvaW50LiBJZiBhIHBob3RvIGZhaWxzIHRvIHVwbG9hZCBhZnRlcgogICAgICAgICAgIHRoYXQg' +
  '4oCUIGRlYWQgc2lnbmFsIGluIGEgZHJpdmV3YXkg4oCUIHRoZSBhdHRlbXB0IHN0aWxsIHN0YW5kcyBhbmQgdGhlCiAgICAgICAg' +
  'ICAgc2VydmVyIGlzIHRvbGQgd2hpY2ggb25lcyB0byByZXRyeSBmcm9tIHRoZSBqb2Igc2NyZWVuLCByYXRoZXIgdGhhbgogICAg' +
  'ICAgICAgIGxvc2luZyB0aGUgd2hvbGUgZW50cnkuICovCiAgICAgICAgbGV0IGZhaWxlZCA9IDA7CiAgICAgICAgaWYgKHBlbmRp' +
  'bmcubGVuZ3RoKSB7CiAgICAgICAgICB0cnkgewogICAgICAgICAgICBhd2FpdCB1cGxvYWRQaG90b3MoYXR0LmlkLCBwZW5kaW5n' +
  'LAogICAgICAgICAgICAgIChuLCB0b3RhbCkgPT4geyBzYXZlLnRleHRDb250ZW50ID0gYFNlbmRpbmcgcGhvdG8gJHtufSBvZiAk' +
  'e3RvdGFsfeKApmA7IH0pOwogICAgICAgICAgfSBjYXRjaCAoZSkgeyBmYWlsZWQgPSAxOyB9CiAgICAgICAgfQogICAgICAgIGNs' +
  'b3NlU2hlZXQoKTsKICAgICAgICB0b2FzdChmYWlsZWQgPyAnQXR0ZW1wdCBzYXZlZCDigJQgYSBwaG90byBkaWQgbm90IHNlbmQs' +
  'IGFkZCBpdCBhZ2FpbiBmcm9tIHRoZSBqb2InCiAgICAgICAgICA6IG91dGNvbWUgPT09ICdTZXJ2ZWQnID8gJ1NlcnZlZCDigJQg' +
  'am9iIGNsb3NlZCBvdXQnIDogJ0F0dGVtcHQgbG9nZ2VkJywgISFmYWlsZWQpOwogICAgICAgIGdvKCdqb2InLCB7IGlkOiBqb2Iu' +
  'aWQgfSk7CiAgICAgIH0gY2F0Y2ggKGUpIHsgc2F2ZS5kaXNhYmxlZCA9IGZhbHNlOyBzYXZlLnRleHRDb250ZW50ID0gd2FzOyB0' +
  'b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgICB9OwogIH0pOwp9CgpmdW5jdGlvbiBsb2NhbE5vdygpIHsKICBjb25zdCBkID0g' +
  'bmV3IERhdGUoRGF0ZS5ub3coKSAtIG5ldyBEYXRlKCkuZ2V0VGltZXpvbmVPZmZzZXQoKSAqIDYwMDAwKTsKICByZXR1cm4gZC50' +
  'b0lTT1N0cmluZygpLnNsaWNlKDAsIDE2KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLSBhZmZpZGF2aXQgLS0gKi8KYXN5bmMgZnVuY3Rpb24gYWZmaWRhdml0U2hlZXQoam9iKSB7CiAgY29u' +
  'c3QgdGVtcGxhdGVzID0gYXdhaXQgYXBpKCcvdGVtcGxhdGVzJyk7CiAgY29uc3QgbG9hZCA9IGFzeW5jIGlkID0+IHsKICAgIGNv' +
  'bnN0IHIgPSBhd2FpdCBhcGkoJy9qb2JzLycgKyBqb2IuaWQgKyAnL2FmZmlkYXZpdCcgKyAoaWQgPyAnP3RlbXBsYXRlX2lkPScg' +
  'KyBpZCA6ICcnKSk7CiAgICByZXR1cm4gcjsKICB9OwogIGNvbnN0IGZpcnN0ID0gYXdhaXQgbG9hZCgpOwogIHNoZWV0KCdBZmZp' +
  'ZGF2aXQg4oCUICcgKyBqb2Iuam9iX251bWJlciwgYAogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5UZW1wbGF0ZTwvbGFi' +
  'ZWw+PHNlbGVjdCBpZD0idHBsIj4KICAgICAgJHt0ZW1wbGF0ZXMubWFwKHQgPT4gYDxvcHRpb24gdmFsdWU9IiR7dC5pZH0iICR7' +
  'dC5pZCA9PT0gZmlyc3QudGVtcGxhdGVfaWQgPyAnc2VsZWN0ZWQnIDogJyd9PiR7ZXNjKHQubmFtZSl9JHt0Lmp1cmlzZGljdGlv' +
  'biA/ICcg4oCUICcgKyBlc2ModC5qdXJpc2RpY3Rpb24pIDogJyd9PC9vcHRpb24+YCkuam9pbignJyl9CiAgICA8L3NlbGVjdD48' +
  'L2Rpdj4KICAgIDxwcmUgY2xhc3M9InByZXYiIGlkPSJwcmV2Ij4ke2VzYyhmaXJzdC50ZXh0KX08L3ByZT4KICAgIDxkaXYgY2xh' +
  'c3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InByaW50QWZmIj5Q' +
  'cmludCAvIHNhdmUgUERGPC9idXR0b24+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIGlkPSJjb3B5QWZmIj5Db3B5IHRl' +
  'eHQ8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5DbG9zZTwvYnV0' +
  'dG9uPgogICAgPC9kaXY+YCwgZWwgPT4gewogICAgY29uc3Qgc2VsID0gZWwucXVlcnlTZWxlY3RvcignI3RwbCcpOwogICAgc2Vs' +
  'Lm9uY2hhbmdlID0gYXN5bmMgKCkgPT4geyBlbC5xdWVyeVNlbGVjdG9yKCcjcHJldicpLnRleHRDb250ZW50ID0gKGF3YWl0IGxv' +
  'YWQoc2VsLnZhbHVlKSkudGV4dDsgfTsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNwcmludEFmZicpLm9uY2xpY2sgPSAoKSA9Pgog' +
  'ICAgICB3aW5kb3cub3BlbignL3ByaW50L2FmZmlkYXZpdC8nICsgam9iLmlkICsgJz90ZW1wbGF0ZV9pZD0nICsgc2VsLnZhbHVl' +
  'LCAnX2JsYW5rJyk7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjY29weUFmZicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAg' +
  'IGF3YWl0IG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KGVsLnF1ZXJ5U2VsZWN0b3IoJyNwcmV2JykudGV4dENvbnRlbnQp' +
  'OwogICAgICB0b2FzdCgnQ29waWVkJyk7CiAgICB9OwogIH0pOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSB0b29scyAtLS0gKi8KLyogTGFiZWwgbWFrZXIuIFRoZSBwb2ludCBvZiB0aGUg' +
  'c2hlZXQgZ3JpZCBpcyB0aGF0IGxhYmVsIHNoZWV0cyBhcmUgZXhwZW5zaXZlCiAgIGFuZCByYXJlbHkgdXNlZCB1cCBpbiBvbmUg' +
  'Z286IG1hcmsgd2hpY2ggb25lcyB5b3UndmUgYWxyZWFkeSBwZWVsZWQgb2ZmIGFuZAogICB0aGUgcHJpbnRlciBza2lwcyB0aGVt' +
  'LCBzbyBhIHBhcnQtdXNlZCBzaGVldCBnb2VzIGJhY2sgaW4gYW5kIGNhcnJpZXMgb24uICovCmFzeW5jIGZ1bmN0aW9uIHRvb2xz' +
  'VmlldygpIHsKICBjb25zdCBbbGF5b3V0cywgaW5pdFNoZWV0LCBqb2JzXSA9IGF3YWl0IFByb21pc2UuYWxsKFsKICAgIGFwaSgn' +
  'L2xhYmVsLWxheW91dHMnKSwgYXBpKCcvbGFiZWwtc2hlZXQnKSwgYXBpKCcvam9icz9vcGVuPTEnKQogIF0pOwogIFMuY2FjaGUu' +
  'c2hlZXQgPSBpbml0U2hlZXQ7CiAgUy5jYWNoZS5waWNrZWQgPSBTLmNhY2hlLnBpY2tlZCB8fCBbXTsKCiAgYXBwLmlubmVySFRN' +
  'TCA9IHNoZWxsKGAKICAgIDxoMSBjbGFzcz0icGFnZSI+VG9vbHM8L2gxPgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8' +
  'aDI+TGFiZWwgbWFrZXIgPHNwYW4gY2xhc3M9InN1YiI+cHJpbnRzIG9ubHkgdGhlIGxhYmVscyB5b3UgaGF2ZW4ndCB1c2VkPC9z' +
  'cGFuPjwvaDI+CgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkxhYmVsIHNoZWV0PC9sYWJlbD4KICAgICAgICA8c2Vs' +
  'ZWN0IGlkPSJsYXlvdXQiPgogICAgICAgICAgJHtsYXlvdXRzLm1hcChsID0+IGA8b3B0aW9uIHZhbHVlPSIke2wua2V5fSIgJHts' +
  'LmtleSA9PT0gaW5pdFNoZWV0LmxheW91dCA/ICdzZWxlY3RlZCcgOiAnJ30+CiAgICAgICAgICAgICR7ZXNjKGwubmFtZSl9IOKA' +
  'lCAke2VzYyhsLnNpemUpfTwvb3B0aW9uPmApLmpvaW4oJycpfQogICAgICAgIDwvc2VsZWN0PgogICAgICAgIDxkaXYgY2xhc3M9' +
  'ImhpbnQiPk9mZmljZSBEZXBvdCBzaGVldHMgcHJpbnQgYW4gQXZlcnkgZXF1aXZhbGVudCBudW1iZXIgb24gdGhlIHBhY2thZ2Ug' +
  'ZnJvbnQg4oCUCiAgICAgICAgICBtYXRjaCB0aGF0LiBDaGFuZ2luZyB0aGUgc2hlZXQgY2xlYXJzIHRoZSB1c2VkIG1hcmtzLCBz' +
  'aW5jZSBwb3NpdGlvbiA3IG9uIGEgMzAtdXAgc2hlZXQKICAgICAgICAgIGlzbid0IHBvc2l0aW9uIDcgb24gYSAxMC11cCBvbmUu' +
  'PC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGxhYmVsPldoaWNoIGxhYmVscyBhcmUgYWxyZWFkeSBnb25lPzwvbGFiZWw+CiAg' +
  'ICAgIDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tYm90dG9tOjhweCI+VGFwIHRoZSBvbmVzIGFscmVhZHkgcGVlbGVk' +
  'IG9mZi4gR3JleSA9IHVzZWQgYW5kIHNraXBwZWQuCiAgICAgICAgTnVtYmVyZWQgZ3JlZW4gPSB3aGVyZSB5b3VyIG5leHQgbGFi' +
  'ZWxzIHdpbGwgbGFuZCwgaW4gb3JkZXIuPC9kaXY+CiAgICAgIDxkaXYgaWQ9ImdyaWQiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNz' +
  'PSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxzcGFuIGNsYXNzPSJwaWxsIiBpZD0iZnJlZUNvdW50Ij48' +
  'L3NwYW4+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9Im5ld1NoZWV0Ij5GcmVzaCBzaGVldDwvYnV0dG9u' +
  'PgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJhbGxVc2VkIj5NYXJrIGFsbCB1c2VkPC9idXR0b24+CiAg' +
  'ICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5XaG8gdG8gcHJpbnQgPHNwYW4g' +
  'Y2xhc3M9InN1YiIgaWQ9InBpY2tDb3VudCI+PC9zcGFuPjwvaDI+CiAgICAgIDxpbnB1dCBpZD0iam9iRmlsdGVyIiBwbGFjZWhv' +
  'bGRlcj0iRmlsdGVyIGJ5IG5hbWUsIGNpdHkgb3Igam9iIG51bWJlciIgc3R5bGU9Im1hcmdpbi1ib3R0b206OHB4Ij4KICAgICAg' +
  'PGRpdiBjbGFzcz0ibGlzdCIgaWQ9ImpvYlBpY2siIHN0eWxlPSJtYXgtaGVpZ2h0OjMyMHB4O292ZXJmbG93OmF1dG8iPgogICAg' +
  'ICAgICR7am9icy5sZW5ndGggPyBqb2JzLm1hcChqID0+IGAKICAgICAgICAgIDxkaXYgY2xhc3M9Iml0ZW0iIGRhdGEtcGljaz0i' +
  'JHtqLmlkfSI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9InIiPjxkaXY+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0idCI+JHtl' +
  'c2Moai5yZWNpcGllbnRfbmFtZSl9PC9kaXY+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ibSI+JHtlc2Moai5qb2JfbnVtYmVy' +
  'KX0gwrcgJHtlc2MoW2ouYWRkcmVzczEsIGouY2l0eV0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJywgJykgfHwgJ25vIGFkZHJlc3Mn' +
  'KX08L2Rpdj4KICAgICAgICAgICAgPC9kaXY+PHNwYW4gY2xhc3M9InBpbGwiIGRhdGEtdGljaz0iJHtqLmlkfSI+YWRkPC9zcGFu' +
  'PjwvZGl2PgogICAgICAgICAgPC9kaXY+YCkuam9pbignJykKICAgICAgICAgIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij5ObyBvcGVu' +
  'IGpvYnMgdG8gbGFiZWwuPC9kaXY+J30KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAg' +
  'ICAgPGgyPlByaW50PC9oMj4KICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJw' +
  'cmludEJ0biIgZGlzYWJsZWQ+UHJpbnQgbGFiZWxzPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIg' +
  'aWQ9InRlc3RCdG4iPkFsaWdubWVudCB0ZXN0PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBz' +
  'dHlsZT0ibWFyZ2luLXRvcDo4cHgiPkluIHRoZSBwcmludCBkaWFsb2cgc2V0IHNjYWxlIHRvIDxiPjEwMCU8L2I+IGFuZCB0dXJu' +
  'IG9mZgogICAgICAgICJmaXQgdG8gcGFnZSIg4oCUIHNjYWxpbmcgaXMgd2hhdCB0aHJvd3MgbGFiZWwgYWxpZ25tZW50IG9mZi48' +
  'L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij48bGFiZWw+TnVkZ2UsIGlmIHlv' +
  'dXIgcHJpbnRlciBydW5zIG9mZjwvbGFiZWw+CiAgICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgICAgIDxzcGFuIGNsYXNz' +
  'PSJoaW50IiBzdHlsZT0ibWFyZ2luOjAiPlJpZ2h0PC9zcGFuPgogICAgICAgICAgPGlucHV0IGlkPSJvZmZYIiB0eXBlPSJudW1i' +
  'ZXIiIHN0ZXA9IjAuMDEiIG1pbj0iLTAuNSIgbWF4PSIwLjUiIHZhbHVlPSIke2luaXRTaGVldC5vZmZzZXRfeH0iIHN0eWxlPSJ3' +
  'aWR0aDo5MHB4Ij4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjAiPkRvd248L3NwYW4+CiAgICAg' +
  'ICAgICA8aW5wdXQgaWQ9Im9mZlkiIHR5cGU9Im51bWJlciIgc3RlcD0iMC4wMSIgbWluPSItMC41IiBtYXg9IjAuNSIgdmFsdWU9' +
  'IiR7aW5pdFNoZWV0Lm9mZnNldF95fSIgc3R5bGU9IndpZHRoOjkwcHgiPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNl' +
  'YyBzbSIgaWQ9InNhdmVPZmYiPlNhdmU8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJoaW50Ij5J' +
  'bmNoZXMuIFByaW50IHRoZSBhbGlnbm1lbnQgdGVzdCBvbiBwbGFpbiBwYXBlciwgaG9sZCBpdCBhZ2FpbnN0IGEgcmVhbCBzaGVl' +
  'dCwKICAgICAgICAgIGFuZCBudWRnZSB1bnRpbCB0aGUgYm94ZXMgbGluZSB1cC48L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rp' +
  'dj5gKTsKICBiaW5kU2hlbGwoKTsKCiAgY29uc3QgbGF5b3V0TWV0YSA9ICgpID0+IGxheW91dHMuZmluZChsID0+IGwua2V5ID09' +
  'PSBTLmNhY2hlLnNoZWV0LmxheW91dCkgfHwgbGF5b3V0c1swXTsKCiAgZnVuY3Rpb24gZHJhd0dyaWQoKSB7CiAgICBjb25zdCBt' +
  'ZXRhID0gbGF5b3V0TWV0YSgpOwogICAgY29uc3QgcyA9IFMuY2FjaGUuc2hlZXQ7CiAgICBjb25zdCB1c2VkID0gbmV3IFNldChz' +
  'LnVzZWQubWFwKE51bWJlcikpOwogICAgY29uc3QgZnJlZSA9IFtdOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBtZXRhLmNhcGFj' +
  'aXR5OyBpKyspIGlmICghdXNlZC5oYXMoaSkpIGZyZWUucHVzaChpKTsKICAgIGNvbnN0IG9yZGVyID0gbmV3IE1hcChmcmVlLnNs' +
  'aWNlKDAsIFMuY2FjaGUucGlja2VkLmxlbmd0aCkubWFwKChwb3MsIG4pID0+IFtwb3MsIG4gKyAxXSkpOwoKICAgICQoJyNncmlk' +
  'JykuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImxncmlkIiBzdHlsZT0iZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgke21l' +
  'dGEuY29sc30sMWZyKSI+YCArCiAgICAgIEFycmF5LmZyb20oeyBsZW5ndGg6IG1ldGEuY2FwYWNpdHkgfSwgKF8sIGkpID0+IHsK' +
  'ICAgICAgICBjb25zdCBpc1VzZWQgPSB1c2VkLmhhcyhpKTsKICAgICAgICBjb25zdCBuID0gb3JkZXIuZ2V0KGkpOwogICAgICAg' +
  'IHJldHVybiBgPGJ1dHRvbiBjbGFzcz0ibGNlbGwke2lzVXNlZCA/ICcgdXNlZCcgOiAnJ30ke24gPyAnIG5leHQnIDogJyd9IiBk' +
  'YXRhLWNlbGw9IiR7aX0iCiAgICAgICAgICB0aXRsZT0iUG9zaXRpb24gJHtpICsgMX0iPiR7aXNVc2VkID8gJ8OXJyA6IChuIHx8' +
  'ICcnKX08L2J1dHRvbj5gOwogICAgICB9KS5qb2luKCcnKSArICc8L2Rpdj4nOwoKICAgICQoJyNmcmVlQ291bnQnKS50ZXh0Q29u' +
  'dGVudCA9IGZyZWUubGVuZ3RoICsgJyBvZiAnICsgbWV0YS5jYXBhY2l0eSArICcgbGVmdCc7CiAgICAkKCcjcGlja0NvdW50Jyku' +
  'dGV4dENvbnRlbnQgPSBTLmNhY2hlLnBpY2tlZC5sZW5ndGggKyAnIHNlbGVjdGVkJzsKICAgIGNvbnN0IG92ZXIgPSBTLmNhY2hl' +
  'LnBpY2tlZC5sZW5ndGggPiBmcmVlLmxlbmd0aDsKICAgIGNvbnN0IGJ0biA9ICQoJyNwcmludEJ0bicpOwogICAgYnRuLmRpc2Fi' +
  'bGVkID0gIVMuY2FjaGUucGlja2VkLmxlbmd0aDsKICAgIGJ0bi50ZXh0Q29udGVudCA9IG92ZXIKICAgICAgPyBgUHJpbnQgJHtm' +
  'cmVlLmxlbmd0aH0gbm93ICgke1MuY2FjaGUucGlja2VkLmxlbmd0aCAtIGZyZWUubGVuZ3RofSB3b24ndCBmaXQpYAogICAgICA6' +
  'IGBQcmludCAke1MuY2FjaGUucGlja2VkLmxlbmd0aH0gbGFiZWwke1MuY2FjaGUucGlja2VkLmxlbmd0aCA9PT0gMSA/ICcnIDog' +
  'J3MnfWA7CgogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtY2VsbF0nKS5mb3JFYWNoKGMgPT4gYy5vbmNsaWNr' +
  'ID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBpID0gK2MuZGF0YXNldC5jZWxsOwogICAgICBjb25zdCBzZXQgPSBuZXcgU2V0' +
  'KFMuY2FjaGUuc2hlZXQudXNlZC5tYXAoTnVtYmVyKSk7CiAgICAgIHNldC5oYXMoaSkgPyBzZXQuZGVsZXRlKGkpIDogc2V0LmFk' +
  'ZChpKTsKICAgICAgYXdhaXQgc2F2ZVNoZWV0KHsgdXNlZDogWy4uLnNldF0gfSk7CiAgICB9KTsKICB9CgogIGFzeW5jIGZ1bmN0' +
  'aW9uIHNhdmVTaGVldChwYXRjaCkgewogICAgdHJ5IHsKICAgICAgUy5jYWNoZS5zaGVldCA9IGF3YWl0IGFwaSgnL2xhYmVsLXNo' +
  'ZWV0JywgeyBtZXRob2Q6ICdQQVRDSCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHBhdGNoKSB9KTsKICAgICAgZHJhd0dyaWQoKTsK' +
  'ICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH0KCiAgJCgnI2xheW91dCcpLm9uY2hhbmdlID0g' +
  'ZSA9PiBzYXZlU2hlZXQoeyBsYXlvdXQ6IGUudGFyZ2V0LnZhbHVlIH0pOwogICQoJyNuZXdTaGVldCcpLm9uY2xpY2sgPSAoKSA9' +
  'PiBzYXZlU2hlZXQoeyB1c2VkOiBbXSB9KTsKICAkKCcjYWxsVXNlZCcpLm9uY2xpY2sgPSAoKSA9PgogICAgc2F2ZVNoZWV0KHsg' +
  'dXNlZDogQXJyYXkuZnJvbSh7IGxlbmd0aDogbGF5b3V0TWV0YSgpLmNhcGFjaXR5IH0sIChfLCBpKSA9PiBpKSB9KTsKICAkKCcj' +
  'c2F2ZU9mZicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBhd2FpdCBzYXZlU2hlZXQoeyBvZmZzZXRfeDogTnVtYmVyKCQo' +
  'JyNvZmZYJykudmFsdWUpIHx8IDAsIG9mZnNldF95OiBOdW1iZXIoJCgnI29mZlknKS52YWx1ZSkgfHwgMCB9KTsKICAgIHRvYXN0' +
  'KCdBbGlnbm1lbnQgc2F2ZWQnKTsKICB9OwoKICBjb25zdCBwYWludCA9ICgpID0+IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwo' +
  'J1tkYXRhLXRpY2tdJykuZm9yRWFjaCh0ID0+IHsKICAgIGNvbnN0IG9uID0gUy5jYWNoZS5waWNrZWQuaW5jbHVkZXMoK3QuZGF0' +
  'YXNldC50aWNrKTsKICAgIHQudGV4dENvbnRlbnQgPSBvbiA/ICfinJMgYWRkZWQnIDogJ2FkZCc7CiAgICB0LmNsYXNzTmFtZSA9' +
  'IG9uID8gJ3BpbGwgU2VydmVkJyA6ICdwaWxsJzsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1waWNr' +
  'XScpLmZvckVhY2gocm93ID0+IHJvdy5vbmNsaWNrID0gKCkgPT4gewogICAgY29uc3QgaWQgPSArcm93LmRhdGFzZXQucGljazsK' +
  'ICAgIGNvbnN0IGkgPSBTLmNhY2hlLnBpY2tlZC5pbmRleE9mKGlkKTsKICAgIGkgPT09IC0xID8gUy5jYWNoZS5waWNrZWQucHVz' +
  'aChpZCkgOiBTLmNhY2hlLnBpY2tlZC5zcGxpY2UoaSwgMSk7CiAgICBwYWludCgpOyBkcmF3R3JpZCgpOwogIH0pOwogICQoJyNq' +
  'b2JGaWx0ZXInKS5vbmlucHV0ID0gZSA9PiB7CiAgICBjb25zdCB2ID0gZS50YXJnZXQudmFsdWUudG9Mb3dlckNhc2UoKTsKICAg' +
  'IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBpY2tdJykuZm9yRWFjaChyID0+IHsKICAgICAgci5zdHlsZS5kaXNw' +
  'bGF5ID0gci5pbm5lclRleHQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyh2KSA/ICcnIDogJ25vbmUnOwogICAgfSk7CiAgfTsKCiAg' +
  'JCgnI3Rlc3RCdG4nKS5vbmNsaWNrID0gKCkgPT4gewogICAgY29uc3QgaWRzID0gUy5jYWNoZS5waWNrZWQubGVuZ3RoID8gUy5j' +
  'YWNoZS5waWNrZWQgOiAoam9ic1swXSA/IFtqb2JzWzBdLmlkXSA6IFtdKTsKICAgIGlmICghaWRzLmxlbmd0aCkgcmV0dXJuIHRv' +
  'YXN0KCdBZGQgYXQgbGVhc3Qgb25lIGpvYiBmaXJzdCcsIHRydWUpOwogICAgd2luZG93Lm9wZW4oJy9wcmludC9sYWJlbHM/Z3Vp' +
  'ZGVzPTEmaWRzPScgKyBpZHMuam9pbignLCcpLCAnX2JsYW5rJyk7CiAgfTsKCiAgJCgnI3ByaW50QnRuJykub25jbGljayA9ICgp' +
  'ID0+IHsKICAgIGNvbnN0IG1ldGEgPSBsYXlvdXRNZXRhKCk7CiAgICBjb25zdCB1c2VkID0gbmV3IFNldChTLmNhY2hlLnNoZWV0' +
  'LnVzZWQubWFwKE51bWJlcikpOwogICAgY29uc3QgZnJlZSA9IFtdOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBtZXRhLmNhcGFj' +
  'aXR5OyBpKyspIGlmICghdXNlZC5oYXMoaSkpIGZyZWUucHVzaChpKTsKICAgIGNvbnN0IHdpbGxVc2UgPSBmcmVlLnNsaWNlKDAs' +
  'IFMuY2FjaGUucGlja2VkLmxlbmd0aCk7CiAgICB3aW5kb3cub3BlbignL3ByaW50L2xhYmVscz9pZHM9JyArIFMuY2FjaGUucGlj' +
  'a2VkLmpvaW4oJywnKSwgJ19ibGFuaycpOwoKICAgIGNvbmZpcm1QcmludGVkKHdpbGxVc2UpOwogIH07CgogIGZ1bmN0aW9uIGNv' +
  'bmZpcm1QcmludGVkKHdpbGxVc2UpIHsKICAgIHNoZWV0KCdEaWQgdGhleSBwcmludD8nLCBgCiAgICAgIDxwIGNsYXNzPSJoaW50' +
  'Ij5Pbmx5IG1hcmsgdGhlc2UgdXNlZCBvbmNlIHRoZSBzaGVldCBhY3R1YWxseSBjYW1lIG91dCByaWdodCDigJQgaWYgdGhlIHBy' +
  'aW50ZXIKICAgICAgICBqYW1tZWQgb3IgdGhlIGFsaWdubWVudCB3YXMgb2ZmLCBzYXkgbm8gYW5kIG5vdGhpbmcgY2hhbmdlcy48' +
  'L3A+CiAgICAgIDxwPjxiPiR7d2lsbFVzZS5sZW5ndGh9PC9iPiBwb3NpdGlvbiR7d2lsbFVzZS5sZW5ndGggPT09IDEgPyAnJyA6' +
  'ICdzJ30gd291bGQgYmUgbWFya2VkIHVzZWQ6CiAgICAgICAgJHt3aWxsVXNlLm1hcChpID0+IGkgKyAxKS5qb2luKCcsICcpfTwv' +
  'cD4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJi' +
  'dG4gb2siIGlkPSJ5ZXNVc2VkIj5ZZXMg4oCUIG1hcmsgdGhlbSB1c2VkPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0i' +
  'YnRuIHNlYyIgb25jbGljaz0iY2xvc2VTaGVldCgpIj5Obywga2VlcCB0aGVtIGZyZWU8L2J1dHRvbj4KICAgICAgPC9kaXY+YCwg' +
  'ZWwgPT4gewogICAgICBlbC5xdWVyeVNlbGVjdG9yKCcjeWVzVXNlZCcpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgICAg' +
  'Y29uc3Qgc2V0ID0gbmV3IFNldChTLmNhY2hlLnNoZWV0LnVzZWQubWFwKE51bWJlcikpOwogICAgICAgIHdpbGxVc2UuZm9yRWFj' +
  'aChpID0+IHNldC5hZGQoaSkpOwogICAgICAgIGF3YWl0IHNhdmVTaGVldCh7IHVzZWQ6IFsuLi5zZXRdIH0pOwogICAgICAgIFMu' +
  'Y2FjaGUucGlja2VkID0gW107CiAgICAgICAgY2xvc2VTaGVldCgpOwogICAgICAgIHRvYXN0KCdTaGVldCB1cGRhdGVkIOKAlCAn' +
  'ICsgUy5jYWNoZS5zaGVldC5mcmVlICsgJyBsYWJlbHMgbGVmdCcpOwogICAgICAgIGdvKCd0b29scycpOwogICAgICB9OwogICAg' +
  'fSk7CiAgfQoKICBwYWludCgpOwogIGRyYXdHcmlkKCk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0gcHJvcGVydHkgc2VhcmNoIC0tICovCi8qIFRoZSBzYW1lIGxvb2t1cCB0aGUgRGVhbCBGaW5kZXIg' +
  'cnVucywgYWdhaW5zdCB0aGUgc2FtZSBjb3VudHkgYXBwcmFpc2FsCiAqIHJvbGxzLCBiZWNhdXNlIGEgcHJvY2VzcyBzZXJ2ZXIg' +
  'bmVlZHMgZXhhY3RseSB3aGF0IGEgYnV5ZXIgbmVlZHM6IHdobyBvd25zCiAqIHRoaXMgYWRkcmVzcywgYW5kIHdoZXJlIGRvZXMg' +
  'dGhlaXIgcG9zdCBhY3R1YWxseSBnby4KICoKICogVGhlIHJvbGxzIGFyZSBwdWJsaXNoZWQgYXMgQXJjR0lTIGZlYXR1cmUgbGF5' +
  'ZXJzLCBzbyB0aGUgYnJvd3NlciBhc2tzIHRoZQogKiBjb3VudHkgZGlyZWN0bHkg4oCUIG5vIGtleSwgbm8gc2VydmVyIGluIHRo' +
  'ZSBtaWRkbGUsIG5vdGhpbmcgY2FjaGVkIHRoYXQgY291bGQKICogZ28gc3RhbGUuIEZpZWxkIG5hbWVzIGRpZmZlciBwZXIgY291' +
  'bnR5LCBzbyBlYWNoIG9uZSBjYXJyaWVzIGl0cyBvd24gbWFwLAogKiB2ZXJpZmllZCBhZ2FpbnN0IHRoZSBsaXZlIGxheWVyIHJh' +
  'dGhlciB0aGFuIGd1ZXNzZWQuCiAqLwpjb25zdCBDQUQgPSAoKCkgPT4gewogIGNvbnN0IGNhbWVyb25GaWVsZHMgPSB1cHBlciA9' +
  'PiB7CiAgICBjb25zdCBuID0gKGEsIGIpID0+ICh1cHBlciA/IGIgOiBhKTsKICAgIHJldHVybiB7CiAgICAgIGFkZHI6IG4oJ3Np' +
  'dHVzZGlzcGwnLCAnc2l0dXNEaXNwbCcpLAogICAgICBhZGRyUGFydHM6IFtuKCdzaXR1c25vJywgJ3NpdHVzTm8nKSwgbignc2l0' +
  'cGZ4JywgJ3NpdFBmeCcpLCBuKCdzaXRzdHInLCAnc2l0U3RyJyksIG4oJ3NpdHNmeCcsICdzaXRTZngnKV0sCiAgICAgIGNpdHk6' +
  'IG4oJ3NpdGNpdHknLCAnc2l0Q2l0eScpLCB6aXA6IG4oJ3NpdHppcCcsICdzaXRaaXAnKSwKICAgICAgb3duZXI6ICdvd25lcics' +
  'IG1haWw6ICdhZGRyMScsIG1haWxjaXR5OiBuKCdhZGRyY2l0eScsICdhZGRyQ2l0eScpLAogICAgICBtYWlsc3RhdGU6IG4oJ2Fk' +
  'ZHJzdGF0ZScsICdhZGRyU3RhdGUnKSwgbWFpbHppcDogbignYWRkcnppcCcsICdhZGRyWmlwJyksCiAgICAgIHNxZnQ6IG4oJ2x2' +
  'Z2FyZWEnLCAnbHZnQXJlYScpLCB5ZWFyOiBuKCd5cmJ1aWx0JywgJ3lyQnVpbHQnKSwgY2FkOiAnbWFya2V0JywKICAgICAgY2xz' +
  'OiBuKCdzdGF0ZWNkJywgJ3N0YXRlQ2QnKSwgZXhlbXB0OiAnZXhtcycsIHBpZDogbigncHJvcF9pZCcsICdQUk9QX0lEJyksCiAg' +
  'ICAgIGdlbzogbignZ2VvX2lkJywgJ2dlb0lEJyksCiAgICAgIGRlZWQ6IHsgZGF0ZTogbignZGVlZGR0JywgJ2RlZWREdCcpLCBy' +
  'ZWM6IG4oJ2RlZWRyZWNkdCcsICdkZWVkUmVjRHQnKSwKICAgICAgICAgICAgICB0eXBlOiBuKCdkZWVkdHlwZScsICdkZWVkVHlw' +
  'ZScpLCB2b2w6ICd2b2x1bWUnLCBwYWdlOiAncGFnZScsIG51bTogbignZG9jbnVtJywgJ2RvY051bScpIH0KICAgIH07CiAgfTsK' +
  'ICByZXR1cm4gewogICAgJ1RYfEhJREFMR08nOiB7CiAgICAgIGxhYmVsOiAnSGlkYWxnbyBDQUQgMjAyNiBjZXJ0aWZpZWQgcm9s' +
  'bCcsIGNsZXJrOiAnaGlkYWxnbycsCiAgICAgIHE6ICdodHRwczovL3NlcnZpY2VzOS5hcmNnaXMuY29tL2R3TURQNTVIVGZvajRu' +
  'MWMvYXJjZ2lzL3Jlc3Qvc2VydmljZXMvSENBRF9QQVJDRUxTXzIwMjYvRmVhdHVyZVNlcnZlci8xL3F1ZXJ5JywKICAgICAgZjog' +
  'eyBhZGRyOiAnc2l0dXMnLCBvd25lcjogJ25hbWUnLCBtYWlsOiAnYWRkckRlbGl2ZXJ5TGluZScsIG1haWxjaXR5OiAnYWRkckNp' +
  'dHknLAogICAgICAgICAgIG1haWxzdGF0ZTogJ2FkZHJTdGF0ZScsIG1haWx6aXA6ICdhZGRyWmlwJywgc3FmdDogJ2ltcHJ2TWFp' +
  'bkFyZWEnLAogICAgICAgICAgIHllYXI6ICdpbXBydkFjdHVhbFllYXJCdWlsdCcsIGNhZDogJ21hcmtldFZhbHVlJywgY2xzOiAn' +
  'c3RhdGVDZCcsCiAgICAgICAgICAgZXhlbXB0OiAnZXhlbXB0aW9ucycsIHBpZDogJ1BST1BfSUQnLCBnZW86ICdnZW9JRCcsIHVu' +
  'aXQ6ICd0YXhpbmdVbml0cycsCiAgICAgICAgICAgbGVnYWw6ICdsZWdhbERlc2NyaXB0aW9uJywKICAgICAgICAgICBkZWVkOiB7' +
  'IGRhdGU6ICdkZWVkRHQnLCB0eXBlOiAnZGVlZFR5cGUnLCBudW06ICdpbnN0cnVtZW50TnVtJyB9IH0sCiAgICAgIGxpbms6IHBp' +
  'ZCA9PiAnaHR0cHM6Ly9oaWRhbGdvLnByb2RpZ3ljYWQuY29tL3Byb3BlcnR5LWRldGFpbC8nICsgcGlkLAogICAgICBjaXRpZXM6' +
  'IHsgJ01jQWxsZW4nOiAnQ01MJywgJ0VkaW5idXJnJzogJ0NFQicsICdNaXNzaW9uJzogJ0NNUycsICdQaGFycic6ICdDUFInLCAn' +
  'V2VzbGFjbyc6ICdDV0wnLAogICAgICAgICAgICAgICAgJ1NhbiBKdWFuJzogJ0NTSicsICdEb25uYSc6ICdDRE4nLCAnTWVyY2Vk' +
  'ZXMnOiAnQ01DJywgJ0FsYW1vJzogJ0NBTycsICdIaWRhbGdvJzogJ0NIRCcsCiAgICAgICAgICAgICAgICAnTGEgSm95YSc6ICdD' +
  'TEonLCAnUGFsbXZpZXcnOiAnQ1BNJywgJ0FsdG9uJzogJ0NBTicgfQogICAgfSwKICAgICdUWHxDQU1FUk9OJzogewogICAgICBs' +
  'YWJlbDogJ0NhbWVyb24gQ0FEIDIwMjYgcm9sbCcsIGNsZXJrOiAnY2FtZXJvbicsCiAgICAgIHE6ICdodHRwczovL2NvYmdpcy5i' +
  'cm93bnN2aWxsZXR4Lmdvdi9hcmNnaXMvcmVzdC9zZXJ2aWNlcy9Ib3N0ZWQvQ0NBRF9QYXJjZWxzXzA5MDgyMDI1L0ZlYXR1cmVT' +
  'ZXJ2ZXIvMC9xdWVyeScsCiAgICAgIGY6IGNhbWVyb25GaWVsZHMoZmFsc2UpLAogICAgICBhbHQ6IHsgcTogJ2h0dHBzOi8vc2Vy' +
  'dmljZXMyLmFyY2dpcy5jb20vNm9hTE1aRVpsa3RiUXB5aS9hcmNnaXMvcmVzdC9zZXJ2aWNlcy9DQ0FEX1BhcmNlbHNfVmlldy9G' +
  'ZWF0dXJlU2VydmVyLzAvcXVlcnknLAogICAgICAgICAgICAgbGFiZWw6ICdDYW1lcm9uIENBRCAyMDI1IHJvbGwgKEVzcmkgbWly' +
  'cm9yKScsIGY6IGNhbWVyb25GaWVsZHModHJ1ZSkgfSwKICAgICAgY2l0aWVzOiB7ICdCcm93bnN2aWxsZSc6ICdDQlInLCAnSGFy' +
  'bGluZ2VuJzogJ0NIRycsICdTYW4gQmVuaXRvJzogJ0NTQicsICdMYSBGZXJpYSc6ICdDTEYnLAogICAgICAgICAgICAgICAgJ0xv' +
  'cyBGcmVzbm9zJzogJ0NMTycsICdTb3V0aCBQYWRyZSBJc2xhbmQnOiAnQ1NQJywgJ1JpbyBIb25kbyc6ICdDUkgnLCAnUG9ydCBJ' +
  'c2FiZWwnOiAnQ1BJJyB9CiAgICB9LAogICAgJ1RYfFNUQVJSJzogewogICAgICBsYWJlbDogJ1N0YXJyIENBRCBwYXJjZWxzJywg' +
  'Y2xlcms6ICdzdGFycicsCiAgICAgIHE6ICdodHRwczovL3V0aWxpdHkuYXJjZ2lzLmNvbS91c3JzdmNzL3NlcnZlcnMvZmYwNWFm' +
  'NDI5MzQ3NGI0NWFiZjM5MDc1MjUwZWZlNzgvcmVzdC9zZXJ2aWNlcy9TdGFyckNBRFdlYlNlcnZpY2UvRmVhdHVyZVNlcnZlci8w' +
  'L3F1ZXJ5JywKICAgICAgZjogeyBhZGRyUGFydHM6IFsnc2l0dXNfbnVtJywgJ3NpdHVzX3N0cmVldF9wcmVmeCcsICdzaXR1c19z' +
  'dHJlZXQnLCAnc2l0dXNfc3RyZWV0X3N1Zml4J10sCiAgICAgICAgICAgYWRkcjogJ3NpdHVzX3N0cmVldCcsIGNpdHk6ICdzaXR1' +
  'c19jaXR5JywgemlwOiAnc2l0dXNfemlwJywKICAgICAgICAgICBvd25lcjogJ2ZpbGVfYXNfbmFtZScsIG1haWw6ICdhZGRyX2xp' +
  'bmUxJywgbWFpbGNpdHk6ICdhZGRyX2NpdHknLAogICAgICAgICAgIG1haWxzdGF0ZTogJ2FkZHJfc3RhdGUnLCBtYWlsemlwOiAn' +
  'emlwJywgY2FkOiAnbWFya2V0JywKICAgICAgICAgICBwaWQ6ICdwcm9wX2lkJywgZ2VvOiAnZ2VvX2lkJywgdW5pdDogJ2NpdHkn' +
  'LCBsZWdhbDogJ2xlZ2FsX2Rlc2MnLAogICAgICAgICAgIGRlZWQ6IHsgZGF0ZTogJ0RlZWRfRGF0ZScsIHZvbDogJ1ZvbHVtZScs' +
  'IHBhZ2U6ICdQYWdlJywgbnVtOiAnTnVtYmVyJyB9IH0sCiAgICAgIGNpdGllczogeyAnUmlvIEdyYW5kZSBDaXR5JzogJ1JJTyBH' +
  'UkFOREUgQ0lUWScsICdSb21hJzogJ1JPTUEnLCAnTGEgR3J1bGxhJzogJ0xBIEdSVUxMQScsCiAgICAgICAgICAgICAgICAnRXNj' +
  'b2JhcmVzJzogJ0VTQ09CQVJFUycgfSwKICAgICAgY2l0eUlzVGV4dDogdHJ1ZSwKICAgICAgbm90ZTogIlN0YXJyJ3Mgcm9sbCBw' +
  'dWJsaXNoZXMgbm8gYnVpbGRpbmcgc3F1YXJlIGZvb3RhZ2Ugb3IgeWVhciBidWlsdC4iCiAgICB9CiAgfTsKfSkoKTsKCmNvbnN0' +
  'IHNxbEVzYyA9IHYgPT4gU3RyaW5nKHYpLnJlcGxhY2UoLycvZywgIicnIik7CmNvbnN0IG56ID0gdiA9PiB7IGNvbnN0IG4gPSBw' +
  'YXJzZUZsb2F0KHYpOyByZXR1cm4gaXNGaW5pdGUobikgPyBuIDogMDsgfTsKY29uc3QgdGl0bGVDYXNlID0gdiA9PiBTdHJpbmco' +
  'diA9PSBudWxsID8gJycgOiB2KS50b0xvd2VyQ2FzZSgpCiAgLnJlcGxhY2UoL1xiKFthLXpdKS9nLCBtID0+IG0udG9VcHBlckNh' +
  'c2UoKSkKICAucmVwbGFjZSgvXGIoVHh8SWl8SWlpfEl2fExsY3xMcHxJbmN8UG8pXGIvZywgbSA9PiBtLnRvVXBwZXJDYXNlKCkp' +
  'LnRyaW0oKTsKCmZ1bmN0aW9uIHNwbGl0U2l0dXModikgewogIGNvbnN0IHMgPSBTdHJpbmcodiA9PSBudWxsID8gJycgOiB2KS50' +
  'cmltKCk7CiAgY29uc3QgbSA9IHMubWF0Y2goL14oLio/KSxccyooW14sXSopLFxzKltBLVpdezJ9XGIvKTsKICBpZiAobSkgcmV0' +
  'dXJuIHsgYWRkcjogbVsxXS50cmltKCksIGNpdHk6IG1bMl0udHJpbSgpIH07CiAgcmV0dXJuIHsgYWRkcjogcy5yZXBsYWNlKC8s' +
  'XHMqVFhccyokL2ksICcnKS50cmltKCksIGNpdHk6ICcnIH07Cn0KCi8qIEEgc3RyaW5naWZpZWQgb2JqZWN0IGluIG91dEZpZWxk' +
  'cyBtYWtlcyBBcmNHSVMgcmVqZWN0IHRoZSB3aG9sZSBxdWVyeSwgc28KICAgdGhlIG1hcCBpcyBmbGF0dGVuZWQgY2FyZWZ1bGx5' +
  'OiBzdHJpbmdzIHBhc3MsIGFycmF5cyBzcHJlYWQsIHRoZSBuZXN0ZWQgZGVlZAogICBvYmplY3QgY29udHJpYnV0ZXMgaXRzIHZh' +
  'bHVlcywgYW55dGhpbmcgZWxzZSBpcyBkcm9wcGVkLiAqLwpmdW5jdGlvbiBmaWVsZExpc3QoRykgewogIGNvbnN0IG91dCA9IFtd' +
  'OwogIGZvciAoY29uc3QgayBpbiBHKSB7CiAgICBjb25zdCB2ID0gR1trXTsKICAgIGlmICghdikgY29udGludWU7CiAgICBpZiAo' +
  'dHlwZW9mIHYgPT09ICdzdHJpbmcnKSB7IG91dC5wdXNoKHYpOyBjb250aW51ZTsgfQogICAgaWYgKEFycmF5LmlzQXJyYXkodikp' +
  'IHsgdi5mb3JFYWNoKHggPT4geyBpZiAodHlwZW9mIHggPT09ICdzdHJpbmcnICYmIHgpIG91dC5wdXNoKHgpOyB9KTsgY29udGlu' +
  'dWU7IH0KICAgIGlmICh0eXBlb2YgdiA9PT0gJ29iamVjdCcpIHsgZm9yIChjb25zdCBrayBpbiB2KSBpZiAodHlwZW9mIHZba2td' +
  'ID09PSAnc3RyaW5nJyAmJiB2W2trXSkgb3V0LnB1c2godltra10pOyB9CiAgfQogIHJldHVybiBvdXQuZmlsdGVyKCh4LCBpKSA9' +
  'PiBvdXQuaW5kZXhPZih4KSA9PT0gaSk7Cn0KCi8vIENvdW50aWVzIHN0b3JlIHRoZSBkZWVkIGRhdGUgdGhyZWUgd2F5czogSVNP' +
  'IHN0cmluZywgVVMgc3RyaW5nLCBlcG9jaCBtcy4KZnVuY3Rpb24gZGVlZERhdGUodikgewogIGlmICh2ID09IG51bGwgfHwgdiA9' +
  'PT0gJycpIHJldHVybiAnJzsKICBjb25zdCBuID0gTnVtYmVyKHYpOwogIGlmIChpc0Zpbml0ZShuKSAmJiBuID4gMTAwMDAwMDAw' +
  'MDApIHsKICAgIGNvbnN0IGQgPSBuZXcgRGF0ZShuKTsKICAgIHJldHVybiBpc0Zpbml0ZShkLmdldFRpbWUoKSkgPyBkLnRvSVNP' +
  'U3RyaW5nKCkuc2xpY2UoMCwgMTApIDogJyc7CiAgfQogIGNvbnN0IHMgPSBTdHJpbmcodikudHJpbSgpOwogIGxldCBtID0gcy5t' +
  'YXRjaCgvXihcZHs0fSktKFxkezJ9KS0oXGR7Mn0pLyk7CiAgaWYgKG0pIHJldHVybiBtWzBdOwogIG0gPSBzLm1hdGNoKC9eKFxk' +
  'ezEsMn0pXC8oXGR7MSwyfSlcLyhcZHs0fSkvKTsKICBpZiAobSkgcmV0dXJuIG1bM10gKyAnLScgKyAoJzAnICsgbVsxXSkuc2xp' +
  'Y2UoLTIpICsgJy0nICsgKCcwJyArIG1bMl0pLnNsaWNlKC0yKTsKICByZXR1cm4gcy5zbGljZSgwLCAxMCk7Cn0KZnVuY3Rpb24g' +
  'ZGVlZE9mKEcsIGEpIHsKICBjb25zdCBkID0gRyAmJiBHLmRlZWQ7CiAgaWYgKCFkKSByZXR1cm4gbnVsbDsKICBjb25zdCBnID0g' +
  'ayA9PiAoZFtrXSA/IFN0cmluZyhhW2Rba11dID09IG51bGwgPyAnJyA6IGFbZFtrXV0pLnRyaW0oKSA6ICcnKTsKICBjb25zdCBv' +
  'ID0geyBkYXRlOiBkZWVkRGF0ZShkLmRhdGUgPyBhW2QuZGF0ZV0gOiAnJyksIHJlYzogZGVlZERhdGUoZC5yZWMgPyBhW2QucmVj' +
  'XSA6ICcnKSwKICAgICAgICAgICAgICB0eXBlOiBnKCd0eXBlJyksIHZvbDogZygndm9sJyksIHBhZ2U6IGcoJ3BhZ2UnKSwgbnVt' +
  'OiBnKCdudW0nKSB9OwogIHJldHVybiAoby5kYXRlIHx8IG8ucmVjIHx8IG8ubnVtIHx8IG8udm9sKSA/IG8gOiBudWxsOwp9Cgov' +
  'KiBSb2xscyBmaWxlIG93bmVycyBsYXN0LW5hbWUtZmlyc3QgYW5kIGJvbHQgb24gZXZlcnl0aGluZyBmcm9tIGEgc3BvdXNlIHRv' +
  'IGFuCiAgIGVzdGF0ZTogIk1BREVSTyBKT1JHRSAmIExJRElBIiwgIkdBUlpBIE1BUklBIEVUVVgiLiBTZWFyY2hpbmcgdGhhdCB3' +
  'aG9sZQogICBzdHJpbmcgZmluZHMgZXhhY3RseSB0aGUgb25lIHBhcmNlbCB5b3Ugc3RhcnRlZCBmcm9tLCBzbyBpdCBpcyBjdXQg' +
  'YmFjayB0bwogICB0aGUgcGFydCB0aGF0IGlkZW50aWZpZXMgdGhlIGZhbWlseS4gKi8KY29uc3QgT1dOSlVOSyA9IC9eKEVUQUx8' +
  'RVR8QUx8RVRVWHxFVFZJUnxVWHxKUnxTUnxJSXxJSUl8SVZ8VFJVU1RFRXxUUnxUUlVTVHxFU1R8RVNUQVRFfE9GfFRIRXxMSUZF' +
  'fEVTVEFURVM/KSQvOwpmdW5jdGlvbiBvd25lclF1ZXJ5KG5hbWUsIHRva2VucykgewogIGNvbnN0IHQgPSBTdHJpbmcobmFtZSB8' +
  'fCAnJykudG9VcHBlckNhc2UoKQogICAgLnJlcGxhY2UoLyYuKiQvLCAnJykKICAgIC5yZXBsYWNlKC9bXkEtWjAtOSBdL2csICcg' +
  'JykKICAgIC5zcGxpdCgvXHMrLykuZmlsdGVyKEJvb2xlYW4pCiAgICAuZmlsdGVyKHggPT4gIU9XTkpVTksudGVzdCh4KSk7CiAg' +
  'cmV0dXJuIHQuc2xpY2UoMCwgdG9rZW5zIHx8IDIpLmpvaW4oJyAnKTsKfQoKLyogRXZlcnkgY291bnR5IHNwZWxscyB0aGUgc3Vm' +
  'Zml4IGRpZmZlcmVudGx5LCBzbyBpdCBpcyBkcm9wcGVkIGJlZm9yZSBzZWFyY2hpbmcKICAgYW5kIHRoZSByZXN0IG1hdGNoZWQg' +
  'bG9vc2VseS4gKi8KY29uc3QgU1VGRklYRVMgPSAvXihTVHxTVFJFRVR8QVZFfEFWRU5VRXxSRHxST0FEfERSfERSSVZFfExOfExB' +
  'TkV8QkxWRHxCT1VMRVZBUkR8Q1R8Q09VUlR8Q0lSfENJUkNMRXxQTHxQTEFDRXxIV1l8SElHSFdBWXxUUkx8VFJBSUx8V0FZfFBL' +
  'V1l8UEFSS1dBWXxBUFR8VU5JVHxTVEUpJC87CmZ1bmN0aW9uIGFkZHJUb2tlbnMocSkgewogIGNvbnN0IHQgPSBTdHJpbmcocSB8' +
  'fCAnJykudG9VcHBlckNhc2UoKS5yZXBsYWNlKC9bXkEtWjAtOSBdL2csICcgJykuc3BsaXQoL1xzKy8pLmZpbHRlcihCb29sZWFu' +
  'KTsKICBjb25zdCBrZWVwID0gdC5maWx0ZXIoKHYsIGkpID0+IGkgPT09IDAgfHwgIVNVRkZJWEVTLnRlc3QodikpOwogIHJldHVy' +
  'biBrZWVwLmxlbmd0aCA/IGtlZXAgOiB0Owp9Cgpjb25zdCBjbGVya1NlYXJjaCA9IChrZXksIHEpID0+IHsKICBjb25zdCBzcmMg' +
  'PSBDQURba2V5XTsKICBpZiAoIXNyYyB8fCAhc3JjLmNsZXJrKSByZXR1cm4gJyc7CiAgcmV0dXJuICdodHRwczovLycgKyBzcmMu' +
  'Y2xlcmsgKyAnLnR4LnB1YmxpY3NlYXJjaC51cy9yZXN1bHRzP19jb3VydElkPSZkZXBhcnRtZW50PVJQJyArCiAgICAgICAgICcm' +
  'bGltaXQ9NTAmb2Zmc2V0PTAmcT0nICsgZW5jb2RlVVJJQ29tcG9uZW50KFN0cmluZyhxIHx8ICcnKS50cmltKCkpICsKICAgICAg' +
  'ICAgJyZzZWFyY2hPY3JUZXh0PWZhbHNlJnNlYXJjaFR5cGU9cXVpY2tTZWFyY2gnOwp9OwoKYXN5bmMgZnVuY3Rpb24gY2FkSlNP' +
  'Tih1KSB7CiAgY29uc3QgciA9IGF3YWl0IGZldGNoKHUsIHsgbW9kZTogJ2NvcnMnIH0pOwogIGlmICghci5vaykgdGhyb3cgbmV3' +
  'IEVycm9yKCdIVFRQICcgKyByLnN0YXR1cyk7CiAgY29uc3QgaiA9IGF3YWl0IHIuanNvbigpOwogIGlmIChqLmVycm9yKSB0aHJv' +
  'dyBuZXcgRXJyb3Ioai5lcnJvci5tZXNzYWdlIHx8ICgnQ291bnR5IHNlcnZlciBlcnJvciAnICsgai5lcnJvci5jb2RlKSk7CiAg' +
  'cmV0dXJuIGo7Cn0KCmFzeW5jIGZ1bmN0aW9uIGNhZExvb2t1cChrZXksIG1vZGUsIHJhdywgY2l0eSwgb3ZlcnJpZGUpIHsKICBj' +
  'b25zdCBzcmMgPSBvdmVycmlkZSB8fCBDQURba2V5XTsKICBjb25zdCBHID0gc3JjLmYgfHwge30sIEcyID0gc3JjLmYyIHx8IHt9' +
  'OwogIGNvbnN0IHcgPSBbXTsKICBpZiAobW9kZSA9PT0gJ2FkZHInKSB7CiAgICBpZiAoIUcuYWRkcikgdGhyb3cgbmV3IEVycm9y' +
  'KCJUaGF0IGNvdW50eSdzIHJvbGwgaGFzIG5vIGFkZHJlc3MgY29sdW1uLiIpOwogICAgdy5wdXNoKCdVUFBFUignICsgRy5hZGRy' +
  'ICsgIikgTElLRSAnJSIgKyBzcWxFc2MoYWRkclRva2VucyhyYXcpLmpvaW4oJyUnKSkgKyAiJSciKTsKICB9IGVsc2UgewogICAg' +
  'aWYgKCFHLm93bmVyKSB0aHJvdyBuZXcgRXJyb3IoIlRoYXQgY291bnR5J3Mgcm9sbCBoYXMgbm8gb3duZXIgY29sdW1uLiIpOwog' +
  'ICAgdy5wdXNoKCdVUFBFUignICsgRy5vd25lciArICIpIExJS0UgJyUiICsgc3FsRXNjKHJhdy50b1VwcGVyQ2FzZSgpKSArICIl' +
  'JyIpOwogIH0KICBpZiAoY2l0eSkgewogICAgY29uc3QgY29kZSA9IChDQURba2V5XS5jaXRpZXMgfHwge30pW2NpdHldOwogICAg' +
  'aWYgKGNvZGUgJiYgRy51bml0KSB7CiAgICAgIHcucHVzaChDQURba2V5XS5jaXR5SXNUZXh0CiAgICAgICAgPyAnVVBQRVIoJyAr' +
  'IEcudW5pdCArICIpIExJS0UgJyUiICsgc3FsRXNjKGNvZGUudG9VcHBlckNhc2UoKSkgKyAiJSciCiAgICAgICAgOiBHLnVuaXQg' +
  'KyAiIExJS0UgJyUiICsgY29kZSArICIlJyIpOwogICAgfSBlbHNlIGlmIChHLmNpdHkpIHsKICAgICAgdy5wdXNoKCdVUFBFUign' +
  'ICsgRy5jaXR5ICsgIikgTElLRSAnJSIgKyBzcWxFc2MoY2l0eS50b1VwcGVyQ2FzZSgpKSArICIlJyIpOwogICAgfQogIH0KICBj' +
  'b25zdCBvdXRGID0gZmllbGRMaXN0KEcpOwogIGZvciAoY29uc3QgayBpbiBHMikgaWYgKEcyW2tdKSBvdXRGLnB1c2goRzJba10p' +
  'OwoKICBjb25zdCBxcCA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoewogICAgd2hlcmU6IHcuam9pbignIEFORCAnKSwgb3V0RmllbGRz' +
  'OiBvdXRGLmpvaW4oJywnKSwgcmV0dXJuR2VvbWV0cnk6ICdmYWxzZScsCiAgICByZXN1bHRSZWNvcmRDb3VudDogJzYwJywgZjog' +
  'J2pzb24nLCByZXR1cm5DZW50cm9pZDogJ3RydWUnLCBvdXRTUjogJzQzMjYnCiAgfSk7CiAgY29uc3QgciA9IGF3YWl0IGNhZEpT' +
  'T04oc3JjLnEgKyAnPycgKyBxcCk7CiAgcmV0dXJuIChyLmZlYXR1cmVzIHx8IFtdKS5tYXAoZnQgPT4gewogICAgY29uc3QgYSA9' +
  'IGZ0LmF0dHJpYnV0ZXMgfHwge30sIGN0ID0gZnQuY2VudHJvaWQgfHwge307CiAgICBsZXQgc3AgPSBzcGxpdFNpdHVzKGFbRy5h' +
  'ZGRyXSk7CiAgICBpZiAoRy5hZGRyUGFydHMpIHsKICAgICAgY29uc3QgYml0cyA9IEcuYWRkclBhcnRzLm1hcChrayA9PiBTdHJp' +
  'bmcoYVtra10gPT0gbnVsbCA/ICcnIDogYVtra10pLnRyaW0oKSkKICAgICAgICAuZmlsdGVyKHggPT4geCAmJiB4ICE9PSAnMCcp' +
  'OwogICAgICBpZiAoYml0cy5sZW5ndGgpIHNwID0geyBhZGRyOiBiaXRzLmpvaW4oJyAnKS5yZXBsYWNlKC9ccysvZywgJyAnKSwg' +
  'Y2l0eTogJycgfTsKICAgIH0KICAgIGNvbnN0IG1jaXR5ID0gRy5tYWlsY2l0eSA/IFN0cmluZyhhW0cubWFpbGNpdHldIHx8ICcn' +
  'KS50cmltKCkgOiAnJzsKICAgIGNvbnN0IHBjaXR5ID0gKEcuY2l0eSAmJiBhW0cuY2l0eV0pID8gU3RyaW5nKGFbRy5jaXR5XSku' +
  'dHJpbSgpIDogc3AuY2l0eTsKICAgIGNvbnN0IGV4ID0gRy5leGVtcHQgPyBTdHJpbmcoYVtHLmV4ZW1wdF0gfHwgJycpLnRyaW0o' +
  'KSA6ICcnOwogICAgY29uc3QgcGlkID0gRy5waWQgPyBhW0cucGlkXSA6ICcnOwogICAgcmV0dXJuIHsKICAgICAgbGF0OiBpc0Zp' +
  'bml0ZShjdC55KSA/IGN0LnkgOiBudWxsLCBsb246IGlzRmluaXRlKGN0LngpID8gY3QueCA6IG51bGwsCiAgICAgIGFkZHJlc3M6' +
  'IHRpdGxlQ2FzZShzcC5hZGRyKSB8fCAn4oCUJywgY2l0eTogdGl0bGVDYXNlKHBjaXR5KSB8fCBjaXR5LAogICAgICB6aXA6IEcu' +
  'emlwID8gU3RyaW5nKGFbRy56aXBdIHx8ICcnKS5zbGljZSgwLCA1KSA6ICcnLAogICAgICBzcWZ0OiBHLnNxZnQgPyBueihhW0cu' +
  'c3FmdF0pIDogMCwgeWVhcjogRy55ZWFyID8gbnooYVtHLnllYXJdKSA6IDAsCiAgICAgIGNsczogRy5jbHMgPyBTdHJpbmcoYVtH' +
  'LmNsc10gfHwgJycpLnRyaW0oKSA6ICcnLAogICAgICBvd25lcjogdGl0bGVDYXNlKGFbRy5vd25lcl0gfHwgJycpLAogICAgICBt' +
  'YWlsOiB0aXRsZUNhc2UoW2FbRy5tYWlsXSwgbWNpdHksIEcubWFpbHN0YXRlID8gYVtHLm1haWxzdGF0ZV0gOiAnJywKICAgICAg' +
  'ICAgICAgICAgICAgICAgICBHLm1haWx6aXAgPyBhW0cubWFpbHppcF0gOiAnJ10uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJywgJykp' +
  'LAogICAgICBtYWlsY2l0eTogdGl0bGVDYXNlKG1jaXR5KSwKICAgICAgZXhlbXB0OiBleCwgaG9tZXN0ZWFkOiAvXGJIU1xiL2ku' +
  'dGVzdChleCksCiAgICAgIG91dG9mdG93bjogISEobWNpdHkgJiYgcGNpdHkgJiYgbWNpdHkudG9VcHBlckNhc2UoKSAhPT0gcGNp' +
  'dHkudG9VcHBlckNhc2UoKSksCiAgICAgIGxlZ2FsOiBHLmxlZ2FsID8gU3RyaW5nKGFbRy5sZWdhbF0gfHwgJycpLnRyaW0oKSA6' +
  'ICcnLAogICAgICBkZWVkOiBkZWVkT2YoRywgYSksCiAgICAgIHBpZCwgZ2VvOiBHLmdlbyA/IGFbRy5nZW9dIDogJycsIGxpbms6' +
  'IChDQURba2V5XS5saW5rICYmIHBpZCkgPyBDQURba2V5XS5saW5rKHBpZCkgOiAnJwogICAgfTsKICB9KTsKfQoKbGV0IFBST1Ag' +
  'PSB7IGtleTogJ1RYfEhJREFMR08nLCBtb2RlOiAnYWRkcicsIHJlc3VsdHM6IFtdLCBqb2JJZDogbnVsbCwgcGVuZGluZzogbnVs' +
  'bCB9OwoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGZpbmQg' +
  'LS0tLS0tICovCi8qIFRocmVlIGxvb2t1cHMgYmVoaW5kIG9uZSB0YWIsIGJlY2F1c2UgaW4gcHJhY3RpY2UgdGhleSBhcmUgb25l' +
  'IGpvYjogeW91IGhhdmUKICAgYSBuYW1lIGFuZCBhIHN0YWxlIGFkZHJlc3MsIGFuZCB5b3UgYXJlIHRyeWluZyB0byB0dXJuIHRo' +
  'YXQgaW50byBhIGRvb3IuCgogICBQZW9wbGUgYW5kIEFkZHJlc3Mgc2VhcmNoIHdoYXQgdGhpcyBjb21wYW55IGFscmVhZHkga25v' +
  'd3Mg4oCUIHdoaWNoIGlzIHRoZSBiZXN0CiAgIHNraXAtdHJhY2UgZGF0YWJhc2UgYSB3b3JraW5nIHNlcnZlciBoYXMgYW5kLCB1' +
  'bnRpbCBub3csIHRoZSBsZWFzdCB1c2VkLgogICBQcm9wZXJ0eSBnb2VzIG91dCB0byB0aGUgY291bnR5IGFwcHJhaXNhbCByb2xs' +
  'LiAgICAgICAgICAgICAgICAgICAgICAgICAgICovCgpsZXQgRklORCA9IHsgdGFiOiAncGVvcGxlJywgcTogJycsIGNpdHk6ICcn' +
  'LCBjb3VudHk6ICcnLCBzdGF0ZTogJ1RYJywKICAgICAgICAgICAgIHBlb3BsZTogW10sIHBsYWNlczogW10sIHBsYXRlczogW10s' +
  'IG1heWJlOiBbXSwgcGxhdGVOb3RlOiAnJywKICAgICAgICAgICAgIHBlcnNvbjogbnVsbCwgYnVzeTogZmFsc2UsIHJhbjogZmFs' +
  'c2UsIGNvdW50eUtub3duOiB0cnVlIH07CgovKiBUaGUgY291bnRpZXMgdGhpcyBidXNpbmVzcyB3b3Jrcy4gVHlwaW5nIGFub3Ro' +
  'ZXIgb25lIGlzIGFsbG93ZWQg4oCUIGl0IG5hcnJvd3MKICAgdGhlIGxpY2VuY2Ugcm9sbCwgd2hpY2ggaXMgdGhlIG9ubHkgc291' +
  'cmNlIHRoYXQgcmVjb3JkcyBhIGNvdW50eSDigJQgYnV0IHRoZQogICB0YXggcm9sbHMgYW5kIHlvdXIgb3duIGpvYnMgcmVjb3Jk' +
  'IGEgY2l0eSwgc28gdGhvc2UgY2FuIG9ubHkgYmUgbmFycm93ZWQgYnkKICAgYSBjb3VudHkgd2hvc2UgdG93bnMgYXJlIGtub3du' +
  'LiAqLwpjb25zdCBDT1VOVElFUyA9IFsnSGlkYWxnbycsICdDYW1lcm9uJywgJ1N0YXJyJywgJ1dpbGxhY3knXTsKCmNvbnN0IG91' +
  'dGNvbWVQaWxsID0gbyA9PiB7CiAgY29uc3QgYmFkID0gL2JhZCBhZGRyZXNzfG1vdmVkfGV2YWQvaS50ZXN0KG8pOwogIGNvbnN0' +
  'IGdvb2QgPSAvc2VydmVkL2kudGVzdChvKTsKICByZXR1cm4gYDxzcGFuIGNsYXNzPSJwaWxsJHtnb29kID8gJyBvaycgOiBiYWQg' +
  'PyAnIHdhcm4nIDogJyd9Ij4ke2VzYyhvKX08L3NwYW4+YDsKfTsKCmZ1bmN0aW9uIGZpbmRWaWV3KCkgewogIGNvbnN0IHRhYiA9' +
  'IChrLCBsYWJlbCkgPT4KICAgIGA8YnV0dG9uIGNsYXNzPSJidG4gJHtGSU5ELnRhYiA9PT0gayA/ICcnIDogJ3NlYyAnfXNtIiBk' +
  'YXRhLWZ0PSIke2t9Ij4ke2xhYmVsfTwvYnV0dG9uPmA7CgogIGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8aDEgY2xhc3M9' +
  'InBhZ2UiPkZpbmQ8L2gxPgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9ImdhcDo2' +
  'cHgiPgogICAgICAgICR7dGFiKCdwZW9wbGUnLCAnUGVyc29uJyl9JHt0YWIoJ2FkZHJlc3MnLCAnQWRkcmVzcycpfSR7dGFiKCdw' +
  'bGF0ZScsICdQbGF0ZScpfSR7dGFiKCdwcm9wZXJ0eScsICdQcm9wZXJ0eScpfQogICAgICA8L2Rpdj4KICAgICAgPGRpdiBpZD0i' +
  'ZmluZEJvZHkiIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGlkPSJmaW5kT3V0Ij48' +
  'L2Rpdj5gKTsKICBiaW5kU2hlbGwoKTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1mdF0nKS5mb3JFYWNoKGIg' +
  'PT4gYi5vbmNsaWNrID0gKCkgPT4gewogICAgRklORC50YWIgPSBiLmRhdGFzZXQuZnQ7CiAgICBGSU5ELnJhbiA9IGZhbHNlOwog' +
  'ICAgaWYgKEZJTkQudGFiID09PSAncHJvcGVydHknKSByZXR1cm4gcHJvcGVydHlWaWV3KCk7CiAgICBmaW5kVmlldygpOwogIH0p' +
  'OwogIGRyYXdGaW5kRm9ybSgpOwp9CgpmdW5jdGlvbiBkcmF3RmluZEZvcm0oKSB7CiAgY29uc3QgYm9keSA9ICQoJyNmaW5kQm9k' +
  'eScpOwogIGNvbnN0IHBlcnNvbiA9IEZJTkQudGFiID09PSAncGVvcGxlJzsKICBjb25zdCBwbGF0ZSA9IEZJTkQudGFiID09PSAn' +
  'cGxhdGUnOwoKICBpZiAocGxhdGUpIHsKICAgIC8qIE5vIGNpdHkgb3IgY291bnR5IGhlcmUuIEEgcGxhdGUgaXMgYWxyZWFkeSBz' +
  'cGVjaWZpYywgYW5kIG5hcnJvd2luZyBpdCBieQogICAgICAgYSBwbGFjZSB3b3VsZCBoaWRlIHRoZSB2ZXJ5IHRoaW5nIHlvdSBh' +
  'cmUgbG9va2luZyBmb3I6IHRoZSBzYW1lIGNhcgogICAgICAgc29tZXdoZXJlIHlvdSBkaWQgbm90IGV4cGVjdC4gKi8KICAgIGJv' +
  'ZHkuaW5uZXJIVE1MID0gYAogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPlBsYXRlPC9sYWJlbD4KICAgICAgICA8aW5w' +
  'dXQgaWQ9ImZpbmRRIiB2YWx1ZT0iJHtlc2MoRklORC5xKX0iIGF1dG9jb21wbGV0ZT0ib2ZmIiBwbGFjZWhvbGRlcj0iRFhLNDQ3' +
  'MSIKICAgICAgICAgIGF1dG9jYXBpdGFsaXplPSJjaGFyYWN0ZXJzIiBzdHlsZT0idGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlIj48' +
  'L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJmaW5kR28iPlNlYXJj' +
  'aDwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIGlkPSJmaW5kQ2xlYXIiPkNsZWFyPC9idXR0b24+CiAg' +
  'ICAgIDwvZGl2PgogICAgICA8cCBjbGFzcz0iaGludCI+RXZlcnkgYXR0ZW1wdCB3aGVyZSB5b3Ugd3JvdGUgdGhpcyBwbGF0ZSBk' +
  'b3duLiBTcGFjaW5nIGFuZCBkYXNoZXMKICAgICAgICBkbyBub3QgbWF0dGVyLiBUaGlzIHNlYXJjaGVzIHlvdXIgb3duIHJlY29y' +
  'ZHMg4oCUIGEgcmVnaXN0ZXJlZCBvd25lciBjb21lcyBmcm9tCiAgICAgICAgdGhlIERNViBhbmQgbmVlZHMgYSBjcmVkZW50aWFs' +
  'ZWQgYWNjb3VudC48L3A+YDsKICAgICQoJyNmaW5kR28nKS5vbmNsaWNrID0gKCkgPT4geyBGSU5ELnEgPSAoJCgnI2ZpbmRRJyku' +
  'dmFsdWUgfHwgJycpLnRyaW0oKTsgcnVuRmluZCgpOyB9OwogICAgJCgnI2ZpbmRDbGVhcicpLm9uY2xpY2sgPSAoKSA9PiB7CiAg' +
  'ICAgIEZJTkQucSA9ICcnOyBGSU5ELnBsYXRlcyA9IFtdOyBGSU5ELm1heWJlID0gW107IEZJTkQucmFuID0gZmFsc2U7IGZpbmRW' +
  'aWV3KCk7CiAgICB9OwogICAgY29uc3QgcGkgPSAkKCcjZmluZFEnKTsKICAgIHBpLm9ua2V5ZG93biA9IGUgPT4geyBpZiAoZS5r' +
  'ZXkgPT09ICdFbnRlcicpIHsgRklORC5xID0gKHBpLnZhbHVlIHx8ICcnKS50cmltKCk7IHJ1bkZpbmQoKTsgfSB9OwogICAgaWYg' +
  'KCFGSU5ELnBlcnNvbikgcGkuZm9jdXMoKTsKICAgIGRyYXdGaW5kUmVzdWx0cygpOwogICAgcmV0dXJuOwogIH0KCiAgYm9keS5p' +
  'bm5lckhUTUwgPSBgCiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPiR7cGVyc29uID8gJ05hbWUnIDogJ0FkZHJlc3MnfTwv' +
  'bGFiZWw+CiAgICAgIDxpbnB1dCBpZD0iZmluZFEiIHZhbHVlPSIke2VzYyhGSU5ELnEpfSIgYXV0b2NvbXBsZXRlPSJvZmYiCiAg' +
  'ICAgICAgcGxhY2Vob2xkZXI9IiR7cGVyc29uID8gJ01hcmlhIEdhcnphJyA6ICcxODA2IEFzaCBBdmUnfSI+PC9kaXY+CiAgICA8' +
  'ZGl2IGNsYXNzPSJncmlkIGcyIj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5DaXR5IDxzcGFuIGNsYXNzPSJoaW50' +
  'Ij7igJQgb3B0aW9uYWw8L3NwYW4+PC9sYWJlbD4KICAgICAgICA8aW5wdXQgaWQ9ImZpbmRDaXR5IiB2YWx1ZT0iJHtlc2MoRklO' +
  'RC5jaXR5KX0iIGF1dG9jb21wbGV0ZT0ib2ZmIiBwbGFjZWhvbGRlcj0iTWNBbGxlbiI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9' +
  'ImZpZWxkIj48bGFiZWw+Q291bnR5IDxzcGFuIGNsYXNzPSJoaW50Ij7igJQgb3B0aW9uYWw8L3NwYW4+PC9sYWJlbD4KICAgICAg' +
  'ICA8aW5wdXQgaWQ9ImZpbmRDb3VudHkiIGxpc3Q9ImZpbmRDb3VudGllcyIgdmFsdWU9IiR7ZXNjKEZJTkQuY291bnR5KX0iCiAg' +
  'ICAgICAgICBhdXRvY29tcGxldGU9Im9mZiIgcGxhY2Vob2xkZXI9IkhpZGFsZ28iPgogICAgICAgIDxkYXRhbGlzdCBpZD0iZmlu' +
  'ZENvdW50aWVzIj4ke0NPVU5USUVTLm1hcChjID0+IGA8b3B0aW9uPiR7ZXNjKGMpfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvZGF0' +
  'YWxpc3Q+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCIgc3R5bGU9Im1heC13aWR0aDoxMjBw' +
  'eCI+PGxhYmVsPlN0YXRlPC9sYWJlbD4KICAgICAgPGlucHV0IGlkPSJmaW5kU3RhdGUiIHZhbHVlPSIke2VzYyhGSU5ELnN0YXRl' +
  'KX0iIG1heGxlbmd0aD0iMiIKICAgICAgICBzdHlsZT0idGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlIj48L2Rpdj4KICAgIDxkaXYg' +
  'Y2xhc3M9InJvdyI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9ImZpbmRHbyI+U2VhcmNoPC9idXR0b24+CiAgICAgIDxi' +
  'dXR0b24gY2xhc3M9ImJ0biBzZWMiIGlkPSJmaW5kQ2xlYXIiPkNsZWFyPC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDxwIGNsYXNz' +
  'PSJoaW50Ij4ke3BlcnNvbgogICAgICA/ICdFdmVyeSBqb2IsIGFkZHJlc3MgYW5kIGF0dGVtcHQgb24gZmlsZSBmb3IgdGhhdCBu' +
  'YW1lIOKAlCBmaXJzdCBhbmQgbGFzdCBuYW1lIGluIGVpdGhlciBvcmRlci4nCiAgICAgIDogJ0V2ZXJ5b25lIHlvdSBoYXZlIHRy' +
  'aWVkIHRvIHNlcnZlIGF0IGFuIGFkZHJlc3MsIGFuZCB3aG8gYW5zd2VyZWQgdGhlIGRvb3IuJ30KICAgICAgTGVhdmUgdGhlIGJv' +
  'eGVzIGJlbG93IGJsYW5rIHRvIHNlYXJjaCBldmVyeXdoZXJlLjwvcD5gOwoKICBjb25zdCByZWFkRm9ybSA9ICgpID0+IHsKICAg' +
  'IEZJTkQucSA9ICgkKCcjZmluZFEnKS52YWx1ZSB8fCAnJykudHJpbSgpOwogICAgRklORC5jaXR5ID0gKCQoJyNmaW5kQ2l0eScp' +
  'LnZhbHVlIHx8ICcnKS50cmltKCk7CiAgICBGSU5ELmNvdW50eSA9ICgkKCcjZmluZENvdW50eScpLnZhbHVlIHx8ICcnKS50cmlt' +
  'KCk7CiAgICBGSU5ELnN0YXRlID0gKCQoJyNmaW5kU3RhdGUnKS52YWx1ZSB8fCAnJykudHJpbSgpLnRvVXBwZXJDYXNlKCk7CiAg' +
  'fTsKCiAgJCgnI2ZpbmRHbycpLm9uY2xpY2sgPSAoKSA9PiB7IHJlYWRGb3JtKCk7IHJ1bkZpbmQoKTsgfTsKICAkKCcjZmluZENs' +
  'ZWFyJykub25jbGljayA9ICgpID0+IHsKICAgIEZJTkQucSA9ICcnOyBGSU5ELmNpdHkgPSAnJzsgRklORC5jb3VudHkgPSAnJzsg' +
  'RklORC5zdGF0ZSA9ICdUWCc7CiAgICBGSU5ELnBlb3BsZSA9IFtdOyBGSU5ELnBsYWNlcyA9IFtdOyBGSU5ELnBlcnNvbiA9IG51' +
  'bGw7IEZJTkQucmFuID0gZmFsc2U7CiAgICBmaW5kVmlldygpOwogIH07CiAgWycjZmluZENpdHknLCAnI2ZpbmRDb3VudHknLCAn' +
  'I2ZpbmRTdGF0ZSddLmZvckVhY2goc2VsID0+IHsKICAgIGNvbnN0IGVsID0gJChzZWwpOwogICAgaWYgKGVsKSBlbC5vbmtleWRv' +
  'd24gPSBlID0+IHsgaWYgKGUua2V5ID09PSAnRW50ZXInKSB7IHJlYWRGb3JtKCk7IHJ1bkZpbmQoKTsgfSB9OwogIH0pOwogIGNv' +
  'bnN0IGlucHV0ID0gJCgnI2ZpbmRRJyk7CiAgaW5wdXQub25rZXlkb3duID0gZSA9PiB7IGlmIChlLmtleSA9PT0gJ0VudGVyJykg' +
  'eyByZWFkRm9ybSgpOyBydW5GaW5kKCk7IH0gfTsKICBpZiAoIUZJTkQucGVyc29uKSBpbnB1dC5mb2N1cygpOwogIGRyYXdGaW5k' +
  'UmVzdWx0cygpOwp9CgovKiBUaGUgY2l0eSAvIGNvdW50eSAvIHN0YXRlIGJveGVzLCBhcyBhIHF1ZXJ5IHN0cmluZy4gTmFycm93' +
  'aW5nIGFwcGxpZXMgdG8KICAgeW91ciBvd24gcmVjb3JkcyBhbmQgdG8gdGhlIHB1YmxpYyBzb3VyY2VzIGFsaWtlLiAqLwpmdW5j' +
  'dGlvbiBmaW5kRmlsdGVycygpIHsKICByZXR1cm4gWwogICAgRklORC5jaXR5ID8gJ2NpdHk9JyArIGVuY29kZVVSSUNvbXBvbmVu' +
  'dChGSU5ELmNpdHkpIDogJycsCiAgICBGSU5ELmNvdW50eSA/ICdjb3VudHk9JyArIGVuY29kZVVSSUNvbXBvbmVudChGSU5ELmNv' +
  'dW50eSkgOiAnJywKICAgIEZJTkQuc3RhdGUgPyAnc3RhdGU9JyArIGVuY29kZVVSSUNvbXBvbmVudChGSU5ELnN0YXRlKSA6ICcn' +
  'CiAgXS5maWx0ZXIoQm9vbGVhbikuam9pbignJicpOwp9Cgpjb25zdCBmaWx0ZXJTdW1tYXJ5ID0gKCkgPT4gWwogIEZJTkQuY2l0' +
  'eSwgRklORC5jb3VudHkgPyBGSU5ELmNvdW50eSArICcgQ291bnR5JyA6ICcnLCBGSU5ELnN0YXRlCl0uZmlsdGVyKEJvb2xlYW4p' +
  'LmpvaW4oJyDCtyAnKTsKCmFzeW5jIGZ1bmN0aW9uIHJ1bkZpbmQoKSB7CiAgY29uc3QgdGVybSA9IEZJTkQucTsKICBGSU5ELnBl' +
  'cnNvbiA9IG51bGw7CiAgaWYgKHRlcm0ubGVuZ3RoIDwgMikgeyB0b2FzdCgnVHlwZSBhdCBsZWFzdCB0d28gY2hhcmFjdGVycycs' +
  'IHRydWUpOyByZXR1cm47IH0KICBGSU5ELmJ1c3kgPSB0cnVlOyBGSU5ELnJhbiA9IHRydWU7CiAgJCgnI2ZpbmRPdXQnKS5pbm5l' +
  'ckhUTUwgPSAnPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0iZW1wdHkiPlNlYXJjaGluZ+KApjwvZGl2PjwvZGl2Pic7CiAg' +
  'Y29uc3QgZXh0cmEgPSBmaW5kRmlsdGVycygpOwogIHRyeSB7CiAgICBpZiAoRklORC50YWIgPT09ICdwZW9wbGUnKSB7CiAgICAg' +
  'IGNvbnN0IGQgPSBhd2FpdCBhcGkoJy9wZW9wbGU/cT0nICsgZW5jb2RlVVJJQ29tcG9uZW50KHRlcm0pICsgKGV4dHJhID8gJyYn' +
  'ICsgZXh0cmEgOiAnJykpOwogICAgICBGSU5ELnBlb3BsZSA9IGQucGVvcGxlIHx8IFtdOwogICAgICBGSU5ELmNvdW50eUtub3du' +
  'ID0gZC5jb3VudHlfa25vd24gIT09IGZhbHNlOwogICAgfSBlbHNlIGlmIChGSU5ELnRhYiA9PT0gJ3BsYXRlJykgewogICAgICBj' +
  'b25zdCBkID0gYXdhaXQgYXBpKCcvcGxhdGVzP3E9JyArIGVuY29kZVVSSUNvbXBvbmVudCh0ZXJtKSk7CiAgICAgIEZJTkQucGxh' +
  'dGVzID0gZC5wbGF0ZXMgfHwgW107CiAgICAgIEZJTkQubWF5YmUgPSBkLm1heWJlIHx8IFtdOwogICAgICBGSU5ELnBsYXRlTm90' +
  'ZSA9IGQubm90ZSB8fCAnJzsKICAgIH0gZWxzZSB7CiAgICAgIGNvbnN0IGQgPSBhd2FpdCBhcGkoJy9wZW9wbGUvYXQ/cT0nICsg' +
  'ZW5jb2RlVVJJQ29tcG9uZW50KHRlcm0pICsgKGV4dHJhID8gJyYnICsgZXh0cmEgOiAnJykpOwogICAgICBGSU5ELnBsYWNlcyA9' +
  'IGQuYWRkcmVzc2VzIHx8IFtdOwogICAgICBGSU5ELmNvdW50eUtub3duID0gZC5jb3VudHlfa25vd24gIT09IGZhbHNlOwogICAg' +
  'fQogIH0gY2F0Y2ggKGUpIHsKICAgIEZJTkQucGVvcGxlID0gW107IEZJTkQucGxhY2VzID0gW107IEZJTkQucGxhdGVzID0gW107' +
  'IEZJTkQubWF5YmUgPSBbXTsKICAgIHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7CiAgfQogIEZJTkQuYnVzeSA9IGZhbHNlOwogIGRy' +
  'YXdGaW5kUmVzdWx0cygpOwp9CgovKiBBIGNvdW50eSBvbmx5IG5hcnJvd3MgYSBzb3VyY2UgdGhhdCByZWNvcmRzIG9uZS4gU2F5' +
  'aW5nIHNvIGlzIGJldHRlciB0aGFuIGEKICAgZmlsdGVyIHRoYXQgc2lsZW50bHkgZG9lcyBub3RoaW5nLiAqLwpmdW5jdGlvbiBj' +
  'b3VudHlXYXJuaW5nKCkgewogIGlmICghRklORC5jb3VudHkgfHwgRklORC5jb3VudHlLbm93bikgcmV0dXJuICcnOwogIHJldHVy' +
  'biBgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJvcmRlci1jb2xvcjojRjZDNjhBO2JhY2tncm91bmQ6I0ZFRjZFQyI+CiAgICA8' +
  'Yj4ke2VzYyhGSU5ELmNvdW50eSl9IENvdW50eSBuYXJyb3dlZCB0aGUgbGljZW5jZSByb2xsIG9ubHk8L2I+CiAgICA8ZGl2IGNs' +
  'YXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDo0cHgiPllvdXIgb3duIGpvYnMgYW5kIHRoZSB0YXggcm9sbHMgcmVjb3JkIGEg' +
  'Y2l0eSwKICAgICAgbm90IGEgY291bnR5LCBhbmQgdGhpcyBhcHAgb25seSBrbm93cyB3aGljaCB0b3ducyBhcmUgaW4gSGlkYWxn' +
  'bywgQ2FtZXJvbiwgU3RhcnIgYW5kCiAgICAgIFdpbGxhY3kuIEZvciBhbnl3aGVyZSBlbHNlLCBwdXQgdGhlIGNpdHkgaW4gaW5z' +
  'dGVhZC48L2Rpdj48L2Rpdj5gOwp9CgovKiBQbGF0ZXMgeW91IHdyb3RlIGRvd24geW91cnNlbGYuIFRoZSB0aGluZyB3b3J0aCBz' +
  'cG90dGluZyBpcyBhIHBsYXRlIGF0IG1vcmUKICAgdGhhbiBvbmUgYWRkcmVzcywgb3Igb24gbW9yZSB0aGFuIG9uZSBwZXJzb24n' +
  'cyBqb2IuICovCmZ1bmN0aW9uIGRyYXdQbGF0ZXMob3V0KSB7CiAgaWYgKCFGSU5ELnBsYXRlcy5sZW5ndGgpIHsKICAgIG91dC5p' +
  'bm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0iZW1wdHkiPgogICAgICBUaGF0IHBsYXRlIGlzIG5vdCBp' +
  'biB5b3VyIHJlY29yZHMuPGJyPjxzcGFuIGNsYXNzPSJoaW50Ij5Pbmx5IGF0dGVtcHRzIHdoZXJlIHlvdQogICAgICB0eXBlZCBp' +
  'dCBpbiBhcmUgc2VhcmNoYWJsZSDigJQgYW55dGhpbmcgd3JpdHRlbiBpbiBhIG5vdGVzIGJveCBiZWZvcmUgdGhpcyBleGlzdGVk' +
  'CiAgICAgIHdpbGwgbm90IGJlIGZvdW5kLjwvc3Bhbj48L2Rpdj48L2Rpdj4KICAgICAgJHtGSU5ELm1heWJlLmxlbmd0aCA/IG5l' +
  'YXJNaXNzZXMoKSA6ICcnfQogICAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgICA8aDI+UmVnaXN0ZXJlZCBvd25lcjwvaDI+' +
  'CiAgICAgICAgPGRpdiBjbGFzcz0iaGludCI+Tm90IGF2YWlsYWJsZSBoZXJlLiBUaGF0IGNvbWVzIGZyb20gRE1WIHJlY29yZHMs' +
  'IHdoaWNoIG5lZWQgYQogICAgICAgICAgY3JlZGVudGlhbGVkIGFjY291bnQgd2l0aCBhIGRhdGEgcHJvdmlkZXIg4oCUIHNlcnZp' +
  'bmcgcHJvY2VzcyBpcyBhIGxhd2Z1bCByZWFzb24KICAgICAgICAgIHRvIGFzaywgYnV0IHRoZSBhY2Nlc3MgaXRzZWxmIGhhcyB0' +
  'byBiZSBib3VnaHQgYW5kIGV2ZXJ5IHNlYXJjaCBpcyBsb2dnZWQuPC9kaXY+CiAgICAgIDwvZGl2PmA7CiAgICB3aXJlTmVhcigp' +
  'OwogICAgcmV0dXJuOwogIH0KCiAgb3V0LmlubmVySFRNTCA9IChGSU5ELnBsYXRlTm90ZQogICAgICA/IGA8ZGl2IGNsYXNzPSJj' +
  'YXJkIiBzdHlsZT0iYm9yZGVyLWNvbG9yOiNGNkM2OEE7YmFja2dyb3VuZDojRkVGNkVDIj4KICAgICAgICAgICA8Yj4ke2VzYyhG' +
  'SU5ELnBsYXRlTm90ZSl9PC9iPjwvZGl2PmAgOiAnJykgKwogICAgRklORC5wbGF0ZXMubWFwKHAgPT4gYAogICAgICA8ZGl2IGNs' +
  'YXNzPSJjYXJkIj4KICAgICAgICA8aDI+JHtlc2MocC5wbGF0ZSl9JHtwLnBsYXRlX3N0YXRlID8gYCA8c3BhbiBjbGFzcz0ic3Vi' +
  'Ij4ke2VzYyhwLnBsYXRlX3N0YXRlKX08L3NwYW4+YCA6ICcnfQogICAgICAgICAgPHNwYW4gY2xhc3M9InN1YiI+c2VlbiAke3Au' +
  'dGltZXN9w5c8L3NwYW4+PC9oMj4KICAgICAgICAke3AudmVoaWNsZSA/IGA8ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyhwLnZlaGlj' +
  'bGUpfSR7CiAgICAgICAgICBwLnZpbiA/IGAgwrcgVklOICR7ZXNjKHAudmluKX1gIDogJyd9PC9kaXY+YCA6ICcnfQoKICAgICAg' +
  'ICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPjxiPkNvbm5lY3RlZCB0bzwvYj48L2Rpdj4KICAgICAgICAke3AucGVvcGxl' +
  'Lm1hcCh4ID0+IGA8ZGl2IGNsYXNzPSJoaW50IiBkYXRhLXBrPSIke2VzYyh4LmtleSl9IgogICAgICAgICAgc3R5bGU9Im1hcmdp' +
  'bi10b3A6M3B4O2NvbG9yOnZhcigtLWJyYW5kKTtjdXJzb3I6cG9pbnRlciI+JHtlc2MoeC5uYW1lKX08L2Rpdj5gKS5qb2luKCcn' +
  'KX0KCiAgICAgICAgJHtwLnBsYWNlcy5sZW5ndGggPyBgPGRpdiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij48Yj5TZWVuIGF0PC9i' +
  'PgogICAgICAgICAgJHtwLnBsYWNlcy5tYXAoYSA9PiBgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6M3B4Ij7i' +
  'jIIgJHtlc2MoYSl9PC9kaXY+YCkuam9pbignJyl9CiAgICAgICAgPC9kaXY+YCA6ICcnfQoKICAgICAgICA8ZGl2IHN0eWxlPSJt' +
  'YXJnaW4tdG9wOjEycHgiPjxiPkV2ZXJ5IHNpZ2h0aW5nPC9iPjwvZGl2PgogICAgICAgICR7cC5zZWVuLm1hcChzID0+IGA8ZGl2' +
  'IHN0eWxlPSJwYWRkaW5nOjdweCAwO2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWxpbmUpIj4KICAgICAgICAgIDxkaXY+' +
  'JHtvdXRjb21lUGlsbChzLm91dGNvbWUpfSA8c3BhbiBjbGFzcz0ic3ViIj4ke2ZtdERUKHMud2hlbil9JHsKICAgICAgICAgICAg' +
  'cy5zZXJ2ZXIgPyAnIMK3ICcgKyBlc2Mocy5zZXJ2ZXIpIDogJyd9PC9zcGFuPjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0i' +
  'aGludCI+JHtlc2Mocy53aG8gfHwgJycpfSR7cy5hZGRyZXNzID8gJyDCtyAnICsgZXNjKHMuYWRkcmVzcykgOiAnJ308L2Rpdj4K' +
  'ICAgICAgICAgICR7cy5ub3RlcyA/IGA8ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyhzLm5vdGVzKX08L2Rpdj5gIDogJyd9CiAgICAg' +
  'ICAgPC9kaXY+YCkuam9pbignJyl9CiAgICAgIDwvZGl2PmApLmpvaW4oJycpICsgKEZJTkQubWF5YmUubGVuZ3RoID8gbmVhck1p' +
  'c3NlcygpIDogJycpOwoKICB3aXJlTmVhcigpOwp9CgovKiBQbGF0ZXMgdGhhdCBtYXRjaCBvbmx5IG9uY2UgdGhlIGVhc2lseS1j' +
  'b25mdXNlZCBjaGFyYWN0ZXJzIGFyZSBmb2xkZWQKICAgdG9nZXRoZXIuIE9mZmVyZWQgYXMgYSBxdWVzdGlvbiwgbmV2ZXIgbWl4' +
  'ZWQgaW50byB0aGUgYW5zd2VyLiAqLwpmdW5jdGlvbiBuZWFyTWlzc2VzKCkgewogIHJldHVybiBgPGRpdiBjbGFzcz0iY2FyZCI+' +
  'CiAgICA8aDI+RGlkIHlvdSBtZWFuIDxzcGFuIGNsYXNzPSJzdWIiPiR7RklORC5tYXliZS5sZW5ndGh9PC9zcGFuPjwvaDI+CiAg' +
  'ICA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLWJvdHRvbTo4cHgiPkNsb3NlLCBvbmNlIDAgYW5kIE8sIDEgYW5kIEks' +
  'IDUgYW5kIFMsCiAgICAgIDggYW5kIEIgYXJlIHRyZWF0ZWQgYXMgdGhlIHNhbWUuIEVhc3kgdG8gbWlzcmVhZCBvZmYgYSBjYXIu' +
  'PC9kaXY+CiAgICAke0ZJTkQubWF5YmUubWFwKG0gPT4gYDxkaXYgY2xhc3M9ImhpbnQiIGRhdGEtcGxhdGU9IiR7ZXNjKG0ucGxh' +
  'dGUpfSIKICAgICAgc3R5bGU9Im1hcmdpbi10b3A6NHB4O2NvbG9yOnZhcigtLWJyYW5kKTtjdXJzb3I6cG9pbnRlciI+CiAgICAg' +
  'IDxiPiR7ZXNjKG0ucGxhdGUpfTwvYj4ke20ucGxhdGVfc3RhdGUgPyAnICcgKyBlc2MobS5wbGF0ZV9zdGF0ZSkgOiAnJ30KICAg' +
  'ICAgJHttLnZlaGljbGUgPyAn4oCUICcgKyBlc2MobS52ZWhpY2xlKSA6ICcnfQogICAgICA8c3BhbiBjbGFzcz0ic3ViIj7CtyAk' +
  'e2VzYyhtLndobyB8fCAnJyl9IMK3ICR7Zm10RFQobS53aGVuKX08L3NwYW4+PC9kaXY+YCkuam9pbignJyl9CiAgPC9kaXY+YDsK' +
  'fQoKZnVuY3Rpb24gd2lyZU5lYXIoKSB7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcGxhdGVdJykuZm9yRWFj' +
  'aChlbCA9PiBlbC5vbmNsaWNrID0gKCkgPT4gewogICAgRklORC5xID0gZWwuZGF0YXNldC5wbGF0ZTsKICAgIGZpbmRWaWV3KCk7' +
  'CiAgICBzZXRUaW1lb3V0KHJ1bkZpbmQsIDApOwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBrXScp' +
  'LmZvckVhY2goZWwgPT4gZWwub25jbGljayA9ICgpID0+IHsKICAgIEZJTkQudGFiID0gJ3Blb3BsZSc7CiAgICBvcGVuUGVyc29u' +
  'KGVsLmRhdGFzZXQucGspOwogIH0pOwp9CgpmdW5jdGlvbiBkcmF3RmluZFJlc3VsdHMoKSB7CiAgY29uc3Qgb3V0ID0gJCgnI2Zp' +
  'bmRPdXQnKTsKICBpZiAoIW91dCkgcmV0dXJuOwogIGlmIChGSU5ELnBlcnNvbikgcmV0dXJuIGRyYXdQZXJzb24ob3V0KTsKICBp' +
  'ZiAoIUZJTkQucmFuKSB7IG91dC5pbm5lckhUTUwgPSAnJzsgcmV0dXJuOyB9CgogIGlmIChGSU5ELnRhYiA9PT0gJ3BsYXRlJykg' +
  'cmV0dXJuIGRyYXdQbGF0ZXMob3V0KTsKCiAgaWYgKEZJTkQudGFiID09PSAncGVvcGxlJykgewogICAgaWYgKCFGSU5ELnBlb3Bs' +
  'ZS5sZW5ndGgpIHsKICAgICAgLyogTm90aGluZyBvZiB5b3VyIG93biBpcyB0aGUgbW9tZW50IHRoZSBwdWJsaWMgcmVjb3JkcyBt' +
  'YXR0ZXIgbW9zdCDigJQgYQogICAgICAgICBkZWZlbmRhbnQgeW91IGhhdmUgbmV2ZXIgc2VydmVkIGJlZm9yZSBpcyBleGFjdGx5' +
  'IHdobyB5b3UgaGF2ZSB0byBnbwogICAgICAgICBhbmQgZmluZC4gU2VuZGluZyBzb21lYm9keSB0byBhIGRlYWQgZW5kIGhlcmUg' +
  'd291bGQgd2FzdGUgdGhlIHNlYXJjaC4gKi8KICAgICAgY29uc3QgbmFycm93ZWQgPSBmaWx0ZXJTdW1tYXJ5KCk7CiAgICAgIG91' +
  'dC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iY2FyZCI+PGRpdiBjbGFzcz0iZW1wdHkiPgogICAgICAgIE5vIG9uZSBieSB0aGF0' +
  'IG5hbWUgaW4geW91ciByZWNvcmRzJHtuYXJyb3dlZCA/ICcgaW4gJyArIGVzYyhuYXJyb3dlZCkgOiAnJ30uPGJyPgogICAgICAg' +
  'IDxzcGFuIGNsYXNzPSJoaW50Ij4ke25hcnJvd2VkCiAgICAgICAgICA/ICdDbGVhciB0aGUgY2l0eSBhbmQgY291bnR5IGJveGVz' +
  'IHRvIGxvb2sgZXZlcnl3aGVyZSwgb3Igc3RhcnQgZnJvbSB0aGUgcHVibGljIHJlY29yZHMgYmVsb3cuJwogICAgICAgICAgOiAn' +
  'Tm9ib2R5IHlvdSBoYXZlIHdvcmtlZCBvbiBiZWZvcmUg4oCUIHNvIHRoZSBwdWJsaWMgcmVjb3JkcyBiZWxvdyBhcmUgdGhlIHBs' +
  'YWNlIHRvIHN0YXJ0Lid9PC9zcGFuPjwvZGl2PjwvZGl2PgogICAgICAgICR7Y291bnR5V2FybmluZygpfQogICAgICAgIDxkaXYg' +
  'Y2xhc3M9ImNhcmQiIGlkPSJwdWJDYXJkIj4KICAgICAgICAgIDxoMj5QdWJsaWMgcmVjb3JkcyA8c3BhbiBjbGFzcz0ic3ViIiBp' +
  'ZD0icHViU3RhdHVzIj5sb29raW5n4oCmPC9zcGFuPjwvaDI+CiAgICAgICAgICA8ZGl2IGlkPSJwdWJPdXQiPjwvZGl2PgogICAg' +
  'ICAgIDwvZGl2PmA7CiAgICAgIGxvYWRQdWJsaWMoeyBuYW1lOiBGSU5ELnEgfSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIG91' +
  'dC5pbm5lckhUTUwgPSBjb3VudHlXYXJuaW5nKCkgKyBGSU5ELnBlb3BsZS5tYXAocCA9PiBgCiAgICAgIDxkaXYgY2xhc3M9ImNh' +
  'cmQgcGVyc29uIiBkYXRhLWtleT0iJHtlc2MocC5rZXkpfSIgc3R5bGU9ImN1cnNvcjpwb2ludGVyIj4KICAgICAgICA8aDI+JHtl' +
  'c2MocC5uYW1lKX0gPHNwYW4gY2xhc3M9InN1YiI+JHtwLnN0YXRzLmpvYnN9IGpvYiR7cC5zdGF0cy5qb2JzID09PSAxID8gJycg' +
  'OiAncyd9PC9zcGFuPjwvaDI+CiAgICAgICAgJHtwLnZhcmlhbnRzLmxlbmd0aCA+IDEgPyBgPGRpdiBjbGFzcz0iaGludCI+YWxz' +
  'byBvbiBmaWxlIGFzICR7CiAgICAgICAgICBlc2MocC52YXJpYW50cy5maWx0ZXIodiA9PiB2ICE9PSBwLm5hbWUpLmpvaW4oJyDC' +
  'tyAnKSl9PC9kaXY+YCA6ICcnfQogICAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjZweCI+CiAgICAg' +
  'ICAgICAke3Auc3RhdHMuYXR0ZW1wdHN9IGF0dGVtcHQke3Auc3RhdHMuYXR0ZW1wdHMgPT09IDEgPyAnJyA6ICdzJ30gwrcKICAg' +
  'ICAgICAgICR7cC5hZGRyZXNzZXMubGVuZ3RofSBhZGRyZXNzJHtwLmFkZHJlc3Nlcy5sZW5ndGggPT09IDEgPyAnJyA6ICdlcyd9' +
  'CiAgICAgICAgICAke3Auc3RhdHMuc2VydmVkID8gYCDCtyA8YiBzdHlsZT0iY29sb3I6dmFyKC0tZ29vZCkiPnNlcnZlZCAke3Au' +
  'c3RhdHMuc2VydmVkfcOXPC9iPmAgOiAnJ30KICAgICAgICAgICR7cC5zdGF0cy5ldmFzaXZlID8gYCDCtyA8YiBzdHlsZT0iY29s' +
  'b3I6dmFyKC0tYmFkKSI+ZXZhc2l2ZTwvYj5gIDogJyd9CiAgICAgICAgICAke3Auc3RhdHMuYmFkX2FkZHJlc3MgPyBgIMK3ICR7' +
  'cC5zdGF0cy5iYWRfYWRkcmVzc30gYmFkIGFkZHJlc3NgIDogJyd9CiAgICAgICAgPC9kaXY+CiAgICAgICAgJHtwLmFkZHJlc3Nl' +
  'cy5zbGljZSgwLCAyKS5tYXAoYSA9PiBgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6NHB4Ij4KICAgICAgICAg' +
  'IOKMgiAke2VzYyhhLmxpbmUpfSR7YS5jaXR5ID8gJywgJyArIGVzYyhhLmNpdHkpIDogJyd9CiAgICAgICAgICAke2EuYXR0ZW1w' +
  'dHMgPyBgPHNwYW4gY2xhc3M9InN1YiI+IOKAlCAke2EuYXR0ZW1wdHN9IGF0dGVtcHQke2EuYXR0ZW1wdHMgPT09IDEgPyAnJyA6' +
  'ICdzJ308L3NwYW4+YCA6ICcnfQogICAgICAgIDwvZGl2PmApLmpvaW4oJycpfQogICAgICAgIDxkaXYgY2xhc3M9ImhpbnQiIHN0' +
  'eWxlPSJtYXJnaW4tdG9wOjhweDtjb2xvcjp2YXIoLS1icmFuZCk7Zm9udC13ZWlnaHQ6NzAwIj5PcGVuIOKGkjwvZGl2PgogICAg' +
  'ICA8L2Rpdj5gKS5qb2luKCcnKTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5wZXJzb24nKS5mb3JFYWNoKGMgPT4g' +
  'Yy5vbmNsaWNrID0gKCkgPT4gb3BlblBlcnNvbihjLmRhdGFzZXQua2V5KSk7CiAgICByZXR1cm47CiAgfQoKICBpZiAoIUZJTkQu' +
  'cGxhY2VzLmxlbmd0aCkgewogICAgb3V0LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJlbXB0eSI+' +
  'CiAgICAgIE5vdGhpbmcgb24gZmlsZSBhdCB0aGF0IGFkZHJlc3Mke2ZpbHRlclN1bW1hcnkoKSA/ICcgaW4gJyArIGVzYyhmaWx0' +
  'ZXJTdW1tYXJ5KCkpIDogJyd9Ljxicj4KICAgICAgPHNwYW4gY2xhc3M9ImhpbnQiPk5ldmVyIGJlZW4gdGhlcmUg4oCUIHNvIHRy' +
  'eSB0aGUgcHVibGljIHJlY29yZHMgYmVsb3csIG9yIHRoZSBjb3VudHkKICAgICAgcm9sbCB1bmRlciBQcm9wZXJ0eSBmb3Igd2hv' +
  'IG93bnMgaXQuPC9zcGFuPjwvZGl2PjwvZGl2PgogICAgICAke2NvdW50eVdhcm5pbmcoKX0KICAgICAgPGRpdiBjbGFzcz0iY2Fy' +
  'ZCIgaWQ9InB1YkNhcmQiPgogICAgICAgIDxoMj5QdWJsaWMgcmVjb3JkcyA8c3BhbiBjbGFzcz0ic3ViIiBpZD0icHViU3RhdHVz' +
  'Ij5sb29raW5n4oCmPC9zcGFuPjwvaDI+CiAgICAgICAgPGRpdiBpZD0icHViT3V0Ij48L2Rpdj4KICAgICAgPC9kaXY+YDsKICAg' +
  'IGxvYWRQdWJsaWMoeyBhZGRyZXNzOiBGSU5ELnEgfSk7CiAgICByZXR1cm47CiAgfQogIG91dC5pbm5lckhUTUwgPSBGSU5ELnBs' +
  'YWNlcy5tYXAoYSA9PiBgCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPiR7ZXNjKGEubGluZSl9IDxzcGFuIGNsYXNz' +
  'PSJzdWIiPiR7ZXNjKFthLmNpdHksIGEuc3RhdGVdLmZpbHRlcihCb29sZWFuKS5qb2luKCcsICcpKX08L3NwYW4+PC9oMj4KICAg' +
  'ICAgPGRpdiBjbGFzcz0iaGludCI+JHthLmF0dGVtcHRzfSBhdHRlbXB0JHthLmF0dGVtcHRzID09PSAxID8gJycgOiAncyd9JHsK' +
  'ICAgICAgICBhLmxhc3QgPyAnIMK3IGxhc3QgJyArIGZtdERUKGEubGFzdCkgOiAnJ30KICAgICAgICAke09iamVjdC5lbnRyaWVz' +
  'KGEub3V0Y29tZXMgfHwge30pLm1hcCgoW28sIG5dKSA9PiBgIMK3ICR7ZXNjKG8pfSDDlyR7bn1gKS5qb2luKCcnKX08L2Rpdj4K' +
  'CiAgICAgIDxkaXYgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+PGI+VHJpZWQgaGVyZTwvYj48L2Rpdj4KICAgICAgJHthLnBlb3Bs' +
  'ZS5tYXAocCA9PiBgPGRpdiBjbGFzcz0iaGludCIgZGF0YS1waz0iJHtlc2MocC5rZXkpfSIKICAgICAgICBzdHlsZT0ibWFyZ2lu' +
  'LXRvcDozcHg7Y29sb3I6dmFyKC0tYnJhbmQpO2N1cnNvcjpwb2ludGVyIj4KICAgICAgICAke2VzYyhwLm5hbWUpfSA8c3BhbiBj' +
  'bGFzcz0ic3ViIj7igJQgJHtPYmplY3QuZW50cmllcyhwLnN0YXR1c2VzKS5tYXAoKFtzLCBuXSkgPT4KICAgICAgICAgIGVzYyhz' +
  'KSArIChuID4gMSA/ICcgw5cnICsgbiA6ICcnKSkuam9pbignLCAnKX08L3NwYW4+PC9kaXY+YCkuam9pbignJyl9CgogICAgICAk' +
  'e2EuYW5zd2VyZWQubGVuZ3RoID8gYDxkaXYgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+PGI+QW5zd2VyZWQgdGhlIGRvb3I8L2I+' +
  'CiAgICAgICAgPGRpdiBjbGFzcz0iaGludCI+VXNlZnVsIGZvciBzdWJzdGl0dXRlZCBzZXJ2aWNlIOKAlCBzb21lb25lIG9mIHN1' +
  'aXRhYmxlIGFnZSB5b3UgaGF2ZQogICAgICAgICAgYWxyZWFkeSBtZXQgYW5kIHJlY29yZGVkLjwvZGl2PgogICAgICAgICR7YS5h' +
  'bnN3ZXJlZC5tYXAodyA9PiBgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6M3B4Ij4KICAgICAgICAgICR7ZXNj' +
  'KHcubmFtZSl9JHt3LnJlbGF0aW9uc2hpcCA/IGAgPHNwYW4gY2xhc3M9InN1YiI+4oCUICR7ZXNjKHcucmVsYXRpb25zaGlwKX08' +
  'L3NwYW4+YCA6ICcnfQogICAgICAgICAgPHNwYW4gY2xhc3M9InN1YiI+wrcgJHt3LnRpbWVzfcOXLCBsYXN0ICR7Zm10RFQody5s' +
  'YXN0KX08L3NwYW4+PC9kaXY+YCkuam9pbignJyl9CiAgICAgIDwvZGl2PmAgOiAnJ30KICAgIDwvZGl2PmApLmpvaW4oJycpICsg' +
  'YAogICAgPGRpdiBjbGFzcz0iY2FyZCIgaWQ9InB1YkNhcmQiPgogICAgICA8aDI+UHVibGljIHJlY29yZHMgPHNwYW4gY2xhc3M9' +
  'InN1YiIgaWQ9InB1YlN0YXR1cyI+bG9va2luZ+KApjwvc3Bhbj48L2gyPgogICAgICA8ZGl2IGlkPSJwdWJPdXQiPjwvZGl2Pgog' +
  'ICAgPC9kaXY+YDsKCiAgLy8gQW55IGJ1c2luZXNzIHRyYWRpbmcgYXQgdGhpcyBhZGRyZXNzLCBmcm9tIHRoZSBzYWxlcyB0YXgg' +
  'cGVybWl0IHJvbGwuCiAgbG9hZFB1YmxpYyh7IGFkZHJlc3M6IEZJTkQucSB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxs' +
  'KCdbZGF0YS1wa10nKS5mb3JFYWNoKGVsID0+CiAgICBlbC5vbmNsaWNrID0gKCkgPT4geyBGSU5ELnRhYiA9ICdwZW9wbGUnOyBv' +
  'cGVuUGVyc29uKGVsLmRhdGFzZXQucGspOyB9KTsKfQoKLyogLS0tLSBwdWJsaWMgcmVjb3JkcyAtLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0KICAgRnJlZSBnb3Zlcm5tZW50IHNvdXJjZXMsIHNob3duIHVuZGVy' +
  'IHRoZSBwZXJzb24ncyBvd24gaGlzdG9yeSBiZWNhdXNlIHRoYXQKICAgaXMgdGhlIG9yZGVyIHlvdSBzaG91bGQgcmVhZCB0aGVt' +
  'IGluOiB3aGF0IHlvdSBrbm93LCB0aGVuIHdoYXQgaXMgY2xhaW1lZC4gICovCmFzeW5jIGZ1bmN0aW9uIGxvYWRQdWJsaWMocSkg' +
  'ewogIGNvbnN0IGJveCA9ICQoJyNwdWJPdXQnKSwgc3RhdHVzID0gJCgnI3B1YlN0YXR1cycpOwogIGlmICghYm94KSByZXR1cm47' +
  'CiAgY29uc3QgZXh0cmEgPSBmaW5kRmlsdGVycygpOwogIGNvbnN0IHFzID0gKHEubmFtZSA/ICduYW1lPScgKyBlbmNvZGVVUklD' +
  'b21wb25lbnQocS5uYW1lKQogICAgICAgICAgICAgICAgICAgICA6ICdhZGRyZXNzPScgKyBlbmNvZGVVUklDb21wb25lbnQocS5h' +
  'ZGRyZXNzKSkgKwogICAgICAgICAgICAgKGV4dHJhID8gJyYnICsgZXh0cmEgOiAnJyk7CiAgbGV0IGQ7CiAgdHJ5IHsKICAgIGQg' +
  'PSBhd2FpdCBhcGkoJy9wZW9wbGUvcHVibGljPycgKyBxcyk7CiAgfSBjYXRjaCAoZSkgewogICAgc3RhdHVzLnRleHRDb250ZW50' +
  'ID0gJyc7CiAgICBib3guaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImhpbnQiPkNvdWxkbid0IHJlYWNoIHRoZSBwdWJsaWMgcmVj' +
  'b3JkcyBzZXJ2aWNlcyDigJQgJHtlc2MoZS5tZXNzYWdlKX0uCiAgICAgIE5vdGhpbmcgZWxzZSBvbiB0aGlzIHBhZ2UgZGVwZW5k' +
  'cyBvbiB0aGVtLjwvZGl2PmA7CiAgICByZXR1cm47CiAgfQoKICBjb25zdCBhbGwgPSBkLnNvdXJjZXMgfHwgW107CiAgY29uc3Qg' +
  'd2l0aEhpdHMgPSBhbGwuZmlsdGVyKHMgPT4gcy5yZXN1bHRzLmxlbmd0aCk7CiAgY29uc3QgYnJva2UgPSBhbGwuZmlsdGVyKHMg' +
  'PT4gIXMub2spOwogIGNvbnN0IHRvdGFsID0gd2l0aEhpdHMucmVkdWNlKChuLCBzKSA9PiBuICsgcy5yZXN1bHRzLmxlbmd0aCwg' +
  'MCk7CgogIC8qICJOb3RoaW5nIGZvdW5kIiBhbmQgImNvdWxkbid0IGFzayIgYXJlIGRpZmZlcmVudCBhbnN3ZXJzLCBhbmQgc29t' +
  'ZWJvZHkKICAgICBkZWNpZGluZyB3aGV0aGVyIHRvIHN0b3AgbG9va2luZyBuZWVkcyB0byBrbm93IHdoaWNoIG9uZSB0aGV5IGdv' +
  'dC4gKi8KICBjb25zdCBhbGxEb3duID0gYWxsLmxlbmd0aCAmJiBicm9rZS5sZW5ndGggPT09IGFsbC5sZW5ndGg7CiAgc3RhdHVz' +
  'LnRleHRDb250ZW50ID0gYWxsRG93biA/ICJjb3VsZG4ndCByZWFjaCB0aGVtIgogICAgOiB0b3RhbCA/IGAke3RvdGFsfSBwb3Nz' +
  'aWJsZSBtYXRjaCR7dG90YWwgPT09IDEgPyAnJyA6ICdlcyd9YAogICAgOiAnbm90aGluZyBmb3VuZCc7CgogIGlmIChhbGxEb3du' +
  'KSB7CiAgICBib3guaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQpIj48Yj5Ob25l' +
  'IG9mIHRoZSBwdWJsaWMgcmVjb3JkcwogICAgICBzZXJ2aWNlcyBhbnN3ZXJlZDwvYj4sIHNvIHRoaXMgdGVsbHMgeW91IG5vdGhp' +
  'bmcgZWl0aGVyIHdheSDigJQgaXQgaXMgbm90IHRoZSBzYW1lIGFzCiAgICAgIGZpbmRpbmcgbm90aGluZy4gJHticm9rZS5tYXAo' +
  'cyA9PiBlc2Mocy5sYWJlbCkgKyAnIOKAlCAnICsgZXNjKHMuZXJyb3IpKS5qb2luKCc7ICcpfS48L2Rpdj4KICAgICAgPGRpdiBj' +
  'bGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6NnB4Ij5Zb3VyIG93biByZWNvcmRzIGFib3ZlIGFyZSB1bmFmZmVjdGVkLgog' +
  'ICAgICAgIDxhIGhyZWY9IiMiIGlkPSJwdWJSZXRyeSI+VHJ5IGFnYWluPC9hPjwvZGl2PmA7CiAgICBjb25zdCBhZ2FpbiA9ICQo' +
  'JyNwdWJSZXRyeScpOwogICAgaWYgKGFnYWluKSBhZ2Fpbi5vbmNsaWNrID0gZSA9PiB7CiAgICAgIGUucHJldmVudERlZmF1bHQo' +
  'KTsKICAgICAgc3RhdHVzLnRleHRDb250ZW50ID0gJ2xvb2tpbmfigKYnOwogICAgICBib3guaW5uZXJIVE1MID0gJyc7CiAgICAg' +
  'IGxvYWRQdWJsaWMocSk7CiAgICB9OwogICAgcmV0dXJuOwogIH0KCiAgaWYgKCF3aXRoSGl0cy5sZW5ndGgpIHsKICAgIGJveC5p' +
  'bm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iaGludCI+Tm90aGluZyB1bmRlciB0aGF0IG5hbWUgaW4KICAgICAgJHticm9rZS5sZW5n' +
  'dGggPyAndGhlIHNvdXJjZXMgdGhhdCBhbnN3ZXJlZCcgOiAndGhlIGZyZWUgZ292ZXJubWVudCBzb3VyY2VzJ30g4oCUCiAgICAg' +
  'IGNvbXBhbnkgZmlsaW5ncywgc2FsZXMgdGF4IHBlcm1pdHMsIHRyYWRlIGxpY2VuY2VzIG9yIHRoZSBoZWFsdGhjYXJlIHJlZ2lz' +
  'dHJ5LgogICAgICBUaGF0IGlzIGNvbW1vbiBmb3Igc29tZW9uZSB3aG8gcmVudHMgYW5kIHdvcmtzIGZvciBhIHdhZ2UuPC9kaXY+' +
  'CiAgICAgICR7YnJva2UubGVuZ3RoID8gYDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjZweDtjb2xvcjp2YXIo' +
  'LS1iYWQpIj4KICAgICAgICBDb3VsZG4ndCByZWFjaDogJHticm9rZS5tYXAocyA9PiBlc2Mocy5sYWJlbCkgKyAnICgnICsgZXNj' +
  'KHMuZXJyb3IpICsgJyknKS5qb2luKCcsICcpfSDigJQKICAgICAgICBzbyB0aGlzIGlzIG5vdCBhIGNvbXBsZXRlIGFuc3dlci48' +
  'L2Rpdj5gIDogJyd9YDsKICAgIHJldHVybjsKICB9CgogIGJveC5pbm5lckhUTUwgPSBgCiAgICA8ZGl2IGNsYXNzPSJoaW50IiBz' +
  'dHlsZT0ibWFyZ2luLWJvdHRvbToxMHB4Ij4ke2VzYyhkLm5vdGUpfTwvZGl2PgogICAgJHt3aXRoSGl0cy5tYXAocyA9PiBgCiAg' +
  'ICAgIDxkaXYgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+CiAgICAgICAgPGRpdj48Yj4ke2VzYyhzLmxhYmVsKX08L2I+IDxzcGFu' +
  'IGNsYXNzPSJzdWIiPiR7cy5yZXN1bHRzLmxlbmd0aH08L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5' +
  'bGU9Im1hcmdpbi1ib3R0b206NnB4Ij4ke2VzYyhzLndoYXQpfTwvZGl2PgogICAgICAgICR7cy5yZXN1bHRzLnNsaWNlKDAsIDEy' +
  'KS5tYXAociA9PiBgCiAgICAgICAgICA8ZGl2IHN0eWxlPSJwYWRkaW5nOjdweCAwO2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZh' +
  'cigtLWxpbmUpIj4KICAgICAgICAgICAgPGRpdj48Yj4ke2VzYyhyLm5hbWUpfTwvYj4gPHNwYW4gY2xhc3M9InBpbGwiPiR7ZXNj' +
  'KHIua2luZCl9PC9zcGFuPjwvZGl2PgogICAgICAgICAgICAke3IuYWRkcmVzcyA/IGA8ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyhy' +
  'LmFkZHJlc3MpfSR7CiAgICAgICAgICAgICAgci5jaXR5ID8gJywgJyArIGVzYyhyLmNpdHkpIDogJyd9JHtyLnppcCA/ICcgJyAr' +
  'IGVzYyhyLnppcCkgOiAnJ308L2Rpdj5gIDogJyd9CiAgICAgICAgICAgICR7ci5kZXRhaWwgPyBgPGRpdiBjbGFzcz0iaGludCI+' +
  'JHtlc2Moci5kZXRhaWwpfTwvZGl2PmAgOiAnJ30KICAgICAgICAgICAgJHtyLmFkZHJlc3MgPyBgPGRpdiBzdHlsZT0ibWFyZ2lu' +
  'LXRvcDo1cHgiPjxhIGNsYXNzPSJidG4gc2VjIHNtIiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciIKICAgICAgICAgICAg' +
  'ICBocmVmPSJodHRwczovL3d3dy5nb29nbGUuY29tL21hcHMvc2VhcmNoLz9hcGk9MSZxdWVyeT0ke2VuY29kZVVSSUNvbXBvbmVu' +
  'dCgKICAgICAgICAgICAgICAgIFtyLmFkZHJlc3MsIHIuY2l0eSwgci5zdGF0ZSwgci56aXBdLmZpbHRlcihCb29sZWFuKS5qb2lu' +
  'KCcgJykpfSI+TWFwPC9hPjwvZGl2PmAgOiAnJ30KICAgICAgICAgIDwvZGl2PmApLmpvaW4oJycpfQogICAgICAgICR7cy5yZXN1' +
  'bHRzLmxlbmd0aCA+IDEyID8gYDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjZweCI+CiAgICAgICAgICBhbmQg' +
  'JHtzLnJlc3VsdHMubGVuZ3RoIC0gMTJ9IG1vcmUg4oCUIG5hcnJvdyB0aGUgbmFtZSBpZiBub25lIG9mIHRoZXNlIGZpdC48L2Rp' +
  'dj5gIDogJyd9CiAgICAgIDwvZGl2PmApLmpvaW4oJycpfQogICAgJHticm9rZS5sZW5ndGggPyBgPGRpdiBjbGFzcz0iaGludCIg' +
  'c3R5bGU9Im1hcmdpbi10b3A6MTBweDtjb2xvcjp2YXIoLS1iYWQpIj4KICAgICAgQ291bGRuJ3QgcmVhY2g6ICR7YnJva2UubWFw' +
  'KHMgPT4gZXNjKHMubGFiZWwpKS5qb2luKCcsICcpfS4gVHJ5IGFnYWluIGluIGEgbW9tZW50LjwvZGl2PmAgOiAnJ31gOwp9Cgph' +
  'c3luYyBmdW5jdGlvbiBvcGVuUGVyc29uKGtleSkgewogIHRyeSB7CiAgICBGSU5ELnBlcnNvbiA9IGF3YWl0IGFwaSgnL3Blb3Bs' +
  'ZS9vbmU/a2V5PScgKyBlbmNvZGVVUklDb21wb25lbnQoa2V5KSk7CiAgICBmaW5kVmlldygpOwogIH0gY2F0Y2ggKGUpIHsgdG9h' +
  'c3QoZS5tZXNzYWdlLCB0cnVlKTsgfQp9CgpmdW5jdGlvbiBkcmF3UGVyc29uKG91dCkgewogIGNvbnN0IHAgPSBGSU5ELnBlcnNv' +
  'bjsKICBjb25zdCBzID0gcC5zdGF0czsKICBvdXQuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxk' +
  'aXYgY2xhc3M9InJvdyIgc3R5bGU9Imp1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQi' +
  'PgogICAgICAgIDxkaXY+PGgyIHN0eWxlPSJtYXJnaW46MCI+JHtlc2MocC5uYW1lKX08L2gyPgogICAgICAgICAgJHtwLnZhcmlh' +
  'bnRzLmxlbmd0aCA+IDEgPyBgPGRpdiBjbGFzcz0iaGludCI+YWxzbzogJHsKICAgICAgICAgICAgZXNjKHAudmFyaWFudHMuZmls' +
  'dGVyKHYgPT4gdiAhPT0gcC5uYW1lKS5qb2luKCcgwrcgJykpfTwvZGl2PmAgOiAnJ308L2Rpdj4KICAgICAgICA8YnV0dG9uIGNs' +
  'YXNzPSJidG4gc2VjIHNtIiBpZD0icEJhY2siPkJhY2s8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0' +
  'YXRzIiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJzdGF0Ij48ZGl2IGNsYXNzPSJuIj4ke3Mu' +
  'am9ic308L2Rpdj48ZGl2IGNsYXNzPSJsIj5Kb2JzPC9kaXY+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ic3RhdCI+PGRpdiBj' +
  'bGFzcz0ibiI+JHtzLmF0dGVtcHRzfTwvZGl2PjxkaXYgY2xhc3M9ImwiPkF0dGVtcHRzPC9kaXY+PC9kaXY+CiAgICAgICAgPGRp' +
  'diBjbGFzcz0ic3RhdCAke3Muc2VydmVkID8gJ2dvb2QnIDogJyd9Ij48ZGl2IGNsYXNzPSJuIj4ke3Muc2VydmVkfTwvZGl2Pjxk' +
  'aXYgY2xhc3M9ImwiPlNlcnZlZDwvZGl2PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InN0YXQgJHtzLmV2YXNpdmUgPyAnYWxl' +
  'cnQnIDogJyd9Ij48ZGl2IGNsYXNzPSJuIj4ke3AuYWRkcmVzc2VzLmxlbmd0aH08L2Rpdj48ZGl2IGNsYXNzPSJsIj5BZGRyZXNz' +
  'ZXM8L2Rpdj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkFk' +
  'ZHJlc3NlcyA8c3BhbiBjbGFzcz0ic3ViIj5tb3N0IGF0dGVtcHRlZCBmaXJzdDwvc3Bhbj48L2gyPgogICAgICAke3AuYWRkcmVz' +
  'c2VzLm1hcChhID0+IGA8ZGl2IHN0eWxlPSJwYWRkaW5nOjlweCAwO2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWxpbmUp' +
  'Ij4KICAgICAgICA8ZGl2PjxiPiR7ZXNjKGEubGluZSl9PC9iPiR7YS5jaXR5ID8gYDxzcGFuIGNsYXNzPSJzdWIiPiAke2VzYyhh' +
  'LmNpdHkpfSR7CiAgICAgICAgICBhLnppcCA/ICcgJyArIGVzYyhhLnppcCkgOiAnJ308L3NwYW4+YCA6ICcnfTwvZGl2PgogICAg' +
  'ICAgIDxkaXYgY2xhc3M9ImhpbnQiPiR7YS5hdHRlbXB0cwogICAgICAgICAgPyBgJHthLmF0dGVtcHRzfSBhdHRlbXB0JHthLmF0' +
  'dGVtcHRzID09PSAxID8gJycgOiAncyd9IMK3ICR7CiAgICAgICAgICAgICAgT2JqZWN0LmVudHJpZXMoYS5vdXRjb21lcykubWFw' +
  'KChbbywgbl0pID0+IGVzYyhvKSArIChuID4gMSA/ICcgw5cnICsgbiA6ICcnKSkuam9pbignLCAnKX0KICAgICAgICAgICAgICR7' +
  'YS5sYXN0ID8gJyDCtyBsYXN0ICcgKyBmbXREVChhLmxhc3QpIDogJyd9YAogICAgICAgICAgOiAnb24gZmlsZSwgbmV2ZXIgYXR0' +
  'ZW1wdGVkJ308L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjZweDtnYXA6NnB4Ij4KICAg' +
  'ICAgICAgIDxhIGNsYXNzPSJidG4gc2VjIHNtIiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciIKICAgICAgICAgICAgIGhy' +
  'ZWY9Imh0dHBzOi8vd3d3Lmdvb2dsZS5jb20vbWFwcy9zZWFyY2gvP2FwaT0xJnF1ZXJ5PSR7CiAgICAgICAgICAgICAgIGVuY29k' +
  'ZVVSSUNvbXBvbmVudChbYS5saW5lLCBhLmNpdHksIGEuc3RhdGUsIGEuemlwXS5maWx0ZXIoQm9vbGVhbikuam9pbignICcpKX0i' +
  'Pk1hcDwvYT4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGRhdGEtbG9va3VwPSIke2VzYyhhLmxpbmUpfSI+' +
  'V2hvIGVsc2UgaXMgaGVyZTwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj5gKS5qb2luKCcnKSB8fCAnPGRpdiBj' +
  'bGFzcz0iZW1wdHkiPk5vIGFkZHJlc3NlcyBvbiBmaWxlLjwvZGl2Pid9CiAgICA8L2Rpdj4KCiAgICAkeyhwLnZlaGljbGVzIHx8' +
  'IFtdKS5sZW5ndGggPyBgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5WZWhpY2xlcyA8c3BhbiBjbGFzcz0ic3ViIj5zZWVu' +
  'IHdoaWxlIGF0dGVtcHRpbmc8L3NwYW4+PC9oMj4KICAgICAgJHtwLnZlaGljbGVzLm1hcCh2ID0+IGA8ZGl2IHN0eWxlPSJwYWRk' +
  'aW5nOjhweCAwO2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWxpbmUpIj4KICAgICAgICA8ZGl2PiR7di5wbGF0ZSA/IGA8' +
  'Yj4ke2VzYyh2LnBsYXRlKX08L2I+JHsKICAgICAgICAgIHYucGxhdGVfc3RhdGUgPyAnIDxzcGFuIGNsYXNzPSJzdWIiPicgKyBl' +
  'c2Modi5wbGF0ZV9zdGF0ZSkgKyAnPC9zcGFuPicgOiAnJ31gIDogJyd9CiAgICAgICAgICAke3YudmVoaWNsZSA/IGA8c3BhbiBj' +
  'bGFzcz0iJHt2LnBsYXRlID8gJ3N1YicgOiAnJ30iPiR7ZXNjKHYudmVoaWNsZSl9PC9zcGFuPmAgOiAnJ30KICAgICAgICAgIDxz' +
  'cGFuIGNsYXNzPSJzdWIiPsK3IHNlZW4gJHt2LnRpbWVzfcOXPC9zcGFuPjwvZGl2PgogICAgICAgICR7di52aW4gPyBgPGRpdiBj' +
  'bGFzcz0iaGludCI+VklOICR7ZXNjKHYudmluKX08L2Rpdj5gIDogJyd9CiAgICAgICAgJHt2LnBsYWNlcy5sZW5ndGggPiAxID8g' +
  'YDxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQpIj4KICAgICAgICAgIEF0ICR7di5wbGFjZXMubGVuZ3Ro' +
  'fSBkaWZmZXJlbnQgYWRkcmVzc2VzIOKAlCAke3YucGxhY2VzLm1hcChlc2MpLmpvaW4oJyDCtyAnKX08L2Rpdj5gCiAgICAgICAg' +
  'ICA6IHYucGxhY2VzLmxlbmd0aCA/IGA8ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyh2LnBsYWNlc1swXSl9PC9kaXY+YCA6ICcnfQog' +
  'ICAgICAgICR7di5wbGF0ZSA/IGA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjVweCI+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJi' +
  'dG4gc2VjIHNtIiBkYXRhLXBsYXRlPSIke2VzYyh2LnBsYXRlKX0iPlNlYXJjaCB0aGlzIHBsYXRlPC9idXR0b24+CiAgICAgICAg' +
  'PC9kaXY+YCA6ICcnfQogICAgICA8L2Rpdj5gKS5qb2luKCcnKX0KICAgIDwvZGl2PmAgOiAnJ30KCiAgICA8ZGl2IGNsYXNzPSJj' +
  'YXJkIj4KICAgICAgPGgyPkpvYnMgPHNwYW4gY2xhc3M9InN1YiI+JHtwLmpvYnMubGVuZ3RofTwvc3Bhbj48L2gyPgogICAgICAk' +
  'e3Auam9icy5tYXAoaiA9PiBgPGRpdiBzdHlsZT0icGFkZGluZzo4cHggMDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1s' +
  'aW5lKSI+CiAgICAgICAgPGRpdj48Yj4ke2VzYyhqLmpvYl9udW1iZXIgfHwgJycpfTwvYj4gPHNwYW4gY2xhc3M9InBpbGwiPiR7' +
  'ZXNjKGouc3RhdHVzKX08L3NwYW4+CiAgICAgICAgICAke2ouY2FzZV9udW1iZXIgPyBgPHNwYW4gY2xhc3M9InN1YiI+ICR7ZXNj' +
  'KGouY2FzZV9udW1iZXIpfTwvc3Bhbj5gIDogJyd9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGludCI+JHtlc2Moai5jbGll' +
  'bnRfbmFtZSB8fCAnbm8gY2xpZW50Jyl9JHsKICAgICAgICAgIGouYWRkcmVzcyA/ICcgwrcgJyArIGVzYyhqLmFkZHJlc3MpIDog' +
  'Jyd9PC9kaXY+CiAgICAgICAgJHtqLm5vdGVzID8gYDxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKGoubm90ZXMpfTwvZGl2PmAgOiAn' +
  'J30KICAgICAgPC9kaXY+YCkuam9pbignJyl9CiAgICA8L2Rpdj4KCiAgICAke3AudGltZWxpbmUubGVuZ3RoID8gYDxkaXYgY2xh' +
  'c3M9ImNhcmQiPgogICAgICA8aDI+RXZlcnkgYXR0ZW1wdCA8c3BhbiBjbGFzcz0ic3ViIj5uZXdlc3QgZmlyc3Q8L3NwYW4+PC9o' +
  'Mj4KICAgICAgJHtwLnRpbWVsaW5lLm1hcCh0ID0+IGA8ZGl2IHN0eWxlPSJwYWRkaW5nOjhweCAwO2JvcmRlci1ib3R0b206MXB4' +
  'IHNvbGlkIHZhcigtLWxpbmUpIj4KICAgICAgICA8ZGl2PiR7b3V0Y29tZVBpbGwodC5vdXRjb21lKX0gPHNwYW4gY2xhc3M9InN1' +
  'YiI+JHtmbXREVCh0LndoZW4pfSR7CiAgICAgICAgICB0LnNlcnZlciA/ICcgwrcgJyArIGVzYyh0LnNlcnZlcikgOiAnJ308L3Nw' +
  'YW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaGludCI+JHtlc2ModC5hZGRyZXNzIHx8ICcnKX08L2Rpdj4KICAgICAgICAk' +
  'e3QucGxhdGUgfHwgdC52ZWhpY2xlID8gYDxkaXYgY2xhc3M9ImhpbnQiPvCfmpcgJHsKICAgICAgICAgIHQucGxhdGUgPyAnPGI+' +
  'JyArIGVzYyh0LnBsYXRlKSArICc8L2I+JyA6ICcnfSR7CiAgICAgICAgICB0LnBsYXRlICYmIHQudmVoaWNsZSA/ICcgwrcgJyA6' +
  'ICcnfSR7ZXNjKHQudmVoaWNsZSB8fCAnJyl9PC9kaXY+YCA6ICcnfQogICAgICAgICR7dC5wZXJzb25fc2VydmVkID8gYDxkaXYg' +
  'Y2xhc3M9ImhpbnQiPlNwb2tlIHRvIDxiPiR7ZXNjKHQucGVyc29uX3NlcnZlZCl9PC9iPiR7CiAgICAgICAgICB0LnJlbGF0aW9u' +
  'c2hpcCA/ICcg4oCUICcgKyBlc2ModC5yZWxhdGlvbnNoaXApIDogJyd9PC9kaXY+YCA6ICcnfQogICAgICAgICR7dC5ub3RlcyA/' +
  'IGA8ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyh0Lm5vdGVzKX08L2Rpdj5gIDogJyd9CiAgICAgIDwvZGl2PmApLmpvaW4oJycpfQog' +
  'ICAgPC9kaXY+YCA6ICcnfQoKICAgIDxkaXYgY2xhc3M9ImNhcmQiIGlkPSJwdWJDYXJkIj4KICAgICAgPGgyPlB1YmxpYyByZWNv' +
  'cmRzIDxzcGFuIGNsYXNzPSJzdWIiIGlkPSJwdWJTdGF0dXMiPmxvb2tpbmfigKY8L3NwYW4+PC9oMj4KICAgICAgPGRpdiBpZD0i' +
  'cHViT3V0Ij48L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+TG9vayBmdXJ0aGVyPC9o' +
  'Mj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi1ib3R0b206MTBweCI+VGhlIGNvdW50eSBhcHByYWlzYWwg' +
  'cm9sbCBpcyB0aGUgb3RoZXIgZnJlZQogICAgICAgIHNvdXJjZSB3b3J0aCB0cnlpbmcg4oCUIGEgbWFpbGluZyBhZGRyZXNzIGRp' +
  'ZmZlcmVudCBmcm9tIHRoZSBwcm9wZXJ0eSBhZGRyZXNzIGlzIHRoZQogICAgICAgIHN0cm9uZ2VzdCBsZWFkIHRoZXJlIGlzLjwv' +
  'ZGl2PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJwQ291bnR5Ij5TZWFyY2ggdGhlIGNvdW50eSByb2xsIGZvciB0aGlz' +
  'IG5hbWU8L2J1dHRvbj4KICAgIDwvZGl2PmA7CgogIC8qIEZpcmVkIGFmdGVyIHRoZSBwYWdlIGlzIGFscmVhZHkgb24gc2NyZWVu' +
  'LCBuZXZlciBhd2FpdGVkIGJlZm9yZSBpdC4gRm91cgogICAgIGdvdmVybm1lbnQgc2VydmljZXMsIGFueSBvZiB3aGljaCBtYXkg' +
  'YmUgc2xvdyDigJQgdGhlIHBlcnNvbidzIG93biBoaXN0b3J5CiAgICAgbXVzdCBub3Qgd2FpdCBiZWhpbmQgdGhlbS4gKi8KICBs' +
  'b2FkUHVibGljKHsgbmFtZTogcC5uYW1lIH0pOwoKICAkKCcjcEJhY2snKS5vbmNsaWNrID0gKCkgPT4geyBGSU5ELnBlcnNvbiA9' +
  'IG51bGw7IGZpbmRWaWV3KCk7IH07CiAgJCgnI3BDb3VudHknKS5vbmNsaWNrID0gKCkgPT4gewogICAgUFJPUC5tb2RlID0gJ293' +
  'bmVyJzsKICAgIFBST1AucGVuZGluZyA9IHAubmFtZTsKICAgIHByb3BlcnR5VmlldygpOwogIH07CiAgZG9jdW1lbnQucXVlcnlT' +
  'ZWxlY3RvckFsbCgnW2RhdGEtcGxhdGVdJykuZm9yRWFjaChiID0+IGIub25jbGljayA9ICgpID0+IHsKICAgIEZJTkQudGFiID0g' +
  'J3BsYXRlJzsKICAgIEZJTkQucSA9IGIuZGF0YXNldC5wbGF0ZTsKICAgIEZJTkQucGVyc29uID0gbnVsbDsKICAgIGZpbmRWaWV3' +
  'KCk7CiAgICBzZXRUaW1lb3V0KHJ1bkZpbmQsIDApOwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWxv' +
  'b2t1cF0nKS5mb3JFYWNoKGIgPT4gYi5vbmNsaWNrID0gKCkgPT4gewogICAgRklORC50YWIgPSAnYWRkcmVzcyc7CiAgICBGSU5E' +
  'LnEgPSBiLmRhdGFzZXQubG9va3VwOwogICAgRklORC5wZXJzb24gPSBudWxsOwogICAgZmluZFZpZXcoKTsKICAgIHNldFRpbWVv' +
  'dXQocnVuRmluZCwgMCk7CiAgfSk7Cn0KCmZ1bmN0aW9uIHByb3BlcnR5VmlldygpIHsKICBjb25zdCBzcmMgPSBDQURbUFJPUC5r' +
  'ZXldOwogIGNvbnN0IGNpdHlPcHRzID0gWyc8b3B0aW9uIHZhbHVlPSIiPkFueSBjaXR5PC9vcHRpb24+J10KICAgIC5jb25jYXQo' +
  'T2JqZWN0LmtleXMoc3JjLmNpdGllcyB8fCB7fSkubWFwKGMgPT4gYDxvcHRpb24+JHtlc2MoYyl9PC9vcHRpb24+YCkpLmpvaW4o' +
  'JycpOwoKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5GaW5kPC9oMT4KCiAgICA8ZGl2IGNs' +
  'YXNzPSJjYXJkIj4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0iZ2FwOjZweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0i' +
  'YnRuIHNlYyBzbSIgZGF0YS1mdD0icGVvcGxlIj5QZXJzb248L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2Vj' +
  'IHNtIiBkYXRhLWZ0PSJhZGRyZXNzIj5BZGRyZXNzPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIg' +
  'ZGF0YS1mdD0icGxhdGUiPlBsYXRlPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBkYXRhLWZ0PSJwcm9w' +
  'ZXJ0eSI+UHJvcGVydHk8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgaWQ9InByb3BNb2RlIiBz' +
  'dHlsZT0iZ2FwOjZweDttYXJnaW4tdG9wOjEycHgiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biAke1BST1AubW9kZSA9PT0g' +
  'J2FkZHInID8gJycgOiAnc2VjICd9c20iIGRhdGEtbT0iYWRkciI+QnkgYWRkcmVzczwvYnV0dG9uPgogICAgICAgIDxidXR0b24g' +
  'Y2xhc3M9ImJ0biAke1BST1AubW9kZSA9PT0gJ293bmVyJyA/ICcnIDogJ3NlYyAnfXNtIiBkYXRhLW09Im93bmVyIj5CeSBvd25l' +
  'cjwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+' +
  'CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Db3VudHk8L2xhYmVsPjxzZWxlY3QgaWQ9InByb3BDb3VudHkiPgog' +
  'ICAgICAgICAgJHtPYmplY3Qua2V5cyhDQUQpLnNvcnQoKS5tYXAoayA9PiBgPG9wdGlvbiB2YWx1ZT0iJHtlc2Moayl9IiR7ayA9' +
  'PT0gUFJPUC5rZXkgPyAnIHNlbGVjdGVkJyA6ICcnfT4kewogICAgICAgICAgICBlc2Moay5zcGxpdCgnfCcpWzFdLnJlcGxhY2Uo' +
  'L1xiKFx3KShcdyopL2csIChtLCBhLCBiKSA9PiBhICsgYi50b0xvd2VyQ2FzZSgpKSl9IENvdW50eSwgVFg8L29wdGlvbj5gKS5q' +
  'b2luKCcnKX0KICAgICAgICA8L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkNpdHkgPHNw' +
  'YW4gY2xhc3M9InN1YiI+b3B0aW9uYWw8L3NwYW4+PC9sYWJlbD4KICAgICAgICAgIDxzZWxlY3QgaWQ9InByb3BDaXR5Ij4ke2Np' +
  'dHlPcHRzfTwvc2VsZWN0PjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbCBpZD0icHJv' +
  'cExhYmVsIj4ke1BST1AubW9kZSA9PT0gJ2FkZHInID8gJ0FkZHJlc3MnIDogJ093bmVyIG5hbWUnfTwvbGFiZWw+CiAgICAgICAg' +
  'PGlucHV0IGlkPSJwcm9wUSIgcGxhY2Vob2xkZXI9IiR7UFJPUC5tb2RlID09PSAnYWRkcicgPyAnMTgwNiBBc2ggQXZlJyA6ICdH' +
  'YXJ6YSd9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJwcm9w' +
  'R28iPlNlYXJjaDwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMiIGlkPSJwcm9wQ2xlYXIiPkNsZWFyPC9i' +
  'dXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8cCBjbGFzcz0iaGludCIgaWQ9InByb3BIaW50Ij48L3A+CiAgICA8L2Rpdj4KCiAg' +
  'ICA8ZGl2IGlkPSJwcm9wU3RhdHVzIj48L2Rpdj4KICAgIDxkaXYgaWQ9InByb3BPdXQiPjwvZGl2PgoKICAgIDxkaXYgY2xhc3M9' +
  'ImNhcmQiPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbjowIj5BIG1haWxpbmcgYWRkcmVzcyBmcm9tIHRoZSBh' +
  'cHByYWlzYWwgZGlzdHJpY3QgaXMgYSBsZWFkLCBub3QgcHJvb2Ygb2YKICAgICAgICByZXNpZGVuY2Ug4oCUIHBsZW50eSBvZiBv' +
  'd25lcnMgaGF2ZSBwb3N0IGdvaW5nIHRvIGFuIGFnZW50LCBhIHJlbGF0aXZlLCBvciBhbm90aGVyIHN0YXRlLiBUcmVhdCBpdCBh' +
  'cyBhCiAgICAgICAgcGxhY2UgdG8gYXR0ZW1wdCwgYW5kIHJlY29yZCB3aGF0IHlvdSBhY3R1YWxseSBmaW5kIGluIHRoZSBhdHRl' +
  'bXB0IG5vdGVzLjwvcD4KICAgIDwvZGl2PmApOwogIGJpbmRTaGVsbCgpOwoKICBjb25zdCBoaW50ID0gKCkgPT4gewogICAgY29u' +
  'c3QgcyA9IENBRFtQUk9QLmtleV07CiAgICAkKCcjcHJvcEhpbnQnKS5pbm5lckhUTUwgPSAoUFJPUC5tb2RlID09PSAnYWRkcicK' +
  'ICAgICAgPyAnU3RyZWV0IG51bWJlciBhbmQgbmFtZSBpcyBlbm91Z2gg4oCUIHRoZSBzdWZmaXggaXMgZHJvcHBlZCBiZWZvcmUg' +
  'c2VhcmNoaW5nLCBiZWNhdXNlIGV2ZXJ5IGNvdW50eSBzcGVsbHMgaXQgZGlmZmVyZW50bHkuJwogICAgICA6ICdBIHN1cm5hbWUg' +
  'YWxvbmUgd29ya3MgYW5kIGZpbmRzIGV2ZXJ5IHBhcmNlbCB0aGF0IG93bmVyIGhvbGRzIGluIHRoZSBjb3VudHkuIFJlY29yZHMg' +
  'YXJlIGZpbGVkIGxhc3QgbmFtZSBmaXJzdCwgc28gPGk+R2FyemE8L2k+IGJlYXRzIDxpPk1hcmlhIEdhcnphPC9pPi4nKQogICAg' +
  'ICArIChzLm5vdGUgPyAnIDxiPicgKyBlc2Mocy5ub3RlKSArICc8L2I+JyA6ICcnKTsKICB9OwogIGhpbnQoKTsKCiAgZG9jdW1l' +
  'bnQucXVlcnlTZWxlY3RvckFsbCgnI3Byb3BNb2RlIFtkYXRhLW1dJykuZm9yRWFjaChiID0+IGIub25jbGljayA9ICgpID0+IHsK' +
  'ICAgIFBST1AubW9kZSA9IGIuZGF0YXNldC5tOyBwcm9wZXJ0eVZpZXcoKTsKICB9KTsKICAkKCcjcHJvcENvdW50eScpLm9uY2hh' +
  'bmdlID0gKCkgPT4geyBQUk9QLmtleSA9ICQoJyNwcm9wQ291bnR5JykudmFsdWU7IHByb3BlcnR5VmlldygpOyB9OwogICQoJyNw' +
  'cm9wQ2xlYXInKS5vbmNsaWNrID0gKCkgPT4geyBQUk9QLnJlc3VsdHMgPSBbXTsgJCgnI3Byb3BPdXQnKS5pbm5lckhUTUwgPSAn' +
  'JzsgJCgnI3Byb3BTdGF0dXMnKS5pbm5lckhUTUwgPSAnJzsgJCgnI3Byb3BRJykudmFsdWUgPSAnJzsgfTsKICAkKCcjcHJvcFEn' +
  'KS5vbmtleWRvd24gPSBlID0+IHsgaWYgKGUua2V5ID09PSAnRW50ZXInKSB7IGUucHJldmVudERlZmF1bHQoKTsgJCgnI3Byb3BH' +
  'bycpLmNsaWNrKCk7IH0gfTsKICAkKCcjcHJvcEdvJykub25jbGljayA9ICgpID0+IHJ1blByb3BlcnR5U2VhcmNoKCQoJyNwcm9w' +
  'UScpLnZhbHVlLnRyaW0oKSwgJCgnI3Byb3BDaXR5JykudmFsdWUpOwoKICAvLyBDb21pbmcgaGVyZSBmcm9tIGEgcGVyc29uJ3Mg' +
  'cGFnZTogdGhlaXIgbmFtZSBpcyBhbHJlYWR5IHR5cGVkIGluLCBhbmQgdGhlCiAgLy8gc2VhcmNoIHJ1bnMgc28gdGhlIGFuc3dl' +
  'ciBpcyBvbiBzY3JlZW4gYnkgdGhlIHRpbWUgdGhleSBsb29rIHVwLgogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRh' +
  'LWZ0XScpLmZvckVhY2goYiA9PiBiLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBpZiAoYi5kYXRhc2V0LmZ0ID09PSAncHJvcGVydHkn' +
  'KSByZXR1cm47CiAgICBGSU5ELnRhYiA9IGIuZGF0YXNldC5mdDsKICAgIEZJTkQucmFuID0gZmFsc2U7CiAgICBGSU5ELnBlcnNv' +
  'biA9IG51bGw7CiAgICBmaW5kVmlldygpOwogIH0pOwogIGlmIChQUk9QLnBlbmRpbmcpIHsKICAgIGNvbnN0IG5hbWUgPSBQUk9Q' +
  'LnBlbmRpbmc7CiAgICBQUk9QLnBlbmRpbmcgPSBudWxsOwogICAgJCgnI3Byb3BRJykudmFsdWUgPSBuYW1lOwogICAgcnVuUHJv' +
  'cGVydHlTZWFyY2gobmFtZSwgJycpOwogICAgcmV0dXJuOwogIH0KICBpZiAoUFJPUC5yZXN1bHRzLmxlbmd0aCkgZHJhd1Byb3Bl' +
  'cnR5KCk7Cn0KCmFzeW5jIGZ1bmN0aW9uIHJ1blByb3BlcnR5U2VhcmNoKHJhdywgY2l0eSkgewogIGlmICghcmF3KSByZXR1cm4g' +
  'dG9hc3QoJ1R5cGUgc29tZXRoaW5nIHRvIGxvb2sgdXAnLCB0cnVlKTsKICBjb25zdCBzdGF0ID0gJCgnI3Byb3BTdGF0dXMnKTsK' +
  'ICBjb25zdCBzcmMgPSBDQURbUFJPUC5rZXldOwogIHN0YXQuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xh' +
  'c3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MCI+QXNraW5nICR7ZXNjKHNyYy5sYWJlbCl94oCmPC9kaXY+PC9kaXY+YDsKICAkKCcj' +
  'cHJvcE91dCcpLmlubmVySFRNTCA9ICcnOwogIHRyeSB7CiAgICBsZXQgcm93czsKICAgIHRyeSB7CiAgICAgIHJvd3MgPSBhd2Fp' +
  'dCBjYWRMb29rdXAoUFJPUC5rZXksIFBST1AubW9kZSwgcmF3LCBjaXR5KTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgLy8gQ2Ft' +
  'ZXJvbiBwdWJsaXNoZXMgdGhlIHNhbWUgcm9sbCB0d2ljZTsgaWYgdGhlIGZpcnN0IGlzIGRvd24sIHRyeSB0aGUgbWlycm9yLgog' +
  'ICAgICBpZiAoIXNyYy5hbHQpIHRocm93IGU7CiAgICAgIHJvd3MgPSBhd2FpdCBjYWRMb29rdXAoUFJPUC5rZXksIFBST1AubW9k' +
  'ZSwgcmF3LCBjaXR5LCBzcmMuYWx0KTsKICAgIH0KICAgIFBST1AucmVzdWx0cyA9IHJvd3M7CiAgICBzdGF0LmlubmVySFRNTCA9' +
  'IHJvd3MubGVuZ3RoCiAgICAgID8gYDxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MCI+' +
  'JHtyb3dzLmxlbmd0aH0gcmVjb3JkJHtyb3dzLmxlbmd0aCA9PT0gMSA/ICcnIDogJ3MnfSBmcm9tICR7ZXNjKHNyYy5sYWJlbCl9' +
  'PC9kaXY+PC9kaXY+YAogICAgICA6IGA8ZGl2IGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luOjAi' +
  'Pk5vdGhpbmcgbWF0Y2hlZCBpbiAke2VzYyhzcmMubGFiZWwpfS4gVHJ5IGZld2VyIHdvcmRzLCBvciBkcm9wIHRoZSBjaXR5Ljwv' +
  'ZGl2PjwvZGl2PmA7CiAgICBkcmF3UHJvcGVydHkoKTsKICB9IGNhdGNoIChlKSB7CiAgICBQUk9QLnJlc3VsdHMgPSBbXTsKICAg' +
  'IHN0YXQuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MDtjb2xv' +
  'cjp2YXIoLS1iYWQpIj5UaGUgY291bnR5IGRpZCBub3QgYW5zd2VyOiAke2VzYyhlLm1lc3NhZ2UpfTwvZGl2PjwvZGl2PmA7CiAg' +
  'ICAkKCcjcHJvcE91dCcpLmlubmVySFRNTCA9ICcnOwogIH0KfQoKZnVuY3Rpb24gZHJhd1Byb3BlcnR5KCkgewogIGNvbnN0IG91' +
  'dCA9ICQoJyNwcm9wT3V0Jyk7CiAgaWYgKCFvdXQpIHJldHVybjsKICBvdXQuaW5uZXJIVE1MID0gUFJPUC5yZXN1bHRzLm1hcCgo' +
  'ciwgaSkgPT4gewogICAgY29uc3QgTCA9IChrLCB2KSA9PiBgPHRyPjx0aCBzdHlsZT0id2lkdGg6MzglIj4ke2t9PC90aD48dGQ+' +
  'JHt2fTwvdGQ+PC90cj5gOwogICAgY29uc3QgZCA9IHIuZGVlZDsKICAgIGxldCBkZWVkTGluZSA9ICcnOwogICAgaWYgKGQpIHsK' +
  'ICAgICAgY29uc3QgYml0cyA9IFtdOwogICAgICBpZiAoZC5kYXRlKSBiaXRzLnB1c2goZXNjKGQuZGF0ZSkpOwogICAgICBpZiAo' +
  'ZC50eXBlKSBiaXRzLnB1c2goZXNjKGQudHlwZSkpOwogICAgICBpZiAoZC5udW0pIGJpdHMucHVzaCgnaW5zdC4gJyArIGVzYyhk' +
  'Lm51bSkpOwogICAgICBpZiAoZC52b2wgJiYgZC5wYWdlKSBiaXRzLnB1c2goJ3ZvbCAnICsgZXNjKGQudm9sKSArICcgcGcgJyAr' +
  'IGVzYyhkLnBhZ2UpKTsKICAgICAgZGVlZExpbmUgPSBiaXRzLmpvaW4oJyDCtyAnKTsKICAgIH0KICAgIGNvbnN0IGZ1bGwgPSBb' +
  'ci5hZGRyZXNzLCBbci5jaXR5LCByLnppcF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJyAnKV0uZmlsdGVyKEJvb2xlYW4pLmpvaW4o' +
  'JywgJyk7CiAgICByZXR1cm4gYDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+JHtlc2Moci5hZGRyZXNzKX08L2gyPgogICAg' +
  'ICA8ZGl2IGNsYXNzPSJtIiBzdHlsZT0iY29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxM3B4Ij4ke2VzYyhbci5jaXR5LCBy' +
  'LnppcF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJyAnKSl9PC9kaXY+CiAgICAgIDx0YWJsZSBjbGFzcz0idGJsIiBzdHlsZT0ibWFy' +
  'Z2luLXRvcDoxMHB4Ij4KICAgICAgICAke0woJ093bmVyJywgJzxiPicgKyBlc2Moci5vd25lciB8fCAn4oCUJykgKyAnPC9iPicp' +
  'fQogICAgICAgICR7ci5tYWlsID8gTCgnTWFpbHMgdG8nLCBlc2Moci5tYWlsKSkgOiAnJ30KICAgICAgICAke0woJ0xpdmVzIHRo' +
  'ZXJlPycsIHIuaG9tZXN0ZWFkCiAgICAgICAgICAgID8gJzxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS1vayk7Zm9udC13ZWlnaHQ6' +
  'NjAwIj5Ib21lc3RlYWQgb24gZmlsZSDigJQgb3duZXItb2NjdXBpZWQ8L3NwYW4+JwogICAgICAgICAgICA6ICdObyBob21lc3Rl' +
  'YWQgZXhlbXB0aW9uJyArIChyLm91dG9mdG93biA/ICcgwrcgPGI+bWFpbHMgb3V0IG9mIHRvd248L2I+JyA6ICcnKSl9CiAgICAg' +
  'ICAgJHtyLnllYXIgPyBMKCdCdWlsdCcsIHIueWVhcikgOiAnJ30KICAgICAgICAke3Iuc3FmdCA/IEwoJ1NpemUnLCBNYXRoLnJv' +
  'dW5kKHIuc3FmdCkudG9Mb2NhbGVTdHJpbmcoKSArICcgc3EgZnQnKSA6ICcnfQogICAgICAgICR7ci5sZWdhbCA/IEwoJ0xlZ2Fs' +
  'JywgZXNjKHIubGVnYWwpKSA6ICcnfQogICAgICAgICR7ci5nZW8gPyBMKCdHZW9ncmFwaGljIElEJywgZXNjKHIuZ2VvKSkgOiAn' +
  'J30KICAgICAgICAke2RlZWRMaW5lID8gTCgnTGFzdCBkZWVkJywgZGVlZExpbmUpIDogJyd9CiAgICAgIDwvdGFibGU+CiAgICAg' +
  'IDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBz' +
  'bSIgZGF0YS1wY29weT0iJHtlc2MoZnVsbCl9Ij5Db3B5IGFkZHJlc3M8L2J1dHRvbj4KICAgICAgICAke3IubWFpbCA/IGA8YnV0' +
  'dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBkYXRhLXBjb3B5PSIke2VzYyhyLm1haWwpfSI+Q29weSBtYWlsaW5nIGFkZHJlc3M8L2J1' +
  'dHRvbj5gIDogJyd9CiAgICAgICAgJHtyLm93bmVyID8gYDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGRhdGEtcG93bmVyPSIk' +
  'e2VzYyhvd25lclF1ZXJ5KHIub3duZXIpKX0iPk1vcmUgYnkgdGhpcyBvd25lcjwvYnV0dG9uPmAgOiAnJ30KICAgICAgICAke3Iu' +
  'bGF0ICE9IG51bGwgPyBgPGEgY2xhc3M9ImJ0biBzZWMgc20iIHRhcmdldD0iX2JsYW5rIgogICAgICAgICAgIGhyZWY9Imh0dHBz' +
  'Oi8vd3d3Lmdvb2dsZS5jb20vbWFwcy9zZWFyY2gvP2FwaT0xJnF1ZXJ5PSR7ci5sYXR9LCR7ci5sb259Ij5NYXA8L2E+YCA6ICcn' +
  'fQogICAgICAgICR7ci5saW5rID8gYDxhIGNsYXNzPSJidG4gc2VjIHNtIiB0YXJnZXQ9Il9ibGFuayIgaHJlZj0iJHtlc2Moci5s' +
  'aW5rKX0iPkNvdW50eSByZWNvcmQg4oaXPC9hPmAgOiAnJ30KICAgICAgICAke3Iub3duZXIgPyBgPGEgY2xhc3M9ImJ0biBzZWMg' +
  'c20iIHRhcmdldD0iX2JsYW5rIgogICAgICAgICAgIGhyZWY9IiR7ZXNjKGNsZXJrU2VhcmNoKFBST1Aua2V5LCAoZCAmJiBkLm51' +
  'bSkgPyBkLm51bSA6IG93bmVyUXVlcnkoci5vd25lcikpKX0iPkRlZWRzICZhbXA7IGxpZW5zIOKGlzwvYT5gIDogJyd9CiAgICAg' +
  'IDwvZGl2PgogICAgPC9kaXY+YDsKICB9KS5qb2luKCcnKTsKCiAgb3V0LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXBjb3B5XScp' +
  'LmZvckVhY2goYiA9PiBiLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgeyBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJk' +
  'LndyaXRlVGV4dChiLmRhdGFzZXQucGNvcHkpOyB0b2FzdCgnQ29waWVkJyk7IH0KICAgIGNhdGNoIChlKSB7IHRvYXN0KCdDb3B5' +
  'IGZhaWxlZCDigJQgc2VsZWN0IGl0IGJ5IGhhbmQnLCB0cnVlKTsgfQogIH0pOwogIG91dC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0' +
  'YS1wb3duZXJdJykuZm9yRWFjaChiID0+IGIub25jbGljayA9ICgpID0+IHsKICAgIFBST1AubW9kZSA9ICdvd25lcic7CiAgICBw' +
  'cm9wZXJ0eVZpZXcoKTsKICAgICQoJyNwcm9wUScpLnZhbHVlID0gYi5kYXRhc2V0LnBvd25lcjsKICAgIHJ1blByb3BlcnR5U2Vh' +
  'cmNoKGIuZGF0YXNldC5wb3duZXIsICcnKTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0gY2FzZSBsb29rdXAgLS0gKi8KLyogTm9uZSBvZiB0aGVzZSBwb3J0YWxzIGFjY2VwdCBhIGNh' +
  'c2UgbnVtYmVyIGluIHRoZSBVUkwgLS0gSGlkYWxnbydzIHJ1bnMgb24KICAgc2Vzc2lvbi1iYXNlZCBmb3JtIHBvc3RzLCBDYW1l' +
  'cm9uJ3Mgc2l0cyBiZWhpbmQgYSBKYXZhU2NyaXB0IGdhdGUuIFNvIHRoaXMKICAgY29waWVzIHRoZSBudW1iZXIgdG8gdGhlIGNs' +
  'aXBib2FyZCBhbmQgb3BlbnMgdGhlIHJpZ2h0IHNlYXJjaCBwYWdlLiBObwogICBzY3JhcGluZywgbm90aGluZyB0byBicmVhayB3' +
  'aGVuIHRoZXkgcmVkZXNpZ24uICovCmNvbnN0IFRYX1BPUlRBTFMgPSBbCiAgeyBuYW1lOiAncmU6U2VhcmNoVFgg4oCUIHN0YXRl' +
  'd2lkZScsIHVybDogJ2h0dHBzOi8vcmVzZWFyY2gudHhjb3VydHMuZ292LycsCiAgICBub3RlOiAnRnJlZSBhY2NvdW50IHJlcXVp' +
  'cmVkLiBEaXN0cmljdCwgY291bnR5IGFuZCBwcm9iYXRlIGNvdXJ0cyBpbiBhbGwgMjU0IGNvdW50aWVzLiAnICsKICAgICAgICAg' +
  'ICdQdWJsaWMgdmlldyBzdGFydHMgYXQgZmlsaW5ncyBmcm9tIDEgTm92IDIwMTguIEp1c3RpY2Utb2YtdGhlLXBlYWNlIGV2aWN0' +
  'aW9ucyBhcmUgcGF0Y2h5LicgfSwKICB7IG5hbWU6ICdIaWRhbGdvIENvdW50eSDigJQgRGlzdHJpY3QgQ2xlcmsgY2FzZSBzZWFy' +
  'Y2gnLCB1cmw6ICdodHRwczovL3BhLmNvLmhpZGFsZ28udHgudXMvZGVmYXVsdC5hc3B4JywKICAgIG5vdGU6ICdDaXZpbCBhbmQg' +
  'Y3JpbWluYWwgY2FzZXMuIEZyZWUsIG5vIGxvZ2luLicgfSwKICB7IG5hbWU6ICdDYW1lcm9uIENvdW50eSDigJQgY291cnQgcG9y' +
  'dGFscycsIHVybDogJ2h0dHBzOi8vd3d3LmNhbWVyb25jb3VudHl0eC5nb3YvY2FtZXJvbi1jb3VudHktcG9ydGFscy8nLAogICAg' +
  'bm90ZTogJ0luZGV4IHBhZ2UgZm9yIHRoZSBjb3VudHlcJ3MgZGlzdHJpY3QgYW5kIGNvdW50eSBjbGVyayBzZWFyY2hlcy4nIH0s' +
  'CiAgeyBuYW1lOiAnQ2FtZXJvbiBDb3VudHkg4oCUIERpc3RyaWN0IENsZXJrIHJlY29yZHMnLCB1cmw6ICdodHRwczovL2tvZmls' +
  'ZXF1aWNrbGlua3MuY29tL2NhbWVyb25kYy8nLAogICAgbm90ZTogJ0Rpc3RyaWN0IENsZXJrIHJlY29yZCBzZWFyY2guJyB9LAog' +
  'IHsgbmFtZTogJ0hpZGFsZ28gQ291bnR5IOKAlCBwcm9wZXJ0eSAvIG9mZmljaWFsIHJlY29yZHMnLCB1cmw6ICdodHRwczovL2hp' +
  'ZGFsZ28udHgucHVibGljc2VhcmNoLnVzLycsCiAgICBub3RlOiAnRGVlZHMsIGxpZW5zIGFuZCBvd25lcnNoaXAgZnJvbSB0aGUg' +
  'Q291bnR5IENsZXJrIOKAlCBwcm9wZXJ0eSwgbm90IGxhd3N1aXRzLiAnICsKICAgICAgICAgICdVc2VmdWwgZm9yIGNvbmZpcm1p' +
  'bmcgd2hvIGFjdHVhbGx5IG93bnMgYW4gYWRkcmVzcy4nIH0KXTsKCmZ1bmN0aW9uIGNhc2VMb29rdXBTaGVldChqb2IpIHsKICBz' +
  'aGVldCgnTG9vayB1cCAnICsgam9iLmNhc2VfbnVtYmVyLCBgCiAgICA8ZGl2IGNsYXNzPSJjYXJkIiBzdHlsZT0iYmFja2dyb3Vu' +
  'ZDojZjhmYWZjO2JveC1zaGFkb3c6bm9uZTt0ZXh0LWFsaWduOmNlbnRlciI+CiAgICAgIDxkaXYgc3R5bGU9ImZvbnQ6NjAwIDIw' +
  'cHgvMS4zIG1vbm9zcGFjZTtsZXR0ZXItc3BhY2luZzouNXB4Ij4ke2VzYyhqb2IuY2FzZV9udW1iZXIpfTwvZGl2PgogICAgICA8' +
  'ZGl2IGNsYXNzPSJoaW50Ij4ke2VzYyhqb2IuY291cnQgfHwgJ2NvdXJ0IG5vdCByZWNvcmRlZCcpfTwvZGl2PgogICAgICA8YnV0' +
  'dG9uIGNsYXNzPSJidG4gc20iIGlkPSJjb3B5Q2FzZSIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+Q29weSBjYXNlIG51bWJlcjwv' +
  'YnV0dG9uPgogICAgPC9kaXY+CiAgICA8cCBjbGFzcz0iaGludCI+VGhlc2UgcG9ydGFscyBjYW4ndCBiZSBsaW5rZWQgdG8gZGly' +
  'ZWN0bHkgd2l0aCBhIGNhc2UgbnVtYmVyLCBzbyB0YXBwaW5nIG9uZSBjb3BpZXMKICAgICAgdGhlIG51bWJlciBhbmQgb3BlbnMg' +
  'dGhlaXIgc2VhcmNoIHBhZ2Ug4oCUIHBhc3RlIGl0IGludG8gdGhlaXIgYm94LjwvcD4KICAgIDxkaXYgY2xhc3M9Imxpc3QiPgog' +
  'ICAgICAke1RYX1BPUlRBTFMubWFwKChwLCBpKSA9PiBgCiAgICAgICAgPGRpdiBjbGFzcz0iaXRlbSIgZGF0YS1wb3J0YWw9IiR7' +
  'aX0iPgogICAgICAgICAgPGRpdiBjbGFzcz0idCI+JHtlc2MocC5uYW1lKX08L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9Im0i' +
  'PiR7ZXNjKHAubm90ZSl9PC9kaXY+CiAgICAgICAgPC9kaXY+YCkuam9pbignJyl9CiAgICA8L2Rpdj4KICAgIDxwIGNsYXNzPSJo' +
  'aW50IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij5Db3VydCByZWNvcmRzIHJhcmVseSBwdWJsaXNoIGEgZGVmZW5kYW50J3Mgc2Vy' +
  'dmljZSBhZGRyZXNzIOKAlAogICAgICB0aGF0IG5vcm1hbGx5IG9ubHkgZXhpc3RzIG9uIHRoZSBjbGllbnQncyBwYWNrZXQuPC9w' +
  'PgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBibG9jayIgc3R5bGU9Im1hcmdpbi10b3A6OHB4IiBvbmNsaWNrPSJjbG9zZVNo' +
  'ZWV0KCkiPkNsb3NlPC9idXR0b24+YCwgZWwgPT4gewogICAgY29uc3QgY29weSA9IGFzeW5jICgpID0+IHsKICAgICAgdHJ5IHsg' +
  'YXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoam9iLmNhc2VfbnVtYmVyKTsgcmV0dXJuIHRydWU7IH0KICAgICAg' +
  'Y2F0Y2ggKGUpIHsgcmV0dXJuIGZhbHNlOyB9CiAgICB9OwogICAgZWwucXVlcnlTZWxlY3RvcignI2NvcHlDYXNlJykub25jbGlj' +
  'ayA9IGFzeW5jICgpID0+CiAgICAgIHRvYXN0KGF3YWl0IGNvcHkoKSA/ICdDb3BpZWQgJyArIGpvYi5jYXNlX251bWJlciA6ICdD' +
  'b3B5IGZhaWxlZCDigJQgc2VsZWN0IGl0IGJ5IGhhbmQnLCBmYWxzZSk7CiAgICBlbC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1w' +
  'b3J0YWxdJykuZm9yRWFjaChyb3cgPT4gcm93Lm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGNvbnN0IHAgPSBUWF9QT1JU' +
  'QUxTWytyb3cuZGF0YXNldC5wb3J0YWxdOwogICAgICBjb25zdCBvayA9IGF3YWl0IGNvcHkoKTsKICAgICAgdG9hc3Qob2sgPyAn' +
  'Q2FzZSBudW1iZXIgY29waWVkIOKAlCBwYXN0ZSBpdCBpbnRvIHRoZWlyIHNlYXJjaCcgOiAnT3BlbmluZyAnICsgcC5uYW1lKTsK' +
  'ICAgICAgd2luZG93Lm9wZW4ocC51cmwsICdfYmxhbmsnKTsKICAgIH0pOwogIH0pOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gc2NhbiAtLSAqLwpmdW5jdGlvbiBzY2FuVmlldygp' +
  'IHsKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5TY2FuIGEgcGFja2V0PC9oMT4KICAgIDxk' +
  'aXYgY2xhc3M9ImNhcmQiPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6MCI+UG9pbnQgdGhlIGNhbWVy' +
  'YSBhdCB0aGUgYmFyY29kZSBvbiB0aGUgY292ZXIgc2hlZXQgdG8gb3BlbiB0aGF0IGpvYi4gSWYgdGhlIGNhbWVyYQogICAgICB3' +
  'b24ndCBjb29wZXJhdGUsIHR5cGUgdGhlIGpvYiBudW1iZXIgaW5zdGVhZCDigJQgaXQgd29ya3MgdGhlIHNhbWUuPC9wPgogICAg' +
  'ICA8ZGl2IGlkPSJyZWFkZXIiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEycHgiPgog' +
  'ICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InN0YXJ0U2NhbiI+U3RhcnQgY2FtZXJhPC9idXR0b24+CiAgICAgICAgPGJ1' +
  'dHRvbiBjbGFzcz0iYnRuIHNlYyIgaWQ9InN0b3BTY2FuQnRuIiBzdHlsZT0iZGlzcGxheTpub25lIj5TdG9wPC9idXR0b24+CiAg' +
  'ICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBpZD0ic2Nhbk1zZyI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYg' +
  'Y2xhc3M9ImNhcmQiPgogICAgICA8aDI+RW50ZXIgam9iIG51bWJlcjwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InJvdyI+CiAgICAg' +
  'ICAgPGlucHV0IGlkPSJtYW51YWwiIHBsYWNlaG9sZGVyPSJTVC0xMDAwMSIgc3R5bGU9ImZsZXg6MTt0ZXh0LXRyYW5zZm9ybTp1' +
  'cHBlcmNhc2UiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9Im1hbnVhbEdvIj5PcGVuPC9idXR0b24+CiAgICAgIDwv' +
  'ZGl2PgogICAgPC9kaXY+YCk7CiAgYmluZFNoZWxsKCk7CgogIGNvbnN0IG9wZW4gPSBhc3luYyBjb2RlID0+IHsKICAgIHRyeSB7' +
  'CiAgICAgIGNvbnN0IGogPSBhd2FpdCBhcGkoJy9sb29rdXAvJyArIGVuY29kZVVSSUNvbXBvbmVudChjb2RlKSk7CiAgICAgIGlm' +
  'ICh3aW5kb3cuX19zdG9wU2NhbikgeyB3aW5kb3cuX19zdG9wU2NhbigpOyB3aW5kb3cuX19zdG9wU2NhbiA9IG51bGw7IH0KICAg' +
  'ICAgdG9hc3QoJ09wZW5pbmcgJyArIGouam9iX251bWJlcik7CiAgICAgIGdvKCdqb2InLCB7IGlkOiBqLmlkIH0pOwogICAgfSBj' +
  'YXRjaCAoZSkgeyAkKCcjc2Nhbk1zZycpLnRleHRDb250ZW50ID0gZS5tZXNzYWdlOyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9' +
  'CiAgfTsKCiAgJCgnI21hbnVhbEdvJykub25jbGljayA9ICgpID0+IHsgY29uc3QgdiA9ICQoJyNtYW51YWwnKS52YWx1ZS50cmlt' +
  'KCk7IGlmICh2KSBvcGVuKHYpOyB9OwogICQoJyNtYW51YWwnKS5vbmtleWRvd24gPSBlID0+IHsgaWYgKGUua2V5ID09PSAnRW50' +
  'ZXInKSAkKCcjbWFudWFsR28nKS5jbGljaygpOyB9OwoKICAkKCcjc3RhcnRTY2FuJykub25jbGljayA9IGFzeW5jICgpID0+IHsK' +
  'ICAgIGNvbnN0IG1zZyA9ICQoJyNzY2FuTXNnJyk7CiAgICBpZiAoIXdpbmRvdy5aWGluZykgcmV0dXJuIG1zZy50ZXh0Q29udGVu' +
  'dCA9ICdTY2FubmVyIGxpYnJhcnkgZGlkIG5vdCBsb2FkIOKAlCB1c2UgdGhlIGpvYiBudW1iZXIgYm94IGJlbG93Lic7CiAgICB0' +
  'cnkgewogICAgICBjb25zdCByZWFkZXIgPSBuZXcgWlhpbmcuQnJvd3Nlck11bHRpRm9ybWF0UmVhZGVyKCk7CiAgICAgIGNvbnN0' +
  'IHZpZGVvID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndmlkZW8nKTsKICAgICAgdmlkZW8uc2V0QXR0cmlidXRlKCdwbGF5c2lu' +
  'bGluZScsICd0cnVlJyk7CiAgICAgICQoJyNyZWFkZXInKS5pbm5lckhUTUwgPSAnJzsKICAgICAgJCgnI3JlYWRlcicpLmFwcGVu' +
  'ZENoaWxkKHZpZGVvKTsKICAgICAgJCgnI3N0YXJ0U2NhbicpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgICAgICQoJyNzdG9w' +
  'U2NhbkJ0bicpLnN0eWxlLmRpc3BsYXkgPSAnJzsKICAgICAgbXNnLnRleHRDb250ZW50ID0gJ0xvb2tpbmcgZm9yIGEgYmFyY29k' +
  'ZeKApic7CiAgICAgIGxldCBoYW5kbGVkID0gZmFsc2U7CiAgICAgIGF3YWl0IHJlYWRlci5kZWNvZGVGcm9tQ29uc3RyYWludHMo' +
  'CiAgICAgICAgeyB2aWRlbzogeyBmYWNpbmdNb2RlOiAnZW52aXJvbm1lbnQnIH0gfSwgdmlkZW8sCiAgICAgICAgKHJlc3VsdCkg' +
  'PT4geyBpZiAocmVzdWx0ICYmICFoYW5kbGVkKSB7IGhhbmRsZWQgPSB0cnVlOyBvcGVuKHJlc3VsdC5nZXRUZXh0KCkpOyB9IH0p' +
  'OwogICAgICB3aW5kb3cuX19zdG9wU2NhbiA9ICgpID0+IHsKICAgICAgICB0cnkgeyByZWFkZXIucmVzZXQoKTsgfSBjYXRjaCAo' +
  'ZSkge30KICAgICAgICAkKCcjcmVhZGVyJykuaW5uZXJIVE1MID0gJyc7CiAgICAgICAgY29uc3QgcyA9ICQoJyNzdGFydFNjYW4n' +
  'KSwgc3QgPSAkKCcjc3RvcFNjYW5CdG4nKTsKICAgICAgICBpZiAocykgcy5zdHlsZS5kaXNwbGF5ID0gJyc7CiAgICAgICAgaWYg' +
  'KHN0KSBzdC5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogICAgICB9OwogICAgICAkKCcjc3RvcFNjYW5CdG4nKS5vbmNsaWNrID0g' +
  'KCkgPT4geyB3aW5kb3cuX19zdG9wU2NhbigpOyB3aW5kb3cuX19zdG9wU2NhbiA9IG51bGw7IG1zZy50ZXh0Q29udGVudCA9ICcn' +
  'OyB9OwogICAgfSBjYXRjaCAoZSkgewogICAgICBtc2cudGV4dENvbnRlbnQgPSAnQ2FtZXJhIHVuYXZhaWxhYmxlICgnICsgZS5t' +
  'ZXNzYWdlICsgJykuIFVzZSB0aGUgam9iIG51bWJlciBib3ggYmVsb3cuJzsKICAgICAgJCgnI3N0YXJ0U2NhbicpLnN0eWxlLmRp' +
  'c3BsYXkgPSAnJzsKICAgICAgJCgnI3N0b3BTY2FuQnRuJykuc3R5bGUuZGlzcGxheSA9ICdub25lJzsKICAgIH0KICB9Owp9Cgov' +
  'KiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSBtb25leSAtLSAq' +
  'Lwphc3luYyBmdW5jdGlvbiBtb25leVZpZXcoKSB7CiAgaWYgKCFpc0FkbWluKCkpIHJldHVybiBteVBheVZpZXcoKTsKICBjb25z' +
  'dCBbc3RhdGVtZW50cywgaW52b2ljZXMsIHVzZXJzLCBjbGllbnRzLCBhcl0gPSBhd2FpdCBQcm9taXNlLmFsbCgKICAgIFthcGko' +
  'Jy9zdGF0ZW1lbnRzJyksIGFwaSgnL2ludm9pY2VzJyksIGFwaSgnL3VzZXJzJyksIGFwaSgnL2NsaWVudHMnKSwgYXBpKCcvcmVj' +
  'ZWl2YWJsZXMnKV0pOwoKICAvKiBNb25leSBvd2VkLCBvbGRlc3QgZmlyc3QuICJVbmJpbGxlZCIgaXMgZGVsaWJlcmF0ZWx5IG5v' +
  'dCBwYXJ0IG9mIHRoZQogICAgIHRvdGFsIOKAlCB0aGF0IGlzIHdvcmsgeW91IGhhdmUgbm90IGFza2VkIHRvIGJlIHBhaWQgZm9y' +
  'IHlldCwgd2hpY2ggaXMgYQogICAgIGRpZmZlcmVudCBwcm9ibGVtIGZyb20gYSBmaXJtIHRoYXQgaXMgc2xvdyB0byBwYXkuICov' +
  'CiAgY29uc3Qgb3dlZCA9IGFyLmNsaWVudHMuZmlsdGVyKGMgPT4gTnVtYmVyKGMuYmFsYW5jZSkgPiAwKTsKICBjb25zdCBidWNr' +
  'ZXQgPSAodiwgd2FybikgPT4gYDxkaXYgY2xhc3M9InN0YXQke3YgPiAwICYmIHdhcm4gPyAnIGJhZCcgOiAnJ30iIHN0eWxlPSJm' +
  'bGV4OjEiPgogICAgICA8ZGl2IGNsYXNzPSJuIiBzdHlsZT0iZm9udC1zaXplOjE2cHgiPiR7bW9uZXkodil9PC9kaXY+PGRpdiBj' +
  'bGFzcz0ibCI+JHt3YXJuIHx8ICdDdXJyZW50J308L2Rpdj48L2Rpdj5gOwoKICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAg' +
  'PGgxIGNsYXNzPSJwYWdlIj5CaWxsaW5nICZhbXA7IHBheTwvaDE+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5P' +
  'dXRzdGFuZGluZyA8c3BhbiBjbGFzcz0ic3ViIj53aGF0IHlvdXIgYXR0b3JuZXlzIG93ZSB5b3U8L3NwYW4+PC9oMj4KICAgICAg' +
  'PGRpdiBjbGFzcz0ic3RhdCBiaWciIHN0eWxlPSJtYXJnaW4tdG9wOjZweCI+CiAgICAgICAgPGRpdiBjbGFzcz0ibiI+JHttb25l' +
  'eShhci50b3RhbCl9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibCI+JHtvd2VkLmxlbmd0aCA/IG93ZWQubGVuZ3RoICsgJyBm' +
  'aXJtJyArIChvd2VkLmxlbmd0aCA9PT0gMSA/ICcnIDogJ3MnKSArICcgd2l0aCBhIGJhbGFuY2UnCiAgICAgICAgICA6ICdFdmVy' +
  'eW9uZSBpcyBwYWlkIHVwJ308L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgICR7YXIudG90YWwgPiAwID8gYDxkaXYgY2xhc3M9InJv' +
  'dyIgc3R5bGU9ImdhcDo2cHg7bWFyZ2luLXRvcDoxMHB4Ij4KICAgICAgICAke2J1Y2tldChhci5idWNrZXRzLmQwKX0ke2J1Y2tl' +
  'dChhci5idWNrZXRzLmQzMCwgJzMwKyBkYXlzJyl9CiAgICAgICAgJHtidWNrZXQoYXIuYnVja2V0cy5kNjAsICc2MCsgZGF5cycp' +
  'fSR7YnVja2V0KGFyLmJ1Y2tldHMuZDkwLCAnOTArIGRheXMnKX0KICAgICAgPC9kaXY+YCA6ICcnfQogICAgICAke293ZWQubGVu' +
  'Z3RoID8gYDx0YWJsZSBjbGFzcz0idGJsIiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij4KICAgICAgICA8dHI+PHRoPkF0dG9ybmV5' +
  'PC90aD48dGggY2xhc3M9Im51bSI+T3dlZDwvdGg+PHRoIGNsYXNzPSJudW0iPk9sZGVzdDwvdGg+PHRoPjwvdGg+PC90cj4KICAg' +
  'ICAgICAke293ZWQubWFwKGMgPT4gewogICAgICAgICAgY29uc3QgYWdlID0gTWF0aC5mbG9vcigoRGF0ZS5ub3coKSAtIG5ldyBE' +
  'YXRlKGMub2xkZXN0X2ludm9pY2UpLmdldFRpbWUoKSkgLyA4NjRlNSk7CiAgICAgICAgICByZXR1cm4gYDx0cj4KICAgICAgICAg' +
  'ICAgPHRkPiR7ZXNjKGMuY2xpZW50X25hbWUpfTxkaXYgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW46MCI+JHtjLmludm9pY2Vf' +
  'Y291bnR9IGludm9pY2UkewogICAgICAgICAgICAgIGMuaW52b2ljZV9jb3VudCA9PT0gMSA/ICcnIDogJ3MnfTwvZGl2PjwvdGQ+' +
  'CiAgICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KGMuYmFsYW5jZSl9PC90ZD4KICAgICAgICAgICAgPHRkIGNsYXNz' +
  'PSJudW0iJHthZ2UgPj0gNjAgPyAnIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQpO2ZvbnQtd2VpZ2h0OjcwMCInIDogJyd9PiR7YWdl' +
  'fWQ8L3RkPgogICAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iL3ByaW50L2FjY291bnQvJHtjLmNsaWVudF9pZH0i' +
  'IHRhcmdldD0iX2JsYW5rIj5zdGF0ZW1lbnQ8L2E+PC90ZD4KICAgICAgICAgIDwvdHI+YDsKICAgICAgICB9KS5qb2luKCcnKX08' +
  'L3RhYmxlPmAgOiAnJ30KICAgICAgJHthci51bmJpbGxlZCA+IDAgPyBgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10' +
  'b3A6MTJweCI+U2VwYXJhdGVseSwgPGI+JHttb25leShhci51bmJpbGxlZCl9PC9iPgogICAgICAgIG9mIHNlcnZlZCB3b3JrIGhh' +
  'cyBub3QgYmVlbiBwdXQgb24gYW4gaW52b2ljZSB5ZXQg4oCUIHRoYXQgaXMgbW9uZXkgeW91IGhhdmUgbm90IGFza2VkIGZvci48' +
  'L2Rpdj5gIDogJyd9CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkNvbnRyYWN0b3Igc3RhdGVt' +
  'ZW50cyA8c3BhbiBjbGFzcz0ic3ViIj53aGF0IHlvdSBvd2UgeW91ciBzZXJ2ZXJzPC9zcGFuPjwvaDI+CiAgICAgIDxwIGNsYXNz' +
  'PSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDotNHB4Ij5QdWxscyBldmVyeSBjb21wbGV0ZWQgc2VydmUgaW4gdGhlIHBlcmlvZCB0' +
  'aGF0IGhhc24ndCBiZWVuIHBhaWQgb3V0IHlldCwgYXQgdGhlCiAgICAgIHBlci1qb2IgcmF0ZSBvbiB0aGUgam9iLiBOb3RoaW5n' +
  'IGdldHMgY291bnRlZCB0d2ljZS48L3A+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgi' +
  'PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U2VydmVyPC9sYWJlbD48c2VsZWN0IGlkPSJzX3NlcnZlciI+CiAg' +
  'ICAgICAgICAke3VzZXJzLmZpbHRlcih1ID0+IHUuYWN0aXZlKS5tYXAodSA9PiBgPG9wdGlvbiB2YWx1ZT0iJHt1LmlkfSI+JHtl' +
  'c2ModS5uYW1lKX08L29wdGlvbj5gKS5qb2luKCcnKX08L3NlbGVjdD48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0' +
  'eWxlPSJhbGlnbi1pdGVtczpmbGV4LWVuZDtnYXA6NnB4Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0iZmxl' +
  'eDoxO21hcmdpbjowIj48bGFiZWw+RnJvbTwvbGFiZWw+PGlucHV0IHR5cGU9ImRhdGUiIGlkPSJzX3N0YXJ0IiB2YWx1ZT0iJHtm' +
  'aXJzdE9mTW9udGgoKX0iPjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJmbGV4OjE7bWFyZ2luOjAi' +
  'PjxsYWJlbD5UbzwvbGFiZWw+PGlucHV0IHR5cGU9ImRhdGUiIGlkPSJzX2VuZCIgdmFsdWU9IiR7dG9kYXlJU08oKX0iPjwvZGl2' +
  'PgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgi' +
  'PgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20iIGlkPSJzX3ByZXYiPlByZXZpZXc8L2J1dHRvbj4KICAgICAgICA8' +
  'YnV0dG9uIGNsYXNzPSJidG4gc20iIGlkPSJzX21ha2UiPkNyZWF0ZSBzdGF0ZW1lbnQ8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAg' +
  'ICAgIDxkaXYgaWQ9InNfb3V0Ij48L2Rpdj4KICAgICAgJHtzdGF0ZW1lbnRzLmxlbmd0aCA/IGA8dGFibGUgY2xhc3M9InRibCIg' +
  'c3R5bGU9Im1hcmdpbi10b3A6MTRweCI+CiAgICAgICAgPHRyPjx0aD5TZXJ2ZXI8L3RoPjx0aD5QZXJpb2Q8L3RoPjx0aCBjbGFz' +
  'cz0ibnVtIj5Kb2JzPC90aD48dGggY2xhc3M9Im51bSI+VG90YWw8L3RoPjx0aD48L3RoPjx0aD48L3RoPjwvdHI+CiAgICAgICAg' +
  'JHtzdGF0ZW1lbnRzLm1hcChzID0+IGA8dHI+CiAgICAgICAgICA8dGQ+JHtlc2Mocy5zZXJ2ZXJfbmFtZSl9PC90ZD48dGQ+JHtm' +
  'bXREYXRlT25seShzLnBlcmlvZF9zdGFydCl94oCTJHtmbXREYXRlT25seShzLnBlcmlvZF9lbmQpfTwvdGQ+CiAgICAgICAgICA8' +
  'dGQgY2xhc3M9Im51bSI+JHtzLmpvYl9jb3VudH08L3RkPjx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KHMudG90YWwpfTwvdGQ+CiAg' +
  'ICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9InBpbGwgJHtjbHMocy5zdGF0dXMpfSI+JHtlc2Mocy5zdGF0dXMpfTwvc3Bhbj48L3Rk' +
  'PgogICAgICAgICAgPHRkIGNsYXNzPSJudW0iPjxhIGhyZWY9Ii9wcmludC9zdGF0ZW1lbnQvJHtzLmlkfSIgdGFyZ2V0PSJfYmxh' +
  'bmsiPnByaW50PC9hPgogICAgICAgICAgICAke3Muc3RhdHVzICE9PSAnUGFpZCcgPyBgIMK3IDxhIGhyZWY9IiMiIGRhdGEtcGFp' +
  'ZD0iJHtzLmlkfSI+bWFyayBwYWlkPC9hPmAgOiAnJ308L3RkPgogICAgICAgIDwvdHI+YCkuam9pbignJyl9PC90YWJsZT5gIDog' +
  'Jyd9CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkNsaWVudCBpbnZvaWNlczwvaDI+CiAgICAg' +
  'IDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q2xpZW50PC9sYWJlbD48c2Vs' +
  'ZWN0IGlkPSJpX2NsaWVudCI+CiAgICAgICAgICAke2NsaWVudHMuZmlsdGVyKGMgPT4gYy5hY3RpdmUpLm1hcChjID0+IGA8b3B0' +
  'aW9uIHZhbHVlPSIke2MuaWR9Ij4ke2VzYyhjLm5hbWUpfTwvb3B0aW9uPmApLmpvaW4oJycpfTwvc2VsZWN0PjwvZGl2PgogICAg' +
  'ICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9ImFsaWduLWl0ZW1zOmZsZXgtZW5kO2dhcDo2cHgiPgogICAgICAgICAgPGRpdiBj' +
  'bGFzcz0iZmllbGQiIHN0eWxlPSJmbGV4OjE7bWFyZ2luOjAiPjxsYWJlbD5Gcm9tPC9sYWJlbD48aW5wdXQgdHlwZT0iZGF0ZSIg' +
  'aWQ9Imlfc3RhcnQiIHZhbHVlPSIke2ZpcnN0T2ZNb250aCgpfSI+PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCIg' +
  'c3R5bGU9ImZsZXg6MTttYXJnaW46MCI+PGxhYmVsPlRvPC9sYWJlbD48aW5wdXQgdHlwZT0iZGF0ZSIgaWQ9ImlfZW5kIiB2YWx1' +
  'ZT0iJHt0b2RheUlTTygpfSI+PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyb3ci' +
  'IHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9ImlfcHJldiI+UHJl' +
  'dmlldzwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9ImlfbWFrZSI+Q3JlYXRlIGludm9pY2U8L2J1' +
  'dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgaWQ9Imlfb3V0Ij48L2Rpdj4KICAgICAgJHtpbnZvaWNlcy5sZW5ndGggPyBg' +
  'PHRhYmxlIGNsYXNzPSJ0YmwiIHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPgogICAgICAgIDx0cj48dGg+Q2xpZW50PC90aD48dGg+' +
  'UGVyaW9kPC90aD48dGggY2xhc3M9Im51bSI+Sm9iczwvdGg+PHRoIGNsYXNzPSJudW0iPlRvdGFsPC90aD48dGg+PC90aD48dGg+' +
  'PC90aD48L3RyPgogICAgICAgICR7aW52b2ljZXMubWFwKHMgPT4gYDx0cj4KICAgICAgICAgIDx0ZD4ke2VzYyhzLmNsaWVudF9u' +
  'YW1lKX08L3RkPjx0ZD4ke2ZtdERhdGVPbmx5KHMucGVyaW9kX3N0YXJ0KX3igJMke2ZtdERhdGVPbmx5KHMucGVyaW9kX2VuZCl9' +
  'PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke3Muam9iX2NvdW50fTwvdGQ+PHRkIGNsYXNzPSJudW0iPiR7bW9uZXko' +
  'cy50b3RhbCl9PC90ZD4KICAgICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icGlsbCAke2NscyhzLnN0YXR1cyl9Ij4ke2VzYyhzLnN0' +
  'YXR1cyl9PC9zcGFuPjwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iL3ByaW50L2ludm9pY2UvJHtzLmlk' +
  'fSIgdGFyZ2V0PSJfYmxhbmsiPnByaW50PC9hPgogICAgICAgICAgICAke3Muc3RhdHVzICE9PSAnUGFpZCcgPyBgIMK3IDxhIGhy' +
  'ZWY9IiMiIGRhdGEtaXBhaWQ9IiR7cy5pZH0iPm1hcmsgcGFpZDwvYT5gIDogJyd9PC90ZD4KICAgICAgICA8L3RyPmApLmpvaW4o' +
  'JycpfTwvdGFibGU+YCA6ICcnfQogICAgPC9kaXY+YCk7CiAgYmluZFNoZWxsKCk7CgogIGNvbnN0IGxpbmVzVGFibGUgPSAociwg' +
  'a2V5KSA9PiByLmxpbmVzLmxlbmd0aAogICAgPyBgPHRhYmxlIGNsYXNzPSJ0YmwiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPjx0' +
  'cj48dGg+RGF0ZTwvdGg+PHRoPkpvYjwvdGg+PHRoPlJlY2lwaWVudDwvdGg+PHRoIGNsYXNzPSJudW0iPiR7a2V5ID09PSAncGF5' +
  'JyA/ICdQYXknIDogJ0ZlZSd9PC90aD48L3RyPgogICAgICAgJHtyLmxpbmVzLm1hcChsID0+IGA8dHI+PHRkPiR7Zm10RGF0ZU9u' +
  'bHkobC5zZXJ2ZWRfYXQpfTwvdGQ+PHRkPiR7ZXNjKGwuam9iX251bWJlcil9PC90ZD4KICAgICAgIDx0ZD4ke2VzYyhsLnJlY2lw' +
  'aWVudF9uYW1lKX08L3RkPjx0ZCBjbGFzcz0ibnVtIj4ke21vbmV5KGtleSA9PT0gJ3BheScgPyBsLnNlcnZlcl9wYXkgOiBsLmNs' +
  'aWVudF9mZWUpfTwvdGQ+PC90cj5gKS5qb2luKCcnKX0KICAgICAgIDx0cj48dGQgY29sc3Bhbj0iMyI+PGI+JHtyLmNvdW50fSBq' +
  'b2Iocyk8L2I+PC90ZD48dGQgY2xhc3M9Im51bSI+PGI+JHttb25leShyLnRvdGFsKX08L2I+PC90ZD48L3RyPjwvdGFibGU+YAog' +
  'ICAgOiAnPGRpdiBjbGFzcz0iaGludCI+Tm90aGluZyB1bmJpbGxlZCBpbiB0aGF0IHdpbmRvdy48L2Rpdj4nOwoKICAkKCcjc19w' +
  'cmV2Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9zdGF0ZW1lbnRzL3ByZXZpZXcn' +
  'LCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSgKICAgICAgeyBzZXJ2ZXJfaWQ6ICQoJyNzX3NlcnZlcicp' +
  'LnZhbHVlLCBzdGFydDogJCgnI3Nfc3RhcnQnKS52YWx1ZSwgZW5kOiAkKCcjc19lbmQnKS52YWx1ZSB9KSB9KTsKICAgICQoJyNz' +
  'X291dCcpLmlubmVySFRNTCA9IGxpbmVzVGFibGUociwgJ3BheScpOwogIH07CiAgJCgnI3NfbWFrZScpLm9uY2xpY2sgPSBhc3lu' +
  'YyAoKSA9PiB7CiAgICB0cnkgewogICAgICBhd2FpdCBhcGkoJy9zdGF0ZW1lbnRzJywgeyBtZXRob2Q6ICdQT1NUJywgYm9keTog' +
  'SlNPTi5zdHJpbmdpZnkoCiAgICAgICAgeyBzZXJ2ZXJfaWQ6ICQoJyNzX3NlcnZlcicpLnZhbHVlLCBzdGFydDogJCgnI3Nfc3Rh' +
  'cnQnKS52YWx1ZSwgZW5kOiAkKCcjc19lbmQnKS52YWx1ZSB9KSB9KTsKICAgICAgdG9hc3QoJ1N0YXRlbWVudCBjcmVhdGVkJyk7' +
  'IGdvKCdtb25leScpOwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKICAkKCcjaV9wcmV2' +
  'Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9pbnZvaWNlcy9wcmV2aWV3JywgeyBt' +
  'ZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoCiAgICAgIHsgY2xpZW50X2lkOiAkKCcjaV9jbGllbnQnKS52YWx1' +
  'ZSwgc3RhcnQ6ICQoJyNpX3N0YXJ0JykudmFsdWUsIGVuZDogJCgnI2lfZW5kJykudmFsdWUgfSkgfSk7CiAgICAkKCcjaV9vdXQn' +
  'KS5pbm5lckhUTUwgPSBsaW5lc1RhYmxlKHIsICdmZWUnKTsKICB9OwogICQoJyNpX21ha2UnKS5vbmNsaWNrID0gYXN5bmMgKCkg' +
  'PT4gewogICAgdHJ5IHsKICAgICAgYXdhaXQgYXBpKCcvaW52b2ljZXMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0' +
  'cmluZ2lmeSgKICAgICAgICB7IGNsaWVudF9pZDogJCgnI2lfY2xpZW50JykudmFsdWUsIHN0YXJ0OiAkKCcjaV9zdGFydCcpLnZh' +
  'bHVlLCBlbmQ6ICQoJyNpX2VuZCcpLnZhbHVlIH0pIH0pOwogICAgICB0b2FzdCgnSW52b2ljZSBjcmVhdGVkJyk7IGdvKCdtb25l' +
  'eScpOwogICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgfTsKICBkb2N1bWVudC5xdWVyeVNlbGVj' +
  'dG9yQWxsKCdbZGF0YS1wYWlkXScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sgPSBhc3luYyBlID0+IHsKICAgIGUucHJldmVudERl' +
  'ZmF1bHQoKTsKICAgIGF3YWl0IGFwaSgnL3N0YXRlbWVudHMvJyArIGEuZGF0YXNldC5wYWlkLCB7IG1ldGhvZDogJ1BBVENIJywg' +
  'Ym9keTogSlNPTi5zdHJpbmdpZnkoeyBzdGF0dXM6ICdQYWlkJyB9KSB9KTsKICAgIHRvYXN0KCdNYXJrZWQgcGFpZCcpOyBnbygn' +
  'bW9uZXknKTsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1pcGFpZF0nKS5mb3JFYWNoKGEgPT4gYS5v' +
  'bmNsaWNrID0gYXN5bmMgZSA9PiB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICBhd2FpdCBhcGkoJy9pbnZvaWNlcy8nICsg' +
  'YS5kYXRhc2V0LmlwYWlkLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBzdGF0dXM6ICdQYWlkJyB9' +
  'KSB9KTsKICAgIHRvYXN0KCdNYXJrZWQgcGFpZCcpOyBnbygnbW9uZXknKTsKICB9KTsKfQoKZnVuY3Rpb24gZmlyc3RPZk1vbnRo' +
  'KCkgewogIGNvbnN0IGQgPSBuZXcgRGF0ZSgpOyByZXR1cm4gbmV3IERhdGUoZC5nZXRGdWxsWWVhcigpLCBkLmdldE1vbnRoKCks' +
  'IDEpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTApOwp9Cgphc3luYyBmdW5jdGlvbiBteVBheVZpZXcoKSB7CiAgY29uc3QgW3N0' +
  'YXRlbWVudHMsIHN0YXRzXSA9IGF3YWl0IFByb21pc2UuYWxsKFthcGkoJy9zdGF0ZW1lbnRzJyksIGFwaSgnL3N0YXRzJyldKTsK' +
  'ICBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYAogICAgPGgxIGNsYXNzPSJwYWdlIj5NeSBwYXk8L2gxPgogICAgPGRpdiBjbGFzcz0i' +
  'c3RhdHMiPgogICAgICA8ZGl2IGNsYXNzPSJzdGF0IGdvb2QiPjxkaXYgY2xhc3M9Im4iPiR7bW9uZXkoc3RhdHMudW5iaWxsZWQp' +
  'fTwvZGl2PjxkaXYgY2xhc3M9ImwiPkVhcm5lZCwgbm90IHlldCBvbiBhIHN0YXRlbWVudDwvZGl2PjwvZGl2PgogICAgICA8ZGl2' +
  'IGNsYXNzPSJzdGF0Ij48ZGl2IGNsYXNzPSJuIj4ke3N0YXRzLnNlcnZlZF83ZH08L2Rpdj48ZGl2IGNsYXNzPSJsIj5TZXJ2ZXMg' +
  'Y29tcGxldGVkLCA3IGRheXM8L2Rpdj48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iY2FyZCI+PGgyPlN0YXRlbWVu' +
  'dHM8L2gyPgogICAgJHtzdGF0ZW1lbnRzLmxlbmd0aCA/IGA8dGFibGUgY2xhc3M9InRibCI+CiAgICAgIDx0cj48dGg+UGVyaW9k' +
  'PC90aD48dGggY2xhc3M9Im51bSI+Sm9iczwvdGg+PHRoIGNsYXNzPSJudW0iPlRvdGFsPC90aD48dGg+PC90aD48dGg+PC90aD48' +
  'L3RyPgogICAgICAke3N0YXRlbWVudHMubWFwKHMgPT4gYDx0cj48dGQ+JHtmbXREYXRlT25seShzLnBlcmlvZF9zdGFydCl94oCT' +
  'JHtmbXREYXRlT25seShzLnBlcmlvZF9lbmQpfTwvdGQ+CiAgICAgICAgPHRkIGNsYXNzPSJudW0iPiR7cy5qb2JfY291bnR9PC90' +
  'ZD48dGQgY2xhc3M9Im51bSI+JHttb25leShzLnRvdGFsKX08L3RkPgogICAgICAgIDx0ZD48c3BhbiBjbGFzcz0icGlsbCAke2Ns' +
  'cyhzLnN0YXR1cyl9Ij4ke2VzYyhzLnN0YXR1cyl9PC9zcGFuPjwvdGQ+CiAgICAgICAgPHRkIGNsYXNzPSJudW0iPjxhIGhyZWY9' +
  'Ii9wcmludC9zdGF0ZW1lbnQvJHtzLmlkfSIgdGFyZ2V0PSJfYmxhbmsiPnByaW50PC9hPjwvdGQ+PC90cj5gKS5qb2luKCcnKX0K' +
  'ICAgICAgPC90YWJsZT5gIDogJzxkaXYgY2xhc3M9ImVtcHR5Ij5ObyBzdGF0ZW1lbnRzIHlldC48L2Rpdj4nfQogICAgPC9kaXY+' +
  'CiAgICA8ZGl2IGNsYXNzPSJjYXJkIj48aDI+Q2hhbmdlIHBhc3N3b3JkPC9oMj4KICAgICAgPGRpdiBjbGFzcz0iaGludCI+VGhp' +
  'cyBpcyB5b3VyIG9uZSBwYXNzd29yZCBmb3IgZXZlcnkgYXBwLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGlucHV0' +
  'IGlkPSJvcHciIHR5cGU9InBhc3N3b3JkIiBwbGFjZWhvbGRlcj0iQ3VycmVudCBwYXNzd29yZCI+PC9kaXY+CiAgICAgIDxkaXYg' +
  'Y2xhc3M9ImZpZWxkIj48aW5wdXQgaWQ9Im5wdyIgdHlwZT0icGFzc3dvcmQiIHBsYWNlaG9sZGVyPSJOZXcgcGFzc3dvcmQgKDgr' +
  'IGNoYXJhY3RlcnMpIj48L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0ic2F2ZVB3Ij5VcGRhdGU8L2J1dHRv' +
  'bj48L2Rpdj5gKTsKICBiaW5kU2hlbGwoKTsKICAkKCcjc2F2ZVB3Jykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7' +
  'CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9tZS9wYXNzd29yZCcsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3Ry' +
  'aW5naWZ5KHsKICAgICAgICBwYXNzd29yZDogJCgnI25wdycpLnZhbHVlLCBvbGRfcGFzc3dvcmQ6ICQoJyNvcHcnKS52YWx1ZSB9' +
  'KSB9KTsKICAgICAgJCgnI29wdycpLnZhbHVlID0gJyc7ICQoJyNucHcnKS52YWx1ZSA9ICcnOwogICAgICB0b2FzdChyLmV2ZXJ5' +
  'd2hlcmUgPT09IGZhbHNlID8gJ0NoYW5nZWQgaGVyZSDigJQgb3RoZXIgYXBwcyBzdGlsbCBoYXZlIHRoZSBvbGQgb25lJyA6ICdQ' +
  'YXNzd29yZCB1cGRhdGVkIGV2ZXJ5d2hlcmUnKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQog' +
  'IH07Cn0KCgpmdW5jdGlvbiBjb2Rlc1RhYmxlKGxpc3QpIHsKICBpZiAoIWxpc3QubGVuZ3RoKSByZXR1cm4gJzxkaXYgY2xhc3M9' +
  'ImhpbnQiPk5vIGNvZGVzIHlldC48L2Rpdj4nOwogIHJldHVybiBgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgPHRyPjx0aD5Db2Rl' +
  'PC90aD48dGg+R3JhbnRzPC90aD48dGg+VXNlZDwvdGg+PHRoPjwvdGg+PHRoPjwvdGg+PC90cj4KICAgICR7bGlzdC5tYXAoYyA9' +
  'PiBgPHRyPgogICAgICA8dGQ+PHNwYW4gc3R5bGU9ImZvbnQ6NjAwIDEzcHggbW9ub3NwYWNlO2xldHRlci1zcGFjaW5nOi41cHgi' +
  'PiR7ZXNjKGMuY29kZSl9PC9zcGFuPgogICAgICAgICR7Yy5ub3RlID8gYDxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKGMubm90ZSl9' +
  'PC9kaXY+YCA6ICcnfQogICAgICAgICR7Yy5yZWRlbXB0aW9ucyAmJiBjLnJlZGVtcHRpb25zLmxlbmd0aCA/IGA8ZGl2IGNsYXNz' +
  'PSJoaW50Ij4ke2MucmVkZW1wdGlvbnMubWFwKHIgPT4gZXNjKHIuZW1haWwpKS5qb2luKCcsICcpfTwvZGl2PmAgOiAnJ308L3Rk' +
  'PgogICAgICA8dGQ+JHtjLnJvbGUgPT09ICdhZG1pbicgPyAnQWRtaW4nIDogJ0ZpZWxkIHNlcnZlcid9CiAgICAgICAgJHtjLmV4' +
  'cGlyZXNfYXQgPyBgPGRpdiBjbGFzcz0iaGludCI+dG8gJHtmbXREYXRlT25seShjLmV4cGlyZXNfYXQpfTwvZGl2PmAgOiAnJ308' +
  'L3RkPgogICAgICA8dGQ+JHtjLnVzZWRfY291bnR9LyR7Yy5tYXhfdXNlc308L3RkPgogICAgICA8dGQ+PHNwYW4gY2xhc3M9InBp' +
  'bGwgJHtjLnN0YXRlID09PSAnQWN0aXZlJyA/ICdTZXJ2ZWQnIDogJyd9Ij4ke2VzYyhjLnN0YXRlKX08L3NwYW4+PC90ZD4KICAg' +
  'ICAgPHRkIGNsYXNzPSJudW0iPgogICAgICAgIDxhIGhyZWY9IiMiIGRhdGEtY29weT0iJHtlc2MoYy5jb2RlKX0iPmNvcHk8L2E+' +
  'CiAgICAgICAgJHtjLnN0YXRlID09PSAnQWN0aXZlJyA/IGAgwrcgPGEgaHJlZj0iIyIgZGF0YS1yZXZva2U9IiR7Yy5pZH0iPnJl' +
  'dm9rZTwvYT5gIDogJyd9CiAgICAgIDwvdGQ+PC90cj5gKS5qb2luKCcnKX08L3RhYmxlPmA7Cn0KCi8qIC0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIGFkbWluIC0tICovCi8qIC0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSB0aGUgcGxhbiAtLSAqLwovKiBUaHJlZSBz' +
  'dGF0ZXMgd29ydGggdGVsbGluZyBzb21lYm9keSBhYm91dCwgYW5kIG9uZSB3b3J0aCBzdGF5aW5nIHF1aWV0IG9uLgogICBBIHBh' +
  'aWQgY29tcGFueSBzZWVzIG5vdGhpbmcgYXQgdGhlIHRvcCBvZiBpdHMgZGFzaGJvYXJkIOKAlCBpdCBoYXMgYWxyZWFkeQogICBi' +
  'b3VnaHQgdGhlIHRoaW5nLCBhbmQgYSBiYW5uZXIgd291bGQganVzdCBiZSBpbiB0aGUgd2F5LiAqLwoKY29uc3QgcGxhbiA9ICgp' +
  'ID0+IChTLm1lICYmIFMubWUucGxhbikgfHwgeyBwbGFuOiAnZnJlZScsIHRyaWFsOiBmYWxzZSB9OwoKZnVuY3Rpb24gcGxhbkJh' +
  'bm5lcigpIHsKICBjb25zdCBwID0gcGxhbigpOwogIGlmIChwLnBsYW4gPT09ICdwcm8nICYmICFwLnRyaWFsKSByZXR1cm4gJyc7' +
  'ICAgICAgICAgIC8vIHBheWluZzogc2F5IG5vdGhpbmcKICBpZiAocC50cmlhbCkgewogICAgY29uc3QgZCA9IHAuZGF5c19sZWZ0' +
  'OwogICAgaWYgKGQgPT09IG51bGwgfHwgZCA+IDcpIHJldHVybiAnJzsgICAgICAgICAgICAgICAgIC8vIGVhcmx5IGRheXM6IGxl' +
  'YXZlIHRoZW0gYWxvbmUKICAgIHJldHVybiBgPGRpdiBjbGFzcz0iY2FyZCIgc3R5bGU9ImJvcmRlci1jb2xvcjojRjZDNjhBO2Jh' +
  'Y2tncm91bmQ6I0ZFRjZFQyI+CiAgICAgIDxiPiR7ZCA9PT0gMCA/ICdZb3VyIHRyaWFsIGVuZHMgdG9kYXknIDogZCA9PT0gMSA/' +
  'ICdPbmUgZGF5IGxlZnQgaW4geW91ciB0cmlhbCcKICAgICAgICAgIDogZCArICcgZGF5cyBsZWZ0IGluIHlvdXIgdHJpYWwnfTwv' +
  'Yj4KICAgICAgPGRpdiBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6NHB4Ij5FdmVyeXRoaW5nIGtlZXBzIHdvcmtpbmck' +
  'ewogICAgICAgIGQgPT09IDAgPyAnIHVudGlsIG1pZG5pZ2h0JyA6ICcnfS4gQWZ0ZXIgdGhhdCB5b3UgY2FuIGNhcnJ5IG9uIGZy' +
  'ZWUgd2l0aCB1cCB0bwogICAgICAgICR7cC5saW1pdHMgPyBwLmxpbWl0cy5jbGllbnRzIDogM30gYXR0b3JuZXkgY2xpZW50cy4K' +
  'ICAgICAgICA8YSBocmVmPSIjIiBkYXRhLWdvPSJhZG1pbiI+VXBncmFkZTwvYT48L2Rpdj48L2Rpdj5gOwogIH0KICBpZiAocC50' +
  'cmlhbF9vdmVyKSB7CiAgICByZXR1cm4gYDxkaXYgY2xhc3M9ImNhcmQiIHN0eWxlPSJib3JkZXItY29sb3I6I0Y2QzY4QTtiYWNr' +
  'Z3JvdW5kOiNGRUY2RUMiPgogICAgICA8Yj5Zb3VyIGZyZWUgdHJpYWwgaGFzIGVuZGVkPC9iPgogICAgICA8ZGl2IGNsYXNzPSJo' +
  'aW50IiBzdHlsZT0ibWFyZ2luLXRvcDo0cHgiPllvdSBhcmUgb24gdGhlIGZyZWUgcGxhbiDigJQgdXAgdG8KICAgICAgICAke3Au' +
  'bGltaXRzID8gcC5saW1pdHMuY2xpZW50cyA6IDN9IGF0dG9ybmV5IGNsaWVudHMuIFlvdXIgam9icywgYXR0ZW1wdHMgYW5kIHBo' +
  'b3RvcyBhcmUKICAgICAgICBhbGwgc3RpbGwgaGVyZS4gPGEgaHJlZj0iIyIgZGF0YS1nbz0iYWRtaW4iPlVwZ3JhZGU8L2E+PC9k' +
  'aXY+PC9kaXY+YDsKICB9CiAgcmV0dXJuICcnOwp9CgpmdW5jdGlvbiBwbGFuQ2FyZCgpIHsKICBjb25zdCBwID0gcGxhbigpOwog' +
  'IGNvbnN0IGxhYmVsID0gcC5wbGFuID09PSAncHJvJwogICAgPyAocC50cmlhbCA/IGBGcmVlIHRyaWFsIMK3ICR7cC5kYXlzX2xl' +
  'ZnR9IGRheSR7cC5kYXlzX2xlZnQgPT09IDEgPyAnJyA6ICdzJ30gbGVmdGAgOiAnUHJvJykKICAgIDogKHAudHJpYWxfb3ZlciA/' +
  'ICdGcmVlIOKAlCB0cmlhbCBlbmRlZCcgOiAnRnJlZScpOwogIHJldHVybiBgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICA8aDI+U3Vi' +
  'c2NyaXB0aW9uIDxzcGFuIGNsYXNzPSJzdWIiPiR7ZXNjKGxhYmVsKX08L3NwYW4+PC9oMj4KICAgICR7cC5wbGFuID09PSAncHJv' +
  'JyAmJiAhcC50cmlhbAogICAgICA/IGA8ZGl2IGNsYXNzPSJoaW50Ij5QYWlkJHtwLmV4cGlyZXNfb24gPyAnIHRocm91Z2ggJyAr' +
  'IGZtdERhdGVPbmx5KHAuZXhwaXJlc19vbikgOiAnJ30uIFRoYW5rIHlvdS48L2Rpdj5gCiAgICAgIDogYDxkaXYgY2xhc3M9Imhp' +
  'bnQiPiR7cC50cmlhbAogICAgICAgICAgPyBgWW91ciB0cmlhbCBydW5zIHRvICR7Zm10RGF0ZU9ubHkocC5leHBpcmVzX29uKX0u' +
  'IE5vdGhpbmcgaXMgbGltaXRlZCB1bnRpbCB0aGVuLmAKICAgICAgICAgIDogYFRoZSBmcmVlIHBsYW4gY292ZXJzICR7cC5saW1p' +
  'dHMgPyBwLmxpbWl0cy5jbGllbnRzIDogM30gYXR0b3JuZXkgY2xpZW50cy4KICAgICAgICAgICAgIEV2ZXJ5dGhpbmcgZWxzZSDi' +
  'gJQgam9icywgYXR0ZW1wdHMsIHBob3RvcywgYWZmaWRhdml0cywgaW52b2ljZXMg4oCUIGlzIHVubGltaXRlZC5gfTwvZGl2PmB9' +
  'CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCIgc3R5bGU9Im1hcmdpbi10b3A6MTJweCI+PGxhYmVsPkhhdmUgYW4gdXBncmFkZSBjb2Rl' +
  'PzwvbGFiZWw+CiAgICAgIDxpbnB1dCBpZD0icGxhbkNvZGUiIHBsYWNlaG9sZGVyPSJTUlYtMzBELVhYWFgtWFhYWFhYIiBhdXRv' +
  'Y2FwaXRhbGl6ZT0iY2hhcmFjdGVycyIKICAgICAgICAgICAgIHN0eWxlPSJ0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2UiPjwvZGl2' +
  'PgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0icGxhbkdvIj5BcHBseSBjb2RlPC9idXR0b24+CiAgICA8ZGl2IGNsYXNz' +
  'PSJoaW50IiBpZD0icGxhbk1zZyIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij48L2Rpdj4KICA8L2Rpdj5gOwp9CgpmdW5jdGlvbiB3' +
  'aXJlUGxhbkNhcmQoKSB7CiAgY29uc3QgYnRuID0gJCgnI3BsYW5HbycpOwogIGlmICghYnRuKSByZXR1cm47CiAgYnRuLm9uY2xp' +
  'Y2sgPSBhc3luYyAoKSA9PiB7CiAgICBjb25zdCBtc2cgPSAkKCcjcGxhbk1zZycpOwogICAgY29uc3QgY29kZSA9ICgkKCcjcGxh' +
  'bkNvZGUnKS52YWx1ZSB8fCAnJykudHJpbSgpOwogICAgaWYgKCFjb2RlKSB7IG1zZy50ZXh0Q29udGVudCA9ICdFbnRlciB0aGUg' +
  'Y29kZSB5b3Ugd2VyZSBnaXZlbi4nOyByZXR1cm47IH0KICAgIGJ0bi5kaXNhYmxlZCA9IHRydWU7CiAgICBtc2cuc3R5bGUuY29s' +
  'b3IgPSAnJzsKICAgIG1zZy50ZXh0Q29udGVudCA9ICdDaGVja2luZ+KApic7CiAgICB0cnkgewogICAgICBhd2FpdCBhcGkoJy9w' +
  'bGFuL3JlZGVlbScsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY29kZSB9KSB9KTsKICAgICAgUy5t' +
  'ZSA9IGF3YWl0IGFwaSgnL21lJyk7CiAgICAgIHRvYXN0KCdVcGdyYWRlZCDigJQgdGhhbmsgeW91Jyk7CiAgICAgIGFkbWluVmll' +
  'dygpOwogICAgfSBjYXRjaCAoZSkgewogICAgICBtc2cuc3R5bGUuY29sb3IgPSAndmFyKC0tYmFkKSc7CiAgICAgIG1zZy50ZXh0' +
  'Q29udGVudCA9IGUubWVzc2FnZTsKICAgICAgYnRuLmRpc2FibGVkID0gZmFsc2U7CiAgICB9CiAgfTsKfQoKYXN5bmMgZnVuY3Rp' +
  'b24gYWRtaW5WaWV3KCkgewogIC8vIEZldGNoIGV2ZXJ5dGhpbmcgYmVmb3JlIGRyYXdpbmcuIFBvcHVsYXRpbmcgY2FyZHMgYWZ0' +
  'ZXIgcmVuZGVyIG1hZGUgdGhlCiAgLy8gcGFnZSBncm93IHVuZGVyIHRoZSB1c2VyJ3MgZmluZ2VyLCBzbyBhIHRhcCBjb3VsZCBs' +
  'YW5kIG9uIHRoZSB3cm9uZyByb3cuCiAgY29uc3QgW3VzZXJzLCBjbGllbnRzLCB0ZW1wbGF0ZXMsIGNvZGVzLCBwb3J0YWxzLCBj' +
  'b21wYW5pZXNdID0gYXdhaXQgUHJvbWlzZS5hbGwoWwogICAgYXBpKCcvdXNlcnMnKSwgYXBpKCcvY2xpZW50cycpLCBhcGkoJy90' +
  'ZW1wbGF0ZXMnKSwKICAgIGFwaSgnL2NvZGVzJykuY2F0Y2goKCkgPT4gW10pLCBhcGkoJy9wb3J0YWxzJykuY2F0Y2goKCkgPT4g' +
  'W10pLAogICAgYXBpKCcvY29tcGFuaWVzJykuY2F0Y2goKCkgPT4gW10pCiAgXSk7CiAgY29uc3QgaGVyZSA9IGNvbXBhbmllcy5m' +
  'aW5kKGMgPT4gUy5tZS5jb21wYW55ICYmIGMuaWQgPT09IFMubWUuY29tcGFueS5pZCkgfHwgY29tcGFuaWVzWzBdIHx8IHt9Owog' +
  'IGFwcC5pbm5lckhUTUwgPSBzaGVsbChgCiAgICA8aDEgY2xhc3M9InBhZ2UiPlNldHVwPC9oMT4KCiAgICAke3BsYW5DYXJkKCl9' +
  'CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj4ke2lzT3duZXIoKSA/ICdUaGlzIGNvbXBhbnknIDogJ1lvdXIgY29t' +
  'cGFueSd9PC9oMj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5OYW1lPC9sYWJlbD48aW5wdXQgaWQ9ImNvTmFtZSIg' +
  'dmFsdWU9IiR7ZXNjKGhlcmUubmFtZSB8fCAnJyl9Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Db250' +
  'YWN0IGVtYWlsPC9sYWJlbD48aW5wdXQgaWQ9ImNvRW1haWwiIHZhbHVlPSIke2VzYyhoZXJlLmNvbnRhY3RfZW1haWwgfHwgJycp' +
  'fSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGhvbmU8L2xhYmVsPjxpbnB1dCBpZD0iY29QaG9uZSIg' +
  'dmFsdWU9IiR7ZXNjKGhlcmUucGhvbmUgfHwgJycpfSI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9ImNv' +
  'U2F2ZSI+U2F2ZTwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPlRoaXMgbmFt' +
  'ZSBhcHBlYXJzIG9uIHlvdXIgaW52b2ljZXMgYW5kIHBheSBzdGF0ZW1lbnRzLjwvZGl2PgogICAgPC9kaXY+CgogICAgJHtpc093' +
  'bmVyKCkgPyBgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5BbGwgY29tcGFuaWVzIDxzcGFuIGNsYXNzPSJzdWIiPiR7Y29t' +
  'cGFuaWVzLmxlbmd0aH08L3NwYW4+PC9oMj4KICAgICAgPHRhYmxlIGNsYXNzPSJ0YmwiPgogICAgICAgIDx0cj48dGg+Q29tcGFu' +
  'eTwvdGg+PHRoIGNsYXNzPSJudW0iPlBlb3BsZTwvdGg+PHRoIGNsYXNzPSJudW0iPk9wZW48L3RoPjx0aD48L3RoPjwvdHI+CiAg' +
  'ICAgICAgJHtjb21wYW5pZXMubWFwKGMgPT4gYDx0cj4KICAgICAgICAgIDx0ZD4ke2VzYyhjLm5hbWUpfSR7Uy5tZS5jb21wYW55' +
  'ICYmIGMuaWQgPT09IFMubWUuY29tcGFueS5pZCA/ICcgPHNwYW4gY2xhc3M9InBpbGwiPnlvdSBhcmUgaGVyZTwvc3Bhbj4nIDog' +
  'Jyd9CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKGMuYWRtaW5fZW1haWwgfHwgJ25vIGFkbWluIHlldCcpfSDC' +
  'tyAke2MucGxhbiA9PT0gJ3BybycgPyAnUHJvJyA6ICdGcmVlJ308L2Rpdj48L3RkPgogICAgICAgICAgPHRkIGNsYXNzPSJudW0i' +
  'PiR7Yy5wZW9wbGUgPz8gJ+KAlCd9PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj4ke2Mub3Blbl9qb2JzID8/ICfigJQn' +
  'fTwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+JHtTLm1lLmNvbXBhbnkgJiYgYy5pZCA9PT0gUy5tZS5jb21wYW55Lmlk' +
  'CiAgICAgICAgICAgID8gJycgOiBgPGEgaHJlZj0iIyIgZGF0YS1lbnRlcj0iJHtjLmlkfSI+ZW50ZXI8L2E+YH08L3RkPjwvdHI+' +
  'YCkuam9pbignJyl9CiAgICAgIDwvdGFibGU+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4' +
  'Ij48bGFiZWw+U3RhcnQgYW5vdGhlciBjb21wYW55PC9sYWJlbD4KICAgICAgICA8aW5wdXQgaWQ9Im5ld0NvTmFtZSIgcGxhY2Vo' +
  'b2xkZXI9IkNvbXBhbnkgbmFtZSI+PC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9Im5ld0NvIj5DcmVhdGUg' +
  'Y29tcGFueTwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJoaW50IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPkNyZWF0aW5nIGEg' +
  'Y29tcGFueSBnaXZlcyBpdCBpdHMgb3duIGpvYnMsIGNsaWVudHMgYW5kCiAgICAgICAgYmlsbGluZy4gQWRkIGl0cyBhZG1pbmlz' +
  'dHJhdG9yIGZyb20gaW5zaWRlIGl0LCBvciBoYW5kIHRoZW0gYW4gYWNjZXNzIGNvZGUuPC9kaXY+CiAgICA8L2Rpdj5gIDogJyd9' +
  'CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5UZWFtIDxzcGFuIGNsYXNzPSJzdWIiPiR7dXNlcnMubGVuZ3RofTwv' +
  'c3Bhbj48L2gyPgogICAgICA8dGFibGUgY2xhc3M9InRibCI+CiAgICAgICAgPHRyPjx0aD5OYW1lPC90aD48dGg+Um9sZTwvdGg+' +
  'PHRoIGNsYXNzPSJudW0iPlJhdGU8L3RoPjx0aD48L3RoPjwvdHI+CiAgICAgICAgJHt1c2Vycy5tYXAodSA9PiBgPHRyPjx0ZD4k' +
  'e2VzYyh1Lm5hbWUpfTxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKHUuZW1haWwpfTwvZGl2PjwvdGQ+CiAgICAgICAgICA8dGQ+JHtl' +
  'c2ModS5yb2xlKX0ke3UuYWN0aXZlID8gJycgOiAnIDxzcGFuIGNsYXNzPSJwaWxsIj5vZmY8L3NwYW4+J308L3RkPgogICAgICAg' +
  'ICAgPHRkIGNsYXNzPSJudW0iPiR7bW9uZXkodS5kZWZhdWx0X3BheSl9PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj48' +
  'YSBocmVmPSIjIiBkYXRhLXVzZXI9IiR7dS5pZH0iPmVkaXQ8L2E+PC90ZD48L3RyPmApLmpvaW4oJycpfQogICAgICA8L3RhYmxl' +
  'PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIGJsb2NrIHNtIiBpZD0ibmV3VXNlciIgc3R5bGU9Im1hcmdpbi10b3A6MTBw' +
  'eCI+KyBBZGQgcGVyc29uPC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkNsaWVu' +
  'dHMgPHNwYW4gY2xhc3M9InN1YiI+JHtjbGllbnRzLmxlbmd0aH08L3NwYW4+PC9oMj4KICAgICAgPHRhYmxlIGNsYXNzPSJ0Ymwi' +
  'PgogICAgICAgIDx0cj48dGg+TmFtZTwvdGg+PHRoIGNsYXNzPSJudW0iPkRlZmF1bHQgZmVlPC90aD48dGg+PC90aD48L3RyPgog' +
  'ICAgICAgICR7Y2xpZW50cy5tYXAoYyA9PiBgPHRyPjx0ZD4ke2VzYyhjLm5hbWUpfTxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKGMu' +
  'Y29udGFjdF9uYW1lIHx8ICcnKX0gJHtlc2MoYy5waG9uZSB8fCAnJyl9PC9kaXY+PC90ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0i' +
  'bnVtIj4ke21vbmV5KGMuZGVmYXVsdF9mZWUpfTwvdGQ+CiAgICAgICAgICA8dGQgY2xhc3M9Im51bSI+PGEgaHJlZj0iIyIgZGF0' +
  'YS1jbGllbnQ9IiR7Yy5pZH0iPmVkaXQ8L2E+PC90ZD48L3RyPmApLmpvaW4oJycpfQogICAgICA8L3RhYmxlPgogICAgICA8YnV0' +
  'dG9uIGNsYXNzPSJidG4gc2VjIGJsb2NrIHNtIiBpZD0ibmV3Q2xpZW50IiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4rIEFkZCBj' +
  'bGllbnQ8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9ImNhcmQiPgogICAgICA8aDI+QWZmaWRhdml0IHRlbXBs' +
  'YXRlcyA8c3BhbiBjbGFzcz0ic3ViIj4ke3RlbXBsYXRlcy5sZW5ndGh9PC9zcGFuPjwvaDI+CiAgICAgIDxwIGNsYXNzPSJoaW50' +
  'IiBzdHlsZT0ibWFyZ2luLXRvcDotNHB4Ij5Xcml0ZSB5b3VyIG93biB3b3JkaW5nIHBlciBjb3VudHkgb3IgY2xpZW50LiBNZXJn' +
  'ZSBmaWVsZHMgZmlsbCBpbiBmcm9tIHRoZSBqb2IsCiAgICAgIGluY2x1ZGluZyB0aGUgZnVsbCBhdHRlbXB0IGxvZyB3aXRoIEdQ' +
  'Uy48L3A+CiAgICAgIDx0YWJsZSBjbGFzcz0idGJsIj4KICAgICAgICAke3RlbXBsYXRlcy5tYXAodCA9PiBgPHRyPjx0ZD4ke2Vz' +
  'Yyh0Lm5hbWUpfTxkaXYgY2xhc3M9ImhpbnQiPiR7ZXNjKHQuanVyaXNkaWN0aW9uIHx8ICcnKX08L2Rpdj48L3RkPgogICAgICAg' +
  'ICAgPHRkPiR7dC5pc19kZWZhdWx0ID8gJzxzcGFuIGNsYXNzPSJwaWxsIFNlcnZlZCI+ZGVmYXVsdDwvc3Bhbj4nIDogJyd9PC90' +
  'ZD4KICAgICAgICAgIDx0ZCBjbGFzcz0ibnVtIj48YSBocmVmPSIjIiBkYXRhLXRwbD0iJHt0LmlkfSI+ZWRpdDwvYT48L3RkPjwv' +
  'dHI+YCkuam9pbignJyl9CiAgICAgIDwvdGFibGU+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgYmxvY2sgc20iIGlkPSJu' +
  'ZXdUcGwiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPisgTmV3IHRlbXBsYXRlPC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8ZGl2' +
  'IGNsYXNzPSJjYXJkIj4KICAgICAgPGgyPkFjY2VzcyBjb2RlcyA8c3BhbiBjbGFzcz0ic3ViIj5sZXQgcGVvcGxlIHNldCB1cCB0' +
  'aGVpciBvd24gYWNjb3VudDwvc3Bhbj48L2gyPgogICAgICA8cCBjbGFzcz0iaGludCIgc3R5bGU9Im1hcmdpbi10b3A6LTRweCI+' +
  'R2VuZXJhdGUgYSBjb2RlIGFuZCBzZW5kIGl0IG92ZXIuIFRoZXkgZW50ZXIgaXQgb24gdGhlIHNpZ24taW4KICAgICAgICBzY3Jl' +
  'ZW4gdW5kZXIgIlNldCB1cCB5b3VyIGFjY291bnQiLCBwaWNrIHRoZWlyIG93biBwYXNzd29yZCwgYW5kIHRoZXkncmUgaW4g4oCU' +
  'IG5vIG5lZWQgdG8ga2V5IGluCiAgICAgICAgdGhlaXIgZGV0YWlscyBvciBzaGFyZSBhIHBhc3N3b3JkIHdpdGggdGhlbS48L3A+' +
  'CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzMiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxkaXYgY2xhc3M9ImZp' +
  'ZWxkIj48bGFiZWw+VGhleSBiZWNvbWU8L2xhYmVsPjxzZWxlY3QgaWQ9ImNfcm9sZSI+CiAgICAgICAgICA8b3B0aW9uIHZhbHVl' +
  'PSJzZXJ2ZXIiPkZpZWxkIHNlcnZlcjwvb3B0aW9uPjxvcHRpb24gdmFsdWU9ImFkbWluIj5BZG1pbjwvb3B0aW9uPjwvc2VsZWN0' +
  'PjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+SG93IG1hbnkgY2FuIHVzZSBpdDwvbGFiZWw+PGlucHV0' +
  'IGlkPSJjX3VzZXMiIHR5cGU9Im51bWJlciIgbWluPSIxIiBtYXg9IjUwMCIgdmFsdWU9IjEiPjwvZGl2PgogICAgICAgIDxkaXYg' +
  'Y2xhc3M9ImZpZWxkIj48bGFiZWw+RXhwaXJlcyAob3B0aW9uYWwpPC9sYWJlbD48aW5wdXQgaWQ9ImNfZXhwIiB0eXBlPSJkYXRl' +
  'Ij48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxk' +
  'Ij48bGFiZWw+UGF5IHBlciBzZXJ2ZSAoZmllbGQgc2VydmVycyk8L2xhYmVsPjxpbnB1dCBpZD0iY19wYXkiIHR5cGU9Im51bWJl' +
  'ciIgc3RlcD0iMC4wMSIgcGxhY2Vob2xkZXI9IjQ1LjAwIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVs' +
  'Pk5vdGUgdG8geW91cnNlbGY8L2xhYmVsPjxpbnB1dCBpZD0iY19ub3RlIiBwbGFjZWhvbGRlcj0iRm9yIE1hcmlhIOKAlCBldmlj' +
  'dGlvbnMiPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHNtIiBpZD0iY19tYWtlIj5HZW5lcmF0' +
  'ZSBhIGNvZGU8L2J1dHRvbj4KICAgICAgPGRpdiBpZD0iY19saXN0IiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij4ke2NvZGVzVGFi' +
  'bGUoY29kZXMpfTwvZGl2PgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICAgIDxoMj5Db3VydCBwb3J0YWwg' +
  'cHJvYmUgPHNwYW4gY2xhc3M9InN1YiI+ZXhwZXJpbWVudGFsPC9zcGFuPjwvaDI+CiAgICAgIDxwIGNsYXNzPSJoaW50IiBzdHls' +
  'ZT0ibWFyZ2luLXRvcDotNHB4Ij5Bc2tzIHRoZSBzZXJ2ZXIgdG8gZmV0Y2ggYSBjb3VudHkgcG9ydGFsIGFuZCByZXBvcnQgd2hh' +
  'dCBjYW1lIGJhY2sg4oCUCiAgICAgICAgc3RhdHVzLCBjb29raWVzLCBmb3JtcywgbGlua3MuIFRoaXMgaXMgdGhlIGdyb3VuZHdv' +
  'cmsgZm9yIGF1dG9tYXRpYyBjYXNlIGxvb2t1cDogdGhlc2UgcG9ydGFscyBjYW4ndCBiZQogICAgICAgIHJlYWNoZWQgZnJvbSB3' +
  'aGVyZSB0aGlzIGFwcCB3YXMgd3JpdHRlbiwgc28gdGhlIHNlcnZlciBoYXMgdG8gZ28gYW5kIGxvb2suIFJ1biBvbmUgYW5kIHNl' +
  'bmQgbWUgdGhlIHJlc3VsdC48L3A+CiAgICAgIDxkaXYgY2xhc3M9InJvdyIgaWQ9InByb2JlQnRucyIgc3R5bGU9Im1hcmdpbi10' +
  'b3A6MTBweCI+JHtwb3J0YWxzLm1hcChwdCA9PgogICAgICAgIGA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBkYXRhLXByb2Jl' +
  'PSIke2VzYyhwdC5rZXkpfSI+JHtlc2MocHQubGFiZWwpfTwvYnV0dG9uPmApLmpvaW4oJycpfTwvZGl2PgogICAgICA8ZGl2IGNs' +
  'YXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHgiPgogICAgICAgIDxpbnB1dCBpZD0icHJvYmVVcmwiIHBsYWNlaG9sZGVy' +
  'PSLigKZvciBhIHNwZWNpZmljIHBhZ2UgVVJMIiBzdHlsZT0iZmxleDoxO21pbi13aWR0aDoxNTBweCI+CiAgICAgICAgPGJ1dHRv' +
  'biBjbGFzcz0iYnRuIHNlYyBzbSIgaWQ9InByb2JlR28iPlByb2JlIFVSTDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPHBy' +
  'ZSBjbGFzcz0icHJldiIgaWQ9InByb2JlT3V0IiBzdHlsZT0iZGlzcGxheTpub25lO21hcmdpbi10b3A6MTBweCI+PC9wcmU+CiAg' +
  'ICAgIDxidXR0b24gY2xhc3M9ImJ0biBzZWMgc20gYmxvY2siIGlkPSJjb3B5UHJvYmUiIHN0eWxlPSJkaXNwbGF5Om5vbmU7bWFy' +
  'Z2luLXRvcDo4cHgiPkNvcHkgcmVzdWx0PC9idXR0b24+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJjYXJkIj4KICAgICAg' +
  'PGgyPk15IGFjY291bnQ8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJoaW50Ij5PbmUgcGFzc3dvcmQsIGV2ZXJ5IGFwcC4gQ2hhbmdp' +
  'bmcgaXQgaGVyZSBjaGFuZ2VzIGl0IGV2ZXJ5d2hlcmUuPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Q3Vy' +
  'cmVudCBwYXNzd29yZDwvbGFiZWw+PGlucHV0IGlkPSJvcHciIHR5cGU9InBhc3N3b3JkIiBwbGFjZWhvbGRlcj0idGhlIG9uZSB5' +
  'b3Ugc2lnbmVkIGluIHdpdGgiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk5ldyBwYXNzd29yZDwvbGFi' +
  'ZWw+PGlucHV0IGlkPSJucHciIHR5cGU9InBhc3N3b3JkIiBwbGFjZWhvbGRlcj0iOCsgY2hhcmFjdGVycyI+PC9kaXY+CiAgICAg' +
  'IDxidXR0b24gY2xhc3M9ImJ0biBzbSIgaWQ9InNhdmVQdyI+VXBkYXRlIHBhc3N3b3JkPC9idXR0b24+CiAgICAgIDxkaXYgY2xh' +
  'c3M9ImhpbnQiIGlkPSJidWlsZFN0YW1wIiBzdHlsZT0ibWFyZ2luLXRvcDoxMnB4Ij5idWlsZCDigKY8L2Rpdj4KICAgIDwvZGl2' +
  'PmApOwogIGJpbmRTaGVsbCgpOwoKICBmZXRjaCgnL2FwaS9idWlsZCcpLnRoZW4ociA9PiByLmpzb24oKSkudGhlbihiID0+IHsK' +
  'ICAgIGNvbnN0IGVsID0gJCgnI2J1aWxkU3RhbXAnKTsKICAgIGlmIChlbCkgZWwudGV4dENvbnRlbnQgPSAnU2VydmVUcmFjayBi' +
  'dWlsZCAnICsgYi5idWlsZCArIChiLnByb2JlVGFyZ2V0cyA/ICcgwrcgYm9vdCBwcm9iZSBhcm1lZCcgOiAnJyk7CiAgfSkuY2F0' +
  'Y2goKCkgPT4ge30pOwoKCiAgLyogLS0tLSBhY2Nlc3MgY29kZXMgLS0tLSAqLwogIGFzeW5jIGZ1bmN0aW9uIGRyYXdDb2Rlcygp' +
  'IHsKICAgICQoJyNjX2xpc3QnKS5pbm5lckhUTUwgPSBjb2Rlc1RhYmxlKGF3YWl0IGFwaSgnL2NvZGVzJykpOwogICAgd2lyZUNv' +
  'ZGVzKCk7CiAgfQoKICBmdW5jdGlvbiB3aXJlQ29kZXMoKSB7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1j' +
  'b3B5XScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sgPSBhc3luYyBlID0+IHsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAg' +
  'ICB0cnkgeyBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dChhLmRhdGFzZXQuY29weSk7IHRvYXN0KCdDb3BpZWQg' +
  'JyArIGEuZGF0YXNldC5jb3B5KTsgfQogICAgICBjYXRjaCAoZXJyKSB7IHRvYXN0KCdTZWxlY3QgaXQgYW5kIGNvcHkgYnkgaGFu' +
  'ZCcsIHRydWUpOyB9CiAgICB9KTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXJldm9rZV0nKS5mb3JFYWNo' +
  'KGEgPT4gYS5vbmNsaWNrID0gYXN5bmMgZSA9PiB7CiAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgaWYgKCFjb25maXJt' +
  'KCdSZXZva2UgdGhpcyBjb2RlPyBBbnlvbmUgd2hvIGFscmVhZHkgdXNlZCBpdCBrZWVwcyB0aGVpciBhY2NvdW50LicpKSByZXR1' +
  'cm47CiAgICAgIGF3YWl0IGFwaSgnL2NvZGVzLycgKyBhLmRhdGFzZXQucmV2b2tlLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTog' +
  'SlNPTi5zdHJpbmdpZnkoeyByZXZva2VkOiB0cnVlIH0pIH0pOwogICAgICB0b2FzdCgnUmV2b2tlZCcpOyBkcmF3Q29kZXMoKTsK' +
  'ICAgIH0pOwogIH0KICB3aXJlQ29kZXMoKTsKCiAgJCgnI2NfbWFrZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkg' +
  'ewogICAgICBjb25zdCBtYWRlID0gYXdhaXQgYXBpKCcvY29kZXMnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmlu' +
  'Z2lmeSh7CiAgICAgICAgcm9sZTogJCgnI2Nfcm9sZScpLnZhbHVlLAogICAgICAgIG1heF91c2VzOiAkKCcjY191c2VzJykudmFs' +
  'dWUsCiAgICAgICAgZXhwaXJlc19hdDogJCgnI2NfZXhwJykudmFsdWUgfHwgbnVsbCwKICAgICAgICBkZWZhdWx0X3BheTogJCgn' +
  'I2NfcGF5JykudmFsdWUgfHwgMCwKICAgICAgICBub3RlOiAkKCcjY19ub3RlJykudmFsdWUKICAgICAgfSkgfSk7CiAgICAgICQo' +
  'JyNjX25vdGUnKS52YWx1ZSA9ICcnOwogICAgICB0b2FzdCgnQ29kZSAnICsgbWFkZS5jb2RlKTsKICAgICAgZHJhd0NvZGVzKCk7' +
  'CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9OwogIGRyYXdDb2RlcygpLmNhdGNoKCgpID0+' +
  'IHt9KTsKCiAgLyogLS0tLSBwb3J0YWwgcHJvYmUgLS0tLSAqLwogIGNvbnN0IHByb2JlT3V0ID0gJCgnI3Byb2JlT3V0Jyk7CiAg' +
  'Y29uc3QgcnVuUHJvYmUgPSBhc3luYyBib2R5ID0+IHsKICAgIHByb2JlT3V0LnN0eWxlLmRpc3BsYXkgPSAnJzsKICAgIHByb2Jl' +
  'T3V0LnRleHRDb250ZW50ID0gJ1Byb2JpbmfigKYgKHRoaXMgY2FuIHRha2UgdXAgdG8gMjAgc2Vjb25kcyknOwogICAgJCgnI2Nv' +
  'cHlQcm9iZScpLnN0eWxlLmRpc3BsYXkgPSAnJzsKICAgIHRyeSB7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy9wb3J0YWwt' +
  'cHJvYmUnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KTsKICAgICAgcHJvYmVPdXQudGV4' +
  'dENvbnRlbnQgPSBKU09OLnN0cmluZ2lmeShyLCBudWxsLCAyKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgcHJvYmVPdXQudGV4' +
  'dENvbnRlbnQgPSAnUHJvYmUgZmFpbGVkOiAnICsgZS5tZXNzYWdlOwogICAgfQogIH07CiAgZG9jdW1lbnQucXVlcnlTZWxlY3Rv' +
  'ckFsbCgnW2RhdGEtcHJvYmVdJykuZm9yRWFjaChiID0+CiAgICBiLm9uY2xpY2sgPSAoKSA9PiBydW5Qcm9iZSh7IHBvcnRhbDog' +
  'Yi5kYXRhc2V0LnByb2JlIH0pKTsKICAkKCcjcHJvYmVHbycpLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBjb25zdCB1ID0gJCgnI3By' +
  'b2JlVXJsJykudmFsdWUudHJpbSgpOwogICAgaWYgKHUpIHJ1blByb2JlKHsgdXJsOiB1IH0pOwogIH07CiAgJCgnI2NvcHlQcm9i' +
  'ZScpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgeyBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dChw' +
  'cm9iZU91dC50ZXh0Q29udGVudCk7IHRvYXN0KCdDb3BpZWQnKTsgfQogICAgY2F0Y2ggKGUpIHsgdG9hc3QoJ1NlbGVjdCB0aGUg' +
  'dGV4dCBhbmQgY29weSBpdCBieSBoYW5kJywgdHJ1ZSk7IH0KICB9OwoKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0' +
  'YS11c2VyXScpLmZvckVhY2goYSA9PiBhLm9uY2xpY2sgPSBlID0+IHsKICAgIGUucHJldmVudERlZmF1bHQoKTsgdXNlckZvcm0o' +
  'dXNlcnMuZmluZCh1ID0+IFN0cmluZyh1LmlkKSA9PT0gYS5kYXRhc2V0LnVzZXIpKTsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNl' +
  'bGVjdG9yQWxsKCdbZGF0YS1jbGllbnRdJykuZm9yRWFjaChhID0+IGEub25jbGljayA9IGUgPT4gewogICAgZS5wcmV2ZW50RGVm' +
  'YXVsdCgpOyBjbGllbnRGb3JtKGNsaWVudHMuZmluZChjID0+IFN0cmluZyhjLmlkKSA9PT0gYS5kYXRhc2V0LmNsaWVudCkpOwog' +
  'IH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXRwbF0nKS5mb3JFYWNoKGEgPT4gYS5vbmNsaWNrID0gZSA9' +
  'PiB7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7IHRlbXBsYXRlRm9ybSh0ZW1wbGF0ZXMuZmluZCh0ID0+IFN0cmluZyh0LmlkKSA9' +
  'PT0gYS5kYXRhc2V0LnRwbCkpOwogIH0pOwogIHdpcmVQbGFuQ2FyZCgpOwogIGNvbnN0IGNvU2F2ZSA9ICQoJyNjb1NhdmUnKTsK' +
  'ICBpZiAoY29TYXZlKSBjb1NhdmUub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIHRyeSB7CiAgICAgIGF3YWl0IGFwaSgnL2Nv' +
  'bXBhbmllcy8nICsgKGhlcmUuaWQpLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoewogICAgICAgIG5h' +
  'bWU6ICQoJyNjb05hbWUnKS52YWx1ZSwgY29udGFjdF9lbWFpbDogJCgnI2NvRW1haWwnKS52YWx1ZSwgcGhvbmU6ICQoJyNjb1Bo' +
  'b25lJykudmFsdWUgfSkgfSk7CiAgICAgIFMubWUgPSBhd2FpdCBhcGkoJy9tZScpOwogICAgICB0b2FzdCgnQ29tcGFueSBzYXZl' +
  'ZCcpOwogICAgICByZW5kZXIoKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5tZXNzYWdlLCB0cnVlKTsgfQogIH07CiAgY29u' +
  'c3QgbmV3Q28gPSAkKCcjbmV3Q28nKTsKICBpZiAobmV3Q28pIG5ld0NvLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBjb25z' +
  'dCBuYW1lID0gJCgnI25ld0NvTmFtZScpLnZhbHVlLnRyaW0oKTsKICAgIGlmICghbmFtZSkgcmV0dXJuIHRvYXN0KCdHaXZlIHRo' +
  'ZSBjb21wYW55IGEgbmFtZScsIHRydWUpOwogICAgdHJ5IHsKICAgICAgYXdhaXQgYXBpKCcvY29tcGFuaWVzJywgeyBtZXRob2Q6' +
  'ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBuYW1lIH0pIH0pOwogICAgICBTLm1lID0gYXdhaXQgYXBpKCcvbWUnKTsK' +
  'ICAgICAgdG9hc3QobmFtZSArICcgY3JlYXRlZCcpOwogICAgICByZW5kZXIoKTsKICAgIH0gY2F0Y2ggKGUpIHsgdG9hc3QoZS5t' +
  'ZXNzYWdlLCB0cnVlKTsgfQogIH07CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtZW50ZXJdJykuZm9yRWFjaChh' +
  'ID0+IGEub25jbGljayA9IGFzeW5jIGUgPT4gewogICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgdHJ5IHsKICAgICAgY29uc3Qg' +
  'b3V0ID0gYXdhaXQgYXBpKCcvY29tcGFuaWVzLycgKyBhLmRhdGFzZXQuZW50ZXIgKyAnL2VudGVyJywgeyBtZXRob2Q6ICdQT1NU' +
  'JyB9KTsKICAgICAgUy5tZSA9IGF3YWl0IGFwaSgnL21lJyk7CiAgICAgIHRvYXN0KCdOb3cgaW4gJyArIG91dC5jb21wYW55Lm5h' +
  'bWUpOwogICAgICByZW5kZXIoKTsKICAgIH0gY2F0Y2ggKGVycikgeyB0b2FzdChlcnIubWVzc2FnZSwgdHJ1ZSk7IH0KICB9KTsK' +
  'ICAkKCcjbmV3VXNlcicpLm9uY2xpY2sgPSAoKSA9PiB1c2VyRm9ybShudWxsKTsKICAkKCcjbmV3Q2xpZW50Jykub25jbGljayA9' +
  'ICgpID0+IGNsaWVudEZvcm0obnVsbCk7CiAgJCgnI25ld1RwbCcpLm9uY2xpY2sgPSAoKSA9PiB0ZW1wbGF0ZUZvcm0obnVsbCk7' +
  'CiAgJCgnI3NhdmVQdycpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICBjb25zdCByID0gYXdhaXQgYXBp' +
  'KCcvbWUvcGFzc3dvcmQnLCB7IG1ldGhvZDogJ1BPU1QnLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgcGFzc3dvcmQ6' +
  'ICQoJyNucHcnKS52YWx1ZSwgb2xkX3Bhc3N3b3JkOiAkKCcjb3B3JykudmFsdWUgfSkgfSk7CiAgICAgICQoJyNvcHcnKS52YWx1' +
  'ZSA9ICcnOyAkKCcjbnB3JykudmFsdWUgPSAnJzsKICAgICAgdG9hc3Qoci5ldmVyeXdoZXJlID09PSBmYWxzZSA/ICdDaGFuZ2Vk' +
  'IGhlcmUg4oCUIG90aGVyIGFwcHMgc3RpbGwgaGF2ZSB0aGUgb2xkIG9uZScgOiAnUGFzc3dvcmQgdXBkYXRlZCBldmVyeXdoZXJl' +
  'Jyk7CiAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICB9Owp9CgpmdW5jdGlvbiB1c2VyRm9ybSh1' +
  'KSB7CiAgY29uc3QgdiA9IHUgfHwgeyByb2xlOiAnc2VydmVyJywgYWN0aXZlOiB0cnVlIH07CiAgc2hlZXQodSA/ICdFZGl0ICcg' +
  'KyB1Lm5hbWUgOiAnQWRkIHBlcnNvbicsIGAKICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+TmFtZTwvbGFiZWw+PGlucHV0' +
  'IGlkPSJ1X25hbWUiIHZhbHVlPSIke2VzYyh2Lm5hbWUpfSI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkVt' +
  'YWlsICh1c2VkIHRvIHNpZ24gaW4pPC9sYWJlbD48aW5wdXQgaWQ9InVfZW1haWwiIHR5cGU9ImVtYWlsIiB2YWx1ZT0iJHtlc2Mo' +
  'di5lbWFpbCl9Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+JHt1ID8gJ05ldyBwYXNzd29yZCAobGVhdmUg' +
  'YmxhbmsgdG8ga2VlcCknIDogJ1Bhc3N3b3JkJ308L2xhYmVsPjxpbnB1dCBpZD0idV9wYXNzd29yZCIgdHlwZT0idGV4dCIgcGxh' +
  'Y2Vob2xkZXI9IiR7dSA/ICd1bmNoYW5nZWQnIDogJ3NldCBhIHBhc3N3b3JkJ30iPjwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ3Jp' +
  'ZCBnMiI+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+Um9sZTwvbGFiZWw+PHNlbGVjdCBpZD0idV9yb2xlIj4KICAg' +
  'ICAgICA8b3B0aW9uIHZhbHVlPSJzZXJ2ZXIiICR7di5yb2xlID09PSAnc2VydmVyJyA/ICdzZWxlY3RlZCcgOiAnJ30+RmllbGQg' +
  'c2VydmVyPC9vcHRpb24+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYWRtaW4iICR7di5yb2xlID09PSAnYWRtaW4nID8gJ3NlbGVj' +
  'dGVkJyA6ICcnfT5BZG1pbjwvb3B0aW9uPgogICAgICAgICR7aXNPd25lcigpID8gYDxvcHRpb24gdmFsdWU9Im93bmVyIiAke3Yu' +
  'cm9sZSA9PT0gJ293bmVyJyA/ICdzZWxlY3RlZCcgOiAnJ30+T3duZXIgKGV2ZXJ5IGNvbXBhbnkpPC9vcHRpb24+YCA6ICcnfQog' +
  'ICAgICA8L3NlbGVjdD48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5EZWZhdWx0IHBheSBwZXIgc2VydmU8' +
  'L2xhYmVsPjxpbnB1dCBpZD0idV9kZWZhdWx0X3BheSIgdHlwZT0ibnVtYmVyIiBzdGVwPSIwLjAxIiB2YWx1ZT0iJHt2LmRlZmF1' +
  'bHRfcGF5IHx8ICcnfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+UGhvbmU8L2xhYmVsPjxpbnB1dCBp' +
  'ZD0idV9waG9uZSIgdmFsdWU9IiR7ZXNjKHYucGhvbmUpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+' +
  'TGljZW5zZSAvIHJlZ2lzdHJhdGlvbiAjPC9sYWJlbD48aW5wdXQgaWQ9InVfbGljZW5zZV9ubyIgdmFsdWU9IiR7ZXNjKHYubGlj' +
  'ZW5zZV9ubyl9Ij48L2Rpdj4KICAgIDwvZGl2PgogICAgJHt1ID8gYDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+U3RhdHVzPC9s' +
  'YWJlbD48c2VsZWN0IGlkPSJ1X2FjdGl2ZSI+CiAgICAgIDxvcHRpb24gdmFsdWU9InRydWUiICR7di5hY3RpdmUgPyAnc2VsZWN0' +
  'ZWQnIDogJyd9PkFjdGl2ZTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJmYWxzZSIgJHshdi5hY3RpdmUgPyAnc2VsZWN0' +
  'ZWQnIDogJyd9PkRlYWN0aXZhdGVkPC9vcHRpb24+PC9zZWxlY3Q+PC9kaXY+YCA6ICcnfQogICAgPGRpdiBjbGFzcz0icm93Ij48' +
  'YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJzYXZlIj5TYXZlPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIiBvbmNs' +
  'aWNrPSJjbG9zZVNoZWV0KCkiPkNhbmNlbDwvYnV0dG9uPjwvZGl2PmAsIGVsID0+IHsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoJyNz' +
  'YXZlJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgICAgY29uc3QgYm9keSA9IHsKICAgICAgICBuYW1lOiBlbC5xdWVyeVNl' +
  'bGVjdG9yKCcjdV9uYW1lJykudmFsdWUsIGVtYWlsOiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9lbWFpbCcpLnZhbHVlLAogICAgICAg' +
  'IHJvbGU6IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X3JvbGUnKS52YWx1ZSwgcGhvbmU6IGVsLnF1ZXJ5U2VsZWN0b3IoJyN1X3Bob25l' +
  'JykudmFsdWUsCiAgICAgICAgbGljZW5zZV9ubzogZWwucXVlcnlTZWxlY3RvcignI3VfbGljZW5zZV9ubycpLnZhbHVlLAogICAg' +
  'ICAgIGRlZmF1bHRfcGF5OiBlbC5xdWVyeVNlbGVjdG9yKCcjdV9kZWZhdWx0X3BheScpLnZhbHVlIHx8IDAKICAgICAgfTsKICAg' +
  'ICAgY29uc3QgcHcgPSBlbC5xdWVyeVNlbGVjdG9yKCcjdV9wYXNzd29yZCcpLnZhbHVlOwogICAgICBpZiAocHcpIGJvZHkucGFz' +
  'c3dvcmQgPSBwdzsKICAgICAgaWYgKHUpIGJvZHkuYWN0aXZlID0gZWwucXVlcnlTZWxlY3RvcignI3VfYWN0aXZlJykudmFsdWUg' +
  'PT09ICd0cnVlJzsKICAgICAgdHJ5IHsKICAgICAgICBhd2FpdCAodSA/IGFwaSgnL3VzZXJzLycgKyB1LmlkLCB7IG1ldGhvZDog' +
  'J1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSkKICAgICAgICAgICAgICAgICA6IGFwaSgnL3VzZXJzJywgeyBt' +
  'ZXRob2Q6ICdQT1NUJywgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSkpOwogICAgICAgIGNsb3NlU2hlZXQoKTsgdG9hc3Qo' +
  'J1NhdmVkJyk7IGdvKCdhZG1pbicpOwogICAgICB9IGNhdGNoIChlKSB7IHRvYXN0KGUubWVzc2FnZSwgdHJ1ZSk7IH0KICAgIH07' +
  'CiAgfSk7Cn0KCmZ1bmN0aW9uIGNsaWVudEZvcm0oYykgewogIGNvbnN0IHYgPSBjIHx8IHt9OwogIHNoZWV0KGMgPyAnRWRpdCAn' +
  'ICsgYy5uYW1lIDogJ0FkZCBjbGllbnQnLCBgCiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkZpcm0gLyBjbGllbnQgbmFt' +
  'ZTwvbGFiZWw+PGlucHV0IGlkPSJjX25hbWUiIHZhbHVlPSIke2VzYyh2Lm5hbWUpfSI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJn' +
  'cmlkIGcyIj4KICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Db250YWN0PC9sYWJlbD48aW5wdXQgaWQ9ImNfY29udGFj' +
  'dF9uYW1lIiB2YWx1ZT0iJHtlc2Modi5jb250YWN0X25hbWUpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFi' +
  'ZWw+UGhvbmU8L2xhYmVsPjxpbnB1dCBpZD0iY19waG9uZSIgdmFsdWU9IiR7ZXNjKHYucGhvbmUpfSI+PC9kaXY+CiAgICAgIDxk' +
  'aXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+RW1haWw8L2xhYmVsPjxpbnB1dCBpZD0iY19lbWFpbCIgdHlwZT0iZW1haWwiIHZhbHVl' +
  'PSIke2VzYyh2LmVtYWlsKX0iPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPkRlZmF1bHQgZmVlIHBlciBz' +
  'ZXJ2ZTwvbGFiZWw+PGlucHV0IGlkPSJjX2RlZmF1bHRfZmVlIiB0eXBlPSJudW1iZXIiIHN0ZXA9IjAuMDEiIHZhbHVlPSIke3Yu' +
  'ZGVmYXVsdF9mZWUgfHwgJyd9Ij48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5CaWxsaW5n' +
  'IGFkZHJlc3M8L2xhYmVsPjx0ZXh0YXJlYSBpZD0iY19hZGRyZXNzIiBzdHlsZT0ibWluLWhlaWdodDo2MHB4Ij4ke2VzYyh2LmFk' +
  'ZHJlc3MpfTwvdGV4dGFyZWE+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsPk5vdGVzPC9sYWJlbD48dGV4dGFy' +
  'ZWEgaWQ9ImNfbm90ZXMiIHN0eWxlPSJtaW4taGVpZ2h0OjYwcHgiPiR7ZXNjKHYubm90ZXMpfTwvdGV4dGFyZWE+PC9kaXY+CiAg' +
  'ICA8ZGl2IGNsYXNzPSJyb3ciPjxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InNhdmUiPlNhdmU8L2J1dHRvbj4KICAgIDxidXR0b24g' +
  'Y2xhc3M9ImJ0biBzZWMiIG9uY2xpY2s9ImNsb3NlU2hlZXQoKSI+Q2FuY2VsPC9idXR0b24+PC9kaXY+YCwgZWwgPT4gewogICAg' +
  'ZWwucXVlcnlTZWxlY3RvcignI3NhdmUnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBib2R5ID0ge307CiAg' +
  'ICAgIFsnbmFtZScsJ2NvbnRhY3RfbmFtZScsJ3Bob25lJywnZW1haWwnLCdkZWZhdWx0X2ZlZScsJ2FkZHJlc3MnLCdub3Rlcydd' +
  'CiAgICAgICAgLmZvckVhY2goZiA9PiBib2R5W2ZdID0gZWwucXVlcnlTZWxlY3RvcignI2NfJyArIGYpLnZhbHVlKTsKICAgICAg' +
  'dHJ5IHsKICAgICAgICBhd2FpdCAoYyA/IGFwaSgnL2NsaWVudHMvJyArIGMuaWQsIHsgbWV0aG9kOiAnUEFUQ0gnLCBib2R5OiBK' +
  'U09OLnN0cmluZ2lmeShib2R5KSB9KQogICAgICAgICAgICAgICAgIDogYXBpKCcvY2xpZW50cycsIHsgbWV0aG9kOiAnUE9TVCcs' +
  'IGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pKTsKICAgICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KCdTYXZlZCcpOyBnbygn' +
  'YWRtaW4nKTsKICAgICAgfSBjYXRjaCAoZSkgeyB0b2FzdChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgICB9OwogIH0pOwp9Cgphc3lu' +
  'YyBmdW5jdGlvbiB0ZW1wbGF0ZUZvcm0odCkgewogIGNvbnN0IGZpZWxkcyA9IGF3YWl0IGFwaSgnL3RlbXBsYXRlLWZpZWxkcycp' +
  'OwogIGNvbnN0IHYgPSB0IHx8IHsgYm9keTogJycsIGlzX2RlZmF1bHQ6IGZhbHNlIH07CiAgc2hlZXQodCA/ICdFZGl0IHRlbXBs' +
  'YXRlJyA6ICdOZXcgYWZmaWRhdml0IHRlbXBsYXRlJywgYAogICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+CiAgICAgIDxkaXYgY2xh' +
  'c3M9ImZpZWxkIj48bGFiZWw+VGVtcGxhdGUgbmFtZTwvbGFiZWw+PGlucHV0IGlkPSJ0X25hbWUiIHZhbHVlPSIke2VzYyh2Lm5h' +
  'bWUpfSI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWw+SnVyaXNkaWN0aW9uIC8gY291cnQ8L2xhYmVsPjxp' +
  'bnB1dCBpZD0idF9qdXJpc2RpY3Rpb24iIHZhbHVlPSIke2VzYyh2Lmp1cmlzZGljdGlvbil9Ij48L2Rpdj4KICAgIDwvZGl2Pgog' +
  'ICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbD5Cb2R5PC9sYWJlbD4KICAgICAgPHRleHRhcmVhIGlkPSJ0X2JvZHkiIHN0eWxl' +
  'PSJtaW4taGVpZ2h0OjIyMHB4O2ZvbnQ6MTIuNXB4LzEuNSAnQ291cmllciBOZXcnLG1vbm9zcGFjZSI+JHtlc2Modi5ib2R5KX08' +
  'L3RleHRhcmVhPgogICAgICA8ZGl2IGNsYXNzPSJoaW50Ij5DbGljayBhIGZpZWxkIHRvIGluc2VydCBpdCBhdCB0aGUgY3Vyc29y' +
  'OjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0b2tlbnMiPiR7ZmllbGRzLm1hcChmID0+IGA8YnV0dG9uIGRhdGEtZj0iJHtmWzBd' +
  'fSIgdGl0bGU9IiR7ZXNjKGZbMV0pfSI+e3ske2ZbMF19fX08L2J1dHRvbj5gKS5qb2luKCcnKX08L2Rpdj4KICAgIDwvZGl2Pgog' +
  'ICAgPGxhYmVsIHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHgiPjxpbnB1dCB0eXBlPSJjaGVj' +
  'a2JveCIgaWQ9InRfZGVmYXVsdCIgc3R5bGU9IndpZHRoOmF1dG8iICR7di5pc19kZWZhdWx0ID8gJ2NoZWNrZWQnIDogJyd9PiBV' +
  'c2UgYXMgdGhlIGRlZmF1bHQgdGVtcGxhdGU8L2xhYmVsPgogICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDox' +
  'MnB4Ij4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0ic2F2ZSI+U2F2ZTwvYnV0dG9uPgogICAgICA8YnV0dG9uIGNsYXNz' +
  'PSJidG4gc2VjIiBpZD0icHJldmlldyI+UHJldmlldyB3aXRoIHJlYWwgam9iPC9idXR0b24+CiAgICAgIDxidXR0b24gY2xhc3M9' +
  'ImJ0biBzZWMiIG9uY2xpY2s9ImNsb3NlU2hlZXQoKSI+Q2FuY2VsPC9idXR0b24+CiAgICAgICR7dCA/ICc8YnV0dG9uIGNsYXNz' +
  'PSJidG4gZ2hvc3QiIGlkPSJkZWwiIHN0eWxlPSJjb2xvcjp2YXIoLS1iYWQpO21hcmdpbi1sZWZ0OmF1dG8iPkRlbGV0ZTwvYnV0' +
  'dG9uPicgOiAnJ30KICAgIDwvZGl2PgogICAgPHByZSBjbGFzcz0icHJldiIgaWQ9InRwcmV2IiBzdHlsZT0iZGlzcGxheTpub25l' +
  'O21hcmdpbi10b3A6MTJweCI+PC9wcmU+YCwgZWwgPT4gewogICAgY29uc3QgdGEgPSBlbC5xdWVyeVNlbGVjdG9yKCcjdF9ib2R5' +
  'Jyk7CiAgICBlbC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1mXScpLmZvckVhY2goYiA9PiBiLm9uY2xpY2sgPSAoKSA9PiB7CiAg' +
  'ICAgIGNvbnN0IHRvayA9ICd7eycgKyBiLmRhdGFzZXQuZiArICd9fSc7CiAgICAgIGNvbnN0IHMgPSB0YS5zZWxlY3Rpb25TdGFy' +
  'dCwgZSA9IHRhLnNlbGVjdGlvbkVuZDsKICAgICAgdGEudmFsdWUgPSB0YS52YWx1ZS5zbGljZSgwLCBzKSArIHRvayArIHRhLnZh' +
  'bHVlLnNsaWNlKGUpOwogICAgICB0YS5mb2N1cygpOyB0YS5zZWxlY3Rpb25TdGFydCA9IHRhLnNlbGVjdGlvbkVuZCA9IHMgKyB0' +
  'b2subGVuZ3RoOwogICAgfSk7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCcjcHJldmlldycpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7' +
  'CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoJy90ZW1wbGF0ZXMvcHJldmlldycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpT' +
  'T04uc3RyaW5naWZ5KHsgYm9keTogdGEudmFsdWUgfSkgfSk7CiAgICAgIGNvbnN0IHAgPSBlbC5xdWVyeVNlbGVjdG9yKCcjdHBy' +
  'ZXYnKTsKICAgICAgcC5zdHlsZS5kaXNwbGF5ID0gJyc7IHAudGV4dENvbnRlbnQgPSByLnRleHQ7CiAgICB9OwogICAgZWwucXVl' +
  'cnlTZWxlY3RvcignI3NhdmUnKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgICBjb25zdCBib2R5ID0gewogICAgICAgIG5h' +
  'bWU6IGVsLnF1ZXJ5U2VsZWN0b3IoJyN0X25hbWUnKS52YWx1ZSwganVyaXNkaWN0aW9uOiBlbC5xdWVyeVNlbGVjdG9yKCcjdF9q' +
  'dXJpc2RpY3Rpb24nKS52YWx1ZSwKICAgICAgICBib2R5OiB0YS52YWx1ZSwgaXNfZGVmYXVsdDogZWwucXVlcnlTZWxlY3Rvcign' +
  'I3RfZGVmYXVsdCcpLmNoZWNrZWQKICAgICAgfTsKICAgICAgaWYgKCFib2R5Lm5hbWUudHJpbSgpKSByZXR1cm4gdG9hc3QoJ0dp' +
  'dmUgdGhlIHRlbXBsYXRlIGEgbmFtZScsIHRydWUpOwogICAgICB0cnkgewogICAgICAgIGF3YWl0ICh0ID8gYXBpKCcvdGVtcGxh' +
  'dGVzLycgKyB0LmlkLCB7IG1ldGhvZDogJ1BBVENIJywgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSkKICAgICAgICAgICAg' +
  'ICAgICA6IGFwaSgnL3RlbXBsYXRlcycsIHsgbWV0aG9kOiAnUE9TVCcsIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpIH0pKTsK' +
  'ICAgICAgICBjbG9zZVNoZWV0KCk7IHRvYXN0KCdTYXZlZCcpOyBnbygnYWRtaW4nKTsKICAgICAgfSBjYXRjaCAoZSkgeyB0b2Fz' +
  'dChlLm1lc3NhZ2UsIHRydWUpOyB9CiAgICB9OwogICAgaWYgKGVsLnF1ZXJ5U2VsZWN0b3IoJyNkZWwnKSkgZWwucXVlcnlTZWxl' +
  'Y3RvcignI2RlbCcpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICAgIGlmICghY29uZmlybSgnRGVsZXRlIHRoaXMgdGVtcGxh' +
  'dGU/JykpIHJldHVybjsKICAgICAgYXdhaXQgYXBpKCcvdGVtcGxhdGVzLycgKyB0LmlkLCB7IG1ldGhvZDogJ0RFTEVURScgfSk7' +
  'CiAgICAgIGNsb3NlU2hlZXQoKTsgdG9hc3QoJ0RlbGV0ZWQnKTsgZ28oJ2FkbWluJyk7CiAgICB9OwogIH0pOwp9CgovKiAtLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gYm9vdCAtLSAqLwpjb25z' +
  'dCBWSUVXUyA9IHsgZGFzaDogZGFzaFZpZXcsIGpvYnM6IGpvYnNWaWV3LCBqb2I6IGpvYlZpZXcsIHNjYW46IHNjYW5WaWV3LAog' +
  'IHRvb2xzOiB0b29sc1ZpZXcsIGZpbmQ6IGZpbmRWaWV3LCBwcm9wZXJ0eTogcHJvcGVydHlWaWV3LCBtb25leTogbW9uZXlWaWV3' +
  'LCBhZG1pbjogYWRtaW5WaWV3IH07Cgphc3luYyBmdW5jdGlvbiByZW5kZXIoKSB7CiAgY2xvc2VTaGVldCgpOwogIGlmICghUy5t' +
  'ZSkgcmV0dXJuIGxvZ2luVmlldygpOwogIGlmIChTLnZpZXcgPT09ICdqb2JzJykgUy5jYWNoZS5qb2JGaWx0ZXIgPSBTLnBhcmFt' +
  'czsKICBjb25zdCBmbiA9IFZJRVdTW1Mudmlld10gfHwgZGFzaFZpZXc7CiAgdHJ5IHsKICAgIGFwcC5pbm5lckhUTUwgPSAnPGRp' +
  'diBjbGFzcz0id3JhcCI+PGRpdiBjbGFzcz0iZW1wdHkiPkxvYWRpbmfigKY8L2Rpdj48L2Rpdj4nOwogICAgYXdhaXQgZm4oKTsK' +
  'ICB9IGNhdGNoIChlKSB7CiAgICBpZiAoUy5tZSkgeyBhcHAuaW5uZXJIVE1MID0gc2hlbGwoYDxkaXYgY2xhc3M9ImNhcmQiPjxk' +
  'aXYgY2xhc3M9ImVtcHR5Ij4ke2VzYyhlLm1lc3NhZ2UpfTwvZGl2PjwvZGl2PmApOyBiaW5kU2hlbGwoKTsgfQogIH0KfQoKKGFz' +
  'eW5jIGZ1bmN0aW9uIGJvb3QoKSB7CiAgdHJ5IHsgUy5tZSA9IGF3YWl0IGFwaSgnL21lJyk7IH0gY2F0Y2ggKGUpIHsgUy5tZSA9' +
  'IG51bGw7IH0KICByZW5kZXIoKTsKfSkoKTsKfSkoKTsKCi8qIC0tLS0gaW5zdGFsbGFibGUgYXBwIC0tLS0tLS0tLS0tLS0tLS0t' +
  'LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0KICAgQSBzZXJ2aWNlIHdvcmtlciBwbHVzIGEgbWFuaWZlc3Qg' +
  'aXMgdGhlIHdob2xlIGRpZmZlcmVuY2UgYmV0d2VlbiBhIHdlYiBwYWdlCiAgIGFuZCBzb21ldGhpbmcgdGhhdCBsaXZlcyBvbiB0' +
  'aGUgaG9tZSBzY3JlZW4gd2l0aCBpdHMgb3duIGljb24gYW5kIG5vIGJyb3dzZXIKICAgYmFycy4gTm8gc3RvcmUsIG5vIHJldmll' +
  'dywgbm8gZGV2ZWxvcGVyIGFjY291bnQuCgogICBUaGUgYmFyIHdhaXRzIGEgY291cGxlIG9mIHNlY29uZHMgc28gaXQgbmV2ZXIg' +
  'bGFuZHMgb24gdG9wIG9mIHdoYXQgc29tZW9uZQogICBpcyByZWFkaW5nLCBhbmQgb25jZSBkaXNtaXNzZWQgaXQgc3RheXMgZGlz' +
  'bWlzc2VkIG9uIHRoYXQgZGV2aWNlLiAgICAgICAgICAqLwooZnVuY3Rpb24gKCkgewogIGlmICgnc2VydmljZVdvcmtlcicgaW4g' +
  'bmF2aWdhdG9yKSB7CiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignbG9hZCcsIGZ1bmN0aW9uICgpIHsKICAgICAgbmF2aWdh' +
  'dG9yLnNlcnZpY2VXb3JrZXIucmVnaXN0ZXIoJy9zdy5qcycpLmNhdGNoKGZ1bmN0aW9uICgpIHt9KTsKICAgIH0pOwogIH0KICB2' +
  'YXIgc3RhbmRhbG9uZSA9IHdpbmRvdy5tYXRjaE1lZGlhKCcoZGlzcGxheS1tb2RlOiBzdGFuZGFsb25lKScpLm1hdGNoZXMKICAg' +
  'ICAgICAgICAgICAgIHx8IHdpbmRvdy5uYXZpZ2F0b3Iuc3RhbmRhbG9uZSA9PT0gdHJ1ZTsKICBpZiAoc3RhbmRhbG9uZSkgcmV0' +
  'dXJuOwoKICB2YXIgS0VZID0gJ3N0X2EyaHMnOwogIHRyeSB7IGlmIChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShLRVkpID09PSAnMScp' +
  'IHJldHVybjsgfSBjYXRjaCAoZSkge30KCiAgdmFyIGlvcyA9IC9pcGhvbmV8aXBhZHxpcG9kL2kudGVzdChuYXZpZ2F0b3IudXNl' +
  'ckFnZW50KTsKICB2YXIgYmFyID0gbnVsbCwgZGVmZXJyZWQgPSBudWxsOwoKICBmdW5jdGlvbiBidWlsZChodG1sKSB7CiAgICBi' +
  'YXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICAgIGJhci5pZCA9ICdhMmhzJzsKICAgIGJhci5pbm5lckhUTUwg' +
  'PSAnPGltZyBjbGFzcz0iYWkiIHNyYz0iL2ljb24tMTkyLnBuZyIgYWx0PSIiPicgKyBodG1sICsKICAgICAgJzxidXR0b24gY2xh' +
  'c3M9IngiIGFyaWEtbGFiZWw9IkRpc21pc3MiPiZ0aW1lczs8L2J1dHRvbj4nOwogICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGls' +
  'ZChiYXIpOwogICAgYmFyLnF1ZXJ5U2VsZWN0b3IoJy54Jykub25jbGljayA9IGZ1bmN0aW9uICgpIHsKICAgICAgYmFyLmNsYXNz' +
  'TGlzdC5yZW1vdmUoJ29uJyk7CiAgICAgIHRyeSB7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKEtFWSwgJzEnKTsgfSBjYXRjaCAoZSkg' +
  'e30KICAgIH07CiAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHsgYmFyLmNsYXNzTGlzdC5hZGQoJ29uJyk7IH0sIDI2MDApOwog' +
  'IH0KCiAgaWYgKGlvcykgewogICAgYnVpbGQoJzxkaXYgY2xhc3M9ImF0Ij48Yj5QdXQgU2VydmVUcmFjayBvbiB5b3VyIGhvbWUg' +
  'c2NyZWVuPC9iPicgKwogICAgICAgICAgJ1RhcCBTaGFyZSwgdGhlbiA8YiBzdHlsZT0iZGlzcGxheTppbmxpbmUiPkFkZCB0byBI' +
  'b21lIFNjcmVlbjwvYj4uPC9kaXY+Jyk7CiAgfSBlbHNlIHsKICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdiZWZvcmVpbnN0' +
  'YWxscHJvbXB0JywgZnVuY3Rpb24gKGV2KSB7CiAgICAgIGV2LnByZXZlbnREZWZhdWx0KCk7CiAgICAgIGRlZmVycmVkID0gZXY7' +
  'CiAgICAgIGlmIChiYXIpIHJldHVybjsKICAgICAgYnVpbGQoJzxkaXYgY2xhc3M9ImF0Ij48Yj5JbnN0YWxsIFNlcnZlVHJhY2s8' +
  'L2I+UnVucyBmdWxsIHNjcmVlbiwgb3BlbnMgc3RyYWlnaHQgdG8geW91ciB3b3JrLjwvZGl2PicgKwogICAgICAgICAgICAnPGJ1' +
  'dHRvbiBpZD0iYTJoc0dvIj5JbnN0YWxsPC9idXR0b24+Jyk7CiAgICAgIHZhciBnbyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlk' +
  'KCdhMmhzR28nKTsKICAgICAgaWYgKGdvKSBnby5vbmNsaWNrID0gZnVuY3Rpb24gKCkgewogICAgICAgIGJhci5jbGFzc0xpc3Qu' +
  'cmVtb3ZlKCdvbicpOwogICAgICAgIGRlZmVycmVkLnByb21wdCgpOwogICAgICAgIGRlZmVycmVkID0gbnVsbDsKICAgICAgICB0' +
  'cnkgeyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShLRVksICcxJyk7IH0gY2F0Y2ggKGUpIHt9CiAgICAgIH07CiAgICB9KTsKICB9Cn0p' +
  'KCk7Cgo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg=='
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
const BUILD = '2026-09-02.29';           // shown in Setup so uploads can be confirmed
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

/* Counties, for narrowing a search.
 *
 * Only one of the sources actually carries a county: the licence roll. The tax
 * rolls and this app's own jobs record a city, so a county filter has to become
 * a list of that county's cities. That list is written out for the counties
 * this business actually works, because a half-remembered list would quietly
 * drop the town somebody lives in — worse than no filter at all.
 *
 * A county that is not listed still narrows the licence roll, and is ignored by
 * the others rather than guessed at. The app says which is which.
 */
const COUNTY_CITIES = {
  HIDALGO: ['MCALLEN', 'EDINBURG', 'MISSION', 'PHARR', 'WESLACO', 'SAN JUAN', 'ALAMO',
    'DONNA', 'MERCEDES', 'ELSA', 'HIDALGO', 'LA JOYA', 'PALMVIEW', 'PENITAS', 'PEÑITAS',
    'SULLIVAN CITY', 'PROGRESO', 'ALTON', 'PALMHURST', 'EDCOUCH', 'LA VILLA', 'GRANJENO'],
  CAMERON: ['BROWNSVILLE', 'HARLINGEN', 'SAN BENITO', 'LOS FRESNOS', 'PORT ISABEL',
    'LA FERIA', 'SANTA ROSA', 'RIO HONDO', 'COMBES', 'PRIMERA', 'SOUTH PADRE ISLAND',
    'LAGUNA VISTA', 'RANCHO VIEJO', 'INDIAN LAKE', 'PALM VALLEY'],
  STARR: ['RIO GRANDE CITY', 'ROMA', 'ESCOBARES', 'LA GRULLA'],
  WILLACY: ['RAYMONDVILLE', 'LYFORD', 'SEBASTIAN', 'SAN PERLITA'],
};

const citiesInCounty = county => COUNTY_CITIES[String(county || '').trim().toUpperCase()] || null;

/* A plate is read off a car in a driveway, in the dark, from a moving start.
 * "DXK 4471", "dxk-4471" and "DXK4471" are the same plate, so spacing and
 * punctuation go.
 *
 * The characters that get confused are a harder call. On a Texas plate the
 * glyphs for 0 and O are deliberately different, but a person copying one into
 * a phone gets them wrong constantly, as with 1 and I, 5 and S, 8 and B. So a
 * second, looser key folds those together and is used only to offer near
 * matches — never to claim two plates are the same. The exact key is what an
 * ordinary search matches on.
 */
const plateKey = p => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const plateLoose = p => plateKey(p)
  .replace(/[O]/g, '0').replace(/[I|L]/g, '1')
  .replace(/[S]/g, '5').replace(/[B]/g, '8')
  .replace(/[Z]/g, '2').replace(/[G]/g, '6');

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
         a.plate, a.plate_state, a.vehicle, a.vin,
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
  /* Vehicles seen while attempting this person. A plate that turns up at two of
     their addresses, or on somebody else's job, is the sort of thing that is
     obvious once written down and invisible while it sits in a notes box. */
  const vehicles = {};

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
      if (a.plate || a.vehicle) {
        const vk = a.plate ? 'P:' + String(a.plate).toUpperCase().replace(/[^A-Z0-9]/g, '')
                           : 'V:' + String(a.vehicle).toUpperCase();
        const v = vehicles[vk] || (vehicles[vk] = {
          /* Shown in its normalised form. Whether it was typed "DXK 4471" or
             "dxk-4471" is an accident of the moment, and showing whichever
             attempt happened to be most recent made the same car look like it
             had two plates. */
          plate: a.plate ? plateKey(a.plate) : '', plate_state: a.plate_state || '',
          vehicle: a.vehicle || '', vin: a.vin || '', times: 0,
          first: null, last: null, places: new Set()
        });
        v.times++;
        if (a.vehicle && !v.vehicle) v.vehicle = a.vehicle;
        if (a.vin && !v.vin) v.vin = a.vin;
        if (a.address_used) v.places.add(a.address_used);
        if (!v.first || a.attempted_at < v.first) v.first = a.attempted_at;
        if (!v.last || a.attempted_at > v.last) v.last = a.attempted_at;
      }
      timeline.push({
        when: a.attempted_at, outcome: a.outcome, manner: a.manner,
        person_served: a.person_served, relationship: a.relationship,
        notes: a.notes, address: a.address_used || j.address1,
        plate: a.plate, plate_state: a.plate_state, vehicle: a.vehicle,
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
    vehicles: Object.values(vehicles)
      .map(v => Object.assign({}, v, { places: [...v.places] }))
      .sort((a, b) => b.times - a.times),
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
/* City, county and state narrow a search. County becomes a list of cities,
   because a job records a city and not a county — see COUNTY_CITIES. */
function placeClause(query, params) {
  const out = [];
  const city = String(query.city || '').trim();
  const state = String(query.state || '').trim();
  const county = String(query.county || '').trim();

  if (city) { params.push('%' + city + '%'); out.push(`j.city ILIKE $${params.length}`); }
  if (state) { params.push(state); out.push(`upper(j.state) = upper($${params.length})`); }
  if (county) {
    const cities = citiesInCounty(county);
    if (cities) {
      params.push(cities);
      out.push(`upper(j.city) = ANY($${params.length}::text[])`);
    }
    // A county with no city list of its own narrows nothing here, rather than
    // narrowing to nothing. The app tells the person that.
  }
  return out.length ? ' AND ' + out.join(' AND ') : '';
}

const countyKnown = c => !c || Boolean(citiesInCounty(c));

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
  const place = placeClause(req.query, params);
  const { rows: jobs } = await q(
    `${PEOPLE_SQL} AND ${clauses.join(' AND ') || 'TRUE'}${place}
     ORDER BY j.created_at DESC LIMIT 400`,
    params);
  if (!jobs.length) {
    return res.json({ people: [], county_known: countyKnown(req.query.county) });
  }

  const { rows: attempts } = await q(ATTEMPTS_FOR, [jobs.map(j => j.id)]);

  const groups = {};
  for (const j of jobs) {
    const k = nameKey(j.recipient_name);
    (groups[k] = groups[k] || []).push(j);
  }
  const people = Object.entries(groups)
    .map(([key, list]) => Object.assign({ key }, buildPerson(list, attempts)))
    .sort((a, b) => b.stats.jobs - a.stats.jobs);

  res.json({
    people: supportView(req) ? people.map(maskPerson) : people,
    county_known: countyKnown(req.query.county)
  });
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

  const params = [req.companyId, '%' + term + '%'];
  const place = placeClause(req.query, params);
  const { rows: jobs } = await q(
    `${PEOPLE_SQL} AND (j.address1 ILIKE $2 OR j.address2 ILIKE $2)${place}
     ORDER BY j.created_at DESC LIMIT 400`,
    params);

  /* Attempts can record an address that is not the one on the job — a work
     address, a relative's house — so those are searched too. */
  const p2 = [req.companyId, '%' + term + '%'];
  const place2 = placeClause(req.query, p2);
  const { rows: viaAttempt } = await q(
    `${PEOPLE_SQL.replace('WHERE j.company_id = $1', `
       WHERE j.company_id = $1 AND j.id IN (
         SELECT a.job_id FROM attempts a WHERE a.address_used ILIKE $2)`)}${place2}
     ORDER BY j.created_at DESC LIMIT 400`,
    p2);

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
/* Turn the city / county / state boxes into extra conditions for a Socrata
   dataset. Only the fields a given dataset actually has can be used, so each
   source says which of its columns hold the city. */
function socrataPlace(where, q, cityCols) {
  const city = String(q.city || '').trim().toUpperCase();
  const county = String(q.county || '').trim();
  const bits = [where];

  if (city && cityCols.length) {
    bits.push('(' + cityCols.map(c => `upper(${c}) like '%${soql(city)}%'`).join(' OR ') + ')');
  } else if (county && cityCols.length) {
    const list = citiesInCounty(county);
    if (list) {
      bits.push('(' + cityCols.map(c =>
        `upper(${c}) in (${list.map(x => `'${soql(x)}'`).join(',')})`).join(' OR ') + ')');
    }
  }
  return bits.filter(Boolean).join(' AND ');
}

const SOURCES = {
  franchise: {
    label: 'Texas franchise taxpayers',
    what: 'Companies registered with the Comptroller',
    async byName(name, q = {}) {
      const where = socrataPlace(
        `upper(taxpayer_name) like '%${soql(name.toUpperCase())}%'`, q, ['taxpayer_city']);
      const rows = await getJson(`${SOCRATA}9cir-efmm.json?$limit=25&$where=` +
        encodeURIComponent(where));
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
    async byName(name, q = {}) {
      const n = soql(name.toUpperCase());
      const where = socrataPlace(
        `(upper(taxpayer_name) like '%${n}%' OR upper(outlet_name) like '%${n}%')`,
        q, ['outlet_city', 'taxpayer_city']);
      const rows = await getJson(`${SOCRATA}jrea-zgmq.json?$limit=25&$where=` +
        encodeURIComponent(where));
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
    async byAddress(addr, q = {}) {
      const a = soql(addr.toUpperCase());
      const where = socrataPlace(`upper(outlet_address) like '%${a}%'`, q, ['outlet_city']);
      const rows = await getJson(`${SOCRATA}jrea-zgmq.json?$limit=25&$where=` +
        encodeURIComponent(where));
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
    async byName(name, q = {}) {
      const n = soql(name.toUpperCase());
      /* The one source with a genuine county column, and no city at all — so
         county narrows it properly and a city cannot. */
      const county = String(q.county || '').trim().toUpperCase();
      const where = [`(upper(owner_name) like '%${n}%' OR upper(business_name) like '%${n}%')`,
        county ? `upper(business_county) = '${soql(county)}'` : ''].filter(Boolean).join(' AND ');
      const rows = await getJson(`${SOCRATA}7358-krk7.json?$limit=25&$where=` +
        encodeURIComponent(where));
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
    async byName(name, q = {}) {
      /* This one wants the name split, and will not take a bare surname
         without a state. It takes a city natively; it has no notion of a
         county, so a county narrows it only through its cities. */
      const parts = String(name).trim().split(/[\s,]+/).filter(Boolean);
      const last = parts.length > 1 ? parts[parts.length - 1] : parts[0];
      const first = parts.length > 1 ? parts[0] : '';
      const state = String(q.state || 'TX').trim().toUpperCase().slice(0, 2) || 'TX';
      const city = String(q.city || '').trim();
      const url = NPI_BASE + (NPI_BASE.includes('?') ? '&' : '?') +
        `version=2.1&limit=20&state=${encodeURIComponent(state)}` +
        (city ? `&city=${encodeURIComponent(city)}` : '') +
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
      /* This service has no county, so a county is applied to what comes back
         rather than to the question. Only for a county whose towns are known;
         otherwise everything is kept, since dropping results on a guess would
         hide the address somebody actually lives at. */
      const towns = citiesInCounty(q.county);
      if (towns && !city) {
        const inCounty = out.filter(r => towns.includes(String(r.city).toUpperCase()));
        return inCounty.length ? inCounty : out;
      }
      return out;
    }
  }
};

/* Ask them all at once. One slow or broken source must not delay or spoil the
   others, so each is raced against its own timeout and reported separately —
   "couldn't reach it" is a different answer from "nothing found", and a person
   deciding where to knock deserves to know which one they got. */
async function publicRecords(kind, term, where = {}) {
  const key = [kind, term, where.city || '', where.county || '', where.state || '']
    .join('|').toUpperCase();
  const hit = publicCache.get(key);
  if (hit && Date.now() - hit.at < PUBLIC_CACHE_MS) return hit.out;

  const usable = Object.entries(SOURCES).filter(([, s]) => s[kind]);
  const out = await Promise.all(usable.map(async ([id, s]) => {
    const started = Date.now();
    try {
      const results = await s[kind](term, where);
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
  const where = {
    city: String(req.query.city || '').trim(),
    county: String(req.query.county || '').trim(),
    state: String(req.query.state || '').trim()
  };
  const sources = name
    ? await publicRecords('byName', name, where)
    : await publicRecords('byAddress', address, where);

  res.json({
    sources,
    county_known: countyKnown(where.county),
    note: 'Public records. A lead to go and check, not a fact — nothing here ' +
          'has been added to your records.'
  });
}));

/* -------------------------------------------------------------- plates --- */
/* The same plate at two addresses is a connection nothing else will give you.
 *
 * A registered owner cannot be looked up here — that is a DMV record, and
 * getting at one lawfully means a credentialed account with a vendor who logs
 * why you asked. Serving process is a permissible reason to ask; it is the
 * access that is gated, not the purpose. What this does is search what you
 * yourself wrote down from the kerb, which costs nothing and is often enough.
 */
app.get('/api/plates', auth, wrap(async (req, res) => {
  const raw = String(req.query.q || '').trim();
  if (plateKey(raw).length < 3) return res.json({ plates: [] });

  const key = plateKey(raw);
  const loose = plateLoose(raw);

  /* Only this company's attempts, and for anyone but an admin only their own
     jobs — the same rule the rest of the app follows. */
  const mineOnly = isAdmin(req.user) ? '' : ' AND j.assigned_to = $3';
  const params = [req.companyId, '%' + key + '%'];
  if (mineOnly) params.push(req.user.id);

  const { rows } = await q(
    `SELECT a.id, a.plate, a.plate_state, a.plate_key, a.vehicle, a.vin,
            a.attempted_at, a.outcome, a.address_used, a.notes,
            j.id AS job_id, j.job_number, j.recipient_name, j.city, j.state,
            u.name AS server_name
       FROM attempts a
       JOIN jobs j ON j.id = a.job_id
       LEFT JOIN users u ON u.id = a.server_id
      WHERE j.company_id = $1 AND a.plate_key IS NOT NULL
        AND a.plate_key LIKE $2${mineOnly}
      ORDER BY a.attempted_at DESC LIMIT 200`,
    params);

  /* Anything the loose key matches but the exact one does not is offered as a
     "did you mean" rather than mixed in — an O read as a 0 is a guess, and a
     guess must look like one. */
  const { rows: near } = await q(
    `SELECT a.id, a.plate, a.plate_state, a.plate_key, a.vehicle,
            a.attempted_at, a.outcome, a.address_used,
            j.id AS job_id, j.job_number, j.recipient_name
       FROM attempts a
       JOIN jobs j ON j.id = a.job_id
      WHERE j.company_id = $1 AND a.plate_key IS NOT NULL
        AND a.plate_key NOT LIKE $2${mineOnly}
      ORDER BY a.attempted_at DESC LIMIT 400`,
    params);

  const sightings = {};
  for (const r of rows) {
    const k = r.plate_key;
    const p = sightings[k] || (sightings[k] = {
      // The normalised form, for the same reason as above.
      plate: plateKey(r.plate), plate_state: r.plate_state, key: k,
      vehicle: '', vin: '', people: {}, places: {}, seen: []
    });
    if (r.vehicle && !p.vehicle) p.vehicle = r.vehicle;
    if (r.vin && !p.vin) p.vin = r.vin;
    p.people[nameKey(r.recipient_name)] =
      { key: nameKey(r.recipient_name), name: r.recipient_name };
    const where = r.address_used || '';
    if (where) p.places[addrKey(where)] = where;
    p.seen.push({
      when: r.attempted_at, outcome: r.outcome, address: where,
      job_number: r.job_number, job_id: r.job_id, who: r.recipient_name,
      server: r.server_name, notes: r.notes, vehicle: r.vehicle
    });
  }

  const plates = Object.values(sightings).map(p => Object.assign({}, p, {
    people: Object.values(p.people),
    places: Object.values(p.places),
    times: p.seen.length
  })).sort((a, b) => b.times - a.times);

  const maybe = near
    .filter(r => plateLoose(r.plate) === loose)
    .slice(0, 8)
    .map(r => ({ plate: r.plate, plate_state: r.plate_state, vehicle: r.vehicle,
                 who: r.recipient_name, when: r.attempted_at }));

  res.json({
    plates: supportView(req) ? plates.map(maskPlate) : plates,
    maybe: supportView(req) ? [] : maybe,
    note: plates.length > 1 || (plates[0] && plates[0].places.length > 1)
      ? 'Seen at more than one address — the same vehicle in two places is worth a look.'
      : ''
  });
}));

function maskPlate(p) {
  return Object.assign({}, p, {
    people: (p.people || []).map(x => Object.assign({}, x, { name: '—' })),
    places: (p.places || []).map(() => '—'),
    seen: (p.seen || []).map(s => Object.assign({}, s,
      { address: '—', who: '—', notes: maskText(s.notes) }))
  });
}

/* Decode a VIN. Free, no key, and it answers about the car and nothing about
   the person — which is exactly why it is available and a plate lookup is not. */
app.get('/api/vin/:vin', auth, wrap(async (req, res) => {
  const vin = String(req.params.vin || '').trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{11,17}$/.test(vin)) {
    return res.status(400).json({ error: 'That does not look like a VIN' });
  }
  try {
    const base = process.env.VIN_BASE || 'https://vpic.nhtsa.dot.gov/api/vehicles/';
    const data = await getJson(`${base}DecodeVinValues/${encodeURIComponent(vin)}?format=json`, 9000);
    const r = (data.Results || [])[0] || {};
    const pick = k => String(r[k] || '').trim();
    const out = {
      vin,
      year: pick('ModelYear'), make: titleCaseName(pick('Make')), model: pick('Model'),
      body: pick('BodyClass'), trim: pick('Trim'), colour: '',
      drive: pick('DriveType'), fuel: pick('FuelTypePrimary'), plant: pick('PlantCountry')
    };
    out.summary = [out.year, out.make, out.model, out.body].filter(Boolean).join(' ');
    if (!out.summary) return res.json({ ok: false, error: 'Nothing came back for that VIN' });
    res.json({ ok: true, vehicle: out });
  } catch (e) {
    console.warn('VIN decode failed:', e.message);
    res.json({ ok: false, error: "Couldn't reach the VIN service — " + e.message });
  }
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
      ['person_served', 'relationship', 'notes', 'address', 'plate', 'vehicle'])),
    /* A plate identifies a car, and through it a person — it belongs behind the
       same curtain as a name. */
    vehicles: (p.vehicles || []).map(v => Object.assign({}, v,
      { plate: '—', vehicle: '—', vin: '', places: [] }))
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
  const plate = String(b.plate || '').trim().toUpperCase();
  const { rows } = await q(
    `INSERT INTO attempts (job_id,server_id,attempted_at,outcome,manner,person_served,relationship,
       description,notes,lat,lng,accuracy_m,address_used,
       plate,plate_state,plate_key,vehicle,vin)
     VALUES ($1,$2,COALESCE($3,NOW()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [job.id, req.user.id, b.attempted_at || null, b.outcome, b.manner || null, b.person_served || null,
     b.relationship || null, b.description || null, b.notes || null,
     b.lat ?? null, b.lng ?? null, b.accuracy_m ?? null, addr,
     plate || null,
     String(b.plate_state || '').trim().toUpperCase().slice(0, 2) || null,
     plate ? plateKey(plate) : null,
     String(b.vehicle || '').trim() || null,
     String(b.vin || '').trim().toUpperCase() || null]
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
