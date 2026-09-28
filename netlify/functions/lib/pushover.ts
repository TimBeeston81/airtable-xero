// Minimal Pushover client for phone alerts to Tim himself.
//
// Two tiers, chosen by the caller:
//   - normal    → priority 0: an ordinary notification that respects iOS Focus / quiet hours
//   - emergency → priority 2: breaks through Focus and silent mode (needs Critical Alerts allowed
//                 for Pushover on the iPhone) and repeats every RETRY_SECONDS until acknowledged
//                 in the app, or EXPIRE_SECONDS passes

const RETRY_SECONDS = 60; // Pushover minimum is 30
const EXPIRE_SECONDS = 3600; // Pushover maximum is 10800

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// `html` is Pushover's HTML subset (<b>, <i>, <u>, <a href>, <font color>) — escape untrusted text in it.
export async function sendPushover(options: {
  title: string;
  html: string;
  url?: string;
  urlTitle?: string;
  emergency?: boolean;
}): Promise<string> {
  const token = Netlify.env.get("PUSHOVER_APP_TOKEN");
  const user = Netlify.env.get("PUSHOVER_USER_KEY");
  if (!token || !user) {
    throw new Error("PUSHOVER_APP_TOKEN and PUSHOVER_USER_KEY must both be set");
  }

  const response = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      user,
      title: options.title,
      message: options.html,
      html: 1,
      url: options.url,
      url_title: options.urlTitle,
      ...(options.emergency
        ? { priority: 2, retry: RETRY_SECONDS, expire: EXPIRE_SECONDS }
        : { priority: 0 }),
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.status !== 1) {
    const message = Array.isArray(data?.errors) ? data.errors.join("; ") : JSON.stringify(data);
    throw new Error(`Pushover API error (${response.status}): ${message}`);
  }

  return data.request;
}
