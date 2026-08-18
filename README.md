# ServeTrack

Process serving management for a small agency: intake → assignment → GPS-stamped
attempts in the field → affidavit → invoice → contractor pay statement.

Built to cover the four things ServeManager users most often complain about:

1. **Turn-by-turn navigation** — every job hands off to Apple Maps or Google Maps
   with the address preloaded, and "Route my day" opens one multi-stop Google Maps
   route for the whole open list. Deep links only, so there are no mapping API fees.
2. **Custom affidavit templates** — write your own wording per county or client with
   merge fields that fill from the job, including the full attempt log with GPS.
3. **Barcode scanning** — every job gets a Code 128 barcode on its printable cover
   sheet; the Scan tab opens the job from the camera, with manual entry as a fallback.
4. **Contractor pay statements** — per-server statements over any date range, at the
   per-job rate stored on the job, with a printable statement. Jobs are marked once
   they're on a statement so nothing gets paid twice.

Everything works on a phone. Field servers see only their own jobs.

## Running it

```bash
npm install
export DATABASE_URL=postgres://user:pass@host/db
export ADMIN_EMAIL=you@example.com
export ADMIN_PASSWORD='choose-a-strong-one'
export JWT_SECRET='long-random-string'
npm start           # schema is created automatically on first boot
npm run seed        # optional demo data
```

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | first boot | Seeds the first admin account |
| `ADMIN_NAME` | no | Display name for that admin |
| `JWT_SECRET` | yes | Signs session cookies — set a long random value |
| `COMPANY_NAME` | no | Printed on statements and invoices |
| `TIMEZONE` | no | Defaults to `America/New_York`; used for affidavit dates |
| `NODE_ENV` | prod | Set to `production` so cookies are marked secure |

## Deploying to Render

Web service: runtime **node**, build `npm install`, start `npm start`.
Add the environment variables above; point `DATABASE_URL` at the Postgres instance.

## Notes

- Affidavit wording is yours to set. The bundled template is a generic starting point,
  not legal advice — check it against your county's requirements before filing.
- Statements are contractor pay records, not tax filings; no withholding is calculated.
