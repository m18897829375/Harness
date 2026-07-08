/**
 * DeepSeek Web Search Extension — Popup Script
 *
 * Manages Exa API Key configuration through the extension popup:
 * - Loads current key state from chrome.storage.sync on open
 * - Saves new API key (validates non-empty)
 * - Clears stored API key
 * - Shows visual status feedback (loading / configured / unconfigured)
 *
 * @file popup/popup.js
 */

// === DOM References ===

/** @type {HTMLDivElement} */
var statusRow = /** @type {HTMLDivElement} */ (document.getElementById('statusRow'));

/** @type {HTMLSpanElement} */
var statusDot = /** @type {HTMLSpanElement} */ (document.getElementById('statusDot'));

/** @type {HTMLSpanElement} */
var statusText = /** @type {HTMLSpanElement} */ (document.getElementById('statusText'));

/** @type {HTMLDivElement} */
var keyDisplay = /** @type {HTMLDivElement} */ (document.getElementById('keyDisplay'));

/** @type {HTMLSpanElement} */
var keyMasked = /** @type {HTMLSpanElement} */ (document.getElementById('keyMasked'));

/** @type {HTMLDivElement} */
var inputForm = /** @type {HTMLDivElement} */ (document.getElementById('inputForm'));

/** @type {HTMLInputElement} */
var apiKeyInput = /** @type {HTMLInputElement} */ (document.getElementById('apiKeyInput'));

/** @type {HTMLButtonElement} */
var saveBtn = /** @type {HTMLButtonElement} */ (document.getElementById('saveBtn'));

/** @type {HTMLButtonElement} */
var clearBtn = /** @type {HTMLButtonElement} */ (document.getElementById('clearBtn'));

// === Constants ===

/** chrome.storage.sync key name, must match background/service-worker.js:61 */
var STORAGE_KEY = 'exaApiKey';

/** Number of trailing characters to show when displaying masked key. */
var MASKED_SUFFIX_LENGTH = 4;

// === Status Display ===

/**
 * CSS class sets for each status state.
 * Keys: row class, dot class.
 * @type {Object<string, { row: string, dot: string }>}
 */
var STATUS_CLASSES = {
  loading:   { row: 'status-row--loading',   dot: 'status-dot--loading' },
  configured: { row: 'status-row--configured', dot: 'status-dot--configured' },
  unconfigured: { row: 'status-row--unconfigured', dot: 'status-dot--unconfigured' }
};

/**
 * Update the status badge to reflect the given state.
 *
 * @param {'loading' | 'configured' | 'unconfigured'} state
 * @param {string} message — human-readable status text
 */
function setStatus(state, message) {
  var cls = STATUS_CLASSES[state];

  // Remove all status classes, then add the target ones
  statusRow.className = 'status-row ' + cls.row;
  statusDot.className = 'status-dot ' + cls.dot;
  statusText.textContent = message;
}

// === Masking ===

/**
 * Create a masked display string for an API key, showing only the last few characters.
 *
 * @param {string} key — the full API key
 * @returns {string} masked string, e.g. "••••••••1234"
 */
function maskApiKey(key) {
  if (!key || key.length <= MASKED_SUFFIX_LENGTH) {
    return '••••••••';
  }

  var suffix = key.slice(-MASKED_SUFFIX_LENGTH);
  var prefixLength = key.length - MASKED_SUFFIX_LENGTH;
  var masked = '';

  for (var i = 0; i < prefixLength; i++) {
    masked += '•';
  }

  return masked + suffix;
}

// === Save / Clear ===

/**
 * Save the current input value as the API key.
 * Validates that input is not empty; shows error state on empty save attempt.
 */
function saveApiKey() {
  var key = apiKeyInput.value.trim();

  if (key === '') {
    setStatus('unconfigured', '请输入 API Key 后再保存');
    // Flash the input border red briefly
    apiKeyInput.style.borderColor = '#e03131';
    setTimeout(function () {
      apiKeyInput.style.borderColor = '';
    }, 1500);
    return;
  }

  setStatus('loading', '保存中...');
  saveBtn.disabled = true;
  clearBtn.disabled = true;

  /** @type {Record<string, string>} */
  var items = {};
  items[STORAGE_KEY] = key;

  try {
    chrome.storage.sync.set(items, function () {
      if (chrome.runtime.lastError) {
        setStatus('unconfigured', '保存失败: ' + chrome.runtime.lastError.message);
        saveBtn.disabled = false;
        clearBtn.disabled = false;
        return;
      }

      // Update display for configured state
      keyMasked.textContent = maskApiKey(key);
      keyDisplay.style.display = '';
      apiKeyInput.value = '';
      apiKeyInput.placeholder = '输入新的 API Key 以替换...';

      setStatus('configured', '已配置 ✓');
      saveBtn.disabled = false;
      clearBtn.disabled = false;
    });
  } catch (error) {
    setStatus('unconfigured', '保存失败: ' + (error instanceof Error ? error.message : '未知错误'));
    saveBtn.disabled = false;
    clearBtn.disabled = false;
  }
}

/**
 * Remove the stored API key from chrome.storage.sync.
 */
function clearApiKey() {
  setStatus('loading', '清除中...');
  saveBtn.disabled = true;
  clearBtn.disabled = true;

  try {
    chrome.storage.sync.remove(STORAGE_KEY, function () {
      if (chrome.runtime.lastError) {
        setStatus('configured', '清除失败: ' + chrome.runtime.lastError.message);
        saveBtn.disabled = false;
        clearBtn.disabled = false;
        return;
      }

      // Reset display for unconfigured state
      keyDisplay.style.display = 'none';
      keyMasked.textContent = '';
      apiKeyInput.value = '';
      apiKeyInput.placeholder = '输入你的 Exa API Key...';

      setStatus('unconfigured', '未配置');
      saveBtn.disabled = false;
      clearBtn.disabled = true;
    });
  } catch (error) {
    setStatus('configured', '清除失败: ' + (error instanceof Error ? error.message : '未知错误'));
    saveBtn.disabled = false;
    clearBtn.disabled = false;
  }
}

// === Event Handlers ===

/**
 * Handle input changes — enable/disable the Save button based on content.
 */
function onInputChange() {
  var hasValue = apiKeyInput.value.trim().length > 0;
  saveBtn.disabled = !hasValue;
}

/**
 * Handle Save button click.
 */
function onSaveClick() {
  saveApiKey();
}

/**
 * Handle Clear button click.
 */
function onClearClick() {
  clearApiKey();
}

// === Initialization ===

/**
 * Load existing API key from chrome.storage.sync and set initial UI state.
 */
function loadExistingKey() {
  setStatus('loading', '加载中...');
  saveBtn.disabled = true;
  clearBtn.disabled = true;

  try {
    chrome.storage.sync.get(
      /** @type {string[]} */ [STORAGE_KEY],
      /**
       * @param {{ [key: string]: string | undefined }} items
       */
      function (items) {
        if (chrome.runtime.lastError) {
          setStatus('unconfigured', '读取失败: ' + chrome.runtime.lastError.message);
          saveBtn.disabled = false;
          return;
        }

        var key = items[STORAGE_KEY];

        if (key && typeof key === 'string' && key.trim() !== '') {
          // Key is configured
          keyMasked.textContent = maskApiKey(key.trim());
          keyDisplay.style.display = '';
          apiKeyInput.placeholder = '输入新的 API Key 以替换...';

          setStatus('configured', '已配置 ✓');
          saveBtn.disabled = true; // Nothing to save until user types
          clearBtn.disabled = false;
        } else {
          // No key configured
          keyDisplay.style.display = 'none';
          apiKeyInput.placeholder = '输入你的 Exa API Key...';

          setStatus('unconfigured', '未配置');
          saveBtn.disabled = true; // Disabled until user types
          clearBtn.disabled = true;
        }
      }
    );
  } catch (error) {
    setStatus('unconfigured', '读取失败: ' + (error instanceof Error ? error.message : '未知错误'));
    saveBtn.disabled = false;
  }
}

// === Bootstrap ===

document.addEventListener('DOMContentLoaded', function () {
  // Register event listeners
  apiKeyInput.addEventListener('input', onInputChange);
  saveBtn.addEventListener('click', onSaveClick);
  clearBtn.addEventListener('click', onClearClick);

  // Load existing configuration
  loadExistingKey();
});
