import asyncio
import base64
from collections import OrderedDict
from contextlib import asynccontextmanager
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import threading
import time
from typing import Literal, Optional
import unicodedata
import uuid

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from openai import (
    APIConnectionError,
    APITimeoutError,
    AsyncOpenAI,
    AuthenticationError,
    BadRequestError,
    RateLimitError,
)
from pydantic import BaseModel, Field
import pypdfium2 as pdfium

# Tải biến môi trường từ backend/.env nếu có (khi chạy local)
BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
ENV_PATH = BASE_DIR / ".env"
if ENV_PATH.exists():
    load_dotenv(dotenv_path=ENV_PATH)

DEFAULT_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.6-sol")
DEFAULT_REASONING_EFFORT = os.getenv("OPENAI_REASONING_EFFORT", "low").strip().lower()
PLACEHOLDER_API_KEY = "sk-your-openai-api-key-here"

MAX_PDF_SIZE_BYTES = 15 * 1024 * 1024
MAX_SCANNED_PDF_SIZE_BYTES = 8 * 1024 * 1024
MAX_PDF_PAGES = 200
MAX_STORED_PDF_CHARS = 300_000
MAX_PROMPT_PDF_CHARS = 18_000

PDF_CACHE_MAX_ITEMS = 25
PDF_CACHE_TTL_SECONDS = 45 * 60
PDF_CACHE_MAX_BYTES = 50 * 1024 * 1024

SYSTEM_PROMPT = """Bạn là trợ lý học tập Y khoa (MedStudy AI) dành cho sinh viên y khoa và người tự học kiến thức y học.
Hãy trả lời bằng tiếng Việt rõ ràng, chính xác về mặt học thuật và dễ ghi nhớ.

Nguyên tắc trình bày:
1. Dùng cấu trúc mạch lạc bằng Markdown (tiêu đề ngắn, gạch đầu dòng, in đậm thuật ngữ quan trọng).
2. Khi phù hợp, kèm thuật ngữ tiếng Anh chuyên ngành trong ngoặc đơn để hỗ trợ học tài liệu quốc tế.
3. Tổ chức câu trả lời súc tích theo các phần hợp lý (ví dụ: Tổng quan, Cơ chế / Giải thích trọng tâm, Điểm dễ nhầm lẫn hoặc liên hệ lâm sàng, Mẹo ghi nhớ nhanh).
4. Không bịa đặt số liệu hoặc phác đồ; nếu vấn đề phụ thuộc hướng dẫn cập nhật hoặc bối cảnh bệnh nhân cụ thể, hãy nêu rõ.
5. Nếu câu hỏi liên quan đến chẩn đoán/kê đơn cho một bệnh nhân thực tế, nhắc nhẹ rằng thông tin chỉ phục vụ mục đích học tập và cần tham khảo bác sĩ chuyên khoa."""

# Cache AsyncOpenAI client theo API key để tái sử dụng HTTP keep-alive connection pool
_openai_clients: dict[str, AsyncOpenAI] = {}
_clients_lock = threading.Lock()


def _get_openai_client(api_key: str) -> AsyncOpenAI:
    with _clients_lock:
        client = _openai_clients.get(api_key)
        if client is None:
            client = AsyncOpenAI(api_key=api_key, timeout=90.0, max_retries=2)
            # Tránh giữ quá nhiều client nếu nhận nhiều key khác nhau
            if len(_openai_clients) >= 8:
                oldest_key = next(iter(_openai_clients))
                _openai_clients.pop(oldest_key, None)
            _openai_clients[api_key] = client
        return client


@dataclass
class CachedPdf:
    pdf_id: str
    filename: str
    pages: int
    char_count: int
    truncated: bool
    mode: Literal["text", "vision"]
    page_texts: list[tuple[int, str]]
    pdf_base64: Optional[str]
    approx_bytes: int
    created_at: float


class PdfMemoryCache:
    """LRU + TTL cache lưu tài liệu PDF đã trích xuất trên server để không gửi lại dữ liệu lớn qua mạng."""

    def __init__(self, max_items: int, ttl_seconds: int, max_bytes: int):
        self._max_items = max_items
        self._ttl_seconds = ttl_seconds
        self._max_bytes = max_bytes
        self._store: OrderedDict[str, CachedPdf] = OrderedDict()
        self._total_bytes = 0
        self._lock = threading.Lock()

    def _evict_expired(self, now: float) -> None:
        expired_ids = [
            key for key, item in self._store.items() if now - item.created_at > self._ttl_seconds
        ]
        for key in expired_ids:
            removed = self._store.pop(key, None)
            if removed:
                self._total_bytes = max(0, self._total_bytes - removed.approx_bytes)

    def put(self, item: CachedPdf) -> None:
        now = time.monotonic()
        with self._lock:
            self._evict_expired(now)
            if item.pdf_id in self._store:
                old = self._store.pop(item.pdf_id)
                self._total_bytes = max(0, self._total_bytes - old.approx_bytes)

            self._store[item.pdf_id] = item
            self._total_bytes += item.approx_bytes

            while len(self._store) > self._max_items or (
                self._total_bytes > self._max_bytes and len(self._store) > 1
            ):
                _, oldest = self._store.popitem(last=False)
                self._total_bytes = max(0, self._total_bytes - oldest.approx_bytes)

    def get(self, pdf_id: str) -> Optional[CachedPdf]:
        now = time.monotonic()
        with self._lock:
            item = self._store.get(pdf_id)
            if item is None:
                return None
            if now - item.created_at > self._ttl_seconds:
                self._store.pop(pdf_id, None)
                self._total_bytes = max(0, self._total_bytes - item.approx_bytes)
                return None
            # Gia hạn TTL nhẹ khi còn sử dụng và đánh dấu mới dùng gần nhất
            item.created_at = now
            self._store.move_to_end(pdf_id)
            return item


pdf_cache = PdfMemoryCache(
    max_items=PDF_CACHE_MAX_ITEMS,
    ttl_seconds=PDF_CACHE_TTL_SECONDS,
    max_bytes=PDF_CACHE_MAX_BYTES,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    clients = list(_openai_clients.values())
    _openai_clients.clear()
    for client in clients:
        try:
            await client.close()
        except Exception:
            pass


app = FastAPI(
    title="MedStudy AI - FastAPI Backend",
    description="API kết nối web học Y khoa với OpenAI (hỗ trợ Streaming & đọc PDF tốc độ cao).",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class AskRequest(BaseModel):
    question: str = Field(default="", max_length=4000, description="Câu hỏi y khoa của người dùng")
    topic: str = Field(default="Tự do", max_length=100, description="Chuyên ngành / môn học")
    history: list[ChatMessage] = Field(default_factory=list, description="Lịch sử hội thoại gần đây")
    api_key: Optional[str] = Field(default=None, description="OpenAI API Key tùy chọn")
    model: Optional[str] = Field(default=None, description="Tên model OpenAI")
    pdf_id: Optional[str] = Field(default=None, max_length=64, description="ID tài liệu PDF đã upload lên server")
    pdf_name: Optional[str] = Field(default=None, max_length=255, description="Tên file PDF (tương thích ngược)")
    pdf_text: Optional[str] = Field(default=None, max_length=50_000, description="Nội dung PDF (tương thích ngược)")
    pdf_base64: Optional[str] = Field(default=None, max_length=12_000_000, description="Base64 PDF (tương thích ngược)")


class PdfUploadResponse(BaseModel):
    pdf_id: str
    filename: str
    pages: int
    char_count: int
    truncated: bool
    mode: Literal["text", "vision"]


class UsageInfo(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class AskResponse(BaseModel):
    answer: str
    model: str
    usage: Optional[UsageInfo] = None


def _get_env_api_key() -> str:
    # Đọc lại .env khi chạy local để không cần khởi động lại server nếu vừa thêm key
    if ENV_PATH.exists():
        load_dotenv(dotenv_path=ENV_PATH, override=True)
    key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if key == PLACEHOLDER_API_KEY:
        return ""
    return key


def _normalize_vi(text: str) -> str:
    """Chuẩn hóa tiếng Việt không dấu, chữ thường để so khớp từ khóa chính xác hơn."""
    decomposed = unicodedata.normalize("NFD", text.lower().replace("đ", "d").replace("Đ", "d"))
    return "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")


_VI_STOPWORDS = {
    "la", "va", "cua", "cho", "voi", "trong", "nay", "nao", "nhu", "the", "hay",
    "toi", "ban", "mot", "cac", "nhung", "duoc", "khong", "co", "ve", "tu", "den",
    "tai", "lieu", "pdf", "file", "dinh", "kem", "giai", "thich", "trinh", "bay",
    "ngan", "gon", "chi", "tiet", "gi", "sao", "vi", "khi", "neu", "thi", "ma",
    "phan", "biet", "neu", "ro", "dua", "tren", "theo", "bang", "sau", "day",
}

_SUMMARY_HINTS = (
    "tom tat", "tong quan", "muc luc", "y chinh", "trong tam", "toan bo",
    "trac nghiem", "cau hoi on tap", "summary", "overview", "outline", "quiz",
)


def _extract_requested_pages(question: str, max_page: int) -> list[int]:
    """Bắt các yêu cầu chỉ định số trang như 'trang 5', 'trang 3-6', 'page 10'."""
    norm = _normalize_vi(question)
    pages: set[int] = set()
    for match in re.finditer(r"\b(?:trang|tr\.?|page|p\.?)\s*(\d{1,4})(?:\s*[-–đến]+\s*(\d{1,4}))?", norm):
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else start
        if start > end:
            start, end = end, start
        for p in range(max(1, start), min(max_page, end) + 1):
            pages.add(p)
            if len(pages) >= 12:
                break
    return sorted(pages)


def _select_pdf_context(doc: CachedPdf, question: str, max_chars: int = MAX_PROMPT_PDF_CHARS) -> tuple[str, bool]:
    """Chọn toàn bộ hoặc các trang liên quan nhất của PDF để giảm mạnh token và tăng tốc OpenAI."""
    if not doc.page_texts:
        return "", False

    full_blocks = [f"--- Trang {p} ---\n{txt}" for p, txt in doc.page_texts]
    total_len = sum(len(b) + 2 for b in full_blocks)
    if total_len <= max_chars:
        return "\n\n".join(full_blocks), False

    page_map = {p: txt for p, txt in doc.page_texts}
    available_pages = [p for p, _ in doc.page_texts]

    # 1. Nếu người dùng chỉ định rõ số trang -> ưu tiên các trang đó
    explicit_pages = [p for p in _extract_requested_pages(question, doc.pages) if p in page_map]

    # 2. Chấm điểm liên quan bằng từ khóa từ câu hỏi
    norm_q = _normalize_vi(question)
    q_tokens = [
        tok for tok in re.findall(r"[a-z0-9]{2,}", norm_q) if tok not in _VI_STOPWORDS
    ]
    is_summary = any(hint in norm_q for hint in _SUMMARY_HINTS)

    selected_order: list[int] = []
    seen: set[int] = set()

    def _add_page(p: int) -> None:
        if p in page_map and p not in seen:
            seen.add(p)
            selected_order.append(p)

    for p in explicit_pages:
        _add_page(p)

    if is_summary and not explicit_pages:
        # Lấy mẫu rải đều đầu - giữa - cuối để tóm tắt/tạo câu hỏi bao quát toàn tài liệu
        n = len(available_pages)
        sample_count = min(n, 14)
        if sample_count <= 1:
            _add_page(available_pages[0])
        else:
            for i in range(sample_count):
                idx = round(i * (n - 1) / (sample_count - 1))
                _add_page(available_pages[idx])
    elif q_tokens:
        # Chấm điểm từng trang theo mật độ và số lượng từ khóa khớp
        unique_tokens = set(q_tokens)
        scored: list[tuple[float, int]] = []
        for p, txt in doc.page_texts:
            if p in seen:
                continue
            norm_txt = _normalize_vi(txt)
            matched_distinct = 0
            raw_hits = 0
            for tok in unique_tokens:
                cnt = norm_txt.count(tok)
                if cnt > 0:
                    matched_distinct += 1
                    raw_hits += min(cnt, 6)
            if matched_distinct > 0:
                score = matched_distinct * 3.0 + raw_hits * 0.6
                scored.append((score, p))

        scored.sort(key=lambda item: (-item[0], item[1]))
        for _, p in scored[:12]:
            _add_page(p)

    # Bổ sung trang đầu nếu chưa đủ ngữ cảnh (ví dụ câu hỏi chung không trùng từ khóa)
    for p in available_pages:
        if len(selected_order) >= 12:
            break
        _add_page(p)

    # Cắt gọn theo ngân sách ký tự và sắp xếp lại đúng thứ tự trang tăng dần
    picked_pages: list[tuple[int, str]] = []
    used_chars = 0
    for p in selected_order:
        block = f"--- Trang {p} ---\n{page_map[p]}"
        if used_chars + len(block) > max_chars:
            remaining = max_chars - used_chars
            if remaining > 300 and not picked_pages:
                picked_pages.append((p, block[:remaining]))
            elif remaining > 400:
                picked_pages.append((p, block[:remaining] + "..."))
                break
            else:
                break
        else:
            picked_pages.append((p, block))
            used_chars += len(block) + 2

    picked_pages.sort(key=lambda item: item[0])
    return "\n\n".join(block for _, block in picked_pages), True


def _extract_pdf_sync(raw_bytes: bytes) -> tuple[int, list[tuple[int, str]], int, bool]:
    """Trích xuất văn bản PDF siêu nhanh bằng PDFium (C++) — chạy trong threadpool để không block event loop."""
    doc = None
    try:
        try:
            doc = pdfium.PdfDocument(raw_bytes)
        except pdfium.PdfiumError as exc:
            msg = str(exc).lower()
            if "password" in msg:
                raise ValueError("PASSWORD_PROTECTED")
            raise ValueError("INVALID_PDF")

        total_pages = len(doc)
        if total_pages == 0:
            raise ValueError("EMPTY_PDF")

        page_texts: list[tuple[int, str]] = []
        total_chars = 0
        truncated = False
        pages_to_scan = min(total_pages, MAX_PDF_PAGES)
        if total_pages > MAX_PDF_PAGES:
            truncated = True

        for idx in range(pages_to_scan):
            page = doc[idx]
            textpage = None
            try:
                textpage = page.get_textpage()
                raw_text = textpage.get_text_bounded() or ""
            except Exception:
                raw_text = ""
            finally:
                if textpage is not None:
                    textpage.close()
                page.close()

            # Làm sạch khoảng trắng thừa để tiết kiệm token
            cleaned = re.sub(r"[ \t]+", " ", raw_text)
            cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
            if not cleaned:
                continue

            if total_chars + len(cleaned) > MAX_STORED_PDF_CHARS:
                remaining = MAX_STORED_PDF_CHARS - total_chars
                if remaining > 100:
                    page_texts.append((idx + 1, cleaned[:remaining]))
                    total_chars += remaining
                truncated = True
                break

            page_texts.append((idx + 1, cleaned))
            total_chars += len(cleaned)

        return total_pages, page_texts, total_chars, truncated
    finally:
        if doc is not None:
            doc.close()


def _build_openai_call_params(payload: AskRequest) -> tuple[str, str, dict]:
    question = payload.question.strip()

    pdf_name = (payload.pdf_name or "document.pdf").strip()
    pdf_text = (payload.pdf_text or "").strip()
    pdf_base64 = (payload.pdf_base64 or "").strip()
    selected_subset = False
    total_pages = 0

    if payload.pdf_id:
        cached = pdf_cache.get(payload.pdf_id.strip())
        if cached is None:
            raise HTTPException(
                status_code=410,
                detail="PDF_EXPIRED",
            )
        pdf_name = cached.filename
        total_pages = cached.pages
        if cached.mode == "text":
            effective_q = question or "Hãy tóm tắt có hệ thống các kiến thức trọng tâm trong tài liệu PDF đính kèm."
            pdf_text, selected_subset = _select_pdf_context(cached, effective_q)
            pdf_base64 = ""
        else:
            pdf_text = ""
            pdf_base64 = cached.pdf_base64 or ""

    has_pdf = bool(pdf_text or pdf_base64)
    if not question and has_pdf:
        question = "Hãy tóm tắt có hệ thống các kiến thức trọng tâm trong tài liệu PDF đính kèm."

    if not question:
        raise HTTPException(
            status_code=400,
            detail="Vui lòng nhập câu hỏi hoặc tải lên tài liệu PDF trước khi gửi.",
        )

    api_key = (payload.api_key or "").strip() or _get_env_api_key()
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="Chưa có OpenAI API Key. Hãy thêm OPENAI_API_KEY vào file backend/.env hoặc cấu hình trên máy chủ.",
        )

    model_name = (payload.model or "").strip() or os.getenv("OPENAI_MODEL", DEFAULT_MODEL)
    topic_note = f"\nChủ đề/môn học người dùng đang chọn: {payload.topic}." if payload.topic else ""

    pdf_instruction = ""
    if pdf_text:
        subset_note = (
            f" (đã trích lọc các trang liên quan nhất từ tổng số {total_pages} trang để tối ưu tốc độ)"
            if selected_subset and total_pages
            else ""
        )
        pdf_instruction = (
            f'\n\nNgười dùng đang đính kèm tài liệu PDF tên "{pdf_name}"{subset_note}. '
            "Hãy ưu tiên bám sát nội dung trong tài liệu này để trả lời, trích dẫn số trang (ví dụ: Trang 2) nếu có, "
            "đồng thời giải thích rõ các thuật ngữ/cơ chế y khoa liên quan.\n\n"
            f"=== NỘI DUNG TÀI LIỆU PDF ({pdf_name}) ===\n{pdf_text}\n=== HẾT TÀI LIỆU PDF ==="
        )
    elif pdf_base64:
        pdf_instruction = (
            f'\n\nNgười dùng đang đính kèm file PDF dạng hình ảnh/scan tên "{pdf_name}". '
            "Hãy đọc kỹ nội dung, bảng biểu, hình ảnh trong file PDF này để trả lời chính xác và có cấu trúc."
        )

    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT + topic_note + pdf_instruction}]

    # Giữ tối đa 8 tin nhắn gần nhất để hội thoại mạch lạc mà vẫn tiết kiệm token
    for msg in payload.history[-8:]:
        if msg.content.strip():
            messages.append({"role": msg.role, "content": msg.content.strip()})

    if pdf_base64 and not pdf_text:
        messages.append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "file",
                        "file": {
                            "filename": pdf_name,
                            "file_data": f"data:application/pdf;base64,{pdf_base64}",
                        },
                    },
                    {"type": "text", "text": question},
                ],
            }
        )
    else:
        messages.append({"role": "user", "content": question})

    create_kwargs: dict = {
        "model": model_name,
        "messages": messages,
    }
    lower_model = model_name.lower()
    if lower_model.startswith("gpt-5"):
        effort = os.getenv("OPENAI_REASONING_EFFORT", DEFAULT_REASONING_EFFORT).strip().lower()
        if effort in {"none", "low", "medium", "high"}:
            create_kwargs["reasoning_effort"] = effort
    elif not lower_model.startswith(("o1", "o3", "o4")):
        create_kwargs["temperature"] = 0.3

    return api_key, model_name, create_kwargs


def _map_openai_error(exc: Exception) -> tuple[int, str]:
    if isinstance(exc, AuthenticationError):
        return 401, "OpenAI API Key không hợp lệ hoặc đã bị thu hồi. Vui lòng kiểm tra lại."
    if isinstance(exc, RateLimitError):
        return 429, "OpenAI API đã hết hạn mức (quota) hoặc vượt giới hạn tốc độ. Vui lòng kiểm tra billing trên OpenAI."
    if isinstance(exc, APITimeoutError):
        return 504, "Kết nối tới OpenAI bị quá thời gian chờ. Vui lòng thử lại."
    if isinstance(exc, APIConnectionError):
        return 503, "Không thể kết nối tới máy chủ OpenAI. Vui lòng kiểm tra kết nối mạng."
    if isinstance(exc, BadRequestError):
        return 400, f"Yêu cầu không hợp lệ tới OpenAI: {str(exc)}"
    return 500, f"Lỗi khi gọi OpenAI API: {str(exc)}"


def _sse_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/api/health")
def health_check():
    env_key = _get_env_api_key()
    return {
        "status": "ok",
        "has_env_api_key": bool(env_key),
        "default_model": os.getenv("OPENAI_MODEL", DEFAULT_MODEL),
    }


@app.post("/api/upload-pdf", response_model=PdfUploadResponse)
async def upload_pdf(file: UploadFile = File(...)):
    filename = (file.filename or "document.pdf").strip()
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Chỉ hỗ trợ file định dạng .pdf.")

    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="File PDF trống, vui lòng chọn file khác.")

    if len(raw_bytes) > MAX_PDF_SIZE_BYTES:
        raise HTTPException(
            status_code=400,
            detail="File PDF vượt quá giới hạn 15 MB. Vui lòng chọn file nhỏ hơn.",
        )

    if b"%PDF" not in raw_bytes[:1024]:
        raise HTTPException(status_code=400, detail="File tải lên không phải định dạng PDF hợp lệ.")

    try:
        total_pages, page_texts, total_chars, truncated = await asyncio.to_thread(
            _extract_pdf_sync, raw_bytes
        )
    except ValueError as err:
        code = str(err)
        if code == "PASSWORD_PROTECTED":
            raise HTTPException(
                status_code=400,
                detail="File PDF có mật khẩu bảo vệ. Vui lòng gỡ mật khẩu trước khi tải lên.",
            )
        if code == "EMPTY_PDF":
            raise HTTPException(status_code=400, detail="File PDF không có trang nào.")
        raise HTTPException(status_code=400, detail="Không thể đọc file PDF này. File có thể bị lỗi.")

    pdf_id = uuid.uuid4().hex[:16]

    # Nếu PDF có văn bản trích xuất được -> lưu trang vào cache server, trả về metadata gọn nhẹ
    if total_chars >= 20:
        approx_bytes = sum(len(txt.encode("utf-8")) for _, txt in page_texts) + 512
        pdf_cache.put(
            CachedPdf(
                pdf_id=pdf_id,
                filename=filename,
                pages=total_pages,
                char_count=total_chars,
                truncated=truncated,
                mode="text",
                page_texts=page_texts,
                pdf_base64=None,
                approx_bytes=approx_bytes,
                created_at=time.monotonic(),
            )
        )
        return PdfUploadResponse(
            pdf_id=pdf_id,
            filename=filename,
            pages=total_pages,
            char_count=total_chars,
            truncated=truncated,
            mode="text",
        )

    # PDF dạng ảnh/scan không có chữ nhúng -> lưu base64 trên server để tránh trình duyệt gửi lại nhiều lần
    if len(raw_bytes) > MAX_SCANNED_PDF_SIZE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=(
                "File PDF này là bản scan/hình ảnh không có chữ nhúng và vượt quá 8 MB. "
                "Vui lòng nén hoặc tách nhỏ file (<= 8 MB) rồi tải lên lại."
            ),
        )

    b64_data = await asyncio.to_thread(lambda b: base64.b64encode(b).decode("ascii"), raw_bytes)
    pdf_cache.put(
        CachedPdf(
            pdf_id=pdf_id,
            filename=filename,
            pages=total_pages,
            char_count=0,
            truncated=False,
            mode="vision",
            page_texts=[],
            pdf_base64=b64_data,
            approx_bytes=len(b64_data) + 512,
            created_at=time.monotonic(),
        )
    )
    return PdfUploadResponse(
        pdf_id=pdf_id,
        filename=filename,
        pages=total_pages,
        char_count=0,
        truncated=False,
        mode="vision",
    )


@app.post("/api/ask", response_model=AskResponse)
async def ask_medical_question(payload: AskRequest):
    api_key, model_name, create_kwargs = _build_openai_call_params(payload)
    client = _get_openai_client(api_key)

    try:
        completion = await client.chat.completions.create(**create_kwargs)
    except Exception as exc:
        status_code, detail = _map_openai_error(exc)
        raise HTTPException(status_code=status_code, detail=detail)

    answer = (completion.choices[0].message.content or "").strip()
    if not answer:
        raise HTTPException(status_code=502, detail="OpenAI không trả về nội dung câu trả lời.")

    usage_info = None
    if completion.usage:
        usage_info = UsageInfo(
            prompt_tokens=completion.usage.prompt_tokens or 0,
            completion_tokens=completion.usage.completion_tokens or 0,
            total_tokens=completion.usage.total_tokens or 0,
        )

    return AskResponse(
        answer=answer,
        model=completion.model or model_name,
        usage=usage_info,
    )


@app.post("/api/ask/stream")
async def ask_medical_question_stream(payload: AskRequest):
    api_key, model_name, create_kwargs = _build_openai_call_params(payload)
    client = _get_openai_client(api_key)

    async def event_generator():
        resolved_model = model_name
        usage_dict = None
        has_content = False

        try:
            stream = await client.chat.completions.create(
                **create_kwargs,
                stream=True,
                stream_options={"include_usage": True},
            )
            async for chunk in stream:
                if getattr(chunk, "model", None):
                    resolved_model = chunk.model
                if chunk.choices:
                    delta = chunk.choices[0].delta
                    if delta and delta.content:
                        has_content = True
                        yield _sse_event("delta", {"text": delta.content})
                if getattr(chunk, "usage", None):
                    usage_dict = {
                        "prompt_tokens": chunk.usage.prompt_tokens or 0,
                        "completion_tokens": chunk.usage.completion_tokens or 0,
                        "total_tokens": chunk.usage.total_tokens or 0,
                    }

            if not has_content:
                yield _sse_event("error", {"detail": "OpenAI không trả về nội dung câu trả lời."})
                return

            yield _sse_event("done", {"model": resolved_model, "usage": usage_dict})
        except Exception as exc:
            _, detail = _map_openai_error(exc)
            yield _sse_event("error", {"detail": detail})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# Phục vụ trực tiếp giao diện web (frontend/) khi deploy 1 dịch vụ duy nhất (Render, Railway, v.v.)
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
else:
    @app.get("/")
    def root():
        return {
            "message": "MedStudy AI FastAPI Backend đang hoạt động.",
            "docs": "/docs",
            "health": "/api/health",
        }
