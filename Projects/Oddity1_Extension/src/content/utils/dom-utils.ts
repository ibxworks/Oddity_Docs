function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Scrapes the full text of the current Google Doc via clipboard.
 * Simulates Ctrl+A then Ctrl+C and reads the clipboard result.
 */
export async function scrapeDocContext(): Promise<string> {
  const scrollY = window.scrollY;

  // Focus the Google Docs editor body so keyboard events land there
  const editorBody =
    (document.querySelector('.kix-appview-editor') as HTMLElement | null) ??
    (document.querySelector('[contenteditable="true"]') as HTMLElement | null);

  if (editorBody) {
    editorBody.focus();
  }

  await sleep(50);

  // Simulate Ctrl+A
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
  );
  await sleep(150);

  // Simulate Ctrl+C
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'c',
      code: 'KeyC',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
  );
  await sleep(250);

  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    // clipboard API may be blocked; return empty string gracefully
    text = '';
  }

  window.scrollTo({ top: scrollY, behavior: 'instant' });
  return text;
}

/**
 * Inserts text at the current cursor position in Google Docs
 * with a typewriter effect (~18ms per character).
 */
export async function insertAtCursor(text: string): Promise<void> {
  // Try to find the hidden contenteditable input surface Google Docs uses
  const editor =
    (document.querySelector('.docs-texteventtarget-iframe') as HTMLIFrameElement | null)
      ?.contentDocument?.body ??
    (document.querySelector('[contenteditable="true"]') as HTMLElement | null);

  if (!editor) return;

  (editor as HTMLElement).focus();
  await sleep(50);

  for (const char of text) {
    document.execCommand('insertText', false, char);
    await sleep(18);
  }
}

/**
 * Simulates backspace keypresses to delete the trigger string.
 * Uses the active element so the events land inside Google Docs.
 */
export function deleteTrigger(length: number): void {
  const target = document.activeElement ?? document.body;
  for (let i = 0; i < length; i++) {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Backspace',
        code: 'Backspace',
        bubbles: true,
        cancelable: true,
      })
    );
    target.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: 'Backspace',
        code: 'Backspace',
        bubbles: true,
        cancelable: true,
      })
    );
  }
}
