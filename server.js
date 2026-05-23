/*
  Local Publisher Console
  ------------------------------------------------------------
  Single-file local server for managing remote publisher instances.

  Design goals:
  - one server.js runtime file;
  - optional external styles.css next to server.js;
  - if styles.css does not exist, the app renders without custom styles;
  - full server-side rendering;
  - local-only access on 127.0.0.1;
  - 4-digit PIN gate on first launch, stored in the browser only;
  - collections and publisher instances stored locally;
  - publisher passwords are never stored in config.json;
  - credentials are stored in separate local JSON files;
  - a credentials template file can be generated from the UI;
  - remote CRUD calls are proxied server-side to avoid CORS;
  - compatible with backends exposing /api/:type/items.

  Requirements:
    npm init -y
    npm i express
    node server.js

  Optional environment variables:
    PORT=4545
    APP_NAME=LocalPublisherConsole
    DATA_DIR=/path/to/data
    STYLE_FILE=/path/to/styles.css
    MAX_BODY_SIZE=10mb
    REQUEST_TIMEOUT_MS=30000
    DISABLE_OPEN_BROWSER=1
*/

const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { exec } = require("child_process");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const APP_NAME = String(process.env.APP_NAME || "LocalPublisherConsole").trim();
const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE || "10mb";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const SESSION_TOKEN = crypto.randomBytes(32).toString("hex");
const DATA_DIR = process.env.DATA_DIR || getAppDataDir(APP_NAME);
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const CREDENTIALS_DIR = path.join(DATA_DIR, "credentials");
const STYLE_FILE = process.env.STYLE_FILE || path.join(__dirname, "styles.css");

app.use(express.urlencoded({ extended: true, limit: MAX_BODY_SIZE }));
app.use(express.json({ limit: MAX_BODY_SIZE }));

// ------------------------------------------------------------
// Storage
// ------------------------------------------------------------

function getAppDataDir(appName) {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), appName);
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appName);
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), appName);
}

async function ensureStorage() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(CREDENTIALS_DIR, { recursive: true });

  if (!fs.existsSync(CONFIG_FILE)) {
    await writeJsonAtomic(CONFIG_FILE, {
      version: 1,
      collections: []
    });
  }
}

async function readConfig() {
  await ensureStorage();
  const raw = await fsp.readFile(CONFIG_FILE, "utf8");
  const config = JSON.parse(raw);

  if (!config || !Array.isArray(config.collections)) {
    throw new Error("Local configuration is invalid.");
  }

  return config;
}

async function writeConfig(config) {
  await writeJsonAtomic(CONFIG_FILE, {
    version: 1,
    collections: Array.isArray(config.collections) ? config.collections : []
  });
}

async function writeJsonAtomic(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(tempPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fsp.rename(tempPath, filePath);
}

// ------------------------------------------------------------
// Security and validation
// ------------------------------------------------------------

function requireLocalhost(req, res, next) {
  const ip = req.socket.remoteAddress || "";
  const allowed = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

  if (!allowed.has(ip)) {
    return res.status(403).send("Local access only.");
  }

  next();
}

function requireServerToken(req, res, next) {
  const token = req.get("x-local-server-token") || req.query.token || req.body?._token || "";

  if (token !== SESSION_TOKEN) {
    return res.status(401).send("Invalid local server token.");
  }

  next();
}

function normalizeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeLabel(value, fallback) {
  const label = String(value || "").trim();
  return label || fallback;
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/$/, "");
  const url = new URL(raw);

  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are allowed.");
  }

  return url.toString().replace(/\/$/, "");
}

function normalizeLocalFilePath(value) {
  const filePath = String(value || "").trim();
  if (!filePath) return "";
  return path.resolve(filePath);
}

function createCredentialsFileName(collectionId, publisherId) {
  const safeCollectionId = normalizeId(collectionId || "collection");
  const safePublisherId = normalizeId(publisherId || "publisher");
  return `${safeCollectionId}.${safePublisherId}.credentials.json`;
}

function defaultCredentialsPayload({ username = "", password = "", token = "" } = {}) {
  return {
    username: String(username || ""),
    password: String(password || ""),
    token: String(token || ""),
    headers: {}
  };
}

async function generateCredentialsFile({ collectionId, publisherId, username, password, token, overwrite = false }) {
  await ensureStorage();

  const fileName = createCredentialsFileName(collectionId, publisherId);
  const filePath = path.join(CREDENTIALS_DIR, fileName);

  if (fs.existsSync(filePath) && !overwrite) {
    return {
      created: false,
      filePath
    };
  }

  await writeJsonAtomic(filePath, defaultCredentialsPayload({ username, password, token }));

  return {
    created: true,
    filePath
  };
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

function findCollection(config, collectionId) {
  const id = normalizeId(collectionId);
  return config.collections.find((collection) => collection.id === id) || null;
}

function findPublisher(config, collectionId, publisherId) {
  const collection = findCollection(config, collectionId);
  if (!collection) return null;
  const id = normalizeId(publisherId);
  return (collection.publishers || []).find((publisher) => publisher.id === id) || null;
}

async function readCredentialsFile(credentialsFilePath) {
  const filePath = normalizeLocalFilePath(credentialsFilePath);

  if (!filePath) {
    throw new Error("A credentials file path is required for this publisher.");
  }

  const raw = await fsp.readFile(filePath, "utf8");
  const data = JSON.parse(raw);

  return {
    username: String(data.username || data.user || ""),
    password: String(data.password || data.adminPassword || ""),
    token: String(data.token || ""),
    headers: data.headers && typeof data.headers === "object" ? data.headers : {}
  };
}

function buildAuthHeaders(credentials) {
  const headers = {};

  if (credentials.password) {
    headers["x-admin-password"] = credentials.password;
  }

  if (credentials.username && credentials.password) {
    const basic = Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64");
    headers.authorization = `Basic ${basic}`;
  }

  if (credentials.token) {
    headers.authorization = `Bearer ${credentials.token}`;
  }

  for (const [key, value] of Object.entries(credentials.headers || {})) {
    const lower = String(key).toLowerCase();
    if (["host", "connection", "content-length"].includes(lower)) continue;
    headers[key] = String(value);
  }

  return headers;
}

async function remoteRequest(publisher, remotePath, options = {}) {
  const credentials = await readCredentialsFile(publisher.credentialsFilePath);
  const method = String(options.method || "GET").toUpperCase();
  const url = `${publisher.baseUrl}${assertSafeRemotePath(remotePath)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const headers = {
    accept: "application/json, text/plain, */*",
    "user-agent": `${APP_NAME}/1.0`,
    ...buildAuthHeaders(credentials),
    ...(options.headers || {})
  };

  if (!["GET", "HEAD"].includes(method)) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: ["GET", "HEAD"].includes(method) ? undefined : JSON.stringify(options.body ?? {}),
    signal: controller.signal
  }).finally(() => clearTimeout(timeout));

  const text = await response.text();
  const body = tryParseJson(text);

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    body,
    rawBody: text
  };
}

// ------------------------------------------------------------
// Routes
// ------------------------------------------------------------

if (process.env.ALLOW_REMOTE !== "1") {
  app.use(requireLocalhost);
}

app.get("/styles.css", (req, res) => {
  try {
    if (!fs.existsSync(STYLE_FILE)) {
      res.type("text/css").send("");
      return;
    }

    res.type("text/css").send(fs.readFileSync(STYLE_FILE, "utf8"));
  } catch (error) {
    res.type("text/css").send("");
  }
});

app.get("/", async (req, res) => {
  const config = await readConfig();
  res.send(renderLayout({
    title: "Dashboard",
    active: "dashboard",
    content: renderDashboard(config),
    script: clientBootstrapScript()
  }));
});

app.get("/setup", (req, res) => {
  res.send(renderLayout({
    title: "Security setup",
    active: "setup",
    content: renderSetup(),
    script: clientBootstrapScript()
  }));
});

app.post("/collections", requireServerToken, async (req, res) => {
  try {
    const config = await readConfig();
    const now = new Date().toISOString();
    const id = normalizeId(req.body.id || req.body.label || "collection");
    if (!id) throw new Error("A valid collection id is required.");

    if (config.collections.some((collection) => collection.id === id)) {
      throw new Error(`Collection already exists: ${id}`);
    }

    config.collections.push({
      id,
      label: normalizeLabel(req.body.label, id),
      publishers: [],
      createdAt: now,
      updatedAt: now
    });

    config.collections.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    await writeConfig(config);
    res.redirect("/");
  } catch (error) {
    res.status(400).send(renderError(error));
  }
});

app.post("/collections/:collectionId/delete", requireServerToken, async (req, res) => {
  const config = await readConfig();
  const collectionId = normalizeId(req.params.collectionId);
  config.collections = config.collections.filter((collection) => collection.id !== collectionId);
  await writeConfig(config);
  res.redirect("/");
});

app.post("/collections/:collectionId/publishers", requireServerToken, async (req, res) => {
  try {
    const config = await readConfig();
    const collection = findCollection(config, req.params.collectionId);
    if (!collection) throw new Error("Collection not found.");

    const now = new Date().toISOString();
    const id = normalizeId(req.body.id || req.body.label || "publisher");
    if (!id) throw new Error("A valid publisher id is required.");

    collection.publishers = Array.isArray(collection.publishers) ? collection.publishers : [];

    if (collection.publishers.some((publisher) => publisher.id === id)) {
      throw new Error(`Publisher already exists: ${id}`);
    }

    let credentialsFilePath = normalizeLocalFilePath(req.body.credentialsFilePath);
    const credentialsMode = String(req.body.credentialsMode || "generate");

    if (credentialsMode === "generate" || !credentialsFilePath) {
      const generated = await generateCredentialsFile({
        collectionId: collection.id,
        publisherId: id,
        username: req.body.credentialsUsername,
        password: req.body.credentialsPassword,
        token: req.body.credentialsToken,
        overwrite: String(req.body.overwriteCredentials || "") === "on"
      });
      credentialsFilePath = generated.filePath;
    } else if (!fs.existsSync(credentialsFilePath)) {
      throw new Error(`Credentials file does not exist: ${credentialsFilePath}. Use generate mode or create the file first.`);
    }

    collection.publishers.push({
      id,
      label: normalizeLabel(req.body.label, id),
      baseUrl: normalizeBaseUrl(req.body.baseUrl),
      defaultType: normalizeId(req.body.defaultType || "article") || "article",
      credentialsFilePath,
      createdAt: now,
      updatedAt: now
    });

    collection.publishers.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    collection.updatedAt = now;

    await writeConfig(config);
    res.redirect(`/collections/${collection.id}`);
  } catch (error) {
    res.status(400).send(renderError(error));
  }
});

app.post("/collections/:collectionId/publishers/:publisherId/credentials", requireServerToken, async (req, res) => {
  try {
    const config = await readConfig();
    const collection = findCollection(config, req.params.collectionId);
    const publisher = findPublisher(config, req.params.collectionId, req.params.publisherId);

    if (!collection || !publisher) {
      throw new Error("Publisher not found.");
    }

    const generated = await generateCredentialsFile({
      collectionId: collection.id,
      publisherId: publisher.id,
      username: req.body.credentialsUsername,
      password: req.body.credentialsPassword,
      token: req.body.credentialsToken,
      overwrite: String(req.body.overwriteCredentials || "") === "on"
    });

    publisher.credentialsFilePath = generated.filePath;
    publisher.updatedAt = new Date().toISOString();
    collection.updatedAt = publisher.updatedAt;

    await writeConfig(config);
    res.redirect(`/collections/${collection.id}/publishers/${publisher.id}?credentials=${generated.created ? "created" : "existing"}`);
  } catch (error) {
    res.status(400).send(renderError(error));
  }
});

app.post("/collections/:collectionId/publishers/:publisherId/delete", requireServerToken, async (req, res) => {
  const config = await readConfig();
  const collection = findCollection(config, req.params.collectionId);
  if (collection) {
    const publisherId = normalizeId(req.params.publisherId);
    collection.publishers = (collection.publishers || []).filter((publisher) => publisher.id !== publisherId);
    collection.updatedAt = new Date().toISOString();
    await writeConfig(config);
  }
  res.redirect(`/collections/${normalizeId(req.params.collectionId)}`);
});

app.get("/collections/:collectionId", async (req, res) => {
  const config = await readConfig();
  const collection = findCollection(config, req.params.collectionId);

  if (!collection) {
    return res.status(404).send(renderError(new Error("Collection not found.")));
  }

  res.send(renderLayout({
    title: collection.label,
    active: "collections",
    content: renderCollection(collection),
    script: clientBootstrapScript()
  }));
});

app.get("/collections/:collectionId/publishers/:publisherId", async (req, res) => {
  const config = await readConfig();
  const collection = findCollection(config, req.params.collectionId);
  const publisher = findPublisher(config, req.params.collectionId, req.params.publisherId);

  if (!collection || !publisher) {
    return res.status(404).send(renderError(new Error("Publisher not found.")));
  }

  const type = normalizeId(req.query.type || publisher.defaultType || "article") || "article";
  let result = null;
  let error = null;

  try {
    result = await remoteRequest(publisher, `/api/${encodeURIComponent(type)}/items?withContent=false`);
    if (!result.ok) {
      error = new Error(result.body?.error || result.statusText || `HTTP ${result.status}`);
    }
  } catch (requestError) {
    error = requestError;
  }

  const items = result?.body?.items || [];

  res.send(renderLayout({
    title: publisher.label,
    active: "publishers",
    content: renderPublisher({ collection, publisher, type, items, error, credentialsStatus: req.query.credentials }),
    script: clientBootstrapScript()
  }));
});

app.get("/collections/:collectionId/publishers/:publisherId/articles/:slug", async (req, res) => {
  const config = await readConfig();
  const collection = findCollection(config, req.params.collectionId);
  const publisher = findPublisher(config, req.params.collectionId, req.params.publisherId);

  if (!collection || !publisher) {
    return res.status(404).send(renderError(new Error("Publisher not found.")));
  }

  const type = normalizeId(req.query.type || publisher.defaultType || "article") || "article";
  const slug = normalizeId(req.params.slug);
  let article = null;
  let error = null;

  try {
    const result = await remoteRequest(
      publisher,
      `/api/${encodeURIComponent(type)}/items?withContent=true&slug=${encodeURIComponent(slug)}`
    );

    if (!result.ok) {
      error = new Error(result.body?.error || result.statusText || `HTTP ${result.status}`);
    } else {
      article = result.body?.items?.[0] || null;
    }
  } catch (requestError) {
    error = requestError;
  }

  res.send(renderLayout({
    title: article?.title || slug,
    active: "article",
    content: renderArticle({ collection, publisher, type, slug, article, error, updated: req.query.updated }),
    script: clientBootstrapScript()
  }));
});

app.post("/collections/:collectionId/publishers/:publisherId/articles/:slug", requireServerToken, async (req, res) => {
  const config = await readConfig();
  const publisher = findPublisher(config, req.params.collectionId, req.params.publisherId);

  if (!publisher) {
    return res.status(404).send(renderError(new Error("Publisher not found.")));
  }

  const type = normalizeId(req.body.type || publisher.defaultType || "article") || "article";
  const targetSlug = normalizeId(req.params.slug);

  const payload = {
    targetSlug,
    slug: normalizeId(req.body.slug || targetSlug),
    title: String(req.body.title || "").trim(),
    excerpt: String(req.body.excerpt || "").trim(),
    publishedAt: String(req.body.publishedAt || "").trim(),
    tags: String(req.body.tags || "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    html: String(req.body.html || "")
  };

  try {
    const result = await remoteRequest(publisher, `/api/${encodeURIComponent(type)}/items`, {
      method: "PUT",
      body: payload
    });

    if (!result.ok) {
      throw new Error(result.body?.error || result.statusText || `HTTP ${result.status}`);
    }

    res.redirect(`/collections/${normalizeId(req.params.collectionId)}/publishers/${publisher.id}/articles/${payload.slug}?type=${encodeURIComponent(type)}&updated=1`);
  } catch (error) {
    res.status(400).send(renderError(error));
  }
});

app.get("/credentials-template", (req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-disposition", "attachment; filename=publisher-credentials.example.json");
  res.send(JSON.stringify(defaultCredentialsPayload({ password: "your-admin-password" }), null, 2) + "\n");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: APP_NAME,
    port: PORT,
    dataDir: DATA_DIR,
    credentialsDir: CREDENTIALS_DIR,
    styleFile: STYLE_FILE,
    styleLoaded: fs.existsSync(STYLE_FILE)
  });
});

// ------------------------------------------------------------
// Rendering
// ------------------------------------------------------------

function renderLayout({ title, active, content, script = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · ${escapeHtml(APP_NAME)}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body data-token="${SESSION_TOKEN}">
  <div id="pinGate" class="pin-gate" hidden>
    <form class="pin-card" id="pinForm">
      <div class="eyebrow">Local access</div>
      <h1>Unlock console</h1>
      <p id="pinHint">Create a 4-digit PIN for this browser.</p>
      <input id="pinInput" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="••••" autocomplete="off" required>
      <button type="submit">Continue</button>
      <p class="microcopy">The PIN is stored in this browser only. It is a local convenience lock, not remote authentication.</p>
    </form>
  </div>

  <div id="appShell" hidden>
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">P</div>
        <div>
          <strong>${escapeHtml(APP_NAME)}</strong>
          <span>Local control plane</span>
        </div>
      </div>
      <nav>
        <a class="${active === "dashboard" ? "active" : ""}" href="/">Dashboard</a>
        <a class="${active === "setup" ? "active" : ""}" href="/setup">Security setup</a>
        <a href="/credentials-template">Credentials template</a>
      </nav>
      <div class="sidebar-footer">
        <span>Data</span>
        <code>${escapeHtml(DATA_DIR)}</code>
        <span>Credentials</span>
        <code>${escapeHtml(CREDENTIALS_DIR)}</code>
        <span>Stylesheet</span>
        <code>${escapeHtml(STYLE_FILE)}</code>
      </div>
    </aside>

    <main class="main">
      ${content}
    </main>
  </div>

  <script>${script}</script>
</body>
</html>`;
}

function renderDashboard(config) {
  return `
<section class="hero">
  <div>
    <div class="eyebrow">Publisher workspace</div>
    <h1>Collections</h1>
    <p>Group remote publisher instances, load articles through the local proxy, then inspect and update HTML payloads without browser CORS friction.</p>
  </div>
  <form class="panel compact-form" method="post" action="/collections">
    ${tokenInput()}
    <h2>Add collection</h2>
    <label>Collection ID</label>
    <input name="id" placeholder="newsroom" required>
    <label>Label</label>
    <input name="label" placeholder="Newsroom">
    <button type="submit">Create collection</button>
  </form>
</section>

<section class="grid-list">
  ${config.collections.length ? config.collections.map(renderCollectionCard).join("") : renderEmptyState("No collection yet", "Create your first collection to register publisher instances.")}
</section>`;
}

function renderCollectionCard(collection) {
  const count = Array.isArray(collection.publishers) ? collection.publishers.length : 0;
  return `
<article class="panel card-link">
  <a class="card-cover" href="/collections/${encodeURIComponent(collection.id)}"></a>
  <div class="card-topline">
    <span class="badge">${count} publisher${count === 1 ? "" : "s"}</span>
    <form method="post" action="/collections/${encodeURIComponent(collection.id)}/delete" onsubmit="return confirm('Delete this collection?')">
      ${tokenInput()}
      <button class="icon-button" title="Delete" type="submit">×</button>
    </form>
  </div>
  <h2>${escapeHtml(collection.label)}</h2>
  <p>${escapeHtml(collection.id)}</p>
</article>`;
}

function renderCollection(collection) {
  const publishers = Array.isArray(collection.publishers) ? collection.publishers : [];

  return `
<section class="hero">
  <div>
    <div class="eyebrow">Collection</div>
    <h1>${escapeHtml(collection.label)}</h1>
    <p>Register publisher instances. Generate a local credentials file or link an existing one. The server config stores only the file path.</p>
  </div>
  <form class="panel compact-form" method="post" action="/collections/${encodeURIComponent(collection.id)}/publishers">
    ${tokenInput()}
    <h2>Add publisher</h2>
    <label>Publisher ID</label>
    <input name="id" placeholder="prod-fr" required>
    <label>Label</label>
    <input name="label" placeholder="Production FR">
    <label>Base URL</label>
    <input name="baseUrl" placeholder="https://example.com" required>
    <label>Default content type</label>
    <input name="defaultType" value="article" required>

    <div class="segmented">
      <label><input type="radio" name="credentialsMode" value="generate" checked> Generate credentials file</label>
      <label><input type="radio" name="credentialsMode" value="existing"> Use existing file</label>
    </div>

    <div class="credential-generation-fields">
      <label>Credentials username</label>
      <input name="credentialsUsername" placeholder="optional">
      <label>Credentials password</label>
      <input name="credentialsPassword" type="password" placeholder="admin password or leave empty template">
      <label>Credentials bearer token</label>
      <input name="credentialsToken" type="password" placeholder="optional">
      <label class="checkbox"><input type="checkbox" name="overwriteCredentials"> Overwrite existing generated file</label>
    </div>

    <div class="credential-existing-fields">
      <label>Existing credentials file path</label>
      <input name="credentialsFilePath" placeholder="/path/to/publisher-credentials.json">
    </div>

    <button type="submit">Add publisher</button>
  </form>
</section>

<section class="grid-list">
  ${publishers.length ? publishers.map((publisher) => renderPublisherCard(collection, publisher)).join("") : renderEmptyState("No publisher yet", "Add a remote instance to list articles.")}
</section>`;
}

function renderPublisherCard(collection, publisher) {
  return `
<article class="panel card-link">
  <a class="card-cover" href="/collections/${encodeURIComponent(collection.id)}/publishers/${encodeURIComponent(publisher.id)}"></a>
  <div class="card-topline">
    <span class="badge">${escapeHtml(publisher.defaultType || "article")}</span>
    <form method="post" action="/collections/${encodeURIComponent(collection.id)}/publishers/${encodeURIComponent(publisher.id)}/delete" onsubmit="return confirm('Delete this publisher?')">
      ${tokenInput()}
      <button class="icon-button" title="Delete" type="submit">×</button>
    </form>
  </div>
  <h2>${escapeHtml(publisher.label)}</h2>
  <p>${escapeHtml(publisher.baseUrl)}</p>
  <code>${escapeHtml(publisher.credentialsFilePath)}</code>
</article>`;
}

function renderPublisher({ collection, publisher, type, items, error, credentialsStatus }) {
  const credentialNotice = credentialsStatus === "created"
    ? renderNotice("success", "Credentials file generated and linked.")
    : credentialsStatus === "existing"
      ? renderNotice("success", "Existing credentials file path linked.")
      : "";

  return `
<section class="page-head">
  <div>
    <div class="eyebrow">Publisher</div>
    <h1>${escapeHtml(publisher.label)}</h1>
    <p>${escapeHtml(publisher.baseUrl)}</p>
    <p><code>${escapeHtml(publisher.credentialsFilePath)}</code></p>
  </div>
  <form class="inline-form" method="get">
    <label>Type</label>
    <input name="type" value="${escapeAttr(type)}">
    <button type="submit">Reload</button>
  </form>
</section>

${credentialNotice}
${error ? renderNotice("error", error.message) : ""}

<section class="panel compact-form credentials-panel">
  <h2>Generate or relink credentials file</h2>
  <form method="post" action="/collections/${encodeURIComponent(collection.id)}/publishers/${encodeURIComponent(publisher.id)}/credentials">
    ${tokenInput()}
    <label>Username</label>
    <input name="credentialsUsername" placeholder="optional">
    <label>Password</label>
    <input name="credentialsPassword" type="password" placeholder="admin password or leave empty template">
    <label>Bearer token</label>
    <input name="credentialsToken" type="password" placeholder="optional">
    <label class="checkbox"><input type="checkbox" name="overwriteCredentials"> Overwrite existing generated file</label>
    <button type="submit">Generate credentials file</button>
  </form>
</section>

<section class="panel table-panel">
  <div class="panel-title">
    <h2>Articles</h2>
    <span class="badge">${items.length} item${items.length === 1 ? "" : "s"}</span>
  </div>
  ${items.length ? renderArticlesTable(collection, publisher, type, items) : renderEmptyState("No article returned", "The remote endpoint returned an empty list or could not be parsed.")}
</section>`;
}

function renderArticlesTable(collection, publisher, type, items) {
  return `
<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Title</th>
        <th>Slug</th>
        <th>Updated</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      ${items.map((item) => `
      <tr>
        <td><strong>${escapeHtml(item.title || item.slug)}</strong><small>${escapeHtml(item.excerpt || "")}</small></td>
        <td><code>${escapeHtml(item.slug)}</code></td>
        <td>${escapeHtml(item.updatedAt || item.publishedAt || "")}</td>
        <td class="right"><a class="button small" href="/collections/${encodeURIComponent(collection.id)}/publishers/${encodeURIComponent(publisher.id)}/articles/${encodeURIComponent(item.slug)}?type=${encodeURIComponent(type)}">Display</a></td>
      </tr>`).join("")}
    </tbody>
  </table>
</div>`;
}

function renderArticle({ collection, publisher, type, slug, article, error, updated }) {
  if (error) {
    return `
<section class="page-head">
  <div>
    <div class="eyebrow">Article</div>
    <h1>${escapeHtml(slug)}</h1>
  </div>
</section>
${renderNotice("error", error.message)}`;
  }

  if (!article) {
    return `
<section class="page-head">
  <div>
    <div class="eyebrow">Article</div>
    <h1>${escapeHtml(slug)}</h1>
  </div>
</section>
${renderEmptyState("Article not found", "The remote publisher did not return content for this slug.")}`;
  }

  return `
<section class="page-head">
  <div>
    <div class="eyebrow">Article editor</div>
    <h1>${escapeHtml(article.title || article.slug)}</h1>
    <p><code>${escapeHtml(article.slug)}</code> · ${escapeHtml(article.updatedAt || "")}</p>
  </div>
  <a class="button ghost" href="/collections/${encodeURIComponent(collection.id)}/publishers/${encodeURIComponent(publisher.id)}?type=${encodeURIComponent(type)}">Back to list</a>
</section>

${updated ? renderNotice("success", "Article updated.") : ""}

<form class="editor-grid" method="post" action="/collections/${encodeURIComponent(collection.id)}/publishers/${encodeURIComponent(publisher.id)}/articles/${encodeURIComponent(slug)}">
  ${tokenInput()}
  <input type="hidden" name="type" value="${escapeAttr(type)}">

  <section class="panel editor-form">
    <div class="panel-title"><h2>Metadata</h2></div>
    <label>Slug</label>
    <input name="slug" value="${escapeAttr(article.slug || slug)}" required>
    <label>Title</label>
    <input name="title" value="${escapeAttr(article.title || "")}" required>
    <label>Excerpt</label>
    <input name="excerpt" value="${escapeAttr(article.excerpt || "")}">
    <label>Published at</label>
    <input name="publishedAt" value="${escapeAttr(article.publishedAt || new Date().toISOString())}" required>
    <label>Tags</label>
    <input name="tags" value="${escapeAttr(Array.isArray(article.tags) ? article.tags.join(", ") : "")}">
    <button type="submit">Update article</button>
  </section>

  <section class="panel editor-form wide">
    <div class="panel-title">
      <h2>HTML payload</h2>
      <button class="button small ghost" type="button" onclick="togglePreview()">Toggle preview</button>
    </div>
    <textarea id="htmlField" name="html" spellcheck="false">${escapeHtml(article.html || "")}</textarea>
  </section>
</form>

<section class="panel preview-panel" id="previewPanel">
  <div class="panel-title"><h2>Rendered preview</h2></div>
  <iframe id="previewFrame" sandbox="allow-same-origin"></iframe>
</section>`;
}

function renderSetup() {
  return `
<section class="hero">
  <div>
    <div class="eyebrow">Security model</div>
    <h1>Local PIN and credentials files</h1>
    <p>The console lock is browser-side only. Publisher passwords are loaded from local JSON files at request time and are never copied into the server configuration.</p>
  </div>
</section>

<section class="panel prose">
  <h2>Credentials file format</h2>
  <p>Create or generate a local file such as <code>${escapeHtml(path.join(CREDENTIALS_DIR, "prod-fr.credentials.json"))}</code>.</p>
  <pre>{
  "username": "",
  "password": "your-admin-password",
  "token": "",
  "headers": {}
}</pre>
  <p>Only the file path is stored in <code>${escapeHtml(CONFIG_FILE)}</code>.</p>
  <p>Optional stylesheet path: <code>${escapeHtml(STYLE_FILE)}</code>. If it does not exist, the console runs without custom styling.</p>
  <a class="button" href="/credentials-template">Download template</a>
</section>`;
}

function renderNotice(type, message) {
  return `<div class="notice ${escapeAttr(type)}">${escapeHtml(message)}</div>`;
}

function renderEmptyState(title, body) {
  return `<div class="empty"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span></div>`;
}

function renderError(error) {
  return renderLayout({
    title: "Error",
    active: "error",
    content: `<section class="panel prose"><h1>Request failed</h1><p>${escapeHtml(error.message)}</p><a class="button" href="/">Back home</a></section>`,
    script: clientBootstrapScript()
  });
}

function tokenInput() {
  return `<input type="hidden" name="_token" value="${SESSION_TOKEN}">`;
}

function clientBootstrapScript() {
  return `
(function () {
  const pinKey = "localPublisherConsole.pinHash";
  const pinGate = document.getElementById("pinGate");
  const appShell = document.getElementById("appShell");
  const pinForm = document.getElementById("pinForm");
  const pinInput = document.getElementById("pinInput");
  const pinHint = document.getElementById("pinHint");

function hashPin(value) {
  let hash = 0;

  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }

  return String(hash);
}

  function unlock() {
    pinGate.hidden = true;
    appShell.hidden = false;
    renderPreview();
    syncCredentialMode();
  }

  function lock() {
    appShell.hidden = true;
    pinGate.hidden = false;
    pinInput.focus();
  }

  if (!localStorage.getItem(pinKey)) {
    pinHint.textContent = "Create a 4-digit PIN for this browser.";
  } else {
    pinHint.textContent = "Enter your 4-digit PIN.";
  }

  pinForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    const pin = pinInput.value.trim();

    if (!/^\\d{4}$/.test(pin)) {
      pinHint.textContent = "The PIN must contain exactly 4 digits.";
      return;
    }

    const hash = hashPin(pin);
    const current = localStorage.getItem(pinKey);

    if (!current) {
      localStorage.setItem(pinKey, hash);
      unlock();
      return;
    }

    if (hash === current) {
      unlock();
      return;
    }

    pinInput.value = "";
    pinHint.textContent = "Invalid PIN.";
  });

  lock();

  function syncCredentialMode() {
    const selected = document.querySelector('input[name="credentialsMode"]:checked');
    if (!selected) return;
    document.body.classList.toggle("use-existing-credentials", selected.value === "existing");
  }

  document.querySelectorAll('input[name="credentialsMode"]').forEach(function (radio) {
    radio.addEventListener("change", syncCredentialMode);
  });

  window.togglePreview = function () {
    const panel = document.getElementById("previewPanel");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderPreview();
  };

  function renderPreview() {
    const field = document.getElementById("htmlField");
    const frame = document.getElementById("previewFrame");
    if (!field || !frame) return;

    const doc = frame.contentDocument || frame.contentWindow.document;
    doc.open();
    doc.write("<!doctype html><html><head><meta charset='utf-8'><base target='_blank'><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.6;margin:28px;color:#111827}img{max-width:100%;height:auto}</style></head><body>" + field.value + "</body></html>");
    doc.close();
  }

  const htmlField = document.getElementById("htmlField");
  if (htmlField) {
    htmlField.addEventListener("input", function () {
      clearTimeout(window.__previewTimer);
      window.__previewTimer = setTimeout(renderPreview, 250);
    });
  }
})();`;
}

// ------------------------------------------------------------
// Utilities
// ------------------------------------------------------------

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

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}


// ------------------------------------------------------------
// Boot
// ------------------------------------------------------------

ensureStorage()
  .then(() => {
    app.listen(PORT, HOST, () => {
      const url = `http://127.0.0.1:${PORT}/`;
      console.log(`${APP_NAME} running on ${url}`);
      console.log(`Data directory: ${DATA_DIR}`);
      console.log(`Credentials directory: ${CREDENTIALS_DIR}`);
      console.log(`Style file: ${STYLE_FILE}`);
      console.log(`Style loaded: ${fs.existsSync(STYLE_FILE) ? "yes" : "no"}`);
      console.log(`Local server token: ${SESSION_TOKEN}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start local publisher console:", error);
    process.exit(1);
  });
