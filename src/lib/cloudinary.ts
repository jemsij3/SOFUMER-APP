import { apiFetch } from './api';

export const MAX_PRODUCT_PHOTOS = 6;
export const MAX_VIDEO_DURATION_SEC = 10;

export const ALLOWED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'] as const;
export const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'] as const;
export const ALLOWED_VIDEO_EXTENSIONS = ['mp4', 'mov'] as const;
export const ALLOWED_VIDEO_MIMES = ['video/mp4', 'video/quicktime'] as const;

export interface SellerMediaConfig {
  configured: boolean;
  presetRequired: boolean;
  maxPhotos: number;
  maxVideos: number;
  maxVideoDurationSec: number;
  maxImageBytes: number;
  maxVideoBytes: number;
  allowedImageFormats: string[];
  allowedVideoFormats: string[];
}

export interface SignedUploadParams {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  publicId: string;
  expectedFullPublicId: string;
  resourceType: 'image' | 'video';
  uploadUrl: string;
  maxFileBytes: number;
  maxVideoDurationSec: number;
  maxPhotos: number;
  maxVideos: number;
}

export interface VerifiedMediaUpload {
  id?: string;
  storageProvider: 'cloudinary' | 'legacy_url';
  mediaType: 'image' | 'video';
  resourceType: 'image' | 'video';
  publicId: string;
  version?: number | string;
  signature?: string;
  secureUrl: string;
  format: string;
  bytes: number;
  width: number;
  height: number;
  duration: number | null;
  sortOrder: number;
  isPrimary: boolean;
  altText: string;
}

export const DEFAULT_MEDIA_CONFIG: SellerMediaConfig = {
  configured: false,
  presetRequired: false,
  maxPhotos: MAX_PRODUCT_PHOTOS,
  maxVideos: 2,
  maxVideoDurationSec: MAX_VIDEO_DURATION_SEC,
  maxImageBytes: 10 * 1024 * 1024,
  maxVideoBytes: 30 * 1024 * 1024,
  allowedImageFormats: [...ALLOWED_IMAGE_EXTENSIONS],
  allowedVideoFormats: [...ALLOWED_VIDEO_EXTENSIONS],
};

export async function fetchSellerMediaConfig(): Promise<SellerMediaConfig> {
  return apiFetch<SellerMediaConfig>('/api/seller/media/config');
}

function getExtension(name: string): string {
  const cleaned = String(name || '').trim().toLowerCase();
  const idx = cleaned.lastIndexOf('.');
  if (idx === -1 || idx === cleaned.length - 1) return '';
  return cleaned.slice(idx + 1).replace(/[^a-z0-9]/g, '');
}

export function validateImageFile(
  file: File,
  maxImageBytes: number
): { ok: true } | { ok: false; error: string } {
  const mime = (file.type || '').toLowerCase();
  const ext = getExtension(file.name);
  const mimeOk = !mime || (ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime);
  const extOk = !ext || (ALLOWED_IMAGE_EXTENSIONS as readonly string[]).includes(ext);

  if (!mimeOk || !extOk || (!mime && !ext)) {
    return {
      ok: false,
      error: `"${file.name}" is not a supported photo format. Allowed: JPG, JPEG, PNG, and WebP.`,
    };
  }
  if (file.size <= 0) {
    return { ok: false, error: `"${file.name}" is empty.` };
  }
  if (file.size > maxImageBytes) {
    const maxMb = Math.round(maxImageBytes / (1024 * 1024));
    return { ok: false, error: `"${file.name}" exceeds the ${maxMb} MB photo size limit.` };
  }
  return { ok: true };
}

export async function validateVideoFileAndDuration(
  file: File,
  maxVideoBytes: number,
  maxDurationSec = MAX_VIDEO_DURATION_SEC
): Promise<{ ok: true; duration: number } | { ok: false; error: string }> {
  const mime = (file.type || '').toLowerCase();
  const ext = getExtension(file.name);
  const mimeOk = !mime || (ALLOWED_VIDEO_MIMES as readonly string[]).includes(mime);
  const extOk = !ext || (ALLOWED_VIDEO_EXTENSIONS as readonly string[]).includes(ext);

  if (!mimeOk || !extOk || (!mime && !ext)) {
    return {
      ok: false,
      error: `"${file.name}" is not a supported video format. Allowed: MP4 and MOV.`,
    };
  }
  if (file.size <= 0) {
    return { ok: false, error: `"${file.name}" is empty.` };
  }
  if (file.size > maxVideoBytes) {
    const maxMb = Math.round(maxVideoBytes / (1024 * 1024));
    return { ok: false, error: `"${file.name}" exceeds the ${maxMb} MB video size limit.` };
  }

  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    let settled = false;
    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        ok: false,
        error: `Could not read duration for "${file.name}". Please upload a standard MP4 or MOV clip (max ${maxDurationSec}s).`,
      });
    }, 8000);

    video.onloadedmetadata = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      const dur = Number(video.duration);
      cleanup();

      if (!Number.isFinite(dur) || dur <= 0) {
        resolve({
          ok: false,
          error: `Could not determine duration of "${file.name}".`,
        });
        return;
      }

      if (dur > maxDurationSec) {
        resolve({
          ok: false,
          error: `Video "${file.name}" is ${dur.toFixed(1)}s long. Short product videos must be ${maxDurationSec} seconds or less and are not automatically trimmed.`,
        });
        return;
      }

      resolve({ ok: true, duration: Number(dur.toFixed(2)) });
    };

    video.onerror = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      cleanup();
      resolve({
        ok: false,
        error: `Unable to decode "${file.name}". Please select a valid MP4 or MOV video (max ${maxDurationSec}s).`,
      });
    };

    video.src = url;
  });
}

export async function uploadSignedMediaToCloudinary(options: {
  file: File;
  mediaType: 'image' | 'video';
  duration?: number | null;
  productId?: string;
  replaceMediaId?: string;
  scope?: 'product' | 'shop';
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}): Promise<VerifiedMediaUpload> {
  const {
    file,
    mediaType,
    duration,
    productId,
    replaceMediaId,
    scope = 'product',
    signal,
    onProgress,
  } = options;

  const signParams = await apiFetch<SignedUploadParams>('/api/seller/media/sign', {
    method: 'POST',
    body: JSON.stringify({
      mediaType,
      mimeType: file.type,
      fileName: file.name,
      fileSize: file.size,
      duration: mediaType === 'video' ? duration : undefined,
      productId,
      replaceMediaId,
      scope,
    }),
  });

  if (signal?.aborted) {
    throw new Error('Upload cancelled.');
  }

  const cloudinaryPayload = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', signParams.uploadUrl, true);

    const onAbort = () => {
      xhr.abort();
      reject(new Error('Upload cancelled.'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) {
        const pct = Math.min(95, Math.max(5, Math.round((ev.loaded / ev.total) * 95)));
        onProgress(pct);
      }
    };

    xhr.onload = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(xhr.responseText || '{}');
      } catch {
        parsed = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsed);
      } else {
        const errMsg =
          (parsed.error as { message?: string } | undefined)?.message ||
          `Cloudinary upload failed (HTTP ${xhr.status}).`;
        reject(new Error(errMsg));
      }
    };

    xhr.onerror = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new Error('Network error while uploading media to Cloudinary.'));
    };

    const formData = new FormData();
    formData.append('file', file);
    formData.append('api_key', signParams.apiKey);
    formData.append('timestamp', String(signParams.timestamp));
    formData.append('signature', signParams.signature);
    formData.append('folder', signParams.folder);
    formData.append('public_id', signParams.publicId);
    xhr.send(formData);
  });

  onProgress?.(98);

  const publicId = String(cloudinaryPayload.public_id || signParams.expectedFullPublicId);
  const version = cloudinaryPayload.version as number | string | undefined;
  const responseSignature = String(cloudinaryPayload.signature || '');
  const verifiedRes = await apiFetch<{ verifiedMedia: VerifiedMediaUpload }>(
    '/api/seller/media/verify',
    {
      method: 'POST',
      body: JSON.stringify({
        scope,
        publicId,
        version,
        signature: responseSignature,
        secureUrl: cloudinaryPayload.secure_url,
        resourceType: cloudinaryPayload.resource_type || mediaType,
        mediaType,
        format: cloudinaryPayload.format,
        bytes: cloudinaryPayload.bytes,
        width: cloudinaryPayload.width,
        height: cloudinaryPayload.height,
        duration: cloudinaryPayload.duration ?? duration ?? null,
      }),
    }
  );

  onProgress?.(100);

  return {
    ...verifiedRes.verifiedMedia,
    version,
    signature: responseSignature,
  };
}

export function optimizeCloudinaryUrl(
  rawUrl: string | null | undefined,
  mode: 'thumb' | 'gallery' | 'video' | 'poster',
  width?: number
): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== 'res.cloudinary.com') return trimmed;

    if (mode === 'video') {
      const marker = '/video/upload/';
      const idx = parsed.pathname.indexOf(marker);
      if (idx === -1) return trimmed;
      const prefix = parsed.pathname.slice(0, idx + marker.length);
      const rest = parsed.pathname.slice(idx + marker.length);
      if (rest.startsWith('f_') || rest.startsWith('q_') || rest.startsWith('vc_')) return trimmed;
      const mp4Rest = rest.replace(/\.[a-z0-9]+$/i, '.mp4');
      return `${parsed.origin}${prefix}f_mp4,vc_h264,q_auto/${mp4Rest}`;
    }

    if (mode === 'poster') {
      const marker = '/video/upload/';
      const idx = parsed.pathname.indexOf(marker);
      if (idx === -1) return '';
      const prefix = parsed.pathname.slice(0, idx + marker.length);
      const rest = parsed.pathname.slice(idx + marker.length).replace(/\.[a-z0-9]+$/i, '.jpg');
      return `${parsed.origin}${prefix}so_0,f_jpg,q_auto,w_${width || 800}/${rest}`;
    }

    const marker = '/image/upload/';
    const idx = parsed.pathname.indexOf(marker);
    if (idx === -1) return trimmed;
    const prefix = parsed.pathname.slice(0, idx + marker.length);
    const rest = parsed.pathname.slice(idx + marker.length);
    if (rest.startsWith('f_') || rest.startsWith('q_') || rest.startsWith('c_')) return trimmed;
    const transform =
      mode === 'thumb'
        ? `f_auto,q_auto,c_fill,w_${width || 640}`
        : `f_auto,q_auto,w_${width || 1200}`;
    return `${parsed.origin}${prefix}${transform}/${rest}`;
  } catch {
    return trimmed;
  }
}
