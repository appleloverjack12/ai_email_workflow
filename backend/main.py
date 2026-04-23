from __future__ import annotations
import base64
import json
import os
import re
import secrets
from datetime import datetime
from email.message import EmailMessage
from email.utils import parseaddr
from enum import Enum
from io import BytesIO
from pathlib import Path
import fitz
import pytesseract
from PIL import Image
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, HTMLResponse
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from openai import OpenAI
from sqlalchemy import Column, JSON, or_, func
from typing import Optional
from pydantic import BaseModel, ConfigDict, EmailStr, Field as PydanticField
from pypdf import PdfReader
from sqlmodel import Field, Session, SQLModel, create_engine, select
import io
import jwt
from jwt.exceptions import InvalidTokenError
from pwdlib import PasswordHash
from datetime import timedelta, timezone
from fastapi import Depends, status
from fastapi import HTTPException
from fastapi.security import OAuth2PasswordBearer
from fastapi.responses import StreamingResponse
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

load_dotenv()

TESSERACT_CMD = os.getenv("TESSERACT_CMD")
if TESSERACT_CMD:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD


# --- App setup ---
limiter = Limiter(key_func=get_remote_address)

app = FastAPI(title="AI Email + Document Workflow API")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Comma-separated list of allowed frontend origins. Local dev defaults are
# included automatically; add your Vercel URL to CORS_ORIGINS in production.
_default_origins = "http://localhost:3000,http://127.0.0.1:3000"
_cors_env = os.getenv("CORS_ORIGINS", _default_origins)
_cors_origins = [o.strip() for o in _cors_env.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# ── Production-ready config ───────────────────────────────────────────────
# DATA_DIR controls where workflow.db and uploads/ live. Defaults to the
# backend folder (matches local dev). In Railway, set DATA_DIR=/app/data
# and mount a persistent volume there so data survives redeploys.
DATA_DIR = Path(os.getenv("DATA_DIR", ".")).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "workflow.db"
engine = create_engine(f"sqlite:///{DB_PATH}", echo=False)

# DEMO_MODE hides Gmail sync features in the frontend (via /config endpoint).
# Set DEMO_MODE=true in Railway when your client is testing with manual paste.
DEMO_MODE = os.getenv("DEMO_MODE", "false").lower() == "true"

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")

GOOGLE_REDIRECT_URI = os.getenv(
    "GOOGLE_REDIRECT_URI", "http://127.0.0.1:8000/auth/google/callback"
)
GOOGLE_TOKEN_PATH = os.getenv("GOOGLE_TOKEN_PATH", str(DATA_DIR / "google_token.json"))

SECRET_KEY = os.getenv("APP_SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("APP_SECRET_KEY is missing")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24

password_hash = PasswordHash.recommended()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/login")

GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
]

oauth_pending: dict[str, str] = {}


def get_google_client_config() -> dict:
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise HTTPException(
            status_code=500, detail="Google OAuth env vars are not configured"
        )
    return {
        "web": {
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [GOOGLE_REDIRECT_URI],
        }
    }

UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def save_google_credentials(credentials: Credentials) -> None:
    Path(GOOGLE_TOKEN_PATH).write_text(credentials.to_json(), encoding="utf-8")


def load_google_credentials() -> Credentials | None:
    token_file = Path(GOOGLE_TOKEN_PATH)
    if not token_file.exists():
        return None
    creds = Credentials.from_authorized_user_file(str(token_file), GOOGLE_SCOPES)
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(GoogleRequest())
        save_google_credentials(creds)
    return creds


def google_connected() -> bool:
    try:
        creds = load_google_credentials()
        return creds is not None and creds.valid
    except Exception:
        return False


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


class MessageSource(str, Enum):
    manual = "manual"
    gmail = "gmail"


class ReplyTone(str, Enum):
    professional = "professional"
    friendly = "friendly"
    concise = "concise"
    warm = "warm"


class ElectricalServiceType(str, Enum):
    strong_current = "strong_current"
    weak_current = "weak_current"
    solar = "solar"
    maintenance = "maintenance"
    project_design = "project_design"
    unknown = "unknown"


class LeadPriority(str, Enum):
    hot = "hot"
    needs_info = "needs_info"
    low_detail = "low_detail"


class MessageStatus(str, Enum):
    new = "new"
    processing = "processing"
    needs_review = "needs_review"
    approved = "approved"
    sent = "sent"
    rejected = "rejected"
    error = "error"
    archived = "archived"
    ignored = "ignored"
    waiting_for_info = "waiting_for_info"
    ready_for_quote = "ready_for_quote"
    ready_for_site_visit = "ready_for_site_visit"


class ApprovalStatus(str, Enum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"
    edited = "edited"


# NEW: Quote lifecycle status
class QuoteStatus(str, Enum):
    draft = "draft"
    sent_to_client = "sent_to_client"
    accepted = "accepted"
    rejected = "rejected"
    expired = "expired"


class UserRole(str, Enum):
    admin = "admin"
    reviewer = "reviewer"


# --- Database models ---
DEFAULT_QUOTE_REQUIRED_FIELDS = [
    "company_name",
    "website_url",
    "budget",
    "timeline",
    "location",
    "pages_needed",
    "business_goals",
]


class CompanySettings(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    company_name: str = Field(default="Your Company")
    preferred_reply_tone: ReplyTone = Field(default=ReplyTone.professional)
    reply_signature: str = Field(default="Best,\nYour Company")
    ignore_senders_json: str = Field(default="[]")
    quote_required_fields_json: str = Field(
        default=json.dumps(DEFAULT_QUOTE_REQUIRED_FIELDS)
    )
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


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
    source: MessageSource = Field(default=MessageSource.manual)
    gmail_message_id: Optional[str] = Field(default=None, index=True)
    gmail_synced_at: Optional[datetime] = None
    gmail_thread_id: Optional[str] = Field(default=None, index=True)
    has_attachments: bool = False


class InternalNote(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    message_id: int = Field(foreign_key="message.id", index=True)
    author: str
    note_text: str
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Document(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    message_id: int = Field(index=True)
    filename: str
    file_type: Optional[str] = None
    storage_path: Optional[str] = None
    extracted_text: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


# NEW: Reply template model
class ReplyTemplate(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    category: Optional[MessageCategory] = None
    service_type: Optional[str] = None  # ElectricalServiceType value
    body_text: str
    use_count: int = Field(default=0)
    created_by: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class QuoteLineItem(BaseModel):
    name: str
    description: Optional[str] = None
    quantity: float = 1
    unit: str = "pcs"
    unit_price: float = 0
    total: Optional[float] = None


class QuoteProposalPayload(BaseModel):
    title: str = "Electrical Works Proposal"
    currency: str = "EUR"
    client_name: Optional[str] = None
    project_name: Optional[str] = None
    site_address: Optional[str] = None
    intro_text: Optional[str] = None
    scope_items: list[QuoteLineItem] = PydanticField(default_factory=list)
    exclusions_text: Optional[str] = None
    validity_days: int = 15
    payment_terms: Optional[str] = None
    discount_amount: float = 0


class QuoteProposalResponse(QuoteProposalPayload):
    message_id: int
    subtotal: float
    total_amount: float
    # NEW: lifecycle fields
    quote_status: Optional[str] = "draft"
    sent_at: Optional[datetime] = None
    responded_at: Optional[datetime] = None


class QuoteProposal(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    message_id: int = Field(foreign_key="message.id", index=True, unique=True)
    title: str = "Electrical Works Proposal"
    currency: str = "EUR"
    client_name: Optional[str] = None
    project_name: Optional[str] = None
    site_address: Optional[str] = None
    intro_text: Optional[str] = None
    scope_items_json: list[dict] = Field(
        default_factory=list,
        sa_column=Column(JSON),
    )
    exclusions_text: Optional[str] = None
    validity_days: int = 15
    payment_terms: Optional[str] = None
    subtotal: float = 0
    discount_amount: float = 0
    total_amount: float = 0
    # NEW: quote lifecycle fields (Optional so existing DB rows without them still load)
    quote_status: Optional[str] = Field(default="draft")
    sent_at: Optional[datetime] = None
    responded_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class UserRole(str, Enum):
    admin = "admin"
    reviewer = "reviewer"


class CompanySettingsRead(SQLModel):
    company_name: str
    preferred_reply_tone: ReplyTone
    reply_signature: str
    ignore_senders: list[str]
    quote_required_fields: list[str]


class CompanySettingsUpdate(SQLModel):
    company_name: str
    preferred_reply_tone: ReplyTone
    reply_signature: str
    ignore_senders: list[str]
    quote_required_fields: list[str]


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    email: EmailStr = Field(index=True)
    full_name: str
    hashed_password: str
    role: UserRole = Field(default=UserRole.reviewer)
    is_active: bool = True
    created_at: datetime = Field(default_factory=datetime.utcnow)


class LoginRequest(SQLModel):
    email: EmailStr
    password: str


class BootstrapAdminRequest(SQLModel):
    email: EmailStr
    full_name: str
    password: str


class UserRead(SQLModel):
    id: int
    email: EmailStr
    full_name: str
    role: UserRole
    is_active: bool


class TokenResponse(SQLModel):
    access_token: str
    token_type: str = "bearer"
    user: UserRead


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
MAX_BODY_LENGTH = 20_000
MAX_SUBJECT_LENGTH = 500
MAX_NAME_LENGTH = 200


class MessageCreate(BaseModel):
    subject: str = PydanticField(max_length=MAX_SUBJECT_LENGTH)
    sender_email: EmailStr
    sender_name: Optional[str] = PydanticField(default=None, max_length=MAX_NAME_LENGTH)
    body_text: str = PydanticField(max_length=MAX_BODY_LENGTH)


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
    source: MessageSource
    gmail_message_id: Optional[str] = None
    gmail_thread_id: Optional[str] = None
    gmail_synced_at: Optional[datetime] = None
    has_attachments: bool = False


class ElectricalQualification(BaseModel):
    service_type: ElectricalServiceType
    service_label: str
    object_type: Optional[str] = None
    location: Optional[str] = None
    budget: Optional[str] = None
    timeline: Optional[str] = None
    urgency: Optional[str] = None
    power_capacity: Optional[str] = None
    installation_type: Optional[str] = None
    attachments_summary: Optional[str] = None
    lead_priority: LeadPriority
    lead_score: int
    missing_fields: list[str]
    recommended_next_step: str
    client_summary: str


class ElectricalQuoteBrief(BaseModel):
    service_type: ElectricalServiceType
    service_label: str
    lead_priority: LeadPriority
    lead_score: int
    current_workflow_status: str
    client_name: Optional[str] = None
    client_email: Optional[str] = None
    client_phone: Optional[str] = None
    location: Optional[str] = None
    budget: Optional[str] = None
    object_type: Optional[str] = None
    timeline: Optional[str] = None
    urgency: Optional[str] = None
    installation_type: Optional[str] = None
    attachments_summary: Optional[str] = None
    missing_fields: list[str] = []
    recommended_next_step: str
    estimator_summary: str


class DraftEditRequest(BaseModel):
    draft_text: str


class InternalNoteCreate(SQLModel):
    author: Optional[str] = None
    note_text: str


class InternalNoteRead(SQLModel):
    id: int
    message_id: int
    author: str
    note_text: str
    created_at: datetime


# NEW: Bulk action schema
class BulkActionRequest(BaseModel):
    message_ids: list[int]
    action: str  # "ignore" | "unignore" | "archive" | "unarchive" | "reject" | "process"


# NEW: Reply template schemas
class ReplyTemplateCreate(BaseModel):
    name: str
    category: Optional[MessageCategory] = None
    service_type: Optional[str] = None
    body_text: str


class ReplyTemplateRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    category: Optional[MessageCategory] = None
    service_type: Optional[str] = None
    body_text: str
    use_count: int
    created_at: datetime
    updated_at: datetime


class ReplyTemplateUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[MessageCategory] = None
    service_type: Optional[str] = None
    body_text: Optional[str] = None


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
    project_type: Optional[str] = None
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
    missing_information: Optional[list[str]] = None
    summary: str


class DraftOutput(BaseModel):
    reply_text: str


# --- Prompt text ---
DRAFT_SYSTEM_PROMPT = """
You draft concise, professional small-business email replies.

Rules:
- Use extracted fields and attached-document details if available.
- If attached-document text is present, do NOT ask the sender to resend the brief or attachment.
- For quote requests, acknowledge the project clearly and mention concrete details when available, such as service requested, budget, or timeline.
- Ask only for genuinely missing information.
- Do not invent promises, prices, or timelines.
- Keep the draft under 180 words.
- Do not include a fake signature name.
"""

EXTRACTION_SYSTEM_PROMPT = """
You extract structured business information from an inbound email and any attached-document text.

The system is optimized for small-business and agency quote requests.

Important rules:
- If the email references an attachment, brief, proposal, scope, requirements, or PDF, treat the attached-document text as a primary source.
- For quote requests and project briefs, prefer concrete details found in the attached document over vague wording in the email.
- Extract details from both the email body and the attached document text.
- Use null only when the information is truly missing.
- Use lists for pages_needed, business_goals, and missing_information when appropriate.
- Keep summary concise and factual.

Always look for:
- sender_name, company_name, email, phone
- requested_service, project_type, budget, timeline, location, urgency, interest_level
- website_url, pages_needed, design_preferences, business_goals
- preferred_next_step, additional_notes, missing_information, summary

For quote/project briefs:
- requested_service should capture the main service requested.
- project_type should be a short label.
- pages_needed should list named pages if present.
- business_goals should list concrete goals if present.
- missing_information should include only the important details still needed to prepare a quote.
"""

CLASSIFICATION_SYSTEM_PROMPT = """
You classify inbound small-business emails using both the email body and any attached-document text.

Allowed categories: lead, quote_request, invoice, support, appointment, spam, other

Rules:
- If the email or attached document clearly requests a quote, estimate, pricing, project discussion, redesign, proposal, or service inquiry, prefer quote_request.
- If the message is a broader business opportunity or recruiting/business lead without a direct quote request, prefer lead.
- Do not classify as spam if attached-document text contains a clear business request.
- Use the attached-document text when the email body is short or vague.

Return: category, confidence (float 0-1), summary (one sentence).
"""

MISSING_INFO_DRAFT_SYSTEM_PROMPT = """
You draft concise, professional follow-up emails for quote requests when key information is still missing.

Rules:
- Use the extracted fields and attached-document details if available.
- Acknowledge that the brief or attachment was reviewed if present.
- Clearly list only the missing details needed to prepare a quote.
- Be polite and practical.
- Do not ask for information that is already present.
- Do not invent prices, timelines, or promises.
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
    return os.getenv("OPENAI_MODEL", "gpt-4o-mini")


def truncate_body(text: str, max_chars: int = MAX_BODY_LENGTH) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n\n[... truncated ...]"


def get_connected_gmail_address(service) -> str:
    profile = service.users().getProfile(userId="me").execute()
    return (profile.get("emailAddress") or "").lower().strip()


def archive_gmail_message(service, gmail_message_id: str) -> dict:
    return (
        service.users()
        .messages()
        .modify(
            userId="me",
            id=gmail_message_id,
            body={"removeLabelIds": ["INBOX"]},
        )
        .execute()
    )


def get_user_by_email(session: Session, email: str) -> User | None:
    return session.exec(
        select(User).where(User.email == email.strip().lower())
    ).first()


def safe_text(value: object) -> str:
    if value is None:
        return "—"
    text = str(value).strip()
    return text if text else "—"


def normalize_quote_items(items: list[QuoteLineItem]) -> tuple[list[dict], float]:
    normalized: list[dict] = []
    subtotal = 0.0
    for item in items:
        quantity = float(item.quantity or 0)
        unit_price = float(item.unit_price or 0)
        total = round(quantity * unit_price, 2)
        normalized_item = {
            "name": item.name,
            "description": item.description,
            "quantity": quantity,
            "unit": item.unit,
            "unit_price": unit_price,
            "total": total,
        }
        normalized.append(normalized_item)
        subtotal += total
    return normalized, round(subtotal, 2)


def quote_proposal_to_response(proposal: QuoteProposal) -> QuoteProposalResponse:
    return QuoteProposalResponse(
        message_id=proposal.message_id,
        title=proposal.title,
        currency=proposal.currency,
        client_name=proposal.client_name,
        project_name=proposal.project_name,
        site_address=proposal.site_address,
        intro_text=proposal.intro_text,
        scope_items=[QuoteLineItem(**item) for item in (proposal.scope_items_json or [])],
        exclusions_text=proposal.exclusions_text,
        validity_days=proposal.validity_days,
        payment_terms=proposal.payment_terms,
        discount_amount=proposal.discount_amount,
        subtotal=proposal.subtotal,
        total_amount=proposal.total_amount,
        # NEW lifecycle fields
        quote_status=proposal.quote_status or "draft",
        sent_at=proposal.sent_at,
        responded_at=proposal.responded_at,
    )


def register_pdf_fonts() -> tuple[str, str]:
    """
    Registers Unicode fonts for Croatian characters.
    Returns (regular_font_name, bold_font_name).
    """
    regular_path = os.getenv("PDF_FONT_REGULAR")
    bold_path = os.getenv("PDF_FONT_BOLD")
    if not regular_path:
        regular_path = r"C:\Windows\Fonts\arial.ttf"
    if not bold_path:
        bold_path = r"C:\Windows\Fonts\arialbd.ttf"
    if not Path(regular_path).exists():
        raise RuntimeError(f"PDF regular font not found: {regular_path}")
    if not Path(bold_path).exists():
        raise RuntimeError(f"PDF bold font not found: {bold_path}")
    regular_name = "AppFont"
    bold_name = "AppFontBold"
    try:
        pdfmetrics.getFont(regular_name)
    except KeyError:
        pdfmetrics.registerFont(TTFont(regular_name, regular_path))
    try:
        pdfmetrics.getFont(bold_name)
    except KeyError:
        pdfmetrics.registerFont(TTFont(bold_name, bold_path))
    return regular_name, bold_name


# NEW: Client-facing quote proposal PDF
def build_quote_proposal_pdf_bytes(proposal: QuoteProposal) -> bytes:
    buffer = BytesIO()
    regular_font, bold_font = register_pdf_fonts()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm,
        topMargin=20 * mm, bottomMargin=20 * mm,
    )
    styles = getSampleStyleSheet()
    currency = proposal.currency or "EUR"

    title_style = ParagraphStyle("QTitle", fontName=bold_font, fontSize=22, leading=28, textColor=colors.HexColor("#0F172A"))
    heading_style = ParagraphStyle("QH", fontName=bold_font, fontSize=12, leading=16, textColor=colors.HexColor("#0F172A"), spaceBefore=14, spaceAfter=6)
    body_style = ParagraphStyle("QBody", fontName=regular_font, fontSize=10, leading=15, textColor=colors.HexColor("#334155"))
    small_label = ParagraphStyle("QLabel", fontName=bold_font, fontSize=8, leading=10, textColor=colors.HexColor("#94A3B8"), spaceAfter=2)
    value_style = ParagraphStyle("QVal", fontName=regular_font, fontSize=10, leading=14, textColor=colors.HexColor("#0F172A"))
    footer_style = ParagraphStyle("QFoot", fontName=regular_font, fontSize=9, leading=13, textColor=colors.HexColor("#94A3B8"))

    story = []

    # Header
    story.append(Paragraph(proposal.title or "Electrical Works Proposal", title_style))
    story.append(Spacer(1, 8))

    # Client info summary table
    header_data = [
        [Paragraph("Client", small_label), Paragraph("Project", small_label),
         Paragraph("Site address", small_label), Paragraph("Date", small_label)],
        [Paragraph(safe_text(proposal.client_name), value_style),
         Paragraph(safe_text(proposal.project_name), value_style),
         Paragraph(safe_text(proposal.site_address), value_style),
         Paragraph(datetime.utcnow().strftime("%d.%m.%Y"), value_style)],
    ]
    col_w = [42 * mm, 52 * mm, 52 * mm, 28 * mm]
    header_table = Table(header_data, colWidths=col_w)
    header_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F8FAFC")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#E2E8F0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(header_table)

    # Intro text
    if proposal.intro_text:
        story.append(Paragraph("Overview", heading_style))
        story.append(Paragraph(proposal.intro_text, body_style))

    # Scope of work table
    story.append(Paragraph("Scope of Work", heading_style))
    scope_items = proposal.scope_items_json or []
    if scope_items:
        table_data = [[
            Paragraph("Item", small_label),
            Paragraph("Description", small_label),
            Paragraph("Qty", small_label),
            Paragraph("Unit", small_label),
            Paragraph("Unit price", small_label),
            Paragraph("Total", small_label),
        ]]
        for item in scope_items:
            table_data.append([
                Paragraph(str(item.get("name", "")), body_style),
                Paragraph(str(item.get("description", "") or ""), body_style),
                Paragraph(str(item.get("quantity", 1)), body_style),
                Paragraph(str(item.get("unit", "")), body_style),
                Paragraph(f"{float(item.get('unit_price', 0)):.2f}", body_style),
                Paragraph(f"{float(item.get('total', 0)):.2f}", body_style),
            ])
        col_widths = [45 * mm, 50 * mm, 15 * mm, 15 * mm, 25 * mm, 24 * mm]
        scope_table = Table(table_data, colWidths=col_widths)
        scope_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2563EB")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), bold_font),
            ("FONTNAME", (0, 1), (-1, -1), regular_font),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8FAFC")]),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
            ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#E2E8F0")),
            ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 7),
            ("RIGHTPADDING", (0, 0), (-1, -1), 7),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.append(scope_table)
    else:
        story.append(Paragraph("No scope items defined.", body_style))

    # Totals
    story.append(Spacer(1, 8))
    totals_data = [
        [Paragraph("Subtotal", body_style), Paragraph(f"{proposal.subtotal:.2f} {currency}", body_style)],
    ]
    if proposal.discount_amount:
        totals_data.append([
            Paragraph("Discount", body_style),
            Paragraph(f"- {proposal.discount_amount:.2f} {currency}", body_style),
        ])
    totals_data.append([
        Paragraph("TOTAL", ParagraphStyle("TL", fontName=bold_font, fontSize=11, textColor=colors.HexColor("#0F172A"))),
        Paragraph(f"{proposal.total_amount:.2f} {currency}", ParagraphStyle("TV", fontName=bold_font, fontSize=11, textColor=colors.HexColor("#2563EB"))),
    ])
    totals_table = Table(totals_data, colWidths=[130 * mm, 44 * mm])
    totals_table.setStyle(TableStyle([
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("LINEABOVE", (0, -1), (-1, -1), 1, colors.HexColor("#CBD5E1")),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(totals_table)

    if proposal.exclusions_text:
        story.append(Paragraph("Exclusions &amp; Conditions", heading_style))
        story.append(Paragraph(proposal.exclusions_text, body_style))

    if proposal.payment_terms:
        story.append(Paragraph("Payment Terms", heading_style))
        story.append(Paragraph(proposal.payment_terms, body_style))

    story.append(Spacer(1, 16))
    story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#E2E8F0")))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        f"This proposal is valid for {proposal.validity_days} days from the date of issue. "
        "Prices are subject to final scope confirmation and site inspection.",
        footer_style,
    ))

    doc.build(story)
    pdf_bytes = buffer.getvalue()
    buffer.close()
    return pdf_bytes


def build_quote_brief_pdf_bytes(session: Session, message: Message) -> bytes:
    brief = build_electrical_quote_brief(session, message)
    notes_text = get_message_notes_text(session, message.id)
    documents_text = get_message_documents_text(session, message.id)

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
    )

    styles = getSampleStyleSheet()
    regular_font, bold_font = register_pdf_fonts()
    title_style = ParagraphStyle(
        "CustomTitle", parent=styles["Title"], fontName=bold_font, fontSize=18, leading=22)
    heading_style = ParagraphStyle(
        "CustomHeading", parent=styles["Heading2"], fontName=bold_font, fontSize=12, leading=15)
    normal_style = ParagraphStyle(
        "CustomBody", parent=styles["BodyText"], fontName=regular_font, fontSize=10, leading=14)
    small_label = ParagraphStyle(
        "SmallLabel", parent=styles["BodyText"], fontName=regular_font, fontSize=9,
        textColor=colors.HexColor("#64748b"), spaceAfter=2)
    value_style = ParagraphStyle(
        "ValueStyle", parent=styles["BodyText"], fontName=regular_font, fontSize=10,
        textColor=colors.HexColor("#0f172a"), leading=14)

    story = []
    story.append(Paragraph("Elesys – Brief za upit", title_style))
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        "Automatski pripremljen pregled upita za elektroinstalacije / terenski izvid / izradu ponude.",
        normal_style,
    ))
    story.append(Spacer(1, 10))

    summary_table_data = [
        [Paragraph("Client", small_label), Paragraph(safe_text(brief.client_name), value_style),
         Paragraph("Email", small_label), Paragraph(safe_text(brief.client_email), value_style)],
        [Paragraph("Phone", small_label), Paragraph(safe_text(brief.client_phone), value_style),
         Paragraph("Location", small_label), Paragraph(safe_text(brief.location), value_style)],
        [Paragraph("Object type", small_label), Paragraph(safe_text(brief.object_type), value_style),
         Paragraph("Timeline", small_label), Paragraph(safe_text(brief.timeline), value_style)],
        [Paragraph("Budget", small_label), Paragraph(safe_text(brief.budget), value_style),
         Paragraph("Urgency", small_label), Paragraph(safe_text(brief.urgency), value_style)],
        [Paragraph("Installation type", small_label), Paragraph(safe_text(brief.installation_type), value_style),
         Paragraph("Priority", small_label), Paragraph(safe_text(brief.lead_priority.value), value_style)],
    ]

    summary_table = Table(summary_table_data, colWidths=[28 * mm, 57 * mm, 28 * mm, 57 * mm])
    summary_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
        ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#cbd5e1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(summary_table)
    story.append(Spacer(1, 12))

    story.append(Paragraph("Estimator Summary", heading_style))
    story.append(Paragraph(safe_text(brief.estimator_summary), normal_style))
    story.append(Spacer(1, 10))

    story.append(Paragraph("Recommended Next Step", heading_style))
    story.append(Paragraph(safe_text(brief.recommended_next_step), normal_style))
    story.append(Spacer(1, 10))

    story.append(Paragraph("Missing Technical Details", heading_style))
    if brief.missing_fields:
        for item in brief.missing_fields:
            story.append(Paragraph(f"• {safe_text(item)}", normal_style))
    else:
        story.append(Paragraph("No critical missing details detected.", normal_style))
    story.append(Spacer(1, 10))

    story.append(Paragraph("Attachments / Documents", heading_style))
    for line in safe_text(documents_text).split("\n"):
        story.append(Paragraph(line, normal_style))
    story.append(Spacer(1, 10))

    story.append(Paragraph("Attachment Summary", heading_style))
    story.append(Paragraph(safe_text(brief.attachments_summary), normal_style))
    story.append(Spacer(1, 10))

    story.append(Paragraph("Internal Notes", heading_style))
    for block in safe_text(notes_text).split("\n\n"):
        story.append(Paragraph(block.replace("\n", "<br/>"), normal_style))
        story.append(Spacer(1, 4))

    doc.build(story)
    pdf_bytes = buffer.getvalue()
    buffer.close()
    return pdf_bytes


def hash_password(password: str) -> str:
    return password_hash.hash(password)


def verify_password(password: str, hashed_password: str) -> bool:
    return password_hash.verify(password, hashed_password)


def parse_json_list(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
    except Exception:
        pass
    return []


def list_to_json(values: list[str]) -> str:
    cleaned = [str(v).strip() for v in values if str(v).strip()]
    return json.dumps(cleaned)


def get_or_create_company_settings(session: Session) -> CompanySettings:
    settings = session.exec(select(CompanySettings)).first()
    if settings:
        return settings
    settings = CompanySettings()
    session.add(settings)
    session.commit()
    session.refresh(settings)
    return settings


def extract_phone_number_from_text(text: str) -> str | None:
    if not text:
        return None
    patterns = [
        r"(\+385[\s/-]?\d{1,2}[\s/-]?\d{3}[\s/-]?\d{3,4})",
        r"(0\d{1,2}[\s/-]?\d{3}[\s/-]?\d{3,4})",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return match.group(1).strip()
    return None


def build_electrical_quote_brief(session: Session, message: Message) -> ElectricalQuoteBrief:
    context = build_message_context(session, message)
    qualification = ai_qualify_electrical_lead(context)
    client_name = message.sender_name or None
    client_email = message.sender_email or None
    client_phone = extract_phone_number_from_text(message.body_text or "")
    estimator_summary = (
        f"{qualification.service_label} | "
        f"Prioritet: {qualification.lead_priority.value} | "
        f"Lokacija: {qualification.location or 'nije navedena'} | "
        f"Rok: {qualification.timeline or 'nije naveden'} | "
        f"Budžet: {qualification.budget or 'nije naveden'}"
    )
    return ElectricalQuoteBrief(
        service_type=qualification.service_type,
        service_label=qualification.service_label,
        lead_priority=qualification.lead_priority,
        lead_score=qualification.lead_score,
        current_workflow_status=message.status.value,
        client_name=client_name,
        client_email=client_email,
        client_phone=client_phone,
        location=qualification.location,
        object_type=qualification.object_type,
        budget=qualification.budget,
        timeline=qualification.timeline,
        urgency=qualification.urgency,
        installation_type=qualification.installation_type,
        attachments_summary=qualification.attachments_summary,
        missing_fields=qualification.missing_fields,
        recommended_next_step=qualification.recommended_next_step,
        estimator_summary=estimator_summary,
    )


def build_tone_instruction(tone: ReplyTone) -> str:
    if tone == ReplyTone.friendly:
        return "Write in a friendly, approachable tone."
    if tone == ReplyTone.concise:
        return "Write in a concise, direct tone."
    if tone == ReplyTone.warm:
        return "Write in a warm, helpful, personable tone."
    return "Write in a professional, helpful tone."


def build_company_style_context(settings: CompanySettingsRead) -> str:
    return (
        f"Company name: {settings.company_name}\n"
        f"Preferred reply tone: {settings.preferred_reply_tone.value}\n"
        f"Reply signature:\n{settings.reply_signature}\n"
        f"{build_tone_instruction(settings.preferred_reply_tone)}"
    )


def company_settings_to_read(settings: CompanySettings) -> CompanySettingsRead:
    return CompanySettingsRead(
        company_name=settings.company_name,
        preferred_reply_tone=settings.preferred_reply_tone,
        reply_signature=settings.reply_signature,
        ignore_senders=parse_json_list(settings.ignore_senders_json),
        quote_required_fields=parse_json_list(settings.quote_required_fields_json),
    )


QUOTE_FIELD_LABELS = {
    "requested_service": "Requested service",
    "project_type": "Project type",
    "company_name": "Company name",
    "website_url": "Website URL",
    "budget": "Budget",
    "timeline": "Timeline",
    "location": "Location",
    "pages_needed": "Pages needed",
    "business_goals": "Business goals",
}

ELECTRICAL_REQUIRED_FIELDS = {
    ElectricalServiceType.strong_current: [
        "location", "object_type", "timeline", "scope_of_work",
    ],
    ElectricalServiceType.weak_current: [
        "location", "object_type", "system_type", "scope_of_work",
    ],
    ElectricalServiceType.solar: [
        "location", "object_type", "roof_or_ground",
        "estimated_consumption", "budget", "timeline",
    ],
    ElectricalServiceType.maintenance: [
        "location", "urgency", "issue_description",
    ],
    ElectricalServiceType.project_design: [
        "location", "object_type", "project_scope", "timeline",
    ],
}


def is_quote_category(category: object) -> bool:
    value = str(getattr(category, "value", category)).lower()
    return value in {"quote_request", "quote"}


def is_missing_value(value: object) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, list):
        return len([v for v in value if str(v).strip()]) == 0
    return False


def get_missing_required_fields(extracted_data: dict, required_fields: list[str]) -> list[str]:
    missing: list[str] = []
    for field in required_fields:
        value = extracted_data.get(field)
        if is_missing_value(value):
            missing.append(QUOTE_FIELD_LABELS.get(field, field.replace("_", " ").title()))
    return missing


def merge_missing_information(extracted_data: dict, required_fields: list[str]) -> list[str]:
    ai_missing = extracted_data.get("missing_information") or []
    required_missing = get_missing_required_fields(extracted_data, required_fields)
    merged: list[str] = []
    for item in [*ai_missing, *required_missing]:
        label = str(item).strip()
        if label and label not in merged:
            merged.append(label)
    return merged


def create_access_token(subject: str, role: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": subject, "role": role, "exp": expire}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(token: str = Depends(oauth2_scheme)) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get("sub")
        if not email:
            raise credentials_exception
    except InvalidTokenError:
        raise credentials_exception
    with Session(engine, expire_on_commit=False) as session:
        user = get_user_by_email(session, email)
        if not user or not user.is_active:
            raise credentials_exception
        return user


def require_roles(*allowed_roles: UserRole):
    def dependency(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role not in allowed_roles:
            raise HTTPException(status_code=403, detail="Not enough permissions")
        return current_user
    return dependency


def actor_name_for(user: User) -> str:
    return user.full_name.strip() or user.email


def append_customer_reply_to_message(
    session: Session,
    *,
    message: Message,
    new_subject: str,
    new_sender_name: str | None,
    new_sender_email: str,
    new_body_text: str,
) -> None:
    existing = (message.body_text or "").strip()
    incoming = truncate_body((new_body_text or "").strip())
    separator = "\n\n--- CUSTOMER REPLY ---\n"
    if incoming:
        combined = f"{existing}{separator}{incoming}" if existing else incoming
        message.body_text = truncate_body(combined)
    if new_subject:
        message.subject = new_subject
    if new_sender_name:
        message.sender_name = new_sender_name
    if new_sender_email:
        message.sender_email = new_sender_email
    if message.status == MessageStatus.waiting_for_info:
        message.status = MessageStatus.needs_review
    message.updated_at = datetime.utcnow()
    message.gmail_synced_at = datetime.utcnow()
    session.add(message)
    session.commit()
    session.refresh(message)


def get_local_message_by_gmail_thread(session: Session, gmail_thread_id: str) -> Message | None:
    return session.exec(
        select(Message)
        .where(Message.gmail_thread_id == gmail_thread_id)
        .order_by(Message.created_at.asc())
    ).first()


def get_latest_draft_for_message(session: Session, message_id: int) -> Draft | None:
    return session.exec(
        select(Draft)
        .where(Draft.message_id == message_id)
        .order_by(Draft.updated_at.desc(), Draft.created_at.desc())
    ).first()


def ocr_image_bytes(file_bytes: bytes) -> str | None:
    try:
        image = Image.open(io.BytesIO(file_bytes))
        text = pytesseract.image_to_string(image).strip()
        return text or None
    except Exception:
        return None


def ocr_pdf_bytes(file_bytes: bytes) -> str | None:
    try:
        doc = fitz.open(stream=file_bytes, filetype="pdf")
        pages_text: list[str] = []
        for page in doc:
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
            img_bytes = pix.tobytes("png")
            image = Image.open(io.BytesIO(img_bytes))
            page_text = pytesseract.image_to_string(image).strip()
            if page_text:
                pages_text.append(page_text)
        combined = "\n\n".join(pages_text).strip()
        return combined or None
    except Exception:
        return None


def get_gmail_import_metadata(session: Session, message_id: int) -> dict | None:
    log = session.exec(
        select(AuditLog)
        .where(AuditLog.message_id == message_id, AuditLog.action == "gmail_imported")
        .order_by(AuditLog.created_at.desc())
    ).first()
    if not log or not log.metadata_json:
        return None
    try:
        return json.loads(log.metadata_json)
    except Exception:
        return None


def count_urls(text: str) -> int:
    return len(re.findall(r"https?://|www\.", text or "", flags=re.IGNORECASE))


def should_auto_ignore_message(
    *,
    subject: str,
    sender_email: str,
    body_text: str,
    custom_ignore_senders: list[str] | None = None,
) -> tuple[bool, str | None]:
    subject_l = (subject or "").lower()
    sender_l = (sender_email or "").lower()
    custom_ignore_senders = custom_ignore_senders or []
    if any(pattern.lower().strip() in sender_l for pattern in custom_ignore_senders if pattern.strip()):
        return True, "custom_ignore_sender"
    body_l = (body_text or "").lower()
    ignored_sender_fragments = [
        "noreply", "no-reply", "newsletter", "fashionnews", "marketing",
        "mailer", "digest", "updates@", "notification@", "notifications@",
        "jobs-listings@", "quora.com", "linkedin.com",
    ]
    if any(part in sender_l for part in ignored_sender_fragments):
        return True, "ignored_sender_pattern"
    newsletter_phrases = [
        "unsubscribe", "manage preferences", "email preferences",
        "view in browser", "why did i get this email",
        "update your preferences", "privacy policy", "terms of service",
    ]
    if sum(1 for phrase in newsletter_phrases if phrase in body_l) >= 2:
        return True, "newsletter_pattern"
    promo_subject_keywords = [
        "sale", "discount", "special offer", "limited time", "shop now",
        "save big", "new arrivals", "wishlist", "price drop", "up to ",
        "% off", "deal", "promo", "coupon", "now hiring", "job alert", "digest",
    ]
    if any(word in subject_l for word in promo_subject_keywords):
        return True, "promotional_subject"
    if count_urls(body_text) >= 6:
        return True, "too_many_links"
    if len(body_l) < 40 and count_urls(body_text) >= 2:
        return True, "short_link_heavy_message"
    actionable_keywords = [
        "quote", "pricing", "proposal", "project", "website", "web design",
        "invoice", "contract", "deadline", "support", "help", "issue",
        "problem", "meeting", "call", "client", "budget", "timeline",
    ]
    if any(word in subject_l for word in actionable_keywords):
        return False, None
    if any(word in body_l for word in actionable_keywords):
        return False, None
    return False, None


def triage_score(*, subject: str, sender_email: str, body_text: str) -> int:
    score = 0
    subject_l = (subject or "").lower()
    sender_l = (sender_email or "").lower()
    body_l = (body_text or "").lower()
    positive_keywords = [
        "quote", "pricing", "proposal", "project", "website", "budget",
        "timeline", "support", "issue", "help", "meeting", "client",
        "invoice", "contract",
    ]
    negative_keywords = [
        "unsubscribe", "sale", "discount", "promo", "wishlist",
        "price drop", "digest", "now hiring", "job alert",
    ]
    for word in positive_keywords:
        if word in subject_l:
            score += 3
        if word in body_l:
            score += 1
    for word in negative_keywords:
        if word in subject_l:
            score -= 3
        if word in body_l:
            score -= 1
    if "noreply" in sender_l or "no-reply" in sender_l:
        score -= 3
    if count_urls(body_text) >= 6:
        score -= 2
    return score


def sanitize_filename(filename: str) -> str:
    keep = []
    for ch in filename:
        if ch.isalnum() or ch in (" ", ".", "_", "-"):
            keep.append(ch)
        else:
            keep.append("_")
    return "".join(keep).strip() or "attachment"


def extract_text_from_file_bytes(filename: str, mime_type: str | None, file_bytes: bytes) -> str | None:
    lower_name = filename.lower()
    mime_type = mime_type or ""
    try:
        if lower_name.endswith(".pdf") or mime_type == "application/pdf":
            reader = PdfReader(io.BytesIO(file_bytes))
            pages: list[str] = []
            for page in reader.pages:
                pages.append(page.extract_text() or "")
            text = "\n".join(pages).strip()
            if text:
                return text
            return ocr_pdf_bytes(file_bytes)
        if (lower_name.endswith(".txt") or lower_name.endswith(".md")
                or lower_name.endswith(".csv") or mime_type.startswith("text/")):
            text = file_bytes.decode("utf-8", errors="ignore").strip()
            return text or None
        if (lower_name.endswith(".png") or lower_name.endswith(".jpg")
                or lower_name.endswith(".jpeg") or lower_name.endswith(".webp")
                or mime_type.startswith("image/")):
            return ocr_image_bytes(file_bytes)
    except Exception:
        return None
    return None


def walk_message_parts(parts: list[dict] | None) -> list[dict]:
    if not parts:
        return []
    found: list[dict] = []
    for part in parts:
        found.append(part)
        child_parts = part.get("parts") or []
        found.extend(walk_message_parts(child_parts))
    return found


def fetch_attachment_bytes(service, gmail_message_id: str, part: dict) -> bytes | None:
    body = part.get("body") or {}
    if body.get("data"):
        return base64.urlsafe_b64decode(body["data"] + "=" * (-len(body["data"]) % 4))
    attachment_id = body.get("attachmentId")
    if not attachment_id:
        return None
    attachment = (
        service.users()
        .messages()
        .attachments()
        .get(userId="me", messageId=gmail_message_id, id=attachment_id)
        .execute()
    )
    data = attachment.get("data")
    if not data:
        return None
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def import_gmail_attachments_for_message(
    service,
    session: Session,
    *,
    gmail_message: dict,
    local_message_id: int,
) -> int:
    payload = gmail_message.get("payload", {}) or {}
    all_parts = walk_message_parts(payload.get("parts") or [])
    imported_count = 0
    gmail_message_id = gmail_message.get("id")
    for part in all_parts:
        filename = (part.get("filename") or "").strip()
        if not filename:
            continue
        mime_type = part.get("mimeType") or "application/octet-stream"
        file_bytes = fetch_attachment_bytes(service, gmail_message_id, part)
        if not file_bytes:
            continue
        safe_name = sanitize_filename(filename)
        stored_name = f"{datetime.utcnow().strftime('%Y%m%d%H%M%S%f')}_{safe_name}"
        stored_path = UPLOAD_DIR / stored_name
        stored_path.write_bytes(file_bytes)
        extracted_text = extract_text_from_file_bytes(filename, mime_type, file_bytes)
        doc = Document(
            message_id=local_message_id,
            filename=filename,
            file_type=mime_type,
            storage_path=str(stored_path),
            extracted_text=extracted_text,
        )
        session.add(doc)
        session.commit()
        session.refresh(doc)
        log_action(
            session,
            local_message_id,
            "gmail_attachment_imported",
            "gmail_sync",
            metadata_json=json.dumps({
                "filename": filename,
                "mime_type": mime_type,
                "document_id": doc.id,
                "extracted_text_length": len(extracted_text) if extracted_text else 0,
            }),
        )
        imported_count += 1
    return imported_count


def build_gmail_raw_message(
    *,
    to_email: str,
    subject: str,
    body_text: str,
    thread_id: str | None = None,
    in_reply_to: str | None = None,
    references: str | None = None,
) -> dict:
    message = EmailMessage()
    message["To"] = to_email
    message["Subject"] = subject
    if in_reply_to:
        message["In-Reply-To"] = in_reply_to
    if references:
        message["References"] = references
    message.set_content(body_text)
    raw = base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")
    payload = {"raw": raw}
    if thread_id:
        payload["threadId"] = thread_id
    return payload


def get_gmail_service():
    creds = load_google_credentials()
    if creds is None or not creds.valid:
        raise HTTPException(status_code=401, detail="Gmail is not connected")
    return build("gmail", "v1", credentials=creds)


def extract_header(headers: list[dict], name: str) -> str | None:
    for header in headers:
        if header.get("name", "").lower() == name.lower():
            return header.get("value")
    return None


def decode_gmail_body_data(data: str | None) -> str:
    if not data:
        return ""
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded.encode("utf-8")).decode("utf-8", errors="ignore")


def extract_plain_text_from_payload(payload: dict | None) -> str:
    if not payload:
        return ""
    mime_type = payload.get("mimeType", "")
    body = payload.get("body", {}) or {}
    data = body.get("data")
    if mime_type == "text/plain" and data:
        return decode_gmail_body_data(data)
    parts = payload.get("parts", []) or []
    for part in parts:
        if part.get("mimeType") == "text/plain":
            part_data = (part.get("body") or {}).get("data")
            if part_data:
                return decode_gmail_body_data(part_data)
    for part in parts:
        nested = extract_plain_text_from_payload(part)
        if nested.strip():
            return nested
    if data:
        return decode_gmail_body_data(data)
    return ""


def get_imported_gmail_ids(session: Session) -> set[str]:
    logs = session.exec(
        select(AuditLog).where(
            AuditLog.action.in_(["gmail_imported", "customer_reply_synced"])
        )
    ).all()
    ids: set[str] = set()
    for log in logs:
        if not log.metadata_json:
            continue
        try:
            meta = json.loads(log.metadata_json)
            gmail_id = meta.get("gmail_message_id")
            if gmail_id:
                ids.add(gmail_id)
        except Exception:
            pass
    return ids


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


def get_message_notes_text(session: Session, message_id: int) -> str:
    try:
        notes = session.exec(
            select(InternalNote)
            .where(InternalNote.message_id == message_id)
            .order_by(InternalNote.created_at.desc())
        ).all()
    except Exception:
        return "—"
    if not notes:
        return "—"
    parts: list[str] = []
    for note in notes:
        author = note.author or "Unknown"
        created = note.created_at.strftime("%d.%m.%Y %H:%M") if note.created_at else ""
        parts.append(f"{author} ({created}): {note.note_text}")
    return "\n\n".join(parts)


def get_message_documents_text(session: Session, message_id: int) -> str:
    try:
        docs = session.exec(
            select(Document)
            .where(Document.message_id == message_id)
            .order_by(Document.created_at.desc())
        ).all()
    except Exception:
        return "—"
    if not docs:
        return "—"
    return "\n".join(
        f"- {doc.filename} ({doc.file_type or 'unknown'})"
        for doc in docs
    )


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
        truncate_body(message.body_text),
        "",
        f"ATTACHMENT COUNT: {len(docs)}",
    ]
    for i, doc in enumerate(docs, start=1):
        extracted = truncate_body((doc.extracted_text or "").strip(), max_chars=6000)
        parts.extend([
            "",
            f"ATTACHMENT {i}",
            f"Filename: {doc.filename}",
            f"File type: {doc.file_type or 'unknown'}",
            "ATTACHED DOCUMENT TEXT:",
            extracted if extracted else "[NO EXTRACTED TEXT AVAILABLE]",
        ])
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
            {"role": "user", "content": f"Classify this inbound message.\n\nSubject: {subject}\n\nContext:\n{context}"},
        ],
        text_format=ClassificationOutput,
    )
    parsed = response.output_parsed
    if parsed is None:
        raise HTTPException(status_code=500, detail="AI classification returned no structured output.")
    parsed.confidence = clamp_confidence(parsed.confidence)
    return parsed


def ai_qualify_electrical_lead(context: str) -> ElectricalQualification:
    client = get_openai_client()
    prompt = f"""
You are qualifying inbound leads for an electrical installations company in Croatia.

Classify the inquiry into one of these service types:
- strong_current
- weak_current
- solar
- maintenance
- project_design
- unknown

Return:
- service_type
- service_label in Croatian
- object_type
- location
- budget
- timeline
- urgency
- power_capacity
- installation_type
- attachments_summary
- lead_priority
- lead_score from 1 to 100
- missing_fields as a list
- recommended_next_step
- client_summary

Rules:
- Use Croatian labels when possible.
- Focus on practical sales qualification for electrical works.
- If details are vague, mark lead_priority as needs_info or low_detail.
- If message clearly describes a real project with location/scope/timeline, score it higher.
- Missing fields should be concise and useful.
- recommended_next_step should be one short action.

Context:
{context}
"""
    response = client.responses.parse(
        model=get_model_name(),
        input=prompt,
        text_format=ElectricalQualification,
    )
    parsed = response.output_parsed
    if parsed is None:
        raise HTTPException(status_code=500, detail="AI qualification returned no structured output.")
    return parsed


def ai_extract_fields(category: MessageCategory, context: str) -> ExtractionOutput:
    client = get_openai_client()
    response = client.responses.parse(
        model=get_model_name(),
        reasoning={"effort": "none"},
        input=[
            {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
            {"role": "user", "content": (
                f"Category: {category.value}\n\n"
                "Extract structured business fields from the inbound message below.\n\n"
                "IMPORTANT:\n"
                "- If ATTACHED DOCUMENT TEXT is present, use it as a primary source.\n"
                "- For quote requests, pull as many concrete project details as possible from the attached document.\n"
                "- Do NOT say the brief is missing if attached-document text is already present.\n\n"
                f"{context}"
            )},
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
            {"role": "user", "content": (
                f"Category: {category.value}\n"
                f"Sender name: {sender_name or 'there'}\n\n"
                "IMPORTANT:\n"
                "- If ATTACHED DOCUMENT TEXT exists, assume the brief was received.\n"
                "- Do NOT ask the sender to resend an attachment if its contents are already present.\n"
                "- For quote requests, mention known details like service, budget, timeline, website URL, or scope when available.\n"
                "- Use missing_information only if those details are actually missing.\n\n"
                f"Extracted fields JSON:\n{extracted.model_dump_json(indent=2)}\n\n"
                f"{context}\n\n"
                "Write the best reply draft."
            )},
        ],
        text_format=DraftOutput,
    )
    parsed = response.output_parsed
    if parsed is None:
        raise HTTPException(status_code=500, detail="AI drafting returned no structured output.")
    return parsed


def merge_unique_strings(*lists: list[str]) -> list[str]:
    merged: list[str] = []
    for values in lists:
        for value in values:
            item = str(value).strip()
            if item and item not in merged:
                merged.append(item)
    return merged


def build_electrical_missing_info_guidance(qualification: ElectricalQualification) -> str:
    service_type = qualification.service_type
    if service_type == ElectricalServiceType.strong_current:
        return (
            "Lead je za elektroinstalacije jake struje.\n"
            "Ako nešto nedostaje, prioritetno traži:\n"
            "- tlocrt ili nacrt objekta\n"
            "- broj prostorija i planirane točke rasvjete/utičnica\n"
            "- je li riječ o novogradnji ili adaptaciji\n"
            "- priključnu snagu objekta ako je poznata\n"
            "- detalje za EV punjač ako se spominje\n"
            "Piši kao profesionalan izvođač elektroinstalacija u Hrvatskoj."
        )
    if service_type == ElectricalServiceType.weak_current:
        return (
            "Lead je za instalacije slabe struje.\n"
            "Ako nešto nedostaje, prioritetno traži:\n"
            "- vrstu sustava (video nadzor, alarm, parlafon, mreža, kontrola pristupa)\n"
            "- broj uređaja/točaka\n"
            "- stanje postojeće infrastrukture i kabliranja\n"
            "- tlocrt ili fotografije prostora\n"
            "Piši jasno, tehnički i profesionalno."
        )
    if service_type == ElectricalServiceType.solar:
        return (
            "Lead je za solarnu elektranu.\n"
            "Ako nešto nedostaje, prioritetno traži:\n"
            "- adresu/lokaciju objekta\n"
            "- je li montaža na krovu ili na tlu\n"
            "- približnu godišnju ili mjesečnu potrošnju električne energije\n"
            "- fotografije krova ili dokumentaciju objekta\n"
            "- vrstu objekta i okvirni budžet\n"
            "Piši profesionalno i praktično, kao tvrtka koja priprema ponudu za fotonaponski sustav."
        )
    if service_type == ElectricalServiceType.maintenance:
        return (
            "Lead je za održavanje ili intervenciju.\n"
            "Ako nešto nedostaje, prioritetno traži:\n"
            "- točan opis kvara ili problema\n"
            "- lokaciju objekta\n"
            "- hitnost intervencije\n"
            "- termin dostupnosti na lokaciji\n"
            "Piši kratko, jasno i usmjereno na dogovor sljedećeg koraka."
        )
    if service_type == ElectricalServiceType.project_design:
        return (
            "Lead je za projektiranje ili automatizaciju.\n"
            "Ako nešto nedostaje, prioritetno traži:\n"
            "- opis projekta i cilja\n"
            "- vrstu objekta\n"
            "- postojeću dokumentaciju\n"
            "- planirani rok\n"
            "- budžet ili okvir opsega\n"
            "Piši profesionalno i konzultativno."
        )
    return (
        "Ako je riječ o tehničkom elektro upitu, zatraži samo ključne informacije "
        "potrebne za izradu ponude ili dogovor sljedećeg koraka."
    )


def ai_draft_missing_info(
    category: MessageCategory,
    sender_name: Optional[str],
    extracted: ExtractionOutput,
    context: str,
) -> DraftOutput:
    client = get_openai_client()
    qualification: ElectricalQualification | None = None
    electrical_guidance = ""
    qualification_missing_fields: list[str] = []
    try:
        qualification = ai_qualify_electrical_lead(context)
        qualification_missing_fields = qualification.missing_fields or []
        electrical_guidance = build_electrical_missing_info_guidance(qualification)
    except Exception:
        qualification = None
        qualification_missing_fields = []
        electrical_guidance = ""
    extracted_missing = extracted.missing_information or []
    merged_missing = merge_unique_strings(extracted_missing, qualification_missing_fields)
    response = client.responses.parse(
        model=get_model_name(),
        reasoning={"effort": "none"},
        input=[
            {"role": "system", "content": (
                MISSING_INFO_DRAFT_SYSTEM_PROMPT
                + "\n\nDODATNA PRAVILA:\n"
                + "- Ako je upit tehnički i vezan za elektroinstalacije, solar, održavanje ili slabu/jaku struju, odgovor piši na hrvatskom jeziku.\n"
                + "- Ton neka bude profesionalan, jasan i poslovan.\n"
                + "- Ne nabrajaj nepotrebne informacije koje već postoje u upitu.\n"
                + "- Traži samo podatke koji zaista nedostaju za kvalifikaciju ili pripremu ponude.\n"
                + "- Ako je upit dovoljno kompletan, reci da zahtjev izgleda dovoljno kompletno za daljnji pregled i pripremu ponude.\n"
            )},
            {"role": "user", "content": (
                f"Category: {category.value}\n"
                f"Sender name: {sender_name or 'there'}\n\n"
                "IMPORTANT:\n"
                "- Only ask for the items listed in FINAL_MISSING_INFORMATION.\n"
                "- If FINAL_MISSING_INFORMATION is empty, write a short reply saying the request looks complete enough to review for a quote.\n"
                "- If ATTACHED DOCUMENT TEXT exists, assume the attachment was received and reviewed.\n"
                "- If the inquiry is clearly electrical/solar/technical, prefer Croatian.\n"
                "- Keep the email concise and natural.\n\n"
                f"Electrical qualification JSON:\n"
                f"{qualification.model_dump_json(indent=2) if qualification else 'null'}\n\n"
                f"Service-specific drafting guidance:\n{electrical_guidance or 'No special electrical guidance.'}\n\n"
                f"Extracted fields JSON:\n{extracted.model_dump_json(indent=2)}\n\n"
                f"FINAL_MISSING_INFORMATION:\n{json.dumps(merged_missing, ensure_ascii=False, indent=2)}\n\n"
                f"{context}\n\n"
                "Write the best follow-up email requesting missing information."
            )},
        ],
        text_format=DraftOutput,
    )
    parsed = response.output_parsed
    if parsed is None:
        raise HTTPException(status_code=500, detail="AI missing-info drafting returned no structured output.")
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
    log_action(session, message.id, "classified", "ai", metadata_json=result.model_dump_json())
    return message


def run_ai_workflow_for_message(session: Session, message_id: int) -> dict:
    message = get_message_or_404(session, message_id)
    context = build_message_context(session, message)
    classification = ai_classify_message(message.subject, context)
    message.category = classification.category
    message.ai_confidence = classification.confidence
    settings = get_or_create_company_settings(session)
    settings_read = company_settings_to_read(settings)
    style_context = build_company_style_context(settings_read)
    context = context + "\n\nCOMPANY SETTINGS:\n" + style_context
    extracted = ai_extract_fields(classification.category, context)
    reply = ai_draft_reply(classification.category, message.sender_name, extracted, context)
    extracted_row = ExtractedFields(message_id=message_id, json_data=extracted.model_dump_json())
    draft = Draft(message_id=message_id, draft_text=reply.reply_text)
    message.status = MessageStatus.needs_review
    message.updated_at = datetime.utcnow()
    session.add(extracted_row)
    session.add(draft)
    session.add(message)
    session.commit()
    session.refresh(draft)
    log_action(session, message_id, "processed", "ai", metadata_json=json.dumps({
        "category": classification.category.value,
        "confidence": classification.confidence,
        "classification_summary": classification.summary,
    }))
    return {
        "message_id": message_id,
        "category": classification.category,
        "confidence": classification.confidence,
        "classification_summary": classification.summary,
        "extracted_fields": extracted.model_dump(),
        "draft_text": reply.reply_text,
        "status": message.status,
    }


def _bg_run_ai_workflow(message_id: int) -> None:
    """Runs the full AI workflow for a single message in a background task."""
    try:
        with Session(engine, expire_on_commit=False) as session:
            run_ai_workflow_for_message(session, message_id)
    except Exception as exc:
        try:
            with Session(engine, expire_on_commit=False) as session:
                log_action(session, message_id, "auto_process_failed", "system",
                           metadata_json=json.dumps({"error": str(exc)}))
        except Exception:
            pass


def build_initial_quote_proposal_from_message(
    message: Message,
    qualification: Optional[ElectricalQualification] = None,
    brief: Optional[ElectricalQuoteBrief] = None,
) -> QuoteProposalPayload:
    title = "Electrical Works Proposal"
    if qualification and qualification.service_type == ElectricalServiceType.solar:
        title = "Solar Installation Proposal"
    elif qualification and qualification.service_type == ElectricalServiceType.maintenance:
        title = "Electrical Maintenance Proposal"
    elif qualification and qualification.service_type == ElectricalServiceType.strong_current:
        title = "Electrical Installation Proposal"
    scope_items: list[QuoteLineItem] = []
    if qualification:
        if qualification.service_type == ElectricalServiceType.strong_current:
            scope_items = [
                QuoteLineItem(name="Main electrical installation works", quantity=1, unit="lot", unit_price=0),
                QuoteLineItem(name="Lighting and socket circuits", quantity=1, unit="lot", unit_price=0),
                QuoteLineItem(name="Low-current preparation", quantity=1, unit="lot", unit_price=0),
            ]
        elif qualification.service_type == ElectricalServiceType.solar:
            scope_items = [
                QuoteLineItem(name="Solar system supply and installation", quantity=1, unit="lot", unit_price=0),
                QuoteLineItem(name="Inverter and protection equipment", quantity=1, unit="lot", unit_price=0),
                QuoteLineItem(name="Commissioning", quantity=1, unit="lot", unit_price=0),
            ]
        elif qualification.service_type == ElectricalServiceType.maintenance:
            scope_items = [
                QuoteLineItem(name="Inspection and fault diagnostics", quantity=1, unit="visit", unit_price=0),
                QuoteLineItem(name="Corrective electrical works", quantity=1, unit="lot", unit_price=0),
            ]
    intro_text = None
    if brief and brief.estimator_summary:
        intro_text = brief.estimator_summary
    elif qualification and qualification.client_summary:
        intro_text = qualification.client_summary
    return QuoteProposalPayload(
        title=title,
        currency="EUR",
        client_name=message.sender_name,
        project_name=message.subject,
        site_address=brief.location if brief else (qualification.location if qualification else None),
        intro_text=intro_text,
        scope_items=scope_items,
        exclusions_text="Final pricing is subject to site inspection, technical documentation, and final scope confirmation.",
        validity_days=15,
        payment_terms="Advance payment and final settlement by agreement.",
        discount_amount=0,
    )


# --- Routes ---

@app.get("/health")
def health() -> dict:
    checks: dict[str, str] = {}
    try:
        with Session(engine) as session:
            session.exec(select(User).limit(1)).first()
        checks["db"] = "ok"
    except Exception as exc:
        checks["db"] = f"error: {exc}"
    checks["openai_key"] = "ok" if os.getenv("OPENAI_API_KEY") else "missing"
    checks["gmail"] = "connected" if google_connected() else "not_connected"
    ok = all(v in ("ok", "connected", "not_connected") for v in checks.values())
    return {"ok": ok, "checks": checks}

@app.get("/config")
def get_runtime_config():
    """Public config the frontend reads on load. No auth required."""
    return {
        "demo_mode": DEMO_MODE,
    }

# ── NEW: Stats dashboard ──────────────────────────────────────────────────────

@app.get("/stats/dashboard")
def stats_dashboard(
    days: int = 30,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    """Aggregated metrics for the management overview panel."""
    since = datetime.utcnow() - timedelta(days=days)
    with Session(engine, expire_on_commit=False) as session:
        all_messages = session.exec(select(Message)).all()
        recent = [m for m in all_messages if m.created_at >= since]

        by_status: dict[str, int] = {}
        for m in recent:
            by_status[m.status.value] = by_status.get(m.status.value, 0) + 1

        by_category: dict[str, int] = {}
        for m in recent:
            by_category[m.category.value] = by_category.get(m.category.value, 0) + 1

        proposals = session.exec(select(QuoteProposal)).all()
        quotes_sent = sum(1 for p in proposals if p.quote_status == "sent_to_client")
        quotes_accepted = sum(1 for p in proposals if p.quote_status == "accepted")
        quotes_rejected = sum(1 for p in proposals if p.quote_status == "rejected")

        day_counts: dict[str, int] = {}
        for m in recent:
            day_key = m.created_at.strftime("%Y-%m-%d")
            day_counts[day_key] = day_counts.get(day_key, 0) + 1

        needs_review = sum(1 for m in all_messages if m.status == MessageStatus.needs_review)
        waiting_info = sum(1 for m in all_messages if m.status == MessageStatus.waiting_for_info)
        total_attachments = session.exec(select(func.count(Document.id))).one()

    conversion_rate = round(quotes_accepted / quotes_sent * 100, 1) if quotes_sent > 0 else 0

    return {
        "period_days": days,
        "total_messages": len(all_messages),
        "recent_messages": len(recent),
        "needs_review": needs_review,
        "waiting_for_info": waiting_info,
        "by_status": by_status,
        "by_category": by_category,
        "quotes_sent": quotes_sent,
        "quotes_accepted": quotes_accepted,
        "quotes_rejected": quotes_rejected,
        "conversion_rate_pct": conversion_rate,
        "total_attachments": total_attachments,
        "messages_by_day": [{"date": k, "count": v} for k, v in sorted(day_counts.items())],
    }


# ── NEW: Server-side search ───────────────────────────────────────────────────

@app.get("/messages/search", response_model=list[MessageRead])
def search_messages(
    q: str,
    status: Optional[str] = None,
    category: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    current_user: User = Depends(get_current_user),
) -> list[Message]:
    """Full-text search across subject, body, sender email and name."""
    if not q.strip():
        raise HTTPException(status_code=400, detail="Search query cannot be empty")
    with Session(engine, expire_on_commit=False) as session:
        query = select(Message).where(
            or_(
                Message.subject.ilike(f"%{q}%"),
                Message.body_text.ilike(f"%{q}%"),
                Message.sender_email.ilike(f"%{q}%"),
                Message.sender_name.ilike(f"%{q}%"),
            )
        )
        if status:
            query = query.where(Message.status == status)
        if category:
            query = query.where(Message.category == category)
        query = query.order_by(Message.updated_at.desc()).offset(offset).limit(min(limit, 100))
        return session.exec(query).all()


# ── NEW: Bulk actions ─────────────────────────────────────────────────────────

@app.post("/messages/bulk-action")
@limiter.limit("10/minute")
def bulk_action(
    request: Request,
    payload: BulkActionRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    """Apply one action to up to 50 messages at once."""
    if len(payload.message_ids) > 50:
        raise HTTPException(status_code=400, detail="Maximum 50 messages per bulk action")
    valid_actions = {"ignore", "unignore", "archive", "unarchive", "reject", "process"}
    if payload.action not in valid_actions:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid action. Must be one of: {', '.join(sorted(valid_actions))}",
        )
    succeeded: list[int] = []
    failed: list[dict] = []
    with Session(engine, expire_on_commit=False) as session:
        for msg_id in payload.message_ids:
            try:
                msg = get_message_or_404(session, msg_id)
                if payload.action == "ignore":
                    msg.status = MessageStatus.ignored
                elif payload.action == "unignore":
                    msg.status = MessageStatus.new
                elif payload.action == "archive":
                    msg.status = MessageStatus.archived
                elif payload.action == "unarchive":
                    msg.status = MessageStatus.needs_review
                elif payload.action == "reject":
                    msg.status = MessageStatus.rejected
                elif payload.action == "process":
                    background_tasks.add_task(_bg_run_ai_workflow, msg_id)
                    log_action(session, msg_id, f"bulk_{payload.action}", actor_name_for(current_user))
                    succeeded.append(msg_id)
                    continue
                msg.updated_at = datetime.utcnow()
                session.add(msg)
                log_action(session, msg_id, f"bulk_{payload.action}", actor_name_for(current_user))
                succeeded.append(msg_id)
            except Exception as e:
                failed.append({"id": msg_id, "error": str(e)})
        session.commit()
    return {
        "ok": True,
        "action": payload.action,
        "succeeded": succeeded,
        "succeeded_count": len(succeeded),
        "failed": failed,
        "queued_for_processing": payload.action == "process",
    }


# ── NEW: Reply templates ──────────────────────────────────────────────────────

@app.get("/templates", response_model=list[ReplyTemplateRead])
def list_templates(
    category: Optional[str] = None,
    service_type: Optional[str] = None,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> list[ReplyTemplate]:
    with Session(engine, expire_on_commit=False) as session:
        query = select(ReplyTemplate).order_by(
            ReplyTemplate.use_count.desc(), ReplyTemplate.name
        )
        if category:
            query = query.where(ReplyTemplate.category == category)
        if service_type:
            query = query.where(ReplyTemplate.service_type == service_type)
        return session.exec(query).all()


@app.post("/templates", response_model=ReplyTemplateRead)
def create_template(
    payload: ReplyTemplateCreate,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> ReplyTemplate:
    with Session(engine, expire_on_commit=False) as session:
        template = ReplyTemplate(
            name=payload.name.strip(),
            category=payload.category,
            service_type=payload.service_type,
            body_text=payload.body_text.strip(),
            created_by=actor_name_for(current_user),
        )
        session.add(template)
        session.commit()
        session.refresh(template)
        return template


@app.patch("/templates/{template_id}", response_model=ReplyTemplateRead)
def update_template(
    template_id: int,
    payload: ReplyTemplateUpdate,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> ReplyTemplate:
    with Session(engine, expire_on_commit=False) as session:
        template = session.get(ReplyTemplate, template_id)
        if not template:
            raise HTTPException(status_code=404, detail="Template not found")
        if payload.name is not None:
            template.name = payload.name.strip()
        if payload.category is not None:
            template.category = payload.category
        if payload.service_type is not None:
            template.service_type = payload.service_type
        if payload.body_text is not None:
            template.body_text = payload.body_text.strip()
        template.updated_at = datetime.utcnow()
        session.add(template)
        session.commit()
        session.refresh(template)
        return template


@app.delete("/templates/{template_id}")
def delete_template(
    template_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        template = session.get(ReplyTemplate, template_id)
        if not template:
            raise HTTPException(status_code=404, detail="Template not found")
        session.delete(template)
        session.commit()
        return {"ok": True, "template_id": template_id}


@app.post("/messages/{message_id}/apply-template/{template_id}")
def apply_template(
    message_id: int,
    template_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    """Copy a template's body into a new draft for the message."""
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        template = session.get(ReplyTemplate, template_id)
        if not template:
            raise HTTPException(status_code=404, detail="Template not found")

        draft = Draft(message_id=message_id, draft_text=template.body_text)
        session.add(draft)

        template.use_count = (template.use_count or 0) + 1
        template.updated_at = datetime.utcnow()
        session.add(template)

        message.status = MessageStatus.needs_review
        message.updated_at = datetime.utcnow()
        session.add(message)

        session.commit()
        session.refresh(draft)

        log_action(session, message_id, "template_applied", actor_name_for(current_user),
                   metadata_json=json.dumps({"template_id": template_id, "template_name": template.name}))

        return {"ok": True, "draft_id": draft.id, "draft_text": draft.draft_text, "template_name": template.name}


# ── NEW: Quote proposal client-facing PDF ────────────────────────────────────

@app.get("/messages/{message_id}/quote-proposal/pdf")
def export_quote_proposal_pdf(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> StreamingResponse:
    """Generate and download a client-facing quote proposal PDF."""
    with Session(engine, expire_on_commit=False) as session:
        get_message_or_404(session, message_id)
        proposal = session.exec(
            select(QuoteProposal).where(QuoteProposal.message_id == message_id)
        ).first()
        if not proposal:
            raise HTTPException(
                status_code=404,
                detail="No quote proposal found for this message. Build one first.",
            )
        pdf_bytes = build_quote_proposal_pdf_bytes(proposal)

    safe_project = re.sub(r"[^\w\s-]", "", (proposal.project_name or f"message-{message_id}"))[:40].strip().replace(" ", "-")
    filename = f"quote-{safe_project}.pdf"
    return StreamingResponse(
        BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── NEW: Quote lifecycle endpoints ────────────────────────────────────────────

@app.post("/messages/{message_id}/quote-proposal/mark-sent", response_model=QuoteProposalResponse)
def mark_quote_sent(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> QuoteProposalResponse:
    """Mark the quote as sent to the client."""
    with Session(engine, expire_on_commit=False) as session:
        proposal = session.exec(
            select(QuoteProposal).where(QuoteProposal.message_id == message_id)
        ).first()
        if not proposal:
            raise HTTPException(status_code=404, detail="No quote proposal found")
        proposal.quote_status = QuoteStatus.sent_to_client
        proposal.sent_at = datetime.utcnow()
        proposal.updated_at = datetime.utcnow()
        session.add(proposal)
        session.commit()
        session.refresh(proposal)
        log_action(session, message_id, "quote_marked_sent", actor_name_for(current_user))
        return quote_proposal_to_response(proposal)


@app.post("/messages/{message_id}/quote-proposal/mark-accepted", response_model=QuoteProposalResponse)
def mark_quote_accepted(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> QuoteProposalResponse:
    """Mark the quote as accepted by the client."""
    with Session(engine, expire_on_commit=False) as session:
        proposal = session.exec(
            select(QuoteProposal).where(QuoteProposal.message_id == message_id)
        ).first()
        if not proposal:
            raise HTTPException(status_code=404, detail="No quote proposal found")
        proposal.quote_status = QuoteStatus.accepted
        proposal.responded_at = datetime.utcnow()
        proposal.updated_at = datetime.utcnow()
        session.add(proposal)
        # Also move the parent message to approved
        message = get_message_or_404(session, message_id)
        message.status = MessageStatus.approved
        message.updated_at = datetime.utcnow()
        session.add(message)
        session.commit()
        session.refresh(proposal)
        log_action(session, message_id, "quote_accepted", actor_name_for(current_user))
        return quote_proposal_to_response(proposal)


@app.post("/messages/{message_id}/quote-proposal/mark-rejected", response_model=QuoteProposalResponse)
def mark_quote_rejected(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> QuoteProposalResponse:
    """Mark the quote as rejected by the client."""
    with Session(engine, expire_on_commit=False) as session:
        proposal = session.exec(
            select(QuoteProposal).where(QuoteProposal.message_id == message_id)
        ).first()
        if not proposal:
            raise HTTPException(status_code=404, detail="No quote proposal found")
        proposal.quote_status = QuoteStatus.rejected
        proposal.responded_at = datetime.utcnow()
        proposal.updated_at = datetime.utcnow()
        session.add(proposal)
        session.commit()
        session.refresh(proposal)
        log_action(session, message_id, "quote_rejected", actor_name_for(current_user))
        return quote_proposal_to_response(proposal)


# ── Existing routes (unchanged from original) ─────────────────────────────────

@app.post("/messages/{message_id}/ignore")
def ignore_message(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        message.status = MessageStatus.ignored
        message.updated_at = datetime.utcnow()
        session.add(message)
        session.commit()
        session.refresh(message)
        log_action(session, message_id, "ignored", actor_name_for(current_user))
        return {"ok": True, "message_id": message_id, "status": message.status}


@app.get("/messages/{message_id}/notes", response_model=list[InternalNoteRead])
def list_message_notes(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> list[InternalNote]:
    with Session(engine, expire_on_commit=False) as session:
        get_message_or_404(session, message_id)
        notes = session.exec(
            select(InternalNote)
            .where(InternalNote.message_id == message_id)
            .order_by(InternalNote.created_at.desc())
        ).all()
        return notes


@app.delete("/messages/{message_id}/delete-internal")
def delete_internal_message(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        for model in (ExtractedFields, Draft, InternalNote, AuditLog, QuoteProposal):
            for row in session.exec(select(model).where(model.message_id == message_id)).all():
                session.delete(row)
        for doc in session.exec(select(Document).where(Document.message_id == message_id)).all():
            if doc.storage_path and Path(doc.storage_path).exists():
                Path(doc.storage_path).unlink()
            session.delete(doc)
        session.delete(message)
        session.commit()
        return {"ok": True, "message": "Internal message deleted", "message_id": message_id}


@app.delete("/messages/{message_id}/delete-email")
def delete_email_message(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        gmail_deleted = False
        if message.source == MessageSource.gmail and message.gmail_message_id:
            service = get_gmail_service()
            service.users().messages().trash(userId="me", id=message.gmail_message_id).execute()
            gmail_deleted = True
        message.status = MessageStatus.archived
        message.updated_at = datetime.utcnow()
        session.add(message)
        session.commit()
        session.refresh(message)
        log_action(
            session, message_id, "gmail_trashed", actor_name_for(current_user),
            metadata_json=json.dumps({
                "gmail_deleted": gmail_deleted,
                "gmail_message_id": message.gmail_message_id,
                "gmail_thread_id": message.gmail_thread_id,
            }),
        )
        return {"ok": True, "message_id": message_id, "gmail_deleted": gmail_deleted, "status": message.status}


@app.get("/messages/{message_id}/quote-proposal", response_model=QuoteProposalResponse)
def get_quote_proposal(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> QuoteProposalResponse:
    with Session(engine) as session:
        message = session.get(Message, message_id)
        if not message:
            raise HTTPException(status_code=404, detail="Message not found")
        proposal = session.exec(
            select(QuoteProposal).where(QuoteProposal.message_id == message_id)
        ).first()
        if proposal:
            return quote_proposal_to_response(proposal)
        return QuoteProposalResponse(
            message_id=message_id, title="Electrical Works Proposal", currency="EUR",
            client_name=message.sender_name, project_name=message.subject,
            site_address=None, intro_text=None, scope_items=[],
            exclusions_text=None, validity_days=15, payment_terms=None,
            discount_amount=0, subtotal=0, total_amount=0,
        )


@app.put("/messages/{message_id}/quote-proposal", response_model=QuoteProposalResponse)
def save_quote_proposal(
    message_id: int,
    payload: QuoteProposalPayload,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
):
    with Session(engine) as session:
        message = session.get(Message, message_id)
        if not message:
            raise HTTPException(status_code=404, detail="Message not found")
        proposal = session.exec(
            select(QuoteProposal).where(QuoteProposal.message_id == message_id)
        ).first()
        normalized_items, subtotal = normalize_quote_items(payload.scope_items)
        total_amount = round(max(subtotal - float(payload.discount_amount or 0), 0), 2)
        if not proposal:
            proposal = QuoteProposal(message_id=message_id)
            session.add(proposal)
        proposal.title = payload.title
        proposal.currency = payload.currency
        proposal.client_name = payload.client_name
        proposal.project_name = payload.project_name
        proposal.site_address = payload.site_address
        proposal.intro_text = payload.intro_text
        proposal.scope_items_json = normalized_items
        proposal.exclusions_text = payload.exclusions_text
        proposal.validity_days = payload.validity_days
        proposal.payment_terms = payload.payment_terms
        proposal.discount_amount = round(float(payload.discount_amount or 0), 2)
        proposal.subtotal = subtotal
        proposal.total_amount = total_amount
        proposal.updated_at = datetime.utcnow()
        session.add(proposal)
        session.commit()
        session.refresh(proposal)
        return quote_proposal_to_response(proposal)


@app.post("/messages/{message_id}/quote-proposal/autofill", response_model=QuoteProposalResponse)
def autofill_quote_proposal(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
):
    with Session(engine) as session:
        message = session.get(Message, message_id)
        if not message:
            raise HTTPException(status_code=404, detail="Message not found")
        qualification = None
        brief = None
        try:
            context = build_message_context(session, message)
            qualification = ai_qualify_electrical_lead(context)
        except Exception:
            qualification = None
        try:
            if qualification is not None:
                brief = build_electrical_quote_brief(session, message)
        except Exception:
            brief = None
        payload = build_initial_quote_proposal_from_message(
            message=message, qualification=qualification, brief=brief,
        )
        proposal = session.exec(
            select(QuoteProposal).where(QuoteProposal.message_id == message_id)
        ).first()
        normalized_items, subtotal = normalize_quote_items(payload.scope_items)
        total_amount = round(max(subtotal - float(payload.discount_amount or 0), 0), 2)
        if not proposal:
            proposal = QuoteProposal(message_id=message_id)
            session.add(proposal)
        proposal.title = payload.title
        proposal.currency = payload.currency
        proposal.client_name = payload.client_name
        proposal.project_name = payload.project_name
        proposal.site_address = payload.site_address
        proposal.intro_text = payload.intro_text
        proposal.scope_items_json = normalized_items
        proposal.exclusions_text = payload.exclusions_text
        proposal.validity_days = payload.validity_days
        proposal.payment_terms = payload.payment_terms
        proposal.discount_amount = payload.discount_amount
        proposal.subtotal = subtotal
        proposal.total_amount = total_amount
        proposal.updated_at = datetime.utcnow()
        session.add(proposal)
        session.commit()
        session.refresh(proposal)
        return quote_proposal_to_response(proposal)


@app.post("/auth/bootstrap", response_model=UserRead)
def bootstrap_admin(payload: BootstrapAdminRequest) -> User:
    with Session(engine, expire_on_commit=False) as session:
        existing_user = session.exec(select(User)).first()
        if existing_user:
            raise HTTPException(status_code=400, detail="Bootstrap already completed")
        user = User(
            email=payload.email.strip().lower(),
            full_name=payload.full_name.strip(),
            hashed_password=hash_password(payload.password),
            role=UserRole.admin,
            is_active=True,
        )
        session.add(user)
        session.commit()
        session.refresh(user)
        return user


@app.get("/messages/{message_id}/quote-brief.pdf")
def export_quote_brief_pdf(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> StreamingResponse:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        pdf_bytes = build_quote_brief_pdf_bytes(session, message)
    filename = f"elesys-brief-message-{message_id}.pdf"
    return StreamingResponse(
        BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/messages/{message_id}/quote-brief")
def get_quote_brief(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
):
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        brief = build_electrical_quote_brief(session, message)
        return brief.model_dump()


@app.post("/messages/{message_id}/ready-for-site-visit")
def mark_ready_for_site_visit(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        message.status = MessageStatus.ready_for_site_visit
        message.updated_at = datetime.utcnow()
        session.add(message)
        session.commit()
        session.refresh(message)
        log_action(session, message_id, "marked_ready_for_site_visit", actor_name_for(current_user),
                   metadata_json=json.dumps({"status": message.status.value}))
        return {"ok": True, "message_id": message_id, "status": message.status}


@app.post("/messages/{message_id}/ready-for-quote")
def mark_ready_for_quote(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        message.status = MessageStatus.ready_for_quote
        message.updated_at = datetime.utcnow()
        session.add(message)
        session.commit()
        session.refresh(message)
        log_action(session, message_id, "marked_ready_for_quote", actor_name_for(current_user),
                   metadata_json=json.dumps({"status": message.status.value}))
        return {"ok": True, "message_id": message_id, "status": message.status}


@app.post("/auth/login", response_model=TokenResponse)
@limiter.limit("5/minute")
def login(request: Request, payload: LoginRequest) -> TokenResponse:
    with Session(engine, expire_on_commit=False) as session:
        user = get_user_by_email(session, payload.email)
        if not user or not verify_password(payload.password, user.hashed_password):
            raise HTTPException(status_code=401, detail="Invalid email or password")
        token = create_access_token(user.email, user.role.value)
        return TokenResponse(
            access_token=token,
            user=UserRead(
                id=user.id,
                email=user.email,
                full_name=user.full_name,
                role=user.role,
                is_active=user.is_active,
            ),
        )


@app.get("/settings", response_model=CompanySettingsRead)
def get_settings(
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> CompanySettingsRead:
    with Session(engine, expire_on_commit=False) as session:
        settings = get_or_create_company_settings(session)
        return company_settings_to_read(settings)


@app.put("/settings", response_model=CompanySettingsRead)
def update_settings(
    payload: CompanySettingsUpdate,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> CompanySettingsRead:
    with Session(engine, expire_on_commit=False) as session:
        settings = get_or_create_company_settings(session)
        settings.company_name = payload.company_name.strip() or "Your Company"
        settings.preferred_reply_tone = payload.preferred_reply_tone
        settings.reply_signature = payload.reply_signature.strip() or "Best,\nYour Company"
        settings.ignore_senders_json = list_to_json(payload.ignore_senders)
        settings.quote_required_fields_json = list_to_json(payload.quote_required_fields)
        settings.updated_at = datetime.utcnow()
        session.add(settings)
        session.commit()
        session.refresh(settings)
        return company_settings_to_read(settings)


@app.get("/messages/{message_id}/electrical-qualification")
def get_electrical_qualification(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        context = build_message_context(session, message)
        qualification = ai_qualify_electrical_lead(context)
        return qualification.model_dump()


@app.get("/auth/me", response_model=UserRead)
def auth_me(current_user: User = Depends(get_current_user)) -> UserRead:
    return UserRead(
        id=current_user.id, email=current_user.email, full_name=current_user.full_name,
        role=current_user.role, is_active=current_user.is_active,
    )


@app.get("/messages", response_model=list[MessageRead])
def list_messages(current_user: User = Depends(get_current_user)) -> list[Message]:
    with Session(engine, expire_on_commit=False) as session:
        return session.exec(select(Message).order_by(Message.created_at.desc())).all()


@app.post("/messages/{message_id}/notes", response_model=InternalNoteRead)
def create_message_note(
    message_id: int,
    payload: InternalNoteCreate,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> InternalNote:
    with Session(engine, expire_on_commit=False) as session:
        get_message_or_404(session, message_id)
        author_name = (payload.author or "").strip() or actor_name_for(current_user)
        note_text = payload.note_text.strip()
        if not note_text:
            raise HTTPException(status_code=400, detail="Note text cannot be empty")
        note = InternalNote(message_id=message_id, author=author_name, note_text=note_text)
        session.add(note)
        session.commit()
        session.refresh(note)
        log_action(session, message_id, "internal_note_created", author_name,
                   metadata_json=json.dumps({"note_id": note.id, "preview": note.note_text[:120]}))
        return note


@app.post("/messages/{message_id}/approve")
def approve_message(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        draft = session.exec(
            select(Draft).where(Draft.message_id == message_id).order_by(Draft.created_at.desc())
        ).first()
        if not draft:
            raise HTTPException(status_code=404, detail="Draft not found")
        draft.approval_status = ApprovalStatus.approved
        draft.approved_by = actor_name_for(current_user)
        draft.updated_at = datetime.utcnow()
        message.status = MessageStatus.approved
        message.updated_at = datetime.utcnow()
        session.add(draft)
        session.add(message)
        session.commit()
        session.refresh(message)
        log_action(session, message_id, "approved", actor_name_for(current_user))
        return {"ok": True, "message_id": message_id, "status": message.status}


@app.post("/messages/{message_id}/unignore")
def unignore_message(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        message.status = MessageStatus.new
        message.updated_at = datetime.utcnow()
        session.add(message)
        session.commit()
        session.refresh(message)
        log_action(session, message_id, "unignored", actor_name_for(current_user))
        return {"ok": True, "message_id": message_id, "status": message.status}


@app.post("/messages/{message_id}/archive")
def archive_message(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        gmail_archived = False
        if message.source == MessageSource.gmail and message.gmail_message_id:
            service = get_gmail_service()
            archive_gmail_message(service, message.gmail_message_id)
            gmail_archived = True
        message.status = MessageStatus.archived
        message.updated_at = datetime.utcnow()
        session.add(message)
        session.commit()
        session.refresh(message)
        log_action(session, message_id, "archived", actor_name_for(current_user),
                   metadata_json=json.dumps({
                       "gmail_archived": gmail_archived,
                       "gmail_message_id": message.gmail_message_id,
                       "gmail_thread_id": message.gmail_thread_id,
                   }))
        return {"ok": True, "message_id": message_id, "status": message.status, "gmail_archived": gmail_archived}


@app.post("/messages/{message_id}/unarchive")
def unarchive_message(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        message.status = MessageStatus.needs_review
        message.updated_at = datetime.utcnow()
        session.add(message)
        session.commit()
        session.refresh(message)
        log_action(session, message_id, "unarchived", actor_name_for(current_user))
        return {"ok": True, "message_id": message_id, "status": message.status}


@app.post("/messages/{message_id}/send-gmail")
def send_message_via_gmail(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    service = get_gmail_service()
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        if message.status not in (MessageStatus.approved, MessageStatus.waiting_for_info):
            raise HTTPException(
                status_code=400,
                detail="Only approved or waiting-for-info messages can be sent",
            )
        draft = get_latest_draft_for_message(session, message_id)
        draft_text = (
            (draft.approved_text if draft and hasattr(draft, "approved_text") else None)
            or (draft.draft_text if draft else "")
            or ""
        ).strip()
        if not draft_text:
            raise HTTPException(status_code=400, detail="No saved draft found for this message")
        thread_id = None
        in_reply_to = None
        references = None
        subject = message.subject or "(No subject)"
        if message.source == MessageSource.gmail and message.gmail_message_id:
            original = (
                service.users()
                .messages()
                .get(
                    userId="me",
                    id=message.gmail_message_id,
                    format="metadata",
                    metadataHeaders=["Message-ID", "References", "Subject"],
                )
                .execute()
            )
            headers = (original.get("payload") or {}).get("headers", []) or []
            original_message_id = extract_header(headers, "Message-ID")
            original_references = extract_header(headers, "References")
            original_subject = extract_header(headers, "Subject")
            thread_id = message.gmail_thread_id or original.get("threadId")
            in_reply_to = original_message_id
            references = (
                f"{original_references} {original_message_id}".strip()
                if original_references and original_message_id
                else original_message_id
            )
            if original_subject:
                subject = original_subject
        gmail_payload = build_gmail_raw_message(
            to_email=message.sender_email,
            subject=subject,
            body_text=draft_text,
            thread_id=thread_id,
            in_reply_to=in_reply_to,
            references=references,
        )
        sent = service.users().messages().send(userId="me", body=gmail_payload).execute()
        message.status = MessageStatus.sent
        message.updated_at = datetime.utcnow()
        session.add(message)
        session.commit()
        log_action(session, message_id, "sent_via_gmail", actor_name_for(current_user),
                   metadata_json=json.dumps({
                       "gmail_sent_message_id": sent.get("id"),
                       "thread_id": sent.get("threadId"),
                   }))
        return {
            "ok": True,
            "message_id": message_id,
            "gmail_sent_message_id": sent.get("id"),
            "thread_id": sent.get("threadId"),
            "status": message.status,
        }


@app.delete("/messages/clear-local")
def clear_local_messages(
    current_user: User = Depends(require_roles(UserRole.admin)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        docs = session.exec(select(Document)).all()
        deleted_counts: dict[str, int] = {
            "documents": 0, "document_files": 0, "extracted_fields": 0,
            "drafts": 0, "audit_logs": 0, "internal_notes": 0,
            "quote_proposals": 0, "messages": 0,
        }
        for row in docs:
            if row.storage_path and Path(row.storage_path).exists():
                Path(row.storage_path).unlink()
                deleted_counts["document_files"] += 1
            session.delete(row)
            deleted_counts["documents"] += 1
        for model, key in [
            (ExtractedFields, "extracted_fields"),
            (Draft, "drafts"),
            (AuditLog, "audit_logs"),
            (InternalNote, "internal_notes"),
            (QuoteProposal, "quote_proposals"),
            (Message, "messages"),
        ]:
            for row in session.exec(select(model)).all():
                session.delete(row)
                deleted_counts[key] += 1
        session.commit()
        return {"ok": True, "deleted": deleted_counts}


@app.post("/gmail/sync")
@limiter.limit("10/minute")
def gmail_sync(
    request: Request,
    background_tasks: BackgroundTasks,
    max_results: int = 20,
    auto_process: bool = False,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    service = get_gmail_service()
    connected_gmail_address = get_connected_gmail_address(service)
    gmail_list = (
        service.users()
        .messages()
        .list(
            userId="me",
            labelIds=["INBOX"],
            q="in:inbox -category:promotions -category:social -category:forums -from:noreply -from:no-reply -from:mailer-daemon",
            maxResults=max_results,
        )
        .execute()
    )
    message_refs = gmail_list.get("messages", []) or []
    imported_count = 0
    thread_reply_updated_count = 0
    own_thread_skipped_count = 0
    auto_ignored_count = 0
    skipped_count = 0
    queued_process_count = 0
    duplicate_count = 0
    imported_attachment_count = 0
    imported_ids: list[int] = []

    with Session(engine, expire_on_commit=False) as session:
        existing_gmail_ids = get_imported_gmail_ids(session)
        for ref in message_refs:
            gmail_message_id = ref.get("id")
            if not gmail_message_id:
                skipped_count += 1
                continue
            if gmail_message_id in existing_gmail_ids:
                duplicate_count += 1
                skipped_count += 1
                continue
            gmail_message = (
                service.users()
                .messages()
                .get(userId="me", id=gmail_message_id, format="full")
                .execute()
            )
            payload = gmail_message.get("payload", {}) or {}
            headers = payload.get("headers", []) or []
            settings = get_or_create_company_settings(session)
            settings_read = company_settings_to_read(settings)
            subject = extract_header(headers, "Subject") or "(No subject)"
            from_header = extract_header(headers, "From") or ""
            sender_name, sender_email = parseaddr(from_header)
            sender_email_normalized = (sender_email or "").lower().strip()
            gmail_thread_id = gmail_message.get("threadId")
            is_from_me = sender_email_normalized == connected_gmail_address
            if not sender_email_normalized:
                skipped_count += 1
                continue
            body_text = extract_plain_text_from_payload(payload).strip()
            snippet = gmail_message.get("snippet", "") or ""
            if not body_text or len(body_text) > 4000 or body_text.count("http") > 5:
                body_text = snippet
            body_text = truncate_body(body_text)
            existing_thread_message = None
            if gmail_thread_id:
                existing_thread_message = get_local_message_by_gmail_thread(session, gmail_thread_id)
            if existing_thread_message and not is_from_me:
                was_waiting_for_info = existing_thread_message.status == MessageStatus.waiting_for_info
                append_customer_reply_to_message(
                    session,
                    message=existing_thread_message,
                    new_subject=subject,
                    new_sender_name=sender_name or None,
                    new_sender_email=sender_email,
                    new_body_text=body_text,
                )
                reply_attachment_count = import_gmail_attachments_for_message(
                    service, session,
                    gmail_message=gmail_message,
                    local_message_id=existing_thread_message.id,
                )
                if reply_attachment_count > 0:
                    existing_thread_message.has_attachments = True
                    existing_thread_message.updated_at = datetime.utcnow()
                    session.add(existing_thread_message)
                    session.commit()
                    session.refresh(existing_thread_message)
                log_action(session, existing_thread_message.id, "customer_reply_synced", "gmail_sync",
                           metadata_json=json.dumps({
                               "gmail_message_id": gmail_message_id,
                               "thread_id": gmail_thread_id,
                               "reopened_for_review": was_waiting_for_info,
                               "reply_attachment_count": reply_attachment_count,
                           }))
                existing_gmail_ids.add(gmail_message_id)
                thread_reply_updated_count += 1
                continue
            if existing_thread_message and is_from_me:
                log_action(session, existing_thread_message.id, "own_thread_message_skipped", "gmail_sync",
                           metadata_json=json.dumps({
                               "gmail_message_id": gmail_message_id,
                               "thread_id": gmail_thread_id,
                           }))
                existing_gmail_ids.add(gmail_message_id)
                own_thread_skipped_count += 1
                continue
            should_ignore, ignore_reason = should_auto_ignore_message(
                subject=subject,
                sender_email=sender_email,
                body_text=body_text,
                custom_ignore_senders=settings_read.ignore_senders,
            )
            score = triage_score(subject=subject, sender_email=sender_email, body_text=body_text)
            message = Message(
                subject=subject,
                sender_email=sender_email,
                sender_name=sender_name or None,
                body_text=body_text,
                source=MessageSource.gmail,
                gmail_message_id=gmail_message_id,
                gmail_thread_id=gmail_thread_id,
                gmail_synced_at=datetime.utcnow(),
                has_attachments=False,
                status=MessageStatus.ignored if should_ignore else MessageStatus.new,
            )
            session.add(message)
            session.commit()
            session.refresh(message)
            attachment_count = import_gmail_attachments_for_message(
                service, session, gmail_message=gmail_message, local_message_id=message.id,
            )
            message.has_attachments = attachment_count > 0
            message.updated_at = datetime.utcnow()
            session.add(message)
            session.commit()
            session.refresh(message)
            log_action(session, message.id, "gmail_imported", "gmail_sync",
                       metadata_json=json.dumps({
                           "gmail_message_id": gmail_message_id,
                           "thread_id": gmail_thread_id,
                           "attachment_count": attachment_count,
                           "triage_score": score,
                           "auto_ignored": should_ignore,
                       }))
            if should_ignore:
                log_action(session, message.id, "auto_ignored", "system",
                           metadata_json=json.dumps({"reason": ignore_reason}))
            imported_attachment_count += attachment_count
            imported_count += 1
            if should_ignore:
                auto_ignored_count += 1
            imported_ids.append(message.id)
            existing_gmail_ids.add(gmail_message_id)
            if auto_process and message.status != MessageStatus.ignored:
                background_tasks.add_task(_bg_run_ai_workflow, message.id)
                queued_process_count += 1

    return {
        "imported_count": imported_count,
        "imported_attachment_count": imported_attachment_count,
        "thread_reply_updated_count": thread_reply_updated_count,
        "own_thread_skipped_count": own_thread_skipped_count,
        "duplicate_count": duplicate_count,
        "skipped_count": skipped_count,
        "imported_message_ids": imported_ids,
        "auto_ignored_count": auto_ignored_count,
        "auto_process_queued": auto_process,
        "processed_count": queued_process_count,
    }


@app.post("/messages/{message_id}/process")
@limiter.limit("20/minute")
def process_message(
    request: Request,
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        return run_ai_workflow_for_message(session, message_id)


@app.get("/auth/google/start")
def google_auth_start() -> RedirectResponse:
    client_config = get_google_client_config()
    state = secrets.token_urlsafe(24)
    code_verifier = secrets.token_urlsafe(96)[:128]
    flow = Flow.from_client_config(
        client_config,
        scopes=GOOGLE_SCOPES,
        redirect_uri=GOOGLE_REDIRECT_URI,
        state=state,
        code_verifier=code_verifier,
        autogenerate_code_verifier=False,
    )
    oauth_pending[state] = code_verifier
    authorization_url, _ = flow.authorization_url(
        access_type="offline", include_granted_scopes="true", prompt="consent",
    )
    return RedirectResponse(url=authorization_url)


@app.get("/auth/google/callback")
def google_auth_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    if error:
        raise HTTPException(status_code=400, detail=f"Google OAuth error: {error}")
    if not code or not state:
        raise HTTPException(status_code=400, detail="Missing code or state in Google callback")
    if state not in oauth_pending:
        raise HTTPException(status_code=400, detail="Invalid OAuth state")
    code_verifier = oauth_pending.pop(state)
    client_config = get_google_client_config()
    flow = Flow.from_client_config(
        client_config,
        scopes=GOOGLE_SCOPES,
        redirect_uri=GOOGLE_REDIRECT_URI,
        state=state,
        code_verifier=code_verifier,
        autogenerate_code_verifier=False,
    )
    flow.fetch_token(code=code)
    save_google_credentials(flow.credentials)
    return HTMLResponse("""
        <html>
          <body style="font-family: Arial, sans-serif; padding: 24px;">
            <h2>Gmail connected successfully</h2>
            <p>You can close this tab and return to the dashboard.</p>
          </body>
        </html>
    """)


@app.get("/auth/google/status")
def google_auth_status(
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    return {"connected": google_connected()}


@app.post("/auth/google/disconnect")
def google_auth_disconnect(
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    token_file = Path(GOOGLE_TOKEN_PATH)
    if token_file.exists():
        token_file.unlink()
    return {"connected": False}


@app.get("/messages/{message_id}/documents")
def list_message_documents(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        get_message_or_404(session, message_id)
        docs = session.exec(
            select(Document).where(Document.message_id == message_id).order_by(Document.created_at.desc())
        ).all()
        return {
            "message_id": message_id,
            "documents": [
                {"id": d.id, "filename": d.filename, "file_type": d.file_type,
                 "storage_path": d.storage_path, "created_at": d.created_at}
                for d in docs
            ],
        }


@app.get("/messages/{message_id}/audit-logs")
def get_message_audit_logs(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        get_message_or_404(session, message_id)
        logs = session.exec(
            select(AuditLog).where(AuditLog.message_id == message_id).order_by(AuditLog.created_at.desc())
        ).all()
        return {
            "message_id": message_id,
            "audit_logs": [
                {"id": l.id, "action": l.action, "actor": l.actor,
                 "metadata_json": l.metadata_json, "created_at": l.created_at}
                for l in logs
            ],
        }


@app.post("/messages/{message_id}/draft-missing-info")
def generate_missing_info_draft(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        message = ensure_message_classified(session, message)
        context = build_message_context(session, message)
        settings = get_or_create_company_settings(session)
        settings_read = company_settings_to_read(settings)
        style_context = build_company_style_context(settings_read)
        context = context + "\n\nCOMPANY SETTINGS:\n" + style_context
        extracted = ai_extract_fields(message.category, context)
        merged_missing: list[str] = extracted.missing_information or []
        if is_quote_category(message.category):
            extracted_data = extracted.model_dump()
            merged_missing = merge_missing_information(extracted_data, settings_read.quote_required_fields)
        extracted.missing_information = merged_missing
        draft_output = ai_draft_missing_info(message.category, message.sender_name, extracted, context)
        draft = Draft(message_id=message_id, draft_text=draft_output.reply_text)
        message.status = MessageStatus.waiting_for_info
        message.updated_at = datetime.utcnow()
        session.add(draft)
        session.add(message)
        session.commit()
        session.refresh(draft)
        session.refresh(message)
        log_action(session, message_id, "missing_info_draft_created", "ai",
                   metadata_json=json.dumps({
                       "missing_information": extracted.missing_information,
                       "reason": "missing_information",
                       "new_status": "waiting_for_info",
                   }))
        return {
            "message_id": message_id,
            "draft_id": draft.id,
            "draft_text": draft.draft_text,
            "missing_information": extracted.missing_information,
            "status": message.status,
        }


@app.post("/messages", response_model=MessageRead)
def create_message(
    payload: MessageCreate,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> Message:
    with Session(engine, expire_on_commit=False) as session:
        message = Message(
            subject=payload.subject,
            sender_email=payload.sender_email,
            sender_name=payload.sender_name,
            body_text=truncate_body(payload.body_text),
            source=MessageSource.manual,
            gmail_message_id=None,
            gmail_thread_id=None,
            gmail_synced_at=None,
            has_attachments=False,
        )
        session.add(message)
        session.commit()
        session.refresh(message)
        log_action(session, message.id, "message_created", "system")
        return message


@app.get("/messages/{message_id}", response_model=MessageRead)
def get_message(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> Message:
    with Session(engine, expire_on_commit=False) as session:
        return get_message_or_404(session, message_id)


@app.get("/messages/{message_id}/latest-extraction")
def get_latest_extraction(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        get_message_or_404(session, message_id)
        row = session.exec(
            select(ExtractedFields).where(ExtractedFields.message_id == message_id).order_by(ExtractedFields.created_at.desc())
        ).first()
        audit = session.exec(
            select(AuditLog)
            .where(AuditLog.message_id == message_id, AuditLog.action.in_(["processed", "classified"]))
            .order_by(AuditLog.created_at.desc())
        ).first()
        classification_summary = None
        if audit and audit.metadata_json:
            try:
                classification_summary = json.loads(audit.metadata_json).get("classification_summary")
            except Exception:
                pass
        if not row:
            return {"message_id": message_id, "extracted_fields": None, "classification_summary": classification_summary}
        return {
            "message_id": message_id,
            "extracted_fields_id": row.id,
            "extracted_fields": json.loads(row.json_data),
            "classification_summary": classification_summary,
            "created_at": row.created_at,
        }


@app.get("/messages/{message_id}/latest-draft")
def get_latest_draft(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        get_message_or_404(session, message_id)
        draft = session.exec(
            select(Draft).where(Draft.message_id == message_id).order_by(Draft.created_at.desc())
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
def upload_document(
    message_id: int,
    file: UploadFile = File(...),
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        get_message_or_404(session, message_id)
        safe_name = Path(file.filename or "upload.bin").name
        timestamp_prefix = datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
        stored_name = f"{timestamp_prefix}_{safe_name}"
        stored_path = UPLOAD_DIR / stored_name
        raw_bytes = file.file.read()
        stored_path.write_bytes(raw_bytes)
        extracted_text = extract_text_from_file_bytes(safe_name, file.content_type, raw_bytes)
        doc = Document(
            message_id=message_id, filename=safe_name, file_type=file.content_type,
            storage_path=str(stored_path), extracted_text=extracted_text,
        )
        session.add(doc)
        session.commit()
        session.refresh(doc)
        log_action(session, message_id, "document_uploaded", "system",
                   metadata_json=json.dumps({"filename": safe_name, "stored_path": str(stored_path)}))
        return {"document_id": doc.id, "filename": doc.filename, "stored_path": str(stored_path)}


@app.post("/messages/{message_id}/classify")
def run_classification(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
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
        log_action(session, message_id, "classified", "ai",
                   metadata_json=json.dumps({
                       "category": result.category.value,
                       "confidence": result.confidence,
                       "classification_summary": result.summary,
                   }))
        return {"message_id": message_id, "category": result.category, "confidence": result.confidence, "summary": result.summary}


@app.post("/messages/{message_id}/extract")
def run_extraction(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
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
        log_action(session, message_id, "fields_extracted", "ai", metadata_json=extracted.model_dump_json())
        return {"message_id": message_id, "extracted_fields_id": row.id, "json_data": json.loads(row.json_data)}


@app.post("/messages/{message_id}/draft-reply")
def generate_draft(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
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


@app.post("/messages/{message_id}/edit-draft")
def edit_draft(
    message_id: int,
    payload: DraftEditRequest,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        get_message_or_404(session, message_id)
        draft = session.exec(
            select(Draft).where(Draft.message_id == message_id).order_by(Draft.created_at.desc())
        ).first()
        if not draft:
            raise HTTPException(status_code=404, detail="Draft not found")
        draft.approved_text = payload.draft_text
        draft.approval_status = ApprovalStatus.edited
        draft.approved_by = actor_name_for(current_user)
        draft.updated_at = datetime.utcnow()
        session.add(draft)
        session.commit()
        log_action(session, message_id, "draft_edited", actor_name_for(current_user))
        return {"message_id": message_id, "draft_id": draft.id, "approved_text": draft.approved_text}


@app.post("/messages/{message_id}/reject")
def reject_message(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        draft = session.exec(
            select(Draft).where(Draft.message_id == message_id).order_by(Draft.created_at.desc())
        ).first()
        if draft:
            draft.approval_status = ApprovalStatus.rejected
            draft.approved_by = actor_name_for(current_user)
            draft.updated_at = datetime.utcnow()
            session.add(draft)
        message.status = MessageStatus.rejected
        message.updated_at = datetime.utcnow()
        session.add(message)
        session.commit()
        log_action(session, message_id, "rejected", actor_name_for(current_user))
        return {"message_id": message_id, "status": message.status}


@app.get("/messages/{message_id}/debug-context")
def debug_message_context(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        context = build_message_context(session, message)
        docs = session.exec(
            select(Document).where(Document.message_id == message_id).order_by(Document.created_at.desc())
        ).all()
        return {
            "message_id": message_id,
            "document_count": len(docs),
            "documents": [
                {
                    "id": doc.id, "filename": doc.filename,
                    "has_extracted_text": bool(doc.extracted_text),
                    "extracted_text_length": len(doc.extracted_text) if doc.extracted_text else 0,
                }
                for doc in docs
            ],
            "context_preview": context[:4000],
        }


@app.post("/messages/{message_id}/send")
def send_message(
    message_id: int,
    current_user: User = Depends(require_roles(UserRole.admin, UserRole.reviewer)),
) -> dict:
    with Session(engine, expire_on_commit=False) as session:
        message = get_message_or_404(session, message_id)
        if message.status != MessageStatus.approved:
            raise HTTPException(status_code=400, detail="Message must be approved before sending")
        message.status = MessageStatus.sent
        message.updated_at = datetime.utcnow()
        session.add(message)
        session.commit()
        log_action(session, message_id, "sent", actor_name_for(current_user))
        return {"message_id": message_id, "status": message.status, "note": "Stub send endpoint succeeded"}