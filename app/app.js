import { fetchIncidents } from './api.js';

const list = document.querySelector('[data-testid="incident-list"]');

function render(incidents) {
  list.innerHTML = incidents
    .map(
      (i) => `<li data-testid="incident-row" data-id="${i.id}" class="row ${i.severity}">
        <span class="id">${i.id}</span>
        <span class="sev">${i.severity}</span>
        <span class="what">${i.service} · ${i.region} · ${i.summary}</span>
        <time datetime="${i.openedAt}">${i.openedAt}</time>
      </li>`,
    )
    .join('');
}

const page = await fetchIncidents();
render(page.incidents);
