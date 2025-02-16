import { Slot, SlotRegistry } from '@teambit/harmony';
import CLIAspect, { CLIMain, MainRuntime } from '@teambit/cli';
import { v4 } from 'uuid';
import chalk from 'chalk';
import os from 'os';
import open from 'open';
import * as http from 'http';
import { Express } from 'express';
import { GetScopesGQLResponse } from '@teambit/cloud.models.cloud-scope';
import { CloudUser, CloudUserAPIResponse } from '@teambit/cloud.models.cloud-user';
import { ScopeDescriptor } from '@teambit/scopes.scope-descriptor';
import { ScopeID } from '@teambit/scopes.scope-id';
import { Logger, LoggerAspect, LoggerMain } from '@teambit/logger';
import {
  getCloudDomain,
  DEFAULT_HUB_DOMAIN,
  getSymphonyUrl,
  SYMPHONY_GRAPHQL,
  getLoginUrl,
  DEFAULT_ANALYTICS_DOMAIN,
  DEFAULT_REGISTRY_URL,
  CENTRAL_BIT_HUB_URL,
  CENTRAL_BIT_HUB_NAME,
  CFG_USER_TOKEN_KEY,
  CFG_USER_NAME_KEY,
} from '@teambit/legacy/dist/constants';
import ScopeAspect, { ScopeMain } from '@teambit/scope';
import globalFlags from '@teambit/legacy/dist/cli/global-flags';
import GraphqlAspect, { GraphqlMain } from '@teambit/graphql';
import WorkspaceAspect, { Workspace } from '@teambit/workspace';
import { ExpressAspect, ExpressMain } from '@teambit/express';
import GlobalConfigAspect, { GlobalConfigMain } from '@teambit/global-config';
import { execSync } from 'child_process';
import UIAspect, { UiMain } from '@teambit/ui';
import { cloudSchema } from './cloud.graphql';
import { CloudAspect } from './cloud.aspect';
import { LoginCmd } from './login.cmd';
import { LogoutCmd } from './logout.cmd';
import { WhoamiCmd } from './whoami.cmd';

export interface CloudWorkspaceConfig {
  cloudDomain: string;
  cloudHubDomain: string;
  cloudApi: string;
  cloudGraphQL: string;
  loginDomain: string;
  analyticsDomain: string;
  registryUrl: string;
  cloudExporterUrl: string;
  cloudHubName: string;
  loginPort?: number;
}

type CloudAuthListener = {
  port: number;
  server?: http.Server;
  username?: string | null;
  clientId?: string;
  expressApp?: Express | null;
};

type CloudOrganization = {
  id: string;
  name: string;
};

type CloudOrganizationAPIResponse = {
  data: {
    getUserOrganizations: CloudOrganization[];
  };
};

export type OnSuccessLogin = ({
  username,
  token,
  npmrcUpdateResult,
}: {
  username?: string;
  token?: string;
  npmrcUpdateResult?: {
    success?: boolean;
    error?: Error;
    configUpdates?: string;
  };
}) => void;
export type OnSuccessLoginSlot = SlotRegistry<OnSuccessLogin>;

export class CloudMain {
  static ERROR_RESPONSE = 500;
  static DEFAULT_PORT = 8888;
  static REDIRECT = 302;
  static GRAPHQL_ENDPOINT = '/graphql';
  private authListenerByPort: Map<number, CloudAuthListener> = new Map();
  private REDIRECT_URL?: string;

  constructor(
    private config: CloudWorkspaceConfig,
    public logger: Logger,
    public express: ExpressMain,
    public workspace: Workspace,
    public scope: ScopeMain,
    public globalConfig: GlobalConfigMain,
    public onSuccessLoginSlot: OnSuccessLoginSlot
  ) {}

  async updateNpmrcOnLogin({ authToken, username }: { authToken: string; username: string }): Promise<string> {
    const orgs = (await this.getUserOrganizations()) ?? [];
    const orgNames = orgs.map((org) => org.name);
    const allOrgs = [...CloudMain.PRESET_ORGS, ...orgNames, username];
    const registryUrl = this.getRegistryUrl();
    const scopeConfig = allOrgs.map((org) => `@${org}:registry="${registryUrl}"`).join(' ');
    const authConfig = `//${new URL(registryUrl).host}/:_authToken="${authToken}"`;
    const configUpdates = `${scopeConfig} ${authConfig}`;
    execSync(`npm config set ${configUpdates}`, { stdio: 'ignore' });
    return configUpdates;
  }

  setupAuthListener({
    port: portFromParams,
    clientId = v4(),
  }: {
    port?: number;
    clientId?: string;
  } = {}): Promise<CloudAuthListener | null> {
    return new Promise((resolve, reject) => {
      const port = portFromParams || this.getLoginPort();
      const existingAuthListener = this.authListenerByPort.get(port);

      if (existingAuthListener) {
        this.logger.debug(`auth server is already running on port ${port}`);
        resolve(existingAuthListener);
        return;
      }

      const expressApp = this.express.createApp();

      this.authListenerByPort.set(port, {
        port,
        clientId,
      });

      const authServer = expressApp
        .listen(port, () => {
          this.logger.debug(`cloud express server started on port ${port}`);
          const existing = this.authListenerByPort.get(port) ?? {};
          this.authListenerByPort.set(port, {
            port,
            clientId,
            ...existing,
            server: authServer,
          });
          resolve({
            port,
            server: authServer,
            clientId,
          });
        })
        .on('error', (err) => {
          // @ts-ignore
          const { code } = err;
          if (code === 'EADDRINUSE') {
            // set up a new auth listener with new port
            this.logger.warn(`port: ${port} already in use for cloud auth listener, trying port ${port + 1}`);
            // eslint-disable-next-line promise/no-promise-in-callback
            this.setupAuthListener({
              port: port + 1,
            })
              .then(resolve)
              .catch(reject);
            return;
          }
          this.logger.error(`cloud express server failed to start on port ${port}`, err);
          reject(err);
        });

      expressApp.get('/', (req, res) => {
        this.logger.debug('cloud.authListener', 'received request', req.query);
        try {
          const { clientId: clientIdFromReq, redirectUri, username: usernameFromReq } = req.query;
          const username = typeof usernameFromReq === 'string' ? usernameFromReq : undefined;
          let { token } = req.query;
          if (Array.isArray(token)) {
            token = token[0];
          }
          if (typeof token !== 'string') {
            res.status(400).send('Invalid token format');
            return res;
          }
          this.globalConfig.setSync(CFG_USER_TOKEN_KEY, token);
          if (username) this.globalConfig.setSync(CFG_USER_NAME_KEY, username);

          const existing = this.authListenerByPort.get(port) ?? {};
          this.authListenerByPort.set(port, {
            port,
            server: authServer,
            clientId: clientIdFromReq as string,
            ...existing,
            username,
          });

          const onLoggedInFns = this.onSuccessLoginSlot.values();

          this.updateNpmrcOnLogin({ authToken: token as string, username: username as string })
            .then((configUpdates) => {
              onLoggedInFns.forEach((fn) =>
                fn({ username, token: token as string, npmrcUpdateResult: { success: true, configUpdates } })
              );
            })
            .catch((error) => {
              onLoggedInFns.forEach((fn) =>
                fn({
                  username,
                  token: token as string,
                  npmrcUpdateResult: {
                    success: false,
                    error: new Error(`failed to update npmrc. error ${error?.toString}`),
                  },
                })
              );
            });

          if (this.REDIRECT_URL) return res.redirect(this.REDIRECT_URL);
          if (typeof redirectUri === 'string' && redirectUri) return res.redirect(redirectUri);
          return res.status(200).send('Login successful');
        } catch (err) {
          this.logger.error(`Error on login: ${err}`);
          res.status(CloudMain.ERROR_RESPONSE).send('Login failed');
          reject(err);
          return res;
        }
      });
    });
  }

  registerOnSuccessLogin(onSuccessLoginFn: OnSuccessLogin) {
    this.onSuccessLoginSlot.register(onSuccessLoginFn);
    return this;
  }

  getCloudDomain(): string {
    return this.config.cloudDomain;
  }

  getCloudHubDomain(): string {
    return this.config.cloudHubDomain;
  }

  getCloudApi(): string {
    return this.config.cloudApi;
  }

  getCloudGraphQL(): string {
    return this.config.cloudGraphQL;
  }
  getLoginDomain(): string {
    return this.config.loginDomain;
  }

  getAnalyticsDomain(): string {
    return this.config.analyticsDomain;
  }

  getRegistryUrl(): string {
    return this.config.registryUrl;
  }

  getCloudExporterUrl(): string {
    return this.config.cloudExporterUrl;
  }

  getHubName(): string {
    return this.config.cloudHubName;
  }

  getLoginPort(): number {
    return this.config.loginPort || CloudMain.DEFAULT_PORT;
  }

  isLoggedIn(): boolean {
    return Boolean(this.getAuthToken());
  }

  getAuthToken() {
    this.globalConfig.invalidateCache();
    const processToken = globalFlags.token;
    const token = processToken || this.globalConfig.getSync(CFG_USER_TOKEN_KEY);
    if (!token) return null;

    return token;
  }

  getAuthHeader() {
    return {
      Authorization: `Bearer ${this.getAuthToken()}`,
    };
  }

  getUsername(): string | undefined {
    return this.globalConfig.getSync(CFG_USER_NAME_KEY);
  }

  async getLoginUrl({
    redirectUrl,
    machineName,
    cloudDomain,
    port: portFromParams,
  }: { redirectUrl?: string; machineName?: string; cloudDomain?: string; port?: string } = {}): Promise<string | null> {
    const loginUrl = cloudDomain || this.getLoginDomain();
    const port = Number(portFromParams) || this.getLoginPort();
    if (redirectUrl) {
      this.REDIRECT_URL = redirectUrl;
    }
    const authListenerForPort = this.authListenerByPort.get(port);
    if (authListenerForPort) {
      return `${loginUrl}?port=${port}&clientId=${authListenerForPort.clientId}&responseType=token&deviceName=${
        machineName || os.hostname()
      }&os=${process.platform}`;
    }
    const authListener = await this.setupAuthListener({ port });

    if (!authListener) return null;

    return encodeURI(
      `${loginUrl}?port=${port}&clientId=${authListener?.clientId}&responseType=token&deviceName=${
        machineName || os.hostname()
      }&os=${process.platform}`
    );
  }

  logout() {
    this.globalConfig.delSync(CFG_USER_TOKEN_KEY);
    this.globalConfig.delSync(CFG_USER_NAME_KEY);
  }

  async whoami(): Promise<string | undefined> {
    const currentUser = await this.getCurrentUser();
    if (!currentUser?.username) {
      return undefined;
    }
    return currentUser.username;
  }

  async login(
    port?: string,
    suppressBrowserLaunch?: boolean,
    machineName?: string,
    cloudDomain?: string,
    redirectUrl?: string
  ): Promise<{
    isAlreadyLoggedIn?: boolean;
    username?: string;
    token?: string;
    npmrcUpdateResult?: {
      success?: boolean;
      error?: Error;
      configUpdates?: string;
    };
  } | null> {
    return new Promise((resolve, reject) => {
      if (this.isLoggedIn()) {
        resolve({
          isAlreadyLoggedIn: true,
          username: this.globalConfig.getSync(CFG_USER_NAME_KEY),
          token: this.globalConfig.getSync(CFG_USER_TOKEN_KEY),
        });
        return;
      }

      const promptLogin = async () => {
        this.REDIRECT_URL = redirectUrl;
        this.registerOnSuccessLogin((loggedInParams) => {
          resolve({
            username: loggedInParams.username,
            token: loggedInParams.token,
            npmrcUpdateResult: loggedInParams.npmrcUpdateResult,
          });
        });

        const loginUrl = await this.getLoginUrl({
          machineName,
          cloudDomain,
          port,
        });
        if (!loginUrl) {
          reject(new Error('Failed to get login url'));
          return;
        }
        if (!suppressBrowserLaunch) {
          console.log(chalk.yellow(`Your browser has been opened to visit:\n${loginUrl}`)); // eslint-disable-line no-console
          open(loginUrl).catch((err) => {
            this.logger.error(`failed to open browser on login, err: ${err}`);
            reject(err);
          });
        } else {
          console.log(chalk.yellow(`Go to the following link in your browser::\n${loginUrl}`)); // eslint-disable-line no-console
        }
      };
      try {
        this.setupAuthListener({
          port: Number(port),
        })
          .then(promptLogin)
          .catch((e) => reject(e));
      } catch (err) {
        reject(err);
      }
    });
  }

  static GET_SCOPES = `
      query GET_SCOPES($ids: [String]!) {
        getScopes(ids: $ids) {
          id
          scopeStyle {
            icon
            backgroundIconColor
            stripColor
          }
        }
      }
    `;
  static GET_CURRENT_USER = `
    query GET_ME {
      me {
        id
        username
        image
        displayName
      }
    }
  `;
  static GET_USER_ORGANIZATIONS = `
    query GET_USER_ORGANIZATIONS {
      getUserOrganizations {
        id
        name
      }    
    }
  `;

  static PRESET_ORGS = ['bitdev', 'teambit', 'bitdesign', 'frontend', 'backend'];

  async getCloudScopes(scopes: string[]): Promise<ScopeDescriptor[]> {
    const remotes = await this.scope._legacyRemotes();
    const filteredScopesToFetch = scopes.filter((scope) => {
      return ScopeID.isValid(scope) && remotes.isHub(scope);
    });
    const queryResponse = await this.fetchFromSymphonyViaGQL<GetScopesGQLResponse>(CloudMain.GET_SCOPES, {
      ids: filteredScopesToFetch,
    });
    const scopesFromQuery = queryResponse?.data?.getScopes;
    if (!scopesFromQuery) return [];
    return scopesFromQuery.map((scope) => {
      const scopeDescriptorObj = {
        ...scope,
        id: ScopeID.fromString(scope.id),
      };
      return ScopeDescriptor.fromObject(scopeDescriptorObj);
    });
  }

  async getCurrentUser(): Promise<CloudUser | null> {
    return this.fetchFromSymphonyViaGQL<CloudUserAPIResponse>(CloudMain.GET_CURRENT_USER).then((response) => {
      if (!response) return null;
      return {
        isLoggedIn: true,
        displayName: response.data.me.displayName,
        username: response.data.me.username,
        profileImage: response.data.me.image,
      };
    });
  }

  async getUserOrganizations(): Promise<CloudOrganization[] | null> {
    return this.fetchFromSymphonyViaGQL<CloudOrganizationAPIResponse>(CloudMain.GET_USER_ORGANIZATIONS).then(
      (response) => {
        if (!response) return null;
        return response.data.getUserOrganizations;
      }
    );
  }

  async fetchFromSymphonyViaGQL<T>(query: string, variables?: Record<string, any>): Promise<T | null> {
    if (!this.isLoggedIn()) return null;
    const graphqlUrl = `https://${this.getCloudApi()}${CloudMain.GRAPHQL_ENDPOINT}`;
    const body = JSON.stringify({
      query,
      variables,
    });
    const headers = {
      'Content-Type': 'application/json',
      ...this.getAuthHeader(),
    };
    try {
      const response = await fetch(graphqlUrl, {
        method: 'POST',
        headers,
        body,
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      this.logger.debug('fetchFromSymphonyViaGQL. ', 'Error fetching data: ', error);
      return null;
    }
  }

  static slots = [Slot.withType<OnSuccessLogin>()];
  static dependencies = [
    LoggerAspect,
    GraphqlAspect,
    ExpressAspect,
    WorkspaceAspect,
    ScopeAspect,
    GlobalConfigAspect,
    CLIAspect,
    UIAspect,
  ];
  static runtime = MainRuntime;
  static defaultConfig: CloudWorkspaceConfig = {
    cloudDomain: getCloudDomain(),
    cloudHubDomain: DEFAULT_HUB_DOMAIN,
    cloudApi: getSymphonyUrl(),
    cloudGraphQL: SYMPHONY_GRAPHQL,
    loginDomain: getLoginUrl(),
    analyticsDomain: DEFAULT_ANALYTICS_DOMAIN,
    registryUrl: DEFAULT_REGISTRY_URL,
    cloudExporterUrl: CENTRAL_BIT_HUB_URL,
    cloudHubName: CENTRAL_BIT_HUB_NAME,
    loginPort: CloudMain.DEFAULT_PORT,
  };
  static async provider(
    [loggerMain, graphql, express, workspace, scope, globalConfig, cli, ui]: [
      LoggerMain,
      GraphqlMain,
      ExpressMain,
      Workspace,
      ScopeMain,
      GlobalConfigMain,
      CLIMain,
      UiMain
    ],
    config: CloudWorkspaceConfig,
    [onSuccessLoginSlot]: [OnSuccessLoginSlot]
  ) {
    const logger = loggerMain.createLogger(CloudAspect.id);
    const cloudMain = new CloudMain(config, logger, express, workspace, scope, globalConfig, onSuccessLoginSlot);
    const loginCmd = new LoginCmd(cloudMain);
    const logoutCmd = new LogoutCmd(cloudMain);
    const whoamiCmd = new WhoamiCmd(cloudMain);
    cli.register(loginCmd, logoutCmd, whoamiCmd);
    graphql.register(cloudSchema(cloudMain));
    if (workspace) {
      ui.registerOnStart(async () => {
        await cloudMain.setupAuthListener();
        return undefined;
      });
    }
    return cloudMain;
  }
}

CloudAspect.addRuntime(CloudMain);
