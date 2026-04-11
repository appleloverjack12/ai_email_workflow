"use client";

import React, { useEffect, useMemo, useState, useRef } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

type MessageCategory = "lead" | "quote_request" | "invoice" | "support" | "appointment" | "spam" | "other";
type MessageStatus = "new" | "processing" | "needs_review" | "approved" | "sent" | "rejected" | "error" | "archived" | "ignored" | "waiting_for_info" | "ready_for_quote" | "ready_for_site_visit";
type UploadedDocument = { id: number; filename: string; file_type?: string | null; storage_path?: string | null; created_at: string; };
type AuthUser = { id: number; email: string; full_name: string; role: "admin" | "reviewer"; is_active: boolean; };
type DocumentsResponse = { message_id: number; documents: UploadedDocument[]; };
type Message = { id: number; subject: string; sender_email: string; sender_name?: string | null; body_text: string; category: MessageCategory; status: MessageStatus; ai_confidence?: number | null; source: "manual" | "gmail"; gmail_message_id?: string | null; gmail_thread_id?: string | null; gmail_synced_at?: string | null; has_attachments: boolean; created_at: string; updated_at: string; };
type ElectricalServiceType = "strong_current" | "weak_current" | "solar" | "maintenance" | "project_design" | "unknown";
type ElectricalQuoteBrief = { service_type: ElectricalServiceType; service_label: string; lead_priority: LeadPriority; lead_score: number; current_workflow_status: string; client_name?: string | null; client_email?: string | null; client_phone?: string | null; location?: string | null; object_type?: string | null; budget?: string | null; timeline?: string | null; urgency?: string | null; installation_type?: string | null; attachments_summary?: string | null; missing_fields: string[]; recommended_next_step: string; estimator_summary: string; };
type LeadPriority = "hot" | "needs_info" | "low_detail";
type ElectricalQualification = { service_type: ElectricalServiceType; service_label: string; object_type?: string | null; location?: string | null; budget?: string | null; timeline?: string | null; urgency?: string | null; power_capacity?: string | null; installation_type?: string | null; attachments_summary?: string | null; lead_priority: LeadPriority; lead_score: number; missing_fields: string[]; recommended_next_step: string; client_summary: string; };
type InternalNote = { id: number; message_id: number; author: string; note_text: string; created_at: string; };
type QueueFilter = "needs_review" | "waiting_for_info" | "new" | "approved" | "sent" | "ignored" | "archived" | "all";
type ProcessedMessage = { message_id: number; category: MessageCategory; confidence: number; classification_summary?: string; extracted_fields?: Record<string, unknown>; draft_text?: string; status: MessageStatus; };
type LatestExtractionResponse = { message_id: number; extracted_fields_id?: number; extracted_fields: Record<string, unknown> | null; classification_summary?: string | null; created_at?: string; };
type ReplyTone = "professional" | "friendly" | "concise" | "warm";
type CompanySettings = { company_name: string; preferred_reply_tone: ReplyTone; reply_signature: string; ignore_senders: string[]; quote_required_fields: string[]; };
type AuditLogItem = { id: number; action: string; actor: string; metadata_json?: string | null; created_at: string; };
type AuditLogsResponse = { message_id: number; audit_logs: AuditLogItem[]; };
type LatestDraftResponse = { message_id: number; draft_id?: number; draft_text: string | null; approval_status?: string; approved_by?: string | null; created_at?: string; updated_at?: string; draft?: null; };
type Toast = { type: "success" | "error"; message: string; };

// ─── Constants ───────────────────────────────────────────────────────────────

const API_BASE = "http://127.0.0.1:8000";

const QUEUE_KEYS: QueueFilter[] = ["needs_review", "waiting_for_info", "new", "approved", "sent", "ignored", "archived", "all"];

const queueConfig: Record<QueueFilter, { label: string; description: string; emptyMessage: string; tileGrad: string; tileText: string; activeBg: string }> = {
  needs_review:     { label: "Needs review",    description: "Messages that need human review before the next step.",                     emptyMessage: "No messages waiting for review.",     tileGrad: "from-blue-600 to-indigo-700",   tileText: "text-white", activeBg: "bg-blue-600" },
  waiting_for_info: { label: "Waiting for info", description: "Messages waiting for customer details before you can continue.",            emptyMessage: "No messages waiting for info.",       tileGrad: "from-sky-500 to-cyan-600",      tileText: "text-white", activeBg: "bg-sky-500" },
  new:              { label: "New",             description: "Freshly imported or created messages not yet processed.",                    emptyMessage: "No new messages.",                   tileGrad: "from-slate-600 to-slate-700",   tileText: "text-white", activeBg: "bg-slate-600" },
  approved:         { label: "Approved",        description: "Approved messages that are ready to be sent.",                               emptyMessage: "No approved messages.",               tileGrad: "from-emerald-500 to-teal-600",  tileText: "text-white", activeBg: "bg-emerald-600" },
  sent:             { label: "Sent",            description: "Completed outbound replies already sent.",                                   emptyMessage: "No sent messages yet.",              tileGrad: "from-violet-600 to-purple-700", tileText: "text-white", activeBg: "bg-violet-600" },
  ignored:          { label: "Ignored",         description: "Low-priority or auto-triaged messages kept out of the active workflow.",     emptyMessage: "No ignored messages.",               tileGrad: "from-orange-500 to-amber-600",  tileText: "text-white", activeBg: "bg-orange-500" },
  archived:         { label: "Archived",        description: "Finished items removed from the active queue.",                              emptyMessage: "No archived messages.",              tileGrad: "from-slate-400 to-slate-500",   tileText: "text-white", activeBg: "bg-slate-400" },
  all:              { label: "All",             description: "Every message in the system.",                                               emptyMessage: "No messages yet.",                   tileGrad: "from-slate-800 to-slate-900",   tileText: "text-white", activeBg: "bg-slate-800" },
};

// Which message statuses count towards each queue filter
function statusMatchesFilter(status: MessageStatus, filter: QueueFilter): boolean {
  if (filter === "all") return true;
  if (filter === "ignored") return status === "ignored";
  if (filter === "archived") return status === "archived";
  if (filter === "needs_review") return status === "needs_review";
  if (filter === "waiting_for_info") return status === "waiting_for_info";
  if (filter === "new") return status === "new" || status === "processing";
  if (filter === "approved") return status === "approved" || status === "ready_for_quote" || status === "ready_for_site_visit";
  if (filter === "sent") return status === "sent";
  return false;
}

const statusStyles: Record<MessageStatus, string> = {
  new: "bg-slate-100 text-slate-600 border-slate-200", processing: "bg-amber-50 text-amber-700 border-amber-200",
  waiting_for_info: "bg-sky-50 text-sky-700 border-sky-200", needs_review: "bg-blue-50 text-blue-700 border-blue-200",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200", sent: "bg-violet-50 text-violet-700 border-violet-200",
  rejected: "bg-rose-50 text-rose-700 border-rose-200", error: "bg-red-50 text-red-700 border-red-200",
  archived: "bg-slate-100 text-slate-500 border-slate-200", ignored: "bg-orange-50 text-orange-700 border-orange-200",
  ready_for_quote: "bg-violet-50 text-violet-700 border-violet-200", ready_for_site_visit: "bg-sky-50 text-sky-700 border-sky-200",
};
const statusDots: Record<MessageStatus, string> = {
  new: "bg-slate-400", processing: "bg-amber-400", needs_review: "bg-blue-500", waiting_for_info: "bg-sky-400",
  approved: "bg-emerald-500", sent: "bg-violet-500", rejected: "bg-rose-500", error: "bg-red-500",
  archived: "bg-slate-300", ignored: "bg-orange-400", ready_for_quote: "bg-violet-400", ready_for_site_visit: "bg-sky-400",
};
const statusLabels: Record<MessageStatus, string> = {
  new: "New", processing: "Processing", needs_review: "Needs review", waiting_for_info: "Waiting for info",
  approved: "Approved", sent: "Sent", rejected: "Rejected", error: "Error",
  archived: "Archived", ignored: "Ignored", ready_for_site_visit: "Site visit", ready_for_quote: "Ready for quote",
};
const leadPriorityLabels: Record<LeadPriority, string> = { hot: "High priority", needs_info: "Needs more info", low_detail: "Low detail" };
const serviceTypeLabels: Record<ElectricalServiceType, string> = { strong_current: "Strong current", weak_current: "Weak current", solar: "Solar installation", maintenance: "Maintenance", project_design: "Design / automation", unknown: "Unknown" };
const categoryStyles: Record<MessageCategory, string> = {
  lead: "bg-cyan-50 text-cyan-700 border-cyan-200", quote_request: "bg-indigo-50 text-indigo-700 border-indigo-200",
  invoice: "bg-orange-50 text-orange-700 border-orange-200", support: "bg-pink-50 text-pink-700 border-pink-200",
  appointment: "bg-lime-50 text-lime-700 border-lime-200", spam: "bg-red-50 text-red-700 border-red-200",
  other: "bg-slate-50 text-slate-600 border-slate-200",
};

function formatDate(v: string) { try { return new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" }).format(new Date(v)) + " UTC"; } catch { return v; } }
function prettyKey(k: string) { return k.replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase()); }

// ─── Design System ────────────────────────────────────────────────────────────

function Chip({ text, className = "" }: { text: string; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold tracking-wide ${className}`}>{text}</span>;
}
function StatusChip({ status }: { status: MessageStatus }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${statusStyles[status]}`}><span className={`size-1.5 shrink-0 rounded-full ${statusDots[status]}`} />{statusLabels[status]}</span>;
}
function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</div>;
}
function PanelHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4">
      <div><h3 className="text-sm font-bold text-slate-900">{title}</h3>{subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}</div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}
function Label({ children }: { children: React.ReactNode }) { return <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{children}</p>; }
function Empty({ icon, text }: { icon?: string; text: string }) {
  return <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-10 text-center">{icon && <span className="text-2xl opacity-30">{icon}</span>}<p className="text-xs text-slate-400">{text}</p></div>;
}
function Btn({ children, onClick, disabled, variant = "ghost", size = "sm", className = "" }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; variant?: "primary"|"ghost"|"danger"|"success"|"warning"|"brand"|"sky"; size?: "xs"|"sm"|"md"; className?: string; }) {
  const base = "inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none";
  const sizes = { xs: "px-2.5 py-1.5 text-[11px]", sm: "px-3.5 py-2 text-xs", md: "px-5 py-2.5 text-sm" };
  const variants = { primary: "bg-slate-900 text-white hover:bg-slate-700", ghost: "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-300", danger: "border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100", success: "bg-emerald-600 text-white hover:bg-emerald-700", warning: "bg-amber-500 text-white hover:bg-amber-600", brand: "bg-violet-600 text-white hover:bg-violet-700", sky: "bg-sky-600 text-white hover:bg-sky-700" };
  return <button onClick={onClick} disabled={disabled} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}>{children}</button>;
}
function Input({ value, onChange, placeholder, className = "" }: { value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; placeholder?: string; className?: string }) {
  return <input value={value} onChange={onChange} placeholder={placeholder} className={`w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm placeholder-slate-400 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 ${className}`} />;
}
function Textarea({ value, onChange, placeholder, rows = 5, className = "" }: { value: string; onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void; placeholder?: string; rows?: number; className?: string }) {
  return <textarea value={value} onChange={onChange} placeholder={placeholder} rows={rows} className={`w-full resize-none rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm placeholder-slate-400 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 ${className}`} />;
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function Page() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [processedData, setProcessedData] = useState<ProcessedMessage | null>(null);
  const [editedDraft, setEditedDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("needs_review");
  const [toast, setToast] = useState<Toast | null>(null);
  const [documents, setDocuments] = useState<UploadedDocument[]>([]);
  const DEMO_COMPANY_NAME = "Elesys";
  const [uploading, setUploading] = useState(false);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [electricalQualification, setElectricalQualification] = useState<ElectricalQualification | null>(null);
  const [qualificationLoading, setQualificationLoading] = useState(false);
  const [notes, setNotes] = useState<InternalNote[]>([]);
  const [newNote, setNewNote] = useState("");
  const [quoteBrief, setQuoteBrief] = useState<ElectricalQuoteBrief | null>(null);
  const [quoteBriefLoading, setQuoteBriefLoading] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [loggingIn, setLoggingIn] = useState(false);
  const [settings, setSettings] = useState<CompanySettings>({ company_name: "Your Company", preferred_reply_tone: "professional", reply_signature: "Best,\nYour Company", ignore_senders: [], quote_required_fields: ["company_name","website_url","budget","timeline","location","pages_needed","business_goals"] });
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [ignoreSendersText, setIgnoreSendersText] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const filteredMessages = useMemo(() => messages.filter((m) => {
    const q = search.trim().toLowerCase();
    const matchesSearch = q === "" || m.subject.toLowerCase().includes(q) || m.sender_email.toLowerCase().includes(q) || (m.sender_name || "").toLowerCase().includes(q);
    return matchesSearch && statusMatchesFilter(m.status, queueFilter);
  }), [messages, search, queueFilter]);

  const stats = useMemo(() => ({ total: messages.length, review: messages.filter(m => m.status === "needs_review").length, approved: messages.filter(m => m.status === "approved").length, sent: messages.filter(m => m.status === "sent").length }), [messages]);

  const queueCounts = useMemo((): Record<QueueFilter, number> => ({
    needs_review: messages.filter(m => statusMatchesFilter(m.status, "needs_review")).length,
    waiting_for_info: messages.filter(m => statusMatchesFilter(m.status, "waiting_for_info")).length,
    new: messages.filter(m => statusMatchesFilter(m.status, "new")).length,
    approved: messages.filter(m => statusMatchesFilter(m.status, "approved")).length,
    sent: messages.filter(m => statusMatchesFilter(m.status, "sent")).length,
    ignored: messages.filter(m => statusMatchesFilter(m.status, "ignored")).length,
    archived: messages.filter(m => statusMatchesFilter(m.status, "archived")).length,
    all: messages.length,
  }), [messages]);

  const quoteFields = processedData?.extracted_fields ?? {};
  const isElectricalLead = electricalQualification !== null && electricalQualification.service_type !== "unknown";
  const quoteSummary = { requested_service: quoteFields["requested_service"], project_type: quoteFields["project_type"], company_name: quoteFields["company_name"], website_url: quoteFields["website_url"], budget: quoteFields["budget"], timeline: quoteFields["timeline"], location: quoteFields["location"], pages_needed: quoteFields["pages_needed"], business_goals: quoteFields["business_goals"], missing_information: quoteFields["missing_information"] };
  const missingInfoItems = Array.isArray(quoteSummary.missing_information) ? quoteSummary.missing_information : [];
  function renderFieldValue(v: unknown) { if (v === null || v === undefined || v === "") return "—"; if (Array.isArray(v)) return v.length > 0 ? v.join(", ") : "—"; return String(v); }

  const workflowRecommendation = useMemo(() => {
    if (!selectedMessage) return { tone: "slate", title: "No message selected", description: "Select a message from the queue to see the recommended next step.", action: null as null | "process" | "missing-info" | "approve" | "send" | "none", actionLabel: "" };
    if (selectedMessage.status === "ready_for_site_visit") return { tone: "sky", title: "Ready for site visit", description: "This lead has been qualified for a site inspection.", action: "none" as const, actionLabel: "" };
    if (selectedMessage.status === "ready_for_quote") return { tone: "violet", title: "Ready for quote", description: "This lead is ready for quote preparation.", action: "none" as const, actionLabel: "" };
    if (selectedMessage.status === "waiting_for_info") return { tone: "sky", title: "Waiting for missing information", description: "A follow-up draft is ready. Review and send it when ready.", action: "send" as const, actionLabel: "Send follow-up" };
    if (selectedMessage.status === "sent") return { tone: "emerald", title: "Completed", description: "This message has already been sent. No further action needed.", action: null, actionLabel: "" };
    if (selectedMessage.status === "ignored") return { tone: "orange", title: "Filtered from active workflow", description: "This message was identified as low-priority. Restore it if relevant.", action: null, actionLabel: "" };
    if (selectedMessage.status === "archived") return { tone: "slate", title: "Archived", description: "This message is archived. Unarchive it to bring it back.", action: null, actionLabel: "" };
    if (selectedMessage.status === "approved") return { tone: "violet", title: "Ready to send", description: "The draft has been approved and is ready to be sent.", action: "send" as const, actionLabel: "Send now" };
    if (!processedData) return { tone: "blue", title: "Process this request", description: "Run AI processing to extract details and generate a draft reply.", action: "process" as const, actionLabel: "Process with AI" };
    if (missingInfoItems.length > 0) return { tone: "amber", title: "Needs more info", description: `Missing ${missingInfoItems.length} detail${missingInfoItems.length === 1 ? "" : "s"}. Generate a follow-up for what is missing.`, action: "missing-info" as const, actionLabel: "Request missing info" };
    return { tone: "emerald", title: "Ready to quote", description: "This request looks complete. Review, refine, and approve a reply.", action: "approve" as const, actionLabel: "Approve draft" };
  }, [selectedMessage, processedData, missingInfoItems.length]);

  type RecStyle = { bar: string; bg: string; border: string; title: string };
  const recTones: Record<string, RecStyle> = {
    slate:   { bar: "bg-slate-400",   bg: "bg-slate-50",   border: "border-slate-200",   title: "text-slate-700" },
    blue:    { bar: "bg-blue-500",    bg: "bg-blue-50",    border: "border-blue-200",    title: "text-blue-900" },
    amber:   { bar: "bg-amber-400",   bg: "bg-amber-50",   border: "border-amber-200",   title: "text-amber-900" },
    emerald: { bar: "bg-emerald-500", bg: "bg-emerald-50", border: "border-emerald-200", title: "text-emerald-900" },
    violet:  { bar: "bg-violet-500",  bg: "bg-violet-50",  border: "border-violet-200",  title: "text-violet-900" },
    sky:     { bar: "bg-sky-500",     bg: "bg-sky-50",     border: "border-sky-200",     title: "text-sky-900" },
    orange:  { bar: "bg-orange-400",  bg: "bg-orange-50",  border: "border-orange-200",  title: "text-orange-900" },
  };
  const priorityStyles: Record<LeadPriority, string> = { hot: "bg-emerald-50 text-emerald-700 border-emerald-200", needs_info: "bg-amber-50 text-amber-700 border-amber-200", low_detail: "bg-slate-50 text-slate-600 border-slate-200" };
  const serviceStyles: Record<ElectricalServiceType, string> = { strong_current: "bg-blue-50 text-blue-700 border-blue-200", weak_current: "bg-cyan-50 text-cyan-700 border-cyan-200", solar: "bg-yellow-50 text-yellow-700 border-yellow-200", maintenance: "bg-orange-50 text-orange-700 border-orange-200", project_design: "bg-violet-50 text-violet-700 border-violet-200", unknown: "bg-slate-50 text-slate-600 border-slate-200" };

  useEffect(() => {
    if (filteredMessages.length === 0) { setSelectedId(null); setSelectedMessage(null); return; }
    if (!filteredMessages.some(m => m.id === selectedId)) { setSelectedId(filteredMessages[0].id); setSelectedMessage(filteredMessages[0]); }
  }, [filteredMessages, selectedId]);
  useEffect(() => { if (token && authUser) { fetchMessages(); fetchSettings(); } }, [token, authUser]);
  useEffect(() => { if (selectedId !== null && messages.some(m => m.id === selectedId)) fetchMessageDetail(selectedId); }, [selectedId, messages]);
  useEffect(() => { if (selectedId !== null && !messages.some(m => m.id === selectedId)) { setSelectedId(null); setSelectedMessage(null); setProcessedData(null); setEditedDraft(""); setDocuments([]); setAuditLogs([]); setNotes([]); setNewNote(""); setElectricalQualification(null); setQuoteBrief(null); } }, [messages, selectedId]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2500); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { const t = localStorage.getItem("auth_token"); const u = localStorage.getItem("auth_user"); if (t) setToken(t); if (u) setAuthUser(JSON.parse(u)); setAuthReady(true); }, []);

  async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
    const headers = new Headers(init.headers || {});
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const r = await fetch(input, { ...init, headers });
    if (r.status === 401) { localStorage.removeItem("auth_token"); localStorage.removeItem("auth_user"); setToken(null); setAuthUser(null); }
    return r;
  }

  async function fetchMessages() { setLoading(true); try { const r = await authFetch(`${API_BASE}/messages`); if (!r.ok) throw new Error("Failed to load messages"); const data: Message[] = await r.json(); const sorted = [...data].sort((a,b) => new Date(b.created_at).getTime()-new Date(a.created_at).getTime()); setMessages(sorted); if (data.length > 0 && selectedId === null) setSelectedId(data[0].id); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setLoading(false); } }
  async function fetchSettings() { try { const r = await authFetch(`${API_BASE}/settings`); const d = await r.json(); if (!r.ok) throw new Error(d.detail||"Failed to load settings"); setSettings(d); setIgnoreSendersText((d.ignore_senders||[]).join("\n")); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Failed to load settings"}); } }

  async function fetchMessageDetail(messageId: number) {
    if (!messages.some(m => m.id === messageId)) return;
    setDetailLoading(true);
    try {
      const mr = await authFetch(`${API_BASE}/messages/${messageId}`); if (!mr.ok) throw new Error("Failed"); const md: Message = await mr.json();
      if (selectedId !== messageId) return; setSelectedMessage(md);
      let ef: Record<string,unknown>|undefined, dt: string|undefined, cs: string|undefined;
      try { const r = await authFetch(`${API_BASE}/messages/${messageId}/latest-extraction`); if (r.ok) { const d: LatestExtractionResponse = await r.json(); if (d.extracted_fields) ef = d.extracted_fields; if (d.classification_summary) cs = d.classification_summary; } } catch {}
      try { const r = await authFetch(`${API_BASE}/messages/${messageId}/latest-draft`); if (r.ok) { const d: LatestDraftResponse = await r.json(); if (d.draft_text) dt = d.draft_text; } } catch {}
      if (selectedId !== messageId) return;
      if (ef || dt || cs) setProcessedData({ message_id: md.id, category: md.category, confidence: md.ai_confidence??0, classification_summary: cs, extracted_fields: ef, draft_text: dt, status: md.status }); else setProcessedData(null);
      setEditedDraft(dt ?? "");
      await fetchDocuments(messageId); await fetchAuditLogs(messageId); await fetchMessageNotes(messageId); await fetchElectricalQualification(messageId); await fetchQuoteBrief(messageId);
    } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); }
    finally { if (selectedId === messageId) setDetailLoading(false); }
  }

  async function fetchDocuments(id: number) { try { const r = await authFetch(`${API_BASE}/messages/${id}/documents`); if (!r.ok) throw new Error(); const d: DocumentsResponse = await r.json(); setDocuments(d.documents||[]); } catch { setDocuments([]); } }
  async function fetchAuditLogs(id: number) { try { const r = await authFetch(`${API_BASE}/messages/${id}/audit-logs`); if (!r.ok) throw new Error(); const d: AuditLogsResponse = await r.json(); setAuditLogs(d.audit_logs||[]); } catch { setAuditLogs([]); } }
  async function fetchMessageNotes(id: number) { try { const r = await authFetch(`${API_BASE}/messages/${id}/notes`); const d = await r.json(); if (!r.ok) throw new Error(); setNotes(d); } catch { setNotes([]); } }
  async function fetchElectricalQualification(id: number) { setQualificationLoading(true); try { const r = await authFetch(`${API_BASE}/messages/${id}/electrical-qualification`); const d = await r.json(); if (!r.ok) throw new Error(d.detail); if (selectedId===id) setElectricalQualification(d); } catch { if (selectedId===id) setElectricalQualification(null); } finally { if (selectedId===id) setQualificationLoading(false); } }
  async function fetchQuoteBrief(id: number) { setQuoteBriefLoading(true); try { const r = await authFetch(`${API_BASE}/messages/${id}/quote-brief`); const d = await r.json(); if (!r.ok) throw new Error(d.detail); if (selectedId===id) setQuoteBrief(d); } catch { if (selectedId===id) setQuoteBrief(null); setToast({type:"error",message:"Quote brief failed"}); } finally { if (selectedId===id) setQuoteBriefLoading(false); } }
  async function processSelectedMessage() { if (!selectedMessage) return; setActionLoading("process"); try { const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/process`,{method:"POST"}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setProcessedData(d); setEditedDraft(d.draft_text||""); await fetchMessages(); await fetchMessageDetail(selectedMessage.id); setToast({type:"success",message:"Message processed with AI."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setActionLoading(null); } }
  async function approveSelectedMessage() { if (!selectedMessage) return; setActionLoading("approve"); try { const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/approve`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({actor_name:"Jakov"})}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); await fetchMessageDetail(selectedMessage.id); setToast({type:"success",message:"Message approved."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setActionLoading(null); } }
  async function rejectSelectedMessage() { if (!selectedMessage) return; setActionLoading("reject"); try { const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/reject`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({actor_name:"Jakov"})}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); await fetchMessageDetail(selectedMessage.id); setToast({type:"success",message:"Message rejected."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setActionLoading(null); } }
  async function sendSelectedMessage() { if (!selectedMessage) return; setActionLoading("send"); try { const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/send-gmail`,{method:"POST"}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); await fetchMessageDetail(selectedMessage.id); setToast({type:"success",message:"Message sent via Gmail."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setActionLoading(null); } }
  async function saveEditedDraft() { if (!selectedMessage||!editedDraft.trim()) return; setActionLoading("edit"); try { const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/edit-draft`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({draft_text:editedDraft,editor_name:"Jakov"})}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessageDetail(selectedMessage.id); setToast({type:"success",message:"Draft saved."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setActionLoading(null); } }
  async function requestMissingInfoDraft() { if (!selectedMessage) return; setActionLoading("missing-info"); try { const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/draft-missing-info`,{method:"POST"}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setEditedDraft(d.draft_text||""); await fetchMessages(); await fetchMessageDetail(selectedMessage.id); setToast({type:"success",message:"Missing-info draft generated."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setActionLoading(null); } }
  async function ignoreSelectedMessage() { if (!selectedMessage) return; setActionLoading("ignore"); try { const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/ignore`,{method:"POST"}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); await fetchMessageDetail(selectedMessage.id); setToast({type:"success",message:"Message ignored."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setActionLoading(null); } }
  async function unignoreSelectedMessage() { if (!selectedMessage) return; setActionLoading("unignore"); try { const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/unignore`,{method:"POST"}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); await fetchMessageDetail(selectedMessage.id); setToast({type:"success",message:"Message restored to inbox."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setActionLoading(null); } }
  async function archiveSelectedMessage() { if (!selectedMessage) return; setActionLoading("archive"); try { const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/archive`,{method:"POST"}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setSelectedId(null); setSelectedMessage(null); setProcessedData(null); setEditedDraft(""); setDocuments([]); setAuditLogs([]); await fetchMessages(); setToast({type:"success",message:d.gmail_archived?"Archived locally and in Gmail.":"Message archived."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setActionLoading(null); } }
  async function unarchiveSelectedMessage() { if (!selectedMessage) return; setActionLoading("unarchive"); try { const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/unarchive`,{method:"POST"}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); await fetchMessageDetail(selectedMessage.id); setToast({type:"success",message:"Message unarchived."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setActionLoading(null); } }
  async function syncGmailInbox(autoProcess = false) { setActionLoading(autoProcess?"gmail-sync-ai":"gmail-sync"); try { const r = await authFetch(`${API_BASE}/gmail/sync?max_results=10&auto_process=${autoProcess?"true":"false"}`,{method:"POST"}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); setToast({type:"success",message:autoProcess?`Imported ${d.imported_count}, updated ${d.thread_reply_updated_count??0}, ignored ${d.auto_ignored_count??0}, processed ${d.processed_count}.`:`Imported ${d.imported_count}, updated ${d.thread_reply_updated_count??0}, ignored ${d.auto_ignored_count??0}.`}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setActionLoading(null); } }
  async function clearLocalInbox() { if (!window.confirm("Clear all local messages, drafts, documents, extracted fields, and audit logs?")) return; setActionLoading("clear-local"); try { const r = await authFetch(`${API_BASE}/messages/clear-local`,{method:"DELETE"}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setMessages([]); setSelectedId(null); setSelectedMessage(null); setProcessedData(null); setEditedDraft(""); setDocuments([]); setAuditLogs([]); setElectricalQualification(null); setToast({type:"success",message:"Local inbox cleared."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setActionLoading(null); } }
  async function addInternalNote() { if (!selectedMessage||!newNote.trim()) return; setSavingNote(true); try { const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/notes`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({author:"Jakov",note_text:newNote.trim()})}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setNewNote(""); await fetchMessageNotes(selectedMessage.id); await fetchAuditLogs(selectedMessage.id); setToast({type:"success",message:"Note added."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setSavingNote(false); } }
  async function markReadyForSiteVisit() { if (!selectedMessage) return; setActionLoading("ready-site-visit"); try { const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/ready-for-site-visit`,{method:"POST"}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); await fetchMessageDetail(selectedMessage.id); setToast({type:"success",message:"Marked as ready for site visit."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setActionLoading(null); } }
  async function markReadyForQuote() { if (!selectedMessage) return; setActionLoading("ready-quote"); try { const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/ready-for-quote`,{method:"POST"}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); await fetchMessageDetail(selectedMessage.id); setToast({type:"success",message:"Marked as ready for quote."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setActionLoading(null); } }
  async function downloadQuoteBriefPdf() { if (!selectedMessage) return; try { const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/quote-brief.pdf`); if (!r.ok) { const t = await r.text(); throw new Error(t||"Failed"); } const blob = await r.blob(); const url = window.URL.createObjectURL(blob); const a = document.createElement("a"); a.href=url; a.download=`quote-brief-${selectedMessage.id}.pdf`; document.body.appendChild(a); a.click(); a.remove(); window.URL.revokeObjectURL(url); setToast({type:"success",message:"Quote brief PDF exported."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Failed to export PDF"}); } }
  async function saveSettings() { setSettingsSaving(true); try { const r = await authFetch(`${API_BASE}/settings`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({...settings,ignore_senders:ignoreSendersText.split("\n").map(l=>l.trim()).filter(Boolean)})}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setSettings(d); setIgnoreSendersText((d.ignore_senders||[]).join("\n")); setToast({type:"success",message:"Settings saved."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Failed to save settings"}); } finally { setSettingsSaving(false); } }
  async function login() { setLoggingIn(true); try { const r = await fetch(`${API_BASE}/auth/login`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(loginForm)}); const d = await r.json(); if (!r.ok) throw new Error(d.detail||"Login failed"); localStorage.setItem("auth_token",d.access_token); localStorage.setItem("auth_user",JSON.stringify(d.user)); setToken(d.access_token); setAuthUser(d.user); setToast({type:"success",message:"Logged in."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setLoggingIn(false); } }
  async function bootstrapAdmin() { setLoggingIn(true); try { const r = await fetch(`${API_BASE}/auth/bootstrap`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:loginForm.email,full_name:"Jakov",password:loginForm.password})}); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setToast({type:"success",message:"Admin account created. Now log in."}); } catch(e) { setToast({type:"error",message:e instanceof Error?e.message:"Unknown error"}); } finally { setLoggingIn(false); } }
  function logout() { localStorage.removeItem("auth_token"); localStorage.removeItem("auth_user"); setToken(null); setAuthUser(null); }
  function toggleRequiredField(f: string) { setSettings(p => ({...p,quote_required_fields:p.quote_required_fields.includes(f)?p.quote_required_fields.filter(x=>x!==f):[...p.quote_required_fields,f]})); }

  // ─── Auth screens ─────────────────────────────────────────────────────────

  if (!authReady) return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800">
      <div className="flex items-center gap-2 text-sm text-slate-400"><svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Loading…</div>
    </div>
  );

  if (!token || !authUser) return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-yellow-400 to-orange-500 shadow-lg shadow-orange-500/30">
            <svg className="size-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
          </div>
          <h1 className="text-2xl font-black text-white">Elesys Workflow</h1>
          <p className="mt-1 text-sm text-slate-400">Sign in to access your dashboard</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
          <div className="space-y-4">
            <div><label className="mb-1.5 block text-xs font-semibold text-slate-300">Email address</label><input value={loginForm.email} onChange={e=>setLoginForm(p=>({...p,email:e.target.value}))} placeholder="you@example.com" className="w-full rounded-lg border border-white/10 bg-white/10 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-yellow-400/50"/></div>
            <div><label className="mb-1.5 block text-xs font-semibold text-slate-300">Password</label><input type="password" value={loginForm.password} onChange={e=>setLoginForm(p=>({...p,password:e.target.value}))} placeholder="••••••••" className="w-full rounded-lg border border-white/10 bg-white/10 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-yellow-400/50"/></div>
            <div className="flex gap-2 pt-1">
              <button onClick={login} disabled={loggingIn} className="flex-1 rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-4 py-2.5 text-sm font-bold text-white shadow-lg disabled:opacity-50">{loggingIn?"Signing in…":"Sign in"}</button>
              <button onClick={bootstrapAdmin} disabled={loggingIn} className="rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-slate-300 hover:bg-white/10 disabled:opacity-50">Create admin</button>
            </div>
          </div>
        </div>
      </div>
      {toast && <ToastNotification toast={toast}/>}
    </div>
  );

  // ─── Main App ──────────────────────────────────────────────────────────────

  const recStyle = recTones[workflowRecommendation.tone] ?? recTones.slate;

  return (
    <div className="flex min-h-screen flex-col bg-slate-100 text-slate-900">

      {/* ── Nav ── */}
      <header className="sticky top-0 z-30 border-b border-slate-800/50 bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 xl:px-6">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-yellow-400 to-orange-500 shadow-md shadow-orange-500/30">
              <svg className="size-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
            </div>
            <div>
              <span className="text-sm font-black text-white">{DEMO_COMPANY_NAME}</span>
              <span className="ml-2 rounded-md bg-yellow-400/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-yellow-300">Demo</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <NavBtn onClick={fetchMessages} disabled={loading}>{loading?"Refreshing…":"↻ Refresh"}</NavBtn>
            <NavBtn onClick={()=>syncGmailInbox(false)} disabled={actionLoading!==null}>Sync Gmail</NavBtn>
            <button onClick={()=>syncGmailInbox(true)} disabled={actionLoading!==null} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-emerald-500 disabled:opacity-40">Sync + AI</button>
            <button onClick={processSelectedMessage} disabled={!selectedMessage||actionLoading!==null} className="rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 px-3 py-1.5 text-[11px] font-bold text-white shadow disabled:opacity-40">⚡ Process with AI</button>
            <div className="h-4 w-px bg-white/10"/>
            <button onClick={()=>setSettingsOpen(o=>!o)} className={`rounded-lg border px-3 py-1.5 text-[11px] font-semibold transition ${settingsOpen?"border-yellow-400/40 bg-yellow-400/10 text-yellow-300":"border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"}`}>⚙ Settings</button>
            <button onClick={clearLocalInbox} disabled={actionLoading!==null} className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-[11px] font-semibold text-rose-400 hover:bg-rose-500/20 disabled:opacity-40">Clear inbox</button>
            <div className="h-4 w-px bg-white/10"/>
            <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-slate-300"><span className="font-bold text-white">{authUser.full_name}</span> · {authUser.role}</div>
            <NavBtn onClick={logout}>Logout</NavBtn>
          </div>
        </div>
      </header>

      <div className="flex-1 px-4 py-5 xl:px-6">

        {/* Settings */}
        {settingsOpen && (
          <Panel className="mb-5">
            <PanelHeader title="Company settings" subtitle="Business rules, response tone, email signature, and quote requirements." right={<><Btn variant="ghost" size="xs" onClick={()=>setSettingsOpen(false)}>Collapse</Btn><Btn variant="primary" size="xs" onClick={saveSettings} disabled={settingsSaving||settingsLoading}>{settingsSaving?"Saving…":"Save settings"}</Btn></>} />
            <div className="grid gap-5 p-6 md:grid-cols-2">
              <div><label className="mb-1.5 block text-xs font-semibold text-slate-600">Company name</label><Input value={settings.company_name} onChange={e=>setSettings(p=>({...p,company_name:e.target.value}))} placeholder="Elesys"/></div>
              <div><label className="mb-1.5 block text-xs font-semibold text-slate-600">Reply tone</label><select value={settings.preferred_reply_tone} onChange={e=>setSettings(p=>({...p,preferred_reply_tone:e.target.value as ReplyTone}))} className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-slate-400"><option value="professional">Professional</option><option value="friendly">Friendly</option><option value="concise">Concise</option><option value="warm">Warm</option></select></div>
              <div className="md:col-span-2"><label className="mb-1.5 block text-xs font-semibold text-slate-600">Reply signature</label><Textarea value={settings.reply_signature} onChange={e=>setSettings(p=>({...p,reply_signature:e.target.value}))} placeholder={"Best,\nElesys"} rows={4}/></div>
              <div><label className="mb-1.5 block text-xs font-semibold text-slate-600">Ignore senders <span className="font-normal text-slate-400">(one per line)</span></label><Textarea value={ignoreSendersText} onChange={e=>setIgnoreSendersText(e.target.value)} placeholder={"newsletter@\nlinkedin.com"} rows={6}/></div>
              <div><label className="mb-2 block text-xs font-semibold text-slate-600">Required quote fields</label><div className="space-y-1.5">{[["company_name","Company name"],["website_url","Website URL"],["budget","Budget"],["timeline","Timeline"],["location","Location"],["pages_needed","Pages needed"],["business_goals","Business goals"],["requested_service","Requested service"],["project_type","Project type"]].map(([val,lbl])=><label key={val} className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 hover:bg-slate-100"><input type="checkbox" checked={settings.quote_required_fields.includes(val)} onChange={()=>toggleRequiredField(val)} className="size-3.5 rounded accent-slate-900"/>{lbl}</label>)}</div></div>
            </div>
          </Panel>
        )}

        {/* Stats */}
        <div className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
          {[
            { label:"Total messages", value:stats.total,   grad:"from-slate-800 to-slate-700" },
            { label:"Needs review",   value:stats.review,  grad:"from-blue-600 to-indigo-700" },
            { label:"Approved",       value:stats.approved,grad:"from-emerald-500 to-teal-600" },
            { label:"Sent",           value:stats.sent,    grad:"from-violet-600 to-purple-700" },
          ].map(s=>(
            <div key={s.label} className={`rounded-xl bg-gradient-to-br px-5 py-4 ${s.grad}`}>
              <p className="text-[10px] font-bold uppercase tracking-widest text-white/60">{s.label}</p>
              <p className="mt-1 text-3xl font-black tabular-nums tracking-tight text-white">{s.value}</p>
            </div>
          ))}
        </div>

        {/* Main layout */}
        <div className="grid gap-5 xl:grid-cols-[400px_minmax(0,1fr)]">

          {/* ── Sidebar ── */}
          <div className="xl:sticky xl:top-[61px] xl:h-[calc(100vh-77px)]">
            <Panel className="flex h-full flex-col overflow-hidden">
              <div className="border-b border-slate-100 px-4 py-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-black text-slate-900">Review Queue</h2>
                  <span className="rounded-full bg-slate-900 px-2.5 py-1 text-[11px] font-bold text-white">{filteredMessages.length}</span>
                </div>
                <p className="mt-1 text-[11px] text-slate-400">{queueConfig[queueFilter].description}</p>

                {/* 2×4 grid of filter tiles */}
                <div className="mt-3 grid grid-cols-4 gap-1.5">
                  {QUEUE_KEYS.map(key=>{
                    const active = queueFilter===key;
                    const cfg = queueConfig[key];
                    return (
                      <button key={key} onClick={()=>setQueueFilter(key)}
                        className={`flex flex-col items-center justify-center rounded-xl px-1 py-2.5 text-center transition-all ${active?`bg-gradient-to-br ${cfg.tileGrad} shadow-sm`:"bg-slate-100 hover:bg-slate-200"}`}>
                        <span className={`text-[9px] font-bold uppercase leading-tight tracking-wide ${active?"text-white/80":"text-slate-500"}`}>{cfg.label}</span>
                        <span className={`mt-1 text-lg font-black tabular-nums leading-none ${active?"text-white":""}`}>{queueCounts[key]}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="relative mt-3">
                  <svg className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8"/><path strokeLinecap="round" d="m21 21-4.35-4.35"/></svg>
                  <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search subject or sender…" className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-8 pr-3 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100"/>
                </div>
              </div>

              <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
                {filteredMessages.map(msg=>{
                  const active = selectedId===msg.id;
                  return (
                    <button key={msg.id} onClick={()=>{setSelectedId(msg.id);setSelectedMessage(msg);}}
                      className={`w-full rounded-xl border p-3.5 text-left transition-all ${active?"border-slate-900 bg-slate-900 shadow-lg":"border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm"}`}>
                      <div className="flex items-start justify-between gap-2">
                        <p className={`truncate text-xs font-bold leading-snug ${active?"text-white":"text-slate-900"}`}>{msg.subject}</p>
                        <span className={`shrink-0 text-[10px] ${active?"text-slate-400":"text-slate-400"}`}>{new Date(msg.updated_at).toLocaleDateString("en-GB",{day:"2-digit",month:"short"})}</span>
                      </div>
                      <p className={`mt-1 truncate text-[11px] ${active?"text-slate-400":"text-slate-500"}`}>{msg.sender_name||msg.sender_email}</p>
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold ${active?"bg-white/10 text-white":`border ${statusStyles[msg.status]}`}`}>
                          <span className={`size-1.5 rounded-full ${active?"bg-white/60":statusDots[msg.status]}`}/>{statusLabels[msg.status]}
                        </span>
                        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold ${active?"bg-white/10 text-white":`border ${categoryStyles[msg.category]}`}`}>{prettyKey(msg.category)}</span>
                        {msg.source==="gmail"&&<span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold ${active?"bg-white/10 text-white":"border border-slate-200 bg-slate-50 text-slate-500"}`}>Gmail</span>}
                        {msg.has_attachments&&<span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold ${active?"bg-white/10 text-white":"border border-amber-200 bg-amber-50 text-amber-700"}`}>📎</span>}
                      </div>
                    </button>
                  );
                })}
                {filteredMessages.length===0&&<Empty icon={queueFilter==="ignored"?"🚫":queueFilter==="archived"?"📦":"📭"} text={queueConfig[queueFilter].emptyMessage}/>}
              </div>
            </Panel>
          </div>

          {/* ── Detail ── */}
          <div className="space-y-5">

            <Panel>
              <div className="p-6">
                {!selectedMessage ? <Empty icon="👈" text="Select a message from the queue to get started."/> : (
                  <>
                    {detailLoading&&<div className="mb-4 flex items-center gap-2 text-xs text-slate-400"><svg className="size-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Loading…</div>}
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <Label>Active inquiry</Label>
                        <h2 className="mt-1.5 text-xl font-black leading-snug text-slate-900">{selectedMessage.subject}</h2>
                        <p className="mt-1.5 text-sm text-slate-500"><span className="font-semibold text-slate-700">{selectedMessage.sender_name||"Unknown sender"}</span>{" · "}{selectedMessage.sender_email}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <StatusChip status={selectedMessage.status}/>
                        <Chip text={prettyKey(selectedMessage.category)} className={categoryStyles[selectedMessage.category]}/>
                        <Chip text={selectedMessage.source==="gmail"?"Gmail":"Manual"} className="border-slate-200 bg-slate-50 text-slate-600"/>
                        {selectedMessage.has_attachments&&<Chip text="📎 Attachment" className="border-amber-200 bg-amber-50 text-amber-700"/>}
                        {typeof selectedMessage.ai_confidence==="number"&&<Chip text={`AI ${Math.round(selectedMessage.ai_confidence*100)}%`} className="border-slate-200 bg-slate-50 text-slate-600"/>}
                      </div>
                    </div>

                    <div className="mt-4 border-t border-slate-100 pt-4">
                      <Label>Original email</Label>
                      <div className="mt-2 max-h-52 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-7 text-slate-700 whitespace-pre-wrap break-words">{selectedMessage.body_text}</div>
                    </div>

                    {/* Recommendation */}
                    <div className={`mt-4 overflow-hidden rounded-xl border ${recStyle.border} ${recStyle.bg}`}>
                      <div className={`h-1 w-full ${recStyle.bar}`}/>
                      <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-widest opacity-50">Recommended next step</p>
                          <p className={`mt-1 text-sm font-bold ${recStyle.title}`}>{workflowRecommendation.title}</p>
                          <p className={`mt-1 text-xs leading-relaxed opacity-75 ${recStyle.title}`}>{workflowRecommendation.description}</p>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          {workflowRecommendation.action==="process"&&<Btn variant="primary" size="sm" onClick={processSelectedMessage} disabled={actionLoading!==null}>{workflowRecommendation.actionLabel}</Btn>}
                          {workflowRecommendation.action==="missing-info"&&<Btn variant="warning" size="sm" onClick={requestMissingInfoDraft} disabled={actionLoading!==null}>{workflowRecommendation.actionLabel}</Btn>}
                          {workflowRecommendation.action==="approve"&&<Btn variant="success" size="sm" onClick={approveSelectedMessage} disabled={actionLoading!==null||selectedMessage.status==="approved"||selectedMessage.status==="sent"}>{workflowRecommendation.actionLabel}</Btn>}
                          {workflowRecommendation.action==="send"&&<Btn variant="brand" size="sm" onClick={sendSelectedMessage} disabled={actionLoading!==null||!["approved","waiting_for_info"].includes(selectedMessage.status)}>{workflowRecommendation.actionLabel}</Btn>}
                        </div>
                      </div>
                      {missingInfoItems.length>0&&(
                        <div className="border-t border-amber-200/60 bg-white/40 px-4 py-3">
                          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-800">Missing details</p>
                          <div className="flex flex-wrap gap-1.5">{missingInfoItems.map((item,i)=><span key={i} className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">{item}</span>)}</div>
                        </div>
                      )}
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      {selectedMessage.status==="archived"?<Btn variant="ghost" size="xs" onClick={unarchiveSelectedMessage} disabled={actionLoading!==null}>↩ Unarchive</Btn>:<Btn variant="ghost" size="xs" onClick={archiveSelectedMessage} disabled={actionLoading!==null}>Archive</Btn>}
                      {selectedMessage.status==="ignored"?<Btn variant="ghost" size="xs" onClick={unignoreSelectedMessage} disabled={actionLoading!==null}>↩ Unignore</Btn>:<Btn variant="ghost" size="xs" onClick={ignoreSelectedMessage} disabled={actionLoading!==null||selectedMessage.status==="archived"}>Ignore</Btn>}
                      <Btn variant="success" size="xs" onClick={approveSelectedMessage} disabled={actionLoading!==null||selectedMessage.status==="approved"||selectedMessage.status==="sent"||selectedMessage.status==="archived"}>✓ Approve</Btn>
                      <Btn variant="ghost" size="xs" onClick={rejectSelectedMessage} disabled={actionLoading!==null||selectedMessage.status==="sent"}>Reject</Btn>
                      <Btn variant="brand" size="xs" onClick={sendSelectedMessage} disabled={actionLoading!==null||selectedMessage.status!=="approved"}>↑ Send via Gmail</Btn>
                    </div>
                  </>
                )}
              </div>
            </Panel>

            {/* Electrical Quote Brief */}
            {isElectricalLead&&(
              <Panel>
                <PanelHeader title="Electrical Quote Brief" subtitle="Estimator handoff — site visit and quote preparation" right={quoteBrief?(
                  <><Chip text={leadPriorityLabels[quoteBrief.lead_priority]} className={priorityStyles[quoteBrief.lead_priority]}/><Btn variant="sky" size="xs" onClick={markReadyForSiteVisit} disabled={!selectedMessage||actionLoading!==null}>Site visit</Btn><Btn variant="brand" size="xs" onClick={markReadyForQuote} disabled={!selectedMessage||actionLoading!==null}>Ready for quote</Btn><Btn variant="ghost" size="xs" onClick={downloadQuoteBriefPdf} disabled={!selectedMessage||quoteBriefLoading||actionLoading!==null}>↓ PDF</Btn></>
                ):null}/>
                <div className="p-6">
                  {quoteBriefLoading?<Empty text="Loading quote brief…"/>:quoteBrief?(
                    <div className="space-y-4">
                      <div className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-slate-100/50 p-4">
                        <div><Label>Service type</Label><p className="mt-1 text-base font-black text-slate-900">{serviceTypeLabels[quoteBrief.service_type]}</p><p className="mt-1.5 text-sm leading-relaxed text-slate-600">{quoteBrief.estimator_summary}</p></div>
                        <div className="shrink-0 text-right"><Label>Lead score</Label><p className="mt-1 text-4xl font-black tabular-nums text-slate-900">{quoteBrief.lead_score}<span className="text-lg font-semibold text-slate-400">/100</span></p></div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {[["Client",quoteBrief.client_name],["Email",quoteBrief.client_email],["Phone",quoteBrief.client_phone],["Location",quoteBrief.location],["Property type",quoteBrief.object_type],["Timeline",quoteBrief.timeline],["Budget",quoteBrief.budget],["Urgency",quoteBrief.urgency]].map(([l,v])=><div key={l} className="rounded-lg border border-slate-200 bg-white p-3"><Label>{l}</Label><p className="mt-1 text-sm text-slate-800">{v||"—"}</p></div>)}
                        <div className="rounded-lg border border-slate-200 bg-white p-3 sm:col-span-2"><Label>Installation type</Label><p className="mt-1 text-sm text-slate-800">{quoteBrief.installation_type||"—"}</p></div>
                        <div className="rounded-lg border border-slate-200 bg-white p-3 sm:col-span-2"><Label>Attachments / documents</Label><p className="mt-1 text-sm text-slate-800">{quoteBrief.attachments_summary||"—"}</p></div>
                      </div>
                      {quoteBrief.missing_fields.length>0&&<div className="rounded-xl border border-amber-200 bg-gradient-to-br from-amber-50 to-orange-50 p-4"><p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-amber-800">Missing technical details</p><div className="flex flex-wrap gap-1.5">{quoteBrief.missing_fields.map((f,i)=><span key={i} className="rounded-md border border-amber-200 bg-white px-2 py-0.5 text-xs text-amber-800">{f}</span>)}</div></div>}
                      <div className="rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50 p-4"><p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-emerald-800">Recommended next step</p><p className="text-sm text-emerald-900">{quoteBrief.recommended_next_step}</p></div>
                    </div>
                  ):<Empty icon="📋" text="Select and process a relevant inquiry to see the estimator brief."/>}
                </div>
              </Panel>
            )}

            {/* Electrical qualification */}
            {isElectricalLead&&(
              <Panel>
                <PanelHeader title="Electrical Lead Qualification" subtitle="Tailored intake for electrical and solar inquiries" right={electricalQualification?(<><Chip text={serviceTypeLabels[electricalQualification.service_type]} className={serviceStyles[electricalQualification.service_type]}/><Chip text={leadPriorityLabels[electricalQualification.lead_priority]} className={priorityStyles[electricalQualification.lead_priority]}/></>):null}/>
                <div className="p-6">
                  {qualificationLoading?<Empty text="Loading qualification…"/>:electricalQualification?(
                    <div className="space-y-4">
                      <div className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-slate-100/50 p-4">
                        <div><Label>Lead summary</Label><p className="mt-1.5 text-sm leading-relaxed text-slate-700">{electricalQualification.client_summary}</p></div>
                        <div className="shrink-0 text-right"><Label>Lead score</Label><p className="mt-1 text-4xl font-black tabular-nums text-slate-900">{electricalQualification.lead_score}<span className="text-lg font-semibold text-slate-400">/100</span></p></div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {[["Object type",electricalQualification.object_type],["Location",electricalQualification.location],["Budget",electricalQualification.budget],["Timeline",electricalQualification.timeline],["Urgency",electricalQualification.urgency],["Installation type",electricalQualification.installation_type]].map(([l,v])=><div key={l} className="rounded-lg border border-slate-200 bg-white p-3"><Label>{l}</Label><p className="mt-1 text-sm text-slate-800">{v||"—"}</p></div>)}
                        <div className="rounded-lg border border-slate-200 bg-white p-3 sm:col-span-2"><Label>Attachments / documents</Label><p className="mt-1 text-sm text-slate-800">{electricalQualification.attachments_summary||"No attachment context detected."}</p></div>
                      </div>
                      {electricalQualification.missing_fields.length>0&&<div className="rounded-xl border border-amber-200 bg-gradient-to-br from-amber-50 to-orange-50 p-4"><p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-amber-800">Missing technical details</p><div className="flex flex-wrap gap-1.5">{electricalQualification.missing_fields.map((f,i)=><span key={i} className="rounded-md border border-amber-200 bg-white px-2 py-0.5 text-xs text-amber-800">{f}</span>)}</div></div>}
                      <div className="rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50 p-4"><p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-emerald-800">Recommended next step</p><p className="text-sm text-emerald-900">{electricalQualification.recommended_next_step}</p></div>
                    </div>
                  ):<Empty icon="⚡" text="Process a relevant inquiry to see the electrical qualification view."/>}
                </div>
              </Panel>
            )}

            {/* Quote summary (non-electrical) */}
            {!isElectricalLead&&(
              <Panel>
                <PanelHeader title="Quote Summary" right={<Chip text={missingInfoItems.length>0?"Needs more info":"Ready to review"} className={missingInfoItems.length>0?"border-amber-200 bg-amber-50 text-amber-700":"border-emerald-200 bg-emerald-50 text-emerald-700"}/>}/>
                <div className="p-6"><div className="grid gap-3 sm:grid-cols-2">
                  {[{label:"Requested service",value:quoteSummary.requested_service,wide:false},{label:"Project type",value:quoteSummary.project_type,wide:false},{label:"Company",value:quoteSummary.company_name,wide:false},{label:"Website URL",value:quoteSummary.website_url,wide:false},{label:"Budget",value:quoteSummary.budget,wide:false},{label:"Timeline",value:quoteSummary.timeline,wide:false},{label:"Location",value:quoteSummary.location,wide:true},{label:"Pages needed",value:quoteSummary.pages_needed,wide:true},{label:"Business goals",value:quoteSummary.business_goals,wide:true},{label:"Missing information",value:quoteSummary.missing_information,wide:true}].map((item,i)=>(
                    <div key={`${item.label}-${i}`} className={`rounded-lg border border-slate-200 bg-white p-3 ${item.wide?"sm:col-span-2":""}`}><Label>{item.label}</Label><p className="mt-1 break-words text-sm text-slate-800">{renderFieldValue(item.value)}</p></div>
                  ))}
                </div></div>
              </Panel>
            )}

            {/* Draft + Documents */}
            <div className="grid gap-5 xl:grid-cols-2">
              <Panel>
                <PanelHeader title="Draft Reply" subtitle="Edit and review before approving and sending" right={<Btn variant="ghost" size="xs" onClick={saveEditedDraft} disabled={actionLoading!==null||!editedDraft.trim()}>Save draft</Btn>}/>
                <div className="p-6"><Textarea value={editedDraft} onChange={e=>setEditedDraft(e.target.value)} placeholder="AI-generated draft will appear here after processing…" rows={12}/><p className="mt-2 text-xs text-slate-400">Review, save, approve, and send.</p></div>
              </Panel>
              <Panel>
                <PanelHeader title="Documents" subtitle="Files attached to this inquiry"/>
                <div className="p-6">{documents.length>0?(<div className="space-y-2">{documents.map(doc=><div key={doc.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-900">{doc.filename}</p><p className="mt-0.5 text-xs text-slate-400">{doc.file_type||"Unknown type"} · {formatDate(doc.created_at)}</p></div><span className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-500">Attachment</span></div>)}</div>):<Empty icon="📁" text="No documents attached yet."/>}</div>
              </Panel>
            </div>

            {/* Notes + Audit */}
            <div className="grid gap-5 xl:grid-cols-2">
              <Panel>
                <PanelHeader title="Internal Notes" subtitle="Private notes for your team"/>
                <div className="space-y-4 p-6">
                  <Textarea value={newNote} onChange={e=>setNewNote(e.target.value)} placeholder="Add a private note for your team…" rows={4}/>
                  <div className="flex justify-end"><Btn variant="primary" size="sm" onClick={addInternalNote} disabled={!selectedMessage||!newNote.trim()||savingNote}>{savingNote?"Saving…":"Add note"}</Btn></div>
                  {notes.length>0?(<div className="space-y-2">{notes.map(note=><div key={note.id} className="rounded-xl border border-blue-100 bg-blue-50/40 p-4"><div className="mb-2 flex items-center justify-between gap-2"><p className="text-xs font-bold text-slate-900">{note.author}</p><p className="text-[11px] text-slate-400">{formatDate(note.created_at)}</p></div><p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{note.note_text}</p></div>)}</div>):<Empty icon="📝" text="No internal notes yet."/>}
                </div>
              </Panel>
              <Panel>
                <PanelHeader title="Audit Log" subtitle="Timeline of actions on this inquiry"/>
                <div className="p-6">{auditLogs.length>0?(
                  <div className="relative pl-4">
                    <div className="absolute bottom-2 left-0 top-2 w-px bg-gradient-to-b from-violet-400 via-blue-300 to-slate-200"/>
                    {auditLogs.map(log=>(
                      <div key={log.id} className="relative pb-4 last:pb-0">
                        <div className="absolute -left-[17px] top-1 size-3 rounded-full border-2 border-white bg-violet-500 ring-1 ring-violet-200"/>
                        <div className="ml-3 rounded-xl border border-slate-200 bg-white p-3.5">
                          <div className="flex items-start justify-between gap-2"><p className="text-xs font-bold text-slate-900">{log.action}</p><p className="shrink-0 text-[11px] text-slate-400">{formatDate(log.created_at)}</p></div>
                          <p className="mt-0.5 text-[11px] text-slate-500">{log.actor}</p>
                          {log.metadata_json&&<pre className="mt-2 overflow-x-auto rounded-lg border border-slate-100 bg-slate-50 p-2.5 text-[11px] leading-5 text-slate-600">{log.metadata_json}</pre>}
                        </div>
                      </div>
                    ))}
                  </div>
                ):<Empty icon="🕐" text="No audit log entries yet."/>}</div>
              </Panel>
            </div>

          </div>
        </div>
      </div>

      {toast&&<ToastNotification toast={toast}/>}
    </div>
  );
}

function NavBtn({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) {
  return <button onClick={onClick} disabled={disabled} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-slate-300 transition hover:bg-white/10 disabled:opacity-40">{children}</button>;
}

function ToastNotification({ toast }: { toast: Toast }) {
  return (
    <div className="fixed bottom-5 right-5 z-50">
      <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-sm font-semibold shadow-xl ${toast.type==="success"?"border-emerald-200 bg-emerald-50 text-emerald-800 shadow-emerald-100":"border-rose-200 bg-rose-50 text-rose-800 shadow-rose-100"}`}>
        <span className={`flex size-6 items-center justify-center rounded-full text-xs font-black text-white ${toast.type==="success"?"bg-emerald-500":"bg-rose-500"}`}>{toast.type==="success"?"✓":"✕"}</span>
        {toast.message}
      </div>
    </div>
  );
}