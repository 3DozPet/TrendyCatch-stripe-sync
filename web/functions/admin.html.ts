// Gatekeeper for GET /admin.html. Cloudflare Pages Functions run in front of
// static assets, so this intercepts every request to the dashboard before it
// reaches the real admin.html file: no password set yet -> show the "create
// your password" page; password set but no valid session -> show the login
// page; valid session -> fall through to the real static file via next().
import { hasPasswordSet, hasValidSession } from "./_lib/auth"

interface Env {
  ORDERS_KV?: KVNamespace
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env, next }) => {
  if (!env.ORDERS_KV) {
    // Can't gate without KV — fail open rather than lock the owner out
    // entirely. In practice KV is always bound (the rest of the dashboard
    // needs it too), so this should never trigger.
    return next()
  }

  const passwordSet = await hasPasswordSet(env.ORDERS_KV)
  if (!passwordSet) {
    return htmlResponse(renderSetPasswordPage())
  }

  const authed = await hasValidSession(request, env.ORDERS_KV)
  if (!authed) {
    return htmlResponse(renderLoginPage())
  }

  return next()
}

function htmlResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })
}

function pageShell(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { --ink:#121417; --muted:#6b7280; --bg:#0f1115; --card:#1a1d24; --border:#2a2e37; --accent:#34d399; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:#f3f4f6; }
  .card { width:100%; max-width:360px; background:var(--card); border:1px solid var(--border); border-radius:14px; padding:28px 26px; margin:16px; }
  h1 { font-size:18px; margin:0 0 6px; font-weight:700; }
  p.sub { font-size:13px; color:var(--muted); margin:0 0 20px; }
  label { display:block; font-size:12px; color:var(--muted); margin-bottom:6px; }
  input { width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--border); background:#11141a; color:#f3f4f6; font-size:14px; margin-bottom:14px; }
  input:focus { outline:2px solid var(--accent); border-color:var(--accent); }
  button { width:100%; padding:11px; border-radius:8px; border:none; background:var(--accent); color:#06281f; font-weight:700; font-size:14px; cursor:pointer; }
  button:disabled { opacity:0.6; cursor:default; }
  .error { font-size:13px; color:#f87171; margin:0 0 14px; min-height:16px; }
</style>
</head>
<body>
<div class="card">${inner}</div>
</body>
</html>`
}

function renderSetPasswordPage(): string {
  const inner = `
    <h1>Set your admin password</h1>
    <p class="sub">No password is configured yet. Choose one now to protect this dashboard — at least 8 characters.</p>
    <form id="f">
      <label for="p1">New password</label>
      <input id="p1" type="password" minlength="8" required autocomplete="new-password" />
      <label for="p2">Confirm password</label>
      <input id="p2" type="password" minlength="8" required autocomplete="new-password" />
      <p class="error" id="err"></p>
      <button type="submit" id="btn">Create password</button>
    </form>
    <script>
      const f = document.getElementById("f");
      const err = document.getElementById("err");
      const btn = document.getElementById("btn");
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const p1 = document.getElementById("p1").value;
        const p2 = document.getElementById("p2").value;
        if (p1 !== p2) { err.textContent = "Passwords don't match."; return; }
        btn.disabled = true; err.textContent = "";
        try {
          const res = await fetch("/admin-set-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: p1 }),
          });
          const data = await res.json();
          if (res.ok) { location.href = "/admin.html"; }
          else { err.textContent = data.error || "Something went wrong."; btn.disabled = false; }
        } catch (e2) { err.textContent = "Network error — try again."; btn.disabled = false; }
      });
    </script>`
  return pageShell("Set admin password — TrendyCatch", inner)
}

function renderLoginPage(): string {
  const inner = `
    <h1>Admin login</h1>
    <p class="sub">Enter your password to view the TrendyCatch dashboard.</p>
    <form id="f">
      <label for="p">Password</label>
      <input id="p" type="password" required autocomplete="current-password" autofocus />
      <p class="error" id="err"></p>
      <button type="submit" id="btn">Log in</button>
    </form>
    <script>
      const f = document.getElementById("f");
      const err = document.getElementById("err");
      const btn = document.getElementById("btn");
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const p = document.getElementById("p").value;
        btn.disabled = true; err.textContent = "";
        try {
          const res = await fetch("/admin-login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: p }),
          });
          const data = await res.json();
          if (res.ok) { location.href = "/admin.html"; }
          else { err.textContent = data.error || "Login failed."; btn.disabled = false; }
        } catch (e2) { err.textContent = "Network error — try again."; btn.disabled = false; }
      });
    </script>`
  return pageShell("Log in — TrendyCatch", inner)
}
