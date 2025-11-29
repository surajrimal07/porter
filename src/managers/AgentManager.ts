import browser, { Runtime } from 'webextension-polyfill';
import { v4 as uuidv4 } from 'uuid';
import {
  Agent,
  AgentInfo,
  ConnectionType,
  PorterContext,
  MessageTarget,
  AgentId,
  BrowserLocation,
} from '../porter.model';
import { Logger } from '../porter.utils';

export interface AgentOperations {
  addAgent(port: Runtime.Port, context?: PorterContext): AgentId | undefined;
  queryAgents(location: Partial<BrowserLocation>): Agent[];
  getAgentById(id: AgentId): Agent | null;
  // Return all Runtime.Port objects associated with a logical agent id
  getPortsByAgentId(id: AgentId): Runtime.Port[];
  getAgentsByContext(context: PorterContext): Agent[];
  getAgentByLocation(location: BrowserLocation): Agent | null;
  getAllAgents(): Agent[];
  getAllAgentsInfo(): AgentInfo[];
  hasPort(port: Runtime.Port): boolean;
  removeAgent(agentId: AgentId): void;
  printAgents(): void;
}

export interface AgentEventEmitter {
  on(
    event: 'agentSetup',
    handler: (agentInfo: AgentInfo, port: Runtime.Port) => void
  ): void;
  on(
    event: 'agentMessage',
    handler: (message: any, info: AgentInfo) => void
  ): void;
  on(event: 'agentDisconnect', handler: (info: AgentInfo) => void): void;
}

export class AgentManager implements AgentOperations, AgentEventEmitter {
  // Track potentially multiple ports per logical agent id. Some environments
  // may create more than one Port for the same location; we must not clobber
  // the previous port reference as that can cause messages to be delivered to
  // only the most-recent connection and break reactivity for others.
  private agents: Map<AgentId, Set<Runtime.Port>> = new Map();
  private agentsInfo: Map<AgentId, AgentInfo> = new Map();
  private eventHandlers: Map<string, Set<Function>> = new Map();

  constructor(private logger: Logger) {
    this.eventHandlers.set('agentSetup', new Set());
    this.eventHandlers.set('agentMessage', new Set());
    this.eventHandlers.set('agentDisconnect', new Set());
  }

  public addAgent(
    port: Runtime.Port,
    context?: PorterContext
  ): AgentId | undefined {
    this.logger.debug(`Adding agent`, { context, port });
    const connectionSource = this.identifyConnectionSource(port);
    if (!connectionSource) {
      this.logger.error(`Cannot add agent that did not have a sender`);
      return;
    }

    const determinedContext = connectionSource.context;
    const tabId = connectionSource.tabId || -1;
    const frameId = connectionSource.frameId || 0;

    this.logger.debug(`Determined context for new agent`, {
      determinedContext,
      tabId,
      frameId,
    });
    // Find agents in the same tab or under the same extension context
    const tabAgentsInfo = Array.from(this.agentsInfo.values()).filter(
      (info) => {
        return (
          info.location.context === determinedContext &&
          info.location.tabId === tabId &&
          info.location.frameId === frameId
        );
      }
    );

    if (tabAgentsInfo.length > 0) {
      this.logger.debug('Adding agent: Found existing similar agent.', {
        tabAgentsInfo,
      });
    }

    const existing = this.getAgentByLocation({
      context: determinedContext,
      tabId,
      frameId,
    })?.info?.id;

    const agentId = existing || (uuidv4() as AgentId);

    this.logger.debug(`Adding agent with id: ${agentId}`);

    // Maintain a set of ports per agent id and add this port to the set.
    if (!this.agents.has(agentId)) {
      this.agents.set(agentId, new Set());
    }
    this.agents.get(agentId)!.add(port);

    const existingAgentInfo = this.agentsInfo.get(agentId);
    const now = Date.now();
    let agentInfo: AgentInfo;

    if (existingAgentInfo) {
      agentInfo = existingAgentInfo;
      agentInfo.lastActiveAt = now;
    } else {
      agentInfo = {
        id: agentId,
        location: { context: determinedContext, tabId, frameId },
        createdAt: now,
        lastActiveAt: now,
      };
      this.agentsInfo.set(agentId, agentInfo);
    }

    this.logger.debug(`Constructed agent info: ${JSON.stringify(agentInfo)}`);
    port.onMessage.addListener((message: any) =>
      this.emit('agentMessage', message, agentInfo)
    );

    // When this specific port disconnects, remove it from the set. Only emit
    // agentDisconnect and remove the AgentInfo once all ports for that agentId
    // are gone.
    port.onDisconnect.addListener(() => {
      this.logger.debug('Port disconnected for agent id, removing port.', {
        agentId,
        portName: port.name,
      });
      this.removePortFromAgent(agentId, port);
    });

    this.emit('agentSetup', agentInfo, port);
    this.logger.debug('Setup complete for adding agent. ', {
      agentInfo,
    });
    return agentId;
  }

  public getAgentByLocation(location: BrowserLocation): Agent | null {
    const { context, tabId, frameId } = location;

    const infoEntry: [AgentId, AgentInfo] | undefined = Array.from(
      this.agentsInfo.entries()
    ).find(
      ([key, info]) =>
        info.location.context === context &&
        info.location.tabId === tabId &&
        info.location.frameId === frameId
    );
    if (infoEntry === undefined) {
      this.logger.error('No agent found for location. ', {
        location,
      });
      return null;
    }
    const agentId = infoEntry[0];
    const portSet = this.agents.get(agentId);
    const info = this.agentsInfo.get(agentId);
    if (!portSet || !info) {
      this.logger.error('No agent found for location. ', {
        location,
      });
      return null;
    }

    const ports = Array.from(portSet);
    if (ports.length === 0) {
      this.logger.error('No port available for agent id. ', { agentId });
      return null;
    }
    return { ports, info };
  }

  public getAgentsByContext(context: PorterContext): Agent[] {
    let infoForAgents = Array.from(this.agentsInfo.entries()).filter(
      ([key, value]) => value.location.context === context
    );
    return infoForAgents.map(([key, value]) => ({
      ports: Array.from(this.agents.get(key) || []),
      info: value,
    }));
  }

  public getAllAgents(): Agent[] {
    let allInfo = Array.from(this.agentsInfo.entries());
    return allInfo.map(([key, value]) => ({
      ports: Array.from(this.agents.get(key) || []),
      info: value,
    }));
  }

  public queryAgents(location: Partial<BrowserLocation>): Agent[] {
    let infoForAgents = Array.from(this.agentsInfo.entries()).filter(
      ([key, value]) => {
        const hasContext = location.context
          ? value.location.context === location.context
          : true;
        const hasTabId = location.tabId
          ? value.location.tabId === location.tabId
          : true;
        const hasFrameId = location.frameId
          ? value.location.frameId === location.frameId
          : true;
        return hasContext && hasTabId && hasFrameId;
      }
    );
    return infoForAgents.map(([key, value]) => ({
      ports: Array.from(this.agents.get(key) || []),
      info: value,
    }));
  }

  public getAgentById(id: AgentId): Agent | null {
    const ports = this.agents.get(id);
    let info = this.agentsInfo.get(id);
    if (!ports || !info) {
      this.logger.error('No agent found for agentId. ', {
        id,
      });
      return null;
    }
    const portsArr = Array.from(ports);
    return { ports: portsArr, info };
  }

  public getPortsByAgentId(id: AgentId): Runtime.Port[] {
    const ports = this.agents.get(id);
    if (!ports) return [];
    return Array.from(ports);
  }

  public getAllAgentsInfo(): AgentInfo[] {
    return Array.from(this.agentsInfo.values());
  }

  public hasPort(port: Runtime.Port): boolean {
    for (const ports of this.agents.values()) {
      for (const p of ports) {
        if (p.name === port.name) return true;
      }
    }
    return false;
  }

  public removeAgent(agentId: AgentId) {
    if (this.agents.has(agentId) && this.agentsInfo.has(agentId)) {
      this.agents.delete(agentId);
      this.agentsInfo.delete(agentId);
    } else {
      this.logger.error('No agent found to remove. ', {
        agentId,
      });
    }
  }

  private removePortFromAgent(agentId: AgentId, port: Runtime.Port) {
    const ports = this.agents.get(agentId);
    const info = this.agentsInfo.get(agentId);
    if (!ports) return;

    ports.delete(port);
    // If ports remain, do not remove the agent yet.
    if (ports.size > 0) {
      this.logger.debug('Ports remain for agent, keeping agent info.', {
        agentId,
        remaining: ports.size,
      });
      return;
    }

    // No ports remain: remove agent and emit disconnect
    this.agents.delete(agentId);
    if (info) {
      this.agentsInfo.delete(agentId);
      this.emit('agentDisconnect', info);
      this.logger.debug('All ports removed for agent; agent removed.', {
        agentId,
      });
    }
  }

  public printAgents() {
    const allAgents = Array.from(this.agents.entries());
    const allAgentsInfo = Array.from(this.agentsInfo.entries());
    this.logger.debug('Current agents:', {
      allAgents,
      allAgentsInfo,
    });
  }

  // private isContentScript(port: Runtime.Port) {
  //   if (!port.sender) return false;
  //   const hasFrame =
  //     port.sender.tab &&
  //     port.sender.tab.id !== undefined &&
  //     port.sender.frameId !== undefined;
  //   if (!hasFrame) return false;
  //   if (!(port.sender as any).origin) return false;

  //   const contentPage =
  //     !(port.sender as any)!.origin.startsWith('chrome-extension://') &&
  //     !(port.sender as any)!.tab!.url?.startsWith('moz-extension://');
  //   return contentPage;
  // }

  public on(event: string, handler: Function) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.add(handler);
    }
  }

  private emit(event: string, ...args: any[]) {
    const handlers = this.eventHandlers.get(event);
    handlers?.forEach((handler) => handler(...args));
  }

  private identifyConnectionSource(port: Runtime.Port): {
    context: PorterContext;
    tabId?: number;
    frameId?: number;
    url?: string;
    portName?: string;
  } | null {
    const sender = port.sender;
    if (!sender) {
      this.logger.error(`Cannot add agent that did not have a sender`);
      return null;
    }
    // Cache the manifest data
    const manifest = browser.runtime.getManifest();

    // Extract page URLs from manifest
    const sidePanel = (manifest as any)?.side_panel?.default_path || '';
    const optionsPage = (manifest as any).options_page || '';
    const popupPage = (manifest as any).action?.default_popup || '';
    const devtoolsPage = (manifest as any).devtools_page || '';
    const newTabOverride = (manifest as any).chrome_url_overrides?.newtab || '';
    const bookmarksOverride =
      (manifest as any).chrome_url_overrides?.bookmarks || '';
    const historyOverride =
      (manifest as any).chrome_url_overrides?.history || '';

    // Create URL endings for matching
    // (handles both full paths and just filenames)
    const pageMatchers = {
      sidepanel: sidePanel ? sidePanel.split('/').pop() : 'sidepanel.html',
      options: optionsPage ? optionsPage.split('/').pop() : 'options.html',
      popup: popupPage ? popupPage.split('/').pop() : 'popup.html',
      devtools: devtoolsPage ? devtoolsPage.split('/').pop() : 'devtools.html',
      newtab: newTabOverride ? newTabOverride.split('/').pop() : 'newtab.html',
      bookmarks: bookmarksOverride
        ? bookmarksOverride.split('/').pop()
        : 'bookmarks.html',
      history: historyOverride
        ? historyOverride.split('/').pop()
        : 'history.html',
    };

    // Content scripts (web pages)
    if (sender.tab && sender.url && !sender.url.includes('extension://')) {
      return {
        context: PorterContext.ContentScript,
        tabId: sender.tab.id,
        frameId: sender.frameId || 0,
        url: sender.url,
        portName: port.name,
      };
    }

    // Extension pages
    if (sender.url && sender.url.includes('extension://')) {
      const urlPath = new URL(sender.url).pathname;
      const filename = urlPath.split('/').pop();

      // Check against our manifest-derived page matchers
      for (const [pageType, pageMatcher] of Object.entries(pageMatchers)) {
        if (filename === pageMatcher) {
          // It's a main extension page
          // Different handling based on presence of tab

          return {
            context: pageType as PorterContext,
            tabId: sender.tab?.id || 0,
            frameId: sender.frameId || 0,
            url: sender.url,
            portName: port.name,
          };
        }
      }

      // It's some other extension page not specifically listed in our matchers

      return {
        context: PorterContext.Unknown,
        tabId: sender.tab?.id || 0,
        frameId: sender.frameId || 0,
        url: sender.url,
        portName: port.name,
      };
    }

    // Fallback for unknown sources
    return {
      context: PorterContext.Unknown,
      tabId: 0,
      url: sender.url,
      portName: port.name,
    };
  }
}
