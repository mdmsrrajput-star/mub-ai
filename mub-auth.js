(() => {
  const CLIENT_ID = "1064070440957-1ial119jci1jninb5t10stg5p79bttpi.apps.googleusercontent.com";
  const style = document.createElement("style");
  style.textContent = `
    .mub-auth-wrap{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:10px}
    .mub-auth-button{display:inline-flex;align-items:center;justify-content:center;gap:9px;min-height:40px;padding:9px 13px;border:1px solid #c9d1dc;border-radius:9px;background:#fff;color:#202124;font:600 13px system-ui,Arial;cursor:pointer}
    .mub-auth-button img{width:18px;height:18px}
    .mub-auth-profile{display:flex;align-items:center;gap:8px;min-width:0;font:12px system-ui,Arial;color:inherit}
    .mub-auth-profile img{width:30px;height:30px;border-radius:50%;object-fit:cover}
    .mub-auth-profile span{overflow-wrap:anywhere}
    .mub-auth-status{font:12px system-ui,Arial;opacity:.85}
  `;
  document.head.appendChild(style);
  const host = document.querySelector("header") || document.body;
  const wrap = document.createElement("div");
  wrap.className = "mub-auth-wrap";
  wrap.innerHTML = '<button type="button" class="mub-auth-button" id="mubGoogleSignIn"><img alt="" src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg">Continue with Google</button><div class="mub-auth-status" id="mubAuthStatus" aria-live="polite"></div><div class="mub-auth-profile" id="mubAuthProfile" hidden></div>';
  host.appendChild(wrap);
  const button = wrap.querySelector("#mubGoogleSignIn");
  const status = wrap.querySelector("#mubAuthStatus");
  const profile = wrap.querySelector("#mubAuthProfile");

  function showUser(user) {
    button.hidden = true;
    status.textContent = "";
    profile.hidden = false;
    profile.replaceChildren();
    if (user.picture) {
      const img = document.createElement("img"); img.src = user.picture; img.alt = ""; img.referrerPolicy = "no-referrer"; profile.appendChild(img);
    }
    const label = document.createElement("span");
    label.textContent = (user.displayName || "MuB user") + " · " + (user.id || "");
    profile.appendChild(label);
    const logout = document.createElement("button");
    logout.type = "button"; logout.className = "mub-auth-button"; logout.textContent = "Sign out";
    logout.addEventListener("click", async () => {
      await fetch("/api/auth?action=logout", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({action:"logout"}), credentials:"same-origin" });
      location.reload();
    });
    profile.appendChild(logout);
  }
  async function login(credential) {
    status.textContent = "Verifying Google account…";
    button.disabled = true;
    try {
      const response = await fetch("/api/auth", { method:"POST", headers:{"Content-Type":"application/json"}, credentials:"same-origin", body:JSON.stringify({action:"login",credential}) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Sign-in failed.");
      showUser(data.user);
      status.textContent = "Signed in securely.";
      window.dispatchEvent(new CustomEvent("mub:auth", {detail:data.user}));
    } catch (error) {
      status.textContent = error.message || "Sign-in failed. Please retry.";
      button.disabled = false;
    }
  }
  async function loadMe() {
    try {
      const r = await fetch("/api/auth?action=me", {credentials:"same-origin",cache:"no-store"});
      if (r.ok) { const d = await r.json(); if (d.user) showUser(d.user); }
    } catch {}
  }
  function initGoogle() {
    if (!window.google?.accounts?.id) { status.textContent = "Google sign-in is loading…"; return false; }
    window.google.accounts.id.initialize({client_id:CLIENT_ID,callback:(response)=>login(response.credential),auto_select:false});
    button.addEventListener("click", () => {
      status.textContent = "Choose your Google account in the sign-in window.";
      window.google.accounts.id.prompt();
    });
    return true;
  }
  const gis = document.createElement("script");
  gis.src = "https://accounts.google.com/gsi/client";
  gis.async = true; gis.defer = true;
  gis.onload = () => { if (!initGoogle()) status.textContent = "Google sign-in could not initialize. Refresh and try again."; };
  gis.onerror = () => { status.textContent = "Google sign-in could not load. Check your connection or content blocker."; };
  document.head.appendChild(gis);
  loadMe();
})();