---
created: 2026-04-09
system: cap
status: approved
target_agent: worktree
acceptance_criteria:
  - "Does resolvePlaybackSource return an isStale flag when the probe indicates the URL may have expired (e.g., redirected presigned URL with an old timestamp)?"
  - "Does the video element error handler in CapVideoPlayer attempt to re-resolve the mp4 source before falling back to raw?"
  - "Does the re-resolve attempt invalidate the React Query cache for resolvedSrc so a fresh presigned URL is fetched?"
  - "Does the 'Optimizing video' badge only show when there is genuine upload processing activity, not due to URL expiry fallback?"
  - "After a successful re-resolve, does the player load the fresh URL without showing the raw fallback badge?"
  - "Does the site.webmanifest file contain valid JSON that the browser can parse without errors?"
depends_on:
supersedes:
repos:
  - Cap
---

# Fix Stale Presigned URL and False Optimizing State

## Problem

Video presigned URLs from R2 have a 1-hour TTL. When a user leaves a tab open longer than that, the URL expires and the `<video>` element fires an error event. The current error handler in `CapVideoPlayer.tsx` responds by falling back to the raw source, which (a) is lower quality and (b) triggers the "Optimizing video" badge even though the video is fully processed. The real problem is just that the presigned URL expired, not that the video is still being optimized.

Two distinct user-facing bugs result:
1. **Stale URL (Bug 2):** The video stops playing after ~1 hour in a background tab because the presigned URL expired. The player falls back to raw or shows an error instead of transparently refreshing.
2. **False "Optimizing video" (Bug 3):** When the fallback to raw succeeds, the badge says "Optimizing video" even though the video is fully processed. The UI incorrectly infers optimization state from URL fetch failure.

Additionally, the console shows `site.webmanifest:1 Manifest: Line: 1, column: 1, Syntax error.` on every page load because the webmanifest has empty `name` and `short_name` fields, which Chrome treats as a parse error.

## Design

Three changes to the video player pipeline, plus one static asset fix:

### 1. playback-source.ts: presigned URL expiry detection and safe probing

Add an `isStale` boolean and `resolvedAt` timestamp to `ResolvedPlaybackSource`. During probe resolution, parse the presigned URL parameters (`X-Amz-Date` and `X-Amz-Expires`) from the final URL (after redirect) to compute whether the URL has already expired or is about to expire. The `isSourcePotentiallyStale` helper checks `source.isStale` first (authoritative, based on actual URL expiry data) and falls back to a `resolvedAt` age check (45 minutes) as a safety net.

Replace the `appendCacheBust` approach with `cache: "no-store"` on the fetch request. This avoids mutating the URL, which would invalidate the signature on presigned URLs. Non-presigned URLs also benefit since `cache: "no-store"` achieves the same cache-busting effect without URL mutation.

Add an `isPresignedUrl` helper that checks for `X-Amz-Signature` in the URL's query parameters.

### 2. CapVideoPlayer.tsx: re-resolve before falling back to raw, with repeatable refresh

Change the video element's `handleError` to check whether the current mp4 source is potentially stale. If so, invalidate the `resolvedSrc` query (which triggers a fresh probe with a new presigned URL) instead of immediately falling back to raw. Only fall back to raw if the re-resolved mp4 source also fails.

Track a `hasTriedRefresh` state alongside the existing `hasTriedRawFallback`. The error handling sequence becomes:
1. First mp4 error with stale source: set `hasTriedRefresh`, invalidate query (get fresh URL)
2. Second mp4 error after refresh: fall back to raw (existing behavior)
3. Raw error: show error overlay (existing behavior)

Reset `hasTriedRefresh` when a new resolved source arrives (detected by `resolvedSrc.data?.resolvedAt` changing), but only if the new source is NOT stale. If the server returns a cached/stale presigned URL after a refresh attempt, `hasTriedRefresh` remains `true`, which prevents an infinite refresh loop and allows the normal fallback-to-raw path to proceed on the next error. This allows future expirations (after a successful fresh URL is loaded) to trigger another refresh cycle instead of being a one-shot mechanism.

### 3. site.webmanifest: fix empty name fields

Populate `name` and `short_name` with "Cap" so Chrome's manifest parser accepts the file without errors.

## Acceptance Criteria

- [ ] Does resolvePlaybackSource return an isStale flag when the probe indicates the URL may have expired (e.g., redirected presigned URL with an old timestamp)?
- [ ] Does the video element error handler in CapVideoPlayer attempt to re-resolve the mp4 source before falling back to raw?
- [ ] Does the re-resolve attempt invalidate the React Query cache for resolvedSrc so a fresh presigned URL is fetched?
- [ ] Does the "Optimizing video" badge only show when there is genuine upload processing activity, not due to URL expiry fallback?
- [ ] After a successful re-resolve, does the player load the fresh URL without showing the raw fallback badge?
- [ ] Does the site.webmanifest file contain valid JSON that the browser can parse without errors?

## Implementation

### `apps/web/app/s/[videoId]/_components/playback-source.ts`

```typescript
"use client";

export type ResolvedPlaybackSource = {
	url: string;
	type: "mp4" | "raw";
	supportsCrossOrigin: boolean;
	resolvedAt: number;
	isStale: boolean;
};

type ProbeResult = {
	url: string;
	response: Response;
};

type ResolvePlaybackSourceInput = {
	videoSrc: string;
	rawFallbackSrc?: string;
	enableCrossOrigin?: boolean;
	fetchImpl?: typeof fetch;
	now?: () => number;
	createVideoElement?: () => Pick<HTMLVideoElement, "canPlayType">;
	preferredSource?: "mp4" | "raw";
};

const PRESIGNED_URL_STALE_MS = 45 * 60 * 1000;

const PRESIGNED_URL_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export function isPresignedUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.searchParams.has("X-Amz-Signature");
	} catch {
		return false;
	}
}

function getPresignedUrlExpiresAt(url: string): number | null {
	try {
		const parsed = new URL(url);
		const amzDate = parsed.searchParams.get("X-Amz-Date");
		const amzExpires = parsed.searchParams.get("X-Amz-Expires");

		if (!amzDate || !amzExpires) {
			return null;
		}

		const year = amzDate.substring(0, 4);
		const month = amzDate.substring(4, 6);
		const day = amzDate.substring(6, 8);
		const hour = amzDate.substring(9, 11);
		const minute = amzDate.substring(11, 13);
		const second = amzDate.substring(13, 15);
		const signedAtMs = Date.parse(
			`${year}-${month}-${day}T${hour}:${minute}:${second}Z`,
		);

		if (Number.isNaN(signedAtMs)) {
			return null;
		}

		const expiresInSeconds = Number.parseInt(amzExpires, 10);
		if (Number.isNaN(expiresInSeconds)) {
			return null;
		}

		return signedAtMs + expiresInSeconds * 1000;
	} catch {
		return null;
	}
}

function computeIsStale(url: string, now: number): boolean {
	const expiresAt = getPresignedUrlExpiresAt(url);
	if (expiresAt !== null) {
		return now >= expiresAt - PRESIGNED_URL_EXPIRY_BUFFER_MS;
	}
	return false;
}

export function isSourcePotentiallyStale(
	source: ResolvedPlaybackSource | null | undefined,
	now: number = Date.now(),
): boolean {
	if (!source) return false;
	if (source.isStale) return true;
	return now - source.resolvedAt > PRESIGNED_URL_STALE_MS;
}

function isPlayableProbeResponse(response: Response): boolean {
	return response.ok || response.status === 206;
}

function isWebMContentType(contentType: string, url: string): boolean {
	return (
		contentType.toLowerCase().includes("video/webm") ||
		/\.webm(?:$|[?#])/i.test(url)
	);
}

async function probePlaybackSource(
	url: string,
	fetchImpl: typeof fetch,
	now: () => number,
): Promise<ProbeResult | null> {
	try {
		const response = await fetchImpl(url, {
			headers: { range: "bytes=0-0" },
			cache: "no-store",
		});

		if (!isPlayableProbeResponse(response)) {
			return null;
		}

		return {
			url: response.redirected ? response.url : url,
			response,
		};
	} catch {
		return null;
	}
}

export function detectCrossOriginSupport(url: string): boolean {
	return true;
}

export function canPlayRawContentType(
	contentType: string,
	url: string,
	createVideoElement: () => Pick<HTMLVideoElement, "canPlayType"> = () =>
		document.createElement("video"),
): boolean {
	if (!isWebMContentType(contentType, url)) {
		return true;
	}

	const video = createVideoElement();
	return (
		video.canPlayType(contentType) !== "" ||
		video.canPlayType("video/webm") !== ""
	);
}

export function shouldFallbackToRawPlaybackSource(
	resolvedSourceType: ResolvedPlaybackSource["type"] | null | undefined,
	rawFallbackSrc: string | undefined,
	hasTriedRawFallback: boolean,
): boolean {
	return Boolean(
		rawFallbackSrc && resolvedSourceType === "mp4" && !hasTriedRawFallback,
	);
}

export async function resolvePlaybackSource({
	videoSrc,
	rawFallbackSrc,
	enableCrossOrigin = false,
	fetchImpl = fetch,
	now = () => Date.now(),
	createVideoElement,
	preferredSource = "mp4",
}: ResolvePlaybackSourceInput): Promise<ResolvedPlaybackSource | null> {
	const resolvedAt = now();

	const resolveRaw = async (): Promise<ResolvedPlaybackSource | null> => {
		if (!rawFallbackSrc) {
			return null;
		}

		const rawResult = await probePlaybackSource(rawFallbackSrc, fetchImpl, now);

		if (!rawResult) {
			return null;
		}

		const contentType = rawResult.response.headers.get("content-type") ?? "";

		if (
			!canPlayRawContentType(contentType, rawResult.url, createVideoElement)
		) {
			return null;
		}

		return {
			url: rawResult.url,
			type: "raw",
			supportsCrossOrigin:
				enableCrossOrigin && detectCrossOriginSupport(rawResult.url),
			resolvedAt,
			isStale: computeIsStale(rawResult.url, resolvedAt),
		};
	};

	if (preferredSource === "raw") {
		return await resolveRaw();
	}

	const mp4Result = await probePlaybackSource(videoSrc, fetchImpl, now);

	if (mp4Result) {
		return {
			url: mp4Result.url,
			type: "mp4",
			supportsCrossOrigin:
				enableCrossOrigin && detectCrossOriginSupport(mp4Result.url),
			resolvedAt,
			isStale: computeIsStale(mp4Result.url, resolvedAt),
		};
	}

	return await resolveRaw();
}
```

### `apps/web/app/s/[videoId]/_components/CapVideoPlayer.tsx`

```tsx
"use client";

import { LogoSpinner } from "@cap/ui";
import { calculateStrokeDashoffset, getProgressCircleConfig } from "@cap/utils";
import type { Video } from "@cap/web-domain";
import { faPlay } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangleIcon, InfoIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { retryVideoProcessing } from "@/actions/video/retry-processing";
import CommentStamp from "./CommentStamp";
import {
	canRetryFailedProcessing,
	getUploadFailureMessage,
	shouldDeferPlaybackSource,
	shouldReloadPlaybackAfterUploadCompletes,
	useUploadProgress,
} from "./ProgressCircle";
import {
	type ResolvedPlaybackSource,
	isSourcePotentiallyStale,
	resolvePlaybackSource,
	shouldFallbackToRawPlaybackSource,
} from "./playback-source";
import {
	MediaPlayer,
	MediaPlayerCaptions,
	MediaPlayerControls,
	MediaPlayerControlsOverlay,
	MediaPlayerError,
	MediaPlayerFullscreen,
	MediaPlayerLoading,
	MediaPlayerPiP,
	MediaPlayerPlay,
	MediaPlayerSeek,
	MediaPlayerSeekBackward,
	MediaPlayerSeekForward,
	MediaPlayerSettings,
	MediaPlayerTime,
	MediaPlayerVideo,
	MediaPlayerVolume,
	MediaPlayerVolumeIndicator,
} from "./video/media-player";
import { Tooltip, TooltipContent, TooltipTrigger } from "./video/tooltip";

const { circumference } = getProgressCircleConfig();

const PLACEHOLDER_SVG = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="224" height="128"><rect fill="%231f2937" width="224" height="128"/></svg>')}`;

const ERROR_SVG = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="224" height="128"><rect fill="%23dc2626" width="224" height="128"/></svg>')}`;

function getProgressStatusText(
	status: "uploading" | "processing" | "generating_thumbnail",
) {
	switch (status) {
		case "processing":
			return "Processing";
		case "generating_thumbnail":
			return "Finishing up";
		default:
			return "Uploading";
	}
}

type EnhancedAudioStatus = "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED";

interface CaptionOption {
	code: string;
	name: string;
}

interface Props {
	videoSrc: string;
	rawFallbackSrc?: string;
	videoId: Video.VideoId;
	chaptersSrc: string;
	captionsSrc: string;
	disableCaptions?: boolean;
	videoRef: React.RefObject<HTMLVideoElement | null>;
	mediaPlayerClassName?: string;
	autoplay?: boolean;
	enableCrossOrigin?: boolean;
	hasActiveUpload: boolean | undefined;
	disableCommentStamps?: boolean;
	disableReactionStamps?: boolean;
	comments?: Array<{
		id: string;
		timestamp: number | null;
		type: "text" | "emoji";
		content: string;
		authorName?: string | null;
	}>;
	onSeek?: (time: number) => void;
	enhancedAudioUrl?: string | null;
	enhancedAudioStatus?: EnhancedAudioStatus | null;
	captionLanguage?: string;
	onCaptionLanguageChange?: (language: string) => void;
	availableCaptions?: CaptionOption[];
	isCaptionLoading?: boolean;
	hasCaptions?: boolean;
	canRetryProcessing?: boolean;
	duration?: number | null;
	showPlaybackStatusBadge?: boolean;
}

export function CapVideoPlayer({
	videoSrc,
	rawFallbackSrc,
	videoId,
	chaptersSrc,
	captionsSrc,
	disableCaptions,
	videoRef,
	mediaPlayerClassName,
	autoplay = false,
	enableCrossOrigin = false,
	hasActiveUpload,
	comments = [],
	disableCommentStamps = false,
	disableReactionStamps = false,
	onSeek,
	enhancedAudioUrl: _enhancedAudioUrl,
	enhancedAudioStatus: _enhancedAudioStatus,
	captionLanguage,
	onCaptionLanguageChange,
	availableCaptions = [],
	isCaptionLoading = false,
	hasCaptions = false,
	canRetryProcessing = false,
	duration: fallbackDuration,
	showPlaybackStatusBadge = false,
}: Props) {
	const [currentCue, setCurrentCue] = useState<string>("");
	const [controlsVisible, setControlsVisible] = useState(false);
	const [mainControlsVisible, setMainControlsVisible] = useState(false);
	const [toggleCaptions, setToggleCaptions] = useState(true);
	const [showPlayButton, setShowPlayButton] = useState(false);
	const [videoLoaded, setVideoLoaded] = useState(false);
	const [hasPlayedOnce, setHasPlayedOnce] = useState(false);
	const [isMobile, setIsMobile] = useState(false);
	const [hasError, setHasError] = useState(false);
	const [autoRetryCount, setAutoRetryCount] = useState(0);
	const [isRetryingProcessing, setIsRetryingProcessing] = useState(false);
	const [playerDuration, setPlayerDuration] = useState(fallbackDuration ?? 0);
	const [preferredSource, setPreferredSource] = useState<"mp4" | "raw">("mp4");
	const [hasTriedRawFallback, setHasTriedRawFallback] = useState(false);
	const [hasTriedRefresh, setHasTriedRefresh] = useState(false);
	const queryClient = useQueryClient();

	const previewVideoRef = useRef<HTMLVideoElement>(null);
	const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
	const scrubThumbnailRef = useRef<{
		time: number;
		src: string;
		videoUrl: string;
	} | null>(null);
	const pendingPreviewSeekRef = useRef<number | null>(null);
	const isMountedRef = useRef(true);
	const [, setScrubThumbnailVersion] = useState(0);

	useEffect(() => {
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	useEffect(() => {
		const checkMobile = () => {
			setIsMobile(window.innerWidth < 640);
		};

		checkMobile();
		window.addEventListener("resize", checkMobile);

		return () => window.removeEventListener("resize", checkMobile);
	}, []);

	const uploadProgressRaw = useUploadProgress(
		videoId,
		hasActiveUpload || false,
	);
	const uploadProgress = videoLoaded ? null : uploadProgressRaw;
	const isUploading = uploadProgress?.status === "uploading";
	const isProcessing = uploadProgress?.status === "processing";
	const isGeneratingThumbnail =
		uploadProgress?.status === "generating_thumbnail";
	const hasActiveProgress =
		isUploading || isProcessing || isGeneratingThumbnail;
	const shouldDeferResolvedSource = shouldDeferPlaybackSource(uploadProgress);

	const resolvedSrc = useQuery<ResolvedPlaybackSource | null>({
		queryKey: [
			"resolvedSrc",
			videoSrc,
			rawFallbackSrc,
			enableCrossOrigin,
			preferredSource,
		],
		queryFn: shouldDeferResolvedSource
			? skipToken
			: () =>
					resolvePlaybackSource({
						videoSrc,
						rawFallbackSrc,
						enableCrossOrigin,
						preferredSource,
					}),
		refetchOnWindowFocus: false,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});

	useEffect(() => {
		void videoSrc;
		void rawFallbackSrc;
		setVideoLoaded(false);
		setHasError(false);
		setShowPlayButton(false);
		setPreferredSource("mp4");
		setHasTriedRawFallback(false);
		setHasTriedRefresh(false);
	}, [videoSrc, rawFallbackSrc]);

	const prevResolvedAtRef = useRef<number | undefined>(undefined);
	useEffect(() => {
		const currentResolvedAt = resolvedSrc.data?.resolvedAt;
		if (
			currentResolvedAt !== undefined &&
			prevResolvedAtRef.current !== undefined &&
			currentResolvedAt !== prevResolvedAtRef.current &&
			resolvedSrc.data?.type === "mp4" &&
			!isSourcePotentiallyStale(resolvedSrc.data)
		) {
			setHasTriedRefresh(false);
		}
		prevResolvedAtRef.current = currentResolvedAt;
	}, [resolvedSrc.data?.resolvedAt, resolvedSrc.data?.type, resolvedSrc.data]);

	useEffect(() => {
		setPlayerDuration(fallbackDuration ?? 0);
	}, [fallbackDuration]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;

		const handleLoadedMetadata = () => {
			if (Number.isFinite(video.duration) && video.duration > 0) {
				setPlayerDuration(video.duration);
			}
		};

		if (Number.isFinite(video.duration) && video.duration > 0) {
			setPlayerDuration(video.duration);
		}

		video.addEventListener("loadedmetadata", handleLoadedMetadata);

		return () => {
			video.removeEventListener("loadedmetadata", handleLoadedMetadata);
		};
	}, [videoRef]);

	const [markersReady, setMarkersReady] = useState(false);
	const [hoveredComment, setHoveredComment] = useState<string | null>(null);

	const handleMouseEnter = useCallback((commentId: string) => {
		setHoveredComment(commentId);
	}, []);

	const handleMouseLeave = useCallback(() => {
		setHoveredComment(null);
	}, []);

	useEffect(() => {
		if (playerDuration > 0 && comments.length > 0 && videoRef.current) {
			setMarkersReady(true);
		}
	}, [playerDuration, comments.length, videoRef.current]);

	useEffect(() => {
		if (resolvedSrc.data) {
			setHasError(false);
			setAutoRetryCount(0);
			return;
		}

		if (uploadProgress || resolvedSrc.isPending) {
			setHasError(false);
			return;
		}

		if (resolvedSrc.isSuccess) {
			setHasError(true);
		}
	}, [
		resolvedSrc.data,
		resolvedSrc.isPending,
		resolvedSrc.isSuccess,
		uploadProgress,
	]);

	useEffect(() => {
		if (!hasError || autoRetryCount >= 5) return;

		const timer = setTimeout(() => {
			setAutoRetryCount((c) => c + 1);
			setHasError(false);
			setVideoLoaded(false);
			setHasTriedRawFallback(false);
			setHasTriedRefresh(false);
			setPreferredSource("mp4");
			queryClient.invalidateQueries({
				queryKey: ["resolvedSrc"],
			});
		}, 3000);

		return () => clearTimeout(timer);
	}, [hasError, autoRetryCount, queryClient]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || resolvedSrc.isPending) return;

		const handleLoadedData = () => {
			setVideoLoaded(true);
			setHasError(false);
			if (!hasPlayedOnce) {
				setShowPlayButton(true);
			}
		};

		const handleCanPlay = () => {
			setVideoLoaded(true);
			setHasError(false);
			if (!hasPlayedOnce) {
				setShowPlayButton(true);
			}
		};

		const handlePlay = () => {
			setHasPlayedOnce(true);
		};

		const handleError = () => {
			const sourceIsStale = isSourcePotentiallyStale(resolvedSrc.data);

			if (
				resolvedSrc.data?.type === "mp4" &&
				sourceIsStale &&
				!hasTriedRefresh
			) {
				setHasTriedRefresh(true);
				setVideoLoaded(false);
				setHasError(false);
				setShowPlayButton(false);
				queryClient.invalidateQueries({
					queryKey: [
						"resolvedSrc",
						videoSrc,
						rawFallbackSrc,
						enableCrossOrigin,
						preferredSource,
					],
				});
				return;
			}

			if (
				shouldFallbackToRawPlaybackSource(
					resolvedSrc.data?.type,
					rawFallbackSrc,
					hasTriedRawFallback,
				)
			) {
				setHasTriedRawFallback(true);
				setPreferredSource("raw");
				setVideoLoaded(false);
				setHasError(false);
				setShowPlayButton(false);
				return;
			}

			setHasError(true);
		};

		let captionTrack: TextTrack | null = null;

		const handleCueChange = (): void => {
			if (captionTrack?.activeCues && captionTrack.activeCues.length > 0) {
				const cue = captionTrack.activeCues[0] as VTTCue;
				const plainText = cue.text.replace(/<[^>]*>/g, "");
				setCurrentCue(plainText);
			} else {
				setCurrentCue("");
			}
		};

		const setupTracks = (): void => {
			const tracks = Array.from(video.textTracks);

			for (const track of tracks) {
				if (track.kind === "captions" || track.kind === "subtitles") {
					captionTrack = track;
					track.mode = "hidden";
					track.addEventListener("cuechange", handleCueChange);
					break;
				}
			}
		};

		const ensureTracksHidden = (): void => {
			const tracks = Array.from(video.textTracks);
			for (const track of tracks) {
				if (track.kind === "captions" || track.kind === "subtitles") {
					if (track.mode !== "hidden") {
						track.mode = "hidden";
					}
				}
			}
		};

		const handleLoadedMetadataWithTracks = () => {
			setVideoLoaded(true);
			setHasError(false);
			if (!hasPlayedOnce) {
				setShowPlayButton(true);
			}
			setupTracks();
		};

		const handleTrackChange = () => {
			ensureTracksHidden();
			setupTracks();
		};

		video.addEventListener("loadeddata", handleLoadedData);
		video.addEventListener("canplay", handleCanPlay);
		video.addEventListener("loadedmetadata", handleLoadedMetadataWithTracks);
		video.addEventListener("play", handlePlay);
		video.addEventListener("error", handleError as EventListener);

		video.textTracks.addEventListener("change", handleTrackChange);
		video.textTracks.addEventListener("addtrack", handleTrackChange);
		video.textTracks.addEventListener("removetrack", handleTrackChange);

		if (video.readyState === 4) {
			handleLoadedData();
		}

		return () => {
			video.removeEventListener("loadeddata", handleLoadedData);
			video.removeEventListener("canplay", handleCanPlay);
			video.removeEventListener("play", handlePlay);
			video.removeEventListener("error", handleError as EventListener);
			video.removeEventListener(
				"loadedmetadata",
				handleLoadedMetadataWithTracks,
			);
			video.textTracks.removeEventListener("change", handleTrackChange);
			video.textTracks.removeEventListener("addtrack", handleTrackChange);
			video.textTracks.removeEventListener("removetrack", handleTrackChange);
			if (captionTrack) {
				captionTrack.removeEventListener("cuechange", handleCueChange);
			}
		};
	}, [
		enableCrossOrigin,
		hasPlayedOnce,
		hasTriedRawFallback,
		hasTriedRefresh,
		preferredSource,
		queryClient,
		rawFallbackSrc,
		resolvedSrc.data,
		resolvedSrc.isPending,
		videoRef.current,
		videoSrc,
	]);

	const generateVideoFrameThumbnail = useCallback(
		(time: number): string => {
			const currentVideoUrl = resolvedSrc.data?.url ?? "";
			const cached = scrubThumbnailRef.current;
			if (
				cached &&
				Math.abs(cached.time - time) < 0.01 &&
				cached.videoUrl === currentVideoUrl
			) {
				return cached.src;
			}

			const preview = previewVideoRef.current;
			if (!preview || preview.readyState < 1) {
				return PLACEHOLDER_SVG;
			}

			if (
				pendingPreviewSeekRef.current !== null &&
				Math.abs(pendingPreviewSeekRef.current - time) < 0.01
			) {
				if (cached && cached.videoUrl === currentVideoUrl) {
					return cached.src;
				}
				return PLACEHOLDER_SVG;
			}

			pendingPreviewSeekRef.current = time;

			const seekAndCapture = () => {
				const cleanup = () => {
					clearTimeout(seekTimeout);
					preview.removeEventListener("seeked", onSeeked);
					preview.removeEventListener("error", onError);
				};

				const onSeeked = () => {
					cleanup();

					if (!isMountedRef.current) return;

					if (!previewCanvasRef.current) {
						previewCanvasRef.current = document.createElement("canvas");
					}
					const canvas = previewCanvasRef.current;
					canvas.width = 224;
					canvas.height = 128;
					const ctx = canvas.getContext("2d");

					if (ctx) {
						try {
							ctx.drawImage(preview, 0, 0, canvas.width, canvas.height);
							const src = canvas.toDataURL("image/jpeg", 0.8);
							scrubThumbnailRef.current = {
								time,
								src,
								videoUrl: currentVideoUrl,
							};
						} catch (_e) {
							scrubThumbnailRef.current = {
								time,
								src: ERROR_SVG,
								videoUrl: currentVideoUrl,
							};
						}
					}

					pendingPreviewSeekRef.current = null;
					setScrubThumbnailVersion((v) => v + 1);
				};

				const onError = () => {
					cleanup();
					pendingPreviewSeekRef.current = null;
				};

				const seekTimeout = setTimeout(() => {
					preview.removeEventListener("seeked", onSeeked);
					preview.removeEventListener("error", onError);
					pendingPreviewSeekRef.current = null;
				}, 3000);

				preview.addEventListener("seeked", onSeeked, { once: true });
				preview.addEventListener("error", onError, { once: true });
				const safeTime = Math.min(Math.max(time, 0), preview.duration || time);
				preview.currentTime = safeTime;
			};

			seekAndCapture();

			if (cached && cached.videoUrl === currentVideoUrl) {
				return cached.src;
			}
			return PLACEHOLDER_SVG;
		},
		[resolvedSrc.data?.url],
	);

	const isUploadFailed = uploadProgress?.status === "failed";
	const isUploadError = uploadProgress?.status === "error";
	const showUploadFailureOverlay =
		isUploadFailed ||
		(isUploadError && !resolvedSrc.data && !resolvedSrc.isPending);
	const canRetryUploadProcessing = canRetryFailedProcessing(
		uploadProgress,
		canRetryProcessing,
	);
	const uploadFailureMessage = getUploadFailureMessage(
		uploadProgress,
		canRetryProcessing,
	);

	const retryProcessing = useCallback(async () => {
		if (!canRetryUploadProcessing || isRetryingProcessing) {
			return;
		}

		setIsRetryingProcessing(true);

		try {
			const result = await retryVideoProcessing({ videoId });
			await queryClient.invalidateQueries({
				queryKey: ["getUploadProgress", videoId],
			});
			toast.success(
				result.status === "started"
					? "Video processing restarted."
					: "Video is still processing.",
			);
		} catch (error) {
			console.error("Failed to retry video processing", error);
			toast.error("Could not retry video processing.");
		} finally {
			setIsRetryingProcessing(false);
		}
	}, [canRetryUploadProcessing, isRetryingProcessing, queryClient, videoId]);

	const prevUploadProgress = useRef<typeof uploadProgress>(uploadProgress);
	useEffect(() => {
		if (
			shouldReloadPlaybackAfterUploadCompletes(
				prevUploadProgress.current,
				uploadProgress,
				videoLoaded,
			)
		) {
			setHasError(false);
			void queryClient.invalidateQueries({
				queryKey: [
					"resolvedSrc",
					videoSrc,
					rawFallbackSrc,
					enableCrossOrigin,
					preferredSource,
				],
			});
		}
		prevUploadProgress.current = uploadProgress;
	}, [
		enableCrossOrigin,
		preferredSource,
		queryClient,
		rawFallbackSrc,
		uploadProgress,
		videoLoaded,
		videoSrc,
	]);

	const isAutoRetrying = hasError && autoRetryCount < 5;
	const showPreparingOverlay =
		!videoLoaded &&
		!uploadProgress &&
		(!hasError || isAutoRetrying) &&
		(!resolvedSrc.isSuccess || Boolean(resolvedSrc.data));
	const showPlaybackResolutionError =
		hasError &&
		!isAutoRetrying &&
		!uploadProgress &&
		!resolvedSrc.data &&
		!resolvedSrc.isPending;
	const showRawPlaybackBadge =
		showPlaybackStatusBadge && resolvedSrc.data?.type === "raw";
	const rawPlaybackBadgeLabel =
		uploadProgressRaw?.status === "error"
			? "Original upload"
			: "Optimizing video";
	const rawPlaybackBadgeDescription =
		uploadProgressRaw?.status === "error"
			? "The processed version is unavailable right now, so this page is playing the original uploaded file instead."
			: "This page is temporarily playing the original uploaded file while Cap finishes processing the optimized version for smoother playback and broader compatibility.";
	const blockPlaybackControls =
		(!videoLoaded && hasActiveProgress) || showUploadFailureOverlay;

	return (
		<MediaPlayer
			onMouseEnter={() => setControlsVisible(true)}
			onMouseLeave={() => setControlsVisible(false)}
			onTouchStart={() => setControlsVisible(true)}
			onTouchEnd={() => setControlsVisible(false)}
			className={clsx(
				mediaPlayerClassName,
				"[&::-webkit-media-text-track-display]:!hidden",
			)}
			autoHide
		>
			{showUploadFailureOverlay && (
				<div className="flex absolute inset-0 flex-col px-3 gap-3 z-[20] justify-center items-center bg-black transition-opacity duration-300">
					<AlertTriangleIcon className="text-red-500 size-12" />
					<p className="text-gray-11 text-sm leading-relaxed text-center text-balance w-full max-w-[340px] mx-auto">
						{uploadFailureMessage}
					</p>
					{canRetryUploadProcessing && (
						<button
							type="button"
							onClick={retryProcessing}
							disabled={isRetryingProcessing}
							className="px-4 py-2 text-sm font-medium text-white bg-blue-500 rounded-full transition-colors disabled:opacity-60 disabled:cursor-not-allowed hover:bg-blue-600"
						>
							{isRetryingProcessing ? "Retrying..." : "Retry Processing"}
						</button>
					)}
				</div>
			)}
			{showPlaybackResolutionError && (
				<div className="flex absolute inset-0 flex-col px-3 gap-3 z-[20] justify-center items-center bg-black transition-opacity duration-300">
					<AlertTriangleIcon className="text-red-500 size-12" />
					<p className="text-gray-11 text-sm leading-relaxed text-center text-balance w-full max-w-[340px] mx-auto">
						Could not load a playable video source. Reload to try again.
					</p>
				</div>
			)}
			<div
				className={clsx(
					"flex absolute inset-0 z-10 rounded-xl justify-center items-center bg-black transition-opacity duration-300 overflow-visible",
					videoLoaded || !!uploadProgress || !showPreparingOverlay
						? "opacity-0 pointer-events-none"
						: "opacity-100",
				)}
			>
				<div className="flex flex-col gap-2 items-center">
					<LogoSpinner className="w-8 h-auto animate-spin sm:w-10" />
				</div>
			</div>
			{showRawPlaybackBadge && (
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							className="absolute top-3 left-3 z-10 inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur-sm transition-colors hover:bg-black/70"
							aria-label={rawPlaybackBadgeDescription}
						>
							<InfoIcon className="size-3" />
							<span>{rawPlaybackBadgeLabel}</span>
						</button>
					</TooltipTrigger>
					<TooltipContent
						side="bottom"
						align="start"
						className="max-w-[260px] border border-white/10 bg-black/90 px-3 py-2 text-xs leading-relaxed text-white shadow-xl"
					>
						{rawPlaybackBadgeDescription}
					</TooltipContent>
				</Tooltip>
			)}
			{resolvedSrc.data && (
				<MediaPlayerVideo
					src={resolvedSrc.data.url}
					ref={videoRef}
					onLoadedData={() => {
						setVideoLoaded(true);
					}}
					onPlay={() => {
						setShowPlayButton(false);
						setHasPlayedOnce(true);
					}}
					crossOrigin={
						resolvedSrc.data.supportsCrossOrigin ? "anonymous" : undefined
					}
					playsInline
					autoPlay={autoplay}
				>
					{chaptersSrc && <track default kind="chapters" src={chaptersSrc} />}
					{captionsSrc && (
						<track
							label="English"
							kind="captions"
							srcLang="en"
							src={captionsSrc}
						/>
					)}
				</MediaPlayerVideo>
			)}
			{resolvedSrc.data && (
				<video
					ref={previewVideoRef}
					src={resolvedSrc.data.url}
					crossOrigin={
						resolvedSrc.data.supportsCrossOrigin ? "anonymous" : undefined
					}
					preload="metadata"
					muted
					playsInline
					style={{ display: "none" }}
				>
					<track kind="captions" />
				</video>
			)}
			<AnimatePresence>
				{!videoLoaded && hasActiveProgress && !showUploadFailureOverlay && (
					<>
						<motion.div
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
							transition={{ duration: 0.2 }}
							className="absolute inset-0 z-10 transition-all duration-300 bg-black/60 rounded-xl"
						/>
						<motion.div
							initial={{ opacity: 0, y: 10 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: 10 }}
							transition={{ duration: 0.2 }}
							className="flex absolute bottom-3 left-3 gap-2 items-center z-20"
						>
							<span className="text-sm font-semibold text-white">
								{getProgressStatusText(
									isProcessing
										? "processing"
										: isGeneratingThumbnail
											? "generating_thumbnail"
											: "uploading",
								)}
								{uploadProgress?.progress != null &&
									uploadProgress.progress > 0 &&
									` ${Math.round(uploadProgress.progress)}%`}
							</span>
							<svg className="w-4 h-4 transform -rotate-90" viewBox="0 0 20 20">
								<title>Progress</title>
								<circle
									cx="10"
									cy="10"
									r="8"
									stroke="currentColor"
									strokeWidth="3"
									fill="none"
									className="text-white/30"
								/>
								<circle
									cx="10"
									cy="10"
									r="8"
									stroke="currentColor"
									strokeWidth="3"
									fill="none"
									strokeLinecap="round"
									className="text-white transition-all duration-200 ease-out"
									style={{
										strokeDasharray: `${circumference} ${circumference}`,
										strokeDashoffset: `${calculateStrokeDashoffset(uploadProgress?.progress ?? 0, circumference)}`,
									}}
								/>
							</svg>
						</motion.div>
					</>
				)}
				{showPlayButton &&
					videoLoaded &&
					!hasPlayedOnce &&
					!showUploadFailureOverlay &&
					!showPlaybackResolutionError && (
						<motion.div
							whileHover={{ scale: 1.1 }}
							whileTap={{ scale: 0.9 }}
							initial={{ opacity: 0, y: 10 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: 10 }}
							transition={{ duration: 0.2 }}
							onClick={() => videoRef.current?.play()}
							className="flex absolute inset-0 z-10 justify-center items-center m-auto bg-blue-500 rounded-full transition-colors transform cursor-pointer hover:bg-blue-600 size-12 xs:size-20 md:size-32"
						>
							<FontAwesomeIcon
								icon={faPlay}
								className="text-white size-4 xs:size-8 md:size-12"
							/>
						</motion.div>
					)}
			</AnimatePresence>
			{currentCue && toggleCaptions && (
				<div
					className={clsx(
						"absolute left-1/2 transform -translate-x-1/2 text-sm sm:text-xl z-40 pointer-events-none bg-black/80 text-white px-3 sm:px-4 py-1.5 sm:py-2 rounded-md text-center transition-all duration-300 ease-in-out",
						"max-w-[90%] sm:max-w-[480px] md:max-w-[600px]",
						controlsVisible || videoRef.current?.paused
							? "bottom-16 sm:bottom-24"
							: "bottom-3 sm:bottom-12",
					)}
				>
					{currentCue}
				</div>
			)}
			<MediaPlayerLoading />
			{!isUploading &&
				!showUploadFailureOverlay &&
				!showPlaybackResolutionError && <MediaPlayerError />}
			<MediaPlayerVolumeIndicator />

			{mainControlsVisible &&
				markersReady &&
				(() => {
					const filteredComments = comments.filter(
						(comment) =>
							comment &&
							comment.timestamp !== null &&
							comment.id &&
							!(disableCommentStamps && comment.type === "text") &&
							!(disableReactionStamps && comment.type === "emoji"),
					);

					return filteredComments.map((comment) => {
						const position = (Number(comment.timestamp) / playerDuration) * 100;
						const containerPadding = 20;
						const availableWidth = `calc(100% - ${containerPadding * 2}px)`;
						const adjustedPosition = `calc(${containerPadding}px + (${position}% * ${availableWidth} / 100%))`;

						return (
							<CommentStamp
								key={comment.id}
								comment={comment}
								adjustedPosition={adjustedPosition}
								handleMouseEnter={handleMouseEnter}
								handleMouseLeave={handleMouseLeave}
								onSeek={onSeek}
								hoveredComment={hoveredComment}
							/>
						);
					});
				})()}

			<MediaPlayerControls
				className="flex-col items-start gap-2.5"
				mainControlsVisible={(arg: boolean) => setMainControlsVisible(arg)}
				isUploadingOrFailed={blockPlaybackControls}
			>
				<MediaPlayerControlsOverlay className="rounded-b-xl" />
				<MediaPlayerSeek
					fallbackDuration={playerDuration}
					tooltipThumbnailSrc={
						isMobile || !resolvedSrc.isSuccess
							? undefined
							: generateVideoFrameThumbnail
					}
				/>
				<div className="flex gap-2 items-center w-full">
					<div className="flex flex-1 gap-2 items-center">
						<MediaPlayerPlay />
						<MediaPlayerSeekBackward />
						<MediaPlayerSeekForward />
						<MediaPlayerVolume expandable />
						<MediaPlayerTime fallbackDuration={playerDuration} />
					</div>
					<div className="flex gap-2 items-center">
						{!disableCaptions && (
							<MediaPlayerCaptions
								setToggleCaptions={setToggleCaptions}
								toggleCaptions={toggleCaptions}
							/>
						)}
						<MediaPlayerSettings
							captionLanguage={captionLanguage}
							onCaptionLanguageChange={onCaptionLanguageChange}
							availableCaptions={availableCaptions}
							isCaptionLoading={isCaptionLoading}
							hasCaptions={hasCaptions}
						/>
						<MediaPlayerPiP />
						<MediaPlayerFullscreen />
					</div>
				</div>
			</MediaPlayerControls>
		</MediaPlayer>
	);
}
```

### `apps/web/public/site.webmanifest`

```json
{
	"name": "Cap",
	"short_name": "Cap",
	"icons": [
		{
			"src": "/android-chrome-192x192.png",
			"sizes": "192x192",
			"type": "image/png"
		},
		{
			"src": "/android-chrome-512x512.png",
			"sizes": "512x512",
			"type": "image/png"
		}
	],
	"theme_color": "#ffffff",
	"background_color": "#ffffff",
	"display": "standalone"
}
```

## Open Questions

- None. The presigned URL TTL of 1 hour is a known R2/S3 default. The 5-minute expiry buffer combined with the 45-minute `resolvedAt` fallback provides reliable staleness detection from both directions.

## Key Files

- `apps/web/app/s/[videoId]/_components/playback-source.ts` - Added `isStale` boolean and `resolvedAt` timestamp to `ResolvedPlaybackSource`. Added `isPresignedUrl`, `getPresignedUrlExpiresAt`, and `computeIsStale` helpers that parse `X-Amz-Date` and `X-Amz-Expires` from presigned URLs. Changed `isSourcePotentiallyStale` to check `source.isStale` first. Replaced `appendCacheBust` URL mutation with `cache: "no-store"` fetch option to avoid invalidating presigned URL signatures.
- `apps/web/app/s/[videoId]/_components/CapVideoPlayer.tsx` - Added `hasTriedRefresh` state with `prevResolvedAtRef` tracking so refresh resets when a new non-stale source is resolved (fixing one-shot limitation while preventing infinite refresh loops from cached stale URLs). Changed `handleError` to attempt URL refresh via query invalidation before falling back to raw when the mp4 source is stale.
- `apps/web/public/site.webmanifest` - Populated empty `name` and `short_name` fields with "Cap" to fix Chrome manifest parse error.
