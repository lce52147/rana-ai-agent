export * from "../tool_contracts.js";
export * from "../context_store.js";
export * from "../architecture/pre_dispatch.js";
export * from "../architecture/model_tool_guidance.js";
export * from "../output_guard.js";

import { __test as contractsTest } from "../tool_contracts.js";
import { __test as contextTest } from "../context_store.js";
import { __test as preDispatchTest } from "../architecture/pre_dispatch.js";
import { __test as modelToolGuidanceTest } from "../architecture/model_tool_guidance.js";
import { __test as outputGuardTest } from "../output_guard.js";

export const __test = {
  ...contractsTest,
  ...contextTest,
  ...preDispatchTest,
  ...modelToolGuidanceTest,
  ...outputGuardTest,
};
