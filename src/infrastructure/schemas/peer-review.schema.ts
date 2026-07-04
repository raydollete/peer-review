import { z } from 'zod';

const HistorySchema = z.array(
  z.object({
    role: z.enum(['user', 'model']),
    content: z.string(),
  }),
);

// .strict(): client-supplied generation params (model, temperature, …) are rejected —
// those values are injected server-side from config only.
export const PeerReviewInputSchema = z
  .object({
    prompt: z.string().min(1).max(100000),
    history: HistorySchema.optional(),
    tier: z.number().int().positive().optional(),
  })
  .strict();

export const QueryPeerInputSchema = z
  .object({
    prompt: z.string().min(1).max(100000),
    history: HistorySchema.optional(),
    source: z.string().min(1).optional(),
  })
  .strict();

export const CountTokensInputSchema = z
  .object({
    text: z.string().min(1).max(1000000),
    source: z.string().min(1).optional(),
  })
  .strict();
