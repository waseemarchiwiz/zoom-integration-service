import axios from "axios";

import {
  ZOOM_CLIENT_ID,
  ZOOM_CLIENT_SECRET,
  ZOOM_ACCOUNT_ID,
} from "./config.js";

let tokenCache = {
  accessToken: "",
  expiresAt: 0,
};

function getBasicAuth() {
  return Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString(
    "base64",
  );
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function formatDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

export async function getZoomAccessToken(forceRefresh = false) {
  if (
    !forceRefresh &&
    tokenCache.accessToken &&
    Date.now() < tokenCache.expiresAt - 60_000
  ) {
    return tokenCache.accessToken;
  }

  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(
    ZOOM_ACCOUNT_ID,
  )}`;

  const resp = await axios.post(url, null, {
    headers: {
      Authorization: `Basic ${getBasicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  const { access_token, expires_in } = resp.data;

  tokenCache = {
    accessToken: access_token,
    expiresAt: Date.now() + Number(expires_in || 3600) * 1000,
  };

  return tokenCache.accessToken;
}

export async function getAccountCallHistory({
  from,
  to,
  pageSize = 100,
  nextPageToken = "",
} = {}) {
  const token = await getZoomAccessToken();

  const resp = await axios.get("https://api.zoom.us/v2/phone/call_history", {
    headers: authHeaders(token),
    params: {
      from,
      to,
      page_size: pageSize,
      ...(nextPageToken ? { next_page_token: nextPageToken } : {}),
    },
  });

  return resp.data;
}

export async function findCallHistoryByZoomCallId(callId, aroundIso = "") {
  const anchor = aroundIso ? new Date(aroundIso) : new Date();
  const fromDate = new Date(anchor);
  const toDate = new Date(anchor);

  fromDate.setDate(fromDate.getDate() - 2);
  toDate.setDate(toDate.getDate() + 1);

  let nextPageToken = "";

  for (let i = 0; i < 10; i += 1) {
    const data = await getAccountCallHistory({
      from: formatDateOnly(fromDate),
      to: formatDateOnly(toDate),
      pageSize: 100,
      nextPageToken,
    });

    const logs = data.call_logs || [];
    const hit = logs.find((x) => String(x.call_id) === String(callId));
    if (hit) return hit;

    if (!data.next_page_token) break;
    nextPageToken = data.next_page_token;
  }

  return null;
}

export async function getCallPath(callLogId) {
  const token = await getZoomAccessToken();

  const resp = await axios.get(
    `https://api.zoom.us/v2/phone/call_history/${encodeURIComponent(callLogId)}`,
    {
      headers: authHeaders(token),
    },
  );
  return resp.data;
}

export async function getEnrichedCallData(callId, aroundIso = "") {
  const history = await findCallHistoryByZoomCallId(callId, aroundIso);
  if (!history) return null;

  const callPath = await getCallPath(history.id);

  return {
    history,
    callPath,
  };
}

export async function getRecordingDownloadUrl(recordingId, aroundIso = "") {
  const token = await getZoomAccessToken();
  const anchor = aroundIso ? new Date(aroundIso) : new Date();
  const fromDate = new Date(anchor);
  const toDate = new Date(anchor);
  fromDate.setDate(fromDate.getDate() - 2);
  toDate.setDate(toDate.getDate() + 1);

  const resp = await axios.get("https://api.zoom.us/v2/phone/recordings", {
    headers: authHeaders(token),
    params: {
      from: formatDateOnly(fromDate),
      to: formatDateOnly(toDate),
      page_size: 100,
    },
  });

  const recordings = resp.data?.recordings || [];
  const hit = recordings.find((r) => r.id === recordingId);
  return hit?.download_url || null;
}
