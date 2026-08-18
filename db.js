const fs = require('fs');
const path = require('path');
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
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await q(sql);

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

  const t = await q('SELECT count(*)::int AS n FROM affidavit_templates');
  if (!t.rows[0].n) {
    await q(
      `INSERT INTO affidavit_templates (name, jurisdiction, body, is_default)
       VALUES ($1,$2,$3,TRUE)`,
      ['General Affidavit of Service', 'Generic', DEFAULT_TEMPLATE]
    );
  }
}

module.exports = { q, pool, init, DEFAULT_TEMPLATE };
