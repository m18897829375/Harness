/**
 * DeepSeek Web Search Extension - Main-World API Interceptor
 *
 * Runs in the page's MAIN world via chrome.scripting.executeScript.
 * Monkey-patches window.fetch and XMLHttpRequest.prototype.send so that,
 * when the smart-search toggle is active, the next POST to
 * /api/v0/chat/completion is held while the isolated content script performs a
 * web search. Results are passed back via a main-world CustomEvent
 * ('ralph-web-search-results-ready'). When valid formatted text is received,
 * it is prepended to the original prompt and the request is released with the
 * modified body. When results are null/empty, when the content script signals
 * failure, or after a 15-second timeout, the request is released with the
 * original prompt unchanged (silent fallback).
 *
 * Communication with the isolated content script uses CustomEvents only;
 * no chrome.* APIs are available in the MAIN world.
 *
 * @file inject/interceptor.js
 */

(function () {
  var TARGET_URL = '/api/v0/chat/completion';
  var TRIGGER_EVENT = 'ralph-web-search-trigger';
  var RESULTS_EVENT = 'ralph-web-search-results-ready';
  var HOLD_TIMEOUT_MS = 15000;
  var METHOD_KEY = '__webSearchMethod_' + Math.random().toString(36).slice(2);
  var URL_KEY = '__webSearchUrl_' + Math.random().toString(36).slice(2);

  /**
   * Signal that the interceptor has been installed in the main world.
   * Used by verification scripts to confirm injection succeeded.
   */
  /** @type {any} */
  var anyWindow = window;
  anyWindow.__ralphInterceptorReady = true;

  var originalFetch = window.fetch;
  var originalXhrOpen = XMLHttpRequest.prototype.open;
  var originalXhrSend = XMLHttpRequest.prototype.send;

  /**
   * Check whether smart-search is currently active.
   * The active state is set by the content-script button via
   * document.body.dataset.ralphSmartSearch and is intentionally persistent
   * across SPA navigation and interception cycles.
   *
   * @returns {boolean}
   */
  function isSmartSearchActive() {
    return document.body && document.body.dataset.ralphSmartSearch === 'active';
  }

  /**
   * Extract the original prompt from a POST request body.
   *
   * @param {string} bodyString
   * @returns {string | null}
   */
  function extractPrompt(bodyString) {
    try {
      var body = JSON.parse(bodyString);
      if (body && typeof body.prompt === 'string') {
        return body.prompt;
      }
    } catch (e) {
      // Not JSON or malformed — cannot intercept.
    }
    return null;
  }

  /**
   * Build a new request body with search results prepended to the prompt.
   *
   * @param {string} bodyString
   * @param {string} originalPrompt
   * @param {string} searchResults
   * @returns {string}
   */
  function buildInjectedBody(bodyString, originalPrompt, searchResults) {
    return bodyString.replace(
      JSON.stringify(originalPrompt),
      JSON.stringify(searchResults + '\n\n' + originalPrompt)
    );
  }

  /**
   * Hold a request until search results are ready, then inject them into the
   * prompt field. Falls back to the original request after a timeout or if the
   * content script fails to dispatch results.
   *
   * @param {string} originalBody
   * @param {function(string | undefined): void} releaseOriginal
   */
  function holdUntilResultsReady(originalBody, releaseOriginal) {
    var originalPrompt = extractPrompt(originalBody);

    /** @type {ReturnType<typeof setTimeout> | null} */
    var timeoutId = null;

    /** @type {(function(): void) | null} */
    var cleanup = null;

    /**
     * Release the request once, cleaning up listeners and timers.
     *
     * @param {string} [bodyToSend]
     */
    function release(bodyToSend) {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (cleanup) {
        cleanup();
        cleanup = null;
      }
      releaseOriginal(bodyToSend !== undefined ? bodyToSend : originalBody);
    }

    return /** @type {Promise<void>} */ (new Promise(function (resolve) {
      /**
       * Listener for the content script's results-ready event.
       * @param {Event} event
       */
      function onResultsReady(event) {
        var detail = event && /** @type {CustomEvent} */ (event).detail;
        if (!detail) {
          release(originalBody);
          resolve();
          return;
        }

        var searchResults = typeof detail === 'string' ? detail : String(detail);
        if (originalPrompt !== null && searchResults) {
          try {
            var injectedBody = buildInjectedBody(originalBody, originalPrompt, searchResults);
            release(injectedBody);
            resolve();
            return;
          } catch (e) {
            console.warn('[WebSearch] Failed to inject search results:', e);
          }
        }

        release(originalBody);
        resolve();
      }

      document.addEventListener(RESULTS_EVENT, onResultsReady, { once: true });

      timeoutId = setTimeout(function () {
        cleanup = function () {};
        document.removeEventListener(RESULTS_EVENT, onResultsReady);
        release(originalBody);
        resolve();
      }, HOLD_TIMEOUT_MS);

      cleanup = function () {
        document.removeEventListener(RESULTS_EVENT, onResultsReady);
      };
    }));
  }

  /**
   * Determine whether a request URL + method should be intercepted.
   *
   * @param {string} url
   * @param {string} method
   * @returns {boolean}
   */
  function shouldIntercept(url, method) {
    return isSmartSearchActive() &&
      typeof url === 'string' &&
      url.indexOf(TARGET_URL) !== -1 &&
      method === 'POST';
  }

  /**
   * Monkey-patch window.fetch to hold the DeepSeek completion request when
   * smart search is active, dispatch a search-trigger event, and release the
   * request only after search results are injected or a fallback occurs.
   *
   * @param {URL | RequestInfo} url
   * @param {RequestInit} [options]
   * @returns {Promise<Response>}
   */
  window.fetch = function (url, options) {
    options = options || {};

    var urlString = typeof url === 'string' ? url : String(url);
    var method = (options.method || 'GET').toUpperCase();

    if (!shouldIntercept(urlString, method)) {
      return originalFetch.call(this, url, options);
    }

    var bodyString = typeof options.body === 'string' ? options.body : '';
    if (!bodyString) {
      return originalFetch.call(this, url, options);
    }

    var originalPrompt = extractPrompt(bodyString);
    if (originalPrompt === null) {
      return originalFetch.call(this, url, options);
    }

    // Dispatch the search trigger so the content script can perform a search.
    document.dispatchEvent(new CustomEvent(TRIGGER_EVENT, {
      detail: { prompt: originalPrompt }
    }));

    // Asynchronously hold the request until results are ready or fallback.
    return new Promise(function (resolve, reject) {
      holdUntilResultsReady(bodyString, function (bodyToSend) {
        /** @type {RequestInit} */
        var newOptions = { body: bodyToSend };
        var optionKeys = Object.keys(options);
        for (var i = 0; i < optionKeys.length; i++) {
          var key = optionKeys[i];
          if (key !== 'body') {
            /** @type {any} */
            var src = options;
            /** @type {any} */
            var dst = newOptions;
            dst[key] = src[key];
          }
        }
        originalFetch.call(window, url, newOptions).then(resolve, reject);
      });
    });
  };

  /**
   * Capture the HTTP method and URL from XMLHttpRequest.open.
   *
   * @param {string} method
   * @param {string | URL} url
   * @param {boolean} [async]
   * @param {string | null} [username]
   * @param {string | null} [password]
   */
  XMLHttpRequest.prototype.open = function (method, url, async, username, password) {
    /** @type {any} */
    var self = this;
    self[METHOD_KEY] = method;
    self[URL_KEY] = url;
    return originalXhrOpen.call(this, method, url, async === undefined ? true : async, username, password);
  };

  /**
   * Monkey-patch XMLHttpRequest.prototype.send to hold the DeepSeek completion
   * request when smart search is active, then release it after injection or
   * fallback by calling the original send with the modified or original body.
   *
   * @param {Document | XMLHttpRequestBodyInit | null | undefined} [body]
   */
  XMLHttpRequest.prototype.send = function (body) {
    /** @type {any} */
    var self = this;
    var method = (self[METHOD_KEY] || 'GET').toUpperCase();
    var url = String(self[URL_KEY] || '');

    var bodyString = typeof body === 'string' ? body : '';

    if (!bodyString || !shouldIntercept(url, method)) {
      return originalXhrSend.call(this, body);
    }

    var originalPrompt = extractPrompt(bodyString);
    if (originalPrompt === null) {
      return originalXhrSend.call(this, body);
    }

    document.dispatchEvent(new CustomEvent(TRIGGER_EVENT, {
      detail: { prompt: originalPrompt }
    }));

    var selfRef = this;
    holdUntilResultsReady(bodyString, function (bodyToSend) {
      originalXhrSend.call(selfRef, bodyToSend);
    });
  };
})();
