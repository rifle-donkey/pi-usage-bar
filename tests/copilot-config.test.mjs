import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, rename, symlink, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { blank, configText, host, LOGIN, MIN, ok, quota, settle, until } from './fixtures/host.mjs';

const provider = 'github-copilot';
const setupNeeded = /copilot setup needed/;
const value = /premium 20%/;
const account = LOGIN.toLowerCase();
const config = configText(account);
const filename = 'copilot-credits.json';

function copilot(t, run, options = {}) { return host(t, { provider, ...options }, run); }
async function ticks(s, count = 6) {
  for (let i = 0; i < count; i++) { s.tick(MIN); await settle(); }
}
async function firstPrompt(s) {
  let started = false;
  const start = s.start().then(() => { started = true; });
  const prompt = await s.waitPrompt();
  await until(() => started, 'session_start blocked on unanswered prompt');
  await start;
  return prompt;
}
async function assertConfig(s, login) {
  const info = await lstat(s.path);
  assert.ok(info.isFile());
  assert.equal(info.mode & 0o777, 0o600);
  assert.equal(await readFile(s.path, 'utf8'), configText(login));
  assert.deepEqual(await readdir(s.dir), [filename], 'temporary config files remain');
}
async function noConfigOrWork(s) {
  await s.command();
  await ticks(s);
  await assert.rejects(lstat(s.path), { code: 'ENOENT' });
  assert.match(s.border(), setupNeeded);
  assert.deepEqual(s.calls, []);
}

// Read the advertised file across publication without relying on temporary names.
async function samplePublication(path, run, allowMissing = true) {
  const observed = new Set();
  const sample = () => {
    try { observed.add(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' || !allowMissing) observed.add(error.code); }
  };
  let reading = true;
  const reader = (async () => { while (reading) { sample(); await turn(); } })();
  try { await run(); sample(); }
  finally { reading = false; await reader; }
  return [...observed];
}

function paddedConfig(bytes) {
  const empty = JSON.stringify({ account, padding: '' });
  return JSON.stringify({ account, padding: ' '.repeat(bytes - Buffer.byteLength(empty)) });
}

for (const override of ['unset', '', 'absolute', 'relative', '~', '~/']) {
  test(`AC4 Copilot loads valid config from ${override || 'empty'} agent directory override`, async t => {
    await copilot(t, async s => {
      await s.start();
      await s.waitBorder(value);
      assert.equal(s.calls.length, 3);
      assert.deepEqual(s.prompts, []);
    }, { override, config });
  });
}

test('AC4 Copilot accepts exactly 4096 bytes and reads config once per instance', async t => {
  await copilot(t, async s => {
    await s.start();
    await s.waitBorder(value);
    await s.writeConfig(configText('changed-on-disk'));
    await s.command();
    assert.match(s.border(), value);
    assert.match(s.notices.at(-1).text, /Remaining: 80 \/ 100/);
    assert.equal(s.calls.length, 6);
  }, { config: paddedConfig(4096) });
});

for (const [name, contents] of [
  ['malformed JSON', '{synthetic-private-marker'], ['missing field', '{}'], ['wrong type', '{"account":42}'],
  ['empty', '{"account":""}'], ['leading hyphen', '{"account":"-abc"}'], ['trailing hyphen', '{"account":"abc-"}'],
  ['adjacent hyphens', '{"account":"ab--cd"}'], ['non-ASCII', '{"account":"é"}'],
  ['too long login', configText('a'.repeat(40))], ['4097 bytes', paddedConfig(4097)],
  ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d])], ['array', '["abc"]'],
  ['inherited account', '{"__proto__":{"account":"abc"}}'],
]) {
  test(`AC4 AC5 Copilot invalid config ${name} never prompts or calls gh, including on ticks`, async t => {
    await copilot(t, async s => {
      await s.start();
      await s.waitBorder(setupNeeded);
      await ticks(s);
      await s.command();
      assert.deepEqual(s.calls, []);
      assert.deepEqual(s.prompts, []);
      const notice = s.notices.at(-1);
      assert.equal(notice.level, 'warning');
      assert.ok(notice.text.includes(s.path));
      assert.match(notice.text, /\/copilot-credits setup/);
      assert.doesNotMatch(JSON.stringify([s.border(), s.notices]), /synthetic-private-marker|Sample-Account/i);
      assert.deepEqual(await readFile(s.path), Buffer.from(contents));
    }, { config: contents });
  });
}

for (const override of ['file:///synthetic-override', '~\\synthetic-override', '~synthetic-override/agent']) {
  test(`AC4 Copilot refuses unsupported agent-directory form ${override}`, async t => {
    await copilot(t, async s => {
      const before = await readdir(s.home, { recursive: true });
      await s.start();
      await s.waitBorder(setupNeeded);
      await s.command();
      await s.command('setup');
      await ticks(s);
      assert.deepEqual(s.prompts, []);
      assert.deepEqual(s.calls, []);
      assert.ok(s.notices.length >= 2);
      for (const { text } of s.notices) {
        assert.match(text, /PI_CODING_AGENT_DIR is not a supported path/);
        assert.doesNotMatch(text, /synthetic-override/);
      }
      assert.deepEqual(await readdir(s.home, { recursive: true }), before);
    }, { override });
  });
}

for (const contents of [undefined, config]) {
  test(`T2 Copilot on a platform without O_NOFOLLOW fails closed with ${contents ? 'valid' : 'missing'} config`, async t => {
    let intercepted = false;
    const query = `?no-nofollow-${contents ? 'valid' : 'missing'}`;
    const hook = registerHooks({
      resolve(specifier, context, next) {
        if (['node:fs', 'fs'].includes(specifier) && context.parentURL?.endsWith(`/src/copilot.ts${query}`)) {
          intercepted = true;
          return {
            url: 'data:text/javascript,' + encodeURIComponent(`import fs from 'node:fs';
              export const constants = { ...fs.constants, O_NOFOLLOW: undefined };
              export default { ...fs, constants };`), shortCircuit: true,
          };
        }
        const result = next(specifier, context);
        // A distinct module graph keeps the intercepted import independent of the normal host.
        if (context.parentURL?.endsWith(query) && result.url.endsWith('/src/copilot.ts')) {
          return { ...result, url: `${result.url}${query}` };
        }
        return result;
      },
    });
    try {
      const { default: factory } = await import(`../extensions/usage-bar.ts${query}`);
      assert.ok(intercepted, 'missing Copilot node:fs import to test O_NOFOLLOW');
      await copilot(t, async s => {
        const before = (await readdir(s.home, { recursive: true })).sort();
        await s.start();
        await s.waitBorder(setupNeeded);
        await s.command();
        await s.command('setup');
        await ticks(s);
        assert.deepEqual(s.prompts, []);
        assert.deepEqual(s.calls, []);
        assert.ok(s.notices.length >= 2);
        for (const { text } of s.notices) assert.match(text, /cannot open files without following symbolic links/);
        assert.deepEqual((await readdir(s.home, { recursive: true })).sort(), before);
        if (contents) assert.equal(await readFile(s.path, 'utf8'), contents);
      }, { factory, config: contents });
    } finally { hook.deregister(); }
  });
}

test('D3 AC5 missing config prompts on first Copilot activation only; publishes complete file before refresh', async t => {
  await copilot(t, async s => {
    await s.start();
    await ticks(s);
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.prompts, []);
    await s.select(provider);
    const prompt = await s.waitPrompt();
    assert.deepEqual(s.calls, []);
    let publishedAtFirstCall;
    s.exec = async ({ endpoint }) => {
      if (s.calls.length === 1) publishedAtFirstCall = readFileSync(s.path, 'utf8');
      return endpoint === 'user' ? ok(LOGIN) : ok(JSON.stringify(quota()));
    };
    const observed = await samplePublication(s.path, async () => {
      prompt.answer(`  ${LOGIN} \n`);
      await s.waitBorder(value);
    });
    assert.deepEqual(observed, [configText(LOGIN)]);
    assert.equal(publishedAtFirstCall, configText(LOGIN));
    await assertConfig(s, LOGIN);
    assert.equal((await lstat(s.dir)).mode & 0o777, 0o700);
    assert.equal(s.calls.length, 3);
    assert.doesNotMatch(JSON.stringify([s.border(), s.notices]), /Sample-Account/i);
    await s.select('unknown');
    await s.select(provider);
    await settle();
    assert.equal(s.prompts.length, 1);
  }, { provider: 'unknown' });
});

for (const [name, answer] of [['cancel', undefined], ['empty answer', '']]) {
  test(`D3 Copilot ${name} leaves no config and does not prompt again on reactivation`, async t => {
    await copilot(t, async s => {
      (await firstPrompt(s)).answer(answer);
      await noConfigOrWork(s);
      await s.select('unknown');
      await s.select(provider);
      await ticks(s);
      assert.equal(s.prompts.length, 1);
      assert.deepEqual(s.calls, []);
    });
  });
}

test('AC4 Copilot gives up after three invalid answers without echoing or writing them', async t => {
  await copilot(t, async s => {
    await firstPrompt(s);
    for (const [i, answer] of ['synthetic_bad_login', 123, 'a'.repeat(40)].entries()) (await s.waitPrompt(i)).answer(answer);
    await noConfigOrWork(s);
    assert.equal(s.prompts.length, 3);
    assert.doesNotMatch(JSON.stringify([s.prompts.map(p => p.title), s.border(), s.notices]), /synthetic_bad_login|a{40}/);
  });
});

for (const kind of ['deadline', 'shutdown', 'late answer', 'switch away']) {
  test(`AC4 T8 Copilot pending automatic prompt: ${kind}`, async t => {
    await copilot(t, async s => {
      const prompt = await firstPrompt(s);
      const { signal, timeout } = prompt.options ?? {};
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      assert.equal(timeout, 60_000);
      if (kind === 'deadline') {
        s.tick(59_999);
        assert.equal(prompt.reason, undefined);
        s.tick(1);
        assert.equal(await prompt.promise, undefined);
        assert.equal(prompt.reason, 'timeout');
        await noConfigOrWork(s);
      } else if (kind === 'switch away') {
        await s.select('unknown');
        prompt.answer(LOGIN);
      } else {
        const command = s.command('setup');
        await settle();
        assert.equal(s.prompts.length, 1, 'setup opened a second prompt');
        await s.shutdown();
        assert.equal(signal.aborted, true);
        if (kind === 'late answer') prompt.answer(LOGIN);
        else assert.equal(prompt.reason, 'abort');
        await command;
      }
      await settle();
      assert.equal(s.prompts.length, 1);
      await assert.rejects(lstat(s.path), { code: 'ENOENT' });
      assert.deepEqual(s.calls, []);
    }, { honorAbort: kind !== 'late answer' });
  });
}

test('AC4 competing first-start publish wins, unchanged and without temp files', async t => {
  await copilot(t, async s => {
    const prompt = await firstPrompt(s);
    const winner = 'synthetic-winner';
    const observed = await samplePublication(s.path, async () => {
      await mkdir(s.dir, { recursive: true });
      const competingFile = join(s.dir, 'competing-session.tmp');
      await writeFile(competingFile, configText(winner), { mode: 0o600 });
      await rename(competingFile, s.path);
      s.login = winner;
      prompt.answer('synthetic-loser');
      await s.waitBorder(value);
    });
    assert.deepEqual(observed, [configText(winner)]);
    await assertConfig(s, winner);
    assert.equal(s.calls.length, 3);
  });
});

for (const kind of ['directory', 'valid symlink', 'dangling symlink']) {
  test(`T2 Copilot rejects ${kind} on startup and explicit setup without modifying it`, async t => {
    await copilot(t, async s => {
      await mkdir(s.dir, { recursive: true });
      const target = join(s.dir, 'target.json');
      if (kind === 'directory') {
        await mkdir(s.path);
        await writeFile(join(s.path, 'marker'), 'intact');
      } else {
        if (kind === 'valid symlink') await writeFile(target, config);
        await symlink(target, s.path);
      }
      const before = (await readdir(s.dir)).sort();
      const mode = (await lstat(s.dir)).mode;
      await s.start();
      await s.waitBorder(setupNeeded);
      assert.deepEqual(s.prompts, []);
      await s.command('setup');
      assert.match(s.notices.at(-1).text, /not a regular file/);
      await ticks(s);
      assert.deepEqual(s.calls, []);
      assert.deepEqual(s.prompts, []);
      assert.equal((await lstat(s.dir)).mode, mode);
      assert.deepEqual((await readdir(s.dir)).sort(), before);
      if (kind === 'directory') assert.equal(await readFile(join(s.path, 'marker'), 'utf8'), 'intact');
      else {
        assert.equal(await readlink(s.path), target);
        if (kind === 'valid symlink') assert.equal(await readFile(target, 'utf8'), config);
        else await assert.rejects(lstat(target), { code: 'ENOENT' });
      }
    });
  });
}

for (const initial of [config, '{invalid']) {
  test(`D8 Copilot setup on non-Copilot model atomically replaces ${initial === config ? 'valid' : 'invalid'} regular file`, async t => {
    await copilot(t, async s => {
      await chmod(s.dir, 0o750);
      const old = await open(s.path, 'r');
      try {
        await s.start();
        const setup = s.command(' setup ');
        try {
          const prompt = await s.waitPrompt();
          const login = 'Synthetic-Replacement';
          s.login = login;
          const observed = await samplePublication(s.path, async () => {
            prompt.answer(` ${login} `);
            await setup;
          }, false);
          assert.deepEqual(observed, [initial, configText(login)]);
          assert.equal(await old.readFile('utf8'), initial);
          await assertConfig(s, login);
          assert.equal((await lstat(s.dir)).mode & 0o777, 0o750);
          assert.equal(s.calls.length, 3);
          assert.equal(s.border(), blank());
          assert.equal(s.notices.at(-1).level, 'info');
          assert.doesNotMatch(JSON.stringify(s.notices), /Synthetic-Replacement/i);
        } finally { for (const prompt of s.prompts) prompt.answer(undefined); await setup; }
      } finally { await old.close(); }
    }, { provider: 'unknown', config: initial });
  });
}

test('AC4 Copilot treats throwing input as cancellation', async t => {
  await copilot(t, async s => {
    s.inputError = new Error('synthetic-input-error');
    await s.start();
    await s.command('setup');
    await assert.rejects(lstat(s.path), { code: 'ENOENT' });
    assert.deepEqual(s.calls, []);
    assert.doesNotMatch(JSON.stringify(s.notices), /synthetic-input-error/);
  }, { provider: 'unknown' });
});

test('AC4 Copilot write failure leaves no temp file and does not refresh', {
  skip: process.getuid?.() === 0 || process.platform === 'win32' ? 'Needs Unix permissions and a non-root user' : false,
}, async t => {
  await copilot(t, async s => {
    await mkdir(s.dir, { recursive: true });
    await chmod(s.dir, 0o500);
    try {
      await s.start();
      const setup = s.command('setup');
      try {
        (await s.waitPrompt()).answer(LOGIN);
        await setup;
        assert.equal(s.notices.at(-1).text, `Copilot quota setup failed: could not write ${s.path}.`);
        assert.deepEqual(s.calls, []);
        assert.deepEqual(await readdir(s.dir), []);
      } finally { for (const prompt of s.prompts) prompt.answer(undefined); await setup; }
    } finally { await chmod(s.dir, 0o700); }
  }, { provider: 'unknown' });
});

test('AC4 Copilot non-UI startup and commands do not prompt, write, notify or invoke gh', async t => {
  await copilot(t, async s => {
    await s.start();
    for (const args of ['', 'setup', 'bogus']) await s.command(args);
    await ticks(s);
    assert.deepEqual([s.calls, s.prompts, s.statuses, s.notices, s.renders], [[], [], [], [], []]);
    await assert.rejects(lstat(s.path), { code: 'ENOENT' });
  }, { hasUI: false });
});

test('D8 Copilot unknown command argument shows usage without prompting or invoking gh', async t => {
  await copilot(t, async s => {
    await s.start();
    await s.command('bogus');
    assert.equal(s.notices.at(-1).text, 'Usage: /copilot-credits [setup]');
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.prompts, []);
  }, { provider: 'unknown', config });
});

test('T8 account setup discards the old command before its post-check and clears cached quota on new-account failure', async t => {
  await copilot(t, async s => {
    await s.start();
    await s.waitBorder(value);
    const old = Promise.withResolvers();
    s.exec = async ({ endpoint, login }) => {
      if (endpoint === 'user') return ok(login);
      if (login === LOGIN) return old.promise;
      return { code: 1, stdout: 'synthetic-new-account-failure' };
    };
    const previous = s.command();
    try {
      await until(() => s.calls.length === 5, 'old-account command did not make quota call');
      const setup = s.command('setup');
      const prompt = await s.waitPrompt();
      s.login = 'synthetic-new-account';
      prompt.answer(s.login);
      await s.waitBorder(/usage unavailable/);
      await setup;
      await assertConfig(s, s.login);
      assert.equal(s.calls.filter(call => call.login === s.login).length, 3);
      const counts = [s.calls.length, s.renders.length, s.notices.length];
      s.login = LOGIN;
      old.resolve(ok(JSON.stringify(quota(67))));
      await previous;
      assert.deepEqual([s.calls.length, s.renders.length, s.notices.length], counts);
      assert.match(s.border(), /usage unavailable/);
      assert.doesNotMatch(s.border(), /premium|stale/);
    } finally { old.resolve(ok(JSON.stringify(quota()))); await previous; }
  }, { config });
});

for (const mode of ['automatic', 'command']) {
  test(`T8 shutdown fences pending Copilot ${mode} identity check and all later commands`, async t => {
    await copilot(t, async s => {
      const gate = Promise.withResolvers();
      s.exec = () => gate.promise;
      await s.start();
      const pending = mode === 'command' ? s.command() : undefined;
      try {
        await until(() => s.calls.length > 0, 'Copilot identity lookup did not start');
        await s.shutdown();
        const renders = s.renders.length;
        gate.resolve(ok(LOGIN));
        await pending;
        await settle();
        for (const args of ['', 'setup', 'bogus']) await s.command(args);
        assert.equal(s.calls.length, 1);
        assert.equal(s.renders.length, renders);
        assert.deepEqual(s.notices, []);
        assert.deepEqual(s.prompts, []);
        assert.equal(await readFile(s.path, 'utf8'), config);
      } finally { gate.resolve(ok(LOGIN)); await pending; }
    }, { config, provider: mode === 'command' ? 'unknown' : provider });
  });
}
