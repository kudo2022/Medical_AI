const state = {
  topic: "Tự do",
  history: [],
  isLoading: false,
  isUploadingPdf: false,
  pdf: null,
  pdfFile: null,
};

const els = {
  clearChatBtn: document.getElementById("clearChatBtn"),
  topicChips: document.getElementById("topicChips"),
  chatContainer: document.getElementById("chatContainer"),
  emptyState: document.getElementById("emptyState"),
  messagesList: document.getElementById("messagesList"),
  pdfBar: document.getElementById("pdfBar"),
  pdfName: document.getElementById("pdfName"),
  pdfMeta: document.getElementById("pdfMeta"),
  pdfQuickSummaryBtn: document.getElementById("pdfQuickSummaryBtn"),
  pdfQuickQuizBtn: document.getElementById("pdfQuickQuizBtn"),
  removePdfBtn: document.getElementById("removePdfBtn"),
  pdfInput: document.getElementById("pdfInput"),
  uploadPdfBtn: document.getElementById("uploadPdfBtn"),
  questionForm: document.getElementById("questionForm"),
  questionInput: document.getElementById("questionInput"),
  sendBtn: document.getElementById("sendBtn"),
  charCount: document.getElementById("charCount"),
};

function getBackendUrl() {
  const { protocol, hostname, port, origin } = window.location;
  // Khi chạy tách 2 terminal local (frontend port 3000, backend port 8000) hoặc mở file://
  if (protocol === "file:" || ((hostname === "localhost" || hostname === "127.0.0.1") && port === "3000")) {
    return "http://127.0.0.1:8000";
  }
  // Khi deploy chung trên Render hoặc truy cập trực tiếp qua FastAPI
  return origin.replace(/\/+$/, "");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderFallbackMathHtml(rawExpr) {
  let s = escapeHtml(rawExpr.trim());

  // Thay thế các ký hiệu LaTeX thông dụng khi không tải được CDN KaTeX
  const symbolMap = [
    [/\\times/g, "×"],
    [/\\cdot/g, "·"],
    [/\\pm/g, "±"],
    [/\\le(?:q)?\b/g, "≤"],
    [/\\ge(?:q)?\b/g, "≥"],
    [/\\ne(?:q)?\b/g, "≠"],
    [/\\approx/g, "≈"],
    [/\\rightarrow|\\to\b/g, "→"],
    [/\\leftarrow/g, "←"],
    [/\\leftrightarrow/g, "↔"],
    [/\\alpha\b/g, "α"],
    [/\\beta\b/g, "β"],
    [/\\gamma\b/g, "γ"],
    [/\\delta\b/g, "δ"],
    [/\\Delta\b/g, "Δ"],
    [/\\mu\b/g, "μ"],
    [/\\pi\b/g, "π"],
    [/\\infty\b/g, "∞"],
    [/\\left|\\right/g, ""],
    [/\\,/g, " "],
    [/\\;/g, " "],
    [/\\quad/g, "  "],
  ];
  for (const [pattern, replacement] of symbolMap) {
    s = s.replace(pattern, replacement);
  }

  s = s.replace(/\\(?:text|mathrm|mathbf|operatorname)\{([^{}]+)\}/g, "$1");
  s = s.replace(/_\{([^{}]+)\}/g, "<sub>$1</sub>");
  s = s.replace(/\^\{([^{}]+)\}/g, "<sup>$1</sup>");
  s = s.replace(/_([A-Za-z0-9+-])/g, "<sub>$1</sub>");
  s = s.replace(/\^([A-Za-z0-9+-])/g, "<sup>$1</sup>");

  // Chuyển \frac{tu}{mau} thành phân số dựng đứng
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s.replace(
      /\\(?:d|t)?frac\{([^{}]+)\}\{([^{}]+)\}/g,
      '<span class="math-frac"><span class="math-frac-num">$1</span><span class="math-frac-den">$2</span></span>'
    );
  }

  return s;
}

function renderMath(expr, displayMode = false) {
  const clean = String(expr || "").trim();
  if (!clean) return "";

  if (window.katex && typeof window.katex.renderToString === "function") {
    try {
      const html = window.katex.renderToString(clean, {
        displayMode,
        throwOnError: false,
        strict: false,
      });
      return displayMode
        ? `<div class="math-block">${html}</div>`
        : `<span class="math-inline">${html}</span>`;
    } catch {
      // Fall through to built-in HTML renderer
    }
  }

  const fallbackHtml = renderFallbackMathHtml(clean);
  return displayMode
    ? `<div class="math-block math-fallback">${fallbackHtml}</div>`
    : `<span class="math-inline math-fallback">${fallbackHtml}</span>`;
}

function formatInlineMarkdown(line) {
  const tokens = [];
  const stash = (htmlSnippet) => {
    const idx = tokens.length;
    tokens.push(htmlSnippet);
    return `@@TOK_${idx}@@`;
  };

  let raw = String(line || "");

  // 1. Bảo vệ inline code trước (LaTeX trong backtick giữ nguyên dạng code)
  raw = raw.replace(/`([^`]+)`/g, (_, code) => stash(`<code>${escapeHtml(code)}</code>`));

  // 2. Render công thức LaTeX trong dòng: \(...\), \[...\], $$...$$, $...$
  raw = raw.replace(/\\\((.+?)\\\)/g, (_, expr) => stash(renderMath(expr, false)));
  raw = raw.replace(/\\\[(.+?)\\\]/g, (_, expr) => stash(renderMath(expr, true)));
  raw = raw.replace(/(?<!\\)\$\$(.+?)(?<!\\)\$\$/g, (_, expr) => stash(renderMath(expr, false)));
  raw = raw.replace(/(?<!\\)\$(?!\s)((?:[^$\\\n]|\\.)+?)(?<!\s)\$/g, (match, expr) => {
    // Tránh nhầm giá tiền đơn thuần như "$7/tháng" hoặc "$100"
    if (/^\d[\d.,]*$/.test(expr.trim())) {
      return match;
    }
    return stash(renderMath(expr, false));
  });

  // 3. Escape phần văn bản thường và định dạng đậm/nghiêng
  let html = escapeHtml(raw);
  html = html.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  // 4. Khôi phục code và công thức đã render an toàn
  html = html.replace(/@@TOK_(\d+)@@/g, (_, idx) => tokens[Number(idx)] || "");
  return html;
}

function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (trimmed[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += trimmed[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

function isTableSeparator(line) {
  if (!line.includes("|")) return false;
  const cells = splitTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseTableAlignments(line) {
  return splitTableRow(line).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

function renderMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const output = [];
  let inUl = false;
  let inOl = false;
  let inCodeBlock = false;
  let codeLines = [];
  let inMathBlock = null; // "bracket" (\[...\]) | "dollar" ($$...$$)
  let mathLines = [];
  let quoteLines = [];

  const closeLists = () => {
    if (inUl) {
      output.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      output.push("</ol>");
      inOl = false;
    }
  };

  const flushQuote = () => {
    if (quoteLines.length > 0) {
      const inner = quoteLines.map((q) => `<p>${formatInlineMarkdown(q)}</p>`).join("");
      output.push(`<blockquote>${inner}</blockquote>`);
      quoteLines = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    // Fenced code block
    if (!inMathBlock && line.startsWith("```")) {
      closeLists();
      flushQuote();
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLines = [];
      } else {
        output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        inCodeBlock = false;
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    // Đang ở trong block công thức nhiều dòng (\[ ... \] hoặc $$ ... $$)
    if (inMathBlock === "bracket") {
      if (line.endsWith("\\]")) {
        const beforeClose = line.slice(0, -2).trim();
        if (beforeClose) mathLines.push(beforeClose);
        output.push(renderMath(mathLines.join("\n"), true));
        inMathBlock = null;
        mathLines = [];
      } else {
        mathLines.push(rawLine);
      }
      continue;
    }

    if (inMathBlock === "dollar") {
      if (line.endsWith("$$")) {
        const beforeClose = line.slice(0, -2).trim();
        if (beforeClose) mathLines.push(beforeClose);
        output.push(renderMath(mathLines.join("\n"), true));
        inMathBlock = null;
        mathLines = [];
      } else {
        mathLines.push(rawLine);
      }
      continue;
    }

    // Mở block công thức dạng \[ ... \] (1 dòng hoặc nhiều dòng)
    if (line.startsWith("\\[")) {
      closeLists();
      flushQuote();
      if (line.endsWith("\\]") && line.length > 4) {
        output.push(renderMath(line.slice(2, -2), true));
      } else {
        inMathBlock = "bracket";
        mathLines = [];
        const afterOpen = line.slice(2).trim();
        if (afterOpen) mathLines.push(afterOpen);
      }
      continue;
    }

    // Mở block công thức dạng $$ ... $$ (1 dòng hoặc nhiều dòng)
    if (line.startsWith("$$")) {
      closeLists();
      flushQuote();
      if (line.endsWith("$$") && line.length > 4) {
        output.push(renderMath(line.slice(2, -2), true));
      } else {
        inMathBlock = "dollar";
        mathLines = [];
        const afterOpen = line.slice(2).trim();
        if (afterOpen) mathLines.push(afterOpen);
      }
      continue;
    }

    if (!line) {
      closeLists();
      flushQuote();
      continue;
    }

    // Markdown table: header + separator + rows
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1].trim())
    ) {
      closeLists();
      flushQuote();

      const headers = splitTableRow(line);
      const alignments = parseTableAlignments(lines[i + 1].trim());
      i += 2;

      const rows = [];
      while (i < lines.length) {
        const rowLine = lines[i].trim();
        if (!rowLine || !rowLine.includes("|")) {
          i -= 1;
          break;
        }
        rows.push(splitTableRow(rowLine));
        i += 1;
      }

      const thHtml = headers
        .map((cell, idx) => {
          const align = alignments[idx] || "left";
          const style = align !== "left" ? ` style="text-align:${align}"` : "";
          return `<th${style}>${formatInlineMarkdown(cell)}</th>`;
        })
        .join("");

      const bodyHtml = rows
        .map((cells) => {
          const tdHtml = headers
            .map((_, idx) => {
              const align = alignments[idx] || "left";
              const style = align !== "left" ? ` style="text-align:${align}"` : "";
              return `<td${style}>${formatInlineMarkdown(cells[idx] || "")}</td>`;
            })
            .join("");
          return `<tr>${tdHtml}</tr>`;
        })
        .join("");

      output.push(
        `<div class="table-wrap"><table><thead><tr>${thHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`
      );
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      closeLists();
      flushQuote();
      output.push("<hr />");
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      closeLists();
      flushQuote();
      const level = Math.min(headingMatch[1].length + 1, 4);
      output.push(`<h${level}>${formatInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    // Blockquote
    if (line.startsWith("> ") || line === ">") {
      closeLists();
      quoteLines.push(line.replace(/^>\s?/, ""));
      continue;
    }

    flushQuote();

    // Unordered list
    const ulMatch = line.match(/^[-*•]\s+(.*)$/);
    if (ulMatch) {
      if (inOl) {
        output.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        output.push("<ul>");
        inUl = true;
      }
      output.push(`<li>${formatInlineMarkdown(ulMatch[1])}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^\d+\.\s+(.*)$/);
    if (olMatch) {
      if (inUl) {
        output.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        output.push("<ol>");
        inOl = true;
      }
      output.push(`<li>${formatInlineMarkdown(olMatch[1])}</li>`);
      continue;
    }

    closeLists();
    output.push(`<p>${formatInlineMarkdown(line)}</p>`);
  }

  if (inCodeBlock && codeLines.length > 0) {
    output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  if (inMathBlock && mathLines.length > 0) {
    output.push(renderMath(mathLines.join("\n"), true));
  }
  closeLists();
  flushQuote();
  return output.join("\n");
}

function isNearBottom(threshold = 120) {
  const { scrollTop, scrollHeight, clientHeight } = els.chatContainer;
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

function scrollToBottom(force = true) {
  if (force || isNearBottom()) {
    els.chatContainer.scrollTop = els.chatContainer.scrollHeight;
  }
}

function appendUserMessage(text, topic, pdfName = "") {
  els.emptyState.classList.add("hidden");

  const wrapper = document.createElement("article");
  wrapper.className = "message user";
  const pdfBadgeHtml = pdfName
    ? `<div class="user-pdf-badge" title="${escapeHtml(pdfName)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${escapeHtml(pdfName)}</span></div><div>${escapeHtml(text)}</div>`
    : escapeHtml(text);

  wrapper.innerHTML = `
    <div class="message-meta">
      <span>Bạn</span>
      <span>•</span>
      <span>${escapeHtml(topic)}</span>
    </div>
    <div class="bubble">${pdfBadgeHtml}</div>
  `;
  els.messagesList.appendChild(wrapper);
  scrollToBottom();
}

function appendLoadingMessage() {
  const wrapper = document.createElement("article");
  wrapper.className = "message assistant";
  wrapper.id = "loadingMessage";
  wrapper.innerHTML = `
    <div class="message-meta">
      <span>MedStudy AI</span>
    </div>
    <div class="bubble">
      <div class="typing-indicator">
        <span class="typing-dots"><span></span><span></span><span></span></span>
        <span>Đang xử lý câu hỏi...</span>
      </div>
    </div>
  `;
  els.messagesList.appendChild(wrapper);
  scrollToBottom();
  return wrapper;
}

function appendAssistantMessage(answer, meta = {}) {
  const wrapper = document.createElement("article");
  wrapper.className = "message assistant";

  const tokenText =
    meta.usage && meta.usage.total_tokens
      ? `${meta.usage.total_tokens} tokens`
      : "";
  const modelText = meta.model ? `Model: ${meta.model}` : "";
  const infoText = [modelText, tokenText].filter(Boolean).join(" • ");

  wrapper.innerHTML = `
    <div class="message-meta">
      <span>MedStudy AI</span>
    </div>
    <div class="bubble">
      <div class="markdown-body">${renderMarkdown(answer)}</div>
      <div class="assistant-footer">
        <span>${escapeHtml(infoText)}</span>
        <button type="button" class="copy-btn">Sao chép</button>
      </div>
    </div>
  `;

  const copyBtn = wrapper.querySelector(".copy-btn");
  copyBtn.addEventListener("click", async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(answer);
      } else {
        const temp = document.createElement("textarea");
        temp.value = answer;
        temp.style.position = "fixed";
        temp.style.opacity = "0";
        document.body.appendChild(temp);
        temp.select();
        document.execCommand("copy");
        temp.remove();
      }
      copyBtn.textContent = "Đã sao chép";
      setTimeout(() => {
        copyBtn.textContent = "Sao chép";
      }, 1600);
    } catch {
      copyBtn.textContent = "Không sao chép được";
    }
  });

  els.messagesList.appendChild(wrapper);
  scrollToBottom();
}

function appendErrorMessage(message) {
  const wrapper = document.createElement("article");
  wrapper.className = "message error";
  wrapper.innerHTML = `
    <div class="message-meta"><span>Thông báo lỗi</span></div>
    <div class="bubble">${escapeHtml(message)}</div>
  `;
  els.messagesList.appendChild(wrapper);
  scrollToBottom();
}

function autoResizeTextarea() {
  els.questionInput.style.height = "auto";
  els.questionInput.style.height = `${Math.min(els.questionInput.scrollHeight, 160)}px`;

  const len = els.questionInput.value.length;
  if (len >= 3000) {
    els.charCount.textContent = `${len}/4000`;
    els.charCount.classList.remove("hidden");
  } else {
    els.charCount.classList.add("hidden");
  }
}

function extractErrorDetail(data, status) {
  if (typeof data.detail === "string" && data.detail.trim()) {
    return data.detail;
  }
  if (Array.isArray(data.detail) && data.detail.length > 0) {
    const msgs = data.detail
      .map((item) => (item && item.msg ? String(item.msg) : ""))
      .filter(Boolean);
    if (msgs.length > 0) return msgs.join("; ");
  }
  return `Backend trả về lỗi HTTP ${status}.`;
}

function formatCharCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K ký tự`;
  return `${n} ký tự`;
}

function renderPdfBar() {
  if (state.isUploadingPdf) {
    els.pdfBar.classList.remove("hidden");
    els.pdfBar.classList.add("uploading");
    els.pdfQuickSummaryBtn.disabled = true;
    els.pdfQuickQuizBtn.disabled = true;
    els.uploadPdfBtn.disabled = true;
    return;
  }

  els.pdfBar.classList.remove("uploading");
  els.uploadPdfBtn.disabled = state.isLoading;

  if (!state.pdf) {
    els.pdfBar.classList.add("hidden");
    els.uploadPdfBtn.classList.remove("has-file");
    return;
  }

  els.pdfBar.classList.remove("hidden");
  els.uploadPdfBtn.classList.add("has-file");
  els.pdfName.textContent = state.pdf.filename;
  els.pdfName.title = state.pdf.filename;

  const metaParts = [`${state.pdf.pages} trang`];
  if (state.pdf.mode === "vision") {
    metaParts.push("Đọc hình ảnh/scan");
  } else {
    metaParts.push(formatCharCount(state.pdf.char_count));
    if (state.pdf.truncated) {
      metaParts.push("đã lấy phần đầu");
    }
  }
  els.pdfMeta.textContent = metaParts.join(" • ");
  els.pdfQuickSummaryBtn.disabled = state.isLoading;
  els.pdfQuickQuizBtn.disabled = state.isLoading;
}

function clearPdfAttachment() {
  state.pdf = null;
  state.pdfFile = null;
  els.pdfInput.value = "";
  renderPdfBar();
}

async function uploadPdfToServer(file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${getBackendUrl()}/api/upload-pdf`, {
    method: "POST",
    body: formData,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(extractErrorDetail(data, response.status));
  }

  return {
    pdf_id: data.pdf_id,
    filename: data.filename || file.name,
    pages: data.pages || 1,
    char_count: data.char_count || 0,
    truncated: Boolean(data.truncated),
    mode: data.mode || "text",
  };
}

async function handlePdfFile(file) {
  if (!file || state.isUploadingPdf || state.isLoading) return;

  if (!file.name.toLowerCase().endsWith(".pdf")) {
    els.emptyState.classList.add("hidden");
    appendErrorMessage("Vui lòng chỉ chọn file định dạng .pdf.");
    return;
  }

  if (file.size > 15 * 1024 * 1024) {
    els.emptyState.classList.add("hidden");
    appendErrorMessage("File PDF vượt quá giới hạn 15 MB. Vui lòng chọn file nhỏ hơn.");
    return;
  }

  state.isUploadingPdf = true;
  els.pdfName.textContent = file.name;
  els.pdfMeta.textContent = "Đang đọc tài liệu PDF...";
  renderPdfBar();

  try {
    state.pdf = await uploadPdfToServer(file);
    state.pdfFile = file;
    els.questionInput.focus();
  } catch (err) {
    els.emptyState.classList.add("hidden");
    appendErrorMessage(
      (err && err.message) ||
        `Không thể tải lên file PDF tới máy chủ tại ${getBackendUrl()}. Vui lòng thử lại.`
    );
  } finally {
    state.isUploadingPdf = false;
    els.pdfInput.value = "";
    renderPdfBar();
  }
}

function attachCopyHandler(copyBtn, getText) {
  copyBtn.addEventListener("click", async () => {
    const text = getText();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const temp = document.createElement("textarea");
        temp.value = text;
        temp.style.position = "fixed";
        temp.style.opacity = "0";
        document.body.appendChild(temp);
        temp.select();
        document.execCommand("copy");
        temp.remove();
      }
      copyBtn.textContent = "Đã sao chép";
      setTimeout(() => {
        copyBtn.textContent = "Sao chép";
      }, 1600);
    } catch {
      copyBtn.textContent = "Không sao chép được";
    }
  });
}

function upgradeLoadingToStreamingBubble(loadingNode) {
  loadingNode.removeAttribute("id");
  const bubble = loadingNode.querySelector(".bubble");
  bubble.innerHTML = `
    <div class="markdown-body streaming"></div>
    <div class="assistant-footer hidden">
      <span class="assistant-info"></span>
      <button type="button" class="copy-btn">Sao chép</button>
    </div>
  `;
  return {
    bodyEl: bubble.querySelector(".markdown-body"),
    footerEl: bubble.querySelector(".assistant-footer"),
    infoEl: bubble.querySelector(".assistant-info"),
    copyBtn: bubble.querySelector(".copy-btn"),
  };
}

async function fetchStreamResponse(requestBody, allowReupload = true) {
  const response = await fetch(`${getBackendUrl()}/api/ask/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  // Nếu Render vừa khởi động lại làm hết hạn cache PDF, tự động tải lại file từ trình duyệt 1 lần
  if (response.status === 410 && allowReupload && state.pdfFile) {
    const refreshed = await uploadPdfToServer(state.pdfFile);
    state.pdf = refreshed;
    renderPdfBar();
    return fetchStreamResponse({ ...requestBody, pdf_id: refreshed.pdf_id }, false);
  }

  return response;
}

async function submitQuestion(rawQuestion) {
  let question = rawQuestion.trim();
  if (state.isLoading || state.isUploadingPdf) return;
  if (!question && state.pdf) {
    question = "Hãy tóm tắt có hệ thống các kiến thức trọng tâm trong tài liệu PDF đính kèm.";
  }
  if (!question) return;

  const attachedPdf = state.pdf;

  state.isLoading = true;
  els.sendBtn.disabled = true;
  renderPdfBar();
  els.questionInput.value = "";
  autoResizeTextarea();

  appendUserMessage(question, state.topic, attachedPdf ? attachedPdf.filename : "");
  const loadingNode = appendLoadingMessage();

  try {
    const requestBody = {
      question,
      topic: state.topic,
      history: state.history,
    };
    if (attachedPdf && attachedPdf.pdf_id) {
      requestBody.pdf_id = attachedPdf.pdf_id;
    }

    const response = await fetchStreamResponse(requestBody, true);

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      loadingNode.remove();
      const detail =
        data.detail === "PDF_EXPIRED"
          ? "Phiên tài liệu PDF trên máy chủ đã hết hạn. Vui lòng tải lên lại file PDF."
          : extractErrorDetail(data, response.status);
      appendErrorMessage(detail);
      return;
    }

    if (!response.body) {
      loadingNode.remove();
      appendErrorMessage("Trình duyệt không hỗ trợ streaming phản hồi.");
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullAnswer = "";
    let streamUI = null;
    let renderScheduled = false;
    let doneMeta = null;
    let streamError = null;

    const flushRender = () => {
      renderScheduled = false;
      if (!streamUI) return;
      const shouldStick = isNearBottom(140);
      streamUI.bodyEl.innerHTML = renderMarkdown(fullAnswer);
      if (shouldStick) scrollToBottom(true);
    };

    const processEventBlock = (rawBlock) => {
      const lines = rawBlock.split("\n");
      let eventName = "message";
      const dataLines = [];
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }
      if (dataLines.length === 0) return;

      let payload;
      try {
        payload = JSON.parse(dataLines.join("\n"));
      } catch {
        return;
      }

      if (eventName === "delta" && payload.text) {
        if (!streamUI) {
          streamUI = upgradeLoadingToStreamingBubble(loadingNode);
        }
        fullAnswer += payload.text;
        if (!renderScheduled) {
          renderScheduled = true;
          requestAnimationFrame(flushRender);
        }
      } else if (eventName === "done") {
        doneMeta = payload;
      } else if (eventName === "error") {
        streamError = payload.detail || "Đã xảy ra lỗi khi nhận phản hồi.";
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        if (block.trim()) processEventBlock(block);
      }
    }
    if (buffer.trim()) {
      processEventBlock(buffer);
    }

    if (streamError) {
      if (!fullAnswer) {
        loadingNode.remove();
      } else if (streamUI) {
        streamUI.bodyEl.classList.remove("streaming");
      }
      appendErrorMessage(streamError);
      return;
    }

    if (!fullAnswer.trim()) {
      loadingNode.remove();
      appendErrorMessage("Không nhận được nội dung câu trả lời từ máy chủ.");
      return;
    }

    if (!streamUI) {
      streamUI = upgradeLoadingToStreamingBubble(loadingNode);
    }
    streamUI.bodyEl.classList.remove("streaming");
    streamUI.bodyEl.innerHTML = renderMarkdown(fullAnswer);

    const tokenText =
      doneMeta && doneMeta.usage && doneMeta.usage.total_tokens
        ? `${doneMeta.usage.total_tokens} tokens`
        : "";
    const modelText = doneMeta && doneMeta.model ? `Model: ${doneMeta.model}` : "";
    streamUI.infoEl.textContent = [modelText, tokenText].filter(Boolean).join(" • ");
    streamUI.footerEl.classList.remove("hidden");
    attachCopyHandler(streamUI.copyBtn, () => fullAnswer);
    scrollToBottom(false);

    state.history.push(
      { role: "user", content: question },
      { role: "assistant", content: fullAnswer }
    );
  } catch (err) {
    loadingNode.remove();
    appendErrorMessage(
      (err && err.message && !String(err.message).includes("Failed to fetch"))
        ? err.message
        : `Không thể kết nối đến máy chủ tại ${getBackendUrl()}. Vui lòng thử lại sau.`
    );
  } finally {
    state.isLoading = false;
    els.sendBtn.disabled = false;
    renderPdfBar();
    els.questionInput.focus();
  }
}

// Event listeners
els.uploadPdfBtn.addEventListener("click", () => {
  if (state.isLoading || state.isUploadingPdf) return;
  els.pdfInput.click();
});

els.pdfInput.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) handlePdfFile(file);
});

els.removePdfBtn.addEventListener("click", () => {
  if (state.isUploadingPdf) return;
  clearPdfAttachment();
  els.questionInput.focus();
});

els.pdfQuickSummaryBtn.addEventListener("click", () => {
  if (!state.pdf) return;
  submitQuestion("Hãy tóm tắt có hệ thống các kiến thức trọng tâm trong tài liệu PDF đính kèm.");
});

els.pdfQuickQuizBtn.addEventListener("click", () => {
  if (!state.pdf) return;
  submitQuestion(
    "Hãy tạo 5 câu hỏi trắc nghiệm ôn tập (kèm đáp án và giải thích ngắn gọn) dựa trên tài liệu PDF đính kèm."
  );
});

["dragenter", "dragover"].forEach((evtName) => {
  els.questionForm.addEventListener(evtName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    els.questionForm.classList.add("drag-over");
  });
});

["dragleave", "drop"].forEach((evtName) => {
  els.questionForm.addEventListener(evtName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    els.questionForm.classList.remove("drag-over");
  });
});

els.questionForm.addEventListener("drop", (event) => {
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) handlePdfFile(file);
});

els.clearChatBtn.addEventListener("click", () => {
  if (state.isLoading || state.isUploadingPdf) return;
  state.history = [];
  clearPdfAttachment();
  els.messagesList.innerHTML = "";
  els.emptyState.classList.remove("hidden");
  els.questionInput.focus();
});

function setActiveTopic(topic) {
  const nextTopic = topic || "Tự do";
  state.topic = nextTopic;
  els.topicChips.querySelectorAll(".chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.topic === nextTopic);
  });
  document.querySelectorAll(".spec-card").forEach((card) => {
    card.classList.toggle("is-selected", card.dataset.specTopic === nextTopic);
  });
  els.questionInput.placeholder =
    nextTopic === "Tự do"
      ? "Hỏi bài y khoa hoặc kéo thả PDF..."
      : `Hỏi bài môn ${nextTopic} hoặc kéo thả PDF...`;
}

els.topicChips.addEventListener("click", (event) => {
  const btn = event.target.closest(".chip");
  if (!btn) return;
  setActiveTopic(btn.dataset.topic || "Tự do");
});

document.querySelectorAll(".sample-card").forEach((card) => {
  card.addEventListener("click", () => {
    const topic = card.dataset.topic;
    const question = card.dataset.question;
    if (topic) setActiveTopic(topic);
    if (question) submitQuestion(question);
  });
});

// Wire horizontal specialty rail cards directly into the live MedStudy AI studio
document.querySelectorAll(".spec-card").forEach((card) => {
  card.addEventListener("click", () => {
    const topic = card.dataset.specTopic || "Tự do";
    const starterQuestion = (card.dataset.specQuestion || "").trim();
    setActiveTopic(topic);

    const studioEl = document.getElementById("studio");
    if (studioEl) {
      studioEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    if (starterQuestion && !els.questionInput.value.trim()) {
      els.questionInput.value = starterQuestion;
      autoResizeTextarea();
    }
    setTimeout(() => {
      els.questionInput.focus({ preventScroll: true });
    }, 320);
  });
});

els.questionInput.addEventListener("input", autoResizeTextarea);

els.questionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submitQuestion(els.questionInput.value);
  }
});

els.questionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitQuestion(els.questionInput.value);
});

/* ============================================================================
   ScrollCraft Runtime, Preview KaTeX, Particle Field, Pointer Depth & ECG Rail
   ========================================================================== */
function renderStaticPreviewFormulas() {
  const heroFormulaEl = document.getElementById("heroPreviewFormula");
  if (heroFormulaEl) {
    heroFormulaEl.innerHTML = renderMath("TI = \\frac{TD_{50}}{ED_{50}}", true);
  }
  const methodFormulaEl = document.getElementById("methodFormula");
  if (methodFormulaEl) {
    methodFormulaEl.innerHTML = renderMath(
      "Cl_{Cr} = \\frac{(140 - \\text{Tuổi}) \\times \\text{Cân nặng}}{72 \\times Scr}",
      true
    );
  }
}

function initParticleField() {
  const canvas = document.getElementById("particleField");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const prefersReduced =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let particles = [];
  let rafId = 0;

  const seedParticles = () => {
    const count = Math.min(72, Math.max(28, Math.floor((width * height) / 24000)));
    particles = [];
    for (let i = 0; i < count; i += 1) {
      const isGreen = i % 3 === 0;
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        r: 1.1 + Math.random() * 1.9,
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.14,
        depth: 0.2 + Math.random() * 0.7,
        color: isGreen ? "rgba(11, 122, 59, 0.24)" : "rgba(15, 31, 78, 0.22)",
      });
    }
  };

  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seedParticles();
    draw(false);
  };

  const draw = (step) => {
    ctx.clearRect(0, 0, width, height);
    const scrollShift = (window.scrollY || 0) * 0.08;

    for (let i = 0; i < particles.length; i += 1) {
      const p = particles[i];
      if (step) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -8) p.x = width + 8;
        if (p.x > width + 8) p.x = -8;
        if (p.y < -8) p.y = height + 8;
        if (p.y > height + 8) p.y = -8;
      }
      const py = (((p.y - scrollShift * p.depth) % (height + 16)) + (height + 16)) % (height + 16) - 8;
      ctx.beginPath();
      ctx.arc(p.x, py, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
    }
  };

  const loop = () => {
    if (document.hidden) {
      rafId = 0;
      return;
    }
    draw(true);
    rafId = requestAnimationFrame(loop);
  };

  resize();
  window.addEventListener("resize", resize, { passive: true });

  if (!prefersReduced) {
    rafId = requestAnimationFrame(loop);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !rafId) {
        rafId = requestAnimationFrame(loop);
      }
    });
  } else {
    window.addEventListener("scroll", () => draw(false), { passive: true });
  }
}

function initHeroPointerDepth() {
  const stage = document.getElementById("heroStage");
  if (!stage) return;

  const canHover =
    window.matchMedia &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!canHover) return;

  const items = Array.from(stage.querySelectorAll("[data-pointer-depth]"));
  if (!items.length) return;

  let targetX = 0;
  let targetY = 0;
  let curX = 0;
  let curY = 0;
  let rafId = 0;

  const animate = () => {
    curX += (targetX - curX) * 0.1;
    curY += (targetY - curY) * 0.1;

    for (let i = 0; i < items.length; i += 1) {
      const el = items[i];
      const depth = parseFloat(el.dataset.pointerDepth || "1");
      const dx = (curX * 12 * depth).toFixed(2);
      const dy = (curY * 9 * depth).toFixed(2);
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    }

    if (Math.abs(targetX - curX) > 0.002 || Math.abs(targetY - curY) > 0.002) {
      rafId = requestAnimationFrame(animate);
    } else {
      rafId = 0;
    }
  };

  stage.addEventListener(
    "pointermove",
    (event) => {
      const rect = stage.getBoundingClientRect();
      targetX = ((event.clientX - rect.left) / Math.max(rect.width, 1) - 0.5) * 2;
      targetY = ((event.clientY - rect.top) / Math.max(rect.height, 1) - 0.5) * 2;
      if (!rafId) rafId = requestAnimationFrame(animate);
    },
    { passive: true }
  );

  stage.addEventListener("pointerleave", () => {
    targetX = 0;
    targetY = 0;
    if (!rafId) rafId = requestAnimationFrame(animate);
  });
}

function initEcgPulseRail() {
  const path = document.getElementById("ecgProgressPath");
  const nodes = Array.from(document.querySelectorAll(".ecg-node"));
  const navLinks = Array.from(document.querySelectorAll(".nav-link"));
  const sections = ["overview", "method", "specialties", "studio"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  let totalLength = 0;
  if (path && typeof path.getTotalLength === "function") {
    totalLength = path.getTotalLength();
    path.style.strokeDasharray = `${totalLength}`;
    path.style.strokeDashoffset = `${totalLength}`;
  }

  let rafId = 0;
  const update = () => {
    rafId = 0;
    const maxScroll = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
    const progress = Math.min(1, Math.max(0, (window.scrollY || 0) / maxScroll));

    if (path && totalLength > 0) {
      const shown = Math.max(0.06, progress);
      path.style.strokeDashoffset = `${(totalLength * (1 - shown)).toFixed(1)}`;
    }

    let activeId = "overview";
    const probeY = window.scrollY + window.innerHeight * 0.36;
    for (let i = 0; i < sections.length; i += 1) {
      if (sections[i].offsetTop <= probeY) {
        activeId = sections[i].id;
      }
    }

    nodes.forEach((node) => {
      node.classList.toggle("is-active", node.dataset.ecgTarget === activeId);
    });
    navLinks.forEach((link) => {
      link.classList.toggle("is-active", link.getAttribute("href") === `#${activeId}`);
    });
  };

  const onScroll = () => {
    if (!rafId) rafId = requestAnimationFrame(update);
  };

  update();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
}

// Mount untouched ScrollCraft engine & page-local interactions
renderStaticPreviewFormulas();
if (window.ScrollCraft && typeof window.ScrollCraft.mount === "function") {
  window.ScrollCraft.mount(document);
}
initParticleField();
initHeroPointerDepth();
initEcgPulseRail();
