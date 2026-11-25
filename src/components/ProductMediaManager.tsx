import { useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Film,
  ImagePlus,
  Loader2,
  RefreshCw,
  RotateCcw,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import {
  type SellerMediaConfig,
  type VerifiedMediaUpload,
  MAX_PRODUCT_PHOTOS,
  MAX_VIDEO_DURATION_SEC,
  uploadSignedMediaToCloudinary,
  validateImageFile,
  validateVideoFileAndDuration,
} from '../lib/cloudinary';
import { ImageWithFallback } from './ImageWithFallback';

export interface DraftMediaItem extends VerifiedMediaUpload {
  localKey: string;
  previewUrl?: string;
  status: 'ready' | 'uploading' | 'error';
  progress?: number;
  error?: string;
  rawFile?: File;
}

interface Props {
  items: DraftMediaItem[];
  onChange: React.Dispatch<React.SetStateAction<DraftMediaItem[]>>;
  config: SellerMediaConfig;
  configLoading?: boolean;
  configError?: string | null;
  onRetryConfig?: () => void;
  productId?: string;
  notify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

export function ProductMediaManager({
  items,
  onChange,
  config,
  configLoading = false,
  configError = null,
  onRetryConfig,
  productId,
  notify,
}: Props) {
  const [validationError, setValidationError] = useState<string>('');
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<{
    localKey: string;
    mediaType: 'image' | 'video';
    existingId?: string;
  } | null>(null);

  const photos = items.filter((item) => item.mediaType === 'image');
  const videos = items.filter((item) => item.mediaType === 'video');
  const maxImageMb = Math.round((config.maxImageBytes || 10 * 1024 * 1024) / (1024 * 1024));
  const maxVideoMb = Math.round((config.maxVideoBytes || 30 * 1024 * 1024) / (1024 * 1024));

  function updateItem(localKey: string, patch: Partial<DraftMediaItem>) {
    onChange((prev) =>
      prev.map((item) => (item.localKey === localKey ? { ...item, ...patch } : item))
    );
  }

  function removeItem(localKey: string) {
    const controller = abortControllersRef.current.get(localKey);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(localKey);
    }
    onChange((prev) => {
      const target = prev.find((i) => i.localKey === localKey);
      if (target?.previewUrl && target.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(target.previewUrl);
      }
      const next = prev.filter((i) => i.localKey !== localKey);
      const remainingPhotos = next.filter((i) => i.mediaType === 'image');
      if (remainingPhotos.length > 0 && !remainingPhotos.some((p) => p.isPrimary)) {
        const firstPhotoKey = remainingPhotos[0].localKey;
        return next.map((i) =>
          i.localKey === firstPhotoKey ? { ...i, isPrimary: true } : i
        );
      }
      return next;
    });
  }

  async function runUpload(options: {
    localKey: string;
    file: File;
    mediaType: 'image' | 'video';
    duration?: number | null;
    replaceMediaId?: string;
    makePrimaryIfFirst?: boolean;
  }) {
    const { localKey, file, mediaType, duration, replaceMediaId } = options;
    const controller = new AbortController();
    abortControllersRef.current.set(localKey, controller);

    try {
      const uploaded = await uploadSignedMediaToCloudinary({
        file,
        mediaType,
        duration,
        productId,
        replaceMediaId,
        scope: 'product',
        signal: controller.signal,
        onProgress: (pct) => {
          updateItem(localKey, { progress: pct, status: 'uploading', error: undefined });
        },
      });

      abortControllersRef.current.delete(localKey);
      onChange((prev) => {
        const hasPrimaryPhoto = prev.some(
          (p) => p.localKey !== localKey && p.mediaType === 'image' && p.isPrimary
        );
        return prev.map((item) => {
          if (item.localKey !== localKey) return item;
          if (item.previewUrl && item.previewUrl.startsWith('blob:')) {
            URL.revokeObjectURL(item.previewUrl);
          }
          return {
            ...uploaded,
            id: replaceMediaId || uploaded.id,
            localKey,
            isPrimary: mediaType === 'image' ? item.isPrimary || !hasPrimaryPhoto : false,
            status: 'ready',
            progress: 100,
            error: undefined,
            previewUrl: uploaded.secureUrl,
          };
        });
      });
    } catch (err) {
      abortControllersRef.current.delete(localKey);
      const message = err instanceof Error ? err.message : 'Upload failed.';
      if (message === 'Upload cancelled.') {
        removeItem(localKey);
        return;
      }
      updateItem(localKey, {
        status: 'error',
        progress: 0,
        error: message,
      });
      notify(message, 'error');
    }
  }

  async function handleSelectPhotos(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files || []);
    e.target.value = '';
    if (selected.length === 0) return;

    setValidationError('');

    const availableSlots = MAX_PRODUCT_PHOTOS - photos.length;
    if (availableSlots <= 0) {
      const msg = `Maximum ${MAX_PRODUCT_PHOTOS} photos allowed per product. Remove or replace an existing photo first.`;
      setValidationError(msg);
      notify(msg, 'error');
      return;
    }

    let filesToProcess = selected;
    if (selected.length > availableSlots) {
      const msg = `Maximum ${MAX_PRODUCT_PHOTOS} photos allowed per product. You can add ${availableSlots} more photo${
        availableSlots === 1 ? '' : 's'
      }; extra files were rejected.`;
      setValidationError(msg);
      notify(msg, 'error');
      filesToProcess = selected.slice(0, availableSlots);
    }

    for (const file of filesToProcess) {
      const check = validateImageFile(file, config.maxImageBytes);
      if (check.ok === false) {
        setValidationError(check.error);
        notify(check.error, 'error');
        continue;
      }
      if (!config.configured) {
        const msg = 'Cloudinary media storage is not configured on this environment.';
        setValidationError(msg);
        notify(msg, 'error');
        return;
      }

      const localKey = `draft_img_${crypto.randomUUID().slice(0, 10)}`;
      const previewUrl = URL.createObjectURL(file);
      const shouldBePrimary = photos.length === 0 && !items.some((i) => i.mediaType === 'image');

      const draft: DraftMediaItem = {
        localKey,
        storageProvider: 'cloudinary',
        mediaType: 'image',
        resourceType: 'image',
        publicId: '',
        secureUrl: '',
        format: '',
        bytes: file.size,
        width: 0,
        height: 0,
        duration: null,
        sortOrder: photos.length,
        isPrimary: shouldBePrimary,
        altText: '',
        previewUrl,
        status: 'uploading',
        progress: 5,
        rawFile: file,
      };

      onChange((prev) => [...prev, draft]);
      void runUpload({ localKey, file, mediaType: 'image' });
    }
  }

  async function handleSelectVideos(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files || []);
    e.target.value = '';
    if (selected.length === 0) return;

    setValidationError('');

    const availableSlots = config.maxVideos - videos.length;
    if (availableSlots <= 0) {
      const msg = `Maximum ${config.maxVideos} short video${config.maxVideos === 1 ? '' : 's'} allowed per product.`;
      setValidationError(msg);
      notify(msg, 'error');
      return;
    }

    let filesToProcess = selected;
    if (selected.length > availableSlots) {
      const msg = `Maximum ${config.maxVideos} short videos allowed per product.`;
      setValidationError(msg);
      notify(msg, 'error');
      filesToProcess = selected.slice(0, availableSlots);
    }

    for (const file of filesToProcess) {
      const check = await validateVideoFileAndDuration(
        file,
        config.maxVideoBytes,
        config.maxVideoDurationSec || MAX_VIDEO_DURATION_SEC
      );
      if (check.ok === false) {
        setValidationError(check.error);
        notify(check.error, 'error');
        continue;
      }
      if (!config.configured) {
        const msg = 'Cloudinary media storage is not configured on this environment.';
        setValidationError(msg);
        notify(msg, 'error');
        return;
      }

      const localKey = `draft_vid_${crypto.randomUUID().slice(0, 10)}`;
      const previewUrl = URL.createObjectURL(file);

      const draft: DraftMediaItem = {
        localKey,
        storageProvider: 'cloudinary',
        mediaType: 'video',
        resourceType: 'video',
        publicId: '',
        secureUrl: '',
        format: '',
        bytes: file.size,
        width: 0,
        height: 0,
        duration: check.duration,
        sortOrder: videos.length,
        isPrimary: false,
        altText: '',
        previewUrl,
        status: 'uploading',
        progress: 5,
        rawFile: file,
      };

      onChange((prev) => [...prev, draft]);
      void runUpload({
        localKey,
        file,
        mediaType: 'video',
        duration: check.duration,
      });
    }
  }

  function triggerReplace(item: DraftMediaItem) {
    setReplaceTarget({
      localKey: item.localKey,
      mediaType: item.mediaType,
      existingId: item.id,
    });
    if (replaceInputRef.current) {
      replaceInputRef.current.accept =
        item.mediaType === 'video'
          ? 'video/mp4,video/quicktime,.mp4,.mov'
          : 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';
      replaceInputRef.current.click();
    }
  }

  async function handleReplaceFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !replaceTarget) return;
    setValidationError('');

    const { localKey, mediaType, existingId } = replaceTarget;
    let verifiedDur: number | null = null;

    if (mediaType === 'image') {
      const check = validateImageFile(file, config.maxImageBytes);
      if (check.ok === false) {
        setValidationError(check.error);
        notify(check.error, 'error');
        return;
      }
    } else {
      const check = await validateVideoFileAndDuration(
        file,
        config.maxVideoBytes,
        config.maxVideoDurationSec || MAX_VIDEO_DURATION_SEC
      );
      if (check.ok === false) {
        setValidationError(check.error);
        notify(check.error, 'error');
        return;
      }
      verifiedDur = check.duration;
    }

    const previewUrl = URL.createObjectURL(file);
    updateItem(localKey, {
      previewUrl,
      status: 'uploading',
      progress: 5,
      error: undefined,
      duration: verifiedDur,
      bytes: file.size,
      rawFile: file,
    });

    void runUpload({
      localKey,
      file,
      mediaType,
      duration: verifiedDur,
      replaceMediaId: existingId,
    });
  }

  function movePhoto(localKey: string, direction: -1 | 1) {
    onChange((prev) => {
      const currentPhotos = prev.filter((i) => i.mediaType === 'image');
      const currentVideos = prev.filter((i) => i.mediaType === 'video');
      const idx = currentPhotos.findIndex((p) => p.localKey === localKey);
      const targetIdx = idx + direction;
      if (idx === -1 || targetIdx < 0 || targetIdx >= currentPhotos.length) return prev;
      const reordered = [...currentPhotos];
      const [moved] = reordered.splice(idx, 1);
      reordered.splice(targetIdx, 0, moved);
      return [
        ...reordered.map((p, i) => ({ ...p, sortOrder: i })),
        ...currentVideos,
      ];
    });
  }

  function setPrimaryPhoto(localKey: string) {
    onChange((prev) =>
      prev.map((item) =>
        item.mediaType === 'image'
          ? { ...item, isPrimary: item.localKey === localKey }
          : item
      )
    );
  }

  return (
    <div className="space-y-4 p-4 rounded-2xl bg-[#070B14] border border-slate-800">
      <input
        ref={replaceInputRef}
        type="file"
        onChange={handleReplaceFileSelected}
        className="hidden"
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-white">Product Photos & Short Videos</h3>
          <p className="text-xs text-slate-400">
            Up to {MAX_PRODUCT_PHOTOS} photos (JPG, PNG, WebP · max {maxImageMb} MB) and up to{' '}
            {config.maxVideos} short video{config.maxVideos === 1 ? '' : 's'} (MP4, MOV · max{' '}
            {MAX_VIDEO_DURATION_SEC}s, {maxVideoMb} MB).
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs font-mono-nums">
          <span
            className={`px-2.5 py-1 rounded-lg border ${
              photos.length >= MAX_PRODUCT_PHOTOS
                ? 'bg-amber-950/50 border-amber-700/60 text-amber-200'
                : 'bg-[#0E1525] border-slate-800 text-slate-200'
            }`}
          >
            Photos: {photos.length} / {MAX_PRODUCT_PHOTOS}
          </span>
          <span className="px-2.5 py-1 rounded-lg bg-[#0E1525] border border-slate-800 text-slate-200">
            Videos: {videos.length} / {config.maxVideos}
          </span>
        </div>
      </div>

      {configLoading ? (
        <div className="p-3 rounded-xl bg-[#0E1525] border border-slate-800 text-xs text-slate-300 flex items-center gap-2">
          <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
          <span>Checking Cloudinary media configuration...</span>
        </div>
      ) : configError ? (
        <div className="p-3 rounded-xl bg-red-950/40 border border-red-700/60 text-xs text-red-200 flex items-center justify-between gap-2">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>Could not load Cloudinary upload configuration: {configError}</span>
          </div>
          {onRetryConfig && (
            <button
              type="button"
              onClick={onRetryConfig}
              className="h-7 px-2.5 rounded-lg bg-red-800/70 hover:bg-red-700 text-white font-medium shrink-0"
            >
              Retry
            </button>
          )}
        </div>
      ) : !config.configured ? (
        <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-700/60 text-xs text-amber-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Cloudinary media uploads are not available on this environment yet. Check CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in Worker settings.
          </span>
        </div>
      ) : null}

      {validationError && (
        <div className="p-3 rounded-xl bg-red-950/50 border border-red-700/70 text-xs text-red-200 flex items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{validationError}</span>
          </div>
          <button
            type="button"
            onClick={() => setValidationError('')}
            aria-label="Dismiss error"
            className="text-red-300 hover:text-white shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Product Photos Grid */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-slate-200">
            Product Photos ({photos.length} / {MAX_PRODUCT_PHOTOS})
          </span>
          <span className="text-slate-400">Select one cover photo and reorder with arrows</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {photos.map((photo, idx) => (
            <div
              key={photo.localKey}
              className={`rounded-xl overflow-hidden border bg-[#0E1525] flex flex-col ${
                photo.isPrimary ? 'border-blue-500' : 'border-slate-800'
              }`}
            >
              <div className="relative aspect-[4/3] bg-black/40">
                <ImageWithFallback
                  src={photo.previewUrl || photo.secureUrl}
                  alt={`Product photo ${idx + 1}`}
                  className="w-full h-full object-cover"
                />

                {photo.isPrimary && (
                  <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-blue-600 text-[10px] font-semibold text-white">
                    Primary
                  </span>
                )}

                {photo.status === 'uploading' && (
                  <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center p-2 gap-1.5">
                    <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
                    <span className="text-[11px] font-mono-nums text-white">
                      {photo.progress ?? 0}%
                    </span>
                    <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-blue-500 transition-all"
                        style={{ width: `${photo.progress ?? 5}%` }}
                      />
                    </div>
                  </div>
                )}

                {photo.status === 'error' && (
                  <div className="absolute inset-0 bg-red-950/85 p-2 flex flex-col items-center justify-center text-center gap-1.5">
                    <span className="text-[11px] text-red-100 line-clamp-2">
                      {photo.error || 'Upload failed'}
                    </span>
                    {photo.rawFile && (
                      <button
                        type="button"
                        onClick={() => {
                          updateItem(photo.localKey, { status: 'uploading', progress: 5, error: undefined });
                          void runUpload({
                            localKey: photo.localKey,
                            file: photo.rawFile!,
                            mediaType: 'image',
                          });
                        }}
                        className="px-2 py-1 rounded bg-red-700 text-white text-[11px] flex items-center gap-1"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>Retry</span>
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="p-1.5 flex items-center justify-between gap-1 border-t border-slate-800/80">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    disabled={idx === 0 || photo.status === 'uploading'}
                    onClick={() => movePhoto(photo.localKey, -1)}
                    aria-label="Move photo left"
                    className="w-7 h-7 rounded flex items-center justify-center text-slate-300 hover:bg-slate-800 disabled:opacity-30"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={idx === photos.length - 1 || photo.status === 'uploading'}
                    onClick={() => movePhoto(photo.localKey, 1)}
                    aria-label="Move photo right"
                    className="w-7 h-7 rounded flex items-center justify-center text-slate-300 hover:bg-slate-800 disabled:opacity-30"
                  >
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={photo.status === 'uploading'}
                    onClick={() => setPrimaryPhoto(photo.localKey)}
                    aria-label="Set as primary photo"
                    title="Set primary photo"
                    className={`w-7 h-7 rounded flex items-center justify-center ${
                      photo.isPrimary
                        ? 'text-blue-400 bg-blue-950/60'
                        : 'text-slate-400 hover:text-white hover:bg-slate-800'
                    }`}
                  >
                    <Star className={`w-3.5 h-3.5 ${photo.isPrimary ? 'fill-blue-400' : ''}`} />
                  </button>
                </div>

                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    disabled={photo.status === 'uploading'}
                    onClick={() => triggerReplace(photo)}
                    aria-label="Replace photo"
                    title="Replace photo"
                    className="w-7 h-7 rounded flex items-center justify-center text-slate-300 hover:bg-slate-800 disabled:opacity-30"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeItem(photo.localKey)}
                    aria-label="Remove photo"
                    title={photo.status === 'uploading' ? 'Cancel upload' : 'Remove photo'}
                    className="w-7 h-7 rounded flex items-center justify-center text-red-400 hover:bg-red-950/50"
                  >
                    {photo.status === 'uploading' ? (
                      <X className="w-3.5 h-3.5" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          ))}

          {photos.length < MAX_PRODUCT_PHOTOS && (
            <label className="aspect-[4/3] rounded-xl border border-dashed border-slate-700 hover:border-blue-500 bg-[#0E1525]/60 flex flex-col items-center justify-center p-3 text-center cursor-pointer transition-colors">
              <ImagePlus className="w-6 h-6 text-blue-400 mb-1.5" />
              <span className="text-xs font-medium text-slate-200">Add Photos</span>
              <span className="text-[11px] text-slate-400 mt-0.5">
                {MAX_PRODUCT_PHOTOS - photos.length} slot{MAX_PRODUCT_PHOTOS - photos.length === 1 ? '' : 's'} left
              </span>
              <input
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                onChange={handleSelectPhotos}
                className="hidden"
              />
            </label>
          )}
        </div>
      </div>

      {/* Product Short Videos */}
      <div className="pt-3 border-t border-slate-800/80 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-medium text-slate-200">
            Short Product Videos ({videos.length} / {config.maxVideos})
          </span>
          <span className="text-amber-300 font-medium">
            Maximum {MAX_VIDEO_DURATION_SEC} seconds · MP4 / MOV only
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {videos.map((vid, idx) => (
            <div
              key={vid.localKey}
              className="rounded-xl overflow-hidden border border-slate-800 bg-[#0E1525] flex flex-col"
            >
              <div className="relative aspect-video bg-black">
                <video
                  src={vid.previewUrl || vid.secureUrl}
                  controls
                  playsInline
                  preload="metadata"
                  className="w-full h-full object-contain"
                />
                {vid.duration !== null && (
                  <span className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/75 border border-slate-700 text-[11px] font-mono-nums text-white">
                    {vid.duration.toFixed(1)}s
                  </span>
                )}
                {vid.status === 'uploading' && (
                  <div className="absolute inset-0 bg-black/75 flex flex-col items-center justify-center p-4 gap-2">
                    <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
                    <span className="text-xs font-mono-nums text-white">
                      Uploading video... {vid.progress ?? 0}%
                    </span>
                    <div className="w-3/4 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-blue-500 transition-all"
                        style={{ width: `${vid.progress ?? 5}%` }}
                      />
                    </div>
                  </div>
                )}
                {vid.status === 'error' && (
                  <div className="absolute inset-0 bg-red-950/90 p-3 flex flex-col items-center justify-center text-center gap-2">
                    <span className="text-xs text-red-100">{vid.error || 'Video upload failed'}</span>
                    {vid.rawFile && (
                      <button
                        type="button"
                        onClick={() => {
                          updateItem(vid.localKey, { status: 'uploading', progress: 5, error: undefined });
                          void runUpload({
                            localKey: vid.localKey,
                            file: vid.rawFile!,
                            mediaType: 'video',
                            duration: vid.duration,
                          });
                        }}
                        className="px-2.5 py-1 rounded bg-red-700 text-white text-xs flex items-center gap-1"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Retry</span>
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="p-2 flex items-center justify-between gap-2 border-t border-slate-800/80 text-xs">
                <span className="text-slate-300 truncate">
                  Video {idx + 1} {vid.format ? `(${vid.format.toUpperCase()})` : ''}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    disabled={vid.status === 'uploading'}
                    onClick={() => triggerReplace(vid)}
                    className="h-8 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-slate-200 hover:border-slate-700 flex items-center gap-1 disabled:opacity-40"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Replace</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeItem(vid.localKey)}
                    className="h-8 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-red-400 hover:bg-red-950/40 flex items-center gap-1"
                  >
                    {vid.status === 'uploading' ? (
                      <>
                        <X className="w-3.5 h-3.5" />
                        <span>Cancel</span>
                      </>
                    ) : (
                      <>
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Remove</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          ))}

          {videos.length < config.maxVideos && (
            <label className="aspect-video rounded-xl border border-dashed border-slate-700 hover:border-blue-500 bg-[#0E1525]/60 flex flex-col items-center justify-center p-4 text-center cursor-pointer transition-colors">
              <Film className="w-6 h-6 text-blue-400 mb-1.5" />
              <span className="text-xs font-medium text-slate-200">Add Short Video (Max 10s)</span>
              <span className="text-[11px] text-slate-400 mt-0.5">
                MP4 or MOV · {config.maxVideos - videos.length} slot left
              </span>
              <input
                type="file"
                accept="video/mp4,video/quicktime,.mp4,.mov"
                onChange={handleSelectVideos}
                className="hidden"
              />
            </label>
          )}
        </div>
      </div>
    </div>
  );
}
