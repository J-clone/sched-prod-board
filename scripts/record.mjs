// Records the deployed board in use: open-board, watch-board, ack-incident (one real ack).
// Usage: node scripts/record.mjs <board url> <out dir>
// Adds a recording overlay (cursor dot, elapsed time, UTC clock) that is not part of the build.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const [url, out = 'recordings'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const size = { width: 1280, height: 900 };
const ctx = await browser.newContext({
  viewport: size,
  locale: 'en-GB',
  timezoneId: 'Europe/Amsterdam',
});
const t0 = Date.now();
const at = (ms = Date.now()) => {
  const s = Math.floor((ms - t0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const events = [];
const note = (what, extra = {}) => {
  const e = { at: at(), ms: Date.now() - t0, utc: new Date().toISOString(), what, ...extra };
  events.push(e);
  console.log(JSON.stringify(e));
};

await ctx.addInitScript((start) => {
  addEventListener('DOMContentLoaded', () => {
    const dot = document.createElement('div');
    dot.style.cssText = 'position:fixed;z-index:99999;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(220,0,60,.55);border:2px solid #c00;pointer-events:none;left:-40px;top:-40px;transition:transform .1s';
    const clock = document.createElement('div');
    clock.style.cssText = 'position:fixed;z-index:99999;right:8px;bottom:8px;font:12px ui-monospace,monospace;background:#000c;color:#fff;padding:4px 8px;border-radius:4px;pointer-events:none';
    document.body.append(dot, clock);
    addEventListener('mousemove', (e) => { dot.style.left = `${e.clientX}px`; dot.style.top = `${e.clientY}px`; }, true);
    addEventListener('mousedown', () => { dot.style.transform = 'scale(1.8)'; }, true);
    addEventListener('mouseup', () => { dot.style.transform = ''; }, true);
    const tick = () => {
      const s = Math.floor((Date.now() - start) / 1000);
      const mmss = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      clock.textContent = `recording ${mmss} · ${new Date().toISOString().slice(11, 19)} UTC`;
      requestAnimationFrame(tick);
    };
    tick();
  });
}, t0);

const page = await ctx.newPage();
// Frames come from Chromium's screencast and go to the system ffmpeg; video time 0 is t0.
const framesDir = `${out}/frames`;
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });
const frames = [];
const cdp = await ctx.newCDPSession(page);
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const file = `f${String(frames.length).padStart(6, '0')}.jpg`;
  writeFileSync(`${framesDir}/${file}`, Buffer.from(data, 'base64'));
  frames.push({ file, ms: metadata.timestamp * 1000 });
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: size.width, maxHeight: size.height });
const ackReplies = [];
if (process.env.DRY) {
  // Dry run: answer the ack locally so no real ack reaches the course.
  await page.route('**/api/ack**', (route) => route.fulfill({ json: { id: new URL(route.request().url()).searchParams.get('id'), ackedAt: new Date().toISOString(), receipt: 'dry-run' } }));
}
page.on('response', async (res) => {
  if (new URL(res.url()).pathname.endsWith('/ack')) ackReplies.push({ status: res.status(), body: await res.json().catch(() => null) });
});

note('open-board: navigate', { url });
await page.goto(url);
await page.getByTestId('incident-row').first().waitFor({ timeout: 20000 });
const sha = await page.locator('meta[name=build]').getAttribute('content');
note('open-board: incidents on screen', { sha, rows: await page.getByTestId('incident-row').count(), loader: await page.getByTestId('loader').count() });
await page.mouse.move(640, 120);
await page.waitForTimeout(3000);

const topId = () => page.getByTestId('incident-row').first().getAttribute('data-id');
async function waitForNewTop(timeout = 30000) {
  const before = await topId();
  await page.waitForFunction((b) => document.querySelector('[data-testid=incident-row]')?.dataset.id !== b, before, { timeout, polling: 50 });
  const now = await topId();
  note('watch-board: new incident at top without reload', { id: now, previousTop: before });
  return now;
}

const race = Boolean(process.env.RACE);
const panelMode = Boolean(process.env.PANEL);
const rowAt = (x, y) => page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('[data-testid=incident-row]')?.dataset.id ?? null, [x, y]);
let target;
if (panelMode) {
  // PANEL=1 (build after product's decision): the same race as RACE=1, then the panel catches it.
  // A person picks a sev1 row and clicks it as a new incident lands; the panel names the incident that
  // was clicked; the person reads it, picks the row they meant, and acks from the panel.
  const seen = await page.getByTestId('incident-row').evaluateAll((els) => els.map((e) => ({ id: e.dataset.id, cls: e.className })));
  target = (seen.find((r, i) => i > 0 && r.cls.includes('sev1')) ?? seen[1]).id;
  const aim = await page.locator(`[data-testid=incident-row][data-id="${target}"]`).boundingBox();
  const x = aim.x + aim.width * 0.4;
  const y = aim.y + aim.height / 2;
  await page.mouse.move(x, y, { steps: 15 });
  note('ack-incident: pointer on the row, reading it', { expected: target, rowUnderPointer: await rowAt(x, y) });
  const before = await topId();
  await page.waitForFunction((b) => document.querySelector('[data-testid=incident-row]')?.dataset.id !== b, before, { timeout: 30000, polling: 'raf' });
  await page.mouse.click(x, y);
  const panelSays = async () => (await page.getByTestId('incident-panel').locator('.panel-title').textContent())?.trim();
  note('ack-incident: click (a new incident landed on top at that moment)', { expected: target, rowUnderPointerAtClick: await rowAt(x, y), newTop: await topId() });
  await page.getByTestId('incident-panel').waitFor();
  const first = await panelSays();
  note('ack-incident: panel opens and names an incident', { expected: target, panelNames: first, acksSoFar: ackReplies.length });
  await page.waitForTimeout(1800); // reading the panel
  if (first !== target) {
    const row = page.locator(`[data-testid=incident-row][data-id="${target}"]`);
    const b2 = await row.boundingBox();
    await page.mouse.move(b2.x + b2.width * 0.4, b2.y + b2.height / 2, { steps: 10 });
    await page.mouse.click(b2.x + b2.width * 0.4, b2.y + b2.height / 2);
    await page.waitForTimeout(300);
    note('ack-incident: wrong incident in the panel, picked the row meant', { expected: target, panelNames: await panelSays() });
    await page.waitForTimeout(1500);
  }
  const ackBtn = page.getByTestId('panel-ack');
  const b3 = await ackBtn.boundingBox();
  await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height / 2, { steps: 10 });
  await page.waitForTimeout(300);
  note('ack-incident: click panel Ack', { expected: target, panelNames: await panelSays(), button: (await ackBtn.textContent())?.trim() });
  await page.mouse.click(b3.x + b3.width / 2, b3.y + b3.height / 2);
  await page.locator(`[data-testid=incident-row][data-id="${target}"] [data-testid=acked]`).waitFor({ timeout: 10000 });
  const reply = ackReplies.at(-1)?.body;
  note('ack-incident: acked', { expected: target, got: reply?.id, acks: ackReplies.length, ackedAt: reply?.ackedAt });
  await page.mouse.move(640, 60, { steps: 8 });
  await waitForNewTop();
  await page.waitForTimeout(1500);
  await waitForNewTop();
  note('watch-board: after more arrivals', { acked: await page.getByTestId('acked').evaluateAll((els) => els.map((e) => e.closest('[data-testid=incident-row]').dataset.id)), panelNames: await panelSays() });
  await page.waitForTimeout(2000);
} else if (race) {
  // RACE=1: click like a person. Pick a sev1 row, move to its Ack, read, click. The board does not
  // hold still meanwhile: the click goes the moment the list changes, at the same spot on screen.
  const seen = await page.getByTestId('incident-row').evaluateAll((els) => els.map((e) => ({ id: e.dataset.id, cls: e.className })));
  target = (seen.find((r, i) => i > 0 && r.cls.includes('sev1')) ?? seen[1]).id;
  const aim = await page.locator(`[data-testid=incident-row][data-id="${target}"] [data-testid=ack]`).boundingBox();
  const x = aim.x + aim.width / 2;
  const y = aim.y + aim.height / 2;
  await page.mouse.move(x, y, { steps: 15 });
  note('ack-incident: pointer on Ack, reading the row', { expected: target, rowUnderPointer: await rowAt(x, y) });
  const before = await topId();
  await page.waitForFunction((b) => document.querySelector('[data-testid=incident-row]')?.dataset.id !== b, before, { timeout: 30000, polling: 'raf' });
  await page.mouse.click(x, y);
  note('ack-incident: click Ack (a new incident landed on top at that moment)', { expected: target, rowUnderPointerAtClick: await rowAt(x, y), newTop: await topId() });
  await page.getByTestId('acked').first().waitFor({ timeout: 10000 });
  const reply = ackReplies.at(-1)?.body;
  const markedRow = await page.getByTestId('acked').first().evaluate((e) => e.closest('[data-testid=incident-row]').dataset.id);
  note('ack-incident: acked', { expected: target, got: reply?.id, markedRow, ackedAt: reply?.ackedAt });
  await page.mouse.move(640, 60, { steps: 8 });
  await waitForNewTop();
  await page.waitForTimeout(1500);
  await waitForNewTop();
  note('watch-board: board after the race', { expectedStillAckable: await page.locator(`[data-testid=incident-row][data-id="${target}"] [data-testid=ack]`).count() });
  await page.waitForTimeout(2000);
} else {
await waitForNewTop();
await page.waitForTimeout(1500);
await waitForNewTop();

// Ack the newest incident straight after it lands, so no refresh moves the row under the pointer.
target = await waitForNewTop();
const button = page.locator(`[data-testid=incident-row][data-id="${target}"] [data-testid=ack]`);
const box = await button.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
await page.waitForTimeout(250);
const rowUnderPointer = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid=incident-row]')?.dataset.id, [box.x + box.width / 2, box.y + box.height / 2]);
note('ack-incident: click Ack', { target, rowUnderPointer });
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.locator(`[data-testid=incident-row][data-id="${target}"] [data-testid=acked]`).waitFor({ timeout: 10000 });
note('ack-incident: row marked Acked', { target, reply: ackReplies.at(-1)?.body ? { id: ackReplies.at(-1).body.id, ackedAt: ackReplies.at(-1).body.ackedAt } : null });
await page.mouse.move(640, 120, { steps: 8 });

// Keep watching: more incidents arrive on top, the acked mark stays.
await waitForNewTop();
await page.waitForTimeout(1500);
await waitForNewTop();
const stillAcked = await page.locator(`[data-testid=incident-row][data-id="${target}"] [data-testid=acked]`).count();
note('watch-board: acked mark still there after refreshes', { target, stillAcked });
await page.waitForTimeout(2000);
}

await cdp.send('Page.stopScreencast');
await ctx.close();
await browser.close();
const end = Date.now();
const lines = frames.map((f, i) => {
  const from = i === 0 ? t0 : f.ms;
  const to = i + 1 < frames.length ? frames[i + 1].ms : end;
  return `file '${f.file}'\nduration ${Math.max(0.001, (to - from) / 1000).toFixed(3)}`;
});
writeFileSync(`${framesDir}/list.txt`, `${lines.join('\n')}\nfile '${frames.at(-1).file}'\n`);
const tag = `${sha.slice(0, 7)}${panelMode ? '-panel' : race ? '-race' : ''}`;
const webm = `${out}/board-${tag}.mp4`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${framesDir}/list.txt`, '-vf', 'fps=25,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-movflags', '+faststart', webm]);
note('video written', { frames: frames.length, seconds: (end - t0) / 1000 });
writeFileSync(`${out}/record-${tag}.json`, JSON.stringify({ url, sha, t0: new Date(t0).toISOString(), events, ackReplies }, null, 2));
console.log(webm);
