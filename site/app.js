// Registry page glue: loads registry.json, routes on the URL hash and wires the
// controls to the pure modules in lib/. Keep logic out of this file.

import { filterEntries, filtersFromHash, hashFromFilters } from './lib/search.js';
import { highestTier, TIER_ORDER } from './lib/risk.js';
import {
  buildLaunchUrl, buildManifest, checkAppName, defaultAppName, defaultTarget, manifestFormAction,
  manifestSupported, newState, parseTarget,
} from './lib/launch.js';
import { rememberLaunch } from './lib/callback.js';
import { renderEntryDetail, renderEntryList, renderNotFound, renderOptions, renderRisk } from './lib/render.js';

const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const filtersForm = $('#filters');
let registry;
let highestBySlug;

async function load() {
  const res = await fetch('registry.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`registry.json returned HTTP ${res.status}`);
  registry = await res.json();
  highestBySlug = new Map(registry.entries.map((e) => [e.slug, highestTier(e, registry.permissions)]));
  $('#category').innerHTML = renderOptions([['', 'All categories'], ...Object.entries(registry.categories.categories)], '');
  $('#tier').innerHTML = renderOptions([['', 'Any'], ...[...TIER_ORDER].map((t) => [t, `${registry.permissions.tiers[t].label} or lower`])], '');
  $('#generated').textContent = `${registry.entries.length} entries, built ${registry.generated_at.slice(0, 10)}`;
}

function showList() {
  const filters = filtersFromHash(location.hash);
  filtersForm.hidden = false;
  $('#q').value = filters.query;
  $('#category').value = filters.category;
  $('#tier').value = filters.maxTier;
  $('#owner-filter').value = filters.owner;
  const entries = filterEntries(registry.entries, filters, { permissions: registry.permissions, categories: registry.categories.categories });
  view.innerHTML = renderEntryList(entries, { table: registry.permissions, categories: registry.categories.categories, highestBySlug });
  document.title = 'byoghapp: GitHub App definitions you own';
}

function readTargetForm() {
  const form = $('#target-form');
  return {
    kind: form.elements.kind.value,
    owner: form.elements.owner.value,
    host: form.elements.host.value,
    appName: form.elements.appName.value,
  };
}

function showDetail(slug) {
  filtersForm.hidden = true;
  const entry = registry.entries.find((e) => e.slug === slug);
  if (!entry) {
    view.innerHTML = renderNotFound(slug);
    return;
  }
  const target = defaultTarget(entry);
  let variantId = entry.variants?.[0].id;
  view.innerHTML = renderEntryDetail(entry, {
    table: registry.permissions,
    categories: registry.categories.categories,
    variantId,
    target,
    appName: defaultAppName(entry),
    contributors: registry.contributors[entry.slug] ?? [],
  });
  document.title = `${entry.name}: byoghapp`;

  const link = $('#launch-link');
  const error = $('#target-error');
  const manifestButton = $('#manifest-button');
  let current = null;

  function update() {
    const input = readTargetForm();
    const parsed = parseTarget(input, { requireHost: entry.own_app === 'ghes-only' });
    const name = checkAppName(input.appName);
    const problem = !parsed.ok ? parsed.error : !name.ok ? name.error : null;
    error.hidden = !problem;
    error.textContent = problem ?? '';
    link.classList.toggle('disabled', Boolean(problem));
    link.setAttribute('aria-disabled', String(Boolean(problem)));
    if (problem) {
      link.removeAttribute('href');
      current = null;
      manifestButton.disabled = true;
      return;
    }
    current = { target: parsed.target, appName: name.name };
    link.href = buildLaunchUrl(entry, { ...current, variantId, table: registry.permissions });
    const supported = manifestSupported(parsed.target);
    manifestButton.disabled = !supported;
    $('#manifest-unavailable').hidden = supported;
  }

  $('#target-form').addEventListener('input', update);
  $('#target-form').addEventListener('submit', (e) => e.preventDefault());
  $('#variant')?.addEventListener('change', (e) => {
    variantId = e.target.value;
    $('#risk').innerHTML = renderRisk(entry, registry.permissions, variantId);
    $('#variant-description').textContent = entry.variants.find((v) => v.id === variantId).description ?? '';
    update();
  });
  manifestButton.addEventListener('click', () => {
    if (!current || !manifestSupported(current.target)) return;
    const state = newState();
    rememberLaunch(sessionStorage, { state, host: current.target.host, slug: entry.slug });
    const redirectUrl = new URL('callback.html', location.href.split('#')[0]).href;
    const form = document.createElement('form');
    form.method = 'post';
    form.action = manifestFormAction(current.target, state);
    const field = document.createElement('input');
    field.type = 'hidden';
    field.name = 'manifest';
    field.value = JSON.stringify(buildManifest(entry, { ...current, variantId, redirectUrl, table: registry.permissions }));
    form.append(field);
    document.body.append(form);
    form.submit();
  });
  update();
}

function route() {
  const match = location.hash.match(/^#\/entry\/([^/?]+)$/);
  if (match) showDetail(decodeURIComponent(match[1]));
  else showList();
  view.focus({ preventScroll: true });
}

filtersForm.addEventListener('input', () => {
  const hash = hashFromFilters({
    query: $('#q').value.trim(),
    category: $('#category').value,
    maxTier: $('#tier').value,
    owner: $('#owner-filter').value,
  });
  history.replaceState(null, '', hash || location.pathname);
  showList();
});
filtersForm.addEventListener('submit', (e) => e.preventDefault());
window.addEventListener('hashchange', route);

load().then(route).catch((err) => {
  view.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'error';
  p.textContent = `Could not load the registry: ${err.message}`;
  view.append(p);
});
