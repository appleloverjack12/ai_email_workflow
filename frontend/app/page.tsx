"use client";

import React, { useEffect, useMemo, useState } from "react";

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
  | "error";
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
  const [statusFilter, setStatusFilter] = useState<"all" | MessageStatus>("all");
  const [toast, setToast] = useState<Toast | null>(null);
  const [documents, setDocuments] = useState<UploadedDocument[]>([]);
  const [uploading, setUploading] = useState(false);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);

  const filteredMessages = useMemo(() => {
    return messages.filter((message) => {
      const q = search.trim().toLowerCase();
      const matchesSearch =
        q === "" ||
        message.subject.toLowerCase().includes(q) ||
        message.sender_email.toLowerCase().includes(q) ||
        (message.sender_name || "").toLowerCase().includes(q);

      const matchesStatus = statusFilter === "all" || message.status === statusFilter;
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
      setMessages(data);

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
      const response = await fetch(`${API_BASE}/messages/${selectedMessage.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor_name: "Jakov" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Failed to send message");

      await fetchMessages();
      await fetchMessageDetail(selectedMessage.id);
      setToast({ type: "success", message: "Message sent." });
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

  return (
    <div className="min-h-screen bg-slate-50 p-6 text-slate-900">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">AI Email Workflow Dashboard</h1>
            <p className="mt-1 text-sm text-slate-600">
              Review inbound emails, inspect extracted data, and approve drafts before sending.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={fetchMessages}
              disabled={loading}
              className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium shadow-sm hover:bg-slate-50 disabled:opacity-50"
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
            <button
              onClick={processSelectedMessage}
              disabled={!selectedMessage || actionLoading !== null}
              className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50"
            >
              Process with AI
            </button>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm text-slate-500">Total messages</p>
            <p className="mt-2 text-3xl font-semibold">{stats.total}</p>
          </div>
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm text-slate-500">Needs review</p>
            <p className="mt-2 text-3xl font-semibold">{stats.review}</p>
          </div>
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm text-slate-500">Approved</p>
            <p className="mt-2 text-3xl font-semibold">{stats.approved}</p>
          </div>
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm text-slate-500">Sent</p>
            <p className="mt-2 text-3xl font-semibold">{stats.sent}</p>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
          <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
            <div className="border-b border-slate-200 p-5">
              <h2 className="text-lg font-semibold">Inbox</h2>

              <div className="mt-4 flex gap-2">
                <input
                  value={search}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
                  placeholder="Search subject or sender"
                  className="w-full rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500"
                />

                <select
                  value={statusFilter}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    setStatusFilter(e.target.value as "all" | MessageStatus)
                  }
                  className="rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500"
                >
                  <option value="all">All</option>
                  <option value="new">New</option>
                  <option value="needs_review">Needs review</option>
                  <option value="approved">Approved</option>
                  <option value="sent">Sent</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
            </div>

            <div className="h-[640px] space-y-2 overflow-y-auto p-3">
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
                      : "border-slate-200 bg-white hover:border-slate-300"
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
            <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <h3 className="text-lg font-semibold">Audit log</h3>

              <div className="mt-4">
                {auditLogs.length > 0 ? (
                  <div className="space-y-3">
                    {auditLogs.map((log) => (
                      <div
                        key={log.id}
                        className="rounded-2xl border border-slate-200 bg-white p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-slate-800">{log.action}</p>
                            <p className="mt-1 text-xs text-slate-500">
                              {log.actor} · {formatDate(log.created_at)}
                            </p>
                          </div>
                        </div>

                        {log.metadata_json && (
                          <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
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
            <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <h3 className="text-lg font-semibold">Documents</h3>

              <div className="mt-4 space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <input
                    type="file"
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        uploadDocument(file);
                      }
                      e.target.value = "";
                    }}
                    disabled={!selectedMessage || uploading}
                    className="block w-full text-sm text-slate-600"
                  />

                  <span className="text-xs text-slate-500">
                    {uploading ? "Uploading..." : "Upload a .txt, .md, .csv, or similar text file"}
                  </span>
                </div>

                {documents.length > 0 ? (
                  <div className="space-y-2">
                    {documents.map((doc) => (
                      <div
                        key={doc.id}
                        className="rounded-2xl border border-slate-200 bg-white p-3"
                      >
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
            <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <div className="mb-4">
                <h2 className="text-xl font-semibold">Create message</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Paste an inbound email directly into the app.
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
                    className="w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
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
                    className="w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
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
                    className="w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
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
                    className="min-h-[140px] w-full rounded-2xl border border-slate-300 p-3 text-sm outline-none focus:border-slate-500"
                    placeholder="Hi, I need a quote for redesigning my company website..."
                  />
                </div>
              </div>

              <div className="mt-4 flex justify-end">
                <button
                  onClick={createMessage}
                  disabled={creating}
                  className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50"
                >
                  {creating ? "Creating..." : "Create message"}
                </button>
              </div>
            </div>
            <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
              <div className="border-b border-slate-200 p-5">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold">
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
                    <div>
                      <p className="mb-2 text-sm font-medium text-slate-700">Original email</p>
                      <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-700 shadow-sm">
                        {selectedMessage.body_text}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={approveSelectedMessage}
                        disabled={
                          actionLoading !== null ||
                          selectedMessage.status === "approved" ||
                          selectedMessage.status === "sent"
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

            <div className="grid gap-6 xl:grid-cols-2">
              <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
                <h3 className="text-lg font-semibold">Extracted fields</h3>

                <div className="mt-4">
                  {processedData?.extracted_fields ? (
                    <div className="space-y-3">
                      {Object.entries(processedData.extracted_fields).map(([key, value]) => (
                        <div key={key} className="rounded-2xl border border-slate-200 bg-white p-3">
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

              <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
                <h3 className="text-lg font-semibold">Draft reply</h3>

                <div className="mt-4 space-y-4">
                  <textarea
                    value={editedDraft}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditedDraft(e.target.value)}
                    placeholder="AI-generated draft will appear here"
                    className="min-h-[300px] w-full rounded-2xl border border-slate-300 p-3 text-sm outline-none focus:border-slate-500"
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

            <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
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
  );
}