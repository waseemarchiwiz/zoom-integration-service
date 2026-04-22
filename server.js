import express from "express";
import axios from "axios";

import {
  getZoomAccessToken,
  findCallHistoryByZoomCallId,
  getCallPath,
  getEnrichedCallData,
  getRecordingDownloadUrl,
} from "./zoom-api.js";

import {
  PORT,
  CHATWOOT_BASE_URL,
  ZOOM_WEBHOOK_SECRET_TOKEN,
  CHATWOOT_INBOX_IDENTIFIER,
  CHATWOOT_API_TOKEN,
  CHATWOOT_ACCOUNT_ID,
} from "./config.js";

import {
  postMessage,
  createConversation,
  createOrGetContact,
  buildCallMessage,
  buildValidationResponse,
  verifyZoomSignature,
  updateConversation,
  resolveConversation,
  loadState,
  saveState,
  extractCallInfo,
  formatDuration,
  ensureCallRecord,
  updateCallRecord,
  syncConversationCustomAttributes,
  mergeZoomApiData,
  getCallsForConversation,
  serializeCallForApi,
} from "./utils.js";

const app = express();
const processingLocks = new Map();
const pendingSummaries = new Map();

// TEMP: keep calls visible in Chatwoot while testing UI
const AUTO_RESOLVE_CALLS = false;

// Middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

async function withLock(key, fn) {
  while (processingLocks.get(key)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  processingLocks.set(key, true);
  try {
    return await fn();
  } finally {
    processingLocks.delete(key);
  }
}

if (
  !ZOOM_WEBHOOK_SECRET_TOKEN ||
  !CHATWOOT_BASE_URL ||
  !CHATWOOT_INBOX_IDENTIFIER
) {
  console.error("Missing required env vars");
  process.exit(1);
}

if (!CHATWOOT_API_TOKEN || !CHATWOOT_ACCOUNT_ID) {
  console.warn(
    "CHATWOOT_API_TOKEN or CHATWOOT_ACCOUNT_ID not set — auto-resolve disabled",
  );
}

const HANDLED_EVENTS = new Set([
  "phone.callee_ringing",
  "phone.callee_answered",
  "phone.callee_missed",
  "phone.callee_ended",
  "phone.caller_ended",
  "phone.voicemail_received",
]);

const ENDED_EVENTS = new Set([
  "phone.callee_ended",
  "phone.caller_ended",
  "phone.callee_missed",
  "phone.voicemail_received",
]);

// ─── Media proxy endpoints ───────────────────────────────────────────
// These fetch recordings/voicemails from Zoom with the Bearer token
// so Chatwoot links work without exposing Zoom credentials.

app.get("/media/voicemail/:voicemailId", async (req, res) => {
  try {
    const token = await getZoomAccessToken();
    const zoomUrl = `https://zoom.us/v2/phone/voice_mails/download/${encodeURIComponent(req.params.voicemailId)}`;

    const resp = await axios.get(zoomUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: "stream",
      maxRedirects: 5,
    });

    res.setHeader("Content-Type", resp.headers["content-type"] || "audio/mpeg");
    if (resp.headers["content-length"]) {
      res.setHeader("Content-Length", resp.headers["content-length"]);
    }
    res.setHeader("Content-Disposition", "inline");

    resp.data.pipe(res);
  } catch (err) {
    console.error(
      "Voicemail proxy error:",
      err?.response?.status,
      err?.response?.data || err.message,
    );
    const status = err?.response?.status || 500;
    res.status(status).json({ error: "Voicemail download failed" });
  }
});

app.get("/media/recording/:recordingId", async (req, res) => {
  try {
    const downloadUrl = await getRecordingDownloadUrl(req.params.recordingId);

    if (!downloadUrl) {
      return res.status(404).json({ error: "Recording not found" });
    }

    const token = await getZoomAccessToken();
    const resp = await axios.get(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: "stream",
      maxRedirects: 5,
    });

    res.setHeader("Content-Type", resp.headers["content-type"] || "audio/mpeg");
    if (resp.headers["content-length"]) {
      res.setHeader("Content-Length", resp.headers["content-length"]);
    }
    res.setHeader("Content-Disposition", "inline");
    resp.data.pipe(res);
  } catch (err) {
    console.error(
      "Recording proxy error:",
      err?.response?.status,
      err?.response?.data || err.message,
    );
    const status = err?.response?.status || 500;
    res.status(status).json({ error: "Recording download failed" });
  }
});

// ─── Health & debug endpoints ────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    service: "zoom-chatwoot-bridge",
    version: "4.2",
    status: "running",
    autoResolveCalls: AUTO_RESOLVE_CALLS,
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.get("/debug/state", (_req, res) => {
  const state = loadState();
  res.json({
    totalContacts: Object.keys(state.contacts).length,
    totalCalls: Object.keys(state.calls).length,
    recentCalls: Object.entries(state.calls)
      .slice(-10)
      .map(([groupKey, val]) => ({ groupKey, ...val })),
  });
});

async function postFinalSummary(groupKey) {
  const state = loadState();
  const callRecord = state.calls[groupKey];
  if (!callRecord || callRecord.summaryPosted) return;

  // Re-enrich from Zoom API (data may not have been ready during webhook)
  if (
    callRecord.zoomCallId &&
    (!callRecord.recording?.available ||
      (callRecord.recording?.id && !callRecord.recording?.downloadUrl))
  ) {
    try {
      const apiData = await getEnrichedCallData(
        callRecord.zoomCallId,
        callRecord.endedAt || callRecord.startedAt || "",
      );
      if (apiData) {
        mergeZoomApiData(callRecord, apiData);
        saveState(state);

        // Fetch recording download URL if we have a recording ID
        if (callRecord.recording?.id && !callRecord.recording?.downloadUrl) {
          try {
            const { getRecordingDownloadUrl } = await import("./zoom-api.js");
            const downloadUrl = await getRecordingDownloadUrl(
              callRecord.recording.id,
              callRecord.endedAt || "",
            );
            if (downloadUrl) {
              callRecord.recording.downloadUrl = downloadUrl;
              saveState(state);
              console.log(`Recording download URL found for ${groupKey}`);
            }
          } catch (err) {
            console.warn(
              "Recording URL lookup failed:",
              err?.response?.data || err.message,
            );
          }
        }
        console.log(`Re-enriched call ${groupKey} from Zoom API`);
      }
    } catch (err) {
      console.warn("Re-enrichment failed:", err?.response?.data || err.message);
    }
  }

  const info = {
    event:
      callRecord.status === "missed"
        ? "phone.callee_missed"
        : callRecord.status === "voicemail"
          ? "phone.voicemail_received"
          : "phone.callee_answered",
    caller: callRecord.caller?.number || "",
    callerName: callRecord.caller?.name || "",
    callerExtension: callRecord.caller?.extension || "",
    callerEmail: callRecord.caller?.email || "",
    callee: callRecord.callee?.number || "",
    calleeName: callRecord.callee?.name || "",
    calleeExtension: callRecord.callee?.extension || "",
    calleeEmail: callRecord.callee?.email || "",
    agent: callRecord.answeredBy?.name || "",
    agentEmail: callRecord.answeredBy?.email || "",
    duration: callRecord.duration,
    direction: callRecord.direction || "",
    callEndTime: callRecord.endedAt || "",
    occurredAt: callRecord.endedAt || callRecord.startedAt || "",
    recordingUrl: callRecord.recording?.url || "",
    voicemailUrl: callRecord.voicemail?.url || "",
    voicemailId: callRecord.voicemail?.id || "",
    transcript: callRecord.voicemail?.transcript || "",
    handupResult: callRecord.handupResult || "",
    callId: callRecord.zoomCallId || groupKey,
  };

  const msg = buildCallMessage(info, callRecord);

  await postMessage(
    callRecord.contactIdentifier,
    callRecord.conversationId,
    msg,
  );

  await syncConversationCustomAttributes(callRecord.conversationId, callRecord);

  await updateConversation(callRecord.conversationId, {
    custom_attributes: {
      call_status: callRecord.status || "",
      call_duration: formatDuration(callRecord.duration) || "",
      agent: callRecord.answeredBy?.name || "",
    },
  });

  if (AUTO_RESOLVE_CALLS) {
    await resolveConversation(callRecord.conversationId);
  }

  const latestState = loadState();
  if (latestState.calls[groupKey]) {
    latestState.calls[groupKey].summaryPosted = true;
    saveState(latestState);
  }

  console.log(
    `Summary: ${groupKey} | ${callRecord.caller?.name || callRecord.caller?.number} → ${callRecord.callee?.name || callRecord.callee?.number} | ${formatDuration(callRecord.duration)} | ${(callRecord.status || "").toUpperCase()}`,
  );
}

app.get("/debug/zoom-api/:callId", async (req, res) => {
  try {
    const { callId } = req.params;

    const history = await findCallHistoryByZoomCallId(callId);
    if (!history) {
      return res.status(404).json({
        error: "Call history not found",
        callId,
      });
    }

    const callPath = await getCallPath(history.id);

    return res.json({
      ok: true,
      callId,
      callHistoryId: history.id,
      history,
      callPath,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Zoom API debug failed",
      detail: err?.response?.data || err.message || String(err),
    });
  }
});

app.get("/api/zoom/conversation/:conversationId", async (req, res) => {
  try {
    const { conversationId } = req.params;
    const calls = getCallsForConversation(conversationId);

    if (!calls.length) {
      return res.json({
        conversationId: Number(conversationId),
        hasMatch: false,
        matchType: "none",
        calls: [],
      });
    }

    return res.json({
      conversationId: Number(conversationId),
      hasMatch: true,
      matchType: calls.length === 1 ? "direct" : "multiple",
      calls: calls.map(serializeCallForApi),
    });
  } catch (err) {
    console.error("Conversation lookup failed:", err?.message || err);
    return res.status(500).json({
      error: "Conversation lookup failed",
    });
  }
});

app.post(
  "/webhook/zoom",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const rawBody = req.body.toString("utf8");

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    if (body.event === "endpoint.url_validation") {
      const plainToken = body?.payload?.plainToken;
      if (!plainToken) {
        return res.status(400).json({ error: "Missing plainToken" });
      }
      console.log("Zoom validation — responding");
      return res.status(200).json(buildValidationResponse(plainToken));
    }

    if (!verifyZoomSignature(req, rawBody)) {
      console.warn("Invalid signature — rejected");
      return res.status(401).json({ error: "Invalid signature" });
    }

    if (!HANDLED_EVENTS.has(body.event)) {
      return res.status(200).json({ ignored: true, event: body.event });
    }

    try {
      const info = extractCallInfo(body);

      console.log(
        `${info.event} | ${info.groupKey} | ${info.callerName || info.caller} → ${info.calleeName || info.callee}`,
      );
      console.log(
        "RAW PAYLOAD:",
        JSON.stringify(body.payload?.object, null, 2),
      );

      await withLock(info.groupKey, async () => {
        const state = loadState();
        const contactIdentifier = await createOrGetContact(info, state);

        let callRecord = state.calls[info.groupKey];

        if (!callRecord) {
          await createConversation(contactIdentifier, info, state);
          callRecord = state.calls[info.groupKey];
        } else {
          ensureCallRecord(
            state,
            info,
            callRecord.contactIdentifier || contactIdentifier,
            callRecord.conversationId,
          );
          callRecord = state.calls[info.groupKey];
        }

        updateCallRecord(callRecord, info);

        if (info.callId) {
          try {
            const apiData = await getEnrichedCallData(
              info.callId,
              info.callEndTime || info.occurredAt || "",
            );
            mergeZoomApiData(callRecord, apiData);
          } catch (err) {
            console.warn(
              "Zoom API enrichment failed:",
              err?.response?.data || err.message || err,
            );
          }
        }

        await syncConversationCustomAttributes(
          callRecord.conversationId,
          callRecord,
        );
        saveState(state);

        const isVoicemailOverride =
          info.event === "phone.voicemail_received" && callRecord.summaryPosted;

        if (
          (ENDED_EVENTS.has(info.event) &&
            !callRecord.summaryPosted &&
            !pendingSummaries.has(info.groupKey)) ||
          isVoicemailOverride
        ) {
          if (isVoicemailOverride) {
            callRecord.summaryPosted = false;
            saveState(state);
            console.log(
              `Voicemail override — will re-post summary for ${info.groupKey}`,
            );
          }
          pendingSummaries.set(info.groupKey, true);

          setTimeout(async () => {
            try {
              await postFinalSummary(info.groupKey);
            } catch (err) {
              console.error(
                "Summary failed:",
                err?.response?.data || err.message || err,
              );
            } finally {
              pendingSummaries.delete(info.groupKey);
            }
          }, 10000);
        }
      });

      return res.status(200).json({ received: true, call: info.groupKey });
    } catch (err) {
      console.error(
        "Processing failed:",
        err?.response?.data || err.message || err,
      );
      return res.status(500).json({ error: "Processing failed" });
    }
  },
);

app.listen(PORT, () => {
  console.log(`zoom-chatwoot-bridge v4.2 listening on :${PORT}`);
  console.log(`Chatwoot: ${CHATWOOT_BASE_URL}`);
  console.log(`Inbox: ${CHATWOOT_INBOX_IDENTIFIER}`);
  console.log(`Auto-resolve: ${AUTO_RESOLVE_CALLS ? "enabled" : "disabled"}`);
});
