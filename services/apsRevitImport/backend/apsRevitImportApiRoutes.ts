import { ApsRevitImportBackend } from './apsRevitImportBackend';
import { ApsRevitImportStartRequest } from '../apsRevitImportTypes';

export interface ApsRevitImportApiRequest {
  method?: string;
  url?: string;
  body?: any;
  params?: Record<string, string | undefined>;
  /** Firebase uid resolved by the API auth gate; null only in anonymous dev mode. */
  userId?: string | null;
}

export interface ApsRevitImportApiResponse {
  status(code: number): ApsRevitImportApiResponse;
  json(body: any): void;
}

const readJobId = (request: ApsRevitImportApiRequest): string | undefined => {
  if (request.params?.jobId) return request.params.jobId;
  const match = String(request.url || '').match(/\/api\/imports\/aps-revit\/([^/?#]+)/);
  return match?.[1] && match[1] !== 'engines' ? decodeURIComponent(match[1]) : undefined;
};

// Answers 404 rather than 403 for someone else's job — whether a given job id exists is
// itself not the caller's business. Jobs with no recorded owner predate the auth gate.
const denyForeignJob = async (
  backend: ApsRevitImportBackend,
  jobId: string,
  request: ApsRevitImportApiRequest,
  response: ApsRevitImportApiResponse,
): Promise<boolean> => {
  const owner = await backend.getJobOwner(jobId);
  if (owner && owner !== (request.userId ?? null)) {
    response.status(404).json({ error: `Unknown APS Revit import job: ${jobId}` });
    return true;
  }
  return false;
};

export const createApsRevitImportApiRoutes = (backend = new ApsRevitImportBackend()) => ({
  getEngines: async (_request: ApsRevitImportApiRequest, response: ApsRevitImportApiResponse) => {
    try {
      const engines = await backend.listEngines();
      response.status(200).json(engines);
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  postImport: async (request: ApsRevitImportApiRequest, response: ApsRevitImportApiResponse) => {
    try {
      const body = request.body as ApsRevitImportStartRequest;
      const job = await backend.startImport(body, request.userId ?? null);
      response.status(202).json(job);
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  getStatus: async (request: ApsRevitImportApiRequest, response: ApsRevitImportApiResponse) => {
    try {
      const jobId = readJobId(request);
      if (!jobId) {
        response.status(400).json({ error: 'Missing APS Revit import jobId.' });
        return;
      }
      if (await denyForeignJob(backend, jobId, request, response)) return;
      const status = await backend.getStatus(jobId);
      response.status(200).json(status);
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  getResult: async (request: ApsRevitImportApiRequest, response: ApsRevitImportApiResponse) => {
    try {
      const jobId = readJobId(request);
      if (!jobId) {
        response.status(400).json({ error: 'Missing APS Revit import jobId.' });
        return;
      }
      if (await denyForeignJob(backend, jobId, request, response)) return;
      const result = await backend.getResult(jobId);
      response.status(200).json(result);
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  },
});

export const routeApsRevitImportApiRequest = async (
  request: ApsRevitImportApiRequest,
  response: ApsRevitImportApiResponse,
  backend = new ApsRevitImportBackend(),
): Promise<boolean> => {
  const routes = createApsRevitImportApiRoutes(backend);
  const method = String(request.method || 'GET').toUpperCase();
  const url = String(request.url || '');
  if (method === 'GET' && /\/api\/imports\/aps-revit\/engines\/?$/.test(url)) {
    await routes.getEngines(request, response);
    return true;
  }
  if (method === 'POST' && /\/api\/imports\/aps-revit\/?$/.test(url)) {
    await routes.postImport(request, response);
    return true;
  }
  if (method === 'GET' && /\/api\/imports\/aps-revit\/[^/]+\/result\/?$/.test(url)) {
    await routes.getResult(request, response);
    return true;
  }
  if (method === 'GET' && /\/api\/imports\/aps-revit\/[^/]+\/?$/.test(url)) {
    await routes.getStatus(request, response);
    return true;
  }
  return false;
};
