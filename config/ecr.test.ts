import { describe, expect, it } from 'vitest';
import { ecrRepositoryArn } from './ecr.cjs';

const DIGEST = `@sha256:${'c'.repeat(64)}`;

describe('the Amazon ECR repository an image names', () => {
  it.each([
    [`123456789012.dkr.ecr.us-east-1.amazonaws.com/acme/chat${DIGEST}`, 'arn:aws:ecr:us-east-1:123456789012:repository/acme/chat'],
    ['123456789012.dkr.ecr.us-east-1.amazonaws.com/acme/chat:1', 'arn:aws:ecr:us-east-1:123456789012:repository/acme/chat'],
  ])('%s is in %s', (uri, arn) => {
    expect(ecrRepositoryArn(uri)).toBe(arn);
  });

  it('is none for an image in another registry', () => {
    expect(ecrRepositoryArn(`mirror.example.com/acme/chat${DIGEST}`)).toBeUndefined();
  });
});
