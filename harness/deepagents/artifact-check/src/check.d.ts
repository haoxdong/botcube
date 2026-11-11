export type CheckError = { file: string; line?: number; column?: number; element: string; message: string; nearest: string };
/** `file:line:col element — what is wrong. Nearest: the allowed form.` */
export function describe(error: CheckError): string;
/** Whether the Artifact Type has a checker. */
export function checked(type: string): boolean;
/** Whether the type's checker reads the Source file at `path`, a path in the Source. */
export function reads(type: string, path: string): boolean;
/** Every error in a Source of the type, given its files by their path in the Source; empty when it may be saved. */
export function check(type: string, files: Record<string, string>): Promise<CheckError[]>;
