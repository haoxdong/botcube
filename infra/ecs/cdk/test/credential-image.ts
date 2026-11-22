import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import { auditCopyImage, type CredentialServiceImage } from '../lib/credential-audit-copy.js';

/** A stand-in for the Credential Service image, by name, so a synth needs no image build. */
export function registryCredentialImage(name: string): CredentialServiceImage {
  return { service: ContainerImage.fromRegistry(name), auditCopy: auditCopyImage(name) };
}
