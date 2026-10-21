import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

const conversation = document.getElementById("conversation");
const welcome = document.getElementById("welcome");
const form = document.getElementById("composer");
const input = document.getElementById("question");
const sendButton = document.getElementById("send");
const stopButton = document.getElementById("stop");
const kbInfo = document.getElementById("kb-info");
const banner = document.getElementById("mode-banner");
const announcer = document.getElementById("announcer");

// The conversation as plain-text turns. The server keeps no state: each question sends the
// whole history, which alternates user and assistant turns and ends with the user.
let history = [];
// In Claude Code mode the server continues this session, so the model keeps the whole chat.
let sessionId = null;
let controller = null;
let chatId = 0;

// Links in answers open in a new tab.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

function renderMarkdown(markdown) {
  return DOMPurify.sanitize(marked.parse(markdown));
}

// When the assistant asks a question it ends with a line like [[options: Warehouse | Office]],
// which the page shows as answer buttons instead of text.
const OPTIONS_LINE = /\[\[options:([^\]]*)\]\]/i;

/** The answer without its options line, including one that is still streaming in. */
function visibleText(text) {
  return text
    .replace(/\[\[options:[^\]]*(\]\]|$)/gi, "")
    .replace(/\[\[?[a-z:]*$/i, "")
    .trimEnd();
}

function addQuickReplies(messageEl, text) {
  const match = OPTIONS_LINE.exec(text);
  if (!match) return;
  const options = match[1]
    .split("|")
    .map((option) => option.trim())
    .filter(Boolean)
    .slice(0, 6);
  const row = document.createElement("div");
  row.className = "quick-replies";
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = option;
    button.addEventListener("click", () => {
      if (!controller) ask(option);
    });
    row.append(button);
  }
  messageEl.append(row);
}

async function loadInfo() {
  try {
    const info = await (await fetch("/api/info")).json();
    const collected = new Date(info.builtAt).toLocaleDateString(undefined, { dateStyle: "medium" });
    kbInfo.textContent =
      `${info.documents} documents from ${new URL(info.source).host}, collected ${collected}` +
      (info.mode === "search" ? "" : ` · Answered by ${info.note}`);
    if (info.mode === "search") {
      banner.textContent = `Search-only mode: ${info.note}. Until then, answers list the best-matching pages instead of a written reply.`;
      banner.hidden = false;
    }
  } catch {
    kbInfo.textContent = "Couldn't load the knowledge base details.";
  }
}

function addMessage(role) {
  const el = document.createElement("article");
  el.className = `message ${role}`;
  const body = document.createElement("div");
  body.className = "body";
  el.append(body);
  conversation.append(el);
  return { el, body };
}

function addNote(messageEl, text, kind = "") {
  const note = document.createElement("p");
  note.className = kind ? `note ${kind}` : "note";
  note.textContent = text;
  messageEl.append(note);
}

function nearBottom() {
  return conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 80;
}

function scrollToBottom() {
  conversation.scrollTop = conversation.scrollHeight;
}

/** Yields { event, data } for each server-sent event in a response body. */
async function* readEvents(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

function setBusy(busy) {
  sendButton.hidden = busy;
  stopButton.hidden = !busy;
}

async function ask(question) {
  const thisChat = chatId;
  welcome.hidden = true;
  for (const row of conversation.querySelectorAll(".quick-replies")) row.remove();
  history.push({ role: "user", content: question });
  addMessage("user").body.textContent = question;
  const reply = addMessage("assistant");
  reply.el.setAttribute("aria-busy", "true");
  reply.body.innerHTML =
    '<span class="typing" role="status" aria-label="Typing"><span></span><span></span><span></span></span>';
  scrollToBottom();
  setBusy(true);
  controller = new AbortController();

  let text = "";
  let failed = false;
  let frame = 0;
  const render = () => {
    frame = 0;
    const follow = nearBottom();
    reply.body.innerHTML = renderMarkdown(visibleText(text));
    if (follow) scrollToBottom();
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history, sessionId }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Server error ${res.status}`);
    for await (const { event, data } of readEvents(res.body)) {
      if (event === "delta") {
        text += data.text;
        frame ||= requestAnimationFrame(render);
      } else if (event === "refusal") {
        // Partial text before a refusal isn't a complete answer, so it's dropped.
        text = "";
        failed = true;
        addNote(reply.el, data.text, "error");
      } else if (event === "notice") {
        addNote(reply.el, data.text);
      } else if (event === "done") {
        if (data.sessionId && thisChat === chatId) sessionId = data.sessionId;
      } else if (event === "error") {
        throw new Error(data.message);
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      addNote(reply.el, "Stopped.");
    } else {
      failed = true;
      addNote(reply.el, err.message, "error");
    }
    // The session may not hold this turn; the next message starts a new one with the chat so far.
    if (thisChat === chatId) sessionId = null;
  } finally {
    cancelAnimationFrame(frame);
    render();
    reply.el.removeAttribute("aria-busy");
    if (thisChat === chatId) {
      setBusy(false);
      controller = null;
    }
  }

  if (thisChat !== chatId) return; // A new chat started while this answer was streaming.
  if (text.trim()) {
    history.push({ role: "assistant", content: text });
    addQuickReplies(reply.el, text);
    announcer.textContent = "Answer ready.";
  } else {
    // Nothing to keep: drop the question so the history still alternates.
    history.pop();
    reply.body.remove();
    if (failed && !input.value) input.value = question;
  }
}

function resizeInput() {
  input.style.height = "auto";
  // scrollHeight leaves out the border, which the border-box height includes.
  const border = input.offsetHeight - input.clientHeight;
  input.style.height = `${Math.min(input.scrollHeight + border, 200)}px`;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = input.value.trim();
  if (!question || controller) return;
  input.value = "";
  resizeInput();
  ask(question);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
input.addEventListener("input", resizeInput);

stopButton.addEventListener("click", () => controller?.abort());

document.getElementById("new-chat").addEventListener("click", () => {
  controller?.abort();
  controller = null;
  chatId++;
  history = [];
  sessionId = null;
  setBusy(false);
  for (const el of conversation.querySelectorAll(".message")) el.remove();
  welcome.hidden = false;
  input.focus();
});

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    if (!controller) ask(chip.textContent.trim());
  });
}

loadInfo();
input.focus();
