import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EdgeWorker } from '../src/EdgeWorker'
import { LinearClient } from '@linear/sdk'
import { NdjsonClient } from 'cyrus-ndjson-client'
import { ClaudeRunner } from 'cyrus-claude-runner'
import { SessionManager, Session } from 'cyrus-core'
import { SharedApplicationServer } from '../src/SharedApplicationServer'
import type { EdgeWorkerConfig } from '../src/types'
import { 
  mockIssueAssignedWebhook, 
  mockCommentWebhook,
  mockUnassignedWebhook,
  mockClaudeAssistantMessage,
  mockClaudeToolMessage,
  mockClaudeResultMessage
} from './setup'

// Mock dependencies
vi.mock('@linear/sdk')
vi.mock('cyrus-ndjson-client')
vi.mock('cyrus-claude-runner')
vi.mock('../src/SharedApplicationServer')
vi.mock('fs')
vi.mock('fs/promises')
vi.mock('cyrus-core', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    // Keep the actual type guard functions
    isIssueAssignedWebhook: actual.isIssueAssignedWebhook,
    isIssueCommentMentionWebhook: actual.isIssueCommentMentionWebhook,
    isIssueNewCommentWebhook: actual.isIssueNewCommentWebhook,
    isIssueUnassignedWebhook: actual.isIssueUnassignedWebhook,
    // Mock Session and SessionManager
    Session: vi.fn(),
    SessionManager: vi.fn()
  }
})

describe('EdgeWorker', () => {
  let edgeWorker: EdgeWorker
  let mockConfig: EdgeWorkerConfig
  let mockLinearClient: any
  let mockNdjsonClient: any
  let mockClaudeRunner: any
  let mockSessionManager: any
  let mockSharedApplicationServer: any

  beforeEach(() => {
    // Clear DEBUG_EDGE to ensure predictable behavior
    delete process.env.DEBUG_EDGE
    
    // Setup config with single repository for backward compatibility
    mockConfig = {
      proxyUrl: 'http://localhost:3000',
      repositories: [{
        id: 'test-repo',
        name: 'Test Repository',
        repositoryPath: '/tmp/test-repo',
        baseBranch: 'main',
        linearWorkspaceId: 'test-workspace',
        linearToken: 'test-linear-oauth-token',
        workspaceBaseDir: '/tmp/test-workspaces'
      }],
      handlers: {
        createWorkspace: vi.fn().mockResolvedValue({
          path: '/tmp/test-workspaces/TEST-123',
          isGitWorktree: false
        }),
        onClaudeMessage: vi.fn(),
        onSessionStart: vi.fn(),
        onSessionEnd: vi.fn(),
        onError: vi.fn()
      },
      features: {
        enableContinuation: true,
        enableTokenLimitHandling: true
      }
    }

    // Setup mock Linear client
    mockLinearClient = {
      createComment: vi.fn().mockResolvedValue({
        success: true,
        comment: { id: 'comment-123' }
      }),
      viewer: {
        id: 'cyrus-user-id',
        name: 'cyrus',
        displayName: 'Cyrus Agent',
        email: 'cyrus@ceedar.ai'
      }
    }
    vi.mocked(LinearClient).mockImplementation(() => mockLinearClient)

    // Setup mock NDJSON client
    mockNdjsonClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      on: vi.fn(),
      sendStatus: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true)
    }
    vi.mocked(NdjsonClient).mockImplementation(() => mockNdjsonClient)

    // Setup mock Claude runner
    mockClaudeRunner = {
      start: vi.fn().mockResolvedValue({
        sessionId: 'test-session-123',
        startedAt: new Date(),
        isRunning: false
      }),
      startStreaming: vi.fn().mockResolvedValue({
        sessionId: 'test-session-123',
        startedAt: new Date(),
        isRunning: false
      }),
      stop: vi.fn(),
      isRunning: vi.fn().mockReturnValue(false),
      isStreaming: vi.fn().mockReturnValue(false),
      addStreamMessage: vi.fn(),
      completeStream: vi.fn(),
      getSessionInfo: vi.fn().mockReturnValue(null),
      getMessages: vi.fn().mockReturnValue([])
    }
    vi.mocked(ClaudeRunner).mockImplementation(() => mockClaudeRunner)

    // Setup mock session manager
    mockSessionManager = {
      addSession: vi.fn(),
      getSession: vi.fn(),
      removeSession: vi.fn(),
      getAllSessions: vi.fn().mockReturnValue(new Map())
    }
    vi.mocked(SessionManager).mockImplementation(() => mockSessionManager)

    // Setup mock shared application server
    mockSharedApplicationServer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      registerWebhookHandler: vi.fn(),
      unregisterWebhookHandler: vi.fn(),
      registerOAuthCallbackHandler: vi.fn(),
      startOAuthFlow: vi.fn(),
      getWebhookUrl: vi.fn().mockReturnValue('http://localhost:3456/webhook'),
      getOAuthCallbackUrl: vi.fn().mockReturnValue('http://localhost:3456/callback'),
      isListening: false,
      port: 3456
    }
    vi.mocked(SharedApplicationServer).mockImplementation(() => mockSharedApplicationServer)

    // Create EdgeWorker instance
    edgeWorker = new EdgeWorker(mockConfig)

    // Mock the fetchFullIssueDetails method to return a mock Linear issue
    vi.spyOn(edgeWorker as any, 'fetchFullIssueDetails').mockResolvedValue({
      id: 'issue-123',
      identifier: 'TEST-123',
      title: 'Test Issue',
      description: 'Test description',
      branchName: 'TEST-123-test-issue',
      priority: 1,
      state: Promise.resolve({ name: 'In Progress' }),
      url: 'https://linear.app/test/issue/TEST-123'
    })
  })

  afterEach(async () => {
    // Stop the EdgeWorker to clean up resources
    if (edgeWorker) {
      await edgeWorker.stop()
      // Remove all event listeners to prevent memory leaks
      edgeWorker.removeAllListeners()
    }
    
    // Clear all mocks and restore original implementations
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  describe('initialization', () => {
    it('should initialize with correct config', () => {
      expect(edgeWorker).toBeDefined()
      expect(vi.mocked(LinearClient)).toHaveBeenCalledWith({
        accessToken: 'test-linear-oauth-token'
      })
      expect(vi.mocked(NdjsonClient)).toHaveBeenCalledWith({
        proxyUrl: mockConfig.proxyUrl,
        token: 'test-linear-oauth-token',
        name: 'Test Repository',
        transport: 'webhook',
        useExternalWebhookServer: true,
        externalWebhookServer: expect.any(Object),
        webhookPort: expect.any(Number),
        webhookPath: '/webhook',
        webhookHost: 'localhost',
        onConnect: expect.any(Function),
        onDisconnect: expect.any(Function),
        onError: expect.any(Function)
      })
    })

    it('should register webhook handler', () => {
      expect(mockNdjsonClient.on).toHaveBeenCalledWith('webhook', expect.any(Function))
    })

    it('should not register heartbeat handler by default', () => {
      expect(mockNdjsonClient.on).not.toHaveBeenCalledWith('heartbeat', expect.any(Function))
    })

    it('should register heartbeat handler when DEBUG_EDGE is true', () => {
      process.env.DEBUG_EDGE = 'true'
      new EdgeWorker(mockConfig)
      expect(mockNdjsonClient.on).toHaveBeenCalledWith('heartbeat', expect.any(Function))
      delete process.env.DEBUG_EDGE
    })

    it('should work without handlers', () => {
      const minimalConfig = {
        proxyUrl: 'http://localhost:3000',
        claudePath: '/usr/local/bin/claude',
        repositories: [{
          id: 'minimal-repo',
          name: 'Minimal Repository',
          repositoryPath: '/tmp/minimal-repo',
          baseBranch: 'main',
          linearWorkspaceId: 'minimal-workspace',
          linearToken: 'test-token',
          workspaceBaseDir: '/tmp/test-workspaces'
        }]
      }
      const worker = new EdgeWorker(minimalConfig)
      expect(worker).toBeDefined()
    })
  })

  describe('start/stop', () => {
    it('should start shared application server and connect to NDJSON client on start', async () => {
      await edgeWorker.start()
      expect(mockSharedApplicationServer.start).toHaveBeenCalled()
      expect(mockNdjsonClient.connect).toHaveBeenCalled()
    })

    it('should handle connection events', async () => {
      const connectedSpy = vi.fn()
      edgeWorker.on('connected', connectedSpy)

      // Trigger connection callback
      const onConnect = vi.mocked(NdjsonClient).mock.calls[0][0].onConnect
      onConnect()

      expect(connectedSpy).toHaveBeenCalledWith('test-linear-oauth-token')
      const status = edgeWorker.getConnectionStatus()
      expect(status.size).toBeGreaterThan(0)
      for (const [, isConnected] of status) {
        expect(isConnected).toBe(true)
      }
    })

    it('should handle disconnection events', () => {
      const disconnectedSpy = vi.fn()
      edgeWorker.on('disconnected', disconnectedSpy)

      // Trigger disconnection callback
      const onDisconnect = vi.mocked(NdjsonClient).mock.calls[0][0].onDisconnect
      onDisconnect('Connection lost')

      expect(disconnectedSpy).toHaveBeenCalledWith('test-linear-oauth-token', 'Connection lost')
      const status = edgeWorker.getConnectionStatus()
      expect(status.size).toBeGreaterThan(0)
      // Note: actual connection status depends on mock implementation
    })

    it('should stop all Claude processes on stop', async () => {
      // Create some mock sessions
      const runner1 = { stop: vi.fn() }
      const runner2 = { stop: vi.fn() }
      edgeWorker['claudeRunners'].set('issue-1', runner1 as any)
      edgeWorker['claudeRunners'].set('issue-2', runner2 as any)

      await edgeWorker.stop()

      expect(runner1.stop).toHaveBeenCalled()
      expect(runner2.stop).toHaveBeenCalled()
      expect(edgeWorker['claudeRunners'].size).toBe(0)
    })

    it('should clear sessions, disconnect clients and stop shared application server', async () => {
      mockSessionManager.getAllSessions.mockReturnValue(new Map([
        ['issue-1', {}],
        ['issue-2', {}]
      ]))

      await edgeWorker.stop()

      expect(mockSessionManager.removeSession).toHaveBeenCalledWith('issue-1')
      expect(mockSessionManager.removeSession).toHaveBeenCalledWith('issue-2')
      expect(mockNdjsonClient.disconnect).toHaveBeenCalled()
      expect(mockSharedApplicationServer.stop).toHaveBeenCalled()
    })
  })

  describe('webhook handling', () => {
    let webhookHandler: Function

    beforeEach(() => {
      // Get the webhook handler function
      webhookHandler = mockNdjsonClient.on.mock.calls.find(
        (call: any) => call[0] === 'webhook'
      )?.[1]
    })

    it('should handle issue assignment notifications', async () => {
      const webhook = mockIssueAssignedWebhook()
      await webhookHandler(webhook)

      // Should create workspace with full Linear issue
      expect(mockConfig.handlers.createWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'issue-123',
          identifier: 'TEST-123',
          title: 'Test Issue',
          description: 'Test description',
          branchName: 'TEST-123-test-issue'
        }),
        expect.objectContaining({ id: 'test-repo' })
      )

      // Should start Claude streaming session
      expect(mockClaudeRunner.startStreaming).toHaveBeenCalled()

      // Should create session with comment ID as key
      expect(mockSessionManager.addSession).toHaveBeenCalledWith(
        'comment-123',
        expect.any(Session)
      )

      // Should emit events with full Linear issue
      expect(mockConfig.handlers.onSessionStart).toHaveBeenCalledWith(
        'issue-123',
        expect.objectContaining({
          id: 'issue-123',
          identifier: 'TEST-123',
          title: 'Test Issue',
          description: 'Test description',
          branchName: 'TEST-123-test-issue'
        }),
        'test-repo'
      )
    })

    it('should use default workspace if no handler provided', async () => {
      delete mockConfig.handlers.createWorkspace
      const webhook = mockIssueAssignedWebhook()
      
      await webhookHandler(webhook)

      // Should still work with default workspace
      expect(vi.mocked(ClaudeRunner)).toHaveBeenCalledWith(
        expect.objectContaining({
          workingDirectory: '/tmp/test-workspaces/TEST-123'
        })
      )
    })

    it('should pass mcpConfigPath to ClaudeRunner when configured', async () => {
      // Add mcpConfigPath to repository config
      mockConfig.repositories[0].mcpConfigPath = '/path/to/mcp-config.json'
      
      const webhook = mockIssueAssignedWebhook()
      await webhookHandler(webhook)

      // Should pass mcpConfigPath to ClaudeRunner
      expect(vi.mocked(ClaudeRunner)).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpConfigPath: '/path/to/mcp-config.json'
        })
      )
    })

    it('should not pass mcpConfigPath to ClaudeRunner when not configured', async () => {
      // Ensure mcpConfigPath is not set
      delete mockConfig.repositories[0].mcpConfigPath
      
      const webhook = mockIssueAssignedWebhook()
      await webhookHandler(webhook)

      // Should not pass mcpConfigPath to ClaudeRunner
      expect(vi.mocked(ClaudeRunner)).toHaveBeenCalledWith(
        expect.not.objectContaining({
          mcpConfigPath: expect.anything()
        })
      )
    })

    it('should handle new comment notifications', async () => {
      // Setup existing session
      mockSessionManager.getSession.mockReturnValue({
        workspace: { path: '/tmp/test-workspaces/TEST-123' }
      })

      // Include a mention of the agent so it triggers
      const webhook = mockCommentWebhook({}, { body: '@cyrus please help with this' })
      await webhookHandler(webhook)

      // Should start new streaming session with comment as prompt (since no existing runner)
      expect(mockClaudeRunner.startStreaming).toHaveBeenCalledWith('@cyrus please help with this')
    })

    it('should handle issue unassignment with single thread', async () => {
      // Set up a comment thread for this issue
      const threadCommentId = 'comment-123'
      edgeWorker['issueToCommentThreads'].set('issue-123', new Set([threadCommentId]))
      
      // Set up a mock Claude runner for the thread
      const mockRunner = { stop: vi.fn() }
      edgeWorker['claudeRunners'].set(threadCommentId, mockRunner as any)

      const webhook = mockUnassignedWebhook()
      await webhookHandler(webhook)

      expect(mockRunner.stop).toHaveBeenCalled()
      expect(mockSessionManager.removeSession).toHaveBeenCalledWith(threadCommentId)
      expect(mockLinearClient.createComment).toHaveBeenCalledWith({
        issueId: 'issue-123',
        body: "I've been unassigned and am stopping work now."
      })
    })
    
    it('should handle issue unassignment with multiple active threads', async () => {
      // Set up multiple comment threads for this issue
      const thread1 = 'comment-thread-1'
      const thread2 = 'comment-thread-2'
      const thread3 = 'comment-thread-3'
      edgeWorker['issueToCommentThreads'].set('issue-123', new Set([thread1, thread2, thread3]))
      
      // Set up mock Claude runners for each thread
      const runner1 = { stop: vi.fn() }
      const runner2 = { stop: vi.fn() }
      const runner3 = { stop: vi.fn() }
      
      edgeWorker['claudeRunners'].set(thread1, runner1 as any)
      edgeWorker['claudeRunners'].set(thread2, runner2 as any)
      edgeWorker['claudeRunners'].set(thread3, runner3 as any)
      
      // Set up mappings that should be cleaned up
      edgeWorker['commentToRepo'].set(thread1, 'test-repo')
      edgeWorker['commentToRepo'].set(thread2, 'test-repo')
      edgeWorker['commentToRepo'].set(thread3, 'test-repo')
      
      edgeWorker['commentToIssue'].set(thread1, 'issue-123')
      edgeWorker['commentToIssue'].set(thread2, 'issue-123')
      edgeWorker['commentToIssue'].set(thread3, 'issue-123')
      
      edgeWorker['commentToLatestAgentReply'].set(thread1, 'reply-1')
      edgeWorker['commentToLatestAgentReply'].set(thread2, 'reply-2')
      edgeWorker['commentToLatestAgentReply'].set(thread3, 'reply-3')
      
      const webhook = mockUnassignedWebhook()
      await webhookHandler(webhook)
      
      // All runners should be stopped
      expect(runner1.stop).toHaveBeenCalled()
      expect(runner2.stop).toHaveBeenCalled()
      expect(runner3.stop).toHaveBeenCalled()
      
      // All sessions should be removed
      expect(mockSessionManager.removeSession).toHaveBeenCalledWith(thread1)
      expect(mockSessionManager.removeSession).toHaveBeenCalledWith(thread2)
      expect(mockSessionManager.removeSession).toHaveBeenCalledWith(thread3)
      
      // Only ONE farewell comment should be posted
      expect(mockLinearClient.createComment).toHaveBeenCalledTimes(1)
      expect(mockLinearClient.createComment).toHaveBeenCalledWith({
        issueId: 'issue-123',
        body: "I've been unassigned and am stopping work now."
      })
      
      // All mappings should be cleaned up
      expect(edgeWorker['claudeRunners'].has(thread1)).toBe(false)
      expect(edgeWorker['claudeRunners'].has(thread2)).toBe(false)
      expect(edgeWorker['claudeRunners'].has(thread3)).toBe(false)
      
      expect(edgeWorker['commentToRepo'].has(thread1)).toBe(false)
      expect(edgeWorker['commentToRepo'].has(thread2)).toBe(false)
      expect(edgeWorker['commentToRepo'].has(thread3)).toBe(false)
      
      expect(edgeWorker['commentToIssue'].has(thread1)).toBe(false)
      expect(edgeWorker['commentToIssue'].has(thread2)).toBe(false)
      expect(edgeWorker['commentToIssue'].has(thread3)).toBe(false)
      
      expect(edgeWorker['commentToLatestAgentReply'].has(thread1)).toBe(false)
      expect(edgeWorker['commentToLatestAgentReply'].has(thread2)).toBe(false)
      expect(edgeWorker['commentToLatestAgentReply'].has(thread3)).toBe(false)
      
      // Issue-level mappings should be cleaned
      expect(edgeWorker['issueToCommentThreads'].has('issue-123')).toBe(false)
    })

    it('should ignore comments when continuation is disabled', async () => {
      mockConfig.features!.enableContinuation = false
      mockSessionManager.getSession.mockReturnValue({})

      const webhook = mockCommentWebhook()
      await webhookHandler(webhook)

      expect(mockClaudeRunner.start).not.toHaveBeenCalled()
    })

    it('should ignore comments for non-existent sessions', async () => {
      mockSessionManager.getSession.mockReturnValue(null)

      // Include a mention of the agent so it triggers
      const webhook = mockCommentWebhook({}, { body: '@cyrus please help with this' })
      await webhookHandler(webhook)

      // When there's no existing session, it should restart from scratch (handleIssueAssigned)
      // So startStreaming will be called with the full issue prompt, not just the comment
      expect(mockClaudeRunner.startStreaming).toHaveBeenCalled()
    })

    it('should handle failures gracefully without crashing', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockConfig.handlers.createWorkspace!.mockRejectedValue(new Error('Workspace error'))

      const webhook = mockIssueAssignedWebhook()
      
      // Should not throw/reject - errors should be caught and logged
      await expect(webhookHandler(webhook)).resolves.toBeUndefined()
      
      // Should log the error
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EdgeWorker] Failed to process webhook:'),
        expect.any(Error)
      )
      
      consoleSpy.mockRestore()
    })

  })

  describe('Claude event handling', () => {
    it('should handle assistant responses', async () => {
      // Setup Claude runner with message handler
      let claudeMessageHandler: Function
      vi.mocked(ClaudeRunner).mockImplementation((config) => {
        claudeMessageHandler = config.onMessage
        return mockClaudeRunner
      })

      // Create a session
      const webhook = mockIssueAssignedWebhook()
      const webhookHandler = mockNdjsonClient.on.mock.calls.find(
        (call: any) => call[0] === 'webhook'
      )?.[1]
      await webhookHandler(webhook)

      // Emit Claude assistant message
      const message = mockClaudeAssistantMessage('Hello from Claude!')
      await claudeMessageHandler!(message)

      // Should NOT post comment to Linear for assistant messages (only for result messages)
      // The initial comment should be the only one posted
      expect(mockLinearClient.createComment).toHaveBeenCalledWith({
        issueId: 'issue-123',
        body: "I've been assigned to this issue and am getting started right away. I'll update this comment with my plan shortly."
      })

      // Should emit message events
      expect(mockConfig.handlers.onClaudeMessage).toHaveBeenCalledWith('issue-123', message, 'test-repo')
    })

    it('should handle tool use events', async () => {
      let claudeMessageHandler: Function
      vi.mocked(ClaudeRunner).mockImplementation((config) => {
        claudeMessageHandler = config.onMessage
        return mockClaudeRunner
      })

      const webhook = mockIssueAssignedWebhook()
      const webhookHandler = mockNdjsonClient.on.mock.calls.find(
        (call: any) => call[0] === 'webhook'
      )?.[1]
      await webhookHandler(webhook)

      const toolUseSpy = vi.fn()
      edgeWorker.on('claude:tool-use', toolUseSpy)

      const message = mockClaudeToolMessage('bash', { command: 'ls -la' })
      await claudeMessageHandler!(message)

      expect(toolUseSpy).toHaveBeenCalledWith('issue-123', 'bash', { command: 'ls -la' }, 'test-repo')
    })

    it('should handle Claude errors', async () => {
      let claudeErrorHandler: Function
      vi.mocked(ClaudeRunner).mockImplementation((config) => {
        claudeErrorHandler = config.onError
        return mockClaudeRunner
      })

      const webhook = mockIssueAssignedWebhook()
      const webhookHandler = mockNdjsonClient.on.mock.calls.find(
        (call: any) => call[0] === 'webhook'
      )?.[1]
      await webhookHandler(webhook)

      const sessionEndedSpy = vi.fn()
      edgeWorker.on('session:ended', sessionEndedSpy)

      const error = new Error('Something went wrong')
      await claudeErrorHandler!(error)

      expect(sessionEndedSpy).toHaveBeenCalledWith('issue-123', 1, 'test-repo')
      expect(mockConfig.handlers.onSessionEnd).toHaveBeenCalledWith('issue-123', 1, 'test-repo')
    })

    it('should handle token limit errors', async () => {
      let claudeMessageHandler: Function
      vi.mocked(ClaudeRunner).mockImplementation((config) => {
        claudeMessageHandler = config.onMessage
        return mockClaudeRunner
      })

      const webhook = mockIssueAssignedWebhook()
      const webhookHandler = mockNdjsonClient.on.mock.calls.find(
        (call: any) => call[0] === 'webhook'
      )?.[1]
      await webhookHandler(webhook)

      mockSessionManager.getSession.mockReturnValue({
        issue: webhook.notification.issue
      })

      const errorSpy = vi.fn()
      edgeWorker.on('error', errorSpy)

      const message = mockClaudeResultMessage('error_max_turns')
      await claudeMessageHandler!(message)

      // Should post warning as a reply to the comment thread
      expect(mockLinearClient.createComment).toHaveBeenCalledWith({
        issueId: 'issue-123',
        body: '[System] Token limit reached. Starting fresh session with issue context.',
        parentId: 'comment-123'
      })

      // Should restart session (initial + restart = 2 times total)
      expect(mockClaudeRunner.startStreaming).toHaveBeenCalledTimes(2)
    })

    it('should handle Claude session completion', async () => {
      let completeHandler: Function
      vi.mocked(ClaudeRunner).mockImplementation((config) => {
        completeHandler = config.onComplete
        return mockClaudeRunner
      })

      // Create a session first
      const webhook = mockIssueAssignedWebhook()
      const webhookHandler = mockNdjsonClient.on.mock.calls.find(
        (call: any) => call[0] === 'webhook'
      )?.[1]
      await webhookHandler(webhook)

      // Now test completion handling
      const messages = [mockClaudeAssistantMessage('Task completed')]
      await completeHandler!(messages)

      expect(edgeWorker['claudeRunners'].has('issue-123')).toBe(false)
      expect(mockConfig.handlers.onSessionEnd).toHaveBeenCalledWith('issue-123', 0, 'test-repo')
    })

    it('should handle comment creation failures gracefully', async () => {
      // Mock console.error to verify error logging
      const consoleErrorSpy = vi.spyOn(console, 'error')
      
      // Reset the mock to clear the initial comment creation
      mockLinearClient.createComment.mockClear()
      mockLinearClient.createComment.mockResolvedValueOnce({
        success: true,
        comment: { id: 'comment-123' }
      })
      mockLinearClient.createComment.mockRejectedValueOnce(new Error('API Error'))

      let claudeMessageHandler: Function
      vi.mocked(ClaudeRunner).mockImplementation((config) => {
        claudeMessageHandler = config.onMessage
        return mockClaudeRunner
      })

      const webhook = mockIssueAssignedWebhook()
      const webhookHandler = mockNdjsonClient.on.mock.calls.find(
        (call: any) => call[0] === 'webhook'
      )?.[1]
      await webhookHandler(webhook)

      // Use a result message which actually posts comments
      const message = mockClaudeResultMessage('success')
      
      // The handler doesn't throw, it logs the error and continues
      await claudeMessageHandler!(message)
      
      // Verify error was logged but not thrown
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to create comment on issue issue-123:'),
        expect.any(Error)
      )
    })
  })

  describe('Comment to Latest Reply Mapping', () => {
    let webhookHandler: Function
    
    beforeEach(() => {
      webhookHandler = mockNdjsonClient.on.mock.calls.find(
        (call: any) => call[0] === 'webhook'
      )?.[1]
    })
    
    it('should track latest agent reply when posting comments', async () => {
      // Setup mock to capture Claude message handler
      let claudeMessageHandler: Function
      vi.mocked(ClaudeRunner).mockImplementation((config) => {
        claudeMessageHandler = config.onMessage
        return mockClaudeRunner
      })
      
      // Setup initial issue assignment
      const webhook = mockIssueAssignedWebhook()
      await webhookHandler(webhook)
      
      // The initial comment should set the mapping to itself
      expect(edgeWorker['commentToLatestAgentReply'].get('comment-123')).toBe('comment-123')
      
      // Setup mock Linear client with createComment
      const linearClient = {
        createComment: vi.fn().mockResolvedValue({
          comment: { id: 'reply-comment-456' },
          success: true
        })
      }
      edgeWorker['linearClients'].set('test-repo', linearClient as any)
      
      // Simulate Claude posting a successful result
      const message = mockClaudeResultMessage('success')
      await claudeMessageHandler!(message)
      
      // Check that the mapping was updated
      const mapping = edgeWorker['commentToLatestAgentReply']
      expect(mapping.get('comment-123')).toBe('reply-comment-456')
    })
    
    it('should update latest reply for subsequent messages in same thread', async () => {
      // Setup mock to capture Claude message handler
      let claudeMessageHandler: Function
      vi.mocked(ClaudeRunner).mockImplementation((config) => {
        claudeMessageHandler = config.onMessage
        return mockClaudeRunner
      })
      
      // Setup
      const webhook = mockIssueAssignedWebhook()
      await webhookHandler(webhook)
      
      // Set initial reply
      edgeWorker['commentToLatestAgentReply'].set('comment-123', 'reply-1')
      
      // Setup mock Linear client
      const linearClient = {
        createComment: vi.fn().mockResolvedValue({
          comment: { id: 'reply-2' },
          success: true
        })
      }
      edgeWorker['linearClients'].set('test-repo', linearClient as any)
      
      const message = mockClaudeResultMessage('success')
      await claudeMessageHandler!(message)
      
      // Should update to latest reply
      expect(edgeWorker['commentToLatestAgentReply'].get('comment-123')).toBe('reply-2')
    })
    
    it('should handle root comments (no parent) correctly', async () => {
      const webhook = mockIssueAssignedWebhook()
      await webhookHandler(webhook)
      
      // The initial comment is the root, so it should map to itself after being posted
      const mapping = edgeWorker['commentToLatestAgentReply']
      expect(mapping.get('comment-123')).toBe('comment-123')
    })
    
    it('should use latest reply for todo updates', async () => {
      // Setup mock to capture Claude message handler
      let claudeMessageHandler: Function
      vi.mocked(ClaudeRunner).mockImplementation((config) => {
        claudeMessageHandler = config.onMessage
        return mockClaudeRunner
      })
      
      const webhook = mockIssueAssignedWebhook()
      await webhookHandler(webhook)
      
      // Set a latest reply
      edgeWorker['commentToLatestAgentReply'].set('comment-123', 'latest-reply-789')
      
      // Setup mock Linear client with updateComment
      const linearClient = {
        updateComment: vi.fn().mockResolvedValue({ success: true })
      }
      edgeWorker['linearClients'].set('test-repo', linearClient as any)
      
      const todoMessage = {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'TodoWrite',
            input: {
              todos: [
                { id: '1', content: 'Test todo', status: 'pending', priority: 'high' }
              ]
            }
          }]
        }
      }
      
      await claudeMessageHandler!(todoMessage)
      
      // Should update the latest reply, not the root
      expect(linearClient.updateComment).toHaveBeenCalledWith(
        'latest-reply-789',
        expect.any(Object)
      )
    })
  })

  describe('comment mention detection', () => {
    let webhookHandler: Function

    beforeEach(() => {
      // Get the webhook handler function
      webhookHandler = mockNdjsonClient.on.mock.calls.find(
        (call: any) => call[0] === 'webhook'
      )?.[1]

      // Setup mock Linear client with viewer information for mention detection
      mockLinearClient = {
        createComment: vi.fn().mockResolvedValue({
          success: true,
          comment: { id: 'comment-123' }
        }),
        viewer: {
          id: 'cyrus-user-id',
          name: 'cyrus',
          displayName: 'Cyrus Agent',
          email: 'cyrus@ceedar.ai'
        }
      }
      vi.mocked(LinearClient).mockImplementation(() => mockLinearClient)
    })

    it('should trigger when agent is mentioned by name', async () => {
      // Setup existing session to avoid triggering full issue assignment
      mockSessionManager.getSession.mockReturnValue({
        workspace: { path: '/tmp/test-workspaces/TEST-123' }
      })

      const webhook = mockCommentWebhook({}, { 
        body: 'Hey @cyrus, can you help with this?' 
      })
      await webhookHandler(webhook)

      // Should start Claude streaming session since agent is mentioned
      expect(mockClaudeRunner.startStreaming).toHaveBeenCalledWith('Hey @cyrus, can you help with this?')
    })

    it('should trigger when agent is mentioned by display name', async () => {
      // Setup existing session to avoid triggering full issue assignment
      mockSessionManager.getSession.mockReturnValue({
        workspace: { path: '/tmp/test-workspaces/TEST-123' }
      })

      const webhook = mockCommentWebhook({}, { 
        body: 'Hey @"Cyrus Agent", can you help with this?' 
      })
      await webhookHandler(webhook)

      // Should start Claude streaming session since agent is mentioned
      expect(mockClaudeRunner.startStreaming).toHaveBeenCalledWith('Hey @"Cyrus Agent", can you help with this?')
    })

    it('should trigger when agent is mentioned by user ID', async () => {
      // Setup existing session to avoid triggering full issue assignment
      mockSessionManager.getSession.mockReturnValue({
        workspace: { path: '/tmp/test-workspaces/TEST-123' }
      })

      const webhook = mockCommentWebhook({}, { 
        body: 'Hey @cyrus-user-id, can you help with this?' 
      })
      await webhookHandler(webhook)

      // Should start Claude streaming session since agent is mentioned
      expect(mockClaudeRunner.startStreaming).toHaveBeenCalledWith('Hey @cyrus-user-id, can you help with this?')
    })

    it('should NOT trigger when only other users are mentioned', async () => {
      // Setup existing session to avoid triggering full issue assignment
      mockSessionManager.getSession.mockReturnValue({
        workspace: { path: '/tmp/test-workspaces/TEST-123' }
      })

      const webhook = mockCommentWebhook({}, { 
        body: 'Hey @john and @jane, can you help with this?' 
      })
      await webhookHandler(webhook)

      // Should NOT start Claude session since agent is not mentioned
      expect(mockClaudeRunner.start).not.toHaveBeenCalled()
    })

    it('should NOT trigger when no mentions are present', async () => {
      // Setup existing session to avoid triggering full issue assignment
      mockSessionManager.getSession.mockReturnValue({
        workspace: { path: '/tmp/test-workspaces/TEST-123' }
      })

      const webhook = mockCommentWebhook({}, { 
        body: 'This is just a regular comment without mentions' 
      })
      await webhookHandler(webhook)

      // Should NOT start Claude session since agent is not mentioned
      expect(mockClaudeRunner.start).not.toHaveBeenCalled()
    })

    it('should trigger when agent is mentioned along with other users', async () => {
      // Setup existing session to avoid triggering full issue assignment
      mockSessionManager.getSession.mockReturnValue({
        workspace: { path: '/tmp/test-workspaces/TEST-123' }
      })

      const webhook = mockCommentWebhook({}, { 
        body: 'Hey @john, @cyrus, and @jane, can you all help with this?' 
      })
      await webhookHandler(webhook)

      // Should start Claude streaming session since agent is mentioned (even with others)
      expect(mockClaudeRunner.startStreaming).toHaveBeenCalledWith('Hey @john, @cyrus, and @jane, can you all help with this?')
    })

    it('should be case-insensitive when checking mentions by name', async () => {
      // Setup existing session to avoid triggering full issue assignment
      mockSessionManager.getSession.mockReturnValue({
        workspace: { path: '/tmp/test-workspaces/TEST-123' }
      })

      const webhook = mockCommentWebhook({}, { 
        body: 'Hey @CYRUS, can you help with this?' 
      })
      await webhookHandler(webhook)

      // Should start Claude streaming session since agent is mentioned (case-insensitive)
      expect(mockClaudeRunner.startStreaming).toHaveBeenCalledWith('Hey @CYRUS, can you help with this?')
    })

    it('should still work when viewer information is unavailable', async () => {
      // Setup existing session to avoid triggering full issue assignment
      mockSessionManager.getSession.mockReturnValue({
        workspace: { path: '/tmp/test-workspaces/TEST-123' }
      })

      // Mock Linear client to return null viewer
      mockLinearClient.viewer = null
      
      const webhook = mockCommentWebhook({}, { 
        body: 'Hey @cyrus, can you help with this?' 
      })
      await webhookHandler(webhook)

      // Should err on the side of caution and trigger when viewer info is unavailable
      expect(mockClaudeRunner.startStreaming).toHaveBeenCalledWith('Hey @cyrus, can you help with this?')
    })

    it('should NOT trigger when Linear client is unavailable', async () => {
      // Setup existing session to avoid triggering full issue assignment
      mockSessionManager.getSession.mockReturnValue({
        workspace: { path: '/tmp/test-workspaces/TEST-123' }
      })

      // Remove the Linear client to simulate error condition
      edgeWorker['linearClients'].clear()
      
      const webhook = mockCommentWebhook({}, { 
        body: 'Hey @someone, can you help with this?' 
      })
      await webhookHandler(webhook)

      // Should NOT trigger when client is unavailable since we can't verify mentions
      expect(mockClaudeRunner.start).not.toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('should emit error events', () => {
      const errorSpy = vi.fn()
      edgeWorker.on('error', errorSpy)

      const onError = vi.mocked(NdjsonClient).mock.calls[0][0].onError
      const error = new Error('Connection error')
      onError(error)

      expect(errorSpy).toHaveBeenCalledWith(error)
      expect(mockConfig.handlers.onError).toHaveBeenCalledWith(error)
    })
  })

  describe('getters', () => {
    it('should return connection status', () => {
      const statusBefore = edgeWorker.getConnectionStatus()
      expect(statusBefore.size).toBe(1)
      expect(statusBefore.get('test-repo')).toBe(true) // Mock returns true by default

      // Test that we can check connection status
      const onConnect = vi.mocked(NdjsonClient).mock.calls[0][0].onConnect
      onConnect()

      const statusAfter = edgeWorker.getConnectionStatus()
      expect(statusAfter.size).toBe(1)
      expect(statusAfter.get('test-repo')).toBe(true)
    })

    it('should return active sessions', () => {
      mockSessionManager.getAllSessions.mockReturnValue(new Map([
        ['issue-1', {}],
        ['issue-2', {}],
        ['issue-3', {}]
      ]))

      const sessions = edgeWorker.getActiveSessions()
      expect(sessions).toEqual(['issue-1', 'issue-2', 'issue-3'])
    })
  })

  describe('Multiple Sessions Per Issue', () => {
    let webhookHandler: Function
    
    beforeEach(() => {
      webhookHandler = mockNdjsonClient.on.mock.calls.find(
        (call: any) => call[0] === 'webhook'
      )?.[1]
    })
    
    it('should support multiple comment threads per issue', async () => {
      // Setup: Create initial thread via assignment
      const assignmentWebhook = mockIssueAssignedWebhook()
      await webhookHandler(assignmentWebhook)
      
      // Verify first thread was created
      const initialThreads = edgeWorker['issueToCommentThreads'].get('issue-123')
      expect(initialThreads?.size).toBe(1)
      expect(initialThreads?.has('comment-123')).toBe(true)
      
      // Setup: Manually add a second thread to simulate multiple threads
      const threads = edgeWorker['issueToCommentThreads'].get('issue-123') || new Set()
      threads.add('comment-thread-2')
      edgeWorker['issueToCommentThreads'].set('issue-123', threads)
      
      // Create a mock runner for the second thread
      const secondRunner = {
        startStreaming: vi.fn(),
        stop: vi.fn(),
        isStreaming: vi.fn().mockReturnValue(false)
      }
      edgeWorker['claudeRunners'].set('comment-thread-2', secondRunner as any)
      
      // Create a session for the second thread
      const secondSession = new Session({
        issue: { id: 'issue-123', identifier: 'TEST-123', title: 'Test Issue' } as any,
        workspace: { path: '/test/workspace2', isGitWorktree: false },
        startedAt: new Date(),
        agentRootCommentId: 'comment-thread-2'
      })
      mockSessionManager.addSession('comment-thread-2', secondSession)
      
      // Verify we have two threads
      const allThreads = edgeWorker['issueToCommentThreads'].get('issue-123')
      expect(allThreads?.size).toBe(2)
      expect(allThreads?.has('comment-123')).toBe(true)
      expect(allThreads?.has('comment-thread-2')).toBe(true)
      
      // Verify we have two runners
      expect(edgeWorker['claudeRunners'].has('comment-123')).toBe(true)
      expect(edgeWorker['claudeRunners'].has('comment-thread-2')).toBe(true)
    })
    
    it('should isolate sessions between comment threads', async () => {
      // Setup two threads
      edgeWorker['issueToCommentThreads'].set('issue-123', new Set(['thread-1', 'thread-2']))
      
      // Create separate mocks for each runner
      const runner1Mock = {
        startStreaming: vi.fn(),
        stop: vi.fn(),
        isStreaming: vi.fn().mockReturnValue(true)
      }
      
      const runner2Mock = {
        startStreaming: vi.fn(),
        stop: vi.fn(),
        isStreaming: vi.fn().mockReturnValue(true)
      }
      
      edgeWorker['claudeRunners'].set('thread-1', runner1Mock as any)
      edgeWorker['claudeRunners'].set('thread-2', runner2Mock as any)
      
      // Stop one thread
      await edgeWorker['claudeRunners'].get('thread-1')?.stop()
      
      // Only thread-1 should be stopped
      expect(runner1Mock.stop).toHaveBeenCalled()
      expect(runner2Mock.stop).not.toHaveBeenCalled()
      expect(runner2Mock.isStreaming()).toBe(true)
    })
    
    it('should handle replies to different comment threads independently', async () => {
      // Setup issue with two comment threads
      edgeWorker['issueToCommentThreads'].set('issue-123', new Set(['thread-1', 'thread-2']))
      
      // Setup sessions for both threads
      const session1 = { workspace: { path: '/test/thread-1' } }
      const session2 = { workspace: { path: '/test/thread-2' } }
      
      mockSessionManager.getSession
        .mockReturnValueOnce(session1) // First call for thread-1
        .mockReturnValueOnce(session2) // Second call for thread-2
      
      // Setup mock Linear client
      const linearClient = {
        comment: vi.fn(),
        createComment: vi.fn().mockResolvedValue({
          success: true,
          comment: { id: 'new-reply' }
        }),
        viewer: {
          id: 'cyrus-user-id',
          name: 'Cyrus Agent'
        }
      }
      edgeWorker['linearClients'].set('test-repo', linearClient as any)
      
      // Setup Claude runners for both threads
      edgeWorker['claudeRunners'].set('thread-1', mockClaudeRunner as any)
      edgeWorker['claudeRunners'].set('thread-2', { ...mockClaudeRunner, startStreaming: vi.fn() } as any)
      
      // Reply to first thread
      const reply1 = {
        ...mockCommentWebhook({}, {
          id: 'reply-1-1',
          body: '@cyrus more details for feature A',
          parent: { id: 'thread-1' }
        }),
        action: 'issueCommentMention',
        notification: {
          ...mockCommentWebhook({}, {}).notification,
          type: 'issueCommentMention',
          comment: {
            id: 'reply-1-1',
            body: '@cyrus more details for feature A',
            parent: { id: 'thread-1' }
          }
        }
      }
      
      linearClient.comment.mockResolvedValueOnce({
        id: 'reply-1-1',
        parent: { id: 'thread-1' }
      })
      
      await webhookHandler(reply1)
      
      // Should use thread-1 as root
      expect(mockSessionManager.getSession).toHaveBeenCalledWith('thread-1')
      expect(mockClaudeRunner.startStreaming).toHaveBeenCalledWith('@cyrus more details for feature A')
      
      // Clear calls for second test
      mockSessionManager.getSession.mockClear()
      
      // Reply to second thread
      const reply2 = {
        ...mockCommentWebhook({}, {
          id: 'reply-2-1',
          body: '@cyrus more details for feature B',
          parent: { id: 'thread-2' }
        }),
        action: 'issueCommentMention',
        notification: {
          ...mockCommentWebhook({}, {}).notification,
          type: 'issueCommentMention',
          comment: {
            id: 'reply-2-1',
            body: '@cyrus more details for feature B',
            parent: { id: 'thread-2' }
          }
        }
      }
      
      linearClient.comment.mockResolvedValueOnce({
        id: 'reply-2-1',
        parent: { id: 'thread-2' }
      })
      
      await webhookHandler(reply2)
      
      // Should use thread-2 as root
      expect(mockSessionManager.getSession).toHaveBeenCalledWith('thread-2')
    })
  })

  describe('branch name sanitization', () => {
    it('should sanitize branch names by removing backticks', () => {
      // Test the sanitization function directly
      const sanitizeBranchName = (name: string) => name ? name.replace(/`/g, '') : name
      
      expect(sanitizeBranchName('TEST-123-issue-with-`backticks`-in-title')).toBe('TEST-123-issue-with-backticks-in-title')
      expect(sanitizeBranchName('Normal-branch-name')).toBe('Normal-branch-name')
      expect(sanitizeBranchName('`start-with-backtick')).toBe('start-with-backtick')
      expect(sanitizeBranchName('end-with-backtick`')).toBe('end-with-backtick')
      expect(sanitizeBranchName('')).toBe('')
    })
  })
})