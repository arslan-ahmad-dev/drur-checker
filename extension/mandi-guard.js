/*
 * mandi-guard.js — ToolsMandi auth layer (Markhor-style proxy architecture).
 *
 *   1. All ahrefs.com/v4/* calls redirect to toolsmandi.com/bar/v4/ (mandi-rules.json)
 *   2. X-TM-Token header carries the portal session — real Ahrefs token stays on server
 *   3. ahToken in storage = tm_session_token (sentinel), NOT the raw Ahrefs bearer
 *   4. Blocks credential wipe while TM session is active
 */

importScripts('event.js');

(() => {
  const API_BASE = 'https://toolsmandi.com/bar';
  const PROXY_V4_REGEX = '^https://toolsmandi\\.com/bar/v4/.*';
  const PROXY_V4_FILTER = '||toolsmandi.com/bar/v4/';
  const PROXY_RES_TYPES = ['xmlhttprequest', 'other', 'main_frame', 'sub_frame'];
  const AUTH_RULE_ID = 2000;
  const TOKEN_EXPIRES_IN = 315360000;
  const ALARM_NAME = 'mandi-auth-sync';
  const AHREFS_V4 = 'https://ahrefs.com/v4';

  const getLocal = (keys) => new Promise((res) => chrome.storage.local.get(keys, res));
  const setLocal = (obj) => new Promise((res) => chrome.storage.local.set(obj, res));

  const logs = [];
  function mask(t) {
    if (!t) return '(none)';
    const s = String(t);
    return s.length <= 12 ? '(len ' + s.length + ')' : s.slice(0, 6) + '…' + s.slice(-4);
  }
  function log(...args) {
    const ts = new Date().toISOString().slice(11, 23);
    const line = '[mandi-guard ' + ts + '] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    logs.push(line);
    if (logs.length > 200) logs.shift();
    try { console.log(line); } catch (e) {}
  }

  function normalizeUserData(ud) {
    const out = ud && typeof ud === 'object' ? { ...ud } : {};
    out.keywordsLimit = 0;
    out.siteExplorerLimit = 0;
    if (!out.email) out.email = 'user@toolsmandi.com';
    if (!out.workspaceName) out.workspaceName = 'ToolsMandi';
    return out;
  }

  let lastAuthTok = null;
  async function setTokenHeaderRule(token) {
    if (token === lastAuthTok) return;
    lastAuthTok = token;
    try {
      if (token) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: [AUTH_RULE_ID],
          addRules: [{
            id: AUTH_RULE_ID,
            priority: 100,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [{ header: 'X-TM-Token', operation: 'set', value: token }],
            },
            condition: {
              regexFilter: PROXY_V4_REGEX,
              resourceTypes: PROXY_RES_TYPES,
            },
          }],
        });
        log('X-TM-Token rule SET', mask(token));
      } else {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [AUTH_RULE_ID] });
        log('X-TM-Token rule REMOVED');
      }
    } catch (e) {
      log('setTokenHeaderRule error:', e.message);
      try {
        if (token) {
          await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [AUTH_RULE_ID],
            addRules: [{
              id: AUTH_RULE_ID,
              priority: 100,
              action: {
                type: 'modifyHeaders',
                requestHeaders: [{ header: 'X-TM-Token', operation: 'set', value: token }],
              },
              condition: { urlFilter: PROXY_V4_FILTER, resourceTypes: PROXY_RES_TYPES },
            }],
          });
          log('X-TM-Token rule SET (urlFilter fallback)', mask(token));
        }
      } catch (e2) {
        log('urlFilter fallback failed:', e2.message);
      }
    }
  }

  async function syncToolbarAuth(reason) {
    const store = await getLocal(['tm_session_token', 'ahToken', 'ahIsAuth3', 'ahUserData']);
    const sessionToken = store.tm_session_token || '';
    log('syncToolbarAuth(' + reason + ') session=' + (sessionToken ? mask(sessionToken) : 'no'));

    await setTokenHeaderRule(sessionToken);

    if (!sessionToken) {
      if (store.ahIsAuth3 || (store.ahToken && store.ahToken.accessToken)) {
        await setLocal({
          ahToken: { accessToken: undefined, expiresIn: undefined },
          ahIsAuth3: false,
        });
      }
      return { authed: false, reason };
    }

    const curToken = (store.ahToken && store.ahToken.accessToken) || '';
    const userData = normalizeUserData(store.ahUserData);

    await setLocal({
      ahToken: { accessToken: sessionToken, expiresIn: TOKEN_EXPIRES_IN },
      ahIsAuth3: true,
      ahIsEnabled: true,
      ahUserData: userData,
      sessionDataUpdatedAt: Date.now(),
      tm_proxy_mode: true,
    });
    await new Promise((res) => chrome.storage.local.remove(
      ['ah_token', 'tm_force_direct', 'tm_credential_source'],
      res
    ));

    if (curToken !== sessionToken || store.ahIsAuth3 !== true) {
      log('toolbar auth synced with session token');
    }

    return { authed: true, reason };
  }

  async function apiPost(path, body) {
    const response = await fetch(`${API_BASE}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let jsonText = text;
    const jsonStart = text.indexOf('{');
    if (jsonStart > 0) jsonText = text.substring(jsonStart);
    return JSON.parse(jsonText);
  }

  async function resyncCredentials(reason) {
    const result = await syncToolbarAuth(reason);
    if (!result.authed) return { ok: false, reason: 'no-session' };

    const store = await getLocal(['tm_session_token']);
    try {
      const resp = await apiPost('mandibar_api.php', {
        action: 'heartbeat',
        session_token: store.tm_session_token,
      });
      if (resp.ahrefs_credentials && resp.ahrefs_credentials.ahUserData) {
        await setLocal({
          ahUserData: normalizeUserData(resp.ahrefs_credentials.ahUserData),
        });
        log('ahUserData synced from DB credential');
      }
    } catch (e) {
      log('heartbeat ping skipped:', e.message);
    }

    return { ok: true, reason };
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.tm_session_token) {
      syncToolbarAuth('session-change');
      return;
    }

    if (changes.tm_session_token === undefined) {
      const authDropped =
        (changes.ahIsAuth3 && changes.ahIsAuth3.oldValue === true && changes.ahIsAuth3.newValue === false) ||
        (changes.ahToken &&
          changes.ahToken.oldValue &&
          changes.ahToken.oldValue.accessToken &&
          !(changes.ahToken.newValue && changes.ahToken.newValue.accessToken));

      if (authDropped) {
        getLocal(['tm_session_token']).then((s) => {
          if (s.tm_session_token) syncToolbarAuth('storage-watch');
        });
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'mandi:resync' || msg.type === 'mandi:sync') {
      resyncCredentials(msg.reason || 'message').then(sendResponse);
      return true;
    }
    if (msg.type === 'mandi:status') {
      getLocal(['tm_session_token', 'ahIsAuth3', 'ahToken', 'ahUserData']).then(async (s) => {
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        sendResponse({
          session: !!s.tm_session_token,
          authed: !!(s.ahIsAuth3 && s.ahToken && s.ahToken.accessToken),
          proxyMode: true,
          email: s.ahUserData && s.ahUserData.email,
          dynamicRuleIds: rules.map((r) => r.id),
        });
      });
      return true;
    }
  });

  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === ALARM_NAME) syncToolbarAuth('alarm');
  });

  try {
    if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.onRuleMatchedDebug) {
      chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
        try {
          const r = info.request || {};
          log('DNR rule#' + info.rule.ruleId + ' matched', (r.method || '') + ' ' + String(r.url || '').slice(0, 120));
        } catch (e) {}
      });
    }
  } catch (e) {}

  chrome.runtime.onInstalled.addListener(() => syncToolbarAuth('installed'));
  chrome.runtime.onStartup.addListener(() => syncToolbarAuth('startup'));

  let lastResyncAt = 0;
  self.mandiResync = () => {
    const now = Date.now();
    if (now - lastResyncAt < 30000) return;
    lastResyncAt = now;
    syncToolbarAuth('api-auth-failure');
  };
  self.mandiSync = () => syncToolbarAuth('manual');
  self.mandiLogs = () => { console.log(logs.join('\n')); return logs; };
  self.mandiStatus = async () => {
    const store = await getLocal(['tm_session_token', 'ahIsAuth3', 'ahToken', 'ahUserData']);
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const out = {
      session: mask(store.tm_session_token),
      ahIsAuth3: store.ahIsAuth3,
      ahToken: mask(store.ahToken && store.ahToken.accessToken),
      dynamicRuleIds: rules.map((r) => r.id),
      ahUserData: store.ahUserData,
    };
    console.log('[mandi status]', out);
    return out;
  };
  self.mandiDiag = async (target) => {
    target = target || 'buyahref.com';
    const url = AHREFS_V4 + '/tbGetHeaderV3?input=' + encodeURIComponent(JSON.stringify({ target }));
    log('mandiDiag GET ' + url);
    try {
      const resp = await fetch(url, { method: 'GET' });
      const body = await resp.text();
      const res = { status: resp.status, finalUrl: resp.url, redirected: resp.redirected, body: body.slice(0, 800) };
      log('mandiDiag RESULT', JSON.stringify(res));
      console.log('[mandi diag]', res);
      return res;
    } catch (e) {
      log('mandiDiag ERROR ' + e.message);
      return { error: e.message };
    }
  };

  log('loaded (proxy mode)');
  syncToolbarAuth('boot');
})();
