import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { convertConversationToEngineeringPlan } from '../conversation-conversion.js';
import {
  createConversationSession,
  transitionConversationSession,
  type ConversationSession,
  type ConversationStatus,
} from '../conversation-session.js';
import type { EngineeringPlan } from '../engineering-plan.js';
import {
  makeSeedConversation,
  resolvedAnswers,
} from '../fixtures/seed-conversation.js';
import {
  loadConversation,
  loadEngineeringPlan,
  saveConversation,
  saveEngineeringPlan,
} from '../persistence.js';
import { approvePlan, requestApproval } from '../plan-approval.js';
import type { Result } from '../result.js';

if (!process.env.CODEX_LENS_DATA_DIR) {
  process.env.CODEX_LENS_DATA_DIR = mkdtempSync(
    join(tmpdir(), 'codex-lens-demo-'),
  );
}

function unwrap<T>(result: Result<T>, context: string): T {
  if (!result.ok) {
    console.error(`FAILED: ${context}: [${result.error.code}] ${result.error.message}`);
    process.exit(1);
  }
  return result.value;
}

function persistConversation(session: ConversationSession): void {
  unwrap(saveConversation(session), 'persist conversation session');
  unwrap(loadConversation(session.conversationId), 'reload conversation session');
}

function persistPlan(plan: EngineeringPlan): void {
  unwrap(saveEngineeringPlan(plan), 'persist engineering plan');
  unwrap(loadEngineeringPlan(plan.engineeringPlanId), 'reload engineering plan');
}

function transitionAndPersist(
  session: ConversationSession,
  targetStatus: ConversationStatus,
): ConversationSession {
  const next = unwrap(
    transitionConversationSession(session, targetStatus),
    `transition conversation to ${targetStatus}`,
  );
  console.log(
    `ConversationSession: ${session.conversationStatus} -> ${next.conversationStatus}`,
  );
  persistConversation(next);
  return next;
}

function answerOpenQuestions(session: ConversationSession): ConversationSession {
  const answers = new Map(resolvedAnswers.map(({ id, answer }) => [id, answer]));
  const answered = unwrap(
    createConversationSession({
      conversationId: session.conversationId,
      projectName: session.projectName,
      userGoal: session.userGoal,
      background: session.background,
      openQuestions: session.openQuestions.map((question) => ({
        ...question,
        answer: question.answer ?? answers.get(question.id),
      })),
      confirmedRequirements: [...session.confirmedRequirements],
      confirmedConstraints: [...session.confirmedConstraints],
      confirmedAcceptanceCriteria: [...session.confirmedAcceptanceCriteria],
      assumptions: [...session.assumptions],
      unresolvedRisks: [...session.unresolvedRisks],
      conversationStatus: session.conversationStatus,
    }),
    'answer open questions',
  );
  for (const question of answered.openQuestions) {
    console.log(`  answered "${question.id}": ${question.answer}`);
  }
  persistConversation(answered);
  return answered;
}

console.log(`Persisting to ${process.env.CODEX_LENS_DATA_DIR}`);

// (1) Start from the Draft seed conversation.
let session = makeSeedConversation();
console.log(
  `ConversationSession: created "${session.conversationId}" (status=${session.conversationStatus})`,
);
persistConversation(session);

// (2) Answer all open questions and walk Draft -> Clarifying -> ReadyForPlan.
session = transitionAndPersist(session, 'Clarifying');
session = answerOpenQuestions(session);
session = transitionAndPersist(session, 'ReadyForPlan');

// (3) Convert the ready conversation into a Draft Engineering Plan.
const conversion = unwrap(
  convertConversationToEngineeringPlan(session),
  'convert conversation to engineering plan',
);
console.log(
  `ConversationSession: ${session.conversationStatus} -> ${conversion.session.conversationStatus}`,
);
persistConversation(conversion.session);
let plan = conversion.plan;
console.log(
  `EngineeringPlan: created "${plan.engineeringPlanId}" (status=${plan.status})`,
);
persistPlan(plan);

// (4) Request approval: Draft -> ReadyForApproval.
const readyPlan = unwrap(requestApproval(plan), 'request plan approval');
console.log(`EngineeringPlan: ${plan.status} -> ${readyPlan.status}`);
plan = readyPlan;
persistPlan(plan);

// (5) Approve with an approval pinned to the plan's version and digest.
const outcome = unwrap(
  approvePlan(plan, {
    approvalId: randomUUID(),
    approvedBy: 'demo-reviewer@codex-lens.local',
    approvalTimestamp: new Date().toISOString(),
    approvalType: 'EngineeringPlanApproval',
    notes: 'Approved during the end-to-end demo run.',
    pinnedVersion: plan.version,
    pinnedContentDigest: plan.contentDigest,
  }),
  'approve plan',
);
console.log(`EngineeringPlan: ${plan.status} -> ${outcome.plan.status}`);
plan = outcome.plan;
persistPlan(plan);

console.log(
  `EngineeringPlan Approved (version=${plan.version}, digest=${plan.contentDigest})`,
);
console.log('DEMO COMPLETE');
