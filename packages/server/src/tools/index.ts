import { assetTools } from './asset-tools';
import { editorTools } from './editor-tools';
import { fileTools, historyTools } from './file-tools';
import { memoryTools } from './memory-tools';
import { planTools } from './plan-tools';
import { prefabTools } from './prefab-tools';
import { itemTools } from './item-tools';
import { ToolRegistry } from './registry';
import { ruleTools } from './rule-tools';
import { runtimeTools } from './runtime-tools';
import { sceneTools } from './scene-tools';
import { verifyTools } from './verify-tools';

export * from './registry';
export { changeInfo, entitySummary, gameObjectOf } from './scene-tools';

/** Project-editing tools (stage 3) and the project memory. */
export function createEditingTools() {
  return new ToolRegistry([...sceneTools, ...prefabTools, ...itemTools, ...ruleTools, ...assetTools, ...fileTools, ...historyTools, ...memoryTools]);
}

/** Everything the agent can use: editing tools plus runtime tools (these need a RuntimeHost in the context). */
export function createAgentTools() {
  return new ToolRegistry([...sceneTools, ...prefabTools, ...itemTools, ...ruleTools, ...assetTools, ...fileTools, ...historyTools, ...memoryTools, ...editorTools, ...runtimeTools, ...verifyTools, ...planTools]);
}
