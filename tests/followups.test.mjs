import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { blank, configText, cursor, host, json, LOGIN, MIN, oauth, ok, quota, settle, until } from './fixtures/host.mjs';

const COPILOT = 'github-copilot';
const QUOTA = 'copilot_internal/user';
const CONFIG = configText(LOGIN);
const RESET = Date.parse('2026-11-26T00:00:00Z');
const quotaReply = (used, reset = quota().reset) => ok(JSON.stringify({ ...quota(100 - used), reset }));

function jwt(payload) {
  return `fixture.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture`;
}

for (const [kind, replacement, next] of [
  ['different subject', jwt({ sub: 'account-b' }), jwt({ sub: 'account-b', version: 2 })],
  ['opaque token', 'opaque-token-one', 'opaque-token-two'],
  ['malformed payload', 'fixture.not-json.fixture', 'fixture.also-not-json.fixture'],
  ['extra segment', `${jwt({ sub: 'account-a' })}.extra`, `${jwt({ sub: 'account-a', version: 2 })}.extra`],
  ['missing subject', jwt({}), jwt({ version: 2 })],
  ['empty subject', jwt({ sub: '' }), jwt({ sub: '', version: 2 })],
  ['non-string subject', jwt({ sub: 42 }), jwt({ sub: 42, version: 2 })],
]) {
  test(`N1 Cursor keeps a rotated same-sub token cached, then detects a change to ${kind}`, async t => {
    await host(t, {}, async s => {
      const reply = Promise.withResolvers();
      let token = jwt({ sub: 'account-a' });
      s.auth = async () => oauth(token);
      s.fetch = async () => s.requests.length === 1 ? json(cursor(12)) : reply.promise;
      await s.start();
      await s.waitBorder(/cursor 12%/);
      try {
        token = jwt({ sub: 'account-a', version: 2 });
        s.tick(MIN);
        await settle();
        assert.equal(s.lookups.length, 2);
        assert.equal(s.requests.length, 1, 'same-sub rotation forced a request');
        assert.match(s.border(), /cursor 12%/, 'same-sub rotation hid the cached value');

        token = replacement;
        s.tick(MIN);
        await until(() => s.requests.length === 2, 'changed digest did not trigger a request');
        assert.equal(s.border(), blank(), 'changed digest kept the old value');
        assert.equal(new Headers(s.requests[1].opts.headers).get('authorization'), `Bearer ${replacement}`);
        reply.resolve(json(cursor(37)));
        await s.waitBorder(/cursor 37%/);

        token = next;
        s.fetch = async () => json(cursor(64));
        s.tick(MIN);
        await settle();
        if (kind === 'different subject') {
          assert.equal(s.requests.length, 2, 'second account rotation forced a request');
          assert.match(s.border(), /cursor 37%/);
        } else {
          assert.equal(s.requests.length, 3, 'fallback did not compare whole tokens');
          assert.match(s.border(), /cursor 64%/);
        }
      } finally { reply.resolve(json(cursor())); }
    });
  });
}

test('N1 Cursor hides cached usage on a thrown lookup and restores it without another request', async t => {
  await host(t, {}, async s => {
    const token = jwt({ sub: 'account-a' });
    s.auth = async () => oauth(token);
    s.fetch = async () => json(cursor(34));
    await s.start();
    await s.waitBorder(/cursor 34%/);
    s.auth = async () => { throw new Error('synthetic lookup failure'); };
    s.tick(MIN);
    await settle();
    assert.equal(s.border(), blank());
    assert.equal(s.renders.at(-1), blank(), 'lookup failure did not redraw the hidden value');
    assert.equal(s.requests.length, 1);
    await s.end();
    await settle();
    assert.equal(s.lookups.length, 3, 'the due turn-end check did not check auth');
    assert.equal(s.requests.length, 1, 'the due turn-end check fetched despite lookup failure');
    s.auth = async () => oauth(token);
    s.tick(MIN);
    await settle();
    assert.equal(s.requests.length, 1, 'recovering auth refetched the old value');
    assert.match(s.border(), /cursor 34%/);
    assert.match(s.renders.at(-1), /cursor 34%/);
  });
});

function stubUsage(s, provider, reply) {
  if (provider === COPILOT) {
    s.exec = async ({ endpoint }) => endpoint === QUOTA ? reply() : ok(s.login);
  } else if (provider === 'anthropic') {
    s.fetch = async () => reply();
  } else {
    s.fetch = async url => String(url).endsWith('/usage') ? reply() : json({ available_count: 0 });
  }
}

for (const provider of ['anthropic', 'openai-codex', COPILOT]) {
  test(`N4 B3 ${provider} bypasses cooldown exactly once after discarded work settles`, async t => {
    await host(t, { provider, config: CONFIG, now: RESET - MIN }, async s => {
      const first = Promise.withResolvers(), old = Promise.withResolvers();
      const reply = used => provider === COPILOT ? quotaReply(used, '2026-11-26') : provider === 'anthropic'
        ? json({ five_hour: { utilization: used, resets_at: new Date(RESET).toISOString() } })
        : json({ rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18000, reset_at: RESET } } });
      const label = provider === COPILOT ? 'premium' : '5h';
      let attempts = 0;
      stubUsage(s, provider, () => ++attempts === 1 ? first.promise : attempts === 2 ? old.promise : reply(31));
      await s.start();
      try {
        await until(() => attempts === 1, 'initial usage lookup did not start');
        s.tick(5000);
        first.resolve(reply(12));
        await s.waitBorder(new RegExp(`${label} 12%`));
        s.tick(MIN - 5000);
        await until(() => attempts === 2, 'known reset did not trigger an early usage lookup');
        await s.select('unknown');
        const renders = s.renders.length;
        const calls = s.calls.length;
        old.resolve(reply(91));
        await settle();
        assert.equal(s.renders.length, renders, 'discarded result rendered');
        assert.equal(s.calls.length, calls, 'discarded result ran a Copilot post-check');
        await s.select(provider);
        await s.waitBorder(new RegExp(`${label} 31%`));
        await s.select('unknown');
        await s.select(provider);
        await settle();
        assert.equal(attempts, 3, 'cooldown was bypassed more than once');
        assert.match(s.border(), new RegExp(`${label} 31%`));
      } finally { first.resolve(reply(12)); old.resolve(reply(91)); }
    });
  });
}

for (const claimed of [false, true]) {
  test(`N3 same-account setup discards automatic Copilot work${claimed ? ' claimed by a command' : ''}`, async t => {
    await host(t, { provider: COPILOT, config: CONFIG }, async s => {
      const old = Promise.withResolvers();
      let attempts = 0;
      stubUsage(s, COPILOT, () => ++attempts === 1 ? old.promise : quotaReply(33));
      await s.start();
      let command, setup;
      try {
        await until(() => attempts === 1, 'automatic Copilot lookup did not start');
        if (claimed) {
          command = s.command();
          await settle();
          assert.equal(attempts, 1, 'command should join current work');
        }
        setup = s.command('setup');
        (await s.waitPrompt()).answer(LOGIN);
        await until(() => attempts === 2, 'setup joined old work instead of replacing it');
        await setup;
        await s.waitBorder(/premium 33%/);
        const counts = [s.calls.length, s.renders.length, s.notices.length];
        old.resolve(quotaReply(91));
        await command;
        await settle();
        assert.deepEqual([s.calls.length, s.renders.length, s.notices.length], counts);
        assert.match(s.border(), /premium 33%/);
      } finally {
        old.resolve(quotaReply(91));
        for (const prompt of s.prompts) prompt.answer(undefined);
        await command;
        await setup;
      }
    });
  });
}

for (const provider of ['cursor', 'anthropic']) {
  test(`N3 Copilot setup preserves an in-flight ${provider} refresh`, async t => {
    await host(t, { provider, config: CONFIG }, async s => {
      const reply = Promise.withResolvers();
      s.fetch = () => reply.promise;
      const response = json(provider === 'cursor' ? cursor(38) : { five_hour: { utilization: 38 } });
      await s.start();
      let setup;
      try {
        await until(() => s.requests.length === 1, 'active provider did not start refresh');
        setup = s.command('setup');
        const prompt = await s.waitPrompt();
        s.login = 'replacement-account';
        prompt.answer(s.login);
        await setup;
        assert.match(s.notices.at(-1)?.text ?? '', /account saved/);
        if (provider === 'cursor') assert.equal(s.requests[0].opts.signal.aborted, false);
        reply.resolve(response);
        await settle();
        assert.match(s.border(), new RegExp(`${provider === 'cursor' ? 'cursor' : '5h'} 38%`));
        assert.equal(s.requests.length, 1, 'active provider retried its refresh');
      } finally {
        reply.resolve(response);
        for (const prompt of s.prompts) prompt.answer(undefined);
        await setup;
      }
    });
  });
}

for (const hasConfig of [true, false]) {
  test(`N4 shutdown during the ${hasConfig ? 'valid' : 'missing'} Copilot config read fences all continuations`, async t => {
    const suffix = `?deferred-config-${hasConfig}`;
    // Pause the final file close or the missing-file error before readConfig can resolve.
    const fs = 'data:text/javascript,' + encodeURIComponent(`
      // ${suffix}
      import * as fs from 'node:fs/promises';
      export * from 'node:fs/promises';
      const { promise: blocked, resolve: ready } = Promise.withResolvers();
      const { promise: gate, resolve: release } = Promise.withResolvers();
      export { blocked, release };
      export async function lstat(...args) {
        try { return await fs.lstat(...args); }
        catch (error) { ready(); await gate; throw error; }
      }
      export async function open(...args) {
        const file = await fs.open(...args);
        const close = file.close;
        file.close = async () => { await close.call(file); ready(); await gate; };
        return file;
      }
    `);
    const hook = registerHooks({
      resolve(specifier, context, next) {
        if (specifier === 'node:fs/promises' && context.parentURL?.endsWith(`/src/copilot.ts${suffix}`)) {
          return { url: fs, shortCircuit: true };
        }
        const result = next(specifier, context);
        if (context.parentURL?.endsWith(suffix) && result.url.endsWith('/src/copilot.ts')) {
          return { ...result, url: `${result.url}${suffix}` };
        }
        return result;
      },
    });
    try {
      const { blocked, release } = await import(fs);
      let readIsBlocked = false;
      void blocked.then(() => { readIsBlocked = true; });
      const { default: factory } = await import(`../extensions/usage-bar.ts${suffix}`);
      await host(t, { provider: COPILOT, config: hasConfig ? CONFIG : undefined, factory }, async s => {
        try {
          await s.start();
          await until(() => readIsBlocked, 'config read did not reach the gate');
          assert.deepEqual([s.calls, s.renders, s.prompts], [[], [], []]);
          await s.shutdown();
          release();
          await settle();
          assert.deepEqual([s.calls, s.renders, s.prompts], [[], [], []]);
          assert.equal(s.border(), blank());
        } finally { release(); }
      });
    } finally { hook.deregister(); }
  });
}
