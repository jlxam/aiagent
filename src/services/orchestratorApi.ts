// Typed client for the AI Local Agent Orchestrator API.
import { BACKEND_URL } from '../config';

export type AppStatus = 'STOPPED' | 'RUNNING' | 'ERROR';
export type ModelType = 'gemma' | 'llama' | 'deepseek';
export type ServiceKind = 'backend' | 'frontend';

/** A registered target application (mirrors ai_orchestrator.applications). */
export interface OrchestratorApp {
  id: number;
  name: string;
  model_type: ModelType;
  backend_path: string;
  frontend_path: string;
  backend_port: number;
  frontend_port: number;
  backend_status: AppStatus;
  frontend_status: AppStatus;
  created_at?: string;
}

export interface ToggleResult {
  message?: string;
  status?: AppStatus;
  error?: string;
}

/** GET /api/orchestrator/applications — list with reconciled live statuses. */
export async function fetchApplications(): Promise<OrchestratorApp[]> {
  const res = await fetch(`${BACKEND_URL}/api/orchestrator/applications`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Orchestrator API returned ${res.status}`);
  }
  return res.json();
}

/** POST /api/orchestrator/applications/:id/:kind/toggle — start or stop. */
export async function toggleService(id: number, kind: ServiceKind): Promise<ToggleResult> {
  const res = await fetch(`${BACKEND_URL}/api/orchestrator/applications/${id}/${kind}/toggle`, {
    method: 'POST'
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body.error || `Toggle failed with ${res.status}` };
  return body;
}
