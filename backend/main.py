import os
from pathlib import Path
from typing import Literal, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
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

# Tải biến môi trường từ backend/.env nếu có (khi chạy local)
BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
ENV_PATH = BASE_DIR / ".env"
if ENV_PATH.exists():
    load_dotenv(dotenv_path=ENV_PATH)

DEFAULT_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.6-sol")
PLACEHOLDER_API_KEY = "sk-your-openai-api-key-here"

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
    question: str = Field(..., min_length=1, max_length=4000, description="Câu hỏi y khoa của người dùng")
    topic: str = Field(default="Tự do", max_length=100, description="Chuyên ngành / môn học")
    history: list[ChatMessage] = Field(default_factory=list, description="Lịch sử hội thoại gần đây")
    api_key: Optional[str] = Field(default=None, description="OpenAI API Key tùy chọn gửi từ giao diện")
    model: Optional[str] = Field(default=None, description="Tên model OpenAI")


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


@app.post("/api/ask", response_model=AskResponse)
def ask_medical_question(payload: AskRequest):
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Vui lòng nhập câu hỏi trước khi gửi.")

    api_key = (payload.api_key or "").strip() or _get_env_api_key()
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail=(
                "Chưa có OpenAI API Key. Hãy thêm OPENAI_API_KEY vào file backend/.env "
                "hoặc nhập API Key trực tiếp ở mục Cài đặt trên giao diện."
            ),
        )

    model_name = (payload.model or "").strip() or os.getenv("OPENAI_MODEL", DEFAULT_MODEL)

    topic_note = f"\nChủ đề/môn học người dùng đang chọn: {payload.topic}." if payload.topic else ""
    messages = [{"role": "system", "content": SYSTEM_PROMPT + topic_note}]

    # Giữ tối đa 8 tin nhắn gần nhất để hội thoại mạch lạc mà vẫn tiết kiệm token
    for msg in payload.history[-8:]:
        if msg.content.strip():
            messages.append({"role": msg.role, "content": msg.content.strip()})

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
