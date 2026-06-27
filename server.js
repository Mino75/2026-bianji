/*
  Local Publisher Console — unified items/media editor

  Runtime:
    npm i express multer
    node server.js
*/

const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const APP_NAME = String(process.env.APP_NAME || "LocalPublisherConsole").trim();
const STYLE_FILE = process.env.STYLE_FILE || path.join(__dirname, "styles.css");
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE || "25mb";
const MAX_UPLOAD_SIZE_BYTES = Number(process.env.MAX_UPLOAD_SIZE_BYTES || 50 * 1024 * 1024);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_SIZE_BYTES }
});

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

// --------------------------------------------------
// Item proxy API
// --------------------------------------------------

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
      query: { withContent: "true", slug }
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
      body: { ...article, html: encodeHtmlForApi(article.html) }
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
      body: { ...article, html: encodeHtmlForApi(article.html) }
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

// --------------------------------------------------
// Media proxy API
// --------------------------------------------------

app.post("/api/proxy/media/list", async (req, res) => {
  try {
    const publisher = normalizePublisherPayload(req.body);

    const result = await remoteRequest({
      baseUrl: publisher.baseUrl,
      apiKey: publisher.apiKey,
      remotePath: "/api/media/items",
      method: "GET"
    });

    res.status(result.status).json(result.body ?? { rawBody: result.rawBody });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/proxy/media/rename", async (req, res) => {
  try {
    const publisher = normalizePublisherPayload(req.body);
    const targetName = normalizeMediaName(req.body.targetName);
    const name = normalizeMediaName(req.body.name);

    if (!targetName || !name) throw new Error("targetName and name are required.");

    if (path.extname(targetName).toLowerCase() !== path.extname(name).toLowerCase()) {
      throw new Error("Changing media file type is not allowed.");
    }

    const result = await remoteRequest({
      baseUrl: publisher.baseUrl,
      apiKey: publisher.apiKey,
      remotePath: "/api/media/items",
      method: "PUT",
      body: { targetName, name }
    });

    res.status(result.status).json(result.body ?? { rawBody: result.rawBody });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/proxy/media/delete", async (req, res) => {
  try {
    const publisher = normalizePublisherPayload(req.body);
    const name = normalizeMediaName(req.body.name);

    if (!name) throw new Error("name is required.");

    const result = await remoteRequest({
      baseUrl: publisher.baseUrl,
      apiKey: publisher.apiKey,
      remotePath: "/api/media/items",
      method: "DELETE",
      body: { name }
    });

    res.status(result.status).json(result.body ?? { rawBody: result.rawBody });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/proxy/media/upload", upload.single("file"), async (req, res) => {
  try {
    const publisher = normalizePublisherPayload(req.body);

    if (!req.file) throw new Error("A media file is required.");

    const result = await remoteMultipartRequest({
      baseUrl: publisher.baseUrl,
      apiKey: publisher.apiKey,
      remotePath: "/api/media/items",
      file: req.file
    });

    res.status(result.status).json(result.body ?? { rawBody: result.rawBody });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --------------------------------------------------
// Remote request helpers
// --------------------------------------------------

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

  const fetchOptions = { method, headers, signal: controller.signal };

  if (!["GET", "HEAD"].includes(method)) {
    headers["content-type"] = "application/json";
    fetchOptions.body = JSON.stringify(body || {});
  }

  const response = await fetch(url, fetchOptions).finally(() => clearTimeout(timeout));
  const rawBody = await response.text();
  const parsedBody = tryParseJson(rawBody);

  return { ok: response.ok, status: response.status, body: parsedBody, rawBody };
}

async function remoteMultipartRequest({ baseUrl, apiKey, remotePath, file }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const url = new URL(assertSafeRemotePath(remotePath), baseUrl);

  const form = new FormData();
  const blob = new Blob([file.buffer], { type: file.mimetype || "application/octet-stream" });
  form.append("file", blob, file.originalname);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "x-admin-password": apiKey
    },
    body: form,
    signal: controller.signal
  }).finally(() => clearTimeout(timeout));

  const rawBody = await response.text();
  const parsedBody = tryParseJson(rawBody);

  return { ok: response.ok, status: response.status, body: parsedBody, rawBody };
}

// --------------------------------------------------
// Normalization helpers
// --------------------------------------------------

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
      : String(article.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean),
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

function normalizeMediaName(value) {
  const raw = String(value || "").trim();
  const name = path.basename(raw);

  if (!name || name !== raw) {
    throw new Error("Invalid media filename.");
  }

  return name;
}

function assertSafeRemotePath(value) {
  const remotePath = String(value || "").trim();

  if (!remotePath.startsWith("/")) throw new Error("Remote path must start with /.");
  if (remotePath.includes("\\")) throw new Error("Remote path contains invalid characters.");

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

// --------------------------------------------------
// HTML rendering
// --------------------------------------------------

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
    <p>Configure a remote publisher, store the API key in this browser, then read and update items or media through the proxy.</p>
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
    <h2 id="collectionTitle">Items</h2>
    <div>
      <button class="button small" type="button" onclick="switchCollectionMode('items')">Items</button>
      <button class="button small ghost" type="button" onclick="switchCollectionMode('media')">Media</button>
      <button class="button small ghost" type="button" onclick="triggerUpload()">Upload</button>
      <button class="button small ghost" type="button" onclick="reloadCollection()">Reload</button>
    </div>
  </div>
  <input id="uploadInput" type="file" hidden>
  <div id="itemsList" class="empty">No collection loaded.</div>
</section>

<form class="editor-grid" id="editorForm" hidden>
  <section class="panel editor-form" id="metadataPanel">
    <div class="panel-title"><h2 id="metadataTitle">Metadata</h2></div>

    <div id="itemMetadataFields">
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
    </div>

    <div id="mediaMetadataFields" hidden>
      <label>Filename</label>
      <input id="mediaName">

      <input id="mediaTargetName" type="hidden">
      <input id="mediaUrl" type="hidden">
      <input id="mediaType" type="hidden">

      <button type="button" onclick="saveMedia()">Save media</button>
      <button class="ghost" type="button" onclick="deleteMedia()">Delete media</button>
      <button class="ghost" type="button" onclick="copyCurrentMediaUrl()">Copy URL</button>
    </div>
  </section>

  <section class="panel editor-form wide" id="payloadPanel">
    <div class="panel-title">
      <h2 id="payloadTitle">HTML payload</h2>
      <button class="button small ghost" id="previewToggleButton" type="button" onclick="togglePreview()">Toggle preview</button>
    </div>

    <textarea id="html" spellcheck="false"></textarea>
    <div id="mediaViewer" hidden></div>
  </section>
</form>

<section class="panel preview-panel" id="previewPanel" hidden>
  <div class="panel-title"><h2>Preview</h2></div>
  <iframe id="previewFrame" sandbox="allow-same-origin allow-scripts allow-forms allow-popups"></iframe>
</section>

<div id="notice" class="notice" hidden></div>`;
}

// --------------------------------------------------
// Client application
// --------------------------------------------------

function clientScript() {
  return `
(function () {
  const storeKey = 'localPublisherConsole.publishers.v1';
  let activePublisherId = '';
  let activeItemSlug = '';
  let collectionMode = 'items';

  const $ = function (id) { return document.getElementById(id); };

  function getPublishers() {
    try { return JSON.parse(localStorage.getItem(storeKey) || '[]'); }
    catch { return []; }
  }

  function setPublishers(publishers) {
    localStorage.setItem(storeKey, JSON.stringify(publishers));
  }

  function publisherIdFrom(label, baseUrl, type) {
    return [label, baseUrl, type].join('-').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  function getActivePublisher() {
    return getPublishers().find(function (publisher) { return publisher.id === activePublisherId; }) || null;
  }

  function notify(message, kind) {
    const box = $('notice');
    box.hidden = false;
    box.className = 'notice ' + (kind || 'success');
    box.textContent = message;
    setTimeout(function () { box.hidden = true; }, 4500);
  }

  async function postJson(url, payload) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); }
    catch { body = { rawBody: text }; }

    if (!response.ok) {
      throw new Error(body.error || body.rawBody || 'Request failed.');
    }

    return body;
  }

  async function postUpload(url, file) {
    const publisher = getActivePublisher();
    if (!publisher) throw new Error('No active publisher selected.');

    const form = new FormData();
    form.append('baseUrl', publisher.baseUrl);
    form.append('type', publisher.type);
    form.append('apiKey', publisher.apiKey);
    form.append('file', file);

    const response = await fetch(url, { method: 'POST', body: form });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); }
    catch { body = { rawBody: text }; }

    if (!response.ok) {
      throw new Error(body.error || body.rawBody || 'Upload failed.');
    }

    return body;
  }

  function publisherPayload() {
    const publisher = getActivePublisher();
    if (!publisher) throw new Error('No active publisher selected.');
    return { baseUrl: publisher.baseUrl, type: publisher.type, apiKey: publisher.apiKey };
  }

  function escapeHtml(value) {
    return String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  function escapeAttr(value) { return escapeHtml(value); }

  function absoluteMediaUrl(url) {
    const publisher = getActivePublisher();
    if (!publisher || !url) return url || '';
    try { return new URL(url, publisher.baseUrl).toString(); }
    catch { return url || ''; }
  }

  function bytesLabel(value) {
    const size = Number(value || 0);
    if (size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB';
    if (size >= 1024) return (size / 1024).toFixed(1) + ' KB';
    return String(size) + ' B';
  }

  window.loadPublishers = function () {
    const publishers = getPublishers();
    const target = $('publishersList');

    if (!publishers.length) {
      target.className = 'empty';
      target.innerHTML = 'No publisher configured.';
      return;
    }

    target.className = 'table-wrap';
    target.innerHTML = '<table>' +
      '<thead><tr><th>Label</th><th>Base URL</th><th>Type</th><th></th></tr></thead>' +
      '<tbody>' +
      publishers.map(function (publisher) {
        return '<tr>' +
          '<td><strong>' + escapeHtml(publisher.label || publisher.type) + '</strong></td>' +
          '<td><code>' + escapeHtml(publisher.baseUrl) + '</code></td>' +
          '<td><code>' + escapeHtml(publisher.type) + '</code></td>' +
          '<td class="right">' +
            '<button class="button small js-open-publisher" type="button" data-id="' + escapeAttr(publisher.id) + '">Open</button> ' +
            '<button class="button small ghost js-delete-publisher" type="button" data-id="' + escapeAttr(publisher.id) + '">Delete</button>' +
          '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';
  };

  window.selectPublisher = async function (publisherId) {
    activePublisherId = publisherId;
    activeItemSlug = '';
    $('itemsPanel').hidden = false;
    $('editorForm').hidden = true;
    $('previewPanel').hidden = true;
    await reloadCollection();
  };

  window.removePublisher = function (publisherId) {
    if (!confirm('Delete this publisher from this browser?')) return;

    const publishers = getPublishers().filter(function (publisher) { return publisher.id !== publisherId; });
    setPublishers(publishers);

    if (activePublisherId === publisherId) {
      activePublisherId = '';
      $('itemsPanel').hidden = true;
      $('editorForm').hidden = true;
      $('previewPanel').hidden = true;
    }

    loadPublishers();
  };

  window.switchCollectionMode = async function (mode) {
    collectionMode = mode === 'media' ? 'media' : 'items';
    $('editorForm').hidden = true;
    $('previewPanel').hidden = true;
    await reloadCollection();
  };

  window.reloadCollection = async function () {
    if (collectionMode === 'media') return reloadMedia();
    return reloadItems();
  };

  window.reloadItems = async function () {
    try {
      $('collectionTitle').textContent = 'Items';
      const body = await postJson('/api/proxy/list', publisherPayload());
      const items = Array.isArray(body.items) ? body.items : [];
      const target = $('itemsList');

      if (!items.length) {
        target.className = 'empty';
        target.innerHTML = 'No item returned.';
        return;
      }

      target.className = 'table-wrap';
      target.innerHTML = '<table>' +
        '<thead><tr><th>Title</th><th>Slug</th><th>Updated</th><th></th></tr></thead>' +
        '<tbody>' +
        items.map(function (item) {
          return '<tr>' +
            '<td><strong>' + escapeHtml(item.title || item.slug || 'Untitled') + '</strong><small>' + escapeHtml(item.excerpt || '') + '</small></td>' +
            '<td><code>' + escapeHtml(item.slug || '') + '</code></td>' +
            '<td>' + escapeHtml(item.updatedAt || item.publishedAt || '') + '</td>' +
            '<td class="right"><button class="button small js-open-item" type="button" data-slug="' + escapeAttr(item.slug || '') + '">Edit</button></td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>';
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  window.reloadMedia = async function () {
    try {
      $('collectionTitle').textContent = 'Media';
      const body = await postJson('/api/proxy/media/list', publisherPayload());
      const items = Array.isArray(body.items) ? body.items : [];
      const target = $('itemsList');

      if (!items.length) {
        target.className = 'empty';
        target.innerHTML = 'No media returned.';
        return;
      }

      target.className = 'table-wrap';
      target.innerHTML = '<table>' +
        '<thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Updated</th><th></th></tr></thead>' +
        '<tbody>' +
        items.map(function (item) {
          return '<tr>' +
            '<td><strong>' + escapeHtml(item.name || '') + '</strong><small><code>' + escapeHtml(item.url || '') + '</code></small></td>' +
            '<td><code>' + escapeHtml(item.type || '') + '</code></td>' +
            '<td>' + escapeHtml(bytesLabel(item.size || 0)) + '</td>' +
            '<td>' + escapeHtml(item.updatedAt || '') + '</td>' +
            '<td class="right"><button class="button small js-open-media" type="button" data-name="' + escapeAttr(item.name || '') + '" data-url="' + escapeAttr(item.url || '') + '" data-type="' + escapeAttr(item.type || '') + '">Edit</button></td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>';
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  window.openItem = async function (slug) {
    try {
      activeItemSlug = slug;
      collectionMode = 'items';
      const body = await postJson('/api/proxy/read', Object.assign({}, publisherPayload(), { slug: slug }));
      const item = Array.isArray(body.items) ? body.items[0] : null;
      if (!item) throw new Error('Item not found.');

      showItemEditor();
      $('targetSlug').value = item.slug || slug;
      $('slug').value = item.slug || slug;
      $('title').value = item.title || '';
      $('excerpt').value = item.excerpt || '';
      $('publishedAt').value = item.publishedAt || new Date().toISOString();
      $('tags').value = Array.isArray(item.tags) ? item.tags.join(', ') : '';
      $('html').value = item.html || '';
      renderPreview();
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  window.openMedia = function (item) {
    collectionMode = 'media';
    showMediaEditor();
    $('mediaTargetName').value = item.name || '';
    $('mediaName').value = item.name || '';
    $('mediaUrl').value = item.url || '';
    $('mediaType').value = item.type || '';
    renderMediaViewer(item.url || '', item.type || '', item.name || '');
  };

  function showItemEditor() {
    $('editorForm').hidden = false;
    $('itemMetadataFields').hidden = false;
    $('mediaMetadataFields').hidden = true;
    $('html').hidden = false;
    $('mediaViewer').hidden = true;
    $('previewToggleButton').hidden = false;
    $('metadataTitle').textContent = 'Metadata';
    $('payloadTitle').textContent = 'HTML payload';
  }

  function showMediaEditor() {
    $('editorForm').hidden = false;
    $('itemMetadataFields').hidden = true;
    $('mediaMetadataFields').hidden = false;
    $('html').hidden = true;
    $('mediaViewer').hidden = false;
    $('previewPanel').hidden = true;
    $('previewToggleButton').hidden = true;
    $('metadataTitle').textContent = 'Media';
    $('payloadTitle').textContent = 'Media visualisation';
  }

  function collectArticle() {
    return {
      targetSlug: $('targetSlug').value.trim() || activeItemSlug || $('slug').value.trim(),
      slug: $('slug').value.trim(),
      title: $('title').value.trim(),
      excerpt: $('excerpt').value.trim(),
      publishedAt: $('publishedAt').value.trim() || new Date().toISOString(),
      tags: $('tags').value,
      html: $('html').value
    };
  }

  $('publisherForm').addEventListener('submit', function (event) {
    event.preventDefault();

    const label = $('label').value.trim() || $('type').value.trim();
    const baseUrl = $('baseUrl').value.trim().replace(/\\/$/, '');
    const type = $('type').value.trim() || 'article';
    const apiKey = $('apiKey').value.trim();

    if (!baseUrl || !apiKey || !type) {
      notify('Base URL, content type and API key are required.', 'error');
      return;
    }

    const id = publisherIdFrom(label, baseUrl, type);
    const publishers = getPublishers().filter(function (publisher) { return publisher.id !== id; });
    publishers.push({ id: id, label: label, baseUrl: baseUrl, type: type, apiKey: apiKey });
    setPublishers(publishers);
    loadPublishers();
    notify('Publisher saved in this browser.');
  });

  $('editorForm').addEventListener('submit', async function (event) {
    event.preventDefault();
    if (collectionMode === 'media') return saveMedia();

    try {
      await postJson('/api/proxy/save', Object.assign({}, publisherPayload(), { article: collectArticle() }));
      notify('Item saved.');
      await reloadItems();
    } catch (error) {
      notify(error.message, 'error');
    }
  });

  window.createItem = async function () {
    try {
      await postJson('/api/proxy/create', Object.assign({}, publisherPayload(), { article: collectArticle() }));
      notify('Item created.');
      await reloadItems();
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  window.deleteItem = async function () {
    if (!confirm('Delete this item?')) return;
    try {
      await postJson('/api/proxy/delete', Object.assign({}, publisherPayload(), { slug: $('targetSlug').value.trim() || activeItemSlug }));
      notify('Item deleted.');
      $('editorForm').hidden = true;
      await reloadItems();
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  window.saveMedia = async function () {
    const targetName = $('mediaTargetName').value.trim();
    const name = $('mediaName').value.trim();

    if (!targetName || !name) {
      notify('Filename is required.', 'error');
      return;
    }

    try {
      await postJson('/api/proxy/media/rename', Object.assign({}, publisherPayload(), { targetName, name }));
      notify('Media saved.');
      $('mediaTargetName').value = name;
      await reloadMedia();
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  window.deleteMedia = async function () {
    const name = $('mediaTargetName').value.trim() || $('mediaName').value.trim();
    if (!name) return;
    if (!confirm('Delete this media file?')) return;

    try {
      await postJson('/api/proxy/media/delete', Object.assign({}, publisherPayload(), { name }));
      notify('Media deleted.');
      $('editorForm').hidden = true;
      await reloadMedia();
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  window.copyCurrentMediaUrl = async function () {
    const url = $('mediaUrl').value.trim();
    try {
      await navigator.clipboard.writeText(url);
      notify('Media URL copied.');
    } catch {
      notify(url || 'No media URL.');
    }
  };

  window.triggerUpload = function () {
    $('uploadInput').value = '';
    $('uploadInput').click();
  };

  $('uploadInput').addEventListener('change', async function () {
    const file = this.files && this.files[0];
    if (!file) return;

    if (collectionMode === 'media') {
      try {
        const body = await postUpload('/api/proxy/media/upload', file);
        notify('Media uploaded.');
        await reloadMedia();

        const item = body.item || (Array.isArray(body.items) ? body.items[0] : null);
        if (item) openMedia(item);
      } catch (error) {
        notify(error.message, 'error');
      }
      return;
    }

    try {
      const text = await file.text();
      const item = JSON.parse(text);
      showItemEditor();
      activeItemSlug = item.slug || '';
      $('targetSlug').value = item.targetSlug || item.slug || '';
      $('slug').value = item.slug || '';
      $('title').value = item.title || '';
      $('excerpt').value = item.excerpt || '';
      $('publishedAt').value = item.publishedAt || new Date().toISOString();
      $('tags').value = Array.isArray(item.tags) ? item.tags.join(', ') : String(item.tags || '');
      $('html').value = item.html || '';
      renderPreview();
      notify('Item JSON loaded into editor. Use Save or Create to publish.');
    } catch {
      notify('Item upload expects a JSON item file.', 'error');
    }
  });

  window.togglePreview = function () {
    const panel = $('previewPanel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderPreview();
  };

  function renderPreview() {
    const field = $('html');
    const frame = $('previewFrame');
    if (!field || !frame) return;

    const doc = frame.contentDocument || frame.contentWindow.document;
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.6;margin:28px;color:#111827}img{max-width:100%;height:auto}</style></head><body>' + field.value + '</body></html>');
    doc.close();
  }

  function renderMediaViewer(url, type, name) {
    const target = $('mediaViewer');
    const fullUrl = absoluteMediaUrl(url);
    const ext = String(type || name || '').toLowerCase();
    let body = '';

    if (/webp|jpg|jpeg|png|gif|svg/.test(ext)) {
      body = '<img src="' + escapeAttr(fullUrl) + '" alt="' + escapeAttr(name) + '" style="max-width:100%;height:auto;border-radius:12px">';
    } else if (/mp4|webm/.test(ext)) {
      body = '<video controls src="' + escapeAttr(fullUrl) + '" style="width:100%;max-height:520px"></video>';
    } else if (/mp3|wav/.test(ext)) {
      body = '<audio controls src="' + escapeAttr(fullUrl) + '" style="width:100%"></audio>';
    } else if (/pdf/.test(ext)) {
      body = '<iframe src="' + escapeAttr(fullUrl) + '" style="width:100%;height:520px;border:0;border-radius:12px"></iframe>';
    } else {
      body = '<p>No inline preview available.</p>';
    }

    target.innerHTML = '<div>' + body + '<p><code>' + escapeHtml(url || '') + '</code></p></div>';
  }

  document.addEventListener('click', function (event) {
    const openPublisherButton = event.target.closest('.js-open-publisher');
    if (openPublisherButton) { selectPublisher(openPublisherButton.dataset.id); return; }

    const deletePublisherButton = event.target.closest('.js-delete-publisher');
    if (deletePublisherButton) { removePublisher(deletePublisherButton.dataset.id); return; }

    const openItemButton = event.target.closest('.js-open-item');
    if (openItemButton) { openItem(openItemButton.dataset.slug); return; }

    const openMediaButton = event.target.closest('.js-open-media');
    if (openMediaButton) {
      openMedia({
        name: openMediaButton.dataset.name,
        url: openMediaButton.dataset.url,
        type: openMediaButton.dataset.type
      });
    }
  });

  $('html').addEventListener('input', function () {
    clearTimeout(window.__previewTimer);
    window.__previewTimer = setTimeout(renderPreview, 250);
  });

  loadPublishers();
})();
`;
}

app.listen(PORT, HOST, () => {
  console.log(`${APP_NAME} running on http://${HOST}:${PORT}/`);
});
