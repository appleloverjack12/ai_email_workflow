from __future__ import annotations
from fastapi.middleware.cors import CORSMiddleware
import json
import os
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from openai import OpenAI
from pydantic import BaseModel, ConfigDict, EmailStr
from sqlmodel import Field, Session, SQLModel, create_engine, select


load_dotenv()


# --- App setup ---
app = FastAPI(title="AI Email + Document Workflow API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
engine = create_engine("sqlite:///workflow.db", echo=False)
UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)


def create_db_and_tables() -> None:
    SQLModel.metadata.create_all(engine)


@app.on_event("startup")
def on_startup() -> None:
    create_db_and_tables()


# --- Enums ---
class MessageCategory(str, Enum):
    lead = "lead"
    quote_request = "quote_request"
    invoice = "invoice"
    support = "support"
    appointment = "appointment"
    spam = "spam"
    other = "other"


class MessageStatus(str, Enum):
    new = "new"
    processing = "processing"
    needs_review = "needs_review"
    approved = "approved"
    sent = "sent"
    rejected = "rejected"
    error = "error"


class ApprovalStatus(str, Enum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"
    edited = "edited"


# --- Database models ---
class Message(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    subject: str
    sender_email: str
    sender_name: Optional[str] = None
    body_text: str
    category: MessageCategory = Field(default=MessageCategory.other)
    status: MessageStatus = Field(default=MessageStatus.new)
    ai_confidence: Optional[float] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class Document(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    message_id: int = Field(index=True)
    filename: str
    file_type: Optional[str] = None
    storage_path: Optional[str] = None
    extracted_text: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ExtractedFields(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    message_id: int = Field(index=True)
    json_data: str
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Draft(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    message_id: int = Field(index=True)
    draft_text: str
    approved_text: Optional[str] = None
    approval_status: ApprovalStatus = Field(default=ApprovalStatus.pending)
    approved_by: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class AuditLog(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    message_id: int = Field(index=True)
    action: str
    actor: str
    metadata_json: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


# --- API schemas ---
class MessageCreate(BaseModel):
    subject: str
    sender_email: EmailStr
    sender_name: Optional[str] = None
    body_text: str


class MessageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    subject: str
    sender_email: str
    sender_name: Optional[str] = None
    body_text: str
    category: MessageCategory
    status: MessageStatus
    ai_confidence: Optional[float] = None
    created_at: datetime
    updated_at: datetime


class DraftEditRequest(BaseModel):
    draft_text: str
    editor_name: str


class ApprovalRequest(BaseModel):
    actor_name: str


# --- Structured AI output schemas ---
class ClassificationOutput(BaseModel):
    category: MessageCategory
    confidence: float
    summary: str


class ExtractionOutput(BaseModel):
    sender_name: Optional[str] = None
    company_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    requested_service: Optional[str] = None
    budget: Optional[str] = None
    timeline: Optional[str] = None
    location: Optional[str] = None
    urgency: Optional[str] = None
    interest_level: Optional[str] = None
    summary: str


class DraftOutput(BaseModel):
    reply_text: str


# --- Prompt text ---
CLASSIFICATION_SYSTEM_PROMPT = """
You classify inbound small-business emails.

Allowed categories:
- lead
- quote_request
- invoice
- support
- appointment
- spam
- other

Return:
- category
- confidence: a float from 0.0 to 1.0
- summary: a short one-sentence explanation

Choose the single best category.
"""

EXTRACTION_SYSTEM_PROMPT = """
You extract structured business information from an inbound email and any attached-document text.

Rules:
- Only extract what is actually present or strongly implied.
- Use null for unknown fields.
- Keep summary concise and factual.
- Budget and timeline may be free-form strings.
"""

DRAFT_SYSTEM_PROMPT = """
You draft concise, professional small-business email replies.

Rules:
- Be polite and practical.
- Do not invent promises, prices, or timelines.
- Ask for missing info only when useful.
- Keep the draft under 180 words.
- Do not include a fake signature name.
"""


# --- Helpers ---
def get_openai_client() -> OpenAI:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="OPENAI_API_KEY is missing. Add it to your .env file.",
        )
    return OpenAI(api_key=api_key)


def get_model_name() -> str:
    return os.getenv("OPENAI_MODEL", "gpt-5.4-mini")


def get_message_or_404(session: Session, message_id: int) -> Message:
    message = session.get(Message, message_id)
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    return message


def clamp_confidence(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def extract_text_from_upload(filename: str, raw_bytes: bytes) -> Optional[str]:
    ext = Path(filename).suffix.lower()
    text_like = {".txt", ".md", ".csv", ".json", ".log"}
    if ext in text_like:
        try:
            return raw_bytes.decode("utf-8")
        except UnicodeDecodeError:
            return raw_bytes.decode("utf-8", errors="ignore")
    return None


def build_message_context(session: Session, message: Message) -> str:
    docs = session.exec(
        select(Document).where(Document.message_id == message.id).order_by(Document.created_at.asc())
    ).all()

    parts = [
        f"Subject: {message.subject}",
        f"Sender name: {message.sender_name or ''}",
        f"Sender email: {message.sender_email}",
        "",
        "Email body:",
        message.body_text,
    ]

    if docs:
        parts.append("")
        parts.append("Attached documents:")
        for doc in docs:
            parts.append(f"- Filename: {doc.filename}")
            if doc.extracted_text:
                parts.append("  Extracted text:")
                parts.append(doc.extracted_text[:8000])

    return "\n".join(parts)


def log_action(
    session: Session,
    message_id: int,
    action: str,
    actor: str,
    metadata_json: Optional[str] = None,
) -> None:
    entry = AuditLog(
        message_id=message_id,
        action=action,
        actor=actor,
        metadata_json=metadata_json,
    )
    session.add(entry)
    session.commit()


def ai_classify_message(subject: str, context: str) -> ClassificationOutput:
    client = get_openai_client()
    response = client.responses.parse(
        model=get_model_name(),
        reasoning={"effort": "none"},
        input=[
            {"role": "system", "content": CLASSIFICATION_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"Classify this inbound message.\n\nSubject: {subject}\n\nContext:\n{context}",
            },
        ],
        text_format=ClassificationOutput,
    )
    parsed = response.output_parsed
    if parsed is None:
        raise HTTPException(status_code=500, detail="AI classification returned no structured output.")
    parsed.confidence = clamp_confidence(parsed.confidence)
    return parsed


def ai_extract_fields(category: MessageCategory, context: str) -> ExtractionOutput:
    client = get_openai_client()
    response = client.responses.parse(
        model=get_model_name(),
        reasoning={"effort": "none"},
        input=[
            {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"Category: {category.value}\n\n"
                    f"Extract the useful business fields from this message and any document text.\n\n{context}"
                ),
            },
        ],
        text_format=ExtractionOutput,
    )
    parsed = response.output_parsed
    if parsed is None:
        raise HTTPException(status_code=500, detail="AI extraction returned no structured output.")
    return parsed


def ai_draft_reply(
    category: MessageCategory,
    sender_name: Optional[str],
    extracted: ExtractionOutput,
    context: str,
) -> DraftOutput:
    client = get_openai_client()
    response = client.responses.parse(
        model=get_model_name(),
        reasoning={"effort": "none"},
        input=[
            {"role": "system", "content": DRAFT_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"Category: {category.value}\n"
                    f"Sender name: {sender_name or 'there'}\n"
                    f"Extracted fields JSON:\n{extracted.model_dump_json(indent=2)}\n\n"
                    f"Original context:\n{context}\n\n"
                    "Write the best reply draft."
                ),
            },
        ],
        text_format=DraftOutput,
    )
    parsed = response.output_parsed
    if parsed is None:
        raise HTTPException(status_code=500, detail="AI drafting returned no structured output.")
    return parsed


def ensure_message_classified(session: Session, message: Message) -> Message:
    if message.ai_confidence is not None and message.category != MessageCategory.other:
        return message

    context = build_message_context(session, message)
    result = ai_classify_message(message.subject, context)
    message.category = result.category
    message.ai_confidence = result.confidence
    message.status = MessageStatus.processing
    message.updated_at = datetime.utcnow()
    session.add(message)
    session.commit()
    log_action(
        session,
        message.id,
        "classified",
        "ai",
        metadata_json=result.model_dump_json(),
    )
    return message


# --- Routes ---
@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/messages", response_model=MessageRead)
def create_message(payload: MessageCreate) -> Message:
    with Session(engine, expire_on_commit=False) as session:
        message = Message(
            subject=payload.subject,
            sender_email=payload.sender_email,
            sender_name=payload.sender_name,
            body_text=payload.body_text,
        )
        session.add(message)
        session.commit()
        session.refresh(message)
        log_action(session, message.id, "message_created", "system")
        return message


@app.get("/messages", response_model=list[MessageRead])
def list_messages() -> list[Message]:
    with Session(engine, expire_on_commit=False) as session:
        rows = session.exec(select(Message).order_by(Message.created_at.desc())).all()
        return rows


@app.get("/messages/{message_id}", response_model=MessageRead)
def get_message(message_id: int) -> Message:
    with Session(engine, expire_on_commit=False) as session:
        return get_message_or_404(session, message_id)

@app.get("/messages/{message_id}/latest-extraction")
def get_latest_extraction(message_id: int) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        get_message_or_404(session, message_id)

        row = session.exec(
            select(ExtractedFields)
            .where(ExtractedFields.message_id == message_id)
            .order_by(ExtractedFields.created_at.desc())
        ).first()

        if not row:
            return {"message_id": message_id, "extracted_fields": None}

        return {
            "message_id": message_id,
            "extracted_fields_id": row.id,
            "extracted_fields": json.loads(row.json_data),
            "created_at": row.created_at,
        }


@app.get("/messages/{message_id}/latest-draft")
def get_latest_draft(message_id: int) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        get_message_or_404(session, message_id)

        draft = session.exec(
            select(Draft)
            .where(Draft.message_id == message_id)
            .order_by(Draft.created_at.desc())
        ).first()

        if not draft:
            return {"message_id": message_id, "draft": None}

        return {
            "message_id": message_id,
            "draft_id": draft.id,
            "draft_text": draft.approved_text or draft.draft_text,
            "approval_status": draft.approval_status,
            "approved_by": draft.approved_by,
            "created_at": draft.created_at,
            "updated_at": draft.updated_at,
        }

@app.post("/messages/{message_id}/documents")
def upload_document(message_id: int, file: UploadFile = File(...)) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        get_message_or_404(session, message_id)

        safe_name = Path(file.filename or "upload.bin").name
        timestamp_prefix = datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
        stored_name = f"{timestamp_prefix}_{safe_name}"
        stored_path = UPLOAD_DIR / stored_name

        raw_bytes = file.file.read()
        stored_path.write_bytes(raw_bytes)
        extracted_text = extract_text_from_upload(safe_name, raw_bytes)

        doc = Document(
            message_id=message_id,
            filename=safe_name,
            file_type=file.content_type,
            storage_path=str(stored_path),
            extracted_text=extracted_text,
        )
        session.add(doc)
        session.commit()
        session.refresh(doc)
        log_action(
            session,
            message_id,
            "document_uploaded",
            "system",
            metadata_json=json.dumps({"filename": safe_name, "stored_path": str(stored_path)}),
        )
        return {"document_id": doc.id, "filename": doc.filename, "stored_path": str(stored_path)}


@app.post("/messages/{message_id}/classify")
def run_classification(message_id: int) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        context = build_message_context(session, message)
        result = ai_classify_message(message.subject, context)

        message.status = MessageStatus.processing
        message.category = result.category
        message.ai_confidence = result.confidence
        message.updated_at = datetime.utcnow()
        session.add(message)
        session.commit()

        log_action(
            session,
            message_id,
            "classified",
            "ai",
            metadata_json=result.model_dump_json(),
        )
        return {
            "message_id": message_id,
            "category": result.category,
            "confidence": result.confidence,
            "summary": result.summary,
        }


@app.post("/messages/{message_id}/extract")
def run_extraction(message_id: int) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        message = ensure_message_classified(session, message)
        context = build_message_context(session, message)

        extracted = ai_extract_fields(message.category, context)
        row = ExtractedFields(message_id=message_id, json_data=extracted.model_dump_json())
        session.add(row)
        message.updated_at = datetime.utcnow()
        session.add(message)
        session.commit()
        session.refresh(row)

        log_action(
            session,
            message_id,
            "fields_extracted",
            "ai",
            metadata_json=extracted.model_dump_json(),
        )
        return {
            "message_id": message_id,
            "extracted_fields_id": row.id,
            "json_data": json.loads(row.json_data),
        }


@app.post("/messages/{message_id}/draft-reply")
def generate_draft(message_id: int) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        message = ensure_message_classified(session, message)
        context = build_message_context(session, message)
        extracted = ai_extract_fields(message.category, context)
        text = ai_draft_reply(message.category, message.sender_name, extracted, context)

        draft = Draft(message_id=message_id, draft_text=text.reply_text)
        message.status = MessageStatus.needs_review
        message.updated_at = datetime.utcnow()
        session.add(draft)
        session.add(message)
        session.commit()
        session.refresh(draft)

        log_action(session, message_id, "draft_created", "ai")
        return {"message_id": message_id, "draft_id": draft.id, "draft_text": draft.draft_text}


@app.post("/messages/{message_id}/process")
def process_message(message_id: int) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        context = build_message_context(session, message)

        classification = ai_classify_message(message.subject, context)
        message.category = classification.category
        message.ai_confidence = classification.confidence

        extracted = ai_extract_fields(classification.category, context)
        reply = ai_draft_reply(classification.category, message.sender_name, extracted, context)

        extracted_row = ExtractedFields(
            message_id=message_id,
            json_data=extracted.model_dump_json(),
        )
        draft = Draft(message_id=message_id, draft_text=reply.reply_text)

        message.status = MessageStatus.needs_review
        message.updated_at = datetime.utcnow()

        session.add(extracted_row)
        session.add(draft)
        session.add(message)
        session.commit()
        session.refresh(draft)

        log_action(
            session,
            message_id,
            "processed",
            "ai",
            metadata_json=json.dumps(
                {
                    "category": classification.category.value,
                    "confidence": classification.confidence,
                }
            ),
        )

        return {
            "message_id": message_id,
            "category": classification.category,
            "confidence": classification.confidence,
            "classification_summary": classification.summary,
            "extracted_fields": extracted.model_dump(),
            "draft_text": reply.reply_text,
            "status": message.status,
        }


@app.post("/messages/{message_id}/edit-draft")
def edit_draft(message_id: int, payload: DraftEditRequest) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        get_message_or_404(session, message_id)
        draft = session.exec(
            select(Draft)
            .where(Draft.message_id == message_id)
            .order_by(Draft.created_at.desc())
        ).first()
        if not draft:
            raise HTTPException(status_code=404, detail="Draft not found")

        draft.approved_text = payload.draft_text
        draft.approval_status = ApprovalStatus.edited
        draft.approved_by = payload.editor_name
        draft.updated_at = datetime.utcnow()
        session.add(draft)
        session.commit()
        log_action(session, message_id, "draft_edited", payload.editor_name)
        return {
            "message_id": message_id,
            "draft_id": draft.id,
            "approved_text": draft.approved_text,
        }


@app.post("/messages/{message_id}/approve")
def approve_message(message_id: int, payload: ApprovalRequest) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        draft = session.exec(
            select(Draft)
            .where(Draft.message_id == message_id)
            .order_by(Draft.created_at.desc())
        ).first()
        if not draft:
            raise HTTPException(status_code=404, detail="Draft not found")

        draft.approval_status = ApprovalStatus.approved
        draft.approved_by = payload.actor_name
        draft.updated_at = datetime.utcnow()
        message.status = MessageStatus.approved
        message.updated_at = datetime.utcnow()
        session.add(draft)
        session.add(message)
        session.commit()
        log_action(session, message_id, "approved", payload.actor_name)
        return {"message_id": message_id, "status": message.status}


@app.post("/messages/{message_id}/reject")
def reject_message(message_id: int, payload: ApprovalRequest) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        draft = session.exec(
            select(Draft)
            .where(Draft.message_id == message_id)
            .order_by(Draft.created_at.desc())
        ).first()

        if draft:
            draft.approval_status = ApprovalStatus.rejected
            draft.approved_by = payload.actor_name
            draft.updated_at = datetime.utcnow()
            session.add(draft)

        message.status = MessageStatus.rejected
        message.updated_at = datetime.utcnow()
        session.add(message)
        session.commit()
        log_action(session, message_id, "rejected", payload.actor_name)
        return {"message_id": message_id, "status": message.status}


@app.post("/messages/{message_id}/send")
def send_message(message_id: int, payload: ApprovalRequest) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        if message.status != MessageStatus.approved:
            raise HTTPException(
                status_code=400,
                detail="Message must be approved before sending",
            )

        message.status = MessageStatus.sent
        message.updated_at = datetime.utcnow()
        session.add(message)
        session.commit()
        log_action(session, message_id, "sent", payload.actor_name)

        return {
            "message_id": message_id,
            "status": message.status,
            "note": "Stub send endpoint succeeded",
        }