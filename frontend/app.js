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

function formatInlineMarkdown(line) {
  const codeTokens = [];
  let html = escapeHtml(line);

  // Bảo vệ inline code trước khi định dạng bold/italic
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const idx = codeTokens.length;
    codeTokens.push(`<code>${code}</code>`);
    return `@@CODE_${idx}@@`;
  });

  html = html.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  html = html.replace(/@@CODE_(\d+)@@/g, (_, idx) => codeTokens[Number(idx)] || "");
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
    if (line.startsWith("```")) {
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
    ? `<div class="user-pdf-badge" title="${escapeHtml(pdfName)}">📄 ${escapeHtml(pdfName)}</div><div>${escapeHtml(text)}</div>`
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

els.topicChips.addEventListener("click", (event) => {
  const btn = event.target.closest(".chip");
  if (!btn) return;

  els.topicChips.querySelectorAll(".chip").forEach((chip) => chip.classList.remove("active"));
  btn.classList.add("active");
  state.topic = btn.dataset.topic || "Tự do";
});

document.querySelectorAll(".sample-card").forEach((card) => {
  card.addEventListener("click", () => {
    const topic = card.dataset.topic;
    const question = card.dataset.question;
    if (topic) {
      state.topic = topic;
      els.topicChips.querySelectorAll(".chip").forEach((chip) => {
        chip.classList.toggle("active", chip.dataset.topic === topic);
      });
    }
    if (question) {
      submitQuestion(question);
    }
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
