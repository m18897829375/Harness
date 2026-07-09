/**
 * DeepSeek Web Search Extension — Content Script
 *
 * Injects a "智能搜索" button into DeepSeek's Expert mode textarea toolbar.
 * The button uses data-ralph-web-search for stable event-delegation targeting
 * and follows the smart-search-button-design.md spec for states and styles.
 *
 * @file content.js
 */

// === DOM Selectors (matching OpenCLI clis/deepseek/utils.js) ===

/** DeepSeek composer textarea. */
var TEXTAREA_SELECTOR = 'textarea[placeholder*="DeepSeek"]';

// === Module-Level State ===

/** @type {HTMLButtonElement | null} */
var webSearchButton = null;

/** @type {MutationObserver | null} */
var observer = null;

/** @type {ReturnType<typeof setTimeout> | null} */
var reinsertTimer = null;

/** @type {boolean} Tracks whether an Exa API key is configured in chrome.storage.sync. */
var hasApiKey = false;

/**
 * Tracks whether the smart search toggle is currently active.
 * The button acts as a persistent toggle: a click flips the active state and
 * exposes it via document.body.dataset.ralphSmartSearch for the API interceptor
 * to consume; it no longer triggers handleWebSearch() immediately.
 * @type {boolean}
 */
var isSmartSearchActive = false;

/**
 * Tracks whether the main-world API interceptors have already been installed.
 * Used instead of DOM element checks because the injected <script> is removed
 * immediately after execution.
 * @type {boolean}
 */
var apiInterceptorsInstalled = false;

/**
 * Current button state for the 3-state machine:
 * idle → loading → error (auto-revert after 3s) or back to idle.
 * @type {'idle' | 'loading' | 'error'}
 */
var buttonState = 'idle';

/** @type {ReturnType<typeof setTimeout> | null} Timer handle for error state auto-revert. */
var errorRevertTimer = null;

/**
 * Persists the last known model mode across SPA navigations.
 * History conversation pages (/a/chat/s/<uuid>) do not render div[role='radio']
 * elements, so this fallback is used when radios are absent.
 * Updated every time isExpertMode() finds radio elements on the page.
 * @type {string | null}
 */
var lastKnownMode = null;

/** @type {MutationObserver | null} Observes the button parent to reinsert the button when removed. */
var buttonRemovalObserver = null;

// === SVG Icons ===

/**
 * Globe/search icon SVG string for the "智能搜索" button.
 * 16x16 viewBox with circle, horizontal line, and vertical globe path.
 * Uses currentColor so it inherits the button text color for inactive/active states.
 */
var SMART_SEARCH_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M2 8H14" stroke="currentColor" stroke-width="1.5"/><path d="M8 2C9.5 4 10 6 10 8C10 10 9.5 12 8 14C6.5 12 6 10 6 8C6 6 6.5 4 8 2Z" stroke="currentColor" stroke-width="1.5"/></svg>';

/** Spinner SVG icon for loading state. Wrapped in a span with .web-search-spinner class for CSS rotation animation. */
var SPINNER_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// === Style Injection ===

/**
 * Inject a <style> element into the document head for the smart-search button.
 * Idempotent — does nothing if already injected.
 */
function injectStyles() {
  if (document.getElementById('web-search-styles')) {
    return;
  }

  var style = document.createElement('style');
  style.id = 'web-search-styles';
  style.textContent = [
    '.web-search-btn-smart-search {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  gap: 6px;',
    '  border-radius: 999px;',
    '  padding: 6px 12px;',
    '  font-size: 13px;',
    '  font-weight: 500;',
    '  color: #1f2329;',
    '  background-color: #fff;',
    '  border: 1px solid rgba(0, 0, 0, 0.08);',
    '  cursor: pointer;',
    '  transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;',
    '}',
    '.web-search-btn-smart-search:hover {',
    '  background-color: rgba(91, 108, 249, 0.06);',
    '}',
    '.web-search-btn-smart-search.active {',
    '  color: #5b6cf9;',
    '  background-color: rgba(91, 108, 249, 0.15);',
    '  border-color: rgba(91, 108, 249, 0.35);',
    '}',
    '@keyframes web-search-spin {',
    '  from { transform: rotate(0deg); }',
    '  to { transform: rotate(360deg); }',
    '}',
    '.web-search-btn-loading .web-search-spinner {',
    '  display: inline-flex;',
    '  animation: web-search-spin 0.8s linear infinite;',
    '}',
    '.web-search-btn-loading .web-search-spinner svg {',
    '  display: block;',
    '}',
    '.web-search-btn-error,',
    '.web-search-btn-error:hover {',
    '  background-color: rgba(239, 68, 68, 0.15) !important;',
    '  border-color: rgba(239, 68, 68, 0.4) !important;',
    '  color: #ef4444 !important;',
    '}',
  ].join('\n');
  document.head.appendChild(style);
}

// === Mode Detection ===

/**
 * Check if the current model mode is Expert.
 * Based on OpenCLI selectModel(): radios index 0=Instant, 1=Expert, 2=Vision.
 *
 * @returns {boolean} true when the second div[role="radio"] has aria-checked="true"
 */
function isExpertMode() {
  var radios = document.querySelectorAll('div[role="radio"]');
  /** @type {string | null} */
  var currentMode = lastKnownMode;
  if (radios.length >= 2) {
    // Update lastKnownMode from radio state for fallback on history pages
    currentMode = radios[1].getAttribute('aria-checked') === 'true' ? 'expert' : 'instant';
    lastKnownMode = currentMode;
    return currentMode === 'expert';
  }
  // History conversation pages have no radios — use lastKnownMode fallback
  if (currentMode === 'expert') {
    var toolbar = findToolbarContainer();
    if (toolbar) {
      var toggles = toolbar.querySelectorAll('.ds-toggle-button');
      for (var i = 0; i < toggles.length; i++) {
        var text = toggles[i].textContent || '';
        if (text === '联网搜索' || text.indexOf('搜索') !== -1) {
          console.log('[isExpertMode] detected native quick-mode search toggle:', text);
          return false;
        }
      }
    }
    return true;
  }
  return currentMode === 'expert';
}

// === DOM Helpers ===

/**
 * Find the DeepSeek composer textarea.
 * @returns {HTMLTextAreaElement | null}
 */
function findTextarea() {
  return document.querySelector(TEXTAREA_SELECTOR);
}

/**
 * Find the toolbar container that holds .ds-toggle-button elements near the textarea.
 * Walks up from the textarea until it finds a parent containing toggle buttons.
 *
 * @returns {HTMLElement | null}
 */
function findToolbarContainer() {
  var textarea = findTextarea();
  if (!textarea) {
    return null;
  }

  var container = textarea.parentElement;
  while (container && container !== document.body) {
    if (container.querySelector('.ds-toggle-button')) {
      return container;
    }
    container = container.parentElement;
  }

  // Fallback: when .ds-toggle-button elements are not rendered yet
  // (e.g., during initial page load before React hydrates the toolbar),
  // fall back to textarea.parentElement so the button can still be injected.
  return textarea.parentElement;
}

// === Button Lifecycle ===

/**
 * Create the "智能搜索" button element according to the design spec.
 *
 * @returns {HTMLButtonElement}
 */
function createButton() {
  var btn = document.createElement('button');
  btn.className = 'web-search-btn-smart-search';
  btn.setAttribute('data-ralph-web-search', '');
  btn.setAttribute('aria-label', '智能搜索');
  btn.setAttribute('title', '智能搜索');
  btn.setAttribute('aria-pressed', 'false');
  btn.setAttribute('aria-disabled', 'false');
  btn.setAttribute('aria-busy', 'false');
  btn.type = 'button';
  btn.innerHTML = SMART_SEARCH_ICON_SVG + '<span>智能搜索</span>';
  return btn;
}

/**
 * Inject the "智能搜索" button into the textarea toolbar.
 * Inserts after the last existing .ds-toggle-button, or at container end if none found.
 * Does nothing if not in Expert mode or if button already exists in the DOM.
 * Re-applies the active state when isSmartSearchActive is true.
 */
function injectButton() {
  // Guard: only inject in Expert mode
  if (!isExpertMode()) {
    removeButton();
    return;
  }

  // Guard: don't duplicate
  if (webSearchButton && webSearchButton.isConnected) {
    return;
  }

  var container = findToolbarContainer();
  if (!container) {
    return;
  }

  var btn = createButton();
  var existingToggles = container.querySelectorAll('.ds-toggle-button');

  if (existingToggles.length > 0) {
    var lastToggle = existingToggles[existingToggles.length - 1];
    lastToggle.after(btn);
  } else {
    container.appendChild(btn);
  }

  webSearchButton = btn;

  // Re-apply persistent active state immediately after injection
  if (isSmartSearchActive) {
    webSearchButton.classList.add('active');
    webSearchButton.setAttribute('aria-pressed', 'true');
  }

  setupButtonRemovalObserver();
}

/**
 * Remove the injected button from the DOM and stop observing its parent.
 * Safe to call when button is not injected (no-op).
 * Does NOT reset isSmartSearchActive so the active state persists across removals.
 */
function removeButton() {
  disconnectButtonRemovalObserver();

  if (webSearchButton) {
    webSearchButton.remove();
    webSearchButton = null;
  }

  // Reset button visual-state trackers when the DOM element is removed.
  // isSmartSearchActive is intentionally preserved across SPA navigation
  // and button re-insertion; do NOT clear it here.
  buttonState = 'idle';
  clearTimers();
}

/**
 * Disconnect the SPA navigation MutationObserver.
 * Safe to call when observer is not set up.
 */
function disconnectObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

/**
 * Disconnect the button removal MutationObserver.
 * Safe to call when observer is not set up.
 */
function disconnectButtonRemovalObserver() {
  if (buttonRemovalObserver) {
    buttonRemovalObserver.disconnect();
    buttonRemovalObserver = null;
  }
}

/**
 * Clear all pending timers used by the content script.
 */
function clearTimers() {
  if (reinsertTimer) {
    clearTimeout(reinsertTimer);
    reinsertTimer = null;
  }
  if (errorRevertTimer) {
    clearTimeout(errorRevertTimer);
    errorRevertTimer = null;
  }
}

/**
 * Full teardown: disconnect observers and clear timers.
 * Used when the content script is being unloaded.
 */
function teardown() {
  disconnectObserver();
  disconnectButtonRemovalObserver();
  clearTimers();
}

/**
 * Set up a MutationObserver on the button's direct parent so that if the
 * button is removed (e.g., by a React re-render), it is re-inserted in the same
 * event loop via setTimeout(..., 0). Idempotent: disconnects any previous observer first.
 */
function setupButtonRemovalObserver() {
  disconnectButtonRemovalObserver();

  if (!webSearchButton || !webSearchButton.isConnected) {
    return;
  }

  var parent = webSearchButton.parentElement;
  if (!parent) {
    return;
  }

  buttonRemovalObserver = new MutationObserver(function (mutations) {
    if (webSearchButton && webSearchButton.isConnected) {
      return;
    }

    // Button was removed — re-insert in the same event loop.
    setTimeout(function () {
      injectButton();
    }, 0);
  });

  buttonRemovalObserver.observe(parent, {
    childList: true,
    subtree: true,
  });
}

// === Button State Machine ===

/**
 * Transition the button to loading state.
 * Swaps icon to animated spinner, changes text to "智能搜索中...",
 * sets aria-busy, and keeps the button clickable (aria-disabled="false").
 * No-op if the button is not in the DOM.
 */
function setButtonLoading() {
  if (!webSearchButton || !webSearchButton.isConnected) {
    return;
  }

  // Cancel any pending error revert timer to prevent stale timer from corrupting state.
  if (errorRevertTimer) {
    clearTimeout(errorRevertTimer);
    errorRevertTimer = null;
  }

  buttonState = 'loading';
  webSearchButton.className = 'web-search-btn-smart-search web-search-btn-loading';
  webSearchButton.setAttribute('aria-disabled', 'false');
  webSearchButton.setAttribute('aria-busy', 'true');
  webSearchButton.setAttribute('aria-pressed', 'false');
  webSearchButton.innerHTML = '<span class="web-search-spinner">' + SPINNER_SVG + '</span><span>智能搜索中...</span>';
}

/**
 * Transition the button to error state.
 * Applies red-tint CSS class, changes text to "智能搜索失败",
 * and schedules an auto-revert to idle after 3 seconds.
 * Clears any pending error revert timer before setting a new one.
 * No-op if the button is not in the DOM.
 */
function setButtonError() {
  if (!webSearchButton || !webSearchButton.isConnected) {
    return;
  }

  // Cancel any pending revert timer
  if (errorRevertTimer) {
    clearTimeout(errorRevertTimer);
    errorRevertTimer = null;
  }

  buttonState = 'error';
  webSearchButton.className = 'web-search-btn-smart-search web-search-btn-error';
  webSearchButton.setAttribute('aria-disabled', 'false');
  webSearchButton.setAttribute('aria-busy', 'false');
  webSearchButton.setAttribute('aria-pressed', 'false');
  webSearchButton.innerHTML = SMART_SEARCH_ICON_SVG + '<span>智能搜索失败</span>';

  // Auto-revert to idle after 3 seconds
  errorRevertTimer = setTimeout(function () {
    errorRevertTimer = null;
    setButtonIdle();
  }, 3000);
}

/**
 * Transition the button to idle state.
 * Restores the original icon and "智能搜索" text, removes loading/error
 * CSS classes, clears aria-busy, and re-applies the active class if
 * isSmartSearchActive is true. Keeps the button clickable (aria-disabled="false").
 * Clears any pending error revert timer.
 * No-op if the button is not in the DOM.
 */
function setButtonIdle() {
  if (!webSearchButton || !webSearchButton.isConnected) {
    return;
  }

  // Cancel any pending revert timer
  if (errorRevertTimer) {
    clearTimeout(errorRevertTimer);
    errorRevertTimer = null;
  }

  buttonState = 'idle';
  webSearchButton.className = 'web-search-btn-smart-search';
  webSearchButton.setAttribute('aria-busy', 'false');
  webSearchButton.setAttribute('aria-disabled', 'false');
  webSearchButton.innerHTML = SMART_SEARCH_ICON_SVG + '<span>智能搜索</span>';

  // Re-apply persistent active state if the toggle is still active
  if (isSmartSearchActive) {
    webSearchButton.classList.add('active');
    webSearchButton.setAttribute('aria-pressed', 'true');
  } else {
    webSearchButton.setAttribute('aria-pressed', 'false');
  }

  // Refresh tooltip to match current textarea/API-key state
  updateButtonState();
}

/**
 * Toggle the smart-search active state.
 *
 * Flips the module-level isSmartSearchActive boolean and updates the button
 * DOM class to reflect the active/inactive state. When active, exposes the
 * state via document.body.dataset.ralphSmartSearch so the main-world interceptor
 * can read it without relying on the DOM element.
 *
 * @returns {boolean} the new state after toggling
 */
function toggleSmartSearchActive() {
  isSmartSearchActive = !isSmartSearchActive;

  // Persist the active state synchronously so the main-world interceptor can
  // read it via document.body.dataset.ralphSmartSearch.
  document.body.dataset.ralphSmartSearch = isSmartSearchActive ? 'active' : '';

  if (webSearchButton && webSearchButton.isConnected) {
    if (isSmartSearchActive) {
      webSearchButton.classList.add('active');
      webSearchButton.setAttribute('aria-pressed', 'true');
    } else {
      webSearchButton.classList.remove('active');
      webSearchButton.setAttribute('aria-pressed', 'false');
    }
  }

  return isSmartSearchActive;
}

// === Button State ===

/**
 * Keep the button's tooltip up to date and ensure aria-disabled is always
 * "false" so the button remains clickable in all states.
 */
function updateButtonState() {
  if (!webSearchButton || !webSearchButton.isConnected) {
    return;
  }

  var textarea = findTextarea();
  var hasContent = !!(textarea && textarea.value.trim().length > 0);

  // The button is always clickable per the smart-search design spec.
  webSearchButton.setAttribute('aria-disabled', 'false');

  // Update tooltip based on the reason the user might not see a search happen
  if (!hasContent) {
    webSearchButton.setAttribute('title', '输入内容后，点击即可智能搜索');
  } else if (!hasApiKey) {
    webSearchButton.setAttribute('title', '配置 Exa API Key 后，点击即可智能搜索');
  } else {
    webSearchButton.setAttribute('title', '智能搜索');
  }
}

// === Search Handler ===

/**
 * Handle a Web Search request triggered by the main-world interceptor.
 *
 * Dispatches a web-search request to the service worker via SEARCH_REQUEST,
 * then forwards the formatted results back to the main world via a
 * 'ralph-web-search-results-ready' CustomEvent. This story does NOT perform
 * any auto-send, textarea injection, or highlighting; those actions are reserved
 * for the new interceptor-driven flow and are removed in US-F05.
 *
 * Guards:
 * - Empty textarea / missing API key: ignored (button already disabled)
 * - Double-click during loading: ignored (buttonState === 'loading')
 * - Stale callbacks after SPA navigation: ignored (button isConnected check)
 *
 * @param {string} [query] - optional query to search; defaults to current textarea value
 * @see setButtonLoading, setButtonError, setButtonIdle
 */
function handleWebSearch(query) {
  var textarea = findTextarea();
  if (!textarea) {
    return;
  }

  var searchQuery = typeof query === 'string' && query.trim() ? query : textarea.value.trim();
  if (!searchQuery) {
    return;
  }

  if (!hasApiKey) {
    return;
  }

  // Guard: prevent double-click / spam during loading state
  if (buttonState === 'loading') {
    return;
  }

  // Enter loading state
  setButtonLoading();

  try {
    chrome.runtime.sendMessage(
      { action: 'SEARCH_REQUEST', query: searchQuery },
      /**
       * @param {{ results?: Array<{ title: string, url: string, text: string }>, error?: string }} response
       */
      function (response) {
        // Stale-callback guard: button may have been destroyed
        // and re-injected by SPA navigation during the async call.
        if (!webSearchButton || !webSearchButton.isConnected) {
          return;
        }

        // chrome.runtime.lastError means the background worker is unavailable.
        // Dispatch an empty results-ready event so the interceptor releases the
        // original request immediately rather than waiting for the 15s timeout.
        if (chrome.runtime.lastError) {
          setButtonError();
          document.dispatchEvent(new CustomEvent('ralph-web-search-results-ready', {
            detail: null,
          }));
          return;
        }

        if (!response) {
          setButtonError();
          document.dispatchEvent(new CustomEvent('ralph-web-search-results-ready', {
            detail: null,
          }));
          return;
        }

        if (response.error) {
          setButtonError();
          document.dispatchEvent(new CustomEvent('ralph-web-search-results-ready', {
            detail: null,
          }));
          return;
        }

        if (response.results && response.results.length > 0) {
          var formattedText = formatSearchResults(response.results, searchQuery);
          document.dispatchEvent(new CustomEvent('ralph-web-search-results-ready', {
            detail: formattedText,
          }));
          setButtonIdle();
        } else {
          // Zero results - dispatch an empty ready event so the interceptor
          // releases the original request immediately, unchanged.
          document.dispatchEvent(new CustomEvent('ralph-web-search-results-ready', {
            detail: null,
          }));
          setButtonIdle();
        }
      }
    );
  } catch (error) {
    // chrome.runtime.sendMessage can throw synchronously when the extension
    // context is no longer available (e.g., service worker terminated or
    // extension reloaded). Restore the button immediately without showing an
    // error state and release the interceptor so the original request proceeds.
    setButtonIdle();
    document.dispatchEvent(new CustomEvent('ralph-web-search-results-ready', {
      detail: null,
    }));
  }
}

// === API Key Status ===

/**
 * Check whether an Exa API key is configured in chrome.storage.sync.
 * Updates the hasApiKey flag and refreshes the button state.
 */
function checkApiKeyStatus() {
  try {
    chrome.storage.sync.get(
      /** @type {string[]} */ ['exaApiKey'],
      /**
       * @param {{ [key: string]: string | undefined }} items
       */
      function (items) {
        if (chrome.runtime.lastError) {
          // Read failed — keep current state (safe default: button stays disabled)
          return;
        }

        var key = items['exaApiKey'];
        var wasConfigured = hasApiKey;

        hasApiKey = !!(key && typeof key === 'string' && key.trim() !== '');

        // Only update the button if the state changed, to avoid unnecessary DOM writes
        if (hasApiKey !== wasConfigured) {
          updateButtonState();
        }
      }
    );
  } catch (error) {
    // chrome.storage.sync.get can throw synchronously when the extension context is
    // invalid (e.g., extension reloaded or context invalidated). Preserve the current
    // hasApiKey state so the button remains disabled by default.
    return;
  }
}

/**
 * Listen for API key changes from the extension popup.
 * When the user saves or clears the key in the popup, chrome.storage.sync
 * fires this event, allowing the content script to react immediately.
 */
chrome.storage.onChanged.addListener(
  /**
   * @param {Record<string, chrome.storage.StorageChange>} changes
   * @param {string} areaName
   */
  function (changes, areaName) {
    if (areaName !== 'sync') {
      return;
    }

    if (!changes['exaApiKey']) {
      return;
    }

    var change = changes['exaApiKey'];
    var newValue = change.newValue;

    hasApiKey = !!(newValue && typeof newValue === 'string' && newValue.trim() !== '');
    updateButtonState();
  }
);

// === SPA Navigation Handling ===

/**
 * Handle DOM mutations that may indicate SPA navigation or mode switching.
 * Debounced to batch multiple mutations from a single React re-render.
 */
function handleDomMutation() {
  if (reinsertTimer) {
    clearTimeout(reinsertTimer);
  }

  // Check radios immediately to decide strategy
  var radios = document.querySelectorAll('div[role="radio"]');

  if (radios.length === 0) {
    // No radios found — may be a history conversation page.
    // Do NOT remove the button; wait 300ms and retry.
    // Existing button stays visible if present.
    reinsertTimer = setTimeout(function () {
      var retryRadios = document.querySelectorAll('div[role="radio"]');
      if (retryRadios.length === 0 && lastKnownMode === null) {
        // Still no radios and never initialized — safe to remove
        removeButton();
      } else {
        // Radios now exist OR lastKnownMode fallback available — re-evaluate
        if (isExpertMode()) {
          if (!webSearchButton || !webSearchButton.isConnected) {
            injectButton();
          }
        } else {
          removeButton();
        }
      }
    }, 300);
  } else {
    // Radios exist — normal debounce path: re-evaluate after 300ms
    reinsertTimer = setTimeout(function () {
      if (isExpertMode()) {
        // Button may have been destroyed by React re-render — re-inject
        if (!webSearchButton || !webSearchButton.isConnected) {
          injectButton();
        }
      } else {
        // Not in Expert mode — clean up
        removeButton();
      }
    }, 300);
  }
}

/**
 * Setup a MutationObserver to detect SPA route changes and mode switches.
 * Observes document.body with childList + subtree for maximum coverage,
 * since DeepSeek uses CSS modules with hashed class names.
 */
function setupObserver() {
  if (observer) {
    return;
  }

  observer = new MutationObserver(handleDomMutation);

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// === Event Delegation ===

/**
 * Listen for textarea input events via event delegation on document.body.
 * This survives React re-renders because the listener is on a stable ancestor,
 * not on the textarea element itself (which may be replaced).
 *
 * @param {Event} event
 */
function onTextareaInput(event) {
  var target = /** @type {HTMLElement} */ (event.target);
  if (target.matches && target.matches(TEXTAREA_SELECTOR)) {
    updateButtonState();
  }
}

/**
 * Listen for Web Search button clicks via event delegation.
 * When the injected button (or its child elements) is clicked,
 * toggle the smart-search active state and initiate the search flow
 * only when toggling from inactive to active.
 *
 * @param {Event} event
 */
function onButtonClick(event) {
  var target = /** @type {HTMLElement} */ (event.target);

  // Walk up from the clicked element to find the button.
  // Uses the data-ralph-web-search attribute for stable targeting
  // that survives React DOM replacement (CSS attribute selectors on
  // .ds-toggle-button would fail after React re-renders the toolbar).
  var btn = target.closest('[data-ralph-web-search]');
  if (!btn) {
    return;
  }

  // Toggle the smart-search active state. The click no longer triggers an
  // immediate search; activation is consumed later by the API interceptor.
  toggleSmartSearchActive();
}

// === API Request Interception ===

/**
 * Inject a script into the page's main world to monkey-patch window.fetch
 * and XMLHttpRequest.prototype.send. Because Manifest V3 content scripts run
 * in an isolated JavaScript world, direct monkey-patching of content.js'
 * window.fetch would not intercept requests made by DeepSeek's own page code.
 *
 * The interceptor script must be injected from the service worker (via
 * chrome.scripting.executeScript) because the chrome.scripting API is not
 * exposed inside the content-script world. The content script therefore always
 * asks the service worker to perform the MAIN-world injection by sending
 * { action: 'INJECT_INTERCEPTOR' }.
 *
 * The injected script listens for a CustomEvent from the content script that
 * carries formatted search results, then prepends them to the prompt field of
 * the next intercepted POST /api/v0/chat/completion request.
 */
function installApiInterceptors() {
  if (apiInterceptorsInstalled) {
    return;
  }

  try {
    chrome.runtime.sendMessage({ action: 'INJECT_INTERCEPTOR' }, function () {
      if (chrome.runtime.lastError) {
        // Service-worker injection failed; keep flag false so we can retry later.
        return;
      }

      apiInterceptorsInstalled = true;
    });
  } catch (error) {
    // INJECT_INTERCEPTOR sendMessage failed synchronously; retry later.
  }
}

// === Initialization ===

/**
 * Listen for the main-world interceptor to request a web search.
 * When the interceptor dispatches 'ralph-web-search-trigger' it carries the
 * original prompt in event.detail.prompt; we start a search and will later
 * dispatch 'ralph-web-search-results-ready' back to the main world.
 *
 * @param {Event} event
 */
function onWebSearchTrigger(event) {
  var detail = event && /** @type {CustomEvent} */ (event).detail;
  var prompt = detail && typeof detail.prompt === 'string' ? detail.prompt : '';
  handleWebSearch(prompt);
}

/**
 * Initialize the content script.
 * Waits for DOM readiness, injects the button if in Expert mode,
 * and sets up the MutationObserver + input listener.
 */
function init() {
  injectStyles();
  installApiInterceptors();
  injectButton();
  setupObserver();
  document.body.addEventListener('input', onTextareaInput);
  document.body.addEventListener('click', onButtonClick);
  document.addEventListener('ralph-web-search-trigger', onWebSearchTrigger);
  window.addEventListener('beforeunload', teardown);
  checkApiKeyStatus();
}

// === Bootstrap ===

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
