"use client";

import React, { useEffect, useMemo, useState, useRef } from "react";
type MessageCategory =
  | "lead"
  | "quote_request"
  | "invoice"
  | "support"
  | "appointment"
  | "spam"
  | "other";

type MessageStatus =
  | "new"
  | "processing"
  | "needs_review"
  | "approved"
  | "sent"
  | "rejected"
  | "error"
  | "archived";

type UploadedDocument = {
  id: number;
  filename: string;
  file_type?: string | null;
  storage_path?: string | null;
  created_at: string;
};

type DocumentsResponse = {
  message_id: number;
  documents: UploadedDocument[];
};
type Message = {
  id: number;
  subject: string;
  sender_email: string;
  sender_name?: string | null;
  body_text: string;
  category: MessageCategory;
  status: MessageStatus;
  ai_confidence?: number | null;
  source: "manual" | "gmail";
  gmail_message_id?: string | null;
  gmail_thread_id?: string | null;
  gmail_synced_at?: string | null;
  has_attachments: boolean;
  created_at: string;
  updated_at: string;
};

type ProcessedMessage = {
  message_id: number;
  category: MessageCategory;
  confidence: number;
  classification_summary?: string;
  extracted_fields?: Record<string, unknown>;
  draft_text?: string;
  status: MessageStatus;
};

type LatestExtractionResponse = {
  message_id: number;
  extracted_fields_id?: number;
  extracted_fields: Record<string, unknown> | null;
  classification_summary?: string | null;
  created_at?: string;
};

type AuditLogItem = {
  id: number;
  action: string;
  actor: string;
  metadata_json?: string | null;
  created_at: string;
};

type AuditLogsResponse = {
  message_id: number;
  audit_logs: AuditLogItem[];
};

type LatestDraftResponse = {
  message_id: number;
  draft_id?: number;
  draft_text: string | null;
  approval_status?: string;
  approved_by?: string | null;
  created_at?: string;
  updated_at?: string;
  draft?: null;
};

type Toast = {
  type: "success" | "error";
  message: string;
};

const API_BASE = "http://127.0.0.1:8000";

const statusStyles: Record<MessageStatus, string> = {
  new: "bg-slate-100 text-slate-700",
  processing: "bg-amber-100 text-amber-700",
  needs_review: "bg-blue-100 text-blue-700",
  approved: "bg-emerald-100 text-emerald-700",
  sent: "bg-violet-100 text-violet-700",
  rejected: "bg-rose-100 text-rose-700",
  error: "bg-red-100 text-red-700",
  archived: "bg-slate-200 text-slate-700",
};

const categoryStyles: Record<MessageCategory, string> = {
  lead: "bg-cyan-100 text-cyan-700",
  quote_request: "bg-indigo-100 text-indigo-700",
  invoice: "bg-orange-100 text-orange-700",
  support: "bg-pink-100 text-pink-700",
  appointment: "bg-lime-100 text-lime-700",
  spam: "bg-red-100 text-red-700",
  other: "bg-slate-100 text-slate-700",
};

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(value)) + " UTC";
  } catch {
    return value;
  }
}

function prettyKey(key: string) {
  return key.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function Badge({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  return (
    <span className={`inline-flex rounded-xl px-2.5 py-1 text-xs font-medium ${className}`}>
      {text}
    </span>
  );
}

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
  const [statusFilter, setStatusFilter] = useState<"active" | "all" | MessageStatus>("active");
  const [toast, setToast] = useState<Toast | null>(null);
  const [documents, setDocuments] = useState<UploadedDocument[]>([]);
  const [uploading, setUploading] = useState(false);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const filteredMessages = useMemo(() => {
    return messages.filter((message) => {
      const q = search.trim().toLowerCase();
      const matchesSearch =
        q === "" ||
        message.subject.toLowerCase().includes(q) ||
        message.sender_email.toLowerCase().includes(q) ||
        (message.sender_name || "").toLowerCase().includes(q);

      const matchesStatus =
        statusFilter === "all"
          ? true
          : statusFilter === "active"
            ? message.status !== "archived"
            : message.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [messages, search, statusFilter]);

  const stats = useMemo(() => {
    return {
      total: messages.length,
      review: messages.filter((m) => m.status === "needs_review").length,
      approved: messages.filter((m) => m.status === "approved").length,
      sent: messages.filter((m) => m.status === "sent").length,
    };
  }, [messages]);
  const [createForm, setCreateForm] = useState({
    subject: "",
    sender_email: "",
    sender_name: "",
    body_text: "",
  });
  const [creating, setCreating] = useState(false);
  async function fetchMessages() {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/messages`);
      if (!response.ok) throw new Error("Failed to load messages");
      const data: Message[] = await response.json();
      const sorted = [...data].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      setMessages(sorted);

      if (data.length > 0 && selectedId === null) {
        setSelectedId(data[0].id);
      }
    } catch (error) {
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  }


  
  async function clearLocalInbox() {
    const confirmed = window.confirm(
      "Clear all local messages, drafts, documents, extracted fields, and audit logs from the app?"
    );

    if (!confirmed) return;

    setActionLoading("clear-local");

    try {
      const response = await fetch(`${API_BASE}/messages/clear-local`, {
        method: "DELETE",
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Failed to clear local inbox");

      setMessages([]);
      setSelectedId(null);
      setSelectedMessage(null);
      setProcessedData(null);
      setEditedDraft("");
      setDocuments([]);
      setAuditLogs([]);

      setToast({
        type: "success",
        message: "Local inbox cleared.",
      });
    } catch (error) {
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setActionLoading(null);
    }
  }

  async function archiveSelectedMessage() {
  if (!selectedMessage) return;
  setActionLoading("archive");

  try {
    const response = await fetch(`${API_BASE}/messages/${selectedMessage.id}/archive`, {
      method: "POST",
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Failed to archive message");

    setSelectedId(null);
    setSelectedMessage(null);
    setProcessedData(null);
    setEditedDraft("");
    setDocuments([]);
    setAuditLogs([]);

    await fetchMessages();

    setToast({
      type: "success",
      message: data.gmail_archived
        ? "Message archived locally and in Gmail."
        : "Message archived locally.",
    });
  } catch (error) {
    setToast({
      type: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    setActionLoading(null);
  }
}

async function unarchiveSelectedMessage() {
  if (!selectedMessage) return;
  setActionLoading("unarchive");

  try {
    const response = await fetch(`${API_BASE}/messages/${selectedMessage.id}/unarchive`, {
      method: "POST",
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Failed to unarchive message");

    await fetchMessages();
    await fetchMessageDetail(selectedMessage.id);

    setToast({
      type: "success",
      message: "Message unarchived.",
    });
  } catch (error) {
    setToast({
      type: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    setActionLoading(null);
  }
}

  async function syncGmailInbox() {
    setActionLoading("gmail-sync");

    try {
      const response = await fetch(`${API_BASE}/gmail/sync`, {
        method: "POST",
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Failed to sync Gmail");

      await fetchMessages();
      setToast({
        type: "success",
        message: `Imported ${data.imported_count} Gmail message(s).`,
      });
    } catch (error) {
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setActionLoading(null);
    }
  }


  async function uploadDocument(file: File) {
    if (!selectedMessage) {
      setToast({
        type: "error",
        message: "Select a message first.",
      });
      return;
    }

    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`${API_BASE}/messages/${selectedMessage.id}/documents`, {
        method: "POST",
        body: formData,
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Failed to upload document");

      await fetchDocuments(selectedMessage.id);
      setToast({ type: "success", message: `Uploaded ${data.filename}.` });
    } catch (error) {
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setUploading(false);
    }
  }
  async function createMessage() {
    if (
      !createForm.subject.trim() ||
      !createForm.sender_email.trim() ||
      !createForm.body_text.trim()
    ) {
      setToast({
        type: "error",
        message: "Subject, sender email, and email body are required.",
      });
      return;
    }

    setCreating(true);

    try {
      const response = await fetch(`${API_BASE}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createForm),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Failed to create message");

      const createdMessage = data as Message;

      await fetchMessages();
      setSelectedId(createdMessage.id);
      setSelectedMessage(createdMessage);
      setProcessedData(null);
      setEditedDraft("");
      await fetchDocuments(createdMessage.id);

      setCreateForm({
        subject: "",
        sender_email: "",
        sender_name: "",
        body_text: "",
      });

      setToast({ type: "success", message: "Message created." });
    } catch (error) {
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setCreating(false);
    }
  }
  async function requestMissingInfoDraft() {
    if (!selectedMessage) return;
    setActionLoading("missing-info");

    try {
      const response = await fetch(`${API_BASE}/messages/${selectedMessage.id}/draft-missing-info`, {
        method: "POST",
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Failed to generate missing-info draft");

      setEditedDraft(data.draft_text || "");
      await fetchMessages();
      await fetchMessageDetail(selectedMessage.id);
      setToast({ type: "success", message: "Missing-info draft generated." });
    } catch (error) {
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setActionLoading(null);
    }
  }
  async function fetchAuditLogs(messageId: number) {
    try {
      const response = await fetch(`${API_BASE}/messages/${messageId}/audit-logs`);
      if (!response.ok) throw new Error("Failed to load audit logs");

      const data: AuditLogsResponse = await response.json();
      setAuditLogs(data.audit_logs || []);
    } catch (error) {
      setAuditLogs([]);
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
  async function fetchMessageDetail(messageId: number) {
    setDetailLoading(true);

    try {
      const messageRes = await fetch(`${API_BASE}/messages/${messageId}`);
      if (!messageRes.ok) throw new Error("Failed to load message details");

      const messageData: Message = await messageRes.json();
      setSelectedMessage(messageData);

      let extractedFields: Record<string, unknown> | undefined = undefined;
      let draftText: string | undefined = undefined;
      let classificationSummary: string | undefined = undefined;

      try {
        const extractionRes = await fetch(`${API_BASE}/messages/${messageId}/latest-extraction`);
        if (extractionRes.ok) {
          const extractionData: LatestExtractionResponse = await extractionRes.json();
          if (extractionData.extracted_fields) {
            extractedFields = extractionData.extracted_fields;
          }
          if (extractionData.classification_summary) {
            classificationSummary = extractionData.classification_summary;
          }
        }
      } catch {
      }

      try {
        const draftRes = await fetch(`${API_BASE}/messages/${messageId}/latest-draft`);
        if (draftRes.ok) {
          const draftData: LatestDraftResponse = await draftRes.json();
          if (draftData.draft_text) {
            draftText = draftData.draft_text;
          }
        }
      } catch {
        // ignore draft load failure for now
      }

      if (extractedFields || draftText || classificationSummary) {
        setProcessedData({
          message_id: messageData.id,
          category: messageData.category,
          confidence: messageData.ai_confidence ?? 0,
          classification_summary: classificationSummary,
          extracted_fields: extractedFields,
          draft_text: draftText,
          status: messageData.status,
        });
      } else {
        setProcessedData(null);
      }

      setEditedDraft(draftText ?? "");
      await fetchDocuments(messageId);
      await fetchAuditLogs(messageId);
    } catch (error) {
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setDetailLoading(false);
    }
  }
  async function fetchDocuments(messageId: number) {
    try {
      const response = await fetch(`${API_BASE}/messages/${messageId}/documents`);
      if (!response.ok) throw new Error("Failed to load documents");

      const data: DocumentsResponse = await response.json();
      setDocuments(data.documents || []);
    } catch (error) {
      setDocuments([]);
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
  async function approveSelectedMessage() {
    if (!selectedMessage) return;
    setActionLoading("approve");
    try {
      const response = await fetch(`${API_BASE}/messages/${selectedMessage.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor_name: "Jakov" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Failed to approve message");

      await fetchMessages();
      await fetchMessageDetail(selectedMessage.id);
      setToast({ type: "success", message: "Message approved." });
    } catch (error) {
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setActionLoading(null);
    }
  }

  async function rejectSelectedMessage() {
    if (!selectedMessage) return;
    setActionLoading("reject");
    try {
      const response = await fetch(`${API_BASE}/messages/${selectedMessage.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor_name: "Jakov" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Failed to reject message");

      await fetchMessages();
      await fetchMessageDetail(selectedMessage.id);
      setToast({ type: "success", message: "Message rejected." });
    } catch (error) {
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setActionLoading(null);
    }
  }



  async function sendSelectedMessage() {
    if (!selectedMessage) return;
    setActionLoading("send");

    try {
      const response = await fetch(`${API_BASE}/messages/${selectedMessage.id}/send-gmail`, {
        method: "POST",
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Failed to send message via Gmail");

      await fetchMessages();
      await fetchMessageDetail(selectedMessage.id);
      setToast({ type: "success", message: "Message sent via Gmail." });
    } catch (error) {
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setActionLoading(null);
    }
  }
  async function processSelectedMessage() {
    if (!selectedMessage) return;
    setActionLoading("process");

    try {
      const response = await fetch(`${API_BASE}/messages/${selectedMessage.id}/process`, {
        method: "POST",
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Failed to process message");

      setProcessedData(data);
      setEditedDraft(data.draft_text || "");
      await fetchMessages();
      await fetchMessageDetail(selectedMessage.id);
      setToast({ type: "success", message: "Message processed with AI." });
    } catch (error) {
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setActionLoading(null);
    }
  }
  async function saveEditedDraft() {
    if (!selectedMessage || !editedDraft.trim()) return;
    setActionLoading("edit");
    try {
      const response = await fetch(`${API_BASE}/messages/${selectedMessage.id}/edit-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draft_text: editedDraft,
          editor_name: "Jakov",
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Failed to save draft edit");

      await fetchMessageDetail(selectedMessage.id);
      setToast({ type: "success", message: "Draft saved." });
    } catch (error) {
      setToast({
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setActionLoading(null);
    }
  }
  useEffect(() => {
    fetchMessages();
  }, []);

  useEffect(() => {
    if (selectedId !== null) {
      fetchMessageDetail(selectedId);
    }
  }, [selectedId]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);
  const quoteFields = processedData?.extracted_fields ?? {};

  const quoteSummary = {
    requested_service: quoteFields["requested_service"],
    project_type: quoteFields["project_type"],
    company_name: quoteFields["company_name"],
    website_url: quoteFields["website_url"],
    budget: quoteFields["budget"],
    timeline: quoteFields["timeline"],
    location: quoteFields["location"],
    pages_needed: quoteFields["pages_needed"],
    business_goals: quoteFields["business_goals"],
    missing_information: quoteFields["missing_information"],
  };
  function renderFieldValue(value: unknown) {
    if (value === null || value === undefined || value === "") return "—";
    if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "—";
    return String(value);
  }
  const missingInfoItems = Array.isArray(quoteSummary.missing_information)
    ? quoteSummary.missing_information
    : [];

  const workflowRecommendation = useMemo(() => {
    if (!selectedMessage) {
      return {
        tone: "slate",
        title: "No message selected",
        description: "Select a message from the inbox to see the next recommended step.",
        action: null as null | "process" | "missing-info" | "approve" | "send",
        actionLabel: "",
      };
    }

    if (selectedMessage.status === "sent") {
      return {
        tone: "emerald",
        title: "Completed",
        description: "This message has already been sent. No further action is needed.",
        action: null as null | "process" | "missing-info" | "approve" | "send",
        actionLabel: "",
      };
    }

    if (selectedMessage.status === "approved") {
      return {
        tone: "violet",
        title: "Ready to send",
        description: "The draft has already been approved and is ready to be sent.",
        action: "send" as const,
        actionLabel: "Send now",
      };
    }

    if (!processedData) {
      return {
        tone: "blue",
        title: "Process this request",
        description: "Run AI processing first to extract structured details and generate a draft reply.",
        action: "process" as const,
        actionLabel: "Process with AI",
      };
    }

    if (missingInfoItems.length > 0) {
      return {
        tone: "amber",
        title: "Needs more info",
        description: `This request is missing ${missingInfoItems.length} important detail${missingInfoItems.length === 1 ? "" : "s"
          }. Generate a follow-up asking only for what is missing.`,
        action: "missing-info" as const,
        actionLabel: "Request missing info",
      };
    }

    return {
      tone: "emerald",
      title: "Ready to quote",
      description: "This request looks complete enough to review, refine, and approve a quote-oriented reply.",
      action: "approve" as const,
      actionLabel: "Approve draft",
    };
  }, [selectedMessage, processedData, missingInfoItems.length]);
  [selectedMessage, processedData, missingInfoItems.length]

  const recommendationStyles: Record<string, string> = {
    slate: "border-slate-200 bg-slate-50 text-slate-800",
    blue: "border-blue-200 bg-blue-50 text-blue-900",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
    violet: "border-violet-200 bg-violet-50 text-violet-900",
  };
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-100 via-slate-50 to-white p-6 text-slate-900">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white/80 shadow-sm backdrop-blur">
          <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-700 px-6 py-8 text-white">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-300">
                  AI Workflow
                </p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight">
                  Email + Document Review Dashboard
                </h1>
                <p className="mt-2 max-w-2xl text-sm text-slate-200">
                  Review inbound requests, extract project details, generate drafts,
                  and keep a clear human approval workflow.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={fetchMessages}
                  disabled={loading}
                  className="rounded-2xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white backdrop-blur hover:bg-white/15 disabled:opacity-50"
                >
                  {loading ? "Refreshing..." : "Refresh inbox"}
                </button>

                <button
                  onClick={clearLocalInbox}
                  disabled={actionLoading !== null}
                  className="rounded-2xl border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 shadow-sm hover:bg-red-50 disabled:opacity-50"
                >
                  Clear inbox
                </button>

                <button
                  onClick={syncGmailInbox}
                  disabled={actionLoading !== null}
                  className="rounded-2xl bg-white px-4 py-2 text-sm font-medium text-slate-900 shadow-sm hover:bg-slate-100 disabled:opacity-50"
                >
                  Sync Gmail
                </button>

                <button
                  onClick={processSelectedMessage}
                  disabled={!selectedMessage || actionLoading !== null}
                  className="rounded-2xl bg-slate-950 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-black disabled:opacity-50"
                >
                  Process with AI
                </button>
              </div>
            </div>
          </div>

          <div className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Total messages</p>
              <p className="mt-2 text-3xl font-semibold">{stats.total}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Needs review</p>
              <p className="mt-2 text-3xl font-semibold">{stats.review}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Approved</p>
              <p className="mt-2 text-3xl font-semibold">{stats.approved}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Sent</p>
              <p className="mt-2 text-3xl font-semibold">{stats.sent}</p>
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4">
            <h2 className="text-xl font-semibold">Create message</h2>
            <p className="mt-1 text-sm text-slate-600">
              Paste an inbound email to simulate a new request entering the workflow.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Subject</label>
              <input
                value={createForm.subject}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setCreateForm((prev) => ({ ...prev, subject: e.target.value }))
                }
                className="w-full rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-500 focus:ring-4 focus:ring-slate-100"
                placeholder="Need a quote for website redesign"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Sender email</label>
              <input
                value={createForm.sender_email}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setCreateForm((prev) => ({ ...prev, sender_email: e.target.value }))
                }
                className="w-full rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-500 focus:ring-4 focus:ring-slate-100"
                placeholder="client@example.com"
              />
            </div>

            <div className="md:col-span-2">
              <label className="mb-1 block text-sm font-medium text-slate-700">Sender name</label>
              <input
                value={createForm.sender_name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setCreateForm((prev) => ({ ...prev, sender_name: e.target.value }))
                }
                className="w-full rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-500 focus:ring-4 focus:ring-slate-100"
                placeholder="John"
              />
            </div>

            <div className="md:col-span-2">
              <label className="mb-1 block text-sm font-medium text-slate-700">Email body</label>
              <textarea
                value={createForm.body_text}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  setCreateForm((prev) => ({ ...prev, body_text: e.target.value }))
                }
                className="min-h-[140px] w-full rounded-2xl border border-slate-300 bg-white p-3 text-sm outline-none transition focus:border-slate-500 focus:ring-4 focus:ring-slate-100"
                placeholder="Hi, please see the attached brief for our website redesign project..."
              />
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <button
              onClick={createMessage}
              disabled={creating}
              className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create message"}
            </button>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 p-5">
              <h2 className="text-lg font-semibold">Inbox</h2>
              <p className="mt-1 text-xs text-slate-500">
                Select a message to review details, generated drafts, and workflow history.
              </p>

              <div className="mt-4 flex gap-2">
                <input
                  value={search}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
                  placeholder="Search subject or sender"
                  className="w-full rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-500 focus:ring-4 focus:ring-slate-100"
                />

                <select
                  value={statusFilter}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    setStatusFilter(e.target.value as "active" | "all" | MessageStatus)
                  }
                  className="rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-500 focus:ring-4 focus:ring-slate-100"
                >
                  <option value="active">Active</option>
                  <option value="all">All</option>
                  <option value="new">New</option>
                  <option value="needs_review">Needs review</option>
                  <option value="approved">Approved</option>
                  <option value="sent">Sent</option>
                  <option value="rejected">Rejected</option>
                  <option value="archived">Archived</option>
                </select>
              </div>
            </div>

            <div className="h-[760px] space-y-3 overflow-y-auto p-4">
              {filteredMessages.map((message) => {
                const active = selectedId === message.id;

                return (
                  <button
                    key={message.id}
                    onClick={() => {
                      setSelectedId(message.id);
                      setSelectedMessage(message);
                    }}
                    className={`w-full rounded-2xl border p-4 text-left transition ${active
                      ? "border-slate-900 bg-slate-900 text-white shadow"
                      : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm"
                      }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{message.subject}</p>
                        <p className={`mt-1 truncate text-xs ${active ? "text-slate-300" : "text-slate-500"}`}>
                          {message.sender_name || "Unknown sender"} · {message.sender_email}
                        </p>
                      </div>
                      <span className={active ? "text-slate-300" : "text-slate-400"}>✉️</span>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Badge
                        text={message.status}
                        className={active ? "bg-white/15 text-white" : statusStyles[message.status]}
                      />
                      <Badge
                        text={message.category}
                        className={active ? "bg-white/15 text-white" : categoryStyles[message.category]}
                      />
                      <Badge
                        text={message.source === "gmail" ? "gmail" : "manual"}
                        className={active ? "bg-white/15 text-white" : "bg-slate-100 text-slate-700"}
                      />
                      {message.has_attachments && (
                        <Badge
                          text="attachment"
                          className={active ? "bg-white/15 text-white" : "bg-amber-100 text-amber-700"}
                        />
                      )}
                    </div>

                    <p className={`mt-3 text-xs ${active ? "text-slate-300" : "text-slate-500"}`}>
                      Updated {formatDate(message.updated_at)}
                    </p>
                  </button>
                );
              })}

              {filteredMessages.length === 0 && (
                <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">
                  No messages match your filters.
                </div>
              )}
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-3xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 p-5">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                      Selected request
                    </p>
                    <h2 className="mt-1 text-2xl font-semibold">
                      {selectedMessage?.subject || "Select a message"}
                    </h2>
                    {selectedMessage && (
                      <p className="mt-2 text-sm text-slate-600">
                        {selectedMessage.sender_name || "Unknown sender"} · {selectedMessage.sender_email}
                      </p>
                    )}
                  </div>

                  {selectedMessage && (
                    <div className="flex flex-wrap gap-2">
                      <Badge
                        text={selectedMessage.status}
                        className={statusStyles[selectedMessage.status]}
                      />

                      <Badge
                        text={selectedMessage.category}
                        className={categoryStyles[selectedMessage.category]}
                      />

                      <Badge
                        text={selectedMessage.source === "gmail" ? "gmail" : "manual"}
                        className="bg-slate-100 text-slate-700"
                      />

                      {selectedMessage.has_attachments && (
                        <Badge
                          text="attachment"
                          className="bg-amber-100 text-amber-700"
                        />
                      )}

                      {typeof selectedMessage.ai_confidence === "number" && (
                        <Badge
                          text={`AI ${Math.round(selectedMessage.ai_confidence * 100)}%`}
                          className="bg-slate-100 text-slate-700"
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-6 p-5">
                {detailLoading && <p className="text-sm text-slate-500">Loading message details...</p>}

                {!detailLoading && !selectedMessage && (
                  <p className="text-sm text-slate-500">Pick a message from the inbox.</p>
                )}

                {selectedMessage && (
                  <>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <p className="mb-2 text-sm font-medium text-slate-700">Original email</p>
                      <div className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
                        {selectedMessage.body_text}
                      </div>
                    </div>

                    <div
                      className={`rounded-2xl border p-4 ${recommendationStyles[workflowRecommendation.tone]}`}
                    >
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide opacity-70">
                            Recommended next step
                          </p>
                          <h3 className="mt-1 text-lg font-semibold">{workflowRecommendation.title}</h3>
                          <p className="mt-1 text-sm opacity-90">{workflowRecommendation.description}</p>
                        </div>

                        {workflowRecommendation.action === "process" && (
                          <button
                            onClick={processSelectedMessage}
                            disabled={actionLoading !== null || !selectedMessage}
                            className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                          >
                            {workflowRecommendation.actionLabel}
                          </button>
                        )}

                        {workflowRecommendation.action === "missing-info" && (
                          <button
                            onClick={requestMissingInfoDraft}
                            disabled={actionLoading !== null || !selectedMessage}
                            className="rounded-2xl bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                          >
                            {workflowRecommendation.actionLabel}
                          </button>
                        )}

                        {workflowRecommendation.action === "approve" && (
                          <button
                            onClick={approveSelectedMessage}
                            disabled={
                              actionLoading !== null ||
                              !selectedMessage ||
                              selectedMessage.status === "approved" ||
                              selectedMessage.status === "sent"
                            }
                            className="rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                          >
                            {workflowRecommendation.actionLabel}
                          </button>
                        )}

                        {workflowRecommendation.action === "send" && (
                          <button
                            onClick={sendSelectedMessage}
                            disabled={actionLoading !== null || !selectedMessage || selectedMessage.status !== "approved"}
                            className="rounded-2xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                          >
                            {workflowRecommendation.actionLabel}
                          </button>
                        )}
                      </div>

                      {missingInfoItems.length > 0 && (
                        <div className="mt-3 rounded-xl bg-white/60 p-3 text-sm">
                          <p className="font-medium">Missing details:</p>
                          <ul className="mt-2 list-disc pl-5">
                            {missingInfoItems.map((item, index) => (
                              <li key={index}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {selectedMessage.status === "archived" ? (
                        <button
                          onClick={unarchiveSelectedMessage}
                          disabled={actionLoading !== null}
                          className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
                        >
                          Unarchive
                        </button>
                      ) : (
                        <button
                          onClick={archiveSelectedMessage}
                          disabled={actionLoading !== null}
                          className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
                        >
                          Archive
                        </button>
                      )}

                      <button
                        onClick={approveSelectedMessage}
                        disabled={
                          actionLoading !== null ||
                          selectedMessage.status === "approved" ||
                          selectedMessage.status === "sent" ||
                          selectedMessage.status === "archived"
                        }
                        className="rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        Approve
                      </button>

                      <button
                        onClick={rejectSelectedMessage}
                        disabled={actionLoading !== null || selectedMessage.status === "sent"}
                        className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
                      >
                        Reject
                      </button>

                      <button
                        onClick={sendSelectedMessage}
                        disabled={actionLoading !== null || selectedMessage.status !== "approved"}
                        className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
                      >
                        Send
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold">Quote summary</h3>

                <span
                  className={`rounded-xl px-2.5 py-1 text-xs font-medium ${Array.isArray(quoteSummary.missing_information) && quoteSummary.missing_information.length > 0
                    ? "bg-amber-100 text-amber-700"
                    : "bg-emerald-100 text-emerald-700"
                    }`}
                >
                  {Array.isArray(quoteSummary.missing_information) && quoteSummary.missing_information.length > 0
                    ? "Needs more info"
                    : "Ready to review"}
                </span>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="rounded-2xl border border-slate-200 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Requested service</p>
                  <p className="mt-1 text-sm text-slate-800">{renderFieldValue(quoteSummary.requested_service)}</p>
                </div>

                <div className="rounded-2xl border border-slate-200 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Project type</p>
                  <p className="mt-1 text-sm text-slate-800">{renderFieldValue(quoteSummary.project_type)}</p>
                </div>

                <div className="rounded-2xl border border-slate-200 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Company</p>
                  <p className="mt-1 text-sm text-slate-800">{renderFieldValue(quoteSummary.company_name)}</p>
                </div>

                <div className="rounded-2xl border border-slate-200 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Website URL</p>
                  <p className="mt-1 break-all text-sm text-slate-800">{renderFieldValue(quoteSummary.website_url)}</p>
                </div>

                <div className="rounded-2xl border border-slate-200 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Budget</p>
                  <p className="mt-1 text-sm text-slate-800">{renderFieldValue(quoteSummary.budget)}</p>
                </div>

                <div className="rounded-2xl border border-slate-200 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Timeline</p>
                  <p className="mt-1 text-sm text-slate-800">{renderFieldValue(quoteSummary.timeline)}</p>
                </div>

                <div className="rounded-2xl border border-slate-200 p-3 md:col-span-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Location</p>
                  <p className="mt-1 text-sm text-slate-800">{renderFieldValue(quoteSummary.location)}</p>
                </div>

                <div className="rounded-2xl border border-slate-200 p-3 md:col-span-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Pages needed</p>
                  <p className="mt-1 text-sm text-slate-800">{renderFieldValue(quoteSummary.pages_needed)}</p>
                </div>

                <div className="rounded-2xl border border-slate-200 p-3 md:col-span-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Business goals</p>
                  <p className="mt-1 text-sm text-slate-800">{renderFieldValue(quoteSummary.business_goals)}</p>
                </div>

                <div className="rounded-2xl border border-slate-200 p-3 md:col-span-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Missing information</p>
                  <p className="mt-1 text-sm text-slate-800">{renderFieldValue(quoteSummary.missing_information)}</p>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <h3 className="text-lg font-semibold">Documents</h3>

              <div className="mt-4 space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <input
                      ref={fileInputRef}
                      type="file"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          uploadDocument(file);
                        }
                        e.target.value = "";
                      }}
                      disabled={!selectedMessage || uploading}
                      className="hidden"
                    />

                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={!selectedMessage || uploading}
                      className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {uploading ? "Uploading..." : "Add file"}
                    </button>

                    <span className="text-xs text-slate-500">
                      {!selectedMessage
                        ? "Select a message first"
                        : "Upload a .txt, .md, .csv, or PDF file"}
                    </span>
                  </div>
                </div>

                {documents.length > 0 ? (
                  <div className="space-y-2">
                    {documents.map((doc) => (
                      <div key={doc.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                        <p className="text-sm font-medium text-slate-800">{doc.filename}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {doc.file_type || "unknown type"} · uploaded {formatDate(doc.created_at)}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">
                    No documents uploaded for this message yet.
                  </div>
                )}
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-2">
              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <h3 className="text-lg font-semibold">Extracted fields</h3>

                <div className="mt-4">
                  {processedData?.extracted_fields ? (
                    <div className="space-y-3">
                      {Object.entries(processedData.extracted_fields).map(([key, value]) => (
                        <div key={key} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                            {prettyKey(key)}
                          </p>
                          <p className="mt-1 text-sm text-slate-700">
                            {value === null || value === "" ? "—" : String(value)}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">
                      No extracted fields yet. Run <span className="font-medium">Process with AI</span> first.
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <h3 className="text-lg font-semibold">Draft reply</h3>

                <div className="mt-4 space-y-4">
                  <textarea
                    value={editedDraft}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditedDraft(e.target.value)}
                    placeholder="AI-generated draft will appear here"
                    className="min-h-[300px] w-full rounded-2xl border border-slate-300 p-3 text-sm outline-none transition focus:border-slate-500 focus:ring-4 focus:ring-slate-100"
                  />

                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-slate-500">Edit the draft before approving and sending.</p>

                    <button
                      onClick={saveEditedDraft}
                      disabled={actionLoading !== null || !editedDraft.trim()}
                      className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
                    >
                      Save draft
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-2">
              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <h3 className="text-lg font-semibold">AI summary</h3>

                <div className="mt-4">
                  {processedData ? (
                    <div className="space-y-3 text-sm text-slate-700">
                      <div>
                        <span className="font-medium">Category:</span> {processedData.category}
                      </div>
                      <div>
                        <span className="font-medium">Confidence:</span>{" "}
                        {Math.round(processedData.confidence * 100)}%
                      </div>
                      <div>
                        <span className="font-medium">Summary:</span>{" "}
                        {processedData.classification_summary || "No summary returned."}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">
                      Process a message to see its AI summary, extracted fields, and draft reply.
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <h3 className="text-lg font-semibold">Audit log</h3>

                <div className="mt-4">
                  {auditLogs.length > 0 ? (
                    <div className="space-y-3">
                      {auditLogs.map((log) => (
                        <div key={log.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium text-slate-800">{log.action}</p>
                              <p className="mt-1 text-xs text-slate-500">
                                {log.actor} · {formatDate(log.created_at)}
                              </p>
                            </div>
                          </div>

                          {log.metadata_json && (
                            <pre className="mt-3 overflow-x-auto rounded-xl bg-white p-3 text-xs text-slate-600">
                              {log.metadata_json}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">
                      No audit log entries for this message yet.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {toast && (
          <div className="fixed bottom-4 right-4 z-50">
            <div
              className={`rounded-2xl px-4 py-3 text-sm text-white shadow-lg ${toast.type === "success" ? "bg-emerald-600" : "bg-red-600"
                }`}
            >
              {toast.message}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}