export const HEAD_ANGLES = 'self.robot.set_head_angles';
export const FACE_SPEAKER = 'self.robot.face_speaker';

type HeadRequest = { name: string; args: Record<string, number>; confirmation: string };

const small = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const tens = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
const spokenAngle = new RegExp(`\\b(?:${tens.join('|')})(?:[ -](?:${small.slice(1, 10).join('|')}))?\\b|\\b(?:${small.join('|')})\\b`, 'g');

function angleDigits(phrase: string): string {
  const [first, second] = phrase.split(/[ -]/);
  const base = small.indexOf(first);
  if (base >= 0) return String(base);
  return String((tens.indexOf(first) + 2) * 10 + (second ? small.indexOf(second) : 0));
}

/** Handle unambiguous spoken commands without asking a language model to guess an angle. */
export function headRequest(input: string): HeadRequest | undefined {
  const words = input.trim().toLowerCase()
    .replace(/^(?:(?:hey|hi)[, ]+)?(?:saoirse|stack[ -]?chan)[, ]+/, '')
    .replace(/^(?:(?:can|could|would|will) you\s+)?(?:please\s+)?/, '')
    .replace(/(?:,?\s+please)?[.?!]*$/, '')
    .replace(spokenAngle, angleDigits)
    .replace(/\b(\d+)\s+[a-z]{1,4}[-–—]+\s*(?=\d+\b)/g, '');
  if (/^(?:see (?:me|my face)|(?:look at|look towards?|turn (?:your head )?(?:towards?|to (?:face|look at))|face|follow) (?:me|my face|my voice|the (?:person speaking|speaker)))$/.test(words)) {
    return { name: FACE_SPEAKER, args: {}, confirmation: 'I’m checking where your voice is coming from.' };
  }
  if (/^(?:(?:center|centre) your head|(?:face|look|turn) straight ahead)$/.test(words)) {
    return { name: HEAD_ANGLES, args: { yaw: 0, speed: 220 }, confirmation: 'I’m facing straight ahead.' };
  }
  const degrees = /^(?:face|turn|point|aim|look|move)(?: your head)?\s+(?:(\d{1,3})(?:\s*°|\s+degrees?)?\s+)?(?:to\s+)?(?:(?:your|the)\s+)?(left|right|up|down)(?:\s+(\d{1,3})(?:\s*°|\s+degrees?)?)?$/.exec(words);
  if (!degrees || (!degrees[1] && !degrees[3]) || (degrees[1] && degrees[3])) return;
  const n = Number(degrees[1] ?? degrees[3]);
  const direction = degrees[2];
  if (direction === 'down' || n > (direction === 'up' ? 87 : 90)) return;
  const args: Record<string, number> = direction === 'up' ? { pitch: n } : { yaw: direction === 'left' ? -n : n };
  return { name: HEAD_ANGLES, args: { ...args, speed: 220 }, confirmation: `My head is at ${n} degrees ${direction}.` };
}

export const wakeGreeting = /^(?:hi|hey|hello)[,\s]+(?:stack[ -]?(?:chan|chen)|step chen|saoirse)[\s.!?]*$/i;
