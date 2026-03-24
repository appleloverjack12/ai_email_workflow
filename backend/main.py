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
from io import BytesIO
from pypdf import PdfReader

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

    website_url: Optional[str] = None
    pages_needed: Optional[list[str]] = None
    design_preferences: Optional[str] = None
    business_goals: Optional[list[str]] = None
    preferred_next_step: Optional[str] = None
    additional_notes: Optional[str] = None

    summary: str


class DraftOutput(BaseModel):
    reply_text: str


# --- Prompt text ---
DRAFT_SYSTEM_PROMPT = """
You draft concise, professional small-business email replies.

Rules:
- Use the extracted fields and attached-document details if available.
- If the project brief or attachment is already present in the context, do NOT ask the sender to send it again.
- Mention useful known details like requested service, budget, timeline, or project scope when available.
- Ask only for genuinely missing information.
- Do not invent promises, prices, or timelines.
- Keep the draft under 180 words.
- Do not include a fake signature name.
"""

EXTRACTION_SYSTEM_PROMPT = """
You extract structured business information from an inbound email and any attached-document text.

Important rules:
- For quote requests, project briefs, proposals, scopes, requirements, and attached PDFs, treat the attached-document text as the primary source of truth.
- The email body may be short; do not ignore rich details that appear only in the attached document.
- Extract concrete details from the document whenever present.
- Use null only when the information is truly missing.
- Keep summary concise and factual.

Always look for:
- sender_name
- company_name
- email
- phone
- requested_service
- budget
- timeline
- location
- urgency
- interest_level
- website_url
- pages_needed
- design_preferences
- business_goals
- preferred_next_step
- additional_notes
- summary

For pages_needed and business_goals, return a list when clearly stated.
"""

CLASSIFICATION_SYSTEM_PROMPT = """
You classify inbound small-business emails using both the email body and any attached-document text.

Allowed categories:
- lead
- quote_request
- invoice
- support
- appointment
- spam
- other

Rules:
- If the email references an attached brief, proposal, scope, requirements, invoice, or similar document, use the attached-document text to determine the category.
- If the message is clearly a request for pricing, quote, estimate, or project discussion, prefer quote_request or lead over other/spam.
- Do not classify as spam if the attached-document text contains a clear business request.

Return:
- category
- confidence: a float from 0.0 to 1.0
- summary: a short one-sentence explanation
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

    if ext == ".pdf":
        try:
            reader = PdfReader(BytesIO(raw_bytes))
            parts: list[str] = []

            for page in reader.pages:
                text = page.extract_text()
                if text:
                    parts.append(text)

            extracted = "\n\n".join(parts).strip()
            return extracted or None
        except Exception:
            return None

    return None


def build_message_context(session: Session, message: Message) -> str:
    docs = session.exec(
        select(Document)
        .where(Document.message_id == message.id)
        .order_by(Document.created_at.asc())
    ).all()

    parts = [
        "INBOUND EMAIL",
        f"Subject: {message.subject}",
        f"Sender name: {message.sender_name or ''}",
        f"Sender email: {message.sender_email}",
        "",
        "EMAIL BODY:",
        message.body_text,
        "",
        f"ATTACHMENT COUNT: {len(docs)}",
    ]

    for i, doc in enumerate(docs, start=1):
        extracted = (doc.extracted_text or "").strip()
        parts.extend(
            [
                "",
                f"ATTACHMENT {i}",
                f"Filename: {doc.filename}",
                f"File type: {doc.file_type or 'unknown'}",
                "ATTACHED DOCUMENT TEXT:",
                extracted if extracted else "[NO EXTRACTED TEXT AVAILABLE]",
            ]
        )

    context = "\n".join(parts)

    print(f"[CONTEXT DEBUG] message_id={message.id} docs={len(docs)}")
    for doc in docs:
        print(
            f"[CONTEXT DEBUG] doc={doc.filename} "
            f"extracted_len={len(doc.extracted_text) if doc.extracted_text else 0}"
        )
    print(f"[CONTEXT DEBUG] preview:\n{context[:3000]}")

    return context


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
                    "Extract structured business fields from the message below.\n\n"
                    "IMPORTANT:\n"
                    "- If ATTACHED DOCUMENT TEXT contains useful details, use it.\n"
                    "- Do NOT say the brief or attachment was missing if ATTACHED DOCUMENT TEXT is present.\n"
                    "- Prefer concrete details from ATTACHED DOCUMENT TEXT over vague email wording.\n\n"
                    f"{context}"
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
                    f"Sender name: {sender_name or 'there'}\n\n"
                    "IMPORTANT:\n"
                    "- If ATTACHED DOCUMENT TEXT is present in the context, assume the attachment was received.\n"
                    "- Do NOT ask the sender to resend the brief or attachment if its contents are already present.\n"
                    "- Use concrete details from the attached document when drafting.\n\n"
                    f"Extracted fields JSON:\n{extracted.model_dump_json(indent=2)}\n\n"
                    f"{context}\n\n"
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

@app.get("/messages/{message_id}/documents")
def list_message_documents(message_id: int) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        get_message_or_404(session, message_id)

        docs = session.exec(
            select(Document)
            .where(Document.message_id == message_id)
            .order_by(Document.created_at.desc())
        ).all()

        return {
            "message_id": message_id,
            "documents": [
                {
                    "id": doc.id,
                    "filename": doc.filename,
                    "file_type": doc.file_type,
                    "storage_path": doc.storage_path,
                    "created_at": doc.created_at,
                }
                for doc in docs
            ],
        }

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

        audit = session.exec(
            select(AuditLog)
            .where(
                AuditLog.message_id == message_id,
                AuditLog.action.in_(["processed", "classified"])
            )
            .order_by(AuditLog.created_at.desc())
        ).first()

        classification_summary = None
        if audit and audit.metadata_json:
            try:
                meta = json.loads(audit.metadata_json)
                classification_summary = meta.get("classification_summary")
            except Exception:
                classification_summary = None

        if not row:
            return {
                "message_id": message_id,
                "extracted_fields": None,
                "classification_summary": classification_summary,
            }

        return {
            "message_id": message_id,
            "extracted_fields_id": row.id,
            "extracted_fields": json.loads(row.json_data),
            "classification_summary": classification_summary,
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
        print(f"[UPLOAD DEBUG] {safe_name} extracted_text_length = {len(extracted_text) if extracted_text else 0}")

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
    metadata_json=json.dumps(
        {
            "category": result.category.value,
            "confidence": result.confidence,
            "classification_summary": result.summary,
        }
    ),
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
        print(f"[PROCESS DEBUG] message_id={message_id}")
        print(f"[PROCESS DEBUG] context preview:\n{context[:2000]}")
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
            "classification_summary": classification.summary,
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
@app.get("/messages/{message_id}/debug-context")
def debug_message_context(message_id: int) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        context = build_message_context(session, message)

        docs = session.exec(
            select(Document)
            .where(Document.message_id == message_id)
            .order_by(Document.created_at.desc())
        ).all()

        return {
            "message_id": message_id,
            "document_count": len(docs),
            "documents": [
                {
                    "id": doc.id,
                    "filename": doc.filename,
                    "has_extracted_text": bool(doc.extracted_text),
                    "extracted_text_length": len(doc.extracted_text) if doc.extracted_text else 0,
                }
                for doc in docs
            ],
            "context_preview": context[:4000],
        }

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
        