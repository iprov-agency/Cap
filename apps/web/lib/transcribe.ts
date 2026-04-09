import { db } from "@cap/database";
import { organizations, s3Buckets, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { transcribeVideoWorkflow } from "@/workflows/transcribe";

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
