import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const historySchema = {
  type: 'array',
  description: 'Previous conversation turns for multi-turn interactions',
  items: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: ['user', 'model'] },
      content: { type: 'string' },
    },
    required: ['role', 'content'],
  },
} as const;

export const peerReviewTool: Tool = {
  name: 'peer_review',
  description: `Ask a weighted quorum of external LLM peers the same question and get a consensus answer with a machine-consumable certainty score.

Use this tool when you need:
- A second opinion validated across multiple independent models, not just one
- A confidence signal (certaintyScore 0-1) you can act on programmatically
- Design/code review sign-off where agreement between models matters

Sources are consulted in cost tiers: cheap tier-1 peers first, escalating to higher tiers only if agreement falls short of the configured weight threshold. The response itemizes every consulted source with its status and agreement rating, so degraded quorums (failed or unavailable peers) are always visible. An unmet quorum is NOT an error — inspect quorum.achieved and certaintyScore.`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The question or content to put before the peer quorum.',
        minLength: 1,
        maxLength: 100000,
      },
      history: historySchema,
      tier: {
        type: 'integer',
        description:
          'Highest tier to escalate to (defaults to the full configured stack). Lower = cheaper.',
        minimum: 1,
      },
      callerAnswer: {
        type: 'string',
        description:
          "Your own answer to the prompt. Never shown to peers — they answer blind, so their independence is preserved. The arbiter rates it against the peer consensus (zero quorum weight; it cannot self-certify) and the response returns the rating as callerAgreement.",
        minLength: 1,
        maxLength: 100000,
      },
    },
    required: ['prompt'],
  },
};

export const queryPeerTool: Tool = {
  name: 'query_peer',
  description: `Query a single configured external LLM peer directly (no quorum, one outbound call).

Use this tool when you need:
- A quick second opinion from one specific outside model
- The cheap path: exactly one LLM call instead of a full peer_review fan-out

Defaults to the lowest-tier highest-weight source; pass "source" to pick a configured peer by name (see list_peers).`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The prompt to send to the peer. Be specific and clear.',
        minLength: 1,
        maxLength: 100000,
      },
      history: historySchema,
      source: {
        type: 'string',
        description: 'Configured source name to query (see list_peers). Optional.',
      },
    },
    required: ['prompt'],
  },
};

export const listPeersTool: Tool = {
  name: 'list_peers',
  description:
    'List the configured peer sources with their API type, model, weight, tier, and current availability (whether a credential is resolvable). Use before query_peer to discover valid source names.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export const countTokensTool: Tool = {
  name: 'count_tokens',
  description: `Count tokens in a text using a configured source's tokenizer.

The response's "method" field tells you how the count was produced: "api" (provider count endpoint, exact) or "estimate" (ceil(chars/4) heuristic for providers without a count endpoint).`,
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to count tokens for.',
        minLength: 1,
        maxLength: 1000000,
      },
      source: {
        type: 'string',
        description: 'Configured source name whose tokenizer to use. Optional.',
      },
    },
    required: ['text'],
  },
};
