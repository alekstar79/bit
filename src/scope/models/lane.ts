import { v4 } from 'uuid';
import { cloneDeep, isEqual, pickBy } from 'lodash';
import { BitError } from '@teambit/bit-error';
import { ComponentID, ComponentIdList } from '@teambit/component-id';
import { isSnap } from '@teambit/component-version';
import { LaneId, DEFAULT_LANE, LANE_REMOTE_DELIMITER } from '@teambit/lane-id';
import { Scope } from '..';
import { CFG_USER_EMAIL_KEY, CFG_USER_NAME_KEY, PREVIOUS_DEFAULT_LANE } from '../../constants';
import ValidationError from '../../error/validation-error';
import logger from '../../logger/logger';
import { getStringifyArgs, sha1 } from '../../utils';
import { hasVersionByRef } from '../component-ops/traverse-versions';
import { BitObject, Ref, Repository } from '../objects';
import { Version } from '.';
import * as globalConfig from '../../api/consumer/lib/global-config';

export type Log = { date: string; username?: string; email?: string; profileImage?: string };

export type LaneProps = {
  name: string;
  scope: string;
  log: Log;
  components?: LaneComponent[];
  hash: string;
  readmeComponent?: LaneReadmeComponent;
  forkedFrom?: LaneId;
};

export type LaneComponent = { id: ComponentID; head: Ref };
export type LaneReadmeComponent = { id: ComponentID; head: Ref | null };
export default class Lane extends BitObject {
  name: string;
  scope: string;
  components: LaneComponent[];
  log: Log;
  readmeComponent?: LaneReadmeComponent;
  forkedFrom?: LaneId;
  _hash: string; // reason for the underscore prefix is that we already have hash as a method
  isNew = false; // doesn't get saved in the object. only needed for in-memory instance
  hasChanged = false; // doesn't get saved in the object. only needed for in-memory instance
  constructor(props: LaneProps) {
    super();
    if (!props.name) throw new TypeError('Lane constructor expects to get a name parameter');
    this.name = props.name;
    this.scope = props.scope;
    this.components = props.components || [];
    this.log = props.log || {};
    this._hash = props.hash;
    this.readmeComponent = props.readmeComponent;
    this.forkedFrom = props.forkedFrom;
  }
  id(): string {
    return this.scope + LANE_REMOTE_DELIMITER + this.name;
  }
  hash(): Ref {
    if (!this._hash) {
      throw new Error('hash is missing from a Lane object');
    }
    return new Ref(this._hash);
  }
  changeName(name: string) {
    this.name = name;
    this.hasChanged = true;
  }
  changeScope(scope: string) {
    this.scope = scope;
    this.hasChanged = true;
  }
  refs(): Ref[] {
    return this.components.map((c) => c.head);
  }
  validateBeforePersisting(str: string) {
    logger.debug(`validating lane object: ${this.hash().toString()} ${this.id()}`);
    const lane = Lane.parse(str, this.hash().toString());
    lane.validate();
  }
  toObject() {
    const obj = pickBy(
      {
        name: this.name,
        scope: this.scope,
        components: this.components.map((component) => ({
          id: { scope: component.id.scope, name: component.id.fullName },
          head: component.head.toString(),
        })),
        log: this.log,
        readmeComponent: this.readmeComponent && {
          id: { scope: this.readmeComponent.id.scope, name: this.readmeComponent.id.fullName },
          head: this.readmeComponent.head?.toString() ?? null,
        },
        forkedFrom: this.forkedFrom && this.forkedFrom.toObject(),
      },
      (val) => !!val
    );
    return obj;
  }
  static from(props: LaneProps): Lane {
    return new Lane(props);
  }
  static create(
    name: string,
    scope: string,
    forkedFrom?: LaneId,
    bitCloudUser?: {
      username?: string;
      email?: string;
      profileImage?: string;
    }
  ) {
    const log = {
      date: Date.now().toString(),
      username: bitCloudUser?.username || globalConfig.getSync(CFG_USER_NAME_KEY),
      email: bitCloudUser?.email || globalConfig.getSync(CFG_USER_EMAIL_KEY),
      profileImage: bitCloudUser?.profileImage,
    };
    const lane = new Lane({ name, scope, hash: sha1(v4()), log, forkedFrom });
    lane.isNew = true;
    lane.hasChanged = true;
    return lane;
  }
  static parse(contents: string, hash: string): Lane {
    const laneObject = JSON.parse(contents);
    return Lane.from({
      name: laneObject.name,
      scope: laneObject.scope,
      log: laneObject.log,
      components: laneObject.components.map((component) => ({
        id: ComponentID.fromObject({ scope: component.id.scope, name: component.id.name }),
        head: new Ref(component.head),
      })),
      readmeComponent: laneObject.readmeComponent && {
        id: ComponentID.fromObject({
          scope: laneObject.readmeComponent.id.scope,
          name: laneObject.readmeComponent.id.name,
        }),
        head: laneObject.readmeComponent.head && new Ref(laneObject.readmeComponent.head),
      },
      forkedFrom: laneObject.forkedFrom && LaneId.from(laneObject.forkedFrom.name, laneObject.forkedFrom.scope),
      hash: laneObject.hash || hash,
    });
  }
  toBuffer(pretty?: boolean) {
    const args = getStringifyArgs(pretty);
    const obj = this.toObject();
    const str = JSON.stringify(obj, ...args);
    if (this.validateBeforePersist) this.validateBeforePersisting(str);
    return Buffer.from(str);
  }
  addComponent(component: LaneComponent) {
    const existsComponent = this.getComponent(component.id);
    if (existsComponent) {
      if (!existsComponent.head.isEqual(component.head)) this.hasChanged = true;
      existsComponent.id = component.id;
      existsComponent.head = component.head;
    } else {
      logger.debug(`Lane.addComponent, adding component ${component.id.toString()} to lane ${this.id()}`);
      this.components.push(component);
      this.hasChanged = true;
    }
  }
  removeComponent(id: ComponentID): boolean {
    const existsComponent = this.getComponent(id);
    if (!existsComponent) return false;
    this.components = this.components.filter((c) => !c.id.isEqualWithoutVersion(id));
    this.hasChanged = true;
    return true;
  }
  getComponent(id: ComponentID): LaneComponent | undefined {
    return this.components.find((c) => c.id.isEqualWithoutVersion(id));
  }
  getComponentHead(bitId: ComponentID): Ref | null {
    const found = this.components.find((c) => c.id.isEqual(bitId));
    if (found) return found.head;
    return null;
  }
  setLaneComponents(laneComponents: LaneComponent[]) {
    // this gets called when adding lane-components from other lanes/remotes, so it's better to
    // clone the objects to not change the original data.
    this.components = laneComponents.map((c) => ({ id: c.id.clone(), head: c.head.clone() }));
    this.hasChanged = true;
  }
  setReadmeComponent(id?: ComponentID) {
    const previousReadme = this.readmeComponent;
    if (!id) {
      this.readmeComponent = undefined;
      if (previousReadme) this.hasChanged = true;
      return;
    }
    const readmeComponent = this.getComponent(id);
    if (!readmeComponent) {
      this.readmeComponent = { id, head: null };
    } else {
      this.readmeComponent = readmeComponent;
    }
    if (
      !previousReadme ||
      !previousReadme.id.isEqual(id) ||
      previousReadme.head?.toString() !== this.readmeComponent.head?.toString()
    ) {
      this.hasChanged = true;
    }
  }

  async isFullyMerged(scope: Scope): Promise<boolean> {
    const { unmerged } = await this.getMergedAndUnmergedIds(scope);
    return unmerged.length === 0;
  }
  async getMergedAndUnmergedIds(scope: Scope): Promise<{ merged: ComponentID[]; unmerged: ComponentID[] }> {
    const merged: ComponentID[] = [];
    const unmerged: ComponentID[] = [];
    await Promise.all(
      this.components.map(async (component) => {
        const modelComponent = await scope.getModelComponentIfExist(component.id);
        if (!modelComponent) {
          unmerged.push(component.id);
          return;
        }
        const startTraverseFrom = modelComponent.getHead() || null; // it's important to have it as null and not as undefined, see hasVersionByRef
        const headExist = await hasVersionByRef(modelComponent, component.head, scope.objects, startTraverseFrom);
        if (headExist) merged.push(component.id);
        else unmerged.push(component.id);
      })
    );
    return { merged, unmerged };
  }
  /**
   * @deprecated use toComponentIds instead
   */
  toBitIds(): ComponentIdList {
    return this.toComponentIds();
  }
  toComponentIds(): ComponentIdList {
    return ComponentIdList.fromArray(this.components.map((c) => c.id.changeVersion(c.head.toString())));
  }
  toLaneId() {
    return new LaneId({ scope: this.scope, name: this.name });
  }
  collectObjectsById(repo: Repository): Promise<Array<{ id: ComponentID; objects: BitObject[] }>> {
    return Promise.all(
      this.components.map(async (component) => {
        const headVersion = (await component.head.load(repo)) as Version;
        const objects = [headVersion, ...headVersion.collect(repo)];
        return { id: component.id, objects };
      })
    );
  }
  validate() {
    const message = `unable to save Lane object "${this.id()}"`;
    const bitIds = this.toBitIds();
    this.components.forEach((component) => {
      if (bitIds.filterWithoutVersion(component.id).length > 1) {
        throw new ValidationError(`${message}, the following component is duplicated "${component.id.fullName}"`);
      }
      if (!isSnap(component.head.hash)) {
        throw new ValidationError(
          `${message}, lane component ${component.id.toStringWithoutVersion()} head should be a hash, got ${
            component.head.hash
          }`
        );
      }
    });
    if (this.name === DEFAULT_LANE) {
      throw new BitError(`${message}, this name is reserved as the default lane`);
    }
    if (this.name === PREVIOUS_DEFAULT_LANE) {
      throw new BitError(`${message}, this name is reserved as the old default lane`);
    }
  }
  isEqual(lane: Lane): boolean {
    if (this.id() !== lane.id()) return false;
    const thisComponents = this.toComponentIds().toStringArray().sort();
    const otherComponents = lane.toComponentIds().toStringArray().sort();
    return isEqual(thisComponents, otherComponents);
  }
  clone() {
    return new Lane({
      ...this,
      hash: this._hash,
      components: cloneDeep(this.components),
    });
  }
}
