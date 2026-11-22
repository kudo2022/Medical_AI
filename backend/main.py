import base64
import io
import os
from pathlib import Path
from typing import Literal, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AuthenticationError,
    BadRequestError,
    NotFoundError,
    OpenAI,
    PermissionDeniedError,
    RateLimitError,
)
from pydantic import BaseModel, Field
from pypdf import PdfReader

# Tải biến môi trường từ backend/.env nếu có (khi chạy local)
BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
ENV_PATH = BASE_DIR / ".env"
if ENV_PATH.exists():
    load_dotenv(dotenv_path=ENV_PATH)

DEFAULT_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.6-sol")
PLACEHOLDER_API_KEY = "sk-your-openai-api-key-here"
MAX_PDF_SIZE_BYTES = 15 * 1024 * 1024
MAX_SCANNED_PDF_SIZE_BYTES = 8 * 1024 * 1024
MAX_PDF_TEXT_CHARS = 45_000

SYSTEM_PROMPT = """Bạn là trợ lý học tập Y khoa (MedStudy AI) dành cho sinh viên y khoa và người tự học kiến thức y học.
Hãy trả lời bằng tiếng Việt rõ ràng, chính xác về mặt học thuật và dễ ghi nhớ.

Nguyên tắc trình bày:
1. Dùng cấu trúc mạch lạc bằng Markdown (tiêu đề ngắn, gạch đầu dòng, in đậm thuật ngữ quan trọng).
2. Khi phù hợp, kèm thuật ngữ tiếng Anh chuyên ngành trong ngoặc đơn để hỗ trợ học tài liệu quốc tế.
3. Tổ chức câu trả lời súc tích theo các phần hợp lý (ví dụ: Tổng quan, Cơ chế / Giải thích trọng tâm, Điểm dễ nhầm lẫn hoặc liên hệ lâm sàng, Mẹo ghi nhớ nhanh).
4. Không bịa đặt số liệu hoặc phác đồ; nếu vấn đề phụ thuộc hướng dẫn cập nhật hoặc bối cảnh bệnh nhân cụ thể, hãy nêu rõ.
5. Nếu câu hỏi liên quan đến chẩn đoán/kê đơn cho một bệnh nhân thực tế, nhắc nhẹ rằng thông tin chỉ phục vụ mục đích học tập và cần tham khảo bác sĩ chuyên khoa."""

app = FastAPI(
    title="MedStudy AI - FastAPI Backend",
    description="API đơn giản kết nối web học Y khoa với OpenAI.",
    version="1.0.0",
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
    api_key: Optional[str] = Field(default=None, description="OpenAI API Key tùy chọn gửi từ giao diện")
    model: Optional[str] = Field(default=None, description="Tên model OpenAI")
    pdf_name: Optional[str] = Field(default=None, max_length=255, description="Tên file PDF đính kèm")
    pdf_text: Optional[str] = Field(default=None, max_length=50_000, description="Nội dung trích xuất từ PDF")
    pdf_base64: Optional[str] = Field(default=None, max_length=12_000_000, description="Dữ liệu base64 cho PDF dạng scan/hình ảnh")


class PdfUploadResponse(BaseModel):
    filename: str
    pages: int
    char_count: int
    truncated: bool
    mode: Literal["text", "vision"]
    text: str = ""
    pdf_base64: Optional[str] = None


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
        reader = PdfReader(io.BytesIO(raw_bytes))
        if reader.is_encrypted:
            try:
                decrypted = reader.decrypt("")
            except Exception:
                decrypted = 0
            if not decrypted:
                raise HTTPException(
                    status_code=400,
                    detail="File PDF có mật khẩu bảo vệ. Vui lòng gỡ mật khẩu trước khi tải lên.",
                )
        total_pages = len(reader.pages)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Không thể đọc file PDF này. File có thể bị lỗi.")

    if total_pages == 0:
        raise HTTPException(status_code=400, detail="File PDF không có trang nào.")

    extracted_parts: list[str] = []
    current_len = 0
    truncated = False

    for page_idx, page in enumerate(reader.pages, start=1):
        try:
            page_text = (page.extract_text() or "").strip()
        except Exception:
            page_text = ""

        if not page_text:
            continue

        block = f"--- Trang {page_idx} ---\n{page_text}"
        if current_len + len(block) > MAX_PDF_TEXT_CHARS:
            remaining = MAX_PDF_TEXT_CHARS - current_len
            if remaining > 100:
                extracted_parts.append(block[:remaining])
            truncated = True
            break

        extracted_parts.append(block)
        current_len += len(block) + 2

    combined_text = "\n\n".join(extracted_parts).strip()

    # Nếu PDF có văn bản trích xuất được -> gửi dạng text nhẹ và hỗ trợ nhiều trang
    if len(combined_text) >= 20:
        return PdfUploadResponse(
            filename=filename,
            pages=total_pages,
            char_count=len(combined_text),
            truncated=truncated,
            mode="text",
            text=combined_text,
        )

    # Nếu PDF dạng ảnh/scan (không có lớp text) -> gửi trực tiếp file PDF cho model đọc thị giác
    if len(raw_bytes) > MAX_SCANNED_PDF_SIZE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=(
                "File PDF này là bản scan/hình ảnh không có chữ nhúng và vượt quá 8 MB. "
                "Vui lòng nén hoặc tách nhỏ file (<= 8 MB) rồi tải lên lại."
            ),
        )

    return PdfUploadResponse(
        filename=filename,
        pages=total_pages,
        char_count=0,
        truncated=False,
        mode="vision",
        text="",
        pdf_base64=base64.b64encode(raw_bytes).decode("ascii"),
    )


@app.post("/api/ask", response_model=AskResponse)
def ask_medical_question(payload: AskRequest):
    question = payload.question.strip()
    pdf_text = (payload.pdf_text or "").strip()
    pdf_base64 = (payload.pdf_base64 or "").strip()
    pdf_name = (payload.pdf_name or "document.pdf").strip()
    has_pdf = bool(pdf_text or pdf_base64)

    if not question and has_pdf:
        question = "Hãy tóm tắt có hệ thống các kiến thức trọng tâm trong tài liệu PDF đính kèm."

    if not question:
        raise HTTPException(status_code=400, detail="Vui lòng nhập câu hỏi hoặc tải lên tài liệu PDF trước khi gửi.")

    api_key = (payload.api_key or "").strip() or _get_env_api_key()
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail=(
                "Chưa có OpenAI API Key. Hãy thêm OPENAI_API_KEY vào file backend/.env "
                "hoặc cấu hình trên máy chủ."
            ),
        )

    model_name = (payload.model or "").strip() or os.getenv("OPENAI_MODEL", DEFAULT_MODEL)

    topic_note = f"\nChủ đề/môn học người dùng đang chọn: {payload.topic}." if payload.topic else ""
    pdf_instruction = ""
    if pdf_text:
        pdf_instruction = (
            f"\n\nNgười dùng đang đính kèm tài liệu PDF tên \"{pdf_name}\". "
            "Hãy ưu tiên bám sát nội dung trong tài liệu này để trả lời, trích dẫn số trang (ví dụ: Trang 2) nếu có, "
            "đồng thời giải thích rõ các thuật ngữ/cơ chế y khoa liên quan.\n\n"
            f"=== NỘI DUNG TÀI LIỆU PDF ({pdf_name}) ===\n{pdf_text}\n=== HẾT TÀI LIỆU PDF ==="
        )
    elif pdf_base64:
        pdf_instruction = (
            f"\n\nNgười dùng đang đính kèm file PDF dạng hình ảnh/scan tên \"{pdf_name}\". "
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

    try:
        client = OpenAI(api_key=api_key)
        create_kwargs = {
            "model": model_name,
            "messages": messages,
        }
        lower_model = model_name.lower()
        if not lower_model.startswith(("gpt-5", "o1", "o3", "o4")):
            create_kwargs["temperature"] = 0.3
        completion = client.chat.completions.create(**create_kwargs)
    except AuthenticationError:
        raise HTTPException(
            status_code=401,
            detail="OpenAI API Key không hợp lệ hoặc đã bị thu hồi. Vui lòng kiểm tra lại.",
        )
    except RateLimitError:
        raise HTTPException(
            status_code=429,
            detail="OpenAI API đã hết hạn mức (quota) hoặc vượt giới hạn tốc độ. Vui lòng kiểm tra billing trên OpenAI.",
        )
    except APIConnectionError:
        raise HTTPException(
            status_code=503,
            detail="Không thể kết nối tới máy chủ OpenAI. Vui lòng kiểm tra kết nối mạng.",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi khi gọi OpenAI API: {str(exc)}",
        )

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
