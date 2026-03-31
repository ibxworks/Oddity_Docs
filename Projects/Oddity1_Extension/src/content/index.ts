import { scrapeDocContext } from './utils/dom-utils';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface OdditySession {
  docId: string;
  tabId: string;
  history: Message[];
  createdAt: number;
  treeContent?: string;
  essayContent?: string;
  essayTabId?: string;
  treeTabId?: string;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

const history: Message[] = [];
let docContext = '';
let streaming = false;
let currentStreamText = '';
let pendingUserText = '';
let pendingUserPaste: Promise<void> = Promise.resolve();
let inputBar: HTMLDivElement | null = null;
let textarea: HTMLTextAreaElement | null = null;
let sendBtn: HTMLButtonElement | null = null;
let treeBtn: HTMLButtonElement | null = null;
let essayBtn: HTMLButtonElement | null = null;
let activeDocId = '';
let activeTabId = '';
let essayTabId = '';
let treeTabId = '';
let pendingEditMode = false;
let activeSession: OdditySession | null = null;

// ─── URL parsing ──────────────────────────────────────────────────────────────
function parseGDocsLocation(): { docId: string; tabId: string } {
  const pathMatch = window.location.pathname.match(/\/document\/d\/([^/]+)\//);
  const docId = pathMatch ? pathMatch[1] : 'unknown';
  const tabParam = new URLSearchParams(window.location.search).get('tab');
  return { docId, tabId: tabParam ?? 'default' };
}

// ─── Storage helpers ──────────────────────────────────────────────────────────
function sessionKey(docId: string, tabId: string) {
  return `oddity_session_${docId}_${tabId}`;
}

async function loadSession(docId: string, tabId: string): Promise<OdditySession | null> {
  const key = sessionKey(docId, tabId);
  const result = await chrome.storage.local.get(key);
  return (result[key] as OdditySession) ?? null;
}

async function saveSession(session: OdditySession): Promise<void> {
  const key = sessionKey(session.docId, session.tabId);
  await chrome.storage.local.set({ [key]: session });
}

async function saveSessionAfterMessage(): Promise<void> {
  if (!activeSession) return;
  activeSession.history = [...history];
  await saveSession(activeSession);
}

// ─── Stream relay ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STREAM_CHUNK') {
    currentStreamText += message.text;
  } else if (message.type === 'STREAM_DONE') {
    const response = currentStreamText;
    history.push({ role: 'assistant', content: response });
    currentStreamText = '';
    pendingUserPaste
      .then(() => saveSessionAfterMessage())
      .then(() => handleResponseActions(response))
      .then(() => {
        streaming = false;
        setInputEnabled(true);
      });
  } else if (message.type === 'STREAM_ERROR') {
    currentStreamText = '';
    streaming = false;
    pendingEditMode = false;
    setInputEnabled(true);
  }
});

// ─── Doc insertion via character-by-character beforeinput events ──────────────
async function pasteIntoDoc(text: string) {
  const iframe = document.querySelector(
    '.docs-texteventtarget-iframe'
  ) as HTMLIFrameElement | null;

  if (!iframe?.contentDocument?.body || !iframe.contentWindow) {
    console.warn('[Oddity] iframe not accessible');
    return;
  }

  const iframeBody = iframe.contentDocument.body as HTMLElement;

  iframeBody.focus();
  await sleep(100);

  // Dispatch each character via keydown + beforeinput on the iframe body.
  // beforeinput with inputType='insertText' is how modern browsers signal
  // text insertion — GDocs canvas editor listens for this.
  for (const char of text) {
    if (char === '\n') {
      iframeBody.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        })
      );
      iframeBody.dispatchEvent(
        new KeyboardEvent('keyup', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true,
        })
      );
    } else {
      const cc = char.charCodeAt(0);
      // keypress carries charCode — this is how GDocs canvas reads typed characters
      // Skip keydown/keyup for printable chars: their keyCode (VK code) differs from
      // charCode for symbols (e.g. apostrophe charCode=39 == ArrowRight keyCode),
      // causing unintended cursor movement in GDocs.
      iframeBody.dispatchEvent(
        new KeyboardEvent('keypress', {
          key: char, charCode: cc, keyCode: cc, which: cc,
          bubbles: true, cancelable: true,
        })
      );
    }
  }
}

// ─── GDocs tab rename ─────────────────────────────────────────────────────────
// GDocs tabs use role="treeitem" (not "tab") with aria-selected="true" for active tab.
// The label text is in .chapter-label-content; the rename input is input.goog-control
// inside the same treeitem, hidden until double-click activates rename mode.

async function renameGDocsTab(name: string): Promise<boolean> {
  const tabEl = document.querySelector('[role="treeitem"][aria-selected="true"]');
  if (!tabEl) return false;

  // Double-click the visible label to activate rename mode
  const labelEl = tabEl.querySelector('.chapter-label-content');
  if (!labelEl) return false;

  labelEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  await sleep(400);

  // The rename input lives inside the tab element, becomes visible after dblclick
  const inputEl = tabEl.querySelector<HTMLInputElement>('input.goog-control');
  if (!inputEl || inputEl.style.display === 'none') return false;

  inputEl.value = name;
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(50);

  inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  await sleep(200);
  return true;
}

async function renameGDocsTabWithRetry(name: string, tabId: string, maxAttempts = 5, delayMs = 500): Promise<void> {
  if (tabId === 'default') return;
  for (let i = 0; i < maxAttempts; i++) {
    const ok = await renameGDocsTab(name);
    if (ok) return;
    await sleep(delayMs);
  }
  console.warn('[Oddity] Could not rename GDocs tab — sidebar may not be visible');
}

// ─── GDocs tab creation & navigation ─────────────────────────────────────────
async function createNewGDocsTab(): Promise<boolean> {
  // aria-label="Add tab" confirmed from live DOM inspection
  const addBtn = document.querySelector<HTMLElement>('[aria-label="Add tab"]');
  if (!addBtn) return false;
  addBtn.click();
  await sleep(600);
  return true;
}

async function waitForTabChange(previousTabId: string, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const current = new URLSearchParams(window.location.search).get('tab') ?? 'default';
    if (current !== previousTabId) return;
    await sleep(100);
  }
}

// Navigate to a tab by its display name (aria-label on the treeitem)
async function navigateToGDocsTabByLabel(label: string): Promise<void> {
  const tabEl = document.querySelector<HTMLElement>(`[role="treeitem"][aria-label="${label}"]`);
  if (tabEl) {
    tabEl.click();
    await sleep(400);
  }
}

async function buildEssayTab(essayContent: string): Promise<void> {
  const brainstormingTabId = activeTabId;

  const created = await createNewGDocsTab();
  if (!created) {
    await pasteIntoDoc(`\n\n--- Essay Draft ---\n${essayContent}\n\n`);
    return;
  }

  await waitForTabChange(brainstormingTabId);
  const newTabId = new URLSearchParams(window.location.search).get('tab') ?? 'default';
  essayTabId = newTabId;

  await renameGDocsTabWithRetry('Essay Draft', newTabId, 8, 300);
  await pasteIntoDoc(essayContent + '\n\n');
  if (activeSession) {
    activeSession.essayContent = essayContent;
    activeSession.essayTabId = newTabId;
    await saveSession(activeSession);
  }
  await navigateToGDocsTabByLabel('Brainstorming');
}

async function buildArgumentTreeTab(treeContent: string): Promise<void> {
  const brainstormingTabId = activeTabId;

  const created = await createNewGDocsTab();
  if (!created) {
    await pasteIntoDoc(`\n\n--- Argument Tree ---\n${treeContent}\n\n`);
    return;
  }

  await waitForTabChange(brainstormingTabId);
  const newTabId = new URLSearchParams(window.location.search).get('tab') ?? 'default';
  treeTabId = newTabId;

  await renameGDocsTabWithRetry('Argument Tree', newTabId, 8, 300);
  await pasteIntoDoc(treeContent + '\n\n');
  if (activeSession) {
    activeSession.treeContent = treeContent;
    activeSession.treeTabId = newTabId;
    await saveSession(activeSession);
  }
  // Navigate back to Brainstorming by its display name (set during activate)
  await navigateToGDocsTabByLabel('Brainstorming');
}

// ─── Suggestion mode helpers ──────────────────────────────────────────────────
function getCurrentGDocsTabLabel(): string {
  const activeTab = document.querySelector('[role="treeitem"][aria-selected="true"] .chapter-label-content');
  return activeTab?.textContent?.trim() ?? '';
}

async function enableSuggestionMode(): Promise<void> {
  // No-op if already in suggesting mode — exclude menu items to avoid false positives
  const suggestingIndicator = document.querySelector(
    '[aria-label="Suggesting"]:not([role="menuitem"]):not([role="option"]), ' +
    '[data-tooltip="Suggesting"]:not([role="menuitem"]):not([role="option"])'
  );
  if (suggestingIndicator) {
    console.log('[Oddity] Already in suggestion mode, indicator:', suggestingIndicator.tagName, suggestingIndicator.getAttribute('aria-label'));
    return;
  }
  console.log('[Oddity] Not in suggestion mode, attempting to enable...');

  // Find the editing-mode button — try multiple selector variants
  const editBtn = document.querySelector<HTMLElement>(
    '[aria-label="Editing"], [aria-label="Editing mode"], [data-tooltip="Editing"], [data-tooltip="Editing mode"]'
  ) ?? Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')).find(el =>
    /^editing$/i.test(el.textContent?.trim() ?? '') ||
    /^editing$/i.test(el.getAttribute('aria-label') ?? '') ||
    /^editing$/i.test(el.getAttribute('data-tooltip') ?? '')
  );
  console.log('[Oddity] Editing mode button found:', !!editBtn, editBtn?.getAttribute('aria-label'), editBtn?.textContent?.trim());
  if (!editBtn) { console.warn('[Oddity] Editing mode button not found — suggestion mode skipped'); return; }

  editBtn.click();

  // Poll for "Suggesting" menu item
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role^="menuitem"], [role="option"]'))
      .find(el => /\bsuggesting\b/i.test(el.textContent ?? '') || /\bsuggesting\b/i.test(el.getAttribute('aria-label') ?? ''));
    if (item) {
      console.log('[Oddity] Clicking Suggesting item:', item.textContent?.trim());
      item.click();
      await sleep(300);
      return;
    }
    await sleep(50);
  }
  console.warn('[Oddity] Suggesting menu item not found after 2s');
}

// ─── Find & replace helpers ───────────────────────────────────────────────────
function parseEditOps(text: string): Array<{ find: string; replace: string }> {
  const ops: Array<{ find: string; replace: string }> = [];
  const blocks = text.split(/^---\s*$/m);
  for (const block of blocks) {
    const findMatch = block.match(/^FIND:\s*([\s\S]*?)(?=\nREPLACE:)/m);
    const replaceMatch = block.match(/^REPLACE:\s*([\s\S]*)$/m);
    if (findMatch) {
      ops.push({
        find: findMatch[1].trim(),
        replace: replaceMatch ? replaceMatch[1].trim() : '',
      });
    }
  }
  return ops;
}

// Returns all accessible same-origin iframe documents
function iframeDocuments(): Document[] {
  return Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'))
    .flatMap(f => { try { return f.contentDocument ? [f.contentDocument] : []; } catch { return []; } });
}

// Find the F&R dialog inputs across all frames using multiple strategies
function findFRInputs(): { findInput: HTMLInputElement | null; replaceInput: HTMLInputElement | null; dialogDoc: Document } {
  const excluded = ['docs-title-input', 'docs-omnibox-input', 'assisted-actions-toolbar-omnibox', 'goog-toolbar-combo-button-input'];

  for (const doc of [document, ...iframeDocuments()]) {
    // Strategy 1: aria-label contains "find" or "search"
    const allInputs = Array.from(doc.querySelectorAll<HTMLInputElement>('input'));
    const findByLabel = allInputs.find(el => /\b(find|search)\b/i.test(el.getAttribute('aria-label') ?? ''));
    if (findByLabel) {
      const replaceByLabel = allInputs.find(el => /\breplace\b/i.test(el.getAttribute('aria-label') ?? '') && el !== findByLabel);
      return { findInput: findByLabel, replaceInput: replaceByLabel ?? null, dialogDoc: doc };
    }

    // Strategy 2: [role="dialog"] container — grab its first two inputs
    const dialog = doc.querySelector<HTMLElement>('[role="dialog"]');
    if (dialog) {
      const dialogInputs = Array.from(dialog.querySelectorAll<HTMLInputElement>('input'))
        .filter(el => !excluded.some(c => el.classList.contains(c)));
      if (dialogInputs.length >= 1) {
        console.log('[Oddity] findFRInputs via dialog role, inputs found:', dialogInputs.length);
        return { findInput: dialogInputs[0], replaceInput: dialogInputs[1] ?? null, dialogDoc: doc };
      }
    }

    // Strategy 3: any non-toolbar inputs in this document (F&R dialog is the only dialog open)
    const nonToolbarInputs = allInputs.filter(el => !excluded.some(c => el.classList.contains(c)));
    if (nonToolbarInputs.length >= 1) {
      console.log('[Oddity] findFRInputs via fallback, inputs:', nonToolbarInputs.map(el => el.getAttribute('aria-label') ?? el.className));
      return { findInput: nonToolbarInputs[0], replaceInput: nonToolbarInputs[1] ?? null, dialogDoc: doc };
    }
  }
  return { findInput: null, replaceInput: null, dialogDoc: document };
}

// Poll until F&R dialog inputs are available
async function waitForFRDialog(timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (findFRInputs().findInput) return true;
    await sleep(100);
  }
  return false;
}

// Type into a Google Docs F&R input (Closure Library) char-by-char via keypress
async function typeIntoFRInput(input: HTMLInputElement, value: string): Promise<void> {
  input.focus();
  await sleep(50);
  // Clear existing content
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', keyCode: 65, ctrlKey: true, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', keyCode: 46, bubbles: true }));
  input.value = '';
  await sleep(50);
  // Type each character so Closure's input handlers fire
  for (const char of value) {
    const cc = char.charCodeAt(0);
    input.dispatchEvent(new KeyboardEvent('keypress', { key: char, charCode: cc, keyCode: cc, bubbles: true, cancelable: true }));
    input.value += char;
    input.dispatchEvent(new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true }));
  }
  await sleep(400); // wait for Closure's debounce timer
}

// Core approach: open F&R → find text → select it in canvas → close dialog → type replacement
// This is the ONLY path that produces real tracked-change suggestions (Find & Replace All bypasses suggestion mode).
async function replaceTextViaCanvas(findText: string, replaceText: string): Promise<void> {
  console.log('[Oddity] replaceTextViaCanvas', JSON.stringify(findText.slice(0, 40)), '→', JSON.stringify(replaceText.slice(0, 40)));

  // 1. Open F&R via ⌘+Shift+H keyboard shortcut on the canvas iframe
  // (Clicking the Edit menu item uses isTrusted:false which Google Docs ignores)
  const canvasIframe = document.querySelector<HTMLIFrameElement>('.docs-texteventtarget-iframe');
  if (!canvasIframe?.contentDocument?.body) { console.warn('[Oddity] Canvas iframe not found'); return; }
  canvasIframe.contentDocument.body.focus();
  await sleep(100);
  canvasIframe.contentDocument.body.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'H', code: 'KeyH', keyCode: 72,
    metaKey: true, shiftKey: true,
    bubbles: true, cancelable: true,
  }));
  console.log('[Oddity] Dispatched ⌘+Shift+H to open F&R');

  // 2. Poll for dialog to appear
  const ready = await waitForFRDialog();
  if (!ready) { console.warn('[Oddity] F&R dialog did not appear'); return; }

  // 3. Find inputs by aria-label
  const { findInput, dialogDoc } = findFRInputs();
  if (!findInput) { console.warn('[Oddity] Find input not found'); return; }
  console.log('[Oddity] findInput aria-label:', findInput.getAttribute('aria-label'));

  // 4. Type find text into find input
  await typeIntoFRInput(findInput, findText);

  // 5. Click "Find" / "Next" button to select the occurrence in the canvas
  function findNextBtn(): HTMLElement | null {
    for (const doc of [document, ...iframeDocuments()]) {
      const btn = Array.from(doc.querySelectorAll<HTMLElement>('*')).find(el =>
        el.offsetParent !== null && el.children.length === 0 &&
        /^(find|next)$/i.test(el.textContent?.trim() ?? '')
      );
      if (btn) return btn;
    }
    return null;
  }
  const nextBtn = findNextBtn();
  console.log('[Oddity] Next btn found:', !!nextBtn, nextBtn?.textContent?.trim());
  if (nextBtn) {
    nextBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    nextBtn.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
    nextBtn.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
    await sleep(300);
  }

  // 6. Close dialog — dispatch Escape to the find input itself so it bubbles up through the dialog
  findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
  await sleep(100);
  // Also try clicking the X close button if dialog is still open
  const closeX = Array.from(document.querySelectorAll<HTMLElement>('*')).find(el =>
    el.offsetParent !== null && /^(×|✕|close)$/i.test(el.textContent?.trim() ?? '') &&
    (el.getAttribute('aria-label') ?? '').toLowerCase().includes('close')
  );
  if (closeX) closeX.click();
  // Poll until dialog is gone (max 2s) before typing into canvas
  const closeStart = Date.now();
  while (Date.now() - closeStart < 2000) {
    if (!findFRInputs().findInput) break;
    await sleep(100);
  }
  await sleep(200);

  // 7. Type replacement via canvas — overwrites the selection as a tracked-change suggestion
  await pasteIntoDoc(replaceText);
  await sleep(200);
}

// ─── Response router ──────────────────────────────────────────────────────────
async function handleResponseActions(response: string): Promise<void> {
  if (pendingEditMode) {
    pendingEditMode = false;
    console.log('[Oddity] handleResponseActions: edit mode, response length:', response.length, 'preview:', response.slice(0, 100));
    const editMatch = response.match(/<<<EDIT>>>([\s\S]+?)<<<END_EDIT>>>/);
    console.log('[Oddity] editMatch found:', !!editMatch);
    if (editMatch) {
      console.log('[Oddity] enabling suggestion mode...');
      await enableSuggestionMode();
      console.log('[Oddity] suggestion mode enabled, parsing ops...');
      const ops = parseEditOps(editMatch[1].trim());
      console.log('[Oddity] parsed ops:', ops.length, ops.map(o => ({ find: o.find.slice(0, 30), replace: o.replace.slice(0, 30) })));
      for (const op of ops) {
        await replaceTextViaCanvas(op.find, op.replace);
      }
    } else {
      console.warn('[Oddity] No <<<EDIT>>> block found in response');
    }
    return;
  }

  const treeMatch = response.match(/<<<TREE>>>([\s\S]+?)<<<END_TREE>>>/);
  const essayMatch = response.match(/<<<ESSAY>>>([\s\S]+?)<<<END_ESSAY>>>/);
  if (treeMatch) {
    const treeContent = treeMatch[1].trim();
    const followup = response.replace(/<<<TREE>>>[\s\S]+?<<<END_TREE>>>/, '').trim();
    await buildArgumentTreeTab(treeContent);
    if (followup) await pasteIntoDoc(`Oddity: ${followup}\n\n`);
  } else if (essayMatch) {
    const essayContent = essayMatch[1].trim();
    const followup = response.replace(/<<<ESSAY>>>[\s\S]+?<<<END_ESSAY>>>/, '').trim();
    await buildEssayTab(essayContent);
    if (followup) await pasteIntoDoc(`Oddity: ${followup}\n\n`);
  } else {
    await pasteIntoDoc(`Oddity: ${response}\n\n`);
  }
}

function setInputEnabled(enabled: boolean) {
  if (textarea) {
    textarea.disabled = !enabled;
    textarea.placeholder = enabled ? 'Ask Oddity...' : 'Thinking…';
    if (enabled) textarea.focus();
  }
  if (sendBtn) sendBtn.disabled = !enabled;
  if (treeBtn) treeBtn.disabled = !enabled;
  if (essayBtn) essayBtn.disabled = !enabled;
}

// ─── Tree request ─────────────────────────────────────────────────────────────
function handleTreeRequest(btn: HTMLButtonElement) {
  if (streaming || history.length === 0) return;
  streaming = true;
  pendingUserPaste = Promise.resolve(); // no user text to paste into doc
  btn.disabled = true;
  if (sendBtn) sendBtn.disabled = true;
  if (textarea) { textarea.disabled = true; textarea.placeholder = 'Building tree…'; }

  const messages: Message[] = [];
  if (docContext) {
    messages.push({
      role: 'user',
      content: `Here is the current document text for context:\n\n${docContext}\n\nNow let's begin.`,
    });
    messages.push({
      role: 'assistant',
      content: "Got it — I've read the document. What would you like to think through?",
    });
  }
  messages.push(...history);
  messages.push({ role: 'user', content: 'Please build the argument tree now.' });

  chrome.runtime.sendMessage({ type: 'CHAT', messages, mode: 'tree' });
}

// ─── Essay request ────────────────────────────────────────────────────────────
function handleEssayRequest(btn: HTMLButtonElement) {
  if (streaming || history.length === 0) return;
  streaming = true;
  pendingUserPaste = Promise.resolve();
  btn.disabled = true;
  if (sendBtn) sendBtn.disabled = true;
  if (treeBtn) treeBtn.disabled = true;
  if (textarea) { textarea.disabled = true; textarea.placeholder = 'Drafting essay…'; }

  const messages: Message[] = [];
  if (docContext) {
    messages.push({
      role: 'user',
      content: `Here is the current document text for context:\n\n${docContext}\n\nNow let's begin.`,
    });
    messages.push({
      role: 'assistant',
      content: "Got it — I've read the document. What would you like to think through?",
    });
  }
  messages.push(...history);
  messages.push({ role: 'user', content: 'Please write a first draft essay based on our conversation and the argument tree.' });

  chrome.runtime.sendMessage({ type: 'CHAT', messages, mode: 'essay' });
}

// ─── Send handler ─────────────────────────────────────────────────────────────
async function handleSend(text: string) {
  if (!text || streaming) return;

  const currentTabId = new URLSearchParams(window.location.search).get('tab') ?? 'default';
  const isEditTab = (!!essayTabId && currentTabId === essayTabId) || (!!treeTabId && currentTabId === treeTabId);

  if (isEditTab) {
    // On edit tabs: send to AI with edit prompt, paste response as suggestion, no user echo
    streaming = true;
    pendingEditMode = true;
    pendingUserPaste = Promise.resolve();
    setInputEnabled(false);
    if (textarea) textarea.placeholder = 'Editing…';

    history.push({ role: 'user', content: text });
    saveSessionAfterMessage();

    // Use stored essay content — scraping is unreliable due to isTrusted blocks
    const essayContent = activeSession?.essayContent ?? '';
    console.log('[Oddity] essayContent length:', essayContent.length, 'preview:', essayContent.slice(0, 100));

    const editMessages: Message[] = [];
    if (essayContent) {
      editMessages.push({
        role: 'user',
        content: `Here is the essay to edit:\n\n${essayContent}\n\nNow let's begin.`,
      });
      editMessages.push({
        role: 'assistant',
        content: "Got it — I've read the essay. What edits would you like me to make?",
      });
    }
    editMessages.push(...history);

    chrome.runtime.sendMessage({ type: 'CHAT', messages: editMessages, mode: 'edit' });
    return;
  }

  // Brainstorming tab: normal chat flow
  streaming = true;
  pendingUserText = text;
  setInputEnabled(false);
  pendingUserPaste = pasteIntoDoc(`You: ${text}\n\n`);

  history.push({ role: 'user', content: text });
  saveSessionAfterMessage(); // fire-and-forget

  const messages: Message[] = [];
  if (docContext) {
    messages.push({
      role: 'user',
      content: `Here is the current document text for context:\n\n${docContext}\n\nNow let's begin.`,
    });
    messages.push({
      role: 'assistant',
      content: "Got it — I've read the document. What would you like to think through?",
    });
  }
  messages.push(...history);

  chrome.runtime.sendMessage({ type: 'CHAT', messages, mode: 'chat' });
}

// ─── Input bar ────────────────────────────────────────────────────────────────
function createInputBar() {
  const host = document.createElement('div');
  host.id = 'oddity-input-host';
  host.style.cssText =
    'all: initial; position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 2147483646; width: 520px;';
  document.body.appendChild(host);
  inputBar = host;

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; }
    .bar {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      background: #ffffff;
      border-radius: 14px;
      padding: 10px 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.14), 0 1px 4px rgba(0,0,0,0.08);
      border: 1px solid #e5e7eb;
    }
    textarea {
      flex: 1;
      resize: none;
      border: none;
      outline: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.5;
      color: #111827;
      background: transparent;
      max-height: 120px;
      overflow-y: auto;
      padding: 0;
    }
    textarea::placeholder { color: #9ca3af; }
    textarea:disabled { opacity: 0.5; }
    .send {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      border: none;
      background: #2563eb;
      color: #fff;
      font-size: 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .send:disabled { background: #e5e7eb; color: #9ca3af; cursor: default; }
    .close {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      border: none;
      background: none;
      color: #9ca3af;
      font-size: 18px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      line-height: 1;
      padding: 0;
    }
    .close:hover { color: #6b7280; }
    .tree-btn {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      border: none;
      background: #f3f4f6;
      color: #374151;
      font-size: 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    .tree-btn:hover { background: #e5e7eb; }
    .tree-btn:disabled { opacity: 0.4; cursor: default; }
    .essay-btn {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      border: none;
      background: #f3f4f6;
      color: #374151;
      font-size: 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    .essay-btn:hover { background: #e5e7eb; }
    .essay-btn:disabled { opacity: 0.4; cursor: default; }
  `;
  shadow.appendChild(style);

  const bar = document.createElement('div');
  bar.className = 'bar';

  textarea = document.createElement('textarea');
  textarea.placeholder = 'Ask Oddity...';
  textarea.rows = 1;
  textarea.addEventListener('input', () => {
    textarea!.style.height = 'auto';
    textarea!.style.height = `${Math.min(textarea!.scrollHeight, 120)}px`;
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const val = textarea!.value.trim();
      if (val) {
        textarea!.value = '';
        textarea!.style.height = 'auto';
        handleSend(val);
      }
    }
  });

  sendBtn = document.createElement('button');
  sendBtn.className = 'send';
  sendBtn.textContent = '↑';
  sendBtn.addEventListener('click', () => {
    const val = textarea!.value.trim();
    if (val) {
      textarea!.value = '';
      textarea!.style.height = 'auto';
      handleSend(val);
    }
  });

  treeBtn = document.createElement('button');
  treeBtn.className = 'tree-btn';
  treeBtn.textContent = '🌳';
  treeBtn.title = 'Build argument tree';
  treeBtn.addEventListener('click', () => handleTreeRequest(treeBtn!));

  essayBtn = document.createElement('button');
  essayBtn.className = 'essay-btn';
  essayBtn.textContent = '📝';
  essayBtn.title = 'Draft essay from conversation';
  essayBtn.addEventListener('click', () => handleEssayRequest(essayBtn!));

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close Oddity';
  closeBtn.addEventListener('click', deactivate);

  bar.appendChild(textarea);
  bar.appendChild(treeBtn);
  bar.appendChild(essayBtn);
  bar.appendChild(sendBtn);
  bar.appendChild(closeBtn);
  shadow.appendChild(bar);

  setTimeout(() => textarea?.focus(), 100);
}

// ─── Activate / deactivate ────────────────────────────────────────────────────
async function activate() {
  if (inputBar) return; // already active

  const fab = document.getElementById('oddity-fab') as HTMLButtonElement | null;
  if (fab) fab.style.display = 'none';

  const { docId, tabId } = parseGDocsLocation();
  activeDocId = docId;
  activeTabId = tabId;

  const existingSession = await loadSession(docId, tabId);

  docContext = await scrapeDocContext();
  createInputBar();

  if (existingSession) {
    history.push(...existingSession.history);
    activeSession = existingSession;
    essayTabId = existingSession.essayTabId ?? '';
    treeTabId = existingSession.treeTabId ?? '';
    await pasteIntoDoc('Oddity: [Resuming — Brainstorming]\n\n');
  } else {
    activeSession = { docId, tabId, history: [], createdAt: Date.now() };
    await saveSession(activeSession);

    const renamePromise = renameGDocsTabWithRetry('Brainstorming', tabId);
    await pasteIntoDoc('Oddity: What\'s the topic, idea, or problem you want to think through?\n\n');
    await renamePromise;
  }
}

function deactivate() {
  if (inputBar) {
    inputBar.remove();
    inputBar = null;
    textarea = null;
    sendBtn = null;
    treeBtn = null;
    essayBtn = null;
  }
  history.length = 0;
  docContext = '';
  activeDocId = '';
  activeTabId = '';
  essayTabId = '';
  treeTabId = '';
  pendingEditMode = false;
  activeSession = null;
  const fab = document.getElementById('oddity-fab') as HTMLButtonElement | null;
  if (fab) fab.style.display = 'flex';
}

// ─── FAB ──────────────────────────────────────────────────────────────────────
function injectFAB() {
  const fab = document.createElement('button');
  fab.id = 'oddity-fab';
  fab.textContent = 'On';
  fab.style.cssText = `
    all: initial;
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483647;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    background: #2563eb;
    color: #ffffff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    font-weight: 600;
    border: none;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(37,99,235,0.4), 0 2px 6px rgba(0,0,0,0.12);
    display: flex;
    align-items: center;
    justify-content: center;
  `;
  fab.addEventListener('click', activate);
  document.body.appendChild(fab);
}

injectFAB();
