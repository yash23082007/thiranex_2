const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

const allowedTaskFields = new Set([
  "title",
  "description",
  "dueDate",
  "priority",
  "status"
]);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

let db = {
  users: [],
  sessions: [],
  tasks: []
};

let saveChain = Promise.resolve();
const sseClients = new Map();

function now() {
  return new Date().toISOString();
}

function createId() {
  return crypto.randomUUID();
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto
    .pbkdf2Sync(String(password), salt, 120000, 32, "sha256")
    .toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, originalHash] = String(storedHash || "").split(":");
  if (!salt || !originalHash) return false;
  const candidateHash = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(
    Buffer.from(candidateHash, "hex"),
    Buffer.from(originalHash, "hex")
  );
}

async function ensureDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await fs.readFile(DB_FILE, "utf8");
    db = JSON.parse(raw);
    db.users ||= [];
    db.sessions ||= [];
    db.tasks ||= [];
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    await saveDb();
  }
}

function saveDb() {
  saveChain = saveChain.then(() =>
    fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), "utf8")
  );
  return saveChain;
}

function pruneExpiredSessions() {
  const currentTime = Date.now();
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((session) => {
    return new Date(session.expiresAt).getTime() > currentTime;
  });
  if (db.sessions.length !== before) {
    saveDb().catch((error) => console.error("Failed to prune sessions", error));
  }
}

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const separator = cookie.indexOf("=");
        if (separator === -1) return [cookie, ""];
        return [
          decodeURIComponent(cookie.slice(0, separator)),
          decodeURIComponent(cookie.slice(separator + 1))
        ];
      })
  );
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(
    Date.now() + SESSION_MAX_AGE_SECONDS * 1000
  ).toISOString();

  db.sessions.push({
    token,
    userId,
    expiresAt,
    createdAt: now()
  });

  return { token, expiresAt };
}

function getAuthenticatedUser(req) {
  pruneExpiredSessions();
  const token = parseCookies(req).session;
  if (!token) return null;

  const session = db.sessions.find((item) => item.token === token);
  if (!session) return null;

  const user = db.users.find((item) => item.id === session.userId);
  return user || null;
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `session=${encodeURIComponent(
      token
    )}; Max-Age=${SESSION_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax"
  );
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

async function readJsonBody(req) {
  let body = "";

  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) {
      throw new Error("Request body is too large.");
    }
  }

  if (!body) return {};

  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function taskForClient(task) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    dueDate: task.dueDate,
    priority: task.priority,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function getUserTasks(userId) {
  return db.tasks
    .filter((task) => task.userId === userId)
    .sort((a, b) => {
      const statusOrder = { "in-progress": 0, todo: 1, done: 2 };
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return (
        statusOrder[a.status] - statusOrder[b.status] ||
        priorityOrder[a.priority] - priorityOrder[b.priority] ||
        String(a.dueDate || "9999-12-31").localeCompare(
          String(b.dueDate || "9999-12-31")
        ) ||
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    })
    .map(taskForClient);
}

function validateTaskPayload(payload, partial = false) {
  const result = {};

  if (!partial || Object.hasOwn(payload, "title")) {
    const title = String(payload.title || "").trim();
    if (!title) {
      throw Object.assign(new Error("Task title is required."), {
        statusCode: 400
      });
    }
    if (title.length > 120) {
      throw Object.assign(new Error("Task title must be 120 characters or less."), {
        statusCode: 400
      });
    }
    result.title = title;
  }

  if (!partial || Object.hasOwn(payload, "description")) {
    result.description = String(payload.description || "").trim().slice(0, 1000);
  }

  if (!partial || Object.hasOwn(payload, "dueDate")) {
    const dueDate = String(payload.dueDate || "").trim();
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      throw Object.assign(new Error("Due date must use YYYY-MM-DD format."), {
        statusCode: 400
      });
    }
    result.dueDate = dueDate;
  }

  if (!partial || Object.hasOwn(payload, "priority")) {
    const priority = String(payload.priority || "medium").toLowerCase();
    if (!["low", "medium", "high"].includes(priority)) {
      throw Object.assign(new Error("Priority must be low, medium, or high."), {
        statusCode: 400
      });
    }
    result.priority = priority;
  }

  if (!partial || Object.hasOwn(payload, "status")) {
    const status = String(payload.status || "todo").toLowerCase();
    if (!["todo", "in-progress", "done"].includes(status)) {
      throw Object.assign(
        new Error("Status must be todo, in-progress, or done."),
        {
          statusCode: 400
        }
      );
    }
    result.status = status;
  }

  return result;
}

function getSseClientSet(userId) {
  if (!sseClients.has(userId)) {
    sseClients.set(userId, new Set());
  }
  return sseClients.get(userId);
}

function writeSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastTasks(userId) {
  const clients = sseClients.get(userId);
  if (!clients || clients.size === 0) return;

  const payload = { tasks: getUserTasks(userId), updatedAt: now() };
  for (const client of clients) {
    writeSse(client, "tasks-changed", payload);
  }
}

async function handleAuthRoutes(req, res, pathname) {
  if (req.method === "POST" && pathname === "/api/auth/register") {
    const payload = await readJsonBody(req);
    const name = String(payload.name || "").trim();
    const email = normalizeEmail(payload.email);
    const password = String(payload.password || "");

    if (!name || !email || !password) {
      return sendError(res, 400, "Name, email, and password are required.");
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendError(res, 400, "Enter a valid email address.");
    }

    if (password.length < 8) {
      return sendError(res, 400, "Password must be at least 8 characters.");
    }

    if (db.users.some((user) => user.email === email)) {
      return sendError(res, 409, "An account with this email already exists.");
    }

    const user = {
      id: createId(),
      name,
      email,
      passwordHash: hashPassword(password),
      createdAt: now()
    };
    db.users.push(user);
    const session = createSession(user.id);
    await saveDb();

    setSessionCookie(res, session.token);
    return sendJson(res, 201, { user: publicUser(user) });
  }

  if (req.method === "POST" && pathname === "/api/auth/login") {
    const payload = await readJsonBody(req);
    const email = normalizeEmail(payload.email);
    const password = String(payload.password || "");
    const user = db.users.find((item) => item.email === email);

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return sendError(res, 401, "Invalid email or password.");
    }

    const session = createSession(user.id);
    await saveDb();
    setSessionCookie(res, session.token);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    const token = parseCookies(req).session;
    if (token) {
      db.sessions = db.sessions.filter((session) => session.token !== token);
      await saveDb();
    }
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && pathname === "/api/auth/me") {
    const user = getAuthenticatedUser(req);
    return sendJson(res, 200, { user: user ? publicUser(user) : null });
  }

  return false;
}

async function handleTaskRoutes(req, res, pathname) {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return sendError(res, 401, "Sign in to manage tasks.");
  }

  if (req.method === "GET" && pathname === "/api/tasks") {
    return sendJson(res, 200, { tasks: getUserTasks(user.id) });
  }

  if (req.method === "GET" && pathname === "/api/tasks/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    writeSse(res, "tasks-changed", {
      tasks: getUserTasks(user.id),
      updatedAt: now()
    });

    const clients = getSseClientSet(user.id);
    clients.add(res);
    req.on("close", () => {
      clients.delete(res);
      if (clients.size === 0) {
        sseClients.delete(user.id);
      }
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/tasks") {
    const payload = validateTaskPayload(await readJsonBody(req));
    const task = {
      id: createId(),
      userId: user.id,
      ...payload,
      createdAt: now(),
      updatedAt: now()
    };
    db.tasks.push(task);
    await saveDb();
    broadcastTasks(user.id);
    return sendJson(res, 201, { task: taskForClient(task) });
  }

  const taskIdMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (!taskIdMatch) {
    return false;
  }

  const task = db.tasks.find(
    (item) => item.id === taskIdMatch[1] && item.userId === user.id
  );
  if (!task) {
    return sendError(res, 404, "Task not found.");
  }

  if (req.method === "PATCH") {
    const rawPayload = await readJsonBody(req);
    const payload = Object.fromEntries(
      Object.entries(rawPayload).filter(([key]) => allowedTaskFields.has(key))
    );

    if (Object.keys(payload).length === 0) {
      return sendError(res, 400, "Provide at least one task field to update.");
    }

    Object.assign(task, validateTaskPayload(payload, true), {
      updatedAt: now()
    });
    await saveDb();
    broadcastTasks(user.id);
    return sendJson(res, 200, { task: taskForClient(task) });
  }

  if (req.method === "DELETE") {
    db.tasks = db.tasks.filter((item) => item.id !== task.id);
    await saveDb();
    broadcastTasks(user.id);
    return sendJson(res, 200, { ok: true });
  }

  return false;
}

async function serveStatic(req, res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const normalizedPath = path.normalize(decodeURIComponent(requestedPath));
  const filePath = path.join(PUBLIC_DIR, normalizedPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendError(res, 403, "Forbidden.");
  }

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream"
    });
    res.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      const index = await fs.readFile(path.join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": mimeTypes[".html"] });
      res.end(index);
      return;
    }
    throw error;
  }
}

async function requestHandler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname.startsWith("/api/auth/")) {
      const handled = await handleAuthRoutes(req, res, pathname);
      if (handled === false) {
        return sendError(res, 404, "Auth route not found.");
      }
      return;
    }

    if (pathname.startsWith("/api/tasks")) {
      const handled = await handleTaskRoutes(req, res, pathname);
      if (handled === false) {
        return sendError(res, 404, "Task route not found.");
      }
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (error) {
    console.error(error);
    sendError(res, error.statusCode || 500, error.message || "Server error.");
  }
}

ensureDb()
  .then(() => {
    http.createServer(requestHandler).listen(PORT, () => {
      console.log(`Task manager running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start server", error);
    process.exit(1);
  });
