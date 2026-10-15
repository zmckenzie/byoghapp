// Renders registry views as HTML strings. Every dynamic value goes through esc()
// or safeUrl(): entries are contributed data and must never become markup.

import { summarize, TIER_ORDER } from './risk.js';
import { KIND_SUPPORT, TARGET_KINDS } from './launch.js';
import { entryHistoryUrl, entrySourceUrl, reportProblemUrl } from './links.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for HTML content and quoted attribute values. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Only https URLs (or in-page fragments) may become links; anything else becomes "#". */
export function safeUrl(url) {
  const s = String(url ?? '');
  if (s.startsWith('#')) return esc(s);
  try {
    return new URL(s).protocol === 'https:' ? esc(s) : '#';
  } catch {
    return '#';
  }
}

const OWN_APP_LABELS = {
  required: 'Requires your own app',
  optional: 'Own app optional',
  'ghes-only': 'Own app on GitHub Enterprise Server',
};
const SUPPORT_LABELS = { user: 'Personal', org: 'Organization', enterprise: 'Enterprise', ghes: 'GHES' };
const CREDENTIAL_LABELS = {
  app_id: 'App ID',
  client_id: 'Client ID',
  client_secret: 'Client secret',
  private_key: 'Private key',
  webhook_secret: 'Webhook secret',
  installation_id: 'Installation ID',
};
const STATUS_LABELS = { ok: 'Verified', 'needs-review': 'Needs review', failed: 'Verification failed' };

export function tierBadge(tier, table) {
  if (!tier) return '<span class="tier tier-none">Unrated</span>';
  return `<span class="tier tier-${esc(tier)}">${esc(table.tiers[tier]?.label ?? tier)}</span>`;
}

function verificationBadge(entry) {
  const status = entry.verification.status;
  const when = entry.last_verified ? ` on ${esc(entry.last_verified)} by ${esc(entry.verified_by)}` : '';
  return `<span class="status status-${esc(status)}">${esc(STATUS_LABELS[status] ?? status)}</span><span class="muted">${when}</span>`;
}

function supportChips(supports) {
  return Object.entries(SUPPORT_LABELS)
    .filter(([key]) => supports[key])
    .map(([, label]) => `<span class="chip">${esc(label)}</span>`)
    .join('');
}

/** One card in the list view. */
export function renderEntryCard(entry, { table, categories, highest }) {
  return `<li class="card">
  <a class="card-link" href="#/entry/${esc(encodeURIComponent(entry.slug))}">
    <span class="card-title">${esc(entry.name)}</span>
    <span class="card-vendor">${esc(entry.vendor)}</span>
  </a>
  <div class="card-meta">${tierBadge(highest, table)}<span class="chip chip-category">${esc(categories[entry.category] ?? entry.category)}</span>${supportChips(entry.supports)}</div>
  <div class="card-foot">${esc(OWN_APP_LABELS[entry.own_app])} · ${verificationBadge(entry)}</div>
</li>`;
}

/** The list view, including the empty state. */
export function renderEntryList(entries, ctx) {
  if (entries.length === 0) {
    return '<p class="empty">No entries match these filters. <a href="#">Clear filters</a> or <a href="https://github.com/zmckenzie/byoghapp/issues/new?template=new-entry.yml">request an entry</a>.</p>';
  }
  const cards = entries.map((e) => renderEntryCard(e, { ...ctx, highest: ctx.highestBySlug.get(e.slug) })).join('\n');
  return `<p class="count">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}</p>\n<ul class="cards">\n${cards}\n</ul>`;
}

/** Options for a <select>, with the current value selected. */
export function renderOptions(options, selected) {
  return options
    .map(([value, label]) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`)
    .join('');
}

function renderHistogram(histogram, table) {
  return [...TIER_ORDER].reverse()
    .map((t) => `<li><span class="tier tier-${t}">${esc(table.tiers[t].label)}</span> <strong>${histogram[t]}</strong></li>`)
    .join('');
}

/** Risk summary and permission table for the selected variant. */
export function renderRisk(entry, table, variantId) {
  const s = summarize(entry, table, variantId);
  const rows = s.items.map((i) => `<tr>
      <td><a href="${safeUrl(i.docsUrl)}" rel="noreferrer">${esc(i.name)}</a> <code>${esc(i.key)}</code></td>
      <td>${esc(i.scope)}</td>
      <td>${esc(i.level)}</td>
      <td>${tierBadge(i.tier, table)}${i.manualOnly ? ' <span class="chip">Set by hand</span>' : ''}</td>
      <td>${esc(i.blastRadius)}</td>
    </tr>`).join('');
  const webhook = s.webhook.active
    ? `Active, ${s.webhook.events.length} event${s.webhook.events.length === 1 ? '' : 's'}: ${s.webhook.events.map((e) => `<code>${esc(e)}</code>`).join(' ') || 'none'}. Set a webhook secret in GitHub's form.`
    : 'Inactive: GitHub sends no events to the vendor.';
  return `<div class="risk">
  <p class="risk-headline">Highest tier: ${tierBadge(s.highest, table)} ${s.writeAnywhere ? '<span class="flag">Can write</span>' : '<span class="flag flag-ok">Read-only</span>'}</p>
  <ul class="histogram">${renderHistogram(s.histogram, table)}</ul>
  <p><strong>Webhook:</strong> ${webhook}</p>
  ${s.manualOnly.length ? `<p class="warning">${s.manualOnly.map((k) => `<code>${esc(k)}</code>`).join(', ')} can't be pre-filled: add ${s.manualOnly.length === 1 ? 'it' : 'them'} by hand after creating the app.</p>` : ''}
  <div class="table-wrap"><table class="perms">
    <thead><tr><th scope="col">Permission</th><th scope="col">Scope</th><th scope="col">Access</th><th scope="col">Tier</th><th scope="col">What it allows</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</div>`;
}

function renderLauncher(entry, { target, appName }) {
  const kinds = Object.entries(TARGET_KINDS).map(([kind, def]) => {
    const supported = entry.supports[KIND_SUPPORT[kind]];
    return `<label class="radio"><input type="radio" name="kind" value="${esc(kind)}"${target.kind === kind ? ' checked' : ''}${supported ? '' : ' disabled'}> ${esc(def.label)}${supported ? '' : ' <span class="muted">(not supported by the vendor)</span>'}</label>`;
  }).join('');
  return `<section class="launch" aria-labelledby="launch-title">
  <h2 id="launch-title">Create the app</h2>
  <form id="target-form" class="target" novalidate>
    <fieldset><legend>Owner</legend>${kinds}</fieldset>
    <label for="owner">Organization or enterprise name</label>
    <input id="owner" name="owner" autocomplete="off" spellcheck="false" value="${esc(target.owner)}">
    <label for="host">GitHub host <span class="muted">(github.com, a ghe.com host, or your GitHub Enterprise Server)</span></label>
    <input id="host" name="host" autocomplete="off" spellcheck="false" placeholder="${entry.own_app === 'ghes-only' ? 'github.example.com' : 'github.com'}" value="${esc(target.host)}">
    <label for="app-name">App name <span class="muted">(must be unique on the host, at most 34 characters)</span></label>
    <input id="app-name" name="appName" autocomplete="off" maxlength="34" value="${esc(appName)}">
    <p id="target-error" class="error" role="alert" hidden></p>
  </form>
  <p class="launch-actions"><a id="launch-link" class="button" href="#" rel="noreferrer">Open in GitHub</a></p>
  <p class="muted">Opens GitHub's own registration form with these values filled in. Review them there, set a webhook secret if the webhook is on, and generate the private key in GitHub. Nothing secret passes through this site.</p>
  <details class="manifest">
    <summary>Create from manifest instead (opt-in)</summary>
    <p class="warning">GitHub creates the app immediately and sends its private key, client secret and webhook secret back to this page, once. They stay in your browser and are never stored, but you are trusting this page with them. Only for personal and organization owners on github.com or ghe.com.</p>
    <p><button id="manifest-button" type="button">Create from manifest</button></p>
    <p id="manifest-unavailable" class="muted" hidden>Not available for this owner or host: use "Open in GitHub".</p>
  </details>
</section>`;
}

function renderChangelog(entry) {
  const rows = entry.changelog.map((c) => `<tr><td>${esc(c.date)}</td><td>${esc(c.version)}</td><td>${esc(c.author)}</td><td>${esc(c.summary)}${c.pr ? ` (<a href="https://github.com/zmckenzie/byoghapp/pull/${esc(c.pr)}">#${esc(c.pr)}</a>)` : ''}</td></tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr><th scope="col">Date</th><th scope="col">Version</th><th scope="col">Author</th><th scope="col">Change</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** The detail view for one entry. */
export function renderEntryDetail(entry, { table, categories, variantId, target, appName, contributors = [] }) {
  const variantPicker = entry.variants
    ? `<label for="variant">Feature set</label><select id="variant">${renderOptions(entry.variants.map((v) => [v.id, v.name]), variantId ?? entry.variants[0].id)}</select>
       <p class="muted" id="variant-description">${esc(entry.variants.find((v) => v.id === variantId)?.description ?? entry.variants[0].description ?? '')}</p>`
    : '';
  const docs = [entry.documentation_url, ...(entry.documentation_urls ?? [])]
    .map((u) => `<li><a href="${safeUrl(u)}" rel="noreferrer">${esc(u)}</a></li>`).join('');
  const steps = entry.manual_steps.length
    ? `<h2>Steps GitHub's form can't do</h2><ol>${entry.manual_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`
    : '';
  return `<article class="detail" data-slug="${esc(entry.slug)}">
  <p><a href="#">← All entries</a></p>
  <h1>${esc(entry.name)}</h1>
  <p class="lead">${esc(entry.vendor)} · ${esc(categories[entry.category] ?? entry.category)} · ${esc(OWN_APP_LABELS[entry.own_app])}</p>
  <p>${verificationBadge(entry)}</p>
  ${entry.verification.status !== 'ok' ? '<p class="warning">A maintainer has not yet confirmed this entry against the vendor\'s documentation. Check the permissions against the linked docs before you create the app.</p>' : ''}
  ${entry.notes ? `<p>${esc(entry.notes)}</p>` : ''}
  <h2>Vendor documentation</h2><ul class="links">${docs}</ul>
  <p class="links-inline"><a href="${safeUrl(entry.website)}" rel="noreferrer">Website</a> · <a href="${safeUrl(entrySourceUrl(entry))}">Entry YAML</a> · <a href="${safeUrl(entryHistoryUrl(entry))}">History</a> · <a id="report-link" href="${safeUrl(reportProblemUrl(entry))}">Report a problem</a></p>
  <h2>Permissions and risk</h2>
  ${variantPicker}
  <div id="risk">${renderRisk(entry, table, variantId)}</div>
  <h2>Setup facts</h2>
  <dl class="facts">
    <dt>Supported owners</dt><dd>${supportChips(entry.supports) || 'None listed'}</dd>
    <dt>Install on</dt><dd>${esc({ all: 'All repositories', selected: 'Selected repositories', either: 'All or selected repositories' }[entry.install_scope.repositories])} · ${esc(entry.install_scope.level)}${entry.install_scope.notes ? ` · ${esc(entry.install_scope.notes)}` : ''}</dd>
    <dt>Give the vendor</dt><dd>${entry.credentials_needed.map((c) => esc(CREDENTIAL_LABELS[c])).join(', ') || 'Nothing: the vendor stores its own credentials'}</dd>
    <dt>Webhook URL</dt><dd>${entry.two_step_webhook ? 'Known only after the vendor side is set up: replace the placeholder in GitHub\'s form.' : 'Pre-filled'}</dd>
  </dl>
  ${steps}
  ${renderLauncher(entry, { target, appName })}
  <h2>Changelog</h2>
  <p class="muted">GitHub applies an app's permissions only when it's created. If your app is older than the latest change, compare its permissions with this entry.</p>
  ${renderChangelog(entry)}
  ${contributors.length ? `<p class="muted">Contributors: ${contributors.map(esc).join(', ')}</p>` : ''}
</article>`;
}

/** Shown when the hash names an unknown entry. */
export function renderNotFound(slug) {
  return `<article class="detail"><p><a href="#">← All entries</a></p><h1>Entry not found</h1><p>There is no entry called <code>${esc(slug)}</code>.</p></article>`;
}
