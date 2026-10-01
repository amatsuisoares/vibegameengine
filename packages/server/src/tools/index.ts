import { fileTools, historyTools } from './file-tools';
import { ToolRegistry } from './registry';
import { runtimeTools } from './runtime-tools';
import { sceneTools } from './scene-tools';

export * from './registry';
export { changeInfo, entitySummary } from './scene-tools';

/** Project-editing tools (stage 3). */
export function createEditingTools() {
  return new ToolRegistry([...sceneTools, ...fileTools, ...historyTools]);
}

/** Everything the agent can use: editing tools plus runtime tools (these need a RuntimeHost in the context). */
export function createAgentTools() {
  return new ToolRegistry([...sceneTools, ...fileTools, ...historyTools, ...runtimeTools]);
}
