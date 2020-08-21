import { Harmony } from '@teambit/harmony';
import { Workspace } from '@teambit/workspace';
import { CreateCmd } from './create.cmd';
import { Create, Registry } from './create';
import { CreateExtConfig } from './types';
import { CLIMain } from '@teambit/cli';

export type CreateConfig = {};

export type CreateDeps = [CLIMain, Workspace];

export async function provideCreate(
  [cli, workspace]: CreateDeps,
  config: CreateExtConfig,
  _slots,
  harmony: Harmony
): Promise<Create> {
  const create = new Create(config, workspace, new Registry(harmony));
  cli.register(new CreateCmd(create));
  return create;
}
