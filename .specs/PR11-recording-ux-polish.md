---
created: 2026-04-09
system: cap
status: approved
target_agent: worktree
acceptance_criteria:
  - "Does the recording dialog auto-close after recording stops and upload completes?"
  - "Does the scrub preview show the correct frame for the hovered timestamp?"
  - "Does the main video continue playing unaffected during scrub preview seeking?"
  - "Does the hidden preview video use the same source as the main player?"
depends_on:
supersedes:
repos:
  - Cap
---

# Recording UX Polish

## Problem

Two usability issues in the web recording and playback experience. First, when a user stops recording, the recording dialog stays open showing a redundant "Open Share Link" button even though the share page already auto-opens in a new tab. The user must manually close the dialog to return to the dashboard. Second, the video player's scrub preview (hover thumbnail on the progress bar) always shows the same frame regardless of hover position because `generateVideoFrameThumbnail` draws from the main video element at its current playback position instead of seeking to the requested time.

## Design

### Fix 1: Auto-close recording dialog on stop

Add a `useEffect` in `web-recorder-dialog.tsx` that watches for the `phase` transition to `"completed"` AND for `completedShareUrl` to be populated. Guarding on both values prevents the effect from firing before the share URL is available (which would reset state prematurely). When both conditions are met and the dialog is open, close it via direct state resets and `setOpen(false)`. This is safer than calling a close callback from within `useWebRecorder`'s `stopRecording` because it runs after React has re-rendered with the new phase.

No changes to `useWebRecorder.ts` are needed. The existing toast ("Recording uploaded.") fires before the dialog closes, so the user still sees confirmation. The "Share link ready" panel (lines 346-361 in the dialog) is never rendered because the dialog closes before it becomes visible.

### Fix 2: Scrub preview shows correct frame

Add a hidden `<video>` element that shares the same source as the main player. When `generateVideoFrameThumbnail` is called with a time value, it checks a ref-based thumbnail cache. If the cache holds a thumbnail for the requested time (within 0.01s tolerance) and for the current video URL, it returns it immediately. Otherwise, it kicks off an asynchronous seek on the hidden video, and when the seek completes, draws the frame to a canvas and triggers a version counter bump to re-render.

Key details:
- The hidden video element is only rendered when `resolvedSrc.data` is available
- The hidden video has `preload="metadata"` to avoid loading the full video until needed
- A tolerance of 0.01 seconds is used when comparing cached time vs requested time
- Only one seek can be in flight at a time (tracked via `pendingPreviewSeekRef`)
- The canvas is reused via a ref to avoid repeated DOM allocations
- Seek completion uses `addEventListener("seeked", ..., { once: true })` with a companion error listener and a 3-second timeout fallback to prevent the pending flag from deadlocking if `seeked` never fires (metadata not ready, seek fails, element removed)
- The thumbnail cache stores the video URL alongside time and src, so a source change invalidates stale frames
- Time is clamped to `[0, preview.duration]` before seeking to prevent NaN/Infinity exceptions
- Placeholder images use inline data URL SVGs instead of external URLs to avoid leaking the user's IP
- An `isMountedRef` guards all state-setter calls (`setScrubThumbnailVersion`) so that late `seeked` callbacks after unmount do not call setters on an unmounted component

## Acceptance Criteria

- [ ] Does the recording dialog auto-close after recording stops and upload completes?
- [ ] Does the scrub preview show the correct frame for the hovered timestamp?
- [ ] Does the main video continue playing unaffected during scrub preview seeking?
- [ ] Does the hidden preview video use the same source as the main player?

## Implementation

### `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/web-recorder-dialog.tsx`

```tsx
"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "@cap/ui";
import { AnimatePresence, motion } from "framer-motion";
import { MonitorIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useDashboardContext } from "../../../Contexts";
import { CameraPreviewWindow } from "./CameraPreviewWindow";
import { CameraSelector } from "./CameraSelector";
import { HowItWorksButton } from "./HowItWorksButton";
import { HowItWorksPanel } from "./HowItWorksPanel";
import { InProgressRecordingBar } from "./InProgressRecordingBar";
import { MicrophoneSelector } from "./MicrophoneSelector";
import { RecordingButton } from "./RecordingButton";
import {
	type RecordingMode,
	RecordingModeSelector,
} from "./RecordingModeSelector";
import { SettingsButton } from "./SettingsButton";
import { SettingsPanel } from "./SettingsPanel";
import { SystemAudioToggle } from "./SystemAudioToggle";
import { useCameraDevices } from "./useCameraDevices";
import { useDevicePreferences } from "./useDevicePreferences";
import { useDialogInteractions } from "./useDialogInteractions";
import { useMicrophoneDevices } from "./useMicrophoneDevices";
import { useWebRecorder } from "./useWebRecorder";
import {
	dialogVariants,
	FREE_PLAN_MAX_RECORDING_MS,
} from "./web-recorder-constants";
import { WebRecorderDialogHeader } from "./web-recorder-dialog-header";

const recoveredRecordingTimeFormatter = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

export const WebRecorderDialog = () => {
	const [open, setOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [howItWorksOpen, setHowItWorksOpen] = useState(false);
	const [recordingMode, setRecordingMode] =
		useState<RecordingMode>("fullscreen");
	const [cameraSelectOpen, setCameraSelectOpen] = useState(false);
	const [micSelectOpen, setMicSelectOpen] = useState(false);
	const dialogContentRef = useRef<HTMLDivElement>(null);
	const startSoundRef = useRef<HTMLAudioElement | null>(null);
	const stopSoundRef = useRef<HTMLAudioElement | null>(null);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}

		const startSound = new Audio("/sounds/start-recording.ogg");
		startSound.preload = "auto";
		const stopSound = new Audio("/sounds/stop-recording.ogg");
		stopSound.preload = "auto";

		startSoundRef.current = startSound;
		stopSoundRef.current = stopSound;

		return () => {
			startSound.pause();
			stopSound.pause();
			startSoundRef.current = null;
			stopSoundRef.current = null;
		};
	}, []);

	const playAudio = useCallback((audio: HTMLAudioElement | null) => {
		if (!audio) {
			return;
		}
		audio.currentTime = 0;
		void audio.play().catch(() => {});
	}, []);

	const handleRecordingStartSound = useCallback(() => {
		playAudio(startSoundRef.current);
	}, [playAudio]);

	const handleRecordingStopSound = useCallback(() => {
		playAudio(stopSoundRef.current);
	}, [playAudio]);

	const { activeOrganization, user } = useDashboardContext();
	const organisationId = activeOrganization?.organization.id;
	const { devices: availableMics, refresh: refreshMics } =
		useMicrophoneDevices(open);
	const { devices: availableCameras, refresh: refreshCameras } =
		useCameraDevices(open);

	const {
		rememberDevices,
		selectedCameraId,
		selectedMicId,
		systemAudioEnabled,
		setSelectedCameraId,
		handleCameraChange,
		handleMicChange,
		handleSystemAudioChange,
		handleRememberDevicesChange,
	} = useDevicePreferences({
		open,
		availableCameras,
		availableMics,
	});

	const micEnabled = selectedMicId !== null;

	useEffect(() => {
		if (
			recordingMode === "camera" &&
			!selectedCameraId &&
			availableCameras.length > 0
		) {
			setSelectedCameraId(availableCameras[0]?.deviceId ?? null);
		}
	}, [recordingMode, selectedCameraId, availableCameras, setSelectedCameraId]);

	const {
		phase,
		durationMs,
		hasAudioTrack,
		chunkUploads,
		errorDownload,
		completedShareUrl,
		recoveredDownloads,
		isRecording,
		isBusy,
		isRestarting,
		canStartRecording,
		isBrowserSupported,
		unsupportedReason,
		supportsDisplayRecording,
		supportCheckCompleted,
		screenCaptureWarning,
		startRecording,
		pauseRecording,
		resumeRecording,
		stopRecording,
		openCompletedShareUrl,
		restartRecording,
		resetState,
		dismissRecoveredDownload,
	} = useWebRecorder({
		organisationId,
		selectedMicId,
		micEnabled,
		systemAudioEnabled,
		recordingMode,
		selectedCameraId,
		isProUser: user.isPro,
		onRecordingSurfaceDetected: (mode) => {
			setRecordingMode(mode);
		},
		onRecordingStart: handleRecordingStartSound,
		onRecordingStop: handleRecordingStopSound,
	});

	useEffect(() => {
		if (
			!supportCheckCompleted ||
			supportsDisplayRecording ||
			recordingMode === "camera"
		) {
			return;
		}

		setRecordingMode("camera");
	}, [supportCheckCompleted, supportsDisplayRecording, recordingMode]);

	const {
		handlePointerDownOutside,
		handleFocusOutside,
		handleInteractOutside,
	} = useDialogInteractions({
		dialogContentRef,
		isRecording,
		isBusy,
	});

	const handleOpenChange = (next: boolean) => {
		if (next && supportCheckCompleted && !isBrowserSupported) {
			toast.error(
				"This browser isn't compatible with Cap's web recorder. We recommend Google Chrome or other Chromium-based browsers.",
			);
			return;
		}

		if (!next && isBusy) {
			toast.info("Keep this dialog open while your upload finishes.");
			return;
		}

		if (!next) {
			void resetState();
			setSelectedCameraId(null);
			setRecordingMode("fullscreen");
			setSettingsOpen(false);
			setHowItWorksOpen(false);
		}
		setOpen(next);
	};

	useEffect(() => {
		if (open && phase === "completed" && completedShareUrl) {
			void resetState();
			setSelectedCameraId(null);
			setRecordingMode("fullscreen");
			setSettingsOpen(false);
			setHowItWorksOpen(false);
			setOpen(false);
		}
	}, [open, phase, completedShareUrl, resetState, setSelectedCameraId]);

	const handleStopClick = () => {
		stopRecording().catch((err: unknown) => {
			console.error("Stop recording error", err);
		});
	};

	const handleClose = () => {
		if (!isBusy) {
			handleOpenChange(false);
		}
	};

	const handleSettingsOpen = () => {
		setSettingsOpen(true);
		setHowItWorksOpen(false);
	};

	const handleHowItWorksOpen = () => {
		setHowItWorksOpen(true);
		setSettingsOpen(false);
	};

	const showInProgressBar = isRecording || isBusy || phase === "error";
	const recordingTimerDisplayMs = user.isPro
		? durationMs
		: Math.max(0, FREE_PLAN_MAX_RECORDING_MS - durationMs);

	return (
		<>
			<Dialog open={open} onOpenChange={handleOpenChange}>
				<DialogTrigger asChild>
					<Button variant="blue" size="sm" className="flex items-center gap-2">
						<MonitorIcon className="size-3.5" />
						Record in Browser
					</Button>
				</DialogTrigger>
				<DialogContent
					ref={dialogContentRef}
					className="w-[300px] border-none bg-transparent p-0 [&>button]:hidden"
					onPointerDownOutside={handlePointerDownOutside}
					onFocusOutside={handleFocusOutside}
					onInteractOutside={handleInteractOutside}
				>
					<DialogTitle className="sr-only">Instant Mode Recorder</DialogTitle>
					<AnimatePresence mode="wait">
						{open && (
							<motion.div
								variants={dialogVariants}
								initial="hidden"
								animate="visible"
								exit="exit"
								className="relative flex justify-center flex-col p-[1rem] pt-[2rem] gap-[0.75rem] text-[0.875rem] font-[400] text-[--text-primary] bg-gray-2 rounded-lg min-h-[350px]"
							>
								<SettingsButton
									visible={!settingsOpen}
									onClick={handleSettingsOpen}
								/>
								<SettingsPanel
									open={settingsOpen}
									rememberDevices={rememberDevices}
									onClose={() => setSettingsOpen(false)}
									onRememberDevicesChange={handleRememberDevicesChange}
								/>
								<HowItWorksPanel
									open={howItWorksOpen}
									onClose={() => setHowItWorksOpen(false)}
								/>
								<WebRecorderDialogHeader
									isBusy={isBusy}
									onClose={handleClose}
								/>
								<RecordingModeSelector
									mode={recordingMode}
									disabled={isBusy}
									onModeChange={setRecordingMode}
								/>
								{screenCaptureWarning && (
									<div className="rounded-md border border-amber-6 bg-amber-3/60 px-3 py-2 text-xs leading-snug text-amber-12">
										{screenCaptureWarning}
									</div>
								)}
								<CameraSelector
									selectedCameraId={selectedCameraId}
									availableCameras={availableCameras}
									dialogOpen={open}
									disabled={isBusy}
									open={cameraSelectOpen}
									onOpenChange={(isOpen) => {
										setCameraSelectOpen(isOpen);
										if (isOpen) {
											setMicSelectOpen(false);
										}
									}}
									onCameraChange={handleCameraChange}
									onRefreshDevices={refreshCameras}
								/>
								<MicrophoneSelector
									selectedMicId={selectedMicId}
									availableMics={availableMics}
									dialogOpen={open}
									disabled={isBusy}
									open={micSelectOpen}
									onOpenChange={(isOpen) => {
										setMicSelectOpen(isOpen);
										if (isOpen) {
											setCameraSelectOpen(false);
										}
									}}
									onMicChange={handleMicChange}
									onRefreshDevices={refreshMics}
								/>
								{recordingMode !== "camera" && (
									<SystemAudioToggle
										enabled={systemAudioEnabled}
										disabled={isBusy}
										recordingMode={recordingMode}
										onToggle={handleSystemAudioChange}
									/>
								)}
								<RecordingButton
									isRecording={isRecording}
									disabled={!canStartRecording || (isBusy && !isRecording)}
									onStart={startRecording}
									onStop={handleStopClick}
								/>
								{!isBrowserSupported && unsupportedReason && (
									<div className="rounded-md border border-red-6 bg-red-3/70 px-3 py-2 text-xs leading-snug text-red-12">
										{unsupportedReason}
									</div>
								)}
								{phase === "completed" && completedShareUrl && (
									<div className="rounded-md border border-green-6 bg-green-3/70 px-3 py-3 text-xs text-green-12">
										<div className="font-medium">Share link ready</div>
										<div className="mt-1 leading-snug">
											If it did not open automatically, open it here.
										</div>
										<Button
											variant="blue"
											size="sm"
											className="mt-3 w-full"
											onClick={openCompletedShareUrl}
										>
											Open Share Link
										</Button>
									</div>
								)}
								{phase === "idle" && recoveredDownloads.length > 0 && (
									<div className="rounded-md border border-blue-6 bg-blue-3/60 px-3 py-2">
										<div className="text-xs font-medium text-blue-12">
											Recovered recordings
										</div>
										<div className="mt-2 flex flex-col gap-2">
											{recoveredDownloads.map((download) => (
												<div
													key={download.id}
													className="flex items-center justify-between gap-3 rounded-md bg-white/70 px-2.5 py-2 text-xs text-gray-12"
												>
													<div className="min-w-0">
														<div className="truncate font-medium">
															{download.fileName}
														</div>
														<div className="text-gray-10">
															{recoveredRecordingTimeFormatter.format(
																new Date(download.createdAt),
															)}
														</div>
													</div>
													<div className="flex shrink-0 items-center gap-3">
														<a
															href={download.url}
															download={download.fileName}
															className="font-medium text-blue-11 hover:text-blue-12"
															onClick={() =>
																setTimeout(
																	() => dismissRecoveredDownload(download.id),
																	500,
																)
															}
														>
															Download
														</a>
														<button
															type="button"
															className="text-gray-10 hover:text-gray-12"
															onClick={() =>
																dismissRecoveredDownload(download.id)
															}
														>
															Dismiss
														</button>
													</div>
												</div>
											))}
										</div>
									</div>
								)}
								<HowItWorksButton onClick={handleHowItWorksOpen} />
							</motion.div>
						)}
					</AnimatePresence>
				</DialogContent>
			</Dialog>
			{showInProgressBar && (
				<InProgressRecordingBar
					phase={phase}
					durationMs={recordingTimerDisplayMs}
					hasAudioTrack={hasAudioTrack}
					chunkUploads={chunkUploads}
					errorDownload={errorDownload}
					onStop={handleStopClick}
					onPause={pauseRecording}
					onResume={resumeRecording}
					onRestart={restartRecording}
					isRestarting={isRestarting}
				/>
			)}
			{selectedCameraId && (
				<CameraPreviewWindow
					cameraId={selectedCameraId}
					onClose={() => handleCameraChange(null)}
				/>
			)}
		</>
	);
};
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
	}, [videoSrc, rawFallbackSrc]);

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
		hasPlayedOnce,
		hasTriedRawFallback,
		rawFallbackSrc,
		resolvedSrc.data?.type,
		resolvedSrc.isPending,
		videoRef.current,
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

## Open Questions

- The `CapVideoPlayer` function is 742 lines (pre-existing), well above the `max_fn_lines = 200` constraint in `.sentrux/rules.toml`. This spec adds approximately 50 lines to it. A decomposition refactor is out of scope for this spec but should be planned.
- Cross-origin video sources may prevent `drawImage` from producing thumbnails on the hidden preview video. The hidden video mirrors the `crossOrigin` attribute from the main player, but if the server does not send proper CORS headers for the preview video's requests, the canvas will be tainted. This matches the existing behavior (the original code has the same limitation with the main video).
- The commented-out enhanced audio JSX from the original `CapVideoPlayer.tsx` has been removed in the spec output since the repo constraint forbids code comments. If this code is needed as a placeholder for future work, it should be tracked in a separate issue rather than living as commented-out code.

## Key Files

- `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/web-recorder-dialog.tsx` - Recording dialog component. Added a `useEffect` that auto-closes the dialog when `phase` transitions to `"completed"` and `completedShareUrl` is available.
- `apps/web/app/s/[videoId]/_components/CapVideoPlayer.tsx` - Share page video player. Added hidden preview video element, canvas ref, and async thumbnail generation for accurate scrub previews. Uses `addEventListener("seeked", ..., { once: true })` with error and timeout fallbacks to prevent deadlocks. Guards state updates with `isMountedRef` to prevent leaking state after unmount.
