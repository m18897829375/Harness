/**
 * US-002 self-check: isExpertMode() quick-mode native toggle detection.
 *
 * Runs in JSDOM with content.js loaded as a script so the private functions
 * become globals on window.
 */

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const contentPath = path.join(__dirname, '..', 'content.js');
const contentSource = fs.readFileSync(contentPath, 'utf8');

function createPage(html) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://chat.deepseek.com/a/chat/s/123' });
  const { window } = dom;
  global.document = window.document;
  global.window = window;

  // Mock chrome APIs used by content.js during init (must be on window, not Node global)
  window.chrome = {
    storage: {
      sync: {
        get: () => {},
        onChanged: { addListener: () => {} },
      },
      onChanged: { addListener: () => {} },
    },
    runtime: {
      sendMessage: () => {},
      onMessage: { addListener: () => {} },
      lastError: null,
    },
  };

  const script = window.document.createElement('script');
  script.textContent = contentSource;
  window.document.body.appendChild(script);

  return { window, document: window.document };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL: ${label} — expected ${expected}, got ${actual}`);
    process.exit(1);
  }
  console.log(`PASS: ${label}`);
}

function setRadio(window, index, checked) {
  const radios = window.document.querySelectorAll('div[role="radio"]');
  radios[index].setAttribute('aria-checked', String(checked));
}

// 1. Radio Expert mode → true
{
  const { window } = createPage(`
    <html><body>
      <div role="radio" aria-checked="false"></div>
      <div role="radio" aria-checked="true"></div>
      <div role="radio" aria-checked="false"></div>
      <textarea placeholder="DeepSeek"></textarea>
    </body></html>
  `);
  assertEqual(window.isExpertMode(), true, 'radio expert mode returns true');
}

// 2. Radio Instant mode → false
{
  const { window } = createPage(`
    <html><body>
      <div role="radio" aria-checked="true"></div>
      <div role="radio" aria-checked="false"></div>
      <div role="radio" aria-checked="false"></div>
      <textarea placeholder="DeepSeek"></textarea>
    </body></html>
  `);
  assertEqual(window.isExpertMode(), false, 'radio instant mode returns false');
}

// 3. No radios, lastKnownMode='expert', native quick-mode search toggle → false
{
  const { window } = createPage(`
    <html><body>
      <div id="toolbar">
        <button class="ds-toggle-button">联网搜索</button>
        <textarea placeholder="DeepSeek"></textarea>
      </div>
    </body></html>
  `);
  window.lastKnownMode = 'expert';
  assertEqual(window.isExpertMode(), false, 'quick mode history with native toggle returns false');
}

// 4. No radios, lastKnownMode='expert', toolbar not rendered yet (no toggle) → true
{
  const { window } = createPage(`
    <html><body>
      <div id="toolbar">
        <textarea placeholder="DeepSeek"></textarea>
      </div>
    </body></html>
  `);
  window.lastKnownMode = 'expert';
  assertEqual(window.isExpertMode(), true, 'expert history with unrendered toolbar returns true');
}

// 5. No radios, lastKnownMode='instant' → false
{
  const { window } = createPage(`
    <html><body>
      <div id="toolbar">
        <button class="ds-toggle-button">联网搜索</button>
        <textarea placeholder="DeepSeek"></textarea>
      </div>
    </body></html>
  `);
  window.lastKnownMode = 'instant';
  assertEqual(window.isExpertMode(), false, 'instant mode history returns false regardless of toggle');
}

console.log('\nUS-002 self-check: all 5 cases passed.');
