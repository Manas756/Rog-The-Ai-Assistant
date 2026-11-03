// Runtime validation for every payload a renderer can send.
import { z } from 'zod';

export const ipcSchemas = {
  orbMicStatus: z.object({ open: z.boolean(), error: z.string().max(200).optional(), label: z.string().max(200).optional() }),
  orbInteractive: z.boolean(),
  orbDrag: z.object({ dx: z.number().finite().min(-2000).max(2000), dy: z.number().finite().min(-2000).max(2000) }),
  orbConfirm: z.boolean(),
  id: z.string().min(1).max(64),
  text: z.string().trim().min(1).max(300),
  apiKey: z.string().trim().min(8).max(400),
  boolean: z.boolean(),
  pickExecutable: z.object({ title: z.string().max(80).optional() }).optional(),
};
