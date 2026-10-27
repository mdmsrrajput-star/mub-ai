(() => {
  "use strict";
  const CLIENT_ID = "1064070440957-kuihr9e5r7go5qv87nks4igmnbbfum0a.apps.googleusercontent.com";
  const API = "/api/auth";
  const root = document.createElement("section");
  root.id = "mubAccountPanel";
  root.innerHTML = `
    <style>
      #mubAccountPanel{font:14px system-ui,Arial,sans-serif;color:var(--text,#edf2ff);background:var(--panel,#141c30);border:1px solid var(--border,#28334b);border-radius:12px;padding:12px;margin:12px auto;max-width:1050px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
      #mubAccountPanel .mub-account-left{display:flex;align-items:center;gap:10px;min-width:0}
      #mubAccountPanel .mub-account-avatar{width:36px;height:36px;border-radius:50%;object-fit:cover;background:#304c80;display:grid;place-items:center;font-weight:800}
      #mubAccountPanel .mub-account-meta{min-width:0}
      #mubAccountPanel .mub-account-name{font-weight:750;overflow-wrap:anywhere}
      #mubAccountPanel .mub-account-sub{font-size:12px;opacity:.75;overflow-wrap:anywhere;margin-top:2px}
      #mubAccountPanel .mub-account-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      #mubAccountPanel button{cursor:pointer;border:1px solid var(--border,#28334b);border-radius:8px;padding:9px 12px;background:#1b2740;color:inherit;font-weight:700}
      #mubAccountPanel .mub-account-error{width:100%;font-size:12px;color:#ff8794}
      #mubAccountPanel .mub-account-join{background:#244f42}
    </style>
    <div class="mub-account-left"><div class="mub-account-avatar">M</div><div class="mub-account-meta"><div class="mub-account-name">MuB account</div><div class="mub-account-sub">Sign in to use your shared MuB identity</div></div></div>
    <div class="mub-account-actions"><div id="mubGoogleButton"></div></div>
    <div class="mub-account-error" id="mubAuthError" role="status" hidden></div>`;
  const attach = () => {
    const header = document.querySelector("header");
    if (header && header.parentNode) header.insertAdjacentElement("afterend", root);
    else document.body.insertBefore(root, document.body.firstChild);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach, { once: true }); else attach();

  const errorBox = () => root.querySelector("#mubAuthError");
  function showError(message) {
    errorBox().textContent = message;
    errorBox().hidden = !message;
  }
  async function request(path, options) {
    const response = await fetch(path, { credentials: "same-origin", ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || "Request failed.");
    return data;
  }
  function renderUser(user) {
    const avatar = root.querySelector(".mub-account-avatar");
    const name = root.querySelector(".mub-account-name");
    const sub = root.querySelector(".mub-account-sub");
    const actions = root.querySelector(".mub-account-actions");
    actions.replaceChildren();
    if (!user) {
      avatar.textContent = "M";
      name.textContent = "MuB account";
      sub.textContent = "Sign in to use your shared MuB identity";
      loadGoogle();
      return;
    }
    if (user.picture) {
      avatar.textContent = "";
      avatar.style.backgroundImage = "url(" + JSON.stringify(user.picture).slice(1, -1) + ")";
      avatar.style.backgroundSize = "cover";
      avatar.style.backgroundPosition = "center";
    } else {
      avatar.style.backgroundImage = "";
      avatar.textContent = (user.name || "M").slice(0, 1).toUpperCase();
    }
    name.textContent = user.name || "MuB user";
    sub.textContent = (user.id || "") + " · " + (user.email || "");
    const join = document.createElement("button");
    join.className = "mub-account-join";
    join.textContent = "JOIN TOURNAMENT";
    join.addEventListener("click", () => {
      showError("Shared sign-in is connected. Tournament account linking is the next integration step; no separate account has been created.");
    });
    const logout = document.createElement("button");
    logout.textContent = "Sign out";
    logout.addEventListener("click", async () => {
      logout.disabled = true;
      try {
        await request(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "logout" }) });
        renderUser(null);
      } catch (e) { showError(e.message); logout.disabled = false; }
    });
    actions.append(join, logout);
  }
  let googleLoading = false;
  function loadGoogle() {
    if (googleLoading || document.getElementById("mubGoogleIdentityScript")) return;
    googleLoading = true;
    const script = document.createElement("script");
    script.id = "mubGoogleIdentityScript";
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (!window.google?.accounts?.id) {
        showError("Google sign-in could not load. Refresh and try again.");
        return;
      }
      window.google.accounts.id.initialize({
        client_id: CLIENT_ID,
        callback: async (response) => {
          showError("");
          try {
            const result = await request(API, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "login", credential: response.credential })
            });
            renderUser(result.user);
          } catch (e) { showError(e.message); }
        },
        auto_select: false,
        cancel_on_tap_outside: true
      });
      window.google.accounts.id.renderButton(root.querySelector("#mubGoogleButton"), {
        type: "standard", theme: "filled_blue", size: "large", text: "signin_with", shape: "rectangular", width: 220
      });
    };
    script.onerror = () => showError("Unable to load Google sign-in. Check your connection.");
    document.head.appendChild(script);
  }
  async function init() {
    try {
      const data = await request(API, { method: "GET" });
      renderUser(data.user || null);
    } catch (e) {
      showError(e.message);
      renderUser(null);
    }
  }
  document.addEventListener("DOMContentLoaded", init, { once: true });
  if (document.readyState !== "loading") init();
})();
