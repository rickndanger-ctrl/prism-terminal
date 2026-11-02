export const CONSEQUENTIAL_ACTION_CATEGORIES = [
  'external-communication',
  'destructive-file-operation',
  'software-installation',
  'source-control-or-release',
  'security-or-account-change',
  'financial-or-legal-action',
] as const;

export type ConsequentialActionCategory = typeof CONSEQUENTIAL_ACTION_CATEGORIES[number];
export type ActionExecutionScope = 'computer' | 'mac' | 'project';

export interface ActionConfirmationContext {
  scope: ActionExecutionScope;
}

export interface ActionConfirmationPolicy {
  requiresExplicitConfirmation: boolean;
  category?: ConsequentialActionCategory;
  confirmationReason?: string;
}

interface CategoryRule {
  category: ConsequentialActionCategory;
  reason: string;
  patterns: readonly RegExp[];
}

/*
 * These expressions identify actions that can cross an important boundary.
 * They are deliberately broader than the safe-action allowlist below. A false
 * positive costs one confirmation; a false negative could run with full Mac
 * authority.
 */
const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: 'external-communication',
    reason: 'This would communicate, submit, publish, schedule, or upload something externally.',
    patterns: [
      /\b(?:do\s+not|don't|dont|never)\s+(?:forget|fail|hesitate)\s+to\s+(?:send|email|message|text|post|submit|share|upload|publish|reply|forward|dm|tweet|comment|invite|call|book|reserve|schedule|apply|rsvp|follow|like|react|accept)\b/giu,
      /(?:^|[.!?;]\s*|\b(?:then|and|also|please|kindly|now|go ahead(?: and)?|i (?:need|want) you to|can you|could you|would you|will you)\s+)(?:send|email|message|text|post|submit|share|upload|publish|reply|forward|dm|tweet|comment|invite|call)\b/giu,
      /(?:^|[.!?;]\s*|\b(?:then|and|also|please|kindly|now|go ahead(?: and)?|i (?:need|want) you to|can you|could you|would you|will you)\s+)(?:book|reserve|schedule|apply|rsvp|follow|like|react|accept)\b/giu,
      /\b(?:create|add|send|accept)\s+(?:a\s+|an\s+|the\s+|my\s+)?(?:calendar\s+)?(?:event|appointment|meeting|invitation|invite|comment|issue|ticket)\b/giu,
      /\b(?:create|open|add)\s+.{0,60}\b(?:github|gitlab|jira|linear|public)\s+.{0,40}\b(?:issue|ticket|comment|post)\b/giu,
      /(?:^|[.!?;]\s*|\b(?:then|and|also|please|kindly|now)\s+)tell\s+[\p{L}\p{N}][\p{L}\p{N}'-]*(?:\s+that)?\b/giu,
      /\b(?:make|place|start)\s+(?:a\s+|the\s+)?(?:phone|video|audio)?\s*call\b/giu,
      /\b(?:upload|attach)\s+(?:\/|~\/|\.\/|[A-Za-z]:\\|[^\s]+\.(?:zip|pdf|png|jpe?g|docx?|xlsx?|mov|mp4))\S*/giu,
      /\b(?:click|press|choose|select|tap)\s+(?:the\s+)?(?:send|post|submit|share|upload|publish|apply|book|reserve|schedule)\b/giu,
    ],
  },
  {
    category: 'destructive-file-operation',
    reason: 'This could delete, overwrite, discard, wipe, or irreversibly alter data.',
    patterns: [
      /\b(?:do\s+not|don't|dont|never)\s+(?:forget|fail|hesitate)\s+to\s+(?:delete|erase|remove|trash|wipe|destroy|drop|truncate|discard|purge|prune|overwrite|replace|clear|empty|format)\b/giu,
      /(?:^|[.!?;]\s*|\b(?:then|and|also|please|kindly|now|go ahead(?: and)?|i (?:need|want) you to|can you|could you|would you|will you)\s+)(?:delete|erase|remove|trash|wipe|destroy|drop|truncate|discard|purge|prune|overwrite|replace|clear|empty|format)\b/giu,
      /(?:^|[.!?;]\s*)\s*(?:sudo\s+)?(?:rm|rmdir|unlink)\b/giu,
      /\b(?:rm|rmdir|unlink)\s+(?:-[A-Za-z]+\s+)*(?:\/|~\/|\.\/|\.\.\/)/giu,
      /\b(?:move|send|put)\s+.{0,120}\b(?:to|in|into)\s+(?:the\s+)?trash\b/giu,
      /\b(?:drop|truncate)\s+(?:the\s+)?(?:production\s+|staging\s+)?(?:database|schema|table|collection)\b/giu,
      /\b(?:factory reset|restore factory settings|discard (?:all\s+)?unsaved changes)\b/giu,
      /\b(?:by|then|and)\s+(?:deleting|erasing|removing|trashing|wiping|dropping|truncating|discarding|overwriting|replacing|clearing)\b/giu,
      /\b(?:click|press|choose|select|tap)\s+(?:the\s+)?(?:delete|erase|trash|empty trash|discard|overwrite|replace)\b/giu,
    ],
  },
  {
    category: 'software-installation',
    reason: 'This would install, uninstall, update, enable, or execute software.',
    patterns: [
      /\b(?:do\s+not|don't|dont|never)\s+(?:forget|fail|hesitate)\s+to\s+(?:install|uninstall|reinstall|update|upgrade|downgrade|enable|activate|execute)\b/giu,
      /(?:^|[.!?;]\s*|\b(?:then|and|also|please|kindly|now|go ahead(?: and)?|i (?:need|want) you to|can you|could you|would you|will you)\s+)(?:install|uninstall|reinstall)\b/giu,
      /(?:^|[.!?;]\s*|\b(?:then|and|also|please|kindly|now|go ahead(?: and)?|i (?:need|want) you to|can you|could you|would you|will you)\s+)(?:update|upgrade|downgrade)\s+(?:the\s+|my\s+)?(?:app|application|software|program|package|extension|plugin|driver|sdk|framework|tool|dependency|dependencies|xcode|macos|ios|ipados|watchos|tvos|windows|chrome|safari|firefox|homebrew)\b/giu,
      /\b(?:npm|pnpm|yarn|bun|pipx?|uv(?:\s+tool)?|poetry|cargo|brew|gem|bundle|pod|mas)\s+(?:i|install|add|update|upgrade|remove|uninstall)\b/giu,
      /\b(?:curl|wget)\b.{0,240}(?:\||&&|;)\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|python\d*|ruby|node)\b/giu,
      /(?:^|[.!?;]\s*|\b(?:then|and|also|please|kindly|now|go ahead(?: and)?)\s+)(?:open|run|launch|execute|start)\s+.{0,120}(?:downloaded|installer|setup|install|\.dmg\b|\.pkg\b|\.app\b|\.sh\b|\.command\b)/giu,
      /(?:^|[.!?;]\s*|\b(?:then|and|also|please|kindly|now)\s+)(?:enable|activate|load)\s+.{0,80}\b(?:extension|plugin|driver|kernel extension|system extension)\b/giu,
      /\b(?:click|press|choose|select|tap)\s+(?:the\s+)?(?:install|uninstall|update|upgrade|run installer|open installer|enable extension)\b/giu,
    ],
  },
  {
    category: 'source-control-or-release',
    reason: 'This would change shared source control or publish, deploy, or release work.',
    patterns: [
      /\b(?:do\s+not|don't|dont|never)\s+(?:forget|fail|hesitate)\s+to\s+(?:commit|push|merge|rebase|reset|clean|tag|pull|revert|deploy|publish|release|ship)\b/giu,
      /\bgit\s+(?:commit|push|merge|rebase|reset|clean|tag|pull|revert|cherry-pick|checkout|switch)\b/giu,
      /(?:^|[.!?;]\s*|\b(?:then|and|also|please|kindly|now|go ahead(?: and)?|i (?:need|want) you to|can you|could you|would you|will you)\s+)(?:commit|push|force[- ]?push|merge|rebase|reset|tag|pull|revert|cherry-pick)\b/giu,
      /(?:^|[.!?;]\s*|\b(?:then|and|also|please|kindly|now|go ahead(?: and)?|i (?:need|want) you to|can you|could you|would you|will you)\s+)(?:deploy|release|ship)\b/giu,
      /\bpublish\s+(?:the\s+|this\s+|a\s+)?(?:app|application|build|site|website|service|project|release|package|library)\b/giu,
      /\b(?:create|publish|cut|open)\s+(?:a\s+|the\s+)?(?:github\s+|gitlab\s+)?release\b/giu,
      /\b(?:create|open|merge|approve|close)\s+(?:a\s+|the\s+|this\s+)?(?:pull request|merge request|pr)\b/giu,
      /\b(?:delete|remove)\s+(?:the\s+|a\s+)?(?:local\s+|remote\s+)?(?:git\s+)?branch\b/giu,
      /\bpublish\s+(?:it\s+)?to\s+(?:npm|pypi|rubygems|crates\.io|production|testflight|the app store)\b/giu,
      /\b(?:click|press|choose|select|tap)\s+(?:the\s+)?(?:commit|push|merge|deploy|publish|release|ship)\b/giu,
    ],
  },
  {
    category: 'security-or-account-change',
    reason: 'This would change security, permissions, authentication, system access, or an account.',
    patterns: [
      /(?:^|[.!?;]\s*|\b(?:then|and|also|please|kindly|now|go ahead(?: and)?|i (?:need|want) you to|can you|could you|would you|will you)\s+)(?:sign|log)\s+(?:in|into|out|off)\b/giu,
      /\b(?:change|reset|remove|disable|enable|grant|revoke|approve|deny|allow|block|unlock|lock|regenerate|rotate|create|delete|close|add|give)\s+.{0,120}\b(?:password|passcode|permission|permissions|privacy|security|account|profile|user|administrator|admin|login|sign-in|signin|authentication|authorization|credential|credentials|api key|token|passkey|keychain|firewall|encryption|two-factor|2fa|access|touch id|face id|full disk access)\b/giu,
      /\b(?:sudo|chmod|chown|chflags|spctl|xattr)\b/giu,
      /\b(?:change|set|configure|reset|enable|disable|turn on|turn off|start|stop)\s+.{0,120}\b(?:system setting|privacy setting|network|wi-?fi|vpn|dns|proxy|sharing|screen sharing|remote access|remote login|ssh|firewall|bluetooth|location services|filevault|gatekeeper|sip)\b/giu,
      /\brestore factory settings\b/giu,
      /\b(?:click|press|choose|select|tap)\s+(?:the\s+)?(?:allow|deny|grant|revoke|sign in|log in|sign out|log out|change password|reset password|trust|always allow)\b/giu,
    ],
  },
  {
    category: 'financial-or-legal-action',
    reason: 'This would make a financial transaction, purchase, subscription change, or legal commitment.',
    patterns: [
      /\b(?:do\s+not|don't|dont|never)\s+(?:forget|fail|hesitate)\s+to\s+(?:buy|purchase|order|pay|checkout|transfer|wire|withdraw|deposit|trade|sell|refund|subscribe|unsubscribe|cancel|donate|bid|bet|wager|sign|accept|file|submit)\b/giu,
      /(?:^|[.!?;]\s*|\b(?:then|and|also|please|kindly|now|go ahead(?: and)?|i (?:need|want) you to|can you|could you|would you|will you)\s+)(?:buy|purchase|order|pay|checkout|transfer|wire|withdraw|deposit|trade|sell|refund|subscribe|unsubscribe|cancel|donate|bid|bet|wager)\b/giu,
      /\bsend\s+(?:[$£€¥]|\d+(?:\.\d{1,2})?\s+(?:dollars?|usd|eur|gbp))\b/giu,
      /\b(?:sign|accept|agree to|file|submit)\s+.{0,120}\b(?:contract|agreement|terms|waiver|legal|tax|taxes|return|filing|plea|settlement)\b/giu,
      /\b(?:book|reserve)\s+.{0,120}\b(?:flight|hotel|car|rental|trip|ticket|room)\b/giu,
      /\b(?:cancel|change|renew)\s+.{0,80}\b(?:subscription|membership|insurance|order|purchase|reservation|booking)\b/giu,
      /\b(?:click|press|choose|select|tap)\s+(?:the\s+)?(?:buy|purchase|order|pay|checkout|transfer|trade|sell|subscribe|accept terms|agree|sign)\b/giu,
    ],
  },
];

/**
 * Ignore only a directly negated or directly educational reference. Do not
 * skip wrappers such as "don't forget to delete" or "never hesitate to send":
 * those are affirmative requests despite containing a negative word.
 */
function isNonExecutingReference(text: string, index: number): boolean {
  const prefix = text.slice(Math.max(0, index - 96), index);
  const directlyNegated = /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not|cannot|can't|cant|won't|wont)\s*$/iu.test(prefix);
  const directlyEducational = /\b(?:draft|prepare|compose|write|preview|plan|describe|explain|simulate)(?:\s+(?:a|an|the))?(?:\s+(?:example|sample|draft|plan|instructions?|steps?|command|script))?(?:\s+how)?(?:\s+to)?\s*$/iu.test(prefix)
    || /\b(?:show|tell)\s+me\s+how\s+to\s*$/iu.test(prefix);
  return directlyNegated || directlyEducational;
}

function matchedCategory(text: string): CategoryRule | undefined {
  const priority: readonly ConsequentialActionCategory[] = [
    'financial-or-legal-action',
    'security-or-account-change',
    'source-control-or-release',
    'software-installation',
    'destructive-file-operation',
    'external-communication',
  ];
  for (const category of priority) {
    const rule = CATEGORY_RULES.find((candidate) => candidate.category === category);
    if (rule === undefined) continue;
    for (const pattern of rule.patterns) {
      pattern.lastIndex = 0;
      let match = pattern.exec(text);
      while (match !== null) {
        if (!isNonExecutingReference(text, match.index)) return rule;
        match = pattern.exec(text);
      }
    }
  }
  return undefined;
}

/**
 * Gateway-owned policy. One complete wearer utterance starts ordinary work.
 * A second confirmation remains only for categories that cross an external,
 * destructive, installation, release, security, financial, or legal boundary.
 * The model cannot label its own request safe.
 */
export function actionConfirmationPolicy(
  instruction: string,
  context: ActionConfirmationContext,
): ActionConfirmationPolicy {
  void context;
  const text = instruction.trim();
  const category = matchedCategory(text);
  if (category !== undefined) {
    return {
      requiresExplicitConfirmation: true,
      category: category.category,
      confirmationReason: category.reason,
    };
  }

  return { requiresExplicitConfirmation: false };
}
