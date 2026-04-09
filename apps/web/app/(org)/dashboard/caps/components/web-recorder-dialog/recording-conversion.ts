import type { UploadStatus } from "../../UploadingContext";
import type { VideoId } from "./web-recorder-types";

const MAX_THUMBNAIL_WIDTH = 1000;
const MAX_THUMBNAIL_HEIGHT = 562;
const JPEG_QUALITY = 0.65;
const STREAM_THUMBNAIL_TIMEOUT_MS = 8000;

const renderFrameToJpeg = (video: HTMLVideoElement): Promise<Blob | null> =>
	new Promise((resolve) => {
		try {
			const sourceWidth = video.videoWidth;
			const sourceHeight = video.videoHeight;
			if (sourceWidth <= 0 || sourceHeight <= 0) {
				resolve(null);
				return;
			}
			const canvas = document.createElement("canvas");
			const scale = Math.min(
				MAX_THUMBNAIL_WIDTH / sourceWidth,
				MAX_THUMBNAIL_HEIGHT / sourceHeight,
				1,
			);
			const width = Math.round(sourceWidth * scale);
			const height = Math.round(sourceHeight * scale);
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				resolve(null);
				return;
			}
			ctx.drawImage(video, 0, 0, width, height);
			canvas.toBlob(
				(blob) => {
					resolve(blob ?? null);
				},
				"image/jpeg",
				JPEG_QUALITY,
			);
		} catch {
			resolve(null);
		}
	});

export const captureStreamThumbnail = (stream: MediaStream) =>
	new Promise<Blob | null>((resolve) => {
		const videoTracks = stream.getVideoTracks();
		if (videoTracks.length === 0 || videoTracks[0]?.readyState !== "live") {
			resolve(null);
			return;
		}

		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.srcObject = new MediaStream(videoTracks);

		let timeoutId: number;
		let resolved = false;

		const finalize = (result: Blob | null) => {
			if (resolved) return;
			resolved = true;
			window.clearTimeout(timeoutId);
			video.pause();
			video.srcObject = null;
			resolve(result);
		};

		timeoutId = window.setTimeout(
			() => finalize(null),
			STREAM_THUMBNAIL_TIMEOUT_MS,
		);

		video.addEventListener(
			"error",
			() => {
				finalize(null);
			},
			{ once: true },
		);

		const attemptCapture = () => {
			void renderFrameToJpeg(video).then(finalize);
		};

		if ("requestVideoFrameCallback" in video) {
			video.requestVideoFrameCallback(attemptCapture);
		} else {
			video.addEventListener("loadeddata", attemptCapture, { once: true });
		}

		void video.play().catch(() => {
			finalize(null);
		});
	});

export const captureThumbnail = (source: Blob) =>
	new Promise<Blob | null>((resolve) => {
		const video = document.createElement("video");
		const objectUrl = URL.createObjectURL(source);
		video.src = objectUrl;
		video.muted = true;
		video.playsInline = true;

		let timeoutId: number;

		const cleanup = () => {
			video.pause();
			video.removeAttribute("src");
			video.load();
			URL.revokeObjectURL(objectUrl);
		};

		const finalize = (result: Blob | null) => {
			window.clearTimeout(timeoutId);
			cleanup();
			resolve(result);
		};

		timeoutId = window.setTimeout(() => finalize(null), 10000);

		video.addEventListener(
			"error",
			() => {
				finalize(null);
			},
			{ once: true },
		);

		video.addEventListener(
			"loadedmetadata",
			() => {
				try {
					const duration = Number.isFinite(video.duration) ? video.duration : 0;
					const targetTime = duration > 0 ? Math.min(1, duration / 4) : 0;
					video.currentTime = targetTime;
				} catch {
					finalize(null);
				}
			},
			{ once: true },
		);

		video.addEventListener(
			"seeked",
			() => {
				try {
					const sourceWidth = video.videoWidth;
					const sourceHeight = video.videoHeight;
					if (sourceWidth <= 0 || sourceHeight <= 0) {
						finalize(null);
						return;
					}
					const canvas = document.createElement("canvas");
					const scale = Math.min(
						MAX_THUMBNAIL_WIDTH / sourceWidth,
						MAX_THUMBNAIL_HEIGHT / sourceHeight,
						1,
					);
					const width = Math.round(sourceWidth * scale);
					const height = Math.round(sourceHeight * scale);
					canvas.width = width;
					canvas.height = height;
					const ctx = canvas.getContext("2d");
					if (!ctx) {
						finalize(null);
						return;
					}
					ctx.drawImage(video, 0, 0, width, height);
					canvas.toBlob(
						(blob) => {
							finalize(blob ?? null);
						},
						"image/jpeg",
						JPEG_QUALITY,
					);
				} catch {
					finalize(null);
				}
			},
			{ once: true },
		);
	});

export const convertToMp4 = async (
	blob: Blob,
	hasAudio: boolean,
	currentVideoId: VideoId,
	setUploadStatus: (status: UploadStatus | undefined) => void,
	onPhaseChange?: (phase: "converting") => void,
) => {
	onPhaseChange?.("converting");
	setUploadStatus({
		status: "converting",
		capId: currentVideoId,
		progress: 0,
	});

	const file = new File([blob], "recording.webm", { type: blob.type });
	const { convertMedia } = await import("@remotion/webcodecs");

	const result = await convertMedia({
		src: file,
		container: "mp4",
		videoCodec: "h264",
		...(hasAudio ? { audioCodec: "aac" as const } : {}),
		onProgress: ({ overallProgress }) => {
			if (overallProgress !== null) {
				const percent = Math.min(100, Math.max(0, overallProgress * 100));
				setUploadStatus({
					status: "converting",
					capId: currentVideoId,
					progress: percent,
				});
			}
		},
	});

	const savedFile = await result.save();
	if (savedFile.size === 0) {
		throw new Error("Conversion produced empty file");
	}
	if (savedFile.type !== "video/mp4") {
		return new File([savedFile], "result.mp4", { type: "video/mp4" });
	}
	return savedFile;
};
