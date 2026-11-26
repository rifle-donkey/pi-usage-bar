import assert from 'node:assert/strict';
import test from 'node:test';
import * as usage from '../src/usage.ts';
import { blank, configText, host, json, LOGIN, MIN, NOW, ok, quota, RESET, settle, until } from './fixtures/host.mjs';

function copilot(t, run, options = {}) {
  return host(t, { provider: 'github-copilot', config: configText(LOGIN.toLowerCase()), ...options }, run);
}

const sequence = ['user', 'copilot_internal/user', 'user'];
const endpoints = s => s.calls.map(c => c.endpoint);
const premium = /enterprise · premium 20% \(6d 3h\)/;

function parse(data) {
  assert.equal(typeof usage.parseCopilotQuota, 'function', 'missing parseCopilotQuota export');
  return usage.parseCopilotQuota(data, NOW);
}

test('AC4 D1 Copilot parser returns used share, UTC reset and command details', () => {
  const data = { ...quota(), quota: { entitlement: 10_000, remaining: 9980, percent_remaining: 99.8, unlimited: false } };
  const { snapshot, quota: details } = parse(data);
  assert.equal(snapshot.plan, 'enterprise');
  assert.equal(snapshot.windows.length, 1);
  assert.equal(snapshot.windows[0].label, 'premium');
  assert.ok(Math.abs(snapshot.windows[0].usedPercent - 0.2) < 1e-9);
  assert.equal(snapshot.windows[0].resetsAt, Date.parse(`${RESET}T00:00:00Z`));
  assert.deepEqual(details, { entitlement: 10_000, remaining: 9980, percent: 99.8, reset: RESET, fetchedAt: NOW });
  assert.equal(parse({ ...quota(), quota: { ...quota().quota, percent_remaining: 79 } }).snapshot.windows[0].usedPercent, 21);
  assert.equal(parse(quota(100)).snapshot.windows[0].usedPercent, 0);
  assert.equal(parse(quota(0)).snapshot.windows[0].usedPercent, 100);
});

test('AC4 Copilot parser preserves quota shape, range, consistency and date validation', () => {
  const q = quota();
  parse(q);
  const bad = [null, {}, { ...q, plan: 'individual' }, { ...q, reset: '2026-02-31' },
    { ...q, reset: '2026-2-01' }, { ...q, quota: null }];
  for (const patch of [{ unlimited: true }, { unlimited: undefined }, { entitlement: 0 }, { entitlement: Infinity },
    { remaining: -1 }, { remaining: 101 }, { remaining: '80' }, { percent_remaining: 10 }, { percent_remaining: -1 },
    { percent_remaining: 101 }, { percent_remaining: NaN }]) bad.push({ ...q, quota: { ...q.quota, ...patch } });
  for (const value of bad) assert.throws(() => parse(value));
});

test('AC4 T2 Copilot checks the configured account on github.com before and after quota; no status entry', async t => {
  await copilot(t, async s => {
    s.oauthEnabled = false;
    await s.start();
    await s.waitBorder(premium);
    assert.deepEqual(endpoints(s), sequence);
    for (const call of s.calls) {
      assert.equal(call.cmd, 'gh');
      assert.deepEqual(call.args.slice(0, 5), ['api', '--hostname', 'github.com', call.endpoint, '--jq']);
      assert.equal(call.args[5], call.endpoint === 'user' ? '.login' :
        '{plan: .copilot_plan, reset: .quota_reset_date, quota: .quota_snapshots.premium_interactions}');
      assert.equal(call.args.length, 6);
      assert.equal(call.opts.timeout, 10_000);
      assert.equal(call.opts.maxBuffer, 16_384);
    }
    assert.deepEqual(s.requests, []);
    assert.deepEqual(s.statuses, []);
    assert.deepEqual(s.prompts, []);
  });
});

test('D4 Copilot shares 60 s turn/switch cooldown and five-minute idle cadence; shutdown stops it', async t => {
  await copilot(t, async s => {
    await s.start();
    await s.waitBorder(premium);
    await s.end();
    await s.select('unknown');
    await s.select('github-copilot');
    await settle();
    assert.deepEqual(endpoints(s), sequence);
    for (let i = 0; i < 4; i++) { s.tick(MIN); await settle(); }
    assert.deepEqual(endpoints(s), sequence, 'Copilot refreshed before the fifth tick');
    s.tick(MIN);
    await until(() => s.calls.length >= 6, 'fifth tick did not refresh Copilot');
    await settle();
    assert.deepEqual(endpoints(s), [...sequence, ...sequence]);
    s.tick(MIN);
    await s.end();
    await until(() => s.calls.length >= 9, 'turn end did not refresh at the 60 s boundary');
    await s.shutdown();
    const renders = s.renders.length;
    for (let i = 0; i < 6; i++) { s.tick(MIN); await settle(); }
    assert.equal(s.calls.length, 9);
    assert.equal(s.renders.length, renders);
  });
});

test('T2 Copilot pre-check mismatch stops quota call and clears cached details', async t => {
  await copilot(t, async s => {
    await s.start();
    await s.waitBorder(premium);
    s.login = 'different-account';
    await s.command();
    assert.deepEqual(endpoints(s), [...sequence, 'user']);
    assert.match(s.border(), /account mismatch/);
    assert.match(s.notices.at(-1).text, /account mismatch/);
    assert.doesNotMatch(s.notices.at(-1).text, /Remaining:|Used:|Last updated:|different-account|Sample-Account/i);
  });
});

for (const [name, failedQuota] of [
  ['success', () => ok(JSON.stringify(quota(61)))],
  ['nonzero exit', () => ({ code: 1, stdout: 'synthetic-error-marker' })],
  ['timeout', () => ({ code: 0, killed: true, stdout: 'synthetic-error-marker' })],
  ['truncation', () => ({ code: 0, truncated: true, stdout: 'synthetic-error-marker' })],
  ['exception', () => { throw new Error('synthetic-error-marker'); }],
  ['invalid JSON', () => ok('synthetic-error-marker')],
  ['invalid quota', () => ok('{}')],
]) {
  test(`D10 Copilot post-check after quota ${name}: mismatch takes precedence`, async t => {
    await copilot(t, async s => {
      await s.start();
      await s.waitBorder(premium);
      let attemptedQuota = false;
      s.exec = async ({ endpoint }) => {
        if (endpoint === 'user') return ok(attemptedQuota ? 'different-account' : LOGIN);
        attemptedQuota = true;
        return failedQuota();
      };
      await s.command();
      assert.deepEqual(endpoints(s), [...sequence, ...sequence]);
      assert.match(s.border(), /account mismatch/);
      assert.doesNotMatch(s.border(), /premium|stale/);
      assert.equal(s.notices.at(-1).level, 'warning');
      assert.match(s.notices.at(-1).text, /account mismatch/);
      assert.doesNotMatch(JSON.stringify([s.border(), s.notices, s.logs]), /synthetic-error-marker|different-account|Sample-Account|Remaining:/i);
    }, { captureConsole: true });
  });
}

test('AC4 D11 Copilot failed refresh is stale, retains last success details and keeps stale at width 12', async t => {
  await copilot(t, async s => {
    await s.start();
    await s.waitBorder(premium);
    s.tick(MIN);
    await settle();
    s.exec = async ({ endpoint }) => endpoint === 'user' ? ok(LOGIN) : { code: 1, stderr: 'synthetic-raw-error' };
    await s.command();
    assert.deepEqual(endpoints(s), [...sequence, ...sequence]);
    assert.match(s.border(), /premium 20%.*stale/);
    assert.equal(s.border(12), '──── stale ─');
    const { text, level } = s.notices.at(-1);
    assert.equal(level, 'warning');
    for (const fragment of ['Remaining: 80 / 100 (80%)', 'Used: 20', `Reset: ${RESET}`, `Last updated: ${new Date(NOW).toLocaleString()}`]) {
      assert.ok(text.includes(fragment), `missing detail: ${fragment}`);
    }
    assert.doesNotMatch(JSON.stringify([s.border(), s.notices, s.logs]), /synthetic-raw-error|Sample-Account/i);
  }, { captureConsole: true });
});

for (const failure of ['missing gh', 'invalid identity output', 'post-check failure']) {
  test(`T2 Copilot ${failure} is usage unavailable without old quota, not mismatch`, async t => {
    await copilot(t, async s => {
      s.exec = async ({ endpoint }) => {
        if (failure === 'missing gh') throw new Error('synthetic missing command');
        if (failure === 'invalid identity output') return ok('{');
        if (endpoint !== 'user') return ok(JSON.stringify(quota()));
        if (s.calls.length > 1) return { code: 1, stdout: '' };
        return ok(LOGIN);
      };
      await s.start();
      await s.waitBorder(/usage unavailable/);
      assert.deepEqual(endpoints(s), failure === 'post-check failure' ? sequence : ['user']);
    });
  });
}

test('AC5 other models do not automatically invoke gh or prompt, even through idle ticks', async t => {
  await host(t, { provider: 'unknown' }, async s => {
    await s.start();
    for (const provider of ['anthropic', 'openai-codex', 'cursor', undefined]) {
      await s.select(provider);
      await s.end();
      for (let i = 0; i < 6; i++) { s.tick(MIN); await settle(); }
    }
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.prompts, []);
    assert.deepEqual(s.statuses, []);
  });
});

test('D8 B2 explicit command starts and finishes across a model switch; results stay off other borders', async t => {
  await copilot(t, async s => {
    const gate = Promise.withResolvers();
    s.exec = async ({ endpoint }) => endpoint === 'user' ? ok(LOGIN) : gate.promise;
    s.fetch = async () => json({ five_hour: { utilization: 10 } });
    await s.start();
    await s.waitBorder(/5h 10%/);
    const command = s.command();
    try {
      await until(() => s.calls.length >= 2, 'explicit command did not try quota on a non-Copilot model');
      await s.select('unknown');
      gate.resolve(ok(JSON.stringify(quota())));
      await command;
      assert.deepEqual(endpoints(s), sequence);
      assert.equal(s.notices.at(-1).level, 'info');
      assert.match(s.notices.at(-1).text, /Used: 20/);
      assert.equal(s.border(), blank());
      await s.select('github-copilot');
      await s.waitBorder(premium);
      assert.deepEqual(endpoints(s), sequence, 'explicit result did not populate the Copilot cache');
    } finally { gate.resolve(ok(JSON.stringify(quota()))); await command; }
  }, { provider: 'anthropic' });
});

test('B2 explicit command does not join obsolete automatic Copilot work or publish its results', async t => {
  await copilot(t, async s => {
    const late = Promise.withResolvers();
    s.exec = async ({ endpoint }) => endpoint === 'user' ? ok(LOGIN) :
      s.calls.length === 2 ? late.promise : ok(JSON.stringify(quota()));
    await s.start();
    try {
      await until(() => s.calls.length === 2, 'automatic quota lookup did not start');
      await s.select('unknown');
      const command = s.command();
      await until(() => s.notices.some(n => /Used: 20/.test(n.text)), 'explicit command joined obsolete automatic work');
      await command;
      assert.deepEqual(endpoints(s), ['user', 'copilot_internal/user', ...sequence]);
      const renders = s.renders.length;
      late.resolve(ok(JSON.stringify(quota(9))));
      await settle();
      assert.equal(s.calls.length, 5, 'obsolete automatic quota ran a post-check');
      assert.equal(s.renders.length, renders, 'obsolete automatic quota rendered');
      assert.equal(s.border(), blank());
    } finally { late.resolve(ok(JSON.stringify(quota()))); }
  });
});
