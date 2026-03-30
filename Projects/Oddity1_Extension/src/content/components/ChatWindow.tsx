import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MessageBubble } from './MessageBubble';
import { insertAtCursor } from '../utils/dom-utils';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatWindowProps {
  docContext: string;
  onClose: () => void;
}

const SYSTEM_CONTEXT_SEED: Message[] = [
  {
    role: 'user',
    content: `You are Oddity, a brainstorming AI embedded directly inside a Google Doc. You help the user think through ideas, explore concepts, generate outlines, and expand their thinking. Be direct, creative, and concise. Here is the current document text for context:\n\n__DOC_CONTEXT__\n\nNow help the user brainstorm.`,
  },
  {
    role: 'assistant',
    content: "Got it — I've read the document. What would you like to brainstorm?",
  },
];

export function ChatWindow({ docContext, onClose }: ChatWindowProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [currentChunk, setCurrentChunk] = useState('');
  const [lastAssistantMsg, setLastAssistantMsg] = useState('');

  // Drag state
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ mouseX: 0, mouseY: 0, offsetX: 0, offsetY: 0 });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentChunk]);

  // Focus input on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  // Listen for stream messages from background (via content script relay)
  useEffect(() => {
    const handler = (event: Event) => {
      const e = event as CustomEvent;
      const msg = e.detail;

      if (msg.type === 'STREAM_CHUNK') {
        setCurrentChunk((prev) => prev + msg.text);
      } else if (msg.type === 'STREAM_DONE') {
        setCurrentChunk((prev) => {
          const full = prev;
          setMessages((msgs) => [...msgs, { role: 'assistant', content: full }]);
          setLastAssistantMsg(full);
          return '';
        });
        setStreaming(false);
      } else if (msg.type === 'STREAM_ERROR') {
        setCurrentChunk('');
        setMessages((msgs) => [
          ...msgs,
          { role: 'assistant', content: `Error: ${msg.error}` },
        ]);
        setStreaming(false);
      }
    };

    window.addEventListener('oddity-stream', handler);
    return () => window.removeEventListener('oddity-stream', handler);
  }, []);

  const buildMessages = useCallback((): Message[] => {
    const seed = SYSTEM_CONTEXT_SEED.map((m) => ({
      ...m,
      content: m.content.replace('__DOC_CONTEXT__', docContext || '(empty document)'),
    }));
    return [...seed, ...messages];
  }, [messages, docContext]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const userMsg: Message = { role: 'user', content: text };
    setMessages((msgs) => [...msgs, userMsg]);
    setInput('');
    setStreaming(true);
    setCurrentChunk('');

    // Get current tab ID then send to background
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab?.id;
    if (!tabId) return;

    chrome.runtime.sendMessage({
      type: 'CHAT',
      messages: [...buildMessages(), userMsg],
      tabId,
    });
  }, [input, streaming, buildMessages]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInsertToDoc = () => {
    if (!lastAssistantMsg) return;
    insertAtCursor(lastAssistantMsg);
  };

  // Drag handlers
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    setIsDragging(true);
    dragStart.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      offsetX: offset.x,
      offsetY: offset.y,
    };
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      setOffset({
        x: dragStart.current.offsetX + (e.clientX - dragStart.current.mouseX),
        y: dragStart.current.offsetY + (e.clientY - dragStart.current.mouseY),
      });
    };
    const onMouseUp = () => setIsDragging(false);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDragging]);

  const panelStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: `${24 - offset.y}px`,
    left: `calc(50% + ${offset.x}px)`,
    transform: 'translateX(-50%)',
    zIndex: 2147483647,
    width: '380px',
    maxHeight: '520px',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#ffffff',
    borderRadius: '16px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    overflow: 'hidden',
    userSelect: isDragging ? 'none' : 'auto',
  };

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div
        onMouseDown={onMouseDown}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid #e5e7eb',
          cursor: 'grab',
          backgroundColor: '#f9fafb',
          borderRadius: '16px 16px 0 0',
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: '#2563eb',
            }}
          />
          <span style={{ fontSize: '14px', fontWeight: 600, color: '#111827' }}>
            Oddity
          </span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: '#9ca3af',
            fontSize: '18px',
            lineHeight: 1,
            padding: '2px 4px',
            borderRadius: '4px',
          }}
          title="Close"
        >
          ×
        </button>
      </div>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          minHeight: '200px',
          maxHeight: '340px',
        }}
      >
        {messages.length === 0 && !streaming && (
          <div
            style={{
              color: '#6b7280',
              fontSize: '13px',
              textAlign: 'center',
              marginTop: '24px',
              lineHeight: 1.6,
            }}
          >
            What&apos;s the topic, idea, or problem
            <br />
            you want to think through?
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble key={i} role={msg.role} content={msg.content} />
        ))}

        {(streaming || currentChunk) && (
          <MessageBubble
            role="assistant"
            content={currentChunk || ''}
            isStreaming={streaming}
          />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Insert to Doc button — only shown after an assistant reply */}
      {lastAssistantMsg && !streaming && (
        <div style={{ padding: '0 16px 8px' }}>
          <button
            onClick={handleInsertToDoc}
            style={{
              width: '100%',
              padding: '7px',
              backgroundColor: '#eff6ff',
              color: '#2563eb',
              border: '1px solid #bfdbfe',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Insert to Doc
          </button>
        </div>
      )}

      {/* Input area */}
      <div
        style={{
          borderTop: '1px solid #e5e7eb',
          padding: '12px 16px',
          display: 'flex',
          gap: '8px',
          alignItems: 'flex-end',
          backgroundColor: '#f9fafb',
        }}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Oddity..."
          rows={1}
          disabled={streaming}
          style={{
            flex: 1,
            resize: 'none',
            border: '1px solid #e5e7eb',
            borderRadius: '10px',
            padding: '8px 12px',
            fontSize: '13px',
            outline: 'none',
            lineHeight: 1.5,
            maxHeight: '96px',
            overflowY: 'auto',
            fontFamily: 'inherit',
            backgroundColor: streaming ? '#f9fafb' : '#ffffff',
            color: '#111827',
          }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
          }}
        />
        <button
          onClick={handleSubmit}
          disabled={!input.trim() || streaming}
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '8px',
            border: 'none',
            backgroundColor: input.trim() && !streaming ? '#2563eb' : '#e5e7eb',
            color: input.trim() && !streaming ? '#ffffff' : '#9ca3af',
            cursor: input.trim() && !streaming ? 'pointer' : 'default',
            fontSize: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
          title="Send"
        >
          ↑
        </button>
      </div>
    </div>
  );
}
