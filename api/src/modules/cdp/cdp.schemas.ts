import { z } from "zod";

export const GetDevtoolsUrlSchema = z.object({
  pageId: z.string().optional(),
  sessionId: z.string().uuid().optional(),
});

export default {
  GetDevtoolsUrlSchema,
};
