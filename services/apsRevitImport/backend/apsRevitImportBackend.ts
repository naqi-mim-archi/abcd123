import {
  ApsRevitExtractionManifest,
  ApsRevitImportJobResponse,
  ApsRevitImportJobStatus,
  ApsRevitImportOptions,
  ApsRevitImportStartRequest,
  APS_REVIT_IMPORT_VERSION,
} from '../apsRevitImportTypes';
import { convertApsRevitExtractionToNative, getDefaultApsRevitImportOptions } from '../apsRevitImportConverter';

export interface ApsRevitImportConfig {
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

export interface ApsRevitImportJobRecord extends ApsRevitImportJobResponse {
  /**
   * Firebase uid of the caller who started the import. Job ids are unguessable, but that
   * is not access control — the routes reject a mismatch. Null for jobs started while
   * ALLOW_ANONYMOUS_API was on (local dev), which stay open.
   */
  ownerId?: string | null;
  createdAt: string;
  updatedAt: string;
  sourceFileName: string;
  options: ApsRevitImportOptions;
  inputObjectKey?: string;
  optionsObjectKey?: string;
  extractionManifestObjectKey?: string;
  extractionReportObjectKey?: string;
  importReportObjectKey?: string;
  projectObjectKey?: string;
  logObjectKey?: string;
}

export interface ApsRevitImportJobStore {
  create(record: ApsRevitImportJobRecord): Promise<void>;
  update(jobId: string, patch: Partial<ApsRevitImportJobRecord>): Promise<ApsRevitImportJobRecord>;
  get(jobId: string): Promise<ApsRevitImportJobRecord | null>;
}

interface ApsToken {
  access_token: string;
  expires_in: number;
  token_type: string;
}

const APS_AUTH_URL = 'https://developer.api.autodesk.com/authentication/v2/token';
const APS_DATA_BASE_URL = 'https://developer.api.autodesk.com';

export class InMemoryApsRevitImportJobStore implements ApsRevitImportJobStore {
  private readonly records = new Map<string, ApsRevitImportJobRecord>();

  async create(record: ApsRevitImportJobRecord): Promise<void> {
    this.records.set(record.jobId, record);
  }

  async update(jobId: string, patch: Partial<ApsRevitImportJobRecord>): Promise<ApsRevitImportJobRecord> {
    const existing = this.records.get(jobId);
    if (!existing) throw new Error(`Unknown APS Revit import job: ${jobId}`);
    const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.records.set(jobId, next);
    return next;
  }

  async get(jobId: string): Promise<ApsRevitImportJobRecord | null> {
    return this.records.get(jobId) || null;
  }
}

export const getApsRevitImportConfigFromEnv = (
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): ApsRevitImportConfig | null => {
  const config: ApsRevitImportConfig = {
    clientId: env.APS_CLIENT_ID || '',
    clientSecret: env.APS_CLIENT_SECRET || '',
    bucketKey: env.APS_BUCKET_KEY || '',
    region: env.APS_REGION || '',
    revitEngine: env.APS_REVIT_IMPORT_ENGINE || env.APS_REVIT_ENGINE || '',
    appBundleId: env.APS_REVIT_IMPORT_APPBUNDLE_ID || '',
    activityId: env.APS_REVIT_IMPORT_ACTIVITY_ID || '',
    activityAlias: env.APS_REVIT_IMPORT_ACTIVITY_ALIAS || 'dev',
    callbackUrl: env.APS_REVIT_IMPORT_CALLBACK_URL,
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

const requireConfig = (config?: ApsRevitImportConfig | null): ApsRevitImportConfig => {
  if (config) return config;
  throw new Error('APS Revit Importer is not configured. Set APS_CLIENT_ID, APS_CLIENT_SECRET, APS_BUCKET_KEY, APS_REGION, APS_REVIT_ENGINE, APS_REVIT_IMPORT_APPBUNDLE_ID, APS_REVIT_IMPORT_ACTIVITY_ID, and APS_REVIT_IMPORT_ACTIVITY_ALIAS on the server.');
};

const engineYear = (engine?: string): number => Number(String(engine || '').match(/Autodesk\.Revit\+(\d+)/)?.[1] || 0);

const engineEnvSuffix = (engine?: string): string => {
  const year = engineYear(engine);
  return year ? `_${year}` : '';
};

const configForEngine = (baseConfig: ApsRevitImportConfig, requestedEngine?: string): ApsRevitImportConfig => {
  if (!requestedEngine || requestedEngine === baseConfig.revitEngine) return baseConfig;
  const suffix = engineEnvSuffix(requestedEngine);
  const env = baseConfig.env || {};
  const engineConfig: ApsRevitImportConfig = {
    ...baseConfig,
    revitEngine: requestedEngine,
    appBundleId: env[`APS_REVIT_IMPORT_APPBUNDLE_ID${suffix}`] || '',
    activityId: env[`APS_REVIT_IMPORT_ACTIVITY_ID${suffix}`] || '',
    activityAlias: env[`APS_REVIT_IMPORT_ACTIVITY_ALIAS${suffix}`] || baseConfig.activityAlias,
  };
  if (engineConfig.appBundleId && engineConfig.activityId && engineConfig.activityAlias) return engineConfig;
  throw new Error(`Revit engine ${requestedEngine} is available in APS, but APS Revit Importer does not have a matching AppBundle/Activity configured yet.`);
};

const designAutomationRegion = (region: string): string => {
  const normalized = region.trim().toLowerCase();
  if (normalized === 'us' || normalized === 'usa' || normalized === 'us-east') return 'us-east';
  if (normalized === 'emea' || normalized === 'eu' || normalized === 'europe') return 'eu';
  return normalized || 'us-east';
};

const designAutomationBaseUrl = (region: string): string => `https://developer.api.autodesk.com/da/${designAutomationRegion(region)}/v3`;

const activityFullId = (config: ApsRevitImportConfig): string =>
  config.activityId.includes('+') ? config.activityId : `${config.activityId}+${config.activityAlias}`;

const makeJobId = (): string => `aps_revit_import_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const cleanFileName = (name: string, fallback = 'revit-import'): string => (name || fallback)
  .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '_')
  .replace(/\s+/g, '_')
  .replace(/_+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 96) || fallback;

const objectKey = (jobId: string, suffix: string): string => `${jobId}/${suffix}`;

const requestJson = async <T,>(url: string, init: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`APS request failed ${response.status} ${response.statusText}: ${text.slice(0, 1000)}`);
  }
  return text ? JSON.parse(text) as T : {} as T;
};

const createToken = async (config: ApsRevitImportConfig): Promise<ApsToken> => {
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

const listRevitEngines = async (token: string, config: ApsRevitImportConfig): Promise<string[]> => {
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

const downloadJsonFromUrl = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`Failed to download APS output JSON: ${response.status} ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
};

const submitWorkItem = async (
  token: string,
  config: ApsRevitImportConfig,
  urls: { inputRvt: string; optionsJson: string; manifest: string; extractionReport: string; executionLog: string },
): Promise<{ id: string; status?: string }> => {
  const argumentsPayload: Record<string, any> = {
    inputRvt: { url: urls.inputRvt, verb: 'get' },
    optionsJson: { url: urls.optionsJson, verb: 'get' },
    extractionManifest: { url: urls.manifest, verb: 'put' },
    extractionReport: { url: urls.extractionReport, verb: 'put' },
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

const getWorkItem = async (token: string, config: ApsRevitImportConfig, workItemId: string): Promise<any> => (
  apsJson<any>(token, `${designAutomationBaseUrl(config.region)}/workitems/${encodeURIComponent(workItemId)}`, { method: 'GET' })
);

const mapWorkItemStatus = (status?: string): ApsRevitImportJobStatus => {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'success') return 'converting_to_canvas';
  if (['failed', 'failedinstructions', 'faileddownload', 'failedupload', 'cancelled', 'timeout'].includes(normalized)) return 'failed';
  if (normalized === 'pending') return 'queued';
  if (normalized === 'inprogress' || normalized === 'in_progress') return 'extracting_revit_data';
  return 'extracting_revit_data';
};

const decodeBase64 = (value: string): Uint8Array => {
  const clean = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  return new Uint8Array(Buffer.from(clean, 'base64'));
};

const validateStartRequest = (request: ApsRevitImportStartRequest) => {
  if (!request?.fileName?.toLowerCase().endsWith('.rvt')) throw new Error('APS Revit Importer requires a .rvt source file.');
  if (!request.fileBase64) throw new Error('APS Revit Importer request is missing fileBase64.');
};

export class ApsRevitImportBackend {
  constructor(
    private readonly config: ApsRevitImportConfig | null = getApsRevitImportConfigFromEnv(),
    private readonly store: ApsRevitImportJobStore = new InMemoryApsRevitImportJobStore(),
  ) {}

  async startImport(request: ApsRevitImportStartRequest, ownerId: string | null = null): Promise<ApsRevitImportJobResponse> {
    validateStartRequest(request);
    const baseConfig = requireConfig(this.config);
    const options = { ...getDefaultApsRevitImportOptions(), ...(request.options || {}) };
    const config = configForEngine(baseConfig, options.revitEngine || baseConfig.revitEngine);
    const jobId = makeJobId();
    const now = new Date().toISOString();
    const safeName = cleanFileName(request.fileName, 'source.rvt');
    const record: ApsRevitImportJobRecord = {
      jobId,
      ownerId,
      status: 'queued',
      progressMessage: 'Preparing APS Revit Importer job...',
      warnings: [],
      errors: [],
      project: null,
      report: null,
      manifest: null,
      createdAt: now,
      updatedAt: now,
      sourceFileName: request.fileName,
      options,
      inputObjectKey: objectKey(jobId, `input/${safeName}`),
      optionsObjectKey: objectKey(jobId, 'input/aps-revit-import-options.json'),
      extractionManifestObjectKey: objectKey(jobId, 'output/RevitExtractionManifest.json'),
      extractionReportObjectKey: objectKey(jobId, 'output/RevitExtractionReport.json'),
      importReportObjectKey: objectKey(jobId, 'output/APSRevitImport_Report.json'),
      projectObjectKey: objectKey(jobId, 'output/APSRevitImport_Project.json'),
      logObjectKey: objectKey(jobId, 'output/APSRevitImport_Execution.log'),
    };
    await this.store.create(record);

    try {
      await this.store.update(jobId, { status: 'uploading', progressMessage: 'Uploading RVT to APS OSS...' });
      const token = await createToken(config);
      await ensureBucket(token.access_token, config.bucketKey, config.region);
      await uploadObject(token.access_token, config.bucketKey, record.inputObjectKey!, decodeBase64(request.fileBase64), 'application/octet-stream');
      await uploadObject(token.access_token, config.bucketKey, record.optionsObjectKey!, JSON.stringify({
        ...options,
        manifestVersion: APS_REVIT_IMPORT_VERSION,
        sourceFileName: request.fileName,
      }, null, 2), 'application/json');
      await uploadObject(token.access_token, config.bucketKey, record.extractionManifestObjectKey!, new Uint8Array(), 'application/json');
      await uploadObject(token.access_token, config.bucketKey, record.extractionReportObjectKey!, new Uint8Array(), 'application/json');
      await uploadObject(token.access_token, config.bucketKey, record.importReportObjectKey!, new Uint8Array(), 'application/json');
      await uploadObject(token.access_token, config.bucketKey, record.projectObjectKey!, new Uint8Array(), 'application/json');
      await uploadObject(token.access_token, config.bucketKey, record.logObjectKey!, new Uint8Array(), 'text/plain');

      const urls = {
        inputRvt: await createAutomationSignedUrl(token.access_token, config.bucketKey, record.inputObjectKey!, 'read'),
        optionsJson: await createAutomationSignedUrl(token.access_token, config.bucketKey, record.optionsObjectKey!, 'read'),
        manifest: await createAutomationSignedUrl(token.access_token, config.bucketKey, record.extractionManifestObjectKey!, 'write'),
        extractionReport: await createAutomationSignedUrl(token.access_token, config.bucketKey, record.extractionReportObjectKey!, 'write'),
        executionLog: await createAutomationSignedUrl(token.access_token, config.bucketKey, record.logObjectKey!, 'write'),
      };
      await this.store.update(jobId, { status: 'extracting_revit_data', progressMessage: 'Extracting Revit DB data through APS Revit Automation...' });
      const workItem = await submitWorkItem(token.access_token, config, urls);
      const updated = await this.store.update(jobId, {
        workItemId: workItem.id,
        status: mapWorkItemStatus(workItem.status),
        progressMessage: 'Extracting Revit DB data through APS Revit Automation...',
      });
      return this.toResponse(updated);
    } catch (error) {
      const updated = await this.store.update(jobId, {
        status: 'failed',
        progressMessage: 'APS Revit Importer failed before Automation completed.',
        errors: [error instanceof Error ? error.message : String(error)],
      });
      return this.toResponse(updated);
    }
  }

  async listEngines(): Promise<{ engines: ApsRevitImportEngineInfo[] }> {
    const config = requireConfig(this.config);
    const token = await createToken(config);
    const engines = await listRevitEngines(token.access_token, config);
    const env = config.env || {};
    const rows = engines
      .map(engine => {
        const suffix = engineEnvSuffix(engine);
        const configured = engine === config.revitEngine || Boolean(env[`APS_REVIT_IMPORT_ACTIVITY_ID${suffix}`]);
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

  async getStatus(jobId: string): Promise<ApsRevitImportJobResponse> {
    const record = await this.store.get(jobId);
    if (!record) throw new Error(`Unknown APS Revit import job: ${jobId}`);
    if (!record.workItemId || ['completed', 'completed_with_warnings', 'failed'].includes(record.status)) {
      return this.toResponse(record);
    }

    const baseConfig = requireConfig(this.config);
    const config = configForEngine(baseConfig, record.options.revitEngine || baseConfig.revitEngine);
    const token = await createToken(config);
    const workItem = await getWorkItem(token.access_token, config, record.workItemId);
    const nextStatus = mapWorkItemStatus(workItem.status);
    if (nextStatus === 'converting_to_canvas') {
      return this.finalizeSuccessfulWorkItem(record, token.access_token, config);
    }
    if (nextStatus === 'failed') {
      const updated = await this.store.update(jobId, {
        status: 'failed',
        progressMessage: 'APS Revit Automation extraction failed.',
        errors: [...(record.errors || []), workItem.statusDetails || workItem.error || 'APS WorkItem failed.'],
      });
      return this.toResponse(updated);
    }
    const updated = await this.store.update(jobId, {
      status: nextStatus,
      progressMessage: nextStatus === 'queued' ? 'Queued in APS Revit Automation...' : 'Extracting Revit DB data...',
    });
    return this.toResponse(updated);
  }

  async getResult(jobId: string): Promise<ApsRevitImportJobResponse> {
    const status = await this.getStatus(jobId);
    if (!['completed', 'completed_with_warnings'].includes(status.status)) {
      throw new Error(`APS Revit import job ${jobId} is not ready.`);
    }
    return status;
  }

  private async finalizeSuccessfulWorkItem(
    record: ApsRevitImportJobRecord,
    token: string,
    config: ApsRevitImportConfig,
  ): Promise<ApsRevitImportJobResponse> {
    await this.store.update(record.jobId, { status: 'converting_to_canvas', progressMessage: 'Converting Revit extraction manifest to native canvas project...' });
    const manifestUrl = await createSignedDownloadUrl(token, config.bucketKey, record.extractionManifestObjectKey!);
    const manifest = await downloadJsonFromUrl<ApsRevitExtractionManifest>(manifestUrl);
    const conversion = convertApsRevitExtractionToNative(manifest, record.sourceFileName, record.options);
    const warnings = [...new Set([...(record.warnings || []), ...conversion.report.warnings])];
    const errors = [...(record.errors || []), ...conversion.report.errors];

    await this.store.update(record.jobId, { status: 'validating', progressMessage: 'Validating imported native project...' });
    await uploadObject(token, config.bucketKey, record.projectObjectKey!, JSON.stringify(conversion.project, null, 2), 'application/json');
    await uploadObject(token, config.bucketKey, record.importReportObjectKey!, JSON.stringify(conversion.report, null, 2), 'application/json');

    const projectJsonUrl = await createSignedDownloadUrl(token, config.bucketKey, record.projectObjectKey!);
    const reportUrl = await createSignedDownloadUrl(token, config.bucketKey, record.importReportObjectKey!);
    const executionLogUrl = await createSignedDownloadUrl(token, config.bucketKey, record.logObjectKey!).catch(() => null);
    const status: ApsRevitImportJobStatus = errors.length
      ? 'failed'
      : warnings.length || conversion.report.fallbackElementCount || conversion.report.skippedElementCount
        ? 'completed_with_warnings'
        : 'completed';
    const updated = await this.store.update(record.jobId, {
      status,
      progressMessage: status === 'failed' ? 'APS Revit import failed validation.' : 'APS Revit import completed.',
      warnings,
      errors,
      project: conversion.project,
      report: conversion.report,
      manifest,
      manifestUrl,
      projectJsonUrl,
      reportUrl,
      executionLogUrl,
      manifestObjectKey: record.extractionManifestObjectKey,
      reportObjectKey: record.importReportObjectKey,
      projectObjectKey: record.projectObjectKey,
      logObjectKey: record.logObjectKey,
    });
    return this.toResponse(updated);
  }

  private toResponse(record: ApsRevitImportJobRecord): ApsRevitImportJobResponse {
    return {
      jobId: record.jobId,
      status: record.status,
      progressMessage: record.progressMessage,
      warnings: record.warnings,
      errors: record.errors,
      project: record.project,
      report: record.report,
      manifest: record.manifest,
      workItemId: record.workItemId,
      manifestUrl: record.manifestUrl,
      projectJsonUrl: record.projectJsonUrl,
      reportUrl: record.reportUrl,
      executionLogUrl: record.executionLogUrl,
      inputObjectKey: record.inputObjectKey,
      manifestObjectKey: record.manifestObjectKey || record.extractionManifestObjectKey,
      reportObjectKey: record.reportObjectKey || record.importReportObjectKey,
      projectObjectKey: record.projectObjectKey,
      logObjectKey: record.logObjectKey,
    };
  }
}

interface ApsRevitImportEngineInfo {
  engine: string;
  year: number;
  configured: boolean;
  isDefault: boolean;
}
