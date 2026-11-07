// player-worker.js - Background part of the player tab (player.html, opened by ▶ Play when the ⚙ setting says
// "In a new tab"). Loaded at the end of background.js; the popup's own player and its header rules (1001 / 1002)
// are not touched.
//
// The player tab needs the link's Referer (and CORS headers) on its requests, like the popup player gets. Each
// player tab gets a session rule of its own, limited to that tab, so a second player tab or a ▶ Play in the popup
// never changes the headers of a tab that is still playing. The rule goes when the tab closes or leaves the player.
(function () {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return;
  const RULE_BASE = 1400;
  const RULE_SPAN = 200;
  const PLAYER_URL = chrome.runtime.getURL('player.html');
  const ownRule = (r) => r && r.id >= RULE_BASE && r.id < RULE_BASE + RULE_SPAN;
  const ruleOfTab = (rules, tabId) => rules.find((r) => ownRule(r) && r.condition && Array.isArray(r.condition.tabIds) && r.condition.tabIds.includes(tabId));

  // Same Referer / Origin as the popup player uses for this link (see setPreviewRefererRule in background.js)
  const headersFor = (mediaUrl, refererUrl) => {
    const media = new URL(mediaUrl);
    let refOrigin = '';
    let refUrl = '';
    if (/^https?:\/\//i.test(refererUrl || '')) {
      try { refOrigin = new URL(refererUrl).origin; refUrl = refererUrl; } catch (e) {}
    }
    if (!refOrigin) {
      refOrigin = `https://${media.hostname}`;
      refUrl = `${refOrigin}/`;
    }
    return {
      requestHeaders: [
        { header: 'Referer', operation: 'set', value: refUrl },
        { header: 'Origin', operation: 'set', value: refOrigin }
      ],
      responseHeaders: [
        { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
        { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS, POST' },
        { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' }
      ]
    };
  };

  const prepare = async (tabId, mediaUrl, refererUrl) => {
    if (!/^https?:\/\//i.test(mediaUrl || '')) return false;
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    let id = (ruleOfTab(rules, tabId) || {}).id || 0;
    if (!id) {
      const used = new Set(rules.map((r) => r.id));
      for (let i = RULE_BASE; i < RULE_BASE + RULE_SPAN && !id; i++) if (!used.has(i)) id = i;
    }
    if (!id) return false;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{
        id: id,
        priority: 3, // above the popup's rule 1001, which also matches this extension's own requests
        action: { type: 'modifyHeaders', ...headersFor(mediaUrl, refererUrl) },
        condition: { tabIds: [tabId], resourceTypes: ['media', 'xmlhttprequest', 'image', 'other'] }
      }]
    });
    return true;
  };

  const dropRule = async (tabId) => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const mine = ruleOfTab(rules, tabId);
    if (mine) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [mine.id] });
  };

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || request.action !== 'preparePlayerTab') return false;
    const tabId = sender && sender.tab ? sender.tab.id : -1;
    // only this extension's player page may ask
    if (tabId < 0 || typeof sender.url !== 'string' || !sender.url.startsWith(PLAYER_URL)) {
      sendResponse({ ok: false });
      return false;
    }
    prepare(tabId, request.mediaUrl, request.refererUrl)
      .then((ok) => sendResponse({ ok: ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  });

  chrome.tabs.onRemoved.addListener((tabId) => { dropRule(tabId).catch(() => {}); });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url && !changeInfo.url.startsWith(PLAYER_URL)) dropRule(tabId).catch(() => {});
  });
})();
