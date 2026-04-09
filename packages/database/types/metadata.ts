export interface VideoMetadata {
	customCreatedAt?: string;
	sourceName?: string;
	aiTitle?: string;
	summary?: string;
	chapters?: { title: string; start: number }[];
	aiGenerationStatus?:
		| "QUEUED"
		| "PROCESSING"
		| "COMPLETE"
		| "ERROR"
		| "SKIPPED";
	enhancedAudioStatus?: "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED";
	transcriptionStartedAt?: number;
	transcriptionProgress?: "EXTRACTING" | "TRANSCRIBING" | "SUMMARIZING";
	transcriptionError?: string;
	transcriptionProgressStartedAt?: string;
}

export interface SpaceMetadata {
	[key: string]: never;
}

export interface UserMetadata {
	[key: string]: never;
}
