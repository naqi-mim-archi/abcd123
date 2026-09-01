import { GoogleGenAI } from "@google/genai";
import { GoogleAuth } from "google-auth-library";
import { getVertexCredentialsPath } from '../vertexAuth';
import { WORKFLOWS, Workflow } from './workflowRegistry';
import { MODELS, WorkflowCostEstimator, ActualUsageCostCalculator } from './modelPricingRegistry';
import { IntentNormalizer, DefaultResolver, PromptCompiler } from './promptCompiler';
import { PromptEnhancerEngine } from './promptEnhancer';
import { getJob, setJob } from './jobStore';

const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
let cachedVertexAuth: GoogleAuth | undefined;
let cachedVertexClientPromise: ReturnType<GoogleAuth['getClient']> | undefined;

const configureVertexEnvironment = (keyPath: string) => {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
  process.env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
  process.env.GOOGLE_CLOUD_PROJECT = 'rendair-competitor';
  process.env.GOOGLE_CLOUD_LOCATION = 'us-central1';
};

const getVertexAuth = (): GoogleAuth | null => {
  const keyPath = getVertexCredentialsPath('GOOGLE_VERTEX_RENDER_SA_KEY_JSON');
  if (!keyPath) {
    return null;
  }
  configureVertexEnvironment(keyPath);
  if (!cachedVertexAuth) {
    cachedVertexAuth = new GoogleAuth({ keyFile: keyPath, scopes: VERTEX_SCOPE });
  }
  return cachedVertexAuth;
};

const getVertexClient = () => {
  const auth = getVertexAuth();
  if (!auth) return null;
  if (!cachedVertexClientPromise) {
    cachedVertexClientPromise = auth.getClient().catch(error => {
      cachedVertexClientPromise = undefined;
      throw error;
    });
  }
  return cachedVertexClientPromise;
};

// Image generation runs over whichever credential is configured. The render service account
// reaches the models through Vertex in the rendair-competitor project; without it we fall
// back to the same Gemini image models on the public API using GEMINI_API_KEY, which the
// Gemini proxy already relies on. When neither exists the job fails — it must never quietly
// substitute a stock photograph and report success.
export type ImageTransport =
  | { kind: 'vertex'; token: string }
  | { kind: 'api-key'; apiKey: string };

export const resolveImageTransport = async (): Promise<ImageTransport | null> => {
  const clientPromise = getVertexClient();
  if (clientPromise) {
    try {
      const token = (await (await clientPromise).getAccessToken())?.token;
      if (token) return { kind: 'vertex', token };
    } catch (error: any) {
      console.warn(`[AI-Render] Vertex render credentials failed to authenticate: ${error?.message || error}`);
    }
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) return { kind: 'api-key', apiKey };
  return null;
};

const geminiImageEndpoint = (transport: ImageTransport, model: string) =>
  transport.kind === 'vertex'
    ? `https://aiplatform.googleapis.com/v1/projects/rendair-competitor/locations/global/publishers/google/models/${model}:generateContent`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(transport.apiKey)}`;

const geminiImageHeaders = (transport: ImageTransport): Record<string, string> =>
  transport.kind === 'vertex'
    ? { Authorization: `Bearer ${transport.token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };

// Normalize provider errors
export function normalizeError(err: any): string {
  const msg = err?.message || String(err);
  if (msg.includes('MIME') || msg.includes('format')) return 'UNSUPPORTED_MIME_TYPE';
  if (msg.includes('size') || msg.includes('large')) return 'FILE_TOO_LARGE';
  if (msg.includes('401') || msg.includes('auth') || msg.includes('token')) return 'AUTHENTICATION_FAILED';
  if (msg.includes('429') || msg.includes('quota') || msg.includes('rate limit')) return 'PROVIDER_RATE_LIMIT';
  if (msg.includes('timeout') || msg.includes('deadline')) return 'GPU_COLD_START_TIMEOUT';
  if (msg.includes('safety') || msg.includes('block')) return 'SAFETY_BLOCKED';
  if (msg.includes('not found') || msg.includes('404')) return 'MODEL_UNAVAILABLE';
  return 'GENERATION_FAILED';
}

export interface Job {
  jobId: string;
  workflowId: number;
  status: 'queued' | 'normalizing' | 'preprocessing' | 'generating' | 'postprocessing' | 'completed' | 'failed' | 'cancelled';
  model: string;
  /** The engine the caller selected. */
  requestedModel?: string;
  /** The engine that actually produced the image — differs whenever the selection has no provider. */
  resolvedModel?: string | null;
  options: any;
  prompt: string;
  estimatedCostUsd: number;
  actualCostUsdEstimate: number;
  processingTimeMs: number;
  outputs: Array<{
    type: string;
    mime_type: string;
    gcs_uri: string;
    signed_url: string;
    width?: number;
    height?: number;
  }>;
  error?: string;
  promptVersion: string;
  userRating?: number;
  logs?: string[];
  createdAt: number;
}

// Runs a job in the background without blocking the response, and — when running on
// Vercel — keeps the function alive with waitUntil() until the job actually finishes.
async function scheduleBackgroundJob(jobId: string) {
  const promise = runAsyncJob(jobId).catch(err => {
    console.error(`[AI-Render Job ${jobId}] Unhandled background error`, err);
  });
  try {
    const { waitUntil } = await import('@vercel/functions');
    waitUntil(promise);
  } catch {
    // Not running on Vercel (e.g. local `vite dev`) — fire-and-forget is fine there.
  }
}


const MOCK_ARCH_VIDEOS = [
  'https://assets.mixkit.co/videos/preview/mixkit-modern-apartment-interior-design-with-creative-lighting-43093-large.mp4',
  'https://assets.mixkit.co/videos/preview/mixkit-bright-kitchen-with-wooden-details-in-modern-house-41577-large.mp4',
  'https://assets.mixkit.co/videos/preview/mixkit-luxury-home-exterior-with-swimming-pool-and-green-lawn-41618-large.mp4',
  'https://assets.mixkit.co/videos/preview/mixkit-living-room-with-modern-furniture-and-large-windows-41574-large.mp4'
];

async function generateVariant(job: Job, workflow: Workflow, index: number, transport: ImageTransport | null): Promise<{ base64: string; usedFallbackMock: boolean; resolvedModel: string }> {
  // These two providers do not generate an image at all — local_adjustment is applied on the
  // client and gemini_analysis produces a moodboard — so they keep returning the placeholder
  // that the output mapping below replaces with the source image or a moodboard reference.
  if (workflow.provider === 'local_adjustment' || workflow.provider === 'gemini_analysis') {
    const delay = job.model.includes('pro') ? 2500 : 1200;
    await new Promise(r => setTimeout(r, delay));
    return {
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', // 1x1 mock PNG
      usedFallbackMock: true,
      resolvedModel: 'none'
    };
  }

  if (!transport) {
    throw new Error('No image generation credentials are configured. Set GOOGLE_VERTEX_RENDER_SA_KEY_JSON, or GEMINI_API_KEY as a fallback.');
  }

  try {
    // Map non-gemini model identifiers (e.g. flux-1, stable-diffusion-xl) to Vertex AI image generator
    let targetModel = job.model;
    if (!targetModel.startsWith('gemini-')) {
      targetModel = 'gemini-3.1-flash-image';
    }

    // Extract reference image(s) if supplied in job options or assets
    interface ParsedImage {
      mimeType: string;
      base64Data: string;
      category?: 'drawing' | 'reference';
      drawingType?: string;
      customDrawingType?: string;
      referenceAspects?: string[];
      label?: string;
      name?: string;
    }

    const inputImagesList: ParsedImage[] = [];

    const parseImageEntry = (entry: any, defaultName = 'Reference'): ParsedImage | null => {
      if (!entry) return null;
      let rawStr = '';
      let mime = 'image/png';
      let label = typeof entry === 'object' ? entry.label : '';
      let name = typeof entry === 'object' ? entry.name : defaultName;
      let category = typeof entry === 'object' ? entry.category : undefined;
      let drawingType = typeof entry === 'object' ? entry.drawingType : undefined;
      let customDrawingType = typeof entry === 'object' ? entry.customDrawingType : undefined;
      let referenceAspects = typeof entry === 'object' ? entry.referenceAspects : undefined;

      if (typeof entry === 'string') {
        rawStr = entry;
      } else if (typeof entry === 'object') {
        rawStr = entry.base64 || entry.base64Data || entry.signed_url || entry.url || '';
      }

      if (!rawStr || typeof rawStr !== 'string' || rawStr.length < 50) return null;

      if (rawStr.startsWith('data:image/')) {
        const match = rawStr.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
        if (match) {
          mime = match[1];
          rawStr = match[2];
        }
      }

      return { mimeType: mime, base64Data: rawStr, label, name, category, drawingType, customDrawingType, referenceAspects };
    };

    // 1. Multiple images array
    const rawMultiImages = job.options?.uploaded_images || job.options?.parameters?.uploaded_images;
    if (Array.isArray(rawMultiImages) && rawMultiImages.length > 0) {
      rawMultiImages.forEach((img: any, idx: number) => {
        const parsed = parseImageEntry(img, `Image ${idx + 1}`);
        if (parsed) inputImagesList.push(parsed);
      });
    }

    // 2. Single image fallback if multi-array wasn't provided or empty
    if (inputImagesList.length === 0) {
      const singleRaw = job.options?.uploaded_image || 
        job.options?.assets?.[0]?.signed_url || 
        job.options?.assets?.[0]?.base64Data || 
        job.options?.source_image;
      const parsedSingle = parseImageEntry(singleRaw, 'Image 1');
      if (parsedSingle) {
        parsedSingle.label = 'Original Base Image to Edit';
        inputImagesList.push(parsedSingle);
      }
    }

    // 3. Mask image for inpainting / localized raster editing
    const rawMask = job.options?.mask_image || job.options?.parameters?.mask_image || job.options?.options?.mask_image;
    let hasMask = false;
    if (rawMask) {
      const parsedMask = parseImageEntry(rawMask, 'Inpainting Mask');
      if (parsedMask) {
        parsedMask.label = 'Inpainting Mask (WHITE = Target Region to Edit/Remove/Replace, BLACK = Strictly Preserve 100% Untouched)';
        inputImagesList.push(parsedMask);
        hasMask = true;
      }
    }

    const hasInputImage = inputImagesList.length > 0;

    const aspect = (job.options?.parameters?.aspect_ratio === 'custom' 
      ? job.options?.parameters?.custom_aspect_ratio 
      : job.options?.parameters?.aspect_ratio) || '16:9';
    const resolution = job.options?.parameters?.resolution || '2K';
    
    let canvasSpec = `[MANDATORY CANVAS SPECIFICATION]\nASPECT RATIO: ${aspect}\nRESOLUTION: ${resolution}`;
    if (hasInputImage) {
      canvasSpec += `\nPROPORTION FIDELITY: Maintain 1:1 true physical proportions of all architectural geometry. DO NOT stretch, squish, warp, or skew the scene. If the requested aspect ratio (${aspect}) differs from the input image, seamlessly extend (outpaint) the surrounding landscape, sky, floor, or architectural context to naturally fill the canvas without distorting focal structures.`;
    }

    let inpaintingSpec = '';
    if (hasMask) {
      inpaintingSpec = `\n\n[CRITICAL LOCALIZED INPAINTING MANDATE]\n- You are performing surgical inpainting.\n- The attached Inpainting Mask specifies the EXACT target region with WHITE pixels.\n- Modify ONLY the content located within the white masked area.\n- DO NOT touch, remove, alter, or regenerate any elements in the black area.\n- If there are other similar objects in the scene (such as other ceiling lights, windows, or furniture items) that are outside the white mask, THEY MUST REMAIN COMPLETELY PRESERVED AND UNCHANGED.`;
    }

    const finalPrompt = `${job.prompt}\n\n${canvasSpec}${inpaintingSpec}`;

    const fetch = (await import('node-fetch')).default || global.fetch;

    // 1. Try Gemini 3 multimodal image generator
    let base64 = '';
    // Records the model that actually produced the bytes. Selecting a non-Gemini engine
    // (flux-2-pro, stable-diffusion-xl) silently rewrites the target to a Gemini image
    // model above, so without this the job reports the model you picked rather than the
    // one that ran.
    let resolvedModel = '';
    if (hasInputImage) {
      let targetModel = job.model || 'gemini-3.1-flash-image';
      if (!targetModel.startsWith('gemini')) {
        targetModel = 'gemini-3.1-flash-image';
      }
      
      const multimodalModels = Array.from(new Set([targetModel, 'gemini-3.1-flash-image', 'gemini-3-pro-image']));

      for (const m of multimodalModels) {
        if (base64) break;
        try {
          const vertexUrl = geminiImageEndpoint(transport, m);

          const userParts: any[] = [];
          inputImagesList.forEach((img, idx) => {
            let tag = `[Image ${idx + 1}]:`;
            if (img.category === 'drawing') {
              const rawType = (img.drawingType === 'Custom' && img.customDrawingType) ? img.customDrawingType : (img.drawingType || 'Floor Plan');
              let typeName = rawType;
              if (rawType.toLowerCase().includes('floor') || rawType.toLowerCase().includes('plan')) typeName = 'Floorplan';
              else if (rawType.toLowerCase().includes('elevation') || rawType.toLowerCase().includes('facade')) typeName = 'Elevation';
              else if (rawType.toLowerCase().includes('sketch')) typeName = 'Sketch';
              else if (rawType.toLowerCase().includes('3d') || rawType.toLowerCase().includes('model')) typeName = '3D Model Screenshot';
              else if (rawType.toLowerCase().includes('section')) typeName = 'Section Drawing';
              tag = `[Image ${idx + 1}: Design Drawing - ${typeName}]:`;
            } else if (img.category === 'reference') {
              const aspects = (img.referenceAspects && img.referenceAspects.length > 0) ? img.referenceAspects : ['All (Complete Theme & Mood)'];
              let aspectsLabel = '';
              if (aspects.includes('All (Complete Theme & Mood)')) {
                aspectsLabel = 'All Theme (Style, Lighting, Materials, Furniture, Landscape)';
              } else {
                aspectsLabel = aspects.map((a: string) => a.split(' ')[0]).join(', ');
              }
              tag = `[Image ${idx + 1}: Visual Reference - ${aspectsLabel}]:`;
            } else if (img.label) {
              tag = `[Image ${idx + 1}: ${img.label}]:`;
            }
            userParts.push({ text: tag });
            userParts.push({
              inlineData: {
                mimeType: img.mimeType,
                data: img.base64Data
              }
            });
          });
          userParts.push({ text: finalPrompt });

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 95000);

          const res = await fetch(vertexUrl, {
            method: 'POST',
            signal: controller.signal,
            headers: geminiImageHeaders(transport),
            body: JSON.stringify({
              contents: [{
                role: 'user',
                parts: userParts
              }],
              generationConfig: {
                candidateCount: 1,
                responseModalities: ['IMAGE']
              }
            })
          });
          clearTimeout(timeoutId);

          if (res.ok) {
            const data = await res.json();
            const imagePart = data?.candidates
              ?.flatMap((candidate: any) => candidate.content?.parts || [])
              .find((part: any) => part.inlineData?.data);
            base64 = imagePart?.inlineData?.data || '';
            if (base64) resolvedModel = m;
          } else {
            const errText = await res.text();
            console.warn(`[AI-Render] Gemini multimodal image call (${m}) returned status ${res.status}: ${errText}`);
          }
        } catch (err: any) {
          console.warn(`[AI-Render] Gemini multimodal image call (${m}) failed: ${err.message}`);
        }
      }
    }

    // 2. Try Imagen 3 native image generator (for text-to-image or secondary generator).
    // Imagen is only reachable through Vertex, so it is skipped on the API-key fallback.
    if (!base64 && !hasInputImage && transport.kind === 'vertex') {
      const imagenModels = [
        'imagen-3.0-generate-002',
        'imagen-3.0-fast-generate-001',
        'imagen-3.0-generate-001'
      ];
      for (const m of imagenModels) {
        if (base64) break;
        try {
          const imagenUrl = `https://us-central1-aiplatform.googleapis.com/v1/projects/rendair-competitor/locations/us-central1/publishers/google/models/${m}:predict`;
          const instancePayload: any = { prompt: finalPrompt };
          const res = await fetch(imagenUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${transport.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instances: [instancePayload],
              parameters: {
                sampleCount: 1,
                aspectRatio: aspect,
                outputOptions: { mimeType: 'image/png' }
              }
            })
          });

          if (res.ok) {
            const data = await res.json();
            base64 = data?.predictions?.[0]?.bytesBase64Encoded || '';
            if (base64) resolvedModel = m;
          } else {
            const errText = await res.text();
            console.warn(`[AI-Render] Imagen model ${m} returned status ${res.status}: ${errText}`);
          }
        } catch (err: any) {
          console.warn(`[AI-Render] Imagen model ${m} call failed: ${err.message}`);
        }
      }
    }

    // 3. Fallback to Gemini generateContent
    if (!base64) {
      let targetModel = job.model;
      if (!targetModel.startsWith('gemini-')) {
        targetModel = 'gemini-3.1-flash-image';
      }
      const vertexUrl = geminiImageEndpoint(transport, targetModel);
      const userParts: any[] = [];
      inputImagesList.forEach((img, idx) => {
        const tag = img.label ? `[REFERENCE IMAGE ${idx + 1} (${img.label})]:` : `[REFERENCE IMAGE ${idx + 1}]:`;
        userParts.push({ text: tag });
        userParts.push({
          inlineData: {
            mimeType: img.mimeType,
            data: img.base64Data
          }
        });
      });
      userParts.push({ text: finalPrompt });

      const res = await fetch(vertexUrl, {
        method: 'POST',
        headers: geminiImageHeaders(transport),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: userParts }],
          generationConfig: {
            candidateCount: 1,
            responseModalities: ['IMAGE']
          }
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`${transport.kind === 'vertex' ? 'Vertex AI' : 'Gemini'} API returned status ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const imagePart = data?.candidates
        ?.flatMap((candidate: any) => candidate.content?.parts || [])
        .find((part: any) => part.inlineData?.data);
      base64 = imagePart?.inlineData?.data;
      if (base64) resolvedModel = targetModel;
    }

    if (!base64) throw new Error('No image bytes returned from Vertex AI.');
    return { base64, usedFallbackMock: false, resolvedModel };

  } catch (liveError: any) {
    console.error(`[AI-Render Job ${job.jobId} Variant ${index + 1}] Live call failed: ${liveError.message}`);
    throw liveError;
  }
}

// Background task executor helper
async function runAsyncJob(jobId: string) {
  const job = await getJob(jobId);
  if (!job) return;
  const persist = () => setJob(jobId, job);

  const workflow = WORKFLOWS[job.workflowId];
  const startTime = Date.now();
  const variants = job.options?.parameters?.variants || job.options?.variants || job.options?.options?.variants || 1;

  console.log(`[AI-Render Job ${jobId}] Starting execution for workflow: ${workflow.slug} (${workflow.name}) with ${variants} variants in parallel`);

  try {
    // 1. Normalizing & AI Prompt Enhancement
    job.status = 'normalizing';
    console.log(`[AI-Render Job ${jobId}] State: normalizing (AI prompt enhancement)`);
    job.logs?.push('Parsing design intent and enhancing architectural prompt with AI.');
    await persist();

    if (!job.options?.is_custom_edited) {
      try {
        const getAccessToken = async () => {
          const client = await getVertexClient();
          if (!client) return null;
          const res = await client.getAccessToken();
          return res.token || null;
        };
        const enhanced = await PromptEnhancerEngine.enhanceWithVertex({
          user_input: job.options.user_input || '',
          workflow_id: job.workflowId,
          image_style: job.options.image_style || 'realistic',
          model: job.model,
          people: job.options.people,
          camera_angle: job.options.camera_angle,
          custom_camera: job.options.custom_camera,
          lighting: job.options.lighting,
          custom_lighting: job.options.custom_lighting,
          materials: job.options.materials,
          custom_materials: job.options.custom_materials,
          environment: job.options.environment,
          custom_environment: job.options.custom_environment,
          mood: job.options.mood,
          custom_mood: job.options.custom_mood,
          has_reference_image: !!job.options.uploaded_image || (Array.isArray(job.options.uploaded_images) && job.options.uploaded_images.length > 0),
          reference_images_count: Array.isArray(job.options.uploaded_images) ? job.options.uploaded_images.length : (job.options.uploaded_image ? 1 : 0),
          reference_images_metadata: Array.isArray(job.options.uploaded_images) ? job.options.uploaded_images : undefined,
          controlnet_enabled: job.options?.parameters?.controlnet_enabled ?? job.options?.controlnet_enabled,
          controlnet_strength: job.options?.parameters?.controlnet_strength_percent ?? job.options?.controlnet_strength ?? 80
        }, getAccessToken);
        if (enhanced) {
          job.prompt = enhanced;
        }
      } catch (e) {
        console.warn(`[AI-Render Job ${jobId}] AI prompt enhancement fallback:`, e);
      }
    }

    // 2. Preprocessing
    job.status = 'preprocessing';
    console.log(`[AI-Render Job ${jobId}] State: preprocessing`);
    job.logs?.push('Validating and converting uploaded source files.');
    await persist();
    await new Promise(r => setTimeout(r, 600));

    // 3. Generating
    job.status = 'generating';
    console.log(`[AI-Render Job ${jobId}] State: generating`);
    job.logs?.push(`Contacting provider adapters and launching ${variants} parallel api calls...`);
    await persist();

    const transport = await resolveImageTransport();
    if (transport) {
      job.logs?.push(`Image generation transport: ${transport.kind === 'vertex' ? 'Vertex AI (render service account)' : 'Gemini API key fallback'}.`);
    }

    // Launch all variant calls in parallel!
    const results = await Promise.all(
      Array.from({ length: variants }).map((_, idx) => generateVariant(job, workflow, idx, transport))
    );

    const usedFallbackMock = results.some(r => r.usedFallbackMock);

    // Report the model that actually ran, not the one the dropdown asked for. FLUX.2 Pro and
    // Stable Diffusion XL have no provider behind them, so they are rewritten to a Gemini
    // image model; without this the job would claim to have run the engine you selected.
    job.requestedModel = job.model;
    job.resolvedModel = results.find(r => r.resolvedModel && r.resolvedModel !== 'none')?.resolvedModel || null;
    if (job.resolvedModel && job.resolvedModel !== job.requestedModel) {
      const line = `Requested model "${job.requestedModel}" is not available; generated with "${job.resolvedModel}".`;
      console.warn(`[AI-Render Job ${jobId}] ${line}`);
      job.logs?.push(line);
    } else if (job.resolvedModel) {
      job.logs?.push(`Generated with "${job.resolvedModel}".`);
    }

    // 4. Postprocessing
    job.status = 'postprocessing';
    console.log(`[AI-Render Job ${jobId}] State: postprocessing`);
    job.logs?.push('Finalizing assets, saving private rendering references.');
    await persist();
    await new Promise(r => setTimeout(r, 400));

    let mimeType = 'image/png';
    let outputType = 'image';

    if (workflow.output_types.includes('video/mp4')) {
      outputType = 'video';
      mimeType = 'video/mp4';
    } else if (workflow.output_types.includes('model/gltf-binary') || workflow.output_types.includes('application/octet-stream')) {
      outputType = '3d';
      mimeType = 'model/gltf-binary';
    }

    job.outputs = results.map((res, index) => {
      let signedUrl = `data:${mimeType};base64,${res.base64}`;
      if (outputType === 'video') {
        const duration = job.options?.parameters?.duration_seconds || job.options?.duration_seconds || job.options?.options?.duration_seconds || 4;
        const baseVideo = MOCK_ARCH_VIDEOS[index % MOCK_ARCH_VIDEOS.length];
        signedUrl = `${baseVideo}#t=0,${duration}`;
      } else if (outputType === '3d') {
        signedUrl = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Box/GLTF-Binary/Box.glb';
      } else if (res.usedFallbackMock) {
        const sourceImage = job.options?.assets?.source_image || job.options?.assets?.image;
        if (sourceImage && workflow.slug !== 'render-to-moodboard') {
          signedUrl = sourceImage;
        } else if (workflow.slug === 'render-to-moodboard') {
          const MOODBOARD_MOCKS = [
            'https://images.unsplash.com/photo-1533090161767-e6ffed986c88?auto=format&fit=crop&w=1200&q=80',
            'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?auto=format&fit=crop&w=1200&q=80',
            'https://images.unsplash.com/photo-1507089947368-19c1da9775ae?auto=format&fit=crop&w=1200&q=80'
          ];
          signedUrl = MOODBOARD_MOCKS[index % MOODBOARD_MOCKS.length];
        } else {
          // local_adjustment applies an edit to an image the caller supplies; with no source
          // image there is nothing to return, and a stock photograph would misrepresent it.
          throw new Error(`${workflow.name} requires a source image, but none was supplied.`);
        }
      }
      return {
        type: outputType,
        mime_type: mimeType,
        gcs_uri: `gs://rendair-competitor-assets/users/dev-user/ai-render/${jobId}/outputs/output_${index}.${mimeType === 'image/png' ? 'png' : mimeType === 'video/mp4' ? 'mp4' : 'glb'}`,
        signed_url: signedUrl,
        width: 1024,
        height: 1024
      };
    });

    job.status = 'completed';
    job.processingTimeMs = Date.now() - startTime;
    
    // Set actual cost. If mock fallback was used, cost is 0 USD
    job.actualCostUsdEstimate = usedFallbackMock ? 0 : ActualUsageCostCalculator.calculate(job.model, (job.processingTimeMs / 1000) / variants, {
      duration_seconds: job.options?.parameters?.duration_seconds || job.options?.duration_seconds || job.options?.options?.duration_seconds || 4,
      resolution: job.options?.parameters?.resolution || job.options?.resolution || job.options?.options?.resolution || '2K',
      audio: job.options?.parameters?.audio ?? job.options?.audio ?? job.options?.options?.audio ?? false
    }) * variants;
    
    console.log(`[AI-Render Job ${jobId}] State: completed in ${job.processingTimeMs}ms. Cost: $${job.actualCostUsdEstimate}`);
    job.logs?.push(`Job completed successfully with ${variants} variants.`);
    await persist();

  } catch (err: any) {
    console.error(`[AI-Render Job ${jobId}] Failed:`, err);
    job.status = 'failed';
    job.error = normalizeError(err);
    job.processingTimeMs = Date.now() - startTime;
    job.logs?.push(`Job failed: ${job.error}. Raw: ${err.message || err}`);
    job.actualCostUsdEstimate = 0;
    await persist();
  }
}

export const warmAiRenderVertexAuth = async () => {
  const startedAt = Date.now();
  const transport = await resolveImageTransport();
  if (!transport) {
    // No credentials at all: report it instead of implying a working mock renderer.
    return { ready: false, transport: 'none', warmupMs: Date.now() - startedAt };
  }
  return { ready: true, transport: transport.kind, warmupMs: Date.now() - startedAt };
};

export const routeAiRenderApiRequest = async (
  request: { method?: string; url?: string; body?: any },
  response: { status: (code: number) => any; json: (payload: any) => void }
): Promise<boolean> => {
  const url = request.url || '';
  if (!url.startsWith('/api/ai-render')) {
    return false;
  }

  console.log(`[AI-Render API] Request: ${request.method} ${url}`);

  // POST /api/ai-render/auth/warm
  if (url === '/api/ai-render/auth/warm' && request.method === 'POST') {
    try {
      const result = await warmAiRenderVertexAuth();
      console.log(`[AI-Render API] Vertex auth prewarmed in ${result.warmupMs}ms`);
      response.json(result);
    } catch (e: any) {
      console.warn(`[AI-Render API] Vertex auth prewarm failed:`, e);
      response.json({ ready: false, error: e.message });
    }
    return true;
  }

  // GET /api/ai-render/workflows
  if (url === '/api/ai-render/workflows' && request.method === 'GET') {
    response.json(Object.values(WORKFLOWS));
    return true;
  }

  // POST /api/ai-render/enhance-prompt
  if (url === '/api/ai-render/enhance-prompt' && request.method === 'POST') {
    const body = request.body || {};
    const { user_input, workflow_id, image_style, model } = body;
    const reqPayload = {
      ...body,
      user_input: user_input || '',
      workflow_id: Number(workflow_id || 1),
      image_style: image_style || 'realistic',
      model: model || 'gemini-3-pro-image'
    };
    try {
      const getAccessToken = async () => {
        const client = await getVertexClient();
        if (!client) return null;
        const res = await client.getAccessToken();
        return res.token || null;
      };
      const enhancedPrompt = await PromptEnhancerEngine.enhanceWithVertex(
        reqPayload,
        getAccessToken
      );
      response.json({ enhanced_prompt: enhancedPrompt });
    } catch (e: any) {
      console.warn('[AI-Render API] Prompt enhancement error:', e);
      const fallbackPrompt = PromptEnhancerEngine.enhanceOffline(reqPayload);
      response.json({ enhanced_prompt: fallbackPrompt });
    }
    return true;
  }

  // POST /api/ai-render/uploads
  if (url === '/api/ai-render/uploads' && request.method === 'POST') {
    const { filename, base64Data } = request.body || {};
    response.json({
      gcs_uri: `gs://rendair-competitor-assets/users/dev-user/ai-render/temp-uploads/${filename || 'upload.png'}`,
      signed_url: base64Data || 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    });
    return true;
  }

  // POST /api/ai-render/jobs
  if (url === '/api/ai-render/jobs' && request.method === 'POST') {
    const body = request.body || {};
    const { workflow_id, model, user_input, assets, options, parameters, override_prompt } = body;
    const workflow = WORKFLOWS[workflow_id];

    if (!workflow) {
      response.status(400).json({ error: 'Invalid workflow_id' });
      return true;
    }

    const effectiveParams = parameters || options || {};
    const selectedModel = model || workflow.default_model;
    const jobId = 'job_' + Math.random().toString(36).substr(2, 9);
    
    const resolvedOverride = override_prompt || options?.override_prompt || (typeof user_input === 'string' && user_input.startsWith('TASK:') ? user_input : undefined);
    const compiledPrompt = resolvedOverride || PromptEnhancerEngine.enhanceOffline({
      user_input: user_input || workflow.name,
      workflow_id: workflow.id,
      image_style: body.image_style || options?.image_style || 'realistic',
      model: selectedModel
    });

    const variants = effectiveParams?.variants || body.variants || 1;
    const costResult = WorkflowCostEstimator.calculate(workflow_id, selectedModel, effectiveParams);

    const mergedOptions = {
      ...body,
      parameters: effectiveParams,
      options: effectiveParams,
      user_input,
      assets
    };

    const newJob: Job = {
      jobId,
      workflowId: workflow_id,
      status: 'queued',
      model: selectedModel,
      options: mergedOptions,
      prompt: compiledPrompt,
      estimatedCostUsd: costResult.estimateUsd * variants,
      actualCostUsdEstimate: 0,
      processingTimeMs: 0,
      outputs: [],
      promptVersion: workflow.prompt_version,
      logs: ['Job created and queued.'],
      createdAt: Date.now()
    };

    await setJob(jobId, newJob);

    await scheduleBackgroundJob(jobId);

    response.json(newJob);
    return true;
  }

  // GET /api/ai-render/jobs/{job_id}
  const statusMatch = url.match(/^\/api\/ai-render\/jobs\/([^/]+)$/);
  if (statusMatch && request.method === 'GET') {
    const jobId = statusMatch[1];
    const job = await getJob(jobId);
    if (!job) {
      response.status(404).json({ error: 'Job not found' });
    } else {
      response.json(job);
    }
    return true;
  }

  // GET /api/ai-render/jobs/{job_id}/result
  const resultMatch = url.match(/^\/api\/ai-render\/jobs\/([^/]+)\/result$/);
  if (resultMatch && request.method === 'GET') {
    const jobId = resultMatch[1];
    const job = await getJob(jobId);
    if (!job) {
      response.status(404).json({ error: 'Job not found' });
    } else {
      response.json({ status: job.status, outputs: job.outputs, error: job.error });
    }
    return true;
  }

  // POST /api/ai-render/jobs/{job_id}/cancel
  const cancelMatch = url.match(/^\/api\/ai-render\/jobs\/([^/]+)\/cancel$/);
  if (cancelMatch && request.method === 'POST') {
    const jobId = cancelMatch[1];
    const job = await getJob(jobId);
    if (!job) {
      response.status(404).json({ error: 'Job not found' });
    } else {
      job.status = 'cancelled';
      job.logs?.push('Job cancelled by user.');
      await setJob(jobId, job);
      response.json(job);
    }
    return true;
  }

  // POST /api/ai-render/jobs/{job_id}/retry
  const retryMatch = url.match(/^\/api\/ai-render\/jobs\/([^/]+)\/retry$/);
  if (retryMatch && request.method === 'POST') {
    const jobId = retryMatch[1];
    const job = await getJob(jobId);
    if (!job) {
      response.status(404).json({ error: 'Job not found' });
    } else {
      job.status = 'queued';
      job.logs = ['Job retried.'];
      await setJob(jobId, job);
      await scheduleBackgroundJob(jobId);
      response.json(job);
    }
    return true;
  }

  // POST /api/ai-render/jobs/{job_id}/rate
  const rateMatch = url.match(/^\/api\/ai-render\/jobs\/([^/]+)\/rate$/);
  if (rateMatch && request.method === 'POST') {
    const jobId = rateMatch[1];
    const { rating } = request.body || {};
    const job = await getJob(jobId);
    if (!job) {
      response.status(404).json({ error: 'Job not found' });
    } else {
      job.userRating = rating;
      await setJob(jobId, job);
      response.json({ success: true, job });
    }
    return true;
  }

  response.status(404).json({ error: 'Not Found' });
  return true;
};
