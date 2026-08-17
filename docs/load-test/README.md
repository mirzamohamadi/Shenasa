# Load test report — Kanidm SSO bursts (k6)

Roadmap item (v1.2 / v1.3.0): *“k6 load-test report published in docs: SSO
token-fetch bursts for 50 apps, sizing guidance validated on 1.10/1.11
(script + method; results attached on first operator run).”*

This document ships the **script** (`k6-sso-burst.js`) and the **method**.
The results table below is intentionally blank: numbers must come from a
run against **your** staging hardware — publishing lab numbers from
unrelated hardware would be dishonest sizing guidance.

## Method

1. Stand up a staging Kanidm server with a directory roughly the size of
   production (number of persons matters for `GET /v1/person`).
2. Create a read-only probe identity (never run load tests as `idm_admin`):

   ```bash
   kanidm service-account create k6_probe "k6 probe" idm_service_account_admins
   kanidm service-account api-token generate k6_probe k6 --read-only
   ```

3. Run the script (see header of `k6-sso-burst.js` for all env vars):

   ```bash
   K6_BASE_URL=https://idm.staging.example.com K6_TOKEN=<token> \
     K6_RPS=50 K6_DURATION=2m k6 run docs/load-test/k6-sso-burst.js
   ```

4. Repeat for `K6_RPS=100` and `K6_RPS=200` to find the knee. The run FAILS
   automatically if the thresholds in the script are exceeded
   (p95 `<400 ms` on `/v1/self`, p95 `<1200 ms` on `/v1/person`,
   `<1 %` errors).

## What the load models

Shenasa is a static SPA: browsers talk to Kanidm **directly**, so the UI
adds no proxy hop. The per-admin request profile is:

| UI event | Kanidm requests |
| --- | --- |
| Boot / sign-in | `GET /v1/self`, `GET /v1/self/_uat` |
| Dashboard | `GET /v1/person`, `GET /v1/group`, `GET /v1/domain` |
| Users / Groups / Reports | the same list endpoints (de-duplicated in flight since v1.3.0) |
| Passkey-adoption report | one `GET /v1/person/{id}/_credential/_status` per group member (bounded to 4 concurrent) |

50 admins opening the dashboard within the same minute is therefore a burst
of ≈ 3 requests/admin — well modelled by `K6_RPS=150` worst case.

## Results (fill in on first operator run)

| Date | Kanidm | Hardware (vCPU/RAM) | Directory size | RPS | p95 `/v1/self` | p95 `/v1/person` | Error rate | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _TBD_ | 1.11.0 | _e.g. 2 / 4 GB_ | _e.g. 2,000 persons_ | 50 | _ms_ | _ms_ | _%_ | _pass/fail_ |
| _TBD_ | 1.11.0 | | | 100 | | | | |
| _TBD_ | 1.10.5 | | | 50 | | | | |

## Sizing guidance (updated after each run)

- Kanidm is sibling-cache friendly through 1.11: give the host **2 vCPU /
  4 GB RAM** as the floor for ~2,000 persons; the SSD-backed scratch volume
  matters more than CPU for `/v1/person` list latency.
- Watch `docker stats shenasa-kanidm` during the run; sustained CPU > 80 %
  at target RPS = scale vertically first (Kanidm 1.10/1.11 has no stable
  replication — horizontal HA lands in the v2.0 roadmap).
- If `/v1/person` p95 degrades with directory growth, prefer page-local
  filtering (Shenasa renders max 15 rows per page by design) and keep the
  passkey-adoption report for maintenance windows — it is the only flow
  whose cost scales with group size.
