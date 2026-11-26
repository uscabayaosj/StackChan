import type { ChatEvent, ChatMessage, ToolSpec } from './llm.js';
import { formatLocalTime } from './clock.js';
import { callWithDeadline } from './deadline.js';
import type { CalendarChange, ICloudCalendar } from './icloud_calendar.js';
import { CalendarError } from './icloud_dav.js';
import { makeLiveCard, type LiveCard } from './live_cards.js';

const HOLD_MS = 45_000;
const CONFIRM = /^confirm (?:the )?calendar change[.!?]*$/i;
const CANCEL = /^cancel (?:the )?calendar change[.!?]*$/i;
const CALENDAR_REQUEST = /\b(?:(?:my|the|iCloud|Apple) calendar|calendar (?:events?|entries|appointments?)|my (?:agenda|schedule|appointments?)|(?:am i|do i have any time) free|what (?:do i have|have i got) (?:scheduled|on (?:today|tomorrow|this week)))\b/i;

const DATE = 'Local date YYYY-MM-DD or local date and time YYYY-MM-DDTHH:mm, without an offset.';
const CALENDAR_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'interpret_calendar_request',
    description: 'Interpret one request about the configured iCloud calendar. This does not save a change.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'clarify', 'unsupported', 'unrelated'] },
        from: { type: 'string', description: `List or look up existing events starting at this boundary. ${DATE}` },
        until: { type: 'string', description: `End of the lookup, exclusive. ${DATE}` },
        title: { type: 'string', description: 'New event title, or exact current title for an update.' },
        new_title: { type: 'string', description: 'Replacement title, for an update only.' },
        start: { type: 'string', description: `New start. ${DATE}` },
        end: { type: 'string', description: `New end. ${DATE} For an all-day event use the day after its last day.` },
        location: { type: 'string', description: 'New location, if explicitly requested.' },
        missing: { type: 'string', enum: ['title', 'date', 'time', 'duration', 'changes', 'request'] },
      },
    },
  },
};

const QUESTIONS: Record<string, string> = {
  title: 'What is the title of the event?', date: 'Which date or date range?',
  time: 'What time should the event start?', duration: 'When should it end, or how long should it last?',
  changes: 'What would you like to change about the event?',
  request: 'What would you like me to look up, add, or change on your calendar?',
};

const CALENDAR_INSTRUCTIONS = `Translate the user's speech into one interpret_calendar_request call. Resolve relative dates using the current local time. For today's schedule use the whole local day. For an availability question use the requested time range, or one minute for a single time. For updates, from/until cover the event's OLD date or time and title is its current title. Use start/end only for the NEW time. If the start moves and no new end is requested, omit end to preserve duration. For a new event ask for the title, date and start and either end or duration if missing. Only create all-day events when the user requests all day. Use clarify for missing or ambiguous details. Use unrelated when the user switches to a non-calendar topic during clarification. Use unsupported for deletion, invitations, recurrence changes or other calendars. Do not answer the request yourself.`;

type Chat = (messages: ChatMessage[], signal: AbortSignal, tools: ToolSpec[]) => AsyncIterable<ChatEvent | string>;
interface CalendarReply { lines: string[]; change?: CalendarChange; card?: LiveCard }

/** One voice conversation on one authenticated WebSocket. Pending writes never enter the model's tools or history. */
export class CalendarConversation {
  private pending?: { change: CalendarChange; until: number };
  private clarification?: { turns: ChatMessage[]; until: number };

  constructor(private readonly calendar: Pick<ICloudCalendar, 'list' | 'prepare'>,
    private readonly zone: string, private readonly timeoutMs: number, private readonly name?: string) {}

  accepts(speech: string, now: number): boolean {
    const text = speech.trim();
    if (CONFIRM.test(text) || CANCEL.test(text) || CALENDAR_REQUEST.test(text) ||
      (this.name && text.toLowerCase().includes(this.name.toLowerCase())) ||
      (this.clarification && now <= this.clarification.until)) return true;
    this.pending = undefined;
    this.clarification = undefined;
    return false;
  }

  stage(change: CalendarChange, now: number): void {
    this.pending = { change, until: now + HOLD_MS };
  }

  async respond(speech: string, now: number, signal: AbortSignal, chat: Chat): Promise<CalendarReply | undefined> {
    const text = speech.trim();
    const pending = this.pending;
    const clarification = this.clarification;
    this.pending = undefined;
    this.clarification = undefined;
    if (CONFIRM.test(text) || CANCEL.test(text)) {
      if (!pending || now > pending.until) return { lines: ['There is no pending calendar change. Please tell me the change again.'] };
      if (CANCEL.test(text)) return { lines: ['Calendar change cancelled.'],
        card: makeLiveCard('calendar', 'Change cancelled', 'iCloud', []) };
      try {
        await callWithDeadline('iCloud Calendar save', this.timeoutMs, signal, s => pending.change.save(s));
        return { lines: ['Saved to your iCloud calendar.'],
          card: makeLiveCard('calendar', 'Event saved', 'iCloud', pending.change.card?.items?.slice(-1).map(item => ({ title: item.title })) ?? []) };
      } catch (error) {
        signal.throwIfAborted();
        return { lines: [error instanceof CalendarError ? error.message
          : 'I could not verify the save. Please check your calendar before trying again.'] };
      }
    }

    const turns = [...(clarification && now <= clarification.until ? clarification.turns : []), { role: 'user' as const, content: text }];
    const ask = (question: string) => {
      this.clarification = { turns: [...turns.slice(-4), { role: 'assistant', content: question }], until: now + HOLD_MS };
      return { lines: [question] };
    };
    const system = `${CALENDAR_INSTRUCTIONS}\nConfigured calendar name: ${JSON.stringify(this.name ?? 'iCloud Calendar')}.\nCurrent local time in ${this.zone}: ${formatLocalTime(new Date(now), this.zone)}.`;
    let args: Record<string, unknown> | undefined;
    for await (const event of chat([{ role: 'system', content: system }, ...turns], signal, [CALENDAR_TOOL])) {
      if (typeof event === 'string' || event.type !== 'tool_calls' || event.calls.length !== 1 ||
        event.calls[0].name !== CALENDAR_TOOL.function.name) continue;
      try {
        const data: unknown = JSON.parse(event.calls[0].arguments);
        if (data && typeof data === 'object' && !Array.isArray(data)) args = data as Record<string, unknown>;
      } catch { /* Ask for clarification if the model could not interpret the request. */ }
    }
    signal.throwIfAborted();
    if (!args) return ask(QUESTIONS.request);
    const { action, missing } = args;
    if (action === 'unrelated') return undefined;
    if (action === 'clarify') return ask(typeof missing === 'string' && Object.hasOwn(QUESTIONS, missing) ? QUESTIONS[missing] : QUESTIONS.request);
    if (action !== 'list' && action !== 'create' && action !== 'update') {
      return { lines: ['I can check your iCloud calendar, add an event, or edit a one-off event without guests.'] };
    }
    try {
      const input = args;
      if (action === 'list') {
        let card: LiveCard | undefined;
        const lines = await callWithDeadline('iCloud Calendar lookup', this.timeoutMs, signal, s => this.calendar.list(input, s, value => { card = value; }));
        return { lines, card };
      }
      const change = await callWithDeadline('iCloud Calendar preview', this.timeoutMs, signal, s => this.calendar.prepare(action, input, s));
      return { lines: change.preview, change, card: change.card };
    } catch (error) {
      signal.throwIfAborted();
      return error instanceof CalendarError ? ask(error.message) : { lines: ['I could not reach your iCloud calendar. Please try again.'] };
    }
  }
}
