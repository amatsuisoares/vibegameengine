import { fileTools, historyTools } from './file-tools';
import { ToolRegistry } from './registry';
import { sceneTools } from './scene-tools';

export * from './registry';
export { changeInfo, entitySummary } from './scene-tools';

/** Project-editing tools (stage 3). Runtime tools are added in stage 4. */
export function createEditingTools() {
  return new ToolRegistry([...sceneTools, ...fileTools, ...historyTools]);
}
