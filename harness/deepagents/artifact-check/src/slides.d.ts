export type SlideError = { file: string; line?: number; column?: number; element: string; message: string; nearest: string };
export function checkDeck(files: Record<string, string>): Promise<SlideError[]>;
export function describe(error: SlideError): string;
