export interface ThreadExchange {
  role: 'user' | 'assistant';
  content: string;
}

export interface PendingMessage {
  id: string;
  question: string;
  context: unknown;
  thread: ThreadExchange[];
  user: { level: string | null; goal: string | null };
  leaseId: string;
  leaseUntil: string;
  type?: 'chat' | 'report';
  report?: ReportJob;
}

export interface ReportPlace { name: string; lat: number; lon: number }
export interface ReportJob {
  dueAt: string;
  timezone: string;
  places: ReportPlace[];
  instructions: string;
  kind: 'once' | 'recurring';
  complexity?: 'simple' | 'complex';
}

export interface ReplyImage {
  src: string;
  alt: string;
}

export interface ReplyRequest {
  id: string;
  leaseId: string;
  text: string;
  model: string;
  toolsUsed: string[];
  images?: ReplyImage[];
  briefing?: LaptopBriefing;
  usage?: { promptTokens?: number; completionTokens?: number; latencyMs?: number };
}

export interface AgentApi {
  heartbeat(runtime: string, version: string): Promise<void>;
  health(): Promise<unknown>;
  pending(): Promise<PendingMessage | null>;
  reply(request: ReplyRequest): Promise<void>;
  release(id: string, leaseId: string): Promise<void>;
  reportClaim?(): Promise<PendingMessage | null>;
  reportReady?(request: ReplyRequest): Promise<void>;
  reportRelease?(id: string, leaseId: string): Promise<void>;
  reportMaintenance?(): Promise<MaintenanceTask | null>;
  reportNotified?(id: string, leaseId: string, channel: 'text-ian' | 'email'): Promise<void>;
}

export interface MaintenanceTask { id: string; leaseId: string; message: string }

export interface RunnerInput {
  question: string;
  context: unknown;
  thread: ThreadExchange[];
  user: PendingMessage['user'];
  report?: ReportJob;
}

export interface RunnerResult {
  text: string;
  model: string;
  toolsUsed: string[];
  images?: ReplyImage[];
  /** Compact evidence passed back to the fast lane for later turns. */
  briefing?: LaptopBriefing;
  usage?: { promptTokens?: number; completionTokens?: number; latencyMs?: number };
}

export interface LaptopBriefing {
  keyNumbers: string[];
  sources: string[];
}

export type Runner = (input: RunnerInput, signal: AbortSignal) => Promise<RunnerResult>;
