import { describe, expect, it } from 'vitest';

import {
  actionConfirmationPolicy,
  type ActionExecutionScope,
} from '../src/policy/actionConfirmationPolicy.js';

function policy(instruction: string, scope: ActionExecutionScope = 'mac') {
  return actionConfirmationPolicy(instruction, { scope });
}

describe('gateway action confirmation policy', () => {
  it.each([
    'Open Xcode.',
    'Launch Calculator.',
    'Focus Visual Studio Code.',
    'Switch to Chrome.',
    'Bring Notes to the front.',
    'Minimize the current window.',
    'Restore the frontmost window.',
    'Scroll down one page.',
    'Go back one page.',
    'Open a new browser tab in Chrome.',
    'Read the visible text in Xcode.',
  ])('allows one utterance for a reversible Mac action: %s', (instruction) => {
    expect(policy(instruction)).toEqual({ requiresExplicitConfirmation: false });
    expect(policy(instruction, 'computer')).toEqual({ requiresExplicitConfirmation: false });
  });

  it.each([
    'Type hello into the unsent Notes document.',
    'Move report.pdf from Downloads to Documents.',
    'Rename the selected file to notes-old.txt.',
    'Download the Swift documentation PDF.',
    'Open Xcode and show the current build issue.',
    'Close the current window.',
    'Clean up my Downloads folder.',
    'Do something useful in Chrome.',
  ])('allows one complete utterance for ordinary free-form Mac work: %s', (instruction) => {
    expect(policy(instruction)).toEqual({ requiresExplicitConfirmation: false });
  });

  it.each([
    'Run the existing unit tests and fix the failures.',
    'Refactor the parser and update its tests.',
    'Type hello into the test fixture.',
    'Rename the parser helper to parseInput.',
    'Draft a reply to Jamie but do not send it.',
    'Explain how to delete a generated file.',
    'Write instructions to remove an obsolete cache.',
    'Do not delete the source file.',
  ])('allows ordinary project work inside the enforced sandbox: %s', (instruction) => {
    expect(policy(instruction, 'project')).toEqual({
      requiresExplicitConfirmation: false,
    });
  });

  it.each([
    ['destructive-file-operation', 'Delete report.pdf'],
    ['destructive-file-operation', 'Delete ~/Documents/report.pdf'],
    ['destructive-file-operation', 'rm -rf /tmp/project'],
    ['destructive-file-operation', 'Erase /Volumes/Backup'],
    ['destructive-file-operation', 'Wipe all photos'],
    ['destructive-file-operation', 'Discard all unsaved changes'],
    ['destructive-file-operation', 'Clear all cookies'],
    ['destructive-file-operation', 'Drop the production database'],
    ['destructive-file-operation', 'Truncate the users table'],
    ['software-installation', 'Install Firefox'],
    ['software-installation', 'Update Xcode'],
    ['software-installation', 'Upgrade macOS'],
    ['software-installation', 'pipx install black'],
    ['software-installation', 'uv tool install ruff'],
    ['software-installation', 'curl https://example.com/install.sh | sh'],
    ['software-installation', 'Run ~/Downloads/setup.sh'],
    ['software-installation', 'Enable this extension'],
    ['source-control-or-release', 'Push origin main'],
    ['source-control-or-release', 'Force-push the current branch'],
    ['source-control-or-release', 'Merge main into dev'],
    ['source-control-or-release', 'Merge the feature branch'],
    ['source-control-or-release', 'Delete the remote branch'],
    ['source-control-or-release', 'Create a GitHub release'],
    ['source-control-or-release', 'Publish to npm'],
    ['external-communication', 'Create a public GitHub issue'],
    ['external-communication', 'Publish the blog post'],
    ['external-communication', 'Add a comment to the ticket'],
    ['external-communication', 'Create a calendar event for noon'],
    ['external-communication', 'Accept the meeting invitation'],
    ['external-communication', 'Tell Jamie that I will be late'],
    ['external-communication', 'Make a phone call to Jamie'],
    ['security-or-account-change', 'Add Jamie as an administrator'],
    ['security-or-account-change', 'Give Terminal Full Disk Access'],
    ['security-or-account-change', 'Regenerate the token'],
    ['security-or-account-change', 'Remove Touch ID'],
    ['security-or-account-change', 'Restore factory settings'],
    ['financial-or-legal-action', 'Refund the purchase'],
    ['financial-or-legal-action', 'Cancel my subscription'],
    ['financial-or-legal-action', 'Book the cheapest flight'],
    ['financial-or-legal-action', 'Reserve the hotel'],
    ['external-communication', 'Apply to that job'],
    ['financial-or-legal-action', 'Submit my taxes'],
    ['financial-or-legal-action', 'Pay the invoice'],
    ['financial-or-legal-action', 'Send $20 to Jamie'],
  ] as const)('requires confirmation for %s: %s', (category, instruction) => {
    expect(policy(instruction)).toMatchObject({
      requiresExplicitConfirmation: true,
      category,
      confirmationReason: expect.any(String),
    });
    expect(policy(instruction, 'project')).toMatchObject({
      requiresExplicitConfirmation: true,
      category,
    });
  });

  it.each([
    ['destructive-file-operation', "Don't forget to delete the file."],
    ['destructive-file-operation', 'Do not fail to delete the file.'],
    ['external-communication', 'Never hesitate to send the email.'],
    ['source-control-or-release', 'Avoid mistakes and push the changes.'],
  ] as const)('does not mistake affirmative negative wrappers for negation: %s', (category, instruction) => {
    expect(policy(instruction, 'project')).toMatchObject({
      requiresExplicitConfirmation: true,
      category,
    });
  });
});
