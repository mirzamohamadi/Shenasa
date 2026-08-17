// k6-sso-burst.js — Shenasa / Kanidm SSO burst load test.
//
// Roadmap (v1.2 "Operations at scale", k6 report): measures how a Kanidm
// 1.10/1.11 server behaves under realistic admin-UI-driven bursts so the
// README's sizing guidance can be published with evidence. Run this AGAINST
// A STAGING SERVER — it creates no data but still produces read load.
//
// Scenarios
// ---------
// 1. session_check  — constant-arrival-rate GET /v1/self with a valid
//    Bearer token (this is exactly what Shenasa fires on boot/navigation;
//    50 concurrent admins ~= 50 in-flight requests worst case).
// 2. people_list    — the heaviest single read the UI issues
//    (GET /v1/person), ramped to the target directory size.
//
// Usage
// -----
//   # 1) Create a service account + read-only API token on the test server:
//   kanidm service-account create k6_probe "k6 probe" idm_service_account_admins \
//     --url https://idm.staging.example.com
//   kanidm service-account api-token generate k6_probe k6 --read-only \
//     --url https://idm.staging.example.com
//   # 2) Run:
//   K6_BASE_URL=https://idm.staging.example.com \
//   K6_TOKEN=<api-token> \
//   K6_RPS=50 K6_DURATION=2m \
//   k6 run docs/load-test/k6-sso-burst.js
//
// Thresholds fail the run if the server can't hold the interactive budget
// Shenasa targets (p95 < 400 ms for session checks, < 1200 ms for the
// people list at up to ~5k entries).

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = (__ENV.K6_BASE_URL || 'https://idm.example.com').replace(/\/+$/, '');
const TOKEN = __ENV.K6_TOKEN || '';
const RPS = Number(__ENV.K6_RPS || 50);
const DURATION = __ENV.K6_DURATION || '2m';

const errRate = new Rate('shenasa_errors');
const selfTrend = new Trend('shenasa_self_ms', true);
const peopleTrend = new Trend('shenasa_people_ms', true);

export const options = {
  scenarios: {
    session_check: {
      executor: 'constant-arrival-rate',
      rate: RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(10, Math.ceil(RPS / 5)),
      maxVUs: Math.max(50, RPS),
      exec: 'sessionCheck',
    },
    people_list: {
      executor: 'constant-arrival-rate',
      rate: Math.max(1, Math.floor(RPS / 10)),
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 5,
      maxVUs: 20,
      exec: 'peopleList',
    },
  },
  thresholds: {
    shenasa_self_ms: ['p(95)<400'],
    shenasa_people_ms: ['p(95)<1200'],
    shenasa_errors: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
  },
};

const HEADERS = {
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/json',
  },
};

export function sessionCheck() {
  const res = http.get(`${BASE}/v1/self`, HEADERS);
  selfTrend.add(res.timings.duration);
  const ok = check(res, { 'self 200': (r) => r.status === 200 });
  errRate.add(!ok);
}

export function peopleList() {
  const res = http.get(`${BASE}/v1/person`, HEADERS);
  peopleTrend.add(res.timings.duration);
  const ok = check(res, { 'people 200': (r) => r.status === 200 });
  errRate.add(!ok);
}
