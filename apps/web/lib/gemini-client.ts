import { serverEnv } from "@cap/env";
import { GoogleGenerativeAI } from "@google/generative-ai";

let geminiClient: GoogleGenerativeAI | null = null;

export function getGeminiClient(): GoogleGenerativeAI | null {
	const apiKey = serverEnv().GOOGLE_API_KEY;
	if (!apiKey) {
		return null;
	}

	if (!geminiClient) {
		geminiClient = new GoogleGenerativeAI(apiKey);
	}

	return geminiClient;
}

export const GEMINI_TEXT_MODEL = "gemini-2.5-flash";
export const GEMINI_AUDIO_MODEL = "gemini-2.5-flash";
