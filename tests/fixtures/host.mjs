import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as realSetTimeout, clearTimeout as realClearTimeout } from 'node:timers';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { formatWithOptions } from 'node:util';
import usageBar from '../../extensions/usage-bar.ts';

export const NOW = Date.parse('2026-11-24T21:00:00Z');
export const MIN = 60_000;
export const CURSOR_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
export const TOKEN = 'synthetic-cursor-token';
export const LOGIN = 'Sample-Account';
export const RESET = '2026-12-01';
export const configText = account => `${JSON.stringify({ account })}\n`;
export const oauth = (apiKey = TOKEN) => ({ auth: { apiKey }, source: 'OAuth' });
export const quota = (remaining = 80) => ({
  plan: 'enterprise', reset: RESET,
  quota: { entitlement: 100, remaining, percent_remaining: remaining, unlimited: false },
});
export const cursor = (autoPercentUsed = 12.4, apiPercentUsed = 45.6, billingCycleEnd = '1796592000000') => ({
  billingCycleEnd, planUsage: { autoPercentUsed, apiPercentUsed },
});
export const ok = stdout => ({ code: 0, stdout });
export const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
export const blank = (width = 100) => '─'.repeat(width);
export const settle = async () => { await turn(); await turn(); };

// Only the failure guard uses wall time. Success is driven by public host observations.
export async function until(predicate, message) {
  const deadline = performance.now() + 1000;
  while (!predicate() && performance.now() < deadline) await delay(2);
  assert.ok(predicate(), message);
}

async function bounded(operation, name) {
  let watchdog;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      watchdog = realSetTimeout(() => reject(new Error(`${name} did not finish`)), 2000);
    })]);
  } finally { realClearTimeout(watchdog); }
}

export async function host(t, {
  provider = 'cursor', hasUI = true, config, override = 'absolute', honorAbort = true,
  factory = usageBar, captureConsole = false, now = NOW,
} = {}, run) {
  const home = await mkdtemp(join(tmpdir(), 'usage-bar-qa-'));
  const env = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  const previousCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const handlers = new Map(), commands = new Map();
  let editorFactory, editor, stopped = false;
  const dir = override === 'unset' || override === '' ? join(home, '.pi', 'agent') :
    override === '~' ? home : join(home, 'agent');
  const path = join(dir, '.config', 'copilot-credits.json');
  const model = provider => provider ? { provider, id: 'fixture-model' } : undefined;
  const s = {
    home, path, dir: dirname(path), commands, notices: [], prompts: [], calls: [], statuses: [],
    requests: [], lookups: [], renders: [], logs: [], login: LOGIN, oauthEnabled: true,
    auth: async () => oauth(),
    fetch: async () => { throw new Error('Unexpected fetch in offline test'); },
    exec: async call => call.endpoint === 'user' ? ok(s.login) : ok(JSON.stringify(quota())),
    start: async () => {
      await bounded(handlers.get('session_start')?.({}, ctx), 'session_start');
      if (hasUI) {
        assert.ok(editorFactory, 'session_start did not install an editor factory');
        editor = editorFactory({ requestRender() { s.renders.push(s.border()); } }, ctx.ui.theme, {});
      }
    },
    shutdown: async () => {
      if (!stopped) {
        stopped = true;
        await bounded(handlers.get('session_shutdown')?.({}, ctx), 'session_shutdown');
      }
    },
    select: async provider => {
      ctx.model = model(provider);
      await bounded(handlers.get('model_select')?.({ model: ctx.model }, ctx), 'model_select');
    },
    end: () => bounded(handlers.get('agent_end')?.({}, ctx), 'agent_end'),
    command(args = '') {
      const command = commands.get('copilot-credits');
      assert.ok(command, 'missing /copilot-credits command');
      const completion = bounded(command.handler(args, ctx), '/copilot-credits');
      void completion.catch(() => {}); // The test may await a public event before awaiting the command.
      return completion;
    },
    tick: ms => t.mock.timers.tick(ms),
    border: (width = 100, hidden = 0) => editor?.renderTopBorder(width, hidden) ?? blank(width),
    waitBorder: pattern => until(() => pattern.test(s.border()), `Expected border matching ${pattern}`),
    waitPrompt: async (index = 0) => {
      await until(() => s.prompts.length > index, `Expected Copilot input prompt ${index + 1}`);
      return s.prompts[index];
    },
    writeConfig: async contents => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    },
  };
  const ctx = {
    model: model(provider), hasUI,
    modelRegistry: {
      isUsingOAuth: () => s.oauthEnabled,
      async getProviderAuth(provider) { s.lookups.push(provider); return s.auth(provider); },
    },
    ui: {
      theme: { fg: (_tone, text) => text },
      getEditorComponent: () => editorFactory,
      setEditorComponent: factory => { editorFactory = factory; },
      setStatus: (...args) => s.statuses.push(args),
      notify: (text, level) => s.notices.push({ text, level }),
      input(title, placeholder, options) {
        const { promise, resolve } = Promise.withResolvers();
        const signal = options?.signal;
        let timer;
        const prompt = { title, placeholder, options, promise, answer: value => finish(value, 'answer') };
        function finish(value, reason) {
          if (prompt.reason) return;
          prompt.reason = reason;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          resolve(value);
        }
        const abort = () => finish(undefined, 'abort');
        s.prompts.push(prompt);
        if (honorAbort) signal?.addEventListener('abort', abort, { once: true });
        if (Number.isFinite(options?.timeout)) timer = setTimeout(() => finish(undefined, 'timeout'), options.timeout);
        if (honorAbort && signal?.aborted) abort();
        return s.inputError ? Promise.reject(s.inputError) : promise;
      },
    },
  };
  try {
    process.env.HOME = home;
    process.chdir(home);
    if (override === 'unset') delete process.env.PI_CODING_AGENT_DIR;
    else if (override === 'absolute') process.env.PI_CODING_AGENT_DIR = join(home, 'agent');
    else if (override === 'relative') process.env.PI_CODING_AGENT_DIR = 'agent';
    else process.env.PI_CODING_AGENT_DIR = override === '~/' ? '~/agent' : override;
    if (config !== undefined) await s.writeConfig(config);
    t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now });
    globalThis.fetch = async (url, opts) => {
      s.requests.push({ url, opts });
      return s.fetch(url, opts);
    };
    if (captureConsole) {
      for (const method of ['log', 'debug', 'info', 'warn', 'error', 'trace', 'dir', 'table', 'assert']) {
        t.mock.method(console, method, (...args) => { s.logs.push(formatWithOptions({ colors: false, depth: null }, ...args)); });
      }
    }
    factory({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: (name, command) => commands.set(name, command),
      async exec(cmd, args, opts) {
        const endpoint = args.includes('copilot_internal/user') ? 'copilot_internal/user' : 'user';
        const call = { cmd, args, opts, endpoint, login: s.login };
        s.calls.push(call);
        return s.exec(call);
      },
    });
    await run(s);
  } finally {
    try {
      await s.shutdown();
      for (const prompt of s.prompts) prompt.answer(undefined);
      await settle();
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
      process.chdir(previousCwd);
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(home, { recursive: true, force: true });
    }
  }
}
