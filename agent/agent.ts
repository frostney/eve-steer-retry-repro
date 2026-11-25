import { defineAgent } from "eve";

import { scriptedModel } from "./lib/scripted-model.js";

export default defineAgent({
  model: scriptedModel,
  modelContextWindowTokens: 100_000,
});
