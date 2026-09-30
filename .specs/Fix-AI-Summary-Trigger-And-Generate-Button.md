---
created: 2026-04-09
system: cap
status: approved
content_hash: 98b7854dd2947f589bc402109fe68c4ae893411f842cd9074faea56f2e4a065b
target_agent: worktree
acceptance_criteria:
  - "Does shouldTriggerAiGeneration in get-status.ts check GOOGLE_API_KEY instead of GROQ_API_KEY/OPENAI_API_KEY?"
  - "Does the Summary tab show a Generate Summary button when transcription is COMPLETE, no aiGenerationStatus exists, and no summary exists?"
  - "Does clicking the Generate Summary button call the retry-ai endpoint and reload the page on success?"
  - "Does the auto-trigger in getVideoStatus fire correctly when GOOGLE_API_KEY is set and transcription completes?"
depends_on:
supersedes:
repos:
  - Cap
---

# Fix AI Summary Trigger and Generate Button

## Problem

The AI summary feature is completely broken for two reasons. First, the auto-trigger condition in `get-status.ts` checks `GROQ_API_KEY || OPENAI_API_KEY`, but this fork uses Gemini (via `GOOGLE_API_KEY`). Those keys are never set, so `shouldTriggerAiGeneration` is always false and AI generation never fires for new recordings. Second, videos recorded before this fix (with complete transcriptions but no AI summary) have no way to trigger generation manually. The Summary tab shows "No summary available" with no actionable button.

## Design

Two targeted changes:

1. **Fix auto-trigger (get-status.ts):** Replace the `GROQ_API_KEY || OPENAI_API_KEY` check on line 376 with `GOOGLE_API_KEY`. The rest of the AI pipeline (`lib/generate-ai.ts`, `workflows/generate-ai.ts`) already uses Gemini correctly, so this is the only broken link.

2. **Add Generate Summary button (Summary.tsx + Sidebar.tsx):** Thread `transcriptionStatus` from the Sidebar into the Summary component. When transcription is COMPLETE and no AI generation has been attempted (no `aiGenerationStatus`, no summary), show a "Generate Summary" button. This button calls the existing `/api/videos/${videoId}/retry-ai` endpoint, which already handles the "no aiGenerationStatus" case (its `canRetry` check includes `!metadata.aiGenerationStatus`). The button follows the same pattern as the existing retry button for ERROR/SKIPPED states.

## Acceptance Criteria

- [ ] Does shouldTriggerAiGeneration in get-status.ts check GOOGLE_API_KEY instead of GROQ_API_KEY/OPENAI_API_KEY?
- [ ] Does the Summary tab show a Generate Summary button when transcription is COMPLETE, no aiGenerationStatus exists, and no summary exists?
- [ ] Does clicking the Generate Summary button call the retry-ai endpoint and reload the page on success?
- [ ] Does the auto-trigger in getVideoStatus fire correctly when GOOGLE_API_KEY is set and transcription completes?

## Implementation

### `apps/web/actions/videos/get-status.ts`

```typescript
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
```

### `apps/web/app/s/[videoId]/_components/tabs/Summary.tsx`

```tsx
"use client";

import { Button } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import {
	faRectangleList,
	faRotateRight,
	faWandMagicSparkles,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useState } from "react";
import ReactMarkdown from "react-markdown";

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

interface Chapter {
	title: string;
	start: number;
}

interface SummaryProps {
	videoId: Video.VideoId;
	onSeek?: (time: number) => void;
	initialAiData?: {
		title?: string | null;
		summary?: string | null;
		chapters?: Chapter[] | null;
		aiGenerationStatus?: AiGenerationStatus | null;
	};
	aiGenerationEnabled?: boolean;
	isSummaryDisabled?: boolean;
	ownerIsPro: boolean;
	transcriptionStatus?: string | null;
}

const formatTime = (time: number) => {
	const minutes = Math.floor(time / 60);
	const seconds = Math.floor(time % 60);
	return `${minutes.toString().padStart(2, "0")}:${seconds
		.toString()
		.padStart(2, "0")}`;
};

const SkeletonLoader = () => (
	<div className="p-4 space-y-6 animate-pulse">
		<div>
			<div className="mb-3 w-24 h-6 bg-gray-200 rounded"></div>
			<div className="mb-4 w-32 h-3 bg-gray-100 rounded"></div>
			<div className="space-y-3">
				<div className="w-full h-4 bg-gray-200 rounded"></div>
				<div className="w-5/6 h-4 bg-gray-200 rounded"></div>
				<div className="w-4/5 h-4 bg-gray-200 rounded"></div>
				<div className="w-full h-4 bg-gray-200 rounded"></div>
				<div className="w-3/4 h-4 bg-gray-200 rounded"></div>
			</div>
		</div>

		<div>
			<div className="mb-4 w-24 h-6 bg-gray-200 rounded"></div>
			<div className="space-y-2">
				{[1, 2, 3, 4].map((i) => (
					<div key={i} className="flex items-center p-2">
						<div className="mr-3 w-12 h-4 bg-gray-200 rounded"></div>
						<div className="flex-1 h-4 bg-gray-200 rounded"></div>
					</div>
				))}
			</div>
		</div>
	</div>
);

export const Summary: React.FC<SummaryProps> = ({
	videoId,
	onSeek,
	initialAiData,
	isSummaryDisabled = false,
	aiGenerationEnabled = false,
	ownerIsPro,
	transcriptionStatus,
}) => {
	const [isRetrying, setIsRetrying] = useState(false);
	const [retryError, setRetryError] = useState<string | null>(null);

	const aiData = initialAiData || null;
	const aiGenerationStatus = aiData?.aiGenerationStatus;

	const isLoading =
		aiGenerationEnabled &&
		(aiGenerationStatus === "QUEUED" || aiGenerationStatus === "PROCESSING") &&
		!aiData?.summary &&
		!aiData?.chapters?.length;

	const canRetry =
		aiGenerationStatus === "ERROR" || aiGenerationStatus === "SKIPPED";

	const canGenerate =
		transcriptionStatus === "COMPLETE" &&
		!aiGenerationStatus &&
		!aiData?.summary &&
		!aiData?.chapters?.length;

	const handleSeek = (time: number) => {
		if (onSeek) {
			onSeek(time);
		}
	};

	const handleRetry = async () => {
		setIsRetrying(true);
		setRetryError(null);

		try {
			const response = await fetch(`/api/videos/${videoId}/retry-ai`, {
				method: "POST",
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.error || "Failed to retry AI generation");
			}

			window.location.reload();
		} catch (error) {
			setRetryError(
				error instanceof Error
					? error.message
					: "Failed to retry AI generation",
			);
		} finally {
			setIsRetrying(false);
		}
	};

	if (!ownerIsPro) {
		return (
			<div className="flex flex-col justify-center items-center p-8 h-full text-center">
				<div className="space-y-4 max-w-sm">
					<div className="p-6 bg-gradient-to-br from-blue-50 to-purple-50 rounded-lg border border-blue-100">
						<div className="mb-3 text-blue-600">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								className="mx-auto w-12 h-12"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={1.5}
									d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"
								/>
							</svg>
						</div>
						<h3 className="mb-2 text-lg font-semibold text-gray-900">
							Unlock Cap AI
						</h3>
						<p className="mb-4 text-sm leading-relaxed text-gray-600">
							Upgrade to Cap Pro to access AI-powered features including
							automatic titles, video summaries, and intelligent chapter
							generation.
						</p>
						<Button
							href="/pricing"
							variant="primary"
							size="sm"
							className="mx-auto"
						>
							Upgrade to Cap Pro
						</Button>
					</div>
				</div>
			</div>
		);
	}

	if (isSummaryDisabled) return null;

	if (isLoading) {
		return (
			<div className="flex flex-col h-full">
				<div className="overflow-y-auto flex-1">
					<SkeletonLoader />
				</div>
			</div>
		);
	}

	if (!aiData?.summary && !aiData?.chapters?.length) {
		return (
			<div className="flex flex-col justify-center items-center p-8 h-full text-center">
				<FontAwesomeIcon
					icon={faRectangleList}
					className="mb-4 text-gray-12 size-8"
				/>
				<div className="space-y-1">
					<h3 className="text-base font-medium text-gray-12">
						{aiGenerationStatus === "ERROR"
							? "AI generation failed"
							: aiGenerationStatus === "SKIPPED"
								? "AI generation skipped"
								: "No summary available"}
					</h3>
					<p className="text-sm text-gray-10">
						{aiGenerationStatus === "ERROR"
							? "There was an error generating the AI summary."
							: aiGenerationStatus === "SKIPPED"
								? "The video was too short or had no speech detected."
								: "AI summary has not been generated for this video yet."}
					</p>
					{canRetry && (
						<div className="pt-4">
							<Button
								variant="gray"
								size="sm"
								onClick={handleRetry}
								disabled={isRetrying}
							>
								<FontAwesomeIcon
									icon={faRotateRight}
									className={`mr-2 ${isRetrying ? "animate-spin" : ""}`}
								/>
								{isRetrying ? "Retrying..." : "Retry AI Generation"}
							</Button>
							{retryError && (
								<p className="mt-2 text-sm text-red-500">{retryError}</p>
							)}
						</div>
					)}
					{canGenerate && (
						<div className="pt-4">
							<Button
								variant="primary"
								size="sm"
								onClick={handleRetry}
								disabled={isRetrying}
							>
								<FontAwesomeIcon
									icon={faWandMagicSparkles}
									className={`mr-2 ${isRetrying ? "animate-spin" : ""}`}
								/>
								{isRetrying ? "Generating..." : "Generate Summary"}
							</Button>
							{retryError && (
								<p className="mt-2 text-sm text-red-500">{retryError}</p>
							)}
						</div>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			<div className="overflow-y-auto flex-1">
				<div className="p-4 space-y-6">
					{aiData?.summary && (
						<div>
							<h3 className="text-lg font-medium">Summary</h3>
							<div className="mb-2">
								<span className="text-xs font-semibold text-gray-8">
									Generated by Cap AI
								</span>
							</div>
							<div className="text-sm text-gray-12 prose prose-sm prose-gray max-w-none prose-p:my-2 prose-ul:my-2 prose-li:my-0 prose-strong:text-gray-12">
								<ReactMarkdown>{aiData.summary}</ReactMarkdown>
							</div>
						</div>
					)}

					{aiData?.chapters && aiData.chapters.length > 0 && (
						<div className={aiData?.summary ? "mt-6" : ""}>
							<h3 className="mb-2 text-lg font-medium">Chapters</h3>
							<div className="divide-y">
								{aiData.chapters.map((chapter) => (
									<div
										key={chapter.start}
										className="flex items-center p-2 rounded transition-colors cursor-pointer hover:bg-gray-100"
										onClick={() => handleSeek(chapter.start)}
									>
										<span className="w-16 text-xs text-gray-500">
											{formatTime(chapter.start)}
										</span>
										<span className="ml-2 text-sm">{chapter.title}</span>
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
};
```

### `apps/web/app/s/[videoId]/_components/Sidebar.tsx`

```tsx
import type { comments as commentsSchema } from "@cap/database/schema";
import { classNames } from "@cap/utils";
import type { ImageUpload, Video } from "@cap/web-domain";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { forwardRef, Suspense, useState } from "react";
import type { OrganizationSettings } from "@/app/(org)/dashboard/dashboard-data";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import type { VideoData } from "../types";
import { Activity } from "./tabs/Activity";
import { Settings } from "./tabs/Settings";
import { Summary } from "./tabs/Summary";
import { Transcript } from "./tabs/Transcript";

type TabType = "activity" | "transcript" | "summary" | "settings";

type CommentType = typeof commentsSchema.$inferSelect & {
	authorName?: string | null;
	authorImage?: ImageUpload.ImageUrl | null;
};

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

type TranscriptionProgress = "EXTRACTING" | "TRANSCRIBING" | "SUMMARIZING";

interface SidebarProps {
	data: VideoData;
	commentsData: CommentType[];
	optimisticComments: CommentType[];
	handleCommentSuccess: (comment: CommentType) => void;
	setOptimisticComments: (newComment: CommentType) => void;
	setCommentsData: React.Dispatch<React.SetStateAction<CommentType[]>>;
	views: MaybePromise<number>;
	onSeek?: (time: number) => void;
	videoSettings?: OrganizationSettings | null;
	videoId: Video.VideoId;
	aiData?: {
		title?: string | null;
		summary?: string | null;
		chapters?: { title: string; start: number }[] | null;
		aiGenerationStatus?: AiGenerationStatus | null;
	} | null;
	aiGenerationEnabled?: boolean;
	transcriptionProgress?: TranscriptionProgress | null;
	transcriptionError?: string | null;
	transcriptionProgressStartedAt?: string | null;
}

const TabContent = motion.div;

const tabVariants = {
	enter: (direction: number) => ({
		x: direction > 0 ? 1000 : -1000,
		opacity: 0,
	}),
	center: {
		zIndex: 1,
		x: 0,
		opacity: 1,
	},
	exit: (direction: number) => ({
		zIndex: 0,
		x: direction < 0 ? 1000 : -1000,
		opacity: 0,
	}),
};

const tabTransition = {
	x: { type: "spring", stiffness: 300, damping: 30 },
	opacity: { duration: 0.2 },
};

export const Sidebar = forwardRef<{ scrollToBottom: () => void }, SidebarProps>(
	(
		{
			data,
			commentsData,
			setCommentsData,
			optimisticComments,
			handleCommentSuccess,
			setOptimisticComments,
			views,
			videoSettings,
			onSeek,
			aiData,
			aiGenerationEnabled = false,
			transcriptionProgress,
			transcriptionError,
			transcriptionProgressStartedAt,
		},
		ref,
	) => {
		const user = useCurrentUser();

		const isOwner = Boolean(user?.id === data.owner.id);
		const isOwnerOrMember = Boolean(
			isOwner || (user && data.organizationMembers?.includes(user.id)),
		);

		const defaultTab = !(
			videoSettings?.disableComments ?? data.orgSettings?.disableComments
		)
			? "activity"
			: !(videoSettings?.disableSummary ?? data.orgSettings?.disableSummary)
				? "summary"
				: !(
							videoSettings?.disableTranscript ??
							data.orgSettings?.disableTranscript
						)
					? "transcript"
					: "activity";

		const [activeTab, setActiveTab] = useState<TabType>(defaultTab);
		const [[page, direction], setPage] = useState([0, 0]);

		const tabs = [
			{
				id: "activity",
				label: "Comments",
				disabled:
					videoSettings?.disableComments ?? data.orgSettings?.disableComments,
			},
			{
				id: "summary",
				label: "Summary",
				disabled:
					videoSettings?.disableSummary ?? data.orgSettings?.disableSummary,
			},
			{
				id: "transcript",
				label: "Transcript",
				disabled:
					videoSettings?.disableTranscript ??
					data.orgSettings?.disableTranscript,
			},
		];

		const paginate = (tabId: TabType) => {
			const currentIndex = tabs.findIndex((tab) => tab.id === activeTab);
			const newIndex = tabs.findIndex((tab) => tab.id === tabId);
			const direction = newIndex > currentIndex ? 1 : -1;

			setPage([page + direction, direction]);
			setActiveTab(tabId);
		};

		const renderTabContent = () => {
			switch (activeTab) {
				case "activity":
					return (
						<Suspense
							fallback={<Activity.Skeleton isOwnerOrMember={isOwnerOrMember} />}
						>
							<Activity
								ref={ref}
								views={views}
								comments={commentsData}
								commentsDisabled={
									videoSettings?.disableComments ??
									data.orgSettings?.disableComments ??
									false
								}
								setComments={setCommentsData}
								optimisticComments={optimisticComments}
								setOptimisticComments={setOptimisticComments}
								handleCommentSuccess={handleCommentSuccess}
								isOwnerOrMember={isOwnerOrMember}
								isOwner={isOwner}
								onSeek={onSeek}
								videoId={data.id}
							/>
						</Suspense>
					);
				case "summary":
					return (
						<Summary
							videoId={data.id}
							ownerIsPro={data.owner.isPro}
							onSeek={onSeek}
							isSummaryDisabled={videoSettings?.disableSummary}
							initialAiData={aiData || undefined}
							aiGenerationEnabled={aiGenerationEnabled}
							transcriptionStatus={data.transcriptionStatus}
						/>
					);
				case "transcript":
					return (
						<Transcript
							data={data}
							onSeek={onSeek}
							transcriptionProgress={transcriptionProgress}
							transcriptionError={transcriptionError}
							transcriptionProgressStartedAt={transcriptionProgressStartedAt}
						/>
					);
				case "settings":
					return <Settings />;
				default:
					return null;
			}
		};

		const allTabsDisabled = tabs.every((tab) => tab.disabled);

		return (
			<div className="bg-white rounded-2xl border border-gray-5 overflow-hidden h-[calc(100vh-16rem)] lg:h-full flex flex-col lg:aspect-video">
				<div className="flex-none">
					<div
						className={clsx(
							"flex border-b border-gray-5",
							allTabsDisabled && "hidden",
						)}
					>
						{tabs
							.filter((tab) => !tab.disabled)
							.map((tab) => (
								<button
									type="button"
									key={tab.id}
									onClick={() => paginate(tab.id as TabType)}
									className={classNames(
										"flex-1 px-5 py-3 text-sm font-medium relative transition-colors duration-200",
										"hover:bg-gray-1",
										activeTab === tab.id ? "bg-gray-3" : "",
									)}
								>
									<span
										className={classNames(
											"relative z-10 text-sm",
											activeTab === tab.id ? "text-gray-12" : "text-gray-9",
										)}
									>
										{tab.label}
									</span>
									{activeTab === tab.id && (
										<motion.div
											layoutId="activeTab"
											className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500"
											initial={false}
											transition={{
												type: "spring",
												stiffness: 500,
												damping: 30,
											}}
										/>
									)}
								</button>
							))}
					</div>
				</div>
				<div className="flex-1 min-h-0">
					<div className="overflow-hidden relative h-full">
						<AnimatePresence initial={false} custom={direction}>
							<TabContent
								key={activeTab}
								custom={direction}
								variants={tabVariants}
								initial="enter"
								animate="center"
								exit="exit"
								transition={tabTransition}
								className="overflow-auto absolute inset-0"
							>
								<div className="h-full">{renderTabContent()}</div>
							</TabContent>
						</AnimatePresence>
					</div>
				</div>
			</div>
		);
	},
);
```

## Open Questions

None. The `faWandMagicSparkles` icon has been verified as available in the project's `@fortawesome/free-solid-svg-icons@^6.7.2` dependency (already used in `CapAIDialog.tsx` and `FeaturesPage.tsx`).

## Key Files

- `apps/web/actions/videos/get-status.ts` - Fixed `shouldTriggerAiGeneration` to check `GOOGLE_API_KEY` instead of `GROQ_API_KEY/OPENAI_API_KEY`
- `apps/web/app/s/[videoId]/_components/tabs/Summary.tsx` - Added `transcriptionStatus` prop and "Generate Summary" button for videos with complete transcription but no AI summary
- `apps/web/app/s/[videoId]/_components/Sidebar.tsx` - Threads `data.transcriptionStatus` to the Summary component
- `apps/web/app/api/videos/[videoId]/retry-ai/route.ts` - Existing endpoint, no changes needed (already handles the null aiGenerationStatus case)
- `apps/web/lib/generate-ai.ts` - Existing function, no changes needed (already uses GOOGLE_API_KEY)
