import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { CredentialServiceImage } from '../lib/credential-audit-copy.js';

/** Code naming an image by its URI, as a fixture's registry images do; Lambda itself runs only images in the account's ECR. */
class ImageUriCode extends lambda.Code {
  readonly isInline = false;
  constructor(private readonly imageUri: string) { super(); }
  bind(): lambda.CodeConfig { return { image: { imageUri: this.imageUri } }; }
}

class ImageUriFunctionCode extends lambda.DockerImageCode {
  constructor(private readonly imageUri: string) { super(); }
  _bind(): lambda.Code { return new ImageUriCode(this.imageUri); }
}

/** A stand-in for the Credential Service image, by name, so a synth needs no image build. */
export function registryCredentialImage(name: string): CredentialServiceImage {
  return { service: ContainerImage.fromRegistry(name), auditCopy: new ImageUriFunctionCode(name) };
}
