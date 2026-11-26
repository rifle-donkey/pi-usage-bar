import assert from 'node:assert/strict';
import test from 'node:test';
import * as usage from '../src/usage.ts';
import { blank, cursor, CURSOR_URL, host, json, MIN, oauth, settle, TOKEN, until } from './fixtures/host.mjs';

function parse(data) {
  assert.equal(typeof usage.parseCursorUsage, 'function', 'missing parseCursorUsage export');
  return usage.parseCursorUsage(data);
}

const RESET = Date.parse('2026-12-07T00:00:00Z');
const shape = snapshot => snapshot.windows.map(w => [w.label, w.usedPercent, w.resetsAt]);

test('AC2 Cursor parser maps both pools and decimal-string or numeric milliseconds', () => {
  for (const reset of [RESET, String(RESET)]) {
    const snapshot = parse(cursor(12.4, 107.6, reset));
    assert.deepEqual(shape(snapshot), [['cursor', 12.4, RESET], ['other', 107.6, RESET]]);
    assert.equal(snapshot.plan, undefined);
  }
});

test('AC2/3 Cursor parser distinguishes omitted pools, invalid pools and invalid resets', () => {
  for (const billingCycleEnd of [undefined, null, '', ' 12', '12.5', '1e8', '-5', Infinity, NaN, {}, true]) {
    assert.deepEqual(shape(parse({ billingCycleEnd, planUsage: { apiPercentUsed: 0 } })), [['other', 0, undefined]]);
    assert.deepEqual(shape(parse({ billingCycleEnd, planUsage: { autoPercentUsed: 0, apiPercentUsed: null } })), [['cursor', 0, undefined]]);
  }
  for (const data of [null, [], {}, { planUsage: {} }, { planUsage: { autoPercentUsed: null } }]) {
    assert.throws(() => parse(data), error => !String(error).includes('missing parseCursorUsage'), 'invalid or empty pool set');
  }
  for (const value of [-1, -Infinity, Infinity, NaN, '12', {}, [], true]) {
    for (const field of ['autoPercentUsed', 'apiPercentUsed']) {
      assert.throws(() => parse({ planUsage: { ...cursor().planUsage, [field]: value } }),
        error => !String(error).includes('missing parseCursorUsage'), `invalid ${field}`);
    }
  }
});

test('AC2/3 T2 Cursor OAuth sends only the approved POST and renders both rounded pools', async t => {
  await host(t, { captureConsole: true }, async s => {
    s.fetch = async () => json(cursor(12.4, 45.6, String(RESET)));
    await s.start();
    await s.waitBorder(/cursor 12% \(12d 3h\) · other 46% \(12d 3h\)/);
    assert.equal(s.requests.length, 1);
    const [{ url, opts }] = s.requests;
    assert.equal(url, CURSOR_URL);
    assert.equal(opts.method, 'POST');
    assert.equal(opts.body, '{}');
    assert.equal(opts.redirect, 'error');
    assert.deepEqual(Object.fromEntries(new Headers(opts.headers)), {
      authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'connect-protocol-version': '1',
    });
    assert.ok(opts.signal instanceof AbortSignal);
    assert.equal(s.renders.filter(r => /cursor 12%/.test(r)).length, 1);
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.prompts, []);
    assert.doesNotMatch(JSON.stringify([s.notices, s.logs, s.border()]), new RegExp(TOKEN));
  });
});

for (const [name, value] of [
  ['API-key source', { auth: { apiKey: TOKEN }, source: 'api_key' }],
  ['OAuth with empty token', oauth('')], ['missing auth', undefined],
]) {
  test(`AC2 D9 Cursor fails closed for ${name} even when model reports OAuth`, async t => {
    await host(t, {}, async s => {
      s.auth = async () => value;
      await s.start();
      await until(() => s.lookups.includes('cursor'), 'Cursor did not resolve OAuth source');
      await settle();
      assert.deepEqual(s.requests, []);
      assert.equal(s.border(), blank());
    });
  });
}

for (const [name, response] of [
  ['HTTP failure', () => json({ secret: TOKEN }, 503)],
  ['network failure', () => { throw new Error(TOKEN); }],
  ['malformed JSON', () => new Response(`not JSON ${TOKEN}`)],
  ['missing pools', () => json({ planUsage: {} })],
  ['one invalid pool', () => json(cursor(12, '46'))],
  ['non-finite pool', () => new Response('{"planUsage":{"autoPercentUsed":1e999,"apiPercentUsed":0}}')],
]) {
  test(`AC3 D11 Cursor ${name}: unavailable without cache; stale with cache`, async t => {
    await host(t, { captureConsole: true }, async s => {
      s.fetch = async () => response();
      await s.start();
      await s.waitBorder(/usage unavailable/);
      s.fetch = async () => json(cursor());
      s.tick(MIN);
      await s.end();
      await s.waitBorder(/cursor 12%.*other 46%/);
      s.fetch = async () => response();
      s.tick(MIN);
      await s.end();
      await s.waitBorder(/cursor 12%.*other 46%.*stale/);
      assert.match(s.border(38), /cursor 12%.*stale/);
      assert.doesNotMatch(s.border(38), /other/);
      assert.equal(s.border(12), '──── stale ─');
      assert.doesNotMatch(JSON.stringify([s.notices, s.logs, s.border()]), new RegExp(TOKEN));
    });
  });
}

for (const phase of ['request', 'body']) {
  test(`T2 Cursor single 10 s abort deadline includes ${phase}`, async t => {
    await host(t, {}, async s => {
      let bodyStarted = false;
      let signal;
      const hold = () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      s.fetch = async (_url, opts) => {
        signal = opts.signal;
        if (phase === 'request') return hold();
        await new Promise(resolve => setTimeout(resolve, 4000));
        return { ok: true, status: 200, json() { bodyStarted = true; return hold(); } };
      };
      await s.start();
      await until(() => signal instanceof AbortSignal, 'Cursor request did not supply an abort signal');
      if (phase === 'body') {
        s.tick(4000);
        await until(() => bodyStarted, 'Cursor never began reading the body');
      }
      s.tick(10_000 - (phase === 'body' ? 4000 : 0) - 1);
      assert.equal(signal.aborted, false);
      s.tick(1);
      assert.equal(signal.aborted, true);
      await s.waitBorder(/usage unavailable/);
    });
  });
}

test('B1 hides cached Cursor quota during activation and reuses it after a matching digest', async t => {
  await host(t, {}, async s => {
    s.fetch = async () => json(cursor());
    await s.start();
    await s.waitBorder(/cursor 12%/);
    await s.select('unknown');
    const pending = Promise.withResolvers();
    s.auth = () => pending.promise;
    const before = s.lookups.length;
    const activation = s.select('cursor');
    try {
      await until(() => s.lookups.length > before, 'Cursor activation did not resolve token digest');
      assert.equal(s.border(), blank());
      pending.resolve(oauth());
      await activation;
      await s.waitBorder(/cursor 12%/);
      assert.equal(s.requests.length, 1, 'same digest unexpectedly bypassed cooldown');
    } finally { pending.resolve(oauth()); await activation; }
  });
});

test('B1 same-model login change: render OAuth gate, tick clears old value, then refreshes new token', async t => {
  await host(t, {}, async s => {
    s.fetch = async () => json(cursor());
    await s.start();
    await s.waitBorder(/cursor 12%/);
    s.oauthEnabled = false;
    assert.equal(s.border(), blank(), 'render did not recheck model OAuth');
    s.auth = async () => ({ source: 'api_key', auth: { apiKey: 'synthetic-api-key' } });
    const before = s.lookups.length;
    s.tick(MIN);
    await until(() => s.lookups.length > before, 'Cursor tick did not recheck same-model auth');
    await settle();
    s.oauthEnabled = true;
    assert.equal(s.border(), blank(), 'tick did not clear non-OAuth cache');
    assert.equal(s.requests.length, 1);
    s.auth = async () => oauth('synthetic-replacement-token');
    s.fetch = async () => json(cursor(77, null));
    s.tick(MIN);
    await s.waitBorder(/cursor 77%/);
    assert.equal(s.requests.length, 2);
    assert.equal(new Headers(s.requests[1].opts.headers).get('authorization'), 'Bearer synthetic-replacement-token');
  });
});

test('B1 same-model OAuth rotation on tick clears old value and forces refresh despite cooldown', async t => {
  await host(t, {}, async s => {
    s.fetch = async () => json(cursor());
    await s.start();
    await s.waitBorder(/cursor 12%/);
    s.tick(MIN - 1000);
    await s.end();
    await settle();
    assert.equal(s.requests.length, 1);
    // Establish a success in the last second before a later tick.
    s.tick(MIN);
    await s.end();
    await until(() => s.requests.length === 2, 'turn-end did not force a due Cursor refresh');
    await settle();
    const reply = Promise.withResolvers();
    s.auth = async () => oauth('synthetic-rotated-token');
    s.fetch = async () => reply.promise;
    try {
      s.tick(1000);
      await until(() => s.requests.length === 3, 'changed digest did not bypass cooldown');
      assert.equal(s.border(), blank());
      reply.resolve(json(null, 503));
      await s.waitBorder(/usage unavailable/);
    } finally { reply.resolve(json(null, 503)); }
  });
});
