// Protocol fixture only: no model imports, downloads or inference.
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers';
const output = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const wav = Buffer.alloc(48);
wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
if (process.env.VOICE_TEST_START !== 'hang') setTimeout(() => output({ type: 'ready', provider: 'kokoro', voices: ['af_heart', 'am_michael'], sampleRate: 24000 }), Number(process.env.VOICE_TEST_START ?? 0));
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.text === 'environment-check' && (process.env.OPENAI_API_KEY || process.env.CODEX_LENS_GATEWAY_TOKEN || process.env.HF_TOKEN)) {
    output({ id: request.id, error: 'credentials-were-inherited' }); return;
  }
  if (request.text === 'hang') return;
  if (request.text === 'crash') process.exit(1);
  if (request.text === 'error') { output({ id: request.id, error: 'private-path-and-secret-must-not-leak' }); return; }
  output({ id: request.text === 'wrong-owner' ? 'some-other-request' : request.id,
    format: 'wav', sampleRate: 24000, audioBase64: request.text === 'bad-audio' ? 'AAAA' : wav.toString('base64') });
});
