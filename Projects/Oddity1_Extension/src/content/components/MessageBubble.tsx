import React from 'react';

interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
}

export function MessageBubble({ role, content, isStreaming }: MessageBubbleProps) {
  const isUser = role === 'user';

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: '8px',
      }}
    >
      <div
        style={{
          maxWidth: '85%',
          padding: '8px 12px',
          borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
          backgroundColor: isUser ? '#2563eb' : '#f3f4f6',
          color: isUser ? '#ffffff' : '#111827',
          fontSize: '13px',
          lineHeight: '1.5',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {content}
        {isStreaming && (
          <span
            style={{
              display: 'inline-block',
              width: '2px',
              height: '13px',
              backgroundColor: '#6b7280',
              marginLeft: '2px',
              verticalAlign: 'text-bottom',
              animation: 'oddity-blink 1s step-end infinite',
            }}
          />
        )}
      </div>
    </div>
  );
}
