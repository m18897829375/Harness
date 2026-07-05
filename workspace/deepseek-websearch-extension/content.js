/**
 * DeepSeek Web Search Extension — Content Script
 *
 * Injects a "Web Search" button into DeepSeek's Expert mode textarea toolbar.
 * Uses div[role="radio"] for model detection and .ds-toggle-button for visual
 * consistency (selectors from OpenCLI clis/deepseek/utils.js).
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
 * Current button state for the 4-state machine:
 * idle → loading → success (back to idle) or error (auto-revert after 3s).
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
 * @type {null | 'expert' | 'instant'}
 */
var lastKnownMode = null;

// === SVG Icon ===

/** Globe/search icon SVG string for the Web Search button. */
var WEB_SEARCH_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M2 8H14" stroke="currentColor" stroke-width="1.5"/><path d="M8 2C9.5 4 10 6 10 8C10 10 9.5 12 8 14C6.5 12 6 10 6 8C6 6 6.5 4 8 2Z" stroke="currentColor" stroke-width="1.5"/></svg>';

/** Spinner SVG icon for loading state. Wrapped in a span with .web-search-spinner class for CSS rotation animation. */
var SPINNER_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// === Style Injection ===

/**
 * Inject a <style> element into the document head for button state classes.
 * Idempotent — does nothing if already injected.
 */
function injectStyles() {
  if (document.getElementById('web-search-styles')) {
    return;
  }

  var style = document.createElement('style');
  style.id = 'web-search-styles';
  style.textContent = [
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
  if (radios.length >= 2) {
    // Update lastKnownMode from radio state for fallback on history pages
    lastKnownMode = radios[1].getAttribute('aria-checked') === 'true' ? 'expert' : 'instant';
    return lastKnownMode === 'expert';
  }
  // History conversation pages have no radios — use lastKnownMode fallback
  console.log('[WebSearch] isExpertMode: lastKnownMode=' + lastKnownMode + ', radios.length=' + radios.length + ', using fallback');
  return lastKnownMode === 'expert';
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
 * Create the Web Search button element.
 * Reuses .ds-toggle-button class for visual consistency with native toggles.
 *
 * @returns {HTMLButtonElement}
 */
function createButton() {
  var btn = document.createElement('button');
  btn.className = 'ds-toggle-button web-search-btn';
  btn.setAttribute('data-ralph-web-search', '');
  btn.setAttribute('aria-disabled', 'true');
  btn.setAttribute('aria-label', 'Web 搜索');
  btn.setAttribute('title', 'Web 搜索 — 通过 Exa API 搜索网络');
  btn.type = 'button';
  btn.innerHTML = WEB_SEARCH_ICON_SVG + '<span>Web搜索</span>';
  return btn;
}

/**
 * Inject the Web Search button into the textarea toolbar.
 * Inserts after the last existing .ds-toggle-button, or at container end if none found.
 * Does nothing if not in Expert mode or if button already exists in the DOM.
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

  // Apply initial disabled state
  updateButtonState();
}

/**
 * Remove the injected button from the DOM.
 * Safe to call when button is not injected (no-op).
 */
function removeButton() {
  if (webSearchButton) {
    webSearchButton.remove();
    webSearchButton = null;
  }

  // Reset button state trackers when button is removed.
  // The active smart-search state is intentionally preserved across SPA
  // navigation and button re-insertion; do NOT clear
  // document.body.dataset.ralphSmartSearch here.
  isSmartSearchActive = false;
  buttonState = 'idle';
  if (errorRevertTimer) {
    clearTimeout(errorRevertTimer);
    errorRevertTimer = null;
  }
}

// === Button State Machine ===

/**
 * Transition the button to loading state.
 * Swaps icon to animated spinner, changes text to "搜索中...",
 * disables the button, and sets aria-busy.
 * No-op if the button is not in the DOM.
 */
function setButtonLoading() {
  if (!webSearchButton || !webSearchButton.isConnected) {
    return;
  }

  buttonState = 'loading';
  webSearchButton.classList.add('web-search-btn-loading');
  webSearchButton.classList.remove('web-search-btn-error');
  webSearchButton.setAttribute('aria-disabled', 'true');
  webSearchButton.setAttribute('aria-busy', 'true');
  webSearchButton.innerHTML = '<span class="web-search-spinner">' + SPINNER_SVG + '</span><span>搜索中...</span>';
}

/**
 * Transition the button to error state.
 * Applies red-tint CSS class, changes text to "搜索失败",
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
  webSearchButton.classList.remove('web-search-btn-loading');
  webSearchButton.classList.add('web-search-btn-error');
  webSearchButton.setAttribute('aria-disabled', 'true');
  webSearchButton.setAttribute('aria-busy', 'false');
  webSearchButton.innerHTML = WEB_SEARCH_ICON_SVG + '<span>搜索失败</span>';

  // Auto-revert to idle after 3 seconds
  errorRevertTimer = setTimeout(function () {
    errorRevertTimer = null;
    setButtonIdle();
  }, 3000);
}

/**
 * Transition the button to idle state.
 * Restores the original icon and "Web搜索" text, removes loading/error
 * CSS classes, clears aria-busy, and delegates enabled/disabled to
 * updateButtonState() (which checks API key + textarea content).
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
  webSearchButton.classList.remove('web-search-btn-loading');
  webSearchButton.classList.remove('web-search-btn-error');
  webSearchButton.setAttribute('aria-busy', 'false');
  webSearchButton.innerHTML = WEB_SEARCH_ICON_SVG + '<span>Web搜索</span>';

  // Restore the correct enabled/disabled state based on API key + textarea content
  updateButtonState();
}

/**
 * Toggle the smart-search active state.
 *
 * Flips the module-level isSmartSearchActive boolean and updates the button
 * DOM class to reflect the active/inactive state. The class name is only a
 * state hook for external observers; no styles, icons, or visual attributes
 * are changed here.
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
 * Toggle the button's aria-disabled attribute based on:
 * 1. Whether an Exa API key is configured (checked via chrome.storage.sync)
 * 2. Whether the textarea has content
 *
 * The button is only enabled when BOTH conditions are met.
 * Uses event delegation so it works even after React re-renders replace DOM elements.
 */
function updateButtonState() {
  if (!webSearchButton || !webSearchButton.isConnected) {
    return;
  }

  var textarea = findTextarea();
  var hasContent = !!(textarea && textarea.value.trim().length > 0);
  var enabled = hasContent && hasApiKey;

  webSearchButton.setAttribute('aria-disabled', enabled ? 'false' : 'true');

  // Update tooltip based on the reason the button is disabled
  if (!hasApiKey) {
    webSearchButton.setAttribute('title', '请先在扩展弹出窗口中配置 Exa API Key');
  } else {
    webSearchButton.setAttribute('title', 'Web 搜索 — 通过 Exa API 搜索网络');
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
}

// === API Key Status ===

/**
 * Check whether an Exa API key is configured in chrome.storage.sync.
 * Updates the hasApiKey flag and refreshes the button state.
 */
function checkApiKeyStatus() {
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

  chrome.runtime.sendMessage({ action: 'INJECT_INTERCEPTOR' }, function () {
    if (chrome.runtime.lastError) {
      console.warn('[WebSearch] Service-worker injection failed:', chrome.runtime.lastError.message);
      return;
    }

    apiInterceptorsInstalled = true;
    console.log('[WebSearch] MAIN-world interceptor installed via service-worker fallback');
  });
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
  checkApiKeyStatus();
}

// === Bootstrap ===

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
