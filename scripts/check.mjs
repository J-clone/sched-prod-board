// Local check of the four issues against a fake incident API (no real acks are sent).
// Usage: npm run build -- --allow-dirty && npm test
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  try {
    const body = await readFile(join('dist', path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': types[extname(path) || '.html'] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

const incidents = [
  { id: 'INC-2', service: 'auth', region: 'us-east', summary: 'b <b>bold</b>', severity: 'sev1', openedAt: '2026-11-12T03:03:00.000Z' },
  { id: 'INC-1', service: 'exports', region: 'eu-central', summary: 'a', severity: 'sev3', openedAt: '2026-11-12T02:00:00.000Z' },
];
const fresh = { id: 'INC-3', service: 'sessions', region: 'ap-southeast', summary: 'new', severity: 'sev2', openedAt: '2026-11-12T04:00:00.000Z' };

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });

async function open({ locale, timezoneId, delayFirst = 0 }) {
  const ctx = await browser.newContext({ locale, timezoneId });
  const page = await ctx.newPage();
  const state = { calls: 0, acks: [] };
  await page.route('**/challenges/show-me-when/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/incidents')) {
      state.calls++;
      if (state.calls === 1 && delayFirst) await new Promise((r) => setTimeout(r, delayFirst));
      const list = state.calls >= 3 ? [fresh, ...incidents] : incidents;
      return route.fulfill({ json: { updatedAt: new Date().toISOString(), incidents: list, cursor: `c${state.calls}` } });
    }
    if (url.pathname.endsWith('/ack')) {
      state.acks.push({ id: url.searchParams.get('id'), cursor: url.searchParams.get('cursor') });
      return route.fulfill({ json: { id: url.searchParams.get('id'), ackedAt: new Date().toISOString(), receipt: 'r' } });
    }
    return route.abort();
  });
  await page.goto(base);
  return { ctx, page, state };
}

// SCHED-4512 loader, SCHED-4511 ack, SCHED-4513 refresh, R6 build sha
{
  const { ctx, page, state } = await open({ locale: 'en-GB', timezoneId: 'Europe/London', delayFirst: 800 });
  ok(await page.getByTestId('loader').isVisible(), 'loader shows on open');
  await page.getByTestId('incident-row').first().waitFor();
  ok((await page.getByTestId('loader').count()) === 0, 'loader gone once incidents load');
  ok(await page.getByTestId('empty').isHidden(), 'empty state hidden when there are incidents');
  ok((await page.locator('b').count()) === 0, 'summary text is not parsed as HTML');

  const sha = await page.locator('meta[name=build]').getAttribute('content');
  ok(/^[0-9a-f]{40}$/.test(sha) && (await page.getByTestId('build-sha').textContent()) === sha, `meta build and footer name the same sha (${sha})`);

  await page.locator('[data-testid=incident-row][data-id="INC-1"] [data-testid=ack]').click();
  await page.locator('[data-testid=incident-row][data-id="INC-1"] [data-testid=acked]').waitFor();
  ok(state.acks.length === 1 && state.acks[0].id === 'INC-1' && state.acks[0].cursor?.startsWith('c'), 'Ack sends api.ack for that row with the latest cursor');

  await page.locator('[data-testid=incident-row][data-id="INC-3"]').waitFor({ timeout: 7000 });
  const ids = await page.getByTestId('incident-row').evaluateAll((els) => els.map((e) => e.dataset.id));
  ok(ids.join() === 'INC-3,INC-2,INC-1', `new incident appears at the top without a reload (${ids})`);
  ok((await page.locator('[data-testid=incident-row][data-id="INC-1"] [data-testid=acked]').count()) === 1, 'acked mark survives refreshes');
  const before = state.calls;
  await page.waitForTimeout(4500);
  ok(state.calls - before >= 2 && state.calls - before <= 3, `refreshes about every 2 s (${state.calls - before} calls in 4.5 s)`);
  await ctx.close();
}

// SCHED-4514 local times
for (const [locale, timezoneId, want] of [
  ['en-NZ', 'Pacific/Auckland', /12\/11\/2026.*4:03.*pm|12\/11\/2026.*16:03/i],
  ['de-DE', 'Europe/Berlin', /12\.11\.2026.*04:03/],
  ['en-US', 'America/New_York', /11\/1[12]\/2026.*10:03/],
]) {
  const { ctx, page } = await open({ locale, timezoneId });
  const time = page.locator('[data-testid=incident-row][data-id="INC-2"] time');
  await time.waitFor();
  const text = await time.textContent();
  ok(want.test(text) && (await time.getAttribute('datetime')) === '2026-11-12T03:03:00.000Z', `${timezoneId} ${locale}: "${text}"`);
  await ctx.close();
}

await browser.close();
server.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
