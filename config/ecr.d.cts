export const PINNED: string;
export const ECR_IMAGE: RegExp;
/** The ARN of the Amazon ECR repository an image URI names; none for an image in another registry. */
export function ecrRepositoryArn(uri: string): string | undefined;
