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
	_now: () => number,
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

export function detectCrossOriginSupport(_url: string): boolean {
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
