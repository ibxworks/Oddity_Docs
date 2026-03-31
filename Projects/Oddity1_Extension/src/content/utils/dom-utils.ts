function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Scrapes the full text of the current Google Doc via clipboard.
 * Simulates Ctrl+A then Ctrl+C and reads the clipboard result.
 */
export async function scrapeDocContext(): Promise<string> {
  // Read text directly from kix render spans — no keyboard events needed
  const paragraphs = Array.from(document.querySelectorAll<HTMLElement>('.kix-paragraphrenderer'));
  if (paragraphs.length > 0) {
    return paragraphs.map(p => {
      const spans = Array.from(p.querySelectorAll<HTMLElement>('.kix-lineview-text-block'));
      return spans.map(s => s.textContent ?? '').join('');
    }).join('\n');
  }
  // Fallback: grab all text blocks directly
  const blocks = Array.from(document.querySelectorAll<HTMLElement>('.kix-lineview-text-block'));
  return blocks.map(b => b.textContent ?? '').join('\n');
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
