import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { setInterval } from 'node:timers';

const shutdownMarker = process.argv[2];

process.on('SIGTERM', () => {
  writeFileSync(shutdownMarker, 'terminated');
  process.exit(0);
});

process.stdout.write('not-json\n');
setInterval(() => undefined, 1_000);
