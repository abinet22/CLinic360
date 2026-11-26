import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { initDatabase } from './server/db.ts';
import router from './server/routes.ts';

async function main() {
  await initDatabase();
  const app = express();
  app.use(express.json());
  app.use('/api', router);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind ephemeral port');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  async function loginAs(email: string) {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Clinic360!' }),
    });
    const body = (await res.json()) as {
      token?: string;
      requires2fa?: boolean;
      challengeId?: string;
      devVerificationCode?: string;
      dashboard_type?: string;
      defaultDashboard?: string;
      error?: string;
    };
    assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(body)}`);
    if (body.requires2fa && body.challengeId && body.devVerificationCode) {
      const verRes = await fetch(`${baseUrl}/api/auth/verify-2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: body.challengeId, code: body.devVerificationCode }),
      });
      const verBody = (await verRes.json()) as { token?: string; dashboard_type?: string };
      assert.equal(verRes.status, 200, `2FA failed for ${email}: ${JSON.stringify(verBody)}`);
      return { token: verBody.token!, body: verBody };
    }
    return { token: body.token!, body };
  }

  async function apiGet(path: string, token: string) {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  }

  const roleAccounts: Array<{ email: string; expectedDashboard: string; ownEndpoint: string; forbiddenEndpoint: string }> = [
    { email: 'adm@clinic360.local', expectedDashboard: 'admin', ownEndpoint: '/api/dashboard/admin', forbiddenEndpoint: '' },
    { email: 'doc@clinic360.local', expectedDashboard: 'doctor', ownEndpoint: '/api/dashboard/doctor', forbiddenEndpoint: '/api/dashboard/admin' },
    { email: 'nur@clinic360.local', expectedDashboard: 'nurse', ownEndpoint: '/api/dashboard/nurse', forbiddenEndpoint: '/api/dashboard/cashier' },
    { email: 'csh@clinic360.local', expectedDashboard: 'cashier', ownEndpoint: '/api/dashboard/cashier', forbiddenEndpoint: '/api/dashboard/lab' },
    { email: 'lab@clinic360.local', expectedDashboard: 'lab', ownEndpoint: '/api/dashboard/lab', forbiddenEndpoint: '/api/dashboard/radiology' },
    { email: 'img@clinic360.local', expectedDashboard: 'radiology', ownEndpoint: '/api/dashboard/radiology', forbiddenEndpoint: '/api/dashboard/pharmacy' },
    { email: 'pha@clinic360.local', expectedDashboard: 'pharmacy', ownEndpoint: '/api/dashboard/pharmacy', forbiddenEndpoint: '/api/dashboard/hr' },
    { email: 'hro@clinic360.local', expectedDashboard: 'hr', ownEndpoint: '/api/dashboard/hr', forbiddenEndpoint: '/api/dashboard/doctor' },
    { email: 'acc@clinic360.local', expectedDashboard: 'accounting', ownEndpoint: '/api/dashboard', forbiddenEndpoint: '/api/dashboard/admin' },
    { email: 'mgr@clinic360.local', expectedDashboard: 'general', ownEndpoint: '/api/dashboard', forbiddenEndpoint: '/api/dashboard/cashier' },
  ];

  let doc1QueueCount = 0;
  for (const tc of roleAccounts) {
    const { token } = await loginAs(tc.email);
    const me = await apiGet('/api/auth/me', token);
    assert.equal(me.status, 200, `/api/auth/me failed for ${tc.email}`);
    assert.ok(Array.isArray(me.json.roles), `${tc.email} missing roles`);
    assert.ok(Array.isArray(me.json.permissions), `${tc.email} missing permissions`);
    assert.ok(Array.isArray(me.json.departments), `${tc.email} missing departments`);
    assert.ok(Array.isArray(me.json.clinic_units), `${tc.email} missing clinic_units`);
    assert.equal(
      me.json.dashboard_type,
      tc.expectedDashboard,
      `Expected dashboard_type=${tc.expectedDashboard} for ${tc.email}, got ${String(me.json.dashboard_type)}`
    );

    const own = await apiGet(tc.ownEndpoint, token);
    assert.equal(own.status, 200, `${tc.ownEndpoint} returned ${own.status} for ${tc.email}: ${JSON.stringify(own.json)}`);
    assert.ok(own.json.metrics, `${tc.ownEndpoint} missing metrics object`);

    if (tc.email === 'doc@clinic360.local') {
      const m = own.json.metrics as { waitingQueue: number; assignedPatients: number };
      doc1QueueCount = m.waitingQueue;
      assert.ok(m.assignedPatients > 0, 'doc@clinic360.local should have assigned patients');
    }

    if (tc.forbiddenEndpoint) {
      const denied = await apiGet(tc.forbiddenEndpoint, token);
      assert.equal(
        denied.status,
        403,
        `Expected 403 for ${tc.email} hitting ${tc.forbiddenEndpoint}, got ${denied.status}`
      );
    }
    console.log(`PASS: ${tc.email} -> dashboard=${tc.expectedDashboard}, own=${tc.ownEndpoint}(200), forbidden=${tc.forbiddenEndpoint || 'n/a'}(403)`);
  }

  // Verify doctor scoping isolation between doc@ and doc2@
  const { token: doc2Token } = await loginAs('doc2@clinic360.local');
  const doc2Dash = await apiGet('/api/dashboard/doctor', doc2Token);
  assert.equal(doc2Dash.status, 200);
  const doc2Metrics = doc2Dash.json.metrics as { waitingQueue: number };
  assert.ok(
    doc2Metrics.waitingQueue !== doc1QueueCount || doc2Metrics.waitingQueue === 0,
    'doc2@ should have independent doctor-scoped queue'
  );
  console.log(`PASS: Doctor isolation verified (doc1 queue=${doc1QueueCount}, doc2 queue=${doc2Metrics.waitingQueue})`);

  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
