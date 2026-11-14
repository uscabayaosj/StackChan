/** Keep exact stop names and resolve short corrections against the current bus board. */
export function parseBusRequest(text: string, previous?: Record<string, unknown>): Record<string, unknown> | undefined {
  const words = text.trim().replace(/[?.!]+$/, '');
  if (/\b(?:tomorrow|next week|first|last)\b|\b(?:at|after|before)\s+\d/i.test(words)) return;
  const request = /^(?:please,?\s+)?(?:(?:show me|tell me|check|find|what are|when are|when is)\s+)?(?:the\s+)?(?:next\s+|live\s+)?(?:buses|bus)\b(?:\s+(?:arrivals|departures|schedules?|times))?\s+(?:at|from)\s+(.+)$/i.exec(words);
  if (request) return { mode: 'bus', stop: request[1] };
  if (!previous || previous.mode !== 'bus' || typeof previous.stop !== 'string') return;
  const route = /^(?:(?:and|what about|how about|only)\s+)?(?:(?:the|route|bus)\s+)?([a-z]?\d{1,3})$/i.exec(words);
  const direction = /^(?:(?:and|what about|how about)\s+)?towards?\s+(.+)$/i.exec(words);
  const letter = /^(?:(?:and|what about|how about)\s+)?stop\s+([a-z]{1,2})$/i.exec(words);
  if (route) return { ...previous, route: route[1] };
  if (direction) return { ...previous, direction: direction[1] };
  if (letter) return { ...previous, letter: letter[1] };
}
