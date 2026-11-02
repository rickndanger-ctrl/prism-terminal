#!/usr/bin/env -S node

import { inspectMacMessagesReadiness } from './messages.js';

const result = await inspectMacMessagesReadiness();
if (!result.ok) {
  console.error(`Messages readiness failed: ${result.error.message}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result.value, null, 2));
  if (!result.value.ready) {
    console.error(
      'Contacts access and exactly one enabled, connected Messages account are required for at least one service. No message was sent.',
    );
    process.exitCode = 1;
  }
}
