import {
  REVIT_EXPORT_VERSION,
  RevitExportJobResponse,
  RevitExportJobStatus,
  RevitExportManifest,
  RevitExportEngineInfo,
} from '../revitExportTypes';
import { validateRevitExportManifest } from '../revitExportManifest';

export interface ApsRevitExportConfig {
  clientId: string;
  clientSecret: string;
  bucketKey: string;
  region: string;
  revitEngine: string;
  appBundleId: string;
  activityId: string;
  activityAlias: string;
  callbackUrl?: string;
  env?: Record<string, string | undefined>;
}

export interface RevitExportJobRecord extends RevitExportJobResponse {
  /**
   * Firebase uid of the caller who started the export. Job ids are unguessable, but that
   * is not access control — the routes reject a mismatch. Null for jobs started while
   * ALLOW_ANONYMOUS_API was on (local dev), which stay open.
   */
  ownerId?: string | null;
  createdAt: string;
  updatedAt: string;
  manifest?: RevitExportManifest;
  manifestObjectKey?: string;
  rvtObjectKey?: string;
  reportObjectKey?: string;
  logObjectKey?: string;
}

export interface RevitExportJobStore {
  create(record: RevitExportJobRecord): Promise<void>;
  update(jobId: string, patch: Partial<RevitExportJobRecord>): Promise<RevitExportJobRecord>;
  get(jobId: string): Promise<RevitExportJobRecord | null>;
}

interface ApsToken {
  access_token: string;
  expires_in: number;
  token_type: string;
}

const APS_AUTH_URL = 'https://developer.api.autodesk.com/authentication/v2/token';
const APS_DATA_BASE_URL = 'https://developer.api.autodesk.com';

export class InMemoryRevitExportJobStore implements RevitExportJobStore {
  private readonly records = new Map<string, RevitExportJobRecord>();

  async create(record: RevitExportJobRecord): Promise<void> {
    this.records.set(record.jobId, record);
  }

  async update(jobId: string, patch: Partial<RevitExportJobRecord>): Promise<RevitExportJobRecord> {
    const existing = this.records.get(jobId);
    if (!existing) throw new Error(`Unknown Revit export job: ${jobId}`);
    const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.records.set(jobId, next);
    return next;
  }

  async get(jobId: string): Promise<RevitExportJobRecord | null> {
    return this.records.get(jobId) || null;
  }
}

export const getApsRevitExportConfigFromEnv = (env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {}): ApsRevitExportConfig | null => {
  const config: ApsRevitExportConfig = {
    clientId: env.APS_CLIENT_ID || '',
    clientSecret: env.APS_CLIENT_SECRET || '',
    bucketKey: env.APS_BUCKET_KEY || '',
    region: env.APS_REGION || '',
    revitEngine: env.APS_REVIT_ENGINE || '',
    appBundleId: env.APS_REVIT_APPBUNDLE_ID || '',
    activityId: env.APS_REVIT_ACTIVITY_ID || '',
    activityAlias: env.APS_REVIT_ACTIVITY_ALIAS || '',
    callbackUrl: env.APS_REVIT_EXPORT_CALLBACK_URL,
    env,
  };
  return Object.values({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    bucketKey: config.bucketKey,
    region: config.region,
    revitEngine: config.revitEngine,
    appBundleId: config.appBundleId,
    activityId: config.activityId,
    activityAlias: config.activityAlias,
  }).every(Boolean) ? config : null;
};

const requireConfig = (config?: ApsRevitExportConfig | null): ApsRevitExportConfig => {
  if (config) return config;
  throw new Error('APS Revit export backend is not configured. Set APS_CLIENT_ID, APS_CLIENT_SECRET, APS_BUCKET_KEY, APS_REGION, APS_REVIT_ENGINE, APS_REVIT_APPBUNDLE_ID, APS_REVIT_ACTIVITY_ID, and APS_REVIT_ACTIVITY_ALIAS on the server.');
};

const engineYear = (engine?: string): number => Number(String(engine || '').match(/Autodesk\.Revit\+(\d+)/)?.[1] || 0);

const engineEnvSuffix = (engine?: string): string => {
  const year = engineYear(engine);
  return year ? `_${year}` : '';
};

const configForEngine = (baseConfig: ApsRevitExportConfig, requestedEngine?: string): ApsRevitExportConfig => {
  if (!requestedEngine || requestedEngine === baseConfig.revitEngine) return baseConfig;
  const suffix = engineEnvSuffix(requestedEngine);
  const env = baseConfig.env || {};
  const engineConfig: ApsRevitExportConfig = {
    ...baseConfig,
    revitEngine: requestedEngine,
    appBundleId: env[`APS_REVIT_APPBUNDLE_ID${suffix}`] || '',
    activityId: env[`APS_REVIT_ACTIVITY_ID${suffix}`] || '',
    activityAlias: env[`APS_REVIT_ACTIVITY_ALIAS${suffix}`] || baseConfig.activityAlias,
  };
  if (engineConfig.appBundleId && engineConfig.activityId && engineConfig.activityAlias) return engineConfig;
  throw new Error(`Revit engine ${requestedEngine} is available in APS, but this server does not have an AppBundle/Activity configured for it yet. Run the APS Revit export setup for Revit ${engineYear(requestedEngine)} or choose a configured version.`);
};

const designAutomationRegion = (region: string): string => {
  const normalized = region.trim().toLowerCase();
  if (normalized === 'us' || normalized === 'usa' || normalized === 'us-east') return 'us-east';
  if (normalized === 'emea' || normalized === 'eu' || normalized === 'europe') return 'eu';
  return normalized || 'us-east';
};

const designAutomationBaseUrl = (region: string): string => `https://developer.api.autodesk.com/da/${designAutomationRegion(region)}/v3`;

const activityFullId = (config: ApsRevitExportConfig): string =>
  config.activityId.includes('+') ? config.activityId : `${config.activityId}+${config.activityAlias}`;

const makeJobId = (): string => `revit_export_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const objectKey = (jobId: string, suffix: string): string => `${jobId}/${suffix}`;

const requestJson = async <T,>(url: string, init: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`APS request failed ${response.status} ${response.statusText}: ${text.slice(0, 1000)}`);
  }
  return text ? JSON.parse(text) as T : {} as T;
};

const createToken = async (config: ApsRevitExportConfig): Promise<ApsToken> => {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: 'data:read data:write data:create bucket:read bucket:create code:all',
  });
  return requestJson<ApsToken>(APS_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
};

const apsJson = async <T,>(token: string, url: string, init: RequestInit = {}): Promise<T> => (
  requestJson<T>(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
);

const listRevitEngines = async (token: string, config: ApsRevitExportConfig): Promise<string[]> => {
  const payload = await apsJson<any>(token, `${designAutomationBaseUrl(config.region)}/engines`, { method: 'GET' });
  const engines = Array.isArray(payload) ? payload : (payload.data || payload.value || []);
  return engines.filter((engine: unknown) => String(engine).startsWith('Autodesk.Revit+'));
};

const ensureBucket = async (token: string, bucketKey: string, region: string): Promise<void> => {
  const detailsUrl = `${APS_DATA_BASE_URL}/oss/v2/buckets/${encodeURIComponent(bucketKey)}/details`;
  const details = await fetch(detailsUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (details.ok) return;
  if (details.status !== 404) {
    const text = await details.text();
    throw new Error(`Failed to inspect APS bucket ${bucketKey}: ${details.status} ${text}`);
  }
  await apsJson(token, `${APS_DATA_BASE_URL}/oss/v2/buckets`, {
    method: 'POST',
    body: JSON.stringify({
      bucketKey,
      policyKey: 'transient',
      region: region.toUpperCase().includes('EMEA') ? 'EMEA' : 'US',
    }),
  });
};

const createSignedS3UploadUrl = async (token: string, bucketKey: string, key: string): Promise<{ uploadUrl: string; uploadKey: string }> => {
  const url = `${APS_DATA_BASE_URL}/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(key)}/signeds3upload?parts=1&minutesExpiration=60`;
  const response = await apsJson<any>(token, url, { method: 'GET' });
  const uploadUrl = response.urls?.[0] || response.uploadUrl || response.url;
  if (!uploadUrl || !response.uploadKey) throw new Error(`APS signed upload response did not include upload URL/uploadKey for ${key}.`);
  return { uploadUrl, uploadKey: response.uploadKey };
};

const completeSignedS3Upload = async (token: string, bucketKey: string, key: string, uploadKey: string): Promise<void> => {
  const url = `${APS_DATA_BASE_URL}/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(key)}/signeds3upload`;
  await apsJson(token, url, {
    method: 'POST',
    body: JSON.stringify({ uploadKey }),
  });
};

const uploadObject = async (token: string, bucketKey: string, key: string, contents: string | Uint8Array, contentType: string): Promise<void> => {
  const { uploadUrl, uploadKey } = await createSignedS3UploadUrl(token, bucketKey, key);
  const upload = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: typeof contents === 'string' ? new TextEncoder().encode(contents) : contents,
  });
  if (!upload.ok) {
    const text = await upload.text();
    throw new Error(`Failed to upload ${key} to signed S3 URL: ${upload.status} ${text}`);
  }
  await completeSignedS3Upload(token, bucketKey, key, uploadKey);
};

const createSignedDownloadUrl = async (token: string, bucketKey: string, key: string, minutesExpiration = 60): Promise<string> => {
  const url = `${APS_DATA_BASE_URL}/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(key)}/signeds3download?minutesExpiration=${minutesExpiration}`;
  const response = await apsJson<any>(token, url, { method: 'GET' });
  const signedUrl = response.url || response.signedUrl;
  if (!signedUrl) throw new Error(`APS signed download response did not include a URL for ${key}.`);
  return signedUrl;
};

const createAutomationSignedUrl = async (token: string, bucketKey: string, key: string, access: 'read' | 'write' | 'readwrite'): Promise<string> => {
  const signedAccess = access === 'write' ? 'readwrite' : access;
  const url = `${APS_DATA_BASE_URL}/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(key)}/signed?access=${encodeURIComponent(signedAccess)}`;
  const response = await apsJson<any>(token, url, {
    method: 'POST',
    body: JSON.stringify({
      minutesExpiration: 60,
      singleUse: false,
    }),
  });
  const signedUrl = response.signedUrl || response.url;
  if (!signedUrl) throw new Error(`APS signed URL response did not include a URL for ${key}.`);
  return signedUrl;
};

const submitWorkItem = async (
  token: string,
  config: ApsRevitExportConfig,
  urls: { manifest: string; outputRvt: string; report: string; executionLog: string },
): Promise<{ id: string; status?: string }> => {
  const argumentsPayload: Record<string, any> = {
    manifest: { url: urls.manifest, verb: 'get' },
    resultRvt: { url: urls.outputRvt, verb: 'put' },
    reportJson: { url: urls.report, verb: 'put' },
    executionLog: { url: urls.executionLog, verb: 'put' },
  };
  if (config.callbackUrl) {
    argumentsPayload.onComplete = { url: config.callbackUrl, verb: 'post' };
  }
  return apsJson<{ id: string; status?: string }>(token, `${designAutomationBaseUrl(config.region)}/workitems`, {
    method: 'POST',
    body: JSON.stringify({
      activityId: activityFullId(config),
      arguments: argumentsPayload,
    }),
  });
};

const getWorkItem = async (token: string, config: ApsRevitExportConfig, workItemId: string): Promise<any> => (
  apsJson<any>(token, `${designAutomationBaseUrl(config.region)}/workitems/${encodeURIComponent(workItemId)}`, { method: 'GET' })
);

const mapWorkItemStatus = (status?: string): RevitExportJobStatus => {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'success') return 'validating';
  if (normalized === 'failed' || normalized === 'cancelled' || normalized === 'timeout') return 'failed';
  if (normalized === 'pending') return 'queued';
  if (normalized === 'inprogress' || normalized === 'in_progress') return 'processing';
  return 'processing';
};

export class ApsRevitExportBackend {
  constructor(
    private readonly config: ApsRevitExportConfig | null = getApsRevitExportConfigFromEnv(),
    private readonly store: RevitExportJobStore = new InMemoryRevitExportJobStore(),
  ) {}

  async startExport(manifest: RevitExportManifest, ownerId: string | null = null): Promise<RevitExportJobResponse> {
    const baseConfig = requireConfig(this.config);
    const requestedEngine = manifest.settings.revitEngine;
    const config = configForEngine(baseConfig, requestedEngine);
    const validation = validateRevitExportManifest(manifest);
    if (!validation.isValid) {
      throw new Error(`Invalid Revit export manifest: ${validation.errors.join('; ')}`);
    }

    const jobId = makeJobId();
    const now = new Date().toISOString();
    const record: RevitExportJobRecord = {
      jobId,
      ownerId,
      status: 'queued',
      progressMessage: 'Preparing Revit export...',
      warnings: validation.warnings,
      errors: [],
      downloadUrl: null,
      reportUrl: null,
      createdAt: now,
      updatedAt: now,
      manifest,
      manifestObjectKey: objectKey(jobId, 'input/revit-export-manifest.json'),
      rvtObjectKey: objectKey(jobId, 'output/project.rvt'),
      reportObjectKey: objectKey(jobId, 'output/revit-export-report.json'),
      logObjectKey: objectKey(jobId, 'output/revit-export-execution.log'),
    };
    await this.store.create(record);

    try {
      await this.store.update(jobId, { status: 'uploading', progressMessage: 'Uploading project data...' });
      const token = await createToken(config);
      await ensureBucket(token.access_token, config.bucketKey, config.region);
      await uploadObject(token.access_token, config.bucketKey, record.manifestObjectKey!, JSON.stringify(manifest, null, 2), 'application/json');
      await uploadObject(token.access_token, config.bucketKey, record.rvtObjectKey!, new Uint8Array(), 'application/octet-stream');
      await uploadObject(token.access_token, config.bucketKey, record.reportObjectKey!, new Uint8Array(), 'application/json');
      await uploadObject(token.access_token, config.bucketKey, record.logObjectKey!, new Uint8Array(), 'text/plain');

      const urls = {
        manifest: await createAutomationSignedUrl(token.access_token, config.bucketKey, record.manifestObjectKey!, 'read'),
        outputRvt: await createAutomationSignedUrl(token.access_token, config.bucketKey, record.rvtObjectKey!, 'write'),
        report: await createAutomationSignedUrl(token.access_token, config.bucketKey, record.reportObjectKey!, 'write'),
        executionLog: await createAutomationSignedUrl(token.access_token, config.bucketKey, record.logObjectKey!, 'write'),
      };

      await this.store.update(jobId, { status: 'processing', progressMessage: 'Creating Revit model...' });
      const workItem = await submitWorkItem(token.access_token, config, urls);
      const updated = await this.store.update(jobId, {
        workItemId: workItem.id,
        status: mapWorkItemStatus(workItem.status),
        progressMessage: 'Creating Revit model...',
      });
      return this.toResponse(updated);
    } catch (error) {
      const updated = await this.store.update(jobId, {
        status: 'failed',
        progressMessage: 'Revit export failed before Automation completed.',
        errors: [error instanceof Error ? error.message : String(error)],
      });
      return this.toResponse(updated);
    }
  }

  async listEngines(): Promise<{ engines: RevitExportEngineInfo[] }> {
    const config = requireConfig(this.config);
    const token = await createToken(config);
    const engines = await listRevitEngines(token.access_token, config);
    const env = config.env || {};
    const rows = engines
      .map(engine => {
        const suffix = engineEnvSuffix(engine);
        const configured = engine === config.revitEngine || Boolean(env[`APS_REVIT_ACTIVITY_ID${suffix}`]);
        return {
          engine,
          year: engineYear(engine),
          configured,
          isDefault: engine === config.revitEngine,
        };
      })
      .filter(row => row.year > 0)
      .sort((a, b) => b.year - a.year);
    return { engines: rows };
  }

  /** Owner of a job, `undefined` when no such job exists. Used by the routes to gate reads. */
  async getJobOwner(jobId: string): Promise<string | null | undefined> {
    const record = await this.store.get(jobId);
    return record ? record.ownerId ?? null : undefined;
  }

  async getStatus(jobId: string): Promise<RevitExportJobResponse> {
    const record = await this.store.get(jobId);
    if (!record) throw new Error(`Unknown Revit export job: ${jobId}`);
    if (!record.workItemId || ['completed', 'completed_with_warnings', 'failed'].includes(record.status)) {
      return this.toResponse(record);
    }

    const config = requireConfig(this.config);
    const token = await createToken(config);
    const workItem = await getWorkItem(token.access_token, config, record.workItemId);
    const nextStatus = mapWorkItemStatus(workItem.status);
    if (nextStatus === 'validating') {
      const downloadUrl = await createSignedDownloadUrl(token.access_token, config.bucketKey, record.rvtObjectKey!);
      const reportUrl = await createSignedDownloadUrl(token.access_token, config.bucketKey, record.reportObjectKey!);
      const warnings = [...record.warnings, ...(workItem.reportUrl ? [] : [])];
      const updated = await this.store.update(jobId, {
        status: warnings.length ? 'completed_with_warnings' : 'completed',
        progressMessage: 'Preparing download...',
        downloadUrl,
        reportUrl,
        warnings,
      });
      return this.toResponse(updated);
    }
    if (nextStatus === 'failed') {
      const updated = await this.store.update(jobId, {
        status: 'failed',
        progressMessage: 'APS Revit Automation failed.',
        errors: [...(record.errors || []), workItem.statusDetails || workItem.error || 'APS WorkItem failed.'],
      });
      return this.toResponse(updated);
    }
    const updated = await this.store.update(jobId, {
      status: nextStatus,
      progressMessage: nextStatus === 'queued' ? 'Queued in Revit Automation...' : 'Creating Revit model...',
    });
    return this.toResponse(updated);
  }

  async getDownload(jobId: string): Promise<{ downloadUrl: string; reportUrl: string | null }> {
    const status = await this.getStatus(jobId);
    if (!status.downloadUrl) throw new Error(`Revit export job ${jobId} is not ready for download.`);
    return { downloadUrl: status.downloadUrl, reportUrl: status.reportUrl };
  }

  private toResponse(record: RevitExportJobRecord): RevitExportJobResponse {
    return {
      jobId: record.jobId,
      status: record.status,
      progressMessage: record.progressMessage,
      warnings: record.warnings,
      errors: record.errors,
      downloadUrl: record.downloadUrl,
      reportUrl: record.reportUrl,
      manifestObjectKey: record.manifestObjectKey,
      rvtObjectKey: record.rvtObjectKey,
      reportObjectKey: record.reportObjectKey,
      workItemId: record.workItemId,
    };
  }
}

export const createInitialFailureReport = (manifest: RevitExportManifest, errors: string[]): string => JSON.stringify({
  exportVersion: REVIT_EXPORT_VERSION,
  status: 'failed',
  projectName: manifest.project.name,
  sourceElementCount: manifest.summary.sourceElementCount,
  revitElementCount: 0,
  nativeElementCount: 0,
  fallbackDirectShapeCount: 0,
  skippedElementCount: manifest.summary.skippedElementCount,
  levels: manifest.levels.map(level => ({ sourceLevelId: level.id, name: level.name, elevation: level.elevation })),
  classCounts: {},
  elementMappings: [],
  warnings: manifest.summary.warnings,
  errors,
  validation: {
    projectCreated: false,
    savedRvt: false,
  },
}, null, 2);
