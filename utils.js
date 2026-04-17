import crypto from "crypto";
import fs from "fs";
import path from "path";
import axios from "axios";

import {
  ZOOM_WEBHOOK_SECRET_TOKEN,
  CHATWOOT_BASE_URL,
  CHATWOOT_INBOX_IDENTIFIER,
  CHATWOOT_API_TOKEN,
  CHATWOOT_ACCOUNT_ID,
  ZOOM_DATA_DIR,
  BRIDGE_PUBLIC_URL,
} from "./config.js";

const DATA_DIR = ZOOM_DATA_DIR;
const STATE_FILE = path.join(DATA_DIR, "state.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      contacts: data.contacts || {},
      calls: data.calls || {},
    };
  } catch {
    return { contacts: {}, calls: {} };
  }
}

export function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function getPath(obj, paths, fallback = null) {
  for (const p of paths) {
    const value = p
      .split(".")
      .reduce(
        (acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined),
        obj,
      );
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
}

export function formatTime(value) {
  if (!value) return "";
  try {
    return new Date(typeof value === "number" ? value : value).toISOString();
  } catch {
    return String(value);
  }
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === "") return "";
  const s = Number(seconds);
  if (isNaN(s)) return String(seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function formatTimeShort(isoString) {
  if (!isoString) return "";
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return isoString;
  }
}

export function normalizePhone(value) {
  if (!value) return "unknown";
  const cleaned = String(value).trim();
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.length >= 10 && /^\d+$/.test(cleaned)) return `+${cleaned}`;
  return cleaned;
}

// ─── Proxy URL helpers ───────────────────────────────────────────────
// Convert raw Zoom download URLs to proxied URLs that go through
// our bridge (which adds the Bearer token automatically).

export function proxyVoicemailUrl(rawUrl) {
  if (!rawUrl || !BRIDGE_PUBLIC_URL) return rawUrl || "";
  // Extract voicemail ID from: https://zoom.us/v2/phone/voice_mails/download/XXXXX
  const match = rawUrl.match(/voice_mails\/download\/([^?/]+)/);
  if (!match) return rawUrl;
  return `${BRIDGE_PUBLIC_URL}/zoom/media/voicemail/${match[1]}`;
}

export function proxyRecordingUrl(recordingId) {
  if (!recordingId || !BRIDGE_PUBLIC_URL) return "";
  return `${BRIDGE_PUBLIC_URL}/zoom/media/recording/${recordingId}`;
}

// ─── Signature verification ──────────────────────────────────────────

export function verifyZoomSignature(req, rawBody) {
  const timestamp = req.headers["x-zm-request-timestamp"];
  const signature = req.headers["x-zm-signature"];
  if (!timestamp || !signature) return false;

  const message = `v0:${timestamp}:${rawBody}`;
  const hash = crypto
    .createHmac("sha256", ZOOM_WEBHOOK_SECRET_TOKEN)
    .update(message)
    .digest("hex");

  const expected = `v0=${hash}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

export function buildValidationResponse(plainToken) {
  const encryptedToken = crypto
    .createHmac("sha256", ZOOM_WEBHOOK_SECRET_TOKEN)
    .update(plainToken)
    .digest("hex");

  return { plainToken, encryptedToken };
}

export function extractCallInfo(body) {
  const obj = body?.payload?.object || {};
  const event = body?.event || "unknown";
  const eventTs = body?.event_ts || Date.now();

  const callId = getPath(body, ["payload.object.call_id", "payload.object.id"]);
  const caller = normalizePhone(
    getPath(
      body,
      [
        "payload.object.caller.phone_number",
        "payload.object.caller_number",
        "payload.object.from",
        "payload.object.phone_number",
      ],
      "unknown",
    ),
  );

  const callerName = getPath(
    body,
    [
      "payload.object.caller.name",
      "payload.object.caller.display_name",
      "payload.object.caller_name",
    ],
    "",
  );

  const callerEmail = getPath(
    body,
    ["payload.object.caller.email", "payload.object.caller_email"],
    "",
  );

  const callerExtension = getPath(
    body,
    [
      "payload.object.caller.extension_number",
      "payload.object.caller_extension",
    ],
    "",
  );

  const callee = normalizePhone(
    getPath(
      body,
      [
        "payload.object.callee.phone_number",
        "payload.object.callee_number",
        "payload.object.to",
        "payload.object.phone_number",
      ],
      "",
    ),
  );

  const calleeName = getPath(
    body,
    [
      "payload.object.callee.name",
      "payload.object.callee.display_name",
      "payload.object.callee_name",
    ],
    "",
  );

  const calleeEmail = getPath(
    body,
    ["payload.object.callee.email", "payload.object.callee_email"],
    "",
  );

  const calleeExtension = getPath(
    body,
    [
      "payload.object.callee.extension_number",
      "payload.object.callee_extension",
      "payload.object.extension_number",
    ],
    "",
  );

  const agent = getPath(
    body,
    [
      "payload.object.user_name",
      "payload.object.owner_name",
      "payload.object.display_name",
    ],
    "",
  );

  const agentEmail = getPath(
    body,
    [
      "payload.object.user_email",
      "payload.object.owner_email",
      "payload.object.email",
    ],
    "",
  );

  let duration = getPath(
    body,
    [
      "payload.object.duration",
      "payload.object.call_duration",
      "payload.object.voicemail_duration",
    ],
    null,
  );

  const rawCallEnd = getPath(
    body,
    ["payload.object.call_end_time", "payload.object.end_time"],
    "",
  );

  const rawRingStart = getPath(body, ["payload.object.ringing_start_time"], "");

  const rawAnswerStart = getPath(
    body,
    ["payload.object.answer_start_time"],
    "",
  );

  const rawCallStart = getPath(
    body,
    [
      "payload.object.start_time",
      "payload.object.answer_start_time",
      "payload.object.date_time",
      "payload.object.ringing_start_time",
    ],
    "",
  );

  let waitSeconds = null;

  if (rawRingStart && rawAnswerStart) {
    try {
      const waitMs =
        new Date(rawAnswerStart).getTime() - new Date(rawRingStart).getTime();
      if (waitMs >= 0) waitSeconds = Math.round(waitMs / 1000);
    } catch {}
  }

  if (
    (duration === null || duration === undefined || duration === "") &&
    rawCallEnd
  ) {
    try {
      const talkStart = rawAnswerStart || rawCallStart;
      const diffMs =
        new Date(rawCallEnd).getTime() - new Date(talkStart).getTime();
      if (diffMs > 0) duration = Math.round(diffMs / 1000);
    } catch {}
  }

  const direction = getPath(
    body,
    ["payload.object.direction", "payload.object.call_direction"],
    "",
  );

  const handupResult = getPath(
    body,
    ["payload.object.handup_result", "payload.object.hangup_result"],
    "",
  );

  const transcript = getPath(
    body,
    [
      "payload.object.transcript",
      "payload.object.voicemail_transcript",
      "payload.object.text",
      "payload.object.content",
    ],
    "",
  );

  const recordingUrl = getPath(
    body,
    [
      "payload.object.recording_url",
      "payload.object.download_url",
      "payload.object.play_url",
      "payload.object.recording.download_url",
    ],
    "",
  );

  const voicemailId = getPath(body, ["payload.object.voicemail_id"], "");
  const voicemailUrl = getPath(
    body,
    ["payload.object.download_url", "payload.object.voicemail_url"],
    "",
  );

  const occurredAt = getPath(
    body,
    [
      "payload.object.call_end_time",
      "payload.object.end_time",
      "payload.object.date_time",
      "payload.object.create_time",
      "payload.object.timestamp",
    ],
    eventTs,
  );

  const forwardedByName = getPath(
    body,
    ["payload.object.forwarded_by.name"],
    "",
  );
  const forwardedByExt = getPath(
    body,
    ["payload.object.forwarded_by.extension_number"],
    "",
  );
  const redirectByName = getPath(
    body,
    ["payload.object.redirect_forwarded_by.name"],
    "",
  );
  const redirectByExt = getPath(
    body,
    ["payload.object.redirect_forwarded_by.extension_number"],
    "",
  );
  const routingFromName = getPath(
    body,
    ["payload.object.call_routing.from.name"],
    "",
  );
  const routingFromExt = getPath(
    body,
    ["payload.object.call_routing.from.extension_number"],
    "",
  );
  const routingToName = getPath(
    body,
    ["payload.object.call_routing.to.name"],
    "",
  );
  const routingToExt = getPath(
    body,
    ["payload.object.call_routing.to.extension_number"],
    "",
  );

  const groupKey = callId || voicemailId || `${event}:${caller}:${eventTs}`;

  return {
    event,
    eventTs,
    callId: callId || "",
    groupKey,
    caller,
    callerName,
    callerEmail,
    callerExtension: String(callerExtension || ""),
    callee,
    calleeName,
    calleeEmail,
    calleeExtension: String(calleeExtension || ""),
    agent,
    agentEmail,
    duration,
    direction,
    handupResult,
    transcript,
    recordingUrl,
    voicemailId,
    voicemailUrl,
    callEndTime: formatTime(rawCallEnd),
    occurredAt: formatTime(occurredAt),
    ringingStartTime: formatTime(rawRingStart),
    answerStartTime: formatTime(rawAnswerStart),
    waitSeconds,
    forwardedByName,
    forwardedByExt,
    redirectByName,
    redirectByExt,
    routingFromName,
    routingFromExt,
    routingToName,
    routingToExt,
    raw: obj,
  };
}

function callerDisplay(info) {
  if (info.callerName && info.callerName !== info.caller)
    return info.callerName;
  return info.caller || "Unknown";
}

function calleeDisplay(info) {
  if (info.calleeName && info.calleeName !== info.callee)
    return info.calleeName;
  return info.callee || "Unknown";
}

function callerDetail(info) {
  const parts = [];
  if (info.caller && info.caller !== "unknown") parts.push(info.caller);
  if (info.callerExtension) parts.push(`ext. ${info.callerExtension}`);
  return parts.join(" · ");
}

function calleeDetail(info) {
  const parts = [];
  if (info.callee && info.callee !== "unknown") parts.push(info.callee);
  if (info.calleeExtension) parts.push(`ext. ${info.calleeExtension}`);
  return parts.join(" · ");
}

export function buildCallMessage(info, callRecord) {
  const status = callRecord?.status || "completed";
  const lines = [];

  if (status === "voicemail") {
    lines.push("📩 **Voicemail**");
  } else if (status === "missed") {
    lines.push("📵 **Missed Call**");
  } else {
    lines.push("📞 **Call Completed**");
  }

  lines.push("");
  lines.push(`**${callerDisplay(info)}** → **${calleeDisplay(info)}**`);

  const fromDetail = callerDetail(info);
  const toDetail = calleeDetail(info);
  if (fromDetail || toDetail) {
    lines.push(
      [fromDetail, toDetail ? `→ ${toDetail}` : ""].filter(Boolean).join(" "),
    );
  }

  if (callRecord?.answeredBy?.name) {
    lines.push(`Answered by **${callRecord.answeredBy.name}**`);
  }

  const metaParts = [];
  if (info.duration)
    metaParts.push(`Duration: **${formatDuration(info.duration)}**`);
  if (
    callRecord?.waitSeconds !== null &&
    callRecord?.waitSeconds !== undefined
  ) {
    metaParts.push(`Wait: **${formatDuration(callRecord.waitSeconds)}**`);
  }
  if (info.callEndTime || info.occurredAt) {
    metaParts.push(formatTimeShort(info.callEndTime || info.occurredAt));
  }
  if (metaParts.length) lines.push(metaParts.join("  ·  "));

  if (callRecord?.queue?.extension || callRecord?.queue?.name) {
    lines.push(
      `Queue: **${callRecord.queue.name || "Unknown"}**${callRecord.queue.extension ? ` (ext. ${callRecord.queue.extension})` : ""}`,
    );
  }

  if (
    callRecord?.autoReceptionist?.extension ||
    callRecord?.autoReceptionist?.name
  ) {
    lines.push(
      `Entry: **${callRecord.autoReceptionist.name || "Main Auto Receptionist"}**${callRecord.autoReceptionist.extension ? ` (ext. ${callRecord.autoReceptionist.extension})` : ""}`,
    );
  }

  // ── Use proxied URLs for recording and voicemail ──
  if (callRecord?.recording?.available && status !== "voicemail") {
    const url =
      proxyRecordingUrl(callRecord.recording.id) ||
      callRecord.recording.url ||
      "";
    if (url) {
      lines.push("");
      lines.push(`▶ [View Recording](${url})`);
    }
  }

  if (callRecord?.voicemail?.available) {
    const url = proxyVoicemailUrl(callRecord.voicemail.url) || "";
    if (url) {
      lines.push("");
      lines.push(`▶ [Listen to Voicemail](${url})`);
    }
  }

  if (callRecord?.voicemail?.transcript) {
    lines.push("");
    lines.push("**Transcript:**");
    lines.push(`"${callRecord.voicemail.transcript}"`);
  }

  if (callRecord?.aiSummary?.text) {
    lines.push("");
    lines.push("**AI Summary:**");
    lines.push(callRecord.aiSummary.text);
  }

  return lines.join("\n");
}

export function ensureCallRecord(
  state,
  info,
  contactIdentifier,
  conversationId,
) {
  if (!state.calls[info.groupKey]) {
    state.calls[info.groupKey] = {
      conversationId,
      contactIdentifier,
      zoomCallId: info.callId || "",
      events: [],
      status: "in_progress",
      direction: info.direction || "",
      caller: {
        number: info.caller || "",
        name: info.callerName || "",
        extension: info.callerExtension || "",
        email: info.callerEmail || "",
      },
      callee: {
        number: info.callee || "",
        name: info.calleeName || "",
        extension: info.calleeExtension || "",
        email: info.calleeEmail || "",
      },
      autoReceptionist: {
        extension: "801",
        name: "Main Auto Receptionist",
      },
      queue: {
        extension: "803",
        name: "Chatwoot Flow Queue",
      },
      answeredBy: {
        name: "",
        email: "",
        extension: "",
      },
      startedAt: info.occurredAt || "",
      ringingStartedAt: "",
      answerStartedAt: "",
      endedAt: "",
      duration: null,
      waitSeconds: null,
      handupResult: "",
      recording: {
        available: false,
        id: "",
        url: "",
      },
      voicemail: {
        available: false,
        id: "",
        url: "",
        transcript: "",
      },
      aiSummary: {
        available: false,
        text: "",
      },
      routePath: [],
      summaryPosted: false,
    };
  }

  return state.calls[info.groupKey];
}

export function updateCallRecord(callRecord, info) {
  if (!callRecord.events.includes(info.event)) {
    callRecord.events.push(info.event);
  }

  if (
    info.duration !== null &&
    info.duration !== undefined &&
    info.duration !== ""
  ) {
    callRecord.duration = Number(info.duration);
  }

  if (info.waitSeconds !== null && info.waitSeconds !== undefined) {
    callRecord.waitSeconds = Number(info.waitSeconds);
  }

  if (info.direction) callRecord.direction = info.direction;
  if (info.handupResult) callRecord.handupResult = info.handupResult;
  if (info.callEndTime || info.occurredAt)
    callRecord.endedAt = info.callEndTime || info.occurredAt;

  if (info.ringingStartTime)
    callRecord.ringingStartedAt = info.ringingStartTime;
  if (info.answerStartTime) callRecord.answerStartedAt = info.answerStartTime;

  if (info.callerName) callRecord.caller.name = info.callerName;
  if (info.callerEmail) callRecord.caller.email = info.callerEmail;
  if (info.callerExtension) callRecord.caller.extension = info.callerExtension;
  if (info.caller) callRecord.caller.number = info.caller;

  if (info.calleeName) callRecord.callee.name = info.calleeName;
  if (info.calleeEmail) callRecord.callee.email = info.calleeEmail;
  if (info.calleeExtension) callRecord.callee.extension = info.calleeExtension;
  if (info.callee) callRecord.callee.number = info.callee;

  if (info.agent) {
    callRecord.answeredBy.name = info.agent;
    callRecord.answeredBy.email = info.agentEmail || "";
    callRecord.answeredBy.extension = info.calleeExtension || "";
  }

  if (info.recordingUrl) {
    callRecord.recording.available = true;
    callRecord.recording.url = info.recordingUrl;
  }

  if (info.voicemailId || info.voicemailUrl || info.transcript) {
    callRecord.voicemail.available = true;
    if (info.voicemailId) callRecord.voicemail.id = info.voicemailId;
    if (info.voicemailUrl) callRecord.voicemail.url = info.voicemailUrl;
    if (info.transcript) callRecord.voicemail.transcript = info.transcript;
  }

  if (info.event === "phone.callee_answered") {
    callRecord.status = "answered";
  } else if (info.event === "phone.callee_missed") {
    callRecord.status = "missed";
  } else if (info.event === "phone.voicemail_received") {
    callRecord.status = "voicemail";
  } else if (
    info.event === "phone.callee_ended" ||
    info.event === "phone.caller_ended"
  ) {
    if (callRecord.status === "in_progress") callRecord.status = "completed";
  }

  // Prefer logical call_routing values from webhook
  if (info.routingToName || info.routingToExt) {
    callRecord.queue.name = info.routingToName || callRecord.queue.name;
    callRecord.queue.extension = String(
      info.routingToExt || callRecord.queue.extension,
    );
  } else if (info.forwardedByName) {
    callRecord.queue.name = info.forwardedByName;
    callRecord.queue.extension = String(
      info.forwardedByExt || callRecord.queue.extension,
    );
  }

  if (info.routingFromName || info.routingFromExt) {
    callRecord.autoReceptionist.name =
      info.routingFromName || callRecord.autoReceptionist.name;
    callRecord.autoReceptionist.extension = String(
      info.routingFromExt || callRecord.autoReceptionist.extension,
    );
  } else if (info.redirectByName) {
    callRecord.autoReceptionist.name = info.redirectByName;
    callRecord.autoReceptionist.extension = String(
      info.redirectByExt || callRecord.autoReceptionist.extension,
    );
  }

  if (
    (callRecord.duration === null || callRecord.duration === undefined) &&
    callRecord.answerStartedAt &&
    callRecord.endedAt
  ) {
    try {
      const diffMs =
        new Date(callRecord.endedAt).getTime() -
        new Date(callRecord.answerStartedAt).getTime();
      if (diffMs > 0) callRecord.duration = Math.round(diffMs / 1000);
    } catch {}
  }

  const step = buildRouteStep(info, callRecord);
  if (step) {
    const exists = callRecord.routePath.some(
      (r) =>
        r.event === step.event && r.target === step.target && r.at === step.at,
    );
    if (!exists) callRecord.routePath.push(step);
  }
}

function buildRouteStep(info, callRecord) {
  const at = info.callEndTime || info.occurredAt || new Date().toISOString();

  switch (info.event) {
    case "phone.callee_ringing":
      return {
        event: info.event,
        label: "Ringing",
        target: `${callRecord.queue.name} (${callRecord.queue.extension})`,
        at,
      };
    case "phone.callee_answered":
      return {
        event: info.event,
        label: "Answered",
        target: info.agent || info.calleeName || info.callee || "Unknown",
        at,
      };
    case "phone.callee_missed":
      return {
        event: info.event,
        label: "Missed",
        target: info.calleeName || info.callee || "Unknown",
        at,
      };
    case "phone.voicemail_received":
      return {
        event: info.event,
        label: "Voicemail",
        target: callRecord.queue.name,
        at,
      };
    default:
      return null;
  }
}

export async function createOrGetContact(info, state) {
  const key = info.caller;
  if (state.contacts[key]?.contactIdentifier) {
    return state.contacts[key].contactIdentifier;
  }

  const url = `${CHATWOOT_BASE_URL}/public/api/v1/inboxes/${CHATWOOT_INBOX_IDENTIFIER}/contacts`;
  const contactName = info.callerName || key;
  const isValidPhone = key.startsWith("+") && key.length >= 10;

  const payload = {
    identifier: key,
    name: contactName,
    custom_attributes: {
      source: "zoom-phone",
      first_seen: new Date().toISOString(),
      phone_or_extension: key,
    },
  };

  if (isValidPhone) payload.phone_number = key;
  if (info.callerEmail) payload.email = info.callerEmail;

  const resp = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
  });

  const contactIdentifier = resp.data.source_id;
  state.contacts[key] = { contactIdentifier, name: contactName };
  saveState(state);

  console.log(
    `Chatwoot contact ready | ${contactName} | identifier=${key} | source_id=${contactIdentifier}`,
  );

  return contactIdentifier;
}

export async function createConversation(contactIdentifier, info, state) {
  const url = `${CHATWOOT_BASE_URL}/public/api/v1/inboxes/${CHATWOOT_INBOX_IDENTIFIER}/contacts/${contactIdentifier}/conversations`;

  const payload = {
    custom_attributes: {
      source: "zoom-phone",
      zoom_call_id: info.callId || "",
      zoom_status: "in_progress",
      zoom_direction: info.direction || "",
      zoom_caller_number: info.caller || "",
      zoom_caller_name: info.callerName || "",
      zoom_business_number: info.callee || "",
      zoom_queue_extension: "803",
      zoom_auto_receptionist_extension: "801",
      zoom_answered_by: "",
      zoom_recording_available: false,
      zoom_voicemail_available: false,
      zoom_ai_summary_available: false,
    },
  };

  const resp = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
  });

  const conversationId = resp.data.id;
  ensureCallRecord(state, info, contactIdentifier, conversationId);
  saveState(state);

  console.log(
    `Chatwoot conversation created | conversationId=${conversationId} | callId=${info.callId || info.groupKey}`,
  );

  return conversationId;
}

export async function postMessage(contactIdentifier, conversationId, content) {
  const url = `${CHATWOOT_BASE_URL}/public/api/v1/inboxes/${CHATWOOT_INBOX_IDENTIFIER}/contacts/${contactIdentifier}/conversations/${conversationId}/messages`;

  await axios.post(
    url,
    { content },
    { headers: { "Content-Type": "application/json" } },
  );

  console.log(`Chatwoot message posted | conversationId=${conversationId}`);
}

export async function updateConversation(conversationId, updates) {
  if (!CHATWOOT_API_TOKEN || !CHATWOOT_ACCOUNT_ID) return;

  const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`;
  try {
    await axios.patch(url, updates, {
      headers: {
        "Content-Type": "application/json",
        api_access_token: CHATWOOT_API_TOKEN,
      },
    });
  } catch (err) {
    console.warn(
      "Could not update conversation:",
      err?.response?.data || err.message,
    );
  }
}

export async function syncConversationCustomAttributes(
  conversationId,
  callRecord,
) {
  // Use proxied URLs in custom attributes too
  const recordingLink =
    proxyRecordingUrl(callRecord.recording?.id) ||
    callRecord.recording?.url ||
    "";
  const voicemailLink =
    proxyVoicemailUrl(callRecord.voicemail?.url) ||
    callRecord.voicemail?.url ||
    "";

  const customAttributes = {
    zoom_call_id: callRecord.zoomCallId || "",
    zoom_status: callRecord.status || "",
    zoom_direction: callRecord.direction || "",
    zoom_caller_number: callRecord.caller?.number || "",
    zoom_caller_name: callRecord.caller?.name || "",
    zoom_business_number: callRecord.callee?.number || "",
    zoom_queue_extension: callRecord.queue?.extension || "",
    zoom_queue_name: callRecord.queue?.name || "",
    zoom_auto_receptionist_extension:
      callRecord.autoReceptionist?.extension || "",
    zoom_auto_receptionist_name: callRecord.autoReceptionist?.name || "",
    zoom_answered_by: callRecord.answeredBy?.name || "",
    zoom_answered_by_extension: callRecord.answeredBy?.extension || "",
    zoom_duration: formatDuration(callRecord.duration),
    zoom_wait_seconds: callRecord.waitSeconds ?? "",
    zoom_handup_result: callRecord.handupResult || "",
    zoom_recording_available: !!callRecord.recording?.available,
    zoom_recording_url: recordingLink,
    zoom_voicemail_available: !!callRecord.voicemail?.available,
    zoom_voicemail_url: voicemailLink,
    zoom_voicemail_transcript: callRecord.voicemail?.transcript || "",
    zoom_ai_summary_available: !!callRecord.aiSummary?.available,
    zoom_ai_summary: callRecord.aiSummary?.text || "",
    zoom_started_at: callRecord.startedAt || "",
    zoom_ringing_started_at: callRecord.ringingStartedAt || "",
    zoom_answer_started_at: callRecord.answerStartedAt || "",
    zoom_ended_at: callRecord.endedAt || "",
    zoom_route_path: JSON.stringify(callRecord.routePath || []),
  };

  await updateConversation(conversationId, {
    custom_attributes: customAttributes,
  });
}

export async function resolveConversation(conversationId) {
  if (!CHATWOOT_API_TOKEN || !CHATWOOT_ACCOUNT_ID) return;

  const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/toggle_status`;
  try {
    await axios.post(
      url,
      { status: "resolved" },
      {
        headers: {
          "Content-Type": "application/json",
          api_access_token: CHATWOOT_API_TOKEN,
        },
      },
    );
    console.log(`Conversation ${conversationId} auto-resolved`);
  } catch (err) {
    console.warn(
      "Could not resolve conversation:",
      err?.response?.data || err.message,
    );
  }
}

export function mergeZoomApiData(callRecord, apiData) {
  if (!apiData) return;

  const history = apiData.history || {};
  const path = apiData.callPath || {};
  const elements = path.call_elements || path.call_path || [];

  if (history.id) callRecord.zoomCallHistoryId = history.id;
  if (history.call_path_id) callRecord.zoomCallPathId = history.call_path_id;

  if (history.direction) callRecord.direction = history.direction;
  if (history.duration !== undefined && history.duration !== null) {
    callRecord.duration = Number(history.duration);
  }
  if (history.call_result) {
    callRecord.handupResult = history.call_result;
  }
  if (history.start_time) callRecord.startedAt = history.start_time;
  if (history.end_time) callRecord.endedAt = history.end_time;

  if (history.recording_status === "recorded") {
    callRecord.recording.available = true;
  }

  const normalizedRoute = elements.map((item) => ({
    event: item.event || "",
    result: item.result || "",
    calleeName: item.callee_name || "",
    calleeExtNumber: item.callee_ext_number || "",
    calleeExtType: item.callee_ext_type || "",
    operatorName: item.operator_name || "",
    operatorExtNumber: item.operator_ext_number || "",
    operatorExtType: item.operator_ext_type || "",
    startTime: item.start_time || "",
    answerTime: item.answer_time || "",
    endTime: item.end_time || "",
    talkTime: item.talk_time || 0,
    holdTime: item.hold_time || 0,
    waitTime: item.wait_time || 0,
    recordingId: item.recording_id || "",
    callElementId: item.call_element_id || "",
    calleeEmail: item.callee_email || "",
  }));

  if (normalizedRoute.length > 0) {
    callRecord.routePath = normalizedRoute;
  }

  const ringToMember = normalizedRoute.find(
    (x) => x.event === "ring_to_member" && x.calleeExtType === "user",
  );

  if (ringToMember) {
    callRecord.answeredBy.name =
      ringToMember.calleeName || callRecord.answeredBy.name;
    callRecord.answeredBy.extension =
      ringToMember.calleeExtNumber || callRecord.answeredBy.extension;
  }

  const queueStep = normalizedRoute.find(
    (x) => x.calleeExtType === "call_queue",
  );
  if (queueStep) {
    callRecord.queue.name = queueStep.calleeName || callRecord.queue.name;
    callRecord.queue.extension =
      queueStep.calleeExtNumber || callRecord.queue.extension;
  }

  const autoReceptionistStep = normalizedRoute.find(
    (x) => x.calleeExtType === "auto_receptionist",
  );
  if (autoReceptionistStep) {
    callRecord.autoReceptionist.name =
      autoReceptionistStep.calleeName || callRecord.autoReceptionist.name;
    callRecord.autoReceptionist.extension =
      autoReceptionistStep.calleeExtNumber ||
      callRecord.autoReceptionist.extension;
  }

  const recordingStep = normalizedRoute.find((x) => x.recordingId);
  if (recordingStep) {
    callRecord.recording.available = true;
    callRecord.recording.id = recordingStep.recordingId;
  }

  const waitStep = normalizedRoute.find(
    (x) => typeof x.waitTime === "number" && x.waitTime > 0,
  );
  if (
    waitStep &&
    (callRecord.waitSeconds === null || callRecord.waitSeconds === undefined)
  ) {
    callRecord.waitSeconds = waitStep.waitTime;
  }

  const talkStep = normalizedRoute.find(
    (x) => typeof x.talkTime === "number" && x.talkTime > 0,
  );
  if (
    talkStep &&
    (callRecord.duration === null || callRecord.duration === undefined)
  ) {
    callRecord.duration = talkStep.talkTime;
  }
}
