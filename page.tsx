"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Lang = "ru" | "en" | "kk";
type Message = { role: "user" | "assistant"; content: string };

const translations = {
  ru: {
    newChat: "Новый чат", history: "История", title: "Чем могу помочь?",
    subtitle: "Спроси о чём угодно — Pinsk поможет разобраться.",
    placeholder: "Напишите сообщение Pinsk...", send: "Отправить",
    welcome: "Привет! Я Pinsk. Чем могу помочь?", free: "Бесплатный план",
    upgrade: "Перейти на PRO", language: "Язык", thinking: "Думаю...",
    error: "Не удалось получить ответ. Проверь API-ключ и попробуй ещё раз.",
    footer: "Pinsk может ошибаться. Проверяйте важную информацию.",
    starter1: "Объясни сложную тему простыми словами",
    starter2: "Помоги написать программу",
    starter3: "Составь план обучения"
  },
  en: {
    newChat: "New chat", history: "History", title: "What can I help with?",
    subtitle: "Ask anything — Pinsk will help you figure it out.",
    placeholder: "Message Pinsk...", send: "Send",
    welcome: "Hello! I'm Pinsk. How can I help?", free: "Free plan",
    upgrade: "Upgrade to PRO", language: "Language", thinking: "Thinking...",
    error: "Couldn't get a response. Check your API key and try again.",
    footer: "Pinsk can make mistakes. Check important information.",
    starter1: "Explain a difficult topic simply",
    starter2: "Help me write a program",
    starter3: "Create a learning plan"
  },
  kk: {
    newChat: "Жаңа чат", history: "Тарих", title: "Қалай көмектесе аламын?",
    subtitle: "Кез келген сұрақ қойыңыз — Pinsk көмектеседі.",
    placeholder: "Pinsk-ке хабарлама жазыңыз...", send: "Жіберу",
    welcome: "Сәлем! Мен Pinskпін. Қалай көмектесе аламын?", free: "Тегін жоспар",
    upgrade: "PRO нұсқасына өту", language: "Тіл", thinking: "Ойланып жатырмын...",
    error: "Жауап алу мүмкін болмады. API кілтін тексеріп, қайта көріңіз.",
    footer: "Pinsk қателесуі мүмкін. Маңызды ақпаратты тексеріңіз.",
    starter1: "Күрделі тақырыпты қарапайым түсіндір",
    starter2: "Бағдарлама жазуға көмектес",
    starter3: "Оқу жоспарын жаса"
  }
} satisfies Record<Lang, Record<string, string>>;

export default function Home() {
  const [lang, setLang] = useState<Lang>("ru");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const t = translations[lang];

  useEffect(() => {
    const savedLang = localStorage.getItem("pinsk-language") as Lang | null;
    if (savedLang && ["ru", "en", "kk"].includes(savedLang)) setLang(savedLang);
    const savedHistory = localStorage.getItem("pinsk-history");
    if (savedHistory) setHistory(JSON.parse(savedHistory));
  }, []);

  function changeLanguage(value: Lang) {
    setLang(value);
    localStorage.setItem("pinsk-language", value);
  }

  function newChat() {
    setMessages([]);
  }

  async function sendMessage(event?: FormEvent, preset?: string) {
    event?.preventDefault();
    const text = (preset ?? input).trim();
    if (!text || busy) return;

    const updated: Message[] = [...messages, { role: "user", content: text }];
    setMessages(updated);
    setInput("");
    setBusy(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: updated, language: lang })
      });
      if (!response.ok) throw new Error("Request failed");
      const data = await response.json();
      const answer = String(data.answer ?? "");
      setMessages([...updated, { role: "assistant", content: answer }]);
      const nextHistory = [text, ...history].slice(0, 12);
      setHistory(nextHistory);
      localStorage.setItem("pinsk-history", JSON.stringify(nextHistory));
    } catch {
      setMessages([...updated, { role: "assistant", content: t.error }]);
    } finally {
      setBusy(false);
    }
  }

  const suggestions = useMemo(() => [t.starter1, t.starter2, t.starter3], [lang]);

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">P</span><span>Pinsk</span></div>
        <button className="new-chat" onClick={newChat}>＋ {t.newChat}</button>
        <div className="side-label">{t.history}</div>
        <div className="history-list">
          {history.map((item, i) => <button key={`${item}-${i}`} className="history-item" onClick={() => { setMessages([{role:"user",content:item}]); }}>{item}</button>)}
        </div>
        <div className="sidebar-bottom">
          <div className="plan-card">
            <div className="plan-title">{t.free}</div>
            <div className="plan-sub">Pinsk</div>
            <button className="upgrade" onClick={() => alert("Оплата PRO будет подключена после выбора платёжного провайдера.")}>{t.upgrade} ↗</button>
          </div>
          <label className="language-label" htmlFor="language">{t.language}</label>
          <select id="language" className="language-select" value={lang} onChange={e => changeLanguage(e.target.value as Lang)}>
            <option value="ru">🇷🇺 Русский</option>
            <option value="en">🇬🇧 English</option>
            <option value="kk">🇰🇿 Қазақша</option>
          </select>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark">P</span> Pinsk</div>
          <span className="model-pill"><span className="status-dot" /> Pinsk AI</span>
          <button className="top-new" onClick={newChat}>＋ {t.newChat}</button>
        </header>

        <div className="conversation">
          {messages.length === 0 ? (
            <div className="empty-state">
              <div className="hero-mark">P</div>
              <h1>{t.title}</h1>
              <p>{t.subtitle}</p>
              <div className="suggestions">
                {suggestions.map(s => <button key={s} onClick={() => sendMessage(undefined, s)}>{s}<span>↗</span></button>)}
              </div>
            </div>
          ) : (
            <div className="messages">
              {messages.map((m, i) => (
                <div className={`message-row ${m.role}`} key={i}>
                  <div className="avatar">{m.role === "user" ? "Вы" : "P"}</div>
                  <div className="message-content">{m.content}</div>
                </div>
              ))}
              {busy && <div className="thinking">{t.thinking}</div>}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <form className="composer" onSubmit={sendMessage}>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              placeholder={t.placeholder}
              rows={1}
            />
            <button className="send-button" type="submit" disabled={!input.trim() || busy} aria-label={t.send}>↑</button>
          </form>
          <div className="disclaimer">{t.footer}</div>
        </div>
      </section>
    </main>
  );
}
