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
      output = JSON.parse(`"${output.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`);
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
  return `
(function () {
  const storeKey = "localPublisherConsole.publishers.v1";
  let activePublisherId = "";
  let activeItemSlug = "";

  const $ = function (id) {
    return document.getElementById(id);
  };

  function getPublishers() {
    try {
      return JSON.parse(localStorage.getItem(storeKey) || "[]");
    } catch {
      return [];
    }
  }

  function setPublishers(publishers) {
    localStorage.setItem(storeKey, JSON.stringify(publishers));
  }

  function publisherIdFrom(label, baseUrl, type) {
    return [label, baseUrl, type]
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function getActivePublisher() {
    return getPublishers().find(function (publisher) {
      return publisher.id === activePublisherId;
    }) || null;
  }

  function notify(message, kind) {
    const box = $("notice");
    box.hidden = false;
    box.className = "notice " + (kind || "success");
    box.textContent = message;
    setTimeout(function () {
      box.hidden = true;
    }, 4500);
  }

  async function postJson(url, payload) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let body = null;

    try {
      body = JSON.parse(text);
    } catch {
      body = { rawBody: text };
    }

    if (!response.ok) {
      throw new Error(body.error || body.rawBody || "Request failed.");
    }

    return body;
  }

  function publisherPayload() {
    const publisher = getActivePublisher();

    if (!publisher) {
      throw new Error("No active publisher selected.");
    }

    return {
      baseUrl: publisher.baseUrl,
      type: publisher.type,
      apiKey: publisher.apiKey
    };
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll("`", "&#96;");
  }

  window.loadPublishers = function () {
    const publishers = getPublishers();
    const target = $("publishersList");

    if (!publishers.length) {
      target.className = "empty";
      target.innerHTML = "No publisher configured.";
      return;
    }

    target.className = "table-wrap";
    target.innerHTML =
      "<table>" +
      "<thead><tr><th>Label</th><th>Base URL</th><th>Type</th><th></th></tr></thead>" +
      "<tbody>" +
      publishers.map(function (publisher) {
        return "<tr>" +
          "<td><strong>" + escapeHtml(publisher.label || publisher.type) + "</strong></td>" +
          "<td><code>" + escapeHtml(publisher.baseUrl) + "</code></td>" +
          "<td><code>" + escapeHtml(publisher.type) + "</code></td>" +
          "<td class='right'>" +
            "<button class='button small js-open-publisher' type='button' data-id='" + escapeAttr(publisher.id) + "'>Open</button> " +
            "<button class='button small ghost js-delete-publisher' type='button' data-id='" + escapeAttr(publisher.id) + "'>Delete</button>" +
          "</td>" +
        "</tr>";
      }).join("") +
      "</tbody></table>";
  };

  window.selectPublisher = async function (publisherId) {
    activePublisherId = publisherId;
    activeItemSlug = "";
    $("itemsPanel").hidden = false;
    $("editorForm").hidden = true;
    await reloadItems();
  };

  window.removePublisher = function (publisherId) {
    if (!confirm("Delete this publisher from this browser?")) return;

    const publishers = getPublishers().filter(function (publisher) {
      return publisher.id !== publisherId;
    });

    setPublishers(publishers);

    if (activePublisherId === publisherId) {
      activePublisherId = "";
      $("itemsPanel").hidden = true;
      $("editorForm").hidden = true;
    }

    loadPublishers();
  };

  window.reloadItems = async function () {
    try {
      const body = await postJson("/api/proxy/list", publisherPayload());
      const items = Array.isArray(body.items) ? body.items : [];
      const target = $("itemsList");

      if (!items.length) {
        target.className = "empty";
        target.innerHTML = "No item returned.";
        return;
      }

      target.className = "table-wrap";
      target.innerHTML =
        "<table>" +
        "<thead><tr><th>Title</th><th>Slug</th><th>Updated</th><th></th></tr></thead>" +
        "<tbody>" +
        items.map(function (item) {
          return "<tr>" +
            "<td><strong>" + escapeHtml(item.title || item.slug || "Untitled") + "</strong><small>" + escapeHtml(item.excerpt || "") + "</small></td>" +
            "<td><code>" + escapeHtml(item.slug || "") + "</code></td>" +
            "<td>" + escapeHtml(item.updatedAt || item.publishedAt || "") + "</td>" +
            "<td class='right'><button class='button small js-open-item' type='button' data-slug='" + escapeAttr(item.slug || "") + "'>Edit</button></td>" +
          "</tr>";
        }).join("") +
        "</tbody></table>";
    } catch (error) {
      notify(error.message, "error");
    }
  };

  window.openItem = async function (slug) {
    try {
      activeItemSlug = slug;

      const body = await postJson("/api/proxy/read", {
        ...publisherPayload(),
        slug
      });

      const item = Array.isArray(body.items) ? body.items[0] : null;

      if (!item) throw new Error("Item not found.");

      $("editorForm").hidden = false;
      $("targetSlug").value = item.slug || slug;
      $("slug").value = item.slug || slug;
      $("title").value = item.title || "";
      $("excerpt").value = item.excerpt || "";
      $("publishedAt").value = item.publishedAt || new Date().toISOString();
      $("tags").value = Array.isArray(item.tags) ? item.tags.join(", ") : "";
      $("html").value = item.html || "";

      renderPreview();
    } catch (error) {
      notify(error.message, "error");
    }
  };

  function collectArticle() {
    return {
      targetSlug: $("targetSlug").value.trim() || activeItemSlug || $("slug").value.trim(),
      slug: $("slug").value.trim(),
      title: $("title").value.trim(),
      excerpt: $("excerpt").value.trim(),
      publishedAt: $("publishedAt").value.trim() || new Date().toISOString(),
      tags: $("tags").value,
      html: $("html").value
    };
  }

  $("publisherForm").addEventListener("submit", function (event) {
    event.preventDefault();

    const label = $("label").value.trim() || $("type").value.trim();
    const baseUrl = $("baseUrl").value.trim().replace(/\/$/, "");
    const type = $("type").value.trim() || "article";
    const apiKey = $("apiKey").value.trim();

    if (!baseUrl || !apiKey || !type) {
      notify("Base URL, content type and API key are required.", "error");
      return;
    }

    const id = publisherIdFrom(label, baseUrl, type);
    const publishers = getPublishers().filter(function (publisher) {
      return publisher.id !== id;
    });

    publishers.push({ id, label, baseUrl, type, apiKey });
    setPublishers(publishers);
    loadPublishers();
    notify("Publisher saved in this browser.");
  });

  $("editorForm").addEventListener("submit", async function (event) {
    event.preventDefault();

    try {
      await postJson("/api/proxy/save", {
        ...publisherPayload(),
        article: collectArticle()
      });

      notify("Item saved.");
      await reloadItems();
    } catch (error) {
      notify(error.message, "error");
    }
  });

  window.createItem = async function () {
    try {
      await postJson("/api/proxy/create", {
        ...publisherPayload(),
        article: collectArticle()
      });

      notify("Item created.");
      await reloadItems();
    } catch (error) {
      notify(error.message, "error");
    }
  };

  window.deleteItem = async function () {
    if (!confirm("Delete this item?")) return;

    try {
      await postJson("/api/proxy/delete", {
        ...publisherPayload(),
        slug: $("targetSlug").value.trim() || activeItemSlug
      });

      notify("Item deleted.");
      $("editorForm").hidden = true;
      await reloadItems();
    } catch (error) {
      notify(error.message, "error");
    }
  };

  window.togglePreview = function () {
    const panel = $("previewPanel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderPreview();
  };

  function renderPreview() {
    const field = $("html");
    const frame = $("previewFrame");
    if (!field || !frame) return;

    const doc = frame.contentDocument || frame.contentWindow.document;
    doc.open();
    doc.write("<!doctype html><html><head><meta charset='utf-8'><base target='_blank'><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.6;margin:28px;color:#111827}img{max-width:100%;height:auto}</style></head><body>" + field.value + "</body></html>");
    doc.close();
  }

  document.addEventListener("click", function (event) {
    const openPublisherButton = event.target.closest(".js-open-publisher");
    if (openPublisherButton) {
      selectPublisher(openPublisherButton.dataset.id);
      return;
    }

    const deletePublisherButton = event.target.closest(".js-delete-publisher");
    if (deletePublisherButton) {
      removePublisher(deletePublisherButton.dataset.id);
      return;
    }

    const openItemButton = event.target.closest(".js-open-item");
    if (openItemButton) {
      openItem(openItemButton.dataset.slug);
    }
  });

  $("html").addEventListener("input", function () {
    clearTimeout(window.__previewTimer);
    window.__previewTimer = setTimeout(renderPreview, 250);
  });

  loadPublishers();
})();`;
}

app.listen(PORT, HOST, () => {
  console.log(`${APP_NAME} running on http://${HOST}:${PORT}/`);
});
