import semver from 'semver';
import { isEmpty } from 'lodash';
import {
  DependencyResolverAspect,
  DependencyResolverMain,
  WorkspacePolicy,
  WorkspacePolicyConfigKeysNames,
  WorkspacePolicyEntry,
} from '@teambit/dependency-resolver';
import tempy from 'tempy';
import fs from 'fs-extra';
import { MainRuntime } from '@teambit/cli';
import { WorkspaceAspect, Workspace } from '@teambit/workspace';
import { Logger, LoggerAspect, LoggerMain } from '@teambit/logger';
import ConsumerComponent from '@teambit/legacy/dist/consumer/component';
import { DEPENDENCIES_FIELDS } from '@teambit/legacy/dist/constants';
import { BitError } from '@teambit/bit-error';
import mergeFiles, { MergeFileParams } from '@teambit/legacy/dist/utils/merge-files';
import { ConfigAspect, ConfigMain } from '@teambit/config';
import { ConfigMergeResult, parseVersionLineWithConflict } from './config-merge-result';
import { ConfigMergerAspect } from './config-merger.aspect';

type PkgEntry = { name: string; version: string; force: boolean };

const WS_DEPS_FIELDS = ['dependencies', 'peerDependencies'];

export type WorkspaceDepsUpdates = { [pkgName: string]: [string, string] }; // from => to
export type WorkspaceDepsConflicts = Record<WorkspacePolicyConfigKeysNames, Array<{ name: string; version: string }>>; // the pkg value is in a format of CONFLICT::OURS::THEIRS

export type WorkspaceConfigUpdateResult = {
  workspaceDepsUpdates?: WorkspaceDepsUpdates; // in case workspace.jsonc has been updated with dependencies versions
  workspaceDepsConflicts?: WorkspaceDepsConflicts; // in case workspace.jsonc has conflicts
  workspaceConfigConflictWriteError?: Error; // in case workspace.jsonc has conflicts and we failed to write the conflicts to the file
  logs?: string[]; // verbose details about the updates/conflicts for each one of the deps
};
export class ConfigMergerMain {
  constructor(
    private workspace: Workspace,
    private logger: Logger,
    private config: ConfigMain,
    private depsResolver: DependencyResolverMain
  ) {}

  async generateConfigMergeConflictFileForAll(allConfigMerge: ConfigMergeResult[]) {
    const configMergeFile = this.workspace.getConflictMergeFile();
    allConfigMerge.forEach((configMerge) => {
      const conflict = configMerge.generateMergeConflictFile();
      if (!conflict) return;
      configMergeFile.addConflict(configMerge.compIdStr, conflict);
    });
    if (configMergeFile.hasConflict()) {
      await configMergeFile.write();
    }
  }

  async writeWorkspaceJsoncWithConflictsGracefully(
    workspaceDepsConflicts: WorkspaceDepsConflicts
  ): Promise<Error | undefined> {
    try {
      await this.writeWorkspaceJsoncWithConflicts(workspaceDepsConflicts);
      return undefined;
    } catch (err: any) {
      this.logger.error(`unable to write workspace.jsonc with conflicts`, err);
      const errTitle = `unable to write workspace.jsonc with conflicts, due to an error: "${err.message}".
see the conflicts below and edit your workspace.jsonc as you see fit.`;
      const conflictsStr = WS_DEPS_FIELDS.map((depField) => {
        if (!workspaceDepsConflicts[depField]) return [];
        return workspaceDepsConflicts[depField].map(({ name, version }) => {
          const { currentVal, otherVal } = parseVersionLineWithConflict(version);
          return `(${depField}) ${name}: ours: ${currentVal}, theirs: ${otherVal}`;
        });
      })
        .flat()
        .join('\n');
      return new BitError(`${errTitle}\n${conflictsStr}`);
    }
  }

  private async writeWorkspaceJsoncWithConflicts(workspaceDepsConflicts: WorkspaceDepsConflicts) {
    const wsConfig = this.config.workspaceConfig;
    if (!wsConfig) throw new Error(`unable to get workspace config`);
    const wsJsoncPath = wsConfig.path;
    const wsJsoncOriginalContent = await fs.readFile(wsJsoncPath, 'utf8');
    let wsJsoncContent = wsJsoncOriginalContent;
    WS_DEPS_FIELDS.forEach((depField) => {
      if (!workspaceDepsConflicts[depField]) return;
      workspaceDepsConflicts[depField].forEach(({ name, version }) => {
        const { currentVal, otherVal } = parseVersionLineWithConflict(version);
        // e.g. "@ci/8oypmb6p-remote.bar.foo": "^0.0.3"
        const originalDep = `"${name}": "${currentVal}"`;
        if (!wsJsoncContent.includes(originalDep)) {
          throw new Error(`unable to find the dependency ${originalDep} in the workspace.jsonc`);
        }
        wsJsoncContent = wsJsoncContent.replace(originalDep, `"${name}": "${otherVal}"`);
      });
    });

    const baseFilePath = await tempy.write('');
    const otherFilePath = await tempy.write(wsJsoncContent);
    const mergeFilesParams: MergeFileParams = {
      filePath: wsJsoncPath,
      currentFile: {
        label: 'ours',
        path: wsJsoncPath,
      },
      baseFile: {
        path: baseFilePath,
      },
      otherFile: {
        label: 'theirs',
        path: otherFilePath,
      },
    };
    const mergeResult = await mergeFiles(mergeFilesParams);
    const conflictFile = mergeResult.conflict;
    if (!conflictFile) {
      this.logger.debug(`original content:\n${wsJsoncOriginalContent}`);
      this.logger.debug(`new content:\n${wsJsoncContent}`);
      throw new Error('unable to generate conflict from the workspace.jsonc file. see debug.log for the file content');
    }
    await wsConfig.backupConfigFile('before writing conflicts');
    this.logger.debug('writing workspace.jsonc with conflicts');
    await fs.writeFile(wsJsoncPath, conflictFile);
  }

  async updateWorkspaceJsoncWithDepsIfNeeded(
    allConfigMerge: ConfigMergeResult[]
  ): Promise<{ workspaceDepsUpdates?: WorkspaceDepsUpdates; workspaceDepsConflicts?: WorkspaceDepsConflicts }> {
    const allResults = allConfigMerge.map((c) => c.getDepsResolverResult());

    // aggregate all dependencies that can be updated (not conflicting)
    const nonConflictDeps: { [pkgName: string]: string[] } = {};
    const nonConflictSources: { [pkgName: string]: string[] } = {}; // for logging/debugging purposes
    allConfigMerge.forEach((configMerge) => {
      const mergedConfig = configMerge.getDepsResolverResult()?.mergedConfig;
      if (!mergedConfig || mergedConfig === '-') return;
      const mergedConfigPolicy = mergedConfig.policy || {};
      DEPENDENCIES_FIELDS.forEach((depField) => {
        if (!mergedConfigPolicy[depField]) return;
        mergedConfigPolicy[depField].forEach((pkg: PkgEntry) => {
          if (pkg.force) return; // we only care about auto-detected dependencies
          if (nonConflictDeps[pkg.name]) {
            if (!nonConflictDeps[pkg.name].includes(pkg.version)) nonConflictDeps[pkg.name].push(pkg.version);
            nonConflictSources[pkg.name].push(configMerge.compIdStr);
            return;
          }
          nonConflictDeps[pkg.name] = [pkg.version];
          nonConflictSources[pkg.name] = [configMerge.compIdStr];
        });
      });
    });

    // aggregate all dependencies that have conflicts
    const conflictDeps: { [pkgName: string]: string[] } = {};
    const conflictDepsSources: { [pkgName: string]: string[] } = {}; // for logging/debugging purposes
    allConfigMerge.forEach((configMerge) => {
      const mergedConfigConflict = configMerge.getDepsResolverResult()?.conflict;
      if (!mergedConfigConflict) return;
      DEPENDENCIES_FIELDS.forEach((depField) => {
        if (!mergedConfigConflict[depField]) return;
        mergedConfigConflict[depField].forEach((pkg: PkgEntry) => {
          if (pkg.force) return; // we only care about auto-detected dependencies
          if (conflictDeps[pkg.name]) {
            if (!conflictDeps[pkg.name].includes(pkg.version)) conflictDeps[pkg.name].push(pkg.version);
            conflictDepsSources[pkg.name].push(configMerge.compIdStr);
            return;
          }
          conflictDeps[pkg.name] = [pkg.version];
          conflictDepsSources[pkg.name] = [configMerge.compIdStr];
        });
      });
    });

    const notConflictedPackages = Object.keys(nonConflictDeps);
    const conflictedPackages = Object.keys(conflictDeps);
    if (!notConflictedPackages.length && !conflictedPackages.length) return {};

    const workspaceConfig = this.config.workspaceConfig;
    if (!workspaceConfig) throw new Error(`updateWorkspaceJsoncWithDepsIfNeeded unable to get workspace config`);
    const depResolver = workspaceConfig.extensions.findCoreExtension(DependencyResolverAspect.id);
    const policy = depResolver?.config.policy;
    if (!policy) {
      return {};
    }

    // calculate the workspace.json updates
    const workspaceJsonUpdates = {};
    notConflictedPackages.forEach((pkgName) => {
      if (nonConflictDeps[pkgName].length > 1) {
        // we only want the deps that the other lane has them in the workspace.json and that all comps use the same dep.
        return;
      }
      DEPENDENCIES_FIELDS.forEach((depField) => {
        if (!policy[depField]?.[pkgName]) return; // doesn't exists in the workspace.json
        const currentVer = policy[depField][pkgName];
        const newVer = nonConflictDeps[pkgName][0];
        if (currentVer === newVer) return;
        workspaceJsonUpdates[pkgName] = [currentVer, newVer];
        policy[depField][pkgName] = newVer;
        this.logger.debug(
          `update workspace.jsonc: ${pkgName} from ${currentVer} to ${newVer}. Triggered by: ${nonConflictSources[
            pkgName
          ].join(', ')}`
        );
      });
    });

    // calculate the workspace.json conflicts
    const workspaceJsonConflicts = { dependencies: [], peerDependencies: [] };
    const conflictPackagesToRemoveFromConfigMerge: string[] = [];
    conflictedPackages.forEach((pkgName) => {
      if (conflictDeps[pkgName].length > 1) {
        // we only want the deps that the other lane has them in the workspace.json and that all comps use the same dep.
        return;
      }
      const conflictRaw = conflictDeps[pkgName][0];
      const [, currentVal, otherVal] = conflictRaw.split('::');

      WS_DEPS_FIELDS.forEach((depField) => {
        if (!policy[depField]?.[pkgName]) return;
        const currentVerInWsJson = policy[depField][pkgName];
        if (!currentVerInWsJson) return;
        // the version is coming from the workspace.jsonc
        conflictPackagesToRemoveFromConfigMerge.push(pkgName);
        if (semver.satisfies(otherVal, currentVerInWsJson)) {
          // the other version is compatible with the current version in the workspace.json
          return;
        }
        workspaceJsonConflicts[depField].push({
          name: pkgName,
          version: conflictRaw.replace(currentVal, currentVerInWsJson),
          force: false,
        });
        conflictPackagesToRemoveFromConfigMerge.push(pkgName);
        this.logger.debug(
          `conflict workspace.jsonc: ${pkgName} current: ${currentVerInWsJson}, other: ${otherVal}. Triggered by: ${conflictDepsSources[
            pkgName
          ].join(', ')}`
        );
      });
    });
    WS_DEPS_FIELDS.forEach((depField) => {
      if (isEmpty(workspaceJsonConflicts[depField])) delete workspaceJsonConflicts[depField];
    });

    if (conflictPackagesToRemoveFromConfigMerge.length) {
      allResults.forEach((result) => {
        if (result?.conflict) {
          DEPENDENCIES_FIELDS.forEach((depField) => {
            if (!result.conflict?.[depField]) return;
            result.conflict[depField] = result.conflict?.[depField].filter(
              (dep) => !conflictPackagesToRemoveFromConfigMerge.includes(dep.name)
            );
            if (!result.conflict[depField].length) delete result.conflict[depField];
          });
          if (isEmpty(result.conflict)) result.conflict = undefined;
        }
      });
    }

    if (Object.keys(workspaceJsonUpdates).length) {
      await workspaceConfig.write({ reasonForChange: 'merge (update dependencies)' });
    }

    this.logger.debug('final workspace.jsonc updates', workspaceJsonUpdates);
    this.logger.debug('final workspace.jsonc conflicts', workspaceJsonConflicts);

    return {
      workspaceDepsUpdates: Object.keys(workspaceJsonUpdates).length ? workspaceJsonUpdates : undefined,
      workspaceDepsConflicts: Object.keys(workspaceJsonConflicts).length ? workspaceJsonConflicts : undefined,
    };
  }

  async updateDepsInWorkspaceConfig(components: ConsumerComponent[]): Promise<WorkspaceConfigUpdateResult | undefined> {
    const workspacePolicy = this.depsResolver.getWorkspacePolicyFromConfig();
    const workspacePolicyObj = workspacePolicy.entries.reduce((acc, current) => {
      acc[current.dependencyId] = current.value.version;
      return acc;
    }, {});
    const componentDepsWithMultipleVer: Record<string, string[]> = {};
    components.forEach((component) => {
      const deps = this.depsResolver.getDependenciesFromLegacyComponent(component);
      deps.forEach((dep) => {
        if (dep.source !== 'auto') return;
        const depId = dep.idWithoutVersion;
        if (!workspacePolicyObj[depId]) return;
        if (workspacePolicyObj[depId] === dep.version) return;
        if (componentDepsWithMultipleVer[depId]?.includes(dep.version)) return;

        (componentDepsWithMultipleVer[depId] ||= []).push(dep.version);
      });
    });

    const compToLog = Object.keys(componentDepsWithMultipleVer)
      .map(
        (depId) =>
          `${depId} => workspace: ${workspacePolicyObj[depId]}, components: ${componentDepsWithMultipleVer[depId].join(
            ', '
          )}`
      )
      .join('\n');
    this.logger.info(`found the following deps to update/conflict:\n${compToLog}`);

    const componentDeps = Object.keys(componentDepsWithMultipleVer).reduce((acc, depId) => {
      // if there are different versions of this dep between the components, forget about it.
      if (componentDepsWithMultipleVer[depId].length > 1) return acc;
      acc[depId] = componentDepsWithMultipleVer[depId][0];
      return acc;
    }, {});

    if (isEmpty(componentDeps)) {
      return undefined;
    }

    const workspaceDepsUpdates: WorkspaceDepsUpdates = {};
    const workspaceDepsConflicts: WorkspaceDepsConflicts = { dependencies: [], peerDependencies: [] };

    const logs: string[] = [];

    Object.keys(componentDeps).forEach((depId) => {
      const depInCompVer: string = componentDeps[depId];
      const depInWsVer: string = workspacePolicyObj[depId];
      const isDepInCompVersion = Boolean(semver.valid(depInCompVer));
      const isDepInCompRange = !isDepInCompVersion && Boolean(semver.validRange(depInCompVer));

      const addNotUpdateToLogs = (reason: string) => {
        logs.push(`${depId} - not updating. ${reason}`);
      };

      if (!isDepInCompVersion && !isDepInCompRange) {
        addNotUpdateToLogs(`probably a snap-hash`);
        return; // probably a snap-hash.
      }
      const isDepInWsVersion = Boolean(semver.valid(depInWsVer));
      const isDepInWsRange = !isDepInWsVersion && Boolean(semver.validRange(depInWsVer));
      if (!isDepInWsVersion && !isDepInWsRange) {
        addNotUpdateToLogs(`probably a snap-hash`);
        return; // probably a snap-hash.
      }

      // both are either versions or ranges
      const lifeCycle =
        workspacePolicy.entries.find((d) => d.dependencyId === depId)?.lifecycleType === 'peer'
          ? 'peerDependencies'
          : 'dependencies';

      const addToUpdate = (addRangeFrom?: string) => {
        if (addRangeFrom) {
          // depInCompVer is a version, depInWsVer is a range
          const potentialRangeChar = depInWsVer[0];
          const newRange = potentialRangeChar + depInCompVer;
          if (!semver.validRange(newRange)) {
            const warnMsg = `failed to add the range "${potentialRangeChar}" to ${depInCompVer}, the result is not a valid range`;
            this.logger.warn(warnMsg);
            addNotUpdateToLogs(warnMsg);
            return;
          }
          logs.push(`${depId} - updating from ${depInWsVer} to ${newRange} (new range based on ${depInCompVer})`);
          workspaceDepsUpdates[depId] = [depInWsVer, newRange];
        } else {
          logs.push(`${depId} - updating from ${depInWsVer} to ${depInCompVer}`);
          workspaceDepsUpdates[depId] = [depInWsVer, depInCompVer];
        }
      };
      const addToConflict = () => {
        workspaceDepsConflicts[lifeCycle].push({ name: depId, version: `CONFLICT::${depInWsVer}::${depInCompVer}` });
        logs.push(`${depId} - conflict. ours: ${depInWsVer}, theirs: ${depInCompVer}`);
      };

      // both are versions
      if (isDepInCompVersion && isDepInWsVersion) {
        if (semver.gt(depInCompVer, depInWsVer)) {
          addToConflict();
          return;
        }
        addNotUpdateToLogs(`the version from ws ${depInWsVer} is greater than ${depInCompVer} from comp`);
        return;
      }

      // both are ranges
      if (isDepInCompRange && isDepInWsRange) {
        if (this.isRange1GreaterThanRange2Naively(depInCompVer, depInWsVer)) {
          addToUpdate();
          return;
        }
        addNotUpdateToLogs(`the range from ws ${depInWsVer} is greater than ${depInCompVer} from comp`);
        return;
      }

      if (isDepInCompVersion && isDepInWsRange) {
        const wsMinVer = semver.minVersion(depInWsVer);
        if (!wsMinVer) {
          this.logger.warn(`unable to calculate the min version of ${depInWsVer}`);
          addNotUpdateToLogs(`unable to calculate the min version of ${depInWsVer} from ws`);
          return;
        }
        if (semver.gt(wsMinVer, depInCompVer)) {
          addNotUpdateToLogs(`the min version from ws ${depInWsVer} is greater than ${depInCompVer} from comp`);
          return;
        }
        if (semver.satisfies(depInCompVer, depInWsVer)) {
          addToUpdate(depInWsVer);
          return;
        }
        addToConflict();
        return;
      }

      if (isDepInCompRange && isDepInWsVersion) {
        if (semver.satisfies(depInWsVer, depInCompVer)) {
          addToUpdate();
          return;
        }
        const compMinVer = semver.minVersion(depInCompVer);
        if (!compMinVer) {
          this.logger.warn(`unable to calculate the min version of ${compMinVer}`);
          addNotUpdateToLogs(`unable to calculate the min version of ${compMinVer} from comp`);
          return;
        }
        if (semver.gt(compMinVer, depInWsVer)) {
          addToConflict();
          return;
        }
        addNotUpdateToLogs(`the min version from comp ${compMinVer} is less than ${depInWsVer} from ws`);
      }
      throw new Error(`unhandled case: comp: ${depInCompVer}, ws: ${depInWsVer}`);
    });

    WS_DEPS_FIELDS.forEach((depField) => {
      if (isEmpty(workspaceDepsConflicts[depField])) delete workspaceDepsConflicts[depField];
    });

    this.logger.debug(`workspace config-merge all components logs\n${logs.join('\n')}`);
    this.logger.debug('final workspace.jsonc updates [from, to]', workspaceDepsUpdates);
    this.logger.debug(`final workspace.jsonc conflicts ${JSON.stringify(workspaceDepsConflicts, undefined, 2)}`);

    await this.updateWsConfigWithGivenChanges(workspaceDepsUpdates, workspacePolicy);
    let workspaceConfigConflictWriteError: Error | undefined;
    if (!isEmpty(workspaceDepsConflicts)) {
      workspaceConfigConflictWriteError = await this.writeWorkspaceJsoncWithConflictsGracefully(workspaceDepsConflicts);
    }

    return {
      workspaceDepsUpdates: isEmpty(workspaceDepsUpdates) ? undefined : workspaceDepsUpdates,
      workspaceDepsConflicts: isEmpty(workspaceDepsConflicts) ? undefined : workspaceDepsConflicts,
      workspaceConfigConflictWriteError,
      logs,
    };
  }

  private async updateWsConfigWithGivenChanges(workspaceDepsUpdates: WorkspaceDepsUpdates, wsPolicy: WorkspacePolicy) {
    if (isEmpty(workspaceDepsUpdates)) return;
    const getLifeCycle = (depId: string) => {
      const lifeCycle = wsPolicy.entries.find((d) => d.dependencyId === depId)?.lifecycleType;
      if (!lifeCycle) throw new Error(`unable to find the lifecycle of ${depId}`);
      return lifeCycle;
    };

    const newWorkspacePolicyEntries: WorkspacePolicyEntry[] = Object.keys(workspaceDepsUpdates).map((pkgName) => {
      return {
        dependencyId: pkgName,
        lifecycleType: getLifeCycle(pkgName),
        value: {
          version: workspaceDepsUpdates[pkgName][1],
        },
      };
    });
    this.depsResolver.addToRootPolicy(newWorkspacePolicyEntries, {
      updateExisting: true,
    });
    await this.depsResolver.persistConfig('config-merger (update root policy)');
  }

  /**
   * if both versions are ranges, it's hard to check which one is bigger. sometimes it's even impossible.
   * remember that a range can be something like `1.2 <1.2.9 || >2.0.0`.
   * this check is naive in a way that it assumes the range is simple, such as "^1.2.3" or "~1.2.3.
   * in this case, it's possible to check for the minimum version and compare it.
   */
  private isRange1GreaterThanRange2Naively(range1: string, range2: string) {
    const minVersion1 = semver.minVersion(range1);
    const minVersion2 = semver.minVersion(range2);
    if (!minVersion1 || !minVersion2) return false;
    return semver.gt(minVersion1, minVersion2);
  }

  static slots = [];
  static dependencies = [WorkspaceAspect, ConfigAspect, LoggerAspect, DependencyResolverAspect];
  static runtime = MainRuntime;
  static async provider([workspace, config, loggerMain, depsResolver]: [
    Workspace,
    ConfigMain,
    LoggerMain,
    DependencyResolverMain
  ]) {
    const logger = loggerMain.createLogger(ConfigMergerAspect.id);
    return new ConfigMergerMain(workspace, logger, config, depsResolver);
  }
}

ConfigMergerAspect.addRuntime(ConfigMergerMain);

export default ConfigMergerMain;
