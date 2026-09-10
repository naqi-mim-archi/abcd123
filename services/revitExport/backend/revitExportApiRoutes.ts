import { ApsRevitExportBackend } from './apsRevitExportBackend';
import { RevitExportStartRequest } from '../revitExportTypes';

export interface RevitExportApiRequest {
  method?: string;
  url?: string;
  body?: any;
  params?: Record<string, string | undefined>;
  /** Firebase uid resolved by the API auth gate; null only in anonymous dev mode. */
  userId?: string | null;
}

export interface RevitExportApiResponse {
  status(code: number): RevitExportApiResponse;
  json(body: any): void;
}

const readJobId = (request: RevitExportApiRequest): string | undefined => {
  if (request.params?.jobId) return request.params.jobId;
  const match = String(request.url || '').match(/\/api\/exports\/revit\/([^/?#]+)/);
  return match?.[1] && match[1] !== 'download' ? decodeURIComponent(match[1]) : undefined;
};

// Answers 404 rather than 403 for someone else's job — whether a given job id exists is
// itself not the caller's business. Jobs with no recorded owner predate the auth gate.
const denyForeignJob = async (
  backend: ApsRevitExportBackend,
  jobId: string,
  request: RevitExportApiRequest,
  response: RevitExportApiResponse,
): Promise<boolean> => {
  const owner = await backend.getJobOwner(jobId);
  if (owner && owner !== (request.userId ?? null)) {
    response.status(404).json({ error: `Unknown Revit export job: ${jobId}` });
    return true;
  }
  return false;
};

export const createRevitExportApiRoutes = (backend = new ApsRevitExportBackend()) => ({
  getRevitExportEngines: async (_request: RevitExportApiRequest, response: RevitExportApiResponse) => {
    try {
      const engines = await backend.listEngines();
      response.status(200).json(engines);
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  postRevitExport: async (request: RevitExportApiRequest, response: RevitExportApiResponse) => {
    try {
      const body = request.body as RevitExportStartRequest;
      if (!body?.manifest) {
        response.status(400).json({ error: 'Revit export request requires a direct manifest payload.' });
        return;
      }
      const job = await backend.startExport(body.manifest, request.userId ?? null);
      response.status(202).json(job);
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  getRevitExportStatus: async (request: RevitExportApiRequest, response: RevitExportApiResponse) => {
    try {
      const jobId = readJobId(request);
      if (!jobId) {
        response.status(400).json({ error: 'Missing Revit export jobId.' });
        return;
      }
      if (await denyForeignJob(backend, jobId, request, response)) return;
      const status = await backend.getStatus(jobId);
      response.status(200).json(status);
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  getRevitExportDownload: async (request: RevitExportApiRequest, response: RevitExportApiResponse) => {
    try {
      const jobId = readJobId(request);
      if (!jobId) {
        response.status(400).json({ error: 'Missing Revit export jobId.' });
        return;
      }
      if (await denyForeignJob(backend, jobId, request, response)) return;
      const download = await backend.getDownload(jobId);
      response.status(200).json(download);
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  },
});

export const routeRevitExportApiRequest = async (
  request: RevitExportApiRequest,
  response: RevitExportApiResponse,
  backend = new ApsRevitExportBackend(),
): Promise<boolean> => {
const routes = createRevitExportApiRoutes(backend);
  const method = String(request.method || 'GET').toUpperCase();
  const url = String(request.url || '');
  if (method === 'GET' && /\/api\/exports\/revit\/engines\/?$/.test(url)) {
    await routes.getRevitExportEngines(request, response);
    return true;
  }
  if (method === 'POST' && /\/api\/exports\/revit\/?$/.test(url)) {
    await routes.postRevitExport(request, response);
    return true;
  }
  if (method === 'GET' && /\/api\/exports\/revit\/[^/]+\/download\/?$/.test(url)) {
    await routes.getRevitExportDownload(request, response);
    return true;
  }
  if (method === 'GET' && /\/api\/exports\/revit\/[^/]+\/?$/.test(url)) {
    await routes.getRevitExportStatus(request, response);
    return true;
  }
  return false;
};
