
"use strict";

const $ = id => document.getElementById(id);

const STORAGE = {
  chats: "pinsk_chats",
  projects: "pinsk_projects",
  library: "pinsk_library",
  name: "pinsk_name",
  reasoning: "pinsk_reasoning",
  language: "pinsk_language"
};

let chats = JSON.parse(localStorage.getItem(STORAGE.chats) || "[]");
let projects = JSON.parse(localStorage.getItem(STORAGE.projects) || "[]");
let library = JSON.parse(localStorage.getItem(STORAGE.library) || "[]");

let currentUser = null;
let currentChatId = null;
let currentPage = "chat";
let usageData = null;
let isSending = false;
let recognition = null;
let isRecording = false;

const language = localStorage.getItem(STORAGE.language) || "ru";

function saveLocal() {
  localStorage.setItem(STORAGE.chats, JSON.stringify(chats));
  localStorage.setItem(STORAGE.projects, JSON.stringify(projects));
  localStorage.setItem(STORAGE.library, JSON.stringify(library));
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function toast(message) {
  const element = $("toast");
  if (!element) {
    alert(message);
    return;
  }

  element.textContent = message;
  element.classList.add("show");

  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.classList.remove("show");
  }, 3000);
}

async function api(url, options = {}) {
  const response = await window.fetch.call(window, url, {
    credentials: "include",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401 && currentUser) {
      currentUser = null;
      showAuth();
    }

    throw new Error(data.error || "Ошибка сервера.");
  }

  return data;
}

// -----------------------------
// АВТОРИЗАЦИЯ
// -----------------------------

function showModal(content) {
  const backdrop = $("modalBackdrop");
  const modal = $("modal");
  const modalContent = $("modalContent");

  if (!backdrop || !modalContent) return;

  modalContent.innerHTML = content;
  backdrop.classList.add("active");
  if (modal) modal.classList.add("active");
}

function closeModal() {
  $("modalBackdrop")?.classList.remove("active");
  $("modal")?.classList.remove("active");
}

function showAuth(mode = "login") {
  const isRegister = mode === "register";

  showModal(`
    <div class="auth-box">
      <h2>${isRegister ? "Создать аккаунт Pinsk" : "Вход в Pinsk"}</h2>
      <p>${isRegister ? "Зарегистрируйся, чтобы начать работу." : "Войди в свой аккаунт."}</p>

      ${isRegister ? `
        <label>Имя</label>
        <input id="authName" placeholder="Твоё имя" maxlength="50">
      ` : ""}

      <label>Email</label>
      <input id="authEmail" type="email" placeholder="example@mail.com">

      <label>Пароль</label>
      <input id="authPassword" type="password" placeholder="Не менее 8 символов">

      <button class="primary-button" id="authSubmit">
        ${isRegister ? "Зарегистрироваться" : "Войти"}
      </button>

      <p id="authError" class="error-text"></p>

      <p class="auth-switch">
        ${isRegister ? "Уже есть аккаунт?" : "Нет аккаунта?"}
        <a href="#" id="authSwitch">
          ${isRegister ? "Войти" : "Зарегистрироваться"}
        </a>
      </p>
    </div>
  `);

  $("authSwitch")?.addEventListener("click", event => {
    event.preventDefault();
    showAuth(isRegister ? "login" : "register");
  });

  $("authSubmit")?.addEventListener("click", async () => {
    const name = $("authName")?.value.trim();
    const email = $("authEmail")?.value.trim();
    const password = $("authPassword")?.value;

    const errorElement = $("authError");
    const button = $("authSubmit");

    if (!email || !password || (isRegister && !name)) {
      if (errorElement) errorElement.textContent = "Заполни все поля.";
      return;
    }

    button.disabled = true;
    button.textContent = "Подождите...";

    try {
      const data = await api(
        isRegister ? "/api/auth/register" : "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ name, email, password })
        }
      );

      currentUser = data.user;
      closeModal();
      updateProfile();
      await loadUsage();
      await loadHistory();
      toast("Ты успешно вошёл в Pinsk!");

      if (currentUser.role === "OWNER") {
        addAdminNavigation();
      }

      renderPageContent(currentPage);
    } catch (error) {
      if (errorElement) errorElement.textContent = error.message;
      button.disabled = false;
      button.textContent = isRegister ? "Зарегистрироваться" : "Войти";
    }
  });
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (error) {
    console.error(error);
  }

  currentUser = null;
  usageData = null;
  currentChatId = null;

  updateProfile();
  showAuth("login");
}

async function checkAuth() {
  try {
    const data = await api("/api/auth/me");
    currentUser = data.user;
    updateProfile();
    return true;
  } catch {
    currentUser = null;
    updateProfile();
    return false;
  }
}

function updateProfile() {
  const name = currentUser?.name || "Гость";
  const role = currentUser?.role || "FREE";

  if ($("profileName")) $("profileName").textContent = name;
  if ($("avatar")) $("avatar").textContent = name.charAt(0).toUpperCase();

  if ($("profileButton")) {
    $("profileButton").title = currentUser
      ? `${name} · ${role}`
      : "Войти";
  }

  if (currentUser?.role === "OWNER") {
    addAdminNavigation();
  } else {
    removeAdminNavigation();
  }
}

// -----------------------------
// ИСПОЛЬЗОВАНИЕ И ТАРИФ
// -----------------------------

async function loadUsage() {
  if (!currentUser) return;

  try {
    usageData = await api("/api/usage");
    renderUsage();
  } catch (error) {
    console.error(error);
  }
}

function renderUsage() {
  if (!usageData) return;

  const used = usageData.used || {};
  const limits = usageData.limits || {};

  const usageElement = $("usageInfo");
  if (usageElement) {
    usageElement.innerHTML = `
      <div>Сообщения: ${used.messages || 0} / ${limits.messages}</div>
      <div>Изображения: ${used.images || 0} / ${limits.images}</div>
      <div>Файлы: ${used.files || 0} / ${limits.files}</div>
    `;
  }
}

function showProfile() {
  if (!currentUser) {
    showAuth();
    return;
  }

  showModal(`
    <div class="profile-modal">
      <h2>Мой аккаунт</h2>
      <div class="profile-avatar">
        ${escapeHTML(currentUser.name.charAt(0).toUpperCase())}
      </div>
      <h3>${escapeHTML(currentUser.name)}</h3>
      <p>${escapeHTML(currentUser.email)}</p>
      <p>Тариф: <strong>${escapeHTML(currentUser.role)}</strong></p>
      <p>Статус: активен</p>

      <button class="secondary-button" id="profilePlans">Тарифы Pinsk</button>
      <button class="secondary-button" id="profileLogout">Выйти из аккаунта</button>
    </div>
  `);

  $("profilePlans")?.addEventListener("click", () => {
    closeModal();
    renderPage("plans");
  });

  $("profileLogout")?.addEventListener("click", logout);
}

function showPlans() {
  showModal(`
    <div class="plans-modal">
      <h2>Тарифы Pinsk</h2>
      <p>Выбери подходящий тариф.</p>

      <div class="plan-card">
        <h3>FREE</h3>
        <h2>Бесплатно</h2>
        <p>100 сообщений в день</p>
        <p>5 генераций изображений в день</p>
        <p>5 файлов в день</p>
      </div>

      <div class="plan-card">
        <h3>Pinsk PRO — месяц</h3>
        <h2>2 990 ₸ / месяц</h2>
        <p>Безлимитные сообщения</p>
        <p>10 изображений в день</p>
        <p>10 файлов в день</p>
      </div>

      <div class="plan-card">
        <h3>Pinsk PRO — год</h3>
        <h2>30 498 ₸ / год</h2>
        <p>Скидка 15%</p>
        <p>Безлимитные сообщения, изображения и файлы</p>
      </div>

      <p class="muted-text">
        Оплата пока не подключена. Покупка тарифа сейчас недоступна.
      </p>
    </div>
  `);
}

// -----------------------------
// ЧАТЫ
// -----------------------------

function newChat() {
  currentChatId = null;

  if ($("messages")) $("messages").innerHTML = "";
  if ($("welcome")) $("welcome").style.display = "";
  if ($("prompt")) $("prompt").value = "";

  renderPage("chat");
  $("prompt")?.focus();
}

function renderMessage(role, content) {
  const messages = $("messages");
  if (!messages) return;

  const item = document.createElement("div");
  item.className = `message ${role === "user" ? "user-message" : "assistant-message"}`;

  const label = role === "user" ? "Вы" : "Pinsk";

  const body = document.createElement("div");
  body.className = "message-content";
  body.textContent = content;

  const title = document.createElement("div");
  title.className = "message-author";
  title.textContent = label;

  item.appendChild(title);
  item.appendChild(body);
  messages.appendChild(item);

  messages.scrollTop = messages.scrollHeight;
}

async function loadHistory() {
  if (!currentUser) return;

  try {
    const history = await api("/api/history");
    chats = history;
    saveLocal();
    renderHistory();
  } catch (error) {
    console.error(error);
  }
}

function renderHistory() {
  const container = $("history");
  if (!container) return;

  container.innerHTML = "";

  chats.forEach(chat => {
    const item = document.createElement("button");
    item.className = "history-item";
    item.textContent = chat.title || "Новый чат";

    item.addEventListener("click", () => openChat(chat.id));
    container.appendChild(item);
  });
}

async function openChat(id) {
  if (!currentUser) return showAuth();

  try {
    const messages = await api(`/api/history/${encodeURIComponent(id)}`);

    currentChatId = id;

    if ($("welcome")) $("welcome").style.display = "none";
    if ($("messages")) $("messages").innerHTML = "";

    messages.forEach(message => {
      renderMessage(message.role, message.content);
    });

    renderPage("chat");
  } catch (error) {
    toast(error.message);
  }
}

async function sendMessage(text) {
  if (!currentUser) {
    showAuth();
    return;
  }

  if (isSending) return;

  const message = String(text || "").trim();
  if (!message) return;

  isSending = true;

  if ($("sendButton")) $("sendButton").disabled = true;
  if ($("welcome")) $("welcome").style.display = "none";

  renderMessage("user", message);

  if ($("prompt")) $("prompt").value = "";

  const loading = document.createElement("div");
  loading.className = "message assistant-message loading-message";
  loading.textContent = "Pinsk думает...";
  $("messages")?.appendChild(loading);

  try {
    const data = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message,
        conversationId: currentChatId || crypto.randomUUID()
      })
    });

    currentChatId = data.conversationId;
    loading.remove();

    renderMessage("assistant", data.answer || "Нет ответа.");

    await loadUsage();
    await loadHistory();

  } catch (error) {
    loading.remove();
    renderMessage("assistant", "Ошибка: " + error.message);
    toast(error.message);
  } finally {
    isSending = false;
    if ($("sendButton")) $("sendButton").disabled = false;
    $("prompt")?.focus();
  }
}

// -----------------------------
// СТРАНИЦЫ
// -----------------------------

function renderPage(page) {
  currentPage = page;

  document.querySelectorAll("[data-page]").forEach(button => {
    button.classList.toggle("active", button.dataset.page === page);
  });

  const titles = {
    chat: "Pinsk",
    overview: "Обзор",
    projects: "Проекты",
    library: "Библиотека",
    plugins: "Приложения",
    analysis: "Анализ данных",
    voice: "Голосовой режим",
    plans: "Тарифы",
    admin: "Админ-панель"
  };

  if ($("pageTitle")) {
    $("pageTitle").textContent = titles[page] || "Pinsk";
  }

  renderPageContent(page);
}

function renderPageContent(page) {
  const workspace = $("workspace");
  if (!workspace) return;

  if (page === "chat") {
    const welcome = $("welcome");
    const messages = $("messages");
    const composer = $("composerArea");

    if (welcome) welcome.style.display = currentChatId ? "none" : "";
    if (messages) messages.style.display = "";
    if (composer) composer.style.display = "";

    return;
  }

  if ($("welcome")) $("welcome").style.display = "none";
  if ($("messages")) $("messages").style.display = "none";
  if ($("composerArea")) $("composerArea").style.display = "none";

  if (page === "overview") {
    workspace.innerHTML = `
      <div class="page-content">
        <h2>Обзор Pinsk</h2>
        <p>Твой персональный ИИ-помощник.</p>
        <div class="dashboard-grid">
          <div class="dashboard-card">
            <h3>Аккаунт</h3>
            <p>${escapeHTML(currentUser?.name || "Гость")}</p>
            <p>Тариф: ${escapeHTML(currentUser?.role || "FREE")}</p>
          </div>
          <div class="dashboard-card">
            <h3>Использование</h3>
            <div id="usageInfo">Загрузка...</div>
          </div>
          <div class="dashboard-card">
            <h3>Проекты</h3>
            <p>${projects.length} проектов</p>
          </div>
          <div class="dashboard-card">
            <h3>Библиотека</h3>
            <p>${library.length} материалов</p>
          </div>
        </div>
      </div>
    `;
    renderUsage();
    return;
  }

  if (page === "projects") {
    workspace.innerHTML = `
      <div class="page-content">
        <h2>Мои проекты</h2>
        <p>Сохраняй и организовывай свои задачи.</p>
        <button class="primary-button" id="addProject">+ Новый проект</button>
        <div id="projectsList"></div>
      </div>
    `;
    renderProjects();
    $("addProject")?.addEventListener("click", createProject);
    return;
  }

  if (page === "library") {
    workspace.innerHTML = `
      <div class="page-content">
        <h2>Библиотека</h2>
        <p>Твои сохранённые материалы.</p>
        <button class="primary-button" id="addLibraryItem">+ Добавить материал</button>
        <div id="libraryList"></div>
      </div>
    `;
    renderLibrary();
    $("addLibraryItem")?.addEventListener("click", addLibraryItem);
    return;
  }

  if (page === "plugins") {
    workspace.innerHTML = `
      <div class="page-content">
        <h2>Приложения Pinsk</h2>
        <p>Дополнительные возможности помощника.</p>
        <div class="dashboard-card">
          <h3>Подключаемые приложения</h3>
          <p>Раздел находится в разработке.</p>
        </div>
      </div>
    `;
    return;
  }

  if (page === "analysis") {
    workspace.innerHTML = `
      <div class="page-content">
        <h2>Анализ данных</h2>
        <p>Здесь будут инструменты для работы с таблицами и данными.</p>
        <div class="dashboard-card">
          <h3>Инструменты анализа</h3>
          <p>Раздел находится в разработке.</p>
        </div>
      </div>
    `;
    return;
  }

  if (page === "voice") {
    workspace.innerHTML = `
      <div class="page-content voice-page">
        <h2>Голосовой режим</h2>
        <p>Говори с Pinsk голосом.</p>
        <button class="primary-button" id="voiceStart">🎙 Начать разговор</button>
        <button class="secondary-button" id="voiceStop">Остановить</button>
        <p id="voiceStatus">Голосовой режим готов.</p>
      </div>
    `;

    $("voiceStart")?.addEventListener("click", startVoice);
    $("voiceStop")?.addEventListener("click", stopVoice);
    return;
  }

  if (page === "plans") {
    workspace.innerHTML = `
      <div class="page-content">
        <h2>Тарифы Pinsk</h2>
        <div class="dashboard-card">
          <h3>FREE</h3>
          <p>100 сообщений в день, 5 изображений и 5 файлов.</p>
        </div>
        <div class="dashboard-card">
          <h3>Pinsk PRO — 2 990 ₸ / месяц</h3>
          <p>Безлимитные сообщения, 10 изображений и 10 файлов в день.</p>
        </div>
        <div class="dashboard-card">
          <h3>Pinsk PRO — 30 498 ₸ / год</h3>
          <p>Скидка 15%. Безлимитные сообщения, изображения и файлы.</p>
        </div>
        <p>Оплата пока не подключена.</p>
      </div>
    `;
    return;
  }

  if (page === "admin") {
    renderAdmin();
  }
}

// -----------------------------
// ПРОЕКТЫ
// -----------------------------

function renderProjects() {
  const container = $("projectsList");
  if (!container) return;

  if (!projects.length) {
    container.innerHTML = "<p>Пока нет проектов.</p>";
    return;
  }

  container.innerHTML = projects.map(project => `
    <div class="dashboard-card">
      <h3>${escapeHTML(project.name)}</h3>
      <p>${escapeHTML(project.description || "")}</p>
      <button class="secondary-button" data-delete-project="${escapeHTML(project.id)}">
        Удалить
      </button>
    </div>
  `).join("");

  container.querySelectorAll("[data-delete-project]").forEach(button => {
    button.addEventListener("click", () => {
      projects = projects.filter(item => item.id !== button.dataset.deleteProject);
      saveLocal();
      renderProjects();
    });
  });
}

function createProject() {
  showModal(`
    <h2>Новый проект</h2>
    <input id="projectName" placeholder="Название проекта">
    <textarea id="projectDescription" placeholder="Описание проекта"></textarea>
    <button class="primary-button" id="saveProject">Создать</button>
  `);

  $("saveProject")?.addEventListener("click", () => {
    const name = $("projectName").value.trim();
    const description = $("projectDescription").value.trim();

    if (!name) return toast("Введи название проекта.");

    projects.push({
      id: crypto.randomUUID(),
      name,
      description,
      createdAt: new Date().toISOString()
    });

    saveLocal();
    closeModal();
    renderProjects();
    toast("Проект создан.");
  });
}

// -----------------------------
// БИБЛИОТЕКА
// -----------------------------

function renderLibrary() {
  const container = $("libraryList");
  if (!container) return;

  if (!library.length) {
    container.innerHTML = "<p>Библиотека пока пуста.</p>";
    return;
  }

  container.innerHTML = library.map(item => `
    <div class="dashboard-card">
      <h3>${escapeHTML(item.title)}</h3>
      <p>${escapeHTML(item.content)}</p>
      <button class="secondary-button" data-delete-library="${escapeHTML(item.id)}">
        Удалить
      </button>
    </div>
  `).join("");

  container.querySelectorAll("[data-delete-library]").forEach(button => {
    button.addEventListener("click", () => {
      library = library.filter(item => item.id !== button.dataset.deleteLibrary);
      saveLocal();
      renderLibrary();
    });
  });
}

function addLibraryItem() {
  showModal(`
    <h2>Добавить материал</h2>
    <input id="libraryTitle" placeholder="Название">
    <textarea id="libraryContent" placeholder="Текст материала"></textarea>
    <button class="primary-button" id="saveLibrary">Сохранить</button>
  `);

  $("saveLibrary")?.addEventListener("click", () => {
    const title = $("libraryTitle").value.trim();
    const content = $("libraryContent").value.trim();

    if (!title || !content) return toast("Заполни оба поля.");

    library.push({
      id: crypto.randomUUID(),
      title,
      content
    });

    saveLocal();
    closeModal();
    renderLibrary();
    toast("Материал сохранён.");
  });
}

// -----------------------------
// АДМИН-ПАНЕЛЬ
// -----------------------------

function addAdminNavigation() {
  if (document.querySelector('[data-page="admin"]')) return;

  const nav = document.querySelector(".sidebar-nav") ||
    document.querySelector("#sidebar nav") ||
    $("sidebar");

  if (!nav) return;

  const button = document.createElement("button");
  button.dataset.page = "admin";
  button.className = "nav-item";
  button.innerHTML = "⚙ Админ-панель";
  button.addEventListener("click", () => renderPage("admin"));

  nav.appendChild(button);
}

function removeAdminNavigation() {
  document.querySelector('[data-page="admin"]')?.remove();
}

async function renderAdmin() {
  const workspace = $("workspace");
  if (!workspace) return;

  if (!currentUser || currentUser.role !== "OWNER") {
    workspace.innerHTML = "<h2>Доступ запрещён.</h2>";
    return;
  }

  workspace.innerHTML = `
    <div class="page-content admin-page">
      <h2>Админ-панель Pinsk</h2>
      <p>Управление пользователями и аккаунтами.</p>

      <div class="dashboard-grid" id="adminStats">
        <div class="dashboard-card">Загрузка статистики...</div>
      </div>

      <div class="admin-users">
        <h3>Пользователи</h3>
        <input id="adminSearch" placeholder="Поиск по имени или email">
        <button class="secondary-button" id="adminRefresh">Обновить</button>
        <div id="adminUsersList">Загрузка пользователей...</div>
      </div>
    </div>
  `;

  $("adminSearch")?.addEventListener("input", () => {
    clearTimeout(renderAdmin.searchTimer);
    renderAdmin.searchTimer = setTimeout(loadAdminUsers, 300);
  });

  $("adminRefresh")?.addEventListener("click", async () => {
    await loadAdminStats();
    await loadAdminUsers();
  });

  await loadAdminStats();
  await loadAdminUsers();
}

async function loadAdminStats() {
  try {
    const stats = await api("/api/admin/stats");
    const container = $("adminStats");
    if (!container) return;

    container.innerHTML = `
      <div class="dashboard-card">
        <h3>Всего пользователей</h3>
        <h2>${stats.total || 0}</h2>
      </div>
      <div class="dashboard-card">
        <h3>FREE</h3>
        <h2>${stats.free || 0}</h2>
      </div>
      <div class="dashboard-card">
        <h3>PRO</h3>
        <h2>${stats.pro || 0}</h2>
      </div>
      <div class="dashboard-card">
        <h3>Заблокировано</h3>
        <h2>${stats.blocked || 0}</h2>
      </div>
    `;
  } catch (error) {
    toast(error.message);
  }
}

async function loadAdminUsers() {
  const container = $("adminUsersList");
  if (!container) return;

  try {
    const search = $("adminSearch")?.value || "";
    const users = await api(
      "/api/admin/users?search=" + encodeURIComponent(search)
    );

    if (!users.length) {
      container.innerHTML = "<p>Пользователи не найдены.</p>";
      return;
    }

    container.innerHTML = users.map(user => {
      const isOwner = user.role === "OWNER";
      const isSelf = user.id === currentUser.id;
      const protectedUser = isOwner || isSelf;

      return `
        <div class="dashboard-card admin-user">
          <h3>${escapeHTML(user.name)}</h3>
          <p>${escapeHTML(user.email)}</p>
          <p>Тариф: <strong>${escapeHTML(user.role)}</strong></p>
          <p>Статус: ${user.is_blocked ? "Заблокирован" : "Активен"}</p>
          <p>Регистрация: ${escapeHTML(user.created_at || "")}</p>

          ${protectedUser ? `
            <p class="muted-text">Защищённый аккаунт</p>
          ` : `
            <label>Изменить тариф</label>
            <select data-role-user="${escapeHTML(user.id)}">
              <option value="FREE" ${user.role === "FREE" ? "selected" : ""}>FREE</option>
              <option value="PRO" ${user.role === "PRO" ? "selected" : ""}>PRO</option>
            </select>

            <button class="secondary-button"
              data-save-role="${escapeHTML(user.id)}">
              Сохранить тариф
            </button>

            <button class="secondary-button"
              data-block-user="${escapeHTML(user.id)}"
              data-blocked="${user.is_blocked ? "true" : "false"}">
              ${user.is_blocked ? "Разблокировать" : "Заблокировать"}
            </button>
          `}
        </div>
      `;
    }).join("");

    container.querySelectorAll("[data-save-role]").forEach(button => {
      button.addEventListener("click", async () => {
        const id = button.dataset.saveRole;
        const select = container.querySelector(`[data-role-user="${id}"]`);

        try {
          await api(`/api/admin/users/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify({ role: select.value })
          });

          toast("Тариф пользователя обновлён.");
          await loadAdminStats();
          await loadAdminUsers();
        } catch (error) {
          toast(error.message);
        }
      });
    });

    container.querySelectorAll("[data-block-user]").forEach(button => {
      button.addEventListener("click", async () => {
        const id = button.dataset.blockUser;
        const currentlyBlocked = button.dataset.blocked === "true";

        const confirmed = confirm(
          currentlyBlocked
            ? "Разблокировать этого пользователя?"
            : "Заблокировать этого пользователя?"
        );

        if (!confirmed) return;

        try {
          await api(`/api/admin/users/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify({ is_blocked: !currentlyBlocked })
          });

          toast(currentlyBlocked ? "Пользователь разблокирован." : "Пользователь заблокирован.");
          await loadAdminStats();
          await loadAdminUsers();
        } catch (error) {
          toast(error.message);
        }
      });
    });

  } catch (error) {
    container.innerHTML = `<p>Ошибка: ${escapeHTML(error.message)}</p>`;
  }
}

// -----------------------------
// ГОЛОСОВОЙ РЕЖИМ
// -----------------------------

function startVoice() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    toast("Браузер не поддерживает распознавание речи.");
    return;
  }

  if (isRecording) return;

  recognition = new SpeechRecognition();
  recognition.lang = language === "en" ? "en-US" : "ru-RU";
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onstart = () => {
    isRecording = true;
    if ($("voiceStatus")) $("voiceStatus").textContent = "Слушаю...";
  };

  recognition.onresult = event => {
    const text = event.results[0][0].transcript;
    if ($("voiceStatus")) $("voiceStatus").textContent = "Вы сказали: " + text;
    sendMessage(text);
  };

  recognition.onerror = () => {
    if ($("voiceStatus")) $("voiceStatus").textContent = "Не удалось распознать речь.";
  };

  recognition.onend = () => {
    isRecording = false;
  };

  recognition.start();
}

function stopVoice() {
  if (recognition) recognition.stop();
  isRecording = false;
  window.speechSynthesis?.cancel();

  if ($("voiceStatus")) $("voiceStatus").textContent = "Голосовой режим остановлен.";
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = language === "en" ? "en-US" : "ru-RU";
  window.speechSynthesis.speak(utterance);
}

// -----------------------------
// НАСТРОЙКИ И СОБЫТИЯ
// -----------------------------

function showSettings() {
  showModal(`
    <h2>Настройки Pinsk</h2>

    <label>Язык интерфейса</label>
    <select id="languageSelect">
      <option value="ru" ${language === "ru" ? "selected" : ""}>Русский</option>
      <option value="en" ${language === "en" ? "selected" : ""}>English</option>
    </select>

    <label>
      <input type="checkbox" id="reasoningToggle"
        ${localStorage.getItem(STORAGE.reasoning) === "true" ? "checked" : ""}>
      Глубокое рассуждение
    </label>

    <button class="primary-button" id="saveSettings">Сохранить</button>
  `);

  $("saveSettings")?.addEventListener("click", () => {
    const selectedLanguage = $("languageSelect").value;
    const reasoning = $("reasoningToggle").checked;

    localStorage.setItem(STORAGE.language, selectedLanguage);
    localStorage.setItem(STORAGE.reasoning, String(reasoning));

    closeModal();
    toast("Настройки сохранены. Обнови страницу для смены языка.");
  });
}

function initEvents() {
  $("chatForm")?.addEventListener("submit", event => {
    event.preventDefault();
    sendMessage($("prompt")?.value || "");
  });

  $("newChat")?.addEventListener("click", newChat);
  $("profileButton")?.addEventListener("click", showProfile);
  $("upgradeButton")?.addEventListener("click", showPlans);
  $("topUpgrade")?.addEventListener("click", showPlans);
  $("settingsButton")?.addEventListener("click", showSettings);

  $("modalClose")?.addEventListener("click", closeModal);
  $("modalBackdrop")?.addEventListener("click", event => {
    if (event.target === $("modalBackdrop")) closeModal();
  });

  document.querySelectorAll("[data-page]").forEach(button => {
    button.addEventListener("click", () => {
      renderPage(button.dataset.page);
    });
  });

  $("welcome")?.addEventListener("click", event => {
    const suggestion = event.target.closest("[data-prompt]");
    if (suggestion) sendMessage(suggestion.dataset.prompt);
  });

  $("reasoningButton")?.addEventListener("click", () => {
    const enabled = localStorage.getItem(STORAGE.reasoning) !== "true";
    localStorage.setItem(STORAGE.reasoning, String(enabled));
    $("reasoningButton").classList.toggle("active", enabled);
    toast(enabled ? "Глубокое рассуждение включено." : "Глубокое рассуждение выключено.");
  });

  $("attachButton")?.addEventListener("click", () => {
    $("fileInput")?.click();
  });

  $("fileInput")?.addEventListener("change", () => {
    const files = $("fileInput").files;
    if (files?.length) {
      toast("Выбран файл: " + files[0].name + ". Обработка файлов будет добавлена отдельно.");
    }
  });

  $("mobileMenu")?.addEventListener("click", () => {
    $("sidebar")?.classList.toggle("open");
  });
}

// -----------------------------
// ЗАПУСК
// -----------------------------

async function init() {
  initEvents();

  const reasoningEnabled = localStorage.getItem(STORAGE.reasoning) === "true";
  $("reasoningButton")?.classList.toggle("active", reasoningEnabled);

  const authenticated = await checkAuth();

  if (authenticated) {
    await loadUsage();
    await loadHistory();

    if (currentUser.role === "OWNER") {
      addAdminNavigation();
    }

    renderPage("chat");
  } else {
    showAuth("login");
  }

  try {
    const status = await api("/api/status");
    console.log("Pinsk server:", status);
  } catch (error) {
    console.error("Pinsk server unavailable:", error);
  }
}

document.addEventListener("DOMContentLoaded", init);
