---
created: 2026-04-09
system: cap
status: approved
content_hash: e671c49ab390d200a36b6915932ec01186a33e044ded69fba4c8b8c0b2082ed1
target_agent: worktree
acceptance_criteria:
  - "Does the web recorder start streaming audio extraction to an in-memory buffer when recording begins?"
  - "Does the API route receive the accumulated audio, transcribe it with Gemini, and save a WebVTT file to R2?"
  - "Is the transcript saved in WebVTT format to the correct S3 key ({userId}/{videoId}/transcription.vtt) when recording stops?"
  - "Does the post-upload transcription skip if a streaming transcript already exists in S3?"
  - "Does the system fall back to post-upload transcription if streaming transcription fails at any point?"
depends_on:
supersedes:
repos:
  - Cap
---

# Streaming Transcription

## Problem

Transcription starts only after the video upload completes. For a 3-minute recording, the user waits 10+ seconds for upload, then additional time for Gemini processing, before seeing any transcript. Competitors like Loom show transcripts within 3-5 seconds because they process audio during recording. Cap needs to extract audio during recording and transcribe it immediately when recording stops, in parallel with the video upload. Audio-only data is 10-50x smaller than video, so the transcription request completes much faster than the video upload.

## Design

Three new files and two modified files. The approach extracts audio from the MediaStream during recording, accumulates it client-side as PCM data, then sends the complete audio buffer to a POST API endpoint when recording stops. The server transcribes with Gemini and saves the WebVTT to R2. This runs concurrently with the video upload.

### Why POST instead of WebSocket

Next.js App Router route handlers do not support WebSocket upgrade. The POST approach is simpler, more reliable, and still achieves the core goal: transcription starts immediately when recording stops (not after video upload). Audio for a 3-minute recording at 16kHz mono 16-bit PCM is approximately 5.8MB, which uploads in under 2 seconds on most connections.

### Client-side audio extraction

When recording starts, `createStreamingTranscription(videoId)` creates a Web Audio pipeline that extracts audio from the MediaStream. A ScriptProcessorNode (widely supported, deprecated but still functional) captures raw float32 samples. These are downsampled to 16kHz mono using OfflineAudioContext (which applies a proper low-pass anti-aliasing filter) and accumulated in an array of Float32Array chunks. The client enforces a 10-minute maximum recording duration for audio accumulation to prevent unbounded memory growth. When recording stops, `stop()` converts the accumulated PCM to a WAV file and POSTs it to `/api/transcribe-stream`. The ScriptProcessorNode is connected through a zero-gain node to prevent audio echo. The function is fire-and-forget from the recorder's perspective; failure does not block the recording or upload flow.

### Server-side transcription

The POST handler at `/api/transcribe-stream` receives the WAV audio body, validates the content-type header and RIFF/WAVE magic bytes, enforces a 20MB request size limit, validates the user session, looks up the video, sets the transcription status to PROCESSING before calling Gemini (to prevent the post-upload workflow from starting a duplicate), sends the audio to Gemini for transcription (reusing the existing Gemini client and prompt pattern), converts the result to WebVTT, and saves it to R2. It marks the video's `transcriptionStatus` as `COMPLETE`.

### Fallback path

In `transcribeVideo()`, before triggering the transcription workflow, the code checks if a `transcription.vtt` file already exists in S3 for the video. If it does, the function marks the status as COMPLETE and returns early. The S3 existence check distinguishes not-found errors from other S3 failures, re-throwing non-404 errors so they propagate correctly. If the streaming transcription failed silently (network error, audio extraction issue, Gemini error), the existing post-upload transcription path runs normally as a fallback.

### Data flow

1. User clicks record. `startRecording()` calls `createStreamingTranscription(videoId).start(mixedStream)`
2. Audio samples accumulate in the client's memory during recording (capped at 10 minutes)
3. User clicks stop. `stopRecording()` calls `streamingTranscriptionRef.current.stop()`
4. `stop()` encodes accumulated PCM as WAV and POSTs to `/api/transcribe-stream`
5. Server validates content-type, size, and WAV magic bytes
6. Server sets transcriptionStatus to PROCESSING, then transcribes with Gemini, saves VTT to R2, marks video COMPLETE
7. Concurrently, video upload proceeds normally
8. When the upload completes, `transcribeVideo()` checks S3 for existing VTT, finds it, skips

## Acceptance Criteria

- [ ] Does the web recorder start streaming audio extraction to an in-memory buffer when recording begins?
- [ ] Does the API route receive the accumulated audio, transcribe it with Gemini, and save a WebVTT file to R2?
- [ ] Is the transcript saved in WebVTT format to the correct S3 key ({userId}/{videoId}/transcription.vtt) when recording stops?
- [ ] Does the post-upload transcription skip if a streaming transcript already exists in S3?
- [ ] Does the system fall back to post-upload transcription if streaming transcription fails at any point?

## Implementation

### `apps/web/lib/audio-pcm.ts`

PCM conversion utilities for extracting and encoding audio data. The `downsampleTo16kHz` function uses `OfflineAudioContext` for proper resampling with anti-aliasing (ST-001 fix), making it async.

```typescript
export async function downsampleTo16kHz(
	buffer: Float32Array,
	inputSampleRate: number,
): Promise<Float32Array> {
	if (inputSampleRate === 16000) {
		return buffer;
	}

	const offlineCtx = new OfflineAudioContext(
		1,
		Math.ceil((buffer.length * 16000) / inputSampleRate),
		16000,
	);
	const source = offlineCtx.createBufferSource();
	const audioBuffer = offlineCtx.createBuffer(1, buffer.length, inputSampleRate);
	audioBuffer.getChannelData(0).set(buffer);
	source.buffer = audioBuffer;
	source.connect(offlineCtx.destination);
	source.start();
	const rendered = await offlineCtx.startRendering();
	return rendered.getChannelData(0);
}

export function floatTo16BitPCM(float32Array: Float32Array): ArrayBuffer {
	const buffer = new ArrayBuffer(float32Array.length * 2);
	const view = new DataView(buffer);

	for (let i = 0; i < float32Array.length; i++) {
		const sample = float32Array[i] ?? 0;
		const clamped = Math.max(-1, Math.min(1, sample));
		const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
		view.setInt16(i * 2, int16, true);
	}

	return buffer;
}

export function encodeWav(
	pcmData: Float32Array,
	sampleRate: number,
): ArrayBuffer {
	const pcm16 = floatTo16BitPCM(pcmData);
	const numChannels = 1;
	const bitsPerSample = 16;
	const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
	const blockAlign = numChannels * (bitsPerSample / 8);
	const dataSize = pcm16.byteLength;
	const headerSize = 44;
	const totalSize = headerSize + dataSize;

	const buffer = new ArrayBuffer(totalSize);
	const view = new DataView(buffer);

	writeString(view, 0, "RIFF");
	view.setUint32(4, totalSize - 8, true);
	writeString(view, 8, "WAVE");

	writeString(view, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, bitsPerSample, true);

	writeString(view, 36, "data");
	view.setUint32(40, dataSize, true);

	const pcmBytes = new Uint8Array(pcm16);
	const wavBytes = new Uint8Array(buffer);
	wavBytes.set(pcmBytes, headerSize);

	return buffer;
}

function writeString(view: DataView, offset: number, str: string): void {
	for (let i = 0; i < str.length; i++) {
		view.setUint8(offset + i, str.charCodeAt(i));
	}
}
```

### `apps/web/lib/streaming-transcription.ts`

Client-side audio extraction and transcription request manager. Fixes applied: AudioContext.resume() after creation (ST-002), zero-gain node to prevent echo (ST-003), max recording duration cap of 10 minutes (ST-004), async downsampleTo16kHz call (ST-001).

```typescript
import { downsampleTo16kHz, encodeWav } from "./audio-pcm";

const MAX_STREAMING_DURATION_MS = 10 * 60 * 1000;

interface StreamingTranscriptionHandle {
	start: (stream: MediaStream) => void;
	stop: () => Promise<void>;
	isActive: () => boolean;
}

export function createStreamingTranscription(
	videoId: string,
): StreamingTranscriptionHandle {
	let audioContext: AudioContext | null = null;
	let scriptProcessor: ScriptProcessorNode | null = null;
	let sourceNode: MediaStreamAudioSourceNode | null = null;
	let gainNode: GainNode | null = null;
	let active = false;
	const chunks: Float32Array[] = [];
	let inputSampleRate = 48000;
	let totalSamplesAccumulated = 0;
	let maxSamplesReached = false;

	const start = (stream: MediaStream) => {
		const audioTracks = stream.getAudioTracks();
		if (audioTracks.length === 0) {
			return;
		}

		try {
			audioContext = new AudioContext();
			inputSampleRate = audioContext.sampleRate;

			const maxSamplesAllowed = Math.ceil(
				(inputSampleRate * MAX_STREAMING_DURATION_MS) / 1000,
			);

			audioContext.resume().catch(() => {});

			const audioOnlyStream = new MediaStream(audioTracks);
			sourceNode = audioContext.createMediaStreamSource(audioOnlyStream);

			scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
			scriptProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
				if (!active || maxSamplesReached) return;
				const inputData = event.inputBuffer.getChannelData(0);
				totalSamplesAccumulated += inputData.length;
				if (totalSamplesAccumulated > maxSamplesAllowed) {
					maxSamplesReached = true;
					return;
				}
				chunks.push(new Float32Array(inputData));
			};

			sourceNode.connect(scriptProcessor);
			gainNode = audioContext.createGain();
			gainNode.gain.value = 0;
			scriptProcessor.connect(gainNode);
			gainNode.connect(audioContext.destination);
			active = true;
		} catch (err) {
			console.error("Failed to start streaming audio extraction", err);
			cleanup();
		}
	};

	const cleanup = () => {
		active = false;
		if (scriptProcessor) {
			scriptProcessor.disconnect();
			scriptProcessor = null;
		}
		if (gainNode) {
			gainNode.disconnect();
			gainNode = null;
		}
		if (sourceNode) {
			sourceNode.disconnect();
			sourceNode = null;
		}
		if (audioContext && audioContext.state !== "closed") {
			audioContext.close().catch(() => {});
			audioContext = null;
		}
	};

	const stop = async () => {
		if (!active && chunks.length === 0) {
			cleanup();
			return;
		}

		cleanup();

		if (chunks.length === 0) {
			return;
		}

		try {
			let totalLength = 0;
			for (const chunk of chunks) {
				totalLength += chunk.length;
			}

			const merged = new Float32Array(totalLength);
			let offset = 0;
			for (const chunk of chunks) {
				merged.set(chunk, offset);
				offset += chunk.length;
			}

			const downsampled = await downsampleTo16kHz(merged, inputSampleRate);
			const wavBuffer = encodeWav(downsampled, 16000);

			const response = await fetch("/api/transcribe-stream", {
				method: "POST",
				headers: {
					"Content-Type": "audio/wav",
					"X-Video-Id": videoId,
				},
				body: wavBuffer,
			});

			if (!response.ok) {
				console.error(
					"Streaming transcription request failed:",
					response.status,
					await response.text().catch(() => ""),
				);
			}
		} catch (err) {
			console.error("Failed to send streaming transcription", err);
		}
	};

	const isActive = () => active;

	return { start, stop, isActive };
}
```

### `apps/web/app/api/transcribe-stream/route.ts`

Server-side POST endpoint that receives WAV audio, transcribes with Gemini, and saves WebVTT to R2. Fixes applied: 20MB request size limit (ST-005), content-type and RIFF/WAVE magic bytes validation (ST-006), PROCESSING marker set before Gemini call (ST-008).

```typescript
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { s3Buckets, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import type { NextRequest } from "next/server";
import { GEMINI_AUDIO_MODEL, getGeminiClient } from "@/lib/gemini-client";
import { runPromise } from "@/lib/server";
import { geminiTextToWebVTT } from "@/lib/transcribe-utils";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

function isValidWavHeader(buffer: ArrayBuffer): boolean {
	if (buffer.byteLength < 12) return false;
	const view = new DataView(buffer);
	const riff =
		String.fromCharCode(view.getUint8(0)) +
		String.fromCharCode(view.getUint8(1)) +
		String.fromCharCode(view.getUint8(2)) +
		String.fromCharCode(view.getUint8(3));
	const wave =
		String.fromCharCode(view.getUint8(8)) +
		String.fromCharCode(view.getUint8(9)) +
		String.fromCharCode(view.getUint8(10)) +
		String.fromCharCode(view.getUint8(11));
	return riff === "RIFF" && wave === "WAVE";
}

export async function POST(request: NextRequest) {
	const user = await getCurrentUser();
	if (!user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.includes("audio/wav")) {
		return Response.json(
			{ error: "Invalid content-type, expected audio/wav" },
			{ status: 400 },
		);
	}

	const videoId = request.headers.get("X-Video-Id");
	if (!videoId) {
		return Response.json(
			{ error: "Missing X-Video-Id header" },
			{ status: 400 },
		);
	}

	if (!serverEnv().GOOGLE_API_KEY) {
		return Response.json(
			{ error: "Transcription not configured" },
			{ status: 503 },
		);
	}

	const query = await db()
		.select({
			video: videos,
			bucket: s3Buckets,
		})
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (query.length === 0 || !query[0]?.video) {
		return Response.json({ error: "Video not found" }, { status: 404 });
	}

	const video = query[0].video;
	if (video.ownerId !== user.id) {
		return Response.json({ error: "Forbidden" }, { status: 403 });
	}

	const audioBuffer = await request.arrayBuffer();
	if (audioBuffer.byteLength === 0) {
		return Response.json({ error: "Empty audio body" }, { status: 400 });
	}

	if (audioBuffer.byteLength > MAX_AUDIO_BYTES) {
		return Response.json(
			{ error: "Audio payload too large" },
			{ status: 413 },
		);
	}

	if (!isValidWavHeader(audioBuffer)) {
		return Response.json(
			{ error: "Invalid WAV file format" },
			{ status: 400 },
		);
	}

	try {
		const gemini = getGeminiClient();
		if (!gemini) {
			return Response.json(
				{ error: "Gemini client not available" },
				{ status: 503 },
			);
		}

		await db()
			.update(videos)
			.set({ transcriptionStatus: "PROCESSING" })
			.where(eq(videos.id, videoId as Video.VideoId));

		const audioBase64 = Buffer.from(audioBuffer).toString("base64");

		const model = gemini.getGenerativeModel({ model: GEMINI_AUDIO_MODEL });

		const result = await model.generateContent([
			{
				inlineData: {
					mimeType: "audio/wav",
					data: audioBase64,
				},
			},
			{
				text: `Transcribe this audio accurately. Include timestamps for each segment.
Format each line as: [MM:SS] transcribed text
For example:
[0:00] Hello and welcome to this video.
[0:05] Today we're going to talk about...

Be precise with the timestamps and transcribe every word spoken. If there are multiple speakers, note speaker changes.`,
			},
		]);

		const transcriptionText = result.response.text();

		if (!transcriptionText || transcriptionText.trim().length === 0) {
			return Response.json(
				{ error: "Gemini returned empty transcription" },
				{ status: 502 },
			);
		}

		const vtt = geminiTextToWebVTT(transcriptionText);

		const [bucket] = await S3Buckets.getBucketAccess(
			Option.fromNullable(query[0].bucket?.id),
		).pipe(runPromise);

		await bucket
			.putObject(`${user.id}/${videoId}/transcription.vtt`, vtt, {
				contentType: "text/vtt",
			})
			.pipe(runPromise);

		await db()
			.update(videos)
			.set({ transcriptionStatus: "COMPLETE" })
			.where(eq(videos.id, videoId as Video.VideoId));

		return Response.json({ success: true });
	} catch (err) {
		console.error(
			`[transcribe-stream] Failed to transcribe video ${videoId}:`,
			err,
		);
		return Response.json(
			{ error: "Transcription failed" },
			{ status: 500 },
		);
	}
}
```

### `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/useWebRecorder.ts`

Targeted changes only. The builder should apply these diffs to the existing 1638-line file, not replace it.

**Change 1: Add import (after the existing imports, around line 31)**

Add this import after the existing `import { moveRecordingSpoolToInMemoryBackup }` line:

```typescript
import { createStreamingTranscription } from "@/lib/streaming-transcription";
```

**Change 2: Add ref (after `thumbnailUploadAbortRef` at line 298)**

Add this ref declaration after `const thumbnailUploadAbortRef = useRef<AbortController | null>(null);`:

```typescript
const streamingTranscriptionRef = useRef<ReturnType<
	typeof createStreamingTranscription
> | null>(null);
```

**Change 3: Cleanup in `cleanupRecordingState` (inside the function body, after `cancelThumbnailCapture();` at line 629)**

Add streaming transcription cleanup. After the line `cancelThumbnailCapture();` and before `instantChunkModeRef.current = null;`, insert:

```typescript
		if (streamingTranscriptionRef.current) {
			streamingTranscriptionRef.current.stop().catch((err) => {
				console.error("Failed to stop streaming transcription during cleanup", err);
			});
			streamingTranscriptionRef.current = null;
		}
```

**Change 4: Start streaming transcription in `startRecording` (after `onRecordingStart?.()` at line 1121)**

After the line `onRecordingStart?.();` and before `startTimer();`, insert:

```typescript
			if (hasAudio && videoCreationRef.current) {
				try {
					const transcription = createStreamingTranscription(
						videoCreationRef.current.id,
					);
					transcription.start(mixedStream);
					streamingTranscriptionRef.current = transcription;
				} catch (err) {
					console.error("Failed to start streaming transcription", err);
				}
			}
```

**Change 5: Stop streaming transcription in `stopRecording` (after `onRecordingStop?.()` at line 1256)**

After the line `onRecordingStop?.();` and before `updatePhase("creating");`, insert:

```typescript
			const streamingTranscription = streamingTranscriptionRef.current;
			streamingTranscriptionRef.current = null;
			if (streamingTranscription) {
				streamingTranscription.stop().catch((err) => {
					console.error("Streaming transcription finalization failed", err);
				});
			}
```

### `apps/web/lib/transcribe.ts`

Complete replacement of the file. The key change is in `transcribeVideo()`: before triggering the workflow, it checks if a streaming transcript already exists in S3. The `checkStreamingTranscriptExists` function now distinguishes NotFound from other S3 errors (ST-007 fix), only returning false for not-found and re-throwing other errors.

```typescript
import { db } from "@cap/database";
import { organizations, s3Buckets, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { S3Buckets } from "@cap/web-backend";
import { eq } from "drizzle-orm";
import { Cause, Exit, Option } from "effect";
import { transcribeVideoWorkflow } from "@/workflows/transcribe";
import { runPromise } from "@/lib/server";

type TranscribeResult = {
	success: boolean;
	message: string;
};

const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

async function markTranscriptionError(
	videoId: Video.VideoId,
	errorMessage: string,
): Promise<void> {
	try {
		const [currentVideo] = await db()
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId));

		const currentMetadata = (currentVideo?.metadata as VideoMetadata) || {};

		await db()
			.update(videos)
			.set({
				transcriptionStatus: "ERROR",
				metadata: {
					...currentMetadata,
					transcriptionProgress: undefined,
					transcriptionProgressStartedAt: undefined,
					transcriptionError: errorMessage,
				},
			})
			.where(eq(videos.id, videoId));
	} catch (dbErr) {
		console.error(
			`[transcribeVideo] Failed to save error status for ${videoId}:`,
			dbErr,
		);
	}
}

function isS3NotFoundError(err: unknown): boolean {
	if (Exit.isExit(err) && Exit.isFailure(err)) {
		const cause = err.cause;
		if (Cause.isFailType(cause)) {
			const s3Error = cause.error;
			if (
				s3Error &&
				typeof s3Error === "object" &&
				"cause" in s3Error
			) {
				const underlying = (s3Error as { cause: unknown }).cause;
				if (
					underlying &&
					typeof underlying === "object" &&
					"name" in underlying
				) {
					const name = (underlying as { name: string }).name;
					return name === "NotFound" || name === "NoSuchKey";
				}
				if (
					underlying &&
					typeof underlying === "object" &&
					"$metadata" in underlying
				) {
					const metadata = (underlying as { $metadata: { httpStatusCode?: number } })
						.$metadata;
					return metadata?.httpStatusCode === 404;
				}
			}
		}
	}
	return false;
}

async function checkStreamingTranscriptExists(
	videoId: string,
	userId: string,
	bucketId: string | null,
): Promise<boolean> {
	try {
		const [bucket] = await S3Buckets.getBucketAccess(
			Option.fromNullable(bucketId),
		).pipe(runPromise);

		await bucket
			.headObject(`${userId}/${videoId}/transcription.vtt`)
			.pipe(runPromise);

		return true;
	} catch (err) {
		if (isS3NotFoundError(err)) {
			return false;
		}
		throw err;
	}
}

export async function transcribeVideo(
	videoId: Video.VideoId,
	userId: string,
	aiGenerationEnabled = false,
	_isRetry = false,
): Promise<TranscribeResult> {
	if (!serverEnv().GOOGLE_API_KEY) {
		return {
			success: false,
			message: "Missing GOOGLE_API_KEY for Gemini transcription",
		};
	}

	if (!userId || !videoId) {
		return {
			success: false,
			message: "userId or videoId not supplied",
		};
	}

	const query = await db()
		.select({
			video: videos,
			bucket: s3Buckets,
			settings: videos.settings,
			orgSettings: organizations.settings,
		})
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId));

	if (query.length === 0) {
		return { success: false, message: "Video does not exist" };
	}

	const result = query[0];
	if (!result || !result.video) {
		return { success: false, message: "Video information is missing" };
	}

	const { video } = result;

	if (!video) {
		return { success: false, message: "Video information is missing" };
	}

	if (
		video.settings?.disableTranscript ??
		result.orgSettings?.disableTranscript
	) {
		console.log(
			`[transcribeVideo] Transcription disabled for video ${videoId}`,
		);
		try {
			await db()
				.update(videos)
				.set({ transcriptionStatus: "SKIPPED" })
				.where(eq(videos.id, videoId));
		} catch (err) {
			console.error(`[transcribeVideo] Failed to mark as skipped:`, err);
			return {
				success: false,
				message: "Transcription disabled, but failed to update status",
			};
		}
		return {
			success: true,
			message: "Transcription disabled for video, skipping transcription",
		};
	}

	if (
		video.transcriptionStatus === "COMPLETE" ||
		video.transcriptionStatus === "SKIPPED" ||
		video.transcriptionStatus === "NO_AUDIO"
	) {
		return {
			success: true,
			message: "Transcription already completed",
		};
	}

	const streamingTranscriptExists = await checkStreamingTranscriptExists(
		videoId,
		video.ownerId,
		result.bucket?.id ?? null,
	);

	if (streamingTranscriptExists) {
		console.log(
			`[transcribeVideo] Streaming transcript already exists for ${videoId}, marking COMPLETE`,
		);
		try {
			await db()
				.update(videos)
				.set({ transcriptionStatus: "COMPLETE" })
				.where(eq(videos.id, videoId));
		} catch (dbErr) {
			console.error(
				`[transcribeVideo] Failed to mark streaming transcript as complete:`,
				dbErr,
			);
		}
		return {
			success: true,
			message: "Streaming transcript already exists",
		};
	}

	if (video.transcriptionStatus === "PROCESSING") {
		const metadata = (video.metadata ?? {}) as VideoMetadata;
		const rawStartedAt = metadata.transcriptionStartedAt;
		const startedAtMs =
			typeof rawStartedAt === "string"
				? Date.parse(rawStartedAt)
				: rawStartedAt;
		if (
			startedAtMs == null ||
			Number.isNaN(startedAtMs) ||
			Date.now() - startedAtMs < PROCESSING_TIMEOUT_MS
		) {
			return {
				success: true,
				message: "Transcription already in progress",
			};
		}
		console.log(
			`[transcribeVideo] PROCESSING status stale for ${videoId}, marking as ERROR`,
		);
		await markTranscriptionError(
			videoId,
			"Transcription timed out after 5 minutes. Click retry to try again.",
		);
		return {
			success: false,
			message:
				"Transcription timed out after 5 minutes. Click retry to try again.",
		};
	}

	try {
		console.log(
			`[transcribeVideo] Triggering transcription workflow for video ${videoId}`,
		);

		transcribeVideoWorkflow({
			videoId,
			userId,
			aiGenerationEnabled,
		}).catch(async (err) => {
			console.error(`[transcribeVideo] Workflow failed for ${videoId}:`, err);

			const errorMessage =
				err instanceof Error
					? err.message
					: "Transcription failed unexpectedly";

			await markTranscriptionError(videoId, errorMessage);
		});

		return {
			success: true,
			message: "Transcription workflow started",
		};
	} catch (error) {
		console.error("[transcribeVideo] Failed to trigger workflow:", error);

		const errorMessage =
			error instanceof Error
				? error.message
				: "Failed to start transcription workflow";

		await markTranscriptionError(videoId, errorMessage);

		return {
			success: false,
			message: "Failed to start transcription workflow",
		};
	}
}
```

## Open Questions

- Gemini has a maximum inline data size limit (currently 20MB). For very long recordings (30+ minutes), the WAV file may exceed this. The server now enforces a 20MB limit (ST-005). A chunked approach or server-side audio compression could be added later for longer recordings.
- The ScriptProcessorNode is deprecated in favor of AudioWorklet. ScriptProcessorNode is used here because it has broader browser support and simpler implementation. If browser compatibility narrows, a migration to AudioWorklet would be straightforward since the interface is isolated in `streaming-transcription.ts`.
- The streaming transcription creates its own AudioContext. The web recorder already creates an AudioContext for mixing system audio and mic audio (line 968). These are independent because the streaming transcription taps directly into the mixed stream, not the raw sources. If memory pressure becomes a concern, the two could share an AudioContext.

## Key Files

- `apps/web/lib/audio-pcm.ts` - NEW. PCM conversion utilities (OfflineAudioContext downsample, float-to-int16, WAV encoding)
- `apps/web/lib/streaming-transcription.ts` - NEW. Client-side audio extraction with duration cap, zero-gain echo prevention, AudioContext resume
- `apps/web/app/api/transcribe-stream/route.ts` - NEW. Server POST endpoint with size limit, content-type/WAV validation, PROCESSING marker
- `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/useWebRecorder.ts` - MODIFIED. Integration hooks for start/stop/cleanup
- `apps/web/lib/transcribe.ts` - MODIFIED. Skip workflow if streaming transcript exists in S3, NotFound-specific error handling
