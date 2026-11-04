import { memo } from 'react';
import { ChevronDown } from 'lucide-react';
import type { LogEntry } from '../store/atoms';
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
export const CommunicationRow = memo(function CommunicationRow({ entry }: { entry: LogEntry }) {
  return <details className={`log-line log-${entry.level}`}><summary><time className="mono">{timeFormat.format(entry.time)}</time><span className="log-level mono">{entry.level.toUpperCase()}</span><span>{entry.message}</span>{entry.rawHex && <ChevronDown size={12} />}</summary>{entry.rawHex && <code className="raw-frame">{entry.rawHex}</code>}</details>;
});
