const state = {
  user: null,
  tasks: [],
  filter: "all",
  search: "",
  authMode: "login",
  editingTaskId: null,
  stream: null
};

const els = {
  authView: document.querySelector("#authView"),
  workspaceView: document.querySelector("#workspaceView"),
  authForm: document.querySelector("#authForm"),
  authSubmit: document.querySelector("#authSubmit"),
  authError: document.querySelector("#authError"),
  authModeButtons: document.querySelectorAll("[data-auth-mode]"),
  registerOnlyFields: document.querySelectorAll(".register-only"),
  nameInput: document.querySelector("#nameInput"),
  emailInput: document.querySelector("#emailInput"),
  passwordInput: document.querySelector("#passwordInput"),
  userLabel: document.querySelector("#userLabel"),
  logoutButton: document.querySelector("#logoutButton"),
  taskForm: document.querySelector("#taskForm"),
  taskSubmit: document.querySelector("#taskSubmit"),
  taskError: document.querySelector("#taskError"),
  taskTitle: document.querySelector("#taskTitle"),
  taskDescription: document.querySelector("#taskDescription"),
  taskDueDate: document.querySelector("#taskDueDate"),
  taskPriority: document.querySelector("#taskPriority"),
  taskStatus: document.querySelector("#taskStatus"),
  editorTitle: document.querySelector("#editorTitle"),
  cancelEditButton: document.querySelector("#cancelEditButton"),
  summaryStrip: document.querySelector("#summaryStrip"),
  filterButtons: document.querySelectorAll("[data-filter]"),
  taskSearch: document.querySelector("#taskSearch"),
  taskList: document.querySelector("#taskList")
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

function setAuthMode(mode) {
  state.authMode = mode;
  const isRegister = mode === "register";

  els.authModeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.authMode === mode);
  });

  els.registerOnlyFields.forEach((field) => {
    field.classList.toggle("is-hidden", !isRegister);
  });

  els.nameInput.required = isRegister;
  els.passwordInput.autocomplete = isRegister ? "new-password" : "current-password";
  els.authSubmit.textContent = isRegister ? "Create account" : "Sign in";
  els.authError.textContent = "";
}

function setSession(user) {
  state.user = user;
  els.authView.classList.toggle("is-hidden", Boolean(user));
  els.workspaceView.classList.toggle("is-hidden", !user);

  if (user) {
    els.userLabel.textContent = `${user.name} · ${user.email}`;
    loadTasks();
    connectTaskStream();
  } else {
    els.userLabel.textContent = "";
    state.tasks = [];
    closeTaskStream();
    renderTasks();
  }
}

async function loadCurrentUser() {
  const { user } = await api("/api/auth/me");
  setSession(user);
}

async function loadTasks() {
  const { tasks } = await api("/api/tasks");
  state.tasks = tasks;
  renderTasks();
}

function connectTaskStream() {
  closeTaskStream();
  state.stream = new EventSource("/api/tasks/stream");
  state.stream.addEventListener("tasks-changed", (event) => {
    const payload = JSON.parse(event.data);
    state.tasks = payload.tasks;
    renderTasks();
  });
  state.stream.onerror = () => {
    closeTaskStream();
    setTimeout(() => {
      if (state.user) connectTaskStream();
    }, 1800);
  };
}

function closeTaskStream() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
}

function getTaskCounts() {
  return state.tasks.reduce(
    (counts, task) => {
      counts.all += 1;
      counts[task.status] += 1;
      return counts;
    },
    { all: 0, todo: 0, "in-progress": 0, done: 0 }
  );
}

function humanizeStatus(status) {
  return {
    todo: "To do",
    "in-progress": "In progress",
    done: "Done"
  }[status];
}

function humanizePriority(priority) {
  return priority[0].toUpperCase() + priority.slice(1);
}

function formatDate(date) {
  if (!date) return "No due date";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(`${date}T00:00:00`));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getFilteredTasks() {
  const search = state.search.trim().toLowerCase();
  return state.tasks.filter((task) => {
    const matchesFilter = state.filter === "all" || task.status === state.filter;
    const matchesSearch =
      !search ||
      task.title.toLowerCase().includes(search) ||
      task.description.toLowerCase().includes(search);
    return matchesFilter && matchesSearch;
  });
}

function renderSummary() {
  const counts = getTaskCounts();
  const items = [
    ["All", counts.all],
    ["To do", counts.todo],
    ["In progress", counts["in-progress"]],
    ["Done", counts.done]
  ];

  els.summaryStrip.innerHTML = items
    .map(
      ([label, count]) => `
        <div class="summary-item">
          <strong>${count}</strong>
          <span>${label}</span>
        </div>
      `
    )
    .join("");
}

function renderTasks() {
  renderSummary();

  const tasks = getFilteredTasks();
  if (tasks.length === 0) {
    els.taskList.innerHTML = `
      <div class="empty-state">
        ${
          state.tasks.length === 0
            ? "Create your first task to get moving."
            : "No tasks match the current view."
        }
      </div>
    `;
    return;
  }

  els.taskList.innerHTML = tasks
    .map(
      (task) => `
        <article class="task-card" data-task-id="${task.id}">
          <div class="task-card-header">
            <div>
              <h3 class="task-title">${escapeHtml(task.title)}</h3>
              <p class="task-description">${
                task.description
                  ? escapeHtml(task.description)
                  : '<span class="muted">No description</span>'
              }</p>
            </div>
            <span class="badge badge-priority-${task.priority}">
              ${humanizePriority(task.priority)}
            </span>
          </div>

          <div class="task-meta">
            <span class="badge badge-status-${task.status}">
              ${humanizeStatus(task.status)}
            </span>
            <span class="muted">${formatDate(task.dueDate)}</span>
          </div>

          <div class="task-actions">
            <button class="ghost-button" type="button" data-action="edit">Edit</button>
            <button class="ghost-button" type="button" data-action="next-status">
              ${task.status === "done" ? "Reopen" : "Advance"}
            </button>
            <button class="danger-button" type="button" data-action="delete">
              Delete
            </button>
          </div>
        </article>
      `
    )
    .join("");
}

function resetTaskForm() {
  state.editingTaskId = null;
  els.editorTitle.textContent = "New task";
  els.taskSubmit.textContent = "Create task";
  els.cancelEditButton.classList.add("is-hidden");
  els.taskError.textContent = "";
  els.taskForm.reset();
  els.taskPriority.value = "medium";
  els.taskStatus.value = "todo";
}

function populateTaskForm(task) {
  state.editingTaskId = task.id;
  els.editorTitle.textContent = "Edit task";
  els.taskSubmit.textContent = "Save changes";
  els.cancelEditButton.classList.remove("is-hidden");
  els.taskTitle.value = task.title;
  els.taskDescription.value = task.description;
  els.taskDueDate.value = task.dueDate;
  els.taskPriority.value = task.priority;
  els.taskStatus.value = task.status;
  els.taskTitle.focus();
}

function getTaskFormPayload() {
  const formData = new FormData(els.taskForm);
  return {
    title: formData.get("title"),
    description: formData.get("description"),
    dueDate: formData.get("dueDate"),
    priority: formData.get("priority"),
    status: formData.get("status")
  };
}

function nextStatus(status) {
  if (status === "todo") return "in-progress";
  if (status === "in-progress") return "done";
  return "todo";
}

els.authModeButtons.forEach((button) => {
  button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
});

els.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.authError.textContent = "";
  els.authSubmit.disabled = true;

  const formData = new FormData(els.authForm);
  const path =
    state.authMode === "register" ? "/api/auth/register" : "/api/auth/login";
  const payload = {
    email: formData.get("email"),
    password: formData.get("password")
  };

  if (state.authMode === "register") {
    payload.name = formData.get("name");
  }

  try {
    const { user } = await api(path, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    els.authForm.reset();
    setSession(user);
  } catch (error) {
    els.authError.textContent = error.message;
  } finally {
    els.authSubmit.disabled = false;
  }
});

els.logoutButton.addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  setSession(null);
});

els.taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.taskError.textContent = "";
  els.taskSubmit.disabled = true;

  try {
    const editingTaskId = state.editingTaskId;
    await api(editingTaskId ? `/api/tasks/${editingTaskId}` : "/api/tasks", {
      method: editingTaskId ? "PATCH" : "POST",
      body: JSON.stringify(getTaskFormPayload())
    });
    resetTaskForm();
    await loadTasks();
  } catch (error) {
    els.taskError.textContent = error.message;
  } finally {
    els.taskSubmit.disabled = false;
  }
});

els.cancelEditButton.addEventListener("click", resetTaskForm);

els.filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    els.filterButtons.forEach((item) => {
      item.classList.toggle("is-active", item === button);
    });
    renderTasks();
  });
});

els.taskSearch.addEventListener("input", (event) => {
  state.search = event.target.value;
  renderTasks();
});

els.taskList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  const card = event.target.closest("[data-task-id]");
  if (!button || !card) return;

  const task = state.tasks.find((item) => item.id === card.dataset.taskId);
  if (!task) return;

  if (button.dataset.action === "edit") {
    populateTaskForm(task);
    return;
  }

  button.disabled = true;

  try {
    if (button.dataset.action === "delete") {
      await api(`/api/tasks/${task.id}`, { method: "DELETE" });
      if (state.editingTaskId === task.id) resetTaskForm();
      await loadTasks();
      return;
    }

    if (button.dataset.action === "next-status") {
      await api(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus(task.status) })
      });
      await loadTasks();
    }
  } catch (error) {
    els.taskError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

setAuthMode("login");
loadCurrentUser().catch((error) => {
  console.error(error);
  setSession(null);
});
