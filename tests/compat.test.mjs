import assert from 'node:assert/strict';
import test from 'node:test';
import { blank, host, json, MIN } from './fixtures/host.mjs';

const anthropic = {
  five_hour: { utilization: 82, resets_at: '2026-11-24T23:40:00Z' },
  seven_day: { utilization: 16, resets_at: '2026-11-29T22:00:00Z' },
};
const codex = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 35, limit_window_seconds: 18000, reset_after_seconds: 13260 },
    secondary_window: { used_percent: 9, limit_window_seconds: 604800, reset_after_seconds: 216000 },
  },
  rate_limit_reset_credits: { available_count: 2 },
};
const credits = { available_count: 2, credits: [{ status: 'available', expires_at: '2026-12-13T19:00:00Z' }] };

// Captured through the editor factory on b4d1538, at widths 72 and 28 and a fixed clock.
const unavailable = [
  '──────────────────────────────────────────────────── usage unavailable ─', '──────── usage unavailable ─',
];
const expected = {
  anthropic: {
    success: ['───────────────────────────────────── 5h 82% (2h 40m) · 7d 16% (5d 1h) ─', '────────── 5h 82% (2h 40m) ─'],
    stale: ['───────────────────────────── 5h 82% (2h 39m) · 7d 16% (5d 0h) · stale ─', '────────── 5h 82% (2h 39m) ─'],
    unavailable,
  },
  'openai-codex': {
    success: ['──────────── plus · 5h 35% (3h 41m) · 7d 9% (2d 12h) · ✦ 2 exp 18d 22h ─', '────────── 5h 35% (3h 41m) ─'],
    stale: ['──── plus · 5h 35% (3h 40m) · 7d 9% (2d 11h) · ✦ 2 exp 18d 21h · stale ─', '────────── 5h 35% (3h 40m) ─'],
    unavailable,
  },
};

for (const provider of Object.keys(expected)) {
  for (const state of ['success', 'stale', 'unavailable']) {
    test(`AC1 ${provider} ${state} border is byte-identical to b4d1538`, async t => {
      await host(t, { provider }, async s => {
        let fail = state === 'unavailable';
        s.fetch = async url => fail ? json(null, 503) : json(provider === 'anthropic' ? anthropic :
          String(url).endsWith('/usage') ? codex : credits);
        await s.start();
        await s.waitBorder(fail ? /usage unavailable/ : /%/);
        if (state === 'stale') {
          fail = true;
          s.tick(MIN);
          await s.end();
          await s.waitBorder(/stale/);
        }
        for (const [i, width] of [72, 28].entries()) {
          assert.equal(s.border(width), expected[provider][state][i]);
          assert.equal(s.border(width, 1), blank(width));
        }
        assert.deepEqual(s.calls, []);
        assert.deepEqual(s.prompts, []);
      });
    });
  }
}
