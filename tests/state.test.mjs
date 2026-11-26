import assert from 'node:assert/strict';
import test from 'node:test';
import { blank, cursor, host, json, MIN, NOW, oauth, settle, until } from './fixtures/host.mjs';

for (const invalidation of ['provider switch', 'shutdown']) {
  test(`T8 ${invalidation} while Cursor auth is pending prevents the fetch and late render`, async t => {
    await host(t, {}, async s => {
      const gate = Promise.withResolvers();
      s.auth = () => gate.promise;
      const start = s.start();
      try {
        await until(() => s.lookups.length > 0, 'Cursor did not start auth lookup');
        if (invalidation === 'shutdown') await s.shutdown();
        else await s.select(undefined);
        const renders = s.renders.length;
        gate.resolve(oauth());
        await start;
        await settle();
        assert.deepEqual(s.requests, []);
        assert.equal(s.renders.length, renders);
        assert.equal(s.border(), blank());
      } finally { gate.resolve(oauth()); await start; }
    });
  });
}

test('T8 current generation starts a new Cursor request while obsolete work is pending', async t => {
  await host(t, {}, async s => {
    const old = Promise.withResolvers();
    const fresh = Promise.withResolvers();
    s.fetch = () => s.requests.length === 1 ? old.promise : fresh.promise;
    await s.start();
    try {
      await until(() => s.requests.length === 1, 'first Cursor request did not start');
      await s.select('unknown');
      await s.select('cursor');
      await until(() => s.requests.length === 2, 'activation joined an obsolete request');
      const renders = s.renders.length;
      old.resolve(json(cursor(91, null)));
      await settle();
      assert.equal(s.renders.length, renders, 'discarded completion rendered');
      assert.equal(s.border(), blank(), 'discarded completion wrote cache');
      await s.end();
      await settle();
      assert.equal(s.requests.length, 2, 'obsolete completion detached current work');
      fresh.resolve(json(cursor(27, null)));
      await s.waitBorder(/cursor 27%/);
      assert.equal(s.renders.filter(r => /cursor 27%/.test(r)).length, 1);
    } finally { old.resolve(json(cursor())); fresh.resolve(json(cursor())); }
  });
});

test('B3 reactivation bypasses recent cooldown once even after discarded request settled', async t => {
  await host(t, {}, async s => {
    const initial = Promise.withResolvers(), discarded = Promise.withResolvers();
    s.fetch = () => {
      if (s.requests.length === 1) return initial.promise;
      if (s.requests.length === 2) return discarded.promise;
      return Promise.resolve(json(cursor(23, null)));
    };
    await s.start();
    try {
      await until(() => s.requests.length === 1, 'first Cursor request did not start');
      s.tick(9000);
      initial.resolve(json(cursor(12, null, NOW + MIN)));
      await s.waitBorder(/cursor 12%/);
      s.tick(MIN - 9000);
      await until(() => s.requests.length === 2, 'known reset did not trigger tick refresh inside cooldown');
      await s.select('unknown');
      const renders = s.renders.length;
      discarded.resolve(json(cursor(91, null)));
      await settle();
      assert.equal(s.renders.length, renders, 'discarded completion rendered');
      await s.select('cursor');
      await s.waitBorder(/cursor 23%/);
      assert.equal(s.requests.length, 3);
      assert.ok(s.renders.every(r => !r.includes('cursor 91%')));
      await s.select('unknown');
      await s.select('cursor');
      await s.waitBorder(/cursor 23%/);
      assert.equal(s.requests.length, 3, 'discarded flag bypassed cooldown a second time');
    } finally { initial.resolve(json(cursor())); discarded.resolve(json(cursor())); }
  });
});

test('T8 discarded Cursor completion does not move the live refresh cooldown', async t => {
  await host(t, {}, async s => {
    const old = Promise.withResolvers();
    s.fetch = () => {
      if (s.requests.length === 1) return old.promise;
      return Promise.resolve(json(cursor(s.requests.length === 2 ? 20 : 30, null)));
    };
    await s.start();
    try {
      await until(() => s.requests.length === 1, 'first Cursor request did not start');
      await s.select('unknown');
      await s.select('cursor');
      await s.waitBorder(/cursor 20%/);
      s.tick(5000);
      const renders = s.renders.length;
      old.resolve(json(cursor(91, null)));
      await settle();
      assert.equal(s.renders.length, renders);
      assert.match(s.border(), /cursor 20%/);
      s.tick(MIN - 5000);
      await settle();
      await s.end();
      await s.waitBorder(/cursor 30%/);
      assert.equal(s.requests.length, 3);
    } finally { old.resolve(json(cursor())); }
  });
});

test('T8 a second session start detaches old Cursor work even when provider did not change', async t => {
  await host(t, {}, async s => {
    const old = Promise.withResolvers();
    s.fetch = () => s.requests.length === 1 ? old.promise : Promise.resolve(json(cursor(30, null)));
    await s.start();
    try {
      await until(() => s.requests.length === 1, 'first session did not start Cursor refresh');
      await s.start();
      await s.waitBorder(/cursor 30%/);
      const renders = s.renders.length;
      old.resolve(json(cursor(91, null)));
      await settle();
      assert.match(s.border(), /cursor 30%/);
      assert.equal(s.renders.length, renders);
    } finally { old.resolve(json(cursor())); }
  });
});
