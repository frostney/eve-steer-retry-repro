import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Write a note.",
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ written: text.length }),
});
