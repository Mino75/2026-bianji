/*
  Local Publisher Console — simplified

  Runtime:
    npm i express
    node server.js

  Environment:
    PORT=3000
    HOST=0.0.0.0
    APP_NAME=LocalPublisherConsole
    STYLE_FILE=/app/styles.css

  Auth model:
    API key is stored in browser localStorage only.
    API key is sent to this server only when proxying a request.
    API key is forwarded to the remote API as: x-admin-password
*/

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const APP_NAME = String(process.env.APP_NAME || "LocalPublisherConsole").trim();
const STYLE_FILE = process.env.STYLE_FILE || path.join(__dirname, "styles.css");
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE || "25mb";

app.use(express.urlencoded({ extended: true, limit: MAX_BODY_SIZE }));
app.use(express.json({ limit: MAX_BODY_SIZE }));

app.get("/styles.css", (req, res) => {
  if (!fs.existsSync(STYLE_FILE)) {
    res.type("text/css").send("");
    return;
  }

  res.type("text/css").send(fs.readFileSync(STYLE_FILE, "utf8"));
});

app.get("/", (req, res) => {
  res.send(renderLayout({
    title: "Dashboard",
    content: renderDashboard()
  }));
});

app.get("/health", (req, res) => {
  res.json({ ok: true, app: APP_NAME, port: PORT });
});

app.post("/api/proxy/list", async (req, res) => {
  try {
    const publisher = normalizePublisherPayload(req.body);
    const result = await remoteRequest({
      baseUrl: publisher.baseUrl,
      apiKey: publisher.apiKey,
      remotePath: `/api/${encodeURIComponent(publisher.type)}/items`,
      method: "GET",
      query: { withContent: "false" }
    });

    res.status(result.status).json(result.body ?? { rawBody: result.rawBody });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/proxy/read", async (req, res) => {
  try {
    const publisher = normalizePublisherPayload(req.body);
    const slug = normalizeSlug(req.body.slug);

    if (!slug) throw new Error("Slug is required.");

    const result = await remoteRequest({
      baseUrl: publisher.baseUrl,
      apiKey: publisher.apiKey,
      remotePath: `/api/${encodeURIComponent(publisher.type)}/items`,
      method: "GET",
      query: {
        withContent: "true",
        slug
      }
    });

    const responseBody = result.body ?? { rawBody: result.rawBody };
    const item = Array.isArray(responseBody.items) ? responseBody.items[0] : null;

    if (item && typeof item.html === "string") {
      item.html = decodeEscapedHtml(item.html);
    }

    res.status(result.status).json(responseBody);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/proxy/save", async (req, res) => {
  try {
    const publisher = normalizePublisherPayload(req.body);
    const article = normalizeArticlePayload(req.body.article || {});

    const result = await remoteRequest({
      baseUrl: publisher.baseUrl,
      apiKey: publisher.apiKey,
      remotePath: `/api/${encodeURIComponent(publisher.type)}/items`,
      method: "PUT",
      body: {
        ...article,
        html: encodeHtmlForApi(article.html)
      }
    });

    res.status(result.status).json(result.body ?? { rawBody: result.rawBody });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/proxy/create", async (req, res) => {
  try {
    const publisher = normalizePublisherPayload(req.body);
    const article = normalizeArticlePayload(req.body.article || {});

    const result = await remoteRequest({
      baseUrl: publisher.baseUrl,
      apiKey: publisher.apiKey,
      remotePath: `/api/${encodeURIComponent(publisher.type)}/items`,
      method: "POST",
      body: {
        ...article,
        html: encodeHtmlForApi(article.html)
      }
    });

    res.status(result.status).json(result.body ?? { rawBody: result.rawBody });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/proxy/delete", async (req, res) => {
  try {
    const publisher = normalizePublisherPayload(req.body);
    const slug = normalizeSlug(req.body.slug);

    if (!slug) throw new Error("Slug is required.");

    const result = await remoteRequest({
      baseUrl: publisher.baseUrl,
      apiKey: publisher.apiKey,
      remotePath: `/api/${encodeURIComponent(publisher.type)}/items`,
      method: "DELETE",
      body: { slug }
    });

    res.status(result.status).json(result.body ?? { rawBody: result.rawBody });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

async function remoteRequest({ baseUrl, apiKey, remotePath, method = "GET", query = null, body = null }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const url = new URL(assertSafeRemotePath(remotePath), baseUrl);

  for (const [key, value] of Object.entries(query || {})) {
    url.searchParams.set(key, value);
  }

  const headers = {
    accept: "application/json, text/plain, */*",
    "x-admin-password": apiKey
  };

  const fetchOptions = {
    method,
    headers,
    signal: controller.signal
  };

  if (!["GET", "HEAD"].includes(method)) {
    headers["content-type"] = "application/json";
    fetchOptions.body = JSON.stringify(body || {});
  }

  const response = await fetch(url, fetchOptions).finally(() => clearTimeout(timeout));
  const rawBody = await response.text();
  const parsedBody = tryParseJson(rawBody);

  return {
    ok: response.ok,
    status: response.status,
    body: parsedBody,
    rawBody
  };
}

function normalizePublisherPayload(body) {
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  const type = normalizeType(body.type || "article");
  const apiKey = String(body.apiKey || "").trim();

  if (!apiKey) throw new Error("API key is required.");

  return { baseUrl, type, apiKey };
}

function normalizeArticlePayload(article) {
  const slug = normalizeSlug(article.slug);
  const targetSlug = normalizeSlug(article.targetSlug || article.slug);

  if (!slug) throw new Error("Slug is required.");

  return {
    targetSlug,
    slug,
    title: String(article.title || "").trim(),
    excerpt: String(article.excerpt || "").trim(),
    publishedAt: String(article.publishedAt || "").trim(),
    tags: Array.isArray(article.tags)
      ? article.tags.map((tag) => String(tag).trim()).filter(Boolean)
      : String(article.tags || "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    html: String(article.html || "")
  };
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/$/, "");

  if (!raw) throw new Error("Base URL is required.");

  const url = new URL(raw);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are allowed.");
  }

  return url.toString().replace(/\/$/, "");
}

function normalizeType(value) {
  const type = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!type) throw new Error("Content type is required.");

  return type;
}

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function assertSafeRemotePath(value) {
  const remotePath = String(value || "").trim();

  if (!remotePath.startsWith("/")) {
    throw new Error("Remote path must start with /.");
  }

  if (remotePath.includes("\\")) {
    throw new Error("Remote path contains invalid characters.");
  }

  return remotePath;
}

function decodeEscapedHtml(value) {
  let output = String(value || "");

  for (let i = 0; i < 2; i += 1) {
    if (!/[\\][nrt"]/.test(output)) break;

    try {
      output = JSON.parse('"' + output.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + '"');
    } catch {
      break;
    }
  }

  return output;
}

function encodeHtmlForApi(value) {
  return String(value || "");
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderLayout({ title, content }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · ${escapeHtml(APP_NAME)}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div id="appShell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">P</div>
        <div>
          <strong>${escapeHtml(APP_NAME)}</strong>
          <span>Local control plane</span>
        </div>
      </div>
      <nav>
        <a class="active" href="/">Dashboard</a>
      </nav>
    </aside>

    <main class="main">
      ${content}
    </main>
  </div>

  <script>${clientScript()}</script>
</body>
</html>`;
}

function renderDashboard() {
  return `
<section class="hero">
  <div>
    <div class="eyebrow">Publisher workspace</div>
    <h1>Publishers</h1>
    <p>Configure a remote publisher, store the API key in this browser, then read and update items through the proxy.</p>
  </div>

  <form class="panel compact-form" id="publisherForm">
    <h2>Publisher</h2>

    <label>Label</label>
    <input id="label" placeholder="Fabu">

    <label>Base URL</label>
    <input id="baseUrl" placeholder="https://fabu.hongkoala.com" required>

    <label>Content type</label>
    <input id="type" value="article" required>

    <label>API key</label>
    <input id="apiKey" type="password" autocomplete="off" placeholder="x-admin-password" required>

    <button type="submit">Save in browser</button>
  </form>
</section>

<section class="panel table-panel">
  <div class="panel-title">
    <h2>Configured publishers</h2>
    <button class="button small" type="button" onclick="loadPublishers()">Refresh</button>
  </div>
  <div id="publishersList" class="empty">No publisher loaded.</div>
</section>

<section class="panel table-panel" id="itemsPanel" hidden>
  <div class="panel-title">
    <h2>Items</h2>
    <button class="button small ghost" type="button" onclick="reloadItems()">Reload</button>
  </div>
  <div id="itemsList" class="empty">No item loaded.</div>
</section>

<form class="editor-grid" id="editorForm" hidden>
  <section class="panel editor-form">
    <div class="panel-title"><h2>Metadata</h2></div>

    <label>Target slug</label>
    <input id="targetSlug">

    <label>Slug</label>
    <input id="slug" required>

    <label>Title</label>
    <input id="title">

    <label>Excerpt</label>
    <input id="excerpt">

    <label>Published at</label>
    <input id="publishedAt">

    <label>Tags</label>
    <input id="tags" placeholder="tag1, tag2">

    <button type="submit">Save item</button>
    <button class="ghost" type="button" onclick="createItem()">Create as new item</button>
    <button class="ghost" type="button" onclick="deleteItem()">Delete item</button>
  </section>

  <section class="panel editor-form wide">
    <div class="panel-title">
      <h2>HTML payload</h2>
      <button class="button small ghost" type="button" onclick="togglePreview()">Toggle preview</button>
    </div>
    <textarea id="html" spellcheck="false"></textarea>
  </section>
</form>

<section class="panel preview-panel" id="previewPanel" hidden>
  <div class="panel-title"><h2>Preview</h2></div>
  <iframe id="previewFrame" sandbox="allow-same-origin allow-scripts allow-forms allow-popups"></iframe>
</section>

<div id="notice" class="notice" hidden></div>`;
}

function clientScript() {
  return "\n" +
"(function () {\n" +
"  const storeKey = 'localPublisherConsole.publishers.v1';\n" +
"  let activePublisherId = '';\n" +
"  let activeItemSlug = '';\n" +
"\n" +
"  const $ = function (id) { return document.getElementById(id); };\n" +
"\n" +
"  function getPublishers() {\n" +
"    try { return JSON.parse(localStorage.getItem(storeKey) || '[]'); }\n" +
"    catch { return []; }\n" +
"  }\n" +
"\n" +
"  function setPublishers(publishers) {\n" +
"    localStorage.setItem(storeKey, JSON.stringify(publishers));\n" +
"  }\n" +
"\n" +
"  function publisherIdFrom(label, baseUrl, type) {\n" +
"    return [label, baseUrl, type].join('-').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');\n" +
"  }\n" +
"\n" +
"  function getActivePublisher() {\n" +
"    return getPublishers().find(function (publisher) { return publisher.id === activePublisherId; }) || null;\n" +
"  }\n" +
"\n" +
"  function notify(message, kind) {\n" +
"    const box = $('notice');\n" +
"    box.hidden = false;\n" +
"    box.className = 'notice ' + (kind || 'success');\n" +
"    box.textContent = message;\n" +
"    setTimeout(function () { box.hidden = true; }, 4500);\n" +
"  }\n" +
"\n" +
"  async function postJson(url, payload) {\n" +
"    const response = await fetch(url, {\n" +
"      method: 'POST',\n" +
"      headers: { 'content-type': 'application/json' },\n" +
"      body: JSON.stringify(payload)\n" +
"    });\n" +
"\n" +
"    const text = await response.text();\n" +
"    let body = null;\n" +
"    try { body = JSON.parse(text); }\n" +
"    catch { body = { rawBody: text }; }\n" +
"\n" +
"    if (!response.ok) {\n" +
"      throw new Error(body.error || body.rawBody || 'Request failed.');\n" +
"    }\n" +
"\n" +
"    return body;\n" +
"  }\n" +
"\n" +
"  function publisherPayload() {\n" +
"    const publisher = getActivePublisher();\n" +
"    if (!publisher) throw new Error('No active publisher selected.');\n" +
"    return { baseUrl: publisher.baseUrl, type: publisher.type, apiKey: publisher.apiKey };\n" +
"  }\n" +
"\n" +
"  function escapeHtml(value) {\n" +
"    return String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\\\"', '&quot;').replaceAll(\"'\", '&#39;');\n" +
"  }\n" +
"\n" +
"  function escapeAttr(value) { return escapeHtml(value); }\n" +
"\n" +
"  window.loadPublishers = function () {\n" +
"    const publishers = getPublishers();\n" +
"    const target = $('publishersList');\n" +
"\n" +
"    if (!publishers.length) {\n" +
"      target.className = 'empty';\n" +
"      target.innerHTML = 'No publisher configured.';\n" +
"      return;\n" +
"    }\n" +
"\n" +
"    target.className = 'table-wrap';\n" +
"    target.innerHTML = '<table>' +\n" +
"      '<thead><tr><th>Label</th><th>Base URL</th><th>Type</th><th></th></tr></thead>' +\n" +
"      '<tbody>' +\n" +
"      publishers.map(function (publisher) {\n" +
"        return '<tr>' +\n" +
"          '<td><strong>' + escapeHtml(publisher.label || publisher.type) + '</strong></td>' +\n" +
"          '<td><code>' + escapeHtml(publisher.baseUrl) + '</code></td>' +\n" +
"          '<td><code>' + escapeHtml(publisher.type) + '</code></td>' +\n" +
"          '<td class=\\\"right\\\">' +\n" +
"            '<button class=\\\"button small js-open-publisher\\\" type=\\\"button\\\" data-id=\\\"' + escapeAttr(publisher.id) + '\\\">Open</button> ' +\n" +
"            '<button class=\\\"button small ghost js-delete-publisher\\\" type=\\\"button\\\" data-id=\\\"' + escapeAttr(publisher.id) + '\\\">Delete</button>' +\n" +
"          '</td>' +\n" +
"        '</tr>';\n" +
"      }).join('') +\n" +
"      '</tbody></table>';\n" +
"  };\n" +
"\n" +
"  window.selectPublisher = async function (publisherId) {\n" +
"    activePublisherId = publisherId;\n" +
"    activeItemSlug = '';\n" +
"    $('itemsPanel').hidden = false;\n" +
"    $('editorForm').hidden = true;\n" +
"    await reloadItems();\n" +
"  };\n" +
"\n" +
"  window.removePublisher = function (publisherId) {\n" +
"    if (!confirm('Delete this publisher from this browser?')) return;\n" +
"\n" +
"    const publishers = getPublishers().filter(function (publisher) { return publisher.id !== publisherId; });\n" +
"    setPublishers(publishers);\n" +
"\n" +
"    if (activePublisherId === publisherId) {\n" +
"      activePublisherId = '';\n" +
"      $('itemsPanel').hidden = true;\n" +
"      $('editorForm').hidden = true;\n" +
"    }\n" +
"\n" +
"    loadPublishers();\n" +
"  };\n" +
"\n" +
"  window.reloadItems = async function () {\n" +
"    try {\n" +
"      const body = await postJson('/api/proxy/list', publisherPayload());\n" +
"      const items = Array.isArray(body.items) ? body.items : [];\n" +
"      const target = $('itemsList');\n" +
"\n" +
"      if (!items.length) {\n" +
"        target.className = 'empty';\n" +
"        target.innerHTML = 'No item returned.';\n" +
"        return;\n" +
"      }\n" +
"\n" +
"      target.className = 'table-wrap';\n" +
"      target.innerHTML = '<table>' +\n" +
"        '<thead><tr><th>Title</th><th>Slug</th><th>Updated</th><th></th></tr></thead>' +\n" +
"        '<tbody>' +\n" +
"        items.map(function (item) {\n" +
"          return '<tr>' +\n" +
"            '<td><strong>' + escapeHtml(item.title || item.slug || 'Untitled') + '</strong><small>' + escapeHtml(item.excerpt || '') + '</small></td>' +\n" +
"            '<td><code>' + escapeHtml(item.slug || '') + '</code></td>' +\n" +
"            '<td>' + escapeHtml(item.updatedAt || item.publishedAt || '') + '</td>' +\n" +
"            '<td class=\\\"right\\\"><button class=\\\"button small js-open-item\\\" type=\\\"button\\\" data-slug=\\\"' + escapeAttr(item.slug || '') + '\\\">Edit</button></td>' +\n" +
"          '</tr>';\n" +
"        }).join('') +\n" +
"        '</tbody></table>';\n" +
"    } catch (error) {\n" +
"      notify(error.message, 'error');\n" +
"    }\n" +
"  };\n" +
"\n" +
"  window.openItem = async function (slug) {\n" +
"    try {\n" +
"      activeItemSlug = slug;\n" +
"      const body = await postJson('/api/proxy/read', Object.assign({}, publisherPayload(), { slug: slug }));\n" +
"      const item = Array.isArray(body.items) ? body.items[0] : null;\n" +
"      if (!item) throw new Error('Item not found.');\n" +
"\n" +
"      $('editorForm').hidden = false;\n" +
"      $('targetSlug').value = item.slug || slug;\n" +
"      $('slug').value = item.slug || slug;\n" +
"      $('title').value = item.title || '';\n" +
"      $('excerpt').value = item.excerpt || '';\n" +
"      $('publishedAt').value = item.publishedAt || new Date().toISOString();\n" +
"      $('tags').value = Array.isArray(item.tags) ? item.tags.join(', ') : '';\n" +
"      $('html').value = item.html || '';\n" +
"      renderPreview();\n" +
"    } catch (error) {\n" +
"      notify(error.message, 'error');\n" +
"    }\n" +
"  };\n" +
"\n" +
"  function collectArticle() {\n" +
"    return {\n" +
"      targetSlug: $('targetSlug').value.trim() || activeItemSlug || $('slug').value.trim(),\n" +
"      slug: $('slug').value.trim(),\n" +
"      title: $('title').value.trim(),\n" +
"      excerpt: $('excerpt').value.trim(),\n" +
"      publishedAt: $('publishedAt').value.trim() || new Date().toISOString(),\n" +
"      tags: $('tags').value,\n" +
"      html: $('html').value\n" +
"    };\n" +
"  }\n" +
"\n" +
"  $('publisherForm').addEventListener('submit', function (event) {\n" +
"    event.preventDefault();\n" +
"\n" +
"    const label = $('label').value.trim() || $('type').value.trim();\n" +
"    const baseUrl = $('baseUrl').value.trim().replace(/\\/$/, '');\n" +
"    const type = $('type').value.trim() || 'article';\n" +
"    const apiKey = $('apiKey').value.trim();\n" +
"\n" +
"    if (!baseUrl || !apiKey || !type) {\n" +
"      notify('Base URL, content type and API key are required.', 'error');\n" +
"      return;\n" +
"    }\n" +
"\n" +
"    const id = publisherIdFrom(label, baseUrl, type);\n" +
"    const publishers = getPublishers().filter(function (publisher) { return publisher.id !== id; });\n" +
"    publishers.push({ id: id, label: label, baseUrl: baseUrl, type: type, apiKey: apiKey });\n" +
"    setPublishers(publishers);\n" +
"    loadPublishers();\n" +
"    notify('Publisher saved in this browser.');\n" +
"  });\n" +
"\n" +
"  $('editorForm').addEventListener('submit', async function (event) {\n" +
"    event.preventDefault();\n" +
"    try {\n" +
"      await postJson('/api/proxy/save', Object.assign({}, publisherPayload(), { article: collectArticle() }));\n" +
"      notify('Item saved.');\n" +
"      await reloadItems();\n" +
"    } catch (error) {\n" +
"      notify(error.message, 'error');\n" +
"    }\n" +
"  });\n" +
"\n" +
"  window.createItem = async function () {\n" +
"    try {\n" +
"      await postJson('/api/proxy/create', Object.assign({}, publisherPayload(), { article: collectArticle() }));\n" +
"      notify('Item created.');\n" +
"      await reloadItems();\n" +
"    } catch (error) {\n" +
"      notify(error.message, 'error');\n" +
"    }\n" +
"  };\n" +
"\n" +
"  window.deleteItem = async function () {\n" +
"    if (!confirm('Delete this item?')) return;\n" +
"    try {\n" +
"      await postJson('/api/proxy/delete', Object.assign({}, publisherPayload(), { slug: $('targetSlug').value.trim() || activeItemSlug }));\n" +
"      notify('Item deleted.');\n" +
"      $('editorForm').hidden = true;\n" +
"      await reloadItems();\n" +
"    } catch (error) {\n" +
"      notify(error.message, 'error');\n" +
"    }\n" +
"  };\n" +
"\n" +
"  window.togglePreview = function () {\n" +
"    const panel = $('previewPanel');\n" +
"    panel.hidden = !panel.hidden;\n" +
"    if (!panel.hidden) renderPreview();\n" +
"  };\n" +
"\n" +
"  function renderPreview() {\n" +
"    const field = $('html');\n" +
"    const frame = $('previewFrame');\n" +
"    if (!field || !frame) return;\n" +
"\n" +
"    const doc = frame.contentDocument || frame.contentWindow.document;\n" +
"    doc.open();\n" +
"    doc.write('<!doctype html><html><head><meta charset=\\\"utf-8\\\"><base target=\\\"_blank\\\"><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.6;margin:28px;color:#111827}img{max-width:100%;height:auto}</style></head><body>' + field.value + '</body></html>');\n" +
"    doc.close();\n" +
"  }\n" +
"\n" +
"  document.addEventListener('click', function (event) {\n" +
"    const openPublisherButton = event.target.closest('.js-open-publisher');\n" +
"    if (openPublisherButton) { selectPublisher(openPublisherButton.dataset.id); return; }\n" +
"\n" +
"    const deletePublisherButton = event.target.closest('.js-delete-publisher');\n" +
"    if (deletePublisherButton) { removePublisher(deletePublisherButton.dataset.id); return; }\n" +
"\n" +
"    const openItemButton = event.target.closest('.js-open-item');\n" +
"    if (openItemButton) openItem(openItemButton.dataset.slug);\n" +
"  });\n" +
"\n" +
"  $('html').addEventListener('input', function () {\n" +
"    clearTimeout(window.__previewTimer);\n" +
"    window.__previewTimer = setTimeout(renderPreview, 250);\n" +
"  });\n" +
"\n" +
"  loadPublishers();\n" +
"})();\n";
}

app.listen(PORT, HOST, () => {
  console.log(`${APP_NAME} running on http://${HOST}:${PORT}/`);
});
