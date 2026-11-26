

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
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
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
let selectedAnalysisFile = null;

let selectedFiles = [];
let imageMode = false;
let temporaryUrls = [];
let studioFiles = { html: "", css: "", js: "" };
let studioActiveTab = "html";

/* =========================================
   ХРАНИЛИЩЕ
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
   МАТЕМАТИКА
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

  text = text.replace(/\^\{([^{}]+)\}/g, (_, value) =>
    [...value].map(char => superscripts[char] || char).join("")
  );

  text = text.replace(/\^([0-9])/g, (_, value) =>
    superscripts[value] || value
  );

  const subscripts = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃",
    "4": "₄", "5": "₅", "6": "₆", "7": "₇",
    "8": "₈", "9": "₉", "+": "₊", "-": "₋"
  };

  text = text.replace(/_\{([^{}]+)\}/g, (_, value) =>
    [...value].map(char => subscripts[char] || char).join("")
  );

  text = text.replace(/_([0-9])/g, (_, value) =>
    subscripts[value] || value
  );

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
  const lines = String(value ?? "").replace(/\r\n/g, "\n").split("\n");

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

      html += `<li>${renderInlineMarkdown(unordered ? unordered[1] : ordered[1])}</li>`;
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
    const headers = { ...(options.headers || {}) };

    if (!(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    } else {
      delete headers["Content-Type"];
    }

    response = await window.fetch.call(window, url, {
      ...options,
      credentials: "include",
      headers
    });

  } catch (error) {
    const connectionError = new Error("Не удалось подключиться к серверу.");
    connectionError.status = 0;
    throw connectionError;
  }

  const contentType = response.headers.get("content-type") || "";
  let data;

  if (contentType.includes("application/json")) {
    data = await response.json().catch(() => ({}));
  } else {
    data = {
      error: await response.text().catch(() => "Неверный ответ сервера.")
    };
  }

  if (!response.ok) {
    const error = new Error(data.error || `Ошибка ${response.status}`);
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

function showEmailVerification(email) {
  const userEmail = String(email || "").trim().toLowerCase();

  showModal(`
    <div class="auth-box">
      <h2>Подтверждение email</h2>
      <p>
        Мы отправили письмо с кодом подтверждения на:
      </p>

      <p style="color:#b5a8ff;font-weight:600;overflow-wrap:anywhere;">
        ${escapeHTML(userEmail)}
      </p>

      <label>Шестизначный код</label>
      <input
        id="authVerificationCode"
        type="text"
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="6"
        placeholder="000000"
      >

      <button class="primary-button" id="verifyEmailButton">
        Подтвердить email
      </button>

      <p id="verificationError" class="error-text"></p>
      <p id="verificationNotice"></p>

      <button
        class="secondary-button"
        id="resendVerificationButton"
        style="width:100%;margin-top:8px;"
      >
        Отправить код повторно
      </button>

      <p class="auth-switch">
        <a href="#" id="backToLogin">Вернуться ко входу</a>
      </p>
    </div>
  `);

  const codeInput = $("authVerificationCode");
  const verifyButton = $("verifyEmailButton");
  const resendButton = $("resendVerificationButton");
  const errorElement = $("verificationError");
  const noticeElement = $("verificationNotice");

  codeInput?.focus();

  codeInput?.addEventListener("input", () => {
    codeInput.value = codeInput.value
      .replace(/\D/g, "")
      .slice(0, 6);
  });

  async function verifyCode() {
    if (!codeInput || !verifyButton || verifyButton.disabled) return;

    const code = codeInput.value.trim();

    errorElement.textContent = "";
    noticeElement.textContent = "";

    if (!/^\d{6}$/.test(code)) {
      errorElement.textContent = "Введи шестизначный код из письма.";
      return;
    }

    verifyButton.disabled = true;
    verifyButton.textContent = "Проверка...";

    try {
      const data = await api("/api/auth/verify-email", {
        method: "POST",
        body: JSON.stringify({
          email: userEmail,
          code
        })
      });

      if (!data.user) {
        throw new Error("Сервер не вернул пользователя.");
      }

      currentUser = data.user;

      closeModal();
      updateProfile();

      await loadUsage();
      await loadHistory();

      renderPage("chat");

      toast("Email подтверждён! Добро пожаловать в Pinsk AI!");

    } catch (error) {
      errorElement.textContent = error.message;

      verifyButton.disabled = false;
      verifyButton.textContent = "Подтвердить email";
    }
  }

  async function resendCode() {
    if (!resendButton || resendButton.disabled) return;

    errorElement.textContent = "";
    noticeElement.textContent = "";

    resendButton.disabled = true;
    resendButton.textContent = "Отправка...";

    try {
      const data = await api("/api/auth/resend-code", {
        method: "POST",
        body: JSON.stringify({
          email: userEmail
        })
      });

      noticeElement.textContent =
        data.message || "Новый код отправлен на твою почту.";

    } catch (error) {
      errorElement.textContent = error.message;

    } finally {
      resendButton.disabled = false;
      resendButton.textContent = "Отправить код повторно";
    }
  }

  verifyButton?.addEventListener("click", verifyCode);
  resendButton?.addEventListener("click", resendCode);

  codeInput?.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      verifyCode();
    }
  });

  $("backToLogin")?.addEventListener("click", event => {
    event.preventDefault();
    showAuth("login");
  });
}

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
        <a href="#" id="authSwitch">${register ? "Войти" : "Регистрация"}</a>
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

    if (button?.disabled) return;

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

    error.textContent = "";

    try {
      const data = await api(
        register ? "/api/auth/register" : "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({
            name,
            email,
            password
          })
        }
      );

      if (register && data.verificationRequired) {
        showEmailVerification(data.email || email);
        return;
      }

      if (!data.user) {
        throw new Error("Сервер не вернул пользователя.");
      }

      currentUser = data.user;

      closeModal();
      updateProfile();

      await loadUsage();
      await loadHistory();

      renderPage("chat");

      toast(
        currentUser.role === "OWNER"
          ? "Добро пожаловать, владелец Pinsk!"
          : "Добро пожаловать в Pinsk!"
      );

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
      toast(error.message);
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

  clearSelectedFiles();

  currentUser = null;
  usageData = null;
  currentChatId = null;

  updateProfile();
  showAuth("login");
}

/* =========================================
   ПРОФИЛЬ И OWNER
   ========================================= */

function updateProfile() {
  const name = currentUser?.name || "Гость";
  const role = String(currentUser?.role || "FREE").toUpperCase();

  if ($("profileName")) $("profileName").textContent = name;
  if ($("avatar")) $("avatar").textContent = name.charAt(0).toUpperCase();

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

  if (isOwner()) addAdminNavigation();
  else removeAdminNavigation();
}

function showProfile() {
  if (!currentUser) return showAuth("login");

  const role = String(currentUser.role || "FREE").toUpperCase();

  showModal(`
    <div class="profile-modal">
      <h2>Мой аккаунт</h2>
      <h3>${escapeHTML(currentUser.name)}</h3>
      <p>${escapeHTML(currentUser.email)}</p>
      <p>Тариф: ${escapeHTML(role)}</p>
      ${role === "OWNER" ? "<p>Владелец Pinsk AI. Полный доступ без ограничений.</p>" : ""}
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

function renderPlans() {
  const page = getPageView();
  if (!page) return;

  page.innerHTML = `
    <div class="page-content">
      <h2>Тарифы Pinsk</h2>
      <p>Выбери подходящий план для работы с Pinsk AI.</p>

      ${isOwner() ? `
        <div class="dashboard-card">
          <h3>OWNER — Владелец</h3>
          <h2>Без ограничений</h2>
          <p>Полный доступ ко всем функциям платформы.</p>
          <ul>
            <li>Безлимитные сообщения</li>
            <li>Безлимитные файлы и изображения</li>
            <li>Админ-панель и управление пользователями</li>
            <li>Все возможности Pinsk PRO</li>
          </ul>
        </div>
      ` : ""}

      <div class="dashboard-grid">
        <div class="dashboard-card">
          <h3>FREE</h3>
          <h2>Бесплатно</h2>
          <p>Для знакомства с Pinsk AI.</p>
          <ul>
            <li>100 сообщений в день</li>
            <li>5 изображений в день</li>
            <li>5 файлов в день</li>
            <li>История чатов</li>
            <li>Базовый ИИ-ассистент</li>
            <li>Проекты и библиотека</li>
          </ul>
          <p><strong>Стоимость: 0 ₸</strong></p>
        </div>

        <div class="dashboard-card">
          <h3>Pinsk PRO</h3>
          <h2>2 990 ₸ / месяц</h2>
          <p>Для расширенной работы с ИИ.</p>
          <ul>
            <li>Безлимитные сообщения</li>
            <li>Безлимитные файлы</li>
            <li>Генерация изображений</li>
            <li>Проекты и библиотека</li>
            <li>Глубокое рассуждение</li>
            <li>Голосовое общение</li>
            <li>Расширенные инструменты</li>
          </ul>
          <p><strong>2 990 ₸ в месяц</strong></p>
        </div>

        <div class="dashboard-card">
          <h3>Pinsk PRO — годовой</h3>
          <h2>30 498 ₸ / год</h2>
          <p>Экономия 15% по сравнению с оплатой за каждый месяц.</p>
          <ul>
            <li>Все возможности PRO</li>
            <li>Оплата за год</li>
            <li>Выгоднее месячного плана</li>
          </ul>
          <p><strong>30 498 ₸ в год</strong></p>
        </div>
      </div>

      <p class="muted-text">
        Подключение оплаты пока не настроено. Тарифы отображают запланированные возможности.
      </p>
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
   ВЛОЖЕНИЯ
   ========================================= */

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " Б";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " КБ";
  return (bytes / (1024 * 1024)).toFixed(1) + " МБ";
}

function isImageFile(file) {
  return /^image\/(png|jpeg|jpg|webp|gif)$/i.test(file.type);
}

function revokeTemporaryUrls() {
  temporaryUrls.forEach(url => URL.revokeObjectURL(url));
  temporaryUrls = [];
}

function clearSelectedFiles() {
  revokeTemporaryUrls();

  selectedFiles = [];

  if ($("fileInput")) $("fileInput").value = "";

  renderAttachmentPreview();
}

/* =========================================
   DRAG & DROP — ПЕРЕТАСКИВАНИЕ ФАЙЛОВ
   ========================================= */

function installDragAndDrop() {
  if ($("pinskDropOverlay")) return;

  let dragCounter = 0;

  const overlay = document.createElement("div");
  overlay.id = "pinskDropOverlay";
  overlay.setAttribute("aria-hidden", "true");

  overlay.innerHTML = `
    <div class="pinsk-drop-content">
      <div class="pinsk-drop-icon">📂</div>
      <h2>Перетащите файлы сюда</h2>
      <p>Отпустите мышь, чтобы прикрепить файлы к сообщению</p>
    </div>
  `;

  document.body.appendChild(overlay);

  function hasFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes("Files");
  }

  function showOverlay() {
    if (currentPage !== "chat" || imageMode) return;

    overlay.classList.add("active");
    overlay.setAttribute("aria-hidden", "false");
  }

  function hideOverlay() {
    overlay.classList.remove("active");
    overlay.setAttribute("aria-hidden", "true");
  }

  document.addEventListener("dragenter", event => {
    if (!hasFiles(event)) return;

    event.preventDefault();
    dragCounter++;

    showOverlay();
  });

  document.addEventListener("dragover", event => {
    if (!hasFiles(event)) return;

    event.preventDefault();

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect =
        currentPage === "chat" && !imageMode ? "copy" : "none";
    }

    showOverlay();
  });

  document.addEventListener("dragleave", event => {
    if (!hasFiles(event)) return;

    event.preventDefault();

    dragCounter = Math.max(0, dragCounter - 1);

    if (dragCounter === 0) {
      hideOverlay();
    }
  });

  document.addEventListener("drop", event => {
    if (!hasFiles(event)) return;

    event.preventDefault();
    event.stopPropagation();

    dragCounter = 0;
    hideOverlay();

    if (currentPage !== "chat") {
      toast("Перетащи файлы в окно чата.");
      return;
    }

    if (imageMode) {
      toast("Сначала выключи режим генерации изображения.");
      return;
    }

    const files = event.dataTransfer?.files;

    if (!files || !files.length) return;

    const previousCount = selectedFiles.length;

    addSelectedFiles(files);

    const addedCount = selectedFiles.length - previousCount;

    if (addedCount > 0) {
      toast(
        addedCount === 1
          ? "Файл добавлен."
          : `Добавлено файлов: ${addedCount}`
      );
    }
  });

  window.addEventListener("dragend", () => {
    dragCounter = 0;
    hideOverlay();
  });

  window.addEventListener("blur", () => {
    dragCounter = 0;
    hideOverlay();
  });
}

function removeSelectedFile(index) {
  if (index < 0 || index >= selectedFiles.length) return;

  selectedFiles.splice(index, 1);
  renderAttachmentPreview();
}

function addSelectedFiles(files) {
  const incoming = Array.from(files || []);

  if (!incoming.length) return;

  const maxFiles = 5;
  const maxSize = 12 * 1024 * 1024;

  for (const file of incoming) {
    if (selectedFiles.length >= maxFiles) {
      toast("Можно прикрепить не более 5 файлов.");
      break;
    }

    if (file.size > maxSize) {
      toast(`Файл ${file.name} превышает 12 МБ.`);
      continue;
    }

    const alreadyAdded = selectedFiles.some(item =>
      item.name === file.name &&
      item.size === file.size &&
      item.lastModified === file.lastModified
    );

    if (alreadyAdded) continue;

    selectedFiles.push(file);
  }

  if ($("fileInput")) $("fileInput").value = "";

  renderAttachmentPreview();
}

function renderAttachmentPreview() {
  // Используем контейнер, который уже находится в HTML внутри формы.
  const container = $("selectedFiles");

  if (!container) return;

  // Освобождаем старые URL изображений перед повторной отрисовкой.
  revokeTemporaryUrls();

  container.innerHTML = "";

  if (!selectedFiles.length) {
    container.style.display = "none";
    return;
  }

  container.style.display = "flex";

  selectedFiles.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "pinsk-attachment-item";

    if (isImageFile(file)) {
      const image = document.createElement("img");
      image.className = "pinsk-attachment-thumb";

      const url = URL.createObjectURL(file);
      temporaryUrls.push(url);

      image.src = url;
      image.alt = file.name;

      item.appendChild(image);
    } else {
      const icon = document.createElement("div");
      icon.className = "pinsk-attachment-icon";
      icon.textContent = file.name.split(".").pop()?.toUpperCase() || "FILE";

      item.appendChild(icon);
    }

    const info = document.createElement("div");
    info.className = "pinsk-attachment-info";

    const name = document.createElement("div");
    name.className = "pinsk-attachment-name";
    name.textContent = file.name;

    const size = document.createElement("div");
    size.className = "pinsk-attachment-size";
    size.textContent = formatFileSize(file.size);

    info.append(name, size);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "pinsk-attachment-remove";
    remove.textContent = "×";
    remove.title = "Удалить файл";
    remove.setAttribute("aria-label", `Удалить файл ${file.name}`);

    remove.addEventListener("click", () => removeSelectedFile(index));

    item.append(info, remove);
    container.appendChild(item);
  });
}

/* =========================================
   ЧАТЫ
   ========================================= */

function newChat() {
  currentChatId = null;

  clearSelectedFiles();

  if ($("messages")) $("messages").innerHTML = "";
  if ($("prompt")) $("prompt").value = "";

  renderPage("chat");
  renderHistory();
}

function safeImageSource(source) {
  const value = String(source || "");

  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(value)) {
    return value;
  }

  if (/^https:\/\/[^\s"'<>]+$/i.test(value)) {
    return value;
  }

  return "";
}

function renderMessage(role, content, options = {}) {
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

  body.appendChild(title);

  const text = document.createElement("div");
  text.className = "message-text";
  text.innerHTML = renderMarkdown(content || "");

  if (content) body.appendChild(text);

  const attachments = Array.isArray(options.attachments)
    ? options.attachments
    : [];

  if (attachments.length) {
    const attachmentList = document.createElement("div");
    attachmentList.className = "pinsk-message-attachments";

    attachments.forEach(file => {
      const chip = document.createElement("div");
      chip.className = "pinsk-message-file";
      chip.textContent = "📎 " + String(file.name || "Файл");
      attachmentList.appendChild(chip);
    });

    body.appendChild(attachmentList);
  }

  const imageSource = safeImageSource(options.image || options.imageUrl);

  if (imageSource) {
    const imageBox = document.createElement("div");
    imageBox.className = "pinsk-generated-image";

    const image = document.createElement("img");
    image.src = imageSource;
    image.alt = "Изображение Pinsk AI";
    image.loading = "lazy";

    imageBox.appendChild(image);

    const download = document.createElement("a");
    download.href = imageSource;
    download.download = "pinsk-ai-image.png";
    download.className = "pinsk-image-download";
    download.textContent = "↓ Сохранить изображение";

    imageBox.appendChild(download);
    body.appendChild(imageBox);
  }

  if (isUser) item.append(body);
  else item.append(avatar, body);

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

    if (chat.id === currentChatId) button.classList.add("active");

    button.addEventListener("click", () => openChat(chat.id));
    container.appendChild(button);
  });
}

async function openChat(id) {
  if (!currentUser) return showAuth("login");

  try {
    const result = await api(`/api/history/${encodeURIComponent(id)}`);

    currentChatId = id;

    if ($("messages")) $("messages").innerHTML = "";

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

/* =========================================
   ОТПРАВКА СООБЩЕНИЙ
   ========================================= */

function setSendingState(value) {
  isSending = value;

  const sendButton = $("sendButton");
  const imageButton = $("imageModeButton");

  if (sendButton) sendButton.disabled = value;
  if (imageButton) imageButton.disabled = value;
}

function createLoadingMessage(text = "Pinsk думает...") {
  const loading = document.createElement("div");
  loading.className = "message assistant-message loading-message";

  const loadingText = document.createElement("div");
  loadingText.className = "message-content";
  loadingText.textContent = text;

  loading.appendChild(loadingText);
  $("messages")?.appendChild(loading);

  const messages = $("messages");
  if (messages) messages.scrollTop = messages.scrollHeight;

  return loading;
}

async function sendMessage(value, options = {}) {
  if (!currentUser) return showAuth("login");
  if (isSending) return;

  const message = String(value || "").trim();
  const files = [...selectedFiles];

  if (!message && !files.length) return;

  if (imageMode && files.length) {
    toast("Для генерации изображения сначала убери вложения.");
    return;
  }

  if (imageMode && !message) {
    toast("Опиши изображение, которое нужно создать.");
    return;
  }

  setSendingState(true);

  if (currentPage === "chat" && $("welcome")) {
    $("welcome").style.display = "none";
  }

  renderMessage("user", message || "Проанализируй прикреплённые файлы.", {
    attachments: files.map(file => ({ name: file.name }))
  });

  if ($("prompt")) $("prompt").value = "";

  const loading = createLoadingMessage(
    imageMode ? "Pinsk создаёт изображение..." : "Pinsk думает..."
  );

  try {
    if (imageMode) {
      const data = await api("/api/images/generate", {
        method: "POST",
        body: JSON.stringify({ prompt: message })
      });

      loading.remove();

      const image = data.image || data.imageUrl || data.url ||
        data.data?.[0]?.url || "";

      const answer = data.answer || data.text ||
        "Изображение создано.";

      if (!image) {
        throw new Error("Сервер не вернул изображение.");
      }

      renderMessage("assistant", answer, { image });

      await loadUsage();

    } else {
      const formData = new FormData();

      formData.append("message", message || "Проанализируй прикреплённые файлы.");
      formData.append("conversationId", currentChatId || makeId());

      files.forEach(file => {
        formData.append("files", file, file.name);
      });

      const data = await api("/api/chat", {
        method: "POST",
        body: formData
      });

      currentChatId = data.conversationId || currentChatId;

      loading.remove();

      const answer = data.answer || "Нет ответа.";

      renderMessage("assistant", answer);

      if (options.speak) speakAnswer(answer);

      await loadUsage();
      await loadHistory();
    }

    if (files.length) clearSelectedFiles();

  } catch (error) {
    loading.remove();

    renderMessage(
      "assistant",
      "Не удалось выполнить запрос: " + error.message
    );

    toast(error.message);

  } finally {
    setSendingState(false);
  }
}

/* =========================================
   ГЕНЕРАЦИЯ ИЗОБРАЖЕНИЙ
   ========================================= */

function installImageModeButton() {
  const form = $("chatForm");
  if (!form || $("imageModeButton")) return;

  const button = document.createElement("button");

  button.type = "button";
  button.id = "imageModeButton";
  button.className = "pinsk-image-mode";
  button.textContent = "🎨 Создать изображение";
  button.title = "Переключить режим генерации изображений";

  button.addEventListener("click", () => {
    imageMode = !imageMode;

    button.classList.toggle("active", imageMode);
    button.textContent = imageMode
      ? "✕ Режим изображения"
      : "🎨 Создать изображение";

    if (imageMode) {
      if (selectedFiles.length) clearSelectedFiles();

      toast("Режим генерации включён. Опиши изображение.");

      if ($("prompt")) {
        $("prompt").placeholder = "Опиши изображение, которое нужно создать...";
        $("prompt").focus();
      }
    } else {
      if ($("prompt")) {
        $("prompt").placeholder = "Спроси что-нибудь...";
      }

      toast("Обычный режим чата.");
    }
  });

  const attachButton = $("attachButton");

  if (attachButton && attachButton.parentElement === form) {
    form.insertBefore(button, attachButton);
  } else {
    form.appendChild(button);
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

  if (currentPage === "voice" && page !== "voice") stopVoice();

  if (page === "admin" && !isOwner()) {
    toast("Доступ к админ-панели разрешён только владельцу.");
    page = "chat";
  }

  currentPage = page;

  document.querySelectorAll("[data-page]").forEach(button => {
    button.classList.toggle("active", button.dataset.page === page);
  });

  const titles = {
    chat: "Pinsk AI",
    overview: "Обзор",
    projects: "Проекты",
    library: "Библиотека",
    plugins: "Плагины",
    analysis: "Анализ данных",
    studio: "Студия дизайна",
    voice: "Голосовой режим",
    plans: "Тарифы",
    admin: "Админ-панель"
  };

  if ($("pageTitle")) $("pageTitle").textContent = titles[page] || "Pinsk AI";

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

    if (welcome) welcome.style.display = currentChatId ? "none" : "";
    if (messages) messages.style.display = "flex";
    if (composer) composer.style.display = "";

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
        <button class="primary-button" id="addProject">+ Новый проект</button>
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
        <button class="primary-button" id="addLibraryItem">+ Добавить материал</button>
        <div id="libraryList"></div>
      </div>
    `;

    renderLibrary();
    $("addLibraryItem")?.addEventListener("click", addLibraryItem);
    return;
  }

  if (page === "plugins") {
    renderPlugins();
    return;
  }

  if (page === "analysis") {
    renderAnalysis();
    return;
  }

  if (page === "studio") {
    renderStudio();
    return;
  }

  if (page === "voice") {
    view.innerHTML = `
      <div class="page-content voice-page">
        <h2>Голосовой режим</h2>
        <p>Общайся с Pinsk голосом.</p>
        <div class="voice-controls">
          <button class="primary-button" id="voiceStart">🎙 Начать разговор</button>
          <button class="secondary-button" id="voiceStop">Остановить</button>
        </div>
        <div class="voice-status" id="voiceStatus">Готов к разговору.</div>
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
   СТУДИЯ ДИЗАЙНА
   ========================================= */

function installStudioNavigation() {
  if (document.querySelector('[data-page="studio"]')) return;

  const nav = document.querySelector("#sidebar .navigation") ||
    document.querySelector(".navigation");
  if (!nav) return;

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.page = "studio";
  button.className = "nav-item";
  button.innerHTML = '<span aria-hidden="true">✦</span><span>Студия дизайна</span>';
  nav.appendChild(button);
}

function renderStudio() {
  const view = getPageView();
  if (!view) return;

  view.innerHTML = `
    <div class="page-content studio-page">
      <div class="studio-heading">
        <div>
          <h2>Студия дизайна</h2>
          <p>Создавай изображения, макеты и полноценные сайты с помощью Pinsk AI.</p>
        </div>
        <span class="studio-mark">P</span>
      </div>

      <div class="studio-mode-tabs" role="tablist" aria-label="Инструменты студии">
        <button type="button" class="studio-mode-tab active" data-studio-mode="image">✧ Генерация изображений</button>
        <button type="button" class="studio-mode-tab" data-studio-mode="website">⌘ Создание сайтов</button>
      </div>

      <section class="studio-panel" id="studioImagePanel">
        <div class="studio-panel-heading">
          <div><h3>Генератор изображений</h3><p>Логотипы, баннеры, обложки, иллюстрации и рекламные материалы.</p></div>
        </div>
        <form id="studioImageForm" class="studio-prompt-form">
          <label for="studioImagePrompt">Опиши, какое изображение нужно создать</label>
          <textarea id="studioImagePrompt" maxlength="2048" rows="4" placeholder="Например: минималистичный логотип технологической компании в фиолетовых и чёрных оттенках..."></textarea>
          <div class="studio-form-footer"><span>До 2048 символов</span><button class="primary-button" id="studioImageSubmit" type="submit">✦ Создать изображение</button></div>
        </form>
        <div id="studioImageStatus" class="studio-status" role="status" aria-live="polite"></div>
        <div id="studioImageResult" class="studio-image-result"></div>
      </section>

      <section class="studio-panel" id="studioWebsitePanel" hidden>
        <div class="studio-panel-heading">
          <div><h3>Конструктор сайтов</h3><p>Опиши сайт — Pinsk подготовит HTML, CSS и JavaScript, а ты сможешь изменить код и посмотреть результат.</p></div>
        </div>
        <form id="studioWebsiteForm" class="studio-prompt-form">
          <label for="studioWebsitePrompt">Какой сайт или интерфейс создать?</label>
          <textarea id="studioWebsitePrompt" maxlength="5000" rows="4" placeholder="Например: современный сайт кофейни с меню, фотографиями, ценами и формой бронирования..."></textarea>
          <div class="studio-form-footer"><span>До 5000 символов</span><button class="primary-button" id="studioWebsiteSubmit" type="submit">⌘ Сгенерировать сайт</button></div>
        </form>
        <div id="studioWebsiteStatus" class="studio-status" role="status" aria-live="polite"></div>

        <div class="studio-workspace" id="studioWorkspace" hidden>
          <div class="studio-editor-column">
            <div class="studio-editor-top"><strong>Редактор кода</strong><div class="studio-file-tabs">
              <button type="button" data-studio-file="html" class="active">HTML</button>
              <button type="button" data-studio-file="css">CSS</button>
              <button type="button" data-studio-file="js">JS</button>
            </div></div>
            <textarea id="studioCodeEditor" class="studio-code-editor" spellcheck="false" aria-label="Редактор кода"></textarea>
            <div class="studio-editor-actions"><button type="button" class="secondary-button" id="studioUpdatePreview">↻ Обновить просмотр</button><button type="button" class="secondary-button" id="studioDownloadCurrent">↓ Скачать файл</button></div>
            <div class="studio-download-all"><button type="button" class="primary-button" id="studioDownloadAll">Скачать проект (HTML + CSS + JS)</button></div>
          </div>
          <div class="studio-preview-column">
            <div class="studio-preview-heading"><strong>Предпросмотр</strong><span>Изолированный режим</span></div>
            <iframe id="studioPreview" title="Предпросмотр сайта" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
          </div>
        </div>
      </section>
    </div>
  `;

  const imagePanel = $("studioImagePanel");
  const websitePanel = $("studioWebsitePanel");
  const modeButtons = view.querySelectorAll("[data-studio-mode]");

  modeButtons.forEach(button => button.addEventListener("click", () => {
    const mode = button.dataset.studioMode;
    modeButtons.forEach(item => item.classList.toggle("active", item === button));
    imagePanel.hidden = mode !== "image";
    websitePanel.hidden = mode !== "website";
  }));

  $("studioImageForm")?.addEventListener("submit", generateStudioImage);
  $("studioWebsiteForm")?.addEventListener("submit", generateStudioWebsite);

  view.querySelectorAll("[data-studio-file]").forEach(button => {
    button.addEventListener("click", () => setStudioEditorTab(button.dataset.studioFile));
  });

  $("studioCodeEditor")?.addEventListener("input", () => {
    studioFiles[studioActiveTab] = $("studioCodeEditor").value;
  });
  $("studioUpdatePreview")?.addEventListener("click", updateStudioPreview);
  $("studioDownloadCurrent")?.addEventListener("click", downloadStudioCurrentFile);
  $("studioDownloadAll")?.addEventListener("click", downloadStudioProject);
}

async function generateStudioImage(event) {
  event.preventDefault();
  const prompt = $("studioImagePrompt")?.value.trim() || "";
  const status = $("studioImageStatus");
  const result = $("studioImageResult");
  const button = $("studioImageSubmit");

  if (!prompt) {
    status.textContent = "Сначала опиши изображение.";
    return;
  }

  button.disabled = true;
  button.textContent = "Создаю...";
  status.textContent = "Pinsk создаёт изображение. Это может занять несколько минут.";
  result.innerHTML = "";

  try {
    const data = await api("/api/images/generate", {
      method: "POST",
      body: JSON.stringify({ prompt })
    });
    const source = safeImageSource(data.image || data.imageUrl || data.url);
    if (!source) throw new Error("Сервер не вернул изображение.");

    const image = document.createElement("img");
    image.src = source;
    image.alt = "Изображение, созданное в Студии дизайна Pinsk AI";
    image.loading = "lazy";
    result.appendChild(image);

    const download = document.createElement("a");
    download.href = source;
    download.download = "pinsk-studio-image.png";
    download.className = "secondary-button studio-image-download";
    download.textContent = "↓ Скачать изображение";
    result.appendChild(download);
    status.textContent = "Изображение готово.";
    if (data.usage) usageData = data.usage;
  } catch (error) {
    status.textContent = error.message || "Не удалось создать изображение.";
  } finally {
    button.disabled = false;
    button.textContent = "✦ Создать изображение";
  }
}

async function generateStudioWebsite(event) {
  event.preventDefault();
  const prompt = $("studioWebsitePrompt")?.value.trim() || "";
  const status = $("studioWebsiteStatus");
  const button = $("studioWebsiteSubmit");
  if (!prompt) {
    status.textContent = "Опиши сайт, который нужно создать.";
    return;
  }

  button.disabled = true;
  button.textContent = "Генерирую...";
  status.textContent = "Pinsk проектирует интерфейс и пишет код...";

  try {
    const data = await api("/api/design/generate", {
      method: "POST",
      body: JSON.stringify({ prompt })
    });

    studioFiles = {
      html: String(data.html || ""),
      css: String(data.css || ""),
      js: String(data.js || "")
    };
    if (!studioFiles.html) throw new Error("ИИ не вернул HTML-код. Попробуй уточнить запрос.");

    $("studioWorkspace").hidden = false;
    studioActiveTab = "html";
    $("studioCodeEditor").value = studioFiles.html;
    document.querySelectorAll("[data-studio-file]").forEach(tab => {
      tab.classList.toggle("active", tab.dataset.studioFile === "html");
    });
    updateStudioPreview();
    status.textContent = "Сайт создан. Можешь редактировать код, обновлять предпросмотр и скачивать файлы.";
  } catch (error) {
    status.textContent = error.message || "Не удалось создать сайт.";
  } finally {
    button.disabled = false;
    button.textContent = "⌘ Сгенерировать сайт";
  }
}

function setStudioEditorTab(file) {
  if (!Object.prototype.hasOwnProperty.call(studioFiles, file)) return;
  const editor = $("studioCodeEditor");
  if (editor && studioActiveTab) studioFiles[studioActiveTab] = editor.value;
  studioActiveTab = file;
  if (editor) editor.value = studioFiles[file] || "";
  document.querySelectorAll("[data-studio-file]").forEach(button => {
    button.classList.toggle("active", button.dataset.studioFile === file);
  });
}

function buildStudioDocument() {
  let html = String(studioFiles.html || "");
  const css = `<style>\n${studioFiles.css || ""}\n</style>`;
  const js = `<script>\n${String(studioFiles.js || "").replace(/<\/script/gi, "<\\/script")}\n<\/script>`;

  if (/<\/head\s*>/i.test(html)) html = html.replace(/<\/head\s*>/i, css + "</head>");
  else html = css + html;

  if (/<\/body\s*>/i.test(html)) html = html.replace(/<\/body\s*>/i, js + "</body>");
  else html += js;
  return html;
}

function updateStudioPreview() {
  const editor = $("studioCodeEditor");
  if (editor) studioFiles[studioActiveTab] = editor.value;
  const frame = $("studioPreview");
  if (frame) frame.srcdoc = buildStudioDocument();
}

function downloadStudioFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadStudioCurrentFile() {
  const editor = $("studioCodeEditor");
  if (editor) studioFiles[studioActiveTab] = editor.value;
  const extensions = { html: "html", css: "css", js: "js" };
  downloadStudioFile(`pinsk-project.${extensions[studioActiveTab]}`, studioFiles[studioActiveTab], "text/plain;charset=utf-8");
}

function downloadStudioProject() {
  const editor = $("studioCodeEditor");
  if (editor) studioFiles[studioActiveTab] = editor.value;
  downloadStudioFile("index.html", buildStudioDocument(), "text/html;charset=utf-8");
  downloadStudioFile("style.css", studioFiles.css, "text/css;charset=utf-8");
  downloadStudioFile("script.js", studioFiles.js, "text/javascript;charset=utf-8");
}

/* =========================================
   ПЛАГИНЫ
   ========================================= */

function openWebSearchPlugin() {
  showModal(`
    <div class="plugin-modal web-search-modal">
      <div class="plugin-modal__icon">🌐</div>
      <h2>Поиск в интернете</h2>
      <p class="plugin-modal__lead">Найди актуальную информацию в интернете. Pinsk покажет краткий ответ и ссылки на источники.</p>

      <form id="webSearchForm" class="web-search-form">
        <label for="webSearchQuery">Что будем искать?</label>
        <div class="web-search-input-row">
          <input
            id="webSearchQuery"
            name="query"
            type="search"
            maxlength="500"
            autocomplete="off"
            placeholder="Например: последние новости технологий"
            required
          >
          <button type="submit" class="primary-button" id="webSearchSubmit">Найти</button>
        </div>
      </form>

      <div id="webSearchStatus" class="web-search-status" role="status" aria-live="polite"></div>
      <section id="webSearchAnswer" class="web-search-answer" aria-live="polite"></section>
      <section id="webSearchResults" class="web-search-results"></section>
      <p class="plugin-modal__muted">Результаты предоставляются поисковым сервисом и могут требовать дополнительной проверки по первоисточнику.</p>
    </div>
  `);

  const form = $("webSearchForm");
  const input = $("webSearchQuery");
  const button = $("webSearchSubmit");
  const status = $("webSearchStatus");
  const answer = $("webSearchAnswer");
  const results = $("webSearchResults");

  input?.focus();

  form?.addEventListener("submit", async event => {
    event.preventDefault();

    const query = input?.value.trim() || "";
    if (!query) {
      status.textContent = "Введи поисковый запрос.";
      input?.focus();
      return;
    }

    if (query.length > 500) {
      status.textContent = "Запрос не должен превышать 500 символов.";
      return;
    }

    button.disabled = true;
    button.textContent = "Ищу...";
    status.textContent = "Ищем информацию в интернете...";
    answer.innerHTML = "";
    results.innerHTML = "";

    try {
      const data = await api("/api/search", {
        method: "POST",
        body: JSON.stringify({ query })
      });

      if (data.answer) {
        answer.innerHTML = `<h3>Краткий ответ</h3><div class="web-search-answer__text">${renderMarkdown(data.answer)}</div>`;
      }

      const items = Array.isArray(data.results) ? data.results : [];
      if (items.length) {
        results.innerHTML = `<h3>Источники (${items.length})</h3>`;

        items.forEach(item => {
          let url;
          try {
            url = new URL(String(item.url || ""));
          } catch {
            return;
          }

          if (!["http:", "https:"].includes(url.protocol)) return;

          const article = document.createElement("article");
          article.className = "web-search-result";

          const link = document.createElement("a");
          link.className = "web-search-result__title";
          link.href = url.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = String(item.title || item.domain || url.hostname);

          const domain = document.createElement("div");
          domain.className = "web-search-result__domain";
          domain.textContent = String(item.domain || url.hostname);

          const snippet = document.createElement("p");
          snippet.className = "web-search-result__snippet";
          snippet.textContent = String(item.snippet || "");

          article.append(link, domain);
          if (snippet.textContent) article.appendChild(snippet);
          results.appendChild(article);
        });
      }

      if (!data.answer && !items.length) {
        status.textContent = "По этому запросу ничего не найдено. Попробуй изменить формулировку.";
      } else {
        status.textContent = `Поиск завершён. Найдено источников: ${items.length}.`;
      }

    } catch (error) {
      status.textContent = error.message || "Не удалось выполнить поиск.";
      if (error.data?.code === "SEARCH_NOT_CONFIGURED") {
        status.textContent = "Поиск пока не настроен на сервере. Владельцу нужно добавить TAVILY_API_KEY в переменные окружения Render.";
      }
    } finally {
      button.disabled = false;
      button.textContent = "Найти";
    }
  });
}

function openWorkspacePlugin() {
  showModal(`
    <div class="plugin-modal">
      <div class="plugin-modal__icon">🗂️</div>
      <h2>Рабочее пространство</h2>
      <p class="plugin-modal__lead">Выбери, с чем хочешь продолжить работу.</p>
      <div class="plugin-modal__actions">
        <button type="button" class="plugin-action-button" id="openPluginProjects">
          <span class="plugin-action-button__icon">📁</span>
          <span><strong>Проекты</strong><small>Создавай и организуй свои проекты</small></span>
          <span class="plugin-action-button__arrow">›</span>
        </button>
        <button type="button" class="plugin-action-button" id="openPluginLibrary">
          <span class="plugin-action-button__icon">📚</span>
          <span><strong>Библиотека</strong><small>Сохраняй важные материалы и заметки</small></span>
          <span class="plugin-action-button__arrow">›</span>
        </button>
      </div>
    </div>
  `);

  $("openPluginProjects")?.addEventListener("click", () => renderPage("projects"));
  $("openPluginLibrary")?.addEventListener("click", () => renderPage("library"));
}

async function renderPlugins() {
  const view = getPageView();
  if (!view || currentPage !== "plugins") return;

  view.innerHTML = `
    <div class="page-content plugins-page">
      <div class="plugins-heading">
        <div>
          <h2>Плагины Pinsk</h2>
          <p>Дополнительные инструменты и возможности рабочего пространства.</p>
        </div>
        <span class="plugins-heading__label">ИНСТРУМЕНТЫ</span>
      </div>
      <div id="pluginsList" class="plugin-grid">
        <div class="plugin-loading">Загружаем инструменты...</div>
      </div>
    </div>
  `;

  const container = $("pluginsList");
  if (!container) return;

  const fallbackPlugins = [
    {
      id: "web-search",
      name: "Поиск в интернете",
      description: "Ищи актуальную информацию в сети и изучай источники.",
      status: "not_connected",
      icon: "🌐",
      action: openWebSearchPlugin,
      statusText: "Требуется подключение"
    },
    {
      id: "data-analysis",
      name: "Анализ данных",
      description: "Загружай таблицы и текстовые файлы, задавай вопросы и получай выводы.",
      status: "available",
      icon: "📊",
      action: () => renderPage("analysis"),
      statusText: "Доступен"
    },
    {
      id: "workspace",
      name: "Рабочее пространство",
      description: "Управляй проектами и сохраняй полезные материалы в библиотеке.",
      status: "available",
      icon: "🗂️",
      action: openWorkspacePlugin,
      statusText: "Доступен"
    }
  ];

  let plugins = fallbackPlugins;

  try {
    const result = await api("/api/plugins");

    // Не перерисовываем плагины, если пользователь уже открыл другую страницу.
    if (currentPage !== "plugins" || $("pluginsList") !== container) return;

    const serverPlugins = Array.isArray(result?.plugins) ? result.plugins : [];
    const serverById = new Map(serverPlugins.map(plugin => [plugin.id, plugin]));

    plugins = fallbackPlugins.map(fallback => {
      const serverPlugin = serverById.get(fallback.id);
      if (!serverPlugin) return fallback;

      return {
        ...fallback,
        name: serverPlugin.name || fallback.name,
        description: serverPlugin.description || fallback.description,
        status: serverPlugin.status || fallback.status,
        statusText: serverPlugin.status === "available"
          ? "Доступен"
          : (fallback.id === "web-search" ? "Требуется подключение" : fallback.statusText)
      };
    });

  } catch (error) {
    console.warn("Не удалось загрузить каталог плагинов, используются локальные сведения:", error);
    if (currentPage !== "plugins" || $("pluginsList") !== container) return;
  }

  if (currentPage !== "plugins" || $("pluginsList") !== container) return;

  container.innerHTML = "";

  plugins.forEach(plugin => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "plugin-card";
    button.dataset.pluginId = plugin.id;
    button.setAttribute("aria-label", `${plugin.name}. ${plugin.description}`);

    const statusClass = plugin.status === "available"
      ? "plugin-status--available"
      : "plugin-status--pending";

    button.innerHTML = `
      <span class="plugin-card__topline">
        <span class="plugin-card__icon" aria-hidden="true">${plugin.icon}</span>
        <span class="plugin-card__arrow" aria-hidden="true">↗</span>
      </span>
      <span class="plugin-card__title">${escapeHTML(plugin.name)}</span>
      <span class="plugin-card__description">${escapeHTML(plugin.description)}</span>
      <span class="plugin-card__meta">
        <span class="plugin-status ${statusClass}"><span class="plugin-status__dot"></span>${escapeHTML(plugin.statusText)}</span>
        <span class="plugin-card__open">Открыть</span>
      </span>
    `;

    button.addEventListener("click", () => {
      if (currentPage !== "plugins") return;
      plugin.action();
    });

    container.appendChild(button);
  });
}

/* =========================================
   АНАЛИЗ ДАННЫХ
   ========================================= */

function renderAnalysis() {
  const view = getPageView();
  if (!view) return;

  view.innerHTML = `
    <div class="page-content">
      <h2>Анализ данных</h2>
      <p>Загрузи CSV, TXT, JSON или MD-файл и задай вопрос по его содержимому.</p>

      <div class="dashboard-card">
        <label for="analysisFile">Выбрать файл</label>
        <input
          type="file"
          id="analysisFile"
          accept=".csv,.txt,.json,.md"
        >

        <p id="analysisFileName">Файл не выбран.</p>

        <label for="analysisQuestion">Что нужно проанализировать?</label>
        <textarea
          id="analysisQuestion"
          rows="4"
          placeholder="Например: найди закономерности, посчитай итоги и сделай выводы."
        ></textarea>

        <button class="primary-button" id="runAnalysis">
          Проанализировать
        </button>

        <div id="analysisResult" class="analysis-result"></div>
      </div>
    </div>
  `;

  $("analysisFile")?.addEventListener("change", event => {
    selectedAnalysisFile = event.target.files?.[0] || null;

    $("analysisFileName").textContent = selectedAnalysisFile
      ? `Выбран файл: ${selectedAnalysisFile.name}`
      : "Файл не выбран.";
  });

  $("runAnalysis")?.addEventListener("click", runAnalysis);
}

async function runAnalysis() {
  if (!currentUser) return showAuth("login");

  const file = selectedAnalysisFile;
  const question = $("analysisQuestion")?.value.trim() ||
    "Проанализируй данные и сделай выводы.";

  const result = $("analysisResult");
  const button = $("runAnalysis");

  if (!file) {
    toast("Сначала выбери файл.");
    return;
  }

  const allowed = /\.(csv|txt|json|md)$/i.test(file.name);

  if (!allowed) {
    toast("Пока поддерживаются CSV, TXT, JSON и MD.");
    return;
  }

  if (file.size > 2 * 1024 * 1024) {
    toast("Размер файла не должен превышать 2 МБ.");
    return;
  }

  button.disabled = true;
  button.textContent = "Анализирую...";
  result.textContent = "Pinsk анализирует файл...";

  try {
    const content = await file.text();

    const data = await api("/api/analysis", {
      method: "POST",
      body: JSON.stringify({ content, question })
    });

    result.innerHTML = renderMarkdown(data.answer || "Нет результата.");

  } catch (error) {
    result.textContent = "Ошибка анализа: " + error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Проанализировать";
  }
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
        <button class="secondary-button" data-delete-project="${escapeHTML(project.id)}">
          Удалить
        </button>
      </div>
    `).join("")
    : "<p>Пока нет проектов.</p>";

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
    <input id="projectName" placeholder="Название">
    <textarea id="projectDescription" placeholder="Описание"></textarea>
    <button class="primary-button" id="saveProject">Создать</button>
  `);

  $("saveProject").onclick = () => {
    const name = $("projectName").value.trim();
    const description = $("projectDescription").value.trim();

    if (!name) return toast("Введи название проекта.");

    projects.push({ id: makeId(), name, description });
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
        <button class="secondary-button" data-delete-library="${escapeHTML(item.id)}">
          Удалить
        </button>
      </div>
    `).join("")
    : "<p>Библиотека пуста.</p>";

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
    <textarea id="libraryContent" placeholder="Текст"></textarea>
    <button class="primary-button" id="saveLibrary">Сохранить</button>
  `);

  $("saveLibrary").onclick = () => {
    const title = $("libraryTitle").value.trim();
    const content = $("libraryContent").value.trim();

    if (!title || !content) return toast("Заполни оба поля.");

    library.push({ id: makeId(), title, content });
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
  if (document.querySelector('[data-page="admin"]')) return;

  const nav = document.querySelector("#sidebar .navigation") ||
    document.querySelector(".navigation");

  if (!nav) {
    console.warn("Pinsk: не найдена навигация.");
    return;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.page = "admin";
  button.className = "nav-item";
  button.textContent = "⚙ Админ-панель";

  button.addEventListener("click", () => renderPage("admin"));
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
        <h2>Доступ запрещён</h2>
        <p>Этот раздел доступен только владельцу Pinsk AI.</p>
      </div>
    `;
    return;
  }

  view.innerHTML = `
    <div class="page-content admin-page">
      <h2>Админ-панель Pinsk</h2>
      <div class="dashboard-grid" id="adminStats">Загрузка...</div>
      <h3>Пользователи</h3>
      <input id="adminSearch" placeholder="Поиск пользователей">
      <button class="secondary-button" id="adminRefresh">Обновить</button>
      <div id="adminUsersList">Загрузка...</div>
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
      <div class="dashboard-card"><h3>Пользователи</h3><h2>${Number(stats.total || 0)}</h2></div>
      <div class="dashboard-card"><h3>FREE</h3><h2>${Number(stats.free || 0)}</h2></div>
      <div class="dashboard-card"><h3>PRO</h3><h2>${Number(stats.pro || 0)}</h2></div>
      <div class="dashboard-card"><h3>OWNER</h3><h2>${Number(stats.owners || 0)}</h2></div>
      <div class="dashboard-card"><h3>Заблокировано</h3><h2>${Number(stats.blocked || 0)}</h2></div>
    `;
  } catch (error) {
    if ($("adminStats")) $("adminStats").textContent = error.message;
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

    const users = Array.isArray(result) ? result : result.users || [];

    if (!users.length) {
      container.innerHTML = "<p>Пользователи не найдены.</p>";
      return;
    }

    container.innerHTML = users.map(user => `
      <div class="dashboard-card">
        <h3>${escapeHTML(user.name)}</h3>
        <p>${escapeHTML(user.email)}</p>
        <p>Тариф: ${escapeHTML(user.role)}</p>
        <p>Статус: ${user.is_blocked ? "Заблокирован" : "Активен"}</p>
      </div>
    `).join("");

  } catch (error) {
    container.textContent = error.message;
  }
}

/* =========================================
   ГОЛОС
   ========================================= */

function speakAnswer(text) {
  if (!("speechSynthesis" in window)) {
    toast("Озвучивание не поддерживается браузером.");
    return;
  }

  window.speechSynthesis.cancel();

  const cleanText = cleanMath(String(text))
    .replace(/```[\s\S]*?```/g, "Блок кода.")
    .replace(/[#*_`~$]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1");

  const utterance = new SpeechSynthesisUtterance(cleanText);
  utterance.lang = language === "en" ? "en-US" : "ru-RU";
  utterance.rate = 1;
  utterance.pitch = 1;

  window.speechSynthesis.speak(utterance);
}

function startVoice() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    toast("Браузер не поддерживает распознавание речи.");
    return;
  }

  if (!currentUser) return showAuth("login");

  stopVoice();

  recognition = new SpeechRecognition();
  recognition.lang = language === "en" ? "en-US" : "ru-RU";
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onstart = () => {
    const status = $("voiceStatus");
    if (status) status.textContent = "Слушаю тебя...";
    $("voiceButton")?.classList.add("recording");
  };

  recognition.onresult = event => {
    const spokenText = event.results[0][0].transcript;

    if ($("prompt")) $("prompt").value = spokenText;

    sendMessage(spokenText, { speak: true });
  };

  recognition.onerror = event => {
    console.error("Voice recognition:", event.error);

    if (event.error === "not-allowed") {
      toast("Разреши доступ к микрофону в браузере.");
    } else {
      toast("Ошибка распознавания речи.");
    }
  };

  recognition.onend = () => {
    recognition = null;
    $("voiceButton")?.classList.remove("recording");
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
      console.warn(error);
    }

    recognition = null;
  }

  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }

  $("voiceButton")?.classList.remove("recording");

  if ($("voiceStatus")) {
    $("voiceStatus").textContent = "Голосовой режим остановлен.";
  }
}

function installVoiceButton() {
  const form = $("chatForm");
  const prompt = $("prompt");

  if (!form || !prompt || $("voiceButton")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.id = "voiceButton";
  button.className = "voice-inline-button";
  button.title = "Голосовой ввод";
  button.setAttribute("aria-label", "Голосовой ввод");
  button.textContent = "🎙";

  button.addEventListener("click", () => {
    if (recognition) stopVoice();
    else startVoice();
  });

  const sendButton = $("sendButton");

  if (sendButton && sendButton.parentElement === form) {
    form.insertBefore(button, sendButton);
  } else {
    form.appendChild(button);
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
  $("upgradeButton")?.addEventListener("click", () => renderPage("plans"));
  $("topUpgrade")?.addEventListener("click", () => renderPage("plans"));
  $("settingsButton")?.addEventListener("click", showSettings);
  $("modalClose")?.addEventListener("click", closeModal);

  $("modalBackdrop")?.addEventListener("click", event => {
    if (event.target === $("modalBackdrop")) closeModal();
  });

  document.querySelectorAll("[data-page]").forEach(button => {
    button.addEventListener("click", () => renderPage(button.dataset.page));
  });

  $("welcome")?.addEventListener("click", event => {
    const item = event.target.closest("[data-prompt]");
    if (item) sendMessage(item.dataset.prompt);
  });

  $("reasoningButton")?.addEventListener("click", () => {
    const enabled = localStorage.getItem(STORAGE.reasoning) !== "true";

    localStorage.setItem(STORAGE.reasoning, String(enabled));
    $("reasoningButton")?.classList.toggle("active", enabled);

    toast(enabled
      ? "Глубокое мышление включено."
      : "Глубокое мышление выключено."
    );
  });

  $("attachButton")?.addEventListener("click", () => {
    if (imageMode) {
      toast("В режиме генерации изображения вложения отключены.");
      return;
    }

    $("fileInput")?.click();
  });

  $("fileInput")?.addEventListener("change", event => {
    addSelectedFiles(event.target.files);
  });

  $("mobileMenu")?.addEventListener("click", () => {
    $("sidebar")?.classList.toggle("open");
  });
}

/* =========================================
   СТИЛИ
   ========================================= */

function installPinskUiFixes() {
  if ($("pinskUiFixes")) return;

  const style = document.createElement("style");
  style.id = "pinskUiFixes";

  style.textContent = `
    /* Экран Drag & Drop — скрыт до перетаскивания */
    #pinskDropOverlay {
      display: none !important;
      position: fixed;
      inset: 0;
      z-index: 99999;
      align-items: center;
      justify-content: center;
      background: rgba(12, 10, 22, .82);
      backdrop-filter: blur(7px);
      pointer-events: none;
    }

    #pinskDropOverlay.active {
      display: flex !important;
    }

    .pinsk-drop-content {
      width: min(500px, calc(100% - 40px));
      padding: 45px 25px;
      text-align: center;
      border: 2px dashed #9b88ff;
      border-radius: 22px;
      background: #211d32;
      box-shadow: 0 0 50px #8b78ff35;
    }

    .pinsk-drop-icon {
      font-size: 58px;
      margin-bottom: 15px;
    }

    .pinsk-drop-content h2 {
      margin: 0 0 12px;
      color: #fff;
      font-size: 23px;
    }

    .pinsk-drop-content p {
      margin: 0;
      color: #c2badb;
      font-size: 14px;
    }

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
      transition: background .2s, border-color .2s, transform .2s;
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

    .voice-inline-button {
      width: 42px;
      height: 42px;
      flex: 0 0 42px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid #514875;
      border-radius: 12px;
      color: #e8e4ff;
      background: #292638;
      font-size: 19px;
      cursor: pointer;
      margin: 0 6px;
    }

    .voice-inline-button:hover {
      background: #39324f;
      border-color: #8b78ff;
    }

    .voice-inline-button.recording {
      background: #713b55;
      border-color: #ff759d;
      animation: pinskPulse 1.2s infinite;
    }

    @keyframes pinskPulse {
      50% { box-shadow: 0 0 0 5px #ff759d33; }
    }

    .analysis-result {
      margin-top: 18px;
      line-height: 1.65;
      overflow-wrap: anywhere;
    }

    .analysis-result pre {
      overflow-x: auto;
      padding: 12px;
      background: #111116;
      border-radius: 9px;
    }

    .plugin-status {
      color: #b5a8ff;
      font-size: 13px;
    }

    /* Карточки плагинов */
    .plugins-page {
      max-width: 1120px;
    }

    .plugins-heading {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 24px;
    }

    .plugins-heading h2 {
      margin: 0 0 8px;
    }

    .plugins-heading p {
      margin: 0;
      color: #aaa5b8;
      line-height: 1.55;
    }

    .plugins-heading__label {
      flex: 0 0 auto;
      padding: 7px 10px;
      border: 1px solid #514875;
      border-radius: 999px;
      color: #c9bfff;
      background: #292638;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: .09em;
    }

    .plugin-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 245px), 1fr));
      gap: 16px;
    }

    .plugin-card {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      min-width: 0;
      min-height: 225px;
      padding: 19px;
      border: 1px solid #393447;
      border-radius: 17px;
      color: #f2efff;
      background: linear-gradient(145deg, #242130, #191722);
      text-align: left;
      font: inherit;
      cursor: pointer;
      transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease, background .18s ease;
    }

    .plugin-card:hover {
      transform: translateY(-3px);
      border-color: #8170dc;
      background: linear-gradient(145deg, #2b263d, #1d1a29);
      box-shadow: 0 12px 30px #08061055;
    }

    .plugin-card:focus-visible {
      outline: 3px solid #a99aff;
      outline-offset: 3px;
    }

    .plugin-card__topline {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 18px;
    }

    .plugin-card__icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 49px;
      height: 49px;
      border: 1px solid #514875;
      border-radius: 14px;
      background: #302a45;
      font-size: 25px;
    }

    .plugin-card__arrow {
      color: #9588c5;
      font-size: 21px;
      transition: transform .18s ease;
    }

    .plugin-card:hover .plugin-card__arrow {
      transform: translate(2px, -2px);
    }

    .plugin-card__title {
      display: block;
      margin-bottom: 8px;
      color: #fff;
      font-size: 16px;
      font-weight: 750;
    }

    .plugin-card__description {
      display: block;
      flex: 1;
      color: #aaa5b8;
      font-size: 13px;
      line-height: 1.55;
    }

    .plugin-card__meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-top: 20px;
      padding-top: 13px;
      border-top: 1px solid #393447;
    }

    .plugin-status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: #b5a8ff;
      font-size: 11px;
      font-weight: 650;
    }

    .plugin-status__dot {
      width: 7px;
      height: 7px;
      flex: 0 0 7px;
      border-radius: 50%;
      background: #d9a85b;
    }

    .plugin-status--available {
      color: #8eddb1;
    }

    .plugin-status--available .plugin-status__dot {
      background: #62cf91;
      box-shadow: 0 0 9px #62cf9166;
    }

    .plugin-status--pending {
      color: #e5bd79;
    }

    .plugin-card__open {
      color: #c5baff;
      font-size: 12px;
      font-weight: 700;
    }

    .plugin-loading {
      grid-column: 1 / -1;
      padding: 22px;
      border: 1px solid #393447;
      border-radius: 14px;
      color: #aaa5b8;
      background: #1d1a27;
    }

    .plugin-modal {
      max-width: 520px;
    }

    .plugin-modal__icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 54px;
      height: 54px;
      margin-bottom: 14px;
      border: 1px solid #514875;
      border-radius: 16px;
      background: #302a45;
      font-size: 27px;
    }

    .plugin-modal h2 {
      margin: 0 0 9px;
    }

    .plugin-modal__lead {
      color: #c7c1d7;
      line-height: 1.55;
    }

    .plugin-notice {
      margin: 17px 0;
      padding: 15px;
      border: 1px solid #514875;
      border-radius: 12px;
      background: #242033;
      color: #e9e4f7;
      line-height: 1.55;
    }

    .plugin-notice p {
      margin: 9px 0 0;
      color: #b9b2ca;
      font-size: 13px;
    }

    .plugin-modal__muted {
      color: #9690a4;
      font-size: 12px;
      line-height: 1.5;
    }

    .plugin-modal__actions {
      display: grid;
      gap: 10px;
      margin-top: 18px;
    }

    /* Интерфейс интернет-поиска */
    .web-search-modal {
      width: min(680px, 100%);
      max-width: 680px;
    }

    .web-search-form {
      margin-top: 18px;
    }

    .web-search-form label {
      display: block;
      margin-bottom: 8px;
      color: #d8d5e8;
      font-size: 13px;
      font-weight: 650;
    }

    .web-search-input-row {
      display: flex;
      align-items: stretch;
      gap: 9px;
    }

    .web-search-input-row input {
      flex: 1;
      min-width: 0;
      margin: 0 !important;
    }

    .web-search-input-row button {
      flex: 0 0 auto;
      min-width: 88px;
    }

    .web-search-status {
      margin-top: 13px;
      color: #bdb5d1;
      font-size: 13px;
      line-height: 1.5;
    }

    .web-search-answer {
      margin-top: 16px;
      padding: 14px;
      border: 1px solid #514875;
      border-radius: 12px;
      background: #242033;
      line-height: 1.6;
      overflow-wrap: anywhere;
    }

    .web-search-answer:empty,
    .web-search-results:empty {
      display: none;
    }

    .web-search-answer h3,
    .web-search-results h3 {
      margin: 0 0 9px;
      color: #f2efff;
      font-size: 15px;
    }

    .web-search-answer__text p {
      margin: 0 0 9px;
    }

    .web-search-answer__text p:last-child {
      margin-bottom: 0;
    }

    .web-search-results {
      margin-top: 17px;
    }

    .web-search-result {
      margin-top: 9px;
      padding: 13px;
      border: 1px solid #393447;
      border-radius: 11px;
      background: #1d1a27;
    }

    .web-search-result__title {
      color: #c8bdff;
      font-weight: 700;
      line-height: 1.45;
      text-decoration: none;
      overflow-wrap: anywhere;
    }

    .web-search-result__title:hover {
      text-decoration: underline;
    }

    .web-search-result__domain {
      margin-top: 4px;
      color: #8eddb1;
      font-size: 11px;
      overflow-wrap: anywhere;
    }

    .web-search-result__snippet {
      margin: 8px 0 0;
      color: #b9b2ca;
      font-size: 12px;
      line-height: 1.55;
    }

    @media (max-width: 520px) {
      .web-search-input-row {
        flex-direction: column;
      }

      .web-search-input-row button {
        width: 100%;
      }
    }

    .plugin-action-button {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 13px;
      border: 1px solid #454052;
      border-radius: 12px;
      color: #f2efff;
      background: #211e2c;
      text-align: left;
      cursor: pointer;
      transition: border-color .18s ease, background .18s ease;
    }

    .plugin-action-button:hover,
    .plugin-action-button:focus-visible {
      border-color: #8b78ff;
      background: #302a45;
      outline: none;
    }

    .plugin-action-button__icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 42px;
      height: 42px;
      flex: 0 0 42px;
      border-radius: 11px;
      background: #39324f;
      font-size: 21px;
    }

    .plugin-action-button strong,
    .plugin-action-button small {
      display: block;
    }

    .plugin-action-button small {
      margin-top: 4px;
      color: #aaa5b8;
      font-size: 11px;
    }

    .plugin-action-button__arrow {
      margin-left: auto;
      color: #b5a8ff;
      font-size: 24px;
    }

    .page-content textarea {
      display: block;
      width: 100%;
      min-height: 100px;
      margin: 10px 0;
      padding: 12px;
      color: #f2f2f5;
      background: #111116;
      border: 1px solid #3b3949;
      border-radius: 9px;
      resize: vertical;
    }

    .page-content input[type="file"] {
      display: block;
      margin: 12px 0;
      color: #f2f2f5;
    }

    /* Приветственный экран */
    #welcome .suggestions {
      display: none !important;
    }

    /* Кнопка генерации */
    .pinsk-image-mode {
      min-height: 40px;
      padding: 8px 12px;
      flex: 0 0 auto;
      border: 1px solid #514875;
      border-radius: 11px;
      color: #ded8ff;
      background: #292638;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      transition: .2s;
    }

    .pinsk-image-mode:hover,
    .pinsk-image-mode.active {
      background: #51418c;
      border-color: #9c89ff;
      color: #fff;
    }

    /* Предпросмотр вложений */
    #selectedFiles {
      display: none;
      flex-wrap: wrap;
      gap: 9px;
      width: 100%;
      padding: 10px 0;
    }

    .pinsk-attachment-item {
      position: relative;
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 150px;
      max-width: 230px;
      padding: 9px;
      border: 1px solid #454052;
      border-radius: 12px;
      background: #211f2b;
      color: #f1eff8;
    }

    .pinsk-attachment-thumb {
      width: 46px;
      height: 46px;
      flex: 0 0 46px;
      border-radius: 8px;
      object-fit: cover;
    }

    .pinsk-attachment-icon {
      width: 46px;
      height: 46px;
      flex: 0 0 46px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      background: #39324f;
      color: #d9ceff;
      font-size: 11px;
      font-weight: 700;
    }

    .pinsk-attachment-info {
      min-width: 0;
      padding-right: 14px;
    }

    .pinsk-attachment-name {
      overflow: hidden;
      max-width: 135px;
      font-size: 12px;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .pinsk-attachment-size {
      margin-top: 4px;
      color: #aaa5b8;
      font-size: 11px;
    }

    .pinsk-attachment-remove {
      position: absolute;
      top: 3px;
      right: 5px;
      width: 22px;
      height: 22px;
      border: 0;
      border-radius: 50%;
      color: #fff;
      background: #51475e;
      cursor: pointer;
      font-size: 17px;
      line-height: 20px;
    }

    .pinsk-attachment-remove:hover {
      background: #a34461;
    }

    /* Вложения внутри сообщений */
    .pinsk-message-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      margin-top: 9px;
    }

    .pinsk-message-file {
      padding: 7px 10px;
      border: 1px solid #514875;
      border-radius: 9px;
      background: #292638;
      color: #e8e4ff;
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    /* Сгенерированные изображения */
    .pinsk-generated-image {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
      margin-top: 12px;
    }

    .pinsk-generated-image img {
      display: block;
      width: 100%;
      max-width: 640px;
      max-height: 650px;
      object-fit: contain;
      border-radius: 14px;
      background: #17151f;
    }

    .pinsk-image-download {
      display: inline-flex;
      align-items: center;
      padding: 9px 13px;
      border: 1px solid #514875;
      border-radius: 9px;
      color: #e8e4ff;
      background: #292638;
      text-decoration: none;
      font-size: 13px;
    }

    .pinsk-image-download:hover {
      background: #39324f;
    }

    .loading-message {
      opacity: .75;
    }

    /* Мобильная версия */
    @media (max-width: 760px) {
      #selectedFiles {
        gap: 6px;
        padding: 8px 0;
      }

      .pinsk-attachment-item {
        min-width: 0;
        max-width: calc(50% - 4px);
        flex: 1 1 calc(50% - 4px);
      }

      .pinsk-attachment-name {
        max-width: 100px;
      }

      .pinsk-image-mode {
        min-height: 38px;
        padding: 7px 9px;
        font-size: 11px;
      }

      .pinsk-generated-image img {
        max-height: 480px;
      }

      .message-content {
        min-width: 0;
        max-width: 100%;
      }

      .message-text {
        overflow-wrap: anywhere;
      }

      #chatForm {
        gap: 5px;
      }

      #prompt {
        min-width: 0;
      }

      .voice-inline-button {
        width: 38px;
        height: 38px;
        flex-basis: 38px;
        margin: 0 2px;
      }
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

  // Создаём единственный экран Drag & Drop.
  installDragAndDrop();
  installStudioNavigation();

  initEvents();
  installVoiceButton();
  installImageModeButton();
  renderAttachmentPreview();
  updateProfile();

  const authResult = await checkAuth();

  if (authResult === true) {
    await loadUsage();
    await loadHistory();
    renderPage("chat");

  } else if (authResult === false) {
    showAuth("login");

  } else {
    toast("Сервер временно недоступен. Попробуй обновить страницу.");
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
