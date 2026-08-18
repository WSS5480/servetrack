/* Optional demo data: `npm run seed`. Safe to skip in production. */
const bcrypt = require('bcryptjs');
const { q, init } = require('./db');

const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };

(async () => {
  await init();

  const { rows: existing } = await q("SELECT count(*)::int n FROM jobs");
  if (existing[0].n) { console.log('Jobs already exist — skipping demo seed.'); process.exit(0); }

  const hash = await bcrypt.hash('serve1234', 10);
  const server = (await q(
    `INSERT INTO users (name,email,password_hash,role,phone,license_no,county,default_pay)
     VALUES ('Marcus Reed','marcus@example.com',$1,'server','555-0142','PS-44810','Franklin',45)
     ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [hash])).rows[0].id;
  const server2 = (await q(
    `INSERT INTO users (name,email,password_hash,role,phone,license_no,county,default_pay)
     VALUES ('Dana Whitfield','dana@example.com',$1,'server','555-0177','PS-51203','Delaware',40)
     ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [hash])).rows[0].id;

  const c1 = (await q(
    `INSERT INTO clients (name,contact_name,email,phone,address,default_fee)
     VALUES ('Halloran & Pace LLP','Beth Halloran','beth@halloranpace.example','555-0110',
             '80 N High St, Suite 700, Columbus, OH 43215',75) RETURNING id`)).rows[0].id;
  const c2 = (await q(
    `INSERT INTO clients (name,contact_name,email,phone,address,default_fee)
     VALUES ('Keystone Property Group','Ray Ortiz','ray@keystonepg.example','555-0188',
             '2200 Riverside Dr, Columbus, OH 43221',60) RETURNING id`)).rows[0].id;

  const jobs = [
    ['Angela Brooks', '4120 Sunbury Rd', 'Columbus', 'OH', '43219', c1, server, 'Rush', d(-2), 'Summons and Complaint',
      '24CV004182', 'Franklin County Court of Common Pleas', 'Halloran Capital LLC', 'Angela Brooks', 75, 45,
      'Works second shift; best before 2pm. Blue F-150 in drive.'],
    ['Devon Marsh', '918 E Weber Rd', 'Columbus', 'OH', '43211', c1, server, 'Routine', d(4), 'Subpoena Duces Tecum',
      '24CV003991', 'Franklin County Court of Common Pleas', 'State of Ohio', 'Devon Marsh', 75, 45, ''],
    ['Riverbend Holdings LLC', '55 W Broad St, Ste 300', 'Columbus', 'OH', '43215', c1, server2, 'Same Day', d(0),
      'Summons and Complaint', '24CV004215', 'Franklin County Court of Common Pleas', 'Meridian Bank', 'Riverbend Holdings LLC',
      95, 55, 'Serve statutory agent at registered address.'],
    ['Tanya Whitlock', '2601 Cleveland Ave, Apt 12', 'Columbus', 'OH', '43211', c2, server2, 'Routine', d(6),
      '3-Day Notice to Vacate', 'EV-24-0881', 'Franklin County Municipal Court', 'Keystone Property Group', 'Tanya Whitlock',
      60, 40, 'Posting authorized if no personal service after 2 attempts.'],
    ['Gregory Dunn', '780 Kenwick Rd', 'Columbus', 'OH', '43209', c2, null, 'Routine', d(9), 'Eviction Complaint',
      'EV-24-0902', 'Franklin County Municipal Court', 'Keystone Property Group', 'Gregory Dunn', 60, 40, ''],
    ['Helena Voss', '1490 Grandview Ave', 'Grandview Heights', 'OH', '43212', c1, server, 'Routine', d(-6),
      'Summons and Complaint', '24CV003844', 'Franklin County Court of Common Pleas', 'Ardent Medical Group', 'Helena Voss',
      75, 45, 'Two prior attempts by another firm failed.']
  ];

  const F = ['recipient_name','address1','city','state','zip','client_id','assigned_to','priority','due_date',
    'documents','case_number','court','plaintiff','defendant','client_fee','server_pay','recipient_notes'];
  let n = 0;
  const ids = [];
  for (const j of jobs) {
    n++;
    const { rows } = await q(
      `INSERT INTO jobs (job_number,status,${F.join(',')})
       VALUES ($1,$2,${F.map((_, i) => '$' + (i + 3)).join(',')}) RETURNING id`,
      ['ST-' + (10000 + n), j[6] ? 'Assigned' : 'Pending', ...j]);
    ids.push(rows[0].id);
  }

  // a couple of attempts, one successful serve
  await q(`INSERT INTO attempts (job_id,server_id,attempted_at,outcome,notes,lat,lng,accuracy_m)
           VALUES ($1,$2,NOW() - INTERVAL '2 days','No Answer','Lights off, no vehicle present.',39.9987,-82.9331,8)`,
    [ids[0], server]);
  await q(`INSERT INTO attempts (job_id,server_id,attempted_at,outcome,notes,lat,lng,accuracy_m)
           VALUES ($1,$2,NOW() - INTERVAL '1 day','Evading','Curtain moved, no one came to the door.',39.9987,-82.9331,6)`,
    [ids[0], server]);
  await q(`INSERT INTO attempts (job_id,server_id,attempted_at,outcome,manner,person_served,description,notes,lat,lng,accuracy_m)
           VALUES ($1,$2,NOW() - INTERVAL '3 days','Served','Personal','Helena Voss','W/F, approx 50s, 5-6, blonde',
                   'Identified herself; accepted documents at front door.',39.9812,-83.0421,5)`,
    [ids[5], server]);
  await q(`UPDATE jobs SET status='Served', served_at=NOW() - INTERVAL '3 days', served_manner='Personal',
           served_person='Helena Voss' WHERE id=$1`, [ids[5]]);
  await q("UPDATE jobs SET status='Attempted' WHERE id=$1", [ids[0]]);

  console.log('Demo data loaded. Field server logins: marcus@example.com / dana@example.com, password serve1234');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
