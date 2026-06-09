import { memo, useEffect, useState } from "react";
import { CircleDashed, ChevronRight, ChevronDown } from "lucide-react";
import { useI18n } from "../../components/useI18n";
import type { Attachment } from "../../../../shared/attachments";

interface QueuedMessage {
  text: string;
  attachments: Attachment[];
}

interface QueuedMessagesProps {
  messages: QueuedMessage[];
}

/**
 * Pending-send queue indicator shown above the input while the agent is busy.
 * Replaces the old single-line "N message(s) queued" banner with a waiting
 * spinner plus a collapsible count: when more than one message is queued the
 * count expands to reveal each queued message; a single queued message is
 * shown inline with no toggle.
 */
export const QueuedMessages = memo(function QueuedMessages({
  messages,
}: QueuedMessagesProps): React.JSX.Element | null {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  // Reset the collapse state once the queue fully drains so a later refill
  // starts collapsed instead of inheriting a stale expanded state (the
  // component fibre stays alive across empty renders).
  useEffect(() => {
    if (messages.length === 0) setExpanded(false);
  }, [messages.length]);

  if (messages.length === 0) return null;

  const preview = (m: QueuedMessage): string => {
    const text = m.text.trim();
    if (text) return text;
    return t("chat.queuedAttachment", { count: m.attachments.length });
  };

  // Single queued message — show it directly, no collapse affordance.
  if (messages.length === 1) {
    return (
      <div className="chat-queue-indicator">
        <CircleDashed size={14} className="chat-queue-icon" />
        <span className="chat-queue-single" title={preview(messages[0])}>
          {preview(messages[0])}
        </span>
      </div>
    );
  }

  return (
    <div className="chat-queue-indicator chat-queue-collapsible">
      <button
        type="button"
        className="chat-queue-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <CircleDashed size={14} className="chat-queue-icon" />
        <span>{t("chat.queuedCount", { count: messages.length })}</span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {expanded && (
        <ul className="chat-queue-list">
          {messages.map((m, i) => (
            <li
              key={`${i}-${m.text.length}-${m.attachments.length}`}
              className="chat-queue-item"
              title={preview(m)}
            >
              {preview(m)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
