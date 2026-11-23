import crypto from 'node:crypto';
import { db, newId } from './db.ts';
import { sanitizeText } from './security.ts';

export const MAX_PRODUCT_PHOTOS = 6;
export const MAX_VIDEO_DURATION_SEC = 10;
export const DEFAULT_MAX_VIDEOS_PER_PRODUCT = 2;
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_VIDEO_BYTES = 30 * 1024 * 1024;

export const ALLOWED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'] as const;
export const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'] as const;
export const ALLOWED_VIDEO_EXTENSIONS = ['mp4', 'mov'] as const;
export const ALLOWED_VIDEO_MIMES = ['video/mp4', 'video/quicktime'] as const;

export interface MediaLimits {
  maxPhotos: number;
  maxVideos: number;
  maxVideoDurationSec: number;
  maxImageBytes: number;
  maxVideoBytes: number;
}

export interface CloudinaryConfigState {
  configured: boolean;
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

export interface SubmittedMediaInput {
  id?: string;
  mediaType?: 'image' | 'video';
  resourceType?: 'image' | 'video';
  publicId?: string;
  version?: number | string;
  signature?: string;
  secureUrl?: string;
  format?: string;
  bytes?: number;
  width?: number;
  height?: number;
  duration?: number | null;
  sortOrder?: number;
  isPrimary?: boolean;
  altText?: string;
  storageProvider?: 'cloudinary' | 'legacy_url';
}

export interface VerifiedMediaRecord {
  id?: string;
  storageProvider: 'cloudinary' | 'legacy_url';
  mediaType: 'image' | 'video';
  resourceType: 'image' | 'video';
  publicId: string;
  secureUrl: string;
  format: string;
  bytes: number;
  width: number;
  height: number;
  duration: number | null;
  sortOrder: number;
  isPrimary: number;
  altText: string;
}

export function getCloudinaryConfigState(): CloudinaryConfigState {
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const apiKey = String(process.env.CLOUDINARY_API_KEY || '').trim();
  const apiSecret = String(process.env.CLOUDINARY_API_SECRET || '').trim();
  return {
    configured: Boolean(cloudName && apiKey && apiSecret),
    cloudName,
    apiKey,
    apiSecret,
  };
}

export function getMediaLimitsFromLocalDb(): MediaLimits {
  const rows = db
    .prepare(
      "SELECT key, value FROM platform_settings WHERE key IN ('max_product_videos', 'max_product_image_mb', 'max_product_video_mb')"
    )
    .all() as Array<{ key: string; value: string }>;
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.key, r.value);

  const rawMaxVideos = Number(map.get('max_product_videos') || DEFAULT_MAX_VIDEOS_PER_PRODUCT);
  const rawMaxImgMb = Number(map.get('max_product_image_mb') || 10);
  const rawMaxVidMb = Number(map.get('max_product_video_mb') || 30);

  return {
    maxPhotos: MAX_PRODUCT_PHOTOS,
    maxVideos: Number.isFinite(rawMaxVideos)
      ? Math.min(5, Math.max(1, Math.floor(rawMaxVideos)))
      : DEFAULT_MAX_VIDEOS_PER_PRODUCT,
    maxVideoDurationSec: MAX_VIDEO_DURATION_SEC,
    maxImageBytes: Math.round(
      (Number.isFinite(rawMaxImgMb) ? Math.min(20, Math.max(1, rawMaxImgMb)) : 10) * 1024 * 1024
    ),
    maxVideoBytes: Math.round(
      (Number.isFinite(rawMaxVidMb) ? Math.min(100, Math.max(5, rawMaxVidMb)) : 30) * 1024 * 1024
    ),
  };
}

function sha1Hex(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function generateCloudinarySignature(
  params: Record<string, string | number | boolean | undefined>,
  apiSecret: string
): string {
  const pairs: string[] = [];
  const keys = Object.keys(params)
    .filter((k) => {
      if (['file', 'cloud_name', 'resource_type', 'api_key', 'signature'].includes(k)) return false;
      const val = params[k];
      return val !== undefined && val !== null && String(val) !== '';
    })
    .sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    pairs.push(`${key}=${String(params[key])}`);
  }
  return sha1Hex(`${pairs.join('&')}${apiSecret}`);
}

export function verifyCloudinaryResponseSignature(
  params: { publicId: string; version: number | string; signature: string },
  apiSecret: string
): boolean {
  const publicId = String(params.publicId || '').trim();
  const version = String(params.version ?? '').trim();
  const signature = String(params.signature || '').trim().toLowerCase();
  if (!publicId || !version || !/^[a-f0-9]{40}$/.test(signature)) {
    return false;
  }
  const expected = sha1Hex(`public_id=${publicId}&version=${version}${apiSecret}`);
  return timingSafeEqualStr(signature, expected.toLowerCase());
}

export function extractFileExtension(fileName?: string): string {
  const cleaned = sanitizeText(fileName || '', 200).toLowerCase();
  const dotIdx = cleaned.lastIndexOf('.');
  if (dotIdx === -1 || dotIdx === cleaned.length - 1) return '';
  return cleaned.slice(dotIdx + 1).replace(/[^a-z0-9]/g, '');
}

export function validateSignRequestPayload(
  input: {
    mediaType?: unknown;
    mimeType?: unknown;
    fileName?: unknown;
    fileSize?: unknown;
    duration?: unknown;
    scope?: unknown;
  },
  limits: MediaLimits
):
  | {
      ok: true;
      mediaType: 'image' | 'video';
      resourceType: 'image' | 'video';
      scope: 'product' | 'shop';
      fileSize: number;
      clientDuration: number | null;
      ext: string;
    }
  | { ok: false; error: string } {
  const mediaType = input.mediaType === 'video' ? 'video' : input.mediaType === 'image' ? 'image' : null;
  if (!mediaType) {
    return { ok: false, error: 'Media type must be "image" or "video".' };
  }

  const scope = input.scope === 'shop' ? 'shop' : 'product';
  if (scope === 'shop' && mediaType !== 'image') {
    return { ok: false, error: 'Shop logos and banners only support image uploads.' };
  }

  const mimeType = sanitizeText(input.mimeType || '', 80).toLowerCase();
  const ext = extractFileExtension(typeof input.fileName === 'string' ? input.fileName : '');
  const fileSize = Number(input.fileSize ?? 0);

  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return { ok: false, error: 'Valid non-empty file size is required before upload.' };
  }

  if (mediaType === 'image') {
    const mimeOk = !mimeType || (ALLOWED_IMAGE_MIMES as readonly string[]).includes(mimeType);
    const extOk = !ext || (ALLOWED_IMAGE_EXTENSIONS as readonly string[]).includes(ext);
    if (!mimeOk || !extOk || (!mimeType && !ext)) {
      return {
        ok: false,
        error: 'Unsupported image format. Allowed formats: JPG, JPEG, PNG, and WebP.',
      };
    }
    if (fileSize > limits.maxImageBytes) {
      const maxMb = Math.round(limits.maxImageBytes / (1024 * 1024));
      return { ok: false, error: `Photo exceeds the maximum allowed size of ${maxMb} MB.` };
    }
    return {
      ok: true,
      mediaType: 'image',
      resourceType: 'image',
      scope,
      fileSize,
      clientDuration: null,
      ext: ext || 'jpg',
    };
  }

  const mimeOk = !mimeType || (ALLOWED_VIDEO_MIMES as readonly string[]).includes(mimeType);
  const extOk = !ext || (ALLOWED_VIDEO_EXTENSIONS as readonly string[]).includes(ext);
  if (!mimeOk || !extOk || (!mimeType && !ext)) {
    return {
      ok: false,
      error: 'Unsupported video format. Allowed video formats: MP4 and MOV.',
    };
  }
  if (fileSize > limits.maxVideoBytes) {
    const maxMb = Math.round(limits.maxVideoBytes / (1024 * 1024));
    return { ok: false, error: `Short video exceeds the maximum allowed size of ${maxMb} MB.` };
  }

  let clientDuration: number | null = null;
  if (input.duration !== undefined && input.duration !== null && input.duration !== '') {
    const parsedDur = Number(input.duration);
    if (!Number.isFinite(parsedDur) || parsedDur <= 0) {
      return { ok: false, error: 'Valid video duration is required.' };
    }
    if (parsedDur > limits.maxVideoDurationSec) {
      return {
        ok: false,
        error: `Video duration (${parsedDur.toFixed(1)}s) exceeds the 10-second maximum limit. Videos longer than 10 seconds are rejected and not automatically trimmed.`,
      };
    }
    clientDuration = Number(parsedDur.toFixed(2));
  }

  return {
    ok: true,
    mediaType: 'video',
    resourceType: 'video',
    scope,
    fileSize,
    clientDuration,
    ext: ext || 'mp4',
  };
}

export function isCloudinaryAssetUrlValid(rawUrl: unknown, cloudName: string): boolean {
  if (typeof rawUrl !== 'string' || !cloudName) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname.toLowerCase() !== 'res.cloudinary.com') return false;
    return parsed.pathname.startsWith(`/${cloudName}/`);
  } catch {
    return false;
  }
}

function encodePublicIdSegments(publicId: string): string {
  return publicId
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export async function fetchCloudinaryResourceMetadata(
  config: CloudinaryConfigState,
  resourceType: 'image' | 'video',
  publicId: string
): Promise<
  | {
      ok: true;
      resource: {
        public_id: string;
        resource_type: 'image' | 'video';
        format: string;
        bytes: number;
        width: number;
        height: number;
        duration?: number;
        secure_url: string;
      };
    }
  | { ok: false; status: number; error: string }
> {
  if (!config.configured) {
    return { ok: false, status: 503, error: 'Cloudinary credentials are not configured on the server.' };
  }

  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(
    config.cloudName
  )}/resources/${resourceType}/upload/${encodePublicIdSegments(publicId)}`;
  const authToken = Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64');

  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${authToken}`,
        Accept: 'application/json',
      },
    });
    if (res.status === 404) {
      return { ok: false, status: 400, error: 'Uploaded media asset could not be verified in Cloudinary.' };
    }
    if (!res.ok) {
      return { ok: false, status: 502, error: 'Unable to verify uploaded media metadata with Cloudinary right now.' };
    }
    const data = (await res.json()) as Record<string, unknown>;
    return {
      ok: true,
      resource: {
        public_id: String(data.public_id || publicId),
        resource_type: data.resource_type === 'video' ? 'video' : 'image',
        format: String(data.format || '').toLowerCase(),
        bytes: Number(data.bytes || 0),
        width: Number(data.width || 0),
        height: Number(data.height || 0),
        duration: data.duration !== undefined && data.duration !== null ? Number(data.duration) : undefined,
        secure_url: String(data.secure_url || ''),
      },
    };
  } catch {
    return { ok: false, status: 502, error: 'Cloudinary verification request failed.' };
  }
}

export async function destroyCloudinaryAsset(
  config: CloudinaryConfigState,
  resourceType: 'image' | 'video',
  publicId: string
): Promise<{ ok: boolean; result?: string }> {
  if (!config.configured || !publicId) return { ok: false };
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = generateCloudinarySignature(
    { invalidate: 'true', public_id: publicId, timestamp },
    config.apiSecret
  );
  const body = new URLSearchParams();
  body.set('public_id', publicId);
  body.set('timestamp', String(timestamp));
  body.set('api_key', config.apiKey);
  body.set('invalidate', 'true');
  body.set('signature', signature);

  try {
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/${resourceType}/destroy`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }
    );
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { result?: string };
    return { ok: true, result: data.result };
  } catch {
    return { ok: false };
  }
}

export async function verifyUploadedCloudinaryAsset(options: {
  sellerUserId: string;
  scope?: 'product' | 'shop';
  input: SubmittedMediaInput;
  limits: MediaLimits;
}): Promise<{ ok: true; media: VerifiedMediaRecord } | { ok: false; status: number; error: string }> {
  const { sellerUserId, input, limits } = options;
  const scope = options.scope === 'shop' ? 'shop' : 'product';
  const config = getCloudinaryConfigState();
  if (!config.configured) {
    return { ok: false, status: 503, error: 'Cloudinary credentials are not configured on the server.' };
  }

  const publicId = sanitizeText(input.publicId || '', 260);
  const expectedPrefix =
    scope === 'shop' ? `sofumer/shops/${sellerUserId}/` : `sofumer/products/${sellerUserId}/`;

  if (!publicId || !publicId.startsWith(expectedPrefix) || !/^[a-zA-Z0-9_/-]+$/.test(publicId)) {
    return { ok: false, status: 403, error: 'Invalid or unauthorized Cloudinary asset identifier.' };
  }

  const resourceType = input.resourceType === 'video' || input.mediaType === 'video' ? 'video' : 'image';
  if (scope === 'shop' && resourceType === 'video') {
    return { ok: false, status: 400, error: 'Shop media must be an image.' };
  }

  const sigValid = verifyCloudinaryResponseSignature(
    {
      publicId,
      version: input.version ?? '',
      signature: String(input.signature || ''),
    },
    config.apiSecret
  );
  if (!sigValid) {
    return { ok: false, status: 400, error: 'Cloudinary upload signature could not be verified.' };
  }

  const metaRes = await fetchCloudinaryResourceMetadata(config, resourceType, publicId);
  if (metaRes.ok === false) {
    return { ok: false, status: metaRes.status, error: metaRes.error };
  }
  const verified = metaRes.resource;

  if (!isCloudinaryAssetUrlValid(verified.secure_url, config.cloudName)) {
    await destroyCloudinaryAsset(config, resourceType, publicId);
    return { ok: false, status: 400, error: 'Cloudinary asset delivery URL did not match the configured cloud.' };
  }

  const actualType: 'image' | 'video' = verified.resource_type === 'video' ? 'video' : 'image';
  if (actualType !== resourceType) {
    await destroyCloudinaryAsset(config, verified.resource_type, publicId);
    return { ok: false, status: 400, error: 'Uploaded file type did not match declared media type.' };
  }

  const format = verified.format.toLowerCase();
  if (actualType === 'image') {
    if (!(ALLOWED_IMAGE_EXTENSIONS as readonly string[]).includes(format)) {
      await destroyCloudinaryAsset(config, 'image', publicId);
      return {
        ok: false,
        status: 400,
        error: `Unsupported image format "${format || 'unknown'}". Allowed formats: JPG, JPEG, PNG, and WebP.`,
      };
    }
    if (verified.bytes <= 0 || verified.bytes > limits.maxImageBytes) {
      await destroyCloudinaryAsset(config, 'image', publicId);
      const maxMb = Math.round(limits.maxImageBytes / (1024 * 1024));
      return { ok: false, status: 400, error: `Photo exceeds the maximum allowed size of ${maxMb} MB.` };
    }
  } else {
    if (!(ALLOWED_VIDEO_EXTENSIONS as readonly string[]).includes(format)) {
      await destroyCloudinaryAsset(config, 'video', publicId);
      return {
        ok: false,
        status: 400,
        error: `Unsupported video format "${format || 'unknown'}". Allowed formats: MP4 and MOV.`,
      };
    }
    if (verified.bytes <= 0 || verified.bytes > limits.maxVideoBytes) {
      await destroyCloudinaryAsset(config, 'video', publicId);
      const maxMb = Math.round(limits.maxVideoBytes / (1024 * 1024));
      return { ok: false, status: 400, error: `Video exceeds the maximum allowed size of ${maxMb} MB.` };
    }
    const dur = Number(verified.duration);
    if (!Number.isFinite(dur) || dur <= 0) {
      await destroyCloudinaryAsset(config, 'video', publicId);
      return { ok: false, status: 400, error: 'Uploaded video duration metadata is missing or invalid.' };
    }
    if (dur > limits.maxVideoDurationSec) {
      await destroyCloudinaryAsset(config, 'video', publicId);
      return {
        ok: false,
        status: 400,
        error: `Video duration (${dur.toFixed(1)}s) exceeds the maximum allowed 10 seconds. Longer videos are rejected and never auto-trimmed.`,
      };
    }
  }

  return {
    ok: true,
    media: {
      storageProvider: 'cloudinary',
      mediaType: actualType,
      resourceType: actualType,
      publicId: verified.public_id,
      secureUrl: verified.secure_url,
      format,
      bytes: verified.bytes,
      width: verified.width,
      height: verified.height,
      duration: actualType === 'video' ? Number(Number(verified.duration).toFixed(2)) : null,
      sortOrder: Math.max(0, Math.floor(Number(input.sortOrder ?? 0))),
      isPrimary: actualType === 'image' && input.isPrimary ? 1 : 0,
      altText: sanitizeText(input.altText || '', 160),
    },
  };
}

export function extractCloudinaryPublicIdFromUrl(rawUrl: unknown, cloudName: string): string {
  if (typeof rawUrl !== 'string' || !cloudName) return '';
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'res.cloudinary.com') {
      return '';
    }
    const prefix = `/${cloudName}/`;
    if (!parsed.pathname.startsWith(prefix)) return '';
    const uploadIdx = parsed.pathname.indexOf('/upload/');
    if (uploadIdx === -1) return '';
    let remainder = decodeURIComponent(parsed.pathname.slice(uploadIdx + '/upload/'.length));
    remainder = remainder.replace(/^v\d+\//, '');
    const dotIdx = remainder.lastIndexOf('.');
    const publicId = dotIdx > 0 ? remainder.slice(0, dotIdx) : remainder;
    return /^[a-zA-Z0-9_/-]+$/.test(publicId) ? publicId : '';
  } catch {
    return '';
  }
}

export async function destroyUnreferencedCloudinaryAssetsLocal(
  assets: Array<{ public_id?: string | null; resource_type?: string | null; storage_provider?: string | null }>
): Promise<void> {
  const config = getCloudinaryConfigState();
  if (!config.configured) return;
  for (const asset of assets) {
    const publicId = String(asset.public_id || '').trim();
    if (!publicId || asset.storage_provider === 'legacy_url') continue;
    const row = db
      .prepare('SELECT COUNT(*) as cnt FROM product_media WHERE public_id = ?')
      .get(publicId) as { cnt: number };
    const shopRow = db
      .prepare("SELECT COUNT(*) as cnt FROM shops WHERE status != 'closed' AND (logo_url LIKE ? OR banner_url LIKE ?)")
      .get(`%/${publicId}%`, `%/${publicId}%`) as { cnt: number };
    if ((row?.cnt ?? 0) === 0 && (shopRow?.cnt ?? 0) === 0) {
      const rType = asset.resource_type === 'video' ? 'video' : 'image';
      await destroyCloudinaryAsset(config, rType, publicId);
    }
  }
}

export async function destroyExclusiveShopCloudinaryAssetsLocal(
  urls: Array<string | null | undefined>
): Promise<void> {
  const config = getCloudinaryConfigState();
  if (!config.configured) return;

  const seen = new Set<string>();
  for (const rawUrl of urls) {
    const publicId = extractCloudinaryPublicIdFromUrl(rawUrl, config.cloudName);
    if (!publicId || !publicId.startsWith('sofumer/shops/') || seen.has(publicId)) continue;
    seen.add(publicId);
    const shopRef = db
      .prepare("SELECT COUNT(*) as cnt FROM shops WHERE status != 'closed' AND (logo_url LIKE ? OR banner_url LIKE ?)")
      .get(`%/${publicId}%`, `%/${publicId}%`) as { cnt: number };
    const mediaRef = db
      .prepare('SELECT COUNT(*) as cnt FROM product_media WHERE public_id = ?')
      .get(publicId) as { cnt: number };
    if ((shopRef?.cnt ?? 0) === 0 && (mediaRef?.cnt ?? 0) === 0) {
      await destroyCloudinaryAsset(config, 'image', publicId);
    }
  }
}

export function syncProductImagesFromMediaLocal(productId: string, fallbackAltText: string): void {
  const imgs = db
    .prepare(
      `SELECT id, secure_url, alt_text, sort_order, is_primary
       FROM product_media
       WHERE product_id = ? AND media_type = 'image'
       ORDER BY is_primary DESC, sort_order ASC, created_at ASC`
    )
    .all(productId) as Array<{ id: string; secure_url: string; alt_text: string; sort_order: number; is_primary: number }>;

  db.prepare('DELETE FROM product_images WHERE product_id = ?').run(productId);
  imgs.slice(0, MAX_PRODUCT_PHOTOS).forEach((item, idx) => {
    db.prepare(
      `INSERT INTO product_images (id, product_id, url, alt_text, sort_order, is_primary)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      newId('img'),
      productId,
      item.secure_url,
      sanitizeText(item.alt_text || fallbackAltText, 160),
      idx,
      idx === 0 ? 1 : 0
    );
  });
}
