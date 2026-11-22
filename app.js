
"use strict";

/* =========================================
   PINSK AI — APP.JS
   ========================================= */

const $ = id => document.getElementById(id);

const OWNER_EMAIL = "artamonovzahar466@gmail.com";

const STORAGE = {
  chats: "pinsk_chats",
  projects: "pinsk_projects",
  library: "pinsk_library",
  reasoning: "pinsk_reasoning",
  language: "pinsk_language"
};

function readStorage(key, fallback = []) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

let chats = readStorage(STORAGE.chats);
let projects = readStorage(STORAGE.projects);
let library = readStorage(STORAGE.library);

let currentUser = null;
let currentChatId = null;
let currentPage = "chat";
let usageData = null;
let isSending = false;
let language = localStorage.getItem(STORAGE.language) || "ru";
let recognition = null;

/* =========================================
   УТИЛИТЫ
   ========================================= */

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
    console.log(message);
    return;
  }

  element.textContent = message;
  element.classList.add("show");

  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.classList.remove("show");
  }, 3000);
}

function makeId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function isOwner() {
  return String(currentUser?.role || "").toUpperCase() === "OWNER";
}

/* =========================================
   ОБРАБОТКА МАТЕМАТИЧЕСКИХ ФОРМУЛ
   ========================================= */

function cleanMath(value) {
  let text = String(value ?? "");

  text = text.replace(/\\\[/g, "");
  text = text.replace(/\\\]/g, "");
  text = text.replace(/\\\(/g, "");
  text = text.replace(/\\\)/g, "");
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, "$1");
  text = text.replace(/\$([^$\n]+)\$/g, "$1");

  const replacements = [
    [/\\times\b/g, "×"],
    [/\\cdot\b/g, "·"],
    [/\\div\b/g, "÷"],
    [/\\pm\b/g, "±"],
    [/\\neq\b/g, "≠"],
    [/\\leq\b/g, "≤"],
    [/\\le\b/g, "≤"],
    [/\\geq\b/g, "≥"],
    [/\\ge\b/g, "≥"],
    [/\\approx\b/g, "≈"],
    [/\\infty\b/g, "∞"],
    [/\\pi\b/g, "π"],
    [/\\sqrt\s*\{([^{}]+)\}/g, "√($1)"],
    [/\\degree\b/g, "°"],
    [/\\%/g, "%"]
  ];

  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }

  text = text.replace(/\\text\s*\{([^{}]*)\}/g, "$1");

  const superscripts = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³",
    "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷",
    "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻",
    "=": "⁼", "(": "⁽", ")": "⁾"
  };

  text = text.replace(/\^\{([^{}]+)\}/g, (_, value) => {
    return [...value].map(char => superscripts[char] || char).join("");
  });

  text = text.replace(/\^([0-9])/g, (_, value) => {
    return superscripts[value] || value;
  });

  const subscripts = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃",
    "4": "₄", "5": "₅", "6": "₆", "7": "₇",
    "8": "₈", "9": "₉", "+": "₊", "-": "₋"
  };

  text = text.replace(/_\{([^{}]+)\}/g, (_, value) => {
    return [...value].map(char => subscripts[char] || char).join("");
  });

  text = text.replace(/_([0-9])/g, (_, value) => {
    return subscripts[value] || value;
  });

  text = text.replace(/\\(mathrm|mathbf|mathit|mathbb|left|right)\b/g, "");
  text = text.replace(/\\,/g, " ");
  text = text.replace(/\\;/g, " ");
  text = text.replace(/\\!/g, "");
  text = text.replace(/\\quad\b/g, " ");
  text = text.replace(/\\qquad\b/g, " ");

  return text;
}

/* =========================================
   MARKDOWN
   ========================================= */

function renderInlineMarkdown(value) {
  let text = escapeHTML(cleanMath(value));

  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__(.+?)__/g, "<strong>$1</strong>");
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  text = text.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1</em>");
  text = text.replace(/~~(.+?)~~/g, "<del>$1</del>");

  return text;
}

function renderMarkdown(value) {
  const source = String(value ?? "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");

  let html = "";
  let paragraph = [];
  let listType = null;
  let codeLines = [];
  let inCode = false;
  let codeLanguage = "";

  function closeParagraph() {
    if (!paragraph.length) return;

    html += `<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`;
    paragraph = [];
  }

  function closeList() {
    if (!listType) return;

    html += listType === "ul" ? "</ul>" : "</ol>";
    listType = null;
  }

  function closeCode() {
    if (!inCode) return;

    html += `<pre><code class="language-${escapeHTML(codeLanguage)}">${escapeHTML(codeLines.join("\n"))}</code></pre>`;
    codeLines = [];
    codeLanguage = "";
    inCode = false;
  }

  for (const line of lines) {
    const fence = line.match(/^```([\w-]*)\s*$/);

    if (fence) {
      closeParagraph();
      closeList();

      if (inCode) {
        closeCode();
      } else {
        inCode = true;
        codeLanguage = fence[1] || "text";
      }

      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      closeParagraph();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);

    if (heading) {
      closeParagraph();
      closeList();

      const level = heading[1].length;
      html += `<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`;
      continue;
    }

    if (/^[-*_]{3,}$/.test(line.trim())) {
      closeParagraph();
      closeList();
      html += "<hr>";
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);

    if (unordered || ordered) {
      closeParagraph();

      const nextType = unordered ? "ul" : "ol";

      if (listType !== nextType) {
        closeList();
        listType = nextType;
        html += nextType === "ul" ? "<ul>" : "<ol>";
      }

      const item = unordered ? unordered[1] : ordered[1];
      html += `<li>${renderInlineMarkdown(item)}</li>`;
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  closeParagraph();
  closeList();
  closeCode();

  return html || "";
}

/* =========================================
   API
   ========================================= */

async function api(url, options = {}) {
  let response;

  try {
    response = await window.fetch.call(window, url, {
      ...options,
      credentials: "include",
      headers: {
        ...(options.headers || {}),
        ...(options.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" })
      }
    });
  } catch (error) {
    console.error("Pinsk connection error:", error);

    const connectionError = new Error(
      "Не удалось подключиться к серверу."
    );

    connectionError.status = 0;
    throw connectionError;
  }

  const contentType = response.headers.get("content-type") || "";
  let data;

  if (contentType.includes("application/json")) {
    data = await response.json().catch(() => ({}));
  } else {
    const responseText = await response.text().catch(() => "");
    data = {
      error: responseText || "Неверный ответ сервера."
    };
  }

  if (!response.ok) {
    const error = new Error(
      data.error || `Ошибка ${response.status}`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

/* =========================================
   МОДАЛЬНЫЕ ОКНА
   ========================================= */

function showModal(content) {
  const backdrop = $("modalBackdrop");
  const modalContent = $("modalContent");

  if (!backdrop || !modalContent) {
    toast("Окно приложения не найдено.");
    return;
  }

  modalContent.innerHTML = content;
  backdrop.classList.add("active");
  $("modal")?.classList.add("active");
}

function closeModal() {
  $("modalBackdrop")?.classList.remove("active");
  $("modal")?.classList.remove("active");
}

/* =========================================
   АВТОРИЗАЦИЯ
   ========================================= */

function showAuth(mode = "login") {
  const register = mode === "register";

  showModal(`
    <div class="auth-box">
      <h2>${register ? "Регистрация Pinsk" : "Вход в Pinsk"}</h2>
      <p>${register ? "Создай свой аккаунт." : "Войди в свой аккаунт."}</p>

      ${register ? `
        <label>Имя</label>
        <input id="authName" maxlength="50" placeholder="Твоё имя">
      ` : ""}

      <label>Email</label>
      <input id="authEmail" type="email" placeholder="example@mail.com">

      <label>Пароль</label>
      <input id="authPassword" type="password" placeholder="Пароль">

      <button class="primary-button" id="authSubmit">
        ${register ? "Зарегистрироваться" : "Войти"}
      </button>

      <p id="authError" class="error-text"></p>

      <p class="auth-switch">
        ${register ? "Уже есть аккаунт?" : "Нет аккаунта?"}
        <a href="#" id="authSwitch">
          ${register ? "Войти" : "Регистрация"}
        </a>
      </p>
    </div>
  `);

  $("authSwitch")?.addEventListener("click", event => {
    event.preventDefault();
    showAuth(register ? "login" : "register");
  });

  const submit = async () => {
    const name = $("authName")?.value.trim() || "";
    const email = $("authEmail")?.value.trim() || "";
    const password = $("authPassword")?.value || "";
    const error = $("authError");
    const button = $("authSubmit");

    if (!email || !password || (register && !name)) {
      error.textContent = "Заполни все поля.";
      return;
    }

    if (password.length < 8) {
      error.textContent = "Пароль должен содержать минимум 8 символов.";
      return;
    }

    button.disabled = true;
    button.textContent = "Подождите...";

    try {
      const data = await api(
        register ? "/api/auth/register" : "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ name, email, password })
        }
      );

      if (!data.user) {
        throw new Error("Сервер не вернул данные пользователя.");
      }

      currentUser = data.user;

      closeModal();
      updateProfile();

      await loadUsage();
      await loadHistory();

      renderPage("chat");
      toast("Добро пожаловать в Pinsk!");

    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
      button.textContent = register
        ? "Зарегистрироваться"
        : "Войти";
    }
  };

  $("authSubmit")?.addEventListener("click", submit);

  ["authEmail", "authPassword", "authName"].forEach(id => {
    $(id)?.addEventListener("keydown", event => {
      if (event.key === "Enter") submit();
    });
  });
}

async function checkAuth() {
  try {
    const data = await api("/api/auth/me");

    currentUser = data.user || null;
    updateProfile();

    return Boolean(currentUser);

  } catch (error) {
    console.error("Проверка авторизации:", error);

    if (error.status === 401) {
      currentUser = null;
      updateProfile();
      return false;
    }

    if (error.status === 403) {
      currentUser = null;
      updateProfile();
      toast(error.message || "Доступ к аккаунту ограничен.");
      return false;
    }

    return "unavailable";
  }
}

async function logout() {
  try {
    await api("/api/auth/logout", {
      method: "POST"
    });
  } catch (error) {
    console.error(error);
  }

  currentUser = null;
  usageData = null;
  currentChatId = null;

  updateProfile();
  showAuth("login");
}

/* =========================================
   ПРОФИЛЬ
   ========================================= */

function updateProfile() {
  const name = currentUser?.name || "Гость";
  const role = currentUser?.role || "FREE";

  if ($("profileName")) {
    $("profileName").textContent = name;
  }

  if ($("avatar")) {
    $("avatar").textContent = name.charAt(0).toUpperCase();
  }

  if ($("profileButton")) {
    $("profileButton").title = currentUser
      ? `${name} · ${role}`
      : "Войти";
  }

  const badge = document.querySelector(".free-badge");

  if (badge) {
    badge.textContent = role;
    badge.classList.toggle("owner-badge", role === "OWNER");
    badge.classList.toggle("pro-badge", role === "PRO");
  }

  const description = document.querySelector(".profile-info small");

  if (description) {
    description.textContent =
      role === "OWNER" ? "Владелец Pinsk AI" :
      role === "PRO" ? "Pinsk PRO" :
      "Бесплатный план";
  }

  if (isOwner()) {
    addAdminNavigation();
  } else {
    removeAdminNavigation();
  }
}

function showProfile() {
  if (!currentUser) {
    showAuth("login");
    return;
  }

  const role = currentUser.role || "FREE";

  showModal(`
    <div class="profile-modal">
      <h2>Мой аккаунт</h2>
      <h3>${escapeHTML(currentUser.name)}</h3>
      <p>${escapeHTML(currentUser.email)}</p>
      <p>Тариф: ${escapeHTML(role)}</p>
      ${
        role === "OWNER"
          ? "<p>Владелец Pinsk AI. Доступ без ограничений.</p>"
          : ""
      }
      <button class="secondary-button" id="profilePlans">Тарифы</button>
      <button class="secondary-button" id="profileLogout">Выйти</button>
    </div>
  `);

  $("profilePlans").onclick = () => {
    closeModal();
    renderPage("plans");
  };

  $("profileLogout").onclick = logout;
}

/* =========================================
   ТАРИФЫ
   ========================================= */

function showPlans() {
  renderPage("plans");
}

function renderPlans() {
  const page = getPageView();
  if (!page) return;

  const owner = isOwner();

  page.innerHTML = `
    <div class="page-content">
      <h2>Тарифы Pinsk</h2>

      ${
        owner
          ? `
            <div class="dashboard-card">
              <h3>OWNER</h3>
              <h2>Без ограничений</h2>
              <p>Аккаунт создателя Pinsk AI.</p>
              <p>Полный доступ к возможностям платформы.</p>
            </div>
          `
          : ""
      }

      <div class="dashboard-card">
        <h3>FREE</h3>
        <h2>Бесплатно</h2>
        <p>100 сообщений в день.</p>
      </div>

      <div class="dashboard-card">
        <h3>Pinsk PRO</h3>
        <h2>2 990 ₸ / месяц</h2>
        <p>Расширенные возможности.</p>
      </div>

      <div class="dashboard-card">
        <h3>Pinsk PRO годовой</h3>
        <h2>30 498 ₸ / год</h2>
        <p>Скидка 15%.</p>
      </div>

      <p>Оплата пока не подключена.</p>
    </div>
  `;
}

/* =========================================
   ИСПОЛЬЗОВАНИЕ
   ========================================= */

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
  const element = $("usageInfo");

  if (!element) return;

  element.innerHTML = `
    <div>Сообщения: ${used.messages || 0} / ${limits.messages ?? "∞"}</div>
    <div>Изображения: ${used.images || 0} / ${limits.images ?? "∞"}</div>
    <div>Файлы: ${used.files || 0} / ${limits.files ?? "∞"}</div>
  `;
}

/* =========================================
   ЧАТЫ
   ========================================= */

function newChat() {
  currentChatId = null;

  if ($("messages")) {
    $("messages").innerHTML = "";
  }

  if ($("prompt")) {
    $("prompt").value = "";
  }

  renderPage("chat");
}

function renderMessage(role, content) {
  const messages = $("messages");
  if (!messages) return;

  const isUser = role === "user";

  const item = document.createElement("div");
  item.className = isUser
    ? "message user-message"
    : "message assistant-message";

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = isUser ? "" : "P";

  const body = document.createElement("div");
  body.className = "message-content";

  const title = document.createElement("div");
  title.className = "message-author";
  title.textContent = isUser ? "Вы" : "Pinsk";

  const text = document.createElement("div");
  text.className = "message-text";
  text.innerHTML = renderMarkdown(content);

  body.append(title, text);

  if (isUser) {
    item.append(body);
  } else {
    item.append(avatar, body);
  }

  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;
}

async function loadHistory() {
  if (!currentUser) return;

  try {
    const result = await api("/api/history");

    chats = Array.isArray(result) ? result : [];
    saveLocal();
    renderHistory();

  } catch (error) {
    console.error("History:", error);
  }
}

function renderHistory() {
  const container = $("history");
  if (!container) return;

  container.innerHTML = "";

  chats.forEach(chat => {
    const button = document.createElement("button");

    button.className = "history-item";
    button.textContent = chat.title || "Новый чат";

    if (chat.id === currentChatId) {
      button.classList.add("active");
    }

    button.addEventListener("click", () => openChat(chat.id));
    container.appendChild(button);
  });
}

async function openChat(id) {
  if (!currentUser) {
    showAuth("login");
    return;
  }

  try {
    const result = await api(
      `/api/history/${encodeURIComponent(id)}`
    );

    currentChatId = id;

    if ($("messages")) {
      $("messages").innerHTML = "";
    }

    const messages = Array.isArray(result)
      ? result
      : result.messages || [];

    messages.forEach(message => {
      renderMessage(message.role, message.content);
    });

    renderHistory();
    renderPage("chat");

  } catch (error) {
    toast(error.message);
  }
}

async function sendMessage(value, options = {}) {
  if (!currentUser) {
    showAuth("login");
    return;
  }

  if (isSending) return;

  const message = String(value || "").trim();
  if (!message) return;

  isSending = true;

  const sendButton = $("sendButton");

  if (sendButton) {
    sendButton.disabled = true;
  }

  if (currentPage === "chat" && $("welcome")) {
    $("welcome").style.display = "none";
  }

  if (options.voice !== true) {
    renderMessage("user", message);
  }

  if ($("prompt")) {
    $("prompt").value = "";
  }

  const loading = document.createElement("div");
  loading.className = "message assistant-message loading-message";

  const loadingText = document.createElement("div");
  loadingText.className = "message-content";
  loadingText.textContent = "Pinsk думает...";

  loading.appendChild(loadingText);

  if (options.voice === true && $("voiceStatus")) {
    $("voiceStatus").textContent = "Pinsk думает...";
  } else {
    $("messages")?.appendChild(loading);
  }

  try {
    const data = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message,
        conversationId: currentChatId || makeId()
      })
    });

    currentChatId = data.conversationId || currentChatId;

    loading.remove();

    const answer = data.answer || "Нет ответа.";

    if (options.voice === true) {
      if ($("voiceStatus")) {
        $("voiceStatus").textContent = answer;
      }

      speakAnswer(answer);

    } else {
      renderMessage("assistant", answer);
    }

    await loadUsage();
    await loadHistory();

  } catch (error) {
    loading.remove();

    if (options.voice === true) {
      if ($("voiceStatus")) {
        $("voiceStatus").textContent = "Ошибка: " + error.message;
      }
    } else {
      renderMessage("assistant", "Ошибка: " + error.message);
    }

    toast(error.message);

  } finally {
    isSending = false;

    if (sendButton) {
      sendButton.disabled = false;
    }
  }
}

/* =========================================
   СТРАНИЦЫ
   ========================================= */

function getPageView() {
  const workspace = $("workspace");
  if (!workspace) return null;

  let element = $("pageView");

  if (!element) {
    element = document.createElement("div");
    element.id = "pageView";
    element.className = "page-view";
    workspace.appendChild(element);
  }

  return element;
}

function renderPage(page) {
  closeModal();

  if (currentPage === "voice" && page !== "voice") {
    stopVoice();
  }

  if (page === "admin" && !isOwner()) {
    toast("Доступ к админ-панели разрешён только владельцу.");
    page = "chat";
  }

  currentPage = page;

  document.querySelectorAll("[data-page]").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.page === page
    );
  });

  const titles = {
    chat: "Pinsk AI",
    overview: "Обзор",
    projects: "Проекты",
    library: "Библиотека",
    plugins: "Плагины",
    analysis: "Анализ данных",
    voice: "Голосовой режим",
    plans: "Тарифы",
    admin: "Админ-панель"
  };

  if ($("pageTitle")) {
    $("pageTitle").textContent = titles[page] || "Pinsk AI";
  }

  renderPageContent(page);
  $("sidebar")?.classList.remove("open");
}

function renderPageContent(page) {
  const view = getPageView();
  if (!view) return;

  const welcome = $("welcome");
  const messages = $("messages");
  const composer = $("composerArea");

  if (page === "chat") {
    view.style.display = "none";

    if (welcome) {
      welcome.style.display = currentChatId ? "none" : "";
    }

    if (messages) {
      messages.style.display = "flex";
    }

    if (composer) {
      composer.style.display = "";
    }

    return;
  }

  if (welcome) welcome.style.display = "none";
  if (messages) messages.style.display = "none";
  if (composer) composer.style.display = "none";

  view.style.display = "block";

  if (page === "overview") {
    view.innerHTML = `
      <div class="page-content">
        <h2>Обзор Pinsk</h2>

        <div class="dashboard-grid">
          <div class="dashboard-card">
            <h3>Аккаунт</h3>
            <p>${escapeHTML(currentUser?.name || "Гость")}</p>
            <p>${escapeHTML(currentUser?.role || "FREE")}</p>
          </div>

          <div class="dashboard-card">
            <h3>Проекты</h3>
            <p>${projects.length}</p>
          </div>

          <div class="dashboard-card">
            <h3>Библиотека</h3>
            <p>${library.length}</p>
          </div>

          <div class="dashboard-card">
            <h3>Использование</h3>
            <div id="usageInfo">Загрузка...</div>
          </div>
        </div>
      </div>
    `;

    renderUsage();
    return;
  }

  if (page === "projects") {
    view.innerHTML = `
      <div class="page-content">
        <h2>Мои проекты</h2>
        <button class="primary-button" id="addProject">
          + Новый проект
        </button>
        <div id="projectsList"></div>
      </div>
    `;

    renderProjects();
    $("addProject")?.addEventListener("click", createProject);
    return;
  }

  if (page === "library") {
    view.innerHTML = `
      <div class="page-content">
        <h2>Библиотека</h2>
        <button class="primary-button" id="addLibraryItem">
          + Добавить материал
        </button>
        <div id="libraryList"></div>
      </div>
    `;

    renderLibrary();
    $("addLibraryItem")?.addEventListener("click", addLibraryItem);
    return;
  }

  if (page === "plugins" || page === "analysis") {
    view.innerHTML = `
      <div class="page-content">
        <h2>${page === "plugins" ? "Плагины" : "Анализ данных"}</h2>
        <div class="dashboard-card">
          Раздел находится в разработке.
        </div>
      </div>
    `;
    return;
  }

  if (page === "voice") {
    view.innerHTML = `
      <div class="page-content voice-page">
        <h2>Голосовой режим</h2>
        <p>Общайся с Pinsk голосом.</p>

        <div class="voice-controls">
          <button class="primary-button" id="voiceStart">
            🎙 Начать разговор
          </button>

          <button class="secondary-button" id="voiceStop">
            Остановить
          </button>
        </div>

        <div class="voice-status" id="voiceStatus">
          Готов к разговору.
        </div>
      </div>
    `;

    $("voiceStart")?.addEventListener("click", startVoice);
    $("voiceStop")?.addEventListener("click", stopVoice);
    return;
  }

  if (page === "plans") {
    renderPlans();
    return;
  }

  if (page === "admin") {
    renderAdmin();
    return;
  }

  view.innerHTML = `
    <div class="page-content">
      <h2>Раздел не найден</h2>
    </div>
  `;
}

/* =========================================
   ПРОЕКТЫ
   ========================================= */

function renderProjects() {
  const container = $("projectsList");
  if (!container) return;

  container.innerHTML = projects.length
    ? projects.map(project => `
      <div class="dashboard-card">
        <h3>${escapeHTML(project.name)}</h3>
        <p>${escapeHTML(project.description || "")}</p>
        <button
          class="secondary-button"
          data-delete-project="${escapeHTML(project.id)}"
        >
          Удалить
        </button>
      </div>
    `).join("")
    : "<p>Пока нет проектов.</p>";

  container.querySelectorAll("[data-delete-project]").forEach(button => {
    button.addEventListener("click", () => {
      projects = projects.filter(
        item => item.id !== button.dataset.deleteProject
      );

      saveLocal();
      renderProjects();
    });
  });
}

function createProject() {
  showModal(`
    <h2>Новый проект</h2>
    <input id="projectName" placeholder="Название">
    <textarea id="projectDescription" placeholder="Описание"></textarea>
    <button class="primary-button" id="saveProject">
      Создать
    </button>
  `);

  $("saveProject").onclick = () => {
    const name = $("projectName").value.trim();
    const description = $("projectDescription").value.trim();

    if (!name) {
      return toast("Введи название проекта.");
    }

    projects.push({
      id: makeId(),
      name,
      description
    });

    saveLocal();
    closeModal();
    renderProjects();
    toast("Проект создан.");
  };
}

/* =========================================
   БИБЛИОТЕКА
   ========================================= */

function renderLibrary() {
  const container = $("libraryList");
  if (!container) return;

  container.innerHTML = library.length
    ? library.map(item => `
      <div class="dashboard-card">
        <h3>${escapeHTML(item.title)}</h3>
        <p>${escapeHTML(item.content)}</p>
        <button
          class="secondary-button"
          data-delete-library="${escapeHTML(item.id)}"
        >
          Удалить
        </button>
      </div>
    `).join("")
    : "<p>Библиотека пуста.</p>";

  container.querySelectorAll("[data-delete-library]").forEach(button => {
    button.addEventListener("click", () => {
      library = library.filter(
        item => item.id !== button.dataset.deleteLibrary
      );

      saveLocal();
      renderLibrary();
    });
  });
}

function addLibraryItem() {
  showModal(`
    <h2>Добавить материал</h2>
    <input id="libraryTitle" placeholder="Название">
    <textarea id="libraryContent" placeholder="Текст"></textarea>
    <button class="primary-button" id="saveLibrary">
      Сохранить
    </button>
  `);

  $("saveLibrary").onclick = () => {
    const title = $("libraryTitle").value.trim();
    const content = $("libraryContent").value.trim();

    if (!title || !content) {
      return toast("Заполни оба поля.");
    }

    library.push({
      id: makeId(),
      title,
      content
    });

    saveLocal();
    closeModal();
    renderLibrary();
    toast("Материал сохранён.");
  };
}

/* =========================================
   АДМИН-ПАНЕЛЬ
   ========================================= */

function addAdminNavigation() {
  if (!isOwner()) return;

  if (document.querySelector('[data-page="admin"]')) {
    return;
  }

  const nav = document.querySelector(
    "#sidebar .navigation"
  ) || document.querySelector(".navigation");

  if (!nav) {
    console.warn("Pinsk: не найдена навигация для админ-панели.");
    return;
  }

  const button = document.createElement("button");

  button.type = "button";
  button.dataset.page = "admin";
  button.className = "nav-item";
  button.textContent = "⚙ Админ-панель";

  button.addEventListener("click", () => {
    renderPage("admin");
  });

  nav.appendChild(button);
}

function removeAdminNavigation() {
  document.querySelector('[data-page="admin"]')?.remove();
}

async function renderAdmin() {
  const view = getPageView();
  if (!view) return;

  if (!isOwner()) {
    view.innerHTML = `
      <div class="page-content">
        <h2>Доступ запрещён.</h2>
        <p>Этот раздел доступен только владельцу Pinsk AI.</p>
      </div>
    `;
    return;
  }

  view.innerHTML = `
    <div class="page-content admin-page">
      <h2>Админ-панель Pinsk</h2>

      <div class="dashboard-grid" id="adminStats">
        Загрузка...
      </div>

      <h3>Пользователи</h3>

      <input
        id="adminSearch"
        placeholder="Поиск пользователей"
      >

      <button class="secondary-button" id="adminRefresh">
        Обновить
      </button>

      <div id="adminUsersList">
        Загрузка...
      </div>
    </div>
  `;

  $("adminSearch")?.addEventListener("input", () => {
    clearTimeout(renderAdmin.timer);
    renderAdmin.timer = setTimeout(loadAdminUsers, 300);
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
        <h3>Пользователи</h3>
        <h2>${Number(stats.total || 0)}</h2>
      </div>

      <div class="dashboard-card">
        <h3>FREE</h3>
        <h2>${Number(stats.free || 0)}</h2>
      </div>

      <div class="dashboard-card">
        <h3>PRO</h3>
        <h2>${Number(stats.pro || 0)}</h2>
      </div>

      <div class="dashboard-card">
        <h3>Заблокировано</h3>
        <h2>${Number(stats.blocked || 0)}</h2>
      </div>
    `;

  } catch (error) {
    const container = $("adminStats");

    if (container) {
      container.textContent = error.message;
    }
  }
}

async function loadAdminUsers() {
  const container = $("adminUsersList");
  if (!container) return;

  try {
    const search = $("adminSearch")?.value || "";

    const result = await api(
      "/api/admin/users?search=" + encodeURIComponent(search)
    );

    const users = Array.isArray(result)
      ? result
      : result.users || [];

    if (!users.length) {
      container.innerHTML = "<p>Пользователи не найдены.</p>";
      return;
    }

    container.innerHTML = users.map(user => `
      <div class="dashboard-card">
        <h3>${escapeHTML(user.name)}</h3>
        <p>${escapeHTML(user.email)}</p>
        <p>Тариф: ${escapeHTML(user.role)}</p>
        <p>Статус: ${
          user.is_blocked ? "Заблокирован" : "Активен"
        }</p>
      </div>
    `).join("");

  } catch (error) {
    container.innerHTML = `
      <p>${escapeHTML(error.message)}</p>
    `;
  }
}

/* =========================================
   ГОЛОСОВОЙ РЕЖИМ
   ========================================= */

function speakAnswer(text) {
  if (!("speechSynthesis" in window)) return;

  window.speechSynthesis.cancel();

  const cleanText = cleanMath(String(text))
    .replace(/```[\s\S]*?```/g, "Блок кода.")
    .replace(/[#*_`~$]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1");

  const utterance = new SpeechSynthesisUtterance(cleanText);

  utterance.lang = language === "en" ? "en-US" : "ru-RU";
  utterance.rate = 1;
  utterance.pitch = 1;

  utterance.onend = () => {
    if (currentPage === "voice" && $("voiceStatus")) {
      $("voiceStatus").textContent = "Готов слушать.";
    }
  };

  utterance.onerror = () => {
    if ($("voiceStatus")) {
      $("voiceStatus").textContent =
        "Не удалось озвучить ответ.";
    }
  };

  window.speechSynthesis.speak(utterance);
}

function startVoice() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    toast("Браузер не поддерживает распознавание речи.");
    return;
  }

  if (!currentUser) {
    showAuth("login");
    return;
  }

  stopVoice();

  recognition = new SpeechRecognition();
  recognition.lang = language === "en" ? "en-US" : "ru-RU";
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onstart = () => {
    if ($("voiceStatus")) {
      $("voiceStatus").textContent = "Слушаю тебя...";
    }
  };

  recognition.onresult = event => {
    const spokenText = event.results[0][0].transcript;

    if ($("voiceStatus")) {
      $("voiceStatus").textContent = "Ты: " + spokenText;
    }

    sendMessage(spokenText, { voice: true });
  };

  recognition.onerror = event => {
    console.error("Voice recognition:", event.error);

    if ($("voiceStatus")) {
      $("voiceStatus").textContent =
        event.error === "not-allowed"
          ? "Разреши доступ к микрофону в браузере."
          : "Ошибка распознавания речи.";
    }
  };

  recognition.onend = () => {
    recognition = null;
  };

  try {
    recognition.start();
  } catch (error) {
    console.error(error);
    toast("Не удалось запустить микрофон.");
  }
}

function stopVoice() {
  if (recognition) {
    try {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onstart = null;
      recognition.onend = null;
      recognition.stop();
    } catch (error) {
      console.warn("Voice stop:", error);
    }

    recognition = null;
  }

  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }

  if ($("voiceStatus")) {
    $("voiceStatus").textContent =
      "Голосовой режим остановлен.";
  }
}

/* =========================================
   НАСТРОЙКИ
   ========================================= */

function showSettings() {
  showModal(`
    <h2>Настройки Pinsk</h2>

    <label>Язык</label>

    <select id="languageSelect">
      <option value="ru" ${
        language === "ru" ? "selected" : ""
      }>Русский</option>

      <option value="en" ${
        language === "en" ? "selected" : ""
      }>English</option>
    </select>

    <label>
      <input
        type="checkbox"
        id="reasoningToggle"
        ${
          localStorage.getItem(STORAGE.reasoning) === "true"
            ? "checked"
            : ""
        }
      >
      Глубокое рассуждение
    </label>

    <button class="primary-button" id="saveSettings">
      Сохранить
    </button>
  `);

  $("saveSettings").onclick = () => {
    language = $("languageSelect").value;

    localStorage.setItem(STORAGE.language, language);

    localStorage.setItem(
      STORAGE.reasoning,
      String($("reasoningToggle").checked)
    );

    closeModal();
    toast("Настройки сохранены.");
  };
}

/* =========================================
   СОБЫТИЯ
   ========================================= */

function initEvents() {
  $("chatForm")?.addEventListener("submit", event => {
    event.preventDefault();
    sendMessage($("prompt")?.value || "");
  });

  $("prompt")?.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("chatForm")?.requestSubmit();
    }
  });

  $("newChat")?.addEventListener("click", newChat);
  $("profileButton")?.addEventListener("click", showProfile);
  $("upgradeButton")?.addEventListener("click", showPlans);
  $("topUpgrade")?.addEventListener("click", showPlans);
  $("settingsButton")?.addEventListener("click", showSettings);
  $("modalClose")?.addEventListener("click", closeModal);

  $("modalBackdrop")?.addEventListener("click", event => {
    if (event.target === $("modalBackdrop")) {
      closeModal();
    }
  });

  document.querySelectorAll("[data-page]").forEach(button => {
    button.addEventListener("click", () => {
      renderPage(button.dataset.page);
    });
  });

  $("welcome")?.addEventListener("click", event => {
    const item = event.target.closest("[data-prompt]");

    if (item) {
      sendMessage(item.dataset.prompt);
    }
  });

  $("reasoningButton")?.addEventListener("click", () => {
    const enabled =
      localStorage.getItem(STORAGE.reasoning) !== "true";

    localStorage.setItem(
      STORAGE.reasoning,
      String(enabled)
    );

    $("reasoningButton")?.classList.toggle("active", enabled);

    toast(
      enabled
        ? "Глубокое мышление включено."
        : "Глубокое мышление выключено."
    );
  });

  $("attachButton")?.addEventListener("click", () => {
    $("fileInput")?.click();
  });

  $("fileInput")?.addEventListener("change", () => {
    const file = $("fileInput")?.files?.[0];

    if (file) {
      toast("Выбран файл: " + file.name);
    }
  });

  $("mobileMenu")?.addEventListener("click", () => {
    $("sidebar")?.classList.toggle("open");
  });
}

/* =========================================
   ОФОРМЛЕНИЕ КНОПОК И ПОЛЕЙ
   ========================================= */

function installPinskUiFixes() {
  if ($("pinskUiFixes")) return;

  const style = document.createElement("style");

  style.id = "pinskUiFixes";

  style.textContent = `
    .auth-box label,
    .profile-modal label {
      display: block;
      margin: 14px 0 7px;
      color: #d8d5e8;
      font-weight: 600;
    }

    .auth-box input,
    .profile-modal input,
    .modal input:not([type="checkbox"]),
    .modal select,
    .modal textarea {
      display: block;
      width: 100%;
      min-height: 42px;
      margin: 7px 0 13px;
      padding: 11px 13px;
      color: #f2f2f5;
      background: #111116;
      border: 1px solid #3b3949;
      border-radius: 9px;
      outline: none;
    }

    .auth-box input:focus,
    .modal input:focus,
    .modal select:focus,
    .modal textarea:focus {
      border-color: #8b78ff;
      box-shadow: 0 0 0 2px #8b78ff26;
    }

    .primary-button,
    .secondary-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 40px;
      padding: 10px 15px;
      border-radius: 9px;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
      transition:
        background .2s,
        border-color .2s,
        transform .2s;
    }

    .primary-button {
      color: #fff !important;
      background: #7865e8 !important;
      border: 1px solid #8b78ff !important;
    }

    .primary-button:hover {
      background: #8b78ff !important;
    }

    .secondary-button {
      color: #e8e4ff !important;
      background: #292638 !important;
      border: 1px solid #514875 !important;
    }

    .secondary-button:hover {
      background: #39324f !important;
      border-color: #8b78ff !important;
    }

    .primary-button:disabled,
    .secondary-button:disabled {
      opacity: .6;
      cursor: not-allowed;
    }

    .auth-box .primary-button {
      width: 100%;
      margin-top: 8px;
    }

    .auth-switch a {
      color: #b5a8ff;
    }

    .error-text {
      color: #ff8b9b !important;
    }

    .modal-backdrop.active {
      display: flex;
    }

    .message-text p {
      margin: 0 0 10px;
    }

    .message-text p:last-child {
      margin-bottom: 0;
    }

    .message-text pre {
      overflow-x: auto;
      padding: 12px;
      border-radius: 9px;
      background: #111116;
    }

    .message-text code {
      overflow-wrap: anywhere;
    }

    .message-text ul,
    .message-text ol {
      padding-left: 22px;
      margin: 8px 0;
    }

    .message-text h1,
    .message-text h2,
    .message-text h3 {
      margin: 12px 0 8px;
    }

    .message-text hr {
      border: 0;
      border-top: 1px solid #393644;
      margin: 12px 0;
    }

    .owner-badge {
      color: #f0d28b;
    }
  `;

  document.head.appendChild(style);
}

/* =========================================
   ЗАПУСК
   ========================================= */

async function init() {
  console.log("Pinsk AI: запуск...");

  installPinskUiFixes();
  initEvents();
  updateProfile();

  const authResult = await checkAuth();

  if (authResult === true) {
    await loadUsage();
    await loadHistory();
    renderPage("chat");

  } else if (authResult === false) {
    showAuth("login");

  } else {
    toast(
      "Не удалось проверить вход. Сервер временно недоступен. Попробуй обновить страницу позже."
    );

    renderPage("chat");
  }

  try {
    const status = await api("/api/status");
    console.log("Pinsk server:", status);
  } catch (error) {
    console.error("Pinsk server:", error);
  }

  console.log("Pinsk AI: готов.");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
