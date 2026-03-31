import Anthropic from '@anthropic-ai/sdk';
import systemPrompt from '../../SYSTEM_PROMPT.md?raw';
import essayPrompt from '../../ESSAY_PROMPT.md?raw';
import treePrompt from '../../TREE_PROMPT.md?raw';
import editPrompt from '../../EDIT_PROMPT.md?raw';

const API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY as string;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatRequest {
  type: 'CHAT';
  messages: ChatMessage[];
  mode?: 'chat' | 'essay' | 'tree' | 'edit';
}

chrome.runtime.onMessage.addListener((request: ChatRequest, sender, sendResponse) => {
  if (request.type !== 'CHAT') return;

  const tabId = sender.tab?.id;
  if (!tabId) return;

  (async () => {
    const client = new Anthropic({ apiKey: API_KEY, dangerouslyAllowBrowser: true });
    const promptMap: Record<string, string> = { essay: essayPrompt, tree: treePrompt, edit: editPrompt };
    const prompt = promptMap[request.mode ?? ''] ?? systemPrompt;

    try {
      const stream = client.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: prompt,
        messages: request.messages,
      });

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          chrome.tabs.sendMessage(tabId, {
            type: 'STREAM_CHUNK',
            text: event.delta.text,
          });
        }
      }

      chrome.tabs.sendMessage(tabId, { type: 'STREAM_DONE' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      chrome.tabs.sendMessage(tabId, {
        type: 'STREAM_ERROR',
        error: message,
      });
    }
  })();

  sendResponse({ ok: true });
  return true;
});
