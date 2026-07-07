/**
 * DeepSeek Web Search Extension — Background Service Worker
 *
 * Handles Exa API search requests from the content script via
 * chrome.runtime.onMessage. The content script sends SEARCH_REQUEST
 * messages; this worker validates the stored API key, calls the Exa
 * search endpoint, and returns structured results or specific error
 * messages.
 *
 * Chrome MV3: the listener MUST return true to keep the message
 * channel open for the async sendResponse callback.
 *
 * @file background/service-worker.js
 */

// === Constants ===

/** Exa search API endpoint. */
var EXA_API_URL = 'https://api.exa.ai/search';

/** Default number of search results. */
var DEFAULT_NUM_RESULTS = 5;

/** Request timeout in milliseconds. */
var REQUEST_TIMEOUT_MS = 15000;

// === Message Listener ===

/**
 * Handle incoming runtime messages from the content script.
 *
 * @param {*} message — the message payload sent by chrome.runtime.sendMessage
 * @param {chrome.runtime.MessageSender} _sender — sender info (unused)
 * @param {function} sendResponse — callback to reply (accepts one argument)
 * @returns {boolean} true when the response will be sent asynchronously
 */
chrome.runtime.onMessage.addListener(
  /** @type {(message: *, sender: chrome.runtime.MessageSender, sendResponse: function) => boolean} */
  function (message, sender, sendResponse) {
    if (!message || !message.action) {
      return false;
    }

    if (message.action === 'SEARCH_REQUEST') {
      handleSearchRequest(message, sendResponse);
      return true;
    }

    if (message.action === 'GET_TAB_ID') {
      var tabId = sender && sender.tab && sender.tab.id ? sender.tab.id : null;
      sendResponse({ tabId: tabId });
      return false;
    }

    if (message.action === 'INJECT_INTERCEPTOR') {
      var injectTabId = sender && sender.tab && sender.tab.id ? sender.tab.id : null;
      if (!injectTabId) {
        sendResponse({ injected: false });
        return false;
      }
      chrome.scripting.executeScript({
        target: { tabId: injectTabId },
        world: 'MAIN',
        files: ['inject/interceptor.js'],
      }, function () {
        if (chrome.runtime.lastError) {
          sendResponse({ injected: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ injected: true });
      });
      return true;
    }

    return false;
  }
);

// === Request Handler ===

/**
 * Validate API key and initiate Exa search.
 *
 * @param {{ action: string, query: string }} message
 * @param {function} sendResponse
 */
function handleSearchRequest(message, sendResponse) {
  try {
    chrome.storage.sync.get(
      /** @type {string[]} */ ['exaApiKey'],
      /**
       * @param {{ [key: string]: string | undefined }} items
       */
      function (items) {
        try {
          if (chrome.runtime.lastError) {
            sendResponse({
              error: 'Failed to read stored API key: ' + chrome.runtime.lastError.message
            });
            return;
          }

          var apiKey = items['exaApiKey'];

          if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
            sendResponse({
              error: 'API key not configured. Please set your Exa API key in the extension popup.'
            });
            return;
          }

          performSearch(message.query, apiKey.trim(), sendResponse);
        } catch (callbackError) {
          var callbackReason = callbackError instanceof Error ? callbackError.message : String(callbackError);
          sendResponse({
            error: 'Failed to read stored API key: ' + callbackReason
          });
          return;
        }
      }
    );
  } catch (error) {
    var reason = error instanceof Error ? error.message : String(error);
    sendResponse({
      error: 'Failed to read stored API key: ' + reason
    });
    return;
  }
}

// === Exa API Call ===

/**
 * Call the Exa search API and return results.
 *
 * @param {string} query — user-entered search query
 * @param {string} apiKey — validated Exa API key
 * @param {function} sendResponse
 */
function performSearch(query, apiKey, sendResponse) {
  var controller = new AbortController();
  var timeoutId = setTimeout(function () {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  fetch(EXA_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey
    },
    body: JSON.stringify({
      query: query,
      numResults: DEFAULT_NUM_RESULTS,
      type: 'auto',
      contents: {
        text: {
          maxCharacters: 2000
        }
      }
    }),
    signal: controller.signal
  })
    .then(function (response) {
      clearTimeout(timeoutId);

      if (!response.ok) {
        sendResponse({
          error: 'Search API error (status ' + String(response.status) + '). Please check your API key or try again later.'
        });
        return;
      }

      return response.json().then(function (data) {
        /** @type {{ results?: Array<{ title: string, url: string, text: string }> }} */
        var parsed = data;

        if (!parsed.results || !Array.isArray(parsed.results)) {
          sendResponse({
            error: 'Unexpected API response format. Please try again later.'
          });
          return;
        }

        var results = parsed.results.map(function (item) {
          return {
            title: item.title || '',
            url: item.url || '',
            text: item.text || ''
          };
        });

        sendResponse({ results: results });
      });
    })
    .catch(function (error) {
      clearTimeout(timeoutId);

      if (error && error.name === 'AbortError') {
        sendResponse({
          error: 'Search request timed out. Please try again.'
        });
      } else {
        sendResponse({
          error: 'Network error. Please check your connection and try again.'
        });
      }
    });
}
