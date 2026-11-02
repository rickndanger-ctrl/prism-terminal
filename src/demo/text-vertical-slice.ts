import { pathToFileURL } from 'node:url';

import {
  ApprovalStatus,
  ApprovalTargetType,
  approvePlan,
  convertConversationToEngineeringPlan,
  createApprovalContract,
  createConversationSession,
  createExecutionPlanFromApproval,
  requestApproval,
  transitionApprovalContract,
  transitionConversationSession,
  type Result,
} from '@codex-lens/shared';
import {
  assertExecutionApproved,
  createTask,
  type Task,
} from '@codex-lens/gateway';
import { openDb } from '../../packages/gateway/src/db/schema.js';

const DEMO_TIME = '2026-07-20T12:00:00.000Z';

export interface TextVerticalSliceResult {
  readonly task: Task;
  readonly transcript: readonly string[];
}

function unwrap<T>(result: Result<T>, step: string): T {
  if (!result.ok) {
    throw new Error(`${step}: [${result.error.code}] ${result.error.message}`);
  }
  return result.value;
}

export function runTextVerticalSlice(): TextVerticalSliceResult {
  const transcript: string[] = [];
  const draftConversation = unwrap(
    createConversationSession({
      conversationId: 'demo-conversation',
      projectName: 'Codex Lens',
      userGoal: 'Demonstrate the approved planning protocol for smart glasses.',
      background: 'Codex Lens is a glasses-first engineering assistant.',
      openQuestions: [
        {
          id: 'surface',
          question: 'What is the primary product surface?',
          answer:
            'Smart glasses are primary; text is a deterministic protocol demo.',
        },
      ],
      confirmedRequirements: ['Queue Codex only after both approvals.'],
      confirmedConstraints: ['Keep the demo deterministic and text-only.'],
      confirmedAcceptanceCriteria: ['The final Codex task is queued.'],
      assumptions: ['The local gateway task queue is available.'],
      unresolvedRisks: [
        'The text demo does not replace glasses hardware validation.',
      ],
      conversationStatus: 'Draft',
    }),
    'create conversation',
  );
  const clarifying = unwrap(
    transitionConversationSession(draftConversation, 'Clarifying'),
    'clarify conversation',
  );
  const readyConversation = unwrap(
    transitionConversationSession(clarifying, 'ReadyForPlan'),
    'finish conversation',
  );
  transcript.push('1. Conversation: ready for planning');

  const conversion = unwrap(
    convertConversationToEngineeringPlan(readyConversation),
    'create Engineering Plan',
  );
  transcript.push('2. Engineering Plan: ready for approval');
  const engineeringApproval = unwrap(
    approvePlan(
      unwrap(requestApproval(conversion.plan), 'request engineering approval'),
      {
        approvalId: 'demo-engineering-approval',
        approvedBy: 'demo-reviewer',
        approvalTimestamp: DEMO_TIME,
        approvalType: 'EngineeringPlanApproval',
        notes: 'Deterministic demo approval.',
      },
    ),
    'approve Engineering Plan',
  );
  transcript.push('3. Engineering approval: approved');

  const executionPlan = unwrap(
    createExecutionPlanFromApproval(
      engineeringApproval.approval,
      engineeringApproval.plan,
      {
        filesToModify: ['src/demo/text-vertical-slice.ts'],
        filesToCreate: [],
        filesToDelete: [],
        implementationSteps: ['Run the approved deterministic text slice.'],
        expectedCommands: ['npm run demo'],
        estimatedRisk: 'Low',
        estimatedComplexity: 'Low',
        estimatedDuration: 1,
        rollbackStrategy: 'Remove the demo entry point.',
        executionStatus: 'Pending',
      },
    ),
    'create Execution Plan',
  );
  transcript.push('4. Execution Plan: ready for approval');

  const pendingExecutionApproval = unwrap(
    createApprovalContract({
      approvalId: 'demo-execution-approval',
      approvedBy: 'demo-reviewer',
      approvalTimestamp: DEMO_TIME,
      approvalType: 'ExecutionPlanApproval',
      notes: 'Deterministic demo execution approval.',
      approvalStatus: ApprovalStatus.Pending,
      target: {
        targetType: ApprovalTargetType.ExecutionPlan,
        targetId: executionPlan.executionPlanId,
        targetVersion: executionPlan.version,
        targetContentDigest: executionPlan.contentDigest,
      },
    }),
    'create execution approval',
  );
  const executionApproval = unwrap(
    transitionApprovalContract(
      pendingExecutionApproval,
      ApprovalStatus.Approved,
    ),
    'approve Execution Plan',
  );
  unwrap(
    assertExecutionApproved(executionPlan, executionApproval),
    'verify execution approval',
  );
  transcript.push('5. Execution approval: approved');

  const db = openDb(':memory:');
  try {
    const task = unwrap(
      createTask(db, {
        projectId: 'codex-lens-demo',
        idempotencyKey: 'text-vertical-slice-v1',
      }),
      'queue Codex task',
    );
    transcript.push('6. Codex task: queued');
    return Object.freeze({ task, transcript: Object.freeze(transcript) });
  } finally {
    db.close();
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  const result = runTextVerticalSlice();
  console.log('Codex Lens deterministic text vertical slice');
  for (const line of result.transcript) console.log(line);
  console.log('DEMO COMPLETE');
}
