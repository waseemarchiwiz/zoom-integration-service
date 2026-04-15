import dotenv from "dotenv";
dotenv.config();

export const PORT = process.env.PORT || 3001;
export const ZOOM_WEBHOOK_SECRET_TOKEN =
  process.env.ZOOM_WEBHOOK_SECRET_TOKEN || "";
export const CHATWOOT_BASE_URL = (process.env.CHATWOOT_BASE_URL || "").replace(
  /\/+$/,
  "",
);

export const CHATWOOT_INBOX_IDENTIFIER =
  process.env.CHATWOOT_INBOX_IDENTIFIER || "";

export const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || "";
export const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || "";

export const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || "";
export const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || "";
export const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID || "";

export const ZOOM_DATA_DIR = "/home/azureuser/zoom-bridge-data";

// Public URL for proxied media links (recording/voicemail playback)
export const BRIDGE_PUBLIC_URL = (
  process.env.BRIDGE_PUBLIC_URL ||
  CHATWOOT_BASE_URL ||
  ""
).replace(/\/+$/, "");
