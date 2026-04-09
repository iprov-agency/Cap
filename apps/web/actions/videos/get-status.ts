"use server";

import { db } from "@cap/database";
import { users, videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { provideOptionalAuth, VideosPolicy } from "@cap/web-backend";
import { Policy, type Video } from "@cap/web-domain";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { startAiGeneration } from "@/lib/generate-ai";
import * as EffectRuntime from "@/lib/server";
import { transcribeVideo } from "../../lib/transcribe";
import { isAiGenerationEnabled } from "../../utils/flags";

const VALID_TRANSCRIPTION_STATUSES = [
	"PROCESSING",
	"COMPLETE",
	"ERROR",
	"SKIPPED",
	"NO_AUDIO",
] as const;

type TranscriptionStatus = (typeof VALID_TRANSCRIPTION_STATUSES)[number];

function isValidTranscriptionStatus(
	value: unknown,
): value is TranscriptionStatus {
	return (
		typeof value === "string" &&
		(VALID_TRANSCRIPTION_STATUSES as readonly string[]).includes(value)
	);
}

const VALID_AI_GENERATION_STATUSES = [
	"PROCESSING",
	"QUEUED",
	"COMPLETE",
	"ERROR",
	"SKIPPED",
] as const;

type AiGenerationStatus = (typeof VALID_AI_GENERATION_STATUSES)[number];

function isValidAiGenerationStatus(
	value: unknown,
): value is AiGenerationStatus {
	return (
		typeof value === "string" &&
		(VALID_AI_GENERATION_STATUSES as readonly string[]).includes(value)
	);
}

type TranscriptionProgress = "EXTRACTING" | "TRANSCRIBING" | "SUMMARIZING";

export interface VideoStatusResult {
	transcriptionStatus: TranscriptionStatus | null;
	aiGenerationStatus: AiGenerationStatus | null;
	aiTitle: string | null;
	summary: string | null;
	chapters: { title: string; start: number }[] | null;
	error?: string;
	transcriptionProgress?: TranscriptionProgress | null;
	transcriptionError?: string | null;
	transcriptionProgressStartedAt?: string | null;
}

const ACTIVE_UPLOAD_PHASES = [
	"uploading",
	"processing",
	"generating_thumbnail",
] as const;

const PHASE_STALE_TIMEOUTS: Record<string, number> = {
	uploading: 5 * 60 * 1000,
	processing: 15 * 60 * 1000,
	generating_thumbnail: 10 * 60 * 1000,
};

const DEFAULT_STALE_TIMEOUT_MS = 5 * 60 * 1000;

const AI_GENERATION_CLAIM_TTL_MS = 10 * 60 * 1000;

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

function buildStatusResponse(
	transcriptionStatus: TranscriptionStatus | null,
	aiGenerationStatus: AiGenerationStatus | null,
	metadata: VideoMetadata,
	overrides?: Partial<VideoStatusResult>,
): VideoStatusResult {
	return {
		transcriptionStatus,
		aiGenerationStatus,
		aiTitle: metadata.aiTitle || null,
		summary: metadata.summary || null,
		chapters: metadata.chapters || null,
		transcriptionProgress:
			(metadata.transcriptionProgress as TranscriptionProgress) ?? null,
		transcriptionError: metadata.transcriptionError ?? null,
		transcriptionProgressStartedAt:
			metadata.transcriptionProgressStartedAt ?? null,
		...overrides,
	};
}

async function checkActiveUploads(
	videoId: Video.VideoId,
): Promise<"active" | "stale_cleaned" | "none"> {
	try {
		const activeUpload = await db()
			.select({
				videoId: videoUploads.videoId,
				phase: videoUploads.phase,
				updatedAt: videoUploads.updatedAt,
			})
			.from(videoUploads)
			.where(
				and(
					eq(videoUploads.videoId, videoId),
					inArray(videoUploads.phase, [...ACTIVE_UPLOAD_PHASES]),
				),
			)
			.orderBy(desc(videoUploads.updatedAt))
			.limit(1);

		if (activeUpload.length === 0) {
			return "none";
		}

		const upload = activeUpload[0];
		const ageMs = Date.now() - new Date(upload.updatedAt).getTime();
		const phaseTimeout =
			PHASE_STALE_TIMEOUTS[upload.phase] ?? DEFAULT_STALE_TIMEOUT_MS;
		const isStale = ageMs > phaseTimeout;

		if (!isStale) {
			return "active";
		}

		const staleThreshold = new Date(Date.now() - phaseTimeout);
		console.log(
			`[Get Status] Cleaning up stale upload record for video ${videoId} (phase: ${upload.phase}, age: ${Math.round(ageMs / 1000)}s)`,
		);
		await db()
			.delete(videoUploads)
			.where(
				and(
					eq(videoUploads.videoId, videoId),
					lt(videoUploads.updatedAt, staleThreshold),
				),
			);

		return "stale_cleaned";
	} catch (error) {
		console.error(
			`[Get Status] DB error checking active uploads for video ${videoId}:`,
			error,
		);
		return "none";
	}
}

function triggerTranscription(
	videoId: Video.VideoId,
	ownerId: string,
	normalizedAiGenerationStatus: AiGenerationStatus | null,
	metadata: VideoMetadata,
): VideoStatusResult {
	console.log(
		`[Get Status] Transcription not started for video ${videoId}, triggering transcription`,
	);
	try {
		transcribeVideo(videoId, ownerId).catch((error) => {
			console.error(
				`[Get Status] Error starting transcription for video ${videoId}:`,
				error,
			);
		});

		return buildStatusResponse(
			"PROCESSING",
			normalizedAiGenerationStatus,
			metadata,
			{
				transcriptionError: null,
				transcriptionProgress: null,
				transcriptionProgressStartedAt: null,
			},
		);
	} catch (error) {
		console.error(
			`[Get Status] Error triggering transcription for video ${videoId}:`,
			error,
		);
		return buildStatusResponse(
			"ERROR",
			normalizedAiGenerationStatus,
			metadata,
			{
				error: "Failed to start transcription",
				transcriptionProgress: null,
				transcriptionError: "Failed to start transcription",
				transcriptionProgressStartedAt: null,
			},
		);
	}
}

async function triggerAiGenerationIfEligible(
	videoId: Video.VideoId,
	ownerId: string,
	normalizedTranscriptionStatus: TranscriptionStatus | null,
	normalizedAiGenerationStatus: AiGenerationStatus | null,
	metadata: VideoMetadata,
): Promise<VideoStatusResult | null> {
	try {
		const ownerQuery = await db()
			.select({
				email: users.email,
				stripeSubscriptionStatus: users.stripeSubscriptionStatus,
				thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
			})
			.from(users)
			.where(eq(users.id, ownerId))
			.limit(1);

		const owner = ownerQuery[0];
		if (owner && (await isAiGenerationEnabled(owner))) {
			const staleClaimThreshold = Date.now() - AI_GENERATION_CLAIM_TTL_MS;
			const claimResult = await db()
				.update(videos)
				.set({
					metadata: sql`JSON_SET(
						COALESCE(metadata, '{}'),
						'$.aiGenerationStatus', 'PROCESSING',
						'$.aiGenerationClaimedAt', ${Date.now()}
					)`,
				})
				.where(
					and(
						eq(videos.id, videoId),
						sql`(
							JSON_UNQUOTE(JSON_EXTRACT(COALESCE(metadata, '{}'), '$.aiGenerationStatus')) IS NULL
							OR (
								JSON_UNQUOTE(JSON_EXTRACT(COALESCE(metadata, '{}'), '$.aiGenerationStatus')) = 'PROCESSING'
								AND CAST(JSON_EXTRACT(COALESCE(metadata, '{}'), '$.aiGenerationClaimedAt') AS UNSIGNED) < ${staleClaimThreshold}
							)
						)`,
					),
				);

			if (getAffectedRows(claimResult) === 0) {
				return buildStatusResponse(
					normalizedTranscriptionStatus,
					normalizedAiGenerationStatus,
					metadata,
					{
						transcriptionError: null,
					},
				);
			}

			console.log(
				`[Get Status] AI generation not started for video ${videoId}, triggering generation`,
			);
			startAiGeneration(videoId, ownerId).catch(async (error) => {
				console.error(
					`[Get Status] Error starting AI generation for video ${videoId}:`,
					error,
				);
				await db()
					.update(videos)
					.set({
						metadata: sql`JSON_SET(COALESCE(metadata, '{}'), '$.aiGenerationStatus', CAST(NULL AS JSON), '$.aiGenerationClaimedAt', CAST(NULL AS JSON))`,
					})
					.where(eq(videos.id, videoId))
					.catch(() => {});
			});

			return buildStatusResponse(
				normalizedTranscriptionStatus,
				"PROCESSING" as AiGenerationStatus,
				metadata,
				{
					transcriptionError: null,
				},
			);
		}
	} catch (error) {
		console.error(
			`[Get Status] Error checking AI generation eligibility for video ${videoId}:`,
			error,
		);
	}

	return null;
}

export async function getVideoStatus(
	videoId: Video.VideoId,
): Promise<VideoStatusResult | { success: false }> {
	if (!videoId) throw new Error("Video ID not provided");

	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;

		return yield* Effect.promise(() =>
			db().select().from(videos).where(eq(videos.id, videoId)),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(exit)) return { success: false };

	const video = exit.value[0];
	if (!video) throw new Error("Video not found");

	const metadata: VideoMetadata = (video.metadata as VideoMetadata) || {};

	const normalizedTranscriptionStatus = isValidTranscriptionStatus(
		video.transcriptionStatus,
	)
		? (video.transcriptionStatus as TranscriptionStatus)
		: null;

	const normalizedAiGenerationStatus = isValidAiGenerationStatus(
		metadata.aiGenerationStatus,
	)
		? (metadata.aiGenerationStatus as AiGenerationStatus)
		: null;

	if (!normalizedTranscriptionStatus && serverEnv().GOOGLE_API_KEY) {
		const uploadStatus = await checkActiveUploads(videoId);

		if (uploadStatus === "active") {
			return buildStatusResponse(null, normalizedAiGenerationStatus, metadata, {
				transcriptionProgress: null,
				transcriptionError: null,
				transcriptionProgressStartedAt: null,
			});
		}

		return triggerTranscription(
			videoId,
			video.ownerId,
			normalizedAiGenerationStatus,
			metadata,
		);
	}

	if (normalizedTranscriptionStatus === "ERROR") {
		return buildStatusResponse(
			"ERROR",
			normalizedAiGenerationStatus,
			metadata,
			{
				error: metadata.transcriptionError || "Transcription failed",
				transcriptionProgress: null,
				transcriptionError: metadata.transcriptionError ?? null,
				transcriptionProgressStartedAt: null,
			},
		);
	}

	const shouldTriggerAiGeneration =
		normalizedTranscriptionStatus === "COMPLETE" &&
		!normalizedAiGenerationStatus &&
		!metadata.summary &&
		serverEnv().GOOGLE_API_KEY;

	if (shouldTriggerAiGeneration) {
		const aiResult = await triggerAiGenerationIfEligible(
			videoId,
			video.ownerId,
			normalizedTranscriptionStatus,
			normalizedAiGenerationStatus,
			metadata,
		);
		if (aiResult) return aiResult;
	}

	return buildStatusResponse(
		normalizedTranscriptionStatus,
		normalizedAiGenerationStatus,
		metadata,
	);
}
