"use client";

import React, { useEffect, useMemo, useState, useRef } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────
type QuoteLineItem = {
  name: string;
  description?: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  total?: number | null;
};

type QuoteProposal = {
  message_id: number;
  title: string;
  currency: string;
  client_name?: string | null;
  project_name?: string | null;
  site_address?: string | null;
  intro_text?: string | null;
  scope_items: QuoteLineItem[];
  exclusions_text?: string | null;
  validity_days: number;
  payment_terms?: string | null;
  discount_amount: number;
  subtotal: number;
  total_amount: number;
  // NEW — quote lifecycle
  quote_status?: string | null;
  sent_at?: string | null;
  responded_at?: string | null;
};
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

// NEW types
type ReplyTemplate = {
  id: number;
  name: string;
  category?: MessageCategory | null;
  service_type?: string | null;
  body_text: string;
  use_count: number;
  created_at: string;
  updated_at: string;
};
type DashboardStats = {
  period_days: number;
  total_messages: number;
  recent_messages: number;
  needs_review: number;
  waiting_for_info: number;
  by_status: Record<string, number>;
  by_category: Record<string, number>;
  quotes_sent: number;
  quotes_accepted: number;
  quotes_rejected: number;
  conversion_rate_pct: number;
  total_attachments: number;
  messages_by_day: { date: string; count: number }[];
};
type BulkActionKind = "ignore" | "unignore" | "archive" | "unarchive" | "reject" | "process";

// ─── Constants ───────────────────────────────────────────────────────────────

const API_BASE = "http://127.0.0.1:8000";
const QUEUE_KEYS: QueueFilter[] = ["needs_review", "waiting_for_info", "new", "approved", "sent", "ignored", "archived", "all"];

// Design System (UI UX Pro Max — B2B SaaS / Data-Dense Dashboard / Flat Design)
// Font: Plus Jakarta Sans | Primary: #2563EB | Foreground: #0F172A | Muted: #F1F5FD
const DS = {
  primary: "#2563EB",
  secondary: "#3B82F6",
  accent: "#DC2626",
  bg: "#FFFFFF",
  fg: "#0F172A",
  muted: "#F1F5FD",
  border: "#E4ECFC",
  ring: "#2563EB",
};

// NEW — quote lifecycle colors
const quoteStatusConfig: Record<string, { bg: string; text: string; dot: string; label: string }> = {
  draft:          { bg: "bg-slate-100",  text: "text-slate-600",   dot: "bg-slate-400",   label: "Draft" },
  sent_to_client: { bg: "bg-blue-50",    text: "text-blue-700",    dot: "bg-blue-500",    label: "Sent to client" },
  accepted:       { bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500", label: "Accepted" },
  rejected:       { bg: "bg-red-50",     text: "text-red-700",     dot: "bg-red-500",     label: "Rejected" },
  expired:        { bg: "bg-orange-50",  text: "text-orange-700",  dot: "bg-orange-400",  label: "Expired" },
};

const queueConfig: Record<QueueFilter, { label: string; description: string; emptyMessage: string; dot: string; count_color: string; active: string }> = {
  needs_review: { label: "Needs review", description: "Messages requiring human review before the next step.", emptyMessage: "No messages waiting for review.", dot: "bg-blue-600", count_color: "text-blue-600", active: "bg-blue-600 text-white" },
  waiting_for_info: { label: "Waiting for info", description: "Messages waiting for customer details to continue.", emptyMessage: "No messages waiting for information.", dot: "bg-sky-500", count_color: "text-sky-600", active: "bg-sky-500 text-white" },
  new: { label: "New", description: "Freshly imported messages not yet processed.", emptyMessage: "No new messages.", dot: "bg-slate-400", count_color: "text-slate-600", active: "bg-slate-600 text-white" },
  approved: { label: "Approved", description: "Approved messages ready to be sent.", emptyMessage: "No approved messages.", dot: "bg-emerald-500", count_color: "text-emerald-600", active: "bg-emerald-600 text-white" },
  sent: { label: "Sent", description: "Completed outbound replies already sent.", emptyMessage: "No sent messages yet.", dot: "bg-violet-500", count_color: "text-violet-600", active: "bg-violet-600 text-white" },
  ignored: { label: "Ignored", description: "Auto-triaged low-priority messages.", emptyMessage: "No ignored messages.", dot: "bg-orange-400", count_color: "text-orange-600", active: "bg-orange-500 text-white" },
  archived: { label: "Archived", description: "Finished items removed from the active queue.", emptyMessage: "No archived messages.", dot: "bg-slate-300", count_color: "text-slate-400", active: "bg-slate-500 text-white" },
  all: { label: "All", description: "Every message in the system.", emptyMessage: "No messages yet.", dot: "bg-slate-600", count_color: "text-slate-700", active: "bg-slate-900 text-white" },
};

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

const statusStyles: Record<MessageStatus, { bg: string; text: string; dot: string; label: string }> = {
  new: { bg: "bg-slate-100", text: "text-slate-600", dot: "bg-slate-400", label: "New" },
  processing: { bg: "bg-amber-50", text: "text-amber-700", dot: "bg-amber-400", label: "Processing" },
  waiting_for_info: { bg: "bg-sky-50", text: "text-sky-700", dot: "bg-sky-500", label: "Waiting for info" },
  needs_review: { bg: "bg-blue-50", text: "text-blue-700", dot: "bg-blue-500", label: "Needs review" },
  approved: { bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500", label: "Approved" },
  sent: { bg: "bg-violet-50", text: "text-violet-700", dot: "bg-violet-500", label: "Sent" },
  rejected: { bg: "bg-rose-50", text: "text-rose-700", dot: "bg-rose-500", label: "Rejected" },
  error: { bg: "bg-red-50", text: "text-red-700", dot: "bg-red-500", label: "Error" },
  archived: { bg: "bg-slate-100", text: "text-slate-500", dot: "bg-slate-300", label: "Archived" },
  ignored: { bg: "bg-orange-50", text: "text-orange-700", dot: "bg-orange-400", label: "Ignored" },
  ready_for_quote: { bg: "bg-violet-50", text: "text-violet-700", dot: "bg-violet-400", label: "Ready for quote" },
  ready_for_site_visit: { bg: "bg-sky-50", text: "text-sky-700", dot: "bg-sky-400", label: "Site visit" },
};

const categoryConfig: Record<MessageCategory, { bg: string; text: string; label: string }> = {
  lead: { bg: "bg-blue-50", text: "text-blue-700", label: "Lead" },
  quote_request: { bg: "bg-indigo-50", text: "text-indigo-700", label: "Quote" },
  invoice: { bg: "bg-orange-50", text: "text-orange-700", label: "Invoice" },
  support: { bg: "bg-pink-50", text: "text-pink-700", label: "Support" },
  appointment: { bg: "bg-teal-50", text: "text-teal-700", label: "Appointment" },
  spam: { bg: "bg-red-50", text: "text-red-700", label: "Spam" },
  other: { bg: "bg-slate-100", text: "text-slate-600", label: "Other" },
};

const leadPriorityConfig: Record<LeadPriority, { bg: string; text: string; label: string }> = {
  hot: { bg: "bg-emerald-50", text: "text-emerald-700", label: "High priority" },
  needs_info: { bg: "bg-amber-50", text: "text-amber-700", label: "Needs more info" },
  low_detail: { bg: "bg-slate-100", text: "text-slate-600", label: "Low detail" },
};

const serviceConfig: Record<string, { bg: string; text: string; label: string }> = {
  strong_current: { bg: "bg-blue-50", text: "text-blue-700", label: "Strong current" },
  weak_current: { bg: "bg-cyan-50", text: "text-cyan-700", label: "Weak current" },
  solar: { bg: "bg-amber-50", text: "text-amber-700", label: "Solar installation" },
  maintenance: { bg: "bg-orange-50", text: "text-orange-700", label: "Maintenance" },
  project_design: { bg: "bg-violet-50", text: "text-violet-700", label: "Design / automation" },
  unknown: { bg: "bg-slate-100", text: "text-slate-600", label: "Unknown" },
};

function formatDate(v: string) {
  try { return new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" }).format(new Date(v)) + " UTC"; }
  catch { return v; }
}
function formatShortDate(v: string) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(v));
  } catch {
    return v;
  }
}
function prettyKey(k: string) { return k.replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase()); }

// ─── SVG Icons (Heroicons outline style) ──────────────────────────────────────

const Icons = {
  bolt: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-4"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" /></svg>,
  refresh: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>,
  mail: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" /></svg>,
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803 7.5 7.5 0 0015.803 15.803z" /></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
  trash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>,
  logout: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>,
  send: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" /></svg>,
  archive: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" /></svg>,
  x: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>,
  eye: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
  ban: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>,
  undo: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" /></svg>,
  download: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>,
  note: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>,
  clip: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" /></svg>,
  chip: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-4"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25zm.75-12h9v9h-9v-9z" /></svg>,
  clock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
  folder: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-4"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg>,
  spin: <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>,
  cursor: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-4"><path strokeLinecap="round" strokeLinejoin="round" d="M15.042 21.672L13.684 16.6m0 0l-2.51 2.225.569-9.47 5.227 7.917-3.286-.672zM12 2.25V4.5m5.834.166l-1.591 1.591M20.25 10.5H18M7.757 14.743l-1.59 1.59M6 10.5H3.75m4.007-4.243l-1.59-1.59" /></svg>,
  // NEW icons
  chart: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg>,
  template: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="size-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>,
};

// ─── Design System Components ─────────────────────────────────────────────────

function Tag({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${className}`}>
      {children}
    </span>
  );
}

function StatusTag({ status }: { status: MessageStatus }) {
  const s = statusStyles[status];
  return (
    <Tag className={`${s.bg} ${s.text}`}>
      <span className={`size-1.5 shrink-0 rounded-full ${s.dot}`} />
      {s.label}
    </Tag>
  );
}

// NEW — quote lifecycle tag
function QuoteStatusTag({ status }: { status: string }) {
  const s = quoteStatusConfig[status] || quoteStatusConfig.draft;
  return (
    <Tag className={`${s.bg} ${s.text}`}>
      <span className={`size-1.5 shrink-0 rounded-full ${s.dot}`} />
      {s.label}
    </Tag>
  );
}

// Flat Design card — thin border, no shadow by default
function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-[#E4ECFC] bg-white ${className}`}>{children}</div>;
}

function CardHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[#E4ECFC] px-5 py-4">
      <div>
        <h3 className="text-sm font-700 text-[#0F172A]" style={{ fontWeight: 700 }}>{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{children}</p>;
}

function FieldValue({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-sm text-[#0F172A]">{children}</p>;
}

function Empty({ icon, text }: { icon?: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[#E4ECFC] bg-[#F1F5FD] p-10 text-center">
      {icon && <span className="text-slate-300">{icon}</span>}
      <p className="text-xs text-slate-400">{text}</p>
    </div>
  );
}

// Flat Design button — 150ms transition, no shadows
function Btn({
  children, onClick, disabled, variant = "ghost", size = "sm", icon, className = ""
}: {
  children?: React.ReactNode; onClick?: () => void; disabled?: boolean; icon?: React.ReactNode;
  variant?: "primary" | "ghost" | "danger" | "success" | "warning" | "brand" | "sky" | "outline";
  size?: "xs" | "sm" | "md"; className?: string;
}) {
  const base = "cursor-pointer inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-[#2563EB]";
  const sizes = { xs: "px-2.5 py-1.5 text-[11px]", sm: "px-3.5 py-2 text-xs", md: "px-5 py-2.5 text-sm" };
  const variants: Record<string, string> = {
    primary: "bg-[#2563EB] text-white hover:bg-[#1D4ED8]",
    ghost: "border border-[#E4ECFC] bg-white text-slate-600 hover:bg-[#F1F5FD] hover:border-[#2563EB]/20",
    outline: "border border-[#E4ECFC] bg-[#F1F5FD] text-slate-700 hover:bg-[#E4ECFC]",
    danger: "border border-red-100 bg-red-50 text-red-700 hover:bg-red-100",
    success: "bg-emerald-600 text-white hover:bg-emerald-700",
    warning: "bg-amber-500 text-white hover:bg-amber-600",
    brand: "bg-violet-600 text-white hover:bg-violet-700",
    sky: "bg-sky-600 text-white hover:bg-sky-700",
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}>
      {icon && icon}{children}
    </button>
  );
}

function Input({ value, onChange, placeholder, type = "text", className = "" }: { value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; placeholder?: string; type?: string; className?: string }) {
  return <input type={type} value={value} onChange={onChange} placeholder={placeholder} className={`w-full rounded-lg border border-[#E4ECFC] bg-white px-3 py-2.5 text-sm text-[#0F172A] placeholder-slate-400 outline-none transition-all duration-150 focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/10 ${className}`} />;
}

function Textarea({ value, onChange, placeholder, rows = 5, className = "" }: { value: string; onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void; placeholder?: string; rows?: number; className?: string }) {
  return <textarea value={value} onChange={onChange} placeholder={placeholder} rows={rows} className={`w-full resize-none rounded-lg border border-[#E4ECFC] bg-white px-3 py-2.5 text-sm text-[#0F172A] placeholder-slate-400 outline-none transition-all duration-150 focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/10 ${className}`} />;
}

// KPI stat tile — flat design, no shadow
function KpiTile({ label, value, color, sub }: { label: string; value: number | string; color: string; sub?: string }) {
  return (
    <div className={`rounded-xl border-0 px-5 py-4 ${color}`}>
      <p className="text-[10px] font-bold uppercase tracking-widest opacity-70">{label}</p>
      <p className="mt-1 text-3xl font-extrabold tabular-nums tracking-tight">{value}</p>
      {sub && <p className="mt-1 text-[11px] opacity-70">{sub}</p>}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function Page() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [processedData, setProcessedData] = useState<ProcessedMessage | null>(null);
  const [editedDraft, setEditedDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [quoteProposal, setQuoteProposal] = useState<QuoteProposal | null>(null);
  const [quoteProposalLoading, setQuoteProposalLoading] = useState(false);
  const [quoteProposalSaving, setQuoteProposalSaving] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("needs_review");
  const [toast, setToast] = useState<Toast | null>(null);
  const [documents, setDocuments] = useState<UploadedDocument[]>([]);
  const DEMO_COMPANY_NAME = "Elesys";
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
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
  const [settings, setSettings] = useState<CompanySettings>({ company_name: "Your Company", preferred_reply_tone: "professional", reply_signature: "Best,\nYour Company", ignore_senders: [], quote_required_fields: ["company_name", "website_url", "budget", "timeline", "location", "pages_needed", "business_goals"] });
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [ignoreSendersText, setIgnoreSendersText] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  // NEW state — templates
  const [templates, setTemplates] = useState<ReplyTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesPickerOpen, setTemplatesPickerOpen] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateBody, setNewTemplateBody] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);

  // NEW state — bulk selection
  const [selectedBulkIds, setSelectedBulkIds] = useState<Set<number>>(new Set());
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);

  // NEW state — stats dashboard
  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);

  // Inject Plus Jakarta Sans (UI UX Pro Max recommendation for B2B SaaS / Friendly SaaS pairing)
  useEffect(() => {
    const link = document.createElement("link");
    link.href = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }, []);

  const filteredMessages = useMemo(() => messages.filter(m => {
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

  const workflowRec = useMemo(() => {
    if (!selectedMessage) return { tone: "muted", title: "No message selected", desc: "Select a message from the queue.", action: null as null | "process" | "missing-info" | "approve" | "send" | "none", label: "" };
    if (selectedMessage.status === "ready_for_site_visit") return { tone: "sky", title: "Ready for site visit", desc: "This lead is qualified for a site inspection.", action: "none" as const, label: "" };
    if (selectedMessage.status === "ready_for_quote") return { tone: "violet", title: "Ready for quote", desc: "This lead is ready for quote preparation.", action: "none" as const, label: "" };
    if (selectedMessage.status === "waiting_for_info") return { tone: "sky", title: "Waiting for information", desc: "A follow-up draft is ready. Review and send.", action: "send" as const, label: "Send follow-up" };
    if (selectedMessage.status === "sent") return { tone: "emerald", title: "Completed", desc: "This message has been sent. No further action needed.", action: null, label: "" };
    if (selectedMessage.status === "ignored") return { tone: "orange", title: "Filtered from workflow", desc: "Low-priority message. Restore it if relevant.", action: null, label: "" };
    if (selectedMessage.status === "archived") return { tone: "muted", title: "Archived", desc: "Unarchive to return to active workflow.", action: null, label: "" };
    if (selectedMessage.status === "approved") return { tone: "violet", title: "Ready to send", desc: "Draft is approved and ready to send.", action: "send" as const, label: "Send now" };
    if (!processedData) return { tone: "blue", title: "Process this request", desc: "Run AI processing to extract details and draft a reply.", action: "process" as const, label: "Process with AI" };
    if (missingInfoItems.length > 0) return { tone: "amber", title: "Needs more info", desc: `Missing ${missingInfoItems.length} detail${missingInfoItems.length === 1 ? "" : "s"}. Request missing information.`, action: "missing-info" as const, label: "Request missing info" };
    return { tone: "emerald", title: "Ready to quote", desc: "Request is complete. Review, approve, and send.", action: "approve" as const, label: "Approve draft" };
  }, [selectedMessage, processedData, missingInfoItems.length]);

  // Flat design banner: accent left bar, tinted background
  const recStyles: Record<string, { bar: string; bg: string; border: string; title: string }> = {
    muted: { bar: "bg-slate-300", bg: "bg-[#F1F5FD]", border: "border-[#E4ECFC]", title: "text-slate-600" },
    blue: { bar: "bg-[#2563EB]", bg: "bg-blue-50", border: "border-blue-200", title: "text-blue-900" },
    amber: { bar: "bg-amber-400", bg: "bg-amber-50", border: "border-amber-200", title: "text-amber-900" },
    emerald: { bar: "bg-emerald-500", bg: "bg-emerald-50", border: "border-emerald-200", title: "text-emerald-900" },
    violet: { bar: "bg-violet-500", bg: "bg-violet-50", border: "border-violet-200", title: "text-violet-900" },
    sky: { bar: "bg-sky-500", bg: "bg-sky-50", border: "border-sky-200", title: "text-sky-900" },
    orange: { bar: "bg-orange-400", bg: "bg-orange-50", border: "border-orange-200", title: "text-orange-900" },
  };
  function emptyQuoteLine(): QuoteLineItem {
    return {
      name: "",
      description: "",
      quantity: 1,
      unit: "pcs",
      unit_price: 0,
      total: 0,
    };
  }

  function recalcQuoteProposal(proposal: QuoteProposal): QuoteProposal {
    const scope_items = proposal.scope_items.map((item) => ({
      ...item,
      total: Number(item.quantity || 0) * Number(item.unit_price || 0),
    }));

    const subtotal = scope_items.reduce((sum, item) => sum + Number(item.total || 0), 0);
    const total_amount = Math.max(subtotal - Number(proposal.discount_amount || 0), 0);

    return {
      ...proposal,
      scope_items,
      subtotal,
      total_amount,
    };
  }

  async function fetchQuoteProposal(messageId: number) {
    setQuoteProposalLoading(true);
    try {
      const response = await authFetch(`${API_BASE}/messages/${messageId}/quote-proposal`);
      const data = await response.json();

      if (!response.ok) throw new Error(data.detail || "Failed to load quote proposal");
      if (selectedId === messageId) {
        setQuoteProposal(recalcQuoteProposal(data));
      }
    } catch (error) {
      if (selectedId === messageId) {
        setQuoteProposal(null);
      }
    } finally {
      if (selectedId === messageId) {
        setQuoteProposalLoading(false);
      }
    }
  }

  async function autofillQuoteProposal() {
    if (!selectedMessage) return;

    setQuoteProposalSaving(true);
    try {
      const response = await authFetch(
        `${API_BASE}/messages/${selectedMessage.id}/quote-proposal/autofill`,
        { method: "POST" }
      );
      const data = await response.json();

      if (!response.ok) throw new Error(data.detail || "Failed to autofill proposal");

      setQuoteProposal(recalcQuoteProposal(data));
      setToast({ type: "success", message: "Quote proposal autofilled." });
    } catch (error) {
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to autofill proposal",
      });
    } finally {
      setQuoteProposalSaving(false);
    }
  }

  async function saveQuoteProposal() {
    if (!selectedMessage || !quoteProposal) return;

    setQuoteProposalSaving(true);
    try {
      const proposal = recalcQuoteProposal(quoteProposal);

      const response = await authFetch(
        `${API_BASE}/messages/${selectedMessage.id}/quote-proposal`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: proposal.title,
            currency: proposal.currency,
            client_name: proposal.client_name,
            project_name: proposal.project_name,
            site_address: proposal.site_address,
            intro_text: proposal.intro_text,
            scope_items: proposal.scope_items,
            exclusions_text: proposal.exclusions_text,
            validity_days: proposal.validity_days,
            payment_terms: proposal.payment_terms,
            discount_amount: proposal.discount_amount,
          }),
        }
      );

      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Failed to save quote proposal");

      setQuoteProposal(recalcQuoteProposal(data));
      setToast({ type: "success", message: "Quote proposal saved." });
    } catch (error) {
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to save quote proposal",
      });
    } finally {
      setQuoteProposalSaving(false);
    }
  }

  function updateQuoteProposalField<K extends keyof QuoteProposal>(key: K, value: QuoteProposal[K]) {
    setQuoteProposal((prev) => {
      if (!prev) return prev;
      return recalcQuoteProposal({
        ...prev,
        [key]: value,
      });
    });
  }

  function updateQuoteLineItem(index: number, key: keyof QuoteLineItem, value: string | number) {
    setQuoteProposal((prev) => {
      if (!prev) return prev;

      const nextItems = [...prev.scope_items];
      nextItems[index] = {
        ...nextItems[index],
        [key]: value,
      };

      return recalcQuoteProposal({
        ...prev,
        scope_items: nextItems,
      });
    });
  }

  function addQuoteLineItem() {
    setQuoteProposal((prev) => {
      if (!prev) return prev;
      return recalcQuoteProposal({
        ...prev,
        scope_items: [...prev.scope_items, emptyQuoteLine()],
      });
    });
  }

  function removeQuoteLineItem(index: number) {
    setQuoteProposal((prev) => {
      if (!prev) return prev;
      return recalcQuoteProposal({
        ...prev,
        scope_items: prev.scope_items.filter((_, i) => i !== index),
      });
    });
  }

  // ── Effects & auth setup ──────────────────────────────────────────────────
  useEffect(() => { if (filteredMessages.length === 0) { setSelectedId(null); setSelectedMessage(null); return; } if (!filteredMessages.some(m => m.id === selectedId)) { setSelectedId(filteredMessages[0].id); setSelectedMessage(filteredMessages[0]); } }, [filteredMessages, selectedId]);
  useEffect(() => { if (token && authUser) { fetchMessages(); fetchSettings(); fetchTemplates(); } }, [token, authUser]);
  useEffect(() => { if (selectedId !== null && messages.some(m => m.id === selectedId)) fetchMessageDetail(selectedId); }, [selectedId, messages]);
  useEffect(() => { if (selectedId !== null && !messages.some(m => m.id === selectedId)) { setSelectedId(null); setSelectedMessage(null); setProcessedData(null); setEditedDraft(""); setDocuments([]); setAuditLogs([]); setNotes([]); setNewNote(""); setElectricalQualification(null); setQuoteBrief(null); setQuoteProposal(null);} }, [messages, selectedId]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2500); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { const t = localStorage.getItem("auth_token"); const u = localStorage.getItem("auth_user"); if (t) setToken(t); if (u) setAuthUser(JSON.parse(u)); setAuthReady(true); }, []);

  async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
    const headers = new Headers(init.headers || {});
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const r = await fetch(input, { ...init, headers });
    if (r.status === 401) { localStorage.removeItem("auth_token"); localStorage.removeItem("auth_user"); setToken(null); setAuthUser(null); }
    return r;
  }

  // ── API actions ───────────────────────────────────────────────────────────
  async function fetchMessages() { setLoading(true); try { const r = await authFetch(`${API_BASE}/messages`); if (!r.ok) throw new Error("Failed to load"); const data: Message[] = await r.json(); setMessages([...data].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())); if (data.length > 0 && selectedId === null) setSelectedId(data[0].id); } catch (e) { setToast({ type: "error", message: e instanceof Error ? e.message : "Error" }); } finally { setLoading(false); } }
  async function fetchSettings() {setSettingsLoading(true); try { const r = await authFetch(`${API_BASE}/settings`); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setSettings(d); setIgnoreSendersText((d.ignore_senders || []).join("\n")); } catch (e) { setToast({ type: "error", message: e instanceof Error ? e.message : "Error" }); }finally { setSettingsLoading(false); } }

  async function fetchMessageDetail(id: number) {
    if (!messages.some(m => m.id === id)) return; setDetailLoading(true);
    try {
      const mr = await authFetch(`${API_BASE}/messages/${id}`); if (!mr.ok) throw new Error("Failed"); const md: Message = await mr.json();
      if (selectedId !== id) return; setSelectedMessage(md);
      let ef: Record<string, unknown> | undefined, dt: string | undefined, cs: string | undefined;
      try { const r = await authFetch(`${API_BASE}/messages/${id}/latest-extraction`); if (r.ok) { const d: LatestExtractionResponse = await r.json(); if (d.extracted_fields) ef = d.extracted_fields; if (d.classification_summary) cs = d.classification_summary; } } catch { }
      try { const r = await authFetch(`${API_BASE}/messages/${id}/latest-draft`); if (r.ok) { const d: LatestDraftResponse = await r.json(); if (d.draft_text) dt = d.draft_text; } } catch { }
      if (selectedId !== id) return;
      if (ef || dt || cs) setProcessedData({ message_id: md.id, category: md.category, confidence: md.ai_confidence ?? 0, classification_summary: cs, extracted_fields: ef, draft_text: dt, status: md.status }); else setProcessedData(null);
      setEditedDraft(dt ?? "");
      await Promise.all([fetchDocuments(id), fetchAuditLogs(id), fetchMessageNotes(id), fetchElectricalQualification(id), fetchQuoteBrief(id), fetchQuoteProposal(id)]);
    } catch (e) { setToast({ type: "error", message: e instanceof Error ? e.message : "Error" }); }
    finally { if (selectedId === id) setDetailLoading(false); }
  }

  async function fetchDocuments(id: number) { try { const r = await authFetch(`${API_BASE}/messages/${id}/documents`); if (!r.ok) throw new Error(); const d: DocumentsResponse = await r.json(); setDocuments(d.documents || []); } catch { setDocuments([]); } }
  async function fetchAuditLogs(id: number) { try { const r = await authFetch(`${API_BASE}/messages/${id}/audit-logs`); if (!r.ok) throw new Error(); const d: AuditLogsResponse = await r.json(); setAuditLogs(d.audit_logs || []); } catch { setAuditLogs([]); } }
  async function fetchMessageNotes(id: number) { try { const r = await authFetch(`${API_BASE}/messages/${id}/notes`); const d = await r.json(); if (!r.ok) throw new Error(); setNotes(d); } catch { setNotes([]); } }
  async function fetchElectricalQualification(id: number) { setQualificationLoading(true); try { const r = await authFetch(`${API_BASE}/messages/${id}/electrical-qualification`); const d = await r.json(); if (!r.ok) throw new Error(); if (selectedId === id) setElectricalQualification(d); } catch { if (selectedId === id) setElectricalQualification(null); } finally { if (selectedId === id) setQualificationLoading(false); } }
  async function fetchQuoteBrief(id: number) { setQuoteBriefLoading(true); try { const r = await authFetch(`${API_BASE}/messages/${id}/quote-brief`); const d = await r.json(); if (!r.ok) throw new Error(); if (selectedId === id) setQuoteBrief(d); } catch { if (selectedId === id) setQuoteBrief(null); } finally { if (selectedId === id) setQuoteBriefLoading(false); } }
  async function action(key: string, fn: () => Promise<void>) { setActionLoading(key); try { await fn(); } finally { setActionLoading(null); } }
  const processSelectedMessage = () => action("process", async () => { const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/process`, { method: "POST" }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setProcessedData(d); setEditedDraft(d.draft_text || ""); await fetchMessages(); await fetchMessageDetail(selectedMessage!.id); setToast({ type: "success", message: "Processed with AI." }); });
  const approveSelectedMessage = () => action("approve", async () => { const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor_name: "Jakov" }) }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); await fetchMessageDetail(selectedMessage!.id); setToast({ type: "success", message: "Approved." }); });
  const rejectSelectedMessage = () => action("reject", async () => { const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/reject`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor_name: "Jakov" }) }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); await fetchMessageDetail(selectedMessage!.id); setToast({ type: "success", message: "Rejected." }); });
  const sendSelectedMessage = () => action("send", async () => { const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/send-gmail`, { method: "POST" }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); await fetchMessageDetail(selectedMessage!.id); setToast({ type: "success", message: "Sent via Gmail." }); });
  const saveEditedDraft = () => action("edit", async () => { if (!editedDraft.trim()) return; const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/edit-draft`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft_text: editedDraft, editor_name: "Jakov" }) }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessageDetail(selectedMessage!.id); setToast({ type: "success", message: "Draft saved." }); });
  const requestMissingInfoDraft = () => action("missing-info", async () => { const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/draft-missing-info`, { method: "POST" }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setEditedDraft(d.draft_text || ""); await fetchMessages(); await fetchMessageDetail(selectedMessage!.id); setToast({ type: "success", message: "Follow-up draft generated." }); });
  const ignoreSelectedMessage = () => action("ignore", async () => { const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/ignore`, { method: "POST" }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); await fetchMessageDetail(selectedMessage!.id); setToast({ type: "success", message: "Ignored." }); });
  const unignoreSelectedMessage = () => action("unignore", async () => { const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/unignore`, { method: "POST" }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); await fetchMessageDetail(selectedMessage!.id); setToast({ type: "success", message: "Restored to inbox." }); });
  const archiveSelectedMessage = () => action("archive", async () => { const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/archive`, { method: "POST" }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setSelectedId(null); setSelectedMessage(null); setProcessedData(null); setEditedDraft(""); setDocuments([]); setAuditLogs([]); setQuoteProposal(null); await fetchMessages(); setToast({ type: "success", message: d.gmail_archived ? "Archived locally and in Gmail." : "Archived." }); });
  const deleteSelectedInternalMessage = () =>
  action("delete-internal", async () => {
    if (!selectedMessage) return;
    const confirmed = window.confirm("Delete this message from the internal app only? This will not delete it from Gmail.");
    if (!confirmed) return;
    const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/delete-internal`, { method: "DELETE" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || "Failed to delete internal message");
    setSelectedId(null); setSelectedMessage(null); setProcessedData(null); setEditedDraft(""); setDocuments([]); setAuditLogs([]); setNotes([]); setNewNote(""); setElectricalQualification(null); setQuoteBrief(null); setQuoteProposal(null);
    await fetchMessages();
    setToast({ type: "success", message: "Internal message deleted." });
  });

  const deleteSelectedEmailMessage = () =>
    action("delete-email", async () => {
      if (!selectedMessage) return;
      const confirmed = window.confirm("Delete this email from Gmail? It will be moved to Gmail Trash and removed from the app.");
      if (!confirmed) return;
      const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/delete-email`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "Failed to delete email");
      setSelectedId(null); setSelectedMessage(null); setProcessedData(null); setEditedDraft(""); setDocuments([]); setAuditLogs([]); setNotes([]); setNewNote(""); setElectricalQualification(null); setQuoteBrief(null); setQuoteProposal(null);
      await fetchMessages();
      setToast({ type: "success", message: "Email moved to Gmail Trash and removed from the app." });
    });
  const unarchiveSelectedMessage = () => action("unarchive", async () => { const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/unarchive`, { method: "POST" }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); await fetchMessageDetail(selectedMessage!.id); setToast({ type: "success", message: "Unarchived." }); });
  const syncGmailInbox = (autoProcess = false) => action(autoProcess ? "gmail-ai" : "gmail", async () => { const r = await authFetch(`${API_BASE}/gmail/sync?max_results=10&auto_process=${autoProcess}`, { method: "POST" }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); setToast({ type: "success", message: autoProcess ? `Imported ${d.imported_count}, processed ${d.processed_count}.` : `Imported ${d.imported_count}.` }); });
  const clearLocalInbox = () => { if (!window.confirm("Clear all local messages, drafts, and audit logs?")) return; action("clear", async () => { const r = await authFetch(`${API_BASE}/messages/clear-local`, { method: "DELETE" }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setMessages([]); setSelectedId(null); setSelectedMessage(null); setProcessedData(null); setEditedDraft(""); setDocuments([]); setAuditLogs([]); setElectricalQualification(null); setToast({ type: "success", message: "Inbox cleared." }); }); };
  const addInternalNote = () => action("note", async () => { if (!newNote.trim()) return; const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ author: "Jakov", note_text: newNote.trim() }) }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setNewNote(""); await fetchMessageNotes(selectedMessage!.id); await fetchAuditLogs(selectedMessage!.id); setToast({ type: "success", message: "Note added." }); });
  const markReadyForSiteVisit = () => action("site-visit", async () => { const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/ready-for-site-visit`, { method: "POST" }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); await fetchMessageDetail(selectedMessage!.id); setToast({ type: "success", message: "Marked for site visit." }); });
  const markReadyForQuote = () => action("ready-quote", async () => { const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/ready-for-quote`, { method: "POST" }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); await fetchMessages(); await fetchMessageDetail(selectedMessage!.id); setToast({ type: "success", message: "Marked ready for quote." }); });
  const downloadQuoteBriefPdf = async () => { try { const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/quote-brief.pdf`); if (!r.ok) throw new Error(); const blob = await r.blob(); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `quote-brief-${selectedMessage!.id}.pdf`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); setToast({ type: "success", message: "PDF exported." }); } catch { setToast({ type: "error", message: "PDF export failed." }); } };
  async function saveSettings() { setSettingsSaving(true); try { const r = await authFetch(`${API_BASE}/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...settings, ignore_senders: ignoreSendersText.split("\n").map(l => l.trim()).filter(Boolean) }) }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setSettings(d); setIgnoreSendersText((d.ignore_senders || []).join("\n")); setToast({ type: "success", message: "Settings saved." }); } catch (e) { setToast({ type: "error", message: e instanceof Error ? e.message : "Error" }); } finally { setSettingsSaving(false); } }
  async function login() { setLoggingIn(true); try { const r = await fetch(`${API_BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(loginForm) }); const d = await r.json(); if (!r.ok) throw new Error(d.detail || "Login failed"); localStorage.setItem("auth_token", d.access_token); localStorage.setItem("auth_user", JSON.stringify(d.user)); setToken(d.access_token); setAuthUser(d.user); } catch (e) { setToast({ type: "error", message: e instanceof Error ? e.message : "Error" }); } finally { setLoggingIn(false); } }
  async function bootstrapAdmin() { setLoggingIn(true); try { const r = await fetch(`${API_BASE}/auth/bootstrap`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: loginForm.email, full_name: "Jakov", password: loginForm.password }) }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setToast({ type: "success", message: "Admin created. Log in." }); } catch (e) { setToast({ type: "error", message: e instanceof Error ? e.message : "Error" }); } finally { setLoggingIn(false); } }
  function logout() { localStorage.removeItem("auth_token"); localStorage.removeItem("auth_user"); setToken(null); setAuthUser(null); }
  function toggleRequiredField(f: string) { setSettings(p => ({ ...p, quote_required_fields: p.quote_required_fields.includes(f) ? p.quote_required_fields.filter(x => x !== f) : [...p.quote_required_fields, f] })); }

  // ── NEW: Templates ──────────────────────────────────────────────────────────
  async function fetchTemplates() {
    setTemplatesLoading(true);
    try {
      const r = await authFetch(`${API_BASE}/templates`);
      if (!r.ok) return;
      const d: ReplyTemplate[] = await r.json();
      setTemplates(d);
    } catch { }
    finally { setTemplatesLoading(false); }
  }

  async function applyTemplate(templateId: number) {
    if (!selectedMessage) return;
    try {
      const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/apply-template/${templateId}`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail);
      setEditedDraft(d.draft_text || "");
      await fetchTemplates();
      setTemplatesPickerOpen(false);
      setToast({ type: "success", message: `Template "${d.template_name}" applied.` });
    } catch (e) {
      setToast({ type: "error", message: e instanceof Error ? e.message : "Error applying template" });
    }
  }

  async function saveNewTemplate() {
    if (!newTemplateName.trim() || !newTemplateBody.trim()) return;
    setSavingTemplate(true);
    try {
      const r = await authFetch(`${API_BASE}/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTemplateName.trim(), body_text: newTemplateBody.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail);
      await fetchTemplates();
      setNewTemplateName("");
      setNewTemplateBody("");
      setToast({ type: "success", message: "Template saved." });
    } catch (e) {
      setToast({ type: "error", message: e instanceof Error ? e.message : "Error saving template" });
    } finally {
      setSavingTemplate(false);
    }
  }

  async function deleteTemplate(id: number) {
    if (!window.confirm("Delete this template?")) return;
    try {
      const r = await authFetch(`${API_BASE}/templates/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error();
      await fetchTemplates();
      setToast({ type: "success", message: "Template deleted." });
    } catch {
      setToast({ type: "error", message: "Failed to delete template." });
    }
  }

  // ── NEW: Bulk selection & actions ───────────────────────────────────────────
  function toggleBulkSelect(id: number) {
    setSelectedBulkIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function clearBulkSelection() { setSelectedBulkIds(new Set()); }
  async function executeBulkAction(kind: BulkActionKind) {
    if (selectedBulkIds.size === 0) return;
    setBulkActionLoading(true);
    try {
      const r = await authFetch(`${API_BASE}/messages/bulk-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_ids: Array.from(selectedBulkIds), action: kind }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail);
      clearBulkSelection();
      await fetchMessages();
      setToast({ type: "success", message: `Bulk ${kind}: ${d.affected} message(s) updated.` });
    } catch (e) {
      setToast({ type: "error", message: e instanceof Error ? e.message : "Bulk action failed." });
    } finally {
      setBulkActionLoading(false);
    }
  }

  // ── NEW: Stats dashboard ────────────────────────────────────────────────────
  async function fetchStats() {
    setStatsLoading(true);
    try {
      const r = await authFetch(`${API_BASE}/stats/dashboard?days=30`);
      if (!r.ok) throw new Error();
      const d: DashboardStats = await r.json();
      setDashboardStats(d);
    } catch (e) {
      setToast({ type: "error", message: "Failed to load stats." });
    } finally {
      setStatsLoading(false);
    }
  }

  // ── NEW: Quote proposal PDF + lifecycle ─────────────────────────────────────
  const downloadQuoteProposalPdf = async () => {
    if (!selectedMessage) return;
    try {
      const r = await authFetch(`${API_BASE}/messages/${selectedMessage.id}/quote-proposal/pdf`);
      if (!r.ok) { const err = await r.json().catch(() => ({})); throw new Error(err.detail || "PDF failed"); }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `quote-${selectedMessage.id}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setToast({ type: "success", message: "Quote PDF exported." });
    } catch (e) {
      setToast({ type: "error", message: e instanceof Error ? e.message : "Quote PDF export failed." });
    }
  };

  const markQuoteSent = () => action("quote-sent", async () => {
    const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/quote-proposal/mark-sent`, { method: "POST" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail);
    setQuoteProposal(recalcQuoteProposal(d));
    setToast({ type: "success", message: "Quote marked as sent to client." });
  });
  const markQuoteAccepted = () => action("quote-accepted", async () => {
    const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/quote-proposal/mark-accepted`, { method: "POST" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail);
    setQuoteProposal(recalcQuoteProposal(d));
    await fetchMessages();
    await fetchMessageDetail(selectedMessage!.id);
    setToast({ type: "success", message: "Quote accepted! Message moved to approved." });
  });
  const markQuoteRejected = () => action("quote-rejected", async () => {
    const r = await authFetch(`${API_BASE}/messages/${selectedMessage!.id}/quote-proposal/mark-rejected`, { method: "POST" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail);
    setQuoteProposal(recalcQuoteProposal(d));
    setToast({ type: "success", message: "Quote marked as rejected." });
  });


  // ─── Auth screens ─────────────────────────────────────────────────────────

  const fontStyle = { fontFamily: "'Plus Jakarta Sans', sans-serif" };

  if (!authReady) return (
    <div style={fontStyle} className="flex min-h-screen items-center justify-center bg-[#F1F5FD]">
      <div className="flex items-center gap-2 text-sm text-slate-400">{Icons.spin} Loading…</div>
    </div>
  );

  if (!token || !authUser) return (
    <div style={fontStyle} className="flex min-h-screen items-center justify-center bg-[#F1F5FD] p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-[#2563EB]">
            <span className="text-white">{React.cloneElement(Icons.chip as React.ReactElement<React.SVGProps<SVGSVGElement>>, { className: "size-7" })}</span>
          </div>
          <h1 className="text-2xl font-extrabold text-[#0F172A]">Elesys Workflow</h1>
          <p className="mt-1 text-sm text-slate-400">B2B electrical inquiry management</p>
        </div>
        <Card className="p-6">
          <div className="space-y-4">
            <div><label className="mb-1.5 block text-xs font-semibold text-slate-500">Email address</label><Input value={loginForm.email} onChange={e => setLoginForm(p => ({ ...p, email: e.target.value }))} placeholder="you@company.com" /></div>
            <div><label className="mb-1.5 block text-xs font-semibold text-slate-500">Password</label><Input type="password" value={loginForm.password} onChange={e => setLoginForm(p => ({ ...p, password: e.target.value }))} placeholder="••••••••" /></div>
            <div className="flex gap-2 pt-1">
              <Btn variant="primary" onClick={login} disabled={loggingIn} className="flex-1">{loggingIn ? "Signing in…" : "Sign in"}</Btn>
              <Btn variant="ghost" onClick={bootstrapAdmin} disabled={loggingIn}>Create admin</Btn>
            </div>
          </div>
        </Card>
      </div>
      {toast && <ToastBanner toast={toast} />}
    </div>
  );

  // ─── Main App ──────────────────────────────────────────────────────────────
  const rec = recStyles[workflowRec.tone] ?? recStyles.muted;
  const quoteStatus = quoteProposal?.quote_status || "draft";

  return (
    <div style={fontStyle} className="flex min-h-screen flex-col bg-[#F1F5FD] text-[#0F172A]">

      {/* ─── Topnav ─── */}
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-[#0F172A]">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-[#2563EB]">
              <span className="text-white">{Icons.chip}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-extrabold text-white">{DEMO_COMPANY_NAME}</span>
              <span className="rounded bg-[#2563EB]/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#93C5FD]">Demo</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <NavAction onClick={fetchMessages} disabled={loading} icon={Icons.refresh}>{loading ? "Refreshing…" : "Refresh"}</NavAction>
            <NavAction onClick={() => syncGmailInbox(false)} disabled={actionLoading !== null} icon={Icons.mail}>Sync Gmail</NavAction>
            <NavAction onClick={() => syncGmailInbox(true)} disabled={actionLoading !== null} highlight icon={Icons.mail}>Sync + AI</NavAction>
            <NavAction onClick={processSelectedMessage} disabled={!selectedMessage || actionLoading !== null} primary icon={Icons.cursor}>Process with AI</NavAction>
            <div className="h-4 w-px bg-white/10" />
            <NavAction onClick={() => { setStatsOpen(o => !o); if (!statsOpen) fetchStats(); }} icon={Icons.chart} active={statsOpen}>Stats</NavAction>
            <NavAction onClick={() => setBulkMode(b => !b)} active={bulkMode} icon={Icons.check}>{bulkMode ? "Exit bulk" : "Bulk select"}</NavAction>
            <NavAction onClick={() => setSettingsOpen(o => !o)} icon={Icons.settings} active={settingsOpen}>Settings</NavAction>
            <NavAction onClick={clearLocalInbox} disabled={actionLoading !== null} icon={Icons.trash} danger>Clear inbox</NavAction>
            <div className="h-4 w-px bg-white/10" />
            <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-slate-300">
              <span className="font-bold text-white">{authUser.full_name}</span> · {authUser.role}
            </div>
            <NavAction onClick={logout} icon={Icons.logout}>Logout</NavAction>
          </div>
        </div>
      </header>

      <div className="flex-1 px-5 py-5 pb-24">

        {/* ─── NEW: Stats panel ─── */}
        {statsOpen && (
          <Card className="mb-5">
            <CardHeader
              title="Dashboard statistics"
              subtitle="Activity, conversion, and performance over the last 30 days."
              right={
                <>
                  <Btn variant="ghost" size="xs" onClick={fetchStats} disabled={statsLoading} icon={Icons.refresh}>{statsLoading ? "Loading…" : "Refresh"}</Btn>
                  <Btn variant="ghost" size="xs" onClick={() => setStatsOpen(false)}>Collapse</Btn>
                </>
              }
            />
            <div className="p-5">
              {statsLoading ? (
                <Empty icon={Icons.spin} text="Loading statistics…" />
              ) : dashboardStats ? (
                <div className="space-y-5">
                  {/* KPIs */}
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                    <KpiTile label="Quotes sent" value={dashboardStats.quotes_sent} color="bg-blue-600 text-white" />
                    <KpiTile label="Accepted" value={dashboardStats.quotes_accepted} color="bg-emerald-600 text-white" />
                    <KpiTile label="Rejected" value={dashboardStats.quotes_rejected} color="bg-red-600 text-white" />
                    <KpiTile label="Conversion" value={`${dashboardStats.conversion_rate_pct}%`} color="bg-[#0F172A] text-white" sub="Accepted / sent" />
                    <KpiTile label="Needs review" value={dashboardStats.needs_review} color="bg-amber-500 text-white" />
                    <KpiTile label="Waiting info" value={dashboardStats.waiting_for_info} color="bg-sky-600 text-white" />
                  </div>

                  {/* By category + messages by day side by side */}
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="rounded-xl border border-[#E4ECFC] bg-white p-4">
                      <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">By category (30 days)</p>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(dashboardStats.by_category).length === 0 && <p className="text-xs text-slate-400">No data</p>}
                        {Object.entries(dashboardStats.by_category).map(([cat, count]) => {
                          const cfg = categoryConfig[cat as MessageCategory] || { bg: "bg-slate-100", text: "text-slate-600", label: cat };
                          return (
                            <span key={cat} className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold ${cfg.bg} ${cfg.text}`}>
                              {cfg.label}
                              <span className="rounded-full bg-white/70 px-1.5 font-bold tabular-nums">{count}</span>
                            </span>
                          );
                        })}
                      </div>
                    </div>

                    <div className="rounded-xl border border-[#E4ECFC] bg-white p-4">
                      <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Volume (last 30 days)</p>
                      {dashboardStats.messages_by_day.length === 0 ? (
                        <p className="text-xs text-slate-400">No data</p>
                      ) : (
                        <div className="flex h-24 items-end gap-0.5">
                          {(() => {
                            const maxCount = Math.max(...dashboardStats.messages_by_day.map(d => d.count), 1);
                            return dashboardStats.messages_by_day.map((d, i) => {
                              const h = (d.count / maxCount) * 100;
                              return (
                                <div key={i} className="flex-1" title={`${d.date}: ${d.count}`}>
                                  <div className="w-full rounded-sm bg-[#2563EB] transition-all" style={{ height: `${Math.max(h, 2)}%`, minHeight: d.count > 0 ? 2 : 0 }} />
                                </div>
                              );
                            });
                          })()}
                        </div>
                      )}
                      <p className="mt-2 text-[10px] text-slate-400">Total recent: {dashboardStats.recent_messages} · Attachments: {dashboardStats.total_attachments}</p>
                    </div>
                  </div>

                  {/* By status breakdown */}
                  <div className="rounded-xl border border-[#E4ECFC] bg-white p-4">
                    <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">By status</p>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(dashboardStats.by_status).length === 0 && <p className="text-xs text-slate-400">No data</p>}
                      {Object.entries(dashboardStats.by_status).map(([st, count]) => {
                        const cfg = statusStyles[st as MessageStatus] || { bg: "bg-slate-100", text: "text-slate-600", dot: "bg-slate-400", label: st };
                        return (
                          <span key={st} className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold ${cfg.bg} ${cfg.text}`}>
                            <span className={`size-1.5 shrink-0 rounded-full ${cfg.dot}`} />
                            {cfg.label}
                            <span className="rounded-full bg-white/70 px-1.5 font-bold tabular-nums">{count}</span>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <Empty icon={Icons.chart} text="Click Refresh to load dashboard stats." />
              )}
            </div>
          </Card>
        )}

        {/* Settings panel */}
        {settingsOpen && (
          <Card className="mb-5">
            <CardHeader title="Company settings" subtitle="Business rules, reply tone, signature, and quote field requirements." right={
              <><Btn variant="ghost" size="xs" onClick={() => setSettingsOpen(false)}>Collapse</Btn><Btn variant="primary" size="xs" onClick={saveSettings} disabled={settingsSaving || settingsLoading}>{settingsSaving ? "Saving…" : "Save settings"}</Btn></>
            } />
            <div className="grid gap-5 p-5 md:grid-cols-2">
              <div><label className="mb-1.5 block text-xs font-semibold text-slate-500">Company name</label><Input value={settings.company_name} onChange={e => setSettings(p => ({ ...p, company_name: e.target.value }))} placeholder="Elesys" /></div>
              <div><label className="mb-1.5 block text-xs font-semibold text-slate-500">Reply tone</label><select value={settings.preferred_reply_tone} onChange={e => setSettings(p => ({ ...p, preferred_reply_tone: e.target.value as ReplyTone }))} className="w-full cursor-pointer rounded-lg border border-[#E4ECFC] bg-white px-3 py-2.5 text-sm outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/10"><option value="professional">Professional</option><option value="friendly">Friendly</option><option value="concise">Concise</option><option value="warm">Warm</option></select></div>
              <div className="md:col-span-2"><label className="mb-1.5 block text-xs font-semibold text-slate-500">Reply signature</label><Textarea value={settings.reply_signature} onChange={e => setSettings(p => ({ ...p, reply_signature: e.target.value }))} placeholder={"Best,\nElesys"} rows={4} /></div>
              <div><label className="mb-1.5 block text-xs font-semibold text-slate-500">Ignore senders <span className="font-normal text-slate-400">(one per line)</span></label><Textarea value={ignoreSendersText} onChange={e => setIgnoreSendersText(e.target.value)} placeholder={"newsletter@\nlinkedin.com"} rows={6} /></div>
              <div><label className="mb-2 block text-xs font-semibold text-slate-500">Required quote fields</label><div className="space-y-1.5">{[["company_name", "Company name"], ["website_url", "Website URL"], ["budget", "Budget"], ["timeline", "Timeline"], ["location", "Location"], ["pages_needed", "Pages needed"], ["business_goals", "Business goals"], ["requested_service", "Requested service"], ["project_type", "Project type"]].map(([val, lbl]) => <label key={val} className="flex cursor-pointer items-center gap-3 rounded-lg border border-[#E4ECFC] bg-[#F1F5FD] px-3 py-2 text-xs text-slate-700 transition-colors duration-150 hover:bg-[#E4ECFC]"><input type="checkbox" checked={settings.quote_required_fields.includes(val)} onChange={() => toggleRequiredField(val)} className="size-3.5 cursor-pointer rounded accent-[#2563EB]" />{lbl}</label>)}</div></div>
            </div>
          </Card>
        )}

        {/* KPI tiles */}
        <div className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiTile label="Total messages" value={stats.total} color="bg-[#0F172A] text-white" />
          <KpiTile label="Needs review" value={stats.review} color="bg-[#2563EB] text-white" />
          <KpiTile label="Approved" value={stats.approved} color="bg-emerald-600 text-white" />
          <KpiTile label="Sent" value={stats.sent} color="bg-violet-600 text-white" />
        </div>

        {/* Main 2-col layout */}
        <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">

          {/* ── Left: Queue sidebar ── */}
          <div className="xl:sticky xl:top-[57px] xl:h-[calc(100vh-73px)]">
            <Card className="flex h-full flex-col overflow-hidden">
              <div className="border-b border-[#E4ECFC] px-4 py-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-extrabold text-[#0F172A]">Review Queue</h2>
                    <p className="mt-0.5 text-[11px] text-slate-400">{queueConfig[queueFilter].description}</p>
                  </div>
                  <span className="rounded-full bg-[#0F172A] px-2.5 py-1 text-[11px] font-bold text-white">{filteredMessages.length}</span>
                </div>

                <div className="mt-3 grid grid-cols-4 gap-1">
                  {QUEUE_KEYS.map(key => {
                    const active = queueFilter === key;
                    const cfg = queueConfig[key];
                    return (
                      <button key={key} onClick={() => setQueueFilter(key)}
                        className={`cursor-pointer flex flex-col items-center rounded-lg px-1.5 py-2.5 text-center transition-all duration-150 ${active ? cfg.active : "bg-[#F1F5FD] text-slate-500 hover:bg-[#E4ECFC]"}`}>
                        <span className="text-[9px] font-bold uppercase leading-tight tracking-wide">{cfg.label}</span>
                        <span className={`mt-1 text-lg font-extrabold tabular-nums leading-none ${!active && cfg.count_color}`}>
                          {queueCounts[key]}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="relative mt-3">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">{Icons.search}</span>
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search subject or sender…"
                    className="w-full rounded-lg border border-[#E4ECFC] bg-[#F1F5FD] py-2.5 pl-8 pr-3 text-xs text-[#0F172A] placeholder-slate-400 outline-none transition-all duration-150 focus:border-[#2563EB] focus:bg-white focus:ring-2 focus:ring-[#2563EB]/10" />
                </div>

                {/* NEW: bulk mode hint */}
                {bulkMode && (
                  <p className="mt-2 text-[10px] font-bold uppercase tracking-wider text-[#2563EB]">
                    Bulk select mode — click checkboxes to select
                  </p>
                )}
              </div>

              {/* Message list */}
              <div className="flex-1 space-y-1 overflow-y-auto p-2.5">
                {filteredMessages.map(msg => {
                  const active = selectedId === msg.id;
                  const st = statusStyles[msg.status];
                  const cat = categoryConfig[msg.category];
                  const isBulkSelected = selectedBulkIds.has(msg.id);
                  return (
                    <div
                      key={msg.id}
                      onClick={() => {
                        if (bulkMode) { toggleBulkSelect(msg.id); return; }
                        setSelectedId(msg.id);
                        setSelectedMessage(msg);
                      }}
                      className={`cursor-pointer group w-full rounded-xl border p-3.5 text-left transition-all duration-150 ${
                        active ? "border-[#2563EB] bg-[#2563EB] text-white shadow-md"
                        : isBulkSelected ? "border-[#2563EB] bg-blue-50"
                        : "border-[#E4ECFC] bg-white hover:border-[#2563EB]/30 hover:bg-[#F1F5FD]"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        {/* Bulk checkbox */}
                        {bulkMode && (
                          <input
                            type="checkbox"
                            checked={isBulkSelected}
                            onChange={(e) => { e.stopPropagation(); toggleBulkSelect(msg.id); }}
                            onClick={e => e.stopPropagation()}
                            className="mt-0.5 size-3.5 cursor-pointer rounded accent-[#2563EB]"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <p className={`truncate text-xs font-bold leading-snug ${active ? "text-white" : "text-[#0F172A]"}`}>{msg.subject}</p>
                            <span className={`shrink-0 text-[10px] ${active ? "text-blue-200" : "text-slate-400"}`}>{formatShortDate(msg.updated_at)}</span>
                          </div>
                          <p className={`mt-0.5 truncate text-[11px] ${active ? "text-blue-200" : "text-slate-500"}`}>{msg.sender_name || msg.sender_email}</p>
                          <div className="mt-2 flex flex-wrap gap-1">
                            <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${active ? "bg-white/15 text-white" : `${st.bg} ${st.text}`}`}>
                              <span className={`size-1.5 shrink-0 rounded-full ${active ? "bg-white/70" : st.dot}`} />{st.label}
                            </span>
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${active ? "bg-white/15 text-white" : `${cat.bg} ${cat.text}`}`}>{cat.label}</span>
                            {msg.source === "gmail" && <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${active ? "bg-white/15 text-white" : "bg-slate-100 text-slate-500"}`}>Gmail</span>}
                            {msg.has_attachments && <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${active ? "bg-white/15 text-white" : "bg-amber-50 text-amber-700"}`}>Attachment</span>}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {filteredMessages.length === 0 && <Empty icon={queueFilter === "ignored" ? Icons.ban : queueFilter === "archived" ? Icons.archive : Icons.mail} text={queueConfig[queueFilter].emptyMessage} />}
              </div>
            </Card>
          </div>

          {/* ── Right: Detail ── */}
          <div className="space-y-5">

            {/* Message detail card */}
            <Card>
              <div className="p-5">
                {!selectedMessage ? (
                  <Empty icon={Icons.mail} text="Select a message from the queue to view the full workflow." />
                ) : (
                  <>
                    {detailLoading && <div className="mb-4 flex items-center gap-2 text-xs text-slate-400">{Icons.spin} Loading details…</div>}

                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Active inquiry</p>
                        <h2 className="mt-1 text-xl font-extrabold leading-snug text-[#0F172A]">{selectedMessage.subject}</h2>
                        <p className="mt-1 text-sm text-slate-500"><span className="font-semibold text-slate-700">{selectedMessage.sender_name || "Unknown"}</span> · {selectedMessage.sender_email}</p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <StatusTag status={selectedMessage.status} />
                        <Tag className={`${categoryConfig[selectedMessage.category].bg} ${categoryConfig[selectedMessage.category].text}`}>{categoryConfig[selectedMessage.category].label}</Tag>
                        <Tag className="bg-slate-100 text-slate-600">{selectedMessage.source === "gmail" ? "Gmail" : "Manual"}</Tag>
                        {selectedMessage.has_attachments && <Tag className="bg-amber-50 text-amber-700">Attachment</Tag>}
                        {typeof selectedMessage.ai_confidence === "number" && <Tag className="bg-[#F1F5FD] text-slate-600">AI {Math.round(selectedMessage.ai_confidence * 100)}%</Tag>}
                      </div>
                    </div>

                    <div className="mt-4 border-t border-[#E4ECFC] pt-4">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Original email</p>
                      <div className="mt-2 max-h-48 overflow-auto rounded-lg border border-[#E4ECFC] bg-[#F1F5FD] p-4 text-sm leading-7 text-slate-700 whitespace-pre-wrap break-words">{selectedMessage.body_text}</div>
                    </div>

                    <div className={`mt-4 overflow-hidden rounded-xl border ${rec.border} ${rec.bg}`}>
                      <div className={`h-1 ${rec.bar}`} />
                      <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                          <p className={`text-[10px] font-bold uppercase tracking-widest ${rec.title} opacity-50`}>Recommended next step</p>
                          <p className={`mt-1 text-sm font-bold ${rec.title}`}>{workflowRec.title}</p>
                          <p className={`mt-0.5 text-xs leading-relaxed ${rec.title} opacity-75`}>{workflowRec.desc}</p>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          {workflowRec.action === "process" && <Btn variant="primary" size="sm" onClick={processSelectedMessage} disabled={actionLoading !== null} icon={Icons.cursor}>{workflowRec.label}</Btn>}
                          {workflowRec.action === "missing-info" && <Btn variant="warning" size="sm" onClick={requestMissingInfoDraft} disabled={actionLoading !== null}>{workflowRec.label}</Btn>}
                          {workflowRec.action === "approve" && <Btn variant="success" size="sm" onClick={approveSelectedMessage} disabled={actionLoading !== null || selectedMessage.status === "approved" || selectedMessage.status === "sent"} icon={Icons.check}>{workflowRec.label}</Btn>}
                          {workflowRec.action === "send" && <Btn variant="brand" size="sm" onClick={sendSelectedMessage} disabled={actionLoading !== null || !["approved", "waiting_for_info"].includes(selectedMessage.status)} icon={Icons.send}>{workflowRec.label}</Btn>}
                        </div>
                      </div>
                      {missingInfoItems.length > 0 && (
                        <div className="border-t border-amber-200/50 bg-white/40 px-4 py-3">
                          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-800">Missing details</p>
                          <div className="flex flex-wrap gap-1.5">{missingInfoItems.map((item, i) => <span key={i} className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">{item}</span>)}</div>
                        </div>
                      )}
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-1.5">
                      {selectedMessage.status === "archived"
                        ? <Btn variant="ghost" size="xs" onClick={unarchiveSelectedMessage} disabled={actionLoading !== null} icon={Icons.undo}>Unarchive</Btn>
                        : <Btn variant="ghost" size="xs" onClick={archiveSelectedMessage} disabled={actionLoading !== null} icon={Icons.archive}>Archive</Btn>}
                      {selectedMessage.status === "ignored"
                        ? <Btn variant="ghost" size="xs" onClick={unignoreSelectedMessage} disabled={actionLoading !== null} icon={Icons.undo}>Unignore</Btn>
                        : <Btn variant="ghost" size="xs" onClick={ignoreSelectedMessage} disabled={actionLoading !== null || selectedMessage.status === "archived"} icon={Icons.ban}>Ignore</Btn>}
                      <Btn variant="success" size="xs" onClick={approveSelectedMessage} disabled={actionLoading !== null || selectedMessage.status === "approved" || selectedMessage.status === "sent" || selectedMessage.status === "archived"} icon={Icons.check}>Approve</Btn>
                      <Btn variant="ghost" size="xs" onClick={rejectSelectedMessage} disabled={actionLoading !== null || selectedMessage.status === "sent"} icon={Icons.x}>Reject</Btn>
                      <Btn variant="brand" size="xs" onClick={sendSelectedMessage} disabled={actionLoading !== null || selectedMessage.status !== "approved"} icon={Icons.send}>Send via Gmail</Btn>
                    </div>
                  </>
                )}
              </div>
            </Card>


            {/* Electrical Quote Brief */}
            {isElectricalLead && (
              <Card>
                <CardHeader title="Electrical Quote Brief" subtitle="Estimator handoff — site visit and quote preparation" right={quoteBrief ? (
                  <><Tag className={`${leadPriorityConfig[quoteBrief.lead_priority].bg} ${leadPriorityConfig[quoteBrief.lead_priority].text}`}>{leadPriorityConfig[quoteBrief.lead_priority].label}</Tag><Btn variant="sky" size="xs" onClick={markReadyForSiteVisit} disabled={!selectedMessage || actionLoading !== null}>Site visit</Btn><Btn variant="brand" size="xs" onClick={markReadyForQuote} disabled={!selectedMessage || actionLoading !== null}>Ready for quote</Btn><Btn variant="ghost" size="xs" onClick={downloadQuoteBriefPdf} disabled={!selectedMessage || quoteBriefLoading || actionLoading !== null} icon={Icons.download}>PDF</Btn></>
                ) : null} />
                <div className="p-5">
                  {quoteBriefLoading ? <Empty icon={Icons.spin} text="Loading quote brief…" /> : quoteBrief ? (
                    <div className="space-y-4">
                      <div className="flex items-start justify-between gap-4 rounded-xl bg-[#F1F5FD] p-4">
                        <div>
                          <FieldLabel>Service type</FieldLabel>
                          <p className="mt-1 text-base font-extrabold text-[#0F172A]">{serviceConfig[quoteBrief.service_type]?.label || quoteBrief.service_type}</p>
                          <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{quoteBrief.estimator_summary}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <FieldLabel>Lead score</FieldLabel>
                          <p className="mt-1 text-4xl font-extrabold tabular-nums text-[#0F172A]">{quoteBrief.lead_score}<span className="text-base font-semibold text-slate-400">/100</span></p>
                        </div>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {[["Client", quoteBrief.client_name], ["Email", quoteBrief.client_email], ["Phone", quoteBrief.client_phone], ["Location", quoteBrief.location], ["Property type", quoteBrief.object_type], ["Timeline", quoteBrief.timeline], ["Budget", quoteBrief.budget], ["Urgency", quoteBrief.urgency]].map(([l, v]) => (
                          <div key={l} className="rounded-lg border border-[#E4ECFC] bg-white p-3"><FieldLabel>{l}</FieldLabel><FieldValue>{v || "—"}</FieldValue></div>
                        ))}
                        <div className="rounded-lg border border-[#E4ECFC] bg-white p-3 sm:col-span-2"><FieldLabel>Installation type</FieldLabel><FieldValue>{quoteBrief.installation_type || "—"}</FieldValue></div>
                        <div className="rounded-lg border border-[#E4ECFC] bg-white p-3 sm:col-span-2"><FieldLabel>Attachments / documents</FieldLabel><FieldValue>{quoteBrief.attachments_summary || "—"}</FieldValue></div>
                      </div>
                      {quoteBrief.missing_fields.length > 0 && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-amber-800">Missing technical details</p><div className="flex flex-wrap gap-1.5">{quoteBrief.missing_fields.map((f, i) => <span key={i} className="rounded border border-amber-200 bg-white px-2 py-0.5 text-xs font-medium text-amber-800">{f}</span>)}</div></div>}
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4"><p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-emerald-800">Recommended next step</p><p className="text-sm text-emerald-900">{quoteBrief.recommended_next_step}</p></div>
                    </div>
                  ) : <Empty icon={Icons.folder} text="Select and process a relevant inquiry to see the estimator brief." />}
                </div>
              </Card>
            )}

            {/* Electrical qualification */}
            {isElectricalLead && (
              <Card>
                <CardHeader title="Lead Qualification" subtitle="Tailored intake for electrical and solar inquiries" right={electricalQualification ? (
                  <><Tag className={`${serviceConfig[electricalQualification.service_type]?.bg || "bg-slate-100"} ${serviceConfig[electricalQualification.service_type]?.text || "text-slate-600"}`}>{serviceConfig[electricalQualification.service_type]?.label}</Tag><Tag className={`${leadPriorityConfig[electricalQualification.lead_priority].bg} ${leadPriorityConfig[electricalQualification.lead_priority].text}`}>{leadPriorityConfig[electricalQualification.lead_priority].label}</Tag></>
                ) : null} />
                <div className="p-5">
                  {qualificationLoading ? <Empty icon={Icons.spin} text="Loading qualification…" /> : electricalQualification ? (
                    <div className="space-y-4">
                      <div className="flex items-start justify-between gap-4 rounded-xl bg-[#F1F5FD] p-4">
                        <div><FieldLabel>Lead summary</FieldLabel><p className="mt-1.5 text-sm leading-relaxed text-slate-700">{electricalQualification.client_summary}</p></div>
                        <div className="shrink-0 text-right"><FieldLabel>Lead score</FieldLabel><p className="mt-1 text-4xl font-extrabold tabular-nums text-[#0F172A]">{electricalQualification.lead_score}<span className="text-base font-semibold text-slate-400">/100</span></p></div>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {[["Object type", electricalQualification.object_type], ["Location", electricalQualification.location], ["Budget", electricalQualification.budget], ["Timeline", electricalQualification.timeline], ["Urgency", electricalQualification.urgency], ["Installation type", electricalQualification.installation_type]].map(([l, v]) => <div key={l} className="rounded-lg border border-[#E4ECFC] bg-white p-3"><FieldLabel>{l}</FieldLabel><FieldValue>{v || "—"}</FieldValue></div>)}
                        <div className="rounded-lg border border-[#E4ECFC] bg-white p-3 sm:col-span-2"><FieldLabel>Attachments / documents</FieldLabel><FieldValue>{electricalQualification.attachments_summary || "No attachment context detected."}</FieldValue></div>
                      </div>
                      {electricalQualification.missing_fields.length > 0 && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-amber-800">Missing technical details</p><div className="flex flex-wrap gap-1.5">{electricalQualification.missing_fields.map((f, i) => <span key={i} className="rounded border border-amber-200 bg-white px-2 py-0.5 text-xs font-medium text-amber-800">{f}</span>)}</div></div>}
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4"><p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-emerald-800">Recommended next step</p><p className="text-sm text-emerald-900">{electricalQualification.recommended_next_step}</p></div>
                    </div>
                  ) : <Empty icon={Icons.chip} text="Process a relevant inquiry to see the electrical qualification view." />}
                </div>
              </Card>
            )}

            {/* Quote summary (non-electrical) */}
            {!isElectricalLead && (
              <Card>
                <CardHeader title="Quote Summary" right={<Tag className={missingInfoItems.length > 0 ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}>{missingInfoItems.length > 0 ? "Needs more info" : "Ready to review"}</Tag>} />
                <div className="p-5"><div className="grid gap-2 sm:grid-cols-2">
                  {[{ l: "Requested service", v: quoteSummary.requested_service, w: false }, { l: "Project type", v: quoteSummary.project_type, w: false }, { l: "Company", v: quoteSummary.company_name, w: false }, { l: "Website URL", v: quoteSummary.website_url, w: false }, { l: "Budget", v: quoteSummary.budget, w: false }, { l: "Timeline", v: quoteSummary.timeline, w: false }, { l: "Location", v: quoteSummary.location, w: true }, { l: "Pages needed", v: quoteSummary.pages_needed, w: true }, { l: "Business goals", v: quoteSummary.business_goals, w: true }, { l: "Missing information", v: quoteSummary.missing_information, w: true }].map((item, i) => (
                    <div key={i} className={`rounded-lg border border-[#E4ECFC] bg-white p-3 ${item.w ? "sm:col-span-2" : ""}`}><FieldLabel>{item.l}</FieldLabel><FieldValue>{renderFieldValue(item.v)}</FieldValue></div>
                  ))}
                </div></div>
              </Card>
            )}

            {/* ─── Quote Builder (electrical leads) ─── */}
            {isElectricalLead && (
              <Card>
                <CardHeader
                  title="Quote Builder"
                  subtitle="Build, send, and track the commercial offer from the qualified inquiry."
                  right={
                    <div className="flex flex-wrap items-center gap-2">
                      {/* NEW: quote status badge */}
                      {quoteProposal && <QuoteStatusTag status={quoteStatus} />}

                      <Btn variant="ghost" size="xs" onClick={autofillQuoteProposal} disabled={!selectedMessage || quoteProposalSaving}>
                        Autofill from brief
                      </Btn>
                      <Btn variant="primary" size="xs" onClick={saveQuoteProposal} disabled={!selectedMessage || !quoteProposal || quoteProposalSaving}>
                        {quoteProposalSaving ? "Saving..." : "Save quote"}
                      </Btn>

                      {/* NEW: Download client-facing PDF */}
                      <Btn variant="ghost" size="xs" onClick={downloadQuoteProposalPdf} disabled={!selectedMessage || !quoteProposal} icon={Icons.download}>
                        PDF
                      </Btn>

                      {/* NEW: lifecycle buttons */}
                      {quoteProposal && quoteStatus === "draft" && (
                        <Btn variant="sky" size="xs" onClick={markQuoteSent} disabled={actionLoading !== null} icon={Icons.send}>
                          Mark sent
                        </Btn>
                      )}
                      {quoteProposal && quoteStatus === "sent_to_client" && (
                        <>
                          <Btn variant="success" size="xs" onClick={markQuoteAccepted} disabled={actionLoading !== null} icon={Icons.check}>
                            Accepted
                          </Btn>
                          <Btn variant="danger" size="xs" onClick={markQuoteRejected} disabled={actionLoading !== null} icon={Icons.x}>
                            Rejected
                          </Btn>
                        </>
                      )}
                    </div>
                  }
                />

                <div className="p-5">
                  {quoteProposalLoading ? (
                    <Empty icon={Icons.spin} text="Loading quote proposal..." />
                  ) : quoteProposal ? (
                    <div className="space-y-4">
                      {/* NEW: timeline info */}
                      {(quoteProposal.sent_at || quoteProposal.responded_at) && (
                        <div className="rounded-lg border border-[#E4ECFC] bg-[#F1F5FD] px-4 py-3 text-xs text-slate-600">
                          <div className="flex flex-wrap gap-4">
                            {quoteProposal.sent_at && (
                              <span>
                                <span className="font-bold text-slate-500">Sent:</span>{" "}
                                {formatDate(quoteProposal.sent_at)}
                              </span>
                            )}
                            {quoteProposal.responded_at && (
                              <span>
                                <span className="font-bold text-slate-500">Responded:</span>{" "}
                                {formatDate(quoteProposal.responded_at)}
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="grid gap-3 md:grid-cols-2">
                        <div>
                          <label className="mb-1.5 block text-xs font-semibold text-slate-500">Quote title</label>
                          <Input value={quoteProposal.title} onChange={(e) => updateQuoteProposalField("title", e.target.value)} />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-xs font-semibold text-slate-500">Currency</label>
                          <Input value={quoteProposal.currency} onChange={(e) => updateQuoteProposalField("currency", e.target.value)} />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-xs font-semibold text-slate-500">Client name</label>
                          <Input value={quoteProposal.client_name || ""} onChange={(e) => updateQuoteProposalField("client_name", e.target.value)} />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-xs font-semibold text-slate-500">Project name</label>
                          <Input value={quoteProposal.project_name || ""} onChange={(e) => updateQuoteProposalField("project_name", e.target.value)} />
                        </div>
                        <div className="md:col-span-2">
                          <label className="mb-1.5 block text-xs font-semibold text-slate-500">Site address</label>
                          <Input value={quoteProposal.site_address || ""} onChange={(e) => updateQuoteProposalField("site_address", e.target.value)} />
                        </div>
                        <div className="md:col-span-2">
                          <label className="mb-1.5 block text-xs font-semibold text-slate-500">Intro text</label>
                          <Textarea value={quoteProposal.intro_text || ""} onChange={(e) => updateQuoteProposalField("intro_text", e.target.value)} rows={4} />
                        </div>
                      </div>

                      <div className="rounded-xl border border-[#E4ECFC] bg-[#F1F5FD] p-4">
                        <div className="mb-3 flex items-center justify-between">
                          <p className="text-sm font-bold text-[#0F172A]">Scope items</p>
                          <Btn variant="ghost" size="xs" onClick={addQuoteLineItem}>Add line</Btn>
                        </div>
                        <div className="space-y-3">
                          {quoteProposal.scope_items.map((item, index) => (
                            <div key={index} className="rounded-lg border border-[#E4ECFC] bg-white p-3">
                              <div className="grid gap-3 md:grid-cols-12">
                                <div className="md:col-span-4"><label className="mb-1 block text-[11px] font-semibold text-slate-500">Item</label><Input value={item.name} onChange={(e) => updateQuoteLineItem(index, "name", e.target.value)} /></div>
                                <div className="md:col-span-2"><label className="mb-1 block text-[11px] font-semibold text-slate-500">Qty</label><Input type="number" value={String(item.quantity)} onChange={(e) => updateQuoteLineItem(index, "quantity", Number(e.target.value))} /></div>
                                <div className="md:col-span-2"><label className="mb-1 block text-[11px] font-semibold text-slate-500">Unit</label><Input value={item.unit} onChange={(e) => updateQuoteLineItem(index, "unit", e.target.value)} /></div>
                                <div className="md:col-span-2"><label className="mb-1 block text-[11px] font-semibold text-slate-500">Unit price</label><Input type="number" value={String(item.unit_price)} onChange={(e) => updateQuoteLineItem(index, "unit_price", Number(e.target.value))} /></div>
                                <div className="md:col-span-2"><label className="mb-1 block text-[11px] font-semibold text-slate-500">Total</label><div className="rounded-lg border border-[#E4ECFC] bg-[#F1F5FD] px-3 py-2.5 text-sm text-slate-700">{(item.total || 0).toFixed(2)} {quoteProposal.currency}</div></div>
                                <div className="md:col-span-11"><label className="mb-1 block text-[11px] font-semibold text-slate-500">Description</label><Input value={item.description || ""} onChange={(e) => updateQuoteLineItem(index, "description", e.target.value)} /></div>
                                <div className="md:col-span-1 flex items-end"><Btn variant="danger" size="xs" onClick={() => removeQuoteLineItem(index)}>Remove</Btn></div>
                              </div>
                            </div>
                          ))}
                          {quoteProposal.scope_items.length === 0 && (
                            <Empty text="No scope items yet. Use autofill or add line items manually." />
                          )}
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        <div>
                          <label className="mb-1.5 block text-xs font-semibold text-slate-500">Exclusions</label>
                          <Textarea value={quoteProposal.exclusions_text || ""} onChange={(e) => updateQuoteProposalField("exclusions_text", e.target.value)} rows={4} />
                        </div>
                        <div className="space-y-3">
                          <div>
                            <label className="mb-1.5 block text-xs font-semibold text-slate-500">Payment terms</label>
                            <Textarea value={quoteProposal.payment_terms || ""} onChange={(e) => updateQuoteProposalField("payment_terms", e.target.value)} rows={3} />
                          </div>
                          <div className="grid gap-3 grid-cols-2">
                            <div><label className="mb-1.5 block text-xs font-semibold text-slate-500">Validity days</label><Input type="number" value={String(quoteProposal.validity_days)} onChange={(e) => updateQuoteProposalField("validity_days", Number(e.target.value))} /></div>
                            <div><label className="mb-1.5 block text-xs font-semibold text-slate-500">Discount</label><Input type="number" value={String(quoteProposal.discount_amount)} onChange={(e) => updateQuoteProposalField("discount_amount", Number(e.target.value))} /></div>
                          </div>
                          <div className="rounded-xl border border-[#E4ECFC] bg-[#F1F5FD] p-4">
                            <div className="flex items-center justify-between text-sm"><span className="text-slate-500">Subtotal</span><span className="font-semibold text-[#0F172A]">{quoteProposal.subtotal.toFixed(2)} {quoteProposal.currency}</span></div>
                            <div className="mt-2 flex items-center justify-between text-sm"><span className="text-slate-500">Discount</span><span className="font-semibold text-[#0F172A]">{Number(quoteProposal.discount_amount).toFixed(2)} {quoteProposal.currency}</span></div>
                            <div className="mt-3 border-t border-[#E4ECFC] pt-3 flex items-center justify-between"><span className="text-sm font-bold text-[#0F172A]">Total</span><span className="text-xl font-extrabold text-[#0F172A]">{quoteProposal.total_amount.toFixed(2)} {quoteProposal.currency}</span></div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <Empty icon={Icons.folder} text="No quote proposal yet." />
                  )}
                </div>
              </Card>
            )}

            {/* Draft + Documents */}
            <div className="grid gap-5 xl:grid-cols-2">
              <Card>
                <CardHeader
                  title="Draft Reply"
                  subtitle="Edit before approving and sending"
                  right={
                    <>
                      {/* NEW: Templates button */}
                      <Btn variant="ghost" size="xs" onClick={() => setTemplatesPickerOpen(o => !o)} icon={Icons.template}>
                        {templatesPickerOpen ? "Close templates" : `Templates (${templates.length})`}
                      </Btn>
                      <Btn variant="ghost" size="xs" onClick={saveEditedDraft} disabled={actionLoading !== null || !editedDraft.trim()}>Save draft</Btn>
                    </>
                  }
                />
                <div className="p-5 space-y-4">
                  {/* NEW: Template picker panel */}
                  {templatesPickerOpen && (
                    <div className="rounded-xl border border-[#E4ECFC] bg-[#F1F5FD] p-4">
                      <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">Saved templates</p>
                      {templatesLoading ? (
                        <div className="text-xs text-slate-400 flex items-center gap-2">{Icons.spin} Loading…</div>
                      ) : templates.length === 0 ? (
                        <p className="text-xs text-slate-400">No templates yet. Create one below.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {templates.map(t => (
                            <div key={t.id} className="flex items-center justify-between gap-2 rounded-lg border border-[#E4ECFC] bg-white px-3 py-2">
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs font-bold text-[#0F172A]">{t.name}</p>
                                <p className="truncate text-[10px] text-slate-400">Used {t.use_count}× · {t.body_text.slice(0, 60)}{t.body_text.length > 60 ? "…" : ""}</p>
                              </div>
                              <div className="flex shrink-0 gap-1">
                                <Btn variant="primary" size="xs" onClick={() => applyTemplate(t.id)} disabled={!selectedMessage}>Apply</Btn>
                                <Btn variant="danger" size="xs" onClick={() => deleteTemplate(t.id)} icon={Icons.trash}></Btn>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Create new template */}
                      <div className="mt-4 space-y-2 border-t border-[#E4ECFC] pt-4">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Create new template</p>
                        <Input value={newTemplateName} onChange={e => setNewTemplateName(e.target.value)} placeholder="Template name (e.g. Site visit follow-up)" />
                        <Textarea value={newTemplateBody} onChange={e => setNewTemplateBody(e.target.value)} placeholder="Template body text…" rows={4} />
                        <div className="flex justify-end">
                          <Btn variant="primary" size="xs" onClick={saveNewTemplate} disabled={!newTemplateName.trim() || !newTemplateBody.trim() || savingTemplate} icon={Icons.plus}>
                            {savingTemplate ? "Saving…" : "Save template"}
                          </Btn>
                        </div>
                      </div>
                    </div>
                  )}

                  <Textarea value={editedDraft} onChange={e => setEditedDraft(e.target.value)} placeholder="AI-generated draft will appear here after processing…" rows={12} />
                  <p className="text-xs text-slate-400">Review, save, approve, and send.</p>
                </div>
              </Card>
              <Card>
                <CardHeader title="Documents" subtitle="Files attached to this inquiry" />
                <div className="p-5">{documents.length > 0 ? (<div className="space-y-2">{documents.map(doc => <div key={doc.id} className="flex items-center justify-between gap-3 rounded-lg border border-[#E4ECFC] bg-[#F1F5FD] px-3.5 py-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-[#0F172A]">{doc.filename}</p><p className="mt-0.5 text-xs text-slate-400">{doc.file_type || "Unknown"} · {formatDate(doc.created_at)}</p></div><span className="shrink-0 rounded border border-[#E4ECFC] bg-white px-2 py-0.5 text-xs font-medium text-slate-500">Attachment</span></div>)}</div>) : <Empty icon={Icons.folder} text="No documents attached yet." />}</div>
              </Card>
            </div>

            {/* Notes + Audit log */}
            <div className="grid gap-5 xl:grid-cols-2">
              <Card>
                <CardHeader title="Internal Notes" subtitle="Private notes for your team" />
                <div className="space-y-4 p-5">
                  <Textarea value={newNote} onChange={e => setNewNote(e.target.value)} placeholder="Add a private note…" rows={4} />
                  <div className="flex justify-end"><Btn variant="primary" size="sm" onClick={addInternalNote} disabled={!selectedMessage || !newNote.trim() || actionLoading === "note"} icon={Icons.note}>{actionLoading === "note" ? "Saving…" : "Add note"}</Btn></div>
                  {notes.length > 0 ? (<div className="space-y-2">{notes.map(n => <div key={n.id} className="rounded-xl border border-[#E4ECFC] bg-[#F1F5FD] p-4"><div className="mb-2 flex items-center justify-between gap-2"><p className="text-xs font-bold text-[#0F172A]">{n.author}</p><p className="text-[11px] text-slate-400 flex items-center gap-1">{Icons.clock}{formatDate(n.created_at)}</p></div><p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{n.note_text}</p></div>)}</div>) : <Empty icon={Icons.note} text="No internal notes yet." />}
                </div>
              </Card>

              <Card>
                <CardHeader title="Audit Log" subtitle="Timeline of actions on this inquiry" />
                <div className="p-5">{auditLogs.length > 0 ? (
                  <div className="relative pl-5">
                    <div className="absolute bottom-2 left-[7px] top-2 w-px bg-[#E4ECFC]" />
                    {auditLogs.map((log, i) => (
                      <div key={log.id} className="relative pb-3.5 last:pb-0">
                        <div className="absolute left-[-14px] top-1.5 size-3 rounded-full border-2 border-white bg-[#2563EB] ring-2 ring-[#E4ECFC]" />
                        <div className="rounded-lg border border-[#E4ECFC] bg-white p-3.5">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-xs font-bold text-[#0F172A]">{log.action}</p>
                            <p className="shrink-0 text-[11px] text-slate-400">{formatDate(log.created_at)}</p>
                          </div>
                          <p className="mt-0.5 text-[11px] text-slate-500">{log.actor}</p>
                          {log.metadata_json && <pre className="mt-2 overflow-x-auto rounded border border-[#E4ECFC] bg-[#F1F5FD] p-2.5 text-[11px] leading-5 text-slate-600">{log.metadata_json}</pre>}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : <Empty icon={Icons.clock} text="No audit log entries yet." />}</div>
              </Card>
            </div>

          </div>
        </div>
      </div>

      {/* NEW: Sticky bulk action bar */}
      {selectedBulkIds.size > 0 && (
        <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2" style={fontStyle}>
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[#E4ECFC] bg-[#0F172A] px-4 py-3 shadow-2xl">
            <span className="text-xs font-bold text-white">
              {selectedBulkIds.size} selected
            </span>
            <div className="h-4 w-px bg-white/20" />
            <Btn variant="ghost" size="xs" onClick={() => executeBulkAction("archive")} disabled={bulkActionLoading} icon={Icons.archive}>Archive</Btn>
            <Btn variant="ghost" size="xs" onClick={() => executeBulkAction("ignore")} disabled={bulkActionLoading} icon={Icons.ban}>Ignore</Btn>
            <Btn variant="primary" size="xs" onClick={() => executeBulkAction("process")} disabled={bulkActionLoading} icon={Icons.cursor}>Process</Btn>
            <Btn variant="danger" size="xs" onClick={() => executeBulkAction("reject")} disabled={bulkActionLoading} icon={Icons.x}>Reject</Btn>
            <div className="h-4 w-px bg-white/20" />
            <Btn variant="ghost" size="xs" onClick={clearBulkSelection} disabled={bulkActionLoading}>Clear</Btn>
          </div>
        </div>
      )}

      {toast && <ToastBanner toast={toast} />}
    </div>
  );
}

// ─── Nav action button (dark variant for header) ───────────────────────────

function NavAction({ children, onClick, disabled, icon, primary, highlight, danger, active }: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean; icon?: React.ReactNode; primary?: boolean; highlight?: boolean; danger?: boolean; active?: boolean }) {
  const base = "cursor-pointer inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed";
  let cls = "border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10";
  if (primary) cls = "bg-[#2563EB] text-white hover:bg-[#1D4ED8]";
  if (highlight) cls = "border border-emerald-500/40 bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30";
  if (danger) cls = "border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20";
  if (active) cls = "border border-[#2563EB]/40 bg-[#2563EB]/20 text-[#93C5FD] hover:bg-[#2563EB]/30";
  return <button onClick={onClick} disabled={disabled} className={`${base} ${cls}`}>{icon}{children}</button>;
}

// ─── Toast notification ───────────────────────────────────────────────────

function ToastBanner({ toast }: { toast: Toast }) {
  return (
    <div className="fixed bottom-5 right-5 z-50" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-sm font-semibold shadow-lg ${toast.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"}`}>
        <span className={`flex size-5 items-center justify-center rounded-full text-[10px] font-extrabold text-white ${toast.type === "success" ? "bg-emerald-500" : "bg-red-500"}`}>{toast.type === "success" ? "✓" : "✕"}</span>
        {toast.message}
      </div>
    </div>
  );
}