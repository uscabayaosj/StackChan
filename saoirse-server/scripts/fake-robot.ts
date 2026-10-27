import { runFakeRobot } from '../src/fake_robot.js';

function arg(name: string, dflt?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (dflt !== undefined) return dflt;
  throw new Error(`missing --${name}`);
}

try {
  const result = await runFakeRobot({
    url: arg('url', 'ws://127.0.0.1:8765/api/ws'),
    token: arg('token', process.env.SAOIRSE_DEVICE_TOKEN ?? ''),
    wavPath: arg('wav'),
    outPath: arg('out', 'reply.wav'),
    log: m => console.log(m),
  });
  console.log(`stt="${result.stt}" emotion=${result.emotion} sentences=${result.sentences.length} reply_frames=${result.replyFrames}`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
