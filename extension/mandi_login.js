/**
 * ToolsMandi Proxy Bar - Secure Sync System (MandiBar2)
 * Backend: https://toolsmandi.com/bar
 */

console.log("🚀 [MandiBar2] Secure Login system loading...");

const TM = {
  API_BASE: "https://toolsmandi.com/bar",
  HEARTBEAT_INTERVAL_MS: 5 * 60 * 1000, 
  heartbeatTimer: null,
  sessionToken: null,
  deviceSignature: null,

  // ── Init ──────────────────────────────────────────────────
  async init() {
    console.log("🔵 [TM] Initializing...");
    await this.generateDeviceSignature();
    const stored = await this.loadStorage();

    if (stored.sessionToken) {
      this.sessionToken = stored.sessionToken;
      console.log("🔵 [TM] Found stored session, verifying...");
      this.showLoading("Verifying your session...");
      await this.verifySession();
    } else {
      // No session
      await this.clearSensitiveStorage();
      console.log("🔵 [TM] No session found, showing login");
      this.showLogin();
    }

    const loginBtn = document.getElementById("login-btn");
    if (loginBtn) {
      loginBtn.addEventListener("click", () => this.handleLogin());
    }
  },

  // ── Device Signature ─────────────────────────────────────
  async generateDeviceSignature() {
    try {
      const raw = [
        navigator.userAgent,
        navigator.language,
        screen.width + "x" + screen.height,
        new Date().getTimezoneOffset(),
        navigator.platform,
      ].join("|");
      const encoded = new TextEncoder().encode(raw);
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
      this.deviceSignature = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    } catch (e) {
      this.deviceSignature = "fallback-" + Date.now();
    }
  },

  // ── Storage ───────────────────────────────────────────────
  loadStorage() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        ["tm_session_token"],
        (localResult) => {
          resolve({
            sessionToken: localResult.tm_session_token || null
          });
        },
      );
    });
  },

  saveSession(token) {
    return new Promise((resolve) => {
      chrome.storage.local.set(
        {
          tm_session_token: token,
          tm_device_sig: this.deviceSignature,
        },
        resolve,
      );
    });
  },

  clearSession() {
    return new Promise((resolve) => {
      chrome.storage.local.remove(
        ["tm_session_token", "tm_device_sig"],
        resolve,
      );
    });
  },

  clearSensitiveStorage() {
    return new Promise((resolve) => {
      chrome.storage.local.remove(
        [
          "ahToken", "ah_token", "ahIsAuth3", "ahUserData", "sessionDataUpdatedAt",
          "tm_force_direct", "tm_credential_source", "tm_last_inject_at",
        ],
        resolve,
      );
    });
  },

  normalizeUserData(ud) {
    const out = ud && typeof ud === "object" ? { ...ud } : {};
    out.keywordsLimit = 0;
    out.siteExplorerLimit = 0;
    if (!out.email) out.email = "user@toolsmandi.com";
    if (!out.workspaceName) out.workspaceName = "ToolsMandi";
    return out;
  },

  async injectCredentials(serverUserData) {
    if (!this.sessionToken) return false;

    const payload = {
      ahToken: { accessToken: this.sessionToken, expiresIn: 315360000 },
      ahUserData: this.normalizeUserData(serverUserData),
      ahIsAuth3: true,
      ahIsEnabled: true,
      tm_proxy_mode: true,
      sessionDataUpdatedAt: Date.now(),
    };

    await new Promise((r) => chrome.storage.local.remove(["ah_token", "tm_force_direct", "tm_credential_source"], r));
    await new Promise((r) => chrome.storage.local.remove(["ahTbGetIconCache", "ahTbGetIconCache2", "ahTbGetHeaderCache", "ahTbGetHeaderCache2"], r));
    await new Promise((r) => chrome.storage.local.set(payload, r));
    try {
      chrome.runtime.sendMessage({ type: 'mandi:sync', reason: 'inject' });
    } catch (e) {}
    console.log("✅ [TM] Session-based toolbar auth injected (proxy mode)");
    return true;
  },

  isFatalSessionError(error) {
    const msg = String(error || "").toLowerCase();
    if (!msg) return false;
    return (
      msg.includes("invalid session") ||
      msg.includes("invalid or expired session") ||
      msg.includes("please login again") ||
      msg.includes("disabled") ||
      msg.includes("blocked") ||
      msg.includes("expired") ||
      msg.includes("session limit") ||
      msg.includes("already active")
    );
  },

  async hasStoredCredentials() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["ahToken", "ahIsAuth3"], (store) => {
        resolve(!!(store.ahIsAuth3 && store.ahToken && store.ahToken.accessToken));
      });
    });
  },

  async refreshCredentials() {
    if (!this.sessionToken) return { ok: false, fatal: true, error: 'no session' };

    let serverUserData = null;
    try {
      const proxyMeta = await this.apiPost("mandibar_api.php", {
        action: "heartbeat",
        session_token: this.sessionToken,
      });
      if (!proxyMeta.success && this.isFatalSessionError(proxyMeta.error)) {
        return { ok: false, fatal: true, error: proxyMeta.error };
      }
      if (proxyMeta.ahrefs_credentials && proxyMeta.ahrefs_credentials.ahUserData) {
        serverUserData = proxyMeta.ahrefs_credentials.ahUserData;
      }
    } catch (e) {
      console.warn("[TM] mandibar_api ping failed:", e.message);
    }

    await this.injectCredentials(serverUserData);
    return { ok: true, fatal: false };
  },
  async performProxySync(proxyUrl, silent = false) {
    console.log("🌐 [TM] Proxy URL detected:", proxyUrl);
    try {
      if (!silent) this.showLoading("Syncing with proxy...");
      
      // ── Cache-busting: add timestamp param to bypass browser/CDN cache ──
      const cacheBuster = `?_t=${Date.now()}`;
      const urlWithBust = proxyUrl.includes('?')
        ? `${proxyUrl}&_t=${Date.now()}`
        : `${proxyUrl}${cacheBuster}`;

      const res = await fetch(urlWithBust, {
        credentials: 'include',
        cache: 'no-store',          // never use cached response
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      });
      if (!res.ok) {
         throw new Error(`Fetch failed with status ${res.status}`);
      }
      
      let data = await res.json();
      let fullJson = data;
      
      if (data.data && data.data.activationData) {
        fullJson = data.data.activationData;
      } else if (data.activationData) {
        fullJson = data.activationData;
      } else if (data.data && data.data.ahToken) {
        fullJson = data.data;
      }

      if (fullJson.ahToken && fullJson.ahToken.accessToken) {
        fullJson.ahIsAuth3 = true;
        fullJson.ahIsEnabled = true;
        fullJson.ahUserData = this.normalizeUserData(fullJson.ahUserData);
        // Proxy mode: never store raw Ahrefs token on client — session token only
        fullJson.ahToken = { accessToken: this.sessionToken, expiresIn: 315360000 };
        fullJson.tm_proxy_mode = true;
      } else {
        throw new Error("Invalid or empty Ahrefs token received.");
      }

      fullJson.sessionDataUpdatedAt = Date.now();
      
      await new Promise(r => chrome.storage.local.set(fullJson, r));
      chrome.runtime.sendMessage({ type: 'mandi:sync', reason: 'proxy-sync' });
      console.log("✅ [TM] Proxy sync complete (session-based auth)");
      return true;
    } catch(err) {
      console.error("❌ [TM] Proxy Fetch error:", err);
      throw err;
    }
  },


  // ── API Calls ─────────────────────────────────────────────
  async apiPost(path, body) {
    const response = await fetch(`${this.API_BASE}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let jsonText = text;
    const jsonStart = text.indexOf("{");
    if (jsonStart > 0) jsonText = text.substring(jsonStart);
    return JSON.parse(jsonText);
  },

  // ── Login Flow ────────────────────────────────────────────
  async handleLogin() {
    const username = document.getElementById("login-username")?.value?.trim();
    const password = document.getElementById("login-password")?.value;

    if (!username || !password) {
      this.showMessage("Please enter your username and password.", "warning");
      return;
    }

    this.showLoading("Logging in...");

    try {
      const loginResult = await this.apiPost("login.php", {
        username,
        password,
      });

      if (!loginResult.success) {
        this.showLogin();
        this.showMessage(
          loginResult.error || "Login failed. Please try again.",
          "error",
        );
        return;
      }

      this.sessionToken = loginResult.session_token;
      await this.saveSession(this.sessionToken);

      // Prefer direct server credentials; proxy URL is a secondary refresh path.
      this.showLoading("Securing connection...");
      const refresh = await this.refreshCredentials();

      if (!refresh.ok) {
        if (refresh.fatal) {
          await this.clearSession();
          this.sessionToken = null;
          this.showLogin();
          this.showMessage(refresh.error || "Activation failed.", "error");
          return;
        }
        this.startHeartbeat();
        this.showMainUI();
        this.showMessage("Logged in. Ahrefs credentials are still loading — click Refresh if metrics do not appear.", "warning");
        return;
      }

      this.startHeartbeat();
      this.showMainUI();

    } catch (err) {
      console.error("❌ [TM] Login error:", err);
      this.showLogin();
      this.showMessage(err.message || "Network error. Please check your connection.", "error");
    }
  },

  // ── Verify existing session ────────────────────────────────
  async verifySession(isManualRefresh = false) {
    try {
      const refresh = await this.refreshCredentials();

      if (refresh.ok) {
        this.startHeartbeat();
        if (isManualRefresh) {
          chrome.runtime.sendMessage({ type: "mandi:resync", reason: "manual-refresh" });
        }
        this.showMainUI();
        return;
      }

      if (refresh.fatal) {
        console.warn("⚠️ [TM] Session invalid:", refresh.error);
        await this.handleLogout();
        return;
      }

      console.warn("⚠️ [TM] Credentials refresh failed, keeping session");
      this.startHeartbeat();
      this.showMainUI();
      if (isManualRefresh) {
        alert("Could not refresh credentials. Your session is still active — try again shortly.");
      }
    } catch (err) {
      console.warn("⚠️ [TM] Init network error:", err.message);
      this.startHeartbeat();
      this.showMainUI();
      if (isManualRefresh) {
        alert("Network issue updating credentials. Your session is still active.");
      }
    } finally {
      if (isManualRefresh) this.resetRefreshButton();
    }
  },

  resetRefreshButton() {
    const btn = document.getElementById("tm-refresh-btn");
    if (btn) btn.textContent = "🔄 Update Proxy / Refresh";
  },

  // ── Heartbeat ─────────────────────────────────────────────
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(
      () => this.sendHeartbeat(),
      this.HEARTBEAT_INTERVAL_MS,
    );
    console.log("💓 [TM] Heartbeat started (every 5 min)");
  },

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  },

  async sendHeartbeat() {
    if (!this.sessionToken) return;
    try {
      const refresh = await this.refreshCredentials();
      if (refresh.ok) {
        console.log("💓 [TM] Heartbeat OK");
        return;
      }
      if (refresh.fatal) {
        console.warn("💓 [TM] Heartbeat session invalid:", refresh.error);
        await this.handleLogout();
      } else {
        console.warn("💓 [TM] Heartbeat credential refresh failed, session kept");
      }
    } catch (err) {
      console.warn("⚠️ [TM] Heartbeat network error");
    }
  },

  // ── Logout ────────────────────────────────────────────────
  async handleLogout() {
    console.log("🔴 [TM] Logging out...");
    this.stopHeartbeat();

    try {
      if (this.sessionToken) {
        await this.apiPost("logout.php", { session_token: this.sessionToken });
      }
    } catch (e) {}

    await this.clearSession();
    await this.clearSensitiveStorage();
    this.sessionToken = null;
    console.log("🗑️ [TM] All storage cleared");
    this.showLogin();
  },

  // ── UI Helpers ────────────────────────────────────────────
  showLogin() {
    const loginContainer = document.getElementById("login-container");
    const loadingEl = document.getElementById("login-loading");
    const formEl = document.getElementById("login-form-wrap");
    if (loginContainer) loginContainer.style.display = "block";
    if (loadingEl) loadingEl.style.display = "none";
    if (formEl) formEl.style.display = "block";
    document.getElementById("ah_p").style.display = "none";
  },

  showLoading(text = "Loading...") {
    const loginContainer = document.getElementById("login-container");
    const loadingEl = document.getElementById("login-loading");
    const formEl = document.getElementById("login-form-wrap");
    const loadingText = document.getElementById("loading-text");
    if (loginContainer) loginContainer.style.display = "block";
    if (loadingEl) loadingEl.style.display = "block";
    if (formEl) formEl.style.display = "none";
    if (loadingText) loadingText.textContent = text;
  },

  showMainUI() {
    const loginContainer = document.getElementById("login-container");
    if (loginContainer) loginContainer.style.display = "none";
    document.getElementById("ah_p").style.display = "block";
    
    // Add Control Buttons
    this.addControlButtons();
  },

  addControlButtons() {
    if (document.getElementById('ah-control-buttons')) return;

    const mainPopup = document.getElementById('ah_p');
    if (!mainPopup) return;

    const controlContainer = document.createElement('div');
    controlContainer.id = 'ah-control-buttons';
    controlContainer.style.cssText = `
        position: fixed;
        top: 10px;
        right: 10px;
        z-index: 10000;
        display: flex;
        gap: 10px;
        padding: 8px 10px;
        background: #111827;
        border: 1px solid #374151;
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    // Title
    const titleObj = document.createElement('div');
    titleObj.textContent = 'Waly Proxy: ';
    titleObj.style.cssText = 'color: #f97316; font-size: 13px; font-weight: bold; line-height: 28px; padding-right: 5px;';

    const updateBtn = document.createElement('button');
    updateBtn.id = 'tm-refresh-btn';
    updateBtn.textContent = '🔄 Update Proxy / Refresh';
    updateBtn.title = 'Fetch fresh proxy data from server';
    updateBtn.style.cssText = `
        padding: 6px 12px;
        background: #2563eb;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
    `;
    updateBtn.addEventListener('mouseover', () => updateBtn.style.background = '#1d4ed8');
    updateBtn.addEventListener('mouseout', () => updateBtn.style.background = '#2563eb');
    updateBtn.addEventListener('click', () => {
       updateBtn.textContent = '⏳ Updating...';
       this.verifySession(true);
    });

    const logoutBtn = document.createElement('button');
    logoutBtn.textContent = '🚪 Logout';
    logoutBtn.style.cssText = `
        padding: 6px 12px;
        background: #ef4444;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
    `;
    logoutBtn.addEventListener('mouseover', () => logoutBtn.style.background = '#dc2626');
    logoutBtn.addEventListener('mouseout', () => logoutBtn.style.background = '#ef4444');
    logoutBtn.addEventListener('click', () => this.handleLogout());

    controlContainer.appendChild(titleObj);
    controlContainer.appendChild(updateBtn);
    controlContainer.appendChild(logoutBtn);
    document.body.appendChild(controlContainer);
  },

  showMessage(msg, type = "info") {
    const msgEl = document.getElementById("login-message");
    if (!msgEl) return;
    msgEl.innerHTML = msg;
    msgEl.style.display = "block";
    if (type === "error") {
      msgEl.style.background = "rgba(239, 68, 68, 0.15)";
      msgEl.style.color = "#ef4444";
      msgEl.style.border = "1px solid rgba(239, 68, 68, 0.3)";
    } else if (type === "warning") {
      msgEl.style.background = "rgba(245, 158, 11, 0.15)";
      msgEl.style.color = "#fbbf24";
      msgEl.style.border = "1px solid rgba(245, 158, 11, 0.3)";
    } else {
      msgEl.style.background = "rgba(59, 130, 246, 0.15)";
      msgEl.style.color = "#60a5fa";
      msgEl.style.border = "1px solid rgba(59, 130, 246, 0.3)";
    }
  }
};

document.addEventListener("DOMContentLoaded", () => {
    TM.init();
});

// Expose TM so custom.js or other things can trigger logout and refresh
window.TM = TM;
