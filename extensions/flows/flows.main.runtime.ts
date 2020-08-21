import { Flows } from './flows';
import { WorkspaceAspect, Workspace } from '@teambit/workspace';
import { FlowsAspect } from './flows.aspect';
import { MainRuntime } from '@teambit/cli';

type ScriptDeps = [Workspace];

export const FlowsMain = {
  name: 'flows',
  runtime: MainRuntime,
  dependencies: [WorkspaceAspect],
  async provider([workspace]: ScriptDeps) {
    const flows = new Flows(workspace);
    // const runCMD = new RunCmd(flows, reporter, logger);
    // cli.register(runCMD);
    return flows;
  },
};

FlowsAspect.addRuntime(FlowsMain);
