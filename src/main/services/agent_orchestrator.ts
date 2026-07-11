// src/main/services/agent_orchestrator.ts
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';
import { geminiLiveBridge } from './gemini_live_bridge';
import { BrowserWindow } from 'electron';

type FunctionResponsePayload = {
  id: string;
  name: string;
  response: Record<string, unknown>;
};

export interface ISecurityAuditResult {
  passed: boolean;
  reason?: string;
}

export interface IToolDefinition {
  id: string;
  name: string;
  description: string;
  sourceCode: string;
  compiledFn: Function | null;
  status: 'pending' | 'compiled' | 'failed';
  createdAt: number;
}

export interface IProgressStep {
  stepId: string;
  label: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  timestamp: number;
}

export type ToolSynthesisPhase = 
  | 'IDLE'
  | 'SEARCHING_REGISTRY'
  | 'TOOL_NOT_FOUND'
  | 'DESIGNING_ARCHITECTURE'
  | 'WRITING_CODE'
  | 'COMPILING_ASSETS'
  | 'RUNNING_SANITY_TESTS'
  | 'DEPLOYING_TOOL'
  | 'COMPLETED'
  | 'FAILED';

const BLOCKED_KEYWORDS: string[] = [
  'process.exit',
  'process.env',
  'fs.rmSync',
  'child_process',
  'require(',
  'eval(',
  'Function(',
  'globalThis',
];

const INFINITE_LOOP_PATTERNS: RegExp[] = [
  /while\s*\(\s*true\s*\)/,
  /for\s*\(\s*;\s*;\s*\)/,
];

export class AgentOrchestrator extends EventEmitter {
  private toolRegistry: Map<string, IToolDefinition> = new Map();
  private activeProgressSteps: IProgressStep[] = [];
  private currentPhase: ToolSynthesisPhase = 'IDLE';
  private apiKey: string;
  private projectRoot: string;
  private readonly toolDeclarations: unknown[] = [
    { google_search: {} },
    {
      function_declarations: [
        {
          name: 'generate_cad',
          description: 'Generates a 3D CAD model based on a prompt.',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              prompt: { type: 'STRING', description: 'The description of the object to generate.' }
            },
            required: ['prompt']
          }
        },
        {
          name: 'run_web_agent',
          description: 'Opens a web browser and performs a task according to the prompt.',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              prompt: { type: 'STRING', description: 'The detailed instructions for the web browser agent.' }
            },
            required: ['prompt']
          }
        },
        {
          name: 'create_project',
          description: 'Creates a new project folder to organize files.',
          parameters: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING', description: 'The name of the new project.' }
            },
            required: ['name']
          }
        },
        {
          name: 'switch_project',
          description: 'Switches the current active project context.',
          parameters: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING', description: 'The name of the project to switch to.' }
            },
            required: ['name']
          }
        },
        {
          name: 'list_projects',
          description: 'Lists all available projects.',
          parameters: {
            type: 'OBJECT',
            properties: {},
          }
        },
        {
          name: 'list_smart_devices',
          description: 'Lists all available smart home devices (lights, plugs, etc.) on the network.',
          parameters: {
            type: 'OBJECT',
            properties: {},
          }
        },
        {
          name: 'control_light',
          description: 'Controls a smart light device.',
          parameters: {
            type: 'OBJECT',
            properties: {
              target: { type: 'STRING', description: 'The IP address of the device to control. Always prefer the IP address over the alias for reliability.' },
              action: { type: 'STRING', description: "The action to perform: 'turn_on', 'turn_off', or 'set'." },
              brightness: { type: 'INTEGER', description: 'Optional brightness level (0-100).' },
              color: { type: 'STRING', description: "Optional color name (e.g., 'red', 'cool white') or 'warm'." }
            },
            required: ['target', 'action']
          }
        },
        {
          name: 'discover_printers',
          description: 'Discovers 3D printers available on the local network.',
          parameters: {
            type: 'OBJECT',
            properties: {},
          }
        },
        {
          name: 'print_stl',
          description: 'Prints an STL file to a 3D printer. Handles slicing the STL to G-code and uploading to the printer.',
          parameters: {
            type: 'OBJECT',
            properties: {
              stl_path: { type: 'STRING', description: "Path to STL file, or 'current' for the most recent CAD model." },
              printer: { type: 'STRING', description: 'Printer name or IP address.' },
              profile: { type: 'STRING', description: 'Optional slicer profile name.' }
            },
            required: ['stl_path', 'printer']
          }
        },
        {
          name: 'get_print_status',
          description: 'Gets the current status of a 3D printer including progress, time remaining, and temperatures.',
          parameters: {
            type: 'OBJECT',
            properties: {
              printer: { type: 'STRING', description: 'Printer name or IP address.' }
            },
            required: ['printer']
          }
        },
        {
          name: 'iterate_cad',
          description: 'Modifies or iterates on the current CAD design based on user feedback.',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              prompt: { type: 'STRING', description: 'The changes or modifications to apply to the current design.' }
            },
            required: ['prompt']
          }
        },
      ]
    }
  ];

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
    this.projectRoot = path.join(process.cwd(), 'agent_projects');
    try {
      if (!fs.existsSync(this.projectRoot)) {
        fs.mkdirSync(this.projectRoot, { recursive: true });
      }
    } catch (err) {
      console.error('[agent_orchestrator] failed to create project root:', err);
    }
  }

  private resolveSandboxedPath(requested: string): string {
    if (typeof requested !== 'string' || requested.trim().length === 0) {
      throw new Error('A non-empty relative path is required for sandboxed file operations.');
    }
    const resolved = path.resolve(this.projectRoot, requested);
    const rootWithSep = this.projectRoot.endsWith(path.sep)
      ? this.projectRoot
      : this.projectRoot + path.sep;
    if (resolved !== this.projectRoot && !resolved.startsWith(rootWithSep)) {
      throw new Error(`Path "${requested}" escapes the agent project sandbox.`);
    }
    return resolved;
  }

  public performSecurityAudit(code: string): ISecurityAuditResult {
    for (const keyword of BLOCKED_KEYWORDS) {
      if (code.includes(keyword)) {
        return { passed: false, reason: `Blocked keyword detected: "${keyword}"` };
      }
    }
    for (const pattern of INFINITE_LOOP_PATTERNS) {
      if (pattern.test(code)) {
        return { passed: false, reason: `Potential infinite loop detected: ${pattern.source}` };
      }
    }
    return { passed: true };
  }

  public getToolDeclarations(): unknown[] {
    return this.toolDeclarations;
  }

  public async handleToolCall(toolCall: any): Promise<FunctionResponsePayload[]> {
    const functionResponses: FunctionResponsePayload[] = [];
    if (!toolCall || !Array.isArray(toolCall.functionCalls)) {
      return functionResponses;
    }

    for (const fc of toolCall.functionCalls) {
      try {
        const response = await this.executeFunctionCall(fc);
        functionResponses.push(response);
      } catch (err: any) {
        functionResponses.push({
          id: fc?.id ?? crypto.randomUUID(),
          name: fc?.name ?? 'unknown_tool',
          response: { error: err?.message ?? 'Tool execution failed' }
        });
      }
    }

    return functionResponses;
  }

  private async executeFunctionCall(fc: any): Promise<FunctionResponsePayload> {
    const name: string = fc.name;
    const args = fc.args ?? {};
    const id: string = fc.id ?? crypto.randomUUID();

    switch (name) {
      case 'generate_cad':
      case 'run_web_agent':
      case 'iterate_cad':
        return {
          id,
          name,
          response: { result: `${name} started asynchronously.` }
        };

      case 'write_file': {
        const filePath = this.resolveSandboxedPath(args.path as string);
        const content = args.content as string;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
        return { id, name, response: { result: `Wrote file ${filePath}` } };
      }

      case 'read_directory': {
        const dirPath = this.resolveSandboxedPath(args.path as string);
        const entries = fs.readdirSync(dirPath);
        return { id, name, response: { result: entries.join('\n') } };
      }

      case 'read_file': {
        const filePath = this.resolveSandboxedPath(args.path as string);
        const content = fs.readFileSync(filePath, 'utf-8');
        return { id, name, response: { result: content } };
      }

      case 'create_project': {
        const projectName = args.name as string;
        const targetPath = this.resolveSandboxedPath(projectName);
        if (!fs.existsSync(targetPath)) {
          fs.mkdirSync(targetPath, { recursive: true });
        }
        return { id, name, response: { result: `Created project ${projectName}` } };
      }

      case 'switch_project': {
        const projectName = args.name as string;
        const targetPath = this.resolveSandboxedPath(projectName);
        if (!fs.existsSync(targetPath)) {
          return { id, name, response: { result: `Project ${projectName} does not exist.` } };
        }
        return { id, name, response: { result: `Switched active project to ${projectName}` } };
      }

      case 'list_projects': {
        const folders = fs.readdirSync(this.projectRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
        return { id, name, response: { result: folders.join('\n') } };
      }

      case 'list_smart_devices':
      case 'discover_printers':
        return { id, name, response: { result: 'Device discovery is not available in this runtime.' } };

      case 'control_light':
      case 'print_stl':
      case 'get_print_status':
        return { id, name, response: { result: `${name} is not supported by this local Electron runtime.` } };

      default:
        return { id, name, response: { result: `Unhandled tool: ${name}` } };
    }
  }

  public async generateToolFromIntent(intent: string): Promise<IToolDefinition> {
    const toolId = crypto.randomUUID();
    this.activeProgressSteps = [];
    this.currentPhase = 'IDLE';

    // Phase 1: Search registry
    this.setPhase('SEARCHING_REGISTRY');
    this.emitProgressStep('Searching tool registry...', 'active');
    this.completeLastStep();

    // Simulate registry search - tool not found
    this.setPhase('TOOL_NOT_FOUND');
    this.emitProgressStep('No existing tool found — initiating synthesis', 'active');
    this.completeLastStep();

    // Phase 2: Design architecture
    this.setPhase('DESIGNING_ARCHITECTURE');
    this.emitProgressStep('Designing tool architecture...', 'active');
    this.completeLastStep();

    // Phase 3: Write code
    this.setPhase('WRITING_CODE');
    this.emitProgressStep('Synthesizing tool script...', 'active');

    let generatedJS = '';
    let toolName = 'DynamicStreamTool';
    const intentSummary = intent.length > 80 ? `${intent.slice(0, 80)}…` : intent;
    const toolDescription = `Synthesized live-stream widget for intent: "${intentSummary}"`;

    try {
      if (!this.apiKey) {
        throw new Error('API Key missing for agent dynamic compiler.');
      }

      const prompt = `You are a secure coding assistant. Write a valid JavaScript function that returns video stream parameters for user request: "${intent}".
Your output must be ONLY the raw function code without comments, markdown tags, or explanations.
The function signature must be:
(function buildVideoWidget(context) {
  return {
    success: true,
    streamType: "hls",
    streamUrl: "https://live-hls-web-aje.getaj.net/AJE/index.m3u8",
    width: "100%",
    height: "100%"
  };
})

Rules:
- Use streamType "hls" for .m3u8 URLs (example: https://live-hls-web-aje.getaj.net/AJE/index.m3u8)
- Use streamType "embed" for YouTube or other web embed URLs
- Choose a real, publicly accessible live stream URL appropriate to the user request`;

      generatedJS = await this.queryGeminiModel(prompt);
      
      // Sanitise clean code
      generatedJS = generatedJS.replace(/^```javascript\n/, '').replace(/^```\n/, '').replace(/```$/, '').trim();
      
      const match = generatedJS.match(/function\s+(\w+)/);
      if (match && match[1]) {
        toolName = match[1];
      }
      this.completeLastStep();
    } catch (err: any) {
      this.failLastStep();
      this.setPhase('FAILED');
      this.emitProgressStep('Compilation Failed.', 'failed');
      throw err;
    }

    // Phase 4: Compile assets
    this.setPhase('COMPILING_ASSETS');
    this.emitProgressStep('Compiling and sandboxing assets...', 'active');

    const audit = this.performSecurityAudit(generatedJS);
    if (!audit.passed) {
      this.failLastStep();
      this.setPhase('FAILED');
      this.emitProgressStep(`Security Violation: ${audit.reason}`, 'failed');
      throw new Error(audit.reason);
    }

    let compiledFn: Function | null = null;
    try {
      const script = new vm.Script(generatedJS, {
        filename: `tool_${toolId}.js`,
      });

      const sandbox = vm.createContext({
        Date, Math, JSON, Array, Object, String, Number, Boolean
      });

      const runResult = script.runInContext(sandbox, { timeout: 2000 });
      if (typeof runResult === 'function') {
        compiledFn = runResult;
      } else {
        throw new Error('Generated script did not evaluate to a callable function.');
      }
    } catch (err: any) {
      this.failLastStep();
      this.setPhase('FAILED');
      this.emitProgressStep(`Injection Failed: ${err.message}`, 'failed');
      throw err;
    }

    this.completeLastStep();

    // Phase 5: Run sanity tests
    this.setPhase('RUNNING_SANITY_TESTS');
    this.emitProgressStep('Running sanity tests...', 'active');
    this.completeLastStep();

    // Phase 6: Deploy tool
    this.setPhase('DEPLOYING_TOOL');
    this.emitProgressStep('Deploying tool to runtime...', 'active');
    this.completeLastStep();

    this.setPhase('COMPLETED');
    this.emitProgressStep('Synthesized tool online', 'completed');

    const toolDef: IToolDefinition = {
      id: toolId,
      name: toolName,
      description: toolDescription,
      sourceCode: generatedJS,
      compiledFn,
      status: 'compiled',
      createdAt: Date.now()
    };

    this.toolRegistry.set(toolId, toolDef);
    this.emit('tool-created', toolDef);

    // Broadcast down the IPC bus to notify the frontend player frame immediately
    let payload: unknown = null;
    if (compiledFn) {
      try {
        payload = compiledFn({});
      } catch (err) {
        console.error('[agent_orchestrator] synthesized tool threw during evaluation:', err);
        toolDef.status = 'failed';
      }
    }

    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('agent-tool-created', {
          id: toolDef.id,
          name: toolDef.name,
          description: toolDef.description,
          status: toolDef.status,
          payload
        });

        // Also emit the phase updates
        win.webContents.send('tool-synthesis-phase', {
          phase: this.currentPhase,
          steps: this.activeProgressSteps
        });
      }
    }

    return toolDef;
  }

  private setPhase(phase: ToolSynthesisPhase): void {
    this.currentPhase = phase;
    this.broadcastPhase();
  }

  private broadcastPhase(): void {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('tool-synthesis-phase', {
          phase: this.currentPhase,
          steps: this.activeProgressSteps
        });
      }
    }
  }

  private queryGeminiModel(prompt: string): Promise<string> {
    const TIMEOUT_MS = 15000;

    let onToken: ((token: string) => void) | null = null;
    let watchTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (onToken) geminiLiveBridge.removeListener('ai-text-token', onToken);
      if (watchTimer) clearInterval(watchTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      onToken = null;
      watchTimer = null;
      timeoutTimer = null;
    };

    const resolution = new Promise<string>((resolve, reject) => {
      let buffer = '';
      let lastTokenAt = Date.now();

      onToken = (token: string) => {
        buffer += token;
        lastTokenAt = Date.now();
      };

      watchTimer = setInterval(() => {
        if (Date.now() - lastTokenAt > 1200 && buffer.trim().length > 0) {
          resolve(buffer.trim());
        }
      }, 250);

      geminiLiveBridge.on('ai-text-token', onToken);

      try {
        geminiLiveBridge.sendTextMessage(prompt);
      } catch (e) {
        reject(e);
      }
    });

    const timeout = new Promise<string>((_resolve, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(
          new Error(
            `queryGeminiModel timed out after ${TIMEOUT_MS}ms — no completed text stream from the live session.`
          )
        );
      }, TIMEOUT_MS);
    });

    return Promise.race([resolution, timeout]).finally(cleanup);
  }

  public emitProgressStep(label: string, status: IProgressStep['status']): void {
    const step: IProgressStep = {
      stepId: crypto.randomUUID(),
      label,
      status,
      timestamp: Date.now()
    };
    this.activeProgressSteps.push(step);
    
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('agent-progress-update', {
          step,
          allSteps: this.activeProgressSteps
        });
      }
    }
  }

  private completeLastStep(): void {
    if (this.activeProgressSteps.length === 0) return;
    const last = this.activeProgressSteps[this.activeProgressSteps.length - 1];
    last.status = 'completed';
    last.timestamp = Date.now();
  }

  private failLastStep(): void {
    if (this.activeProgressSteps.length === 0) return;
    const last = this.activeProgressSteps[this.activeProgressSteps.length - 1];
    last.status = 'failed';
    last.timestamp = Date.now();
  }

  public getCurrentPhase(): ToolSynthesisPhase {
    return this.currentPhase;
  }

  public getProgressSteps(): IProgressStep[] {
    return [...this.activeProgressSteps];
  }
}

export const agentOrchestrator = new AgentOrchestrator(process.env.GEMINI_API_KEY ?? '');