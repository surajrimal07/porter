
import { AgentManager } from '../../src/managers/AgentManager';
import { Logger } from '../../src/porter.utils';
import { PorterContext } from '../../src/porter.model';
import { Runtime } from 'webextension-polyfill';

// Mock webextension-polyfill
jest.mock('webextension-polyfill', () => ({
  runtime: {
    getManifest: jest.fn(() => ({})),
  },
}));

// Mock Logger
jest.mock('../../src/porter.utils', () => ({
  Logger: {
    getLogger: jest.fn(() => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      trace: jest.fn(),
    })),
    configure: jest.fn(),
  },
}));

describe('AgentManager Multi-Instance Support', () => {
  describe('Intensive Multi-Agent Same Tab', () => {
    const AGENT_COUNT = 100;

    function createManyPorts(tabId: number, count: number) {
      return Array.from({ length: count }, (_, i) =>
        createMockPort(`porter:conn${i + 1}`, tabId)
      );
    }

    it('should handle adding 100 agents to the same tab', () => {
      const tabId = 999;
      const ports = createManyPorts(tabId, AGENT_COUNT);
      const agentIds = ports.map((port) => agentManager.addAgent(port));
      expect(agentManager.getAllAgents().length).toBe(AGENT_COUNT);
      // All agent IDs should be unique
      const uniqueIds = new Set(agentIds);
      expect(uniqueIds.size).toBe(AGENT_COUNT);
      // All agents should be queryable by tabId
      const agentsByTab = agentManager.queryAgents({ tabId });
      expect(agentsByTab.length).toBe(AGENT_COUNT);
    });

    it('should remove agents one by one and keep others intact', () => {
      const tabId = 1000;
      const ports = createManyPorts(tabId, AGENT_COUNT);
      const agentIds = ports.map((port) => agentManager.addAgent(port));
      // Remove half of the agents
      for (let i = 0; i < AGENT_COUNT / 2; i++) {
        agentManager.removeAgent(agentIds[i]!);
      }
      expect(agentManager.getAllAgents().length).toBe(AGENT_COUNT / 2);
      // Remaining agents should still be queryable
      const agentsByTab = agentManager.queryAgents({ tabId });
      expect(agentsByTab.length).toBe(AGENT_COUNT / 2);
      // Removed agents should not be found
      for (let i = 0; i < AGENT_COUNT / 2; i++) {
        expect(agentManager.getAgentById(agentIds[i]!)).toBeNull();
      }
    });

    it('should handle random disconnects and keep state consistent', () => {
      const tabId = 2000;
      const ports = createManyPorts(tabId, AGENT_COUNT);
      const disconnectListeners: Function[] = [];
      ports.forEach((port, idx) => {
        (port.onDisconnect.addListener as jest.Mock).mockImplementation((cb) => {
          disconnectListeners[idx] = cb;
        });
      });
      const agentIds = ports.map((port) => agentManager.addAgent(port));
      // Randomly disconnect 10 agents
      const toDisconnect = [5, 10, 20, 33, 44, 55, 66, 77, 88, 99];
      toDisconnect.forEach((idx) => disconnectListeners[idx]!());
      expect(agentManager.getAllAgents().length).toBe(AGENT_COUNT - toDisconnect.length);
      // Disconnected agents should not be found
      toDisconnect.forEach((idx) => {
        expect(agentManager.getAgentById(agentIds[idx]!)).toBeNull();
      });
    });

    it('should not remove other agents when one disconnects', () => {
      const tabId = 3000;
      const ports = createManyPorts(tabId, 5);
      const disconnectListeners: Function[] = [];
      ports.forEach((port, idx) => {
        (port.onDisconnect.addListener as jest.Mock).mockImplementation((cb) => {
          disconnectListeners[idx] = cb;
        });
      });
      const agentIds = ports.map((port) => agentManager.addAgent(port));
      disconnectListeners[2]!(); // Disconnect the third agent
      expect(agentManager.getAllAgents().length).toBe(4);
      expect(agentManager.getAgentById(agentIds[2]!)).toBeNull();
      // Others should still exist
      [0, 1, 3, 4].forEach((idx) => {
        expect(agentManager.getAgentById(agentIds[idx]!)).toBeDefined();
      });
    });

    it('should handle rapid add/remove cycles without breaking', () => {
      const tabId = 4000;
      for (let cycle = 0; cycle < 10; cycle++) {
        const ports = createManyPorts(tabId, 10);
        const agentIds = ports.map((port) => agentManager.addAgent(port));
        expect(agentManager.getAllAgents().length).toBe(10);
        agentIds.forEach((id) => agentManager.removeAgent(id!));
        expect(agentManager.getAllAgents().length).toBe(0);
      }
    });
  });
  let agentManager: AgentManager;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      trace: jest.fn(),
    };
    agentManager = new AgentManager(mockLogger);
  });

  const createMockPort = (name: string, tabId: number): Runtime.Port => {
    return {
      name,
      disconnect: jest.fn(),
      onDisconnect: {
        addListener: jest.fn(),
        removeListener: jest.fn(),
        hasListener: jest.fn(),
        hasListeners: jest.fn(),
      },
      onMessage: {
        addListener: jest.fn(),
        removeListener: jest.fn(),
        hasListener: jest.fn(),
        hasListeners: jest.fn(),
      },
      postMessage: jest.fn(),
      sender: {
        tab: { id: tabId },
        url: 'http://example.com',
        frameId: 0,
      },
    } as unknown as Runtime.Port;
  };

  it('should allow multiple agents from the same tab', () => {
    const tabId = 123;
    const ports = [
      createMockPort('porter:conn1', tabId),
      createMockPort('porter:conn2', tabId),
      createMockPort('porter:conn3', tabId),
      createMockPort('porter:conn4', tabId),
      createMockPort('porter:conn5', tabId),
    ];
    const agentIds = ports.map((port) => agentManager.addAgent(port));

    agentIds.forEach((id, idx) => {
      expect(id).toBeDefined();
      // Ensure all agent IDs are unique
      expect(agentIds.indexOf(id)).toBe(idx);
    });

    const allAgents = agentManager.getAllAgents();
    expect(allAgents.length).toBe(5);

    agentIds.forEach((id, idx) => {
      const agent = agentManager.getAgentById(id!);
      expect(agent).toBeDefined();
      expect(agent?.port).toBe(ports[idx]);
    });
  });

  it('should remove only the disconnected agent', () => {
    const tabId = 123;
    const port1 = createMockPort('porter:conn1', tabId);
    const port2 = createMockPort('porter:conn2', tabId);

    // Capture disconnect listeners
    let disconnectListener1: Function;
    let disconnectListener2: Function;

    (port1.onDisconnect.addListener as jest.Mock).mockImplementation((cb) => {
      disconnectListener1 = cb;
    });
    (port2.onDisconnect.addListener as jest.Mock).mockImplementation((cb) => {
      disconnectListener2 = cb;
    });

    const agentId1 = agentManager.addAgent(port1);
    const agentId2 = agentManager.addAgent(port2);

    expect(agentManager.getAllAgents().length).toBe(2);

    // Simulate disconnect of port1
    disconnectListener1!();

    expect(agentManager.getAllAgents().length).toBe(1);
    expect(agentManager.getAgentById(agentId1!)).toBeNull();
    expect(agentManager.getAgentById(agentId2!)).toBeDefined();
  });

  it('should queryAgents correctly for shared location', () => {
    const tabId = 123;
    const port1 = createMockPort('porter:conn1', tabId);
    const port2 = createMockPort('porter:conn2', tabId);

    agentManager.addAgent(port1);
    agentManager.addAgent(port2);

    const agents = agentManager.queryAgents({
      context: PorterContext.ContentScript,
      tabId: tabId,
    });

    expect(agents.length).toBe(2);
  });
});
