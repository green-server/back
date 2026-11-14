// End-to-end smoke test against a running backend: node scripts/smoke.js https://green.gsw226.xyz
// Uses throwaway accounts only and deletes every one it created, even when a check fails.
// It never connects an agent or starts a consultation, so nothing runs on a real server.
import { randomBytes } from 'node:crypto';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: node scripts/smoke.js <base URL>');
  process.exit(2);
}
const ORIGIN = new URL(arg).origin;

let n = 0;
let failed = 0;
function check(description, ok, reason = '') {
  n += 1;
  if (ok) console.log(`ok ${n} - ${description}`);
  else {
    failed += 1;
    console.log(`not ok ${n} - ${description}: ${reason}`);
  }
  return ok;
}
const expect = (description, res, status, ok = () => true) =>
  check(description, res.status === status && ok(res.body), `status ${res.status}, body ${JSON.stringify(res.body)?.slice(0, 300)}`);

class Client {
  cookie = '';
  async req(method, path, body) {
    const res = await fetch(ORIGIN + path, {
      method,
      headers: {
        origin: ORIGIN,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const token = res.headers.getSetCookie().find((c) => c.startsWith('gs_token='));
    if (token) this.cookie = token.split(';')[0];
    const text = await res.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, body: parsed };
  }
}

const accounts = []; // { client, email, password, cookie at signup } for cleanup
const newEmail = () => `smoke-${Date.now()}-${randomBytes(4).toString('hex')}@example.invalid`;
const newPassword = () => randomBytes(24).toString('base64url');

async function signup() {
  const client = new Client();
  const email = newEmail();
  const password = newPassword();
  const res = await client.req('POST', '/api/auth/signup', { email, name: 'smoke', password });
  if (res.status === 201) accounts.push({ client, email, password });
  return { client, email, password, res };
}

const isList = (b) => Array.isArray(b);
const isEmptyList = (b) => Array.isArray(b) && b.length === 0;

async function main() {
  // Account
  const a = await signup();
  if (!expect('signup creates an account and a session', a.res, 201, (b) => b?.email === a.email && b.name === 'smoke' && Number.isInteger(b.id))) {
    return;
  }
  check('signup sets the gs_token cookie', a.client.cookie.startsWith('gs_token='), 'no gs_token in Set-Cookie');
  const userId = a.res.body.id;
  expect('GET /api/me returns the new user', await a.client.req('GET', '/api/me'), 200, (b) => b?.id === userId && b.email === a.email);
  expect('PATCH /api/me renames the user', await a.client.req('PATCH', '/api/me', { name: 'smoke renamed' }), 200, (b) => b?.name === 'smoke renamed');
  expect('GET /api/me shows the new name', await a.client.req('GET', '/api/me'), 200, (b) => b?.name === 'smoke renamed');
  expect('PATCH /api/me rejects an empty name', await a.client.req('PATCH', '/api/me', { name: ' ' }), 400, (b) => b?.error?.code === 'validation_error');

  const fresh = new Client();
  expect('login rejects a wrong password', await fresh.req('POST', '/api/auth/login', { email: a.email, password: newPassword() }), 401, (b) => b?.error?.code === 'invalid_credentials');
  expect('login again with the right password', await fresh.req('POST', '/api/auth/login', { email: a.email, password: a.password }), 200, (b) => b?.id === userId);
  expect('the login session reaches /api/me', await fresh.req('GET', '/api/me'), 200, (b) => b?.id === userId);
  expect('no cookie gets 401', await new Client().req('GET', '/api/me'), 401, (b) => b?.error?.code === 'unauthorized');

  // Servers
  const homeBody = { name: 'smoke home', kind: 'home_pc', ratePlan: 'home_tiered', householdKwh: 300 };
  const cloudBody = { name: 'smoke cloud', kind: 'cloud_vm', ratePlan: 'cloud_hourly', hourlyKrw: 120 };
  const homeRes = await a.client.req('POST', '/api/servers', homeBody);
  const cloudRes = await a.client.req('POST', '/api/servers', cloudBody);
  expect('create a home_tiered server', homeRes, 201, (b) =>
    b?.server?.name === 'smoke home' && b.server.kind === 'home_pc' && b.server.powerSource === 'measured' && b.server.householdKwh === 300 && typeof b.agentToken === 'string');
  expect('create a cloud_hourly server', cloudRes, 201, (b) =>
    b?.server?.name === 'smoke cloud' && b.server.powerSource === 'estimated' && b.server.hourlyKrw === 120);
  expect('cloud_hourly without hourlyKrw is rejected', await a.client.req('POST', '/api/servers', { ...cloudBody, hourlyKrw: undefined }), 400, (b) => b?.error?.code === 'validation_error');
  const home = homeRes.body?.server?.id;
  const cloud = cloudRes.body?.server?.id;
  if (!home || !cloud) return;

  expect('list holds exactly the two new servers', await a.client.req('GET', '/api/servers'), 200, (b) =>
    isList(b) && b.length === 2 && b.map((s) => s.id).join() === [home, cloud].sort((x, y) => x - y).join() && b.every((s) => s.online === false));
  expect('get one server with its summary', await a.client.req('GET', `/api/servers/${home}`), 200, (b) =>
    b?.id === home && b.name === 'smoke home' && b.latestWatts === null && typeof b.monthlyKwh === 'number' && typeof b.monthlyKrw === 'number');

  const patch = async (label, id, change, ok) => expect(`PATCH ${label}`, await a.client.req('PATCH', `/api/servers/${id}`, change), 200, ok);
  await patch('name', home, { name: 'smoke home 2' }, (b) => b?.name === 'smoke home 2' && b.kind === 'home_pc');
  await patch('householdKwh', home, { householdKwh: 450 }, (b) => b?.householdKwh === 450);
  await patch('kind to baremetal', home, { kind: 'baremetal' }, (b) => b?.kind === 'baremetal' && b.powerSource === 'measured');
  await patch('kind to cloud_vm makes power estimated', home, { kind: 'cloud_vm' }, (b) => b?.kind === 'cloud_vm' && b.powerSource === 'estimated');
  await patch('ratePlan to cloud_hourly with hourlyKrw', home, { ratePlan: 'cloud_hourly', hourlyKrw: 75.5 }, (b) => b?.ratePlan === 'cloud_hourly' && b.hourlyKrw === 75.5);
  await patch('hourlyKrw', cloud, { hourlyKrw: 99.99 }, (b) => b?.hourlyKrw === 99.99 && b.name === 'smoke cloud');
  expect('PATCH rejects an unknown kind', await a.client.req('PATCH', `/api/servers/${cloud}`, { kind: 'mainframe' }), 400, (b) => b?.error?.code === 'validation_error');
  expect('GET shows the patched fields', await a.client.req('GET', `/api/servers/${home}`), 200, (b) =>
    b?.name === 'smoke home 2' && b.kind === 'cloud_vm' && b.ratePlan === 'cloud_hourly' && b.hourlyKrw === 75.5 && b.householdKwh === 450);

  // Child lists: empty but well-formed
  for (const id of [home, cloud]) {
    expect(`metrics of server ${id} is an empty list`, await a.client.req('GET', `/api/servers/${id}/metrics?range=24h`), 200, isEmptyList);
    expect(`processes of server ${id} is an empty list`, await a.client.req('GET', `/api/servers/${id}/processes`), 200, isEmptyList);
    expect(`recommendations of server ${id} is an empty list`, await a.client.req('GET', `/api/servers/${id}/recommendations`), 200, isEmptyList);
    expect(`consultations of server ${id} is an empty list`, await a.client.req('GET', `/api/servers/${id}/consultations`), 200, isEmptyList);
  }
  expect('metrics rejects an unknown range', await a.client.req('GET', `/api/servers/${home}/metrics?range=1y`), 400, (b) => b?.error?.code === 'validation_error');

  // Joined reads
  expect('activity report lists both servers with zero counts (LEFT JOIN)', await a.client.req('GET', '/api/reports/activity'), 200, (b) => {
    if (!isList(b?.servers) || !isEmptyList(b.calls) || b.servers.length !== 2) return false;
    return [home, cloud].every((id) => {
      const s = b.servers.find((x) => x.serverId === id);
      return s && typeof s.serverName === 'string' && s.total === 0 && s.open === 0 && s.applied === 0 && s.openSavingKrw === 0;
    });
  });
  const wellFormedSavings = (b) =>
    isEmptyList(b?.items) && isList(b.bySource) && b.bySource.length === 2 &&
    ['rule', 'ai'].every((src) => b.bySource.some((s) => s.source === src && s.total === 0 && s.applied === 0 && s.savedKrwMonth === 0)) &&
    b.total?.savedKrwMonth === 0 && b.total.savedCo2KgMonth === 0;
  expect('savings report is well-formed and empty', await a.client.req('GET', '/api/reports/savings'), 200, wellFormedSavings);
  expect('savings report for one server is well-formed', await a.client.req('GET', `/api/reports/savings?serverId=${cloud}`), 200, wellFormedSavings);

  // Another account cannot reach these servers
  const b = await signup();
  if (expect('a second account signs up', b.res, 201, (x) => x?.email === b.email)) {
    expect('the second account sees no servers', await b.client.req('GET', '/api/servers'), 200, isEmptyList);
    expect('the second account cannot read the server', await b.client.req('GET', `/api/servers/${home}`), 404, (x) => x?.error?.code === 'not_found');
    expect('the second account cannot update the server', await b.client.req('PATCH', `/api/servers/${home}`, { name: 'stolen' }), 404);
    expect('the second account cannot delete the server', await b.client.req('DELETE', `/api/servers/${home}`), 404);
    expect('the second account cannot read its metrics', await b.client.req('GET', `/api/servers/${home}/metrics`), 404);
    expect('the second account cannot scope savings to it', await b.client.req('GET', `/api/reports/savings?serverId=${home}`), 404);
    expect('the server is unchanged after those attempts', await a.client.req('GET', `/api/servers/${home}`), 200, (x) => x?.name === 'smoke home 2');
  }

  // Delete
  expect('delete a server', await a.client.req('DELETE', `/api/servers/${home}`), 204);
  expect('the deleted server is gone', await a.client.req('GET', `/api/servers/${home}`), 404);
  expect('list after delete holds only the other server', await a.client.req('GET', '/api/servers'), 200, (x) => isList(x) && x.length === 1 && x[0].id === cloud);
  expect('activity report after delete holds only the other server', await a.client.req('GET', '/api/reports/activity'), 200, (x) =>
    x?.servers?.length === 1 && x.servers[0].serverId === cloud);
}

async function cleanup() {
  for (const { client, email, password } of accounts) {
    // Log in again first: a failed check may have left this client without a working session.
    const me = await client.req('GET', '/api/me');
    if (me.status !== 200) await client.req('POST', '/api/auth/login', { email, password });
    const session = client.cookie;
    expect(`DELETE /api/me removes ${email}`, await client.req('DELETE', '/api/me'), 204);
    client.cookie = session;
    expect(`the deleted session of ${email} gets 401`, await client.req('GET', '/api/me'), 401);
    expect(`login as deleted ${email} fails`, await new Client().req('POST', '/api/auth/login', { email, password }), 401);
  }
}

try {
  await main();
} catch (err) {
  check('run without exceptions', false, err?.stack ?? String(err));
} finally {
  try {
    await cleanup();
  } catch (err) {
    check('cleanup without exceptions', false, `${err?.stack ?? err} -- accounts may remain: ${accounts.map((x) => x.email).join(', ')}`);
  }
}
console.log(`1..${n}`);
console.log(failed ? `# ${failed} of ${n} checks failed` : `# all ${n} checks passed`);
process.exit(failed ? 1 : 0);
