/**
 * US-002 smoke verification via local test-page.
 *
 * Loads the extension's content.js in the test page, mocks chrome APIs,
 * and asserts the smart-search button is injected in Expert mode,
 * removed in Instant mode, and re-appears on toggling back to Expert.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const EXT_DIR = path.resolve(__dirname, '..');
const CONTENT_PATH = path.join(EXT_DIR, 'content.js');
const TEST_PAGE_PATH = path.join(EXT_DIR, 'test-page', 'index.html');

async function run() {
  const contentSource = fs.readFileSync(CONTENT_PATH, 'utf8');
  const testPageUrl = 'file://' + TEST_PAGE_PATH;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  try {
    await page.goto(testPageUrl);

    // Inject a mock chrome object before loading the content script so init() runs cleanly.
    await page.evaluate(() => {
      window.chrome = {
        storage: {
          sync: {
            get: (_keys, callback) => callback && callback({}),
            onChanged: { addListener: () => {} },
          },
          onChanged: { addListener: () => {} },
        },
        runtime: {
          sendMessage: (_msg, callback) => callback && callback(),
          onMessage: { addListener: () => {} },
          lastError: null,
        },
      };
    });

    // Load the content script as an ordinary <script>; var declarations attach to window.
    await page.addScriptTag({ content: contentSource });

    // Wait for the content script to set up observers and inject the button.
    await page.waitForTimeout(1200);

    const result = await page.evaluate(async () => {
      const report = {
        initialExpertBtnCount: document.querySelectorAll('.web-search-btn-smart-search').length,
        initialExpertDataAttr: document.querySelector('[data-ralph-web-search]') !== null,
      };

      // Toggle to Instant mode by clicking the first radio and forcing a DOM mutation
      // so the content script's MutationObserver detects the mode change.
      const radios = document.querySelectorAll('div[role="radio"]');
      if (radios.length >= 2) {
        radios.forEach((r) => r.setAttribute('aria-checked', 'false'));
        radios[0].setAttribute('aria-checked', 'true');
        radios[0].dispatchEvent(new Event('click', { bubbles: true }));
        radios[0].click();
        // Trigger a real childList mutation so the observer callback fires and removes the button.
        const div = document.createElement('div');
        div.id = 'mutation-trigger-instant';
        document.body.appendChild(div);
        div.remove();
      }
      await new Promise((resolve) => setTimeout(resolve, 600));

      report.instantBtnCount = document.querySelectorAll('.web-search-btn-smart-search').length;
      report.instantDataAttr = document.querySelector('[data-ralph-web-search]') !== null;

      // Toggle back to Expert mode.
      if (radios.length >= 2) {
        radios.forEach((r) => r.setAttribute('aria-checked', 'false'));
        radios[1].setAttribute('aria-checked', 'true');
        radios[1].dispatchEvent(new Event('click', { bubbles: true }));
        radios[1].click();
        // Trigger a real childList mutation so the observer callback re-evaluates the mode.
        const div = document.createElement('div');
        div.id = 'mutation-trigger-expert';
        document.body.appendChild(div);
        div.remove();
      }
      await new Promise((resolve) => setTimeout(resolve, 600));

      report.revertedExpertBtnCount = document.querySelectorAll('.web-search-btn-smart-search').length;
      report.revertedExpertDataAttr = document.querySelector('[data-ralph-web-search]') !== null;

      return report;
    });

    const failures = [];
    if (result.initialExpertBtnCount !== 1) failures.push(`initial Expert mode expected 1 button, got ${result.initialExpertBtnCount}`);
    if (!result.initialExpertDataAttr) failures.push('initial Expert mode expected [data-ralph-web-search] to exist');
    if (result.instantBtnCount !== 0) failures.push(`Instant mode expected 0 buttons, got ${result.instantBtnCount}`);
    if (result.instantDataAttr) failures.push('Instant mode expected [data-ralph-web-search] to be absent');
    if (result.revertedExpertBtnCount !== 1) failures.push(`reverted Expert mode expected 1 button, got ${result.revertedExpertBtnCount}`);
    if (!result.revertedExpertDataAttr) failures.push('reverted Expert mode expected [data-ralph-web-search] to exist');

    if (failures.length > 0) {
      console.error('FAIL: US-002 smoke check');
      for (const f of failures) console.error('  -', f);
      process.exit(1);
    }

    console.log('PASS: US-002 smoke check');
    console.log('Result:', JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error('FAIL: unexpected error', error);
  process.exit(1);
});
