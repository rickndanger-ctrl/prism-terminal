import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

import { err, ok, type Result } from '@codex-lens/shared';

import type { Db } from '../db/schema.js';
import {
  createMemoryMessageIntentStore,
  createSqliteMessageIntentStore,
  type MessageIntentRecord,
  type MessageIntentStore,
} from './messageIntentStore.js';

export const MESSAGE_SERVICE_TYPES = ['iMessage', 'SMS', 'RCS'] as const;
export type MessageServiceType = typeof MESSAGE_SERVICE_TYPES[number];

export interface PrepareTextMessageRequest {
  recipient: string;
  message: string;
  serviceType: MessageServiceType;
}

export interface PreparedTextMessage {
  confirmationId: string;
  digest: string;
  recipientDisplay: string;
  maskedDestination: string;
  message: string;
  serviceType: MessageServiceType;
  expiresAt: string;
  requiresExplicitConfirmation: true;
}

export interface SendPreparedTextRequest {
  confirmationId: string;
  digest: string;
}

export interface SentTextMessage {
  /**
   * Legacy wire name. `true` means the Messages app accepted the AppleScript
   * send command; it is not a carrier or recipient delivery receipt.
   */
  sent: true;
  recipientDisplay: string;
  serviceType: MessageServiceType;
  sentAt: string;
}

export interface MessageAddress {
  displayName: string;
  handle: string;
}

export interface MessageDestination {
  displayName: string;
  handle: string;
  serviceType: MessageServiceType;
  serviceAccountId: string;
}

export type MessageDestinationResolver = (
  recipient: string,
  serviceType: MessageServiceType,
) => Promise<Result<MessageDestination>>;

export type MessageSender = (
  destination: MessageDestination,
  message: string,
) => Promise<Result<void>>;

export interface MessageService {
  /**
   * Claims listener ownership and closes every durable intent left by an older
   * gateway process. This must run only after the gateway owns its TCP listener.
   */
  activate(): void;
  prepare(request: PrepareTextMessageRequest): Promise<Result<PreparedTextMessage>>;
  send(request: SendPreparedTextRequest): Promise<Result<SentTextMessage>>;
  status(confirmationId: string): Promise<Result<MessageIntentStatus>>;
  readiness(): Promise<Result<MessageReadiness>>;
}

export interface MessageIntentStatus {
  confirmationId: string;
  recipientDisplay: string;
  maskedDestination: string;
  serviceType: MessageServiceType;
  state: MessageIntentRecord['state'];
  preparedAt: string;
  expiresAt: string;
  updatedAt: string;
  acceptedAt?: string;
  failureCode?: string;
}

export interface MessageServiceReadiness {
  serviceType: MessageServiceType;
  available: boolean;
  accountCount: number;
}

export interface MessageReadiness {
  contactsAccessible: boolean;
  services: MessageServiceReadiness[];
  ready: boolean;
}

interface StoredMessage {
  destination: MessageDestination;
  message: string;
  digest: string;
  expiresAt: Date;
}

export type MessageReadinessInspector = () => Promise<Result<MessageReadiness>>;

export interface CreateMessageServiceOptions {
  resolve?: MessageDestinationResolver;
  send?: MessageSender;
  readiness?: MessageReadinessInspector;
  db?: Db;
  intentStore?: MessageIntentStore;
  now?: () => Date;
  id?: () => string;
  ttlMs?: number;
}

const CONTACT_LOOKUP_SCRIPT = String.raw`
on cleanText(inputValue)
  set cleanValue to inputValue as text
  set AppleScript's text item delimiters to tab
  set cleanValue to text items of cleanValue
  set AppleScript's text item delimiters to " "
  set cleanValue to cleanValue as text
  set AppleScript's text item delimiters to linefeed
  set cleanValue to text items of cleanValue
  set AppleScript's text item delimiters to " "
  set cleanValue to cleanValue as text
  set AppleScript's text item delimiters to ""
  return cleanValue
end cleanText

on run argv
  if application "Contacts" is not running then
    launch application "Contacts"
    delay 1
  end if
  set queryText to item 1 of argv
  set rows to {}
  tell application "Contacts"
    set matches to every person whose name contains queryText
    repeat with personRecord in matches
      set contactID to my cleanText(id of personRecord)
      set contactName to my cleanText(name of personRecord)
      set end of rows to contactID & tab & contactName & tab & "person" & tab & "" & tab & ""
      repeat with phoneRecord in phones of personRecord
        set end of rows to contactID & tab & contactName & tab & "phone" & tab & my cleanText(label of phoneRecord) & tab & my cleanText(value of phoneRecord)
      end repeat
      repeat with emailRecord in emails of personRecord
        set end of rows to contactID & tab & contactName & tab & "email" & tab & my cleanText(label of emailRecord) & tab & my cleanText(value of emailRecord)
      end repeat
    end repeat
  end tell
  set AppleScript's text item delimiters to linefeed
  set outputText to rows as text
  set AppleScript's text item delimiters to ""
  return outputText
end run
`;

const CONTACT_PERMISSION_CHECK_SCRIPT = String.raw`
if application "Contacts" is not running then
  launch application "Contacts"
  delay 1
end if
tell application "Contacts"
  set personCount to count of people
end tell
return personCount as text
`;

const MESSAGE_SERVICE_LOOKUP_SCRIPT = String.raw`
on matchesRequestedType(accountRecord, requestedType)
  tell application "Messages"
    try
      set accountServiceType to service type of accountRecord
      if requestedType = "iMessage" then return accountServiceType is iMessage
      if requestedType = "SMS" then return accountServiceType is SMS
      if requestedType = "RCS" then return accountServiceType is RCS
    on error
      -- Messages can expose connected account records whose service type is
      -- unreadable. They are not eligible destinations; skip them.
      return false
    end try
  end tell
  return false
end matchesRequestedType

on run argv
  if application "Messages" is not running then
    launch application "Messages"
    delay 1
  end if
  set requestedType to item 1 of argv
  set rows to {}
  tell application "Messages"
    repeat with accountRecord in accounts
      if enabled of accountRecord is true and connection status of accountRecord is connected then
        if my matchesRequestedType(accountRecord, requestedType) then
          set end of rows to id of accountRecord
        end if
      end if
    end repeat
  end tell
  set AppleScript's text item delimiters to linefeed
  set outputText to rows as text
  set AppleScript's text item delimiters to ""
  return outputText
end run
`;

const MESSAGE_SERVICE_READINESS_SCRIPT = String.raw`
on run
  if application "Messages" is not running then
    launch application "Messages"
    delay 1
  end if
  set iMessageCount to 0
  set smsCount to 0
  set rcsCount to 0
  tell application "Messages"
    repeat with accountRecord in accounts
      try
        if enabled of accountRecord is true and connection status of accountRecord is connected then
          set accountServiceType to service type of accountRecord
          if accountServiceType is iMessage then
            set iMessageCount to iMessageCount + 1
          else if accountServiceType is SMS then
            set smsCount to smsCount + 1
          else if accountServiceType is RCS then
            set rcsCount to rcsCount + 1
          end if
        end if
      on error
        -- Ignore unreadable non-Messages service records instead of turning
        -- valid iMessage/SMS accounts into a false zero-account result.
      end try
    end repeat
  end tell
  return "iMessage" & tab & iMessageCount & linefeed & "SMS" & tab & smsCount & linefeed & "RCS" & tab & rcsCount
end run
`;

const SEND_MESSAGE_SCRIPT = String.raw`
on matchesRequestedType(accountRecord, requestedType)
  tell application "Messages"
    try
      set accountServiceType to service type of accountRecord
      if requestedType = "iMessage" then return accountServiceType is iMessage
      if requestedType = "SMS" then return accountServiceType is SMS
      if requestedType = "RCS" then return accountServiceType is RCS
    on error
      return false
    end try
  end tell
  return false
end matchesRequestedType

on run argv
  if application "Messages" is not running then
    launch application "Messages"
    delay 1
  end if
  set targetAccountID to item 1 of argv
  set requestedType to item 2 of argv
  set targetAddress to item 3 of argv
  set bodyText to item 4 of argv
  tell application "Messages"
    set matchingAccounts to every account whose id = targetAccountID
    if (count of matchingAccounts) is not 1 then return "service-unavailable"
    set targetAccount to item 1 of matchingAccounts
    if enabled of targetAccount is not true then return "service-unavailable"
    if connection status of targetAccount is not connected then return "service-unavailable"
    if not my matchesRequestedType(targetAccount, requestedType) then return "service-mismatch"
    set targetParticipant to participant targetAddress of targetAccount
    send bodyText to targetParticipant
  end tell
  return "accepted"
end run
`;

const APPLE_SCRIPT = '/usr/bin/osascript';
const AUTOMATION_TIMEOUT_MS = 12_000;

interface ContactRow {
  personId: string;
  name: string;
  kind: 'person' | 'phone' | 'email';
  label: string;
  value: string;
}

export type ContactLookup = (recipient: string) => Promise<Result<string>>;

function runAppleScript(script: string, args: string[]): Promise<Result<string>> {
  return new Promise((resolve) => {
    const child = spawn(
      APPLE_SCRIPT,
      ['-e', script, '--', ...args],
      { shell: false, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let output = '';
    let settled = false;
    const finish = (result: Result<string>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (output.length < 65_536) output += chunk;
    });
    child.once('error', () => {
      finish(err('MESSAGES_AUTOMATION_UNAVAILABLE', 'Mac Messages automation could not start.'));
    });
    child.once('close', (code) => {
      if (code === 0) finish(ok(output.trim()));
      else finish(err('MESSAGES_AUTOMATION_FAILED', 'Mac Messages automation did not complete.'));
    });
    const timeout = setTimeout(() => {
      child.kill();
      finish(err('MESSAGES_AUTOMATION_TIMEOUT', 'Mac Messages automation timed out.'));
    }, AUTOMATION_TIMEOUT_MS);
  });
}

function normalizePhone(value: string, minimumDigits = 10): string | undefined {
  const trimmed = value.trim();
  const digits = trimmed.replaceAll(/\D/gu, '');
  if (digits.length < minimumDigits || digits.length > 15) return undefined;
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

function directDestination(recipient: string): MessageAddress | undefined {
  const trimmed = recipient.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(trimmed)) {
    return { displayName: trimmed, handle: trimmed.toLowerCase() };
  }
  if (resemblesDirectPhone(trimmed)) {
    const phone = normalizePhone(trimmed);
    if (phone !== undefined) return { displayName: trimmed, handle: phone };
  }
  return undefined;
}

function resemblesDirectPhone(recipient: string): boolean {
  const trimmed = recipient.trim();
  return /\d/u.test(trimmed) && /^[+\d\s().-]+$/u.test(trimmed);
}

function parseContactRows(output: string): ContactRow[] {
  return output.split(/\r?\n/u).flatMap((line) => {
    const [personId, name, kind, label = '', value = ''] = line.split('\t');
    if (
      personId === undefined || personId === '' ||
      name === undefined || name === '' ||
      (kind !== 'person' && kind !== 'phone' && kind !== 'email') ||
      (kind !== 'person' && value === '')
    ) return [];
    return [{ personId, name, kind, label, value }];
  });
}

interface ContactRecord {
  personId: string;
  name: string;
  rows: ContactRow[];
}

interface RankedHandle {
  handle: string;
  rank: number;
}

function rankedHandle(row: ContactRow): RankedHandle | undefined {
  if (row.kind === 'phone') {
    const handle = normalizePhone(row.value);
    if (handle === undefined) return undefined;
    return {
      handle,
      rank: /mobile|iphone/i.test(row.label) ? 0 : 1,
    };
  }
  if (row.kind === 'email') {
    const handle = row.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(handle)) return undefined;
    return { handle, rank: 2 };
  }
  return undefined;
}

function contactRecords(rows: ContactRow[]): ContactRecord[] {
  const records = new Map<string, ContactRecord>();
  for (const row of rows) {
    const existing = records.get(row.personId);
    if (existing === undefined) {
      records.set(row.personId, {
        personId: row.personId,
        name: row.name,
        rows: [row],
      });
    } else {
      existing.rows.push(row);
    }
  }
  return [...records.values()];
}

function resolveContactOutput(recipient: string, output: string): Result<MessageAddress> {
  const records = contactRecords(parseContactRows(output));
  const query = recipient.trim().toLocaleLowerCase();
  const exactRecords = records.filter((record) => record.name.toLocaleLowerCase() === query);
  const candidates = exactRecords.length > 0 ? exactRecords : records;
  if (candidates.length === 0) {
    return err('MESSAGE_RECIPIENT_NOT_FOUND', `No contact matched “${recipient.trim()}”.`);
  }
  if (candidates.length > 1) {
    const names = [...new Set(candidates.map((record) => record.name))];
    return err(
      'MESSAGE_RECIPIENT_AMBIGUOUS',
      `Multiple contact records matched: ${names.slice(0, 5).join(', ')}. Say a more specific contact name or a full phone number or email address.`,
    );
  }

  const record = candidates[0]!;
  const ranked = record.rows.flatMap((row) => {
    const candidate = rankedHandle(row);
    return candidate === undefined ? [] : [candidate];
  });
  if (ranked.length === 0) {
    return err(
      'MESSAGE_RECIPIENT_NO_DESTINATION',
      `${record.name} has no usable full phone number or email address.`,
    );
  }
  const bestRank = Math.min(...ranked.map((candidate) => candidate.rank));
  const bestHandles = [...new Set(
    ranked
      .filter((candidate) => candidate.rank === bestRank)
      .map((candidate) => candidate.handle),
  )];
  if (bestHandles.length > 1) {
    return err(
      'MESSAGE_DESTINATION_AMBIGUOUS',
      `${record.name} has multiple equally eligible Messages destinations. Say the full phone number or email address.`,
    );
  }
  return ok({ displayName: record.name, handle: bestHandles[0]! });
}

export async function resolveMacMessageDestinationWithLookup(
  recipient: string,
  lookup: ContactLookup,
): Promise<Result<MessageAddress>> {
  const direct = directDestination(recipient);
  if (direct !== undefined) return ok(direct);
  const trimmed = recipient.trim();
  if (resemblesDirectPhone(trimmed)) {
    return err(
      'MESSAGE_RECIPIENT_INVALID',
      'Use a full phone number with 10 to 15 digits, including the area code.',
    );
  }
  if (trimmed.includes('@')) {
    return err('MESSAGE_RECIPIENT_INVALID', 'Use a complete Messages email address.');
  }

  const queried = await lookup(recipient);
  if (!queried.ok) return queried;
  return resolveContactOutput(recipient, queried.value);
}

async function resolveMacMessageAccount(
  serviceType: MessageServiceType,
): Promise<Result<string>> {
  const accounts = await runAppleScript(MESSAGE_SERVICE_LOOKUP_SCRIPT, [serviceType]);
  if (!accounts.ok) return accounts;
  const accountIDs = accounts.value.split(/\r?\n/u).filter((value) => value !== '');
  if (accountIDs.length === 0) {
    return err(
      'MESSAGES_SERVICE_UNAVAILABLE',
      `No enabled and connected ${serviceType} account is available in Messages.`,
    );
  }
  if (accountIDs.length > 1) {
    return err(
      'MESSAGES_SERVICE_AMBIGUOUS',
      `More than one enabled and connected ${serviceType} account is available. Choose one in Messages settings before sending.`,
    );
  }
  return ok(accountIDs[0]!);
}

export const resolveMacMessageDestination: MessageDestinationResolver = async (
  recipient,
  serviceType,
) => {
  const account = await resolveMacMessageAccount(serviceType);
  if (!account.ok) return account;
  const address = await resolveMacMessageDestinationWithLookup(
    recipient,
    async (query) => runAppleScript(CONTACT_LOOKUP_SCRIPT, [query]),
  );
  if (!address.ok) return address;
  return ok({
    ...address.value,
    serviceType,
    serviceAccountId: account.value,
  });
};

export const sendMacMessage: MessageSender = async (destination, message) => {
  const sent = await runAppleScript(SEND_MESSAGE_SCRIPT, [
    destination.serviceAccountId,
    destination.serviceType,
    destination.handle,
    message,
  ]);
  if (!sent.ok) return sent;
  if (sent.value === 'service-unavailable') {
    return err(
      'MESSAGES_SERVICE_UNAVAILABLE',
      `The prepared ${destination.serviceType} account is no longer enabled and connected. Nothing was intentionally retried.`,
    );
  }
  if (sent.value === 'service-mismatch') {
    return err(
      'MESSAGES_SERVICE_MISMATCH',
      'The prepared Messages account changed service type. Nothing was sent.',
    );
  }
  if (sent.value !== 'accepted') {
    return err('MESSAGES_SEND_UNCONFIRMED', 'Mac Messages did not confirm accepting the send request.');
  }
  return ok(undefined);
};

function parseServiceReadiness(output: string): MessageServiceReadiness[] {
  const counts = new Map<MessageServiceType, number>();
  for (const line of output.split(/\r?\n/u)) {
    const [rawType, rawCount] = line.split('\t');
    if (
      rawType === undefined ||
      !MESSAGE_SERVICE_TYPES.includes(rawType as MessageServiceType) ||
      rawCount === undefined
    ) continue;
    const count = Number.parseInt(rawCount, 10);
    if (Number.isInteger(count) && count >= 0) {
      counts.set(rawType as MessageServiceType, count);
    }
  }
  return MESSAGE_SERVICE_TYPES.map((serviceType) => {
    const accountCount = counts.get(serviceType) ?? 0;
    return { serviceType, available: accountCount === 1, accountCount };
  });
}

export const inspectMacMessagesReadiness: MessageReadinessInspector = async () => {
  const [contacts, servicesResult] = await Promise.all([
    runAppleScript(CONTACT_PERMISSION_CHECK_SCRIPT, []),
    runAppleScript(MESSAGE_SERVICE_READINESS_SCRIPT, []),
  ]);
  const services = servicesResult.ok
    ? parseServiceReadiness(servicesResult.value)
    : MESSAGE_SERVICE_TYPES.map((serviceType) => ({
        serviceType,
        available: false,
        accountCount: 0,
      }));
  const contactsAccessible = contacts.ok;
  return ok({
    contactsAccessible,
    services,
    ready: contactsAccessible && services.some((service) => service.available),
  });
};

function maskDestination(handle: string): string {
  const at = handle.indexOf('@');
  if (at > 0) {
    return `${handle.slice(0, 1)}•••${handle.slice(at)}`;
  }
  const digits = handle.replaceAll(/\D/gu, '');
  return `••••${digits.slice(-4)}`;
}

function digestFor(id: string, destination: MessageDestination, message: string, expiresAt: Date): string {
  return createHash('sha256')
    .update(id)
    .update('\0')
    .update(destination.handle)
    .update('\0')
    .update(destination.serviceType)
    .update('\0')
    .update(destination.serviceAccountId)
    .update('\0')
    .update(message)
    .update('\0')
    .update(expiresAt.toISOString())
    .digest('hex');
}

function digestMatches(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

function intentStatus(record: MessageIntentRecord): MessageIntentStatus {
  return {
    confirmationId: record.confirmationId,
    recipientDisplay: record.recipientDisplay,
    maskedDestination: record.maskedDestination,
    serviceType: record.serviceType,
    state: record.state,
    preparedAt: record.preparedAt,
    expiresAt: record.expiresAt,
    updatedAt: record.updatedAt,
    ...(record.acceptedAt === undefined ? {} : { acceptedAt: record.acceptedAt }),
    ...(record.failureCode === undefined ? {} : { failureCode: record.failureCode }),
  };
}

function missingConfirmationError(
  record: MessageIntentRecord | undefined,
): Result<never> {
  switch (record?.state) {
  case 'sending':
    return err(
      'MESSAGE_SEND_ALREADY_STARTED',
      'That message send already started. Its outcome may still be pending; it will not be retried.',
    );
  case 'accepted':
    return err('MESSAGE_ALREADY_ACCEPTED', 'Messages already accepted that text. It will not be sent again.');
  case 'uncertain':
    return err(
      'MESSAGE_SEND_OUTCOME_UNCERTAIN',
      'The prior send outcome is uncertain. It will not be retried because that could duplicate the text.',
    );
  case 'expired':
    return err('MESSAGE_CONFIRMATION_EXPIRED', 'That message confirmation expired. Prepare it again.');
  case 'rejected':
    if (record.failureCode === 'MESSAGE_CONFIRMATION_RESTARTED') {
      return err(
        'MESSAGE_CONFIRMATION_RESTARTED',
        'The gateway restarted after preparing that message. It was not sent; prepare it again.',
      );
    }
    return err('MESSAGE_SEND_REJECTED', 'That prepared message is closed. Prepare it again before sending.');
  case 'prepared':
    return err(
      'MESSAGE_CONFIRMATION_RESTARTED',
      'The gateway restarted after preparing that message. It was not sent; prepare it again.',
    );
  case undefined:
    return err('MESSAGE_CONFIRMATION_NOT_FOUND', 'That prepared message no longer exists. Prepare it again.');
  }
}

function isDefinitelyRejectedBeforeSend(code: string): boolean {
  return code === 'MESSAGES_AUTOMATION_UNAVAILABLE' ||
    code === 'MESSAGES_SERVICE_UNAVAILABLE' ||
    code === 'MESSAGES_SERVICE_MISMATCH';
}

export function createMessageService(options: CreateMessageServiceOptions = {}): MessageService {
  const resolveDestination = options.resolve ?? resolveMacMessageDestination;
  const sendMessage = options.send ?? sendMacMessage;
  const readinessInspector = options.readiness ?? inspectMacMessagesReadiness;
  const intentStore = options.intentStore ?? (
    options.db === undefined
      ? createMemoryMessageIntentStore()
      : createSqliteMessageIntentStore(options.db)
  );
  const now = options.now ?? (() => new Date());
  const makeId = options.id ?? randomUUID;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const prepared = new Map<string, StoredMessage>();
  let activated = false;

  const activate = (): void => {
    if (activated) return;
    intentStore.reconcileRestart(now().toISOString());
    activated = true;
  };

  const requireActivation = (): Result<never> | undefined => activated
    ? undefined
    : err(
        'MESSAGES_SERVICE_NOT_ACTIVE',
        'The Messages service is not active on the gateway listener.',
      );

  return {
    activate,

    async prepare(request) {
      const inactive = requireActivation();
      if (inactive !== undefined) return inactive;
      const destination = await resolveDestination(request.recipient, request.serviceType);
      if (!destination.ok) return destination;
      if (destination.value.serviceType !== request.serviceType) {
        return err(
          'MESSAGES_SERVICE_MISMATCH',
          'The resolved Messages service did not match the requested service. Nothing was prepared.',
        );
      }
      const confirmationId = makeId();
      const preparedAt = now();
      const expiresAt = new Date(preparedAt.getTime() + ttlMs);
      const digest = digestFor(confirmationId, destination.value, request.message, expiresAt);
      const maskedDestination = maskDestination(destination.value.handle);
      intentStore.insert({
        confirmationId,
        digest,
        recipientDisplay: destination.value.displayName,
        maskedDestination,
        serviceType: destination.value.serviceType,
        state: 'prepared',
        preparedAt: preparedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        updatedAt: preparedAt.toISOString(),
      });
      prepared.set(confirmationId, {
        destination: destination.value,
        message: request.message,
        digest,
        expiresAt,
      });
      return ok({
        confirmationId,
        digest,
        recipientDisplay: destination.value.displayName,
        maskedDestination,
        message: request.message,
        serviceType: destination.value.serviceType,
        expiresAt: expiresAt.toISOString(),
        requiresExplicitConfirmation: true,
      });
    },

    async send(request) {
      const inactive = requireActivation();
      if (inactive !== undefined) return inactive;
      const stored = prepared.get(request.confirmationId);
      if (stored === undefined) {
        const record = intentStore.get(request.confirmationId);
        if (record?.state === 'prepared') {
          intentStore.transition(
            request.confirmationId,
            ['prepared'],
            'rejected',
            now().toISOString(),
            { failureCode: 'MESSAGE_CONFIRMATION_RESTARTED' },
          );
        }
        return missingConfirmationError(record);
      }
      if (now() >= stored.expiresAt) {
        prepared.delete(request.confirmationId);
        intentStore.transition(
          request.confirmationId,
          ['prepared'],
          'expired',
          now().toISOString(),
          { failureCode: 'MESSAGE_CONFIRMATION_EXPIRED' },
        );
        return err('MESSAGE_CONFIRMATION_EXPIRED', 'That message confirmation expired. Prepare it again.');
      }
      if (!digestMatches(request.digest, stored.digest)) {
        return err('MESSAGE_CONFIRMATION_MISMATCH', 'The message confirmation did not match. Nothing was sent.');
      }

      // Consume before invoking Messages. A timeout has an uncertain external
      // outcome, so automatic replay could duplicate a real text.
      prepared.delete(request.confirmationId);
      const startedAt = now().toISOString();
      if (!intentStore.transition(
        request.confirmationId,
        ['prepared'],
        'sending',
        startedAt,
      )) {
        return missingConfirmationError(intentStore.get(request.confirmationId));
      }
      const sent = await sendMessage(stored.destination, stored.message);
      if (!sent.ok) {
        const finalState = isDefinitelyRejectedBeforeSend(sent.error.code)
          ? 'rejected'
          : 'uncertain';
        intentStore.transition(
          request.confirmationId,
          ['sending'],
          finalState,
          now().toISOString(),
          { failureCode: sent.error.code },
        );
        return sent;
      }
      const acceptedAt = now().toISOString();
      intentStore.transition(
        request.confirmationId,
        ['sending'],
        'accepted',
        acceptedAt,
        { acceptedAt },
      );
      return ok({
        sent: true,
        recipientDisplay: stored.destination.displayName,
        serviceType: stored.destination.serviceType,
        sentAt: acceptedAt,
      });
    },

    async status(confirmationId) {
      const inactive = requireActivation();
      if (inactive !== undefined) return inactive;
      let record = intentStore.get(confirmationId);
      if (record === undefined) {
        return err('MESSAGE_CONFIRMATION_NOT_FOUND', 'No message intent exists with that confirmation id.');
      }
      if (record.state === 'prepared' && now() >= new Date(record.expiresAt)) {
        intentStore.transition(
          confirmationId,
          ['prepared'],
          'expired',
          now().toISOString(),
          { failureCode: 'MESSAGE_CONFIRMATION_EXPIRED' },
        );
        record = intentStore.get(confirmationId)!;
      }
      return ok(intentStatus(record));
    },

    async readiness() {
      const inactive = requireActivation();
      if (inactive !== undefined) return inactive;
      return readinessInspector();
    },
  };
}
