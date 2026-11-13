import { fetchIncidents, ack } from './api.js';

const REFRESH_MS = 2000; // R4

const list = document.querySelector('[data-testid="incident-list"]');
const loader = document.querySelector('[data-testid="loader"]');
const empty = document.querySelector('[data-testid="empty"]');
const loadError = document.querySelector('.error[data-kind="load"]');
const ackError = document.querySelector('.error[data-kind="ack"]');

// Rows are kept by incident id, so a refresh never rebuilds or moves an existing row:
// the acked mark and the open row survive every refresh (R1, R2, R4).
const rows = new Map();
const acked = new Set();

// R5: the viewer's own zone and the viewer's own locale order (en-GB, de, fr, en-NZ: day before month).
const timeFormat = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

function localTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : timeFormat.format(d);
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

// Product decision after step 1 (row 00:10 mis-ack): Ack leaves the row. A row opens its incident
// panel, the panel names the incident, and Ack lives there, bound to that id, not to a screen position.
const data = new Map(); // id -> latest incident from the API
const panel = document.querySelector('[data-testid="incident-panel"]');
const panelTitle = panel.querySelector('.panel-title');
const panelFields = panel.querySelector('.panel-fields');
const panelAck = panel.querySelector('[data-testid="panel-ack"]');
const panelAcked = panel.querySelector('.panel-acked');
let openId = null;
const ackedAt = new Map(); // id -> ackedAt from the ack API

function markAcked(row) {
  if (!row.querySelector('[data-testid="acked"]')) row.append(el('span', { 'data-testid': 'acked', class: 'acked' }, 'Acked'));
  row.classList.add('is-acked');
}

function fillPanel() {
  const i = data.get(openId);
  if (!i) return;
  panelTitle.textContent = i.id;
  panelFields.replaceChildren(
    ...[
      ['Severity', i.severity],
      ['Service', i.service],
      ['Region', i.region],
      ['Summary', i.summary],
      ['Opened', localTime(i.openedAt)],
    ].flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]),
  );
  const done = acked.has(i.id);
  panelAck.hidden = done;
  panelAck.disabled = false;
  panelAck.textContent = `Ack ${i.id}`;
  panelAcked.hidden = !done;
  panelAcked.textContent = done ? `Acked ${ackedAt.has(i.id) ? localTime(ackedAt.get(i.id)) : ''}`.trim() : '';
}

function openPanel(id) {
  rows.get(openId)?.classList.remove('is-open');
  rows.get(openId)?.removeAttribute('aria-current');
  openId = id;
  rows.get(id)?.classList.add('is-open');
  rows.get(id)?.setAttribute('aria-current', 'true');
  ackError.hidden = true;
  fillPanel();
  panel.hidden = false;
}

function closePanel() {
  rows.get(openId)?.classList.remove('is-open');
  rows.get(openId)?.removeAttribute('aria-current');
  openId = null;
  panel.hidden = true;
}

async function onPanelAck() {
  const id = openId; // the incident the panel names, whatever the list does meanwhile
  if (!id || acked.has(id)) return;
  panelAck.disabled = true;
  panelAck.textContent = `Acking ${id}…`;
  try {
    const reply = await ack(id);
    acked.add(id);
    ackedAt.set(id, reply.ackedAt);
    const row = rows.get(id);
    if (row) markAcked(row);
    ackError.hidden = true;
  } catch (err) {
    showError(ackError, `Ack failed for ${id}: ${err.message}`); // stays until the next good ack
  }
  if (openId === id) fillPanel();
}

panelAck.addEventListener('click', onPanelAck);
panel.querySelector('.panel-close').addEventListener('click', closePanel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openId) closePanel();
});

function buildRow(i) {
  const row = el('li', { 'data-testid': 'incident-row', 'data-id': i.id, class: `row ${i.severity}`, role: 'button', tabindex: '0', 'aria-label': `Open ${i.id}` });
  row.append(
    el('span', { class: 'id' }, i.id),
    el('span', { class: 'sev' }, i.severity),
    el('span', { class: 'what' }, `${i.service} · ${i.region} · ${i.summary}`),
    el('time', { datetime: i.openedAt, title: i.openedAt }, localTime(i.openedAt)),
  );
  if (acked.has(i.id)) markAcked(row);
  row.addEventListener('click', () => openPanel(i.id));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPanel(i.id);
    }
  });
  return row;
}

function updateRow(row, i) {
  const time = row.querySelector('time');
  if (time.getAttribute('datetime') !== i.openedAt) {
    time.setAttribute('datetime', i.openedAt);
    time.title = i.openedAt;
    time.textContent = localTime(i.openedAt);
  }
}

// incidents arrive newest first; the list follows that order, new ones at the top (R1).
function render(incidents) {
  const seen = new Set();
  let prev = null;
  for (const i of incidents) {
    seen.add(i.id);
    data.set(i.id, i);
    let row = rows.get(i.id);
    if (row) updateRow(row, i);
    else {
      row = buildRow(i);
      rows.set(i.id, row);
    }
    const want = prev ? prev.nextSibling : list.firstChild;
    if (want !== row) list.insertBefore(row, want);
    prev = row;
  }
  for (const [id, row] of rows) {
    if (!seen.has(id)) {
      row.remove();
      rows.delete(id);
      data.delete(id);
      if (openId === id) closePanel();
    }
  }
  empty.hidden = incidents.length > 0;
  if (openId) fillPanel();
}

function showError(box, message) {
  box.textContent = message;
  box.hidden = false;
}

async function refresh() {
  try {
    const page = await fetchIncidents();
    render(page.incidents ?? []);
    loader.remove(); // R3: gone once incidents load
    loadError.hidden = true;
  } catch (err) {
    showError(loadError, `Could not load incidents: ${err.message}. Retrying.`);
  } finally {
    setTimeout(refresh, REFRESH_MS); // R4: one request at a time, every 2 s
  }
}

refresh();
